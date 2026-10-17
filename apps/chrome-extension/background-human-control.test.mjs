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

async function fixture({ managed = true, command, write, detach, authority = () => {} } = {}) {
  const calls = [], storage = {}, listeners = new Set(), detachListeners = new Set();
  let documentId = "original-document";
  const tab = { id: 7, groupId: 10, windowId: 1, pinned: false, url: "https://fixture.test", title: "Original" };
  const chrome = {
    webNavigation: { async getFrame() { return { documentId }; } },
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
          for (const listener of [...listeners]) listener(target, "Page.screencastFrame", { sessionId: 42, data: "cGl4ZWxz", metadata: { deviceWidth: 800, deviceHeight: 600, pageScaleFactor: 1, offsetTop: 0 } });
        });
        return response ?? (method === "Page.getLayoutMetrics" ? { cssVisualViewport: { clientWidth: 800, clientHeight: 600, scale: 1, zoom: 1, offsetX: 0, offsetY: 0 } } : {});
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
  const session = await backend.store.getSession("task"); session.chromeGroupId = 10; session.tabOrigins = { 7: "agent" }; await backend.store.save();
  const first = await backend.getControlState({ session_id: "task" });
  const params = { session_id: "task", turn_id: first.nextTurnId, control_epoch: first.controlEpoch, tabId: 7 };
  await backend.attach(params);
  const frames = [];
  const begin = () => backend.beginManagedHuman(7, authority, frame => frames.push(frame));
  return { backend, Backend, chrome, calls, storage, first, params, begin, frames,
    changeDocument: () => { documentId = "replacement-document"; },
    emitDetach: (source, reason) => { for (const fn of detachListeners) fn(source, reason); } };
}
function input(handle, value) { const info = handle.info(); return handle.input({ leaseId: info.leaseId, generation: info.generation, sequence: info.lastInputSequence + 1, input: value }); }

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
  gate.resolve(); await assert.rejects(sending, /revoked|Pause/); await pausing;
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
  const restarted = new f.Backend(); await restarted.controlReady;
  assert.equal((await restarted.getAutomationControlStatus()).state, "error");
  await assert.rejects(restarted.resumeAutomation(restarted.automationControl.revision), /PAUSE_INCOMPLETE/);
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
