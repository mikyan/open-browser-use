import assert from "node:assert/strict";
import test from "node:test";
import { deflateSync } from "node:zlib";
import { BrowserClipboard, validateClipboardRequest, validateClipboardResult } from "./browser-clipboard.js";

const MAX_BYTES = 16 * 1024 * 1024;
const MAX_JSON_BYTES = 48 * 1024 * 1024;
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const request = (extra = {}) => ({ session_id: "one", turn_id: "turn", control_epoch: 1, tabId: 7, ...extra });
const scope = params => ({ ...params, attachment: {}, docRevision: 1, documentId: "document-one" });
const text = (value, mime_type = "text/plain") => ({ mime_type, text: value });
const image = (value = PNG) => ({ mime_type: "image/png", base64: value });
const item = (...entries) => ({ entries });
const rich = (...entries) => request({ items: [item(...entries)] });

function fixture(options = {}) {
  const calls = [], hooks = {};
  let valid = true;
  const clipboard = new BrowserClipboard({
    async execute(bound, method, params, flags) {
      calls.push({ bound, method, params, flags });
      if (hooks.execute) return hooks.execute(bound, method, params, flags);
      flags.check();
      if (method === "readClipboardText") return { text: "中文 🦆" };
      if (method === "readClipboard") return { items: [item(text("plain"), text("<b>rich</b>", "text/html"), image())] };
      return {};
    },
    async validateScope(bound) { await hooks.validate?.(bound); if (!valid) throw new Error("scope retired"); },
    assertScope(bound) { hooks.assert?.(bound); if (!valid) throw new Error("scope retired"); },
    ...options
  });
  const launch = (method = "readClipboardText", extra = {}) => {
    const record = clipboard.reserve(method, request(extra));
    return { record, result: clipboard.run(record, scope(record.params)) };
  };
  return { clipboard, calls, hooks, launch, retireScope() { valid = false; } };
}

test("requests preserve wire names, clone nested payloads and normalize explicit defaults", () => {
  const source = rich(text("中文 🦆"), text("<p>hi</p>", "text/html"), image());
  const value = validateClipboardRequest("writeClipboard", source);
  source.items[0].entries[0].text = "changed";
  assert.equal(value.items[0].entries[0].text, "中文 🦆");
  assert.equal(value.items[0].presentation_style, "unspecified");
  assert.equal(value.timeoutMs, 10000); assert.equal(value.maxBytes, MAX_BYTES);
  for (const part of [value, value.items, value.items[0], value.items[0].entries, ...value.items[0].entries]) assert.ok(Object.isFrozen(part));
  assert.deepEqual(Object.keys(value).sort(), ["session_id", "turn_id", "control_epoch", "tabId", "timeoutMs", "maxBytes", "items"].sort());
  for (const style of ["unspecified", "inline", "attachment"]) {
    const params = rich(text("")); params.items[0].presentation_style = style;
    assert.equal(validateClipboardRequest("writeClipboard", params).items[0].presentation_style, style);
  }
  assert.equal(validateClipboardRequest("writeClipboardText", request({ text: "" })).text, "");
});

test("scope, timeout, size and method fields reject invalid or ambiguous requests", () => {
  for (const method of ["clipboard.read", "read_clipboard", "toString", "", undefined]) assert.throws(() => validateClipboardRequest(method, request()), /OBU_CLIPBOARD_INVALID/);
  for (const extra of [{ session_id: "" }, { session_id: 7 }, { session_id: "x".repeat(4097) }, { turn_id: "\ud800" }, { control_epoch: 0 }, { control_epoch: undefined }, { control_epoch: 1.5 }, { control_epoch: Number.MAX_SAFE_INTEGER + 1 }, { tabId: -1 }, { tabId: "7" }, { tabId: NaN }, { target: { tabId: 7 } }, { text: "read has no payload" }]) assert.throws(() => validateClipboardRequest("readClipboardText", request(extra)), /OBU_CLIPBOARD_(INVALID|LIMIT)/);
  for (const timeoutMs of [null, 0, -1, 120001, 1.5, "100", Infinity, NaN]) assert.throws(() => validateClipboardRequest("readClipboard", request({ timeoutMs })), /OBU_CLIPBOARD_INVALID/);
  for (const maxBytes of [null, 0, -1, MAX_BYTES + 1, 1.5, "100", Infinity]) assert.throws(() => validateClipboardRequest("readClipboard", request({ maxBytes })), /OBU_CLIPBOARD_INVALID/);
  for (const params of [null, [], {}, Object.create(request())]) assert.throws(() => validateClipboardRequest("readClipboard", params), /OBU_CLIPBOARD_INVALID/);
  assert.equal(validateClipboardRequest("readClipboard", request({ timeoutMs: 1, maxBytes: 1, tabId: 0 })).timeoutMs, 1);
  assert.equal(validateClipboardRequest("readClipboard", request({ timeoutMs: 120000 })).timeoutMs, 120000);
});

test("rich clipboard rejects unknown fields, duplicate MIME, missing or mixed representations", () => {
  const invalidItems = [null, {}, [item()], [item(text("one")), item(text("two"))], [item(text("a"), text("b"))],
    [item({ mime_type: "text/plain", base64: "YQ==" })], [item({ mime_type: "text/html", text: "a", base64: "YQ==" })],
    [item({ mime_type: "image/png", text: "not binary" })], [item({ mime_type: "image/jpeg", base64: PNG })],
    [item({ mime_type: "text/plain;charset=utf-8", text: "a" })], [item({ mimeType: "text/plain", text: "a" })],
    [item({ mime_type: "text/plain", text: "a", extra: false })], [item({ mime_type: "text/plain" })],
    [{ ...item(text("a")), extra: false }], [{ ...item(text("a")), presentation_style: null }], [{ ...item(text("a")), presentation_style: "unknown" }],
    [item(text("a"), text("a", "text/html"), image(), text("too many"))]];
  for (const items of invalidItems) assert.throws(() => validateClipboardRequest("writeClipboard", request({ items })), /OBU_CLIPBOARD_INVALID/);
  assert.throws(() => validateClipboardRequest("writeClipboardText", request({ text: "hi", items: [] })), /OBU_CLIPBOARD_INVALID/);
  assert.throws(() => validateClipboardRequest("writeClipboard", request({ items: [], text: "hi" })), /OBU_CLIPBOARD_INVALID/);
});

test("non-wire accessors, sparse arrays and symbol fields cannot execute or sneak through validation", () => {
  let getterCalled = false;
  const accessor = request(); Object.defineProperty(accessor, "text", { enumerable: true, get() { getterCalled = true; return "bad"; } });
  assert.throws(() => validateClipboardRequest("writeClipboardText", accessor), /OBU_CLIPBOARD_INVALID/);
  assert.equal(getterCalled, false);
  for (const items of [new Array(1), Object.assign([], { extra: 1 }), [Object.assign(item(text("a")), { [Symbol("extra")]: 1 })]]) assert.throws(() => validateClipboardRequest("writeClipboard", request({ items })), /OBU_CLIPBOARD_INVALID/);
  const entries = [text("a")]; Object.defineProperty(entries, "0", { get() { getterCalled = true; return text("bad"); } });
  assert.throws(() => validateClipboardRequest("writeClipboard", request({ items: [{ entries }] })), /OBU_CLIPBOARD_INVALID/);
  assert.equal(getterCalled, false);
});

test("text rejects lone surrogates and counts UTF-8 bytes cumulatively across representations", () => {
  for (const value of ["\ud800", "\udfff", "a\ud800b", "\ud800\ud800", "\udfff\ud800"]) {
    assert.throws(() => validateClipboardRequest("writeClipboardText", request({ text: value })), /OBU_CLIPBOARD_INVALID/);
    assert.throws(() => validateClipboardRequest("writeClipboard", rich(text(value, "text/html"))), /OBU_CLIPBOARD_INVALID/);
    assert.throws(() => validateClipboardResult("readClipboardText", { text: value }), /OBU_CLIPBOARD_FAILED/);
  }
  assert.equal(validateClipboardRequest("writeClipboardText", request({ text: "中🦆", maxBytes: 7 })).text, "中🦆");
  assert.throws(() => validateClipboardRequest("writeClipboardText", request({ text: "中🦆", maxBytes: 6 })), /OBU_CLIPBOARD_LIMIT/);
  const value = rich(text("中"), text("文", "text/html"), image());
  const exact = 6 + Buffer.from(PNG, "base64").length;
  assert.equal(validateClipboardRequest("writeClipboard", { ...value, maxBytes: exact }).items[0].entries.length, 3);
  assert.throws(() => validateClipboardRequest("writeClipboard", { ...value, maxBytes: exact - 1 }), /OBU_CLIPBOARD_LIMIT/);
  assert.throws(() => validateClipboardResult("readClipboard", { items: value.items }, exact - 1), /OBU_CLIPBOARD_LIMIT/);
});

test("PNG accepts only canonical base64 and a bounded plausible header, not other image types", () => {
  for (const base64 of ["", PNG.slice(0, -1), `${PNG}\n`, PNG.replace("+", "-").replace("/", "_"), "A===", "AB==", "YWJj", Buffer.from("GIF89a").toString("base64")]) assert.throws(() => validateClipboardRequest("writeClipboard", rich(image(base64))), /OBU_CLIPBOARD_INVALID/);
  const changed = mutate => { const bytes = Buffer.from(PNG, "base64"); mutate(bytes); return bytes.toString("base64"); };
  for (const base64 of [changed(b => { b[0] = 0; }), changed(b => b.writeUInt32BE(14, 8)), changed(b => b.writeUInt32BE(0, 16)), changed(b => b.writeUInt32BE(0, 20)), changed(b => { b[25] = 1; }), changed(b => { b[24] = 3; }), changed(b => { b[26] = 1; }), changed(b => { b[27] = 1; }), changed(b => { b[28] = 2; })]) assert.throws(() => validateClipboardRequest("writeClipboard", rich(image(base64))), /OBU_CLIPBOARD_INVALID/);
  assert.throws(() => validateClipboardRequest("writeClipboard", rich(image(changed(b => { b.writeUInt32BE(4097, 16); b.writeUInt32BE(4096, 20); })))), /OBU_CLIPBOARD_LIMIT/);
  assert.throws(() => validateClipboardRequest("writeClipboard", rich(image(changed(b => { b.writeUInt32BE(0xffffffff, 16); b.writeUInt32BE(0xffffffff, 20); })))), /OBU_CLIPBOARD_LIMIT/);
  assert.ok(validateClipboardRequest("writeClipboard", rich(image(changed(b => { b.writeUInt32BE(4096, 16); b.writeUInt32BE(4096, 20); })))));
});

test("strict result validation has no empty fallback and never echoes malformed native contents", () => {
  for (const value of [undefined, null, "secret", {}, { text: 7 }, { text: "ok", other: "secret" }, []]) assert.throws(() => validateClipboardResult("readClipboardText", value), /^Error: OBU_CLIPBOARD_FAILED: native clipboard returned invalid data$/);
  for (const value of [undefined, {}, { items: null }, { items: [item({ mime_type: "custom/private", text: "secret" })] }, { items: [], extra: "secret" }]) assert.throws(() => validateClipboardResult("readClipboard", value), /OBU_CLIPBOARD_FAILED/);
  assert.deepEqual(validateClipboardResult("readClipboardText", { text: "" }), { text: "" });
  assert.deepEqual(validateClipboardResult("readClipboard", { items: [] }), { items: [] });
  for (const value of [undefined, null, { ok: true }, { error: "secret" }, []]) assert.throws(() => validateClipboardResult("writeClipboard", value), /OBU_CLIPBOARD_FAILED/);
  assert.deepEqual(validateClipboardResult("writeClipboardText", {}), {});
  assert.throws(() => validateClipboardResult("readClipboardText", { text: "abc" }, 2), /OBU_CLIPBOARD_LIMIT/);
});

test("actual normalized JSON request and result accept the 48 MiB boundary and reject one extra encoded byte", () => {
  const fill = (make, target) => {
    const available = target - Buffer.byteLength(JSON.stringify(make("")));
    const value = "\0".repeat(Math.floor(available / 6)) + "x".repeat(available % 6);
    assert.ok(Buffer.byteLength(value) < MAX_BYTES);
    assert.equal(Buffer.byteLength(JSON.stringify(make(value))), target);
    return value;
  };
  const normalized = validateClipboardRequest("writeClipboardText", request({ text: "" }));
  const requestText = fill(value => ({ ...normalized, text: value }), MAX_JSON_BYTES);
  assert.equal(validateClipboardRequest("writeClipboardText", { ...normalized, text: requestText }).text, requestText);
  assert.throws(() => validateClipboardRequest("writeClipboardText", { ...normalized, text: `${requestText}x` }), /OBU_CLIPBOARD_LIMIT/);
  const resultText = fill(value => ({ text: value }), MAX_JSON_BYTES);
  assert.equal(validateClipboardResult("readClipboardText", { text: resultText }).text, resultText);
  assert.throws(() => validateClipboardResult("readClipboardText", { text: `${resultText}x` }), /OBU_CLIPBOARD_LIMIT/);
});

test("HTML control-character expansion is rejected before dispatch or returning a partial read", () => {
  const value = `<b>${"\u0001".repeat(MAX_BYTES - 7)}</b>`;
  assert.equal(Buffer.byteLength(value), MAX_BYTES);
  const payload = rich(text(value, "text/html"));
  assert.ok(Buffer.byteLength(JSON.stringify(payload)) > 64 * 1024 * 1024);
  const f = fixture();
  assert.throws(() => f.clipboard.reserve("writeClipboard", payload), /OBU_CLIPBOARD_LIMIT/);
  assert.equal(f.calls.length, 0); assert.equal(f.clipboard.records.size, 0);
  assert.throws(() => validateClipboardResult("readClipboard", { items: payload.items }), /OBU_CLIPBOARD_LIMIT/);
});

test("the Go relay's HTML and Unicode escapes also count toward the exact encoded limit", () => {
  const goJSON = value => JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
  const prefix = "<>&\u2028\u2029";
  const normalized = validateClipboardRequest("writeClipboard", rich(text("", "text/html")));
  const make = value => ({ ...normalized, items: [{ presentation_style: "unspecified", entries: [text(value, "text/html")] }] });
  const available = MAX_JSON_BYTES - Buffer.byteLength(goJSON(make(prefix)));
  const value = prefix + "&".repeat(Math.floor(available / 6)) + "x".repeat(available % 6);
  assert.ok(Buffer.byteLength(value) < MAX_BYTES);
  assert.ok(Buffer.byteLength(JSON.stringify(make(value))) < MAX_JSON_BYTES);
  assert.equal(Buffer.byteLength(goJSON(make(value))), MAX_JSON_BYTES);
  assert.equal(validateClipboardRequest("writeClipboard", make(value)).items[0].entries[0].text, value);
  assert.throws(() => validateClipboardRequest("writeClipboard", make(`${value}x`)), /OBU_CLIPBOARD_LIMIT/);
  const unescapedHTML = "<".repeat(MAX_BYTES);
  assert.ok(Buffer.byteLength(JSON.stringify({ text: unescapedHTML })) < MAX_JSON_BYTES);
  assert.throws(() => validateClipboardResult("readClipboardText", { text: unescapedHTML }), /OBU_CLIPBOARD_LIMIT/);
});

test("a complete 16 MiB PNG encoded as base64 still fits the separate JSON transport limit", () => {
  // A valid 1x1 RGBA PNG with a large ancillary text chunk. This tests the
  // full decoded-byte allowance without inventing a huge pixel allocation.
  const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
    let crc = index;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    return crc >>> 0;
  });
  const chunk = (type, data) => {
    const value = Buffer.alloc(data.length + 12);
    value.writeUInt32BE(data.length); value.write(type, 4, "ascii"); data.copy(value, 8);
    let crc = 0xffffffff;
    for (let index = 4; index < value.length - 4; index++) crc = crcTable[(crc ^ value[index]) & 255] ^ (crc >>> 8);
    value.writeUInt32BE((crc ^ 0xffffffff) >>> 0, value.length - 4);
    return value;
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(1); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  const ihdr = chunk("IHDR", header), idat = chunk("IDAT", deflateSync(Buffer.from([0, 255, 0, 0, 255]))), iend = chunk("IEND", Buffer.alloc(0));
  const ancillary = Buffer.alloc(MAX_BYTES - 8 - ihdr.length - idat.length - iend.length - 12, 65);
  ancillary.write("Comment\0", 0, "ascii");
  const bytes = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), ihdr, chunk("tEXt", ancillary), idat, iend]);
  assert.equal(bytes.length, MAX_BYTES);
  const base64 = bytes.toString("base64"), params = rich(image(base64));
  const value = validateClipboardRequest("writeClipboard", params);
  assert.equal(value.items[0].entries[0].base64, base64);
  assert.ok(Buffer.byteLength(JSON.stringify(value)) < MAX_JSON_BYTES);
  assert.equal(validateClipboardResult("readClipboard", { items: params.items }).items[0].entries[0].base64, base64);
});

test("all four methods run through the trusted adapter with immutable payload and exact scope", async () => {
  const f = fixture();
  for (const [method, extra] of [["readClipboardText", {}], ["readClipboard", {}], ["writeClipboardText", { text: "hello" }], ["writeClipboard", { items: [item(text("rich"), image())] }]]) {
    const { record, result } = f.launch(method, extra);
    const output = await result, call = f.calls.at(-1);
    assert.equal(call.method, method); assert.equal(call.bound.attachment, record.scope.attachment);
    assert.equal(call.flags.deadlineAt, record.deadlineAt); assert.equal(typeof call.flags.check, "function");
    assert.ok(Object.isFrozen(call.params)); assert.equal(f.clipboard.records.size, 0);
    assert.deepEqual(Object.keys(output), method === "readClipboardText" ? ["text"] : method === "readClipboard" ? ["items"] : []);
  }
  await tick(); assert.equal(f.clipboard.controlSnapshot().pending.length, 0);
});

test("outer admission and inner run share the original deadline and retire only after outer completion", async () => {
  let now = 100;
  const f = fixture({ now: () => now }), record = f.clipboard.reserve("readClipboardText", request({ timeoutMs: 200 }));
  const output = await f.clipboard.within(record, async () => {
    now += 60;
    const value = await f.clipboard.run(record, scope(record.params));
    assert.equal(f.clipboard.records.has(record), true);
    assert.throws(() => f.clipboard.reserve("readClipboardText", request()), /OBU_CLIPBOARD_BUSY/);
    now += 60;
    return value;
  });
  assert.equal(output.text, "中文 🦆"); assert.equal(f.calls[0].flags.deadlineAt, 300);
  assert.equal(f.clipboard.records.size, 0); assert.equal(f.clipboard.controlSnapshot().pending.length, 0);
});

test("zero rich items validate ownership and succeed without a clipboard access or implicit clear", async () => {
  const f = fixture(); let validations = 0; f.hooks.validate = () => { validations++; };
  assert.deepEqual(await f.launch("writeClipboard", { items: [] }).result, {});
  assert.equal(f.calls.length, 0); assert.equal(validations, 2);
  f.retireScope(); await assert.rejects(f.launch("writeClipboard", { items: [] }).result, /scope retired/);
  assert.equal(f.calls.length, 0);
});

test("global busy applies across tabs and sessions until real native completion, even after cancellation", async () => {
  const f = fixture(), gate = deferred(), entered = deferred();
  f.hooks.execute = async () => { entered.resolve(); return gate.promise; };
  const { record, result } = f.launch(); const rejected = assert.rejects(result, /OBU_CLIPBOARD_CANCELLED/); await entered.promise;
  let drained = false; const draining = f.clipboard.cancel(record).then(() => { drained = true; });
  await rejected; assert.equal(drained, false);
  assert.throws(() => f.clipboard.reserve("readClipboardText", request({ tabId: 8, session_id: "two" })), /OBU_CLIPBOARD_BUSY/);
  assert.deepEqual([...f.clipboard.controlSnapshot().tabIds], [7]); assert.ok(f.clipboard.controlSnapshot().pending.length);
  gate.resolve({ text: "late private content" }); await draining; await tick();
  assert.equal(f.clipboard.records.size, 0); assert.equal(f.clipboard.controlSnapshot().pending.length, 0);
  assert.ok(f.clipboard.reserve("readClipboardText", request({ tabId: 8 })));
  await f.clipboard.invalidateAll();
});

test("an unbound timed-out admission retains the single slot without cleanup waiting on itself", async () => {
  const f = fixture(), gate = deferred(), entered = deferred();
  const record = f.clipboard.reserve("readClipboardText", request({ timeoutMs: 20 }));
  const result = f.clipboard.within(record, async () => { entered.resolve(); await gate.promise; return f.clipboard.run(record, scope(record.params)); });
  await entered.promise; await assert.rejects(result, /OBU_CLIPBOARD_TIMEOUT/);
  await f.clipboard.invalidateAll();
  assert.equal(f.calls.length, 0); assert.ok(f.clipboard.controlSnapshot().pending.length);
  assert.throws(() => f.clipboard.reserve("readClipboardText", request()), /OBU_CLIPBOARD_BUSY/);
  gate.resolve(); await Promise.allSettled(f.clipboard.controlSnapshot().pending); await tick();
  assert.equal(f.calls.length, 0); assert.equal(f.clipboard.records.size, 0);
});

test("native timeout is timely but does not claim that an already dispatched write was undone", async () => {
  const f = fixture(), native = deferred(), entered = deferred(); let writesCompleted = 0;
  f.hooks.execute = async (_scope, _method, _params, flags) => { flags.check(); entered.resolve(); await native.promise; writesCompleted++; return {}; };
  const { result } = f.launch("writeClipboardText", { text: "requested once", timeoutMs: 20 }); await entered.promise;
  await assert.rejects(result, /OBU_CLIPBOARD_TIMEOUT/);
  let drained = false; const draining = f.clipboard.invalidateAll().then(() => { drained = true; });
  await tick(); assert.equal(drained, false); assert.equal(f.calls.length, 1);
  native.resolve(); await draining; await tick();
  assert.equal(writesCompleted, 1); assert.equal(f.calls.length, 1); assert.equal(f.clipboard.records.size, 0);
});

test("adapter pre-native check prevents a delayed decode from dispatching after cancellation", async () => {
  const f = fixture(), decoding = deferred(), entered = deferred(); let nativeCalls = 0;
  f.hooks.execute = async (_scope, _method, _params, flags) => { entered.resolve(); await decoding.promise; flags.check(); nativeCalls++; return {}; };
  const { record, result } = f.launch("writeClipboard", { items: [item(image())] });
  const rejected = assert.rejects(result, /OBU_CLIPBOARD_CANCELLED/); await entered.promise;
  const cleanup = f.clipboard.cancel(record); await rejected;
  assert.equal(nativeCalls, 0); decoding.resolve(); await cleanup;
  assert.equal(nativeCalls, 0); assert.equal(f.clipboard.records.size, 0);
});

test("deadline includes adapter decoding and post-native validation", async () => {
  for (const phase of ["decode", "native result", "final scope"]) {
    let now = 0, nativeCalls = 0, validations = 0;
    const f = fixture({ now: () => now });
    f.hooks.execute = async (_scope, _method, _params, flags) => {
      if (phase === "decode") now = 100;
      flags.check(); nativeCalls++;
      if (phase === "native result") now = 100;
      return { text: "answer" };
    };
    f.hooks.validate = () => { if (++validations === 2 && phase === "final scope") now = 100; };
    await assert.rejects(f.launch("readClipboardText", { timeoutMs: 100 }).result, /OBU_CLIPBOARD_TIMEOUT/);
    await f.clipboard.invalidateAll();
    assert.equal(nativeCalls, phase === "decode" ? 0 : 1); assert.equal(f.clipboard.records.size, 0);
  }
});

test("request validation time and post-run outer admission time do not refresh the deadline", async () => {
  let calls = 0;
  const f = fixture({ now: () => ++calls === 1 ? 0 : 10 });
  assert.throws(() => f.clipboard.reserve("writeClipboardText", request({ text: "body", timeoutMs: 10 })), /OBU_CLIPBOARD_TIMEOUT/);
  assert.equal(f.clipboard.records.size, 0);
  let now = 0; const g = fixture({ now: () => now });
  const record = g.clipboard.reserve("readClipboardText", request({ timeoutMs: 100 }));
  await assert.rejects(g.clipboard.within(record, async () => { const value = await g.clipboard.run(record, scope(record.params)); now = 100; return value; }), /OBU_CLIPBOARD_TIMEOUT/);
  assert.equal(g.clipboard.records.size, 0); assert.equal(g.calls.length, 1);
});

test("revocation during asynchronous scope inspection prevents native access and drains the real inspection", async () => {
  const f = fixture(), validating = deferred(), entered = deferred();
  f.hooks.validate = async () => { entered.resolve(); await validating.promise; };
  const { result } = f.launch(); const rejected = assert.rejects(result, /OBU_CLIPBOARD_CANCELLED/); await entered.promise;
  let drained = false; const cleanup = f.clipboard.invalidateSession("one").then(() => { drained = true; });
  await rejected; assert.equal(drained, false); assert.equal(f.calls.length, 0);
  validating.resolve(); await cleanup; assert.equal(f.calls.length, 0);
});

test("final live ownership validation suppresses a stale read without retrying or undoing a write", async () => {
  for (const method of ["readClipboardText", "writeClipboardText"]) {
    const f = fixture(); let validations = 0;
    f.hooks.validate = () => { if (++validations === 2) f.retireScope(); };
    await assert.rejects(f.launch(method, method === "writeClipboardText" ? { text: "once" } : {}).result, /scope retired/);
    await f.clipboard.invalidateAll(); assert.equal(f.calls.length, 1); assert.equal(f.clipboard.records.size, 0);
  }
});

test("bound scope identity must match all request scope fields and adapter failures remain failures", async () => {
  for (const mismatch of [{ session_id: "two" }, { turn_id: "late" }, { control_epoch: 2 }, { tabId: 8 }]) {
    const f = fixture(), record = f.clipboard.reserve("readClipboardText", request());
    await assert.rejects(f.clipboard.run(record, { ...scope(record.params), ...mismatch }), /OBU_CLIPBOARD_CANCELLED/);
    assert.equal(f.calls.length, 0); assert.equal(f.clipboard.records.size, 0);
  }
  const f = fixture(), failure = new Error("native permission denied"); f.hooks.execute = () => { throw failure; };
  await assert.rejects(f.launch().result, error => error === failure);
  await f.clipboard.invalidateAll(); assert.equal(f.calls.length, 1); assert.equal(f.clipboard.records.size, 0);
});

test("a plausible PNG header cannot bypass a real decode failure in the adapter", async () => {
  const f = fixture(); let writes = 0;
  f.hooks.execute = async () => { throw new Error("PNG decode failed"); };
  await assert.rejects(f.launch("writeClipboard", { items: [item(image(Buffer.from(PNG, "base64").subarray(0, 33).toString("base64")))] }).result, /PNG decode failed/);
  assert.equal(writes, 0); assert.equal(f.calls.length, 1); assert.equal(f.clipboard.records.size, 0);
});

test("read result validation rejects oversized and unsupported native data rather than partial success", async () => {
  for (const [method, result, maxBytes, code] of [["readClipboardText", { text: "abc" }, 2, "LIMIT"], ["readClipboardText", undefined, 10, "FAILED"], ["readClipboard", { items: [item(text("a")), item(text("b"))] }, 10, "FAILED"], ["readClipboard", { items: [item(image())] }, 10, "LIMIT"], ["writeClipboardText", undefined, 10, "FAILED"]]) {
    const f = fixture(); f.hooks.execute = async () => result;
    await assert.rejects(f.launch(method, { maxBytes, ...(method === "writeClipboardText" ? { text: "a" } : {}) }).result, new RegExp(`OBU_CLIPBOARD_${code}`));
    await f.clipboard.invalidateAll(); assert.equal(f.clipboard.records.size, 0);
  }
});

test("setup migration preserves only the exact unbound reservation; bound records always invalidate", async () => {
  const f = fixture(), record = f.clipboard.reserve("readClipboardText", request());
  await f.clipboard.invalidateTab(7, record); await f.clipboard.invalidateAttachedTab(7);
  assert.equal(record.invalid, false); assert.equal(f.clipboard.records.size, 1);
  await f.clipboard.invalidateTab(7, {}); assert.equal(record.invalid, true); assert.equal(f.clipboard.records.size, 0);
  const g = fixture(), gate = deferred(), entered = deferred();
  g.hooks.execute = async () => { entered.resolve(); return gate.promise; };
  const next = g.launch(), rejected = assert.rejects(next.result, /OBU_CLIPBOARD_CANCELLED/); await entered.promise;
  const cleanup = g.clipboard.invalidateTab(7, next.record); await rejected;
  assert.equal(next.record.invalid, true); gate.resolve({ text: "late" }); await cleanup;
});

test("exact attachment and document invalidation cannot cancel a successor or a foreign tab", async () => {
  const f = fixture(), gate = deferred(), entered = deferred(); f.hooks.execute = async () => { entered.resolve(); return gate.promise; };
  const { record, result } = f.launch(); await entered.promise;
  await f.clipboard.invalidateAttachment(7, {}); await f.clipboard.invalidateAttachment(8, record.scope.attachment); await f.clipboard.invalidateSession("other");
  assert.equal(record.invalid, false);
  const error = new Error("document changed"), rejected = assert.rejects(result, /document changed/);
  const cleanup = f.clipboard.invalidateAttachment(7, record.scope.attachment, error); await rejected;
  gate.resolve({ text: "late" }); await cleanup; assert.equal(f.clipboard.records.size, 0);
  const next = f.clipboard.reserve("readClipboardText", request());
  await f.clipboard.invalidateAttachedTab(7, error); assert.equal(next.invalid, false);
  await f.clipboard.invalidateAll();
});

test("synchronous cancel before run or admission dispatch never starts the adapter", async () => {
  const f = fixture(), record = f.clipboard.reserve("readClipboardText", request());
  const output = f.clipboard.within(record, () => f.clipboard.run(record, scope(record.params)));
  const rejected = assert.rejects(output, /OBU_CLIPBOARD_CANCELLED/);
  await f.clipboard.cancel(record); await rejected; await tick();
  assert.equal(f.calls.length, 0); assert.equal(f.clipboard.records.size, 0); assert.equal(f.clipboard.controlSnapshot().pending.length, 0);
});
