import assert from "node:assert/strict";
import path from "node:path";

export function dialogCaller({ kind, sessionId, client, endpoint, executable, subprocess, tool, detail }) {
  assert.ok(["cli", "mcp"].includes(kind));
  detail.calls ??= []; detail.processes ??= [];
  const invoke = async (method, tabId, value, scope) => {
    const record = { method, tabId, value: structuredClone(value), ...(scope ? { scope } : {}), startedAt: Date.now() }; detail.calls.push(record);
    let response;
    if (kind === "cli") {
      const argv = [method.replace(/[A-Z]/g, char => "-" + char.toLowerCase()), "--socket", endpoint, "--session-id", sessionId, "--tab-id", String(tabId), "--timeout", "10s"];
      argv.push("--turn-id", scope.turn_id, "--control-epoch", String(scope.control_epoch));
      if (method === "armDialog") {
        argv.push("--type", value.type, `--accept=${value.accept}`);
        if (value.message !== undefined) argv.push("--message", value.message);
        if (value.promptText !== undefined) argv.push("--prompt-text", value.promptText);
      } else argv.push("--dialog-id", value.dialogId);
      record.argv = argv;
      const process = { command: path.resolve(executable), argv }; detail.processes.push(process);
      response = JSON.parse(await subprocess(process.command, argv, { processEvidence: process }));
    } else {
      const args = { tab_id: tabId, ...(method === "armDialog" ? { type: value.type, accept: value.accept,
        ...(value.message !== undefined ? { message: value.message } : {}), ...(value.promptText !== undefined ? { prompt_text: value.promptText } : {}), timeout_ms: value.timeoutMs } : { dialog_id: value.dialogId }) };
      const name = method.replace(/[A-Z]/g, char => "_" + char.toLowerCase());
      Object.assign(record, { tool: name, arguments: args });
      const result = await tool(name, args); record.toolResult = result;
      assert.equal(result.isError, false, JSON.stringify(result)); response = result.structuredContent;
    }
    record.response = response; record.completedAt = Date.now();
    assert.equal(response.error, undefined, JSON.stringify(response)); assert.ok(Object.hasOwn(response, "result"));
    return response.result;
  };
  return async (tab, decision, options) => {
    const scope = kind === "cli" ? { turn_id: client.turnId, control_epoch: client.controlEpoch } : undefined;
    if (scope) { assert.ok(scope.turn_id); assert.ok(Number.isSafeInteger(scope.control_epoch) && scope.control_epoch > 0); }
    const ack = await invoke("armDialog", tab.id, { ...decision, timeoutMs: options.timeoutMs }, scope);
    assert.ok(typeof ack.dialogId === "string" && ack.dialogId); assert.ok(ack.remainingMs > 0 && ack.remainingMs <= options.timeoutMs);
    return { ...ack, result: () => invoke("collectDialog", tab.id, { dialogId: ack.dialogId }, scope), cancel: () => invoke("cancelDialog", tab.id, { dialogId: ack.dialogId }, scope) };
  };
}

export function checkDialogCallerProcesses(detail) {
  assert.ok(detail.processes.length > 0);
  for (const process of detail.processes) {
    assert.ok(Number.isSafeInteger(process.pid) && process.pid > 0);
    assert.equal(process.closeObserved, true); assert.equal(process.exitCode, 0); assert.equal(process.signal, null);
    assert.equal(process.terminationRequestedAt, undefined); assert.equal(process.spawnError, undefined);
  }
  assert.equal(detail.calls.length, 54);
  for (let index = 0; index < detail.calls.length; index += 3) {
    const [arm, collect, cancel] = detail.calls.slice(index, index + 3);
    assert.equal(arm.method, "armDialog"); assert.equal(collect.method, "collectDialog"); assert.equal(cancel.method, "cancelDialog");
    assert.equal(collect.value.dialogId, arm.response.result.dialogId); assert.equal(cancel.value.dialogId, collect.value.dialogId);
  }
}
