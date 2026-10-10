import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { endianness, tmpdir } from "node:os";
import { join } from "node:path";
import { OpenBrowserUseBrowser, OpenBrowserUseClient, encodeFrame } from "../dist/index.js";
import { MAX_PAGE_EXPORT_BYTES, pageExportParams, validatePageExport } from "../dist/page-exports.js";

const info = { metadata: { turnLifecycleVersion: 1, pageExportVersion: 1 } };
const state = epoch => ({ controlEpoch: epoch, nextTurnId: `turn-${epoch}`, lifecycleVersion: 1, closing: false });
const result = (format, bytes) => ({ format, mimeType: format === "pdf" ? "application/pdf" : "multipart/related", encoding: "base64", data: bytes.toString("base64"), byteLength: bytes.length });
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

async function fixture(t, handler) {
  const path = process.platform === "win32" ? `\\\\.\\pipe\\obu-export-${randomUUID()}` : join(tmpdir(), `obu-export-${randomUUID()}.sock`);
  const calls = [], sockets = new Set(), timers = [];
  const server = createServer(socket => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    socket.on("data", chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const size = endianness() === "LE" ? buffer.readUInt32LE(0) : buffer.readUInt32BE(0);
        if (buffer.length < size + 4) break;
        const request = JSON.parse(buffer.subarray(4, size + 4)); buffer = buffer.subarray(size + 4); calls.push(request);
        handler(request, value => socket.write(encodeFrame({ id: request.id, result: value })), message => socket.write(encodeFrame({ id: request.id, error: { message } })), (fn, ms) => timers.push(setTimeout(fn, ms)));
      }
    });
  });
  await new Promise(resolve => server.listen(path, resolve));
  const client = new OpenBrowserUseClient({ socketPath: path, turnId: "initial" });
  t.after(async () => { timers.forEach(clearTimeout); client.close(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  return { client, calls, tab: new OpenBrowserUseBrowser({ client }).tab(9) };
}

test("PDF/MHTML helpers validate binary results and preserve one captured request scope", async t => {
  const bytes = { pdf: Buffer.from([37, 80, 68, 70, 45, 255, 0]), mhtml: Buffer.from("MIME-Version: 1.0\r\n报告🙂") };
  const f = await fixture(t, (req, reply) => {
    if (req.method === "getInfo") return reply(info);
    if (req.method === "getControlState") return reply(state(7));
    assert.equal(req.method, "exportPage");
    assert.equal(req.params.control_epoch, 7); assert.equal(req.params.turn_id, "initial");
    assert.ok(req.params.timeoutMs >= 1 && req.params.timeoutMs <= 1000);
    if (req.params.format === "pdf") assert.deepEqual(req.params.pdf, { landscape: false, marginTop: 0, pageRanges: "1-2" });
    else assert.equal(req.params.pdf, undefined);
    reply(result(req.params.format, bytes[req.params.format]));
  });
  const options = { timeoutMs: 1000, pdf: { landscape: false, marginTop: 0, pageRanges: "1-2" } };
  const pending = f.tab.exportPDF(options); options.pdf.pageRanges = "9";
  assert.deepEqual(await pending, result("pdf", bytes.pdf));
  assert.deepEqual(await f.tab.exportMHTML({ timeoutMs: 1000 }), result("mhtml", bytes.mhtml));
  assert.deepEqual(await f.tab.exportPage("mhtml", { timeoutMs: 1000 }), result("mhtml", bytes.mhtml));
  assert.equal(f.calls.filter(req => req.method === "exportPage").length, 3);
});

test("page export option boundaries and unknown fields reject before connecting", async t => {
  const f = await fixture(t, () => assert.fail("invalid options must not send"));
  for (const options of [null, [], { path: "x" }, { maxBytes: 0 }, { maxBytes: MAX_PAGE_EXPORT_BYTES + 1 }, { maxBytes: true }, { maxBytes: 1.5 }, { timeoutMs: null }, { timeoutMs: 0 }, { timeoutMs: 1.5 }, { timeoutMs: 120001 }, { timeoutMs: true }]) await assert.rejects(f.tab.exportPDF(options), /Invalid|must be/);
  for (const pdf of [null, [], { path: "x" }, { landscape: 1 }, { scale: .09 }, { scale: 2.1 }, { scale: NaN }, { paperWidth: 0 }, { paperHeight: 201 }, { marginLeft: -1 }, { marginRight: 201 }, { pageRanges: "all" }, { pageRanges: "1\n" }, { pageRanges: "1".repeat(1025) }]) await assert.rejects(f.tab.exportPDF({ pdf }), /PDF/);
  await assert.rejects(f.tab.exportMHTML({ pdf: {} }), /PDF/);
  await assert.rejects(f.tab.exportPage("png"), /format/);
  assert.equal(f.calls.length, 0);
  assert.equal(pageExportParams("pdf", { maxBytes: 1, timeoutMs: 1, pdf: { scale: .1, paperWidth: 200, marginLeft: 200, generateTaggedPDF: false } }).maxBytes, 1);
});

test("encoded export results enforce canonical base64, exact schema and caller cap", () => {
  const good = result("pdf", Buffer.from([255]));
  for (const value of [null, {}, { ...good, extra: 1 }, { ...good, format: "mhtml" }, { ...good, mimeType: "text/html" }, { ...good, encoding: "utf8" }, { ...good, data: "/x==" }, { ...good, data: "_w==" }, { ...good, data: "/w=\n" }, { ...good, data: "????" }, { ...good, byteLength: true }, { ...good, byteLength: 2 }, { ...good, byteLength: 0 }]) assert.throws(() => validatePageExport(value, "pdf", 100), /Invalid exportPage/);
  assert.throws(() => validatePageExport(result("mhtml", Buffer.from("中文")), "mhtml", 5), /Invalid/);
  const boundary = result("pdf", Buffer.alloc(MAX_PAGE_EXPORT_BYTES, 255));
  assert.equal(validatePageExport(boundary, "pdf", MAX_PAGE_EXPORT_BYTES).byteLength, MAX_PAGE_EXPORT_BYTES);
  assert.throws(() => validatePageExport(boundary, "pdf", MAX_PAGE_EXPORT_BYTES - 1), /Invalid/);
});

test("version negotiation includes explicit epoch and rejects legacy/boolean/future versions", async t => {
  for (const version of [undefined, true, 2]) for (const manual of [false, true]) {
    const f = await fixture(t, (req, reply) => reply(req.method === "getInfo" ? { metadata: { turnLifecycleVersion: 1, pageExportVersion: version } } : state(7)));
    await assert.rejects(manual ? f.client.request("exportPage", { tabId: 9, format: "pdf", control_epoch: 7 }) : f.tab.exportPDF(), /OBU_PAGE_EXPORT_UNSUPPORTED/);
    assert.equal(f.calls.some(req => req.method === "exportPage"), false);
    if (manual) assert.deepEqual(f.calls.map(req => req.method), ["getInfo"]);
  }
});

test("cold discovery consumes the export budget without sending expired work", async t => {
  for (const manual of [false, true]) {
    const f = await fixture(t, (req, reply, fail, later) => {
      if (req.method === "getInfo") return later(() => reply(info), 150);
      assert.equal(req.method, "getControlState"); reply(state(7));
    });
    await assert.rejects(manual ? f.client.request("exportPage", { tabId: 9, format: "pdf", control_epoch: 7, timeoutMs: 20 }) : f.tab.exportPDF({ timeoutMs: 20 }), /timed out/);
    assert.ok(!f.calls.some(req => req.method === "exportPage"));
  }
});

test("wire export deadline rejects explicit null and fractional values", async t => {
  const f = await fixture(t, (req, reply) => { assert.notEqual(req.method, "exportPage"); reply(req.method === "getInfo" ? info : state(7)); });
  for (const timeoutMs of [null, NaN, true, 0, 1.5, 120001]) await assert.rejects(f.client.request("exportPage", { tabId: 9, format: "pdf", timeoutMs }), /timeoutMs/);
});

test("export waiting during a turn end keeps its old epoch and is not replayed", async t => {
  const entered = defer(); let complete;
  const f = await fixture(t, (req, reply, fail) => {
    if (req.method === "getInfo") return reply(info);
    if (req.method === "getControlState") return reply(state(7));
    if (req.method === "turnEnded") return reply({ ...state(8), endedTurnId: "initial" });
    assert.equal(req.method, "exportPage"); assert.equal(req.params.control_epoch, 7);
    complete = () => fail("OBU_STALE_CONTROL_EPOCH"); entered.resolve();
  });
  const pending = f.tab.exportPDF(); await entered.promise;
  const rejected = assert.rejects(pending, /OBU_STALE_CONTROL_EPOCH/);
  await f.client.turnEnded(); complete(); await rejected;
  assert.equal(f.calls.filter(req => req.method === "exportPage").length, 1);
});

test("a lost export response is not retried", async t => {
  const f = await fixture(t, (req, reply) => {
    if (req.method === "getInfo") reply(info);
    else if (req.method === "getControlState") reply(state(7));
    else assert.equal(req.method, "exportPage");
  });
  await assert.rejects(f.tab.exportPDF({ timeoutMs: 50 }), /timed out/);
  assert.equal(f.calls.filter(req => req.method === "exportPage").length, 1);
});
