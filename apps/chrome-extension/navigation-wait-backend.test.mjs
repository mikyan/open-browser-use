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

async function fixture(t) {
  const storage = {}, calls = [], tabs = new Map([[7, { id: 7, groupId: 10, windowId: 1, url: "https://fixture.test" }]]), pages = new Map();
  const hooks = {};
  const chrome = {
    storage: { local: {
      async get(key) { return structuredClone(Object.hasOwn(storage, key) ? { [key]: storage[key] } : {}); },
      async set(value) { await hooks.write?.(value); Object.assign(storage, structuredClone(value)); }
    } },
    debugger: { onDetach: event(), onEvent: event(),
      async attach({ tabId }) { calls.push(["raw-attach", tabId]); },
      async detach({ tabId }) { calls.push(["detach", tabId]); },
      async sendCommand(target, method) { calls.push([method, target.tabId]); if (method === "Page.navigate") pages.get(target.tabId)?.emit("navigation"); return {}; }
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
      const page = new EventEmitter();
      page.getByRole = () => ({ click: async () => {
        calls.push(["click", tabId]);
        await hooks.click?.();
        page.emit("navigation");
      } });
      pages.set(tabId, page);
      return page;
    },
    async detach(tabId) { pages.get(tabId)?.emit("close"); pages.delete(tabId); calls.push(["engine-detach", tabId]); }
  };
  const runtime = { createOpenBrowserUseNavigationWait(page, options) {
    const ready = deferred(); let resolve, reject, cancelled;
    const result = new Promise((yes, no) => { resolve = yes; reject = no; }); result.catch(() => {});
    const cleanup = () => { page.off("navigation", finish); page.off("close", close); };
    const finish = () => { cleanup(); resolve(); };
    const close = () => cancel(new Error("native page closed"));
    const cancel = error => { if (cancelled) return; cancelled = error; cleanup(); reject(error); };
    (async () => {
      await hooks.listen?.();
      if (cancelled) throw cancelled;
      page.on("navigation", finish); page.on("close", close);
      calls.push(["listening", 7]); ready.resolve();
      if (options.event === "loadstate") finish();
    })().catch(error => { cancel(error); ready.resolve(); });
    return { ready: ready.promise, result, cancel };
  }, crx: { start: async () => app }, setOpenBrowserUseCommandObserver() {}, setOpenBrowserUseEventFilter() {}, setOpenBrowserUseInputHooks() {} };
  const createBrowserActionEngine = options => new BrowserActionEngine({ ...options, loadRuntime: async () => runtime,
    aroundAction: ({ run }) => run() });
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
    hooks.query = hooks.attach = hooks.write = undefined;
    backend.networkWaits.invalidateAll();
    backend.navigationWaits.invalidateAll();
    await Promise.allSettled([...backend.browserEngine?.pages.keys() ?? []].map(id => backend.browserEngine.detach(id)));
    globalThis.chrome = oldChrome;
  });
  const arm = extra => backend.armNavigationWait({ ...params, event: "url", url, timeoutMs: 1000, ...extra });
  const handle = ready => ({ ...params, waiterId: ready.waiterId });
  const click = extra => backend.browserAction({ ...params, action: "click", locator: [{ kind: "role", role: "button", name: "Go" }], timeoutMs: 1000, ...extra });
  const wait = extra => backend.browserAction({ ...params, action: "waitForURL", args: { url }, timeoutMs: 1000, ...extra });
  return { backend, chrome, pages, tabs, calls, hooks, params, otherParams, arm, handle, click, wait };
}

test("direct cold wait reserves readiness before a later click and does not hold the action queue", async t => {
  const f = await fixture(t), gate = deferred(), entered = deferred();
  f.hooks.listen = async () => { entered.resolve(); await gate.promise; };
  const wait = f.wait(), click = f.click();
  await entered.promise;
  assert.equal(f.calls.some(([name]) => name === "click"), false);
  gate.resolve();
  const [result] = await Promise.all([wait, click]);
  assert.equal(result.value, null);
  assert.equal(result.engine.protocolVersion, 1);
  assert.ok(f.calls.findIndex(([name]) => name === "listening") < f.calls.findIndex(([name]) => name === "click"));
  assert.equal(f.backend.navigationWaits.records.size, 0);
});

test("explicit arm migrates a cold raw attachment and yields a ready fixed-scope handle", async t => {
  const f = await fixture(t);
  assert.equal((await f.backend.getInfo()).metadata.navigationWaitVersion, 1);
  await f.backend.attach(f.params);
  const ready = await f.arm();
  assert.ok(ready.remainingMs > 0 && ready.remainingMs <= 1000);
  await f.click();
  assert.equal(Object.keys(await f.backend.collectNavigationWait(f.handle(ready))).length, 0);
  assert.equal(Object.keys(await f.backend.collectNavigationWait(f.handle(ready))).length, 0);
  assert.equal(f.calls.filter(([name]) => name === "click").length, 1);
  await f.backend.cancelNavigationWait(f.handle(ready));
  assert.equal(f.backend.navigationWaits.records.size, 0);
});

test("scope admission latency cannot let a later trigger overtake the waiter", async t => {
  const f = await fixture(t), gate = deferred(), entered = deferred(); let first = true;
  f.hooks.query = async () => { if (first) { first = false; entered.resolve(); await gate.promise; } };
  const wait = f.wait(); await entered.promise;
  const click = f.click(); await tick();
  assert.equal(f.calls.some(([name]) => name === "click"), false);
  gate.resolve(); await Promise.all([wait, click]);
});

test("a later raw CDP trigger also waits for listener readiness", async t => {
  const f = await fixture(t), gate = deferred(), entered = deferred();
  f.hooks.listen = async () => { entered.resolve(); await gate.promise; };
  const wait = f.wait(); await entered.promise;
  f.backend.resolveCdpTarget = async () => ({ tabId: 7 });
  f.backend.validateCdpCommandTarget = async () => {};
  const trigger = f.backend.executeCdp({ ...f.params, method: "Page.navigate", commandParams: { url }, timeoutMs: 1000 });
  await tick(); assert.equal(f.calls.some(([name]) => name === "Page.navigate"), false);
  gate.resolve(); await Promise.all([wait, trigger]);
});

test("pending wait timeout does not detach or cancel an already running click", async t => {
  const f = await fixture(t), gate = deferred(), entered = deferred();
  const ready = await f.arm({ timeoutMs: 40 });
  f.hooks.click = async () => { entered.resolve(); await gate.promise; };
  const click = f.click(); await entered.promise;
  await assert.rejects(f.backend.collectNavigationWait(f.handle(ready)), /OBU_NAVIGATION_WAIT_TIMEOUT/);
  assert.equal(f.backend.attachedTabs.has(7), true);
  assert.equal(f.calls.some(([name]) => name === "engine-detach"), false);
  gate.resolve(); await click;
});

test("a second warm setup timing out cannot detach the existing observer or held control", async t => {
  const f = await fixture(t), gate = deferred();
  const first = await f.arm();
  const token = f.backend.attachmentEpochs.get(7);
  f.hooks.listen = () => gate.promise;
  await assert.rejects(f.arm({ timeoutMs: 20 }), /OBU_NAVIGATION_WAIT_TIMEOUT/);
  gate.resolve(); await tick();
  assert.equal(f.backend.attachmentEpochs.get(7), token);
  assert.equal(f.calls.some(([name]) => name === "engine-detach"), false);
  f.pages.get(7).emit("navigation");
  await f.backend.collectNavigationWait(f.handle(first));
});

test("original deadline precedes controlReady and a late gate cannot install a listener", async t => {
  const f = await fixture(t), gate = deferred(); f.backend.controlReady = gate.promise;
  try {
    const wait = f.wait({ timeoutMs: 20 });
    assert.equal(f.backend.navigationWaits.records.size, 1);
    await assert.rejects(wait, /OBU_NAVIGATION_WAIT_TIMEOUT/);
    gate.resolve(); await tick();
    assert.equal(f.calls.some(([name]) => name === "engine-attach"), false);
  } finally { gate.resolve(); }
});

test("a trigger's own short deadline expires behind setup without late input", async t => {
  const f = await fixture(t), gate = deferred(), entered = deferred();
  f.hooks.listen = async () => { entered.resolve(); await gate.promise; };
  const wait = f.wait(); await entered.promise;
  await assert.rejects(f.click({ timeoutMs: 15 }), /OBU_NAVIGATION_SETUP_TIMEOUT/);
  gate.resolve(); await tick();
  assert.equal(f.calls.some(([name]) => name === "click"), false);
  f.pages.get(7).emit("navigation"); await wait;
});

test("a trigger retains its deadline through admission after listener readiness", async t => {
  const f = await fixture(t), gate = deferred(), entered = deferred();
  f.hooks.listen = async () => { entered.resolve(); await gate.promise; };
  const wait = f.wait(); await entered.promise;
  const original = f.backend.requireSessionTab.bind(f.backend);
  let admissionStarted = false, delayed = false;
  const after = f.backend.runAfterNavigationSetups.bind(f.backend);
  f.backend.runAfterNavigationSetups = (params, setups, handler) => after(params, setups, value => {
    admissionStarted = true;
    return handler(value);
  });
  f.backend.requireSessionTab = async (params, command) => {
    if (command === "browserAction" && admissionStarted && !delayed) {
      delayed = true;
      await new Promise(resolve => setTimeout(resolve, 70));
    }
    return original(params, command);
  };
  const click = assert.rejects(f.click({ timeoutMs: 30 }), /timed out during admission/);
  gate.resolve(); await click;
  assert.equal(delayed, true);
  assert.equal(f.calls.some(([name]) => name === "click"), false);
  assert.equal(f.calls.some(([name]) => name === "engine-detach"), false);
  f.pages.get(7).emit("navigation"); await wait;
});

test("legacy omitted epoch remains compatible for direct waits and cached load success", async t => {
  const f = await fixture(t);
  const wait = f.wait({ control_epoch: undefined });
  await f.click(); await wait;
  const result = await f.backend.browserAction({ ...f.params, control_epoch: undefined, action: "waitForLoadState", args: { state: "load" } });
  assert.equal(result.value, null);
  assert.equal(f.backend.navigationWaits.records.size, 0);
});

test("foreign handles, owner movement, detach and close cannot retain navigation authority", async t => {
  const f = await fixture(t), ready = await f.arm();
  await assert.rejects(f.backend.collectNavigationWait({ ...f.handle(ready), turn_id: "foreign" }), /OBU_NAVIGATION_WAIT_EXPIRED/);
  f.tabs.get(7).groupId = 20; f.chrome.tabs.onUpdated.emit(7, { groupId: 20 });
  assert.equal(f.backend.navigationWaits.records.size, 0);
  const next = await f.backend.armNavigationWait({ ...f.otherParams, event: "url", url, timeoutMs: 1000 });
  await assert.rejects(f.backend.collectNavigationWait({ ...f.otherParams, waiterId: ready.waiterId }), /OBU_NAVIGATION_WAIT_EXPIRED/);
  f.pages.get(7).emit("navigation");
  await f.backend.collectNavigationWait({ ...f.otherParams, waiterId: next.waiterId });
  f.chrome.debugger.onDetach.emit({ tabId: 7 });
  assert.equal(f.backend.navigationWaits.records.size, 0);
});

test("turn end and Pause cancel navigation observers without replay on explicit recovery", async t => {
  const f = await fixture(t), ready = await f.arm();
  const entered = deferred(), collect = f.backend.navigationWaits.collect.bind(f.backend.navigationWaits);
  f.backend.navigationWaits.collect = params => { entered.resolve(); return collect(params); };
  const wait = assert.rejects(f.backend.collectNavigationWait(f.handle(ready)), /OBU_NAVIGATION_WAIT_EXPIRED/);
  await entered.promise;
  await f.backend.turnEnded(f.params); await wait;
  const control = await f.backend.getControlState({ session_id: "task" });
  const scope = { ...f.params, control_epoch: control.controlEpoch, turn_id: "second" };
  const next = await f.backend.armNavigationWait({ ...scope, event: "url", url, timeoutMs: 1000 });
  const waiting = assert.rejects(f.backend.collectNavigationWait({ ...scope, waiterId: next.waiterId }), /OBU_NAVIGATION_WAIT_EXPIRED|PAUSED/);
  assert.equal((await f.backend.pauseAutomation()).state, "paused"); await waiting;
  assert.equal(f.backend.navigationWaits.records.size, 0);
  assert.equal(f.calls.some(([name]) => name === "click"), false);
});
