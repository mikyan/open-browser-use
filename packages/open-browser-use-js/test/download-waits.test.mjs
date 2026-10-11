import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { tmpdir, endianness } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { OpenBrowserUseBrowser, OpenBrowserUseClient, encodeFrame } from "../dist/index.js";
import { downloadWaitAck, downloadWaitParams } from "../dist/download-waits.js";

const info = { metadata: { turnLifecycleVersion: 1, downloadWaitVersion: 1, directDownloadsVersion: 1 } };
const state = epoch => ({ controlEpoch: epoch, nextTurnId: `turn-${epoch}`, lifecycleVersion: 1, closing: false });
const download = { downloadId: "page-guid" };
async function fixture(t, handler) {
  const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\obu-download-${randomUUID()}` : join(tmpdir(), `obu-download-${randomUUID()}.sock`);
  const calls = [], sockets = new Set();
  const server = createServer(socket => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket)); let buffer = Buffer.alloc(0);
    socket.on("data", chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const size = endianness() === "LE" ? buffer.readUInt32LE(0) : buffer.readUInt32BE(0);
        if (buffer.length < size + 4) break;
        const req = JSON.parse(buffer.subarray(4, size + 4)); buffer = buffer.subarray(size + 4); calls.push(req);
        handler(req, value => socket.write(encodeFrame({ id: req.id, result: value })), message => socket.write(encodeFrame({ id: req.id, error: { message } })));
      }
    });
  });
  await new Promise(resolve => server.listen(endpoint, resolve));
  const client = new OpenBrowserUseClient({ socketPath: endpoint, turnId: "initial" });
  t.after(async () => { client.close(); for (const s of sockets) s.destroy(); await new Promise(resolve => server.close(resolve)); });
  return { client, calls, tab: new OpenBrowserUseBrowser({ client }).tab(9) };
}

test("download ready ACK precedes action, collect and cancellation retain exact scope", async t => {
  let clicked = false;
  const f = await fixture(t, (req, reply, fail) => {
    if (req.method === "getInfo") return reply(info);
    if (req.method === "getControlState") return reply(state(7));
    if (req.method === "armDownloadWait") { assert.ok(req.params.timeoutMs <= 1000); return reply({ waiterId: "w", remainingMs: 500 }); }
    assert.equal(req.params.control_epoch, 7); assert.equal(req.params.turn_id, "initial");
    if (req.method === "browserAction") { clicked = true; return reply({ value: null, engine: { name: "playwright-crx", version: "0.15.0", playwrightVersion: "1.53.0" } }); }
    assert.equal(req.params.tabId, 9); assert.equal(req.params.waiterId, "w"); assert.equal(req.params.timeoutMs, undefined);
    if (req.method === "collectDownloadWait") { assert.ok(clicked); return reply(download); }
    if (req.method === "cancelDownloadWait") return reply({});
    fail("unexpected operation");
  });
  const wait = await f.tab.playwright.expectDownload({ timeoutMs: 1000 });
  assert.equal(wait.waiterId, "w"); assert.equal(wait.remainingMs, 500);
  await f.tab.getByRole("button", { name: "Upload" }).click();
  assert.equal((await wait.result()).downloadId, download.downloadId); await wait.cancel();
  await assert.rejects(wait.result(), /OBU_DOWNLOAD_WAIT_INVALID/);
  assert.deepEqual(f.calls.map(v => v.method), ["getInfo", "getControlState", "armDownloadWait", "browserAction", "collectDownloadWait", "cancelDownloadWait"]);
});

test("delayed ACK preserves ended scope and rejection never rearms or begins a turn", async t => {
  let ack;
  const f = await fixture(t, (req, reply, fail) => {
    if (req.method === "getInfo") return reply(info);
    if (req.method === "getControlState") return reply(state(7));
    if (req.method === "armDownloadWait") { ack = () => reply({ waiterId: "old", remainingMs: 500 }); return; }
    if (req.method === "turnEnded") return reply({ ...state(8), endedTurnId: "initial" });
    assert.equal(req.params.control_epoch, 7); assert.equal(req.params.turn_id, "initial"); fail("OBU_STALE_CONTROL_EPOCH");
  });
  const pending = f.tab.expectDownload(); while (!ack) await delay(1);
  await f.client.turnEnded(); ack(); const wait = await pending;
  await assert.rejects(wait.result(), /OBU_STALE_CONTROL_EPOCH/);
  await assert.rejects(wait.cancel(), /OBU_STALE_CONTROL_EPOCH/);
  assert.equal(f.client.controlEpoch, 8);
  assert.equal(f.calls.filter(v => v.method === "armDownloadWait").length, 1);
  assert.equal(f.calls.filter(v => v.method === "getControlState").length, 1);
});

test("expired result sends nothing but exact cancellation remains available and retryable", async t => {
  const f = await fixture(t, (req, reply) => reply(req.method === "getInfo" ? info : req.method === "getControlState" ? state(7) : req.method === "armDownloadWait" ? { waiterId: "short", remainingMs: 20 } : {}));
  const wait = await f.tab.expectDownload({ timeoutMs: 1000 }); await delay(30);
  await assert.rejects(wait.result(), /timed out/); await wait.cancel(); await wait.cancel();
  assert.ok(!f.calls.some(v => v.method === "collectDownloadWait"));
  for (const req of f.calls.filter(v => v.method === "cancelDownloadWait")) assert.deepEqual(req.params, { session_id: f.client.sessionId, turn_id: "initial", control_epoch: 7, tabId: 9, waiterId: "short" });
});

test("concurrent result conflicts immediately instead of issuing a second collect", async t => {
  let finish;
  const f = await fixture(t, (req, reply) => {
    if (req.method === "collectDownloadWait") { finish = () => reply(download); return; }
    reply(req.method === "getInfo" ? info : req.method === "getControlState" ? state(7) : { waiterId: "w", remainingMs: 500 });
  });
  const wait = await f.tab.expectDownload(), first = wait.result();
  await assert.rejects(wait.result(), /OBU_DOWNLOAD_WAIT_CONFLICT/);
  while (!finish) await delay(1); finish(); assert.equal((await first).downloadId, download.downloadId);
  await assert.rejects(wait.result(), /OBU_DOWNLOAD_WAIT_INVALID/);
  assert.equal(f.calls.filter(v => v.method === "collectDownloadWait").length, 1);
});

test("slow bootstrap and reconnect consume the original budget before any stale send", async t => {
  for (const raw of [false, true]) {
    const f = await fixture(t, (req, reply) => { if (req.method === "getInfo") return setTimeout(() => reply(info), 80); reply(state(7)); });
    await assert.rejects(raw ? f.client.request("armDownloadWait", { tabId: 9, timeoutMs: 30 }) : f.tab.expectDownload({ timeoutMs: 30 }), /timed out/);
    assert.ok(!f.calls.some(v => v.method === "armDownloadWait"));
  }
  const f = await fixture(t, (req, reply) => reply(req.method === "getInfo" ? info : req.method === "getControlState" ? state(7) : req.method === "armDownloadWait" ? { waiterId: "w", remainingMs: 40 } : {}));
  const wait = await f.tab.expectDownload();
  const connect = f.client.connect.bind(f.client); f.client.connect = async () => { await delay(60); return connect(); };
  await assert.rejects(wait.result(), /timed out/); assert.ok(!f.calls.some(v => v.method === "collectDownloadWait"));
  await wait.cancel(); assert.equal(f.calls.at(-1).method, "cancelDownloadWait");
});

test("raw download preflight rejects invalid inputs and exact capability mismatches", async t => {
  const f = await fixture(t, (req, reply) => reply(req.method === "getInfo" ? { metadata: { turnLifecycleVersion: 1, downloadWaitVersion: true } } : state(7)));
  for (const timeoutMs of [null, 0, -1, 1.5, 120001, NaN, Infinity]) await assert.rejects(f.tab.expectDownload({ timeoutMs }), /timeoutMs/);
  for (const tabId of [-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) await assert.rejects(f.client.request("armDownloadWait", { tabId }), /parameters/);
  for (const tabId of [0, Number.MAX_SAFE_INTEGER]) assert.doesNotThrow(() => downloadWaitParams("armDownloadWait", { tabId }));
  for (const options of [{ url: "https://example.test" }, null, [], { timeoutMs: 1, filename: "file" }]) await assert.rejects(f.tab.expectDownload(options), /options/);
  for (const waiterId of [null, "", 1, "界".repeat(43)]) await assert.rejects(f.client.request("collectDownloadWait", { tabId: 9, waiterId }), /parameters/);
  for (const scope of [{ session_id: "" }, { turn_id: "界".repeat(1366) }, { control_epoch: 0 }, { control_epoch: Infinity }]) await assert.rejects(f.client.request("armDownloadWait", { tabId: 9, ...scope }), /scope/);
  await assert.rejects(f.client.request("collectDownloadWait", { tabId: 9, waiterId: "w", timeoutMs: 1 }), /parameters/);
  assert.equal(f.calls.length, 0);
  for (const method of ["armDownloadWait", "collectDownloadWait", "cancelDownloadWait"]) await assert.rejects(f.client.request(method, method === "armDownloadWait" ? { tabId: 9 } : { tabId: 9, waiterId: "w" }), /OBU_DOWNLOAD_WAIT_UNSUPPORTED/);
  assert.deepEqual(f.calls.map(v => v.method), ["getInfo", "getControlState"]);
});

test("wire validation rejects ACK budget expansion and malformed results without replay", async t => {
  let response;
  const f = await fixture(t, (req, reply) => {
    if (req.method === "getInfo") return setTimeout(() => reply(info), 30);
    if (req.method === "getControlState") return reply(state(7));
    if (req.method === "armDownloadWait") return reply(response ?? { waiterId: "w", remainingMs: req.params.timeoutMs + 1 });
    reply(response);
  });
  await assert.rejects(f.tab.expectDownload({ timeoutMs: 1000 }), /acknowledgement/);
  response = { waiterId: "w", remainingMs: 500 }; const wait = await f.tab.expectDownload();
  for (const value of [{ downloadId: "" }, { downloadId: 1 }, { ...download, extra: true }, { downloadId: "界".repeat(86) }]) { response = value; await assert.rejects(wait.result(), /Invalid download acknowledgement/); }
  response = { ok: true }; await assert.rejects(wait.cancel(), /cancellation acknowledgement/);
  assert.equal(f.calls.filter(v => v.method === "armDownloadWait").length, 2);
  for (const remainingMs of [NaN, Infinity, -Infinity, 0, -1, true, 1001]) assert.throws(() => downloadWaitAck({ waiterId: "w", remainingMs }, 1000), /acknowledgement/);
  for (const waiterId of ["", "界".repeat(43), 1]) assert.throws(() => downloadWaitAck({ waiterId, remainingMs: 1 }, 1000), /acknowledgement/);

});

test("result download retains the arm scope without leaking waiterId or renewing the wait", async t => {
  const f = await fixture(t, (req, reply, fail) => {
    if (req.method === "getInfo") return reply(info);
    if (req.method === "getControlState") return reply(state(7));
    if (req.method === "armDownloadWait") return reply({ waiterId: "private-wait", remainingMs: 1000 });
    if (req.method === "turnEnded") return reply({ ...state(8), endedTurnId: "initial" });
    assert.equal(req.params.control_epoch, 7); assert.equal(req.params.turn_id, "initial"); assert.equal(req.params.tabId, 9);
    if (req.method === "collectDownloadWait") return reply(download);
    if (req.method === "cancelDownloadWait") { assert.equal(req.params.waiterId, "private-wait"); assert.equal(req.params.downloadId, undefined); return reply({}); }
    assert.equal(req.params.waiterId, undefined); assert.equal(req.params.downloadId, "page-guid");
    if (req.method === "downloadPath") return fail("OBU_DOWNLOAD_PATH_UNAVAILABLE");
    if (req.method === "cancelDownload") return fail("OBU_DOWNLOAD_CANCEL_UNSUPPORTED");
    fail("unexpected operation");
  });
  const wait = await f.tab.expectDownload();
  await f.client.turnEnded();
  const result = await wait.result();
  await wait.cancel();
  await assert.rejects(result.path(), /OBU_DOWNLOAD_PATH_UNAVAILABLE/);
  await assert.rejects(result.cancel(), /OBU_DOWNLOAD_CANCEL_UNSUPPORTED/);
  assert.equal(f.calls.filter(v => v.method === "getControlState").length, 1);
  assert.ok(!f.calls.some(v => v.method === "downloadURL"));
});

test("ready acknowledgement arriving inside reply reserve cannot outlive original deadline", async t => {
  const f = await fixture(t, (req, reply) => {
    if (req.method === "getInfo") return reply(info);
    if (req.method === "getControlState") return reply(state(7));
    setTimeout(() => reply({ waiterId: "late", remainingMs: 10 }), 80);
  });
  await assert.rejects(f.tab.expectDownload({ timeoutMs: 40 }), /timed out/);
  assert.equal(f.calls.filter(v => v.method === "armDownloadWait").length, 1);
  assert.ok(!f.calls.some(v => v.method === "collectDownloadWait"));
});

test("cancelling observation consumes only the waiter and raw results are validated", async t => {
  let response = {};
  const f = await fixture(t, (req, reply) => reply(req.method === "getInfo" ? info : req.method === "getControlState" ? state(7) : req.method === "armDownloadWait" ? { waiterId: "w", remainingMs: 500 } : response));
  const wait = await f.tab.expectDownload(); await wait.cancel();
  await assert.rejects(wait.result(), /OBU_DOWNLOAD_WAIT_INVALID/);
  response = { downloadId: "page-guid", extra: true };
  await assert.rejects(f.client.request("collectDownloadWait", { tabId: 9, waiterId: "w" }), /acknowledgement/);
  response = { cancelled: true };
  await assert.rejects(f.client.request("cancelDownloadWait", { tabId: 9, waiterId: "w" }), /cancellation acknowledgement/);
  assert.ok(!f.calls.some(v => v.method === "cancelDownload" || v.method === "downloadURL"));
});
