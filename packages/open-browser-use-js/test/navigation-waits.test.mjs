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

const info = { metadata: { turnLifecycleVersion: 1, navigationWaitVersion: 1 } };
const state = epoch => ({ controlEpoch: epoch, nextTurnId: `turn-${epoch}`, lifecycleVersion: 1, closing: false });
const result = event => ({ event, requestId: "request-1", url: "http://fixture.test/api", method: "pOsT", resourceType: "fetch", frameUrl: "http://fixture.test/", ...(event === "response" ? { status: 503, statusText: "Unavailable" } : {}) });
async function fixture(t, handler, native = false) {
  const root = await realpath(tmpdir()), directory = await mkdtemp(join(root, "obu-nav-"));
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
    endpoint = process.platform === "win32" ? `\\\\.\\pipe\\obu-nav-${randomUUID()}` : join(directory, "s.sock");
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

for (const native of [false, true]) test(`navigation ready/action/collect/cancel through ${native ? "real host" : "IPC"}`, { skip: native && !process.env.OBU_TEST_HOST_BINARY }, async t => {
  let triggered = false;
  const f = await fixture(t, (req, reply) => {
    if (req.method === "getInfo") return reply(info);
    if (req.method === "getControlState") return reply(state(7));
    assert.equal(req.params.control_epoch, 7); assert.equal(req.params.turn_id, "initial");
    if (req.method === "armNavigationWait") {
      assert.ok(req.params.timeoutMs > 0 && req.params.timeoutMs <= 1000);
      if (req.params.event === "url") { assert.equal(req.params.url, "**/next"); assert.equal(req.params.waitUntil, "commit"); assert.equal(req.params.state, undefined); }
      else { assert.equal(req.params.state, "networkidle"); assert.equal(req.params.url, undefined); }
      return reply({ waiterId: "wait-1", remainingMs: 10 });
    }
    if (req.method === "browserAction") { triggered = true; return reply({ value: null, engine: { name: "playwright-crx", version: "0.15.0", playwrightVersion: "1.53.0" } }); }
    assert.equal(req.params.timeoutMs, undefined); assert.ok(triggered); reply({});
  }, native);
  const options = { waitUntil: "commit", timeoutMs: 1000 };
  const arming = f.tab.playwright.expectURL("**/next", options); options.waitUntil = "load";
  const wait = await arming;
  const loaded = await f.tab.expectLoadState({ state: "networkidle", timeoutMs: 1000 });
  await f.tab.getByRole("button", { name: "Next" }).click(); await delay(15);
  assert.equal(await wait.result(), undefined); assert.equal(await wait.result({ timeoutMs: 1000 }), undefined);
  await loaded.result(); await wait.cancel(); await loaded.cancel();
  assert.equal(f.calls.filter(req => req.method === "armNavigationWait").length, 2);
});

test("navigation handle from a late ACK keeps the old scope and never rearms", async t => {
  let finish;
  const f = await fixture(t, (req, reply, fail) => {
    if (req.method === "getInfo") return reply(info);
    if (req.method === "getControlState") return reply(state(7));
    if (req.method === "armNavigationWait") { finish = () => reply({ waiterId: "old", remainingMs: 1000 }); return; }
    if (req.method === "turnEnded") return reply({ ...state(8), endedTurnId: "initial" });
    assert.equal(req.params.control_epoch, 7); assert.equal(req.params.turn_id, "initial"); fail("OBU_STALE_CONTROL_EPOCH");
  });
  const pending = f.tab.expectURL("**/next"); while (!finish) await delay(1);
  await f.client.turnEnded(); finish(); const wait = await pending;
  await assert.rejects(wait.result(), /STALE_CONTROL_EPOCH/); await assert.rejects(wait.cancel(), /STALE_CONTROL_EPOCH/);
  assert.equal(f.calls.filter(call => call.method === "armNavigationWait").length, 1);
});

test("navigation arm budget includes slow discovery for high level and raw requests", async t => {
  for (const raw of [false, true]) {
    const f = await fixture(t, (req, reply) => {
      if (req.method === "getInfo") { setTimeout(() => reply(info), 250); return; }
      assert.equal(req.method, "getControlState"); reply(state(7));
    });
    await assert.rejects(raw ? f.client.request("armNavigationWait", { tabId: 9, event: "url", url: "x", timeoutMs: 100 }) : f.tab.expectURL("x", { timeoutMs: 100 }), /timed out/);
    assert.ok(!f.calls.some(req => req.method === "armNavigationWait"));
  }
});

test("navigation validates options, rejects unsupported versions and strict ACKs", async t => {
  const f = await fixture(t, (req, reply) => reply(req.method === "getInfo" ? { metadata: { turnLifecycleVersion: 1, navigationWaitVersion: true } } : state(7)));
  for (const url of ["", "🙂".repeat(1025), /next/]) assert.throws(() => f.tab.expectURL(url), /Invalid/);
  for (const options of [{ waitUntil: "idle" }, { waitUntil: null }, { state: "load" }, { timeoutMs: 0 }, { timeoutMs: 1.5 }, { timeoutMs: 120001 }]) assert.throws(() => f.tab.expectURL("x", options), /Invalid|timeoutMs/);
  for (const options of [{ state: "commit" }, { state: null }, { waitUntil: "load" }]) assert.throws(() => f.tab.expectLoadState(options), /Invalid/);
  assert.equal(f.calls.length, 0); await assert.rejects(f.tab.expectURL("x"), /OBU_NAVIGATION_WAIT_UNSUPPORTED/);
  const { navigationWaitAck, OpenBrowserUseNavigationWait } = await import("../dist/navigation-waits.js");
  for (const value of [{ waiterId: "", remainingMs: 1 }, { waiterId: "w", remainingMs: 0 }, { waiterId: "w", remainingMs: 1001 }, { waiterId: "w", remainingMs: 1, extra: true }]) assert.throws(() => navigationWaitAck(value, 1000), /acknowledgement/);
  for (const value of [null, [], { value: null }, true]) {
    const wait = new OpenBrowserUseNavigationWait({ waiterId: "w", remainingMs: 1 }, async () => value);
    await assert.rejects(wait.result(), /acknowledgement/); await assert.rejects(wait.cancel(), /acknowledgement/);
  }
});
