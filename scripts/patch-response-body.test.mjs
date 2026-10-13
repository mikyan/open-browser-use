import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { patchCrxTransport } from "./build-chrome-extension.mjs";
import { patchCrxDiagnostics } from "./patch-diagnostics.mjs";
import { responseBodyBridge, patchCrxResponseBody } from "./patch-response-body.mjs";

const require = createRequire(new URL("../apps/chrome-extension/package.json", import.meta.url));
const directory = path.dirname(require.resolve("playwright-crx/package.json"));
const entry = await fs.readFile(path.join(directory, "lib/index.mjs"), "utf8");
const chunk = /from ["']\.\/([^"']+\.mjs)/.exec(entry)[1];
const upstream = await fs.readFile(path.join(directory, "lib", chunk), "utf8");
const guarded = patchCrxDiagnostics(patchCrxTransport(upstream)), patched = patchCrxResponseBody(guarded);
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const flush = () => new Promise(resolve => setImmediate(resolve));
function slice(source, start, end) {
  assert.equal(source.split(start).length, 2, `Pinned boundary must be unique: ${start}`);
  const from = source.indexOf(start), to = source.indexOf(end, from);
  assert.ok(to > from, `Pinned boundary end missing: ${end}`);
  return source.slice(from, to);
}

function fixture() {
  const sent = [], records = [], native = { send: async () => ({ body: "", base64Encoded: false }) }, admission = { wait: null };
  const context = { assert, Buffer, eventsExports: { EventEmitter },
    SdkObject: class {}, headersObjectToArray: value => Object.entries(value).map(([name, value]) => ({ name, value: String(value) })),
    helper: { secondsToRoundishMillis: value => value * 1000 },
    openBrowserUseInputHooks: { send: async (_target, _method, _params, operation) => { if (admission.wait) await admission.wait; return operation(); } },
    openBrowserUseCommandObserver: undefined, observeCrxInputCommand() { throw new Error("unexpected input observer"); },
    chrome: { debugger: { sendCommand: (target, method, params) => { sent.push({ target, method, params }); return native.send(target, method, params); } } },
    debugLogger: { isEnabled: () => false, log() {} }, ProtocolError: class extends Error { setMessage(value) { this.message = value; } }
  };
  // Execute the actual pinned Response, CRSession, response/finish/failure and
  // transport methods. Only chrome.debugger and the surrounding Page are fakes.
  const source = slice(upstream, "class ManualPromise extends Promise {", "class LongStandingScope {") +
    slice(upstream, "let Response$1 = class Response extends SdkObject {", "let WebSocket$1 =") +
    slice(upstream, "class CRSession extends", "let CDPSession$1 =") +
    "\nclass NativeTransport {\n" + slice(guarded, "  async _send(debuggee, method, commandParams, diagnosticGuard) {", "  _emitMessage(message) {") + "}\n" +
    "class NetworkManager {\n" + slice(patched, "  _createResponse(request2, responsePayload, hasExtraInfo) {", "\nlet InterceptableRequest$1 =") +
    responseBodyBridge.replace("export function createOpenBrowserUseResponseBodyRead", "function createOpenBrowserUseResponseBodyRead") +
    "\n({NetworkManager, NativeTransport, CRSession, createOpenBrowserUseResponseBodyRead});";
  const runtime = vm.runInNewContext(source, context);
  const transport = new runtime.NativeTransport();
  transport._tabToTarget = new Map([[7, { targetId: "original-target" }]]); transport._sessions = new Map();
  const connection = { _transport: transport, _sessions: new Map(), _rawSend() { throw new Error("body must bypass channel/CRSession send"); } };
  const session = id => {
    const result = new runtime.CRSession(connection, null, id); connection._sessions.set(id, result);
    if (id !== "crx-tab-7") transport._sessions.set(id, 7);
    return result;
  };
  const root = session("crx-tab-7"), manager = new runtime.NetworkManager();
  Object.assign(manager, { _page: { frameManager: { reportRequestFinished() {}, requestFailed() {}, requestReceivedResponse() {} } },
    _responseExtraInfoTracker: { servedFromCache: () => false, loadingFinished() {}, loadingFailed() {},
      processResponse: (_id, response) => { response.setResponseHeadersSize(0); response.setRawResponseHeaders(null); } },
    _requestIdToRequest: new Map(), _attemptedAuthentications: new Set() });
  function response({ id = `native-${records.length + 1}`, client = root, status = 200, headers = { "Content-Length": "14" } } = {}) {
    const request = { _failureText: null, _redirectedTo: null, _context: {}, _response: null,
      frame: () => ({ _id: "frame" }), url: () => "https://fixture.invalid/same-url", _setResponse(value) { this._response = value; },
      _existingResponse() { return this._response; }, _setFailureText(value) { this._failureText = value; } };
    const original = { session: client, request, _requestId: id, _documentId: id, _timestamp: 1, _wallTime: 10 };
    manager._requestIdToRequest.set(id, original);
    const server = manager._createResponse(original, { status, statusText: "fixture", headers }, false);
    const value = { original, server, client: { _toImpl: () => server } }; records.push(value); return value;
  }
  const finish = async (value, client = value.original.session) => {
    manager._onLoadingFinished({ session: client, isMain: client === root }, { requestId: value.original._requestId, timestamp: 2, encodedDataLength: 20 });
    await flush();
  };
  return { ...runtime, transport, connection, session, root, manager, response, finish, sent, native, admission };
}

test("patch requires exact response/terminal/session mapping and a final native dispatch guard", () => {
  assert.throws(() => patchCrxResponseBody(upstream), /shape changed/);
  for (const anchor of ["    const response2 = new Response$1(request2.request, responsePayload.status,", "    const response2 = this._createResponse(request2, responsePayload, hasExtraInfo);", "this._maybeUpdateRequestSession(sessionInfo, request2);", "diagnosticGuard?.();", "clientConnection.toImpl = (x) => x ? dispatcherConnection._dispatcherByGuid.get(x._guid)._object"])
    assert.throws(() => patchCrxResponseBody(guarded.replace(anchor, "changed")), /shape changed/);
  assert.match(patched, /bindOpenBrowserUseResponse\(response2, request2\)/);
});

test("original empty response never invokes pinned loadNetworkResource fallback even with nonzero Content-Length", async () => {
  const f = fixture(), value = f.response(); await f.finish(value);
  const reader = f.createOpenBrowserUseResponseBodyRead(value.client);
  assert.equal(reader.finished, value.server._finishedPromise);
  assert.deepEqual(await reader.read(() => {}), { body: "", base64Encoded: false });
  assert.deepEqual(f.sent.map(call => call.method), ["Network.getResponseBody"]);
  assert.equal(f.sent[0].params.requestId, value.original._requestId);
  await assert.rejects(reader.read(() => {}), /already attempted/); assert.equal(f.sent.length, 1);
});

test("two same-URL responses read their own native request IDs without URL lookup", async () => {
  const f = fixture(), first = f.response(), second = f.response();
  await f.finish(first); await f.finish(second);
  await f.createOpenBrowserUseResponseBodyRead(second.client).read(() => {});
  await f.createOpenBrowserUseResponseBodyRead(first.client).read(() => {});
  assert.deepEqual(f.sent.map(call => call.params.requestId), ["native-2", "native-1"]);
});

test("redirect reused native ID and failed request are terminal but cannot expose successor or partial bytes", async () => {
  const f = fixture(), redirect = f.response({ id: "reused", status: 302 });
  redirect.server._requestFinished(1); redirect.original.request._redirectedTo = {};
  const next = f.response({ id: "reused" }); await f.finish(next);
  await assert.rejects(f.createOpenBrowserUseResponseBodyRead(redirect.client).read(() => {}), /UNAVAILABLE/);
  await f.createOpenBrowserUseResponseBodyRead(next.client).read(() => {}); assert.equal(f.sent.length, 1);
  const failed = f.response({ id: "failed" });
  f.manager._onLoadingFailed({ session: f.root, isMain: true }, { requestId: "failed", timestamp: 3, errorText: "failed original" });
  await flush();
  assert.equal(failed.server._finishedPromise.isDone(), true);
  await assert.rejects(f.createOpenBrowserUseResponseBodyRead(failed.client).read(() => {}), /RESPONSE_BODY_FAILED/);
  assert.equal(f.sent.length, 1);
});

test("actual pinned loadingFinished session migration binds OOPIF terminal route", async () => {
  const f = fixture(), value = f.response(), child = f.session("original-oopif");
  const reader = f.createOpenBrowserUseResponseBodyRead(value.client);
  await f.finish(value, child);
  assert.equal(value.original.session, child);
  await reader.read(() => {});
  assert.equal(f.sent[0].target.tabId, 7); assert.equal(f.sent[0].target.sessionId, "original-oopif");
});

test("300/304 without an actual redirect read Chromium's original body instead of fabricating empty data", async () => {
  for (const status of [300, 304]) {
    const f = fixture(), value = f.response({ status });
    f.native.send = async () => ({ body: "native retained bytes", base64Encoded: false });
    await f.finish(value);
    assert.deepEqual(await f.createOpenBrowserUseResponseBodyRead(value.client).read(() => {}), { body: "native retained bytes", base64Encoded: false });
    assert.deepEqual(f.sent.map(call => call.method), ["Network.getResponseBody"]);
  }
  const f = fixture(), value = f.response({ status: 304 }); await f.finish(value);
  f.native.send = async () => { throw new Error("native cache has no body"); };
  await assert.rejects(f.createOpenBrowserUseResponseBodyRead(value.client).read(() => {}), /UNAVAILABLE/);
  assert.equal(f.sent.length, 1);
});

test("pinned redirect terminal rejects even before a successor Request object is available", async () => {
  const f = fixture(), value = f.response({ id: "reused-redirect" });
  f.manager._handleRequestRedirect(value.original, { status: 302, statusText: "Found", headers: {} }, 2, false);
  const redirect = value.original.request._existingResponse();
  await flush(); assert.equal(value.original.request._redirectedTo, null);
  await assert.rejects(f.createOpenBrowserUseResponseBodyRead({ _toImpl: () => redirect }).read(() => {}), /UNAVAILABLE/);
  assert.equal(f.sent.length, 0);
});

test("late capture rejects replacement target or foreign migrated session instead of rebinding", async () => {
  for (const mutation of [f => { f.transport._tabToTarget.set(7, { targetId: "replacement" }); }, f => {
    const child = f.session("foreign"); f.transport._sessions.set("foreign", 8); f.transport._tabToTarget.set(8, {}); return child;
  }]) {
    const f = fixture(), value = f.response(), next = mutation(f);
    await f.finish(value, next || f.root);
    await assert.rejects(f.createOpenBrowserUseResponseBodyRead(value.client).read(() => {}), /EXPIRED/); assert.equal(f.sent.length, 0);
  }
});

test("closed or replaced original native sessions never fall through to a current successor", async () => {
  for (const mutation of [f => f.root.dispose(), f => f.session("crx-tab-7"), f => f.transport._tabToTarget.set(7, {}), f => { f.connection._closed = true; }]) {
    const f = fixture(), value = f.response(); await f.finish(value);
    const reader = f.createOpenBrowserUseResponseBodyRead(value.client); mutation(f);
    await assert.rejects(reader.read(() => {}), /EXPIRED/); assert.equal(f.sent.length, 0);
  }
});

test("original guard executes after asynchronous backend admission, before actual native body send", async () => {
  const f = fixture(), value = f.response(), gate = deferred(); await f.finish(value);
  f.admission.wait = gate.promise;
  let allowed = true;
  const reading = f.createOpenBrowserUseResponseBodyRead(value.client).read(() => { if (!allowed) throw new Error("OBU_RESPONSE_BODY_EXPIRED: old scope"); });
  await flush(); assert.equal(f.sent.length, 0); allowed = false; gate.resolve();
  await assert.rejects(reading, /old scope/); assert.equal(f.sent.length, 0);
});

test("actual native body promise remains pending when original CRSession is disposed early", async () => {
  const f = fixture(), value = f.response(), native = deferred(); await f.finish(value);
  f.native.send = () => native.promise; let settled = false;
  const reading = f.createOpenBrowserUseResponseBodyRead(value.client).read(() => {});
  reading.then(() => { settled = true; }, () => { settled = true; });
  await flush(); assert.equal(f.sent.length, 1); f.root.dispose(); await flush();
  assert.equal(settled, false, "channel/session close is not original native completion");
  native.resolve({ body: "late", base64Encoded: false }); await assert.rejects(reading, /EXPIRED/);
  assert.equal(settled, true); assert.equal(f.sent.length, 1);
});

test("evicted native data fails once with bounded text and never enters refetch or stream APIs", async () => {
  const f = fixture(), value = f.response(); await f.finish(value);
  f.native.send = async () => { throw new Error("PRIVATE_BODY must not appear in outgoing error"); };
  const reader = f.createOpenBrowserUseResponseBodyRead(value.client);
  await assert.rejects(reader.read(() => {}), error => /UNAVAILABLE/.test(error.message) && !error.stack.includes("PRIVATE_BODY"));
  await assert.rejects(reader.read(() => {}), /already attempted/);
  assert.deepEqual(f.sent.map(call => call.method), ["Network.getResponseBody"]);
});

test("disposed client-to-server mapping and unknown responses fail with bounded unavailable errors", () => {
  const f = fixture();
  for (const value of [undefined, { _toImpl: () => ({}) }, { _toImpl() { throw new Error("private dispatcher details"); } }])
    assert.throws(() => f.createOpenBrowserUseResponseBodyRead(value), error => /RESPONSE_BODY_UNAVAILABLE/.test(error.message) && !error.stack.includes("private dispatcher details"));
  assert.equal(f.sent.length, 0);
});
