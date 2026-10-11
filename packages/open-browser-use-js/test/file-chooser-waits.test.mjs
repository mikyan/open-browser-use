import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { tmpdir, endianness } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { OpenBrowserUseBrowser, OpenBrowserUseClient, encodeFrame } from "../dist/index.js";
import { fileChooserWaitAck, fileChooserWaitResult, fileChooserWaitParams } from "../dist/file-chooser-waits.js";

const info = { metadata: { turnLifecycleVersion: 1, fileChooserWaitVersion: 1 } };
const state = epoch => ({ controlEpoch: epoch, nextTurnId: `turn-${epoch}`, lifecycleVersion: 1, closing: false });
const chooser = { fileChooserId: "chooser-1", isMultiple: false };
async function fixture(t, handler, options = {}) {
  const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\obu-chooser-${randomUUID()}` : join(tmpdir(), `obu-chooser-${randomUUID()}.sock`);
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
  const client = new OpenBrowserUseClient({ socketPath: endpoint, turnId: "initial", ...options });
  t.after(async () => { client.close(); for (const s of sockets) s.destroy(); await new Promise(resolve => server.close(resolve)); });
  return { client, calls, tab: new OpenBrowserUseBrowser({ client }).tab(9) };
}

test("file setter preserves the default wire and permits an explicit reply grace without replay", async t => {
  const f = await fixture(t, (req, reply, fail) => {
    if (req.method === "getInfo") return reply(info);
    if (req.method === "getControlState") return reply(state(7));
    assert.equal(req.method, "setFileChooserFiles");
    assert.equal(req.params.control_epoch, 7);
    assert.equal(req.params.turn_id, "initial");
    if (req.params.fileChooserId === "rejected") return fail("OBU_FILE_CHOOSER_CONSUMED");
    if (req.params.timeoutMs === 50) return setTimeout(() => reply({}), 150);
    reply({});
  }, { timeoutMs: 100 });
  const budgets = [], request = f.client.request.bind(f.client);
  f.client.request = (method, params, options) => { budgets.push(options); return request(method, params, options); };
  await f.client.setFileChooserFiles("default", []);
  await f.client.setFileChooserFiles("slow", ["directory"], 50);
  await f.client.setFileChooserFiles("maximum", [], 120000);
  await assert.rejects(f.client.setFileChooserFiles("rejected", [], 1), /OBU_FILE_CHOOSER_CONSUMED/);
  assert.deepEqual(budgets, [undefined, { timeoutMs: 1050 }, { timeoutMs: 121000 }, { timeoutMs: 1001 }]);
  assert.deepEqual(f.calls.filter(v => v.method === "setFileChooserFiles").map(v => ({ id: v.params.fileChooserId, files: v.params.files, timeoutMs: v.params.timeoutMs })), [
    { id: "default", files: [], timeoutMs: undefined },
    { id: "slow", files: ["directory"], timeoutMs: 50 },
    { id: "maximum", files: [], timeoutMs: 120000 },
    { id: "rejected", files: [], timeoutMs: 1 }
  ]);
});

test("invalid file setter timeouts reject before discovery or a request", async t => {
  const f = await fixture(t, () => assert.fail("invalid timeout reached the wire"));
  for (const timeout of [null, true, "1", 0, -1, 1.5, NaN, Infinity, 120001]) {
    await assert.rejects(f.client.setFileChooserFiles("chooser", [], timeout), /timeoutMs must be an integer/);
  }
  assert.equal(f.calls.length, 0);
});

test("chooser ready ACK precedes action, collect and cancellation retain exact scope", async t => {
  let clicked = false;
  const f = await fixture(t, (req, reply, fail) => {
    if (req.method === "getInfo") return reply(info);
    if (req.method === "getControlState") return reply(state(7));
    if (req.method === "armFileChooserWait") { assert.ok(req.params.timeoutMs <= 1000); return reply({ waiterId: "w", remainingMs: 500 }); }
    assert.equal(req.params.control_epoch, 7); assert.equal(req.params.turn_id, "initial");
    if (req.method === "browserAction") { clicked = true; return reply({ value: null, engine: { name: "playwright-crx", version: "0.15.0", playwrightVersion: "1.53.0" } }); }
    assert.equal(req.params.tabId, 9); assert.equal(req.params.waiterId, "w"); assert.equal(req.params.timeoutMs, undefined);
    if (req.method === "collectFileChooserWait") { assert.ok(clicked); return reply(chooser); }
    if (req.method === "cancelFileChooserWait") return reply({});
    fail("unexpected operation");
  });
  const wait = await f.tab.playwright.expectFileChooser({ timeoutMs: 1000 });
  assert.equal(wait.waiterId, "w"); assert.equal(wait.remainingMs, 500);
  await f.tab.getByRole("button", { name: "Upload" }).click();
  assert.deepEqual(await wait.result(), chooser); await wait.cancel();
  assert.deepEqual(f.calls.map(v => v.method), ["getInfo", "getControlState", "armFileChooserWait", "browserAction", "collectFileChooserWait", "cancelFileChooserWait"]);
});

test("delayed ACK preserves ended scope and rejection never rearms or begins a turn", async t => {
  let ack;
  const f = await fixture(t, (req, reply, fail) => {
    if (req.method === "getInfo") return reply(info);
    if (req.method === "getControlState") return reply(state(7));
    if (req.method === "armFileChooserWait") { ack = () => reply({ waiterId: "old", remainingMs: 500 }); return; }
    if (req.method === "turnEnded") return reply({ ...state(8), endedTurnId: "initial" });
    assert.equal(req.params.control_epoch, 7); assert.equal(req.params.turn_id, "initial"); fail("OBU_STALE_CONTROL_EPOCH");
  });
  const pending = f.tab.expectFileChooser(); while (!ack) await delay(1);
  await f.client.turnEnded(); ack(); const wait = await pending;
  await assert.rejects(wait.result(), /OBU_STALE_CONTROL_EPOCH/);
  await assert.rejects(wait.cancel(), /OBU_STALE_CONTROL_EPOCH/);
  assert.equal(f.client.controlEpoch, 8);
  assert.equal(f.calls.filter(v => v.method === "armFileChooserWait").length, 1);
  assert.equal(f.calls.filter(v => v.method === "getControlState").length, 1);
});

test("expired result sends nothing but exact cancellation remains available and retryable", async t => {
  const f = await fixture(t, (req, reply) => reply(req.method === "getInfo" ? info : req.method === "getControlState" ? state(7) : req.method === "armFileChooserWait" ? { waiterId: "short", remainingMs: 20 } : {}));
  const wait = await f.tab.expectFileChooser({ timeoutMs: 1000 }); await delay(30);
  await assert.rejects(wait.result(), /timed out/); await wait.cancel(); await wait.cancel();
  assert.ok(!f.calls.some(v => v.method === "collectFileChooserWait"));
  for (const req of f.calls.filter(v => v.method === "cancelFileChooserWait")) assert.deepEqual(req.params, { session_id: f.client.sessionId, turn_id: "initial", control_epoch: 7, tabId: 9, waiterId: "short" });
});

test("concurrent result conflicts immediately instead of issuing a second collect", async t => {
  let finish;
  const f = await fixture(t, (req, reply) => {
    if (req.method === "collectFileChooserWait") { finish = () => reply(chooser); return; }
    reply(req.method === "getInfo" ? info : req.method === "getControlState" ? state(7) : { waiterId: "w", remainingMs: 500 });
  });
  const wait = await f.tab.expectFileChooser(), first = wait.result();
  await assert.rejects(wait.result(), /OBU_FILE_CHOOSER_WAIT_CONFLICT/);
  while (!finish) await delay(1); finish(); assert.deepEqual(await first, chooser);
  assert.equal(f.calls.filter(v => v.method === "collectFileChooserWait").length, 1);
});

test("slow bootstrap and reconnect consume the original budget before any stale send", async t => {
  for (const raw of [false, true]) {
    const f = await fixture(t, (req, reply) => { if (req.method === "getInfo") return setTimeout(() => reply(info), 80); reply(state(7)); });
    await assert.rejects(raw ? f.client.request("armFileChooserWait", { tabId: 9, timeoutMs: 30 }) : f.tab.expectFileChooser({ timeoutMs: 30 }), /timed out/);
    assert.ok(!f.calls.some(v => v.method === "armFileChooserWait"));
  }
  const f = await fixture(t, (req, reply) => reply(req.method === "getInfo" ? info : req.method === "getControlState" ? state(7) : req.method === "armFileChooserWait" ? { waiterId: "w", remainingMs: 40 } : {}));
  const wait = await f.tab.expectFileChooser();
  const connect = f.client.connect.bind(f.client); f.client.connect = async () => { await delay(60); return connect(); };
  await assert.rejects(wait.result(), /timed out/); assert.ok(!f.calls.some(v => v.method === "collectFileChooserWait"));
  await wait.cancel(); assert.equal(f.calls.at(-1).method, "cancelFileChooserWait");
});

test("raw chooser preflight rejects invalid inputs and exact capability mismatches", async t => {
  const f = await fixture(t, (req, reply) => reply(req.method === "getInfo" ? { metadata: { turnLifecycleVersion: 1, fileChooserWaitVersion: true } } : state(7)));
  for (const timeoutMs of [null, 0, -1, 1.5, 120001, NaN, Infinity]) await assert.rejects(f.tab.expectFileChooser({ timeoutMs }), /timeoutMs/);
  for (const tabId of [-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) await assert.rejects(f.client.request("armFileChooserWait", { tabId }), /parameters/);
  for (const tabId of [0, Number.MAX_SAFE_INTEGER]) assert.doesNotThrow(() => fileChooserWaitParams("armFileChooserWait", { tabId }));
  await assert.rejects(f.client.request("collectFileChooserWait", { tabId: 9, waiterId: "w", timeoutMs: 1 }), /parameters/);
  assert.equal(f.calls.length, 0);
  for (const method of ["armFileChooserWait", "collectFileChooserWait", "cancelFileChooserWait"]) await assert.rejects(f.client.request(method, method === "armFileChooserWait" ? { tabId: 9 } : { tabId: 9, waiterId: "w" }), /OBU_FILE_CHOOSER_WAIT_UNSUPPORTED/);
  assert.deepEqual(f.calls.map(v => v.method), ["getInfo", "getControlState"]);
});

test("wire validation rejects ACK budget expansion and malformed results without replay", async t => {
  let response;
  const f = await fixture(t, (req, reply) => {
    if (req.method === "getInfo") return setTimeout(() => reply(info), 30);
    if (req.method === "getControlState") return reply(state(7));
    if (req.method === "armFileChooserWait") return reply(response ?? { waiterId: "w", remainingMs: req.params.timeoutMs + 1 });
    reply(response);
  });
  await assert.rejects(f.tab.expectFileChooser({ timeoutMs: 1000 }), /acknowledgement/);
  response = { waiterId: "w", remainingMs: 500 }; const wait = await f.tab.expectFileChooser();
  for (const value of [{ fileChooserId: "", isMultiple: false }, { ...chooser, isMultiple: 1 }, { ...chooser, extra: true }, { ...chooser, fileChooserId: "界".repeat(43) }]) { response = value; await assert.rejects(wait.result(), /Invalid file chooser wait result/); }
  response = { ok: true }; await assert.rejects(wait.cancel(), /cancellation acknowledgement/);
  assert.equal(f.calls.filter(v => v.method === "armFileChooserWait").length, 2);
  for (const remainingMs of [NaN, Infinity, -Infinity, 0, -1, true, 1001]) assert.throws(() => fileChooserWaitAck({ waiterId: "w", remainingMs }, 1000), /acknowledgement/);
  assert.throws(() => fileChooserWaitResult({ fileChooserId: Infinity, isMultiple: false }), /Invalid/);
});
