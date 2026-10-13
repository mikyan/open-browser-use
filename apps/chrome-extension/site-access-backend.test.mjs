import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "./test-support/backend-vm.mjs";
import { SITE_ACCESS_POLICY_KEY, SiteAccessPolicy } from "./site-access-policy.js";

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
      async get(key) { calls.push(["storage.get", key]); await hooks.read?.(key); return Object.hasOwn(state, key) ? { [key]: clone(state[key]) } : {}; },
      async set(value) { await hooks.write?.(value); Object.assign(state, clone(value)); calls.push(["storage.set", Object.keys(value)[0]]); },
      async setAccessLevel(value) { calls.push(["storage.access", clone(value)]); await hooks.access?.(value); }
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
  const saving = f.backend.setSiteAccessPolicy(config(), 0, f.backend.siteAccess.generation);
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
  await assert.rejects(f.backend.setSiteAccessPolicy(config(), 0, f.backend.siteAccess.generation), /OBU_SITE_ACCESS_UNAVAILABLE/);
  assert.equal(f.backend.siteAccess.status().ready, false); assert.equal(f.attached.size, 0);
  const paused = await f.backend.getAutomationControlStatus(); assert.equal(paused.inputBlocked, true);
  await assert.rejects(f.backend.resumeAutomation(paused.revision), /OBU_SITE_ACCESS_UNAVAILABLE/);
  assert.equal(f.state[AUTOMATION_KEY].paused, true);
});

test("pending policy write cannot be overtaken by Resume and worker recovery keeps the durable pause", async t => {
  const f = await fixture(t), writing = f.gate(), entered = f.gate();
  f.hooks.write = async value => { if (value[SITE_ACCESS_POLICY_KEY]) { entered.resolve(); await writing.promise; } };
  const saving = f.backend.setSiteAccessPolicy(config(), 0, f.backend.siteAccess.generation); await entered.promise;
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
    const saving = f.backend.setSiteAccessPolicy(config(), 0, f.backend.siteAccess.generation);
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
    ["browserAction", { action: "responseBody", args: { captureId: "capture", requestId: "request-1" } }],
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
    await assert.rejects(invoke({ type: "SET_SITE_ACCESS_POLICY", policy: config(), expectedRevision: 0, expectedGeneration: f.backend.siteAccess.generation }, bad), /OBU_CONTROL_FORBIDDEN/);
  const readContexts = f.chrome.runtime.getContexts;
  for (const contexts of [[], [{ contextType: "TAB", documentUrl: sender.url, documentId: "live-popup" }]]) {
    f.chrome.runtime.getContexts = async () => contexts;
    await assert.rejects(invoke({ type: "SET_SITE_ACCESS_POLICY", policy: config(), expectedRevision: 0, expectedGeneration: f.backend.siteAccess.generation }, { ...sender, documentId: undefined }), /OBU_CONTROL_FORBIDDEN/);
  }
  f.chrome.runtime.getContexts = readContexts;
  assert.equal(f.backend.automationControl.inputBlocked, false); assert.equal(f.state[SITE_ACCESS_POLICY_KEY], undefined);
  const result = await invoke({ type: "SET_SITE_ACCESS_POLICY", policy: config(), expectedRevision: 0, expectedGeneration: f.backend.siteAccess.generation }, { ...sender, documentId: undefined });
  assert.equal(result.mode, "allow"); assert.equal(f.backend.automationControl.inputBlocked, true);
});

test("settled policy failure exposes an exact candidate retry that remains paused and rejects ordinary SET", async t => {
  const f = await fixture(t); await f.backend.attach(f.params);
  f.hooks.write = async value => { if (value[SITE_ACCESS_POLICY_KEY]) throw new Error("controlled quota"); };
  await assert.rejects(f.backend.setSiteAccessPolicy(config("block", ["https://denied.test"]), 0, f.backend.siteAccess.generation), /OBU_SITE_ACCESS_UNAVAILABLE/);
  const failure = await f.backend.getSiteAccessPolicy();
  assert.equal(failure.retryable, true); assert.equal(failure.ready, false); assert.equal(failure.revision, 1);
  assert.equal(f.attached.size, 0); assert.equal(f.state[AUTOMATION_KEY].paused, true);
  const before = f.calls.length;
  assert.throws(() => f.backend.setSiteAccessPolicy(config("all", []), 1, f.backend.siteAccess.generation), /OBU_SITE_ACCESS_RETRY_REQUIRED/);
  assert.throws(() => f.backend.retrySiteAccessPolicy(0, f.backend.siteAccess.generation), /OBU_SITE_ACCESS_REVISION_CONFLICT/);
  assert.equal(f.calls.length, before, "Rejected requests must not begin another Pause or persistent write");
  failure.origins[0] = "https://mutated.test"; delete f.hooks.write;
  const confirmed = await f.backend.retrySiteAccessPolicy(1, f.backend.siteAccess.generation);
  assert.equal(confirmed.ready, true); assert.equal(confirmed.retryable, undefined); assert.equal(confirmed.revision, 2);
  assert.equal(confirmed.mode, "block"); assert.deepEqual(Array.from(confirmed.origins), ["https://denied.test"]);
  assert.deepEqual(f.state[SITE_ACCESS_POLICY_KEY], { version: 1, revision: 2, mode: "block", origins: ["https://denied.test"] });
  assert.equal(f.state[AUTOMATION_KEY].paused, true); assert.equal(f.backend.automationControl.inputBlocked, true);
  assert.throws(() => f.backend.retrySiteAccessPolicy(1, f.backend.siteAccess.generation), /OBU_SITE_ACCESS_REVISION_CONFLICT/);
  assert.throws(() => f.backend.retrySiteAccessPolicy(2, f.backend.siteAccess.generation), /OBU_SITE_ACCESS_RETRY_UNAVAILABLE/);
  const paused = await f.backend.getAutomationControlStatus(); await f.backend.resumeAutomation(paused.revision);
  await assert.rejects(f.backend.attach(f.params), /OBU_STALE_CONTROL_EPOCH/);
});

test("retry holds the original update token through timeout and concurrent calls until real write settlement", async t => {
  for (const fail of [false, true]) {
    const f = await fixture(t, { automationCleanupTimeoutMs: 25 });
    f.hooks.write = async value => { if (value[SITE_ACCESS_POLICY_KEY]) throw new Error("first failure"); };
    await assert.rejects(f.backend.setSiteAccessPolicy(config(), 0, f.backend.siteAccess.generation), /OBU_SITE_ACCESS_UNAVAILABLE/);
    assert.equal((await f.backend.getSiteAccessPolicy()).retryable, true);
    const entered = f.gate(), writing = f.gate(); let policyWrites = 0;
    f.hooks.write = async value => { if (value[SITE_ACCESS_POLICY_KEY]) { policyWrites++; entered.resolve(); await writing.promise; if (fail) throw new Error("late actual failure"); } };
    const retry = f.backend.retrySiteAccessPolicy(1, f.backend.siteAccess.generation), rejected = assert.rejects(retry, /OBU_SITE_ACCESS_UNAVAILABLE.*unconfirmed/);
    assert.equal((await f.backend.getSiteAccessPolicy()).retryable, undefined);
    assert.throws(() => f.backend.retrySiteAccessPolicy(1, f.backend.siteAccess.generation), /OBU_SITE_ACCESS_BUSY/);
    await entered.promise; await rejected;
    const token = f.backend.sitePolicyUpdate; assert.ok(token); assert.equal(policyWrites, 1);
    assert.equal((await f.backend.getSiteAccessPolicy()).retryable, undefined);
    assert.throws(() => f.backend.retrySiteAccessPolicy(2, f.backend.siteAccess.generation), /OBU_SITE_ACCESS_BUSY/);
    assert.throws(() => f.backend.setSiteAccessPolicy(config("all", []), 2, f.backend.siteAccess.generation), /OBU_SITE_ACCESS_BUSY/);
    const paused = await f.backend.getAutomationControlStatus();
    await assert.rejects(f.backend.resumeAutomation(paused.revision), /OBU_SITE_ACCESS_BUSY|OBU_SITE_ACCESS_UNAVAILABLE/);
    assert.equal(f.backend.sitePolicyUpdate, token);
    writing.resolve(); await f.backend.siteAccess.writes.catch(() => {}); await Promise.resolve(); await Promise.resolve();
    assert.equal(f.backend.sitePolicyUpdate, null); assert.equal(policyWrites, 1);
    const settled = await f.backend.getSiteAccessPolicy();
    assert.equal(settled.revision, 2); assert.equal(settled.ready, !fail); assert.equal(settled.retryable, fail ? true : undefined);
    assert.equal(f.backend.automationControl.inputBlocked, true); assert.equal(f.state[AUTOMATION_KEY].paused, true);
  }
});

test("retry authority stays private to a live popup and its exact failed revision", async t => {
  const f = await fixture(t), invoke = vm.runInNewContext(`${popupCode}\nhandleSiteAccessMessage`, { ...f.context, backend: f.backend });
  f.hooks.write = async value => { if (value[SITE_ACCESS_POLICY_KEY]) throw new Error("failed write"); };
  await assert.rejects(f.backend.setSiteAccessPolicy(config(), 0, f.backend.siteAccess.generation)); delete f.hooks.write;
  const sender = { id: "fixture", url: "chrome-extension://fixture/popup.html", documentId: "live-popup" };
  const retry = { type: "RETRY_SITE_ACCESS_POLICY", expectedRevision: 1, expectedGeneration: f.backend.siteAccess.generation }, before = f.calls.length;
  for (const bad of [{ ...sender, id: "other" }, { ...sender, url: "https://allowed.test" }, { ...sender, tab: { id: 7 } }, { ...sender, documentId: "old-popup" }])
    await assert.rejects(invoke(retry, bad), /OBU_CONTROL_FORBIDDEN/);
  for (const extra of [{ policy: config("all", []) }, { candidate: config() }, { extra: true }])
    await assert.rejects(invoke({ ...retry, ...extra }, sender), /OBU_SITE_ACCESS_INVALID/);
  await assert.rejects(invoke({ type: retry.type }, sender), /OBU_SITE_ACCESS_INVALID|OBU_SITE_ACCESS_REVISION_CONFLICT/);
  assert.equal(f.calls.length, before); assert.equal((await f.backend.getSiteAccessPolicy()).retryable, true);
  const result = await invoke(retry, { ...sender, documentId: undefined });
  assert.equal(result.revision, 2); assert.equal(result.mode, "allow"); assert.equal(f.backend.automationControl.inputBlocked, true);
});

test("failed retry Pause never writes policy and keeps the original candidate available for another explicit retry", async t => {
  const f = await fixture(t);
  f.hooks.write = async value => { if (value[SITE_ACCESS_POLICY_KEY]) throw new Error("first policy failure"); };
  await assert.rejects(f.backend.setSiteAccessPolicy(config(), 0, f.backend.siteAccess.generation));
  const original = await f.backend.getSiteAccessPolicy(); let policyWrites = 0;
  f.hooks.write = async value => { if (value[SITE_ACCESS_POLICY_KEY]) policyWrites++; if (value[AUTOMATION_KEY]) throw new Error("Pause persistence failed"); };
  await assert.rejects(f.backend.retrySiteAccessPolicy(1, f.backend.siteAccess.generation), /OBU_AUTOMATION_PAUSE_FAILED/);
  assert.equal(policyWrites, 0); assert.equal(f.backend.sitePolicyUpdate, null);
  assert.deepEqual(await f.backend.getSiteAccessPolicy(), original);
  assert.equal(f.backend.automationControl.inputBlocked, true);
  delete f.hooks.write; const result = await f.backend.retrySiteAccessPolicy(1, f.backend.siteAccess.generation);
  assert.equal(result.ready, true); assert.equal(result.revision, 2); assert.equal(f.state[AUTOMATION_KEY].paused, true);
});

test("startup read failure or corrupt state cannot authorize ordinary saves or failed-candidate retry", async t => {
  for (const corrupt of [false, true]) {
    const f = await fixture(t);
    if (corrupt) f.state[SITE_ACCESS_POLICY_KEY] = null;
    else f.hooks.read = async key => { if (key === SITE_ACCESS_POLICY_KEY) throw new Error("startup read failure"); };
    const restarted = new f.Backend(); await restarted.controlReady; await restarted.siteRecoveryReady;
    const status = await restarted.getSiteAccessPolicy(); assert.equal(status.ready, false); assert.equal(status.retryable, undefined);
    assert.equal(status.recovery.state, corrupt ? "invalid" : "read-error"); assert.equal(typeof status.recovery.id, "string");
    assert.equal((await restarted.getAutomationControlStatus()).state, "paused");
    const before = f.calls.length;
    assert.throws(() => restarted.retrySiteAccessPolicy(status.revision, restarted.siteAccess.generation), /OBU_SITE_ACCESS_RETRY_UNAVAILABLE/);
    assert.equal(f.calls.length, before); assert.equal(restarted.sitePolicyUpdate, null);
  }
});

test("explicit startup recovery preserves the original policy, durably pauses and requires a new epoch", async t => {
  const f = await fixture(t); await f.backend.attach(f.params);
  f.state[SITE_ACCESS_POLICY_KEY] = { ...policyState(), revision: 8 };
  f.hooks.read = async key => { if (key === SITE_ACCESS_POLICY_KEY) throw Error("initial read failed"); };
  const backend = new f.Backend(); await backend.controlReady; await backend.siteRecoveryReady;
  const original = clone(f.state[SITE_ACCESS_POLICY_KEY]), failed = await backend.getSiteAccessPolicy();
  assert.equal(failed.recovery.state, "read-error");
  const before = f.calls.length;
  for (let index = 0; index < 3; index++) assert.deepEqual(await backend.getSiteAccessPolicy(), failed);
  assert.equal(f.calls.length, before, "Status reads cannot perform another native read");
  assert.throws(() => backend.recoverSiteAccessPolicy("stale"), /OBU_SITE_ACCESS_RECOVERY_CONFLICT/);
  delete f.hooks.read;
  const recovering = backend.recoverSiteAccessPolicy(failed.recovery.id);
  assert.equal(backend.automationControl.inputBlocked, true);
  assert.throws(() => backend.recoverSiteAccessPolicy(failed.recovery.id), /OBU_SITE_ACCESS_BUSY/);
  const result = await recovering;
  assert.equal(result.ready, true); assert.equal(result.revision, 8); assert.equal(result.mode, "allow"); assert.equal(result.error, undefined);
  assert.deepEqual(f.state[SITE_ACCESS_POLICY_KEY], original);
  assert.equal(f.calls.slice(before).filter(([kind, key]) => kind === "storage.get" && key === SITE_ACCESS_POLICY_KEY).length, 1);
  assert.equal(f.calls.slice(before).filter(([kind, key]) => kind === "storage.set" && key === SITE_ACCESS_POLICY_KEY).length, 0);
  const paused = await backend.getAutomationControlStatus(); assert.equal(paused.state, "paused"); assert.equal(paused.cleanupComplete, true);
  assert.equal(f.state[AUTOMATION_KEY].paused, true);
  await assert.rejects(backend.attach(f.params), /OBU_AUTOMATION_PAUSED/);
  await backend.resumeAutomation(paused.revision);
  await assert.rejects(backend.attach(f.params), /OBU_STALE_CONTROL_EPOCH/);
  const next = await backend.getControlState({ session_id: "task" });
  await backend.attach({ ...f.params, control_epoch: next.controlEpoch, turn_id: next.nextTurnId });
  await backend.detachTab(7);
});

test("read recovery remains single-flight after caller timeout until its real read settles", async t => {
  for (const fail of [false, true]) {
    const f = await fixture(t, { automationCleanupTimeoutMs: 30 });
    f.state[SITE_ACCESS_POLICY_KEY] = policyState();
    f.hooks.read = async key => { if (key === SITE_ACCESS_POLICY_KEY) throw Error("initial failure"); };
    const backend = new f.Backend({ automationCleanupTimeoutMs: 30 }); await backend.controlReady; await backend.siteRecoveryReady;
    const failed = await backend.getSiteAccessPolicy(), read = f.gate(), entered = f.gate();
    f.hooks.read = async key => { if (key === SITE_ACCESS_POLICY_KEY) { entered.resolve(); await read.promise; if (fail) throw Error("late read failure"); } };
    const operation = backend.recoverSiteAccessPolicy(failed.recovery.id);
    const rejected = assert.rejects(operation, /OBU_SITE_ACCESS_UNAVAILABLE.*unconfirmed/);
    await entered.promise; await rejected;
    assert.ok(backend.sitePolicyUpdate); const status = await backend.getSiteAccessPolicy();
    assert.equal(status.ready, false); assert.equal(status.recovery.state, "pending"); assert.equal(status.recovery.id, undefined);
    assert.throws(() => backend.recoverSiteAccessPolicy(failed.recovery.id), /OBU_SITE_ACCESS_BUSY/);
    await assert.rejects(backend.resumeAutomation((await backend.getAutomationControlStatus()).revision), /OBU_SITE_ACCESS_BUSY|OBU_SITE_ACCESS_UNAVAILABLE/);
    read.resolve(); await backend.siteAccess.ready.catch(() => {}); await Promise.resolve(); await Promise.resolve();
    assert.equal(backend.sitePolicyUpdate, null); assert.equal(backend.automationControl.inputBlocked, true);
    const after = await backend.getSiteAccessPolicy(); assert.equal(after.ready, !fail);
    if (fail) { assert.notEqual(after.recovery.id, failed.recovery.id); assert.throws(() => backend.recoverSiteAccessPolicy(failed.recovery.id), /OBU_SITE_ACCESS_RECOVERY_CONFLICT/); }
  }
});

test("trusted storage access failure is retried only by explicit recovery before the actual policy read", async t => {
  const f = await fixture(t); f.state[SITE_ACCESS_POLICY_KEY] = policyState();
  f.hooks.access = () => { throw Error("trusted storage setup failed"); };
  const before = f.calls.length, backend = new f.Backend(); await backend.controlReady; await backend.siteRecoveryReady;
  const failed = await backend.getSiteAccessPolicy(); assert.equal(failed.recovery.state, "read-error");
  await backend.getSiteAccessPolicy();
  assert.equal(f.calls.slice(before).filter(([kind]) => kind === "storage.access").length, 1);
  assert.equal(f.calls.slice(before).filter(([kind, key]) => kind === "storage.get" && key === SITE_ACCESS_POLICY_KEY).length, 0);
  delete f.hooks.access; const result = await backend.recoverSiteAccessPolicy(failed.recovery.id);
  assert.equal(result.ready, true); assert.equal(result.mode, "allow");
  assert.equal(f.calls.slice(before).filter(([kind]) => kind === "storage.access").length, 2);
  assert.equal(f.calls.slice(before).filter(([kind, key]) => kind === "storage.get" && key === SITE_ACCESS_POLICY_KEY).length, 1);
  assert.equal((await backend.getAutomationControlStatus()).state, "paused");
});

test("read recovery requires an exact live popup message and is never a public native RPC", async t => {
  const f = await fixture(t);
  f.hooks.read = async key => { if (key === SITE_ACCESS_POLICY_KEY) throw Error("initial read failure"); };
  const backend = new f.Backend(); await backend.controlReady; await backend.siteRecoveryReady;
  const failed = await backend.getSiteAccessPolicy(); delete f.hooks.read;
  const invoke = vm.runInNewContext(`${popupCode}\nhandleSiteAccessMessage`, { ...f.context, backend });
  const sender = { id: "fixture", url: "chrome-extension://fixture/popup.html", documentId: "live-popup" };
  const request = { type: "RECOVER_SITE_ACCESS_POLICY", expectedRecoveryId: failed.recovery.id }, before = f.calls.length;
  for (const bad of [{ ...sender, id: "foreign" }, { ...sender, url: "https://allowed.test" }, { ...sender, tab: { id: 7 } }, { ...sender, documentId: "closed-popup" }])
    await assert.rejects(invoke(request, bad), /OBU_CONTROL_FORBIDDEN/);
  const contexts = f.chrome.runtime.getContexts;
  f.chrome.runtime.getContexts = async () => [];
  await assert.rejects(invoke(request, sender), /OBU_CONTROL_FORBIDDEN/);
  f.chrome.runtime.getContexts = contexts;
  for (const invalid of [
    { type: request.type }, { ...request, expectedRecoveryId: null }, { ...request, expectedRecoveryId: 1 },
    { ...request, expectedRecoveryId: "" }, { ...request, expectedRecoveryId: "x".repeat(129) },
    { ...request, policy: config() }, { ...request, expectedRevision: 0 }, { ...request, extra: true },
  ]) await assert.rejects(invoke(invalid, sender), /OBU_SITE_ACCESS_INVALID/);
  await assert.rejects(invoke({ ...request, expectedRecoveryId: "stale" }, sender), /OBU_SITE_ACCESS_RECOVERY_CONFLICT/);
  const Peer = vm.runInNewContext(`${code}\nJsonRpcPeer`, f.context), replies = [];
  const peer = new Peer({ setMessageCallback() {}, sendMessage: response => replies.push(response) }, backend);
  for (const method of ["recoverSiteAccessPolicy", "RECOVER_SITE_ACCESS_POLICY", "prepareSiteStorageAccess"])
    await peer.handleMessage({ jsonrpc: "2.0", id: replies.length + 1, method, params: { expectedRecoveryId: failed.recovery.id } });
  assert.equal(replies.length, 3);
  for (const reply of replies) { assert.match(reply.error.message, /No handler registered/); assert.equal(reply.result, undefined); }
  assert.equal(f.calls.length, before); assert.equal(backend.sitePolicyUpdate, null);
  const result = await invoke(request, sender);
  assert.equal(result.ready, true); assert.equal(result.stored, false);
});

test("other core startup failures cannot publish read-recovery authority or start another policy read", async t => {
  for (const key of ["OPEN_BROWSER_USE_SESSION_STATE", "OPEN_BROWSER_USE_CONTROL_STATE", "OPEN_BROWSER_USE_INPUT_RISKS", "OPEN_BROWSER_USE_AUXILIARY_TABS"]) {
    const f = await fixture(t); let reads = 0;
    f.hooks.read = async requested => {
      if (requested === SITE_ACCESS_POLICY_KEY) { reads++; throw Error("policy read failed"); }
      if (requested === key) throw Error("independent core startup failure");
    };
    if (key === "OPEN_BROWSER_USE_AUXILIARY_TABS") {
      const read = f.chrome.storage.session.get;
      f.chrome.storage.session.get = function (requested) {
        if (requested === key) return Promise.reject(Error("independent core startup failure"));
        return read.call(this, requested);
      };
    }
    const backend = new f.Backend();
    await assert.rejects(backend.controlReady, /independent core startup failure/, key);
    const status = await backend.getSiteAccessPolicy();
    assert.equal(status.recovery.state, "read-error"); assert.equal(status.recovery.id, undefined);
    assert.equal(backend.controlStartupState, "failed");
    assert.throws(() => backend.recoverSiteAccessPolicy(backend.siteAccess.status().recovery.id), /OBU_SITE_ACCESS_RECOVERY_UNAVAILABLE/);
    assert.equal(reads, 1); assert.equal(backend.sitePolicyUpdate, null);
  }
});

test("a caught automation-control loadError is still a failed core startup, never recovery authority", async t => {
  const f = await fixture(t); let reads = 0;
  f.state[AUTOMATION_KEY] = { version: 1, revision: 9, paused: "invalid" };
  f.hooks.read = async key => { if (key === SITE_ACCESS_POLICY_KEY) { reads++; throw Error("policy read failed"); } };
  const backend = new f.Backend();
  // Existing user-Pause startup semantics keep this promise fulfilled. The
  // separate policy-recovery gate must still withhold read authority.
  await backend.controlReady; await backend.siteRecoveryReady;
  assert.ok(backend.automationControl.loadError); assert.equal(backend.controlStartupState, "failed");
  const status = await backend.getSiteAccessPolicy(); assert.equal(status.recovery.id, undefined);
  assert.throws(() => backend.recoverSiteAccessPolicy(backend.siteAccess.status().recovery.id), /OBU_SITE_ACCESS_RECOVERY_UNAVAILABLE/);
  assert.equal(reads, 1); assert.equal(backend.sitePolicyUpdate, null);
  assert.deepEqual(f.state[AUTOMATION_KEY], { version: 1, revision: 9, paused: "invalid" });
});

test("failed durable recovery Pause performs no read and preserves the same settled recovery identity", async t => {
  const f = await fixture(t); f.state[SITE_ACCESS_POLICY_KEY] = policyState();
  f.hooks.read = async key => { if (key === SITE_ACCESS_POLICY_KEY) throw Error("initial policy failure"); };
  const backend = new f.Backend(); await backend.controlReady; await backend.siteRecoveryReady;
  const failed = await backend.getSiteAccessPolicy(); delete f.hooks.read;
  f.hooks.write = async value => { if (value[AUTOMATION_KEY]) throw Error("actual Pause write rejected"); };
  const before = f.calls.length;
  await assert.rejects(backend.recoverSiteAccessPolicy(failed.recovery.id), /OBU_AUTOMATION_PAUSE_FAILED/);
  assert.equal(f.calls.slice(before).filter(([kind, key]) => kind === "storage.get" && key === SITE_ACCESS_POLICY_KEY).length, 0);
  assert.deepEqual(await backend.getSiteAccessPolicy(), failed); assert.equal(backend.sitePolicyUpdate, null);
  assert.equal(backend.automationControl.inputBlocked, true); assert.equal(backend.automationControl.cleanupComplete, false);
  delete f.hooks.write;
  assert.equal((await backend.recoverSiteAccessPolicy(failed.recovery.id)).ready, true);
  assert.equal(f.calls.slice(before).filter(([kind, key]) => kind === "storage.get" && key === SITE_ACCESS_POLICY_KEY).length, 1);
});

test("real pending Pause persistence prevents policy reread, even after the recovery caller times out", async t => {
  const f = await fixture(t, { automationCleanupTimeoutMs: 25 });
  f.hooks.read = async key => { if (key === SITE_ACCESS_POLICY_KEY) throw Error("initial read failure"); };
  const backend = new f.Backend({ automationCleanupTimeoutMs: 25 }); await backend.controlReady; await backend.siteRecoveryReady;
  const failed = await backend.getSiteAccessPolicy(); delete f.hooks.read;
  const write = f.gate(), entered = f.gate();
  f.hooks.write = async value => { if (value[AUTOMATION_KEY]) { entered.resolve(); await write.promise; } };
  const before = f.calls.length, recovering = backend.recoverSiteAccessPolicy(failed.recovery.id);
  const rejected = assert.rejects(recovering, /OBU_SITE_ACCESS_UNAVAILABLE|OBU_AUTOMATION_PAUSE_FAILED/);
  await entered.promise;
  assert.equal((await backend.getSiteAccessPolicy()).recovery.id, undefined);
  await rejected;
  assert.equal(f.calls.slice(before).filter(([kind, key]) => kind === "storage.get" && key === SITE_ACCESS_POLICY_KEY).length, 0);
  assert.equal(backend.automationControl.inputBlocked, true);
  write.resolve(); await backend.automationTransitions.catch(() => {}); await backend.automationControl.writes;
  assert.equal(f.calls.slice(before).filter(([kind, key]) => kind === "storage.get" && key === SITE_ACCESS_POLICY_KEY).length, 0, "A late Pause ACK must not start a fresh-budget read");
  assert.equal(backend.siteAccess.status().recovery.id, failed.recovery.id);
  delete f.hooks.write;
  assert.equal((await backend.recoverSiteAccessPolicy(failed.recovery.id)).ready, true);
});

test("initial pending trusted setup stays unready without retry authority or a policy get", async t => {
  const f = await fixture(t, { automationCleanupTimeoutMs: 20 }), setup = f.gate(), entered = f.gate();
  f.hooks.access = async () => { entered.resolve(); await setup.promise; };
  const before = f.calls.length, backend = new f.Backend({ automationCleanupTimeoutMs: 20 });
  await entered.promise;
  const status = await backend.getSiteAccessPolicy();
  assert.equal(status.ready, false); assert.equal(status.recovery.state, "pending"); assert.equal(status.recovery.id, undefined);
  assert.equal(backend.controlStartupState, "pending");
  assert.throws(() => backend.recoverSiteAccessPolicy("invented"), /OBU_SITE_ACCESS_RECOVERY_UNAVAILABLE/);
  assert.equal(f.calls.slice(before).filter(([kind]) => kind === "storage.access").length, 1);
  assert.equal(f.calls.slice(before).filter(([kind, key]) => kind === "storage.get" && key === SITE_ACCESS_POLICY_KEY).length, 0);
  setup.resolve(); await backend.controlReady;
  assert.equal((await backend.getSiteAccessPolicy()).ready, true);
  assert.equal(f.calls.slice(before).filter(([kind]) => kind === "storage.access").length, 1);
  assert.equal(f.calls.slice(before).filter(([kind, key]) => kind === "storage.get" && key === SITE_ACCESS_POLICY_KEY).length, 1);
});

test("retry trusted setup owns its actual promise through timeout and handles synchronous native throws", async t => {
  for (const reject of [false, true]) {
    const f = await fixture(t, { automationCleanupTimeoutMs: 25 });
    const original = f.chrome.storage.local.setAccessLevel;
    f.chrome.storage.local.setAccessLevel = () => { f.calls.push(["native-access-threw"]); throw Error("synchronous native setup throw"); };
    const backend = new f.Backend({ automationCleanupTimeoutMs: 25 }); await backend.controlReady; await backend.siteRecoveryReady;
    const failed = await backend.getSiteAccessPolicy(); assert.equal(failed.recovery.state, "read-error");
    f.chrome.storage.local.setAccessLevel = original;
    const setup = f.gate(), entered = f.gate();
    f.hooks.access = async () => { entered.resolve(); await setup.promise; if (reject) throw Error("late setup rejection"); };
    const before = f.calls.length, recovering = backend.recoverSiteAccessPolicy(failed.recovery.id);
    const rejected = assert.rejects(recovering, /OBU_SITE_ACCESS_UNAVAILABLE.*unconfirmed/);
    await entered.promise; await rejected;
    const token = backend.sitePolicyUpdate; assert.ok(token);
    const status = await backend.getSiteAccessPolicy(); assert.equal(status.recovery.state, "pending"); assert.equal(status.recovery.id, undefined);
    assert.throws(() => backend.recoverSiteAccessPolicy(failed.recovery.id), /OBU_SITE_ACCESS_BUSY/);
    await assert.rejects(backend.resumeAutomation(backend.automationControl.revision), /OBU_SITE_ACCESS_UNAVAILABLE|OBU_SITE_ACCESS_BUSY/);
    assert.equal(backend.sitePolicyUpdate, token);
    assert.equal(f.calls.slice(before).filter(([kind]) => kind === "storage.access").length, 1);
    assert.equal(f.calls.slice(before).filter(([kind, key]) => kind === "storage.get" && key === SITE_ACCESS_POLICY_KEY).length, 0);
    setup.resolve(); await backend.siteAccess.ready.catch(() => {}); await Promise.resolve(); await Promise.resolve();
    assert.equal(backend.sitePolicyUpdate, null); assert.equal(backend.automationControl.inputBlocked, true);
    const after = await backend.getSiteAccessPolicy(); assert.equal(after.ready, !reject);
    assert.equal(f.calls.slice(before).filter(([kind, key]) => kind === "storage.get" && key === SITE_ACCESS_POLICY_KEY).length, reject ? 0 : 1);
    if (reject) {
      assert.equal(after.recovery.state, "read-error"); assert.notEqual(after.recovery.id, failed.recovery.id);
      assert.throws(() => backend.recoverSiteAccessPolicy(failed.recovery.id), /OBU_SITE_ACCESS_RECOVERY_CONFLICT/);
      delete f.hooks.access; await backend.recoverSiteAccessPolicy(after.recovery.id);
      assert.equal(f.calls.slice(before).filter(([kind]) => kind === "storage.access").length, 2);
    }
  }
});

test("repeated invalid rereads stay blocked until external repair and never save a replacement", async t => {
  const f = await fixture(t);
  f.state[SITE_ACCESS_POLICY_KEY] = { ...policyState(), revision: 37, origins: ["https://private.test/path"] };
  const backend = new f.Backend(); await backend.controlReady; await backend.siteRecoveryReady;
  const first = await backend.getSiteAccessPolicy(), before = f.calls.length;
  assert.equal(first.recovery.state, "invalid");
  await assert.rejects(backend.recoverSiteAccessPolicy(first.recovery.id), /OBU_SITE_ACCESS_STATE_INVALID/);
  const second = await backend.getSiteAccessPolicy(); assert.equal(second.recovery.state, "invalid"); assert.notEqual(second.recovery.id, first.recovery.id);
  assert.equal(backend.siteAccess.allowsUrl("https://allowed.test"), false);
  f.state[SITE_ACCESS_POLICY_KEY] = { ...policyState(), revision: 37 };
  const repaired = await backend.recoverSiteAccessPolicy(second.recovery.id);
  assert.equal(repaired.ready, true); assert.equal(repaired.stored, true); assert.equal(repaired.revision, 37);
  assert.equal(repaired.error, undefined); assert.equal(repaired.recovery, undefined);
  assert.equal(f.calls.slice(before).filter(([kind, key]) => kind === "storage.get" && key === SITE_ACCESS_POLICY_KEY).length, 2);
  assert.equal(f.calls.slice(before).filter(([kind, key]) => kind === "storage.set" && key === SITE_ACCESS_POLICY_KEY).length, 0);
  assert.equal((await backend.getAutomationControlStatus()).state, "paused");
});

test("startup policy failure releases unbound admission while still waiting for the real Pause ACK", async t => {
  const f = await fixture(t, { automationCleanupTimeoutMs: 1000 });
  const read = f.gate(), readEntered = f.gate(), pauseWrite = f.gate(), pauseEntered = f.gate();
  f.hooks.read = async key => { if (key === SITE_ACCESS_POLICY_KEY) { readEntered.resolve(); await read.promise; throw Error("initial policy delivery failed"); } };
  f.hooks.write = async value => { if (value[AUTOMATION_KEY]) { pauseEntered.resolve(); await pauseWrite.promise; } };
  const before = f.calls.length, backend = new f.Backend({ automationCleanupTimeoutMs: 1000 });
  await readEntered.promise;
  const exporting = backend.exportPage({ ...f.params, format: "pdf" });
  const rejected = assert.rejects(exporting, /OBU_EXPORT_CANCELLED|OBU_AUTOMATION_PAUSED/);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(backend.pageExports.records.size, 1);
  assert.ok(backend.pageExports.controlSnapshot().pending.length);
  read.resolve(); await pauseEntered.promise;
  await backend.controlReady; await rejected;
  assert.equal(backend.controlStartupState, "pending");
  assert.equal(backend.automationControl.cleanupComplete, false);
  const status = await backend.getSiteAccessPolicy(); assert.equal(status.recovery.state, "read-error"); assert.equal(status.recovery.id, undefined);
  assert.throws(() => backend.recoverSiteAccessPolicy(backend.siteAccess.status().recovery.id), /OBU_SITE_ACCESS_RECOVERY_UNAVAILABLE/);
  assert.equal(f.calls.slice(before).some(([kind]) => kind === "attach-start" || kind === "command"), false);
  pauseWrite.resolve(); await backend.siteRecoveryReady;
  assert.equal(backend.pageExports.controlSnapshot().pending.length, 0); assert.equal(backend.pageExports.records.size, 0);
  assert.equal(backend.controlStartupState, "ready");
  const paused = await backend.getAutomationControlStatus(); assert.equal(paused.state, "paused"); assert.equal(paused.cleanupComplete, true);
  assert.equal(f.state[AUTOMATION_KEY].paused, true);
  assert.equal(typeof (await backend.getSiteAccessPolicy()).recovery.id, "string");
});

test("explicit invalid replacement persists only selected settings and keeps retired control paused", async t => {
  const f = await fixture(t); await f.backend.attach(f.params);
  f.state[SITE_ACCESS_POLICY_KEY] = { ...policyState(), revision: 91, origins: ["https://allowed.test/path"] };
  const backend = new f.Backend(); await backend.controlReady; await backend.siteRecoveryReady;
  const failed = await backend.getSiteAccessPolicy(), before = f.calls.length;
  assert.equal(failed.recovery.state, "invalid");
  const result = await backend.replaceInvalidSiteAccessPolicy(config(), failed.recovery.id);
  assert.equal(result.ready, true); assert.equal(result.stored, true); assert.equal(result.revision, 1);
  assert.notEqual(result.generation, failed.generation); assert.equal(result.recovery, undefined);
  assert.deepEqual(f.state[SITE_ACCESS_POLICY_KEY], policyState());
  assert.equal(f.calls.slice(before).filter(([kind, key]) => kind === "storage.set" && key === SITE_ACCESS_POLICY_KEY).length, 1);
  assert.equal((await backend.getAutomationControlStatus()).state, "paused");
  assert.equal(f.state[AUTOMATION_KEY].paused, true);
  assert.throws(() => backend.replaceInvalidSiteAccessPolicy(config("all", []), failed.recovery.id), /OBU_SITE_ACCESS_RECOVERY_UNAVAILABLE/);
  await assert.rejects(backend.attach(f.params), /OBU_AUTOMATION_PAUSED/);
  await backend.resumeAutomation(backend.automationControl.revision);
  await assert.rejects(backend.attach(f.params), /OBU_STALE_CONTROL_EPOCH/);
  const restarted = new f.Backend(); await restarted.controlReady;
  const persisted = await restarted.getSiteAccessPolicy();
  assert.equal(persisted.ready, true); assert.equal(persisted.revision, 1); assert.notEqual(persisted.generation, result.generation);
  assert.equal(persisted.mode, "allow");
});

test("replacement requires the live popup and exact invalid ID, never a public agent RPC", async t => {
  const f = await fixture(t); f.state[SITE_ACCESS_POLICY_KEY] = null;
  const backend = new f.Backend(); await backend.controlReady; await backend.siteRecoveryReady;
  const invoke = vm.runInNewContext(`${popupCode}\nhandleSiteAccessMessage`, { ...f.context, backend });
  const status = await backend.getSiteAccessPolicy(), before = f.calls.length;
  const sender = { id: "fixture", url: "chrome-extension://fixture/popup.html", documentId: "live-popup" };
  const request = { type: "REPLACE_INVALID_SITE_ACCESS_POLICY", policy: config(), expectedRecoveryId: status.recovery.id };
  for (const bad of [{ ...sender, id: "other" }, { ...sender, url: "https://allowed.test" }, { ...sender, tab: { id: 7 } }, { ...sender, documentId: "old-popup" }])
    await assert.rejects(invoke(request, bad), /OBU_CONTROL_FORBIDDEN/);
  for (const invalid of [{ ...request, extra: true }, { ...request, expectedRevision: 0 }, { ...request, expectedRecoveryId: "" }, { type: request.type, expectedRecoveryId: request.expectedRecoveryId }])
    await assert.rejects(invoke(invalid, sender), /OBU_SITE_ACCESS_INVALID/);
  await assert.rejects(invoke({ ...request, expectedRecoveryId: "stale" }, sender), /OBU_SITE_ACCESS_RECOVERY_CONFLICT/);
  const Peer = vm.runInNewContext(`${code}\nJsonRpcPeer`, f.context), replies = [];
  const peer = new Peer({ setMessageCallback() {}, sendMessage: response => replies.push(response) }, backend);
  for (const method of ["replaceInvalidSiteAccessPolicy", "REPLACE_INVALID_SITE_ACCESS_POLICY"])
    await peer.handleMessage({ jsonrpc: "2.0", id: replies.length + 1, method, params: request });
  assert.equal(replies.length, 2); for (const reply of replies) assert.match(reply.error.message, /No handler registered/);
  assert.equal(f.calls.length, before); assert.equal(backend.sitePolicyUpdate, null);
  assert.equal((await invoke(request, sender)).ready, true);
});

test("unreadable storage and independent startup failure cannot authorize invalid replacement", async t => {
  for (const coreFailure of [false, true]) {
    const f = await fixture(t);
    if (coreFailure) {
      f.state[SITE_ACCESS_POLICY_KEY] = null;
      f.state[AUTOMATION_KEY] = { version: 1, revision: 7, paused: "invalid" };
    } else f.hooks.read = async key => { if (key === SITE_ACCESS_POLICY_KEY) throw Error("unavailable storage"); };
    const backend = new f.Backend(); await backend.controlReady; await backend.siteRecoveryReady;
    const status = await backend.getSiteAccessPolicy(), before = f.calls.length;
    assert.equal(status.recovery.state, coreFailure ? "invalid" : "read-error");
    if (coreFailure) assert.equal(status.recovery.id, undefined);
    assert.throws(() => backend.replaceInvalidSiteAccessPolicy(config(), backend.siteAccess.status().recovery.id), /OBU_SITE_ACCESS_RECOVERY_UNAVAILABLE/);
    assert.equal(f.calls.length, before); assert.equal(backend.sitePolicyUpdate, null);
    assert.equal(backend.automationControl.inputBlocked, true);
  }
});

test("replacement retains pending native write after timeout and only real rejection grants exact retry", async t => {
  for (const fail of [false, true]) {
    const f = await fixture(t, { automationCleanupTimeoutMs: 25 }); f.state[SITE_ACCESS_POLICY_KEY] = null;
    const backend = new f.Backend({ automationCleanupTimeoutMs: 25 }); await backend.controlReady; await backend.siteRecoveryReady;
    const failed = await backend.getSiteAccessPolicy(), entered = f.gate(), writing = f.gate(); let writes = 0;
    f.hooks.write = async value => { if (value[SITE_ACCESS_POLICY_KEY]) { writes++; entered.resolve(); await writing.promise; if (fail) throw Error("actual rejected write"); } };
    const saving = backend.replaceInvalidSiteAccessPolicy(config(), failed.recovery.id);
    const rejection = assert.rejects(saving, /OBU_SITE_ACCESS_UNAVAILABLE.*unconfirmed/);
    await entered.promise; await rejection;
    const token = backend.sitePolicyUpdate; assert.ok(token); assert.equal(writes, 1);
    const pending = await backend.getSiteAccessPolicy(); assert.equal(pending.ready, false); assert.equal(pending.retryable, undefined);
    assert.throws(() => backend.replaceInvalidSiteAccessPolicy(config(), failed.recovery.id), /OBU_SITE_ACCESS_BUSY/);
    assert.throws(() => backend.recoverSiteAccessPolicy(failed.recovery.id), /OBU_SITE_ACCESS_BUSY/);
    assert.throws(() => backend.retrySiteAccessPolicy(1, pending.generation), /OBU_SITE_ACCESS_BUSY/);
    await assert.rejects(backend.resumeAutomation(backend.automationControl.revision), /OBU_SITE_ACCESS_BUSY|OBU_SITE_ACCESS_UNAVAILABLE/);
    writing.resolve(); await backend.siteAccess.writes.catch(() => {}); await Promise.resolve(); await Promise.resolve();
    assert.equal(backend.sitePolicyUpdate, null); assert.equal(writes, 1);
    const settled = await backend.getSiteAccessPolicy(); assert.equal(settled.ready, !fail); assert.equal(settled.retryable, fail ? true : undefined);
    assert.equal(backend.automationControl.inputBlocked, true); assert.equal(f.state[AUTOMATION_KEY].paused, true);
    if (fail) {
      delete f.hooks.write;
      assert.throws(() => backend.setSiteAccessPolicy(config("all", []), 1, settled.generation), /OBU_SITE_ACCESS_RETRY_REQUIRED/);
      const retried = await backend.retrySiteAccessPolicy(settled.revision, settled.generation);
      assert.equal(retried.ready, true); assert.equal(retried.revision, 2); assert.equal(retried.generation, settled.generation);
      assert.deepEqual(f.state[SITE_ACCESS_POLICY_KEY], { ...policyState(), revision: 2 });
    }
  }
});

test("replacement performs no native set if its queue starts after the original deadline", async t => {
  const f = await fixture(t, { automationCleanupTimeoutMs: 25 }); f.state[SITE_ACCESS_POLICY_KEY] = null;
  const backend = new f.Backend({ automationCleanupTimeoutMs: 25 }); await backend.controlReady; await backend.siteRecoveryReady;
  const failed = await backend.getSiteAccessPolicy(), queued = f.gate(), before = f.calls.length;
  backend.siteAccess.writes = queued.promise;
  await assert.rejects(backend.replaceInvalidSiteAccessPolicy(config(), failed.recovery.id), /OBU_SITE_ACCESS_UNAVAILABLE.*unconfirmed/);
  assert.ok(backend.sitePolicyUpdate); queued.resolve(); await backend.siteAccess.writes.catch(() => {}); await Promise.resolve(); await Promise.resolve();
  assert.equal(backend.sitePolicyUpdate, null);
  assert.equal(f.calls.slice(before).some(([kind, key]) => kind === "storage.set" && key === SITE_ACCESS_POLICY_KEY), false);
  assert.equal(f.state[SITE_ACCESS_POLICY_KEY], null);
  const after = await backend.getSiteAccessPolicy(); assert.equal(after.ready, false); assert.equal(after.retryable, undefined);
  assert.equal(after.recovery.state, "invalid"); assert.notEqual(after.recovery.id, failed.recovery.id);
  assert.throws(() => backend.replaceInvalidSiteAccessPolicy(config(), failed.recovery.id), /OBU_SITE_ACCESS_RECOVERY_CONFLICT/);
});

test("same revision in a new worker rejects old SET and RETRY before Pause, and missing generation cannot save", async t => {
  const f = await fixture(t, { policy: policyState() }), original = await f.backend.getSiteAccessPolicy();
  const backend = new f.Backend(); await backend.controlReady;
  const before = f.calls.length;
  assert.throws(() => backend.setSiteAccessPolicy(config("all", []), original.revision, original.generation), /OBU_SITE_ACCESS_GENERATION_CONFLICT/);
  assert.throws(() => backend.retrySiteAccessPolicy(original.revision, original.generation), /OBU_SITE_ACCESS_GENERATION_CONFLICT/);
  const invoke = vm.runInNewContext(`${popupCode}\nhandleSiteAccessMessage`, { ...f.context, backend });
  const sender = { id: "fixture", url: "chrome-extension://fixture/popup.html", documentId: "live-popup" };
  for (const message of [
    { type: "SET_SITE_ACCESS_POLICY", policy: config(), expectedRevision: 1 },
    { type: "RETRY_SITE_ACCESS_POLICY", expectedRevision: 1 },
    { type: "SET_SITE_ACCESS_POLICY", policy: config(), expectedRevision: 1, expectedGeneration: "", extra: true }
  ]) await assert.rejects(invoke(message, sender), /OBU_SITE_ACCESS_INVALID/);
  assert.equal(f.calls.length, before); assert.equal(backend.sitePolicyUpdate, null);
  assert.equal(backend.automationControl.inputBlocked, false);
});

test("same revision policy generation invalidates a retained document proof and an in-flight inspection", async t => {
  const f = await fixture(t, { policy: policyState() });
  const proof = await f.backend.assertSiteTab(7); f.backend.assertSiteProof(proof);
  const renew = async () => {
    const policy = new SiteAccessPolicy({ storage: f.chrome.storage.local }); await policy.ready;
    f.backend.siteAccess = policy;
  };
  await renew(); assert.equal(f.backend.siteAccess.status().revision, proof.revision);
  assert.throws(() => f.backend.assertSiteProof(proof), /OBU_SITE_ACCESS_UNVERIFIED/);
  const entered = f.gate(), reading = f.gate();
  f.hooks.frames = async () => { entered.resolve(); await reading.promise; };
  const inspecting = f.backend.assertSiteTab(7); await entered.promise;
  await renew(); reading.resolve(); await assert.rejects(inspecting, /OBU_SITE_ACCESS_UNVERIFIED/);
});

test("invalid replacement requires the real durable Pause ACK within the original deadline", async t => {
  for (const failure of ["rejected", "late"]) {
    const f = await fixture(t, { automationCleanupTimeoutMs: 25 }); f.state[SITE_ACCESS_POLICY_KEY] = null;
    const backend = new f.Backend({ automationCleanupTimeoutMs: 25 }); await backend.controlReady; await backend.siteRecoveryReady;
    const failed = await backend.getSiteAccessPolicy(), writing = f.gate(), entered = f.gate();
    f.hooks.write = async value => {
      if (!value[AUTOMATION_KEY]) return;
      entered.resolve();
      if (failure === "late") await writing.promise;
      else throw Error("actual Pause write failed");
    };
    const before = f.calls.length;
    const replacing = backend.replaceInvalidSiteAccessPolicy(config(), failed.recovery.id);
    const rejected = assert.rejects(replacing, /OBU_AUTOMATION_PAUSE_FAILED|OBU_SITE_ACCESS_UNAVAILABLE/);
    await entered.promise; await rejected;
    assert.equal(backend.automationControl.inputBlocked, true);
    if (failure === "late") writing.resolve();
    await backend.automationTransitions.catch(() => {}); await backend.automationControl.writes.catch(() => {}); await Promise.resolve();
    assert.equal(f.calls.slice(before).some(([kind, key]) => kind === "storage.set" && key === SITE_ACCESS_POLICY_KEY), false);
    assert.equal(f.state[SITE_ACCESS_POLICY_KEY], null);
    assert.equal(backend.siteAccess.status().recovery.id, failed.recovery.id, "No policy transition was dispatched");
    assert.equal(backend.siteAccess.generation, failed.generation);
  }
});
