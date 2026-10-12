// Opt-in Windows fixture. Importing this module has no process/UI side effects.
// Bootstrap is explicitly disposable; only the second ordinary launch is task
// evidence. Authorization always belongs to the human at that private window.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildChromeExtension } from "../build-chrome-extension.mjs";
import { stageReloadObserver } from "./extension-reload-support.mjs";
import { assertNativeProcessIdentity, nativeRegistrationSource, nativeWatchSource, nativeTerminateSource } from "./native-lifecycle-support.mjs";
import { windowsPowerShellCommand, windowsCommandArguments } from "./native-browser-installation.mjs";
import { assertNormalProcess, assertNativeInfo, assertBindingAck, assertOriginalHostExit, normalRunOutcome, normalStartArguments, normalInspectURL,
  parsePrivateDevToolsPort, commandInbox, managedProcess, runProcess, connectNormalCDP, closePrivateBrowserSource,
  classifyPrivateProcesses, privateInventoryFailure, beginShutdownAttempt, waitPrivateProcessesGone, awaitTaskWithStop, normalBindBudgetMs, bound, poll, sleep,
  readPrivateProfileAccountState, assertPrivateProfileAccountState, assertFixtureExtensionInventory } from "./normal-browser-downloads-support.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const norm = value => path.win32.resolve(value).toLowerCase();
const errorValue = error => ({ message: error.message, stack: error.stack, ...(error.result && { result: error.result }) });
async function readIfPresent(file) { try { return await fs.readFile(file, "utf8"); } catch (error) { if (error.code === "ENOENT") return null; throw error; } }
async function hashes(root) {
  const result = {};
  async function walk(relative = "") { for (const entry of (await fs.readdir(path.join(root, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (["node_modules", ".git"].includes(entry.name)) continue;
    const next = path.join(relative, entry.name); assert.equal(entry.isSymbolicLink(), false, "Source/runtime hash tree cannot follow a symlink");
    if (entry.isDirectory()) await walk(next); else if (entry.isFile()) result[next.replaceAll(path.sep, "/")] = sha256(await fs.readFile(path.join(root, next)));
  } }
  await walk(); return result;
}
function inside(root, file) { const relative = path.relative(root, path.resolve(file)); return !!relative && !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`); }

/**
 * onBound receives only this exact private runtime. It must return
 * {verified:true,...evidence} after its business assertions, and honor signal.
 * Without a callback the runner stays awaiting-user after BOUND, never PASS.
 */
export async function runNormalBrowserDownloads({ browserBinary, hostBinary, outputRoot = path.join(repo, ".tmp/browser-integration"), onBound,
  input = process.stdin, output = process.stdout, env: parentEnv = process.env } = {}) {
  assert.equal(process.platform, "win32", "This real native-registration fixture requires Windows");
  assert.ok(path.isAbsolute(browserBinary ?? "") && path.isAbsolute(hostBinary ?? ""), "Explicit absolute browserBinary and hostBinary are required");
  assert.ok(onBound === undefined || typeof onBound === "function");
  outputRoot = path.resolve(outputRoot);
  assert.ok(inside(path.join(repo, ".tmp"), outputRoot) || outputRoot === path.join(repo, ".tmp"), "Runtime output must stay under this repository's .tmp");
  await fs.mkdir(outputRoot, { recursive: true });
  const runDir = await fs.mkdtemp(path.join(outputRoot, "normal-start-")), profile = path.join(runDir, "profile");
  const env = { ...parentEnv, TEMP: path.join(runDir, "temp"), TMP: path.join(runDir, "temp"), LOCALAPPDATA: path.join(runDir, "local"), APPDATA: path.join(runDir, "roaming"), USERPROFILE: path.join(runDir, "home"), HOME: path.join(runDir, "home") };
  for (const directory of new Set([profile, env.TEMP, env.LOCALAPPDATA, env.APPDATA, env.USERPROFILE])) await fs.mkdir(directory);
  const extension = path.join(runDir, "extension"), endpointFile = path.join(env.TEMP, "open-browser-use/active.json");
  const report = { version: 1, startedAt: Date.now(), status: "preparing", passed: false, runDir, profile,
    scope: "Explicit fixture bootstrap followed by normal Edge startup; no daily profile, remote startup flag, authorization automation, or download-path preference mutation",
    phase: "preparation", steps: [], commands: [], diagnostics: [], hostGenerations: [], cleanup: { complete: false, errors: [] },
    profileAccountIsolation: { version: 1, status: "unchecked", checks: [], scope: "Read-only checkpoints of account/sync-session metadata; cannot prevent OS implicit sign-in at browser startup or prove no changes between checks" } };
  const inbox = commandInbox(input, output), signal = inbox.signal, helpers = new Set(), clients = new Set(), diagnostics = new Set();
  let saveSequence = Promise.resolve(), extensionId, observer, nativeExecutable, endpoint, sdk, bootstrap, normal, bootstrapControl, registryAttempted = false, watchSequence = 0;
  const knownProcesses = new Map();
  const privateCLI = path.join(runDir, "open-browser-use.exe"), nativeName = `com.openbrowseruse.lifecycle.n${randomBytes(12).toString("hex")}`;
  const registryScript = path.join(runDir, "registry.ps1"), watchScript = path.join(runDir, "watch-process.ps1"), closeScript = path.join(runDir, "close-browser.ps1"), terminateScript = path.join(runDir, "terminate-process.ps1");
  function save(name, value) {
    assert.equal(path.basename(name), name); const bytes = JSON.stringify(value, null, 2) + "\n";
    const operation = saveSequence.then(() => fs.writeFile(path.join(runDir, name), bytes)); saveSequence = operation.catch(() => {}); return operation;
  }
  const checkpoint = () => { report.input = inbox.records; return save("results.json", report); };
  async function checkProfileAccounts(stage) {
    signal.throwIfAborted();
    const value = { stage, ...await readPrivateProfileAccountState(profile) };
    report.profileAccountIsolation.checks.push(value); report.profileAccountIsolation.status = value.status;
    await checkpoint(); signal.throwIfAborted(); return assertPrivateProfileAccountState(value);
  }
  async function step(phase, status, extra = {}) { Object.assign(report, { phase, status }); report.steps.push({ phase, status, at: Date.now(), ...extra }); await checkpoint(); }
  async function command(file, args, { cancel = true, timeoutMs = 30000, ...options } = {}) {
    const record = {}; report.commands.push(record);
    try { return await runProcess(file, args, { cwd: repo, env, registry: helpers, record, timeoutMs, ...(cancel && { signal }), ...options }); }
    finally { await checkpoint(); }
  }
  const powershell = async (source, options = {}) => (await command("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", windowsPowerShellCommand(source)], options)).stdout;
  const script = (file, args = [], options = {}) => powershell("$taskArguments=ConvertFrom-Json -InputObject $env:OBU_TEST_PS_ARGUMENTS; & $env:OBU_TEST_PS_SCRIPT @taskArguments", { ...options, env: { ...env, OBU_TEST_PS_SCRIPT: file, OBU_TEST_PS_ARGUMENTS: JSON.stringify(args) } });
  const processTable = async () => {
    // Global CIM rows are transient ancestry inputs. Do not serialize unrelated
    // applications' command lines into the command transcript.
    try {
      const command = await runProcess("powershell.exe", ["-NoProfile", "-Command", windowsPowerShellCommand("ConvertTo-Json -InputObject @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine,@{n='CreationDate';e={$_.CreationDate.ToUniversalTime().ToString('o')}}) -Compress")], { env, registry: helpers, timeoutMs: 15000 });
      const rows = JSON.parse(command.stdout);
      const selected = classifyPrivateProcesses(rows, { profile, browserBinary, nativeExecutable, extensionId, systemRoot: env.SystemRoot, roots: [bootstrap?.identity, normal?.identity].filter(Boolean), known: [...knownProcesses.values()] });
      for (const entry of [...selected.owned, ...selected.externalDescendants, ...selected.unknownDescendants]) {
        const row = entry.process; knownProcesses.set(`${row.ProcessId}:${row.CreationDate}:${row.ExecutablePath}`, { ...row, privateProcessRole: entry.role });
      }
      return rows;
    } catch (error) { throw privateInventoryFailure(error); }
  };
  async function connectCDP(url, options = {}) {
    const record = options.record ?? {}; report.diagnostics.push(record);
    const value = await connectNormalCDP(url, { ...options, authorizationRequired: report.phase !== "bootstrap", signal, record, persist: checkpoint, notify: text => output.write(text) }); diagnostics.add(value); return value;
  }
  async function descriptors() {
    const directory = path.dirname(endpointFile), result = [];
    for (const file of await fs.readdir(directory).catch(error => error.code === "ENOENT" ? [] : Promise.reject(error))) {
      if (!file.endsWith(".json")) continue;
      const source = await readIfPresent(path.join(directory, file)); if (source !== null) result.push({ file, value: JSON.parse(source) });
    }
    return result;
  }
  async function discoverHost(runtime, { timeoutMs = 15000, optional = false } = {}) {
    const deadline = Date.now() + timeoutMs;
    do {
      signal.throwIfAborted(); const source = await readIfPresent(endpointFile);
      if (source !== null) {
        const value = JSON.parse(source); assert.ok(typeof value.socketPath === "string" && value.socketPath.startsWith("\\\\.\\pipe\\"));
        assert.ok(typeof value.startedAt === "string" && Number.isFinite(Date.parse(value.startedAt)));
        const rows = await processTable(), identity = assertNativeProcessIdentity(value, rows, { executable: nativeExecutable, browserPid: runtime.identity.ProcessId });
        const browser = await sdk.connectOpenBrowserUse({ socketPath: value.socketPath, sessionId: "normal-start-identity", timeoutMs: 3000 });
        try {
          const info = assertNativeInfo(await browser.client.getInfo(), { extensionId, nativeName });
          const observed = { ...value, identity, info, observedAt: Date.now() }; report.hostGenerations.push(observed); endpoint = observed; await checkpoint(); return observed;
        } finally { browser.close(); }
      }
      if (Date.now() >= deadline) break;
      await sleep(200);
    } while (true);
    if (optional) return null;
    throw new Error("No browser-launched native host descriptor appeared in the isolated TEMP directory");
  }
  async function launch(phase, args) {
    const record = { args: [...args], hosts: [] }; report[phase] = record;
    record.runtimeIdentity = { browserSha256: sha256(await fs.readFile(browserBinary)), nativeHostSha256: sha256(await fs.readFile(nativeExecutable)), extension: await hashes(extension), sdk: await hashes(path.join(runDir, "js-sdk")) };
    assert.equal(record.runtimeIdentity.browserSha256, report.sourceIdentity.browser.sha256); assert.equal(record.runtimeIdentity.nativeHostSha256, report.sourceIdentity.host.sha256);
    assert.deepEqual(record.runtimeIdentity.extension, report.stagedExtensionHashes); assert.deepEqual(record.runtimeIdentity.sdk, report.sourceIdentity.sdk);
    // Browser stderr can contain synced extension/account identifiers before
    // the read-only profile guard can run. It is never needed for host parsing.
    const process = managedProcess(browserBinary, args, { env, cwd: repo, registry: helpers, record: record.launcher, captureOutput: false });
    // Browser lifecycle is not cancelled by stdin; exact-handle cleanup owns it.
    record.launcher = process.record;
    const runtime = { record, process, phase };
    if (phase === "bootstrap") bootstrap = runtime; else normal = runtime;
    runtime.identity = await poll(async () => {
      const rows = await processTable();
      const candidates = rows.filter(row => {
        if (!row.CommandLine || !row.ExecutablePath || norm(row.ExecutablePath) !== norm(browserBinary)) return false;
        const values = windowsCommandArguments(row.CommandLine);
        return values.includes(`--user-data-dir=${profile}`) && !values.some(value => value.startsWith("--type="));
      });
      assert.ok(candidates.length <= 1, "Ambiguous private browser root processes");
      if (candidates.length === 1) return candidates[0];
      if (process.record.closedAt) throw new Error("Browser launcher closed without a unique private browser process");
      return false;
    }, { timeoutMs: 15000, signal, label: `${phase} exact browser process` });
    assert.equal(runtime.identity.ProcessId, process.child.pid, "Unexpected browser launcher handoff; cannot infer actual close from another PID");
    record.identity = runtime.identity;
    if (phase === "normal") { assertNormalProcess(runtime.identity, { profile, executable: browserBinary, browserPid: process.child.pid }); record.commandVerified = true; }
    await checkpoint(); return runtime;
  }
  async function watch(row, label) {
    label += `-${++watchSequence}`;
    const identityName = `${label}-identity.json`, readyName = `${label}-watch-ready.json`;
    await save(identityName, row);
    const completed = script(watchScript, [path.join(runDir, identityName), path.join(runDir, readyName)], { timeoutMs: 50000, cancel: false }).then(value => ({ result: JSON.parse(value) }), error => ({ error: errorValue(error) }));
    const ready = await poll(async () => { const text = await readIfPresent(path.join(runDir, readyName)); return text && JSON.parse(text.replace(/^\uFEFF/, "")); }, { timeoutMs: 10000, label: "exact process watcher ready" });
    assert.equal(ready.pid, row.ProcessId); assert.equal(ready.exactHandle, true); return { ready, completed };
  }
  async function pipeAbsent(socketPath) {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(socketPath);
      const timer = setTimeout(() => { socket.destroy(); reject(new Error("Original native pipe probe timed out")); }, 2000);
      socket.once("connect", () => { clearTimeout(timer); socket.destroy(); resolve(false); });
      socket.once("error", error => { clearTimeout(timer); socket.destroy(); ["ENOENT", "ECONNREFUSED"].includes(error.code) ? resolve({ at: Date.now(), code: error.code }) : reject(error); });
    });
  }
  async function privateProcesses() {
    const rows = await processTable();
    return classifyPrivateProcesses(rows, { profile, browserBinary, nativeExecutable, extensionId, systemRoot: env.SystemRoot, roots: [bootstrap?.identity, normal?.identity].filter(Boolean), known: [...knownProcesses.values()] });
  }
  async function shutdown(runtime, { viaCDP } = {}) {
    if (!runtime || runtime.record.shutdown?.complete) return;
    const result = beginShutdownAttempt(runtime.record, viaCDP ? "Browser.close" : "exact retained handle CloseMainWindow");
    try {
    const currentRows = await processTable();
    if (!runtime.identity) {
      const candidate = currentRows.find(row => row.ProcessId === runtime.process.child.pid);
      if (candidate) {
        assert.equal(norm(candidate.ExecutablePath), norm(browserBinary));
        assert.ok(windowsCommandArguments(candidate.CommandLine).includes(`--user-data-dir=${profile}`));
        runtime.identity = candidate; runtime.record.cleanupRecoveredIdentity = candidate;
      }
    }
    const current = currentRows.find(row => row.ProcessId === runtime.identity?.ProcessId);
    if (current) {
      assert.equal(current.ExecutablePath, runtime.identity.ExecutablePath); assert.equal(current.CreationDate, runtime.identity.CreationDate);
      if (runtime.record.host) {
        const original = runtime.record.host.identity.process;
        const originalLive = currentRows.find(row => row.ProcessId === original.ProcessId);
        assert.ok(originalLive, "Original observed native host exited before its exact exit observer was installed");
        assert.equal(originalLive.ExecutablePath, original.ExecutablePath); assert.equal(originalLive.CreationDate, original.CreationDate, "Original native host PID was reused");
        assertNativeProcessIdentity({ pid: originalLive.ProcessId }, currentRows, { executable: nativeExecutable, browserPid: current.ProcessId });
        result.originalNativeHost = originalLive;
      }
      const browserWatch = await watch(current, `${runtime.phase}-browser`);
      const hosts = currentRows.filter(row => nativeExecutable && row.ExecutablePath && norm(row.ExecutablePath) === norm(nativeExecutable));
      const watches = [];
      for (const host of hosts) {
        assertNativeProcessIdentity({ pid: host.ProcessId }, currentRows, { executable: nativeExecutable, browserPid: current.ProcessId });
        watches.push({ process: host, watcher: await watch(host, `${runtime.phase}-host-${host.ProcessId}`) });
      }
      if (viaCDP) {
        result.closeSubmittedAt = Date.now();
        try { result.closeReply = await viaCDP.call("Browser.close", {}, 10000); } catch (error) { result.closeReplyError = error.message; }
      } else {
        const name = `${runtime.phase}-close-identity.json`; await save(name, current);
        result.windowClose = JSON.parse(await script(closeScript, [path.join(runDir, name)], { cancel: false, timeoutMs: 30000 }));
      }
      const close = await bound(runtime.process.completed, 20000, "actual browser launcher close");
      assert.ok(close.closedAt && close.exitedAt); result.actualClose = close;
      const observedBrowser = await browserWatch.completed;
      result.browserExit = { ready: browserWatch.ready, ...observedBrowser };
      assert.equal(observedBrowser.error, undefined, "Exact browser root exit was not observed");
      assert.equal(observedBrowser.result.exitCode, 0, "Exact browser root did not exit normally");
      result.hostExits = [];
      for (const value of watches) {
        const watched = await value.watcher.completed;
        result.hostExits.push({ process: value.process, ready: value.watcher.ready, ...watched });
        assert.equal(watched.error, undefined, "Original native host exit observer failed");
        assert.equal(watched.result.exitCode, 0, "Original native host did not exit normally");
      }
    } else {
      result.alreadyExited = true;
      result.actualClose = await bound(runtime.process.completed, 10000, "already-exited browser actual close");
      assert.equal(runtime.identity?.ProcessId, runtime.process.child.pid, "Cannot infer another root's exit from the launcher");
    }
    result.processInventory = {};
    result.processesAfter = await waitPrivateProcessesGone(privateProcesses, { record: result.processInventory, persist: checkpoint });
    result.descriptorsAfter = await poll(async () => { const values = await descriptors(); return values.length === 0 && values; }, { timeoutMs: 10000, label: "native EOF removes all private descriptors" });
    if (endpoint) result.pipeAfter = await poll(() => pipeAbsent(endpoint.socketPath), { timeoutMs: 5000, label: "original native pipe absent" });
    assert.equal(result.actualClose.code, 0, "Browser exited with a nonzero result");
    assert.notEqual(result.windowClose?.forced, true, "Forced shutdown is cleanup evidence, not normal completion");
    assert.equal(result.closeReplyError, undefined, "Bootstrap Browser.close did not acknowledge; actual exit alone is not the requested ACK");
    assertOriginalHostExit(runtime.record.host, result.hostExits);
    result.complete = true; result.completedAt = Date.now(); await checkpoint();
    } catch (error) { result.error = errorValue(error); result.failedAt = Date.now(); throw error; }
    finally { await checkpoint(); }
  }
  async function handoff(reason) {
    await checkProfileAccounts("pre-handoff");
    await step("normal-authorization", "awaiting-user", { reason });
    const value = { version: 1, status: "awaiting-user", reason, runDir, profile, browserPid: normal.identity.ProcessId, actualNormalCommand: normal.identity.CommandLine,
      inspectURL: normalInspectURL, extension: { id: extensionId, directory: extension }, observer,
      nativeHost: endpoint ? { pid: endpoint.pid, socketPath: endpoint.socketPath, verifiedAt: endpoint.observedAt } : null,
      instructions: reason === "manual-load"
        ? "In this private Edge window only, open edge://extensions, enable Developer mode manually and load the two listed unpacked directories if absent. Then open edge://inspect/#remote-debugging and enable remote debugging. Type bind in the runner and approve the connection prompt in this same window."
        : "In this private Edge window's edge://inspect/#remote-debugging page, enable remote debugging. Type bind in the runner and approve the connection prompt. Each later diagnostic connection can require another Allow. Type stop to cleanly end.",
      commands: ["bind", "stop"], permission: "Human checkbox and Allow; this runner does not operate authorization UI", taskVerified: false };
    await save("handoff.json", value); output.write(`HANDOFF ${JSON.stringify({ file: path.join(runDir, "handoff.json"), reason, profile, browserPid: normal.identity.ProcessId })}\n`);
  }
  try {
    output.write(`PREPARING ${JSON.stringify({ runDir, profile })}\n`);
    await fs.copyFile(hostBinary, privateCLI); await fs.cp(path.join(repo, "packages/open-browser-use-js/dist"), path.join(runDir, "js-sdk"), { recursive: true, errorOnExist: true });
    sdk = await import(pathToFileURL(path.join(runDir, "js-sdk/index.js")).href);
    const binaryIdentity = JSON.parse(await powershell("$taskFile=Get-Item -LiteralPath $env:OBU_NORMAL_BINARY; $taskSignature=Get-AuthenticodeSignature -LiteralPath $env:OBU_NORMAL_BINARY; @{path=$taskFile.FullName;productName=$taskFile.VersionInfo.ProductName;productVersion=$taskFile.VersionInfo.ProductVersion;fileVersion=$taskFile.VersionInfo.FileVersion;signatureStatus=$taskSignature.Status.ToString();signer=$taskSignature.SignerCertificate.Subject} | ConvertTo-Json -Compress", { env: { ...env, OBU_NORMAL_BINARY: browserBinary } }));
    assert.equal(binaryIdentity.signatureStatus, "Valid"); assert.match(binaryIdentity.productName, /Microsoft Edge/i); assert.match(binaryIdentity.signer, /Microsoft Corporation/i);
    report.sourceIdentity = { gitHead: (await command("git", ["rev-parse", "HEAD"])).stdout.trim(), gitStatus: (await command("git", ["status", "--porcelain"])).stdout,
      browser: { ...binaryIdentity, sha256: sha256(await fs.readFile(browserBinary)) }, host: { path: hostBinary, copiedPath: privateCLI, sha256: sha256(await fs.readFile(hostBinary)) },
      sdk: await hashes(path.join(runDir, "js-sdk")), sources: {} };
    assert.equal(sha256(await fs.readFile(privateCLI)), report.sourceIdentity.host.sha256);
    for (const directory of ["apps/chrome-extension", "cmd/open-browser-use", "internal", "packages/open-browser-use-js/src"])
      report.sourceIdentity.sources[directory] = await hashes(path.join(repo, directory));
    for (const file of ["go.mod", "go.sum", "pnpm-lock.yaml", "package.json", "scripts/build-chrome-extension.mjs", ...(await fs.readdir(path.join(repo, "scripts"))).filter(file => /^patch-.*\.mjs$/.test(file) && !file.endsWith(".test.mjs")).map(file => `scripts/${file}`), "scripts/browser-integration/normal-browser-downloads.mjs", "scripts/browser-integration/normal-browser-downloads-support.mjs", "scripts/browser-integration/native-lifecycle-support.mjs", "scripts/browser-integration/extension-reload-support.mjs"])
      report.sourceIdentity.sources[file] = sha256(await fs.readFile(path.join(repo, file)));
    await buildChromeExtension(extension); report.productionExtensionHashes = await hashes(extension);
    const backgroundPath = path.join(extension, "background.js"), source = await fs.readFile(backgroundPath, "utf8"), original = 'const NATIVE_HOST_NAME = "com.ifuryst.open_browser_use.extension";';
    assert.equal(source.split(original).length, 2); await fs.writeFile(backgroundPath, source.replace(original, `const NATIVE_HOST_NAME = ${JSON.stringify(nativeName)};`));
    const manifestPath = path.join(extension, "manifest.json"), manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    manifest.key ??= (await fs.readFile(path.join(repo, "cmd/open-browser-use/main.go"), "utf8")).match(/const betaExtensionPublicKey = "([^"]+)"/)?.[1]; assert.ok(manifest.key);
    extensionId = sha256(Buffer.from(manifest.key, "base64")).slice(0, 32).replace(/[0-9a-f]/g, value => String.fromCharCode(97 + parseInt(value, 16)));
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2)); report.stagedExtensionHashes = await hashes(extension);
    assert.deepEqual(Object.keys(report.productionExtensionHashes).filter(file => report.productionExtensionHashes[file] !== report.stagedExtensionHashes[file]).sort(), ["background.js", "manifest.json"]);
    report.stagingExceptions = ["unique native host-name constant", "public unpacked extension key"];
    observer = await stageReloadObserver({ directory: path.join(runDir, "observer-extension") }); Object.assign(report, { extensionId, nativeName, observer });
    const hostManifestPath = path.join(runDir, "native-host.json");
    await command(privateCLI, ["install-manifest", "--browser", "edge", "--extension-id", extensionId, "--path", privateCLI, "--output", hostManifestPath]);
    const hostManifest = JSON.parse(await fs.readFile(hostManifestPath, "utf8")); hostManifest.name = nativeName; nativeExecutable = hostManifest.path;
    assert.ok(inside(runDir, nativeExecutable), "Native manifest executable escaped private run directory"); assert.equal(sha256(await fs.readFile(nativeExecutable)), report.sourceIdentity.host.sha256);
    await fs.writeFile(hostManifestPath, JSON.stringify(hostManifest, null, 2)); report.nativeManifest = hostManifest;
    for (const [file, text] of [[registryScript, nativeRegistrationSource], [watchScript, nativeWatchSource], [closeScript, closePrivateBrowserSource], [terminateScript, nativeTerminateSource]]) await fs.writeFile(file, text, { flag: "wx" });
    await save("registration.json", { Name: nativeName, Browser: "edge", Manifest: hostManifestPath, Owner: randomBytes(16).toString("hex") });
    registryAttempted = true; report.registration = JSON.parse(await script(registryScript, ["create"]));
    await step("bootstrap", "running");
    await launch("bootstrap", [`--user-data-dir=${profile}`, "--remote-debugging-port=0", "--enable-unsafe-extension-debugging", "--no-first-run", "--no-default-browser-check", "about:blank"]);
    const bootstrapPort = await poll(async () => { const text = await readIfPresent(path.join(profile, "DevToolsActivePort")); return text && parsePrivateDevToolsPort(text); }, { signal, label: "bootstrap DevToolsActivePort" });
    bootstrap.record.devTools = bootstrapPort;
    bootstrapControl = await connectCDP(bootstrapPort.url, { authorizationRequired: false, handshakeTimeoutMs: 10000 });
    bootstrap.record.version = await bootstrapControl.call("Browser.getVersion");
    bootstrap.record.installation = [];
    for (const [directory, expectedId] of [[observer.directory, observer.extensionId], [extension, extensionId]]) {
      const loaded = await bootstrapControl.call("Extensions.loadUnpacked", { path: directory }); assert.equal(loaded.id, expectedId);
      bootstrap.record.installation.push({ directory, loaded, at: Date.now() });
    }
    try { bootstrap.record.inventory = assertFixtureExtensionInventory(await bootstrapControl.call("Extensions.getExtensions"), [extensionId, observer.extensionId]); }
    catch (error) { bootstrap.record.inventory = error.inventory ?? { unavailable: true }; throw error; }
    bootstrap.record.host = await discoverHost(bootstrap); await shutdown(bootstrap, { viaCDP: bootstrapControl });
    await bootstrapControl.close(); diagnostics.delete(bootstrapControl); bootstrapControl = undefined;
    assert.equal(bootstrap.record.shutdown.complete, true); endpoint = undefined;
    await checkProfileAccounts("post-bootstrap");
    await step("normal-start", "running"); await launch("normal", normalStartArguments(profile));
    normal.record.host = await discoverHost(normal, { optional: true, timeoutMs: 10000 });
    await handoff(normal.record.host ? "enable-remote-debugging" : "manual-load");
    while (true) {
      const action = await inbox.next(); if (action.command === "stop") { report.stopped = { at: Date.now(), origin: action.origin }; break; }
      signal.throwIfAborted();
      if (report.binding?.verified) { output.write("BOUND: No task hook was supplied. Type stop to finish without a task PASS.\n"); continue; }
      await checkProfileAccounts("pre-bind");
      const host = await discoverHost(normal, { optional: true, timeoutMs: 5000 });
      if (!host) { await handoff("manual-load"); continue; }
      normal.record.host = host;
      const live = (await processTable()).find(row => row.ProcessId === normal.identity.ProcessId);
      assertNormalProcess(live, { profile, executable: browserBinary, browserPid: normal.identity.ProcessId }); assert.equal(live.CreationDate, normal.identity.CreationDate);
      await step("binding", "running");
      const binding = report.binding = { requestedBy: action, budgetMs: normalBindBudgetMs, processWatchdogMs: normalBindBudgetMs + 5000 };
      binding.command = await command(privateCLI, ["bind-browser", "--socket", host.socketPath, "--auto-connect", "--browser", "edge", "--user-data-dir", profile, "--exclusive", "--timeout", "120s"],
        { timeoutMs: normalBindBudgetMs + 5000, onStderr: text => output.write(text) });
      binding.reply = assertBindingAck(binding.command, { extensionId, instanceId: host.info.metadata.extensionInstanceId });
      binding.verified = true; binding.completedAt = Date.now();
      const devTools = parsePrivateDevToolsPort(await fs.readFile(path.join(profile, "DevToolsActivePort"), "utf8")); normal.record.devTools = devTools;
      const currentHost = await discoverHost(normal, { timeoutMs: 3000 });
      for (const field of ["pid", "socketPath", "startedAt"]) assert.equal(currentHost[field], host[field], "Original normal native host changed during binding");
      assert.equal(currentHost.identity.process.CreationDate, host.identity.process.CreationDate);
      assert.equal(currentHost.info.metadata.pageDownloads?.available, true); assert.equal(currentHost.info.metadata.pageDownloads.generation, binding.reply.result.generation);
      output.write(`BOUND ${JSON.stringify({ runDir, browserPid: normal.identity.ProcessId, hostPid: host.pid, generation: binding.reply.result.generation })}\n`);
      if (!onBound) { await step("bound-without-task", "awaiting-user"); continue; }
      await checkProfileAccounts("pre-business");
      await step("download-proof", "running");
      const connectBrowser = async (sessionId, options = {}) => { await checkProfileAccounts("pre-business-client"); const value = await sdk.connectOpenBrowserUse({ ...options, socketPath: host.socketPath, sessionId, timeoutMs: options.timeoutMs ?? 20000 }); clients.add(value); return value; };
      const task = Promise.resolve().then(() => onBound({ runDir, profile, env, report, signal, extensionId, nativeName, observer, endpoint: host,
        binding, hostBinary: privateCLI, browserBinary, normalIdentity: normal.identity, devTools, save, checkpoint, connectBrowser, connectCDP, processTable }));
      report.taskStop = {};
      report.task = await awaitTaskWithStop(task, { signal, record: report.taskStop });
      assert.equal(report.task?.verified, true, "Task hook did not verify the original download workflow");
      await checkProfileAccounts("post-business");
      break;
    }
  } catch (error) {
    if (signal.aborted && error.message === "OBU_NORMAL_RUN_STOPPED" || signal.aborted && error.result?.termination?.reason === "stop") report.stopped = { at: Date.now(), reason: error.message };
    else report.error = errorValue(error);
  } finally {
    await step("cleanup", "running").catch(error => report.cleanup.errors.push(errorValue(error)));
    for (const browser of clients) { try { browser.close(); } catch (error) { report.cleanup.errors.push(errorValue(error)); } }
    try { if (normal) await shutdown(normal); else if (bootstrap) await shutdown(bootstrap, { viaCDP: bootstrapControl }); }
    catch (error) {
      report.cleanup.errors.push(errorValue(error));
      // Failure cleanup may terminate only the exact previously verified root
      // or private staged native executable. It never converts failure to PASS.
      for (const runtime of [normal, bootstrap].filter(Boolean)) {
        try {
          const live = (await processTable()).find(row => row.ProcessId === runtime.identity?.ProcessId); if (!live) continue;
          assert.equal(live.CreationDate, runtime.identity.CreationDate); assert.equal(live.ExecutablePath, runtime.identity.ExecutablePath);
          const name = `failed-${runtime.phase}-identity.json`; await save(name, live);
          report.cleanup[`${runtime.phase}Forced`] = JSON.parse(await script(terminateScript, [path.join(runDir, name)], { cancel: false, timeoutMs: 15000 }));
          await bound(runtime.process.completed, 10000, "forced browser actual close");
        } catch (failure) { report.cleanup.errors.push(errorValue(failure)); }
      }
      if (nativeExecutable) {
        try {
          assert.ok(inside(runDir, nativeExecutable)); assert.equal(sha256(await fs.readFile(nativeExecutable)), report.sourceIdentity.host.sha256);
          const rows = await processTable();
          for (const row of rows.filter(value => value.ExecutablePath && norm(value.ExecutablePath) === norm(nativeExecutable))) {
            const name = `failed-native-${row.ProcessId}-identity.json`; await save(name, row);
            const result = JSON.parse(await script(terminateScript, [path.join(runDir, name)], { cancel: false, timeoutMs: 15000 }));
            (report.cleanup.nativeForced ??= []).push({ process: row, result });
          }
        } catch (failure) { report.cleanup.errors.push(errorValue(failure)); }
      }
    }
    for (const connection of diagnostics) { try { await connection.close(); } catch (error) { report.cleanup.errors.push(errorValue(error)); } }
    try {
      report.cleanup.processInventory = {};
      report.cleanup.processesAfter = await waitPrivateProcessesGone(privateProcesses, { record: report.cleanup.processInventory, persist: checkpoint, label: "final private processes gone" });
      report.cleanup.descriptorsAfter = await descriptors();
      if (report.cleanup.descriptorsAfter.length) report.cleanup.errors.push({ message: "Private native descriptors remain; preserved as failure evidence" });
      assert.equal(helpers.size, 0, "Tracked subprocess has not actually closed; registration retained");
      if (registryAttempted) report.cleanup.registration = JSON.parse(await script(registryScript, ["cleanup"], { cancel: false }));
      report.cleanup.complete = report.cleanup.errors.length === 0 && (!registryAttempted || report.cleanup.registration.removed === true);
    } catch (error) { report.cleanup.errors.push(errorValue(error)); }
    inbox.close(); report.completedAt = Date.now(); Object.assign(report, normalRunOutcome(report)); await checkpoint();
    output.write(`${report.passed ? "PASS" : report.status === "stopped" ? "STOPPED" : "FAIL"} ${JSON.stringify({ runDir, status: report.status, passed: report.passed, cleanupComplete: report.cleanup.complete })}\n`);
  }
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runNormalBrowserDownloads({ browserBinary: process.env.OBU_TEST_CHROMIUM_BINARY, hostBinary: process.env.OBU_TEST_HOST_BINARY })
    .then(report => { process.exitCode = report.exitCode; }, error => { console.error(error.stack ?? String(error)); process.exitCode = 1; });
}
