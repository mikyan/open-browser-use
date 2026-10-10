import assert from "node:assert/strict";
import test from "node:test";
import { NativeMessageReceiver } from "./native-message-receiver.js";

const CHUNK = 512 * 1024;
const MiB = 1024 * 1024;
const WALL_START = 1700000000000;
const envelope = (method, params) => ({ jsonrpc: "2.0", method: `obu.native.${method}`, params });
const request = (extra = {}) => ({ jsonrpc: "2.0", id: "obu:1", method: "executeCdp", params: { text: "界🌏<&>".repeat(120000), timeoutMs: 10000 }, ...extra });
function frames(value = request(), { id = "obu:1", timeoutMs = 10000, deadlineUnixMs = WALL_START + timeoutMs } = {}) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
  assert.ok(bytes.length > MiB);
  const chunks = [];
  for (let offset = 0; offset < bytes.length; offset += CHUNK) chunks.push(envelope("chunk", { id, index: chunks.length, data: bytes.subarray(offset, offset + CHUNK).toString("base64") }));
  return { bytes, start: envelope("start", { id, totalBytes: bytes.length, totalChunks: chunks.length, timeoutMs, deadlineUnixMs }), chunks, commit: envelope("commit", { id, remainingMs: timeoutMs }) };
}
const valid = frames();
function fixture(overrides = {}) {
  let time = 100, wallTime = WALL_START, timerID = 0;
  const sent = [], dispatched = [], timers = new Map(), cleared = [];
  const receiver = new NativeMessageReceiver({
    dispatch: message => dispatched.push(message), send: message => sent.push(message), now: () => time, wallNow: () => wallTime,
    setTimer(callback, delay) { const id = ++timerID; timers.set(id, { callback, delay }); return id; },
    clearTimer(id) { cleared.push(id); timers.delete(id); }, ...overrides
  });
  return { receiver, sent, dispatched, timers, cleared, advance(ms) { time += ms; wallTime += ms; }, advanceMono(ms) { time += ms; }, advanceWall(ms) { wallTime += ms; }, now: () => time, wallNow: () => wallTime };
}
function assemble(env, value = valid) {
  env.receiver.receive(value.start);
  for (const chunk of value.chunks) env.receiver.receive(chunk);
}
function assertError(env, kind = "INVALID", ids = ["obu:1"]) {
  assert.deepEqual(env.sent.map(value => value.id), ids);
  for (const value of env.sent) {
    assert.equal(value.jsonrpc, "2.0");
    assert.equal(value.error.code, -32000);
    assert.match(value.error.message, new RegExp(`^OBU_NATIVE_TRANSPORT_${kind}: [a-z ]+$`));
    assert.ok(value.error.message.length < 120);
  }
  assert.equal(env.receiver.active, null);
  assert.equal(env.timers.size, 0);
  assert.equal(env.dispatched.length, 0);
}

test("ordinary messages keep identity and dispatch without private validation", () => {
  const env = fixture();
  for (const message of [{ jsonrpc: "2.0", id: 3, method: "ping" }, { method: "heartbeat" }, null, [1]]) {
    env.receiver.receive(message);
    assert.equal(env.dispatched.at(-1), message);
  }
  assert.equal(env.sent.length, 0);
  assert.equal(env.timers.size, 0);
});

test("complete multi-chunk UTF-8 request dispatches exactly once after commit", () => {
  const env = fixture();
  env.receiver.receive(valid.start);
  const state = env.receiver.active;
  assert.equal(state.bytes.length, valid.bytes.length);
  assert.equal(env.timers.size, 1);
  for (const chunk of valid.chunks) {
    env.receiver.receive(chunk);
    assert.equal(env.dispatched.length, 0);
  }
  env.receiver.receive(valid.commit);
  assert.deepEqual(env.dispatched, [request()]);
  assert.equal(env.receiver.active, null);
  assert.equal(state.bytes, null);
  assert.equal(env.timers.size, 0);
  env.receiver.receive(valid.commit);
  assert.equal(env.dispatched.length, 1);
  assert.match(env.sent[0].error.message, /OBU_NATIVE_TRANSPORT_INVALID/);
});

test("minimum large message and exact full final chunk both assemble correctly", () => {
  const original = { jsonrpc: "2.0", id: "obu:1", method: "ping" };
  const json = JSON.stringify(original);
  for (const length of [MiB + 1, 2 * MiB]) {
    const value = frames(Buffer.from(json + " ".repeat(length - json.length))), env = fixture();
    assert.equal(value.bytes.length, length);
    assemble(env, value); env.receiver.receive(value.commit);
    assert.deepEqual(env.dispatched, [original]);
  }
});

test("explicit valid timeout is reduced by assembly elapsed time and host remaining budget", () => {
  for (const [elapsed, hostRemaining, expected] of [[120.5, 9900, 9879], [100, 250, 250]]) {
    const env = fixture(); assemble(env); env.advance(elapsed);
    env.receiver.receive(envelope("commit", { id: "obu:1", remainingMs: hostRemaining }));
    assert.equal(env.dispatched[0].params.timeoutMs, expected);
  }
  const env = fixture(), value = frames(request({ params: { text: request().params.text, timeoutMs: 1000.75 } }));
  assemble(env, value); env.advance(100.25); env.receiver.receive(value.commit);
  assert.equal(env.dispatched[0].params.timeoutMs, 900);
});

test("absent or invalid parameter budget remains unchanged for the public RPC validator", () => {
  for (const timeoutMs of [undefined, null, 0, -1, "100", 0.5, 120001]) {
    const params = { text: request().params.text, custom: { untouched: true } };
    if (timeoutMs !== undefined) params.timeoutMs = timeoutMs;
    const env = fixture(), value = frames(request({ params }));
    assemble(env, value); env.advance(50); env.receiver.receive(value.commit);
    assert.deepEqual(env.dispatched[0].params, params);
  }
  const env = fixture(), value = frames(request({ params: [request().params.text] }));
  assemble(env, value); env.receiver.receive(value.commit);
  assert.deepEqual(env.dispatched[0].params, [request().params.text]);
});

test("request budget exhaustion never dispatches even within the assembly deadline", () => {
  const env = fixture(), value = frames(request({ params: { text: request().params.text, timeoutMs: 5 } }));
  assemble(env, value); env.advance(5); env.receiver.receive(value.commit);
  assertError(env, "TIMEOUT");
});

test("queued timer cannot permit an expired commit; final parse time is also charged", () => {
  const env = fixture(); assemble(env); env.advance(10000); env.receiver.receive(valid.commit);
  assertError(env, "TIMEOUT");
  let clock = 0, reads = 0;
  const parsing = fixture({ now: () => { if (clock && ++reads === 3) return 10000; return clock; } });
  assemble(parsing); clock = 1;
  parsing.receiver.receive(valid.commit);
  assertError(parsing, "TIMEOUT");
});

test("absolute deadline rejects a start delayed in Chrome before allocating", () => {
  const env = fixture(); env.advance(10000); env.receiver.receive(valid.start);
  assertError(env, "TIMEOUT");
  assert.deepEqual(env.cleared, []);
});

test("delivery delay shortens the timer and the dispatched action budget", () => {
  const env = fixture(); env.advance(9975); assemble(env);
  assert.equal([...env.timers.values()][0].delay, 25);
  env.advance(15); env.receiver.receive(valid.commit);
  assert.equal(env.dispatched[0].params.timeoutMs, 10);
});

test("host queue plus parse time cannot regain the original larger request budget", () => {
  let mono = 80, wall = WALL_START + 80, parsing = false, reads = 0;
  const env = fixture({ now() {
    if (parsing && ++reads === 3) { mono += 10; wall += 10; }
    return mono;
  }, wallNow: () => wall });
  const value = frames(request({ params: { text: request().params.text, timeoutMs: 100 } }), { timeoutMs: 20, deadlineUnixMs: WALL_START + 100 });
  assemble(env, value); parsing = true;
  env.receiver.receive(envelope("commit", { id: "obu:1", remainingMs: 19 }));
  assert.equal(env.dispatched[0].params.timeoutMs, 9);
});

test("a tighter relative start bound remains effective despite a later absolute deadline", () => {
  const env = fixture(), value = frames(request(), { timeoutMs: 20, deadlineUnixMs: WALL_START + 1000 });
  assemble(env, value); env.advance(15);
  env.receiver.receive(envelope("commit", { id: "obu:1", remainingMs: 100 }));
  assert.equal(env.dispatched[0].params.timeoutMs, 5);
});

test("parse time exhausts commit remaining even when other bounds have time left", () => {
  let time = 0, parsing = false, reads = 0;
  const env = fixture({ now() { if (parsing && ++reads === 3) time += 6; return time; } });
  assemble(env); parsing = true;
  env.receiver.receive(envelope("commit", { id: "obu:1", remainingMs: 5 }));
  assertError(env, "TIMEOUT");
});

test("wall rollback cannot extend the monotonic budget and wall advance expires it", () => {
  const rollback = fixture(), value = frames(request(), { timeoutMs: 100, deadlineUnixMs: WALL_START + 100 });
  assemble(rollback, value); rollback.advanceMono(90); rollback.advanceWall(-5000); rollback.receiver.receive(value.commit);
  assert.equal(rollback.dispatched[0].params.timeoutMs, 10);
  const forward = fixture(); assemble(forward, value); forward.advanceWall(100); forward.receiver.receive(value.commit);
  assertError(forward, "TIMEOUT");
});

test("wall deadline is rechecked after parsing and monotonic rollback fails closed", () => {
  let time = 0, wall = WALL_START, parsing = false, reads = 0;
  const env = fixture({ now() { if (parsing && ++reads === 3) wall += 10000; return time; }, wallNow: () => wall });
  assemble(env); parsing = true; env.receiver.receive(valid.commit); assertError(env, "TIMEOUT");
  const rollback = fixture(); assemble(rollback); rollback.advanceMono(-1); rollback.receiver.receive(valid.commit);
  assertError(rollback, "TIMEOUT");
});

test("timeout clears partial bytes and stale timer cannot affect a successor", () => {
  const env = fixture(); env.receiver.receive(valid.start);
  const state = env.receiver.active, callback = [...env.timers.values()][0].callback;
  env.receiver.receive(valid.chunks[0]); env.advance(10000); callback();
  assertError(env, "TIMEOUT"); assert.equal(state.bytes, null);
  env.sent.length = 0; env.receiver.receive(envelope("start", { ...valid.start.params, deadlineUnixMs: env.wallNow() + 10000 })); callback();
  assert.equal(env.sent.length, 0); assert.ok(env.receiver.active);
  env.receiver.close();
});

test("start bounds reject invalid IDs, sizes, totals and budgets before allocating", () => {
  const invalid = [
    ...["obu:0", "obu:01", "obu:-1", "obu:1x", "obu:123456789012345678901", "private-token", 1, null].map(id => ({ id })),
    ...[0, MiB, MiB + 0.5, 64 * MiB + 1, Infinity, "2000000"].map(totalBytes => ({ totalBytes })),
    ...[0, 1, 1.2, "3"].map(totalChunks => ({ totalChunks })),
    ...[0, -1, 120001, Infinity, NaN, null, "10"].map(timeoutMs => ({ timeoutMs })),
    ...[0, -1, 1.5, Infinity, NaN, null, undefined, "1700000010000", Number.MAX_SAFE_INTEGER + 1].map(deadlineUnixMs => ({ deadlineUnixMs })),
    { unexpected: true }
  ];
  for (const change of invalid) {
    const env = fixture(); env.receiver.receive(envelope("start", { ...valid.start.params, ...change }));
    assertError(env, "INVALID", [Object.hasOwn(change, "id") ? null : "obu:1"]);
  }
});

test("64 MiB is the maximum single allocation and a new start frees it without replacing it", () => {
  const env = fixture(); env.receiver.receive(envelope("start", { id: "obu:12345678901234567890", totalBytes: 64 * MiB, totalChunks: 128, timeoutMs: 120000, deadlineUnixMs: WALL_START + 120000 }));
  const state = env.receiver.active;
  assert.equal(state.bytes.length, 64 * MiB);
  env.receiver.receive(valid.start);
  assertError(env, "CONFLICT", ["obu:12345678901234567890", "obu:1"]);
  assert.equal(state.bytes, null);
});

test("private messages require the exact notification envelope and known methods", () => {
  for (const message of [
    { ...valid.start, id: "obu:1" }, { ...valid.start, jsonrpc: "1.0" }, { ...valid.start, extra: true },
    { method: "obu.native.start", params: valid.start.params },
    envelope("hello", { id: "obu:1" }), envelope("anything", { id: "secret invalid id" }),
    envelope("chunk", null)
  ]) {
    const env = fixture(); env.receiver.receive(message);
    assertError(env, "INVALID", [message.params?.id === "obu:1" ? "obu:1" : null]);
    assert.ok(!JSON.stringify(env.sent).includes("secret"));
  }
});

test("out-of-order, duplicate, negative and fractional chunks discard the assembly", () => {
  for (const index of [1, -1, 0.5, "0", Infinity]) {
    const env = fixture(); env.receiver.receive(valid.start);
    env.receiver.receive(envelope("chunk", { ...valid.chunks[0].params, index }));
    assertError(env);
  }
  const env = fixture(); env.receiver.receive(valid.start); env.receiver.receive(valid.chunks[0]); env.receiver.receive(valid.chunks[0]); assertError(env);
});

test("cross-ID messages reject both bounded IDs and do not start the second request", () => {
  for (const message of [
    envelope("chunk", { ...valid.chunks[0].params, id: "obu:2" }),
    envelope("commit", { id: "obu:2", remainingMs: 100 }),
    envelope("abort", { id: "obu:2" }),
    envelope("start", { ...valid.start.params, id: "obu:2" })
  ]) {
    const env = fixture(); env.receiver.receive(valid.start); env.receiver.receive(message);
    assertError(env, "CONFLICT", ["obu:1", "obu:2"]);
  }
});

test("ordinary same-ID request is rejected instead of executing alongside assembly", () => {
  const env = fixture(); env.receiver.receive(valid.start);
  env.receiver.receive({ jsonrpc: "2.0", id: "obu:1", method: "dangerousOperation" });
  assertError(env, "CONFLICT");
  const other = fixture(); other.receiver.receive(valid.start);
  const small = { jsonrpc: "2.0", id: "obu:2", method: "ping" };
  other.receiver.receive(small);
  for (const chunk of valid.chunks) other.receiver.receive(chunk);
  other.receiver.receive(valid.commit);
  assert.equal(other.dispatched[0], small);
  assert.equal(other.dispatched[1].id, "obu:1");
});

test("canonical base64 rejects whitespace, URL-safe alphabet and nonzero padding bits", () => {
  const first = valid.chunks[0].params.data;
  const lastSymbol = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  // 512 KiB has one '='; the final symbol's two unused bits must be zero.
  const paddingIndex = lastSymbol.indexOf(first.at(-2));
  const noncanonical = first.slice(0, -2) + lastSymbol[paddingIndex + 1] + "=";
  for (const data of [first.slice(0, -1), " " + first.slice(1), "-" + first.slice(1), "_" + first.slice(1), noncanonical, first.slice(0, -1) + "A", "!" + first.slice(1)]) {
    const env = fixture(); env.receiver.receive(valid.start); env.receiver.receive(envelope("chunk", { id: "obu:1", index: 0, data })); assertError(env);
  }
});

test("each chunk including the final one must have its exact declared byte count", () => {
  for (const data of [Buffer.alloc(CHUNK - 1).toString("base64"), Buffer.alloc(CHUNK + 1).toString("base64")]) {
    const env = fixture(); env.receiver.receive(valid.start); env.receiver.receive(envelope("chunk", { id: "obu:1", index: 0, data })); assertError(env);
  }
  const env = fixture(); env.receiver.receive(valid.start);
  for (const chunk of valid.chunks.slice(0, -1)) env.receiver.receive(chunk);
  const last = valid.chunks.at(-1).params;
  env.receiver.receive(envelope("chunk", { ...last, data: Buffer.from(last.data, "base64").subarray(1).toString("base64") })); assertError(env);
});

test("commit requires all chunks and its exact bounded fields", () => {
  const incomplete = fixture(); incomplete.receiver.receive(valid.start); incomplete.receiver.receive(valid.chunks[0]); incomplete.receiver.receive(valid.commit); assertError(incomplete);
  for (const params of [{ id: "obu:1", remainingMs: 0 }, { id: "obu:1", remainingMs: 120001 }, { id: "obu:1", remainingMs: "10" }, { id: "obu:1", remainingMs: 10, extra: true }, { id: "obu:1" }]) {
    const env = fixture(); assemble(env); env.receiver.receive(envelope("commit", params)); assertError(env);
  }
});

test("invalid UTF-8 and invalid JSON never reach dispatch", () => {
  const malformedUTF8 = Buffer.from(valid.bytes); malformedUTF8[malformedUTF8.indexOf(Buffer.from("界"))] = 0xff;
  const invalidJSON = Buffer.alloc(MiB + 1, "x");
  for (const bytes of [malformedUTF8, invalidJSON]) {
    const env = fixture(), value = frames(bytes); assemble(env, value); env.receiver.receive(value.commit); assertError(env);
  }
});

test("assembled payload must be one RPC object with the same ID and a public method", () => {
  for (const value of [
    request({ id: "obu:2" }), request({ id: 1 }), request({ jsonrpc: "1.0" }), request({ method: null }),
    request({ method: "obu.native.start" }), [request()], request().params.text,
    Buffer.from("null" + " ".repeat(MiB))
  ]) {
    const env = fixture(), packet = frames(value); assemble(env, packet); env.receiver.receive(packet.commit); assertError(env);
  }
});

test("abort clears pending bytes and stale fragments cannot execute", () => {
  const env = fixture(); env.receiver.receive(valid.start); env.receiver.receive(valid.chunks[0]);
  env.receiver.receive(envelope("abort", { id: "obu:1" })); assertError(env, "ABORTED");
  for (const chunk of valid.chunks.slice(1)) env.receiver.receive(chunk);
  env.receiver.receive(valid.commit);
  assert.equal(env.dispatched.length, 0);
});

test("close permanently rejects delivery and already queued timer callbacks", () => {
  const env = fixture(); env.receiver.receive(valid.start);
  const state = env.receiver.active, callback = [...env.timers.values()][0].callback;
  env.receiver.receive(valid.chunks[0]); env.receiver.close(); env.receiver.close(); callback();
  assert.equal(state.bytes, null);
  env.receiver.receive(valid.start);
  for (const chunk of valid.chunks) env.receiver.receive(chunk);
  env.receiver.receive(valid.commit); env.receiver.receive({ id: 1, method: "ping" });
  assert.equal(env.dispatched.length, 0); assert.equal(env.sent.length, 0); assert.equal(env.timers.size, 0);
});

test("dispatch failure is propagated after state release without transport retry", () => {
  const failure = new Error("consumer failed"), env = fixture({ dispatch() { throw failure; } });
  assemble(env);
  assert.throws(() => env.receiver.receive(valid.commit), error => error === failure);
  assert.equal(env.receiver.active, null); assert.equal(env.timers.size, 0); assert.equal(env.sent.length, 0);
  env.receiver.receive(valid.commit);
  assert.match(env.sent[0].error.message, /OBU_NATIVE_TRANSPORT_INVALID/);
});

test("send failure clears state, attempts each affected ID only once and propagates", () => {
  const calls = [], failure = new Error("port disconnected");
  const env = fixture({ send(message) { calls.push(message); throw failure; } });
  env.receiver.receive(valid.start);
  assert.throws(() => env.receiver.receive(envelope("abort", { id: "obu:2" })), error => error === failure);
  assert.deepEqual(calls.map(message => message.id), ["obu:1", "obu:2"]);
  assert.equal(env.receiver.active, null); assert.equal(env.timers.size, 0);
});

test("a send callback closing the port prevents every subsequent callback", () => {
  const calls = [], env = fixture({ send(message) { calls.push(message); env.receiver.close(); } });
  env.receiver.receive(valid.start);
  env.receiver.receive(envelope("abort", { id: "obu:2" }));
  env.receiver.receive({ id: "obu:3", method: "ping" });
  assert.deepEqual(calls.map(message => message.id), ["obu:1"]);
  assert.equal(env.dispatched.length, 0);
});

test("timer scheduling failure cannot retain an executable partial request", () => {
  const failure = new Error("timer failed"), env = fixture({ setTimer() { throw failure; } });
  assert.throws(() => env.receiver.receive(valid.start), error => error === failure);
  assert.equal(env.receiver.active, null);
  env.receiver.receive(valid.commit);
  assertError(env);
});
