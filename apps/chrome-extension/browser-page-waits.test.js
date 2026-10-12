import assert from "node:assert/strict";
import test from "node:test";
import { BrowserPageWaits } from "./browser-page-waits.js";

const params = { session_id: "first", turn_id: "turn-1", control_epoch: 1, tabId: 10, timeoutMs: 1000 };
const root = { frameId: 0, parentFrameId: -1, documentId: "root-original", processId: 100, documentLifecycle: "active" };
const child = { frameId: 2, parentFrameId: 0, documentId: "child-original", processId: 102, documentLifecycle: "active" };
const event = (tabId = 20, sourceFrameId = 0) => ({ sourceTabId: 10, sourceFrameId, sourceProcessId: sourceFrameId + 100, tabId, url: "https://same.example/", timeStamp: -10 });
const gate = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); promise.catch(() => {}); return { promise, resolve, reject }; };
const flush = async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); };

function setup(overrides = {}, options = {}) {
  let now = 100, nextId = 0, timerId = 0; const timers = new Map(), log = [], values = [root, child];
  const waits = new BrowserPageWaits({ now: () => now, createId: () => `wait-${++nextId}`,
    setTimer: (fn, delay) => { const id = ++timerId; timers.set(id, { at: now + delay, fn }); return id; }, clearTimer: id => timers.delete(id),
    assertScope: scope => { assert.equal(scope.attachment, "original"); }, validateScope: async scope => { log.push(["validate", scope]); },
    snapshotFrames: async () => structuredClone(values), adopt: async (scope, native, record) => { log.push(["adopt", native.tabId]); waits.check(record); return { tabId: native.tabId }; },
    release: async record => { log.push(["release", record.waiterId]); }, ...overrides, ...options });
  const reserve = (request = params) => { const record = waits.reserve(request); waits.bind(record, { ...Object.fromEntries(Object.entries(request).filter(([key]) => key !== "timeoutMs")), attachment: "original" }); return record; };
  const handle = record => ({ ...Object.fromEntries(Object.entries(record.params).filter(([key]) => key !== "timeoutMs")), waiterId: record.waiterId });
  return { waits, log, values, timers, reserve, handle, get now() { return now; }, set now(value) { now = value; },
    tick(ms) { now += ms; for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); } } };
}

test("ready precedes eligible native events, first exact child wins and one collect consumes original handle", async () => {
  const state = setup(), record = state.reserve(); state.waits.observe(event(19));
  assert.equal(record.candidate, undefined); const ack = await state.waits.arm(record); assert.deepEqual(ack, { waiterId: record.waiterId, remainingMs: 1000 });
  await state.waits.barrier(record); state.waits.observe(event(20)); state.waits.observe(event(21));
  assert.equal(record.candidate.tabId, 20); assert.equal(record.state, "matching");
  assert.deepEqual(await state.waits.collect(state.handle(record)), { tabId: 20 });
  assert.deepEqual(state.log.filter(row => row[0] === "adopt"), [["adopt", 20]]);
  await assert.rejects(state.waits.collect(state.handle(record)), /EXPIRED/); assert.deepEqual(await state.waits.cancel(state.handle(record)), {});
  assert.equal(state.log.some(row => row[0] === "release"), false); assert.deepEqual(state.waits.controlSnapshot(), { tabIds: [], pending: [] });
});

test("one waiter per source and exact immutable session/turn/epoch/tab identity", async () => {
  const state = setup(), request = { ...params }, record = state.reserve(request); request.tabId = 999;
  assert.throws(() => state.waits.reserve({ ...params, session_id: "second" }), /LIMIT/); await state.waits.arm(record);
  for (const changed of [{ session_id: "second" }, { turn_id: "successor" }, { control_epoch: 2 }, { tabId: 11 }]) {
    const foreign = { ...state.handle(record), ...changed }; assert.throws(() => state.waits.lookup(foreign), /EXPIRED/); assert.deepEqual(await state.waits.cancel(foreign), {});
  }
  state.waits.observe({ ...event(), sourceTabId: 11 }); state.waits.observe(event(20, 9)); assert.equal(record.candidate, undefined);
  assert.equal(record.params.tabId, 10); await state.waits.cancel(state.handle(record));
});

test("request/handle shape, UTF-8 bounds and total/session capacity reject before admitting work", async () => {
  const state = setup({}, { maxTotal: 2, maxPerSession: 1 });
  for (const changed of [{ timeoutMs: null }, { timeoutMs: 0 }, { timeoutMs: 120001 }, { control_epoch: undefined }, { control_epoch: 0 }, { tabId: -1 }, { extra: true }, { session_id: "汉".repeat(1400) }]) assert.throws(() => state.waits.reserve({ ...params, ...changed }));
  const first = state.reserve(); assert.throws(() => state.waits.reserve({ ...params, tabId: 11 }), /LIMIT/);
  const second = state.reserve({ ...params, session_id: "second", tabId: 11 }); assert.throws(() => state.waits.reserve({ ...params, session_id: "third", tabId: 12 }), /LIMIT/);
  for (const handle of [{ ...state.handle(first), waiterId: "" }, { ...state.handle(first), timeoutMs: 1 }, { ...state.handle(first), waiterId: "x".repeat(129) }]) assert.throws(() => state.waits.validateHandle(handle));
  await state.waits.cancel(state.handle(first)); await state.waits.cancel(state.handle(second)); state.tick(30000); assert.equal(state.waits.records.size, 0);
});

test("future frame first document is eligible under original root; existing navigation cannot silently replace it", async () => {
  const state = setup(), record = state.reserve(); await state.waits.arm(record);
  const dynamic = { ...child, frameId: 4, documentId: "new-frame-first", processId: 104 };
  state.waits.navigation("onBeforeNavigate", { tabId: 10, frameId: 4 }); state.waits.navigation("onCommitted", { tabId: 10, ...dynamic }); state.values.push(dynamic);
  state.waits.observe(event(20, 4)); assert.deepEqual(await state.waits.collect(state.handle(record)), { tabId: 20 });
  const second = state.reserve(); await state.waits.arm(second);
  state.waits.navigation("onBeforeNavigate", { tabId: 10, frameId: 2 }); state.waits.navigation("onCommitted", { tabId: 10, ...child, documentId: "successor" });
  state.waits.observe(event(21, 2)); assert.equal(second.candidate, undefined);
  state.waits.observe(event(22)); assert.deepEqual(await state.waits.collect(state.handle(second)), { tabId: 22 });
});

test("source root navigation and child close/move invalidation fail original candidate without adopting replacement", async () => {
  for (const change of [state => state.waits.navigation("onBeforeNavigate", { tabId: 10, frameId: 0 }), state => state.waits.invalidateTab(20)]) {
    const admitted = gate(), state = setup({ adopt: async () => admitted.promise }), record = state.reserve(); await state.waits.arm(record);
    state.waits.observe(event(20)); await flush(); change(state); state.waits.observe(event(21));
    await assert.rejects(state.waits.collect(state.handle(record)), /SOURCE_CHANGED|EXPIRED/); admitted.resolve({ tabId: 20 }); await state.waits.drain(record);
    assert.equal(record.candidate.tabId, 20); assert.equal(record.cleaned, true);
  }
});

test("navigation between matched adoption and collect is revalidated before result delivery", async () => {
  const state = setup(), record = state.reserve(); await state.waits.arm(record); state.waits.observe(event(20, 2)); await flush();
  await record.completion.promise; assert.equal(record.state, "matched");
  state.values[1] = { ...child, documentId: "late-replacement" };
  await assert.rejects(state.waits.collect(state.handle(record)), /SOURCE_CHANGED/); await state.waits.drain(record);
  assert.equal(state.log.filter(row => row[0] === "release").length, 1);
});

test("interleaved native navigation invalidates versioned readiness snapshot rather than publishing a mixed document", async () => {
  const snapshot = gate(), state = setup({ snapshotFrames: () => snapshot.promise }), record = state.reserve();
  const arm = state.waits.arm(record); await flush(); state.waits.navigation("onCommitted", { tabId: 10, ...root }); snapshot.resolve([root, child]);
  await assert.rejects(arm, /SOURCE_CHANGED/); await state.waits.drain(record); assert.equal(record.armed, undefined);
});

test("original deadline covers a late adoption ACK even when timer dispatch has not run", async () => {
  const adoption = gate(), state = setup({ adopt: () => adoption.promise }), record = state.reserve(); await state.waits.arm(record);
  state.waits.observe(event()); await flush(); state.now += 1001; adoption.resolve({ tabId: 20 });
  await assert.rejects(state.waits.collect(state.handle(record)), /TIMEOUT/); await state.waits.drain(record);
  assert.equal(record.delivered, undefined); assert.equal(state.log.filter(row => row[0] === "release").length, 1);
});

test("a reserved foreign source grants no pause-detach authority while its real setup still drains", { timeout: 2000 }, async t => {
  const admission = gate(), state = setup();
  t.after(async () => { admission.resolve(); await state.waits.invalidateAll(); });
  const foreign = state.waits.reserve({ ...params, tabId: 999 });
  const actual = state.waits.within(foreign, () => admission.promise);
  actual.catch(() => {});
  const bound = state.reserve(); await state.waits.arm(bound); await flush();
  assert.equal(foreign.scope, undefined);
  assert.deepEqual(state.waits.controlSnapshot().tabIds, [10]);
  assert.ok(state.waits.controlSnapshot().pending.length > 0);
  let settled = false;
  const invalidated = state.waits.invalidateTab(999).then(() => { settled = true; });
  await assert.rejects(actual, /OBU_PAGE_WAIT_EXPIRED/); await flush();
  assert.equal(settled, false);
  assert.deepEqual(state.waits.controlSnapshot().tabIds, [10]);
  assert.ok(state.waits.controlSnapshot().pending.length > 0);
  assert.throws(() => state.waits.reserve({ ...params, tabId: 999 }), /LIMIT/);
  admission.resolve(); await invalidated;
  assert.equal(state.log.filter(row => row[0] === "release" && row[1] === foreign.waiterId).length, 1);
  assert.deepEqual(state.waits.controlSnapshot(), { tabIds: [10], pending: [] });
});

test("an unadmitted foreign candidate never grants pause-detach authority but retains its invalidation barrier", { timeout: 2000 }, async t => {
  const adoption = gate(); let adoptionCalls = 0;
  t.after(() => adoption.resolve({ tabId: 999 }));
  const state = setup({ adopt: () => { adoptionCalls++; return adoption.promise; } }), record = state.reserve();
  await state.waits.arm(record); state.waits.observe(event(999)); await flush();
  assert.equal(adoptionCalls, 1); assert.equal(record.candidate.tabId, 999); assert.equal(record.state, "matching");
  assert.deepEqual(state.waits.controlSnapshot().tabIds, [10]);
  assert.ok(state.waits.controlSnapshot().pending.length > 0);
  let settled = false;
  const invalidated = state.waits.invalidateTab(999, new Error("FOREIGN_CANDIDATE_REMOVED")).then(() => { settled = true; });
  await assert.rejects(state.waits.collect(state.handle(record)), /FOREIGN_CANDIDATE_REMOVED/);
  state.waits.observe(event(1000)); await flush();
  assert.equal(settled, false); assert.equal(record.candidate.tabId, 999); assert.equal(adoptionCalls, 1);
  assert.deepEqual(state.waits.controlSnapshot().tabIds, [10]);
  assert.equal(state.log.some(row => row[0] === "release"), false);
  adoption.resolve({ tabId: 999 }); await invalidated;
  assert.equal(state.log.filter(row => row[0] === "release").length, 1);
  assert.deepEqual(state.waits.controlSnapshot(), { tabIds: [], pending: [] });
});

test("cancel stops publication immediately but keeps real adoption and source reverse lock until its ACK and release", async () => {
  const adoption = gate(), state = setup({ adopt: () => adoption.promise }), record = state.reserve(); await state.waits.arm(record); state.waits.observe(event()); await flush();
  let settled = false; const cancelled = state.waits.cancel(state.handle(record)).then(() => { settled = true; }); await flush();
  assert.equal(settled, false); assert.ok(state.waits.controlSnapshot().pending.length > 0); assert.deepEqual(state.waits.controlSnapshot().tabIds, [10]);
  assert.throws(() => state.waits.reserve(params), /LIMIT/); assert.equal(state.log.some(row => row[0] === "release"), false);
  adoption.resolve({ tabId: 20 }); await cancelled; assert.equal(settled, true); assert.equal(state.log.filter(row => row[0] === "release").length, 1);
  assert.deepEqual(state.waits.controlSnapshot(), { tabIds: [], pending: [] }); state.reserve();
});

test("bounded cancel timeout does not forget native work or replay adoption, and late admission token is cancelled once", async () => {
  const attach = gate(), state = setup(), record = state.waits.reserve(params); let tokenCancelled = 0;
  const native = state.waits.within(record, async () => { await attach.promise; record.cancelAdmission = () => { tokenCancelled++; }; return "late actual setup"; });
  await flush(); const cancel = state.waits.cancel(state.handle(record)); native.catch(() => {}); state.tick(10001);
  await assert.rejects(cancel, /CLEANUP_TIMEOUT/); assert.ok(state.waits.controlSnapshot().pending.length > 0); assert.throws(() => state.waits.reserve(params), /LIMIT/);
  attach.resolve(); await assert.rejects(native, /EXPIRED/); await state.waits.drain(record); assert.equal(tokenCancelled, 1);
  assert.deepEqual(await state.waits.cancel(state.handle(record)), {}); assert.equal(tokenCancelled, 1);
});

test("cancel drains exact release ACK and exposes release failure without clearing its reverse lock", async () => {
  const released = gate(), state = setup({ release: () => released.promise }), record = state.reserve(); await state.waits.arm(record);
  const cancel = state.waits.cancel(state.handle(record)); await flush(); assert.ok(state.waits.controlSnapshot().pending.length > 0);
  released.reject(new Error("actual storage release failed")); await assert.rejects(cancel, /actual storage/);
  assert.throws(() => state.waits.reserve(params), /LIMIT/); await assert.rejects(state.waits.cancel(state.handle(record)), /actual storage/);
});

test("concurrent collect has deterministic conflict and keeps original candidate", async () => {
  const state = setup(), record = state.reserve(); await state.waits.arm(record);
  const first = state.waits.collect(state.handle(record)); await assert.rejects(state.waits.collect(state.handle(record)), /CONFLICT/);
  state.waits.observe(event()); assert.deepEqual(await first, { tabId: 20 });
});

test("wrong adoption result never grants another child and is released", async () => {
  const state = setup({ adopt: async () => ({ tabId: 21 }) }), record = state.reserve(); await state.waits.arm(record); state.waits.observe(event());
  await assert.rejects(state.waits.collect(state.handle(record)), /different native child/); await state.waits.drain(record);
  assert.equal(record.candidate.tabId, 20); assert.equal(state.log.filter(row => row[0] === "release").length, 1);
});

test("own admission invalidation only preserves original unbound reservation; epoch/assertScope and bound source remain enforced", async () => {
  const state = setup(), record = state.waits.reserve(params); await state.waits.invalidateTab(10, undefined, record); assert.equal(record.invalid, undefined);
  state.waits.bind(record, { ...Object.fromEntries(Object.entries(params).filter(([key]) => key !== "timeoutMs")), attachment: "original" });
  await state.waits.invalidateTab(10, undefined, record); assert.throws(() => state.waits.check(record), /EXPIRED/);
  const bad = state.waits.reserve({ ...params, tabId: 11 }); assert.throws(() => state.waits.bind(bad, { ...params, tabId: 11, attachment: "successor" }), /original/);
  await state.waits.invalidateAll();
});

test("invalidating one session leaves the other exact waiter alive, while all invalidation drains both", async () => {
  const state = setup(), first = state.reserve(), second = state.reserve({ ...params, session_id: "second", tabId: 11 });
  await state.waits.arm(first); await state.waits.arm(second); await state.waits.invalidateSession("first");
  assert.throws(() => state.waits.check(first), /EXPIRED/); state.waits.check(second); await state.waits.invalidateAll(); assert.throws(() => state.waits.check(second), /EXPIRED/);
});

test("exact failed child rollback skips only its own cleanup and cannot exempt another waiter or a live record", async () => {
  let state;
  state = setup({ release: async record => { await state.waits.invalidateTab(record.candidate?.tabId ?? record.params.tabId, undefined, null, record); } });
  const record = state.reserve(); await state.waits.arm(record); state.waits.observe(event()); await record.completion.promise;
  const childSource = state.reserve({ ...params, tabId: 20, session_id: "second" }); await state.waits.arm(childSource);
  await state.waits.cancel(state.handle(record)); assert.equal(record.cleaned, true); assert.equal(childSource.invalid, true); assert.equal(childSource.cleaned, true);
  const live = state.reserve({ ...params, tabId: 11 }); await state.waits.arm(live);
  await state.waits.invalidateTab(11, undefined, null, live); assert.equal(live.invalid, true);
});

test("asynchronous admission cancellation failure is retained even when later rollback succeeds", async () => {
  const state = setup(), record = state.reserve(); record.cancelAdmission = async () => { throw new Error("admission cancel ACK unknown"); };
  await state.waits.arm(record); await assert.rejects(state.waits.cancel(state.handle(record)), /ACK unknown/);
  assert.throws(() => state.waits.reserve(params), /LIMIT/); assert.equal(state.log.filter(row => row[0] === "release").length, 1);
});

test("synchronous scope revocation immediately retires eligibility instead of waiting for original timer", async () => {
  let valid = true; const state = setup({ assertScope: () => { if (!valid) throw new Error("OBU_STALE_CONTROL_EPOCH"); } }), record = state.reserve(); await state.waits.arm(record);
  valid = false; assert.throws(() => state.waits.check(record), /STALE_CONTROL/); await state.waits.drain(record);
  assert.equal(record.invalid, true); assert.equal(record.cleaned, true); state.waits.observe(event()); assert.equal(record.candidate, undefined);
});

test("a second explicit cancel retries a settled failed release, never adoption, and frees capacity only after real success", async () => {
  let releases = 0;
  const state = setup({ release: async () => { if (++releases === 1) throw new Error("first release failed"); } }), record = state.reserve();
  await state.waits.arm(record); state.waits.observe(event()); await record.completion.promise;
  await assert.rejects(state.waits.cancel(state.handle(record)), /first release failed/);
  assert.equal(record.cleanupSettled, true); assert.equal(releases, 1); assert.throws(() => state.waits.reserve(params), /LIMIT/);
  await assert.rejects(state.waits.invalidateAll(), /first release failed/); assert.equal(releases, 1, "ordinary invalidation is not retry authorization");
  assert.deepEqual(await state.waits.cancel(state.handle(record)), {}); assert.equal(releases, 2); assert.equal(record.cleaned, true); assert.equal(record.cleanupAttempts, 2);
  assert.equal(state.log.filter(row => row[0] === "adopt").length, 1); state.reserve();
});

test("a second cancel while release is still pending never duplicates an unknown native operation", async () => {
  const release = gate(); let calls = 0;
  const state = setup({ release: () => { calls++; return release.promise; } }), record = state.reserve(); await state.waits.arm(record);
  const first = state.waits.cancel(state.handle(record)); await flush(); const second = state.waits.cancel(state.handle(record)); await flush();
  assert.equal(calls, 1); assert.equal(record.cleanupSettled, false); await state.waits.retryFailedCleanup(); assert.equal(calls, 1);
  release.resolve(); assert.deepEqual(await first, {}); assert.deepEqual(await second, {}); assert.equal(calls, 1);
});

test("failed explicit retry keeps reverse lock and new error until a later explicit successful cleanup", async () => {
  let calls = 0; const state = setup({ release: async () => { if (++calls <= 2) throw new Error(`release attempt ${calls}`); } }), record = state.reserve(); await state.waits.arm(record);
  await assert.rejects(state.waits.cancel(state.handle(record)), /attempt 1/);
  await assert.rejects(state.waits.cancel(state.handle(record)), /attempt 2/); assert.equal(record.cleanupAttempts, 2);
  assert.throws(() => state.waits.reserve(params), /LIMIT/); assert.match(record.cleanupError.message, /attempt 2/);
  await state.waits.retryFailedCleanup(); assert.equal(calls, 3); assert.equal(record.cleaned, true); state.reserve();
});

test("explicit retry reattempts a rejected admission cancellation but skips an acknowledged cancellation", async () => {
  let cancellations = 0, releases = 0;
  const state = setup({ release: async () => { releases++; if (releases === 2) throw new Error("second conditional release failed"); } }), record = state.reserve();
  record.cancelAdmission = async () => { if (++cancellations === 1) throw new Error("first admission cancel rejected"); }; await state.waits.arm(record);
  await assert.rejects(state.waits.cancel(state.handle(record)), /first admission/); assert.equal(record.admissionCancellation.state, "rejected");
  await assert.rejects(state.waits.cancel(state.handle(record)), /second conditional/); assert.equal(cancellations, 2); assert.equal(record.admissionCancellation.state, "fulfilled");
  assert.deepEqual(await state.waits.cancel(state.handle(record)), {}); assert.equal(releases, 3); assert.equal(cancellations, 2);
});
