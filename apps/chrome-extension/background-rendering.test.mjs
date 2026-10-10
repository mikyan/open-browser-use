import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "./test-support/backend-vm.mjs";

const source = (await readFile(new URL("./background.js", import.meta.url), "utf8")).replace('import { createBrowserActionEngine } from "./browser-runtime.js";', "").replace('import { NativeInputTracker } from "./browser-input-adapter.js";', (await readFile(new URL("./browser-input-adapter.js", import.meta.url), "utf8")).replace(/^export /gm, "") + "\nglobalThis.performance ??= { now: () => Date.now() };");
const runtimeStart = source.indexOf("chrome.runtime.onInstalled.addListener");
assert.notEqual(runtimeStart, -1);
const session = { session_id: "render-test", turn_id: "turn-1" };
const json = (value) => JSON.parse(JSON.stringify(value));
const defer = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function loadBackend({ attachError, command, detach, frames = true } = {}) {
  const calls = [];
  const listeners = new Set();
  let detachListener;
  const emit = (source = { tabId: 7 }) => {
    for (const listener of [...listeners]) listener(source, "Page.screencastFrame", { sessionId: 42 });
  };
  const chrome = {
    debugger: {
      onEvent: { addListener(fn) { listeners.add(fn); }, removeListener(fn) { listeners.delete(fn); } },
      onDetach: { addListener(fn) { detachListener = fn; } },
      async attach(target) { calls.push(["attach", json(target)]); if (attachError) throw attachError; },
      async detach(target) { calls.push(["detach", json(target)]); await detach?.(target); },
      async sendCommand(target, method, params) {
        calls.push([method, json(target), params === undefined ? undefined : json(params)]);
        const response = await command?.(method, params);
        if (method === "Page.startScreencast" && frames) queueMicrotask(emit);
        return response ?? (method === "Page.captureScreenshot" ? { data: "original-image" } : {});
      }
    },
    storage: { local: { async get() { return {}; }, async set() {} } },
    tabs: {
      async query() { return [{ id: 7, groupId: 10, url: "https://fixture.test" }]; },
      async update() { throw new Error("Must not activate a tab"); }
    },
    windows: { async update() { throw new Error("Must not focus a window"); } }
  };
  const BrowserBackend = vm.runInNewContext(`${source.slice(0, runtimeStart)}\nBrowserBackend;`, {
    chrome, Date, setTimeout, clearTimeout
  });
  const backend = new BrowserBackend();
  await backend.store.ready;
  (await backend.store.getSession(session.session_id)).chromeGroupId = 10;
  const attach = () => backend.attach({ ...session, tabId: 7 });
  const cdp = (method, commandParams = {}, extra = {}) => backend.executeCdp({
    ...session, target: { tabId: 7 }, method, commandParams, timeoutMs: 250, ...extra
  });
  return { backend, attach, cdp, calls, emit, listeners, detachListener: () => detachListener({ tabId: 7 }) };
}

test("attachment enables background rendering once without tab or window activation", async () => {
  const { backend, attach, calls, detachListener } = await loadBackend();
  await attach();
  await attach();
  assert.deepEqual(calls, [["attach", { tabId: 7 }], ["Emulation.setFocusEmulationEnabled", { tabId: 7 }, { enabled: true }]]);
  assert.ok(backend.attachedTabs.has(7));
  detachListener();
  assert.equal(backend.attachedTabs.has(7), false);
  assert.equal(backend.attachmentEpochs.has(7), false);
  await attach();
  assert.equal(calls.filter(([method]) => method === "Emulation.setFocusEmulationEnabled").length, 2);
});

test("failed focus initialization detaches our new attachment and preserves the error", async () => {
  const failure = new Error("Renderer disappeared");
  const { backend, attach, calls } = await loadBackend({ command: () => { throw failure; } });
  await assert.rejects(attach(), (error) => error === failure);
  assert.equal(backend.attachedTabs.size, 0);
  assert.equal(calls.at(-1)[0], "detach");
});

test("a competing debugger is never detached when attachment initialization fails", async () => {
  const failure = new Error("Debugger is not attached");
  const { backend, attach, calls } = await loadBackend({
    attachError: new Error("Another debugger is already attached"), command: () => { throw failure; }
  });
  await assert.rejects(attach(), (error) => error === failure);
  assert.equal(backend.attachedTabs.size, 0);
  assert.equal(calls.some(([method]) => method === "detach"), false);
});

test("engine migration releases our raw attachment but leaves unknown debuggers alone", async () => {
  const { backend, attach, calls } = await loadBackend();
  await backend.prepareEngineAttachment(7);
  assert.deepEqual(calls, []);
  await attach();
  const previousAttachment = backend.attachmentEpochs.get(7);
  await backend.prepareEngineAttachment(7);
  assert.equal(calls.at(-1)[0], "detach");
  assert.equal(backend.attachedTabs.has(7), false);
  assert.notEqual(backend.attachmentEpochs.get(7), previousAttachment);
  assert.equal(backend.pendingAttachmentTabs.has(7), true);
});

test("a screenshot primes a frame and preserves all capture options and the result", async () => {
  const { attach, cdp, calls, listeners } = await loadBackend();
  await attach();
  calls.length = 0;
  const options = { format: "webp", quality: 87, fromSurface: true, captureBeyondViewport: true,
    clip: { x: 11, y: 22, width: 333, height: 444, scale: 2 } };
  assert.deepEqual(await cdp("Page.captureScreenshot", options), { data: "original-image" });
  assert.deepEqual(calls.map(([method]) => method), ["Page.enable", "Page.startScreencast", "Page.screencastFrameAck", "Page.captureScreenshot", "Page.stopScreencast"]);
  assert.deepEqual(calls[3][2], options);
  assert.equal(listeners.size, 0);
});

test("frame timeout stops its stream, removes the listener and never dispatches capture", async () => {
  const { attach, cdp, calls, listeners } = await loadBackend({ frames: false });
  await attach();
  await assert.rejects(cdp("Page.captureScreenshot", {}, { timeoutMs: 20 }), /Timed out/);
  await tick();
  assert.equal(listeners.size, 0);
  assert.ok(calls.some(([method]) => method === "Page.stopScreencast"));
  assert.equal(calls.some(([method]) => method === "Page.captureScreenshot"), false);
});

test("a late start completion is cleaned up after timeout without taking a screenshot", async () => {
  const start = defer();
  const { attach, cdp, calls, listeners } = await loadBackend({ command: (method) => method === "Page.startScreencast" ? start.promise : undefined });
  await attach();
  await assert.rejects(cdp("Page.captureScreenshot", {}, { timeoutMs: 20 }), /Timed out/);
  await tick();
  start.resolve({});
  await tick();
  assert.equal(listeners.size, 0);
  assert.equal(calls.filter(([method]) => method === "Page.stopScreencast").length, 1);
  assert.equal(calls.some(([method]) => method === "Page.captureScreenshot"), false);
});

test("concurrent screenshots serialize their temporary streams and expire queued work", async () => {
  const { attach, cdp, calls, listeners } = await loadBackend({ frames: false });
  await attach();
  const first = cdp("Page.captureScreenshot", {}, { timeoutMs: 35 });
  const second = cdp("Page.captureScreenshot", {}, { timeoutMs: 15 });
  const results = await Promise.allSettled([first, second]);
  assert.ok(results.every((result) => result.status === "rejected"));
  await tick();
  assert.equal(calls.filter(([method]) => method === "Page.startScreencast").length, 1);
  assert.equal(listeners.size, 0);
});

test("caller-owned screencasts remain running through screenshots", async () => {
  const { attach, cdp, calls, backend } = await loadBackend();
  await attach();
  await cdp("Page.startScreencast", { format: "jpeg" });
  calls.length = 0;
  await cdp("Page.captureScreenshot");
  assert.deepEqual(calls.map(([method]) => method), ["Page.captureScreenshot"]);
  assert.ok(backend.externalScreencastTabs.has(7));
  await cdp("Page.stopScreencast");
  assert.equal(backend.externalScreencastTabs.has(7), false);
});

test("an old screenshot cannot consume a new attachment's frame or stop its stream", async () => {
  const { backend, attach, cdp, calls, emit } = await loadBackend({ frames: false });
  await attach();
  const pending = cdp("Page.captureScreenshot", {}, { timeoutMs: 30 });
  await tick();
  backend.releaseEngineAttachment(7);
  await attach();
  emit();
  await assert.rejects(pending, /cancelled because tab control ended/);
  await tick();
  assert.equal(calls.some(([method]) => method === "Page.captureScreenshot"), false);
  assert.equal(calls.some(([method]) => method === "Page.stopScreencast"), false);
});

test("capture errors retain their identity while temporary stream cleanup still runs", async () => {
  const failure = new Error("Invalid clip");
  const { attach, cdp, calls, listeners } = await loadBackend({ command: (method) => {
    if (method === "Page.captureScreenshot") throw failure;
  } });
  await attach();
  await assert.rejects(cdp("Page.captureScreenshot"), (error) => error === failure);
  assert.equal(calls.at(-1)[0], "Page.stopScreencast");
  assert.equal(listeners.size, 0);
});

test("the shared screenshot lease stays live until the Playwright operation settles", async () => {
  const { backend, attach, calls, emit, listeners } = await loadBackend();
  const completion = defer();
  const result = { base64: "playwright-image", mimeType: "image/png" };
  await attach();
  let ran = false;
  const pending = backend.withRenderingLease({ tabId: 7 }, 250, async () => {
    ran = true;
    return completion.promise;
  });
  await tick();
  assert.equal(ran, true);
  assert.equal(backend.internalScreencasts.get(7).active, true);
  assert.equal(calls.some(([method]) => method === "Page.stopScreencast"), false);
  emit();
  await tick();
  assert.equal(calls.filter(([method]) => method === "Page.screencastFrameAck").length, 2);
  completion.resolve(result);
  assert.equal(await pending, result);
  assert.equal(calls.at(-1)[0], "Page.stopScreencast");
  assert.equal(listeners.size, 0);
});

test("shared lease timeout is identifiable, bounded and releases capture resources", async () => {
  const { backend, attach, calls, listeners } = await loadBackend();
  await attach();
  await assert.rejects(backend.withRenderingLease({ tabId: 7 }, 20, () => new Promise(() => {})), error => {
    assert.equal(error.name, "TimeoutError");
    assert.match(error.message, /running rendered action/);
    return true;
  });
  await tick();
  assert.equal(calls.at(-1)[0], "Page.stopScreencast");
  assert.equal(listeners.size, 0);
});

test("detach cancels an in-flight screenshot lease and removes its listener immediately", async () => {
  const { backend, attach, calls, listeners } = await loadBackend();
  const completion = defer();
  await attach();
  const pending = backend.withRenderingLease({ tabId: 7 }, 500, () => completion.promise);
  const rejected = assert.rejects(pending, /cancelled because tab control ended/);
  await tick();
  backend.releaseEngineAttachment(7);
  assert.equal(listeners.size, 0);
  await attach();
  await rejected;
  assert.equal(calls.some(([method]) => method === "Page.stopScreencast"), false);
  completion.resolve("abandoned-image");
});

test("raw and engine captures share the same per-tab screenshot queue", async () => {
  const { backend, attach, cdp, calls } = await loadBackend();
  const completion = defer();
  await attach();
  const first = backend.withRenderingLease({ tabId: 7 }, 250, () => completion.promise);
  await tick();
  const second = cdp("Page.captureScreenshot");
  await tick();
  assert.equal(calls.filter(([method]) => method === "Page.startScreencast").length, 1);
  completion.resolve("playwright-image");
  await Promise.all([first, second]);
  const methods = calls.map(([method]) => method);
  assert.equal(methods.filter(method => method === "Page.startScreencast").length, 2);
  assert.ok(methods.indexOf("Page.stopScreencast") < methods.lastIndexOf("Page.startScreencast"));
});

test("browserAction enforces ownership and preserves the action engine response", async () => {
  const { backend } = await loadBackend();
  const requests = [];
  const result = { value: ["one", "two"], engine: { name: "test-engine" } };
  backend.browserEngine = { async dispatch(params) { requests.push(params); return result; } };
  const request = { ...session, tabId: 7, action: "allTextContents", locator: [{ kind: "css", selector: "li" }] };
  await assert.rejects(backend.browserAction({ ...request, tabId: 99 }), /not part/);
  assert.equal(requests.length, 0);
  assert.equal(await backend.browserAction(request), result);
  assert.equal(requests[0], request);
});

test("turnEnded waits for action cancellation before releasing native tab control", async () => {
  const { backend, attach, calls } = await loadBackend();
  const cancellation = defer();
  await attach();
  backend.browserEngine = {
    async detach(tabId) { calls.push(["engine.detach", tabId]); await cancellation.promise; backend.releaseEngineAttachment(tabId); }
  };
  let ended = false;
  const pending = backend.turnEnded(session).then(() => { ended = true; });
  await tick();
  assert.equal(ended, false);
  assert.equal(calls.some(([method]) => method === "detach"), false);
  cancellation.resolve();
  await pending;
  assert.equal(ended, true);
  assert.equal(backend.attachedTabs.has(7), false);
  assert.ok(calls.findIndex(([method]) => method === "engine.detach") < calls.findIndex(([method]) => method === "detach"));
});

test("failed action engine cancellation still attempts native detach and releases ownership", async () => {
  const { backend, attach, calls } = await loadBackend();
  const failure = new Error("Pending engine attachment failed");
  await attach();
  backend.browserEngine = { async detach() { throw failure; } };
  await assert.rejects(backend.detachTab(7), (error) => error === failure);
  assert.equal(calls.at(-1)[0], "detach");
  assert.equal(backend.attachedTabs.has(7), false);
});

test("a successor raw attachment waits for both engine and native cleanup", async () => {
  const nativeRelease = defer();
  const { backend, attach, calls } = await loadBackend({ detach: () => nativeRelease.promise });
  await attach();
  backend.browserEngine = {
    async detach(tabId) { backend.releaseEngineAttachment(tabId); },
    async attach(tabId) { calls.push(["engine.attach", tabId]); await backend.registerEngineAttachment(tabId); }
  };
  const stopping = backend.detachTab(7);
  await tick();
  const successor = attach();
  await tick();
  assert.equal(calls.some(([method]) => method === "engine.attach"), false);
  nativeRelease.resolve();
  await Promise.all([stopping, successor]);
  assert.equal(calls.filter(([method]) => method === "engine.attach").length, 1);
  assert.equal(backend.attachedTabs.has(7), true);
});

test("a successor browser action waits for native cleanup without losing its new attachment", async () => {
  const nativeRelease = defer();
  const { backend, attach, calls } = await loadBackend({ detach: () => nativeRelease.promise });
  await attach();
  backend.browserEngine = {
    async detach(tabId) { backend.releaseEngineAttachment(tabId); },
    async dispatch() { calls.push(["engine.dispatch"]); return { value: "new action" }; }
  };
  const stopping = backend.detachTab(7);
  await tick();
  const successor = backend.browserAction({ ...session, tabId: 7, action: "snapshot" });
  await tick();
  assert.equal(calls.some(([method]) => method === "engine.dispatch"), false);
  nativeRelease.resolve();
  assert.deepEqual(await successor, { value: "new action" });
  await stopping;
});

test("ending control during lazy engine loading cannot dispatch the abandoned action", async () => {
  const { backend } = await loadBackend();
  const loading = defer();
  backend.getBrowserEngine = () => loading.promise;
  let dispatched = false;
  const request = backend.browserAction({ ...session, tabId: 7, action: "snapshot" });
  await tick();
  await backend.detachTab(7);
  loading.resolve({ dispatch() { dispatched = true; } });
  await assert.rejects(request, /cancelled while loading/);
  assert.equal(dispatched, false);
});

test("browser detach invalidates action engine state as well as raw ownership", async () => {
  const { backend, attach, detachListener } = await loadBackend();
  await attach();
  const forgotten = [];
  backend.browserEngine = { forget(tabId) { forgotten.push(tabId); } };
  detachListener();
  assert.deepEqual(forgotten, [7]);
  assert.equal(backend.attachedTabs.has(7), false);
});

test("internal bootstrap frames stay off the native pipe, including late encoded frames", async () => {
  const { backend } = await loadBackend();
  const stream = { active: true, frameIds: [] };
  backend.internalScreencasts.set(7, stream);
  assert.equal(backend.isInternalCdpEvent({ tabId: 7 }, "Page.screencastFrame", { sessionId: 42 }), true);
  stream.active = false;
  assert.equal(backend.isInternalCdpEvent({ tabId: 7 }, "Page.screencastFrame", { sessionId: 42 }), true);
  assert.equal(backend.isInternalCdpEvent({ tabId: 7 }, "Page.screencastFrame", { sessionId: 43 }), false);
  assert.equal(backend.isInternalCdpEvent({ tabId: 7, sessionId: "child" }, "Page.screencastFrame", { sessionId: 42 }), false);
  backend.externalScreencastTabs.add(7);
  assert.equal(backend.isInternalCdpEvent({ tabId: 7 }, "Page.screencastFrame", { sessionId: 42 }), false);
});
