import { readFile } from "node:fs/promises";
import vm from "./backend-vm.mjs";
const input = (await readFile(new URL("../browser-input-adapter.js", import.meta.url), "utf8")).replace(/^export /gm, "");
const source = (await readFile(new URL("../background.js", import.meta.url), "utf8"))
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

export async function fixture(t, { managed = false } = {}) {
  const local = {}, session = {}, calls = [], attached = new Set(), hooks = {}, gates = [];
  const tabs = new Map([
    [7, { id: 7, groupId: 10, windowId: 1, url: "https://fixture.test/main", active: false }],
    [8, { id: 8, groupId: -1, windowId: 2, url: "https://fixture.test/popup", active: true }],
    [9, { id: 9, groupId: 20, windowId: 1, url: "https://fixture.test/other", active: false }]
  ]);
  if (managed) for (const tab of tabs.values()) tab.pinned = false;
  const windows = new Map([[1, { id: 1, type: "normal", focused: true }], [2, { id: 2, type: "popup", focused: false }], [3, { id: 3, type: "popup", focused: false }]]);
  const groups = new Map([[10, { id: 10, windowId: 1 }], [20, { id: 20, windowId: 1 }]]);
  const requireTab = id => { const tab = tabs.get(id); if (!tab) throw new Error(`No tab with id: ${id}`); return tab; };
  const area = (name, state) => ({
    async get(key) { await hooks.read?.(name, key); return clone(Object.hasOwn(state, key) ? { [key]: state[key] } : {}); },
    async set(value) { const captured = clone(value); await hooks.write?.(name, captured); Object.assign(state, captured); calls.push([`${name}.set`, clone(captured)]); },
    async setAccessLevel(value) { calls.push([`${name}.setAccessLevel`, value]); }
  });
  const frameRecords = new Map([[7, [{frameId:0,parentFrameId:-1,documentId:"root-one",url:"https://fixture.test/main"}]]]);
  const chrome = {
    storage: { local: area("local", local), session: area("session", session) },
    runtime: { id: "fixture", getURL: path => `chrome-extension://fixture/${path}`, getManifest: () => ({ version: "test" }) },
    debugger: { onDetach: event(), onEvent: event(),
      async attach(target) { const tabId = target.tabId ?? Number(target.targetId?.slice(7)); calls.push(["attach-start", tabId]); await hooks.attach?.(tabId); requireTab(tabId); attached.add(tabId); calls.push(["attach", tabId]); },
      async detach(target) { const tabId = target.tabId ?? Number(target.targetId?.slice(7)); await hooks.detach?.(tabId); attached.delete(tabId); calls.push(["detach", tabId]); },
      async getTargets() { const override = await hooks.targets?.(); if (override !== undefined) return override; return [...tabs.values()].map(tab => ({ id: `target-${tab.id}`, tabId: tab.id, type: "page", url: tab.url, attached: attached.has(tab.id) })); },
      async sendCommand(target, method, params) { calls.push([method, target.tabId, clone(params)]); const response = await hooks.command?.(target, method, params); if (response !== undefined) return response;
        if (managed && target.targetId) {
          const tabId = Number(target.targetId.slice(7));
          if (method === "Page.startScreencast") queueMicrotask(() => chrome.debugger.onEvent.emit(target, "Page.screencastFrame", { sessionId: 42, data: "cGl4ZWxz", metadata: { deviceWidth: 800, deviceHeight: 600, pageScaleFactor: 1, offsetTop: 0, monotonicTimestamp: 101 } }));
          if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "root", loaderId: "loader-" + frameRecords.get(tabId)?.[0]?.documentId, url: requireTab(tabId).url } } };
          if (method === "Performance.getMetrics") return { metrics: [{ name: "Timestamp", value: 100 }] };
          if (method === "Page.getLayoutMetrics") return { cssVisualViewport: { clientWidth: 800, clientHeight: 600, scale: 1, zoom: 1, offsetX: 0, offsetY: 0 } };
          return {};
        }
        return { result: { value: "fixture" } }; }
    },
    webNavigation: {async getFrame({tabId}) { await hooks.frame?.(tabId); return clone(frameRecords.get(tabId)?.[0]); },onBeforeNavigate:event(),onCommitted:event(),onErrorOccurred:event(),onHistoryStateUpdated:event(),onReferenceFragmentUpdated:event(),onCreatedNavigationTarget:event(),async getAllFrames({tabId}){await hooks.frames?.(tabId);return clone(frameRecords.get(tabId)??[])}},
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
  const Backend = vm.runInNewContext(`${code}\nBrowserBackend`, { chrome, crypto, Date, URL, setTimeout, clearTimeout, managedConfig: managed ? { version: 1, nativeHostName: "com.openbrowseruse.managed.n0123456789abcdef0123456789abcdef" } : null });
  const backend = new Backend();
  await backend.controlReady;
  if (managed) backend.commitManagedUserOpen(await backend.prepareManagedUserOpen({ workerBootId: "fixture-worker-A" }));
  backend.browserEngine = { async attach(tabId) { attached.add(tabId); backend.attachedTabs.add(tabId); if(!backend.attachmentEpochs.has(tabId)) backend.attachmentEpochs.set(tabId, {}); }, async detach(tabId){attached.delete(tabId);backend.releaseEngineAttachment(tabId);}, invalidate(){}, forget(){} };
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
    await backend.managedHuman.current?.handle.close().catch(() => {});
    backend.networkWaits.invalidateAll();
    await backend.pageWaits.invalidateAll();
    for(const record of [...backend.pageWaits.records.values()]) backend.pageWaits.remove(record);
    await Promise.allSettled([...backend.attachedTabs].map(id => backend.detachTab(id)));
  });
  return { Backend, backend, chrome, local, session, calls, attached, hooks, tabs, windows, groups, frameRecords, params, foreign,
    gate() { const value = deferred(); gates.push(value); return value; },
    fresh(previous, next) { return { ...previous, turn_id: next.nextTurnId, control_epoch: next.controlEpoch }; },
    events: [chrome.debugger.onDetach, chrome.debugger.onEvent, ...Object.values(chrome.tabs).filter(item => item?.emit), ...Object.values(chrome.windows).filter(item => item?.emit)]
  };
}
