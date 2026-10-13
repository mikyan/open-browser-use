import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import nativeVM from "node:vm";
import test from "node:test";
import vm from "./test-support/backend-vm.mjs";
import { SITE_ACCESS_POLICY_KEY } from "./site-access-policy.js";

const input = (await readFile(new URL("./browser-input-adapter.js", import.meta.url), "utf8")).replace(/^export /gm, "");
const source = (await readFile(new URL("./background.js", import.meta.url), "utf8"))
  .replace('import { createBrowserActionEngine } from "./browser-runtime.js";', "")
  .replace('import { NativeInputTracker } from "./browser-input-adapter.js";', input);
const code = source.slice(0, source.indexOf("chrome.runtime.onInstalled.addListener"));
const clone = value => structuredClone(value);
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const event = () => ({ addListener() {}, removeListener() {} });
const siteError = /OBU_SITE_ACCESS_(?:DENIED|UNVERIFIED)|OBU_FILE_CHOOSER_WAIT_EXPIRED|OBU_TRANSFER_CANCELLED/;
const nativeFrame = (id = "root", url = "https://allowed.test/page", parentId) => ({ id, url, loaderId: `loader-${id}`, ...(parentId ? { parentId } : {}) });

// Run the production isolated-world controller/clear functions, rather than a
// second copy of its admission/cleanup algorithm. Only CDP and the DOM are fake.
function renderer() {
  const contexts = new Map(), objects = new Map(), nodes = new Map();
  let serial = 0;
  const key = (target, id) => JSON.stringify([target.tabId, target.sessionId ?? null, id]);
  function context(target, frameId) {
    const identity = key(target, frameId);
    if (!contexts.has(identity)) {
      const realm = nativeVM.createContext({ Date });
      nativeVM.runInContext(`globalThis.document = { defaultView: globalThis };
        globalThis.Event = class { constructor(type) { this.type = type; this.isTrusted = false; } };
        globalThis.HTMLInputElement = class {
          constructor() { this.tagName='INPUT'; this.type='file'; this.isConnected=true; this.ownerDocument=document;
            this.webkitdirectory=false; this.multiple=false; this.files=[]; this.listeners=new Map(); }
          set value(value) { if (value==='') this.files=[]; }
          addEventListener(type, fn) { const set=this.listeners.get(type)??new Set(); set.add(fn); this.listeners.set(type,set); }
          removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
          dispatchEvent(event) { event.target??=this; for (const fn of [...this.listeners.get(event.type)??[]]) fn(event); return true; }
        };`, realm);
      contexts.set(identity, { id: ++serial, realm });
    }
    return contexts.get(identity);
  }
  return {
    nodes,
    async send(target, method, args) {
      if (method === "Page.createIsolatedWorld") return { executionContextId: context(target, args.frameId).id };
      if (method === "DOM.resolveNode") {
        const ctx = [...contexts.values()].find(item => item.id === args.executionContextId);
        assert.ok(ctx, "resolve must use the original returned isolated world");
        const nodeKey = key(target, args.backendNodeId);
        if (!nodes.has(nodeKey)) nodes.set(nodeKey, { node: nativeVM.runInContext("new HTMLInputElement()", ctx.realm), ctx });
        const item = nodes.get(nodeKey); assert.equal(item.ctx, ctx);
        const objectId = `node-${++serial}`; objects.set(objectId, { value: item.node, ctx });
        return { object: { objectId } };
      }
      if (method === "Runtime.callFunctionOn") {
        const item = objects.get(args.objectId); assert.ok(item, "function must use an actual original object");
        const fn = nativeVM.runInContext(`(${args.functionDeclaration})`, item.ctx.realm);
        let value = fn.apply(item.value, (args.arguments ?? []).map(arg => arg.value));
        if (args.awaitPromise) value = await value;
        if (args.returnByValue) return { result: { value: JSON.parse(JSON.stringify(value)) } };
        const objectId = `controller-${++serial}`; objects.set(objectId, { value, ctx: item.ctx });
        return { result: { objectId } };
      }
      if (method === "Runtime.releaseObject") { objects.delete(args.objectId); return {}; }
      if (method === "DOM.setFileInputFiles") {
        const item = nodes.get(key(target, args.backendNodeId)); assert.ok(item);
        item.node.files = args.files.map(name => ({ name })); return {};
      }
      return {};
    }
  };
}

async function fixture(t, { restricted = true, cleanupTimeoutMs = 30 } = {}) {
  const storage = restricted ? { [SITE_ACCESS_POLICY_KEY]: { version: 1, revision: 3, mode: "allow", origins: ["https://allowed.test", "https://child.test"] } } : {};
  const calls = [], hooks = {}, gates = [], view = renderer();
  const tabs = new Map([[7, { id: 7, groupId: 10, windowId: 1, url: "https://allowed.test/page", active: false }]]);
  const frames = [{ frameId: 0, parentFrameId: -1, url: "https://allowed.test/page", documentId: "original-root", documentLifecycle: "active", errorOccurred: false }];
  const trees = new Map([[undefined, { frame: nativeFrame() }]]);
  const chrome = {
    storage: { local: {
      async get(key) { return Object.hasOwn(storage, key) ? { [key]: clone(storage[key]) } : {}; },
      async set(value) { Object.assign(storage, clone(value)); }
    } },
    debugger: { onDetach: event(), onEvent: event(),
      async attach(target) { calls.push({ method: "attach", target }); },
      async detach(target) { calls.push({ method: "detach", target }); },
      async sendCommand(target, method, args = {}) {
        calls.push({ target: clone(target), method, args: clone(args) });
        const override = await hooks.command?.(target, method, args);
        if (override !== undefined) return override;
        if (method === "Page.getFrameTree") return { frameTree: clone(trees.get(target.sessionId)) };
        return view.send(target, method, args);
      }
    },
    tabs: { onRemoved: event(), onUpdated: event(), onDetached: event(), onReplaced: event(),
      async get(id) { return clone(tabs.get(id)); },
      async query(filter = {}) { await hooks.query?.(); return [...tabs.values()].filter(tab => filter.groupId === undefined || tab.groupId === filter.groupId).map(clone); },
      async sendMessage() { return {}; },
      async remove(ids) { for (const id of Array.isArray(ids) ? ids : [ids]) tabs.delete(id); }
    },
    webNavigation: { onBeforeNavigate: event(), onCommitted: event(), onErrorOccurred: event(), onHistoryStateUpdated: event(), onReferenceFragmentUpdated: event(),
      async getAllFrames() { await hooks.frames?.(); return clone(frames); } },
    tabGroups: { async update() {} },
    runtime: { id: "fixture", getURL: path => `chrome-extension://fixture/${path}`, getManifest: () => ({ version: "test" }) }
  };
  const createBrowserActionEngine = callbacks => {
    const attached = new Set();
    return {
      async attach(tabId) {
        if (attached.has(tabId)) return;
        await callbacks.onBeforeAttach(tabId); await chrome.debugger.attach({ tabId });
        await callbacks.onAttached(tabId); attached.add(tabId);
        // A raw-to-engine attachment migration auto-attaches existing OOPIFs
        // again. Model that actual target event rather than keeping stale IDs.
        for (const [sessionId, tree] of trees) if (sessionId !== undefined)
          backend.handleCdpEvent({ tabId }, "Target.attachedToTarget", { sessionId,
            targetInfo: { type: "iframe", targetId: tree.frame.id, url: tree.frame.url } });
      },
      async detach(tabId) { attached.delete(tabId); await chrome.debugger.detach({ tabId }); await callbacks.onDetached(tabId); },
      forget(tabId) { attached.delete(tabId); },
      controlSnapshot: () => ({ tabIds: [...attached], pending: [] }),
      async releaseControl() {}
    };
  };
  const Backend = vm.runInNewContext(`${code}\nBrowserBackend`, { chrome, crypto, Date, URL, setTimeout, clearTimeout, createBrowserActionEngine });
  const backend = new Backend({ automationCleanupTimeoutMs: cleanupTimeoutMs }); await backend.controlReady;
  const session = await backend.store.getSession("task"); session.chromeGroupId = 10; session.tabOrigins = { 7: "agent" }; await backend.store.save();
  const current = await backend.getControlState({ session_id: "task" });
  const scope = { session_id: "task", turn_id: "turn", control_epoch: current.controlEpoch, tabId: 7 };
  t.after(async () => {
    for (const gate of gates) gate.resolve();
    for (const key of Object.keys(hooks)) delete hooks[key];
    await Promise.allSettled([backend.fileChooserWaits.invalidateAll(), backend.detachTab(7)]);
  });
  return { backend, chrome, scope, calls, hooks, tabs, frames, trees, view,
    gate() { const gate = deferred(); gates.push(gate); return gate; },
    arm(extra = {}) { return backend.armFileChooserWait({ ...scope, timeoutMs: 1000, ...extra }); },
    handle(ack) { return { ...scope, waiterId: ack.waiterId }; },
    emit({ sessionId, frameId = "root", backendNodeId = 51, mode = "selectSingle" } = {}) {
      return backend.handleCdpEvent({ tabId: 7, ...(sessionId ? { sessionId } : {}) }, "Page.fileChooserOpened", { frameId, backendNodeId, mode });
    },
    child(sessionId = "child", frameId = "child-frame") {
      frames.push({ frameId: 2, parentFrameId: 0, url: "https://child.test/frame", documentId: "original-child", documentLifecycle: "active", errorOccurred: false });
      trees.set(sessionId, { frame: nativeFrame(frameId, "https://child.test/frame", "root") });
      backend.handleCdpEvent({ tabId: 7 }, "Target.attachedToTarget", { sessionId, targetInfo: { type: "iframe", targetId: frameId, url: "https://child.test/frame" } });
    }
  };
}

async function selected(f, eventParams = {}) {
  const ready = await f.arm(); f.emit(eventParams);
  const result = await f.backend.collectFileChooserWait(f.handle(ready));
  return { ready, result, set: { ...f.scope, fileChooserId: result.fileChooserId, files: ["C:\\fixture\\original.txt"] } };
}

test("unrestricted chooser retains original native node and clear semantics", async t => {
  const f = await fixture(t, { restricted: false }), choice = await selected(f);
  await f.backend.setFileChooserFiles(choice.set);
  assert.deepEqual(f.calls.filter(row => row.method === "DOM.setFileInputFiles").map(row => row.args), [{ backendNodeId: 51, files: choice.set.files }]);
  const clear = await selected(f); await f.backend.setFileChooserFiles({ ...clear.set, files: [] });
  assert.equal([...f.view.nodes.values()][0].node.files.length, 0);
});

for (const target of ["root", "oopif", "nested-same-process"]) test(`restricted chooser ${target} returns and writes only its original native node`, async t => {
  const f = await fixture(t); await f.backend.attach(f.scope);
  let eventParams = {};
  if (target !== "root") {
    f.child(); eventParams = { sessionId: "child", frameId: "child-frame" };
    if (target === "nested-same-process") {
      f.trees.get("child").childFrames = [{ frame: nativeFrame("nested", "https://child.test/nested", "child-frame") }];
      eventParams.frameId = "nested";
    }
  }
  const choice = await selected(f, eventParams);
  await f.backend.setFileChooserFiles(choice.set);
  const writes = f.calls.filter(row => row.method === "DOM.setFileInputFiles");
  assert.equal(writes.length, 1); assert.equal(writes[0].target.sessionId, eventParams.sessionId);
  assert.equal(writes[0].args.backendNodeId, 51);
  assert.equal(f.calls.some(row => row.method.startsWith("Input.")), false);
  assert.equal(f.backend.fileChoosersById.size, 0);
});

test("restricted readiness cannot adopt a policy revision changed during original enable ACK", async t => {
  const f = await fixture(t), gate = f.gate(), entered = f.gate();
  f.hooks.command = async (_target, method, args) => { if (method === "Page.setInterceptFileChooserDialog" && args.enabled) { entered.resolve(); await gate.promise; } };
  const arming = f.arm(); arming.catch(() => {});
  // A failure to reach native enable is itself the old unsupported red.
  await Promise.race([entered.promise, arming]);
  const state = f.backend.siteAccess.status(); await f.backend.siteAccess.replace({ mode: "allow", origins: ["https://allowed.test"] }, state.revision, state.generation);
  gate.resolve(); await assert.rejects(arming, siteError);
  assert.equal(f.backend.fileChoosersById.size, 0);
});

test("an unproven native emitter is rejected rather than reinterpreted as the current allowed frame", async t => {
  const f = await fixture(t), ready = await f.arm(); f.emit({ frameId: "not-in-original-native-tree" });
  await assert.rejects(f.backend.collectFileChooserWait(f.handle(ready)), /OBU_SITE_ACCESS_UNVERIFIED/);
  assert.equal(f.backend.fileChoosersById.size, 0);
  assert.equal(f.calls.some(row => row.method === "DOM.setFileInputFiles"), false);
});

test("chooser native source URL must be allowed even if webNavigation snapshot is allowed", async t => {
  const f = await fixture(t), ready = await f.arm();
  f.trees.set(undefined, { frame: nativeFrame("root", "https://denied.test/private") }); f.emit();
  await assert.rejects(f.backend.collectFileChooserWait(f.handle(ready)), /OBU_SITE_ACCESS_DENIED/);
  assert.equal(f.backend.fileChoosersById.size, 0);
});

test("a policy change during actual disable ACK cannot publish the earlier chooser", async t => {
  const f = await fixture(t), ready = await f.arm(), gate = f.gate(), entered = f.gate();
  f.hooks.command = async (_target, method, args) => { if (method === "Page.setInterceptFileChooserDialog" && !args.enabled) { entered.resolve(); await gate.promise; } };
  f.emit(); const collecting = f.backend.collectFileChooserWait(f.handle(ready)); collecting.catch(() => {});
  await entered.promise;
  const state = f.backend.siteAccess.status(); await f.backend.siteAccess.replace({ mode: "allow", origins: ["https://allowed.test"] }, state.revision, state.generation);
  gate.resolve(); await assert.rejects(collecting, siteError);
  assert.equal(f.backend.fileChoosersById.size, 0);
});

test("same URL document replacement after chooser collection never remints a submission token", async t => {
  const f = await fixture(t), choice = await selected(f);
  f.backend.handleCdpEvent({ tabId: 7 }, "Page.documentOpened", { frame: nativeFrame() });
  await assert.rejects(f.backend.setFileChooserFiles(choice.set), /unowned|EXPIRED|CANCELLED|SITE_ACCESS/);
  assert.equal(f.calls.some(row => row.method === "DOM.setFileInputFiles"), false);
});

test("restricted cancel drains original interception without reading a revoked document", async t => {
  const f = await fixture(t), ready = await f.arm(), gate = f.gate(), entered = f.gate();
  let inspections = 0;
  f.backend.assertSiteTab = async () => { inspections++; throw new Error("OBU_SITE_ACCESS_DENIED: revoked"); };
  f.backend.siteRevokedTabs.add(7);
  f.hooks.command = async (_target, method, args) => { if (method === "Page.setInterceptFileChooserDialog" && !args.enabled) { entered.resolve(); await gate.promise; } };
  let done = false; const cancelling = f.backend.cancelFileChooserWait(f.handle(ready)); cancelling.then(() => { done = true; }, () => {});
  await Promise.race([entered.promise, cancelling]); await tick(); assert.equal(done, false);
  gate.resolve(); assert.deepEqual(await cancelling, {}); assert.equal(inspections, 0);
});

test("policy changed during an actual file write ACK rejects without replaying the write", async t => {
  const f = await fixture(t), choice = await selected(f), gate = f.gate(), entered = f.gate();
  f.hooks.command = async (_target, method) => { if (method === "DOM.setFileInputFiles") { entered.resolve(); await gate.promise; } };
  const setting = f.backend.setFileChooserFiles(choice.set); setting.catch(() => {}); await entered.promise;
  const state = f.backend.siteAccess.status(); await f.backend.siteAccess.replace({ mode: "allow", origins: ["https://allowed.test"] }, state.revision, state.generation);
  gate.resolve(); await assert.rejects(setting, siteError);
  await assert.rejects(f.backend.setFileChooserFiles(choice.set), /unowned|EXPIRED|CONSUMED/);
  assert.equal(f.calls.filter(row => row.method === "DOM.setFileInputFiles").length, 1);
});

test("caller timeout never lets Pause claim completion while the original native file write is pending", async t => {
  const f = await fixture(t, { restricted: false }), choice = await selected(f), gate = f.gate(), entered = f.gate();
  f.hooks.command = async (_target, method) => { if (method === "DOM.setFileInputFiles") { entered.resolve(); await gate.promise; } };
  const setting = f.backend.setFileChooserFiles({ ...choice.set, timeoutMs: 35 }); setting.catch(() => {}); await entered.promise;
  await assert.rejects(setting, /TIMEOUT/);
  assert.ok(f.backend.directoryUploads.operations.size > 0, "actual native Promise remains pending after caller timeout");
  await assert.rejects(f.backend.pauseAutomation(), /CLEANUP_TIMEOUT|cleanup.*pending/i);
  const paused = await f.backend.getAutomationControlStatus(); assert.equal(paused.inputBlocked, true); assert.equal(paused.cleanupComplete, false);
  gate.resolve();
});

test("the first native chooser remains selected while its original frame proof is being read", async t => {
  const f = await fixture(t), ready = await f.arm(), gate = f.gate(), entered = f.gate();
  f.hooks.command = async (_target, method) => { if (method === "Page.getFrameTree") { entered.resolve(); await gate.promise; } };
  f.emit({ backendNodeId: 51 }); const collecting = f.backend.collectFileChooserWait(f.handle(ready)); collecting.catch(() => {});
  await entered.promise; f.emit({ backendNodeId: 99 }); gate.resolve();
  const choice = await collecting;
  await f.backend.setFileChooserFiles({ ...f.scope, fileChooserId: choice.fileChooserId, files: ["original.txt"] });
  assert.deepEqual(f.calls.filter(row => row.method === "DOM.setFileInputFiles").map(row => row.args.backendNodeId), [51]);
  assert.equal(f.calls.filter(row => row.method === "Page.getFrameTree").length, 1);
});

test("a late original frame-tree reply cannot certify a replacement document at the same URL", async t => {
  const f = await fixture(t), ready = await f.arm(), gate = f.gate(), entered = f.gate();
  f.hooks.command = async (_target, method) => {
    if (method === "Page.getFrameTree") { const frameTree = clone(f.trees.get(undefined)); entered.resolve(); await gate.promise; return { frameTree }; }
  };
  f.emit(); const collecting = f.backend.collectFileChooserWait(f.handle(ready)); const outcome = assert.rejects(collecting, siteError);
  await entered.promise; f.backend.handleCdpEvent({ tabId: 7 }, "Page.documentOpened", { frame: nativeFrame() });
  await outcome; gate.resolve(); await tick();
  assert.equal(f.backend.fileChoosersById.size, 0);
  assert.equal(f.calls.some(row => row.method === "DOM.setFileInputFiles"), false);
});

test("an original blank local subframe inherits its proven native parent rather than tab URL", async t => {
  const f = await fixture(t), ready = await f.arm();
  f.trees.get(undefined).childFrames = [{ frame: nativeFrame("local-blank", "about:blank", "root") }];
  f.emit({ frameId: "local-blank" });
  const choice = await f.backend.collectFileChooserWait(f.handle(ready));
  await f.backend.setFileChooserFiles({ ...f.scope, fileChooserId: choice.fileChooserId, files: ["local.txt"] });
  assert.equal(f.calls.find(row => row.method === "Page.createIsolatedWorld").args.frameId, "local-blank");
});

test("same policy revision from a new runtime generation cannot revive a delivered chooser", async t => {
  const f = await fixture(t), choice = await selected(f), policy = f.backend.siteAccess;
  const replacement = new policy.constructor({ storage: f.chrome.storage.local }); await replacement.ready;
  assert.equal(replacement.status().revision, policy.status().revision); assert.notEqual(replacement.generation, policy.generation);
  f.backend.siteAccess = replacement;
  await assert.rejects(f.backend.setFileChooserFiles(choice.set), /OBU_SITE_ACCESS_UNVERIFIED/);
  assert.equal(f.calls.some(row => row.method === "DOM.setFileInputFiles"), false);
});

test("restricted input-caused allowed navigation after native submission retains the successful one-write contract", async t => {
  const f = await fixture(t), choice = await selected(f);
  f.hooks.command = async (_target, method) => {
    if (method === "DOM.setFileInputFiles") {
      f.tabs.get(7).url = "https://allowed.test/saved"; f.frames[0].url = f.tabs.get(7).url;
      f.backend.handleCdpEvent({ tabId: 7 }, "Page.frameNavigated", { frame: nativeFrame("root", f.tabs.get(7).url) });
    }
  };
  await f.backend.setFileChooserFiles(choice.set);
  assert.equal(f.calls.filter(row => row.method === "DOM.setFileInputFiles").length, 1);
  await assert.rejects(f.backend.setFileChooserFiles(choice.set), /unowned/);
});

test("permissions changing during actual renderer guard cleanup ACK reject the already-submitted result", async t => {
  const f = await fixture(t), choice = await selected(f), gate = f.gate(), entered = f.gate();
  f.hooks.command = async (_target, method, args) => {
    if (method === "Runtime.callFunctionOn" && args.functionDeclaration.includes("this.cleanup(")) { entered.resolve(); await gate.promise; }
  };
  const setting = f.backend.setFileChooserFiles(choice.set); setting.catch(() => {}); await entered.promise;
  const policy = f.backend.siteAccess.status(); await f.backend.siteAccess.replace({ mode: "allow", origins: ["https://allowed.test"] }, policy.revision, policy.generation);
  gate.resolve(); await assert.rejects(setting, siteError);
  assert.equal(f.calls.filter(row => row.method === "DOM.setFileInputFiles").length, 1);
});

test("turn end joins a timed-out native setter before acknowledging release", async t => {
  const f = await fixture(t), choice = await selected(f), gate = f.gate(), entered = f.gate();
  f.hooks.command = async (_target, method) => { if (method === "DOM.setFileInputFiles") { entered.resolve(); await gate.promise; } };
  const setting = f.backend.setFileChooserFiles({ ...choice.set, timeoutMs: 35 }); setting.catch(() => {});
  await entered.promise; await assert.rejects(setting, /TIMEOUT/);
  let done = false; const ending = f.backend.turnEnded(f.scope).then(value => { done = true; return value; }); ending.catch(() => {});
  await tick(); assert.equal(done, false); assert.equal(f.calls.filter(row => row.method === "detach").length, 0);
  gate.resolve(); await ending; assert.equal(done, true); assert.equal(f.backend.directoryUploads.operations.size, 0);
});

test("old native file ACK cannot let delayed cleanup detach a successor attachment", async t => {
  const f = await fixture(t), choice = await selected(f), gate = f.gate(), entered = f.gate();
  f.hooks.command = async (_target, method) => { if (method === "DOM.setFileInputFiles") { entered.resolve(); await gate.promise; } };
  const setting = f.backend.setFileChooserFiles({ ...choice.set, timeoutMs: 35 }); setting.catch(() => {});
  await entered.promise; await assert.rejects(setting, /TIMEOUT/);
  const old = f.backend.attachmentEpochs.get(7), releasing = f.backend.detachTab(7); releasing.catch(() => {});
  await tick(); const checkpoint = f.calls.length;
  f.backend.releaseEngineAttachment(7);
  await f.backend.registerEngineAttachment(7); f.backend.rememberAttachmentOwner(f.scope, 7);
  const successor = f.backend.attachmentEpochs.get(7); assert.notEqual(successor, old);
  gate.resolve(); await assert.rejects(releasing, /ATTACHMENT_CHANGED/);
  assert.equal(f.backend.attachmentEpochs.get(7), successor);
  assert.equal(f.calls.slice(checkpoint).some(row => row.method === "detach"), false);
});

test("the original CRX input-release ticket also drains file writes before allowing native detach", async t => {
  const f = await fixture(t), choice = await selected(f), gate = f.gate(), entered = f.gate();
  f.hooks.command = async (_target, method) => { if (method === "DOM.setFileInputFiles") { entered.resolve(); await gate.promise; } };
  const setting = f.backend.setFileChooserFiles({ ...choice.set, timeoutMs: 35 }); setting.catch(() => {});
  await entered.promise; await assert.rejects(setting, /TIMEOUT/);
  const ticket = f.backend.prepareInputRelease(7);
  let done = false; const releasing = ticket.release().then(() => { done = true; }); releasing.catch(() => {});
  await tick(); assert.equal(done, false, "the engine's captured hook cannot bypass the original file native Promise");
  gate.resolve(); await releasing; assert.equal(done, true);
});
