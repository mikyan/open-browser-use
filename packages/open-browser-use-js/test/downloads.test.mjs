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

const info = { metadata: { turnLifecycleVersion: 1, directDownloadsVersion: 1, mediaDownloadsVersion: 1 } };
const state = epoch => ({ controlEpoch: epoch, nextTurnId: `turn-${epoch}`, lifecycleVersion: 1, closing: false });
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

test("media download sends one frozen locator, uses its own capability and returns a scoped Download", async t => {
  const f = await fixture(t, (req, reply) => {
    if (req.method === "getInfo") return reply(info);
    if (req.method === "getControlState") return reply(state(7));
    assert.equal(req.params.control_epoch, 7);
    if (req.method === "downloadMedia") {
      assert.deepEqual(req.params.locator, [{ kind: "frame", selector: "#child" }, { kind: "css", selector: "img" }]);
      assert.equal(req.params.filename, "image.png");
      assert.equal(req.params.url, undefined);
      return reply({ downloadId: "media" });
    }
    assert.equal(req.params.downloadId, "media");
    reply(req.method === "downloadPath" ? { path: "C:\\Downloads\\image.png" } : { cancelled: true });
  });
  const options = { filename: "image.png", timeoutMs: 1000 };
  const pending = f.tab.frameLocator("#child").locator("img").downloadMedia(options);
  options.filename = "changed.png";
  const result = await pending;
  assert.equal(await result.path(), "C:\\Downloads\\image.png");
  await result.cancel();
  assert.equal(f.calls.filter(x => x.method === "downloadMedia").length, 1);
  assert.ok(!f.calls.some(x => x.method === "browserAction" || x.method === "downloadURL"));
});

test("media download rejects missing capability and includes discovery in the original budget", async t => {
  for (const version of [undefined, true, 2]) {
    const f = await fixture(t, (req, reply) => reply(req.method === "getInfo" ? { metadata: { ...info.metadata, mediaDownloadsVersion: version } } : state(7)));
    await assert.rejects(f.tab.locator("img").downloadMedia(), /OBU_MEDIA_DOWNLOADS_UNSUPPORTED/);
    await assert.rejects(f.client.request("downloadMedia", { tabId: 9, locator: [{kind: "css", selector: "img"}], control_epoch: 7 }), /OBU_MEDIA_DOWNLOADS_UNSUPPORTED/);
    assert.ok(!f.calls.some(x => x.method === "downloadMedia"));
  }
  const f = await fixture(t, (req, reply) => req.method === "getInfo" ? void setTimeout(() => reply(info), 250) : reply(state(7)));
  await assert.rejects(f.tab.locator("img").downloadMedia({timeoutMs: 100}), /timed out/);
  assert.ok(!f.calls.some(x => x.method === "downloadMedia"));
  assert.throws(() => f.tab.playwright.downloadMedia(), /nonempty locator/);
  assert.throws(() => f.tab.locator("img").downloadMedia({filename: "../x"}), /filename/);
});

for (const native of [false, true]) test(`direct download path retry and cancel through ${native ? "real host" : "IPC"}`, { skip: native && !process.env.OBU_TEST_HOST_BINARY }, async t => {
  let reads = 0;
  const f = await fixture(t, (req, reply, fail) => {
    if (req.method === "getInfo") return reply(info);
    if (req.method === "getControlState") return reply(state(7));
    assert.equal(req.params.control_epoch, 7); assert.equal(req.params.turn_id, "initial");
    assert.ok(req.params.timeoutMs > 0 && req.params.timeoutMs <= 1000);
    if (req.method === "downloadURL") {
      assert.equal(req.params.url, "https://fixture.test/file"); assert.equal(req.params.filename, "报告.csv");
      assert.equal(req.params.saveAs, undefined); return reply({ downloadId: "opaque" });
    }
    assert.equal(req.params.downloadId, "opaque");
    if (req.method === "downloadPath") return reads++ ? reply({ path: "C:\\Downloads\\报告.csv" }) : fail("OBU_DOWNLOAD_TIMEOUT");
    assert.equal(req.method, "cancelDownload"); reply({ cancelled: true });
  }, native);
  const options = { filename: "报告.csv", timeoutMs: 1000 };
  const starting = f.tab.downloadURL("https://fixture.test/file", options); options.filename = "changed.csv";
  const download = await starting;
  assert.equal(download.downloadId, "opaque");
  await assert.rejects(download.path({ timeoutMs: 1000 }), /OBU_DOWNLOAD_TIMEOUT/);
  assert.equal(await download.path({ timeoutMs: 1000 }), "C:\\Downloads\\报告.csv");
  assert.equal(await download.cancel({ timeoutMs: 1000 }), undefined);
  assert.equal(f.calls.filter(req => req.method === "downloadURL").length, 1);
});

for (const method of ["downloadURL", "downloadMedia", "waitForDownload"]) test(`${method} late ACK handle retains its original epoch`, async t => {
  let finish;
  const f = await fixture(t, (req, reply, fail) => {
    if (req.method === "getInfo") return reply(info);
    if (req.method === "getControlState") return reply(state(7));
    if (req.method === method) { finish = () => reply({ downloadId: "old" }); return; }
    if (req.method === "turnEnded") return reply({ ...state(8), endedTurnId: "initial" });
    assert.equal(req.params.control_epoch, 7); assert.equal(req.params.turn_id, "initial"); fail("OBU_STALE_CONTROL_EPOCH");
  });
  const pending = method === "downloadURL" ? f.tab.downloadURL("https://fixture.test/file") : method === "downloadMedia" ? f.tab.locator("img").downloadMedia() : f.tab.waitForDownload();
  while (!finish) await delay(1);
  await f.client.turnEnded(); finish(); const download = await pending;
  await assert.rejects(download.path(), /STALE_CONTROL_EPOCH/); await assert.rejects(download.cancel(), /STALE_CONTROL_EPOCH/);
  assert.equal(f.calls.filter(req => req.method === method).length, 1);
});

test("direct download short budget includes discovery and never dispatches expired start", async t => {
  for (const raw of [false, true]) {
    const f = await fixture(t, (req, reply) => {
      if (req.method === "getInfo") return void setTimeout(() => reply(info), 250);
      assert.equal(req.method, "getControlState"); reply(state(7));
    });
    await assert.rejects(raw ? f.client.request("downloadURL", { tabId: 9, url: "https://fixture.test/file", timeoutMs: 100 }) : f.tab.downloadURL("https://fixture.test/file", { timeoutMs: 100 }), /timed out/);
    assert.ok(!f.calls.some(req => req.method === "downloadURL"));
  }
});

test("download validation and version negotiation fail before a browser side effect", async t => {
  const f = await fixture(t, (req, reply) => reply(req.method === "getInfo" ? { metadata: { turnLifecycleVersion: 1, directDownloadsVersion: true } } : state(7)));
  for (const url of ["", "file:///tmp/x", "data:text/plain,a", "https://user:secret@fixture.test/", "https://fixture.test/\n", "https://fixture.test/" + "🙂".repeat(2048)]) assert.throws(() => f.tab.downloadURL(url), /Invalid/);
  for (const filename of ["", "..", "../a", "CON.txt", "a/b", "a\\b", "a.", "a ", "a\0", "🙂".repeat(64)]) assert.throws(() => f.tab.downloadURL("https://fixture.test/", { filename }), /filename/);
  for (const timeoutMs of [null, 0, -1, true, 1.5, 120001]) assert.throws(() => f.tab.downloadURL("https://fixture.test/", { timeoutMs }), /timeoutMs/);
  for (const options of [{ method: "POST" }, { saveAs: true }, { conflictAction: "overwrite" }, [], null]) assert.throws(() => f.tab.downloadURL("https://fixture.test/", options), /options/);
  assert.equal(f.calls.length, 0);
  await assert.rejects(f.tab.downloadURL("https://fixture.test/"), /OBU_DIRECT_DOWNLOADS_UNSUPPORTED/);
  assert.ok(!f.calls.some(req => req.method === "downloadURL"));
  const { OpenBrowserUseDownload, downloadID } = await import("../dist/downloads.js");
  const untouched = new OpenBrowserUseDownload("d", async () => { assert.fail("invalid options must not send"); });
  await assert.rejects(untouched.path({ saveAs: true }), /options/); await assert.rejects(untouched.cancel({ method: "POST" }), /options/);
  for (const ack of [{ downloadId: "" }, { downloadId: 3 }, { downloadId: "d", path: "arbitrary" }, null]) assert.throws(() => downloadID(ack), /acknowledgement/);
  for (const ack of [{ path: "" }, { path: "x\0" }, { path: "x", extra: 1 }, {}, null]) await assert.rejects(new OpenBrowserUseDownload("d", async () => ack).path(), /acknowledgement/);
  for (const ack of [{ cancelled: 1 }, { cancelled: false }, { cancelled: true, extra: 1 }, {}, null]) await assert.rejects(new OpenBrowserUseDownload("d", async () => ack).cancel(), /acknowledgement/);
});

test("raw download deadlines reject null and NaN instead of silently defaulting", async t => {
  const f = await fixture(t, (req, reply) => {
    assert.ok(["getInfo", "getControlState"].includes(req.method));
    reply(req.method === "getInfo" ? info : state(7));
  });
  for (const method of ["downloadURL", "downloadMedia", "downloadPath", "cancelDownload"]) {
    for (const timeoutMs of [null, NaN, 0, true, 1.5]) await assert.rejects(f.client.request(method, { downloadId: "d", tabId: 9, url: "https://fixture.test/", timeoutMs }), /timeoutMs/);
  }
});

test("a lost download start ACK is never retried automatically", async t => {
  const f = await fixture(t, (req, reply) => {
    if (req.method === "getInfo") return reply(info);
    if (req.method === "getControlState") return reply(state(7));
    assert.equal(req.method, "downloadURL");
  });
  await assert.rejects(f.tab.downloadURL("https://fixture.test/", { timeoutMs: 100 }), /timed out/);
  assert.equal(f.calls.filter(req => req.method === "downloadURL").length, 1);
});
