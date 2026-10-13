import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { tmpdir, endianness } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { OpenBrowserUseBrowser, OpenBrowserUseClient, encodeFrame } from "../dist/index.js";
import { dialogAck, dialogDecision, dialogParams, dialogResult } from "../dist/dialogs.js";
const info = { metadata: { turnLifecycleVersion: 1, dialogVersion: 1 } };
const state = epoch => ({ controlEpoch: epoch, nextTurnId: `turn-${epoch}`, lifecycleVersion: 1, closing: false });
const decision = { type: "prompt", accept: true, message: 'false,"中文"\n🙂', promptText: 'null,"x"\\n🙂' };
const result = { type: "prompt", message: decision.message, defaultValue: "original default", accepted: true, promptText: decision.promptText };
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

test("typed dialog ready precedes trigger; original literal decision, scope and confirmed result survive", async t => {
  let clicked = false;
  const f = await fixture(t, (req, reply) => {
    if (req.method === "getInfo") return reply(info);
    if (req.method === "getControlState") return reply(state(7));
    assert.equal(req.params.control_epoch, 7); assert.equal(req.params.turn_id, "initial");
    if (req.method === "armDialog") {
      const { session_id, turn_id, control_epoch, tabId, timeoutMs, ...selected } = req.params;
      assert.deepEqual(selected, decision); assert.equal(tabId, 9); assert.ok(timeoutMs > 0 && timeoutMs <= 1000);
      return reply({ dialogId: "original", remainingMs: 500 });
    }
    if (req.method === "browserAction") { clicked = true; return reply({ value: null, engine: { name: "playwright-crx", version: "0.15.0", playwrightVersion: "1.53.0" } }); }
    assert.equal(req.params.dialogId, "original"); assert.equal(req.params.tabId, 9); assert.equal(req.params.timeoutMs, undefined);
    if (req.method === "collectDialog") { assert.equal(clicked, true); return reply(result); }
    assert.equal(req.method, "cancelDialog"); reply({});
  });
  const selected = { ...decision }, waiting = f.tab.playwright.expectDialog(selected, { timeoutMs: 1000 });
  selected.promptText = "changed after submission";
  const wait = await waiting; assert.equal(wait.dialogId, "original"); assert.ok(wait.remainingMs > 0 && wait.remainingMs <= 500);
  await f.tab.locator("#trigger").click(); assert.deepEqual(await wait.result(), result); await wait.cancel();
  await assert.rejects(wait.result(), /OBU_DIALOG_EXPIRED/);
  assert.deepEqual(f.calls.map(row => row.method), ["getInfo", "getControlState", "armDialog", "browserAction", "collectDialog", "cancelDialog"]);
});

test("raw API preserves exact strings and prompt/default distinctions for all native types", async t => {
  let chosen;
  const f = await fixture(t, (req, reply) => {
    if (req.method === "getInfo") return reply(info);
    if (req.method === "getControlState") return reply(state(7));
    if (req.method === "armDialog") { chosen = req.params; return reply({ dialogId: "raw", remainingMs: 500 }); }
    if (req.method === "collectDialog") return reply({ type: chosen.type, message: chosen.message ?? "", defaultValue: "", accepted: chosen.accept, ...(chosen.type === "prompt" && chosen.accept ? { promptText: chosen.promptText ?? "" } : {}) });
    reply({});
  });
  for (const chosen of [{ type: "alert", accept: true }, { type: "confirm", accept: false }, { type: "beforeunload", accept: false }, { type: "prompt", accept: false }, { type: "prompt", accept: true, message: "" }]) {
    assert.equal((await f.client.armDialog(9, chosen, { timeoutMs: 1000 })).dialogId, "raw");
    const value = await f.client.collectDialog(9, "raw"); assert.equal(value.accepted, chosen.accept); assert.equal(value.type, chosen.type);
    if (chosen.type === "prompt" && chosen.accept) assert.equal(value.promptText, ""); else assert.equal(Object.hasOwn(value, "promptText"), false);
    await f.client.cancelDialog(9, "raw");
  }
});

test("schema rejects unknown keys, unpaired Unicode, bad booleans and unsupported capability before side effects", async t => {
  const f = await fixture(t, (req, reply) => reply(req.method === "getInfo" ? { metadata: { turnLifecycleVersion: 1, dialogVersion: true } } : state(7)));
  for (const value of [null, [], {}, { ...decision, type: "print" }, { ...decision, accept: "true" }, { ...decision, extra: 1 }, { ...decision, message: "\ud800" }, { ...decision, promptText: "🙂".repeat(2049) }, { type: "confirm", accept: true, promptText: "" }, { type: "prompt", accept: false, promptText: "" }]) {
    await assert.rejects(f.tab.expectDialog(value));
  }
  for (const timeoutMs of [null, 0, 1.5, Infinity, 120001]) await assert.rejects(f.tab.expectDialog(decision, { timeoutMs }));
  for (const change of [{ tabId: -1 }, { tabId: true }, { control_epoch: 0 }, { session_id: "\ud800" }, { timeoutMs: null }, { extra: 1 }]) await assert.rejects(f.client.request("armDialog", { tabId: 9, ...decision, ...change }));
  for (const dialogId of [null, "", 1, "界".repeat(43), "\ud800"]) await assert.rejects(f.client.collectDialog(9, dialogId));
  assert.equal(f.calls.length, 0);
  for (const method of ["armDialog", "collectDialog", "cancelDialog"]) await assert.rejects(f.client.request(method, method === "armDialog" ? { tabId: 9, ...decision } : { tabId: 9, dialogId: "raw" }), /OBU_DIALOG_UNSUPPORTED/);
  assert.deepEqual(f.calls.map(row => row.method), ["getInfo", "getControlState"]);
  assert.doesNotThrow(() => dialogDecision({ type: "prompt", accept: true, message: "🙂".repeat(2048), promptText: "" }));
  assert.throws(() => dialogParams("collectDialog", { tabId: 9, dialogId: "d", timeoutMs: 5 }));
});

test("raw and typed collection reject malformed or changed decisions without rearming", async t => {
  let response = { dialogId: "d", remainingMs: 500 };
  const f = await fixture(t, (req, reply) => reply(req.method === "getInfo" ? info : req.method === "getControlState" ? state(7) : response));
  const wait = await f.tab.expectDialog(decision);
  for (const invalid of [{ ...result, accepted: "true" }, { ...result, defaultValue: "\ud800" }, { ...result, extra: 1 }, { type: "prompt", message: "", defaultValue: "", accepted: true }, { type: "confirm", message: "", defaultValue: "", accepted: false, promptText: "" }]) {
    response = invalid; await assert.rejects(wait.result(), /Invalid native dialog result/);
  }
  response = { ...result, promptText: "different" }; await assert.rejects(wait.result(), /differs from original decision/);
  response = { ...result, message: "different" }; await assert.rejects(wait.result(), /differs from original decision/);
  response = { ...result, accepted: false }; delete response.promptText; await assert.rejects(wait.result(), /differs from original decision/);
  response = { ok: true }; await assert.rejects(wait.cancel(), /cancellation/); response = {}; await wait.cancel();
  assert.equal(f.calls.filter(row => row.method === "armDialog").length, 1);
  for (const remainingMs of [0, -1, true, NaN, Infinity, 1001]) assert.throws(() => dialogAck({ dialogId: "d", remainingMs }, 1000));
  assert.throws(() => dialogResult({ ...result, promptText: "界".repeat(2731) }));
});

test("expiry blocks collect, retains original cancellation scope, and never extends on later collection", async t => {
  const f = await fixture(t, (req, reply) => reply(req.method === "getInfo" ? info : req.method === "getControlState" ? state(7) : req.method === "armDialog" ? { dialogId: "short", remainingMs: 20 } : {}));
  const wait = await f.tab.expectDialog(decision); await delay(30); await assert.rejects(wait.result(), /timed out/);
  await wait.cancel(); await wait.cancel(); assert.ok(!f.calls.some(row => row.method === "collectDialog"));
  for (const row of f.calls.filter(row => row.method === "cancelDialog")) assert.deepEqual(row.params, { session_id: f.client.sessionId, turn_id: "initial", control_epoch: 7, tabId: 9, dialogId: "short" });
});

test("concurrent collection issues one native observation and close never creates a replacement connection", async t => {
  let finish;
  const f = await fixture(t, (req, reply) => {
    if (req.method === "collectDialog") { finish = () => reply(result); return; }
    reply(req.method === "getInfo" ? info : req.method === "getControlState" ? state(7) : { dialogId: "d", remainingMs: 1000 });
  });
  const wait = await f.tab.expectDialog(decision), first = wait.result(); await assert.rejects(wait.result(), /OBU_DIALOG_BUSY/);
  while (!finish) await delay(1); finish(); assert.deepEqual(await first, result);
  f.client.close(); const count = f.calls.length; await assert.rejects(wait.cancel(), /DISCONNECTED/); assert.equal(f.calls.length, count);
});

test("late ready and late native result cannot renew the original monotonic deadline", async t => {
  for (const stage of ["getInfo", "armDialog", "collectDialog"]) {
    const f = await fixture(t, (req, reply) => {
      const value = req.method === "getInfo" ? info : req.method === "getControlState" ? state(7) : req.method === "armDialog" ? { dialogId: "late", remainingMs: 20 } : result;
      if (req.method === stage) setTimeout(() => reply(value), 70); else reply(value);
    });
    if (stage === "collectDialog") { const wait = await f.tab.expectDialog(decision, { timeoutMs: 1000 }); await assert.rejects(wait.result(), /timed out/); }
    else await assert.rejects(f.tab.expectDialog(decision, { timeoutMs: 30 }), /timed out/);
    assert.ok(f.calls.filter(row => row.method === "armDialog").length <= 1); assert.ok(f.calls.filter(row => row.method === "collectDialog").length <= 1);
  }
});

test("late ready ACK after turn end keeps the old epoch without automatic rearm", async t => {
  let ack;
  const f = await fixture(t, (req, reply, fail) => {
    if (req.method === "getInfo") return reply(info);
    if (req.method === "getControlState") return reply(state(7));
    if (req.method === "armDialog") { ack = () => reply({ dialogId: "old", remainingMs: 500 }); return; }
    if (req.method === "turnEnded") return reply({ ...state(8), endedTurnId: "initial" });
    assert.equal(req.params.turn_id, "initial"); assert.equal(req.params.control_epoch, 7); fail("OBU_STALE_CONTROL_EPOCH");
  });
  const pending = f.tab.expectDialog(decision); while (!ack) await delay(1); await f.client.turnEnded(); ack(); const wait = await pending;
  await assert.rejects(wait.result(), /OBU_STALE_CONTROL_EPOCH/); await assert.rejects(wait.cancel(), /OBU_STALE_CONTROL_EPOCH/);
  assert.equal(f.client.controlEpoch, 8); assert.equal(f.calls.filter(row => row.method === "armDialog").length, 1);
});
