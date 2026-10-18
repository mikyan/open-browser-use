import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "./test-support/backend-vm.mjs";

const source = (await readFile(new URL("./background.js", import.meta.url), "utf8"))
  .replace('import { createBrowserActionEngine } from "./browser-runtime.js";', "")
  .replace('import { NativeInputTracker } from "./browser-input-adapter.js";', (await readFile(new URL("./browser-input-adapter.js", import.meta.url), "utf8")).replace(/^export /gm, ""));
const code = source.slice(0, source.indexOf("chrome.runtime.onInstalled.addListener"));
const clone = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const defer = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function fixture({ managed = true, command, write, detach, authority = () => {}, policy } = {}) {
  const calls = [], states = [], storage = {}, listeners = new Set(), detachListeners = new Set();
  let documentId = "original-document";
  if (policy) storage.OPEN_BROWSER_USE_SITE_ACCESS_POLICY = { version: 1, revision: 1, ...policy };
  const tab = { id: 7, groupId: 10, windowId: 1, pinned: false, url: "https://fixture.test", title: "Original" };
  const chrome = {
    webNavigation: { async getFrame() { return { documentId }; },
      async getAllFrames() { return [{ frameId: 0, parentFrameId: -1, url: tab.url, documentId, documentLifecycle: "active", errorOccurred: false }]; } },
    storage: { local: {
      async get(key) { return Object.hasOwn(storage, key) ? { [key]: clone(storage[key]) } : {}; },
      async set(value) { await write?.(value); Object.assign(storage, clone(value)); }
    } },
    debugger: {
      onEvent: { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) },
      onDetach: { addListener: fn => detachListeners.add(fn) },
      async getTargets() { return [{ id: "original-target", tabId: 7, type: "page", url: tab.url }]; },
      async attach(target) { calls.push(["attach", clone(target)]); },
      async detach(target) { calls.push(["detach", clone(target)]); await detach?.(target); },
      async sendCommand(target, method, params) {
        calls.push([method, clone(target), params === undefined ? undefined : clone(params)]);
        const response = await command?.(target, method, params);
        if (method === "Page.startScreencast") queueMicrotask(() => {
          for (const listener of [...listeners]) listener(target, "Page.screencastFrame", { sessionId: 42, data: "cGl4ZWxz", metadata: { deviceWidth: 800, deviceHeight: 600, pageScaleFactor: 1, offsetTop: 0, monotonicTimestamp: 101 } });
        });
        if (response !== undefined) return response;
        if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "root", loaderId: "loader-" + documentId, url: tab.url } } };
        if (method === "Performance.getMetrics") return { metrics: [{ name: "Timestamp", value: 100 }] };
        return method === "Page.getLayoutMetrics" ? { cssVisualViewport: { clientWidth: 800, clientHeight: 600, scale: 1, zoom: 1, offsetX: 0, offsetY: 0 } } : {};
      }
    },
    tabs: { async get() { return { ...tab }; }, async query() { return [{ ...tab }]; },
      async sendMessage(_tabId, message) { return { ok: true, receiverToken: message.receiverToken ?? "receiver" }; },
      async update() { throw new Error("Must not activate the original tab"); } },
    windows: { async update() { throw new Error("Must not focus the original window"); } },
    tabGroups: { async get() { return {}; }, async query() { return []; } }
  };
  const Backend = vm.runInNewContext(`${code}\nBrowserBackend;`, { chrome, Date, URL, setTimeout, clearTimeout,
    managedConfig: managed ? { version: 1, nativeHostName: "com.openbrowseruse.managed.n0123456789abcdef0123456789abcdef" } : null });
  const backend = new Backend(); await backend.controlReady;
  if (managed) backend.commitManagedUserOpen(await backend.prepareManagedUserOpen({ workerBootId: "fixture-worker" }));
  const session = await backend.store.getSession("task"); session.chromeGroupId = 10; session.tabOrigins = { 7: "agent" }; await backend.store.save();
  const first = await backend.getControlState({ session_id: "task" });
  const params = { session_id: "task", turn_id: first.nextTurnId, control_epoch: first.controlEpoch, tabId: 7 };
  await backend.attach(params);
  const frames = [];
  const begin = () => backend.beginManagedHuman(7, authority, frame => frames.push(frame), state => states.push(state));
  return { backend, Backend, chrome, calls, storage, first, params, begin, frames, states, tab,
    event: (method, params) => { for (const listener of [...listeners]) listener({ targetId: "original-target" }, method, params); },
    changeDocument: () => { documentId = "replacement-document"; },
    emitDetach: (source, reason) => { for (const fn of detachListeners) fn(source, reason); } };
}
function input(handle, value) { const info = handle.info(); return handle.input({ leaseId: info.leaseId, generation: info.generation, sequence: info.lastInputSequence + 1, input: value }); }

test("dialog dispatch retains the exact restricted navigation proof, not only policy revision", async () => {
  const f = await fixture({ policy: { mode: "allow", origins: ["https://fixture.test"] } }), handle = await f.begin();
  assert.ok(f.backend.managedHuman.current.epoch.candidate.siteProof);
  f.event("Page.javascriptDialogOpening", { type: "confirm", message: "Original?", frameId: "root", url: f.tab.url });
  const { leaseId, generation, dialogId } = handle.pendingDialog();
  const response = handle.respondDialog({ leaseId, generation, dialogId, accept: true });
  const rejected = assert.rejects(response, /DIALOG_STALE/);
  f.backend.siteNavigationVersions.set(7, (f.backend.siteNavigationVersions.get(7) ?? 0) + 1);
  await rejected; await handle.close();
  assert.deepEqual(f.calls.filter(([method]) => method === "Page.handleJavaScriptDialog").map(row => row[2]), [{ accept: false }]);
});

test("dialog policy checks every actual ancestor origin without asynchronous page reads", async () => {
  const f = await fixture({ policy: { mode: "allow", origins: ["https://fixture.test", "https://remote.test"] } }), handle = await f.begin();
  const candidate = f.backend.managedHuman.current.epoch.candidate;
  f.chrome.webNavigation.getAllFrames = () => { throw new Error("Modal policy must not read the page"); };
  f.backend.managedHuman.assertDialog(candidate, ["https://fixture.test", "https://remote.test"]);
  for (const denied of [["https://remote.test", "https://denied.test"], ["https://denied.test", "https://remote.test"], ["null"]])
    assert.throws(() => f.backend.managedHuman.assertDialog(candidate, denied), /SITE_ACCESS_DENIED/);
  assert.equal(f.calls.some(([method]) => method === "Page.handleJavaScriptDialog"), false);
  await handle.close();
});

test("real backend native dialog decisions retain original policy and browser lifetime without page re-reads", async () => {
  for (const revoke of [backend => { Object.defineProperty(backend.siteAccess, "generation", { value: backend.siteAccess.generation + 1 }); },
    backend => { backend.sitePolicyUpdate = {}; }, backend => { backend.browserLifetime.isCurrent = () => false; }]) {
    const f = await fixture(), handle = await f.begin();
    f.event("Page.javascriptDialogOpening", { type: "prompt", message: "Original?", defaultPrompt: "old", frameId: "root", url: f.tab.url });
    const { leaseId, generation, dialogId } = handle.pendingDialog();
    const response = handle.respondDialog({ leaseId, generation, dialogId, accept: true, promptText: "must not submit" });
    const rejected = assert.rejects(response, /DIALOG_STALE/); revoke(f.backend); await rejected;
    await handle.close();
    assert.deepEqual(f.calls.filter(([method]) => method === "Page.handleJavaScriptDialog").map(([, target, params]) => [target, params]),
      [[{ targetId: "original-target" }, { accept: false }]]);
    assert.equal(f.storage.OPEN_BROWSER_USE_INPUT_RISKS.risks.length, 0);
  }
});

test("real backend human handoff invalidates old tasks and popup Resume remains fenced until actual close", async () => {
  const f = await fixture(), pending = f.begin();
  assert.ok(f.backend.managedHuman.status());
  await assert.rejects(f.backend.resumeAutomation(f.backend.automationControl.revision), /releasing human control/);
  const handle = await pending;
  assert.equal(f.backend.attachedTabs.size, 0); assert.equal(f.backend.attachmentOwners.size, 0);
  assert.equal(f.backend.automationControl.state, "paused");
  const taskDetach = f.calls.findIndex(([method, target]) => method === "detach" && target.tabId === 7);
  const humanAttach = f.calls.findIndex(([method, target]) => method === "attach" && target.targetId === "original-target");
  assert.ok(taskDetach >= 0 && humanAttach > taskDetach);
  await assert.rejects(f.backend.executeCdp({ ...f.params, target: { tabId: 7 }, method: "Input.insertText", commandParams: { text: "task blocked" } }), /AUTOMATION_PAUSED/);
  await input(handle, { type: "text", text: "one human input" });
  await assert.rejects(f.backend.resumeAutomation(f.backend.automationControl.revision), /releasing human control/);
  assert.equal(f.backend.automationControl.state, "paused");
  await handle.close();
  assert.equal(f.storage.OPEN_BROWSER_USE_INPUT_RISKS.risks.length, 0);
  await f.backend.resumeAutomation(f.backend.automationControl.revision);
  await assert.rejects(f.backend.attach(f.params), /STALE_CONTROL_EPOCH/);
  const next = await f.backend.getControlState({ session_id: "task" });
  await f.backend.attach({ ...f.params, control_epoch: next.controlEpoch, turn_id: next.nextTurnId });
  assert.equal(f.calls.filter(([method]) => method === "Input.insertText").length, 1);
});

test("ordinary installation and an already paused bare tab cannot grant a human attachment", async () => {
  const ordinary = await fixture({ managed: false });
  assert.throws(() => ordinary.begin(), /ordinary browser/);
  const f = await fixture(); await f.backend.pauseAutomation();
  await assert.rejects(f.begin(), /AUTOMATION_PAUSED/);
  assert.equal(f.calls.some(([method, target]) => method === "attach" && target.targetId), false);
  assert.equal(f.backend.managedHuman.status(), null);
});

test("backend keeps complete frame coordinates when the original CSS client excludes scrollbars", async () => {
  const f = await fixture({ command: (_target, method) => method === "Page.getLayoutMetrics" ?
    { cssVisualViewport: { clientWidth: 785, clientHeight: 600, scale: 1, zoom: 1, offsetX: 0, offsetY: 0 } } : undefined });
  const handle = await f.begin();
  assert.deepEqual(clone(handle.info().viewport), { width: 800, height: 600 });
  await input(handle, { type: "pointer", action: "move", x: 799, y: 599 });
  const actual = f.calls.filter(([method]) => method === "Input.dispatchMouseEvent");
  assert.equal(actual.length, 1); assert.deepEqual(actual[0][1], { targetId: "original-target" });
  assert.equal(actual[0][2].x, 799); assert.equal(actual[0][2].y, 599);
  assert.equal(f.backend.automationControl.state, "paused"); await handle.close();
  assert.equal(f.storage.OPEN_BROWSER_USE_INPUT_RISKS.risks.length, 0);
});

test("a document change during the task Pause cannot be adopted as the original human page", async () => {
  const gate = defer(); let f;
  f = await fixture({ detach: target => target.tabId === 7 ? gate.promise : undefined });
  const beginning = f.begin(); beginning.catch(() => {}); await tick(); f.changeDocument(); gate.resolve();
  await assert.rejects(beginning, /original document/);
  assert.equal(f.calls.some(([method, target]) => method === "attach" && target.targetId), false);
});

test("ordinary Pause joins actual human down and cleanup while rejecting late human input", async () => {
  const gate = defer();
  const f = await fixture({ command: (target, method, params) => target.targetId && method === "Input.dispatchMouseEvent" && params.type === "mousePressed" ? gate.promise : undefined });
  const handle = await f.begin();
  const sending = input(handle, { type: "pointer", action: "down", x: 12, y: 13, button: "left" }); sending.catch(() => {}); await tick();
  let done = false; const pausing = f.backend.pauseAutomation().then(() => { done = true; });
  await tick(); assert.equal(done, false);
  assert.equal(f.calls.some(([method, target]) => method === "detach" && target.targetId), false);
  gate.resolve(); assert.equal((await sending).acknowledged, true); await pausing;
  assert.equal(handle.info().state, "released"); assert.equal(f.backend.managedHuman.status(), null);
  assert.equal(f.backend.automationControl.state, "paused");
});

test("human onDetach is consumed without invoking the old task attachment release path", async () => {
  const f = await fixture(), handle = await f.begin(); let taskReleases = 0;
  const original = f.backend.releaseEngineAttachment.bind(f.backend);
  f.backend.releaseEngineAttachment = (...args) => { taskReleases++; return original(...args); };
  f.emitDetach({ tabId: 7 }, "canceled_by_user");
  await assert.rejects(handle.close(), /did not confirm/);
  assert.equal(taskReleases, 0);
  f.backend.managedHuman.invalidateTab(7, { destroyed: true }); await handle.close();
});

test("worker restart preserves a human input risk instead of silently resuming", async () => {
  const f = await fixture(), handle = await f.begin();
  await input(handle, { type: "key", action: "down", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16 });
  assert.equal(f.storage.OPEN_BROWSER_USE_INPUT_RISKS.risks.length, 1);
  const before = f.calls.length;
  const restarted = new f.Backend(); await restarted.controlReady;
  assert.equal((await restarted.getAutomationControlStatus()).state, "error");
  await assert.rejects(restarted.resumeAutomation(restarted.automationControl.revision), /OBU_MANAGED_WORKER_RECOVERY_REQUIRED/);
  await assert.rejects(restarted.prepareManagedUserOpen({ workerBootId: "replacement-worker" }), /OBU_INPUT_RELEASE_UNCONFIRMED/);
  assert.equal(f.calls.slice(before).some(([method]) => method.startsWith("Input.")), false);
  await handle.close();
});

test("popup Resume remains blocked through actual human detach and the durable risk clear", async () => {
  const detach = defer(), detachEntered = defer(), clear = defer(), clearEntered = defer(); let holdClear = false;
  const f = await fixture({
    detach: target => { if (target.targetId) { detachEntered.resolve(); return detach.promise; } },
    write: value => {
      if (holdClear && value.OPEN_BROWSER_USE_INPUT_RISKS?.risks.length === 0) { clearEntered.resolve(); return clear.promise; }
    }
  });
  const handle = await f.begin(); holdClear = true;
  let completed = false; const closing = handle.close().then(() => { completed = true; });
  await detachEntered.promise;
  await assert.rejects(f.backend.resumeAutomation(f.backend.automationControl.revision), /OBU_HUMAN_BUSY/);
  assert.equal(completed, false); assert.equal(f.backend.automationControl.state, "paused");
  detach.resolve(); await clearEntered.promise;
  await assert.rejects(f.backend.resumeAutomation(f.backend.automationControl.revision), /OBU_HUMAN_BUSY/);
  assert.equal(completed, false); assert.equal(f.storage.OPEN_BROWSER_USE_INPUT_RISKS.risks.length, 1);
  clear.resolve(); await closing;
  assert.equal((await f.backend.resumeAutomation(f.backend.automationControl.revision)).state, "running");
});

test("revoked human Begin joins the actual task Pause without obtaining a replacement attachment", async () => {
  const cleanup = defer(), entered = defer(); let authorized = true;
  const f = await fixture({ authority: () => { if (!authorized) throw new Error("original channel revoked"); },
    detach: target => { if (target.tabId === 7) { entered.resolve(); return cleanup.promise; } } });
  const beginning = f.begin(); beginning.catch(() => {}); await entered.promise;
  authorized = false;
  let complete = false; beginning.finally(() => { complete = true; }).catch(() => {});
  await tick(); assert.equal(complete, false);
  await assert.rejects(f.backend.resumeAutomation(f.backend.automationControl.revision), /OBU_HUMAN_BUSY/);
  cleanup.resolve(); await assert.rejects(beginning, /original channel revoked/);
  assert.equal(f.backend.managedHuman.status(), null); assert.equal(f.backend.automationControl.state, "paused");
  assert.equal(f.calls.some(([method, target]) => method === "attach" && target.targetId), false);
  assert.equal(f.backend.attachmentOwners.size, 0);
});

test("a contradictory debugger source cannot revoke the human lease or release task owners", async () => {
  const f = await fixture(), handle = await f.begin();
  f.emitDetach({ targetId: "original-target", tabId: 8 }, "target_closed");
  assert.equal(handle.info().state, "active");
  assert.equal(f.backend.attachmentOwners.size, 0);
  assert.equal(f.backend.attachedTabs.size, 0);
  f.emitDetach({ targetId: "original-target", tabId: 7 }, "target_closed");
  await handle.close(); assert.equal(handle.info().state, "released");
});


test("real backend keeps human navigation in the restricted site ledger after task ownership is paused", async () => {
  const f = await fixture({ policy: { mode: "allow", origins: ["https://fixture.test"] } }), handle = await f.begin();
  assert.equal(f.backend.attachedTabs.size, 0); assert.equal(f.backend.attachmentOwners.size, 0);
  f.backend.onSiteNavigation({ tabId: 7, frameId: 0, url: "https://fixture.test/next" }, "pending");
  assert.equal(handle.info().state, "navigating"); assert.equal(f.backend.sitePendingFrames.get(7).get(0), "https://fixture.test/next");
  const version = f.backend.siteNavigationVersions.get(7);
  f.changeDocument(); f.tab.url = "https://fixture.test/next";
  f.backend.onSiteNavigation({ tabId: 7, frameId: 0, url: f.tab.url }, "committed");
  await f.backend.managedHuman.current.recovery;
  assert.equal(handle.info().state, "active"); assert.ok(f.backend.siteNavigationVersions.get(7) > version);
  assert.equal(f.backend.sitePendingFrames.has(7), false);
  assert.equal(f.states.some(state => state.state === "navigating" && state.viewport === null), true);
  await input(handle, { type: "text", text: "allowed new document" });
  await assert.rejects(f.backend.resumeAutomation(f.backend.automationControl.revision), /OBU_HUMAN_BUSY/);
  await handle.close(); assert.equal(f.backend.automationControl.state, "paused");
});

test("human tab metadata clears the original address during navigation and adopts only the verified successor", async t => {
  const f = await fixture(), handle = await f.begin(); t.after(() => handle.close());
  assert.deepEqual(clone(handle.tabInfo()), { id: 7, title: "Original", url: "https://fixture.test" });
  f.backend.onSiteNavigation({ tabId: 7, frameId: 0, url: "https://fixture.test/B" }, "pending");
  assert.deepEqual(clone(handle.tabInfo()), { id: 7, title: "页面正在跳转", url: "" });
  f.changeDocument(); f.tab.title = "Current B"; f.tab.url = "https://fixture.test/B";
  f.backend.onSiteNavigation({ tabId: 7, frameId: 0, url: f.tab.url }, "committed");
  await f.backend.managedHuman.current.recovery;
  assert.deepEqual(clone(handle.tabInfo()), { id: 7, title: "Current B", url: "https://fixture.test/B" });
  assert.equal(f.calls.filter(([method]) => method.startsWith("Input.")).length, 0);
  assert.equal(f.calls.filter(([method, target]) => method === "attach" && target.targetId).length, 1);
});

test("human tab metadata bounds native titles and URLs without changing original candidate identity", async t => {
  const f = await fixture(); t.after(() => f.backend.pauseAutomation());
  f.tab.title = "A".repeat(600); f.tab.url = "https://fixture.test/#" + "x".repeat(9000);
  const candidate = await f.backend.captureManagedHumanPage(7);
  assert.equal(candidate.title, "A".repeat(512)); assert.equal(candidate.url, f.tab.url.slice(0, 8192));
  f.tab.title = "B".repeat(700); f.tab.url = "https://fixture.test/#" + "y".repeat(9000);
  const verified = await f.backend.validateManagedHumanPage(candidate);
  assert.equal(verified.title, "B".repeat(512)); assert.equal(verified.url, f.tab.url.slice(0, 8192));
  for (const key of ["tabId", "targetId", "documentId", "windowId", "groupId", "pinned", "incarnation", "policyGeneration", "policyRevision"])
    assert.equal(verified[key], candidate[key], key);
  assert.equal(candidate.title, "A".repeat(512)); assert.equal(Object.isFrozen(verified), true);
});

test("a denied pending navigation of a human-only page revokes the whole lease before any new input", async () => {
  const f = await fixture({ policy: { mode: "allow", origins: ["https://fixture.test"] } }), handle = await f.begin();
  f.backend.onSiteNavigation({ tabId: 7, frameId: 4, url: "https://denied.test/frame" }, "pending");
  assert.equal(f.backend.siteRevokedTabs.has(7), true);
  await assert.rejects(input(handle, { type: "text", text: "forbidden" }), /revoked/);
  await handle.close(); assert.equal(handle.info().state, "released");
  assert.equal(f.calls.filter(([method]) => method === "Page.startScreencast").length, 1);
  assert.equal(f.calls.filter(([method]) => method === "Input.insertText").length, 0);
});

test("human continuation never adopts changed original window, tab placement, or target identity", async () => {
  for (const change of [f => { f.tab.windowId++; }, f => { f.tab.groupId++; }, f => { f.tab.pinned = true; },
    f => { f.chrome.debugger.getTargets = async () => [{ id: "replacement", tabId: 7, type: "page" }]; }]) {
    const f = await fixture(), handle = await f.begin(); f.changeDocument(); change(f);
    f.backend.onSiteNavigation({ tabId: 7, frameId: 0, url: f.tab.url }, "committed");
    await handle.closed; await handle.close(); assert.equal(handle.info().state, "released");
    assert.equal(f.calls.filter(([method]) => method === "Page.startScreencast").length, 1);
    assert.equal(f.calls.filter(([method, target]) => method === "attach" && target.targetId).length, 1);
  }
});
