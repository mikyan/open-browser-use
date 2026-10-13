import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import http from "node:http";
import test from "node:test";
import { listenFixture } from "./fixture-listener.mjs";
import { createRestrictedDiagnosticsFixtures, restrictedDiagnosticsURL, restrictedDiagnosticsAPIURL, runRestrictedDiagnosticsWireCaller, checkRestrictedDiagnosticsCaller, checkRestrictedDiagnosticsEvidence, installRestrictedDiagnosticsEvidence, checkRestrictedDiagnosticsBoundaryEvidence } from "./site-access-diagnostics-fixture.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const scope = { session_id: "original-session", turn_id: "original-turn", control_epoch: 7 };
const config = { key: "original-js-root", layout: "root", value: "original π", tabId: 41, scope, apiURL: "http://127.0.0.1:49152/restricted-diagnostics/api?key=original-js-root&layout=root" };

function evidence() {
  const href = restrictedDiagnosticsURL("http://127.0.0.1:49152/", config.key), token = "original-document-token";
  const events = [["input", "note"], ["click", "save"], ["submit", "form"]].map(([type, targetId]) => ({ type, targetId, trusted: true }));
  const value = { key: config.key, layout: "root", documentToken: token, nodeToken: `${token}-note`, href, value: config.value, trustedSubmit: true, events }, bytes = Buffer.from(JSON.stringify(value));
  const responseValue = { key: config.key, nonce: "original-secret-never-in-dom", documentToken: token, note: config.value, bodySHA256: hash(bytes) }, responseBytes = Buffer.from(JSON.stringify(responseValue));
  const post = { value, bodyBytes: bytes.length, bodyBase64: bytes.toString("base64"), bodySHA256: hash(bytes), responseValue, responseBytes: responseBytes.length, responseBase64: responseBytes.toString("base64"), responseSHA256: hash(responseBytes), status: 201, finishedAt: 1 };
  const state = { documentToken: token, original: true, overflow: false, errors: [], href, value: config.value, nodeToken: value.nodeToken, events, receipt: { status: 201, url: config.apiURL, bytes: responseBytes.length }, visibleText: `Saved ${config.key}` };
  const ref = { captureId: "original-capture", requestId: "diag-request-1" }, initial = { captureId: ref.captureId, entries: [], cursor: { captureId: ref.captureId, sequence: 0 }, dropped: 0 };
  const metadata = { requestId: ref.requestId, url: config.apiURL, method: "POST", frameUrl: href, resourceType: "fetch" };
  const capture = { ...initial, entries: [{ kind: "console", type: "log", text: `Original diagnostics console ${config.key}`, location: { url: href } }, { kind: "pageerror", name: "Error", message: `Original diagnostics error ${config.key}`, stack: `Error at ${href}` }, { kind: "request", ...metadata }, { kind: "response", ...metadata, status: 201 }, { kind: "requestfinished", ...metadata }], cursor: { captureId: ref.captureId, sequence: 5 } };
  const source = { tabId: config.tabId }, nativeRows = [
    { method: "Runtime.executionContextCreated", params: { context: { id: 13, auxData: { frameId: "root-target", isDefault: true } } } },
    { method: "Runtime.consoleAPICalled", params: { executionContextId: 13, args: [{ value: `Original diagnostics console ${config.key}` }] } },
    { method: "Runtime.exceptionThrown", params: { exceptionDetails: { executionContextId: 13, exception: { description: `Error: Original diagnostics error ${config.key}` } } } },
    { method: "Network.requestWillBeSent", params: { requestId: "native-1", loaderId: "original-loader", frameId: "root-target", request: { url: config.apiURL, method: "POST", postData: bytes.toString("utf8") } } },
    { method: "Network.responseReceived", params: { requestId: "native-1", response: { url: config.apiURL, status: 201 } } }, { method: "Network.loadingFinished", params: { requestId: "native-1" } }
  ].map((row, index) => ({ ...row, sequence: index + 1, source: { ...source } }));
  const item = { ...config, before: { documents: [{ documentId: "native-document", result: { documentToken: token } }] }, after: { documents: [{ documentId: "native-document", result: state }], targets: [{ tabId: config.tabId, type: "page", id: "root-target" }] },
    callerResult: { scope, tabId: config.tabId, initial, capture, reference: ref, receipt: `Saved ${config.key}`, body: { ...ref, encoding: "base64", data: responseBytes.toString("base64"), byteLength: responseBytes.length }, decoded: responseValue },
    nativeEvidence: { rows: nativeRows, overflow: false, restored: true, removed: true }, bodyProbe: { overflow: false, pending: 0, restored: true, expired: false, rows: [
      { kind: "request", sequence: 1, message: { id: "rpc-1", params: { ...scope, args: { ...ref, maxBytes: 65536 } } } },
      { kind: "native", sequence: 2, source, params: { requestId: "native-1" } }, { kind: "native-ack", sequence: 3, call: 2, result: { body: responseBytes.toString("utf8"), base64Encoded: false } }, { kind: "delivered", sequence: 4, call: 2 }, { kind: "response", sequence: 5, id: "rpc-1", ok: true }
    ] } };
  return { item, record: { documents: [{ documentToken: token, child: false, href }], posts: [post] } };
}

test("original diagnostics, native context/route, POST and original body bytes form one proof", () => {
  const original = evidence(); assert.equal(checkRestrictedDiagnosticsEvidence(original.item, original.record).nativeReads, 1);
  for (const mutate of [x => x.record.posts.push(structuredClone(x.record.posts[0])), x => x.record.posts[0].bodySHA256 = "changed", x => x.item.callerResult.reference.requestId = "request-1",
    x => x.item.after.documents[0].documentId = "new-doc", x => x.item.after.documents[0].result.events[0].trusted = false, x => x.item.after.documents[0].result.visibleText += x.record.posts[0].responseValue.nonce,
    x => x.item.nativeEvidence.rows[0].params.context.auxData.frameId = "foreign", x => x.item.nativeEvidence.rows[2].params.exceptionDetails.executionContextId = 99,
    x => x.item.nativeEvidence.rows[1].source.sessionId = "foreign", x => x.item.bodyProbe.rows[1].params.requestId = "other", x => x.item.bodyProbe.rows[2].result.body = "{}",
    x => x.item.bodyProbe.rows.push({ kind: "alternative-native" }), x => x.item.bodyProbe.rows[0].message.params.control_epoch++, x => x.item.callerResult.capture.entries.pop(), x => x.item.callerResult.decoded.nonce = "made-up"]) {
    const copy = structuredClone(original); mutate(copy); assert.throws(() => checkRestrictedDiagnosticsEvidence(copy.item, copy.record));
  }
});

test("wire caller captures before input, preserves scope and uses the original response ref", async () => {
  const { item } = evidence(), calls = [];
  const result = await runRestrictedDiagnosticsWireCaller(async (method, params) => { calls.push({ method, params });
    if (params.action === "diagnostics") return { value: calls.length === 1 ? item.callerResult.initial : item.callerResult.capture };
    if (params.action === "responseBody") return { value: item.callerResult.body };
    if (params.action === "textContent") return { value: item.callerResult.receipt }; return { value: null };
  }, config);
  assert.deepEqual(calls.map(row => row.params.action), ["diagnostics", "fill", "click", "waitFor", "textContent", "diagnostics", "responseBody"]);
  for (const row of calls) { assert.equal(row.method, "browserAction"); assert.equal(row.params.tabId, config.tabId); for (const [key, value] of Object.entries(scope)) assert.equal(row.params[key], value); }
  assert.deepEqual(calls.at(-1).params.args, { ...item.callerResult.reference, maxBytes: 65536 }); assert.equal(calls.at(-1).params.locator, undefined); assert.deepEqual(result.decoded, item.callerResult.decoded);
});

test("drop counters retain their limited meaning without allowing missing business or unrelated metadata", () => {
  const original = evidence(); original.item.callerResult.initial.dropped = 2; original.item.callerResult.capture.dropped = 4;
  assert.equal(checkRestrictedDiagnosticsEvidence(original.item, original.record).dropped.delta, 2);
  for (const mutate of [x => x.item.callerResult.capture.dropped = 1, x => x.item.callerResult.capture.entries.splice(0, 1),
    x => x.item.callerResult.capture.entries.push({ kind: "response", url: "https://foreign.invalid/secret", status: 200 })]) {
    const copy = structuredClone(original); mutate(copy); assert.throws(() => checkRestrictedDiagnosticsEvidence(copy.item, copy.record));
  }
});

test("original diagnostics denial stops before all page input and preserves its first error", async () => {
  const failure = Error("OBU_SITE_ACCESS_UNSUPPORTED: original production"), calls = [], detail = {};
  await assert.rejects(runRestrictedDiagnosticsWireCaller(async (method, params) => { calls.push(params); throw failure; }, { ...config, layout: "dynamic-oopif" }, detail), error => error === failure);
  assert.equal(calls.length, 1); assert.equal(calls[0].action, "diagnostics"); assert.match(detail.error, /original production/); assert.equal(detail.body, undefined);
});

test("passive native evidence preserves original context and event order and removes listener", () => {
  const listeners = new Set(), api = { debugger: { onEvent: { addListener: x => listeners.add(x), removeListener: x => listeners.delete(x), hasListener: x => listeners.has(x) } } }, target = {};
  installRestrictedDiagnosticsEvidence(api, target, 41); const send = [...listeners][0];
  send({ tabId: 99 }, "Runtime.consoleAPICalled", { executionContextId: 9 }); send({ tabId: 41 }, "Runtime.executionContextCreated", { context: { id: 9, auxData: { frameId: "frame" } } }); send({ tabId: 41 }, "Runtime.consoleAPICalled", { executionContextId: 9, args: [{ value: "original" }] });
  const result = target.__restrictedDiagnosticsEvidence.stop(); assert.deepEqual(result.rows.map(row => [row.sequence, row.method]), [[1, "Runtime.executionContextCreated"], [2, "Runtime.consoleAPICalled"]]); assert.equal(result.rows[1].params.executionContextId, 9); assert.equal(result.removed, true); assert.equal(result.restored, true); assert.equal(listeners.size, 0);
});

test("fixture uses actual localhost child origin and rejects an unrelated Host", () => {
  const fixtures = createRestrictedDiagnosticsFixtures(), request = new EventEmitter(); Object.assign(request, { method: "GET", url: "/restricted-diagnostics/frame?key=child-original&layout=oopif", headers: { host: "localhost:49152" } });
  let status; const response = { writeHead: value => { status = value; }, end() {} };
  assert.equal(fixtures.handle(request, response, new URL(request.url, "http://127.0.0.1:49152")), true); assert.equal(status, 200);
  const doc = fixtures.stats("child-original").documents[0]; assert.equal(new URL(doc.href).hostname, "localhost"); assert.equal(new URL(doc.apiURL).hostname, "localhost");
  request.headers.host = "foreign.invalid:49152"; fixtures.handle(request, response, new URL(request.url, "http://127.0.0.1:49152")); assert.equal(status, 400);
});

test("HTTP ledger retains unique original POST and server-only nonce with exact response bytes", async () => {
  const fixtures = createRestrictedDiagnosticsFixtures(); const server = http.createServer((req, res) => { if (!fixtures.handle(req, res, new URL(req.url, `http://127.0.0.1:${server.address().port}`))) { res.writeHead(404); res.end(); } });
  try {
    const port = await listenFixture(server), url = restrictedDiagnosticsURL(`http://127.0.0.1:${port}/`, "real-original"); const html = await (await fetch(url)).text();
    const doc = fixtures.stats("real-original").documents[0], value = { key: doc.key, href: doc.href, documentToken: doc.documentToken, trustedSubmit: true, value: "π", events: [] }, body = JSON.stringify(value);
    const response = await fetch(restrictedDiagnosticsAPIURL(url), { method: "POST", body }); const bytes = Buffer.from(await response.arrayBuffer()), parsed = JSON.parse(bytes);
    const post = fixtures.stats(doc.key).posts[0]; assert.equal(response.status, 201); assert.equal(fixtures.stats(doc.key).posts.length, 1); assert.equal(post.bodyBase64, Buffer.from(body).toString("base64")); assert.equal(post.responseBase64, bytes.toString("base64")); assert.equal(post.responseSHA256, hash(bytes)); assert.equal(html.includes(parsed.nonce), false); assert.equal(parsed.bodySHA256, hash(Buffer.from(body)));
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test("orchestrator retains original before/after and zero POST after readiness denial", async () => {
  const original = Error("OBU_SITE_ACCESS_UNSUPPORTED: original production"), detail = {}, page = { documents: [{ documentId: "original-doc", result: { documentToken: "original-token" } }] };
  let inputs = 0, nativeRestored = 0; const tab = { id: 41, goto: async () => {}, diagnostics: async () => { throw original; }, locator: () => ({ click: () => inputs++ }) };
  const worker = { async evaluate(script) { if (script.includes(".pending===0")) return true; if (script.includes(".restore()")) { nativeRestored++; return { restored: true }; } if (script.includes(".stop()")) return { restored: true, removed: true }; if (script.includes("const observer=")) return page; return {}; } };
  await assert.rejects(checkRestrictedDiagnosticsCaller({ kind: "js", browser: { newTab: async () => tab, client: { sessionId: scope.session_id, turnId: scope.turn_id, controlEpoch: scope.control_epoch } }, fixtureURL: "http://127.0.0.1:49152/", fixtures: { stats: () => ({ posts: [] }), allStats: () => [{ posts: [] }] }, getWorker: () => worker, until: callback => callback(), detail }), error => error === original);
  assert.equal(detail.variants.length, 1); assert.deepEqual(detail.variants[0].before, page); assert.deepEqual(detail.variants[0].after, page); assert.equal(detail.variants[0].server.posts.length, 0); assert.equal(inputs, 0); assert.equal(nativeRestored, 1); assert.match(detail.variants[0].callerResult.error, /original production/);
});

function boundaryEvidence() {
  const { item, record } = evidence();
  Object.assign(item, { name: "late-native-policy", mode: "normal", url: record.documents[0].href, server: record, submitted: true,
    rejections: [{ authority: "timeout", error: "OBU_RESPONSE_BODY_TIMEOUT: original deadline" }, { authority: "control", error: "OBU_STALE_CONTROL_EPOCH: original scope" }], reads: [{ reference: item.callerResult.reference, nativeRequestId: "native-1" }], reference: item.callerResult.reference, capture: item.callerResult.capture, receipt: item.callerResult.receipt,
    held: { pending: 1, held: true }, blocked: { inputBlocked: true, cleanupComplete: false }, applySettledWhileHeld: false, readStartedAt: 1000, expiredAt: 2000,
    policyChanged: { control: { cleanupComplete: true, inputBlocked: true } }, resume: { inputBlocked: false }, newScope: { ...scope, control_epoch: 8 } });
  item.bodyProbe.rows.at(-1).ok = false;
  item.before.documents[0].frameId = 0; Object.assign(item.before.documents[0].result, { original: true, events: [] }); item.after.documents[0].frameId = 0;
  record.redirects = []; return item;
}

test("boundary oracle binds original bytes/context/ACK and rejects generic failure as authority", () => {
  const original = boundaryEvidence(); assert.equal(checkRestrictedDiagnosticsBoundaryEvidence(original).posts, 1);
  for (const mutate of [x => x.rejections.push({ authority: "denied", error: "OBU_RESPONSE_BODY_FAILED: unrelated" }), x => x.rejections.push({ authority: "body", error: "OBU_RESPONSE_BODY_TIMEOUT: elapsed" }),
    x => x.rejections.push({ authority: "control", error: "OBU_SITE_ACCESS_DENIED: wrong fence" }), x => x.rejections.push({ authority: "denied", error: "OBU_SITE_ACCESS_DENIED", value: {} }),
    x => x.reads[0].nativeRequestId = "foreign", x => x.server.posts[0].bodySHA256 = "bad", x => x.nativeEvidence.rows[0].params.context.auxData.frameId = "foreign",
    x => x.bodyProbe.rows[2].result.body = "{}", x => x.server.posts.push(structuredClone(x.server.posts[0]))]) {
    const copy = structuredClone(original); mutate(copy); assert.throws(() => checkRestrictedDiagnosticsBoundaryEvidence(copy));
  }
});

test("denied third-party source needs actual native response and excludes public metadata", () => {
  const item = boundaryEvidence(); item.name = "third-party"; item.mode = "third-party"; item.reads = []; item.bodyProbe.rows = []; item.rejections = [];
  item.capture.entries = item.capture.entries.filter(row => !row.requestId); assert.equal(checkRestrictedDiagnosticsBoundaryEvidence(item).nativeReads, 0);
  for (const mutate of [x => x.capture.entries.push({ kind: "response", url: x.apiURL, requestId: "diag-leaked" }),
    x => x.nativeEvidence.rows = x.nativeEvidence.rows.filter(row => row.method !== "Network.responseReceived"), x => x.capture.entries.push({ kind: "console", text: x.server.posts[0].responseValue.nonce })]) {
    const copy = structuredClone(item); mutate(copy); assert.throws(() => checkRestrictedDiagnosticsBoundaryEvidence(copy));
  }
});

test("real requestfailed requires socket destruction and native failure, not a status code", () => {
  const item = boundaryEvidence(); item.name = "failed-original-request"; item.mode = "failed"; item.reads = []; item.bodyProbe.rows = []; item.rejections = [];
  const post = item.server.posts[0]; post.socketDestroyedAt = 12; delete post.finishedAt; const state = item.after.documents[0].result; state.receipt = null; state.errors = ["TypeError: Failed to fetch"];
  item.capture.entries = item.capture.entries.filter(row => row.kind !== "requestfinished"); item.capture.entries.push({ kind: "requestfailed", requestId: item.reference.requestId, failure: "net::ERR_INCOMPLETE_CHUNKED_ENCODING" });
  const row = item.nativeEvidence.rows.find(row => row.method === "Network.loadingFinished"); row.method = "Network.loadingFailed"; row.params.errorText = "net::ERR_INCOMPLETE_CHUNKED_ENCODING";
  item.rejections.push({ authority: "failed", error: "OBU_RESPONSE_BODY_FAILED: Original response failed" }); assert.equal(checkRestrictedDiagnosticsBoundaryEvidence(item).posts, 1);
  for (const mutate of [x => delete x.server.posts[0].socketDestroyedAt, x => x.server.posts[0].finishedAt = 13,
    x => x.nativeEvidence.rows.find(row => row.method === "Network.loadingFailed").method = "Network.loadingFinished", x => x.capture.entries.pop()]) {
    const copy = structuredClone(item); mutate(copy); assert.throws(() => checkRestrictedDiagnosticsBoundaryEvidence(copy));
  }
});

test("same URL replacement requires new document/loader and rejects retained old diagnostic metadata", () => {
  const item = boundaryEvidence(); item.name = "same-url-new-document"; item.navigated = true; item.beforeNavigation = structuredClone(item.after); item.reads = []; item.bodyProbe.rows = []; item.rejections = [];
  item.after.documents[0].documentId = "new-document"; Object.assign(item.after.documents[0].result, { documentToken: "new-token", events: [], errors: [], receipt: null });
  item.afterNavigationCapture = { entries: [] }; item.rejections.push({ authority: "body", error: "OBU_RESPONSE_BODY_EXPIRED: Original document changed" });
  item.nativeEvidence.rows.push(...["original-loader", "new-loader"].map(loaderId => ({ method: "Network.requestWillBeSent", source: { tabId: item.tabId }, params: { loaderId, frameId: "root-target", type: "Document", request: { method: "GET", url: item.url } } })), { method: "Page.frameNavigated", params: { frame: { id: "root-target", loaderId: "new-loader" } } });
  assert.equal(checkRestrictedDiagnosticsBoundaryEvidence(item).posts, 1);
  for (const mutate of [x => x.after.documents[0].documentId = "native-document", x => x.afterNavigationCapture.entries.push({ kind: "console", text: `Original diagnostics console ${x.key}` }),
    x => x.afterNavigationCapture.entries.push({ kind: "response", requestId: x.reference.requestId }), x => x.nativeEvidence.rows.at(-1).params.frame.loaderId = "old-loader", x => delete x.beforeNavigation]) {
    const copy = structuredClone(item); mutate(copy); assert.throws(() => checkRestrictedDiagnosticsBoundaryEvidence(copy));
  }
});

test("late ACK is original delivery held across timeout/Pause and cannot become a success", () => {
  const item = boundaryEvidence(); item.name = "late-native-policy"; delete item.reads[0].value; item.bodyProbe.rows.at(-1).ok = false;
  Object.assign(item, { held: { pending: 1, held: true }, blocked: { inputBlocked: true, cleanupComplete: false }, applySettledWhileHeld: false, readStartedAt: 1000, expiredAt: 2000,
    policyChanged: { control: { cleanupComplete: true, inputBlocked: true } }, resume: { inputBlocked: false }, newScope: { ...scope, control_epoch: 8 } });
  assert.equal(checkRestrictedDiagnosticsBoundaryEvidence(item).nativeReads, 1);
  for (const mutate of [x => x.applySettledWhileHeld = true, x => x.blocked.cleanupComplete = true, x => x.expiredAt = 1500, x => x.bodyProbe.rows.at(-1).ok = true, x => x.newScope.control_epoch = scope.control_epoch,
    x => x.rejections[0].error = "OBU_RESPONSE_BODY_FAILED: unrelated", x => x.bodyProbe.rows = x.bodyProbe.rows.filter(row => row.kind !== "native-ack")]) {
    const copy = structuredClone(item); mutate(copy); assert.throws(() => checkRestrictedDiagnosticsBoundaryEvidence(copy));
  }
});

test("HTTP redirect preserves original body while actual failed response is held then destroyed", async () => {
  const fixtures = createRestrictedDiagnosticsFixtures(); const server = http.createServer((req, res) => { if (!fixtures.handle(req, res, new URL(req.url, `http://127.0.0.1:${server.address().port}`))) { res.writeHead(404); res.end(); } });
  try {
    const port = await listenFixture(server), base = `http://127.0.0.1:${port}/`;
    const submit = async (key, mode) => { const url = restrictedDiagnosticsURL(base, key, "root", false, mode); await (await fetch(url)).text(); const doc = fixtures.stats(key).documents[0]; return fetch(restrictedDiagnosticsAPIURL(url), { method: "POST", body: JSON.stringify({ key, href: doc.href, documentToken: doc.documentToken, trustedSubmit: true, value: "original" }) }); };
    const redirected = await submit("redirect-original", "redirect-denied"), bytes = Buffer.from(await redirected.arrayBuffer()), ledger = fixtures.stats("redirect-original");
    assert.equal(redirected.status, 200); assert.equal(ledger.posts.length, 1); assert.deepEqual(ledger.redirects.map(row => row.status), [302, 200]); assert.equal(bytes.toString("base64"), ledger.posts[0].responseBase64);
    const failed = await submit("failed-original", "failed"); assert.equal(failed.status, 201); fixtures.fail("failed-original"); await assert.rejects(failed.arrayBuffer());
    const original = fixtures.stats("failed-original").posts[0]; assert.ok(original.socketDestroyedAt); assert.equal(original.finishedAt, undefined); assert.equal(fixtures.stats("failed-original").posts.length, 1);
  } finally { fixtures.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
