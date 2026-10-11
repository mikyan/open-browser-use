import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const OPEN = 1;
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function settledWithin(promise, timeoutMs) {
  let timer;
  try { return await Promise.race([promise.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); })]); }
  finally { clearTimeout(timer); }
}

// This substitutes only the native Port in the isolated staged extension.
// Closing the WebSocket really delivers onDisconnect; a dead port cannot queue
// a response for a replacement host, even if an old action completes later.
export function nativeAdapterSource(url) {
  return `function __integrationConnectNative(name) {
    const messages = new Set(), disconnects = new Set(), queued = [];
    let closed = false;
    const socket = new WebSocket(${JSON.stringify(url)} + '?extensionId=' + chrome.runtime.id);
    socket.onopen = () => { if (!closed) for (const message of queued.splice(0)) socket.send(message); };
    socket.onmessage = event => { if (!closed) { const message = JSON.parse(event.data); globalThis.__integrationNativeRPCObserver?.("request", message); for (const fn of messages) fn(message); } };
    socket.onclose = () => { if (closed) return; closed = true; queued.length = 0; for (const fn of disconnects) fn(); };
    return { name, onMessage: { addListener: fn => messages.add(fn), removeListener: fn => messages.delete(fn) },
      onDisconnect: { addListener: fn => disconnects.add(fn), removeListener: fn => disconnects.delete(fn) },
      postMessage: message => { if (closed || socket.readyState > 1) throw new Error('Native port is disconnected'); globalThis.__integrationNativeRPCObserver?.("response", message); const text = JSON.stringify(message); if (socket.readyState === 1) socket.send(text); else queued.push(text); },
      disconnect: () => socket.close() };
  }\n`;
}

function nativeFrame(message) {
  const body = Buffer.from(JSON.stringify(message));
  assert.ok(body.length <= 64 * 1024 * 1024, "Extension message exceeds Chrome's 64 MiB native messaging limit");
  const header = Buffer.alloc(4);
  if (os.endianness() === "LE") header.writeUInt32LE(body.length); else header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}

export class NativeHostBridge {
  constructor({ server, executable, socketDir, log = () => {}, onFailure = () => {}, stats, spawnHost = spawn, readRecord = () => fs.readFile(path.join(socketDir, "active.json"), "utf8").then(JSON.parse), timeoutMs = 20000 }) {
    Object.assign(this, { server, executable, socketDir, log, onFailure, spawnHost, readRecord, timeoutMs });
    this.stats = stats ?? { frames: 0, maxFrameBytes: 0, starts: 0, chunks: 0, commits: 0 };
    this.current = null;
    this.closing = false;
    this.failure = null;
    this.generations = [];
    this.liveGenerations = new Set();
    this.connection = (socket, request) => this.accept(socket, request);
    server.on("connection", this.connection);
  }

  get host() { return this.current?.host; }
  get endpoint() { return this.current?.record.endpoint; }
  get socket() { return this.current?.socket; }
  get extensionId() { return this.current?.extensionId; }

  fail(error, generation = this.current) {
    if (this.closing || generation?.stopping || (generation && generation !== this.current) || this.failure) return;
    this.failure = error;
    this.onFailure(error);
  }

  async wait(check, label, timeoutMs = this.timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.failure) throw this.failure;
      if (this.closing) throw new Error("Native bridge is closing");
      const value = await check();
      if (value) return value;
      await delay(20);
    }
    throw new Error(`Timed out waiting for ${label}`);
  }

  async start() {
    assert.ok(!this.current && !this.closing, "Native host already running or bridge closed");
    const record = { generation: this.generations.length + 1, startedAt: Date.now(), connections: [], discardedFrames: 0 };
    const generation = { record, socket: null, buffer: Buffer.alloc(0), stopping: false };
    this.current = generation;
    this.liveGenerations.add(generation);
    this.generations.push(record);
    const host = this.spawnHost(path.resolve(this.executable), ["host", "--socket-dir", this.socketDir], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    generation.host = host;
    record.pid = host.pid;
    generation.exited = new Promise(resolve => {
      host.once("exit", (code, signal) => {
        Object.assign(record, { exitedAt: Date.now(), exitCode: code, exitSignal: signal });
        resolve({ code, signal });
        this.fail(new Error(`Native host exited during active acceptance: ${code} ${signal}`), generation);
      });
      host.once("error", error => {
        record.spawnError = error.message;
        resolve({ error: error.message });
        this.fail(error, generation);
      });
    });
    host.stderr.on("data", data => this.log(data.toString()));
    host.stdin.on("error", error => this.fail(error, generation));
    host.stdout.on("data", data => this.read(generation, data));
    await this.wait(async () => {
      let active;
      try { active = await this.readRecord(); } catch { return false; }
      // A killed host can leave active.json. Never connect to its stale endpoint.
      if (active.pid !== host.pid || typeof active.socketPath !== "string" || !active.socketPath) return false;
      record.endpoint = active.socketPath;
      return true;
    }, "current native host endpoint");
    return { pid: record.pid, endpoint: record.endpoint, generation: record.generation };
  }

  accept(socket, request) {
    const generation = this.current;
    socket.on("error", error => { if (generation) this.fail(error, generation); });
    if (!generation || generation.stopping || this.closing || this.failure) { socket.close(1012, "Native host unavailable"); return; }
    const id = new URL(request.url, "ws://127.0.0.1").searchParams.get("extensionId");
    if (!/^[a-p]{32}$/.test(id ?? "") || (this.knownExtensionId && id !== this.knownExtensionId)) {
      socket.close(1008, "Invalid extension identity"); this.fail(new Error("Native adapter extension identity mismatch"), generation); return;
    }
    this.knownExtensionId = id;
    if (generation.socket?.readyState === OPEN) {
      socket.close(1008, "Native port already connected"); this.fail(new Error("Overlapping native adapter connections"), generation); return;
    }
    const connection = { connectedAt: Date.now(), extensionId: id, hello: false };
    generation.record.connections.push(connection);
    generation.socket = socket;
    generation.extensionId = id;
    socket.on("close", () => { connection.closedAt = Date.now(); if (generation.socket === socket) generation.socket = null; });
    socket.on("message", raw => {
      if (this.current !== generation || generation.stopping || generation.socket !== socket || this.closing || this.failure) return;
      try {
        const message = JSON.parse(raw.toString());
        if (message.method === "obu.native.hello" && message.params?.version === 1) connection.hello = true;
        if (generation.host.stdin.destroyed || generation.host.stdin.writableEnded || generation.host.exitCode !== null) throw new Error("Native host input closed during active acceptance");
        generation.host.stdin.write(nativeFrame(message), error => { if (error) this.fail(error, generation); });
      } catch (error) { this.fail(error, generation); }
    });
  }

  read(generation, data) {
    if (generation !== this.current || generation.stopping || this.closing || this.failure) return;
    try {
      generation.buffer = Buffer.concat([generation.buffer, data]);
      while (generation.buffer.length >= 4) {
        const length = os.endianness() === "LE" ? generation.buffer.readUInt32LE() : generation.buffer.readUInt32BE();
        assert.ok(length <= 1024 * 1024, "Host message exceeds Chrome's 1 MiB native messaging limit");
        if (generation.buffer.length < 4 + length) break;
        const message = generation.buffer.subarray(4, 4 + length).toString();
        generation.buffer = generation.buffer.subarray(4 + length);
        const method = JSON.parse(message).method;
        this.stats.frames++;
        this.stats.maxFrameBytes = Math.max(this.stats.maxFrameBytes, length);
        if (method === "obu.native.start") this.stats.starts++;
        if (method === "obu.native.chunk") this.stats.chunks++;
        if (method === "obu.native.commit") this.stats.commits++;
        if (generation.socket?.readyState === OPEN) generation.socket.send(message, error => { if (error) this.fail(error, generation); });
        else generation.record.discardedFrames++; // No port queue or reconnect replay.
      }
    } catch (error) { this.fail(error, generation); }
  }

  async waitForConnection(timeoutMs = 50000) {
    // The production alarm, not a test-only call to connect(), schedules this.
    // Chromium may clamp its period to 30 seconds.
    await this.wait(() => this.socket?.readyState === OPEN && this.current.record.connections.at(-1)?.hello, "native adapter hello", timeoutMs);
  }

  async stopGeneration(generation, force) {
    if (!generation) return;
    generation.stopping = true;
    if (this.current === generation) this.current = null;
    generation.buffer = Buffer.alloc(0);
    const closePort = async () => {
      const socket = generation.socket;
      if (!socket || socket.readyState === 3) return;
      const closed = new Promise(resolve => socket.once("close", resolve));
      if (socket.readyState < 2) socket.close(1012, "Native host stopped");
      if (!await settledWithin(closed, 1000)) socket.terminate();
      assert.ok(await settledWithin(closed, 1000), "Native port did not close after host termination");
    };
    const stopHost = async () => {
      const host = generation.host;
      if (!host || generation.record.exitedAt || generation.record.spawnError) return;
      if (force) host.kill();
      else if (!host.stdin.destroyed && !host.stdin.writableEnded) host.stdin.end();
      if (!await settledWithin(generation.exited, 1000)) host.kill();
      assert.ok(await settledWithin(generation.exited, 5000), "Native host did not exit after termination");
    };
    // Crash semantics require actual process death to cause the native port
    // disconnect. Closing the port first would let cleanup run before the kill.
    if (force) { await stopHost(); await closePort(); }
    else { await closePort(); await stopHost(); }
    this.liveGenerations.delete(generation);
  }

  async restart() {
    assert.ok(this.current && !this.closing && !this.failure, "No healthy native host to restart");
    assert.ok(this.socket?.readyState === OPEN && this.current.record.connections.at(-1)?.hello, "No live native port to disconnect by terminating its host");
    const old = this.current;
    await this.stopGeneration(old, true);
    const next = await this.start();
    await this.waitForConnection();
    assert.notEqual(next.pid, old.record.pid, "Restart reused the old host PID");
    assert.notEqual(next.endpoint, old.record.endpoint, "Restart reused the old endpoint namespace");
    return { oldPid: old.record.pid, newPid: next.pid, oldEndpoint: old.record.endpoint, newEndpoint: next.endpoint,
      old: structuredClone(old.record), next: structuredClone(this.current.record) };
  }

  async close() {
    this.closing = true;
    this.server.off("connection", this.connection);
    const failures = [];
    for (const generation of this.liveGenerations) {
      try { await this.stopGeneration(generation, false); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, "Native host cleanup failed");
  }
}
