import assert from "node:assert/strict";
import path from "node:path";
import { createHash } from "node:crypto";
import WebSocket from "ws";
import { observedProcessDescendants } from "./observed-process-descendants.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const samePath = (left, right) => path.win32.resolve(left).toLowerCase() === path.win32.resolve(right).toLowerCase();

export function readRecommendedBrowserVersion(source) {
  assert.ok(typeof source === "string" && source.length <= 128 * 1024);
  const versions = [...source.matchAll(/^const RecommendedVersion = "([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+)"\s*$/gm)];
  assert.equal(versions.length, 1, "The frozen production runtime must declare exactly one fixed recommendation");
  return versions[0][1];
}

// Serialized into the existing original worker for passive observation only.
// Never wraps/patches native send or ACK, nor retains image data or page text.
export function installManagedNativeRecoveryObserver(chrome, target = globalThis) {
  if (target.__managedHumanAcceptance) throw new Error("Original observer already installed");
  const events = []; let overflow = false, active = true;
  const metadataKeys = ["offsetTop", "pageScaleFactor", "deviceWidth", "deviceHeight", "scrollOffsetX", "scrollOffsetY", "timestamp", "monotonicTimestamp"];
  const copySource = source => Object.fromEntries(["tabId", "targetId", "sessionId"].filter(key => Number.isSafeInteger(source?.[key]) || typeof source?.[key] === "string" && source[key].length <= 256).map(key => [key, source[key]]));
  const append = event => { if (events.length >= 512) overflow = true; else events.push(event); };
  const onEvent = (source, method, params) => {
    if (!["Page.screencastFrame", "Page.frameNavigated", "Page.frameDetached", "Page.frameResized", "Runtime.executionContextsCleared"].includes(method)) return;
    const event = { at: Date.now(), method, source: copySource(source) };
    if (method === "Page.screencastFrame") {
      event.nativeSessionId = params?.sessionId;
      event.metadataKeys = Object.keys(params?.metadata ?? {}).filter(key => key.length <= 64).slice(0, 32);
      event.metadata = Object.fromEntries(metadataKeys.filter(key => Number.isFinite(params?.metadata?.[key])).map(key => [key, params.metadata[key]]));
    }
    append(event);
  };
  const onDetach = (source, reason) => append({ at: Date.now(), method: "debugger.onDetach", source: copySource(source), reason: String(reason).slice(0, 128) });
  chrome.debugger.onEvent.addListener(onEvent); chrome.debugger.onDetach.addListener(onDetach);
  const snapshot = () => ({ events: structuredClone(events), overflow, listenerPresent: active });
  Object.defineProperty(target, "__managedHumanAcceptance", { configurable: true, value: Object.freeze({ snapshot, stop() { chrome.debugger.onEvent.removeListener(onEvent); chrome.debugger.onDetach.removeListener(onDetach); active = false; return snapshot(); } }) });
  return { listenerPresent: true, readOnly: true, maximumEvents: 512, numericMetadataOnly: true };
}

export function projectNativeRecoveryLifecycle(bytes) {
  assert.ok(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= 1024 * 1024);
  const text = bytes.toString("utf8"), value = JSON.parse(text);
  // Retain Go uint64 process timestamps exactly; normal JSON.parse rounds them.
  const exact = JSON.parse(text.replace(/("(?:nativeCreationTime|creationTime)"\s*:\s*)(\d+)(?=\s*[,}])/g, '$1"$2"'));
  return { value, exact, bytes: bytes.length, sha256: hash(bytes) };
}

export function originalNativeLossAuthority({ info, lifecycle, exact, processes }) {
  assert.equal(lifecycle.state, "ready"); assert.equal(lifecycle.info.runId, info.runId);
  assert.equal(lifecycle.nativeDescriptor.pid, info.nativePID); assert.equal(lifecycle.nativeDescriptor.socketPath, info.socketPath);
  assert.equal(lifecycle.binding.bound, true); assert.equal(lifecycle.binding.exclusive, true);
  const family = observedProcessDescendants(processes, info.browserPID);
  const process = family.find(row => row.ProcessId === info.nativePID);
  assert.ok(process, "Original native host must belong to the observed original browser incarnation");
  assert.ok(samePath(process.ExecutablePath, path.win32.join(info.runDir, "native-host.exe")));
  const creationTime = exact.nativeCreationTime;
  assert.match(creationTime, /^[1-9][0-9]{0,19}$/); assert.ok(BigInt(creationTime) <= 18446744073709551615n);
  return { ProcessId: process.ProcessId, ExecutablePath: process.ExecutablePath, CreationDate: process.CreationDate, CreationTimeDecimal: creationTime,
    runId: info.runId, browser: family.find(row => row.ProcessId === info.browserPID), source: "Original managed lifecycle verified its retained process in the owned Job; native FILETIME and observed path/creation are rechecked before one exact-handle fault." };
}

// Harness fault only. The process object retains its real native handle before
// any identity comparison; Kill and Wait use that same Process, never taskkill.
export const originalNativeLossSource = `param([string]$EvidenceFile)
$ErrorActionPreference = 'Stop'
$expected = Get-Content -LiteralPath $EvidenceFile -Raw | ConvertFrom-Json
if (!$expected.runId -or !$expected.CreationTimeDecimal -or !$expected.ExecutablePath) { throw 'Incomplete original native identity' }
$original = [System.Diagnostics.Process]::GetProcessById([int]$expected.ProcessId)
try {
  $null = $original.Handle
  $actualTime = $original.StartTime.ToUniversalTime().ToFileTimeUtc().ToString()
  $actual = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + [int]$expected.ProcessId)
  if ($actualTime -ne [string]$expected.CreationTimeDecimal -or !$actual -or $actual.ExecutablePath -ne $expected.ExecutablePath -or $actual.CreationDate.ToUniversalTime().ToString('o') -ne $expected.CreationDate) { throw 'Original native process identity changed; no termination' }
  $requested = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $original.Kill()
  if (!$original.WaitForExit(10000)) { throw 'Original native handle did not exit' }
  @{pid=$expected.ProcessId; runId=$expected.runId; creationTimeDecimal=$actualTime; executable=$actual.ExecutablePath; creationDate=$expected.CreationDate; requestedAt=$requested; exitedAt=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); exitCode=$original.ExitCode; exactHandle=$true; faults=1} | ConvertTo-Json -Compress
} finally { $original.Dispose() }
`;

export function assertSameWorkerNativeReplacement(before, after) {
  for (const value of [before, after]) {
    assert.ok(value && value.info && value.binding && value.worker && value.browser);
    for (const key of ["targetId", "contextUniqueId", "workerBootId"]) assert.ok(typeof value.worker[key] === "string" && value.worker[key].length > 0, `Missing original worker ${key}`);
    for (const key of ["portId", "extensionId", "extensionInstanceId", "workerBootId"]) assert.ok(typeof value.binding[key] === "string" && value.binding[key].length > 0, `Missing native ${key}`);
    assert.ok(Number.isSafeInteger(value.epoch) && value.epoch > 0);
    assert.match(value.binding.generation, /^[0-9a-f]{32}$/);
    assert.match(value.nativeCreationTime, /^[1-9][0-9]{0,19}$/);
    assert.equal(value.worker.workerBootId, value.binding.workerBootId);
  }
  for (const key of ["runId", "browserPID", "profileDir", "extensionId", "extensionInstanceId", "nativeHostName"]) assert.equal(after.info[key], before.info[key], `Recovery changed ${key}`);
  assert.deepEqual(after.browser, before.browser, "Original browser process identity changed");
  for (const key of ["targetId", "contextUniqueId", "workerBootId"]) assert.equal(after.worker[key], before.worker[key], `Same-worker recovery changed ${key}`);
  for (const key of ["extensionId", "extensionInstanceId", "workerBootId"]) assert.equal(after.binding[key], before.binding[key], `Binding identity changed ${key}`);
  for (const key of ["portId", "generation"]) assert.notEqual(after.binding[key], before.binding[key], `Original native ${key} was reused`);
  assert.equal(after.binding.bound, true); assert.equal(after.binding.exclusive, true); assert.equal(after.binding.behavior, "default");
  assert.notEqual(after.info.socketPath, before.info.socketPath, "Original native endpoint reused");
  assert.notDeepEqual({ pid: after.info.nativePID, created: after.nativeCreationTime }, { pid: before.info.nativePID, created: before.nativeCreationTime }, "Original native process was not replaced");
  assert.equal(after.epoch, before.epoch + 1, "Recovery must publish exactly one new connection epoch");
}

export function assertNativeRecoveryExit(receipt, expectedCode, { fault = false } = {}) {
  assert.ok(Number.isInteger(expectedCode) && expectedCode >= -2147483648 && expectedCode <= 4294967295);
  const code = expectedCode >>> 0;
  assert.ok(Number.isFinite(Date.parse(receipt?.at)), "Missing original native exit time");
  assert.equal(receipt.code, code, "Native exit must match the original retained handle");
  if (fault) {
    assert.notEqual(code, 0, "The explicit fault must not be relabelled normal EOF");
    assert.equal(receipt.error, `managed process exited with code ${code}`, "Retain exactly the confirmed original fault error, not an unknown wait failure");
  } else { assert.equal(code, 0); assert.equal(receipt.error, undefined); }
  return receipt;
}

// HTTP projects the private cleanup counter/error into this boolean. Never
// substitute a missing public receipt with an assumed private counter value.
export function assertPublicPausedViewerCleanup(value, { leaseId } = {}) {
  assert.equal(value?.status?.state, "paused");
  assert.equal(value.status.inputBlocked, true);
  assert.equal(value.status.cleanupComplete, true);
  assert.equal(value.viewerCleanupComplete, true);
  assert.equal(value.human, null);
  assert.equal(value.view, null);
  assert.equal(value.selectedTabId, null);
  if (leaseId !== undefined) {
    assert.ok(typeof leaseId === "string" && leaseId.length > 0);
    assert.deepEqual(value.humanCleanup, { leaseId, cleanupConfirmed: true });
  }
  return value;
}

// An old token is never logged or placed in a URL query. A rejection is either
// an actual auth/transport closure or original listener absence, not a timeout.
export async function probeRejectedViewerToken(origin, token, timeoutMs = 5000) {
  const url = new URL(origin); assert.equal(url.protocol, "http:"); assert.equal(url.hostname, "127.0.0.1");
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  const record = { origin: url.origin, tokenSHA256: hash(token), requestedAt: Date.now(), authenticated: false, messages: [] };
  await new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://${url.host}/ws`, { origin: url.origin, handshakeTimeout: timeoutMs });
    let settled = false;
    const finish = error => { if (settled) return; settled = true; clearTimeout(timer); socket.terminate(); error ? reject(error) : resolve(); };
    const timer = setTimeout(() => finish(new Error("Old viewer token probe did not actually settle")), timeoutMs);
    socket.on("open", () => socket.send(JSON.stringify({ type: "authenticate", token })));
    socket.on("message", bytes => {
      try { assert.ok(record.messages.length < 8 && bytes.length < 65536); const message = JSON.parse(bytes.toString()); assert.notEqual(message.type, "authenticated", "Old viewer token gained new authority"); record.messages.push({ type: message.type, code: message.error?.code }); }
      catch (error) { finish(error); }
    });
    socket.on("unexpected-response", (_request, response) => { record.httpStatus = response.statusCode; response.resume(); if ([401, 403, 404, 410, 503].includes(response.statusCode)) finish(); else finish(new Error("Unexpected old viewer HTTP response")); });
    socket.on("close", (code, reason) => { record.closedAt = Date.now(); record.closeCode = code; record.reasonBytes = reason.length; finish(); });
    socket.on("error", error => { record.transportError = { code: error.code ?? null, name: error.name }; if (error.code === "ECONNREFUSED" || error.code === "ECONNRESET") finish(); else finish(error); });
  });
  record.completedAt = Date.now(); return record;
}
