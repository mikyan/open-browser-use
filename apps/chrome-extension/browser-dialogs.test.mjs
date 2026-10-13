import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { BrowserDialogs, validateDialog } from "./browser-dialogs.js";

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const params = { session_id: "task", turn_id: "turn", control_epoch: 1, tabId: 7, type: "confirm", accept: true, timeoutMs: 500 };
function fixture(t, extra = {}, options = {}) {
  const registry = new BrowserDialogs(options), page = new EventEmitter(), calls = [], hooks = {};
  page._channel = { async updateSubscription(value) { calls.push(["subscription", value.enabled]); await hooks.subscription?.(value); } };
  const record = registry.reserve({ ...params, ...extra });
  const scope = { ...params, attachment: {} };
  const adapter = { validateScope: async () => { await hooks.validate?.(); }, assertScope: () => { hooks.assert?.(); }, prepareResponse: (_scope, dialog) => async (decision, check) => {
    await hooks.beforeSend?.();
    let failure;
    try { check?.(); } catch (reason) { failure = reason; }
    const submitted = failure ? { accept: dialog.type() === "beforeunload" } : decision;
    calls.push(["response", submitted]); await hooks.native?.();
    return { fallback: Boolean(failure), error: failure };
  } };
  const arm = () => registry.arm(record, page, scope, adapter);
  const open = (type = "confirm", message = "Proceed?", defaultValue = "") => page.emit("dialog", { type: () => type, message: () => message, defaultValue: () => defaultValue });
  const handle = { session_id: "task", turn_id: "turn", control_epoch: 1, tabId: 7, dialogId: record.dialogId };
  t.after(async () => { hooks.subscription = hooks.validate = hooks.native = hooks.beforeSend = undefined; await registry.invalidateAll().catch(() => {}); for (const value of registry.records.values()) registry.clearTimer(value.timer); });
  return { registry, record, page, calls, hooks, arm, open, handle };
}

test("strict dialog schema preserves empty message/text and rejects unknown or malformed data", () => {
  assert.equal(validateDialog({ ...params, message: "" }).message, "");
  assert.equal(validateDialog({ ...params, type: "prompt", promptText: "" }).promptText, "");
  for (const extra of [{ accept: 1 }, { type: "custom" }, { promptText: "x" }, { type: "prompt", accept: false, promptText: "x" },
    { timeoutMs: null }, { timeoutMs: 0 }, { timeoutMs: 120001 }, { message: "\ud800" }, { message: "x".repeat(8193) }, { unknown: true }])
    assert.throws(() => validateDialog({ ...params, ...extra }), /OBU_DIALOG_INVALID/);
});

test("ready waits actual subscription ACK; matching events before ready keep default and do not consume", async t => {
  const f = fixture(t), gate = deferred();
  f.hooks.subscription = ({ enabled }) => enabled ? gate.promise : undefined;
  let ready = false;
  const arming = f.arm().then(value => { ready = true; return value; });
  await tick(); f.open(); await tick();
  assert.equal(ready, false); assert.equal(f.record.state, "arming");
  assert.deepEqual(f.calls.filter(([kind]) => kind === "response"), [["response", { accept: false }]]);
  gate.resolve(); await arming; f.open();
  assert.equal((await f.registry.collect(f.handle)).accepted, true);
});

test("unmatched default and accepted prompt retain exact native metadata and one shot", async t => {
  const f = fixture(t, { type: "prompt", message: "Name?", promptText: "林晓" });
  await f.arm(); f.open("beforeunload", "Leave?"); await tick();
  f.open("alert", "Other"); await tick();
  f.open("prompt", "Name?", "old");
  assert.deepEqual(await f.registry.collect(f.handle), { type: "prompt", message: "Name?", defaultValue: "old", accepted: true, promptText: "林晓" });
  f.open("prompt", "Name?");
  assert.deepEqual(f.calls.filter(([kind]) => kind === "response").map(value => value[1]), [{ accept: true }, { accept: false }, { accept: true, promptText: "林晓" }]);
  assert.equal(f.page.listenerCount("dialog"), 0);
});

test("oversized native metadata gets one default response and explicit failure", async t => {
  const f = fixture(t); await f.arm(); f.open("confirm", "x".repeat(8193));
  await assert.rejects(f.registry.collect(f.handle), /OBU_DIALOG_FAILED/);
  assert.deepEqual(f.calls.filter(([kind]) => kind === "response"), [["response", { accept: false }]]);
});

test("one active handler per tab excludes other owners and only releases after ACK/disable", async t => {
  const f = fixture(t), gate = deferred(); await f.arm();
  assert.throws(() => f.registry.reserve({ ...params, session_id: "other" }), /OBU_DIALOG_BUSY/);
  f.hooks.native = () => gate.promise; f.open(); await tick();
  assert.throws(() => f.registry.reserve(params), /OBU_DIALOG_BUSY/);
  gate.resolve(); await f.registry.collect(f.handle); await tick();
  const next = f.registry.reserve(params); assert.ok(next);
});

test("cancel before native dispatch withdraws choice, drains exactly one default and rejects old collect", async t => {
  const f = fixture(t), gate = deferred(); await f.arm();
  f.hooks.beforeSend = () => gate.promise; f.open(); await tick();
  let cancelled = false; const cancel = f.registry.cancel(f.handle).then(() => { cancelled = true; });
  await tick(); assert.equal(cancelled, false); assert.equal(f.calls.some(([kind]) => kind === "response"), false);
  gate.resolve(); await cancel;
  assert.deepEqual(f.calls.filter(([kind]) => kind === "response"), [["response", { accept: false }]]);
  await assert.rejects(f.registry.collect(f.handle), /OBU_DIALOG_EXPIRED/);
});

test("original deadline covers response; timeout retains real pending operation and never replays", async t => {
  const f = fixture(t, { timeoutMs: 25 }), gate = deferred(); await f.arm();
  f.hooks.native = () => gate.promise; f.open();
  await assert.rejects(f.registry.collect(f.handle), /OBU_DIALOG_TIMEOUT/);
  assert.ok(f.registry.controlSnapshot().pending.length > 0);
  assert.throws(() => f.registry.reserve(params), /OBU_DIALOG_BUSY/);
  gate.resolve(); await tick();
  assert.equal(f.calls.filter(([kind]) => kind === "response").length, 1);
});

test("expiry during subscription cannot publish ready and late enable is followed by confirmed disable", async t => {
  const f = fixture(t, { timeoutMs: 20 }), gate = deferred();
  f.hooks.subscription = ({ enabled }) => enabled ? gate.promise : undefined;
  await assert.rejects(f.arm(), /OBU_DIALOG_TIMEOUT/);
  assert.equal(f.page.listenerCount("dialog"), 0);
  assert.throws(() => f.registry.reserve(params), /OBU_DIALOG_BUSY/);
  gate.resolve(); await tick(); await tick();
  assert.deepEqual(f.calls, [["subscription", true], ["subscription", false]]);
  assert.equal(f.registry.byTab.size, 0);
});

test("document commit revokes pending decision but not already submitted beforeunload result", async t => {
  const f = fixture(t, { type: "beforeunload", accept: false }); await f.arm();
  const gate = deferred(); f.hooks.native = () => gate.promise; f.open("beforeunload"); await tick();
  await f.registry.documentChanged(7); gate.resolve();
  assert.equal((await f.registry.collect(f.handle)).accepted, false);
  const pending = fixture(t); await pending.arm(); await pending.registry.documentChanged(7);
  await assert.rejects(pending.registry.collect(pending.handle), /OBU_DIALOG_EXPIRED/);
});

test("failed disable blocks reuse and explicit cancellation retries only subscription cleanup", async t => {
  const f = fixture(t); await f.arm();
  let failure = true; f.hooks.subscription = ({ enabled }) => { if (!enabled && failure) throw new Error("native channel failure"); };
  f.open(); await assert.rejects(f.registry.collect(f.handle), /OBU_DIALOG_FAILED/);
  assert.throws(() => f.registry.reserve(params), /OBU_DIALOG_BUSY/);
  failure = false; await f.registry.cancel(f.handle);
  assert.equal(f.registry.byTab.size, 0); assert.equal(f.calls.filter(([kind]) => kind === "response").length, 1);
});

test("foreign handle cannot collect or cancel original decision", async t => {
  const f = fixture(t); await f.arm();
  await assert.rejects(f.registry.cancel({ ...f.handle, turn_id: "different" }), /OBU_DIALOG_EXPIRED/);
  await assert.rejects(f.registry.collect({ ...f.handle, session_id: "different" }), /OBU_DIALOG_EXPIRED/);
  assert.equal(f.page.listenerCount("dialog"), 1);
});

test("terminal TTL evicts records only after real cleanup; capacity is reusable", async t => {
  let now = 0;
  const f = fixture(t, {}, { now: () => now, ttlMs: 5, maxTotal: 1 }), gate = deferred();
  await f.arm(); f.hooks.native = () => gate.promise; f.open(); await tick();
  f.registry.fail(f.record, new Error("cancelled"));
  now = 10; f.registry.releaseSlot(f.record);
  assert.throws(() => f.registry.reserve({ ...params, tabId: 8 }), /OBU_DIALOG_LIMIT/);
  gate.resolve(); await tick(); await tick();
  assert.equal(f.registry.records.size, 0);
  assert.ok(f.registry.reserve({ ...params, tabId: 8 }));
});

test("cancel of an already retired ID is idempotent, without authorizing any new response", async t => {
  const f = fixture(t); await f.arm(); await f.registry.cancel(f.handle);
  assert.deepEqual(await f.registry.cancel(f.handle), {});
  assert.equal(f.calls.some(([kind]) => kind === "response"), false);
  await assert.rejects(f.registry.collect(f.handle), /OBU_DIALOG_EXPIRED/);
});

test("confirmed original Page close retires its subscription even if disable ACK rejects", async t => {
  const f = fixture(t), gate = deferred(); let closed = false;
  f.page.isClosed = () => closed;
  await f.arm();
  f.hooks.subscription = ({ enabled }) => enabled ? undefined : gate.promise;
  f.open(); await tick();
  closed = true; f.page.emit("close"); gate.reject(new Error("channel closed"));
  // The selected result was already natively acknowledged. Page termination
  // proves that this original subscription no longer exists.
  assert.equal((await f.registry.collect(f.handle)).accepted, true);
  await f.registry.cancel(f.handle);
  assert.equal(f.registry.byTab.size, 0);
});
