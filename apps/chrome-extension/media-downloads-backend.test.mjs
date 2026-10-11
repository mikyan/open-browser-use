import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import test from "node:test";
import vm from "./test-support/backend-vm.mjs";
import { BrowserActionEngine } from "./browser-action-engine.js";
import { SITE_ACCESS_POLICY_KEY } from "./site-access-policy.js";
import { MEDIA_CANCEL_FUNCTION } from "./browser-media-source.js";

const source = (await readFile(new URL("./background.js", import.meta.url), "utf8"))
  .replace('import { createBrowserActionEngine } from "./browser-runtime.js";', "")
  .replace('import { NativeInputTracker } from "./browser-input-adapter.js";',
    (await readFile(new URL("./browser-input-adapter.js", import.meta.url), "utf8")).replace(/^export /gm, ""));
const code = source.slice(0, source.indexOf("chrome.runtime.onInstalled.addListener"));
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const event = () => { const listeners = new Set(); return { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn), emit: (...args) => [...listeners].forEach(fn => fn(...args)), size: () => listeners.size }; };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function fixture(t, restricted = false, { actualMedia = false } = {}) {
  const state = restricted ? { [SITE_ACCESS_POLICY_KEY]: { version: 1, revision: 1, mode: "allow", origins: ["https://allowed.test"] } } : {};
  const calls = [], hooks = {}, gates = [], tabs = new Map([[7, { id: 7, groupId: 10, windowId: 1, url: "https://allowed.test/page" }], [8, { id: 8, groupId: 20, windowId: 1, url: "https://allowed.test/other" }]]);
  const frames = [{ frameId: 0, parentFrameId: -1, url: tabs.get(7).url, documentLifecycle: "active", errorOccurred: false }];
  const chrome = {
    storage: { local: { async get(key) { return { [key]: structuredClone(state[key]) }; }, async set(value) { Object.assign(state, structuredClone(value)); } } },
    runtime: { id: "fixture", getManifest: () => ({ version: "test" }), getURL: path => `chrome-extension://fixture/${path}` },
    debugger: { onDetach: event(), onEvent: event(), async attach() { await hooks.attach?.(); }, async detach({ tabId }) { calls.push(["detach", tabId]); },
      async sendCommand(target, method, args) {
        calls.push([method, target.tabId, args]);
        if (hooks.command) { const result = await hooks.command(method, args, target); if (result !== undefined) return result; }
        if (method === "Page.printToPDF") return { stream: `stream-${target.tabId}` };
        if (method === "IO.read") return { data: btoa("%PDF-fixture"), base64Encoded: true, eof: true };
        if (method === "Page.captureSnapshot") return { data: "MIME-Version: 1.0\r\nContent-Type: multipart/related\r\n\r\n中文" };
        return {};
      } },
    downloads: {
      async download(options) { calls.push(["download", options]); await hooks.download?.(); return 42; },
      async cancel(id) { calls.push(["cancel", id]); },
      async search({ id }) { return [{ id, byExtensionId:"fixture", state:"complete", danger:"safe", filename:"C:\\Downloads\\image.png", exists:true }]; }
    },
    tabs: { onUpdated: event(), onDetached: event(), onReplaced: event(), onRemoved: event(),
      async get(id) { return structuredClone(tabs.get(id)); },
      async query(filter = {}) { await hooks.query?.(); return [...tabs.values()].filter(tab => filter.groupId === undefined || filter.groupId === tab.groupId).map(tab => structuredClone(tab)); },
      async sendMessage() { return {}; }, async update() { throw new Error("must not activate a tab"); } },
    windows: { async get(id) { return { id, type: id === 2 ? "popup" : "normal" }; }, async update() { throw new Error("must not focus a window"); } },
    webNavigation: { onBeforeNavigate: event(), onCommitted: event(), onErrorOccurred: event(), onHistoryStateUpdated: event(), onReferenceFragmentUpdated: event(), async getAllFrames() { return structuredClone(frames); } },
    tabGroups: { async update() {} }
  };
  const createBrowserActionEngine = engineHooks => {
    const pages = new Map(), generations = new Map(), queues = new Map();
    const readSource = async (params, options) => {
        calls.push(["source", structuredClone(params)]);
        assert.ok(options.deadlineAt < performance.now()+120001 && options.deadlineAt > performance.now());
        await options.check(); const resolved = await hooks.source?.(options); await options.check();
        return resolved ?? {url:"https://allowed.test/image.png"};
    };
    const engine = { pages, generations, queues,
      authorize: engineHooks.authorize,
      async runtime() { return { assertOpenBrowserUseSelector() {}, readMediaSource: (locator, options) => readSource({ locator }, options) }; },
      resolveMediaSource: actualMedia ? BrowserActionEngine.prototype.resolveMediaSource : readSource,
      async attach(id) {
        if (pages.has(id)) return;
        await engineHooks.onBeforeAttach(id); await chrome.debugger.attach({ tabId: id }); await engineHooks.onAttached(id);
        const page = new EventEmitter(); page.locator = selector => ({ selector });
        pages.set(id, Promise.resolve({ page }));
      },
      async detach(id) { pages.delete(id); await chrome.debugger.detach({ tabId: id }); await engineHooks.onDetached(id); }, forget(id) { pages.delete(id); } };
    return engine;
  };
  const Backend = vm.runInNewContext(`${code}\nBrowserBackend`, { chrome, crypto, Date, URL, setTimeout, clearTimeout, createBrowserActionEngine });
  const backend = new Backend(); await backend.controlReady;
  for (const [name, groupId, tabId] of [["task", 10, 7], ["other", 20, 8]]) {
    const session = await backend.store.getSession(name); session.chromeGroupId = groupId; session.tabOrigins = { [tabId]: "agent" };
  }
  await backend.store.save();
  const current = await backend.getControlState({ session_id: "task" });
  const params = { session_id: "task", turn_id: "turn", control_epoch: current.controlEpoch, tabId: 7, locator:[{kind:"css",selector:"img"}] };
  t.after(async () => { for (const gate of gates) gate.resolve(); for (const key of Object.keys(hooks)) delete hooks[key]; await backend.directDownloads.invalidateAll(); await backend.pageExports.invalidateAll(); await Promise.all([...backend.attachedTabs].map(id => backend.detachTab(id))); });
  return { backend, chrome, calls, hooks, tabs, frames, params, gate() { const gate = deferred(); gates.push(gate); return gate; } };
}


test("media download uses a single source snapshot and scoped native download without input", async t => {
  const f = await fixture(t);
  const ack = await f.backend.downloadMedia({...f.params, filename:"image.png"});
  assert.equal((await f.backend.getInfo()).metadata.mediaDownloadsVersion,1);
  assert.equal(f.calls.filter(([name])=>name==="source").length,1);
  assert.deepEqual(f.calls.find(([name])=>name==="download")[1],{url:"https://allowed.test/image.png",filename:"image.png",saveAs:false,conflictAction:"uniquify"});
  assert.equal((await f.backend.downloadPath({...f.params,downloadId:ack.downloadId})).path,"C:\\Downloads\\image.png");
  await f.backend.cancelDownload({...f.params,downloadId:ack.downloadId});
  assert.equal(f.calls.find(([name])=>name==="cancel")[1],42);
});

test("media rejects unowned tabs and restricted policy before source resolution", async t => {
  const f = await fixture(t);
  await assert.rejects(f.backend.downloadMedia({...f.params,tabId:8}),/part|owned|claim/);
  assert.ok(!f.calls.some(([name])=>name==="source" || name==="download"));
  const restricted = await fixture(t,true);
  await assert.rejects(restricted.backend.downloadMedia(restricted.params),/OBU_SITE_ACCESS/);
  assert.ok(!restricted.calls.some(([name])=>name==="source" || name==="download"));
});

test("media timeout retains actual source work and native detach waits for it", async t => {
  const f = await fixture(t), gate=f.gate();f.hooks.source=()=>gate.promise;
  const pending=f.backend.downloadMedia({...f.params,timeoutMs:60});
  await assert.rejects(pending,/TIMEOUT/);
  assert.equal(f.backend.directDownloads.records.size,1);
  let released=false; const detach=f.backend.detachTab(7).then(()=>released=true);
  await tick();assert.equal(released,false);
  assert.ok(!f.calls.some(([name])=>name==="detach"));
  gate.resolve();await detach;
  assert.equal(f.backend.directDownloads.records.size,0);
  assert.ok(!f.calls.some(([name])=>name==="download"));
});

test("navigation while reading media revokes the old source and never replays GET", async t => {
  const f=await fixture(t), gate=f.gate();f.hooks.source=()=>gate.promise;
  const pending=f.backend.downloadMedia(f.params);
  while(!f.calls.some(([name])=>name==="source"))await tick();
  f.backend.invalidatePageExportDocument(7);
  await assert.rejects(pending,/EXPIRED|DOCUMENT_CHANGED/);
  assert.equal(f.backend.directDownloads.records.size,1);
  gate.resolve(); await f.backend.directDownloads.invalidateAll();
  assert.ok(!f.calls.some(([name])=>name==="download"));
});

test("late media native ID is canceled before native attachment release", async t => {
  const f=await fixture(t), gate=f.gate();f.hooks.download=()=>gate.promise;
  const pending=f.backend.downloadMedia(f.params);
  const rejected=assert.rejects(pending,/EXPIRED/);
  while(!f.calls.some(([name])=>name==="download"))await tick();
  let released=false;const detach=f.backend.detachTab(7).then(()=>released=true);
  await tick();assert.equal(released,false);await rejected;
  gate.resolve();await detach;
  const cancel=f.calls.findIndex(([name])=>name==="cancel"), nativeDetach=f.calls.findIndex(([name])=>name==="detach");
  assert.ok(cancel>=0 && nativeDetach>cancel);
  assert.equal(f.calls[cancel][1],42);
});

test("failed source handle disposal keeps the original attachment until explicit detach cleanup really succeeds", async t => {
  const f = await fixture(t), cleanup = f.gate();
  const error = Object.assign(new Error("OBU_MEDIA_CLEANUP_FAILED: fixture handle is still live"), {
    mediaCleanupFailed: true,
    retryMediaCleanup() { f.calls.push(["source-dispose-retry"]); return f.hooks.sourceCleanup?.(); }
  });
  f.hooks.source = async () => { throw error; };
  f.hooks.sourceCleanup = async () => { throw new Error("fixture exact handle release failed"); };
  await assert.rejects(f.backend.downloadMedia(f.params), /OBU_MEDIA_CLEANUP_FAILED/);
  await tick();
  const attachment = f.backend.attachmentEpochs.get(7);
  assert.ok(attachment);
  assert.equal(f.backend.directDownloads.records.size, 1);
  assert.equal(f.calls.filter(([name]) => name === "source-dispose-retry").length, 0);
  await assert.rejects(f.backend.detachTab(7), /OBU_DOWNLOAD_CLEANUP_FAILED/);
  assert.equal(f.backend.attachmentEpochs.get(7), attachment);
  assert.equal(f.backend.attachedTabs.has(7), true);
  assert.equal(f.backend.browserEngine.pages.has(7), true);
  assert.ok(!f.calls.some(([name]) => name === "detach" || name === "download"));
  f.hooks.sourceCleanup = () => cleanup.promise;
  let settled = false;
  const retry = f.backend.detachTab(7).then(() => { settled = true; });
  await tick();
  assert.equal(settled, false);
  assert.equal(f.backend.attachmentEpochs.get(7), attachment);
  assert.ok(f.backend.directDownloads.controlSnapshot().pending.length > 0);
  assert.ok(!f.calls.some(([name]) => name === "detach"));
  cleanup.resolve(); await retry;
  assert.equal(f.backend.directDownloads.records.size, 0);
  assert.equal(f.backend.attachmentEpochs.has(7), false);
  assert.equal(f.calls.filter(([name]) => name === "source").length, 1);
  assert.equal(f.calls.filter(([name]) => name === "source-dispose-retry").length, 2);
  assert.ok(!f.calls.some(([name]) => name === "download"));
});

test("actual engine media scope check revokes moved auxiliary ownership without waiting on its own source cleanup", { timeout: 2000 }, async t => {
  const f = await fixture(t, false, { actualMedia: true }), gate = f.gate(), entered = f.gate();
  f.tabs.set(9, { id: 9, groupId: -1, windowId: 2, url: "https://allowed.test/popup" });
  const params = { ...f.params, tabId: 9 };
  await f.backend.claimUserTab(params);
  const claim = f.backend.auxiliaryTabs.owner(9);
  assert.ok(claim);
  f.hooks.source = async () => { entered.resolve(); await gate.promise; };
  const outcome = assert.rejects(f.backend.downloadMedia(params), /OBU_MEDIA_CANCELLED|OBU_DOWNLOAD_EXPIRED|OBU_AUXILIARY/);
  await entered.promise;
  assert.equal(f.backend.directDownloads.records.size, 1);
  // No onUpdated notification: exercise live ownership inspection itself. The
  // old general engine authorize path awaited releaseAuxiliaryClaim here,
  // which in turn awaited this same actual source promise through detachTab.
  f.tabs.get(9).groupId = 20;
  gate.resolve(); await outcome;
  await f.backend.auxiliaryReleases.get(claim);
  await f.backend.directDownloads.invalidateAll();
  assert.equal(f.backend.auxiliaryTabs.entry(9), undefined);
  assert.equal(f.backend.directDownloads.records.size, 0);
  assert.equal(f.backend.browserEngine.queues.size, 0);
  assert.equal(f.backend.attachmentEpochs.has(9), false);
  assert.ok(!f.calls.some(([name]) => name === "download"));
  assert.equal(f.calls.filter(([name]) => name === "source").length, 1);
});

test("private media cleanup captures its target and remains narrowly available while normal commands are paused", async t => {
  const f = await fixture(t);
  await f.backend.attach(f.params);
  f.backend.childSessionsByTabId.set(7, new Set(["child-owned"]));
  const original = { tabId: 7, sessionId: "child-owned" };
  const cleanup = f.backend.prepareMediaCleanup(original, 17);
  original.tabId = 8; original.sessionId = "child-foreign";
  const sent = [];
  f.hooks.command = async (method, args, target) => { if (method === "Runtime.releaseObject") sent.push({ target: structuredClone(target), method, args: structuredClone(args) }); };
  f.backend.automationControl.block();
  await assert.rejects(f.backend.executeCdp({ ...f.params, target: { tabId: 7 }, method: "Runtime.releaseObject", commandParams: { objectId: "public-raw" } }), /OBU_AUTOMATION_PAUSED/);
  await cleanup.release("captured-object");
  assert.deepEqual(sent, [{ target: { tabId: 7, sessionId: "child-owned" }, method: "Runtime.releaseObject", args: { objectId: "captured-object" } }]);
  assert.equal(Object.isFrozen(cleanup), true);
  for (const objectId of [undefined, null, "", 1, "x".repeat(4097)]) assert.throws(() => cleanup.release(objectId), /OBU_MEDIA_CLEANUP_FAILED/);
  assert.equal(sent.length, 1);
});

test("private media cleanup rejects foreign child sessions and retired attachment identities before sending", async t => {
  const f = await fixture(t);
  await f.backend.attach(f.params);
  f.backend.childSessionsByTabId.set(7, new Set(["child-owned"]));
  f.backend.childSessionsByTabId.set(8, new Set(["child-foreign"]));
  for (const target of [{ tabId: 7, sessionId: "child-foreign" }, { tabId: 7, targetId: "foreign-target" }, { tabId: 7, extensionId: "fixture" }])
    assert.throws(() => f.backend.prepareMediaCleanup(target, 17), /OBU_MEDIA_CLEANUP_FAILED/);
  const cleanup = f.backend.prepareMediaCleanup({ tabId: 7, sessionId: "child-owned" }, 17);
  const token = f.backend.attachmentEpochs.get(7), before = f.calls.length;
  f.backend.childSessionsByTabId.get(7).delete("child-owned");
  assert.throws(() => cleanup.release("original-object"), /OBU_MEDIA_CLEANUP_FAILED/);
  f.backend.childSessionsByTabId.get(7).add("child-owned");
  f.backend.attachmentEpochs.set(7, {});
  try { assert.throws(() => cleanup.release("original-object"), /OBU_MEDIA_CLEANUP_FAILED/); }
  finally { f.backend.attachmentEpochs.set(7, token); }
  assert.equal(f.calls.length, before);
});

test("private media cleanup returns the actual native release promise, including failure", async t => {
  const f = await fixture(t), gate = f.gate();
  await f.backend.attach(f.params);
  const cleanup = f.backend.prepareMediaCleanup({ tabId: 7 }, 17);
  f.hooks.command = async method => { if (method === "Runtime.releaseObject") await gate.promise; };
  let settled = false;
  const releasing = cleanup.release("actual-object").then(() => { settled = true; });
  await tick(); assert.equal(settled, false);
  gate.resolve(); await releasing;
  f.hooks.command = async method => { if (method === "Runtime.releaseObject") throw new Error("native release failed"); };
  await assert.rejects(cleanup.release("actual-object"), /native release failed/);
});

test("native context destruction retires a late object without sending to a reused context or attachment", async t => {
  const f = await fixture(t);
  await f.backend.attach(f.params);
  const beforeListeners = f.chrome.debugger.onEvent.size();
  const originalAttachment = f.backend.attachmentEpochs.get(7);
  const cleanup = f.backend.prepareMediaCleanup({ tabId: 7 }, 17);
  assert.equal(f.chrome.debugger.onEvent.size(), beforeListeners + 1);
  f.chrome.debugger.onEvent.emit({ tabId: 7 }, "Runtime.executionContextDestroyed", { executionContextId: 17 });
  f.backend.attachmentEpochs.set(7, {});
  const next = f.backend.prepareMediaCleanup({ tabId: 7 }, 17);
  const sent = f.calls.length;
  await cleanup.release("late-original-object");
  assert.equal(f.calls.length, sent);
  await next.release("next-object");
  assert.equal(f.calls.length, sent + 1);
  cleanup.close(); cleanup.close();
  assert.equal(f.chrome.debugger.onEvent.size(), beforeListeners + 1);
  next.close();
  assert.equal(f.chrome.debugger.onEvent.size(), beforeListeners);
  assert.throws(() => cleanup.release("closed-object"), /OBU_MEDIA_CLEANUP_FAILED/);
  f.backend.attachmentEpochs.set(7, originalAttachment);
});

test("a foreign context event cannot clear media cleanup failure; matching destruction during release can", async t => {
  const f = await fixture(t);
  await f.backend.attach(f.params);
  f.backend.childSessionsByTabId.set(7, new Set(["child-owned"]));
  const target = { tabId: 7, sessionId: "child-owned" };
  const cleanup = f.backend.prepareMediaCleanup(target, 17);
  f.hooks.command = async method => { if (method === "Runtime.releaseObject") throw new Error("native release failed"); };
  f.chrome.debugger.onEvent.emit({ tabId: 7 }, "Runtime.executionContextsCleared", {});
  f.chrome.debugger.onEvent.emit(target, "Runtime.executionContextDestroyed", { executionContextId: 18 });
  await assert.rejects(cleanup.release("actual-object"), /native release failed/);
  const gate = f.gate();
  f.hooks.command = async method => { if (method === "Runtime.releaseObject") { await gate.promise; throw new Error("context no longer exists"); } };
  let settled = false;
  const releasing = cleanup.release("actual-object").then(() => { settled = true; });
  f.chrome.debugger.onEvent.emit(target, "Runtime.executionContextsCleared", {});
  await tick(); assert.equal(settled, false, "native send settlement must still be joined");
  gate.resolve(); await releasing;
  cleanup.close();
});

test("embedded source uses the original download handle and detach aborts actual source work before native teardown", async t => {
  const f = await fixture(t);
  f.hooks.source = async () => ({ bytesBase64: "AAEC/w==", mimeType: "audio/wav", byteLength: 4 });
  const ack = await f.backend.downloadMedia({ ...f.params, filename: "audio.wav" });
  assert.deepEqual(f.calls.find(([name]) => name === "download")[1], {
    url: "data:audio/wav;base64,AAEC/w==", filename: "audio.wav", saveAs: false, conflictAction: "uniquify"
  });
  await f.backend.cancelDownload({ ...f.params, ...ack });
  const source = f.gate(), abort = f.gate(); let aborts = 0;
  f.hooks.source = async ({ onCancel }) => {
    const unsubscribe = onCancel(() => { aborts++; source.resolve(); return abort.promise; });
    try { await source.promise; return { bytesBase64: "AA==", mimeType: "image/png", byteLength: 1 }; }
    finally { unsubscribe(); }
  };
  const running = assert.rejects(f.backend.downloadMedia(f.params), /EXPIRED|DOCUMENT_CHANGED/);
  while (f.calls.filter(([name]) => name === "source").length < 2) await tick();
  await tick();
  let detached = false; const cleanup = f.backend.detachTab(7).then(() => { detached = true; });
  await running; await tick();
  assert.equal(aborts, 1); assert.equal(detached, false);
  assert.equal(f.backend.directDownloads.pendingSourceBytes, 8 * 1024 * 1024);
  assert.ok(!f.calls.some(([name]) => name === "detach"));
  abort.resolve(); await cleanup;
  assert.equal(f.calls.filter(([name]) => name === "download").length, 1);
  assert.equal(f.backend.directDownloads.pendingSourceBytes, 0);
});

test("private media abort uses a fixed function and exact child target while paused, without opening public Runtime", async t => {
  const f = await fixture(t);
  await f.backend.attach(f.params);
  f.backend.childSessionsByTabId.set(7, new Set(["child-owned"]));
  const target = { tabId: 7, sessionId: "child-owned" };
  const cleanup = f.backend.prepareMediaCleanup(target, 17);
  target.tabId = 8; target.sessionId = "other";
  const sent = [];
  f.hooks.command = async (method, args, nativeTarget) => {
    if (method !== "Runtime.callFunctionOn") return;
    sent.push({ target: structuredClone(nativeTarget), args: structuredClone(args) });
    return { result: { type: "boolean", value: true } };
  };
  f.backend.automationControl.block();
  await assert.rejects(f.backend.executeCdp({ ...f.params, method: "Runtime.callFunctionOn", commandParams: { objectId: "forged" } }), /OBU_AUTOMATION_PAUSED/);
  await cleanup.cancel("binding-object");
  assert.deepEqual(sent, [{ target: { tabId: 7, sessionId: "child-owned" }, args: {
    objectId: "binding-object", functionDeclaration: MEDIA_CANCEL_FUNCTION, returnByValue: true, awaitPromise: true, userGesture: false
  } }]);
  for (const objectId of [undefined, null, "", 1, "x".repeat(4097)]) assert.throws(() => cleanup.cancel(objectId), /OBU_MEDIA_CLEANUP_FAILED/);
  const original = f.backend.attachmentEpochs.get(7);
  f.backend.attachmentEpochs.set(7, {});
  try { assert.throws(() => cleanup.cancel("binding-object"), /OBU_MEDIA_CLEANUP_FAILED/); }
  finally { f.backend.attachmentEpochs.set(7, original); }
  assert.equal(sent.length, 1); cleanup.close();
});

test("private media abort joins native settlement and accepts only positive exact-context destruction", async t => {
  const f = await fixture(t), gate = f.gate();
  await f.backend.attach(f.params);
  const cleanup = f.backend.prepareMediaCleanup({ tabId: 7 }, 17);
  f.hooks.command = async method => {
    if (method !== "Runtime.callFunctionOn") return;
    await gate.promise; throw new Error("native abort failed");
  };
  let settled = false;
  const abort = cleanup.cancel("binding").then(() => { settled = true; });
  f.chrome.debugger.onEvent.emit({ tabId: 7 }, "Runtime.executionContextDestroyed", { executionContextId: 17 });
  await tick(); assert.equal(settled, false);
  gate.resolve(); await abort;
  const before = f.calls.length;
  await cleanup.cancel("binding"); assert.equal(f.calls.length, before);
  cleanup.close();
});

test("unexpected cancellation remote objects are retained across a failed release and never silently lost", async t => {
  const f = await fixture(t);
  await f.backend.attach(f.params);
  const cleanup = f.backend.prepareMediaCleanup({ tabId: 7 }, 17);
  let releaseAllowed = false, responseCount = 0;
  f.hooks.command = async (method, args) => {
    if (method === "Runtime.callFunctionOn") {
      if (++responseCount > 1) return { result: { type: "boolean", value: true } };
      return { result: { objectId: "exception-owned" }, exceptionDetails: { exception: { objectId: "exception-owned" } } };
    }
    if (method === "Runtime.releaseObject" && args.objectId === "exception-owned" && !releaseAllowed) throw new Error("exception release failed");
  };
  await assert.rejects(cleanup.cancel("binding"), /exception release failed/);
  assert.throws(() => cleanup.close(), /cancellation objects remain/);
  releaseAllowed = true;
  await cleanup.cancel("binding");
  const releases = f.calls.filter(([method, , args]) => method === "Runtime.releaseObject" && args.objectId === "exception-owned");
  assert.equal(releases.length, 2, "one failed release, then one exact retry; duplicate IDs are not released twice");
  assert.equal(responseCount, 2);
  f.hooks.command = async method => method === "Runtime.callFunctionOn" ? { result: { value: false } } : undefined;
  await assert.rejects(cleanup.cancel("binding"), /native media cancellation failed/);
  cleanup.close();
});
