import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";
import { captureImageBinding, verifyImageBinding, readMediaSource, validateMediaDownload } from "./browser-media-source.js";

const params = { session_id: "s", turn_id: "t", control_epoch: 1, tabId: 7, locator: [{ kind: "css", selector: "img" }] };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const flush = () => new Promise(resolve => setImmediate(resolve));

test("media parameters reuse finite native locator/download schemas and freeze caller input", () => {
  const input = structuredClone(params), result = validateMediaDownload(input);
  input.locator[0].selector = "changed";
  assert.equal(result.locator[0].selector, "img");
  assert.equal(result.timeoutMs, 10000);
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.locator) && Object.isFrozen(result.locator[0]));
  for (const extra of [{ url: "https://wrong.test" }, { unknown: true }, { filename: "../bad" }, { timeoutMs: 0 }, { control_epoch: 0 }, { locator: [] }, { locator: [{ kind: "frame", selector: "iframe" }] }, { locator: [{ kind: "css", selector: "img", unknown: true }] }])
    assert.throws(() => validateMediaDownload({ ...params, ...extra }));
});

function renderer() {
  const document = {}, states = new WeakMap();
  class Node {}
  class HTMLImageElement extends Node {}
  Object.defineProperties(Node.prototype, {
    isConnected: { get() { return states.get(this)?.connected; } },
    ownerDocument: { get() { return states.get(this)?.document; } }
  });
  Object.defineProperty(HTMLImageElement.prototype, "currentSrc", { get() {
    if (!(this instanceof HTMLImageElement)) throw new TypeError("Illegal invocation");
    return states.get(this).url;
  } });
  const context = vm.createContext({ Node, HTMLImageElement, document });
  const capture = vm.runInContext(`(${captureImageBinding.toString()})`, context);
  const verify = vm.runInContext(`(${verifyImageBinding.toString()})`, context);
  const image = new HTMLImageElement();
  states.set(image, { connected: true, document, url: "https://images.test/selected.png" });
  let selected = image, queryCount = 0;
  const injected = { querySelector(parsed, scope, strict) {
    assert.equal(parsed, "native parsed selector"); assert.equal(scope, document); assert.equal(strict, true);
    queryCount++; return selected;
  } };
  return { capture: () => capture(injected, { info: { parsed: "native parsed selector" } }), verify, image, states, context,
    select: value => { selected = value; }, queryCount: () => queryCount, Node };
}

test("utility getter binds exact image and ignores page-owned currentSrc/isConnected getters", () => {
  const r = renderer(); let pageGetter = 0;
  Object.defineProperties(r.image, {
    currentSrc: { get() { pageGetter++; throw new Error("page getter"); } },
    isConnected: { get() { pageGetter++; return false; } }
  });
  const binding = r.capture();
  assert.equal(binding.element, r.image); assert.equal(binding.url, "https://images.test/selected.png");
  assert.equal(r.verify(binding).url, binding.url); assert.equal(pageGetter, 0); assert.equal(r.queryCount(), 1);
  r.states.get(r.image).url = "https://images.test/replaced.png";
  assert.throws(() => r.verify(binding), /OBU_MEDIA_SOURCE_CHANGED/);
});

test("exact-node verification rejects wrong tags, detachment, adoption, empty currentSrc and changed document", () => {
  for (const change of ["detach", "adopt", "document"]) {
    const r = renderer(), binding = r.capture();
    if (change === "detach") r.states.get(r.image).connected = false;
    if (change === "adopt") r.states.get(r.image).document = {};
    if (change === "document") r.context.document = {};
    assert.throws(() => r.verify(binding), /OBU_MEDIA_SOURCE_CHANGED/);
  }
  const r = renderer(), div = new r.Node();
  r.states.set(div, { connected: true, document: r.context.document }); r.select(div);
  assert.throws(() => r.capture(), /exact HTML img/);
  r.select(r.image); r.states.get(r.image).url = "";
  assert.throws(() => r.capture(), /no selected currentSrc/);
  r.select(undefined); assert.equal(r.capture().missing, true);
});

function adapterFixture({ missing = 0, url = "https://images.test/current.png" } = {}) {
  const r = renderer(); r.states.get(r.image).url = url;
  const context = { world: "utility" }, calls = [], handles = [];
  let rootContext = context, detached = false;
  const frame = { _utilityContext: async () => rootContext, isDetached: () => detached };
  frame._page = { mainFrame: () => frame };
  const injected = { _context: context };
  const native = {
    setHandleObserver() {},
    async evaluateHandle(handle, fn, arg) {
      assert.equal(handle, injected); assert.equal(fn, captureImageBinding);
      assert.equal(arg.info.world, "utility");
      const binding = missing-- > 0 ? { missing: true } : r.capture();
      const result = { binding }; handles.push(result); calls.push("capture"); return result;
    },
    async evaluate(handle, fn) { calls.push(fn === verifyImageBinding ? "verify" : "first"); return fn === verifyImageBinding ? r.verify(handle.binding) : fn(handle.binding); },
    async dispose(handle) { calls.push("dispose"); handle.disposed = true; }
  };
  frame.selectors = { resolveInjectedForSelector: async (selector, options) => {
    assert.equal(selector, "native-selector"); assert.equal(options.strict, true); assert.equal(typeof options.obuMedia.dispose, "function");
    calls.push("resolve"); return { frame, injected, info: { world: "utility" } };
  } };
  frame.retryWithProgressAndTimeouts = async (_progress, delays, callback) => {
    assert.deepEqual(delays, [0, 20, 50, 100, 100, 500]);
    const again = Symbol("native continuePolling");
    for (let i = 0; i < 5; i++) { const value = await callback(again); if (value !== again) return value; }
    throw new Error("unexpected retry");
  };
  const progress = { throwIfAborted() {} };
  const options = { deadlineAt: performance.now() + 10000, check: async () => {},
    runNativeTask: async (_locator, options, task) => { assert.ok(options.timeoutMs > 0); return task(frame, "native-selector", progress, native); } };
  return { r, native, calls, handles, frame, context, progress, options, read: () => readMediaSource({}, options), changeContext: () => { rootContext = { world: "utility" }; }, detach: () => { detached = true; } };
}

test("source adapter only polls absence, disposes each handle and never falls back from selected unsupported sources", async () => {
  const f = adapterFixture({ missing: 1 }); assert.deepEqual(await f.read(), { url: "https://images.test/current.png" });
  assert.deepEqual(f.calls, ["resolve", "capture", "first", "dispose", "resolve", "capture", "first", "verify", "dispose"]);
  assert.ok(f.handles.every(handle => handle.disposed));
  for (const url of ["blob:https://images.test/id", "data:image/png,abc", "file:///x", "https://u:p@images.test/x", "https://images.test/a b"]) {
    const unsupported = adapterFixture({ url });
    await assert.rejects(unsupported.read(), /OBU_MEDIA_UNSUPPORTED/);
    assert.equal(unsupported.calls.filter(call => call === "resolve").length, 1);
    assert.ok(unsupported.handles.every(handle => handle.disposed));
  }
});

test("late handle creation remains pending and is disposed after ownership invalidates", async () => {
  const f = adapterFixture(), entered = deferred(), late = deferred(), disposed = deferred(); let valid = true, settled = false;
  const original = f.native.evaluateHandle;
  f.native.evaluateHandle = async (...args) => { entered.resolve(); await late.promise; return original(...args); };
  f.native.dispose = async handle => { await disposed.promise; handle.disposed = true; };
  f.options.check = async () => { if (!valid) throw new Error("OBU_DOWNLOAD_EXPIRED"); };
  const operation = f.read(); operation.then(() => { settled = true; }, () => { settled = true; });
  await entered.promise; valid = false; await flush(); assert.equal(settled, false);
  late.resolve(); await flush(); assert.equal(settled, false, "dispose is an actual operation, not a timeout race");
  disposed.resolve(); await assert.rejects(operation, /OBU_DOWNLOAD_EXPIRED/);
  assert.ok(f.handles[0].disposed); assert.equal(f.calls.includes("verify"), false);
});

test("document replacement and final source mutation reject without resolving a successor element", async () => {
  for (const mutate of [f => f.changeContext(), f => f.detach(), f => { f.r.states.get(f.r.image).url = "https://images.test/new"; }]) {
    const f = adapterFixture(), original = f.native.evaluate;
    f.native.evaluate = async (...args) => { const result = await original(...args); if (args[1] !== verifyImageBinding) mutate(f); return result; };
    await assert.rejects(f.read(), /OBU_MEDIA_SOURCE_CHANGED/);
    assert.equal(f.calls.filter(call => call === "resolve").length, 1); assert.ok(f.handles[0].disposed);
  }
});

test("failed exact handle release retains a private retry without repeating lookup or reads", async () => {
  const f = adapterFixture(); let attempts = 0, fail = true;
  f.native.dispose = async handle => { attempts++; if (fail) throw new Error("native release failed"); handle.disposed = true; };
  const error = await f.read().catch(error => error);
  assert.equal(error.mediaCleanupFailed, true); assert.equal(attempts, 1); assert.equal(f.handles[0].disposed, undefined);
  await assert.rejects(error.retryMediaCleanup(), /OBU_MEDIA_CLEANUP_FAILED/); assert.equal(attempts, 2);
  fail = false; await error.retryMediaCleanup(); assert.equal(attempts, 3); assert.ok(f.handles[0].disposed);
  assert.equal(f.calls.filter(call => call === "capture").length, 1); assert.equal(f.calls.filter(call => call === "verify").length, 1);
});

test("wrong-world resolver and strict selector errors fail once before any media handle exists", async () => {
  for (const world of ["main", "utility"]) {
    const f = adapterFixture(); let calls = 0;
    f.frame.selectors.resolveInjectedForSelector = async () => { calls++; if (world === "utility") throw new Error("strict mode violation"); return { info: { world } }; };
    await assert.rejects(f.read(), world === "main" ? /OBU_MEDIA_UNSUPPORTED/ : /strict mode violation/);
    assert.equal(calls, 1); assert.equal(f.handles.length, 0);
  }
});
