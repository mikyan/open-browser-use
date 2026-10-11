import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { createPointerMoveReceipt, patchCrxPointerDelivery, pointerDeliveryBridge } from "./patch-pointer-delivery.mjs";
import { patchCrxFrameGeometry } from "./patch-frame-geometry.mjs";
import { createDragCommitGuard, patchCrxDragDelivery, dragDeliveryBridge } from "./patch-drag-delivery.mjs";
import { tagPointerCommand, pointerCommandGuard } from "../apps/chrome-extension/browser-pointer-guard.js";
import { NativeInputTracker } from "../apps/chrome-extension/browser-input-adapter.js";
import { MEDIA_CANCEL_FUNCTION } from "../apps/chrome-extension/browser-media-source.js";
import { mediaTaskBridge } from "./patch-media-source.mjs";

const require = createRequire(new URL("../apps/chrome-extension/package.json", import.meta.url));
const directory = path.dirname(require.resolve("playwright-crx/package.json"));
const entry = await fs.readFile(path.join(directory, "lib/index.mjs"), "utf8");
const upstream = await fs.readFile(path.join(directory, "lib", /from ["']\.\/([^"']+\.mjs)/.exec(entry)[1]), "utf8");
const previous = patchCrxPointerDelivery(patchCrxFrameGeometry(upstream));
const patched = patchCrxDragDelivery(previous);
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const flush = () => new Promise((resolve) => setImmediate(resolve));
const plain = (value) => JSON.parse(JSON.stringify(value));
function slice(source, start, end) {
  const from = source.indexOf(start), to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, start); return source.slice(from, to);
}

// Execute the pinned Frame action, ElementHandle retry/action/interceptor,
// Mouse, RawMouse and DragManager. Native delivery and DOM are controlled seams.
function fixture({ source = patched, bridge = dragDeliveryBridge, guardFactory = createDragCommitGuard, html = true, onNative, onNativeAck, onGuard, onGuardAck, onRuntime, dropMoves = 0, noHooks = false, cleanupError, tracked = false, nativeLease = false } = {}) {
  const calls = [], resolutions = [], cleanups = [], guardObjects = [], events = [], windowListeners = new Map(), pendingAbort = [];
  let expired = false, aborted = false, nativeMoves = 0, attached = true, currentNode, generation = 0, targetCover = false;
  const document = { elementFromPoint: () => targetCover ? {} : currentNode };
  const view = { addEventListener(type, listener) { let set = windowListeners.get(type); if (!set) windowListeners.set(type, set = new Set()); set.add(listener); },
    removeEventListener(type, listener) { windowListeners.get(type)?.delete(listener); },
    getComputedStyle: node => node.style };
  document.defaultView = view;
  const makeNode = (name, x) => ({ name, ownerDocument: document, isConnected: true, parentElement: null,
    style: { transform: "none", transformOrigin: "0px 0px", zoom: "1" },
    getRootNode: () => document, contains(other) { return this === other; },
    getClientRects() { return [{ x: this.x, y: 40, width: 20, height: 20 }]; }, x });
  const sourceNode = makeNode("source", 30), targetNode = makeNode("target", 130); currentNode = sourceNode;
  const transport = { _tabToTarget: new Map([[7, {}]]), _sessions: new Map() };
  const tracker = tracked ? new NativeInputTracker() : undefined, attachment = {};
  tracker?.register(7, attachment);
  class CRExecutionContext {}
  class JSHandle { constructor(context, id) { this._context = context; this._objectId = id; } }
  class NonRecoverableDOMError extends Error {}
  const progress = { metadata: {}, log() {}, isRunning: () => !aborted, timeUntilDeadline: () => expired ? 0 : 10000,
    throwIfAborted() { if (aborted) throw new Error("original action aborted"); }, cleanupWhenAborted(fn) { pendingAbort.push(fn); } };
  const context = { delegate: new CRExecutionContext(), world: "utility", _contextDestroyedScope: { isClosed: () => !attached } };
  const injected = { document, window: view, onGlobalListenersRemoved: new Set(), retarget: node => node,
    expectHitTarget(point, node) { return node.isConnected && (!targetCover || node !== targetNode) && point.x === node.x ? "done" : { hitTargetDescription: "covered original node" }; },
    checkElementStates(node) { return node.isConnected ? undefined : "error:notconnected"; },
    _hoverHitTargetInterceptorEvents: new Set(["mousemove"]), _tapHitTargetInterceptorEvents: new Set(["pointerdown", "pointerup"]),
    _mouseHitTargetInterceptorEvents: new Set(["mousedown", "mouseup", "pointerdown", "pointerup", "click"]) };
  const injectedSource = vm.runInNewContext(/^const source\$4 = (.*);$/m.exec(source)[1]);
  const env = { assert, Error, Promise, Set, Map, Symbol, Number, createPointerMoveReceipt, createDragCommitGuard: guardFactory, CRExecutionContext, NonRecoverableDOMError,
    JSHandle$1: JSHandle, createHandle$3(context, remote) { const handle = new JSHandle(context, remote.objectId); guardObjects.push(handle); return handle; },
    JavaScriptErrorInEvaluate: Error, getExceptionMessage: value => value.text,
    setTimeout, clearTimeout, roundPoint: value => value, process: { platform: "win32" }, isString: value => typeof value === "string",
    isJavaScriptErrorInEvaluate: () => false, isSessionClosedError: () => false, isInvalidSelectorError: () => false,
    isNonRecoverableDOMError: error => error instanceof NonRecoverableDOMError, assertDone(value) { assert.equal(value, "done"); return value; },
    tagPointerCommand, throwRetargetableDOMError: value => value,
    openBrowserUseInputHooks: noHooks ? undefined : { beginPointerAction(target, check) {
      assert.equal(target.tabId, 7); let closed = false;
      if (tracker) return tracker.beginPointerAction(7, attachment, check);
      return { check() { check(); if (closed) throw new Error("ticket closed"); }, close() { closed = true; events.push("close-ticket"); },
        deferCleanup(callback) { const cleanup = async () => { if (cleanupError) throw cleanupError; if (!cleanups.includes(cleanup)) return true; assert.equal(await callback(() => {}), true); cleanups.splice(cleanups.indexOf(cleanup), 1); return true; }; cleanups.push(cleanup); return cleanup; } };
    }, prepareMediaCleanup(target, contextId) {
      assert.equal(target.tabId, 7); assert.equal(contextId, 41);
      return { close() { events.push("close-lease"); }, async cancel(objectId) {
        const result = await transport._send(target, "Runtime.callFunctionOn", { objectId, functionDeclaration: MEDIA_CANCEL_FUNCTION });
        assert.equal(result.result.value, true);
      }, release: objectId => transport._send(target, "Runtime.releaseObject", { objectId }) };
    } },
    createOpenBrowserUseMediaOperations() {
      let observe;
      return { setHandleObserver(fn) { observe = fn; }, async evaluateHandle(handle, factory, arg) {
        if (onGuard) await onGuard();
        const value = factory(handle.node, arg), remote = { _context: context, _objectId: "guard-" + guardObjects.length, value };
        guardObjects.push(remote); observe(remote); return remote;
      }, async evaluate(handle, fn) { return fn(handle.value); }, async cancel(handle) { events.push("cancel-guard"); assert.equal(handle.value.cancel(), true); },
      async dispose(handle) { events.push("release-guard"); handle._disposed = true; } };
    },
    obuFrameGeometry: { async drag(handle, point, actualProgress, position, install) {
      assert.equal(actualProgress, progress); progress.throwIfAborted();
      if (!handle.node.isConnected) return "error:notconnected";
      const hit = injected.expectHitTarget(point, handle.node); if (hit !== "done") return hit;
      if (install) await install(handle, point);
      return { framePoint: { ...point }, frameGeometry: ["frame", handle.node.name, handle.node.x, generation, position ?? null] };
    } },
    ProgressController: class { async run(task) { return task(progress); } }
  };
  const runtime = vm.runInNewContext("class Injected {" + slice(injectedSource, "  setupHitTargetInterceptor(", "  dispatchEvent(") +
    slice(injectedSource, "  _setupHitTargetInterceptors() {", "  async expect(") +
    "registerEvents() {" + /^    this\._allHitTargetInterceptorEvents = .*;$/m.exec(injectedSource)[0] + "}}\n" +
    "class Handle extends JSHandle$1 {" + slice(source, "  async _retryAction(", "  async _markAsTargetElement(") + "}\n" +
    "class Frame {" + slice(source, "  async dragAndDrop(metadata, source2, target, options2)", "  async tap(metadata, selector, options2)") + "}\n" +
    slice(source, "const keypadLocation$1 = 3;", "let Touchscreen$1 = class Touchscreen {") +
    slice(source, "function toModifiersMask$2(", "class CRExecutionContext {") +
    slice(source, "let RawMouseImpl$3 = class RawMouseImpl {", "let RawTouchscreenImpl$3 =") +
    pointerDeliveryBridge + (nativeLease ? mediaTaskBridge.replace("export async function", "async function") : "") + (source !== previous ? bridge : "") +
    "\n({ Injected, Handle, Frame, Mouse: Mouse$1, RawMouse: RawMouseImpl$3, DragManager });", env);
  injected.setupHitTargetInterceptor = runtime.Injected.prototype.setupHitTargetInterceptor;
  runtime.Injected.prototype.registerEvents.call(injected); runtime.Injected.prototype._setupHitTargetInterceptors.call(injected);
  const emit = (type, node = currentNode, extra = {}) => {
    let blocked = false;
    const event = { type, isTrusted: true, isPrimary: true, pointerType: "mouse", buttons: type.includes("down") ? 1 : 0,
      clientX: node.x, clientY: 40, composedPath: () => [node], preventDefault() { blocked = true; }, stopPropagation() {}, stopImmediatePropagation() { blocked = true; }, ...extra };
    for (const listener of [...(windowListeners.get(type) ?? [])]) listener(event);
    return blocked;
  };
  const client = new EventEmitter();
  Object.assign(client, { _sessionId: "crx-tab-7", _connection: { _transport: transport }, async send(method, params) {
    const ticket = pointerCommandGuard(params); ticket?.check();
    const operation = async () => {
    calls.push({ method, params: { ...params }, ticket });
    if (onNative) await onNative({ method, params, ticket, f });
    ticket?.check();
    if (params.type === "mouseMoved") {
      nativeMoves++; currentNode = params.x === sourceNode.x ? sourceNode : targetNode;
      if (nativeMoves > dropMoves) { emit("pointermove", currentNode, { buttons: params.buttons }); emit("mousemove", currentNode, { buttons: params.buttons }); }
      if (params.buttons && html) client.emit("Input.dragIntercepted", { data: { items: [], dragOperationsMask: 1 } });
    }
    if (params.type === "mousePressed") { emit("pointerdown", sourceNode); emit("mousedown", sourceNode); }
    if (params.type === "drop") { currentNode = targetNode; events.push(emit("drop", targetNode) ? "blocked-drop" : "business-drop"); }
    if (params.type === "mouseReleased") { events.push("capture-up"); emit("pointerup", sourceNode); emit("mouseup", sourceNode); }
    if (onNativeAck) await onNativeAck({ method, params, ticket, f });
    events.push("ack:" + (params.type ?? method)); return {};
    };
    return tracker ? tracker.send({ tabId: 7 }, attachment, method, params, operation, ticket) : operation();
  } });
  context.delegate._client = client;
  context.delegate._contextId = 41;
  const page = { keyboard: { _modifiers: () => new Set() }, performActionPreChecks: async () => {},
    frameManager: { frame: id => id === "root" ? frame : null, waitForSignalsCreatedBy: async (_p, _w, fn) => fn() },
    delegate: { _sessionForFrame: () => session }, safeNonStallingEvaluateInAllFrames: async () => {}, frames: () => [frame] };
  const session = { _client: client }, frame = Object.assign(new runtime.Frame(), { _id: "root", _page: page,
    _contextData: new Map([["utility", { context }]]), parentFrame: () => null, pendingDocument: () => frame.pending,
    nonStallingEvaluateInExistingContext: async () => html, raceAgainstEvaluationStallingEvents: fn => fn() });
  context.frame = frame;
  const drag = new runtime.DragManager({ _page: page, _mainFrameSession: session });
  page.mouse = new runtime.Mouse(new runtime.RawMouse(page, client, drag), page);
  const makeHandle = node => Object.assign(new runtime.Handle(), { node, _page: page, _frame: frame, _context: context, _objectId: node.name,
    instrumentation: { onBeforeInputAction: async () => {} }, _scrollRectIntoViewIfNeeded: async () => "done",
    _clickablePoint: async () => ({ x: node.x, y: 40 }), _offsetPoint: async () => ({ x: node.x, y: 40 }),
    _checkFrameIsHitTarget: async point => ({ framePoint: point, frameGeometry: ["frame"] }),
    async evaluateInUtility(fn, arg) { if (typeof arg === "number") return; return fn([injected, node, arg]); },
    async evaluateHandleInUtility(fn, arg) { const value = fn([injected, node, arg]); return { _objectId: "receipt", _context: context,
      rawValue: () => typeof value === "string" ? value : JSON.stringify(value), evaluate: async (fn, arg) => fn(value, arg), dispose() {} }; }
  });
  const sourceHandle = makeHandle(sourceNode), targetHandle = makeHandle(targetNode);
  const remotes = new Map([["source", sourceNode], ["target", targetNode]]);
  let remoteSerial = 0;
  transport._send = async (_target, method, params) => {
    const custom = await onRuntime?.({ method, params, f });
    if (custom) return custom;
    if (method === "Runtime.releaseObject") { events.push("release-guard"); remotes.delete(params.objectId); return {}; }
    assert.equal(method, "Runtime.callFunctionOn");
    if (params.functionDeclaration === MEDIA_CANCEL_FUNCTION) events.push("cancel-guard");
    const factory = params.functionDeclaration.includes("function createDragCommitGuard(");
    if (factory && onGuard) await onGuard();
    const value = await vm.runInNewContext("(" + params.functionDeclaration + ")", { Symbol }).call(remotes.get(params.objectId), params.arguments?.[0].value);
    if (params.returnByValue || params.functionDeclaration === MEDIA_CANCEL_FUNCTION) return { result: { value } };
    const objectId = "native-guard-" + ++remoteSerial; remotes.set(objectId, value);
    if (onGuardAck) await onGuardAck();
    return { result: { objectId, type: "object" } };
  };
  frame._retryWithProgressIfNotConnected = async (_p, selector, _strict, _pre, task) => {
    resolutions.push(selector); return task(selector === "source" ? sourceHandle : targetHandle);
  };
  const f = { sourceNode, targetNode, sourceHandle, targetHandle, page, frame, context, client, progress, calls, events, cleanups, guardObjects, resolutions, emit, windowListeners, drag, tracker, attachment,
    run: (options = {}) => frame.dragAndDrop({}, "source", "target", options),
    expire() { expired = true; }, abort() { aborted = true; for (const fn of pendingAbort) fn(); }, detach() { attached = false; },
    replaceTarget() { targetNode.isConnected = false; }, coverTarget() { targetCover = true; }, changeGeometry() { generation++; },
    async release(timeout = 500) {
      if (tracker) await tracker.release(7, attachment, async (_target, method, params) => { events.push("cleanup-ack:" + (params.type ?? method)); }, timeout);
      else for (const fn of [...cleanups]) await fn();
    } };
  return f;
}

test("drag patch pins complete Frame and DragManager shapes and private native plumbing", () => {
  assert.throws(() => patchCrxDragDelivery(patched), /shape changed/);
  for (const anchor of ["let onDragIntercepted;", 'await this._page.mouse.down();', "!!options2.forClick, options2[obuPointerTicket]);", "await this._dragManager.drop(x, y, modifiers);"])
    assert.throws(() => patchCrxDragDelivery(previous.replace(anchor, anchor.slice(0, -1) + " /* changed */ " + anchor.at(-1))), /shape changed|changed/);
});

test("actual guarded Frame resolves both originals before any input and tags the full HTML drag sequence", async () => {
  const f = fixture({ onNative({ f }) { assert.deepEqual(f.resolutions, ["source", "target"]); } });
  assert.equal(await f.run(), undefined);
  assert.deepEqual(f.calls.map(c => c.params.type ?? c.method), ["mouseMoved", "mousePressed", "Input.setInterceptDrags", "mouseMoved", "Input.setInterceptDrags", "dragEnter", "dragOver", "drop"]);
  assert.ok(f.calls.every(c => c.ticket === f.calls[0].ticket));
  assert.deepEqual(f.events.filter(e => /drop|guard/.test(e)), ["business-drop", "ack:drop", "cancel-guard", "release-guard"]);
  assert.equal(f.cleanups.length, 0);
});

test("source hover geometry changes reprepare the original handle before exactly one press", async () => {
  let shifted = false;
  const f = fixture({ onNative({ params, f }) { if (params.type === "mouseMoved" && !shifted) { shifted = true; f.sourceNode.x += 20; } } });
  assert.equal(await f.run(), undefined);
  assert.equal(f.calls.filter(c => c.params.type === "mousePressed").length, 1);
  assert.deepEqual(f.calls.filter(c => c.params.type === "mouseMoved" && !c.params.buttons).map(c => c.params.x), [30, 50]);
  assert.deepEqual(f.resolutions, ["source", "target"]);
});

test("old down-then-resolve accepts a replacement while the guarded path never submits it a drop", async () => {
  const old = fixture({ source: previous, onNative({ params, f }) { if (params.type === "mousePressed") f.resolutions.push("replacement-created"); } });
  await old.run(); assert.deepEqual(old.resolutions, ["source", "replacement-created", "target"]);
  assert.ok(old.calls.some(c => c.params.type === "drop"));
  const f = fixture({ onNative({ params, f }) { if (params.type === "mousePressed") f.replaceTarget(); } });
  await assert.rejects(f.run(), /original drag destination was lost/);
  assert.equal(f.calls.filter(c => c.params.type === "mousePressed").length, 1);
  assert.equal(f.calls.some(c => c.params.type === "drop" || c.params.type === "mouseReleased"), false);
  assert.deepEqual(f.resolutions, ["source", "target"]); await f.release();
});

test("dragenter and dragover mutations are terminal after the first press", async () => {
  for (const event of ["dragEnter", "dragOver"]) {
    const f = fixture({ onNative({ params, f }) { if (params.type === event) f.coverTarget(); } });
    await assert.rejects(f.run(), /original drag destination changed/);
    assert.equal(f.calls.filter(c => c.params.type === "mousePressed").length, 1);
    assert.equal(f.calls.some(c => c.params.type === "drop" || c.params.type === "mouseReleased"), false);
    assert.equal(f.events.includes("cancel-guard"), false, "committed failure keeps the guard for native release");
    await f.release(); assert.equal(f.events.at(-2), "cancel-guard");
  }
});

test("native drop's internal dragover replacement is blocked in the original utility document", async () => {
  const f = fixture({ onNative({ params, f }) { if (params.type === "drop") f.replaceTarget(); } });
  await assert.rejects(f.run(), /native drop was blocked/);
  assert.ok(f.events.includes("blocked-drop")); assert.equal(f.events.includes("business-drop"), false);
  assert.equal(f.events.includes("cancel-guard"), false); await f.release();
});

test("pointer capture drag remains a normal move/up without requiring a destination move receipt", async () => {
  const f = fixture({ html: false });
  assert.equal(await f.run(), undefined);
  assert.ok(f.events.includes("capture-up")); assert.equal(f.calls.some(c => c.params.type === "drop"), false);
});

test("tagged interception rejection cannot fall back to an unguarded move", async () => {
  const failure = new Error("native interception failed");
  const f = fixture({ onNative({ method }) { if (method === "Input.setInterceptDrags") throw failure; } });
  await assert.rejects(f.run(), /native interception failed/);
  assert.equal(f.calls.filter(c => c.params.type === "mouseMoved").length, 1);
  assert.equal(f.client.listenerCount("Input.dragIntercepted"), 0); await f.release();
});

test("revocation while a native drag command is admitted prevents the late send and any drop", async () => {
  for (const mutate of [f => f.expire(), f => f.detach(), f => { f.frame.pending = {}; }]) {
    const held = deferred(), entered = deferred();
    const f = fixture({ async onNative({ params }) { if (params.type === "dragOver") { entered.resolve(); await held.promise; } } });
    const action = f.run(); await entered.promise; mutate(f); held.resolve();
    await assert.rejects(action, /deadline|changed/);
    assert.equal(f.calls.some(c => c.params.type === "drop"), false); assert.equal(f.events.includes("ack:dragOver"), false); await f.release();
  }
});

test("a late guard allocation remains owned by cleanup registered before the first input", async () => {
  const held = deferred(), entered = deferred();
  const f = fixture({ onGuard() { entered.resolve(); return held.promise; } });
  const action = f.run(); await entered.promise;
  assert.equal(f.cleanups.length, 1); f.abort();
  const cleanup = f.release(); await flush(); assert.equal(f.guardObjects.length, 0);
  held.resolve(); await assert.rejects(action, /aborted/); await cleanup;
  assert.equal(f.guardObjects.length, 1); assert.equal(f.guardObjects[0]._disposed, true);
  assert.equal(f.windowListeners.get("drop").size, 0);
  assert.equal(f.calls.some(c => c.params.type === "drop"), false);
});

test("force, trial, held modifiers and held mouse input retain the inherited branch", async () => {
  for (const mode of ["force", "trial", "modifier", "button", "standalone"]) {
    const f = fixture({ noHooks: mode === "standalone" });
    if (mode === "modifier") f.page.keyboard._modifiers = () => new Set(["Shift"]);
    if (mode === "button") f.page.mouse._buttons.add("left");
    await f.run(mode === "force" || mode === "trial" ? { [mode]: true } : {});
    assert.equal(f.calls.some(c => c.ticket), false); assert.equal(f.guardObjects.length, 0);
  }
});

test("pre-press cleanup failure preserves the action error and always closes its ticket", async () => {
  const cleanupError = new Error("cleanup native ACK missing"), actionError = new Error("source move native failure");
  const f = fixture({ cleanupError, onNative() { throw actionError; } });
  await assert.rejects(f.run(), error => error.cause === actionError && error.cleanupError === cleanupError);
  assert.equal(f.events.at(-1), "close-ticket");
  assert.equal(f.calls.some(c => c.params.type === "mousePressed"), false);
});

test("an admitted same-document successor explicitly retires an orphan guard without expiry", () => {
  const f = fixture();
  const first = createDragCommitGuard(f.sourceNode, { point: { x: 30, y: 40 } });
  assert.equal(f.windowListeners.get("drop").size, 1);
  const second = createDragCommitGuard(f.sourceNode, { point: { x: 30, y: 40 } });
  assert.equal(first.read().current, false); assert.equal(second.read().current, true);
  assert.equal(f.windowListeners.get("drop").size, 1);
  first.cancel(); assert.equal(f.windowListeners.get("drop").size, 1, "late cleanup cannot remove successor");
  second.cancel(); assert.equal(f.windowListeners.get("drop").size, 0);
});

test("actual tracker and fixed native media lease finish only after original drop, cancel and object-release ACKs", async () => {
  const f = fixture({ tracked: true, nativeLease: true });
  assert.equal(await f.run(), undefined);
  assert.ok(f.events.indexOf("ack:drop") < f.events.indexOf("cancel-guard"));
  assert.ok(f.events.indexOf("cancel-guard") < f.events.indexOf("release-guard"));
  assert.equal(f.guardObjects[0]._disposed, true);
  assert.equal(f.windowListeners.get("drop").size, 0);
  f.tracker.forget(7, f.attachment);
  assert.deepEqual(f.tracker.controlSnapshot(), { tabIds: [], pending: [] });
});

test("actual tracker committed-error cleanup cancels HTML drag and releases raw input before the original guard lease", async () => {
  const f = fixture({ tracked: true, nativeLease: true, onNative({ params, f }) { if (params.type === "dragEnter") f.coverTarget(); } });
  await assert.rejects(f.run(), /destination changed/);
  assert.equal(f.windowListeners.get("drop").size, 1);
  assert.throws(() => f.tracker.register(7, {}), /UNCONFIRMED/);
  await f.release();
  const cancel = f.events.indexOf("cleanup-ack:dragCancel"), up = f.events.indexOf("cleanup-ack:mouseReleased");
  assert.ok(cancel >= 0 && up > cancel && f.events.indexOf("cancel-guard") > up);
  assert.equal(f.calls.some(call => call.params.type === "drop"), false);
  assert.equal(f.windowListeners.get("drop").size, 0);
  f.tracker.forget(7, f.attachment);
  assert.deepEqual(f.tracker.controlSnapshot(), { tabIds: [], pending: [] });
});

test("actual media allocation that already installed a listener remains retained through a late native object ACK", async () => {
  const held = deferred(), entered = deferred();
  const f = fixture({ tracked: true, nativeLease: true, onGuardAck() { entered.resolve(); return held.promise; } });
  const action = f.run(); const rejected = assert.rejects(action, /aborted|INVALIDATED/);
  await entered.promise; assert.equal(f.windowListeners.get("drop").size, 1);
  f.abort(); const cleanup = f.release(); await flush();
  assert.equal(f.guardObjects.length, 0); assert.equal(f.windowListeners.get("drop").size, 1);
  assert.throws(() => f.tracker.forget(7, f.attachment), /UNCONFIRMED/);
  held.resolve(); await rejected; await cleanup;
  assert.equal(f.guardObjects[0]._disposed, true); assert.equal(f.windowListeners.get("drop").size, 0);
  assert.equal(f.calls.some(call => call.params.type === "drop"), false);
});

test("release waits for actual drop ACK before removing a guard even after public action revocation", async () => {
  const held = deferred(), entered = deferred();
  const f = fixture({ tracked: true, nativeLease: true, onNativeAck({ params }) { if (params.type === "drop") { entered.resolve(); return held.promise; } } });
  // This fixture controls the underlying task, not the public controller race.
  // Revocation must retain the guard through the real native ACK either way.
  const action = f.run().then(value => ({ value }), error => ({ error }));
  await entered.promise; f.abort(); const cleanup = f.release(); await flush();
  assert.ok(f.events.includes("business-drop")); assert.equal(f.events.includes("cancel-guard"), false);
  assert.equal(f.windowListeners.get("drop").size, 1);
  held.resolve(); await action; await cleanup;
  assert.ok(f.events.indexOf("ack:drop") < f.events.indexOf("cancel-guard"));
  assert.equal(f.windowListeners.get("drop").size, 0);
});

test("actual Frame dispatcher and wire result validator retain dragAndDrop's void contract", async () => {
  const wire = vm.runInNewContext("const scheme = {};\n" +
    slice(upstream, "const tOptional =", "const tArray =") + slice(upstream, "const tObject =", "const tEnum =") +
    /^scheme\.FrameDragAndDropResult = .*;$/m.exec(upstream)[0] +
    "\nclass Dispatcher {" + slice(upstream, "  async dragAndDrop(params, metadata) {", "  async tap(params, metadata) {") + "}\n" +
    "({ Dispatcher, validate: scheme.FrameDragAndDropResult });", { ValidationError: Error });
  const invoke = async f => {
    const dispatcher = Object.assign(new wire.Dispatcher(), { _frame: f.frame });
    const result = await dispatcher.dragAndDrop({ source: "source", target: "target" }, {});
    return wire.validate(result, "", { isUnderTest: () => false });
  };
  // The rejected first candidate returned its internal sentinel through the
  // unchanged dispatcher. Recreate precisely that single return regression.
  const wrongReturn = patched.replace("      await controller.run(progress =>", "      return controller.run(progress =>");
  const old = fixture({ source: wrongReturn });
  await assert.rejects(invoke(old), /expected object, got string/);
  assert.ok(old.events.includes("business-drop"), "schema rejection occurs after the native side effect");
  const f = fixture(); assert.equal(await invoke(f), undefined);
  assert.equal(f.calls.filter(call => call.params.type === "drop").length, 1);
});

test("cleanup retry reuses an acknowledged cancel after its first cleanup budget expires", async () => {
  for (const acknowledged of [false, true]) {
    const held = deferred(), entered = deferred(); let cancellations = 0;
    const bridge = acknowledged ? dragDeliveryBridge : dragDeliveryBridge.replace("cancelled.add(guard);", "");
    const f = fixture({ tracked: true, nativeLease: true, bridge,
      onNative({ params, f }) { if (params.type === "dragEnter") f.coverTarget(); },
      async onRuntime({ params }) {
        if (params.functionDeclaration === MEDIA_CANCEL_FUNCTION && ++cancellations === 1) { entered.resolve(); await held.promise; }
      }
    });
    await assert.rejects(f.run(), /destination changed/);
    const cleanup = assert.rejects(f.release(15), /timed out/); await entered.promise; await cleanup;
    held.resolve(); await Promise.allSettled(f.tracker.controlSnapshot().pending);
    assert.equal(f.events.includes("release-guard"), false, "late cancel ACK cannot send a later release outside its budget");
    await f.release();
    assert.equal(cancellations, acknowledged ? 1 : 2);
    assert.equal(f.guardObjects[0]._disposed, true);
  }
});

test("cleanup retains late exception RemoteObjects from both pre-drop and post-drop native guard reads", async () => {
  for (const stopAt of [1, 2]) {
    const held = deferred(), entered = deferred(); let reads = 0;
    const f = fixture({ tracked: true, nativeLease: true, async onRuntime({ params }) {
      if (params.returnByValue && params.functionDeclaration.includes("value.read()") && ++reads === stopAt) {
        entered.resolve(); await held.promise;
        return { result: { objectId: "late-read-error", type: "object" }, exceptionDetails: {
          text: "late guard read failed", exception: { objectId: "late-read-error", type: "object" }
        } };
      }
    } });
    const action = assert.rejects(f.run(), /late guard read failed/); await entered.promise;
    f.abort(); const cleanup = f.release(); await flush();
    assert.equal(f.events.includes("cancel-guard"), false);
    assert.throws(() => f.tracker.forget(7, f.attachment), /UNCONFIRMED/);
    held.resolve(); await action; await cleanup;
    assert.equal(f.guardObjects.length, 2);
    assert.equal(f.guardObjects.every(handle => handle._disposed), true);
    assert.equal(f.events.filter(event => event === "release-guard").length, 2);
    assert.equal(f.calls.filter(call => call.params.type === "drop").length, stopAt - 1);
  }
});

const oldAABBGuard = vm.runInNewContext("(" + createDragCommitGuard.toString().replace(/const geometry = \(\) => \(\{[\s\S]*?\n  \}\);/,
  `const geometry = () => chain.map(element => {
    const style = view.getComputedStyle(element);
    return [Array.from(element.getClientRects(), r => [r.x, r.y, r.width, r.height]), style.transform, style.transformOrigin, style.zoom];
  });`) + ")", { Symbol });

test("same-AABB individual rotation and border origin changes cannot authorize the old explicit hotspot", () => {
  for (const mode of ["rotate", "border"]) for (const legacy of [true, false]) {
    const f = fixture(), node = f.sourceNode, position = { x: 40, y: 30 };
    node.getClientRects = () => [{ x: 0, y: 0, width: 200, height: 100 }];
    Object.assign(node.style, { width: "200px", height: "100px", boxSizing: "border-box", borderLeftWidth: "0px", borderTopWidth: "0px", rotate: "none" });
    const before = JSON.stringify(node.getClientRects());
    const guard = (legacy ? oldAABBGuard : createDragCommitGuard)(node, { point: position });
    let correctRoot, deliveredLocal;
    if (mode === "rotate") {
      node.style.rotate = "180deg";
      correctRoot = { x: 200 - position.x, y: 100 - position.y };
      deliveredLocal = { ...correctRoot };
    } else {
      node.style.borderLeftWidth = "20px"; node.style.borderTopWidth = "20px";
      correctRoot = { x: position.x + 20, y: position.y + 20 };
      deliveredLocal = { x: position.x - 20, y: position.y - 20 };
    }
    assert.equal(JSON.stringify(node.getClientRects()), before); assert.equal(node.style.transform, "none");
    assert.notDeepEqual(correctRoot, position); assert.notDeepEqual(deliveredLocal, position);
    assert.equal(f.emit("drop", node, { clientX: position.x, clientY: position.y }), !legacy);
    assert.equal(guard.read().status, legacy ? "accepted" : "blocked"); guard.cancel();
  }
});

test("local ancestor plane inputs, element scrolling and visual viewport changes invalidate a retained drop guard", () => {
  const mutations = [
    (node, view, parent) => { parent.style.rotate = "0 1 0 180deg"; },
    (node, view, parent) => { parent.style.scale = "-1 1"; },
    (node, view, parent) => { parent.style.translate = "1px 2px"; },
    node => { node.style.transformBox = "content-box"; },
    (node, view, parent) => { parent.style.perspectiveOrigin = "10px 20px"; },
    node => { node.style.offsetDistance = "25%"; },
    node => { node.style.paddingLeft = "2.25px"; },
    node => { node.clientLeft = 17; },
    (node, view, parent) => { parent.scrollTop = 7; },
    (node, view) => { view.scrollX = 8.5; },
    (node, view) => { view.visualViewport.offsetLeft = 0.25; }
  ];
  for (const mutate of mutations) {
    const f = fixture(), node = f.sourceNode, view = node.ownerDocument.defaultView;
    const parent = { ...node, parentElement: null, style: { ...node.style }, scrollTop: 0 };
    node.parentElement = parent; node.clientLeft = 0; view.scrollX = 0; view.visualViewport = { offsetLeft: 0, offsetTop: 0, scale: 1, width: 1000, height: 800 };
    const guard = createDragCommitGuard(node, { point: { x: 30, y: 40 } });
    mutate(node, view, parent);
    assert.equal(guard.read().current, false); assert.equal(f.emit("drop", node), true); guard.cancel();
  }
});

test("paint-only target and ancestor appearance changes preserve a valid drop", () => {
  const f = fixture(), node = f.sourceNode;
  const parent = { ...node, parentElement: null, style: { ...node.style } }; node.parentElement = parent;
  const guard = createDragCommitGuard(node, { point: { x: 30, y: 40 } });
  node.style.backgroundColor = "rgb(0, 128, 0)"; node.style.color = "rgb(255, 255, 255)";
  parent.style.borderColor = "rgb(255, 0, 0)"; parent.style.boxShadow = "0px 0px 10px black";
  assert.equal(guard.read().current, true); assert.equal(f.emit("drop", node), false);
  assert.equal(guard.read().status, "accepted"); guard.cancel();
});

test("the actual native drop path blocks same-node plane changes inside its final dragover", async () => {
  for (const mutation of [node => { node.style.rotate = "180deg"; }, node => { node.style.borderLeftWidth = "24px"; node.style.borderTopWidth = "24px"; }]) {
    for (const legacy of [true, false]) {
      const f = fixture({ tracked: true, nativeLease: true, guardFactory: legacy ? oldAABBGuard : createDragCommitGuard,
        onNative({ params, f }) { if (params.type === "drop") mutation(f.targetNode); }
      });
      if (legacy) { await f.run(); assert.ok(f.events.includes("business-drop")); }
      else {
        await assert.rejects(f.run(), /native drop was blocked/); assert.equal(f.events.includes("business-drop"), false);
        assert.ok(f.events.includes("blocked-drop")); await f.release();
      }
      assert.equal(f.calls.filter(call => call.params.type === "drop").length, 1);
      assert.equal(f.calls.filter(call => call.params.type === "mousePressed").length, 1);
    }
  }
});
