import assert from "node:assert/strict";
import { test } from "node:test";
import { NativeInputTracker } from "./browser-input-adapter.js";

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const text = ["Input.insertText", { text: "ordinary text" }];
const move = ["Input.dispatchMouseEvent", { type: "mouseMoved", button: "none", buttons: 0 }];
function fixture(options) {
  const tracker = new NativeInputTracker(options), token = {}, target = { tabId: 42 };
  tracker.register(42, token);
  return { tracker, token, target,
    begin: check => tracker.beginFillAction(42, token, check),
    send: (command, operation = async () => ({}), ticket, route = target) => tracker.send(route, token, ...command, operation, ticket),
    release: operation => tracker.release(42, token, operation ?? (async () => ({}))) };
}

test("fill owns an idle input ticket; foreign input invalidates it and old close cannot retire a successor", async () => {
  const f = fixture(), ticket = f.begin();
  assert.equal(typeof ticket.deferCleanup, "function");
  assert.throws(() => f.begin(), /OBU_FILL_ACTION_BUSY/);
  assert.throws(() => f.tracker.beginPointerAction(42, f.token), /OBU_POINTER_ACTION_BUSY/);
  await f.send(text, undefined, ticket); ticket.check();
  await f.send(move);
  assert.throws(() => ticket.check(), /OBU_POINTER_ACTION_INVALIDATED/);
  ticket.close();
  const successor = f.begin(); ticket.close(); successor.check(); successor.close();
});

for (const [label, command] of [
  ["Control", ["Input.dispatchKeyEvent", { type: "rawKeyDown", code: "ControlLeft", key: "Control", modifiers: 2 }]],
  ["Shift", ["Input.dispatchKeyEvent", { type: "rawKeyDown", code: "ShiftLeft", key: "Shift", modifiers: 8 }]],
  ["mouse button", ["Input.dispatchMouseEvent", { type: "mousePressed", button: "left", buttons: 1 }]]
]) test(`fill refuses even confirmed pre-held ${label} in a child session without using hover's legacy fallback`, async () => {
  const f = fixture(); let sent = 0;
  await f.send(command, async () => sent++, undefined, { tabId: 42, sessionId: "child" });
  assert.equal(f.tracker.beginHoverAction(42, f.token), null);
  assert.throws(() => f.begin(), /OBU_FILL_ACTION_BUSY/);
  assert.equal(sent, 1);
  await f.release();
});

test("fill excludes active drag interception and accepts its confirmed idle release", async () => {
  const f = fixture();
  await f.send(["Input.setInterceptDrags", { enabled: true }]);
  assert.throws(() => f.begin(), /OBU_FILL_ACTION_BUSY/);
  await f.send(["Input.setInterceptDrags", { enabled: false }]);
  f.begin().close();
});

test("fill excludes native input still pending and failed input despite a later ACK", async () => {
  const f = fixture(), native = deferred();
  const sending = f.send(text, () => native.promise), rejected = assert.rejects(sending, /unknown native completion/);
  assert.throws(() => f.begin(), /OBU_FILL_ACTION_BUSY/);
  native.reject(new Error("unknown native completion")); await rejected;
  await f.send(move);
  assert.throws(() => f.begin(), /OBU_FILL_ACTION_BUSY/);
  await f.release();
});

test("fill includes both pending durable input marking and pending durable release", async () => {
  for (const hook of ["beforeInput", "released"]) {
    const gate = deferred(), entered = deferred();
    const f = fixture({ [hook]: () => { entered.resolve(); return gate.promise; } });
    const sending = f.send(text); await entered.promise;
    assert.throws(() => f.begin(), /OBU_FILL_ACTION_BUSY/);
    gate.resolve(); await sending;
    f.begin().close();
  }
});

test("fill rechecks its original authority after journal ACK and never sends expired text", async () => {
  const gate = deferred(), entered = deferred(); let expired = false, native = 0;
  const f = fixture({ beforeInput: () => { entered.resolve(); return gate.promise; } });
  const original = new Error("original fill deadline expired");
  const ticket = f.begin(() => { if (expired) throw original; });
  const sending = f.send(text, async () => native++, ticket), rejected = assert.rejects(sending, error => error === original);
  await entered.promise; expired = true; gate.resolve(); await rejected;
  assert.equal(native, 0); ticket.close(); await f.release();
});

test("fill cleanup drains its actual native input before releasing original renderer resources", async () => {
  const f = fixture(), native = deferred(), cleanup = deferred(), entered = deferred(), order = [];
  const ticket = f.begin();
  ticket.deferCleanup(async () => { order.push("cleanup"); entered.resolve(); await cleanup.promise; return true; });
  const sending = f.send(text, async () => { await native.promise; order.push("native ACK"); }, ticket);
  ticket.close();
  let released = false;
  const release = f.release().then(() => { released = true; });
  await Promise.resolve();
  assert.deepEqual(order, []); assert.equal(released, false);
  assert.throws(() => f.begin(), /OBU_INPUT_RELEASE_IN_PROGRESS/);
  native.resolve(); await sending; await entered.promise;
  assert.deepEqual(order, ["native ACK", "cleanup"]); assert.equal(released, false);
  assert.ok(f.tracker.controlSnapshot().pending.length > 0);
  cleanup.resolve(); await release;
  f.tracker.forget(42, f.token);
  assert.deepEqual(f.tracker.controlSnapshot(), { tabIds: [], pending: [] });
});

test("fill retains a failed exact renderer cleanup for explicit retry without replaying text", async () => {
  const f = fixture(), ticket = f.begin(); let attempts = 0, native = 0;
  ticket.deferCleanup(async () => { if (++attempts === 1) throw new Error("resource release rejected"); return true; });
  await f.send(text, async () => native++, ticket); ticket.close();
  await assert.rejects(f.release(), /resource release rejected/);
  assert.throws(() => f.begin(), /OBU_INPUT_RELEASE_IN_PROGRESS/);
  assert.throws(() => f.tracker.register(42, {}), /OBU_INPUT_RELEASE_UNCONFIRMED/);
  await f.release();
  assert.equal(native, 1); assert.equal(attempts, 2);
});

test("fill's synchronous authority check cannot substitute a successor attachment", () => {
  const f = fixture(), successor = {};
  assert.throws(() => f.begin(() => {
    f.tracker.forget(42, f.token); f.tracker.register(42, successor);
  }), /OBU_POINTER_ACTION_INVALIDATED: pointer authority changed during its check/);
  f.tracker.beginFillAction(42, successor).close();
});
