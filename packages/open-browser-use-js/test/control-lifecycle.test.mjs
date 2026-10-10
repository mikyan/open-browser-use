import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { endianness, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { OpenBrowserUseBrowser, OpenBrowserUseClient, encodeFrame } from "../dist/index.js";

async function fixture(t, handler, timeoutMs = 500) {
  const root = await realpath(tmpdir());
  const directory = await mkdtemp(join(root, "obu-control-"));
  const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\obu-control-${randomUUID()}` : join(directory, "s.sock");
  const calls = [], sockets = new Set();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    socket.on("data", chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const length = endianness() === "LE" ? buffer.readUInt32LE(0) : buffer.readUInt32BE(0);
        if (buffer.length < length + 4) break;
        const request = JSON.parse(buffer.subarray(4, length + 4));
        buffer = buffer.subarray(length + 4);
        calls.push(request);
        const reply = result => socket.write(encodeFrame({ jsonrpc: "2.0", id: request.id, result }));
        const fail = message => socket.write(encodeFrame({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message } }));
        handler(request, reply, fail);
      }
    });
  });
  await new Promise(resolve => server.listen(endpoint, resolve));
  const client = new OpenBrowserUseClient({ socketPath: endpoint, sessionId: "test", turnId: "initial", timeoutMs });
  t.after(async () => {
    client.close(); for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    const actual = await realpath(directory);
    assert.equal(dirname(actual), root); assert.equal(actual, directory);
    await rm(actual, { recursive: true, force: true });
  });
  return { client, calls };
}
const info = { metadata: { turnLifecycleVersion: 1 } };
const state = (epoch, next = `next-${epoch}`) => ({ controlEpoch: epoch, nextTurnId: next, closing: false, lifecycleVersion: 1 });
const ended = (request, epoch) => ({ ...state(epoch), endedTurnId: request.params.turn_id });

test("raw navigation verifies the returned loader before and after document readiness", async t => {
  const loaders = ["old-document", "new-document", "superseding-document", "new-document", "new-document"];
  let reads = 0, trees = 0;
  const { client, calls } = await fixture(t, (request, reply) => {
    if (request.method === "getInfo") return reply(info);
    if (request.method === "getControlState") return reply(state(40));
    if (request.method !== "executeCdp") return reply({});
    switch (request.params.method) {
      case "Page.navigate": return reply({ loaderId: "new-document" });
      case "Page.getFrameTree": return reply({ frameTree: { frame: { loaderId: loaders[trees++] } } });
      case "Runtime.evaluate": reads++; return reply({ result: { value: { readyState: "complete" } } });
      default: return reply({});
    }
  });
  const browser = new OpenBrowserUseBrowser({ client });
  await browser.cdp.navigate(1, "http://fixture.test", { timeoutMs: 1000 });
  assert.equal(trees, 5);
  assert.equal(reads, 2);
  assert.equal(calls.filter(call => call.params.method === "Page.navigate").length, 1);
  assert.ok(calls.filter(call => call.method === "executeCdp").every(call => call.params.control_epoch === 40 && call.params.turn_id === "initial"));
});

test("raw navigation propagates a stale loader read without retrying or replaying navigation", async t => {
  const { client, calls } = await fixture(t, (request, reply, fail) => {
    if (request.method === "getInfo") return reply(info);
    if (request.method === "getControlState") return reply(state(40));
    if (request.params.method === "Page.navigate") return reply({ loaderId: "new-document" });
    if (request.params.method === "Page.getFrameTree") return fail("OBU_STALE_CONTROL_EPOCH: ended while navigating");
    reply({});
  });
  const browser = new OpenBrowserUseBrowser({ client });
  await assert.rejects(browser.cdp.navigate(1, "http://fixture.test", { timeoutMs: 1000 }), /OBU_STALE_CONTROL_EPOCH/);
  assert.equal(calls.filter(call => call.params.method === "Page.navigate").length, 1);
  assert.equal(calls.filter(call => call.params.method === "Page.getFrameTree").length, 1);
  assert.equal(calls.filter(call => call.params.method === "Runtime.evaluate").length, 0);
});

test("concurrent first actions negotiate once and capture caller arguments before bootstrap", async t => {
  let release;
  const { client, calls } = await fixture(t, (request, reply) => {
    if (request.method === "getInfo") { release = () => reply(info); return; }
    reply(request.method === "getControlState" ? state(41) : request.params);
  });
  const params = { args: { value: "submitted" } };
  const first = client.request("action", params);
  const second = client.getTabs();
  params.args.value = "changed later";
  while (!release) await new Promise(resolve => setImmediate(resolve));
  release();
  const values = await Promise.all([first, second]);
  assert.equal(values[0].args.value, "submitted");
  assert.ok(values.every(value => value.control_epoch === 41 && value.turn_id === "initial"));
  assert.deepEqual(calls.map(call => call.method), ["getInfo", "getControlState", "action", "getTabs"]);
});

test("an end advances only later submissions; already submitted work retains its old epoch", async t => {
  let epoch = 41;
  const { client, calls } = await fixture(t, (request, reply, fail) => {
    if (request.method === "getInfo") return reply(info);
    if (request.method === "getControlState") return reply(state(epoch));
    if (request.params.control_epoch !== epoch) return fail("OBU_STALE_CONTROL_EPOCH: old work");
    if (request.method === "turnEnded" || request.method === "finalizeTabs") return reply(ended(request, ++epoch));
    reply(request.params);
  });
  await client.createTab();
  const ending = client.turnEnded();
  const queued = assert.rejects(client.createTab(), /OBU_STALE_CONTROL_EPOCH/);
  await ending; await queued;
  assert.equal(client.controlEpoch, 42); assert.equal(client.turnId, "next-42");
  assert.equal((await client.createTab()).control_epoch, 42);
  await client.finalizeTabs([]);
  assert.equal(client.controlEpoch, 43); assert.equal(client.turnId, "next-43");
  assert.equal(calls.filter(call => call.method === "getControlState").length, 1);
  assert.equal(calls.findLast(call => call.method === "finalizeTabs").params.turn_id, "next-42");
});

test("a lost end acknowledgement never refreshes or replays until explicit beginTurn", async t => {
  let epoch = 51, lateReply;
  const { client, calls } = await fixture(t, (request, reply, fail) => {
    if (request.method === "getInfo") return reply(info);
    if (request.method === "getControlState") return reply(state(epoch));
    if (request.method === "turnEnded") { epoch++; lateReply = () => reply(ended(request, epoch)); return; }
    if (request.params.control_epoch !== epoch) return fail("OBU_STALE_CONTROL_EPOCH: explicit recovery required");
    reply(request.params);
  }, 60);
  await client.createTab();
  await assert.rejects(client.turnEnded(), /timed out/);
  lateReply();
  await assert.rejects(client.createTab(), /OBU_STALE_CONTROL_EPOCH/);
  assert.equal(client.controlEpoch, 51);
  assert.equal(calls.filter(call => call.method === "getControlState").length, 1);
  await client.beginTurn("recovered");
  assert.equal((await client.createTab()).control_epoch, 52);
  assert.equal(client.turnId, "recovered");
  assert.equal(calls.filter(call => call.method === "turnEnded").length, 1);
});

test("explicit epoch metadata bypasses managed state without changing its bound turn", async t => {
  const { client, calls } = await fixture(t, (request, reply) => {
    if (request.method === "getInfo") return reply(info);
    if (request.method === "getControlState") return reply(state(61));
    reply(request.params);
  });
  await client.createTab();
  await assert.rejects(client.request("action", { session_id: "other" }), /separate client/);
  await assert.rejects(client.request("action", { turn_id: "other" }), /separate client/);
  const result = await client.request("turnEnded", { session_id: "other", turn_id: "other-turn", control_epoch: 99 });
  assert.equal(result.control_epoch, 99);
  assert.equal(client.controlEpoch, 61); assert.equal(client.turnId, "initial");
  assert.equal(calls.filter(call => call.method === "turnEnded").length, 1);
});

test("old extension negotiation preserves legacy requests; discovery is exempt", async t => {
  const { client, calls } = await fixture(t, (request, reply) => reply(request.method === "getInfo" ? { version: "old" } : request.params));
  await client.request("ping");
  await client.getInfo();
  assert.equal(calls.length, 2);
  const first = await client.createTab();
  assert.equal(first.control_epoch, undefined);
  await client.getTabs();
  assert.equal(calls.filter(call => call.method === "getInfo").length, 2);
  assert.equal(calls.filter(call => call.method === "getControlState").length, 0);
  assert.equal(await client.refreshControlState(), null);
});

test("invalid lifecycle metadata or bootstrap fails without sending the protected action", async t => {
  for (const invalid of [{ metadata: { turnLifecycleVersion: 2 } }, info]) {
    await t.test(JSON.stringify(invalid), async t => {
      const { client, calls } = await fixture(t, (request, reply) => reply(request.method === "getInfo" ? invalid : { controlEpoch: -1 }));
      await assert.rejects(client.createTab(), /Unsupported turn lifecycle|Invalid control state/);
      assert.ok(!calls.some(call => call.method === "createTab"));
    });
  }
});

test("bootstrap consumes the original RPC deadline and reduces the engine budget before send", async t => {
  const { client, calls } = await fixture(t, (request, reply) => {
    if (request.method === "getInfo") return setTimeout(() => reply(info), 80);
    reply(request.method === "getControlState" ? state(71) : request.params);
  }, 2000);
  const result = await client.request("browserAction", { tabId: 1, action: "click", timeoutMs: 10_000 }, { timeoutMs: 1500 });
  assert.ok(result.timeoutMs > 0 && result.timeoutMs <= 430, `remaining engine budget ${result.timeoutMs}`);
  assert.equal(calls.filter(call => call.method === "browserAction").length, 1);
});

test("insufficient engine grace after handshake prevents sending an action", async t => {
  const { client, calls } = await fixture(t, (request, reply) => {
    if (request.method === "getInfo") return setTimeout(() => reply(info), 80);
    reply(state(81));
  });
  await assert.rejects(client.request("browserAction", { tabId: 1, action: "click" }, { timeoutMs: 1050 }), /timed out before browserAction/);
  assert.ok(!calls.some(call => call.method === "browserAction"));
});

test("a shorter concurrent deadline does not inherit the bootstrap caller's longer budget", async t => {
  const { client, calls } = await fixture(t, (request, reply) => {
    if (request.method === "getInfo") return setTimeout(() => reply(info), 100);
    reply(request.method === "getControlState" ? state(91) : request.params);
  });
  const first = client.createTab();
  await assert.rejects(client.request("getTabs", {}, { timeoutMs: 20 }), /timed out/);
  await first;
  assert.ok(!calls.some(call => call.method === "getTabs"));
});

test("raw CDP rechecks attachment and never moves execution across an end during attach", async t => {
  let epoch = 101, holdAttach = false, releaseAttach;
  const { client, calls } = await fixture(t, (request, reply) => {
    if (request.method === "getInfo") return reply(info);
    if (request.method === "getControlState") return reply(state(epoch));
    if (request.method === "turnEnded") return reply(ended(request, ++epoch));
    if (request.method === "attach" && holdAttach) { releaseAttach = () => reply({}); return; }
    reply({});
  });
  const cdp = new OpenBrowserUseBrowser({ client }).cdp;
  await cdp.call(1, "Runtime.evaluate", { expression: "1" });
  await cdp.call(1, "Runtime.evaluate", { expression: "2" });
  assert.equal(calls.filter(call => call.method === "attach").length, 2);
  holdAttach = true;
  const pending = cdp.call(1, "Runtime.evaluate", { expression: "must not execute" });
  while (!releaseAttach) await new Promise(resolve => setImmediate(resolve));
  await client.turnEnded();
  const rejected = assert.rejects(pending, /OBU_STALE_CONTROL_EPOCH/);
  releaseAttach();
  await rejected;
  assert.equal(calls.filter(call => call.method === "executeCdp").length, 2);
});

test("newTab and legacy CDP navigation keep one scope across their RPC stages", async t => {
  for (const operation of ["newTab", "navigate"]) await t.test(operation, async t => {
    let epoch = 111, release;
    const { client, calls } = await fixture(t, (request, reply) => {
      if (request.method === "getInfo") return reply(info);
      if (request.method === "getControlState") return reply(state(epoch));
      if (request.method === "turnEnded") return reply(ended(request, ++epoch));
      if (request.method === "createTab") { release = () => reply({ id: 1 }); return; }
      if (request.method === "executeCdp" && request.params.method === "Page.enable") { release = () => reply({}); return; }
      reply({});
    }, 1500);
    const browser = new OpenBrowserUseBrowser({ client });
    const pending = operation === "newTab" ? browser.newTab({ url: "http://example.test" }) : browser.cdp.navigate(1, "http://example.test", { timeoutMs: 500 });
    while (!release) await new Promise(resolve => setImmediate(resolve));
    await client.turnEnded();
    const rejected = assert.rejects(pending, /OBU_STALE_CONTROL_EPOCH/);
    release(); await rejected;
    assert.ok(!calls.some(call => call.method === "browserAction" || call.params.method === "Page.navigate"));
  });
});

test("event waits validate bounds and lose handshake time from their wire budget", async t => {
  const { client, calls } = await fixture(t, (request, reply) => {
    if (request.method === "getInfo") return setTimeout(() => reply(info), 80);
    reply(request.method === "getControlState" ? state(121) : request.params);
  }, 100);
  for (const invalid of [0, -1, 1.5, 120001, NaN]) await assert.rejects(client.waitForDownload(1, invalid), /integer between/);
  assert.equal(calls.length, 0);
  const result = await client.waitForDownload(1, 300);
  assert.ok(Number.isInteger(result.timeoutMs) && result.timeoutMs > 0 && result.timeoutMs <= 230, JSON.stringify(result));
  const chooser = await client.waitForFileChooser(1);
  assert.ok(chooser.timeoutMs >= 9900 && chooser.timeoutMs <= 10000);
});

test("a long client default cannot replenish short high-level action budgets after handshake", async t => {
  for (const operation of ["browserAction", "waitForFileChooser", "waitForDownload", "newTab"]) await t.test(operation, async t => {
    const { client, calls } = await fixture(t, (request, reply) => {
      if (request.method === "getInfo") return setTimeout(() => reply(info), 250);
      reply(request.method === "getControlState" ? state(131) : request.method === "createTab" ? { id: 1 } : request.params);
    }, 10000);
    const browser = new OpenBrowserUseBrowser({ client });
    const pending = operation === "browserAction" ? client.browserAction(1, "click", { timeoutMs: 100 })
      : operation === "newTab" ? browser.newTab({ url: "http://fixture.test", timeoutMs: 100 })
      : client[operation](1, 100);
    await assert.rejects(pending, /timed out before/);
    assert.ok(!calls.some(call => ["browserAction", "waitForFileChooser", "waitForDownload", "createTab"].includes(call.method)), JSON.stringify(calls));
  });
});

test("raw protected calls cap a long RPC deadline by the submitted operation budget", async t => {
  for (const method of ["browserAction", "waitForFileChooser", "waitForDownload"]) await t.test(method, async t => {
    const { client, calls } = await fixture(t, (request, reply) => {
      if (request.method === "getInfo") return setTimeout(() => reply(info), 250);
      reply(request.method === "getControlState" ? state(141) : request.params);
    }, 10000);
    await assert.rejects(client.request(method, { tabId: 1, action: "click", timeoutMs: 100 }), /timed out before/);
    assert.ok(!calls.some(call => call.method === method));
  });
});
