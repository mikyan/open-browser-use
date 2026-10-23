// Actual formal managed Browser replacement. Root alone explicitly runs this
// opt-in script. No Native Port adapter, page reload or business replay.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium as playwrightChromium } from "playwright";
import { createManagedBrowserRestartFixture, managedBrowserRestartURLs } from "./managed-browser-restart-fixture.mjs";
import { managedBrowserRestartMode, readManagedRestartPreferences, managedRestartTaskGeneration, readManagedRestartRunInventory, classifyManagedRestartStartup, assertManagedRestartLaunch, assertManagedRestartManifest, selectManagedRestartWorker, assertManagedRestartWorkerRuntime, assertManagedRestartIdentity, assertManagedRestartOriginalPosts, assertManagedRestartFollowup, assertManagedRestartPostLedger, assertManagedRestartNativeTarget, managedRestartDocumentReady, assertManagedRestartFinalResults, assertManagedRestartDefaultEmpty, assertManagedRestartCrashTerminal, assertManagedRestartRestoredDraft, assertManagedRestartAuthenticationSeed, assertManagedRestartAuthenticatedPostLedger, assertManagedRestartAuthentication, readManagedRestartDocument } from "./managed-browser-restart-support.mjs";
import { observeManagedWorkflowViewer } from "./managed-workflow-viewer.mjs";
import { installManagedResearchObservation, managedResearchObservationDelta } from "./managed-research-support.mjs";
import { createRecordedAgentSDK } from "./recorded-agent-sdk.mjs";
import { projectNativeRecoveryLifecycle, probeRejectedViewerToken } from "./managed-native-recovery-support.mjs";
import { parseManagedReadyOutput, assertManagedStopReply } from "./managed-download-check.mjs";
import { assertManagedViewerBrowserCommand, assertManagedViewerTerminal } from "./managed-viewer-check.mjs";
import { connectNormalCDP, managedProcess, runProcess, bound, poll } from "./normal-browser-downloads-support.mjs";
import { listenFixture } from "./fixture-listener.mjs";
import { waitPrivateDevToolsEndpoint } from "./private-devtools-endpoint.mjs";
import { observedProcessDescendants as descendants } from "./observed-process-descendants.mjs";
import { startWindowsObservation, foregroundPIDMatches } from "./windows-observation.mjs";
import { browserStartupOptions } from "./browser-startup.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const redact = value => String(value).replace(/(#ticket=)[A-Za-z0-9_-]+/g, "$1[redacted]");
const serialize = value => JSON.stringify(value, (_key, item) => typeof item === "string" ? redact(item) : item, 2);
const processQuery = "@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,ExecutablePath,@{n='CreationDate';e={$_.CreationDate.ToUniversalTime().ToString('o')}}) | ConvertTo-Json -Compress";
function inside(root, file) { const value = path.relative(root, file); assert.ok(value && !path.isAbsolute(value) && value !== ".." && !value.startsWith(`..${path.sep}`)); return value.replaceAll("\\", "/"); }
async function treeHashes(root) {
  const entries = await fs.readdir(root, { recursive: true, withFileTypes: true }); assert.ok(entries.every(entry => !entry.isSymbolicLink()));
  return Object.fromEntries(await Promise.all(entries.filter(entry => entry.isFile()).map(async entry => { const file = path.join(entry.parentPath, entry.name); return [inside(root, file), hash(await fs.readFile(file))]; })));
}

export async function runManagedBrowserRestartCheck({ mode = "normal" } = {}) {
  assert.equal(process.platform, "win32"); assert.ok(["normal", "crash", "crash-established", "crash-authenticated", "default"].includes(mode));
  const authenticatedProfile = mode === "crash-authenticated", establishedProfile = mode === "crash-established" || authenticatedProfile, crashOriginal = mode === "crash" || establishedProfile;
  const executable = process.env.OBU_TEST_HOST_BINARY, chromium = process.env.OBU_TEST_CHROMIUM_BINARY, extension = process.env.OBU_TEST_EXTENSION_DIR;
  const observerBinary = process.env.OBU_TEST_OBSERVER_BINARY, observerBuild = process.env.OBU_TEST_OBSERVER_BUILD_REPORT, hostValidation = process.env.OBU_TEST_HOST_VALIDATION;
  for (const file of [executable, chromium, extension, observerBinary, observerBuild, hostValidation]) { assert.ok(typeof file === "string" && path.isAbsolute(file), "Explicit build/browser/observer inputs and fresh host validation are required"); await fs.access(file); }
  await fs.mkdir(path.join(repo, ".tmp/browser-integration"), { recursive: true });
  const runDir = await fs.mkdtemp(path.join(repo, `.tmp/browser-integration/mbr-${mode[0]}-`)), root = path.join(runDir, "r"), name = "n", viewerProfile = path.join(runDir, "v");
  const scenarioId = `restart-${mode}-${randomUUID().slice(0, 8)}`, draft = `persistent-${randomUUID()}`, memoryDraft = `memory-${randomUUID()}`, followupNote = `followup-${randomUUID()}`;
  const report = { runDir, mode, scenarioId, startedAt: Date.now(), steps: [], commands: [], probes: [], generations: [], denials: [], processObservations: [], cleanup: {}, cleanupErrors: [], unexpectedRequests: [],
    scope: "Two task generations in one dedicated profile. crash-established additionally establishes that profile through generation 0 blank managed run/Stop, then requires a read-only observed native Crashed preference checkpoint before the original Browser.crash. It does not cover fresh profiles before preference persistence. crash-authenticated independently establishes one synthetic persistent HttpOnly login through generation 0 native form/normal Stop and verifies that same login at the server in A and restored B; the newly written draft cookie is only an observation in this separate mode. Original SDK GET work, three one-shot POST reports, finalize and real viewer; exact Browser exit, explicit native restore, new run/SDK/turn and explicit claim for one independent follow-up POST. default mode observes the original no-restore gap without claiming recovery.",
    limits: "Windows fixed Chromium synthetic site only. Native restored page is a new document, never the original Document or task grant. Cache and no-store POST outcomes are recorded without a navigation or resubmission repair. No offline snapshot recovery, real account, pending input, unknown transaction recovery, cross-platform or Codex parity claim. Native tab/focus observer starts after each managed startup and ends before its shutdown; OS observation spans both runs. CIM is supplemental and non-atomic; original manager lifecycle/Job/process receipts remain authoritative." };
  const save = () => fs.writeFile(path.join(runDir, "results.json"), serialize(report));
  const registry = new Set(), generations = []; let originalAuthentication, viewerProcess, viewerBrowser, viewerContext, osObserver, osHandle, osWriteError, osWrites = Promise.resolve(), fixtureWriteError, fixtureWrites = Promise.resolve();
  const fixture = createManagedBrowserRestartFixture({ authenticated: authenticatedProfile, changed() { const bytes = JSON.stringify(fixture.allStats(), null, 2); fixtureWrites = fixtureWrites.then(() => fs.writeFile(path.join(runDir, "server-evidence.json"), bytes)).catch(error => { fixtureWriteError ??= error; }); } });
  const server = createServer((request, response) => { if (!fixture.handle(request, response, server.address().port)) { report.unexpectedRequests.push({ method: request.method, url: request.url, at: Date.now() }); request.resume(); response.writeHead(404); response.end("NOT_FOUND"); } });
  const launch = (program, args, options = {}) => { const record = {}; report.commands.push(record); return managedProcess(program, args, { cwd: repo, registry, record, maximumBytes: 4 * 1024 * 1024, ...options }); };
  async function command(args, expected = 0) { const result = await launch(executable, args, { timeoutMs: args[1] === "stop" ? 55000 : 45000 }).completed; assert.equal(result.code, expected, redact(result.stderr)); return result; }
  function check() { for (const generation of generations) generation.viewer?.check(); if (osWriteError) throw osWriteError; if (fixtureWriteError) throw fixtureWriteError; }
  const wait = (read, label, timeoutMs = 20000) => poll(async () => { check(); return read(); }, { label, timeoutMs, intervalMs: 60 });
  async function step(label, operation) { const entry = { name: label, startedAt: Date.now() }; report.steps.push(entry); console.log("STEP", label); try { await operation(); check(); entry.passed = true; } catch (error) { entry.error = error.stack; entry.passed = false; report.firstFailure ??= { step: label, at: Date.now(), error: error.stack }; throw error; } finally { entry.endedAt = Date.now(); await save(); } }
  async function cleanup(label, operation) { try { report.cleanup[label] = await operation(); } catch (error) { report.cleanupErrors.push({ label, at: Date.now(), error: error.stack ?? String(error), observation: error.observation }); } }
  async function table() { const record = {}; report.probes.push(record); await runProcess("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", processQuery], { registry, record, timeoutMs: 15000, maximumBytes: 2 * 1024 * 1024 }); const result = JSON.parse(record.stdout); record.stdout = { bytes: Buffer.byteLength(record.stdout), sha256: hash(record.stdout) }; return result; }
  async function remember(g, label) {
    const rows = await table(), groups = [];
    for (const [kind, pid] of [["managed", g?.info?.browserPID], ["viewer", viewerProcess?.record.pid]]) if (pid) {
      const original = report.processObservations.flatMap(value => value.groups).find(value => value.kind === kind && value.generation === (kind === "managed" ? g.number : 0))?.processes.find(value => value.ProcessId === pid);
      if (original) assert.ok(rows.some(value => value.ProcessId === pid && value.CreationDate === original.CreationDate && value.ExecutablePath === original.ExecutablePath), "Original process identity ended before inventory");
      groups.push({ kind, generation: kind === "managed" ? g.number : 0, rootPID: pid, processes: descendants(rows, pid) });
    }
    report.processObservations.push({ label, at: Date.now(), groups }); return groups;
  }
  async function lifecycle(g, label) {
    let directory = g.info?.runDir;
    if (!directory) {
      assert.equal(label, "final"); g.detail.runInventoryAfterStartup = await readManagedRestartRunInventory(path.join(root, name, "runs"));
      const ready = parseManagedReadyOutput(g.launcher.record.stdout);
      const outcome = classifyManagedRestartStartup({ before: g.detail.runInventoryBeforeStartup, after: g.detail.runInventoryAfterStartup, terminal: g.launcher.record, readyObserved: g.detail.readyObserved || ready?.state === "ready" });
      if (outcome.phase === "before-run-created") { g.detail.startupFailure = outcome; return outcome; }
      directory = path.join(root, name, "runs", outcome.runId);
    }
    inside(root, directory); const bytes = await fs.readFile(path.join(directory, "lifecycle.json")), parsed = projectNativeRecoveryLifecycle(bytes), file = `lifecycle-${g.number}-${label}.json`;
    await fs.writeFile(path.join(runDir, file), bytes, { flag: "wx" }); g.detail.lifecycleSnapshots.push({ label, file, sha256: parsed.sha256, bytes: parsed.bytes, exact: parsed.exact });
    if (label === "final") g.detail.finalLifecycle = parsed.value; return parsed;
  }
  async function resources(g) {
    const controlPipe = "\\\\.\\pipe\\open-browser-use-managed-" + hash(path.resolve(root).toLowerCase() + "\0" + name).slice(0, 40);
    const scope = { host: g.info.nativeHostName, pipes: [g.info.socketPath, controlPipe] }; assert.match(scope.host, /^com\.openbrowseruse\.managed\.n[0-9a-f]{32}$/);
    const source = String.raw`$ErrorActionPreference='Stop'
$scope=$env:OBU_RESTART_RESOURCES | ConvertFrom-Json
$keys=@()
foreach($view in @([Microsoft.Win32.RegistryView]::Registry32,[Microsoft.Win32.RegistryView]::Registry64)) {
 $base=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser,$view);$key=$null
 try {$key=$base.OpenSubKey(('Software\Google\Chrome\NativeMessagingHosts\'+$scope.host),$false);$keys+=@{view=$view.ToString();absent=($null -eq $key)}} finally {if($null -ne $key){$key.Close()};$base.Close()}
}
$present=@([IO.Directory]::GetFiles('\\.\pipe\') | Where-Object {$scope.pipes -contains $_})
@{registration=$keys;presentOriginalPipes=$present} | ConvertTo-Json -Compress -Depth 5`;
    const record = {}; g.detail.resourceProbe = record; await runProcess("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", source], { registry, record, env: { ...process.env, OBU_RESTART_RESOURCES: JSON.stringify(scope) }, timeoutMs: 15000 });
    const value = JSON.parse(record.stdout); assert.equal(value.registration.length, 2); assert.ok(value.registration.every(item => item.absent)); assert.deepEqual(value.presentOriginalPipes, []);
    const endpointEntries = await fs.readdir(path.join(g.info.runDir, "temp", "open-browser-use")); assert.deepEqual(endpointEntries, []); return { ...value, endpointEntries, checkedAt: Date.now() };
  }
  const endpoint = (profile, owner) => waitPrivateDevToolsEndpoint(profile, { assertAlive() { assert.ok(!owner.record.exitedAt && !owner.record.closedAt && !owner.record.spawnError, "Original owner ended before endpoint"); } });
  async function snapshot(g, label) { const value = await g.worker.evaluate("__managedResearchObservation.snapshot()"); assert.equal(value.identity, g.detail.nativeObserver.identity); assert.equal(value.overflow, false); g.detail.observations.push({ label, ...value }); return value; }
  async function observeDocument(g, tabId) { const rows = await g.worker.evaluate(`chrome.scripting.executeScript({target:{tabId:${tabId}},func:${readManagedRestartDocument.toString()}}).then(rows=>rows.map(row=>({documentId:row.documentId,frameId:row.frameId,...row.result})))`); assert.equal(rows.length, 1); assert.equal(rows[0].frameId, 0); assert.ok(rows[0].documentId); return rows[0]; }
  async function observeRawErrorPage(g, row) {
    // chrome.scripting cannot read a browser-owned network error page. Preserve
    // that denial, then inspect only the exact already-observed raw POST target
    // through a temporary read-only diagnostic connection; no navigation.
    if (row.targets.length !== 1) return;
    const detail = row.nativeErrorObservation = { targetId: row.targets[0].id, requestedAt: Date.now(), connection: {} };
    let reader;
    try {
      const endpointURL = new URL(g.detail.identity.browserRoot), response = await fetch(`http://${endpointURL.host}/json/list`, { signal: AbortSignal.timeout(10000) }); assert.equal(response.status, 200);
      const targets = (await response.json()).filter(target => target.id === detail.targetId && target.type === "page"); assert.equal(targets.length, 1);
      detail.target = { id: targets[0].id, url: targets[0].url, title: targets[0].title };
      reader = await connectNormalCDP(targets[0].webSocketDebuggerUrl, { record: detail.connection, handshakeTimeoutMs: 10000, authorizationRequired: false });
      detail.document = await reader.evaluate(`(${readManagedRestartDocument.toString()})()`, 10000);
    } catch (error) { detail.error = error.stack; }
    finally { if (reader) await reader.close(); detail.completedAt = Date.now(); }
  }
  async function endNativeObservation(g) { if (!g.worker || g.detail.nativeObserverStopped) return; const value = await g.worker.evaluate("__managedResearchObservation.stop()"); g.detail.nativeObserverStopped = value; assert.deepEqual(value.listenersPresent, [false, false, false, false]); const events = managedResearchObservationDelta(g.detail.initialObservation, value); assert.deepEqual(events.filter(item => item.type === "activated" || item.type === "focus"), []); }
  async function uiControl(g, operation) {
    const before = g.detail.viewer.commands.length; await g.page.locator("#control").click({ timeout: 10000 });
    const original = await wait(() => g.detail.viewer.commands.slice(before).find(item => item.operation === operation), `original viewer ${operation}`);
    const reply = await wait(() => g.detail.viewer.messages.find(item => item.type === "response" && item.id === original.id), `original viewer ${operation} reply`);
    assert.equal(reply.error, undefined); assert.equal(g.detail.viewer.commands.slice(before).filter(item => item.operation === operation).length, 1); return { request: original, result: reply.result };
  }
  async function startGeneration(number, restore) {
    const detail = { number, restore, readyObserved: false, observations: [], lifecycleSnapshots: [], viewer: {}, startedAt: Date.now() }, g = { number, detail }; generations.push(g); report.generations.push(detail);
    const args = ["managed", "run", "--root", root, "--name", name, "--browser-path", chromium, "--extension-dir", extension, "--startup-timeout", "30s", ...(restore ? ["--restore"] : [])];
    detail.runInventoryBeforeStartup = await readManagedRestartRunInventory(path.join(root, name, "runs"));
    g.launcher = launch(executable, args); const ready = await wait(() => { const value = parseManagedReadyOutput(g.launcher.record.stdout); if (value?.state === "ready") detail.readyObserved = true; assert.ok(!g.launcher.record.closedAt && !g.launcher.record.exitedAt, redact(g.launcher.record.stderr)); return value; }, `managed generation ${number} ready`, 40000);
    assert.equal(ready.state, "ready"); g.info = ready.info; detail.info = ready.info; inside(root, g.info.runDir); assert.equal(g.info.name, name);
    const life = await lifecycle(g, "ready"); detail.launch = assertManagedRestartLaunch(life.value, restore); assertManagedViewerBrowserCommand(life.value, chromium); assert.equal(life.value.binding.bound, true); assert.equal(life.value.binding.exclusive, true);
    const status = JSON.parse((await command(["managed", "status", "--root", root, "--name", name])).stdout); assert.deepEqual(status.info, g.info); detail.status = status;
    const groups = await remember(g, `ready-${number}`), family = groups.find(value => value.kind === "managed").processes; assert.ok(family.some(value => value.ProcessId === g.info.nativePID));
    const privateEndpoint = await endpoint(g.info.profileDir, g.launcher); detail.rootConnection = {}; g.rootObserver = await connectNormalCDP(privateEndpoint.url, { record: detail.rootConnection, handshakeTimeoutMs: 10000, authorizationRequired: false });
    const stagedManifest = JSON.parse(await fs.readFile(path.join(g.info.runDir, "extension/manifest.json"), "utf8"));
    const response = await fetch(`http://127.0.0.1:${privateEndpoint.port}/json/list`, { signal: AbortSignal.timeout(10000) }); assert.equal(response.status, 200);
    const selectedWorker = selectManagedRestartWorker(g.info, stagedManifest, await response.json());
    const entryFile = path.join(g.info.runDir, "extension", selectedWorker.entry), entryInfo = await fs.lstat(entryFile); assert.ok(entryInfo.isFile() && !entryInfo.isSymbolicLink());
    const entryBytes = await fs.readFile(entryFile); assert.ok(entryBytes.length > 0 && entryBytes.length <= 1024 * 1024);
    detail.workerEntryArtifact = { file: inside(runDir, entryFile), bytes: entryBytes.length, sha256: hash(entryBytes) };
    detail.workerConnection = {}; g.worker = await connectNormalCDP(selectedWorker.target.webSocketDebuggerUrl, { record: detail.workerConnection, handshakeTimeoutMs: 10000, authorizationRequired: false });
    const runtime = await g.worker.evaluate("(()=>{const value=chrome.runtime.getManifest();return {location:location.href,manifest:{version:value.version,version_name:value.version_name,background:value.background}}})()");
    const originalTask = number === 2 ? managedRestartTaskGeneration(generations) : undefined;
    detail.extensionManifest = assertManagedRestartManifest(stagedManifest, runtime.manifest, originalTask?.detail.extensionManifest.staged.version);
    detail.workerEntry = assertManagedRestartWorkerRuntime(selectedWorker, runtime.location, originalTask?.detail.workerEntry);
    detail.nativeObserver = await g.worker.evaluate(`(${installManagedResearchObservation.toString()})(chrome,globalThis)`); detail.initialObservation = await snapshot(g, "initial");
    const marker = await g.worker.evaluate("chrome.storage.session.get('OPEN_BROWSER_USE_BROWSER_LIFETIME').then(value=>value.OPEN_BROWSER_USE_BROWSER_LIFETIME)");
    detail.identity = { info: g.info, browser: family.find(value => value.ProcessId === g.info.browserPID), native: family.find(value => value.ProcessId === g.info.nativePID), nativeCreationTime: life.exact.nativeCreationTime, browserIncarnation: marker.incarnation, workerBootId: life.value.binding.workerBootId, browserRoot: privateEndpoint.url };
    // Probe the old unused capability before authenticating the new viewer;
    // rejection caused only by an already active viewer is not token evidence.
    if (number === 2) {
      const old = new URL(originalTask.unusedViewerURL), fresh = new URL(ready.viewerURL); assert.notEqual(old.hash, fresh.hash);
      report.oldListenerProbe = await probeRejectedViewerToken(old.origin, old.hash.slice(8));
      report.oldTokenOnNewListener = await probeRejectedViewerToken(fresh.origin, old.hash.slice(8));
    }
    const viewerDirectory = path.join(runDir, `viewer-${number}`); await fs.mkdir(viewerDirectory); g.page = await bound(viewerContext.newPage(), 10000, "new owned viewer page");
    g.viewer = await observeManagedWorkflowViewer({ page: g.page, url: ready.viewerURL, directory: viewerDirectory, detail: detail.viewer });
    g.viewerURL = ready.viewerURL; detail.initialViewerState = structuredClone(g.viewer.state); return g;
  }
  async function stopGeneration(g, crash = false) {
    if (g.stopPromise) return g.stopPromise;
    g.stopPromise = (async () => {
      await remember(g, `before-exit-${g.number}`); await endNativeObservation(g);
      if (crash) { g.detail.crash = { command: "Browser.crash", submittedAt: Date.now(), originalBrowserRoot: g.detail.identity.browserRoot, submissions: 1 }; try { g.detail.crash.reply = await bound(g.rootObserver.call("Browser.crash"), 10000, "one original Browser.crash"); } catch (error) { g.detail.crash.error = error.stack; } }
      else { const stopped = await command(["managed", "stop", "--root", root, "--name", name]); g.detail.stopReply = assertManagedStopReply(JSON.parse(stopped.stdout), g.info.runId); }
      const terminal = await bound(g.launcher.completed, 45000, "original managed supervisor terminal"); assert.equal(terminal.code, crash ? 1 : 0, redact(terminal.stderr)); assert.equal(terminal.termination, undefined); g.detail.supervisorExit = { code: terminal.code, exitedAt: terminal.exitedAt, closedAt: terminal.closedAt };
      const life = await lifecycle(g, "final"); if (crash) g.detail.crashCleanup = assertManagedRestartCrashTerminal(life.value, g.info, { browserRoot: g.detail.rootConnection.url, crash: g.detail.crash }); else assertManagedViewerTerminal(life.value, g.info);
      g.detail.resourcesGone = await resources(g); const originals = report.processObservations.flatMap(value => value.groups).filter(value => value.kind === "managed" && value.generation === g.number).flatMap(value => value.processes);
      g.detail.processesGone = await poll(async () => { const rows = await table(), remaining = originals.filter(before => rows.some(after => before.ProcessId === after.ProcessId && before.CreationDate === after.CreationDate)); return !remaining.length && { checkedAt: Date.now(), originalIdentities: originals.length, remaining }; }, { label: "original managed process identities exited", timeoutMs: 15000, intervalMs: 100 });
      g.stopped = true; await g.worker.close(); g.worker = null; await g.rootObserver.close(); g.rootObserver = null; await save(); return { stopped: true, crash, actualExit: terminal.code };
    })(); return g.stopPromise;
  }
  async function rejected(label, call) { const entry = { label, startedAt: Date.now() }; report.denials.push(entry); try { await call(); } catch (error) { entry.error = error.stack; entry.completedAt = Date.now(); assert.match(error.message, /OBU_SDK_BROWSER_DISCONNECTED/, "Original SDK must remain permanently bound to its ended connection"); entry.rejected = true; return entry; } throw Error(`${label} unexpectedly succeeded`); }
  async function publicRead(tab) { return tab.evaluate(`(${readManagedRestartDocument.toString()})()`); }
  const postLedger = (stats, followups) => authenticatedProfile ? assertManagedRestartAuthenticatedPostLedger(stats, fixture.rejectedStats(), report.unexpectedRequests, followups, originalAuthentication) : assertManagedRestartPostLedger(stats, fixture.rejectedStats(), report.unexpectedRequests, followups);
  const authentication = (g, document) => assertManagedRestartAuthentication(document, fixture.stats(scenarioId), originalAuthentication, g.detail.startedAt);
  async function connectSDK(g, label) { g.recorder = await createRecordedAgentSDK({ sdkPath: path.join(runDir, "sdk-input/index.js"), directory: path.join(runDir, `recording-${g.number}`) }); g.browser = await g.recorder.connect({ socketPath: g.info.socketPath, sessionId: `${scenarioId}-${label}`, turnId: `${label}-turn`, timeoutMs: 10000 }); g.detail.sdk = { sessionId: g.browser.client.sessionId, turnId: g.browser.client.turnId, backend: await g.browser.client.getInfo() }; return g.browser; }

  try {
    await step("freeze-current-production-harness-and-fresh-build", async () => {
      report.source = { executable: hash(await fs.readFile(executable)), browser: hash(await fs.readFile(chromium)), observerBinary: hash(await fs.readFile(observerBinary)), extension: await treeHashes(extension), sdk: await treeHashes(path.join(repo, "packages/open-browser-use-js/dist")), snapshot: {} };
      assert.equal(report.source.browser, "566971689aecea06a88355ea1e9020c908b7a3b093dd0d2a12ae7073489a77aa");
      const currentCommit = await launch("git", ["rev-parse", "HEAD"], { timeoutMs: 15000 }).completed; assert.equal(currentCommit.code, 0); report.source.checkoutCommit = currentCommit.stdout.trim();
      const buildBytes = await fs.readFile(hostValidation), build = JSON.parse(buildBytes); assert.equal(build.kind, "fresh-managed-browser-restart-build"); assert.equal(build.passed, true); assert.equal(build.sourceUnchanged, true); assert.equal(build.exeSHA256, report.source.executable); assert.deepEqual(build.extensionFiles, report.source.extension); assert.deepEqual(build.sdkFiles, report.source.sdk);
      for (const phase of ["go-test", "go-vet", "node-tests", "go-build", "extension-build"]) assert.equal(build.steps.find(row => row.name === phase)?.exitCode, 0, `Fresh ${phase} proof required`);
      for (const [file, expected] of Object.entries(build.sourceInputs)) { inside(repo, path.resolve(repo, file)); assert.equal(hash(await fs.readFile(path.join(repo, file))), expected); }
      await fs.writeFile(path.join(runDir, "host-build-validation.json"), buildBytes, { flag: "wx" }); report.hostBuild = { file: "host-build-validation.json", sha256: hash(buildBytes), inputs: Object.keys(build.sourceInputs).length, sourceCommit: build.sourceCommit, binding: "Exact frozen input and artifact bytes; later documentation-only commits need not equal the build commit." };
      const observerBytes = await fs.readFile(observerBuild), validation = JSON.parse(observerBytes); assert.equal(validation.passed, true); assert.deepEqual(validation.before, validation.after); assert.equal(validation.observer.sha256, report.source.observerBinary); assert.ok(validation.commands.length >= 3 && validation.commands.every(row => row.exitCode === 0));
      for (const [file, expected] of Object.entries(validation.before)) { inside(repo, path.resolve(repo, file)); assert.equal(hash(await fs.readFile(path.join(repo, file))), expected); }
      await fs.writeFile(path.join(runDir, "observer-build.json"), observerBytes, { flag: "wx" }); report.observerBuild = { file: "observer-build.json", sha256: hash(observerBytes) };
      const listed = await launch("git", ["ls-files", "--cached", "--others", "--exclude-standard", "--", "cmd", "internal", "apps/chrome-extension", "packages/open-browser-use-js", "scripts/browser-integration", "scripts/build-chrome-extension.mjs", ":(glob)scripts/patch-*.mjs", "go.mod", "go.sum", "pnpm-lock.yaml"], { timeoutMs: 15000 }).completed; assert.equal(listed.code, 0);
      for (const file of [...new Set(listed.stdout.trim().split(/\r?\n/))]) { inside(repo, path.resolve(repo, file)); const bytes = await fs.readFile(path.join(repo, file)); report.source.snapshot[file] = hash(bytes); const destination = path.join(runDir, "source-snapshot", file); await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.writeFile(destination, bytes, { flag: "wx" }); }
      await fs.cp(extension, path.join(runDir, "extension-input"), { recursive: true }); await fs.cp(path.join(repo, "packages/open-browser-use-js/dist"), path.join(runDir, "sdk-input"), { recursive: true });
      await listenFixture(server); report.urls = managedBrowserRestartURLs(server.address().port, scenarioId, { authenticated: authenticatedProfile }); report.expected = { draft, memoryDraft, followupNote };
    });
    let first, second, originalStats;
    await step(authenticatedProfile ? "formal-authenticated-profile-establishment-stop-and-first-task-run" : establishedProfile ? "formal-blank-profile-establishment-stop-and-first-task-run" : "formal-first-managed-run-and-continuous-os-observation", async () => {
      osHandle = await fs.open(path.join(runDir, "windows-observation.jsonl"), "wx"); osObserver = await startWindowsObservation({ executable: observerBinary, sampleMs: 50, onRecord(record) { osWrites = osWrites.then(() => osHandle.write(JSON.stringify(record) + "\n")).catch(error => { osWriteError ??= error; }); } }); report.osReady = osObserver.ready;
      const startup = browserStartupOptions([`--user-data-dir=${viewerProfile}`, "--headless=new", "--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "about:blank"], process.env.OBU_TEST_FIELD_TRIAL_CONFIG); report.viewerStartup = startup; viewerProcess = launch(chromium, startup.args);
      viewerBrowser = await bound(playwrightChromium.connectOverCDP((await endpoint(viewerProfile, viewerProcess)).url), 15000, "owned viewer browser connect"); viewerContext = await bound(viewerBrowser.newContext({ viewport: { width: 1280, height: 1000 } }), 10000, "owned viewer context");
      let established;
      if (establishedProfile) {
        const seed = await startGeneration(0, false);
        assert.equal(seed.detail.initialObservation.tabs.length, 1); assert.equal(seed.detail.initialObservation.tabs[0].url, "about:blank");
        seed.detail.blankTarget = assertManagedRestartNativeTarget(seed.detail.initialObservation, seed.detail.initialObservation.tabs[0].id);
        assert.equal(seed.detail.blankTarget.url, "about:blank"); assert.equal(seed.detail.initialViewerState.tabs.length, 1); assert.equal(seed.detail.initialViewerState.tabs[0].kind, "browser"); assert.equal(seed.detail.initialViewerState.tabs[0].url, "about:blank");
        if (authenticatedProfile) {
          await connectSDK(seed, "establish-login");
          const login = await seed.browser.newTab({ url: report.urls.auth.login });
          const token = await login.playwright.locator("#synthetic-login-token").textContent({ timeoutMs: 10000 }); assert.ok(typeof token === "string" && token.length > 0 && token.length <= 1000);
          seed.detail.login = { tabId: login.id, tokenSHA256: hash(token), submittedAt: Date.now() };
          await login.getByLabel("合成登录口令", { exact: true }).fill(token); await login.getByRole("button", { name: "建立合成登录", exact: true }).click();
          seed.detail.login.document = await publicRead(login); assert.equal(seed.detail.login.document.url, report.urls.auth.check);
          seed.detail.login.authentication = authentication(seed, seed.detail.login.document);
          seed.detail.login.serverState = fixture.stats(scenarioId).auth; originalAuthentication = structuredClone(seed.detail.login.serverState);
          seed.detail.login.postLedger = assertManagedRestartAuthenticationSeed(fixture.stats(scenarioId), fixture.rejectedStats(), report.unexpectedRequests);
          seed.detail.login.finalize = await seed.browser.client.finalizeTabs([]);
          assert.equal(seed.detail.login.finalize.endedTurnId, seed.detail.sdk.turnId);
          seed.detail.afterLoginFinalize = await snapshot(seed, "login-finalized-before-profile-stop");
          assert.deepEqual(seed.detail.afterLoginFinalize.tabs.map(tab => ({ id: tab.id, url: tab.url })), [{ id: seed.detail.initialObservation.tabs[0].id, url: "about:blank" }]);
          assert.equal(assertManagedRestartNativeTarget(seed.detail.afterLoginFinalize, seed.detail.initialObservation.tabs[0].id).id, seed.detail.blankTarget.id);
          seed.detail.afterLoginViewer = await seed.viewer.refresh(); assert.equal(seed.detail.afterLoginViewer.tabs.length, 1); assert.equal(seed.detail.afterLoginViewer.tabs[0].kind, "browser"); assert.equal(seed.detail.afterLoginViewer.tabs[0].url, "about:blank");
        }
        await seed.page.close(); await seed.viewer.settle(); seed.detail.viewerPageClosedBeforeStop = seed.page.isClosed(); assert.equal(seed.detail.viewerPageClosedBeforeStop, true);
        await stopGeneration(seed);
        seed.detail.establishedPreferences = await readManagedRestartPreferences(path.join(seed.info.profileDir, "Default/Preferences"));
        assert.equal(seed.detail.establishedPreferences.exists, true); assert.equal(seed.detail.establishedPreferences.exitType, "Normal");
        if (authenticatedProfile) { seed.detail.authenticatedSeed = assertManagedRestartAuthenticationSeed(fixture.stats(scenarioId), fixture.rejectedStats(), report.unexpectedRequests); assert.deepEqual(fixture.stats(scenarioId).auth.receipt, originalAuthentication.receipt); }
        else { assert.deepEqual(fixture.allStats(), []); assert.deepEqual(fixture.rejectedStats().requests, []); assert.deepEqual(report.unexpectedRequests, []); }
        seed.detail.businessRequests = 0; established = seed;
      }
      first = await startGeneration(1, false);
      if (established) first.detail.establishmentReplacement = assertManagedRestartIdentity(established.detail.identity, first.detail.identity);
      await connectSDK(first, "original");
    });
    await step("original-sdk-work-three-posts-finalize-and-view", async () => {
      const work = await first.browser.newTab({ url: report.urls.work }); first.work = work; first.oldLocator = work.getByLabel("持久草稿", { exact: true });
      if (authenticatedProfile) { first.detail.authenticatedBeforeBusiness = { document: await publicRead(work) }; assert.equal(first.detail.authenticatedBeforeBusiness.document.url, report.urls.work); first.detail.authenticatedBeforeBusiness.authentication = authentication(first, first.detail.authenticatedBeforeBusiness.document); }
      await first.oldLocator.fill(draft); await work.getByRole("button", { name: "保存浏览器草稿", exact: true }).click();
      await work.getByLabel("内存草稿", { exact: true }).fill(memoryDraft); await work.getByRole("button", { name: "暂存内存草稿", exact: true }).click();
      first.detail.work = { kind: "work", tabId: work.id, publicBefore: await publicRead(work), before: await observeDocument(first, work.id) }; assert.equal(first.detail.work.publicBefore.persistent, draft); assert.equal(first.detail.work.publicBefore.cookie, draft); assert.equal(first.detail.work.publicBefore.memory, memoryDraft);
      first.detail.reports = [];
      for (const [kind, button] of [["prg", "保存跳转报告"], ["cache", "保存可缓存 POST 报告"], ["no-store", "保存不缓存 POST 报告"]]) {
        const tab = await first.browser.newTab({ url: report.urls.prepare[kind] }), note = `${scenarioId}-${kind}`;
        await tab.getByLabel("报告说明", { exact: true }).fill(note); await tab.getByRole("button", { name: button, exact: true }).click();
        const receipt = JSON.parse(await tab.playwright.locator("#receipt-json").textContent({ timeoutMs: 10000 })); assert.equal(receipt.kind, kind); assert.equal(receipt.note, note);
        first.detail.reports.push({ kind, tabId: tab.id, receipt, before: await observeDocument(first, tab.id) });
      }
      originalStats = fixture.stats(scenarioId); first.detail.originalStats = originalStats;
      first.detail.postLedger = postLedger(originalStats, 0);
      for (const item of first.detail.reports) assert.deepEqual(item.receipt, originalStats.receipts[item.kind], "Original live DOM receipt must equal its original server receipt");
      first.detail.finalize = await first.browser.client.finalizeTabs([work.id, ...first.detail.reports.map(value => value.tabId)].map(tabId => ({ tabId, status: "deliverable" })));
      first.detail.afterFinalize = await snapshot(first, "after-finalize");
      for (const item of [first.detail.work, ...first.detail.reports]) {
        item.nativeTarget = assertManagedRestartNativeTarget(first.detail.afterFinalize, item.tabId); assert.equal(item.nativeTarget.url, item.before.url);
        const tab = first.detail.afterFinalize.tabs.find(value => value.id === item.tabId); assert.equal(tab.active, false, "A delivered result must remain inactive");
        item.delivery = await first.viewer.select(item.tabId, "result"); await first.viewer.capture({ tabId: item.tabId, kind: "result", label: `before-${item.kind}` }); await first.viewer.deselect();
      }
      first.detail.pause = await uiControl(first, "pause"); assert.equal(first.detail.pause.result.status.state, "paused");
      await first.page.close(); await first.viewer.settle(); const ticket = JSON.parse((await command(["managed", "view", "--root", root, "--name", name])).stdout); assert.equal(ticket.runId, first.info.runId); assert.equal(ticket.state, "viewer");
      first.unusedViewerURL = ticket.viewerURL; first.detail.unusedViewer = { origin: new URL(ticket.viewerURL).origin, tokenSHA256: hash(new URL(ticket.viewerURL).hash.slice(8)), unused: true };
      first.detail.beforeExit = await snapshot(first, "before-exit"); assertManagedRestartOriginalPosts(fixture.stats(scenarioId), originalStats);
    });
    await step(crashOriginal ? "one-original-browser-crash-and-real-terminal-cleanup" : "formal-original-stop-and-real-terminal-cleanup", async () => {
      const preferencesFile = path.join(first.info.profileDir, "Default/Preferences");
      if (establishedProfile) {
        const checkpoint = first.detail.nativeCrashCheckpoint = { startedAt: Date.now(), timeoutMs: 20000, reads: 0, observations: [], condition: "Native Preferences JSON profile.exit_type is Crashed; no write or flush request" };
        try {
          checkpoint.persisted = await wait(async () => {
            const observed = await readManagedRestartPreferences(preferencesFile); checkpoint.reads++;
            const previous = checkpoint.observations.at(-1); if (!previous || previous.exists !== observed.exists || previous.sha256 !== observed.sha256) checkpoint.observations.push(observed);
            return observed.exists && observed.exitType === "Crashed" && observed;
          }, "native Crashed preference persistence before original Browser.crash", checkpoint.timeoutMs);
        } finally { checkpoint.completedAt = Date.now(); }
      }
      await stopGeneration(first, crashOriginal);
      first.detail.preferencesAfterActualExit = await readManagedRestartPreferences(preferencesFile);
      if (establishedProfile) { assert.equal(first.detail.preferencesAfterActualExit.exists, true); assert.equal(first.detail.preferencesAfterActualExit.exitType, "Crashed"); }
    });
    await step("formal-new-run-new-identities-and-retired-capabilities", async () => {
      second = await startGeneration(2, mode !== "default"); report.replacement = assertManagedRestartIdentity(first.detail.identity, second.detail.identity);
      await rejected("old SDK getInfo after original Browser EOF", () => first.browser.client.getInfo()); await rejected("old locator after Browser replacement", () => first.oldLocator.inputValue({ timeoutMs: 1500 }));
      second.detail.beforeNewWork = await snapshot(second, "restored-before-new-work"); second.detail.restoredDocuments = [];
      assert.deepEqual(second.detail.initialViewerState.tabs.filter(row => row.kind === "result"), [], "Replacement run inherited original deliveries");
      for (const item of [first.detail.work, ...first.detail.reports]) {
        const observed = second.detail.beforeNewWork, urlTargets = observed.targets.filter(target => target.url === item.before.url);
        // URLs discover candidates only. Native tabId binds the actual target
        // and the extension DOM read; a raw error page may have another URL.
        const candidateIds = new Set([...observed.tabs.filter(tab => tab.url === item.before.url || tab.pendingUrl === item.before.url).map(tab => tab.id), ...urlTargets.map(target => target.tabId)]);
        const candidates = observed.tabs.filter(tab => candidateIds.has(tab.id)), row = { kind: item.kind, expectedURL: item.before.url, candidates, urlTargets, targets: [] }; second.detail.restoredDocuments.push(row);
        if (candidates.length === 1) {
          row.tabId = candidates[0].id; row.targets = observed.targets.filter(target => target.tabId === row.tabId);
          row.nativeTarget = assertManagedRestartNativeTarget(observed, row.tabId, item.nativeTarget);
          try {
            if (["work", "prg"].includes(item.kind)) {
              const readiness = row.readiness = { startedAt: Date.now(), timeoutMs: 10000, observations: [], scope: "Read-only native snapshot polling; no activation, navigation, attachment or input retry" };
              try {
                await wait(async () => {
                  const current = await snapshot(second, `restored-${item.kind}-readiness`);
                  readiness.observations.push({ at: Date.now(), tab: current.tabs.find(tab => tab.id === row.tabId), targets: current.targets.filter(target => target.tabId === row.tabId) });
                  return managedRestartDocumentReady(current, { tabId: row.tabId, targetId: row.nativeTarget.id, url: row.expectedURL });
                }, `restored ${item.kind} native document readiness`, readiness.timeoutMs);
                readiness.ready = true;
              } finally { readiness.completedAt = Date.now(); }
            }
            row.readAttemptedAt = Date.now(); row.read = await observeDocument(second, row.tabId);
          } catch (error) { row.readError = error.stack; }
          finally { row.readCompletedAt = Date.now(); }
          if (row.read) { assert.notEqual(row.read.documentId, item.before.documentId); row.identity = { originalTargetId: item.nativeTarget.id, targetId: row.nativeTarget.id, tabId: row.tabId, originalDocumentId: item.before.documentId, documentId: row.read.documentId, frameId: row.read.frameId }; }
        }
        if (["cache", "no-store"].includes(item.kind) && !row.read) await observeRawErrorPage(second, row);
      }
      assertManagedRestartOriginalPosts(fixture.stats(scenarioId), originalStats); second.detail.restoredPostLedger = postLedger(fixture.stats(scenarioId), 0);
      second.detail.rawPostOutcome = second.detail.restoredDocuments.filter(row => ["cache", "no-store"].includes(row.kind));
    });
    await step(mode === "default" ? "default-no-restore-observation-only" : "explicit-resume-fresh-sdk-claim-and-independent-followup", async () => {
      if (mode === "default") { assert.ok(second.detail.restoredDocuments.every(row => row.candidates.length === 0), "Default run unexpectedly restored a task page"); report.defaultGap = { observed: true, restoredTaskPages: 0, recoveryClaimed: false, initial: assertManagedRestartDefaultEmpty(second.detail.beforeNewWork, second.detail.restoredDocuments.map(row => row.expectedURL)) }; return; }
      const work = second.detail.restoredDocuments.find(row => row.kind === "work"), prg = second.detail.restoredDocuments.find(row => row.kind === "prg"); assert.equal(work.candidates.length, 1); assert.equal(prg.candidates.length, 1);
      assert.ok(work.read && prg.read, "Restored GET pages must have actual readable documents"); assert.notEqual(work.read.documentId, first.detail.work.before.documentId); assert.notEqual(prg.read.documentId, first.detail.reports.find(row => row.kind === "prg").before.documentId); assert.notEqual(work.read.documentInstance, first.detail.work.before.documentInstance); second.detail.restoredDraft = assertManagedRestartRestoredDraft(work.read, draft, mode); assert.deepEqual(JSON.parse(prg.read.receiptText), first.detail.reports.find(row => row.kind === "prg").receipt);
      if (authenticatedProfile) second.detail.authenticatedRestored = { work: authentication(second, work.read), prg: authentication(second, prg.read) };
      const current = await second.viewer.refresh(); assert.equal(current.status.state, "paused", "Original explicit Pause must survive native restart");
      second.detail.resume = await uiControl(second, "resume"); assert.equal(second.detail.resume.result.status.state, "running");
      await connectSDK(second, "after-restart"); second.detail.explicitTurn = await second.browser.client.beginTurn("explicit-after-browser-restart"); second.detail.ownedBeforeClaim = await second.browser.getTabs(); assert.deepEqual(second.detail.ownedBeforeClaim, []);
      second.detail.userTabsBeforeClaim = await second.browser.client.getUserTabs(); second.detail.claims = [];
      assert.ok(Array.isArray(second.detail.userTabsBeforeClaim)); for (const row of [work, prg]) assert.ok(second.detail.userTabsBeforeClaim.some(tab => tab.id === row.tabId && tab.url === row.expectedURL), "Explicit claim must select a current publicly listed page");
      for (const row of [work, prg]) { second.detail.claims.push({ kind: row.kind, tabId: row.tabId, result: await second.browser.client.claimUserTab(row.tabId) }); }
      const freshWork = second.browser.tab(work.tabId), freshReport = second.browser.tab(prg.tabId); second.detail.publicWork = await publicRead(freshWork); second.detail.publicReceipt = JSON.parse(await freshReport.playwright.locator("#receipt-json").textContent({ timeoutMs: 10000 }));
      assert.equal(second.detail.publicWork.persistent, draft); assert.deepEqual(second.detail.publicReceipt, first.detail.reports.find(row => row.kind === "prg").receipt);
      if (authenticatedProfile) { second.detail.publicReportDocument = await publicRead(freshReport); second.detail.authenticatedPublic = { work: authentication(second, second.detail.publicWork), prg: authentication(second, second.detail.publicReportDocument) }; assert.deepEqual(second.detail.authenticatedPublic.work.proof, second.detail.authenticatedRestored.work.proof); assert.deepEqual(second.detail.authenticatedPublic.prg.proof, second.detail.authenticatedRestored.prg.proof); }
      await rejected("old SDK still disconnected after fresh claim", () => first.work.domSnapshot({ timeoutMs: 1500 }));
      await freshWork.getByLabel("原报告回执", { exact: true }).fill(second.detail.publicReceipt.receiptId); await freshWork.getByLabel("后续说明", { exact: true }).fill(followupNote); await freshWork.getByRole("button", { name: "提交后续操作", exact: true }).click();
      second.detail.followupReceipt = JSON.parse(await freshWork.playwright.locator("#receipt-json").textContent({ timeoutMs: 10000 })); assert.deepEqual(second.detail.followupReceipt, assertManagedRestartFollowup(fixture.stats(scenarioId), second.detail.publicReceipt, followupNote)); assertManagedRestartOriginalPosts(fixture.stats(scenarioId), originalStats);
      if (authenticatedProfile) { second.detail.followupDocument = await publicRead(freshWork); assert.equal(second.detail.followupDocument.url, report.urls.followupReport); second.detail.authenticatedFollowup = authentication(second, second.detail.followupDocument); assert.deepEqual(JSON.parse(second.detail.followupDocument.receiptText), second.detail.followupReceipt); second.detail.followupPostLedger = postLedger(fixture.stats(scenarioId), 1); }
      second.detail.finalize = await second.browser.client.finalizeTabs([work.tabId, prg.tabId].map(tabId => ({ tabId, status: "deliverable" })));
      second.detail.deliveries = [];
      for (const [tabId, label] of [[work.tabId, "after-followup"], [prg.tabId, "after-original-report"]]) { second.detail.deliveries.push(await second.viewer.select(tabId, "result")); await second.viewer.capture({ tabId, kind: "result", label }); await second.viewer.deselect(); }
      second.detail.finalObservation = await snapshot(second, "after-new-task"); second.detail.finalViewerState = await second.viewer.refresh();
      second.detail.finalResults = assertManagedRestartFinalResults(second.detail.finalObservation, second.detail.finalViewerState, second.detail.deliveries, [first.detail.work, ...first.detail.reports].map(row => row.delivery));
    });
    await step("formal-second-stop-and-final-resources", async () => {
      await stopGeneration(second); assertManagedRestartOriginalPosts(fixture.stats(scenarioId), originalStats);
      report.finalPostLedger = postLedger(fixture.stats(scenarioId), mode === "default" ? 0 : 1); assert.equal(fixture.allStats().length, 1);
      if (mode === "default") report.defaultGap.final = assertManagedRestartDefaultEmpty(second.detail.nativeObserverStopped, second.detail.restoredDocuments.map(row => row.expectedURL));
    });
  } catch (error) { report.error = error.stack ?? String(error); console.error(redact(report.error)); }
  finally {
    for (const g of generations) {
      if (g.recorder) await cleanup(`sdk-${g.number}`, async () => { g.browser?.close(); const closed = await g.recorder.closeLog(); return { closed: true, ...closed }; });
      if (g.launcher && !g.stopped && !g.launcher.record.closedAt) await cleanup(`stop-${g.number}`, async () => { if (g.stopPromise) { const result = await command(["managed", "stop", "--root", root, "--name", name]); return { code: result.code }; } return stopGeneration(g); });
      if (g.launcher && !g.launcher.record.closedAt) await cleanup(`supervisor-fallback-${g.number}`, async () => { g.launcher.terminate("managed-browser-restart-cleanup"); await bound(g.launcher.completed.catch(() => {}), 12000, "original supervisor forced cleanup"); throw Error("Forced supervisor cleanup required"); });
      if (g.launcher && !g.detail.finalLifecycle) await cleanup(`final-lifecycle-${g.number}`, () => lifecycle(g, "final"));
      if (g.worker) await cleanup(`worker-${g.number}`, () => g.worker.close()); if (g.rootObserver) await cleanup(`root-${g.number}`, () => g.rootObserver.close()); if (g.viewer) await cleanup(`viewer-evidence-${g.number}`, () => g.viewer.settle());
    }
    if (viewerBrowser) await cleanup("viewer-browser", async () => { const session = await bound(viewerBrowser.newBrowserCDPSession(), 5000, "original viewer close session"); await bound(session.send("Browser.close"), 5000, "original viewer Browser.close"); const result = await bound(viewerProcess.completed, 12000, "actual original viewer exit"); assert.equal(result.code, 0); assert.equal(result.termination, undefined); await bound(viewerBrowser.close(), 5000, "viewer client close"); return { code: result.code, exitedAt: result.exitedAt, closedAt: result.closedAt }; });
    if (viewerProcess && !viewerProcess.record.closedAt) await cleanup("viewer-fallback", async () => { viewerProcess.terminate("managed-browser-restart-cleanup"); await bound(viewerProcess.completed.catch(() => {}), 12000, "original viewer forced cleanup"); throw Error("Forced viewer cleanup required"); });
    if (report.processObservations.length) await cleanup("original-processes", async () => { const originals = [...new Map(report.processObservations.flatMap(row => row.groups).flatMap(row => row.processes).map(row => [`${row.ProcessId}/${row.CreationDate}`, row])).values()]; report.originalProcesses = originals; return poll(async () => { const rows = await table(), remaining = originals.filter(before => rows.some(after => before.ProcessId === after.ProcessId && before.CreationDate === after.CreationDate)); report.lastProcessCheck = { at: Date.now(), originalIdentities: originals.length, remaining }; return !remaining.length && report.lastProcessCheck; }, { label: "all observed original processes exited", timeoutMs: 15000, intervalMs: 100 }); });
    if (osObserver) await cleanup("windows-observation", async () => { const records = await osObserver.stop(), exit = await osObserver.closed; await osWrites; if (osWriteError) throw osWriteError; const samples = records.filter(row => row.type === "ready" || row.type === "sample"), gaps = samples.slice(1).map((row, index) => row.elapsedUs - samples[index].elapsedUs); assert.ok(samples.length > 2); const candidates = foregroundPIDMatches(records, [...new Set((report.originalProcesses ?? []).map(row => row.ProcessId))]); report.backgroundEvidence = { records: records.length, samples: samples.length, maximumSampleGapUs: Math.max(...gaps), foregroundEvents: records.filter(row => row.type === "foreground").length, originalProcessForegroundCandidates: candidates, cursorSameAtAllSamples: samples.every(row => row.cursor.x === samples[0].cursor.x && row.cursor.y === samples[0].cursor.y), conclusion: "Foreground events and cursor samples only; no continuous cursor or input causation claim." }; assert.deepEqual(candidates, []); return { complete: true, stopped: records.at(-1), exit }; });
    if (osObserver) report.osEvidence = osObserver.evidence;
    if (osHandle) await cleanup("os-file", async () => { await osWrites; await osHandle.sync(); await osHandle.close(); const bytes = await fs.readFile(path.join(runDir, "windows-observation.jsonl")); return { bytes: bytes.length, sha256: hash(bytes) }; });
    await cleanup("fixture", async () => { server.closeAllConnections(); if (server.listening) await bound(new Promise(resolve => server.close(resolve)), 5000, "original fixture close"); await fixtureWrites; if (fixtureWriteError) throw fixtureWriteError; report.fixture = fixture.stats(scenarioId); report.fixtureRejected = fixture.rejectedStats(); await fs.writeFile(path.join(runDir, "server-evidence.json"), JSON.stringify(fixture.allStats(), null, 2)); return { closed: !server.listening }; });
    if (report.source?.snapshot) await cleanup("source-integrity", async () => { for (const [file, expected] of Object.entries(report.source.snapshot)) assert.equal(hash(await fs.readFile(path.join(repo, file))), expected, `Frozen source changed: ${file}`); assert.deepEqual(await treeHashes(path.join(runDir, "source-snapshot")), report.source.snapshot); for (const [file, expected] of [[executable, report.source.executable], [chromium, report.source.browser], [observerBinary, report.source.observerBinary], [observerBuild, report.observerBuild.sha256], [hostValidation, report.hostBuild.sha256]]) assert.equal(hash(await fs.readFile(file)), expected); assert.deepEqual(await treeHashes(extension), report.source.extension); assert.deepEqual(await treeHashes(path.join(runDir, "extension-input")), report.source.extension); assert.deepEqual(await treeHashes(path.join(repo, "packages/open-browser-use-js/dist")), report.source.sdk); assert.deepEqual(await treeHashes(path.join(runDir, "sdk-input")), report.source.sdk); return { unchanged: true }; });
    report.liveRunnerChildren = [...registry].map(child => child.pid); report.endedAt = Date.now(); report.passed = !report.error && report.steps.length === 7 && report.steps.every(row => row.passed) && report.cleanupErrors.length === 0 && !registry.size && report.cleanup["source-integrity"]?.unchanged === true && report.cleanup["windows-observation"]?.complete === true;
    await save(); console.log("RESULT", JSON.stringify({ runDir, mode, passed: report.passed }));
  }
  return report;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) { const result = await runManagedBrowserRestartCheck({ mode: managedBrowserRestartMode(process.argv.slice(2)) }); process.exitCode = result.passed ? 0 : 1; }
