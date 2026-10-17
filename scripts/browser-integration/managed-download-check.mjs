// Original webpage downloads through the formal managed supervisor. No viewer
// browser, download-directory override, Native Port adapter, or input retry.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkManagedDownloads } from "./managed-download-proof.mjs";
import { createOriginalDownloadFixtures } from "./original-download-fixture.mjs";
import { createOriginalDownloadNegativeFixtures } from "./original-download-negative-fixture.mjs";
import { resolveNormalDownloadRoot, removeProvenNormalFile, verifyNormalBinding } from "./normal-browser-downloads-proof.mjs";
import { connectNormalCDP, managedProcess, runProcess, bound, poll } from "./normal-browser-downloads-support.mjs";
import { waitPrivateDevToolsEndpoint } from "./private-devtools-endpoint.mjs";
import { observedProcessDescendants } from "./observed-process-descendants.mjs";
import { assertManagedViewerTerminal } from "./managed-viewer-check.mjs";
import { listenFixture } from "./fixture-listener.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const redact = text => String(text).replace(/(#ticket=)[A-Za-z0-9_-]+/g, "$1[redacted]");
const serialize = value => JSON.stringify(value, (_key, item) => typeof item === "string" ? redact(item) : item, 2);
const workerIdentity = "({extensionId:chrome.runtime.id,version:chrome.runtime.getManifest().version,binding:globalThis.__obuNativeDownloadBinding})";
const processQuery = "@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,ExecutablePath,@{n='CreationDate';e={$_.CreationDate.ToUniversalTime().ToString('o')}}) | ConvertTo-Json -Compress";

// The CLI emits one pretty-printed JSON object, which can span stdout chunks.
// Read only a complete root object; native values never enter parser errors.
export function parseManagedReadyOutput(output) {
  assert.ok(typeof output === "string" && Buffer.byteLength(output) <= 2 * 1024 * 1024, "Invalid managed ready output size");
  const value = output.trimStart();
  if (!value) return null;
  assert.ok(value[0] === "{", "Managed ready output must start with an object");
  const stack = []; let quoted = false, escaped = false;
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') { quoted = true; continue; }
    if (char === "{" || char === "[") stack.push(char);
    else if (char === "}" || char === "]") {
      assert.ok(stack.pop() === (char === "}" ? "{" : "["), "Invalid managed ready structure");
      if (!stack.length) {
        assert.ok(value.slice(index + 1).trim() === "", "Unexpected trailing managed ready output");
        try { return JSON.parse(value.slice(0, index + 1)); }
        catch { throw new Error("Invalid complete managed ready JSON"); }
      }
    }
  }
  return null;
}

// The CLI acknowledges the same original run only after its supervisor has
// finished shutdown. A generic success flag or another run is not that receipt.
export function assertManagedStopReply(value, originalRunId) {
  assert.match(originalRunId ?? "", /^[0-9a-f]{32}$/, "Original managed run identity is required for Stop evidence");
  assert.deepEqual(value, { runId: originalRunId, state: "stopped" }, "Managed Stop must confirm the exact original run and stopped state");
  return value;
}

const resourceQuery = String.raw`
$ErrorActionPreference='Stop'
$scope=$env:OBU_DOWNLOAD_RESOURCE_PROBE | ConvertFrom-Json
$keys=@()
foreach($view in @([Microsoft.Win32.RegistryView]::Registry32,[Microsoft.Win32.RegistryView]::Registry64)) {
  $base=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser,$view)
  $key=$null
  try {
    $key=$base.OpenSubKey(('Software\Google\Chrome\NativeMessagingHosts\'+$scope.host),$false)
    $keys+=@{view=$view.ToString();absent=($null -eq $key)}
  } finally {if($null -ne $key){$key.Close()};$base.Close()}
}
$present=@([IO.Directory]::GetFiles('\\.\pipe\') | Where-Object {$scope.pipes -contains $_})
@{registration=$keys;presentOriginalPipes=$present} | ConvertTo-Json -Compress -Depth 5
`;

function inside(root, file) {
  const relative = path.relative(root, file);
  assert.ok(relative && !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`), "Expected an original private-run path");
  return relative.replaceAll("\\", "/");
}

async function treeHashes(root) {
  const entries = await fs.readdir(root, { recursive: true, withFileTypes: true });
  const files = entries.filter(entry => entry.isFile()).map(entry => path.join(entry.parentPath, entry.name)).sort();
  return Object.fromEntries(await Promise.all(files.map(async file => [path.relative(root, file).replaceAll("\\", "/"), hash(await fs.readFile(file))])));
}

export async function runManagedDownloadCheck() {
  assert.equal(process.platform, "win32");
  const executable = process.env.OBU_TEST_HOST_BINARY, chromium = process.env.OBU_TEST_CHROMIUM_BINARY, extension = process.env.OBU_TEST_EXTENSION_DIR;
  assert.ok(executable && chromium && extension, "Set explicit OBU_TEST_HOST_BINARY, OBU_TEST_CHROMIUM_BINARY, OBU_TEST_EXTENSION_DIR");
  for (const file of [executable, chromium, extension]) { assert.ok(path.isAbsolute(file)); await fs.access(file); }
  const validationFile = process.env.OBU_TEST_HOST_VALIDATION;
  await fs.mkdir(path.join(repo, ".tmp/browser-integration"), { recursive: true });
  const runDir = await fs.mkdtemp(path.join(repo, ".tmp/browser-integration/managed-download-"));
  const root = path.join(runDir, "owned-root"), name = "download-acceptance";
  const snapshot = path.join(runDir, "source-snapshot"), extensionInput = path.join(runDir, "extension-input"), sdkInput = path.join(runDir, "sdk-input");
  const report = { runDir, startedAt: Date.now(), commands: [], steps: [], probes: [], cleanup: {}, cleanupErrors: [], business: {},
    scope: "Eight original downloads via formal managed run/status/stop and the production JS SDK: six root/OOPIF/dynamic-OOPIF POST/Blob transfers, one actual native cancel, and one waiter cancellation followed by completion of its original held response. Read-only exact-worker observation, default download behavior, no viewer browser, preferences mutation, input replay, account access or OS input.",
    limits: "CIM inventory is supplemental, non-atomic PID plus original CreationDate evidence. Original Go process handles, Browser.close/exit/native EOF/Job receipts remain authoritative; original lifecycle JSON bytes preserve uint64 values. File deletion revalidates the original identity and bytes but is not an atomic guarantee against concurrent filesystem mutation." };
  const save = () => fs.writeFile(path.join(runDir, "results.json"), serialize(report));
  const registry = new Set(), fixture = createOriginalDownloadFixtures(), heldFixture = createOriginalDownloadNegativeFixtures();
  let fixtureURL, launcher, info, worker, owner, foreign, stopPromise, finalLifecycleSaved = false;
  const server = createServer((request, response) => {
    if (!fixture.handle(request, response, fixtureURL) && !heldFixture.handle(request, response)) { request.resume(); response.writeHead(404); response.end("NOT_FOUND"); }
  });
  const launch = (program, args, options = {}) => {
    const record = {}; report.commands.push(record);
    return managedProcess(program, args, { cwd: repo, registry, record, maximumBytes: 2 * 1024 * 1024, ...options });
  };
  async function command(args, expected = 0) {
    const child = launch(executable, args, { timeoutMs: args[1] === "stop" ? 55000 : 45000 });
    const result = await child.completed; assert.equal(result.code, expected, redact(result.stderr)); return result;
  }
  async function probe(label, script, env) {
    const record = { label }; report.probes.push(record);
    try {
      await runProcess("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { cwd: repo, env, registry, record, timeoutMs: 15000, maximumBytes: 2 * 1024 * 1024 });
      return JSON.parse(record.stdout.replace(/^\uFEFF/, "").trim());
    } finally {
      // Process inventory outside this run is not retained; original rows are
      // selected below. Keep the real probe status and raw-output digest.
      if (typeof record.stdout === "string") record.stdout = { bytes: Buffer.byteLength(record.stdout), sha256: hash(record.stdout) };
    }
  }
  const processTable = () => probe("read-only original process identity observation", processQuery);
  const until = (read, label, timeoutMs = 15000) => poll(read, { timeoutMs, intervalMs: 50, label });
  async function step(label, operation) {
    const row = { name: label, startedAt: Date.now() }; report.steps.push(row); console.log("STEP", label);
    try { await operation(); row.passed = true; }
    catch (error) { row.passed = false; row.error = error.stack ?? String(error); report.firstFailure ??= { step: label, at: Date.now(), error: row.error }; throw error; }
    finally { row.endedAt = Date.now(); await save(); }
  }
  async function cleanup(label, operation) {
    try { report.cleanup[label] = await operation(); }
    catch (error) { report.cleanupErrors.push({ label, at: Date.now(), error: error.stack ?? String(error) }); }
  }
  async function lifecycle(label) {
    let directory = info?.runDir;
    if (!directory) {
      // One original launch in a fresh owned root: retain its startup-failure
      // record too. Never search another profile or infer a process owner here.
      const runs = path.join(root, name, "runs"), entries = await fs.readdir(runs, { withFileTypes: true });
      assert.equal(entries.length, 1, "Startup lifecycle origin is ambiguous");
      assert.ok(entries[0].isDirectory() && !entries[0].isSymbolicLink() && /^[0-9a-f]{32}$/.test(entries[0].name));
      directory = path.join(runs, entries[0].name);
    }
    const file = path.join(directory, "lifecycle.json"); inside(root, file);
    const bytes = await fs.readFile(file); assert.ok(bytes.length <= 1024 * 1024);
    const copy = `lifecycle-${label}.json`; await fs.writeFile(path.join(runDir, copy), bytes);
    const source = { file: inside(runDir, file), copy, bytes: bytes.length, sha256: hash(bytes),
      nativeCreationTimeDecimal: /"nativeCreationTime"\s*:\s*(\d+)/.exec(bytes.toString())?.[1] ?? null };
    const value = JSON.parse(bytes);
    if (label === "final") { report.lifecycleSource = source; report.lifecycle = value; finalLifecycleSaved = true; }
    else { report.readyLifecycleSource = source; report.readyLifecycle = value; }
    return value;
  }
  async function binding() {
    const identity = await worker.evaluate(workerIdentity, 10000);
    const infos = [await owner.client.getInfo(), await foreign.client.getInfo()];
    verifyNormalBinding(report.readyLifecycle.binding, identity, infos);
    assert.equal(identity.extensionId, info.extensionId);
    assert.equal(report.readyLifecycle.binding.extensionInstanceId, info.extensionInstanceId);
    return { identity, infos, checkedAt: Date.now() };
  }
  async function processExitProof() {
    const originals = [...new Map([...(report.originalProcesses ?? []), ...(report.preCloseProcesses ?? [])].map(row => [`${row.ProcessId}/${row.CreationDate}`, row])).values()];
    assert.ok(originals.length, "No original process identities were captured");
    return until(async () => {
      const table = await processTable();
      const remaining = originals.filter(before => table.some(after => before.ProcessId === after.ProcessId && before.CreationDate === after.CreationDate));
      report.lastProcessObservation = { at: Date.now(), originals: originals.length, remaining };
      return !remaining.length && report.lastProcessObservation;
    }, "original managed process identities gone", 15000);
  }
  async function resourceExitProof() {
    assert.match(info.nativeHostName, /^com\.openbrowseruse\.managed\.n[0-9a-f]{32}$/);
    assert.ok(info.socketPath.startsWith("\\\\.\\pipe\\open-browser-use-"));
    const controlPipe = "\\\\.\\pipe\\open-browser-use-managed-" + hash(path.resolve(root).toLowerCase() + "\0" + name).slice(0, 40);
    const value = await probe("read-only exact managed registration and endpoint absence", resourceQuery,
      { ...process.env, OBU_DOWNLOAD_RESOURCE_PROBE: JSON.stringify({ host: info.nativeHostName, pipes: [info.socketPath, controlPipe] }) });
    assert.deepEqual(value.registration.map(row => row.view).sort(), ["Registry32", "Registry64"]);
    assert.ok(value.registration.every(row => row.absent === true)); assert.deepEqual(value.presentOriginalPipes, []);
    const endpointDir = path.join(info.runDir, "temp", "open-browser-use");
    const entries = await fs.readdir(endpointDir); assert.deepEqual(entries, []);
    return { ...value, checkedAt: Date.now(), nativeHostName: info.nativeHostName, pipes: [info.socketPath, controlPipe], endpointDir, entries };
  }
  function stopOriginal() {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      if (info && !launcher.record.closedAt) {
        // Inventory is supplemental evidence, never a prerequisite for sending
        // the original supervisor Stop or authority to adopt a reused PID.
        try {
          const table = await processTable(), original = report.originalProcesses?.find(row => row.ProcessId === info.browserPID);
          assert.ok(original && table.some(row => row.ProcessId === original.ProcessId && row.CreationDate === original.CreationDate && row.ExecutablePath === original.ExecutablePath), "Original browser incarnation is no longer observable before Stop");
          report.preCloseProcesses = observedProcessDescendants(table, info.browserPID);
        } catch (error) { report.cleanupErrors.push({ label: "pre-close process inventory", at: Date.now(), error: error.stack ?? String(error) }); }
      }
      const result = await command(["managed", "stop", "--root", root, "--name", name]);
      report.stop = { at: Date.now(), result: JSON.parse(result.stdout) }; assertManagedStopReply(report.stop.result, info?.runId);
      const terminal = await bound(launcher.completed, 10000, "original managed supervisor actual exit and close");
      assert.equal(terminal.code, 0, redact(terminal.stderr)); assert.equal(terminal.termination, undefined); assert.ok(terminal.exitedAt && terminal.closedAt);
      report.supervisorExit = { code: terminal.code, exitedAt: terminal.exitedAt, closedAt: terminal.closedAt };
      const value = await lifecycle("final"); assertManagedViewerTerminal(value, info);
      assert.deepEqual(value.binding, report.readyLifecycle.binding);
      report.processesGone = await processExitProof(); report.resourcesGone = await resourceExitProof();
      const status = await command(["managed", "status", "--root", root, "--name", name], 1);
      assert.match(status.stderr, /has no reachable supervisor/); report.statusAfterStop = { code: status.code, checkedAt: Date.now() };
      return { confirmed: true, at: Date.now() };
    })();
    return stopPromise;
  }

  try {
    await step("freeze-original-inputs-and-verified-host-provenance", async () => {
      report.source = { executable: hash(await fs.readFile(executable)), browser: hash(await fs.readFile(chromium)), extension: await treeHashes(extension), sdk: await treeHashes(path.join(repo, "packages/open-browser-use-js/dist")) };
      if (validationFile) {
        const validationBytes = await fs.readFile(validationFile), validation = JSON.parse(validationBytes);
        assert.equal(validation.passed, true); assert.equal(validation.sourceUnchanged, true); assert.deepEqual(validation.before, validation.after);
        for (const phase of ["test", "vet", "build", "buildInfo"]) assert.equal(validation[phase].exitCode, 0, `Original host ${phase} did not pass`);
        assert.equal(validation.executableSHA256, report.source.executable, "Supplied host is not the original verified build");
        assert.ok(Object.keys(validation.before).length > 0);
        for (const [relative, expected] of Object.entries(validation.before)) { inside(repo, path.resolve(repo, relative)); assert.equal(hash(await fs.readFile(path.join(repo, relative))), expected, `Verified host source changed: ${relative}`); }
        await fs.writeFile(path.join(runDir, "host-build-validation.json"), validationBytes);
        report.hostBuild = { mode: "reused verified build, not rebuilt by this runner", validationFile, copy: "host-build-validation.json", validationSHA256: hash(validationBytes), executableSHA256: validation.executableSHA256, originalStartedAt: validation.startedAt, originalEndedAt: validation.endedAt, currentSourceFilesMatched: Object.keys(validation.before).length };
      } else report.hostBuild = { mode: "caller supplied binary; source/build provenance unverified", executableSHA256: report.source.executable };
      const git = launch("git", ["rev-parse", "HEAD"], { timeoutMs: 10000 }); const gitResult = await git.completed; assert.equal(gitResult.code, 0); report.source.head = gitResult.stdout.trim();
      if (process.env.OBU_TEST_SOURCE_BINDING_REPORT) {
        const file = process.env.OBU_TEST_SOURCE_BINDING_REPORT, bytes = await fs.readFile(file), value = JSON.parse(bytes);
        assert.equal(value.passed, true); assert.equal(value.currentHead, report.source.head); assert.equal(value.executableSHA256, report.source.executable);
        if (value.browserSHA256) assert.equal(value.browserSHA256, report.source.browser);
        await fs.writeFile(path.join(runDir, "source-binding-report.json"), bytes);
        report.sourceBinding = { file, copy: "source-binding-report.json", bytes: bytes.length, sha256: hash(bytes), value };
      }
      const builder = await fs.readFile(path.join(repo, "scripts/build-chrome-extension.mjs"), "utf8");
      const declaration = builder.match(/const productionFiles\s*=\s*(\[[\s\S]*?\]);/); assert.ok(declaration);
      const productionFiles = JSON.parse(declaration[1]); assert.equal(new Set(productionFiles).size, productionFiles.length);
      assert.ok(productionFiles.includes("background.js") && productionFiles.includes("native-page-downloads.js"));
      report.source.productionExtensionInputs = {};
      for (const file of productionFiles) {
        const expected = hash(await fs.readFile(path.join(repo, "apps/chrome-extension", file)));
        assert.equal(report.source.extension[file], expected, `Extension differs from current production source: ${file}`); report.source.productionExtensionInputs[file] = expected;
      }
      const sourceNames = (await fs.readdir(path.join(repo, "apps/chrome-extension"))).filter(file => /\.(js|json|html|css)$/.test(file) && !file.includes(".test."));
      const extensionSources = [...new Set([...sourceNames, ...productionFiles])].map(file => `apps/chrome-extension/${file}`);
      const builderSources = (await fs.readdir(path.join(repo, "scripts"))).filter(file => /^patch-.*\.mjs$/.test(file) && !file.includes(".test.")).map(file => `scripts/${file}`);
      const integrationSources = (await fs.readdir(path.join(repo, "scripts/browser-integration"))).filter(file => file.endsWith(".mjs") || ["package.json", "package-lock.json"].includes(file)).map(file => `scripts/browser-integration/${file}`);
      for (const source of ["cmd/open-browser-use", "internal", "packages/open-browser-use-go", "go.mod", "go.sum", "scripts/build-chrome-extension.mjs", ...builderSources, ...extensionSources, ...integrationSources]) {
        const destination = path.join(snapshot, source); await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.cp(path.join(repo, source), destination, { recursive: true });
      }
      report.source.snapshot = await treeHashes(snapshot);
      await fs.cp(extension, extensionInput, { recursive: true }); await fs.cp(path.join(repo, "packages/open-browser-use-js/dist"), sdkInput, { recursive: true });
      assert.deepEqual(await treeHashes(extensionInput), report.source.extension); assert.deepEqual(await treeHashes(sdkInput), report.source.sdk);
      await listenFixture(server); fixtureURL = `http://127.0.0.1:${server.address().port}`; report.fixtureURL = fixtureURL;
    });

    await step("production-managed-run-status-and-original-binding", async () => {
      launcher = launch(executable, ["managed", "run", "--root", root, "--name", name, "--browser-path", chromium, "--extension-dir", extensionInput, "--startup-timeout", "30s"], { timeoutMs: 8 * 60 * 1000 });
      const ready = await until(() => {
        if (launcher.record.exitedAt !== undefined || launcher.record.closedAt !== undefined || launcher.record.spawnError) throw new Error(`Original managed startup exited: ${redact(launcher.record.stderr)}`);
        return parseManagedReadyOutput(launcher.record.stdout);
      }, "original managed ready", 40000);
      assert.equal(ready.state, "ready"); info = ready.info; report.info = info; inside(root, info.runDir);
      assert.equal(info.name, name); assert.match(info.runId, /^[0-9a-f]{32}$/); assert.equal(info.profileDir, path.join(root, name, "profile"));
      assert.ok(info.browserPID > 0 && info.nativePID > 0); assert.equal(info.mode, undefined);
      const rows = observedProcessDescendants(await processTable(), info.browserPID); report.originalProcesses = rows;
      const browser = rows.find(row => row.ProcessId === info.browserPID), native = rows.find(row => row.ProcessId === info.nativePID);
      assert.ok(browser && native); assert.equal(path.resolve(browser.ExecutablePath).toLowerCase(), path.resolve(chromium).toLowerCase());
      assert.equal(path.resolve(native.ExecutablePath).toLowerCase(), path.join(info.runDir, "native-host.exe").toLowerCase());
      assert.equal(hash(await fs.readFile(native.ExecutablePath)), report.source.executable);
      const status = JSON.parse((await command(["managed", "status", "--root", root, "--name", name])).stdout); assert.deepEqual(status.info, info); report.status = status;
      await lifecycle("ready"); assert.equal(report.readyLifecycle.state, "ready"); assert.deepEqual(report.readyLifecycle.info, info);
      const endpoint = await waitPrivateDevToolsEndpoint(info.profileDir, { assertAlive() { if (launcher.record.exitedAt !== undefined || launcher.record.closedAt !== undefined || launcher.record.spawnError) throw new Error("Original owner ended before DevTools publication"); } });
      const response = await fetch(`http://127.0.0.1:${endpoint.port}/json/list`, { signal: AbortSignal.timeout(10000) }); assert.equal(response.status, 200);
      const targets = await response.json(), workers = targets.filter(value => value.type === "service_worker" && value.url === `chrome-extension://${info.extensionId}/background.js`);
      assert.equal(workers.length, 1, "Only the exact original extension worker may be observed");
      report.workerTarget = workers[0]; report.observerConnection = {};
      worker = await connectNormalCDP(workers[0].webSocketDebuggerUrl, { record: report.observerConnection, handshakeTimeoutMs: 10000, authorizationRequired: false });
      const { connectOpenBrowserUse } = await import(pathToFileURL(path.join(sdkInput, "index.js")));
      owner = await connectOpenBrowserUse({ socketPath: info.socketPath, sessionId: "managed-download-owner", turnId: "original-downloads", timeoutMs: 10000 });
      foreign = await connectOpenBrowserUse({ socketPath: info.socketPath, sessionId: "managed-download-foreign", turnId: "original-foreign", timeoutMs: 10000 });
      report.bindingBefore = await binding(); report.downloadRoot = await resolveNormalDownloadRoot(info.profileDir);
    });

    await step("eight-original-downloads-and-two-distinct-cancellation-semantics", async () => {
      // Allocate before the original call: a failure keeps its exact partial
      // requests, paths, observer events and server state without a second run.
      await checkManagedDownloads({ owner, foreign, worker, fixture, heldFixture, fixtureURL, downloadRoot: report.downloadRoot.directory, until, detail: report.business });
      assert.equal(report.business.passed, true); assert.equal(report.business.cases.length, 8); assert.equal(report.business.files.length, 7); assert.deepEqual(report.business.cleanupErrors, []);
      report.bindingAfter = await binding(); assert.deepEqual(report.bindingAfter.identity, report.bindingBefore.identity);
    });

    await step("retire-original-turns-and-remove-only-seven-proved-files", async () => {
      report.turnEnded = { owner: await owner.client.turnEnded(), foreign: await foreign.client.turnEnded(), completedAt: Date.now() };
      const completed = report.business.cases.filter(item => item.file); assert.equal(completed.length, 7);
      report.fileCleanup = [];
      for (const item of completed) {
        assert.equal(item.passed, true); assert.equal(item.productPath, item.file.path);
        const row = { key: item.record.key, guid: item.guid, path: item.file.path, requestedAt: Date.now() }; report.fileCleanup.push(row);
        row.result = await removeProvenNormalFile(report.downloadRoot.directory, { productPath: item.file.path, file: item.file }, item.record); row.completedAt = Date.now();
      }
      assert.ok(report.fileCleanup.every(row => row.result.removed));
    });

    await step("real-stop-original-exit-job-empty-and-current-resource-absence", stopOriginal);
  } catch (error) {
    report.error = error.stack ?? String(error); report.firstFailure ??= { at: Date.now(), error: report.error };
    if (error.managedDownloadDetail) assert.equal(error.managedDownloadDetail, report.business);
    console.error(redact(report.error));
  } finally {
    // Snapshot before any runner teardown. No outstanding held response is
    // released or destroyed to manufacture a public cancellation receipt.
    report.fixtureBeforeRunnerCleanup = fixture.allStats(); report.heldFixtureBeforeRunnerCleanup = heldFixture.allStats();
    if (worker) await cleanup("observerTransport", async () => { await worker.close(); return { closed: true, at: Date.now() }; });
    for (const [label, client] of [["ownerTransport", owner], ["foreignTransport", foreign]]) if (client) await cleanup(label, async () => { client.close(); return { closeRequested: true, at: Date.now() }; });
    if (launcher && !report.supervisorExit) await cleanup("stop", stopOriginal);
    if (launcher && !launcher.record.closedAt) await cleanup("supervisorFallback", async () => {
      try { await bound(launcher.completed, 10000, "original supervisor cleanup close"); }
      catch (error) {
        launcher.terminate("managed-download-acceptance-cleanup");
        try { await bound(launcher.completed, 12000, "original supervisor forced close"); }
        catch (failure) { throw new AggregateError([error, failure], "Original cleanup did not complete normally; only the original spawned supervisor handle was terminated"); }
        throw error;
      }
      return { closedAt: launcher.record.closedAt, code: launcher.record.code };
    });
    if (launcher && !finalLifecycleSaved) await cleanup("retainedLifecycle", async () => { await lifecycle("final"); return report.lifecycleSource; });
    if (info && report.originalProcesses && !report.processesGone) await cleanup("processObservation", async () => { report.processesGone = await processExitProof(); return report.processesGone; });
    if (info && !report.resourcesGone) await cleanup("resourceObservation", async () => { report.resourcesGone = await resourceExitProof(); return report.resourcesGone; });
    await cleanup("fixtures", async () => {
      const at = Date.now(), pending = heldFixture.close(); server.closeAllConnections();
      if (server.listening) await bound(new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())), 5000, "original fixture server close");
      return { at, pendingClosedByRunner: pending, closed: !server.listening };
    });
    if (report.source?.snapshot) await cleanup("sourceIntegrity", async () => {
      assert.equal(hash(await fs.readFile(executable)), report.source.executable); assert.equal(hash(await fs.readFile(chromium)), report.source.browser);
      assert.deepEqual(await treeHashes(extension), report.source.extension); assert.deepEqual(await treeHashes(extensionInput), report.source.extension);
      assert.deepEqual(await treeHashes(path.join(repo, "packages/open-browser-use-js/dist")), report.source.sdk); assert.deepEqual(await treeHashes(sdkInput), report.source.sdk);
      assert.deepEqual(await treeHashes(snapshot), report.source.snapshot);
      for (const [relative, expected] of Object.entries(report.source.snapshot)) assert.equal(hash(await fs.readFile(path.join(repo, relative))), expected, `Source changed during acceptance: ${relative}`);
      if (validationFile) assert.equal(hash(await fs.readFile(validationFile)), report.hostBuild.validationSHA256);
      if (report.sourceBinding) assert.equal(hash(await fs.readFile(report.sourceBinding.file)), report.sourceBinding.sha256);
      return { unchanged: true, at: Date.now() };
    });
    report.fixture = fixture.allStats(); report.heldFixture = heldFixture.allStats();
    report.knownFiles = (report.business.cases ?? []).filter(item => item.productPath || item.file?.path).map(item => ({ key: item.record.key, guid: item.guid, path: item.productPath ?? item.file.path,
      removed: report.fileCleanup?.some(row => row.path === (item.productPath ?? item.file.path) && row.result?.removed === true) ?? false }));
    report.liveRunnerChildren = [...registry].map(child => child.pid); report.endedAt = Date.now();
    report.passed = !report.error && report.steps.length === 5 && report.steps.every(row => row.passed) && report.cleanupErrors.length === 0 && !registry.size && report.supervisorExit?.code === 0 && report.cleanup.sourceIntegrity?.unchanged === true;
    await save(); console.log("RESULT", JSON.stringify({ runDir, passed: report.passed }));
  }
  return report;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  assert.equal(process.argv.length, 2, "This acceptance has no business replay or mode arguments");
  const report = await runManagedDownloadCheck(); process.exitCode = report.passed ? 0 : 1;
}
