import assert from "node:assert/strict";
import { test } from "node:test";
import { observeCrxInputCommand, releaseCrxInput } from "./browser-input-adapter.js";

function fixture() {
  const transport = { _tabToTarget: new Map([[42, { targetId: "owned" }]]) }, calls = [];
  return { transport, calls,
    observe: (method, params, target = { tabId: 42 }) => observeCrxInputCommand(transport, target, method, params),
    release: () => releaseCrxInput(transport, 42, async (...args) => { calls.push(args); }) };
}
test("cancelled drag releases observed input once at its last position", async () => {
  const f = fixture();
  f.observe("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", x: 20, y: 30 });
  f.observe("Input.dispatchMouseEvent", { type: "mousePressed", button: "right", x: 20, y: 30 });
  f.observe("Input.setInterceptDrags", { enabled: true });
  f.observe("Input.dispatchDragEvent", { type: "dragEnter", x: 40, y: 50 });
  f.transport._tabToTarget.delete(42); // native Page was already closed
  await f.release();
  assert.deepEqual(f.calls.map(([, method]) => method), ["Input.cancelDragging", "Input.setInterceptDrags", "Input.dispatchMouseEvent", "Input.dispatchMouseEvent"]);
  assert.deepEqual(f.calls[2][2], { type: "mouseReleased", button: "left", buttons: 2, x: 40, y: 50, clickCount: 0 });
  assert.equal(f.calls[3][2].buttons, 0);
  await f.release();
  assert.equal(f.calls.length, 4);
});
test("held key cleanup sends native keyup with no remaining modifiers", async () => {
  const f = fixture();
  f.observe("Input.dispatchKeyEvent", { type: "rawKeyDown", code: "ShiftLeft", key: "Shift", windowsVirtualKeyCode: 16, nativeVirtualKeyCode: 16, location: 1 });
  await f.release();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0][1], "Input.dispatchKeyEvent");
  assert.equal(f.calls[0][2].type, "keyUp");
  assert.equal(f.calls[0][2].code, "ShiftLeft");
  assert.equal(f.calls[0][2].modifiers, 0);
});
test("completed drag, completed key and foreign session input need no teardown input", async () => {
  const f = fixture();
  f.observe("Input.dispatchMouseEvent", { type: "mousePressed", button: "left" }, { tabId: 99 });
  f.observe("Input.dispatchMouseEvent", { type: "mousePressed", button: "left" }, { tabId: 42, sessionId: "foreign-child" });
  f.observe("Input.dispatchMouseEvent", { type: "mousePressed", button: "left" });
  f.observe("Input.dispatchDragEvent", { type: "drop" });
  f.observe("Input.dispatchKeyEvent", { type: "keyDown", code: "KeyA", key: "a" });
  f.observe("Input.dispatchKeyEvent", { type: "keyUp", code: "KeyA", key: "a" });
  await f.release();
  assert.deepEqual(f.calls, []);
});
test("input cleanup is bounded and does not continue dispatching after timeout", async () => {
  const f = fixture();
  f.observe("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", x: 2, y: 3 });
  f.observe("Input.dispatchKeyEvent", { type: "rawKeyDown", code: "ShiftLeft", key: "Shift" });
  let resolve;
  await assert.rejects(releaseCrxInput(f.transport, 42, (...args) => { f.calls.push(args); return new Promise(done => { resolve = done; }); }, 15), /cleanup timed out/);
  resolve();
  await new Promise(done => setTimeout(done, 0));
  assert.equal(f.calls.length, 1);
  await f.release();
  assert.equal(f.calls.length, 1);
});
