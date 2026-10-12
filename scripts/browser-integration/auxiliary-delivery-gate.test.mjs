import assert from "node:assert/strict";
import test from "node:test";
import { createContext, runInContext } from "node:vm";
import { installAuxiliaryDeliveryGate } from "./auxiliary-delivery-gate.mjs";
import { fixture as backendFixture } from "../../apps/chrome-extension/test-support/page-waits-fixture.mjs";

// Native calls here are simulations. Real Backend integration below verifies
// the exact storage shapes and intermediate states; neither is a browser run.
const AUX = "OPEN_BROWSER_USE_AUXILIARY_TABS", STATE = "OPEN_BROWSER_USE_SESSION_STATE";
const plain = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
async function until(predicate, label) {
  for (let count = 0; count < 100; count++) { if (predicate()) return; await tick(); }
  throw Error(`Gate fixture did not reach ${label}`);
}

function fixture({ options = {}, native, inherited = false, install = true, configure } = {}) {
  const scope = { session_id: "task", turn_id: "turn", control_epoch: 3 };
  const claims = [8, 10].map((tabId, index) => ({ ...scope, tabId, claimId: `original-${tabId}`,
    windowId: index ? 1 : 2, kind: index ? "created-page" : "popup", origin: "user", phase: "committed" }));
  const entries = new Map(claims.map(claim => [claim.tabId, claim]));
  const states = new Map(claims.map(claim => [claim, { persisted: true, durable: true, removing: false }]));
  const ledger = { epoch: 3, status: "active" }, calls = [], timers = new Map();
  let timestamp = 1000, nextTimer = 0;
  class Clock extends Date { static now() { return ++timestamp; } }
  const backend = { browserLifetime: { incarnation: "original-browser" }, auxiliaryDeliveries: new Map(), endingSessions: new Map(),
    controlLedger: { records: new Map([[scope.session_id, ledger]]) }, store: { state: { deliverableTabs: {} } },
    auxiliaryTabs: { entry: id => entries.get(id), owner: id => entries.get(id), state: claim => states.get(claim) } };
  const patches = ["session", "local"].map(area => {
    const original = function (...args) {
      const call = { area, receiver: this, args }; calls.push(call);
      return call.result = native ? native(call) : Promise.resolve({ native: area });
    };
    const parent = {};
    Object.defineProperty(parent, "set", { value: original, configurable: true, writable: true, enumerable: false });
    const object = inherited ? Object.create(parent) : parent;
    return { area, original, object, descriptor: Object.getOwnPropertyDescriptor(object, "set") };
  });
  const chrome = { storage: Object.fromEntries(patches.map(patch => [patch.area, patch.object])) };
  const config = { scope, tabIds: [8, 10], stage: "claim-delete", gateTabId: 8, ...options };
  const context = createContext({ backend, chrome, config, TextEncoder, Date: Clock,
    setTimeout(fn, ms) { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); } });
  configure?.({ backend, claims, entries, states, ledger, config, chrome, context });
  const doInstall = () => plain(runInContext(`(${installAuxiliaryDeliveryGate.toString()})(backend, chrome, globalThis, config)`, context));
  const installed = install ? doInstall() : null, api = context.__auxiliaryDeliveryGate;
  function ending() {
    backend.endingSessions.set(scope.session_id, { finalizing: false });
    for (const claim of claims) backend.auxiliaryDeliveries.set(claim.tabId, { record: claim,
      position: { id: claim.tabId, windowId: claim.windowId, groupId: -1, pinned: false }, released: false });
  }
  function deleting(id = 8) {
    if (!backend.endingSessions.size) ending();
    const claim = claims.find(claim => claim.tabId === id); claim.phase = "quarantined";
    Object.assign(states.get(claim), { durable: false, removing: true });
  }
  const claimPayload = (remaining = [claims[1]]) => ({ [AUX]: { version: 4, incarnation: "original-browser", records: remaining.map(plain) } });
  function marking() {
    if (!backend.endingSessions.size) ending();
    backend.endingSessions.get(scope.session_id).finalizing = true; ledger.epoch = 4; ledger.status = "idle";
    for (const claim of claims) {
      entries.delete(claim.tabId);
      const proof = backend.auxiliaryDeliveries.get(claim.tabId);
      proof.released = true; proof.marker = { windowId: claim.windowId, groupId: -1, pinned: false,
        deliveryId: `delivery-${claim.tabId}`, deliveredAt: 900 };
      backend.store.state.deliverableTabs[claim.tabId] = proof.marker;
    }
    return { [STATE]: { incarnation: "original-browser", deliverableTabs: plain(backend.store.state.deliverableTabs) } };
  }
  return { backend, claims, entries, states, ledger, calls, timers, patches, chrome, context, config, installed, api,
    doInstall, ending, deleting, claimPayload, marking, snapshot: () => plain(api.snapshot()), stop: () => plain(api.stop()) };
}

function complete(snapshot) {
  assert.equal(snapshot.closed, true); assert.equal(snapshot.restored, true); assert.equal(snapshot.apiRemoved, true);
  assert.equal(snapshot.overflow, false); assert.deepEqual(snapshot.errors, []); assert.deepEqual(snapshot.pendingOperations, []);
  assert.equal(snapshot.bytes, snapshot.records.reduce((sum, record) => sum + Buffer.byteLength(JSON.stringify(record)), 0));
  snapshot.records.forEach((record, index) => assert.equal(record.sequence, index + 1));
}

test("serialized gate holds publication only after the unchanged original call actually fulfills", async () => {
  const native = deferred(), f = fixture({ native: () => native.promise });
  assert.equal(f.calls.length, 0);
  f.deleting(); const payload = f.claimPayload(), before = plain(payload), receiver = { realReceiver: true };
  let settled = false;
  const returned = Reflect.apply(f.chrome.storage.session.set, receiver, [payload]).then(value => { settled = true; return value; });
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].receiver, receiver); assert.equal(f.calls[0].args[0], payload);
  assert.deepEqual(payload, before); assert.equal(f.snapshot().gate.nativeSettled, false); assert.equal(f.snapshot().gate.held, false);
  const nativeValue = { acknowledgment: true }; native.resolve(nativeValue);
  await until(() => f.snapshot().gate.held, "publication hold");
  assert.equal(settled, false); assert.equal(f.snapshot().pendingOperations[0].nativePending, false);
  const held = f.snapshot(); assert.equal(held.gate.nativeSettled, true);
  assert.ok(held.gate.callSequence < held.gate.nativeSequence && held.gate.nativeSequence < held.gate.heldSequence);
  assert.deepEqual(held.records[0].args.selectedRemaining, [{ tabId: 10, claimId: "original-10", phase: "committed" }]);
  assert.deepEqual(held.records[0].args.omitted, [{ tabId: 8, claimId: "original-8" }]);
  const released = plain(f.api.release()); assert.equal(released.gate.released, true); assert.equal(released.gate.published, false);
  assert.equal(await returned, nativeValue); assert.equal(f.calls.length, 1);
  const final = f.stop(); complete(final); assert.equal(final.gate.published, true);
  assert.ok(final.gate.releaseSequence < final.gate.publishedSequence);
  assert.ok(final.gate.nativeAt <= final.gate.heldAt && final.gate.heldAt <= final.gate.releasedAt && final.gate.releasedAt <= final.gate.publishedAt);
});

test("marker mode observes claim deletion without holding and then holds only the exact published batch", async () => {
  const f = fixture({ options: { stage: "marker-write", gateTabId: undefined } });
  f.deleting(); await f.chrome.storage.session.set(f.claimPayload()); assert.equal(f.snapshot().gate, null);
  const payload = f.marking(); payload[STATE].sessions = { foreign: { secret: "must-not-be-copied" } };
  payload[STATE].deliverableTabs[99] = { deliveryId: "foreign-secret", windowId: 99 };
  const pending = f.chrome.storage.local.set(payload);
  await until(() => f.snapshot().gate?.held, "marker hold");
  const held = f.snapshot(), selected = held.records.find(row => row.stage === "marker-write");
  assert.equal(held.current.finalizing, true); assert.deepEqual(selected.args.markers.map(marker => marker.tabId), [8, 10]);
  assert.equal(JSON.stringify(held).includes("secret"), false);
  f.api.release(); await pending; complete(f.stop());
});

test("unmatched writes preserve the exact native Promise, args and receiver without recording foreign data", async () => {
  const f = fixture(), payload = { unrelated: { privateData: "foreign-value" } }, receiver = {};
  const returned = Reflect.apply(f.chrome.storage.local.set, receiver, [payload]);
  assert.equal(returned, f.calls[0].result); assert.equal(f.calls[0].args[0], payload); assert.equal(f.calls[0].receiver, receiver);
  await returned; assert.deepEqual(f.snapshot().records, []); complete(f.stop());
});

test("selection requires the original scope, claim, incarnation, removing state and actual finalizer", async () => {
  const changes = [
    f => f.backend.endingSessions.clear(),
    f => f.backend.browserLifetime.incarnation = "replacement-browser",
    f => f.claims[0].turn_id = "another-turn",
    f => f.claims[0].control_epoch++,
    f => f.entries.set(8, { ...f.claims[0] }),
    f => f.backend.auxiliaryDeliveries.set(8, { record: { ...f.claims[0] }, position: { id: 8 } }),
    f => f.states.get(f.claims[0]).removing = false,
    f => f.states.get(f.claims[0]).persisted = false,
    f => f.claims[0].phase = "committed"
  ];
  for (const change of changes) {
    const f = fixture(); f.deleting(); change(f);
    const pending = f.chrome.storage.session.set(f.claimPayload());
    assert.equal(pending, f.calls[0].result); await pending; assert.equal(f.snapshot().gate, null); complete(f.stop());
  }
});

test("marker selection rejects replacement metadata, unreleased claims and a different incarnation", async () => {
  for (const change of [
    (f, payload) => payload[STATE].deliverableTabs[8].deliveryId = "replacement",
    (f, payload) => payload[STATE].incarnation = "replacement",
    f => f.backend.auxiliaryDeliveries.get(8).released = false,
    f => f.entries.set(8, { ...f.claims[0] })
  ]) {
    const f = fixture({ options: { stage: "marker-write", gateTabId: undefined } }), payload = f.marking(); change(f, payload);
    const returned = f.chrome.storage.local.set(payload);
    assert.equal(returned, f.calls[0].result); await returned; assert.equal(f.snapshot().gate, null); complete(f.stop());
  }
});

test("gateTabId never holds a different deletion or a batch where the child is already being removed", async () => {
  const f = fixture(); f.deleting(10);
  await f.chrome.storage.session.set(f.claimPayload([f.claims[0]])); assert.equal(f.snapshot().gate, null);
  f.deleting(8); await f.chrome.storage.session.set(f.claimPayload([]));
  assert.equal(f.snapshot().gate, null); complete(f.stop());
});

test("source deletion requires every other selected claim to remain exactly persisted", async () => {
  for (const change of [
    f => f.entries.set(10, { ...f.claims[1] }),
    f => f.states.get(f.claims[1]).persisted = false,
    f => f.states.get(f.claims[1]).removing = true
  ]) {
    const f = fixture(); f.deleting(); change(f); await f.chrome.storage.session.set(f.claimPayload());
    assert.equal(f.snapshot().gate, null); complete(f.stop());
  }
});

test("selection does not evaluate argument accessors or toJSON and never blocks the original call", async () => {
  let reads = 0; const f = fixture(); f.deleting();
  const payload = { toJSON() { reads++; throw Error("must not run"); } };
  Object.defineProperty(payload, AUX, { get() { reads++; throw Error("must not run"); } });
  const returned = f.chrome.storage.session.set(payload);
  assert.equal(returned, f.calls[0].result); assert.equal(f.calls[0].args[0], payload); await returned;
  assert.equal(reads, 0); assert.match(f.snapshot().errors[0], /accessor/); assert.equal(f.stop().restored, true);
});

test("original native rejection is preserved by identity and is never held or retried", async () => {
  const failure = Error("real simulated native failure"), f = fixture({ native: () => Promise.reject(failure) });
  f.deleting(); await assert.rejects(f.chrome.storage.session.set(f.claimPayload()), error => error === failure);
  assert.equal(f.calls.length, 1); const final = f.stop(); complete(final);
  assert.equal(final.gate.rejected, true); assert.equal(final.gate.held, false); assert.equal(final.gate.nativeSettled, true);
  assert.equal(final.records.at(-1).kind, "native-rejected");
});

test("original synchronous throw is preserved, without adding a Promise or retry", () => {
  const failure = Error("synchronous failure"), f = fixture({ native: () => { throw failure; } }); f.deleting();
  assert.throws(() => f.chrome.storage.session.set(f.claimPayload()), error => error === failure);
  assert.equal(f.calls.length, 1); const final = f.stop(); complete(final); assert.equal(final.records.at(-1).kind, "native-threw");
});

test("native error payload and a foreign replacement marker are never copied into evidence", async () => {
  for (const synchronous of [false, true]) {
    let inspected = 0;
    const originalError = { foreignStorage: "foreign-secret" };
    for (const key of ["message", "name"]) Object.defineProperty(originalError, key, { get() { inspected++; throw Error("secret accessor"); } });
    const f = fixture({ native: () => { if (synchronous) throw originalError; return Promise.reject(originalError); } });
    f.deleting(); f.backend.store.state.deliverableTabs[8] = { deliveryId: "foreign-secret" };
    if (synchronous) assert.throws(() => f.chrome.storage.session.set(f.claimPayload()), error => error === originalError);
    else await assert.rejects(f.chrome.storage.session.set(f.claimPayload()), error => error === originalError);
    const final = f.stop(); complete(final); assert.equal(inspected, 0);
    assert.equal(JSON.stringify(final).includes("foreign-secret"), false); assert.equal(final.current.claims[0].markerId, null);
    assert.equal(final.gate.released, false, "There was no held success to release");
  }
});

test("unobservable native return is passed through but makes evidence explicitly incomplete", () => {
  const nativeValue = { nonPromise: true }, f = fixture({ native: () => nativeValue }); f.deleting();
  assert.equal(f.chrome.storage.session.set(f.claimPayload()), nativeValue); assert.equal(f.calls.length, 1);
  assert.match(f.stop().errors[0], /observable native Promise/);
});

test("hold expiry releases publication while retaining a failure, rather than silently passing", async () => {
  const f = fixture({ options: { holdTimeoutMs: 20000 } }); f.deleting();
  const pending = f.chrome.storage.session.set(f.claimPayload()); await until(() => f.snapshot().gate.held, "timed hold");
  assert.equal([...f.timers.values()][0].ms, 20000); [...f.timers.values()][0].fn(); await pending;
  const final = f.stop(); assert.equal(final.gate.timedOut, true); assert.equal(final.gate.releaseReason, "timeout");
  assert.match(final.errors[0], /hold expired/); assert.equal(final.gate.published, true); assert.equal(f.calls.length, 1);
});

test("early release cannot invent native settlement and prevents a later publication hold", async () => {
  const native = deferred(), f = fixture({ native: () => native.promise }); f.deleting();
  const pending = f.chrome.storage.session.set(f.claimPayload()); f.api.release();
  assert.equal(f.snapshot().gate.nativeSettled, false); assert.equal(f.snapshot().gate.published, false);
  native.resolve(7); assert.equal(await pending, 7);
  const final = f.stop(); complete(final); assert.equal(final.records.some(row => row.kind === "held"), false);
});

test("stop releases a held producer but preserves incomplete evidence until a real fresh worker", async () => {
  const f = fixture(); f.deleting(); const pending = f.chrome.storage.session.set(f.claimPayload());
  await until(() => f.snapshot().gate.held, "stop hold"); const stopped = f.stop();
  assert.equal(stopped.restored, true); assert.equal(stopped.apiRemoved, true); assert.equal(stopped.gate.releaseReason, "stop");
  assert.match(stopped.errors[0], /before original storage\/publication/); await pending;
  assert.deepEqual(f.snapshot(), stopped, "Late continuation must not rewrite saved stop-time evidence");
  assert.equal(Object.hasOwn(createContext({}), "__auxiliaryDeliveryGate"), false);
});

test("stop before native settlement does not abort, replay or mislabel the native operation", async () => {
  const native = deferred(), f = fixture({ native: () => native.promise }); f.deleting();
  const pending = f.chrome.storage.session.set(f.claimPayload()), stopped = f.stop();
  assert.equal(stopped.gate.nativeSettled, false); assert.equal(stopped.pendingOperations[0].nativePending, true);
  assert.match(stopped.errors[0], /before original/); native.resolve(1); assert.equal(await pending, 1); assert.equal(f.calls.length, 1);
});

test("restoration preserves exact own descriptors or inherited methods", () => {
  for (const inherited of [false, true]) {
    const f = fixture({ inherited }); const final = f.stop(); complete(final);
    for (const patch of f.patches) {
      assert.deepEqual(Object.getOwnPropertyDescriptor(patch.object, "set"), patch.descriptor);
      assert.equal(patch.object.set, patch.original);
    }
    assert.deepEqual(f.stop(), final);
  }
});

test("identity-safe stop never overwrites a successor wrapper or deletes a successor API", () => {
  const f = fixture(), replacement = () => Promise.resolve(); f.chrome.storage.session.set = replacement;
  const successor = {}; Object.defineProperty(f.context, "__auxiliaryDeliveryGate", { value: successor, configurable: true });
  const stopped = f.stop(); assert.equal(stopped.restored, false); assert.equal(stopped.apiRemoved, false);
  assert.equal(f.chrome.storage.session.set, replacement); assert.equal(f.context.__auxiliaryDeliveryGate, successor);
  assert.equal(stopped.errors.length, 2); assert.match(stopped.errors.join(" "), /replaced before stop/);
});

test("partially failed installation restores the earlier wrapper and never calls native storage", () => {
  const f = fixture({ install: false });
  const actualLocal = f.chrome.storage.local;
  f.chrome.storage.local = new Proxy(actualLocal, { defineProperty() { throw Error("installation denied"); } });
  assert.throws(f.doInstall, /installation denied/);
  for (const patch of f.patches) assert.equal(patch.object.set, patch.original);
  assert.equal(Object.hasOwn(f.context, "__auxiliaryDeliveryGate"), false); assert.equal(f.calls.length, 0);
});

test("record and byte caps are explicit failures while native calls still happen exactly once", async () => {
  for (const options of [{ maxRecords: 1 }, { maxBytes: 1 }]) {
    const f = fixture({ options }); f.deleting(); const pending = f.chrome.storage.session.set(f.claimPayload());
    await until(() => f.snapshot().gate.held, "bounded hold"); f.api.release(); await pending;
    for (let index = 0; index < 4; index++) await f.chrome.storage.session.set(f.claimPayload());
    const final = f.stop(); assert.equal(f.calls.length, 5); assert.equal(final.overflow, true);
    assert.ok(final.records.length <= final.maxRecords); assert.ok(final.bytes <= final.maxBytes); assert.deepEqual(final.pendingOperations, []);
  }
});

test("actual pending-operation inventory is capped without suppressing storage operations", async () => {
  const native = deferred(), f = fixture({ options: { maxRecords: 2 }, native: () => native.promise }); f.deleting();
  const calls = Array.from({ length: 6 }, () => f.chrome.storage.session.set(f.claimPayload()));
  assert.equal(f.calls.length, 6); assert.equal(f.snapshot().pendingOperations.length, 2); assert.equal(f.snapshot().overflow, true);
  f.api.release(); native.resolve(3); assert.deepEqual(await Promise.all(calls), [3, 3, 3, 3, 3, 3]);
  assert.equal(f.stop().pendingOperations.length, 0);
});

test("installation copies scope and tab selection so later caller mutation cannot retarget the gate", async () => {
  const f = fixture(); f.ending(); Object.assign(f.config.scope, { session_id: "foreign", turn_id: "other", control_epoch: 30 });
  f.config.tabIds.push(99); f.config.stage = "marker-write"; f.config.gateTabId = 10;
  f.deleting(); const pending = f.chrome.storage.session.set(f.claimPayload());
  await until(() => f.snapshot().gate.held, "original selection");
  assert.deepEqual(f.snapshot().tabIds, [8, 10]); assert.equal(f.snapshot().scope.session_id, "task");
  f.api.release(); await pending; complete(f.stop());
});

test("invalid scope, claims, options or an existing observer are rejected before any mutation", () => {
  const changes = [
    f => f.config.holdTimeoutMs = 0, f => f.config.holdTimeoutMs = 30001, f => f.config.maxRecords = 0,
    f => f.config.maxBytes = 4194305, f => f.config.stage = "unknown", f => f.config.extra = true,
    f => f.config.tabIds = [8, 8], f => f.config.gateTabId = 10, f => f.config.scope.control_epoch = 0,
    f => f.config.scope.extra = "foreign", f => f.claims[0].phase = "quarantined",
    f => f.states.get(f.claims[0]).persisted = false, f => f.claims[0].session_id = "foreign",
    f => f.ledger.status = "closing", f => f.backend.endingSessions.set("task", {}),
    f => f.context.__auxiliaryDeliveryGate = {}
  ];
  for (const change of changes) {
    const f = fixture({ install: false }); change(f); assert.throws(f.doInstall, /auxiliary|Auxiliary/);
    assert.equal(f.calls.length, 0); for (const patch of f.patches) assert.equal(patch.object.set, patch.original);
  }
});

async function realPair(t) {
  const f = await backendFixture(t), originalAttach = f.backend.browserEngine.attach;
  f.backend.browserEngine.attach = async tabId => { await originalAttach(tabId); await f.backend.registerEngineAttachment(tabId); };
  await f.backend.claimUserTab(f.params);
  f.frameRecords.set(8, [{ frameId: 0, parentFrameId: -1, documentId: "source-popup", url: f.tabs.get(8).url }]);
  f.tabs.set(10, { id: 10, groupId: -1, windowId: 1, url: "https://fixture.test/child", active: false });
  const waiter = await f.backend.armPageWait({ ...f.params, timeoutMs: 2000 });
  f.chrome.webNavigation.onCreatedNavigationTarget.emit({ sourceTabId: 8, sourceFrameId: 0,
    sourceProcessId: 4, tabId: 10, url: f.tabs.get(10).url, timeStamp: 1 });
  assert.equal((await f.backend.collectPageWait({ ...f.params, waiterId: waiter.waiterId })).tabId, 10);
  await f.backend.cancelPageWait({ ...f.params, waiterId: waiter.waiterId });
  f.backend.browserEngine = undefined;
  return f;
}

for (const stage of ["claim-delete", "marker-write"]) test(`real Backend ${stage} gate observes native storage ACK before finalizer publication`, async t => {
  const f = await realPair(t), target = {}, { session_id, turn_id, control_epoch } = f.params;
  const scope = { session_id, turn_id, control_epoch }, originals = [8, 10].map(id => f.backend.auxiliaryTabs.entry(id));
  installAuxiliaryDeliveryGate(f.backend, f.chrome, target, { scope, tabIds: [8, 10], stage,
    ...(stage === "claim-delete" ? { gateTabId: 8 } : {}), holdTimeoutMs: 1000 });
  const api = target.__auxiliaryDeliveryGate; let settled = false;
  const ending = f.backend.finalizeTabs({ ...scope, keep: [8, 10].map(tabId => ({ tabId, status: "deliverable" })) })
    .then(value => ({ value }), error => ({ error })).finally(() => { settled = true; });
  try {
    await until(() => api.snapshot().gate?.held, `${stage} actual backend write`);
    const held = plain(api.snapshot()); assert.equal(settled, false); assert.equal(held.gate.nativeSettled, true);
    assert.equal(held.errors.length, 0); assert.equal(held.overflow, false);
    if (stage === "claim-delete") {
      assert.deepEqual(f.session[AUX].records.filter(record => [8, 10].includes(record.tabId)).map(record => record.tabId), [10]);
      assert.equal(f.backend.auxiliaryTabs.entry(8), originals[0]);
      assert.equal(f.backend.auxiliaryTabs.state(originals[0]).removing, true);
      assert.equal(f.backend.auxiliaryTabs.entry(10), originals[1]);
      assert.equal(f.local[STATE].deliverableTabs?.[8], undefined);
    } else {
      assert.ok(f.local[STATE].deliverableTabs[8]?.deliveryId); assert.ok(f.local[STATE].deliverableTabs[10]?.deliveryId);
      assert.equal(f.backend.auxiliaryTabs.entry(8), undefined); assert.equal(f.backend.auxiliaryTabs.entry(10), undefined);
      assert.equal(held.current.finalizing, true);
    }
    const current = await f.backend.getControlState({ session_id }); assert.equal(current.closing, true);
    await assert.rejects(f.backend.getTabs({ session_id, turn_id: current.nextTurnId, control_epoch: current.controlEpoch }), /OBU_CONTROL_ENDING/);
    api.release(); const result = await ending; assert.equal(result.error, undefined);
    for (const id of [8, 10]) {
      assert.equal(f.backend.auxiliaryTabs.entry(id), undefined); assert.ok(f.local[STATE].deliverableTabs[id]);
      assert.equal(f.tabs.get(id).windowId, originals.find(record => record.tabId === id).windowId);
    }
    complete(plain(api.stop()));
  } finally { api.release(); await ending; api.stop(); }
});
