import assert from "node:assert/strict";
import test from "node:test";
import { BrowserPageExports, validatePageExport } from "./browser-page-exports.js";

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const request = (extra = {}) => ({ session_id: "one", turn_id: "turn", control_epoch: 1, tabId: 7, format: "pdf", ...extra });
const scope = params => ({ ...params, attachment: {}, docRevision: 1 });
const base64 = value => Buffer.from(value).toString("base64");

function fixture(options = {}) {
  const calls = [], hooks = {};
  let valid = true, reads = 0;
  const registry = new BrowserPageExports({
    async send(bound, method, args, flags) {
      calls.push({ bound, method, args, flags });
      if (hooks[method]) return hooks[method](bound, args, flags);
      if (method === "Page.printToPDF") return { data: "", stream: "private-stream" };
      if (method === "IO.read") return ++reads === 1 ? { data: base64("%PDF-bytes"), base64Encoded: true, eof: false } : { data: "", base64Encoded: true, eof: true };
      if (method === "Page.captureSnapshot") return { data: "MIME-Version: 1.0\r\n中文" };
      return {};
    },
    async validateScope(value) { await hooks.validate?.(value); if (!valid) throw new Error("scope retired"); },
    assertScope(value) { hooks.assert?.(value); if (!valid) throw new Error("scope retired"); },
    ...options
  });
  const launch = (extra = {}) => { const record = registry.reserve(request(extra)); return { record, result: registry.run(record, scope(record.params)) }; };
  return { registry, calls, hooks, launch, retireScope() { valid = false; } };
}

test("request validation is strict, immutable, bounded and has explicit defaults", () => {
  const input = request({ pdf: { scale: 0.1, landscape: false, paperHeight: 200, marginTop: 0, pageRanges: "1-3, 5", generateTaggedPDF: true } });
  const value = validatePageExport(input);
  input.pdf.scale = 2;
  assert.equal(value.pdf.scale, 0.1); assert.ok(Object.isFrozen(value.pdf)); assert.ok(Object.isFrozen(value));
  assert.equal(value.timeoutMs, 10000); assert.equal(value.maxBytes, 16 * 1024 * 1024);
  for (const extra of [{ format: "PDF" }, { format: "mhtml", pdf: {} }, { pdf: null }, { pdf: { transferMode: "ReturnAsBase64" } }, { pdf: { headerTemplate: "<b>hi</b>" } }, { filename: "out.pdf" }, { target: { tabId: 7 } }, { control_epoch: 0 }, { tabId: -1 }, { turn_id: "" }]) assert.throws(() => validatePageExport(request(extra)));
  for (const timeoutMs of [null, 0, 120001, 1.5, "100", Infinity]) assert.throws(() => validatePageExport(request({ timeoutMs })));
  for (const maxBytes of [null, 0, 16777217, 1.5, "10", Infinity]) assert.throws(() => validatePageExport(request({ maxBytes })));
  for (const pdf of [{ scale: 0 }, { scale: 2.1 }, { scale: NaN }, { paperWidth: 0 }, { paperHeight: Infinity }, { marginLeft: -1 }, { marginTop: 201 }, { printBackground: 1 }, { pageRanges: "1\n2" }, { pageRanges: "all" }, { pageRanges: "1".repeat(1025) }]) assert.throws(() => validatePageExport(request({ pdf })));
});

test("PDF uses only fixed stream commands, closes before success and returns exactly five fields", async () => {
  const f = fixture(), close = deferred(), entered = deferred();
  f.hooks["IO.close"] = async () => { entered.resolve(); await close.promise; };
  const { record, result } = f.launch({ pdf: { printBackground: true } });
  let settled = false; result.finally(() => { settled = true; }).catch(() => {});
  await entered.promise; assert.equal(settled, false); assert.ok(f.registry.controlSnapshot().pending.length);
  close.resolve();
  assert.deepEqual(await result, { format: "pdf", mimeType: "application/pdf", encoding: "base64", data: base64("%PDF-bytes"), byteLength: 10 });
  assert.deepEqual(f.calls.map(call => [call.method, call.args]), [
    ["Page.printToPDF", { printBackground: true, transferMode: "ReturnAsStream" }],
    ["IO.read", { handle: "private-stream", size: 65536 }], ["IO.read", { handle: "private-stream", size: 65536 }], ["IO.close", { handle: "private-stream" }]
  ]);
  assert.deepEqual(f.calls.at(-1).flags, { cleanup: true });
  assert.equal(f.registry.records.has(record), false);
});

test("reserve then outer admission within then run supports nested completion", async () => {
  const f = fixture(), record = f.registry.reserve(request());
  const result = await f.registry.within(record, () => f.registry.run(record, scope(record.params)));
  assert.equal(result.byteLength, 10); assert.equal(f.registry.records.size, 0);
  await tick(); assert.equal(f.registry.controlSnapshot().pending.length, 0);
});

test("PDF joins independently padded chunks without corrupting binary bytes", async () => {
  const f = fixture(), chunks = [new Uint8Array([0, 255]), new Uint8Array([1]), new Uint8Array([2, 3, 4, 128])];
  let index = 0;
  f.hooks["IO.read"] = async () => ({ data: base64(chunks[index]), base64Encoded: true, eof: ++index === chunks.length });
  const result = await f.launch().result;
  assert.deepEqual([...Buffer.from(result.data, "base64")], [0, 255, 1, 2, 3, 4, 128]);
  assert.equal(result.byteLength, 7);
});

test("plain UTF-8 stream chunks and MHTML return exact encoded byte lengths", async () => {
  const f = fixture();
  f.hooks["IO.read"] = async () => ({ data: "中文", base64Encoded: false, eof: true });
  assert.equal((await f.launch().result).byteLength, 6);
  const result = await f.launch({ format: "mhtml" }).result;
  assert.deepEqual(result, { format: "mhtml", mimeType: "multipart/related", encoding: "base64", data: base64("MIME-Version: 1.0\r\n中文"), byteLength: Buffer.byteLength("MIME-Version: 1.0\r\n中文") });
  assert.deepEqual(f.calls.at(-1).args, { format: "mhtml" });
});

test("byte limits reject partial data and PDF still closes its exact stream", async () => {
  for (const format of ["pdf", "mhtml"]) {
    const f = fixture();
    await assert.rejects(f.launch({ format, maxBytes: 5 }).result, /OBU_EXPORT_LIMIT/);
    await f.registry.invalidateAll();
    assert.equal(f.calls.filter(call => call.method === "IO.close").length, format === "pdf" ? 1 : 0);
    assert.equal(f.registry.records.size, 0);
  }
});

test("malformed base64, stream responses and stalled non-EOF output cannot succeed", async () => {
  for (const result of [{ data: "A===", base64Encoded: true, eof: true }, { data: "AB==", base64Encoded: true, eof: true }, { data: "Y Q==", base64Encoded: true, eof: true }, { data: "YQ", base64Encoded: true, eof: true }, { data: "a", base64Encoded: "true", eof: true }, { data: "a", eof: "true" }, { data: "", eof: false }, { data: "", eof: true }]) {
    const f = fixture(); f.hooks["IO.read"] = async () => result;
    await assert.rejects(f.launch().result, /OBU_EXPORT_FAILED/);
    await f.registry.invalidateAll();
    assert.equal(f.calls.filter(call => call.method === "IO.close").length, 1);
    assert.ok(f.calls.length <= 7);
  }
  const f = fixture(); f.hooks["Page.printToPDF"] = async () => ({ data: "ignored fallback", stream: "" });
  await assert.rejects(f.launch().result, /OBU_EXPORT_FAILED/);
  assert.equal(f.calls.some(call => call.method === "IO.read"), false);
});

test("capacity and per-tab busy reservations include pending cleanup and reopen after cancellation", async () => {
  const f = fixture(), records = [7, 8, 9, 10].map(tabId => f.registry.reserve(request({ tabId })));
  assert.throws(() => f.registry.reserve(request({ tabId: 11 })), /OBU_EXPORT_LIMIT/);
  await f.registry.cancel(records[3]);
  assert.throws(() => f.registry.reserve(request({ session_id: "two" })), /OBU_EXPORT_BUSY/);
  await f.registry.invalidateAll(); assert.equal(f.registry.records.size, 0);
  assert.ok(f.registry.reserve(request()));
});

test("late print after timeout only closes, while the actual flow remains in the drain", async () => {
  const f = fixture(), printed = deferred(), entered = deferred(), closed = deferred();
  f.hooks["Page.printToPDF"] = async () => { entered.resolve(); return printed.promise; };
  f.hooks["IO.close"] = () => closed.promise;
  const { result } = f.launch({ timeoutMs: 15 }); await entered.promise;
  await assert.rejects(result, /OBU_EXPORT_TIMEOUT/);
  assert.equal(f.registry.records.size, 1); assert.ok(f.registry.controlSnapshot().pending.length);
  let drained = false; const draining = f.registry.invalidateAll().then(() => { drained = true; });
  printed.resolve({ stream: "late-stream" }); await tick();
  assert.equal(drained, false); assert.equal(f.calls.some(call => call.method === "IO.read"), false);
  assert.deepEqual(f.calls.at(-1).args, { handle: "late-stream" });
  closed.resolve(); await draining;
  assert.equal(f.registry.records.size, 0); await tick(); assert.equal(f.registry.controlSnapshot().pending.length, 0);
});

test("cancel during a native read rejects promptly but cleanup waits for real read and close", async () => {
  const f = fixture(), reading = deferred(), entered = deferred(), closed = deferred();
  f.hooks["IO.read"] = async () => { entered.resolve(); return reading.promise; };
  f.hooks["IO.close"] = () => closed.promise;
  const { record, result } = f.launch(); const rejected = assert.rejects(result, /OBU_EXPORT_CANCELLED/); await entered.promise;
  let drained = false; const cleanup = f.registry.cancel(record).then(() => { drained = true; });
  await rejected; assert.equal(drained, false); assert.equal(f.calls.some(call => call.method === "IO.close"), false);
  reading.resolve({ data: base64("old"), base64Encoded: true, eof: true }); await tick();
  assert.equal(drained, false); assert.equal(f.calls.filter(call => call.method === "IO.read").length, 1);
  closed.resolve(); await cleanup; assert.equal(f.registry.records.size, 0);
});

test("MHTML timeout tracks native completion and never publishes its late content", async () => {
  const f = fixture(), capturing = deferred(); f.hooks["Page.captureSnapshot"] = () => capturing.promise;
  const { result } = f.launch({ format: "mhtml", timeoutMs: 15 });
  await assert.rejects(result, /OBU_EXPORT_TIMEOUT/); assert.ok(f.registry.controlSnapshot().pending.length);
  const cleanup = f.registry.invalidateAll(); capturing.resolve({ data: "late secret" }); await cleanup;
  assert.equal(f.registry.records.size, 0); assert.equal(f.calls.length, 1);
});

test("failed close stays retryable and does not trigger an automatic second close", async () => {
  const f = fixture(); f.hooks["IO.close"] = async () => { throw new Error("native failed with handle details"); };
  await assert.rejects(f.launch().result, /^Error: OBU_EXPORT_CLEANUP_FAILED: native page export stream could not be closed$/);
  await tick(); assert.equal(f.calls.filter(call => call.method === "IO.close").length, 1);
  assert.equal(f.registry.records.size, 1); assert.throws(() => f.registry.reserve(request()), /OBU_EXPORT_BUSY/);
  await assert.rejects(f.registry.invalidateAll(), /OBU_EXPORT_CLEANUP_FAILED/);
  assert.equal(f.calls.filter(call => call.method === "IO.close").length, 2);
  delete f.hooks["IO.close"]; await f.registry.invalidateAll();
  assert.equal(f.calls.filter(call => call.method === "Page.printToPDF").length, 1);
  assert.equal(f.calls.filter(call => call.method === "IO.close").length, 3);
  assert.equal(f.registry.records.size, 0);
});

test("scope invalidation between read and result prevents disclosure while allowing cleanup", async () => {
  const f = fixture();
  f.hooks["IO.read"] = async () => { f.retireScope(); return { data: base64("private"), base64Encoded: true, eof: true }; };
  await assert.rejects(f.launch().result, /scope retired/); await f.registry.invalidateAll();
  assert.deepEqual(f.calls.at(-1).flags, { cleanup: true }); assert.equal(f.calls.at(-1).method, "IO.close");
});

test("scope invalidation during close is checked before returning already captured bytes", async () => {
  const f = fixture(); f.hooks["IO.close"] = async () => { f.retireScope(); };
  await assert.rejects(f.launch().result, /scope retired/); await f.registry.invalidateAll();
  assert.equal(f.registry.records.size, 0);
});

test("deadline includes validation, native work, stream close and encoding", async () => {
  let now = 0;
  const f = fixture({ now: () => now }); f.hooks["IO.close"] = async () => { now = 100; };
  await assert.rejects(f.launch({ timeoutMs: 100 }).result, /OBU_EXPORT_TIMEOUT/);
  await f.registry.invalidateAll(); assert.equal(f.calls.at(-1).method, "IO.close");
  const g = fixture({ now: () => now }), record = g.registry.reserve(request({ timeoutMs: 10 }));
  now += 10; await assert.rejects(g.registry.run(record, scope(record.params)), /OBU_EXPORT_TIMEOUT/);
  assert.equal(g.calls.length, 0); await g.registry.cancel(record);
});

test("admission pending promises remain visible after an unbound reservation is cancelled", async () => {
  const f = fixture(), admission = deferred(), entered = deferred(), record = f.registry.reserve(request());
  const result = f.registry.within(record, async () => { entered.resolve(); await admission.promise; f.registry.check(record); });
  const rejected = assert.rejects(result, /OBU_EXPORT_CANCELLED/); await entered.promise;
  await f.registry.cancel(record); await rejected;
  assert.ok(f.registry.controlSnapshot().pending.length); assert.deepEqual(f.registry.controlSnapshot().tabIds, []);
  admission.resolve(); await tick(); assert.equal(f.registry.controlSnapshot().pending.length, 0); assert.equal(f.calls.length, 0);
});

test("owner migration preserves only the exact unbound reservation; explicit detach still cancels it", async () => {
  const f = fixture(), one = f.registry.reserve(request()), two = f.registry.reserve(request({ tabId: 8 }));
  await f.registry.invalidateTab(7, one); f.registry.check(one);
  await f.registry.invalidateAttachedTab(7); f.registry.check(one);
  await f.registry.invalidateTab(7); assert.throws(() => f.registry.check(one), /OBU_EXPORT_CANCELLED/);
  f.registry.check(two); await f.registry.invalidateAll();
});

test("document change cancels bound work even if the caller asks to preserve its reservation", async () => {
  const f = fixture(), printing = deferred(), entered = deferred();
  f.hooks["Page.printToPDF"] = async () => { entered.resolve(); return printing.promise; };
  const { record, result } = f.launch(); const rejected = assert.rejects(result, /OBU_EXPORT_DOCUMENT_CHANGED/); await entered.promise;
  const cleanup = f.registry.invalidateAttachedTab(7, new Error("OBU_EXPORT_DOCUMENT_CHANGED: page changed"));
  await rejected; printing.resolve({ stream: "old" }); await cleanup;
  assert.equal(f.calls.some(call => call.method === "IO.read"), false);
  assert.equal(f.registry.records.has(record), false);
});

test("session invalidation cannot cancel another session export and scope identity is exact", async () => {
  const f = fixture(), a = f.registry.reserve(request()), b = f.registry.reserve(request({ tabId: 8, session_id: "two" }));
  await f.registry.invalidateSession("one"); assert.throws(() => f.registry.check(a), /OBU_EXPORT_CANCELLED/); f.registry.check(b);
  for (const change of [{ session_id: "other" }, { turn_id: "old" }, { control_epoch: 2 }, { tabId: 9 }]) await assert.rejects(f.registry.run(b, { ...scope(b.params), ...change }), /OBU_EXPORT_CANCELLED/);
  assert.equal(f.calls.length, 0); await f.registry.invalidateAll();
});

test("native print errors remain errors and never trigger base64 fallback or print replay", async () => {
  const f = fixture(); const original = new Error("Printing is not available");
  f.hooks["Page.printToPDF"] = async () => { throw original; };
  await assert.rejects(f.launch().result, error => error === original);
  await f.registry.invalidateAll(); assert.equal(f.calls.length, 1); assert.equal(f.registry.records.size, 0);
});

test("adapter preflight must recheck cancellation or deadline before the real native command", async () => {
  for (const timedOut of [false, true]) {
    const f = fixture(), inspecting = deferred(), entered = deferred(), original = f.registry.send;
    f.registry.send = async (bound, method, args, options) => {
      if (method === "Page.printToPDF") { entered.resolve(); await inspecting.promise; }
      options.check?.();
      return original(bound, method, args, options);
    };
    const { record, result } = f.launch({ timeoutMs: timedOut ? 15 : 10000 });
    const rejected = assert.rejects(result, timedOut ? /OBU_EXPORT_TIMEOUT/ : /OBU_EXPORT_CANCELLED/);
    await entered.promise;
    if (!timedOut) void f.registry.cancel(record);
    await rejected;
    assert.equal(f.calls.length, 0); assert.ok(f.registry.controlSnapshot().pending.length);
    const draining = f.registry.invalidateAll(); inspecting.resolve(); await draining;
    assert.equal(f.calls.length, 0); assert.equal(f.registry.records.size, 0);
  }
});

test("the original deadline is rechecked after synchronous final encoding", async t => {
  let now = 0;
  const f = fixture({ now: () => now }), original = globalThis.btoa;
  globalThis.btoa = value => { const encoded = original(value); now = 100; return encoded; };
  t.after(() => { globalThis.btoa = original; });
  await assert.rejects(f.launch({ format: "mhtml", timeoutMs: 100 }).result, /OBU_EXPORT_TIMEOUT/);
  await f.registry.invalidateAll(); assert.equal(f.registry.records.size, 0);
});

test("many short stream chunks retain the exact bytes without accumulating chunk objects", async () => {
  const f = fixture(); let count = 0;
  f.hooks["IO.read"] = async () => ({ data: base64([count++ % 256]), base64Encoded: true, eof: count === 4097 });
  const result = await f.launch({ maxBytes: 4097 }).result;
  assert.equal(result.byteLength, 4097);
  assert.deepEqual([...Buffer.from(result.data, "base64")], Array.from({ length: 4097 }, (_, index) => index % 256));
});

test("cleanup failure after external attachment loss stays explicit and cannot close a successor", async () => {
  const f = fixture(); let originalAttachment = true;
  f.hooks["IO.read"] = async () => { originalAttachment = false; return { data: base64("pdf"), base64Encoded: true, eof: true }; };
  f.hooks["IO.close"] = async () => { if (!originalAttachment) throw new Error("original attachment is unavailable"); };
  await assert.rejects(f.launch().result, /OBU_EXPORT_CLEANUP_FAILED/); await tick();
  await assert.rejects(f.registry.invalidateAll(), /OBU_EXPORT_CLEANUP_FAILED/);
  assert.equal(f.registry.records.size, 1); assert.deepEqual(f.registry.controlSnapshot().tabIds, [7]);
  assert.throws(() => f.registry.reserve(request({ session_id: "successor", control_epoch: 2 })), /OBU_EXPORT_BUSY/);
  assert.equal(f.calls.filter(call => call.method === "Page.printToPDF").length, 1);
});

test("captured attachment cleanup preserves unbound reservations and cannot cancel a successor token", async () => {
  const f = fixture(), record = f.registry.reserve(request()), attachment = {}, oldAttachment = {};
  await f.registry.invalidateAttachment(7, attachment); f.registry.check(record);
  const printing = deferred(), entered = deferred();
  f.hooks["Page.printToPDF"] = async () => { entered.resolve(); return printing.promise; };
  const result = f.registry.run(record, { ...scope(record.params), attachment });
  const rejected = assert.rejects(result, /OBU_EXPORT_CANCELLED/); await entered.promise;
  await f.registry.invalidateAttachment(7, oldAttachment); f.registry.check(record);
  assert.equal(f.calls.some(call => call.method === "IO.close"), false);
  let closed = false;
  const cleanup = f.registry.invalidateAttachment(7, attachment).then(() => { closed = true; });
  await rejected; assert.equal(closed, false);
  printing.resolve({ stream: "exact-attachment-stream" }); await cleanup;
  assert.equal(f.calls.some(call => call.method === "IO.read"), false);
  assert.equal(f.calls.at(-1).bound.attachment, attachment);
  const successor = f.registry.reserve(request({ control_epoch: 2 }));
  await f.registry.invalidateAttachment(7, attachment); f.registry.check(successor);
  await f.registry.invalidateAll();
});

test("timed-out unbound admissions retain all four capacity slots until real work settles", async () => {
  const f = fixture(), gates = Array.from({ length: 4 }, deferred), entered = Array.from({ length: 4 }, deferred);
  const requests = gates.map((gate, index) => {
    const record = f.registry.reserve(request({ tabId: index, timeoutMs: 15 }));
    return assert.rejects(f.registry.within(record, async () => { entered[index].resolve(); await gate.promise; f.registry.check(record); }), /OBU_EXPORT_TIMEOUT/);
  });
  await Promise.all(entered.map(item => item.promise)); await Promise.all(requests);
  // Cancellation ACK does not await admission, so owner-migration teardown
  // cannot deadlock. The real operations still consume their reserved slots.
  await f.registry.invalidateAll();
  assert.equal(f.registry.records.size, 4); assert.ok(f.registry.controlSnapshot().pending.length >= 4);
  assert.throws(() => f.registry.reserve(request({ tabId: 99 })), /OBU_EXPORT_LIMIT/);
  gates[0].resolve(); await tick(); assert.equal(f.registry.records.size, 3);
  const replacement = f.registry.reserve(request({ tabId: 99 })); assert.equal(f.registry.records.size, 4);
  await f.registry.cancel(replacement);
  for (const gate of gates.slice(1)) gate.resolve();
  await tick(); assert.equal(f.registry.records.size, 0); assert.equal(f.registry.controlSnapshot().pending.length, 0);
  assert.equal(f.calls.length, 0);
});
