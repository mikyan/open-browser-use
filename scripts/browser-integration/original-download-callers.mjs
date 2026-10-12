import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const describe = error => error?.stack ?? String(error);

// This harness owns only its exact child process. A timeout is terminal: kill
// and observe close, without resending the request or starting another turn.
function startProcess(executable, args, detail, spawnProcess, receive, record = {}, env) {
  const command = /[\\/]/.test(executable) || path.isAbsolute(executable) ? path.resolve(executable) : executable;
  Object.assign(record, { executable: command, args, startedAt: Date.now(), exitObserved: false, closeObserved: false, stdout: "", stderr: "", messages: [] });
  detail.callerProcesses.push(record);
  const child = spawnProcess(record.executable, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], ...(env ? { env } : {}) });
  record.pid = child.pid ?? null;
  let failure, forceTimer, closeTimer;
  const stop = error => {
    if (!failure) { failure = error; record.error = describe(error); }
    if (record.closeObserved || record.terminationRequestedAt) return;
    record.terminationRequestedAt = Date.now();
    child.stdin.destroy(); child.kill();
    forceTimer = setTimeout(() => { if (!record.closeObserved) child.kill("SIGKILL"); }, 1000);
  };
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", data => {
    if (Buffer.byteLength(record.stdout) + Buffer.byteLength(data) > 1024 * 1024) { stop(Error("Original-download caller stdout exceeds bound")); return; }
    record.stdout += data;
    if (receive && !failure) try { receive(data); } catch (error) { stop(error); }
  });
  child.stderr.on("data", data => {
    if (Buffer.byteLength(record.stderr) + Buffer.byteLength(data) > 65536) { stop(Error("Original-download caller stderr exceeds bound")); return; }
    record.stderr += data;
  });
  child.on("error", stop);
  child.stdin.on("error", error => { if (!record.closeObserved) stop(error); });
  child.once("exit", (code, signal) => Object.assign(record, { exitObserved: true, exitCode: code, signal: signal ?? null, exitedAt: Date.now() }));
  const closed = new Promise(resolve => child.once("close", (code, signal) => {
    Object.assign(record, { closeObserved: true, exitCode: code, signal: signal ?? null, closedAt: Date.now() });
    clearTimeout(forceTimer); clearTimeout(closeTimer); resolve();
  }));
  return {
    record, closed, stop,
    get failure() { return failure; },
    send(message) {
      if (failure || record.closeObserved) throw failure ?? Error("Original-download caller already closed");
      record.messages.push({ direction: "send", at: Date.now(), message: structuredClone(message) });
      child.stdin.write(JSON.stringify(message) + "\n");
    },
    end(input) { if (!record.closeObserved && !child.stdin.destroyed) child.stdin.end(input); },
    async close() {
      this.end();
      if (!record.closeObserved) closeTimer = setTimeout(() => stop(Error("Original-download caller did not close after stdin EOF")), 2000);
      await closed;
      if (failure) throw failure;
      if (record.exitCode !== 0) throw Error(`Original-download caller exited ${record.exitCode}: ${record.stderr}`);
    },
  };
}

export async function runOriginalDownloadProcess({ command, args = [], input, env, timeoutMs = 30000, detail = {}, spawnProcess = spawn }) {
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 180000);
  let timer;
  try {
    const process = startProcess(command, args, { callerProcesses: [] }, spawnProcess, undefined, detail, env);
    timer = setTimeout(() => process.stop(Error("Original-download process response deadline exceeded")), timeoutMs);
    process.end(input);
    await process.closed;
    if (process.failure) throw process.failure;
    if (detail.exitCode !== 0) throw Error(`Original-download process exited ${detail.exitCode}: ${detail.stderr}`);
    return detail.stdout;
  } catch (error) {
    detail.error ??= describe(error); error.originalProcessDetail = detail; throw error;
  } finally { clearTimeout(timer); }
}

function cliAdapter(options, detail) {
  return {
    async call(method, params) {
      const process = {}; detail.callerProcesses.push(process);
      const stdout = await runOriginalDownloadProcess({ command: options.executable,
        args: ["call", "--socket", options.socketPath, "--session-id", options.sessionId, "--method", method, "--params", JSON.stringify(params), "--timeout", "20s"],
        detail: process, spawnProcess: options.spawnProcess, timeoutMs: options.responseTimeoutMs });
      const response = JSON.parse(stdout); process.response = response;
      if (response.error) throw Error(JSON.stringify(response.error));
      assert.equal(response.jsonrpc, "2.0"); assert.ok(Object.hasOwn(response, "result"));
      return response.result;
    },
    async close() {},
  };
}

async function mcpAdapter(options, detail) {
  let buffer = "", sequence = 0, pending;
  const process = startProcess(options.executable, ["mcp", "--socket", options.socketPath, "--session-id", options.sessionId, "--timeout", "20s"], detail, options.spawnProcess, data => {
    buffer += data;
    while (buffer.includes("\n")) {
      const end = buffer.indexOf("\n"), line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      const response = JSON.parse(line);
      process.record.messages.push({ direction: "receive", at: Date.now(), message: response });
      if (response.id === undefined) continue;
      assert.ok(pending && response.id === pending.id, "Unexpected original-download MCP response ID");
      const current = pending; pending = undefined; clearTimeout(current.timer);
      if (response.error) current.reject(Error(JSON.stringify(response.error)));
      else current.resolve(response.result);
    }
  });
  process.closed.then(() => {
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(process.failure ?? Error(`Original-download MCP closed ${process.record.exitCode}: ${process.record.stderr}`)); pending = undefined;
    }
  });
  const request = async (method, params) => {
    assert.equal(pending, undefined, "Original-download MCP requests are sequential");
    if (process.failure || process.record.closeObserved) throw process.failure ?? Error("Original-download MCP is closed");
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => process.stop(Error(`Original-download MCP ${method} response deadline exceeded`)), options.responseTimeoutMs);
      pending = { id, resolve, reject, timer };
      try { process.send({ jsonrpc: "2.0", id, method, params }); }
      catch (error) { process.stop(error); }
    });
  };
  try {
    const initialized = await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "obu-original-download-proof", version: "1.0.0" } });
    assert.equal(initialized.protocolVersion, "2025-06-18");
    process.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  } catch (error) {
    try { await process.close(); } catch (cleanup) { detail.callerCloseError = describe(cleanup); }
    throw error;
  }
  return {
    // Resolves to an error instead of rejecting before a gate starts listening.
    closed: process.closed.then(() => process.failure ?? Error(`Original-download MCP closed ${process.record.exitCode}: ${process.record.stderr}`)),
    checkOpen() { if (process.failure || process.record.closeObserved) throw process.failure ?? Error("Original-download MCP closed before ready gate release"); },
    async call(method, params) {
      const tool = await request("tools/call", { name: "call", arguments: { method, params } });
      if (tool.isError) throw Error(JSON.stringify(tool));
      assert.equal(tool.isError, false);
      const response = tool.structuredContent;
      assert.ok(response && typeof response === "object");
      if (response.error) throw Error(JSON.stringify(response.error));
      assert.ok(Object.hasOwn(response, "result"));
      return response.result;
    },
    async close() { await process.close(); assert.equal(buffer.trim(), "", "Incomplete final MCP response"); },
  };
}

// Parent owns navigation, exact fixture identity, independent DOM/native proof
// and tab finalization. This caller owns arm -> trigger -> collect -> path only.
export async function runOriginalDownloadCaller({ kind, downloadKind, key, executable, socketPath, sessionId, turnId, controlEpoch, tabId, variant,
  detail = {}, spawnProcess = spawn, responseTimeoutMs = 25000, afterReady = async () => {} }) {
  assert.ok(["cli", "mcp"].includes(kind)); assert.ok(["root", "oopif", "dynamic-oopif"].includes(variant));
  assert.ok(["post", "blob"].includes(downloadKind));
  for (const value of [key, executable, socketPath, sessionId, turnId]) assert.ok(typeof value === "string" && value && !value.includes("\0"));
  assert.ok(Number.isSafeInteger(controlEpoch) && controlEpoch >= 1); assert.ok(Number.isSafeInteger(tabId) && tabId >= 0);
  assert.ok(Number.isSafeInteger(responseTimeoutMs) && responseTimeoutMs > 0 && responseTimeoutMs <= 30000);
  assert.equal(typeof afterReady, "function");
  const scope = Object.freeze({ session_id: sessionId, turn_id: turnId, control_epoch: controlEpoch });
  Object.assign(detail, { caller: kind, kind: downloadKind, key, variant, tabId, scope, startedAt: Date.now(), ok: false, passed: false, stages: [], callerProcesses: [] });
  let adapter, failure;
  const stage = async (name, run) => {
    const entry = { stage: name, startedAt: Date.now() }; detail.stages.push(entry); detail.stage = name;
    try { const result = await run(entry); entry.completedAt = Date.now(); return result; }
    catch (error) { entry.failedAt = Date.now(); entry.error = describe(error); throw error; }
  };
  const call = (name, method, params) => stage(name, async entry => {
    entry.method = method; entry.params = { ...scope, ...params };
    const result = await adapter.call(method, entry.params); entry.result = structuredClone(result); return result;
  });
  try {
    const options = { executable, socketPath, sessionId, spawnProcess, responseTimeoutMs };
    adapter = await stage("connect", () => kind === "cli" ? cliAdapter(options, detail) : mcpAdapter(options, detail));
    const submittedAt = Date.now(), armStarted = performance.now();
    const ack = await call("arm", "armDownloadWait", { tabId, timeoutMs: 15000, requirePath: true });
    // Keep a returned ID for cleanup even if another ACK field is malformed.
    if (typeof ack?.waiterId === "string" && ack.waiterId) detail.waiterId = ack.waiterId;
    assert.ok(detail.waiterId && typeof ack.remainingMs === "number" && ack.remainingMs > 0 && ack.remainingMs <= 15000);
    detail.remainingMs = ack.remainingMs; detail.readyAt = Date.now();
    const waitDeadline = Math.min(armStarted + 15000, performance.now() + ack.remainingMs);
    // Wall time is evidence only; actions and the gate share the original
    // monotonic budget even if the system clock moves backwards.
    detail.waitDeadline = Math.min(submittedAt + 15000, detail.readyAt + ack.remainingMs);
    const checkWait = () => {
      const remaining = Math.floor(waitDeadline - performance.now());
      assert.ok(remaining > 0, "Original-download wait deadline exceeded; no further trigger or collect submitted");
      return remaining;
    };
    checkWait();
    await stage("gate", async () => {
      let timer;
      try {
        const expired = new Promise((_, reject) => { timer = setTimeout(() => reject(Error("Original-download ready gate exceeded the original wait deadline; no input submitted")), Math.max(0, waitDeadline - performance.now())); });
        const ready = Object.freeze({ waiterId: detail.waiterId, remainingMs: detail.remainingMs, readyAt: detail.readyAt, scope, tabId });
        adapter.checkOpen?.();
        const contenders = [Promise.resolve().then(() => afterReady(ready)), expired];
        if (adapter.closed) contenders.push(adapter.closed.then(error => { throw error; }));
        await Promise.race(contenders);
        adapter.checkOpen?.();
        checkWait(); detail.gateReleasedAt = Date.now();
      } finally { clearTimeout(timer); }
    });
    checkWait();
    if (variant === "dynamic-oopif") await call("addFrame", "browserAction", { tabId, action: "click", locator: [{ kind: "role", role: "button", name: "Add download frame", exact: true }], timeoutMs: Math.min(5000, checkWait()) });
    const locator = [...(variant === "root" ? [] : [{ kind: "frame", selector: "#download-frame" }]), { kind: "role", role: "button", name: "Download original report", exact: true }];
    const timeoutMs = Math.min(5000, checkWait()); detail.triggerAt = Date.now();
    await call("click", "browserAction", { tabId, action: "click", locator, timeoutMs }); detail.triggerCompletedAt = Date.now();
    checkWait();
    const collected = await call("collect", "collectDownloadWait", { tabId, waiterId: detail.waiterId }); detail.collectedAt = Date.now();
    assert.ok(typeof collected?.downloadId === "string" && collected.downloadId); detail.downloadId = collected.downloadId;
    const file = await call("downloadPath", "downloadPath", { tabId, downloadId: detail.downloadId, timeoutMs: 10000 });
    assert.ok(typeof file?.path === "string" && path.isAbsolute(file.path) && !file.path.includes("\0")); detail.productPath = file.path;
    await stage("readFile", async () => {
      const handle = await fs.open(detail.productPath, "r");
      try {
        const stat = await handle.stat(); assert.ok(stat.isFile() && stat.size > 0 && stat.size < 65536);
        const bytes = await handle.readFile(); assert.equal(bytes.length, stat.size);
        const newline = bytes.indexOf(10); assert.ok(newline > 0, "Original file requires its JSON first line");
        detail.file = { path: detail.productPath, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), base64: bytes.toString("base64"), analysis: JSON.parse(bytes.subarray(0, newline).toString("utf8")) };
      } finally { await handle.close(); }
    });
  } catch (error) {
    failure = error; Object.assign(detail, { failedStage: detail.stage, failedAt: Date.now(), error: describe(error), originalError: error?.message ?? String(error) });
  } finally {
    if (adapter && detail.waiterId) {
      try {
        detail.waitCleanup = { attempted: true, ok: false };
        const result = await call("cancelWait", "cancelDownloadWait", { tabId, waiterId: detail.waiterId });
        assert.deepEqual(result, {}, "Original download waiter cancellation acknowledgement");
        detail.waitCleanup.completed = true; detail.waitCleanup.ok = true;
      }
      catch (error) { detail.waitCleanup.error = describe(error); if (!failure) { failure = error; detail.failedStage = "cancelWait"; detail.error = describe(error); detail.originalError = error?.message ?? String(error); } }
    }
    if (adapter) try { await stage("close", () => adapter.close()); }
    catch (error) { detail.callerCloseError = describe(error); if (!failure) { failure = error; detail.failedStage = "close"; detail.error = describe(error); detail.originalError = error?.message ?? String(error); } }
  }
  if (failure) { failure.originalDownloadCallerDetail = detail; throw failure; }
  detail.passed = true; detail.ok = true; detail.completedAt = Date.now(); return detail;
}
