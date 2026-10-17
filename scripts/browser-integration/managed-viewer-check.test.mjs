import assert from "node:assert/strict";
import test from "node:test";
import { assertManagedViewerFrames, assertManagedViewerTerminal, projectViewerCommand, managedViewerRunArguments, assertManagedBrowserInstallation, projectManagedViewerLifecycle, assertManagedViewerBrowserCommand } from "./managed-viewer-check.mjs";

const cacheInput = {
  executable: "D:\\acceptance\\release\\open-browser-use.exe", browser: "D:\\acceptance\\cache\\155.0.8059.84\\chrome-win64\\chrome.exe",
  extension: "D:\\acceptance\\release\\extension", browserCache: "D:\\acceptance\\cache", root: "D:\\acceptance\\run\\owned-root", name: "viewer-acceptance"
};
const installation = () => ({ version: "155.0.8059.84", platform: "win64", executable: cacheInput.browser,
  archiveSHA256: "507f2a031441d10c62b5e3d4e863f09ac1198a571c1419976cbd8387f639afde",
  executableSHA256: "a2ae305da79e701af793b667c1ca3d87383729040596264e52f51259d7966413", reused: true });

test("cache-mode run uses only the preinstalled cache and EXE-adjacent discovery, never explicit overrides or install", () => {
  const args = managedViewerRunArguments(cacheInput);
  assert.deepEqual(args, ["managed", "run", "--root", cacheInput.root, "--name", cacheInput.name, "--browser-cache", cacheInput.browserCache, "--startup-timeout", "30s"]);
  assert.deepEqual(managedViewerRunArguments({ ...cacheInput, browserCache: undefined }),
    ["managed", "run", "--root", cacheInput.root, "--name", cacheInput.name, "--browser-path", cacheInput.browser, "--extension-dir", cacheInput.extension, "--startup-timeout", "30s"]);
});

test("cache selection refuses empty/relative selectors, nonadjacent extensions and sibling-cache executables", () => {
  for (const change of [
    { browserCache: "" }, { browserCache: ".\\cache" }, { browserCache: "\\cache" }, { executable: "open-browser-use.exe" },
    { browser: "D:\\acceptance\\cache-other\\chrome.exe" }, { browser: "D:\\acceptance\\cache\\..\\foreign.exe" },
    { browser: cacheInput.browserCache }, { extension: "D:\\acceptance\\source\\extension" }, { root: "owned-root" }
  ]) assert.throws(() => managedViewerRunArguments({ ...cacheInput, ...change }));
});

test("offline CLI status must prove the fixed package, original executable bytes and reused installation", () => {
  const expected = { browser: cacheInput.browser, sha256: installation().executableSHA256 };
  assert.deepEqual(assertManagedBrowserInstallation(installation(), expected), installation());
  for (const change of [
    { version: "154.0.0.0" }, { platform: "linux64" }, { archiveSHA256: "0".repeat(64) },
    { executableSHA256: "0".repeat(64) }, { executable: "D:\\foreign\\chrome.exe" },
    { executable: "chrome.exe" }, { reused: false }, { reused: undefined }
  ]) assert.throws(() => assertManagedBrowserInstallation({ ...installation(), ...change }, expected));
  assert.throws(() => assertManagedBrowserInstallation(installation(), { ...expected, sha256: "0".repeat(64) }));
});

test("original lifecycle keeps exact uint64 bytes separately from the compatible JavaScript projection", () => {
  const bytes = Buffer.from('{"version":1,"state":"ready","nativeCreationTime":134050123456789123}');
  const record = projectManagedViewerLifecycle(bytes);
  assert.equal(record.nativeCreationTimeDecimal, "134050123456789123");
  assert.notEqual(String(record.value.nativeCreationTime), record.nativeCreationTimeDecimal);
  assert.equal(record.bytes, bytes.length); assert.match(record.sha256, /^[0-9a-f]{64}$/);
  assert.notEqual(projectManagedViewerLifecycle(Buffer.concat([bytes, Buffer.from("\n")])).sha256, record.sha256);
  assert.equal(projectManagedViewerLifecycle(Buffer.from('{"state":"failed"}')).nativeCreationTimeDecimal, null);
  for (const value of ["0", "-1", "1e3", "18446744073709551616"]) {
    assert.throws(() => projectManagedViewerLifecycle(Buffer.from(`{"nativeCreationTime":${value}}`)));
  }
  assert.throws(() => projectManagedViewerLifecycle(Buffer.from('{"nativeCreationTime":1,"nativeCreationTime":2}')));
});

test("original Browser commandLine must use the expected cache executable in a headless session", () => {
  const lifecycle = { commandLine: [cacheInput.browser, "--headless=new", "--enable-automation"] };
  assert.deepEqual(assertManagedViewerBrowserCommand(lifecycle, cacheInput.browser), { executable: cacheInput.browser, expectedExecutable: cacheInput.browser, matched: true });
  for (const commandLine of [[], ["chrome.exe", "--headless=new"], ["D:\\foreign\\chrome.exe", "--headless=new"], [cacheInput.browser]]) {
    assert.throws(() => assertManagedViewerBrowserCommand({ commandLine }, cacheInput.browser));
  }
});

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
  const delivered = { id: 8, operation: "select", tabId: 7, deliveryId: "original-delivery" };
  assert.deepEqual(projectViewerCommand(delivered), delivered);
  for (const deliveryId of [null, "", "x".repeat(129), "bad\nidentity"]) assert.throws(() => projectViewerCommand({ ...delivered, deliveryId }));
  assert.throws(() => projectViewerCommand({ ...delivered, tabId: null }));
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
