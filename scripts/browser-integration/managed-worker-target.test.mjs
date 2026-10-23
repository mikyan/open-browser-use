import assert from "node:assert/strict";
import test from "node:test";
import { managedWorkerScriptURL } from "./managed-worker-target.mjs";

const info = { extensionId: "abcdefghijklmnopabcdefghijklmnop", runId: "0123456789abcdef0123456789abcdef" };

test("managed worker URL identifies the exact extension and run", () => {
  assert.equal(managedWorkerScriptURL(info), "chrome-extension://abcdefghijklmnopabcdefghijklmnop/managed-worker-0123456789abcdef0123456789abcdef.js");
  assert.notEqual(managedWorkerScriptURL({ ...info, runId: "f".repeat(32) }), managedWorkerScriptURL(info));
  assert.notEqual(managedWorkerScriptURL({ ...info, extensionId: "p".repeat(32) }), managedWorkerScriptURL(info));
});

test("invalid managed identities cannot select a worker", () => {
  for (const value of [undefined, null, [], "info", {}, { extensionId: info.extensionId }, { runId: info.runId }]) assert.throws(() => managedWorkerScriptURL(value));
  for (const value of [0, null, [], "a".repeat(31), "a".repeat(33), "q".repeat(32), info.extensionId.toUpperCase(), info.extensionId + "\n", "/".repeat(32), "@".repeat(32)]) assert.throws(() => managedWorkerScriptURL({ ...info, extensionId: value }));
  for (const value of [0, null, [], "a".repeat(31), "a".repeat(33), "g".repeat(32), info.runId.toUpperCase(), info.runId + "\n", "/".repeat(32), "?".repeat(32)]) assert.throws(() => managedWorkerScriptURL({ ...info, runId: value }));
});
