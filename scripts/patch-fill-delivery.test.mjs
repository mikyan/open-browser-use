import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { test } from "node:test";
import { NativeInputTracker } from "../apps/chrome-extension/browser-input-adapter.js";
import { patchCrxPointerDelivery } from "./patch-pointer-delivery.mjs";
import { patchCrxFillDelivery, fillDeliveryBridge, prepareFillReceipt } from "./patch-fill-delivery.mjs";

const require = createRequire(new URL("../apps/chrome-extension/package.json", import.meta.url));
const directory = path.dirname(require.resolve("playwright-crx/package.json"));
const entry = await fs.readFile(path.join(directory, "lib/index.mjs"), "utf8");
const chunk = /from ["']\.\/([^"']+\.mjs)/.exec(entry)[1];
const upstream = await fs.readFile(path.join(directory, "lib", chunk), "utf8");
const beforeFill = patchCrxPointerDelivery(upstream);
const patched = patchCrxFillDelivery(beforeFill);
const injected = vm.runInNewContext(/^const source\$4 = (.*);$/m.exec(patched)[1], {}, { timeout: 1000 });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const flush = () => new Promise(resolve => setImmediate(resolve));
function part(source, start, end) {
  assert.equal(source.split(start).length, 2);
  const offset = source.indexOf(start), finish = source.indexOf(end, offset + start.length);
  assert.ok(finish > offset); return source.slice(offset, finish);
}

// This baseline invokes the actual pinned fill implementation. The mock native
// transport acknowledges without delivering an event; it is not a browser run.
function oldFill() {
  const calls = [];
  const methods = part(upstream, "  async _fill(progress2, value, options2) {", "  async selectText(");
  const Handle = vm.runInNewContext(`(class {${methods}})`);
  const handle = Object.assign(new Handle(), {
    instrumentation: { onBeforeInputAction: async () => {} },
    _retryAction: async (_progress, _name, action) => action(),
    evaluateInUtility: async () => "needsinput",
    _page: { keyboard: { insertText: async text => { calls.push({ method: "Input.insertText", text }); }, press: async key => { calls.push({ key }); } } }
  });
  return { calls, run: () => handle._fill({ log() {}, throwIfAborted() {} }, "original text", {}) };
}

test("pinned baseline demonstrates native ACK alone is accepted as a fill", async () => {
  const f = oldFill();
  if (process.env.OBU_FILL_BASELINE_RED === "1") await assert.rejects(f.run(), /OBU_FILL_DELIVERY_UNCONFIRMED/);
  else assert.equal(await f.run(), "done");
  assert.equal(f.calls.length, 1);
});

function fixture({ type = "text", nodeName = "INPUT", initial = "", editable = false, drop = false,
  cancelBefore = false, afterInput, beforeInput, earlyInput, onFocus, onNative, onRuntime, onCleanup,
  disabled = false, noHooks = false, mainWorld = false, nested = false } = {}) {
  const calls = [], runtimeCalls = [], cleanupCalls = [], tags = new WeakMap(), listeners = new Map(), remotes = new Map();
  let objectCount = 0, paused = false, expired = false, aborted = false, destroyed = false, selectedRange;
  let preparations = 0, began = 0, leaseClosed = 0, prechecks = 0;
  const document = { defaultView: null, activeElement: null };
  const view = document.defaultView = {
    addEventListener(name, listener) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(listener); },
    removeEventListener(name, listener) { listeners.get(name)?.delete(listener); },
    getSelection: () => ({ rangeCount: selectedRange ? 1 : 0, getRangeAt: () => selectedRange,
      removeAllRanges() { selectedRange = undefined; }, addRange(range) { selectedRange = range; } })
  };
  document.createRange = () => ({ selectNodeContents(element) { this.startContainer = element; this.endContainer = element; } });
  const node = { nodeName, type, value: initial, isConnected: true, isContentEditable: editable,
    ownerDocument: document, parentElement: null, childNodes: [],
    getRootNode: () => document, contains(value) { return value === this; },
    focus() { document.activeElement = host; onFocus?.(f); }, select() { this.focus(); },
    dispatchEvent(event) { emit(event.type, { ...event, isTrusted: false }); return true; } };
  const host = nested ? { ...node, parentElement: null, contains: value => value === node || value === host } : node;
  if (nested) node.parentElement = host;
  const emit = (name, overrides = {}) => {
    const event = { type: name, isTrusted: true, inputType: name === "keydown" ? undefined : "insertText", isComposing: false,
      defaultPrevented: false, composedPath: () => [host], preventDefault() { this.defaultPrevented = true; },
      getTargetRanges: () => [{ startContainer: node, endContainer: node }], ...overrides };
    if (name === "input") earlyInput?.(event, f);
    for (const listener of [...listeners.get(name) || []]) listener(event);
    if (name === "beforeinput") { beforeInput?.(event, f); if (cancelBefore) event.preventDefault(); }
    if (name === "input") afterInput?.(event, f);
    return event;
  };
  const identities = new Map([[7, {}]]), sessions = new Map([["child", 7]]);
  const transport = { _tabToTarget: identities, _sessions: sessions };
  class CRExecutionContext {}
  class NonRecoverableDOMError extends Error {}
  class JavaScriptErrorInEvaluate extends Error {}
  const context = { delegate: new CRExecutionContext(), world: mainWorld ? "main" : "utility", _contextDestroyedScope: { isClosed: () => destroyed } };
  const utility = mainWorld ? { ...context, delegate: new CRExecutionContext(), world: "utility" } : context;
  const contextClient = { _sessionId: "child", _connection: { _transport: transport } };
  context.delegate._client = contextClient; context.delegate._contextId = 3;
  utility.delegate._client = contextClient; utility.delegate._contextId = 4;
  const tracker = new NativeInputTracker(), attachment = {}; tracker.register(7, attachment);
  const progress = { metadata: {}, log() {}, isRunning: () => !aborted,
    throwIfAborted() { if (aborted) throw new Error("original action aborted"); }, timeUntilDeadline: () => expired ? -1 : 10000 };
  const injectedObject = { document, retarget: value => value, createStacklessError: message => new Error(message),
    checkElementStates: async (_node, states) => { prechecks++; return disabled && states.includes("enabled") ? { missingState: "enabled" } : undefined; } };
  const hooks = {
    beginFillAction(target, check) { began++; assert.deepEqual({ ...target }, { tabId: 7 }); return tracker.beginFillAction(7, attachment, () => { check(); if (paused) throw new Error("original control revoked"); }); },
    prepareMediaCleanup(target, contextId) {
      assert.deepEqual({ ...target }, { tabId: 7, sessionId: "child" }); assert.equal(contextId, 4);
      return {
        async cancel(id, check) { check?.(); cleanupCalls.push({ operation: "cancel", id }); await onCleanup?.("cancel", id, f); assert.equal(remotes.get(id).cancel(), true); },
        async release(id, check) { check?.(); cleanupCalls.push({ operation: "release", id }); await onCleanup?.("release", id, f); remotes.delete(id); },
        close() { leaseClosed++; }
      };
    }
  };
  const env = { Error, Set, Map, Symbol, Promise, Number, String, Array, isNaN, console, setTimeout,
    CRExecutionContext, NonRecoverableDOMError, JavaScriptErrorInEvaluate,
    getExceptionMessage: () => "original page exception", process: { platform: "win32" },
    isString: value => typeof value === "string", assert,
    Event: class Event { constructor(type, options) { this.type = type; Object.assign(this, options); } },
    tagPointerCommand(params, ticket) { if (ticket) tags.set(params, ticket); return params; },
    openBrowserUseInputHooks: noHooks ? undefined : hooks, prepareFillReceipt };
  const methods = part(patched, "  async _retryAction(", "  async _retryPointerAction(") + part(patched, "  async _fill(progress2, value, options2) {", "  async selectText(");
  const runtime = vm.runInNewContext(
    "class TestInjected {" + part(injected, "  prepareOpenBrowserUseFill(", "  _activelyFocused(") + "}\n" +
    "class TestHandle {" + methods + "}\n" +
    part(patched, "const keypadLocation$1 = 3;", "let Touchscreen$1 = class Touchscreen {") +
    part(patched, "function toModifiersMask$2(", "class DragManager {") +
    part(patched, "const macEditingCommands =", "let RawMouseImpl$3 = class RawMouseImpl {") + fillDeliveryBridge +
    "\n({TestInjected,TestHandle,Keyboard:Keyboard$1,RawKeyboard:RawKeyboardImpl$3});", env);
  for (const name of ["fill", "selectText", "prepareOpenBrowserUseFill"]) injectedObject[name] = runtime.TestInjected.prototype[name];
  remotes.set("injected", injectedObject); remotes.set("node", node);
  utility.injectedScript = async () => ({ _objectId: "injected" });
  transport._send = async (target, method, params) => {
    runtimeCalls.push({ target, method, params });
    if (method === "DOM.describeNode") return { node: { backendNodeId: 11 } };
    if (method === "DOM.resolveNode") { remotes.set("adopted", node); return { object: { objectId: "adopted" } }; }
    assert.equal(method, "Runtime.callFunctionOn");
    const operation = vm.runInNewContext("(" + params.functionDeclaration + ")", env);
    const args = (params.arguments || []).map(arg => arg.objectId ? remotes.get(arg.objectId) : arg.value);
    if (params.functionDeclaration.includes("prepareOpenBrowserUseFill")) preparations++;
    const result = await operation.apply(remotes.get(params.objectId), args);
    let response;
    if (params.returnByValue) response = { result: { value: result } };
    else { const objectId = "receipt-" + ++objectCount; remotes.set(objectId, result); response = { result: { objectId } }; }
    await onRuntime?.({ target, method, params, response }, f);
    return response;
  };
  const nativeClient = { _sessionId: "crx-tab-7", _connection: { _transport: transport }, send(method, params) {
    const ticket = tags.get(params);
    return tracker.send({ tabId: 7 }, attachment, method, params, async () => {
      calls.push({ method, params: { ...params }, ticket: !!ticket });
      if (!drop && (method === "Input.insertText" || method === "Input.dispatchKeyEvent" && params.type === "rawKeyDown" && params.key === "Delete")) {
        const text = method === "Input.insertText" ? params.text : "";
        // Empty Delete is a genuine unchanged edit with no input event.
        if (text !== "" || node.value !== "" || node.childNodes.length) {
          const inputType = text === "" ? "deleteContentForward" : "insertText";
          const before = emit("beforeinput", { inputType });
          if (!before.defaultPrevented) { node.value = text; node.childNodes = []; emit("input", { inputType }); }
        }
      }
      await onNative?.({ method, params }, f);
      return {};
    }, ticket);
  } };
  const keyboard = new runtime.Keyboard(new runtime.RawKeyboard(nativeClient, false, { cancelDrag: async () => false }));
  const page = { keyboard, performActionPreChecks: async () => {} };
  const frame = { _page: page, _utilityContext: async () => utility,
    _contextData: new Map([[context.world, { context }], ["utility", { context: utility }]]) };
  context.frame = utility.frame = frame;
  const handle = Object.assign(new runtime.TestHandle(), { _page: page, _frame: frame, _context: context, _objectId: "node", _disposed: false,
    instrumentation: { onBeforeInputAction: async () => {} },
    evaluateInUtility: async (fn, arg) => fn([injectedObject, node, arg]) });
  const f = { calls, runtimeCalls, cleanupCalls, node, host, document, view, remotes, injected: injectedObject, context, utility, identities, sessions, tracker, attachment, handle,
    emit, progress, run: (value = "original text", options = {}) => handle._fill(progress, value, options),
    raw: (method, params) => nativeClient.send(method, params),
    release: () => tracker.release(7, attachment, async () => ({}), 200),
    pause: () => { paused = true; }, expire: () => { expired = true; }, abort: () => { aborted = true; }, destroy: () => { destroyed = true; },
    enable: () => { disabled = false; }, counts: () => ({ preparations, began, leaseClosed, prechecks }),
    listenerCount: () => [...listeners.values()].reduce((sum, value) => sum + value.size, 0), NonRecoverableDOMError };
  return f;
}

test("native ACK without input is terminal and never submits a second text", async () => {
  const f = fixture({ drop: true });
  await assert.rejects(f.run(), error => error instanceof f.NonRecoverableDOMError && /OBU_FILL_DELIVERY_UNCONFIRMED/.test(error.message));
  assert.equal(f.calls.length, 1); assert.equal(f.node.value, "");
  assert.equal(f.tracker.attachments.get(7).cleanups.size, 1);
  await f.release(); assert.equal(f.listenerCount(), 0); assert.equal(f.counts().leaseClosed, 1);
});

test("native input plus its actual ACK completes and releases the original receipt", async () => {
  const f = fixture(); assert.equal(await f.run(), "done");
  assert.equal(f.node.value, "original text"); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].ticket, true);
  assert.equal(f.listenerCount(), 0); assert.equal(f.remotes.size, 2); assert.equal(f.counts().leaseClosed, 1);
});

for (const [name, mutate] of [
  ["format value", f => { f.node.value = "FORMATTED"; }],
  ["clear value", f => { f.node.value = ""; }],
  ["remove original node", f => { f.node.isConnected = false; }],
  ["disable original node", f => { f.node.disabled = true; }]
]) test(`delivered input may ${name} without being replayed`, async () => {
  const f = fixture({ afterInput: (_event, f) => mutate(f) });
  assert.equal(await f.run(), "done"); assert.equal(f.calls.length, 1);
});

test("cancelled beforeinput is not an edit receipt", async () => {
  const f = fixture({ cancelBefore: true }); await assert.rejects(f.run(), /OBU_FILL_DELIVERY_UNCONFIRMED/);
  assert.equal(f.node.value, ""); assert.equal(f.calls.length, 1); await f.release();
});

test("an earlier capture input handler may remove the original node before receipt capture", async () => {
  const f = fixture({ earlyInput: (_event, f) => { f.node.isConnected = false; } });
  assert.equal(await f.run(), "done"); assert.equal(f.calls.length, 1);
});

test("synthetic or unrelated-host input cannot stand in for native delivery", async () => {
  for (const event of [{ isTrusted: false }, { composedPath: () => [{}] }, { inputType: "insertFromPaste" }, { isComposing: true }]) {
    const f = fixture({ drop: true, onNative: (_call, f) => f.emit("input", event) });
    await assert.rejects(f.run(), /OBU_FILL_DELIVERY_UNCONFIRMED/); assert.equal(f.calls.length, 1); await f.release();
  }
});

test("input during original focus/selection is excluded from the native receipt window", async () => {
  const f = fixture({ drop: true, onFocus: f => f.emit("input") });
  await assert.rejects(f.run(), /OBU_FILL_DELIVERY_UNCONFIRMED/); assert.equal(f.calls.length, 1); await f.release();
});

test("equal non-empty value still needs its original edit event", async () => {
  const f = fixture({ initial: "original text", drop: true });
  await assert.rejects(f.run(), /OBU_FILL_DELIVERY_UNCONFIRMED/); assert.equal(f.calls.length, 1); await f.release();
});

test("empty Delete permits only the independently unchanged empty selection", async () => {
  const empty = fixture(); assert.equal(await empty.run(""), "done");
  assert.deepEqual(empty.calls.map(call => call.params.type), ["rawKeyDown", "keyUp"]);
  assert.ok(empty.calls.every(call => call.ticket));
  const nonempty = fixture({ initial: "original", drop: true });
  await assert.rejects(nonempty.run(""), /OBU_FILL_DELIVERY_UNCONFIRMED/); await nonempty.release();
  const edited = fixture({ initial: "original" }); assert.equal(await edited.run(""), "done"); assert.equal(edited.node.value, "");
});

test("empty Delete may have uncancelled beforeinput but cannot accept a cancelled edit", async () => {
  for (const cancelled of [false, true]) {
    const f = fixture({ drop: true, cancelBefore: cancelled,
      onNative: ({ params }, f) => { if (params.type === "rawKeyDown") f.emit("beforeinput", { inputType: "deleteContentForward" }); } });
    if (cancelled) { await assert.rejects(f.run(""), /OBU_FILL_/); await f.release(); }
    else assert.equal(await f.run(""), "done");
    assert.equal(f.calls.length, 2);
  }
});

test("contenteditable host and a selected nested editable range receive native input", async () => {
  for (const nested of [false, true]) {
    const f = fixture({ nodeName: "DIV", editable: true, nested });
    assert.equal(await f.run(), "done"); assert.equal(f.calls.length, 1);
  }
});

test("textarea and native maxlength truncation use event delivery rather than final value equality", async () => {
  const textarea = fixture({ nodeName: "TEXTAREA" });
  assert.equal(await textarea.run("first\n第二行"), "done"); assert.equal(textarea.calls.length, 1);
  const truncated = fixture({ earlyInput: (_event, f) => { f.node.value = f.node.value.slice(0, 3); } });
  assert.equal(await truncated.run(), "done"); assert.equal(truncated.node.value, "ori");
});

test("empty contenteditable no-op is limited to no children, not textContent equality", async () => {
  const empty = fixture({ nodeName: "DIV", editable: true }); assert.equal(await empty.run(""), "done");
  const br = fixture({ nodeName: "DIV", editable: true, drop: true }); br.node.childNodes.push({ nodeName: "BR" });
  await assert.rejects(br.run(""), /OBU_FILL_/); await br.release();
});

test("a nested editable's sibling target range cannot impersonate the original range", async () => {
  const f = fixture({ nodeName: "DIV", editable: true, nested: true, drop: true,
    onNative: (_call, f) => { f.emit("beforeinput", { getTargetRanges: () => [{ startContainer: {}, endContainer: {} }] }); f.emit("input"); } });
  await assert.rejects(f.run(), /OBU_FILL_DELIVERY_UNCONFIRMED/); await f.release();
});

test("direct setter types keep native pinned synthetic events and require no input ticket", async () => {
  for (const type of ["color", "date", "time", "datetime-local", "month", "range", "week"]) {
    const f = fixture({ type });
    await f.raw("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Control", code: "ControlLeft" });
    assert.equal(await f.run("  direct value  "), "done"); assert.equal(f.node.value, "direct value");
    assert.equal(f.counts().began, 0); assert.equal(f.calls.length, 1); await f.release();
  }
});

test("force bypasses actionability but still requires trusted delivery", async () => {
  const f = fixture({ disabled: true, drop: true });
  await assert.rejects(f.run("original text", { force: true }), /OBU_FILL_DELIVERY_UNCONFIRMED/);
  assert.equal(f.calls.length, 1); assert.equal(f.counts().prechecks, 0); await f.release();
});

test("confirmed held input rejects text fill before selecting or sending", async () => {
  const f = fixture(); await f.raw("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Control", code: "ControlLeft" });
  await assert.rejects(f.run(), /OBU_FILL_/); assert.equal(f.calls.length, 1); assert.equal(f.document.activeElement, null); await f.release();
});

test("original main-world node is adopted by native backend identity, never a new locator", async () => {
  const f = fixture({ mainWorld: true }); assert.equal(await f.run(), "done");
  assert.deepEqual(f.runtimeCalls.slice(0, 2).map(call => call.method), ["DOM.describeNode", "DOM.resolveNode"]);
  assert.equal(f.remotes.has("adopted"), false); assert.equal(f.calls.length, 1);
});

test("standalone unhooked CRX keeps its legacy fill", async () => {
  const f = fixture({ noHooks: true, drop: true }); assert.equal(await f.run(), "done");
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].ticket, false); assert.equal(f.counts().began, 0);
});

test("native ACK hold keeps input and receipt resources pending until the same command settles", async () => {
  const gate = deferred(); const f = fixture({ onNative: () => gate.promise });
  let settled = false; const result = f.run().finally(() => { settled = true; }); await flush();
  assert.equal(settled, false); assert.equal(f.tracker.attachments.get(7).inflight.size, 1); assert.equal(f.listenerCount(), 2);
  gate.resolve(); assert.equal(await result, "done"); assert.equal(f.calls.length, 1); assert.equal(f.listenerCount(), 0);
});

for (const action of ["expire", "abort", "destroy", "pause"]) test(`${action} after native input cannot publish success or replay`, async () => {
  const f = fixture({ onNative: (_call, f) => f[action]() });
  await assert.rejects(f.run(), /OBU_FILL_DELIVERY_UNCONFIRMED/); assert.equal(f.calls.length, 1); await f.release();
});

test("native rejection keeps the original error and requires explicit tracked cleanup", async () => {
  const error = new Error("native connection failed"); const f = fixture({ onNative: () => { throw error; } });
  await assert.rejects(f.run(), failure => failure.cause === error && /OBU_FILL_/.test(failure.message));
  assert.equal(f.tracker.attachments.get(7).error, error); assert.equal(f.calls.length, 1); await f.release();
});

test("late allocating receipt ACK stays owned through cancellation and exact cleanup", async () => {
  const gate = deferred(); const f = fixture({ onRuntime: ({ params }) => params.functionDeclaration.includes("prepareOpenBrowserUseFill") ? gate.promise : undefined });
  const result = f.run(); await flush(); f.abort();
  assert.equal(f.listenerCount(), 2); const release = f.release(); await flush();
  assert.equal(f.cleanupCalls.length, 0); gate.resolve();
  await assert.rejects(result, /OBU_FILL_/); await release;
  assert.equal(f.calls.length, 0); assert.equal(f.listenerCount(), 0); assert.equal(f.remotes.size, 2);
});

test("a late read after deadline/context loss cannot report the already delivered event as success", async () => {
  for (const action of ["expire", "destroy"]) {
    const gate = deferred(); const f = fixture({ onRuntime: ({ params }) => params.functionDeclaration.includes("this.read()") ? gate.promise : undefined });
    const result = f.run(); await flush(); f[action](); gate.resolve();
    await assert.rejects(result, /OBU_FILL_/); assert.equal(f.calls.length, 1); await f.release();
  }
});

test("native exception handles are retained and released without treating them as receipts", async () => {
  const f = fixture({ onRuntime: ({ params, response }, f) => {
    if (params.functionDeclaration.includes("this.read()")) {
      f.remotes.set("native-exception", {});
      response.exceptionDetails = { exception: { objectId: "native-exception" } };
    }
  } });
  await assert.rejects(f.run(), /OBU_FILL_.*original page exception/);
  assert.equal(f.remotes.has("native-exception"), true); await f.release();
  assert.equal(f.remotes.has("native-exception"), false);
  assert.ok(!f.cleanupCalls.some(call => call.operation === "cancel" && call.id === "native-exception"));
});

test("failed receipt cancellation stays explicit and can only be retried by native cleanup", async () => {
  let reject = true; const error = new Error("cancel acknowledgement failed");
  const f = fixture({ onCleanup: operation => { if (operation === "cancel" && reject) { reject = false; throw error; } } });
  await assert.rejects(f.run(), failure => failure.cause === error && /OBU_FILL_/.test(failure.message));
  assert.equal(f.cleanupCalls.filter(call => call.operation === "cancel").length, 1);
  assert.equal(f.calls.length, 1); assert.equal(f.listenerCount(), 2);
  await f.release(); assert.equal(f.listenerCount(), 0);
  assert.equal(f.cleanupCalls.filter(call => call.operation === "cancel").length, 2);
});

test("cleanup ACK is awaited and never borrowed from a successor", async () => {
  const gate = deferred(); let once = true;
  const f = fixture({ onCleanup: operation => { if (operation === "cancel" && once) { once = false; return gate.promise; } } });
  let settled = false; const result = f.run().finally(() => { settled = true; }); await flush();
  assert.equal(settled, false); assert.equal(f.tracker.attachments.get(7).cleanupInflight.size, 1);
  assert.throws(() => f.tracker.beginFillAction(7, f.attachment), /OBU_FILL_ACTION_BUSY/);
  gate.resolve(); assert.equal(await result, "done"); assert.equal(f.listenerCount(), 0);
});

test("foreign raw input invalidates fill's private admission", async () => {
  const f = fixture({ onNative: async ({ method }, f) => { if (method === "Input.insertText") await f.raw("Input.dispatchMouseEvent", { type: "mouseMoved", x: 1, y: 2 }); } });
  await assert.rejects(f.run(), /OBU_FILL_/); assert.equal(f.calls.filter(call => call.method === "Input.insertText").length, 1); await f.release();
});

test("fill patch is pinned and refuses duplicate application or changed native anchors", () => {
  assert.throws(() => patchCrxFillDelivery(patched), /shape changed/);
  for (const anchor of ["  async _fill(progress2, value, options2) {", "  async sendText(text) {", "  async insertText(text) {", "  async ensureModifiers(mm, obuTicket) {"])
    assert.throws(() => patchCrxFillDelivery(beforeFill.replace(anchor, "changed-native-shape")), /shape changed/);
});
