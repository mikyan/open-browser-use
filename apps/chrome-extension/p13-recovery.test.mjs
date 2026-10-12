import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "./test-support/backend-vm.mjs";

const input = (await readFile(new URL("./browser-input-adapter.js", import.meta.url), "utf8")).replace(/^export /gm, "");
const source = (await readFile(new URL("./background.js", import.meta.url), "utf8"))
  .replace('import { createBrowserActionEngine } from "./browser-runtime.js";', "")
  .replace('import { NativeInputTracker } from "./browser-input-adapter.js";', input);
const code = source.slice(0, source.indexOf("chrome.runtime.onInstalled.addListener"));
const unavailable = /OBU_AUXILIARY_|not part of browser session|already part of browser session|closed|No tab|No window|cancel|ended|STALE_CONTROL_EPOCH|AUTOMATION_PAUSED/i;
const clone = value => structuredClone(value);
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const event = () => {
  const listeners = new Set();
  return { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn), clear: () => listeners.clear(), emit: (...args) => { for (const listener of listeners) listener(...args); } };
};
async function until(check, label) {
  for (let attempt = 0; attempt < 100; attempt++) { if (check()) return; await tick(); }
  throw new Error(`Fixture did not reach ${label}`);
}

async function holdInput(f) {
  await f.backend.attach(f.params);
  for (const [method, commandParams] of [
    ["Input.dispatchMouseEvent", { type: "mousePressed", button: "left", x: 10, y: 20 }],
    ["Input.dispatchKeyEvent", { type: "keyDown", key: "Shift", code: "ShiftLeft" }]
  ]) await f.backend.executeCdp({ ...f.params, target: { tabId: 7 }, method, commandParams });
}

test("ordinary ungroup synchronously blocks CRX and releases original held pointer/key without regrouping", async t => {
  const f = await fixture(t);
  await holdInput(f);
  await f.backend.getBrowserEngine();
  const token = f.backend.attachmentEpochs.get(7);
  f.tabs.get(7).groupId = -1;
  f.chrome.tabs.onUpdated.emit(7, { groupId: -1 });
  let sent = 0;
  assert.throws(() => f.engineOptions.inputHooks.send({ tabId: 7 }, "Runtime.callFunctionOn", {}, () => sent++), /OBU_TAB_CONTROL_REVOKED/);
  await f.backend.controlReleases.get(7);
  assert.equal(sent, 0);
  assert.equal(f.attached.has(7), false);
  assert.equal(f.backend.inputTracker.attachments.has(7), false);
  assert.equal(f.backend.revokedAttachmentTokens.has(token), true);
  assert.ok(f.calls.some(([method, , params]) => method === "Input.dispatchMouseEvent" && params.type === "mouseReleased"));
  assert.ok(f.calls.some(([method, , params]) => method === "Input.dispatchKeyEvent" && params.type === "keyUp"));
  assert.equal(f.calls.some(([method]) => ["group", "ungroup", "remove"].includes(method)), false);
  await assert.rejects(f.backend.executeCdp({ ...f.params, target: { tabId: 7 }, method: "Runtime.evaluate" }), /not part of browser session/);
  await f.backend.claimUserTab(f.params);
  // The explicit claim preserves the normal task's established group workflow.
  assert.equal(f.tabs.get(7).groupId, 10);
});

test("same-group update preserves input while a cross-window detach revokes it even if groupId survives", async t => {
  const f = await fixture(t);
  await holdInput(f);
  f.chrome.tabs.onUpdated.emit(7, { groupId: 10 });
  assert.equal(f.backend.controlReleases.has(7), false);
  assert.equal(f.backend.inputTracker.hasHeld(f.backend.inputTracker.attachments.get(7)), true);
  f.tabs.get(7).windowId = 3;
  f.chrome.tabs.onDetached.emit(7, { oldWindowId: 1, oldPosition: 0 });
  await f.backend.controlReleases.get(7);
  assert.equal(f.attached.has(7), false);
  assert.equal(f.tabs.get(7).windowId, 3);
  assert.equal(f.tabs.get(7).groupId, 10);
});

test("a moved raw attachment cannot initialize focus after native attach settles late", async t => {
  const f = await fixture(t), gate = f.gate();
  f.hooks.attach = () => gate.promise;
  const attaching = f.backend.attach(f.params);
  const rejected = assert.rejects(attaching, /cancelled|REVOKED|not part/);
  await until(() => f.calls.some(([method]) => method === "attach-start"), "native attach entry");
  f.tabs.get(7).groupId = -1;
  f.chrome.tabs.onUpdated.emit(7, { groupId: -1 });
  gate.resolve();
  await rejected;
  await f.backend.controlReleases.get(7);
  assert.equal(f.attached.has(7), false);
  assert.equal(f.calls.some(([method]) => method === "Emulation.setFocusEmulationEnabled"), false);
});

for (const destruction of ["tabRemoved", "target_closed"]) test(`native ${destruction} proves original cleanup after a late CRX detach rejection without pausing`, async t => {
  const f = await fixture(t), gate = f.gate();
  await holdInput(f);
  let detaching = false;
  f.hooks.engine = () => ({
    pages: new Map(), queues: new Map(), invalidate() {}, forget() {},
    async detach() { detaching = true; await gate.promise; throw new Error("crxApplication.detach: No tab with given id 7."); }
  });
  await f.backend.getBrowserEngine();
  f.tabs.get(7).groupId = -1;
  f.chrome.tabs.onUpdated.emit(7, { groupId: -1 });
  const release = f.backend.controlReleases.get(7);
  await until(() => detaching, "CRX detach entry");
  if (destruction === "tabRemoved") await f.chrome.tabs.remove(7);
  else { f.attached.delete(7); f.chrome.debugger.onDetach.emit({ tabId: 7 }, "target_closed"); }
  gate.resolve();
  await release;
  assert.equal(f.backend.automationControl.inputBlocked, false);
  assert.equal(f.backend.pauseReleaseFailures.has(7), false);
  assert.equal(f.backend.inputTracker.attachments.has(7), false);
});

test("a detach error without native destruction evidence remains a failure even if it says no tab", async t => {
  const f = await fixture(t);
  await f.backend.attach(f.params);
  f.hooks.engine = () => ({
    pages: new Map(), queues: new Map(), invalidate() {}, forget() {},
    async detach() { throw new Error("crxApplication.detach: No tab with given id 7."); }
  });
  await f.backend.getBrowserEngine();
  await assert.rejects(f.backend.detachTab(7), /No tab with given id/);
});

for (const phase of ["input", "detach"]) for (const removed of [false, true]) {
  test(`${phase} cleanup rejection ${removed ? "after native removal succeeds" : "without destruction evidence fails"}`, async t => {
    const f = await fixture(t), gate = f.gate();
    await holdInput(f);
    let entered = false;
    const fail = async () => { entered = true; await gate.promise; throw new Error("fixture native cleanup rejected"); };
    if (phase === "input") f.hooks.command = async (_target, method) => { if (method === "Input.cancelDragging") await fail(); };
    else f.hooks.detach = fail;
    const releasing = f.backend.detachTab(7);
    const result = releasing.then(() => ({ ok: true }), error => ({ error }));
    await until(() => entered, `${phase} cleanup actual native entry`);
    if (removed) await f.chrome.tabs.remove(7);
    gate.resolve();
    const outcome = await result;
    if (removed) {
      assert.equal(outcome.ok, true);
      assert.equal(f.backend.inputTracker.attachments.has(7), false);
      if (phase === "input") assert.equal(f.calls.some(([method]) => method === "detach"), false);
    } else assert.match(String(outcome.error), /fixture native cleanup rejected/);
    assert.equal(f.backend.automationControl.inputBlocked, false);
  });
}

test("successful held-input completion after native removal cannot proceed to a later native detach", async t => {
  const f = await fixture(t), gate = f.gate();
  await holdInput(f);
  let entered = false;
  f.hooks.command = async (_target, method) => {
    if (method === "Input.cancelDragging") { entered = true; await gate.promise; }
  };
  const releasing = f.backend.detachTab(7);
  await until(() => entered, "native input cleanup");
  await f.chrome.tabs.remove(7);
  gate.resolve();
  await releasing;
  assert.equal(f.calls.some(([method]) => method === "detach"), false);
  assert.equal(f.calls.some(([method, , params]) => method === "Input.dispatchMouseEvent" && params.type === "mouseReleased"), false);
  assert.equal(f.calls.some(([method, , params]) => method === "Input.dispatchKeyEvent" && params.type === "keyUp"), false);
});

test("an old CRX command awaiting policy proof cannot target a replacement attachment", async t => {
  const f = await fixture(t);
  await f.backend.attach(f.params);
  await f.backend.getBrowserEngine();
  const old = f.backend.attachmentEpochs.get(7), gate = f.gate();
  Object.defineProperty(f.backend.siteAccess, "restricted", { value: true });
  f.backend.assertSiteTab = () => gate.promise;
  f.backend.assertSiteProof = () => {};
  let sent = 0;
  const command = f.engineOptions.inputHooks.send({ tabId: 7 }, "Runtime.callFunctionOn", {}, () => sent++);
  const rejected = assert.rejects(command, /OBU_TAB_CONTROL_REVOKED|OBU_INPUT_ATTACHMENT_CHANGED/);
  f.backend.revokedAttachmentTokens.add(old);
  const replacement = {};
  f.backend.attachmentEpochs.set(7, replacement);
  f.backend.inputTracker.register(7, replacement);
  gate.resolve({});
  await rejected;
  assert.equal(sent, 0);
  assert.equal(f.backend.attachmentEpochs.get(7), replacement);
});

test("host disconnect gates synchronously, drains actual held input, and retires epochs before explicit bootstrap", async t => {
  const f = await fixture(t);
  await holdInput(f);
  await f.backend.getBrowserEngine();
  const gate = f.gate();
  let releasing = false;
  f.hooks.command = async (_target, method, params) => {
    if (method === "Input.dispatchMouseEvent" && params.type === "mouseReleased") { releasing = true; await gate.promise; }
  };
  const recovery = f.backend.nativeDisconnected();
  assert.equal(f.backend.nativeDisconnected(), recovery);
  assert.throws(() => f.engineOptions.inputHooks.send({ tabId: 7 }, "Runtime.callFunctionOn", {}, () => assert.fail("late native send")), /OBU_NATIVE_RECOVERY_PENDING/);
  await assert.rejects(f.backend.getTabs(f.params), /OBU_NATIVE_RECOVERY_PENDING/);
  await until(() => releasing, "native held-input release");
  const bootstrap = f.backend.getControlState({ session_id: "task" });
  let acknowledged = false;
  bootstrap.then(() => { acknowledged = true; });
  await tick();
  assert.equal(acknowledged, false);
  assert.equal(f.attached.has(7), true);
  gate.resolve();
  const fresh = await bootstrap;
  await recovery;
  assert.ok(fresh.controlEpoch > f.params.control_epoch);
  assert.equal(f.backend.nativeRecovery, null);
  assert.equal(f.backend.automationControl.inputBlocked, false);
  assert.equal(f.attached.has(7), false);
  await assert.rejects(f.backend.getTabs(f.params), /OBU_STALE_CONTROL_EPOCH/);
  assert.ok((await f.backend.getTabs(f.fresh(f.params, fresh))).some(tab => tab.id === 7));
  assert.equal(f.backend.controlLedger.records.get("task").endedTurnId, "native-host-disconnect");
});

test("failed native input cleanup remains fenced until explicit bootstrap retries exact release", async t => {
  const f = await fixture(t);
  await holdInput(f);
  f.hooks.command = async (_target, method, params) => {
    if (method === "Input.dispatchKeyEvent" && params.type === "keyUp") throw new Error("native key release failed");
  };
  await assert.rejects(f.backend.nativeDisconnected(), /native key release failed/);
  assert.equal(f.attached.has(7), true);
  await assert.rejects(f.backend.getTabs(f.params), /OBU_NATIVE_RECOVERY_FAILED/);
  delete f.hooks.command;
  const fresh = await f.backend.getControlState({ session_id: "task" });
  assert.ok(fresh.controlEpoch > f.params.control_epoch);
  assert.equal(f.attached.has(7), false);
  assert.equal(f.backend.inputTracker.attachments.has(7), false);
});

test("native recovery does not reopen an existing user pause", async t => {
  const f = await fixture(t);
  await holdInput(f);
  await f.backend.pauseAutomation();
  await f.backend.nativeDisconnected();
  assert.equal(f.backend.automationControl.inputBlocked, true);
  await assert.rejects(f.backend.getControlState({ session_id: "task" }), /OBU_AUTOMATION_PAUSED/);
});

test("native recovery retains its fence while epoch persistence is pending and bootstrap returns a bounded error", async t => {
  const f = await fixture(t), gate = f.gate();
  await holdInput(f);
  f.backend.automationCleanupTimeoutMs = 15;
  let writing = false;
  f.hooks.write = async (_area, value) => {
    if (Object.keys(value).some(key => key.includes("CONTROL_STATE"))) { writing = true; await gate.promise; }
  };
  const recovery = f.backend.nativeDisconnected();
  await until(() => writing, "durable epoch invalidation");
  await assert.rejects(f.backend.getControlState({ session_id: "task" }), /OBU_NATIVE_RECOVERY_PENDING/);
  assert.ok(f.backend.nativeRecovery);
  await assert.rejects(f.backend.getTabs(f.params), /OBU_NATIVE_RECOVERY_PENDING/);
  gate.resolve();
  await recovery;
  assert.equal(f.backend.nativeRecovery, null);
  const fresh = await f.backend.getControlState({ session_id: "task" });
  assert.ok(fresh.controlEpoch > f.params.control_epoch);
});

test("native recovery drains a real late attach before acknowledging bootstrap and never initializes its focus", async t => {
  const f = await fixture(t), gate = f.gate();
  f.hooks.attach = () => gate.promise;
  const attaching = f.backend.attach(f.params);
  const rejected = assert.rejects(attaching, /OBU_NATIVE_RECOVERY_PENDING|cancelled/);
  await until(() => f.calls.some(([method]) => method === "attach-start"), "native attach entry");
  const recovery = f.backend.nativeDisconnected();
  const bootstrap = f.backend.getControlState({ session_id: "task" });
  let acknowledged = false;
  bootstrap.then(() => { acknowledged = true; });
  await tick();
  assert.equal(acknowledged, false);
  gate.resolve();
  await rejected;
  await recovery;
  await bootstrap;
  assert.equal(f.attached.has(7), false);
  assert.equal(f.calls.some(([method]) => method === "Emulation.setFocusEmulationEnabled"), false);
});

test("current native port disconnect signals once; stale callbacks do not revoke the replacement port", async t => {
  const f = await fixture(t), ports = [], alarms = [];
  f.chrome.runtime.id = "a".repeat(32);
  f.chrome.alarms = { onAlarm: { addListener: listener => alarms.push(listener) }, create: async () => {}, clear: async () => true };
  f.chrome.runtime.connectNative = () => {
    const port = { onMessage: event(), onDisconnect: event(), postMessage() {} };
    ports.push(port); return port;
  };
  let signals = 0;
  const transport = new f.NativeTransport("fixture.host", { onDisconnect: () => signals++ });
  const old = ports[0];
  old.onDisconnect.emit(); old.onDisconnect.emit();
  assert.equal(signals, 1);
  transport.connect();
  assert.equal(ports.length, 2);
  old.onDisconnect.emit();
  assert.equal(signals, 1);
  assert.equal(transport.port, ports[1]);
  ports[1].onDisconnect.emit();
  assert.equal(signals, 2);
  transport.connect(); // Consume the final real retry timer; leave no delayed test work.
});

test("disconnect during window discovery prevents late tab creation rather than replaying it", async t => {
  const f = await fixture(t), gate = f.gate();
  let querying = false, creations = 0;
  f.chrome.windows.getAll = async () => { querying = true; await gate.promise; return [{ id: 1, type: "normal" }]; };
  f.chrome.tabs.create = async () => { creations++; return { id: 12, windowId: 1 }; };
  const creating = f.backend.createTab(f.params);
  const rejected = assert.rejects(creating, /OBU_NATIVE_RECOVERY_PENDING/);
  await until(() => querying, "window selection");
  const recovery = f.backend.nativeDisconnected();
  gate.resolve();
  await rejected;
  await recovery;
  assert.equal(creations, 0);
});

test("disconnect during WebMCP injection prevents the later page tool invocation", async t => {
  const f = await fixture(t), gate = f.gate();
  f.backend.webMcpGate = { enabled: async () => true };
  let injected = false, invoked = 0;
  f.chrome.tabs.sendMessage = async (_id, message) => {
    if (message.type === "OPEN_BROWSER_USE_WEBMCP_REQUEST") { invoked++; return { ok: true, result: { result: "late" } }; }
    return { ok: false };
  };
  f.chrome.scripting = { executeScript: async () => { injected = true; await gate.promise; } };
  const invocation = f.backend.webmcp_invoke_tool({ ...f.params, tool_name: "test", registration_id: "current", input: {} });
  const rejected = assert.rejects(invocation, /OBU_NATIVE_RECOVERY_PENDING/);
  await until(() => injected, "first bridge injection already submitted");
  const recovery = f.backend.nativeDisconnected();
  gate.resolve();
  await rejected;
  await recovery;
  assert.equal(invoked, 0);
});

for (const externalStream of [false, true]) test(`regrouping cancels a queued raw screenshot with ${externalStream ? "caller" : "internal"} rendering while cleanup retains its attachment`, async t => {
  const f = await fixture(t), predecessor = f.gate(), cleanup = f.gate();
  await f.backend.attach(f.params);
  f.backend.renderingQueues.set(7, predecessor.promise);
  if (externalStream) f.backend.externalScreencastTabs.add(7);
  f.backend.clipboardBroker.waitForTab = () => cleanup.promise;
  let captures = 0;
  const screenshot = f.backend.withRenderingLease({ tabId: 7 }, 1000, () => { captures++; }, "screenshot");
  const rejected = assert.rejects(screenshot, /OBU_TAB_CONTROL_REVOKED/);
  f.tabs.get(7).groupId = -1;
  f.chrome.tabs.onUpdated.emit(7, { groupId: -1 });
  predecessor.resolve();
  await rejected;
  assert.equal(captures, 0);
  assert.equal(f.attached.has(7), true);
  assert.equal(f.calls.some(([method]) => method === "Page.startScreencast"), false);
  cleanup.resolve();
  await f.backend.controlReleases.get(7);
});

async function fixture(t) {
  const local = {}, session = {}, calls = [], attached = new Set(), hooks = {}, gates = [];
  const tabs = new Map([
    [7, { id: 7, groupId: 10, windowId: 1, url: "https://fixture.test/main", active: false }],
    [8, { id: 8, groupId: -1, windowId: 2, url: "https://fixture.test/popup", active: true }],
    [9, { id: 9, groupId: 20, windowId: 1, url: "https://fixture.test/other", active: false }]
  ]);
  const windows = new Map([[1, { id: 1, type: "normal", focused: true }], [2, { id: 2, type: "popup", focused: false }], [3, { id: 3, type: "popup", focused: false }]]);
  const groups = new Map([[10, { id: 10, windowId: 1 }], [20, { id: 20, windowId: 1 }]]);
  const requireTab = id => { const tab = tabs.get(id); if (!tab) throw new Error(`No tab with id: ${id}`); return tab; };
  const area = (name, state) => ({
    async get(key) { await hooks.read?.(name, key); return clone(Object.hasOwn(state, key) ? { [key]: state[key] } : {}); },
    async set(value) { const captured = clone(value); await hooks.write?.(name, captured); Object.assign(state, captured); calls.push([`${name}.set`, clone(captured)]); },
    async setAccessLevel(value) { calls.push([`${name}.setAccessLevel`, value]); }
  });
  const chrome = {
    storage: { local: area("local", local), session: area("session", session) },
    runtime: { id: "fixture", getURL: path => `chrome-extension://fixture/${path}`, getManifest: () => ({ version: "test" }) },
    debugger: { onDetach: event(), onEvent: event(),
      async attach({ tabId }) { calls.push(["attach-start", tabId]); await hooks.attach?.(tabId); requireTab(tabId); attached.add(tabId); calls.push(["attach", tabId]); },
      async detach({ tabId }) { await hooks.detach?.(tabId); attached.delete(tabId); calls.push(["detach", tabId]); },
      async getTargets() { return [...tabs.values()].map(tab => ({ id: `target-${tab.id}`, tabId: tab.id, type: "page", url: tab.url, attached: attached.has(tab.id) })); },
      async sendCommand(target, method, params) { calls.push([method, target.tabId, clone(params)]); await hooks.command?.(target, method, params); return { result: { value: "fixture" } }; }
    },
    tabs: { onRemoved: event(), onUpdated: event(), onDetached: event(), onAttached: event(), onMoved: event(), onReplaced: event(),
      async get(id) { await hooks.getTab?.(id); return clone(requireTab(id)); },
      async query(filter = {}) { await hooks.query?.(filter); return [...tabs.values()].filter(tab => (filter.groupId === undefined || tab.groupId === filter.groupId) && (filter.windowId === undefined || tab.windowId === filter.windowId)).map(clone); },
      async group({ tabIds, groupId }) { calls.push(["group", [...tabIds], groupId]); groupId ??= 30; if (!groups.has(groupId)) groups.set(groupId, { id: groupId, windowId: requireTab(tabIds[0]).windowId }); for (const id of tabIds) { const tab = requireTab(id); tab.groupId = groupId; tab.windowId = groups.get(groupId).windowId; } return groupId; },
      async ungroup(ids) { calls.push(["ungroup", [].concat(ids)]); for (const id of [].concat(ids)) { requireTab(id).groupId = -1; chrome.tabs.onUpdated.emit(id, { groupId: -1 }, clone(requireTab(id))); } },
      async remove(ids) { calls.push(["remove", [].concat(ids)]); for (const id of [].concat(ids)) { const tab = requireTab(id); tabs.delete(id); attached.delete(id); chrome.tabs.onRemoved.emit(id, { windowId: tab.windowId, isWindowClosing: false }); } },
      async sendMessage() { return { ok: true }; }
    },
    tabGroups: {
      async get(id) { if (!groups.has(id)) throw new Error(`No group with id: ${id}`); return clone(groups.get(id)); },
      async update(id, value) { calls.push(["group-update", id]); Object.assign(groups.get(id) ?? {}, value); },
      async query() { return [...groups.values()].map(clone); }
    },
    windows: { onRemoved: event(), onFocusChanged: event(),
      async get(id) { await hooks.getWindow?.(id); if (!windows.has(id)) throw new Error(`No window with id: ${id}`); return clone(windows.get(id)); },
      async getAll() { return [...windows.values()].map(clone); }
    }
  };
  let engineOptions;
  const { BrowserBackend: Backend, NativeTransport } = vm.runInNewContext(`${code}\n({ BrowserBackend, NativeTransport })`, { chrome, crypto, Date, URL, setTimeout, clearTimeout, createBrowserActionEngine: options => { engineOptions = options; return hooks.engine?.(options) ?? { pages: new Map(), queues: new Map(), invalidate() {}, detach: async () => {} }; } });
  const backend = new Backend();
  await backend.controlReady;
  for (const [id, groupId, tabId] of [["task", 10, 7], ["other", 20, 9]]) {
    const state = await backend.store.getSession(id); state.chromeGroupId = groupId; state.tabOrigins = { [tabId]: "agent" };
  }
  await backend.store.save();
  const current = await backend.getControlState({ session_id: "task" }), other = await backend.getControlState({ session_id: "other" });
  const params = { session_id: "task", turn_id: "turn", control_epoch: current.controlEpoch, tabId: 8 };
  const foreign = { session_id: "other", turn_id: "other-turn", control_epoch: other.controlEpoch, tabId: 8 };
  t.after(async () => {
    for (const gate of gates) gate.resolve();
    for (const key of Object.keys(hooks)) delete hooks[key];
    backend.networkWaits.invalidateAll();
    await Promise.allSettled([...backend.attachedTabs].map(id => backend.detachTab(id)));
  });
  return { Backend, NativeTransport, backend, chrome, local, session, calls, attached, hooks, tabs, windows, groups, params: { ...params, tabId: 7 }, foreign,
    get engineOptions() { return engineOptions; },
    gate() { const value = deferred(); gates.push(value); return value; },
    fresh(previous, next) { return { ...previous, turn_id: next.nextTurnId, control_epoch: next.controlEpoch }; },
    events: [chrome.debugger.onDetach, chrome.debugger.onEvent, ...Object.values(chrome.tabs).filter(item => item?.emit), ...Object.values(chrome.windows).filter(item => item?.emit)]
  };
}
