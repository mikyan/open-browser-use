import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { NativeHostBridge, nativeAdapterSource } from "./native-host-bridge.mjs";

const id = "a".repeat(32);
const hello = { jsonrpc: "2.0", method: "obu.native.hello", params: { version: 1 } };
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(check) {
  for (let i = 0; i < 100; i++) { const value = check(); if (value) return value; await delay(10); }
  throw new Error("Fixture wait timed out");
}
function frame(value) {
  const data = Buffer.from(JSON.stringify(value)), header = Buffer.alloc(4);
  if (os.endianness() === "LE") header.writeUInt32LE(data.length); else header.writeUInt32BE(data.length);
  return Buffer.concat([header, data]);
}
class Socket extends EventEmitter {
  readyState = 1;
  sent = [];
  send(value, done) { this.sent.push(JSON.parse(value)); done?.(); }
  close() { this.readyState = 3; this.emit("close"); }
  terminate() { this.close(); }
}
function fixture() {
  const server = new EventEmitter(), errors = [], hosts = [];
  const bridge = new NativeHostBridge({ server, executable: process.execPath, socketDir: "/fixture", onFailure: error => errors.push(error), timeoutMs: 500,
    spawnHost() {
      const host = new EventEmitter();
      Object.assign(host, { pid: 200 + hosts.length, exitCode: null, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
      host.stdin.on("end", () => host.kill()); host.stdin.resume();
      host.kill = () => { if (host.exitCode === null) { host.exitCode = 0; queueMicrotask(() => host.emit("exit", 0, "SIGTERM")); } return true; };
      hosts.push(host); return host;
    },
    readRecord: async () => ({ pid: hosts.at(-1).pid, socketPath: `endpoint-${hosts.at(-1).pid}` }) });
  const connect = () => { const socket = new Socket(); server.emit("connection", socket, { url: `/?extensionId=${id}` }); socket.emit("message", Buffer.from(JSON.stringify(hello))); return socket; };
  return { bridge, server, hosts, errors, connect };
}

test("restart waits for old exit, closes its port, rejects late callbacks and never carries its partial frame", async () => {
  const { bridge, hosts, errors, connect } = fixture();
  try {
    await bridge.start(); const oldSocket = connect(), old = hosts[0];
    await bridge.waitForConnection();
    let disconnected = 0; oldSocket.on("close", () => { assert.equal(old.exitCode, 0, "Port closed before the host really exited"); disconnected++; });
    old.stdout.write(frame({ id: "old", method: "oldAction" }).subarray(0, 6));
    const restarted = bridge.restart();
    await until(() => bridge.host && bridge.host !== old);
    const nextSocket = connect(); const report = await restarted;
    assert.equal(disconnected, 1); assert.equal(old.exitCode, 0);
    assert.ok(report.old.exitedAt <= report.old.connections[0].closedAt);
    assert.ok(report.old.connections[0].closedAt <= report.next.startedAt);
    assert.notEqual(report.oldEndpoint, report.newEndpoint);
    old.stdout.emit("data", frame({ id: "late", method: "mustNotReplay" }));
    oldSocket.emit("message", Buffer.from('{"id":"late","result":"mustNotEnterNewHost"}'));
    old.stdin.emit("error", new Error("old queued write failed"));
    hosts[1].stdout.write(frame({ id: "fresh", method: "newAction" }));
    assert.deepEqual(nextSocket.sent, [{ id: "fresh", method: "newAction" }]);
    assert.deepEqual(errors, []);
  } finally { await bridge.close(); }
});

test("a disconnected worker port has no outbound replay queue", async () => {
  const { bridge, hosts, connect } = fixture();
  try {
    await bridge.start(); connect().close();
    hosts[0].stdout.write(frame({ id: "missing-port", method: "oldAction" }));
    const next = connect();
    hosts[0].stdout.write(frame({ id: "new", method: "fresh" }));
    assert.equal(bridge.generations[0].discardedFrames, 1);
    assert.deepEqual(next.sent, [{ id: "new", method: "fresh" }]);
  } finally { await bridge.close(); }
});

test("optional RPC observer precedes forwarding and cannot mutate either direction", async () => {
  const { bridge, hosts, connect, errors } = fixture(), order = [], writes = [];
  try {
    await bridge.start(); const socket = connect(), send = socket.send.bind(socket);
    socket.send = (message, done) => { order.push("send-request"); send(message, done); };
    const write = hosts[0].stdin.write.bind(hosts[0].stdin);
    hosts[0].stdin.write = (...args) => { writes.push(args[0]); order.push("write-response"); return write(...args); };
    bridge.onRPC = (direction, message) => { order.push(direction); message.id = "observer-mutation"; };
    hosts[0].stdout.write(frame({ id: "original-request", method: "browserAction", params: { timeoutMs: 999 } }));
    socket.emit("message", Buffer.from(JSON.stringify({ id: "original-request", error: { message: "original timeout" } })));
    assert.deepEqual(order, ["request", "send-request", "response", "write-response"]);
    assert.equal(socket.sent[0].id, "original-request");
    assert.deepEqual(JSON.parse(writes[0].subarray(4)), { id: "original-request", error: { message: "original timeout" } });
    socket.close(); hosts[0].stdout.write(frame({ id: "discarded", method: "browserAction" }));
    assert.equal(order.length, 4); assert.deepEqual(errors, []);
  } finally { await bridge.close(); }
});

test("RPC observation failure fails acceptance before forwarding rather than silently losing evidence", async () => {
  const { bridge, hosts, connect, errors } = fixture();
  try {
    await bridge.start(); const socket = connect();
    bridge.onRPC = () => { throw Error("RPC observer failed"); };
    hosts[0].stdout.write(frame({ id: "original", method: "browserAction" }));
    assert.deepEqual(socket.sent, []); assert.equal(errors.length, 1);
    assert.match(errors[0].message, /RPC observer failed/);
  } finally { await bridge.close(); }
});

test("active.json from the old PID is not accepted as the new endpoint", async () => {
  const { bridge, hosts } = fixture(); let reads = 0;
  bridge.readRecord = async () => ({ pid: ++reads < 3 ? 999 : hosts[0].pid, socketPath: reads < 3 ? "stale" : "fresh" });
  try { assert.equal((await bridge.start()).endpoint, "fresh"); assert.equal(reads, 3); }
  finally { await bridge.close(); }
});

test("unexpected host exit and oversized native frame are acceptance failures", async () => {
  for (const failure of ["exit", "frame"]) {
    const { bridge, hosts, errors } = fixture();
    try {
      await bridge.start();
      if (failure === "exit") { hosts[0].exitCode = 7; hosts[0].emit("exit", 7, null); }
      else { const header = Buffer.alloc(4); os.endianness() === "LE" ? header.writeUInt32LE(1024 * 1024 + 1) : header.writeUInt32BE(1024 * 1024 + 1); hosts[0].stdout.write(header); }
      assert.equal(errors.length, 1);
      await assert.rejects(bridge.waitForConnection(), /exited|1 MiB/);
    } finally { await bridge.close(); }
  }
});

test("staged native Port drops pre-open queue on real close and refuses late postMessage", () => {
  const sockets = [];
  class BrowserSocket {
    readyState = 0; sent = [];
    constructor() { sockets.push(this); }
    send(message) { this.sent.push(message); }
    close() { this.readyState = 3; this.onclose?.(); }
  }
  const context = vm.createContext({ WebSocket: BrowserSocket, chrome: { runtime: { id } } });
  vm.runInContext(nativeAdapterSource("ws://127.0.0.1:1") + "globalThis.port=__integrationConnectNative('test');", context);
  let disconnects = 0; context.port.onDisconnect.addListener(() => disconnects++);
  context.port.postMessage(hello); sockets[0].close(); sockets[0].onopen();
  assert.equal(disconnects, 1); assert.deepEqual(sockets[0].sent, []);
  assert.throws(() => context.port.postMessage({ id: "late" }), /disconnected/);
  sockets[0].onclose(); assert.equal(disconnects, 1);
});

test("bridge terminates a real child process before starting a new PID and receives fresh framed bytes", async () => {
  const parent = await fs.realpath(os.tmpdir()), directory = await fs.mkdtemp(path.join(parent, "obu-bridge-"));
  const server = new EventEmitter(), errors = [];
  // A tiny framed stdio child exercises OS process lifetime. It is not the
  // product host or browser; full acceptance supplies the real Go executable.
  const childSource = `import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
    fs.writeFileSync(path.join(process.argv[1],'active.json'),JSON.stringify({pid:process.pid,socketPath:'endpoint-'+process.pid}));
    let bytes=Buffer.alloc(0);process.stdin.on('data',chunk=>{bytes=Buffer.concat([bytes,chunk]);while(bytes.length>=4){const n=os.endianness()==='LE'?bytes.readUInt32LE():bytes.readUInt32BE();if(bytes.length<n+4)break;const msg=JSON.parse(bytes.subarray(4,n+4));bytes=bytes.subarray(n+4);const data=Buffer.from(JSON.stringify({id:msg.id??'hello',result:{pid:process.pid}})),header=Buffer.alloc(4);os.endianness()==='LE'?header.writeUInt32LE(data.length):header.writeUInt32BE(data.length);process.stdout.write(Buffer.concat([header,data]));}});`;
  const bridge = new NativeHostBridge({ server, executable: process.execPath, socketDir: directory, onFailure: error => errors.push(error),
    spawnHost: (_executable, _args, options) => spawn(process.execPath, ["--input-type=module", "-e", childSource, directory], options) });
  const connect = () => { const socket = new Socket(); server.emit("connection", socket, { url: `/?extensionId=${id}` }); socket.emit("message", Buffer.from(JSON.stringify(hello))); return socket; };
  try {
    const initial = await bridge.start(); const oldSocket = connect();
    await until(() => oldSocket.sent.length === 1);
    const restart = bridge.restart();
    await until(() => bridge.host && bridge.host.pid !== initial.pid);
    const next = connect(), report = await restart;
    await until(() => next.sent.length === 1);
    assert.equal(oldSocket.readyState, 3);
    assert.notEqual(report.newPid, report.oldPid);
    assert.equal(next.sent[0].result.pid, report.newPid);
    assert.ok(report.old.exitedAt <= report.old.connections[0].closedAt);
    assert.ok(report.old.connections[0].closedAt <= report.next.startedAt);
    assert.deepEqual(errors, []);
  } finally {
    await bridge.close();
    const resolved = await fs.realpath(directory);
    assert.equal(resolved, directory); assert.equal(path.dirname(resolved), parent); assert.ok(path.basename(resolved).startsWith("obu-bridge-"));
    assert.equal((await fs.lstat(directory)).isSymbolicLink(), false);
    await fs.rm(resolved, { recursive: true, force: true });
  }
});
