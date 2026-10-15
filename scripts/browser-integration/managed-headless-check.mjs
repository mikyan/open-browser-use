// A single Windows feasibility attempt, not an installed-profile focus test.
// The browser launches the real native host. No Native Port shim, page CDP
// driver, OS input, action replay, or sandbox-disabling flag is used.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import net from "node:net";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import WebSocket from "ws";
import { buildChromeExtension } from "../build-chrome-extension.mjs";
import { listenFixture } from "./fixture-listener.mjs";
import { createCreatedPageFixtures } from "./created-page-fixture.mjs";
import { installCreatedPageObserver, assertCreatedPageSource, assertCreatedPageReceipt } from "./created-page-provenance.mjs";
import { assertFixtureExtensionInventory, assertNativeProcessIdentity, nativeRegistrationSource, nativeWatchSource } from "./native-lifecycle-support.mjs";
import { browserStartupOptions, resolveFieldTrialConfig } from "./browser-startup.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
assert.equal(process.platform, "win32", "This prototype supports Windows only");
const binary = process.env.OBU_TEST_CHROMIUM_BINARY, sourceHost = process.env.OBU_TEST_HOST_BINARY;
const fieldTrialConfig = resolveFieldTrialConfig(process.env.OBU_TEST_FIELD_TRIAL_CONFIG);
assert.ok(binary && sourceHost, "Set OBU_TEST_CHROMIUM_BINARY and OBU_TEST_HOST_BINARY explicitly");
await Promise.all([fs.access(binary), fs.access(sourceHost)]);
const sha256 = value => createHash("sha256").update(value).digest("hex");
const pinned = { version: "156.0.8078.4", revision: "f842f52ef39fd97b449eb27cff414bf05a98ddce", sha256: "7f08161bbeb2853ffe1780a9ded4985087f52efb9725d7d8207aabdd42f7cfb9" };
assert.equal(sha256(await fs.readFile(binary)), pinned.sha256, "Unreviewed managed headless browser binary");
const root = path.join(repo, ".tmp/browser-integration");
await fs.mkdir(root, { recursive: true });
const runDir = await fs.mkdtemp(path.join(root, "managed-headless-"));
const profile = path.join(runDir, "profile"), extension = path.join(runDir, "extension"), sdkPath = path.join(runDir, "js-sdk");
const host = path.join(runDir, "native-host.exe"), temporary = path.join(runDir, "temp");
const local = path.join(runDir, "local"), roaming = path.join(runDir, "roaming"), userDirectory = path.join(runDir, "user");
await Promise.all([temporary, local, roaming, userDirectory].map(directory => fs.mkdir(directory, { recursive: true })));
await fs.copyFile(sourceHost, host);
await fs.cp(path.join(repo, "packages/open-browser-use-js/dist"), sdkPath, { recursive: true });
const { connectOpenBrowserUse } = await import(pathToFileURL(path.join(sdkPath, "index.js")));
const env = { ...process.env, TEMP: temporary, TMP: temporary, LOCALAPPDATA: local, APPDATA: roaming, USERPROFILE: userDirectory };
delete env.HOME;
const nativeName = `com.openbrowseruse.lifecycle.n${randomBytes(12).toString("hex")}`;
const endpointFile = path.join(temporary, "open-browser-use/active.json"), registryScript = path.join(runDir, "registry.ps1");
const report = { scope: "explicit isolated headless feasibility; real connectNative and formal JS SDK; not ordinary-profile or OS foreground acceptance", runDir, startedAt: Date.now(), pinned, nativeName, steps: [], commands: [], cleanup: {}, limitations: ["No public managed-session launcher, login handoff or visible trusted settings UI", "Browser focus events are diagnostics, not independent OS foreground evidence", "One root popup only; no OOPIF or multi-browser parity claim"] };
const logs = [], connections = [];
let child, childExit, control, worker, browser, endpoint, nativeExecutable, registrationAttempted = false, watch, inventoryConnection, inventoryTargetId;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const save = (name, value) => fs.writeFile(path.join(runDir, name), JSON.stringify(value, null, 2));
async function until(operation, label, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs; let lastError;
  do {
    try { const value = await operation(); if (value) return value; } catch (error) { lastError = error; }
    await delay(Math.min(50, Math.max(0, deadline - Date.now())));
  } while (Date.now() < deadline);
  throw new Error(`Timed out ${label}${lastError ? `: ${lastError.message}` : ""}`);
}
async function command(program, args, options = {}) {
  const record = { program, args, startedAt: Date.now(), stdout: "", stderr: "" }; report.commands.push(record);
  return new Promise((resolve, reject) => {
    const process = spawn(program, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], ...options });
    record.pid = process.pid;
    const timer = setTimeout(() => { record.timedOut = true; process.kill(); }, 55000);
    process.stdout.on("data", value => { record.stdout += value; }); process.stderr.on("data", value => { record.stderr += value; });
    process.once("error", error => { clearTimeout(timer); record.error = String(error); reject(error); });
    process.once("close", (code, signal) => { clearTimeout(timer); Object.assign(record, { code, signal, endedAt: Date.now() }); code === 0 && !record.timedOut ? resolve(record.stdout) : reject(new Error(`${program} exited ${code}: ${record.stderr}`)); });
  });
}
async function hashTree(directory) {
  const result = {};
  async function visit(relative = "") {
    for (const entry of await fs.readdir(path.join(directory, relative), { withFileTypes: true })) {
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) await visit(name);
      else if (entry.isFile()) result[name.replaceAll(path.sep, "/")] = sha256(await fs.readFile(path.join(directory, name)));
    }
  }
  await visit(); return result;
}
async function cdp(url) {
  const socket = new WebSocket(url), pending = new Map(); let sequence = 0;
  const failed = error => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); } pending.clear(); };
  socket.on("error", failed); socket.on("close", () => failed(new Error("Diagnostic CDP connection closed")));
  await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  socket.on("message", bytes => {
    const reply = JSON.parse(bytes), item = pending.get(reply.id); if (!item) return;
    pending.delete(reply.id); clearTimeout(item.timer); reply.error ? item.reject(new Error(JSON.stringify(reply.error))) : item.resolve(reply.result);
  });
  const connection = {
    call(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error(`Diagnostic CDP timeout: ${method}`)); }, 10000);
        pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
      });
    },
    async evaluate(expression) {
      const result = await connection.call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails)); return result.result.value;
    },
    close() { socket.close(); failed(new Error("Diagnostic CDP closed by fixture")); }
  };
  connections.push(connection); return connection;
}
async function step(name, operation) {
  const record = { name, startedAt: Date.now() }; report.steps.push(record); console.log("STEP", name);
  try { const result = await operation(); record.passed = true; record.endedAt = Date.now(); await save("results.json", report); return result; }
  catch (error) { record.passed = false; record.error = error.stack; record.endedAt = Date.now(); throw error; }
}
async function processTable() {
  return JSON.parse(await command("powershell.exe", ["-NoProfile", "-Command", "@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,ExecutablePath,@{n='CreationDate';e={$_.CreationDate.ToUniversalTime().ToString('o')}}) | ConvertTo-Json -Compress"]));
}
const nativeStatus = () => worker.evaluate("chrome.storage.local.get('OPEN_BROWSER_USE_NATIVE_HOST_STATUS').then(value=>value.OPEN_BROWSER_USE_NATIVE_HOST_STATUS)");
async function nativeCheckpoint(label) {
  const current = JSON.parse(await fs.readFile(endpointFile, "utf8")), status = await nativeStatus();
  const identity = assertNativeProcessIdentity(current, await processTable(), { executable: nativeExecutable, browserPid: child.pid });
  if (endpoint) for (const key of ["pid", "socketPath", "startedAt"]) assert.equal(current[key], endpoint[key], `Native host changed ${key}`);
  assert.equal(status?.state, "connected"); assert.equal(status.hostName, nativeName);
  const result = { label, at: Date.now(), endpoint: current, status, identity };
  report.nativeCheckpoints ??= []; report.nativeCheckpoints.push(result); return result;
}
async function extensionInventory(label) {
  const entry = { label, at: Date.now(), targetId: inventoryTargetId }; report.extensionInventories ??= []; report.extensionInventories.push(entry);
  try {
    const target = (await inventoryConnection.call("Target.getTargetInfo")).targetInfo;
    assert.equal(target.targetId, inventoryTargetId); assert.equal(target.url, "chrome://extensions/");
    entry.entries = await inventoryConnection.evaluate("chrome.developerPrivate.getExtensionsInfo({includeDisabled:true,includeTerminated:true}).then(values=>values.map(({id,location,state,type})=>({id,location,state,type})))");
    Object.assign(entry, assertFixtureExtensionInventory(entry.entries, [report.extensionId])); entry.passed = true; return entry;
  } catch (error) { entry.error = error.stack; throw error; }
  finally { await save("extension-inventory.json", report.extensionInventories); }
}
async function observeEOF() {
  const checkpoint = await nativeCheckpoint("before-close"), identityFile = path.join(runDir, "native-identity.json"), readyFile = path.join(runDir, "native-watch-ready.json");
  await save("native-identity.json", checkpoint.identity.process);
  const completed = command("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(runDir, "watch-native.ps1"), identityFile, readyFile]).then(value => ({ result: JSON.parse(value) }), error => ({ error: error.stack }));
  const ready = await until(async () => JSON.parse(await fs.readFile(readyFile, "utf8")), "native exit observer", 10000);
  assert.equal(ready.pid, endpoint.pid); return { ready, completed };
}
async function endpointRecords() {
  const directory = path.dirname(endpointFile), records = [];
  for (const file of await fs.readdir(directory).catch(error => error.code === "ENOENT" ? [] : Promise.reject(error))) {
    if (file.endsWith(".json")) try { records.push({ file, value: JSON.parse(await fs.readFile(path.join(directory, file), "utf8")) }); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return records;
}
async function pipeUnavailable(socketPath) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath), timer = setTimeout(() => { socket.destroy(); reject(new Error("Named pipe probe timed out")); }, 2000);
    socket.once("connect", () => { clearTimeout(timer); socket.destroy(); resolve(false); });
    socket.once("error", error => { clearTimeout(timer); socket.destroy(); ["ENOENT", "ECONNREFUSED"].includes(error.code) ? resolve({ code: error.code, at: Date.now() }) : reject(error); });
  });
}
const fixtures = createCreatedPageFixtures(), formRequests = [], formToken = randomBytes(16).toString("hex");
const formValue = "隔离窗口 Native 156";
const server = createServer((request, response) => {
  if (fixtures.handle(request, response)) return;
  response.setHeader("Cache-Control", "no-store");
  if (request.url === "/form" && request.method === "GET") {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(`<!doctype html><meta charset="utf-8"><title>Managed headless form</title><style>body{font:20px sans-serif;padding:24px}input,button{font:inherit;padding:10px;margin:15px}</style><h1>Isolated native form</h1><form><label>Report name<input name="name"></label><button>Submit original form</button></form><output id="result"></output><script>let clicks=[];document.querySelector('button').addEventListener('click',e=>clicks.push(e.isTrusted));document.querySelector('form').addEventListener('submit',async e=>{e.preventDefault();const body=new URLSearchParams({name:e.target.elements.name.value,token:${JSON.stringify(formToken)},trusted:String(clicks.at(-1)),count:String(clicks.length)});document.querySelector('#result').textContent=await(await fetch('/form-receipt',{method:'POST',body})).text()})</script>`); return;
  }
  if (request.url === "/form-receipt" && request.method === "POST") {
    const record = { at: Date.now(), chunks: [], finished: false }; formRequests.push(record);
    response.once("finish", () => { record.finished = true; });
    request.on("data", chunk => { record.chunks.push(chunk); });
    request.once("end", () => {
      const bytes = Buffer.concat(record.chunks); delete record.chunks;
      record.body = { base64: bytes.toString("base64"), bytes: bytes.length, sha256: sha256(bytes) }; record.fields = Object.fromEntries(new URLSearchParams(bytes.toString()));
      record.status = formRequests.length === 1 && JSON.stringify(record.fields) === JSON.stringify({ name: formValue, token: formToken, trusted: "true", count: "1" }) ? 200 : 409;
      response.writeHead(record.status, { "Content-Type": "application/json" }); response.end(JSON.stringify({ ok: record.status === 200 }));
    }); return;
  }
  request.resume(); response.writeHead(404); response.end("NOT_FOUND");
});

try {
  report.sourceIdentity = { gitHead: (await command("git", ["rev-parse", "HEAD"], { cwd: repo })).trim(), gitStatus: (await command("git", ["status", "--porcelain"], { cwd: repo })).trim(), host: sha256(await fs.readFile(host)), sdk: await hashTree(sdkPath), sources: {} };
  for (const file of ["scripts/browser-integration/managed-headless-check.mjs", "scripts/browser-integration/browser-startup.mjs", "scripts/browser-integration/native-lifecycle-support.mjs", "scripts/browser-integration/created-page-fixture.mjs", "scripts/browser-integration/created-page-provenance.mjs", "scripts/browser-integration/fixture-listener.mjs", "scripts/build-chrome-extension.mjs"])
    report.sourceIdentity.sources[file] = sha256(await fs.readFile(path.join(repo, file)));
  await step("stage-real-native-extension", async () => {
    await buildChromeExtension(extension); report.sourceIdentity.productionExtension = await hashTree(extension);
    const file = path.join(extension, "background.js"), original = 'const NATIVE_HOST_NAME = "com.ifuryst.open_browser_use.extension";', text = await fs.readFile(file, "utf8");
    assert.equal(text.split(original).length, 2); assert.equal(text.split("chrome.runtime.connectNative(this.hostName)").length, 2);
    await fs.writeFile(file, text.replace(original, `const NATIVE_HOST_NAME = ${JSON.stringify(nativeName)};`));
    const manifestFile = path.join(extension, "manifest.json"), manifest = JSON.parse(await fs.readFile(manifestFile, "utf8"));
    manifest.key ??= (await fs.readFile(path.join(repo, "cmd/open-browser-use/main.go"), "utf8")).match(/const betaExtensionPublicKey = "([^"]+)"/)?.[1]; assert.ok(manifest.key);
    report.extensionId = sha256(Buffer.from(manifest.key, "base64")).slice(0, 32).replace(/[0-9a-f]/g, value => String.fromCharCode(97 + parseInt(value, 16)));
    await fs.writeFile(manifestFile, JSON.stringify(manifest, null, 2)); report.sourceIdentity.stagedExtension = await hashTree(extension);
    assert.deepEqual(Object.keys(report.sourceIdentity.productionExtension).filter(file => report.sourceIdentity.productionExtension[file] !== report.sourceIdentity.stagedExtension[file]).sort(), ["background.js", "manifest.json"]);
    report.stagingExceptions = ["unique native host name", "public unpacked extension key"];
    const manifestPath = path.join(runDir, "native-host.json");
    await command(host, ["install-manifest", "--browser", "chrome", "--extension-id", report.extensionId, "--path", host, "--output", manifestPath], { env });
    const native = JSON.parse(await fs.readFile(manifestPath, "utf8")); native.name = nativeName; await save("native-host.json", native); nativeExecutable = native.path;
    const relative = path.relative(runDir, path.resolve(nativeExecutable)); assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    assert.equal(sha256(await fs.readFile(nativeExecutable)), report.sourceIdentity.host); report.nativeManifest = native;
    await fs.writeFile(registryScript, nativeRegistrationSource); await fs.writeFile(path.join(runDir, "watch-native.ps1"), nativeWatchSource);
    await save("registration.json", { Name: nativeName, Browser: "chrome", Manifest: manifestPath, Owner: randomBytes(16).toString("hex") });
    registrationAttempted = true; report.registration = JSON.parse(await command("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", registryScript, "create"]));
  });
  await listenFixture(server); const fixtureURL = `http://127.0.0.1:${server.address().port}`;
  await step("headless-browser-and-native-connect", async () => {
    const startup = browserStartupOptions(["--headless=new", "--enable-automation", `--user-data-dir=${profile}`, "--remote-debugging-port=0", `--disable-extensions-except=${extension}`, `--load-extension=${extension}`, "--no-first-run", "--no-default-browser-check", "--disable-sync", "--disable-background-networking", "--site-per-process", "--enable-logging", `--log-file=${path.join(runDir, "chrome.log")}`, "about:blank"], fieldTrialConfig);
    assert.ok(!startup.args.includes("--no-sandbox")); report.startup = { binary, ...startup, sandboxDisabled: false };
    child = spawn(binary, startup.args, { env, windowsHide: startup.windowsHide, stdio: ["ignore", "ignore", "pipe"] }); report.browserPid = child.pid;
    child.stderr.on("data", value => logs.push(value.toString()));
    childExit = new Promise(resolve => { child.once("close", (code, signal) => { report.browserExit = { code, signal, at: Date.now() }; resolve(report.browserExit); }); child.once("error", error => resolve({ error: error.stack })); });
    const startupDeadline = Date.now() + 20000; let lines;
    while (Date.now() < startupDeadline) {
      if (report.browserExit) throw new Error(`Headless browser exited before endpoint: ${JSON.stringify(report.browserExit)}`);
      try { lines = (await fs.readFile(path.join(profile, "DevToolsActivePort"), "utf8")).trim().split("\n"); if (lines.length === 2) break; }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      await delay(50);
    }
    assert.ok(lines?.length === 2, "Timed out private headless endpoint");
    report.browserEndpoint = { port: lines[0], browserId: lines[1] }; control = await cdp(`ws://127.0.0.1:${lines[0]}${lines[1]}`);
    report.browserVersion = await control.call("Browser.getVersion"); assert.equal(report.browserVersion.product, `Chrome/${pinned.version}`); assert.equal(report.browserVersion.revision, `@${pinned.revision}`);
    report.commandLine = await control.call("Browser.getBrowserCommandLine"); assert.ok(report.commandLine.arguments.includes("--headless=new")); assert.ok(!report.commandLine.arguments.includes("--no-sandbox"));
    assert.equal(report.commandLine.arguments.includes("--disable-field-trial-config"), fieldTrialConfig === "disabled");
    const target = await until(async () => (await (await fetch(`http://127.0.0.1:${lines[0]}/json/list`)).json()).find(value => value.type === "service_worker" && value.url === `chrome-extension://${report.extensionId}/background.js`), "exact extension worker");
    worker = await cdp(target.webSocketDebuggerUrl); report.workerTargetId = target.id;
    await until(async () => (await nativeStatus())?.state === "connected", "real native Port connection");
    // connectNative returns a Port before Windows finishes launching the host.
    // Wait for the original host's published descriptor within this startup's
    // original deadline, then prove its executable and browser ancestry.
    endpoint = await until(async () => JSON.parse(await fs.readFile(endpointFile, "utf8")), "native endpoint publication", Math.max(1, startupDeadline - Date.now()));
    await nativeCheckpoint("connected");
    inventoryTargetId = (await control.call("Target.createTarget", { url: "chrome://extensions/", background: true })).targetId;
    const inventoryTarget = await until(async () => (await (await fetch(`http://127.0.0.1:${lines[0]}/json/list`)).json()).find(value => value.id === inventoryTargetId), "private extensions inventory");
    inventoryConnection = await cdp(inventoryTarget.webSocketDebuggerUrl);
    await until(() => inventoryConnection.evaluate("document.readyState==='complete'&&typeof chrome.developerPrivate?.getExtensionsInfo==='function'"), "read-only extensions inventory API");
    await extensionInventory("before-task");
    report.internalFocusObserver = await worker.evaluate(`(()=>{globalThis.__managedFocusEvents=[];chrome.tabs.onActivated.addListener(value=>__managedFocusEvents.push({kind:'tab',at:Date.now(),...value}));chrome.windows.onFocusChanged.addListener(windowId=>__managedFocusEvents.push({kind:'window',at:Date.now(),windowId}));return{at:Date.now()}})()`);
    report.createdPageObserver = await worker.evaluate(`(${installCreatedPageObserver.toString()})(chrome,globalThis,{maxSources:1})`);
    browser = await connectOpenBrowserUse({ socketPath: endpoint.socketPath, sessionId: "managed-headless-feasibility", turnId: "original-attempt", timeoutMs: 15000 });
    report.info = await browser.client.getInfo();
    console.log("HARNESS", JSON.stringify({ runDir, browserPid: child.pid, hostPid: endpoint.pid, fixtureURL }));
  });
  let formTab, source, originalChild;
  await step("original-form-and-png", async () => {
    formTab = await browser.newTab({ url: fixtureURL + "/form", backgroundWindow: true }); report.formTabId = formTab.id;
    await formTab.getByLabel("Report name", { exact: true }).fill(formValue, { timeoutMs: 10000 });
    await formTab.getByRole("button", { name: "Submit original form", exact: true }).click({ timeoutMs: 10000 });
    report.formResult = await until(async () => { const text = await formTab.locator("#result").textContent({ timeoutMs: 1000 }); return text && JSON.parse(text); }, "original form response");
    assert.deepEqual(report.formResult, { ok: true }); assert.equal(formRequests.length, 1); assert.equal(formRequests[0].status, 200); assert.equal(formRequests[0].finished, true);
    const screenshot = await formTab.screenshot({ timeoutMs: 10000 }); assert.equal(screenshot.mimeType, "image/png");
    const bytes = Buffer.from(screenshot.base64, "base64"); assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    report.screenshot = { file: "form.png", bytes: bytes.length, sha256: sha256(bytes), width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }; assert.ok(report.screenshot.width > 0 && report.screenshot.height > 0);
    await fs.writeFile(path.join(runDir, "form.png"), bytes); await nativeCheckpoint("after-form");
  });
  await step("original-Control-click-child-and-single-POST", async () => {
    const record = fixtures.createCase({ owner: "managed-headless", variant: "root" });
    const item = report.popup = { key: record.key, owner: record.owner, childURL: fixtureURL + "/created-page/child" };
    source = await browser.newTab({ url: fixtureURL + record.urlPath, backgroundWindow: true }); item.tabId = source.id;
    const readState = async tab => JSON.parse(await tab.locator("#state").textContent({ timeoutMs: 5000 }));
    const frames = tabId => worker.evaluate(`chrome.webNavigation.getAllFrames({tabId:${tabId}})`);
    item.sourceBefore = await readState(source); assert.equal(item.sourceBefore.clicks.length, 0);
    item.sourceFrame = (await frames(source.id)).find(frame => frame.frameId === 0); assert.ok(item.sourceFrame?.documentId);
    item.observerReady = await worker.evaluate(`__createdPageProvenance.register(${source.id})`);
    const deadline = Date.now() + 30000, remaining = () => { const ms = deadline - Date.now(); assert.ok(ms > 0, "Original popup workflow deadline expired"); return Math.min(ms, 10000); };
    const wait = await source.expectPage({ timeoutMs: remaining() }); item.waiterId = wait.waiterId;
    await source.getByRole("link", { name: "Open original child", exact: true }).click({ modifiers: ["Control"], timeoutMs: remaining() });
    originalChild = await wait.result(); item.childId = originalChild.id;
    const trace = await worker.evaluate("__createdPageProvenance.snapshot()"); assert.equal(trace.overflow, false); item.events = trace.events;
    item.sourceAfter = await readState(source); item.framesAfter = await frames(source.id);
    assert.equal(assertCreatedPageSource({ item, events: item.events, afterFrames: item.framesAfter, sourceState: item.sourceAfter }), originalChild.id);
    item.childBefore = await readState(originalChild); item.childFrame = (await frames(originalChild.id)).find(frame => frame.frameId === 0);
    await originalChild.getByLabel("Source key", { exact: true }).fill(item.key, { timeoutMs: remaining() });
    await originalChild.getByLabel("Owner", { exact: true }).fill(item.owner, { timeoutMs: remaining() });
    await originalChild.getByRole("button", { name: "Commit child receipt", exact: true }).click({ timeoutMs: remaining() });
    item.receipt = await until(async () => { const text = await originalChild.locator("#result").textContent({ timeoutMs: remaining() }); return text && JSON.parse(text); }, "original child response", remaining());
    item.childAfter = await readState(originalChild); item.childFramesAfter = await frames(originalChild.id);
    const all = fixtures.allStats(); assert.equal(all.children.length, 1); assert.equal(all.requests.filter(request => request.method === "POST").length, 1);
    item.business = assertCreatedPageReceipt({ item, child: all.children[0], state: item.childAfter, receipt: item.receipt, frames: item.childFramesAfter }); remaining();
    await nativeCheckpoint("after-child");
  });
  await step("formal-turn-cleanup", async () => {
    report.turnCleanup = { result: await browser.client.turnEnded() };
    await assert.rejects(() => originalChild.domSnapshot({ timeoutMs: 1000 }), error => { report.turnCleanup.oldHandleError = String(error); return /STALE|turn|epoch|ended|control/i.test(String(error)); });
    report.turnCleanup.debugTargets = await worker.evaluate("chrome.debugger.getTargets().then(values=>values.map(({id,tabId,attached,type})=>({id,tabId,attached,type})))");
    assert.ok(!report.turnCleanup.debugTargets.some(target => target.attached && [formTab.id, source.id, originalChild.id].includes(target.tabId)), "Original task tab remains debugger attached after turn end");
    report.createdPageFinal = await worker.evaluate("__createdPageProvenance.stop()"); assert.equal(report.createdPageFinal.listenerPresent, false); assert.equal(report.createdPageFinal.events.length, 1);
    report.internalFocusEvents = await worker.evaluate("__managedFocusEvents");
    await extensionInventory("after-turn-cleanup");
  });
} catch (error) { report.error = error.stack; console.error("FAIL", error.stack); }
finally {
  if (child) try {
    const table = await processTable(), owned = new Set([child.pid]);
    let changed;
    do { changed = false; for (const process of table) if (owned.has(process.ParentProcessId) && !owned.has(process.ProcessId)) { owned.add(process.ProcessId); changed = true; } } while (changed);
    report.cleanup.browserProcessInventory = table.filter(process => owned.has(process.ProcessId));
  } catch (error) { report.cleanup.browserInventoryError = error.stack; }
  if (worker) {
    try { report.finalNativeStatus = await nativeStatus(); report.finalInternalFocusEvents = await worker.evaluate("globalThis.__managedFocusEvents??[]"); } catch (error) { report.cleanup.observationError = error.stack; }
  }
  if (inventoryConnection) try { await extensionInventory("before-browser-close"); } catch (error) { report.cleanup.extensionInventoryError = error.stack; }
  if (endpoint && worker) try { watch = await observeEOF(); report.cleanup.nativeExitWatch = watch.ready; } catch (error) { report.cleanup.nativeWatchError = error.stack; }
  if (browser) browser.close();
  if (control) try { report.cleanup.browserClose = { requestedAt: Date.now(), result: await control.call("Browser.close") }; } catch (error) { report.cleanup.browserCloseError = error.stack; }
  if (child) {
    let exited = await Promise.race([childExit, delay(15000).then(() => null)]);
    if (!exited) { report.cleanup.forcedBrowserTermination = true; child.kill(); exited = await Promise.race([childExit, delay(10000).then(() => null)]); }
    report.cleanup.browserExit = exited;
  }
  for (const connection of connections) connection.close();
  if (watch) report.cleanup.nativeExit = await watch.completed;
  if (report.cleanup.browserProcessInventory) try {
    report.cleanup.browserProcessesGone = await until(async () => {
      const table = await processTable(), remaining = report.cleanup.browserProcessInventory.filter(before => table.some(after => after.ProcessId === before.ProcessId && after.CreationDate === before.CreationDate));
      return remaining.length === 0 && { at: Date.now(), checked: report.cleanup.browserProcessInventory.length, remaining };
    }, "original browser process tree gone", 10000);
  } catch (error) { report.cleanup.browserTreeError = error.stack; }
  if (endpoint) try {
    report.cleanup.hostGone = await until(async () => !(await processTable()).some(value => value.ProcessId === endpoint.pid) && { at: Date.now() }, "original native host exit", 10000);
    report.cleanup.pipe = await until(() => pipeUnavailable(endpoint.socketPath), "native pipe gone", 5000);
    report.cleanup.endpointRecords = await until(async () => { const entries = await endpointRecords(); return entries.every(entry => entry.value.socketPath !== endpoint.socketPath) && entries; }, "native EOF descriptor cleanup", 5000);
  } catch (error) { report.cleanup.hostError = error.stack; }
  if (nativeExecutable) try { report.cleanup.privateHostProcesses = (await processTable()).filter(value => value.ExecutablePath && path.resolve(value.ExecutablePath).toLowerCase() === path.resolve(nativeExecutable).toLowerCase()); } catch (error) { report.cleanup.hostInventoryError = error.stack; }
  if (registrationAttempted) try { report.cleanup.registration = JSON.parse(await command("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", registryScript, "cleanup"])); } catch (error) { report.cleanup.registrationError = error.stack; }
  try { server.closeAllConnections(); if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); report.cleanup.serverClosed = true; } catch (error) { report.cleanup.serverError = error.stack; }
  report.fixture = { formRequests, createdPages: fixtures.allStats() };
  await save("fixture.json", report.fixture);
  await fs.writeFile(path.join(runDir, "browser.log"), logs.join(""));
  for (const name of ["chrome_debug.log", "debug.log"]) try { await fs.copyFile(path.join(profile, name), path.join(runDir, name)); } catch (error) { if (error.code !== "ENOENT") report.cleanup.logCopyError = error.stack; }
  try {
    report.sourceIdentity.after = { host: sha256(await fs.readFile(host)), sdk: await hashTree(sdkPath), extension: await hashTree(extension), sources: {} };
    for (const file of Object.keys(report.sourceIdentity.sources)) report.sourceIdentity.after.sources[file] = sha256(await fs.readFile(path.join(repo, file)));
    assert.equal(report.sourceIdentity.after.host, report.sourceIdentity.host); assert.deepEqual(report.sourceIdentity.after.sdk, report.sourceIdentity.sdk); assert.deepEqual(report.sourceIdentity.after.extension, report.sourceIdentity.stagedExtension); assert.deepEqual(report.sourceIdentity.after.sources, report.sourceIdentity.sources); report.sourceIdentity.unchanged = true;
  } catch (error) { report.cleanup.sourceIdentityError = error.stack; }
  report.endedAt = Date.now();
  report.passed = !report.error && report.steps.length === 5 && report.steps.every(step => step.passed) && report.sourceIdentity?.unchanged === true && report.cleanup.browserExit?.code === 0 && !report.cleanup.forcedBrowserTermination && !!report.cleanup.browserProcessesGone && report.cleanup.nativeExit?.result?.exitCode === 0 && !!report.cleanup.hostGone && !!report.cleanup.pipe && report.cleanup.privateHostProcesses?.length === 0 && report.cleanup.registration?.removed === true && report.cleanup.serverClosed === true && !Object.keys(report.cleanup).some(key => key.endsWith("Error"));
  report.exitCode = report.passed ? 0 : 1; await save("results.json", report);
  console.log("RESULT", JSON.stringify({ runDir, passed: report.passed, exitCode: report.exitCode, results: path.join(runDir, "results.json") })); process.exitCode = report.exitCode;
}
