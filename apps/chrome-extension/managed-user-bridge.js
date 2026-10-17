import { resolveManagedNativeHost } from "./managed-native-host.js";

const API = "__obuManagedUser", BINDING = "__obuManagedViewerEvent";
const LEASE_MS = 10000, HEARTBEAT_MS = 3000, MAX_FRAME_BYTES = 4 * 1024 * 1024;
const identityKeys = ["runId", "extensionId", "extensionInstanceId", "workerBootId", "portId"];
const failure = (code, message) => new Error(`OBU_MANAGED_USER_${code}: ${message}`);
const text = (value, max = 256) => typeof value === "string" && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;

// Data descriptors only: this private JSON-shaped surface never invokes a
// supplied getter, accepts inherited authority, or forwards arbitrary CDP.
function fields(value, required) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw failure("PROTOCOL", "expected an object");
  const keys = Reflect.ownKeys(value), descriptors = Object.getOwnPropertyDescriptors(value);
  if (keys.length !== required.length || keys.some(key => !required.includes(key)) ||
      required.some(key => !descriptors[key] || !Object.hasOwn(descriptors[key], "value")))
    throw failure("PROTOCOL", "unexpected, missing, or non-data field");
  return Object.fromEntries(required.map(key => [key, descriptors[key].value]));
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
  return { tabId: value.tabId, streamId: value.streamId, frameSequence: value.sequence, mimeType: value.mimeType, data: value.data, metadata };
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
  if (!backend || ["getManagedViewerTabs", "managedViewerSubscribe", "getAutomationControlStatus", "pauseAutomation", "resumeAutomation"].some(key => typeof backend[key] !== "function") ||
      typeof getInstanceId !== "function" || typeof nativeProof !== "function" || !target || Object.hasOwn(target, API))
    throw failure("CONFIG", "a managed backend and an unused worker surface are required");

  let current = null, opening = null;
  const usedKeys = new Set(), cleanup = new Set();
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
    if (publish && !channel.closed) {
      try { emit(channel, { type: "clear", reason }); } catch { /* revoke already fenced delivery */ }
    }
    if (!record.closing) record.closing = trackCleanup((async () => {
      let handle;
      try { handle = await record.started; }
      catch (error) {
        // Ordinary startup rejection follows its actual cleanup. A native
        // cleanup failure must remain a barrier even when no handle arrived.
        if (error?.viewerCleanupIncomplete) throw error;
        return;
      }
      await handle.close();
    })());
    return record.closing;
  }
  function revoke(channel, reason, publish = true) {
    if (channel.closed) return channel.closedPromise ?? Promise.resolve();
    channel.closed = true;
    if (current === channel) current = null;
    clearTimer(channel.timer);
    const retired = retireStream(channel, reason, false);
    const releases = [...cleanup, retired];
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
    }));
    return channel.closedPromise;
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
  function receiveFrame(channel, record, value) {
    if (record.retired || channel.stream !== record || channel.closed) return;
    try {
      assertCurrent(channel);
      const frame = frameCopy(value);
      if (frame.tabId !== record.tabId) throw failure("FRAME", "frame belongs to a different tab");
      if (record.streamId && record.streamId !== frame.streamId) throw failure("FRAME", "original stream identity changed");
      if (frame.frameSequence <= record.lastFrameSequence) return;
      record.streamId = frame.streamId; record.lastFrameSequence = frame.frameSequence;
      if (channel.streamState.state !== "streaming" || channel.streamState.streamId !== frame.streamId) channel.stateEpoch++;
      channel.streamState = { state: "streaming", streamId: frame.streamId };
      if (channel.inFlight) channel.latest = frame;
      else sendFrame(channel, frame);
    } catch (error) {
      if (channel.closed) return;
      void retireStream(channel, "frame unavailable").catch(() => {});
      channel.streamState = { state: "error", streamId: null, error: String(error.message) };
      try { emit(channel, { type: "error", error: String(error.message) }); } catch { /* revoked */ }
    }
  }
  async function tabs(channel) {
    assertCurrent(channel);
    const result = await backend.getManagedViewerTabs();
    assertCurrent(channel);
    if (!Array.isArray(result) || result.length > 4096) throw failure("TABS", "invalid live attachment list");
    const ids = new Set();
    return result.map(tab => {
      if (!integer(tab.id) || ids.has(tab.id)) throw failure("TABS", "invalid live attachment identity");
      ids.add(tab.id);
      return { id: tab.id, title: typeof tab.title === "string" ? tab.title.slice(0, 512) : "", url: typeof tab.url === "string" ? tab.url.slice(0, 8192) : "" };
    });
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
      if (channel.selectedTabId !== null && !liveTabs.some(tab => tab.id === channel.selectedTabId)) {
        await retireStream(channel, "original attachment unavailable");
        continue;
      }
      const value = { ...identity(channel), connected: true, leaseMs: LEASE_MS, heartbeatMs: HEARTBEAT_MS,
        expiresAt: Math.ceil(wallNow() + Math.max(0, channel.deadline - now())), selectedTabId: channel.selectedTabId,
        automation, tabs: liveTabs, stream: { ...channel.streamState }, cleanupPending: cleanup.size,
        eventSequence: channel.sequence + (publish ? 1 : 0),
        ...(cleanupFailure ? { cleanupError: String(cleanupFailure.message ?? cleanupFailure) } : {}) };
      if (JSON.stringify(value).length > 1024 * 1024) throw failure("CAPACITY", "live metadata status exceeds its bound");
      channel.lastStatus = value;
      if (publish) emit(channel, { type: "status", status: value });
      return value;
    }
    throw failure("STALE_STATUS", "control state kept changing during metadata inspection");
  }
  async function select(channel, tabId) {
    assertCurrent(channel);
    if (tabId !== null && !(await tabs(channel)).some(tab => tab.id === tabId))
      throw failure("TAB", "only an existing owned attached tab can be selected");
    assertCurrent(channel);
    if (channel.selectedTabId === tabId && !cleanup.size && !cleanupFailure) return;
    await retireStream(channel, "selection changed");
    await Promise.all([...cleanup]);
    assertCurrent(channel);
    if (cleanupFailure) throw failure("CLEANUP", String(cleanupFailure.message ?? cleanupFailure));
    if (tabId === null) return;
    const record = { tabId, retired: false, streamId: null, lastFrameSequence: 0, started: null, closing: null };
    channel.stateEpoch++;
    channel.stream = record; channel.selectedTabId = tabId;
    channel.streamState = { state: "starting", streamId: null };
    record.started = Promise.resolve().then(() => {
      assertCurrent(channel);
      if (record.retired || channel.stream !== record) throw failure("CLOSED", "original selection was revoked");
      return backend.managedViewerSubscribe(tabId, frame => receiveFrame(channel, record, frame));
    });
    try {
      const handle = await record.started;
      if (!handle || typeof handle.close !== "function") throw failure("STREAM", "invalid viewer subscription");
      if (handle.closed?.then) void handle.closed.then(({ reason } = {}) => {
        if (record.retired || channel.stream !== record || channel.closed) return;
        void retireStream(channel, text(reason, 4096) ? reason : "original stream unavailable").catch(() => {});
      }, () => { if (!record.retired && channel.stream === record) void retireStream(channel, "original stream failed").catch(() => {}); });
      assertCurrent(channel);
      if (record.retired || channel.stream !== record) throw failure("CLOSED", "original selection was revoked");
    } catch (error) {
      if (channel.stream === record) await retireStream(channel, "subscription unavailable");
      throw error;
    }
  }
  async function open(input) {
    const value = fields(input, ["version", ...identityKeys, "channelKey"]);
    if (value.version !== 1 || value.runId !== runId || !text(value.extensionId, 32) || !/^[a-p]{32}$/.test(value.extensionId) ||
        !identityKeys.slice(2).every(key => text(value[key])) || !text(value.channelKey) || !/^[A-Za-z0-9_-]{32,256}$/.test(value.channelKey))
      throw failure("IDENTITY", "invalid managed worker identity or channel key");
    if (current) { try { assertCurrent(current); } catch { /* expired channel has been revoked */ } }
    if (current || opening) throw failure("BUSY", "one user channel is already open");
    if (cleanup.size || cleanupFailure) throw failure("CLEANUP", "previous viewer cleanup is incomplete");
    if (usedKeys.has(value.channelKey) || usedKeys.size >= 1024) throw failure("REPLAY", "retired channel key or worker channel capacity exhausted");
    const proof = nativeProof(), sink = target[BINDING];
    if (!proof || !text(proof.nonce) || typeof sink !== "function" || !identityKeys.slice(1).every(key => proof[key] === value[key]))
      throw failure("IDENTITY", "original native worker binding is unavailable");
    const ticket = {}; opening = ticket;
    try {
      if (await getInstanceId() !== value.extensionInstanceId || nativeProof() !== proof || target[BINDING] !== sink)
        throw failure("IDENTITY", "original worker identity changed during open");
      const id = newChannelId();
      if (!text(id)) throw failure("CONFIG", "invalid channel identifier");
      const channel = { id, key: value.channelKey, identity: Object.fromEntries(identityKeys.map(key => [key, value[key]])), proof, nonce: proof.nonce, sink,
        deadline: now() + LEASE_MS, closed: false, timer: null, sequence: 0, stateEpoch: 0, selectedTabId: null, stream: null,
        streamState: { state: "idle", streamId: null }, inFlight: null, latest: null, pendingResumes: 0, selections: Promise.resolve() };
      usedKeys.add(channel.key); current = channel; arm(channel);
      try { return { ...identity(channel), status: await status(channel) }; }
      catch (error) { await revoke(channel, "open failed"); throw error; }
    } finally { if (opening === ticket) opening = null; }
  }
  async function request(input) {
    // Read the operation through a data descriptor before deciding its schema.
    const operation = input && Object.getOwnPropertyDescriptor(input, "operation")?.value;
    const extra = operation === "select" ? ["tabId"] : operation === "resume" ? ["expectedRevision", "expectedWorkerBootId"] : operation === "ack" ? ["sequence"] : [];
    const value = fields(input, ["channelKey", "operation", ...extra]);
    if (!["status", "select", "pause", "resume", "heartbeat", "ack", "disconnect"].includes(operation) ||
        typeof value.channelKey !== "string" || (operation === "select" && value.tabId !== null && !integer(value.tabId)) ||
        (operation === "resume" && (!integer(value.expectedRevision) || !text(value.expectedWorkerBootId))) ||
        (operation === "ack" && (!integer(value.sequence) || value.sequence < 1)))
      throw failure("PROTOCOL", "invalid typed user operation");
    const channel = current;
    assertCurrent(channel);
    if (channel.key !== value.channelKey) throw failure("IDENTITY", "channel key does not match");
    if (operation === "heartbeat") { channel.deadline = now() + LEASE_MS; arm(channel); }
    if (operation === "ack") {
      if (!channel.inFlight || channel.inFlight.sequence !== value.sequence) throw failure("ACK", "acknowledgement does not match the outstanding frame");
      channel.inFlight = null;
      if (channel.latest) { const frame = channel.latest; channel.latest = null; sendFrame(channel, frame); }
      return { acknowledged: value.sequence, workerBootId: channel.identity.workerBootId };
    }
    if (operation === "disconnect") {
      const previous = channel.lastStatus;
      await revoke(channel, "manager disconnected");
      return { disconnected: true, status: { ...previous, connected: false, selectedTabId: null, stream: { state: "idle", streamId: null } } };
    }
    if (operation === "select") {
      const selected = channel.selections.catch(() => {}).then(() => select(channel, value.tabId));
      channel.selections = selected; await selected;
    } else if (operation === "pause") {
      channel.stateEpoch++;
      const released = retireStream(channel, "automation paused");
      try { await Promise.all([released, backend.pauseAutomation()]); }
      finally { channel.stateEpoch++; }
    } else if (operation === "resume") {
      if (value.expectedWorkerBootId !== channel.identity.workerBootId) throw failure("REVISION", "worker changed; refresh status before resuming");
      const assertResume = () => {
        assertCurrent(channel);
        if (cleanup.size || cleanupFailure) throw failure("CLEANUP", "original viewer cleanup is incomplete");
      };
      assertResume();
      channel.stateEpoch++;
      channel.pendingResumes++;
      try { await backend.resumeAutomation(value.expectedRevision, assertResume); }
      finally { channel.pendingResumes--; channel.stateEpoch++; }
    }
    assertCurrent(channel);
    return { status: await status(channel, operation !== "status") };
  }
  const api = Object.freeze({ open, request });
  Object.defineProperty(target, API, { value: api, configurable: false, writable: false, enumerable: false });
  return api;
}
