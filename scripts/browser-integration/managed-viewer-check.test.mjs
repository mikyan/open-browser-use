import assert from "node:assert/strict";
import test from "node:test";
import { assertManagedViewerFrames, assertManagedViewerTerminal, projectViewerCommand } from "./managed-viewer-check.mjs";

const info = { runId: "original-run", nativePID: 7, socketPath: "original-pipe", extensionInstanceId: "original-extension" };
function terminal() {
  const value = { version: 1, state: "closed", info: { ...info }, readyAt: "ready", endedAt: "ended", forced: false,
    nativeDescriptor: { pid: 7, socketPath: "original-pipe" }, nativeCreationTime: 10,
    binding: { bound: true, exclusive: true, extensionInstanceId: "original-extension" } };
  for (const field of ["browserClose", "browserExit", "nativeExit", "jobEmpty", "registrationCleanup", "endpointCleanup"]) value[field] = { at: "2026-10-17T12:00:00Z" };
  value.browserClose.result = {}; value.browserExit.code = value.nativeExit.code = 0; value.jobEmpty.result = { activeProcesses: 0 };
  return value;
}
const frames = () => [1, 2, 3].map(sequence => ({ tabId: 7, streamId: "original", sequence, mimeType: "image/png", bytes: 100, width: 100, height: 80, sha256: String(sequence).repeat(64) }));

test("outgoing viewer evidence preserves typed command IDs but never authentication credentials", () => {
  assert.equal(projectViewerCommand({ type: "authenticate", token: "private-one-use-ticket" }), null);
  const resume = { id: 4, operation: "resume", expectedRevision: 3, expectedWorkerBootId: "original-worker" };
  assert.deepEqual(projectViewerCommand(resume), resume);
  assert.deepEqual(projectViewerCommand({ id: 5, operation: "select", tabId: 7 }), { id: 5, operation: "select", tabId: 7 });
  assert.deepEqual(projectViewerCommand({ id: 6, operation: "stop" }), { id: 6, operation: "stop" });
  for (const command of [null, { id: 0, operation: "pause" }, { id: 1, operation: "evaluate" }, { ...resume, expectedRevision: -1 }, { ...resume, token: "must-not-persist" }, { id: 2, operation: "select", tabId: -1 }]) {
    assert.throws(() => projectViewerCommand(command));
  }
});

test("native stream proof requires changing pixels and increasing sequences for the exact original stream", () => {
  const report = frames();
  assert.deepEqual(assertManagedViewerFrames(report, { tabId: 7, streamId: "original" }), { tabId: 7, streamId: "original", frames: 3, firstSequence: 1, lastSequence: 3 });
  for (const mutate of [
    value => { value[1].sequence = value[0].sequence; },
    value => { value[0].sequence = 0; },
    value => { value[1].tabId = 99; },
    value => { value[1].streamId = "successor"; },
    value => { value[1].mimeType = "image/jpeg"; },
    value => { value[1].bytes = 4 * 1024 * 1024 + 1; },
    value => { value[1].width = 0; },
    value => { value[1].sha256 = "not-a-hash"; },
    value => { value[1].sha256 = value[0].sha256; }
  ]) { const bad = frames(); mutate(bad); assert.throws(() => assertManagedViewerFrames(bad, { tabId: 7, streamId: "original" })); }
});

test("a final stopped state cannot hide missing original cleanup ACKs or failed native process exits", () => {
  assert.doesNotThrow(() => assertManagedViewerTerminal(terminal(), info));
  for (const mutate of [
    value => { value.info.runId = "successor"; },
    value => { value.forced = true; },
    value => { value.browserExit.code = 1; },
    value => { value.nativeExit.code = null; },
    value => { value.nativeDescriptor.pid = 99; },
    value => { value.binding.extensionInstanceId = "replacement"; },
    value => { value.registrationCleanup.error = "registry removal failed"; },
    value => { delete value.endpointCleanup; },
    value => { value.jobEmpty.result.activeProcesses = 1; },
    value => { value.browserClose.result = null; }
  ]) { const bad = terminal(); mutate(bad); assert.throws(() => assertManagedViewerTerminal(bad, info)); }
});
