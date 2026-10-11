import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { test } from "node:test";
import { MEDIA_CANCEL_FUNCTION } from "../apps/chrome-extension/browser-media-source.js";
import { MediaContextLifetimes } from "../apps/chrome-extension/browser-media-lifetime.js";
import { mediaTaskBridge, patchCrxMediaSource } from "./patch-media-source.mjs";

const require = createRequire(new URL("../apps/chrome-extension/package.json", import.meta.url));
const directory = path.dirname(require.resolve("playwright-crx/package.json"));
const entry = await fs.readFile(path.join(directory, "lib/index.mjs"), "utf8");
const chunk = /from ["']\.\/([^"']+\.mjs)/.exec(entry)[1];
const upstream = await fs.readFile(path.join(directory, "lib", chunk), "utf8");
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const flush = () => new Promise(resolve => setImmediate(resolve));

function slice(start, end, source = upstream) {
  assert.equal(source.split(start).length, 2, `pinned native boundary must be unique: ${start}`);
  const from = source.indexOf(start), to = source.indexOf(end, from);
  assert.ok(to > from, `pinned native boundary missing: ${end}`);
  return source.slice(from, to);
}

function fixture() {
  const event = () => { const listeners = new Set(); return { listeners, addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn), emit: (...args) => { for (const fn of [...listeners]) fn(...args); } }; };
  const nativeEvents = { onEvent: event(), onDetach: event(), onTabRemoved: event() };
  const lifetimes = new MediaContextLifetimes(nativeEvents);
  const timers = new Map(), active = new Set(), sent = [], released = [], cancelled = [], identities = new Map([[7, {}]]), children = new Map([["oopif-session", 7]]);
  let timerId = 0;
  class ManualPromise extends Promise {
    constructor() { let resolve, reject; super((a, b) => { resolve = a; reject = b; }); this.resolve = resolve; this.reject = reject; }
    static get [Symbol.species]() { return Promise; }
  }
  class TimeoutError extends Error { constructor(message) { super(message); this.name = "TimeoutError"; } }
  class Locator { constructor(frame) { this._frame = { _toImpl: () => frame }; this._selector = "img"; } }
  class CRExecutionContext {}
  class JSHandle { constructor(context, id, element = false) { this._context = context; this._objectId = id; this._disposed = false; this.element = element; } asElement() { return this.element ? this : null; } }
  const transport = { _tabToTarget: identities, _sessions: children,
    async _send(target, method, params) { sent.push({ target, method, params }); return { result: { objectId: "object-1", type: "object" } }; } };
  const hooks = { prepareMediaCleanup(target, contextId) {
    const identity = identities.get(target.tabId), lease = lifetimes.capture(target, contextId);
    return { close: lease.close, cancel: async objectId => {
      if (lease.isGone()) return;
      assert.equal(identities.get(target.tabId), identity);
      if (target.sessionId) assert.equal(children.get(target.sessionId), target.tabId);
      cancelled.push({ target, objectId });
    }, release: async objectId => {
      if (lease.isGone()) return;
      assert.equal(identities.get(target.tabId), identity);
      if (target.sessionId) assert.equal(children.get(target.sessionId), target.tabId);
      released.push({ target, objectId });
    } };
  } };
  const source = slice("class ProgressController {", "const fileUploadSizeLimit$1 =") +
    mediaTaskBridge.replace("export async function", "async function") + "\n({ runOpenBrowserUseMediaTask, createOpenBrowserUseMediaOperations });";
  const runtime = vm.runInNewContext(source, {
    assert, Error, ManualPromise, TimeoutError$1: TimeoutError, monotonicTime: () => 0,
    setTimeout: callback => { const id = ++timerId; timers.set(id, callback); return id; }, clearTimeout: id => timers.delete(id),
    Locator, CRExecutionContext, JSHandle$1: JSHandle, openBrowserUseInputHooks: hooks,
    createHandle$3: (context, remote) => new JSHandle(context, remote.objectId, remote.subtype === "node"),
    JavaScriptErrorInEvaluate: Error, getExceptionMessage: details => details.text,
    serverSideCallMetadata: () => ({ log: [] })
  });
  const frame = { selectors: {}, retryWithProgressAndTimeouts() {}, instrumentation: { onCallLog() {} }, attribution: { context: { _activeProgressControllers: active } } };
  const context = { world: "utility", delegate: new CRExecutionContext(), frame };
  context.delegate._contextId = 41;
  context.delegate._client = { _sessionId: "crx-tab-7", _connection: { _transport: transport } };
  const injected = new JSHandle(context, "injected");
  const operations = runtime.createOpenBrowserUseMediaOperations(), owned = [];
  operations.setHandleObserver(handle => owned.push(handle));
  return { ...runtime, lifetimes, nativeEvents, frame, locator: new Locator(frame), context, injected, operations, owned, timers, active, transport, hooks, sent, released, cancelled, identities, children };
}

test("media patch fails closed on changed native controller, selector and frame-owner shapes", () => {
  assert.throws(() => patchCrxMediaSource("unrecognized"), /shape changed/);
  for (const anchor of ["class ProgressController {", "class CRExecutionContext {", "  async _getContentFrame(handle) {", "      element.dispose();"])
    assert.throws(() => patchCrxMediaSource(upstream.replace(anchor, "changed anchor")), /shape changed/);
  assert.match(patchCrxMediaSource(upstream), /options2.obuMedia.getContentFrame\(element\)/);
});

test("actual pinned ProgressController timeout cannot settle the source before late task cleanup", async () => {
  const f = fixture(), native = deferred(), cleanup = deferred(), entered = deferred(); let settled = false;
  const result = f.runOpenBrowserUseMediaTask(f.locator, { timeoutMs: 10 }, async (_frame, _selector, progress) => {
    entered.resolve(); try { await native.promise; progress.throwIfAborted(); } finally { await cleanup.promise; }
  });
  result.then(() => { settled = true; }, () => { settled = true; });
  await entered.promise; [...f.timers.values()][0](); await flush();
  assert.equal(f.active.size, 0, "native controller has already aborted"); assert.equal(settled, false);
  native.resolve(); await flush(); assert.equal(settled, false);
  cleanup.resolve(); await assert.rejects(result, error => error.name === "TimeoutError");
  assert.equal(f.timers.size, 0);
});

test("cleanup failure survives an earlier native timeout and remains explicitly retryable", async () => {
  const f = fixture(), pending = deferred(), entered = deferred();
  const error = Object.assign(new Error("release failed"), { mediaCleanupFailed: true, retryMediaCleanup: async () => {} });
  const result = f.runOpenBrowserUseMediaTask(f.locator, { timeoutMs: 10 }, async () => { entered.resolve(); await pending.promise; throw error; });
  const checked = assert.rejects(result, value => value === error);
  await entered.promise; [...f.timers.values()][0](); await flush(); pending.resolve(); await checked;
});

test("media calls retain original OOPIF routing and wait for actual release success before marking disposed", async () => {
  const f = fixture(); f.context.delegate._client._sessionId = "oopif-session";
  const handle = await f.operations.evaluateHandle(f.injected, () => ({}), { info: { parsed: { parts: [] } } });
  assert.equal(f.owned[0], handle); assert.equal(f.sent[0].target.sessionId, "oopif-session");
  assert.equal(f.sent[0].params.userGesture, false); assert.equal(f.sent[0].method, "Runtime.callFunctionOn");
  const wait = deferred(); let fail = true;
  f.hooks.prepareMediaCleanup = () => ({ close: () => {}, release: async () => { await wait.promise; if (fail) throw new Error("native release failed"); } });
  const second = await f.operations.evaluateHandle(f.injected, () => ({}));
  const releasing = f.operations.dispose(second); await flush(); assert.equal(second._disposed, false);
  wait.resolve(); await assert.rejects(releasing, /native release failed/); assert.equal(second._disposed, false);
  fail = false; await f.operations.dispose(second); assert.equal(second._disposed, true);
  await f.operations.dispose(handle); assert.equal(f.released[0].target.sessionId, "oopif-session");
});

test("optional cleanup checkpoint reaches the original lease without delaying acknowledged release state", async () => {
  const f = fixture(), seen = [], wait = deferred();
  let expired = false;
  const checkpoint = () => { if (expired) throw new Error("cleanup deadline exceeded"); };
  f.hooks.prepareMediaCleanup = () => ({ close() {}, async cancel(objectId, check) {
    seen.push(["cancel", objectId, check]); check();
  }, async release(objectId, check) {
    seen.push(["release", objectId, check]); check(); await wait.promise;
  } });
  const handle = await f.operations.evaluateHandle(f.injected, () => ({}));
  await f.operations.cancel(handle, checkpoint);
  const disposal = f.operations.dispose(handle, checkpoint); await flush();
  assert.equal(handle._disposed, false);
  expired = true; wait.resolve(); await disposal;
  assert.equal(handle._disposed, true, "actual release ACK is retained before the outer caller checks its expired budget");
  assert.deepEqual(seen.map(([name, id, check]) => [name, id, check === checkpoint]), [["cancel", "object-1", true], ["release", "object-1", true]]);
  await f.operations.dispose(handle, checkpoint); assert.equal(seen.length, 2);
});

test("old exact native handles cannot release a replacement attachment or child session", async () => {
  for (const replace of [f => f.identities.set(7, {}), f => f.children.delete("oopif-session")]) {
    const f = fixture(); f.context.delegate._client._sessionId = "oopif-session";
    const handle = await f.operations.evaluateHandle(f.injected, () => ({})); replace(f);
    await assert.rejects(f.operations.dispose(handle));
    assert.equal(handle._disposed, false); assert.equal(f.released.length, 0);
  }
});

test("exception RemoteObjects are owned for actual disposal, including distinct exception and result IDs", async () => {
  for (const same of [false, true]) {
    const f = fixture();
    f.transport._send = async () => ({ result: { type: "object", objectId: "error-1" }, exceptionDetails: {
      text: "strict mode violation", exception: { type: "object", objectId: same ? "error-1" : "error-2" }
    } });
    await assert.rejects(f.operations.evaluateHandle(f.injected, () => { throw new Error(); }), /strict mode violation/);
    assert.equal(f.owned.length, same ? 1 : 2);
    for (const handle of f.owned) await f.operations.dispose(handle);
    assert.equal(f.released.length, f.owned.length);
  }
});

test("frame owner resolution uses actual native lookup and waits for owner disposal before returning child", async () => {
  const patched = patchCrxMediaSource(upstream);
  const method = slice("  async resolveFrameForSelector(selector, options2 = {}, scope) {", "  async resolveInjectedForSelector(", patched);
  const NativeSelectors = vm.runInNewContext("class NativeSelectors {" + method + "}\nNativeSelectors;", {
    splitSelectorByFrame: value => value, visitAllSelectorParts: () => {}, stringifySelector: () => "iframe"
  });
  const owner = { asElement() { return this; } }, child = {}, read = deferred(), release = deferred();
  const frame = { _context: async () => ({ injectedScript: async () => ({}) }), _page: {} };
  child.selectors = { _parseSelector: selector => ({ parsed: selector }) };
  const resolver = new NativeSelectors(); Object.assign(resolver, { frame, _parseSelector: selector => ({ parsed: selector, world: "utility", strict: true }), _jumpToAriaRefFrameIfNeeded: (_selector, _info, frame) => frame });
  const media = { evaluateHandle: async () => owner, getContentFrame: async () => { await read.promise; return child; }, dispose: async value => { assert.equal(value, owner); await release.promise; } };
  let settled = false;
  const result = resolver.resolveFrameForSelector(["iframe", "img"], { strict: true, obuMedia: media }); result.then(() => { settled = true; });
  await flush(); assert.equal(settled, false); read.resolve(); await flush(); assert.equal(settled, false);
  release.resolve(); assert.equal((await result).frame, child);
});

test("late RemoteObject keeps its original destroyed context lease and releases without touching a successor", async () => {
  const f = fixture(), response = deferred();
  f.transport._send = async () => response.promise;
  const operation = f.operations.evaluateHandle(f.injected, () => ({}));
  assert.equal(f.lifetimes.size, 1);
  f.nativeEvents.onEvent.emit({ tabId: 7 }, "Runtime.executionContextDestroyed", { executionContextId: 41 });
  f.identities.set(7, {});
  response.resolve({ result: { type: "object", objectId: "late-object" } });
  const handle = await operation;
  assert.equal(f.lifetimes.size, 1, "a native destruction event cannot discard the lease before its late handle is released");
  await f.operations.dispose(handle);
  assert.equal(handle._disposed, true); assert.equal(f.released.length, 0); assert.equal(f.lifetimes.size, 0);
  for (const event of Object.values(f.nativeEvents)) assert.equal(event.listeners.size, 0);
});

test("by-value success and no-object native failure close leases only after actual native settlement", async () => {
  for (const outcome of ["value", "reject", "exception"]) {
    const f = fixture(), response = deferred(); f.transport._send = async () => response.promise;
    const result = f.operations.evaluate(f.injected, () => ({ url: "https://images.test/value" }));
    const settled = result.then(value => ({ value }), error => ({ error }));
    assert.equal(f.lifetimes.size, 1);
    f.nativeEvents.onEvent.emit({ tabId: 7 }, "Runtime.executionContextsCleared", {});
    await flush(); assert.equal(f.lifetimes.size, 1);
    if (outcome === "value") response.resolve({ result: { value: { url: "https://images.test/value" } } });
    if (outcome === "reject") response.reject(new Error("native context destroyed"));
    if (outcome === "exception") response.resolve({ result: { type: "undefined" }, exceptionDetails: { text: "native exception without object" } });
    const observed = await settled;
    assert.equal(Boolean(observed.error), outcome !== "value");
    assert.equal(f.lifetimes.size, 0); assert.equal(f.owned.length, 0);
    for (const event of Object.values(f.nativeEvents)) assert.equal(event.listeners.size, 0);
  }
});

test("shared exception lease closes only after all allocated objects are released, retaining failed cleanup", async () => {
  const f = fixture(), prepare = f.hooks.prepareMediaCleanup;
  let fail = true;
  f.hooks.prepareMediaCleanup = (...args) => {
    const cleanup = prepare(...args);
    return { close: cleanup.close, release: async objectId => {
      if (objectId === "error-2" && fail) throw new Error("native release failure");
      return cleanup.release(objectId);
    } };
  };
  f.transport._send = async () => ({ result: { type: "object", objectId: "error-1" },
    exceptionDetails: { text: "query failed", exception: { type: "object", objectId: "error-2" } } });
  await assert.rejects(f.operations.evaluateHandle(f.injected, () => ({})), /query failed/);
  assert.equal(f.lifetimes.size, 1); assert.equal(f.owned.length, 2);
  await f.operations.dispose(f.owned[0]); assert.equal(f.lifetimes.size, 1);
  await assert.rejects(f.operations.dispose(f.owned[1]), /native release failure/);
  assert.equal(f.owned[1]._disposed, false); assert.equal(f.lifetimes.size, 1);
  fail = false; await f.operations.dispose(f.owned[1]); assert.equal(f.lifetimes.size, 0);
});

test("production media calls require the private cleanup lease instead of falling back to fire-and-forget disposal", async () => {
  const f = fixture(); delete f.hooks.prepareMediaCleanup;
  await assert.rejects(f.operations.evaluateHandle(f.injected, () => ({})), /OBU_MEDIA_UNSUPPORTED: native media cleanup hook/);
  assert.equal(f.sent.length, 0); assert.equal(f.lifetimes.size, 0);
});


test("private cancellation remains bound to the original OOPIF object and joins actual native abort", async () => {
  const f = fixture(); f.context.delegate._client._sessionId = "oopif-session";
  const actual = deferred(); let calls = 0, closed = false;
  f.hooks.prepareMediaCleanup = (target, contextId) => {
    assert.equal(target.sessionId, "oopif-session"); assert.equal(contextId, 41);
    return { close: () => { closed = true; }, release: async () => {}, cancel: async objectId => {
      assert.equal(objectId, "object-1"); calls++; await actual.promise;
    } };
  };
  const handle = await f.operations.evaluateHandle(f.injected, () => ({}));
  let settled = false; const cancellation = f.operations.cancel(handle).then(() => { settled = true; });
  await flush(); assert.equal(settled, false); assert.equal(calls, 1); assert.equal(closed, false);
  actual.resolve(); await cancellation; await f.operations.dispose(handle); assert.equal(closed, true);
  await f.operations.cancel(handle); assert.equal(calls, 1, "disposed native object no longer needs abort");
  await assert.rejects(f.operations.cancel(f.injected), /not owned/);
});

test("cancellation failures can retry only the same object; actual context destruction makes old cancellation safe", async () => {
  for (const destroyed of [false, true]) {
    const f = fixture(); f.context.delegate._client._sessionId = "oopif-session";
    const handle = await f.operations.evaluateHandle(f.injected, () => ({}));
    if (destroyed) f.nativeEvents.onEvent.emit({ tabId: 7, sessionId: "oopif-session" }, "Runtime.executionContextDestroyed", { executionContextId: 41 });
    f.identities.set(7, {}); f.children.delete("oopif-session");
    if (destroyed) { await f.operations.cancel(handle); await f.operations.dispose(handle); assert.equal(f.lifetimes.size, 0); }
    else { await assert.rejects(f.operations.cancel(handle)); await assert.rejects(f.operations.dispose(handle)); assert.equal(handle._disposed, false); }
    assert.equal(f.cancelled.length, 0); assert.equal(f.released.length, 0);
  }
});

test("fixed cancellation body returns only an explicit boolean even for renderer errors", async () => {
  const fn = vm.runInNewContext(`(${MEDIA_CANCEL_FUNCTION})`);
  let calls = 0;
  assert.equal(await fn.call({ cancel: async () => { calls++; } }), true);
  assert.equal(await fn.call({ cancel: async () => { calls++; throw new Error("private page details"); } }), false);
  assert.equal(calls, 2);
});


for (const child of [false, true]) test(`private file binding describes the actual ${child ? "OOPIF" : "root/same-origin"} utility node and freezes route/context`, async () => {
  const f = fixture(); let destroyed = false;
  f.frame._id = "file-frame"; f.frame.isDetached = () => false;
  f.frame._contextData = new Map([["utility", { context: f.context }]]);
  f.context._contextDestroyedScope = { isClosed: () => destroyed };
  if (child) f.context.delegate._client._sessionId = "oopif-session";
  f.transport._send = async (target, method, params) => {
    f.sent.push({ target, method, params });
    return method === "DOM.describeNode" ? { node: { nodeName: "INPUT", backendNodeId: 77 } } : { result: { objectId: "file-node", subtype: "node" } };
  };
  const node = await f.operations.evaluateHandle(f.injected, () => null);
  const identity = f.operations.fileInputIdentity(node);
  assert.deepEqual(JSON.parse(JSON.stringify(identity.target)), { tabId: 7, ...(child ? { sessionId: "oopif-session" } : {}) });
  assert.equal(identity.frameId, "file-frame"); assert.equal(await identity.describe(), 77);
  assert.deepEqual(JSON.parse(JSON.stringify(f.sent.at(-1).params)), { objectId: "file-node", depth: 0 });
  destroyed = true; assert.throws(identity.check, /FILE_INPUT_CHANGED/);
  await f.operations.dispose(node);
});

test("file binding rejects unowned handles, replacement context and late original describe responses", async () => {
  const f = fixture(), gate = deferred(), entered = deferred();
  f.frame._id = "root"; f.frame.isDetached = () => false;
  f.frame._contextData = new Map([["utility", { context: f.context }]]);
  f.context._contextDestroyedScope = { isClosed: () => false };
  assert.throws(() => f.operations.fileInputIdentity(f.injected), /FILE_INPUT_CHANGED/);
  f.transport._send = async (_target, method) => {
    if (method === "DOM.describeNode") { entered.resolve(); await gate.promise; return { node: { nodeName: "INPUT", backendNodeId: 99 } }; }
    return { result: { objectId: "node", subtype: "node" } };
  };
  const node = await f.operations.evaluateHandle(f.injected, () => null), identity = f.operations.fileInputIdentity(node);
  const result = assert.rejects(identity.describe(), /FILE_INPUT_CHANGED/);
  await entered.promise; f.frame._contextData.set("utility", { context: {} }); gate.resolve(); await result;
  await f.operations.dispose(node);
});
