import { resolveManagedNativeHost } from "./managed-native-host.js";
import { validateHumanDialogResponse } from "./managed-human-dialogs.js";
import { validateHumanFileRequest } from "./managed-human-file-chooser.js";
import { validateHumanClipboardInput, validateHumanClipboardResult } from "./managed-human-clipboard.js";

const API = "__obuManagedUser", BINDING = "__obuManagedViewerEvent";
const LEASE_MS = 10000, HEARTBEAT_MS = 3000, MAX_FRAME_BYTES = 4 * 1024 * 1024;
const identityKeys = ["runId", "extensionId", "extensionInstanceId", "workerBootId", "portId"];
const failure = (code, message) => new Error(`OBU_MANAGED_USER_${code}: ${message}`);
const text = (value, max = 256) => typeof value === "string" && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;

// Data descriptors only: this private JSON-shaped surface never invokes a
// supplied getter, accepts inherited authority, or forwards arbitrary CDP.
function fields(value, required, optional = []) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw failure("PROTOCOL", "expected an object");
  const keys = Reflect.ownKeys(value), descriptors = Object.getOwnPropertyDescriptors(value);
  if (keys.some(key => !required.includes(key) && !optional.includes(key)) ||
      keys.some(key => !Object.hasOwn(descriptors[key], "value")) || required.some(key => !descriptors[key]))
    throw failure("PROTOCOL", "unexpected, missing, or non-data field");
  return Object.fromEntries(keys.map(key => [key, descriptors[key].value]));
}

function frameCopy(value) {
  if (!value || !integer(value.tabId) || !text(value.streamId) || !integer(value.sequence) || value.sequence < 1 ||
      value.mimeType !== "image/png" || typeof value.data !== "string" || !value.data.length ||
      value.data.length > 4 * Math.ceil(MAX_FRAME_BYTES / 3) || value.data.length % 4 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(value.data))
    throw failure("FRAME", "invalid or oversized native PNG frame");
  const bytes = value.data.length / 4 * 3 - (value.data.endsWith("==") ? 2 : value.data.endsWith("=") ? 1 : 0);
  if (bytes > MAX_FRAME_BYTES) throw failure("FRAME", "native PNG exceeds 4 MiB");
  const metadata = {};
  // CDP screencast metadata contains viewport geometry and capture times. It
  // does not prove a frame's document identity; do not manufacture one here.
  for (const key of ["offsetTop", "pageScaleFactor", "deviceWidth", "deviceHeight", "scrollOffsetX", "scrollOffsetY", "timestamp", "monotonicTimestamp"])
    if (Number.isFinite(value.metadata?.[key])) metadata[key] = value.metadata[key];
  const human = value.controlMode === "human";
  const view = value.controlMode === "user-view", lease = human ? value.humanLeaseId : value.viewLeaseId;
  if (value.controlMode !== undefined && !human && !view ||
      !human && value.humanLeaseId !== undefined || !view && value.viewLeaseId !== undefined ||
      !human && !view && value.generation !== undefined ||
      (human || view) && (!text(lease, 128) || !integer(value.generation) || value.generation < 1))
    throw failure("FRAME", "invalid user frame identity");
  return { tabId: value.tabId, streamId: value.streamId, frameSequence: value.sequence, mimeType: value.mimeType, data: value.data, metadata,
    ...(human ? { controlMode: "human", humanLeaseId: lease, generation: value.generation } :
      view ? { controlMode: "user-view", viewLeaseId: lease, generation: value.generation } : {}) };
}

// Installed only in a packaged managed worker. The manager reaches it through
// that worker's authenticated native Browser binding, never task RPC or HTTP.
export function installManagedUserBridge({ config, backend, getInstanceId, target = globalThis,
  nativeProof = () => target.__obuNativeDownloadBinding,
  now = () => performance.now(), wallNow = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = timer => clearTimeout(timer),
  newChannelId = () => crypto.randomUUID() }) {
  if (config === null) return null;
  const host = resolveManagedNativeHost(config, ""), runId = host.slice(-32);
  if (!backend || ["getManagedViewerTabs", "managedViewerSubscribe", "getAutomationControlStatus", "pauseAutomation", "resumeAutomation",
    "prepareManagedUserOpen", "commitManagedUserOpen", "waitManagedNativeRecovery", "onManagedNativeLoss"].some(key => typeof backend[key] !== "function") ||
      typeof getInstanceId !== "function" || typeof nativeProof !== "function" || !target || Object.hasOwn(target, API))
    throw failure("CONFIG", "a managed backend and an unused worker surface are required");

  let current = null, opening = null, latestChannel = null;
  const usedKeys = new Set(), channels = new Map(), cleanup = new Set();
  let cleanupFailure = null;

  const identity = channel => ({ version: 1, channelId: channel.id, ...channel.identity });
  function proofMatches(channel) {
    let proof;
    try { proof = nativeProof(); } catch { return false; }
    return proof === channel.proof && proof?.nonce === channel.nonce &&
      identityKeys.slice(1).every(key => proof[key] === channel.identity[key]) && target[BINDING] === channel.sink;
  }
  function assertCurrent(channel) {
    if (!channel || channel.closed || current !== channel) throw failure("CLOSED", "original user channel is closed");
    if (now() >= channel.deadline || !proofMatches(channel)) {
      void revoke(channel, now() >= channel.deadline ? "lease expired" : "native binding changed");
      throw failure("CLOSED", "original user channel expired or lost its native binding");
    }
  }
  function emit(channel, payload, final = false) {
    if (!final) assertCurrent(channel);
    const sequence = ++channel.sequence;
    if (!Number.isSafeInteger(sequence)) throw failure("CAPACITY", "event sequence exhausted");
    try { channel.sink(JSON.stringify({ ...identity(channel), ...payload, sequence })); }
    catch (error) {
      if (!channel.closed) void revoke(channel, "viewer binding failed", false);
      throw error;
    }
    return sequence;
  }
  function trackCleanup(promise) {
    cleanup.add(promise);
    promise.then(() => cleanup.delete(promise), error => { cleanup.delete(promise); cleanupFailure = error; });
    return promise;
  }
  function retireStream(channel, reason, publish = true) {
    channel.stateEpoch++;
    const record = channel.stream;
    channel.stream = null; channel.selectedTabId = null;
    channel.inFlight = null; channel.latest = null;
    channel.streamState = { state: "idle", streamId: null };
    if (!record) return Promise.resolve();
    record.retired = true;
    if (record.human) channel.retiredHuman = record;
    if (!record.closing) record.closing = trackCleanup((async () => {
      let handle;
      try { handle = await record.started; }
      catch (error) {
        // Ordinary startup rejection follows its actual cleanup. A native
        // cleanup failure must remain a barrier even when no handle arrived.
        if (error?.viewerCleanupIncomplete || error?.humanCleanupIncomplete) throw error;
        return;
      }
      await handle.close();
      if (record.human || record.view) {
        const info = handle.info();
        if (info?.state !== "released" || !text(info.leaseId, 128)) throw failure("CLEANUP", "original user page release was not confirmed");
        if (record.human) channel.humanCleanup = { leaseId: info.leaseId, cleanupConfirmed: true };
      }
    })());
    // A reentrant receiver must see the original cleanup Promise before Clear.
    if (publish && !channel.closed) {
      try { emit(channel, { type: "clear", reason }); } catch { /* revoke already fenced delivery */ }
    }
    return record.closing;
  }
  function revoke(channel, reason, publish = true) {
    if (channel.closed) return channel.closedPromise ?? Promise.resolve();
    channel.closed = true;
    if (current === channel) current = null;
    clearTimer(channel.timer);
    const retired = cancelSelections(channel, reason, false);
    const releases = [...cleanup, retired];
    if (channel.pageChoices) {
      // Cancelling the caller does not settle native reads or an IDB commit.
      // The catalog drains those original operations before close is confirmed.
      try { channel.pageChoices.revoke(reason); releases.push(channel.pageChoices.drain()); }
      catch (error) { releases.push(Promise.reject(error)); }
    }
    // Fence a pending Resume before it can later unblock input. This does not
    // undo an already completed Resume or browser action. The backend checks
    // its authority callback at the actual asynchronous unblock boundary.
    if (channel.pendingResumes) {
      try { releases.push(Promise.resolve(backend.pauseAutomation())); }
      catch (error) { releases.push(Promise.reject(error)); }
    }
    if (publish) {
      try { emit(channel, { type: "closed", reason }, true); } catch { /* no recursive notification */ }
    }
    channel.closedPromise = trackCleanup(Promise.all(releases).then(() => {
      if (cleanupFailure) throw failure("CLEANUP", String(cleanupFailure.message ?? cleanupFailure));
      channel.cleanupConfirmed = true;
    }));
    return channel.closedPromise;
  }
  backend.onManagedNativeLoss(epoch => {
    const channel = current ?? latestChannel;
    if (!channel) return;
    channel.nativeEpoch = epoch;
    // Revoke publication and accepted selections in the same disconnect turn.
    // Only the original channel retains a bounded cleanup-only receipt path.
    void revoke(channel, "native binding lost").catch(() => {});
  });

  async function disconnectedStatus(channel, joinNative = false) {
    await revoke(channel, "manager disconnected");
    if (joinNative) await backend.waitManagedNativeRecovery(channel.nativeEpoch);
    const automation = await backend.getAutomationControlStatus();
    if (!channel.cleanupConfirmed || channel.stream || channel.selectedTabId !== null)
      throw failure("CLEANUP", "original viewer cleanup is incomplete");
    const disconnected = { ...identity(channel), connected: false, leaseMs: LEASE_MS, heartbeatMs: HEARTBEAT_MS,
      expiresAt: Math.ceil(wallNow()), selectedTabId: channel.selectedTabId, automation, tabs: [],
      stream: { ...channel.streamState }, cleanupPending: 0, eventSequence: channel.sequence, human: null,
      ...(channel.pageSelectionVersion ? { pageSelectionVersion: channel.pageSelectionVersion } : {}),
      view: null, pendingDialog: null, pendingFileChooser: null, ...(channel.humanCleanup ? { humanCleanup: { ...channel.humanCleanup } } : {}) };
    if (JSON.stringify(disconnected).length > 1024 * 1024) throw failure("CAPACITY", "disconnected metadata status exceeds its bound");
    return { disconnected: true, status: disconnected };
  }
  function arm(channel) {
    clearTimer(channel.timer);
    channel.timer = setTimer(() => {
      if (channel.closed) return;
      try { assertCurrent(channel); arm(channel); } catch { /* assertCurrent revokes */ }
    }, Math.max(1, Math.min(HEARTBEAT_MS, channel.deadline - now())));
    channel.timer?.unref?.();
  }
  function sendFrame(channel, frame) {
    // Credit is reserved before invoking the synchronous CDP binding. Neither
    // this credit nor HTTP delivery controls the broker's native screencast ACK.
    const credit = { sequence: channel.sequence + 1 };
    channel.inFlight = credit;
    emit(channel, { type: "frame", ...frame });
  }
  function deliverFrame(channel, frame) {
    if (channel.inFlight) channel.latest = frame;
    else sendFrame(channel, frame);
  }
  function resetLeaseFrames(channel, record) {
    // A manager may still be acknowledging the original published frame.
    // Retire that exact credit once; never accept an arbitrary old sequence.
    if (channel.inFlight) {
      if (channel.retiredAcks.size >= 64) throw failure("CAPACITY", "unsettled retired frame credits exceeded their bound");
      channel.retiredAcks.add(channel.inFlight.sequence);
    }
    channel.inFlight = null; channel.latest = null;
    record.pendingLeaseFrame = null;
    record.streamId = null; record.lastFrameSequence = 0;
    record.publishedLeaseStream = null;
    channel.streamState = { state: "starting", streamId: null };
  }
  function leaseStateChanged(channel, record, value) {
    if (record.retired || channel.closed || channel.stream !== record) return;
    if (!record.handle) { record.earlyState = value; return; }
    const currentInfo = record.handle.info();
    // Native state callbacks are snapshots. A delayed snapshot cannot retire
    // the newer document, even if it names the same durable human lease.
    if (!value || value.leaseId !== currentInfo.leaseId || value.tabId !== record.tabId ||
        value.generation !== currentInfo.generation || value.state !== currentInfo.state) return;
    if (!(record.human ? ["preparing", "active", "navigating"] : ["active", "navigating"]).includes(value.state)) return;
    if (!integer(value.generation) || value.generation < record.leaseGeneration)
      throw failure("HUMAN_UNCONFIRMED", "human generation regressed");
    if (value.generation > record.leaseGeneration) {
      resetLeaseFrames(channel, record);
      record.leaseGeneration = value.generation;
    }
    channel.stateEpoch++;
    record.leaseStatePublicationPending = true;
    publishLeaseStatus(channel, record);
  }
  function publishLeaseStatus(channel, record) {
    if (record.leasePublication || record.retired || channel.closed || channel.stream !== record) return;
    record.leaseStatePublicationPending = false;
    const publication = (async () => {
      const value = await status(channel, true);
      if (record.retired || channel.closed || channel.stream !== record) return;
      const info = record.handle.info(), frame = record.pendingLeaseFrame;
      const announced = record.view ? value.view : value.human;
      const frameLease = record.view ? frame?.viewLeaseId : frame?.humanLeaseId;
      if (!frame || info.state !== "active" || announced?.state !== "active" ||
          frameLease !== info.leaseId || frame.generation !== info.generation ||
          announced.leaseId !== info.leaseId || announced.generation !== info.generation ||
          value.stream.streamId !== frame.streamId) return;
      // The actual matching status is emitted first. A successor frame never
      // grants its own lease/generation simply by arriving before that state.
      record.pendingLeaseFrame = null;
      record.publishedLeaseStream = frame.streamId;
      deliverFrame(channel, frame);
    })();
    record.leasePublication = publication;
    publication.then(() => {
      if (record.leasePublication === publication) record.leasePublication = null;
      // A navigation can arrive after status emitted but before this Promise
      // settles. Publish that state even when its first frame has not arrived.
      if (record.leaseStatePublicationPending || record.pendingLeaseFrame) publishLeaseStatus(channel, record);
    }, () => {
      if (record.leasePublication === publication) record.leasePublication = null;
      if (!record.retired && !channel.closed && channel.stream === record)
        void retireStream(channel, "human state publication unavailable").catch(() => {});
    });
  }
  function receiveFrame(channel, record, value) {
    if (record.retired || channel.stream !== record || channel.closed) return;
    try {
      assertCurrent(channel);
      const frame = frameCopy(value);
      if (frame.tabId !== record.tabId) throw failure("FRAME", "frame belongs to a different tab");
      if (record.human || record.view) {
        const info = record.handle?.info();
        const mode = record.view ? "user-view" : "human", lease = record.view ? frame.viewLeaseId : frame.humanLeaseId;
        if (frame.controlMode === mode && lease === info?.leaseId && frame.generation < info.generation) return;
        if (frame.controlMode !== mode || info?.state !== "active" || lease !== info.leaseId || frame.generation !== info.generation)
          throw failure("FRAME", "frame does not match the active user lease and geometry");
        if (record.leaseGeneration !== info.generation) leaseStateChanged(channel, record, info);
      } else if (frame.controlMode !== undefined) throw failure("FRAME", "observation stream cannot authorize human input");
      if (record.streamId && record.streamId !== frame.streamId) throw failure("FRAME", "original stream identity changed");
      if (frame.frameSequence <= record.lastFrameSequence) return;
      record.streamId = frame.streamId; record.lastFrameSequence = frame.frameSequence;
      if (channel.streamState.state !== "streaming" || channel.streamState.streamId !== frame.streamId) channel.stateEpoch++;
      channel.streamState = { state: "streaming", streamId: frame.streamId };
      if ((record.human || record.view) && record.publishedLeaseStream !== frame.streamId) {
        record.pendingLeaseFrame = frame;
        publishLeaseStatus(channel, record);
      } else deliverFrame(channel, frame);
    } catch (error) {
      if (channel.closed) return;
      void retireStream(channel, "frame unavailable").catch(() => {});
      channel.streamState = { state: "error", streamId: null, error: String(error.message) };
      try { emit(channel, { type: "error", error: String(error.message) }); } catch { /* revoked */ }
    }
  }
  async function tabs(channel) {
    assertCurrent(channel);
    const human = channel.stream?.human && !channel.stream.retired ? channel.stream : null;
    const humanTab = human ? { ...human.tab, ...(human.handle?.tabInfo?.() ?? {}) } : null;
    let result, choices = [];
    if (channel.pageChoices) {
      const reads = await Promise.allSettled([
        backend.getManagedViewerTabs(human ? { excludeTabId: human.tabId } : {}), channel.pageChoices.list()
      ]);
      for (const read of reads) if (read.status === "rejected") throw read.reason;
      result = reads[0].value; choices = reads[1].value;
      if (humanTab && Array.isArray(result)) result = [humanTab, ...result.filter(tab => tab.id !== human.tabId)];
    } else result = human ? [humanTab] : await backend.getManagedViewerTabs();
    assertCurrent(channel);
    if (human && humanTab?.id !== human.tabId) throw failure("TABS", "human metadata belongs to a different tab");
    if (!Array.isArray(result) || result.length > 4096) throw failure("TABS", "invalid live attachment list");
    if (!Array.isArray(choices) || choices.length > 4096) throw failure("TABS", "invalid browser page list");
    const project = (tab, ids, catalog) => {
      if (!integer(tab.id) || ids.has(tab.id)) throw failure("TABS", "invalid live attachment identity");
      ids.add(tab.id);
      const result = tab.kind === "result", task = tab.kind === undefined || tab.kind === "task";
      const browser = tab.kind === "browser";
      if (catalog !== browser || !task && !result && !browser || result && (!text(tab.deliveryId, 128) || typeof tab.watchable !== "boolean" || typeof tab.takeover !== "boolean") ||
          browser && (!channel.pageSelectionVersion || !text(tab.pageSelectionId, 128) || typeof tab.watchable !== "boolean" || typeof tab.takeover !== "boolean") ||
          !browser && tab.pageSelectionId !== undefined ||
          !result && tab.deliveryId !== undefined || tab.watchable !== undefined && typeof tab.watchable !== "boolean" || tab.takeover !== undefined && typeof tab.takeover !== "boolean")
        throw failure("TABS", "invalid user page capabilities");
      const activeView = channel.stream?.view && !channel.stream.retired && channel.stream.tabId === tab.id && channel.stream.tab.deliveryId === tab.deliveryId ? channel.stream : null;
      const current = activeView?.handle?.tabInfo?.() ?? tab;
      return { id: tab.id, title: typeof current.title === "string" ? current.title.slice(0, 512) : "", url: typeof current.url === "string" ? current.url.slice(0, 8192) : "",
        ...(tab.kind !== undefined ? { kind: tab.kind } : {}), ...(result ? { deliveryId: tab.deliveryId } : {}),
        ...(browser ? { pageSelectionId: tab.pageSelectionId } : {}),
        ...(tab.watchable !== undefined ? { watchable: tab.watchable } : {}), ...(tab.takeover !== undefined ? { takeover: tab.takeover } : {}) };
    };
    const ids = new Set(), catalogIds = new Set();
    const projected = result.map(tab => project(tab, ids, false));
    for (const tab of choices.map(tab => project(tab, catalogIds, true))) if (!ids.has(tab.id)) projected.push(tab);
    if (projected.length > 4096) throw failure("TABS", "combined page list exceeds its bound");
    return projected;
  }
  async function status(channel, publish = false) {
    // Tab inspection can outlive a Pause/Resume or a viewer retirement. Read
    // automation last and fence both awaits against those transitions. Only
    // these observations repeat; an accepted control operation never does.
    for (let attempt = 0; attempt < 8; attempt++) {
      assertCurrent(channel);
      const epoch = channel.stateEpoch;
      const liveTabs = await tabs(channel);
      const automation = await backend.getAutomationControlStatus();
      assertCurrent(channel);
      if (channel.stateEpoch !== epoch) continue;
      if (channel.selectedTabId !== null && !liveTabs.some(tab => tab.id === channel.selectedTabId &&
          (!channel.stream?.view || tab.deliveryId === channel.stream.tab.deliveryId))) {
        await retireStream(channel, "original attachment unavailable");
        continue;
      }
      const value = { ...identity(channel), connected: true, leaseMs: LEASE_MS, heartbeatMs: HEARTBEAT_MS,
        expiresAt: Math.ceil(wallNow() + Math.max(0, channel.deadline - now())), selectedTabId: channel.selectedTabId,
        automation, tabs: liveTabs, stream: { ...channel.streamState }, cleanupPending: cleanup.size,
        eventSequence: channel.sequence + (publish ? 1 : 0),
        ...(channel.pageSelectionVersion ? { pageSelectionVersion: channel.pageSelectionVersion } : {}),
        human: channel.stream?.human ? channel.stream.handle?.info() ?? null : null,
        view: channel.stream?.view ? channel.stream.handle?.info() ?? null : null,
        pendingDialog: channel.stream?.human ? channel.stream.handle?.pendingDialog?.() ?? null : null,
        pendingFileChooser: channel.stream?.human ? channel.stream.handle?.pendingFileChooser?.() ?? null : null,
        ...(channel.humanCleanup ? { humanCleanup: { ...channel.humanCleanup } } : {}),
        ...(cleanupFailure ? { cleanupError: String(cleanupFailure.message ?? cleanupFailure) } : {}) };
      if (JSON.stringify(value).length > 1024 * 1024) throw failure("CAPACITY", "live metadata status exceeds its bound");
      channel.lastStatus = value;
      if (publish) emit(channel, { type: "status", status: value });
      return value;
    }
    throw failure("STALE_STATUS", "control state kept changing during metadata inspection");
  }
  function assertSelection(channel, epoch) {
    assertCurrent(channel);
    if (epoch !== channel.selectionEpoch) throw failure("CLOSED", "original selection request was revoked");
    if (channel.pendingResumes) throw failure("BUSY", "wait for the original Resume before selecting a page");
  }
  function cancelSelections(channel, reason, publish = true) {
    // Revoke synchronously, including a Begin still reading its original tab or
    // waiting behind an older selection. Cleanup must not queue behind Begin.
    channel.selectionEpoch++;
    const previous = channel.selections;
    const retired = retireStream(channel, reason, publish);
    // Snapshot here: a later channel-close cleanup can itself wait for this
    // cancellation, and must never become its own prerequisite.
    const originalCleanup = [...cleanup];
    const cancelled = Promise.all([previous.catch(() => {}), retired, ...originalCleanup]).then(() => {
      if (cleanupFailure) throw failure("CLEANUP", "original viewer cleanup is incomplete");
    });
    channel.selections = cancelled;
    return cancelled;
  }
  function checkTabSelection(tab, deliveryId, capability, pageSelectionId) {
    if (!tab || tab[capability] === false || (tab.kind === "result" ? deliveryId !== tab.deliveryId : deliveryId !== undefined) ||
        (tab.kind === "browser" ? pageSelectionId !== tab.pageSelectionId : pageSelectionId !== undefined))
      throw failure("TAB", "original page selection or capability is no longer available");
  }
  async function retainSelectedPage(channel, tab, epoch, pageSelectionId) {
    if (tab.kind !== "browser") return { tab };
    const check = () => assertSelection(channel, epoch);
    check(); channel.stateEpoch++;
    try {
      // An explicit browser-page selection pauses task admission and finishes
      // its original cleanup before publishing any new result authority.
      await backend.pauseAutomation(); check();
      const receipt = fields(await channel.pageChoices.select(tab.id, pageSelectionId, { check }),
        ["tabId", "pageSelectionId", "deliveryId", "retained"]);
      check();
      if (receipt.tabId !== tab.id || receipt.pageSelectionId !== pageSelectionId || !text(receipt.deliveryId, 128) || receipt.retained !== true)
        throw failure("PAGE_UNCONFIRMED", "original page retention receipt does not match");
      const { pageSelectionId: retiredChoice, ...metadata } = tab;
      return { tab: { ...metadata, kind: "result", deliveryId: receipt.deliveryId }, receipt };
    } finally { channel.stateEpoch++; }
  }
  async function select(channel, tabId, epoch, deliveryId, pageSelectionId) {
    assertSelection(channel, epoch);
    if (channel.stream?.human && tabId !== null) throw failure("HUMAN_BUSY", "finish the original human control before changing selection");
    let tab = tabId === null ? null : (await tabs(channel)).find(tab => tab.id === tabId);
    if (tabId !== null) checkTabSelection(tab, deliveryId, "watchable", pageSelectionId);
    assertSelection(channel, epoch);
    if (channel.selectedTabId === tabId && channel.stream?.tab?.deliveryId === deliveryId && !cleanup.size && !cleanupFailure) return;
    await retireStream(channel, "selection changed");
    assertSelection(channel, epoch);
    await Promise.all([...cleanup]);
    assertSelection(channel, epoch);
    if (cleanupFailure) throw failure("CLEANUP", String(cleanupFailure.message ?? cleanupFailure));
    if (tabId === null) return;
    const retained = await retainSelectedPage(channel, tab, epoch, pageSelectionId);
    assertSelection(channel, epoch);
    tab = retained.tab; deliveryId = tab.deliveryId;
    const record = { tabId, tab, view: tab.kind === "result", retired: false, streamId: null, lastFrameSequence: 0, started: null, closing: null,
      handle: null, earlyFrame: null, earlyState: null, leaseGeneration: 0 };
    channel.stateEpoch++;
    channel.retiredHuman = null;
    channel.stream = record; channel.selectedTabId = tabId;
    channel.streamState = { state: "starting", streamId: null };
    const authority = () => {
      assertCurrent(channel);
      if (record.retired || channel.stream !== record) throw failure("CLOSED", "original selection was revoked");
    };
    record.started = Promise.resolve().then(() => {
      authority();
      return backend.managedViewerSubscribe(tabId, frame => {
        if (record.view && !record.handle) { record.earlyFrame = frame; return; }
        receiveFrame(channel, record, frame);
      }, value => leaseStateChanged(channel, record, value), deliveryId === undefined ? {} : { deliveryId }, authority);
    });
    try {
      const handle = await record.started;
      if (!handle || typeof handle.close !== "function") throw failure("STREAM", "invalid viewer subscription");
      if (record.view) {
        if (typeof handle.info !== "function" || typeof handle.tabInfo !== "function" || handle.input !== undefined)
          throw failure("STREAM", "result viewing must not provide input authority");
        record.handle = handle;
        const info = handle.info();
        if (!text(info?.leaseId, 128) || info.tabId !== tabId || info.lastInputSequence !== 0 || !["active", "navigating"].includes(info.state))
          throw failure("STREAM", "result viewing did not become available");
      }
      if (handle.closed?.then) void handle.closed.then(({ reason } = {}) => {
        if (record.retired || channel.stream !== record || channel.closed) return;
        void retireStream(channel, text(reason, 4096) ? reason : "original stream unavailable").catch(() => {});
      }, () => { if (!record.retired && channel.stream === record) void retireStream(channel, "original stream failed").catch(() => {}); });
      authority();
      if (record.earlyState) { const value = record.earlyState; record.earlyState = null; leaseStateChanged(channel, record, value); }
      if (record.earlyFrame) { const value = record.earlyFrame; record.earlyFrame = null; receiveFrame(channel, record, value); }
      return retained.receipt;
    } catch (error) {
      if (channel.stream === record) await retireStream(channel, "subscription unavailable");
      throw error;
    }
  }
  async function beginHuman(channel, tabId, epoch, deliveryId, pageSelectionId) {
    assertSelection(channel, epoch);
    if (typeof backend.beginManagedHuman !== "function") throw failure("HUMAN_UNAVAILABLE", "human control is unavailable");
    if (channel.stream?.human) throw failure("HUMAN_BUSY", "human control is already active");
    let tab = (await tabs(channel)).find(tab => tab.id === tabId);
    assertSelection(channel, epoch);
    checkTabSelection(tab, deliveryId, "takeover", pageSelectionId);
    await retireStream(channel, "human takeover requested");
    assertSelection(channel, epoch);
    await Promise.all([...cleanup]);
    assertSelection(channel, epoch);
    if (cleanupFailure) throw failure("CLEANUP", "original viewing cleanup is incomplete");
    const retained = await retainSelectedPage(channel, tab, epoch, pageSelectionId);
    assertSelection(channel, epoch);
    tab = retained.tab; deliveryId = tab.deliveryId;
    const record = { human: true, tabId, tab, retired: false, streamId: null, lastFrameSequence: 0, started: null, closing: null, handle: null, earlyFrame: null, earlyState: null, leaseGeneration: 0 };
    channel.retiredHuman = null;
    channel.stateEpoch++; channel.stream = record; channel.selectedTabId = tabId;
    channel.streamState = { state: "starting", streamId: null };
    const authority = () => {
      assertCurrent(channel);
      if (record.retired || channel.stream !== record) throw failure("HUMAN_STALE", "original human control was revoked");
    };
    record.started = Promise.resolve().then(() => {
      authority();
      return backend.beginManagedHuman(tabId, authority, value => {
        if (!record.handle) { record.earlyFrame = value; return; }
        receiveFrame(channel, record, value);
      }, value => leaseStateChanged(channel, record, value), {
        ...(deliveryId === undefined ? {} : { deliveryId }),
        ...(channel.browserVersion ? { browserVersion: channel.browserVersion } : {})
      });
    });
    try {
      const handle = await record.started;
      if (!handle || ["info", "input", "close"].some(key => typeof handle[key] !== "function")) throw failure("HUMAN_UNAVAILABLE", "invalid human control handle");
      record.handle = handle;
      const info = handle.info();
      if (!text(info?.leaseId, 128) || info.tabId !== tabId || !["preparing", "active", "navigating"].includes(info.state)) throw failure("HUMAN_UNAVAILABLE", "human control did not become available");
      if (handle.closed?.then) void handle.closed.then(() => {
        if (!record.retired && channel.stream === record) void retireStream(channel, "human control ended").catch(() => {});
      }, () => { if (!record.retired && channel.stream === record) void retireStream(channel, "human control failed").catch(() => {}); });
      authority();
      if (record.earlyState) { const value = record.earlyState; record.earlyState = null; leaseStateChanged(channel, record, value); }
      if (record.earlyFrame) {
        const value = record.earlyFrame; record.earlyFrame = null;
        receiveFrame(channel, record, value);
      }
      return retained.receipt;
    } catch (error) {
      if (channel.stream === record) await retireStream(channel, "human takeover unavailable");
      throw error;
    } finally { channel.stateEpoch++; }
  }
  async function open(input) {
    const value = fields(input, ["version", ...identityKeys, "channelKey"], ["recovery", "browserVersion"]);
    if (value.version !== 1 || value.runId !== runId || !text(value.extensionId, 32) || !/^[a-p]{32}$/.test(value.extensionId) ||
        !identityKeys.slice(2).every(key => text(value[key])) || !text(value.channelKey) || !/^[A-Za-z0-9_-]{32,256}$/.test(value.channelKey))
      throw failure("IDENTITY", "invalid managed worker identity or channel key");
    let browserVersion;
    if (Object.hasOwn(value, "browserVersion")) {
      const native = fields(value.browserVersion, ["product", "revision"]);
      if (![native.product, native.revision].every(value => typeof value === "string" && /^[\x21-\x7e]{1,256}$/.test(value)))
        throw failure("IDENTITY", "invalid original native browser version");
      // The manager reads these values on this original Browser root, then
      // supplies them through the same authenticated worker/port admission.
      browserVersion = Object.freeze({ product: native.product, revision: native.revision });
    }
    if (value.recovery !== undefined) {
      const recovery = fields(value.recovery, ["kind", "previousWorkerBootId", "browserIncarnation", "expectedJournalId", "expectedWorkerEpoch", "nonce"]);
      if (recovery.kind !== "worker-replacement" || !["previousWorkerBootId", "browserIncarnation", "expectedJournalId", "nonce"].every(key => text(recovery[key])) ||
          recovery.previousWorkerBootId === value.workerBootId || !Number.isSafeInteger(recovery.expectedWorkerEpoch) || recovery.expectedWorkerEpoch < 1)
        throw failure("IDENTITY", "invalid original worker recovery identity");
    }
    if (current) { try { assertCurrent(current); } catch { /* expired channel has been revoked */ } }
    if (current || opening) throw failure("BUSY", "one user channel is already open");
    if (cleanup.size || cleanupFailure) throw failure("CLEANUP", "previous viewer cleanup is incomplete");
    if (usedKeys.has(value.channelKey) || usedKeys.size >= 1024) throw failure("REPLAY", "retired channel key or worker channel capacity exhausted");
    const proof = nativeProof(), sink = target[BINDING];
    if (!proof || !text(proof.nonce) || typeof sink !== "function" || !identityKeys.slice(1).every(key => proof[key] === value[key]))
      throw failure("IDENTITY", "original native worker binding is unavailable");
    const ticket = {}, deadline = now() + LEASE_MS; opening = ticket;
    usedKeys.add(value.channelKey);
    const assertOpening = () => {
      if (now() >= deadline) throw failure("CLOSED", "original user open admission expired");
      if (nativeProof() !== proof || target[BINDING] !== sink)
        throw failure("IDENTITY", "original worker binding changed during open");
    };
    try {
      const admission = await backend.prepareManagedUserOpen({ workerBootId: value.workerBootId,
        ...(value.recovery ? { recovery: Object.freeze({ ...value.recovery }) } : {}) }, assertOpening);
      assertOpening();
      if (await getInstanceId() !== value.extensionInstanceId || nativeProof() !== proof || target[BINDING] !== sink)
        throw failure("IDENTITY", "original worker identity changed during open");
      assertOpening();
      const id = newChannelId();
      if (!text(id)) throw failure("CONFIG", "invalid channel identifier");
      const channel = { id, key: value.channelKey, identity: Object.fromEntries(identityKeys.map(key => [key, value[key]])), proof, nonce: proof.nonce, sink,
        deadline, closed: false, timer: null, sequence: 0, stateEpoch: 0, selectedTabId: null, stream: null,
        streamState: { state: "idle", streamId: null }, inFlight: null, latest: null, retiredAcks: new Set(), pendingResumes: 0, selectionEpoch: 0, selections: Promise.resolve(),
        nativeEpoch: admission?.epoch ?? null, browserVersion, pendingSelections: 0 };
      channels.set(channel.key, channel); current = latestChannel = channel; arm(channel);
      try {
        if (typeof backend.createManagedPageChoices === "function") {
          channel.pageChoices = backend.createManagedPageChoices({ check: () => assertCurrent(channel) });
          if (!channel.pageChoices || ["list", "select", "revoke", "drain"].some(key => typeof channel.pageChoices[key] !== "function"))
            throw failure("CONFIG", "invalid managed page catalog");
          channel.pageSelectionVersion = 1;
        }
        const result = { ...identity(channel), status: await status(channel), recoveryState: admission?.recoveryState,
          ...(admission?.workerRecovery ? { workerRecovery: admission.workerRecovery } : {}) };
        assertCurrent(channel);
        assertOpening();
        backend.commitManagedUserOpen(admission);
        return result;
      }
      catch (error) { await revoke(channel, "open failed"); throw error; }
    } finally { if (opening === ticket) opening = null; }
  }
  async function request(input) {
    // Read the operation through a data descriptor before deciding its schema.
    const operation = input && Object.getOwnPropertyDescriptor(input, "operation")?.value;
    if (operation === "retire") {
      const value = fields(input, ["channelKey", "operation", "channelId", "version", ...identityKeys]);
      const channel = typeof value.channelKey === "string" && channels.get(value.channelKey);
      if (!channel || value.version !== 1 || value.channelId !== channel.id ||
          !identityKeys.every(key => value[key] === channel.identity[key]))
        throw failure("IDENTITY", "original cleanup channel identity does not match");
      // This path deliberately does not consult current native proof. Its
      // exact retired channel can only close/join original resources, never
      // heartbeat, acquire authority, or affect a newer channel.
      return disconnectedStatus(channel, true);
    }
    const fileOperation = operation === "humanFileBegin" ? "begin" : operation === "humanFileCommit" ? "commit" : operation === "humanFileCancel" ? "cancel" : null;
    const extra = fileOperation ? ["leaseId", "generation", "chooserId", ...(fileOperation === "cancel" ? [] : ["transferId"]), ...(fileOperation === "commit" ? ["files"] : [])] :
      ["select", "humanBegin"].includes(operation) ? ["tabId"] : operation === "resume" ? ["expectedRevision", "expectedWorkerBootId"] : operation === "ack" ? ["sequence"] : operation === "humanEnd" ? ["leaseId"] : operation === "humanInput" ? ["leaseId", "generation", "sequence", "input"] : operation === "humanDialogRespond" ? ["leaseId", "generation", "dialogId", "accept"] : [];
    const optional = fileOperation === "cancel" ? ["transferId"] : ["select", "humanBegin"].includes(operation) ? ["deliveryId", "pageSelectionId"] : operation === "humanDialogRespond" ? ["promptText"] : [];
    const value = fields(input, ["channelKey", "operation", ...extra], optional);
    if (!["status", "select", "pause", "resume", "heartbeat", "ack", "disconnect", "humanBegin", "humanInput", "humanEnd", "humanDialogRespond", "humanFileBegin", "humanFileCommit", "humanFileCancel"].includes(operation) ||
        typeof value.channelKey !== "string" || (operation === "select" && value.tabId !== null && !integer(value.tabId)) ||
        (operation === "humanBegin" && (!integer(value.tabId) || value.tabId < 1)) ||
        (value.deliveryId !== undefined && (!text(value.deliveryId, 128) || value.tabId === null)) ||
        (value.pageSelectionId !== undefined && (!text(value.pageSelectionId, 128) || value.tabId === null || value.deliveryId !== undefined)) ||
        (["humanInput", "humanEnd"].includes(operation) && !text(value.leaseId, 128)) ||
        (operation === "humanInput" && (!integer(value.generation) || value.generation < 1 || !integer(value.sequence) || value.sequence < 1)) ||
        (operation === "resume" && (!integer(value.expectedRevision) || !text(value.expectedWorkerBootId))) ||
        (operation === "ack" && (!integer(value.sequence) || value.sequence < 1)))
      throw failure("PROTOCOL", "invalid typed user operation");
    const channel = current;
    assertCurrent(channel);
    if (channel.key !== value.channelKey) throw failure("IDENTITY", "channel key does not match");
    if (value.pageSelectionId !== undefined && !channel.pageSelectionVersion) throw failure("PROTOCOL", "browser page selection is unavailable on this channel");
    if (operation === "heartbeat") { channel.deadline = now() + LEASE_MS; arm(channel); }
    if (operation === "ack") {
      if (channel.retiredAcks.delete(value.sequence))
        return { acknowledged: value.sequence, workerBootId: channel.identity.workerBootId };
      if (!channel.inFlight || channel.inFlight.sequence !== value.sequence) throw failure("ACK", "acknowledgement does not match the outstanding frame");
      channel.inFlight = null;
      if (channel.latest) { const frame = channel.latest; channel.latest = null; sendFrame(channel, frame); }
      return { acknowledged: value.sequence, workerBootId: channel.identity.workerBootId };
    }
    if (operation === "disconnect") {
      return disconnectedStatus(channel);
    }
    let inputReceipt, dialogReceipt, fileResult, checkClipboardPublication, pageSelectionReceipt, checkRetiredHuman;
    if (fileOperation) {
      const envelope = Object.fromEntries([...extra, ...optional].filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
      validateHumanFileRequest(envelope, fileOperation);
      const record = channel.stream, handle = record?.human && !record.retired && record.handle;
      const before = handle?.info(), chooser = handle?.pendingFileChooser?.();
      const method = { begin: "beginFile", commit: "commitFile", cancel: "cancelFile" }[fileOperation];
      if (!before || before.state !== "active" || before.fileChooserVersion !== 1 || before.leaseId !== value.leaseId || before.generation !== value.generation ||
          !chooser || chooser.leaseId !== value.leaseId || chooser.generation !== value.generation ||
          chooser.chooserId !== value.chooserId || typeof handle[method] !== "function")
        throw failure("HUMAN_FILE_STALE", "original file chooser is unavailable");
      const accepted = await handle[method](envelope);
      const expected = { leaseId: value.leaseId, generation: value.generation, chooserId: value.chooserId,
        ...(value.transferId === undefined ? {} : { transferId: value.transferId }),
        ...(fileOperation === "commit" ? { acknowledged: true } : fileOperation === "cancel" ? { cancelled: true } : {}) };
      if (!accepted || Reflect.ownKeys(accepted).length !== Object.keys(expected).length ||
          !Object.entries(expected).every(([key, item]) => Object.hasOwn(accepted, key) && accepted[key] === item)) {
        if (channel.stream === record) await retireStream(channel, "original file chooser receipt unavailable");
        throw failure("HUMAN_FILE_UNCONFIRMED", "original file operation receipt is unavailable; do not replay");
      }
      fileResult = { [{ begin: "fileChooserClaim", commit: "fileChooserReceipt", cancel: "fileChooserCancellation" }[fileOperation]]: expected };
    } else if (operation === "humanDialogRespond") {
      const envelope = Object.fromEntries([...extra, "promptText"].filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
      validateHumanDialogResponse(envelope);
      const record = channel.stream, handle = record?.human && !record.retired && record.handle;
      const before = handle?.info(), dialog = handle?.pendingDialog?.();
      if (!before || !["preparing", "active", "navigating"].includes(before.state) || before.leaseId !== value.leaseId || before.generation !== value.generation ||
          !dialog || dialog.leaseId !== value.leaseId || dialog.generation !== value.generation || dialog.dialogId !== value.dialogId || typeof handle.respondDialog !== "function")
        throw failure("HUMAN_DIALOG_STALE", "original human dialog is no longer available; no response was sent");
      const accepted = await handle.respondDialog(envelope);
      if (accepted?.acknowledged !== true || accepted.leaseId !== value.leaseId || accepted.generation !== value.generation || accepted.dialogId !== value.dialogId) {
        if (channel.stream === record) await retireStream(channel, "original dialog acknowledgement unavailable");
        throw failure("HUMAN_DIALOG_UNCONFIRMED", "original native dialog receipt is unavailable; do not replay the response");
      }
      dialogReceipt = { leaseId: accepted.leaseId, generation: accepted.generation, dialogId: accepted.dialogId, acknowledged: true };
    } else if (operation === "humanInput") {
      const record = channel.stream, handle = record?.human && !record.retired && record.handle;
      const before = handle?.info();
      if (before?.leaseId === value.leaseId && (before.generation > value.generation || before.state === "navigating" && before.generation === value.generation))
        throw failure("HUMAN_GENERATION_STALE", "original document input was not dispatched; wait for the current frame");
      if (!before || before.state !== "active" || before.leaseId !== value.leaseId || before.generation !== value.generation)
        throw failure("HUMAN_STALE", "original human lease and geometry are no longer active");
      const clipboardOperation = validateHumanClipboardInput(value.input);
      if (clipboardOperation && before.clipboardTransferVersion !== 1)
        throw failure("HUMAN_STALE", "original human lease does not support clipboard transfer");
      const accepted = await handle.input({ leaseId: value.leaseId, generation: value.generation, sequence: value.sequence, input: value.input });
      if (accepted?.acknowledged !== true || accepted.leaseId !== value.leaseId || accepted.generation !== value.generation || accepted.sequence !== value.sequence) {
        if (channel.stream === record) await retireStream(channel, "original input acknowledgement unavailable");
        throw failure("HUMAN_UNCONFIRMED", "original input receipt is unavailable; do not replay the input");
      }
      // The click's actual receipt and the current page status are different
      // facts. A click which caused navigation still owns its original ACK.
      inputReceipt = { leaseId: accepted.leaseId, generation: accepted.generation, sequence: accepted.sequence, acknowledged: true };
      if (clipboardOperation) {
        try { inputReceipt.clipboardTransfer = validateHumanClipboardResult(accepted.clipboardTransfer, clipboardOperation); }
        catch {
          // A malformed optional payload cannot erase the proven native key
          // ACK or authorize replaying a cut. Never expose its untrusted text.
          inputReceipt.clipboardTransfer = { operation: clipboardOperation, status: "failed", code: "READ_FAILED" };
        }
        checkClipboardPublication = () => {
          const current = handle.info();
          if (inputReceipt.clipboardTransfer.status === "ready" && (channel.stream !== record || record.retired ||
              current?.state !== "active" || current.leaseId !== value.leaseId || current.generation !== value.generation))
            inputReceipt.clipboardTransfer = { operation: clipboardOperation, status: "failed", code: "CANCELLED" };
        };
      }
    } else if (operation === "humanEnd") {
      const record = channel.stream ?? channel.retiredHuman;
      if (!record?.human || !record.handle || record.handle.info().leaseId !== value.leaseId) throw failure("HUMAN_STALE", "original human lease is no longer active");
      if (channel.stream === record) await retireStream(channel, "human control finished");
      else {
        // Native page closure retires publication before its actual cleanup.
        // The same lease may join that original close; it never ends a successor.
        checkRetiredHuman = () => {
          assertCurrent(channel);
          if (channel.stream || channel.retiredHuman !== record || record.handle.info().leaseId !== value.leaseId)
            throw failure("HUMAN_STALE", "original retired human lease was superseded");
        };
        checkRetiredHuman();
        await record.closing;
        checkRetiredHuman();
      }
      await Promise.all([...cleanup]);
      checkRetiredHuman?.();
      if (cleanupFailure) throw failure("CLEANUP", "human cleanup is unconfirmed");
    } else if (operation === "humanBegin") {
      const epoch = channel.selectionEpoch;
      channel.pendingSelections++;
      const selected = channel.selections.catch(() => {}).then(() => beginHuman(channel, value.tabId, epoch, value.deliveryId, value.pageSelectionId));
      channel.selections = selected;
      try { pageSelectionReceipt = await selected; } finally { channel.pendingSelections--; }
    } else if (operation === "select") {
      if (value.tabId === null) await cancelSelections(channel, "selection cleared");
      else {
        const epoch = channel.selectionEpoch;
        channel.pendingSelections++;
        const selected = channel.selections.catch(() => {}).then(() => select(channel, value.tabId, epoch, value.deliveryId, value.pageSelectionId));
        channel.selections = selected;
        try { pageSelectionReceipt = await selected; } finally { channel.pendingSelections--; }
      }
    } else if (operation === "pause") {
      channel.stateEpoch++;
      const released = cancelSelections(channel, "automation paused");
      try { await Promise.all([released, backend.pauseAutomation()]); }
      finally { channel.stateEpoch++; }
    } else if (operation === "resume") {
      if (value.expectedWorkerBootId !== channel.identity.workerBootId) throw failure("REVISION", "worker changed; refresh status before resuming");
      if (channel.pendingSelections) throw failure("BUSY", "wait for original page selection before resuming the Agent");
      // User viewing has no task or input authority. Explicit Resume retires
      // its original native lease before task admission can start again.
      if (channel.stream?.view) await cancelSelections(channel, "result viewing ended before resume");
      const assertResume = () => {
        assertCurrent(channel);
        if (channel.stream?.human || channel.stream?.view) throw failure("HUMAN_BUSY", "finish original user page control before resuming the Agent");
        if (cleanup.size || cleanupFailure) throw failure("CLEANUP", "original viewer cleanup is incomplete");
      };
      assertResume();
      channel.stateEpoch++;
      channel.pendingResumes++;
      try { await backend.resumeAutomation(value.expectedRevision, assertResume); }
      finally { channel.pendingResumes--; channel.stateEpoch++; }
    }
    assertCurrent(channel);
    const currentStatus = await status(channel, operation !== "status");
    // Status collection can cross a navigation or End. Publish clipboard text
    // only after that final asynchronous boundary, keeping the original ACK.
    checkClipboardPublication?.();
    checkRetiredHuman?.();
    return { status: currentStatus, ...(inputReceipt ? { inputReceipt } : {}), ...(dialogReceipt ? { dialogReceipt } : {}),
      ...(pageSelectionReceipt ? { pageSelectionReceipt } : {}), ...fileResult };
  }
  const api = Object.freeze({ open, request });
  Object.defineProperty(target, API, { value: api, configurable: false, writable: false, enumerable: false });
  return api;
}
