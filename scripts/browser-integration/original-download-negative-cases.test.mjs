import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import test from "node:test";
import vm from "node:vm";
import { WebSocketServer } from "ws";
import { createOriginalDownloadNegativeFixtures } from "./original-download-negative-fixture.mjs";
import { assertNegativeHTTPReceipt, assertNegativeRelay, negativeNativeDownload, readNegativeOriginalFile, assertNegativeReportRequests, connectNegativePageActor, withNegativePageRendering, negativeActionBudget, checkOriginalDownloadNegatives, installNegativeTrace } from "./original-download-negative-cases.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const described = bytes => ({ bytes: bytes.length, sha256: hash(bytes), base64: bytes.toString("base64") });
const clone = value => structuredClone(value);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async fn => { const deadline = performance.now() + 2000; while (!fn()) { assert.ok(performance.now() < deadline); await pause(5); } };

function nativeEvidence() {
  const events = [
    { method: "Browser.downloadWillBegin", params: { guid: "owned-guid", frameId: "original-frame", url: "http://127.0.0.1/report", suggestedFilename: "report.bin" } },
    { method: "Browser.downloadProgress", params: { guid: "owned-guid", state: "inProgress", receivedBytes: 4096 } },
    { method: "Browser.downloadProgress", params: { guid: "owned-guid", state: "completed", filePath: path.resolve("original.bin"), receivedBytes: 16384 } }
  ];
  return { overflow: false, captureComplete: true, acceptedConnections: 1, upstreamAttempts: 1, reconnects: 0,
    records: events.map((json, sequence) => { const bytes = Buffer.from(JSON.stringify(json)); return { sequence, direction: "upstream->downstream", binary: false, bytes: bytes.length, sha256: hash(bytes), bodyBase64: bytes.toString("base64"), text: bytes.toString(), json, forwarded: { at: sequence + 1 } }; }) };
}
function replaceMessage(snapshot, index, json) {
  const bytes = Buffer.from(JSON.stringify(json)); Object.assign(snapshot.records[index], { bytes: bytes.length, sha256: hash(bytes), bodyBase64: bytes.toString("base64"), text: bytes.toString(), json });
}

test("native witness joins only the exact original GUID and terminal root event", () => {
  const snapshot = nativeEvidence(), result = negativeNativeDownload(snapshot, "owned-guid", "completed");
  assert.equal(result.begin.json.params.frameId, "original-frame"); assert.equal(result.terminal.json.params.filePath, path.resolve("original.bin"));
  assert.throws(() => negativeNativeDownload(snapshot, "same-filename-different-guid", "completed"), /one original Browser begin/);
  assert.throws(() => negativeNativeDownload(snapshot, "owned-guid", "canceled"));
});

test("native witness rejects altered raw bytes, parsed metadata and non-root events", () => {
  for (const mutate of [s => { s.records[0].sha256 = "0".repeat(64); }, s => { s.records[0].json.params.guid = "changed"; }, s => { s.records[0].binary = true; }, s => { replaceMessage(s, 0, { ...s.records[0].json, sessionId: "wrong-child" }); }, s => { delete s.records[2].forwarded; }]) {
    const snapshot = nativeEvidence(); mutate(snapshot); assert.throws(() => negativeNativeDownload(snapshot, "owned-guid", "completed"));
  }
});

test("native witness rejects duplicate begin/terminal, capture loss and implicit reconnect", () => {
  for (const index of [0, 2]) {
    const snapshot = nativeEvidence(), duplicate = clone(snapshot.records[index]); duplicate.sequence = snapshot.records.length; snapshot.records.push(duplicate);
    assert.throws(() => negativeNativeDownload(snapshot, "owned-guid", "completed"), /one original/);
  }
  for (const changed of [{ overflow: true }, { captureComplete: false }, { acceptedConnections: 2 }, { upstreamAttempts: 2 }, { reconnects: 1 }]) assert.throws(() => assertNegativeRelay({ ...nativeEvidence(), ...changed }));
});

test("file witness reads one exact returned file and checks every byte, not its name", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "obu-negative-file-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const filename = path.join(root, "report.bin"), bytes = Buffer.concat([Buffer.from('{"nonce":"original"}\n'), Buffer.from([0, 255, 195, 40])]);
  await fs.writeFile(filename, bytes);
  const actual = await readNegativeOriginalFile(filename, described(bytes), root);
  assert.deepEqual(actual.analysis, { nonce: "original" }); assert.deepEqual(Buffer.from(actual.base64, "base64"), bytes);
  await fs.writeFile(filename, Buffer.alloc(bytes.length));
  await assert.rejects(readNegativeOriginalFile(filename, described(bytes), root));
  await assert.rejects(readNegativeOriginalFile(path.resolve(root, "../report.bin"), described(bytes), root), /isolated download directory/);
  await assert.rejects(readNegativeOriginalFile("report.bin", described(bytes), root));
});

async function receipt(t) {
  const fixture = createOriginalDownloadNegativeFixtures(), record = fixture.createCase({ owner: "unit-owned", kind: "complete" });
  const server = createServer((request, response) => fixture.handle(request, response));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { fixture.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  await (await fetch(base + record.urlPath)).text();
  const page = { key: record.key, nonce: record.nonce, owner: record.owner, expectedSHA: record.expected.sha256, documentToken: "unit-document", clicks: [] };
  page.clicks.push({ key: record.key, nonce: record.nonce, documentToken: page.documentToken, trusted: true, buttonCount: 1 });
  const response = await fetch(base + record.reportPath, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(page.clicks[0]) });
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from(record.expected.base64, "base64"));
  await until(() => fixture.stats(record.key).requests.some(row => row.method === "POST" && row.closed));
  return { record: fixture.stats(record.key), page };
}

test("HTTP witness retains original bytes/nonce/POST and rejects invented trusted receipt", async t => {
  const { record, page } = await receipt(t); assertNegativeHTTPReceipt(record, page, "complete");
  for (const mutate of [p => { p.clicks[0].trusted = false; }, p => { p.clicks[0].documentToken = "successor"; }, p => { p.clicks.push(clone(p.clicks[0])); }, p => { p.expectedSHA = "unrelated"; }]) {
    const altered = clone(page); mutate(altered); assert.throws(() => assertNegativeHTTPReceipt(record, altered, "complete"));
  }
});

test("HTTP witness rejects duplicate POST, interrupted-as-complete, and alternate GET", async t => {
  const { record, page } = await receipt(t);
  for (const mutate of [r => r.requests.push(clone(r.requests.find(x => x.method === "POST"))), r => { r.requests.find(x => x.method === "POST").finished = false; }, r => { r.requests.find(x => x.method === "POST").fields.nonce = "another"; }, r => { r.requests.push({ method: "GET", url: record.reportPath }); }, r => { r.gets[0].sha256 = "changed-html"; }]) {
    const altered = clone(record); mutate(altered); assert.throws(() => assertNegativeHTTPReceipt(altered, page, "complete"));
  }
});

async function actorPeer(t, handler, options) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 }); await new Promise(resolve => server.once("listening", resolve));
  const state = { received: [], closed: false };
  server.on("connection", socket => {
    state.socket = socket; socket.on("close", () => { state.closed = true; });
    socket.on("message", bytes => { const message = JSON.parse(bytes.toString()); state.received.push(message); handler(socket, message); });
  });
  t.after(async () => { for (const socket of server.clients) socket.terminate(); await new Promise(resolve => server.close(resolve)); });
  const actor = await connectNegativePageActor(`ws://127.0.0.1:${server.address().port}/devtools/page/fixture`, options);
  t.after(() => actor.close()); return { actor, state };
}

test("independent page actor captures original native input/ACK/event and actual close", async t => {
  const { actor, state } = await actorPeer(t, (socket, message) => {
    socket.send(JSON.stringify({ id: message.id, result: {} }));
    if (message.method === "Input.dispatchMouseEvent") socket.send(JSON.stringify({ method: "Page.downloadWillBegin", params: { guid: "original", frameId: "fixture" } }));
  });
  await actor.call("Page.enable"); await actor.call("Input.dispatchMouseEvent", { type: "mousePressed", x: 30, y: 20, button: "left", buttons: 1, clickCount: 1 });
  await until(() => actor.detail.events.length === 1);
  await actor.close(); await until(() => state.closed);
  assert.equal(actor.detail.closeObserved, true); assert.equal(actor.detail.overflow, false); assert.equal(state.received.length, 2);
  for (const row of actor.detail.records) { const bytes = Buffer.from(row.bodyBase64, "base64"); assert.equal(hash(bytes), row.sha256); assert.deepEqual(JSON.parse(bytes.toString()), row.json); }
  await assert.rejects(actor.call("Input.dispatchMouseEvent", {}), /closed/); assert.equal(state.received.length, 2);
});

test("actor timeout closes the original connection and never replays input", async t => {
  const { actor, state } = await actorPeer(t, () => {}, { timeoutMs: 35 });
  await assert.rejects(actor.call("Input.dispatchMouseEvent", { type: "mousePressed" }), /timed out/);
  await actor.close(); await until(() => state.closed);
  await assert.rejects(actor.call("Input.dispatchMouseEvent", { type: "mousePressed" }), /timed out/);
  assert.equal(state.received.length, 1); assert.equal(actor.detail.closeObserved, true);
});

test("actor peer EOF rejects pending work and explicit close also settles pending", async t => {
  for (const remote of [true, false]) await t.test(remote ? "peer EOF" : "explicit close", async t => {
    const { actor, state } = await actorPeer(t, socket => { if (remote) socket.terminate(); });
    const call = assert.rejects(actor.call("Page.getFrameTree"), /closed/);
    await until(() => state.received.length === 1); if (!remote) await actor.close();
    await call; await actor.close(); await until(() => state.closed); assert.equal(actor.detail.closeObserved, true);
  });
});

test("actor refuses Browser roots and non-loopback URLs before opening", async () => {
  for (const url of ["ws://127.0.0.1:1234/devtools/browser/original", "ws://example.com:1234/devtools/page/fixture", "ws://user@127.0.0.1:1234/devtools/page/fixture"]) await assert.rejects(connectNegativePageActor(url));
});

const onePixelPNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jp1sAAAAASUVORK5CYII=";
test("rendering preparation waits for original frame ACK before unique input and closes lease", async t => {
  let frameAck;
  const { actor, state } = await actorPeer(t, (socket, message) => {
    if (message.method === "Page.screencastFrameAck") { frameAck = () => socket.send(JSON.stringify({ id: message.id, result: {} })); return; }
    socket.send(JSON.stringify({ id: message.id, result: {} }));
    if (message.method === "Page.startScreencast") socket.send(JSON.stringify({ method: "Page.screencastFrame", params: { sessionId: 19, data: onePixelPNG, metadata: {} } }));
  });
  const run = withNegativePageRendering(actor, async () => {
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await actor.call("Input.dispatchMouseEvent", { type });
    return "original-input-completed";
  });
  await until(() => frameAck); assert.equal(state.received.filter(row => row.method.startsWith("Input.")).length, 0);
  frameAck(); assert.equal(await run, "original-input-completed");
  assert.deepEqual(state.received.map(row => [row.method, row.params]), [
    ["Emulation.setFocusEmulationEnabled", { enabled: true }],
    ["Page.startScreencast", { format: "png", maxWidth: 64, maxHeight: 64, everyNthFrame: 1 }],
    ["Page.screencastFrameAck", { sessionId: 19 }],
    ...["mouseMoved", "mousePressed", "mouseReleased"].map(type => ["Input.dispatchMouseEvent", { type }]),
    ["Page.stopScreencast", {}], ["Emulation.setFocusEmulationEnabled", { enabled: false }]
  ]);
  const rendering = actor.detail.rendering;
  assert.equal(rendering.firstFrame.sessionId, 19); assert.equal(rendering.firstFrame.width, 1); assert.equal(rendering.firstFrame.height, 1);
  assert.equal(rendering.firstFrame.sha256, hash(Buffer.from(onePixelPNG, "base64")));
  assert.ok(rendering.frameAcknowledged.monotonicMs <= rendering.inputStarted.monotonicMs);
  assert.equal(rendering.cleanup.length, 2); for (const row of rendering.cleanup) assert.ok(row.acknowledged);
  await actor.close(); await until(() => state.closed); assert.equal(actor.detail.closeObserved, true);
});

test("missing original frame or ACK prevents every input with bounded settlement", async t => {
  for (const mode of ["missing-frame", "missing-ack"]) await t.test(mode, async t => {
    const { actor, state } = await actorPeer(t, (socket, message) => {
      if (message.method === "Page.screencastFrameAck") return;
      socket.send(JSON.stringify({ id: message.id, result: {} }));
      if (message.method === "Page.startScreencast" && mode === "missing-ack") socket.send(JSON.stringify({ method: "Page.screencastFrame", params: { sessionId: 23, data: onePixelPNG, metadata: {} } }));
    });
    await assert.rejects(withNegativePageRendering(actor, () => actor.call("Input.dispatchMouseEvent", { type: "mousePressed" }), { timeoutMs: 50 }), mode === "missing-frame" ? /expired before first frame/ : /timed out: Page.screencastFrameAck/);
    assert.equal(state.received.filter(row => row.method.startsWith("Input.")).length, 0);
    if (mode === "missing-frame") assert.ok(actor.detail.rendering.cleanup.every(row => row.acknowledged));
    else { assert.equal(state.received.filter(row => row.method === "Page.screencastFrameAck").length, 1); assert.ok(actor.detail.rendering.cleanup.every(row => row.error)); }
    await actor.close(); await until(() => state.closed); assert.equal(actor.detail.closeObserved, true);
  });
});

test("rendering cleanup failure is preserved and never produces repeated input", async t => {
  const { actor, state } = await actorPeer(t, (socket, message) => {
    socket.send(JSON.stringify(message.method === "Page.stopScreencast" ? { id: message.id, error: { message: "original stop failed" } } : { id: message.id, result: {} }));
    if (message.method === "Page.startScreencast") socket.send(JSON.stringify({ method: "Page.screencastFrame", params: { sessionId: 31, data: onePixelPNG, metadata: {} } }));
  });
  await assert.rejects(withNegativePageRendering(actor, () => actor.call("Input.dispatchMouseEvent", { type: "mousePressed" })), /original stop failed/);
  assert.equal(state.received.filter(row => row.method.startsWith("Input.")).length, 1);
  assert.match(actor.detail.rendering.cleanup[0].error.message, /original stop failed/); assert.ok(actor.detail.rendering.cleanup[1].acknowledged);
});

test("business click budget retains original monotonic deadline and refuses expired trigger", async () => {
  const deadline = performance.now() + 100;
  const before = negativeActionBudget(deadline); assert.ok(before > 0 && before <= 100);
  await pause(20); const after = negativeActionBudget(deadline); assert.ok(after < before);
  assert.equal(negativeActionBudget(performance.now() + 20000), 5000);
  assert.throws(() => negativeActionBudget(performance.now() - 1), /no new click/);
});

test("real acceptance call path never triggers after its arm budget and truncates short ACK budget", async t => {
  for (const mode of ["expired-arm", "expired-before-invoke", "short-ack"]) await t.test(mode, async t => {
    let now = 1000, clicks = 0, cancelled = 0, closed = 0, argument;
    t.mock.method(performance, "now", () => now);
    const fixture = createOriginalDownloadNegativeFixtures(), detail = {};
    t.after(() => fixture.close());
    const waiter = { waiterId: "original-waiter", async cancel() { cancelled++; }, async result() { throw Error("Unexpected result collection"); } };
    Object.defineProperty(waiter, "remainingMs", { get() {
      if (mode === "expired-before-invoke") queueMicrotask(() => { now = 16001; });
      return mode === "short-ack" ? 120 : 15000;
    } });
    const tab = {
      id: 12,
      async expectDownload(options) { assert.equal(options.timeoutMs, 15000); if (mode === "expired-arm") now = 16001; return waiter; },
      getByRole(role, options) {
        assert.equal(role, "button"); assert.deepEqual(options, { name: "Download original report", exact: true });
        return { async click(value) { clicks++; argument = value; throw Error("Short-budget click reached"); } };
      },
      async close() { closed++; }
    };
    const client = sessionId => ({ sessionId, turnId: "original-turn", controlEpoch: 2, onNotification: () => () => {}, async getTabs() { return []; } });
    const owner = { client: { ...client("owner"), async getInfo() { return { metadata: { pageDownloads: { available: true, generation: "original-generation" } } }; }, async getControlState() { return { epoch: 2 }; } }, async newTab() { return tab; }, cdp: { async navigate() {} } };
    const worker = { async evaluate(expression) { if (expression === "globalThis.__obuNativeDownloadBinding") return { nonce: "original-nonce" }; if (expression.startsWith("({page:")) return { page: [], private: [], overflow: false }; } };
    const expected = mode === "short-ack" ? /Short-budget click reached/ : /expired before trigger; no new click/;
    await assert.rejects(checkOriginalDownloadNegatives({ owner, foreign: { client: client("foreign") }, worker, fixture, fixtureURL: "http://127.0.0.1:1/", relay: { snapshot() { return {}; } }, connectionState: async () => ({ nativeSocketReadyState: 1, hostExitCode: null }), detail }), expected);
    assert.equal(clicks, mode === "short-ack" ? 1 : 0); assert.equal(cancelled, 1); assert.equal(closed, 1);
    assert.equal(detail.passed, false);
    if (mode === "short-ack") { assert.deepEqual(argument, { timeoutMs: 120 }); assert.equal(detail.operations[0].params.timeoutMs, 120); }
    if (mode === "expired-arm") assert.equal(detail.operations.length, 0);
    if (mode === "expired-before-invoke") { assert.equal(detail.operations.length, 1); assert.match(detail.operations[0].error.message, expected); }
  });
});

test("passive Network witness preserves exact interrupted-tab initiator and request/response data", () => {
  let listener;
  const context = vm.createContext({ structuredClone, TextEncoder, performance, chrome: { debugger: { onEvent: { addListener(value) { listener = value; } } } } });
  vm.runInContext(`(${installNegativeTrace.toString()})()`, context);
  const trace = context.__originalNegativeTrace;
  trace.network = { tabId: 7, events: [], bytes: 0, overflow: false };
  const params = { requestId: "exact-request", loaderId: "original-loader", frameId: "original-frame", request: { method: "POST", url: "http://127.0.0.1/report", postData: "original=nonce", headers: { Origin: "http://127.0.0.1" } }, initiator: { type: "script", stack: { callFrames: [{ functionName: "submit", lineNumber: 21, url: "http://127.0.0.1/page" }] } } };
  listener({ tabId: 8 }, "Network.requestWillBeSent", params); assert.equal(trace.network.events.length, 0);
  const source = { tabId: 7, sessionId: "exact-session" };
  listener(source, "Network.requestWillBeSent", params);
  const response = { requestId: "exact-request", response: { status: 405, headers: { Allow: "POST" }, mimeType: "text/plain" } };
  listener(source, "Network.responseReceived", response);
  listener(source, "Network.loadingFailed", { requestId: "exact-request", errorText: "net::ERR_ABORTED", canceled: true });
  assert.deepEqual(trace.network.events[0].params, params); assert.deepEqual(trace.network.events[0].source, source); assert.deepEqual(trace.network.events[1].params, response);
  params.request.postData = "later mutation"; assert.equal(trace.network.events[0].params.request.postData, "original=nonce");
  assert.equal(trace.network.events[2].params.errorText, "net::ERR_ABORTED"); assert.equal(trace.network.overflow, false);
  listener(source, "Network.requestWillBeSent", { request: { postData: "x".repeat(2 * 1024 * 1024) } });
  assert.equal(trace.network.overflow, true); assert.equal(trace.network.events.length, 3);
  assert.throws(() => vm.runInContext(`(${installNegativeTrace.toString()})()`, context), /already occupied/);
});

function reportLedger() {
  const originals = ["warm", "held", "unowned", "interrupted", "fresh"].map(key => ({ method: "POST", url: "/original-negative/report", status: 200, once: true, fields: { key }, body: described(Buffer.from(key)) }));
  const denied = { method: "GET", url: "/original-negative/report", status: 405, range: null, once: false, error: "ORIGINAL_REPORT_REQUIRES_POST", prefixWritten: false, prefixFlushed: false, prefixBytes: 0, queuedBytes: 30, finished: true, closed: true, aborted: false, errors: [], response: described(Buffer.from("ORIGINAL_REPORT_REQUIRES_POST\n")) };
  return { originals, denied, stats: { requests: [...clone(originals), clone(denied)] } };
}

test("HTTP ledger keeps five exact original POSTs and returns only one fully rejected GET candidate", () => {
  const { originals, denied, stats } = reportLedger();
  const candidate = assertNegativeReportRequests(stats, originals); assert.deepEqual(candidate, denied); assert.notEqual(candidate, stats.requests.at(-1));
  // Receipt validation alone deliberately has no API or field claiming the
  // request's initiator. The post-browser-close NetLog gate supplies provenance.
  assert.equal(candidate.provenance, undefined);
});

test("GET candidate never licenses extra traffic, range resume or delivery of original bytes", () => {
  for (const mutate of [
    stats => stats.requests.push(clone(stats.requests.at(-1))),
    stats => stats.requests.pop(),
    stats => { stats.requests.at(-1).method = "HEAD"; },
    stats => { stats.requests.at(-1).status = 200; },
    stats => { stats.requests.at(-1).range = "bytes=4096-"; },
    stats => { stats.requests.at(-1).url += "?retry=1"; },
    stats => { stats.requests.at(-1).response = described(Buffer.from("original download payload")); },
    stats => { stats.requests.at(-1).prefixWritten = true; },
    stats => { stats.requests.at(-1).queuedBytes = 16384; },
    stats => { stats.requests.at(-1).finished = false; },
    stats => stats.requests.push(clone(stats.requests[0])),
    stats => { stats.requests[0].body = described(Buffer.from("mutated-original-post")); },
    stats => { stats.requests[0].fields.key = "unknown-owner"; }
  ]) {
    const { originals, stats } = reportLedger(); mutate(stats); assert.throws(() => assertNegativeReportRequests(stats, originals));
  }
});
