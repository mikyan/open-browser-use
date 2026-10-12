import assert from "node:assert/strict";
import { test } from "node:test";
import { NativeInputTracker } from "./browser-input-adapter.js";

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const move = ["Input.dispatchMouseEvent", { type: "mouseMoved", button: "none", buttons: 0, x: 10, y: 20 }];
const down = ["Input.dispatchKeyEvent", { type: "rawKeyDown", code: "ShiftLeft", key: "Shift", modifiers: 8 }];
const up = ["Input.dispatchKeyEvent", { type: "keyUp", code: "ShiftLeft", key: "Shift", modifiers: 0 }];
function fixture(options) {
  const tracker = new NativeInputTracker(options), token = {}, target = { tabId: 42 };
  tracker.register(42, token);
  return { tracker, token, target,
    send: (command, operation = async () => ({}), route = target) => tracker.send(route, token, ...command, operation),
    begin: check => tracker.beginHoverAction(42, token, check),
    release: operation => tracker.release(42, token, operation ?? (async () => ({}))) };
}

test("hover idle admission gives an exclusive live ticket and retains foreign-input invalidation", async () => {
  const f = fixture(), ticket = f.begin();
  ticket.check();
  assert.throws(() => f.begin(), /POINTER_ACTION_BUSY/);
  await f.tracker.send(f.target, f.token, ...move, async () => ({}), ticket);
  ticket.check();
  await f.send(["Input.insertText", { text: "foreign" }]);
  assert.throws(() => ticket.check(), /POINTER_ACTION_INVALIDATED/);
  ticket.close();
  const next = f.begin(); ticket.close(); next.check(); next.close();
});

for (const [label, command] of [["key", down], ["mouse", ["Input.dispatchMouseEvent", { type: "mousePressed", button: "left", buttons: 1 }]]]) {
  test(`hover preserves confirmed pre-held ${label} including child-session input`, async () => {
    const f = fixture();
    await f.send(command, undefined, { tabId: 42, sessionId: "child" });
    let checks = 0;
    assert.equal(f.begin(() => checks++), null);
    assert.equal(checks, 1);
    assert.throws(() => f.tracker.beginPointerAction(42, f.token), /POINTER_ACTION_BUSY/);
    await f.release();
  });
}

test("hover cannot mistake an unresolved press for confirmed held input", async () => {
  const f = fixture(), native = deferred(), pending = f.send(down, () => native.promise);
  assert.throws(() => f.begin(), /POINTER_ACTION_BUSY/);
  native.resolve({}); await pending;
  assert.equal(f.begin(), null);
  await f.release();
});

test("known undispatched key intent cannot use the confirmed pre-held hover fallback", async () => {
  const journal = deferred(); let expired = false, sends = 0;
  const f = fixture({ beforeInput: () => journal.promise });
  const ticket = f.tracker.beginPointerAction(42, f.token, () => { if (expired) throw new Error("original deadline"); });
  const pending = f.tracker.send(f.target, f.token, ...down, async () => sends++, ticket);
  const rejected = assert.rejects(pending, /original deadline/);
  expired = true; journal.resolve(); await rejected; ticket.close();
  assert.equal(sends, 0);
  assert.throws(() => f.begin(), /POINTER_ACTION_BUSY/);
  await f.release();
});

test("a prior key ACK cannot confirm a replacement intent with the same key identity", async () => {
  const journal = deferred(); let writes = 0, deny = false;
  const f = fixture({ beforeInput: () => ++writes === 1 ? undefined : journal.promise,
    assertInput: () => { if (deny) throw new Error("scope ended before native send"); } });
  await f.send(down);
  assert.equal(f.begin(), null);
  const pending = f.send(down), rejected = assert.rejects(pending, /scope ended/);
  deny = true; journal.resolve(); await rejected;
  assert.throws(() => f.begin(), /POINTER_ACTION_BUSY/);
  await f.release();
});

for (const [label, prior, failing] of [["move", null, move], ["keydown", null, down], ["keyup", down, up]]) {
  test(`failed native ${label} remains unconfirmed after a later successful input`, async () => {
    const f = fixture(), original = new Error(`unknown ${label}`);
    if (prior) await f.send(prior);
    await assert.rejects(f.send(failing, async () => { throw original; }), error => error === original);
    await f.send(move);
    assert.throws(() => f.begin(), /POINTER_ACTION_BUSY/);
    assert.throws(() => f.tracker.beginPointerAction(42, f.token), /POINTER_ACTION_BUSY/);
    assert.throws(() => f.tracker.register(42, {}), /RELEASE_UNCONFIRMED/);
    assert.throws(() => f.tracker.forget(42, f.token), /RELEASE_UNCONFIRMED/);
    await f.release();
    f.tracker.forget(42, f.token);
    const successor = {};
    f.tracker.register(42, successor);
    f.tracker.beginHoverAction(42, successor).close();
  });
}

test("failed native input cannot clear its durable risk through a later successful move", async () => {
  let cleared = 0;
  const f = fixture({ released: async () => cleared++ });
  await assert.rejects(f.send(move, async () => { throw new Error("native rejected"); }), /native rejected/);
  await f.send(move);
  assert.equal(cleared, 0);
  await f.release();
  assert.equal(cleared, 1);
});

test("failed explicit release does not restore hover admission", async () => {
  const f = fixture();
  await f.send(down);
  await assert.rejects(f.release(async () => { throw new Error("release rejected"); }), /release rejected/);
  assert.throws(() => f.begin(), /RELEASE_IN_PROGRESS/);
  assert.throws(() => f.tracker.register(42, {}), /RELEASE_UNCONFIRMED/);
  await f.release();
  f.tracker.forget(42, f.token);
});

test("hover admission checks the original authority even on the legacy held-input path", async () => {
  const f = fixture(), denied = new Error("old turn expired");
  await f.send(down);
  assert.throws(() => f.begin(() => { throw denied; }), error => error === denied);
  assert.throws(() => f.begin(() => { f.tracker.attachments.get(42).blocked = true; }), /RELEASE_IN_PROGRESS/);
  await f.release();
});

test("hover admission rejects attachment replacement during the synchronous authority check", () => {
  const f = fixture(), successor = {};
  assert.throws(() => f.begin(() => {
    f.tracker.forget(42, f.token); f.tracker.register(42, successor);
  }), /INPUT_ATTACHMENT_CHANGED/);
  f.tracker.beginHoverAction(42, successor).close();
});

test("hover admission includes pending durable clear after native ACK", async () => {
  const gate = deferred(), entered = deferred();
  const f = fixture({ released: () => { entered.resolve(); return gate.promise; } });
  const pending = f.send(move); await entered.promise;
  assert.throws(() => f.begin(), /POINTER_ACTION_BUSY/);
  gate.resolve(); await pending;
  f.begin().close();
});

test("hover pre-held fallback cannot pass a pending durable mark or its failure", async () => {
  const gate = deferred(), entered = deferred(); let writes = 0;
  const f = fixture({ beforeInput: () => { if (++writes > 1) { entered.resolve(); return gate.promise; } } });
  await f.send(down);
  const pending = f.send(move), failed = assert.rejects(pending, /journal rejected/);
  await entered.promise;
  assert.throws(() => f.begin(), /POINTER_ACTION_BUSY/);
  gate.reject(new Error("journal rejected")); await failed;
  assert.throws(() => f.begin(), /POINTER_ACTION_BUSY/);
  await f.release();
});

for (const [label, command] of [
  ["drag", ["Input.dispatchDragEvent", { type: "dragEnter" }]],
  ["interception", ["Input.setInterceptDrags", { enabled: true }]],
  ["touch", ["Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 1, y: 2 }] }]],
  ["emulation", ["Input.emulateTouchFromMouseEvent", { type: "mousePressed", button: "left" }]]
]) test(`hover refuses ${label} even alongside confirmed held keys`, async () => {
  const f = fixture(); await f.send(down); await f.send(command);
  assert.throws(() => f.begin(), /POINTER_ACTION_BUSY/);
  await f.release();
});

test("disabled drag interception still excludes hover until its actual cancellation", async () => {
  const f = fixture(); await f.send(down);
  await f.send(["Input.setInterceptDrags", { enabled: true }]);
  await f.send(["Input.setInterceptDrags", { enabled: false }]);
  assert.throws(() => f.begin(), /POINTER_ACTION_BUSY/);
  await f.send(["Input.dispatchDragEvent", { type: "dragCancel" }]);
  assert.equal(f.begin(), null);
  await f.release();
});

test("hover refuses a closed action with original cleanup resources still owned", async () => {
  const f = fixture(), ticket = f.tracker.beginPointerAction(42, f.token);
  ticket.deferCleanup(() => true); ticket.close();
  assert.throws(() => f.begin(), /POINTER_ACTION_BUSY/);
  await f.release();
});

test("old native rejection cannot mark a positively destroyed attachment's successor unconfirmed", async () => {
  const f = fixture(), native = deferred(), successor = {};
  const pending = f.send(move, () => native.promise), rejected = assert.rejects(pending, /old native/);
  f.tracker.forget(42, f.token, { destroyed: true }); f.tracker.register(42, successor);
  const ticket = f.tracker.beginHoverAction(42, successor);
  native.reject(new Error("old native")); await rejected;
  ticket.check(); ticket.close();
  f.tracker.beginHoverAction(42, successor).close();
});
