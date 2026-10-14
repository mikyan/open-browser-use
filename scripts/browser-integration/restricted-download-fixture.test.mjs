import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import test from "node:test";
import { createOriginalDownloadFixtures } from "./original-download-fixture.mjs";
import { negativeNativeDownload } from "./original-download-negative-cases.mjs";
import { checkRestrictedDownloadCaller, checkRestrictedDownloadEvidence, checkRestrictedDownloadBoundaryEvidence, checkHTTPDownloadOutcomes, collectRejectedDownloadSource, installRestrictedDownloadEvidence, originalDownloadContext } from "./restricted-download-fixture.mjs";
import { BrowserDownloadWaits } from "../../apps/chrome-extension/browser-download-waits.js";

const hash = bytes => createHash("sha256").update(bytes).digest("hex"), scope = { session_id: "original-owner", turn_id: "original-turn", control_epoch: 9 };
function evidence() {
  const key = "original-key", owner = "original-owner", href = `http://127.0.0.1:49152/original-download/page?key=${key}`, blobURL = "blob:http://127.0.0.1:49152/original-object";
  const analysis = { key, owner, kind: "blob", nonce: "original-report-nonce" }, bytes = Buffer.concat([Buffer.from(JSON.stringify(analysis) + "\n原始报表\n"), Buffer.from([0, 255, 128])]), expected = { bytes: bytes.length, sha256: hash(bytes), base64: bytes.toString("base64") };
  const clicks = [{ trusted: true, buttonCount: 1, documentToken: "original-document", blobURL, revoked: true }], state = { key, owner, kind: "blob", documentToken: "original-document", frameAdds: [], clicks, blobURL };
  const before = { href, state: { ...structuredClone(state), clicks: [] }, button: { id: "download", connected: true, formConnected: true } }, after = { ...structuredClone(before), state };
  const productPath = path.resolve(".tmp", "restricted-download-test", "report.bin"), downloadId = "original-native-guid";
  const messages = [{ method: "Browser.downloadWillBegin", params: { guid: downloadId, frameId: "original-root-target", url: blobURL, suggestedFilename: "report.bin" } }, { method: "Browser.downloadProgress", params: { guid: downloadId, state: "completed", filePath: productPath, totalBytes: bytes.length, receivedBytes: bytes.length } }];
  const relay = { overflow: false, captureComplete: true, acceptedConnections: 1, upstreamAttempts: 1, reconnects: 0, records: messages.map((json, index) => { const text = JSON.stringify(json), raw = Buffer.from(text); return { sequence: index, direction: "upstream->downstream", binary: false, bytes: raw.length, sha256: hash(raw), bodyBase64: raw.toString("base64"), text, json, forwarded: { at: 4 + index } }; }) };
  const item = { key, variant: "root", tabId: 42, scope: { ...scope }, ready: { scope: { ...scope }, tabId: 42, waiterId: "original-waiter" }, readyObservedAt: 2,
    before: { documents: [{ frameId: 0, documentId: "native-document", result: before }] }, after: { documents: [{ frameId: 0, documentId: "native-document", result: after }], targets: [{ id: "original-root-target", tabId: 42, type: "page" }] },
    callerResult: { key, kind: "blob", variant: "root", tabId: 42, scope: { ...scope }, ok: true, waitCleanup: { ok: true }, waiterId: "original-waiter", remainingMs: 14990, readyAt: 1, triggerAt: 3, collectedAt: 5, downloadId, productPath },
    nativeEvidence: { overflow: false, removed: true, restored: true, rows: [{ at: 4, source: { tabId: 42 }, method: "Page.downloadWillBegin", params: messages[0].params }] }, relay, browserDownload: negativeNativeDownload(relay, downloadId, "completed"), file: { path: productPath, ...expected, analysis }, notifications: [{ id: downloadId, status: "complete", tabId: 42, ...scope }] };
  item.nativeEvidence.rows.unshift({ at: 0, source: { tabId: 42 }, method: "Runtime.executionContextCreated", params: { context: { id: 1, uniqueId: "original-context", origin: new URL(href).origin, auxData: { isDefault: true, frameId: "original-root-target" } } } });
  item.nativeEvidence.commands = [{ kind: "native-fulfilled", at: 1, result: { frameTree: { frame: { id: "original-root-target", url: href, loaderId: "original-loader", securityOrigin: new URL(href).origin } } } }];
  item.nativeEvidence.wire = ["claim", "path"].flatMap(operation => [{ kind: "native-request", message: { params: { operation, requestId: operation, nonce: "native-nonce", generation: "native-generation", payload: { ...scope, tabId: 42, guid: downloadId, frameId: "original-root-target", rootTargetId: "original-root-target" } } } }, { kind: "native-reply", message: { params: { requestId: operation, nonce: "native-nonce", generation: "native-generation", result: operation === "claim" ? {} : { path: productPath } } } }]);
  const record = { key, owner, nonce: analysis.nonce, kind: "blob", variant: "root", expected, urlPath: `/original-download/page?key=${key}`, requests: [{ method: "GET", url: `/original-download/page?key=${key}`, status: 200, finished: true }] };
  return { item, record };
}

test("restricted Blob proof joins original trusted button and revoked URL to native GUID and product file bytes", () => {
  const { item, record } = evidence(); assert.deepEqual(checkRestrictedDownloadEvidence(item, record), { guid: "original-native-guid", documentId: "native-document", bytes: record.expected.bytes, sha256: record.expected.sha256, files: 1, trustedClicks: 1, revokedBlob: true, reportRequests: 0 });
});

test("wrong document/GUID/path, replayed click, refetch, broken relay provenance or leaked owner cannot pass", () => {
  for (const mutate of [x => x.item.after.documents[0].documentId = "new-document", x => x.item.after.documents[0].result.state.clicks.push(x.item.after.documents[0].result.state.clicks[0]), x => x.item.after.documents[0].result.state.clicks[0].trusted = false,
    x => x.item.after.documents[0].result.state.clicks[0].revoked = false, x => x.item.callerResult.scope.control_epoch++, x => x.item.callerResult.downloadId = "foreign-guid", x => x.item.callerResult.productPath += "-other", x => x.item.file.sha256 = "wrong-file",
    x => x.item.nativeEvidence.rows.find(row => row.method === "Page.downloadWillBegin").params.frameId = "foreign-frame", x => x.item.nativeEvidence.rows.find(row => row.method === "Page.downloadWillBegin").source.tabId++, x => x.item.relay.records[0].bodyBase64 = "AA==", x => x.item.relay.captureComplete = false,
    x => x.item.notifications[0].session_id = "foreign", x => x.record.requests.push({ method: "GET", url: "/report", status: 200, finished: true }), x => x.record.requests.push({ method: "POST", url: "/report", status: 200, finished: true }),
    x => x.item.readyObservedAt = 4, x => x.item.callerResult.waitCleanup.ok = false, x => x.item.nativeEvidence.commands[0].at = 3,
    x => x.item.nativeEvidence.commands[0].result.frameTree.frame.securityOrigin = "null", x => x.item.nativeEvidence.wire[0].message.params.payload.frameId = "successor",
    x => x.item.nativeEvidence.wire[3].message.params.result.path += "-wrong", x => x.item.nativeEvidence.wire[1].message.params.generation = "new-binding"]) { const original = evidence(); mutate(original); assert.throws(() => checkRestrictedDownloadEvidence(original.item, original.record)); }
});

test("passive Page observer preserves real frame/session identity, event order and listener removal", () => {
  const listeners = new Set(), target = {}, api = { debugger: { onEvent: { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn), hasListener: fn => listeners.has(fn) } } };
  installRestrictedDownloadEvidence(api, target, 42); const listener = [...listeners][0], source = { tabId: 42, sessionId: "child-session" }, params = { guid: "original", frameId: "child-target" };
  listener({ tabId: 99 }, "Page.downloadWillBegin", params); listener(source, "Network.requestWillBeSent", {}); listener(source, "Page.downloadWillBegin", params); params.frameId = "changed"; listener(source, "Page.downloadProgress", { guid: "original", state: "completed" });
  const context = { id: 1, uniqueId: "original-context", origin: "://", auxData: { isDefault: true, frameId: "child-target" } };
  listener(source, "Runtime.executionContextCreated", { context }); context.origin = "changed";
  listener(source, "Runtime.executionContextDestroyed", { executionContextId: 1, executionContextUniqueId: "original-context" }); listener(source, "Runtime.executionContextsCleared", {});
  const value = target.__restrictedDownloadEvidence.stop(); assert.deepEqual(value.rows.map(row => [row.sequence, row.method]), [[1, "Page.downloadWillBegin"], [2, "Page.downloadProgress"], [3, "Runtime.executionContextCreated"], [4, "Runtime.executionContextDestroyed"], [5, "Runtime.executionContextsCleared"]]); assert.deepEqual(value.rows[0].source, source); assert.equal(value.rows[0].params.frameId, "child-target"); assert.equal(value.rows[2].params.context.origin, "://"); assert.equal(value.restored, true); assert.equal(value.removed, true); assert.equal(listeners.size, 0);
});

test("old-source arm rejection preserves native/page/server evidence and cannot trigger or fabricate a path", async () => {
  const failure = Error("OBU_SITE_ACCESS_UNSUPPORTED: old production"), detail = {}, operations = [], { item } = evidence(), fixture = createOriginalDownloadFixtures(); let unsubscribed = false;
  const browser = { client: { sessionId: scope.session_id, turnId: scope.turn_id, controlEpoch: scope.control_epoch, onNotification: () => () => { unsubscribed = true; } }, async newTab() { return { id: 42, async goto() { operations.push("goto"); }, async expectDownload(options) { operations.push(options); throw failure; }, getByRole() { throw Error("Unexpected input"); } }; } };
  const worker = { async evaluate(source) { if (source.includes("installRestrictedDownloadEvidence")) return; if (source.includes(".stop()")) return { rows: [], overflow: false, restored: true, removed: true }; if (source.startsWith("(async()=>({observer:")) return item.before; throw Error("Unexpected observer operation"); } };
  await assert.rejects(checkRestrictedDownloadCaller({ kind: "js", browser, getWorker: () => worker, fixture, fixtureURL: "http://127.0.0.1:49152/", downloadRoot: path.resolve(".tmp"), relay: { snapshot: () => ({ records: [] }) }, until: async fn => { const value = await fn(); assert.ok(value); return value; }, detail }), error => error === failure);
  assert.deepEqual(operations, ["goto", { timeoutMs: 15000, requirePath: true }]); assert.equal(unsubscribed, true); assert.equal(detail.variants.length, 1); assert.deepEqual(detail.variants[0].nativeEvidence.rows, []); assert.equal(detail.variants[0].file, undefined); assert.equal(detail.variants[0].callerResult.productPath, undefined); assert.deepEqual(detail.variants[0].server.requests, []);
});

function boundary(name = "admitted-navigation") {
  const { item, record } = evidence(); Object.assign(item, { name, server: record, rejections: [], kind: "blob", downloadId: item.callerResult.downloadId, productPath: item.callerResult.productPath, readyAt: 1 });
  Object.assign(item.nativeEvidence, { commands: [], wire: [], pending: 0, sourceHeld: false, replyHeld: false, watchdog: false });
  if (name === "admitted-navigation" || name === "source-ack-navigation") {
    item.beforeNavigation = structuredClone(item.after); item.after.documents[0].documentId = "new-native-document"; item.after.documents[0].result.state.documentToken = "new-document"; item.after.documents[0].result.state.clicks = []; record.requests.push(structuredClone(record.requests[0])); item.before.targets = structuredClone(item.after.targets);
    item.pathAfterNavigation = item.productPath;
  } else item.before.targets = structuredClone(item.after.targets);
  if (name === "source-ack-navigation") {
    delete item.downloadId; delete item.productPath; item.notifications = []; item.cancelled = true; item.navigationCompletedAt = 20;
    item.rejections = [{ name: "replaced-source-collect", authority: "retired", ok: false, error: "OBU_SITE_ACCESS_UNVERIFIED: original source changed" }];
    item.nativeEvidence.commands = [{ sequence: 2, at: 5, id: 1, kind: "native-fulfilled", result: { frameTree: { frame: { id: "original-root-target", url: item.before.documents[0].result.href, loaderId: "old-loader" } } } }, { sequence: 3, at: 6, id: 1, kind: "source-delivery-held" }, { sequence: 5, at: 21, kind: "source-delivery-release" }];
    item.nativeEvidence.rows.push({ sequence: 4, at: 19, method: "Page.frameNavigated", source: { tabId: 42 }, params: { frame: { id: "original-root-target", loaderId: "new-loader" } } });
  }
  return item;
}

test("admitted original artifact remains the same file across allowed navigation, candidate ACK cannot authorize a replacement document", () => {
  assert.deepEqual(checkRestrictedDownloadBoundaryEvidence(boundary()), { downloads: 1, posts: 0, bytes: boundary().file.bytes, delivered: 1 });
  assert.equal(checkRestrictedDownloadBoundaryEvidence(boundary("source-ack-navigation")).delivered, 0);
  for (const mutate of [item => item.pathAfterNavigation += "-new", item => item.after.documents[0].documentId = item.before.documents[0].documentId]) { const item = boundary(); mutate(item); assert.throws(() => checkRestrictedDownloadBoundaryEvidence(item)); }
  for (const mutate of [item => item.rejections[0].error = "OBU_DOWNLOAD_WAIT_TIMEOUT", item => item.rejections[0].error = "OBU_DOWNLOAD_WAIT_FAILED", item => item.rejections[0].ok = true,
    item => item.nativeEvidence.commands[2].at = 19, item => item.nativeEvidence.commands.shift(), item => item.nativeEvidence.rows.find(row => row.method === "Page.frameNavigated").params.frame.loaderId = "old-loader",
    item => item.nativeEvidence.wire.push({ kind: "native-request", message: { params: { operation: "claim" } } }), item => item.beforeNavigation.documents[0].result.state.clicks[0].trusted = false,
    item => item.notifications.push({ id: "leaked" }), item => item.server.requests.push(structuredClone(item.server.requests[0]))]) { const item = boundary("source-ack-navigation"); mutate(item); assert.throws(() => checkRestrictedDownloadBoundaryEvidence(item)); }
});

function lateBoundary() {
  const item = boundary("late-release-policy"), message = { jsonrpc: "2.0", method: "obu.native.pageDownloads", params: { version: 1, type: "reply", requestId: "original-release", nonce: "original-native-nonce", generation: "original-native-generation", result: {} } };
  const policy = { generation: "policy", revision: 9, mode: "allow", origins: ["http://127.0.0.1:49152"] }, durable = { OPEN_BROWSER_USE_SITE_ACCESS_POLICY: { version: 1, revision: 9, mode: policy.mode, origins: policy.origins } };
  Object.assign(item, { failedApply: { ok: false, error: "Timed out waiting for restricted dialog policy saved" }, cleanupTimeoutMs: 10000, applyStartedAt: 10, pauseFailedAt: 15010,
    blocked: { state: "error", inputBlocked: true, cleanupComplete: false, error: "OBU_AUTOMATION_PAUSE_FAILED: OBU_AUTOMATION_CLEANUP_TIMEOUT" }, heldAfterFailed: { replyHeld: true, watchdog: false },
    policyBeforeHold: policy, policyAfterFailed: structuredClone(policy), durableBeforeHold: durable, durableAfterFailed: structuredClone(durable), operationsAfterRelease: { operations: 0, resources: 0 },
    policyChanged: { policy: { ...policy, revision: 10 } }, resume: { state: "running" }, newScope: { ...scope, turn_id: "explicit-new-turn", control_epoch: 11 } });
  item.nativeEvidence.wire = [{ kind: "native-request", at: 11, message: { params: { type: "request", operation: "release", requestId: message.params.requestId, nonce: message.params.nonce, generation: message.params.generation, payload: { guid: item.downloadId } } } },
    { kind: "native-reply", at: 12, message: structuredClone(message) }, { kind: "reply-delivery-held", at: 13, message: structuredClone(message) }, { kind: "reply-delivery-release", at: 15011, message: structuredClone(message) }];
  return item;
}

test("late release proof requires real cleanup timeout, unchanged durable policy, original ACK then explicit recovery", () => {
  assert.equal(checkRestrictedDownloadBoundaryEvidence(lateBoundary()).delivered, 1);
  for (const mutate of [item => item.failedApply.ok = true, item => item.blocked.error = "unknown failure", item => item.blocked.cleanupComplete = true, item => item.pauseFailedAt = 20,
    item => item.heldAfterFailed.replyHeld = false, item => item.heldAfterFailed.watchdog = true, item => item.policyAfterFailed.revision++, item => item.durableAfterFailed.OPEN_BROWSER_USE_SITE_ACCESS_POLICY.revision++,
    item => item.nativeEvidence.wire[3].at = 20, item => item.nativeEvidence.wire[3].message.params.generation = "successor", item => item.operationsAfterRelease.resources = 1,
    item => item.newScope.control_epoch = scope.control_epoch, item => item.newScope.turn_id = scope.turn_id, item => item.newScope.session_id = "other-owner"])
    { const item = lateBoundary(); mutate(item); assert.throws(() => checkRestrictedDownloadBoundaryEvidence(item)); }
});

test("native source gate returns original Promise except selected actual ACK and releases without replay", async () => {
  const calls = [], listeners = new Set(), target = {}, original = Promise.resolve({ frameTree: { frame: { id: "frame", loaderId: "original" } } });
  const send = function (...args) { calls.push({ receiver: this, args }); return original; }, api = { debugger: { sendCommand: send, onEvent: { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn), hasListener: fn => listeners.has(fn) } } };
  installRestrictedDownloadEvidence(api, target, 42); assert.equal(api.debugger.sendCommand({ tabId: 99 }, "Page.getFrameTree", {}), original); assert.equal(api.debugger.sendCommand({ tabId: 42 }, "Page.enable", {}), original); await original; await Promise.resolve();
  target.__restrictedDownloadEvidence.holdNextSource(); let delivered = false; const pending = api.debugger.sendCommand({ tabId: 42 }, "Page.getFrameTree", {}).then(value => { delivered = true; return value; }); await original; await Promise.resolve(); await Promise.resolve();
  assert.equal(delivered, false); assert.equal(target.__restrictedDownloadEvidence.snapshot().sourceHeld, true); assert.throws(() => target.__restrictedDownloadEvidence.stop(), /pending/);
  target.__restrictedDownloadEvidence.release(); assert.deepEqual(await pending, await original); const proof = target.__restrictedDownloadEvidence.stop(); assert.equal(proof.restored, true); assert.equal(calls.length, 3); assert.ok(calls.every(call => call.receiver === api.debugger));
  assert.deepEqual(proof.commands.filter(row => row.kind.includes("delivery")).map(row => row.kind), ["source-delivery-held", "source-delivery-release"]);
});

test("private release gate matches original operation/request/nonce/generation and delivers original real reply exactly once", () => {
  const received = [], listeners = new Set(), pass = [], target = { __integrationNativeRPCObserver: (...args) => pass.push(args) }, previous = target.__integrationNativeRPCObserver;
  const client = { receive(message) { received.push({ receiver: this, message }); return true; } }, originalReceive = client.receive, api = { debugger: { onEvent: { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn), hasListener: fn => listeners.has(fn) } } };
  installRestrictedDownloadEvidence(api, target, 42, { nativePageDownloads: () => client }); target.__restrictedDownloadEvidence.holdRelease("original-guid");
  const request = { jsonrpc: "2.0", method: "obu.native.pageDownloads", params: { version: 1, type: "request", requestId: "release-id", nonce: "nonce", generation: "generation", operation: "release", payload: { tabId: 42, guid: "original-guid" } } };
  target.__integrationNativeRPCObserver("response", { ...request, params: { ...request.params, requestId: "path-id", operation: "path" } });
  target.__integrationNativeRPCObserver("response", request);
  const reply = { jsonrpc: "2.0", method: request.method, params: { version: 1, type: "reply", requestId: "release-id", nonce: "nonce", generation: "generation", result: {} } };
  for (const changed of [{ requestId: "path-id" }, { nonce: "foreign" }, { generation: "successor" }]) assert.equal(client.receive({ ...reply, params: { ...reply.params, ...changed } }), true);
  target.__integrationNativeRPCObserver("request", reply); assert.equal(client.receive(reply), true); assert.equal(received.length, 3); assert.equal(target.__restrictedDownloadEvidence.snapshot().replyHeld, true); assert.throws(() => target.__restrictedDownloadEvidence.stop(), /pending/);
  target.__restrictedDownloadEvidence.release(); target.__restrictedDownloadEvidence.release(); assert.equal(received.length, 4); assert.equal(received.at(-1).message, reply); assert.ok(received.every(row => row.receiver === client));
  const proof = target.__restrictedDownloadEvidence.stop(); assert.equal(client.receive, originalReceive); assert.equal(target.__integrationNativeRPCObserver, previous); assert.equal(proof.restored, true); assert.equal(proof.watchdog, false); assert.equal(pass.length, 3);
  assert.deepEqual(proof.wire.map(row => row.kind), ["native-request", "native-request", "native-reply", "reply-delivery-held", "reply-delivery-release"]);
});

test("pending original collection preserves the source rejection when the registry retires during its one click", async () => {
  const original = Error("OBU_SITE_ACCESS_UNVERIFIED: original opaque Blob"), pending = [], calls = [];
  const registry = new BrowserDownloadWaits({ send: async () => {}, assertScope() {}, validateScope() {}, sourceAlive: () => true, publish() {}, discard() {} });
  const params = { ...scope, tabId: 42, timeoutMs: 15000 }, record = registry.reserve(params); registry.bind(record, params); const ack = await registry.arm(record, [undefined]);
  const handle = { ...scope, tabId: 42, waiterId: ack.waiterId };
  await collectRejectedDownloadSource({ pending, wait: { result() { calls.push("collect"); return registry.collect(handle); } }, async click() { calls.push("click"); registry.fail(record, original); await Promise.resolve(); }, async reject(name, promise, authority) { assert.equal(name, "unproven-source-collect"); assert.equal(authority, "source"); await assert.rejects(promise, error => error.message === original.message); calls.push("original-rejection"); } });
  assert.deepEqual(calls, ["collect", "click", "original-rejection"]); assert.deepEqual(await Promise.all(pending), [{ ok: false, error: original.message }]); assert.equal(registry.records.size, 0);
  assert.throws(() => registry.collect(handle), /OBU_DOWNLOAD_WAIT_EXPIRED/, "A new late lookup cannot retrieve the original rejection");
});

test("HTTP's precise revoked-click result and original collection denial are both retained independently", async () => {
  const clickFailure = Error("OBU_SITE_ACCESS_DENIED: document access was revoked during the browser action"), collectionFailure = Error("OBU_SITE_ACCESS_UNVERIFIED: HTTP source provenance unavailable"), evidence = {}, pending = [], calls = [];
  const registry = new BrowserDownloadWaits({ send: async () => {}, assertScope() {}, validateScope() {}, sourceAlive: () => true, publish() {}, discard() {} });
  const params = { ...scope, tabId: 42, timeoutMs: 15000 }, record = registry.reserve(params); registry.bind(record, params); const ack = await registry.arm(record, [undefined]);
  await collectRejectedDownloadSource({ evidence, pending, allowRevokedHTTPClick: true, wait: { result() { calls.push("collect"); return registry.collect({ ...scope, tabId: 42, waiterId: ack.waiterId }); } },
    async click() { calls.push("click"); registry.fail(record, collectionFailure); throw clickFailure; },
    async reject(name, promise, authority) { calls.push("check-original-collect"); assert.equal(authority, "source"); await assert.rejects(promise, error => error.message === collectionFailure.message); } });
  assert.deepEqual(calls, ["collect", "click", "check-original-collect"]); assert.deepEqual(evidence, { collectionOutcome: { ok: false, error: collectionFailure.message }, clickOutcome: { ok: false, error: clickFailure.message } });
  assert.equal(registry.records.size, 0); assert.deepEqual(await Promise.all(pending), [{ ok: false, error: collectionFailure.message }]);
  for (const wrong of ["OBU_DOWNLOAD_WAIT_TIMEOUT", "OBU_DOWNLOAD_WAIT_EXPIRED"]) {
    const detail = {}, observed = [], failure = Error("Collection must independently prove source rejection");
    await assert.rejects(collectRejectedDownloadSource({ evidence: detail, pending: observed, allowRevokedHTTPClick: true, wait: { result: () => Promise.reject(Error(wrong)) },
      click: async () => { throw clickFailure; }, reject: async (_name, promise) => { await assert.rejects(promise, error => error.message === wrong); throw failure; } }), error => error === failure);
    assert.equal(detail.clickOutcome.error, clickFailure.message); assert.equal(detail.collectionOutcome.error, wrong); assert.equal(observed.length, 1);
  }
});

test("unknown clicks and the HTTP-specific error in other cases remain the first failure while the original collect outcome is saved", async () => {
  for (const [message, allowRevokedHTTPClick] of [["Unknown native click failure", true], ["OBU_SITE_ACCESS_DENIED: unrelated click denial", true], ["OBU_SITE_ACCESS_DENIED: document access was revoked during the browser action", false]]) {
    const clickFailure = Error(message), collectionFailure = Error("OBU_SITE_ACCESS_DENIED: original collection denied"), evidence = {}, pending = [], calls = []; let rejectCollection;
    const original = new Promise((_resolve, reject) => { rejectCollection = reject; });
    await assert.rejects(collectRejectedDownloadSource({ evidence, pending, allowRevokedHTTPClick, wait: { result() { calls.push("collect"); return original; } },
      async click() { calls.push("click"); queueMicrotask(() => rejectCollection(collectionFailure)); throw clickFailure; }, reject() { throw Error("Unexpected permission to continue after this click failure"); } }), error => error === clickFailure);
    assert.deepEqual(calls, ["collect", "click"]); assert.deepEqual(evidence, { clickOutcome: { ok: false, error: message }, collectionOutcome: { ok: false, error: collectionFailure.message } });
    assert.deepEqual(await Promise.all(pending), [{ ok: false, error: collectionFailure.message }]);
  }
});

test("HTTP collection requires a source error as the original first classification, independently of its click outcome", () => {
  const original = error => ({ clickOutcome: { ok: false, error: "OBU_SITE_ACCESS_DENIED: document access was revoked during the browser action" },
    collectionOutcome: { ok: false, error }, rejections: [{ name: "unproven-source-collect", authority: "source", ok: false, error }] });
  for (const error of ["OBU_SITE_ACCESS_DENIED: document access was revoked", "OBU_SITE_ACCESS_UNVERIFIED: HTTP source unavailable"]) {
    checkHTTPDownloadOutcomes(original(error)); const completedClick = original(error); completedClick.clickOutcome = { ok: true }; checkHTTPDownloadOutcomes(completedClick);
  }
  for (const error of ["OBU_DOWNLOAD_WAIT_TIMEOUT: OBU_SITE_ACCESS_DENIED: too late", "OBU_DOWNLOAD_WAIT_EXPIRED: OBU_SITE_ACCESS_UNVERIFIED: retired", "OBU_DOWNLOAD_WAIT_TIMEOUT", "OBU_DOWNLOAD_WAIT_EXPIRED"])
    assert.throws(() => checkHTTPDownloadOutcomes(original(error)));
  for (const mutate of [item => item.clickOutcome.error = "OBU_SITE_ACCESS_DENIED: unrelated click error", item => item.collectionOutcome.ok = true,
    item => item.collectionOutcome.value = "unexpected-guid", item => item.rejections[0].error = "OBU_SITE_ACCESS_UNVERIFIED: different result"])
    { const item = original("OBU_SITE_ACCESS_DENIED: document access was revoked"); mutate(item); assert.throws(() => checkHTTPDownloadOutcomes(item)); }
});

function opaqueBoundary() {
  const item = boundary("opaque-source"), rootHref = item.before.documents[0].result.href, childHref = rootHref.replace("127.0.0.1", "localhost").replace("/page?", "/frame?"), blobURL = "blob:null/original-opaque-object";
  item.variant = "oopif"; item.server.variant = "oopif"; item.server.opaque = true; item.cancelled = true; delete item.downloadId; delete item.productPath; item.notifications = [];
  item.rejections = [{ name: "unproven-source-collect", authority: "source", ok: false, error: "OBU_SITE_ACCESS_UNVERIFIED: opaque source" }];
  const childBefore = structuredClone(item.before.documents[0]), childAfter = structuredClone(item.after.documents[0]);
  for (const child of [childBefore, childAfter]) { child.frameId = 5; child.documentId = "original-child-document"; child.result.href = childHref; child.result.origin = "null"; }
  childAfter.result.state.blobURL = blobURL; childAfter.result.state.clicks[0].blobURL = blobURL;
  for (const snapshot of [item.before, item.after]) {
    const root = snapshot.documents[0]; root.result.button = null; root.result.state.clicks = []; root.result.state.documentToken = "original-root-document"; root.result.childFrame = { id: "download-frame", connected: true, sandbox: "allow-scripts allow-downloads", src: childHref };
    snapshot.documents.push(snapshot === item.before ? childBefore : childAfter);
    snapshot.frames = [{ frameId: 0, documentId: "native-document", url: rootHref, processId: 100, documentLifecycle: "active", errorOccurred: false }, { frameId: 5, documentId: "original-child-document", parentFrameId: 0, parentDocumentId: "native-document", url: childHref, processId: 200, documentLifecycle: "active", errorOccurred: false }];
    snapshot.targets = [{ id: "original-root-target", tabId: 42, type: "page", url: rootHref, attached: true }, { id: "original-child-target", type: "other", url: childHref, attached: true }];
    snapshot.oopifs = [{ tabId: 42, source: { tabId: 42 }, type: "iframe", targetId: "original-child-target", sessionId: "original-child-session" }];
  }
  const frame = { id: "original-child-target", loaderId: "original-child-loader", url: childHref, securityOrigin: new URL(childHref).origin };
  item.nativeEvidence.commands = [{ kind: "native-fulfilled", at: 0, result: { frameTree: { frame: { ...frame, loaderId: "temporary-loader", url: "", securityOrigin: "://" } } } }, { kind: "native-fulfilled", at: 1, result: { frameTree: { frame: { ...frame } } } }, { kind: "native-fulfilled", at: 5, result: { frameTree: { frame: { ...frame } } } }];
  const begin = item.nativeEvidence.rows.find(row => row.method === "Page.downloadWillBegin"); begin.source.sessionId = "original-child-session"; begin.params.frameId = frame.id; begin.params.url = blobURL;
  const context = item.nativeEvidence.rows.find(row => row.method === "Runtime.executionContextCreated"); context.source = { ...begin.source }; context.params.context.origin = "://"; context.params.context.auxData.frameId = frame.id;
  item.nativeEvidence.rows.unshift({ at: 0, source: { tabId: 42, sessionId: "original-child-session" }, method: "Page.frameNavigated", params: { frame: { ...frame } } });
  const relayBegin = item.relay.records[0]; relayBegin.json.params.frameId = frame.id; relayBegin.json.params.url = blobURL;
  relayBegin.text = JSON.stringify(relayBegin.json); const raw = Buffer.from(relayBegin.text); relayBegin.bodyBase64 = raw.toString("base64"); relayBegin.bytes = raw.length; relayBegin.sha256 = hash(raw);
  item.browserDownload = negativeNativeDownload(item.relay, begin.params.guid, "completed"); item.server.requests.push({ method: "GET", url: `/original-download/frame?key=${item.key}`, status: 200, finished: true }); return item;
}

test("opaque proof uses the original MAIN-world origin and sandbox; initial empty native origin cannot stand in for the committed frame", () => {
  const original = opaqueBoundary(); assert.equal(checkRestrictedDownloadBoundaryEvidence(original).delivered, 0); assert.equal(original.opaqueSource.origin, "null"); assert.equal(original.opaqueSource.nativeSecurityOrigin, "http://localhost:49152");
  for (const mutate of [item => item.before.documents[1].result.origin = "http://localhost:49152", item => item.after.documents[1].result.origin = "http://localhost:49152",
    item => item.after.documents[0].result.childFrame.sandbox += " allow-same-origin", item => item.nativeEvidence.commands = [item.nativeEvidence.commands[0]],
    item => item.nativeEvidence.commands[1].result.frameTree.frame.url = "", item => item.nativeEvidence.commands[2].result.frameTree.frame.loaderId = "successor",
    item => item.nativeEvidence.rows[0].params.frame.loaderId = "temporary-loader", item => item.rejections[0].error = "OBU_DOWNLOAD_WAIT_EXPIRED"])
    { const item = opaqueBoundary(); mutate(item); assert.throws(() => checkRestrictedDownloadBoundaryEvidence(item)); }
});

test("native default context proof preserves the original frame, route and lifetime independently of URL-derived frame origins", () => {
  const { item } = evidence(), native = item.nativeEvidence, begin = native.rows.find(row => row.method === "Page.downloadWillBegin");
  assert.equal(originalDownloadContext(native, begin).context.uniqueId, "original-context");
  for (const mutate of [value => value.rows[0].source.sessionId = "foreign-session", value => value.rows[0].params.context.uniqueId = "",
    value => value.rows[0].params.context.auxData.isDefault = false, value => value.rows[0].params.context.auxData.frameId = "foreign-frame",
    value => value.rows.splice(1, 0, { source: { tabId: 42 }, method: "Runtime.executionContextsCleared", params: {} }),
    value => value.rows.splice(1, 0, { source: { tabId: 42 }, method: "Runtime.executionContextDestroyed", params: { executionContextId: 1, executionContextUniqueId: "original-context" } })]) {
    const changed = structuredClone(native); mutate(changed); assert.throws(() => originalDownloadContext(changed, changed.rows.find(row => row.method === "Page.downloadWillBegin")));
  }
  native.rows.splice(1, 0, { source: { tabId: 42, sessionId: "other-session" }, method: "Runtime.executionContextsCleared", params: {} });
  assert.equal(originalDownloadContext(native, begin).context.uniqueId, "original-context");
});

test("unexpected old-source acceptance preserves its original public ID without a path call or cyclic SDK object", async () => {
  const calls = [], pending = [], handle = { downloadId: "actual-public-guid", path() { throw Error("No fallback path read"); } }; handle.connection = handle;
  let resolve; const completed = new Promise(done => { resolve = done; }); let captured;
  await assert.rejects(collectRejectedDownloadSource({ wait: { result() { calls.push("collect"); return completed; } }, pending,
    async click() { calls.push("click"); resolve(handle); }, async reject(name, promise, authority) { captured = { name, authority, value: await promise }; throw Error("Unexpected successful collect"); } }), /Unexpected successful collect/);
  assert.deepEqual(calls, ["collect", "click"]); assert.equal(pending.length, 1); assert.equal((await pending[0]).value, handle);
  assert.deepEqual(JSON.parse(JSON.stringify(captured)), { name: "unproven-source-collect", authority: "source", value: { downloadId: "actual-public-guid" } });
});

function sharedOpaqueBoundary() {
  const item = opaqueBoundary(); item.name = "shared-opaque-no-native-download"; item.server.sharedBlob = true;
  Object.assign(item, { classification: "browser-blocked-before-download", armStartedAt: 0, requestedTimeoutMs: 15000, remainingMs: 14999, collectionSettledAt: 15001,
    downloadFilesBefore: [{ name: "prior.bin", dev: "1", ino: "2", size: "177", mtimeNs: "1234" }], downloadFilesAfter: [{ name: "prior.bin", dev: "1", ino: "2", size: "177", mtimeNs: "1234" }] });
  item.rejections = [{ name: "browser-no-download-collect", authority: "browser-no-event", ok: false, error: "OBU_DOWNLOAD_WAIT_TIMEOUT: OBU_TRANSFER_TIMEOUT: original download wait deadline expired" }];
  const root = item.before.documents[0], child = item.before.documents[1], childURL = child.result.href.replace("localhost", "127.0.0.1"), blobURL = "blob:http://127.0.0.1:49152/shared-original-object";
  const shared = { url: blobURL, creatorOrigin: new URL(root.result.href).origin, creatorDocumentToken: root.result.state.documentToken, childDocumentToken: child.result.state.documentToken, revoked: false };
  for (const snapshot of [item.before, item.after]) {
    snapshot.documents[0].result.origin = shared.creatorOrigin; snapshot.documents[0].result.childFrame.src = childURL;
    snapshot.documents[1].result.href = childURL; snapshot.frames[1].url = childURL; snapshot.targets[1].url = childURL;
    snapshot.documents.forEach(row => row.result.state.sharedBlob = { ...shared, revoked: snapshot === item.after });
  }
  const clicked = item.after.documents[1].result.state; clicked.blobURL = blobURL; clicked.clicks[0].blobURL = blobURL; clicked.clicks[0].revocation = "parent-message-ack";
  for (const row of item.nativeEvidence.commands) if (row.result?.frameTree.frame.url) { row.result.frameTree.frame.url = childURL; row.result.frameTree.frame.securityOrigin = shared.creatorOrigin; }
  const frame = item.nativeEvidence.rows.find(row => row.method === "Page.frameNavigated").params.frame; frame.url = childURL; frame.parentId = "original-root-target"; frame.securityOrigin = shared.creatorOrigin;
  item.nativeEvidence.rows = item.nativeEvidence.rows.filter(row => row.method !== "Page.downloadWillBegin"); item.relay.records = [];
  delete item.file; delete item.browserDownload; return item;
}

test("shared opaque browser-no-event classification requires the original timeout and cannot be confused with a product source rejection", () => {
  const item = sharedOpaqueBoundary(); assert.deepEqual(checkRestrictedDownloadBoundaryEvidence(item), { downloads: 0, posts: 0, bytes: 0, delivered: 0, classification: "browser-blocked-before-download" }); assert.equal(item.sourceContext.context.origin, "://"); assert.equal(item.opaqueSource.nativeSecurityOrigin, "http://127.0.0.1:49152");
  for (const mutate of [value => value.nativeEvidence.rows.find(row => row.method === "Runtime.executionContextCreated").params.context.origin = "http://127.0.0.1:49152",
    value => value.after.documents[0].result.state.sharedBlob.creatorDocumentToken = "successor", value => value.before.documents[1].result.state.sharedBlob.url = "blob:null/other",
    value => value.after.documents[1].result.state.sharedBlob.revoked = false, value => value.after.documents[1].result.state.clicks[0].revocation = "synchronous",
    value => value.nativeEvidence.rows.find(row => row.method === "Page.frameNavigated").params.frame.parentId = "foreign-parent",
    value => value.nativeEvidence.commands[1].result.frameTree.frame.securityOrigin = "http://different.test", value => value.rejections[0].ok = true,
    value => value.nativeEvidence.wire.push({ kind: "native-request", message: { params: { operation: "claim" } } }),
    value => value.collectionSettledAt = 14999, value => value.requestedTimeoutMs = 30000, value => value.rejections[0].error = "OBU_SITE_ACCESS_UNVERIFIED: rejected",
    value => value.rejections[0].authority = "source", value => value.downloadFilesAfter[0].mtimeNs = "changed", value => value.file = { path: "unexpected.bin" },
    value => value.notifications.push({ status: "complete" }), value => value.relay.overflow = true,
    value => value.nativeEvidence.rows.push({ method: "Page.downloadWillBegin", params: {} }), value => value.relay.records.push({ json: { method: "Browser.downloadWillBegin", params: { frameId: "original-child-target" } } })]) {
    const changed = sharedOpaqueBoundary(); mutate(changed); assert.throws(() => checkRestrictedDownloadBoundaryEvidence(changed));
  }
  const strictSource = opaqueBoundary(); strictSource.rejections[0].error = item.rejections[0].error; assert.throws(() => checkRestrictedDownloadBoundaryEvidence(strictSource));
});
