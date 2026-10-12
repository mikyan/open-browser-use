import assert from "node:assert/strict";
import test from "node:test";
import { BrowserNavigationWaits, validateNavigationWait } from "./browser-navigation-waits.js";

const params = extra => ({ session_id: "session", turn_id: "turn", control_epoch: 1, tabId: 42, event: "url", url: "**/done", timeoutMs: 1000, ...extra });
const nextTurn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); promise.catch(() => {}); return { promise, resolve, reject }; };
function observer({ ready = true, delayedCancellation = false } = {}) {
  const registration = deferred(), completion = deferred(), cancellations = [];
  if (ready) registration.resolve();
  return { ready: registration.promise, result: completion.promise,
    register: registration.resolve, complete: completion.resolve, reject: completion.reject,
    cancellations, cancel(error) {
      cancellations.push(error);
      registration.reject(error);
      if (!delayedCancellation) completion.reject(error);
    }, settleCancellation() { completion.reject(cancellations[0]); }
  };
}
function fixture(t, options = {}) {
  let now = 0, nextTimer = 0;
  const timers = new Map();
  const registry = new BrowserNavigationWaits({ now: () => now, setTimer: (fn, ms) => { const id = ++nextTimer; timers.set(id, { fn, at: now + ms }); return id; }, clearTimer: id => timers.delete(id), ...options });
  const scope = { session_id: "session", turn_id: "turn", control_epoch: 1, tabId: 42, attachment: {} };
  t.after(() => registry.invalidateAll());
  return { registry, scope, timers,
    handle: record => ({ ...Object.fromEntries(["session_id", "turn_id", "control_epoch", "tabId"].map(key => [key, record.params[key]])), waiterId: record.waiterId }),
    arm: async (extra = {}, validate = async () => {}, native = observer()) => {
      const record = registry.reserve(params(extra));
      const bound = { ...scope, ...Object.fromEntries(["session_id", "turn_id", "control_epoch", "tabId"].map(key => [key, record.params[key]])) };
      const ready = await registry.arm(record, native, bound, validate);
      return { record, ready, native };
    },
    advance: async ms => { now += ms; for (const [id, timer] of [...timers]) if (timer.at <= now && timers.delete(id)) timer.fn(); await nextTurn(); }
  };
}

test("strict navigation fields and UTF-8 limits reject before capacity reservation", t => {
  const f = fixture(t);
  for (const extra of [
    { extra: 1 }, { control_epoch: undefined }, { control_epoch: 0 }, { control_epoch: null }, { tabId: 1.2 },
    { event: "navigation" }, { timeoutMs: null }, { timeoutMs: 0 }, { timeoutMs: 1.5 }, { timeoutMs: 120001 },
    { url: "" }, { url: "字".repeat(1366) }, { url: /done/ }, { urlMatch: "contains" },
    { state: "load" }, { waitUntil: null }, { waitUntil: "ready" },
    { event: "loadstate" }, { event: "loadstate", url: undefined, state: "load" }
  ]) assert.throws(() => f.registry.reserve(params(extra)));
  for (const state of [null, "commit", "ready"]) assert.throws(() => f.registry.reserve({ session_id: "session", turn_id: "turn", control_epoch: 1, tabId: 42, event: "loadstate", state }));
  assert.equal(f.registry.records.size, 0); assert.equal(f.timers.size, 0);
  const value = validateNavigationWait(params({ url: "字".repeat(1365) + "x", waitUntil: "commit" }));
  assert.ok(Object.isFrozen(value)); assert.equal(value.waitUntil, "commit");
  assert.equal(validateNavigationWait({ session_id: "session", turn_id: "turn", control_epoch: 1, tabId: 42, event: "loadstate" }).state, "load");
});

test("legacy direct reservation binds once to the actual admitted epoch", async t => {
  const f = fixture(t), request = params({ control_epoch: undefined });
  assert.throws(() => f.registry.reserve(request), /control_epoch/);
  const record = f.registry.reserve(request, { allowLegacyEpoch: true }), native = observer();
  await f.registry.arm(record, native, { ...f.scope, control_epoch: 8 }, async () => {});
  assert.equal(record.params.control_epoch, 8); assert.ok(Object.isFrozen(record.params));
  native.complete(); assert.deepEqual(await f.registry.collect(f.handle(record)), {});
  await assert.rejects(f.registry.collect({ ...f.handle(record), control_epoch: 1 }), /EXPIRED/);
  const wrong = f.registry.reserve(params()), other = observer();
  await assert.rejects(f.registry.arm(wrong, other, { ...f.scope, control_epoch: 2 }, async () => {}), /scope/);
  assert.equal(other.cancellations.length, 1); assert.ok(!f.registry.records.has(wrong.waiterId));
});

test("ready waits for native listener registration and releases before navigation completion", async t => {
  const f = fixture(t), native = observer({ ready: false }), record = f.registry.reserve(params());
  assert.deepEqual(f.registry.controlSnapshot().tabIds, []);
  let acknowledged = false;
  const arming = f.registry.arm(record, native, f.scope, async () => {}).then(result => { acknowledged = true; return result; });
  await nextTurn(); assert.equal(acknowledged, false);
  assert.deepEqual(f.registry.controlSnapshot().tabIds, [42]);
  native.register(); const ready = await arming;
  assert.equal(ready.waiterId, record.waiterId); assert.equal(ready.remainingMs, 1000); assert.equal(record.state, "pending");
  let collected = false;
  const collecting = f.registry.collect(f.handle(record)).then(value => { collected = true; return value; });
  await nextTurn(); assert.equal(collected, false);
  native.complete(); assert.deepEqual(await collecting, {});
});

test("native current-URL or cached-state success before ACK is retained without waiting for a future event", async t => {
  const f = fixture(t), native = observer(), gate = deferred(); let validations = 0;
  native.complete();
  const record = f.registry.reserve(params());
  const arming = f.registry.arm(record, native, f.scope, async () => { if (++validations === 1) await gate.promise; });
  await nextTurn(); gate.resolve(); await arming;
  await f.advance(2000);
  assert.deepEqual(await f.registry.collect(f.handle(record)), {});
  assert.deepEqual(await f.registry.collect(f.handle(record)), {});
});

test("the first native completion retains its original deadline while bounded owner validation finishes", async t => {
  const f = fixture(t), gate = deferred(); let delayed = false;
  const { record, native } = await f.arm({ timeoutMs: 100 }, async () => { if (delayed) await gate.promise; });
  await f.advance(99); delayed = true; native.complete(); await nextTurn();
  assert.equal(record.selectedAt, 99);
  await f.advance(11); delayed = false; gate.resolve();
  assert.deepEqual(await f.registry.collect(f.handle(record)), {});
  const late = await f.arm({ timeoutMs: 100 }); await f.advance(100); late.native.complete();
  await assert.rejects(f.registry.collect(f.handle(late.record)), /OBU_NAVIGATION_WAIT_TIMEOUT/);
});

test("native navigation errors preserve the original error and name across repeated collection", async t => {
  const f = fixture(t), error = Object.assign(new Error("net::ERR_ABORTED at fixture"), { name: "NavigationError" });
  const { record, native } = await f.arm(); native.reject(error); await nextTurn();
  await assert.rejects(f.registry.collect(f.handle(record)), value => value === error && value.name === "NavigationError");
  await assert.rejects(f.registry.collect(f.handle(record)), value => value === error);
  const early = f.registry.reserve(params()), failed = observer({ ready: false }); failed.reject(error);
  await assert.rejects(f.registry.arm(early, failed, f.scope, async () => {}), value => value === error);
  assert.ok(!f.registry.records.has(early.waiterId));
});

test("timeout cancels only its native observer and retains a repeatable error until cancellation", async t => {
  const f = fixture(t), first = await f.arm({ timeoutMs: 100 }), second = await f.arm();
  const collecting = assert.rejects(f.registry.collect(f.handle(first.record)), /TIMEOUT/);
  await nextTurn(); await f.advance(100); await collecting;
  assert.equal(first.native.cancellations.length, 1); assert.equal(second.native.cancellations.length, 0);
  await assert.rejects(f.registry.collect(f.handle(first.record)), /TIMEOUT/);
  second.native.complete(); assert.deepEqual(await f.registry.collect(f.handle(second.record)), {});
  await f.registry.cancel(f.handle(first.record));
  assert.equal(first.native.cancellations.length, 1);
  await assert.rejects(f.registry.collect(f.handle(first.record)), /EXPIRED/);
});

test("an early completion cannot extend a blocked setup past the original ready deadline", async t => {
  const f = fixture(t), gate = deferred(), native = observer(), record = f.registry.reserve(params({ timeoutMs: 100 }));
  const arming = f.registry.arm(record, native, f.scope, () => gate.promise);
  const rejected = assert.rejects(arming, /TIMEOUT/);
  await nextTurn(); await f.advance(99); native.complete(); await nextTurn();
  await f.advance(11); await rejected; gate.resolve(); await nextTurn();
  assert.equal(f.registry.records.size, 0); assert.equal(native.cancellations.length, 1);
});

test("scope validation loss cannot publish native success or revive a removed record", async t => {
  const f = fixture(t), gate = deferred(); let invalid = false;
  const { record, native } = await f.arm({}, async () => { if (invalid) { await gate.promise; throw new Error("owner changed"); } });
  invalid = true; native.complete(); await nextTurn(); assert.equal(record.state, "matching");
  gate.resolve(); await nextTurn();
  await assert.rejects(f.registry.collect(f.handle(record)), /EXPIRED/);
  assert.equal(f.registry.records.size, 0);
});

test("all scope fields are exact and unknown/foreign cancel cannot affect an owned wait", async t => {
  const f = fixture(t), { record, native } = await f.arm();
  for (const changed of [{ session_id: "other" }, { turn_id: "other" }, { control_epoch: 2 }, { tabId: 43 }]) {
    await assert.rejects(f.registry.collect({ ...f.handle(record), ...changed }), /EXPIRED/);
    assert.deepEqual(await f.registry.cancel({ ...f.handle(record), ...changed }), {});
  }
  assert.equal(native.cancellations.length, 0); native.complete();
  assert.deepEqual(await f.registry.collect(f.handle(record)), {});
  await f.registry.cancel(f.handle(record)); assert.equal(native.cancellations.length, 1);
  assert.deepEqual(await f.registry.cancel(f.handle(record)), {});
});

test("retained terminal records count toward all limits and TTL frees capacity", async t => {
  const f = fixture(t, { maxPerTab: 1, maxPerSession: 2, maxTotal: 3, ttlMs: 50 });
  const first = await f.arm(); first.native.complete(); await nextTurn();
  assert.throws(() => f.registry.reserve(params()), /LIMIT/);
  f.registry.reserve(params({ tabId: 43 })); assert.throws(() => f.registry.reserve(params({ tabId: 44 })), /LIMIT/);
  f.registry.reserve(params({ session_id: "other", tabId: 44 })); assert.throws(() => f.registry.reserve(params({ session_id: "third", tabId: 45 })), /LIMIT/);
  await f.advance(50); await assert.rejects(f.registry.collect(f.handle(first.record)), /EXPIRED/);
  assert.doesNotThrow(() => f.registry.reserve(params()));
});

test("raw-to-engine migration preserves reservations; tab/session/global invalidation cancels native lifetimes", async t => {
  const f = fixture(t), first = await f.arm(), reserved = f.registry.reserve(params());
  f.registry.invalidateAttachedTab(42);
  assert.ok(!f.registry.records.has(first.record.waiterId)); assert.ok(f.registry.records.has(reserved.waiterId));
  assert.equal(first.native.cancellations.length, 1);
  const native = observer({ ready: false });
  const arming = assert.rejects(f.registry.arm(reserved, native, f.scope, async () => {}), /EXPIRED/);
  await nextTurn(); f.registry.invalidateTab(42); await arming; native.register(); native.complete(); await nextTurn();
  assert.equal(f.registry.records.size, 0);
  const waiting = await f.arm();
  const collected = assert.rejects(f.registry.collect(f.handle(waiting.record)), /EXPIRED/);
  f.registry.invalidateSession("session"); await collected;
  assert.equal(f.timers.size, 0);
  const last = await f.arm(); f.registry.invalidateAll(); assert.equal(last.native.cancellations.length, 1);
});

test("control snapshot drains the actual native cancellation promise, even after the handle is removed", async t => {
  const f = fixture(t), native = observer({ delayedCancellation: true }), armed = await f.arm({}, async () => {}, native);
  f.registry.invalidateTab(42);
  assert.equal(f.registry.records.size, 0); assert.equal(native.cancellations.length, 1);
  let drained = false;
  const snapshot = f.registry.controlSnapshot();
  const drain = Promise.allSettled(snapshot.pending).then(() => { drained = true; });
  await nextTurn(); assert.equal(drained, false);
  native.settleCancellation(); await drain;
  await assert.rejects(f.registry.collect(f.handle(armed.record)), /EXPIRED/);
});

test("hung completion/result scope checks are bounded and retain truthful terminal errors", async t => {
  const f = fixture(t), gate = deferred(); let blocked = false;
  const first = await f.arm({}, async () => { if (blocked) await gate.promise; });
  blocked = true; first.native.complete(); await nextTurn(); await f.advance(10000);
  blocked = false; gate.resolve();
  await assert.rejects(f.registry.collect(f.handle(first.record)), /OBU_NAVIGATION_WAIT_FAILED/);
  const second = await f.arm(); second.native.complete(); await nextTurn();
  second.record.validateScope = () => new Promise(() => {});
  const failed = assert.rejects(f.registry.collect(f.handle(second.record)), /result scope validation timed out/);
  await nextTurn(); await f.advance(10000); await failed;
  assert.ok(!f.registry.records.has(second.record.waiterId));
});

test("late or expired setup observers are cancelled and original reservation deadlines cannot be enlarged", async t => {
  const f = fixture(t), record = f.registry.reserve(params({ timeoutMs: 10 }), { deadlineAt: 5000 });
  assert.equal(record.deadlineAt, 10); await f.advance(10);
  const native = observer({ delayedCancellation: true });
  await assert.rejects(f.registry.arm(record, native, f.scope, async () => {}), /TIMEOUT/);
  assert.equal(native.cancellations.length, 1); assert.equal(f.registry.records.size, 0);
  let drained = false;
  const drain = Promise.allSettled(f.registry.controlSnapshot().pending).then(() => { drained = true; });
  await nextTurn(); assert.equal(drained, false);
  native.settleCancellation(); await drain;
  assert.equal(f.registry.controlSnapshot().pending.length, 0);
  const failed = f.registry.reserve(params()); f.registry.fail(failed, new Error("setup failed"));
  assert.ok(!f.registry.records.has(failed.waiterId));
});

test("invalid-scope setup still drains the newly rejected native observer", async t => {
  const f = fixture(t), record = f.registry.reserve(params()), native = observer({ delayedCancellation: true });
  await assert.rejects(f.registry.arm(record, native, { ...f.scope, control_epoch: 2 }, async () => {}), /scope/);
  assert.equal(native.cancellations.length, 1); assert.equal(f.registry.records.size, 0);
  let drained = false;
  const drain = Promise.allSettled(f.registry.controlSnapshot().pending).then(() => { drained = true; });
  await nextTurn(); assert.equal(drained, false);
  native.settleCancellation(); await drain;
  assert.equal(f.registry.controlSnapshot().pending.length, 0);
});

test("a rejected second registration cancels the newly created observer as well as the original record", async t => {
  const f = fixture(t), first = await f.arm(), other = observer();
  await assert.rejects(f.registry.arm(first.record, other, f.scope, async () => {}), /scope/);
  assert.equal(first.native.cancellations.length, 1); assert.equal(other.cancellations.length, 1);
  assert.equal(f.registry.records.size, 0);
  await Promise.allSettled(f.registry.controlSnapshot().pending);
});

test("default timers do not invoke browser timer APIs with the registry receiver", async t => {
  const nativeSet = globalThis.setTimeout.bind(globalThis), nativeClear = globalThis.clearTimeout.bind(globalThis);
  t.mock.method(globalThis, "setTimeout", function(...args) { if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation"); return nativeSet(...args); });
  t.mock.method(globalThis, "clearTimeout", function(...args) { if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation"); return nativeClear(...args); });
  const registry = new BrowserNavigationWaits(), native = observer(), record = registry.reserve(params());
  try {
    await registry.arm(record, native, { ...record.params, attachment: {} }, async () => {});
    native.complete(); assert.deepEqual(await registry.collect({ session_id: "session", turn_id: "turn", control_epoch: 1, tabId: 42, waiterId: record.waiterId }), {});
  } finally { registry.invalidateAll(); }
});
