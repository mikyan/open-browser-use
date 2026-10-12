import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { runOriginalDownloadProcess } from "./original-download-callers.mjs";

const describe = error => error?.stack ?? String(error);
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value, keys, label) => { assert.ok(object(value), label); assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), label); };
const remaining = deadline => { const value = Math.floor(deadline - performance.now()); assert.ok(value > 0, "Original created-page deadline expired"); return value; };
const uuid = value => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);

function rpcResult(response, id) {
  assert.ok(object(response) && response.jsonrpc === "2.0" && response.id === id, "Invalid original RPC response identity");
  const failed = Object.hasOwn(response, "error");
  exact(response, ["jsonrpc", "id", failed ? "error" : "result"], "Invalid original RPC envelope");
  if (failed) throw Error(JSON.stringify(response.error));
  return response.result;
}

function cliAdapter(options, detail) {
  return {
    checkOpen() {},
    async call(method, params, deadline) {
      const timeout = remaining(deadline), record = {}; detail.callerProcesses.push(record);
      const output = await runOriginalDownloadProcess({ command: options.executable,
        args: ["call", "--socket", options.socketPath, "--session-id", options.sessionId, "--method", method, "--params", JSON.stringify(params), "--timeout", `${timeout}ms`],
        timeoutMs: timeout, detail: record, spawnProcess: options.spawnProcess });
      record.response = JSON.parse(output); return rpcResult(record.response, "cli-1");
    },
    async close() { assert.ok(detail.callerProcesses.every(record => record.closeObserved), "Every original CLI process must actually close"); },
  };
}

// One actual MCP process, with EOF/exit/close kept distinct. No reconnect or
// request replay. A failed/expired request terminates this exact process.
function mcpAdapter(options, detail) {
  const command = /[\\/]/.test(options.executable) ? path.resolve(options.executable) : options.executable;
  const record = { executable: command, args: ["mcp", "--socket", options.socketPath, "--session-id", options.sessionId, "--timeout", "20s"], startedAt: Date.now(), stdout: "", stderr: "", messages: [], exitObserved: false, closeObserved: false };
  detail.callerProcesses.push(record);
  const child = options.spawnProcess(command, record.args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }); record.pid = child.pid ?? null;
  let failure, pending, buffer = "", sequence = 0, forceTimer, closeTimer;
  const stop = error => {
    failure ??= error; record.error ??= describe(error);
    if (record.closeObserved || record.terminationRequestedAt) return;
    record.terminationRequestedAt = Date.now(); child.stdin.destroy(); child.kill();
    forceTimer = setTimeout(() => { if (!record.closeObserved) child.kill("SIGKILL"); }, 1000);
  };
  const checkOpen = () => { if (failure || record.closeObserved) throw failure ?? Error(`Created-page MCP closed ${record.exitCode}: ${record.stderr}`); };
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", data => {
    if (Buffer.byteLength(record.stdout) + Buffer.byteLength(data) > 1024 * 1024) return stop(Error("Created-page MCP stdout exceeds bound"));
    record.stdout += data; buffer += data;
    try {
      while (buffer.includes("\n")) {
        const end = buffer.indexOf("\n"), line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        const response = JSON.parse(line); record.messages.push({ direction: "receive", at: Date.now(), message: response });
        assert.ok(object(response) && response.jsonrpc === "2.0", "Invalid MCP response");
        if (!Object.hasOwn(response, "id")) { assert.ok(typeof response.method === "string", "Invalid MCP notification"); continue; }
        assert.ok(pending && response.id === pending.id, "Unexpected created-page MCP response ID");
        const current = pending;
        let value; try { value = rpcResult(response, current.id); } catch (error) { pending = undefined; clearTimeout(current.timer); current.reject(error); continue; }
        pending = undefined; clearTimeout(current.timer); current.resolve(value);
      }
    } catch (error) { stop(error); }
  });
  child.stderr.on("data", data => {
    if (Buffer.byteLength(record.stderr) + Buffer.byteLength(data) > 65536) return stop(Error("Created-page MCP stderr exceeds bound"));
    record.stderr += data;
  });
  child.on("error", stop); child.stdin.on("error", error => { if (!record.closeObserved) stop(error); });
  child.once("exit", (code, signal) => Object.assign(record, { exitObserved: true, exitCode: code, signal: signal ?? null, exitedAt: Date.now() }));
  const closed = new Promise(resolve => child.once("close", (code, signal) => {
    Object.assign(record, { closeObserved: true, exitCode: code, signal: signal ?? null, closedAt: Date.now() }); clearTimeout(forceTimer); clearTimeout(closeTimer);
    if (pending) { clearTimeout(pending.timer); pending.reject(failure ?? Error(`Created-page MCP closed ${code}: ${record.stderr}`)); pending = undefined; }
    resolve(failure ?? Error(`Created-page MCP closed ${code}: ${record.stderr}`));
  }));
  const send = message => { checkOpen(); record.messages.push({ direction: "send", at: Date.now(), message: structuredClone(message) }); child.stdin.write(JSON.stringify(message) + "\n"); };
  const request = (method, params, deadline) => {
    checkOpen(); assert.equal(pending, undefined, "MCP requests must remain sequential"); const timeout = remaining(deadline);
    return new Promise((resolve, reject) => {
      const id = ++sequence; pending = { id, resolve, reject, timer: setTimeout(() => stop(Error(`Created-page MCP ${method} response deadline expired`)), timeout) };
      try { send({ jsonrpc: "2.0", id, method, params }); } catch (error) { stop(error); }
    });
  };
  return {
    closed, checkOpen,
    async initialize(deadline) {
      const result = await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "obu-created-page-proof", version: "1.0.0" } }, deadline);
      assert.equal(result?.protocolVersion, "2025-06-18", "MCP protocol acknowledgement"); remaining(deadline); checkOpen();
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
    },
    async call(method, params, deadline) {
      const tool = await request("tools/call", { name: "call", arguments: { method, params } }, deadline);
      assert.ok(object(tool) && tool.isError === false, `Created-page MCP tool failed: ${JSON.stringify(tool)}`);
      return rpcResult(tool.structuredContent, "cli-1");
    },
    async close() {
      record.eofRequestedAt = Date.now(); if (!child.stdin.destroyed) child.stdin.end();
      if (!record.closeObserved) closeTimer = setTimeout(() => stop(Error("Created-page MCP did not close after stdin EOF")), 2000);
      await closed;
      if (failure) throw failure;
      assert.equal(record.exitCode, 0, "Original MCP process exit"); assert.equal(buffer.trim(), "", "Incomplete final MCP response");
    },
  };
}

function sourceState(value, config, clicked = false) {
  for (const key of ["key", "owner", "variant"]) assert.equal(value[key], config[key], "Wrong original source document");
  assert.ok(uuid(value.sourceNonce) && uuid(value.documentToken), "Original source identities");
  assert.ok(Array.isArray(value.clicks) && value.clicks.length === Number(clicked), "One original source click");
  if (clicked) {
    const click = value.clicks[0]; assert.ok(click.trusted === true && click.ctrlKey === true && click.metaKey === false && click.altKey === false && click.shiftKey === false && click.button === 0 && click.sequence === 1, "Sole trusted Control click");
    for (const key of ["sourceNonce", "documentToken"]) assert.equal(click[key], value[key], "Source click identity");
  }
  return value;
}
function childState(value, before) {
  assert.ok(uuid(value.documentNonce) && uuid(value.documentToken), "Original child identities");
  if (!before) assert.deepEqual(value.clicks, [], "Child was already used");
  else {
    for (const key of ["documentNonce", "documentToken"]) assert.equal(value[key], before[key], "Child identity changed");
    assert.deepEqual(value.clicks, [{ trusted: true, sequence: 1, documentNonce: value.documentNonce, documentToken: value.documentToken }], "One original child commit");
  }
  return value;
}

export async function runCreatedPageCaller({ kind, executable, socketPath, sessionId, turnId, controlEpoch, tabId, variant, key, owner, detail = {}, afterReady = async () => {}, afterPrepared = async () => {}, spawnProcess = spawn }) {
  assert.ok(["cli", "mcp"].includes(kind) && ["root", "oopif", "dynamic-oopif"].includes(variant));
  for (const v of [executable, socketPath, sessionId, turnId, key, owner]) assert.ok(typeof v === "string" && v.length > 0 && v.length <= 4096 && !v.includes("\0"));
  assert.ok(Number.isSafeInteger(controlEpoch) && controlEpoch >= 1 && Number.isSafeInteger(tabId) && tabId >= 0);
  assert.equal(typeof afterReady, "function"); assert.equal(typeof afterPrepared, "function");
  const scope = Object.freeze({ session_id: sessionId, turn_id: turnId, control_epoch: controlEpoch }), config = { key, owner, variant };
  Object.assign(detail, { caller: kind, scope, tabId, key, owner, variant, stages: [], callerProcesses: [], waitCleanup: { attempted: false, ok: false }, clientClose: { attempted: false, ok: false }, ok: false });
  let adapter, failure, deadline;
  const stage = async (name, operation, cleanup = false) => {
    const record = { name, startedAt: Date.now(), ok: false }; detail.stages.push(record); detail.stage = name;
    try { if (!cleanup) { adapter?.checkOpen(); remaining(deadline); } const result = await operation(record); if (!cleanup) { adapter?.checkOpen(); remaining(deadline); } record.ok = true; return result; }
    catch (error) { record.error = describe(error); throw error; }
    finally { record.finishedAt = Date.now(); }
  };
  const call = (name, method, params, { cleanup = false, capture } = {}) => stage(name, async entry => {
    const end = cleanup ? performance.now() + 2000 : deadline;
    entry.method = method; entry.params = { ...params, ...scope };
    const result = await adapter.call(method, entry.params, end); entry.result = structuredClone(result); capture?.(result); return result;
  }, cleanup);
  const action = async (name, targetId, actionName, locator, extra = {}) => {
    const available = remaining(deadline) - 1000; assert.ok(available > 0, "Original created-page action deadline expired before transport reserve");
    const result = await call(name, "browserAction", { tabId: targetId, action: actionName, locator, args: extra, timeoutMs: Math.min(5000, available) });
    assert.ok(object(result) && object(result.engine) && result.engine.name === "playwright-crx" && typeof result.engine.version === "string" && typeof result.engine.playwrightVersion === "string" && Object.hasOwn(result, "value"), "Invalid browser action result"); return result.value;
  };
  const readState = async (name, targetId, frame = []) => {
    for (;;) {
      const text = await action(name, targetId, "textContent", [...frame, { kind: "css", selector: "#state" }]);
      assert.ok(typeof text === "string" && Buffer.byteLength(text) <= 65536, "Invalid original document state");
      if (text !== "") { const state = JSON.parse(text); assert.ok(object(state), "Invalid document JSON"); return state; }
      await new Promise(resolve => setTimeout(resolve, Math.min(25, remaining(deadline))));
    }
  };
  const gate = (name, callback, value) => stage(name, async () => {
    let timer;
    try {
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`Created-page ${name} exceeded original deadline; no further input submitted`)), remaining(deadline)); });
      const contenders = [Promise.resolve().then(() => { adapter.checkOpen(); remaining(deadline); return callback(Object.freeze(value)); }), timeout];
      if (adapter.closed) contenders.push(adapter.closed.then(error => { throw error; }));
      await Promise.race(contenders); adapter.checkOpen(); remaining(deadline);
    } finally { clearTimeout(timer); }
  });
  try {
    deadline = performance.now() + 20000; detail.firstRequestAt = Date.now();
    adapter = kind === "cli" ? cliAdapter({ executable, socketPath, sessionId, spawnProcess }, detail) : mcpAdapter({ executable, socketPath, sessionId, spawnProcess }, detail);
    await stage("connect", () => adapter.initialize?.(deadline));
    const info = await call("capability", "getInfo", {}); assert.equal(info?.metadata?.pageWaitVersion, 1, "OBU_PAGE_WAIT_UNSUPPORTED: extension requires pageWaitVersion 1");
    const control = async name => {
      const value = await call(name, "getControlState", {}); assert.ok(object(value) && value.lifecycleVersion === 1 && value.controlEpoch === controlEpoch && value.closing === false && typeof value.nextTurnId === "string" && value.nextTurnId, "Original control scope changed"); return value;
    };
    detail.scopeBefore = await control("scopeBefore");
    detail.rootBefore = sourceState(await readState("rootBefore", tabId), config); assert.deepEqual(detail.rootBefore.frameAdds, [], "Source fixture was already used");
    const sentBudget = remaining(deadline) - 1000; assert.ok(sentBudget > 0, "No remaining readiness budget");
    const ack = await call("ready", "armPageWait", { tabId, timeoutMs: sentBudget }, { capture: value => { if (typeof value?.waiterId === "string" && value.waiterId) detail.waiterId = value.waiterId; } });
    exact(ack, ["waiterId", "remainingMs"], "Invalid page readiness acknowledgement"); assert.ok(detail.waiterId && !detail.waiterId.includes("\0") && Number.isFinite(ack.remainingMs) && ack.remainingMs > 0 && ack.remainingMs <= sentBudget, "Invalid page readiness budget");
    deadline = Math.min(deadline, performance.now() + ack.remainingMs); detail.remainingMs = ack.remainingMs; detail.readyAt = Date.now();
    await gate("gate", afterReady, { waiterId: detail.waiterId, remainingMs: detail.remainingMs, readyAt: detail.readyAt, scope, tabId }); detail.releaseObservedAt = Date.now();
    if (variant === "dynamic-oopif") await action("addFrame", tabId, "click", [{ kind: "css", selector: "#add-frame" }]);
    const frame = variant === "root" ? [] : [{ kind: "frame", selector: "#created-page-frame" }];
    detail.sourceBefore = sourceState(await readState("sourceBefore", tabId, frame), config); detail.preparedAt = Date.now();
    await gate("preparedGate", afterPrepared, { waiterId: detail.waiterId, remainingMs: remaining(deadline), scope, tabId, key, owner, variant, sourceBefore: structuredClone(detail.sourceBefore), preparedAt: detail.preparedAt }); detail.preparedReleaseObservedAt = Date.now();
    detail.triggerAt = Date.now(); await action("trigger", tabId, "click", [...frame, { kind: "css", selector: "#open-child" }], { modifiers: ["Control"] });
    const child = await call("collect", "collectPageWait", { tabId, waiterId: detail.waiterId }); exact(child, ["tabId"], "Invalid page collection acknowledgement");
    assert.ok(Number.isSafeInteger(child.tabId) && child.tabId >= 0 && child.tabId !== tabId, "Invalid original returned child"); detail.childId = child.tabId; detail.collectedAt = Date.now();
    detail.sourceAfter = sourceState(await readState("sourceAfter", tabId, frame), config, true);
    for (const k of ["sourceNonce", "documentToken"]) assert.equal(detail.sourceAfter[k], detail.sourceBefore[k], "Source changed during trigger");
    detail.rootAfter = variant === "root" ? detail.sourceAfter : sourceState(await readState("rootAfter", tabId), config);
    assert.deepEqual(detail.rootAfter.frameAdds, variant === "dynamic-oopif" ? [{ trusted: true, sequence: 1 }] : [], "Original dynamic frame add");
    detail.childBefore = childState(await readState("childBefore", child.tabId));
    await action("fillKey", child.tabId, "fill", [{ kind: "label", value: "Source key", exact: true }], { value: key });
    await action("fillOwner", child.tabId, "fill", [{ kind: "label", value: "Owner", exact: true }], { value: owner });
    await action("commit", child.tabId, "click", [{ kind: "css", selector: "#commit" }]);
    for (;;) {
      const text = await action("receipt", child.tabId, "textContent", [{ kind: "css", selector: "#result" }]);
      assert.ok(typeof text === "string" && Buffer.byteLength(text) <= 65536, "Invalid child receipt");
      if (text !== "") { detail.receipt = JSON.parse(text); assert.deepEqual(detail.receipt, { ok: true, key, owner, documentNonce: detail.childBefore.documentNonce }, "Wrong child receipt"); break; }
      await new Promise(resolve => setTimeout(resolve, Math.min(25, remaining(deadline))));
    }
    detail.childAfter = childState(await readState("childAfter", child.tabId), detail.childBefore); detail.scopeAfter = await control("scopeAfter");
  } catch (error) { failure = error; detail.failedStage = detail.stage; detail.error = describe(error); detail.originalError = error?.message ?? String(error); }
  finally {
    if (adapter && detail.waiterId) {
      detail.waitCleanup.attempted = true;
      try { exact(await call("waitCleanup", "cancelPageWait", { tabId, waiterId: detail.waiterId }, { cleanup: true }), [], "Exact waiter cleanup acknowledgement"); detail.waitCleanup.ok = true; }
      catch (error) { detail.waitCleanup.error = describe(error); failure ??= error; }
    }
    if (adapter) {
      detail.clientClose.attempted = true;
      try { await stage("close", () => adapter.close(), true); Object.assign(detail.clientClose, { ok: true, returnedAt: Date.now() }); }
      catch (error) { detail.clientClose.error = describe(error); failure ??= error; }
    }
  }
  if (failure) { detail.error ??= describe(failure); detail.originalError ??= failure.message; failure.createdPageCallerDetail = detail; throw failure; }
  detail.ok = true; detail.completedAt = Date.now(); return detail;
}
