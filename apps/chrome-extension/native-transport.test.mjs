import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { NativeMessageReceiver } from "./native-message-receiver.js";
import { NativePageDownloads } from "./native-page-downloads.js";

const background = await readFile(new URL("./background.js", import.meta.url), "utf8");
const source = background.split("class NativeTransport {")[1].split("class SessionStore {")[0];
const peerSource = background.split("class JsonRpcPeer {")[1].split("class NativeTransport {")[0];
function fixture(hooks = {}) {
  const ports = [], alarms = [], statuses = [], alarmWrites = [], scheduledAlarms = new Map(), timers = new Map();
  let now = 0, nextTimer = 0, attempts = 0;
  const chrome = {
    runtime: { id: "a".repeat(32), connectNative() {
      attempts++;
      hooks.connect?.();
      const messages = [], disconnects = [], sent = [];
      const port = { sent, onMessage: { addListener: fn => messages.push(fn) },
        onDisconnect: { addListener: fn => disconnects.push(fn) }, postMessage: message => { hooks.post?.(message); sent.push(message); },
        disconnect() { disconnects.forEach(fn => fn()); }, deliver(message) { messages.forEach(fn => fn(message)); } };
      ports.push(port); return port;
    } },
    alarms: { onAlarm: { addListener: fn => alarms.push(fn) },
      async create(name, value) {
        alarmWrites.push(["create", name, value.periodInMinutes]);
        await hooks.create?.();
        const period = Math.max(30_000, value.periodInMinutes * 60_000);
        scheduledAlarms.set(name, { name, at: now + period, period });
      },
      async clear(name) {
        alarmWrites.push(["clear", name]);
        await hooks.clear?.();
        return scheduledAlarms.delete(name);
      }
    },
    storage: { local: { set: async value => statuses.push(value) } }
  };
  const clock = {
    advance(milliseconds) {
      const end = now + milliseconds;
      for (;;) {
        const due = [...timers.entries()].filter(([, value]) => value.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        now = due[1].at; timers.delete(due[0]); due[1].callback();
      }
      now = end;
    },
    fireAlarms() {
      for (const alarm of scheduledAlarms.values()) if (alarm.at <= now) {
        alarm.at = now + alarm.period;
        alarms.forEach(fn => fn({ name: alarm.name }));
      }
    },
    dropTimers() { timers.clear(); },
    get timers() { return timers.size; }
  };
  const { NativeTransport, JsonRpcPeer } = vm.runInNewContext(`class JsonRpcPeer {${peerSource}; class NativeTransport {${source}; ({NativeTransport,JsonRpcPeer})`, {
    chrome, NativeMessageReceiver, NativePageDownloads, getExtensionInstanceId: async () => "fixture-instance", NATIVE_HOST_STATUS_KEY: "nativeStatus", RECONNECT_ALARM_NAME: "reconnect",
    PUBLIC_BROWSER_METHODS: new Set(["ping"]), Date: class extends Date { static now() { return now; } },
    setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); }
  });
  const transport = new NativeTransport("fixture.host"), received = [];
  transport.setMessageCallback(message => received.push(message));
  return { transport, ports, received, JsonRpcPeer, clock, hooks, statuses, alarmWrites, scheduledAlarms,
    get attempts() { return attempts; },
    flush: () => transport.reconnectAlarmUpdate,
    reconnect: () => alarms.forEach(fn => fn({ name: "reconnect" })) };
}
function fragments(id) {
  const request = { jsonrpc: "2.0", id, method: "executeCdp", params: { text: "中文🌏<&>".repeat(150_000), timeoutMs: 10000 } };
  const bytes = Buffer.from(JSON.stringify(request));
  const envelope = (method, params) => ({ jsonrpc: "2.0", method: `obu.native.${method}`, params });
  const chunks = [];
  for (let i = 0; i < bytes.length; i += 512 * 1024) chunks.push(envelope("chunk", { id, index: chunks.length, data: bytes.subarray(i, i + 512 * 1024).toString("base64") }));
  return { request, start: envelope("start", { id, totalBytes: bytes.length, totalChunks: chunks.length, timeoutMs: 10000, deadlineUnixMs: Date.now() + 10000 }), chunks,
    commit: envelope("commit", { id, remainingMs: 9000 }) };
}

test("disconnected notifications do not postpone the five-second retry or replay messages", async () => {
  const f = fixture();
  await f.flush();
  f.ports[0].disconnect();
  await f.flush();
  const deadline = f.scheduledAlarms.get("reconnect").at;
  for (let index = 0; index < 5; index++) {
    f.clock.advance(999);
    assert.throws(() => f.transport.sendMessage({ jsonrpc: "2.0", method: "heartbeat" }), /disconnected/);
  }
  await f.flush();
  assert.equal(f.attempts, 1);
  assert.equal(f.transport.getStatus().nextRetryMs, 5000);
  assert.equal(f.transport.getStatus().reconnectAttempt, 1);
  assert.equal(f.scheduledAlarms.get("reconnect").at, deadline);
  assert.equal(f.alarmWrites.filter(([kind]) => kind === "create").length, 1);
  f.clock.advance(5);
  await f.flush();
  assert.equal(f.attempts, 2);
  assert.deepEqual(f.ports[1].sent.map(message => message.method), ["obu.native.hello"]);
  assert.equal(f.clock.timers, 0);
  assert.equal(f.scheduledAlarms.size, 0);
  assert.equal(f.transport.getStatus().state, "connected");
});

test("the packed alarm still reconnects when a heartbeat arrives first and the short timer is unavailable", async () => {
  const f = fixture();
  await f.flush();
  f.ports[0].disconnect();
  await f.flush();
  assert.deepEqual(f.alarmWrites.at(-1), ["create", "reconnect", 0.5]);
  f.clock.dropTimers();
  for (let index = 0; index < 3; index++) {
    f.clock.advance(10_000);
    assert.throws(() => f.transport.sendMessage({ method: "heartbeat" }), /disconnected/);
    await f.flush();
    assert.equal(f.scheduledAlarms.get("reconnect").at, 30_000);
  }
  f.clock.fireAlarms();
  await f.flush();
  assert.equal(f.attempts, 2);
  assert.equal(f.transport.getStatus().state, "connected");
  assert.equal(f.scheduledAlarms.size, 0);
});

for (const failure of ["connect", "hello"]) test(`synchronous ${failure} failures retain bounded retries without duplicate timers`, async () => {
  let failures = 2;
  const fail = () => { if (failures-- > 0) throw new Error("native host unavailable"); };
  const f = fixture(failure === "connect" ? { connect: fail } : { post: fail });
  await f.flush();
  assert.equal(f.transport.port, null);
  assert.equal(f.clock.timers, 1);
  assert.equal(f.transport.getStatus().reconnectAttempt, 1);
  f.clock.advance(5000);
  await f.flush();
  assert.equal(f.attempts, 2);
  assert.equal(f.transport.port, null);
  assert.equal(f.clock.timers, 1);
  assert.equal(f.transport.getStatus().reconnectAttempt, 2);
  f.clock.advance(5000);
  await f.flush();
  assert.equal(f.attempts, 3);
  assert.equal(f.transport.getStatus().state, "connected");
  assert.equal(f.transport.getStatus().reconnectAttempt, 0);
  assert.equal(f.clock.timers, 0);
  assert.equal(f.scheduledAlarms.size, 0);
});

test("a slow successful-port alarm clear cannot delete a later disconnect's fallback", async () => {
  const f = fixture();
  await f.flush();
  f.ports[0].disconnect();
  await f.flush();
  let release, clearing = false;
  const gate = new Promise(resolve => { release = resolve; });
  f.hooks.clear = () => { clearing = true; return gate; };
  f.clock.advance(5000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(clearing, true);
  f.ports[1].disconnect();
  const pendingDeadline = f.scheduledAlarms.get("reconnect").at;
  assert.equal(f.alarmWrites.at(-1)[0], "clear");
  release();
  await f.flush();
  assert.equal(f.alarmWrites.at(-1)[0], "create");
  assert.ok(f.scheduledAlarms.get("reconnect").at > pendingDeadline);
  assert.equal(f.clock.timers, 1);
  f.clock.advance(5000);
  await f.flush();
  assert.equal(f.attempts, 3);
  assert.equal(f.scheduledAlarms.size, 0);
});

test("an in-flight fallback creation is cleared after the short timer connects", async () => {
  const f = fixture();
  await f.flush();
  let release, creating = false;
  const gate = new Promise(resolve => { release = resolve; });
  f.hooks.create = () => { creating = true; return gate; };
  f.ports[0].disconnect();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(creating, true);
  f.clock.advance(5000);
  assert.equal(f.attempts, 2);
  release();
  await f.flush();
  assert.deepEqual(f.alarmWrites.map(([kind]) => kind), ["clear", "create", "clear"]);
  assert.equal(f.scheduledAlarms.size, 0);
  f.reconnect(); // A previously queued native alarm delivery cannot double-connect.
  f.clock.advance(30_000);
  assert.equal(f.attempts, 2);
});

test("alarm creation failure does not disable the live worker's retry", async () => {
  const f = fixture({ create() { throw new Error("alarm unavailable"); } });
  await f.flush();
  f.ports[0].disconnect();
  await f.flush();
  assert.equal(f.scheduledAlarms.size, 0);
  f.clock.advance(5000);
  await f.flush();
  assert.equal(f.attempts, 2);
  assert.equal(f.transport.getStatus().state, "connected");
});

test("native ports negotiate and dispatch only the complete request", () => {
  const f = fixture(), port = f.ports[0], value = fragments("obu:1");
  assert.deepEqual(JSON.parse(JSON.stringify(port.sent)), [{ jsonrpc: "2.0", method: "obu.native.hello", params: { version: 1 } }]);
  port.deliver(value.start);
  for (const chunk of value.chunks) port.deliver(chunk);
  assert.equal(f.received.length, 0);
  port.deliver(value.commit);
  assert.equal(f.received.length, 1);
  assert.equal(f.received[0].params.text, value.request.params.text);
  assert.ok(f.received[0].params.timeoutMs <= 9000);
  port.disconnect();
});

test("old port messages and disconnects cannot dispatch or clear the new assembler", () => {
  const f = fixture(), old = f.ports[0], first = fragments("obu:1");
  old.deliver(first.start); old.deliver(first.chunks[0]); old.disconnect();
  f.reconnect();
  const current = f.ports[1], next = fragments("obu:2");
  assert.equal(current.sent[0].method, "obu.native.hello");
  current.deliver(next.start);
  old.deliver(first.commit); old.deliver({ jsonrpc: "2.0", id: "obu:3", method: "ping" }); old.disconnect();
  assert.equal(f.transport.port, current);
  for (const chunk of next.chunks) current.deliver(chunk);
  current.deliver(next.commit);
  assert.deepEqual(f.received.map(item => item.id), ["obu:2"]);
  current.disconnect();
});

test("disconnect discards partial assembly without replay on reconnect", () => {
  const f = fixture(), old = f.ports[0], value = fragments("obu:1");
  old.deliver(value.start); old.disconnect();
  assert.throws(() => f.transport.sendMessage({}), /disconnected/);
  f.reconnect();
  const current = f.ports[1];
  for (const chunk of value.chunks) current.deliver(chunk);
  current.deliver(value.commit);
  assert.equal(f.received.length, 0);
  const small = { jsonrpc: "2.0", id: "obu:2", method: "ping" };
  current.deliver(small);
  assert.deepEqual(f.received, [small]);
  current.disconnect();
});

for (const outcome of ["success", "error"]) {
  test(`late ${outcome} replies cannot cross native port request-ID namespaces`, async () => {
    const f = fixture(), pending = [];
    new f.JsonRpcPeer(f.transport, { ping() { return new Promise((resolve, reject) => pending.push({ resolve, reject })); } });
    const old = f.ports[0], request = { jsonrpc: "2.0", id: "obu:1", method: "ping" };
    old.deliver(request); old.disconnect(); f.reconnect();
    const current = f.ports[1];
    current.deliver(request);
    assert.equal(pending.length, 2);
    if (outcome === "success") pending[0].resolve({ owner: "old" });
    else pending[0].reject(new Error("old native handler failed"));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(current.sent.map(message => message.method), ["obu.native.hello"]);
    assert.equal(old.sent.length, 1);
    pending[1].resolve({ owner: "new" });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(JSON.parse(JSON.stringify(current.sent[1])), { jsonrpc: "2.0", id: "obu:1", result: { owner: "new" } });
    current.disconnect();
  });
}
