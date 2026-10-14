import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "./test-support/backend-vm.mjs";
import { SITE_ACCESS_POLICY_KEY } from "./site-access-policy.js";

const input = (await readFile(new URL("./browser-input-adapter.js", import.meta.url), "utf8")).replace(/^export /gm, "");
const source = (await readFile(new URL("./background.js", import.meta.url), "utf8"))
  .replace('import { createBrowserActionEngine } from "./browser-runtime.js";', "")
  .replace('import { NativeInputTracker } from "./browser-input-adapter.js";', input);
const code = source.slice(0, source.indexOf("chrome.runtime.onInstalled.addListener"));
const clone = value => structuredClone(value);
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const event = () => ({ addListener() {}, removeListener() {} });
const denied = /OBU_SITE_ACCESS_(?:DENIED|UNVERIFIED)|OBU_DOWNLOAD_WAIT_EXPIRED|OBU_TRANSFER_CANCELLED/;
const frame = (id = "root", url = "https://allowed.test/page", parentId) => ({ id, url, securityOrigin: new URL(url).origin,
  loaderId: `loader-${id}`, ...(parentId ? { parentId } : {}) });

async function fixture(t, { restricted = true, cleanupTimeoutMs = 35, contextOrigin, omitContext = false } = {}) {
  const storage = restricted ? { [SITE_ACCESS_POLICY_KEY]: { version: 1, revision: 3, mode: "allow", origins: ["https://allowed.test", "https://child.test"] } } : {};
  const calls = [], requests = [], hooks = {}, gates = [], contexts = [];
  const context = (sessionId, frameId = "root", origin = contextOrigin ?? "https://allowed.test", extra = {}) => {
    const value = { id: contexts.length + 1, uniqueId: `native-context-${contexts.length + 1}`, origin, name: "", auxData: { isDefault: true, frameId }, ...extra };
    contexts.push(value); backend.handleCdpEvent({ tabId: 7, ...(sessionId ? { sessionId } : {}) }, "Runtime.executionContextCreated", { context: value }); return value;
  };
  const tabs = new Map([[7, { id: 7, groupId: 10, windowId: 1, url: "https://allowed.test/page", active: false }]]);
  const frames = [{ frameId: 0, parentFrameId: -1, url: tabs.get(7).url, documentId: "document-original", documentLifecycle: "active", errorOccurred: false }];
  const trees = new Map([[undefined, { frame: frame() }]]);
  const binding = { available: true, generation: "native-original" };
  const client = { status: () => ({ ...binding }), async request(operation, claim, options) {
    requests.push({ operation, claim: clone(claim), options: clone(options) });
    await hooks[operation]?.(claim, options);
    return operation === "path" ? { path: "C:\\fixture\\original-report.bin" } : operation === "cancel" ? { cancelled: true } : {};
  } };
  const chrome = {
    storage: { local: { async get(key) { return Object.hasOwn(storage, key) ? { [key]: clone(storage[key]) } : {}; }, async set(value) { Object.assign(storage, clone(value)); } } },
    debugger: { onDetach: event(), onEvent: event(),
      async attach(target) { calls.push({ method: "attach", target: clone(target) }); },
      async detach(target) { calls.push({ method: "detach", target: clone(target) }); },
      async getTargets() { return [{ id: "original-root-target", tabId: 7, type: "page" }]; },
      async sendCommand(target, method, params = {}) {
        calls.push({ target: clone(target), method, params: clone(params) });
        const value = await hooks.command?.(target, method, params);
        if (value !== undefined) return value;
        if (method === "Page.getFrameTree") return { frameTree: clone(trees.get(target.sessionId)) };
        return {};
      }
    },
    tabs: { onRemoved: event(), onUpdated: event(), onDetached: event(), onReplaced: event(),
      async get(id) { return clone(tabs.get(id)); },
      async query(filter = {}) { await hooks.query?.(); return [...tabs.values()].filter(tab => filter.groupId === undefined || tab.groupId === filter.groupId).map(clone); },
      async sendMessage() { return {}; }, async remove(ids) { for (const id of Array.isArray(ids) ? ids : [ids]) tabs.delete(id); }
    },
    webNavigation: { onBeforeNavigate: event(), onCommitted: event(), onErrorOccurred: event(), onHistoryStateUpdated: event(), onReferenceFragmentUpdated: event(),
      async getAllFrames() { await hooks.frames?.(); return clone(frames); } },
    tabGroups: { async update() {} }, runtime: { id: "fixture", getURL: path => `chrome-extension://fixture/${path}`, getManifest: () => ({ version: "test" }) }
  };
  const createBrowserActionEngine = callbacks => {
    const attached = new Set();
    return {
      async attach(tabId) {
        if (attached.has(tabId)) return;
        await callbacks.onBeforeAttach(tabId); await chrome.debugger.attach({ tabId }); await callbacks.onAttached(tabId); attached.add(tabId);
        for (const [sessionId, tree] of trees) if (sessionId !== undefined)
          backend.handleCdpEvent({ tabId }, "Target.attachedToTarget", { sessionId, targetInfo: { type: "iframe", targetId: tree.frame.id, url: tree.frame.url } });
        if (!omitContext) for (const [sessionId, tree] of trees) context(sessionId, tree.frame.id, contextOrigin ?? tree.frame.securityOrigin);
      },
      async detach(tabId) { attached.delete(tabId); await chrome.debugger.detach({ tabId }); await callbacks.onDetached(tabId); },
      forget(tabId) { attached.delete(tabId); }, controlSnapshot: () => ({ tabIds: [...attached], pending: [] }), async releaseControl() {}
    };
  };
  const Backend = vm.runInNewContext(`${code}\nBrowserBackend`, { chrome, crypto, Date, URL, setTimeout, clearTimeout, createBrowserActionEngine });
  const backend = new Backend({ automationCleanupTimeoutMs: cleanupTimeoutMs }); await backend.controlReady;
  backend.nativePageDownloads = () => client;
  const session = await backend.store.getSession("task"); session.chromeGroupId = 10; session.tabOrigins = { 7: "agent" }; await backend.store.save();
  const current = await backend.getControlState({ session_id: "task" });
  const scope = { session_id: "task", turn_id: "turn", control_epoch: current.controlEpoch, tabId: 7 };
  t.after(async () => {
    for (const gate of gates) gate.resolve();
    for (const key of Object.keys(hooks)) delete hooks[key];
    await Promise.allSettled([backend.downloadWaits.invalidateAll(), backend.detachTab(7)]);
  });
  return { backend, chrome, scope, calls, requests, hooks, tabs, frames, trees, binding, client, context, contexts,
    gate() { const gate = deferred(); gates.push(gate); return gate; },
    arm(extra = {}) { return backend.armDownloadWait({ ...scope, requirePath: true, timeoutMs: 1000, ...extra }); },
    handle(ack) { return { ...scope, waiterId: ack.waiterId }; },
    emit({ sessionId, frameId = "root", guid = "original-guid", url = "blob:https://allowed.test/original-blob" } = {}) {
      backend.handleCdpEvent({ tabId: 7, ...(sessionId ? { sessionId } : {}) }, "Page.downloadWillBegin", { frameId, guid, url, suggestedFilename: "report.bin" });
    },
    child(sessionId = "child", frameId = "child-frame") {
      frames.push({ frameId: 2, parentFrameId: 0, url: "https://child.test/frame", documentId: "child-original", documentLifecycle: "active", errorOccurred: false });
      trees.set(sessionId, { frame: frame(frameId, "https://child.test/frame", "root") });
      backend.handleCdpEvent({ tabId: 7 }, "Target.attachedToTarget", { sessionId, targetInfo: { type: "iframe", targetId: frameId, url: "https://child.test/frame" } });
      context(sessionId, frameId, "https://child.test");
    }
  };
}

async function download(f, source = {}) {
  const ack = await f.arm(); f.emit(source);
  const result = await f.backend.collectDownloadWait(f.handle(ack));
  return { ...f.scope, downloadId: result.downloadId };
}

test("all-mode original HTTP download keeps its existing GUID and native path/cancel contract", async t => {
  const f = await fixture(t, { restricted: false }), handle = await download(f, { url: "https://third-party.test/original-post" });
  assert.deepEqual(await f.backend.downloadPath(handle), { path: "C:\\fixture\\original-report.bin" });
  assert.deepEqual(await f.backend.cancelDownload(handle), { cancelled: true });
  assert.deepEqual(f.requests.map(item => item.operation), ["claim", "path", "cancel"]);
  assert.ok(f.requests.every(item => item.claim.guid === "original-guid"));
});

for (const layout of ["root", "oopif", "dynamic-oopif"]) test(`restricted ${layout} Blob returns only the original GUID and native path`, async t => {
  const f = await fixture(t); if (layout !== "root") await f.backend.attach(f.scope);
  if (layout === "oopif") f.child();
  const ack = await f.arm();
  if (layout === "dynamic-oopif") { f.child(); await f.backend.waitForTransferTargets(7); }
  f.emit(layout === "root" ? {} : { sessionId: "child", frameId: "child-frame", url: "blob:https://child.test/original-blob" });
  const result = await f.backend.collectDownloadWait(f.handle(ack)); assert.equal(result.downloadId, "original-guid");
  assert.deepEqual(await f.backend.downloadPath({ ...f.scope, ...result }), { path: "C:\\fixture\\original-report.bin" });
  assert.equal(f.requests.filter(item => item.operation === "claim").length, 1);
  assert.ok(f.requests.every(item => item.claim.guid === result.downloadId && item.claim.rootTargetId === "original-root-target"));
  assert.equal(f.calls.some(item => ["Network.loadNetworkResource", "DOM.setFileInputFiles", "Input.dispatchMouseEvent"].includes(item.method)), false);
});

async function initialChild(f, { swapFirst = false, holdInitialRead = false } = {}) {
  const sessionId = "new-child", frameId = "new-frame", provisional = { ...frame(frameId, "https://child.test/frame", "root"), url: "", securityOrigin: "://", loaderId: "initial-empty-loader" };
  f.backend.handleCdpEvent({ tabId: 7 }, "Page.frameAttached", { frameId, parentFrameId: "root" });
  f.trees.set(sessionId, { frame: provisional });
  const gate = f.gate(); let read = false;
  if (holdInitialRead) f.hooks.command = async (target, method) => {
    if (target.sessionId === sessionId && method === "Page.getFrameTree" && !read) { read = true; const snapshot = clone(f.trees.get(sessionId)); await gate.promise; return { frameTree: snapshot }; }
  };
  f.backend.handleCdpEvent({ tabId: 7 }, "Target.attachedToTarget", { sessionId, targetInfo: { type: "iframe", targetId: frameId, parentFrameId: "root", url: "" } });
  await tick();
  const swap = () => f.backend.handleCdpEvent({ tabId: 7 }, "Page.frameDetached", { frameId, reason: "swap" });
  if (swapFirst) swap();
  const committed = { ...frame(frameId, "https://child.test/frame", "root"), loaderId: "first-document-loader" };
  f.frames.push({ frameId: 2, parentFrameId: 0, url: committed.url, documentId: "first-child-document", documentLifecycle: "active", errorOccurred: false });
  f.trees.set(sessionId, { frame: committed });
  f.backend.handleCdpEvent({ tabId: 7, sessionId }, "Page.frameNavigated", { frame: committed });
  await f.hooks.childContext?.();
  f.context(sessionId, frameId, "https://child.test");
  if (!swapFirst) swap();
  gate.resolve();
  await f.backend.waitForTransferTargets(7);
  return { sessionId, frameId, url: "blob:https://child.test/original-blob" };
}

for (const options of [{}, { swapFirst: true }, { holdInitialRead: true }]) test(`new OOPIF first commit replaces only its provisional empty document ${JSON.stringify(options)}`, async t => {
  const f = await fixture(t), ack = await f.arm(), source = await initialChild(f, options);
  f.emit(source);
  const result = await f.backend.collectDownloadWait(f.handle(ack));
  assert.equal(result.downloadId, "original-guid");
  assert.deepEqual(await f.backend.downloadPath({ ...f.scope, ...result }), { path: "C:\\fixture\\original-report.bin" });
  assert.equal(f.requests.filter(item => item.operation === "claim").length, 1);
});

for (const change of ["root", "second-child-navigation", "child-document-open", "child-remove"]) test(`first child preparation cannot authorize ${change}`, async t => {
  const f = await fixture(t), ack = await f.arm(), source = await initialChild(f);
  if (change === "root") f.backend.handleCdpEvent({ tabId: 7 }, "Page.frameNavigated", { frame: { ...frame(), loaderId: "new-root-loader" } });
  else if (change === "second-child-navigation") f.backend.handleCdpEvent({ tabId: 7, sessionId: source.sessionId }, "Page.frameNavigated", { frame: { ...frame(source.frameId, "https://child.test/frame", "root"), loaderId: "second-child-loader" } });
  else f.backend.handleCdpEvent({ tabId: 7, sessionId: source.sessionId }, change === "child-remove" ? "Page.frameDetached" : "Page.documentOpened", { frameId: source.frameId, frame: { id: source.frameId }, reason: "remove" });
  f.emit(source); await assert.rejects(f.backend.collectDownloadWait(f.handle(ack)), denied); assert.deepEqual(f.requests, []);
});

test("an existing prepared child cannot claim the new-frame first commit exception", async t => {
  const f = await fixture(t); await f.backend.attach(f.scope); f.child(); const ack = await f.arm();
  f.backend.handleCdpEvent({ tabId: 7 }, "Page.frameAttached", { frameId: "child-frame", parentFrameId: "root" });
  f.backend.handleCdpEvent({ tabId: 7, sessionId: "child" }, "Page.frameNavigated", { frame: { ...frame("child-frame", "https://child.test/frame", "root"), loaderId: "replacement" } });
  f.emit({ sessionId: "child", frameId: "child-frame", url: "blob:https://child.test/original-blob" });
  await assert.rejects(f.backend.collectDownloadWait(f.handle(ack)), denied); assert.deepEqual(f.requests, []);
});

for (const finish of ["cancel", "Pause", "deadline", "child-detach"]) test(`an uncommitted new child does not retain setup after ${finish}`, async t => {
  const f = await fixture(t), ack = await f.arm({ timeoutMs: finish === "deadline" ? 150 : 1000 });
  f.backend.handleCdpEvent({ tabId: 7 }, "Page.frameAttached", { frameId: "new-frame", parentFrameId: "root" });
  f.trees.set("new-child", { frame: { ...frame("new-frame", "https://child.test/frame", "root"), url: "", securityOrigin: "://" } });
  f.backend.handleCdpEvent({ tabId: 7 }, "Target.attachedToTarget", { sessionId: "new-child", targetInfo: { type: "iframe", targetId: "new-frame", parentFrameId: "root", url: "" } });
  await tick(); assert.ok(f.backend.downloadWaits.operations.size > 0);
  if (finish === "Pause") await f.backend.pauseAutomation();
  else if (finish === "deadline") await assert.rejects(f.backend.collectDownloadWait(f.handle(ack)), /TIMEOUT/);
  else {
    if (finish === "child-detach") {
      f.backend.handleCdpEvent({ tabId: 7 }, "Target.detachedFromTarget", { sessionId: "new-child", targetId: "new-frame" });
      await tick(); assert.equal(f.backend.downloadWaits.operations.size, 0);
    }
    await f.backend.cancelDownloadWait(f.handle(ack));
  }
  await tick(); assert.equal(f.backend.downloadWaits.operations.size, 0); assert.deepEqual(f.requests, []);
});

test("cancel joins the actual new-child committed tree ACK but never admits its late source", async t => {
  const f = await fixture(t), ack = await f.arm(), gate = f.gate(), arrived = f.gate(); let childReads = 0;
  f.hooks.command = async (target, method) => {
    if (target.sessionId === "new-child" && method === "Page.getFrameTree" && ++childReads === 2) { arrived.resolve(); await gate.promise; }
  };
  const preparing = initialChild(f), rejected = assert.rejects(preparing, /EXPIRED|CANCELLED/);
  await arrived.promise;
  let done = false; const cancelled = f.backend.cancelDownloadWait(f.handle(ack)).then(() => { done = true; });
  await tick(); assert.equal(done, false); assert.ok(f.backend.downloadWaits.operations.size > 0);
  gate.resolve(); await cancelled; await rejected;
  assert.equal(f.backend.downloadWaits.operations.size, 0); assert.deepEqual(f.requests, []);
});

test("new-child source read must equal the captured first native commit, not a later loader", async t => {
  const f = await fixture(t), ack = await f.arm(); let childReads = 0;
  f.hooks.command = async (target, method) => {
    if (target.sessionId === "new-child" && method === "Page.getFrameTree" && ++childReads === 2)
      return { frameTree: { frame: { ...frame("new-frame", "https://child.test/frame", "root"), loaderId: "unobserved-successor" } } };
  };
  await assert.rejects(initialChild(f), /OBU_SITE_ACCESS_UNVERIFIED/);
  f.emit({ sessionId: "new-child", frameId: "new-frame", url: "blob:https://child.test/original-blob" });
  await assert.rejects(f.backend.collectDownloadWait(f.handle(ack)), denied); assert.deepEqual(f.requests, []);
});

test("opaque default context cannot deliver a shared non-opaque Blob despite its allowed frame-tree origin", async t => {
  const f = await fixture(t, { contextOrigin: "://" }), ack = await f.arm();
  assert.equal(f.trees.get(undefined).frame.securityOrigin, "https://allowed.test");
  f.emit(); await assert.rejects(f.backend.collectDownloadWait(f.handle(ack)), denied); assert.deepEqual(f.requests, []);
});

for (const method of ["Runtime.executionContextDestroyed", "Runtime.executionContextsCleared"]) test(`the prepared default context cannot revive after ${method}`, async t => {
  const f = await fixture(t), ack = await f.arm(), original = f.contexts[0];
  f.backend.handleCdpEvent({ tabId: 7 }, method, { executionContextId: original.id, executionContextUniqueId: original.uniqueId });
  f.backend.handleCdpEvent({ tabId: 7 }, "Runtime.executionContextCreated", { context: original });
  f.context(undefined); f.emit();
  await assert.rejects(f.backend.collectDownloadWait(f.handle(ack)), denied); assert.deepEqual(f.requests, []);
});

test("an isolated context cannot authorize an opaque default context", async t => {
  const f = await fixture(t, { contextOrigin: "://" }), ack = await f.arm();
  f.context(undefined, "root", "https://allowed.test", { auxData: { isDefault: false, frameId: "root" }, name: "utility" });
  f.emit(); await assert.rejects(f.backend.collectDownloadWait(f.handle(ack)), denied); assert.deepEqual(f.requests, []);
});

test("first OOPIF commit waits for its original default context without another Runtime enable", async t => {
  const f = await fixture(t), ack = await f.arm(), gate = f.gate(), arrived = f.gate();
  f.hooks.childContext = () => { arrived.resolve(); return gate.promise; };
  let ready = false; const preparing = initialChild(f).then(value => { ready = true; return value; });
  await arrived.promise; await tick(); assert.equal(ready, false);
  assert.equal(f.backend.pageDownloadContextWaiters.get(7)?.size, 1);
  assert.equal(f.calls.some(call => call.method === "Runtime.enable"), false);
  gate.resolve(); const source = await preparing; f.emit(source);
  assert.equal((await f.backend.collectDownloadWait(f.handle(ack))).downloadId, "original-guid");
  assert.equal(f.backend.pageDownloadContextWaiters.size, 0);
});

for (const finish of ["cancel", "deadline", "detach"]) test(`missing default-context preparation ends on ${finish} and late context cannot revive it`, async t => {
  const f = await fixture(t, { omitContext: true });
  const preparing = f.arm({ timeoutMs: finish === "deadline" ? 150 : 1000 }), rejected = assert.rejects(preparing, /EXPIRED|TIMEOUT|CANCELLED/);
  await tick(); const waiter = f.backend.downloadWaits.byTab.get(7); assert.ok(waiter);
  assert.equal(f.backend.pageDownloadContextWaiters.get(7)?.size, 1);
  if (finish === "cancel") await f.backend.cancelDownloadWait(f.handle(waiter));
  else if (finish === "detach") await f.backend.detachTab(7);
  await rejected; await tick();
  f.context(undefined); f.emit();
  assert.equal(f.backend.pageDownloadContextWaiters.size, 0);
  assert.equal(f.backend.downloadWaits.operations.size, 0); assert.deepEqual(f.requests, []);
});

test("a retired default context destroy cannot invalidate a new unique context with a reused numeric ID", async t => {
  const f = await fixture(t), first = await f.arm(); await f.backend.cancelDownloadWait(f.handle(first)); const original = f.contexts[0];
  f.context(undefined, "root", "https://allowed.test", { id: original.id });
  const ack = await f.arm();
  f.backend.handleCdpEvent({ tabId: 7 }, "Runtime.executionContextDestroyed", { executionContextId: original.id, executionContextUniqueId: original.uniqueId });
  f.emit(); assert.equal((await f.backend.collectDownloadWait(f.handle(ack))).downloadId, "original-guid");
});

test("default-context native IDs are bounded and attachment teardown clears their retired records", async t => {
  const f = await fixture(t); await f.backend.attach(f.scope);
  for (let index = 0; index < 4100; index++) f.context(undefined);
  assert.equal(f.backend.pageDownloadContexts.get(7).size, 4096);
  assert.equal([...f.backend.pageDownloadContexts.get(7).values()].some(context => context.alive), false);
  await f.backend.detachTab(7); assert.equal(f.backend.pageDownloadContexts.has(7), false);
});

for (const url of ["blob:https://denied.test/secret", "blob:null/opaque", "https://allowed.test/original-post", "data:text/plain,secret"])
  test(`restricted first unproven candidate is terminal, never replaced (${url.split(":")[0]})`, async t => {
    const f = await fixture(t), ack = await f.arm(); f.emit({ url }); f.emit({ guid: "second-guid" });
    await assert.rejects(f.backend.collectDownloadWait(f.handle(ack)), denied);
    assert.deepEqual(f.requests, []); assert.equal(f.backend.downloadsById.size, 0);
  });

test("allowed URL cannot authorize a sandboxed opaque native emitter", async t => {
  const f = await fixture(t); f.trees.get(undefined).frame.securityOrigin = "null";
  const ack = await f.arm(); f.emit();
  await assert.rejects(f.backend.collectDownloadWait(f.handle(ack)), denied); assert.deepEqual(f.requests, []);
});

for (const method of ["Page.frameNavigated", "Page.documentOpened"]) test(`original arm document cannot migrate through ${method} before Blob begin`, async t => {
  const f = await fixture(t), ack = await f.arm();
  f.backend.handleCdpEvent({ tabId: 7 }, method, method === "Page.frameNavigated" ? { frame: { ...frame(), loaderId: "replacement-loader" } } : { frame: { id: "root" } });
  f.emit(); await assert.rejects(f.backend.collectDownloadWait(f.handle(ack)), denied); assert.deepEqual(f.requests, []);
});

test("original frame-tree read cannot publish after its document changes", async t => {
  const f = await fixture(t), ack = await f.arm(), gate = f.gate();
  f.hooks.command = async (_target, method) => { if (method === "Page.getFrameTree") await gate.promise; };
  f.emit(); const result = f.backend.collectDownloadWait(f.handle(ack)); const rejection = assert.rejects(result, denied);
  await tick(); f.backend.handleCdpEvent({ tabId: 7 }, "Page.documentOpened", { frame: { id: "root" } });
  gate.resolve(); await rejection; assert.deepEqual(f.requests, []);
});

test("a dynamic child cannot replace the original arm root document before admission", async t => {
  const f = await fixture(t), ack = await f.arm();
  f.backend.handleCdpEvent({ tabId: 7 }, "Page.frameNavigated", { frame: { ...frame(), loaderId: "replacement-root-loader" } });
  f.child(); await f.backend.waitForTransferTargets(7);
  f.emit({ sessionId: "child", frameId: "child-frame", url: "blob:https://child.test/original-blob" });
  await assert.rejects(f.backend.collectDownloadWait(f.handle(ack)), denied); assert.deepEqual(f.requests, []);
});

test("allowed same-document history changes keep the original loader and Blob source", async t => {
  const f = await fixture(t), ack = await f.arm();
  f.trees.get(undefined).frame.url = "https://allowed.test/report#ready";
  f.tabs.get(7).url = f.trees.get(undefined).frame.url; f.frames[0].url = f.tabs.get(7).url;
  f.backend.handleCdpEvent({ tabId: 7 }, "Page.navigatedWithinDocument", { frameId: "root", url: f.tabs.get(7).url });
  f.emit(); const result = await f.backend.collectDownloadWait(f.handle(ack));
  assert.equal(result.downloadId, "original-guid"); assert.equal(f.requests.filter(item => item.operation === "claim").length, 1);
});

test("fixed policy revision is rechecked after native path ACK", async t => {
  const f = await fixture(t), handle = await download(f), gate = f.gate(); f.hooks.path = () => gate.promise;
  const result = f.backend.downloadPath(handle), rejection = assert.rejects(result, denied); await tick();
  const policy = f.backend.siteAccess.status();
  await f.backend.siteAccess.replace({ mode: "allow", origins: ["https://allowed.test", "https://child.test"] }, policy.revision, policy.generation);
  gate.resolve(); await rejection; assert.equal(f.requests.filter(item => item.operation === "path").length, 1);
});

test("observer cancel after denied child joins original setup without inspecting the denied content", async t => {
  const f = await fixture(t), ack = await f.arm();
  f.frames.push({ frameId: 9, parentFrameId: 0, url: "https://denied.test/frame", documentLifecycle: "active", errorOccurred: false });
  f.hooks.frames = () => { throw new Error("Cancellation must not read site content"); };
  assert.deepEqual(await f.backend.cancelDownloadWait(f.handle(ack)), {});
  assert.deepEqual(f.requests, []); assert.equal(f.backend.downloadWaits.records.size, 0);
  await assert.rejects(f.backend.cancelDownloadWait({ ...f.handle(ack), control_epoch: 999 }), /STALE|EPOCH/);
});

test("required binding replacement during admission cannot adopt a successor", async t => {
  const f = await fixture(t), gate = f.gate(); let held = false;
  f.hooks.command = async (_target, method) => { if (method === "Page.enable" && !held) { held = true; await gate.promise; } };
  const result = f.arm(), rejection = assert.rejects(result, /PATH_UNAVAILABLE/); await tick();
  f.backend.nativePageDownloads = () => ({ ...f.client }); gate.resolve(); await rejection; assert.deepEqual(f.requests, []);
});

test("Pause cannot complete while the original private claim release ACK is pending", async t => {
  const f = await fixture(t, { restricted: false }), handle = await download(f), gate = f.gate();
  await f.backend.downloadPath(handle); f.hooks.release = () => gate.promise;
  const paused = f.backend.pauseAutomation();
  await assert.rejects(paused, /CLEANUP_TIMEOUT|PAUSE_FAILED/);
  assert.equal(f.backend.automationControl.status().inputBlocked, true);
  assert.equal(f.requests.filter(item => item.operation === "release").length, 1);
  gate.resolve(); await tick();
});

test("admitted Blob remains the same artifact after allowed same-URL document replacement", async t => {
  const f = await fixture(t), handle = await download(f);
  f.backend.handleCdpEvent({ tabId: 7 }, "Page.frameNavigated", { frame: { ...frame(), loaderId: "new-loader" } });
  f.frames[0].documentId = "new-document";
  assert.deepEqual(await f.backend.downloadPath(handle), { path: "C:\\fixture\\original-report.bin" });
  assert.equal(f.requests.filter(item => item.operation === "claim").length, 1);
  assert.equal(f.requests.at(-1).claim.guid, "original-guid");
});

test("fast original progress is buffered through source inspection without publishing unproven metadata", async t => {
  const f = await fixture(t), ack = await f.arm(), gate = f.gate(), events = [];
  f.backend.addDownloadChangeListener(value => events.push(value));
  f.hooks.command = async (_target, method) => { if (method === "Page.getFrameTree") await gate.promise; };
  f.emit();
  f.backend.handleCdpEvent({ tabId: 7 }, "Page.downloadProgress", { guid: "original-guid", state: "completed" });
  await tick(); assert.deepEqual(events, []); assert.deepEqual(f.requests, []);
  gate.resolve(); await f.backend.collectDownloadWait(f.handle(ack));
  assert.equal(events.at(-1).status, "complete"); assert.equal(events.at(-1).id, "original-guid");
});

test("progress after policy replacement cannot publish metadata or retain an old claim", async t => {
  const f = await fixture(t); await download(f); const events = [];
  f.backend.addDownloadChangeListener(value => events.push(value));
  const policy = f.backend.siteAccess.status();
  await f.backend.siteAccess.replace({ mode: "allow", origins: ["https://allowed.test"] }, policy.revision, policy.generation);
  f.backend.handleCdpEvent({ tabId: 7 }, "Page.downloadProgress", { guid: "original-guid", state: "completed" });
  await tick(); assert.deepEqual(events, []); assert.equal(f.backend.downloadsById.size, 0);
  assert.equal(f.requests.filter(item => item.operation === "release").length, 1);
});

test("buffered progress admitted during its ownership read still checks the complete current tree before emission", async t => {
  const f = await fixture(t), ack = await f.arm(), sourceGate = f.gate(), progressGate = f.gate(), events = [];
  f.hooks.command = async (_target, method) => { if (method === "Page.getFrameTree") await sourceGate.promise; };
  f.backend.addDownloadChangeListener(value => events.push(value)); f.emit(); await tick();
  const validate = f.backend.validateTransferScope.bind(f.backend); let first = true;
  f.backend.validateTransferScope = async scope => { if (first) { first = false; await progressGate.promise; } return validate(scope); };
  f.backend.handleCdpEvent({ tabId: 7 }, "Page.downloadProgress", { guid: "original-guid", state: "completed" });
  await tick(); sourceGate.resolve(); await f.backend.collectDownloadWait(f.handle(ack)); events.length = 0;
  f.frames.push({ frameId: 9, parentFrameId: 0, url: "https://denied.test/frame", documentLifecycle: "active", errorOccurred: false });
  progressGate.resolve(); await tick();
  assert.deepEqual(events, []); assert.equal(f.backend.downloadsById.size, 0);
});

test("concurrent observer cancellation joins the one original matched claim release ACK", async t => {
  const f = await fixture(t), ack = await f.arm(); f.emit();
  await f.backend.downloadWaits.lookup(f.handle(ack)).completion.promise; await tick();
  const gate = f.gate(); f.hooks.release = () => gate.promise; let first = false, second = false;
  const a = f.backend.cancelDownloadWait(f.handle(ack)).then(() => { first = true; });
  await tick(); const b = f.backend.cancelDownloadWait(f.handle(ack)).then(() => { second = true; });
  await tick(); assert.equal(first, false); assert.equal(second, false);
  assert.equal(f.requests.filter(item => item.operation === "release").length, 1);
  gate.resolve(); await Promise.all([a, b]);
  assert.equal(f.backend.pageDownloadOperations.size, 0); assert.equal(f.backend.pageDownloadResources.size, 0);
});

test("canceling an already collected observer never releases its delivered artifact", async t => {
  const f = await fixture(t), ack = await f.arm(); f.emit(); const result = await f.backend.collectDownloadWait(f.handle(ack));
  await f.backend.cancelDownloadWait(f.handle(ack));
  assert.equal(f.requests.some(item => item.operation === "release"), false);
  assert.deepEqual(await f.backend.downloadPath({ ...f.scope, ...result }), { path: "C:\\fixture\\original-report.bin" });
});

test("failed release is retained and only an explicit retry resends the same private claim", async t => {
  const f = await fixture(t); await download(f); f.hooks.release = () => { throw new Error("original release rejected"); };
  await assert.rejects(f.backend.pauseAutomation({ retryPageCleanup: false }), /original release rejected/);
  assert.equal(f.backend.pageDownloadResources.size, 1);
  await assert.rejects(f.backend.pauseAutomation({ retryPageCleanup: false }), /original release rejected/);
  assert.equal(f.requests.filter(item => item.operation === "release").length, 1);
  delete f.hooks.release; await f.backend.pauseAutomation();
  const releases = f.requests.filter(item => item.operation === "release");
  assert.equal(releases.length, 2); assert.deepEqual(releases[0].claim, releases[1].claim);
  assert.equal(f.backend.pageDownloadResources.size, 0);
});

for (const ending of ["session", "detach", "input-release"]) test(`${ending} waits for the original claim release before debugger detach`, async t => {
  const f = await fixture(t), handle = await download(f); await f.backend.downloadPath(handle);
  const gate = f.gate(); f.hooks.release = () => gate.promise; const before = f.calls.length; let done = false;
  const pending = (ending === "session" ? f.backend.turnEnded(f.scope) : ending === "detach" ? f.backend.detach(f.scope) : f.backend.prepareInputRelease(7).release()).then(() => { done = true; });
  await tick(); assert.equal(done, false); assert.equal(f.requests.filter(item => item.operation === "release").length, 1);
  assert.equal(f.calls.slice(before).some(item => item.method === "detach"), false);
  gate.resolve(); await pending; assert.equal(f.backend.pageDownloadResources.size, 0);
});

test("native path caller timeout cannot erase its actual pending request or let Pause finish", async t => {
  const f = await fixture(t), handle = await download(f), gate = f.gate(); await f.backend.downloadsById.get(handle.downloadId).nativeClaimPromise;
  const original = f.client.request.bind(f.client), actuals = new WeakMap();
  f.client.request = (operation, claim, options) => {
    if (operation !== "path") return original(operation, claim, options);
    const request = Promise.reject(new Error("OBU_NATIVE_DOWNLOAD_TIMEOUT: original path deadline expired")); actuals.set(request, gate.promise); return request;
  };
  f.client.settlement = request => actuals.get(request) ?? request;
  await assert.rejects(f.backend.downloadPath(handle), /NATIVE_DOWNLOAD_TIMEOUT/);
  assert.equal(f.backend.pageDownloadOperations.size, 1);
  await assert.rejects(f.backend.pauseAutomation(), /CLEANUP_TIMEOUT|PAUSE_FAILED/);
  assert.equal(f.requests.filter(item => item.operation === "release").length, 0);
  gate.resolve({ path: "C:\\too-late.bin" }); await tick();
  assert.equal(f.requests.filter(item => item.operation === "release").length, 1);
  assert.equal(f.backend.pageDownloadOperations.size, 0); assert.equal(f.backend.pageDownloadResources.size, 0);
});

test("retired claim cleanup uses only the original client and never grants detach authority to a successor", async t => {
  const f = await fixture(t); await download(f); await tick(); const gate = f.gate(); f.hooks.release = () => gate.promise;
  f.backend.retirePageDownload("original-guid"); await tick();
  f.backend.browserEngine.forget(7); f.backend.releaseEngineAttachment(7);
  const successor = [], token = {}; f.backend.nativePageDownloads = () => ({ status: () => ({ available: true, generation: "new" }), request: (...args) => { successor.push(args); return Promise.resolve({}); } });
  f.backend.attachmentEpochs.set(7, token);
  assert.equal(f.backend.globalControlSnapshot().tabIds.has(7), false);
  const before = f.calls.length; gate.resolve(); await f.backend.drainPageDownloads();
  assert.deepEqual(successor, []); assert.equal(f.calls.slice(before).some(item => item.method === "detach"), false);
  assert.equal(f.backend.attachmentEpochs.get(7), token);
});

test("CRX release synchronously retires an armed observer before a delayed real key release can admit a new claim", async t => {
  const f = await fixture(t), ack = await f.arm(), token = f.backend.attachmentEpochs.get(7);
  const target = { tabId: 7 }, down = { type: "rawKeyDown", key: "Shift", code: "ShiftLeft" };
  await f.backend.inputTracker.send(target, token, "Input.dispatchKeyEvent", down, () => f.chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", down));
  const gate = f.gate(), entered = f.gate();
  f.hooks.command = async (_target, method, params) => { if (method === "Input.dispatchKeyEvent" && params.type === "keyUp") { entered.resolve(); await gate.promise; } };
  const result = f.backend.collectDownloadWait(f.handle(ack)).then(value => ({ value }), error => ({ error }));
  const releasing = f.backend.prepareInputRelease(7).release(); releasing.catch(() => {});
  await entered.promise; f.emit(); await tick();
  assert.equal(f.requests.filter(item => item.operation === "claim").length, 0);
  gate.resolve(); await releasing;
  assert.match(String((await result).error), /WAIT_EXPIRED|TRANSFER_CANCELLED/);
  assert.equal(f.backend.pageDownloadResources.size, 0);
});
