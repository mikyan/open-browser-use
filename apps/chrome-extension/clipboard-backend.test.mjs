import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "./test-support/backend-vm.mjs";
import { SITE_ACCESS_POLICY_KEY } from "./site-access-policy.js";

const source = (await readFile(new URL("./background.js", import.meta.url), "utf8"))
  .replace('import { createBrowserActionEngine } from "./browser-runtime.js";', "")
  .replace('import { NativeInputTracker } from "./browser-input-adapter.js";',
    (await readFile(new URL("./browser-input-adapter.js", import.meta.url), "utf8")).replace(/^export /gm, ""));
const code = source.slice(0, source.indexOf("chrome.runtime.onInstalled.addListener"));
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const clone = value => structuredClone(value);
const event = () => { const listeners = []; return { addListener: fn => listeners.push(fn), removeListener() {}, emit: (...args) => listeners.forEach(fn => fn(...args)) }; };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

async function fixture(t, restricted = false) {
  const state = restricted ? { [SITE_ACCESS_POLICY_KEY]: { version: 1, revision: 1, mode: "allow", origins: ["https://allowed.test"] } } : {};
  const calls = [], accesses = [], hooks = {}, gates = [];
  const tabs = new Map([[7, { id: 7, groupId: 10, windowId: 1, url: "https://allowed.test/page" }], [8, { id: 8, groupId: 20, windowId: 1, url: "https://allowed.test/other" }]]);
  const frames = [{ frameId: 0, parentFrameId: -1, url: tabs.get(7).url, documentId: "root-document", documentLifecycle: "active", errorOccurred: false }];
  const chrome = {
    storage: { local: { async get(key) { return { [key]: clone(state[key]) }; }, async set(value) { Object.assign(state, clone(value)); } } },
    runtime: { id: "fixture", getManifest: () => ({ version: "test" }), getURL: path => `chrome-extension://fixture/${path}` },
    debugger: { onDetach: event(), onEvent: event(), async attach(target) { calls.push(["attach", target.tabId]); await hooks.attach?.(target); }, async detach({ tabId }) { calls.push(["detach", tabId]); },
      async sendCommand(target, method, args) {
        calls.push([method, target.tabId, args]);
        if (method === "Runtime.evaluate") throw new Error("clipboard must not evaluate page JavaScript");
        if (hooks.command) { const value = await hooks.command(method, args); if (value !== undefined) return value; }
        if (method === "Page.printToPDF") return { stream: "exact-export-stream" };
        if (method === "IO.read") return { data: btoa("%PDF-test"), base64Encoded: true, eof: true };
        return {};
      } },
    tabs: { onUpdated: event(), onDetached: event(), onReplaced: event(), onRemoved: event(),
      async get(id) { await hooks.get?.(id); return clone(tabs.get(id)); },
      async query(filter = {}) { await hooks.query?.(); return [...tabs.values()].filter(tab => filter.groupId === undefined || filter.groupId === tab.groupId).map(clone); },
      async sendMessage() { return {}; }, async update() { throw new Error("must not activate a tab"); } },
    windows: { async update() { throw new Error("must not focus a window"); } },
    webNavigation: { onBeforeNavigate: event(), onCommitted: event(), onErrorOccurred: event(), onHistoryStateUpdated: event(), onReferenceFragmentUpdated: event(), async getAllFrames() { return clone(frames); } },
    tabGroups: { async update() {} }
  };
  const createBrowserActionEngine = callbacks => {
    const pages = new Map(), generations = new Map();
    return { pages, generations,
      async attach(id) { if (pages.has(id)) return; await callbacks.onBeforeAttach(id); await chrome.debugger.attach({ tabId: id }); await callbacks.onAttached(id); pages.set(id, {}); },
      async detach(id) { pages.delete(id); await chrome.debugger.detach({ tabId: id }); await callbacks.onDetached(id); }, forget(id) { pages.delete(id); } };
  };
  const Backend = vm.runInNewContext(`${code}\nBrowserBackend`, { chrome, crypto, Date, URL, setTimeout, clearTimeout, createBrowserActionEngine });
  const backend = new Backend(); await backend.controlReady;
  backend.clipboardBroker.execute = async (scope, method, params, flags) => {
    accesses.push({ scope, method, params, flags });
    if (hooks.execute) return hooks.execute(scope, method, params, flags);
    flags.check();
    if (method === "readClipboardText") return { text: "trusted clipboard 中文" };
    if (method === "readClipboard") return { items: [{ presentation_style: "unspecified", entries: [{ mime_type: "text/plain", text: "plain" }, { mime_type: "text/html", text: "<b>rich</b>" }] }] };
    return {};
  };
  for (const [name, groupId, tabId] of [["task", 10, 7], ["other", 20, 8]]) {
    const session = await backend.store.getSession(name); session.chromeGroupId = groupId; session.tabOrigins = { [tabId]: "agent" };
  }
  await backend.store.save();
  const current = await backend.getControlState({ session_id: "task" });
  const params = { session_id: "task", turn_id: "turn", control_epoch: current.controlEpoch, tabId: 7 };
  t.after(async () => {
    for (const gate of gates) gate.resolve();
    for (const key of Object.keys(hooks)) delete hooks[key];
    await backend.clipboard.invalidateAll();
    await Promise.allSettled(backend.clipboard.controlSnapshot().pending);
    await Promise.allSettled([...backend.attachedTabs].map(id => backend.detachTab(id)));
  });
  return { Backend, backend, chrome, state, calls, accesses, hooks, tabs, frames, params, gate() { const gate = deferred(); gates.push(gate); return gate; } };
}

test("public clipboard methods use the trusted broker with owned document scope and no page JavaScript or activation", async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.backend.readClipboardText(f.params), { text: "trusted clipboard 中文" });
  assert.deepEqual(await f.backend.writeClipboardText({ ...f.params, text: "requested text" }), {});
  assert.equal((await f.backend.readClipboard(f.params)).items[0].entries[1].mime_type, "text/html");
  assert.deepEqual(await f.backend.writeClipboard({ ...f.params, items: [{ entries: [{ mime_type: "text/plain", text: "rich" }] }] }), {});
  assert.deepEqual(f.accesses.map(value => value.method), ["readClipboardText", "writeClipboardText", "readClipboard", "writeClipboard"]);
  for (const value of f.accesses) {
    assert.equal(value.scope.tabId, 7); assert.equal(value.scope.session_id, "task");
    assert.equal(value.scope.control_epoch, f.params.control_epoch);
    assert.equal(value.scope.attachment, f.backend.attachmentEpochs.get(7));
  }
  assert.equal(f.calls.some(([method]) => method === "Runtime.evaluate"), false);
  assert.equal(f.backend.clipboard.records.size, 0);
  assert.equal((await f.backend.getInfo()).metadata.clipboardVersion, 1);
});

test("foreign, unsupported document and malformed requests are rejected before broker access", async t => {
  const f = await fixture(t);
  await assert.rejects(f.backend.readClipboardText({ ...f.params, tabId: 8 }), /not part|owned/);
  f.tabs.get(7).url = "file:///private/document.html";
  await assert.rejects(f.backend.readClipboardText(f.params), /OBU_CLIPBOARD_UNSUPPORTED/);
  f.tabs.get(7).url = "https://allowed.test/page";
  await assert.rejects(f.backend.writeClipboardText({ ...f.params, text: "\ud800" }), /OBU_CLIPBOARD_INVALID/);
  await assert.rejects(f.backend.writeClipboard({ ...f.params, items: [{ entries: [{ mime_type: "image/jpeg", base64: "AAAA" }] }] }), /OBU_CLIPBOARD_INVALID/);
  assert.equal(f.accesses.length, 0); assert.equal(f.calls.length, 0);
});

test("restricted site modes deny every clipboard method before native setup", async t => {
  const f = await fixture(t, true);
  for (const [method, payload] of [["readClipboardText", {}], ["writeClipboardText", { text: "x" }], ["readClipboard", {}], ["writeClipboard", { items: [] }]]) await assert.rejects(f.backend[method]({ ...f.params, ...payload }), /OBU_SITE_ACCESS_UNSUPPORTED/);
  assert.equal(f.accesses.length, 0); assert.equal(f.calls.length, 0);
});

test("zero rich items are a scoped no-op and do not invoke the trusted broker", async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.backend.writeClipboard({ ...f.params, items: [] }), {});
  assert.equal(f.accesses.length, 0);
  await assert.rejects(f.backend.writeClipboard({ ...f.params, tabId: 8, items: [] }), /not part|owned/);
});

test("cold admission timeout keeps capacity occupied and prevents late broker dispatch", async t => {
  const f = await fixture(t), gate = f.gate(); f.hooks.query = () => gate.promise;
  await assert.rejects(f.backend.readClipboardText({ ...f.params, timeoutMs: 20 }), /OBU_CLIPBOARD_TIMEOUT/);
  assert.ok(f.backend.clipboard.controlSnapshot().pending.length);
  await assert.rejects(f.backend.readClipboardText(f.params), /OBU_CLIPBOARD_BUSY/);
  gate.resolve(); delete f.hooks.query;
  await Promise.allSettled(f.backend.clipboard.controlSnapshot().pending); await tick();
  assert.equal(f.accesses.length, 0); assert.equal(f.backend.clipboard.records.size, 0);
});

for (const kind of ["root", "child", "opened", "history", "moved"]) test(`clipboard ${kind} document or ownership change rejects late data and tracks actual broker settlement`, async t => {
  const f = await fixture(t), gate = f.gate(), entered = f.gate();
  f.hooks.execute = async () => { entered.resolve(); await gate.promise; return { text: "late private clipboard" }; };
  const rejected = assert.rejects(f.backend.readClipboardText(f.params), /OBU_CLIPBOARD_(DOCUMENT_CHANGED|CANCELLED)/);
  await entered.promise;
  if (kind === "root") f.backend.handleCdpEvent({ tabId: 7 }, "Page.frameNavigated", { frame: { id: "root" } });
  if (kind === "child") f.backend.handleCdpEvent({ tabId: 7, sessionId: "child" }, "Page.frameDetached", { frameId: "child" });
  if (kind === "opened") f.backend.handleCdpEvent({ tabId: 7 }, "Page.documentOpened", {});
  if (kind === "history") f.chrome.webNavigation.onHistoryStateUpdated.emit({ tabId: 7, frameId: 0, url: "https://allowed.test/new" });
  if (kind === "moved") f.chrome.tabs.onDetached.emit(7);
  await rejected;
  assert.ok(f.backend.globalControlSnapshot().pending.length); assert.equal(f.backend.clipboard.records.size, 1);
  gate.resolve(); await f.backend.clipboard.invalidateAll(); await tick();
  assert.equal(f.accesses.length, 1); assert.equal(f.backend.clipboard.records.size, 0);
});

test("native clipboard timeout does not detach or replay while the true operation is pending", async t => {
  const f = await fixture(t), gate = f.gate(), entered = f.gate();
  f.hooks.execute = async () => { entered.resolve(); await gate.promise; return {}; };
  const rejected = assert.rejects(f.backend.writeClipboardText({ ...f.params, text: "once", timeoutMs: 30 }), /OBU_CLIPBOARD_TIMEOUT/);
  await entered.promise; await rejected;
  assert.equal(f.calls.some(([method]) => method === "detach"), false);
  await assert.rejects(f.backend.readClipboardText(f.params), /OBU_CLIPBOARD_BUSY/);
  gate.resolve(); await f.backend.clipboard.invalidateAll(); await tick();
  assert.equal(f.accesses.length, 1);
});

test("end and native detach await actual broker completion rather than the rejected RPC", async t => {
  const f = await fixture(t), gate = f.gate(), entered = f.gate();
  f.hooks.execute = async () => { entered.resolve(); await gate.promise; return {}; };
  const rejected = assert.rejects(f.backend.writeClipboardText({ ...f.params, text: "already sent" }), /OBU_CLIPBOARD_CANCELLED/);
  await entered.promise;
  let ended = false; const ending = f.backend.turnEnded(f.params).then(() => { ended = true; });
  await rejected; await tick(); assert.equal(ended, false); assert.equal(f.calls.some(([method]) => method === "detach"), false);
  gate.resolve(); await ending;
  assert.equal(f.backend.clipboard.records.size, 0); assert.equal(f.accesses.length, 1);
});

test("captured CRX release drains only the original attachment's pending clipboard operation", async t => {
  const f = await fixture(t), gate = f.gate(), entered = f.gate();
  f.hooks.execute = async () => { entered.resolve(); await gate.promise; return { text: "old" }; };
  const rejected = assert.rejects(f.backend.readClipboardText(f.params), /OBU_CLIPBOARD_CANCELLED/);
  await entered.promise;
  const captured = f.backend.prepareInputRelease(7);
  let released = false; const release = captured.release().then(async () => { released = true; await captured.detach(); });
  await rejected; await tick(); assert.equal(released, false); assert.equal(f.calls.some(([method]) => method === "detach"), false);
  gate.resolve(); await release; assert.equal(f.accesses.length, 1);
});

test("a failed export close cannot drop the tab release barrier while clipboard native work is pending", async t => {
  const f = await fixture(t), gate = f.gate(), entered = f.gate();
  f.hooks.execute = async () => { entered.resolve(); await gate.promise; return { text: "late" }; };
  f.hooks.command = async method => { if (method === "IO.close") throw new Error("export close failed"); };
  const clipboardRejected = assert.rejects(f.backend.readClipboardText(f.params), /OBU_CLIPBOARD_CANCELLED/);
  await entered.promise;
  await assert.rejects(f.backend.exportPage({ ...f.params, format: "pdf" }), /OBU_EXPORT_CLEANUP_FAILED/);
  let released = false; const release = f.backend.detachTab(7).finally(() => { released = true; });
  const rejected = assert.rejects(release, /OBU_EXPORT_CLEANUP_FAILED/);
  await clipboardRejected; await tick();
  assert.equal(released, false); assert.equal(f.backend.controlReleases.has(7), true);
  assert.equal(f.calls.some(([method]) => method === "detach"), false);
  gate.resolve(); await rejected;
});

test("captured release cancels clipboard preparation before waiting for another capability's pending close", async t => {
  const f = await fixture(t), preparing = f.gate(), entered = f.gate(), closing = f.gate(), closeEntered = f.gate();
  let clipboardNativeCalls = 0;
  f.hooks.execute = async (_scope, _method, _params, flags) => { entered.resolve(); await preparing.promise; flags.check(); clipboardNativeCalls++; return {}; };
  f.hooks.command = async method => { if (method === "IO.close") { closeEntered.resolve(); await closing.promise; } };
  const clipboardRejected = assert.rejects(f.backend.writeClipboardText({ ...f.params, text: "must not commit" }), /OBU_CLIPBOARD_CANCELLED/);
  await entered.promise;
  const exportRejected = assert.rejects(f.backend.exportPage({ ...f.params, format: "pdf" }), /OBU_EXPORT_CANCELLED/);
  await closeEntered.promise;
  const release = f.backend.prepareInputRelease(7).release();
  preparing.resolve(); await clipboardRejected;
  assert.equal(clipboardNativeCalls, 0);
  closing.resolve(); await exportRejected; await release;
});

test("Pause blocks new requests immediately but acknowledges cleanup only after true clipboard settlement", async t => {
  const f = await fixture(t), gate = f.gate(), entered = f.gate();
  f.hooks.execute = async () => { entered.resolve(); await gate.promise; return { text: "old" }; };
  const rejected = assert.rejects(f.backend.readClipboardText(f.params), /OBU_CLIPBOARD_CANCELLED|OBU_AUTOMATION_PAUSED/);
  await entered.promise;
  let paused = false; const pausing = f.backend.pauseAutomation().then(() => { paused = true; });
  await rejected; await tick(); assert.equal(paused, false);
  await assert.rejects(f.backend.getControlState({ session_id: "task" }), /OBU_AUTOMATION_PAUSED/);
  await assert.rejects(f.backend.readClipboardText(f.params), /OBU_CLIPBOARD_BUSY|OBU_AUTOMATION_PAUSED/);
  gate.resolve(); await pausing;
  assert.equal(f.backend.automationControl.status().inputBlocked, true); assert.equal(f.accesses.length, 1);
});

test("final ownership change after a trusted result prevents returning clipboard data", async t => {
  const f = await fixture(t);
  f.hooks.execute = async () => { f.tabs.get(7).groupId = 20; return { text: "must not be returned" }; };
  await assert.rejects(f.backend.readClipboardText(f.params), /not part|owned|OBU_CLIPBOARD_CANCELLED/);
  assert.equal(f.accesses.length, 1);
});

test("raw-to-engine migration preserves the exact pending clipboard setup", async t => {
  const f = await fixture(t); await f.backend.attach(f.params);
  const original = f.backend.attachmentEpochs.get(7);
  assert.deepEqual(await f.backend.readClipboardText(f.params), { text: "trusted clipboard 中文" });
  assert.equal(f.accesses.length, 1);
  assert.notEqual(f.backend.attachmentEpochs.get(7), original);
});

test("old-owner attachment cleanup preserves a new proven owner's first clipboard setup", async t => {
  const f = await fixture(t); await f.backend.attach(f.params);
  const original = f.backend.attachmentEpochs.get(7);
  f.tabs.get(7).groupId = 20;
  const control = await f.backend.getControlState({ session_id: "other" });
  const next = { ...f.params, session_id: "other", turn_id: "other-turn", control_epoch: control.controlEpoch };
  assert.deepEqual(await f.backend.readClipboardText(next), { text: "trusted clipboard 中文" });
  assert.equal(f.accesses.length, 1); assert.equal(f.accesses[0].scope.session_id, "other");
  assert.notEqual(f.backend.attachmentEpochs.get(7), original);
  await assert.rejects(f.backend.readClipboardText(f.params), /not part|owned/);
});

test("auxiliary source movement found in final validation cannot wait on its own clipboard cleanup", { timeout: 1000 }, async t => {
  const f = await fixture(t);
  Object.assign(f.tabs.get(7), { groupId: -1, windowId: 2 });
  const claim = f.backend.auxiliaryTabs.reserve(f.params);
  await f.backend.auxiliaryTabs.commit(claim, { windowId: 2, control_epoch: f.params.control_epoch, check() {}, async validate() {} });
  f.hooks.execute = async () => { f.tabs.get(7).windowId = 3; return { text: "unowned" }; };
  await assert.rejects(f.backend.readClipboardText(f.params), /OBU_CLIPBOARD_CANCELLED/);
  await Promise.all([...f.backend.auxiliaryReleases.values()]);
  assert.equal(f.backend.clipboard.records.size, 0); assert.equal(f.backend.auxiliaryTabs.entry(7), undefined);
});

test("transient startup broker recovery failure keeps old epochs fenced but explicit cleanup and Resume can start fresh work", async t => {
  const f = await fixture(t);
  await f.backend.requireSession(f.params);
  const oldEpoch = f.params.control_epoch;
  const restarted = new f.Backend();
  const metadata = { version: 1, documentId: "original-offscreen-document", documentNonce: crypto.randomUUID(), operationId: crypto.randomUUID(), targetId: "original-target", session_id: "task", tabId: 7 };
  let retries = 0;
  // Model a transient inability to reach the persisted original document.
  // Broker unit tests separately exercise its real Port/rebind protocol.
  restarted.clipboardBroker.recover = async () => { throw restarted.clipboardBroker.markUnknown(metadata); };
  restarted.clipboardBroker.retryCleanup = async () => {
    retries++;
    restarted.clipboardBroker.unknown.resolve();
    restarted.clipboardBroker.unknown = null;
  };
  restarted.clipboardBroker.execute = f.backend.clipboardBroker.execute;
  t.after(async () => { await restarted.clipboard.invalidateAll(); await Promise.allSettled([...restarted.attachedTabs].map(id => restarted.detachTab(id))); });
  await restarted.controlReady;
  assert.equal(restarted.automationControl.status().inputBlocked, true);
  assert.equal(f.state.OPEN_BROWSER_USE_AUTOMATION_CONTROL.paused, true);
  assert.notEqual(restarted.controlLedger.records.get("task").epoch, oldEpoch);
  assert.ok(restarted.globalControlSnapshot().pending.length);
  await assert.rejects(restarted.getControlState({ session_id: "task" }), /OBU_AUTOMATION_PAUSED/);
  assert.equal(f.accesses.length, 0); assert.equal(retries, 0);
  const paused = await restarted.pauseAutomation();
  assert.equal(retries, 1); assert.equal(paused.cleanupComplete, true);
  await restarted.resumeAutomation(paused.revision);
  await assert.rejects(restarted.readClipboardText(f.params), /OBU_STALE_CONTROL_EPOCH/);
  const current = await restarted.getControlState({ session_id: "task" });
  assert.notEqual(current.controlEpoch, oldEpoch);
  assert.deepEqual(await restarted.readClipboardText({ ...f.params, turn_id: "explicit-new-turn", control_epoch: current.controlEpoch }), { text: "trusted clipboard 中文" });
  assert.equal(f.accesses.length, 1); assert.equal(retries, 1);
});

test("Pause cannot acknowledge while startup broker reconciliation is awaiting the original native operation", { timeout: 1500 }, async t => {
  const f = await fixture(t), recoveryGate = f.gate(), recoveryEntered = f.gate();
  await f.backend.requireSession(f.params);
  const metadata = { version: 1, documentId: "original-offscreen-document", documentNonce: crypto.randomUUID(), operationId: crypto.randomUUID(), targetId: "original-target", session_id: "task", tabId: 7 };
  await f.chrome.storage.session.set({ obuClipboardPendingV1: metadata });
  Object.assign(f.chrome.runtime, { onConnect: event(), getContexts: async () => [], sendMessage: async () => {} });
  f.chrome.offscreen = { createDocument: async () => {}, closeDocument: async () => {} };
  f.chrome.debugger.getTargets = async () => [];
  const restarted = new f.Backend();
  // Keep recover()/recoverPending() and their lifecycle accounting real.
  // This seam models the original offscreen bind waiting for native settlement;
  // broker unit tests exercise the full private Port/native wait itself.
  restarted.clipboardBroker.reconcile = async recovered => {
    assert.equal(recovered.operationId, metadata.operationId);
    recoveryEntered.resolve(); await recoveryGate.promise;
    await f.chrome.storage.session.set({ obuClipboardPendingV1: null });
  };
  restarted.automationCleanupTimeoutMs = 30;
  t.after(async () => {
    recoveryGate.resolve();
    await restarted.controlReady.catch(() => {});
    await Promise.allSettled([...restarted.attachedTabs].map(id => restarted.detachTab(id)));
  });
  await recoveryEntered.promise;
  assert.ok(restarted.globalControlSnapshot().pending.length, "Startup broker reconciliation vanished from the global drain");
  let released = false;
  const releasing = restarted.detachTab(7).then(() => { released = true; });
  await tick(); assert.equal(released, false);
  await assert.rejects(restarted.pauseAutomation(), /OBU_AUTOMATION_(CLEANUP_TIMEOUT|PAUSE_FAILED)/);
  assert.equal(released, false); assert.equal(f.calls.some(([method]) => method === "detach"), false);
  assert.equal(restarted.automationControl.status().inputBlocked, true);
  assert.equal(restarted.automationControl.status().cleanupComplete, false);
  assert.ok(restarted.globalControlSnapshot().pending.length);
  recoveryGate.resolve(); await releasing; await restarted.controlReady;
  restarted.automationCleanupTimeoutMs = 1000;
  const retried = await restarted.pauseAutomation();
  assert.equal(retried.cleanupComplete, true); assert.equal(released, true);
  assert.equal(f.accesses.length, 0);
});

test("failed startup marker read cannot make Retry Pause acknowledge cleanup before a real successful read", { timeout: 1500 }, async t => {
  const f = await fixture(t), readGate = f.gate();
  await f.backend.requireSession(f.params);
  const originalGet = f.chrome.storage.session.get;
  let reads = 0, mode = "fail";
  f.chrome.storage.session.get = async key => {
    if (key === "obuClipboardPendingV1") {
      reads++;
      if (mode === "fail") throw new Error("synthetic startup marker read failed");
      if (mode === "wait") await readGate.promise;
    }
    return originalGet(key);
  };
  const restarted = new f.Backend();
  t.after(async () => {
    mode = "ready"; readGate.resolve();
    await restarted.clipboardBroker.retryCleanup().catch(() => {});
    f.chrome.storage.session.get = originalGet;
  });
  await restarted.controlReady;
  assert.equal(reads, 1); assert.equal(restarted.automationControl.status().inputBlocked, true);
  assert.ok(restarted.globalControlSnapshot().pending.length);
  restarted.automationCleanupTimeoutMs = 30;
  await assert.rejects(restarted.pauseAutomation(), /startup marker read failed|OBU_AUTOMATION_PAUSE_FAILED/);
  assert.equal(reads, 2); assert.equal(restarted.automationControl.status().cleanupComplete, false);
  mode = "wait";
  await assert.rejects(restarted.pauseAutomation(), /OBU_AUTOMATION_(CLEANUP_TIMEOUT|PAUSE_FAILED)/);
  assert.equal(reads, 3); assert.equal(restarted.automationControl.status().cleanupComplete, false);
  assert.ok(restarted.globalControlSnapshot().pending.length);
  readGate.resolve(); await restarted.clipboardBroker.retryCleanup();
  restarted.automationCleanupTimeoutMs = 1000;
  const paused = await restarted.pauseAutomation();
  assert.equal(paused.cleanupComplete, true); assert.equal(f.accesses.length, 0);
  await restarted.resumeAutomation(paused.revision);
  await assert.rejects(restarted.readClipboardText(f.params), /OBU_STALE_CONTROL_EPOCH/);
});
