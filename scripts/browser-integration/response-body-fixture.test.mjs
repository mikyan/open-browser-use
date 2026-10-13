import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { createResponseBodyFixtures, responseBodyKinds, responseBodyBytes, checkOriginalResponseBody, checkResponseBodyEvidence, checkResponseBodyEdgesEvidence, installResponseBodyProbe, selectResponseBodyTargets, checkResponseBodyOOPIF, checkResponseBodyPauseFailure } from "./response-body-fixture.mjs";
import { createResponseBodyCaller } from "./response-body-callers.mjs";
import { listenFixture } from "./fixture-listener.mjs";

const hash = value => createHash("sha256").update(value).digest("hex"), tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
async function serverTest(run) {
  const fixture = createResponseBodyFixtures(), server = http.createServer((req, res) => { if (!fixture.handle(req, res, server.address().port)) { res.writeHead(404); res.end(); } });
  await listenFixture(server); const base = `http://127.0.0.1:${server.address().port}`;
  try { await run({ fixture, base }); } finally { fixture.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
async function page(base, key = "original", layout = "root") { const result = await fetch(`${base}/response-body/page?key=${key}&layout=${layout}`); assert.equal(result.status, 200); return result.text(); }
const payload = (fixture, key, kind, ordinal = 1) => ({ key, kind, ordinal, sequence: 1, nonce: fixture.stats(key).documents[0].nonce, documentToken: "original-document", href: "http://fixture/", trusted: true });
const send = (base, fixture, key, kind, ordinal = 1) => fetch(`${base}/response-body/api?key=${key}&kind=${kind}`, { method: "POST", body: JSON.stringify(payload(fixture, key, kind, ordinal)) });

test("real HTTP server preserves binary, Unicode, empty and 503 response bytes with one POST each", () => serverTest(async ({ fixture, base }) => {
  const html = await page(base); assert.match(html, /event\.isTrusted/); assert.match(html, /response\.arrayBuffer/);
  for (const kind of responseBodyKinds) { const response = await send(base, fixture, "original", kind); assert.equal(response.status, kind === "unavailable-status" ? 503 : 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), responseBodyBytes("original", kind)); }
  const stats = fixture.stats("original"); assert.deepEqual(stats.attempts.map(x => x.method), ["GET", "POST", "POST", "POST", "POST"]);
  for (const attempt of stats.attempts.slice(1)) { assert.ok(attempt.finishedAt); assert.equal(hash(Buffer.from(attempt.responseBase64, "base64")), attempt.responseSHA256); }
}));

test("body headers arrive before finish; explicit release route is recorded and releases original stream", () => serverTest(async ({ fixture, base }) => {
  await page(base); const response = await send(base, fixture, "original", "gate"); let settled = false;
  const body = response.arrayBuffer().then(bytes => { settled = true; return bytes; }); await tick(); assert.equal(settled, false);
  assert.ok(fixture.stats("original").attempts[1].headersAt); assert.equal(fixture.stats("original").attempts[1].finishedAt, undefined);
  const release = await fetch(`${base}/response-body/release?key=original`, { method: "POST", body: JSON.stringify({ trusted: true, documentToken: "original-document" }) }); await release.text();
  assert.deepEqual(Buffer.from(await body), responseBodyBytes("original", "gate")); assert.equal(fixture.stats("original").attempts[2].value.trusted, true);
}));

test("same URL original pair remains byte-distinct and redirect preserves original POST payload", () => serverTest(async ({ fixture, base }) => {
  await page(base); const pair = await Promise.all([1, 2].map(async ordinal => Buffer.from(await (await send(base, fixture, "original", "pair", ordinal)).arrayBuffer())));
  assert.notDeepEqual(pair[0], pair[1]); const response = await send(base, fixture, "original", "redirect"); assert.deepEqual(Buffer.from(await response.arrayBuffer()), responseBodyBytes("original", "redirect"));
  const attempts = fixture.stats("original").attempts.slice(-2); assert.deepEqual(attempts.map(x => x.method), ["POST", "POST"]); assert.equal(attempts[0].status, 307); assert.equal(attempts[1].status, 200); assert.equal(attempts[0].bodySHA256, attempts[1].bodySHA256);
}));

test("failed original stream is truly truncated, and denied GET re-fetch remains in the ledger", () => serverTest(async ({ fixture, base }) => {
  await page(base); await assert.rejects(async () => (await send(base, fixture, "original", "failed")).arrayBuffer());
  const denied = await fetch(`${base}/response-body/api?key=original&kind=binary`); assert.equal(denied.status, 405); await denied.text();
  assert.equal(fixture.stats("original").attempts.at(-1).method, "GET");
}));

test("server snapshots are independent and close releases only registered original gates", () => serverTest(async ({ fixture, base }) => {
  await page(base); const response = await send(base, fixture, "original", "gate"); const snapshot = fixture.stats("original"); snapshot.attempts.length = 0;
  assert.equal(fixture.stats("original").attempts.length, 2); fixture.close(); assert.deepEqual(Buffer.from(await response.arrayBuffer()), responseBodyBytes("original", "gate"));
}));

function nativeFixture() {
  const waiting = [], listeners = new Set(), target = {}, receiver = {}, calls = [];
  const api = { debugger: { sendCommand: function (...args) { calls.push({ receiver: this, args }); const d = deferred(); waiting.push(d); return d.promise; }, onEvent: { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) } } };
  const original = api.debugger.sendCommand, scope = { session_id: "owner", turn_id: "turn", control_epoch: 2 };
  installResponseBodyProbe(api, target, { tabId: 7, scope, id: "probe", holdTimeoutMs: 1000 });
  return { api, target, calls, waiting, receiver, original, scope, emit: (...args) => { for (const fn of listeners) fn(...args); } };
}
test("probe preserves native receiver, exact args, rejection identity and nonselected Promise identity", async () => {
  const f = nativeFixture(), target = { tabId: 8 }, params = { requestId: "original" };
  const pass = f.api.debugger.sendCommand.call(f.receiver, target, "Network.getResponseBody", params); assert.equal(pass, f.waiting[0].promise); assert.equal(f.calls[0].receiver, f.receiver); assert.equal(f.calls[0].args[0], target); assert.equal(f.calls[0].args[2], params); f.waiting[0].resolve({ body: "unselected", base64Encoded: false }); await pass;
  const selected = f.api.debugger.sendCommand.call(f.receiver, { tabId: 7, sessionId: "child" }, "Network.getResponseBody", params), originalError = Error("real native rejection"); f.waiting[1].reject(originalError); await assert.rejects(selected, error => error === originalError);
  const restored = f.target.__responseBodyProbe.restore(); assert.equal(restored.pending, 0); assert.equal(restored.restored, true); assert.equal(f.api.debugger.sendCommand, f.original);
});
test("native ACK publication hold never resolves early or fabricates value; cannot restore before actual settlement", async () => {
  const f = nativeFixture(); f.target.__responseBodyProbe.hold(); const originalValue = { body: "bytes", base64Encoded: false };
  let settled = false; const read = f.api.debugger.sendCommand({ tabId: 7 }, "Network.getResponseBody", { requestId: "req" }).then(value => { settled = true; return value; });
  f.waiting[0].resolve(originalValue); await tick();
  const held = f.target.__responseBodyProbe.snapshot(); assert.equal(held.pending, 1); assert.equal(held.held, true); assert.equal(settled, false); assert.deepEqual(held.rows.filter(x => ["native-ack", "held"].includes(x.kind)).map(x => x.kind), ["native-ack", "held"]);
  f.target.__responseBodyProbe.release(); assert.equal(await read, originalValue); const final = f.target.__responseBodyProbe.restore(); assert.equal(final.rows.filter(x => x.kind === "native").length, 1); assert.equal(final.rows.filter(x => x.kind === "delivered").length, 1);
});
test("cleanup before native ACK cannot restore early or accidentally install a later hold", async () => {
  const f = nativeFixture(); f.target.__responseBodyProbe.hold(); const read = f.api.debugger.sendCommand({ tabId: 7 }, "Network.getResponseBody", { requestId: "req" });
  assert.throws(() => f.target.__responseBodyProbe.restore(), /still pending/); assert.notEqual(f.api.debugger.sendCommand, f.original);
  const value = { body: "original", base64Encoded: false }; f.waiting[0].resolve(value); assert.equal(await read, value);
  const final = f.target.__responseBodyProbe.restore(); assert.equal(final.held, false); assert.equal(final.expired, false); assert.equal(final.restored, true);
});
test("probe retains full target session and native loading event identity without unrelated response bodies", async () => {
  const f = nativeFixture(); f.emit({ tabId: 7, sessionId: "oopif" }, "Network.responseReceived", { requestId: "req", response: { url: "http://localhost/response-body/api?key=k", status: 503 } });
  f.emit({ tabId: 7 }, "Network.loadingFinished", { requestId: "req" }); f.emit({ tabId: 7, sessionId: "oopif" }, "Network.loadingFinished", { requestId: "req" });
  const probe = f.target.__responseBodyProbe.restore(); assert.equal(probe.rows.length, 2); assert(probe.rows.every(x => x.source.sessionId === "oopif"));
});
test("alternative native access is observed without changing original receiver, Promise or parameters", async () => {
  const f = nativeFixture(), source = { tabId: 7, sessionId: "child" }, params = { url: "http://original" };
  for (const method of ["Network.loadNetworkResource", "Fetch.enable"]) {
    const result = f.api.debugger.sendCommand.call(f.receiver, source, method, params), n = f.waiting.length - 1;
    assert.equal(result, f.waiting[n].promise); assert.equal(f.calls[n].receiver, f.receiver); assert.equal(f.calls[n].args[2], params);
    f.waiting[n].resolve({}); await result;
  }
  const probe = f.target.__responseBodyProbe.restore(); assert.deepEqual(probe.rows.map(row => [row.kind, row.method]), [["alternative-native", "Network.loadNetworkResource"], ["alternative-native", "Fetch.enable"]]);
});
test("native child targets without tabId are retained by exact original fixture key", () => {
  const targets = [{ id: "root", tabId: 7 }, { id: "child", type: "other", url: "http://localhost:8123/response-body/frame?key=original&layout=oopif" },
    { id: "foreign", type: "other", url: "http://localhost:8123/response-body/frame?key=original-other" }, { id: "bad", type: "other", url: "malformed" }];
  assert.deepEqual(selectResponseBodyTargets(targets, 7, "original").map(target => target.id), ["root", "child"]);
});
function oopifEvidence() {
  const rootURL = "http://127.0.0.1:8123/response-body/page?key=original&layout=oopif", childURL = "http://localhost:8123/response-body/frame?key=original&layout=oopif";
  const native = { tab: { id: 7 }, frames: [{ frameId: 0, documentId: "root-doc", processId: 13, documentLifecycle: "active", errorOccurred: false, url: rootURL },
    { frameId: 10, documentId: "child-doc", parentFrameId: 0, parentDocumentId: "root-doc", processId: 14, documentLifecycle: "active", errorOccurred: false, url: childURL }],
    oopifs: [{ tabId: 7, source: { tabId: 7 }, targetId: "child", sessionId: "original-session", type: "iframe", url: "" }],
    targets: [{ id: "root", tabId: 7, type: "page", url: rootURL, attached: true }, { id: "child", type: "other", url: childURL, attached: true }] };
  return { native, options: { tabId: 7, rootURL, childURL } };
}
test("OOPIF joins original CDP iframe event to debugger other target and distinct native process/document", () => {
  const f = oopifEvidence(); assert.equal(checkResponseBodyOOPIF(f.native, f.options).sessionId, "original-session");
  const changedURL = { ...f.native.targets[1], url: "about:blank" };
  assert.deepEqual(selectResponseBodyTargets([changedURL], 7, "original", f.native.oopifs).map(target => target.id), ["child"], "Cleanup retains original ID after URL changes");
});
for (const [label, mutate] of [
  ["missing original attachment", f => { f.native.oopifs = []; }],
  ["unrelated original target", f => { f.native.oopifs[0].targetId = "replacement"; }],
  ["wrong native target URL", f => { f.native.targets[1].url += "-different"; }],
  ["same process iframe", f => { f.native.frames[1].processId = 13; }],
  ["replacement parent document", f => { f.native.frames[1].parentDocumentId = "replacement"; }],
  ["wrong original session parent", f => { f.native.oopifs[0].source.sessionId = "foreign"; }]
]) test(`OOPIF evidence rejects ${label}`, () => { const f = oopifEvidence(); mutate(f); assert.throws(() => checkResponseBodyOOPIF(f.native, f.options)); });

function evidence() {
  const item = { tabId: 7, layout: "root", scope: { session_id: "owner", turn_id: "turn", control_epoch: 2 }, before: [{ documentId: "original", frameId: 0, result: { evidence: { child: false, nonce: "nonce", documentToken: "document" } } }], reads: [], probe: { pending: 0, overflow: false, expired: false, restored: true, rows: [] } }, stats = { overflow: false, attempts: [] };
  const completed = [], clicks = []; let seq = 0;
  for (const [n, kind] of responseBodyKinds.entries()) {
    const bytes = responseBodyBytes("key", kind), payload = { kind, nonce: "nonce", documentToken: "document", trusted: true }, raw = Buffer.from(JSON.stringify(payload)), reference = { captureId: "capture", requestId: `diagnostic-${n}` }, url = `http://fixture/response-body/api?key=key&kind=${kind}`, status = kind === "unavailable-status" ? 503 : 200;
    const value = { ...reference, encoding: "base64", data: bytes.toString("base64"), byteLength: bytes.length };
    stats.attempts.push({ method: "POST", path: `/response-body/api?key=key&kind=${kind}`, value: payload, finishedAt: 20, bodyBase64: raw.toString("base64"), bodyBytes: raw.length, bodySHA256: hash(raw), status, responseBase64: value.data, responseSHA256: hash(bytes), responseBytes: bytes.length });
    item.reads.push({ reference, event: { url }, value }); clicks.push({ kind, trusted: true }); completed.push({ kind, data: value.data, byteLength: value.byteLength, status });
    const rows = item.probe.rows; rows.push({ kind: "event", sequence: ++seq, method: "Network.responseReceived", requestId: `native-${n}`, source: { tabId: 7 }, url, status });
    rows.push({ kind: "request", sequence: ++seq, message: { id: n, params: { ...item.scope, tabId: 7, args: { ...reference, maxBytes: 4096 } } } });
    const call = ++seq; rows.push({ kind: "native", sequence: call, source: { tabId: 7 }, params: { requestId: `native-${n}` } }); rows.push({ kind: "native-ack", sequence: ++seq, call }); rows.push({ kind: "response", sequence: ++seq, id: n, ok: true });
  }
  item.after = [{ documentId: "original", frameId: 0, result: { evidence: { nonce: "nonce", documentToken: "document", clicks, completions: completed, errors: [] } } }]; return { item, stats };
}
test("original body oracle accepts exact binary/Unicode/empty/503 evidence", () => { const f = evidence(); assert.equal(checkResponseBodyEvidence(f.item, f.stats).reads, 4); });
for (const [name, mutate] of [
  ["same URL wrong original bytes", f => { f.item.reads[0].value.data = f.item.reads[1].value.data; }],
  ["different diagnostic request", f => { f.item.reads[0].value.requestId = "other"; }],
  ["synthetic trigger", f => { f.stats.attempts[0].value.trusted = false; }],
  ["replacement document", f => { f.item.after[0].documentId = "replacement"; }],
  ["replacement nonce", f => { f.stats.attempts[0].value.nonce = "replacement"; }],
  ["hidden re-fetch", f => { f.stats.attempts.push({ method: "GET", path: "/response-body/api?kind=binary" }); }],
  ["native cache", f => { f.item.probe.rows = f.item.probe.rows.filter(x => x.kind !== "native"); }],
  ["alternative native resource loading", f => { f.item.probe.rows.push({ kind: "alternative-native", method: "Network.loadNetworkResource" }); }],
  ["missing actual ACK", f => { f.item.probe.rows = f.item.probe.rows.filter(x => x.kind !== "native-ack"); }],
  ["wrong original frame session", f => { f.item.probe.rows.find(x => x.kind === "native").source.sessionId = "other"; }],
  ["expired gate", f => { f.item.probe.expired = true; }],
  ["still pending cleanup", f => { f.item.probe.pending = 1; }],
  ["foreign scope", f => { f.item.probe.rows.find(x => x.kind === "request").message.params.control_epoch++; }],
  ["native response precedes actual ACK", f => { f.item.probe.rows.find(x => x.kind === "response").sequence = 1; }]
]) test(`evidence rejects ${name}`, () => { const f = evidence(); mutate(f); assert.throws(() => checkResponseBodyEvidence(f.item, f.stats)); });
test("body result rejects extra fallback URL, noncanonical base64 and false byte length", () => {
  const f = evidence(), read = f.item.reads[0], attempt = f.stats.attempts[0];
  for (const value of [{ ...read.value, url: "http://refetch" }, { ...read.value, data: read.value.data + "\n" }, { ...read.value, byteLength: 0 }]) assert.throws(() => checkOriginalResponseBody(value, read.reference, attempt));
});
test("CLI dedicated reader preserves exact IDs and original scope; caller requires actual close", async () => {
  const f = evidence(), detail = {}, browser = { client: { sessionId: "owner", turnId: "original-turn", controlEpoch: 9 } }; let argv;
  const reader = createResponseBodyCaller({ kind: "cli", browser, endpoint: "pipe", executable: "host.exe", detail, subprocess: async (_, args, { processEvidence }) => {
    argv = args; Object.assign(processEvidence, { pid: 1, closeObserved: true, exitCode: 0, signal: null }); return JSON.stringify({ result: { value: f.item.reads[0].value } });
  } });
  await reader({ id: 7 }, f.item.reads[0].reference, { maxBytes: 4096, timeoutMs: 10000 }); assert.equal(argv[0], "response-body"); assert.equal(argv[argv.indexOf("--turn-id") + 1], "original-turn"); assert.equal(argv[argv.indexOf("--control-epoch") + 1], "9");
  const noClose = createResponseBodyCaller({ kind: "cli", browser, endpoint: "pipe", executable: "host.exe", subprocess: async () => JSON.stringify({ result: { value: f.item.reads[0].value } }) }); await assert.rejects(noClose({ id: 7 }, f.item.reads[0].reference, { maxBytes: 4096, timeoutMs: 10000 }));
});
test("MCP reader uses structured literal arguments and dedicated named tool", async () => {
  const f = evidence(); let got; const reader = createResponseBodyCaller({ kind: "mcp", browser: { client: { sessionId: "owner", turnId: "turn", controlEpoch: 2 } }, tool: async (name, args) => { got = { name, args }; return { isError: false, structuredContent: { result: { value: f.item.reads[0].value } } }; } });
  await reader({ id: 7 }, f.item.reads[0].reference, { maxBytes: 4096, timeoutMs: 10000 }); assert.deepEqual(got, { name: "response_body", args: { tab_id: 7, capture_id: "capture", request_id: "diagnostic-0", max_bytes: 4096, timeout_ms: 10000 } });
});

function edgeEvidence() {
  return { cases: [["body-gate", ["gate"], 1, 1], ["identity-and-limits", ["binary", "pair", "pair"], 5, 0],
    ["redirect-and-failure", ["redirect", "redirect", "failed"], 1, 0], ["wait-id-and-turn", ["utf8"], 0, 0], ["late-native-Pause", ["utf8"], 1, 0]].map(([name, kinds, nativeCount, releases]) => {
    const key = `body-${name}-root-original`, value = { nonce: "original", documentToken: "document", trusted: true }, attempts = [{ method: "GET", path: "/response-body/page?key=" + key }];
    for (const kind of kinds) { const body = Buffer.from(JSON.stringify({ ...value, kind })); attempts.push({ method: "POST", path: "/response-body/api?kind=" + kind, value: { ...value, kind }, bodyBytes: body.length, bodyBase64: body.toString("base64"), bodySHA256: hash(body) }); }
    if (releases) attempts.push({ method: "POST", path: "/response-body/release?key=" + key });
    const rows = []; let sequence = 0;
    for (let n = 0; n < nativeCount; n++) { const call = ++sequence; rows.push({ kind: "native", sequence: call }, { kind: "native-ack", call, sequence: ++sequence });
      if (name === "late-native-Pause") rows.push({ kind: "held", sequence: ++sequence }, { kind: "release", sequence: ++sequence });
      rows.push({ kind: "delivered", call, sequence: ++sequence }); }
    return { key, server: { overflow: false, documents: [{}], attempts }, before: [{ documentId: "doc", frameId: 0, result: { evidence: { child: false, ...value } } }], after: [{ documentId: "doc", frameId: 0, result: { evidence: value } }],
      probe: { restored: true, pending: 0, expired: false, overflow: false, rows }, expiredRead: { ok: false }, cleanupTimeoutMs: 10000, pauseStartedAt: 1000, pauseSettledAt: 11001,
      failedPause: { ok: false, error: "OBU_AUTOMATION_PAUSE_FAILED: OBU_AUTOMATION_CLEANUP_TIMEOUT: browser cleanup is unconfirmed; automation remains paused", state: { state: "error", inputBlocked: true, cleanupComplete: false } }, retryPause: { value: { cleanupComplete: true } }, resume: { ok: true } };
  }) };
}
test("edge oracle requires all five original scenarios and exact read/POST counts", () => { assert.deepEqual(checkResponseBodyEdgesEvidence(edgeEvidence()), { cases: 5, originalPostAttempts: 9, explicitReleasePosts: 1, nativeReads: 8, noRefetch: true }); });
for (const [label, mutate] of [
  ["late success after original deadline", d => d.cases[4].probe.rows.push({ kind: "response", ok: true })],
  ["replayed native read", d => d.cases[4].probe.rows.push({ kind: "native" })],
  ["background GET retry", d => d.cases[2].server.attempts.push({ method: "GET", path: "/response-body/api?kind=failed" })],
  ["alternative native Fetch enable", d => d.cases[2].probe.rows.push({ kind: "alternative-native", method: "Fetch.enable" })],
  ["silent dropped scenario", d => d.cases.pop()],
  ["Pause falsely complete", d => { d.cases[4].failedPause.ok = true; }],
  ["wrong original document", d => { d.cases[1].after[0].documentId = "successor"; }],
  ["original delivery still pending", d => { d.cases[4].probe.pending = 1; }]
]) test(`edge oracle rejects ${label}`, () => { const d = edgeEvidence(); mutate(d); assert.throws(() => checkResponseBodyEdgesEvidence(d)); });

test("Pause failure requires original 10-second cleanup timeout, blocked inputs and unconfirmed cleanup", () => {
  const item = edgeEvidence().cases[4]; checkResponseBodyPauseFailure(item);
  for (const mutate of [value => { value.failedPause.error = "OBU_AUTOMATION_PAUSE_INCOMPLETE: retry"; }, value => { value.failedPause.state.inputBlocked = false; },
    value => { value.failedPause.state.cleanupComplete = true; }, value => { value.cleanupTimeoutMs = 1000; }, value => { value.pauseSettledAt = 1001; }]) {
    const changed = structuredClone(item); mutate(changed); assert.throws(() => checkResponseBodyPauseFailure(changed));
  }
});
