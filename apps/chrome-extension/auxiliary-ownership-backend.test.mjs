import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import test from "node:test";
import vm from "./test-support/backend-vm.mjs";

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

test("popup claim preserves its window, deduplicates membership and shares target/transfer authorization", async t => {
  const f = await fixture(t), { backend, params } = f;
  assert.equal((await backend.getInfo()).metadata.auxiliaryTabsVersion, 1);
  await assert.rejects(backend.attach(params), unavailable);
  await backend.claimUserTab(params); await backend.claimUserTab(params);
  assert.equal(f.tabs.get(8).windowId, 2); assert.equal(f.tabs.get(8).groupId, -1);
  assert.equal(f.calls.some(([name]) => name === "group" || name === "ungroup"), false);
  const owned = await backend.getTabs(params); assert.equal(owned.filter(tab => tab.id === 8).length, 1); assert.ok(owned.some(tab => tab.id === 7));
  await backend.attach(params);
  await backend.validateTransferScope(backend.attachmentOwners.get(8));
  assert.equal((await backend.cdpEventMetadata({ tabId: 8 })).session_id, "task");
  await backend.executeCdp({ ...params, target: { targetId: "target-8" }, method: "Runtime.evaluate", commandParams: { expression: "document.title" } });
  const count = f.calls.filter(([method]) => method === "Runtime.evaluate").length;
  await assert.rejects(backend.executeCdp({ ...f.foreign, target: { targetId: "target-8" }, method: "Runtime.evaluate" }), unavailable);
  await assert.rejects(backend.claimUserTab(f.foreign), unavailable);
  assert.equal(f.calls.filter(([method]) => method === "Runtime.evaluate").length, count);
  const inventory = await backend.executeCdp({ ...f.foreign, method: "Target.getTargets" });
  assert.equal(inventory.targetInfos.some(target => target.tabId === 8), false);
});

test("two sessions cannot commit concurrent claims for a group-less popup", async t => {
  const f = await fixture(t), gate = f.gate(); let started = false;
  f.hooks.getTab = async id => { if (id === 8 && !started) { started = true; await gate.promise; } };
  const first = f.backend.claimUserTab(f.params);
  await until(() => started, "first claim live lookup");
  const second = f.backend.claimUserTab(f.foreign);
  const outcomes = Promise.allSettled([first, second]); gate.resolve();
  const results = await outcomes;
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.match(String(results.find(result => result.status === "rejected").reason), unavailable);
  const membership = await Promise.all([f.backend.getTabs(f.params), f.backend.getTabs(f.foreign)]);
  assert.equal(membership.filter(tabs => tabs.some(tab => tab.id === 8)).length, 1);
});

test("auxiliary deliverable releases authority while preserving its native window and page", async t => {
  const f = await fixture(t); await f.backend.claimUserTab(f.params); await f.backend.attach(f.params);
  const before = f.calls.length, native = clone(f.tabs.get(8));
  const result = await f.backend.finalizeTabs({ ...f.params, keep: [{ tabId: 8, status: "deliverable" }] });
  assert.deepEqual(f.tabs.get(8), native); assert.equal(f.attached.has(8), false);
  assert.equal(f.backend.auxiliaryTabs.entry(8), undefined);
  assert.equal(f.calls.slice(before).some(([name, ids]) => ["remove", "ungroup", "group"].includes(name) && [].concat(ids).includes(8)), false);
  assert.equal(f.backend.store.state.deliverableTabs[8].windowId, native.windowId);
  await assert.rejects(f.backend.attach(f.params), unavailable);
  const scope = f.fresh(f.params, result);
  assert.equal((await f.backend.getTabs(scope)).some(tab => tab.id === 8), false);
  await assert.rejects(f.backend.attach(scope), unavailable);
});

test("handoff and turn end retain popup membership without a primary group; omission releases without closing", async t => {
  const f = await fixture(t); await f.backend.claimUserTab(f.params); await f.backend.attach(f.params);
  const handoff = await f.backend.finalizeTabs({ ...f.params, keep: [{ tabId: 8, status: "handoff" }] });
  let scope = f.fresh(f.params, handoff);
  f.groups.delete(10); // Chrome removes the empty primary group independently.
  assert.equal(f.attached.has(8), false); assert.equal(f.tabs.get(8).windowId, 2);
  assert.deepEqual(Array.from(await f.backend.getTabs(scope), tab => tab.id), [8]);
  await f.backend.attach(scope);
  scope = f.fresh(scope, await f.backend.turnEnded(scope));
  assert.equal(f.attached.has(8), false); assert.ok((await f.backend.getTabs(scope)).some(tab => tab.id === 8));
  const before = f.calls.length;
  await f.backend.finalizeTabs({ ...scope, keep: [] });
  assert.equal(f.tabs.get(8).windowId, 2); assert.equal(f.windows.has(2), true);
  assert.equal(f.calls.slice(before).some(([name, ids]) => ["remove", "ungroup", "group"].includes(name) && ids.includes(8)), false);
  await f.backend.claimUserTab(f.foreign); await f.backend.attach(f.foreign);
});

test("Pause releases auxiliary control, keeps membership and fences the old epoch after Resume", async t => {
  const f = await fixture(t); await f.backend.claimUserTab(f.params); await f.backend.attach(f.params);
  const before = f.calls.length, paused = await f.backend.pauseAutomation();
  assert.equal(paused.cleanupComplete, true); assert.equal(f.attached.has(8), false);
  assert.equal(f.calls.slice(before).some(([name]) => ["remove", "ungroup", "group"].includes(name)), false);
  await f.backend.resumeAutomation(paused.revision);
  await assert.rejects(f.backend.attach(f.params), /STALE_CONTROL_EPOCH/);
  const next = await f.backend.getControlState({ session_id: "task" });
  const scope = f.fresh(f.params, next);
  assert.ok((await f.backend.getTabs(scope)).some(tab => tab.id === 8)); await f.backend.attach(scope);
});

test("simulated worker restart retains durable auxiliary membership; clearing session storage drops it", async t => {
  const f = await fixture(t); await f.backend.claimUserTab(f.params); await f.backend.attach(f.params);
  assert.ok(f.session[AUX_KEY]?.records.some(record => record.tabId === 8 && record.phase === "committed"));
  for (const event of f.events) event.clear();
  const restarted = new f.Backend(); await restarted.controlReady;
  await assert.rejects(restarted.attach(f.params), /STALE_CONTROL_EPOCH|BOOTSTRAP_REQUIRED/);
  const scope = f.fresh(f.params, await restarted.getControlState({ session_id: "task" }));
  assert.ok((await restarted.getTabs(scope)).some(tab => tab.id === 8));
  await restarted.attach(scope); await restarted.detach(scope);
  // This VM only models the empty storage.session boundary. It is not a native
  // full-browser/extension restart test. Local storage must not restore a tab ID.
  for (const key of Object.keys(f.session)) delete f.session[key];
  for (const event of f.events) event.clear();
  const freshBrowser = new f.Backend(); await freshBrowser.controlReady;
  const fresh = f.fresh(f.params, await freshBrowser.getControlState({ session_id: "task" }));
  assert.equal((await freshBrowser.getTabs(fresh)).some(tab => tab.id === 8), false);
  await assert.rejects(freshBrowser.attach(fresh), unavailable);
});

for (const boundary of ["end", "pause", "close"]) test(`claim blocked in storage cannot publish after ${boundary}`, async t => {
  const f = await fixture(t), gate = f.gate(); let blocked = false;
  f.hooks.write = async (area, value) => { if (area === "session" && value[AUX_KEY] && !blocked) { blocked = true; await gate.promise; } };
  const claim = f.backend.claimUserTab(f.params).then(value => ({ value }), error => ({ error }));
  await until(() => blocked, "pending auxiliary persistence");
  assert.ok(!f.backend.auxiliaryTabs.owner(8), "A pending reservation granted durable membership");
  let ending;
  if (boundary === "end") ending = f.backend.turnEnded(f.params);
  else if (boundary === "pause") ending = f.backend.pauseAutomation();
  else { f.tabs.delete(8); f.chrome.tabs.onRemoved.emit(8, { windowId: 2, isWindowClosing: true }); f.windows.delete(2); f.chrome.windows.onRemoved.emit(2); }
  gate.resolve();
  const outcome = await claim; assert.ok(outcome.error, "A late claim became usable after cancellation");
  if (ending) await ending;
  assert.equal(f.attached.has(8), false);
  assert.equal((f.session[AUX_KEY]?.records ?? []).some(record => record.tabId === 8 && record.phase === "committed"), false);
});

test("claim persistence failure never yields usable membership or attachment", async t => {
  const f = await fixture(t);
  f.hooks.write = async area => { if (area === "session") throw new Error("fixture session quota"); };
  await assert.rejects(f.backend.claimUserTab(f.params), /fixture session quota/);
  await assert.rejects(f.backend.attach(f.params), /fixture session quota|OBU_AUXILIARY_|not part of browser session/);
  assert.equal(f.attached.has(8), false);
  assert.equal(f.tabs.get(8).windowId, 2);
});

test("external movement quarantines old ownership before a successor may attach", async t => {
  const f = await fixture(t); await f.backend.claimUserTab(f.params); await f.backend.attach(f.params);
  const gate = f.gate(); let releasing = false;
  f.hooks.detach = async id => { if (id === 8 && !releasing) { releasing = true; await gate.promise; } };
  f.tabs.get(8).windowId = 3;
  f.chrome.tabs.onDetached.emit(8, { oldWindowId: 2, oldPosition: 0 });
  f.chrome.tabs.onAttached.emit(8, { newWindowId: 3, newPosition: 0 });
  await until(() => releasing, "retiring exact old attachment");
  const oldCommand = f.backend.executeCdp({ ...f.params, target: { tabId: 8 }, method: "Runtime.evaluate" }).then(value => ({ value }), error => ({ error }));
  const successor = f.backend.claimUserTab(f.foreign).then(value => ({ value }), error => ({ error }));
  await tick(); assert.equal(f.calls.filter(([name]) => name === "attach").length, 1);
  assert.equal(f.calls.some(([name]) => name === "Runtime.evaluate"), false);
  gate.resolve(); await successor;
  assert.match(String((await oldCommand).error), unavailable);
  await Promise.all([...f.backend.auxiliaryReleases.values()]);
  await until(() => !f.backend.auxiliaryTabs.entry(8), "old ownership removal persisted");
  // A rejected racing claim is retried explicitly, never resumed automatically.
  await f.backend.claimUserTab(f.foreign); await f.backend.attach(f.foreign);
  assert.equal(f.tabs.get(8).windowId, 3); assert.equal(f.backend.attachmentOwners.get(8).session_id, "other");
  await assert.rejects(f.backend.attach(f.params), unavailable);
});

test("denied claim's ordinary-tab reservation cannot disturb a foreign group's input or wait", async t => {
  const f = await fixture(t), owner = { ...f.foreign, tabId: 9 }, claimant = { ...f.params, tabId: 9 };
  await f.backend.attach(owner);
  await f.backend.executeCdp({ ...owner, target: { tabId: 9 }, method: "Input.dispatchMouseEvent", commandParams: { type: "mousePressed", x: 10, y: 10, button: "left", buttons: 1, clickCount: 1 } });
  const page = new EventEmitter(), scope = f.backend.attachmentOwners.get(9), url = "https://fixture.test/foreign-api";
  const record = f.backend.networkWaits.reserve({ ...owner, event: "response", match: { url }, timeoutMs: 1000 });
  const ready = await f.backend.networkWaits.arm(record, page, scope, value => f.backend.validateTransferScope(value));
  const gate = f.gate(), original = f.backend.store.findSessionByGroup.bind(f.backend.store); let blocked = false;
  f.backend.store.findSessionByGroup = async groupId => { if (groupId === 20 && !blocked) { blocked = true; await gate.promise; } return original(groupId); };
  const before = f.calls.length;
  const denied = f.backend.claimUserTab(claimant).then(value => ({ value }), error => ({ error }));
  await until(() => blocked, "foreign group ownership validation");
  assert.ok((await f.backend.getTabs(owner)).some(tab => tab.id === 9));
  await f.backend.validateTransferScope(scope);
  const request = { url: () => url, method: () => "POST", resourceType: () => "fetch", frame: () => ({ url: () => "https://fixture.test/other" }), redirectedFrom: () => null };
  page.emit("response", { request: () => request, status: () => 200, statusText: () => "OK" });
  assert.equal((await f.backend.collectNetworkWait({ ...owner, waiterId: ready.waiterId })).status, 200);
  gate.resolve(); assert.match(String((await denied).error), /already part of browser session/);
  await Promise.all([...f.backend.auxiliaryReleases.values()]);
  assert.equal(f.attached.has(9), true); assert.equal(f.backend.attachmentOwners.get(9), scope);
  assert.equal(f.calls.slice(before).some(([method]) => ["detach", "Input.dispatchMouseEvent", "Input.dispatchKeyEvent", "Input.cancelDragging"].includes(method)), false);
  await f.backend.cancelNetworkWait({ ...owner, waiterId: ready.waiterId });
  await f.backend.executeCdp({ ...owner, target: { tabId: 9 }, method: "Input.dispatchMouseEvent", commandParams: { type: "mouseReleased", x: 10, y: 10, button: "left", buttons: 0, clickCount: 1 } });
});

test("ending an unvalidated claim does not detach a foreign owner's cold attachment", async t => {
  const f = await fixture(t), owner = { ...f.foreign, tabId: 9 }, claimant = { ...f.params, tabId: 9 };
  const claimGate = f.gate(), setupGate = f.gate(); let claimBlocked = false, setupBlocked = false, firstReleaseDone = false;
  const findOwner = f.backend.store.findSessionByGroup.bind(f.backend.store);
  f.backend.store.findSessionByGroup = async groupId => {
    if (groupId === 20 && !claimBlocked) { claimBlocked = true; await claimGate.promise; }
    return findOwner(groupId);
  };
  const denied = f.backend.claimUserTab(claimant).then(value => ({ value }), error => ({ error }));
  await until(() => claimBlocked, "unvalidated foreign claim");
  f.hooks.command = async (target, method) => {
    if (target.tabId === 9 && method === "Emulation.setFocusEmulationEnabled") { setupBlocked = true; await setupGate.promise; }
  };
  const attaching = f.backend.attach(owner).then(value => ({ value }), error => ({ error }));
  await until(() => setupBlocked, "foreign raw attachment before owner publication");
  assert.equal(f.attached.has(9), true);
  assert.equal(f.backend.attachmentOwners.has(9), false);
  const release = f.backend.releaseSessionControl.bind(f.backend);
  f.backend.releaseSessionControl = async sessionId => { try { return await release(sessionId); } finally { if (sessionId === "task") firstReleaseDone = true; } };
  const before = f.calls.length;
  const ending = f.backend.turnEnded(f.params).then(value => ({ value }), error => ({ error }));
  await until(() => firstReleaseDone, "claiming session's initial release pass");
  const detachedForeign = f.calls.slice(before).some(([method, id]) => method === "detach" && id === 9);
  const remainedAttached = f.attached.has(9);
  setupGate.resolve(); claimGate.resolve();
  const [claimResult, attachmentResult, endResult] = await Promise.all([denied, attaching, ending]);
  assert.equal(detachedForeign, false, "A pending ordinary claim was mistaken for attachment ownership");
  assert.equal(remainedAttached, true);
  assert.ok(claimResult.error); assert.ok(!attachmentResult.error, String(attachmentResult.error)); assert.ok(!endResult.error, String(endResult.error));
  assert.equal(f.backend.attachmentOwners.get(9).session_id, "other");
});

test("a lookup failure cannot erase durable ownership and a closed popup cannot resurrect after late attach", async t => {
  const f = await fixture(t); await f.backend.claimUserTab(f.params);
  f.hooks.query = async () => { throw new Error("fixture inventory unavailable"); };
  await assert.rejects(f.backend.releaseSessionControl("task"), /fixture inventory unavailable/);
  delete f.hooks.query;
  assert.ok((await f.backend.getTabs(f.params)).some(tab => tab.id === 8));
  const gate = f.gate(); let started = false;
  f.hooks.attach = async id => { if (id === 8) { started = true; await gate.promise; } };
  const attaching = f.backend.attach(f.params).then(value => ({ value }), error => ({ error }));
  await until(() => started, "native attachment");
  await f.chrome.tabs.remove(8); f.windows.delete(2); f.chrome.windows.onRemoved.emit(2);
  gate.resolve(); assert.ok((await attaching).error);
  assert.equal(f.attached.has(8), false); assert.equal((await f.backend.getTabs(f.params)).some(tab => tab.id === 8), false);
});

test("failed release retains the old reverse lock even after a move into a foreign task group", async t => {
  const f = await fixture(t); await f.backend.claimUserTab(f.params); await f.backend.attach(f.params);
  f.hooks.detach = async id => { if (id === 8) throw new Error("fixture native detach unavailable"); };
  f.tabs.get(8).windowId = 1; f.tabs.get(8).groupId = 20;
  f.chrome.tabs.onUpdated.emit(8, { groupId: 20 }, clone(f.tabs.get(8)));
  const releases = [...f.backend.auxiliaryReleases.values()];
  assert.ok(releases.length); await Promise.allSettled(releases);
  assert.ok(f.backend.auxiliaryTabs.entry(8)); assert.ok(!f.backend.auxiliaryTabs.owner(8));
  assert.equal((await f.backend.getTabs(f.foreign)).some(tab => tab.id === 8), false);
  await assert.rejects(f.backend.attach(f.foreign), unavailable);
  await assert.rejects(f.backend.claimUserTab(f.foreign), unavailable);
  assert.equal(f.backend.attachmentOwners.get(8).session_id, "task");
  delete f.hooks.detach;
  await f.backend.releaseSessionControl("task");
  assert.ok(!f.backend.auxiliaryTabs.entry(8));
  await f.backend.claimUserTab(f.foreign); await f.backend.attach(f.foreign);
  assert.equal(f.backend.attachmentOwners.get(8).session_id, "other");
});
