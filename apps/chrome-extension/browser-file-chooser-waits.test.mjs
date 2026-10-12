import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { BrowserFileChooserWaits } from "./browser-file-chooser-waits.js";

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const params = { session_id: "task", turn_id: "turn", control_epoch: 1, tabId: 7 };

test("default timers retain their browser global receiver during admission and cleanup", async () => {
  const source = readFileSync(new URL("./browser-file-chooser-waits.js", import.meta.url), "utf8");
  const { Registry, timers, calls } = runInNewContext(`
    const timers = new Map(), calls = [];
    let nextTimer = 0;
    globalThis.setTimeout = function (callback, delay) {
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      const id = ++nextTimer;
      calls.push(["set", delay]);
      timers.set(id, callback);
      return id;
    };
    globalThis.clearTimeout = function (id) {
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      calls.push(["clear", id]);
      timers.delete(id);
    };
    ${source.replace("export class BrowserFileChooserWaits", "class BrowserFileChooserWaits")}
    ({ Registry: BrowserFileChooserWaits, timers, calls });
  `, { crypto, TextEncoder });
  const registry = new Registry({ send: async () => {}, assertScope: () => {},
    validateScope: async () => {}, targetAlive: () => true, discard: () => {} });
  const record = registry.reserve({ ...params, timeoutMs: 100 });
  registry.bind(record, params);
  const ack = await registry.arm(record, [undefined]);
  await registry.cancel({ ...params, waiterId: ack.waiterId });
  assert.deepEqual(Array.from(calls.filter(([kind]) => kind === "set"), ([, delay]) => delay), [100, 10000]);
  assert.equal(timers.size, 0);
  assert.equal(registry.records.size, 0);
});

function fixture(overrides = {}) {
  let now = 0, next = 0;
  const timers = new Map(), calls = [], discarded = [], attachment = {};
  const scope = { ...params, attachment };
  const registry = new BrowserFileChooserWaits({
    now: () => now, setTimer: (fn, ms) => { const id = ++next; timers.set(id, { at: now + ms, fn }); return id; }, clearTimer: id => timers.delete(id),
    send: async (scope, sessionId, enabled) => { calls.push({ scope, sessionId, enabled }); },
    assertScope: value => assert.equal(value.attachment, attachment), validateScope: async () => {},
    targetAlive: value => value.attachment === attachment, discard: value => discarded.push(value), ...overrides
  });
  const advance = async ms => { now += ms; for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); } await flush(); };
  const reserve = (options = {}) => { const record = registry.reserve({ ...params, timeoutMs: 100, ...options }); registry.bind(record, { ...scope, ...options }); return record; };
  const arm = async (options, sessions = [undefined]) => { const record = reserve(options); const ack = await registry.arm(record, sessions); return { record, ack, handle: { ...params, waiterId: ack.waiterId } }; };
  return { registry, calls, discarded, scope, timers, advance, reserve, arm };
}

test("ready waits for every real enable, retains original remaining budget, and collects exactly once", async () => {
  const gate = deferred(), f = fixture({ send: async (_scope, session, enabled) => { if (session === "child" && enabled) await gate.promise; } });
  const record = f.reserve(); let acknowledged = false;
  const arming = f.registry.arm(record, [undefined, "child"]).then(value => { acknowledged = true; return value; });
  await f.advance(35); assert.equal(acknowledged, false);
  assert.deepEqual(f.registry.controlSnapshot().tabIds, [7]);
  assert.ok(f.registry.controlSnapshot().pending.length > 0); gate.resolve();
  const ack = await arming; assert.equal(ack.remainingMs, 65);
  const handle = { ...params, waiterId: ack.waiterId };
  const collect = f.registry.collect(handle);
  assert.throws(() => f.registry.collect(handle), /CONFLICT/);
  f.registry.observe(record, "child", () => ({ fileChooserId: "chosen", isMultiple: true }));
  assert.deepEqual(await collect, { fileChooserId: "chosen", isMultiple: true });
  assert.throws(() => f.registry.collect(handle), /EXPIRED/);
  assert.equal(f.registry.records.size, 0); assert.equal(f.timers.size, 0);
});

test("all three request schemas reject unknown options and invalid scope before native work", async () => {
  const f = fixture();
  for (const changes of [{ extra: 1 }, { control_epoch: 0 }, { tabId: -1 }, { timeoutMs: null }, { timeoutMs: 1.5 }])
    assert.throws(() => f.registry.reserve({ ...params, ...changes }));
  assert.throws(() => f.registry.lookup({ ...params, waiterId: "id", timeoutMs: 1 }), /does not support/);
  await assert.rejects(f.registry.cancel({ ...params, waiterId: "id", timeoutMs: 1 }), /does not support/);
  assert.deepEqual(f.calls, []);
});

test("foreign scope cannot collect or cancel an owned record", async () => {
  const f = fixture(), { record, handle } = await f.arm();
  for (const changes of [{ session_id: "other" }, { turn_id: "other" }, { control_epoch: 2 }, { tabId: 8 }]) {
    assert.throws(() => f.registry.collect({ ...handle, ...changes }), /EXPIRED/);
    assert.deepEqual(await f.registry.cancel({ ...handle, ...changes }), {});
  }
  assert.equal(record.invalid, undefined);
  await f.registry.cancel(handle); assert.equal(f.registry.records.size, 0);
});

test("a first candidate stays first while ownership validation is pending", async () => {
  let gate;
  const f = fixture({ validateScope: async () => { await gate?.promise; } });
  const { record, handle } = await f.arm(); gate = deferred(); let second = false;
  f.registry.observe(record, undefined, () => ({ fileChooserId: "first", isMultiple: false }));
  f.registry.observe(record, undefined, () => { second = true; return { fileChooserId: "second", isMultiple: false }; });
  const collecting = f.registry.collect(handle); gate.resolve();
  assert.equal((await collecting).fileChooserId, "first"); assert.equal(second, false);
});

test("event validation and collect share the original deadline, including a pre-deadline candidate", async () => {
  let gate;
  const f = fixture({ validateScope: async () => { await gate?.promise; } });
  const { record, handle } = await f.arm(); gate = deferred();
  f.registry.observe(record, undefined, () => ({ fileChooserId: "late", isMultiple: false }));
  const collect = assert.rejects(f.registry.collect(handle), /WAIT_TIMEOUT/);
  await f.advance(100); await collect; gate.resolve(); await flush();
  assert.equal(record.result, undefined); assert.equal(f.registry.records.size, 0);
});

test("timed-out enable retains capacity until its real completion and exact disable", async () => {
  const gate = deferred(), calls = [];
  const f = fixture({ send: async (_scope, _session, enabled) => { calls.push(enabled); if (enabled) await gate.promise; } });
  const record = f.reserve(); const arming = assert.rejects(f.registry.arm(record, [undefined]), /WAIT_TIMEOUT/);
  await flush();
  await f.advance(100); await arming;
  assert.throws(() => f.registry.reserve(params), /LIMIT/); assert.deepEqual(calls, [true]);
  gate.resolve(); await flush();
  assert.deepEqual(calls, [true, false]); assert.equal(f.registry.records.size, 0); assert.equal(f.registry.operations.size, 0);
});

test("cancel waits for disable, and a failed disable keeps capacity until explicit retry after expiry", async () => {
  let fail = true; const gate = deferred(), calls = [];
  const f = fixture({ send: async (_scope, _session, enabled) => { calls.push(enabled); if (!enabled) { if (fail) throw new Error("disable failed"); await gate.promise; } } });
  const { handle } = await f.arm();
  await assert.rejects(f.registry.cancel(handle), /CLEANUP_FAILED/);
  assert.throws(() => f.registry.reserve(params), /LIMIT/);
  await f.advance(200); fail = false;
  let done = false; const retry = f.registry.cancel(handle).then(() => { done = true; });
  await flush(); assert.equal(done, false); gate.resolve(); await retry;
  assert.deepEqual(calls, [true, false, false]); assert.equal(f.registry.records.size, 0);
});

test("cleanup response timeout does not erase pending native work or send a second disable", async () => {
  const gate = deferred(), calls = [];
  const f = fixture({ cleanupTimeoutMs: 50, send: async (_scope, _session, enabled) => { calls.push(enabled); if (!enabled) await gate.promise; } });
  const { handle } = await f.arm(); const cancelling = assert.rejects(f.registry.cancel(handle), /CLEANUP_TIMEOUT/);
  await f.advance(50); await cancelling; assert.equal(f.registry.records.size, 1);
  const retry = f.registry.cancel(handle); await flush(); assert.deepEqual(calls, [true, false]);
  gate.resolve(); await retry; assert.equal(f.registry.records.size, 0);
});

test("replacement attachment never receives an old disable", async () => {
  const gate = deferred(), calls = []; let alive = true;
  const f = fixture({ targetAlive: () => alive, send: async (_scope, _session, enabled) => { calls.push(enabled); if (enabled) await gate.promise; } });
  const record = f.reserve(); const arming = assert.rejects(f.registry.arm(record, [undefined]), /EXPIRED/);
  await flush(); alive = false; const cleanup = f.registry.invalidateAll(); await arming;
  gate.resolve(); await cleanup; assert.deepEqual(calls, [true]); assert.equal(f.registry.records.size, 0);
});

test("new OOPIF enable extends the input readiness barrier without extending its deadline", async () => {
  const gate = deferred(); let blocked = false;
  const f = fixture({ send: async (_scope, session, enabled) => { if (session === "new-child" && enabled) await gate.promise; } });
  const { record, handle } = await f.arm();
  void f.registry.enable(record, "new-child");
  const barrier = f.registry.barrier(record).then(() => { blocked = true; });
  await flush(); assert.equal(blocked, false); assert.equal(record.targets.has("new-child"), true);
  gate.resolve(); await barrier; await f.registry.cancel(handle);
});

test("uncollected results expire and cancellation discards only their chooser", async () => {
  const f = fixture(), { record, handle } = await f.arm();
  f.registry.observe(record, undefined, () => ({ fileChooserId: "uncollected", isMultiple: false }));
  await flush(); assert.equal(record.state, "matched");
  await f.advance(100); assert.throws(() => f.registry.collect(handle), /EXPIRED/);
  assert.ok(f.discarded.some(value => value.fileChooserId === "uncollected")); assert.equal(f.registry.records.size, 0);
});
