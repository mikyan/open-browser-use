import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import vm from "node:vm";
import { patchCrxTransport } from "./build-chrome-extension.mjs";
import { patchCrxDiagnostics } from "./patch-diagnostics.mjs";
import { beginDiagnosticFence, bindDiagnosticSession, acceptDiagnosticEvent, diagnosticReleaseGuard } from "../apps/chrome-extension/browser-diagnostic-fence.js";

const require = createRequire(new URL("../apps/chrome-extension/package.json", import.meta.url));
const packageDir = path.dirname(require.resolve("playwright-crx/package.json"));
const entry = await fs.readFile(path.join(packageDir, "lib/index.mjs"), "utf8");
const chunk = /from ["']\.\/([^"']+\.mjs)/.exec(entry)[1];
const upstream = await fs.readFile(path.join(packageDir, "lib", chunk), "utf8");
const transported = patchCrxTransport(upstream);
const patched = patchCrxDiagnostics(transported);
const flush = () => new Promise(resolve => setImmediate(resolve));

function slice(source, start, end) {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `Pinned diagnostic fixture boundary changed: ${start}`);
  return source.slice(from, to);
}

test("all native event and transport anchors are fixed and fail closed on drift", () => {
  for (const anchor of [
    "this.utilityWorldName = `__playwright_utility_world_${this._page.guid}`;", "this._crPage = crPage;",
    "const worker = new Worker$1(this._page, url2);", "async _onConsoleAPI(event)", "_onLogEntryAdded(event) {",
    'eventsHelper.addEventListener(this._client, "Runtime.exceptionThrown", (exception)',
    'session.on("Runtime.consoleAPICalled", (event2)', 'session.on("Runtime.exceptionThrown", (exception)',
    "async _send(debuggee, method, commandParams)", "const operation = () => chrome.debugger.sendCommand",
    'result = await this._send(debuggee, message.method, { ...message.params });'
  ]) assert.throws(() => patchCrxDiagnostics(transported.replace(anchor, "changed-native-shape")), /shape changed/, anchor);
  assert.ok(patched.indexOf("beginDiagnosticFence(this._page)") < patched.indexOf("this._mainFrameSession = new FrameSession"));
});

function fixture({ admission, failRelease = false } = {}) {
  const native = [], failures = [], handles = [], consoleEvents = [], errors = [];
  const context = {
    beginDiagnosticFence, bindDiagnosticSession, acceptDiagnosticEvent, diagnosticReleaseGuard,
    openBrowserUseInputHooks: { send: async (_target, _method, _params, operation) => { if (admission) await admission; return operation(); } },
    openBrowserUseCommandObserver: undefined, observeCrxInputCommand() { throw new Error("standalone input hook invoked"); },
    openBrowserUseEventFilter: undefined, prepareCrxChildFrame: async () => {},
    __publicField: (object, key, value) => { object[key] = value; },
    debugLogger: { isEnabled: () => false, log: (_kind, error) => failures.push(error) },
    chrome: { debugger: { sendCommand: async (target, method, params) => { native.push({ target, method, params }); if (failRelease) throw new Error("native release failed"); return {}; } } },
    eventsExports: { EventEmitter }, ProtocolError: class extends Error { setMessage(value) { this.message = value; } },
    assert, eventsHelper: { addEventListener: (emitter, name, callback) => { emitter.on(name, callback); return { emitter, name, callback }; } },
    BrowserContext$1: { Events: { PageError: "pageerror" } },
    exceptionToError: details => new Error(details.text),
    createHandle$3: (_context, object) => { handles.push(object); return object; },
    toConsoleMessageLocation: () => ({}), releaseObject: (client, objectId) => client._sendMayFail("Runtime.releaseObject", { objectId })
  };
  // Actual pinned CRSession send/reply/error handling and actual CrxTransport
  // dispatch/_send are executed. Only chrome.debugger is the native boundary.
  const nativeSource = slice(patched, "class CRSession extends", "let CDPSession$1 =") +
    "\nclass NativeTransport {\n" + slice(patched, "  async send(message) {\n    try {\n      const [, tabIdStr]", "  async attach(tabId, onBeforeEmitAttachedToTarget)") +
    slice(patched, "  async _send(debuggee, method, commandParams, diagnosticGuard) {", "  _emitMessage(message) {") + "\n}\n" +
    "\nclass NativeFrame {\n" + slice(patched, "  constructor(crPage, client, targetId, parentSession) {", "  _isMainFrame() {") +
    slice(patched, "  _addRendererListeners() {", "  _addBrowserListeners() {") +
    slice(patched, "  async _onConsoleAPI(event) {", "  async _onBindingCalled(event) {") +
    slice(patched, "  _handleException(exceptionDetails) {", "  async _onTargetCrashed() {") +
    slice(patched, "  _onLogEntryAdded(event) {", "  async _onFileChooserOpened(event) {") + "\n}\n" +
    "({CRSession, NativeTransport, NativeFrame});";
  const { CRSession, NativeTransport, NativeFrame } = vm.runInNewContext(nativeSource, context);
  const transport = new NativeTransport();
  Object.assign(transport, { _tabToTarget: new Map([[17, { targetId: "original" }]]), _sessions: new Map() });
  let id = 0;
  const connection = { _sessions: new Map(), _transport: transport, _rawSend(sessionId, method, params) {
    const messageId = ++id; void transport.send({ id: messageId, sessionId, method, params }); return messageId;
  } };
  transport._emitMessage = message => connection._sessions.get(message.sessionId)?._onMessage(message);
  const page = { addConsoleMessage: (...args) => consoleEvents.push(args), emitOnContextOnceInitialized: (...args) => errors.push(args) };
  beginDiagnosticFence(page, () => 100);
  const session = sessionId => {
    const client = new CRSession(connection, null, sessionId);
    connection._sessions.set(sessionId, client);
    if (sessionId !== "crx-tab-17") transport._sessions.set(sessionId, 17);
    return client;
  };
  const frame = client => {
    const frame = new NativeFrame({ _page: page }, client, "frame", null);
    frame._contextIdToContext.set(1, {});
    frame._addRendererListeners(); return frame;
  };
  const worker = client => {
    const listeners = slice(patched, '    session.on("Runtime.consoleAPICalled", (event2) => {', '\n  }\n  _onDetachedFromTarget(event) {');
    const bind = slice(patched, '    bindDiagnosticSession(this._page, session);', '    this._page.addWorker(event.sessionId, worker);');
    vm.runInNewContext(`(function(session,worker){${bind}${listeners}})`, context).call({ _page: page }, client, { existingExecutionContext: {} });
  };
  const debuggerEvent = slice(patched, '    __publicField(this, "_onDebuggerEvent",', '    this._progress = progress2;');
  transport._sessionIdFor = tabId => `crx-tab-${tabId}`;
  vm.runInNewContext(`(function(){${debuggerEvent}})`, context).call(transport);
  return { page, connection, transport, session, frame, worker, native, failures, handles, consoleEvents, errors };
}

test("late historical root/OOPIF console, Log and pageerror are filtered before native handles are created", async () => {
  for (const sessionId of ["crx-tab-17", "child-oopif"]) {
    const f = fixture(), client = f.session(sessionId); f.frame(client);
    // Arrive after Page/capture setup, exactly the asynchronous replay ordering.
    client.emit("Runtime.consoleAPICalled", { timestamp: 99, executionContextId: 1, type: "log", args: [{ objectId: "old-console" }] });
    client.emit("Runtime.exceptionThrown", { timestamp: 99, exceptionDetails: { text: "old error", exception: { objectId: "old-error" } } });
    client.emit("Log.entryAdded", { entry: { timestamp: 99, args: [{ objectId: "old-log" }], text: "old log" } });
    await flush();
    assert.equal(f.handles.length, 0); assert.equal(f.consoleEvents.length, 0); assert.equal(f.errors.length, 0);
    assert.deepEqual(f.native.map(item => item.params.objectId), ["old-console", "old-error", "old-log"]);
    for (const item of f.native) assert.deepEqual(JSON.parse(JSON.stringify(item.target)), sessionId === "crx-tab-17" ? { tabId: 17 } : { tabId: 17, sessionId });
    client.emit("Runtime.consoleAPICalled", { timestamp: 100, executionContextId: 1, type: "log", args: [{ value: "fresh" }] });
    client.emit("Runtime.exceptionThrown", { timestamp: 101, exceptionDetails: { text: "fresh error" } });
    client.emit("Log.entryAdded", { entry: { timestamp: 102, args: [], text: "fresh log", source: "other" } });
    assert.equal(f.handles.length, 1); assert.equal(f.consoleEvents.length, 2); assert.equal(f.errors.length, 1);
  }
});

test("dedicated-worker native callbacks use the owning Page cutoff and release old exception objects", async () => {
  const f = fixture(), client = f.session("worker-session"); f.worker(client);
  client.emit("Runtime.consoleAPICalled", { timestamp: 99, args: [{ objectId: "worker-console" }] });
  client.emit("Runtime.exceptionThrown", { timestamp: 99, exceptionDetails: { exception: { objectId: "worker-error" } } });
  await flush();
  assert.equal(f.consoleEvents.length, 0); assert.equal(f.errors.length, 0); assert.equal(f.handles.length, 0);
  assert.deepEqual(f.native.map(item => item.params.objectId), ["worker-console", "worker-error"]);
  client.emit("Runtime.consoleAPICalled", { timestamp: 100, args: [{ value: "fresh worker" }] });
  client.emit("Runtime.exceptionThrown", { timestamp: 100, exceptionDetails: { text: "fresh worker error" } });
  assert.equal(f.consoleEvents.length, 1); assert.equal(f.errors.length, 1);
});

test("original release guard survives transport copying and asynchronous permission checks", async () => {
  let releaseAdmission;
  const f = fixture({ admission: new Promise(resolve => { releaseAdmission = resolve; }) });
  const client = f.session("child"); f.frame(client);
  client.emit("Runtime.consoleAPICalled", { timestamp: 99, executionContextId: 1, args: [{ objectId: "old" }] });
  f.transport._tabToTarget.set(17, { targetId: "successor" });
  releaseAdmission(); await flush();
  assert.equal(f.native.length, 0);
  assert.equal(f.failures.length, 1);
  assert.match(f.failures[0].message, /retired native session/);
});

test("native release failure uses existing CRSession error logging, not a false cleanup-success signal", async () => {
  const f = fixture({ failRelease: true }), client = f.session("crx-tab-17"); f.frame(client);
  client.emit("Runtime.exceptionThrown", { timestamp: 99, exceptionDetails: { exception: { objectId: "error" } } });
  await flush();
  assert.equal(f.native.length, 1); assert.equal(f.failures.length, 1);
  assert.match(f.failures[0].message, /native release failed/);
  assert.equal(f.errors.length, 0);
});

test("the original raw debugger event remains observable and unmodified while CRX filters history", async () => {
  const f = fixture(), client = f.session("crx-tab-17"); f.frame(client);
  const rawEvents = [];
  // Independent listeners receive the same event as chrome.debugger.onEvent:
  // one represents public raw CDP, the other is the actual pinned CRX ingress.
  const listeners = [
    (source, method, params) => { rawEvents.push(structuredClone({ source, method, params })); },
    f.transport._onDebuggerEvent
  ];
  const source = Object.freeze({ tabId: 17 });
  const params = Object.freeze({ timestamp: 99, executionContextId: 1, type: "log", args: Object.freeze([Object.freeze({ objectId: "raw-old" })]) });
  for (const listener of listeners) await listener(source, "Runtime.consoleAPICalled", params);
  await flush();
  assert.deepEqual(rawEvents, [{ source, method: "Runtime.consoleAPICalled", params }]);
  assert.equal(f.consoleEvents.length, 0);
  assert.equal(f.native.length, 1);
  assert.equal(f.native[0].params.objectId, "raw-old");
});
