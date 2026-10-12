import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import { createOriginalDownloadRelay } from "./original-download-relay.mjs";

async function until(predicate, description = "condition", timeoutMs = 2000) {
  const end = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= end) throw new Error(`Timed out waiting for ${description}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
async function browser(t, { holdUpgrade = false, reject = false } = {}) {
  const server = http.createServer();
  const wss = new WebSocketServer({ noServer: true });
  const state = { peers: [], messages: [], closed: [], upgrades: [], sockets: new Set() };
  server.on("connection", socket => { state.sockets.add(socket); socket.on("close", () => state.sockets.delete(socket)); });
  server.on("upgrade", (request, socket, head) => {
    const accept = () => {
      if (reject) { socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); return; }
      wss.handleUpgrade(request, socket, head, peer => {
        state.peers.push(peer);
        peer.on("error", () => {});
        peer.on("message", (raw, binary) => state.messages.push({ bytes: Buffer.from(raw), binary }));
        peer.on("close", (code, reason) => state.closed.push({ code, reason: reason.toString() }));
      });
    };
    state.upgrades.push({ path: request.url, accept });
    if (!holdUpgrade) accept();
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const peer of state.peers) peer.terminate();
    for (const socket of state.sockets) socket.destroy();
    await Promise.all([new Promise(resolve => wss.close(resolve)), new Promise(resolve => server.close(resolve))]);
  });
  return { ...state, state, url: `ws://127.0.0.1:${server.address().port}/devtools/browser/original-unit-id` };
}
async function relay(t, targetURL, options = {}) {
  const value = await createOriginalDownloadRelay({ targetURL, timeoutMs: 500, ...options });
  t.after(() => value.close().catch(() => {}));
  return value;
}
function client(t, url) {
  const socket = new WebSocket(url, { handshakeTimeout: 1000 });
  const state = { socket, received: [], errors: [], opened: false, closed: false };
  socket.on("message", (raw, binary) => state.received.push({ bytes: Buffer.from(raw), binary }));
  socket.on("error", error => state.errors.push(error));
  socket.on("open", () => { state.opened = true; });
  socket.on("close", (code, reason) => { state.closed = true; state.closeCode = code; state.closeReason = reason.toString(); });
  t.after(async () => { socket.terminate(); await until(() => state.closed, "client actual close"); });
  return state;
}

test("relay validates explicit literal-loopback Browser roots before any listener or dial", async () => {
  for (const targetURL of [undefined, "", "ws://localhost:123/devtools/browser/id", "ws://example.com:123/devtools/browser/id",
    "ws://192.168.1.1:123/devtools/browser/id", "ws://0.0.0.0:123/devtools/browser/id", "ws://127.1:123/devtools/browser/id",
    "ws://2130706433:123/devtools/browser/id", "ws://0x7f000001:123/devtools/browser/id", "ws://127.0.0.1/devtools/browser/id",
    "ws://127.0.0.1:0/devtools/browser/id", "ws://127.0.0.1:65536/devtools/browser/id", "ws://127.0.0.1:00123/devtools/browser/id",
    "ws://user:secret@127.0.0.1:123/devtools/browser/id", "ws://127.0.0.1:123/devtools/page/id",
    "ws://127.0.0.1:123/devtools/browser/id?", "ws://127.0.0.1:123/devtools/browser/id#", "ws://127.0.0.1:123/devtools/browser/id/extra",
    "ws://127.0.0.1:123/devtools/browser/%69d", "ws://127.0.0.1:123/devtools/browser/..", "ws://127.0.0.1:123/devtools/browser/.",
    "ws://[::ffff:127.0.0.1]:123/devtools/browser/id", "ws://[::2]:123/devtools/browser/id", "http://127.0.0.1:123/devtools/browser/id",
    " ws://127.0.0.1:123/devtools/browser/id", "ws://127.0.0.1:123/devtools/browser/id\n"
  ]) await assert.rejects(createOriginalDownloadRelay({ targetURL }), /OBU_DOWNLOAD_RELAY_URL/);
});

test("unused relay closes its actual listener and accepts IPv6 loopback syntax without dialing", async t => {
  const value = await relay(t, "ws://[::1]:123/devtools/browser/unit-id");
  await Promise.all([value.close(), value.close()]);
  const trace = value.snapshot();
  assert.equal(trace.targetURL, "ws://[::1]:123/devtools/browser/unit-id");
  assert.equal(trace.server.closeObserved, true);
  assert.equal(trace.acceptedConnections, 0); assert.equal(trace.upstreamAttempts, 0);
  assert.equal(trace.records.length, 0); assert.deepEqual(trace.errors, []);
  await assert.rejects(value.disconnect(), /NO_CONNECTION/);
});

test("relay preserves original bytes, binary flag, JSON whitespace, request/event ordering and queued messages", async t => {
  const native = await browser(t, { holdUpgrade: true });
  const value = await relay(t, native.url);
  assert.equal(new URL(value.url).pathname, new URL(native.url).pathname);
  const consumer = client(t, value.url);
  await until(() => consumer.opened && native.upgrades.length === 1);
  const outbound = [Buffer.from('{ "id": 7, "method": "Target.getTargets" }\n'), Buffer.from([0, 1, 255]), Buffer.from("not JSON")];
  outbound.forEach((bytes, i) => consumer.socket.send(bytes, { binary: i === 1 }));
  await until(() => value.snapshot().records.length === 3, "queued original messages");
  assert.equal(native.messages.length, 0); assert.equal(value.snapshot().upstream.opened, undefined);
  native.upgrades[0].accept();
  await until(() => native.messages.length === 3);
  assert.deepEqual(native.messages, outbound.map((bytes, i) => ({ bytes, binary: i === 1 })));
  const inbound = [Buffer.from('{ "id":7, "result":{"targetInfos":[]} }'), Buffer.from('{"method":"Browser.downloadWillBegin","params":{"guid":"exact","frameId":"original"}}'), Buffer.from([255, 0])];
  inbound.forEach((bytes, i) => native.peers[0].send(bytes, { binary: i === 2 }));
  await until(() => consumer.received.length === 3 && value.snapshot().records.every(row => row.forwarded));
  assert.deepEqual(consumer.received, inbound.map((bytes, i) => ({ bytes, binary: i === 2 })));
  const trace = value.snapshot();
  assert.equal(trace.targetURL, native.url); assert.equal(trace.upstreamAttempts, 1); assert.equal(trace.acceptedConnections, 1);
  assert.deepEqual(trace.records.map(row => row.direction), [...Array(3).fill("downstream->upstream"), ...Array(3).fill("upstream->downstream")]);
  for (const [sequence, row] of trace.records.entries()) {
    const original = [...outbound, ...inbound][sequence];
    assert.equal(row.sequence, sequence); assert.deepEqual(Buffer.from(row.bodyBase64, "base64"), original);
    assert.equal(row.sha256, createHash("sha256").update(original).digest("hex")); assert.equal(row.bytes, original.length);
    assert.ok(row.forwarded.at >= row.at); assert.ok(row.forwarded.monotonicMs >= row.monotonicMs);
    if (!row.binary) assert.equal(row.text, original.toString());
  }
  assert.equal(trace.records[0].json.id, 7); assert.equal(trace.records[2].json, undefined);
  trace.records[0].json.id = 900; assert.equal(value.snapshot().records[0].json.id, 7);
  await value.close();
  assert.equal(value.snapshot().server.closeObserved, true);
  assert.equal(value.snapshot().downstream.closeObserved, true); assert.equal(value.snapshot().upstream.closeObserved, true);
  await until(() => native.closed.length === 1 && consumer.closed);
});

test("planned disconnect awaits both actual closes, does not forge CDP, and never reconnects", async t => {
  const native = await browser(t), value = await relay(t, native.url), consumer = client(t, value.url);
  await until(() => native.peers.length === 1);
  consumer.socket.send('{"id":1,"method":"Browser.getVersion"}');
  await until(() => native.messages.length === 1);
  await Promise.all([value.disconnect(), value.disconnect()]);
  const cut = value.snapshot();
  assert.equal(cut.downstream.closeObserved, true); assert.equal(cut.upstream.closeObserved, true);
  assert.ok(cut.faultInjection.actualCloseObserved.monotonicMs >= cut.upstream.closed.monotonicMs);
  assert.ok(cut.faultInjection.actualCloseObserved.monotonicMs >= cut.downstream.closed.monotonicMs);
  assert.ok(cut.upstream.terminateRequested.monotonicMs >= cut.faultInjection.requested.monotonicMs);
  assert.equal(cut.records.length, 1); assert.equal(consumer.received.length, 0); assert.deepEqual(cut.errors, []);
  const rejected = client(t, value.url); await until(() => rejected.closed);
  assert.equal(rejected.opened, false); assert.match(String(rejected.errors[0]), /403/);
  assert.equal(value.snapshot().attemptCount, 2); assert.equal(value.snapshot().upstreamAttempts, 1);
  assert.equal(value.snapshot().acceptedConnections, 1); assert.equal(value.snapshot().reconnects, 0);
  assert.equal(native.upgrades.length, 1); assert.equal(native.messages.length, 1);
  await value.close(); assert.equal(value.snapshot().server.closeObserved, true);
});

for (const source of ["upstream", "downstream"]) test(`actual ${source} graceful close propagates and permanently ends original connection`, async t => {
  const native = await browser(t), value = await relay(t, native.url), consumer = client(t, value.url);
  await until(() => native.peers.length === 1 && value.snapshot().upstream.opened);
  (source === "upstream" ? native.peers[0] : consumer.socket).close(1001, "original endpoint closed");
  await until(() => value.snapshot().upstream.closeObserved && value.snapshot().downstream.closeObserved && consumer.closed && native.closed.length === 1);
  assert.equal(consumer.closeCode, 1001); assert.equal(native.closed[0].code, 1001);
  assert.equal(value.snapshot().faultInjection, undefined); assert.deepEqual(value.snapshot().errors, []);
  const rejected = client(t, value.url); await until(() => rejected.closed);
  assert.equal(native.upgrades.length, 1); assert.equal(value.snapshot().upstreamAttempts, 1);
  await value.close();
});

test("wrong Browser root is rejected without upstream, then sole exact route is accepted", async t => {
  const native = await browser(t), value = await relay(t, native.url);
  const wrong = client(t, `${value.url}/other`); await until(() => wrong.closed);
  assert.equal(value.snapshot().upstreamAttempts, 0);
  const correct = client(t, value.url); await until(() => correct.opened && native.peers.length === 1);
  assert.equal(value.snapshot().attemptCount, 2); assert.equal(value.snapshot().acceptedConnections, 1);
  assert.equal(value.snapshot().attempts[0].exactPath, false); await value.close();
});

test("a simultaneous second client cannot create an upstream or disturb the original connection", async t => {
  const native = await browser(t), value = await relay(t, native.url), original = client(t, value.url);
  await until(() => original.opened && native.peers.length === 1);
  const rejected = client(t, value.url); await until(() => rejected.closed);
  assert.equal(rejected.opened, false); assert.equal(original.closed, false);
  original.socket.send('{"id":8,"method":"Browser.getVersion"}');
  await until(() => native.messages.length === 1);
  assert.equal(value.snapshot().acceptedConnections, 1); assert.equal(value.snapshot().upstreamAttempts, 1);
  assert.equal(native.upgrades.length, 1); await value.close();
});

test("upstream handshake failure closes both real sockets and remains the failure after cleanup", async t => {
  const native = await browser(t, { reject: true }), value = await relay(t, native.url), consumer = client(t, value.url);
  await until(() => value.snapshot().server.closeObserved && value.snapshot().upstream.closeObserved && consumer.closed);
  await assert.rejects(value.close(), /403/); await assert.rejects(value.disconnect(), /403/);
  const trace = value.snapshot();
  assert.equal(trace.upstreamAttempts, 1); assert.equal(trace.downstream.closeObserved, true);
  assert.equal(trace.upstream.opened, undefined); assert.equal(trace.records.length, 0);
  assert.ok(trace.faultInjection.actualCloseObserved); assert.match(trace.errors[0].error, /403/);
});

test("cut during pending upstream handshake closes both sides without forwarding queued data", async t => {
  const native = await browser(t, { holdUpgrade: true }), value = await relay(t, native.url), consumer = client(t, value.url);
  await until(() => consumer.opened && native.upgrades.length === 1);
  consumer.socket.send('{"id":1,"method":"Browser.getVersion"}');
  await until(() => value.snapshot().records.length === 1);
  await value.disconnect(); await value.close();
  const trace = value.snapshot();
  assert.equal(trace.upstream.closeObserved, true); assert.equal(trace.downstream.closeObserved, true);
  assert.equal(trace.upstream.opened, undefined); assert.equal(native.messages.length, 0);
  assert.equal(trace.records[0].forwarded, undefined); assert.match(trace.records[0].notForwarded, /closed/);
  assert.equal(trace.upstreamAttempts, 1); assert.deepEqual(trace.errors, []);
});

test("upstream handshake deadline fails once and closes queued original connection without retry", async t => {
  const native = await browser(t, { holdUpgrade: true }), value = await relay(t, native.url, { timeoutMs: 80 }), consumer = client(t, value.url);
  await until(() => consumer.opened && native.upgrades.length === 1);
  consumer.socket.send('{"id":1,"method":"Target.getTargets"}');
  await until(() => value.snapshot().server.closeObserved && consumer.closed);
  await assert.rejects(value.close(), /Opening handshake has timed out/);
  const trace = value.snapshot();
  assert.equal(trace.upstream.closeObserved, true); assert.equal(trace.downstream.closeObserved, true);
  assert.equal(trace.upstreamAttempts, 1); assert.equal(native.upgrades.length, 1); assert.equal(native.messages.length, 0);
  assert.equal(trace.records[0].forwarded, undefined); assert.match(trace.records[0].notForwarded, /closed/);
  assert.equal(trace.faultInjection, undefined);
});

test("record overflow explicitly fails, keeps complete recorded messages, and closes listener and both sides", async t => {
  const native = await browser(t), value = await relay(t, native.url, { maxRecords: 2 }), consumer = client(t, value.url);
  await until(() => native.peers.length === 1);
  for (let id = 1; id <= 3; id++) native.peers[0].send(JSON.stringify({ id, result: { original: true } }));
  await until(() => value.snapshot().server.closeObserved && consumer.closed);
  await assert.rejects(value.close(), /OVERFLOW/); await assert.rejects(value.close(), /OVERFLOW/);
  await assert.rejects(value.disconnect(), /OVERFLOW/);
  const trace = value.snapshot();
  assert.equal(trace.overflow, true); assert.equal(trace.captureComplete, false); assert.equal(trace.records.length, 2);
  assert.deepEqual(trace.records.map(row => row.json.id), [1, 2]);
  assert.ok(consumer.received.every(row => JSON.parse(row.bytes).result.original === true));
  assert.equal(trace.downstream.closeObserved, true); assert.equal(trace.upstream.closeObserved, true);
});

test("total byte overflow never masquerades as a complete capture", async t => {
  const native = await browser(t), value = await relay(t, native.url, { maxBytes: 16 }), consumer = client(t, value.url);
  await until(() => native.peers.length === 1);
  native.peers[0].send("123456789"); await until(() => value.snapshot().records.length === 1);
  native.peers[0].send("123456789");
  await until(() => value.snapshot().server.closeObserved && consumer.closed);
  await assert.rejects(value.close(), /OVERFLOW/);
  assert.equal(value.snapshot().recordedBytes, 9); assert.equal(value.snapshot().captureComplete, false);
});

test("oversized single message fails explicitly before a partial record is accepted", async t => {
  const native = await browser(t), value = await relay(t, native.url, { maxBytes: 16 }), consumer = client(t, value.url);
  await until(() => native.peers.length === 1);
  native.peers[0].send("x".repeat(17));
  await until(() => value.snapshot().server.closeObserved && consumer.closed);
  await assert.rejects(value.close(), /Max payload size exceeded/);
  assert.equal(value.snapshot().captureComplete, false); assert.equal(value.snapshot().records.length, 0);
});

test("attempt evidence overflow fails closed without creating a second upstream", async t => {
  const native = await browser(t), value = await relay(t, native.url, { maxAttempts: 1 }); client(t, value.url);
  await until(() => native.peers.length === 1); await value.disconnect();
  const rejected = client(t, value.url); await until(() => rejected.closed && value.snapshot().server.closeObserved);
  await assert.rejects(value.close(), /OVERFLOW/);
  const trace = value.snapshot(); assert.equal(trace.attemptCount, 2); assert.equal(trace.attempts.length, 1);
  assert.equal(trace.captureComplete, false); assert.equal(trace.upstreamAttempts, 1); assert.equal(native.upgrades.length, 1);
  await assert.rejects(value.disconnect(), /OVERFLOW/);
});
