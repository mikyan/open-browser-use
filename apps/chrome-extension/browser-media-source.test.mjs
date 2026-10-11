import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";
import { captureImageBinding, verifyImageBinding, prepareMediaBytes, readMediaChunk, readMediaSource, validateMediaDownload, MAX_MEDIA_BYTES, MEDIA_CHUNK_BYTES } from "./browser-media-source.js";

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
  class Element extends Node {}
  class HTMLImageElement extends Element {}
  class HTMLMediaElement extends Element {}
  class HTMLCanvasElement extends Element {}
  Object.defineProperties(Node.prototype, {
    isConnected: { get() { return states.get(this)?.connected; } },
    ownerDocument: { get() { return states.get(this)?.document; } }
  });
  Object.defineProperty(Element.prototype, "localName", { get() { return states.get(this).kind; } });
  for (const Type of [HTMLImageElement, HTMLMediaElement]) Object.defineProperty(Type.prototype, "currentSrc", { get() {
    if (!(this instanceof Type)) throw new TypeError("Illegal invocation");
    return states.get(this).url;
  } });
  for (const field of ["srcObject", "mediaKeys", "duration"]) Object.defineProperty(HTMLMediaElement.prototype, field, { get() { return states.get(this)[field] ?? (field === "duration" ? 1 : null); } });
  for (const field of ["width", "height"]) Object.defineProperty(HTMLCanvasElement.prototype, field, { get() {
    if (!(this instanceof HTMLCanvasElement)) throw new TypeError("Illegal invocation");
    return states.get(this)[field];
  } });
  HTMLCanvasElement.prototype.toBlob = function(callback, type) {
    const state = states.get(this); assert.equal(type, "image/png");
    if (state.tainted) throw Object.assign(new Error("tainted"), { name: "SecurityError" });
    (state.encode ?? (cb => cb(new Blob([new Uint8Array([1, 2, 3])], { type }))))(callback);
  };
  const context = vm.createContext({ Node, Element, HTMLImageElement, HTMLMediaElement, HTMLCanvasElement, document,
    URL, TextEncoder, AbortController, ReadableStream, ReadableStreamDefaultReader, Blob, Uint8Array, btoa, fetch });
  Object.defineProperty(context, "origin", { get: () => "https://images.test", configurable: true });
  const capture = vm.runInContext(`(${captureImageBinding.toString()})`, context);
  const verify = vm.runInContext(`(${verifyImageBinding.toString()})`, context);
  const prepare = vm.runInContext(`(${prepareMediaBytes.toString()})`, context);
  const chunk = vm.runInContext(`(${readMediaChunk.toString()})`, context);
  const image = new HTMLImageElement();
  states.set(image, { connected: true, document, url: "https://images.test/selected.png", kind: "img" });
  let selected = image, queryCount = 0;
  const injected = { querySelector(parsed, scope, strict) {
    assert.equal(parsed, "native parsed selector"); assert.equal(scope, document); assert.equal(strict, true);
    queryCount++; return selected;
  } };
  const element = (kind, options = {}) => {
    const value = kind === "canvas" ? new HTMLCanvasElement() : new HTMLMediaElement();
    states.set(value, { connected: true, document, kind, width: 2, height: 1, url: "https://images.test/media", ...options });
    selected = value; return value;
  };
  return { capture: () => capture(injected, { info: { parsed: "native parsed selector" } }), verify, prepare, chunk, image, states, context, element,
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
    async evaluate(handle, fn, arg) {
      calls.push(fn === verifyImageBinding ? "verify" : fn === prepareMediaBytes ? "prepare" : fn === readMediaChunk ? "chunk" : "first");
      return fn === verifyImageBinding ? r.verify(handle.binding) : fn === prepareMediaBytes ? r.prepare(handle.binding) : fn === readMediaChunk ? r.chunk(handle.binding, arg) : fn(handle.binding);
    },
    async cancel(handle) { calls.push("cancel"); if (!handle.disposed) await handle.binding.cancel(); },
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
  for (const url of ["blob:https://foreign.test/id", "file:///x", "https://u:p@images.test/x", "https://images.test/a b"]) {
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


test("native audio/video getters reject srcObject, DRM and infinite live duration without page property reads", () => {
  for (const kind of ["audio", "video"]) {
    const r = renderer(), element = r.element(kind); let pageGetters = 0;
    for (const name of ["currentSrc", "srcObject", "mediaKeys", "duration", "localName"]) Object.defineProperty(element, name, { get() { pageGetters++; throw new Error("page getter"); } });
    assert.equal(r.verify(r.capture()).url, "https://images.test/media"); assert.equal(pageGetters, 0);
    for (const [name, value] of [["srcObject", {}], ["mediaKeys", {}], ["duration", Infinity]]) {
      r.states.get(element)[name] = value;
      assert.throws(() => r.capture(), /OBU_MEDIA_UNSUPPORTED/);
      r.states.get(element)[name] = name === "duration" ? 1 : null;
    }
  }
});

test("data/blob/canvas use exact captured bytes with MIME essence and canonical bounded chunks", async () => {
  for (const kind of ["img", "audio", "video", "canvas"]) {
    const f = adapterFixture({ url: "data:image/png;base64,AQIDBA==" });
    if (kind !== "img") f.r.element(kind, { url: `blob:https://images.test/${kind}` });
    let requests = 0;
    f.r.context.fetch = async (url, options) => {
      requests++; assert.equal(options.credentials, "omit"); assert.equal(options.redirect, "error"); assert.ok(options.signal instanceof AbortSignal);
      assert.ok(url.startsWith("data:") || url.startsWith("blob:"));
      return new Response(new Uint8Array([1, 2, 3, 4]), { headers: { "Content-Type": `${kind === "img" ? "image" : kind}/test; charset=utf-8` } });
    };
    const result = await f.read();
    assert.equal(result.byteLength, kind === "canvas" ? 3 : 4);
    assert.equal(result.bytesBase64, kind === "canvas" ? "AQID" : "AQIDBA==");
    assert.equal(result.mimeType, kind === "canvas" ? "image/png" : `${kind === "img" ? "image" : kind}/test`);
    assert.equal(requests, kind === "canvas" ? 0 : 1); assert.ok(f.handles.every(h => h.disposed));
  }
});

test("HTTP selection never fetches bytes; canvas size, taint, bad MIME, empty and revoked blobs reject", async () => {
  const http = adapterFixture(); http.r.context.fetch = () => { throw new Error("unexpected fetch"); };
  assert.deepEqual(await http.read(), { url: "https://images.test/current.png" });
  for (const config of [
    f => f.r.element("canvas", { width: 0 }),
    f => f.r.element("canvas", { width: 4097, height: 4096 }),
    f => f.r.element("canvas", { tainted: true }),
    f => { f.r.context.fetch = async () => new Response("text", { headers: { "Content-Type": "text/html" } }); },
    f => { f.r.context.fetch = async () => new Response(new Uint8Array(), { headers: { "Content-Type": "image/png" } }); },
    f => { f.r.context.fetch = async () => { throw new TypeError("Failed to fetch"); }; }
  ]) {
    const f = adapterFixture({ url: "blob:https://images.test/source" }); config(f);
    await assert.rejects(f.read(), /OBU_MEDIA_(?:UNSUPPORTED|LIMIT|TAINTED|READ_FAILED)/);
    assert.ok(f.handles.every(h => h.disposed)); assert.equal(f.calls.filter(c => c === "resolve").length, 1);
  }
});

test("8 MiB is an exact decoded cap and non-final chunks concatenate without padding", async () => {
  const bytes = new Uint8Array(MAX_MEDIA_BYTES); bytes[0] = 0x89; bytes[bytes.length - 1] = 0xff;
  const f = adapterFixture({ url: "blob:https://images.test/large" });
  f.r.context.fetch = async () => new Response(bytes, { headers: { "Content-Type": "image/png" } });
  const result = await f.read();
  assert.equal(result.byteLength, MAX_MEDIA_BYTES); assert.deepEqual(Buffer.from(result.bytesBase64, "base64"), Buffer.from(bytes));
  assert.equal(f.calls.filter(c => c === "chunk").length, Math.ceil(MAX_MEDIA_BYTES / MEDIA_CHUNK_BYTES));
  for (const declared of [false, true]) {
    const f = adapterFixture({ url: "blob:https://images.test/large" });
    let signal;
    f.r.context.fetch = async (_url, options) => { signal = options.signal; return new Response(new Uint8Array(MAX_MEDIA_BYTES + 1), { headers: { "Content-Type": "image/png", ...(declared ? { "Content-Length": String(MAX_MEDIA_BYTES + 1) } : {}) } }); };
    await assert.rejects(f.read(), /OBU_MEDIA_LIMIT/); assert.equal(signal.aborted, true); assert.ok(f.handles.every(h => h.disposed));
  }
});

test("cancel aborts the actual pending renderer fetch then joins exact disposal before settling", async () => {
  const f = adapterFixture({ url: "blob:https://images.test/pending" }), entered = deferred(), abort = deferred(), disposal = deferred();
  let cancel, settled = false, unsubscribed = false;
  f.options.onCancel = fn => { cancel = fn; return () => { unsubscribed = true; }; };
  f.r.context.fetch = (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => { abort.resolve(); reject(new DOMException("aborted", "AbortError")); }, { once: true }); entered.resolve();
  });
  f.native.dispose = async handle => { await disposal.promise; handle.disposed = true; };
  const operation = f.read(); const outcome = operation.then(value => ({ value }), error => ({ error })); outcome.then(() => { settled = true; });
  await entered.promise; await cancel(new Error("OBU_DOWNLOAD_EXPIRED")); await abort.promise; await flush();
  assert.equal(settled, false); assert.equal(unsubscribed, false);
  disposal.resolve(); assert.match((await outcome).error.message, /OBU_MEDIA_READ_FAILED|OBU_DOWNLOAD_EXPIRED/);
  assert.equal(unsubscribed, true); assert.ok(f.handles[0].disposed);
  await cancel(); assert.equal(f.calls.filter(c => c === "cancel").length, 1);
});

test("native progress cancellation aborts reads, but canvas encoding stays tracked until its callback", async () => {
  const f = adapterFixture(), entered = deferred(), encoded = deferred(); f.r.element("canvas", { encode: callback => { entered.resolve(); encoded.promise.then(() => callback(new Blob(["x"], { type: "image/png" }))); } });
  let cleanup, settled = false;
  f.progress.cleanupWhenAborted = fn => { cleanup = fn; };
  const outcome = f.read().then(value => ({ value }), error => ({ error })); outcome.then(() => { settled = true; });
  await entered.promise; await cleanup(); await flush(); assert.equal(settled, false);
  encoded.resolve(); assert.match((await outcome).error.message, /OBU_DOWNLOAD_EXPIRED/); assert.ok(f.handles[0].disposed);
});

test("already cancelled reads never resolve a node or start native fetch", async () => {
  const f = adapterFixture({ url: "data:image/png;base64,AQID" });
  f.options.onCancel = callback => { void callback(new Error("OBU_DOWNLOAD_EXPIRED")); return () => {}; };
  await assert.rejects(f.read(), /OBU_DOWNLOAD_EXPIRED/); assert.deepEqual(f.calls, []);
});


test("native data fetch decodes base64 and percent bytes without involving HTTP or page getters", async () => {
  for (const [url, expected] of [["data:image/png;base64,AAH/gA==", [0, 1, 255, 128]], ["data:image/png,%00%01%FF%80", [0, 1, 255, 128]]]) {
    const f = adapterFixture({ url });
    const value = await f.read();
    assert.deepEqual([...Buffer.from(value.bytesBase64, "base64")], expected);
    assert.equal(value.mimeType, "image/png"); assert.equal(value.byteLength, 4);
  }
});

test("a failed native abort stays retryable until actual binding disposal is confirmed", async () => {
  const f = adapterFixture(), entered = deferred(), encoded = deferred();
  f.r.element("canvas", { encode: cb => { entered.resolve(); encoded.promise.then(() => cb(new Blob(["x"], { type: "image/png" }))); } });
  let callback, disposalFails = true, aborts = 0;
  f.options.onCancel = fn => { callback = fn; return () => {}; };
  f.native.cancel = async () => { aborts++; throw new Error("native abort failed"); };
  f.native.dispose = async handle => { if (disposalFails) throw new Error("release failed"); handle.disposed = true; };
  const outcome = f.read().then(value => ({ value }), error => ({ error })); await entered.promise;
  await assert.rejects(callback(new Error("OBU_DOWNLOAD_EXPIRED")), /native abort failed/);
  encoded.resolve(); const { error } = await outcome;
  assert.equal(error.mediaCleanupFailed, true);
  await assert.rejects(callback(), /native abort failed/); assert.equal(aborts, 2);
  disposalFails = false; await error.retryMediaCleanup(); await callback();
  assert.equal(aborts, 2); assert.ok(f.handles[0].disposed);
});


test("mid-reader cancellation closes native read requests before AbortSignal errors the stream", async () => {
  const f = adapterFixture({ url: "blob:https://images.test/pending-reader" }), reading = deferred(), nativeCancel = deferred();
  let callback, aborted = 0, cancelled = 0, settled = false;
  f.options.onCancel = fn => { callback = fn; return () => {}; };
  f.r.context.fetch = async (_url, { signal }) => new Response(new ReadableStream({
    start(controller) { signal.addEventListener("abort", () => { aborted++; controller.error(new DOMException("aborted", "AbortError")); }, { once: true }); },
    pull() { reading.resolve(); },
    cancel() { cancelled++; return nativeCancel.promise; }
  }, { highWaterMark: 0 }), { headers: { "Content-Type": "image/png" } });
  const outcome = f.read().then(value => ({ value }), error => ({ error })); outcome.then(() => { settled = true; });
  await reading.promise;
  assert.ok(f.handles[0]?.binding.reader, "zero-buffer stream pulls only for the actual native read");
  const abort = callback(new Error("OBU_DOWNLOAD_EXPIRED"));
  await flush(); assert.equal(aborted, 1); assert.equal(cancelled, 1); assert.equal(settled, false);
  assert.equal(f.handles[0].disposed, undefined, "native cancellation has not settled yet");
  nativeCancel.resolve(); await abort;
  assert.match((await outcome).error.message, /OBU_DOWNLOAD_EXPIRED/);
  assert.equal(f.handles[0].disposed, true); assert.equal(cancelled, 1, "reader finally must join, not cancel again");
});

test("underlying stream cancellation failure is retained rather than treated as a normal AbortError", async () => {
  const f = adapterFixture({ url: "blob:https://images.test/failing-reader" }), reading = deferred();
  let callback, calls = 0;
  f.options.onCancel = fn => { callback = fn; return () => {}; };
  f.r.context.fetch = async (_url, { signal }) => new Response(new ReadableStream({
    start(controller) { signal.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")), { once: true }); },
    pull() { reading.resolve(); },
    cancel() { calls++; return Promise.reject(new Error("actual underlying cancellation failed")); }
  }, { highWaterMark: 0 }), { headers: { "Content-Type": "image/png" } });
  const outcome = f.read().then(value => ({ value }), error => ({ error }));
  await reading.promise; assert.ok(f.handles[0]?.binding.reader);
  await assert.rejects(callback(), /actual underlying cancellation failed/);
  assert.match((await outcome).error.message, /OBU_MEDIA_READ_FAILED/);
  assert.equal(calls, 1); assert.equal(f.handles[0].disposed, true);
});

test("cancellation while fetch returns cannot acquire a new reader after the abort", async () => {
  const f = adapterFixture({ url: "blob:https://images.test/late-response" }), fetchEntered = deferred(), response = deferred();
  let callback, pulls = 0;
  f.options.onCancel = fn => { callback = fn; return () => {}; };
  f.r.context.fetch = async () => { fetchEntered.resolve(); return response.promise; };
  const outcome = f.read().then(value => ({ value }), error => ({ error }));
  await fetchEntered.promise; await callback();
  response.resolve(new Response(new ReadableStream({ pull() { pulls++; } }, { highWaterMark: 0 }), { headers: { "Content-Type": "image/png" } }));
  assert.match((await outcome).error.message, /OBU_DOWNLOAD_EXPIRED/);
  assert.equal(pulls, 0); assert.equal(f.handles[0].disposed, true);
});
