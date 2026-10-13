import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import test from "node:test";
import vm from "./test-support/backend-vm.mjs";
import { BrowserActionEngine } from "./browser-action-engine.js";

const input = (await readFile(new URL("./browser-input-adapter.js", import.meta.url), "utf8")).replace(/^export /gm, "");
const source = (await readFile(new URL("./background.js", import.meta.url), "utf8"))
  .replace('import { createBrowserActionEngine } from "./browser-runtime.js";', "")
  .replace('import { NativeInputTracker } from "./browser-input-adapter.js";', input);
const code = source.slice(0, source.indexOf("chrome.runtime.onInstalled.addListener"));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const url = "https://fixture.test/api";
const event = () => { const listeners = []; return { addListener: fn => listeners.push(fn), emit: (...args) => listeners.forEach(fn => fn(...args)) }; };
const nativeRequest = () => ({ url: () => url, method: () => "POST", resourceType: () => "fetch", frame: () => ({ url: () => "https://fixture.test" }), redirectedFrom: () => null });

async function fixture(t) {
  const storage = {}, calls = [], tabs = new Map([[7, { id: 7, groupId: 10, windowId: 1, url: "https://fixture.test" }]]), pages = new Map();
  const hooks = {}; let engineOptions;
  const chrome = {
    storage: { local: {
      async get(key) { return structuredClone(Object.hasOwn(storage, key) ? { [key]: storage[key] } : {}); },
      async set(value) { await hooks.write?.(value); Object.assign(storage, structuredClone(value)); }
    } },
    debugger: { onDetach: event(), onEvent: event(),
      async attach({ tabId }) { calls.push(["raw-attach", tabId]); },
      async detach({ tabId }) { calls.push(["detach", tabId]); },
      async sendCommand(target, method, params) { calls.push([method, target.tabId, structuredClone(params)]); await hooks.native?.(target, method, params); return {}; }
    },
    tabs: { onRemoved: event(), onUpdated: event(), onDetached: event(), onReplaced: event(),
      async get(id) { return tabs.get(id); },
      async query(filter) { await hooks.query?.(); return [...tabs.values()].filter(tab => filter?.groupId === undefined || tab.groupId === filter.groupId); },
      async sendMessage() { return {}; }
    },
    tabGroups: { async update() {} },
    runtime: { id: "fixture", getURL: path => `chrome-extension://fixture/${path}`, getManifest: () => ({ version: "test" }) }
  };
  const app = {
    async attach(tabId) {
      calls.push(["engine-attach", tabId]);
      await hooks.attach?.();
      const page = new EventEmitter(); page._channel = { async updateSubscription(params) { calls.push(["subscription", params.enabled]); await hooks.subscription?.(params); } };
      page.getByRole = () => ({ click: async () => {
        calls.push(["click", tabId]);
        page.emit("response", { request: () => nativeRequest(), status: () => 200, statusText: () => "OK" });
      } });
      pages.set(tabId, page);
      return page;
    },
    async detach(tabId) { pages.get(tabId)?.emit("close"); pages.delete(tabId); calls.push(["engine-detach", tabId]); }
  };
  const runtime = { crx: { start: async () => app }, setOpenBrowserUseCommandObserver() {}, setOpenBrowserUseEventFilter() {}, setOpenBrowserUseInputHooks() {} };
  const createBrowserActionEngine = options => { engineOptions = options; return new BrowserActionEngine({ ...options, loadRuntime: async () => runtime,
    aroundAction: ({ run }) => run() }); };
  const oldChrome = globalThis.chrome;
  globalThis.chrome = chrome;
  const Backend = vm.runInNewContext(`${code}\nBrowserBackend`, { chrome, crypto, Date, URL, setTimeout, clearTimeout, createBrowserActionEngine });
  const backend = new Backend();
  await backend.controlReady;
  for (const [sessionId, groupId] of [["task", 10], ["other", 20]]) {
    const session = await backend.store.getSession(sessionId);
    session.chromeGroupId = groupId;
    session.tabOrigins = { 7: "agent" };
  }
  await backend.store.save();
  const current = await backend.getControlState({ session_id: "task" });
  const other = await backend.getControlState({ session_id: "other" });
  const params = { session_id: "task", turn_id: "turn", control_epoch: current.controlEpoch, tabId: 7 };
  const otherParams = { session_id: "other", turn_id: "other-turn", control_epoch: other.controlEpoch, tabId: 7 };
  t.after(async () => {
    hooks.query = hooks.attach = hooks.write = hooks.native = hooks.subscription = hooks.clientReply = undefined;
    for (const dialogs of backend.nativeDialogs.values()) for (const proof of dialogs.values()) proof.open = false;
    await backend.dialogs?.invalidateAll();
    await Promise.allSettled([...backend.browserEngine?.pages.keys() ?? []].map(id => backend.browserEngine.detach(id)));
    globalThis.chrome = oldChrome;
  });
  const arm = extra => backend.armDialog({ ...params, type: "confirm", accept: true, timeoutMs: 1000, ...extra });
  const handle = ready => ({ ...params, dialogId: ready.dialogId });
  const send = (target, params) => {
    const actual = engineOptions.inputHooks.send(target, "Page.handleJavaScriptDialog", params,
      () => chrome.debugger.sendCommand(target, "Page.handleJavaScriptDialog", params));
    actual.catch(() => {});
    return hooks.clientReply ? hooks.clientReply(actual) : actual;
  };
  const open = (type = "confirm", message = "Proceed?", target = { tabId: 7 }) => {
    backend.handleCdpEvent(target, "Page.javascriptDialogOpening", { type, message, defaultPrompt: "default" });
    const dialog = { type: () => type, message: () => message, defaultValue: () => "default",
      accept: promptText => send(target, { accept: true, promptText }), dismiss: () => send(target, { accept: false }) };
    if (!pages.get(7).emit("dialog", dialog)) void (type === "beforeunload" ? dialog.accept() : dialog.dismiss()).catch(() => {});
    return dialog;
  };
  return { backend, chrome, pages, tabs, calls, hooks, params, otherParams, arm, handle, open, send };
}

test("native dialog arm exposes readiness and confirms exactly one native decision", async t => {
  const f = await fixture(t);
  assert.equal((await f.backend.getInfo()).metadata.dialogVersion, 1);
  const ready = await f.arm();
  assert.ok(ready.remainingMs > 0 && ready.remainingMs <= 1000);
  f.open();
  const result = await f.backend.collectDialog(f.handle(ready));
  assert.equal(result.accepted, true);
  assert.equal(result.message, "Proceed?");
  assert.equal(f.calls.filter(([method]) => method === "Page.handleJavaScriptDialog").length, 1);
});

test("new same-process and OOPIF documents preserve the Page policy; top commit revokes it", async t => {
  const f = await fixture(t), ready = await f.arm();
  f.backend.handleCdpEvent({ tabId: 7 }, "Page.frameNavigated", { frame: { id: "child", parentId: "root" } });
  f.backend.handleCdpEvent({ tabId: 7, sessionId: "oopif" }, "Page.frameNavigated", { frame: { id: "child" } });
  f.open("confirm", "Proceed?", { tabId: 7, sessionId: "oopif" });
  assert.equal((await f.backend.collectDialog(f.handle(ready))).accepted, true);
  const next = await f.arm();
  f.backend.handleCdpEvent({ tabId: 7 }, "Page.frameNavigated", { frame: { id: "root" } });
  await assert.rejects(f.backend.collectDialog(f.handle(next)), /OBU_DIALOG_EXPIRED/);
});

test("ready awaits actual subscription ACK and expiry cannot publish a late policy", async t => {
  const f = await fixture(t), gate = deferred();
  const engine = await f.backend.getBrowserEngine();
  await engine.withPage(f.params, { deadlineAt: performance.now() + 1000 }, () => {});
  f.hooks.subscription = ({ enabled }) => enabled ? gate.promise : undefined;
  await assert.rejects(f.arm({ timeoutMs: 25 }), /OBU_DIALOG_TIMEOUT/);
  assert.equal(f.pages.get(7).listenerCount("dialog"), 0);
  assert.equal(f.backend.dialogs.byTab.size, 1);
  gate.resolve(); await tick(); await tick();
  assert.equal(f.backend.dialogs.byTab.size, 0);
  assert.deepEqual(f.calls.filter(([kind]) => kind === "subscription"), [["subscription", true], ["subscription", false]]);
});

test("client response failure cannot release the original actual native ACK or detach early", async t => {
  const f = await fixture(t), gate = deferred(), ready = await f.arm();
  f.hooks.native = (_target, method) => method === "Page.handleJavaScriptDialog" ? gate.promise : undefined;
  f.hooks.clientReply = () => Promise.reject(new Error("client channel closed early"));
  f.open(); await tick();
  let ended = false;
  const ending = f.backend.detachTab(7).then(() => { ended = true; });
  await tick();
  assert.equal(ended, false);
  assert.equal(f.calls.some(([kind]) => kind === "detach" || kind === "engine-detach"), false);
  assert.equal(f.backend.nativeDialogOperations.size, 1);
  assert.ok(f.backend.globalControlSnapshot().pending.length > 0);
  gate.resolve(); await ending;
  assert.equal(f.backend.nativeDialogOperations.size, 0);
  await assert.rejects(f.backend.dialogs.collect(f.handle(ready)), /OBU_DIALOG_EXPIRED/);
  assert.equal(f.calls.filter(([method]) => method === "Page.handleJavaScriptDialog").length, 1);
});

test("subsequent stock default has its own real native drain and never borrows the first choice", async t => {
  const f = await fixture(t), first = deferred(), second = deferred(), ready = await f.arm();
  let count = 0;
  f.hooks.native = (_target, method) => method === "Page.handleJavaScriptDialog" ? (++count === 1 ? first.promise : second.promise) : undefined;
  f.open(); await tick();
  f.backend.handleCdpEvent({ tabId: 7 }, "Page.javascriptDialogClosed");
  f.open(); await tick();
  assert.equal(f.backend.nativeDialogOperations.size, 2);
  first.resolve(); await f.backend.collectDialog(f.handle(ready));
  let detached = false;
  const release = f.backend.detachTab(7).then(() => { detached = true; });
  await tick(); assert.equal(detached, false);
  assert.equal(f.backend.nativeDialogOperations.size, 1);
  second.resolve(); await release;
  assert.deepEqual(f.calls.filter(([method]) => method === "Page.handleJavaScriptDialog").map(value => value[2].accept), [true, false]);
});

test("withdrawal before send defaults the exact original dialog once, never the requested accept", async t => {
  const f = await fixture(t), ready = await f.arm(), gate = deferred();
  f.hooks.query = () => gate.promise;
  f.open(); await tick();
  let done = false;
  const cancelled = f.backend.dialogs.cancel(f.handle(ready)).then(() => { done = true; });
  await tick(); assert.equal(done, false);
  f.hooks.query = undefined; gate.resolve(); await cancelled;
  assert.deepEqual(f.calls.filter(([method]) => method === "Page.handleJavaScriptDialog").map(value => value[2].accept), [false]);
});

test("closed then replaced native dialog cannot receive the queued original choice", async t => {
  const f = await fixture(t), ready = await f.arm(), gate = deferred();
  f.hooks.query = () => gate.promise;
  f.open(); await tick();
  f.backend.handleCdpEvent({ tabId: 7 }, "Page.javascriptDialogClosed");
  f.backend.handleCdpEvent({ tabId: 7 }, "Page.javascriptDialogOpening", { type: "confirm" });
  f.hooks.query = undefined; gate.resolve();
  await assert.rejects(f.backend.collectDialog(f.handle(ready)), /OBU_DIALOG_EXPIRED/);
  assert.equal(f.calls.filter(([method]) => method === "Page.handleJavaScriptDialog").length, 0);
});

test("native rejection stays blocked until positive original closure, without replay on explicit cleanup", async t => {
  const f = await fixture(t), ready = await f.arm();
  f.hooks.native = (_target, method) => { if (method === "Page.handleJavaScriptDialog") throw new Error("actual native rejection"); };
  f.open(); await assert.rejects(f.backend.collectDialog(f.handle(ready)), /OBU_DIALOG_FAILED/);
  await assert.rejects(f.arm(), /OBU_DIALOG_BUSY/);
  await assert.rejects(f.backend.dialogs.cancel(f.handle(ready)), /OBU_DIALOG_FAILED/);
  f.backend.handleCdpEvent({ tabId: 7 }, "Page.javascriptDialogClosed");
  await f.backend.dialogs.cancel(f.handle(ready));
  await f.backend.drainNativeDialogResponses(7, f.backend.attachmentEpochs.get(7));
  assert.equal(f.backend.nativeDialogOperations.size, 0);
  const next = await f.arm(); await f.backend.cancelDialog(f.handle(next));
  assert.equal(f.calls.filter(([method]) => method === "Page.handleJavaScriptDialog").length, 1);
});

test("foreign scopes cannot collect/cancel and ordinary beforeunload decision survives requested navigation", async t => {
  const f = await fixture(t), ready = await f.arm({ type: "beforeunload", accept: false });
  await assert.rejects(f.backend.collectDialog({ ...f.otherParams, dialogId: ready.dialogId }), /is not part of browser session/);
  f.backend.handleCdpEvent({ tabId: 7 }, "Page.frameRequestedNavigation", { frameId: "root" });
  f.open("beforeunload");
  assert.equal((await f.backend.collectDialog(f.handle(ready))).accepted, false);
});
