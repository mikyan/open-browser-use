import assert from "node:assert/strict";
import test from "node:test";
import { BrowserActionEngine } from "./browser-action-engine.js";

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const actions = ["press", "keyboard.press", "keyboard.type", "pressSequentially"];
function fixture(action, operation, options = {}) {
  const calls = [], target = { press: operation, pressSequentially: operation };
  const page = { on() {}, off() {}, locator: () => target, keyboard: { press: operation, type: operation } };
  const app = { attach: async () => page, detach: async () => { calls.push("detach"); } };
  const runtime = { crx: { start: async () => app }, setOpenBrowserUseCommandObserver() {}, setOpenBrowserUseEventFilter() {}, assertOpenBrowserUseSelector() {} };
  globalThis.chrome = { tabs: { get: async () => ({ incognito: false }) } };
  const engine = new BrowserActionEngine({ loadRuntime: async () => runtime, ...options });
  const request = { session_id: "task", turn_id: "turn", control_epoch: 1, tabId: 42, action,
    ...(action.startsWith("keyboard.") ? {} : { locator: [{ kind: "css", selector: "input" }] }),
    args: action.endsWith("press") ? { key: "Control+a" } : { text: "abc" } };
  return { engine, app, calls, request };
}

for (const action of actions) {
  test(`${action}: invalid chords and rejected admission preserve original pre-held attachment`, async () => {
    for (const code of ["INVALID", "REJECTED"]) {
      // Error text can contain arbitrary invalid key names or nested causes.
      // The outer keyboard classification, not a nested cleanup-like string,
      // determines whether the original pre-held state needs to be retired.
      const failure = new Error(`locator.press: OBU_KEYBOARD_PRESS_${code}: OBU_FILL_DELIVERY_UNCONFIRMED: OBU_KEYBOARD_PRESS_UNCONFIRMED: nested text`);
      const f = fixture(action, async () => { throw failure; });
      await assert.rejects(f.engine.dispatch(f.request), error => error === failure);
      assert.deepEqual(f.calls, []); assert.equal(f.engine.pages.size, 1);
      await f.engine.detach(42);
    }
  });

  test(`${action}: partial native press releases exactly once without repeating input`, async () => {
    let attempts = 0;
    const failure = new Error("OBU_KEYBOARD_PRESS_UNCONFIRMED: actual native key failed");
    const f = fixture(action, async () => { attempts++; throw failure; });
    await assert.rejects(f.engine.dispatch(f.request), error => error === failure);
    assert.equal(attempts, 1); assert.deepEqual(f.calls, ["detach"]); assert.equal(f.engine.pages.size, 0);
  });

  test(`${action}: late failure cannot release a successor attachment`, async () => {
    const entered = deferred(), gate = deferred(), failure = new Error("OBU_KEYBOARD_PRESS_UNCONFIRMED: old key ACK failed");
    const f = fixture(action, () => { entered.resolve(); return gate.promise; });
    const pending = f.engine.dispatch(f.request), rejected = assert.rejects(pending, error => error === failure);
    await entered.promise; f.engine.forget(42); await f.engine.attach(42); const successor = f.engine.pages.get(42);
    gate.reject(failure); await rejected;
    assert.deepEqual(f.calls, []); assert.equal(f.engine.pages.get(42), successor); await f.engine.detach(42);
  });

  test(`${action}: original deadline cannot release successor and keeps actual work in drain`, async () => {
    const entered = deferred(), gate = deferred(), f = fixture(action, () => { entered.resolve(); return gate.promise; });
    const pending = f.engine.dispatch({ ...f.request, timeoutMs: 25 });
    const rejected = assert.rejects(pending, /Browser action timed out after 25ms/);
    await entered.promise; const actual = f.engine.queues.get(42);
    f.engine.forget(42); await f.engine.attach(42); const successor = f.engine.pages.get(42);
    await rejected; assert.deepEqual(f.calls, []); assert.equal(f.engine.pages.get(42), successor);
    assert.ok(f.engine.controlSnapshot().pending.includes(actual));
    gate.resolve(); await actual.catch(() => {}); assert.equal(f.engine.pages.get(42), successor); await f.engine.detach(42);
  });

  test(`${action}: cold attachment deadline cannot release a replacement generation`, async () => {
    const entered = deferred(), gate = deferred(); let reads = 0;
    const f = fixture(action, async () => assert.fail("expired cold action must not run"));
    globalThis.chrome.tabs.get = async () => { if (++reads === 1) { entered.resolve(); await gate.promise; } return { incognito: false }; };
    const pending = f.engine.dispatch({ ...f.request, timeoutMs: 25 });
    const rejected = assert.rejects(pending, /Browser action timed out after 25ms/);
    await entered.promise; const actual = f.engine.queues.get(42);
    f.engine.forget(42); await f.engine.attach(42); const successor = f.engine.pages.get(42);
    await rejected; assert.deepEqual(f.calls, []); assert.equal(f.engine.pages.get(42), successor);
    gate.resolve(); await actual.catch(() => {}); assert.equal(f.engine.pages.get(42), successor); await f.engine.detach(42);
  });
}

test("keyboard admission checks the original deadline synchronously, without exposing closures as cursor metadata", async t => {
  const entered = deferred(), gate = deferred(); let check;
  const f = fixture("keyboard.press", () => { check = f.engine.captureKeyboardPress(42); entered.resolve(); return gate.promise; });
  const originalNow = performance.now.bind(performance); let advance = 0;
  t.mock.method(performance, "now", () => originalNow() + advance);
  assert.throws(() => f.engine.captureKeyboardPress(42), /OBU_KEYBOARD_PRESS_REJECTED/);
  const pending = f.engine.dispatch({ ...f.request, timeoutMs: 500 });
  const rejected = assert.rejects(pending, /timed out/);
  await entered.promise; check(); assert.deepEqual(f.engine.active.get(42), { session_id: "task", turn_id: "turn" });
  advance = 1000; assert.throws(check, /Browser action timed out after 500ms/);
  gate.resolve(); await rejected; assert.throws(() => f.engine.captureKeyboardPress(42), /OBU_KEYBOARD_PRESS_REJECTED/);
});

test("captured keyboard admission cannot follow a later action on the same attachment", async () => {
  const first = deferred(), second = deferred(); let calls = 0, oldCheck, currentCheck;
  const f = fixture("keyboard.press", () => {
    if (++calls === 1) { oldCheck = f.engine.captureKeyboardPress(42); return first.promise; }
    currentCheck = f.engine.captureKeyboardPress(42); second.resolve();
    assert.throws(oldCheck, /OBU_KEYBOARD_PRESS_REJECTED/); currentCheck();
  });
  const pending = f.engine.dispatch(f.request); pending.catch(() => {});
  for (let attempt = 0; !oldCheck && attempt < 100; attempt++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof oldCheck, "function", "original action must enter keyboard admission");
  oldCheck(); first.resolve(); await pending;
  assert.throws(oldCheck, /OBU_KEYBOARD_PRESS_REJECTED/);
  await f.engine.dispatch(f.request); await second.promise; assert.throws(currentCheck, /OBU_KEYBOARD_PRESS_REJECTED/);
  await f.engine.detach(42);
});

test("keyboard native and original cleanup errors are both retained", async () => {
  const failure = new Error("OBU_KEYBOARD_PRESS_UNCONFIRMED: native failed"), cleanup = new Error("original key release failed");
  const f = fixture("press", async () => { throw failure; });
  f.app.detach = async () => { f.calls.push("detach"); throw cleanup; };
  await assert.rejects(f.engine.dispatch(f.request), error => error === failure && error.cleanupError === cleanup);
  assert.deepEqual(f.calls, ["detach"]);
});
