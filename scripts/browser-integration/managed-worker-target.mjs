import assert from "node:assert/strict";

// Match only the entry staged for this managed run, never a previous run's worker.
export function managedWorkerScriptURL(info) {
  assert.ok(info && typeof info === "object" && !Array.isArray(info), "Managed run info is required");
  assert.equal(typeof info.extensionId, "string");
  assert.equal(info.extensionId.length, 32, "Managed extension ID must contain 32 characters");
  assert.match(info.extensionId, /^[a-p]{32}$/);
  assert.equal(typeof info.runId, "string");
  assert.equal(info.runId.length, 32, "Managed run ID must contain 32 characters");
  assert.match(info.runId, /^[0-9a-f]{32}$/);
  return `chrome-extension://${info.extensionId}/managed-worker-${info.runId}.js`;
}
