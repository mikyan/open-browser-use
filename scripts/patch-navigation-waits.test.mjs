import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import vm from "node:vm";
import { patchCrxNavigationWaits } from "./patch-navigation-waits.mjs";

const require = createRequire(new URL("../apps/chrome-extension/package.json", import.meta.url));
const packageDir = path.dirname(require.resolve("playwright-crx/package.json"));
const entry = await fs.readFile(path.join(packageDir, "lib/index.mjs"), "utf8");
const chunk = /from ["']\.\/([^"']+\.mjs)/.exec(entry)[1];
const upstream = await fs.readFile(path.join(packageDir, "lib", chunk), "utf8");
const patched = patchCrxNavigationWaits(upstream);

function slice(source, start, end) {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `Native fixture boundary missing: ${start}`);
  return source.slice(from, to);
}

// Run the real pinned native Waiter, Frame wait methods, URL/glob helpers and
// load-state verifier. Only the browser/channel/zone event sources are fakes;
// there is no substitute URL matcher, lifecycle algorithm or waiter here.
function fixture({ loaded = [], url = "https://example.test/start", baseURL, delayed = false, closed = false } = {}) {
  const timers = new Map(), logs = [], delayedCalls = [];
  let timerId = 0;
  class TimeoutError extends Error { constructor(message) { super(message); this.name = "TimeoutError"; } }
  const source = slice(patched, "const escapedChars =", "function blendWithWhite(") +
    slice(patched, "class Waiter {", "class Worker extends") +
    slice(patched, "const kLifecycleEvents =", "class Frame extends").split("\n").filter(line => line.startsWith("const kLifecycleEvents =")).join("\n") +
    slice(patched, "function verifyLoadState(name, waitUntil) {", "let WritableStream$1 =") +
    "\nclass NativeFrame {\n" + slice(patched, "  _setupNavigationWaiter(options2) {", "  async frameElement() {") + "\n}\n" +
    patched.slice(patched.lastIndexOf("const obuNavigationWaitControl =")).replace("export function", "function") +
    "\n({ NativeFrame, createOpenBrowserUseNavigationWait });";
  const { NativeFrame, createOpenBrowserUseNavigationWait } = vm.runInNewContext(source, {
    URL, Error, TimeoutError2: TimeoutError,
    isString: value => typeof value === "string",
    rewriteErrorMessage: (error, message) => { error.message = message; },
    Events: { Page: { Close: "close", Crash: "crash", FrameDetached: "framedetached" } },
    Request2: { fromNullable: request => request },
    setTimeout: (callback, ms) => { const id = ++timerId; timers.set(id, { callback, ms }); return id; },
    clearTimeout: id => timers.delete(id)
  });
  const page = new EventEmitter(), frame = new NativeFrame();
  const zone = { run: callback => callback(), pop() { return this; } };
  Object.assign(page, {
    _platform: { createGuid: () => "native-wait", zones: { current: () => zone } },
    _channel: { waitForEventInfo: async data => { logs.push(data.info); } },
    _wrapApiCall: async (callback, options) => delayed && !options?.internal
      ? await new Promise((resolve, reject) => delayedCalls.push(() => Promise.resolve().then(callback).then(resolve, reject)))
      : await callback(),
    _timeoutSettings: { navigationTimeout: options => options.timeout },
    isClosed: () => closed, _closeErrorWithReason: () => new Error("native target closed"),
    context: () => ({ _options: { baseURL } }),
    waitForURL: (...args) => frame.waitForURL(...args),
    waitForLoadState: (...args) => frame.waitForLoadState(...args)
  });
  Object.assign(frame, { _page: page, _loadStates: new Set(loaded), _eventEmitter: new EventEmitter(), url: () => url });
  const observer = options => createOpenBrowserUseNavigationWait(page, { timeoutMs: 1000, ...options });
  const noListeners = () => {
    assert.equal(page.eventNames().length, 0);
    assert.equal(frame._eventEmitter.eventNames().length, 0);
    assert.equal(timers.size, 0);
  };
  return { page, frame, observer, noListeners, timers, logs, delayedCalls };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

test("navigation patch fails closed on either changed private native anchor", () => {
  assert.throws(() => patchCrxNavigationWaits("unrecognized runtime"), /shape changed/);
  assert.throws(() => patchCrxNavigationWaits(upstream.replace("_setupNavigationWaiter(options2)", "_setupNavigationWaiter(changed)")), /shape changed/);
  assert.throws(() => patchCrxNavigationWaits(upstream.replace("async waitForEvent(emitter, event, predicate)", "async waitForEvent(changed, event, predicate)")), /shape changed/);
});

test("ready follows actual native listener installation; URL glob and lifecycle both retain native semantics", async () => {
  const f = fixture();
  const o = f.observer({ event: "url", url: "**/{done,complete}?x=*", waitUntil: "domcontentloaded" });
  await o.ready;
  assert.equal(f.frame._eventEmitter.listenerCount("navigated"), 1);
  let finished = false; o.result.then(() => { finished = true; });
  f.frame._eventEmitter.emit("navigated", { url: "https://example.test/no-match" }); await flush();
  assert.equal(finished, false);
  f.frame._eventEmitter.emit("navigated", { url: "https://example.test/done?x=2" }); await flush();
  assert.equal(f.frame._eventEmitter.listenerCount("loadstate"), 1);
  f.frame._eventEmitter.emit("loadstate", "load"); await flush(); assert.equal(finished, false);
  f.frame._eventEmitter.emit("loadstate", "domcontentloaded");
  assert.equal(await o.result, undefined); f.noListeners();
});

test("cached current URL and cached load state resolve without registering a navigation listener", async () => {
  const f = fixture({ loaded: ["load"], url: "https://example.test/start", baseURL: "https://example.test" });
  for (const options of [{ event: "url", url: "/start" }, { event: "loadstate", state: "load" }]) {
    const o = f.observer(options); await o.ready; await o.result; f.noListeners();
  }
});

test("same-document native navigation and commit are observed without fabricated load events", async () => {
  const f = fixture({ loaded: ["commit", "load"] });
  const o = f.observer({ event: "url", url: "**/start#next", waitUntil: "commit" }); await o.ready;
  f.frame._eventEmitter.emit("navigated", { url: "https://example.test/start#next" });
  await o.result; f.noListeners();
});

test("cancellation settles only after native listeners/timers are removed and preserves the original Error", async () => {
  const f = fixture();
  const o = f.observer({ event: "loadstate", state: "load" }); await o.ready;
  const reason = new Error("OBU_NAVIGATION_WAIT_EXPIRED: ownership ended"); reason.code = "EXPIRED";
  o.cancel(reason); o.cancel(new Error("must be ignored"));
  await assert.rejects(o.result, error => error === reason && error.code === "EXPIRED");
  f.noListeners();
  f.frame._eventEmitter.emit("loadstate", "load"); await flush(); f.noListeners();
});

test("cancel before delayed native wrapper entry rejects ready and prevents late listener registration", async () => {
  const f = fixture({ delayed: true });
  const o = f.observer({ event: "url", url: "**/next" });
  const reason = new Error("cancelled before setup"); o.cancel(reason);
  await assert.rejects(o.ready, error => error === reason);
  let resultSettled = false; o.result.catch(() => { resultSettled = true; }); await flush();
  assert.equal(resultSettled, false, "drain must retain the actual delayed native completion");
  f.noListeners(); f.delayedCalls.shift()();
  await assert.rejects(o.result, error => error === reason); f.noListeners();
});

test("cancelling one native observer does not close the Page or cancel another observer", async () => {
  const f = fixture({ loaded: ["load"] });
  const cancelled = f.observer({ event: "url", url: "**/never" });
  const active = f.observer({ event: "url", url: "**/done" }); await Promise.all([cancelled.ready, active.ready]);
  cancelled.cancel(); await assert.rejects(cancelled.result, /cancelled/);
  assert.equal(f.frame._eventEmitter.listenerCount("navigated"), 1);
  f.frame._eventEmitter.emit("navigated", { url: "https://example.test/done" }); await active.result; f.noListeners();
});

test("cancellation between navigation and load-state phases cleans remaining native failures", async () => {
  const f = fixture(); const o = f.observer({ event: "url", url: "**/done" }); await o.ready;
  f.frame._eventEmitter.emit("navigated", { url: "https://example.test/done" });
  o.cancel(new Error("phase transition cancelled"));
  await assert.rejects(o.result, /phase transition cancelled/); f.noListeners();
});

test("cancellation immediately before the second native listener disposes the already-created Waiter", async () => {
  const f = fixture(); const o = f.observer({ event: "url", url: "**/done" }); await o.ready;
  f.frame._loadStates.has = () => { o.cancel(new Error("cancel at load-state boundary")); return false; };
  f.frame._eventEmitter.emit("navigated", { url: "https://example.test/done" });
  await assert.rejects(o.result, /cancel at load-state boundary/); f.noListeners();
});

test("native final redirected response completion remains cancellable after navigation and lifecycle", async () => {
  const f = fixture({ loaded: ["load"] });
  let finishResponse;
  const response = new Promise(resolve => { finishResponse = resolve; });
  const request = { _finalRequest: () => ({ _internalResponse: () => response }) };
  const o = f.observer({ event: "url", url: "**/done" }); await o.ready;
  f.frame._eventEmitter.emit("navigated", { url: "https://example.test/done", newDocument: { request } }); await flush();
  o.cancel(new Error("cancel during final response"));
  await assert.rejects(o.result, /cancel during final response/); f.noListeners();
  finishResponse({ status: 200 }); await flush(); f.noListeners();
});

test("native timeout, navigation error, crash, close and frame detachment preserve native failure paths", async () => {
  for (const kind of ["timeout", "error", "crash", "close", "framedetached"]) {
    const f = fixture(); const o = f.observer({ event: "url", url: "**/done" }); await o.ready;
    if (kind === "timeout") f.timers.values().next().value.callback();
    else if (kind === "error") f.frame._eventEmitter.emit("navigated", { url: "https://example.test/done", error: "net::ERR_CONNECTION_REFUSED" });
    else f.page.emit(kind, f.frame);
    await assert.rejects(o.result, error => kind === "timeout" ? error.name === "TimeoutError" : /failed|closed|detached|ERR_CONNECTION_REFUSED/.test(error.message));
    f.noListeners();
  }
});

test("invalid lifecycle rejects readiness and result; native waits without hooks still work", async () => {
  const f = fixture({ loaded: ["load"] });
  const o = f.observer({ event: "loadstate", state: "invalid" });
  await assert.rejects(o.ready, /expected one of/); await assert.rejects(o.result, /expected one of/); f.noListeners();
  await f.frame.waitForLoadState("load", { timeout: 1000 }); f.noListeners();
});
