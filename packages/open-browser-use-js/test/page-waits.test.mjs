import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { tmpdir, endianness } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { OpenBrowserUseBrowser, OpenBrowserUseClient, encodeFrame } from "../dist/index.js";
import { pageWaitAck, pageWaitParams } from "../dist/page-waits.js";

const info = { metadata: { turnLifecycleVersion: 1, pageWaitVersion: 1, directDownloadsVersion: 1 } };
const state = epoch => ({ controlEpoch: epoch, nextTurnId: `turn-${epoch}`, lifecycleVersion: 1, closing: false });
const download = { tabId: 12 };
const engine = { name: "playwright-crx", version: "0.15.0", playwrightVersion: "1.53.0" };
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
    if (req.method === "armPageWait") { assert.ok(req.params.timeoutMs <= 1000); return reply({ waiterId: "w", remainingMs: 500 }); }
    assert.equal(req.params.control_epoch, 7); assert.equal(req.params.turn_id, "initial");
    if (req.method === "browserAction") { clicked = true; return reply({ value: null, engine: { name: "playwright-crx", version: "0.15.0", playwrightVersion: "1.53.0" } }); }
    assert.equal(req.params.tabId, 9); assert.equal(req.params.waiterId, "w"); assert.equal(req.params.timeoutMs, undefined);
    if (req.method === "collectPageWait") { assert.ok(clicked); return reply(download); }
    if (req.method === "cancelPageWait") return reply({});
    fail("unexpected operation");
  });
  const wait = await f.tab.playwright.expectPage({ timeoutMs: 1000 });
  assert.equal(wait.waiterId, "w"); assert.ok(wait.remainingMs > 0 && wait.remainingMs <= 500);
  await f.tab.getByRole("button", { name: "Upload" }).click();
  assert.equal((await wait.result()).id, download.tabId); await wait.cancel();
  await assert.rejects(wait.result(), /OBU_PAGE_WAIT_INVALID/);
  assert.deepEqual(f.calls.map(v => v.method), ["getInfo", "getControlState", "armPageWait", "browserAction", "collectPageWait", "cancelPageWait"]);
});

test("returned child retains original scope across locator/CDP/cleanup and beginTurn", async t => {
  let epoch = 7;
  const f = await fixture(t, (req, reply) => {
    if (req.method === "getInfo") return reply(info);
    if (req.method === "getControlState") return reply(state(epoch));
    if (req.method === "armPageWait") return reply({ waiterId: "w", remainingMs: 1000 });
    if (req.method === "collectPageWait") return reply({ tabId: 12 });
    if (req.method === "browserAction") {
      assert.equal(req.params.tabId, 12); assert.equal(req.params.turn_id, "initial"); assert.equal(req.params.control_epoch, 7);
      assert.equal(req.params.waiterId, undefined);
      return reply({ value: null, engine });
    }
    reply({});
  });
  const wait = await f.tab.expectPage(), child = await wait.result();
  assert.equal(child.id, 12); const locator = child.locator("#once");
  await locator.click(); epoch = 8; await f.client.beginTurn(); const count = f.calls.length;
  for (const action of [() => locator.click(), () => child.evaluate("location.href"), () => child.close(), () => child.expectPage(), () => child.browser.client.request("getTabs"), () => child.browser.client.beginTurn()]) {
    await assert.rejects(async () => action(), /OBU_STALE_CONTROL_EPOCH/);
  }
  assert.equal(f.calls.length, count);
  await wait.cancel(); assert.equal(f.calls.at(-1).params.control_epoch, 7);
});

test("collect arriving after original deadline fails without replay", async t => {
  const f = await fixture(t, (req, reply) => {
    if (req.method === "getInfo") return reply(info);
    if (req.method === "getControlState") return reply(state(7));
    if (req.method === "armPageWait") return reply({ waiterId: "w", remainingMs: 40 });
    if (req.method === "collectPageWait") return setTimeout(() => reply({ tabId: 12 }), 80);
    reply({});
  });
  const wait = await f.tab.expectPage(); await assert.rejects(wait.result(), /timed out/);
  assert.equal(f.calls.filter(x => x.method === "collectPageWait").length, 1);
});

test("delayed ACK preserves ended scope and rejection never rearms or begins a turn", async t => {
  let ack;
  const f = await fixture(t, (req, reply, fail) => {
    if (req.method === "getInfo") return reply(info);
    if (req.method === "getControlState") return reply(state(7));
    if (req.method === "armPageWait") { ack = () => reply({ waiterId: "old", remainingMs: 500 }); return; }
    if (req.method === "turnEnded") return reply({ ...state(8), endedTurnId: "initial" });
    assert.equal(req.params.control_epoch, 7); assert.equal(req.params.turn_id, "initial"); fail("OBU_STALE_CONTROL_EPOCH");
  });
  const pending = f.tab.expectPage(); while (!ack) await delay(1);
  await f.client.turnEnded(); ack(); const wait = await pending;
  await assert.rejects(wait.result(), /OBU_STALE_CONTROL_EPOCH/);
  await assert.rejects(wait.cancel(), /OBU_STALE_CONTROL_EPOCH/);
  assert.equal(f.client.controlEpoch, 8);
  assert.equal(f.calls.filter(v => v.method === "armPageWait").length, 1);
  assert.equal(f.calls.filter(v => v.method === "getControlState").length, 1);
});

test("expired result sends nothing but exact cancellation remains available and retryable", async t => {
  const f = await fixture(t, (req, reply) => reply(req.method === "getInfo" ? info : req.method === "getControlState" ? state(7) : req.method === "armPageWait" ? { waiterId: "short", remainingMs: 20 } : {}));
  const wait = await f.tab.expectPage({ timeoutMs: 1000 }); await delay(30);
  await assert.rejects(wait.result(), /timed out/); await wait.cancel(); await wait.cancel();
  assert.ok(!f.calls.some(v => v.method === "collectPageWait"));
  for (const req of f.calls.filter(v => v.method === "cancelPageWait")) assert.deepEqual(req.params, { session_id: f.client.sessionId, turn_id: "initial", control_epoch: 7, tabId: 9, waiterId: "short" });
});

test("concurrent result conflicts immediately instead of issuing a second collect", async t => {
  let finish;
  const f = await fixture(t, (req, reply) => {
    if (req.method === "collectPageWait") { finish = () => reply(download); return; }
    reply(req.method === "getInfo" ? info : req.method === "getControlState" ? state(7) : { waiterId: "w", remainingMs: 500 });
  });
  const wait = await f.tab.expectPage(), first = wait.result();
  await assert.rejects(wait.result(), /OBU_PAGE_WAIT_CONFLICT/);
  while (!finish) await delay(1); finish(); assert.equal((await first).id, download.tabId);
  await assert.rejects(wait.result(), /OBU_PAGE_WAIT_INVALID/);
  assert.equal(f.calls.filter(v => v.method === "collectPageWait").length, 1);
});

test("slow bootstrap and reconnect consume the original budget before any stale send", async t => {
  for (const raw of [false, true]) {
    const f = await fixture(t, (req, reply) => { if (req.method === "getInfo") return setTimeout(() => reply(info), 80); reply(state(7)); });
    await assert.rejects(raw ? f.client.request("armPageWait", { tabId: 9, timeoutMs: 30 }) : f.tab.expectPage({ timeoutMs: 30 }), /timed out/);
    assert.ok(!f.calls.some(v => v.method === "armPageWait"));
  }
  const f = await fixture(t, (req, reply) => reply(req.method === "getInfo" ? info : req.method === "getControlState" ? state(7) : req.method === "armPageWait" ? { waiterId: "w", remainingMs: 40 } : {}));
  const wait = await f.tab.expectPage();
  const connect = f.client.connect.bind(f.client); f.client.connect = async () => { await delay(60); return connect(); };
  await assert.rejects(wait.result(), /timed out/); assert.ok(!f.calls.some(v => v.method === "collectPageWait"));
  await wait.cancel(); assert.equal(f.calls.at(-1).method, "cancelPageWait");
});

test("raw download preflight rejects invalid inputs and exact capability mismatches", async t => {
  const f = await fixture(t, (req, reply) => reply(req.method === "getInfo" ? { metadata: { turnLifecycleVersion: 1, pageWaitVersion: true } } : state(7)));
  for (const timeoutMs of [null, 0, -1, 1.5, 120001, NaN, Infinity]) await assert.rejects(f.tab.expectPage({ timeoutMs }), /timeoutMs/);
  for (const tabId of [-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) await assert.rejects(f.client.request("armPageWait", { tabId }), /parameters/);
  for (const tabId of [0, Number.MAX_SAFE_INTEGER]) assert.doesNotThrow(() => pageWaitParams("armPageWait", { tabId }));
  for (const options of [{ url: "https://example.test" }, null, [], { timeoutMs: 1, filename: "file" }]) await assert.rejects(f.tab.expectPage(options), /options/);
  for (const waiterId of [null, "", 1, "界".repeat(43)]) await assert.rejects(f.client.request("collectPageWait", { tabId: 9, waiterId }), /parameters/);
  for (const scope of [{ session_id: "" }, { turn_id: "界".repeat(1366) }, { control_epoch: 0 }, { control_epoch: Infinity }]) await assert.rejects(f.client.request("armPageWait", { tabId: 9, ...scope }), /scope/);
  await assert.rejects(f.client.request("collectPageWait", { tabId: 9, waiterId: "w", timeoutMs: 1 }), /parameters/);
  assert.equal(f.calls.length, 0);
  for (const method of ["armPageWait", "collectPageWait", "cancelPageWait"]) await assert.rejects(f.client.request(method, method === "armPageWait" ? { tabId: 9 } : { tabId: 9, waiterId: "w" }), /OBU_PAGE_WAIT_UNSUPPORTED/);
  assert.deepEqual(f.calls.map(v => v.method), ["getInfo", "getControlState"]);
});

test("wire validation rejects ACK budget expansion and malformed results without replay", async t => {
  let response;
  const f = await fixture(t, (req, reply) => {
    if (req.method === "getInfo") return setTimeout(() => reply(info), 30);
    if (req.method === "getControlState") return reply(state(7));
    if (req.method === "armPageWait") return reply(response ?? { waiterId: "w", remainingMs: req.params.timeoutMs + 1 });
    reply(response);
  });
  await assert.rejects(f.tab.expectPage({ timeoutMs: 1000 }), /acknowledgement/);
  response = { waiterId: "w", remainingMs: 500 }; const wait = await f.tab.expectPage();
  for (const value of [{ tabId: -1 }, { tabId: true }, { tabId: 9 }, { tabId: 1.5 }, { ...download, extra: true }, { tabId: Number.MAX_SAFE_INTEGER + 1 }]) { response = value; await assert.rejects(wait.result(), /Invalid page wait result/); }
  response = { ok: true }; await assert.rejects(wait.cancel(), /cancellation acknowledgement/);
  assert.equal(f.calls.filter(v => v.method === "armPageWait").length, 2);
  for (const remainingMs of [NaN, Infinity, -Infinity, 0, -1, true, 1001]) assert.throws(() => pageWaitAck({ waiterId: "w", remainingMs }, 1000), /acknowledgement/);
  for (const waiterId of ["", "界".repeat(43), 1]) assert.throws(() => pageWaitAck({ waiterId, remainingMs: 1 }, 1000), /acknowledgement/);

});

test("ready acknowledgement arriving inside reply reserve cannot outlive original deadline", async t => {
  const f = await fixture(t, (req, reply) => {
    if (req.method === "getInfo") return reply(info);
    if (req.method === "getControlState") return reply(state(7));
    setTimeout(() => reply({ waiterId: "late", remainingMs: 10 }), 80);
  });
  await assert.rejects(f.tab.expectPage({ timeoutMs: 40 }), /timed out/);
  assert.equal(f.calls.filter(v => v.method === "armPageWait").length, 1);
  assert.ok(!f.calls.some(v => v.method === "collectPageWait"));
});

test("cancelling observation consumes only the waiter and raw results are validated", async t => {
  let response = {};
  const f = await fixture(t, (req, reply) => reply(req.method === "getInfo" ? info : req.method === "getControlState" ? state(7) : req.method === "armPageWait" ? { waiterId: "w", remainingMs: 500 } : response));
  const wait = await f.tab.expectPage(); await wait.cancel();
  await assert.rejects(wait.result(), /OBU_PAGE_WAIT_INVALID/);
  response = { tabId: 12, extra: true };
  await assert.rejects(f.client.request("collectPageWait", { tabId: 9, waiterId: "w" }), /result/);
  response = { cancelled: true };
  await assert.rejects(f.client.request("cancelPageWait", { tabId: 9, waiterId: "w" }), /cancellation acknowledgement/);
  assert.ok(!f.calls.some(v => v.method === "cancelDownload" || v.method === "downloadURL"));
});
