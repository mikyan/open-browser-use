// Two independently solved research tasks in the formal managed browser.
// This process owns infrastructure and post-task auditing, never task actions.
import { managedWorkerScriptURL } from "./managed-worker-target.mjs";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium as playwrightChromium } from "playwright";
import { createResearchWorkflowFixture, checkResearchReceipt } from "./research-workflow-fixture.mjs";
import { observeManagedWorkflowViewer } from "./managed-workflow-viewer.mjs";
import { startWindowsObservation, foregroundPIDMatches } from "./windows-observation.mjs";
import { parseManagedReadyOutput, assertManagedStopReply } from "./managed-download-check.mjs";
import { projectManagedViewerLifecycle, assertManagedViewerTerminal, assertManagedViewerBrowserCommand } from "./managed-viewer-check.mjs";
import { connectNormalCDP, managedProcess, runProcess, bound, poll } from "./normal-browser-downloads-support.mjs";
import { listenFixture } from "./fixture-listener.mjs";
import { browserStartupOptions } from "./browser-startup.mjs";
import { waitPrivateDevToolsEndpoint } from "./private-devtools-endpoint.mjs";
import { observedProcessDescendants as descendants } from "./observed-process-descendants.mjs";
import { managedResearchLaunchCard, managedResearchBudgetMs, managedResearchCleanupBudgetMs, managedResearchStartupBudgetMs, validateManagedResearchAttempt, validateManagedResearchStart,
  installManagedResearchObservation, managedResearchObservationDelta, verifyManagedResearchRound, readManagedResearchReport, verifyClosedManagedResearchRecording, verifyManagedResearchViewerTabs } from "./managed-research-support.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const redact = value => String(value).replace(/(#ticket=)[A-Za-z0-9_-]+/g, "$1[redacted]");
const serialize = value => JSON.stringify(value, (_key, item) => typeof item === "string" ? redact(item) : item, 2);
const processQuery = "@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,ExecutablePath,@{n='CreationDate';e={$_.CreationDate.ToUniversalTime().ToString('o')}}) | ConvertTo-Json -Compress";
const inside = (root, file) => {
  const relative = path.relative(root, file);
  assert.ok(relative && !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`), "Expected original private path");
  return relative.replaceAll("\\", "/");
};
async function treeHashes(root) {
  const entries = await fs.readdir(root, { recursive: true, withFileTypes: true });
  assert.ok(entries.every(entry => !entry.isSymbolicLink()), "Source tree contains a link");
  return Object.fromEntries(await Promise.all(entries.filter(entry => entry.isFile()).map(async entry => {
    const file = path.join(entry.parentPath, entry.name); return [inside(root, file), hash(await fs.readFile(file))];
  })));
}

export async function runManagedResearchCheck() {
  assert.equal(process.platform, "win32");
  const executable = process.env.OBU_TEST_HOST_BINARY, chromium = process.env.OBU_TEST_CHROMIUM_BINARY, extension = process.env.OBU_TEST_EXTENSION_DIR;
  const observerBinary = process.env.OBU_TEST_OBSERVER_BINARY, observerBuild = process.env.OBU_TEST_OBSERVER_BUILD_REPORT;
  for (const file of [executable, chromium, extension, observerBinary, observerBuild]) {
    assert.ok(typeof file === "string" && path.isAbsolute(file), "Set explicit managed executable, extension, pinned browser and observer binary/build report"); await fs.access(file);
  }
  await fs.mkdir(path.join(repo, ".tmp/browser-integration"), { recursive: true });
  const runDir = await fs.mkdtemp(path.join(repo, ".tmp/browser-integration/mra-")), root = path.join(runDir, "r"), name = "n", viewerProfile = path.join(runDir, "v"), solverDir = path.join(runDir, "solver");
  await fs.mkdir(solverDir);
  const report = { runDir, startedAt: Date.now(), steps: [], commands: [], probes: [], attempts: [], lifecycleSnapshots: [], processObservations: [], observations: [], unexpectedRequests: [], prematureRequests: [], cleanup: {}, cleanupErrors: [], viewer: {},
    scope: "Two new variant-3 research tasks solved by an independent agent through the public SDK in one formally managed Windows browser; original reports retained, actual viewer and native tab/process/resource observations.",
    limits: "Finite local synthetic research, not a speed or full parity result. Runner passed covers its six stages, post-task report/tab/view checks and original cleanup. Independent solver provenance, actual public reading of six sources and strict separate 900s business/60s cleanup timing require an external audit of the retained public trace. Runner never solves tasks or submits business. Source/build provenance of the caller-supplied host remains unverified by this runner; external preflight/audit is separate. OS samples are not continuous cursor proof; foreground PID matches do not prove input causation. Protocol files do not establish solver process liveness." };
  const save = () => fs.writeFile(path.join(runDir, "results.json"), serialize(report));
  const registry = new Set(), taskSpecs = [1, 2].map(attempt => ({ attempt, taskId: `managed-research-${attempt}-${randomUUID().replaceAll("-", "")}`, budgetMs: managedResearchBudgetMs }));
  let launcher, info, worker, viewerProcess, viewerBrowser, viewer, observer, osHandle, osWrites = Promise.resolve(), osWriteError, stopPromise, finalSaved = false, observationStopped = false;
  let serverWrites = Promise.resolve(), serverWriteError, enabledAttempt = 0, pendingAttempt;
  const fixture = createResearchWorkflowFixture({ onChange() {
    const bytes = JSON.stringify(fixture.allStats(), null, 2);
    serverWrites = serverWrites.then(() => fs.writeFile(path.join(runDir, "server-evidence.json"), bytes)).catch(error => { serverWriteError ??= error; });
  } });
  const server = createServer((request, response) => {
    const pathname = new URL(request.url, "http://127.0.0.1").pathname;
    const task = taskSpecs.find(item => pathname === `/research-task/${item.taskId}` || pathname.startsWith(`/research-task/${item.taskId}/`));
    if (task && task.attempt > enabledAttempt) {
      report.prematureRequests.push({ method: request.method, url: request.url, at: Date.now() }); request.resume(); response.writeHead(409); response.end("TASK_NOT_ENABLED"); return;
    }
    if (task && fixture.handle(request, response, server.address().port)) return;
    report.unexpectedRequests.push({ method: request.method, url: request.url, at: Date.now() }); request.resume(); response.writeHead(404); response.end("NOT_FOUND");
  });
  const launch = (program, args, options = {}) => {
    const record = {}; report.commands.push(record);
    return managedProcess(program, args, { cwd: repo, registry, record, maximumBytes: 8 * 1024 * 1024, ...options });
  };
  async function command(args) {
    const result = await launch(executable, args, { timeoutMs: args[1] === "stop" ? 55000 : 45000 }).completed;
    assert.equal(result.code, 0, redact(result.stderr)); return result;
  }
  function check() { viewer?.check(); if (osWriteError) throw osWriteError; if (serverWriteError) throw serverWriteError; assert.equal(report.prematureRequests.length, 0, "Solver accessed a task before its acknowledgment gate"); }
  const wait = (read, label, timeoutMs = 15000) => poll(async () => { check(); return read(); }, { label, timeoutMs, intervalMs: 100 });
  async function step(name, operation) {
    const entry = { name, startedAt: Date.now() }; report.steps.push(entry); console.log("STEP", name);
    try { await operation(); check(); entry.passed = true; }
    catch (error) { entry.passed = false; entry.error = error.stack; report.firstFailure ??= { name, at: Date.now(), error: error.stack }; throw error; }
    finally { entry.endedAt = Date.now(); await save(); }
  }
  async function cleanup(label, operation) {
    try { report.cleanup[label] = await operation(); }
    catch (error) { report.cleanupErrors.push({ label, at: Date.now(), error: error.stack ?? String(error), observation: error.observation }); }
  }
  async function table() {
    const record = {}; report.probes.push(record);
    try { await runProcess("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", processQuery], { registry, record, timeoutMs: 15000, maximumBytes: 2 * 1024 * 1024 }); return JSON.parse(record.stdout); }
    finally { if (typeof record.stdout === "string") record.stdout = { bytes: Buffer.byteLength(record.stdout), sha256: hash(record.stdout) }; }
  }
  async function rememberProcesses(label) {
    const rows = await table(), groups = [];
    for (const [kind, pid] of [["managed", info?.browserPID], ["viewer", viewerProcess?.record.pid]]) if (pid) {
      const previous = report.processObservations.flatMap(row => row.groups).find(row => row.kind === kind)?.processes.find(row => row.ProcessId === pid);
      if (previous) assert.ok(rows.some(row => row.ProcessId === pid && row.CreationDate === previous.CreationDate && row.ExecutablePath === previous.ExecutablePath), "Original browser identity ended before observation");
      groups.push({ kind, rootPID: pid, processes: descendants(rows, pid) });
    }
    report.processObservations.push({ label, at: Date.now(), groups }); return groups;
  }
  async function lifecycle(label) {
    let directory = info?.runDir;
    if (!directory) { const runs = path.join(root, name, "runs"), entries = await fs.readdir(runs, { withFileTypes: true }); assert.equal(entries.length, 1); assert.ok(entries[0].isDirectory() && /^[0-9a-f]{32}$/.test(entries[0].name)); directory = path.join(runs, entries[0].name); }
    inside(root, directory);
    const bytes = await fs.readFile(path.join(directory, "lifecycle.json")), { value, ...metadata } = projectManagedViewerLifecycle(bytes), copy = `lifecycle-${label}.json`;
    await fs.writeFile(path.join(runDir, copy), bytes, { flag: "wx" }); report.lifecycleSnapshots.push({ label, copy, ...metadata });
    if (label === "final") { report.lifecycle = value; finalSaved = true; } else report.readyLifecycle = value;
    return value;
  }
  const endpoint = (profile, owner) => waitPrivateDevToolsEndpoint(profile, { assertAlive() { assert.ok(!owner.record.exitedAt && !owner.record.closedAt && !owner.record.spawnError, "Original private browser owner ended before endpoint"); } });
  async function snapshot(label) {
    const value = await worker.evaluate("__managedResearchObservation.snapshot()");
    assert.equal(value.identity, report.nativeObserver.identity); assert.equal(value.overflow, false); assert.equal(value.stopped, false);
    report.observations.push({ label, ...value }); return value;
  }
  async function readReport(tabId) {
    assert.ok(Number.isSafeInteger(tabId));
    const rows = await worker.evaluate(`chrome.scripting.executeScript({target:{tabId:${tabId}},func:${readManagedResearchReport.toString()}}).then(rows=>rows.map(row=>({documentId:row.documentId,frameId:row.frameId,...row.result})))`);
    assert.equal(rows.length, 1); assert.equal(rows[0].frameId, 0); assert.ok(rows[0].documentId); return rows[0];
  }
  async function ack(attempt, proceed) {
    const value = { attempt, continue: proceed }, file = path.join(solverDir, `ack-${attempt}.json`), temporary = `${file}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(value), { flag: "wx" });
    // Publish the ACK only after its server gate is ready. Another process can
    // read the renamed file before the rename Promise continuation runs here.
    if (attempt === 1 && proceed) enabledAttempt = 2;
    await fs.rename(temporary, file);
    report.acknowledgments ??= []; report.acknowledgments.push({ ...value, at: Date.now() });
  }
  async function readSolverFile(file) {
    let stat; try { stat = await fs.lstat(file); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
    assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= 128 * 1024, "Invalid atomic solver protocol file");
    return fs.readFile(file);
  }
  function assertOriginalRunAlive() {
    assert.ok(!launcher.record.closedAt && !launcher.record.exitedAt, "Original managed supervisor ended while waiting for solver");
    assert.equal(worker.state(), "open", "Original observation connection ended while waiting for solver");
  }
  async function bindRecording(detail) {
    const directory = path.join(solverDir, `recording-${detail.task.attempt}`), copy = `recording-original-${detail.task.attempt}`;
    const stat = await fs.lstat(directory); assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), "Original solver recording directory required");
    const hashes = await treeHashes(directory); detail.recording = { directory, copy, hashes };
    await fs.cp(directory, path.join(runDir, copy), { recursive: true, errorOnExist: true, force: false });
    assert.deepEqual(await treeHashes(path.join(runDir, copy)), hashes); assert.deepEqual(await treeHashes(directory), hashes);
    const metadata = JSON.parse(await fs.readFile(path.join(runDir, copy, "recording.json"), "utf8"));
    assert.equal(metadata.sdkURL, pathToFileURL(report.launchCard.sdkPath).href); assert.equal(metadata.sdkEntrySha256, report.source.sdk["index.js"]);
    detail.recording.closed = verifyClosedManagedResearchRecording(await fs.readFile(path.join(runDir, copy, "calls.jsonl"), "utf8"));
  }
  async function stopOriginal() {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      try { await rememberProcesses("before-stop"); } catch (error) { report.cleanupErrors.push({ label: "pre-stop inventory", error: error.stack }); }
      const result = await command(["managed", "stop", "--root", root, "--name", name]);
      report.stopReply = assertManagedStopReply(JSON.parse(result.stdout), info?.runId);
      const terminal = await bound(launcher.completed, 10000, "original supervisor actual close"); assert.equal(terminal.code, 0, redact(terminal.stderr)); assert.equal(terminal.termination, undefined);
      report.supervisorExit = { code: terminal.code, exitedAt: terminal.exitedAt, closedAt: terminal.closedAt };
      const value = await lifecycle("final"); assertManagedViewerTerminal(value, info); if (report.readyLifecycle) assert.deepEqual(value.binding, report.readyLifecycle.binding);
      return { confirmed: true, at: Date.now() };
    })(); return stopPromise;
  }
  async function verifyResources() {
    const controlPipe = "\\\\.\\pipe\\open-browser-use-managed-" + hash(path.resolve(root).toLowerCase() + "\0" + name).slice(0, 40);
    const scope = { host: info.nativeHostName, pipes: [info.socketPath, controlPipe] }; assert.match(scope.host, /^com\.openbrowseruse\.managed\.n[0-9a-f]{32}$/);
    const script = String.raw`$ErrorActionPreference='Stop'
$scope=$env:OBU_RESEARCH_RESOURCE_PROBE | ConvertFrom-Json
$keys=@()
foreach($view in @([Microsoft.Win32.RegistryView]::Registry32,[Microsoft.Win32.RegistryView]::Registry64)) {
  $base=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser,$view);$key=$null
  try {$key=$base.OpenSubKey(('Software\Google\Chrome\NativeMessagingHosts\'+$scope.host),$false);$keys+=@{view=$view.ToString();absent=($null -eq $key)}} finally {if($null -ne $key){$key.Close()};$base.Close()}
}
$present=@([IO.Directory]::GetFiles('\\.\pipe\') | Where-Object {$scope.pipes -contains $_})
@{registration=$keys;presentOriginalPipes=$present} | ConvertTo-Json -Compress -Depth 5`;
    const record = {}; report.resourceProbe = record;
    await runProcess("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { registry, record, env: { ...process.env, OBU_RESEARCH_RESOURCE_PROBE: JSON.stringify(scope) }, timeoutMs: 15000 });
    const value = JSON.parse(record.stdout); assert.equal(value.registration.length, 2); assert.ok(value.registration.every(row => row.absent)); assert.deepEqual(value.presentOriginalPipes, []);
    const entries = await fs.readdir(path.join(info.runDir, "temp", "open-browser-use")); assert.deepEqual(entries, []);
    return { ...value, endpointEntries: entries, checkedAt: Date.now() };
  }

  try {
    await step("freeze-current-sources-and-supplied-build-inputs", async () => {
      report.source = { executable: hash(await fs.readFile(executable)), browser: hash(await fs.readFile(chromium)), observerBinary: hash(await fs.readFile(observerBinary)), extension: await treeHashes(extension), sdk: await treeHashes(path.join(repo, "packages/open-browser-use-js/dist")), snapshot: {} };
      assert.equal(report.source.browser, "566971689aecea06a88355ea1e9020c908b7a3b093dd0d2a12ae7073489a77aa", "Expected fixed CfT 156.0.8078.12");
      report.hostBuild = { mode: "caller supplied binary; source/build provenance unverified", executableSHA256: report.source.executable };
      const selected = await launch("git", ["ls-files", "--cached", "--others", "--exclude-standard", "--", "cmd", "internal", "apps/chrome-extension", "packages/open-browser-use-js", "scripts/browser-integration", "scripts/build-chrome-extension.mjs", ":(glob)scripts/patch-*.mjs", "go.mod", "go.sum", "pnpm-lock.yaml"], { timeoutMs: 15000 }).completed;
      assert.equal(selected.code, 0);
      for (const file of [...new Set(selected.stdout.trim().split(/\r?\n/))]) {
        inside(repo, path.resolve(repo, file)); const bytes = await fs.readFile(path.join(repo, file)); report.source.snapshot[file] = hash(bytes);
        const destination = path.join(runDir, "source-snapshot", file); await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.writeFile(destination, bytes, { flag: "wx" });
      }
      const observerBytes = await fs.readFile(observerBuild), build = JSON.parse(observerBytes);
      assert.equal(build.passed, true); assert.deepEqual(build.before, build.after); assert.equal(build.observer.sha256, report.source.observerBinary);
      assert.ok(Object.keys(build.before).length > 0); assert.ok(build.commands.length >= 3 && build.commands.every(row => row.exitCode === 0));
      for (const [file, sha] of Object.entries(build.before)) { inside(repo, path.resolve(repo, file)); assert.equal(hash(await fs.readFile(path.join(repo, file))), sha); }
      await fs.writeFile(path.join(runDir, "observer-build.json"), observerBytes, { flag: "wx" }); report.observerBuild = { file: "observer-build.json", sha256: hash(observerBytes), sourceMatched: true };
      await fs.cp(extension, path.join(runDir, "extension-input"), { recursive: true });
      await fs.cp(path.join(repo, "packages/open-browser-use-js/dist"), path.join(runDir, "sdk-input"), { recursive: true });
      await listenFixture(server); report.fixtureURL = `http://127.0.0.1:${server.address().port}`;
      for (const task of taskSpecs) task.url = `${report.fixtureURL}/research-task/${task.taskId}?variant=3`;
    });
    await step("formal-managed-run-and-passive-observers", async () => {
      osHandle = await fs.open(path.join(runDir, "windows-observation.jsonl"), "wx");
      observer = await startWindowsObservation({ executable: observerBinary, sampleMs: 50, onRecord(record) {
        const line = JSON.stringify(record) + "\n"; osWrites = osWrites.then(() => osHandle.write(line)).catch(error => { osWriteError ??= error; });
      } }); report.osReady = observer.ready;
      assert.ok(report.source.snapshot["scripts/browser-integration/managed-worker-target.mjs"], "Managed worker helper must be frozen before acceptance");
      launcher = launch(executable, ["managed", "run", "--root", root, "--name", name, "--browser-path", chromium, "--extension-dir", extension, "--startup-timeout", "30s"]);
      const ready = await wait(() => { assert.ok(!launcher.record.closedAt && !launcher.record.exitedAt && !launcher.record.spawnError, "Original supervisor ended before ready"); return parseManagedReadyOutput(launcher.record.stdout); }, "formal managed run ready", 40000);
      assert.equal(ready.state, "ready"); info = ready.info; report.info = info; inside(root, info.runDir); assert.equal(info.name, name);
      const life = await lifecycle("ready"); assert.equal(life.state, "ready"); assert.deepEqual(life.info, info); assertManagedViewerBrowserCommand(life, chromium);
      assert.equal(life.binding.bound, true); assert.equal(life.binding.exclusive, true);
      assert.deepEqual(JSON.parse((await command(["managed", "status", "--root", root, "--name", name])).stdout).info, info);
      const groups = await rememberProcesses("ready"); assert.ok(groups[0].processes.some(row => row.ProcessId === info.nativePID));
      const privateEndpoint = await endpoint(info.profileDir, launcher), response = await fetch(`http://127.0.0.1:${privateEndpoint.port}/json/list`, { signal: AbortSignal.timeout(10000) }); assert.equal(response.status, 200);
      const targets = (await response.json()).filter(row => row.type === "service_worker" && row.url === managedWorkerScriptURL(info)); assert.equal(targets.length, 1);
      report.workerTarget = { id: targets[0].id, url: targets[0].url }; report.workerConnection = {};
      worker = await connectNormalCDP(targets[0].webSocketDebuggerUrl, { record: report.workerConnection, handshakeTimeoutMs: 10000, authorizationRequired: false });
      report.nativeObserver = await worker.evaluate(`(${installManagedResearchObservation.toString()})(chrome,globalThis)`);
      report.initialObservation = await snapshot("initial-before-solver");
      const startup = browserStartupOptions([`--user-data-dir=${viewerProfile}`, "--headless=new", "--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "about:blank"], process.env.OBU_TEST_FIELD_TRIAL_CONFIG);
      report.viewerStartup = startup; viewerProcess = launch(chromium, startup.args);
      viewerBrowser = await playwrightChromium.connectOverCDP((await endpoint(viewerProfile, viewerProcess)).url);
      const context = await bound(viewerBrowser.newContext({ viewport: { width: 1280, height: 1000 } }), 10000, "original viewer context"), page = await bound(context.newPage(), 10000, "original viewer page");
      viewer = await observeManagedWorkflowViewer({ page, url: ready.viewerURL, directory: runDir, detail: report.viewer });
      report.initialViewerTabs = structuredClone(viewer.state.tabs);
      assert.deepEqual(report.initialViewerTabs.map(row => row.id).sort(), report.initialObservation.tabs.map(row => row.id).sort());
      await rememberProcesses("both-browsers-ready");
    });
    let before = await snapshot("attempt-1-before"), enabledAt = Date.now();
    report.launchCard = managedResearchLaunchCard({ sdkPath: path.join(runDir, "sdk-input/index.js"), recordingModule: path.join(repo, "scripts/browser-integration/recorded-agent-sdk.mjs"), socketPath: info.socketPath, artifactDir: solverDir, tasks: taskSpecs });
    enabledAttempt = 1; report.launchPublishedAt = enabledAt;
    const cardFile = path.join(solverDir, "launch-card.json");
    await fs.writeFile(`${cardFile}.tmp`, JSON.stringify(report.launchCard, null, 2), { flag: "wx" }); await fs.rename(`${cardFile}.tmp`, cardFile); await save();
    console.log("SOLVER_READY", JSON.stringify({ runDir, launchCard: path.join(solverDir, "launch-card.json") }));
    for (const task of taskSpecs) {
      pendingAttempt = task.attempt;
      await step(`independent-solver-research-${task.attempt}-and-original-delivery`, async () => {
        const detail = { task, enabledAt, before, startupObservationBudgetMs: managedResearchStartupBudgetMs, terminalObservationBudgetMs: managedResearchBudgetMs + managedResearchCleanupBudgetMs }; report.attempts.push(detail);
        const terminalFile = path.join(solverDir, `attempt-${task.attempt}.json`), startFile = path.join(solverDir, `start-${task.attempt}.json`);
        const first = await wait(async () => {
          assertOriginalRunAlive();
          const start = await readSolverFile(startFile); if (start) return { start };
          const terminal = await readSolverFile(terminalFile); return terminal ? { terminal } : null;
        }, `independent solver preparation attempt ${task.attempt}`, managedResearchStartupBudgetMs);
        let terminalBytes = first.terminal;
        if (first.start) {
          detail.startMarkerFile = { file: inside(runDir, startFile), bytes: first.start.length, sha256: hash(first.start) };
          await fs.writeFile(path.join(runDir, `start-${task.attempt}-original.json`), first.start, { flag: "wx" });
          detail.startMarker = validateManagedResearchStart(JSON.parse(first.start), task, { enabledAt, receivedAt: Date.now() });
          detail.terminalObservationDeadline = detail.startMarker.startedAt + detail.terminalObservationBudgetMs;
          const remainingMs = detail.terminalObservationDeadline - Date.now(); assert.ok(remainingMs > 0, "Original solver observation deadline expired");
          terminalBytes = await wait(async () => { assertOriginalRunAlive(); return readSolverFile(terminalFile); }, `independent solver terminal attempt ${task.attempt}`, remainingMs);
        } else detail.preparationFailed = true;
        detail.receivedAt = Date.now(); detail.terminalFile = { file: inside(runDir, terminalFile), bytes: terminalBytes.length, sha256: hash(terminalBytes) };
        await fs.writeFile(path.join(runDir, `attempt-${task.attempt}-original.json`), terminalBytes, { flag: "wx" });
        detail.terminal = validateManagedResearchAttempt(JSON.parse(terminalBytes), task, { enabledAt, receivedAt: detail.receivedAt, startedAt: detail.startMarker?.startedAt });
        if (detail.preparationFailed) assert.equal(detail.terminal.success, false, "Successful task omitted its original start marker");
        try { await bindRecording(detail); } catch (error) { detail.recordingError = error.stack; if (detail.terminal.success) throw error; }
        assert.equal(detail.terminal.success, true, `Independent solver task failed: ${detail.terminal.summary}`);
        detail.after = await snapshot(`attempt-${task.attempt}-after-finalize`);
        detail.disposition = verifyManagedResearchRound({ task, terminal: detail.terminal, before, after: detail.after, fixtureURL: report.fixtureURL });
        detail.document = await readReport(detail.terminal.reportTabId);
        const receipt = JSON.parse(detail.document.receiptText); detail.receipt = receipt;
        detail.business = checkResearchReceipt(receipt, fixture.stats(task.taskId));
        assert.equal(detail.document.url, `${report.fixtureURL}/research-task/${task.taskId}/report`);
        assert.deepEqual(detail.document.links.map(row => row.href).sort(), receipt.rows.flatMap(row => [row.quoteURL, row.termsURL]).sort());
        detail.resultEntry = await viewer.select(detail.terminal.reportTabId, "result");
        detail.frame = await viewer.capture({ tabId: detail.terminal.reportTabId, kind: "result", label: `research-${task.attempt}-delivered` }); await viewer.deselect();
        detail.afterViewing = await snapshot(`attempt-${task.attempt}-after-view`);
        assert.deepEqual(managedResearchObservationDelta(detail.after, detail.afterViewing), [], "Viewing delivered result changed native tab lifecycle or focus");
        assert.equal(detail.afterViewing.targets.find(row => row.tabId === detail.terminal.reportTabId)?.id, detail.disposition.target.id);
        await rememberProcesses(`after-research-${task.attempt}`);
      });
      before = await snapshot(`attempt-${task.attempt}-gate`);
      if (task.attempt === 1) {
        enabledAt = Date.now();
        await ack(task.attempt, true); pendingAttempt = null; await save();
      }
    }
    await step("both-original-reports-retained-and-viewed", async () => {
      const current = await viewer.refresh(), ids = report.attempts.map(item => item.terminal.reportTabId);
      report.finalViewerState = current;
      report.viewerTabDisposition = verifyManagedResearchViewerTabs({ initialTabs: report.initialViewerTabs, resultEntries: report.attempts.map(item => item.resultEntry), currentTabs: current.tabs });
      report.finalResults = [];
      for (const attempt of report.attempts) {
        const tabId = attempt.terminal.reportTabId, document = await readReport(tabId);
        assert.equal(document.documentId, attempt.document.documentId); assert.deepEqual(JSON.parse(document.receiptText), attempt.receipt);
        const entry = await viewer.select(tabId, "result"); assert.equal(entry.deliveryId, attempt.resultEntry.deliveryId);
        const frame = await viewer.capture({ tabId, kind: "result", label: `research-${attempt.task.attempt}-final` }); await viewer.deselect();
        report.finalResults.push({ document, entry, frameIndex: frame.frameIndex });
      }
      report.finalObservation = await snapshot("final-reports");
      assert.deepEqual(managedResearchObservationDelta(before, report.finalObservation), []);
      assert.deepEqual(report.finalObservation.tabs.map(row => row.id).sort(), [...report.initialObservation.tabs.map(row => row.id), ...ids].sort());
      for (const original of report.initialObservation.tabs) for (const field of ["url", "windowId", "groupId", "pinned", "active"]) assert.equal(report.finalObservation.tabs.find(row => row.id === original.id)?.[field], original[field]);
      for (const attempt of report.attempts) assert.equal(report.finalObservation.targets.find(row => row.tabId === attempt.terminal.reportTabId)?.id, attempt.disposition.target.id);
      assert.equal(fixture.allStats().length, 2); assert.equal(fixture.allStats().reduce((n, row) => n + row.posts.length, 0), 2);
      report.observerStopped = await worker.evaluate("__managedResearchObservation.stop()"); observationStopped = true;
      assert.equal(report.observerStopped.overflow, false); assert.deepEqual(report.observerStopped.listenersPresent, [false, false, false, false]);
      assert.deepEqual(managedResearchObservationDelta(report.finalObservation, report.observerStopped), [], "Native events changed before listener removal");
      const completeEvents = managedResearchObservationDelta(report.initialObservation, report.observerStopped);
      assert.deepEqual(completeEvents.filter(row => row.type === "activated" || row.type === "focus"), []);
      for (const [type, field] of [["created", "createdTabIds"], ["removed", "closedTabIds"]]) {
        assert.deepEqual(completeEvents.filter(row => row.type === type).map(row => type === "created" ? row.tab.id : row.tabId).sort(), report.attempts.flatMap(row => row.disposition[field]).sort(), "Native task lifecycle changed outside the two measured attempts");
      }
    });
    await ack(2, true); pendingAttempt = null; await save();
    await step("formal-stop-original-browser-and-native", async () => { await worker.close(); worker = null; await stopOriginal(); });
  } catch (error) {
    report.error = error.stack ?? String(error); report.observerFailure = error.observation; console.error(redact(report.error));
    if (pendingAttempt) await cleanup("negativeAcknowledgment", () => ack(pendingAttempt, false));
  } finally {
    if (worker && !observationStopped) await cleanup("nativeObserver", async () => { const value = await worker.evaluate("__managedResearchObservation.stop()"); report.observerStopped = value; assert.deepEqual(value.listenersPresent, [false, false, false, false]); return value; });
    if (worker) await cleanup("workerConnection", () => worker.close());
    if (launcher && !report.supervisorExit) await cleanup("stop", stopOriginal);
    if (launcher && !launcher.record.closedAt) await cleanup("supervisorFallback", async () => { launcher.terminate("managed-research-cleanup"); await bound(launcher.completed.catch(() => {}), 12000, "original supervisor fallback"); throw Error("Supervisor needed forced termination"); });
    if (launcher && !finalSaved) await cleanup("finalLifecycle", () => lifecycle("final"));
    if (viewerBrowser) await cleanup("viewerBrowser", async () => {
      const session = await bound(viewerBrowser.newBrowserCDPSession(), 5000, "original viewer close session"); await bound(session.send("Browser.close"), 5000, "original viewer close command");
      const result = await bound(viewerProcess.completed, 12000, "original viewer actual close"); assert.equal(result.code, 0); assert.equal(result.termination, undefined);
      await bound(viewerBrowser.close(), 5000, "original viewer client close"); return { code: result.code, exitedAt: result.exitedAt, closedAt: result.closedAt };
    });
    if (viewerProcess && !viewerProcess.record.closedAt) await cleanup("viewerFallback", async () => { viewerProcess.terminate("managed-research-viewer-cleanup"); await bound(viewerProcess.completed.catch(() => {}), 12000, "original viewer fallback close"); throw Error("Viewer needed forced termination"); });
    if (viewer) await cleanup("viewerEvidence", () => viewer.settle());
    if (info) await cleanup("privateResources", verifyResources);
    if (report.processObservations.length) await cleanup("originalProcesses", async () => {
      const originals = [...new Map(report.processObservations.flatMap(row => row.groups).flatMap(row => row.processes).map(row => [`${row.ProcessId}/${row.CreationDate}`, row])).values()]; report.originalProcesses = originals;
      return poll(async () => { const rows = await table(), remaining = originals.filter(before => rows.some(after => before.ProcessId === after.ProcessId && before.CreationDate === after.CreationDate)); report.lastProcessCheck = { at: Date.now(), originalIdentities: originals.length, remaining }; return !remaining.length && report.lastProcessCheck; }, { label: "all observed original process identities ended", timeoutMs: 15000, intervalMs: 100 });
    });
    if (observer) await cleanup("windowsObservation", async () => {
      const records = await observer.stop(), exit = await observer.closed; await osWrites; if (osWriteError) throw osWriteError;
      const sampled = records.filter(row => row.type === "ready" || row.type === "sample"), gaps = sampled.slice(1).map((row, index) => row.elapsedUs - sampled[index].elapsedUs);
      assert.ok(sampled.length > 2); const candidates = foregroundPIDMatches(records, [...new Set((report.originalProcesses ?? []).map(row => row.ProcessId))]);
      report.backgroundEvidence = { sampleMs: observer.ready.sampleMs, records: records.length, foregroundEvents: records.filter(row => row.type === "foreground").length, samples: sampled.length, maximumSampleGapUs: Math.max(...gaps), cursorSameAtAllSamples: sampled.every(row => row.cursor.x === sampled[0].cursor.x && row.cursor.y === sampled[0].cursor.y), originalProcessForegroundCandidates: candidates, observerExit: exit,
        conclusion: "Observed foreground events and sampled positions only. Cursor changes outside the owned browser are not failures or attributed to the agent/user; equality is not continuous immobility." };
      assert.deepEqual(candidates, [], "An observed owned browser process appeared in foreground; observation retained without restoring focus");
      return { complete: true, records: records.length, stopped: records.at(-1), exit };
    });
    if (observer) report.observerEvidence = observer.evidence;
    if (osHandle) await cleanup("observationFile", async () => { await osWrites; await osHandle.sync(); await osHandle.close(); osHandle = null; const bytes = await fs.readFile(path.join(runDir, "windows-observation.jsonl")); return { file: "windows-observation.jsonl", bytes: bytes.length, sha256: hash(bytes) }; });
    await cleanup("fixture", async () => { server.closeAllConnections(); if (server.listening) await bound(new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())), 5000, "original fixture server close"); await serverWrites; if (serverWriteError) throw serverWriteError; await fs.writeFile(path.join(runDir, "server-evidence.json"), JSON.stringify(fixture.allStats(), null, 2)); return { closed: !server.listening }; });
    if (report.source?.snapshot) await cleanup("sourceIntegrity", async () => {
      for (const [file, expected] of Object.entries(report.source.snapshot)) assert.equal(hash(await fs.readFile(path.join(repo, file))), expected, `Source changed during acceptance: ${file}`);
      assert.deepEqual(await treeHashes(path.join(runDir, "source-snapshot")), report.source.snapshot);
      for (const [file, expected] of [[executable, report.source.executable], [chromium, report.source.browser], [observerBinary, report.source.observerBinary], [observerBuild, report.observerBuild.sha256]]) assert.equal(hash(await fs.readFile(file)), expected);
      assert.deepEqual(await treeHashes(extension), report.source.extension); assert.deepEqual(await treeHashes(path.join(runDir, "extension-input")), report.source.extension);
      assert.deepEqual(await treeHashes(path.join(repo, "packages/open-browser-use-js/dist")), report.source.sdk); assert.deepEqual(await treeHashes(path.join(runDir, "sdk-input")), report.source.sdk);
      for (const attempt of report.attempts) if (attempt.recording) {
        assert.deepEqual(await treeHashes(attempt.recording.directory), attempt.recording.hashes);
        assert.deepEqual(await treeHashes(path.join(runDir, attempt.recording.copy)), attempt.recording.hashes);
      }
      return { unchanged: true, at: Date.now() };
    });
    report.fixture = fixture.allStats(); report.liveRunnerChildren = [...registry].map(child => child.pid); report.endedAt = Date.now();
    report.passed = !report.error && report.steps.length === 6 && report.steps.every(row => row.passed) && report.cleanupErrors.length === 0 && !registry.size && report.cleanup.sourceIntegrity?.unchanged === true && report.cleanup.windowsObservation?.complete === true;
    await save(); console.log("RESULT", JSON.stringify({ runDir, passed: report.passed }));
  }
  return report;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  assert.equal(process.argv.length, 2, "No research replay or task-selection arguments");
  const result = await runManagedResearchCheck(); process.exitCode = result.passed ? 0 : 1;
}
