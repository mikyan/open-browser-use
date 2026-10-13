import assert from "node:assert/strict";
import test from "node:test";
import { NativeInputTracker } from "./browser-input-adapter.js";

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const down = ["Input.dispatchKeyEvent", { type: "rawKeyDown", code: "ControlLeft", key: "Control", modifiers: 2 }];
function fixture(options) {
  const tracker = new NativeInputTracker(options), token = {}, target = { tabId: 42 };
  tracker.register(42, token);
  return { tracker, token, target, begin: check => tracker.beginKeyboardPress(42, token, check),
    send: (command, operation = async () => ({}), ticket, route = target) => tracker.send(route, token, ...command, operation, ticket),
    release: send => tracker.release(42, token, send ?? (async () => ({}))) };
}

for (const [name, command] of [["key", down], ["button", ["Input.dispatchMouseEvent", { type: "mousePressed", button: "left", buttons: 1 }]]])
  test(`keyboard admission returns an exclusive ticket with confirmed pre-held ${name}`, async () => {
    const f = fixture(); await f.send(command, undefined, undefined, { tabId: 42, sessionId: "child" });
    const ticket = f.begin(); assert.equal(typeof ticket.check, "function"); ticket.check();
    assert.throws(() => f.begin(), /OBU_KEYBOARD_PRESS_REJECTED/);
    ticket.close(); const next = f.begin(); ticket.close(); next.check(); next.close(); await f.release();
  });

test("keyboard rejects actual pending or failed input, and a later ACK does not erase uncertainty", async () => {
  const f = fixture(), gate = deferred(), original = new Error("native key failure");
  const pending = f.send(down, () => gate.promise), rejected = assert.rejects(pending, error => error === original);
  assert.throws(() => f.begin(), /OBU_KEYBOARD_PRESS_REJECTED/);
  gate.reject(original); await rejected; await f.send(["Input.insertText", { text: "unrelated" }]);
  assert.throws(() => f.begin(), /OBU_KEYBOARD_PRESS_REJECTED/); await f.release();
});

test("keyboard refuses pending mark/clear, drag state and unresolved resource cleanup", async () => {
  for (const hook of ["beforeInput", "released"]) {
    const gate = deferred(), entered = deferred(), f = fixture({ [hook]: () => { entered.resolve(); return gate.promise; } });
    const pending = f.send(["Input.insertText", { text: "one" }]); await entered.promise;
    assert.throws(() => f.begin(), /OBU_KEYBOARD_PRESS_REJECTED/); gate.resolve(); await pending; f.begin().close();
  }
  const f = fixture(); await f.send(["Input.setInterceptDrags", { enabled: true }]);
  assert.throws(() => f.begin(), /OBU_KEYBOARD_PRESS_REJECTED/); await f.release();
  const other = fixture(), ticket = other.tracker.beginPointerAction(42, other.token);
  ticket.deferCleanup(async () => true); ticket.close();
  assert.throws(() => other.begin(), /OBU_KEYBOARD_PRESS_REJECTED/); await other.release();
});

test("keyboard ticket rechecks original action after persistence and does not dispatch an expired key", async () => {
  const gate = deferred(), entered = deferred(); let expired = false, calls = 0;
  const f = fixture({ beforeInput: () => { entered.resolve(); return gate.promise; } });
  const ticket = f.begin(() => { if (expired) throw new Error("original keyboard deadline"); });
  const pending = f.send(down, async () => calls++, ticket), rejected = assert.rejects(pending, /original keyboard deadline/);
  await entered.promise; expired = true; gate.resolve(); await rejected;
  assert.equal(calls, 0); ticket.close(); await f.release();
});

test("release waits original key ACK and retains failed cleanup without replaying the press", async () => {
  const f = fixture(), gate = deferred(), ticket = f.begin(), commands = [];
  const pending = f.send(down, () => gate.promise, ticket); ticket.close();
  const release = f.release(async (_target, method, params) => { commands.push([method, params.type]); throw new Error("release failed"); });
  const rejected = assert.rejects(release, /release failed/); await Promise.resolve(); assert.deepEqual(commands, []);
  gate.resolve({}); await pending; await rejected;
  assert.throws(() => f.begin(), /RELEASE_IN_PROGRESS/);
  await f.release(async (_target, method, params) => commands.push([method, params.type]));
  assert.deepEqual(commands, [["Input.dispatchKeyEvent", "keyUp"], ["Input.dispatchKeyEvent", "keyUp"]]);
});

test("foreign input or attachment replacement cannot reuse the original keyboard ticket", async () => {
  const f = fixture(), ticket = f.begin(); await f.send(["Input.insertText", { text: "foreign" }]);
  assert.throws(() => ticket.check(), /POINTER_ACTION_INVALIDATED/); ticket.close();
  const successor = {};
  assert.throws(() => f.begin(() => { f.tracker.forget(42, f.token); f.tracker.register(42, successor); }), /POINTER_ACTION_INVALIDATED/);
  f.tracker.beginKeyboardPress(42, successor).close();
});
