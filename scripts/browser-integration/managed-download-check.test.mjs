import assert from "node:assert/strict";
import test from "node:test";
import { parseManagedReadyOutput, assertManagedStopReply } from "./managed-download-check.mjs";

test("original CLI pretty JSON waits for every partial chunk through the root close", () => {
  const object = { state: "ready", info: { path: 'C:\\private\\escaped"}[]', nested: [{ id: "original" }] } };
  const text = JSON.stringify(object, null, 2);
  for (let end = 0; end < text.length; end++) assert.equal(parseManagedReadyOutput(text.slice(0, end)), null);
  assert.deepEqual(parseManagedReadyOutput(text + "\r\n"), object);
  assert.deepEqual(parseManagedReadyOutput("  " + JSON.stringify(object)), object);
});

test("complete malformed or extra output is rejected without exposing native values", () => {
  for (const input of ['{"secret":"private-value",}', '{"secret":"private-value"]', '{}\n{"secret":"private-value"}', 'private-value', '[]']) {
    assert.throws(() => parseManagedReadyOutput(input), error => !error.message.includes("private-value"));
  }
  assert.throws(() => parseManagedReadyOutput(" ".repeat(2 * 1024 * 1024 + 1)), /size/);
});

test("formal CLI Stop accepts the exact original run and stopped state", () => {
  const runId = "816c8c997cf49ff80de8d990cebd1a89";
  const reply = JSON.parse(`{\n  "runId": "${runId}",\n  "state": "stopped"\n}\n`);
  assert.equal(assertManagedStopReply(reply, runId), reply);
});

test("Stop rejects foreign scope, nonterminal state and generic success", () => {
  const runId = "816c8c997cf49ff80de8d990cebd1a89";
  for (const value of [
    { runId: "f".repeat(32), state: "stopped" },
    { runId, state: "ready" }, { runId, state: "stopping" },
    { runId, stopped: true }, { stopped: true }, { state: "stopped" },
    { runId, state: "stopped", error: "cleanup unconfirmed" },
    null, [], "stopped"
  ]) assert.throws(() => assertManagedStopReply(value, runId), /exact original run/);
  for (const missing of [undefined, "", "invalid", "f".repeat(31)]) {
    assert.throws(() => assertManagedStopReply({ runId, state: "stopped" }, missing), /identity is required/);
  }
});
