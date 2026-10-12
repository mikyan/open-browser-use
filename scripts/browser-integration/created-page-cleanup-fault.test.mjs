import assert from "node:assert/strict";
import test from "node:test";
import { createContext, runInContext } from "node:vm";
import { installCreatedPageCleanupFault } from "./created-page-cleanup-fault.mjs";
import { installCreatedPageAdoptionObserver } from "./created-page-adoption-observer.mjs";
import { fixture as backendFixture } from "../../apps/chrome-extension/test-support/page-waits-fixture.mjs";

// Native methods below are simulations. These tests prove the injector's
// selection, transparency and evidence boundaries, not an actual Chrome quota.
const KEY = "OPEN_BROWSER_USE_AUXILIARY_TABS", TEST_KEY = "__OBU_TEST_CLEANUP_QUOTA_12345678";
const plain = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function fixture({ options = {}, native, beforeInstall, inherited = false, install = true } = {}) {
  const calls = [], claim = { tabId: 8, claimId: "original-claim", session_id: "task", turn_id: "turn", control_epoch: 3,
    windowId: 2, kind: "created-page", origin: "user", phase: "committed" };
  const record = { params: { session_id: "task", turn_id: "turn", control_epoch: 3, tabId: 7 }, state: "matched",
    deadlineAt: 20000, result: { tabId: 8 }, pageAdmission: claim };
  const claimState = { persisted: true, removing: false }, entries = new Map([[8, claim]]);
  const backend = { browserLifetime: { incarnation: "original-browser" },
    pageWaits: { records: new Map([["wait", record]]), byTab: new Map([[7, record]]), now: () => 1000 },
    auxiliaryTabs: { entry: id => entries.get(id), state: value => value === claim ? claimState : undefined } };
  const original = function (...args) {
    const call = { receiver: this, args }; calls.push(call);
    call.error = Error("simulated native quota rejection");
    const result = native ? native(call) : Object.hasOwn(args[0], TEST_KEY) ? Promise.reject(call.error) : Promise.resolve("native acknowledgement");
    call.result = result; return result;
  };
  const owner = {};
  Object.defineProperty(owner, "set", { value: original, writable: true, configurable: true, enumerable: false });
  const storage = inherited ? Object.create(owner) : owner;
  storage.QUOTA_BYTES = 128;
  const chrome = { storage: { session: storage } }, descriptor = Object.getOwnPropertyDescriptor(storage, "set");
  const config = { waiterId: "wait", childId: 8, claimId: claim.claimId, testKey: TEST_KEY, ...options };
  const context = createContext({ backend, chrome, Date, TextEncoder });
  beforeInstall?.({ backend, chrome, record, claim, claimState, context, config });
  const installFault = () => plain(runInContext(`(${installCreatedPageCleanupFault.toString()})(backend,chrome,globalThis,${JSON.stringify(config)})`, context));
  const installed = install ? installFault() : null, api = context.__createdPageCleanupFault;
  const payload = (records = [{ tabId: 9, claimId: "foreign-claim", session_id: "other" }]) =>
    ({ [KEY]: { version: 4, incarnation: "original-browser", records } });
  const removing = () => {
    record.invalid = true; record.state = "failed"; record.cleanupAttempts = 1; record.cleanupSettled = false;
    claim.phase = "quarantined"; claimState.removing = true;
  };
  return { backend, chrome, storage, record, claim, claimState, entries, calls, descriptor, original, context, config, installed, api,
    installFault, payload, removing, snapshot: () => plain(api.snapshot()), stop: () => plain(api.stop()) };
}
function complete(snapshot) {
  assert.equal(snapshot.closed, true); assert.equal(snapshot.enabled, false);
  assert.equal(snapshot.restored, true); assert.equal(snapshot.apiRemoved, true);
  assert.equal(snapshot.overflow, false); assert.deepEqual(snapshot.errors, []);
  assert.equal(snapshot.pendingCount, 0); assert.deepEqual(snapshot.pendingAttempts, []);
  assert.equal(snapshot.bytes, snapshot.records.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row)), 0));
  snapshot.records.forEach((row, index) => assert.equal(row.sequence, index + 1));
  for (const row of snapshot.records.filter(row => row.kind === "call")) {
    const outcomes = snapshot.records.filter(item => item.attemptId === row.attemptId && item.kind !== "call");
    assert.equal(outcomes.length, 1); assert.equal(outcomes[0].injected, row.injected); assert.ok(outcomes[0].sequence > row.sequence);
  }
}

test("serialized injector reaches the original method with exact receiver/Promise and only adds quota padding", async () => {
  const f = fixture(); assert.equal(f.calls.length, 0, "Installation never calls storage");
  assert.equal(f.installed.paddingBytes, f.storage.QUOTA_BYTES + 1024);
  f.removing(); const payload = f.payload(), before = plain(payload), receiver = { nativeReceiver: true };
  const actual = Reflect.apply(f.storage.set, receiver, [payload]), call = f.calls[0];
  assert.equal(actual, call.result); assert.equal(call.receiver, receiver);
  assert.notEqual(call.args[0], payload); assert.equal(call.args[0][KEY], payload[KEY]);
  assert.deepEqual(Object.keys(call.args[0]), [KEY, TEST_KEY]);
  assert.equal(call.args[0][TEST_KEY].length, f.storage.QUOTA_BYTES + 1024);
  assert.deepEqual(payload, before); assert.equal(Object.hasOwn(payload, TEST_KEY), false);
  await assert.rejects(actual, error => error === call.error);
  const snapshot = f.stop(); complete(snapshot);
  assert.equal(snapshot.attempts, 1); assert.equal(snapshot.injectedAttempts, 1);
  assert.deepEqual(snapshot.records.map(row => row.kind), ["call", "rejected"]);
  assert.equal(snapshot.records[1].error.message, call.error.message);
  assert.equal(snapshot.records[0].state.noReplacement, true); assert.equal(snapshot.records[0].state.removing, true);
  assert.equal(snapshot.records[0].state.remainingMs, 19000);
  assert.ok(!JSON.stringify(snapshot).includes("q".repeat(100)), "Evidence does not retain large padding");
  assert.deepEqual(Object.getOwnPropertyDescriptor(f.storage, "set"), f.descriptor);
  assert.equal(Object.hasOwn(f.context, "__createdPageCleanupFault"), false);
  assert.deepEqual(f.stop(), snapshot);
});

test("fault persists until disable; recovery remains an observed unchanged native write", async () => {
  const f = fixture(); f.removing();
  await assert.rejects(f.storage.set(f.payload()), /simulated native/);
  await assert.rejects(f.storage.set(f.payload()), /simulated native/);
  assert.equal(f.snapshot().enabled, true); assert.equal(f.snapshot().injectedAttempts, 2);
  assert.equal(f.api.disable().enabled, false);
  const payload = f.payload(), result = f.storage.set(payload), call = f.calls.at(-1);
  assert.equal(call.args[0], payload); assert.equal(call.receiver, f.storage); assert.equal(result, call.result);
  assert.equal(await result, "native acknowledgement");
  const snapshot = f.stop(); complete(snapshot);
  assert.equal(snapshot.attempts, 3); assert.equal(snapshot.injectedAttempts, 2);
  assert.equal(snapshot.records.at(-2).injected, false); assert.equal(snapshot.records.at(-2).args.paddingBytes, 0);
  assert.equal(snapshot.records.at(-1).kind, "fulfilled"); assert.equal(snapshot.records.at(-1).injected, false);
});

test("unrelated writes, retained claims and callback arguments pass through by identity", async () => {
  const f = fixture(); f.removing();
  const callback = () => {}, calls = [[{ unrelated: 1 }], [f.payload([f.claim])], [f.payload([{ ...f.claim, claimId: "other" }])],
    [f.payload([{ ...f.claim, tabId: 90 }])], [f.payload(), callback]];
  for (const args of calls) {
    const result = Reflect.apply(f.storage.set, f.storage, args), original = f.calls.at(-1);
    args.forEach((value, index) => assert.equal(original.args[index], value));
    assert.equal(result, original.result); await result;
  }
  assert.equal(f.snapshot().attempts, 0); complete(f.stop());
});

for (const [name, mutate] of [
  ["not invalid", f => { f.record.invalid = false; }],
  ["delivered", f => { f.record.delivered = true; }],
  ["not removing", f => { f.claimState.removing = false; }],
  ["not persisted", f => { f.claimState.persisted = false; }],
  ["not quarantined", f => { f.claim.phase = "committed"; }],
  ["record replacement", f => { f.backend.pageWaits.records.set("wait", { ...f.record }); }],
  ["claim replacement", f => { f.entries.set(8, { ...f.claim }); }],
  ["browser replacement", f => { f.backend.browserLifetime.incarnation = "replacement"; }],
  ["scope mutation", f => { f.record.params.control_epoch++; }],
  ["deadline mutation", f => { f.record.deadlineAt++; }],
]) test(`${name} cannot receive the original claim's injected fault`, async () => {
  const f = fixture(); f.removing(); mutate(f);
  const payload = f.payload(), actual = f.storage.set(payload);
  assert.equal(f.calls[0].args[0], payload); assert.equal(actual, f.calls[0].result); await actual;
  assert.equal(f.snapshot().attempts, 0); complete(f.stop());
});

test("wrong browser snapshot and malformed storage data do not broaden fault selection", async () => {
  const f = fixture(); f.removing();
  const values = [f.payload(), f.payload(), f.payload(), f.payload()];
  values[0][KEY].incarnation = "foreign-browser"; values[1][KEY].version = 3;
  values[2][KEY].records = [null]; values[3][KEY].records = [{ tabId: 9 }];
  for (const value of values) { await f.storage.set(value); assert.equal(f.calls.at(-1).args[0], value); }
  assert.equal(f.snapshot().attempts, 0); complete(f.stop());
});

test("pending native result is never replaced, gated, retried or fabricated as rejection", async () => {
  const native = Promise.withResolvers(), f = fixture({ native: () => native.promise }); f.removing();
  const actual = f.storage.set(f.payload()); assert.equal(actual, native.promise);
  let snapshot = f.snapshot(); assert.equal(snapshot.pendingCount, 1); assert.deepEqual(snapshot.pendingAttempts, [1]);
  assert.deepEqual(snapshot.records.map(row => row.kind), ["call"]);
  f.api.disable(); assert.equal(f.calls.length, 1); native.resolve("unexpected native success");
  assert.equal(await actual, "unexpected native success"); snapshot = f.stop();
  assert.equal(snapshot.pendingCount, 0); assert.equal(snapshot.restored, true); assert.equal(snapshot.apiRemoved, true);
  assert.match(snapshot.errors.join(" "), /unexpectedly fulfilled/);
  assert.equal(snapshot.records.at(-1).kind, "fulfilled", "Unexpected native success stays visible for the real scene to reject");
  assert.equal(snapshot.records.at(-1).injected, true);
});

test("original synchronous exceptions retain identity; non-Promise results are not native acknowledgements", () => {
  const failure = Error("original synchronous exception"), f = fixture({ native: () => { throw failure; } }); f.removing();
  assert.throws(() => f.storage.set(f.payload()), error => error === failure);
  const stopped = f.stop(); complete(stopped); assert.equal(stopped.records.at(-1).kind, "threw");
  const nonPromise = fixture({ native: () => 17 }); nonPromise.removing();
  assert.equal(nonPromise.storage.set(nonPromise.payload()), 17);
  const snapshot = nonPromise.stop(); assert.equal(snapshot.records.at(-1).kind, "settlement-unobserved");
  assert.equal(snapshot.pendingCount, 0); assert.match(snapshot.errors.join(" "), /observable native Promise/);
});

test("bounded evidence overflow keeps quota injection active until explicit disable", async () => {
  for (const options of [{ maxAttempts: 1 }, { maxRecords: 1 }, { maxBytes: 1 }]) {
    const f = fixture({ options }); f.removing();
    for (let index = 0; index < 3; index++) await assert.rejects(f.storage.set(f.payload()), /simulated native/);
    const snapshot = f.snapshot(); assert.equal(snapshot.enabled, true); assert.equal(snapshot.overflow, true);
    assert.equal(snapshot.attempts, 3); assert.equal(snapshot.injectedAttempts, 3); assert.equal(snapshot.pendingCount, 0);
    assert.ok(snapshot.records.length <= snapshot.maxRecords && snapshot.bytes <= snapshot.maxBytes);
    assert.ok(snapshot.pendingAttempts.length <= snapshot.maxAttempts);
    f.api.disable(); const payload = f.payload(); await f.storage.set(payload); assert.equal(f.calls.at(-1).args[0], payload);
    assert.equal(f.stop().restored, true);
  }
});

test("inspection errors do not execute argument getters or turn unrelated calls into fabricated failures", async () => {
  const f = fixture(); f.removing(); let reads = 0;
  const value = {}; Object.defineProperty(value, KEY, { enumerable: true, get() { reads++; throw Error("getter must not run"); } });
  await f.storage.set(value); assert.equal(reads, 0); assert.equal(f.calls[0].args[0], value);
  const collision = { ...f.payload(), [TEST_KEY]: "pre-existing argument" };
  await assert.rejects(f.storage.set(collision), /simulated native/);
  assert.equal(f.calls[1].args[0], collision); assert.equal(f.snapshot().attempts, 0);
  const snapshot = f.stop(); assert.match(snapshot.errors.join(" "), /accessor.*already exists/);
});

test("restoration is LIFO, preserves inherited descriptors and never removes a replacement API", () => {
  const inherited = fixture({ inherited: true }); assert.equal(Object.hasOwn(inherited.storage, "set"), true);
  complete(inherited.stop()); assert.equal(Object.hasOwn(inherited.storage, "set"), false); assert.equal(inherited.storage.set, inherited.original);
  const f = fixture(), replacement = () => Promise.resolve(); f.storage.set = replacement;
  Object.defineProperty(f.context, "__createdPageCleanupFault", { value: "replacement", configurable: true });
  const snapshot = f.stop(); assert.equal(snapshot.restored, false); assert.equal(snapshot.apiRemoved, false);
  assert.equal(f.storage.set, replacement); assert.equal(f.context.__createdPageCleanupFault, "replacement");
  assert.match(snapshot.errors.join(" "), /reverse order.*API replaced/);
});

test("stopping pending work restores methods but retains incomplete evidence and does not settle native work", async () => {
  const native = Promise.withResolvers(), f = fixture({ native: () => native.promise }); f.removing();
  const actual = f.storage.set(f.payload()), snapshot = f.stop();
  assert.equal(snapshot.pendingCount, 1); assert.match(snapshot.errors.join(" "), /before 1 original storage/);
  assert.equal(f.storage.set, f.original); assert.equal(Object.hasOwn(f.context, "__createdPageCleanupFault"), false);
  native.resolve(); await actual; assert.deepEqual(f.snapshot(), snapshot);
});

test("invalid installation and a failed target definition leave original methods intact", () => {
  for (const options of [{ maxAttempts: 0 }, { maxBytes: 0 }, { testKey: KEY }, { childId: 9 }]) {
    const f = fixture({ options, install: false }); assert.throws(f.installFault, /Invalid/);
    assert.equal(f.storage.set, f.original); assert.equal(Object.hasOwn(f.context, "__createdPageCleanupFault"), false);
  }
  const f = fixture(); assert.throws(f.installFault, /Invalid/); complete(f.stop());
  const g = fixture({ install: false }), target = new Proxy({}, { defineProperty() { throw Error("fixture denied target definition"); } });
  assert.throws(() => installCreatedPageCleanupFault(g.backend, g.chrome, target, g.config), /denied target/);
  assert.deepEqual(Object.getOwnPropertyDescriptor(g.storage, "set"), g.descriptor);
  let reads = 0;
  const accessor = fixture({ install: false, beforeInstall: ({ chrome }) => {
    Object.defineProperty(chrome.storage.session, "set", { get() { reads++; return () => {}; }, configurable: true });
  } });
  assert.throws(accessor.installFault, /Cannot wrap/); assert.equal(reads, 0);
});

test("actual backend cleanup selects the exact removal and recovers after a simulated native quota rejection", async t => {
  const f = await backendFixture(t), scope = { ...f.params, tabId: 7 };
  const originalSet = f.chrome.storage.session.set, adoptionTarget = {};
  installCreatedPageAdoptionObserver(f.backend, f.chrome, adoptionTarget, { sessions: [scope.session_id] });
  const adoptionSet = f.chrome.storage.session.set, adoption = adoptionTarget.__createdPageAdoption;
  const waiter = await f.backend.armPageWait({ ...scope, timeoutMs: 20000 });
  const record = f.backend.pageWaits.records.get(waiter.waiterId);
  f.chrome.webNavigation.onCreatedNavigationTarget.emit({ sourceTabId: 7, sourceFrameId: 0, sourceProcessId: 4, tabId: 8, url: f.tabs.get(8).url });
  await record.completion.promise;
  const claim = f.backend.auxiliaryTabs.owner(8), target = {};
  f.chrome.storage.session.QUOTA_BYTES = 128;
  f.hooks.write = async (area, values) => {
    if (area === "session" && Object.hasOwn(values, TEST_KEY)) throw Error("fixture native quota rejection; no real browser");
  };
  installCreatedPageCleanupFault(f.backend, f.chrome, target, { waiterId: waiter.waiterId, childId: 8, claimId: claim.claimId, testKey: TEST_KEY });
  const api = target.__createdPageCleanupFault;
  try {
    await assert.rejects(f.backend.turnEnded(scope), /fixture native quota rejection/); await tick();
    let snapshot = plain(api.snapshot()); assert.ok(snapshot.injectedAttempts >= 1);
    assert.equal(snapshot.current.cleanupSettled, true); assert.equal(snapshot.current.cleaned, false);
    assert.equal(snapshot.current.claimPhase, "quarantined"); assert.equal(snapshot.current.noReplacement, true);
    assert.equal(f.session[KEY].records.some(value => value.claimId === claim.claimId), true);
    assert.equal(Object.hasOwn(f.session, TEST_KEY), false);
    api.disable(); const fresh = await f.backend.getControlState({ session_id: "task" }); await tick();
    assert.equal(fresh.closing, false); assert.equal(record.cleaned, true); assert.ok(record.cleanupAttempts >= 2);
    assert.equal(f.backend.auxiliaryTabs.entry(8), undefined);
    assert.equal(f.session[KEY].records.some(value => value.claimId === claim.claimId), false);
    snapshot = plain(api.stop()); complete(snapshot);
    assert.ok(snapshot.records.some(row => row.kind === "fulfilled" && !row.injected));
    assert.equal(snapshot.current.noReplacement, true); assert.equal(snapshot.current.claimPresent, false);
    assert.equal(f.chrome.storage.session.set, adoptionSet, "Fault stop restores the previous observer layer");
    assert.equal(Object.hasOwn(target, "__createdPageCleanupFault"), false);
    const adoptionStopped = adoption.stop(); assert.equal(adoptionStopped.restored, true); assert.deepEqual(adoptionStopped.errors, []);
    assert.equal(f.chrome.storage.session.set, originalSet);
  } finally { api.disable(); api.stop(); adoption.stop(); delete f.hooks.write; await f.backend.pageWaits.retryFailedCleanup(); }
});
