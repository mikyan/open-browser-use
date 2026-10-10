import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "./test-support/backend-vm.mjs";
import { SITE_ACCESS_POLICY_KEY } from "./site-access-policy.js";

const input = (await readFile(new URL("./browser-input-adapter.js", import.meta.url), "utf8")).replace(/^export /gm, "");
const source = (await readFile(new URL("./background.js", import.meta.url), "utf8"))
  .replace('import { createBrowserActionEngine } from "./browser-runtime.js";', "")
  .replace('import { NativeInputTracker } from "./browser-input-adapter.js";', input);
const code = source.slice(0, source.indexOf("chrome.runtime.onInstalled.addListener"));
const popupCode = source.slice(source.indexOf("async function handleSiteAccessMessage"), source.indexOf("chrome.runtime.onMessage.addListener"));
const AUTOMATION_KEY = "OPEN_BROWSER_USE_AUTOMATION_CONTROL";
const clone = value => structuredClone(value);
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const event = () => { const callbacks = new Set(); return { addListener: fn => callbacks.add(fn), removeListener: fn => callbacks.delete(fn), emit: (...args) => { for (const callback of callbacks) callback(...args); } }; };
const config = (mode = "allow", origins = ["https://allowed.test"]) => ({ mode, origins });
const policyState = (mode = "allow", origins = ["https://allowed.test"]) => ({ version: 1, revision: 1, mode, origins });
const frame = (url = "https://allowed.test/page", frameId = 0, parentFrameId = -1) => ({ frameId, parentFrameId, url, errorOccurred: false, documentLifecycle: "active" });

async function fixture(t, { policy, createBrowserActionEngine, automationCleanupTimeoutMs } = {}) {
  const state = policy === undefined ? {} : { [SITE_ACCESS_POLICY_KEY]: clone(policy) };
  const calls = [], hooks = {}, attached = new Set(), gates = [];
  const tabs = new Map([[7, { id: 7, groupId: 10, windowId: 1, url: "https://allowed.test/page", title: "Allowed", active: false }],
    [8, { id: 8, groupId: 10, windowId: 1, url: "https://denied.test/private", title: "Denied", active: false }]]);
  const frames = new Map([[7, [frame()]], [8, [frame("https://denied.test/private")]]]);
  const getTab = id => { if (!tabs.has(id)) throw new Error(`No tab with id: ${id}`); return tabs.get(id); };
  const chrome = {
    storage: { local: {
      async get(key) { await hooks.read?.(key); return Object.hasOwn(state, key) ? { [key]: clone(state[key]) } : {}; },
      async set(value) { await hooks.write?.(value); Object.assign(state, clone(value)); calls.push(["storage.set", Object.keys(value)[0]]); },
      async setAccessLevel(value) { calls.push(["storage.access", clone(value)]); }
    } },
    debugger: { onDetach: event(), onEvent: event(),
      async attach({ tabId }) { calls.push(["attach-start", tabId]); await hooks.attach?.(tabId); getTab(tabId); attached.add(tabId); calls.push(["attach", tabId]); },
      async detach({ tabId }) { await hooks.detach?.(tabId); attached.delete(tabId); calls.push(["detach", tabId]); },
      async sendCommand(target, method, params) { calls.push(["command", target.tabId, method, clone(params)]); await hooks.command?.(target, method, params); return {}; }
    },
    tabs: { onRemoved: event(), onUpdated: event(), onDetached: event(), onReplaced: event(),
      async get(id) { await hooks.getTab?.(id); return clone(getTab(id)); },
      async query(filter = {}) { return [...tabs.values()].filter(tab => filter.groupId === undefined || tab.groupId === filter.groupId).map(clone); },
      async sendMessage(id, message) { calls.push(["message", id, message.type]); return { ok: true }; },
      async remove() { throw new Error("Policy update must not close user tabs"); },
      async ungroup() { throw new Error("Policy update must not ungroup user tabs"); }
    },
    webNavigation: { onBeforeNavigate: event(), onCommitted: event(), onErrorOccurred: event(), onHistoryStateUpdated: event(), onReferenceFragmentUpdated: event(),
      async getAllFrames({ tabId }) { await hooks.frames?.(tabId); return clone(frames.get(tabId)); } },
    tabGroups: { async get(id) { return { id, title: "Task" }; }, async update() {}, async query() { return []; } },
    history: { async search() { calls.push(["history"]); return [...tabs.values()].map(tab => ({ id: String(tab.id), url: tab.url, title: tab.title, lastVisitTime: Date.now() })); } },
    runtime: { id: "fixture", getURL: path => `chrome-extension://fixture/${path}`, getManifest: () => ({ version: "test" }),
      async getContexts() { return [{ contextType: "POPUP", documentUrl: "chrome-extension://fixture/popup.html", documentId: "live-popup" }]; } }
  };
  const context = { chrome, crypto, Date, URL, setTimeout, clearTimeout, createBrowserActionEngine };
  const Backend = vm.runInNewContext(`${code}\nBrowserBackend`, context);
  const backend = new Backend({ automationCleanupTimeoutMs }); await backend.controlReady;
  const session = await backend.store.getSession("task"); session.chromeGroupId = 10; session.tabOrigins = { 7: "agent", 8: "user" }; await backend.store.save();
  const current = await backend.getControlState({ session_id: "task" });
  const params = { session_id: "task", turn_id: "turn", control_epoch: current.controlEpoch, tabId: 7 };
  t.after(async () => {
    for (const gate of gates) gate.resolve();
    for (const key of Object.keys(hooks)) delete hooks[key];
    backend.networkWaits.invalidateAll(); backend.navigationWaits.invalidateAll();
    await Promise.allSettled([...backend.attachedTabs].map(id => backend.detachTab(id)));
  });
  return { backend, Backend, chrome, context, state, calls, hooks, attached, tabs, frames, params,
    gate() { const gate = deferred(); gates.push(gate); return gate; } };
}

test("applying a policy immediately pauses existing control, retires epochs and stays paused after saving", async t => {
  const f = await fixture(t); await f.backend.attach(f.params);
  const saving = f.backend.setSiteAccessPolicy(config(), 0);
  assert.equal(f.backend.automationControl.inputBlocked, true);
  await assert.rejects(f.backend.executeCdp({ ...f.params, target: { tabId: 7 }, method: "Runtime.evaluate" }), /OBU_AUTOMATION_PAUSED/);
  const policy = await saving;
  assert.equal(policy.mode, "allow"); assert.equal(policy.revision, 1); assert.equal(f.attached.size, 0);
  assert.equal(f.state[AUTOMATION_KEY].paused, true);
  assert.equal(f.state[SITE_ACCESS_POLICY_KEY].mode, "allow");
  const paused = await f.backend.getAutomationControlStatus(); assert.equal(paused.state, "paused");
  await f.backend.resumeAutomation(paused.revision);
  await assert.rejects(f.backend.attach(f.params), /OBU_STALE_CONTROL_EPOCH/);
  const next = await f.backend.getControlState({ session_id: "task" });
  await f.backend.attach({ ...f.params, control_epoch: next.controlEpoch, turn_id: next.nextTurnId });
  assert.equal(f.attached.has(7), true);
});

test("policy persistence failure keeps control paused and prevents resume", async t => {
  const f = await fixture(t); await f.backend.attach(f.params);
  f.hooks.write = async value => { if (value[SITE_ACCESS_POLICY_KEY]) throw new Error("quota"); };
  await assert.rejects(f.backend.setSiteAccessPolicy(config(), 0), /OBU_SITE_ACCESS_UNAVAILABLE/);
  assert.equal(f.backend.siteAccess.status().ready, false); assert.equal(f.attached.size, 0);
  const paused = await f.backend.getAutomationControlStatus(); assert.equal(paused.inputBlocked, true);
  await assert.rejects(f.backend.resumeAutomation(paused.revision), /OBU_SITE_ACCESS_UNAVAILABLE/);
  assert.equal(f.state[AUTOMATION_KEY].paused, true);
});

test("pending policy write cannot be overtaken by Resume and worker recovery keeps the durable pause", async t => {
  const f = await fixture(t), writing = f.gate(), entered = f.gate();
  f.hooks.write = async value => { if (value[SITE_ACCESS_POLICY_KEY]) { entered.resolve(); await writing.promise; } };
  const saving = f.backend.setSiteAccessPolicy(config(), 0); await entered.promise;
  const paused = await f.backend.getAutomationControlStatus();
  await assert.rejects(f.backend.resumeAutomation(paused.revision), /OBU_SITE_ACCESS_BUSY|OBU_SITE_ACCESS_UNAVAILABLE/);
  assert.equal(f.backend.automationControl.inputBlocked, true);
  writing.resolve(); await saving; delete f.hooks.write;
  const restarted = new f.Backend(); await restarted.controlReady;
  assert.equal((await restarted.getSiteAccessPolicy()).mode, "allow");
  assert.equal((await restarted.getAutomationControlStatus()).state, "paused");
  await assert.rejects(restarted.attach(f.params), /OBU_AUTOMATION_PAUSED/);
});

test("a stuck policy status read returns bounded safe status without changing global pause", async t => {
  const f = await fixture(t, { automationCleanupTimeoutMs: 20 }), reading = f.gate();
  f.hooks.read = async key => { if (key === SITE_ACCESS_POLICY_KEY) await reading.promise; };
  const backend = new f.Backend({ automationCleanupTimeoutMs: 20 });
  const result = await backend.getSiteAccessPolicy();
  assert.equal(result.ready, false); assert.match(result.error, /^OBU_SITE_ACCESS_UNAVAILABLE:/);
  assert.equal(backend.automationControl.inputBlocked, false);
  assert.equal(backend.siteAccess.allowsUrl("https://allowed.test"), false);
  reading.resolve(); await backend.controlReady;
  assert.equal((await backend.getSiteAccessPolicy()).ready, true);
});

test("policy write timeout keeps the update token until the real write settles and never resumes", async t => {
  for (const fail of [false, true]) {
    const f = await fixture(t, { automationCleanupTimeoutMs: 20 }), writing = f.gate(), entered = f.gate();
    f.hooks.write = async value => { if (value[SITE_ACCESS_POLICY_KEY]) { entered.resolve(); await writing.promise; if (fail) throw new Error("late failure"); } };
    const saving = f.backend.setSiteAccessPolicy(config(), 0);
    const rejected = assert.rejects(saving, /OBU_SITE_ACCESS_UNAVAILABLE.*unconfirmed/);
    await entered.promise; await rejected;
    assert.ok(f.backend.sitePolicyUpdate); assert.equal(f.backend.siteAccess.status().ready, false);
    assert.equal(f.backend.automationControl.inputBlocked, true);
    const paused = await f.backend.getAutomationControlStatus();
    await assert.rejects(f.backend.resumeAutomation(paused.revision), /OBU_SITE_ACCESS_BUSY|OBU_SITE_ACCESS_UNAVAILABLE/);
    writing.resolve(); await f.backend.siteAccess.writes.catch(() => {});
    // Await the real replace continuation/finally without sleeping or relying
    // on the rejected UI response to mean the native write was canceled.
    await Promise.resolve(); await Promise.resolve();
    assert.equal(f.backend.sitePolicyUpdate, null);
    assert.equal(f.backend.automationControl.inputBlocked, true);
    assert.equal(f.backend.siteAccess.status().ready, !fail);
    assert.equal(f.state[AUTOMATION_KEY].paused, true);
  }
});

test("blocked top-level and embedded documents are rejected before debugger attachment", async t => {
  const f = await fixture(t, { policy: policyState() });
  await assert.rejects(f.backend.attach({ ...f.params, tabId: 8 }), /OBU_SITE_ACCESS_DENIED/);
  f.frames.get(7).push(frame("https://denied.test/frame", 2, 0));
  await assert.rejects(f.backend.attach(f.params), /OBU_SITE_ACCESS_DENIED/);
  assert.equal(f.calls.some(([name]) => name === "attach-start"), false);
  f.frames.set(7, [frame(), frame("about:srcdoc", 2, 0)]);
  await f.backend.attach(f.params); assert.equal(f.attached.has(7), true);
});

test("restricted unsafe channels fail before native commands or page messages execute", async t => {
  const f = await fixture(t, { policy: policyState() }), before = f.calls.length;
  for (const [method, extra] of [
    ["executeCdp", { target: { tabId: 7 }, method: "Runtime.evaluate", commandParams: { expression: "sensitive()" } }],
    ["moveMouse", { x: 1, y: 2, waitForArrival: false }],
    ["readClipboardText", {}], ["writeClipboardText", { text: "sensitive" }],
    ["webmcp_list_tools", {}], ["browserAction", { action: "diagnostics" }],
    ["armNetworkWait", { event: "request", match: { url: "https://allowed.test/x" }, timeoutMs: 1000 }]
  ]) await assert.rejects(f.backend[method]({ ...f.params, ...extra }), /OBU_SITE_ACCESS_UNSUPPORTED/);
  assert.equal(f.calls.slice(before).some(([name]) => ["command", "message", "attach-start"].includes(name)), false);
  assert.equal(f.backend.networkWaits.records.size, 0);
});

test("restricted tab and history discovery filters denied current and pending URLs", async t => {
  const f = await fixture(t, { policy: policyState() });
  f.tabs.set(9, { id: 9, groupId: 10, windowId: 1, url: "https://allowed.test/old", pendingUrl: "https://denied.test/new" });
  assert.deepEqual(Array.from(await f.backend.getTabs(f.params), tab => tab.id), [7]);
  assert.deepEqual(Array.from(await f.backend.getUserTabs(f.params), tab => tab.id), [7]);
  const history = await f.backend.getUserHistory({ ...f.params, query: "" });
  assert.ok(history.every(entry => entry.url.startsWith("https://allowed.test/"))); assert.equal(history.some(entry => entry.url.includes("denied")), false);
});

test("default all mode preserves legacy empty tab listings", async t => {
  const f = await fixture(t); f.tabs.get(7).url = undefined;
  const tabs = await f.backend.getTabs(f.params);
  assert.ok(tabs.some(tab => tab.id === 7)); assert.ok(tabs.some(tab => tab.id === 8));
});

test("pending forbidden navigation synchronously invalidates waits and prevents later native input", async t => {
  let hooks;
  const engine = { async detach() {}, controlSnapshot: () => ({ tabIds: [], pending: [] }), pages: new Map(), queues: new Map() };
  const f = await fixture(t, { policy: policyState(), createBrowserActionEngine: options => { hooks = options; return engine; } });
  await f.backend.attach(f.params); await f.backend.getBrowserEngine();
  const completion = f.gate(); let cancelled = false;
  const record = f.backend.navigationWaits.reserve({ ...f.params, event: "url", url: "https://allowed.test/next", timeoutMs: 1000 });
  await f.backend.navigationWaits.arm(record, { ready: Promise.resolve(), result: completion.promise, cancel(error) { cancelled = true; completion.reject(error); } }, f.backend.attachmentOwners.get(7), scope => f.backend.validateTransferScope(scope));
  f.chrome.webNavigation.onBeforeNavigate.emit({ tabId: 7, frameId: 0, url: "https://denied.test/new" });
  assert.equal(cancelled, true);
  let delivered = false;
  await assert.rejects(Promise.resolve().then(() => hooks.inputHooks.send({ tabId: 7 }, "Input.dispatchMouseEvent", { type: "mousePressed", button: "left", x: 1, y: 2 }, async () => { delivered = true; })), /OBU_SITE_ACCESS_DENIED|OBU_INPUT_|cancelled/);
  assert.equal(delivered, false);
  await Promise.allSettled([...f.backend.controlReleases.values()]); assert.equal(f.attached.has(7), false);
});

test("native hook rechecks document generation when a frame lookup overlaps navigation", async t => {
  let hooks;
  const engine = { async detach() {}, controlSnapshot: () => ({ tabIds: [], pending: [] }), pages: new Map(), queues: new Map() };
  const f = await fixture(t, { policy: policyState(), createBrowserActionEngine: options => { hooks = options; return engine; } });
  await f.backend.attach(f.params); await f.backend.getBrowserEngine();
  const queried = f.gate(), reading = f.gate();
  f.hooks.frames = async () => { queried.resolve(); await reading.promise; };
  let delivered = false;
  const command = hooks.inputHooks.send({ tabId: 7 }, "Runtime.callFunctionOn", {}, async () => { delivered = true; });
  const rejected = assert.rejects(command, /OBU_SITE_ACCESS_DENIED|OBU_SITE_ACCESS_UNVERIFIED|OBU_INPUT_/);
  await queried.promise;
  f.chrome.webNavigation.onBeforeNavigate.emit({ tabId: 7, frameId: 2, url: "https://denied.test/new-frame" });
  reading.resolve(); await rejected; assert.equal(delivered, false);
});

test("root about:blank navigation revokes an in-flight input attachment before another input can start", async t => {
  let hooks;
  const engine = { async detach() {}, controlSnapshot: () => ({ tabIds: [], pending: [] }), pages: new Map(), queues: new Map() };
  const f = await fixture(t, { policy: policyState(), createBrowserActionEngine: options => { hooks = options; return engine; } });
  await f.backend.attach(f.params); await f.backend.getBrowserEngine();
  const entered = f.gate(), nativeCompletion = f.gate();
  let sends = 0;
  const first = hooks.inputHooks.send({ tabId: 7 }, "Input.dispatchMouseEvent", { type: "mouseMoved", button: "none", buttons: 0, x: 1, y: 2 }, () => {
    sends++; entered.resolve(); return nativeCompletion.promise;
  });
  await entered.promise;
  f.chrome.webNavigation.onBeforeNavigate.emit({ tabId: 7, frameId: 0, url: "about:blank" });
  assert.equal(f.backend.siteRevokedTabs.has(7), true);
  await assert.rejects(Promise.resolve().then(() => hooks.inputHooks.send({ tabId: 7 }, "Input.dispatchMouseEvent", { type: "mousePressed", button: "left", x: 1, y: 2 }, async () => { sends++; })), /OBU_SITE_ACCESS_DENIED|OBU_INPUT_/);
  assert.equal(sends, 1);
  // Already delivered input is not rolled back. Cleanup must follow its actual
  // native settlement, and must never replay the input rejected above.
  assert.equal(f.attached.has(7), true);
  nativeCompletion.resolve(); await first;
  await Promise.allSettled([...f.backend.controlReleases.values()]);
  assert.equal(f.attached.has(7), false); assert.equal(sends, 1);
});

test("native dispatch rejects a navigation-version change in the microtask after document proof resolves", async t => {
  let hooks;
  const engine = { async detach() {}, controlSnapshot: () => ({ tabIds: [], pending: [] }), pages: new Map(), queues: new Map() };
  const f = await fixture(t, { policy: policyState(), createBrowserActionEngine: options => { hooks = options; return engine; } });
  await f.backend.attach(f.params); await f.backend.getBrowserEngine();
  const assertSiteTab = f.backend.assertSiteTab.bind(f.backend);
  f.backend.assertSiteTab = (...args) => assertSiteTab(...args).then(proof => {
    // The next URL is allowed: no revocation or attachment teardown can mask
    // a missing final version check between proof resolution and native send.
    queueMicrotask(() => f.chrome.webNavigation.onBeforeNavigate.emit({ tabId: 7, frameId: 0, url: "https://allowed.test/next" }));
    return proof;
  });
  let delivered = false;
  await assert.rejects(hooks.inputHooks.send({ tabId: 7 }, "Runtime.callFunctionOn", {}, async () => { delivered = true; }), /OBU_SITE_ACCESS_UNVERIFIED/);
  assert.equal(delivered, false);
  assert.equal(f.backend.siteRevokedTabs.has(7), false);
  assert.equal(f.attached.has(7), true);
});

test("only a live action popup may change policy, with exact document identity when supplied", async t => {
  const f = await fixture(t), invoke = vm.runInNewContext(`${popupCode}\nhandleSiteAccessMessage`, { ...f.context, backend: f.backend });
  const sender = { id: "fixture", url: "chrome-extension://fixture/popup.html", documentId: "live-popup" };
  for (const bad of [{ ...sender, id: "other" }, { ...sender, url: "https://allowed.test" }, { ...sender, tab: { id: 7 } }, { ...sender, documentId: "old-popup" }])
    await assert.rejects(invoke({ type: "SET_SITE_ACCESS_POLICY", policy: config(), expectedRevision: 0 }, bad), /OBU_CONTROL_FORBIDDEN/);
  const readContexts = f.chrome.runtime.getContexts;
  for (const contexts of [[], [{ contextType: "TAB", documentUrl: sender.url, documentId: "live-popup" }]]) {
    f.chrome.runtime.getContexts = async () => contexts;
    await assert.rejects(invoke({ type: "SET_SITE_ACCESS_POLICY", policy: config(), expectedRevision: 0 }, { ...sender, documentId: undefined }), /OBU_CONTROL_FORBIDDEN/);
  }
  f.chrome.runtime.getContexts = readContexts;
  assert.equal(f.backend.automationControl.inputBlocked, false); assert.equal(f.state[SITE_ACCESS_POLICY_KEY], undefined);
  const result = await invoke({ type: "SET_SITE_ACCESS_POLICY", policy: config(), expectedRevision: 0 }, { ...sender, documentId: undefined });
  assert.equal(result.mode, "allow"); assert.equal(f.backend.automationControl.inputBlocked, true);
});
