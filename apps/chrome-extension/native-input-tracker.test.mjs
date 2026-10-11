import assert from "node:assert/strict";
import { test } from "node:test";
import { NativeInputTracker } from "./browser-input-adapter.js";

function fixture() {
  const tracker = new NativeInputTracker(), token = {}, calls = [];
  tracker.register(42, token);
  return { tracker, token, calls,
    send: (method, params, target = { tabId: 42 }, operation = async () => {}) => tracker.send(target, token, method, params, operation),
    release: (operation = async (...args) => { calls.push(args); }, timeout = 500) => tracker.release(42, token, operation, timeout) };
}

test("raw and CRX share one held state, so an acknowledged up is not released twice", async () => {
  const f = fixture();
  await f.send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", x: 7, y: 9 });
  await f.send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", x: 7, y: 9 });
  await f.release();
  assert.deepEqual(f.calls, []);
  f.tracker.forget(42, f.token);
  assert.deepEqual(f.tracker.controlSnapshot(), { tabIds: [], pending: [] });
});

test("release preserves original child targets, coordinates, key context, and touch cancellation", async () => {
  const f = fixture(), child = { tabId: 42, sessionId: "oopif-session" };
  await f.send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", x: 7, y: 9 }, child);
  await f.send("Input.dispatchKeyEvent", { type: "rawKeyDown", code: "ShiftLeft", key: "Shift", windowsVirtualKeyCode: 16 }, child);
  await f.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 4, y: 5 }] }, child);
  await f.release();
  assert.ok(f.calls.every(([target]) => target.tabId === 42 && target.sessionId === "oopif-session"));
  assert.deepEqual(f.calls.find(([, method]) => method === "Input.dispatchMouseEvent")[2], { type: "mouseReleased", button: "left", x: 7, y: 9, buttons: 0, clickCount: 0 });
  assert.deepEqual(f.calls.find(([, method]) => method === "Input.dispatchTouchEvent")[2], { type: "touchCancel", touchPoints: [] });
  assert.equal(f.calls.at(-1)[2].code, "ShiftLeft");
  assert.equal(f.calls.at(-1)[2].type, "keyUp");
});

test("an RPC timeout cannot hide a native down still in flight from pause cleanup", async () => {
  const f = fixture();
  let delivered;
  const sending = f.send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", x: 3, y: 4 }, { tabId: 42 }, () => new Promise(resolve => { delivered = resolve; }));
  assert.equal(f.tracker.controlSnapshot().pending.length, 1);
  await assert.rejects(f.release(undefined, 15), /cleanup timed out/);
  assert.deepEqual(f.calls, []);
  assert.throws(() => f.tracker.forget(42, f.token), /UNCONFIRMED/);
  assert.throws(() => f.tracker.register(42, {}), /UNCONFIRMED/);
  delivered();
  await sending;
  await f.release();
  assert.equal(f.calls.filter(([, method]) => method === "Input.dispatchMouseEvent").length, 1);
  f.tracker.forget(42, f.token);
});

test("cleanup failure retains native state for an explicit retry on the same token", async () => {
  const f = fixture();
  await f.send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", x: 10, y: 20 });
  await assert.rejects(f.release(async (_target, method) => { if (method === "Input.dispatchMouseEvent") throw new Error("native release failed"); }), /native release failed/);
  assert.throws(() => f.tracker.forget(42, f.token), /UNCONFIRMED/);
  let sent = false;
  assert.throws(() => f.send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left" }, { tabId: 42 }, () => { sent = true; }), /IN_PROGRESS/);
  assert.equal(sent, false);
  await f.release();
  assert.equal(f.calls.at(-1)[2].type, "mouseReleased");
  f.tracker.forget(42, f.token);
});

test("a cleanup up completing after its budget is not replayed by Retry pause", async () => {
  const f = fixture();
  await f.send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", x: 10, y: 20 });
  let finishUp;
  await assert.rejects(f.release((_target, method) => method === "Input.dispatchMouseEvent" ? new Promise(resolve => { finishUp = resolve; }) : Promise.resolve(), 15), /cleanup timed out/);
  finishUp();
  await Promise.allSettled(f.tracker.controlSnapshot().pending);
  await f.release();
  assert.deepEqual(f.calls, []);
  f.tracker.forget(42, f.token);
});

test("an older acknowledged up cannot erase a newer pending down", async () => {
  const f = fixture();
  await f.send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left" });
  let finishUp;
  const up = f.send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left" }, { tabId: 42 }, () => new Promise(resolve => { finishUp = resolve; }));
  await f.send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", x: 2, y: 6 });
  finishUp();
  await up;
  await f.release();
  assert.equal(f.calls.at(-1)[2].type, "mouseReleased");
  assert.equal(f.calls.at(-1)[2].y, 6);
});

test("a late move completion cannot delete a replacement session state holding a button", async () => {
  const f = fixture();
  let finishOldMove;
  const oldMove = f.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 1, y: 2 }, { tabId: 42 }, () => new Promise(resolve => { finishOldMove = resolve; }));
  await f.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 3, y: 4 });
  await f.send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", x: 5, y: 6 });
  finishOldMove();
  await oldMove;
  await f.release();
  assert.deepEqual(f.calls.at(-1)[2], { type: "mouseReleased", x: 5, y: 6, button: "left", buttons: 0, clickCount: 0 });
});

test("closing the original tab is an explicit recovery boundary for unconfirmed input", async () => {
  const f = fixture();
  let completeOld;
  const old = f.send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left" }, { tabId: 42 }, () => new Promise(resolve => { completeOld = resolve; }));
  f.tracker.forget(42, f.token, { destroyed: true });
  const newToken = {};
  f.tracker.register(42, newToken);
  await f.tracker.send({ tabId: 42 }, newToken, "Input.dispatchMouseEvent", { type: "mousePressed", button: "right", x: 11, y: 12 }, async () => {});
  completeOld();
  await old;
  await f.tracker.release(42, newToken, async (...args) => f.calls.push(args));
  assert.deepEqual(f.calls.filter(([, method]) => method === "Input.dispatchMouseEvent").map(([, , params]) => params.button), ["right"]);
});

test("dragCancel retains a pressed button until confirmed native mouseup", async () => {
  const f = fixture();
  await f.send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", x: 7, y: 9 });
  await f.send("Input.dispatchDragEvent", { type: "dragEnter", x: 8, y: 10 });
  await f.send("Input.dispatchDragEvent", { type: "dragCancel", x: 8, y: 10 });
  assert.equal(f.tracker.hasHeld(f.tracker.attachments.get(42)), true);
  await f.release();
  assert.equal(f.calls.filter(([, method, params]) => method === "Input.dispatchMouseEvent" && params.type === "mouseReleased").length, 1);
  assert.equal(f.tracker.hasHeld(f.tracker.attachments.get(42)), false);
});

test("attachment release fences non-input CRX commands as well as input", async () => {
  const f = fixture();
  assert.equal(f.tracker.assertSend(42, f.token), f.tracker.attachments.get(42));
  const releasing = f.release();
  assert.throws(() => f.tracker.assertSend(42, f.token), /RELEASE_IN_PROGRESS/);
  await releasing;
  assert.throws(() => f.tracker.assertSend(42, f.token), /RELEASE_IN_PROGRESS/);
  f.tracker.forget(42, f.token);
  assert.throws(() => f.tracker.assertSend(42, f.token), /ATTACHMENT_CHANGED/);
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const pointerMove = { type: "mouseMoved", button: "none", buttons: 0, x: 8, y: 9 };
function pointerFixture(hooks) {
  const tracker = new NativeInputTracker(hooks), token = {}, native = [];
  tracker.register(42, token);
  return { tracker, token, native,
    begin: check => tracker.beginPointerAction(42, token, check),
    send: (ticket, params = pointerMove, operation = () => { native.push(params.type); return Promise.resolve(params.type); }) =>
      tracker.send({ tabId: 42 }, token, "Input.dispatchMouseEvent", params, operation, ticket) };
}

test("pointer ticket admits one action and its original move/down/up without changing non-input traffic", async () => {
  const f = pointerFixture(), ticket = f.begin();
  assert.equal(Object.isFrozen(ticket), true);
  assert.deepEqual(Object.keys(ticket), ["check", "close"]);
  assert.throws(() => f.begin(), /POINTER_ACTION_BUSY/);
  await f.send(ticket);
  await f.tracker.send({ tabId: 42 }, f.token, "Runtime.evaluate", {}, async () => 7);
  ticket.check();
  await f.send(ticket, { ...pointerMove, type: "mousePressed", button: "left", buttons: 1 });
  ticket.check();
  await f.send(ticket, { ...pointerMove, type: "mouseReleased", button: "left" });
  ticket.close();
  assert.deepEqual(f.native, ["mouseMoved", "mousePressed", "mouseReleased"]);
  assert.throws(() => ticket.check(), /POINTER_ACTION_INVALIDATED/);
  const next = f.begin();
  ticket.close();
  next.check();
  next.close();
});

test("pointer admission rejects held input of every tracked kind, including keys in a child session", async () => {
  const commands = [
    ["Input.dispatchMouseEvent", { type: "mousePressed", button: "left" }],
    ["Input.dispatchKeyEvent", { type: "keyDown", code: "ShiftLeft", key: "Shift" }],
    ["Input.dispatchDragEvent", { type: "dragEnter" }],
    ["Input.setInterceptDrags", { enabled: true }],
    ["Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 1, y: 2 }] }],
    ["Input.emulateTouchFromMouseEvent", { type: "mousePressed", button: "left" }]
  ];
  for (const [method, params] of commands) {
    const f = pointerFixture();
    await f.tracker.send({ tabId: 42, sessionId: "child" }, f.token, method, params, async () => {});
    assert.throws(() => f.begin(), /POINTER_ACTION_BUSY/, method);
  }
});

test("closing a ticket never hides actual in-flight native input from successor admission", async () => {
  const f = pointerFixture(), native = deferred(), ticket = f.begin();
  const sending = f.send(ticket, pointerMove, () => native.promise);
  ticket.close();
  assert.throws(() => f.begin(), /POINTER_ACTION_BUSY/);
  native.resolve("actual ACK");
  assert.equal(await sending, "actual ACK");
  const next = f.begin();
  ticket.close();
  next.check();
  next.close();
});

test("pointer admission includes a pending durable clear after native input has settled", async () => {
  const clear = deferred(), entered = deferred();
  const f = pointerFixture({ released: () => { entered.resolve(); return clear.promise; } });
  const sending = f.send(undefined);
  await entered.promise;
  assert.equal(f.tracker.attachments.get(42).inflight.size, 0);
  assert.throws(() => f.begin(), /POINTER_ACTION_BUSY/);
  clear.resolve();
  await sending;
  f.begin().close();
});

test("foreign input invalidates the pointer ticket but keeps the raw call's existing result", async () => {
  const f = pointerFixture(), ticket = f.begin();
  assert.equal(await f.tracker.send({ tabId: 42, sessionId: "child" }, f.token, "Input.insertText", { text: "raw" }, async () => "raw ACK"), "raw ACK");
  assert.throws(() => ticket.check(), /POINTER_ACTION_INVALIDATED/);
  assert.throws(() => f.send(ticket, { type: "mousePressed", button: "left" }), /POINTER_ACTION_INVALIDATED/);
  assert.equal(f.tracker.hasHeld(f.tracker.attachments.get(42)), false, "rejected ticket cannot record a button intent");
  assert.deepEqual(f.native, []);
  assert.throws(() => f.begin(), /POINTER_ACTION_BUSY/, "invalidated owner must still close its admission");
  ticket.close();
  f.begin().close();
});

test("foreign input during a delayed journal prevents the guarded native send", async () => {
  const journal = deferred();
  let writes = 0;
  const f = pointerFixture({ beforeInput: () => ++writes === 1 ? journal.promise : Promise.resolve() });
  const ticket = f.begin(), sending = f.send(ticket);
  const rejected = assert.rejects(sending, /POINTER_ACTION_INVALIDATED/);
  await f.send(undefined, { ...pointerMove, x: 20 });
  journal.resolve();
  await rejected;
  assert.deepEqual(f.native, ["mouseMoved"], "only the foreign raw input was sent");
  ticket.close();
});

test("synchronous authority failure after a delayed journal preserves its exact error and sends no native input", async () => {
  const journal = deferred(), authorityError = Object.freeze(new Error("original deadline expired"));
  let revoked = false;
  const f = pointerFixture({ beforeInput: () => journal.promise });
  const ticket = f.begin(() => { if (revoked) throw authorityError; });
  const sending = f.send(ticket);
  revoked = true;
  journal.resolve();
  await assert.rejects(sending, error => error === authorityError);
  assert.deepEqual(f.native, []);
  assert.throws(() => ticket.check(), error => error === authorityError);
  ticket.close();
});

test("initial authority rejection does not leak a pointer admission", () => {
  const f = pointerFixture(), error = Object.freeze(new Error("control already ended"));
  assert.throws(() => f.begin(() => { throw error; }), value => value === error);
  assert.throws(() => f.begin(null), /must be a function/);
  f.begin().close();
});

test("release blocks a ticket while draining its delayed input without dispatching it late", async () => {
  const journal = deferred(), calls = [];
  const f = pointerFixture({ beforeInput: () => journal.promise }), ticket = f.begin();
  const sending = f.send(ticket), rejected = assert.rejects(sending, /RELEASE_IN_PROGRESS/);
  let released = false;
  const releasing = f.tracker.release(42, f.token, async (...args) => calls.push(args)).then(() => { released = true; });
  assert.equal(released, false);
  assert.throws(() => ticket.check(), /RELEASE_IN_PROGRESS/);
  assert.throws(() => f.begin(), /RELEASE_IN_PROGRESS/);
  journal.resolve();
  await Promise.all([rejected, releasing]);
  assert.deepEqual(f.native, []);
  assert.deepEqual(calls, []);
  ticket.close();
});

test("failed durability prevents new pointer admission even after its original ticket closes", async () => {
  const f = pointerFixture({ beforeInput: async () => { throw new Error("journal failed"); } }), ticket = f.begin();
  await assert.rejects(f.send(ticket), /journal failed/);
  ticket.close();
  assert.throws(() => f.begin(), /POINTER_ACTION_BUSY/);
  assert.deepEqual(f.native, []);
});

test("closed and forged tickets cannot send or invalidate a successor action", async () => {
  const f = pointerFixture(), old = f.begin();
  old.close();
  const next = f.begin(), other = pointerFixture(), foreign = other.begin();
  for (const stale of [old, { ...next }, foreign, null]) {
    assert.throws(() => f.send(stale), /POINTER_ACTION_INVALIDATED/);
    next.check();
  }
  old.close();
  await f.send(next);
  assert.deepEqual(f.native, ["mouseMoved"]);
  next.close();
  foreign.close();
});

test("attachment replacement isolates stale tickets and a late actual native ACK", async () => {
  const f = pointerFixture(), old = f.begin(), native = deferred();
  const sending = f.send(old, pointerMove, () => native.promise);
  f.tracker.forget(42, f.token, { destroyed: true });
  const replacement = {};
  f.tracker.register(42, replacement);
  const next = f.tracker.beginPointerAction(42, replacement);
  assert.throws(() => old.check(), /ATTACHMENT_CHANGED/);
  assert.throws(() => f.tracker.send({ tabId: 42 }, replacement, "Input.dispatchMouseEvent", pointerMove, () => { throw new Error("must not send"); }, old), /POINTER_ACTION_INVALIDATED/);
  old.close();
  native.resolve();
  await sending;
  next.check();
  assert.equal(f.tracker.attachments.get(42).token, replacement);
  next.close();
});

test("closing a ticket during its journal prevents its late native send", async () => {
  const journal = deferred(), f = pointerFixture({ beforeInput: () => journal.promise }), ticket = f.begin();
  const sending = f.send(ticket), rejected = assert.rejects(sending, /POINTER_ACTION_INVALIDATED/);
  ticket.close();
  assert.throws(() => f.begin(), /POINTER_ACTION_BUSY/);
  journal.resolve();
  await rejected;
  assert.deepEqual(f.native, []);
  f.begin().close();
});
