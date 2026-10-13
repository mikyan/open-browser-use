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
const AUX_KEY = "OPEN_BROWSER_USE_AUXILIARY_TABS";
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
    tabs: { onActivated: event(), onRemoved: event(), onUpdated: event(), onDetached: event(), onAttached: event(), onMoved: event(), onReplaced: event(),
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
  const Backend = vm.runInNewContext(`${code}\nBrowserBackend`, { chrome, crypto, Date, URL, setTimeout, clearTimeout });
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
  return { Backend, backend, chrome, local, session, calls, attached, hooks, tabs, windows, groups, params, foreign,
    gate() { const value = deferred(); gates.push(value); return value; },
    fresh(previous, next) { return { ...previous, turn_id: next.nextTurnId, control_epoch: next.controlEpoch }; },
    events: [chrome.debugger.onDetach, chrome.debugger.onEvent, ...Object.values(chrome.tabs).filter(item => item?.emit), ...Object.values(chrome.windows).filter(item => item?.emit)]
  };
}

async function ordinary(t, { dissolve = true } = {}) {
  const f = await fixture(t), state = f.backend.store.state.sessions.task;
  state.chromeGroupId = null; state.tabOrigins = {}; f.tabs.delete(7); f.groups.delete(10);
  let nextId = 100;
  f.chrome.tabs.create = async options => {
    f.calls.push(["create", clone(options)]);
    await f.hooks.create?.(options);
    const tab = { id: nextId++, groupId: -1, windowId: options.windowId, url: "about:blank", status: "complete", active: false, pinned: false };
    f.tabs.set(tab.id, tab);
    await f.hooks.created?.(tab);
    return clone(tab);
  };
  f.chrome.tabs.group = async ({ tabIds, groupId = 30 }) => {
    f.calls.push(["group", [...tabIds], groupId]);
    f.groups.set(groupId, { id: groupId, windowId: 1 });
    for (const id of tabIds) { const tab = f.tabs.get(id); tab.groupId = groupId; f.chrome.tabs.onUpdated.emit(id, { groupId }, clone(tab)); }
    await f.hooks.grouped?.(groupId, tabIds);
    if (dissolve) {
      // Actual Opera order: the native group result settles first; its group
      // disappears before the subsequent title update, not before the ACK.
      queueMicrotask(() => queueMicrotask(() => {
        for (const id of tabIds) { const tab = f.tabs.get(id); if (tab) { tab.groupId = -1; f.chrome.tabs.onUpdated.emit(id, { groupId: -1 }, clone(tab)); } }
        f.groups.delete(groupId); f.calls.push(["singleton-removed", groupId]);
      }));
    }
    return groupId;
  };
  f.chrome.tabGroups.update = async (id, value) => {
    f.calls.push(["group-update", id]); await f.hooks.updateGroup?.(id);
    if (!f.groups.has(id)) throw new Error(`No group with id: ${id}.`);
    Object.assign(f.groups.get(id), value);
  };
  const create = () => f.backend.createTab(f.params);
  return { ...f, create, scope: tabId => ({ ...f.params, tabId }) };
}

async function backgroundWindow(t) {
  const f = await fixture(t); let nextId = 100, nextWindow = 1000;
  f.chrome.tabs.create = async options => {
    f.calls.push(["create", clone(options)]);
    const tab = { id: nextId++, groupId: -1, windowId: options.windowId, url: "about:blank", status: "complete", active: false, pinned: false };
    f.tabs.set(tab.id, tab); return clone(tab);
  };
  f.chrome.windows.create = async options => {
    f.calls.push(["window-create", clone(options)]);
    await f.hooks.beforeWindowCreate?.();
    const window = { id: nextWindow++, type: "normal", focused: false };
    const tab = { id: nextId++, groupId: -1, windowId: window.id, url: "about:blank", status: "complete", active: true, pinned: false };
    f.windows.set(window.id, window); f.tabs.set(tab.id, tab);
    if (!f.hooks.deferActivation) f.chrome.tabs.onActivated.emit({ tabId: tab.id, windowId: window.id });
    await f.hooks.windowCreated?.(tab, window);
    return { ...clone(window), tabs: [clone(tab)] };
  };
  return { ...f, create: () => f.backend.createTab({ ...f.params, backgroundWindow: true }), scope: tabId => ({ ...f.params, tabId }) };
}

test("explicit background windows preserve mixed group ownership and subsequent default creation", async t => {
  const f = await backgroundWindow(t), tab = await f.create(), state = f.backend.store.state.sessions.task;
  assert.deepEqual(f.calls.find(([name]) => name === "window-create")[1], { focused: false, type: "normal", url: "about:blank" });
  assert.equal(f.backend.auxiliaryTabs.owner(tab.id).kind, "background-window");
  assert.equal(state.chromeGroupId, 10); assert.notEqual(state.ungrouped, true);
  assert.deepEqual(Array.from(await f.backend.getTabs(f.params), value => value.id).sort(), [100, 7]);
  await f.backend.requireSessionTab(f.scope(tab.id), "detach");
  const ordinary = await f.backend.createTab({ ...f.params, backgroundWindow: false });
  assert.equal(f.tabs.get(ordinary.id).groupId, 10); assert.equal(f.tabs.get(ordinary.id).windowId, 1);
  assert.equal(f.calls.filter(([name]) => name === "window-create").length, 1);
  assert.equal(f.backend.freshBlankTabs.get(tab.id).groupId, -1);
  await f.backend.waitForFreshBlankTab(tab.id, blankAdmission(f, tab.id));
  assert.equal((await f.backend.getInfo()).metadata.backgroundWindowVersion, 1);
});

test("invalid backgroundWindow options fail before any native creation", async t => {
  const f = await backgroundWindow(t);
  for (const value of [null, 0, 1, "true", {}, []]) await assert.rejects(f.backend.createTab({ ...f.params, backgroundWindow: value }), /must be a boolean/);
  assert.equal(f.calls.some(([name]) => name === "window-create" || name === "create"), false);
});

test("the sole new-window activation can arrive after its native ACK without retiring its blank marker", async t => {
  const f = await backgroundWindow(t); f.hooks.deferActivation = true;
  const tab = await f.create();
  f.chrome.tabs.onActivated.emit({ tabId: tab.id, windowId: f.tabs.get(tab.id).windowId });
  assert.equal(f.backend.freshBlankTabs.has(tab.id), true);
  await f.backend.waitForFreshBlankTab(tab.id, blankAdmission(f, tab.id));
});

for (const takeover of ["focus-back", "additional-tab", "same-group", "foreign-group"]) test(`failed background-window creation preserves user takeover: ${takeover}`, async t => {
  const f = await backgroundWindow(t);
  f.hooks.windowCreated = (tab, window) => {
    if (takeover === "focus-back") { window.focused = true; f.chrome.windows.onFocusChanged.emit(window.id); window.focused = false; }
    else if (takeover === "additional-tab") f.tabs.set(500, { id: 500, groupId: -1, windowId: window.id, active: false, url: "https://fixture.test/user" });
    else {
      tab.windowId = 1; tab.groupId = takeover === "same-group" ? 10 : 20;
      f.chrome.tabs.onDetached.emit(tab.id, { oldWindowId: window.id });
      f.chrome.tabs.onUpdated.emit(tab.id, { groupId: tab.groupId });
    }
  };
  await assert.rejects(f.create(), /CREATION_REVOKED/);
  const record = f.backend.auxiliaryTabs.entry(100);
  assert.equal(record.phase, "excluded"); assert.equal(record.kind, "background-window"); assert.equal(record.origin, "user");
  assert.equal(f.tabs.has(100), true); assert.equal(f.backend.freshBlankTabs.has(100), false);
  await assert.rejects(f.backend.requireSessionTab(f.scope(100), "detach"), unavailable);
  assert.equal((await f.backend.getTabs(f.params)).some(tab => tab.id === 100), false);
  assert.equal((await f.backend.getTabs(f.foreign)).some(tab => tab.id === 100), false);
});

for (const takeover of ["pin", "move", "window", "same-group", "foreign-group"]) test(`background-window ${takeover} revocation is sticky across moves and worker recovery`, async t => {
  const f = await backgroundWindow(t), created = await f.create(), tab = f.tabs.get(created.id), originalWindow = tab.windowId;
  if (takeover === "pin") { tab.pinned = true; f.chrome.tabs.onUpdated.emit(tab.id, { pinned: true }); }
  else if (takeover === "move") f.chrome.tabs.onMoved.emit(tab.id, { windowId: tab.windowId, fromIndex: 0, toIndex: 1 });
  else {
    tab.windowId = 1; f.chrome.tabs.onDetached.emit(tab.id, { oldWindowId: originalWindow });
    tab.groupId = takeover === "same-group" ? 10 : takeover === "foreign-group" ? 20 : -1;
    f.chrome.tabs.onUpdated.emit(tab.id, { groupId: tab.groupId });
  }
  // Even between the immediate event and asynchronous cleanup, neither group
  // inventory may infer authority from the new native position.
  assert.equal(f.backend.auxiliaryTabs.owner(tab.id), undefined);
  await Promise.all([...f.backend.auxiliaryReleases.values()]);
  assert.equal(f.backend.auxiliaryTabs.entry(tab.id).phase, "excluded");
  Object.assign(tab, { windowId: originalWindow, groupId: -1, pinned: false });
  f.chrome.tabs.onUpdated.emit(tab.id, { groupId: -1 });
  await Promise.all([...f.backend.auxiliaryReleases.values()]);
  assert.equal((await f.backend.getTabs(f.params)).some(value => value.id === tab.id), false);
  for (const event of f.events) event.clear();
  const restarted = new f.Backend(); await restarted.controlReady;
  const scope = f.fresh(f.scope(tab.id), await restarted.getControlState({ session_id: "task" }));
  await assert.rejects(restarted.requireSessionTab(scope, "detach"), unavailable);
  await restarted.claimUserTab(scope);
  assert.equal(restarted.store.state.sessions.task.tabOrigins[tab.id], "user");
  await restarted.finalizeTabs({ ...scope, keep: [] });
  assert.equal(f.tabs.has(tab.id), true); assert.equal(f.tabs.has(7), false);
});

test("background-window finalize closes only its own tab and leaves an added user tab intact", async t => {
  const f = await backgroundWindow(t), created = await f.create(), tab = f.tabs.get(created.id);
  f.tabs.set(500, { id: 500, windowId: tab.windowId, groupId: -1, url: "https://fixture.test/user", active: false });
  await f.backend.finalizeTabs({ ...f.params, keep: [] });
  assert.equal(f.tabs.has(created.id), false); assert.equal(f.tabs.has(7), false); assert.equal(f.tabs.has(500), true);
  assert.equal(f.calls.some(([name]) => name === "window-remove"), false);
  assert.equal(f.backend.auxiliaryTabs.entry(created.id), undefined);
});

test("finalize does not close a background tab moved into its old task group during native detach", async t => {
  const f = await backgroundWindow(t), created = await f.create(), tab = f.tabs.get(created.id), held = f.gate();
  await f.backend.attach(f.scope(created.id));
  let detaching = false;
  f.hooks.detach = async id => { if (id === created.id) { detaching = true; await held.promise; } };
  const ending = f.backend.finalizeTabs({ ...f.params, keep: [{ tabId: 7, status: "handoff" }] });
  await until(() => detaching, "background native detach");
  const oldWindowId = tab.windowId;
  tab.windowId = 1; tab.groupId = 10;
  f.chrome.tabs.onDetached.emit(tab.id, { oldWindowId }); f.chrome.tabs.onUpdated.emit(tab.id, { groupId: 10 });
  held.resolve(); const ended = await ending;
  assert.equal(f.tabs.has(tab.id), true); assert.equal(f.backend.auxiliaryTabs.entry(tab.id).phase, "excluded");
  const scope = f.fresh(f.scope(tab.id), ended);
  await assert.rejects(f.backend.requireSessionTab(scope, "detach"), unavailable);
});

test("healthy background-window ownership survives worker restart while an old scope stays invalid", async t => {
  const f = await backgroundWindow(t), created = await f.create();
  for (const event of f.events) event.clear();
  const restarted = new f.Backend(); await restarted.controlReady;
  await assert.rejects(restarted.requireSessionTab(f.scope(created.id), "detach"), /STALE_CONTROL_EPOCH|BOOTSTRAP_REQUIRED/);
  const scope = f.fresh(f.scope(created.id), await restarted.getControlState({ session_id: "task" }));
  assert.deepEqual(Array.from(await restarted.getTabs(scope), tab => tab.id).sort(), [100, 7]);
  assert.equal(restarted.auxiliaryTabs.owner(created.id).origin, "agent");
  await restarted.finalizeTabs({ ...scope, keep: [] }); assert.equal(f.tabs.has(created.id), false);
});

test("explicit user reclaim of a revoked background page tolerates its own native grouping events", async t => {
  const f = await backgroundWindow(t), created = await f.create(), tab = f.tabs.get(created.id);
  tab.pinned = true; f.chrome.tabs.onUpdated.emit(tab.id, { pinned: true });
  await Promise.all([...f.backend.auxiliaryReleases.values()]); tab.pinned = false;
  const group = f.chrome.tabs.group;
  f.chrome.tabs.group = async options => {
    const groupId = await group(options);
    for (const tabId of options.tabIds) f.chrome.tabs.onUpdated.emit(tabId, { groupId });
    return groupId;
  };
  await f.backend.claimUserTab(f.scope(tab.id));
  assert.equal(f.backend.store.state.sessions.task.tabOrigins[tab.id], "user");
  await f.backend.finalizeTabs({ ...f.params, keep: [] }); assert.equal(f.tabs.has(tab.id), true);
});

test("background-window handoff retains origin, deliverable releases authority without grouping or moving", async t => {
  const f = await backgroundWindow(t), created = await f.create(), originalWindow = f.tabs.get(created.id).windowId;
  const end = await f.backend.finalizeTabs({ ...f.params, keep: [{ tabId: created.id, status: "handoff" }] });
  const scope = f.fresh(f.scope(created.id), end);
  await f.backend.claimUserTab(scope);
  assert.equal(f.backend.auxiliaryTabs.owner(created.id).origin, "agent");
  await f.backend.finalizeTabs({ ...scope, keep: [{ tabId: created.id, status: "deliverable" }] });
  assert.equal(f.tabs.get(created.id).windowId, originalWindow); assert.equal(f.tabs.get(created.id).groupId, -1);
  assert.equal(f.backend.auxiliaryTabs.entry(created.id), undefined);
  const next = f.fresh(scope, await f.backend.getControlState({ session_id: "task" }));
  await assert.rejects(f.backend.requireSessionTab(next, "detach"), unavailable);
});

for (const revoke of ["pause", "end"]) test(`late background-window creation after ${revoke} closes its exact undisclosed page`, async t => {
  const f = await backgroundWindow(t), held = f.gate(); let entered = false;
  f.hooks.beforeWindowCreate = async () => { entered = true; await held.promise; };
  const creating = f.create(), rejected = assert.rejects(creating, unavailable);
  await until(() => entered, "window creation");
  const ending = revoke === "pause" ? f.backend.pauseAutomation() : f.backend.finalizeTabs({ ...f.params, keep: [] });
  await tick(); held.resolve(); await rejected; await ending;
  assert.equal(f.tabs.has(100), false); assert.equal(f.backend.auxiliaryTabs.entry(100), undefined); assert.equal(f.backend.freshBlankTabs.has(100), false);
});

test("outer create epoch rejection preserves a taken-over new background page without group readmission", async t => {
  const f = await backgroundWindow(t), original = f.backend.createTabInTurn.bind(f.backend);
  f.backend.createTabInTurn = async (...args) => {
    const result = await original(...args), tab = f.tabs.get(result.id);
    tab.windowId = 1; tab.groupId = 10;
    f.chrome.tabs.onDetached.emit(tab.id, { oldWindowId: 1000 });
    f.chrome.tabs.onUpdated.emit(tab.id, { groupId: 10 });
    f.backend.controlLedger.records.get("task").epoch++;
    return result;
  };
  await assert.rejects(f.create(), /STALE_CONTROL_EPOCH/);
  const scope = f.fresh(f.params, await f.backend.getControlState({ session_id: "task" }));
  assert.equal(f.backend.auxiliaryTabs.entry(100).phase, "excluded");
  assert.equal((await f.backend.getTabs(scope)).some(tab => tab.id === 100), false); assert.equal(f.tabs.has(100), true);
});

function blankAdmission(f, tabId, timeoutMs = 1000) {
  const deadline = performance.now() + timeoutMs;
  const timeoutError = () => new Error("fixture original deadline expired");
  return { params: f.scope(tabId), timeoutError,
    remainingMs() { const remaining = deadline - performance.now(); if (remaining <= 0) throw timeoutError(); return remaining; },
    check: () => f.backend.controlLedger.assertCurrent(f.scope(tabId)) };
}

function actionEngine(f, t) {
  const previous = globalThis.chrome; globalThis.chrome = f.chrome;
  t.after(() => { globalThis.chrome = previous; });
  let currentURL = "about:blank";
  const page = { on() {}, off() {}, locator: () => ({ count: async () => { f.calls.push(["page-count"]); return 1; } }),
    async goto(url) { f.calls.push(["page-goto", url]); currentURL = url; f.hooks.navigated?.(url); return { status: () => 200 }; },
    url: () => currentURL };
  const app = {
    async attach(id) { await f.chrome.debugger.attach({ tabId: id }); return page; },
    async detach(id) { await f.chrome.debugger.detach({ tabId: id }); }
  };
  const engine = new BrowserActionEngine({ loadRuntime: async () => ({ crx: { start: async () => app },
    setOpenBrowserUseCommandObserver() {}, setOpenBrowserUseEventFilter() {}, assertOpenBrowserUseSelector() {} }),
    authorize: async params => { await f.backend.requireSessionTab(params, "browserAction"); f.backend.rememberAttachmentOwner(params, params.tabId); },
    onBeforeAttach: (id, admission) => f.backend.prepareEngineAttachment(id, admission),
    onAttached: id => f.backend.registerEngineAttachment(id), onDetached: id => f.backend.releaseEngineAttachment(id) });
  f.backend.browserEngine = engine;
  return engine;
}

async function restrictedFresh(t, { dissolve = false } = {}) {
  const f = await ordinary(t, { dissolve });
  f.chrome.webNavigation = { async getAllFrames({ tabId }) {
    const tab = f.tabs.get(tabId);
    f.calls.push(["site-frames", tabId, tab?.url]);
    return tab?.url ? [{ frameId: 0, parentFrameId: -1, url: tab.url, documentId: `doc-${tabId}`,
      documentLifecycle: "active", errorOccurred: false }] : [];
  } };
  await f.backend.siteAccess.replace({ mode: "allow", origins: ["https://fixture.test"] }, 0, f.backend.siteAccess.generation);
  f.hooks.created = tab => Object.assign(tab, { url: "", pendingUrl: "about:blank", status: "loading" });
  const tab = await f.create(); actionEngine(f, t);
  const live = f.tabs.get(tab.id), marker = f.backend.freshBlankTabs.get(tab.id);
  f.hooks.navigated = url => Object.assign(live, { url, pendingUrl: undefined, status: "complete" });
  const ready = () => Object.assign(live, { url: "about:blank", pendingUrl: undefined, status: "complete" });
  const goto = extra => f.backend.browserAction({ ...f.scope(tab.id), action: "goto", args: { url: "https://fixture.test/next" }, timeoutMs: 1000, ...extra });
  f.calls.length = 0;
  return { ...f, tab, live, marker, ready, goto };
}

for (const dissolve of [false, true]) test(`restricted fresh ${dissolve ? "ordinary" : "grouped"} goto waits before complete website inspection`, async t => {
  const f = await restrictedFresh(t, { dissolve }), held = f.gate(); let entering = false, settled = false;
  const wait = f.backend.waitForFreshBlankTab.bind(f.backend);
  f.backend.waitForFreshBlankTab = (...args) => { entering = true; return wait(...args); };
  f.hooks.getTab = async () => { if (entering) { await held.promise; f.ready(); delete f.hooks.getTab; } };
  const action = f.goto().finally(() => { settled = true; }); action.catch(() => {});
  await until(() => entering || settled, "fresh gate or original rejection");
  assert.equal(entering, true, "the exact fresh-creation gate must precede an incomplete blank site snapshot");
  assert.equal(settled, false);
  assert.equal(f.calls.some(([name]) => name === "site-frames" || name === "attach-start" || name === "page-goto"), false);
  held.resolve(); assert.equal((await action).value.status, 200);
  assert.equal(f.backend.freshBlankTabs.has(f.tab.id), false);
  const frames = f.calls.findIndex(([name]) => name === "site-frames"), attach = f.calls.findIndex(([name]) => name === "attach-start");
  assert.ok(frames >= 0 && attach > frames);
  assert.equal(f.calls.filter(([name]) => name === "page-goto").length, 1);
  assert.ok(f.calls.filter(([name]) => name === "site-frames").every(([, , url]) => Boolean(url)));
});

test("restricted fresh goto rejects foreign scope before document reads or attachment", async t => {
  const f = await restrictedFresh(t);
  await assert.rejects(f.goto({ session_id: f.foreign.session_id, turn_id: f.foreign.turn_id, control_epoch: f.foreign.control_epoch }), /not part of browser session|CREATION_REVOKED/);
  assert.equal(f.calls.some(([name]) => ["site-frames", "attach-start", "page-goto"].includes(name)), false);
  assert.equal(f.backend.freshBlankTabs.get(f.tab.id), f.marker);
});

for (const change of ["epoch", "group", "pause"]) test(`restricted fresh goto cannot continue after ${change} changes during its original read`, async t => {
  const f = await restrictedFresh(t), held = f.gate(); let entering = false, settled = false;
  const wait = f.backend.waitForFreshBlankTab.bind(f.backend);
  f.backend.waitForFreshBlankTab = (...args) => { entering = true; return wait(...args); };
  f.hooks.getTab = async () => { if (entering) await held.promise; };
  const action = f.goto().finally(() => { settled = true; }); action.catch(() => {});
  await until(() => entering || settled, "fresh gate or original rejection"); assert.equal(entering, true);
  if (change === "epoch") f.backend.controlLedger.invalidate(f.backend.controlLedger.records.get("task"), "fixture changed");
  if (change === "group") { f.live.groupId = 20; f.chrome.tabs.onUpdated.emit(f.tab.id, { groupId: 20 }); }
  if (change === "pause") f.backend.automationControl.block();
  f.ready(); held.resolve();
  await assert.rejects(action, /STALE_CONTROL_EPOCH|CREATION_REVOKED|not part of browser session|AUTOMATION_PAUSED/);
  assert.equal(f.calls.some(([name]) => ["site-frames", "attach-start", "page-goto"].includes(name)), false);
});

test("restricted fresh goto deadline rejects a held native read and prevents late attachment", async t => {
  const f = await restrictedFresh(t), held = f.gate(); let entering = false, settled = false;
  const wait = f.backend.waitForFreshBlankTab.bind(f.backend);
  f.backend.waitForFreshBlankTab = (...args) => { entering = true; return wait(...args); };
  f.hooks.getTab = async () => { if (entering) await held.promise; };
  const action = f.goto({ timeoutMs: 30 }).finally(() => { settled = true; }); action.catch(() => {});
  await until(() => entering || settled, "fresh gate or original rejection"); assert.equal(entering, true);
  await assert.rejects(action, /timed out/i);
  const reads = f.calls.length; f.ready(); held.resolve(); await tick(); await tick();
  assert.equal(f.calls.length, reads); assert.equal(f.backend.freshBlankTabs.get(f.tab.id), f.marker);
  assert.equal(f.calls.some(([name]) => ["site-frames", "attach-start", "page-goto"].includes(name)), false);
});

test("restricted goto without the exact fresh marker still rejects an unknown document", async t => {
  const f = await restrictedFresh(t); f.backend.retireFreshBlankTab(f.marker);
  await assert.rejects(f.goto(), /OBU_SITE_ACCESS_UNVERIFIED/);
  assert.equal(f.calls.filter(([name]) => name === "site-frames").length, 1);
  assert.equal(f.calls.some(([name]) => name === "attach-start" || name === "page-goto"), false);
});

test("fresh blank readiness never authorizes an empty native frame snapshot", async t => {
  const f = await restrictedFresh(t); f.ready();
  let reads = 0; f.chrome.webNavigation.getAllFrames = async () => { reads++; return []; };
  await assert.rejects(f.goto(), /OBU_SITE_ACCESS_UNVERIFIED/);
  assert.equal(reads, 1);
  assert.equal(f.calls.some(([name]) => name === "attach-start" || name === "page-goto"), false);
});

for (const dissolve of [true, false]) test(`fresh ${dissolve ? "ordinary" : "grouped"} creation waits for committed blank and consumes only its exact marker`, async t => {
  const f = await ordinary(t, { dissolve }), tab = await f.create(), live = f.tabs.get(tab.id);
  const marker = f.backend.freshBlankTabs.get(tab.id);
  assert.equal(marker.transaction.admitted, true); assert.equal(marker.transaction.finished, true);
  let reads = 0;
  live.url = ""; live.pendingUrl = "about:blank"; live.status = "loading";
  f.hooks.getTab = id => { assert.equal(id, tab.id); if (++reads === 2) Object.assign(live, { url: "about:blank", pendingUrl: undefined, status: "complete" }); };
  await f.backend.waitForFreshBlankTab(tab.id, blankAdmission(f, tab.id));
  assert.equal(reads, 2); assert.equal(f.backend.freshBlankTabs.has(tab.id), false);
  assert.equal(f.calls.some(([name]) => name === "attach"), false);
});

test("fresh marker exists before ordinary publication and waits for the outer mutation's final admission", async t => {
  const f = await ordinary(t), held = f.gate(); let publishing = false;
  const setActive = f.backend.setSessionActiveTab.bind(f.backend);
  f.backend.setSessionActiveTab = async (...args) => { publishing = true; await held.promise; return setActive(...args); };
  const creating = f.create();
  await until(() => publishing, "ordinary publication");
  const marker = f.backend.freshBlankTabs.get(100);
  assert.ok(marker); assert.notEqual(marker.transaction.admitted, true);
  let reads = 0; f.hooks.getTab = () => { reads++; };
  const waiting = f.backend.waitForFreshBlankTab(100, blankAdmission(f, 100));
  await tick(); assert.equal(reads, 0);
  held.resolve(); await creating; await waiting;
  assert.equal(marker.transaction.admitted, true); assert.equal(f.backend.freshBlankTabs.has(100), false);
});

test("failed inner creation admission withdraws its early marker", async t => {
  const f = await ordinary(t);
  f.backend.setSessionActiveTab = async () => { throw new Error("fixture final admission failed"); };
  await assert.rejects(f.create(), /final admission failed/);
  assert.equal(f.backend.freshBlankTabs.size, 0); assert.equal(f.tabs.has(100), false);
});

test("outer final epoch rejection withdraws the marker after createTabInTurn has returned successfully", async t => {
  const f = await ordinary(t), create = f.backend.createTabInTurn.bind(f.backend); let marker;
  f.backend.createTabInTurn = async (...args) => {
    const result = await create(...args);
    marker = f.backend.freshBlankTabs.get(result.id);
    assert.ok(marker); assert.notEqual(marker.transaction.admitted, true);
    f.backend.controlLedger.invalidate(f.backend.controlLedger.records.get("task"), "fixture epoch changed");
    return result;
  };
  await assert.rejects(f.create(), /STALE_CONTROL_EPOCH/);
  assert.equal(marker.transaction.finished, true); assert.notEqual(marker.transaction.admitted, true);
  assert.equal(f.backend.freshBlankTabs.size, 0); assert.equal(f.tabs.has(100), false);
});

test("a wrong fresh scope or native location cannot be skipped as an existing page", async t => {
  const f = await ordinary(t), tab = await f.create(), marker = f.backend.freshBlankTabs.get(tab.id);
  const wrong = blankAdmission(f, tab.id); wrong.params = { ...wrong.params, turn_id: "different" };
  await assert.rejects(f.backend.waitForFreshBlankTab(tab.id, wrong), /CREATION_REVOKED/);
  f.tabs.get(tab.id).windowId = 99;
  await assert.rejects(f.backend.waitForFreshBlankTab(tab.id, blankAdmission(f, tab.id)), /CREATION_REVOKED/);
  assert.equal(f.backend.freshBlankTabs.get(tab.id), marker);
});

test("same-group late ACK preserves fresh state while activation and completed prior navigation retire it", async t => {
  const f = await ordinary(t, { dissolve: false }), tab = await f.create(), marker = f.backend.freshBlankTabs.get(tab.id);
  f.chrome.tabs.onUpdated.emit(tab.id, { groupId: 30 }); assert.equal(f.backend.freshBlankTabs.get(tab.id), marker);
  f.chrome.tabs.onActivated.emit({ tabId: tab.id, windowId: 1 }); assert.equal(f.backend.freshBlankTabs.has(tab.id), false);
  const other = await f.create(); f.tabs.get(other.id).url = "https://fixture.test/already-navigated";
  await f.backend.waitForFreshBlankTab(other.id, blankAdmission(f, other.id));
  assert.equal(f.backend.freshBlankTabs.has(other.id), false);
});

test("a held native readiness read times out without consuming fresh state or attaching late", async t => {
  const f = await ordinary(t), tab = await f.create(), marker = f.backend.freshBlankTabs.get(tab.id), held = f.gate();
  let reads = 0;
  f.hooks.getTab = async () => { reads++; await held.promise; };
  await assert.rejects(f.backend.waitForFreshBlankTab(tab.id, blankAdmission(f, tab.id, 20)), /original deadline/);
  assert.equal(f.backend.freshBlankTabs.get(tab.id), marker);
  delete f.hooks.getTab;
  await f.backend.waitForFreshBlankTab(tab.id, blankAdmission(f, tab.id));
  held.resolve(); await tick();
  assert.equal(reads, 1); assert.equal(f.backend.freshBlankTabs.size, 0);
  assert.equal(f.calls.some(([name]) => name === "attach"), false);
});

test("retiring a fresh marker cancels a held read immediately without new native work", async t => {
  const f = await ordinary(t), tab = await f.create(), held = f.gate(); let reading = false;
  f.hooks.getTab = async () => { reading = true; await held.promise; };
  const pending = assert.rejects(f.backend.waitForFreshBlankTab(tab.id, blankAdmission(f, tab.id)), /CREATION_REVOKED/);
  await until(() => reading, "fresh read");
  f.chrome.tabs.onDetached.emit(tab.id); await pending;
  held.resolve(); await tick(); assert.equal(f.backend.freshBlankTabs.size, 0);
});

test("an active singleton in a newly created unfocused window retains the existing creation contract", async t => {
  const f = await ordinary(t); f.windows.delete(1);
  f.chrome.windows.getAll = async () => [...f.windows.values()].filter(window => window.type === "normal").map(clone);
  f.chrome.windows.create = async options => {
    assert.equal(options.focused, false);
    const tab = { id: 100, windowId: 4, groupId: -1, active: true, url: "about:blank", status: "complete" };
    f.tabs.set(100, tab); f.windows.set(4, { id: 4, type: "normal", focused: false });
    return { ...f.windows.get(4), tabs: [clone(tab)] };
  };
  const tab = await f.create();
  assert.equal(f.backend.freshBlankTabs.get(tab.id).ownWindow, true);
  await f.backend.waitForFreshBlankTab(tab.id, blankAdmission(f, tab.id));
  assert.equal(f.tabs.get(tab.id).active, true); assert.equal(f.windows.get(4).focused, false);
});

for (const path of ["dispatch", "withPage", "transfer"]) test(`${path} cold creator waits for fresh readiness using its existing budget`, async t => {
  const f = await ordinary(t), tab = await f.create(), engine = actionEngine(f, t), held = f.gate();
  const wait = f.backend.waitForFreshBlankTab.bind(f.backend); let entering = false;
  f.backend.waitForFreshBlankTab = async (...args) => { entering = true; return wait(...args); };
  f.hooks.getTab = async () => { if (entering) await held.promise; };
  const params = { ...f.scope(tab.id), action: "count", locator: [{ kind: "css", selector: "body" }], timeoutMs: 1000 };
  const run = path === "dispatch" ? f.backend.browserAction(params) : path === "withPage"
    ? engine.withPage(params, { deadlineAt: performance.now() + 1000 }, () => "registered")
    : f.backend.prepareTransferAttachment(params, Date.now() + 1000);
  await until(() => entering, "cold gate"); await tick(); assert.equal(f.calls.some(([name]) => name === "attach-start"), false);
  held.resolve(); await run;
  assert.equal(f.calls.filter(([name]) => name === "attach").length, 1);
  assert.equal(f.backend.freshBlankTabs.size, 0);
  let warmReads = 0; f.backend.waitForFreshBlankTab = async () => { warmReads++; };
  await engine.withPage(params, { deadlineAt: performance.now() + 1000 }, () => {});
  assert.equal(warmReads, 0);
});

test("Pause during a cold readiness read drains without a false native cleanup failure", async t => {
  const f = await ordinary(t), tab = await f.create(), engine = actionEngine(f, t), held = f.gate();
  const wait = f.backend.waitForFreshBlankTab.bind(f.backend); let reading = false;
  f.backend.waitForFreshBlankTab = async (...args) => { reading = true; return wait(...args); };
  f.hooks.getTab = async () => { if (reading) await held.promise; };
  const rejected = assert.rejects(engine.dispatch({ ...f.scope(tab.id), action: "count", locator: [{ kind: "css", selector: "body" }], timeoutMs: 1000 }), /PAUSED|CREATION_REVOKED|cancelled/);
  await until(() => reading, "fresh gate");
  const paused = f.backend.pauseAutomation(); held.resolve(); await paused; await rejected;
  assert.equal(f.calls.some(([name]) => name === "attach-start"), false);
  assert.equal(f.backend.pendingAttachmentTabs.size, 0); assert.equal(engine.pages.size, 0);
});

test("transfer sharing another creator behind a release barrier cannot detach it on its own deadline", async t => {
  const f = await ordinary(t), tab = await f.create(), engine = actionEngine(f, t);
  const releasing = f.gate(), native = f.gate(); let attaching = false;
  engine.releases.set(tab.id, releasing.promise);
  f.hooks.attach = async () => { attaching = true; await native.promise; };
  const original = engine.attach(tab.id);
  const transfer = assert.rejects(f.backend.prepareTransferAttachment(f.scope(tab.id), Date.now() + 40), /TRANSFER_TIMEOUT/);
  releasing.resolve(); await until(() => attaching, "other creator attach");
  await transfer;
  assert.equal(f.calls.some(([name]) => name === "detach"), false);
  assert.equal(engine.generations.get(tab.id) ?? 0, 0);
  native.resolve(); await original;
  assert.equal(f.calls.filter(([name]) => name === "attach").length, 1);
});

test("a raw attach joining a gated engine creator shares readiness without retiring its marker", async t => {
  const f = await ordinary(t), tab = await f.create(), engine = actionEngine(f, t), held = f.gate();
  const wait = f.backend.waitForFreshBlankTab.bind(f.backend); let entering = false;
  f.backend.waitForFreshBlankTab = async (...args) => { entering = true; return wait(...args); };
  f.hooks.getTab = async () => { if (entering) await held.promise; };
  const action = engine.dispatch({ ...f.scope(tab.id), action: "count", locator: [{ kind: "css", selector: "body" }], timeoutMs: 1000 });
  await until(() => entering, "engine creator gate"); await tick();
  const marker = f.backend.freshBlankTabs.get(tab.id), original = engine.pages.get(tab.id);
  // Only the original gate read stays held; the joining RPC can authorize and
  // reach the exact shared engine promise without releasing that read.
  delete f.hooks.getTab;
  const raw = f.backend.attach(f.scope(tab.id));
  await tick(); await tick();
  assert.equal(f.backend.freshBlankTabs.get(tab.id), marker);
  assert.equal(engine.pages.get(tab.id), original);
  assert.equal(f.calls.some(([name]) => name === "attach-start"), false);
  held.resolve(); await action; await raw;
  assert.equal(f.calls.filter(([name]) => name === "attach").length, 1);
});

test("the observed singleton dissolution admits one and multiple background pages with exact ungrouped ownership", async t => {
  const f = await ordinary(t), one = await f.create(), two = await f.create();
  assert.deepEqual([one.id, two.id], [100, 101]);
  assert.equal(f.calls.filter(([name]) => name === "group").length, 1);
  assert.ok(f.calls.filter(([name]) => name === "create").every(([, options]) => options.active === false));
  assert.equal(f.backend.store.state.sessions.task.chromeGroupId, null);
  for (const id of [100, 101]) {
    const record = f.backend.auxiliaryTabs.owner(id);
    assert.equal(record.kind, "ordinary"); assert.equal(record.origin, "agent");
    await f.backend.attach(f.scope(id));
    await f.backend.executeCdp({ ...f.scope(id), target: { tabId: id }, method: "Page.navigate", commandParams: { url: "https://fixture.test/research" } });
    f.tabs.get(id).url = "https://fixture.test/research";
    f.chrome.tabs.onUpdated.emit(id, { url: "https://fixture.test/research" }, clone(f.tabs.get(id)));
    await f.backend.requireSessionTab(f.scope(id), "attach");
    await f.backend.ownedDocumentSource(f.scope(id), "EXPORT");
    await assert.rejects(f.backend.claimUserTab({ ...f.foreign, tabId: id }), unavailable);
  }
  assert.deepEqual(Array.from(await f.backend.getTabs(f.params), tab => tab.id), [100, 101]);
  await f.backend.finalizeTabs({ ...f.params, keep: [] });
  assert.equal(f.tabs.has(100), false); assert.equal(f.tabs.has(101), false);
  assert.equal(f.backend.auxiliaryTabs.entry(100), undefined);
});

test("a stale stored group cannot prevent fallback for this admission's actual newly created singleton", async t => {
  const f = await ordinary(t);
  f.backend.store.state.sessions.task.chromeGroupId = 999;
  const tab = await f.create();
  assert.equal(tab.id, 100); assert.equal(f.backend.auxiliaryTabs.owner(100).kind, "ordinary");
  assert.deepEqual(f.calls.filter(([name]) => name === "group").map(([, , groupId]) => groupId), [30]);
  assert.equal(f.backend.store.state.sessions.task.chromeGroupId, null);
});

test("ordinary handoff survives a new epoch; single and multiple deliverables remain real tabs without task authority", async t => {
  const f = await ordinary(t), one = await f.create(), two = await f.create();
  const ended = await f.backend.finalizeTabs({ ...f.params, keep: [{ tabId: one.id, status: "handoff" }, { tabId: two.id, status: "deliverable" }] });
  await assert.rejects(f.backend.attach(f.scope(one.id)), /STALE_CONTROL_EPOCH/);
  const scope = f.fresh(f.scope(one.id), ended);
  assert.deepEqual(Array.from(await f.backend.getTabs(scope), tab => tab.id), [one.id]);
  assert.equal(f.tabs.has(two.id), true); assert.equal(f.backend.auxiliaryTabs.entry(two.id), undefined);
  assert.equal(f.backend.store.state.deliverableGroups[1], undefined);
  await f.backend.attach(scope);
  const third = await f.backend.createTab(scope);
  await f.backend.finalizeTabs({ ...scope, keep: [{ tabId: one.id, status: "deliverable" }, { tabId: third.id, status: "deliverable" }] });
  assert.ok([one.id, two.id, third.id].every(id => f.tabs.has(id) && !f.backend.auxiliaryTabs.entry(id)));
  const current = f.fresh(scope, await f.backend.getControlState({ session_id: "task" }));
  await assert.rejects(f.backend.attach(current), unavailable);
});

test("ordinary user claims preserve their origin and are released without closing", async t => {
  const f = await ordinary(t); await f.create();
  f.tabs.set(55, { id: 55, groupId: -1, windowId: 1, url: "https://fixture.test/user", active: false });
  await f.backend.claimUserTab(f.scope(55));
  await f.backend.claimUserTab(f.scope(100));
  assert.equal(f.backend.auxiliaryTabs.owner(55).origin, "user");
  assert.equal(f.backend.auxiliaryTabs.owner(100).origin, "agent");
  await f.backend.finalizeTabs({ ...f.params, keep: [] });
  assert.equal(f.tabs.has(55), true); assert.equal(f.tabs.has(100), false);
  assert.equal(f.calls.some(([name, ids]) => name === "ungroup" && ids.includes(55)), false);
});

test("an explicit fresh ordinary user claim may select ungrouped mode only after its own singleton disappears", async t => {
  const f = await ordinary(t);
  f.tabs.set(55, { id: 55, groupId: -1, windowId: 1, url: "https://fixture.test/user", active: false });
  await f.backend.claimUserTab(f.scope(55));
  assert.equal(f.backend.auxiliaryTabs.owner(55).kind, "ordinary");
  assert.equal(f.backend.auxiliaryTabs.owner(55).origin, "user");
  await f.backend.attach(f.scope(55));
  await f.backend.finalizeTabs({ ...f.params, keep: [] });
  assert.equal(f.tabs.has(55), true);
});

test("explicit user claim can recover a stale group using its actual newly created singleton", async t => {
  const f = await ordinary(t);
  f.backend.store.state.sessions.task.chromeGroupId = 999;
  f.tabs.set(55, { id: 55, groupId: -1, windowId: 1, url: "https://fixture.test/user", active: false });
  await f.backend.claimUserTab(f.scope(55));
  assert.equal(f.backend.auxiliaryTabs.owner(55).kind, "ordinary");
  assert.equal(f.backend.auxiliaryTabs.owner(55).origin, "user");
});

test("normal grouped creation remains grouped and later withdrawal never becomes ungrouped authority", async t => {
  const f = await ordinary(t, { dissolve: false }), tab = await f.create();
  assert.equal(f.tabs.get(tab.id).groupId, 30); assert.equal(f.backend.auxiliaryTabs.entry(tab.id), undefined);
  assert.notEqual(f.backend.store.state.sessions.task.ungrouped, true);
  await f.backend.attach(f.scope(tab.id));
  f.tabs.get(tab.id).groupId = -1; f.chrome.tabs.onUpdated.emit(tab.id, { groupId: -1 });
  await assert.rejects(f.backend.attach(f.scope(tab.id)), unavailable);
});

test("re-claiming a live same-group task page preserves agent disposition after handoff", async t => {
  const f = await ordinary(t, { dissolve: false }), tab = await f.create();
  const ended = await f.backend.finalizeTabs({ ...f.params, keep: [{ tabId: tab.id, status: "handoff" }] });
  const scope = f.fresh(f.scope(tab.id), ended);
  await f.backend.claimUserTab(scope);
  assert.equal(f.backend.store.state.sessions.task.tabOrigins[String(tab.id)], "agent");
  await f.backend.finalizeTabs({ ...scope, keep: [] });
  assert.equal(f.tabs.has(tab.id), false);
});

test("claiming a page that left its old group does not inherit stale agent origin", async t => {
  const f = await ordinary(t, { dissolve: false }), tab = await f.create();
  f.tabs.get(tab.id).groupId = -1;
  f.chrome.tabs.onUpdated.emit(tab.id, { groupId: -1 });
  assert.equal(f.backend.store.state.sessions.task.tabOrigins[String(tab.id)], "agent");
  await f.backend.claimUserTab(f.scope(tab.id));
  assert.equal(f.backend.store.state.sessions.task.tabOrigins[String(tab.id)], "user");
  await f.backend.finalizeTabs({ ...f.params, keep: [] });
  assert.equal(f.tabs.has(tab.id), true);
  assert.equal(f.tabs.get(tab.id).groupId, -1);
});

for (const mutation of ["pin", "move", "window"]) test(`ungrouped ${mutation} withdrawal is sticky even after moving back`, async t => {
  const f = await ordinary(t), tab = await f.create(); await f.backend.attach(f.scope(tab.id));
  if (mutation === "pin") { f.tabs.get(tab.id).pinned = true; f.chrome.tabs.onUpdated.emit(tab.id, { pinned: true }); f.tabs.get(tab.id).pinned = false; }
  else if (mutation === "move") f.chrome.tabs.onMoved.emit(tab.id, { windowId: 1, fromIndex: 1, toIndex: 2 });
  else { f.tabs.get(tab.id).windowId = 3; f.chrome.tabs.onDetached.emit(tab.id, { oldWindowId: 1 }); f.tabs.get(tab.id).windowId = 1; }
  await Promise.allSettled([...f.backend.auxiliaryReleases.values()]);
  await assert.rejects(f.backend.attach(f.scope(tab.id)), unavailable);
  assert.equal(f.tabs.has(tab.id), true);
});

for (const boundary of ["pause", "end"]) test(`a real late create drains and closes its undisclosed tab after ${boundary}`, async t => {
  const f = await ordinary(t), gate = f.gate(); let entered = false;
  f.hooks.create = async () => { entered = true; await gate.promise; };
  const creating = f.create().then(value => ({ value }), error => ({ error }));
  await until(() => entered, "native create");
  let finished = false;
  const ending = (boundary === "pause" ? f.backend.pauseAutomation() : f.backend.turnEnded(f.params)).then(value => { finished = true; return value; });
  await tick(); assert.equal(finished, false);
  gate.resolve(); const result = await creating; assert.ok(result.error); await ending;
  assert.equal(f.tabs.has(100), false); assert.equal(f.calls.filter(([name]) => name === "create").length, 1);
  assert.equal(f.backend.auxiliaryTabs.creations.size, 0);
});

test("a group ACK captured during end can still clean exactly the newly created grouped page", async t => {
  const f = await ordinary(t, { dissolve: false }), gate = f.gate(); let grouped = false;
  f.hooks.grouped = async () => { grouped = true; await gate.promise; };
  const creating = f.create().then(value => ({ value }), error => ({ error }));
  await until(() => grouped, "native group before ACK");
  const ending = f.backend.turnEnded(f.params); gate.resolve();
  assert.ok((await creating).error); await ending;
  assert.equal(f.tabs.has(100), false); assert.equal(f.calls.filter(([name]) => name === "create").length, 1);
});

for (const mutation of ["activation", "foreign-group", "foreign-group-without-event"]) test(`failed creation preserves a page taken over by ${mutation}`, async t => {
  const f = await ordinary(t, { dissolve: false });
  if (mutation === "activation") f.hooks.created = async tab => { tab.active = true; f.chrome.tabs.onActivated.emit({ tabId: tab.id, windowId: tab.windowId }); };
  else f.hooks.updateGroup = async () => {
    f.tabs.get(100).groupId = 20;
    if (mutation === "foreign-group") f.chrome.tabs.onUpdated.emit(100, { groupId: 20 });
  };
  await assert.rejects(f.create(), /CREATION_REVOKED/);
  assert.equal(f.tabs.has(100), true); assert.equal(f.calls.some(([name, ids]) => name === "remove" && ids.includes(100)), false);
});

test("creation storage failure cleans only its native page and never grants membership", async t => {
  const f = await ordinary(t); let failures = 0;
  f.hooks.write = async (area, value) => {
    if (area === "session" && value[AUX_KEY]?.records.some(record => record.origin === "agent" && record.phase === "pending") && !failures++) throw new Error("fixture persistence failed");
  };
  await assert.rejects(f.create(), /fixture persistence failed/);
  assert.equal(f.tabs.has(100), false); assert.equal(f.backend.auxiliaryTabs.entry(100), undefined);
});

test("failed first group persistence clears only its own empty pointer before a queued same-session retry", async t => {
  const f = await ordinary(t); let failed = false;
  f.hooks.write = async (area, value) => {
    if (!failed && area === "local" && value.OPEN_BROWSER_USE_SESSION_STATE?.sessions.task.chromeGroupId === 30) {
      failed = true; throw new Error("fixture group persistence failed");
    }
  };
  const first = f.create().then(value => ({ value }), error => ({ error }));
  const second = f.create();
  assert.match(String((await first).error), /fixture group persistence failed/);
  const retried = await second;
  assert.equal(retried.id, 101); assert.equal(f.tabs.has(100), false);
  assert.equal(f.backend.auxiliaryTabs.owner(101).kind, "ordinary");
  assert.equal(f.backend.store.state.sessions.task.chromeGroupId, null);
});

test("native close failure retains quarantine and capacity until exact explicit cleanup succeeds", async t => {
  const f = await ordinary(t); const remove = f.chrome.tabs.remove;
  f.hooks.updateGroup = async () => { throw new Error("fixture update failure"); };
  // A surviving group cannot use the singleton fallback.
  f.chrome.tabs.group = async ({ tabIds }) => { for (const id of tabIds) f.tabs.get(id).groupId = 30; f.groups.set(30, { id: 30 }); return 30; };
  f.chrome.tabs.remove = async () => { throw new Error("fixture close failed"); };
  await assert.rejects(f.create(), /CREATION_CLEANUP_FAILED/);
  const record = f.backend.auxiliaryTabs.entry(100);
  assert.equal(record.phase, "quarantined"); assert.equal(f.backend.auxiliaryTabs.owner(100), undefined);
  f.chrome.tabs.remove = remove;
  await f.backend.releaseAuxiliaryClaim(record);
  assert.equal(f.backend.auxiliaryTabs.entry(100), undefined);
  assert.equal(f.tabs.has(100), false);
});

for (const takeover of ["activate-back", "move", "navigate-back"]) test(`failed close continues observing ${takeover} before cleanup retry`, async t => {
  const f = await ordinary(t, { dissolve: false }), remove = f.chrome.tabs.remove;
  f.hooks.updateGroup = async () => { throw new Error("fixture update failure"); };
  f.chrome.tabs.remove = async () => { throw new Error("fixture close failed"); };
  await assert.rejects(f.create(), /CREATION_CLEANUP_FAILED/);
  const record = f.backend.auxiliaryTabs.entry(100);
  if (takeover === "activate-back") {
    f.tabs.get(100).active = true; f.chrome.tabs.onActivated.emit({ tabId: 100, windowId: 1 }); f.tabs.get(100).active = false;
  } else if (takeover === "move") f.chrome.tabs.onMoved.emit(100, { windowId: 1, fromIndex: 1, toIndex: 2 });
  else { f.chrome.tabs.onUpdated.emit(100, { url: "https://fixture.test/taken" }); f.chrome.tabs.onUpdated.emit(100, { url: "about:blank" }); }
  f.chrome.tabs.remove = remove;
  await f.backend.releaseAuxiliaryClaim(record);
  assert.equal(f.tabs.has(100), true); assert.equal(f.backend.auxiliaryTabs.entry(100), undefined);
  assert.equal((await f.backend.getTabs(f.params)).some(tab => tab.id === 100), false);
  delete f.hooks.updateGroup;
  const next = await f.create();
  assert.equal(next.id, 101); assert.equal(f.tabs.has(100), true);
});

test("ordinary ownership survives worker recovery while old epoch and replacement browser IDs remain fenced", async t => {
  const f = await ordinary(t), tab = await f.create();
  await f.backend.attach(f.scope(tab.id));
  for (const event of f.events) event.clear();
  // Simulate a worker dying between durable membership and local visual-mode
  // persistence: exact membership still wins over that stale group metadata.
  f.local.OPEN_BROWSER_USE_SESSION_STATE.sessions.task.ungrouped = false;
  f.local.OPEN_BROWSER_USE_SESSION_STATE.sessions.task.chromeGroupId = 999;
  const restarted = new f.Backend(); await restarted.controlReady;
  await assert.rejects(restarted.attach(f.scope(tab.id)), /STALE_CONTROL_EPOCH|BOOTSTRAP_REQUIRED/);
  const scope = f.fresh(f.scope(tab.id), await restarted.getControlState({ session_id: "task" }));
  assert.ok((await restarted.getTabs(scope)).some(value => value.id === tab.id));
  await restarted.attach(scope); await restarted.detach(scope);
  for (const key of Object.keys(f.session)) delete f.session[key];
  for (const event of f.events) event.clear();
  const replacement = new f.Backend(); await replacement.controlReady;
  const fresh = f.fresh(scope, await replacement.getControlState({ session_id: "task" }));
  await assert.rejects(replacement.attach(fresh), unavailable);
  assert.equal(f.tabs.has(tab.id), true);
});

async function excludedCreation(t, { failExclusionWrite = false } = {}) {
  const f = await ordinary(t, { dissolve: false });
  await f.create(); // An already accepted page keeps G; only the second is denied.
  f.hooks.updateGroup = async () => {
    f.chrome.tabs.onActivated.emit({ tabId: 101, windowId: 1 });
    throw new Error("fixture failed admission after takeover");
  };
  if (failExclusionWrite) f.hooks.write = async (area, value) => {
    if (area === "session" && value[AUX_KEY]?.records.some(record => record.phase === "excluded")) throw new Error("fixture exclusion write failed");
  };
  await assert.rejects(f.create(), failExclusionWrite ? /CREATION_CLEANUP_FAILED/ : /fixture failed admission|CREATION_REVOKED/);
  delete f.hooks.updateGroup;
  return f;
}

test("a failed creation taken over inside an existing group remains excluded through Pause and worker recovery", async t => {
  const f = await excludedCreation(t), record = f.backend.auxiliaryTabs.entry(101);
  assert.equal(record.phase, "excluded"); assert.equal(record.excludedGroupId, 30); assert.equal(record.origin, "user");
  assert.equal(f.backend.store.state.sessions.task.chromeGroupId, 30);
  assert.deepEqual(Array.from(await f.backend.getTabs(f.params), tab => tab.id), [100]);
  await assert.rejects(f.backend.attach(f.scope(101)), unavailable);
  const paused = await f.backend.pauseAutomation(); await f.backend.resumeAutomation(paused.revision);
  assert.equal(f.backend.auxiliaryTabs.entry(101).phase, "excluded");
  for (const event of f.events) event.clear();
  const restarted = new f.Backend(); await restarted.controlReady;
  const scope = f.fresh(f.scope(101), await restarted.getControlState({ session_id: "task" }));
  assert.deepEqual(Array.from(await restarted.getTabs(scope), tab => tab.id), [100]);
  await assert.rejects(restarted.attach(scope), unavailable);
  await assert.rejects(restarted.claimUserTab({ ...f.foreign, tabId: 101 }), /CLAIM_CONFLICT/);
  await restarted.claimUserTab(scope);
  assert.equal(restarted.auxiliaryTabs.entry(101), undefined);
  assert.equal(restarted.store.state.sessions.task.tabOrigins[101], "user");
  await restarted.finalizeTabs({ ...scope, keep: [] });
  assert.equal(f.tabs.has(100), false); assert.equal(f.tabs.has(101), true);
  assert.equal(f.tabs.get(101).groupId, -1);
});

test("a failed exclusion write recovers its earlier agent quarantine without restoring implicit group authority", async t => {
  const f = await excludedCreation(t, { failExclusionWrite: true });
  await f.backend.auxiliaryTabs.writes.catch(() => {});
  const persisted = f.session[AUX_KEY].records.find(record => record.tabId === 101);
  assert.equal(persisted.origin, "agent"); assert.equal(persisted.phase, "quarantined");
  delete f.hooks.write;
  for (const event of f.events) event.clear();
  const restarted = new f.Backend(); await restarted.controlReady;
  const scope = f.fresh(f.scope(101), await restarted.getControlState({ session_id: "task" }));
  assert.equal(restarted.auxiliaryTabs.entry(101).phase, "excluded");
  assert.deepEqual(Array.from(await restarted.getTabs(scope), tab => tab.id), [100]);
  const paused = await restarted.pauseAutomation(); await restarted.resumeAutomation(paused.revision);
  assert.equal(restarted.auxiliaryTabs.entry(101).phase, "excluded");
  assert.equal(f.tabs.has(101), true);
  assert.equal(f.calls.some(([name, ids]) => name === "remove" && ids.includes(101)), false);
});

test("same-group notifications cannot erase exclusion; verified group departure can release it", async t => {
  const f = await excludedCreation(t);
  f.chrome.tabs.onUpdated.emit(101, { groupId: 30 });
  await Promise.allSettled([...f.backend.auxiliaryReleases.values()]);
  assert.equal(f.backend.auxiliaryTabs.entry(101).phase, "excluded");
  f.tabs.get(101).groupId = -1;
  f.chrome.tabs.onUpdated.emit(101, { groupId: -1 });
  await Promise.allSettled([...f.backend.auxiliaryReleases.values()]);
  assert.equal(f.backend.auxiliaryTabs.entry(101), undefined); assert.equal(f.tabs.has(101), true);
  await f.backend.claimUserTab(f.scope(101));
  assert.equal(f.backend.store.state.sessions.task.tabOrigins[101], "user");
  await f.backend.finalizeTabs({ ...f.params, keep: [] });
  assert.equal(f.tabs.has(101), true);
});

test("cleanup retry after takeover inside an existing group saves a denial instead of re-authorizing or closing", async t => {
  const f = await ordinary(t, { dissolve: false }); await f.create();
  const remove = f.chrome.tabs.remove;
  f.hooks.updateGroup = async () => { throw new Error("fixture failed admission"); };
  f.chrome.tabs.remove = async () => { throw new Error("fixture close failed"); };
  await assert.rejects(f.create(), /CREATION_CLEANUP_FAILED/);
  const record = f.backend.auxiliaryTabs.entry(101);
  assert.equal(record.phase, "quarantined");
  f.chrome.tabs.onActivated.emit({ tabId: 101, windowId: 1 });
  f.chrome.tabs.remove = remove;
  await f.backend.releaseAuxiliaryClaim(record);
  assert.equal(record.phase, "excluded"); assert.equal(f.tabs.has(101), true);
  assert.deepEqual(Array.from(await f.backend.getTabs(f.params), tab => tab.id), [100]);
});

