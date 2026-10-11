import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { test } from "node:test";
import { NativeInputTracker } from "../apps/chrome-extension/browser-input-adapter.js";
import { createPointerMoveReceipt, patchCrxPointerDelivery, pointerDeliveryBridge } from "./patch-pointer-delivery.mjs";

const require = createRequire(new URL("../apps/chrome-extension/package.json", import.meta.url));
const directory = path.dirname(require.resolve("playwright-crx/package.json"));
const entry = await fs.readFile(path.join(directory, "lib/index.mjs"), "utf8");
const chunk = /from ["']\.\/([^"']+\.mjs)/.exec(entry)[1];
const upstream = await fs.readFile(path.join(directory, "lib", chunk), "utf8");
const patched = patchCrxPointerDelivery(upstream);
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const flush = () => new Promise(resolve => setImmediate(resolve));

function slice(source, start, end) {
  assert.equal(source.split(start).length, 2, `unique native boundary: ${start}`);
  const from = source.indexOf(start), to = source.indexOf(end, from + start.length);
  assert.ok(to > from, `native end boundary: ${end}`);
  return source.slice(from, to);
}

function fixture({ source = patched, bridge = pointerDeliveryBridge, dropMoves = 0, onSend, stopError, stopResult, noHooks = false, delayHook, moveEvent, tracked = false, platform = "win32" } = {}) {
  const calls = [], nativeCalls = [], handles = [], waits = [], logs = [], tags = new WeakMap(), timeline = [];
  const windowListeners = new Map();
  const document = {}, node = { ownerDocument: document, isConnected: true };
  const identities = new Map([[7, {}]]), sessions = new Map([["child-session", 7]]);
  const transport = { _tabToTarget: identities, _sessions: sessions };
  let expired = false, paused = false, running = true, closed = 0, began = 0, nativeMoves = 0, frameChecks = 0;
  class CRExecutionContext {}
  class NonRecoverableDOMError extends Error {}
  let contextDestroyed = false;
  const tracker = tracked ? new NativeInputTracker() : undefined, attachment = {};
  tracker?.register(7, attachment);
  const context = { delegate: new CRExecutionContext(), world: "utility", _contextDestroyedScope: { isClosed: () => contextDestroyed } };
  context.delegate._client = { _sessionId: "child-session", _connection: { _transport: transport } };
  const progress = {
    metadata: {}, log: line => logs.push(line), isRunning: () => running,
    timeUntilDeadline: () => expired ? -1 : 10000,
    throwIfAborted() { if (!running) throw new Error("action aborted"); },
    cleanupWhenAborted() {}
  };
  const injected = {
    document, window: { addEventListener(type, listener, options) { windowListeners.set(type, { listener, options }); } },
    onGlobalListenersRemoved: new Set(), retarget: value => value,
    expectHitTarget: () => "done", checkElementStates: () => undefined,
    _hoverHitTargetInterceptorEvents: new Set(["mousemove"]),
    _tapHitTargetInterceptorEvents: new Set(["pointerdown", "pointerup"]),
    _mouseHitTargetInterceptorEvents: new Set(["mousedown", "mouseup", "pointerdown", "pointerup", "click"])
  };
  const injectedLine = /^const source\$4 = (.*);$/m.exec(source);
  const injectedSource = vm.runInNewContext(injectedLine[1], {}, { timeout: 1000 });
  const setup = slice(injectedSource, "  setupHitTargetInterceptor(", "  dispatchEvent(");
  const globalSetup = slice(injectedSource, "  _setupHitTargetInterceptors() {", "  async expect(");
  const eventSet = /^    this\._allHitTargetInterceptorEvents = .*;$/m.exec(injectedSource)[0];
  const env = {
    Error, Number, Set, Map, Symbol, Promise, CRExecutionContext, NonRecoverableDOMError, assert,
    process: { platform }, isString: value => typeof value === "string",
    isJavaScriptErrorInEvaluate: () => false, isSessionClosedError: () => false,
    isNonRecoverableDOMError: error => error instanceof NonRecoverableDOMError, isInvalidSelectorError: () => false,
    createPointerMoveReceipt,
    setTimeout: (callback, ms) => { waits.push(ms); if (delayHook) delayHook(ms); callback(); return 1; },
    roundPoint: value => value,
    assertDone: value => value, throwRetargetableDOMError: value => value,
    tagPointerCommand(params, ticket) { if (ticket) tags.set(params, ticket); return params; },
    openBrowserUseInputHooks: noHooks ? undefined : { beginPointerAction(target, check) {
      assert.deepEqual({ ...target }, { tabId: 7 }); began++;
      if (tracker) return tracker.beginPointerAction(7, attachment, () => { check(); if (paused) throw new Error("control revoked"); });
      let ticketClosed = false;
      return { check() { check(); if (paused || ticketClosed) throw new Error("control revoked"); }, close() { ticketClosed = true; closed++; } };
    } }
  };
  const methods = slice(source, "  async _retryAction(", "  async _markAsTargetElement(") +
    slice(source, "  _click(progress2, options2) {", "  async dblclick(") +
    slice(source, "  _dblclick(progress2, options2) {", "  async tap(");
  const runtime = vm.runInNewContext(
    (source === upstream ? "" : injectedSource.slice(0, injectedSource.indexOf("\nvar __commonJS"))) +
    "class TestInjected {" + setup + globalSetup + "registerEventSet() {" + eventSet + "}}\n" +
    "class TestHandle {" + methods + "}\n" +
    "class TestFrame {" + slice(source, "  async retryWithProgressAndTimeouts(", "  async _retryWithProgressIfNotConnected(") + "}\n" +
    slice(source, "const keypadLocation$1 = 3;", "let Touchscreen$1 = class Touchscreen {") +
    slice(source, "function toModifiersMask$2(", "class DragManager {") +
    slice(source, "const macEditingCommands =", "let RawMouseImpl$3 = class RawMouseImpl {") +
    slice(source, "let RawMouseImpl$3 = class RawMouseImpl {", "let RawTouchscreenImpl$3 =") +
    (source === upstream ? "" : bridge) +
    "\n({ TestInjected, TestHandle, TestFrame, Keyboard: Keyboard$1, RawKeyboard: RawKeyboardImpl$3, Mouse: Mouse$1, RawMouse: RawMouseImpl$3 });", env);
  injected.setupHitTargetInterceptor = runtime.TestInjected.prototype.setupHitTargetInterceptor;
  runtime.TestInjected.prototype.registerEventSet.call(injected);
  runtime.TestInjected.prototype._setupHitTargetInterceptors.call(injected);
  const event = (type, overrides = {}) => ({ type, isTrusted: true, buttons: type === "mousedown" || type === "pointerdown" ? 1 : 0,
    pointerType: "mouse", isPrimary: true,
    clientX: 30, clientY: 40, composedPath: () => [node], preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {}, ...overrides });
  const emit = (type, overrides) => windowListeners.get(type)?.listener(event(type, overrides));
  const client = {
    _sessionId: "crx-tab-7", _connection: { _transport: transport },
    async send(method, params) {
      const ticket = tags.get(params);
      const operation = async () => {
      ticket?.check();
      calls.push({ method, params: { ...params }, ticket: !!ticket });
      timeline.push({ phase: "start", method, ...params });
      if (params.type === "mouseMoved") nativeMoves++;
      if (onSend) await onSend({ method, params, emit, calls, nativeMoves, ticket, pause: () => { paused = true; } });
      // Emulate the transport's check immediately before actual native send.
      ticket?.check();
      nativeCalls.push({ method, params: { ...params } });
      if (params.type === "mouseMoved" && nativeMoves > dropMoves) { emit("pointermove", moveEvent); emit("mousemove", moveEvent); }
      if (params.type === "mousePressed") { emit("pointerdown"); emit("mousedown"); }
      if (params.type === "mouseReleased") { emit("pointerup"); emit("mouseup"); emit("click"); }
      timeline.push({ phase: "ack", method, ...params });
      return {};
      };
      return tracker ? tracker.send({ tabId: 7 }, attachment, method, params, operation, ticket) : operation();
    }
  };
  const keyboard = new runtime.Keyboard(new runtime.RawKeyboard(client, platform === "darwin", { cancelDrag: async () => false }));
  const page = {
    keyboard, performActionPreChecks: async () => {},
    frameManager: { waitForSignalsCreatedBy: async (_progress, waitAfter, fn) => { page.waitAfter = waitAfter; return fn(); } }
  };
  page.mouse = new runtime.Mouse(new runtime.RawMouse(page, client, { isDragging: () => false, interceptDragCausedByMove: async (...args) => args.at(-1)() }), page);
  const parentFrame = { parentFrame: () => null, pendingDocument: () => undefined };
  const frame = { _page: page, parentFrame: () => parentFrame, pendingDocument: () => undefined, raceAgainstEvaluationStallingEvents: fn => fn() };
  frame._contextData = new Map([["utility", { context }]]);
  context.frame = frame;
  const handle = Object.assign(new runtime.TestHandle(), {
    _page: page, _frame: frame, _context: context, _disposed: false,
    instrumentation: { onBeforeInputAction: async () => {} },
    _scrollRectIntoViewIfNeeded: async () => "done", _clickablePoint: async () => ({ x: 30, y: 40 }),
    _checkFrameIsHitTarget: async () => { frameChecks++; return { framePoint: { x: 30, y: 40 }, frameGeometry: ["original frame"] }; },
    evaluateInUtility: async (fn, arg) => {
      if (typeof arg === "number") { waits.push(arg); return; }
      return fn([injected, node, arg]);
    },
    evaluateHandleInUtility: async (fn, arg) => {
      const value = fn([injected, node, arg]);
      const nativeHandle = { _objectId: "receipt-" + handles.length, _context: context, disposed: false,
        async evaluate(callback, data) {
          if (String(callback).includes("h.stop()")) {
            if (stopError && calls.some(call => call.params.type === "mouseReleased")) throw stopError;
            if (stopResult && calls.some(call => call.params.type === "mouseReleased")) return stopResult;
          }
          return callback(value, data);
        },
        dispose() { this.disposed = true; }
      };
      handles.push(nativeHandle); return nativeHandle;
    }
  });
  const retryFrame = Object.assign(new runtime.TestFrame(), { isDetached: () => false, _page: page });
  return { handle, page, frame, parentFrame, node, injected, emit, windowListeners, progress, calls, nativeCalls, timeline, handles, logs, waits, context, identities, sessions, NonRecoverableDOMError, tracker,
    click: options => handle._click(progress, options || {}),
    dblclick: options => handle._dblclick(progress, options || {}),
    outerRetry: action => retryFrame.retryWithProgressAndTimeouts(progress, [0], action),
    pause: () => { paused = true; }, expire: () => { expired = true; }, abort: () => { running = false; },
    destroyContext: () => { contextDestroyed = true; },
    counts: () => ({ began, closed: tracker ? began - (tracker.attachments.get(7).pointerGuard ? 1 : 0) : closed, nativeMoves, frameChecks }) };
}

test("pinned patch fails closed on changed injection, click, retry and native mouse/keyboard shapes", () => {
  for (const anchor of ["this._allHitTargetInterceptorEvents =", "setupHitTargetInterceptor(node, action, hitPoint, blockAllEvents)",
    "  _click(progress2, options2) {", "  _dblclick(progress2, options2) {", "      await action(point);",
    "let RawMouseImpl$3 = class RawMouseImpl {", "async ensureModifiers(mm)", "let RawKeyboardImpl$3 = class RawKeyboardImpl {",
    "async keydown(modifiers, keyName, description, autoRepeat)"])
    assert.throws(() => patchCrxPointerDelivery(upstream.replace(anchor, "changed native shape")), /shape changed|method changed/);
  assert.throws(() => patchCrxPointerDelivery(patched), /shape changed/);
  assert.match(patched, /tagPointerCommand\(\{/);
});

test("actual old CRX submits buttons after a missing move; patched pre-press retries same coordinates before one click", async () => {
  const old = fixture({ source: upstream, dropMoves: 1 });
  assert.equal(await old.click(), "done");
  assert.deepEqual(old.calls.map(call => call.params.type), ["mouseMoved", "mousePressed", "mouseReleased"]);
  const fixed = fixture({ dropMoves: 1 });
  assert.equal(await fixed.click(), "done");
  assert.deepEqual(fixed.calls.map(call => call.params.type), ["mouseMoved", "mouseMoved", "mousePressed", "mouseReleased"]);
  assert.ok(fixed.calls.every(call => call.ticket));
  assert.deepEqual(fixed.calls.slice(0, 2).map(call => [call.params.x, call.params.y]), [[30, 40], [30, 40]]);
  assert.ok(fixed.logs.some(line => line.includes("retrying click")));
  assert.deepEqual(fixed.counts(), { began: 1, closed: 1, nativeMoves: 2, frameChecks: 3 });
  assert.ok(fixed.handles.every(handle => handle.disposed));
});

test("synthetic, non-mouse, non-primary, foreign target and held-button receipts cannot authorize press", () => {
  const doc = {}, node = { isConnected: true, ownerDocument: doc };
  const injected = { document: doc, expectHitTarget: () => "done" };
  const event = { type: "pointermove", pointerType: "mouse", isPrimary: true, isTrusted: true, buttons: 0, clientX: 30, clientY: 40, composedPath: () => [node] };
  for (const overrides of [{ type: "mousemove" }, { isTrusted: false }, { pointerType: "touch" }, { pointerType: "pen" },
    { pointerType: undefined }, { isPrimary: false }, { isPrimary: undefined }, { composedPath: () => [{}] }, { buttons: 1 },
    { clientX: NaN }, { clientY: Infinity }]) {
    const receipt = createPointerMoveReceipt(injected, node, node, { x: 30, y: 40 }, 1);
    receipt.observe({ ...event, ...overrides });
    assert.notEqual(receipt.read(1).status, "ready");
  }
  const receipt = createPointerMoveReceipt(injected, node, node, { x: 30.4, y: 40.6 }, 2);
  receipt.observe(event); assert.equal(receipt.read(2).status, "ready");
  assert.equal(receipt.read(1).status, "invalid");
  receipt.close(); receipt.observe(event); assert.equal(receipt.read(2).status, "invalid");
});

test("original document/node loss invalidates a previously matching move", () => {
  const doc = {}, node = { isConnected: true, ownerDocument: doc };
  const receipt = createPointerMoveReceipt({ document: doc, expectHitTarget: () => "done" }, node, node, null, 1);
  receipt.observe({ type: "pointermove", pointerType: "mouse", isPrimary: true, isTrusted: true, buttons: 0, clientX: 0, clientY: 0, composedPath: () => [node] });
  node.ownerDocument = {}; assert.equal(receipt.read(1).status, "invalid");
});

test("actual injected global pointer listener accepts fractional local delivery without layout-coordinate equivalence", () => {
  const f = fixture(), hits = [];
  assert.deepEqual({ ...f.windowListeners.get("pointermove").options }, { capture: true, passive: false });
  f.injected.expectHitTarget = point => { hits.push({ ...point }); return "done"; };
  // These layout points are the recorded 9FyKTv regressions. The fractional
  // event values are explicit inputs, not claimed as measured PointerEvents.
  for (const [planned, delivered] of [
    [{ x: 306.28, y: 20.33 }, { x: 306.12, y: 19.125 }],
    [{ x: 50.663328, y: 147.240813 }, { x: 49.75, y: 146.125 }]
  ]) {
    const receipt = f.injected.setupHitTargetInterceptor(f.node, "mouse", planned, false, 7);
    f.emit("pointermove", { clientX: delivered.x, clientY: delivered.y });
    assert.equal(receipt.readMoveReceipt(7, { point: planned }).status, "ready");
    assert.ok(hits.some(point => point.x === delivered.x && point.y === delivered.y), "the fractional event reaches the local hit test unchanged");
    f.emit("mousemove", { clientX: -500, clientY: -500, composedPath: () => [] });
    assert.equal(receipt.readMoveReceipt(7, { point: planned }).status, "ready", "compatibility mousemove cannot overwrite the pointer receipt");
    assert.equal(receipt.readMoveReceipt(7, { point: { x: planned.x + 0.001, y: planned.y } }).status, "invalid", "original/final geometry still matches exactly");
    receipt.stop();
  }
});

test("actual injected pointer receipt rejects wrong target, local hit denial and non-mouse events", () => {
  const f = fixture(), point = { x: 30, y: 40 };
  for (const overrides of [{ pointerType: "pen" }, { pointerType: "touch" }, { isPrimary: false },
    { isTrusted: false }, { buttons: 1 }, { composedPath: () => [{}] }]) {
    const receipt = f.injected.setupHitTargetInterceptor(f.node, "mouse", point, false, 3);
    f.emit("pointermove", overrides);
    assert.notEqual(receipt.readMoveReceipt(3).status, "ready");
    receipt.stop();
  }
  const denied = f.injected.setupHitTargetInterceptor(f.node, "mouse", point, false, 4);
  f.injected.expectHitTarget = () => ({ hitTargetDescription: "local overlay" });
  f.emit("pointermove");
  assert.equal(denied.readMoveReceipt(4).status, "invalid");
  denied.stop();
});

test("unchanged geometry cannot reuse a receipt if only the planned local point becomes covered", () => {
  const f = fixture(), planned = { x: 30, y: 40 }, delivered = { x: 28.25, y: 38.5 };
  const receipt = f.injected.setupHitTargetInterceptor(f.node, "mouse", planned, false, 1);
  f.emit("pointermove", { clientX: delivered.x, clientY: delivered.y });
  assert.equal(receipt.readMoveReceipt(1).status, "ready");
  f.injected.expectHitTarget = point => point.x === planned.x && point.y === planned.y ? { hitTargetDescription: "planned-point overlay" } : "done";
  assert.equal(receipt.readMoveReceipt(1, { point: planned }).status, "invalid");
  assert.equal(f.calls.length, 0, "receipt observation never submits buttons");
  receipt.stop();
});

test("fractional routed receipt passes the full click path without modifying the original root input coordinates", async () => {
  const rootPoint = { x: 430.22, y: 612.88 }, planned = { x: 50.663328, y: 147.240813 };
  const f = fixture({ moveEvent: { clientX: 49.75, clientY: 146.125 } });
  f.handle._clickablePoint = async () => rootPoint;
  f.handle._checkFrameIsHitTarget = async () => ({ framePoint: planned, frameGeometry: ["original frame"] });
  assert.equal(await f.click(), "done");
  assert.deepEqual(f.nativeCalls.map(call => [call.params.type, call.params.x, call.params.y]), [
    ["mouseMoved", rootPoint.x, rootPoint.y], ["mousePressed", rootPoint.x, rootPoint.y], ["mouseReleased", rootPoint.x, rootPoint.y]
  ]);
});

function plannedPointOverlayFixture(bridge = pointerDeliveryBridge) {
  const f = fixture({ bridge, moveEvent: { clientX: 28.25, clientY: 38.5 } });
  let stateChecks = 0, prechecks = 0;
  f.page.performActionPreChecks = async () => {
    // Keep the entire first attempt live. Only an actual actionability retry
    // reaches this second original precheck, before it can send another move.
    if (++prechecks === 2) f.expire();
  };
  f.injected.checkElementStates = () => {
    if (++stateChecks === 2) f.injected.expectHitTarget = point =>
      point.x === 30 && point.y === 40 ? { hitTargetDescription: "planned-point overlay" } : "done";
  };
  return { f, counts: () => ({ stateChecks, prechecks }) };
}

test("the actual click bridge retries without buttons when hover covers only the planned local point", async () => {
  const { f, counts } = plannedPointOverlayFixture();
  await assert.rejects(f.click(), /OBU_POINTER_.*deadline expired/);
  assert.deepEqual(counts(), { stateChecks: 2, prechecks: 2 });
  assert.ok(f.logs.some(line => line.includes("retrying click")), "the invalid receipt must enter the original retry before expiry");
  assert.deepEqual(f.nativeCalls.map(call => call.params.type), ["mouseMoved"]);
  assert.equal(f.counts().closed, 1);
});

test("planned-point overlay regression detects an in-memory bridge that ignores the final receipt status", async () => {
  const condition = 'if (finalReceipt?.attempt !== attempt || finalReceipt.status !== "ready")';
  assert.equal(pointerDeliveryBridge.split(condition).length, 2);
  const mutant = pointerDeliveryBridge.replace(condition, "if (finalReceipt?.attempt !== attempt)");
  const { f, counts } = plannedPointOverlayFixture(mutant);
  // The legacy press interceptor still rejects the now-covered point, but
  // that is after native buttons. This must not masquerade as pre-press safety.
  await assert.rejects(f.click(), /OBU_POINTER_.*planned-point overlay/);
  assert.deepEqual(counts(), { stateChecks: 2, prechecks: 1 });
  assert.equal(f.logs.some(line => line.includes("retrying click")), false);
  assert.deepEqual(f.nativeCalls.map(call => call.params.type), ["mouseMoved", "mousePressed", "mouseReleased"]);
  assert.equal(f.counts().closed, 1);
});

test("stopped receipt cannot affect its successor and legacy press interception still blocks a wrong target", () => {
  const f = fixture(), point = { x: 30, y: 40 };
  const old = f.injected.setupHitTargetInterceptor(f.node, "mouse", point, false, 1);
  old.stop();
  const next = f.injected.setupHitTargetInterceptor(f.node, "mouse", point, false, 2);
  f.emit("pointermove");
  assert.equal(old.readMoveReceipt(1).status, "invalid");
  assert.equal(next.readMoveReceipt(2).status, "ready");
  next.stop();
  const legacy = f.injected.setupHitTargetInterceptor(f.node, "mouse", point, false);
  let blocked = 0;
  f.emit("pointermove", { clientX: -500, clientY: -500, composedPath: () => [] });
  f.injected.expectHitTarget = () => ({ hitTargetDescription: "press overlay" });
  f.emit("pointerdown", { preventDefault() { blocked++; } });
  assert.equal(blocked, 1);
  assert.match(legacy.stop().hitTargetDescription, /press overlay/);
});

test("move is really awaited; Pause during its ACK prevents every press and closes the ticket", async () => {
  const ack = deferred(), entered = deferred();
  const f = fixture({ onSend: async ({ params }) => { if (params.type === "mouseMoved") { entered.resolve(); await ack.promise; } } });
  const action = f.click(); await entered.promise; await flush();
  assert.deepEqual(f.calls.map(call => call.params.type), ["mouseMoved"]);
  f.pause(); ack.resolve();
  await assert.rejects(action, error => error instanceof f.NonRecoverableDOMError && /OBU_POINTER_.*control revoked/.test(error.message));
  assert.equal(f.counts().closed, 1); assert.equal(f.calls.length, 1);
});

test("original monotonic deadline is checked even before its abort timer runs", async () => {
  const f = fixture({ onSend: ({ params }) => { if (params.type === "mouseMoved") f.expire(); } });
  await assert.rejects(f.click(), /OBU_POINTER_.*deadline expired/);
  assert.equal(f.calls.length, 1); assert.equal(f.counts().closed, 1);
});

test("stale attempt ID is terminal and not an actionability retry", async () => {
  const f = fixture(); const evaluate = f.handle.evaluateHandleInUtility;
  f.handle.evaluateHandleInUtility = async (...args) => {
    const handle = await evaluate(...args), read = handle.evaluate;
    handle.evaluate = (fn, arg) => String(fn).includes("readMoveReceipt") ? { attempt: 99, status: "ready" } : read.call(handle, fn, arg);
    return handle;
  };
  await assert.rejects(f.click(), error => error instanceof f.NonRecoverableDOMError && /stale/.test(error.message));
  assert.equal(f.calls.length, 1);
});

test("native move rejection and native press rejection never replay the public click", async () => {
  for (const type of ["mouseMoved", "mousePressed"]) {
    const original = new Error("native rejected");
    const f = fixture({ onSend: ({ params }) => { if (params.type === type) throw original; } });
    await assert.rejects(f.click(), error => error instanceof f.NonRecoverableDOMError && error.cause === original);
    assert.deepEqual(f.calls.map(call => call.params.type), type === "mouseMoved" ? ["mouseMoved"] : ["mouseMoved", "mousePressed"]);
    assert.equal(f.counts().closed, 1);
  }
});

test("an explicit hit interception error after buttons is non-recoverable, including noWaitAfter", async () => {
  for (const waitAfter of [true, false]) {
    const f = fixture({ stopResult: { hitTargetDescription: "overlay appeared after move" } });
    await assert.rejects(f.click({ waitAfter }), error => error instanceof f.NonRecoverableDOMError && /overlay appeared/.test(error.message));
    assert.deepEqual(f.calls.map(call => call.params.type), ["mouseMoved", "mousePressed", "mouseReleased"]);
  }
});

test("a navigation destroying the old utility context retains upstream success without a second click", async () => {
  for (const waitAfter of [true, false]) {
    const f = fixture({ stopError: new Error("Execution context was destroyed by navigation") });
    const original = f.page.mouse.up.bind(f.page.mouse);
    f.page.mouse.up = async (...args) => { await original(...args); f.destroyContext(); };
    assert.equal(await f.click({ waitAfter }), "done");
    assert.equal(f.page.waitAfter, waitAfter);
    assert.deepEqual(f.calls.map(call => call.params.type), ["mouseMoved", "mousePressed", "mouseReleased"]);
  }
});

test("a hover-created child overlay invalidates the old receipt and requires a new move", async () => {
  const f = fixture(); let checks = 0;
  f.injected.checkElementStates = () => {
    if (++checks === 2) f.injected.expectHitTarget = () => ({ hitTargetDescription: "child overlay" });
    if (checks === 3) f.injected.expectHitTarget = () => "done";
  };
  assert.equal(await f.click(), "done");
  assert.deepEqual(f.calls.map(call => call.params.type), ["mouseMoved", "mouseMoved", "mousePressed", "mouseReleased"]);
});

test("a target disabled by hover is rechecked before any press", async () => {
  const f = fixture(); let checks = 0;
  f.injected.checkElementStates = () => ++checks === 2 ? { missingState: "enabled" } : undefined;
  assert.equal(await f.click(), "done");
  assert.deepEqual(f.calls.map(call => call.params.type), ["mouseMoved", "mouseMoved", "mousePressed", "mouseReleased"]);
  assert.equal(checks, 4, "both attempts retain pre-move and post-move state checks");
});

test("iframe movement cannot use a receipt from the previous local coordinates", async () => {
  const f = fixture(); let checks = 0;
  f.handle._checkFrameIsHitTarget = async () => ({ framePoint: { x: ++checks === 2 ? 20 : 30, y: 40 }, frameGeometry: ["original frame"] });
  assert.equal(await f.click(), "done");
  assert.deepEqual(f.calls.map(call => call.params.type), ["mouseMoved", "mouseMoved", "mousePressed", "mouseReleased"]);
});

test("same-session context destruction during an asynchronous native journal rejects late press", async () => {
  const journal = deferred(), entered = deferred();
  const f = fixture({ onSend: async ({ params }) => { if (params.type === "mousePressed") { entered.resolve(); await journal.promise; } } });
  const action = f.click(); await entered.promise;
  f.destroyContext(); journal.resolve();
  await assert.rejects(action, error => error instanceof f.NonRecoverableDOMError && /context\/attachment changed/.test(error.message));
  assert.deepEqual(f.calls.map(call => call.params.type), ["mouseMoved", "mousePressed"]);
  assert.deepEqual(f.nativeCalls.map(call => call.params.type), ["mouseMoved"], "the late press never reaches native send");
  assert.equal(f.counts().closed, 1);
});

test("a replaced utility context cannot borrow a fresh context on another attempt", async () => {
  const f = fixture({ dropMoves: 1 }); const evaluate = f.handle.evaluateHandleInUtility;
  f.handle.evaluateHandleInUtility = async (...args) => {
    const value = await evaluate(...args);
    if (f.handles.length === 2) value._context = { ...f.context };
    return value;
  };
  await assert.rejects(f.click(), /original utility context changed/);
  assert.deepEqual(f.calls.map(call => call.params.type), ["mouseMoved"]);
});

test("force, trial, held modifiers and standalone CRX keep the unguarded path", async () => {
  for (const action of ["click", "dblclick"]) for (const options of [{ force: true }, { trial: true }, { force: true, modifiers: ["Shift"] }]) {
    const f = fixture(); await f[action](options); assert.equal(f.counts().began, 0); assert.ok(f.calls.every(call => !call.ticket));
  }
  const held = fixture(); held.page.keyboard._modifiers = () => new Set(["Shift"]); await held.click(); assert.equal(held.counts().began, 0);
  const standalone = fixture({ noHooks: true }); await standalone.click(); assert.equal(standalone.counts().began, 0);
});

test("guarded delay uses the same deadline and never releases through an expired ticket", async () => {
  const f = fixture({ delayHook: () => f.expire() });
  await assert.rejects(f.click({ delay: 5 }), /deadline expired/);
  assert.deepEqual(f.calls.map(call => call.params.type), ["mouseMoved", "mousePressed"]);
  assert.deepEqual(f.waits, [5]);
});

test("counted click and dblclick await one receipt then send each numbered pair exactly once", async () => {
  for (const [action, options, count] of [["dblclick", {}, 2], ["click", { clickCount: 3 }, 3]]) {
    const old = fixture({ source: upstream, dropMoves: 1 });
    assert.equal(await old[action](options), "done");
    assert.equal(old.calls.filter(call => call.params.type === "mouseMoved").length, 1);
    assert.equal(old.calls.filter(call => call.params.type === "mousePressed").length, count, "old buttons did not wait for delivery");
    const fixed = fixture({ dropMoves: 1, tracked: true });
    assert.equal(await fixed[action](options), "done");
    const expected = [["mouseMoved", undefined], ["mouseMoved", undefined]];
    for (let index = 1; index <= count; index++) expected.push(["mousePressed", index], ["mouseReleased", index]);
    assert.deepEqual(fixed.calls.map(call => [call.params.type, call.params.clickCount]), expected);
    assert.ok(fixed.calls.every(call => call.ticket));
    assert.equal(fixed.counts().began, 1); assert.equal(fixed.counts().closed, 1);
    const buttons = fixed.timeline.filter(event => ["mousePressed", "mouseReleased"].includes(event.type));
    assert.deepEqual(buttons.map(event => event.phase), Array.from({ length: count * 2 }, () => ["start", "ack"]).flat());
    if (action === "dblclick") {
      assert.equal(fixed.page.waitAfter, old.page.waitAfter);
      assert.equal(fixed.page.waitAfter, false, "original disabled option does not wait for navigation signals");
    }
  }
});

test("counted click does not send up or a later down until the previous native ACK", async () => {
  const ack = deferred(), entered = deferred();
  const f = fixture({ tracked: true, onSend: async ({ params }) => {
    if (params.type === "mousePressed" && params.clickCount === 1) { entered.resolve(); await ack.promise; }
  } });
  const action = f.dblclick(); await entered.promise; await flush();
  assert.deepEqual(f.calls.map(call => call.params.type), ["mouseMoved", "mousePressed"]);
  ack.resolve(); assert.equal(await action, "done");
  assert.deepEqual(f.calls.slice(1).map(call => [call.params.type, call.params.clickCount]), [
    ["mousePressed", 1], ["mouseReleased", 1], ["mousePressed", 2], ["mouseReleased", 2]
  ]);
});

test("counted click preserves button, coordinates and both kinds of original delay under one deadline", async () => {
  const f = fixture({ tracked: true });
  assert.equal(await f.click({ clickCount: 3, button: "right", delay: 7 }), "done");
  assert.deepEqual(f.waits, [7, 7, 7, 7, 7], "three down/up delays and two inter-click delays");
  assert.ok(f.calls.every(call => call.params.x === 30 && call.params.y === 40));
  assert.ok(f.calls.slice(1).every(call => call.params.button === "right"));
  assert.deepEqual(f.calls.slice(1).map(call => call.params.buttons), [2, 0, 2, 0, 2, 0]);
  let delays = 0;
  const expired = fixture({ delayHook: () => { if (++delays === 2) expired.expire(); } });
  await assert.rejects(expired.dblclick({ delay: 7 }), /OBU_POINTER_.*deadline expired/);
  assert.deepEqual(expired.calls.map(call => call.params.type), ["mouseMoved", "mousePressed", "mouseReleased"]);
});

test("a rejected second press is terminal at the actual outer retry policy", async () => {
  const original = new Error("second native down rejected"); let attempts = 0;
  const f = fixture({ tracked: true, onSend: ({ params }) => {
    if (params.type === "mousePressed" && params.clickCount === 2) throw original;
  } });
  await assert.rejects(f.outerRetry(() => { attempts++; return f.dblclick(); }), error =>
    error instanceof f.NonRecoverableDOMError && error.cause === original);
  assert.equal(attempts, 1);
  assert.deepEqual(f.calls.map(call => [call.params.type, call.params.clickCount]), [
    ["mouseMoved", undefined], ["mousePressed", 1], ["mouseReleased", 1], ["mousePressed", 2]
  ]);
  assert.ok(f.tracker.hasHeld(f.tracker.attachments.get(7)), "unknown second down remains tracked for engine cleanup");
});

test("Pause during the second press journal prevents late native buttons and does not restart the sequence", async () => {
  const ack = deferred(), entered = deferred();
  const f = fixture({ tracked: true, onSend: async ({ params }) => {
    if (params.type === "mousePressed" && params.clickCount === 2) { entered.resolve(); await ack.promise; }
  } });
  const action = f.dblclick(); await entered.promise; f.pause(); ack.resolve();
  await assert.rejects(action, /OBU_POINTER_.*control revoked/);
  assert.deepEqual(f.nativeCalls.map(call => [call.params.type, call.params.clickCount]), [
    ["mouseMoved", undefined], ["mousePressed", 1], ["mouseReleased", 1]
  ]);
  assert.equal(f.counts().closed, 1);
});

test("observed target or ancestor navigation blocks the next counted press but final navigation remains successful", async () => {
  for (const changed of ["context", "frame", "parentFrame"]) {
    const f = fixture({ tracked: true });
    const original = f.page.mouse.up.bind(f.page.mouse);
    f.page.mouse.up = async options => {
      await original(options);
      if (changed === "context") f.destroyContext();
      else f[changed].pendingDocument = () => ({ documentId: "next" });
    };
    await assert.rejects(f.dblclick(), /OBU_POINTER_.*(context\/attachment changed|navigation interrupted)/);
    assert.deepEqual(f.calls.map(call => call.params.type), ["mouseMoved", "mousePressed", "mouseReleased"]);
  }
  const final = fixture({ stopError: new Error("Execution context destroyed"), tracked: true });
  const up = final.page.mouse.up.bind(final.page.mouse);
  final.page.mouse.up = async options => {
    await up(options);
    if (options.clickCount === 2) { final.destroyContext(); final.parentFrame.pendingDocument = () => ({}); }
  };
  assert.equal(await final.dblclick({ modifiers: ["Shift"] }), "done");
  assert.equal(final.calls.at(-1).params.type, "keyUp", "final navigation still restores this action's modifier");
  assert.equal(final.page.keyboard._modifiers().size, 0);
});

test("navigation observed while a later press waits in the journal is rechecked at native send", async () => {
  const ack = deferred(), entered = deferred();
  const f = fixture({ onSend: async ({ params }) => {
    if (params.type === "mousePressed" && params.clickCount === 2) { entered.resolve(); await ack.promise; }
  } });
  const action = f.dblclick(); await entered.promise;
  f.parentFrame.pendingDocument = () => ({ documentId: "top-navigation" }); ack.resolve();
  await assert.rejects(action, /OBU_POINTER_.*navigation interrupted/);
  assert.deepEqual(f.nativeCalls.map(call => [call.params.type, call.params.clickCount]), [
    ["mouseMoved", undefined], ["mousePressed", 1], ["mouseReleased", 1]
  ]);
});

test("same-context node replacement or local cover between counted clicks cannot redirect the second click", async () => {
  for (const changed of ["node", "hit"]) {
    const f = fixture(); const original = f.page.mouse.up.bind(f.page.mouse);
    f.page.mouse.up = async options => {
      await original(options);
      if (changed === "node") f.node.isConnected = false;
      else f.injected.expectHitTarget = () => ({ hitTargetDescription: "new overlay" });
    };
    await assert.rejects(f.dblclick(), /OBU_POINTER_.*target changed between counted clicks/);
    assert.deepEqual(f.calls.map(call => call.params.type), ["mouseMoved", "mousePressed", "mouseReleased"]);
    assert.equal(f.handles.length, 1, "no replacement node or second receipt was acquired");
  }
});

test("missing initial or later frame geometry cannot authorize native buttons", async () => {
  for (const missingAt of [1, 2, 3]) {
    const f = fixture({ tracked: true }); let checks = 0;
    f.handle._checkFrameIsHitTarget = async () => ({ framePoint: { x: 30, y: 40 },
      ...(++checks === missingAt ? {} : { frameGeometry: ["original frame"] }) });
    if (missingAt === 2) {
      await f.click();
      assert.deepEqual(f.nativeCalls.map(call => call.params.type), ["mouseMoved", "mouseMoved", "mousePressed", "mouseReleased"]);
    } else {
      await assert.rejects(f.dblclick(), /OBU_POINTER_.*(geometry is unavailable|frame changed between counted clicks)/);
      assert.equal(f.nativeCalls.filter(call => call.params.type === "mousePressed").length, missingAt === 1 ? 0 : 1);
    }
    assert.ok(f.handles.every(handle => handle.disposed));
  }
});

test("hover geometry changes around an unchanged local point require another preparation move", async () => {
  const f = fixture({ tracked: true }); let checks = 0;
  f.handle._checkFrameIsHitTarget = async () => ({ framePoint: { x: 30, y: 40 },
    frameGeometry: [{ frameId: "child", quad: ++checks === 1 ? [1, 2, 3, 4] : [2, 1, 4, 3] }] });
  await f.click();
  assert.equal(checks, 4, "each attempt captures its own initial and post-move geometry");
  assert.deepEqual(f.nativeCalls.map(call => call.params.type), ["mouseMoved", "mouseMoved", "mousePressed", "mouseReleased"]);
  assert.equal(f.handles.length, 2); assert.ok(f.handles.every(handle => handle.disposed));
});

test("a changed frame projection cannot reuse the first click receipt even at the same local point", async () => {
  const f = fixture({ tracked: true }); let checks = 0;
  f.handle._checkFrameIsHitTarget = async () => ({ framePoint: { x: 30, y: 40 },
    frameGeometry: [{ frameId: "child", quad: ++checks <= 2 ? [1, 2, 3, 4] : [2, 1, 4, 3] }] });
  let attempts = 0;
  await assert.rejects(f.outerRetry(() => { attempts++; return f.dblclick(); }), /OBU_POINTER_.*frame changed between counted clicks/);
  assert.equal(attempts, 1); assert.equal(checks, 3);
  assert.deepEqual(f.nativeCalls.map(call => [call.params.type, call.params.clickCount]), [
    ["mouseMoved", undefined], ["mousePressed", 1], ["mouseReleased", 1]
  ]);
  assert.ok(f.handles.every(handle => handle.disposed));
});

for (const changed of ["ancestor-cover", "frame-point", "disconnected-frame"]) {
  test(`later counted ancestor check rejects ${changed} without replaying the first pair`, async () => {
    const f = fixture({ tracked: true }), checks = [];
    const originalUp = f.page.mouse.up.bind(f.page.mouse);
    f.page.mouse.up = async options => {
      await originalUp(options);
      if (options.clickCount !== 1) return;
      const local = await f.handles[0].evaluate(h => h.readMoveReceipt(1));
      assert.equal(local.status, "ready", "the old local receipt cannot detect an ancestor move or cover");
      f.handle._checkFrameIsHitTarget = async point => {
        checks.push({ ...point });
        if (changed === "ancestor-cover") return { hitTargetDescription: "parent overlay" };
        if (changed === "disconnected-frame") return "error:notconnected";
        return { framePoint: { x: 31, y: 40 }, frameGeometry: ["original frame"] };
      };
    };
    let attempts = 0;
    await assert.rejects(f.outerRetry(() => { attempts++; return f.dblclick({ modifiers: ["Shift"] }); }), error =>
      error instanceof f.NonRecoverableDOMError && /OBU_POINTER_.*(frame|target) changed between counted clicks/.test(error.message));
    assert.equal(attempts, 1, "an already committed first click cannot restart at the locator retry layer");
    assert.deepEqual(checks, [{ x: 30, y: 40 }], "reuse the original root point without another move or retarget");
    assert.deepEqual(f.nativeCalls.filter(call => call.method === "Input.dispatchMouseEvent").map(call => [call.params.type, call.params.clickCount]), [
      ["mouseMoved", undefined], ["mousePressed", 1], ["mouseReleased", 1]
    ]);
    assert.equal(f.handles.length, 1); assert.ok(f.handles.every(handle => handle.disposed));
    assert.equal(f.page.keyboard._modifiers().size, 0);
    assert.equal(f.tracker.hasHeld(f.tracker.attachments.get(7)), false);
    assert.equal(f.counts().closed, 1);
  });
}

test("each later counted press rechecks the original root point including the third pair", async () => {
  const f = fixture({ tracked: true }), points = [];
  const originalUp = f.page.mouse.up.bind(f.page.mouse);
  f.page.mouse.up = async options => {
    await originalUp(options);
    f.handle._checkFrameIsHitTarget = async point => {
      points.push({ count: options.clickCount + 1, ...point });
      return { framePoint: { x: options.clickCount === 1 ? 30 : 31, y: 40 }, frameGeometry: ["original frame"] };
    };
  };
  let attempts = 0;
  await assert.rejects(f.outerRetry(() => { attempts++; return f.click({ clickCount: 3 }); }), /OBU_POINTER_.*target changed between counted clicks/);
  assert.equal(attempts, 1);
  assert.deepEqual(points, [{ count: 2, x: 30, y: 40 }, { count: 3, x: 30, y: 40 }]);
  assert.deepEqual(f.nativeCalls.map(call => [call.params.type, call.params.clickCount]), [
    ["mouseMoved", undefined], ["mousePressed", 1], ["mouseReleased", 1], ["mousePressed", 2], ["mouseReleased", 2]
  ]);
  assert.equal(f.handles.length, 1); assert.equal(f.counts().closed, 1);
});

test("a held later ancestor check preserves errors and cannot send after Pause, deadline or context loss", { timeout: 2000 }, async () => {
  for (const changed of ["pause", "deadline", "context", "read-error"]) {
    const f = fixture({ tracked: true }), entered = deferred(), result = deferred();
    const original = Object.freeze(new Error("ancestor read rejected"));
    const originalUp = f.page.mouse.up.bind(f.page.mouse);
    f.page.mouse.up = async options => {
      await originalUp(options);
      f.handle._checkFrameIsHitTarget = async () => { entered.resolve(); return result.promise; };
    };
    let attempts = 0;
    const action = f.outerRetry(() => { attempts++; return f.dblclick(); });
    await entered.promise;
    if (changed === "pause") f.pause();
    if (changed === "deadline") f.expire();
    if (changed === "context") f.destroyContext();
    if (changed === "read-error") result.reject(original);
    else result.resolve({ framePoint: { x: 30, y: 40 }, frameGeometry: ["original frame"] });
    await assert.rejects(action, error => error instanceof f.NonRecoverableDOMError &&
      /^OBU_POINTER_/.test(error.message) && (changed !== "read-error" || error.cause === original));
    assert.equal(attempts, 1);
    assert.deepEqual(f.nativeCalls.map(call => [call.params.type, call.params.clickCount]), [
      ["mouseMoved", undefined], ["mousePressed", 1], ["mouseReleased", 1]
    ]);
    assert.ok(f.handles.every(handle => handle.disposed)); assert.equal(f.counts().closed, 1);
  }
});

test("actual Keyboard and RawKeyboard carry private modifier tickets and restore each retry baseline", async () => {
  const f = fixture({ dropMoves: 1, tracked: true });
  assert.equal(await f.dblclick({ modifiers: ["Shift"] }), "done");
  assert.deepEqual(f.calls.map(call => [call.params.type, call.params.modifiers]), [
    ["rawKeyDown", 8], ["mouseMoved", 8], ["keyUp", 0],
    ["rawKeyDown", 8], ["mouseMoved", 8], ["mousePressed", 8], ["mouseReleased", 8],
    ["mousePressed", 8], ["mouseReleased", 8], ["keyUp", 0]
  ]);
  assert.ok(f.calls.every(call => call.ticket), "modifier keys must not invalidate their own real tracker ticket");
  assert.equal(f.page.keyboard._modifiers().size, 0); assert.equal(f.page.keyboard._pressedKeys.size, 0);
  assert.equal(f.tracker.hasHeld(f.tracker.attachments.get(7)), false);
  assert.equal(f.counts().began, 1); assert.equal(f.counts().closed, 1);
});

test("explicit empty modifiers and ControlOrMeta retain pinned keyboard semantics", async () => {
  for (const platform of ["win32", "darwin"]) {
    const f = fixture({ platform, tracked: true });
    assert.equal(await f.click({ modifiers: ["ControlOrMeta"], clickCount: 2 }), "done");
    assert.deepEqual(f.calls.filter(call => call.method === "Input.dispatchKeyEvent").map(call => [call.params.type, call.params.key]),
      [["rawKeyDown", platform === "darwin" ? "Meta" : "Control"], ["keyUp", platform === "darwin" ? "Meta" : "Control"]]);
    assert.ok(f.calls.filter(call => call.method === "Input.dispatchMouseEvent").every(call => call.params.modifiers === (platform === "darwin" ? 4 : 2)));
  }
  const empty = fixture({ tracked: true }); assert.equal(await empty.click({ modifiers: [] }), "done");
  assert.ok(empty.calls.every(call => call.method === "Input.dispatchMouseEvent"));
});

test("partial ensureModifiers failure restores the original baseline even before ensure returned", async () => {
  const original = new Error("second modifier failed");
  const f = fixture({ tracked: true, onSend: ({ params }) => {
    if (params.type === "rawKeyDown" && params.key === "Shift") throw original;
  } });
  await assert.rejects(f.click({ modifiers: ["Control", "Shift"] }), error =>
    error instanceof f.NonRecoverableDOMError && error.cause === original);
  assert.deepEqual(f.calls.map(call => [call.params.type, call.params.key]), [
    ["rawKeyDown", "Control"], ["rawKeyDown", "Shift"], ["keyUp", "Control"], ["keyUp", "Shift"]
  ]);
  assert.ok(f.calls.every(call => call.ticket)); assert.equal(f.page.keyboard._modifiers().size, 0);
  assert.equal(f.tracker.hasHeld(f.tracker.attachments.get(7)), false);
});

test("modifier restoration failure preserves the action error and unknown held keys", async () => {
  for (const frozen of [false, true]) {
    const original = new Error("native move failed"), cleanup = new Error("restore keyup failed");
    if (frozen) Object.freeze(original);
    const f = fixture({ tracked: true, onSend: ({ params }) => {
      if (params.type === "mouseMoved") throw original;
      if (params.type === "keyUp") throw cleanup;
    } });
    await assert.rejects(f.dblclick({ modifiers: ["Shift"] }), error =>
      error instanceof f.NonRecoverableDOMError && error.cause === original &&
      (frozen || original.pointerModifierRestoreError === cleanup));
    assert.deepEqual(f.calls.map(call => call.params.type), ["rawKeyDown", "mouseMoved", "keyUp"]);
    assert.ok(f.tracker.hasHeld(f.tracker.attachments.get(7)), "failed keyup is still native input uncertainty despite local Keyboard bookkeeping");
  }
});

test("restore-only failure cannot report a successful counted click or replay its buttons", async () => {
  const original = new Error("final keyup failed"); let attempts = 0;
  const f = fixture({ tracked: true, onSend: ({ params }) => { if (params.type === "keyUp") throw original; } });
  await assert.rejects(f.outerRetry(() => { attempts++; return f.dblclick({ modifiers: ["Shift"] }); }), error =>
    error instanceof f.NonRecoverableDOMError && error.cause === original);
  assert.equal(attempts, 1);
  assert.equal(f.calls.filter(call => call.params.type === "mousePressed").length, 2);
  assert.ok(f.tracker.hasHeld(f.tracker.attachments.get(7)));
});

test("Pause or deadline during modifier setup cannot emit a late modifier, move or ordinary restore", async () => {
  for (const cancel of ["pause", "expire"]) {
    const journal = deferred(), entered = deferred();
    const f = fixture({ tracked: true, onSend: async ({ params }) => {
      if (params.type === "rawKeyDown") { entered.resolve(); await journal.promise; }
    } });
    const action = f.click({ modifiers: ["Shift"] }); await entered.promise; f[cancel](); journal.resolve();
    await assert.rejects(action, /OBU_POINTER_.*(control revoked|deadline expired)/);
    assert.equal(f.nativeCalls.length, 0);
    assert.deepEqual(f.calls.map(call => call.params.type), ["rawKeyDown"]);
    assert.ok(f.tracker.hasHeld(f.tracker.attachments.get(7)), "engine cleanup owns the unconfirmed modifier intent");
    assert.equal(f.counts().closed, 1);
  }
});

test("unmodified legacy keyboard wire is unchanged when no pointer ticket is passed", async () => {
  const before = fixture({ source: upstream }), after = fixture();
  for (const f of [before, after]) {
    await f.page.keyboard.ensureModifiers(["Shift"]);
    await f.page.keyboard.down("KeyA"); await f.page.keyboard.up("KeyA");
    await f.page.keyboard.ensureModifiers([]);
  }
  assert.equal(JSON.stringify(after.calls), JSON.stringify(before.calls), "same serialized wire, including keyboard commands from separate VM realms");
  assert.ok(after.calls.every(call => !call.ticket));
});
