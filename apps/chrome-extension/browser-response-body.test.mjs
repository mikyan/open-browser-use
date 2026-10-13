import assert from "node:assert/strict";
import { test } from "node:test";
import { readResponseBody, validateResponseBodyArgs, DEFAULT_RESPONSE_BODY_BYTES, MAX_RESPONSE_BODY_BYTES } from "./browser-response-body.js";

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture(result = { body: "original", base64Encoded: false }) {
  const listeners = new Set(), controller = new AbortController();
  let valid = true, calls = 0, checked = 0;
  const reference = { captureId: "capture", requestId: "request-1", response: {},
    check() { if (!valid) throw new Error("OBU_RESPONSE_BODY_EXPIRED: original evicted"); },
    onInvalidated(callback) { listeners.add(callback); return () => listeners.delete(callback); }
  };
  const options = { reference, readNative: { finished: Promise.resolve(), read: check => { calls++; check(); return Promise.resolve(result); } },
    check() { checked++; }, checkSync() {}, signal: controller.signal, deadlineAt: performance.now() + 10000 };
  return { options, reference, controller, listeners, calls: () => calls, checked: () => checked,
    invalidate() { valid = false; for (const callback of listeners) callback(new Error("OBU_RESPONSE_BODY_EXPIRED: original evicted")); } };
}

test("strict arguments keep bounded well-formed diagnostic identities and explicit maxBytes", () => {
  const valid = { captureId: "🧪".repeat(32), requestId: "request-1" };
  assert.deepEqual(validateResponseBodyArgs(valid), { ...valid, maxBytes: DEFAULT_RESPONSE_BODY_BYTES });
  assert.ok(Object.isFrozen(validateResponseBodyArgs(valid)));
  for (const changes of [{ captureId: "" }, { requestId: "" }, { captureId: "🧪".repeat(33) }, { requestId: "\ud800" }, { maxBytes: null }, { maxBytes: 0 }, { maxBytes: 1.5 }, { maxBytes: MAX_RESPONSE_BODY_BYTES + 1 }, { maxBytes: Infinity }, { unknown: true }])
    assert.throws(() => validateResponseBodyArgs({ ...valid, ...changes }), /RESPONSE_BODY_INVALID/);
  for (const invalid of [null, [], "x"]) assert.throws(() => validateResponseBodyArgs(invalid), /INVALID/);
});

test("original text, binary, and empty body produce exactly five fields without a body cache", async () => {
  for (const [native, bytes] of [[{ body: "你好\u0000🧪", base64Encoded: false }, Buffer.from("你好\u0000🧪")],
    [{ body: "AP/+AA==", base64Encoded: true }, Buffer.from([0, 255, 254, 0])], [{ body: "", base64Encoded: false }, Buffer.alloc(0)], [{ body: "", base64Encoded: true }, Buffer.alloc(0)]]) {
    const f = fixture(native), result = await readResponseBody(f.options);
    assert.deepEqual(result, { captureId: "capture", requestId: "request-1", encoding: "base64", data: bytes.toString("base64"), byteLength: bytes.length });
    assert.equal(f.calls(), 1); assert.equal(f.listeners.size, 0);
  }
});

test("original finish can be awaited without sending a body request early", async () => {
  const f = fixture(), finish = deferred(); f.options.readNative.finished = finish.promise;
  const result = readResponseBody(f.options); await flush(); assert.equal(f.calls(), 0);
  finish.resolve(); assert.equal((await result).byteLength, 8); assert.equal(f.calls(), 1);
});

test("eviction, cancellation and original deadline stop unfinished reads without any native request", async () => {
  for (const kind of ["evict", "abort", "timeout"]) {
    const f = fixture(), finish = deferred(); f.options.readNative.finished = finish.promise;
    if (kind === "timeout") f.options.deadlineAt = performance.now() + 15;
    const result = readResponseBody(f.options); const rejected = assert.rejects(result, /RESPONSE_BODY_(EXPIRED|TIMEOUT)/);
    if (kind === "evict") f.invalidate();
    if (kind === "abort") f.controller.abort(new Error("OBU_RESPONSE_BODY_EXPIRED: turn ended"));
    await rejected; finish.resolve(); await flush(); assert.equal(f.calls(), 0); assert.equal(f.listeners.size, 0);
  }
});

test("already cancelled or expired admission cannot register a late native request", async () => {
  const f = fixture(); f.controller.abort();
  await assert.rejects(readResponseBody(f.options)); assert.equal(f.calls(), 0);
  const expired = fixture(); expired.options.deadlineAt = performance.now() - 1;
  await assert.rejects(readResponseBody(expired.options), /TIMEOUT/); assert.equal(expired.calls(), 0);
});

test("public cancellation returns promptly but cannot settle or retry the caller-tracked actual native promise", async () => {
  const f = fixture(), native = deferred(); let actualSettled = false, calls = 0;
  native.promise.finally(() => { actualSettled = true; });
  f.options.readNative.read = check => { calls++; check(); return native.promise; };
  const result = readResponseBody(f.options); await flush();
  f.controller.abort(new Error("OBU_RESPONSE_BODY_EXPIRED: turn ended"));
  await assert.rejects(result, /EXPIRED/); assert.equal(actualSettled, false); assert.equal(calls, 1);
  native.resolve({ body: "late bytes", base64Encoded: false }); await flush();
  assert.equal(actualSettled, true); assert.equal(calls, 1);
});

test("async native admission uses the original checkpoint and cannot send after eviction", async () => {
  const f = fixture(), gate = deferred(); let nativeCalls = 0;
  f.options.readNative.read = async check => { await gate.promise; check(); nativeCalls++; return { body: "x", base64Encoded: false }; };
  const result = readResponseBody(f.options); await flush(); f.invalidate();
  await assert.rejects(result, /EXPIRED/); gate.resolve(); await flush(); assert.equal(nativeCalls, 0);
});

test("malformed native replies and noncanonical base64 fail without leaking response content", async () => {
  for (const native of [null, {}, { body: "PRIVATE_BODY", base64Encoded: 1 }, { body: "\ud800", base64Encoded: false },
    ...["YQ", "YQ=", "YR==", "YQ==\n", "-_==", "====", "A==="].map(body => ({ body, base64Encoded: true }))]) {
    const f = fixture(native);
    await assert.rejects(readResponseBody(f.options), error => /RESPONSE_BODY_FAILED/.test(error.message) && !error.stack.includes("PRIVATE_BODY"));
    assert.equal(f.calls(), 1);
  }
});

test("byte limits apply to decoded data and UTF8, including the complete 8 MiB boundary", async () => {
  for (const native of [{ body: "你好", base64Encoded: false }, { body: Buffer.from([0, 1, 2, 3]).toString("base64"), base64Encoded: true }]) {
    const f = fixture(native); f.options.maxBytes = 3;
    await assert.rejects(readResponseBody(f.options), /TOO_LARGE/);
  }
  const bytes = Buffer.alloc(MAX_RESPONSE_BODY_BYTES, 123), f = fixture({ body: bytes.toString("base64"), base64Encoded: true });
  f.options.maxBytes = MAX_RESPONSE_BODY_BYTES;
  assert.equal((await readResponseBody(f.options)).data, bytes.toString("base64"));
  const over = fixture({ body: Buffer.alloc(MAX_RESPONSE_BODY_BYTES + 1).toString("base64"), base64Encoded: true });
  over.options.maxBytes = MAX_RESPONSE_BODY_BYTES;
  await assert.rejects(readResponseBody(over.options), /TOO_LARGE/);
});

test("post-native and post-encoding checks reject expired scope and decoding-time deadline", async () => {
  const f = fixture(); let checks = 0;
  f.options.check = () => { if (++checks === 3) throw new Error("OBU_RESPONSE_BODY_EXPIRED: attachment changed"); };
  await assert.rejects(readResponseBody(f.options), /EXPIRED/);
  let clock = 1;
  const g = fixture({ get body() { clock = 100; return "native"; }, base64Encoded: false });
  g.options.now = () => clock; g.options.deadlineAt = 50;
  await assert.rejects(readResponseBody(g.options), /TIMEOUT/);
});

test("asynchronous authorization after response completion must settle before any native read", async () => {
  const f = fixture(), finish = deferred(), admission = deferred(); let checks = 0;
  f.options.readNative.finished = finish.promise;
  f.options.check = async () => { if (++checks === 2) await admission.promise; };
  const reading = readResponseBody(f.options); await flush();
  finish.resolve(); await flush(); assert.equal(checks, 2); assert.equal(f.calls(), 0);
  const rejected = assert.rejects(reading, /scope was revoked/);
  admission.reject(new Error("scope was revoked")); await rejected;
  assert.equal(f.calls(), 0); assert.equal(f.listeners.size, 0);
});

test("cancellation while asynchronous authorization is pending prevents a late native dispatch", async () => {
  const f = fixture(), admission = deferred();
  f.options.check = () => admission.promise;
  const reading = readResponseBody(f.options); await flush();
  f.controller.abort(new Error("OBU_RESPONSE_BODY_EXPIRED: turn ended"));
  await assert.rejects(reading, /EXPIRED/); assert.equal(f.calls(), 0);
  admission.resolve(); await flush(); assert.equal(f.calls(), 0);
});

test("the final synchronous native checkpoint cannot be replaced by earlier asynchronous permission", async () => {
  const f = fixture(), nativeAdmission = deferred(); let revoked = false, sends = 0;
  f.options.checkSync = () => { if (revoked) throw new Error("OBU_RESPONSE_BODY_EXPIRED: original scope changed at native send"); };
  f.options.readNative.read = async guard => { await nativeAdmission.promise; guard(); sends++; return { body: "x", base64Encoded: false }; };
  const reading = readResponseBody(f.options); await flush(); revoked = true; nativeAdmission.resolve();
  await assert.rejects(reading, /changed at native send/); assert.equal(sends, 0);
});
