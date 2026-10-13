import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { test } from "node:test";
import { networkWaitProofBridge, patchCrxNetworkWaitProof } from "./patch-network-wait-proof.mjs";

const require = createRequire(new URL("../apps/chrome-extension/package.json", import.meta.url));
const directory = path.dirname(require.resolve("playwright-crx/package.json"));
assert.equal(JSON.parse(await fs.readFile(path.join(directory, "package.json"))).version, "0.15.0");
const entry = await fs.readFile(path.join(directory, "lib/index.mjs"), "utf8");
const upstream = await fs.readFile(path.join(directory, "lib", /from ["']\.\/([^"']+\.mjs)/.exec(entry)[1]), "utf8");
const patched = patchCrxNetworkWaitProof(upstream);
function slice(source, start, end) {
  assert.equal(source.split(start).length, 2, `unique pinned start ${start}`);
  const from = source.indexOf(start), to = source.indexOf(end, from);
  assert.ok(to > from, `pinned end ${end}`); return source.slice(from, to);
}
function fixture() {
  const requests = [], frames = new Map(), transport = { _tabToTarget: new Map([[7, {}]]), _sessions: new Map() };
  const context = { assert, Buffer, SdkObject: class {},
    stripFragmentFromUrl: value => value.split("#")[0], headersObjectToArray: value => Object.entries(value).map(([name, value]) => ({ name, value })),
    BrowserContext$1: { Events: { Request: "request" } } };
  const executable = slice(upstream, "class ManualPromise extends Promise {", "class LongStandingScope {") +
    slice(upstream, "let Request$1 = class Request extends SdkObject {", "let Response$1 =") +
    slice(patched, "let InterceptableRequest$1 = class InterceptableRequest {", "class RouteImpl {") +
    "class NetworkManager {\n" + slice(patched, "  _onRequestWillBeSent(sessionInfo, event) {", "  _onRequestServedFromCache(event) {") +
    slice(patched, "  _onRequest(requestWillBeSentSessionInfo, requestWillBeSentEvent, requestPausedSessionInfo, requestPausedEvent) {", "  _createResponse(request2, responsePayload, hasExtraInfo) {") + "}\n" +
    "class FrameManager {\n" + slice(upstream, "  requestStarted(request2, route) {\n    const frame = request2.frame();", "  requestReceivedResponse(response2) {") + "}\n" +
    networkWaitProofBridge.replace("export function captureOpenBrowserUseNetworkWaitRequest", "function captureOpenBrowserUseNetworkWaitRequest") +
    "\n({ NetworkManager, FrameManager, captureOpenBrowserUseNetworkWaitRequest, observeOpenBrowserUseNetworkDocument });";
  const runtime = vm.runInNewContext(executable, context);
  const page = { browserContext: {}, isClosed: () => false, emitOnContext: (_name, request) => requests.push(request) };
  const frameManager = new runtime.FrameManager();
  Object.assign(frameManager, { _page: page, frame: id => frames.get(id), _inflightRequestStarted() {} }); page.frameManager = frameManager;
  const manager = new runtime.NetworkManager();
  Object.assign(manager, { _page: page, _requestIdToRequest: new Map(), _requestIdToRequestPausedEvent: new Map(), _requestIdToRequestWillBeSentEvent: new Map(),
    _handleRequestRedirect() {} });
  const connection = { _transport: transport };
  const session = { _connection: connection, _sessionId: "crx-tab-7" };
  const addFrame = (id, url, parent = null) => {
    const frame = { _id: id, _url: url, _page: page, _currentDocument: { documentId: `loader-${id}` }, _pendingDocument: undefined, detached: false,
      url() { return this._url; }, parentFrame: () => parent, isDetached() { return this.detached; },
      pendingDocument() { return this._pendingDocument; }, setPendingDocument(value) { this._pendingDocument = value; } };
    frames.set(id, frame); return frame;
  };
  const root = addFrame("root", "https://allowed.test/original");
  const send = (extra = {}, nativeSession = session) => {
    const native = { requestId: `native-${requests.length + 1}`, frameId: "root", loaderId: root._currentDocument.documentId,
      documentURL: root.url(), timestamp: 1, wallTime: 1, type: "Fetch", request: { url: "https://allowed.test/api", method: "POST", headers: {} }, ...extra };
    manager._onRequestWillBeSent({ session: nativeSession }, native);
    return native;
  };
  const client = request => ({ _toImpl: () => request });
  const capture = (request = requests.at(-1), originalPage = page) => runtime.captureOpenBrowserUseNetworkWaitRequest(client(request), client(originalPage));
  return { ...runtime, manager, root, page, frames, requests, transport, session, connection, addFrame, send, capture };
}

test("pinned patch requires native event, request constructor, dispatcher mapping and pending-document boundaries", () => {
  for (const anchor of ["  _onRequestWillBeSent(sessionInfo, event) {", "    this.request = new Request$1(context, frame, serviceWorker,", "      if (debugLogger.isEnabled(`chromedebugger`))", "clientConnection.toImpl = (x) => x ? dispatcherConnection._dispatcherByGuid.get(x._guid)._object", "    frame.setPendingDocument({ documentId: request2._documentId, request: request2 });"])
    assert.throws(() => patchCrxNetworkWaitProof(upstream.replace(anchor, "changed")), /shape changed/);
  assert.throws(() => patchCrxNetworkWaitProof(patched), /shape changed/);
});

test("real pinned request creation captures original source before a response or changed frame URL", () => {
  const f = fixture(); f.send(); const original = f.requests[0];
  f.root._url = "https://allowed.test/later-spa";
  const proof = f.capture(original);
  assert.equal(proof.frameUrl, "https://allowed.test/original");
  assert.ok(proof.urls.includes("https://allowed.test/original"));
  assert.equal(proof.urls.includes("https://allowed.test/later-spa"), false);
  assert.equal(f.requests.length, 1); assert.ok(Object.isFrozen(proof)); proof.check();
});

test("delayed Request construction retains original native-event document, including document.open", () => {
  for (const mutate of [f => { f.root._currentDocument = { documentId: "replacement" }; }, f => {
    f.observeOpenBrowserUseNetworkDocument(f.transport, 7, "Page.documentOpened", { frame: { id: "root" } });
  }]) {
    const f = fixture(); f.manager._protocolRequestInterceptionEnabled = true;
    const event = f.send(); assert.equal(f.requests.length, 0); mutate(f);
    f.manager._onRequest({ session: f.session }, event, undefined, undefined);
    assert.throws(() => f.capture(), /OBU_SITE_ACCESS_UNVERIFIED/);
  }
});

test("same URL successor document, frame replacement and original Page/attachment loss cannot rebind", () => {
  for (const mutate of [f => { f.root._currentDocument = { documentId: "loader-root" }; }, f => { f.root.detached = true; },
    f => { f.frames.set("root", { ...f.root }); }, f => { f.transport._tabToTarget.set(7, {}); }, f => { f.connection._closed = true; }]) {
    const f = fixture(); f.send(); const proof = f.capture(); mutate(f); assert.throws(proof.check, /OBU_SITE_ACCESS_UNVERIFIED/);
  }
  const f = fixture(); f.send(); assert.throws(() => f.capture(f.requests[0], {}), /OBU_SITE_ACCESS_UNVERIFIED/);
});

test("native navigation and redirect hops allow only their original loader pending-to-current transition", () => {
  const f = fixture();
  f.send({ requestId: "navigation", loaderId: "navigation", type: "Document" });
  const before = f.capture();
  f.send({ requestId: "navigation", loaderId: "navigation", type: "Document", redirectResponse: {},
    request: { url: "https://second.test/final", method: "GET", headers: {} } });
  const after = f.capture();
  assert.ok(after.urls.includes("https://allowed.test/api")); assert.ok(after.urls.includes("https://second.test/final"));
  before.check(); after.check();
  f.root._currentDocument = f.root._pendingDocument; f.root._pendingDocument = undefined; f.root._url = "https://second.test/final";
  before.check(); after.check();
  f.root._currentDocument = { documentId: "next-loader" }; assert.throws(after.check, /OBU_SITE_ACCESS_UNVERIFIED/);
});

test("original OOPIF route migration is allowed while the original logical Page and document remain", () => {
  const f = fixture(), child = f.addFrame("child", "https://child.test/form", f.root);
  f.transport._sessions.set("oopif", 7);
  f.send({ frameId: "child", loaderId: child._currentDocument.documentId, documentURL: child.url() }, { _connection: f.connection, _sessionId: "oopif" });
  const proof = f.capture(); f.transport._sessions.delete("oopif"); proof.check();
  f.root._currentDocument = { documentId: "new-parent" }; assert.throws(proof.check, /OBU_SITE_ACCESS_UNVERIFIED/);
});

test("worker/unknown native loaders fail closed but a page request may be served by a worker", () => {
  for (const extra of [{ loaderId: "" }, { documentURL: "" }, { loaderId: "wrong-loader" }]) {
    const f = fixture(); f.send(extra); assert.equal(f.requests.length, 1); assert.throws(() => f.capture(), /OBU_SITE_ACCESS_UNVERIFIED/);
  }
  const f = fixture(); f.send(); f.requests[0]._fromServiceWorker = true; assert.doesNotThrow(() => f.capture());
});

test("inherited blank/srcdoc frame sources retain original authorized ancestors without URL substitution", () => {
  for (const url of ["about:blank", "about:srcdoc"]) {
    const f = fixture(), child = f.addFrame("child", url, f.root);
    f.send({ frameId: "child", loaderId: child._currentDocument.documentId, documentURL: url });
    const proof = f.capture(); assert.equal(proof.frameUrl, url);
    assert.deepEqual([...proof.urls], ["https://allowed.test/api", "https://allowed.test/api", "https://allowed.test/original"]);
    f.root._currentDocument = { documentId: "replacement" }; assert.throws(proof.check, /OBU_SITE_ACCESS_UNVERIFIED/);
  }
});

test("original redirect ancestry is bounded and cannot be replaced by a later Request", () => {
  const f = fixture(); f.send(); const original = f.requests[0], proof = f.capture();
  original._redirectedFrom = original;
  assert.throws(proof.check, /OBU_SITE_ACCESS_UNVERIFIED/); assert.throws(() => f.capture(), /OBU_SITE_ACCESS_UNVERIFIED/);
});
