import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, realpath, rm, readFile } from "node:fs/promises";
import { tmpdir, endianness } from "node:os";
import { join, dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { OpenBrowserUseBrowser, OpenBrowserUseClient, encodeFrame } from "../dist/index.js";

const info = { metadata: { turnLifecycleVersion: 1, networkWaitVersion: 1 } };
const state = epoch => ({ controlEpoch: epoch, nextTurnId: `turn-${epoch}`, lifecycleVersion: 1, closing: false });
const result = event => ({ event, requestId: "request-1", url: "http://fixture.test/api", method: "pOsT", resourceType: "fetch", frameUrl: "http://fixture.test/", ...(event === "response" ? { status: 503, statusText: "Unavailable" } : {}) });
async function fixture(t, handler, native = false) {
  const root = await realpath(tmpdir()), directory = await mkdtemp(join(root, "obu-nw-"));
  const calls = [], sockets = new Set(); let child, server, endpoint;
  const bind = (read, write) => {
    let buffer = Buffer.alloc(0);
    read.on("data", chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const size = endianness() === "LE" ? buffer.readUInt32LE(0) : buffer.readUInt32BE(0);
        if (buffer.length < size + 4) break;
        const request = JSON.parse(buffer.subarray(4, size + 4)); buffer = buffer.subarray(size + 4); calls.push(request);
        handler(request, value => write.write(encodeFrame({ id: request.id, result: value })), message => write.write(encodeFrame({ id: request.id, error: { message } })));
      }
    });
  };
  if (native) {
    child = spawn(resolve(process.env.OBU_TEST_HOST_BINARY), ["host", "--socket-dir", directory], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    child.stderr.resume(); bind(child.stdout, child.stdin);
    for (let index = 0; index < 500; index++) {
      try { endpoint = JSON.parse(await readFile(join(directory, "active.json"), "utf8")).socketPath; break; } catch { await delay(10); }
    }
    assert.ok(endpoint, "real host endpoint");
  } else {
    endpoint = process.platform === "win32" ? `\\\\.\\pipe\\obu-nw-${randomUUID()}` : join(directory, "s.sock");
    server = createServer(socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); bind(socket, socket); });
    await new Promise(resolve => server.listen(endpoint, resolve));
  }
  const client = new OpenBrowserUseClient({ socketPath: endpoint, turnId: "initial" });
  t.after(async () => {
    client.close(); for (const socket of sockets) socket.destroy();
    if (server) await new Promise(resolve => server.close(resolve));
    if (child) { const exit = child.exitCode === null ? once(child, "exit") : Promise.resolve(); child.kill(); await exit; }
    assert.equal(await realpath(directory), directory); assert.equal(dirname(directory), root);
    await rm(directory, { recursive: true, force: true });
  });
  return { client, calls, tab: new OpenBrowserUseBrowser({ client }).tab(9) };
}

for (const native of [false, true]) test(`network arm/action/collect/cancel preserves metadata through ${native ? "real Go host" : "local IPC"}`, { skip: native && !process.env.OBU_TEST_HOST_BINARY }, async t => {
  let triggered = false;
  const f = await fixture(t, (req, reply) => {
    if (req.method === "getInfo") return reply(info);
    if (req.method === "getControlState") return reply(state(7));
    if (req.method === "armNetworkWait") { assert.equal(req.params.match.method, "pOsT"); return reply({ waiterId: "wait-1", remainingMs: 10 }); }
    if (req.method === "browserAction") { triggered = true; return reply({ value: null, engine: { name: "playwright-crx", version: "0.15.0", playwrightVersion: "1.53.0" } }); }
    if (req.method === "collectNetworkWait") { assert.ok(triggered); assert.equal(req.params.timeoutMs, undefined); return reply(result("response")); }
    reply({});
  }, native);
  const match = { url: "http://fixture.test/api", method: "pOsT", status: 503 };
  const arming = f.tab.playwright.expectResponse(match, { timeoutMs: 1000 }); match.method = "CHANGED";
  const wait = await arming;
  await f.tab.getByRole("button", { name: "Save" }).click();
  await delay(15); // ACK's network budget has elapsed; reading a saved result is still allowed.
  assert.deepEqual(await wait.result(), result("response"));
  assert.deepEqual(await wait.result({ timeoutMs: 1000 }), result("response"));
  await wait.cancel();
  assert.deepEqual(f.calls.map(call => call.method), ["getInfo", "getControlState", "armNetworkWait", "browserAction", "collectNetworkWait", "collectNetworkWait", "cancelNetworkWait"]);
  for (const call of f.calls.slice(2)) assert.equal(call.params.control_epoch, 7);
});

test("a delayed arm ACK cannot bind its handle to an already ended turn", async t => {
  let finish;
  const f = await fixture(t, (req, reply, fail) => {
    if (req.method === "getInfo") return reply(info);
    if (req.method === "getControlState") return reply(state(7));
    if (req.method === "armNetworkWait") { finish = () => reply({ waiterId: "old", remainingMs: 1000 }); return; }
    if (req.method === "turnEnded") return reply({ ...state(8), endedTurnId: "initial" });
    assert.equal(req.params.control_epoch, 7); assert.equal(req.params.turn_id, "initial"); fail("OBU_STALE_CONTROL_EPOCH");
  });
  const pending = f.tab.expectRequest({ url: "http://fixture.test/api" });
  while (!finish) await delay(1);
  await f.client.turnEnded(); finish();
  const wait = await pending;
  await assert.rejects(wait.result(), /OBU_STALE_CONTROL_EPOCH/);
  await assert.rejects(wait.cancel(), /OBU_STALE_CONTROL_EPOCH/);
  assert.equal(f.client.controlEpoch, 8);
  assert.equal(f.calls.filter(call => call.method === "armNetworkWait").length, 1);
});

test("short arm budgets include slow negotiation for both high-level and raw calls", async t => {
  for (const raw of [false, true]) {
    const f = await fixture(t, (req, reply) => {
      if (req.method === "getInfo") { setTimeout(() => reply(info), 250); return; }
      assert.equal(req.method, "getControlState"); reply(state(7));
    });
    await assert.rejects(raw ? f.client.request("armNetworkWait", { tabId: 9, event: "request", match: { url: "x" }, timeoutMs: 100 }) : f.tab.expectRequest({ url: "x" }, { timeoutMs: 100 }), /timed out/);
    assert.ok(!f.calls.some(call => call.method === "armNetworkWait"));
  }
});

test("unsupported capability and invalid match never silently arm or read diagnostics", async t => {
  const f = await fixture(t, (req, reply) => reply(req.method === "getInfo" ? { metadata: { turnLifecycleVersion: 1 } } : state(7)));
  for (const match of [{ url: "" }, { url: "🙂".repeat(1025) }, { url: "x", method: "é".repeat(65) }, { url: "x", status: 200 }, { url: "x", urlMatch: "regex" }, { url: "x", predicate: "true" }]) await assert.rejects(f.tab.expectRequest(match), /Invalid/);
  for (const timeoutMs of [null, 0, -1, 1.5, 120001, NaN]) await assert.rejects(f.tab.expectRequest({ url: "x" }, { timeoutMs }), /timeoutMs/);
  assert.equal(f.calls.length, 0);
  await assert.rejects(f.tab.expectResponse({ url: "x" }), /OBU_NETWORK_WAIT_UNSUPPORTED/);
  assert.deepEqual(f.calls.map(call => call.method), ["getInfo", "getControlState"]);
});

test("malformed ready and network result metadata are rejected without replay", async t => {
  let ack = { waiterId: "ok", remainingMs: 1000 }, value = result("response");
  const f = await fixture(t, (req, reply) => reply(req.method === "getInfo" ? info : req.method === "getControlState" ? state(7) : req.method === "armNetworkWait" ? ack : value));
  for (const bad of [{ waiterId: "", remainingMs: 1 }, { waiterId: "ok", remainingMs: 0 }, { waiterId: "ok", remainingMs: 10001 }, { ...ack, extra: true }]) { ack = bad; await assert.rejects(f.tab.expectResponse({ url: "x" }), /acknowledgement/); }
  ack = { waiterId: "ok", remainingMs: 1000 };
  const wait = await f.tab.expectResponse({ url: "x" });
  for (const bad of [{ ...value, event: "request" }, { ...value, status: 99 }, { ...value, status: null }, { ...value, url: "界".repeat(1366) }, { ...value, truncated: 1 }, { ...value, headers: {} }, { ...value, redirectedFrom: "" }]) { value = bad; await assert.rejects(wait.result(), /Invalid network wait result/); }
  assert.equal(f.calls.filter(call => call.method === "armNetworkWait").length, 5);
});
