import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { endianness, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { OpenBrowserUseBrowser, OpenBrowserUseClient, encodeFrame } from "../dist/index.js";

const disconnected = /OBU_SDK_BROWSER_DISCONNECTED:.*[Cc]reate a new client/;
const engine = { name: "playwright-crx", version: "fixture", playwrightVersion: "fixture" };
const state = epoch => ({ controlEpoch: epoch, nextTurnId: `turn-${epoch}`, closing: false, lifecycleVersion: 1 });
const info = { metadata: { turnLifecycleVersion: 1, directDownloadsVersion: 1,
  downloadWaitVersion: 1, fileChooserWaitVersion: 1, networkWaitVersion: 1, navigationWaitVersion: 1 } };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function result(request, host) {
  if (request.method === "getInfo") return info;
  if (request.method === "getControlState") return state(7);
  if (request.method.startsWith("arm")) return { waiterId: `${request.method}-original`, remainingMs: request.params.timeoutMs };
  if (request.method === "collectDownloadWait" || request.method === "downloadURL") return { downloadId: "original-download" };
  if (request.method === "downloadPath") return { path: "/mock/original.bin" };
  if (request.method === "cancelDownload") return { cancelled: true };
  if (request.method === "collectFileChooserWait") return { fileChooserId: "original-chooser", isMultiple: false };
  if (request.method === "collectNetworkWait") return { event: "request", requestId: "original-request", url: "https://fixture.test/", method: "GET", resourceType: "Document" };
  if (request.method.startsWith("cancel") || request.method === "collectNavigationWait") return {};
  if (request.method === "browserAction") return { value: host, engine };
  if (request.method === "createTab") return { id: 7 };
  return { host };
}

// Real local byte streams; replacing the listener reuses its exact address.
// Both hosts deliberately advertise the same numeric control epoch and tab.
async function fixture(t) {
  const root = await realpath(tmpdir()), directory = await mkdtemp(join(root, "obu-sdk-binding-"));
  const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\obu-sdk-binding-${randomUUID()}` : join(directory, "s.sock");
  const hosts = [], clients = [];
  const client = () => {
    const value = new OpenBrowserUseClient({ socketPath: endpoint, sessionId: "same-session", turnId: "original-turn", timeoutMs: 1000 });
    clients.push(value); return value;
  };
  const start = async (name, handler = () => false) => {
    const calls = [], sockets = new Set(); let connections = 0;
    const server = createServer(socket => {
      connections++; sockets.add(socket);
      socket.on("error", () => {}); socket.once("close", () => sockets.delete(socket));
      let buffer = Buffer.alloc(0);
      socket.on("data", chunk => {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 4) {
          const size = endianness() === "LE" ? buffer.readUInt32LE(0) : buffer.readUInt32BE(0);
          if (buffer.length < size + 4) break;
          const request = JSON.parse(buffer.subarray(4, size + 4)); buffer = buffer.subarray(size + 4);
          calls.push(request);
          const reply = value => socket.write(encodeFrame({ jsonrpc: "2.0", id: request.id, result: value }));
          if (!handler(request, reply, socket)) reply(result(request, name));
        }
      });
    });
    const host = { calls, get connections() { return connections; },
      async stop() { for (const socket of sockets) socket.destroy(); if (server.listening) await new Promise(resolve => server.close(resolve)); } };
    hosts.push(host);
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(endpoint, resolve); });
    return host;
  };
  t.after(async () => {
    for (const value of clients) value.close();
    for (const host of hosts) await host.stop();
    const actual = await realpath(directory);
    assert.equal(actual, directory); assert.equal(dirname(actual), root);
    await rm(actual, { recursive: true, force: true });
  });
  return { client, start };
}

for (const mode of ["EOF", "close"]) test(`${mode} permanently isolates old clients and handles from a replacement endpoint`, async t => {
  const f = await fixture(t), held = deferred();
  const a = await f.start("A", (request, _reply, socket) => {
    if (request.method !== "disconnect") return false;
    held.resolve();
    if (mode === "EOF") socket.end(encodeFrame({ id: request.id, result: {} }).subarray(0, 2));
    return true;
  });
  const client = f.client(), browser = new OpenBrowserUseBrowser({ client }), tab = browser.tab(7);
  const locator = tab.locator("#original");
  await locator.click();
  const download = await tab.downloadURL("https://fixture.test/file");
  const downloadWait = await tab.expectDownload(), chooserWait = await tab.expectFileChooser();
  const networkWait = await tab.expectRequest({ url: "https://fixture.test/" }), navigationWait = await tab.expectURL("https://fixture.test/next");
  const pending = client.request("disconnect"), rejected = assert.rejects(pending, mode === "EOF" ? /incomplete frame/ : /client closed/);
  await held.promise;
  if (mode === "close") client.close();
  await rejected; await a.stop();
  const b = await f.start("B");
  const attempts = [
    ["connect", () => client.connect()], ["request", () => client.request("ping")],
    ["manual epoch", () => client.request("browserAction", { tabId: 7, action: "click", timeoutMs: 1000, control_epoch: 7 }, { timeoutMs: 3000 })],
    ["locator", () => locator.click()], ["download path", () => download.path()], ["download cancel", () => download.cancel()],
    ["download wait result", () => downloadWait.result()], ["download wait cancel", () => downloadWait.cancel()],
    ["chooser result", () => chooserWait.result()], ["chooser cancel", () => chooserWait.cancel()],
    ["network result", () => networkWait.result()], ["network cancel", () => networkWait.cancel()],
    ["navigation result", () => navigationWait.result()], ["navigation cancel", () => navigationWait.cancel()],
    ["compound create", () => browser.newTab()], ["beginTurn", () => client.beginTurn("must-not-rebind")],
    ["refreshControlState", () => client.refreshControlState()]
  ];
  const outcomes = [];
  for (const [name, call] of attempts) {
    try { await call(); outcomes.push({ name, error: null }); }
    catch (error) { outcomes.push({ name, error: error.message }); }
  }
  const replacementCalls = b.calls.slice(), replacementConnections = b.connections;
  t.diagnostic(JSON.stringify({ mode, outcomes, replacementConnections, replacementCalls }));
  // A new client is the explicit recovery boundary, even when values collide.
  const fresh = f.client(); await fresh.beginTurn("fresh-turn");
  assert.equal((await fresh.browserAction(7, "click")).value, "B");
  const last = b.calls.at(-1);
  assert.equal(last.params.turn_id, "fresh-turn"); assert.equal(last.params.control_epoch, 7);
  assert.deepEqual(outcomes.filter(item => !disconnected.test(item.error ?? "")), []);
  assert.equal(replacementConnections, 0); assert.deepEqual(replacementCalls, []);
  assert.equal(client.controlEpoch, 7); assert.equal(client.turnId, "original-turn");
});

test("explicit close before any connection is terminal", async t => {
  const f = await fixture(t), host = await f.start("A"), client = f.client();
  client.close();
  await assert.rejects(client.connect(), disconnected);
  await assert.rejects(client.getInfo(), disconnected);
  await assert.rejects(client.beginTurn(), disconnected);
  assert.equal(host.connections, 0); assert.deepEqual(host.calls, []);
});

test("close while concurrent first connections are pending cannot revive the client", async t => {
  const f = await fixture(t), host = await f.start("A"), client = f.client();
  const first = client.connect(), second = client.connect();
  const rejected = Promise.all([assert.rejects(first, /closed|DISCONNECTED/), assert.rejects(second, /closed|DISCONNECTED/)]);
  client.close(); await rejected;
  await assert.rejects(client.connect(), disconnected);
  await assert.rejects(client.request("ping"), disconnected);
  assert.deepEqual(host.calls, []);
});

test("close during shared control initialization rejects every waiter and never initializes a replacement", async t => {
  const f = await fixture(t), requested = deferred();
  const a = await f.start("A", request => { if (request.method === "getInfo") { requested.resolve(); return true; } return false; });
  const client = f.client();
  const first = client.createTab(), second = client.createTab();
  const rejected = Promise.all([assert.rejects(first, /client closed/), assert.rejects(second, /client closed/)]);
  await requested.promise; client.close(); await rejected; await a.stop();
  const b = await f.start("B");
  await assert.rejects(client.createTab(), disconnected); await assert.rejects(client.beginTurn(), disconnected);
  assert.equal(client.controlEpoch, null); assert.equal(b.connections, 0);
});

test("a control acknowledgement queued just before close cannot refresh a terminal client", async t => {
  const f = await fixture(t);
  await f.start("A", (request, _reply, socket) => {
    if (request.method !== "getControlState") return false;
    socket.write(Buffer.concat([
      encodeFrame({ jsonrpc: "2.0", id: request.id, result: state(8) }),
      encodeFrame({ jsonrpc: "2.0", method: "close-now", params: {} })
    ])); return true;
  });
  const client = f.client(); client.onNotification(() => client.close());
  await assert.rejects(client.beginTurn("late-turn"), disconnected);
  assert.equal(client.controlEpoch, null); assert.equal(client.turnId, "original-turn");
  await assert.rejects(client.connect(), disconnected);
});

test("initial connection failure remains retryable until explicit close", async t => {
  const f = await fixture(t), client = f.client();
  await assert.rejects(client.request("ping"), error => !disconnected.test(error.message));
  const host = await f.start("A");
  assert.deepEqual(await client.request("ping"), { host: "A" });
  assert.equal(host.connections, 1);
  client.close(); await assert.rejects(client.connect(), disconnected);
});

test("a healthy response timeout and a business error preserve the original connection without replay", async t => {
  const f = await fixture(t); let late;
  const host = await f.start("A", (request, reply, socket) => {
    if (request.method === "slow") { late = reply; return true; }
    if (request.method === "business-error") {
      socket.write(encodeFrame({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "original business rejection" } })); return true;
    }
    if (request.method === "after-timeout") { late({ stale: true }); reply({ current: true }); return true; }
    return false;
  });
  const client = f.client();
  await assert.rejects(client.request("slow", {}, { timeoutMs: 100 }), /timed out/);
  assert.deepEqual(await client.request("after-timeout"), { current: true });
  await assert.rejects(client.request("business-error"), /original business rejection/);
  assert.deepEqual(await client.request("ping"), { host: "A" });
  assert.equal(host.connections, 1); assert.equal(host.calls.filter(call => call.method === "slow").length, 1);
});
