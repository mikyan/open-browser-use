import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { createServer, createConnection } from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSDKConnectionFixtures, sdkConnectionHTML, createSDKConnectionRelay, runSDKConnectionProcess, checkSDKConnectionReceipt } from "./sdk-connection-fixture.mjs";

const key = "sdk-connection-js-eof-" + "a".repeat(32);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const stored = value => { const bytes = Buffer.from(JSON.stringify(value)); return { bytes: bytes.length, sha256: hash(bytes), bodyBase64: bytes.toString("base64") }; };
function validReceipt() {
  const value = { key, documentToken: "original", kind: "recover-action", target: "recover-action", trusted: true, x: 50, y: 20 };
  const entry = request => ({ ...stored(request), request });
  const disconnected = "OBU_SDK_BROWSER_DISCONNECTED";
  return { key, kind: "js", process: { passed: true, exitObserved: true, closeObserved: true, exitCode: 0, errors: [], messages: [
    { phase: "armed", readyText: "SDK_CONNECTION_READY" },
    { phase: "blocked", firstError: "EOF", blockedErrors: Object.fromEntries(["locator", "beginTurn", "connect", "manualEpoch"].map(value => [value, disconnected])) },
    { phase: "done", freshEpoch: 7, freshTurn: "fresh", oldLocatorError: disconnected }
  ] }, before: { events: [], documentToken: "original" }, blockedState: { events: [], documentToken: "original" },
    after: { errors: [], documentToken: "original", events: [value], receipts: [{}] }, server: { posts: [{ ...stored(value), value }] },
    proxy: { errors: [], connections: [
      { closedAt: 2, targetClosedAt: 2, targetConnectedAt: 1, requests: [entry({ method: "getInfo", params: { session_id: key } })] },
      { closedAt: 4, targetClosedAt: 4, targetConnectedAt: 3, requests: [entry({ method: "getControlState", params: { session_id: key } }), entry({ method: "browserAction", params: { session_id: key, turn_id: "fresh", control_epoch: 7, action: "click", locator: [{ kind: "css", selector: "#recover-action" }] } })] }
    ] } };
}

test("SDK fixture preserves wrong business submissions as original bytes", () => {
  const fixture = createSDKConnectionFixtures(), reply = { writeHead(status) { this.status = status; }, end(body) { this.body = body; } };
  assert.match(sdkConnectionHTML(key), /event.isTrusted/); assert.throws(() => sdkConnectionHTML("bad-key"));
  fixture.handle({ method: "GET" }, reply, new URL("http://127.0.0.1/sdk-connection/page?key=" + key));
  assert.equal(reply.status, 200); assert.equal(hash(reply.body), fixture.stats(key).gets[0].sha256);
  const req = new EventEmitter(); req.method = "POST";
  const value = { key, kind: "stale-action", trusted: true }, bytes = Buffer.from(JSON.stringify(value));
  fixture.handle(req, reply, new URL("http://127.0.0.1/sdk-connection/post?key=" + key));
  req.emit("data", bytes.subarray(0, 7)); req.emit("data", bytes.subarray(7)); req.emit("end");
  assert.equal(reply.status, 200); assert.deepEqual(fixture.stats(key).posts[0].value, value);
  assert.equal(fixture.stats(key).posts[0].bodyBase64, bytes.toString("base64"));
});

test("SDK recovery acceptance rejects stale, duplicate, untrusted and substituted business evidence", () => {
  checkSDKConnectionReceipt(validReceipt());
  for (const mutate of [
    v => { v.blockedState.events.push({ kind: "stale-action" }); },
    v => { v.after.documentToken = "replacement"; },
    v => { v.server.posts.push(v.server.posts[0]); },
    v => { v.after.events[0].trusted = false; },
    v => { v.server.posts[0].sha256 = "forged"; },
    v => { v.proxy.connections[0].requests.push(v.proxy.connections[1].requests[1]); },
    v => { v.proxy.connections.push(v.proxy.connections[1]); },
    v => { v.process.passed = false; },
    v => { delete v.proxy.connections[0].targetClosedAt; },
    v => { delete v.process.messages[1].blockedErrors.manualEpoch; },
    v => { v.process.messages[2].freshEpoch++; },
    v => { v.proxy.connections[1].requests.shift(); }
  ]) { const value = validReceipt(); mutate(value); assert.throws(() => checkSDKConnectionReceipt(value)); }
});

test("SDK relay forwards exact native frames and cuts only its original connection", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "obu-sdk-relay-"));
  const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\obu-relay-test-${process.pid}-${Date.now()}` : path.join(dir, "target.sock");
  const peers = new Set(), server = createServer(socket => { peers.add(socket); socket.on("error", () => {}); socket.on("close", () => peers.delete(socket)); socket.pipe(socket); });
  await new Promise(resolve => server.listen(endpoint, resolve));
  const relay = await createSDKConnectionRelay(endpoint, dir);
  t.after(async () => { await relay.close(); for (const peer of peers) peer.destroy(); await new Promise(resolve => server.close(resolve)); await fs.rmdir(dir); });
  const frame = (id) => { const body = Buffer.from(JSON.stringify({ id, method: "ping", params: { session_id: "relay-test" } })), header = Buffer.alloc(4); os.endianness() === "LE" ? header.writeUInt32LE(body.length) : header.writeUInt32BE(body.length); return Buffer.concat([header, body]); };
  const exchange = async (id) => {
    const socket = createConnection(relay.endpoint); socket.on("error", () => {});
    await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
    const expected = frame(id), chunks = []; let size = 0;
    const reply = new Promise(resolve => socket.on("data", bytes => { chunks.push(bytes); size += bytes.length; if (size === expected.length) resolve(Buffer.concat(chunks)); }));
    socket.write(expected.subarray(0, 2)); socket.write(expected.subarray(2)); assert.deepEqual(await reply, expected); return socket;
  };
  const first = await exchange(1); const firstClosed = new Promise(resolve => first.once("close", resolve)); await relay.cut(); await firstClosed;
  const second = await exchange(2); const secondClosed = new Promise(resolve => second.once("close", resolve)); second.end(); await secondClosed;
  assert.equal(relay.ledger.connections.length, 2); assert.equal(relay.ledger.connections[0].requests[0].request.id, 1);
  assert.equal(relay.ledger.connections[1].requests[0].request.id, 2); assert.deepEqual(relay.ledger.errors, []);
});

test("SDK caller protocol requires ordered acknowledged phases and actual process close", async () => {
  const source = `const rl=require('node:readline').createInterface({input:process.stdin});console.log(JSON.stringify({phase:'armed'}));let i=0;rl.on('line',line=>{if(i++===0){if(line!=='cut')process.exit(3);console.log(JSON.stringify({phase:'blocked'}));}else{if(line!=='recover')process.exit(4);console.log(JSON.stringify({phase:'done'}));rl.close();process.stdin.destroy();}});`;
  const phases = [], result = await runSDKConnectionProcess(process.execPath, ["-e", source], { onPhase: async message => { phases.push(message.phase); } });
  assert.equal(result.passed, true, JSON.stringify(result)); assert.deepEqual(phases, ["armed", "blocked", "done"]);
  assert.equal(result.exitObserved, true); assert.equal(result.closeObserved, true); assert.equal(result.exitCode, 0);
  const malformed = await runSDKConnectionProcess(process.execPath, ["-e", "console.log(JSON.stringify({phase:'done'}))"], { timeoutMs: 2000 });
  assert.equal(malformed.passed, false); assert.equal(malformed.closeObserved, true); assert.ok(malformed.errors.length);
});
