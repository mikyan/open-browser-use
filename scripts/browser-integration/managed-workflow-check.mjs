// Five original transactions through a packaged managed supervisor and the
// public callers. Diagnostic reads never perform or repair a business action.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium as playwrightChromium } from "playwright";
import { createManagedWorkflowFixture, readManagedWorkflowDocument } from "./managed-workflow-fixture.mjs";
import { runManagedWorkflowCaller } from "./managed-workflow-callers.mjs";
import { observeManagedWorkflowViewer } from "./managed-workflow-viewer.mjs";
import { startWindowsObservation, foregroundPIDMatches } from "./windows-observation.mjs";
import { parseManagedReadyOutput, assertManagedStopReply } from "./managed-download-check.mjs";
import { projectManagedViewerLifecycle, assertManagedViewerTerminal, assertManagedViewerBrowserCommand } from "./managed-viewer-check.mjs";
import { connectNormalCDP, managedProcess, runProcess, bound, poll } from "./normal-browser-downloads-support.mjs";
import { resolveNormalDownloadRoot } from "./normal-browser-downloads-proof.mjs";
import { readOriginalDownloadProof, openOriginalDownloadFile } from "./original-download-proof.mjs";
import { listenFixture } from "./fixture-listener.mjs";
import { browserStartupOptions } from "./browser-startup.mjs";
import { waitPrivateDevToolsEndpoint } from "./private-devtools-endpoint.mjs";
import { observedProcessDescendants as descendants } from "./observed-process-descendants.mjs";

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
function installCreationObservation(chrome, target) {
  if (target.__managedWorkflowObservation) throw Error("Observer already installed");
  const sources = new Set(), events = []; let overflow = false;
  const listener = event => { if (!sources.has(event.sourceTabId)) return; if (events.length >= 32) { overflow = true; return; } events.push({ at: Date.now(), ...event }); };
  chrome.webNavigation.onCreatedNavigationTarget.addListener(listener);
  target.__managedWorkflowObservation = {
    register(tabId) { if (!Number.isSafeInteger(tabId) || sources.has(tabId) || sources.size >= 5) throw Error("Invalid original source"); sources.add(tabId); return { tabId, registered: true }; },
    snapshot: () => ({ events, overflow }),
    stop() { chrome.webNavigation.onCreatedNavigationTarget.removeListener(listener); return { events, overflow, listenerPresent: chrome.webNavigation.onCreatedNavigationTarget.hasListener(listener) }; }
  };
  return { installed: true };
}

export async function runManagedWorkflowCheck() {
  assert.equal(process.platform, "win32");
  const bundle = process.env.OBU_TEST_RELEASE_BUNDLE, chromium = process.env.OBU_TEST_CHROMIUM_BINARY;
  const observerBinary = process.env.OBU_TEST_OBSERVER_BINARY, goHelperBinary = process.env.OBU_TEST_GO_WORKFLOW_HELPER;
  const python = process.env.OBU_TEST_PYTHON, buildReport = process.env.OBU_TEST_RELEASE_BUILD_REPORT, auditReport = process.env.OBU_TEST_RELEASE_AUDIT, helperReport = process.env.OBU_TEST_HELPER_BUILD_REPORT;
  for (const file of [bundle, chromium, observerBinary, goHelperBinary, python, buildReport, auditReport, helperReport]) { assert.ok(typeof file === "string" && path.isAbsolute(file), "Set explicit released bundle, Chromium, helper binaries, Python and release/helper evidence paths"); await fs.access(file); }
  const executable = path.join(bundle, "open-browser-use.exe"), extension = path.join(bundle, "extension");
  await fs.mkdir(path.join(repo, ".tmp/browser-integration"), { recursive: true });
  const runDir = await fs.mkdtemp(path.join(repo, ".tmp/browser-integration/mwf-")), root = path.join(runDir, "r"), name = "n", viewerProfile = path.join(runDir, "v");
  const report = { runDir, startedAt: Date.now(), steps: [], commands: [], probes: [], attempts: [], lifecycleSnapshots: [], processObservations: [], unexpectedRequests: [], cleanup: {}, cleanupErrors: [], viewer: {},
    scope: "Five distinct original transactions through JS/Python/Go typed SDKs and managed-selected CLI/MCP using a clean-source packaged Windows EXE and extension (release or internal candidate; publication is not inferred). Real viewer DOM and original file bytes; read-only OS foreground events and cursor samples spanning launch through Stop.",
    limits: "Deterministic local fixture acceptance, not solver/speed or whole-platform parity. No ordinary profile, real account, OS input, URL/business/input replay, focus restoration or input/dialog recovery. Foreground HWND/PID observations are not process-incarnation or input-causation proof; timed cursor samples are not a continuous cursor trace. CIM inventories are supplemental to original Go process/Job receipts." };
  const save = () => fs.writeFile(path.join(runDir, "results.json"), serialize(report));
  const registry = new Set(), fixture = createManagedWorkflowFixture();
  let launcher, info, worker, viewerProcess, viewerBrowser, viewer, page, observer, osHandle, osWrites = Promise.resolve(), osWriteError, stopPromise, finalSaved = false;
  const server = createServer((request, response) => {
    if (fixture.handle(request, response)) return;
    report.unexpectedRequests.push({ method: request.method, url: request.url, at: Date.now() });
    request.resume(); response.writeHead(404); response.end("NOT_FOUND");
  });
  const launch = (program, args, options = {}) => {
    const record = {}; report.commands.push(record);
    return managedProcess(program, args, { cwd: repo, registry, record, maximumBytes: 8 * 1024 * 1024, ...options });
  };
  async function command(args, expected = 0) {
    const result = await launch(executable, args, { timeoutMs: args[1] === "stop" ? 55000 : 45000 }).completed;
    assert.equal(result.code, expected, redact(result.stderr)); return result;
  }
  const wait = (read, label, timeoutMs = 15000) => poll(async () => { viewer?.check(); if (osWriteError) throw osWriteError; return read(); }, { label, timeoutMs, intervalMs: 50 });
  async function step(name, operation) {
    const entry = { name, startedAt: Date.now() }; report.steps.push(entry); console.log("STEP", name);
    try { await operation(); viewer?.check(); entry.passed = true; }
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
    const file = path.join(directory, "lifecycle.json"); inside(root, file);
    const bytes = await fs.readFile(file), { value, ...metadata } = projectManagedViewerLifecycle(bytes), copy = `lifecycle-${label}.json`;
    await fs.writeFile(path.join(runDir, copy), bytes, { flag: "wx" }); report.lifecycleSnapshots.push({ label, copy, ...metadata });
    if (label === "final") { report.lifecycle = value; finalSaved = true; } else report.readyLifecycle = value;
    return value;
  }
  const endpoint = (profile, owner) => waitPrivateDevToolsEndpoint(profile, { assertAlive() { assert.ok(!owner.record.exitedAt && !owner.record.closedAt && !owner.record.spawnError, "Original private browser owner ended before endpoint"); } });
  const readDocument = tabId => worker.evaluate(`chrome.scripting.executeScript({target:{tabId:${tabId}},func:${readManagedWorkflowDocument.toString()}}).then(rows=>{if(rows.length!==1)throw Error('Ambiguous original root');return {documentId:rows[0].documentId,frameId:rows[0].frameId,...rows[0].result}})`);
  const targetFor = tabId => worker.evaluate(`chrome.debugger.getTargets().then(rows=>rows.filter(row=>row.type==='page'&&row.tabId===${tabId}).map(row=>({id:row.id,tabId:row.tabId,url:row.url,attached:row.attached})))`);
  async function stopOriginal() {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      try { await rememberProcesses("before-stop"); } catch (error) { report.cleanupErrors.push({ label: "pre-stop inventory", error: error.stack }); }
      const result = await command(["managed", "stop", "--root", root, "--name", name]);
      report.stopReply = assertManagedStopReply(JSON.parse(result.stdout), info?.runId);
      const terminal = await bound(launcher.completed, 10000, "original supervisor actual close"); assert.equal(terminal.code, 0, redact(terminal.stderr)); assert.equal(terminal.termination, undefined);
      report.supervisorExit = { code: terminal.code, exitedAt: terminal.exitedAt, closedAt: terminal.closedAt };
      const value = await lifecycle("final"); assertManagedViewerTerminal(value, info); assert.deepEqual(value.binding, report.readyLifecycle.binding);
      return { confirmed: true, at: Date.now() };
    })(); return stopPromise;
  }
  async function verifyResources() {
    const controlPipe = "\\\\.\\pipe\\open-browser-use-managed-" + hash(path.resolve(root).toLowerCase() + "\0" + name).slice(0, 40);
    const scope = { host: info.nativeHostName, pipes: [info.socketPath, controlPipe] };
    assert.match(scope.host, /^com\.openbrowseruse\.managed\.n[0-9a-f]{32}$/);
    const script = String.raw`$ErrorActionPreference='Stop'
$scope=$env:OBU_WORKFLOW_RESOURCE_PROBE | ConvertFrom-Json
$keys=@()
foreach($view in @([Microsoft.Win32.RegistryView]::Registry32,[Microsoft.Win32.RegistryView]::Registry64)) {
  $base=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser,$view);$key=$null
  try {$key=$base.OpenSubKey(('Software\Google\Chrome\NativeMessagingHosts\'+$scope.host),$false);$keys+=@{view=$view.ToString();absent=($null -eq $key)}} finally {if($null -ne $key){$key.Close()};$base.Close()}
}
$present=@([IO.Directory]::GetFiles('\\.\pipe\') | Where-Object {$scope.pipes -contains $_})
@{registration=$keys;presentOriginalPipes=$present} | ConvertTo-Json -Compress -Depth 5`;
    const record = {}; report.resourceProbe = record;
    await runProcess("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { registry, record, env: { ...process.env, OBU_WORKFLOW_RESOURCE_PROBE: JSON.stringify(scope) }, timeoutMs: 15000 });
    const value = JSON.parse(record.stdout); assert.equal(value.registration.length, 2); assert.ok(value.registration.every(row => row.absent)); assert.deepEqual(value.presentOriginalPipes, []);
    const entries = await fs.readdir(path.join(info.runDir, "temp", "open-browser-use")); assert.deepEqual(entries, []);
    return { ...value, endpointEntries: entries, checkedAt: Date.now() };
  }
  async function verifyOriginalFile(attempt) {
    const task = fixture.stats().tasks.find(row => row.taskId === attempt.taskId); assert.ok(task.file);
    const proof = await readOriginalDownloadProof(report.downloadRoot.directory, attempt.file.productPath, task.file);
    assert.equal(proof.sha256, attempt.file.sha256); assert.deepEqual(proof.analysis, attempt.receipt);
    assert.deepEqual(proof.identity, attempt.file.identity); return proof;
  }
  async function removeOriginalFiles() {
    assert.ok(report.supervisorExit, "Original supervisor must have closed before file cleanup");
    assert.equal(report.fileCleanup, undefined, "Do not replay a previous file cleanup attempt"); report.fileCleanup = [];
    for (const { detail } of report.attempts.filter(row => row.detail.file)) {
      const item = { path: detail.file.productPath, removed: false }; report.fileCleanup.push(item);
      const original = await verifyOriginalFile(detail), final = await openOriginalDownloadFile(report.downloadRoot.directory, detail.file.productPath);
      try { assert.deepEqual(final.identity, original.identity); } finally { await final.handle.close(); }
      await fs.unlink(detail.file.productPath); await assert.rejects(fs.lstat(detail.file.productPath), { code: "ENOENT" });
      Object.assign(item, { sha256: original.sha256, identity: original.identity, removed: true, boundary: "Exact original identity/bytes checked before unlink; not an atomic concurrent-filesystem guarantee." });
    }
    return { removed: report.fileCleanup.length };
  }

  try {
    await step("freeze-packaged-product-and-all-caller-inputs", async () => {
      const manifestBytes = await fs.readFile(path.join(bundle, "BUILD-MANIFEST.json")), manifest = JSON.parse(manifestBytes);
      const buildBytes = await fs.readFile(buildReport), build = JSON.parse(buildBytes), auditBytes = await fs.readFile(auditReport), audit = JSON.parse(auditBytes);
      assert.equal(manifest.sourceDirty, false); assert.equal(build.passed, true); assert.equal(audit.verified, true);
      assert.equal(build.sourceCommit, manifest.sourceCommit); assert.equal(audit.sourceCommit, manifest.sourceCommit); assert.equal(audit.tag, manifest.version);
      report.source = { releaseCommit: manifest.sourceCommit, tag: manifest.version, executable: hash(await fs.readFile(executable)), browser: hash(await fs.readFile(chromium)), extension: await treeHashes(extension), observerBinary: hash(await fs.readFile(observerBinary)), goHelperBinary: hash(await fs.readFile(goHelperBinary)), pythonBinary: hash(await fs.readFile(python)) };
      assert.equal(report.source.executable, build.exeSHA256); assert.equal(report.source.executable, audit.exeSHA256); assert.equal(report.source.executable, manifest.files['open-browser-use.exe']);
      assert.equal(report.source.browser, "566971689aecea06a88355ea1e9020c908b7a3b093dd0d2a12ae7073489a77aa", "Expected pinned CfT 156.0.8078.12 binary");
      for (const [file, sha] of Object.entries(report.source.extension)) assert.equal(manifest.files[`extension/${file}`], sha);
      assert.equal(Object.keys(report.source.extension).length, audit.bundle.extensionFiles);
      for (const [file, bytes] of [["release-build.json", buildBytes], ["release-audit.json", auditBytes], ["release-manifest.json", manifestBytes]]) await fs.writeFile(path.join(runDir, file), bytes, { flag: "wx" });
      report.releaseEvidence = { build: { file: "release-build.json", sha256: hash(buildBytes) }, audit: { file: "release-audit.json", sha256: hash(auditBytes) }, manifest: { file: "release-manifest.json", sha256: hash(manifestBytes) } };
      const selected = await launch("git", ["ls-files", "--cached", "--others", "--exclude-standard", "--", "cmd", "internal", "apps/chrome-extension", "packages/open-browser-use-js", "packages/open-browser-use-python", "packages/open-browser-use-go", "scripts/browser-integration", "scripts/build-chrome-extension.mjs", ":(glob)scripts/patch-*.mjs", "go.mod", "go.sum", "pnpm-lock.yaml"], { timeoutMs: 15000 }).completed;
      assert.equal(selected.code, 0); const files = [...new Set(selected.stdout.trim().split(/\r?\n/))];
      const productionRuntime = file => /^(cmd\/|internal\/|apps\/chrome-extension\/)/.test(file) && !/\.test\.|_test\.go$/.test(file);
      assert.deepEqual(files.filter(productionRuntime).sort(), Object.keys(manifest.sourceInputs).filter(productionRuntime).sort(), "Current runtime file set differs from the package source");
      report.source.snapshot = {}; report.source.releaseSourceMatches = { exact: [], lineEndingOnly: [] };
      for (const file of files) {
        inside(repo, path.resolve(repo, file)); const bytes = await fs.readFile(path.join(repo, file)); report.source.snapshot[file] = hash(bytes);
        const destination = path.join(runDir, "source-snapshot", file); await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.writeFile(destination, bytes, { flag: "wx" });
        if (productionRuntime(file)) {
          if (manifest.sourceInputs[file] === hash(bytes)) report.source.releaseSourceMatches.exact.push(file);
          else {
            // Source checkout EOLs can differ; bind to the exact release Git blob
            // without claiming byte equality or accepting other transformations.
            const blob = await launch("git", ["show", `${manifest.sourceCommit}:${file}`], { timeoutMs: 10000, maximumBytes: 8 * 1024 * 1024 }).completed;
            assert.equal(blob.code, 0); assert.equal(bytes.toString("utf8").replaceAll("\r\n", "\n"), blob.stdout.replaceAll("\r\n", "\n"), `Released source differs: ${file}`);
            report.source.releaseSourceMatches.lineEndingOnly.push(file);
          }
        }
      }
      report.source.sdk = await treeHashes(path.join(repo, "packages/open-browser-use-js/dist"));
      const helperBytes = await fs.readFile(helperReport), helpers = JSON.parse(helperBytes);
      assert.equal(helpers.passed, true); assert.deepEqual(helpers.before, helpers.after);
      assert.equal(helpers.binaries.observer.sha256, report.source.observerBinary);
      assert.equal(helpers.binaries.goWorkflow.sha256, report.source.goHelperBinary);
      for (const [file, sha] of Object.entries(helpers.before)) assert.equal(report.source.snapshot[file], sha, `Helper input not frozen: ${file}`);
      await fs.writeFile(path.join(runDir, "helper-build.json"), helperBytes, { flag: "wx" });
      report.helperEvidence = { file: "helper-build.json", sha256: hash(helperBytes) };
      await fs.cp(path.join(repo, "packages/open-browser-use-js/dist"), path.join(runDir, "sdk-input"), { recursive: true });
      await fs.cp(extension, path.join(runDir, "extension-input"), { recursive: true });
      await listenFixture(server); report.fixtureURL = `http://127.0.0.1:${server.address().port}`;
    });
    await step("read-only-os-observer-and-formal-managed-start", async () => {
      osHandle = await fs.open(path.join(runDir, "windows-observation.jsonl"), "wx");
      observer = await startWindowsObservation({ executable: observerBinary, sampleMs: 50, onRecord(record) {
        const line = JSON.stringify(record) + "\n"; osWrites = osWrites.then(() => osHandle.write(line)).catch(error => { osWriteError ??= error; });
      } }); report.osReady = observer.ready;
      launcher = launch(executable, ["managed", "run", "--root", root, "--name", name, "--browser-path", chromium, "--extension-dir", extension, "--startup-timeout", "30s"]);
      const ready = await wait(() => { assert.ok(!launcher.record.closedAt && !launcher.record.exitedAt && !launcher.record.spawnError, "Original supervisor ended before ready"); return parseManagedReadyOutput(launcher.record.stdout); }, "formal managed run ready", 40000);
      assert.equal(ready.state, "ready"); info = ready.info; report.info = info; inside(root, info.runDir); assert.equal(info.name, name);
      const life = await lifecycle("ready"); assert.equal(life.state, "ready"); assert.deepEqual(life.info, info); assertManagedViewerBrowserCommand(life, chromium);
      assert.equal(life.binding.bound, true); assert.equal(life.binding.exclusive, true);
      assert.deepEqual(JSON.parse((await command(["managed", "status", "--root", root, "--name", name])).stdout).info, info);
      const groups = await rememberProcesses("ready"); assert.ok(groups[0].processes.some(row => row.ProcessId === info.nativePID));
      const privateEndpoint = await endpoint(info.profileDir, launcher);
      const response = await fetch(`http://127.0.0.1:${privateEndpoint.port}/json/list`, { signal: AbortSignal.timeout(10000) }); assert.equal(response.status, 200);
      const targets = (await response.json()).filter(row => row.type === "service_worker" && row.url === `chrome-extension://${info.extensionId}/background.js`); assert.equal(targets.length, 1);
      report.workerTarget = { id: targets[0].id, url: targets[0].url }; report.workerConnection = {};
      worker = await connectNormalCDP(targets[0].webSocketDebuggerUrl, { record: report.workerConnection, handshakeTimeoutMs: 10000, authorizationRequired: false });
      report.creationObserver = await worker.evaluate(`(${installCreationObservation.toString()})(chrome,globalThis)`);
      report.downloadRoot = await resolveNormalDownloadRoot(info.profileDir);
      const startup = browserStartupOptions([`--user-data-dir=${viewerProfile}`, "--headless=new", "--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "about:blank"], process.env.OBU_TEST_FIELD_TRIAL_CONFIG);
      report.viewerStartup = startup; viewerProcess = launch(chromium, startup.args);
      viewerBrowser = await playwrightChromium.connectOverCDP((await endpoint(viewerProfile, viewerProcess)).url);
      const context = await bound(viewerBrowser.newContext({ viewport: { width: 1280, height: 1000 } }), 10000, "original viewer context"); page = await bound(context.newPage(), 10000, "original viewer page");
      viewer = await observeManagedWorkflowViewer({ page, url: ready.viewerURL, directory: runDir, detail: report.viewer });
      await rememberProcesses("both-browsers-ready");
    });
    for (const kind of ["js", "python", "go", "cli", "mcp"]) await step(`original-${kind}-workflow`, async () => {
      const taskId = `${kind}-${randomUUID().slice(0, 8)}`, specification = fixture.createTask({ taskId, caller: kind });
      const detail = { kind, taskId }, proof = { specification, reads: [], callerStages: [] }; report.attempts.push({ detail, proof });
      await runManagedWorkflowCaller({ kind, baseURL: report.fixtureURL, taskId, socketPath: info.socketPath, root, name, binary: executable, artifactDir: runDir,
        sdkJSPath: path.join(runDir, "sdk-input/index.js"), python, pythonPackageDir: path.join(repo, "packages/open-browser-use-python"), goHelperBinary,
        downloadRoot: report.downloadRoot.directory, timeoutMs: 180000, detail,
        async onStep(label, { step: receipt }) {
          proof.callerStages.push({ label, at: Date.now() }); viewer.check();
          if (label === "source-navigated") {
            proof.sourceBefore = await readDocument(detail.sourceTabId); assert.equal(proof.sourceBefore.url, report.fixtureURL + specification.sourcePath);
            proof.observerRegistration = await worker.evaluate(`__managedWorkflowObservation.register(${detail.sourceTabId})`);
          } else if (label === "child-created") {
            proof.sourceAfter = await readDocument(detail.sourceTabId); assert.equal(proof.sourceAfter.documentId, proof.sourceBefore.documentId);
            assert.equal(proof.sourceAfter.state.opened, true); assert.deepEqual(proof.sourceAfter.state.clicks, [{ trusted: true, button: 0, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false }]);
            proof.created = await worker.evaluate("__managedWorkflowObservation.snapshot()"); assert.equal(proof.created.overflow, false);
            const events = proof.created.events.filter(row => row.sourceTabId === detail.sourceTabId); assert.equal(events.length, 1); assert.equal(events[0].tabId, detail.resultTabId); assert.equal(events[0].url, report.fixtureURL + specification.childPath);
          } else if (label === "snapshot") {
            proof.childBefore = await readDocument(detail.resultTabId); assert.equal(proof.childBefore.url, report.fixtureURL + specification.childPath); assert.deepEqual(proof.childBefore.instructions, specification.expected);
            proof.originalTarget = await targetFor(detail.resultTabId); assert.equal(proof.originalTarget.length, 1);
            await viewer.select(detail.resultTabId, "task"); await viewer.capture({ tabId: detail.resultTabId, kind: "task", label: `${kind}-initial` });
          } else if (label === "fill-note") {
            await viewer.capture({ tabId: detail.resultTabId, kind: "task", label: `${kind}-filled`, after: receipt.startedAt });
          } else if (label === "receipt") {
            const read = await readDocument(detail.resultTabId); proof.reads.push({ label, at: Date.now(), read });
            assert.equal(read.documentId, proof.childBefore.documentId); assert.equal(read.state.documentToken, proof.childBefore.state.documentToken); assert.equal(read.state.error, null);
            assert.deepEqual(read.state.submits, [{ trusted: true, submitter: "submit-task" }]); assert.deepEqual(read.receipt, detail.receipt);
            assert.ok(read.state.inputs.length > 0 && read.state.inputs.every(event => event.trusted));
            for (const field of ["reference", "amount", "note"]) assert.equal(read.state.inputs.findLast(event => event.name === field)?.value, specification.expected[field]);
            await viewer.capture({ tabId: detail.resultTabId, kind: "task", label: `${kind}-receipt`, after: detail.trace.find(row => row.name === "submit-clicked").startedAt });
          } else if (label === "download-file") {
            proof.file = await verifyOriginalFile(detail);
          } else if (label === "finalize") {
            const read = await readDocument(detail.resultTabId); proof.reads.push({ label, at: Date.now(), read });
            assert.equal(read.documentId, proof.childBefore.documentId); assert.equal(read.state.documentToken, proof.childBefore.state.documentToken); assert.deepEqual(read.receipt, detail.receipt);
            assert.deepEqual(read.state.downloads, [{ trusted: true, button: 0 }]);
            const targets = await targetFor(detail.resultTabId); proof.finalTargets = targets; assert.equal(targets.length, 1); assert.equal(targets[0].id, proof.originalTarget[0].id); assert.equal(targets[0].attached, false);
            proof.sourceClosed = await worker.evaluate(`chrome.tabs.query({}).then(rows=>({present:rows.some(row=>row.id===${detail.sourceTabId})}))`); assert.equal(proof.sourceClosed.present, false);
            proof.resultEntry = await viewer.select(detail.resultTabId, "result");
            await viewer.capture({ tabId: detail.resultTabId, kind: "result", label: `${kind}-delivered` }); await viewer.deselect();
          }
        }
      });
      proof.verified = fixture.verifyTask(detail); await rememberProcesses(`after-${kind}`);
    });
    await step("all-five-original-results-and-final-viewer-delivery", async () => {
      const current = await viewer.refresh(), ids = report.attempts.map(row => row.detail.resultTabId);
      assert.equal(ids.length, 5); assert.equal(new Set(ids).size, 5); assert.deepEqual(current.tabs.map(row => row.id).sort(), [...ids].sort()); assert.ok(current.tabs.every(row => row.kind === "result"));
      report.finalResults = [];
      for (const { detail, proof } of report.attempts) {
        const document = await readDocument(detail.resultTabId); assert.equal(document.documentId, proof.childBefore.documentId); assert.deepEqual(document.receipt, detail.receipt);
        assert.equal(document.state.submits.length, 1); assert.equal(document.state.downloads.length, 1);
        const entry = await viewer.select(detail.resultTabId, "result"); assert.equal(entry.deliveryId, proof.resultEntry.deliveryId);
        const frame = await viewer.capture({ tabId: detail.resultTabId, kind: "result", label: `${detail.kind}-final` });
        report.finalResults.push({ entry, document, frameIndex: frame.frameIndex }); await viewer.deselect();
      }
      report.finalCreationObservation = await worker.evaluate("__managedWorkflowObservation.stop()"); assert.equal(report.finalCreationObservation.listenerPresent, false); assert.equal(report.finalCreationObservation.overflow, false);
      assert.equal(report.finalCreationObservation.events.length, 5);
      assert.equal(fixture.stats().requests.length, 20); assert.equal(fixture.stats().requests.filter(row => row.method === "POST").length, 5);
      assert.deepEqual(report.unexpectedRequests, []);
    });
    await step("formal-stop-and-original-file-cleanup", async () => {
      await worker.close(); worker = null;
      await stopOriginal();
      await removeOriginalFiles();
    });
  } catch (error) { report.error = error.stack ?? String(error); report.observerFailure = error.observation; console.error(redact(report.error)); }
  finally {
    if (worker) await cleanup("workerObserver", async () => { await worker.close(); return { closed: true }; });
    if (launcher && !report.supervisorExit) await cleanup("stop", stopOriginal);
    if (launcher && !launcher.record.closedAt) await cleanup("supervisorFallback", async () => {
      try { await bound(launcher.completed, 10000, "original supervisor cleanup exit"); }
      catch (error) { launcher.terminate("managed-workflow-cleanup"); await bound(launcher.completed.catch(() => {}), 12000, "terminated original supervisor close"); throw error; }
      return { code: launcher.record.code, closedAt: launcher.record.closedAt };
    });
    if (launcher && !finalSaved) await cleanup("finalLifecycle", () => lifecycle("final"));
    if (report.supervisorExit && !report.fileCleanup) await cleanup("originalFiles", removeOriginalFiles);
    report.retainedOriginalFiles = report.attempts.filter(row => row.detail.productPath && !report.fileCleanup?.some(file => file.path === row.detail.productPath && file.removed)).map(row => ({ taskId: row.detail.taskId, path: row.detail.productPath }));
    if (viewerBrowser) await cleanup("viewerBrowser", async () => {
      const session = await bound(viewerBrowser.newBrowserCDPSession(), 5000, "original viewer close session"); await bound(session.send("Browser.close"), 5000, "original viewer close command");
      const result = await bound(viewerProcess.completed, 12000, "original viewer browser close"); assert.equal(result.code, 0); assert.equal(result.termination, undefined);
      await bound(viewerBrowser.close(), 5000, "original viewer client close"); return { code: result.code, exitedAt: result.exitedAt, closedAt: result.closedAt };
    });
    if (viewerProcess && !viewerProcess.record.closedAt) await cleanup("viewerFallback", async () => { viewerProcess.terminate("managed-workflow-viewer-cleanup"); await bound(viewerProcess.completed.catch(() => {}), 12000, "original viewer fallback close"); throw Error("Viewer needed forced termination"); });
    if (viewer) await cleanup("viewerEvidence", () => viewer.settle());
    if (info) await cleanup("privateResources", verifyResources);
    if (report.processObservations.length) await cleanup("originalProcesses", async () => {
      const originals = [...new Map(report.processObservations.flatMap(row => row.groups).flatMap(row => row.processes).map(row => [`${row.ProcessId}/${row.CreationDate}`, row])).values()];
      report.originalProcesses = originals;
      return wait(async () => { const rows = await table(), remaining = originals.filter(before => rows.some(after => before.ProcessId === after.ProcessId && before.CreationDate === after.CreationDate)); report.lastProcessCheck = { at: Date.now(), originalIdentities: originals.length, remaining }; return !remaining.length && report.lastProcessCheck; }, "all observed original process identities ended");
    });
    if (observer) await cleanup("windowsObservation", async () => {
      const records = await observer.stop(), exit = await observer.closed; await osWrites; if (osWriteError) throw osWriteError;
      const sampled = records.filter(row => row.type === "ready" || row.type === "sample"), gaps = sampled.slice(1).map((row, index) => row.elapsedUs - sampled[index].elapsedUs);
      assert.ok(sampled.length > 2); const candidates = foregroundPIDMatches(records, [...new Set((report.originalProcesses ?? []).map(row => row.ProcessId))]);
      report.backgroundEvidence = { sampleMs: observer.ready.sampleMs, records: records.length, foregroundEvents: records.filter(row => row.type === "foreground").length, samples: sampled.length, maximumSampleGapUs: Math.max(...gaps), cursorSameAtAllSamples: sampled.every(row => row.cursor.x === sampled[0].cursor.x && row.cursor.y === sampled[0].cursor.y), originalProcessForegroundCandidates: candidates, observerExit: exit,
        conclusion: "Foreground events and sampled positions only. Changes outside recorded original browser processes are not attributed to the Agent or the user; cursor equality only covers observed samples." };
      assert.deepEqual(candidates, [], "An observed original browser process appeared in foreground; do not restore focus or erase the observation");
      return { complete: true, records: records.length, stopped: records.at(-1), exit };
    });
    if (observer) report.observerEvidence = observer.evidence;
    await cleanup("observationFile", async () => { await osWrites; if (osHandle) { await osHandle.sync(); await osHandle.close(); osHandle = null; } const bytes = await fs.readFile(path.join(runDir, "windows-observation.jsonl")); return { file: "windows-observation.jsonl", bytes: bytes.length, sha256: hash(bytes) }; });
    await cleanup("fixture", async () => { server.closeAllConnections(); if (server.listening) await bound(new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())), 5000, "original fixture server close"); return { closed: !server.listening }; });
    if (report.source?.snapshot) await cleanup("sourceIntegrity", async () => {
      for (const [file, expected] of Object.entries(report.source.snapshot)) assert.equal(hash(await fs.readFile(path.join(repo, file))), expected, `Source changed during acceptance: ${file}`);
      assert.deepEqual(await treeHashes(path.join(runDir, "source-snapshot")), report.source.snapshot);
      assert.equal(hash(await fs.readFile(executable)), report.source.executable); assert.equal(hash(await fs.readFile(chromium)), report.source.browser);
      assert.equal(hash(await fs.readFile(observerBinary)), report.source.observerBinary); assert.equal(hash(await fs.readFile(goHelperBinary)), report.source.goHelperBinary);
      assert.deepEqual(await treeHashes(extension), report.source.extension); assert.deepEqual(await treeHashes(path.join(runDir, "extension-input")), report.source.extension);
      assert.deepEqual(await treeHashes(path.join(repo, "packages/open-browser-use-js/dist")), report.source.sdk); assert.deepEqual(await treeHashes(path.join(runDir, "sdk-input")), report.source.sdk);
      return { unchanged: true, at: Date.now() };
    });
    report.fixture = fixture.stats(); report.liveRunnerChildren = [...registry].map(child => child.pid); report.endedAt = Date.now();
    report.passed = !report.error && report.steps.length === 9 && report.steps.every(row => row.passed) && report.cleanupErrors.length === 0 && !registry.size && report.cleanup.sourceIntegrity?.unchanged === true && report.cleanup.windowsObservation?.complete === true;
    await save(); console.log("RESULT", JSON.stringify({ runDir, passed: report.passed }));
  }
  return report;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  assert.equal(process.argv.length, 2, "No workflow retry or replay arguments");
  const result = await runManagedWorkflowCheck(); process.exitCode = result.passed ? 0 : 1;
}
