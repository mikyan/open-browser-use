import assert from "node:assert/strict";
import path from "node:path";

// Setup and the trusted POST remain with the owner JS connection. This adapter
// switches only the public response-body reader and records its original scope.
export function createResponseBodyCaller({ kind, browser, endpoint, executable, python, pythonScript, pythonPath, goExecutable, subprocess, tool, detail = {} }) {
  assert.ok(["python", "go", "cli", "mcp"].includes(kind));
  detail.calls ??= []; detail.processes ??= [];
  return async (tab, reference, options) => {
    const scope = { session_id: browser.client.sessionId, turn_id: browser.client.turnId, control_epoch: browser.client.controlEpoch };
    assert.ok(scope.session_id && scope.turn_id && Number.isSafeInteger(scope.control_epoch));
    const record = { kind, tabId: tab.id, reference: structuredClone(reference), options: { ...options }, scope, startedAt: Date.now() }; detail.calls.push(record);
    let response;
    if (kind === "mcp") {
      const args = { tab_id: tab.id, capture_id: reference.captureId, request_id: reference.requestId, max_bytes: options.maxBytes, timeout_ms: options.timeoutMs };
      Object.assign(record, { tool: "response_body", arguments: args });
      const result = await tool("response_body", args); record.toolResult = result;
      assert.equal(result.isError, false, JSON.stringify(result)); response = result.structuredContent;
    } else {
      const config = { endpoint, tabId: tab.id, scope, reference, ...options };
      const args = kind === "cli" ? ["response-body", "--socket", endpoint, "--session-id", scope.session_id, "--turn-id", scope.turn_id,
        "--control-epoch", String(scope.control_epoch), "--tab-id", String(tab.id), "--capture-id", reference.captureId, "--request-id", reference.requestId,
        "--max-bytes", String(options.maxBytes), "--timeout-ms", String(options.timeoutMs), "--timeout", "15s"] : kind === "python" ? [pythonScript] : [];
      const command = kind === "python" ? python : path.resolve(kind === "cli" ? executable : goExecutable);
      const process = { command, args, scope, tabId: tab.id }; detail.processes.push(process); record.processIndex = detail.processes.length - 1;
      const output = await subprocess(command, args, { timeoutMs: 18000, processEvidence: process,
        ...(kind === "cli" ? {} : { input: JSON.stringify(config) + "\n" }),
        ...(kind === "python" ? { env: { ...globalThis.process.env, PYTHONPATH: pythonPath, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8", PYTHONDONTWRITEBYTECODE: "1" } } : {}) });
      response = JSON.parse(output); record.originalOutput = response;
      assert.equal(process.closeObserved, true); assert.equal(process.exitCode, 0); assert.equal(process.signal, null);
      assert.equal(process.terminationRequestedAt, undefined); assert.equal(process.spawnError, undefined);
      if (kind !== "cli") { assert.deepEqual(response.scope, scope); assert.equal(response.tabId, tab.id); assert.equal(response.caller, kind); }
    }
    assert.equal(response.error, undefined, JSON.stringify(response));
    const value = kind === "python" || kind === "go" ? response.value : response.result?.value;
    assert.ok(value, "Original public response body missing"); record.value = value; record.completedAt = Date.now(); return value;
  };
}

export function checkResponseBodyCallers(detail, kind) {
  assert.equal(detail.calls.length, 12);
  if (kind === "mcp") assert.equal(detail.processes.length, 0, "MCP owner process is verified by runner after close");
  else { assert.equal(detail.processes.length, 12); for (const process of detail.processes) { assert.ok(process.pid > 0); assert.equal(process.closeObserved, true); assert.equal(process.exitCode, 0); assert.equal(process.signal, null); assert.equal(process.terminationRequestedAt, undefined); } }
  assert.ok(detail.calls.every(call => call.completedAt >= call.startedAt && call.value?.captureId === call.reference.captureId && call.value?.requestId === call.reference.requestId));
}
