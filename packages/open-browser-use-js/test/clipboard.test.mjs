import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { endianness, tmpdir } from "node:os";
import { join } from "node:path";
import { OpenBrowserUseBrowser, OpenBrowserUseClient, encodeFrame } from "../dist/index.js";
import { MAX_CLIPBOARD_BYTES, clipboardParams, validateClipboardItems, validateClipboardResult } from "../dist/clipboard.js";

const info = { metadata: { turnLifecycleVersion: 1, clipboardVersion: 1 } };
const state = epoch => ({ controlEpoch: epoch, nextTurnId: `turn-${epoch}`, lifecycleVersion: 1, closing: false });
const result = (format, bytes) => ({ format, mimeType: format === "pdf" ? "application/pdf" : "multipart/related", encoding: "base64", data: bytes.toString("base64"), byteLength: bytes.length });
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=";
const rich = () => [{ entries: [{ mime_type: "text/plain", text: "中文🙂" }, { mime_type: "text/html", text: "<b>报告</b>" }, { mime_type: "image/png", base64: png }], presentation_style: "inline" }];

async function fixture(t, handler) {
  const path = process.platform === "win32" ? `\\\\.\\pipe\\obu-clipboard-${randomUUID()}` : join(tmpdir(), `obu-clipboard-${randomUUID()}.sock`);
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
        handler(request, value => socket.write(encodeFrame({ id: request.id, result: value })), message => socket.write(encodeFrame({ id: request.id, error: { message } })), (fn, ms) => timers.push(setTimeout(fn, ms)), payload => {
          const header = Buffer.alloc(4);
          if (endianness() === "LE") header.writeUInt32LE(payload.length); else header.writeUInt32BE(payload.length);
          socket.write(Buffer.concat([header, payload]));
        });
      }
    });
  });
  await new Promise(resolve => server.listen(path, resolve));
  const client = new OpenBrowserUseClient({ socketPath: path, turnId: "initial" });
  t.after(async () => { timers.forEach(clearTimeout); client.close(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  return { client, calls, tab: new OpenBrowserUseBrowser({ client }).tab(9) };
}

test("clipboard facade and legacy envelopes preserve scope and payload copies", async t => {
  const input = rich();
  const f = await fixture(t, (req, reply) => {
    if (req.method === "getInfo") { input[0].entries[0].text = "changed"; return reply(info); }
    if (req.method === "getControlState") return reply(state(7));
    assert.equal(req.params.tabId, 9); assert.equal(req.params.control_epoch, 7); assert.equal(req.params.turn_id, "initial");
    assert.ok(req.params.timeoutMs > 0 && req.params.timeoutMs <= 1000); assert.equal(req.params.maxBytes, MAX_CLIPBOARD_BYTES);
    if (req.method === "writeClipboard") { if (req.params.items.length) assert.deepEqual(req.params.items, rich()); reply({}); }
    else if (req.method === "readClipboard") reply({ items: rich() });
    else if (req.method === "readClipboardText") reply({ text: "中文🙂" });
    else { assert.equal(req.params.text, ""); reply({}); }
  });
  const options = { timeoutMs: 1000 };
  assert.equal(await f.tab.clipboard.write(input, options), undefined);
  assert.deepEqual(await f.tab.clipboard.read(options), rich());
  assert.equal(await f.tab.clipboard.readText(options), "中文🙂");
  assert.equal(await f.tab.clipboard.writeText("", options), undefined);
  assert.deepEqual(await f.client.writeClipboard(9, [], options), {});
  assert.deepEqual(await f.client.readClipboardText(9, options), { text: "中文🙂" });
});

test("clipboard invalid inputs reject before connection", async t => {
  const f = await fixture(t, () => assert.fail("invalid write must not send"));
  for (const options of [null, [], { x: 1 }, { maxBytes: 0 }, { maxBytes: MAX_CLIPBOARD_BYTES + 1 }, { timeoutMs: null }, { timeoutMs: .5 }, { timeoutMs: 120001 }]) await assert.rejects(f.tab.clipboard.writeText("x", options));
  for (const text of [null, 1, "\ud800", "\udfff"]) await assert.rejects(f.tab.clipboard.writeText(text));
  await assert.rejects(f.tab.clipboard.writeText("中文", { maxBytes: 5 }), /byte limit/);
  for (const entries of [[], [{ mime_type: "text/plain" }], [{ mime_type: "text/plain", text: "x", base64: "eA==" }], [{ mime_type: "text/plain", text: "x", x: 1 }], [{ mime_type: "image/jpeg", base64: png }], [{ mime_type: "image/png", base64: png + "\n" }], [{ mime_type: "image/png", base64: "eA==" }], [{ mime_type: "text/plain", text: "x" }, { mime_type: "text/plain", text: "y" }]]) await assert.rejects(f.tab.clipboard.write([{ entries }]));
  for (const items of [null, {}, [rich()[0], rich()[0]], [{ ...rich()[0], x: true }], [{ ...rich()[0], presentation_style: null }]]) await assert.rejects(f.tab.clipboard.write(items));
  assert.equal(f.calls.length, 0); assert.deepEqual(validateClipboardItems([], 1), []);
  assert.equal(clipboardParams("writeClipboardText", 9, { text: "" }, { maxBytes: 1, timeoutMs: 1 }).text, "");
});

test("clipboard response validates exact schema, PNG and aggregate actual bytes", () => {
  for (const value of [{}, null, { text: 1 }, { text: "\udfff" }, { text: "ok", extra: true }]) assert.throws(() => validateClipboardResult("readClipboardText", value, 100));
  for (const value of [{}, { items: null }, { items: [], extra: 1 }]) assert.throws(() => validateClipboardResult("readClipboard", value, 100));
  assert.throws(() => validateClipboardResult("writeClipboard", { ok: true }, 100));
  assert.deepEqual(validateClipboardResult("readClipboard", { items: [] }, 1), { items: [] });
  const total = Buffer.byteLength("中文🙂") + Buffer.byteLength("<b>报告</b>") + Buffer.from(png, "base64").length;
  assert.deepEqual(validateClipboardItems(rich(), total), rich()); assert.throws(() => validateClipboardItems(rich(), total - 1), /byte limit/);
  for (const mutate of [b => b.writeUInt32BE(0, 16), b => b.writeUInt32BE(16777217, 16), b => b[24] = 3, b => b[26] = 1, b => b[28] = 2]) {
    const bytes = Buffer.from(png, "base64"); mutate(bytes);
    assert.throws(() => validateClipboardItems([{ entries: [{ mime_type: "image/png", base64: bytes.toString("base64") }] }], 1000));
  }
  const boundary = "x".repeat(MAX_CLIPBOARD_BYTES);
  assert.equal(validateClipboardResult("readClipboardText", { text: boundary }, MAX_CLIPBOARD_BYTES).text.length, MAX_CLIPBOARD_BYTES);
  assert.throws(() => validateClipboardResult("readClipboardText", { text: boundary }, MAX_CLIPBOARD_BYTES - 1));
});

test("clipboard capability gates old or invalid versions including manual epochs", async t => {
  for (const version of [undefined, true, 2]) for (const manual of [false, true]) {
    const f = await fixture(t, (req, reply) => reply(req.method === "getInfo" ? { metadata: { turnLifecycleVersion: 1, clipboardVersion: version } } : state(7)));
    await assert.rejects(manual ? f.client.request("readClipboard", { tabId: 9, control_epoch: 7 }) : f.tab.clipboard.read(), /OBU_CLIPBOARD_UNSUPPORTED/);
    assert.ok(f.calls.every(req => ["getInfo", "getControlState"].includes(req.method)));
    if (manual) assert.deepEqual(f.calls.map(req => req.method), ["getInfo"]);
  }
});
test("clipboard discovery consumes original budget and raw invalid deadlines reject", async t => {
  const f = await fixture(t, (req, reply, fail, later) => req.method === "getInfo" ? later(() => reply(info), 100) : reply(state(7)));
  await assert.rejects(f.tab.clipboard.writeText("never", { timeoutMs: 20 }), /timed out/);
  for (const timeoutMs of [null, 0, 1.5, true, 120001]) await assert.rejects(f.client.request("writeClipboard", { tabId: 9, items: [], control_epoch: 7, timeoutMs }), /timeoutMs/);
  assert.ok(!f.calls.some(req => req.method === "writeClipboard" || req.method === "writeClipboardText"));
});
test("clipboard write keeps old scope and never replays stale or lost response", async t => {
  const started = defer(); let failWrite;
  const f = await fixture(t, (req, reply, fail) => {
    if (req.method === "getInfo") return reply(info);
    if (req.method === "getControlState") return reply(state(7));
    if (req.method === "turnEnded") return reply({ ...state(8), endedTurnId: "initial" });
    assert.equal(req.params.control_epoch, 7); failWrite = () => fail("OBU_STALE_CONTROL_EPOCH"); started.resolve();
  });
  const pending = f.tab.clipboard.writeText("once"); await started.promise;
  const rejected = assert.rejects(pending, /OBU_STALE_CONTROL_EPOCH/); await f.client.turnEnded(); failWrite(); await rejected;
  assert.equal(f.calls.filter(req => req.method === "writeClipboardText").length, 1);
  const g = await fixture(t, (req, reply) => { if (req.method === "getInfo") reply(info); else if (req.method === "getControlState") reply(state(7)); });
  await assert.rejects(g.tab.clipboard.write([], { timeoutMs: 20 }), /timed out/);
  assert.equal(g.calls.filter(req => req.method === "writeClipboard").length, 1);
});

test("clipboard rejects malformed raw UTF-8 without repairing text or dropping the connection", async t => {
  const malformed = [Buffer.from([0xff]), Buffer.from([0xc0, 0xaf]), Buffer.from([0xed, 0xa0, 0x80]), Buffer.from([0xf0, 0x9f])];
  let badBytes;
  const f = await fixture(t, (req, reply, _fail, _later, rawReply) => {
    if (req.method === "getInfo") return reply(info);
    if (req.method === "getControlState") return reply(state(7));
    if (!badBytes) return reply(req.method === "readClipboardText" ? { text: "literal \ufffd 中文🙂" } : { items: [] });
    const prefix = req.method === "readClipboardText" ? '{"text":"' : '{"items":[{"entries":[{"mime_type":"text/plain","text":"';
    const suffix = req.method === "readClipboardText" ? '"}' : '"}]}]}';
    rawReply(Buffer.concat([Buffer.from(`{"id":${JSON.stringify(req.id)},"result":${prefix}`), badBytes, Buffer.from(`${suffix}}`)]));
  });
  for (const bytes of malformed) {
    badBytes = bytes;
    await assert.rejects(f.tab.clipboard.readText(), /clipboard response.*UTF-8/i);
    await assert.rejects(f.tab.clipboard.read(), /clipboard response.*UTF-8/i);
  }
  badBytes = null;
  assert.equal(await f.tab.clipboard.readText(), "literal \ufffd 中文🙂");
  assert.deepEqual(await f.tab.clipboard.read(), []);
  assert.equal(f.calls.filter(req => req.method === "getInfo").length, 1);
  assert.equal(f.calls.filter(req => req.method === "readClipboardText").length, malformed.length + 1);
});

test("clipboard bounds escaped request and result bodies before transport", async t => {
  const f = await fixture(t, () => assert.fail("encoded overflow must reject before connection"));
  for (const character of ["<", "\u0000"]) {
    const text = character.repeat(8 * 1024 * 1024);
    const items = [{ entries: [{ mime_type: "text/plain", text }] }];
    await assert.rejects(f.tab.clipboard.writeText(text), /OBU_CLIPBOARD_LIMIT/);
    await assert.rejects(f.tab.clipboard.write(items), /OBU_CLIPBOARD_LIMIT/);
    assert.throws(() => validateClipboardResult("readClipboardText", { text }, MAX_CLIPBOARD_BYTES), /OBU_CLIPBOARD_LIMIT/);
    assert.throws(() => validateClipboardResult("readClipboard", { items }, MAX_CLIPBOARD_BYTES), /OBU_CLIPBOARD_LIMIT/);
  }
  const boundary = "<".repeat(Math.floor((48 * 1024 * 1024 - 11) / 6));
  assert.equal(validateClipboardResult("readClipboardText", { text: boundary }, MAX_CLIPBOARD_BYTES).text, boundary);
  assert.throws(() => validateClipboardResult("readClipboardText", { text: boundary + "<" }, MAX_CLIPBOARD_BYTES), /OBU_CLIPBOARD_LIMIT/);
  assert.equal(f.calls.length, 0);
});
