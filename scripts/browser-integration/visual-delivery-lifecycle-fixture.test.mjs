import test from "node:test";
import assert from "node:assert/strict";
import { installVisualDeliveryProbe, checkVisualDeliveryTrace, checkVisualDeliveryBoundary, checkVisualDeliveryLifecycle, visualDeliveryScenarios } from "./visual-delivery-lifecycle-fixture.mjs";

const scope = { session_id: "original-owner", turn_id: "original-turn", control_epoch: 7 };
const cursor = { type: "OPEN_BROWSER_USE_CURSOR", receiverToken: "original-receiver", sessionId: scope.session_id, turnId: scope.turn_id, feedbackSequence: 9, targetRect: null, x: 30, y: 50 };
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function setup(original, mode = "before-send", options = {}) {
  const calls = [], target = {}, backend = { endingSessions: new Map(), controlReleases: new Map(), visualDeliveries: { pending: new Set(), cleanups: new Set() },
    automationCleanupTimeoutMs: 10000, automationControl: { status: () => ({ state: "running", inputBlocked: false, cleanupComplete: false }) } };
  const api = { tabs: { sendMessage: original ?? function (...args) { calls.push({ receiver: this, args });
    return Promise.resolve(["OPEN_BROWSER_USE_PING", "OPEN_BROWSER_USE_CURSOR_STATE"].includes(args[1]?.type) ? { ok: true, receiverToken: cursor.receiverToken } : { ok: true }); } } };
  const native = api.tabs.sendMessage;
  installVisualDeliveryProbe(api, target, backend, { id: "fixture", tabId: 4, documentId: "original-document", scope, mode, messageType: cursor.type, ...options });
  return { api, target, backend, native, calls, probe: target.__obuVisualDelivery, send: (message = cursor, destination = { documentId: "original-document" }, tab = 4) => api.tabs.sendMessage(tab, message, destination) };
}

test("before-send holds before any original Chrome call and releases the exact receiver/arguments/result once", async () => {
  const native = deferred(), value = { ok: true }, calls = [];
  const f = setup(function (...args) { calls.push({ receiver: this, args }); return native.promise; });
  const destination = { documentId: "original-document" }, returned = f.send(cursor, destination);
  f.backend.visualDeliveries.pending.add({ scope, kind: "message", promise: returned });
  const held = await f.probe.wait("held"); assert.equal(calls.length, 0); assert.equal(held.nativePending, 0); assert.equal(held.backend.exactPending, true);
  assert.equal(held.records.find(row => row.kind === "held").nativeInvoked, false);
  f.probe.release("test"); await Promise.resolve(); assert.equal(calls.length, 1); assert.equal(calls[0].receiver, f.api.tabs);
  assert.equal(calls[0].args[1], cursor); assert.equal(calls[0].args[2], destination); assert.equal(f.probe.snapshot().nativePending, 1);
  native.resolve(value); assert.equal(await returned, value); await f.probe.wait("drained");
  checkVisualDeliveryTrace(f.probe.restore()); assert.equal(f.api.tabs.sendMessage, f.native); assert.equal(f.target.__obuVisualDelivery, undefined); assert.equal(calls.length, 1);
});

test("after-ack records real native settlement before holding its publication", async () => {
  const native = deferred(), value = { ok: true }; let calls = 0, delivered = false;
  const f = setup(() => { calls++; return native.promise; }, "after-ack");
  const returned = f.send(); returned.then(() => { delivered = true; }); assert.equal(calls, 1); assert.equal(f.probe.snapshot().nativePending, 1);
  assert.equal(f.probe.snapshot().deliveryPending, 0); native.resolve(value);
  const held = await f.probe.wait("held"); assert.equal(held.nativePending, 0); assert.equal(delivered, false);
  assert.deepEqual(held.records.find(row => row.kind === "native-settled").value, value); assert.equal(held.records.find(row => row.kind === "held").nativeInvoked, true);
  f.probe.release("test"); assert.equal(await returned, value); await f.probe.wait("drained"); checkVisualDeliveryTrace(f.probe.restore()); assert.equal(calls, 1);
});

test("foreign scope, tab, document and message type retain the identical original Promise", async () => {
  const native = deferred(); let calls = 0; const f = setup(() => { calls++; return native.promise; });
  for (const args of [[cursor, { documentId: "foreign-document" }], [{ ...cursor, turnId: "other" }], [{ ...cursor, sessionId: "other" }],
    [cursor, { documentId: "original-document" }, 9], [{ ...cursor, type: "OPEN_BROWSER_USE_POINTER_EVENT" }], [{ type: "OPEN_BROWSER_USE_PING" }]]) assert.equal(f.send(...args), native.promise);
  native.resolve({ ok: true }); await native.promise; assert.equal(calls, 6); assert.equal(f.probe.snapshot().selected, null); f.probe.release("test"); f.probe.restore();
});

test("a second matching message is observed but never gated or replayed", async () => {
  const native = deferred(); let calls = 0; const f = setup(() => { calls++; return native.promise; });
  const first = f.send(); const second = f.send({ ...cursor, feedbackSequence: 10 }); assert.equal(second, native.promise); assert.equal(calls, 1);
  native.resolve({ ok: true }); await second; f.probe.release("test"); await first; await f.probe.wait("drained"); const record = f.probe.restore();
  checkVisualDeliveryTrace(record); assert.equal(record.records.filter(row => row.kind === "selected").length, 1); assert.equal(calls, 2);
});

test("actual native rejection is preserved and never converted into a held successful ACK", async () => {
  const originalError = new Error("Original native rejection"), f = setup(() => Promise.reject(originalError), "after-ack");
  await assert.rejects(f.send(), error => error === originalError); assert.equal(f.probe.snapshot().deliveryPending, 0);
  assert.equal(f.probe.snapshot().records.some(row => row.kind === "held"), false); f.probe.release("test"); const record = f.probe.restore();
  assert.equal(record.records.find(row => row.kind === "native-settled").ok, false); assert.throws(() => checkVisualDeliveryTrace(record));
});

test("restoration cannot discard a pending original delivery or a replaced observer", async () => {
  const f = setup(), returned = f.send(); await f.probe.wait("held"); assert.throws(() => f.probe.restore(), /unresolved/);
  f.probe.release("test"); await returned; await f.probe.wait("drained"); const wrapper = f.api.tabs.sendMessage;
  f.api.tabs.sendMessage = () => {}; assert.throws(() => f.probe.restore(), /identity changed/); f.api.tabs.sendMessage = wrapper; f.probe.restore();
});

test("old-source missing registry is recorded honestly without blocking real original actions", async () => {
  const f = setup(); delete f.backend.visualDeliveries; const returned = f.send(); const held = await f.probe.wait("held");
  assert.equal(held.backend.supported, false); assert.equal(held.backend.exactPending, false); assert.equal(held.backend.pending, null);
  f.probe.release("test"); await returned; await f.probe.wait("drained"); checkVisualDeliveryTrace(f.probe.restore());
});

test("native RPC observations preserve the previous observer and exact original cleanup scope", async () => {
  const originalCalls = [], target = { __integrationNativeRPCObserver: (...args) => originalCalls.push(args) }, previous = target.__integrationNativeRPCObserver;
  const f = setup(); f.probe.release("unused"); f.probe.restore();
  installVisualDeliveryProbe(f.api, target, f.backend, { id: "rpc", tabId: 4, documentId: "original-document", scope, mode: "before-send", messageType: cursor.type });
  const probe = target.__obuVisualDelivery, observer = target.__integrationNativeRPCObserver;
  const request = { id: 42, method: "turnEnded", params: { ...scope } }; observer("request", request); observer("response", { id: 42, result: { controlEpoch: 8 } });
  observer("request", { id: 43, method: "detach", params: { ...scope, control_epoch: 8 } }); observer("response", { id: 43, result: {} });
  const rows = probe.snapshot().records; assert.deepEqual(rows.map(row => row.kind), ["request", "response"]); assert.equal(originalCalls[0][1], request);
  probe.release("test"); probe.restore(); assert.equal(target.__integrationNativeRPCObserver, previous);
});

async function boundary(operation = "turnEnded") {
  const f = setup(); await f.send({ type: "OPEN_BROWSER_USE_PING" }); const returned = f.send(); f.backend.visualDeliveries.pending.add({ promise: returned, scope, kind: "message" });
  const held = await f.probe.wait("held"), started = Date.now();
  if (operation !== "pause") f.target.__integrationNativeRPCObserver("request", { id: 1, method: operation, params: scope });
  f.probe.release("boundary"); await returned; await f.probe.wait("drained");
  await f.send({ type: "OPEN_BROWSER_USE_CURSOR_STATE", receiverToken: cursor.receiverToken, state: { isVisible: false } });
  if (operation !== "pause") f.target.__integrationNativeRPCObserver("response", { id: 1, result: {} });
  const probe = f.probe.restore();
  return { operation, probe, held, atBoundaryProbe: structuredClone(held), controlStartedAt: started, retryPauseProbe: structuredClone(probe),
    controlOutcome: { ok: false, error: "Request timed out", at: started + 1000 }, blockedSuccessor: { ok: false, error: operation === "turnEnded" ? "OBU_CONTROL_ENDING: original cleanup pending" : "Request timed out" } };
}

test("cleanup oracle rejects early success, lost actual Promise and response before delivery", async () => {
  const original = await boundary(); checkVisualDeliveryBoundary(original);
  for (const mutate of [value => { value.controlOutcome = { ok: true, value: {} }; }, value => { value.atBoundaryProbe.backend.exactPending = false; },
    value => { value.probe.records.find(row => row.kind === "response").sequence = 1; }, value => { value.blockedSuccessor = { ok: true, value: {} }; },
    value => { value.atBoundaryProbe.deliveryPending = 0; }]) { const changed = structuredClone(original); mutate(changed); assert.throws(() => checkVisualDeliveryBoundary(changed)); }
});

function finalHideRows(item) {
  const call = item.probe.records.find(row => row.kind === "call" && row.message.type === "OPEN_BROWSER_USE_CURSOR_STATE");
  return { call, ack: item.probe.records.find(row => row.kind === "native-settled" && row.call === call.sequence) };
}
for (const [name, mutate] of [
  ["missing actual hidden ACK", item => { finalHideRows(item).ack.kind = "unrelated-marker"; }],
  ["false hidden ACK", item => { finalHideRows(item).ack.value = { ok: false }; }],
  ["wrong original document", item => { finalHideRows(item).call.options = { documentId: "successor-document" }; }],
  ["hidden only after cleanup success", item => {
    const rows = item.probe.records, response = rows.splice(rows.findIndex(row => row.kind === "response"), 1)[0], hide = finalHideRows(item).call;
    rows.splice(rows.indexOf(hide), 0, response); const sequences = new Map(rows.map((row, index) => [row.sequence, index + 1]));
    for (const row of rows) { row.sequence = sequences.get(row.sequence); if (Object.hasOwn(row, "call")) row.call = sequences.get(row.call); }
    item.probe.selected = sequences.get(item.probe.selected);
  }]
]) test(`final hiding cannot pass with ${name}`, async () => {
  const item = await boundary(); mutate(item); checkVisualDeliveryTrace(item.probe);
  assert.throws(() => checkVisualDeliveryBoundary(item));
});

test("Pause hidden ACK must already exist in the pre-Resume checkpoint after successful Retry Pause", async () => {
  const item = await boundary("pause"); item.controlOutcome = { ok: true, value: { ok: false, error: "OBU_AUTOMATION_PAUSE_FAILED: OBU_AUTOMATION_CLEANUP_TIMEOUT: pending original" }, at: item.controlStartedAt + 10000 };
  item.atBoundaryProbe.backend.automation = { state: "error", cleanupComplete: false }; item.blockedSuccessor = { ok: false, error: "OBU_AUTOMATION_PAUSED: paused" };
  item.retryPause = { ok: true, status: { cleanupComplete: true } }; item.resumed = { ok: true, status: { inputBlocked: false } };
  const ack = finalHideRows(item).ack; item.retryPauseProbe.records = item.retryPauseProbe.records.filter(row => row.sequence < ack.sequence);
  checkVisualDeliveryTrace(item.probe); assert.throws(() => checkVisualDeliveryBoundary(item));
});

for (const [name, mutate] of [
  ["unknown original PING token", item => { const ping = item.probe.records.find(row => row.kind === "call" && row.message.type === "OPEN_BROWSER_USE_PING"); item.probe.records.find(row => row.kind === "native-settled" && row.call === ping.sequence).value.receiverToken = "foreign-receiver"; }],
  ["missing original PING ACK", item => { const ping = item.probe.records.find(row => row.kind === "call" && row.message.type === "OPEN_BROWSER_USE_PING"); item.probe.records.find(row => row.kind === "native-settled" && row.call === ping.sequence).kind = "unrelated-marker"; }],
  ["hidden message for a successor token", item => { finalHideRows(item).call.message.receiverToken = "successor-receiver"; }],
  ["hidden ACK with a foreign token", item => { finalHideRows(item).ack.value.receiverToken = "foreign-receiver"; }]
]) test(`receiver identity rejects ${name}`, async () => { const item = await boundary(); mutate(item); checkVisualDeliveryTrace(item.probe); assert.throws(() => checkVisualDeliveryBoundary(item)); });

test("Pause requires actual unchanged deadline failure, not transient blocked or a caller timeout", async () => {
  const item = await boundary("pause"); item.controlOutcome = { ok: true, value: { ok: false, error: "OBU_AUTOMATION_PAUSE_FAILED: OBU_AUTOMATION_CLEANUP_TIMEOUT: pending original" }, at: item.controlStartedAt + 10000 };
  item.atBoundaryProbe.backend.automation = { state: "error", cleanupComplete: false }; item.blockedSuccessor = { ok: false, error: "OBU_AUTOMATION_PAUSED: paused" };
  item.retryPause = { ok: true, status: { cleanupComplete: true } }; item.resumed = { ok: true, status: { inputBlocked: false } }; checkVisualDeliveryBoundary(item);
  for (const mutate of [value => { value.controlOutcome.at--; }, value => { value.controlOutcome.value = { ok: true, status: { cleanupComplete: true } }; },
    value => { value.controlOutcome = { ok: false, error: "caller timed out" }; }, value => { value.atBoundaryProbe.backend.automation.state = "pausing"; },
    value => { value.atBoundaryProbe.backend.cleanupTimeoutMs = 1000; }]) { const changed = structuredClone(item); mutate(changed); assert.throws(() => checkVisualDeliveryBoundary(changed)); }
});

test("before-send and after-ACK evidence cannot be relabeled as one another", async () => {
  const item = await boundary(); const falseACK = structuredClone(item.probe); falseACK.mode = "after-ack"; assert.throws(() => checkVisualDeliveryTrace(falseACK));
  const missingACK = structuredClone(item.probe); missingACK.records.find(row => row.kind === "native-settled" && row.call === missingACK.selected).ok = false; assert.throws(() => checkVisualDeliveryTrace(missingACK));
  assert.deepEqual(visualDeliveryScenarios.map(row => [row.operation, row.mode]), [["turnEnded", "before-send"], ["pause", "after-ack"], ["detach", "before-send"]]);
});

test("a failed scene retains its first error and ledger while the other scenes are still attempted once", async () => {
  const first = new Error("first original setup failed"), calls = [], saved = [];
  await assert.rejects(checkVisualDeliveryLifecycle({ popup: {}, fixtureURL: "http://127.0.0.1:55555/",
    connectBrowser: async name => { calls.push(name); throw calls.length === 1 ? first : new Error("later original setup failed"); },
    fixtures: { stats: key => ({ key, gets: [], posts: [] }), allStats: () => [] }, saveDetail: detail => { saved.push(structuredClone(detail)); }
  }), error => error === first);
  assert.deepEqual(calls, visualDeliveryScenarios.map(row => `visual-delivery-${row.name}`)); assert.equal(saved.at(-1).cases.length, 3);
  assert.ok(saved.at(-1).cases.every(row => row.passed === false && row.server.posts.length === 0)); assert.equal(saved.at(-1).error, first.message);
});

test("final persistence failure cannot replace the original scene error", async () => {
  const first = new Error("original scene failure"), persistence = new Error("final save failure"); let saves = 0;
  await assert.rejects(checkVisualDeliveryLifecycle({ popup: {}, fixtureURL: "http://127.0.0.1:55555/",
    connectBrowser: async () => { throw first; }, fixtures: { stats: key => ({ key }), allStats: () => [] },
    saveDetail: async () => { if (++saves === 4) throw persistence; }
  }), error => error === first); assert.equal(saves, 4);
});
