import assert from "node:assert/strict";
import path from "node:path";

export const nativeLifecycleCases = Object.freeze(["native-host-exit", "native-extension-reload", "native-paused-reload"]);
export const nativeCreatedPageCases = Object.freeze(["native-created-page-host-loss"]);
export const nativeIdleDurationMs = 10000;
export function resolveNativeLifecycleMode(value = "acceptance") {
  assert.ok(["acceptance", "idle-diagnostic", "created-page-host-loss", "created-page-cleanup", "auxiliary-delivery"].includes(value), `Unknown OBU_TEST_NATIVE_MODE: ${value}`);
  return value;
}
export function resolveNativeCleanupScenario(mode, change, recovery) {
  resolveNativeLifecycleMode(mode);
  if (mode !== "created-page-cleanup") {
    assert.equal(change, undefined, "OBU_TEST_NATIVE_CHANGE requires created-page-cleanup mode");
    assert.equal(recovery, undefined, "OBU_TEST_NATIVE_RECOVERY requires created-page-cleanup mode");
    return null;
  }
  assert.ok(["source-navigation", "child-close"].includes(change), `Unknown OBU_TEST_NATIVE_CHANGE: ${change}`);
  assert.ok(["session-bootstrap", "retry-pause"].includes(recovery), `Unknown OBU_TEST_NATIVE_RECOVERY: ${recovery}`);
  return { change, recovery, name: `native-created-page-cleanup-${change}-${recovery}` };
}
export function allNativeLifecycleCasesPassed(records, expected = nativeLifecycleCases) {
  return records.length === expected.length && expected.every(name => records.filter(value => value.name === name && value.passed === true).length === 1);
}
export function resolveNativeDeliveryScenario(mode, phase, interruption) {
  resolveNativeLifecycleMode(mode);
  if (mode !== "auxiliary-delivery") {
    assert.equal(phase, undefined, "OBU_TEST_NATIVE_DELIVERY_PHASE requires auxiliary-delivery mode");
    assert.equal(interruption, undefined, "OBU_TEST_NATIVE_INTERRUPTION requires auxiliary-delivery mode");
    return null;
  }
  assert.ok(["claim-delete", "marker-write"].includes(phase), `Unknown OBU_TEST_NATIVE_DELIVERY_PHASE: ${phase}`);
  assert.ok(["host-loss", "worker-stop"].includes(interruption), `Unknown OBU_TEST_NATIVE_INTERRUPTION: ${interruption}`);
  const variants = ["root", "oopif", "dynamic-oopif"];
  return { phase, interruption, variants, names: variants.map(variant => `native-auxiliary-delivery-${phase}-${interruption}-${variant}`) };
}
export function selectCleanupPopupWindow(windows, { sentinelWindowId, sourceWindowId }) {
  assert.ok(Array.isArray(windows));
  const focused = windows.filter(window => window.focused === true);
  assert.equal(focused.length, 1, "Cleanup popup requires one already focused private window");
  const window = focused[0];
  assert.equal(window.type, "normal"); assert.ok(Number.isSafeInteger(window.id));
  assert.ok([sentinelWindowId, sourceWindowId].includes(window.id), "Focused window is not an exact fixture window");
  return window.id;
}

// Serialized into the real popup. Keep every check inside this function so a
// delayed context lookup cannot dispatch a click into a replacement document.
export async function clickCleanupPopup(expected, originalContext) {
  const fields = ["contextType", "contextId", "documentId", "documentUrl", "tabId"];
  if (!expected || !Number.isFinite(expected.expiresAt) ||
      !(expected.action === "pause" && ["Pause all agents", "Retry pause"].includes(expected.label) ||
        expected.action === "resume" && expected.label === "Resume control"))
    throw Error("Invalid cleanup popup click expectation");
  if (originalContext?.contextType !== "POPUP" || !Number.isSafeInteger(originalContext.tabId) ||
      ["contextId", "documentId", "documentUrl"].some(field => typeof originalContext[field] !== "string" || !originalContext[field]))
    throw Error("Invalid original cleanup popup context");
  const expiresAt = expected.expiresAt, label = expected.label, action = expected.action;
  const original = Object.fromEntries(fields.map(field => [field, originalContext[field]])), originalDocument = document;
  if (Date.now() >= expiresAt) throw Error("Cleanup popup click deadline expired");
  const contexts = await chrome.runtime.getContexts({ contextTypes: ["POPUP"] });
  if (!Array.isArray(contexts) || contexts.length !== 1 ||
      fields.some(field => contexts[0]?.[field] !== original[field]))
    throw Error("Original cleanup popup context changed before click");
  if (document !== originalDocument || document.URL !== original.documentUrl)
    throw Error("Original cleanup popup document changed before click");
  if (Date.now() >= expiresAt) throw Error("Cleanup popup click deadline expired");
  const button = document.querySelector("#automation-toggle");
  if (!button || button.disabled !== false || button.textContent?.trim() !== label || button.dataset?.action !== action)
    throw Error("Cleanup popup button changed before click");
  const clickedAt = Date.now();
  if (clickedAt >= expiresAt) throw Error("Cleanup popup click deadline expired");
  button.click();
  return { clickedAt, label, action, context: original };
}

// A diagnostic may collect an unwanted focus event successfully. Keep that
// observation separate from acceptance and require the same teardown evidence.
export function nativeLifecycleOutcome(report) {
  const mode = resolveNativeLifecycleMode(report.mode);
  const complete = !report.error && report.registrationCleanup?.removed === true && !!report.nativeCleanup &&
    !report.nativeCleanupError && !report.browserCleanupError && !report.browserProcessInventoryError &&
    !report.browserProcessCleanupError && !!report.browserProcessesGone && !report.helperCleanupError &&
    report.finalExtensionInventory?.passed === true && report.extensionInventories?.every(value => value.passed === true);
  if (mode !== "idle-diagnostic") {
    const scenario = mode === "created-page-cleanup" ? resolveNativeCleanupScenario(mode, report.cleanupScenario?.change, report.cleanupScenario?.recovery) : null;
    const delivery = mode === "auxiliary-delivery" ? resolveNativeDeliveryScenario(mode, report.deliveryScenario?.phase, report.deliveryScenario?.interruption) : null;
    const expected = delivery ? delivery.names : scenario ? [scenario.name] : mode === "created-page-host-loss" ? nativeCreatedPageCases : nativeLifecycleCases;
    const verified = (!scenario || report.cleanupScenario.name === scenario.name && report.records.every(record =>
      record.detail?.change === scenario.change && record.detail?.recovery === scenario.recovery && record.detail?.recoveryVerified === true)) &&
      (!delivery || delivery.variants.every((variant, index) => {
        const record = report.records.find(value => value.name === delivery.names[index]);
        return record?.detail?.phase === delivery.phase && record.detail.interruption === delivery.interruption &&
          record.detail.variant === variant && record.detail.recoveryVerified === true;
      }));
    const passed = !!complete && verified && allNativeLifecycleCasesPassed(report.records, expected) && report.focus.finalValidation === "passed";
    return { passed, exitCode: passed ? 0 : 1 };
  }
  const diagnostic = report.diagnostic;
  const diagnosticComplete = !!complete && report.records.length === 0 && report.focus.observationComplete === true &&
    diagnostic?.observationComplete === true && diagnostic.originalHostUnchanged === true &&
    diagnostic.durationMs === nativeIdleDurationMs && diagnostic.observedThrough - diagnostic.startedAt >= nativeIdleDurationMs;
  return { passed: false, diagnosticComplete, exitCode: diagnosticComplete ? 0 : 1 };
}

// The manager API includes disabled and terminated entries. Upstream normally
// hides browser components; tolerate one only when the API explicitly labels
// its location COMPONENT, never by its name, ID or a previous contaminated run.
export function assertFixtureExtensionInventory(entries, expectedIds) {
  assert.ok(Array.isArray(entries), "Extension manager inventory is unavailable");
  const ids = entries.map(value => value.id);
  assert.equal(new Set(ids).size, ids.length, "Extension inventory contains duplicate identities");
  const fixture = entries.filter(value => expectedIds.includes(value.id));
  const components = entries.filter(value => !expectedIds.includes(value.id) && value.location === "COMPONENT");
  const unexpected = entries.filter(value => !expectedIds.includes(value.id) && value.location !== "COMPONENT");
  if (unexpected.length || fixture.length !== expectedIds.length) {
    const error = new Error(`OBU_TEST_PROFILE_NOT_ISOLATED: expected fixture IDs ${JSON.stringify([...expectedIds].sort())}, observed non-component IDs ${JSON.stringify(entries.filter(value => value.location !== "COMPONENT").map(value => value.id).sort())}`);
    error.code = "OBU_TEST_PROFILE_NOT_ISOLATED"; throw error;
  }
  return { fixture, components };
}

// The PID alone is insufficient: prove the private executable and its live
// ancestry before allowing this fixture to terminate a browser-launched host.
export function assertNativeProcessIdentity(endpoint, processes, { executable, browserPid }) {
  assert.ok(Number.isSafeInteger(endpoint?.pid) && endpoint.pid > 0);
  const list = Array.isArray(processes) ? processes : [processes];
  const process = list.find(value => value?.ProcessId === endpoint.pid);
  assert.ok(process, "Native endpoint process is not live");
  assert.equal(path.win32.resolve(process.ExecutablePath).toLowerCase(), path.win32.resolve(executable).toLowerCase(), "Native endpoint belongs to another executable");
  assert.ok(typeof process.CreationDate === "string" && process.CreationDate.length > 0, "Native process creation time unavailable");
  const ancestry = [], visited = new Set();
  let current = process;
  while (current.ProcessId !== browserPid) {
    assert.ok(!visited.has(current.ProcessId), "Native process ancestry contains a cycle");
    visited.add(current.ProcessId); ancestry.push(current);
    current = list.find(value => value?.ProcessId === current.ParentProcessId);
    assert.ok(current, "Native host is not a descendant of this fixture's browser process");
  }
  ancestry.push(current);
  return { process, ancestry };
}

// Only the unique leaf is touched. A saved ownership marker and exact value
// inventory fence cleanup against another actor replacing/modifying the key.
export const nativeRegistrationSource = `param([string]$Operation)
$ErrorActionPreference = 'Stop'
$taskData = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'registration.json') -Raw | ConvertFrom-Json
if ($taskData.Name -notmatch '^com\\.openbrowseruse\\.lifecycle\\.n[0-9a-f]{24}$') { throw 'Unexpected test host name' }
if ($taskData.Browser -eq 'edge') { $taskParent = 'HKCU:\\Software\\Microsoft\\Edge\\NativeMessagingHosts' }
elseif ($taskData.Browser -eq 'chrome') { $taskParent = 'HKCU:\\Software\\Google\\Chrome\\NativeMessagingHosts' }
else { throw 'Unexpected browser selector' }
$taskKey = Join-Path $taskParent $taskData.Name
$taskBefore = Join-Path $PSScriptRoot 'registry-before.json'
if ($Operation -eq 'create') {
  $priorExists = Test-Path -LiteralPath $taskKey
  @{exists=$priorExists; key=$taskKey; manifest=$taskData.Manifest; owner=$taskData.Owner} | ConvertTo-Json | Set-Content -LiteralPath $taskBefore
  if ($priorExists) { throw 'Refusing to reuse an existing registration' }
  $created = New-Item -Path $taskKey -ErrorAction Stop
  New-ItemProperty -LiteralPath $taskKey -Name 'ObuFixtureOwner' -Value $taskData.Owner -PropertyType String | Out-Null
  Set-Item -LiteralPath $taskKey -Value $taskData.Manifest
  if ((Get-Item -LiteralPath $taskKey).GetValue('') -ne $taskData.Manifest) { throw 'Native registration verification failed' }
  @{created=$true; key=$taskKey; manifest=$taskData.Manifest; owner=$taskData.Owner} | ConvertTo-Json -Compress
} elseif ($Operation -eq 'cleanup') {
  if (!(Test-Path -LiteralPath $taskBefore)) { @{untouched=$true; reason='create not attempted'} | ConvertTo-Json -Compress; exit }
  $prior = Get-Content -LiteralPath $taskBefore -Raw | ConvertFrom-Json
  if ($prior.key -ne $taskKey -or $prior.manifest -ne $taskData.Manifest -or $prior.owner -ne $taskData.Owner) { throw 'Registration identity changed' }
  if ($prior.exists) { @{untouched=$true; reason='registration preexisted'} | ConvertTo-Json -Compress; exit }
  if (Test-Path -LiteralPath $taskKey) {
    $actual = Get-Item -LiteralPath $taskKey
    if ($actual.GetValue('ObuFixtureOwner') -ne $taskData.Owner) { throw 'Registration ownership changed; refusing cleanup' }
    if ($actual.GetValue('') -ne $taskData.Manifest) { throw 'Registration path changed; refusing cleanup' }
    if ($actual.SubKeyCount -ne 0 -or @($actual.GetValueNames() | Where-Object { $_ -notin @('', 'ObuFixtureOwner') }).Count -ne 0) { throw 'Registration gained unrelated data; refusing cleanup' }
    Remove-Item -LiteralPath $taskKey
  }
  if (Test-Path -LiteralPath $taskKey) { throw 'Registration cleanup failed' }
  @{removed=$true; existsAfter=$false; key=$taskKey} | ConvertTo-Json -Compress
} else { throw 'Unknown registration operation' }
`;

// Re-read process creation identity inside the termination process, then use a
// retained System.Diagnostics.Process handle to avoid a PID-reuse kill race.
export const nativeTerminateSource = `param([string]$EvidenceFile)
$ErrorActionPreference = 'Stop'
$expected = Get-Content -LiteralPath $EvidenceFile -Raw | ConvertFrom-Json
$handle = [System.Diagnostics.Process]::GetProcessById([int]$expected.ProcessId)
try {
  $null = $handle.Handle
  $actual = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + [int]$expected.ProcessId)
  if (!$actual -or $actual.ExecutablePath -ne $expected.ExecutablePath -or $actual.CreationDate.ToUniversalTime().ToString('o') -ne $expected.CreationDate) { throw 'Native process identity changed before termination' }
  $at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $handle.Kill()
  if (!$handle.WaitForExit(10000)) { throw 'Exact native process did not terminate' }
  @{pid=$expected.ProcessId; requestedAt=$at; exitedAt=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); exitCode=$handle.ExitCode; exactHandle=$true} | ConvertTo-Json -Compress
} finally { $handle.Dispose() }
`;

// Hold the existing process handle before runtime.reload, so normal native EOF
// exit status is observed even when a replacement starts before CIM polling.
export const nativeWatchSource = `param([string]$EvidenceFile, [string]$ReadyFile)
$ErrorActionPreference = 'Stop'
$expected = Get-Content -LiteralPath $EvidenceFile -Raw | ConvertFrom-Json
$handle = [System.Diagnostics.Process]::GetProcessById([int]$expected.ProcessId)
try {
  $null = $handle.Handle
  $actual = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + [int]$expected.ProcessId)
  if (!$actual -or $actual.ExecutablePath -ne $expected.ExecutablePath -or $actual.CreationDate.ToUniversalTime().ToString('o') -ne $expected.CreationDate) { throw 'Native process changed before EOF observation' }
  @{pid=$expected.ProcessId; readyAt=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); exactHandle=$true} | ConvertTo-Json -Compress | Set-Content -LiteralPath $ReadyFile
  if (!$handle.WaitForExit(45000)) { throw 'Native EOF process exit not observed' }
  @{pid=$expected.ProcessId; exitedAt=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); exitCode=$handle.ExitCode; exactHandle=$true} | ConvertTo-Json -Compress
} finally { $handle.Dispose() }
`;
