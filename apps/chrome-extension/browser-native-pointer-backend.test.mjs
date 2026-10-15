import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { IDBFactory } from "fake-indexeddb";
import forceCloseDatabase from "fake-indexeddb/lib/forceCloseDatabase";
import vm from "./test-support/backend-vm.mjs";
import { PRIVATE_TARGET_LEDGER_KEY as LEDGER, PRIVATE_TARGET_INITIALIZED_KEY as INITIALIZED } from "./browser-private-target-store.js";

const input = (await readFile(new URL("./browser-input-adapter.js", import.meta.url), "utf8")).replace(/^export /gm, "");
const source = (await readFile(new URL("./background.js", import.meta.url), "utf8"))
  .replace('import { createBrowserActionEngine } from "./browser-runtime.js";', "")
  .replace('import { NativeInputTracker } from "./browser-input-adapter.js";', input);
const end = source.indexOf("chrome.runtime.onInstalled.addListener");
assert.notEqual(end, -1);
const clone = value => structuredClone(value);
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const event = () => { const listeners = new Set(); return { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn), clear: () => listeners.clear(), emit(...args) { for (const listener of listeners) listener(...args); } }; };
const tick = () => new Promise(setImmediate);
async function until(check, label) { for (let i = 0; i < 80; i++) { if (check()) return; await tick(); } throw Error(`Did not reach ${label}`); }
async function prompt(operation) {
  let timer;
  try { return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(Error("Optional feedback extended the caller")), 250); })]); }
  finally { clearTimeout(timer); }
}

async function fixture(t, { installed = true, local = {}, session = {}, indexedDB = new IDBFactory(), awaitRealm = true } = {}) {
  const calls = [], hooks = {}, gates = [], workers = [], events = [];
  const realmConnections = [];
  const realmStorage = indexedDB && { open(...args) {
    const request = indexedDB.open(...args);
    request.addEventListener?.("success", () => realmConnections.push(request.result));
    return request;
  } };
  const rootClients = new Set(), privateClients = new Set();
  const makeEvent = () => { const value = event(); events.push(value); return value; };
  const area = (name, state) => ({
    async get(keys) {
      await hooks.read?.(name, keys);
      const names = keys == null ? Object.keys(state) : typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
      return clone(Object.fromEntries(names.filter(key => Object.hasOwn(state, key)).map(key => [key, state[key]])));
    },
    async set(value) { const captured = clone(value); await hooks.write?.(name, captured); Object.assign(state, captured); calls.push({ method: `${name}.set`, value: captured }); },
    async setAccessLevel() {}
  });
  const tab = { id: 7, groupId: 10, windowId: 1, url: "https://pointer.fixture.test/", active: false };
  const originalInputResult = Object.freeze({ originalNativeInput: true });
  const absent = targetId => Error(`Debugger is not attached to the target with id: ${targetId}.`);
  const nativeReply = (target, method) => {
    if (method === "Target.getTargetInfo") {
      const targetId = target.targetId ?? "original-root";
      const attached = targetId === "original-root" ? rootClients.has(7) : privateClients.has(targetId);
      return attached ? Promise.resolve({ targetInfo: { targetId, type: targetId === "original-root" ? "page" : "iframe" } }) : Promise.reject(absent(targetId));
    }
    if (method === "Page.getFrameTree") return Promise.resolve({ frameTree: { frame: { id: "original-root", loaderId: "original-loader" } } });
    if (method === "Page.createIsolatedWorld") return Promise.resolve({ executionContextId: 19 });
    if (method === "Runtime.evaluate") return Promise.resolve({ result: { objectId: "original-wrapper" } });
    // A null root stops geometry; the real reader still owns and releases its
    // captured group. These tests assert lifecycle, not manufactured geometry.
    if (method === "Runtime.callFunctionOn") return Promise.resolve({ result: { value: null } });
    return Promise.resolve(method.startsWith("Input.") ? originalInputResult : {});
  };
  const chrome = {
    storage: { local: area("local", local), session: area("session", session) },
    runtime: { onStartup: makeEvent(), onInstalled: makeEvent(), id: "fixture", getURL: path => `chrome-extension://fixture/${path}`, getManifest: () => ({ version: "test" }) },
    debugger: {
      onDetach: makeEvent(), onEvent: makeEvent(),
      async attach(target) { calls.push({ method: "attach", target: clone(target) }); await hooks.attach?.(target); if (target.tabId !== undefined) rootClients.add(target.tabId); else privateClients.add(target.targetId); },
      async detach(target) { calls.push({ method: "detach", target: clone(target) }); await hooks.detach?.(target); if (target.tabId !== undefined) { if (!rootClients.delete(target.tabId)) throw Error("Debugger is not attached to the tab with id: 7."); } else { if (!privateClients.delete(target.targetId)) throw absent(target.targetId); } },
      async getTargets() { calls.push({ method: "getTargets" }); return [{ id: "original-root", tabId: 7, type: "page", url: tab.url }, ...[...privateClients].map(id => ({ id, type: "iframe" }))]; },
      sendCommand(target, method, params) { calls.push({ method, target: clone(target), params: clone(params) }); return hooks.send?.(target, method, params) ?? nativeReply(target, method); }
    },
    tabs: { onRemoved: makeEvent(), onUpdated: makeEvent(), onDetached: makeEvent(), onAttached: makeEvent(), onMoved: makeEvent(), onReplaced: makeEvent(),
      async get(id) { if (id !== 7) throw Error("No original tab"); return clone(tab); },
      async query(filter = {}) { return filter.groupId !== undefined && filter.groupId !== 10 ? [] : [clone(tab)]; },
      async sendMessage(tabId, message, destination) { calls.push({ method: "message", tabId, message: clone(message), destination: clone(destination) }); return { ok: true, receiverToken: message.receiverToken ?? "original-receiver" }; },
      async update() { assert.fail("pointer feedback must not focus a tab"); }
    },
    tabGroups: { async get() { return { id: 10, windowId: 1 }; }, async query() { return [{ id: 10, windowId: 1 }]; }, async update() {} },
    windows: { onRemoved: makeEvent(), onFocusChanged: makeEvent(), async get() { return { id: 1, type: "normal", focused: true }; }, async update() { assert.fail("pointer feedback must not focus a window"); } },
    webNavigation: { async getFrame() { return { documentId: "original-document" }; } },
    scripting: { async executeScript() { return []; } }
  };
  const Backend = vm.runInNewContext(`${source.slice(0, end)}\nBrowserBackend`, {
    chrome, Date, URL, setTimeout, clearTimeout, indexedDB: realmStorage,
    createBrowserActionEngine() { assert.fail("cold raw feedback must not initialize or migrate to the action engine"); }
  });
  const backend = new Backend(); workers.push(backend);
  if (installed) chrome.runtime.onInstalled.emit({ reason: "install" });
  await backend.controlReady;
  if (awaitRealm) await backend.nativePointerRealm.ready;
  const state = await backend.store.getSession("task"); state.chromeGroupId = 10; state.activeTabId = 7; state.tabOrigins = { 7: "agent" };
  await backend.store.save();
  const current = await backend.getControlState({ session_id: "task" });
  const params = { session_id: "task", turn_id: "turn", control_epoch: current.controlEpoch, tabId: 7 };
  await backend.privatePointerRecovery.promise;
  t.after(async () => {
    for (const gate of gates) gate.resolve({});
    for (const name of Object.keys(hooks)) delete hooks[name];
    for (const worker of workers) {
      await Promise.allSettled([...worker.pointerFeedbackReads.pending].map(record => record.promise));
      await Promise.allSettled([...worker.attachedTabs].map(id => worker.detachTab(id)));
    }
    for (const database of realmConnections) database.close();
  });
  return { backend, Backend, chrome, calls, hooks, local, session, params, rootClients, privateClients, originalInputResult, absent, realmConnections,
    gate() { const value = deferred(); gates.push(value); return value; },
    move(extra = {}) { return { ...params, target: { tabId: 7 }, method: "Input.dispatchMouseEvent", commandParams: { type: "mouseMoved", x: 120.5, y: 80.25 }, ...extra }; },
    restart() { for (const value of events) value.clear(); const worker = new Backend(); workers.push(worker); return worker; }
  };
}

test("production first install durably enables cold reads without initializing an action engine", { timeout: 5000 }, async t => {
  const f = await fixture(t);
  assert.equal(f.backend.nativePointerStore.snapshot().available, true); assert.equal(f.backend.privatePointerTargets.snapshot().enabled, true);
  const privateWrites = f.calls.filter(c => c.method === "local.set" && (c.value[INITIALIZED] || c.value[LEDGER]));
  assert.deepEqual(privateWrites.map(c => Object.keys(c.value)), [[INITIALIZED], [LEDGER]]);
  await f.backend.attach(f.params); assert.equal(await f.backend.executeCdp(f.move()), f.originalInputResult);
  await f.backend.pointerFeedbackReads.drain();
  assert.equal(f.calls.filter(c => c.method === "attach").length, 1); assert.equal(f.backend.browserEngine, null);
  assert.ok(f.calls.some(c => c.method === "Target.getTargetInfo" && c.target.tabId === 7));
  assert.equal(f.calls.filter(c => c.method === "Runtime.releaseObjectGroup").length, 1);
});

for (const storage of ["pending", "unavailable"]) test(`${storage} realm storage never delays control startup or original input`, { timeout: 5000 }, async t => {
  const f = await fixture(t, { indexedDB: storage === "pending" ? { open: () => ({}) } : null, awaitRealm: false });
  assert.equal(f.backend.nativePointerRealm.capture(), null);
  assert.equal(f.backend.nativePointerRealm.snapshot().pending, storage === "pending");
  await f.backend.attach(f.params);
  assert.equal(await prompt(f.backend.executeCdp(f.move())), f.originalInputResult);
  const failure = Error("original input failed while realm unavailable");
  f.hooks.send = (_target, method) => method.startsWith("Input.") ? Promise.reject(failure) : undefined;
  await assert.rejects(prompt(f.backend.executeCdp(f.move())), error => error === failure);
  assert.equal(f.calls.some(call => call.method === "Page.createIsolatedWorld" || call.method === "Target.getTargetInfo"), false);
  assert.equal(f.backend.pointerFeedbackReads.pending.size, 0);
});

test("replacement production backend reuses committed realm identity without restoring attachment authority", { timeout: 5000 }, async t => {
  const f = await fixture(t), original = f.backend.nativePointerRealm.capture();
  assert.ok(original); await f.backend.attach(f.params);
  const replacement = f.restart(); await replacement.controlReady; await replacement.nativePointerRealm.ready;
  assert.deepEqual(replacement.nativePointerRealm.capture().identity, original.identity);
  assert.equal(replacement.attachmentEpochs.size, 0); assert.equal(replacement.attachedTabs.size, 0);
  assert.equal(f.calls.filter(call => call.method === "attach").length, 1);
});

test("revoked realm blocks later reads but releases an original allocation after its actual reply", { timeout: 5000 }, async t => {
  const f = await fixture(t), allocated = f.gate(), released = f.gate(); await f.backend.attach(f.params);
  f.hooks.send = (_target, method) => method === "Runtime.evaluate" ? allocated.promise : method === "Runtime.releaseObjectGroup" ? released.promise : undefined;
  assert.equal(await prompt(f.backend.executeCdp(f.move())), f.originalInputResult);
  await until(() => f.calls.some(call => call.method === "Runtime.evaluate"), "original allocation");
  const allocation = f.calls.find(call => call.method === "Runtime.evaluate");
  forceCloseDatabase(f.realmConnections[0]);
  await until(() => f.backend.nativePointerRealm.capture() === null, "realm connection revocation");
  assert.equal(await prompt(f.backend.executeCdp(f.move())), f.originalInputResult);
  assert.equal(f.calls.filter(call => call.method === "Page.createIsolatedWorld").length, 1);
  allocated.resolve({ result: { objectId: "late-original-wrapper" } });
  await until(() => f.calls.some(call => call.method === "Runtime.releaseObjectGroup"), "original group release");
  const release = f.calls.find(call => call.method === "Runtime.releaseObjectGroup");
  assert.deepEqual(release.target, allocation.target); assert.equal(release.params.objectGroup, allocation.params.objectGroup);
  assert.equal(f.backend.pointerFeedbackReads.pending.size, 1, "actual release must settle before cleanup finishes");
  assert.equal(f.calls.some(call => call.method === "Runtime.callFunctionOn"), false, "revoked identity cannot publish or continue DOM reads");
  released.resolve({}); await f.backend.pointerFeedbackReads.drain();
  assert.equal(f.backend.pointerFeedbackReads.pending.size, 0); assert.equal(f.rootClients.has(7), true);
  assert.equal(f.calls.filter(call => call.method.startsWith("Input.")).length, 2);
});

test("unknown private ownership preserves ordinary production input and its original native error", { timeout: 5000 }, async t => {
  const f = await fixture(t, { installed: false }); await f.backend.attach(f.params);
  assert.equal(f.backend.privatePointerTargets.snapshot().enabled, false);
  assert.equal(await prompt(f.backend.executeCdp(f.move())), f.originalInputResult);
  const original = Error("original input failure"); f.hooks.send = (_target, method) => method.startsWith("Input.") ? Promise.reject(original) : undefined;
  await assert.rejects(prompt(f.backend.executeCdp(f.move())), error => error === original);
  assert.equal(f.calls.some(c => c.method === "Target.getTargetInfo"), false);
  assert.equal(f.backend.pointerFeedbackReads.pending.size, 0);
});

test("production cold feedback retains one latest read while every original input completes", { timeout: 5000 }, async t => {
  const f = await fixture(t), firstIdentity = f.gate(); let identities = 0;
  await f.backend.attach(f.params);
  f.hooks.send = (target, method) => {
    if (method === "Target.getTargetInfo" && target.tabId === 7 && ++identities === 1) return firstIdentity.promise;
  };
  for (let index = 0; index < 4; index++) {
    const command = f.move({ commandParams: { type: "mouseMoved", x: 120 + index, y: 80 } });
    assert.equal(await prompt(f.backend.executeCdp(command)), f.originalInputResult);
  }
  assert.equal(identities, 1, "queued visual reads must not start overlapping native routes");
  assert.equal(f.backend.pointerFeedbackReads.pending.size, 2);
  assert.deepEqual(f.calls.filter(call => call.method === "Input.dispatchMouseEvent").map(call => call.params.x), [120, 121, 122, 123]);
  firstIdentity.resolve({ targetInfo: { targetId: "original-root", type: "page" } });
  await until(() => f.backend.pointerFeedbackReads.pending.size === 0, "original and latest native route cleanup");
  assert.equal(identities, 2, "only the original and latest queued routes may read");
  assert.equal(f.calls.filter(call => call.method === "Runtime.releaseObjectGroup").length, 2);
  assert.equal(f.backend.browserEngine, null);
});

for (const outcome of ["success", "error", "deadline"]) test(`held first native identity read does not extend the production raw ${outcome}`, { timeout: 5000 }, async t => {
  const f = await fixture(t), info = f.gate(), input = f.gate(), original = Error("original native input error");
  await f.backend.attach(f.params);
  f.hooks.send = (target, method) => {
    if (method === "Target.getTargetInfo" && target.tabId === 7) return info.promise;
    if (method.startsWith("Input.")) return outcome === "error" ? Promise.reject(original) : outcome === "deadline" ? input.promise : undefined;
  };
  const request = f.backend.executeCdp(f.move({ timeoutMs: outcome === "deadline" ? 30 : 1000 }));
  if (outcome === "success") assert.equal(await prompt(request), f.originalInputResult);
  else await assert.rejects(prompt(request), error => outcome === "error" ? error === original : /Timed out/.test(error.message));
  assert.equal(f.backend.pointerFeedbackReads.pending.size, 1);
  assert.equal(f.calls.filter(c => c.method.startsWith("Input.")).length, 1);
  assert.equal(f.calls.some(c => c.method === "Page.getFrameTree"), false);
  input.resolve(f.originalInputResult); info.resolve({}); await f.backend.pointerFeedbackReads.drain();
  assert.equal(f.backend.pointerFeedbackReads.pending.size, 0);
});

test("external root detach retains a held optional read fence after deleting the original attachment token", { timeout: 5000 }, async t => {
  const f = await fixture(t), info = f.gate(); await f.backend.attach(f.params);
  f.hooks.send = (target, method) => method === "Target.getTargetInfo" && target.tabId === 7 ? info.promise : undefined;
  await f.backend.executeCdp(f.move()); const original = f.backend.attachmentEpochs.get(7);
  f.rootClients.delete(7); f.chrome.debugger.onDetach.emit({ tabId: 7 }, "canceled_by_user");
  assert.ok(original); assert.equal(f.backend.attachmentEpochs.has(7), false); assert.equal(f.backend.pointerFeedbackReads.pending.size, 1);
  const before = f.calls.filter(c => c.method === "attach").length;
  await assert.rejects(f.backend.attach(f.params), /POINTER_CLEANUP_PENDING/);
  assert.equal(f.calls.filter(c => c.method === "attach").length, before);
  info.resolve({ targetInfo: { targetId: "original-root", type: "page" } }); await f.backend.pointerFeedbackReads.drain();
  assert.equal(f.calls.some(c => c.method === "Page.getFrameTree"), false);
  f.hooks.send = undefined; await f.backend.attach(f.params);
  assert.notEqual(f.backend.attachmentEpochs.get(7), original);
});

test("public detach explicitly retries exact original root absence after an external detach and failed cleanup", { timeout: 5000 }, async t => {
  const f = await fixture(t), allocated = f.gate(), absence = f.gate(); let queries = 0;
  await f.backend.attach(f.params);
  f.hooks.send = (target, method) => {
    if (method === "Runtime.evaluate") return allocated.promise;
    if (method === "Target.getTargetInfo" && target.targetId === "original-root") return ++queries === 1 ? Promise.reject(Error("original query policy failure")) : absence.promise;
  };
  await f.backend.executeCdp(f.move()); await until(() => f.calls.some(c => c.method === "Runtime.evaluate"), "original root allocation");
  f.rootClients.delete(7); f.chrome.debugger.onDetach.emit({ tabId: 7 }, "canceled_by_user");
  allocated.resolve({ result: { objectId: "late-original-wrapper" } });
  await assert.rejects(f.backend.pointerFeedbackReads.drain(), /original root attachment is unavailable/);
  assert.equal(queries, 1); assert.equal(f.backend.pointerFeedbackReads.pending.size, 1);
  await assert.rejects(f.backend.attach(f.params), /POINTER_CLEANUP_FAILED/);
  let done = false; const closing = f.backend.detach(f.params).then(() => { done = true; });
  await until(() => queries === 2, "explicit original-target absence retry"); await tick(); assert.equal(done, false);
  assert.equal(f.backend.pointerFeedbackReads.pending.size, 1); assert.equal(f.calls.filter(c => c.method === "Runtime.evaluate").length, 1);
  absence.reject(f.absent("original-root")); await closing;
  assert.equal(f.backend.pointerFeedbackReads.pending.size, 0);
  assert.equal(f.calls.filter(c => c.method === "Runtime.releaseObjectGroup").length, 0, "absence retires cleanup without inventing a release ACK");
  const targetQueries = f.calls.filter(c => c.method === "Target.getTargetInfo" && c.target.targetId);
  assert.deepEqual(targetQueries.map(c => c.target), [{ targetId: "original-root" }, { targetId: "original-root" }]);
});

test("replacement worker cleans a durable private intent using its target identity, never the stored root tab ID", { timeout: 5000 }, async t => {
  const f = await fixture(t), detached = f.gate();
  const record = { leaseId: "prior-lease", tabId: 7, rootTargetId: "original-root", targetId: "prior-child", parentFrameId: "original-root", phase: "intent" };
  await f.backend.nativePointerStore.load();
  await f.backend.nativePointerStore.save({ version: 1, incarnation: f.backend.browserLifetime.incarnation, records: [record] });
  f.privateClients.add(record.targetId); f.rootClients.add(7);
  f.hooks.detach = target => target.targetId === record.targetId ? detached.promise : undefined;
  const before = f.calls.length, replacement = f.restart(); await replacement.controlReady;
  await until(() => f.calls.slice(before).some(c => c.method === "detach"), "original private detach");
  assert.deepEqual(f.calls.slice(before).filter(c => c.method === "detach").map(c => c.target), [{ targetId: "prior-child" }]);
  assert.deepEqual(replacement.privatePointerTargets.snapshot().quarantined, [record.leaseId]);
  assert.equal(replacement.attachmentEpochs.size, 0); assert.equal(f.rootClients.has(7), true);
  detached.resolve(); await replacement.privatePointerRecovery.promise;
  assert.deepEqual(f.local[LEDGER].records, []); assert.deepEqual(replacement.privatePointerTargets.snapshot().quarantined, []);
  assert.equal(f.rootClients.has(7), true); assert.equal(f.privateClients.size, 0);
  assert.equal(f.calls.slice(before).some(c => c.method === "getTargets"), false);
});

test("public claim cannot reset a root while an old-token native allocation still needs cleanup", { timeout: 5000 }, async t => {
  const f = await fixture(t), allocation = f.gate(), resetQuery = f.gate(); let detached = false, claimSettled = false;
  await f.backend.attach(f.params);
  f.hooks.send = (target, method) => {
    if (method === "Runtime.evaluate") return allocation.promise;
    if (detached && method === "Target.getTargetInfo" && target.tabId === 7) return resetQuery.promise;
  };
  await f.backend.executeCdp(f.move()); await until(() => f.calls.some(c => c.method === "Runtime.evaluate"), "old native allocation");
  f.rootClients.delete(7); f.chrome.debugger.onDetach.emit({ tabId: 7 }, "canceled_by_user"); detached = true;
  assert.equal(f.backend.attachmentEpochs.has(7), false); assert.equal(f.backend.pointerFeedbackReads.pending.size, 1);
  const before = f.calls.length;
  const claim = f.backend.claimUserTab(f.params).then(value => { claimSettled = true; return { value }; }, error => { claimSettled = true; return { error }; });
  try {
    await until(() => claimSettled || f.backend.coldAttachmentResets.has(7), "claim admission or unsafe native reset");
    assert.equal(f.backend.coldAttachmentResets.has(7), false, "claim must not install a reset gate across the original cleanup route");
    assert.equal(f.calls.slice(before).some(c => c.method === "Target.getTargetInfo" && c.target.tabId === 7), false, "old allocation must settle before any cold-reset query");
    assert.match((await claim).error?.message ?? "", /POINTER_CLEANUP_PENDING/);
    allocation.resolve({ result: { objectId: "late-original-wrapper" } });
    await f.backend.pointerFeedbackReads.drain();
    assert.equal(f.backend.pointerFeedbackReads.pending.size, 0);
    assert.equal(f.calls.filter(c => c.method === "Runtime.evaluate").length, 1);
  } finally {
    resetQuery.resolve({}); allocation.resolve({ result: { objectId: "late-original-wrapper" } });
    await claim; await f.backend.pointerFeedbackReads.drain(() => true, { retryFailed: true }).catch(() => {});
  }
});
