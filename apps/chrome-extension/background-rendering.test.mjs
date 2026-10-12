import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import vm from "./test-support/backend-vm.mjs";
import { BrowserActionEngine } from "./browser-action-engine.js";

const source = (await readFile(new URL("./background.js", import.meta.url), "utf8")).replace('import { createBrowserActionEngine } from "./browser-runtime.js";', "").replace('import { NativeInputTracker } from "./browser-input-adapter.js";', (await readFile(new URL("./browser-input-adapter.js", import.meta.url), "utf8")).replace(/^export /gm, "") + "\nglobalThis.performance ??= { now: () => Date.now() };");
const runtimeStart = source.indexOf("chrome.runtime.onInstalled.addListener");
assert.notEqual(runtimeStart, -1);
const session = { session_id: "render-test", turn_id: "turn-1" };
const json = (value) => JSON.parse(JSON.stringify(value));
const defer = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function loadBackend({ attachError, command, detach, frames = true, engineFactory } = {}) {
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
      async getTargets() { return [{ id: "target-7", tabId: 7, url: "https://fixture.test" }]; },
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
    chrome, Date, setTimeout, clearTimeout, createBrowserActionEngine: engineFactory
  });
  const backend = new BrowserBackend();
  await backend.store.ready;
  (await backend.store.getSession(session.session_id)).chromeGroupId = 10;
  const attach = () => backend.attach({ ...session, tabId: 7 });
  const cdp = (method, commandParams = {}, extra = {}) => backend.executeCdp({
    ...session, target: { tabId: 7 }, method, commandParams, timeoutMs: 250, ...extra
  });
  return { backend, attach, cdp, calls, emit, listeners, chrome, detachListener: () => detachListener({ tabId: 7 }) };
}

// Exercise the pinned Playwright abort race, not a substitute timeout wrapper.
const require = createRequire(import.meta.url);
const upstreamDirectory = path.dirname(require.resolve("playwright-crx/package.json"));
const upstreamEntry = await readFile(path.join(upstreamDirectory, "lib/index.mjs"), "utf8");
const upstreamChunk = /from ["']\.\/([^"']+\.mjs)/.exec(upstreamEntry)[1];
const upstream = await readFile(path.join(upstreamDirectory, "lib", upstreamChunk), "utf8");
const progressStart = "class ProgressController {", progressEnd = "const fileUploadSizeLimit$1 =";
assert.equal(upstream.split(progressStart).length, 2);
assert.equal(upstream.split(progressEnd).length, 2);
class ManualPromise extends Promise {
  constructor() { let resolve, reject; super((yes, no) => { resolve = yes; reject = no; }); this.resolve = resolve; this.reject = reject; }
  static get [Symbol.species]() { return Promise; }
}
class NativeTimeoutError extends Error { constructor(message) { super(message); this.name = "TimeoutError"; } }
const ProgressController = vm.runInNewContext(`${upstream.slice(upstream.indexOf(progressStart), upstream.indexOf(progressEnd))}\nProgressController;`, {
  assert, ManualPromise, TimeoutError$1: NativeTimeoutError, monotonicTime: () => performance.now(), setTimeout, clearTimeout
});

async function engineCaptureFixture() {
  const capture = defer(), entered = defer();
  let hooks, controller, captures = 0;
  const page = {
    on() {}, off() {},
    async screenshot(options) {
      controller = new ProgressController({ log: [] }, { instrumentation: { onCallLog() {} }, attribution: { context: { _activeProgressControllers: new Set() } } });
      return controller.run(() => hooks.send({ tabId: 7 }, "Page.captureScreenshot", { format: "png" }, () => {
        captures++; entered.resolve(); return captures === 1 ? capture.promise : Promise.resolve(Buffer.from("successor image"));
      }), options.timeout);
    }
  };
  const runtime = {
    crx: { start: async () => ({ attach: async () => page, detach: async () => {} }) },
    setOpenBrowserUseInputHooks(value) { hooks = value; }, setOpenBrowserUseEventFilter() {}, setOpenBrowserUseCommandObserver() {}, assertOpenBrowserUseSelector() {}
  };
  const f = await loadBackend({ engineFactory: options => new BrowserActionEngine({ ...options, loadRuntime: async () => runtime }) });
  f.chrome.tabs.get = async () => ({ id: 7, groupId: 10, url: "https://fixture.test", incognito: false });
  const previousChrome = globalThis.chrome; globalThis.chrome = f.chrome;
  await f.backend.attach({ ...session, tabId: 7 });
  const engine = await f.backend.getBrowserEngine(); await engine.attach(7);
  return { ...f, capture, entered, page, engine, send: (...args) => hooks.send(...args), captureCount: () => captures, abort: error => controller.abort(error), restore: () => { globalThis.chrome = previousChrome; } };
}

test("a CRX screenshot cannot send without a currently accepting rendering lease", async () => {
  const f = await engineCaptureFixture();
  try {
    let sent = false;
    assert.throws(() => f.send({ tabId: 7 }, "Page.captureScreenshot", {}, () => { sent = true; }), /requires an active rendering lease/);
    assert.equal(sent, false);
    assert.equal(f.backend.renderingDrains.size, 0);
    // Non-screenshot commands keep their ordinary admission and response path.
    assert.equal(await f.send({ tabId: 7 }, "Runtime.evaluate", {}, () => "ordinary result"), "ordinary result");
  } finally { f.restore(); }
});

for (const external of [false, true]) test(`real engine and pinned Progress abort retain actual CRX screenshot in the original lease and Pause drain (${external ? "caller-owned" : "internal"} stream)`, async () => {
  const f = await engineCaptureFixture();
  try {
    if (external) await f.cdp("Page.startScreencast", { format: "jpeg" });
    const failure = new NativeTimeoutError("pinned screenshot progress expired");
    const action = f.backend.browserAction({ ...session, tabId: 7, action: "screenshot", timeoutMs: 2000 });
    const rejected = assert.rejects(action, error => error === failure);
    await f.entered.promise;
    const original = f.backend.renderingQueues.get(7);
    f.abort(failure); await rejected; await tick();
    assert.ok(f.backend.renderingDrains.has(original), "the original lease must retain the native command after Playwright aborts");
    assert.equal(f.calls.filter(([method]) => method === "Page.stopScreencast").length, 0);
    let paused = false;
    const pause = f.backend.pauseAutomation().then(result => { paused = true; return result; });
    await tick(); assert.equal(paused, false);
    f.capture.resolve(Buffer.from("native image"));
    assert.equal((await pause).cleanupComplete, true);
    assert.equal(f.backend.renderingDrains.size, 0);
    assert.equal(f.captureCount(), 1);
  } finally { f.capture.resolve(Buffer.from("native image")); f.restore(); }
});

test("a CRX screenshot awaiting a restricted proof cannot send after its original Progress aborted", async () => {
  const f = await engineCaptureFixture(), proof = defer(), proofEntered = defer();
  try {
    // Install the asynchronous native-send proof only after ordinary admission.
    const originalScreenshot = f.page.screenshot;
    f.page.screenshot = options => {
      Object.defineProperty(f.backend.siteAccess, "restricted", { value: true });
      f.backend.assertSiteTab = () => { proofEntered.resolve(); return proof.promise; };
      f.backend.assertSiteProof = () => {};
      return originalScreenshot(options);
    };
    const action = f.backend.browserAction({ ...session, tabId: 7, action: "screenshot", timeoutMs: 2000 });
    const originalAttachment = f.backend.attachmentEpochs.get(7);
    const failure = new Error("pinned screenshot progress aborted during proof");
    const rejected = assert.rejects(action, error => error === failure);
    await proofEntered.promise;
    const original = f.backend.renderingQueues.get(7);
    f.abort(failure); await rejected;
    assert.ok(f.backend.renderingDrains.has(original));
    assert.equal(f.backend.attachmentEpochs.get(7), originalAttachment, "the lease guard must work without engine timeout detaching this attachment");
    proof.resolve({}); await tick(); await tick();
    let nativeSent = false; f.entered.promise.then(() => { nativeSent = true; }); await tick();
    assert.equal(nativeSent, false);
    assert.equal(f.backend.renderingDrains.size, 0);
  } finally { proof.resolve({}); f.capture.resolve(Buffer.from("native image")); f.restore(); }
});

test("a real-engine successor lease is independent of the aborted Progress command's original native capture", async () => {
  const f = await engineCaptureFixture();
  try {
    const action = f.backend.browserAction({ ...session, tabId: 7, action: "screenshot", timeoutMs: 2000 });
    const failure = new NativeTimeoutError("old screenshot progress expired");
    const rejected = assert.rejects(action, error => error === failure);
    await f.entered.promise;
    const original = f.backend.renderingQueues.get(7), oldAttachment = f.backend.attachmentEpochs.get(7);
    f.abort(failure); await rejected;
    const successor = await f.backend.browserAction({ ...session, tabId: 7, action: "screenshot", timeoutMs: 1000 });
    assert.equal(successor.value.base64, Buffer.from("successor image").toString("base64"));
    const newAttachment = f.backend.attachmentEpochs.get(7);
    assert.notEqual(newAttachment, oldAttachment);
    assert.ok(f.backend.renderingDrains.has(original));
    await f.cdp("Page.startScreencast", { format: "jpeg" });
    const stops = f.calls.filter(([method]) => method === "Page.stopScreencast").length;
    f.capture.resolve(Buffer.from("old image")); await tick(); await tick();
    assert.equal(f.backend.renderingDrains.size, 0);
    assert.equal(f.backend.attachmentEpochs.get(7), newAttachment);
    assert.equal(f.backend.externalScreencastTabs.has(7), true);
    assert.equal(f.calls.filter(([method]) => method === "Page.stopScreencast").length, stops);
    assert.equal(f.captureCount(), 2);
    await f.cdp("Page.stopScreencast");
  } finally { f.capture.resolve(Buffer.from("native image")); f.restore(); }
});

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

test("shared lease timeout is bounded and removes listeners while actual capture continues draining", async () => {
  const { backend, attach, calls, listeners } = await loadBackend();
  const completion = defer();
  await attach();
  try {
    await assert.rejects(backend.withRenderingLease({ tabId: 7 }, 20, () => backend.trackRenderingCapture(backend.attachmentEpochs.get(7), () => completion.promise)), error => {
      assert.equal(error.name, "TimeoutError");
      assert.match(error.message, /running rendered action/);
      return true;
    });
    assert.equal(listeners.size, 0);
    assert.equal(backend.renderingDrains.size, 2);
    assert.equal(calls.some(([method]) => method === "Page.stopScreencast"), false);
  } finally {
    completion.resolve("abandoned-image");
  }
  await tick();
  assert.equal(calls.at(-1)[0], "Page.stopScreencast");
  assert.equal(backend.renderingDrains.size, 0);
});

for (const external of [false, true]) {
  test(`a timed-out capture retains actual rendering exclusion (${external ? "caller-owned" : "internal"} stream)`, async () => {
    const entered = defer(), completion = defer();
    const { backend, attach, cdp, calls } = await loadBackend({ command: method => {
      if (method === "Page.captureScreenshot") { entered.resolve(); return completion.promise; }
    } });
    await attach();
    if (external) await cdp("Page.startScreencast", { format: "jpeg" });
    const capture = assert.rejects(cdp("Page.captureScreenshot", {}, { timeoutMs: 25 }), /Timed out/);
    await entered.promise;
    const originalTail = backend.renderingQueues.get(7);
    let next;
    try {
      await capture;
      await tick();
      const stops = calls.filter(([method]) => method === "Page.stopScreencast").length;
      next = Promise.allSettled([cdp("Page.stopScreencast", {}, { timeoutMs: 1000 })]);
      await tick();
      assert.equal(backend.renderingDrains.has(originalTail), true, "an expired observer cannot retire the real native capture");
      assert.ok(backend.globalControlSnapshot().pending.includes(originalTail));
      assert.equal(calls.filter(([method]) => method === "Page.stopScreencast").length, stops, "a later stream mutation must not overlap the original capture");
      assert.equal(calls.filter(([method]) => method === "Page.captureScreenshot").length, 1, "timeout must not replay capture");
    } finally {
      completion.resolve({ data: "late-original-image" });
      await capture;
      if (next) assert.equal((await next)[0].status, "fulfilled");
      await tick();
    }
    assert.equal(backend.renderingDrains.has(originalTail), false);
  });

  test(`Pause waits for a timed-out capture's actual settlement (${external ? "caller-owned" : "internal"} stream)`, async () => {
    const entered = defer(), completion = defer();
    const { backend, attach, cdp } = await loadBackend({ command: method => {
      if (method === "Page.captureScreenshot") { entered.resolve(); return completion.promise; }
    } });
    await attach();
    if (external) await cdp("Page.startScreencast", { format: "jpeg" });
    const capture = assert.rejects(cdp("Page.captureScreenshot", {}, { timeoutMs: 25 }), /Timed out/);
    await entered.promise;
    const originalTail = backend.renderingQueues.get(7);
    await capture;
    await tick();
    let pauseSettled = false;
    const pause = backend.pauseAutomation().finally(() => { pauseSettled = true; });
    const result = Promise.allSettled([pause]);
    try {
      await tick(); await tick();
      assert.equal(pauseSettled, false, "Pause cannot report cleanup complete before native capture settles");
      assert.equal(backend.renderingDrains.has(originalTail), true);
    } finally {
      completion.resolve({ data: "late-original-image" });
      const [finished] = await result;
      assert.equal(finished.status, "fulfilled");
      assert.equal(finished.value.state, "paused");
      assert.equal(finished.value.cleanupComplete, true);
    }
    assert.equal(backend.renderingDrains.size, 0);
  });

  test(`Pause stays failed until an unresolved capture really rejects (${external ? "caller-owned" : "internal"} stream)`, async () => {
    const entered = defer();
    let rejectNative;
    const native = new Promise((_, reject) => { rejectNative = reject; });
    const { backend, attach, cdp, calls } = await loadBackend({ command: method => {
      if (method === "Page.captureScreenshot") { entered.resolve(); return native; }
    } });
    await attach();
    if (external) await cdp("Page.startScreencast", { format: "jpeg" });
    const capture = assert.rejects(cdp("Page.captureScreenshot", {}, { timeoutMs: 25 }), /Timed out/);
    await entered.promise;
    const originalTail = backend.renderingQueues.get(7);
    await capture;
    backend.automationCleanupTimeoutMs = 25;
    try {
      await assert.rejects(backend.pauseAutomation(), /OBU_AUTOMATION_CLEANUP_TIMEOUT/);
      const failed = await backend.getAutomationControlStatus();
      assert.equal(failed.state, "error");
      assert.equal(failed.inputBlocked, true);
      assert.equal(failed.cleanupComplete, false);
      assert.equal(backend.renderingDrains.has(originalTail), true);
    } finally {
      rejectNative(new Error("native capture failed after caller timeout"));
      await tick();
    }
    backend.automationCleanupTimeoutMs = 1000;
    const retried = await backend.pauseAutomation();
    assert.equal(retried.state, "paused");
    assert.equal(retried.cleanupComplete, true);
    assert.equal(backend.renderingDrains.size, 0);
    assert.equal(calls.filter(([method]) => method === "Page.captureScreenshot").length, 1, "Retry Pause cannot repeat the screenshot");
  });
}

test("confirmed detach lets a successor render while the original capture still drains", async () => {
  const entered = defer(), completion = defer();
  let captures = 0;
  const { backend, attach, cdp, calls } = await loadBackend({ command: method => {
    if (method === "Page.captureScreenshot" && ++captures === 1) { entered.resolve(); return completion.promise; }
  } });
  await attach();
  const capture = assert.rejects(cdp("Page.captureScreenshot", {}, { timeoutMs: 25 }), /Timed out/);
  await entered.promise;
  const oldTail = backend.renderingQueues.get(7);
  await capture;
  await backend.detach({ ...session, tabId: 7 });
  await attach();
  const successor = backend.attachmentEpochs.get(7);
  try {
    assert.deepEqual(await cdp("Page.captureScreenshot"), { data: "original-image" });
    await cdp("Page.startScreencast", { format: "jpeg" });
    assert.equal(backend.renderingDrains.has(oldTail), true);
    const stops = calls.filter(([method]) => method === "Page.stopScreencast").length;
    completion.resolve({ data: "late-original-image" });
    await tick();
    assert.equal(backend.renderingDrains.has(oldTail), false);
    assert.equal(backend.attachmentEpochs.get(7), successor);
    assert.equal(backend.externalScreencastTabs.has(7), true);
    assert.equal(calls.filter(([method]) => method === "Page.stopScreencast").length, stops, "old completion must not stop the successor's stream");
  } finally {
    completion.resolve({ data: "late-original-image" });
    await cdp("Page.stopScreencast");
  }
});

test("detach cancels an in-flight screenshot lease and removes its listener immediately", async () => {
  const { backend, attach, calls, listeners } = await loadBackend();
  const completion = defer();
  await attach();
  const pending = backend.withRenderingLease({ tabId: 7 }, 500, () => backend.trackRenderingCapture(backend.attachmentEpochs.get(7), () => completion.promise));
  const rejected = assert.rejects(pending, /cancelled because tab control ended/);
  await tick();
  backend.releaseEngineAttachment(7);
  assert.equal(listeners.size, 0);
  assert.equal(backend.renderingDrains.size, 2, "caller cancellation does not settle the rendering operation or its registered capture");
  await attach();
  await rejected;
  assert.equal(calls.some(([method]) => method === "Page.stopScreencast"), false);
  completion.resolve("abandoned-image");
  await tick();
  assert.equal(backend.renderingDrains.size, 0);
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

test("raw screencast mutations cannot replace a running internal lease's stream", async () => {
  const entered = defer(), completion = defer();
  let nativeStream = null;
  const { backend, attach, cdp, calls } = await loadBackend({ command: (method, params) => {
    if (method === "Page.startScreencast") {
      if (nativeStream) throw new Error("Screencast is already active");
      nativeStream = params.format;
    }
    if (method === "Page.stopScreencast") nativeStream = null;
    if (method === "Page.captureScreenshot") { entered.resolve(); return completion.promise; }
  } });
  await attach();
  const attachment = backend.attachmentEpochs.get(7);
  const capture = cdp("Page.captureScreenshot", {}, { timeoutMs: 1000 });
  await entered.promise;
  const stop = cdp("Page.stopScreencast", {}, { timeoutMs: 1000, target: { targetId: "target-7" } });
  const restart = stop.then(() => cdp("Page.startScreencast", { format: "jpeg" }, { timeoutMs: 1000 }));
  // Allow both public requests to pass their asynchronous authorization checks.
  await tick();
  const whileCapturing = { nativeStream, stops: calls.filter(([method]) => method === "Page.stopScreencast").length };
  completion.resolve({ data: "original-image" });
  const results = await Promise.allSettled([capture, stop, restart]);
  assert.ok(results.every(result => result.status === "fulfilled"));
  assert.equal(backend.attachmentEpochs.get(7), attachment);
  assert.equal(whileCapturing.nativeStream, "png", "raw stop/start must wait for the original rendering operation");
  assert.equal(whileCapturing.stops, 0);
  assert.equal(nativeStream, "jpeg", "the old lease must not stop the later caller-owned stream");
  assert.equal(backend.externalScreencastTabs.has(7), true);
  await cdp("Page.stopScreencast");
});

test("raw screencast queued timeout cannot send a late stop after a rendering lease", async () => {
  const entered = defer(), completion = defer();
  const { attach, cdp, calls } = await loadBackend({ command: method => {
    if (method === "Page.captureScreenshot") { entered.resolve(); return completion.promise; }
  } });
  await attach();
  const capture = cdp("Page.captureScreenshot", {}, { timeoutMs: 1000 });
  await entered.promise;
  const stop = cdp("Page.stopScreencast", {}, { timeoutMs: 15 });
  const [result] = await Promise.allSettled([stop]);
  const stopsBeforeCompletion = calls.filter(([method]) => method === "Page.stopScreencast").length;
  completion.resolve({ data: "original-image" });
  await capture;
  await tick();
  assert.equal(result.status, "rejected", "the caller's original budget must include the rendering queue");
  assert.match(result.reason.message, /timed out|expired/i);
  assert.equal(stopsBeforeCompletion, 0);
  assert.equal(calls.filter(([method]) => method === "Page.stopScreencast").length, 1, "only the internal owner's cleanup may stop its stream");
});

test("raw screencast frame ACK is not blocked behind a rendering lease", async () => {
  const entered = defer(), completion = defer();
  const { attach, cdp, calls } = await loadBackend({ command: method => {
    if (method === "Page.captureScreenshot") { entered.resolve(); return completion.promise; }
  } });
  await attach();
  const capture = cdp("Page.captureScreenshot", {}, { timeoutMs: 1000 });
  await entered.promise;
  try {
    await cdp("Page.screencastFrameAck", { sessionId: 73 }, { timeoutMs: 50 });
    assert.ok(calls.some(([method, , params]) => method === "Page.screencastFrameAck" && params.sessionId === 73));
  } finally {
    completion.resolve({ data: "original-image" });
    await capture;
  }
});

test("external stream ACKs and unrelated or child commands bypass its active rendering lease", async () => {
  const entered = defer(), completion = defer();
  const { backend, attach, cdp, calls } = await loadBackend({ command: method => {
    if (method === "Page.captureScreenshot") { entered.resolve(); return completion.promise; }
  } });
  await attach();
  await cdp("Page.startScreencast", { format: "jpeg" });
  const capture = cdp("Page.captureScreenshot", {}, { timeoutMs: 1000 });
  await entered.promise;
  try {
    await cdp("Page.screencastFrameAck", { sessionId: 73 }, { timeoutMs: 100 });
    await cdp("Runtime.evaluate", { expression: "1" }, { timeoutMs: 100 });
    await cdp("Page.stopScreencast", {}, { target: { tabId: 7, sessionId: "child-session" }, timeoutMs: 100 });
    assert.ok(calls.some(([method, target]) => method === "Page.stopScreencast" && target.sessionId === "child-session"));
    assert.equal(backend.externalScreencastTabs.has(7), true, "a child command cannot update root stream ownership");
  } finally {
    completion.resolve({ data: "original-image" });
    await capture;
    await cdp("Page.stopScreencast");
  }
});

test("a timed-out raw start holds the queue until its real ACK and records the still-live external stream", async () => {
  const start = defer(), entered = defer();
  let nativeStream = null;
  const { backend, attach, cdp, calls } = await loadBackend({ command: (method, params) => {
    if (method === "Page.startScreencast") {
      if (nativeStream) throw new Error("Screencast is already active");
      nativeStream = params.format;
      if (params.format === "jpeg") { entered.resolve(); return start.promise; }
    }
    if (method === "Page.stopScreencast") nativeStream = null;
  } });
  await attach();
  const pending = assert.rejects(cdp("Page.startScreencast", { format: "jpeg" }, { timeoutMs: 20 }), /Timed out/);
  await entered.promise;
  await pending;
  assert.equal(backend.externalScreencastTabs.has(7), false, "an unacknowledged native operation is still pending");
  const capture = cdp("Page.captureScreenshot", {}, { timeoutMs: 1000 });
  const result = Promise.allSettled([capture]);
  await tick();
  const beforeACK = calls.map(([method]) => method);
  start.resolve({});
  const [completed] = await result;
  assert.equal(beforeACK.filter(method => method === "Page.startScreencast").length, 1);
  assert.equal(beforeACK.includes("Page.captureScreenshot"), false);
  assert.equal(completed.status, "fulfilled");
  assert.deepEqual(completed.value, { data: "original-image" });
  assert.equal(backend.externalScreencastTabs.has(7), true);
  assert.equal(nativeStream, "jpeg");
  assert.equal(calls.filter(([method]) => method === "Page.startScreencast").length, 1);
  await cdp("Page.stopScreencast");
});

test("a timed-out raw stop retains stream exclusion until the native stop settles", async () => {
  const stop = defer(), entered = defer();
  let stops = 0;
  const { backend, attach, cdp, calls } = await loadBackend({ command: method => {
    if (method === "Page.stopScreencast" && ++stops === 1) { entered.resolve(); return stop.promise; }
  } });
  await attach();
  await cdp("Page.startScreencast", { format: "jpeg" });
  const pending = assert.rejects(cdp("Page.stopScreencast", {}, { timeoutMs: 20 }), /Timed out/);
  await entered.promise;
  await pending;
  const capture = cdp("Page.captureScreenshot", {}, { timeoutMs: 1000 });
  const result = Promise.allSettled([capture]);
  await tick();
  const capturesBeforeACK = calls.filter(([method]) => method === "Page.captureScreenshot").length;
  stop.resolve({});
  assert.equal((await result)[0].status, "fulfilled");
  assert.equal(capturesBeforeACK, 0);
  assert.equal(backend.externalScreencastTabs.has(7), false);
  assert.equal(calls.filter(([method]) => method === "Page.startScreencast").length, 2);
  assert.equal(calls.filter(([method]) => method === "Page.stopScreencast").length, 2);
});

test("an internal late start is stopped before a queued caller-owned stream starts", async () => {
  const start = defer(), entered = defer();
  const { backend, attach, cdp, calls, listeners } = await loadBackend({ command: (method, params) => {
    if (method === "Page.startScreencast" && params.format === "png") { entered.resolve(); return start.promise; }
  } });
  await attach();
  const capture = assert.rejects(cdp("Page.captureScreenshot", {}, { timeoutMs: 20 }), /Timed out/);
  await entered.promise;
  await capture;
  assert.equal(listeners.size, 0, "RPC timeout still removes the frame listener immediately");
  const external = cdp("Page.startScreencast", { format: "jpeg" }, { timeoutMs: 1000 });
  const result = Promise.allSettled([external]);
  await tick();
  const startsBeforeACK = calls.filter(([method]) => method === "Page.startScreencast").length;
  start.resolve({});
  assert.equal((await result)[0].status, "fulfilled");
  assert.equal(startsBeforeACK, 1);
  const methods = calls.map(([method]) => method);
  assert.ok(methods.indexOf("Page.stopScreencast") < methods.lastIndexOf("Page.startScreencast"));
  assert.equal(methods.filter(method => method === "Page.stopScreencast").length, 1);
  assert.equal(methods.includes("Page.captureScreenshot"), false);
  assert.equal(backend.externalScreencastTabs.has(7), true);
  await cdp("Page.stopScreencast");
});

test("an internal stop's real lifetime outlasts its former one-second cleanup observer", async () => {
  const stop = defer(), entered = defer();
  let stops = 0;
  const { backend, attach, cdp, calls } = await loadBackend({ command: method => {
    if (method === "Page.stopScreencast" && ++stops === 1) { entered.resolve(); return stop.promise; }
  } });
  await attach();
  const capture = assert.rejects(cdp("Page.captureScreenshot", {}, { timeoutMs: 20 }), /Timed out/);
  await entered.promise;
  await capture;
  const external = cdp("Page.startScreencast", { format: "jpeg" }, { timeoutMs: 3000 });
  const result = Promise.allSettled([external]);
  await new Promise(resolve => setTimeout(resolve, 1050));
  const startsBeforeACK = calls.filter(([method]) => method === "Page.startScreencast").length;
  stop.resolve({});
  assert.equal((await result)[0].status, "fulfilled");
  assert.equal(startsBeforeACK, 1, "the one-second observer must not release native stream ownership");
  assert.equal(backend.externalScreencastTabs.has(7), true);
  await cdp("Page.stopScreencast");
});

test("a queued raw mutation cannot cross a revoked original tab control epoch", async () => {
  const entered = defer(), completion = defer();
  const { backend, attach, cdp, calls } = await loadBackend({ command: method => {
    if (method === "Page.captureScreenshot") { entered.resolve(); return completion.promise; }
  } });
  await attach();
  const capture = cdp("Page.captureScreenshot", {}, { timeoutMs: 1000 });
  await entered.promise;
  const stop = cdp("Page.stopScreencast", {}, { timeoutMs: 1000 });
  const result = Promise.allSettled([stop]);
  await tick();
  backend.controlEpochs.set(7, (backend.controlEpochs.get(7) ?? 0) + 1);
  completion.resolve({ data: "original-image" });
  await capture;
  const [completed] = await result;
  assert.equal(completed.status, "rejected");
  assert.match(completed.reason.message, /original tab control ended/);
  assert.equal(calls.filter(([method]) => method === "Page.stopScreencast").length, 1, "only the original internal cleanup sends stop");
});

test("a late raw start ACK cannot revive external stream state on a successor attachment", async () => {
  const start = defer(), entered = defer();
  const { backend, attach, cdp, calls } = await loadBackend({ command: (method, params) => {
    if (method === "Page.startScreencast" && params.format === "jpeg") { entered.resolve(); return start.promise; }
  } });
  await attach();
  const original = backend.attachmentEpochs.get(7);
  const pending = assert.rejects(cdp("Page.startScreencast", { format: "jpeg" }, { timeoutMs: 20 }), /Timed out/);
  await entered.promise;
  await pending;
  await backend.detach({ ...session, tabId: 7 });
  await attach();
  assert.notEqual(backend.attachmentEpochs.get(7), original);
  start.resolve({});
  await tick();
  assert.equal(backend.externalScreencastTabs.has(7), false);
  assert.equal(calls.filter(([method]) => method === "Page.stopScreencast").length, 0, "old ACK cleanup must not send to a successor attachment");
  await cdp("Page.captureScreenshot");
  assert.equal(calls.filter(([method]) => method === "Page.startScreencast").length, 2);
});

test("confirmed detach frees a successor stream queue while the old native reply remains tracked", async () => {
  const start = defer(), entered = defer();
  let nativeStream = null, firstStart = true;
  const { backend, attach, cdp, calls } = await loadBackend({
    detach: () => { nativeStream = null; },
    command: (method, params) => {
      if (method === "Page.startScreencast") {
        if (nativeStream) throw new Error("Screencast is already active");
        nativeStream = params.format;
        if (firstStart) { firstStart = false; entered.resolve(); return start.promise; }
      }
      if (method === "Page.stopScreencast") nativeStream = null;
    }
  });
  await attach();
  const pending = assert.rejects(cdp("Page.startScreencast", { format: "jpeg" }, { timeoutMs: 20 }), /Timed out/);
  await entered.promise;
  await pending;
  const oldTail = backend.renderingQueues.get(7);
  await backend.detach({ ...session, tabId: 7 });
  await attach();
  const successor = backend.attachmentEpochs.get(7);
  try {
    await cdp("Page.captureScreenshot");
    await cdp("Page.startScreencast", { format: "jpeg" });
    assert.equal(backend.renderingQueues.has(7), false);
    assert.equal(backend.renderingDrains.has(oldTail), true);
    assert.ok(backend.globalControlSnapshot().pending.includes(oldTail));
  } finally {
    start.resolve({});
    await tick();
  }
  assert.equal(backend.renderingDrains.has(oldTail), false);
  assert.equal(backend.attachmentEpochs.get(7), successor);
  assert.equal(backend.externalScreencastTabs.has(7), true);
  assert.equal(nativeStream, "jpeg");
  assert.equal(calls.filter(([method]) => method === "Page.stopScreencast").length, 1, "old ACK must not stop the new external stream");
  await cdp("Page.stopScreencast");
});

test("late raw start ACK after original scope revocation cannot reauthorize its retained attachment", async () => {
  const start = defer(), entered = defer();
  const { backend, attach, cdp } = await loadBackend({ command: method => {
    if (method === "Page.startScreencast") { entered.resolve(); return start.promise; }
  } });
  await attach();
  const original = backend.attachmentEpochs.get(7);
  const result = Promise.allSettled([cdp("Page.startScreencast", { format: "jpeg" }, { timeoutMs: 1000 })]);
  await entered.promise;
  backend.controlEpochs.set(7, (backend.controlEpochs.get(7) ?? 0) + 1);
  start.resolve({});
  const [completed] = await result;
  assert.equal(completed.status, "rejected");
  assert.match(completed.reason.message, /original tab control ended/);
  assert.equal(backend.attachmentEpochs.get(7), original);
  assert.equal(backend.externalScreencastTabs.has(7), false);
  await backend.detach({ ...session, tabId: 7 });
});

test("Pause drains a timed-out native start after detach without reviving external control", async () => {
  const start = defer(), entered = defer();
  const { backend, attach, cdp } = await loadBackend({ command: method => {
    if (method === "Page.startScreencast") { entered.resolve(); return start.promise; }
  } });
  await attach();
  const original = assert.rejects(cdp("Page.startScreencast", { format: "jpeg" }, { timeoutMs: 20 }), /Timed out/);
  await entered.promise;
  await original;
  let pauseSettled = false;
  const pause = backend.pauseAutomation().finally(() => { pauseSettled = true; });
  const result = Promise.allSettled([pause]);
  await tick();
  const beforeACK = { pauseSettled, pending: backend.renderingDrains.size };
  start.resolve({});
  assert.equal((await result)[0].status, "fulfilled");
  assert.equal(beforeACK.pauseSettled, false);
  assert.equal(beforeACK.pending, 1);
  assert.equal(backend.externalScreencastTabs.has(7), false);
  assert.equal(backend.renderingDrains.size, 0);
  await assert.rejects(cdp("Page.startScreencast", { format: "jpeg" }), /paused/i);
});

test("raw native already-active and stop failures preserve exact errors and the caller-owned stream", async () => {
  const activeError = new Error("Screencast is already active"), stopError = new Error("native stop failed");
  let started = false, rejectStop = true;
  const { backend, attach, cdp } = await loadBackend({ command: method => {
    if (method === "Page.startScreencast") {
      if (started) throw activeError;
      started = true;
    }
    if (method === "Page.stopScreencast") {
      if (rejectStop) throw stopError;
      started = false;
    }
  } });
  await attach();
  await cdp("Page.startScreencast", { format: "jpeg" });
  await assert.rejects(cdp("Page.startScreencast", { format: "png" }), error => error === activeError);
  await assert.rejects(cdp("Page.stopScreencast"), error => error === stopError);
  assert.equal(backend.externalScreencastTabs.has(7), true);
  await cdp("Page.captureScreenshot");
  rejectStop = false;
  await cdp("Page.stopScreencast");
  assert.equal(backend.externalScreencastTabs.has(7), false);
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
  const { timeoutMs, ...forwarded } = requests[0];
  assert.deepEqual(forwarded, request);
  assert.ok(timeoutMs > 0 && timeoutMs <= 10000);
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
