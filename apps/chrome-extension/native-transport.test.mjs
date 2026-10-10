import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { NativeMessageReceiver } from "./native-message-receiver.js";

const background = await readFile(new URL("./background.js", import.meta.url), "utf8");
const source = background.split("class NativeTransport {")[1].split("class SessionStore {")[0];
const peerSource = background.split("class JsonRpcPeer {")[1].split("class NativeTransport {")[0];
function fixture() {
  const ports = [], alarms = [], statuses = [];
  const chrome = {
    runtime: { connectNative() {
      const messages = [], disconnects = [], sent = [];
      const port = { sent, onMessage: { addListener: fn => messages.push(fn) },
        onDisconnect: { addListener: fn => disconnects.push(fn) }, postMessage: message => sent.push(message),
        disconnect() { disconnects.forEach(fn => fn()); }, deliver(message) { messages.forEach(fn => fn(message)); } };
      ports.push(port); return port;
    } },
    alarms: { onAlarm: { addListener: fn => alarms.push(fn) }, create: async () => {} },
    storage: { local: { set: async value => statuses.push(value) } }
  };
  const { NativeTransport, JsonRpcPeer } = vm.runInNewContext(`class JsonRpcPeer {${peerSource}; class NativeTransport {${source}; ({NativeTransport,JsonRpcPeer})`, {
    chrome, NativeMessageReceiver, NATIVE_HOST_STATUS_KEY: "nativeStatus", RECONNECT_ALARM_NAME: "reconnect",
    PUBLIC_BROWSER_METHODS: new Set(["ping"])
  });
  const transport = new NativeTransport("fixture.host"), received = [];
  transport.setMessageCallback(message => received.push(message));
  return { transport, ports, received, JsonRpcPeer, reconnect: () => alarms.forEach(fn => fn({ name: "reconnect" })) };
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
