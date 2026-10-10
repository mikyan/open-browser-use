// Windows-only acceptance through the browser's real native messaging process.
// No connectNative shim, Playwright page connection, or user profile is used.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import WebSocket from "ws";
import { buildChromeExtension } from "../build-chrome-extension.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(directory, "../..");
assert.equal(process.platform, "win32", "This native registration fixture currently supports Windows only");
const browserName = process.env.OBU_TEST_NATIVE_BROWSER ?? "edge";
assert.ok(["edge", "chrome"].includes(browserName), "OBU_TEST_NATIVE_BROWSER must be edge or chrome");
const browserBinary = process.env.OBU_TEST_CHROMIUM_BINARY ?? (browserName === "edge"
  ? path.join(process.env["ProgramFiles(x86)"], "Microsoft/Edge/Application/msedge.exe")
  : path.join(process.env.ProgramFiles, "Google/Chrome/Application/chrome.exe"));
const sourceExecutable = process.env.OBU_TEST_HOST_BINARY;
assert.ok(sourceExecutable, "Set OBU_TEST_HOST_BINARY to the current built executable");
await Promise.all([fs.access(sourceExecutable), fs.access(browserBinary)]);
const artifactRoot = path.join(repo, ".tmp/browser-integration");
await fs.mkdir(artifactRoot, { recursive: true });
const runDir = await fs.mkdtemp(path.join(artifactRoot, "native-"));
const executable = path.join(runDir, "native-host.exe"), jsSnapshot = path.join(runDir, "js-sdk");
await fs.copyFile(sourceExecutable, executable);
await fs.cp(path.join(repo, "packages/open-browser-use-js/dist"), jsSnapshot, { recursive: true });
const { connectOpenBrowserUse, OpenBrowserUseClient } = await import(pathToFileURL(path.join(jsSnapshot, "index.js")));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const report = { startedAt: new Date().toISOString(), browser: browserName, browserBinary, nativeTransport: true, runDir, records: [] };

async function until(operation, label, timeout = 20000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try { const value = await operation(); if (value) return value; } catch (error) { lastError = error; }
    await delay(50);
  }
  throw new Error(`Timed out ${label}${lastError ? `: ${lastError.message}` : ""}`);
}

function subprocess(command, args, { timeoutMs = 30000, ...options } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], ...options });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${command} timed out`)); }, timeoutMs);
    child.stdout.on("data", value => stdout += value.toString());
    child.stderr.on("data", value => stderr += value.toString());
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", code => { clearTimeout(timer); code === 0 ? resolve(stdout) : reject(new Error(`${command} exited ${code}: ${stderr}`)); });
  });
}

async function hashTree(root) {
  const hashes = {};
  async function visit(relative = "") {
    for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) await visit(name);
      else if (entry.isFile()) hashes[name.replaceAll(path.sep, "/")] = sha256(await fs.readFile(path.join(root, name)));
    }
  }
  await visit(); return hashes;
}

// A raw CDP connection is only used for the extension worker's setup, native
// status and foreground-event ledger. All fixture-page work uses the SDK.
async function workerConnection(url) {
  const socket = new WebSocket(url), pending = new Map();
  await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  let nextId = 0;
  const fail = error => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); } pending.clear(); };
  socket.on("error", fail); socket.on("close", () => fail(new Error("Worker diagnostic connection closed")));
  socket.on("message", data => {
    const response = JSON.parse(data), item = pending.get(response.id);
    if (!item) return;
    pending.delete(response.id); clearTimeout(item.timer);
    response.error ? item.reject(new Error(JSON.stringify(response.error))) : item.resolve(response.result);
  });
  return {
    close() { socket.close(); fail(new Error("Worker diagnostic connection closed")); },
    async evaluate(expression) {
      const result = await new Promise((resolve, reject) => {
        const id = ++nextId, timer = setTimeout(() => { pending.delete(id); reject(new Error("Worker evaluation timed out")); }, 15000);
        pending.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
      });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    }
  };
}

// This script never removes a parent key. A create failure still enters cleanup;
// a preexisting key or a key changed by another actor is never overwritten/deleted.
const registrySource = `param([string]$Operation)
$ErrorActionPreference = 'Stop'
$taskData = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'registration.json') -Raw | ConvertFrom-Json
if ($taskData.Name -notmatch '^com\\.openbrowseruse\\.nativecheck\\.n[0-9a-f]{24}$') { throw 'Unexpected host name' }
if ($taskData.Browser -eq 'edge') { $taskParent = 'HKCU:\\Software\\Microsoft\\Edge\\NativeMessagingHosts' }
elseif ($taskData.Browser -eq 'chrome') { $taskParent = 'HKCU:\\Software\\Google\\Chrome\\NativeMessagingHosts' }
else { throw 'Unexpected browser' }
$taskKey = Join-Path $taskParent $taskData.Name
$taskBefore = Join-Path $PSScriptRoot 'registry-before.json'
if ($Operation -eq 'create') {
  $priorExists = Test-Path -LiteralPath $taskKey
  @{exists=$priorExists; key=$taskKey; manifest=$taskData.Manifest} | ConvertTo-Json | Set-Content -LiteralPath $taskBefore
  if ($priorExists) { throw 'Refusing to reuse an existing registry key' }
  New-Item -Path $taskKey | Out-Null
  Set-Item -LiteralPath $taskKey -Value $taskData.Manifest
  if ((Get-Item -LiteralPath $taskKey).GetValue('') -ne $taskData.Manifest) { throw 'Registration verification failed' }
  @{created=$true; key=$taskKey; manifest=$taskData.Manifest} | ConvertTo-Json
} elseif ($Operation -eq 'cleanup') {
  if (!(Test-Path -LiteralPath $taskBefore)) { @{untouched=$true; reason='create did not reach registry'} | ConvertTo-Json; exit }
  $prior = Get-Content -LiteralPath $taskBefore -Raw | ConvertFrom-Json
  if ($prior.key -ne $taskKey -or $prior.manifest -ne $taskData.Manifest) { throw 'Unsafe cleanup identity' }
  if ($prior.exists) { @{untouched=$true; reason='key preexisted'} | ConvertTo-Json; exit }
  if (Test-Path -LiteralPath $taskKey) {
    $taskActual = (Get-Item -LiteralPath $taskKey).GetValue('')
    if ($taskActual -and $taskActual -ne $taskData.Manifest) { throw 'Registry value changed; refusing cleanup' }
    if ((Get-Item -LiteralPath $taskKey).SubKeyCount -ne 0) { throw 'Registry gained subkeys; refusing cleanup' }
    Remove-Item -LiteralPath $taskKey
  }
  if (Test-Path -LiteralPath $taskKey) { throw 'Registry cleanup failed' }
  @{removed=$true; existsAfter=$false; key=$taskKey} | ConvertTo-Json
} else { throw 'Unknown operation' }
`;

function largeExpression(tag) {
  const unit = '中文🙂<article data-x="a/b\\c">payload</article>\n';
  const data = tag + "\n" + unit.repeat(Math.ceil(2 * 1024 * 1024 / Buffer.byteLength(unit)));
  const expected = { tag, characters: data.length, bytes: Buffer.byteLength(data), sha256: sha256(Buffer.from(data)), executions: 1 };
  const expression = `(async()=>{const data=${JSON.stringify(data)},tag=${JSON.stringify(tag)};globalThis.__nativeExecutions??={};const executions=globalThis.__nativeExecutions[tag]=(globalThis.__nativeExecutions[tag]??0)+1;const bytes=new TextEncoder().encode(data);const hash=await crypto.subtle.digest('SHA-256',bytes);return{tag,characters:data.length,bytes:bytes.length,sha256:[...new Uint8Array(hash)].map(b=>b.toString(16).padStart(2,'0')).join(''),executions};})()`;
  assert.ok(expected.bytes >= 2 * 1024 * 1024);
  const expressionBytes = Buffer.byteLength(expression), serializedCommandBytes = Buffer.byteLength(JSON.stringify({ expression, awaitPromise: true, returnByValue: true }));
  assert.ok(serializedCommandBytes > 1024 * 1024);
  return { expression, expected, expressionBytes, serializedCommandBytes };
}

async function runNative(mode) {
  const base = path.join(runDir, mode), extension = path.join(base, "extension"), temporary = path.join(base, "temp"), local = path.join(base, "local"), home = path.join(base, "home");
  const profile = path.join(base, "profile"), roaming = path.join(base, "roaming");
  await Promise.all([temporary, local, home, roaming].map(value => fs.mkdir(value, { recursive: true })));
  const env = { ...process.env, TEMP: temporary, TMP: temporary, LOCALAPPDATA: local, APPDATA: roaming, USERPROFILE: home, HOME: home };
  const nativeName = `com.openbrowseruse.nativecheck.n${randomBytes(12).toString("hex")}`;
  const result = { mode, nativeName, base, profile, startedAt: new Date().toISOString(), records: [], connectionCheckpoints: [] };
  report.records.push(result);
  const browsers = [], clients = [], browserLog = [];
  let child, childExit, worker, registryAttempted = false, endpoint;
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    response.end(request.url === "/sentinel" ? "<!doctype html><title>User sentinel</title><h1>Untouched sentinel</h1>" : "<!doctype html><title>Native message fixture</title><h1>Native message fixture</h1>");
  });
  const registryScript = path.join(base, "registry.ps1");
  const nativeStatus = () => worker.evaluate("chrome.storage.local.get('OPEN_BROWSER_USE_NATIVE_HOST_STATUS').then(value=>value.OPEN_BROWSER_USE_NATIVE_HOST_STATUS)");
  const endpointFile = path.join(temporary, "open-browser-use/active.json");
  const checkpoint = async phase => {
    const current = JSON.parse(await fs.readFile(endpointFile, "utf8")), status = await nativeStatus();
    assert.ok(Number.isSafeInteger(current.pid) && current.pid > 0, "Invalid native process ID");
    process.kill(current.pid, 0);
    const processIdentity = JSON.parse(await subprocess("powershell.exe", ["-NoProfile", "-Command", `Get-CimInstance -ClassName Win32_Process -Filter 'ProcessId = ${current.pid}' | Select-Object ProcessId,ParentProcessId,ExecutablePath | ConvertTo-Json -Compress`]));
    assert.equal(processIdentity.ProcessId, current.pid);
    assert.equal(path.resolve(processIdentity.ExecutablePath).toLowerCase(), path.resolve(result.nativeExecutable).toLowerCase(), "Native endpoint PID belongs to another executable");
    assert.equal(current.pid, endpoint.pid, "Native host process changed");
    assert.equal(current.socketPath, endpoint.socketPath, "Native endpoint changed");
    assert.equal(current.startedAt, endpoint.startedAt, "Native host restarted");
    assert.equal(status?.state, "connected"); assert.equal(status.hostName, nativeName); assert.equal(status.reconnectAttempt, 0);
    result.connectionCheckpoints.push({ phase, endpoint: current, status, processIdentity });
  };
  try {
    await buildChromeExtension(extension);
    result.productionExtensionHashes = await hashTree(extension);
    const backgroundFile = path.join(extension, "background.js");
    const background = await fs.readFile(backgroundFile, "utf8"), original = 'const NATIVE_HOST_NAME = "com.ifuryst.open_browser_use.extension";';
    assert.equal(background.split(original).length, 2, "Production native host constant changed");
    assert.ok(background.includes("chrome.runtime.connectNative(this.hostName)"), "Production connectNative changed");
    await fs.writeFile(backgroundFile, background.replace(original, `const NATIVE_HOST_NAME = ${JSON.stringify(nativeName)};`));
    const manifestFile = path.join(extension, "manifest.json"), manifest = JSON.parse(await fs.readFile(manifestFile, "utf8"));
    const cli = await fs.readFile(path.join(repo, "cmd/open-browser-use/main.go"), "utf8");
    // Stable public key selects a known unpacked extension origin. It is not a
    // private signing key and does not change any existing installed extension.
    const key = manifest.key ?? cli.match(/const betaExtensionPublicKey = "([^"]+)"/)?.[1];
    assert.ok(key); manifest.key = key;
    const extensionId = [...createHash("sha256").update(Buffer.from(key, "base64")).digest().subarray(0, 16)].map(value => String.fromCharCode(97 + (value >> 4), 97 + (value & 15))).join("");
    result.extensionId = extensionId;
    result.stagingChanges = ["unique test native host name", "public unpacked extension key"];
    if (mode === "legacy") {
      // Deliberately no transport hello; metadata cannot enable chunk transport.
      await fs.writeFile(backgroundFile, `const port=chrome.runtime.connectNative(${JSON.stringify(nativeName)});let largeCalls=0;const status={hostName:${JSON.stringify(nativeName)},state:'connected',reconnectAttempt:0};chrome.storage.local.set({OPEN_BROWSER_USE_NATIVE_HOST_STATUS:status});port.onDisconnect.addListener(()=>chrome.storage.local.set({OPEN_BROWSER_USE_NATIVE_HOST_STATUS:{...status,state:'disconnected',error:chrome.runtime.lastError?.message}}));port.onMessage.addListener(message=>{if(message.id===undefined)return;if(message.method==='nativeLargeProbe')largeCalls++;port.postMessage({jsonrpc:'2.0',id:message.id,result:message.method==='getInfo'?{name:'Legacy native fixture',metadata:{}}:{pong:true,largeCalls}})});`);
      manifest.permissions = ["nativeMessaging", "tabs", "storage"];
      delete manifest.action; delete manifest.host_permissions; delete manifest.content_scripts;
      result.stagingChanges.push("minimal legacy worker, no hello, no browser actions");
    }
    await fs.writeFile(manifestFile, JSON.stringify(manifest, null, 2));
    result.stagedExtensionHashes = await hashTree(extension);
    result.changedStagedFiles = Object.keys(result.productionExtensionHashes).filter(file => result.productionExtensionHashes[file] !== result.stagedExtensionHashes[file]);
    assert.deepEqual(result.changedStagedFiles.sort(), ["background.js", "manifest.json"], "Unexpected staged extension changes");
    const nativeManifest = path.join(base, "native-host.json");
    await subprocess(executable, ["install-manifest", "--browser", browserName, "--extension-id", extensionId, "--path", executable, "--output", nativeManifest], { env });
    const native = JSON.parse(await fs.readFile(nativeManifest, "utf8")); native.name = nativeName;
    await fs.writeFile(nativeManifest, JSON.stringify(native, null, 2));
    result.nativeExecutable = native.path; result.nativeExecutableSHA256 = sha256(await fs.readFile(native.path));
    assert.equal(result.nativeExecutableSHA256, report.sourceHashes.host, "Installed test native binary differs from supplied host");
    await fs.writeFile(registryScript, registrySource);
    await fs.writeFile(path.join(base, "registration.json"), JSON.stringify({ Name: nativeName, Browser: browserName, Manifest: nativeManifest }));
    registryAttempted = true;
    result.registration = JSON.parse(await subprocess("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", registryScript, "create"]));
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const baseURL = `http://127.0.0.1:${server.address().port}`;
    child = spawn(browserBinary, [`--user-data-dir=${profile}`, "--remote-debugging-port=0", `--disable-extensions-except=${extension}`, `--load-extension=${extension}`, "--no-first-run", "--no-default-browser-check", "--disable-sync", "--disable-background-networking", "--enable-logging=stderr", "about:blank"], { env, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    child.stderr.on("data", data => browserLog.push(data.toString()));
    childExit = new Promise(resolve => { child.once("exit", (code, signal) => resolve({ code, signal })); child.once("error", error => resolve({ error: error.message })); });
    const debugPort = await until(async () => (await fs.readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0], "isolated native browser debugging port");
    const workerTarget = await until(async () => (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()).find(value => value.type === "service_worker" && value.url === `chrome-extension://${extensionId}/background.js`), "exact extension service worker");
    worker = await workerConnection(workerTarget.webSocketDebuggerUrl);
    result.userAgent = await worker.evaluate("navigator.userAgent");
    await until(async () => (await nativeStatus())?.state === "connected", "native port connection");
    endpoint = await until(async () => JSON.parse(await fs.readFile(endpointFile, "utf8")), "native host endpoint");
    result.endpoint = endpoint;
    const sentinel = await worker.evaluate(`chrome.tabs.create({url:${JSON.stringify(baseURL + "/sentinel")},active:true})`);
    await until(async () => (await worker.evaluate(`chrome.tabs.get(${sentinel.id})`)).status === "complete", "sentinel loaded");
    result.foregroundBefore = await worker.evaluate(`(async()=>{globalThis.__nativeActivationEvents=[];globalThis.__nativeFocusEvents=[];chrome.tabs.onActivated.addListener(value=>__nativeActivationEvents.push({...value,at:Date.now()}));chrome.windows.onFocusChanged.addListener(windowId=>__nativeFocusEvents.push({windowId,at:Date.now()}));return{sentinel:await chrome.tabs.get(${sentinel.id}),focusedWindow:await chrome.windows.getLastFocused()}})()`);
    await checkpoint("before-large-requests");
    if (mode === "modern") {
      const first = await connectOpenBrowserUse({ socketPath: endpoint.socketPath, sessionId: "native-large-first", turnId: "native-test", timeoutMs: 20000 }); browsers.push(first);
      const second = await connectOpenBrowserUse({ socketPath: endpoint.socketPath, sessionId: "native-large-second", turnId: "native-test", timeoutMs: 20000 }); browsers.push(second);
      const tabs = await Promise.all(browsers.map(browser => browser.newTab({ url: baseURL + "/fixture" })));
      const requests = [largeExpression("first-client"), largeExpression("second-client")];
      const results = await Promise.all(tabs.map((tab, index) => tab.evaluate(requests[index].expression, { awaitPromise: true })));
      for (let index = 0; index < results.length; index++) {
        assert.deepEqual(results[index], requests[index].expected, "Large native request was truncated, replayed or routed to another client");
        const { expression: _, ...witness } = requests[index];
        result.records.push({ name: `large-message-${index + 1}`, ...witness, actual: results[index], tabId: tabs[index].id });
        assert.deepEqual(await tabs[index].evaluate("globalThis.__nativeExecutions"), { [requests[index].expected.tag]: 1 });
        await browsers[index].client.request("ping");
      }
      await checkpoint("after-large-and-small-requests");
      await Promise.all(browsers.map(browser => browser.client.finalizeTabs([])));
    } else {
      const client = new OpenBrowserUseClient({ socketPath: endpoint.socketPath, sessionId: "native-legacy", turnId: "legacy-test", timeoutMs: 15000 }); clients.push(client);
      const payload = largeExpression("legacy-client");
      assert.deepEqual(await client.request("ping"), { pong: true, largeCalls: 0 });
      let rejection;
      try { await client.request("nativeLargeProbe", { payload: payload.expression, timeoutMs: 10000 }); assert.fail("Unnegotiated oversized native request was accepted"); }
      catch (error) { assert.match(error.message, /OBU_NATIVE_MESSAGE_TOO_LARGE/); rejection = error.message; }
      assert.deepEqual(await client.request("ping"), { pong: true, largeCalls: 0 }, "Legacy connection was lost or oversized request reached its handler");
      await checkpoint("after-rejection-and-small-ping");
      result.records.push({ name: "legacy-oversized-request-rejected", rejection, expressionBytes: payload.expressionBytes, handlerCalls: 0 });
    }
    result.foregroundAfter = await worker.evaluate(`(async()=>({sentinel:await chrome.tabs.get(${sentinel.id}),focusedWindow:await chrome.windows.getLastFocused(),activeEvents:[...__nativeActivationEvents],windowFocusEvents:[...__nativeFocusEvents]}))()`);
    assert.equal(result.foregroundAfter.sentinel.active, true);
    assert.equal(result.foregroundAfter.sentinel.windowId, result.foregroundBefore.sentinel.windowId);
    assert.equal(result.foregroundAfter.focusedWindow.id, result.foregroundBefore.focusedWindow.id);
    assert.deepEqual(result.foregroundAfter.activeEvents, []); assert.deepEqual(result.foregroundAfter.windowFocusEvents, []);
    await checkpoint("before-profile-close");
    result.passed = true;
  } catch (error) { result.error = error.stack; result.passed = false; }
  finally {
    // Preserve the raw foreground ledger before intentional fixture shutdown.
    if (worker) {
      try {
        result.finalNativeStatus = await nativeStatus();
        result.finalLedgers = await worker.evaluate("({activeEvents:globalThis.__nativeActivationEvents??[],windowFocusEvents:globalThis.__nativeFocusEvents??[]})");
        assert.deepEqual(result.finalLedgers.activeEvents, []); assert.deepEqual(result.finalLedgers.windowFocusEvents, []);
        if (result.foregroundAfter) {
          assert.deepEqual(result.finalLedgers.activeEvents, result.foregroundAfter.activeEvents, "Late tab activation before teardown");
          assert.deepEqual(result.finalLedgers.windowFocusEvents, result.foregroundAfter.windowFocusEvents, "Late window focus before teardown");
        }
      } catch (error) { result.diagnosticError = error.message; result.passed = false; }
    }
    for (const value of [...browsers, ...clients]) value.close();
    if (worker) { try { await worker.evaluate("chrome.windows.getAll().then(windows=>Promise.all(windows.map(window=>chrome.windows.remove(window.id))))"); } catch {} worker.close(); }
    if (child) {
      let exited = await Promise.race([childExit, delay(5000).then(() => null)]);
      if (!exited) { child.kill(); exited = await Promise.race([childExit, delay(5000).then(() => null)]); }
      result.browserExit = exited;
      if (!exited) { result.passed = false; result.cleanupError = "Isolated browser did not exit"; }
    }
    if (registryAttempted) {
      try {
        result.registrationCleanup = JSON.parse(await subprocess("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", registryScript, "cleanup"]));
        if (!result.registrationCleanup.removed) result.passed = false;
      } catch (error) { result.passed = false; result.registryCleanupError = error.message; }
    }
    if (endpoint) {
      try { await until(async () => { try { process.kill(endpoint.pid, 0); return false; } catch (error) { if (error.code === "ESRCH") return true; throw error; } }, "native host exit after isolated profile close", 5000); result.nativeHostStopped = true; }
      catch (error) { result.nativeHostStopped = false; result.passed = false; result.nativeHostCleanupError = error.message; }
    }
    try {
      server.closeAllConnections();
      if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      result.serverClosed = true;
    } catch (error) { result.serverCleanupError = error.message; result.passed = false; }
    // Windows Chromium may put native-host stderr in chrome_debug.log rather
    // than the browser process's stderr. Retain both without copying user logs.
    for (const name of ["chrome_debug.log", "debug.log"]) {
      try { await fs.copyFile(path.join(profile, name), path.join(base, name)); } catch (error) { if (error.code !== "ENOENT") result.logCopyError = error.message; }
    }
    await fs.writeFile(path.join(base, "browser.log"), browserLog.join(""));
    await fs.writeFile(path.join(base, "results.json"), JSON.stringify(result, null, 2));
    console.log(result.passed ? "PASS" : "FAIL", `native-${mode}`, result.error ?? result.cleanupError ?? result.registryCleanupError ?? "");
  }
}

try {
  report.sourceHashes = { host: sha256(await fs.readFile(executable)), jsSDK: await hashTree(jsSnapshot), harness: sha256(await fs.readFile(fileURLToPath(import.meta.url))) };
  report.gitHead = (await subprocess("git", ["rev-parse", "HEAD"], { cwd: repo })).trim();
  report.dirty = !!(await subprocess("git", ["status", "--porcelain"], { cwd: repo })).trim();
  await runNative("modern");
  if (report.records.some(value => value.browserExit === null || value.nativeHostStopped === false)) throw new Error("Prior isolated browser/host cleanup incomplete; refusing to start another browser");
  await runNative("legacy");
} catch (error) { report.error = error.stack; }
finally {
  report.passed = !report.error && report.records.length === 2 && report.records.every(value => value.passed);
  await fs.writeFile(path.join(runDir, "results.json"), JSON.stringify(report, null, 2));
  console.log("RESULT", path.join(runDir, "results.json"));
  process.exitCode = report.passed ? 0 : 1;
}
