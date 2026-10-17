import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { downloadScope } from "./download-waits-fixture.mjs";
import { readOriginalDownloadProof } from "./original-download-proof.mjs";

const stamp = () => ({ at: Date.now(), monotonicMs: performance.now() });
const describe = error => ({ name: error?.name, message: error?.message ?? String(error), stack: error?.stack });
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const unowned = /OBU_DOWNLOAD_EXPIRED:.*(?:unknown|unowned)/i;

// Serialized into the exact managed worker. This is a passive listener only:
// no Native Port, Input, Browser configuration, product method or ACK is wrapped.
export function installManagedDownloadWitness(chrome, target, identity, maximum = 512) {
  if (target.__managedDownloadProof || typeof identity !== "string" || !identity ||
      !Number.isSafeInteger(maximum) || maximum < 1 || maximum > 512) throw Error("Invalid managed download observer installation");
  const watched = new Set(), events = []; let overflow = false, stopped = false;
  const listener = (source, method, params) => {
    if (!watched.has(source?.tabId) || !["Page.downloadWillBegin", "Page.downloadProgress", "Target.attachedToTarget"].includes(method)) return;
    if (method === "Target.attachedToTarget" && params?.targetInfo?.type !== "iframe") return;
    if (events.length >= maximum || JSON.stringify(params).length > 65536) { overflow = true; return; }
    events.push({ sequence: events.length, at: Date.now(), monotonicMs: performance.now(), source: structuredClone(source), method, params: structuredClone(params) });
  };
  const snapshot = () => ({ identity, watched: [...watched], events: structuredClone(events), overflow, stopped });
  const api = {
    watch(tabId) {
      if (stopped || !Number.isSafeInteger(tabId) || tabId < 0 || (!watched.has(tabId) && watched.size >= 8)) throw Error("Managed download observer tab limit or identity changed");
      watched.add(tabId); return snapshot();
    },
    snapshot,
    stop() {
      if (target.__managedDownloadProof !== api) throw Error("Original managed download observer was replaced");
      chrome.debugger.onEvent.removeListener(listener); stopped = true;
      const value = snapshot(); delete target.__managedDownloadProof; return value;
    }
  };
  target.__managedDownloadProof = api; chrome.debugger.onEvent.addListener(listener); return snapshot();
}

function assertBytes(value) {
  assert.equal(value.truncated ?? false, false);
  const bytes = Buffer.from(value.base64, "base64");
  assert.equal(bytes.length, value.bytes); assert.equal(sha(bytes), value.sha256); return bytes;
}

export function assertManagedDownloadJournal(stats, cases, { requests, gets, posts }) {
  const assigned = cases.flatMap(item => item.server.requests).sort((a, b) => a.sequence - b.sequence);
  assert.equal(assigned.length, requests); assert.equal(new Set(assigned.map(row => row.sequence)).size, requests);
  assert.equal(stats.requests.length, requests, "No unassigned HTTP request may be hidden outside individual cases");
  assert.deepEqual(stats.requests, assigned, "Global original HTTP journal must equal the exact case request union");
  assert.equal(stats.requests.filter(row => row.method === "GET").length, gets);
  assert.equal(stats.requests.filter(row => row.method === "POST").length, posts);
}

// Pure checks shared by the real workflow and deliberate falsification tests.
export function assertManagedDownloadTransfer(item, { held = false, cancelled = false } = {}) {
  const { record, page, server } = item;
  assert.equal(page.key, record.key); assert.equal(page.owner, record.owner);
  assert.equal(page.expectedSHA, record.expected.sha256); assert.equal(page.clicks.length, 1);
  assert.equal(page.clicks[0].trusted, true); assert.equal(page.clicks[0].buttonCount, 1);
  assert.equal(page.clicks[0].documentToken, page.documentToken);
  if (record.kind === "blob") assert.equal(page.clicks[0].revoked, true);
  const gets = server.requests.filter(row => row.method === "GET");
  assert.equal(gets.length, item.variant === "root" ? 1 : 2, "Original documents may not be reopened");
  assert.equal(server.gets.length, gets.length);
  for (const get of gets) { assert.equal(get.status, 200); assert.equal(get.finished, true); assert.equal(get.closed, true); assertBytes(get.response); }
  const posts = server.requests.filter(row => row.method === "POST");
  assert.equal(posts.length, record.kind === "blob" ? 0 : 1, "Original POST must not be replayed");
  assert.equal(server.requests.length, gets.length + posts.length);
  for (const post of posts) {
    const body = assertBytes(post.body); assert.equal(post.receivedBytes, body.length);
    assert.equal(post.status, 200); assert.equal(post.url, record.reportPath);
    assert.equal(post.fields.documentToken, page.documentToken); assert.equal(post.fields.trusted, "true"); assert.equal(post.fields.buttonCount, "1");
    assert.deepEqual(Object.fromEntries(new URLSearchParams(body.toString())), post.fields);
    assert.deepEqual(post.response, record.expected); assertBytes(post.response);
    assert.equal(post.finished, !cancelled); assert.equal(post.closed, true);
    if (held) {
      assert.equal(post.once, true); assert.equal(post.range, null); assert.equal(post.prefixFlushed, true);
      assert.equal(post.prefixBytes, 4096); assert.equal(post.aborted, cancelled);
      assert.equal(post.fields.key, record.key); assert.equal(post.fields.nonce, record.nonce);
      assert.equal(post.queuedBytes, cancelled ? 4096 : record.expected.bytes);
      assert.equal(post.closedByFixture ?? false, false, "Fixture teardown is not a native cancellation");
      assert.equal(post.interrupted ?? false, false); assert.equal(post.socketDestroyed ?? false, false);
      if (cancelled) assert.equal(post.released ?? false, false);
      else assert.equal(post.released, true);
    } else {
      assert.equal(post.fields.owner, record.owner); assert.equal(post.fields.token, record.token);
    }
  }
  if (cancelled) {
    assert.deepEqual(item.cancelAcknowledgement, { cancelled: true });
    assert.ok(item.pathRejection?.verified); assert.match(item.pathRejection.error.message, /OBU_NATIVE_DOWNLOAD_CANCELED/);
    assert.equal(item.file, undefined);
  } else {
    assert.equal(item.file.sha256, record.expected.sha256); assert.equal(item.file.bytes, record.expected.bytes);
    assert.equal(item.file.analysis.key, record.key); assert.equal(item.file.analysis.nonce, record.nonce); assert.equal(item.file.analysis.owner, record.owner);
  }
}

function documentsExpression(tabId) {
  return `(async()=>({frames:await chrome.webNavigation.getAllFrames({tabId:${tabId}}),targets:await chrome.debugger.getTargets(),documents:await chrome.scripting.executeScript({target:{tabId:${tabId},allFrames:true},func:()=>({url:location.href,state:JSON.parse(document.querySelector('#state').textContent)})})}))()`;
}

function originalDocument(snapshot, frameId) {
  const matches = snapshot.documents.filter(row => row.frameId === frameId);
  assert.equal(matches.length, 1); assert.ok(matches[0].documentId); return matches[0];
}

// Page.getFrameTree is scoped to its native session; a root tree may omit a
// remote child entirely. Resolve this fixture's single direct OOPIF using the
// existing passive attachment, then read that exact session without attaching.
export function selectManagedDownloadFrame(item, trace) {
  const { beforeTrigger: snapshot, rootTarget, nativeFrameTree } = item;
  const roots = snapshot.frames.filter(frame => frame.frameId === 0);
  assert.equal(roots.length, 1); const root = roots[0], rootDocument = originalDocument(snapshot, 0);
  assert.equal(rootDocument.documentId, root.documentId); assert.equal(rootDocument.result.url, root.url);
  assert.equal(nativeFrameTree.frameTree.frame.id, rootTarget.id);
  assert.equal(nativeFrameTree.frameTree.frame.url, root.url);
  assert.ok(nativeFrameTree.frameTree.frame.loaderId);
  if (item.variant === "root") return { source: { tabId: item.tabId }, webFrame: root, document: rootDocument };
  const frames = snapshot.frames.filter(frame => frame.parentFrameId === 0 && new URL(frame.url).searchParams.get("key") === item.record.key);
  assert.equal(frames.length, 1, "Expected exactly one original direct download iframe");
  const frame = frames[0], document = originalDocument(snapshot, frame.frameId);
  assert.notEqual(frame.processId, root.processId, "Expected an actual OOPIF process");
  assert.equal(frame.parentDocumentId, root.documentId); assert.equal(document.documentId, frame.documentId);
  assert.equal(document.result.url, frame.url);
  const attached = trace.events.filter(event => event.method === "Target.attachedToTarget" &&
    event.source.tabId === item.tabId && event.source.sessionId === undefined &&
    event.params.targetInfo?.type === "iframe" && event.params.targetInfo.parentFrameId === rootTarget.id);
  assert.equal(attached.length, 1, "Expected exactly one original direct OOPIF attachment");
  const original = attached[0], target = original.params.targetInfo;
  assert.ok(original.params.sessionId && target.targetId); assert.notEqual(target.targetId, rootTarget.id);
  if (target.parentId !== undefined) assert.equal(target.parentId, rootTarget.id);
  return { source: { tabId: item.tabId, sessionId: original.params.sessionId }, webFrame: frame, document, attachedFrame: original };
}

export function assertManagedDownloadFrame(item, trace, begin) {
  const selected = selectManagedDownloadFrame(item, trace);
  let native = item.nativeFrameTree.frameTree.frame;
  if (item.variant !== "root") {
    const child = item.childNativeFrame;
    assert.ok(child, "Original OOPIF native tree must be captured before input");
    assert.deepEqual(child.source, selected.source); assert.deepEqual(child.webFrame, selected.webFrame);
    assert.deepEqual(child.document, selected.document); assert.deepEqual(child.attachedFrame, selected.attachedFrame);
    native = child.nativeFrameTree.frameTree.frame;
    assert.equal(native.id, selected.attachedFrame.params.targetInfo.targetId);
    // Frame.parentId is optional on this session-scoped reply. The original
    // attached target's parentFrameId above is mandatory for this direct child.
    if (native.parentId !== undefined) assert.equal(native.parentId, item.rootTarget.id);
    assert.equal(native.url, selected.webFrame.url); assert.ok(native.loaderId);
    assert.ok(child.completed.at >= child.started.at && selected.attachedFrame.at <= child.started.at);
    if (item.trigger) assert.ok(child.completed.at <= item.trigger.at, "Original child tree must precede the only click");
  }
  if (begin) {
    assert.deepEqual(begin.source, selected.source); assert.equal(begin.params.frameId, native.id);
    if (selected.attachedFrame) assert.ok(selected.attachedFrame.sequence < begin.sequence && selected.attachedFrame.at <= begin.at);
  }
  return selected;
}

export async function checkManagedDownloads({ owner, foreign, worker, fixture, heldFixture, fixtureURL, downloadRoot, until, detail = {} }) {
  assert.ok(path.isAbsolute(downloadRoot));
  Object.assign(detail, { version: 1, started: stamp(), passed: false,
    boundary: "Eight original downloads through managed production Native Port binding; public original ACKs, passive Page/iframe events, and exact returned-path bytes. No Browser raw-command trace, Native Port adapter, rebind, preference mutation, filename inference, input replay or OS mouse automation.",
    cases: [], files: [], operations: [], notifications: { owner: [], foreign: [] }, cleanup: [], cleanupErrors: [] });
  const waiters = [], unsubscribe = [], witnessID = randomUUID(); let installed = false, primary;
  const operation = async (label, params, fn, project = value => value ?? null) => {
    const row = { label, params: structuredClone(params), started: stamp() }; detail.operations.push(row);
    try { const value = await fn(); row.result = structuredClone(project(value)); row.acknowledged = stamp(); return value; }
    catch (error) { row.error = describe(error); row.failed = stamp(); throw error; }
  };
  const rejection = async (label, params, fn, pattern) => {
    let failure;
    try { await operation(label, params, fn); } catch (error) { failure = error; }
    assert.ok(failure, label + " unexpectedly succeeded"); assert.match(failure.message, pattern);
    return { verified: true, error: describe(failure), at: Date.now() };
  };
  const witness = async (method = "snapshot", tabId) => {
    const value = await worker.evaluate(`(()=>{const p=globalThis.__managedDownloadProof;if(!p||p.snapshot().identity!==${JSON.stringify(witnessID)})throw Error('Original managed download witness unavailable');return p.${method}(${tabId === undefined ? "" : tabId})})()`);
    detail.witnessLatest = value;
    if (method === "stop") detail.witnessFinal = value;
    assert.equal(value.identity, witnessID); assert.equal(value.overflow, false); return value;
  };
  const cleanupWait = async entry => {
    entry.attempted = true;
    entry.item.waitCleanup = { started: stamp() };
    try {
      await operation(entry.item.label + ".cancelWait", { ...entry.item.scope, tabId: entry.item.tabId, waiterId: entry.waiter.waiterId }, () => entry.waiter.cancel());
      entry.item.waitCleanup.completed = stamp();
    } catch (error) { entry.item.waitCleanup.error = describe(error); throw error; }
  };
  const snapshot = async item => {
    const value = await worker.evaluate(documentsExpression(item.tabId));
    const targets = value.targets.filter(target => target.type === "page" && target.tabId === item.tabId);
    assert.equal(targets.length, 1); assert.equal(targets[0].id, item.rootTarget.id); return value;
  };
  const terminal = async (item, state) => {
    const trace = await until(async () => {
      const value = await witness();
      return value.events.some(row => row.method === "Page.downloadProgress" && row.params.guid === item.guid && row.params.state === state) ? value : false;
    }, item.label + " original Page terminal event", 10000);
    const events = trace.events.filter(row => row.params.guid === item.guid);
    const begins = events.filter(row => row.method === "Page.downloadWillBegin");
    assert.equal(begins.length, 1); const begin = item.pageBegin = begins[0];
    assert.equal(begin.source.tabId, item.tabId); assert.ok(begin.at >= item.ready.at);
    const ends = events.filter(row => row.method === "Page.downloadProgress" && row.params.state !== "inProgress");
    assert.equal(ends.length, 1); assert.equal(ends[0].params.state, state);
    for (const event of events) assert.deepEqual(event.source, begin.source);
    item.pageEvents = events;
    const notification = await until(() => detail.notifications.owner.find(row => row.id === item.guid && row.status === (state === "completed" ? "complete" : state)), item.label + " original owner terminal notification", 5000);
    for (const key of ["session_id", "turn_id", "control_epoch"]) assert.equal(notification[key], item.scope[key]);
    assert.equal(notification.tabId, item.tabId);
    assert.ok(detail.notifications.foreign.every(row => row.id !== item.guid));
    item.terminalNotification = structuredClone(notification);
    const selected = assertManagedDownloadFrame(item, trace, begin);
    if (selected.attachedFrame) { item.attachedFrame = selected.attachedFrame; item.childFrame = selected.webFrame; }
  };
  const runCase = async (variant, kind, heldMode) => {
    assert.ok(detail.cases.length < 8);
    const source = heldMode ? heldFixture : fixture;
    const record = source.createCase({ kind: heldMode ? "held" : kind, owner: `managed-${witnessID}-${detail.cases.length}`, ...(heldMode ? {} : { variant }) });
    const item = { label: heldMode ?? `${variant}-${kind}`, variant, kind: heldMode ? "held" : kind, record, scope: downloadScope(owner), operationsStart: detail.operations.length, started: stamp() };
    detail.cases.push(item);
    const tab = await operation(item.label + ".newTab", {}, () => owner.newTab(), value => ({ id: value.id })); item.tabId = tab.id;
    await witness("watch", tab.id);
    await operation(item.label + ".navigate", { tabId: tab.id, url: new URL(record.urlPath, fixtureURL).href }, () => owner.cdp.navigate(tab.id, new URL(record.urlPath, fixtureURL).href));
    await tab.locator("#state").textContent({ timeoutMs: 5000 });
    const targets = await worker.evaluate("chrome.debugger.getTargets()");
    const roots = targets.filter(value => value.type === "page" && value.tabId === tab.id); assert.equal(roots.length, 1); item.rootTarget = roots[0];
    const target = variant === "root" ? tab : tab.frameLocator("#download-frame");
    if (variant === "oopif") await target.locator("#state").textContent({ timeoutMs: 5000 });
    item.beforeArm = await snapshot(item);
    const armStarted = performance.now();
    const waiter = await operation(item.label + ".arm", { ...item.scope, tabId: tab.id, requirePath: true, timeoutMs: 15000 }, () => tab.expectDownload({ requirePath: true, timeoutMs: 15000 }), value => ({ waiterId: value.waiterId, remainingMs: value.remainingMs }));
    const entry = { item, waiter, attempted: false }; waiters.push(entry);
    item.waiterId = waiter.waiterId; item.ready = stamp(); item.remainingMs = waiter.remainingMs;
    assert.ok(item.remainingMs > 0 && item.remainingMs <= 15000);
    const deadline = Math.min(armStarted + 15000, performance.now() + item.remainingMs);
    const clickBudget = () => { const left = Math.floor(deadline - performance.now()); assert.ok(left > 0, "Original ready deadline expired before input"); return Math.min(5000, left); };
    if (variant === "dynamic-oopif") {
      assert.equal(item.beforeArm.frames.length, 1);
      await operation(item.label + ".addFrame", { ...item.scope, tabId: tab.id }, () => tab.getByRole("button", { name: "Add download frame", exact: true }).click({ timeoutMs: clickBudget() }));
      await target.locator("#state").textContent({ timeoutMs: clickBudget() });
    }
    item.beforeTrigger = await snapshot(item);
    assert.equal(originalDocument(item.beforeArm, 0).documentId, originalDocument(item.beforeTrigger, 0).documentId);
    item.nativeFrameTree = await owner.cdp.call(tab.id, "Page.getFrameTree", {}, { timeoutMs: clickBudget() });
    const frameTrace = await witness(), selected = selectManagedDownloadFrame(item, frameTrace);
    if (variant !== "root") {
      // Allocate before the original read so a native failure keeps its exact
      // source and partial evidence. This observer never creates an attachment.
      item.childNativeFrame = { ...selected, started: stamp() };
      item.childNativeFrame.nativeFrameTree = await worker.evaluate(`chrome.debugger.sendCommand(${JSON.stringify(selected.source)},"Page.getFrameTree",{})`, clickBudget());
      item.childNativeFrame.completed = stamp();
    }
    assertManagedDownloadFrame(item, frameTrace);
    item.trigger = stamp();
    await operation(item.label + ".click", { ...item.scope, tabId: tab.id }, () => target.getByRole("button", { name: "Download original report", exact: true }).click({ timeoutMs: clickBudget() }));
    const download = await operation(item.label + ".collect", { ...item.scope, tabId: tab.id, waiterId: waiter.waiterId }, () => waiter.result(), value => ({ downloadId: value.downloadId }));
    item.guid = download.downloadId; item.collected = stamp();
    item.foreign = {};
    for (const method of ["downloadPath", "cancelDownload"]) item.foreign[method] = await rejection(item.label + ".foreign." + method, { ...downloadScope(foreign), downloadId: item.guid, timeoutMs: 3000 }, () => foreign.client.request(method, { downloadId: item.guid, timeoutMs: 3000 }), unowned);
    if (heldMode) {
      item.held = await until(() => { const value = source.stats(record.key).requests.find(row => row.method === "POST"); return value?.prefixFlushed && !value.closed && !value.finished ? value : false; }, item.label + " original held HTTP prefix", 5000);
      if (heldMode === "native-cancel") {
        item.cancelAcknowledgement = await operation(item.label + ".cancelDownload", { ...item.scope, downloadId: item.guid, timeoutMs: 5000 }, () => owner.client.request("cancelDownload", { ...item.scope, downloadId: item.guid, timeoutMs: 5000 }));
        assert.deepEqual(item.cancelAcknowledgement, { cancelled: true });
        await terminal(item, "canceled");
        await until(() => source.stats(record.key).requests.find(row => row.method === "POST")?.closed, "native cancel closed original HTTP response", 5000);
        item.pathRejection = await rejection(item.label + ".path", { ...item.scope, downloadId: item.guid }, () => download.path({ timeoutMs: 5000 }), /OBU_NATIVE_DOWNLOAD_CANCELED/);
        assert.equal(source.allStats().controls.filter(row => row.key === record.key).length, 0, "Fixture control must not cause native cancellation");
      } else {
        await cleanupWait(entry);
        item.afterCancelWait = source.stats(record.key);
        const original = item.afterCancelWait.requests.find(row => row.method === "POST"); assert.equal(original.closed, false); assert.equal(original.finished, false);
        item.continueAcknowledgement = await operation(item.label + ".releaseOriginalHTTP", { key: record.key }, () => source.release(record.key));
        assert.equal(item.continueAcknowledgement, true);
      }
    }
    if (heldMode !== "native-cancel") {
      item.productPath = await operation(item.label + ".path", { ...item.scope, downloadId: item.guid, timeoutMs: 10000 }, () => download.path({ timeoutMs: 10000 }));
      item.file = await readOriginalDownloadProof(downloadRoot, item.productPath, record.expected); detail.files.push(item.file);
      await terminal(item, "completed");
    }
    item.after = await snapshot(item);
    item.page = JSON.parse(await target.locator("#state").textContent({ timeoutMs: 5000 }));
    const rootBefore = originalDocument(item.beforeTrigger, 0), rootAfter = originalDocument(item.after, 0);
    assert.equal(rootAfter.documentId, rootBefore.documentId); assert.equal(rootAfter.result.state.documentToken, rootBefore.result.state.documentToken);
    for (const before of item.beforeTrigger.documents) {
      const after = originalDocument(item.after, before.frameId); assert.equal(after.documentId, before.documentId); assert.equal(after.result.state.documentToken, before.result.state.documentToken);
    }
    if (variant === "dynamic-oopif") assert.deepEqual(rootAfter.result.state.frameAdds, [{ trusted: true }]);
    item.server = source.stats(record.key); assertManagedDownloadTransfer(item, { held: !!heldMode, cancelled: heldMode === "native-cancel" });
    assert.deepEqual(downloadScope(owner), item.scope);
    if (!entry.attempted) await cleanupWait(entry);
    item.operationsEnd = detail.operations.length; item.passed = true; item.ended = stamp();
  };
  try {
    await owner.client.getTabs(); await foreign.client.getTabs();
    detail.scope = downloadScope(owner); detail.foreignScope = downloadScope(foreign); assert.notEqual(detail.scope.session_id, detail.foreignScope.session_id);
    detail.infoBefore = await owner.client.getInfo();
    assert.equal(detail.infoBefore.metadata.downloadWaitPathVersion, 1); assert.equal(detail.infoBefore.metadata.pageDownloads.available, true);
    detail.generation = detail.infoBefore.metadata.pageDownloads.generation; assert.ok(detail.generation);
    for (const [name, browser] of [["owner", owner], ["foreign", foreign]]) unsubscribe.push(browser.client.onNotification(event => {
      if (event.method !== "onDownloadChange") return;
      if (detail.notifications[name].length >= 512) { detail.notificationOverflow = true; return; }
      detail.notifications[name].push(structuredClone(event.params));
    }));
    installed = true; // Attempt exact cleanup even if installation's original reply is lost.
    detail.witnessStart = await worker.evaluate(`(${installManagedDownloadWitness.toString()})(chrome,globalThis,${JSON.stringify(witnessID)})`);
    for (const variant of ["root", "oopif", "dynamic-oopif"]) for (const kind of ["post", "blob"]) await runCase(variant, kind);
    await runCase("root", "held", "native-cancel");
    await runCase("root", "held", "wait-cancel-only");
    assert.equal(detail.cases.length, 8); assert.equal(detail.files.length, 7);
    assert.equal(new Set(detail.cases.map(item => item.guid)).size, 8); assert.equal(new Set(detail.files.map(item => item.path)).size, 7);
    assert.equal(detail.notificationOverflow ?? false, false);
    const byGUID = new Map(detail.cases.map(item => [item.guid, item]));
    for (const notification of detail.notifications.owner) {
      const item = byGUID.get(notification.id); assert.ok(item, "Owner received an unrelated GUID");
      assert.equal(notification.tabId, item.tabId);
      for (const key of ["session_id", "turn_id", "control_epoch"]) assert.equal(notification[key], item.scope[key]);
    }
    assert.equal(detail.notifications.foreign.length, 0);
    detail.server = fixture.allStats(); detail.heldServer = heldFixture.allStats();
    assertManagedDownloadJournal(detail.server, detail.cases.slice(0, 6), { requests: 13, gets: 10, posts: 3 });
    assertManagedDownloadJournal(detail.heldServer, detail.cases.slice(6), { requests: 4, gets: 2, posts: 2 });
    detail.infoAfter = await owner.client.getInfo();
    assert.equal(detail.infoAfter.metadata.pageDownloads.available, true); assert.equal(detail.infoAfter.metadata.pageDownloads.generation, detail.generation);
    for (const key of ["extensionId", "extensionInstanceId", "nativeHostName"]) assert.equal(detail.infoAfter.metadata[key], detail.infoBefore.metadata[key]);
    detail.passed = true;
  } catch (error) { primary = error; detail.error = describe(error); }
  finally {
    for (const entry of waiters.filter(value => !value.attempted)) {
      try { await cleanupWait(entry); detail.cleanup.push({ kind: "wait", waiterId: entry.waiter.waiterId, ok: true }); }
      catch (error) { detail.cleanupErrors.push({ kind: "wait", waiterId: entry.waiter.waiterId, error: describe(error) }); primary ??= error; }
    }
    for (const stop of unsubscribe) { try { stop(); } catch (error) { detail.cleanupErrors.push({ kind: "notification", error: describe(error) }); primary ??= error; } }
    if (installed) {
      try { detail.witnessFinal = await witness("stop"); assert.equal(detail.witnessFinal.stopped, true); detail.cleanup.push({ kind: "passive-witness", ok: true }); }
      catch (error) { detail.cleanupErrors.push({ kind: "passive-witness", error: describe(error) }); primary ??= error; }
    }
    // Do not release or close held fixture responses here: runner teardown must
    // remain distinguishable from the original Browser.cancelDownload outcome.
    detail.serverBeforeRunnerCleanup = fixture.allStats(); detail.heldServerBeforeRunnerCleanup = heldFixture.allStats();
    detail.ended = stamp(); if (primary) detail.passed = false;
  }
  if (primary) { primary.managedDownloadDetail = detail; throw primary; }
  return detail;
}
