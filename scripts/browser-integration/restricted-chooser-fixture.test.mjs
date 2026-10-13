import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { checkRestrictedChooserEvidence, checkRestrictedChooserBoundaryEvidence, checkRestrictedChooserCaller, installRestrictedChooserEvidence, runRestrictedChooserWireCaller } from "./restricted-chooser-fixture.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex"), bytes = Buffer.from("Original file 中文\0🙂");
const files = [{ path: "C:/private/original.txt", name: "original.txt", size: bytes.length, sha256: hash(bytes) }];
const scope = { session_id: "original-owner", turn_id: "original-turn", control_epoch: 11 };
const config = { key: "restricted-chooser-js-root", layout: "root", tabId: 42, paths: files.map(file => file.path), scope };

function evidence() {
  const href = "http://127.0.0.1:49152/chooser-waits/page?key=restricted-chooser-js-root&variant=root", token = "original-document";
  const posts = [1, 2].map(sequence => {
    const selected = sequence === 1 ? files.map(({ name, size, sha256 }) => ({ name, size, sha256 })) : [];
    const value = { key: config.key, variant: "root", sequence, href, documentToken: token, clicks: Array.from({ length: sequence }, () => ({ trusted: true })), changes: [{ trusted: true, count: 1 }, ...(sequence === 2 ? [{ trusted: false, count: 0 }] : [])], files: sequence === 1 ? [{ name: files[0].name, size: bytes.length, base64: bytes.toString("base64") }] : [] };
    const raw = Buffer.from(JSON.stringify(value)); return { ...value, method: "POST", files: selected, bodyBase64: raw.toString("base64"), bodyBytes: raw.length, bodySHA256: hash(raw), receipt: { key: config.key, variant: "root", sequence, documentToken: token, files: selected } };
  });
  const state = { href, evidence: { documentToken: token, clicks: posts[1].clicks, changes: posts[1].changes, frameAdds: [] }, input: { id: "upload", type: "file", connected: true, files: [], value: "" }, receipt: JSON.stringify(posts[1].receipt) };
  const before = structuredClone(state); before.evidence.clicks = []; before.evidence.changes = []; before.receipt = "";
  const source = { tabId: config.tabId }, rows = [
    { kind: "event", source, method: "Page.fileChooserOpened", params: { frameId: "root-target", backendNodeId: 81 } },
    { kind: "native", source, method: "DOM.setFileInputFiles", params: { backendNodeId: 81, files: config.paths } }, { kind: "ack", call: 2, result: {} },
    { kind: "event", source, method: "Page.fileChooserOpened", params: { frameId: "root-target", backendNodeId: 81 } },
    { kind: "native", source, method: "DOM.resolveNode", params: { backendNodeId: 81 } }, { kind: "ack", call: 5, result: { object: { objectId: "original-node-object" } } },
    { kind: "native", source, method: "Runtime.callFunctionOn", params: { objectId: "original-node-object", functionDeclaration: 'function() { this.value = ""; return this.files.length; }' } }, { kind: "ack", call: 7, result: { result: { value: 0 } } }
  ].map((row, index) => ({ ...row, sequence: index + 1 }));
  return { record: { posts }, item: { ...structuredClone(config), before: { documents: [{ frameId: 0, documentId: "native-document", result: before }] }, after: { documents: [{ frameId: 0, documentId: "native-document", result: state }], targets: [{ id: "root-target", type: "page", tabId: config.tabId }] },
    callerResult: { tabId: config.tabId, scope: structuredClone(scope), receipts: posts.map(post => post.receipt), waits: posts.map((post, index) => ({ sequence: index + 1, waiterId: `wait-${index}`, remainingMs: 9900, readyAt: 1, triggerSubmittedAt: 2, collectedAt: 3, result: { fileChooserId: `chooser-${index}`, isMultiple: false }, files: index === 0 ? config.paths : [], setResult: {}, cancelled: true })) },
    nativeEvidence: { rows, pending: 0, overflow: false, restored: true, removed: true } } };
}

test("upload and explicit clear prove original node, native ACK, trusted/untrusted events and exact bytes", () => {
  const { item, record } = evidence(); assert.deepEqual(checkRestrictedChooserEvidence(item, record, files), { posts: 2, bytes: record.posts.reduce((sum, post) => sum + post.bodyBytes, 0), fileBytes: bytes.length, documentId: "native-document", backendNodeId: 81, chooserEvents: 2, nativeWrites: 1, nativeClears: 1 });
});

test("chooser oracle rejects replay, foreign node/target/object, missing ACK, wrong bytes and fabricated trusted clear", () => {
  for (const mutate of [x => x.record.posts.push(x.record.posts[0]), x => x.record.posts[0].bodySHA256 = "wrong", x => x.record.posts[1].changes[1].trusted = true,
    x => x.item.after.documents[0].documentId = "replacement", x => x.item.after.documents[0].result.input.files = [{ name: "leftover", size: 1 }],
    x => x.item.nativeEvidence.rows[1].params.backendNodeId++, x => x.item.nativeEvidence.rows[1].source = { tabId: 99 }, x => x.item.nativeEvidence.rows[6].params.objectId = "replacement-node",
    x => x.item.nativeEvidence.rows.splice(2, 1), x => x.item.nativeEvidence.rows[7].result.result.value = 1, x => x.item.nativeEvidence.rows[3].params.frameId = "foreign-frame",
    x => x.item.nativeEvidence.rows[6].source = { tabId: 42, sessionId: "foreign" }, x => x.item.callerResult.scope.control_epoch++, x => x.item.callerResult.waits[1].files = [files[0].path],
    x => x.item.callerResult.waits[1].result.fileChooserId = "chooser-0", x => x.item.callerResult.waits[0].triggerSubmittedAt = 0, x => x.item.nativeEvidence.pending = 1]) {
    const copy = evidence(); mutate(copy); assert.throws(() => checkRestrictedChooserEvidence(copy.item, copy.record, files));
  }
});

for (const layout of ["root", "oopif", "dynamic-oopif"]) test(`wire ${layout} uses two distinct acknowledged choosers and explicit empty files`, async () => {
  const calls = []; let sequence = 0;
  const result = await runRestrictedChooserWireCaller(async (method, params) => { calls.push({ method, params });
    if (method === "armFileChooserWait") return { waiterId: `wait-${++sequence}`, remainingMs: 9900 };
    if (method === "collectFileChooserWait") return { fileChooserId: `original-${sequence}`, isMultiple: layout !== "root" };
    if (params.action === "textContent") return { value: JSON.stringify({ sequence }) }; return {};
  }, { ...config, layout });
  assert.equal(result.waits.length, 2); assert.equal(result.receipts.length, 2);
  for (const row of calls) for (const [key, value] of Object.entries(scope)) assert.equal(row.params[key], value);
  assert.deepEqual(calls.filter(row => row.method === "setFileChooserFiles").map(row => [row.params.fileChooserId, row.params.files]), [["original-1", config.paths], ["original-2", []]]);
  assert.equal(calls.filter(row => row.params.action === "click").length, layout === "dynamic-oopif" ? 3 : 2);
  const expected = ["armFileChooserWait", ...(layout === "dynamic-oopif" ? ["click"] : []), "click", "collectFileChooserWait", "setFileChooserFiles", "textContent", "cancelFileChooserWait", "armFileChooserWait", "click", "collectFileChooserWait", "setFileChooserFiles", "textContent", "cancelFileChooserWait"];
  assert.deepEqual(calls.map(row => row.params.action ?? row.method), expected);
});

test("arm rejection performs no input and preserves the exact first error", async () => {
  const original = Error("OBU_SITE_ACCESS_UNSUPPORTED: original source"), calls = [], detail = {};
  await assert.rejects(runRestrictedChooserWireCaller(async (method, params) => { calls.push({ method, params }); throw original; }, { ...config, layout: "dynamic-oopif" }, detail), error => error === original);
  assert.equal(calls.length, 1); assert.equal(calls[0].method, "armFileChooserWait"); assert.equal(detail.waits.length, 1); assert.deepEqual(detail.receipts, []);
});

test("failed setter is never retried and secondary cancel failure does not replace it", async () => {
  const original = Error("original setter failure"), calls = [], detail = {};
  await assert.rejects(runRestrictedChooserWireCaller(async (method, params) => { calls.push(method);
    if (method === "armFileChooserWait") return { waiterId: "wait", remainingMs: 9000 }; if (method === "collectFileChooserWait") return { fileChooserId: "original", isMultiple: false };
    if (method === "setFileChooserFiles") throw original; if (method === "cancelFileChooserWait") throw Error("secondary cancel"); return {};
  }, config, detail), error => error === original);
  assert.deepEqual(calls, ["armFileChooserWait", "browserAction", "collectFileChooserWait", "setFileChooserFiles", "cancelFileChooserWait"]); assert.match(detail.waits[0].cancelError, /secondary cancel/);
});

function probe(original) {
  const listeners = new Set(), target = {}, api = { debugger: { sendCommand: original, onEvent: { addListener: value => listeners.add(value), removeListener: value => listeners.delete(value), hasListener: value => listeners.has(value) } } };
  installRestrictedChooserEvidence(api, target, 42); return { api, target, listeners };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test("native passive observer returns the original promise/receiver and exact event route", async () => {
  const promise = Promise.resolve({ object: { objectId: "native" } }); let received;
  const original = function(...args) { received = { receiver: this, args }; return promise; }, { api, target, listeners } = probe(original);
  const params = { backendNodeId: 81 }, source = { tabId: 42, sessionId: "child-session" };
  assert.equal(api.debugger.sendCommand(source, "DOM.resolveNode", params), promise); assert.equal(received.receiver, api.debugger); assert.equal(received.args[2], params);
  [...listeners][0](source, "Page.fileChooserOpened", { backendNodeId: 81, frameId: "original-frame" }); await flush();
  const value = target.__restrictedChooserEvidence.stop(); assert.deepEqual(value.rows.map(row => row.kind), ["native", "event", "ack"]); assert.deepEqual(value.rows[1].source, source); assert.equal(value.rows[1].params.frameId, "original-frame"); assert.equal(value.rows[2].result.object.objectId, "native"); assert.equal(api.debugger.sendCommand, original); assert.equal(listeners.size, 0);
});

test("late boundary distinguishes real native ACK from delayed delivery and keeps pending until release", async () => {
  const native = Promise.withResolvers(), value = { original: "ACK" }, { api, target } = probe(() => native.promise); const control = target.__restrictedChooserEvidence;
  control.holdNextWrite(); const delivered = api.debugger.sendCommand({ tabId: 42 }, "DOM.setFileInputFiles", { backendNodeId: 81, files: config.paths }); assert.notEqual(delivered, native.promise);
  native.resolve(value); await flush(); assert.equal(control.snapshot().held, true); assert.equal(control.snapshot().pending, 1); assert.deepEqual(control.snapshot().rows.map(row => row.kind), ["native", "ack", "deliveryHeld"]); assert.throws(() => control.stop(), /still pending/);
  control.release(); assert.equal(await delivered, value); await flush(); const result = control.stop(); assert.deepEqual(result.rows.map(row => row.kind), ["native", "ack", "deliveryHeld", "deliveryReleased"]); assert.equal(result.pending, 0);
});

test("native rejection is preserved without an invented ACK or held delivery", async () => {
  const original = Error("real native rejection"), { api, target } = probe(() => Promise.reject(original)); target.__restrictedChooserEvidence.holdNextWrite();
  await assert.rejects(api.debugger.sendCommand({ tabId: 42 }, "DOM.setFileInputFiles", {}), error => error === original); await flush();
  const result = target.__restrictedChooserEvidence.stop(); assert.deepEqual(result.rows.map(row => row.kind), ["native", "rejected"]); assert.equal(result.pending, 0);
});

function boundary(name) {
  const { item, record } = evidence(); item.name = name; item.server = { posts: [] }; item.rejections = []; item.nativeEvidence.rows = []; item.after = structuredClone(item.before); item.cancelled = true;
  item.before.targets = [{ id: "root-target", type: "page", tabId: config.tabId }]; item.chosen = { fileChooserId: "original-chooser", isMultiple: false };
  if (name === "explicit-cancel") item.nativeEvidence.rows = [{ kind: "native", sequence: 1, source: { tabId: 42 }, method: "Page.setInterceptFileChooserDialog", params: { enabled: true } }, { kind: "ack", sequence: 2, call: 1, result: {} }, { kind: "native", sequence: 3, source: { tabId: 42 }, method: "Page.setInterceptFileChooserDialog", params: { enabled: false } }, { kind: "ack", sequence: 4, call: 3, result: {} }];
  if (name === "same-url-new-document") { item.after.documents[0].documentId = "new-document"; item.after.documents[0].result.evidence.documentToken = "new-token"; item.nativeEvidence.rows = [evidence().item.nativeEvidence.rows[0]]; item.rejections = [{ name: "old-document-setter", authority: "chooser", ok: false, error: "Unknown or unowned file chooser id" }]; }
  if (name === "same-url-new-document") { item.beforeNavigation = structuredClone(item.before); item.beforeNavigation.documents[0].result.evidence.clicks = [{ trusted: true }]; }
  if (name === "future-denied-child") { item.after.documents[0].result.evidence.frameAdds = [{ trusted: true }]; item.after.documents.push({ frameId: 1, documentId: "child-document", result: { href: "http://localhost:49152/chooser-waits/frame", evidence: { documentToken: "child-token", clicks: [], changes: [] } } }); item.after.frames = [{ frameId: 1, parentDocumentId: "native-document", documentId: "child-document" }]; item.rejections = [{ name: "future-tree-collect", authority: "chooser", ok: false, error: "OBU_FILE_CHOOSER_WAIT_EXPIRED: original frame changed" }]; }
  if (name === "late-native-policy") {
    item.server.posts = [record.posts[0]]; item.after.documents[0].result.evidence.clicks = [{ trusted: true }]; item.after.documents[0].result.evidence.changes = [{ trusted: true, count: 1 }]; item.after.documents[0].result.receipt = JSON.stringify(record.posts[0].receipt);
    item.nativeEvidence.rows = evidence().item.nativeEvidence.rows.slice(0, 3); item.nativeEvidence.rows.push({ kind: "deliveryHeld", call: 2, sequence: 4 }, { kind: "deliveryReleased", call: 2, sequence: 5 });
    item.newScope = { ...scope, turn_id: "explicit-new-turn", control_epoch: 12 }; item.policyChanged = { control: { state: "paused", cleanupComplete: true } }; item.held = { pending: 1, held: true }; item.blocked = { state: "error", inputBlocked: true, cleanupComplete: false, error: "OBU_AUTOMATION_PAUSE_FAILED: OBU_AUTOMATION_CLEANUP_TIMEOUT: browser cleanup is unconfirmed; automation remains paused" }; item.setStartedAt = 1; item.expiredAt = 1001;
    item.cleanupTimeoutMs = 10000; item.applyStartedAt = 1001; item.pauseFailedAt = 11001; item.failedApply = { ok: false, error: "OBU_AUTOMATION_PAUSE_FAILED: original deadline" }; item.heldAfterFailed = { pending: 1, held: true, rows: [] }; item.policyBeforeHold = { revision: 5, mode: "allow", origins: ["http://127.0.0.1:49152", "http://localhost:49152"], generation: "original-generation", ready: true, stored: true }; item.policyAfterFailed = structuredClone(item.policyBeforeHold); item.policyChanged.policy = { ...structuredClone(item.policyBeforeHold), revision: 6 }; item.durableBeforeHold = { original: "policy" }; item.durableAfterFailed = { original: "policy" }; item.operationsAfterRelease = 0;
    item.rejections = [{ name: "original-setter-timeout", authority: "timeout", ok: false, error: "OBU_DIRECTORY_UPLOAD_TIMEOUT: original deadline" }, { name: "old-policy-setter", authority: "control", ok: false, error: "OBU_STALE_CONTROL_EPOCH: original epoch" }];
  }
  return item;
}

test("cancel and replacement-document evidence cannot hide a native file write or retained identity", () => {
  for (const name of ["explicit-cancel", "same-url-new-document", "future-denied-child"]) assert.equal(checkRestrictedChooserBoundaryEvidence(boundary(name), files).posts, 0);
  for (const mutate of [item => item.after.documents[0].documentId = "native-document", item => item.after.documents[0].result.evidence.documentToken = "original-document", item => item.nativeEvidence.rows.push(evidence().item.nativeEvidence.rows[1]), item => item.server.posts.push(evidence().record.posts[0])]) { const item = boundary("same-url-new-document"); mutate(item); assert.throws(() => checkRestrictedChooserBoundaryEvidence(item, files)); }
  const cancelled = boundary("explicit-cancel"); cancelled.nativeEvidence.rows.pop(); assert.throws(() => checkRestrictedChooserBoundaryEvidence(cancelled, files));
});

test("revocation does not accept generic failure/timeout as proof or invent cancellation success", () => {
  for (const error of ["OBU_FILE_CHOOSER_WAIT_TIMEOUT: elapsed", "OBU_FILE_CHOOSER_FAILED: backend failure", "OBU_STALE_CONTROL_EPOCH: different epoch"]) { const item = boundary("future-denied-child"); item.rejections[0].error = error; assert.throws(() => checkRestrictedChooserBoundaryEvidence(item, files)); }
  const item = boundary("future-denied-child"); item.cancelled = false; assert.throws(() => checkRestrictedChooserBoundaryEvidence(item, files));
});

test("late native ACK proof requires original single POST, blocked drain and separate eventual delivery", () => {
  assert.equal(checkRestrictedChooserBoundaryEvidence(boundary("late-native-policy"), files).posts, 1);
  for (const mutate of [item => item.nativeEvidence.rows.splice(2, 1), item => item.nativeEvidence.rows.pop(), item => item.blocked.cleanupComplete = true, item => item.blocked.state = "pausing", item => item.failedApply.ok = true, item => item.pauseFailedAt--, item => item.heldAfterFailed.held = false, item => item.heldAfterFailed.rows.push({ kind: "deliveryReleased" }), item => item.policyAfterFailed.revision++, item => item.durableAfterFailed.original = "written", item => item.operationsAfterRelease = 1, item => item.newScope.control_epoch = 11, item => item.server.posts.push(item.server.posts[0]), item => item.expiredAt = 5]) { const item = boundary("late-native-policy"); mutate(item); assert.throws(() => checkRestrictedChooserBoundaryEvidence(item, files)); }
});

test("explicit beginTurn recovery accepts a fresh turn while retaining original owner and retired scope rejection", () => {
  const recovered = boundary("late-native-policy"); recovered.newScope.turn_id = "turn-43";
  assert.equal(checkRestrictedChooserBoundaryEvidence(recovered, files).posts, 1);
  for (const mutate of [item => item.newScope.session_id = "foreign-owner", item => item.newScope.control_epoch = item.scope.control_epoch, item => item.newScope.control_epoch = 1, item => item.newScope.turn_id = "", item => item.newScope.turn_id = item.scope.turn_id, item => item.rejections[1] = { name: "old-policy-setter", authority: "control", ok: true, value: {} }]) { const item = structuredClone(recovered); mutate(item); assert.throws(() => checkRestrictedChooserBoundaryEvidence(item, files)); }
});

test("original popup saved-status timeout needs independent real cleanup failure and exact one-revision recovery", () => {
  const observed = boundary("late-native-policy"); observed.failedApply.error = "Timed out waiting for restricted dialog policy saved"; observed.pauseFailedAt = observed.applyStartedAt + 15095;
  assert.equal(checkRestrictedChooserBoundaryEvidence(observed, files).posts, 1);
  for (const mutate of [item => item.failedApply = { ok: true, value: {} }, item => item.blocked.error = "OBU_AUTOMATION_PAUSE_FAILED: unrelated error", item => item.blocked.error = "OBU_AUTOMATION_CLEANUP_TIMEOUT: no failed Pause", item => item.failedApply.error = "arbitrary harness timeout", item => item.policyChanged.policy.revision++, item => item.policyChanged.policy.generation = "changed", item => item.policyChanged.policy.origins = []]) { const item = structuredClone(observed); mutate(item); assert.throws(() => checkRestrictedChooserBoundaryEvidence(item, files)); }
});

test("failed caller retains original document/zero-POST ledger and restores native probe before propagation", async () => {
  const original = Error("OBU_SITE_ACCESS_UNSUPPORTED: old production"), { item } = evidence(), calls = [], detail = {};
  const worker = { async evaluate(source) { calls.push(source); if (source.includes("installRestrictedChooserEvidence")) return; if (source.includes(".snapshot().pending")) return true; if (source.includes(".stop()")) return { rows: [], pending: 0, overflow: false, restored: true, removed: true }; if (source.startsWith("(async()=>{const observer=")) return item.before; throw Error("unexpected worker call"); } };
  const browser = { client: { sessionId: scope.session_id, turnId: scope.turn_id, controlEpoch: scope.control_epoch }, async newTab() { return { id: 42, async goto() {} }; } };
  await assert.rejects(checkRestrictedChooserCaller({ kind: "js", browser, fixtureURL: "http://127.0.0.1:49152/", fixtures: { stats: () => ({ posts: [] }), allStats: () => [{ key: config.key, posts: [] }] }, files, getWorker: () => worker, until: async fn => { const value = await fn(); assert.ok(value); return value; }, detail, caller: async () => { throw original; } }), error => error === original);
  assert.equal(detail.variants.length, 1); assert.deepEqual(detail.variants[0].before, item.before); assert.deepEqual(detail.variants[0].server.posts, []); assert.equal(detail.variants[0].nativeEvidence.restored, true); assert.equal(detail.serverLedger.length, 1); assert.equal(calls.filter(value => value.includes(".stop()")).length, 1);
});
