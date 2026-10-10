import assert from "node:assert/strict";
import test from "node:test";
import { webcrypto } from "node:crypto";
import { BrowserClipboardBroker } from "./clipboard-broker.js";
import { ClipboardOffscreen } from "./clipboard-offscreen.js";

const KEY = "obuClipboardPendingV1";
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) { for (let count = 0; count < 100; count++) { if (predicate()) return; await tick(); } throw new Error("test checkpoint did not arrive"); }
function event() { const listeners = new Set(); return { addListener: listener => listeners.add(listener), clear: () => listeners.clear(), emit: (...args) => { for (const listener of listeners) listener(...args); } }; }

function fixture() {
  const state = { calls: [], storage: {}, nativeCalls: [], messages: [], targets: [], contexts: [], owned: false, text: "synthetic 中文", hooks: {} };
  const workerConnect = event();
  const extensionId = "owned-extension";
  const url = name => `chrome-extension://${extensionId}/${name}`;
  function pair(sender) {
    const a = { name: "obu.clipboard.private.v1", sender, onMessage: event(), onDisconnect: event() };
    const b = { name: a.name, onMessage: event(), onDisconnect: event() };
    let disconnected = false;
    a.postMessage = message => {
      if (disconnected) throw new Error("disconnected"); state.messages.push(message);
      const deliver = () => queueMicrotask(() => { if (!disconnected) b.onMessage.emit(structuredClone(message)); });
      if (state.hooks.message) state.hooks.message(message, deliver); else deliver();
    };
    b.postMessage = message => { if (disconnected) throw new Error("disconnected"); queueMicrotask(() => { if (!disconnected) a.onMessage.emit(structuredClone(message)); }); };
    a.disconnect = b.disconnect = () => { if (disconnected) return; disconnected = true; a.onDisconnect.emit(); b.onDisconnect.emit(); };
    state.lastPort = a;
    workerConnect.emit(a);
    return b;
  }
  const chrome = {
    runtime: { id: extensionId, getURL: url, onConnect: workerConnect,
      getContexts: async () => state.contexts,
      sendMessage: async message => { assert.deepEqual(message, { type: "obu.clipboard.reconnect" }); state.controller?.connect(); }
    },
    storage: { session: {
      get: async () => structuredClone(state.storage),
      setAccessLevel: async value => { assert.deepEqual(value, { accessLevel: "TRUSTED_CONTEXTS" }); },
      set: async value => { state.calls.push("persist:" + (value[KEY] ? "pending" : "clear")); await state.hooks.storage?.(value); Object.assign(state.storage, structuredClone(value)); }
    } },
    offscreen: {
      async createDocument(options) {
        assert.equal(options.url, "clipboard-offscreen.html"); assert.deepEqual(options.reasons, ["CLIPBOARD"]);
        state.calls.push("create");
        state.contexts = [{ contextType: "OFFSCREEN_DOCUMENT", documentUrl: url(options.url), documentId: "offscreen-document", tabId: -1, windowId: -1 }];
        state.controller = new ClipboardOffscreen({
          // Chromium 156's real offscreen Port.sender has no documentId/tab.
          chrome: { runtime: { connect: () => pair({ id: extensionId, url: url(options.url), origin: `chrome-extension://${extensionId}` }) } },
          crypto: webcrypto, Blob,
          ClipboardItem: class { constructor(data, options) { this.data = data; this.presentationStyle = options.presentationStyle; } },
          createImageBitmap: async function (blob) {
            assert.equal(this, globalThis, "native Window.createImageBitmap requires its global receiver");
            state.calls.push("decode"); await state.hooks.decode?.(blob); return { width: state.hooks.width ?? 1, height: 1, close: () => state.calls.push("bitmap-close") };
          },
          clipboard: {
            readText: () => { state.nativeCalls.push("readText"); return state.hooks.native?.() ?? Promise.resolve(state.text); },
            writeText: value => { state.nativeCalls.push("writeText"); state.text = value; return state.hooks.native?.() ?? Promise.resolve(); },
            read: () => { state.nativeCalls.push("read"); return state.hooks.native?.() ?? Promise.resolve([]); },
            write: items => { state.nativeCalls.push("write"); state.writtenItems = items; return state.hooks.native?.() ?? Promise.resolve(); }
          }
        });
        state.targets = [{ id: "offscreen-target", url: url(options.url), title: "Open Browser Use private clipboard", type: "background_page", attached: false }];
        state.controller.connect();
      },
      async closeDocument() { state.calls.push("close"); await state.hooks.close?.(); state.lastPort?.disconnect(); state.contexts = []; state.targets = []; state.controller = null; }
    },
    debugger: {
      getTargets: async () => state.targets,
      attach: async () => { state.calls.push("attach"); state.owned = true; state.targets[0].attached = true; },
      sendCommand: async (debuggee, method, params) => {
        assert.equal(debuggee.targetId, "offscreen-target");
        if (!state.owned) throw new Error("another debugger owns this target");
        state.calls.push(method);
        if (method === "Runtime.evaluate") { assert.equal(params.expression, "globalThis.__obuClipboardDocumentNonce"); return { result: { value: state.hooks.nonce ?? state.controller.nonce } }; }
        assert.equal(method, "Emulation.setFocusEmulationEnabled"); assert.deepEqual(params, { enabled: true });
      },
      detach: async () => { assert.equal(state.owned, true); state.calls.push("detach"); state.owned = false; state.targets[0].attached = false; }
    }
  };
  const scope = { session_id: "session", turn_id: "turn", control_epoch: 1, tabId: 7, attachment: {} };
  let broker = new BrowserClipboardBroker({ chrome, validateScope: async value => { assert.equal(value, scope); await state.hooks.validate?.(); } });
  const launch = (method = "readClipboardText", payload = {}, options = {}) => broker.execute(scope, method, { session_id: "session", turn_id: "turn", control_epoch: 1, tabId: 7, ...payload }, { check: () => state.hooks.check?.(), deadlineAt: Date.now() + 10000, ...options });
  return { state, chrome, scope, pair, launch, get broker() { return broker; }, restart() { workerConnect.clear(); state.lastPort?.disconnect(); broker = new BrowserClipboardBroker({ chrome, validateScope: async () => {} }); return broker; } };
}

test("private broker persists before prepare, performs native text call, and releases exact target/document", async () => {
  const f = fixture();
  assert.deepEqual(await f.launch(), { text: "synthetic 中文" });
  assert.deepEqual(f.state.nativeCalls, ["readText"]);
  assert.ok(f.state.calls.indexOf("persist:pending") < f.state.calls.lastIndexOf("detach"));
  assert.deepEqual(f.state.calls.slice(-3), ["detach", "close", "persist:clear"]);
  assert.equal(f.state.storage[KEY], null);
  assert.equal(f.broker.controlSnapshot().pending.length, 0);
  assert.deepEqual(f.state.messages.map(message => message.type), ["bind", "prepare", "commit"]);
});

test("rich prepare decodes PNG before commit and never inserts HTML in a document", async () => {
  const f = fixture(); const decode = deferred();
  f.state.hooks.decode = () => decode.promise;
  const result = f.launch("writeClipboard", { items: [{ entries: [{ mime_type: "text/html", text: "<script>never executed</script>" }, { mime_type: "image/png", base64: PNG }] }] });
  await until(() => f.state.calls.includes("decode"));
  assert.deepEqual(f.state.nativeCalls, []);
  assert.ok(f.state.storage[KEY]);
  assert.equal(JSON.stringify(f.state.storage).includes("never executed"), false);
  decode.resolve(); await result;
  assert.deepEqual(f.state.nativeCalls, ["write"]);
  assert.ok(f.state.calls.includes("bitmap-close"));
  assert.equal(await f.state.writtenItems[0].data["text/html"].text(), "<script>never executed</script>");
});

test("invalid full PNG decode never reaches native write", async () => {
  const f = fixture(); f.state.hooks.decode = async () => { throw new Error("decoder rejected corrupt image"); };
  await assert.rejects(f.launch("writeClipboard", { items: [{ entries: [{ mime_type: "image/png", base64: PNG }] }] }), /OBU_CLIPBOARD_FAILED/);
  assert.deepEqual(f.state.nativeCalls, []); assert.equal(f.state.storage[KEY], null);
});

test("decoded image pixel cap is enforced before write", async () => {
  const f = fixture(); f.state.hooks.width = 16777217;
  await assert.rejects(f.launch("writeClipboard", { items: [{ entries: [{ mime_type: "image/png", base64: PNG }] }] }), /OBU_CLIPBOARD_LIMIT/);
  assert.deepEqual(f.state.nativeCalls, []); assert.ok(f.state.calls.includes("bitmap-close"));
});

test("scope change after preparation prevents commit and awaits preparation cleanup", async () => {
  const f = fixture(); f.state.hooks.validate = async () => { throw new Error("scope retired"); };
  await assert.rejects(f.launch("writeClipboardText", { text: "new" }), /scope retired/);
  assert.deepEqual(f.state.nativeCalls, []);
  assert.equal(f.state.messages.some(message => message.type === "commit"), false);
  assert.equal(f.state.storage[KEY], null);
});

test("final check is immediately before commit and original deadline is not restarted", async () => {
  const f = fixture(); const gate = deferred();
  f.state.hooks.validate = () => gate.promise;
  let expired = false; f.state.hooks.check = () => { if (expired) throw new Error("cancelled before commit"); };
  const result = f.launch("writeClipboardText", { text: "new" });
  await until(() => f.state.messages.some(message => message.type === "prepare"));
  await tick(); expired = true; gate.resolve();
  await assert.rejects(result, /cancelled before commit/);
  assert.deepEqual(f.state.nativeCalls, []);
  const past = fixture();
  await assert.rejects(past.launch("readClipboardText", {}, { deadlineAt: Date.now() - 1 }), /TIMEOUT/);
  assert.deepEqual(past.state.calls, []);
});

test("storage write is awaited and contains identity only, without clipboard content", async () => {
  const f = fixture(); const stored = deferred();
  f.state.hooks.storage = value => value[KEY] ? stored.promise : undefined;
  const result = f.launch("writeClipboardText", { text: "private payload" });
  await until(() => f.state.calls.includes("persist:pending"));
  assert.equal(f.state.messages.some(message => message.type === "prepare"), false);
  assert.equal(f.broker.controlSnapshot().pending.length, 1);
  stored.resolve(); await result;
  assert.equal(JSON.stringify(f.state.storage).includes("private payload"), false);
});

test("native dispatch rechecks deadline after the commit message leaves the worker", async () => {
  const f = fixture(); let dispatch;
  f.state.hooks.message = (message, deliver) => { if (message.type === "commit") dispatch = deliver; else deliver(); };
  const result = f.launch("writeClipboardText", { text: "too late" });
  await until(() => dispatch);
  f.state.controller.operation.deadlineAt = Date.now() - 1;
  dispatch();
  await assert.rejects(result, /TIMEOUT/);
  assert.deepEqual(f.state.nativeCalls, []);
  assert.equal(f.state.storage[KEY], null);
});

test("a rejected pending-marker write cannot dispatch preparation or a native action", async () => {
  const f = fixture();
  f.state.hooks.storage = value => { if (value[KEY]) throw new Error("storage write failed"); };
  await assert.rejects(f.launch("writeClipboardText", { text: "never dispatched" }), /storage write failed/);
  assert.equal(f.state.messages.some(message => message.type === "prepare"), false);
  assert.deepEqual(f.state.nativeCalls, []);
  assert.equal(f.state.storage[KEY], null);
});

test("post-commit cancellation does not settle native work or admit a second operation", async () => {
  const f = fixture(); const native = deferred(); f.state.hooks.native = () => native.promise;
  const result = f.launch(); await until(() => f.state.nativeCalls.length === 1);
  await assert.rejects(f.launch(), /BUSY/);
  let sessionDone = false, tabDone = false;
  void f.broker.waitForSession("session").then(() => { sessionDone = true; });
  void f.broker.waitForTab(7).then(() => { tabDone = true; });
  await tick(); assert.equal(sessionDone, false); assert.equal(tabDone, false);
  assert.equal(f.state.calls.filter(call => call === "detach").length, 1); // Only temporary identity proof.
  assert.equal(f.state.owned, true);
  native.resolve("real completed text"); assert.deepEqual(await result, { text: "real completed text" });
  await tick(); assert.equal(sessionDone, true); assert.equal(tabDone, true);
});

test("lost Port reconciliation waits for real committed result without replaying native calls", async () => {
  const f = fixture(); const native = deferred(); f.state.hooks.native = () => native.promise;
  const result = f.launch(); result.catch(() => {});
  await until(() => f.state.nativeCalls.length === 1);
  const metadata = structuredClone(f.state.storage[KEY]);
  f.state.lastPort.disconnect();
  // The old broker also reconciles its loss; wait for that same-document bind.
  await until(() => f.state.messages.filter(message => message.type === "bind").length >= 2);
  assert.equal(f.state.storage[KEY].operationId, metadata.operationId);
  assert.deepEqual(f.state.nativeCalls, ["readText"]);
  native.resolve("settled, never replayed");
  await assert.rejects(result, /CHANNEL_LOST/);
  assert.equal(f.state.storage[KEY], null);
  assert.deepEqual(f.state.nativeCalls, ["readText"]);
});

async function preparedDocument(f) {
  await f.chrome.offscreen.createDocument({ url: "clipboard-offscreen.html", reasons: ["CLIPBOARD"] });
  const { channel } = await f.broker.bind("offscreen-document", Date.now() + 10000);
  const targetId = await f.broker.attach(channel);
  const metadata = { version: 1, documentId: channel.documentId, documentNonce: channel.documentNonce, operationId: webcrypto.randomUUID(), targetId, session_id: "session", tabId: 7 };
  f.state.storage[KEY] = metadata;
  await f.broker.request(channel, "prepare", { operationId: metadata.operationId, method: "writeClipboardText", params: { session_id: "session", turn_id: "turn", control_epoch: 1, tabId: 7, text: "synthetic prepared data" }, deadlineAt: Date.now() + 10000 });
  return { channel, metadata };
}

test("new worker handshake revokes old prepared data and never commits it", async () => {
  const f = fixture(); await preparedDocument(f);
  const previous = f.state.controller.operation;
  const broker = f.restart(); await broker.recover();
  assert.deepEqual(f.state.nativeCalls, []);
  assert.equal(previous.revoked, true); assert.equal(previous.params, null);
  assert.equal(f.state.storage[KEY], null);
  assert.deepEqual(f.state.messages.map(message => message.type), ["bind", "prepare", "bind"]);
});

test("new worker waits for old committed native promise before removing marker and admitting work", async () => {
  const f = fixture(); const native = deferred(); f.state.hooks.native = () => native.promise;
  const { channel, metadata } = await preparedDocument(f);
  const committed = f.broker.request(channel, "commit", { operationId: metadata.operationId }); committed.catch(() => {});
  await until(() => f.state.nativeCalls.length === 1);
  const broker = f.restart(); let recovered = false;
  const recovery = broker.recover().then(() => { recovered = true; });
  await until(() => f.state.messages.filter(message => message.type === "bind").length === 2);
  assert.equal(recovered, false); assert.ok(f.state.storage[KEY]);
  assert.equal(broker.controlSnapshot().pending.length, 1);
  assert.deepEqual([...broker.controlSnapshot().tabIds], [7]);
  let pauseDone = false, endDone = false, detachDone = false;
  void Promise.allSettled(broker.controlSnapshot().pending).then(() => { pauseDone = true; });
  void broker.waitForSession("session").then(() => { endDone = true; });
  void broker.waitForTab(7).then(() => { detachDone = true; });
  await broker.waitForSession("foreign"); await broker.waitForTab(99);
  await tick();
  assert.equal(pauseDone, false); assert.equal(endDone, false); assert.equal(detachDone, false);
  assert.equal(f.state.calls.filter(call => call === "detach").length, 1);
  assert.equal(f.state.owned, true);
  native.resolve(); await recovery;
  assert.equal(recovered, true); assert.equal(f.state.storage[KEY], null);
  assert.deepEqual(f.state.nativeCalls, ["writeText"]);
  await tick();
  assert.equal(pauseDone, true); assert.equal(endDone, true); assert.equal(detachDone, true);
  assert.equal(broker.controlSnapshot().pending.length, 0);
});

test("pending recovery storage read globally blocks Pause and scoped cleanup before owner is known", async () => {
  const f = fixture(); const read = deferred();
  f.chrome.storage.session.get = () => read.promise;
  const recovery = f.broker.recover();
  const snapshot = f.broker.controlSnapshot();
  assert.equal(snapshot.pending.length, 1);
  assert.equal(snapshot.tabIds.size, 0);
  let pauseDone = false, sessionDone = false, tabDone = false;
  void Promise.allSettled(snapshot.pending).then(() => { pauseDone = true; });
  void f.broker.waitForSession("any-session").then(() => { sessionDone = true; });
  void f.broker.waitForTab(99).then(() => { tabDone = true; });
  await tick();
  assert.equal(pauseDone, false); assert.equal(sessionDone, false); assert.equal(tabDone, false);
  read.resolve({}); await recovery; await tick();
  assert.equal(pauseDone, true); assert.equal(sessionDone, true); assert.equal(tabDone, true);
  assert.equal(f.broker.controlSnapshot().pending.length, 0);
  // Normal execution awaits the same resolved recovery, without awaiting its
  // own scoped operation or introducing a recover/execute cleanup cycle.
  assert.deepEqual(await f.launch(), { text: "synthetic 中文" });
});

for (const stage of ["get", "setAccessLevel"]) test(`failed startup ${stage} remains unknown until explicit retry confirms an absent marker`, async () => {
  const f = fixture(), gate = deferred(), storageError = new Error(`synthetic ${stage} failure`);
  const original = f.chrome.storage.session[stage];
  let attempts = 0, mode = "fail";
  f.chrome.storage.session[stage] = async (...args) => {
    attempts++;
    if (mode === "fail") throw storageError;
    if (mode === "wait") await gate.promise;
    return original(...args);
  };
  await assert.rejects(f.broker.recover(), error => error === storageError);
  assert.equal(f.broker.controlSnapshot().pending.length, 1);
  assert.equal(f.broker.controlSnapshot().tabIds.size, 0);
  await assert.rejects(f.launch(), /CLEANUP_UNKNOWN/);
  assert.equal(attempts, 1, "Ordinary work must not retry the unknown startup state");
  let sessionDone = false, tabDone = false;
  const session = f.broker.waitForSession("any-session").then(() => { sessionDone = true; });
  const tab = f.broker.waitForTab(99).then(() => { tabDone = true; });
  await assert.rejects(f.broker.retryCleanup(), error => error === storageError);
  assert.equal(attempts, 2); assert.equal(f.broker.controlSnapshot().pending.length, 1);
  mode = "wait";
  const retry = f.broker.retryCleanup();
  await tick();
  assert.equal(attempts, 3); assert.equal(f.broker.controlSnapshot().pending.length, 2);
  assert.equal(sessionDone, false); assert.equal(tabDone, false);
  gate.resolve(); await retry; await session; await tab;
  assert.equal(f.broker.controlSnapshot().pending.length, 0);
  assert.deepEqual(f.state.nativeCalls, []); assert.equal(f.state.calls.includes("create"), false);
});

test("retry after unread startup marker discovers and drains the original committed native operation", async () => {
  const f = fixture(), native = deferred(); f.state.hooks.native = () => native.promise;
  const { channel, metadata } = await preparedDocument(f);
  const committed = f.broker.request(channel, "commit", { operationId: metadata.operationId }); committed.catch(() => {});
  await until(() => f.state.nativeCalls.length === 1);
  const broker = f.restart(), originalGet = f.chrome.storage.session.get;
  f.chrome.storage.session.get = async () => { throw new Error("transient startup read failed"); };
  await assert.rejects(broker.recover(), /transient startup read failed/);
  f.chrome.storage.session.get = originalGet;
  let cleanupDone = false;
  const cleanup = broker.retryCleanup().then(() => { cleanupDone = true; });
  await until(() => f.state.messages.filter(message => message.type === "bind").length === 2);
  assert.equal(cleanupDone, false);
  assert.deepEqual([...broker.controlSnapshot().tabIds], [7]);
  assert.ok(broker.controlSnapshot().pending.length);
  assert.equal(f.state.storage[KEY].operationId, metadata.operationId);
  assert.equal(f.state.owned, true);
  native.resolve(); await cleanup;
  assert.deepEqual(f.state.nativeCalls, ["writeText"]);
  assert.equal(f.state.storage[KEY], null); assert.equal(broker.controlSnapshot().pending.length, 0);
});

test("persisted pending marker without original document fails closed and blocks scoped cleanup", async () => {
  const f = fixture(); f.state.storage[KEY] = { version: 1, documentId: "lost-document", documentNonce: webcrypto.randomUUID(), operationId: webcrypto.randomUUID(), targetId: "lost-target", session_id: "session", tabId: 7 };
  await assert.rejects(f.broker.recover(), /CLEANUP_UNKNOWN/);
  assert.equal(f.broker.controlSnapshot().pending.length, 1);
  assert.deepEqual([...f.broker.controlSnapshot().tabIds], [7]);
  let done = false; void f.broker.waitForSession("session").then(() => { done = true; });
  await tick(); assert.equal(done, false);
  await f.broker.waitForSession("other");
  await assert.rejects(f.launch(), /CLEANUP_UNKNOWN/);
  assert.deepEqual(f.state.nativeCalls, []); assert.equal(f.state.calls.includes("create"), false);
  await assert.rejects(f.broker.retryCleanup(), /CLEANUP_UNKNOWN/);
});

test("lost original document after commit keeps both actual flow and cleanup blocker pending", async () => {
  const f = fixture(); const native = deferred(); f.state.hooks.native = () => native.promise;
  let settled = false;
  void f.launch().then(() => { settled = true; }, () => { settled = true; });
  await until(() => f.state.nativeCalls.length === 1);
  f.state.contexts = [];
  f.state.lastPort.disconnect();
  await until(() => f.broker.unknown);
  native.resolve("late native result has no surviving document proof");
  await tick();
  assert.equal(settled, false);
  assert.equal(f.broker.controlSnapshot().pending.length, 2);
  assert.ok(f.state.storage[KEY]);
  assert.equal(f.state.calls.filter(call => call === "detach").length, 1);
  assert.equal(f.state.owned, true);
  assert.equal(f.state.calls.includes("close"), false);
});

test("explicit cleanup retry can confirm a previously unreachable same document without replay", async () => {
  const f = fixture(); await preparedDocument(f);
  const metadata = structuredClone(f.state.storage[KEY]);
  const broker = f.restart();
  const originalContexts = f.chrome.runtime.getContexts;
  f.chrome.runtime.getContexts = async () => { throw new Error("transient context API failure"); };
  await assert.rejects(broker.recover(), /CLEANUP_UNKNOWN/);
  assert.equal(broker.controlSnapshot().pending.length, 1);
  f.chrome.runtime.getContexts = originalContexts;
  await broker.retryCleanup();
  assert.equal(broker.controlSnapshot().pending.length, 0);
  assert.equal(f.state.storage[KEY], null);
  assert.deepEqual(f.state.nativeCalls, []);
  assert.ok(metadata.documentNonce);
});

test("missing clipboard APIs remain compatible with empty-state recovery but reject execution", async () => {
  const broker = new BrowserClipboardBroker({ chrome: { storage: { session: { get: async () => ({}) } } }, validateScope: async () => {} });
  await broker.recover();
  await assert.rejects(broker.execute({}, "readClipboardText", {}, { check() {}, deadlineAt: Date.now() + 1000 }), /UNSUPPORTED/);
});

test("forged extension tab, wrong sender and stale offscreen document cannot establish a data Port", async () => {
  for (const sender of [
    { id: "foreign", url: "chrome-extension://owned-extension/clipboard-offscreen.html", documentId: "offscreen-document" },
    { id: "owned-extension", url: "chrome-extension://owned-extension/clipboard-offscreen.html", documentId: "offscreen-document", tab: { id: 3 } },
    { id: "owned-extension", url: "chrome-extension://owned-extension/clipboard-offscreen.html", documentId: "old-document" }
  ]) {
    const f = fixture(); f.state.contexts = [{ contextType: "OFFSCREEN_DOCUMENT", documentUrl: f.chrome.runtime.getURL("clipboard-offscreen.html"), documentId: "offscreen-document", tabId: -1, windowId: -1 }];
    const peer = f.pair(sender);
    try { peer.postMessage({ type: "hello", version: 1, documentNonce: webcrypto.randomUUID() }); } catch {}
    await tick(); assert.equal(f.broker.channel, null);
  }
});

test("nonce mismatch never focuses target; competing debugger is never detached", async () => {
  const mismatch = fixture(); mismatch.state.hooks.nonce = "different";
  await assert.rejects(mismatch.launch(), /UNSUPPORTED/);
  assert.equal(mismatch.state.calls.includes("Emulation.setFocusEmulationEnabled"), false);
  assert.deepEqual(mismatch.state.nativeCalls, []);
  const competitor = fixture();
  const originalCreate = competitor.chrome.offscreen.createDocument;
  competitor.chrome.offscreen.createDocument = async options => { await originalCreate(options); competitor.state.targets[0].attached = true; };
  await assert.rejects(competitor.launch(), /another debugger/);
  assert.equal(competitor.state.calls.includes("detach"), false);
  assert.equal(competitor.state.calls.includes("close"), false);
});

test("a same-URL extension page without sender.documentId cannot impersonate the offscreen nonce", async () => {
  const f = fixture();
  await f.chrome.offscreen.createDocument({ url: "clipboard-offscreen.html", reasons: ["CLIPBOARD"] });
  f.state.lastPort.disconnect();
  const peer = f.pair({ id: f.chrome.runtime.id, url: f.chrome.runtime.getURL("clipboard-offscreen.html") });
  peer.postMessage({ type: "hello", version: 1, documentNonce: webcrypto.randomUUID() });
  await tick();
  await assert.rejects(f.broker.waitChannel("offscreen-document", Date.now() + 1000), /UNSUPPORTED/);
  assert.equal(f.broker.channel, null);
  assert.equal(f.state.messages.length, 0); // No bind or payload before proof.
  assert.equal(f.state.calls.includes("Emulation.setFocusEmulationEnabled"), false);
});

test("a forged candidate cannot replace a verified Port or detach its active native target", async () => {
  const f = fixture(); const { channel } = await preparedDocument(f);
  const detaches = f.state.calls.filter(call => call === "detach").length;
  const peer = f.pair({ id: f.chrome.runtime.id, url: f.chrome.runtime.getURL("clipboard-offscreen.html") });
  assert.throws(() => peer.postMessage({ type: "hello", version: 1, documentNonce: webcrypto.randomUUID() }), /disconnected/);
  assert.equal(f.broker.channel, channel); assert.equal(channel.disconnected, false);
  assert.equal(f.state.owned, true);
  assert.equal(f.state.calls.filter(call => call === "detach").length, detaches);
  // Even without an established Port, proving a false nonce must not detach
  // an existing attachment already held by this extension's native operation.
  channel.port.disconnect();
  const forged = f.pair({ id: f.chrome.runtime.id, url: f.chrome.runtime.getURL("clipboard-offscreen.html") });
  forged.postMessage({ type: "hello", version: 1, documentNonce: webcrypto.randomUUID() });
  await tick();
  await assert.rejects(f.broker.waitChannel("offscreen-document", Date.now() + 1000), /UNSUPPORTED/);
  assert.equal(f.state.calls.filter(call => call === "detach").length, detaches);
  assert.equal(f.state.owned, true);
});

test("native read checks blob.size before allocating text or binary buffers", async () => {
  const f = fixture(); let allocated = false;
  f.state.hooks.native = () => Promise.resolve([{ types: ["text/html"], getType: async () => ({ size: 50, text: async () => { allocated = true; return "x"; } }) }]);
  await assert.rejects(f.launch("readClipboard", { maxBytes: 5 }), /LIMIT/);
  assert.equal(allocated, false);
});

test("native unsupported formats cannot silently become an empty successful read", async () => {
  for (const types of [["application/private"], ["text/plain", "text/plain"], []]) {
    const f = fixture();
    f.state.hooks.native = () => Promise.resolve([{ types, getType: async () => { throw new Error("must not allocate"); } }]);
    await assert.rejects(f.launch("readClipboard"), /UNSUPPORTED/);
    assert.equal(f.state.storage[KEY], null);
  }
});
