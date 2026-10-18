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
function event() {
  const listeners = new Set();
  return { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn),
    emit(...args) { for (const listener of [...listeners]) listener(...args); } };
}
async function until(predicate, message) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await tick(); }
  assert.fail(message);
}

// Only Chrome's platform surface is simulated. The backend, site document
// ledger, native human owner, graph, dialog and cleanup code are production.
async function fixture(t, { restricted = false } = {}) {
  const calls = [], storage = {}, states = [], readGate = defer(), allFramesGate = defer(), answerAck = defer();
  let documentId = "document-A", loaderId = "loader-A", contextId = 1, holdReads = false, heldReads = 0,
    readCount = 0, readFailure = false, holdAnswerAck = false, tabReadFailure = false, holdAllFrames = false, heldAllFrames = 0;
  if (restricted) storage.OPEN_BROWSER_USE_SITE_ACCESS_POLICY = { version: 1, revision: 1, mode: "allow", origins: ["https://fixture.test"] };
  const tab = { id: 7, groupId: 10, windowId: 1, pinned: false, url: "https://fixture.test/A", title: "Original" };
  const native = event(), detached = event(), updated = event(), before = event(), committed = event();
  const nativeEvent = (method, params = {}) => native.emit({ targetId: "original-target" }, method, params);
  const context = () => nativeEvent("Runtime.executionContextCreated", { context: { id: contextId,
    uniqueId: `default-${documentId}`, origin: "https://fixture.test", auxData: { frameId: "root", isDefault: true } } });
  const chrome = {
    webNavigation: {
      onBeforeNavigate: before, onCommitted: committed,
      async getFrame() {
        readCount++;
        const frame = { frameId: 0, parentFrameId: -1, url: tab.url, documentId, documentLifecycle: "active", errorOccurred: false };
        if (holdReads) { heldReads++; await readGate.promise; }
        if (readFailure) throw new Error("Original browser identity read failed");
        return frame;
      },
      async getAllFrames() {
        const frames = [{ frameId: 0, parentFrameId: -1, url: tab.url, documentId, documentLifecycle: "active", errorOccurred: false }];
        if (holdAllFrames) { heldAllFrames++; await allFramesGate.promise; }
        return frames;
      }
    },
    storage: { local: {
      async get(key) { return Object.hasOwn(storage, key) ? { [key]: clone(storage[key]) } : {}; },
      async set(value) { Object.assign(storage, clone(value)); }
    } },
    debugger: {
      onEvent: native, onDetach: detached,
      async getTargets() { return [{ id: "original-target", tabId: 7, type: "page", url: tab.url }]; },
      async attach(target) { calls.push(["attach", clone(target)]); },
      async detach(target) { calls.push(["detach", clone(target)]); },
      async sendCommand(target, method, params) {
        calls.push([method, clone(target), params === undefined ? undefined : clone(params)]);
        if (method === "Runtime.enable") context();
        if (method === "Page.startScreencast") queueMicrotask(() => native.emit(target, "Page.screencastFrame", {
          sessionId: 42, data: "cGl4ZWxz", metadata: { deviceWidth: 800, deviceHeight: 600, pageScaleFactor: 1, offsetTop: 0, monotonicTimestamp: 101 }
        }));
        if (method === "Page.handleJavaScriptDialog") {
          nativeEvent("Page.javascriptDialogClosed", { frameId: "root", result: params.accept, userInput: params.promptText ?? "" });
          if (params.accept && holdAnswerAck) await answerAck.promise;
        }
        if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "root", loaderId, url: tab.url } } };
        if (method === "Performance.getMetrics") return { metrics: [{ name: "Timestamp", value: 100 }] };
        if (method === "Page.getLayoutMetrics") return { cssVisualViewport: { clientWidth: 800, clientHeight: 600, scale: 1, zoom: 1, offsetX: 0, offsetY: 0 } };
        return {};
      }
    },
    tabs: {
      onUpdated: updated, async get() { if (tabReadFailure) throw new Error("Original tabs.get failed"); return { ...tab }; }, async query() { return [{ ...tab }]; },
      async sendMessage(_tabId, message) { return { ok: true, receiverToken: message.receiverToken ?? "receiver" }; },
      async update() { throw new Error("Must not activate the original tab"); }
    },
    windows: { async update() { throw new Error("Must not focus the original window"); } },
    tabGroups: { async get() { return {}; }, async query() { return []; } }
  };
  const Backend = vm.runInNewContext(`${code}\nBrowserBackend;`, { chrome, Date, URL, setTimeout, clearTimeout,
    managedConfig: { version: 1, nativeHostName: "com.openbrowseruse.managed.n0123456789abcdef0123456789abcdef" } });
  const backend = new Backend(); await backend.controlReady;
  backend.commitManagedUserOpen(await backend.prepareManagedUserOpen({ workerBootId: "fixture-worker" }));
  const session = await backend.store.getSession("task"); session.chromeGroupId = 10; session.tabOrigins = { 7: "agent" }; await backend.store.save();
  const first = await backend.getControlState({ session_id: "task" });
  await backend.attach({ session_id: "task", turn_id: first.nextTurnId, control_epoch: first.controlEpoch, tabId: 7 });
  const admitted = backend.beginManagedHuman(7, () => {}, () => {}, state => states.push(state));
  const record = backend.managedHuman.current, handle = await admitted; await record.start;
  t.after(async () => { holdReads = false; readGate.resolve(); holdAllFrames = false; allFramesGate.resolve(); answerAck.resolve(); await handle.close(); backend.managedHuman.assertReleased(); });
  return { backend, calls, states, storage, handle, record,
    decisions: () => calls.filter(([method]) => method === "Page.handleJavaScriptDialog").map(row => row[2]),
    opening() { nativeEvent("Page.javascriptDialogOpening", { frameId: "root", url: tab.url, type: "prompt", message: "Original prompt", defaultPrompt: "original" }); },
    update() { updated.emit(7, { url: tab.url }, { ...tab }); },
    holdReads() { holdReads = true; }, releaseReads() { holdReads = false; readGate.resolve(); },
    heldReads: () => heldReads, readCount: () => readCount, failReads() { readFailure = true; },
    failTabReads() { tabReadFailure = true; }, holdAllFrames() { holdAllFrames = true; }, heldAllFrames: () => heldAllFrames,
    releaseAllFrames() { holdAllFrames = false; allFramesGate.resolve(); },
    holdAnswerAck() { holdAnswerAck = true; }, releaseAnswerAck() { answerAck.resolve(); },
    replaceBrowserDocument() { documentId = "unannounced-document"; },
    navigate() {
      nativeEvent("Page.frameStartedNavigating", { frameId: "root", loaderId: "loader-B" });
      before.emit({ tabId: 7, frameId: 0, url: "https://fixture.test/B" });
      nativeEvent("Runtime.executionContextsCleared");
      documentId = "document-B"; loaderId = "loader-B"; tab.url = "https://fixture.test/B"; contextId++;
      nativeEvent("Page.frameNavigated", { frame: { id: "root", loaderId, url: tab.url } });
      committed.emit({ tabId: 7, frameId: 0, documentId, url: tab.url });
      context();
    }
  };
}
const decision = original => ({ leaseId: original.leaseId, generation: original.generation,
  dialogId: original.dialogId, accept: true, promptText: "one original answer" });
async function answerOnce(f, original) {
  const receipt = await f.handle.respondDialog(decision(original));
  assert.deepEqual(clone(receipt), { leaseId: original.leaseId, generation: original.generation, dialogId: original.dialogId, acknowledged: true });
  assert.deepEqual(f.decisions(), [{ accept: true, promptText: "one original answer" }]);
}

test("actual backend retains an active original prompt after an identical browser URL hint", async t => {
  const f = await fixture(t); f.opening();
  const original = f.handle.pendingDialog(), version = f.backend.siteNavigationVersions.get(7) ?? 0;
  assert.ok(original); f.update(); await tick(); await tick();
  assert.deepEqual(clone(f.handle.pendingDialog()), clone(original), "A URL hint did not replace the original document or prompt");
  assert.equal(f.backend.siteNavigationVersions.get(7) ?? 0, version);
  assert.equal(Boolean(f.record.revoked), false);
  assert.deepEqual(f.decisions(), []);
  await answerOnce(f, original);
});

test("actual backend retains original async destination proof across a same-document URL hint", async t => {
  const f = await fixture(t); f.holdReads(); f.navigate(); f.opening();
  const originalEpoch = f.record.epoch, openingRecord = f.record.dialogs.current;
  assert.ok(openingRecord?.capture, "Original Opening must have a live async document proof");
  assert.equal(f.handle.pendingDialog(), null);
  await until(() => f.heldReads() > 0, "Original browser document read did not enter");
  const version = f.backend.siteNavigationVersions.get(7) ?? 0;
  f.update(); await tick(); f.releaseReads();
  await until(() => f.handle.pendingDialog() || f.record.revoked || originalEpoch.retired, "Original pending proof did not settle");
  assert.equal(Boolean(originalEpoch.retired), false, "Same-document hint must not retire the original destination proof");
  const pending = f.handle.pendingDialog(); assert.ok(pending);
  assert.equal(f.record.dialogs.current, openingRecord);
  assert.equal(f.backend.siteNavigationVersions.get(7) ?? 0, version);
  assert.deepEqual(f.decisions(), []);
  await answerOnce(f, pending);
});

test("actual backend never accepts the old prompt after same-URL browser document replacement", async t => {
  const f = await fixture(t); f.opening();
  const original = f.handle.pendingDialog(); assert.ok(original);
  f.replaceBrowserDocument(); f.update();
  // A URL-only hint can retain the displayed original prompt while marking
  // its authority dirty. The original answer must validate the actual browser
  // document before any native decision; the URL string cannot prove identity.
  await assert.rejects(f.handle.respondDialog({ leaseId: original.leaseId, generation: original.generation,
    dialogId: original.dialogId, accept: true, promptText: "must not submit" }), /STALE|UNAVAILABLE|WITHDRAWN|REVOKED/);
  assert.equal(f.decisions().some(params => params.accept), false);
  await f.handle.close();
  assert.deepEqual(f.decisions(), [{ accept: false }]);
  assert.equal(f.storage.OPEN_BROWSER_USE_INPUT_RISKS.risks.length, 0);
});

test("End cancels a claimed unsent answer before its original browser read settles, but joins that read", async t => {
  const f = await fixture(t); f.opening();
  const original = f.handle.pendingDialog(); assert.ok(original);
  f.holdReads(); f.update();
  const reply = f.handle.respondDialog(decision(original)); reply.catch(() => {});
  await until(() => f.heldReads() > 0, "Original answer verification did not enter its browser read");
  let closed = false;
  const closing = f.handle.close().then(() => { closed = true; }); closing.catch(() => {});
  await until(() => f.decisions().length > 0, "End must cancel the original modal without waiting for the browser read");
  assert.deepEqual(f.decisions(), [{ accept: false }]);
  assert.equal(closed, false, "Close must join the still unresolved original browser read");
  assert.equal(f.calls.some(([method, target]) => method === "detach" && target.targetId === "original-target"), false);
  f.releaseReads();
  await assert.rejects(reply); await closing;
  assert.equal(closed, true);
  assert.deepEqual(f.decisions(), [{ accept: false }]);
  assert.equal(f.storage.OPEN_BROWSER_USE_INPUT_RISKS.risks.length, 0);
});

test("a hint after actual answer dispatch cannot replace the original native ACK receipt", async t => {
  const f = await fixture(t); f.opening();
  const original = f.handle.pendingDialog(); assert.ok(original);
  f.holdAnswerAck();
  const reply = f.handle.respondDialog(decision(original)); reply.catch(() => {});
  await until(() => f.decisions().length === 1, "Original answer was not actually dispatched");
  const readsAtDispatch = f.readCount();
  f.replaceBrowserDocument(); f.update(); await tick();
  f.releaseAnswerAck();
  const receipt = await reply;
  assert.deepEqual(clone(receipt), { leaseId: original.leaseId, generation: original.generation, dialogId: original.dialogId, acknowledged: true });
  assert.deepEqual(f.decisions(), [{ accept: true, promptText: "one original answer" }]);
  assert.equal(f.readCount(), readsAtDispatch, "An already dispatched answer must not acquire a new post-ACK document proof");
});

test("a second hint cannot clear the answer gate with a browser read of the old same-URL document", async t => {
  const f = await fixture(t); f.opening();
  const original = f.handle.pendingDialog(); assert.ok(original);
  f.holdReads(); f.update();
  const reply = f.handle.respondDialog(decision(original)); reply.catch(() => {});
  await until(() => f.heldReads() > 0, "Original answer verification did not enter its browser read");
  // getFrame has already captured document A. The second hint is the only new
  // browser observation; no native navigation event rescues a stale first read.
  f.replaceBrowserDocument(); f.update();
  assert.deepEqual(f.decisions(), []);
  f.releaseReads(); await assert.rejects(reply);
  assert.equal(f.decisions().some(params => params.accept), false);
  await f.handle.close();
  assert.deepEqual(f.decisions(), [{ accept: false }]);
});

test("a failed browser-only URL-hint verification cannot submit an original human answer", async t => {
  const f = await fixture(t); f.opening();
  const original = f.handle.pendingDialog(); assert.ok(original);
  f.failReads(); f.update();
  await assert.rejects(f.handle.respondDialog(decision(original)));
  assert.equal(f.decisions().some(params => params.accept), false);
  await f.handle.close();
  assert.deepEqual(f.decisions(), [{ accept: false }]);
});

test("parallel tabs.get failure cannot release the unresolved original getFrame read", async t => {
  const f = await fixture(t); f.opening();
  const original = f.handle.pendingDialog(); assert.ok(original);
  f.holdReads(); f.failTabReads(); f.update();
  const reply = f.handle.respondDialog(decision(original)); reply.catch(() => {});
  await until(() => f.heldReads() === 1, "Parallel original getFrame did not enter");
  await assert.rejects(reply);
  let closed = false;
  const closing = f.handle.close().then(() => { closed = true; }); closing.catch(() => {});
  for (let i = 0; i < 5; i++) await tick();
  assert.deepEqual(f.decisions(), [{ accept: false }]);
  assert.equal(closed, false, "The rejected Promise.all must not discard its still pending original getFrame");
  assert.equal(f.calls.some(([method, target]) => method === "detach" && target.targetId === "original-target"), false);
  assert.equal(f.storage.OPEN_BROWSER_USE_INPUT_RISKS.risks.length, 1);
  f.releaseReads(); await closing;
  assert.equal(f.storage.OPEN_BROWSER_USE_INPUT_RISKS.risks.length, 0);
  assert.deepEqual(f.decisions(), [{ accept: false }]);
});

test("restricted permission timeout cannot release the unresolved original getAllFrames read", { timeout: 5000 }, async t => {
  const f = await fixture(t, { restricted: true }); f.opening();
  assert.equal(f.backend.siteAccess.restricted, true);
  const original = f.handle.pendingDialog(); assert.ok(original);
  f.holdAllFrames(); f.update();
  const reply = f.handle.respondDialog(decision(original)); reply.catch(() => {});
  await until(() => f.heldAllFrames() === 1, "Original restricted frame inspection did not enter");
  // Wait for the production permission inspector's own one-second deadline.
  // The simulated Chrome API remains unresolved and receives no fake timeout.
  await assert.rejects(reply);
  let closed = false;
  const closing = f.handle.close().then(() => { closed = true; }); closing.catch(() => {});
  for (let i = 0; i < 5; i++) await tick();
  assert.deepEqual(f.decisions(), [{ accept: false }]);
  assert.equal(closed, false, "Permission observer timeout must not discard the actual original getAllFrames");
  assert.equal(f.calls.some(([method, target]) => method === "detach" && target.targetId === "original-target"), false);
  assert.equal(f.storage.OPEN_BROWSER_USE_INPUT_RISKS.risks.length, 1);
  f.releaseAllFrames(); await closing;
  assert.equal(f.storage.OPEN_BROWSER_USE_INPUT_RISKS.risks.length, 0);
  assert.deepEqual(f.decisions(), [{ accept: false }]);
});
