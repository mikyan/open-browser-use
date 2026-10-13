import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import test from "node:test";
import { networkWaitProofBridge, patchCrxNetworkWaitProof } from "./patch-network-wait-proof.mjs";
import { diagnosticProofBridge, patchCrxDiagnosticProof } from "./patch-diagnostic-proof.mjs";

const require = createRequire(new URL("../apps/chrome-extension/package.json", import.meta.url));
const directory = path.dirname(require.resolve("playwright-crx/package.json"));
assert.equal(JSON.parse(await fs.readFile(path.join(directory, "package.json"))).version, "0.15.0");
const entry = await fs.readFile(path.join(directory, "lib/index.mjs"), "utf8");
const upstream = await fs.readFile(path.join(directory, "lib", /from ["']\.\/([^"']+\.mjs)/.exec(entry)[1]), "utf8");
const network = patchCrxNetworkWaitProof(upstream);
const patched = patchCrxDiagnosticProof(network);
const baseline = process.env.OBU_TEST_DIAGNOSTIC_PROOF_BASELINE === "1";
const source = baseline ? upstream : patched;
function slice(text, start, end) {
  assert.equal(text.split(start).length, 2, `unique pinned start ${start}`);
  const from = text.indexOf(start), to = text.indexOf(end, from);
  assert.ok(to > from, `pinned end ${end}`); return text.slice(from, to);
}

function fixture() {
  const queued = [], frames = new Map(), serverContext = new EventEmitter(), clientPage = new EventEmitter(), received = [], wire = [];
  const channel = new EventEmitter();
  const context = { EventEmitter, console,
    BrowserContext$1: { Events: { Console: "console", PageError: "pageerror" } },
    Events: { BrowserContext: { Console: "console", WebError: "weberror" }, Page: { Console: "console", PageError: "pageerror" } },
    Page: { from: value => value?._object }, JSHandle2: { from: value => value },
    PageDispatcher: { from: () => pageDispatcher }, JSHandleDispatcher: { fromJSHandle: (_page, value) => value },
    WebError: class { constructor(page, error) { Object.assign(this, { page, error }); } },
    createHandle$3: (_context, value) => ({ preview: () => value.value ?? "", asElement: () => null, dispose() {} }),
    toConsoleMessageLocation: trace => ({ url: trace?.callFrames?.[0]?.url ?? "", lineNumber: 1, columnNumber: 2 }),
    exceptionToError: details => Object.assign(new Error(details.text), { stack: details.stackTrace?.callFrames?.[0]?.url ?? "" }),
    serializeError$1: error => ({ error: { message: error.message, name: error.name, stack: error.stack } }),
    parseError: value => Object.assign(new Error(value.error.message), { name: value.error.name, stack: value.error.stack }),
    releaseObject() {}, isUnderTest: () => true,
    findValidator: () => params => {
      const result = JSON.parse(JSON.stringify({ ...params, page: { guid: params.page._guid } }));
      return result;
    }
  };
  const classes = slice(source, "let ConsoleMessage$1 = class ConsoleMessage {", "let FileChooser$1 =") +
    slice(source, "class ConsoleMessage2 {", "class Dialog2 extends") +
    "class ServerPage {\n" + slice(source, "  emitOnContextOnceInitialized(event, ...args) {", "  async resetForReuse(metadata) {") +
      slice(source, "  addConsoleMessage(type2, args, location2, text", "  async reload(metadata, options2) {") + "}\n" +
    "class FrameSession {\n" + slice(source, baseline ? "  async _onConsoleAPI(event) {\n    if (event.executionContextId === 0) {\n      return;\n    }\n    const context = this._contextIdToContext.get(event.executionContextId);" : "  async _onConsoleAPI(event) {\n    const obuProof = captureOpenBrowserUseDiagnosticContext(this, event.executionContextId);", "  async _onBindingCalled(event) {") +
      slice(source, "  _handleException(exceptionDetails) {", "  async _onTargetCrashed() {") +
      slice(source, "  _onLogEntryAdded(event) {", "  async _onFileChooserOpened(event) {") + "}\n" +
    "class ServerDispatcher {\n" + slice(source, "  _dispatchEvent(method, params) {", "  _dispose(reason) {") +
      "install() {\n" + slice(source, "    this.addObjectListener(BrowserContext$1.Events.PageError, (error2, page) => {", "    this._dialogHandler = (dialog) => {") + "}\n}\n" +
    "class ServerConnection {\n" + slice(source, "  sendEvent(dispatcher, event, params) {", "  sendCreate(parent, type2, guid, initializer) {") + "}\n" +
    "class ClientContext extends EventEmitter { install() {\n" + slice(source, '    this._channel.on("console", (event) => {\n      const consoleMessage = new ConsoleMessage2(this._platform, event);', '    this._channel.on("dialog", ({ dialog }) => {') + "}\n}\n";
  const bridge = baseline ? "" : networkWaitProofBridge.replaceAll("export function ", "function ") + diagnosticProofBridge.replaceAll("export function ", "function ");
  const runtime = vm.runInNewContext(classes + bridge + `\n({ ServerPage, FrameSession, ServerDispatcher, ServerConnection, ClientContext,
    capture: typeof captureOpenBrowserUseDiagnosticSource === 'function' ? captureOpenBrowserUseDiagnosticSource : undefined,
    observe: typeof observeOpenBrowserUseNetworkDocument === 'function' ? observeOpenBrowserUseNetworkDocument : undefined,
    captureMessage: typeof captureOpenBrowserUseDiagnosticMessage === 'function' ? captureOpenBrowserUseDiagnosticMessage : () => null,
    deliver: typeof deliverOpenBrowserUseDiagnosticMessage === 'function' ? deliverOpenBrowserUseDiagnosticMessage : (c,m) => c.dispatch(m) })`, context);
  const page = new runtime.ServerPage();
  Object.assign(page, { _initialized: true, _eventsToEmitAfterInitialized: [], browserContext: serverContext,
    frameManager: { frame: id => frames.get(id), interceptConsoleMessage: () => false }, isClosed: () => false });
  const pageDispatcher = { _guid: "original-page", _object: page };
  Object.assign(clientPage, { _guid: pageDispatcher._guid, _toImpl: () => page });
  for (const kind of ["console", "pageerror"]) clientPage.on(kind, value => received.push({ kind, value }));
  const client = new runtime.ClientContext(); Object.assign(client, { _channel: channel, _platform: {} }); client.install();
  const clientConnection = { dispatch(message) { channel.emit(message.method, { ...message.params, page: { _object: clientPage } }); } };
  const connection = new runtime.ServerConnection();
  connection._validatorToWireContext = () => ({});
  connection.onmessage = message => { wire.push(structuredClone(message)); const original = runtime.captureMessage(message); queued.push(() => runtime.deliver(clientConnection, message, original)); };
  const dispatcher = new runtime.ServerDispatcher();
  Object.assign(dispatcher, { connection, _guid: "context", _type: "BrowserContext", _shouldDispatchEvent: () => true,
    addObjectListener: (event, callback) => serverContext.on(event, callback) }); dispatcher.install();
  const transport = { _tabToTarget: new Map([[7, {}]]), _sessions: new Map() }, nativeConnection = { _transport: transport, _sessions: new Map() };
  const session = { _sessionId: "crx-tab-7", _connection: nativeConnection }; nativeConnection._sessions.set(session._sessionId, session);
  const root = { _id: "root", _page: page, _currentDocument: { documentId: "original" }, _url: "https://allowed.test/original", url() { return this._url; }, parentFrame: () => null, isDetached: () => false };
  frames.set(root._id, root);
  const owner = new runtime.FrameSession(); Object.assign(owner, { _page: page, _client: session, _contextIdToContext: new Map([[1, { frame: root }]]) });
  const consoleEvent = (text = "original", id = 1) => ({ executionContextId: id, type: "log", args: text === null ? [] : [{ value: text }], stackTrace: { callFrames: [{ url: "https://forged.test/source.js" }] } });
  const exceptionEvent = (text = "original error", id = 1) => ({ executionContextId: id, text, stackTrace: { callFrames: [{ url: "https://forged.test/source.js" }] } });
  const flush = () => { while (queued.length) queued.shift()(); };
  const capture = (item = received.at(-1), target = clientPage) => {
    assert.equal(typeof runtime.capture, "function", "pinned ingress must retain original document proof through real dispatcher serialization");
    return runtime.capture(item.kind, item.value, target);
  };
  return { ...runtime, owner, page, root, session, frames, transport, nativeConnection, clientPage, received, wire, queued, flush, capture, consoleEvent, exceptionEvent };
}

test("pinned diagnostic patch rejects changed ingress, dispatch, client mapping or missing document lifecycle", () => {
  for (const anchor of ["  addConsoleMessage(type2, args, location2, text) {", "  _handleException(exceptionDetails) {", 'dispatcherConnection.onmessage = (message) => setImmediate(() => clientConnection.dispatch(message));', '    this._event = event;\n    if (platform.inspectCustom)'])
    assert.throws(() => patchCrxDiagnosticProof(network.replace(anchor, "changed")), /shape changed/);
  assert.throws(() => patchCrxDiagnosticProof(upstream), /requires original network/);
  assert.throws(() => patchCrxDiagnosticProof(patched), /requires original network/);
  const fenced = network.replace('  async _onConsoleAPI(event) {\n    if (event.executionContextId === 0) {\n      return;\n    }\n    const context = this._contextIdToContext.get(event.executionContextId);',
    '  async _onConsoleAPI(event) {\n    if (!acceptDiagnosticEvent(this._page, this._client, "console", event)) return;\n    if (event.executionContextId === 0) {\n      return;\n    }\n    const context = this._contextIdToContext.get(event.executionContextId);');
  assert.ok(patchCrxDiagnosticProof(fenced).includes('const obuProof = captureOpenBrowserUseDiagnosticContext(this, event.executionContextId);\n    if (!acceptDiagnosticEvent'));
});

test("actual pinned zero-argument console and Error retain context identity across copied wire messages", async () => {
  const f = fixture(); await f.owner._onConsoleAPI(f.consoleEvent(null)); f.owner._handleException(f.exceptionEvent()); f.flush();
  assert.deepEqual(f.received.map(row => row.kind), ["console", "pageerror"]);
  for (const row of f.received) { const proof = f.capture(row); assert.deepEqual([...proof.urls], ["https://allowed.test/original"]); proof.check(); }
  assert.equal(f.received[0].value.args().length, 0);
  assert.equal(f.received[1].value.stack, "https://forged.test/source.js");
  assert.deepEqual(Object.keys(f.wire[0].params).sort(), ["page", "type", "text", "args", "location"].sort());
  assert.deepEqual(Object.keys(f.wire[1].params).sort(), ["error", "page"]);
  assert.equal(JSON.stringify(f.wire).includes("proof"), false);
});

test("queued and pre-initialization native events never substitute a successor same-URL document", async () => {
  for (const buffered of [false, true]) {
    const f = fixture(); f.page._initialized = !buffered;
    await f.owner._onConsoleAPI(f.consoleEvent()); f.owner._handleException(f.exceptionEvent());
    f.root._currentDocument = { documentId: "original" };
    if (buffered) for (const { event, args } of f.page._eventsToEmitAfterInitialized.splice(0)) f.page.browserContext.emit(event, ...args);
    f.flush(); assert.equal(f.received.length, 2);
    for (const row of f.received) assert.throws(() => f.capture(row), /OBU_SITE_ACCESS_UNVERIFIED/);
  }
});

test("Log and unknown execution contexts cannot borrow an adjacent proven message or forged source URL", async () => {
  const f = fixture(); await f.owner._onConsoleAPI(f.consoleEvent());
  f.owner._onLogEntryAdded({ entry: { level: "warning", text: "unknown log", source: "javascript", url: "https://allowed.test/original" } });
  f.owner._handleException(f.exceptionEvent("unknown error", 999));
  f.flush(); assert.equal(f.received.length, 3); f.capture(f.received[0]).check();
  assert.throws(() => f.capture(f.received[1]), /OBU_SITE_ACCESS_UNVERIFIED/);
  assert.throws(() => f.capture(f.received[2]), /OBU_SITE_ACCESS_UNVERIFIED/);
  assert.throws(() => f.capture({ kind: "pageerror", value: f.received[0].value }), /OBU_SITE_ACCESS_UNVERIFIED/);
});

test("original diagnostic proof expires on context replacement, document.open and native attachment loss", async () => {
  for (const mutate of [f => f.owner._contextIdToContext.set(1, { frame: f.root }), f => { f.session._closed = true; },
    f => f.transport._tabToTarget.set(7, {}), f => f.observe?.(f.transport, 7, "Page.documentOpened", { frame: { id: "root" } })]) {
    const f = fixture(); await f.owner._onConsoleAPI(f.consoleEvent()); f.flush(); const proof = f.capture();
    mutate(f); assert.throws(proof.check, /OBU_SITE_ACCESS_UNVERIFIED/);
  }
});

test("interleaved messages retain distinct original contexts and cannot authorize another Page", async () => {
  const f = fixture(), original = f.root._currentDocument;
  await f.owner._onConsoleAPI(f.consoleEvent("first"));
  f.root._currentDocument = { documentId: "second" }; await f.owner._onConsoleAPI(f.consoleEvent("second"));
  f.queued.reverse(); f.flush();
  assert.equal(f.received[0].value.text(), "second"); f.capture(f.received[0]).check();
  assert.equal(f.received[1].value.text(), "first"); assert.throws(() => f.capture(f.received[1]), /UNVERIFIED/);
  assert.throws(() => f.capture(f.received[0], { _toImpl: () => ({}) }), /UNVERIFIED/);
  f.root._currentDocument = original; assert.throws(() => f.capture(f.received[0]), /UNVERIFIED/);
});
