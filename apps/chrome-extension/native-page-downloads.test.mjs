import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { NativePageDownloads } from "./native-page-downloads.js";

const source = await readFile(new URL("./native-page-downloads.js", import.meta.url), "utf8");
const method = "obu.native.pageDownloads", extensionId = "a".repeat(32);
const claim = { guid: "original-guid", frameId: "original-frame", rootTargetId: "original-root", session_id: "session", turn_id: "turn", control_epoch: 3, tabId: 7, claimId: "private-claim" };
const message = params => ({ jsonrpc: "2.0", method, params: { version: 1, ...params } });
const plain = value => JSON.parse(JSON.stringify(value));
const defer = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = async () => { for (let index = 0; index < 6; index++) await Promise.resolve(); };

function fixture() {
  let wall = 1700000000000, mono = 0, uuid = 0, timerId = 0;
  const timers = new Map();
  const context = vm.createContext({ Error, performance: { now: () => mono }, Date: { now: () => wall },
    crypto: { randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}` },
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, at: mono + delay }); return id; },
    clearTimeout: id => timers.delete(id) });
  // Run the complete production module, replacing only its export declaration.
  vm.runInContext(source.replace("export class NativePageDownloads", "globalThis.NativePageDownloads = class NativePageDownloads"), context);
  const make = (options = {}) => {
    const sent = [], states = [], target = options.target ?? {};
    const channel = new context.NativePageDownloads({ send: value => { sent.push(value); options.send?.(value); },
      extensionId, getInstanceId: options.getInstanceId ?? (() => "extension-instance"), target, onStateChange: state => states.push(state) });
    return { channel, sent, states, target };
  };
  return { make, timers, deadline: (ms = 1000) => wall + ms, move: (wallMs, monoMs = wallMs) => { wall += wallMs; mono += monoMs; },
    fire() { for (const [id, timer] of [...timers]) if (timer.at <= mono) { timers.delete(id); timer.callback(); } } };
}

async function ready(env, nonce = "nonce-A", generation = "generation-A") {
  env.channel.receive(message({ type: "challenge", requestId: "challenge-" + nonce, nonce })); await flush();
  env.channel.receive(message({ type: "ready", nonce, generation, available: true }));
  assert.equal(env.channel.status().available, true);
}

function reply(env, request, result, extra = {}) {
  env.channel.receive(message({ type: "reply", requestId: request.params.requestId, nonce: request.params.nonce, generation: request.params.generation, result, ...extra }));
}

test("actual imported module publishes only private worker proof and returns independent RPC results", async () => {
  const target = {}, sent = [], channel = new NativePageDownloads({ send: value => sent.push(value), extensionId, getInstanceId: async () => "original-instance", target });
  try {
    await ready({ channel, sent });
    const proof = target.__obuNativeDownloadBinding;
    assert.deepEqual(Object.keys(proof), ["nonce", "extensionId", "extensionInstanceId", "workerBootId", "portId"]);
    assert.equal(proof.extensionInstanceId, "original-instance"); assert.equal(Object.isFrozen(proof), true);
    assert.equal(Object.keys(target).includes("__obuNativeDownloadBinding"), false);
    assert.equal(sent[0].params.result, proof); assert.equal(Object.hasOwn(sent[0], "id"), false);
    assert.equal(channel.status().nonce, undefined);
    const pending = channel.request("path", claim, { deadlineAt: Date.now() + 1000 });
    const request = sent.at(-1); assert.match(request.params.requestId, /^[a-f0-9-]{36}$/); assert.notEqual(request.params.requestId, "obu:1");
    reply({ channel }, request, { path: "C:\\original\\report.bin" });
    assert.deepEqual(await pending, { path: "C:\\original\\report.bin" });
  } finally { channel.close(); }
  assert.equal(target.__obuNativeDownloadBinding, undefined);
});

test("delayed identity after close cannot publish proof or send a response", async () => {
  const f = fixture(), identity = defer(), env = f.make({ getInstanceId: () => identity.promise });
  env.channel.receive(message({ type: "challenge", requestId: "one", nonce: "one" })); await flush();
  env.channel.close(); identity.resolve("late-instance"); await flush();
  assert.equal(env.target.__obuNativeDownloadBinding, undefined); assert.equal(env.sent.length, 0);
  env.channel.receive(message({ type: "ready", nonce: "one", generation: "old", available: true }));
  assert.equal(env.channel.status().available, false);
  await assert.rejects(env.channel.request("claim", claim, { deadlineAt: f.deadline() }), /DISCONNECTED/);
});

test("rechallenge pins the newest identity lookup and ignores old challenge/ready/reply", async () => {
  const f = fixture(), a = defer(), b = defer(); let count = 0;
  const env = f.make({ getInstanceId: () => ++count === 1 ? a.promise : b.promise });
  env.channel.receive(message({ type: "challenge", requestId: "A", nonce: "A" })); await flush();
  env.channel.receive(message({ type: "challenge", requestId: "B", nonce: "B" })); await flush();
  b.resolve("new-instance"); await flush(); const proof = env.target.__obuNativeDownloadBinding;
  a.resolve("old-instance"); await flush(); assert.equal(env.target.__obuNativeDownloadBinding, proof);
  assert.equal(env.sent.length, 1); assert.equal(env.sent[0].params.requestId, "B");
  for (const p of [{ type: "challenge", requestId: "A", nonce: "A" }, { type: "ready", nonce: "A", generation: "old", available: true }]) env.channel.receive(message(p));
  assert.equal(env.channel.status().available, false); assert.equal(count, 2);
  env.channel.receive(message({ type: "ready", nonce: "B", generation: "new", available: true }));
  const pending = env.channel.request("claim", claim, { deadlineAt: f.deadline() }), request = env.sent.at(-1);
  reply(env, request, {}, { nonce: "A" }); reply(env, request, {}, { generation: "old" }); assert.equal(f.timers.size, 1);
  reply(env, request, {}); assert.deepEqual(plain(await pending), {}); env.channel.close();
});

test("a successor port fences pending old work and late identity cannot overwrite its proof", async () => {
  const f = fixture(), target = {}, old = f.make({ target }); await ready(old);
  const oldProof = target.__obuNativeDownloadBinding, pending = old.channel.request("claim", claim, { deadlineAt: f.deadline() });
  const rejected = assert.rejects(pending, /port was replaced/), successor = f.make({ target }); await rejected; await ready(successor, "nonce-B", "generation-B");
  const proof = target.__obuNativeDownloadBinding;
  assert.equal(proof.workerBootId, oldProof.workerBootId); assert.notEqual(proof.portId, oldProof.portId);
  old.channel.close(); assert.equal(target.__obuNativeDownloadBinding, proof);
  old.channel.receive(message({ type: "challenge", requestId: "late", nonce: "late" })); await flush();
  assert.equal(old.sent.length, 2); assert.equal(target.__obuNativeDownloadBinding, proof); successor.channel.close();
});

test("ready false rejects pending, clears proof and cannot be revived by old ready true", async () => {
  const f = fixture(), env = f.make(); await ready(env);
  const pending = env.channel.request("path", claim, { deadlineAt: f.deadline() }), request = env.sent.at(-1);
  const rejected = assert.rejects(pending, /Browser connection lost/);
  env.channel.receive(message({ type: "ready", nonce: "nonce-A", generation: "generation-A", available: false, reason: "Browser connection lost" })); await rejected;
  assert.equal(env.target.__obuNativeDownloadBinding, undefined); assert.equal(f.timers.size, 0);
  reply(env, request, { path: "wrong" });
  for (const generation of ["generation-A", "invented"]) env.channel.receive(message({ type: "ready", nonce: "nonce-A", generation, available: true }));
  assert.equal(env.channel.status().available, false);
  await ready(env, "nonce-B", "generation-B"); assert.equal(env.channel.status().generation, "generation-B"); env.channel.close();
});

test("malformed private messages are consumed while ordinary SDK messages are untouched", async () => {
  const f = fixture(), env = f.make();
  assert.equal(env.channel.receive({ jsonrpc: "2.0", id: "obu:1", method: "getTabs" }), false);
  const challenge = { type: "challenge", requestId: "one", nonce: "one" };
  for (const value of [message({ ...challenge, version: 2 }), { ...message(challenge), id: "SDK-id" }, message({ ...challenge, extra: true }), message({ ...challenge, nonce: "" }), message({ type: "request" })]) assert.equal(env.channel.receive(value), true);
  await flush(); assert.equal(env.sent.length, 0); assert.equal(env.target.__obuNativeDownloadBinding, undefined);
  env.channel.close(); assert.equal(env.channel.receive(message(challenge)), true);
});

test("ready received before asynchronous identity publication does not enable requests", async () => {
  const f = fixture(), identity = defer(), env = f.make({ getInstanceId: () => identity.promise });
  env.channel.receive(message({ type: "challenge", requestId: "A", nonce: "A" })); await flush();
  const notification = message({ type: "ready", nonce: "A", generation: "G", available: true }); env.channel.receive(notification);
  assert.equal(env.channel.status().available, false); identity.resolve("instance"); await flush();
  assert.equal(env.channel.status().available, false); env.channel.receive(notification); assert.equal(env.channel.status().available, true); env.channel.close();
});

test("all four private operations enforce their result shapes and preserve host business errors", async () => {
  const f = fixture(), env = f.make(); await ready(env);
  for (const [operation, result] of [["claim", {}], ["release", {}], ["path", { path: "/original/report.bin" }], ["cancel", { cancelled: true }]]) {
    const pending = env.channel.request(operation, claim, { deadlineAt: f.deadline() }); reply(env, env.sent.at(-1), result);
    assert.deepEqual(plain(await pending), result);
  }
  const business = env.channel.request("path", claim, { deadlineAt: f.deadline() }), request = env.sent.at(-1);
  env.channel.receive(message({ type: "reply", requestId: request.params.requestId, nonce: request.params.nonce, generation: request.params.generation, error: { message: "original host failure" } }));
  await assert.rejects(business, error => error.message === "original host failure"); assert.equal(env.channel.status().available, true);
  for (const [operation, result] of [["claim", { path: "foreign" }], ["path", {}], ["path", { path: "bad\0path" }], ["cancel", { cancelled: false }]]) {
    const pending = env.channel.request(operation, claim, { deadlineAt: f.deadline() }); reply(env, env.sent.at(-1), result); await assert.rejects(pending, /PROTOCOL/);
  }
  env.channel.close();
});

test("expired and malformed local calls send nothing and do not retire a healthy binding", async () => {
  const f = fixture(), env = f.make(); await ready(env); const sent = env.sent.length;
  for (const deadlineAt of [undefined, NaN, Infinity, f.deadline(0), f.deadline(-1)]) await assert.rejects(env.channel.request("claim", claim, { deadlineAt }), /TIMEOUT/);
  await assert.rejects(env.channel.request("status", claim, { deadlineAt: f.deadline() }), /PROTOCOL/);
  for (const value of [{ ...claim, extra: true }, { ...claim, control_epoch: NaN }, { ...claim, control_epoch: 0 }, { ...claim, tabId: -1 }, { ...claim, guid: {} }, { ...claim, session_id: "x".repeat(4097) }, { ...claim, get guid() { throw Error("must not evaluate"); } }])
    await assert.rejects(env.channel.request("claim", value, { deadlineAt: f.deadline() }), /CLAIM/);
  assert.equal(env.sent.length, sent); assert.equal(env.channel.status().available, true); env.channel.close();
});

test("pending payload is copied and capacity is bounded without losing or resending requests", async () => {
  const f = fixture(), env = f.make(); await ready(env); const mutable = { ...claim };
  const pending = Array.from({ length: 128 }, () => env.channel.request("claim", mutable, { deadlineAt: f.deadline() }));
  const finished = Promise.allSettled(pending); mutable.guid = "changed";
  assert.equal(env.sent.at(-1).params.payload.guid, "original-guid");
  assert.equal(new Set(env.sent.slice(1).map(r => r.params.requestId)).size, 128);
  await assert.rejects(env.channel.request("claim", claim, { deadlineAt: f.deadline() }), /CAPACITY/);
  assert.equal(env.sent.length, 129); env.channel.close(); assert.equal((await finished).filter(r => r.status === "rejected").length, 128); assert.equal(f.timers.size, 0);
});

test("late replies are rejected after the deadline even before the queued timer executes", async () => {
  for (const [wallDelta, monoDelta] of [[11, 11], [500, 0], [-1000, 11]]) {
    const f = fixture(), env = f.make(); await ready(env);
    const pending = env.channel.request("path", claim, { deadlineAt: f.deadline(10) }), request = env.sent.at(-1);
    f.move(wallDelta, monoDelta); reply(env, request, { path: "late-original-file" }); await assert.rejects(pending, /TIMEOUT/);
    assert.equal(env.sent.length, 2); assert.equal(f.timers.size, 0); assert.equal(env.channel.status().available, true); env.channel.close();
  }
});

test("timeouts cap long budgets at 120s and never replay a request after late replies", async () => {
  const f = fixture(), env = f.make(); await ready(env);
  const pending = env.channel.request("cancel", claim, { deadlineAt: f.deadline(500000) }), request = env.sent.at(-1);
  assert.equal(request.params.timeoutMs, 120000); const rejected = assert.rejects(pending, /TIMEOUT/);
  f.move(-100000, 120000); f.fire(); await rejected; reply(env, request, { cancelled: true });
  assert.equal(env.sent.length, 2); assert.equal(f.timers.size, 0); env.channel.close();
});

test("native post failure preserves the original error and closes all private state", async () => {
  const f = fixture(), original = new Error("native port write failed"), env = f.make({ send: value => { if (value.params.type === "request") throw original; } }); await ready(env);
  await assert.rejects(env.channel.request("claim", claim, { deadlineAt: f.deadline() }), error => error === original);
  assert.equal(env.channel.status().available, false); assert.equal(env.target.__obuNativeDownloadBinding, undefined); assert.equal(f.timers.size, 0);
  await assert.rejects(env.channel.request("claim", claim, { deadlineAt: f.deadline() }), /DISCONNECTED/); assert.equal(env.sent.length, 2);
});

test("identity lookup failure remains terminal and sends no fabricated proof", async () => {
  const f = fixture(), env = f.make({ getInstanceId: async () => { throw Error("storage unavailable"); } });
  env.channel.receive(message({ type: "challenge", requestId: "A", nonce: "A" })); await flush();
  assert.equal(env.target.__obuNativeDownloadBinding, undefined); assert.equal(env.sent.length, 0); assert.match(env.channel.status().reason, /storage unavailable/);
  env.channel.receive(message({ type: "challenge", requestId: "B", nonce: "B" })); await flush(); assert.equal(env.sent.length, 0);
});

test("challenge replay history is bounded and exhaustion cannot evict an old nonce into reusable authority", async () => {
  const f = fixture(); let lookups = 0;
  const env = f.make({ getInstanceId: () => { lookups++; return "instance"; } });
  for (let index = 0; index <= 4096; index++) env.channel.receive(message({ type: "challenge", requestId: String(index), nonce: "nonce-" + index }));
  await flush(); assert.equal(lookups, 0); assert.equal(env.sent.length, 0); assert.match(env.channel.status().reason, /CAPACITY/);
  env.channel.receive(message({ type: "challenge", requestId: "0", nonce: "nonce-0" })); await flush();
  assert.equal(env.target.__obuNativeDownloadBinding, undefined); assert.equal(env.sent.length, 0);
});
