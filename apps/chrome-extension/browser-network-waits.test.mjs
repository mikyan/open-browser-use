import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { BrowserNetworkWaits, validateNetworkWait } from "./browser-network-waits.js";

const params = extra => ({ session_id: "session", turn_id: "turn", control_epoch: 1, tabId: 42, event: "response", match: { url: "https://example.test/api" }, timeoutMs: 1000, ...extra });
const nextTurn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture(t, options = {}) {
  let now = 0, nextTimer = 0;
  const timers = new Map();
  const registry = new BrowserNetworkWaits({ now: () => now, setTimer: (fn, ms) => { const id = ++nextTimer; timers.set(id, { fn, at: now + ms }); return id; }, clearTimer: id => timers.delete(id), ...options });
  const page = new EventEmitter();
  page.setMaxListeners(0);
  const scope = { session_id: "session", turn_id: "turn", control_epoch: 1, tabId: 42, attachment: 7 };
  t.after(() => registry.invalidateAll());
  return { registry, page, scope, timers,
    handle: record => ({ ...Object.fromEntries(["session_id", "turn_id", "control_epoch", "tabId"].map(key => [key, record.params[key]])), waiterId: record.waiterId }),
    arm: async (extra, validator = async () => {}) => { const record = registry.reserve(params(extra)); const ready = await registry.arm(record, page, { ...scope, ...Object.fromEntries(["session_id", "turn_id", "control_epoch", "tabId"].map(key => [key, record.params[key]])) }, validator); return { record, ready }; },
    advance: async ms => { now += ms; for (const [id, timer] of [...timers]) if (timer.at <= now && timers.delete(id)) timer.fn(); await nextTurn(); }
  };
}
function request(extra = {}) {
  return { url: () => "https://example.test/api", method: () => "POST", resourceType: () => "fetch", frame: () => ({ url: () => "https://example.test/frame" }), redirectedFrom: () => null, ...extra };
}
function response(req = request(), extra = {}) { return { request: () => req, status: () => 200, statusText: () => "OK", ...extra }; }

test("default timers keep the browser global receiver instead of using the registry as a native receiver", async t => {
  const nativeSet = globalThis.setTimeout.bind(globalThis), nativeClear = globalThis.clearTimeout.bind(globalThis);
  let scheduled = 0, cleared = 0;
  t.mock.method(globalThis, "setTimeout", function(...args) {
    if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
    scheduled++;
    return nativeSet(...args);
  });
  t.mock.method(globalThis, "clearTimeout", function(...args) {
    if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
    cleared++;
    return nativeClear(...args);
  });
  const registry = new BrowserNetworkWaits(), page = new EventEmitter();
  try {
    const record = registry.reserve(params());
    await registry.arm(record, page, { ...record.params, attachment: 1 }, async () => {});
    page.emit("response", response());
    const handle = { session_id: "session", turn_id: "turn", control_epoch: 1, tabId: 42, waiterId: record.waiterId };
    assert.equal((await registry.collect(handle)).status, 200);
    await registry.cancel(handle);
    assert.ok(scheduled > 0); assert.ok(cleared > 0);
  } finally { registry.invalidateAll(); }
});

test("ready waits for the actual ordered subscription ACK rather than EventEmitter registration", async t => {
  const f = fixture(t), gate = deferred(); let settled = false;
  f.page._channel = { updateSubscription: ({ enabled }) => enabled ? gate.promise : Promise.resolve() };
  const pending = f.arm().then(value => { settled = true; return value; });
  await nextTurn();
  try { assert.equal(settled, false); }
  finally { gate.resolve(); await pending; }
});

test("selected result waits for actual unsubscribe ACK and rechecks original authority afterwards", async t => {
  const f = fixture(t), gate = deferred(); let revoked = false, settled = false;
  f.page._channel = { updateSubscription: ({ enabled }) => enabled ? Promise.resolve() : gate.promise };
  const record = f.registry.reserve(params());
  await f.registry.arm(record, f.page, f.scope, async () => {}, {
    assertScope() { if (revoked) throw new Error("OBU_SITE_ACCESS_DENIED: original authority revoked"); }
  });
  f.page.emit("response", response());
  const collecting = f.registry.collect(f.handle(record)).then(value => { settled = true; return value; });
  collecting.catch(() => {});
  await nextTurn();
  try { assert.equal(settled, false); revoked = true; gate.resolve(); await assert.rejects(collecting, /OBU_SITE_ACCESS_DENIED/); }
  finally { gate.resolve(); await collecting.catch(() => {}); }
});

test("the first candidate is captured synchronously and cannot borrow a later emitter document", async t => {
  const f = fixture(t), gate = deferred(); let selected = false, current = "original", captures = 0;
  const record = f.registry.reserve(params());
  await f.registry.arm(record, f.page, f.scope, async () => { if (selected) await gate.promise; }, {
    captureCandidate(req) {
      captures++; selected = true; const original = current;
      return { frameUrl: "https://example.test/original", check() { assert.equal(current, original, "OBU_SITE_ACCESS_UNVERIFIED: original document changed"); } };
    },
    assertScope() { record.candidate?.check(); }
  });
  f.page.emit("response", response(request(), { statusText: () => "original" }));
  current = "successor";
  f.page.emit("response", response(request(), { statusText: () => "later" }));
  gate.resolve(); await nextTurn();
  assert.equal(captures, 1);
  await assert.rejects(f.registry.collect(f.handle(record)), /OBU_SITE_ACCESS_UNVERIFIED/);
});

test("two cancels join the same pending cleanup and only explicit settled failure may retry", async t => {
  const f = fixture(t), gate = deferred(); let disabled = 0, firstDone = false, secondDone = false;
  f.page._channel = { async updateSubscription({ enabled }) { if (!enabled) { disabled++; await gate.promise; } } };
  const { record } = await f.arm();
  const first = f.registry.cancel(f.handle(record)).then(() => { firstDone = true; });
  const second = f.registry.cancel(f.handle(record)).then(() => { secondDone = true; });
  await nextTurn();
  try {
    assert.equal(firstDone, false); assert.equal(secondDone, false); assert.equal(disabled, 1);
    assert.deepEqual(f.registry.controlSnapshot().tabIds, [42]);
  } finally { gate.resolve(); await Promise.all([first, second]); }
  assert.deepEqual(f.registry.controlSnapshot().tabIds, []);
  let fail = true;
  f.page._channel.updateSubscription = async ({ enabled }) => { if (!enabled) { disabled++; if (fail) throw Error("local server ACK rejected"); } };
  const next = await f.arm();
  await assert.rejects(f.registry.cancel(f.handle(next.record)), /cleanup is unconfirmed/);
  assert.deepEqual(f.registry.controlSnapshot().tabIds, [42]); fail = false;
  await f.registry.cancel(f.handle(next.record)); assert.deepEqual(f.registry.controlSnapshot().tabIds, []);
  assert.equal(disabled, 3);
});

test("delayed cleanup preserves newer wait and diagnostics listeners in actual dispatch order", async t => {
  const f = fixture(t), gate = deferred(), sent = []; let first = true;
  f.page._channel = { async updateSubscription({ enabled }) { sent.push(enabled); if (first) { first = false; await gate.promise; } } };
  const arming = f.arm(); await nextTurn();
  const original = [...f.registry.records.values()][0];
  const cancelled = f.registry.cancel(f.handle(original));
  const diagnostic = () => {}; f.page.on("response", diagnostic);
  const successor = f.arm();
  const originalFailure = assert.rejects(arming, /EXPIRED/);
  gate.resolve(); await originalFailure; await cancelled;
  const next = await successor;
  assert.deepEqual(sent, [true, true, true]);
  await f.registry.cancel(f.handle(next.record)); assert.equal(sent.at(-1), true);
  assert.equal(f.page.listenerCount("response"), 1); f.page.off("response", diagnostic);
});

test("late actual enable ACK stays in the cleanup drain after the original arm deadline", async t => {
  const f = fixture(t), gate = deferred(), sent = [];
  f.page._channel = { async updateSubscription({ enabled }) { sent.push(enabled); if (enabled) await gate.promise; } };
  const arming = assert.rejects(f.arm({ timeoutMs: 10 }), /TIMEOUT/);
  await nextTurn(); await f.advance(10); await arming;
  assert.equal(f.registry.records.size, 0); assert.deepEqual(f.registry.controlSnapshot().tabIds, [42]);
  let drained = false;
  const released = f.registry.invalidateAll().then(() => { drained = true; }); await nextTurn();
  assert.equal(drained, false);
  gate.resolve(); await released; assert.deepEqual(sent, [true, false]);
  assert.deepEqual(f.registry.controlSnapshot().tabIds, []);
});

test("old Page cleanup cannot update a successor Page on the same tab", async t => {
  const f = fixture(t), gate = deferred(), oldCalls = [], nextCalls = [];
  f.page._channel = { async updateSubscription({ enabled }) { oldCalls.push(enabled); if (!enabled) await gate.promise; } };
  const old = await f.arm(), cancelled = f.registry.cancel(f.handle(old.record));
  const nextPage = new EventEmitter(); nextPage._channel = { async updateSubscription({ enabled }) { nextCalls.push(enabled); } };
  const nextRecord = f.registry.reserve(params());
  await f.registry.arm(nextRecord, nextPage, { ...f.scope, attachment: 8 }, async () => {});
  await nextTurn(); assert.deepEqual(nextCalls, [true]);
  gate.resolve(); await cancelled; assert.deepEqual(oldCalls, [true, false]); assert.deepEqual(nextCalls, [true]);
  nextPage.emit("response", response()); assert.equal((await f.registry.collect(f.handle(nextRecord))).status, 200);
});

test("first denied candidate is terminal and cannot expose or replace it with later allowed metadata", async t => {
  const f = fixture(t), record = f.registry.reserve(params({ match: { url: "/api", urlMatch: "contains" } }));
  let captures = 0;
  await f.registry.arm(record, f.page, f.scope, async () => {}, { captureCandidate() {
    captures++; throw new Error("OBU_SITE_ACCESS_DENIED: original source origin denied");
  } });
  f.page.emit("response", response(request({ url: () => "https://denied.test/api?secret" })));
  f.page.emit("response", response());
  await assert.rejects(f.registry.collect(f.handle(record)), error => {
    assert.match(error.message, /^OBU_SITE_ACCESS_DENIED:/); assert.equal(error.message.includes("secret"), false); return true;
  });
  assert.equal(captures, 1); assert.equal(record.value, undefined);
});

test("strict params and UTF-8 budgets fail synchronously before reserving capacity", t => {
  const f = fixture(t);
  for (const bad of [
    { extra: true }, { control_epoch: 0 }, { tabId: 1.5 }, { event: "requestfailed" }, { timeoutMs: 0 }, { timeoutMs: 1.5 },
    { match: { url: "x", predicate: "code" } }, { match: { url: "" } }, { match: { url: "字".repeat(1400) } },
    { match: { url: "x", urlMatch: "regex" } }, { match: { url: "x", method: "界".repeat(43) } },
    { event: "request", match: { url: "x", status: 200 } }, { match: { url: "x", status: 600 } }
  ]) assert.throws(() => f.registry.reserve(params(bad)));
  assert.equal(f.registry.records.size, 0); assert.equal(f.timers.size, 0);
  const value = validateNetworkWait(params());
  assert.ok(Object.isFrozen(value)); assert.ok(Object.isFrozen(value.match));
});

test("ready first registration retains an event before ACK and returns the first native match idempotently", async t => {
  const f = fixture(t), readyGate = deferred(); let validations = 0;
  const record = f.registry.reserve(params());
  const arming = f.registry.arm(record, f.page, f.scope, async () => { if (++validations === 2) await readyGate.promise; });
  await nextTurn();
  assert.equal(f.page.listenerCount("response"), 1);
  f.page.emit("response", response(request(), { statusText: () => "first" }));
  f.page.emit("response", response(request(), { statusText: () => "second" }));
  await nextTurn(); readyGate.resolve();
  const ready = await arming;
  assert.equal(ready.waiterId, record.waiterId); assert.equal(ready.remainingMs, 1000);
  await f.advance(2000);
  const first = await f.registry.collect(f.handle(record));
  assert.equal(first.statusText, "first");
  assert.equal(first.event, "response"); assert.equal(first.status, 200);
  assert.equal(first.frameUrl, "https://example.test/frame");
  assert.deepEqual(await f.registry.collect(f.handle(record)), first);
  assert.equal(f.page.listenerCount("response"), 0);
});

test("URL, method and status match complete native values before bounded display serialization", async t => {
  const f = fixture(t);
  const { record } = await f.arm({ match: { url: "ending", urlMatch: "contains", method: "POST", status: 503 } });
  for (const event of [response(request({ url: () => "ending", method: () => "post" }), { status: () => 503 }), response(request({ url: () => "ending" }))]) f.page.emit("response", event);
  assert.equal(record.state, "pending");
  const long = "字".repeat(3000) + "ending";
  f.page.emit("response", response(request({ url: () => long, frame: () => ({ url: () => "\n".repeat(4096) }) }), { status: () => 503, statusText: () => "\n".repeat(2000) }));
  const result = await f.registry.collect(f.handle(record));
  assert.equal(result.truncated, true); assert.ok(!result.url.includes("ending"));
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 16 * 1024);
  assert.ok(Buffer.byteLength(result.url) <= 4096);
  assert.equal(Object.hasOwn(result, "headers"), false); assert.equal(Object.hasOwn(result, "body"), false);
});

test("one attachment shares weak Request IDs and redirect ancestry across request and response waiters", async t => {
  const f = fixture(t);
  const before = request(), after = request({ redirectedFrom: () => before });
  const a = await f.arm({ event: "request" }), b = await f.arm({ event: "response" });
  f.page.emit("request", before); await nextTurn();
  f.page.emit("response", response(after));
  const first = await f.registry.collect(f.handle(a.record)), second = await f.registry.collect(f.handle(b.record));
  assert.equal(second.redirectedFrom, first.requestId); assert.notEqual(second.requestId, first.requestId);
});

test("old events and request failures do not satisfy response waits; original deadline cannot be renewed", async t => {
  const f = fixture(t);
  f.page.emit("response", response());
  const { record } = await f.arm({ timeoutMs: 100 });
  f.page.emit("requestfailed", request());
  const collected = f.registry.collect(f.handle(record));
  const rejected = assert.rejects(collected, /OBU_NETWORK_WAIT_TIMEOUT/);
  await nextTurn(); await f.advance(100); await rejected;
  await assert.rejects(f.registry.collect(f.handle(record)), /OBU_NETWORK_WAIT_TIMEOUT/);
  await f.registry.cancel(f.handle(record));
  await assert.rejects(f.registry.collect(f.handle(record)), /OBU_NETWORK_WAIT_EXPIRED/);
});

test("an event selected at t99 retains its deadline win while owner validation finishes at t110", async t => {
  const f = fixture(t), gate = deferred(); let delay = false;
  const { record } = await f.arm({ timeoutMs: 100 }, async () => { if (delay) await gate.promise; });
  await f.advance(99); delay = true;
  f.page.emit("response", response());
  const collected = f.registry.collect(f.handle(record));
  await f.advance(11); gate.resolve();
  assert.equal((await collected).status, 200);
  assert.equal(record.selectedAt, 99);
  const later = await f.arm({ timeoutMs: 100 });
  await f.advance(100); f.page.emit("response", response());
  await assert.rejects(f.registry.collect(f.handle(later.record)), /TIMEOUT/);
});

test("an event before ACK cannot extend the original setup and ready deadline", async t => {
  const f = fixture(t), gate = deferred(); let validations = 0;
  const record = f.registry.reserve(params({ timeoutMs: 100 }));
  const arming = f.registry.arm(record, f.page, f.scope, async () => { if (++validations === 2) await gate.promise; });
  const rejected = assert.rejects(arming, /TIMEOUT/);
  await nextTurn(); await f.advance(99); f.page.emit("response", response()); await nextTurn();
  await f.advance(11); await rejected; gate.resolve();
  assert.equal(f.registry.records.size, 0);
});

test("slow collect scope validation preserves the original timed-out terminal instead of deleting it", async t => {
  const f = fixture(t), gate = deferred(); let delay = false;
  const { record } = await f.arm({ timeoutMs: 100 }, async () => { if (delay) await gate.promise; });
  delay = true;
  const collected = assert.rejects(f.registry.collect(f.handle(record)), /TIMEOUT/);
  await nextTurn(); await f.advance(100); await collected;
  assert.equal(f.registry.records.get(record.waiterId), record);
  delay = false; gate.resolve();
  await assert.rejects(f.registry.collect(f.handle(record)), /TIMEOUT/);
  assert.equal(record.state, "timed-out");
});

test("asynchronous owner checks cannot reorder candidates or publish after lost ownership", async t => {
  const f = fixture(t), gate = deferred(); let invalid = false;
  const { record } = await f.arm({}, async () => { if (invalid) { await gate.promise; throw new Error("owner changed"); } });
  invalid = true;
  f.page.emit("response", response(request(), { statusText: () => "first" }));
  f.page.emit("response", response(request(), { statusText: () => "second" }));
  assert.equal(record.state, "matching");
  gate.resolve(); await nextTurn();
  await assert.rejects(f.registry.collect(f.handle(record)), /EXPIRED/);
  assert.equal(f.registry.records.size, 0);
});

test("scope is exact, wrong handles reveal no result, and closing Page invalidates retained matches", async t => {
  const f = fixture(t);
  const { record } = await f.arm();
  f.page.emit("response", response()); await nextTurn();
  for (const changed of [{ session_id: "other" }, { turn_id: "next" }, { control_epoch: 2 }, { tabId: 43 }])
    await assert.rejects(f.registry.collect({ ...f.handle(record), ...changed }), /EXPIRED/);
  assert.deepEqual(await f.registry.cancel({ ...f.handle(record), session_id: "other" }), {});
  assert.equal(f.registry.records.size, 1);
  f.page.emit("close");
  await assert.rejects(f.registry.collect(f.handle(record)), /EXPIRED/);
  assert.equal(f.timers.size, 0); assert.equal(f.page.listenerCount("close"), 0);
});

test("tab, session and global admission limits include retained terminal records and TTL frees capacity", async t => {
  const f = fixture(t, { maxPerTab: 1, maxPerSession: 2, maxTotal: 3, ttlMs: 50 });
  const first = await f.arm(); f.page.emit("response", response()); await nextTurn();
  assert.throws(() => f.registry.reserve(params()), /LIMIT/);
  f.registry.reserve(params({ tabId: 43 }));
  assert.throws(() => f.registry.reserve(params({ tabId: 44 })), /LIMIT/);
  f.registry.reserve(params({ session_id: "other", tabId: 44 }));
  assert.throws(() => f.registry.reserve(params({ session_id: "third", tabId: 45 })), /LIMIT/);
  await f.advance(50);
  await assert.rejects(f.registry.collect(f.handle(first.record)), /EXPIRED/);
  assert.doesNotThrow(() => f.registry.reserve(params()));
});

test("unbound reservations survive raw-to-engine migration, but full invalidation cancels setup and pending collects", async t => {
  const f = fixture(t);
  const bound = await f.arm();
  assert.deepEqual(f.registry.controlSnapshot().tabIds, [42]);
  const reserved = f.registry.reserve(params());
  f.registry.invalidateAttachedTab(42);
  assert.equal(f.registry.records.has(bound.record.waiterId), false);
  assert.equal(f.registry.records.has(reserved.waiterId), true);
  const gate = deferred(); let late = false;
  const operation = f.registry.within(reserved, async () => { await gate.promise; f.registry.check(reserved); late = true; });
  const rejected = assert.rejects(operation, /EXPIRED/);
  const snapshot = f.registry.controlSnapshot();
  assert.deepEqual(snapshot.tabIds, []);
  f.registry.invalidateAll(); await rejected;
  await Promise.allSettled(snapshot.pending);
  gate.resolve(); await nextTurn(); assert.equal(late, false);
  const active = await f.arm();
  const collect = assert.rejects(f.registry.collect(f.handle(active.record)), /EXPIRED/);
  f.registry.invalidateSession("session"); await collect;
  assert.equal(f.timers.size, 0);
});

test("original setup budget expires before late registration and failure frees its reservation", async t => {
  const f = fixture(t), gate = deferred();
  const record = f.registry.reserve(params({ timeoutMs: 10 }));
  const pending = f.registry.arm(record, f.page, f.scope, () => gate.promise);
  const rejected = assert.rejects(pending, /TIMEOUT/);
  await nextTurn(); await f.advance(10); await rejected;
  gate.resolve(); await nextTurn();
  assert.equal(f.page.listenerCount("response"), 0); assert.equal(f.registry.records.size, 0);
  const other = f.registry.reserve(params());
  f.registry.fail(other, new Error("setup failed"));
  assert.equal(f.registry.records.size, 0);
});
