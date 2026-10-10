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
