import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "./test-support/backend-vm.mjs";
import test from "node:test";

const source = (await readFile(new URL("./background.js", import.meta.url), "utf8"))
  .replace('import { createBrowserActionEngine } from "./browser-runtime.js";', "").replace('import { NativeInputTracker } from "./browser-input-adapter.js";', (await readFile(new URL("./browser-input-adapter.js", import.meta.url), "utf8")).replace(/^export /gm, "") + "\nglobalThis.performance ??= { now: () => Date.now() };");
const code = source.slice(0, source.indexOf("chrome.runtime.onInstalled.addListener"));
const clone = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
const params = (turn = "first", extra = {}) => ({ session_id: "task", turn_id: turn, ...extra });

function environment({ attachGate, storage = {}, write } = {}) {
  const calls = [], attached = new Set(), tabs = new Map([[7, { id: 7, groupId: 10, windowId: 1, url: "https://fixture.test" }]]);
  const chrome = {
    storage: { local: {
      async get(key) { return Object.hasOwn(storage, key) ? { [key]: clone(storage[key]) } : {}; },
      async set(value) { await write?.(value); Object.assign(storage, clone(value)); calls.push(["save", Object.keys(value)[0]]); }
    } },
    debugger: {
      onDetach: { addListener() {} }, onEvent: { addListener() {}, removeListener() {} },
      async attach({ tabId }) { calls.push(["attach", tabId]); await attachGate?.promise; attached.add(tabId); },
      async detach({ tabId }) { calls.push(["detach", tabId]); attached.delete(tabId); },
      async sendCommand(target, method) { calls.push([method, target.tabId]); return {}; }
    },
    tabs: {
      async query(filter) { return [...tabs.values()].filter(tab => filter?.groupId === undefined || tab.groupId === filter.groupId); },
      async remove(ids) { for (const id of Array.isArray(ids) ? ids : [ids]) tabs.delete(id); },
      async ungroup(ids) { for (const id of Array.isArray(ids) ? ids : [ids]) tabs.get(id).groupId = -1; },
      async sendMessage() { return {}; }
    },
    tabGroups: { async update() {} }
  };
  const classes = vm.runInNewContext(`${code}\n({BrowserBackend,ControlLedger,JsonRpcPeer});`, { chrome, Date, setTimeout, clearTimeout });
  return { ...classes, chrome, calls, tabs, attached, storage };
}

async function backendFor(env) {
  const backend = new env.BrowserBackend();
  await backend.controlReady;
  const session = await backend.store.getSession("task");
  session.chromeGroupId = 10;
  session.tabOrigins = { 7: "agent" };
  await backend.store.save();
  return backend;
}

test("ending a CLI turn retires every previously admitted legacy turn", async () => {
  const backend = await backendFor(environment());
  await backend.requireSession(params("cli-a"));
  await backend.requireSession(params("cli-b"));
  const ended = await backend.turnEnded(params("cli-end"));
  for (const id of ["cli-a", "cli-b", "cli-end"]) await assert.rejects(backend.attach(params(id, { tabId: 7 })), /OBU_TURN_ENDED/);
  await backend.attach(params(ended.nextTurnId, { tabId: 7 }));
  assert.equal(backend.attachedTabs.has(7), true);
});

test("strict epochs reject a never-observed late turn and allow an explicit new cycle", async () => {
  const backend = await backendFor(environment());
  const initial = await backend.getControlState({ session_id: "task" });
  const first = params("first", { control_epoch: initial.controlEpoch });
  await backend.attach({ ...first, tabId: 7 });
  const next = await backend.turnEnded(first);
  assert.ok(next.controlEpoch > initial.controlEpoch);
  await assert.rejects(backend.nameSession(params("never-seen", { control_epoch: initial.controlEpoch, name: "stale" })), /OBU_STALE_CONTROL_EPOCH/);
  await backend.nameSession(params(next.nextTurnId, { control_epoch: next.controlEpoch, name: "Next task" }));
  assert.equal((await backend.store.getSession("task")).title, "Next task");
});

test("finalize removes tab state without discarding the control tombstone", async () => {
  const env = environment(), backend = await backendFor(env);
  await backend.finalizeTabs(params("finished", { keep: [] }));
  assert.equal(Object.hasOwn(backend.store.state.sessions, "task"), false);
  await assert.rejects(backend.requireSession(params("finished")), /OBU_TURN_ENDED/);
  const restarted = new env.BrowserBackend();
  await restarted.controlReady;
  await assert.rejects(restarted.requireSession(params("finished")), /OBU_TURN_ENDED/);
});

test("an attachment completing during end is drained and detached before success", async () => {
  const gate = deferred(), env = environment({ attachGate: gate }), backend = await backendFor(env);
  const pending = backend.attach(params("late-attach", { tabId: 7 }));
  const rejected = assert.rejects(pending, /OBU_TURN_ENDED/);
  await tick();
  let ended = false;
  const stopping = backend.turnEnded(params("end")).then(value => { ended = true; return value; });
  await tick();
  assert.equal(ended, false);
  const closing = await backend.getControlState({ session_id: "task" });
  assert.equal(closing.closing, true);
  await assert.rejects(backend.requireSession(params("new", { control_epoch: closing.controlEpoch })), /OBU_CONTROL_ENDING/);
  gate.resolve();
  await Promise.all([stopping, rejected]);
  assert.equal(env.attached.size, 0);
  assert.equal(backend.attachedTabs.size, 0);
  assert.equal(env.calls.at(-1)[0], "save");
});

test("worker restart invalidates active epochs and recovers only by releasing control", async () => {
  const env = environment(), backend = await backendFor(env);
  const state = await backend.getControlState({ session_id: "task" });
  await backend.attach(params("active", { tabId: 7, control_epoch: state.controlEpoch }));
  const restarted = new env.BrowserBackend();
  await restarted.controlReady;
  await assert.rejects(restarted.attach(params("active", { tabId: 7, control_epoch: state.controlEpoch })), /OBU_STALE_CONTROL_EPOCH/);
  assert.equal(env.attached.size, 0);
  assert.equal(env.tabs.has(7), true, "Recovery must not replay finalize or delete tabs");
  assert.ok((await restarted.getControlState({ session_id: "task" })).controlEpoch > state.controlEpoch);
});

test("legacy ledger capacity requires epoch mode instead of dropping tombstones", async () => {
  const env = environment(), ledger = new env.ControlLedger();
  await ledger.ready;
  for (let i = 0; i < 256; i++) await ledger.admit(params(`turn-${i}`));
  await assert.rejects(ledger.admit(params("overflow")), /OBU_CONTROL_BOOTSTRAP_REQUIRED/);
  await assert.rejects(ledger.admit(params("turn-0")), /OBU_CONTROL_BOOTSTRAP_REQUIRED/);
  const state = await ledger.bootstrap("task");
  await ledger.admit(params("strict", { control_epoch: state.controlEpoch }));
  assert.ok(ledger.records.get("task").legacyTurns.length <= 256);
});

test("bounded idle-session eviction uses unique global epochs and disables legacy recreation", async () => {
  const env = environment(), ledger = new env.ControlLedger();
  const original = await ledger.bootstrap("task");
  for (let i = 1; i <= 64; i++) await ledger.bootstrap(`session-${i}`);
  assert.equal(ledger.records.size, 64);
  await assert.rejects(ledger.admit(params("old", { control_epoch: original.controlEpoch })), /OBU_STALE_CONTROL_EPOCH/);
  await assert.rejects(ledger.admit(params("old")), /OBU_CONTROL_BOOTSTRAP_REQUIRED/);
  const replacement = await ledger.bootstrap("task");
  assert.ok(replacement.controlEpoch > original.controlEpoch);
  const reloaded = new env.ControlLedger();
  await reloaded.ready;
  await assert.rejects(reloaded.admit({ session_id: "evicted", turn_id: "legacy" }), /OBU_CONTROL_BOOTSTRAP_REQUIRED/);
});

test("active capacity is recoverable after one session ends", async () => {
  const env = environment(), ledger = new env.ControlLedger();
  for (let i = 0; i < 64; i++) await ledger.admit({ session_id: `session-${i}`, turn_id: "active" });
  await assert.rejects(ledger.bootstrap("new"), /OBU_CONTROL_CAPACITY/);
  await ledger.finishEnd(await ledger.beginEnd({ session_id: "session-0", turn_id: "active" }));
  await ledger.bootstrap("new");
  assert.equal(ledger.records.size, 64);
});

test("invalid finalization does not close the current turn", async () => {
  const backend = await backendFor(environment());
  await assert.rejects(backend.finalizeTabs(params("valid", { keep: [{ tabId: 99, status: "handoff" }] })), /unknown tab/);
  await backend.requireSession(params("valid"));
});

test("RPC only exposes public methods, never internal or prototype helpers", async () => {
  const env = environment(), messages = [];
  const handlers = { getControlState: () => ({ controlEpoch: 1 }), detachTab: () => { throw new Error("Internal method reached"); } };
  const peer = new env.JsonRpcPeer({ setMessageCallback() {}, sendMessage(message) { messages.push(message); } }, handlers);
  for (const method of ["detachTab", "getSessionTabs", "recoverControlState", "constructor", "toString", "__proto__", "missing"]) {
    await peer.handleMessage({ id: method, method, params: {} });
    assert.match(messages.at(-1).error.message, /No handler registered/);
  }
  await peer.handleMessage({ id: "public", method: "getControlState", params: {} });
  assert.equal(messages.at(-1).result.controlEpoch, 1);
});

test("concurrent admissions wait until the active epoch is durably stored", async () => {
  const gate = deferred(), env = environment({ write: () => gate.promise });
  const ledger = new env.ControlLedger();
  let admitted = 0;
  const first = ledger.admit(params()).then(() => admitted++);
  const second = ledger.admit(params()).then(() => admitted++);
  await tick();
  assert.equal(admitted, 0);
  gate.resolve();
  await Promise.all([first, second]);
  assert.equal(admitted, 2);
});

test("a failed active-epoch write blocks concurrent and subsequent unchanged admissions", async () => {
  const gate = deferred(), failure = new Error("Storage is unavailable");
  const env = environment({ write: () => gate.promise }), ledger = new env.ControlLedger();
  const first = assert.rejects(ledger.admit(params()), error => error === failure);
  const second = assert.rejects(ledger.admit(params()), error => error === failure);
  await tick();
  gate.reject(failure);
  await Promise.all([first, second]);
  await assert.rejects(ledger.admit(params()), error => error === failure);
});

test("handoff ends active control while retaining the grouped tab for a new turn", async () => {
  const env = environment(), backend = await backendFor(env);
  backend.activeTabsBySession.set("task", 7);
  await backend.finalizeTabs(params("handoff", { keep: [{ tabId: 7, status: "handoff" }] }));
  assert.equal(env.tabs.get(7).groupId, 10);
  assert.equal(backend.isBrowserControlActive(), false);
  assert.equal((await backend.store.getSession("task")).activeTabId, null);
});

test("prototype-shaped session names cannot modify another session's state", async () => {
  const backend = await backendFor(environment());
  for (const name of ["__proto__", "constructor", "toString"]) {
    await backend.nameSession({ session_id: name, turn_id: "named", name: `Session ${name}` });
    assert.equal((await backend.store.getSession(name)).title, `Session ${name}`);
  }
  assert.equal((await backend.store.getSession("task")).title, "Task - OBU");
});

test("restart of a closing session only releases control, never repeats tab disposition", async () => {
  const env = environment(), backend = await backendFor(env);
  await backend.attach(params("finishing", { tabId: 7 }));
  const closing = await backend.controlLedger.beginEnd(params("finishing"));
  const epoch = closing.epoch;
  const restarted = new env.BrowserBackend();
  await restarted.controlReady;
  const recovered = await restarted.getControlState({ session_id: "task" });
  assert.equal(recovered.controlEpoch, epoch);
  assert.equal(recovered.closing, false);
  assert.equal(env.attached.size, 0);
  assert.equal(env.tabs.get(7).groupId, 10);
  await assert.rejects(restarted.requireSession(params("finishing")), /OBU_TURN_ENDED/);
});

test("a release failure stays fenced until explicit bootstrap finishes cleanup", async () => {
  const env = environment(), backend = await backendFor(env);
  await backend.attach(params("finishing", { tabId: 7 }));
  const originalDetach = env.chrome.debugger.detach;
  env.chrome.debugger.detach = async () => { throw new Error("Native release failed"); };
  await assert.rejects(backend.finalizeTabs(params("finishing", { keep: [] })), /OBU_CONTROL_RELEASE_FAILED/);
  assert.equal(backend.controlLedger.records.get("task").status, "closing");
  await assert.rejects(backend.requireSession(params("later")), /OBU_CONTROL_ENDING/);
  assert.equal(env.tabs.has(7), true, "Failed end must not apply dispositions");
  env.chrome.debugger.detach = originalDetach;
  const recovered = await backend.getControlState({ session_id: "task" });
  assert.equal(recovered.closing, false);
  assert.equal(env.attached.size, 0);
  assert.equal(env.tabs.has(7), true, "Cleanup retry must not replay finalize");
  await backend.attach(params(recovered.nextTurnId, { tabId: 7, control_epoch: recovered.controlEpoch }));
});

test("concurrent bootstrap during recovery cannot admit a successor before cleanup", async () => {
  const env = environment(), backend = await backendFor(env);
  await backend.attach(params("finishing", { tabId: 7 }));
  await backend.controlLedger.beginEnd(params("finishing"));
  const gate = deferred(), originalDetach = env.chrome.debugger.detach;
  env.chrome.debugger.detach = async target => { await gate.promise; return originalDetach(target); };
  const recovering = backend.getControlState({ session_id: "task" });
  await tick();
  const observed = await backend.getControlState({ session_id: "task" });
  assert.equal(observed.closing, true);
  await assert.rejects(backend.attach(params("new", { tabId: 7, control_epoch: observed.controlEpoch })), /OBU_CONTROL_ENDING/);
  gate.resolve();
  const recovered = await recovering;
  assert.equal(recovered.closing, false);
  await backend.attach(params("new", { tabId: 7, control_epoch: recovered.controlEpoch }));
  assert.equal(env.attached.has(7), true);
});

test("accepted tab creation is drained before finalization disposition", async () => {
  const gate = deferred(), env = environment(), backend = await backendFor(env);
  env.chrome.windows = { async getAll() { return [{ id: 1, type: "normal" }]; } };
  env.chrome.tabGroups.get = async id => ({ id });
  env.chrome.tabs.create = async () => { await gate.promise; const tab = { id: 8, groupId: -1, windowId: 1 }; env.tabs.set(8, tab); return tab; };
  env.chrome.tabs.get = async id => { if (!env.tabs.has(id)) throw new Error(`No tab with id: ${id}`); return env.tabs.get(id); };
  env.chrome.tabs.group = async ({ tabIds, groupId }) => { for (const id of [tabIds].flat()) env.tabs.get(id).groupId = groupId; return groupId; };
  const creating = assert.rejects(backend.createTab(params("late-create")), /OBU_TURN_ENDED/);
  await tick();
  let ended = false;
  const ending = backend.finalizeTabs(params("end", { keep: [] })).then(() => { ended = true; });
  await tick();
  assert.equal(ended, false);
  gate.resolve();
  await Promise.all([creating, ending]);
  assert.equal(env.tabs.size, 0);
  assert.equal(backend.isBrowserControlActive(), false);
});

test("release inventory errors cannot erase ownership or report a successful end", async () => {
  const env = environment(), backend = await backendFor(env);
  await backend.attach(params("ending", { tabId: 7 }));
  const originalQuery = env.chrome.tabs.query;
  const failure = new Error("Chrome tab inventory unavailable");
  env.chrome.tabs.query = async () => { throw failure; };
  await assert.rejects(backend.turnEnded(params("ending")), error => error === failure);
  assert.equal(backend.controlLedger.records.get("task").status, "closing");
  assert.equal((await backend.store.getSession("task")).chromeGroupId, 10);
  assert.equal(env.attached.has(7), true);
  env.chrome.tabs.query = originalQuery;
  const recovered = await backend.getControlState({ session_id: "task" });
  assert.equal(recovered.closing, false);
  assert.equal(env.attached.has(7), false);
});

test("finalization inventory failure preserves the active session before ending starts", async () => {
  const env = environment(), backend = await backendFor(env);
  await backend.attach(params("active", { tabId: 7 }));
  const failure = new Error("Chrome tab inventory unavailable");
  env.chrome.tabs.query = async () => { throw failure; };
  await assert.rejects(backend.finalizeTabs(params("active", { keep: [] })), error => error === failure);
  assert.equal(backend.controlLedger.records.get("task").status, "active");
  assert.equal((await backend.store.getSession("task")).chromeGroupId, 10);
  assert.equal(env.attached.has(7), true);
});
