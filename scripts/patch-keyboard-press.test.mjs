import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { test } from "node:test";
import { patchCrxPointerDelivery } from "./patch-pointer-delivery.mjs";
import { patchCrxFillDelivery } from "./patch-fill-delivery.mjs";
import { patchCrxKeyboardPress, keyboardPressBridge } from "./patch-keyboard-press.mjs";
import { NativeInputTracker } from "../apps/chrome-extension/browser-input-adapter.js";

const require = createRequire(new URL("../apps/chrome-extension/package.json", import.meta.url));
const directory = path.dirname(require.resolve("playwright-crx/package.json"));
const entry = await fs.readFile(path.join(directory, "lib/index.mjs"), "utf8");
const chunk = /from ["']\.\/([^"']+\.mjs)/.exec(entry)[1];
const upstream = await fs.readFile(path.join(directory, "lib", chunk), "utf8");
const previous = patchCrxFillDelivery(patchCrxPointerDelivery(upstream));
const patched = patchCrxKeyboardPress(previous);
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const flush = () => new Promise(resolve => setImmediate(resolve));
function part(source, start, end) {
  assert.equal(source.split(start).length, 2);
  const from = source.indexOf(start), to = source.indexOf(end, from + start.length);
  assert.ok(to > from); return source.slice(from, to);
}
function baseline() {
  const calls = [];
  const runtime = vm.runInNewContext(
    part(previous, "const keypadLocation$1 = 3;", "let Touchscreen$1 = class Touchscreen {") +
    part(previous, "function toModifiersMask$2(", "class DragManager {") +
    part(previous, "const macEditingCommands =", "let RawMouseImpl$3 = class RawMouseImpl {") +
    'const obuFillTicket = Symbol("fill");\n({Keyboard: Keyboard$1, RawKeyboard: RawKeyboardImpl$3});',
    { assert, process: { platform: "win32" }, isString: value => typeof value === "string", setTimeout,
      tagPointerCommand: params => params });
  const keyboard = new runtime.Keyboard(new runtime.RawKeyboard({ send: async (method, params) => { calls.push({ method, ...params }); } }, false, { cancelDrag: async () => false }));
  return { calls, keyboard };
}

test("pinned baseline sends Control before discovering the invalid final key", async () => {
  const f = baseline();
  await assert.rejects(f.keyboard.press("Control+DefinitelyNotAKey"), /Unknown key/);
  if (process.env.OBU_KEYBOARD_BASELINE_RED === "1") assert.equal(f.calls.length, 0, "invalid chord must be rejected before native input");
  else assert.equal(f.calls.length, 1);
  assert.deepEqual([...f.keyboard._modifiers()], ["Control"]);
  await f.keyboard.press("a");
  assert.equal(f.calls[1].modifiers, 2); assert.equal(f.calls[1].text, "");
});

function fixture({ source = patched, platform = "win32", hooks = true, onNative, beforeJournal, afterAdmission, timer } = {}) {
  const calls = [], cleanups = [], tags = new WeakMap(), logs = [];
  const tracker = new NativeInputTracker({ beforeInput: beforeJournal }), token = {};
  tracker.register(7, token);
  let began = 0, focused = 0, beforeInput = 0, expired = false, aborted = false, actionCurrent = true;
  const identities = new Map([[7, {}]]), sessions = new Map([["child", 7]]);
  const transport = { _tabToTarget: identities, _sessions: sessions };
  class NonRecoverableDOMError extends Error {}
  const progress = { metadata: {}, log: value => logs.push(value),
    timeUntilDeadline: () => expired ? -1 : 10000,
    throwIfAborted() { if (aborted) throw new Error("original locator action aborted"); } };
  const inputHooks = { beginKeyboardPress(target, check) {
    assert.deepEqual({ ...target }, { tabId: 7 }); began++;
    const ticket = tracker.beginKeyboardPress(7, token, () => {
      check();
      if (expired) throw new Error("original engine deadline expired");
      if (!actionCurrent) throw new Error("original engine action changed");
    });
    afterAdmission?.(ticket, f);
    return ticket;
  } };
  const env = { assert, NonRecoverableDOMError, process: { platform },
    isString: value => typeof value === "string", setTimeout: timer || setTimeout,
    openBrowserUseInputHooks: hooks ? inputHooks : undefined,
    tagPointerCommand(params, ticket) { if (ticket) tags.set(params, ticket); return params; } };
  const runtime = vm.runInNewContext(
    part(source, "const keypadLocation$1 = 3;", "let Touchscreen$1 = class Touchscreen {") +
    part(source, "function toModifiersMask$2(", "class DragManager {") +
    part(source, "const macEditingCommands =", "let RawMouseImpl$3 = class RawMouseImpl {") +
    "class Handle {" + part(source, "  async _press(progress2, key2, options2) {", "  async check(metadata,") + "}\n" +
    'const obuFillTicket = Symbol("fill");\n' + (source === patched ? keyboardPressBridge : "") +
    "\n({Keyboard:Keyboard$1,RawKeyboard:RawKeyboardImpl$3,Handle,obuFillTicket});", env);
  const client = { _sessionId: "crx-tab-7", _connection: { _transport: transport },
    send(method, params) {
      const ticket = tags.get(params);
      return tracker.send({ tabId: 7 }, token, method, params, async () => {
        ticket?.check(); calls.push({ method, params: structuredClone(params), guarded: !!ticket });
        await onNative?.({ method, params }, f); return {};
      }, ticket);
    } };
  const keyboard = new runtime.Keyboard(new runtime.RawKeyboard(client, platform === "darwin", { cancelDrag: async () => false }));
  const page = { keyboard, frameManager: { waitForSignalsCreatedBy: async (_progress, _wait, operation) => operation() } };
  const handle = Object.assign(new runtime.Handle(), { _page: page,
    instrumentation: { onBeforeInputAction: async () => { beforeInput++; } },
    _focus: async () => { focused++; return "done"; } });
  const f = { calls, cleanups, tracker, token, keyboard, handle, progress, identities, sessions, NonRecoverableDOMError,
    press: (key, options) => keyboard.press(key, options),
    locator: (key, options = {}) => handle._press(progress, key, options),
    type: (text, options = {}) => keyboard.type(text, options),
    raw: (method, params) => client.send(method, params),
    release: () => tracker.release(7, token, async (_target, method, params) => { cleanups.push({ method, params }); return {}; }),
    fillPress: (key, ticket) => keyboard.press(key, { [runtime.obuFillTicket]: ticket }),
    expire: () => { expired = true; }, abort: () => { aborted = true; }, revoke: () => { actionCurrent = false; },
    counts: () => ({ began, focused, beforeInput }),
    state: () => ({ keys: [...keyboard._pressedKeys], modifiers: [...keyboard._modifiers()] }) };
  return f;
}

test("invalid trailing key is rejected before any native key or pressed-state mutation", async () => {
  const f = fixture();
  await assert.rejects(f.press("Control+DefinitelyNotAKey"), error =>
    error instanceof f.NonRecoverableDOMError && /OBU_KEYBOARD_PRESS_INVALID: Unknown key/.test(error.message));
  assert.equal(f.calls.length, 0); assert.deepEqual(f.state(), { keys: [], modifiers: [] }); assert.equal(f.counts().began, 0);
  await f.press("a");
  assert.equal(f.calls[0].params.modifiers, 0); assert.equal(f.calls[0].params.text, "a");
});

test("locator validates before focus, instrumentation or native input", async () => {
  const f = fixture(); await assert.rejects(f.locator("Control+DefinitelyNotAKey"), /OBU_KEYBOARD_PRESS_INVALID/);
  assert.deepEqual(f.counts(), { began: 0, focused: 0, beforeInput: 0 }); assert.equal(f.calls.length, 0);
});

test("invalid middle token and malformed plus suffix have zero side effects", async () => {
  for (const key of ["Control+BadKey+a", "Shift+Control+BadKey", "Control+", "", "Control+++"]) {
    const f = fixture(); await assert.rejects(f.press(key), /OBU_KEYBOARD_PRESS_INVALID/);
    assert.equal(f.calls.length, 0, key); assert.deepEqual(f.state(), { keys: [], modifiers: [] });
  }
});

test("invalid chord preserves all already held keys and never obtains cleanup authority", async () => {
  const f = fixture(); await f.keyboard.down("Shift"); await f.keyboard.down("a");
  const original = f.state(), before = f.calls.length;
  await assert.rejects(f.press("Control+DefinitelyNotAKey"), /OBU_KEYBOARD_PRESS_INVALID/);
  assert.deepEqual(f.state(), original); assert.equal(f.calls.length, before); assert.equal(f.counts().began, 0);
  assert.equal(f.cleanups.length, 0); await f.release();
});

test("a first checkpoint refusal closes acquired admission without changing any key state", async () => {
  const f = fixture({ afterAdmission: (_ticket, f) => f.revoke() });
  await assert.rejects(f.press("Control+a"), /OBU_KEYBOARD_PRESS_REJECTED/);
  assert.equal(f.calls.length, 0); assert.deepEqual(f.state(), { keys: [], modifiers: [] });
  assert.equal(f.tracker.attachments.get(7).pointerGuard, null);
});

test("unknown prior input is rejected without silently clearing its error or held state", async () => {
  const f = fixture(); await f.keyboard.down("Control");
  const error = new Error("earlier unknown input"); f.tracker.attachments.get(7).error = error;
  await assert.rejects(f.press("a"), /OBU_KEYBOARD_PRESS_REJECTED/);
  assert.equal(f.calls.length, 1); assert.deepEqual(f.state().modifiers, ["Control"]);
  assert.equal(f.tracker.attachments.get(7).error, error); assert.equal(f.cleanups.length, 0); await f.release();
});

for (const platform of ["win32", "darwin"]) test(`legal aliases, '+' syntax and repeated keys preserve native sequence on ${platform}`, async () => {
  for (const key of ["+", "Control++", "Shift+KeyA", "ControlOrMeta+a", "ControlLeft+KeyA", "Control+Control+a", "a+b", "Enter", "\n", "NumpadEnter"]) {
    const old = fixture({ source: previous, platform, hooks: false }), fixed = fixture({ platform });
    await old.press(key); await fixed.press(key);
    assert.deepEqual(fixed.calls.map(call => call.params), old.calls.map(call => call.params), key);
    assert.deepEqual(fixed.state(), old.state(), key);
    assert.ok(fixed.calls.every(call => call.guarded));
  }
});

test("successful press keeps inherited pre-held semantics, including release of repeated Control", async () => {
  for (const key of ["a", "Control+a", "Shift+a"]) {
    const old = fixture({ source: previous, hooks: false }), fixed = fixture();
    await old.keyboard.down("Control"); await fixed.keyboard.down("Control");
    await old.press(key); await fixed.press(key);
    assert.deepEqual(fixed.calls.map(call => call.params), old.calls.map(call => call.params));
    assert.deepEqual(fixed.state(), old.state());
    await old.release(); await fixed.release();
  }
});

test("partial native rejection is terminal, preserves the cause, and never replays or guesses keyup", async () => {
  for (const failingIndex of [1, 2, 3, 4]) {
    const original = new Error("original native failure");
    const f = fixture({ onNative: (_call, f) => { if (f.calls.length === failingIndex) throw original; } });
    await assert.rejects(f.press("Control+a"), error => error instanceof f.NonRecoverableDOMError &&
      /OBU_KEYBOARD_PRESS_UNCONFIRMED/.test(error.message) && error.cause === original);
    assert.equal(f.calls.length, failingIndex); assert.equal(f.cleanups.length, 0);
    assert.equal(f.tracker.attachments.get(7).error, original);
    await f.release(); assert.equal(f.tracker.hasHeld(f.tracker.attachments.get(7)), false);
  }
});

test("pre-dispatch refusal after down's local mutation also requires original keyboard cleanup", async () => {
  const failure = new Error("journal refused input");
  const f = fixture({ beforeJournal: async () => { throw failure; } });
  await assert.rejects(f.press("Control+a"), error => /OBU_KEYBOARD_PRESS_UNCONFIRMED/.test(error.message) && error.cause === failure);
  assert.equal(f.calls.length, 0); assert.deepEqual(f.state().modifiers, ["Control"]);
  await f.release(); assert.ok(f.cleanups.some(call => call.params.key === "Control"));
});

test("an outstanding native ACK cannot advance the chord or become an early success", async () => {
  const gate = deferred(); const f = fixture({ onNative: (_call, f) => f.calls.length === 1 ? gate.promise : undefined });
  let settled = false; const result = f.press("Control+a").finally(() => { settled = true; }); await flush();
  assert.equal(f.calls.length, 1); assert.equal(settled, false); assert.equal(f.tracker.attachments.get(7).inflight.size, 1);
  gate.resolve(); await result;
  assert.deepEqual(f.calls.map(call => [call.params.type, call.params.key]), [["rawKeyDown", "Control"], ["rawKeyDown", "a"], ["keyUp", "a"], ["keyUp", "Control"]]);
});

for (const action of ["expire", "revoke"]) test(`${action} after native ACK forbids all subsequent chord commands`, async () => {
  const f = fixture({ onNative: (_call, f) => { if (f.calls.length === 1) f[action](); } });
  await assert.rejects(f.press("Control+a"), /OBU_KEYBOARD_PRESS_UNCONFIRMED/);
  assert.equal(f.calls.length, 1); await f.release();
});

test("locator cancellation is checked again after the original key ACK", async () => {
  const f = fixture({ onNative: (_call, f) => f.abort() });
  await assert.rejects(f.locator("Control+a"), /OBU_KEYBOARD_PRESS_UNCONFIRMED/);
  assert.equal(f.calls.length, 1); await f.release();
});

test("press delay uses its original action budget and never submits a late keyup", async () => {
  const delays = [], f = fixture({ timer: (callback, delay) => { delays.push({ callback, delay }); return 1; } });
  const result = f.press("Control+a", { delay: 500 }); await flush();
  assert.equal(f.calls.length, 2); assert.equal(delays[0].delay, 500);
  f.expire(); delays[0].callback(); await assert.rejects(result, /OBU_KEYBOARD_PRESS_UNCONFIRMED/);
  assert.equal(f.calls.length, 2); await f.release(); assert.equal(f.cleanups.length, 2);
});

test("expiry while journal admission is pending prevents the actual native send", async () => {
  const gate = deferred(), f = fixture({ beforeJournal: () => gate.promise });
  const result = f.press("Control+a"); await flush(); f.expire(); gate.resolve();
  await assert.rejects(result, /OBU_KEYBOARD_PRESS_UNCONFIRMED/); assert.equal(f.calls.length, 0); await f.release();
});

test("replacing the native attachment after ACK stops the original sequence", async () => {
  const f = fixture({ onNative: (_call, f) => f.identities.set(7, {}) });
  await assert.rejects(f.press("Control+a"), /OBU_KEYBOARD_PRESS_UNCONFIRMED/); assert.equal(f.calls.length, 1); await f.release();
});

test("foreign native input invalidates chord admission without replay", async () => {
  let once = true; const f = fixture({ onNative: async (_call, f) => {
    if (once) { once = false; await f.raw("Input.dispatchMouseEvent", { type: "mouseMoved", x: 1, y: 2 }); }
  } });
  await assert.rejects(f.press("Control+a"), /OBU_KEYBOARD_PRESS_UNCONFIRMED/);
  assert.equal(f.calls.filter(call => call.method === "Input.dispatchKeyEvent").length, 1); await f.release();
});

test("type's inherited press calls share original admission and stop at the failed character", async () => {
  const f = fixture({ onNative: (_call, f) => { if (f.calls.length === 3) throw new Error("second character failed"); } });
  await assert.rejects(f.type("abc"), /OBU_KEYBOARD_PRESS_UNCONFIRMED/);
  assert.deepEqual(f.calls.map(call => call.params.key), ["a", "a", "b"]); await f.release();
});

test("fill Delete reuses its original private ticket without opening or closing another admission", async () => {
  const f = fixture(), ticket = f.tracker.beginFillAction(7, f.token);
  await f.fillPress("Delete", ticket);
  assert.equal(f.counts().began, 0); ticket.check(); assert.ok(f.calls.every(call => call.guarded));
  assert.deepEqual(f.calls.map(call => [call.params.type, call.params.key]), [["rawKeyDown", "Delete"], ["keyUp", "Delete"]]);
  ticket.close();
});

test("pointer ensureModifiers keeps its original ticket and keyboard method semantics", async () => {
  const f = fixture(), ticket = f.tracker.beginPointerAction(7, f.token);
  const restore = await f.keyboard.ensureModifiers(["Shift"], ticket);
  await f.keyboard.ensureModifiers(restore, ticket); ticket.check(); ticket.close();
  assert.equal(f.counts().began, 0); assert.ok(f.calls.every(call => call.guarded));
  assert.deepEqual(f.calls.map(call => call.params.type), ["rawKeyDown", "keyUp"]);
});

test("standalone unhooked press keeps legal sequence but rejects an invalid chord before input", async () => {
  const f = fixture({ hooks: false }); await assert.rejects(f.press("Control+BadKey"), /OBU_KEYBOARD_PRESS_INVALID/);
  assert.equal(f.calls.length, 0); await f.press("Control+a"); assert.equal(f.calls.length, 4); assert.equal(f.counts().began, 0);
});

test("patch refuses duplicate application and changed pinned parsing/call sites", () => {
  assert.throws(() => patchCrxKeyboardPress(patched), /shape changed/);
  for (const anchor of ["  async press(key2, options2 = {}) {", "    const tokens = split(key2);", "this.down(key2, options2[obuFillTicket])", "      await this._page.keyboard.press(key2, options2);"])
    assert.throws(() => patchCrxKeyboardPress(previous.replace(anchor, "changed-native-shape")), /shape changed/);
});
