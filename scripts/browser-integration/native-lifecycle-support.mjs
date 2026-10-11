import assert from "node:assert/strict";
import path from "node:path";

export const nativeLifecycleCases = Object.freeze(["native-host-exit", "native-extension-reload", "native-paused-reload"]);
export const nativeIdleDurationMs = 10000;
export function resolveNativeLifecycleMode(value = "acceptance") {
  assert.ok(["acceptance", "idle-diagnostic"].includes(value), `Unknown OBU_TEST_NATIVE_MODE: ${value}`);
  return value;
}
export function allNativeLifecycleCasesPassed(records) {
  return records.length === nativeLifecycleCases.length && nativeLifecycleCases.every(name => records.filter(value => value.name === name && value.passed === true).length === 1);
}

// A diagnostic may collect an unwanted focus event successfully. Keep that
// observation separate from acceptance and require the same teardown evidence.
export function nativeLifecycleOutcome(report) {
  const mode = resolveNativeLifecycleMode(report.mode);
  const complete = !report.error && report.registrationCleanup?.removed === true && !!report.nativeCleanup &&
    !report.nativeCleanupError && !report.browserCleanupError && !report.browserProcessInventoryError &&
    !report.browserProcessCleanupError && !!report.browserProcessesGone && !report.helperCleanupError &&
    report.finalExtensionInventory?.passed === true && report.extensionInventories?.every(value => value.passed === true);
  const passed = mode === "acceptance" && !!complete && allNativeLifecycleCasesPassed(report.records) && report.focus.finalValidation === "passed";
  if (mode === "acceptance") return { passed, exitCode: passed ? 0 : 1 };
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
