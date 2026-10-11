import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { test } from "node:test";
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

function fixture({ source = patched, bridge = pointerDeliveryBridge, dropMoves = 0, onSend, stopError, stopResult, noHooks = false, delayHook, moveEvent } = {}) {
  const calls = [], nativeCalls = [], handles = [], waits = [], logs = [], tags = new WeakMap();
  const windowListeners = new Map();
  const document = {}, node = { ownerDocument: document, isConnected: true };
  const identities = new Map([[7, {}]]), sessions = new Map([["child-session", 7]]);
  const transport = { _tabToTarget: identities, _sessions: sessions };
  let expired = false, paused = false, running = true, closed = 0, began = 0, nativeMoves = 0, frameChecks = 0;
  class CRExecutionContext {}
  class NonRecoverableDOMError extends Error {}
  let contextDestroyed = false;
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
    Error, Number, Set, Map, Symbol, Promise, CRExecutionContext, NonRecoverableDOMError,
    createPointerMoveReceipt,
    setTimeout: (callback, ms) => { waits.push(ms); if (delayHook) delayHook(ms); callback(); return 1; },
    roundPoint: value => value,
    assertDone: value => value, throwRetargetableDOMError: value => value,
    toButtonsMask$2: buttons => buttons.has("left") ? 1 : 0,
    toModifiersMask$2: () => 0,
    tagPointerCommand(params, ticket) { if (ticket) tags.set(params, ticket); return params; },
    openBrowserUseInputHooks: noHooks ? undefined : { beginPointerAction(target, check) {
      assert.deepEqual({ ...target }, { tabId: 7 }); began++;
      let ticketClosed = false;
      return { check() { check(); if (paused || ticketClosed) throw new Error("control revoked"); }, close() { ticketClosed = true; closed++; } };
    } }
  };
  const methods = slice(source, "  async _retryAction(", "  async _markAsTargetElement(") +
    slice(source, "  _click(progress2, options2) {", "  async dblclick(");
  const runtime = vm.runInNewContext(
    (source === upstream ? "" : injectedSource.slice(0, injectedSource.indexOf("\nvar __commonJS"))) +
    "class TestInjected {" + setup + globalSetup + "registerEventSet() {" + eventSet + "}}\n" +
    "class TestHandle {" + methods + "}\n" +
    slice(source, "let Mouse$1 = class Mouse {", "const aliases =") +
    slice(source, "let RawMouseImpl$3 = class RawMouseImpl {", "let RawTouchscreenImpl$3 =") +
    (source === upstream ? "" : bridge) +
    "\n({ TestInjected, TestHandle, Mouse: Mouse$1, RawMouse: RawMouseImpl$3 });", env);
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
      ticket?.check();
      calls.push({ method, params: { ...params }, ticket: !!ticket });
      if (params.type === "mouseMoved") nativeMoves++;
      if (onSend) await onSend({ method, params, emit, calls, nativeMoves, ticket, pause: () => { paused = true; } });
      // Emulate the transport's check immediately before actual native send.
      ticket?.check();
      nativeCalls.push({ method, params: { ...params } });
      if (params.type === "mouseMoved" && nativeMoves > dropMoves) { emit("pointermove", moveEvent); emit("mousemove", moveEvent); }
      if (params.type === "mousePressed") { emit("pointerdown"); emit("mousedown"); }
      if (params.type === "mouseReleased") { emit("pointerup"); emit("mouseup"); emit("click"); }
      return {};
    }
  };
  const keyboard = { _modifiers: () => new Set(), ensureModifiers: async () => undefined };
  const page = {
    keyboard, performActionPreChecks: async () => {},
    frameManager: { waitForSignalsCreatedBy: async (_progress, waitAfter, fn) => { page.waitAfter = waitAfter; return fn(); } }
  };
  page.mouse = new runtime.Mouse(new runtime.RawMouse(page, client, { isDragging: () => false, interceptDragCausedByMove: async (...args) => args.at(-1)() }), page);
  const frame = { _page: page, parentFrame: () => true, raceAgainstEvaluationStallingEvents: fn => fn() };
  frame._contextData = new Map([["utility", { context }]]);
  context.frame = frame;
  const handle = Object.assign(new runtime.TestHandle(), {
    _page: page, _frame: frame, _context: context, _disposed: false,
    instrumentation: { onBeforeInputAction: async () => {} },
    _scrollRectIntoViewIfNeeded: async () => "done", _clickablePoint: async () => ({ x: 30, y: 40 }),
    _checkFrameIsHitTarget: async () => { frameChecks++; return { framePoint: { x: 30, y: 40 } }; },
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
  return { handle, page, node, injected, emit, windowListeners, progress, calls, nativeCalls, handles, logs, waits, context, identities, sessions, NonRecoverableDOMError,
    click: options => handle._click(progress, options || {}),
    pause: () => { paused = true; }, expire: () => { expired = true; }, abort: () => { running = false; },
    destroyContext: () => { contextDestroyed = true; },
    counts: () => ({ began, closed, nativeMoves, frameChecks }) };
}

test("pinned patch fails closed on changed injection, click, retry and native mouse shapes", () => {
  for (const anchor of ["this._allHitTargetInterceptorEvents =", "setupHitTargetInterceptor(node, action, hitPoint, blockAllEvents)", "  _click(progress2, options2) {", "      await action(point);", "let RawMouseImpl$3 = class RawMouseImpl {"])
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
  f.handle._checkFrameIsHitTarget = async () => ({ framePoint: planned });
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
  f.handle._checkFrameIsHitTarget = async () => ({ framePoint: { x: ++checks === 2 ? 20 : 30, y: 40 } });
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

test("force, trial, multi-click, modifiers, held modifiers and standalone CRX keep the unguarded path", async () => {
  for (const options of [{ force: true }, { trial: true }, { clickCount: 2 }, { modifiers: ["Shift"] }]) {
    const f = fixture(); await f.click(options); assert.equal(f.counts().began, 0); assert.ok(f.calls.every(call => !call.ticket));
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
