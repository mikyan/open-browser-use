import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { BrowserDownloadWaits } from "./browser-download-waits.js";

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = async () => { for (let n = 0; n < 40; n++) await Promise.resolve(); };
const params = { session_id: "task", turn_id: "turn", control_epoch: 1, tabId: 7 };
function fixture(options = {}) {
  let now = 0, next = 0;
  const timers = new Map(), calls = [], published = [], discarded = [], scope = { ...params, attachment: {} };
  const registry = new BrowserDownloadWaits({ now: () => now,
    setTimer: (fn, ms) => { const id = ++next; timers.set(id, { at: now + ms, fn }); return id; }, clearTimer: id => timers.delete(id),
    send: async (_scope, sessionId) => calls.push(sessionId), assertScope: () => {}, validateScope: async () => {}, sourceAlive: () => true,
    publish: result => published.push(result), discard: result => discarded.push(result), ...options });
  const reserve = changes => { const record = registry.reserve({ ...params, timeoutMs: 100, ...changes }); registry.bind(record, scope); return record; };
  const arm = async (changes, sessions = [undefined]) => { const record = reserve(changes); const ack = await registry.arm(record, sessions); return { record, ack, handle: { ...params, waiterId: ack.waiterId } }; };
  const advance = async ms => { now += ms; for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); } await flush(); };
  return { registry, timers, calls, published, discarded, scope, reserve, arm, advance };
}

test("default download wait timers retain the browser global receiver", async () => {
  const source = readFileSync(new URL("./browser-download-waits.js", import.meta.url), "utf8");
  const { Registry, timers } = runInNewContext(`
    const timers = new Map(); let next = 0;
    globalThis.setTimeout = function (fn) { if (this !== globalThis) throw Error("Illegal invocation"); timers.set(++next, fn); return next; };
    globalThis.clearTimeout = function (id) { if (this !== globalThis) throw Error("Illegal invocation"); timers.delete(id); };
    ${source.replace("export class BrowserDownloadWaits", "class BrowserDownloadWaits")}
    ({Registry: BrowserDownloadWaits, timers});
  `, { crypto, TextEncoder });
  const registry = new Registry({ send: async () => {}, assertScope: () => {}, validateScope: async () => {}, sourceAlive: () => true });
  const record = registry.reserve(params); registry.bind(record, params);
  const ack = await registry.arm(record, [undefined]); await registry.cancel({ ...params, waiterId: ack.waiterId });
  assert.equal(timers.size, 0); assert.equal(registry.records.size, 0);
});

test("readiness waits for root and known children using the original remaining budget", async () => {
  const gate = deferred(), f = fixture({ send: async (_scope, session) => { if (session === "child") await gate.promise; } });
  const record = f.reserve(); let ready = false;
  const arming = f.registry.arm(record, [undefined, "child"]).then(ack => { ready = true; return ack; });
  await f.advance(35); assert.equal(ready, false);
  assert.deepEqual(f.registry.controlSnapshot().tabIds, [7]);
  assert.ok(f.registry.controlSnapshot().pending.length > 0); gate.resolve();
  const ack = await arming; assert.equal(ack.remainingMs, 65);
  await f.registry.cancel({ ...params, waiterId: ack.waiterId });
});

test("a newly joined target ACK must precede final permission validation even without requirePath", async () => {
  const gate = deferred(); let validations = 0, allowed = true, current;
  const f = fixture({ send: async (_scope, session) => { if (session === "child") await gate.promise; },
    validateScope: async () => {
      if (++validations === 1) { void f.registry.enable(current, "child"); return; }
      if (!allowed) throw new Error("OBU_SITE_ACCESS_DENIED: child changed permission");
    } });
  current = f.reserve(); const pending = f.registry.arm(current, [undefined]);
  const rejected = assert.rejects(pending, /SITE_ACCESS_DENIED/);
  await flush(); allowed = false; gate.resolve(); await rejected;
  assert.equal(validations, 2); assert.deepEqual(f.published, []);
  f.registry.fail(current); await f.registry.drain(current);
});

test("collect checks the original authority after its last asynchronous scope validation", async () => {
  let revoked = false, collecting = false;
  const f = fixture({ validateScope: async () => { if (collecting) queueMicrotask(() => { revoked = true; }); },
    assertResult: () => { if (revoked) throw new Error("OBU_SITE_ACCESS_UNVERIFIED: original policy changed"); } });
  const { record, handle } = await f.arm();
  f.registry.observe(record, undefined, () => ({ downloadId: "original-guid" })); await record.completion.promise;
  collecting = true; await assert.rejects(f.registry.collect(handle), /SITE_ACCESS_UNVERIFIED/);
  assert.equal(record.delivered, undefined); assert.equal(record.invalid, true);
  assert.deepEqual(f.discarded, [{ downloadId: "original-guid" }]);
  await f.registry.drain(record); assert.equal(f.registry.records.size, 0);
});

test("strict download wait schemas and capacity are enforced before native work", async () => {
  const f = fixture({ maxTotal: 1 });
  for (const extra of [{ unknown: 1 }, { timeoutMs: null }, { timeoutMs: 0 }, { timeoutMs: 120001 }, { control_epoch: undefined }, { tabId: -1 }])
    assert.throws(() => f.registry.reserve({ ...params, ...extra }));
  const { handle } = await f.arm();
  assert.throws(() => f.registry.reserve(params), /WAIT_LIMIT/);
  assert.throws(() => f.registry.reserve({ ...params, tabId: 8 }), /WAIT_LIMIT/);
  assert.throws(() => f.registry.lookup({ ...handle, timeoutMs: 100 }), /does not support/);
  await assert.rejects(f.registry.cancel({ ...handle, waiterId: "字".repeat(43) }), /128/);
  await f.registry.cancel(handle);
});

test("requirePath is a strict optional boolean and never part of a collect/cancel handle", async () => {
  const f = fixture();
  for (const requirePath of [null, 0, 1, "true", [], {}])
    assert.throws(() => f.registry.reserve({ ...params, requirePath }), /requirePath/);
  for (const requirePath of [false, true]) {
    const { record, handle } = await f.arm({ requirePath });
    assert.equal(record.params.requirePath, requirePath);
    assert.throws(() => f.registry.lookup({ ...handle, requirePath }), /does not support/);
    await assert.rejects(f.registry.cancel({ ...handle, requirePath }), /does not support/);
    await f.registry.cancel(handle);
  }
});

test("legacy download waits reject requirePath before reserving capacity or native setup", async () => {
  const f = fixture();
  for (const requirePath of [true, false, undefined]) {
    assert.throws(() => f.registry.reserve({ ...params, requirePath }, { legacy: true }), /does not support requirePath/);
    assert.equal(f.registry.records.size, 0); assert.equal(f.registry.byTab.size, 0);
    assert.equal(f.timers.size, 0); assert.deepEqual(f.calls, []);
  }
  const record = f.registry.reserve({ ...params, control_epoch: undefined }, { legacy: true });
  assert.equal(record.legacy, true); assert.equal(Object.hasOwn(record.params, "requirePath"), false);
  await f.registry.invalidateAll();
  assert.equal(f.registry.records.size, 0); assert.equal(f.timers.size, 0);
});

test("binding checks fence the final readiness and delivery continuations", async () => {
  let valid = true;
  const f = fixture({ assertBinding: () => { if (!valid) throw new Error("OBU_DOWNLOAD_PATH_UNAVAILABLE"); },
    validateScope: async () => { valid = false; } });
  const record = f.reserve({ requirePath: true });
  await assert.rejects(f.registry.arm(record, [undefined]), /PATH_UNAVAILABLE/);
  assert.equal(record.invalid, true);
  assert.deepEqual(f.published, []);
  assert.equal(f.registry.records.size, 0);
});

test("required path readiness cannot renew its deadline when children keep joining during validation", async () => {
  let sequence = 0;
  const f = fixture({ validateScope: async (_scope, record) => {
    void f.registry.enable(record, `child-${++sequence}`).catch(() => {});
    await f.advance(25);
  } });
  const record = f.reserve({ requirePath: true });
  await assert.rejects(f.registry.arm(record, [undefined]), /WAIT_TIMEOUT/);
  assert.equal(sequence, 4); assert.equal(record.deadlineAt, 100);
  await f.registry.drain(record);
  assert.equal(f.registry.records.size, 0); assert.equal(f.timers.size, 0);
});

test("foreign scope cannot consume or cancel the owned download observer", async () => {
  const f = fixture(), { record, handle } = await f.arm();
  for (const extra of [{ session_id: "other" }, { turn_id: "other" }, { control_epoch: 2 }, { tabId: 8 }]) {
    assert.throws(() => f.registry.collect({ ...handle, ...extra }), /EXPIRED/);
    assert.deepEqual(await f.registry.cancel({ ...handle, ...extra }), {});
  }
  assert.equal(record.invalid, undefined); await f.registry.cancel(handle);
});

test("first native event claims before async validation and collect consumes it only once", async () => {
  let gate;
  const f = fixture({ validateScope: async () => { await gate?.promise; } }), { record, handle } = await f.arm();
  gate = deferred(); let second = false;
  f.registry.observe(record, undefined, () => ({ downloadId: "first" }));
  f.registry.observe(record, undefined, () => { second = true; return { downloadId: "second" }; });
  const result = f.registry.collect(handle);
  assert.throws(() => f.registry.collect(handle), /CONFLICT/); await flush(); assert.equal(second, false);
  gate.resolve(); assert.deepEqual(await result, { downloadId: "first" });
  assert.throws(() => f.registry.collect(handle), /EXPIRED/);
  await f.registry.cancel(handle); assert.deepEqual(f.discarded, []);
});

test("final ownership validation cannot deliver a pre-deadline download after expiry", async () => {
  let gate;
  const f = fixture({ validateScope: async () => { await gate?.promise; } }), { record, handle } = await f.arm();
  f.registry.observe(record, undefined, () => ({ downloadId: "first" })); await flush();
  gate = deferred(); const result = assert.rejects(f.registry.collect(handle), /WAIT_TIMEOUT/);
  await f.advance(100); await result; gate.resolve(); await flush();
  assert.deepEqual(f.discarded, [{ downloadId: "first" }]); assert.equal(f.registry.records.size, 0);
});

test("late candidate validation never publishes or satisfies the next observer", async () => {
  let gate;
  const f = fixture({ validateScope: async () => { await gate?.promise; } }), first = await f.arm();
  gate = deferred(); const held = gate;
  f.registry.observe(first.record, undefined, () => ({ downloadId: "old" })); await flush();
  await f.advance(100); gate = null; const second = await f.arm(); held.resolve(); await flush();
  assert.deepEqual(f.published, []);
  f.registry.observe(second.record, undefined, () => ({ downloadId: "new" }));
  assert.deepEqual(await f.registry.collect(second.handle), { downloadId: "new" });
});

test("timeout and cancellation retain capacity until actual Page.enable settles without disabling Page", async () => {
  const gate = deferred(), f = fixture({ send: async () => gate.promise, cleanupTimeoutMs: 20 });
  const record = f.reserve(), handle = { ...params, waiterId: record.waiterId };
  const arming = assert.rejects(f.registry.arm(record, [undefined]), /WAIT_TIMEOUT/);
  await flush(); await f.advance(100); await arming;
  assert.throws(() => f.registry.reserve(params), /WAIT_LIMIT/);
  const cancel = assert.rejects(f.registry.cancel(handle), /CLEANUP_TIMEOUT/); await f.advance(20); await cancel;
  assert.equal(f.registry.operations.size, 1);
  const retry = f.registry.cancel(handle); gate.resolve(); await retry;
  assert.equal(f.registry.operations.size, 0); assert.equal(f.registry.records.size, 0);
});

test("new child readiness holds input but a removed child cannot claim a late download", async () => {
  const gate = deferred(); let alive = true;
  const f = fixture({ send: async (_scope, session) => { if (session === "dynamic") await gate.promise; }, sourceAlive: (_scope, session) => session === undefined || alive });
  const { record, handle } = await f.arm(); void f.registry.enable(record, "dynamic");
  let ready = false; const barrier = f.registry.barrier(record).then(() => { ready = true; });
  await flush(); assert.equal(ready, false); gate.resolve(); await barrier;
  alive = false; let accepted = false;
  f.registry.observe(record, "dynamic", () => { accepted = true; return { downloadId: "late" }; });
  assert.equal(accepted, false);
  f.registry.observe(record, undefined, () => ({ downloadId: "root" }));
  assert.deepEqual(await f.registry.collect(handle), { downloadId: "root" });
});

test("an already proven child candidate survives ordinary child removal", async () => {
  let alive = true, gate;
  const f = fixture({ sourceAlive: () => alive, validateScope: async () => { await gate?.promise; } });
  const { record, handle } = await f.arm(undefined, [undefined, "child"]); gate = deferred();
  f.registry.observe(record, "child", () => ({ downloadId: "child-download" }));
  alive = false; gate.resolve(); assert.deepEqual(await f.registry.collect(handle), { downloadId: "child-download" });
});

test("cancelling a matched undelivered result only discards its observation record", async () => {
  const f = fixture(), { record, handle } = await f.arm();
  f.registry.observe(record, undefined, () => ({ downloadId: "incomplete-browser-download" })); await flush();
  await f.registry.cancel(handle);
  assert.deepEqual(f.discarded, [{ downloadId: "incomplete-browser-download" }]);
  assert.deepEqual(f.calls, [undefined]); assert.equal(f.registry.records.size, 0);
});
