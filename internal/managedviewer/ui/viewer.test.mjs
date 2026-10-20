import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { captureFixture, captureResultFixture } from "../testdata/generate-bridge-fixture.mjs";

const source = readFileSync(new URL("./viewer.js", import.meta.url), "utf8");
const fileSource = readFileSync(new URL("./human-files.js", import.meta.url), "utf8");
const ticket = "a".repeat(43);

function fileHarness() {
  const h = setup(1, 1, { fileChooserVersion: 1 }); h.readyHuman();
  const chooser = { leaseId: "lease-a", generation: 1, chooserId: "chooser-a", multiple: true,
    source: { origin: "https://upload.example", frame: "child" } };
  const state = (extra = {}) => h.humanState({ eventSequence: 20002, pendingFileChooser: chooser, ...extra });
  h.socket.message({ type: "state", ...state() });
  const fields = { leaseId: chooser.leaseId, generation: chooser.generation, chooserId: chooser.chooserId };
  const reply = (request, payload, extra = {}) => h.respond(request.id, { ...state(extra), ...payload });
  const pick = files => {
    h.event("file-choose", "click", { isTrusted: true });
    h.element("file-picker").files = files;
    h.event("file-picker", "change");
    return h.socket.sent.at(-1);
  };
  return { ...h, chooser, fileState: state, fields, reply, pick };
}
const file = (name, bytes) => ({ name, size: bytes.length,
  slice(start, end) { return { async arrayBuffer() { return Uint8Array.from(bytes.slice(start, end)).buffer; } }; } });
const flushFiles = async () => { for (let n = 0; n < 16; n++) await Promise.resolve(); };

test("files transfer original bytes in bounded acknowledged chunks, including same-name empty file", async () => {
  const h = fileHarness(), bytes = Array.from({ length: 16385 }, (_, n) => n % 256);
  const begin = h.pick([file("same.bin", []), file("same.bin", bytes)]);
  assert.equal(begin.operation, "humanFileBegin");
  assert.deepEqual(begin.files, [{ name: "same.bin", size: 0 }, { name: "same.bin", size: 16385 }]);
  assert.equal(h.element("human-input").dataset.enabled, "false");
  h.reply(begin, { fileTransfer: { ...h.fields, transferId: "transfer-a", fileCount: 2, totalBytes: bytes.length } });
  await flushFiles();
  const chunk = h.socket.sent.at(-1);
  assert.equal(chunk.operation, "humanFileChunk"); assert.equal(chunk.fileIndex, 1); assert.equal(chunk.offset, 0);
  assert.deepEqual([...Buffer.from(chunk.data, "base64")], bytes.slice(0, 16384));
  assert.equal(h.socket.sent.filter(row => row.operation === "humanFileChunk").length, 1);
  h.reply(chunk, { fileChunk: { ...h.fields, transferId: "transfer-a", fileIndex: 1, nextOffset: 16384 } });
  await flushFiles();
  const last = h.socket.sent.at(-1);
  assert.equal(last.offset, 16384); assert.deepEqual([...Buffer.from(last.data, "base64")], bytes.slice(16384));
  h.reply(last, { fileChunk: { ...h.fields, transferId: "transfer-a", fileIndex: 1, nextOffset: 16385 } });
  await flushFiles();
  const commit = h.socket.sent.at(-1);
  assert.equal(commit.operation, "humanFileCommit"); assert.equal(Object.hasOwn(commit, "files"), false);
  assert.equal(h.element("file-cancel").disabled, true); assert.equal(h.element("human-end").disabled, false);
  h.reply(commit, { fileChooserReceipt: { ...h.fields, transferId: "transfer-a", acknowledged: true } },
    { eventSequence: 20003, pendingFileChooser: null });
  await flushFiles();
  assert.match(h.element("file-status").textContent, /网页已接收/);
  assert.equal(h.socket.sent.filter(row => row.operation === "humanFileCommit").length, 1);
  assert.equal(h.element("human-input").dataset.enabled, "true");
});

test("file picker exception is bound to a trusted original selection and ends at change/cancel", async () => {
  const h = fileHarness();
  h.event("file-choose", "click", { isTrusted: false });
  assert.equal(h.element("file-status").dataset.phase, "");
  h.event("file-choose", "click", { isTrusted: true });
  h.windowEvents.blur();
  assert.equal(h.socket.sent.some(row => row.operation === "humanEnd"), false);
  h.event("file-picker", "cancel"); await flushFiles();
  const cancel = h.socket.sent.at(-1);
  assert.equal(cancel.operation, "humanFileCancel"); assert.equal(Object.hasOwn(cancel, "transferId"), false);
  h.reply(cancel, { fileChooserCancellation: { ...h.fields, cancelled: true } }, { eventSequence: 20003, pendingFileChooser: null });
  await flushFiles();
  assert.match(h.element("file-status").textContent, /原有文件保持不变/);
  h.windowEvents.blur();
  assert.equal(h.socket.sent.at(-1).operation, "humanEnd");
});

test("file chooser cannot suppress ordinary blur, hidden viewer or bounded picker timeout", () => {
  const h = fileHarness(); h.windowEvents.blur();
  assert.equal(h.socket.sent.at(-1).operation, "humanEnd");
  const hidden = fileHarness(); hidden.event("file-choose", "click", { isTrusted: true });
  hidden.setHidden(true);
  assert.equal(hidden.socket.sent.at(-1).operation, "humanEnd");
  const picking = fileHarness(); picking.event("file-choose", "click", { isTrusted: true });
  const timer = [...picking.timerDelays].find(([, delay]) => delay === 600000)?.[0];
  assert.ok(timer); picking.timers.get(timer)();
  assert.equal(picking.socket.sent.at(-1).operation, "humanEnd");
});

test("file picker waits for original held key release and ACK without synthesizing keys", () => {
  const h = setup(1, 1, { fileChooserVersion: 1 }); h.readyHuman();
  h.event("human-input", "keydown", { key: "Control", code: "ControlLeft", keyCode: 17, ctrlKey: true });
  const down = h.socket.sent.at(-1);
  const chooser = { leaseId: "lease-a", generation: 1, chooserId: "held", multiple: false };
  const state = h.humanState({ eventSequence: 20002, pendingFileChooser: chooser });
  h.socket.message({ type: "state", ...state });
  assert.equal(h.element("file-choose").disabled, true);
  h.windowEvents.keyup({ key: "Control", code: "ControlLeft", keyCode: 17, preventDefault() {} });
  assert.equal(h.socket.sent.at(-1), down);
  h.ackInput(down, state);
  const up = h.socket.sent.at(-1);
  assert.equal(up.operation, "humanInput"); assert.equal(up.input.action, "up"); assert.equal(up.sequence, 2);
  assert.equal(h.element("file-choose").disabled, true);
  h.ackInput(up, state);
  assert.equal(h.element("file-choose").disabled, false);
  assert.equal(h.socket.sent.filter(row => row.operation === "humanInput").length, 2);
});

for (const name of ["../escape", "a:b", "CON.txt", "CON .txt", "nul", "LPT¹", "trail.", "trail ", "bad\u0000name"]) test(`file name rejected before begin: ${JSON.stringify(name)}`, () => {
  const h = fileHarness(); h.pick([file(name, [1])]);
  assert.equal(h.socket.sent.some(row => row.operation === "humanFileBegin"), false);
  assert.equal(h.element("file-choose").disabled, false);
});

for (const stage of ["begin", "read", "chunk"]) test(`file End fences all later writes/commit at ${stage}`, async () => {
  const h = fileHarness(); let resolveRead;
  const chosen = stage === "read" ? { name: "a.bin", size: 1, slice() { return { arrayBuffer() { return new Promise(resolve => { resolveRead = resolve; }); } }; } } : file("a.bin", [7]);
  const begin = h.pick([chosen]);
  if (stage !== "begin") {
    h.reply(begin, { fileTransfer: { ...h.fields, transferId: "transfer-a", fileCount: 1, totalBytes: 1 } }); await flushFiles();
  }
  const before = h.socket.sent.at(-1);
  h.element("human-end").click();
  if (stage === "begin") h.reply(begin, { fileTransfer: { ...h.fields, transferId: "transfer-a", fileCount: 1, totalBytes: 1 } });
  if (stage === "read") resolveRead(new Uint8Array([7]).buffer);
  if (stage === "chunk") h.reply(before, { fileChunk: { ...h.fields, transferId: "transfer-a", fileIndex: 0, nextOffset: 1 } });
  await flushFiles();
  assert.equal(h.socket.sent.filter(row => row.operation === "humanFileCommit").length, 0);
  assert.equal(h.socket.sent.filter(row => row.operation === "humanFileChunk").length, stage === "chunk" ? 1 : 0);
  assert.equal(h.socket.sent.filter(row => row.operation === "humanEnd").length, 1);
});

test("file cancellation while Begin is pending retires its late claim without any bytes", async () => {
  const h = fileHarness(), begin = h.pick([file("a.txt", [1])]);
  h.element("file-cancel").click(); const cancel = h.socket.sent.at(-1);
  assert.equal(cancel.operation, "humanFileCancel");
  h.reply(cancel, { fileChooserCancellation: { ...h.fields, cancelled: true } }, { pendingFileChooser: null, eventSequence: 20003 });
  h.reply(begin, { fileTransfer: { ...h.fields, transferId: "transfer-a", fileCount: 1, totalBytes: 1 } });
  await flushFiles();
  assert.equal(h.socket.sent.some(row => ["humanFileChunk", "humanFileCommit"].includes(row.operation)), false);
});

test("wrong file chunk offset ends the lease without retry or commit", async () => {
  const h = fileHarness(), begin = h.pick([file("a.txt", [1, 2])]);
  h.reply(begin, { fileTransfer: { ...h.fields, transferId: "transfer-a", fileCount: 1, totalBytes: 2 } }); await flushFiles();
  const chunk = h.socket.sent.at(-1);
  h.reply(chunk, { fileChunk: { ...h.fields, transferId: "transfer-a", fileIndex: 0, nextOffset: 1 } }); await flushFiles();
  assert.equal(h.socket.sent.at(-1).operation, "humanEnd");
  assert.equal(h.socket.sent.some(row => row.operation === "humanFileCommit"), false);
  assert.equal(h.socket.sent.filter(row => row.operation === "humanFileChunk").length, 1);
});

test("file commit retains actual ACK after End and never restores input", async () => {
  const h = fileHarness(), begin = h.pick([file("empty.txt", [])]);
  h.reply(begin, { fileTransfer: { ...h.fields, transferId: "transfer-a", fileCount: 1, totalBytes: 0 } }); await flushFiles();
  const commit = h.socket.sent.at(-1); assert.equal(commit.operation, "humanFileCommit");
  h.element("human-end").click();
  h.reply(commit, { fileChooserReceipt: { ...h.fields, transferId: "transfer-a", acknowledged: true } },
    { eventSequence: 20003, pendingFileChooser: null });
  await flushFiles();
  assert.match(h.element("file-status").textContent, /网页已接收/);
  assert.equal(h.element("human-input").dataset.enabled, "false");
  assert.equal(h.socket.sent.filter(row => row.operation === "humanFileCommit").length, 1);
});

test("same chooser metadata is immutable while old sequenced state is ignored", () => {
  const h = fileHarness();
  h.socket.message({ type: "state", ...h.fileState({ eventSequence: 20001, pendingFileChooser: { ...h.chooser, multiple: false } }) });
  assert.equal(h.socket.sent.some(row => row.operation === "humanEnd"), false);
  h.socket.message({ type: "state", ...h.fileState({ eventSequence: 20003, pendingFileChooser: { ...h.chooser, source: { origin: "https://changed.example", frame: "child" } } }) });
  assert.equal(h.socket.sent.at(-1).operation, "humanEnd");
});

test("file selection needs its original picker intent and retired selection cannot affect a new chooser", async () => {
  const h = fileHarness();
  h.element("file-picker").files = [file("unsolicited.txt", [1])]; h.event("file-picker", "change");
  assert.equal(h.socket.sent.some(row => row.operation === "humanFileBegin"), false);
  const begin = h.pick([file("empty.txt", [])]);
  h.reply(begin, { fileTransfer: { ...h.fields, transferId: "transfer-a", fileCount: 1, totalBytes: 0 } }); await flushFiles();
  const commit = h.socket.sent.at(-1);
  h.socket.message({ type: "state", ...h.fileState({ eventSequence: 20003, pendingFileChooser: { ...h.chooser, chooserId: "chooser-b" } }) });
  h.reply(commit, { fileChooserReceipt: { ...h.fields, transferId: "transfer-a", acknowledged: true } });
  await flushFiles();
  assert.equal(h.element("file-chooser").dataset.chooserId, "chooser-b");
  assert.equal(h.element("file-status").textContent, "");
  assert.equal(h.element("file-choose").disabled, false);
});

test("navigation during local file read cancels old transfer and never uploads to successor", async () => {
  const h = fileHarness(); let resolveRead;
  const chosen = { name: "one.bin", size: 1, slice() { return { arrayBuffer() { return new Promise(resolve => { resolveRead = resolve; }); } }; } };
  const begin = h.pick([chosen]);
  h.reply(begin, { fileTransfer: { ...h.fields, transferId: "transfer-a", fileCount: 1, totalBytes: 1 } }); await flushFiles();
  h.socket.message({ type: "state", ...generationState(h, 2, "navigating") });
  resolveRead(new Uint8Array([1]).buffer); await flushFiles();
  assert.equal(h.socket.sent.some(row => row.operation === "humanFileChunk" || row.operation === "humanFileCommit"), false);
  assert.equal(h.element("file-chooser").hidden, true);
  assert.equal(h.socket.sent.some(row => row.operation === "humanEnd"), false);
});

test("file chooser capability cannot change within an admitted lease", () => {
  const h = fileHarness();
  const human = { ...h.humanState().human }; delete human.fileChooserVersion;
  h.socket.message({ type: "state", ...h.fileState({ eventSequence: 20003, human, pendingFileChooser: null }) });
  assert.equal(h.socket.sent.at(-1).operation, "humanEnd");
});

test("local file read has a fixed deadline that cannot dispatch after expiry", async () => {
  const h = fileHarness(); let resolveRead;
  const chosen = { name: "one.bin", size: 1, slice() { return { arrayBuffer() { return new Promise(resolve => { resolveRead = resolve; }); } }; } };
  const begin = h.pick([chosen]);
  h.reply(begin, { fileTransfer: { ...h.fields, transferId: "transfer-a", fileCount: 1, totalBytes: 1 } }); await flushFiles();
  const timer = [...h.timerDelays].find(([, delay]) => delay === 600000)?.[0];
  assert.ok(timer); h.timers.get(timer)();
  assert.equal(h.socket.sent.at(-1).operation, "humanEnd");
  resolveRead(new Uint8Array([1]).buffer); await flushFiles();
  assert.equal(h.socket.sent.some(row => row.operation === "humanFileChunk" || row.operation === "humanFileCommit"), false);
});

function clipboardHarness(options = {}) {
  const writes = [];
  const api = {
    version: 1,
    ClipboardItem: class { constructor(data) { if (options.itemThrows) throw Error("item unavailable"); this.data = data; } },
    navigator: { clipboard: { write(items) {
      if (options.writeThrows) throw Error("write unavailable");
      const call = { items, blob: null, dataError: null };
      call.data = items[0].data["text/plain"].then(blob => { call.blob = blob; }, error => { call.dataError = error; });
      call.actual = new Promise((resolve, reject) => { call.resolve = resolve; call.reject = reject; });
      writes.push(call);
      return call.actual;
    } } },
    ...options
  };
  if (options.unavailable) api.navigator = {};
  const h = setup(1, 1, api); h.readyHuman();
  const key = (action = "keydown", extra = {}) => h.event("human-input", action, { isTrusted: true, key: "c", code: "KeyC", keyCode: 67, ctrlKey: true, ...extra });
  const receipt = (request, transfer, extra = {}) => h.ackInput(request, {
    inputReceipt: { acknowledged: true, leaseId: request.leaseId, generation: request.generation, sequence: request.sequence,
      ...(transfer === undefined ? {} : { clipboardTransfer: transfer }) }, ...extra
  });
  return { ...h, writes, key, receipt };
}
const flushClipboard = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

test("clipboard transfer starts synchronously in trusted keydown and resolves only its exact ACK", async () => {
  const h = clipboardHarness(); const event = h.key();
  assert.equal(event.prevented, true);
  assert.equal(h.writes.length, 1, "native write starts before leaving keydown");
  const request = h.socket.sent.at(-1);
  assert.equal(request.input.clipboardTransfer, "copy");
  assert.equal(h.writes[0].blob, null);
  h.key("keyup");
  h.receipt(request, { operation: "copy", status: "ready", text: "原文\n😀" });
  await flushClipboard();
  assert.equal(await h.writes[0].blob.text(), "原文\n😀");
  assert.equal(h.socket.sent.at(-1).input.action, "up");
  assert.equal(h.element("human-input").dataset.acknowledgedSequence, String(request.sequence));
  assert.equal(h.element("clipboard-status").dataset.pending, "true");
  h.writes[0].resolve(); await flushClipboard();
  assert.equal(h.element("clipboard-status").dataset.pending, "false");
  assert.match(h.element("clipboard-status").textContent, /已写入/);
});

for (const option of ["unavailable", "itemThrows", "writeThrows"]) test(`clipboard transfer blocks cut on local synchronous failure: ${option}`, async () => {
  const h = clipboardHarness({ [option]: true });
  const count = h.socket.sent.length;
  h.key("keydown", { key: "x", code: "KeyX", keyCode: 88 }); h.key("keyup", { key: "x", code: "KeyX", keyCode: 88 });
  await flushClipboard();
  assert.equal(h.socket.sent.length, count);
  assert.equal(h.element("human-input").dataset.enabled, "true");
  assert.match(h.element("clipboard-status").textContent, /未发送/);
});

for (const transfer of [
  { operation: "copy", status: "unchanged" },
  { operation: "copy", status: "failed", code: "CHANGED" },
  undefined,
  { operation: "cut", status: "ready", text: "wrong" },
  { operation: "copy", status: "ready", text: "\ud800" },
  { operation: "copy", status: "ready", text: "😀".repeat(16385) },
  { operation: "copy", status: "ready", text: "x", code: "CHANGED" },
  { operation: "copy", status: "failed", code: "OTHER" }
]) test(`clipboard transfer post-ACK ${transfer?.status || "missing"}/${transfer?.code || transfer?.operation || ""} preserves input ACK and original up`, async () => {
  const h = clipboardHarness(); h.key(); const request = h.socket.sent.at(-1); h.key("keyup");
  h.receipt(request, transfer); await flushClipboard();
  assert.equal(h.element("human-input").dataset.acknowledgedSequence, "1");
  assert.equal(h.socket.sent.at(-1).input.action, "up");
  assert.equal(h.socket.sent.some(x => x.operation === "humanEnd"), false);
  assert.equal(h.writes[0].blob, null); assert.ok(h.writes[0].dataError);
  h.writes[0].reject(Error("data rejected")); await flushClipboard();
  assert.equal(h.element("human-input").dataset.enabled, "true");
});

test("clipboard transfer permits exactly 64 KiB and explicit empty text", async () => {
  for (const text of ["", "😀".repeat(16384)]) {
    const h = clipboardHarness(); h.key(); h.receipt(h.socket.sent.at(-1), { operation: "copy", status: "ready", text });
    await flushClipboard(); assert.equal(await h.writes[0].blob.text(), text);
    h.writes[0].resolve(); await flushClipboard();
  }
});

for (const reason of ["End", "blur", "navigation", "disconnect"]) test(`clipboard transfer rejects unresolved data at ${reason} but retains actual local write`, async () => {
  const h = clipboardHarness(); h.key(); const request = h.socket.sent.at(-1);
  if (reason === "End") h.element("human-end").click();
  else if (reason === "blur") h.windowEvents.blur();
  else if (reason === "navigation") h.socket.message({ type: "state", ...generationState(h, 2, "navigating") });
  else h.socket.close();
  await flushClipboard();
  assert.ok(h.writes[0].dataError); assert.equal(h.element("clipboard-status").dataset.pending, "true");
  h.receipt(request, { operation: "copy", status: "ready", text: "late" }); await flushClipboard();
  assert.equal(h.writes[0].blob, null);
  h.writes[0].reject(Error("cancelled data")); await flushClipboard();
  assert.equal(h.element("clipboard-status").dataset.pending, "false");
});

test("clipboard transfer End after data resolution cannot claim rollback or admit a second pending write", async () => {
  const h = clipboardHarness(); h.key(); const request = h.socket.sent.at(-1); h.key("keyup");
  h.receipt(request, { operation: "copy", status: "ready", text: "committed payload" }); await flushClipboard();
  h.ackInput(); const count = h.socket.sent.length;
  h.key(); assert.equal(h.socket.sent.length, count); assert.equal(h.writes.length, 1);
  h.element("human-end").click(); assert.equal(h.socket.sent.at(-1).operation, "humanEnd");
  assert.equal(h.element("clipboard-status").dataset.pending, "true");
  assert.match(h.element("clipboard-status").textContent, /不能撤回/);
  h.writes[0].resolve(); await flushClipboard();
  assert.match(h.element("clipboard-status").textContent, /已写入/);
});

test("clipboard transfer queued behind an input is cancelled before sequence assignment", async () => {
  const h = clipboardHarness();
  h.event("human-input", "keydown", { key: "Control", code: "ControlLeft", keyCode: 17, ctrlKey: true });
  const modifier = h.socket.sent.at(-1);
  h.key(); assert.equal(h.writes.length, 1); assert.equal(h.socket.sent.at(-1), modifier);
  h.element("human-end").click(); h.ackInput(modifier); await flushClipboard();
  assert.ok(h.writes[0].dataError);
  assert.equal(h.socket.sent.filter(x => x.input?.clipboardTransfer).length, 0);
  h.writes[0].reject(Error("cancelled")); await flushClipboard();
});

for (const operation of ["copy", "cut"]) for (const settlement of ["reject", "resolve-without-data"])
test(`queued clipboard ${operation} ends the original hold when local write ${settlement} precedes modifier ACK`, async () => {
  const h = clipboardHarness(), fields = operation === "copy"
    ? { key: "c", code: "KeyC", keyCode: 67 } : { key: "x", code: "KeyX", keyCode: 88 };
  h.event("human-input", "keydown", { isTrusted: true, key: "Control", code: "ControlLeft", keyCode: 17, ctrlKey: true });
  const modifier = h.socket.sent.at(-1);
  h.key("keydown", fields); h.key("keyup", fields);
  h.event("human-input", "keyup", { isTrusted: true, key: "Control", code: "ControlLeft", keyCode: 17, ctrlKey: false });
  assert.equal(h.socket.sent.at(-1), modifier); assert.equal(h.writes.length, 1);
  if (settlement === "reject") h.writes[0].reject(Error("local write denied before queued shortcut"));
  else h.writes[0].resolve();
  await flushClipboard();
  assert.ok(h.writes[0].dataError); assert.equal(h.writes[0].blob, null);
  assert.equal(h.element("clipboard-status").dataset.pending, "false");
  h.ackInput(modifier); await flushClipboard();
  assert.equal(h.socket.sent.filter(row => row.input?.clipboardTransfer).length, 0, "a late modifier ACK cannot send the cancelled shortcut");
  assert.deepEqual(h.socket.sent.filter(row => row.operation === "humanInput"), [modifier]);
  const ends = h.socket.sent.filter(row => row.operation === "humanEnd");
  assert.equal(ends.length, 1); assert.equal(ends[0].leaseId, modifier.leaseId);
  assert.equal(h.element("human-input").dataset.enabled, "false");
  assert.match(h.element("clipboard-status").textContent, /未发送/);
  assert.doesNotMatch(h.element("clipboard-status").textContent, /已写入|剪切不会回滚/);
  h.ackInput(modifier);
  assert.deepEqual(h.socket.sent.filter(row => row.operation === "humanEnd"), ends);
  assert.deepEqual(h.socket.sent.filter(row => row.operation === "humanInput"), [modifier]);
});

for (const replacement of ["generation", "lease"]) for (const settlement of ["reject", "resolve-without-data"])
test(`retired queued clipboard ${settlement} cannot end a successor ${replacement}`, async () => {
  const h = clipboardHarness();
  h.event("human-input", "keydown", { isTrusted: true, key: "Control", code: "ControlLeft", keyCode: 17, ctrlKey: true });
  const modifier = h.socket.sent.at(-1);
  h.key("keydown", { key: "x", code: "KeyX", keyCode: 88 });
  if (replacement === "generation") {
    h.socket.message({ type: "state", ...generationState(h, 2, "navigating") });
    resumeGeneration(h, 2);
  } else {
    h.element("human-end").click();
    h.respond(h.socket.sent.at(-1).id, { ...h.state(2, "paused", true, { eventSequence: 20010, retiredSequence: 20010 }),
      human: null, humanCleanup: { leaseId: "lease-a", cleanupConfirmed: true } });
    h.element("control").click(); h.respond(h.socket.sent.at(-1).id, h.state(3));
    h.element("human-begin").click();
    const next = h.state(4, "paused", true, { eventSequence: 40000, retiredSequence: 39999,
      human: { ...h.humanState().human, leaseId: "lease-b" } });
    h.respond(h.socket.sent.at(-1).id, next);
    h.humanFrame(1, { humanLeaseId: "lease-b", eventSequence: 40001, retiredSequence: 39999, streamId: "human-b" });
    h.images.at(-1).onload();
  }
  assert.equal(h.element("human-input").dataset.enabled, "true");
  h.event("human-input", "beforeinput", { inputType: "insertText", data: "successor" });
  const current = h.socket.sent.at(-1), count = h.socket.sent.length;
  if (settlement === "reject") h.writes[0].reject(Error("old local write failed late"));
  else h.writes[0].resolve();
  await flushClipboard();
  h.ackInput(modifier);
  assert.equal(h.socket.sent.length, count); assert.equal(h.socket.sent.at(-1), current);
  assert.equal(h.element("human-input").dataset.enabled, "true");
  assert.equal(h.element("clipboard-status").dataset.pending, "false");
  assert.equal(h.socket.sent.some(row => row.input?.clipboardTransfer), false);
});

for (const phase of ["before-receipt", "after-data"])
test(`already sent cut retains its native ACK and original up when local write fails ${phase}`, async () => {
  const h = clipboardHarness(), fields = { key: "x", code: "KeyX", keyCode: 88 };
  h.key("keydown", fields); const original = h.socket.sent.at(-1);
  assert.equal(original.input.clipboardTransfer, "cut");
  h.key("keyup", fields);
  if (phase === "before-receipt") { h.writes[0].reject(Error("local denial")); await flushClipboard(); }
  h.receipt(original, { operation: "cut", status: "ready", text: "original cut already happened" });
  await flushClipboard();
  const up = h.socket.sent.at(-1);
  assert.equal(up.input.code, "KeyX"); assert.equal(up.input.action, "up");
  if (phase === "after-data") {
    assert.equal(await h.writes[0].blob.text(), "original cut already happened");
    h.writes[0].reject(Error("local denial after accepting data")); await flushClipboard();
  } else assert.equal(h.writes[0].blob, null);
  assert.equal(h.element("human-input").dataset.acknowledgedSequence, String(original.sequence));
  assert.equal(h.socket.sent.filter(row => row.input?.clipboardTransfer === "cut").length, 1);
  assert.equal(h.socket.sent.some(row => row.operation === "humanEnd"), false);
  assert.match(h.element("clipboard-status").textContent, /剪切不会回滚/);
  h.ackInput(up);
  assert.equal(h.element("human-input").dataset.enabled, "true");
});

test("clipboard transfer local asynchronous denial cannot lose original keyup or revoke native ACK", async () => {
  const h = clipboardHarness(); h.key(); const request = h.socket.sent.at(-1);
  h.writes[0].reject(Error("denied")); await flushClipboard();
  h.key("keyup"); h.receipt(request, { operation: "copy", status: "ready", text: "remote cut cannot be retried" }); await flushClipboard();
  assert.equal(h.writes[0].blob, null); assert.equal(h.socket.sent.at(-1).input.action, "up");
  assert.equal(h.element("human-input").dataset.acknowledgedSequence, "1");
  assert.equal(h.socket.sent.some(x => x.operation === "humanEnd"), false);
});

test("clipboard transfer suppresses repeats and untrusted initiation without altering legacy key path", async () => {
  const h = clipboardHarness(); h.key(); const request = h.socket.sent.at(-1);
  h.key("keydown", { repeat: true }); h.key("keyup");
  h.receipt(request, { operation: "copy", status: "unchanged" }); await flushClipboard();
  assert.equal(h.writes.length, 1); assert.equal(h.socket.sent.filter(x => x.input?.repeat).length, 0);
  const untrusted = clipboardHarness(); untrusted.key("keydown", { isTrusted: false });
  assert.equal(untrusted.writes.length, 0); assert.equal(untrusted.socket.sent.some(x => x.operation === "humanInput"), false);
  const legacy = clipboardHarness({ version: undefined }); const e = legacy.key();
  assert.equal(e.prevented, true); assert.equal(legacy.writes.length, 0); assert.equal(legacy.socket.sent.at(-1).input.clipboardTransfer, undefined);
});

test("clipboard transfer binds exact Ctrl/Meta C/X and preserves two equal payloads as two operations", async () => {
  for (const meta of [false, true]) for (const operation of ["copy", "cut"]) {
    const h = clipboardHarness(), key = operation === "copy" ? "c" : "x";
    const fields = { key, code: `Key${key.toUpperCase()}`, keyCode: operation === "copy" ? 67 : 88, ctrlKey: !meta, metaKey: meta };
    for (let i = 0; i < 2; i++) {
      h.key("keydown", fields); const request = h.socket.sent.at(-1);
      assert.equal(request.input.clipboardTransfer, operation);
      assert.equal(request.input.modifiers, meta ? 4 : 2);
      h.key("keydown", { ...fields, shiftKey: true, repeat: true });
      h.key("keyup", fields);
      h.receipt(request, { operation, status: "ready", text: "相同原文" }); await flushClipboard();
      assert.equal(await h.writes[i].blob.text(), "相同原文");
      h.ackInput(); h.writes[i].resolve(); await flushClipboard();
    }
    assert.equal(h.writes.length, 2);
    assert.equal(h.socket.sent.filter(x => x.input?.clipboardTransfer).length, 2);
    assert.equal(h.socket.sent.filter(x => x.input?.repeat).length, 0);
  }
});

test("clipboard transfer rejects mismatched base receipts, unsolicited contents and retired-generation replies", async () => {
  for (const field of ["leaseId", "generation", "sequence", "acknowledged"]) {
    const h = clipboardHarness(); h.key(); const request = h.socket.sent.at(-1);
    const receipt = { leaseId: request.leaseId, generation: 1, sequence: 1, acknowledged: true,
      clipboardTransfer: { operation: "copy", status: "ready", text: "wrong original" } };
    receipt[field] = field === "leaseId" ? "foreign" : field === "acknowledged" ? false : 2;
    h.ackInput(request, { inputReceipt: receipt }); await flushClipboard();
    assert.equal(h.writes[0].blob, null); assert.ok(h.writes[0].dataError);
    assert.equal(h.socket.sent.at(-1).operation, "humanEnd");
    h.writes[0].reject(Error("cancel")); await flushClipboard();
  }
  const ordinary = clipboardHarness(); ordinary.event("human-input", "keydown", { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 });
  ordinary.receipt(ordinary.socket.sent.at(-1), { operation: "copy", status: "ready", text: "unsolicited" });
  assert.equal(ordinary.writes.length, 0);
  const h = clipboardHarness(); h.key(); const original = h.socket.sent.at(-1);
  h.socket.message({ type: "state", ...generationState(h, 2, "navigating") });
  resumeGeneration(h, 2);
  h.receipt(original, { operation: "copy", status: "ready", text: "retired" }); await flushClipboard();
  assert.equal(h.writes[0].blob, null);
  assert.equal(h.element("human-input").dataset.enabled, "true");
  const count = h.socket.sent.length; h.key(); assert.equal(h.socket.sent.length, count, "actual old local write still owns capacity");
  h.writes[0].reject(Error("cancelled")); await flushClipboard();
});

test("clipboard transfer capability is fixed for the original lease and original Begin receipt", () => {
  for (const version of [undefined, 1]) {
    for (const next of [undefined, 0, 1, 2, null, "1"]) {
      if (next === version) continue;
      const h = clipboardHarness({ version });
      const human = { ...h.humanState().human }; delete human.clipboardTransferVersion;
      if (next !== undefined) human.clipboardTransferVersion = next;
      // An older event cannot revoke valid current capability.
      h.socket.message({ type: "state", ...h.humanState({ human, eventSequence: 19998 }) });
      assert.equal(h.element("human-input").dataset.enabled, "true");
      h.socket.message({ type: "state", ...h.humanState({ human, eventSequence: 20002 }) });
      assert.equal(h.element("human-input").dataset.enabled, "false");
      assert.equal(h.socket.sent.at(-1).operation, "humanEnd");
    }
    const h = setup(1, 1, { version }), { begin, original } = beginPreparing(h);
    h.socket.message({ type: "state", ...original, eventSequence: 20003 });
    const human = { ...original.human }; delete human.clipboardTransferVersion;
    if (version === undefined) human.clipboardTransferVersion = 1;
    h.respond(begin.id, { ...original, human });
    assert.equal(h.element("connection").textContent, "控制状态不可用");
    assert.equal(h.socket.sent.some(x => x.operation === "humanInput"), false);
  }
  const h = setup(); readyResult(h);
  h.socket.message({ type: "state", ...h.state(2, "paused", true, { eventSequence: 20002, tabs: [resultTab()], selectedTabId: 1,
    view: viewState({ clipboardTransferVersion: 1 }) }) });
  assert.equal(h.element("watch").disabled, true);
});

test("clipboard transfer local settlement cannot replace a newer unknown-input error", async () => {
  const h = clipboardHarness(); h.key(); const original = h.socket.sent.at(-1); h.key("keyup");
  h.receipt(original, { operation: "copy", status: "ready", text: "original" }); await flushClipboard();
  const release = h.socket.sent.at(-1);
  h.socket.message({ type: "response", id: release.id, error: { code: "OPERATION_UNCONFIRMED", message: "原松键结果未知" } });
  h.writes[0].reject(Error("local denied")); await flushClipboard();
  assert.equal(h.element("error").textContent, "原松键结果未知");
  assert.match(h.element("clipboard-status").textContent, /写入失败/);
});

const resultTab = (extra = {}) => ({ id: 1, title: "Result", url: "https://example.test/result", kind: "result", deliveryId: "original-delivery", watchable: true, takeover: true, ...extra });
const viewState = (extra = {}) => ({ state: "active", leaseId: "view-a", tabId: 1, generation: 1, viewport: { width: 1280, height: 720 }, ...extra });
function readyResult(h, mode = "paused") {
  h.authenticate();
  h.respond(1, h.state(2, mode, mode === "paused", { tabs: [resultTab()], view: null }));
  h.choose();
  const request = h.socket.sent.at(-1);
  h.respond(request.id, h.state(2, mode, mode === "paused", { tabs: [resultTab()], selectedTabId: 1, view: viewState() }));
  h.frame(1, { eventSequence: 20001, controlMode: "user-view", viewLeaseId: "view-a", generation: 1 });
  h.images.at(-1).onload();
}

test("paused delivered result is watchable but a decoded view never grants input", () => {
  const h = setup(); readyResult(h);
  assert.deepEqual(h.socket.sent[2], { id: 2, operation: "select", tabId: 1, deliveryId: "original-delivery" });
  assert.equal(h.element("tabs").children[1].text, "已交付结果 · Result");
  assert.equal(h.element("human-begin").textContent, "操作结果页");
  assert.equal(h.element("human-begin").disabled, false);
  assert.equal(h.element("control").disabled, false);
  assert.equal(h.element("frame").dataset.controlMode, "user-view");
  assert.equal(h.element("frame").dataset.viewLeaseId, "view-a");
  assert.equal(h.element("human-input").dataset.enabled, "false");
  const before = h.socket.sent.length;
  h.event("frame", "pointerdown", { button: 0, pointerId: 1, clientX: 100, clientY: 100 });
  h.event("human-input", "keydown", { key: "A", code: "KeyA", keyCode: 65 });
  assert.equal(h.socket.sent.length, before);
  h.element("control").click();
  assert.equal(h.socket.sent.at(-1).operation, "resume");
});

test("result takeover carries delivery identity and End permits another takeover while paused", () => {
  const h = setup(); readyResult(h);
  h.element("human-begin").click();
  const begin = h.socket.sent.at(-1);
  assert.deepEqual(begin, { id: 3, operation: "humanBegin", tabId: 1, deliveryId: "original-delivery" });
  h.respond(begin.id, h.humanState({ tabs: [resultTab()], selectedTabId: 1, view: null, eventSequence: 20002, retiredSequence: 20001 }));
  assert.equal(h.element("human-input").dataset.enabled, "false");
  h.humanFrame(1, { eventSequence: 20003, retiredSequence: 20001 }); h.images.at(-1).onload();
  assert.equal(h.element("human-input").dataset.enabled, "true");
  h.element("human-end").click();
  const end = h.socket.sent.at(-1);
  h.respond(end.id, h.state(2, "paused", true, { tabs: [resultTab()], human: null, view: null, eventSequence: 20004, retiredSequence: 20003, humanCleanup: { leaseId: "lease-a", cleanupConfirmed: true } }));
  assert.equal(h.element("human-begin").disabled, false);
  assert.equal(h.element("watch").disabled, false);
  h.element("human-begin").click();
  assert.equal(h.socket.sent.at(-1).deliveryId, "original-delivery");
  assert.equal(h.socket.sent.filter(x => x.operation === "resume").length, 0);
});

test("capabilities and cleanup restrict result admission; paused legacy tasks remain blocked", () => {
  for (const extra of [{ tabs: [resultTab({ watchable: false, takeover: false })] }, { tabs: [resultTab()], viewerCleanupComplete: false }, {}]) {
    const h = setup(); h.authenticate(); h.respond(1, h.state(2, "paused", true, extra));
    h.choose();
    assert.equal(h.element("watch").disabled, true);
    assert.equal(h.element("human-begin").disabled, true);
    assert.equal(h.socket.sent.some(x => x.operation === "select"), false);
  }
});

test("delivery replacement retires pending selection and requires a fresh explicit choice", () => {
  for (const late of ["success", "error", "timeout"]) {
    const h = setup(); h.authenticate(); h.respond(1, h.state(2, "paused", true, { tabs: [resultTab()] })); h.choose();
    const timeout = [...h.timers.values()].at(-1);
    h.socket.message({ type: "state", ...h.state(2, "paused", true, { tabs: [resultTab({ deliveryId: "successor" })], eventSequence: 20002 }) });
    if (late === "timeout") timeout();
    else if (late === "error") h.socket.message({ type: "response", id: 2, error: { code: "OPERATION_UNCONFIRMED" } });
    else h.respond(2, h.state(2, "paused", true, { tabs: [resultTab()], selectedTabId: 1, view: viewState() }));
    assert.equal(h.element("tabs").value, "");
    assert.equal(h.element("state").textContent, "已暂停");
    assert.equal(h.element("human-begin").disabled, true);
    h.choose();
    assert.equal(h.socket.sent.at(-1).deliveryId, "successor");
  }
});

test("read-only navigation retires decode and admits only the matching successor frame", () => {
  const h = setup(); readyResult(h);
  h.frame(2, { eventSequence: 20002, controlMode: "user-view", viewLeaseId: "view-a", generation: 1 });
  const oldDecode = h.images.at(-1);
  h.socket.message({ type: "state", ...h.state(2, "paused", true, { tabs: [resultTab()], selectedTabId: 1, view: viewState({ state: "navigating", generation: 2, viewport: null }), eventSequence: 20003 }) });
  h.frame(1, { eventSequence: 20005, streamId: "view-next", controlMode: "user-view", viewLeaseId: "view-a", generation: 2 });
  oldDecode.onload();
  assert.equal(h.element("frame").src, undefined);
  h.socket.message({ type: "state", ...h.state(2, "paused", true, { tabs: [resultTab()], selectedTabId: 1, view: viewState({ generation: 2 }), eventSequence: 20004 }) });
  h.images.at(-1).onload();
  assert.equal(h.element("frame").dataset.generation, "2");
  assert.equal(h.element("frame").dataset.viewLeaseId, "view-a");
  assert.equal(h.element("human-input").dataset.enabled, "false");
  assert.equal(h.socket.sent.some(x => x.operation === "humanEnd"), false);
  const count = h.images.length;
  h.frame(10, { eventSequence: 20006, controlMode: "user-view", viewLeaseId: "view-a", generation: 1 });
  h.frame(11, { eventSequence: 20007, controlMode: "user-view", viewLeaseId: "other", generation: 2 });
  h.frame(12, { eventSequence: 20008 });
  assert.equal(h.images.length, count);
});

test("actual Go-projected result fixture supports view, paused takeover, End and a second takeover", () => {
  const fixture = JSON.parse(readFileSync(new URL("../testdata/public-result-fixture.json", import.meta.url), "utf8"));
  const h = setup();
  const state = value => ({ ...value, retiredSequence: 0 });
  const receiveFrame = (mode, lease) => {
    const value = fixture.events.find(e => e.type === "frame" && e.controlMode === mode && (e.viewLeaseId || e.humanLeaseId) === lease);
    assert.ok(value);
    h.socket.message(state(value));
    h.images.at(-1).naturalWidth = h.images.at(-1).naturalHeight = 1;
    h.images.at(-1).onload();
  };
  h.authenticate(); h.respond(1, state(fixture.open)); h.choose(7);
  assert.equal(h.socket.sent.at(-1).deliveryId, "fixture-delivery-original");
  h.respond(2, state(fixture.viewRunningStatus)); receiveFrame("user-view", fixture.viewRunningStatus.view.leaseId);
  assert.equal(h.element("human-input").dataset.enabled, "false");
  h.element("control").click(); h.respond(3, state(fixture.pause));
  h.element("watch").click(); h.respond(4, state(fixture.viewPausedStatus)); receiveFrame("user-view", fixture.viewPausedStatus.view.leaseId);
  h.element("human-begin").click(); h.respond(5, state(fixture.humanBegin)); receiveFrame("human", fixture.humanBegin.human.leaseId);
  assert.equal(h.element("human-input").dataset.enabled, "true");
  h.event("human-input", "beforeinput", { inputType: "insertText", data: "x" });
  h.respond(6, state(fixture.humanInput));
  assert.equal(h.element("human-input").dataset.acknowledgedSequence, "1");
  h.socket.message({ type: "state", ...state(fixture.humanNavigation.navigating) });
  assert.equal(h.element("human-input").dataset.enabled, "false");
  h.socket.message({ type: "state", ...state(fixture.humanNavigation.active) });
  const successor = fixture.events.find(e => e.type === "frame" && e.controlMode === "human" && e.generation === 2);
  h.socket.message(state(successor)); h.images.at(-1).onload();
  h.element("human-end").click(); h.respond(7, state(fixture.humanEnd));
  assert.equal(h.element("state").textContent, "已暂停");
  h.element("watch").click(); h.respond(8, state(fixture.viewAfterHumanStatus)); receiveFrame("user-view", fixture.viewAfterHumanStatus.view.leaseId);
  assert.ok(h.element("page-title").textContent.includes("B"));
  h.element("human-begin").click(); h.respond(9, state(fixture.secondHumanBegin)); receiveFrame("human", fixture.secondHumanBegin.human.leaseId);
  h.element("human-end").click(); h.respond(10, state(fixture.secondHumanEnd));
  assert.equal(h.element("human-begin").disabled, false);
  assert.equal(h.socket.sent.filter(x => x.operation === "resume").length, 0);
});

test("Go projection fixture matches the current real managed worker bridge", async () => {
  assert.deepEqual(await captureFixture(), JSON.parse(readFileSync(new URL("../testdata/bridge-fixture.json", import.meta.url), "utf8")));
});

test("result fixture records the real bridge lifecycle, including view navigation", async () => {
  assert.deepEqual(await captureResultFixture(), JSON.parse(readFileSync(new URL("../testdata/result-bridge-fixture.json", import.meta.url), "utf8")));
});

function setup(inputBudgetVersion, keyRepeatVersion, clipboard = {}) {
  const nodes = new Map();
  const images = [], revoked = [], timers = new Map(), timerDelays = new Map();
  const windowEvents = {}, documentEvents = {};
  let timerId = 0, replaced, socket;
  let focused = null;
  function element(id) {
    if (!nodes.has(id)) nodes.set(id, {
      disabled: false, hidden: false, textContent: "", value: "", listeners: {}, dataset: {}, style: {},
      addEventListener(event, handler) { this.listeners[event] = handler; },
      replaceChildren(...children) { this.children = children; },
      removeAttribute(name) { delete this[name]; },
      click() { this.listeners.click?.(); },
      focus() { const old = focused; focused = this; if (old && old !== this) old.listeners.blur?.(); },
      getBoundingClientRect() { return this.rect || { left: 10, top: 20, width: 640, height: 360 }; },
      setPointerCapture(id) { this.capture = id; },
      hasPointerCapture(id) { return this.capture === id; },
      releasePointerCapture() { this.capture = null; this.listeners.lostpointercapture?.(); }
    });
    return nodes.get(id);
  }
  class FakeSocket {
    static OPEN = 1;
    constructor(url) { this.url = url; this.readyState = 1; this.handlers = {}; this.sent = []; socket = this; }
    addEventListener(name, handler) { this.handlers[name] = handler; }
    send(message) { this.sent.push(JSON.parse(message)); }
    close() { this.handlers.close?.(); }
    open() { this.handlers.open?.(); }
    message(data) { this.handlers.message?.({ data: JSON.stringify(data) }); }
  }
  class FakeImage {
    constructor() { this.naturalWidth = 1280; this.naturalHeight = 720; images.push(this); }
  }
  let nextBlob = 0;
  const context = vm.createContext({
    document: { getElementById: element, addEventListener(name, handler) { documentEvents[name] = handler; } },
    location: { hash: `#ticket=${ticket}`, host: "127.0.0.1:44555", pathname: "/" },
    history: { replaceState(...args) { replaced = args; } },
    URLSearchParams, WebSocket: FakeSocket, Blob, Uint8Array, TextEncoder,
    navigator: clipboard.navigator, ClipboardItem: clipboard.ClipboardItem,
    URL: class extends URL { static createObjectURL() { return `blob:${++nextBlob}`; } static revokeObjectURL(value) { revoked.push(value); } },
    Image: FakeImage, Option: class { constructor(text, value) { this.text = text; this.value = value; } },
    atob: value => Buffer.from(value, "base64").toString("binary"),
    btoa: value => Buffer.from(value, "binary").toString("base64"),
    setTimeout(callback, delay) { timers.set(++timerId, callback); timerDelays.set(timerId, delay); return timerId; },
    clearTimeout(id) { timers.delete(id); timerDelays.delete(id); }, setInterval() {},
    window: { innerWidth: 1440, innerHeight: 1000, addEventListener(name, handler) { windowEvents[name] = handler; } }
  });
  vm.runInContext(fileSource, context);
  vm.runInContext(source, context);
  function authenticate() { socket.open(); socket.message({ type: "authenticated" }); }
  function state(revision = 1, mode = "running", cleanupComplete = false, extra = {}) {
    return { status: { state: mode, inputBlocked: mode !== "running", revision, cleanupComplete }, workerBootId: "worker-a", eventSequence: revision * 10000, retiredSequence: 0, viewerCleanupComplete: true, selectedTabId: null, tabs: [{ id: 1, title: "<img onerror=bad>", url: "https://example.test" }], ...(clipboard.pageSelectionVersion !== undefined ? { pageSelectionVersion: clipboard.pageSelectionVersion } : {}), ...extra };
  }
  function respond(id, result) { socket.message({ type: "response", id, result }); }
  function running() { authenticate(); respond(1, state()); }
  function choose(tab = 1) { element("tabs").value = String(tab); element("tabs").listeners.change(); }
  function frame(sequence, extra = {}) { socket.message({ type: "frame", tabId: 1, streamId: "stream-a", sequence, eventSequence: 10000 + sequence, retiredSequence: 0, data: "aW1hZ2U=", mimeType: "image/png", metadata: {}, ...extra }); }
  function event(id, name, data = {}) { const e = { preventDefault() { this.prevented = true; }, ...data }; element(id).listeners[name]?.(e); return e; }
  function humanState(extra = {}) { return state(2, "paused", true, { eventSequence: 20000, retiredSequence: 19999, human: { state: "active", leaseId: "lease-a", generation: 1, tabId: 1, viewport: { width: 1280, height: 720 }, ...(inputBudgetVersion !== undefined ? { inputBudgetVersion } : {}), ...(keyRepeatVersion !== undefined ? { keyRepeatVersion } : {}), ...(clipboard.version !== undefined ? { clipboardTransferVersion: clipboard.version } : {}), ...(clipboard.fileChooserVersion !== undefined ? { fileChooserVersion: clipboard.fileChooserVersion } : {}), ...(clipboard.pointerClickCountVersion !== undefined ? { pointerClickCountVersion: clipboard.pointerClickCountVersion } : {}) }, ...extra }); }
  function beginHuman() { running(); choose(); respond(2, state(1, "running", false, { selectedTabId: 1 })); element("human-begin").click(); respond(3, humanState()); }
  function humanFrame(sequence = 1, extra = {}) { frame(sequence, { streamId: "human-stream", eventSequence: 20000 + sequence, retiredSequence: 19999, controlMode: "human", humanLeaseId: "lease-a", generation: 1, ...extra }); }
  function readyHuman() { beginHuman(); humanFrame(); images.at(-1).onload(); }
  function ackInput(request = socket.sent.at(-1), extra = {}) { respond(request.id, { ...humanState(), inputReceipt: { acknowledged: true, leaseId: request.leaseId, generation: request.generation, sequence: request.sequence }, ...extra }); }
  return { element, socket, images, revoked, timers, timerDelays, replaced, authenticate, state, respond, running, choose, frame, event, windowEvents, documentEvents, humanState, beginHuman, humanFrame, readyHuman, ackInput,
    setHidden(hidden) { context.document.hidden = hidden; documentEvents.visibilitychange?.(); },
    setViewport(width, height) { context.window.innerWidth = width; context.window.innerHeight = height; } };
}

const browserChoice = (id = 2, pageSelectionId = "choice-child") => ({ id, title: "Child", url: "https://child.example/", kind: "browser", pageSelectionId, watchable: true, takeover: true });
const retainedChoice = (id = 2, deliveryId = "delivery-child") => ({ id, title: "Child", url: "https://child.example/", kind: "result", deliveryId, watchable: true, takeover: true });
const choiceReceipt = (tabId = 2, pageSelectionId = "choice-child", deliveryId = "delivery-child") => ({ tabId, pageSelectionId, deliveryId, retained: true });

test("browser choice becomes a result only through its original selection receipt", () => {
  const h = setup(undefined, undefined, { pageSelectionVersion: 1 }); h.authenticate();
  h.respond(1, h.state(2, "paused", true, { tabs: [browserChoice()] })); h.choose(2);
  const selection = h.socket.sent.at(-1);
  assert.equal(selection.operation, "select"); assert.equal(selection.pageSelectionId, "choice-child");
  h.respond(selection.id, h.state(2, "paused", true, { eventSequence: 20001, selectedTabId: 2, tabs: [retainedChoice()], pageSelectionReceipt: choiceReceipt() }));
  assert.equal(h.element("human-begin").disabled, false);
  h.element("human-begin").click();
  assert.equal(h.socket.sent.at(-1).deliveryId, "delivery-child");
  assert.equal(h.socket.sent.at(-1).pageSelectionId, undefined);
});

test("browser switching waits for exact End response even if cleanup state arrives first", () => {
  const h = setup(undefined, undefined, { pageSelectionVersion: 1 }); h.readyHuman();
  h.socket.message({ type: "state", ...h.humanState({ eventSequence: 20002, tabs: [...h.state().tabs, browserChoice()] }) });
  h.element("human-switch").click();
  const end = h.socket.sent.at(-1); assert.equal(end.operation, "humanEnd");
  const clean = h.state(2, "paused", true, { eventSequence: 20003, human: null, tabs: [browserChoice()], humanCleanup: { leaseId: "lease-a", cleanupConfirmed: true } });
  h.socket.message({ type: "state", ...clean }); h.choose(2);
  assert.equal(h.socket.sent.at(-1), end, "status alone cannot dispatch the next selection");
  h.respond(end.id, clean); h.choose(2);
  const selection = h.socket.sent.at(-1); assert.equal(selection.pageSelectionId, "choice-child");
  h.respond(selection.id, h.state(2, "paused", true, { eventSequence: 20004, selectedTabId: 2, tabs: [retainedChoice()], pageSelectionReceipt: choiceReceipt() }));
  const begin = h.socket.sent.at(-1);
  assert.equal(begin.operation, "humanBegin"); assert.equal(begin.deliveryId, "delivery-child");
  assert.equal(h.socket.sent.filter(x => x.operation === "humanBegin").length, 2);
});

function switchingBrowserPage() {
  const h = setup(undefined, undefined, { pageSelectionVersion: 1 }); h.readyHuman();
  h.socket.message({ type: "state", ...h.humanState({ eventSequence: 20002, tabs: [...h.state().tabs, browserChoice()] }) });
  h.element("human-switch").click();
  const end = h.socket.sent.at(-1);
  const clean = h.state(2, "paused", true, { eventSequence: 20003, human: null, view: null, tabs: [browserChoice()], humanCleanup: { leaseId: "lease-a", cleanupConfirmed: true } });
  const promoted = h.state(2, "paused", true, { eventSequence: 20004, selectedTabId: 2, human: null, view: null, tabs: [retainedChoice()], pageSelectionReceipt: choiceReceipt() });
  return { h, end, clean, promoted };
}

test("browser switch response-first orders End, select receipt and delivery Begin", () => {
  const { h, end, clean, promoted } = switchingBrowserPage();
  h.respond(end.id, clean); h.choose(2);
  const select = h.socket.sent.at(-1);
  h.socket.message({ type: "state", ...promoted, pageSelectionReceipt: undefined });
  assert.equal(h.element("human-begin").disabled, true, "promotion status is not a choice receipt");
  assert.equal(h.socket.sent.filter(x => x.operation === "humanBegin").length, 1);
  h.respond(select.id, promoted);
  assert.deepEqual(h.socket.sent.slice(-3).map(x => x.operation), ["humanEnd", "select", "humanBegin"]);
  assert.equal(h.socket.sent.at(-1).deliveryId, "delivery-child");
  assert.equal(h.socket.sent.at(-1).pageSelectionId, undefined);
  assert.equal(h.socket.sent.filter(x => x.operation === "resume").length, 0);
});

for (const fault of ["missing", "foreign", "unconfirmed", "pending", "error", "timeout"]) test(`browser switch refuses ${fault} End`, () => {
  const { h, end, clean } = switchingBrowserPage();
  if (fault === "missing") delete clean.humanCleanup;
  if (fault === "foreign") clean.humanCleanup.leaseId = "successor";
  if (fault === "unconfirmed") clean.humanCleanup.cleanupConfirmed = false;
  if (fault === "pending") clean.viewerCleanupComplete = false;
  if (fault === "error") h.socket.message({ type: "response", id: end.id, error: { code: "OPERATION_UNCONFIRMED" } });
  else if (fault === "timeout") [...h.timers.values()].at(-1)();
  else h.respond(end.id, clean);
  h.choose(2); h.element("human-begin").click();
  assert.equal(h.socket.sent.filter(x => x.operation === "select").length, 1);
  assert.equal(h.socket.sent.filter(x => x.operation === "humanBegin").length, 1);
});

for (const fault of ["missing", "foreign-tab", "foreign-choice", "extra", "different-delivery", "gone", "successor-choice"]) test(`browser switch refuses ${fault} promotion`, () => {
  const { h, end, clean, promoted } = switchingBrowserPage();
  h.respond(end.id, clean); h.choose(2); const select = h.socket.sent.at(-1);
  if (fault === "missing") delete promoted.pageSelectionReceipt;
  if (fault === "foreign-tab") promoted.pageSelectionReceipt.tabId = 3;
  if (fault === "foreign-choice") promoted.pageSelectionReceipt.pageSelectionId = "new-choice";
  if (fault === "extra") promoted.pageSelectionReceipt.nativeTarget = "private";
  if (fault === "different-delivery") promoted.tabs = [retainedChoice(2, "different-delivery")];
  if (fault === "gone") h.socket.message({ type: "state", ...clean, eventSequence: 20005, tabs: [] });
  if (fault === "successor-choice") h.socket.message({ type: "state", ...clean, eventSequence: 20005, tabs: [browserChoice(2, "new-choice")] });
  h.respond(select.id, promoted);
  assert.equal(h.socket.sent.filter(x => x.operation === "humanBegin").length, 1, "no late or foreign auto-Begin");
  assert.notEqual(h.element("human-switch").textContent, "正在切换…", "retired choice does not strand the switch workflow");
});

for (const phase of ["ending", "selecting"]) for (const cancel of ["disconnect", "blur", "stop", "hidden"]) test(`browser switch ${phase} cannot survive ${cancel}`, () => {
  const { h, end, clean, promoted } = switchingBrowserPage();
  let request = end, result = clean;
  if (phase === "selecting") { h.respond(end.id, clean); h.choose(2); request = h.socket.sent.at(-1); result = promoted; }
  if (cancel === "disconnect") h.socket.close();
  if (cancel === "blur") h.windowEvents.blur();
  if (cancel === "stop") h.element("stop").click();
  if (cancel === "hidden") h.setHidden(true);
  h.respond(request.id, result);
  assert.equal(h.socket.sent.filter(x => x.operation === "humanBegin").length, 1);
});

test("browser page capability is channel-fixed and older states cannot change it", () => {
  for (const initial of [undefined, 1]) {
    const h = setup(undefined, undefined, { pageSelectionVersion: initial }); h.running();
    h.socket.message({ type: "state", ...h.state(2, "paused", true, { eventSequence: 20000 }) });
    h.socket.message({ type: "state", ...h.state(1, "running", false, { eventSequence: 9999, pageSelectionVersion: initial === 1 ? undefined : 1 }) });
    assert.equal(h.element("connection").textContent, "已连接");
    h.socket.message({ type: "state", ...h.state(3, "paused", true, { eventSequence: 30000, pageSelectionVersion: initial === 1 ? undefined : 1 }) });
    assert.equal(h.element("tabs").disabled, true);
  }
});

test("legacy channel hides page switching and ordinary End does not arm auto-Begin", () => {
  const legacy = setup(); legacy.readyHuman(); assert.equal(legacy.element("human-switch").hidden, true);
  const { h, end, clean, promoted } = switchingBrowserPage();
  h.respond(end.id, clean); h.element("human-switch").click(); // cancel choosing
  h.choose(2); h.respond(h.socket.sent.at(-1).id, promoted);
  assert.equal(h.socket.sent.filter(x => x.operation === "humanBegin").length, 1);
  assert.equal(h.element("human-begin").disabled, false);
});

function beginPreparing(h, generation = 1, state = "preparing") {
  h.running(); h.choose(); h.respond(2, h.state(1, "running", false, { selectedTabId: 1 }));
  h.element("human-begin").click();
  const begin = h.socket.sent.at(-1);
  const original = h.humanState({ human: { ...h.humanState().human, state, generation, viewport: null } });
  return { begin, original };
}

for (const generation of [0, 1]) test(`preparing generation ${generation} admits End only after its original Begin receipt`, () => {
  const h = setup(1), { begin, original } = beginPreparing(h, generation);
  h.socket.message({ type: "state", ...original });
  assert.equal(h.element("human-end").disabled, true);
  h.element("human-end").click();
  assert.equal(h.socket.sent.at(-1), begin);
  h.respond(begin.id, original);
  assert.equal(h.element("connection").textContent, "已连接");
  assert.equal(h.element("human-input").dataset.enabled, "false");
  assert.equal(h.element("human-end").disabled, false);
  h.element("human-end").click();
  assert.equal(h.socket.sent.at(-1).operation, "humanEnd");
  assert.equal(h.socket.sent.at(-1).leaseId, "lease-a");
  h.respond(h.socket.sent.at(-1).id, releaseState(h));
  assert.equal(h.element("human-end").hidden, true);
});

for (const stage of ["preparing", "navigating"]) test(`${stage} proven dialog is independent of viewport and requires Begin receipt`, () => {
  const h = setup(1), { begin, original } = beginPreparing(h, 1, stage);
  original.pendingDialog = dialog();
  h.socket.message({ type: "state", ...original });
  assert.equal(h.element("dialog-accept").disabled, true);
  h.element("dialog-accept").click(); assert.equal(h.socket.sent.at(-1), begin);
  h.respond(begin.id, original);
  assert.equal(h.element("dialog-accept").disabled, false);
  h.element("dialog-prompt").value = "原输入😀"; h.element("dialog-accept").click();
  const answer = h.socket.sent.at(-1);
  assert.equal(answer.operation, "humanDialogRespond"); assert.equal(answer.generation, 1);
  assert.equal(h.element("human-input").dataset.enabled, "false");
  h.respond(answer.id, { ...original, eventSequence: 20002, pendingDialog: null,
    dialogReceipt: { leaseId: "lease-a", generation: 1, dialogId: original.pendingDialog.dialogId, acknowledged: true } });
  assert.equal(h.element("human-input").dataset.enabled, "false");
  assert.equal(h.socket.sent.some(x => x.operation === "humanInput" || x.operation === "humanEnd"), false);
});

for (const order of ["state-first", "frame-first"]) test(`preparing same-generation first viewport requires decoded frame: ${order}`, () => {
  const h = setup(1), { begin, original } = beginPreparing(h);
  h.respond(begin.id, original);
  if (order === "frame-first") h.humanFrame(3, { eventSequence: 20003 });
  h.socket.message({ type: "state", ...h.humanState({ eventSequence: 20002 }) });
  assert.equal(h.element("human-input").dataset.enabled, "false");
  if (order === "state-first") h.humanFrame(3, { eventSequence: 20003 });
  assert.equal(h.images.length, 1); h.images[0].onload();
  assert.equal(h.element("human-input").dataset.enabled, "true");
  assert.equal(h.socket.sent.some(x => x.operation === "humanEnd"), false);
  h.socket.message({ type: "state", ...h.humanState({ eventSequence: 20004,
    human: { ...h.humanState().human, viewport: { width: 800, height: 600 } } }) });
  assert.equal(h.element("human-input").dataset.enabled, "false", "later same-generation resize is not initial readiness");
});

test("navigating dialog response does not wait for the old input receipt or new frame", () => {
  const h = setup(1); h.readyHuman();
  h.event("human-input", "beforeinput", { inputType: "insertText", data: "original" });
  const input = h.socket.sent.at(-1);
  const next = generationState(h, 2, "navigating"); next.pendingDialog = dialog({ generation: 2 });
  h.socket.message({ type: "state", ...next });
  h.element("dialog-accept").click(); const answer = h.socket.sent.at(-1);
  assert.equal(answer.operation, "humanDialogRespond"); assert.equal(answer.generation, 2);
  h.ackInput(input);
  assert.equal(h.element("human-input").dataset.enabled, "false");
  assert.equal(h.socket.sent.at(-1), answer); assert.equal(h.element("dialog-accept").disabled, true);
});

test("pre-admission starting geometry can become ready but cannot replace Begin", () => {
  const h = setup(), { begin, original } = beginPreparing(h, 1, "starting");
  h.socket.message({ type: "state", ...original });
  const active = h.humanState({ eventSequence: 20002 });
  h.socket.message({ type: "state", ...active });
  h.humanFrame(3, { eventSequence: 20003 }); h.images.at(-1).onload();
  assert.equal(h.element("human-end").disabled, true); assert.equal(h.element("human-input").dataset.enabled, "false");
  h.respond(begin.id, active);
  assert.equal(h.element("human-input").dataset.enabled, "true");
  assert.equal(h.socket.sent.some(x => x.operation === "humanEnd"), false);
});

for (const wrong of ["starting", "zero-dialog", "foreign-lease", "readonly", "viewport"]) test(`preparing rejects invalid authority: ${wrong}`, () => {
  const h = setup(), { begin, original } = beginPreparing(h);
  if (wrong === "starting") original.human.state = "starting";
  else if (wrong === "zero-dialog") { original.human.generation = 0; original.pendingDialog = dialog(); }
  else if (wrong === "foreign-lease") { h.socket.message({ type: "state", ...original }); original.human.leaseId = "foreign"; }
  else if (wrong === "readonly") { original.view = original.human; original.human = null; }
  else original.human.viewport = { width: 1280, height: 720 };
  h.respond(begin.id, original);
  assert.equal(h.element("human-input").dataset.enabled, "false");
  assert.equal(h.element("human-end").disabled, true);
  assert.equal(h.element("dialog-accept").disabled, true);
  assert.equal(h.socket.sent.some(x => x.operation === "humanEnd" || x.operation === "humanDialogRespond"), false);
});

test("blur and disconnect during preparing retain the original admission and never enable late frame", () => {
  for (const ended of ["blur", "disconnect"]) {
    const h = setup(), { begin, original } = beginPreparing(h);
    h.socket.message({ type: "state", ...original });
    if (ended === "blur") h.windowEvents.blur(); else h.socket.close();
    h.respond(begin.id, original);
    h.humanFrame();
    assert.equal(h.element("human-input").dataset.enabled, "false");
    assert.equal(h.socket.sent.filter(x => x.operation === "humanEnd").length, ended === "blur" ? 1 : 0);
  }
});

test("ticket is removed before connecting and sent only in first WebSocket auth", () => {
  const h = setup();
  assert.deepEqual(h.replaced, [null, "", "/"]);
  assert.equal(h.socket.url, "ws://127.0.0.1:44555/ws");
  assert.equal(h.element("control").disabled, true);
  h.authenticate();
  assert.deepEqual(h.socket.sent, [{ type: "authenticate", token: ticket }, { id: 1, operation: "status" }]);
  h.respond(1, h.state());
  h.element("refresh").click();
  assert.equal(JSON.stringify(h.socket.sent.slice(1)).includes(ticket), false);
  assert.equal(h.element("tabs").children[1].text, "<img onerror=bad>");
});

test("pause remains unconfirmed until receipt; resume requires current complete revision and worker", () => {
  const h = setup(); h.running();
  h.element("control").click();
  assert.deepEqual(h.socket.sent.at(-1), { id: 2, operation: "pause" });
  assert.equal(h.element("state").textContent, "正在暂停");
  h.socket.message({ type: "state", ...h.state(1) });
  assert.equal(h.element("state").textContent, "正在暂停");
  h.socket.message({ type: "response", id: 2, error: { message: "unconfirmed" } });
  assert.equal(h.element("control").disabled, true);
  h.element("refresh").click();
  h.respond(3, h.state(2, "paused", false));
  assert.equal(h.element("control").textContent, "重试暂停");
  h.element("control").click();
  assert.equal(h.socket.sent.at(-1).operation, "pause");
  h.respond(4, h.state(3, "paused", true));
  h.element("control").click();
  assert.deepEqual(h.socket.sent.at(-1), { id: 5, operation: "resume", expectedRevision: 3, expectedWorkerBootId: "worker-a" });
});

test("stale replies cannot replace newer status and a worker change revokes resume", () => {
  const h = setup(); h.authenticate();
  h.element("refresh").click();
  h.respond(2, h.state(4, "paused", true));
  h.respond(1, h.state(1));
  assert.equal(h.element("state").textContent, "已暂停");
  h.socket.message({ type: "state", ...h.state(1, "paused", true, { workerBootId: "worker-b" }) });
  assert.equal(h.element("control").disabled, true);
  assert.equal(h.element("state").textContent, "状态未确认");
});

test("disconnect and timeouts never claim pause or stop success or replay commands", () => {
  const h = setup(); h.running();
  h.element("control").click();
  const before = h.socket.sent.length;
  [...h.timers.values()].at(-1)();
  assert.equal(h.element("state").textContent, "状态未确认");
  assert.equal(h.socket.sent.length, before);
  h.socket.close();
  assert.equal(h.element("stop").disabled, true);
  assert.equal(h.element("state").textContent, "状态未确认");
  assert.equal(h.socket.sent.length, before);
});

test("stop remains available after backend loss and only acknowledgement confirms stopped", () => {
  const h = setup(); h.running();
  h.socket.message({ type: "unavailable" });
  assert.equal(h.element("control").disabled, true);
  assert.equal(h.element("stop").disabled, false);
  h.element("stop").click();
  h.respond(2, { stopped: true });
  assert.equal(h.element("state").textContent, "会话已停止");
  h.socket.close();
  assert.equal(h.element("state").textContent, "会话已停止");
});

test("image decode has one active and one latest slot; pause suppresses late image", () => {
  const h = setup(); h.running(); h.choose();
  h.frame(1);
  for (let sequence = 2; sequence <= 1000; sequence++) h.frame(sequence);
  assert.equal(h.images.length, 1);
  h.images[0].onload();
  assert.equal(h.images.length, 2);
  assert.equal(h.element("frame").src, "blob:1");
  h.socket.message({ type: "state", ...h.state(2, "paused", true, { tabs: [] }) });
  h.images[1].onload();
  assert.equal(h.element("frame").src, "blob:1");
  assert.equal(h.revoked.includes("blob:2"), true);
  assert.equal(h.element("freshness").textContent.startsWith("保留画面"), true);
  assert.equal(h.element("frame").hidden, false);
});

test("changing selection rejects old tab frames and releases image URLs", () => {
  const h = setup(); h.running(); h.choose(); h.frame(1); h.images[0].onload();
  h.respond(2, h.state(1, "running", false, { selectedTabId: 1 }));
  h.element("tabs").value = ""; h.element("tabs").listeners.change();
  assert.deepEqual(h.socket.sent.at(-1), { id: 3, operation: "select", tabId: null });
  assert.equal(h.revoked.includes("blob:1"), true);
  h.frame(2);
  assert.equal(h.images.length, 1);
  assert.equal(h.element("frame").hidden, true);
});

test("resume never resubscribes; the same option has an explicit start watching action", () => {
  const h = setup(); h.running(); h.choose();
  h.respond(2, h.state(1, "running", false, { selectedTabId: 1 }));
  assert.equal(h.element("watch").textContent, "停止查看");
  h.element("control").click();
  h.respond(3, h.state(2, "paused", true));
  h.element("control").click();
  h.respond(4, h.state(3));
  assert.equal(h.socket.sent.at(-1).operation, "resume");
  assert.equal(h.element("watch").textContent, "开始查看");
  h.element("watch").click();
  assert.deepEqual(h.socket.sent.at(-1), { id: 5, operation: "select", tabId: 1 });
});

test("retirement fences cross-queue late frames and late select responses", () => {
  const h = setup(); h.running(); h.choose();
  h.frame(1); // Decode started while Select is still awaiting its receipt.
  h.socket.message({ type: "clear", eventSequence: 10004, retiredSequence: 10004 });
  h.frame(2, { eventSequence: 10003 }); // Delivered after Clear from the frame queue.
  assert.equal(h.images.length, 1);
  h.images[0].onload();
  assert.equal(h.element("frame").hidden, true);
  h.respond(2, h.state(1, "running", false, { selectedTabId: 1, eventSequence: 10002 }));
  assert.equal(h.element("watch").textContent, "开始查看");
  h.frame(3, { eventSequence: 10003 });
  assert.equal(h.images.length, 1);
  h.element("watch").click();
  h.respond(3, h.state(1, "running", false, { selectedTabId: 1, eventSequence: 10005 }));
  h.frame(1, { streamId: "stream-b", eventSequence: 10006 });
  assert.equal(h.images.length, 2);
  h.images[1].onload();
  assert.equal(h.element("frame").dataset.eventSequence, "10006");
});

test("backend revocation cannot be undone by a late successful command", () => {
  const h = setup(); h.authenticate();
  h.socket.message({ type: "unavailable" });
  h.respond(1, h.state(9, "paused", true));
  assert.equal(h.element("control").disabled, true);
  assert.equal(h.element("stop").disabled, false);
});

test("bridge rendering cleanup failure prevents Resume even if automation cleanup completed", () => {
  const h = setup(); h.authenticate();
  h.respond(1, h.state(1, "paused", true, { viewerCleanupComplete: false }));
  assert.equal(h.element("control").textContent, "重试暂停");
  h.element("control").click();
  assert.equal(h.socket.sent.at(-1).operation, "pause");
});

test("a coalesced status retains the retirement barrier when Clear was replaced", () => {
  const h = setup(); h.running(); h.choose();
  h.frame(1);
  h.socket.message({ type: "state", ...h.state(1, "running", false, { selectedTabId: 1, eventSequence: 10007, retiredSequence: 10005 }) });
  h.images[0].onload();
  assert.equal(h.element("frame").hidden, true);
  h.frame(2, { eventSequence: 10004, retiredSequence: 10005 });
  assert.equal(h.images.length, 1);
  h.frame(1, { streamId: "stream-b", eventSequence: 10006, retiredSequence: 10005 });
  assert.equal(h.images.length, 2);
  h.images[1].onload();
  assert.equal(h.element("frame").dataset.streamId, "stream-b");
});

const mouse = (extra = {}) => ({ pointerId: 1, pointerType: "mouse", clientX: 330, clientY: 200, button: 0, ...extra });
function multiMouse(h, action, detail = 1, extra = {}) {
  const value = { ...mouse(), target: h.element("frame"), isTrusted: true, detail, preventDefault() { this.prevented = true; }, ...extra };
  if (action === "down") h.event("frame", "mousedown", value);
  else h.windowEvents[`mouse${action}`]?.(value);
  return h.socket.sent.at(-1);
}
function multiHarness() {
  const h = setup(1, 1, { pointerClickCountVersion: 1 }); h.readyHuman(); return h;
}
test("multi-click uses trusted mouse detail and never also forwards its pointer compatibility events", () => {
  const h = multiHarness(), before = h.socket.sent.length;
  const pointer = h.event("frame", "pointerdown", mouse({ isTrusted: true, detail: 0 }));
  assert.equal(pointer.prevented, undefined);
  assert.equal(h.socket.sent.length, before);
  multiMouse(h, "down", 1, { isTrusted: false });
  assert.equal(h.socket.sent.length, before);
  const down = multiMouse(h, "down");
  assert.equal(down.input.clickCount, 1); assert.equal(down.input.action, "down");
  assert.equal(h.element("frame").capture, undefined);
  h.event("frame", "pointerup", mouse({ isTrusted: true }));
  assert.equal(h.socket.sent.at(-1), down);
  multiMouse(h, "up");
  h.ackInput(down);
  const up = h.socket.sent.at(-1); assert.equal(up.input.clickCount, 1); assert.equal(up.input.action, "up");
  h.ackInput(up);
  assert.equal(h.socket.sent.filter(value => value.operation === "humanInput").length, 2);
});
test("multi-click preserves each original down/up through delayed ACKs, including count four", () => {
  const h = multiHarness();
  for (let count = 1; count <= 4; count++) { multiMouse(h, "down", count); multiMouse(h, "up", count); }
  for (let n = 0; n < 8; n++) {
    const request = h.socket.sent.at(-1);
    assert.equal(request.input.action, n % 2 ? "up" : "down");
    assert.equal(request.input.clickCount, Math.floor(n / 2) + 1);
    assert.equal(request.sequence, n + 1); h.ackInput(request);
  }
  assert.equal(h.socket.sent.filter(value => value.operation === "humanInput").length, 8);
});
test("multi-click starts at one after an unobserved sequence and restarts on a raw count gap", () => {
  const h = multiHarness();
  for (const [raw, emitted] of [[3, 1], [4, 2], [7, 1], [1, 1]]) {
    const down = multiMouse(h, "down", raw); assert.equal(down.input.clickCount, emitted); h.ackInput(down);
    const up = multiMouse(h, "up", 0); assert.equal(up.input.clickCount, emitted); h.ackInput(up);
  }
});
test("multi-click button chords break the chain and retain both actual releases", () => {
  const h = multiHarness();
  for (const [action, raw, button] of [["down", 1, 0], ["down", 1, 2], ["up", 1, 2], ["up", 1, 0], ["down", 2, 0]]) {
    const request = multiMouse(h, action, raw, { button });
    assert.equal(request.input.action, action); assert.equal(request.input.clickCount, 1);
    assert.equal(request.input.button, button === 0 ? "left" : "right"); h.ackInput(request);
  }
});
test("multi-click synthetic release cannot clear a real hold, and leaving the frame requests End", () => {
  const h = multiHarness(), down = multiMouse(h, "down");
  multiMouse(h, "up", 1, { isTrusted: false }); h.ackInput(down);
  assert.equal(h.socket.sent.at(-1), down);
  h.event("frame", "mouseleave", { isTrusted: false });
  assert.equal(h.socket.sent.at(-1), down);
  h.event("frame", "mouseleave", { isTrusted: true });
  assert.equal(h.socket.sent.at(-1).operation, "humanEnd");
  const end = h.socket.sent.at(-1);
  multiMouse(h, "up"); h.ackInput(down);
  assert.equal(h.socket.sent.at(-1), end);
});
test("multi-click held move outside the image ends control without forwarding an outside input", () => {
  const h = multiHarness(); multiMouse(h, "down");
  multiMouse(h, "move", 0, { clientX: -10, target: h.element("control") });
  assert.equal(h.socket.sent.at(-1).operation, "humanEnd");
  assert.equal(h.socket.sent.filter(value => value.operation === "humanInput").length, 1);
});
test("multi-click mouse cancellation releases the real hold but a late legacy capture notification does not", () => {
  const h = multiHarness(), down = multiMouse(h, "down");
  h.event("frame", "lostpointercapture", { isTrusted: true });
  h.event("frame", "pointercancel", { isTrusted: false });
  assert.equal(h.socket.sent.at(-1), down);
  h.event("frame", "pointercancel", { isTrusted: true });
  assert.equal(h.socket.sent.at(-1).operation, "humanEnd");
});
test("multi-click dialog hit-test changes preserve the real held release at the unchanged point", () => {
  const h = multiHarness();
  h.ackInput(multiMouse(h, "down")); h.ackInput(multiMouse(h, "up"));
  const down = multiMouse(h, "down", 2);
  showDialog(h);
  h.event("frame", "mouseleave", { ...mouse(), isTrusted: true });
  assert.equal(h.socket.sent.at(-1), down);
  multiMouse(h, "up", 2, { target: h.element("page-dialog") });
  h.ackInput(down, h.humanState({ eventSequence: 20003, pendingDialog: dialog() }));
  assert.equal(h.socket.sent.at(-1), down);
  h.element("dialog-cancel").click();
  const response = h.socket.sent.at(-1);
  h.respond(response.id, { ...h.humanState({ eventSequence: 20004, pendingDialog: null }),
    dialogReceipt: { leaseId: "lease-a", generation: 1, dialogId: "original-dialog", acknowledged: true } });
  const up = h.socket.sent.at(-1);
  assert.equal(up.operation, "humanInput"); assert.equal(up.input.action, "up"); assert.equal(up.input.clickCount, 2);
  h.ackInput(up, h.humanState({ eventSequence: 20005, pendingDialog: null }));
  const next = multiMouse(h, "down", 3);
  assert.equal(next.input.clickCount, 1);
});
test("multi-click touch or pen retirement prevents later compatibility mouse input", () => {
  for (const pointerType of ["touch", "pen"]) {
    const h = multiHarness();
    const event = h.event("frame", "pointerdown", mouse({ pointerType, isTrusted: true }));
    assert.equal(event.prevented, true); assert.equal(h.socket.sent.at(-1).operation, "humanEnd");
    multiMouse(h, "down");
    assert.equal(h.socket.sent.some(value => value.operation === "humanInput"), false);
  }
});
test("multi-click navigation drops the old chain and cannot reuse its pending releases", () => {
  const h = multiHarness();
  h.ackInput(multiMouse(h, "down")); h.ackInput(multiMouse(h, "up"));
  const next = { ...h.humanState().human, generation: 2 };
  h.socket.message({ type: "state", ...h.humanState({ eventSequence: 20010, human: { ...next, state: "navigating", viewport: null } }) });
  multiMouse(h, "up", 2);
  h.socket.message({ type: "state", ...h.humanState({ eventSequence: 20011, human: next }) });
  h.humanFrame(2, { generation: 2, eventSequence: 20012 }); h.images.at(-1).onload();
  const request = multiMouse(h, "down", 2);
  assert.equal(request.generation, 2); assert.equal(request.sequence, 1); assert.equal(request.input.clickCount, 1);
});
const key = (extra = {}) => ({ key: "Shift", code: "ShiftLeft", keyCode: 16, shiftKey: true, ...extra });

const dialog = (extra = {}) => ({ leaseId: "lease-a", generation: 1, dialogId: "original-dialog", type: "prompt", message: "<img onerror=bad>\n原网页消息", defaultPrompt: "原值", ...extra });
function showDialog(h, value = dialog(), eventSequence = 20002) {
  h.socket.message({ type: "state", ...h.humanState({ eventSequence, pendingDialog: value }) });
}
function dialogReply(h, request, extra = {}) {
  h.respond(request.id, h.humanState({ eventSequence: 20004, pendingDialog: null,
    dialogReceipt: { leaseId: request.leaseId, generation: request.generation, dialogId: request.dialogId, acknowledged: true }, ...extra }));
}

test("beforeunload exposes explicit Stay and Leave decisions without prompt text or input ACK", () => {
  for (const [button, accept] of [["dialog-cancel", false], ["dialog-accept", true]]) {
    const h = setup(); h.readyHuman();
    h.event("human-input", "beforeinput", { inputType: "insertText", data: "original-trigger" });
    const input = h.socket.sent.at(-1);
    const original = dialog({ type: "beforeunload", message: "", defaultPrompt: undefined });
    showDialog(h, original);
    assert.equal(h.element("dialog-title").textContent, "离开此页面？");
    assert.equal(h.element("dialog-cancel").textContent, "留在页面");
    assert.equal(h.element("dialog-accept").textContent, "离开页面");
    assert.match(h.element("dialog-status").textContent, /未保存的更改可能丢失/);
    assert.equal(h.element("dialog-prompt-label").hidden, true);
    assert.equal(h.element("dialog-cancel").hidden, false);
    h.element("dialog-prompt").value = "never send leftover prompt";
    h.element(button).click(); const answer = h.socket.sent.at(-1);
    assert.deepEqual(answer, { id: answer.id, operation: "humanDialogRespond", leaseId: "lease-a", generation: 1, dialogId: "original-dialog", accept });
    showDialog(h, original, 20003);
    h.element(button).click();
    assert.equal(h.socket.sent.filter(x => x.operation === "humanDialogRespond").length, 1);
    dialogReply(h, answer);
    assert.equal(h.element("human-input").dataset.pending, "1");
    assert.equal(h.element("human-input").dataset.acknowledgedSequence, "0");
    h.ackInput(input, { eventSequence: 20005, pendingDialog: null });
    assert.equal(h.element("human-input").dataset.acknowledgedSequence, "1");
    assert.equal(h.socket.sent.some(x => x.operation === "humanEnd" || x.operation === "resume"), false);
  }
});

test("beforeunload labels do not leak into later alert confirm or prompt dialogs", () => {
  const h = setup(); h.readyHuman();
  for (const [index, type] of ["beforeunload", "alert", "beforeunload", "confirm", "beforeunload", "prompt"].entries()) {
    showDialog(h, dialog({ type, dialogId: `dialog-${index}`, defaultPrompt: type === "prompt" ? "new prompt" : undefined }), 20002 + index);
    const leaving = type === "beforeunload";
    assert.equal(h.element("dialog-cancel").textContent, leaving ? "留在页面" : "取消");
    assert.equal(h.element("dialog-accept").textContent, leaving ? "离开页面" : "确定");
    assert.equal(h.element("dialog-cancel").hidden, type === "alert");
    assert.equal(h.element("dialog-prompt-label").hidden, type !== "prompt");
    if (!leaving) assert.doesNotMatch(h.element("dialog-status").textContent, /未保存的更改/);
  }
  assert.equal(h.element("dialog-prompt").value, "new prompt");
});

test("beforeunload during navigation authorizes only the current decision without a new frame", () => {
  const h = setup(1); h.readyHuman();
  const next = generationState(h, 2, "navigating");
  next.pendingDialog = dialog({ type: "beforeunload", generation: 2, defaultPrompt: undefined });
  h.socket.message({ type: "state", ...next });
  assert.equal(h.element("human-input").dataset.enabled, "false");
  h.element("dialog-cancel").click(); const answer = h.socket.sent.at(-1);
  assert.equal(answer.operation, "humanDialogRespond"); assert.equal(answer.generation, 2); assert.equal(answer.accept, false);
  h.respond(answer.id, { ...next, eventSequence: next.eventSequence + 1, pendingDialog: null,
    dialogReceipt: { leaseId: "lease-a", generation: 2, dialogId: answer.dialogId, acknowledged: true } });
  assert.equal(h.element("human-input").dataset.enabled, "false", "decision ACK is not a recovered document frame");
  assert.equal(h.socket.sent.some(x => x.operation === "humanInput" || x.operation === "resume"), false);
});

test("beforeunload End Stop and disconnect revoke decisions and never replay a late ACK", () => {
  for (const action of ["human-end", "stop", "disconnect"]) {
    const h = setup(); h.readyHuman();
    showDialog(h, dialog({ type: "beforeunload", defaultPrompt: undefined }));
    h.element("dialog-cancel").click(); const answer = h.socket.sent.at(-1);
    assert.equal(answer.operation, "humanDialogRespond");
    if (action === "disconnect") h.socket.close(); else h.element(action).click();
    dialogReply(h, answer);
    h.element("dialog-accept").click();
    assert.equal(h.socket.sent.filter(x => x.operation === "humanDialogRespond").length, 1);
    assert.equal(h.element("human-input").dataset.enabled, "false");
    assert.equal(h.socket.sent.some(x => x.operation === "resume"), false);
  }
});

test("dialog source is separate plain text from page messages and absent legacy metadata", () => {
  for (const source of [undefined, { origin: "https://child.example:8443", frame: "child" }, { origin: "https://xn--bcher-kva.example", frame: "top-level" }]) {
    const h = setup(); h.readyHuman();
    const message = "来源：https://pretend.example <img onerror=bad>";
    showDialog(h, dialog({ message, ...(source ? { source } : {}) }));
    assert.equal(h.element("dialog-source").textContent, source ? `来源：${source.frame === "child" ? "子页面" : "主页面"} · ${source.origin}` : "来源未提供");
    assert.equal(h.element("dialog-message").textContent, message);
    assert.equal(h.element("dialog-source").innerHTML, undefined);
    h.element("dialog-accept").click();
    const answer = h.socket.sent.at(-1);
    assert.equal(answer.operation, "humanDialogRespond");
    assert.equal(Object.hasOwn(answer, "source"), false);
  }
});

test("dialog source rejects malformed or noncanonical origin metadata before any choice", () => {
  const invalid = [null, {}, { origin: "https://site.test" }, { origin: "https://site.test", frame: "other" },
    { origin: "https://site.test", frame: "child", url: "https://other.test" },
    ...["null", "data:text/plain,x", "https://user@site.test", "https://site.test/", "https://site.test?", "https://site.test#", "HTTPS://site.test", "https://SITE.test", "https://site.test:443", "https://site.test:", "https://site.test:0444", "https://bücher.test", "https://site.test\n", "https://" + "a".repeat(2048)].map(origin => ({ origin, frame: "child" }))];
  for (const source of invalid) {
    const h = setup(); h.readyHuman(); showDialog(h, dialog({ source }));
    h.element("dialog-accept").click();
    assert.equal(h.socket.sent.some(value => value.operation === "humanDialogRespond"), false, JSON.stringify(source));
    assert.equal(h.element("human-input").dataset.enabled, "false");
  }
});

test("dialog source is pinned including absence without resetting the original choice", () => {
  const original = { origin: "https://child.test", frame: "child" };
  for (const [before, after] of [[original, { ...original, origin: "https://other.test" }], [original, { ...original, frame: "top-level" }], [undefined, original], [original, undefined]]) {
    const h = setup(); h.readyHuman();
    showDialog(h, dialog(before ? { source: before } : {}));
    h.element("dialog-prompt").value = "original answer";
    showDialog(h, dialog(after ? { source: after } : {}), 20003);
    h.element("dialog-accept").click();
    assert.equal(h.socket.sent.some(value => value.operation === "humanDialogRespond"), false);
    assert.equal(h.element("dialog-source").textContent, "");
  }
});

test("dialog source ignores old state and keeps duplicate metadata from resetting edits or claims", () => {
  const h = setup(); h.readyHuman(); const source = { origin: "http://[::1]:8080", frame: "child" };
  showDialog(h, dialog({ source }), 20005);
  h.element("dialog-prompt").value = "edited";
  showDialog(h, dialog({ source: { origin: "https://old.test", frame: "child" } }), 20004);
  showDialog(h, dialog({ source }), 20006);
  assert.equal(h.element("dialog-source").textContent, "来源：子页面 · http://[::1]:8080");
  assert.equal(h.element("dialog-prompt").value, "edited");
  h.element("dialog-accept").click();
  showDialog(h, dialog({ source }), 20007); h.element("dialog-accept").click();
  assert.equal(h.socket.sent.filter(value => value.operation === "humanDialogRespond").length, 1);
  h.element("human-end").click();
  assert.equal(h.element("dialog-source").textContent, "");
});

test("negotiated human input has one bounded outer wait; modal states do not reset it", () => {
  for (const version of [undefined, 1]) {
    const h = setup(version); h.readyHuman();
    const human = { ...h.humanState().human, ...(version ? { inputBudgetVersion: version } : {}) };
    h.socket.message({ type: "state", ...h.humanState({ eventSequence: 20002, human }) });
    h.event("human-input", "beforeinput", { inputType: "insertText", data: "trigger" });
    const input = h.socket.sent.at(-1), originalTimer = [...h.timers.keys()].at(-1);
    assert.equal(h.timerDelays.get(originalTimer), version ? 340000 : 35000);
    for (const [index, dialogId] of ["original", "original", "successor"].entries()) {
      h.socket.message({ type: "state", ...h.humanState({ eventSequence: 20003 + index, human, pendingDialog: dialog({ dialogId }) }) });
      assert.equal([...h.timers.keys()].at(-1), originalTimer);
      assert.equal(h.timerDelays.get(originalTimer), version ? 340000 : 35000);
      assert.equal(h.element("human-input").dataset.acknowledgedSequence, "0");
    }
    assert.match(h.element("dialog-status").textContent, version ? /5 分钟.*共用/ : /30 秒/);
    h.element("dialog-accept").click();
    assert.equal([...h.timerDelays.values()].at(-1), 35000, "native decision keeps its ordinary acknowledgement deadline");
    assert.equal(h.socket.sent.filter(value => value.operation === "humanInput").length, 1);
    h.timers.get(originalTimer)();
    assert.equal(h.socket.sent.at(-1).operation, "humanEnd");
    assert.equal([...h.timerDelays.values()].at(-1), 35000);
    assert.equal(h.element("human-input").dataset.acknowledgedSequence, "0");
    assert.equal(h.socket.sent.filter(value => value.id === input.id).length, 1);
    assert.equal(h.socket.sent.some(value => value.operation === "resume"), false);
  }
});

test("unknown or read-only budget claims grant no input waiting authority", () => {
  for (const version of [0, 1, 2, "1", null]) {
    const h = setup(); h.readyHuman();
    const count = h.socket.sent.length;
    h.socket.message({ type: "state", ...h.humanState({ eventSequence: 20002,
      human: { ...h.humanState().human, inputBudgetVersion: version } }) });
    h.event("human-input", "beforeinput", { inputType: "insertText", data: "never" });
    assert.equal(h.socket.sent.slice(count).some(value => value.operation === "humanInput"), false);
    assert.equal([...h.timerDelays.values()].includes(340000), false);
  }
  const h = setup(); readyResult(h);
  h.socket.message({ type: "state", ...h.state(2, "paused", true, { eventSequence: 20002, tabs: [resultTab()], selectedTabId: 1,
    view: viewState({ inputBudgetVersion: 1 }) }) });
  assert.equal(h.element("human-input").dataset.enabled, "false");
  assert.equal([...h.timerDelays.values()].includes(340000), false);
});

test("human dialog decision bypasses pending input while preserving its separate ACK", () => {
  const h = setup(); h.readyHuman();
  h.event("human-input", "beforeinput", { inputType: "insertText", data: "original-trigger" });
  const input = h.socket.sent.at(-1);
  showDialog(h);
  assert.equal(h.element("dialog-message").textContent, dialog().message);
  assert.equal(h.element("page-dialog").hidden, false);
  assert.equal(h.element("human-input").dataset.enabled, "false");
  assert.equal(h.element("dialog-accept").disabled, false);
  assert.equal(h.element("stop").disabled, false);
  h.element("dialog-prompt").focus(); // Local focus transfer is not lease loss.
  h.element("dialog-prompt").value = "人工输入 中文π 😀";
  h.element("dialog-accept").click();
  const response = h.socket.sent.at(-1);
  assert.deepEqual(response, { id: 5, operation: "humanDialogRespond", leaseId: "lease-a", generation: 1, dialogId: "original-dialog", accept: true, promptText: "人工输入 中文π 😀" });
  assert.equal(h.socket.sent.filter(value => value.operation === "humanEnd").length, 0);
  assert.equal(h.element("human-input").dataset.acknowledgedSequence, "0");
  dialogReply(h, response);
  assert.equal(h.element("human-input").dataset.pending, "1");
  assert.equal(h.element("human-input").dataset.acknowledgedSequence, "0");
  h.ackInput(input, { eventSequence: 20005, pendingDialog: null });
  assert.equal(h.element("human-input").dataset.acknowledgedSequence, "1");
  assert.equal(h.element("human-input").dataset.pending, "0");
  assert.equal(h.socket.sent.some(value => value.operation === "resume"), false);
});

test("same dialog state does not reset an edited prompt or allow duplicate decisions", () => {
  const h = setup(); h.readyHuman(); showDialog(h);
  h.element("dialog-prompt").value = "用户编辑";
  showDialog(h, dialog(), 20003);
  assert.equal(h.element("dialog-prompt").value, "用户编辑");
  h.element("dialog-accept").click();
  showDialog(h, dialog(), 20004);
  h.element("dialog-accept").click(); h.element("dialog-cancel").click();
  assert.equal(h.socket.sent.filter(value => value.operation === "humanDialogRespond").length, 1);
  assert.equal(h.element("dialog-accept").disabled, true);
});

test("a dialog opened by held pointer or key preserves the real release behind original ACK", () => {
  for (const kind of ["pointer", "key"]) {
    const h = setup(); h.readyHuman();
    if (kind === "pointer") h.event("frame", "pointerdown", mouse());
    else h.event("human-input", "keydown", key());
    const down = h.socket.sent.at(-1);
    showDialog(h);
    if (kind === "pointer") h.event("frame", "pointerup", mouse());
    else {
      assert.equal(h.element("human-input").disabled, true);
      h.element("dialog-prompt").focus();
      h.windowEvents.keyup({ ...key({ shiftKey: false }), preventDefault() {} });
      // A bubbled duplicate from the original textarea cannot enqueue twice.
      h.event("human-input", "keyup", key({ shiftKey: false }));
    }
    assert.equal(h.socket.sent.at(-1).id, down.id);
    assert.equal(h.element("human-input").dataset.pending, "2");
    assert.equal(h.socket.sent.some(row => row.operation === "humanEnd"), false);
    h.element("dialog-accept").click(); const decision = h.socket.sent.at(-1);
    // No original release may overtake the pending down ACK, even after Closed.
    dialogReply(h, decision);
    assert.equal(h.socket.sent.at(-1).id, decision.id);
    h.ackInput(down, { eventSequence: 20005, pendingDialog: null });
    const up = h.socket.sent.at(-1);
    assert.equal(up.operation, "humanInput"); assert.equal(up.input.type, kind);
    assert.equal(up.input.action, "up"); assert.equal(up.sequence, down.sequence + 1);
    h.ackInput(up, { eventSequence: 20006, pendingDialog: null });
    if (kind === "pointer") h.event("frame", "pointerdown", mouse());
    else h.event("human-input", "keydown", key());
    assert.equal(h.socket.sent.at(-1).input.action, "down");
    assert.equal(h.socket.sent.at(-1).sequence, up.sequence + 1);
  }
});

test("modal blocks new input and an out-of-frame held release ends control instead of guessing coordinates", () => {
  const h = setup(); h.readyHuman(); h.event("frame", "pointerdown", mouse()); showDialog(h);
  const before = h.socket.sent.length;
  h.event("frame", "pointerdown", mouse({ button: 2 }));
  h.event("human-input", "keydown", key());
  h.event("human-input", "beforeinput", { inputType: "insertText", data: "not-sent" });
  assert.equal(h.socket.sent.length, before);
  h.event("frame", "pointerup", mouse({ clientX: -10 }));
  assert.equal(h.socket.sent.at(-1).operation, "humanEnd");
});

test("successor dialog can be answered before old ACK without borrowing its prompt or choice", () => {
  const h = setup(); h.readyHuman(); showDialog(h);
  h.element("dialog-accept").click(); const first = h.socket.sent.at(-1);
  const successor = dialog({ dialogId: "successor", defaultPrompt: "新值" });
  showDialog(h, successor, 20004);
  assert.equal(h.element("dialog-prompt").value, "新值");
  assert.equal(h.element("dialog-cancel").disabled, false);
  h.element("dialog-cancel").click(); const second = h.socket.sent.at(-1);
  assert.equal(second.accept, false); assert.equal(second.promptText, undefined);
  dialogReply(h, first, { eventSequence: 20003 });
  assert.equal(h.element("page-dialog").dataset.dialogId, "successor");
  assert.equal(h.element("dialog-accept").disabled, true);
  dialogReply(h, second, { eventSequence: 20005 });
  assert.equal(h.element("page-dialog").hidden, true);
  showDialog(h, dialog(), 20002);
  assert.equal(h.element("page-dialog").hidden, true);
});

test("dialog replies require their exact independent receipt and never retry unknown results", () => {
  for (const mode of ["missing", "wrong", "error", "timeout"]) {
    const h = setup(); h.readyHuman(); showDialog(h); h.element("dialog-accept").click();
    const request = h.socket.sent.at(-1);
    if (mode === "timeout") [...h.timers.values()].at(-1)();
    else if (mode === "error") h.socket.message({ type: "response", id: request.id, error: { code: "OPERATION_UNCONFIRMED" } });
    else dialogReply(h, request, { dialogReceipt: mode === "missing" ? undefined : { leaseId: request.leaseId, generation: 1, dialogId: "other", acknowledged: true } });
    assert.equal(h.socket.sent.filter(value => value.operation === "humanDialogRespond").length, 1);
    assert.equal(h.socket.sent.at(-1).operation, "humanEnd");
    assert.equal(h.element("human-input").dataset.enabled, "false");
    assert.equal(h.element("dialog-accept").disabled, true);
  }
});

test("definite unsent stale dialog rejection refreshes state without ending its successor", () => {
  const h = setup(); h.readyHuman(); showDialog(h); h.element("dialog-accept").click();
  const first = h.socket.sent.at(-1);
  showDialog(h, dialog({ dialogId: "next" }), 20004);
  h.socket.message({ type: "response", id: first.id, error: { code: "HUMAN_DIALOG_STALE" } });
  assert.equal(h.socket.sent.at(-1).operation, "status");
  assert.equal(h.socket.sent.some(row => row.operation === "humanEnd"), false);
  assert.equal(h.element("dialog-accept").disabled, false);
  assert.equal(h.element("page-dialog").dataset.dialogId, "next");
  assert.equal(h.socket.sent.filter(row => row.operation === "humanDialogRespond").length, 1);
});

test("invalid or foreign dialog state grants no decision; read-only view cannot answer", () => {
  for (const extra of [{ leaseId: "foreign" }, { generation: 2 }, { type: "beforeunload" }, { message: "\ud800" }, { message: "界".repeat(2731) }, { dialogId: "" }]) {
    const h = setup(); h.readyHuman(); showDialog(h, dialog(extra)); h.element("dialog-accept").click();
    assert.equal(h.socket.sent.some(value => value.operation === "humanDialogRespond"), false);
    assert.equal(h.element("human-input").dataset.enabled, "false");
  }
  const h = setup(); readyResult(h);
  h.socket.message({ type: "state", ...h.state(2, "paused", true, { eventSequence: 20002, tabs: [resultTab()], view: viewState(), pendingDialog: dialog() }) });
  h.element("dialog-accept").click();
  assert.equal(h.socket.sent.some(value => value.operation === "humanDialogRespond"), false);
});

test("dialog prompt rejects malformed or oversized UTF-8 but supports empty and cancellation", () => {
  const h = setup(); h.readyHuman(); showDialog(h);
  for (const value of ["\ud800", "界".repeat(2731)]) {
    h.element("dialog-prompt").value = value; h.element("dialog-accept").click();
    assert.equal(h.socket.sent.some(row => row.operation === "humanDialogRespond"), false);
  }
  h.element("dialog-prompt").value = ""; h.element("dialog-accept").click();
  assert.equal(h.socket.sent.at(-1).promptText, "");
  const cancel = setup(); cancel.readyHuman(); showDialog(cancel);
  cancel.element("dialog-prompt").value = "\ud800"; cancel.element("dialog-cancel").click();
  assert.equal(cancel.socket.sent.at(-1).accept, false);
  assert.equal(cancel.socket.sent.at(-1).promptText, undefined);
});

test("dialog controls stay independent of fresh image decode and are revoked by End or Stop", () => {
  for (const action of ["human-end", "stop", "disconnect"]) {
    const h = setup(); h.readyHuman(); showDialog(h, dialog({ type: "alert", defaultPrompt: undefined }));
    assert.equal(h.element("dialog-prompt-label").hidden, true);
    assert.equal(h.element("dialog-cancel").hidden, true);
    if (action === "disconnect") h.socket.close(); else h.element(action).click();
    h.element("dialog-accept").click();
    assert.equal(h.socket.sent.some(row => row.operation === "humanDialogRespond"), false);
    assert.equal(h.element("page-dialog").hidden, true);
  }
});

test("human input requires a real decode of the matching lease and generation", () => {
  const h = setup(); h.beginHuman();
  assert.equal(h.element("human-input").dataset.enabled, "false");
  h.event("frame", "pointerdown", mouse());
  assert.equal(h.socket.sent.at(-1).operation, "humanBegin");
  h.humanFrame(1, { humanLeaseId: "retired-lease" });
  h.humanFrame(1, { generation: 2 });
  assert.equal(h.images.length, 0);
  h.humanFrame();
  assert.equal(h.element("human-input").dataset.enabled, "false");
  h.images[0].onload();
  assert.equal(h.element("human-input").dataset.enabled, "true");
  assert.equal(h.element("frame").dataset.controlMode, "human");
  assert.equal(h.element("control").disabled, true);
  assert.equal(h.element("watch").disabled, true);
  h.event("frame", "pointerdown", mouse());
  assert.deepEqual(h.socket.sent.at(-1), { id: 4, operation: "humanInput", leaseId: "lease-a", generation: 1, sequence: 1, input: { type: "pointer", action: "down", x: 640, y: 360, button: "left", modifiers: 0 } });
});

test("input coordinates use actual image content and reject letterboxing", () => {
  const h = setup(); h.readyHuman();
  h.element("frame").rect = { left: 10, top: 20, width: 640, height: 640 };
  h.event("frame", "pointerdown", mouse({ clientY: 40 }));
  assert.equal(h.socket.sent.at(-1).operation, "humanBegin");
  h.event("frame", "pointerdown", mouse({ clientY: 340 }));
  assert.equal(h.socket.sent.at(-1).input.x, 640);
  assert.equal(h.socket.sent.at(-1).input.y, 360);
  h.event("frame", "pointermove", mouse({ clientY: 10 }));
  assert.equal(h.socket.sent.at(-1).operation, "humanEnd");
  assert.equal(h.element("human-input").dataset.enabled, "false");
});

test("one in-flight input waits for exact receipt; only adjacent unsent moves coalesce", () => {
  const h = setup(); h.readyHuman();
  h.event("frame", "pointerdown", mouse());
  const first = h.socket.sent.at(-1);
  for (let x = 340; x < 380; x++) h.event("frame", "pointermove", mouse({ clientX: x }));
  h.event("frame", "pointerup", mouse({ clientX: 380 }));
  assert.equal(h.socket.sent.at(-1), first);
  assert.equal(h.element("human-input").dataset.pending, "3");
  h.ackInput(first);
  const move = h.socket.sent.at(-1);
  assert.equal(move.sequence, 2);
  assert.equal(move.input.action, "move");
  assert.equal(move.input.x, 738);
  h.ackInput(move);
  const up = h.socket.sent.at(-1);
  assert.equal(up.sequence, 3);
  assert.equal(up.input.action, "up");
  h.ackInput(up);
  assert.equal(h.element("human-input").dataset.pending, "0");
  assert.equal(h.element("human-input").dataset.acknowledgedSequence, "3");
});

test("ending synchronously blocks admission and does not wait in the input queue", () => {
  const h = setup(); h.readyHuman();
  h.event("frame", "pointerdown", mouse());
  const original = h.socket.sent.at(-1);
  h.event("frame", "pointerup", mouse());
  h.element("human-end").click();
  const end = h.socket.sent.at(-1);
  assert.equal(end.operation, "humanEnd");
  assert.equal(h.element("human-input").dataset.enabled, "false");
  h.ackInput(original);
  assert.equal(h.socket.sent.at(-1), end);
  h.respond(end.id, { ...h.state(2, "paused", true, { eventSequence: 20010, retiredSequence: 20010 }), human: null, humanCleanup: { leaseId: "lease-a", cleanupConfirmed: true } });
  assert.equal(h.element("control").textContent, "继续操作");
  assert.equal(h.element("control").disabled, false);
  assert.equal(h.socket.sent.some(command => command.operation === "resume"), false);
  h.humanFrame(3, { eventSequence: 20011 });
  assert.equal(h.images.length, 1);
});

test("blur releases held input exactly once while native input is still pending", () => {
  const h = setup(); h.readyHuman();
  h.event("frame", "pointerdown", mouse());
  h.event("human-input", "keydown", key());
  h.event("human-input", "blur");
  h.windowEvents.blur();
  assert.equal(h.socket.sent.filter(command => command.operation === "humanEnd").length, 1);
  assert.equal(h.element("human-input").dataset.enabled, "false");
  assert.equal(h.element("human-input").dataset.pending, "1");
});

test("plain text, committed composition and shortcut key transitions have distinct paths", () => {
  const h = setup(); h.readyHuman();
  h.event("human-input", "keydown", key({ key: "a", code: "KeyA", keyCode: 65, shiftKey: false }));
  h.event("human-input", "beforeinput", { inputType: "insertText", data: "a", isComposing: false });
  const text = h.socket.sent.at(-1);
  assert.deepEqual(text.input, { type: "text", text: "a" });
  h.event("human-input", "keyup", key({ key: "a", code: "KeyA", keyCode: 65, shiftKey: false }));
  h.ackInput(text);
  h.event("human-input", "compositionstart");
  h.event("human-input", "beforeinput", { inputType: "insertCompositionText", data: "中文", isComposing: true });
  h.event("human-input", "compositionend", { data: "中文" });
  const composed = h.socket.sent.at(-1);
  assert.deepEqual(composed.input, { type: "text", text: "中文" });
  h.event("human-input", "beforeinput", { inputType: "insertFromComposition", data: "中文", isComposing: false });
  h.ackInput(composed);
  h.event("human-input", "keydown", key({ key: "a", code: "KeyA", keyCode: 65, ctrlKey: true, shiftKey: false }));
  const down = h.socket.sent.at(-1);
  assert.equal(down.input.type, "key");
  assert.equal(down.input.action, "down");
  h.event("human-input", "keyup", key({ key: "a", code: "KeyA", keyCode: 65, ctrlKey: false, shiftKey: false }));
  h.ackInput(down);
  assert.equal(h.socket.sent.at(-1).input.action, "up");
  assert.equal(h.socket.sent.filter(command => command.input?.type === "text").length, 2);
});

function imeClick(h, position = {}) {
  h.event("frame", "pointerdown", mouse(position)); h.ackInput();
  h.event("frame", "pointerup", mouse(position)); h.ackInput();
}
function imePreedit(h, text = "尚未确认") {
  h.event("human-input", "compositionstart");
  h.element("human-input").value = text;
  h.event("human-input", "beforeinput", { inputType: "insertCompositionText", data: text, isComposing: true });
}

test("local preedit is visible only during its original composition and identical commits stay distinct", () => {
  const h = setup(); h.readyHuman(); imeClick(h);
  const input = h.element("human-input"), first = h.socket.sent.length;
  for (let i = 0; i < 2; i++) {
    imePreedit(h, "中文😀");
    assert.equal(input.dataset.composing, "true"); assert.equal(input.value, "中文😀");
    assert.equal(h.socket.sent.length, first + i);
    assert.equal(h.element("human-status").textContent.includes("中文😀"), false);
    h.event("human-input", "compositionend", { data: "中文😀" });
    assert.equal(input.dataset.composing, "false"); assert.equal(input.value, "");
    assert.deepEqual(h.socket.sent.at(-1).input, { type: "text", text: "中文😀" }); h.ackInput();
  }
  const commits = h.socket.sent.filter(command => command.input?.type === "text");
  assert.equal(commits.length, 2); assert.notEqual(commits[0].id, commits[1].id);
  imePreedit(h); h.event("human-input", "compositionend", { data: "" });
  assert.equal(input.dataset.composing, "false"); assert.equal(h.socket.sent.length, first + 2);
});

for (const modal of ["dialog", "chooser"]) test(`${modal} retires same-generation preedit before disable and cannot revive a late commit`, () => {
  const h = setup(undefined, undefined, { fileChooserVersion: 1 }); h.readyHuman(); imeClick(h); imePreedit(h);
  const input = h.element("human-input"); let disabled = false;
  Object.defineProperty(input, "disabled", { get: () => disabled, set(value) {
    disabled = value;
    if (value) h.event("human-input", "compositionend", { data: "结束时旧字" });
  } });
  const field = modal === "dialog" ? "pendingDialog" : "pendingFileChooser";
  const pending = modal === "dialog" ? dialog() : { leaseId: "lease-a", generation: 1, chooserId: "ime-chooser", multiple: false };
  h.socket.message({ type: "state", ...h.humanState({ eventSequence: 20002, [field]: pending }) });
  assert.equal(input.dataset.composing, "false"); assert.equal(input.value, ""); assert.equal(disabled, true);
  h.socket.message({ type: "state", ...h.humanState({ eventSequence: 20003, [field]: null }) });
  h.event("human-input", "compositionend", { data: "迟到旧字" });
  assert.equal(h.socket.sent.some(command => command.input?.type === "text"), false);
  imePreedit(h, "新字"); h.event("human-input", "compositionend", { data: "新字" });
  assert.deepEqual(h.socket.sent.at(-1).input, { type: "text", text: "新字" });
});

for (const id of ["human-end", "human-switch", "stop"]) test(`${id} preserves input focus on down and fences later compositionend on click`, () => {
  const h = setup(undefined, undefined, { pageSelectionVersion: 1 }); h.readyHuman(); imeClick(h); imePreedit(h);
  assert.equal(h.event(id, "mousedown").prevented, true);
  assert.equal(h.element("human-input").dataset.composing, "true", "down alone is not the explicit End or Stop");
  h.element(id).click();
  assert.equal(h.element("human-input").dataset.composing, "false");
  assert.equal(h.element("human-input").value, "");
  h.event("human-input", "compositionend", { data: "旧字" });
  assert.equal(h.socket.sent.some(command => command.input?.type === "text"), false);
  assert.equal(h.socket.sent.at(-1).operation, id === "stop" ? "stop" : "humanEnd");
});

test("new frame click cancels old preedit before moving its input anchor", () => {
  const h = setup(); h.readyHuman(); imeClick(h); imePreedit(h);
  h.event("frame", "pointerdown", mouse({ clientX: 150, clientY: 110 }));
  assert.equal(h.element("human-input").value, ""); assert.equal(h.element("human-input").dataset.composing, "false");
  h.event("human-input", "compositionend", { data: "旧字段文字" });
  assert.equal(h.socket.sent.at(-1).input.type, "pointer"); h.ackInput();
  h.event("frame", "pointerup", mouse({ clientX: 150, clientY: 110 })); h.ackInput();
  imePreedit(h, "新字段"); h.event("human-input", "compositionend", { data: "新字段" });
  assert.deepEqual(h.socket.sent.at(-1).input, { type: "text", text: "新字段" });
  assert.equal(h.socket.sent.filter(command => command.input?.type === "text").length, 1);
});

test("trusted multi-click path also retires old preedit before its native mouse down", () => {
  const h = multiHarness(); multiMouse(h, "down"); h.ackInput(); multiMouse(h, "up"); h.ackInput();
  imePreedit(h);
  const down = multiMouse(h, "down", 1, { clientX: 150, clientY: 110 });
  assert.equal(h.element("human-input").dataset.composing, "false");
  assert.equal(h.element("human-input").style.left, "140px");
  h.event("human-input", "compositionend", { data: "旧字" });
  assert.equal(h.socket.sent.at(-1), down); assert.equal(down.input.type, "pointer");
  assert.equal(h.socket.sent.some(command => command.input?.type === "text"), false);
});

test("preedit anchor accounts for letterboxing and resize preserves native text and selection", () => {
  const h = setup(); h.readyHuman();
  h.element("frame").rect = { left: 110, top: 70, width: 400, height: 300 };
  imeClick(h, { clientX: 310, clientY: 220 }); imePreedit(h);
  const input = h.element("human-input"); input.selectionStart = 1; input.selectionEnd = 3;
  assert.deepEqual(input.style, { left: "300px", top: "200px", width: "280px", height: "48px" });
  const count = h.socket.sent.length;
  h.event("frame", "pointerdown", mouse({ clientX: 310, clientY: 80 }));
  assert.equal(h.socket.sent.length, count, "letterbox space is not an admitted click");
  assert.equal(input.dataset.composing, "true");
  h.element("screen").rect = { left: 80, top: 100, width: 500, height: 300 };
  h.element("frame").rect = { left: 100, top: 150, width: 320, height: 180 };
  h.windowEvents.resize();
  assert.deepEqual(input.style, { left: "180px", top: "140px", width: "280px", height: "48px" });
  assert.equal(input.value, "尚未确认"); assert.equal(input.selectionStart, 1); assert.equal(input.selectionEnd, 3);
});

test("preedit clamps to right/bottom edges and a narrow visible screen", () => {
  const h = setup(); h.readyHuman(); imeClick(h, { clientX: 649, clientY: 379 }); imePreedit(h);
  assert.deepEqual(h.element("human-input").style, { left: "352px", top: "304px", width: "280px", height: "48px" });
  h.element("screen").rect = { left: 10, top: 20, width: 180, height: 90 };
  h.element("frame").rect = { left: 10, top: 20, width: 180, height: 90 };
  h.windowEvents.resize();
  assert.deepEqual(h.element("human-input").style, { left: "8px", top: "34px", width: "164px", height: "48px" });
});

test("scroll clamps preedit to the visible viewport intersection without changing input", () => {
  const h = setup(); h.readyHuman(); imeClick(h); imePreedit(h);
  h.setViewport(400, 220);
  h.element("screen").rect = { left: -100, top: -180, width: 640, height: 360 };
  h.element("frame").rect = { left: -100, top: -180, width: 640, height: 360 };
  h.windowEvents.scroll();
  assert.deepEqual(h.element("human-input").style, { left: "212px", top: "188px", width: "280px", height: "48px" });
  assert.equal(h.element("human-input").value, "尚未确认");
});

test("generation retirement clears the old click anchor and preedit", () => {
  const h = setup(); h.readyHuman(); imeClick(h); imePreedit(h);
  h.socket.message({ type: "state", ...generationState(h, 2, "navigating") });
  assert.deepEqual(h.element("human-input").style, { left: "0px", top: "0px", width: "1px", height: "1px" });
  h.event("human-input", "compositionstart");
  assert.equal(h.element("human-input").dataset.composing, "false");
  resumeGeneration(h, 2);
  h.event("human-input", "compositionend", { data: "前页候选" });
  assert.equal(h.socket.sent.some(command => command.input?.type === "text"), false);
  assert.equal(h.element("human-input").style.left, "8px");
});

for (const [name, code] of [["Backspace", 8], ["Delete", 46], ["ArrowLeft", 37], ["ArrowRight", 39], ["Enter", 13]]) test(`native repeat ${name} preserves every real down and the one up in receipt order`, () => {
  const h = setup(undefined, 1); h.readyHuman();
  const event = { key: name, code: name, keyCode: code, shiftKey: false };
  h.event("human-input", "keydown", key(event));
  const first = h.socket.sent.at(-1);
  h.event("human-input", "keydown", key({ ...event, repeat: false }));
  h.event("human-input", "keydown", key({ ...event, repeat: true }));
  h.event("human-input", "keydown", key({ ...event, repeat: true, shiftKey: true }));
  h.event("human-input", "keyup", key(event));
  assert.equal(h.socket.sent.at(-1), first);
  assert.equal(h.element("human-input").dataset.pending, "4");
  for (let sequence = 1; sequence <= 4; sequence++) {
    const request = h.socket.sent.at(-1);
    assert.equal(request.sequence, sequence);
    assert.deepEqual(request.input, { type: "key", action: sequence === 4 ? "up" : "down", key: name,
      code: name, windowsVirtualKeyCode: code, modifiers: sequence === 3 ? 8 : 0, ...([2, 3].includes(sequence) ? { repeat: true } : {}) });
    h.ackInput(request);
  }
  assert.equal(h.socket.sent.filter(row => row.operation === "humanInput").length, 4);
  assert.equal(h.element("human-input").dataset.pending, "0");
  assert.equal(h.element("human-input").dataset.acknowledgedSequence, "4");
});

test("native repeat requires an original held key and the native lease capability", () => {
  for (const version of [undefined, 1]) {
    const h = setup(undefined, version); h.readyHuman();
    const event = { key: "Backspace", code: "Backspace", keyCode: 8, shiftKey: false };
    const initial = h.socket.sent.length;
    h.event("human-input", "keydown", key({ ...event, repeat: true }));
    assert.equal(h.socket.sent.length, initial, "orphan repeat cannot invent a new held key");
    h.event("human-input", "keydown", key(event)); h.ackInput();
    const down = h.socket.sent.at(-1);
    h.event("human-input", "keydown", key({ ...event, repeat: true }));
    if (version === 1) { assert.equal(h.socket.sent.at(-1).input.repeat, true); h.ackInput(); }
    else assert.equal(h.socket.sent.at(-1), down);
    h.event("human-input", "keyup", key(event));
    assert.equal(h.socket.sent.at(-1).input.action, "up"); h.ackInput();
    assert.equal(h.socket.sent.filter(row => row.operation === "humanInput").length, version === 1 ? 3 : 2);
  }
});

test("native repeat printable characters retain only their original committed text path", () => {
  const h = setup(undefined, 1); h.readyHuman();
  for (const repeat of [false, true, true]) {
    const event = h.event("human-input", "keydown", key({ key: "a", code: "KeyA", keyCode: 65, repeat, shiftKey: false }));
    assert.equal(event.prevented, undefined);
    h.event("human-input", "beforeinput", { inputType: "insertText", data: "a" });
    assert.deepEqual(h.socket.sent.at(-1).input, { type: "text", text: "a" }); h.ackInput();
  }
  h.event("human-input", "keyup", key({ key: "a", code: "KeyA", keyCode: 65, shiftKey: false }));
  assert.equal(h.socket.sent.filter(row => row.operation === "humanInput").length, 3);
});

test("native repeat End and blur drop unsent repetitions without replaying an in-flight one", () => {
  for (const ending of ["End", "blur"]) {
    const h = setup(undefined, 1); h.readyHuman();
    const event = { key: "Delete", code: "Delete", keyCode: 46, shiftKey: false };
    h.event("human-input", "keydown", key(event)); h.ackInput();
    h.event("human-input", "keydown", key({ ...event, repeat: true }));
    const repeat = h.socket.sent.at(-1); assert.equal(repeat.input.repeat, true);
    h.event("human-input", "keydown", key({ ...event, repeat: true }));
    if (ending === "End") h.element("human-end").click(); else h.windowEvents.blur();
    const end = h.socket.sent.at(-1); assert.equal(end.operation, "humanEnd");
    h.ackInput(repeat); assert.equal(h.socket.sent.at(-1), end);
    h.event("human-input", "keyup", key(event));
    assert.equal(h.socket.sent.filter(row => row.operation === "humanInput").length, 2);
    assert.equal(h.socket.sent.filter(row => row.operation === "humanEnd").length, 1);
    h.respond(end.id, releaseState(h));
    assert.equal(h.element("human-input").dataset.pending, "0");
  }
});

test("native repeat navigation retires queued repetitions and requires a new original down", () => {
  const h = setup(undefined, 1); h.readyHuman();
  const event = { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37, shiftKey: false };
  h.event("human-input", "keydown", key(event)); h.ackInput();
  h.event("human-input", "keydown", key({ ...event, repeat: true }));
  const repeat = h.socket.sent.at(-1); assert.equal(repeat.input.repeat, true);
  h.event("human-input", "keydown", key({ ...event, repeat: true }));
  const human = { ...h.humanState().human, generation: 2 };
  h.socket.message({ type: "state", ...h.humanState({ eventSequence: 20003, human: { ...human, state: "navigating", viewport: null } }) });
  h.ackInput(repeat);
  h.socket.message({ type: "state", ...h.humanState({ eventSequence: 20004, human }) });
  h.humanFrame(1, { generation: 2, streamId: "successor", eventSequence: 20005 }); h.images.at(-1).onload();
  assert.equal(h.element("human-input").dataset.enabled, "true");
  h.event("human-input", "keydown", key({ ...event, repeat: true }));
  h.event("human-input", "keyup", key(event));
  assert.equal(h.socket.sent.filter(row => row.operation === "humanInput").length, 2);
  h.event("human-input", "keydown", key(event));
  assert.equal(h.socket.sent.at(-1).generation, 2); assert.equal(h.socket.sent.at(-1).sequence, 1);
  assert.equal(h.socket.sent.at(-1).input.repeat, undefined);
});

for (const capability of ["keyRepeatVersion", "pointerClickCountVersion"]) test(`${capability} cannot change on an original lease or a delayed Begin`, () => {
  for (const version of [undefined, 1]) {
    for (const next of [undefined, 0, 1, 2, null, "1"]) {
      if (next === version) continue;
      const h = setup(undefined, capability === "keyRepeatVersion" ? version : undefined, { pointerClickCountVersion: capability === "pointerClickCountVersion" ? version : undefined }); h.readyHuman();
      const human = { ...h.humanState().human }; delete human[capability];
      if (next !== undefined) human[capability] = next;
      h.socket.message({ type: "state", ...h.humanState({ human, eventSequence: 20002 }) });
      assert.equal(h.element("human-input").dataset.enabled, "false");
      assert.equal(h.socket.sent.at(-1).operation, "humanEnd");
    }
    const h = setup(undefined, capability === "keyRepeatVersion" ? version : undefined, { pointerClickCountVersion: capability === "pointerClickCountVersion" ? version : undefined }), { begin, original } = beginPreparing(h);
    h.socket.message({ type: "state", ...original, eventSequence: 20003 });
    const human = { ...original.human }; delete human[capability];
    if (version === undefined) human[capability] = 1;
    h.respond(begin.id, { ...original, human });
    assert.equal(h.element("human-input").dataset.enabled, "false");
    // A rejected Begin never grants the admission required to issue End.
    // The connection becomes unavailable; the UI must not invent a lease ACK.
    assert.equal(h.element("connection").textContent, "控制状态不可用");
    assert.equal(h.socket.sent.some(row => row.operation === "humanInput" || row.operation === "humanEnd"), false);
  }
});

for (const capability of ["keyRepeatVersion", "pointerClickCountVersion"]) test(`${capability} is rejected on a read-only view`, () => {
  const h = setup(); readyResult(h);
  h.socket.message({ type: "state", ...h.state(2, "paused", true, { eventSequence: 20002, tabs: [resultTab()], selectedTabId: 1,
    view: viewState({ [capability]: 1 }) }) });
  assert.equal(h.element("watch").disabled, true);
  assert.equal(h.element("human-input").dataset.enabled, "false");
});

test("native repeat cannot turn an original held key into a remote paste shortcut", () => {
  for (const [held, repeating] of [
    [{ key: "Insert", code: "Insert", keyCode: 45, shiftKey: false }, { key: "Insert", code: "Insert", keyCode: 45, shiftKey: true }],
    [{ key: "v", code: "KeyV", keyCode: 86, altKey: true, shiftKey: false }, { key: "v", code: "KeyV", keyCode: 86, ctrlKey: true, shiftKey: false }],
    [{ key: "v", code: "KeyV", keyCode: 86, altKey: true, shiftKey: false }, { key: "v", code: "KeyV", keyCode: 86, metaKey: true, shiftKey: false }]
  ]) {
    const h = setup(undefined, 1); h.readyHuman();
    h.event("human-input", "keydown", key(held)); h.ackInput();
    const original = h.socket.sent.at(-1);
    const repeat = h.event("human-input", "keydown", key({ ...repeating, repeat: true }));
    assert.equal(repeat.prevented, true, "neither remote nor local paste may run while this original nonmodifier key remains held");
    assert.equal(h.socket.sent.at(-1), original);
    assert.match(h.element("error").textContent, /松开.*粘贴/);
    h.event("human-input", "keyup", key({ ...repeating, repeat: false }));
    assert.equal(h.socket.sent.at(-1).input.action, "up");
    assert.equal(h.socket.sent.at(-1).input.code, held.code); h.ackInput();
    assert.equal(h.socket.sent.filter(row => row.operation === "humanInput").length, 2);
    const normalPaste = h.event("human-input", "keydown", key(repeating));
    assert.equal(normalPaste.prevented, undefined, "released original key restores the normal local paste shortcut");
  }
});

test("local paste shortcuts preserve the browser default without forwarding a paste key", () => {
  for (const shortcut of [
    { key: "v", code: "KeyV", keyCode: 86, ctrlKey: true, shiftKey: false },
    { key: "V", code: "KeyV", keyCode: 86, ctrlKey: true, shiftKey: true },
    { key: "v", code: "KeyV", keyCode: 86, metaKey: true, shiftKey: false },
    { key: "v", code: "Period", keyCode: 86, ctrlKey: true, shiftKey: false },
    { key: "Insert", code: "Insert", keyCode: 45, shiftKey: true },
  ]) {
    const h = setup(); h.readyHuman(); const count = h.socket.sent.length;
    const down = h.event("human-input", "keydown", key(shortcut));
    assert.equal(down.prevented, undefined, "browser must be able to dispatch its original paste");
    h.event("human-input", "keyup", key({ ...shortcut, ctrlKey: false, metaKey: false, shiftKey: false }));
    assert.equal(h.socket.sent.length, count, "paste shortcut must not access the remote clipboard");
  }
});

test("local paste reads plain text once and cannot duplicate it through beforeinput", () => {
  const h = setup(); h.readyHuman(); const reads = [], text = "本地粘贴 🙂\n第二行\t終わり";
  const event = h.event("human-input", "paste", { clipboardData: { getData(type) { reads.push(type); return type === "text/plain" ? text : "<b>wrong</b>"; } } });
  assert.equal(event.prevented, true);
  const sent = h.socket.sent.at(-1); assert.deepEqual(sent.input, { type: "text", text });
  assert.deepEqual(reads, ["text/plain"]);
  h.event("human-input", "beforeinput", { inputType: "insertFromPaste", data: text });
  h.ackInput(sent);
  assert.equal(h.socket.sent.filter(row => row.input?.type === "text").length, 1);
  assert.equal(h.element("human-input").value, "");
});

test("local paste does not inspect clipboard data after End or during composition", () => {
  for (const cause of ["End", "composition"]) {
    const h = setup(); h.readyHuman();
    if (cause === "End") h.element("human-end").click(); else h.event("human-input", "compositionstart");
    const count = h.socket.sent.length;
    const event = h.event("human-input", "paste", { clipboardData: { getData() { throw new Error("unavailable paste data must not be read"); } } });
    assert.equal(event.prevented, true);
    assert.equal(h.socket.sent.length, count);
  }
});

test("local paste keeps repeated text and real modifier transitions in original receipt order", () => {
  for (const held of [
    { key: "Control", code: "ControlLeft", keyCode: 17, ctrlKey: true, shiftKey: false },
    { key: "Meta", code: "MetaLeft", keyCode: 91, metaKey: true, shiftKey: false },
    { key: "Shift", code: "ShiftLeft", keyCode: 16, shiftKey: true },
  ]) {
    const h = setup(); h.readyHuman(); h.event("human-input", "keydown", key(held));
    const down = h.socket.sent.at(-1);
    for (const text of ["第一次\n🙂", "第二次\t終わり"]) h.event("human-input", "paste", { clipboardData: { getData: () => text } });
    h.event("human-input", "keyup", key({ ...held, ctrlKey: false, metaKey: false, shiftKey: false }));
    assert.equal(h.socket.sent.at(-1), down);
    h.ackInput(down); const first = h.socket.sent.at(-1);
    assert.deepEqual(first.input, { type: "text", text: "第一次\n🙂" });
    h.ackInput(first); const second = h.socket.sent.at(-1);
    assert.deepEqual(second.input, { type: "text", text: "第二次\t終わり" });
    h.ackInput(second); const up = h.socket.sent.at(-1);
    assert.equal(up.input.code, held.code); assert.equal(up.input.action, "up");
    h.ackInput(up);
    const commands = h.socket.sent.filter(row => row.operation === "humanInput");
    assert.deepEqual(commands.map(row => row.sequence), [1, 2, 3, 4]);
    assert.ok(commands.every(row => row.leaseId === down.leaseId && row.generation === down.generation));
    assert.equal(h.element("human-input").dataset.pending, "0");
  }
});

test("local paste preserves an older remote key release and honors virtual-key layout", () => {
  const h = setup(); h.readyHuman();
  h.event("human-input", "keydown", key({ key: ".", code: "KeyV", keyCode: 190, ctrlKey: true, shiftKey: false }));
  const down = h.socket.sent.at(-1); assert.equal(down.input.windowsVirtualKeyCode, 190);
  h.event("human-input", "keyup", key({ key: ".", code: "KeyV", keyCode: 190, ctrlKey: true, shiftKey: false }));
  h.ackInput(down);
  const up = h.socket.sent.at(-1); assert.equal(up.input.action, "up");
  assert.equal(up.input.windowsVirtualKeyCode, 190); h.ackInput(up);
  h.event("human-input", "keydown", key({ key: "v", code: "KeyV", keyCode: 86, ctrlKey: true, altKey: true, shiftKey: false }));
  const older = h.socket.sent.at(-1); assert.equal(older.input.action, "down");
  const release = h.event("human-input", "keyup", key({ key: "v", code: "KeyV", keyCode: 86, ctrlKey: true, altKey: false, shiftKey: false }));
  assert.equal(release.prevented, true); h.ackInput(older);
  assert.equal(h.socket.sent.at(-1).input.action, "up");
  assert.equal(h.socket.sent.at(-1).input.windowsVirtualKeyCode, 86);
});

test("local paste modifiers retain their original release during composition", () => {
  const h = setup(); h.readyHuman();
  h.event("human-input", "keydown", key({ key: "Control", code: "ControlLeft", keyCode: 17, ctrlKey: true, shiftKey: false }));
  const down = h.socket.sent.at(-1); h.ackInput(down);
  h.event("human-input", "compositionstart");
  const release = h.event("human-input", "keyup", key({ key: "Control", code: "ControlLeft", keyCode: 17, ctrlKey: false, shiftKey: false, isComposing: true }));
  assert.equal(release.prevented, true);
  const up = h.socket.sent.at(-1); assert.equal(up.input.action, "up");
  assert.equal(up.input.code, "ControlLeft"); h.ackInput(up);
  h.event("human-input", "keydown", key({ key: "Control", code: "ControlLeft", keyCode: 17, ctrlKey: true, isComposing: true }));
  assert.equal(h.socket.sent.at(-1), up, "composition cannot admit a new key hold");
});

test("local paste rejects malformed text without reading rich data or sending replacements", () => {
  for (const text of ["\ud800", "bad\u0000value", "bad\u000bvalue"]) {
    const h = setup(); h.readyHuman(); const count = h.socket.sent.length, reads = [];
    h.event("human-input", "paste", { clipboardData: { getData(type) { reads.push(type); return text; } } });
    assert.equal(h.socket.sent.length, count); assert.deepEqual(reads, ["text/plain"]);
    assert.match(h.element("error").textContent, /未发送/);
  }
});

test("local paste queued before End cannot be sent by a late original key acknowledgment", () => {
  const h = setup(); h.readyHuman();
  h.event("human-input", "keydown", key({ key: "Control", code: "ControlLeft", keyCode: 17, ctrlKey: true, shiftKey: false }));
  const down = h.socket.sent.at(-1);
  h.event("human-input", "paste", { clipboardData: { getData: () => "must not outlive original human" } });
  h.element("human-end").click(); const end = h.socket.sent.at(-1);
  h.ackInput(down);
  assert.equal(h.socket.sent.at(-1), end);
  assert.equal(h.socket.sent.some(row => row.input?.type === "text"), false);
});

test("held Shift, committed uppercase and Shift release keep exact receipt order", () => {
  const h = setup(); h.readyHuman();
  h.event("human-input", "keydown", key());
  const down = h.socket.sent.at(-1);
  h.event("human-input", "keydown", key({ key: "A", code: "KeyA", keyCode: 65 }));
  h.event("human-input", "beforeinput", { inputType: "insertText", data: "A", isComposing: false });
  h.event("human-input", "keyup", key({ key: "A", code: "KeyA", keyCode: 65 }));
  h.event("human-input", "keyup", key({ shiftKey: false }));
  assert.equal(h.socket.sent.at(-1), down);
  assert.equal(h.element("human-input").dataset.pending, "3");
  h.ackInput(down);
  const text = h.socket.sent.at(-1);
  assert.equal(text.sequence, 2); assert.deepEqual(text.input, { type: "text", text: "A" });
  h.ackInput(text);
  const up = h.socket.sent.at(-1);
  assert.equal(up.sequence, 3);
  assert.deepEqual(up.input, { type: "key", action: "up", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, modifiers: 0 });
  h.ackInput(up);
  assert.equal(h.element("human-input").dataset.pending, "0");
  assert.equal(h.element("human-input").dataset.acknowledgedSequence, "3");
  assert.equal(h.socket.sent.filter(command => command.operation === "humanInput").length, 3);
  assert.equal(h.socket.sent.filter(command => command.operation === "humanEnd").length, 0);
});

test("the Go-projected canonical bridge fixture drives human UI without private sequence fields", () => {
  const fixture = JSON.parse(readFileSync(new URL("../testdata/public-human-fixture.json", import.meta.url), "utf8"));
  const h = setup(); h.authenticate();
  const state = name => ({ ...fixture[name], retiredSequence: 0 });
  h.respond(1, state("open")); h.choose(7); h.respond(2, state("select"));
  h.element("human-begin").click();
  h.respond(3, state("humanBegin"));
  assert.equal(h.element("human-input").dataset.enabled, "false");
  assert.equal(fixture.humanBegin.human.viewport, null);
  assert.deepEqual(Object.keys(fixture.humanBegin.human).sort(), ["generation", "leaseId", "state", "tabId", "viewport"]);
  h.socket.message({ type: "state", ...state("humanStatus") });
  h.socket.message({ ...fixture.humanFrame, retiredSequence: 0 });
  assert.equal(h.images.length, 1);
  h.images[0].naturalWidth = h.images[0].naturalHeight = 1;
  h.images[0].onload();
  assert.equal(h.element("human-input").dataset.enabled, "true");
  h.event("human-input", "beforeinput", { inputType: "insertText", data: "A" });
  const input = h.socket.sent.at(-1);
  assert.equal(input.operation, "humanInput"); assert.equal(input.sequence, 1);
  h.respond(input.id, state("humanInput"));
  assert.equal(h.element("human-input").dataset.pending, "0");
  h.element("human-end").click(); h.respond(h.socket.sent.at(-1).id, state("humanEnd"));
  assert.equal(h.element("control").disabled, false);
  h.element("control").click();
  assert.equal(h.socket.sent.at(-1).operation, "resume");
  h.respond(h.socket.sent.at(-1).id, state("humanResume"));
  assert.equal(h.element("state").textContent, "正在运行");
});

test("wheel coordinates and pixel deltas follow the decoded viewport", () => {
  const h = setup(); h.readyHuman();
  const wheel = h.event("frame", "wheel", mouse({ deltaX: 0, deltaY: 3, deltaMode: 1 }));
  assert.equal(wheel.prevented, true);
  assert.deepEqual(h.socket.sent.at(-1).input, { type: "wheel", x: 640, y: 360, deltaX: 0, deltaY: 48, modifiers: 0 });
});

test("committed text uses the same UTF-16 bound as the native human protocol", () => {
  const h = setup(); h.readyHuman();
  h.event("human-input", "beforeinput", { inputType: "insertText", data: "😀".repeat(2049) });
  assert.equal(h.socket.sent.filter(command => command.operation === "humanInput").length, 0);
  assert.equal(h.socket.sent.at(-1).operation, "humanEnd");
  assert.equal(h.element("human-input").dataset.enabled, "false");
});

test("bounded input overflow revokes admission instead of dropping release transitions", () => {
  const h = setup(); h.readyHuman();
  for (let i = 0; i < 34; i++) h.event("human-input", "beforeinput", { inputType: "insertText", data: "a" });
  assert.equal(h.socket.sent.filter(command => command.operation === "humanInput").length, 1);
  assert.equal(h.socket.sent.at(-1).operation, "humanEnd");
  assert.equal(h.element("human-input").dataset.pending, "1");
  assert.equal(h.element("human-input").dataset.enabled, "false");
});

test("wrong original input receipt never drains the next command", () => {
  const h = setup(); h.readyHuman();
  h.event("frame", "pointerdown", mouse());
  const original = h.socket.sent.at(-1);
  h.event("frame", "pointerup", mouse());
  h.ackInput(original, { inputReceipt: { acknowledged: true, leaseId: "lease-a", generation: 1, sequence: 2 } });
  assert.equal(h.socket.sent.filter(command => command.operation === "humanInput").length, 1);
  assert.equal(h.socket.sent.at(-1).operation, "humanEnd");
});

test("late human frame and reply cannot revive control after geometry revocation", () => {
  const h = setup(); h.readyHuman();
  h.humanFrame(2);
  h.socket.message({ type: "state", ...h.humanState({ eventSequence: 20003, human: { ...h.humanState().human, state: "releasing", generation: 2 } }) });
  h.images[1].onload();
  assert.equal(h.element("frame").dataset.frameSequence, "1");
  assert.equal(h.element("human-input").dataset.enabled, "false");
  h.socket.message({ type: "state", ...h.humanState() });
  h.humanFrame(4, { generation: 1 });
  assert.equal(h.images.length, 2);
  assert.equal(h.element("control").disabled, true);
});

test("blur during Begin fences late activation and requests cleanup without input", () => {
  const h = setup(); h.running(); h.choose(); h.respond(2, h.state(1, "running", false, { selectedTabId: 1 }));
  h.element("human-begin").click();
  h.windowEvents.blur();
  h.respond(3, h.humanState());
  assert.equal(h.socket.sent.at(-1).operation, "humanEnd");
  h.humanFrame();
  assert.equal(h.images.length, 0);
  assert.equal(h.element("human-input").dataset.enabled, "false");
});

test("a human frame before Begin receipt waits for matching state and never enables early", () => {
  const h = setup(); h.running(); h.choose(); h.respond(2, h.state(1, "running", false, { selectedTabId: 1 }));
  h.element("human-begin").click();
  h.humanFrame();
  assert.equal(h.images.length, 0);
  h.respond(3, h.humanState());
  assert.equal(h.images.length, 1);
  assert.equal(h.element("human-input").dataset.enabled, "false");
  h.images[0].onload();
  assert.equal(h.element("human-input").dataset.enabled, "true");
});

test("an early human frame survives a pending-Begin paused snapshot without inferred retirement", () => {
  const h = setup(); h.running(); h.choose(); h.respond(2, h.state(1, "running", false, { selectedTabId: 1 }));
  h.element("human-begin").click();
  h.humanFrame();
  h.socket.message({ type: "state", ...h.state(2, "paused", true, { eventSequence: 20002, retiredSequence: 19999, human: null, tabs: [] }) });
  assert.equal(h.images.length, 0);
  assert.equal(h.element("human-input").dataset.enabled, "false");
  h.respond(3, h.humanState({ eventSequence: 20003 }));
  assert.equal(h.images.length, 1);
  h.images[0].onload();
  assert.equal(h.element("human-input").dataset.enabled, "true");
  assert.equal(h.socket.sent.filter(command => command.operation === "humanEnd").length, 0);
});

test("active generation zero waits for the first matching decoded frame and later real generation status", () => {
  const h = setup(); h.running(); h.choose(); h.respond(2, h.state(1, "running", false, { selectedTabId: 1 }));
  h.element("human-begin").click();
  const unready = { ...h.humanState().human, generation: 0, viewport: null };
  h.respond(3, h.humanState({ human: unready }));
  assert.equal(h.element("human-input").dataset.enabled, "false");
  h.humanFrame(2);
  h.humanFrame(1); // An older event cannot replace the single latest slot.
  h.socket.message({ type: "state", ...h.humanState({ eventSequence: 20003, human: unready }) });
  assert.equal(h.images.length, 0);
  h.socket.message({ type: "state", ...h.humanState({ eventSequence: 20004 }) });
  assert.equal(h.images.length, 1);
  assert.equal(h.element("human-input").dataset.enabled, "false");
  h.images[0].onload();
  assert.equal(h.element("human-input").dataset.enabled, "true");
  assert.equal(h.element("frame").dataset.frameSequence, "2");
  assert.equal(h.socket.sent.filter(command => command.operation === "humanEnd").length, 0);
});

test("a failed or retiring human geometry may have null viewport without restoring input", () => {
  const h = setup(); h.readyHuman();
  h.socket.message({ type: "state", ...h.humanState({ eventSequence: 20004, human: { ...h.humanState().human, state: "releasing", generation: 2, viewport: null } }) });
  assert.equal(h.element("human-input").dataset.enabled, "false");
  assert.equal(h.element("control").disabled, true);
  assert.equal(h.element("connection").textContent, "已连接");
  h.socket.message({ type: "state", ...h.humanState({ eventSequence: 20005, human: { ...h.humanState().human, state: "error", generation: 2, viewport: null }, viewerCleanupComplete: false }) });
  assert.equal(h.element("human-end").disabled, false);
  assert.equal(h.element("control").disabled, true);
  assert.equal(h.element("connection").textContent, "已连接");
});

test("explicit retirement or blur discards an early frame before first geometry readiness", () => {
  for (const invalidate of [h => h.socket.message({ type: "clear", eventSequence: 20003, retiredSequence: 20003 }), h => h.windowEvents.blur()]) {
    const h = setup(); h.running(); h.choose(); h.respond(2, h.state(1, "running", false, { selectedTabId: 1 }));
    h.element("human-begin").click();
    h.respond(3, h.humanState({ human: { ...h.humanState().human, generation: 0, viewport: null } }));
    h.humanFrame(); invalidate(h);
    h.socket.message({ type: "state", ...h.humanState({ eventSequence: 20005 }) });
    assert.equal(h.images.length, 0);
    assert.equal(h.element("human-input").dataset.enabled, "false");
  }
});

function readyResultHuman() {
  const h = setup(); readyResult(h); h.element("human-begin").click();
  h.respond(h.socket.sent.at(-1).id, h.humanState({ tabs: [resultTab()], selectedTabId: 1, view: null, eventSequence: 20002, retiredSequence: 20001 }));
  h.humanFrame(1, { eventSequence: 20003, retiredSequence: 20001 }); h.images.at(-1).onload();
  return h;
}
const releaseClear = (h, sequence = 20010) => h.socket.message({ type: "clear", eventSequence: sequence, retiredSequence: sequence });
const releaseState = (h, extra = {}) => h.state(2, "paused", true, { tabs: [resultTab()], human: null, view: null,
  eventSequence: 20011, retiredSequence: 20010, humanCleanup: { leaseId: "lease-a", cleanupConfirmed: true }, ...extra });

for (const order of ["state-first", "response-first"]) test(`human release notice clears on its exact cleanup in ${order} order`, () => {
  const h = readyResultHuman(); h.element("human-end").click(); const end = h.socket.sent.at(-1);
  releaseClear(h); assert.match(h.element("error").textContent, /正在释放人工控制/);
  const cleanup = releaseState(h);
  if (order === "state-first") h.socket.message({ type: "state", ...cleanup });
  h.respond(end.id, cleanup);
  if (order === "response-first") h.socket.message({ type: "state", ...cleanup });
  assert.equal(h.element("error").hidden, true); assert.equal(h.element("error").textContent, "");
  assert.equal(h.element("watch").disabled, false); assert.equal(h.element("human-begin").disabled, false);
  assert.equal(h.element("control").disabled, false); assert.equal(h.element("human-end").hidden, true);
  assert.equal(h.socket.sent.filter(command => command.operation === "humanEnd").length, 1);
});

for (const beginOrder of ["state-first", "response-first"]) test(`human release notice binds a pending Begin only when its original lease is confirmed ${beginOrder}`, () => {
  const h = setup(); readyResult(h); h.element("human-begin").click(); const begin = h.socket.sent.at(-1);
  h.windowEvents.blur(); const notice = h.element("error").textContent;
  assert.match(notice, /正在释放人工控制/);
  assert.equal(h.socket.sent.filter(command => command.operation === "humanEnd").length, 0);
  h.socket.message({ type: "state", ...releaseState(h, { eventSequence: 20002, retiredSequence: 20001, humanCleanup: { leaseId: "old-lease", cleanupConfirmed: true } }) });
  assert.equal(h.element("error").textContent, notice, "a cleanup cannot guess the pending Begin lease");
  const active = h.humanState({ tabs: [resultTab()], selectedTabId: 1, view: null, eventSequence: 20003, retiredSequence: 20001 });
  if (beginOrder === "state-first") h.socket.message({ type: "state", ...active });
  h.respond(begin.id, active);
  const end = h.socket.sent.at(-1); assert.equal(end.operation, "humanEnd"); assert.equal(end.leaseId, "lease-a");
  h.socket.message({ type: "state", ...releaseState(h) }); h.respond(end.id, releaseState(h));
  assert.equal(h.element("error").hidden, true); assert.equal(h.element("human-begin").disabled, false);
  assert.equal(h.socket.sent.filter(command => command.operation === "humanEnd").length, 1);
});

test("human release notice from pending Begin is not revived after an error replaces it", () => {
  const h = setup(); readyResult(h); h.element("human-begin").click(); const begin = h.socket.sent.at(-1);
  h.windowEvents.blur();
  h.socket.message({ type: "response", id: begin.id, error: { code: "OPERATION_UNCONFIRMED", message: "Original Begin outcome is unknown." } });
  h.socket.message({ type: "state", ...h.humanState({ tabs: [resultTab()], selectedTabId: 1, view: null, eventSequence: 20003, retiredSequence: 20001 }) });
  assert.equal(h.socket.sent.filter(command => command.operation === "humanEnd").length, 0, "late state cannot replace the failed Begin receipt");
  h.socket.message({ type: "state", ...releaseState(h) });
  assert.equal(h.element("error").textContent, "Original Begin outcome is unknown.");
  assert.equal(h.element("error").hidden, false);
});

for (const cleanup of [undefined, { leaseId: "other-lease", cleanupConfirmed: true }, { leaseId: "lease-a", cleanupConfirmed: false }]) {
  test(`human release notice requires its own confirmed receipt ${JSON.stringify(cleanup)}`, () => {
    const h = readyResultHuman(); releaseClear(h); const notice = h.element("error").textContent;
    h.socket.message({ type: "state", ...releaseState(h, { humanCleanup: cleanup }) });
    assert.equal(h.element("error").textContent, notice); assert.equal(h.element("error").hidden, false);
    assert.equal(h.element("control").disabled, true); assert.equal(h.element("human-begin").disabled, true);
    h.socket.message({ type: "state", ...releaseState(h, { eventSequence: 20012 }) });
    assert.equal(h.element("error").hidden, true); assert.equal(h.element("control").disabled, false);
  });
}

for (const errorOrder of ["before-clear", "after-clear"]) for (const cleanupOrder of ["state-first", "response-first"]) {
  test(`human release notice cannot hide an unknown input outcome ${errorOrder}/${cleanupOrder}`, () => {
    const h = readyResultHuman(); h.event("human-input", "beforeinput", { inputType: "insertText", data: "one original input" });
    const original = h.socket.sent.at(-1);
    h.element("human-end").click(); const end = h.socket.sent.at(-1);
    if (errorOrder === "after-clear") releaseClear(h);
    h.socket.message({ type: "response", id: original.id, error: { code: "OPERATION_UNCONFIRMED", message: "Original input outcome is unknown; do not replay." } });
    if (errorOrder === "before-clear") releaseClear(h);
    assert.equal(h.element("error").textContent, "Original input outcome is unknown; do not replay.");
    if (cleanupOrder === "state-first") h.socket.message({ type: "state", ...releaseState(h) });
    h.respond(end.id, releaseState(h));
    if (cleanupOrder === "response-first") h.socket.message({ type: "state", ...releaseState(h) });
    assert.equal(h.element("error").textContent, "Original input outcome is unknown; do not replay.");
    assert.equal(h.element("error").hidden, false); assert.equal(h.element("human-input").dataset.acknowledgedSequence, "0");
    assert.equal(h.socket.sent.filter(command => command.operation === "humanInput").length, 1);
    assert.equal(h.socket.sent.filter(command => command.operation === "humanEnd").length, 1);
  });
}

for (const settlement of ["success", "error", "timeout"]) for (const currentNotice of ["progress", "error"]) {
  test(`human release notice and errors belong to the current lease, not old ${settlement}/${currentNotice}`, () => {
    const h = readyResultHuman(); releaseClear(h); const old = h.socket.sent.at(-1), timer = [...h.timers.values()].at(-1);
    h.socket.message({ type: "state", ...releaseState(h) });
    h.element("human-begin").click();
    h.respond(h.socket.sent.at(-1).id, h.humanState({ tabs: [resultTab()], selectedTabId: 1, view: null, eventSequence: 30000, retiredSequence: 29999,
      human: { ...h.humanState().human, leaseId: "lease-b" } }));
    h.humanFrame(1, { eventSequence: 30001, retiredSequence: 29999, streamId: "successor", humanLeaseId: "lease-b" }); h.images.at(-1).onload();
    if (currentNotice === "error") {
      h.event("human-input", "beforeinput", { inputType: "insertText", data: "one successor input" });
      h.socket.message({ type: "response", id: h.socket.sent.at(-1).id, error: { code: "OPERATION_UNCONFIRMED", message: "Successor input outcome is unknown." } });
    } else releaseClear(h, 30002);
    const notice = h.element("error").textContent, sent = h.socket.sent.length;
    if (settlement === "timeout") timer();
    else if (settlement === "error") h.socket.message({ type: "response", id: old.id, error: { code: "OPERATION_UNCONFIRMED", message: "Retired End failed." } });
    else h.respond(old.id, releaseState(h));
    assert.equal(h.element("error").textContent, notice); assert.equal(h.element("error").hidden, false);
    assert.equal(h.socket.sent.length, sent);
    h.socket.message({ type: "state", ...releaseState(h, { eventSequence: 30003, retiredSequence: 30002 }) });
    assert.equal(h.element("error").textContent, notice, "a foreign lease cleanup cannot clear the current message");
    h.socket.message({ type: "state", ...releaseState(h, { eventSequence: 30004, retiredSequence: 30002, humanCleanup: { leaseId: "lease-b", cleanupConfirmed: true } }) });
    assert.equal(h.element("error").hidden, currentNotice === "progress");
    if (currentNotice === "error") assert.equal(h.element("error").textContent, notice);
  });
}

test("human release needs the original cleanup receipt before enabling Agent Resume", () => {
  const h = setup(); h.readyHuman();
  h.element("human-end").click();
  const end = h.socket.sent.at(-1);
  h.respond(end.id, { ...h.state(2, "paused", true, { eventSequence: 20010, retiredSequence: 20010 }), human: null });
  assert.equal(h.element("control").disabled, true);
  assert.equal(h.element("human-end").hidden, false);
  h.socket.message({ type: "state", ...h.state(2, "paused", true, { eventSequence: 20011, retiredSequence: 20010 }), human: null, humanCleanup: { leaseId: "lease-a", cleanupConfirmed: true } });
  assert.equal(h.element("control").disabled, false);
});

test("timeout or socket closure fences queued text without replay", () => {
  const h = setup(); h.readyHuman();
  h.event("human-input", "beforeinput", { inputType: "insertText", data: "a" });
  h.event("human-input", "beforeinput", { inputType: "insertText", data: "b" });
  [...h.timers.values()].at(-1)();
  assert.equal(h.element("human-input").dataset.enabled, "false");
  assert.equal(h.socket.sent.at(-1).operation, "humanEnd");
  assert.equal(h.socket.sent.filter(command => command.operation === "humanInput").length, 1);
  h.socket.close();
  h.event("human-input", "beforeinput", { inputType: "insertText", data: "c" });
  assert.equal(h.socket.sent.filter(command => command.operation === "humanInput").length, 1);
});

test("a late receipt from a finished lease cannot drain its successor input lane", () => {
  const h = setup(); h.readyHuman();
  h.event("human-input", "beforeinput", { inputType: "insertText", data: "old" });
  const old = h.socket.sent.at(-1);
  h.element("human-end").click();
  h.respond(h.socket.sent.at(-1).id, { ...h.state(2, "paused", true, { eventSequence: 20010, retiredSequence: 20010 }), human: null, humanCleanup: { leaseId: "lease-a", cleanupConfirmed: true } });
  h.element("control").click();
  h.respond(h.socket.sent.at(-1).id, h.state(3));
  h.element("human-begin").click();
  const nextState = h.state(4, "paused", true, { eventSequence: 40000, retiredSequence: 39999, human: { ...h.humanState().human, leaseId: "lease-b" } });
  h.respond(h.socket.sent.at(-1).id, nextState);
  h.humanFrame(1, { humanLeaseId: "lease-b", eventSequence: 40001, retiredSequence: 39999, streamId: "human-b" });
  h.images.at(-1).onload();
  h.event("human-input", "beforeinput", { inputType: "insertText", data: "new" });
  const current = h.socket.sent.at(-1);
  h.event("human-input", "beforeinput", { inputType: "insertText", data: "queued" });
  h.ackInput(old);
  assert.equal(h.socket.sent.at(-1), current);
  assert.equal(h.element("human-input").dataset.pending, "2");
  h.respond(current.id, { ...nextState, inputReceipt: { acknowledged: true, leaseId: "lease-b", generation: 1, sequence: 1 } });
  assert.equal(h.socket.sent.at(-1).sequence, 2);
  assert.equal(h.socket.sent.at(-1).leaseId, "lease-b");
});

test("retired Begin, Input and End callbacks cannot change a successor admission", () => {
  for (const operation of ["humanBegin", "humanInput", "humanEnd"]) {
    for (const settlement of ["success", "error", "timeout"]) {
      for (const successorReady of [false, true]) {
        const label = `${operation}/${settlement}/${successorReady ? "active" : "pending"}`;
        const h = setup(); h.running(); h.choose();
        h.respond(2, h.state(1, "running", false, { selectedTabId: 1 }));
        h.element("human-begin").click();
        let old = h.socket.sent.at(-1), timer = [...h.timers.values()].at(-1);
        if (operation === "humanBegin") h.socket.message({ type: "state", ...h.humanState() });
        else {
          h.respond(old.id, h.humanState()); h.humanFrame(); h.images.at(-1).onload();
          if (operation === "humanInput") {
            h.event("human-input", "beforeinput", { inputType: "insertText", data: "original" });
            old = h.socket.sent.at(-1); timer = [...h.timers.values()].at(-1);
          }
        }
        h.element("human-end").click();
        const end = h.socket.sent.at(-1);
        const cleanup = { ...h.state(2, "paused", true, { eventSequence: 20010, retiredSequence: 20010 }), human: null, humanCleanup: { leaseId: "lease-a", cleanupConfirmed: true } };
        if (operation === "humanEnd") {
          old = end; timer = [...h.timers.values()].at(-1);
          h.socket.message({ type: "state", ...cleanup }); // Real cleanup can precede its command response.
        } else if (operation === "humanBegin") {
          assert.equal(h.element("human-end").disabled, true, "early status is not Begin admission");
          h.socket.message({ type: "state", ...cleanup }); // Original backend cleanup may retire a still-pending Begin.
        } else h.respond(end.id, cleanup);
        assert.equal(h.element("control").disabled, false, label);
        h.element("control").click(); h.respond(h.socket.sent.at(-1).id, h.state(3));
        h.element("human-begin").click();
        const begin = h.socket.sent.at(-1);
        const next = h.state(4, "paused", true, { eventSequence: 40000, retiredSequence: 39999, human: { ...h.humanState().human, leaseId: "lease-b" } });
        const makeReady = () => {
          h.respond(begin.id, next);
          h.humanFrame(1, { humanLeaseId: "lease-b", eventSequence: 40001, retiredSequence: 39999, streamId: "human-b" });
          h.images.at(-1).onload();
        };
        if (successorReady) makeReady();
        const count = h.socket.sent.length;
        if (settlement === "timeout") timer();
        else if (settlement === "error") h.socket.message({ type: "response", id: old.id, error: { message: "original operation was revoked" } });
        else if (operation === "humanInput") h.ackInput(old);
        else h.respond(old.id, operation === "humanBegin" ? h.humanState() : cleanup);
        assert.equal(h.socket.sent.length, count, label);
        if (!successorReady) {
          assert.equal(h.element("human-status").textContent, "正在暂停 Agent 并等待原控制释放…", label);
          makeReady();
        }
        assert.equal(h.element("human-input").dataset.enabled, "true", label);
        assert.equal(h.element("connection").textContent, "已连接", label);
        h.event("human-input", "beforeinput", { inputType: "insertText", data: "successor" });
        assert.equal(h.socket.sent.at(-1).leaseId, "lease-b", label);
        assert.equal(h.socket.sent.at(-1).sequence, 1, label);
      }
    }
  }
});

test("retired human callbacks do not suppress the independent Stop acknowledgement", () => {
  const h = setup(); h.readyHuman();
  h.event("human-input", "beforeinput", { inputType: "insertText", data: "old" });
  const old = h.socket.sent.at(-1), timer = [...h.timers.values()].at(-1);
  h.element("human-end").click();
  h.respond(h.socket.sent.at(-1).id, { ...h.state(2, "paused", true, { eventSequence: 20010, retiredSequence: 20010 }), human: null, humanCleanup: { leaseId: "lease-a", cleanupConfirmed: true } });
  h.element("stop").click();
  const stop = h.socket.sent.at(-1);
  timer(); h.socket.message({ type: "response", id: old.id, error: { message: "old" } });
  assert.equal(h.element("state").textContent, "正在停止");
  h.respond(stop.id, { stopped: true });
  assert.equal(h.element("state").textContent, "会话已停止");
});

function generationState(h, generation, state = "active", eventSequence = 21000 + generation * 10) {
  return h.humanState({ eventSequence, retiredSequence: 21000 + generation * 10 - 2,
    human: { ...h.humanState().human, state, generation, viewport: state === "navigating" ? null : { width: 1280, height: 720 } } });
}

function resumeGeneration(h, generation = 2) {
  const state = generationState(h, generation);
  h.socket.message({ type: "state", ...state });
  h.humanFrame(1, { generation, streamId: `human-generation-${generation}`, eventSequence: state.eventSequence + 1, retiredSequence: state.retiredSequence });
  h.images.at(-1).onload();
  return state;
}

test("navigation suspends one lease, clears held UI and unsent input, then restarts sequence after decode", () => {
  const h = setup(); h.readyHuman();
  h.event("frame", "pointerdown", mouse());
  const old = h.socket.sent.at(-1);
  h.event("human-input", "keydown", key());
  h.event("human-input", "compositionstart");
  h.element("human-input").value = "uncommitted";
  h.socket.message({ type: "state", ...generationState(h, 2, "navigating") });
  assert.equal(h.element("human-input").dataset.enabled, "false");
  assert.equal(h.element("human-input").dataset.pending, "0");
  assert.equal(h.element("human-input").value, "");
  assert.equal(h.element("frame").hasPointerCapture(1), false);
  assert.equal(h.element("frame").hidden, true);
  h.event("human-input", "blur"); // Disabling the focused input must not end navigation.
  h.event("frame", "pointerup", mouse());
  h.event("human-input", "beforeinput", { inputType: "insertText", data: "during-navigation" });
  assert.equal(h.socket.sent.at(-1), old);
  assert.equal(h.element("human-end").disabled, false);
  assert.match(h.element("human-status").textContent, /跳转/);
  const next = generationState(h, 2);
  h.socket.message({ type: "state", ...next });
  h.humanFrame(1, { generation: 2, streamId: "new-document", eventSequence: next.eventSequence + 1, retiredSequence: next.retiredSequence });
  assert.equal(h.element("human-input").dataset.enabled, "false");
  h.images.at(-1).onload();
  assert.equal(h.element("human-input").dataset.enabled, "true");
  h.event("human-input", "compositionend", { data: "retired-composition" });
  h.event("human-input", "keyup", key({ shiftKey: false }));
  h.event("frame", "pointerup", mouse());
  assert.equal(h.socket.sent.at(-1), old);
  h.event("human-input", "beforeinput", { inputType: "insertText", data: "new-document" });
  assert.equal(h.socket.sent.at(-1).generation, 2);
  assert.equal(h.socket.sent.at(-1).sequence, 1);
  assert.equal(h.socket.sent.filter(command => command.operation === "humanBegin").length, 1);
  assert.equal(h.socket.sent.filter(command => command.operation === "humanEnd").length, 0);
});

test("navigation retires old success, error and timeout without changing successor input or status", () => {
  for (const settlement of ["success", "error", "timeout"]) {
    const h = setup(); h.readyHuman();
    h.event("human-input", "beforeinput", { inputType: "insertText", data: "old" });
    const old = h.socket.sent.at(-1), timer = [...h.timers.values()].at(-1);
    h.socket.message({ type: "state", ...generationState(h, 2, "navigating") });
    const next = resumeGeneration(h);
    h.event("human-input", "beforeinput", { inputType: "insertText", data: "new" });
    const current = h.socket.sent.at(-1);
    h.event("human-input", "beforeinput", { inputType: "insertText", data: "queued" });
    if (settlement === "success") h.ackInput(old);
    else if (settlement === "error") h.socket.message({ type: "response", id: old.id, error: { code: "OPERATION_UNCONFIRMED", message: "old" } });
    else timer();
    assert.equal(h.socket.sent.at(-1), current, settlement);
    assert.equal(h.element("human-input").dataset.pending, "2", settlement);
    assert.equal(h.element("human-input").dataset.acknowledgedSequence, "0", settlement);
    assert.equal(h.element("connection").textContent, "已连接", settlement);
    h.ackInput(current, next);
    assert.equal(h.socket.sent.at(-1).generation, 2, settlement);
    assert.equal(h.socket.sent.at(-1).sequence, 2, settlement);
  }
});

test("navigation accepts the triggering input's exact old receipt and current navigating state", () => {
  const h = setup(); h.readyHuman();
  h.event("frame", "pointerdown", mouse());
  const down = h.socket.sent.at(-1);
  h.event("frame", "pointerup", mouse());
  h.ackInput(down, generationState(h, 2, "navigating"));
  assert.equal(h.element("human-input").dataset.pending, "0");
  assert.equal(h.element("human-input").dataset.acknowledgedSequence, "0");
  assert.equal(h.socket.sent.at(-1), down);
  resumeGeneration(h);
  h.event("frame", "pointerdown", mouse());
  assert.equal(h.socket.sent.at(-1).generation, 2);
  assert.equal(h.socket.sent.at(-1).sequence, 1);
});

test("navigation buffers one early future frame and rejects late old decode", () => {
  const h = setup(); h.readyHuman();
  h.humanFrame(2);
  const oldDecode = h.images.at(-1);
  h.humanFrame(1, { generation: 2, streamId: "new-document", eventSequence: 21021, retiredSequence: 21018 });
  h.socket.message({ type: "state", ...generationState(h, 2, "navigating") });
  h.humanFrame(2, { generation: 2, streamId: "new-document", eventSequence: 21022, retiredSequence: 21018 });
  h.humanFrame(1, { generation: 2, streamId: "new-document", eventSequence: 21021, retiredSequence: 21018 });
  h.socket.message({ type: "state", ...generationState(h, 2, "active", 21023) });
  assert.equal(h.images.length, 2);
  oldDecode.onload();
  assert.equal(h.element("frame").hidden, true);
  assert.equal(h.images.length, 3);
  h.images.at(-1).onload();
  assert.equal(h.element("frame").dataset.generation, "2");
  assert.equal(h.element("frame").dataset.frameSequence, "2");
  assert.equal(h.element("human-input").dataset.enabled, "true");
  assert.equal(h.socket.sent.filter(command => command.operation === "humanEnd").length, 0);
});

test("navigation coalesced active generation still discards old lane and waits for decode", () => {
  const h = setup(); h.readyHuman();
  h.event("human-input", "beforeinput", { inputType: "insertText", data: "old" });
  h.socket.message({ type: "state", ...generationState(h, 3) });
  assert.equal(h.element("human-input").dataset.enabled, "false");
  assert.equal(h.element("frame").hidden, true);
  h.event("human-input", "blur"); // The coalesced active snapshot also disables the old focused input.
  resumeGeneration(h, 3);
  h.event("human-input", "beforeinput", { inputType: "insertText", data: "new" });
  assert.equal(h.socket.sent.at(-1).sequence, 1);
  assert.equal(h.socket.sent.at(-1).generation, 3);
});

test("navigation stale-before-dispatch error waits for a newer generation without replay or End", () => {
  const h = setup(); h.readyHuman();
  h.event("human-input", "beforeinput", { inputType: "insertText", data: "not-dispatched" });
  const old = h.socket.sent.at(-1);
  h.event("human-input", "beforeinput", { inputType: "insertText", data: "queued-old" });
  h.socket.message({ type: "response", id: old.id, error: { code: "HUMAN_GENERATION_STALE", message: "generation retired before dispatch" } });
  assert.equal(h.element("human-input").dataset.enabled, "false");
  assert.equal(h.element("human-input").dataset.pending, "0");
  assert.equal(h.socket.sent.at(-1), old);
  h.socket.message({ type: "state", ...h.humanState({ eventSequence: 20002 }) });
  h.humanFrame(3); h.images.at(-1).onload();
  assert.equal(h.element("human-input").dataset.enabled, "false");
  resumeGeneration(h);
  h.event("human-input", "beforeinput", { inputType: "insertText", data: "fresh" });
  assert.equal(h.socket.sent.at(-1).input.text, "fresh");
  assert.equal(h.socket.sent.at(-1).sequence, 1);
  assert.equal(h.socket.sent.filter(command => command.operation === "humanEnd").length, 0);
});

test("navigation never overrides explicit End, Stop, blur or connection loss", () => {
  for (const finish of ["end", "stop", "blur", "disconnect"]) {
    const h = setup(); h.readyHuman();
    h.socket.message({ type: "state", ...generationState(h, 2, "navigating") });
    if (finish === "end") h.element("human-end").click();
    else if (finish === "stop") h.element("stop").click();
    else if (finish === "blur") h.windowEvents.blur();
    else h.socket.close();
    const command = h.socket.sent.at(-1);
    h.socket.message({ type: "state", ...generationState(h, 2) });
    h.humanFrame(1, { generation: 2, streamId: "late-new-document", eventSequence: 21021, retiredSequence: 21018 });
    assert.equal(h.element("human-input").dataset.enabled, "false", finish);
    assert.equal(h.socket.sent.at(-1), command, finish);
    if (finish === "end" || finish === "blur") {
      assert.equal(command.operation, "humanEnd");
      h.respond(command.id, h.state(2, "paused", true, { eventSequence: 21030, retiredSequence: 21030, human: null, humanCleanup: { leaseId: "lease-a", cleanupConfirmed: true } }));
      assert.equal(h.element("control").disabled, false, finish);
    } else if (finish === "stop") {
      h.respond(command.id, { stopped: true });
      assert.equal(h.element("state").textContent, "会话已停止");
    }
  }
});

test("navigation cannot replace Begin admission and a valid late receipt cannot regress its generation", () => {
  for (const settlement of ["success", "error", "timeout"]) {
    const h = setup(); h.running(); h.choose();
    h.respond(2, h.state(1, "running", false, { selectedTabId: 1 }));
    h.element("human-begin").click();
    const begin = h.socket.sent.at(-1), timer = [...h.timers.values()].at(-1);
    h.socket.message({ type: "state", ...h.humanState() });
    h.socket.message({ type: "state", ...generationState(h, 2, "navigating") });
    resumeGeneration(h);
    assert.equal(h.element("human-input").dataset.enabled, "false", "state and decoded frame do not admit Begin");
    assert.equal(h.element("human-end").disabled, true);
    if (settlement === "success") h.respond(begin.id, h.humanState());
    else if (settlement === "error") h.socket.message({ type: "response", id: begin.id, error: { code: "OPERATION_UNCONFIRMED", message: "old Begin" } });
    else timer();
    assert.equal(h.element("human-input").dataset.enabled, String(settlement === "success"), settlement);
    assert.equal(h.element("connection").textContent, settlement === "success" ? "已连接" : "控制状态不可用", settlement);
    assert.equal(h.socket.sent.filter(command => command.operation === "humanEnd").length, 0, settlement);
    h.event("human-input", "beforeinput", { inputType: "insertText", data: "new" });
    if (settlement === "success") {
      assert.equal(h.socket.sent.at(-1).generation, 2, settlement);
      assert.equal(h.socket.sent.at(-1).sequence, 1, settlement);
    } else assert.equal(h.socket.sent.filter(command => command.operation === "humanInput").length, 0);
  }
});

test("navigation does not reinterpret unknown input failure as a confirmed stale rejection", () => {
  for (const failure of ["OPERATION_UNCONFIRMED", "HUMAN_STALE", "timeout"]) {
    const h = setup(); h.readyHuman();
    h.event("human-input", "beforeinput", { inputType: "insertText", data: "unknown" });
    const input = h.socket.sent.at(-1);
    if (failure === "timeout") [...h.timers.values()].at(-1)();
    else h.socket.message({ type: "response", id: input.id, error: { code: failure, message: "unknown original result" } });
    assert.equal(h.socket.sent.at(-1).operation, "humanEnd", failure);
    h.socket.message({ type: "state", ...generationState(h, 2, "navigating") });
    h.socket.message({ type: "state", ...generationState(h, 2) });
    h.humanFrame(1, { generation: 2, eventSequence: 21021, retiredSequence: 21018 });
    assert.equal(h.element("human-input").dataset.enabled, "false", failure);
    assert.equal(h.socket.sent.filter(command => command.operation === "humanInput").length, 1, failure);
  }
});

test("navigation rejects malformed readiness and never regresses an established generation", () => {
  const h = setup(); h.readyHuman();
  h.socket.message({ type: "state", ...generationState(h, 2, "navigating") });
  resumeGeneration(h);
  h.socket.message({ type: "state", ...h.humanState({ eventSequence: 21029, retiredSequence: 21018 }) });
  h.event("human-input", "beforeinput", { inputType: "insertText", data: "still-generation-two" });
  assert.equal(h.socket.sent.at(-1).generation, 2);
  for (const human of [
    { state: "navigating", generation: 0, viewport: null },
    { state: "navigating", generation: 2, viewport: { width: 1280, height: 720 } },
    { state: "active", generation: 2, viewport: null }
  ]) {
    const invalid = setup(); invalid.readyHuman();
    invalid.socket.message({ type: "state", ...invalid.humanState({ eventSequence: 21020, human: { ...invalid.humanState().human, ...human } }) });
    assert.equal(invalid.element("human-input").dataset.enabled, "false");
    assert.equal(invalid.socket.sent.at(-1).operation, "humanEnd");
  }
});
