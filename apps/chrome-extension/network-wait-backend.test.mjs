import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import test from "node:test";
import vm from "./test-support/backend-vm.mjs";
import { BrowserActionEngine } from "./browser-action-engine.js";
import { SITE_ACCESS_POLICY_KEY } from "./site-access-policy.js";

const input = (await readFile(new URL("./browser-input-adapter.js", import.meta.url), "utf8")).replace(/^export /gm, "");
const source = (await readFile(new URL("./background.js", import.meta.url), "utf8"))
  .replace('import { createBrowserActionEngine } from "./browser-runtime.js";', "")
  .replace('import { NativeInputTracker } from "./browser-input-adapter.js";', input);
const code = source.slice(0, source.indexOf("chrome.runtime.onInstalled.addListener"));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const url = "https://fixture.test/api";
const event = () => { const listeners = []; return { addListener: fn => listeners.push(fn), emit: (...args) => listeners.forEach(fn => fn(...args)) }; };
const nativeRequest = (extra = {}) => ({ url: () => url, method: () => "POST", resourceType: () => "fetch", frame: () => ({ url: () => "https://fixture.test" }), redirectedFrom: () => null, ...extra });

async function fixture(t, { restricted = false } = {}) {
  const storage = {}, calls = [], tabs = new Map([[7, { id: 7, groupId: 10, windowId: 1, url: "https://fixture.test" }]]), pages = new Map();
  if (restricted) storage[SITE_ACCESS_POLICY_KEY] = { version: 1, revision: 1, mode: "allow", origins: ["https://fixture.test"] };
  const hooks = {};
  const chrome = {
    storage: { local: {
      async get(key) { return structuredClone(Object.hasOwn(storage, key) ? { [key]: storage[key] } : {}); },
      async set(value) { await hooks.write?.(value); Object.assign(storage, structuredClone(value)); }
    } },
    debugger: { onDetach: event(), onEvent: event(),
      async attach({ tabId }) { calls.push(["raw-attach", tabId]); },
      async detach({ tabId }) { calls.push(["detach", tabId]); },
      async sendCommand(target, method) { calls.push([method, target.tabId]); return {}; }
    },
    tabs: { onRemoved: event(), onUpdated: event(), onDetached: event(), onReplaced: event(),
      async get(id) { return tabs.get(id); },
      async query(filter) { await hooks.query?.(); return [...tabs.values()].filter(tab => filter?.groupId === undefined || tab.groupId === filter.groupId); },
      async sendMessage() { return {}; }
    },
    webNavigation: { onBeforeNavigate: event(), onCommitted: event(), onErrorOccurred: event(), onHistoryStateUpdated: event(), onReferenceFragmentUpdated: event(),
      async getAllFrames() { await hooks.frames?.(); return hooks.frameRows ?? [{ frameId: 0, parentFrameId: -1, url: "https://fixture.test", documentId: "document-root", documentLifecycle: "active", errorOccurred: false }]; } },
    tabGroups: { async update() {} },
    runtime: { id: "fixture", getURL: path => `chrome-extension://fixture/${path}`, getManifest: () => ({ version: "test" }) }
  };
  const app = {
    async attach(tabId) {
      calls.push(["engine-attach", tabId]);
      await hooks.attach?.();
      const page = new EventEmitter();
      page._channel = { async updateSubscription(params) { calls.push(["subscription", structuredClone(params)]); await hooks.subscription?.(params); } };
      page.getByRole = () => ({ click: async () => {
        calls.push(["click", tabId]);
        page.emit("response", { request: () => nativeRequest(), status: () => 200, statusText: () => "OK" });
      } });
      pages.set(tabId, page);
      return page;
    },
    async detach(tabId) { pages.get(tabId)?.emit("close"); pages.delete(tabId); calls.push(["engine-detach", tabId]); }
  };
  const runtime = { crx: { start: async () => app }, setOpenBrowserUseCommandObserver() {}, setOpenBrowserUseEventFilter() {}, setOpenBrowserUseInputHooks() {},
    captureOpenBrowserUseDiagnosticSource() {
      throw new Error("OBU_SITE_ACCESS_UNVERIFIED: fixture does not provide original console or error sources");
    },
    captureOpenBrowserUseNetworkWaitRequest(request) {
      if (request.unproven) throw new Error("OBU_SITE_ACCESS_UNVERIFIED: original request source unavailable");
      const document = hooks.document;
      return { frameUrl: "https://fixture.test", urls: request.sourceUrls ?? [request.url(), "https://fixture.test"], check() {
        if (hooks.document !== document) throw new Error("OBU_SITE_ACCESS_UNVERIFIED: original request document changed");
      } };
    } };
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
    for (const key of Object.keys(hooks)) delete hooks[key];
    backend.networkWaits.invalidateAll();
    await Promise.allSettled([...backend.browserEngine?.pages.keys() ?? []].map(id => backend.browserEngine.detach(id)));
    globalThis.chrome = oldChrome;
  });
  const arm = extra => backend.armNetworkWait({ ...params, event: "response", match: { url }, timeoutMs: 1000, ...extra });
  const handle = ready => ({ ...params, waiterId: ready.waiterId });
  return { backend, chrome, pages, tabs, calls, hooks, params, otherParams, arm, handle };
}

test("cold network arm shares the action Page after raw migration and releases the action queue", async t => {
  const f = await fixture(t);
  assert.equal((await f.backend.getInfo()).metadata.networkWaitVersion, 1);
  await f.backend.attach(f.params);
  const ready = await f.arm();
  assert.ok(ready.remainingMs > 0 && ready.remainingMs <= 1000);
  assert.equal(f.pages.get(7).listenerCount("response"), 1);
  await f.backend.browserAction({ ...f.params, action: "click", locator: [{ kind: "role", role: "button", name: "Save" }] });
  const result = await f.backend.collectNetworkWait(f.handle(ready));
  assert.equal(result.status, 200);
  assert.equal(result.method, "POST");
  assert.deepEqual(await f.backend.collectNetworkWait(f.handle(ready)), result);
  assert.equal(f.calls.filter(([name]) => name === "click").length, 1);
  assert.equal(f.calls.filter(([name]) => name === "engine-attach").length, 1);
});

test("restricted allowed network wait is ready before its one original trusted task trigger", async t => {
  const f = await fixture(t, { restricted: true });
  const ready = await f.arm();
  assert.ok(ready.remainingMs > 0 && ready.remainingMs <= 1000);
  await f.backend.browserAction({ ...f.params, action: "click", locator: [{ kind: "role", role: "button", name: "Save" }] });
  const result = await f.backend.collectNetworkWait(f.handle(ready));
  assert.equal(result.status, 200); assert.equal(result.url, url);
  assert.equal(f.calls.filter(([name]) => name === "click").length, 1);
  await f.backend.cancelNetworkWait(f.handle(ready));
});

test("network cancel drains the original waiter without reading an unavailable document tree", async t => {
  const f = await fixture(t), ready = await f.arm();
  let inspections = 0;
  f.backend.assertSiteTab = async () => { inspections++; throw new Error("OBU_SITE_ACCESS_UNVERIFIED: document inspection unavailable"); };
  assert.deepEqual(await f.backend.cancelNetworkWait(f.handle(ready)), {});
  assert.equal(inspections, 0);
  assert.equal(f.backend.networkWaits.records.size, 0);
  assert.equal(f.pages.get(7).listenerCount("response"), 0);
});

test("restricted first candidate validates request, emitter and every original redirect source", async t => {
  const f = await fixture(t, { restricted: true });
  for (const sources of [["https://denied.test/api"], [url, "https://denied.test/source"], [url, "https://fixture.test", "https://denied.test/redirect"]]) {
    const ready = await f.arm();
    f.pages.get(7).emit("response", { request: () => nativeRequest({ sourceUrls: sources }), status: () => 200, statusText: () => "OK" });
    await assert.rejects(f.backend.collectNetworkWait(f.handle(ready)), /^Error: OBU_SITE_ACCESS_DENIED:/);
    await f.backend.cancelNetworkWait(f.handle(ready));
    assert.equal(f.backend.siteRevokedTabs.has(7), false, "a denied data candidate is not a website traffic firewall");
  }
});

test("unmatched denied requests are ignored; missing original source proof is terminal", async t => {
  const f = await fixture(t, { restricted: true }), ready = await f.arm();
  f.pages.get(7).emit("response", { request: () => nativeRequest({ url: () => "https://denied.test/unmatched", unproven: true }), status: () => 200 });
  assert.equal([...f.backend.networkWaits.records.values()][0].state, "pending");
  f.pages.get(7).emit("response", { request: () => nativeRequest({ unproven: true }), status: () => 200 });
  await assert.rejects(f.backend.collectNetworkWait(f.handle(ready)), /OBU_SITE_ACCESS_UNVERIFIED/);
});

test("matched original request proof can refresh an allowed navigation snapshot before collection", async t => {
  for (const frameId of [0, 1]) {
    const f = await fixture(t, { restricted: true }), ready = await f.arm();
    const destination = "https://fixture.test/next";
    f.backend.onSiteNavigation({ tabId: 7, frameId, url: destination }, "pending");
    const request = nativeRequest({ resourceType: () => frameId === 0 ? "document" : "fetch" });
    f.pages.get(7).emit("response", { request: () => request, status: () => 200, statusText: () => "OK" });
    await tick();
    const record = f.backend.networkWaits.records.get(ready.waiterId);
    assert.equal(record.state, "matched");
    const originalCandidate = record.candidate;
    const before = f.backend.siteNavigationVersions.get(7);
    const root = { frameId: 0, parentFrameId: -1, url: "https://fixture.test", documentId: "document-root", documentLifecycle: "active", errorOccurred: false };
    f.hooks.frameRows = frameId === 0
      ? [{ ...root, url: destination, documentId: "navigation-loader" }]
      : [root, { ...root, frameId: 1, parentFrameId: 0, url: destination, documentId: "child-loader" }];
    if (frameId === 0) f.tabs.get(7).url = destination;
    f.backend.onSiteNavigation({ tabId: 7, frameId, url: destination }, "committed");
    assert.equal(f.backend.siteNavigationVersions.get(7), before + 1);
    // The pinned bridge separately proves a navigation's original loader can
    // become current, or an unrelated child can commit without changing fetch.
    // This backend seam retains that same original proof across the snapshot.
    originalCandidate.check();
    assert.equal((await f.backend.collectNetworkWait(f.handle(ready))).status, 200);
    assert.equal(record.candidate, originalCandidate);
    await f.backend.cancelNetworkWait(f.handle(ready));
  }
});

test("selected original document and policy are rechecked after pending unsubscribe ACK", async t => {
  const f = await fixture(t, { restricted: true });
  for (const mutate of [() => { f.hooks.document = "successor"; }, () => { f.backend.siteAccess.value.revision++; },
    () => f.backend.onSiteNavigation({ tabId: 7, frameId: 1, url: "https://fixture.test/child" }, "committed")]) {
    const gate = deferred(), ready = await f.arm(); let done = false;
    f.hooks.subscription = ({ enabled }) => enabled ? undefined : gate.promise;
    f.pages.get(7).emit("response", { request: () => nativeRequest(), status: () => 200, statusText: () => "OK" });
    const collecting = f.backend.collectNetworkWait(f.handle(ready)).then(value => { done = true; return value; }); collecting.catch(() => {});
    await tick(); assert.equal(done, false); mutate(); gate.resolve();
    await assert.rejects(collecting, /OBU_SITE_ACCESS_UNVERIFIED/);
    f.hooks.subscription = undefined;
    await f.backend.cancelNetworkWait(f.handle(ready));
  }
});

test("Pause and turn end retain actual network cleanup ACK after listeners are synchronously removed", async t => {
  for (const operation of ["pause", "end"]) {
    const f = await fixture(t), gate = deferred(), ready = await f.arm(); let done = false;
    f.hooks.subscription = ({ enabled }) => enabled ? undefined : gate.promise;
    const finish = (operation === "pause" ? f.backend.pauseAutomation() : f.backend.turnEnded(f.params)).then(value => { done = true; return value; });
    await tick(); assert.equal(done, false); assert.equal(f.pages.get(7).listenerCount("response"), 0);
    assert.equal(f.calls.some(([method]) => method === "engine-detach"), false);
    gate.resolve(); await finish;
    assert.equal(f.backend.networkWaits.cleanups.size, 0);
    await assert.rejects(f.backend.networkWaits.collect(f.handle(ready)), /EXPIRED/);
  }
});

test("arm expiry cannot let Pause release the Page while its original enable or disable ACK is pending", async t => {
  const f = await fixture(t), enable = deferred(), disable = deferred(), entered = deferred();
  const flush = () => new Promise(resolve => setImmediate(resolve));
  const timers = new Set(); let now = 1000;
  t.mock.method(performance, "now", () => now);
  t.mock.method(globalThis, "setTimeout", (callback, delay) => {
    const timer = { callback, delay, source: new Error().stack }; timers.add(timer); return timer;
  });
  t.mock.method(globalThis, "clearTimeout", timer => timers.delete(timer));
  f.hooks.subscription = ({ enabled }) => { if (enabled) { entered.resolve(); return enable.promise; } return disable.promise; };
  const arming = f.arm({ timeoutMs: 35 }).then(value => ({ value }), error => ({ error }));
  try {
    await entered.promise;
    // Both timers have the same deadline. Deliberately dispatch the engine's
    // timer first, preserving the registry's still-pending original ACKs.
    const engineTimers = [...timers].filter(timer => timer.source.split("\n")
      .find(line => /browser-(?:action-engine|network-waits)\.js/.test(line))?.includes("browser-action-engine.js"));
    assert.equal(engineTimers.length, 1); now = 1035;
    timers.delete(engineTimers[0]); engineTimers[0].callback();
    await flush(); assert.match((await arming).error?.message ?? "", /^OBU_NETWORK_WAIT_TIMEOUT:/);
    assert.equal(f.calls.some(([method]) => method === "engine-detach"), false);
    let done = false;
    const pause = f.backend.pauseAutomation().then(value => { done = true; return value; });
    await flush(); assert.equal(done, false); assert.ok(f.backend.networkWaits.controlSnapshot().pending.length);
    enable.resolve(); await flush(); assert.equal(done, false);
    assert.equal(f.calls.some(([method]) => method === "engine-detach"), false);
    disable.resolve(); assert.equal((await pause).cleanupComplete, true);
  } finally { enable.resolve(); disable.resolve(); await arming; await flush(); t.mock.restoreAll(); }
});

test("entry deadline and capacity reservation precede a delayed controlReady and cannot arm late", async t => {
  const f = await fixture(t), gate = deferred();
  f.backend.controlReady = gate.promise;
  try {
    const pending = f.arm({ timeoutMs: 20 });
    assert.equal(f.backend.networkWaits.records.size, 1);
    assert.equal([...f.backend.networkWaits.records.values()][0].scope, undefined);
    const snapshot = f.backend.globalControlSnapshot();
    assert.deepEqual([...snapshot.tabIds], []);
    assert.ok(snapshot.pending.length > 0);
    await assert.rejects(pending, /OBU_NETWORK_WAIT_TIMEOUT/);
    assert.equal(f.backend.networkWaits.records.size, 0);
    gate.resolve();
    await tick();
    assert.equal(f.calls.some(([name]) => name === "engine-attach"), false);
  } finally { gate.resolve(); }
});

test("invalid input does not reserve or wait for worker recovery", async t => {
  const f = await fixture(t), gate = deferred();
  f.backend.controlReady = gate.promise;
  try {
    await assert.rejects(f.arm({ match: { url, predicate: "anything" } }), /does not support/);
    assert.equal(f.backend.networkWaits.records.size, 0);
  } finally { gate.resolve(); }
});

test("an expired cold attachment cannot register late or detach its successor", async t => {
  const f = await fixture(t), entered = deferred(), gate = deferred();
  let first = true;
  f.hooks.attach = async () => { if (first) { first = false; entered.resolve(); await gate.promise; } };
  const old = assert.rejects(f.arm({ timeoutMs: 30 }), /OBU_NETWORK_WAIT_TIMEOUT/);
  await entered.promise;
  await old;
  const next = f.arm({ timeoutMs: 1000 });
  gate.resolve();
  const ready = await next;
  assert.equal(f.backend.networkWaits.records.size, 1);
  f.pages.get(7).emit("response", { request: () => nativeRequest(), status: () => 201, statusText: () => "Created" });
  assert.equal((await f.backend.collectNetworkWait(f.handle(ready))).status, 201);
  assert.equal(f.backend.attachedTabs.has(7), true);
});

test("network scope survives only its original owner, epoch and attachment", async t => {
  const f = await fixture(t), ready = await f.arm();
  await assert.rejects(f.backend.collectNetworkWait({ ...f.handle(ready), turn_id: "foreign" }), /OBU_NETWORK_WAIT_EXPIRED/);
  f.tabs.get(7).groupId = 20;
  f.chrome.tabs.onUpdated.emit(7, { groupId: 20 });
  assert.equal(f.backend.networkWaits.records.size, 0);
  const successor = await f.backend.armNetworkWait({ ...f.otherParams, event: "request", match: { url }, timeoutMs: 1000 });
  assert.equal(f.backend.networkWaits.records.size, 1);
  await assert.rejects(f.backend.collectNetworkWait({ ...f.otherParams, waiterId: ready.waiterId }), /OBU_NETWORK_WAIT_EXPIRED/);
  f.pages.get(7).emit("request", nativeRequest());
  assert.equal((await f.backend.collectNetworkWait({ ...f.otherParams, waiterId: successor.waiterId })).url, url);
});

test("pause cancels a reserved arm before controlReady without waiting for that gate", async t => {
  const f = await fixture(t), gate = deferred();
  f.backend.controlReady = gate.promise;
  const pending = assert.rejects(f.arm(), /OBU_NETWORK_WAIT_EXPIRED/);
  const paused = await f.backend.pauseAutomation();
  assert.equal(paused.state, "paused");
  await pending;
  gate.resolve();
  await tick();
  assert.equal(f.backend.networkWaits.records.size, 0);
  assert.equal(f.calls.some(([name]) => name === "engine-attach"), false);
});

test("control end retires pending collect before its durable state write finishes", async t => {
  const f = await fixture(t), ready = await f.arm(), gate = deferred(), entered = deferred();
  const pending = assert.rejects(f.backend.collectNetworkWait(f.handle(ready)), /OBU_NETWORK_WAIT_EXPIRED/);
  await tick();
  f.hooks.write = async value => {
    if (Object.hasOwn(value, "OPEN_BROWSER_USE_CONTROL_STATE")) { entered.resolve(); await gate.promise; }
  };
  const ending = f.backend.turnEnded(f.params);
  await entered.promise;
  await pending;
  assert.equal(f.backend.networkWaits.records.size, 0);
  gate.resolve();
  await ending;
});

test("external detach, close and window moves invalidate active handles", async t => {
  const f = await fixture(t);
  for (const change of [() => f.chrome.tabs.onDetached.emit(7, {}), () => f.chrome.debugger.onDetach.emit({ tabId: 7 }), () => f.chrome.tabs.onRemoved.emit(7, {})]) {
    const ready = await f.arm();
    change();
    await assert.rejects(f.backend.collectNetworkWait(f.handle(ready)), /OBU_NETWORK_WAIT_EXPIRED/);
    assert.equal(f.backend.networkWaits.records.size, 0);
  }
});
