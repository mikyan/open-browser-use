import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";
import WebSocket, { WebSocketServer } from "ws";
import { buildChromeExtension } from "../build-chrome-extension.mjs";
import { actionsFixture, checkExtendedActions } from "./actions-fixture.mjs";
import { diagnosticsFixture, checkDiagnostics } from "./diagnostics-fixture.mjs";
import { pauseFixture, checkGlobalPause } from "./pause-fixture.mjs";
import { siteAccessFixture, checkSiteAccess } from "./site-access-fixture.mjs";
import { elementScreenshotFixture, checkElementScreenshots } from "./element-screenshot-fixture.mjs";
import { popupFixture, checkChildTabAuthorization, checkAuxiliaryPopupRendering, checkAuxiliaryPopupLifecycle } from "./popup-fixture.mjs";
import { aiSnapshotFixture, fixtureRef, checkAISnapshotRefs, checkAISnapshotLifecycle, checkAISnapshotLimits } from "./ai-snapshot-fixture.mjs";
import { createNetworkWaitFixtures, networkPageURL, networkAPIURL, networkButton, checkNetworkReady, checkNetworkMatching, checkNetworkLifecycle } from "./network-waits-fixture.mjs";
import { createNavigationWaitFixtures, navigationPageURL, navigationTargetURL, navigationButton, navigationWitness, checkNavigationDirectAndReady, checkNavigationLoadStates, checkNavigationLifecycle } from "./navigation-waits-fixture.mjs";
import { createDirectDownloadFixtures, directDownloadURL, directDownloadErrors, prepareDirectDownloadTab, verifyDownloadedFile, checkDirectDownloads, checkDirectDownloadLifecycle } from "./direct-downloads-fixture.mjs";

// Playwright supplies the executable and the fixture's static YAML parser. No
// page/context connection is used: actions go through the public SDK and host.
const directory = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(directory, "../..");
const sourceExecutable = process.env.OBU_TEST_HOST_BINARY;
if (!sourceExecutable) throw new Error("Set OBU_TEST_HOST_BINARY to a built open-browser-use executable; see README.md");
await fs.access(sourceExecutable);
const artifactRoot = path.join(repo, ".tmp/browser-integration");
await fs.mkdir(artifactRoot, { recursive: true });
const runDir = await fs.mkdtemp(path.join(artifactRoot, "run-"));
const executable = path.join(runDir, process.platform === "win32" ? "native-host.exe" : "native-host");
await fs.copyFile(sourceExecutable, executable);
const goExecutable = process.env.OBU_TEST_GO_CLIENT_BINARY ? path.join(runDir, process.platform === "win32" ? "go-client.exe" : "go-client") : null;
if (goExecutable) await fs.copyFile(process.env.OBU_TEST_GO_CLIENT_BINARY, goExecutable);
const jsSnapshot = path.join(runDir, "js-sdk");
await fs.cp(path.join(repo, "packages/open-browser-use-js/dist"), jsSnapshot, { recursive: true });
const { connectOpenBrowserUse } = await import(pathToFileURL(path.join(jsSnapshot, "index.js")));
const pythonChecks = path.join(runDir, "python-checks.py");
await fs.copyFile(path.join(directory, "python-checks.py"), pythonChecks);
const temporaryRoot = await fs.realpath(os.tmpdir());
const socketDir = await fs.mkdtemp(path.join(temporaryRoot, "obu-browser-"));
const profile = path.join(runDir, "profile");
const extension = path.join(runDir, "extension");
const records = [];
const allowedPopupActivations = [];
const allowedWindowFocusEvents = [];
const browserLog = [];
const hostLog = [];
const nativeFrameStats = { frames: 0, maxFrameBytes: 0, starts: 0, chunks: 0, commits: 0 };
let bridgeClosing = false, bridgeFailure;
function failNativeBridge(error) {
  hostLog.push(`Native adapter ${bridgeClosing ? "shutdown" : "failure"}: ${error.stack ?? error}\n`);
  if (bridgeClosing || bridgeFailure) return;
  bridgeFailure = error;
  records.push({ name: "native-adapter-failure", passed: false, error: error.stack ?? String(error) });
  console.error("FAIL native adapter", error.message ?? error);
}
function writeNativeMessage(message) {
  if (bridgeClosing || bridgeFailure) return;
  if (host.stdin.destroyed || host.stdin.writableEnded || host.exitCode !== null) {
    failNativeBridge(new Error("Native host input closed during active acceptance"));
    return;
  }
  try {
    host.stdin.write(frame(JSON.parse(message.toString())), error => { if (error) failNativeBridge(error); });
  } catch (error) { failNativeBridge(error); }
}
let sourceIdentity;
const versions = { node: process.version, browserRunner: "playwright@1.64.0 (executable lookup and static YAML parsing; no page connection)" };
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(callback, label, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (bridgeFailure) throw bridgeFailure;
    try { const value = await callback(); if (value) return value; } catch {}
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
function frame(message) {
  const body = Buffer.from(JSON.stringify(message));
  assert.ok(body.length <= 64 * 1024 * 1024, "Extension message exceeds Chrome's 64 MiB native messaging limit");
  const header = Buffer.alloc(4);
  if (os.endianness() === "LE") header.writeUInt32LE(body.length); else header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}
function pngDimensions(base64) {
  const bytes = Buffer.from(base64, "base64");
  assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  assert.equal(bytes.subarray(12, 16).toString(), "IHDR");
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  assert.ok(width > 0 && height > 0);
  return { bytes, width, height };
}
function subprocess(command, args, { input, timeoutMs = 30000, ...options } = {}) {
  return new Promise((resolve, reject) => {
    const process = spawn(command, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], ...options });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { process.kill(); reject(new Error(`${command} exceeded test deadline`)); }, timeoutMs);
    process.stdout.on("data", data => stdout += data.toString());
    process.stderr.on("data", data => stderr += data.toString());
    process.once("error", error => { clearTimeout(timer); reject(error); });
    process.once("exit", code => { clearTimeout(timer); code === 0 ? resolve(stdout) : reject(new Error(`${command} exited ${code}: ${stderr}`)); });
    process.stdin.end(input);
  });
}
async function hashTree(root) {
  const files = {};
  async function visit(relative = "") {
    for (const item of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
      const name = path.join(relative, item.name);
      if (item.isDirectory() && item.name !== "__pycache__") await visit(name);
      else if (item.isFile() && /\.(m?js|py|json)$/.test(name)) files[name.replaceAll(path.sep, "/")] = createHash("sha256").update(await fs.readFile(path.join(root, name))).digest("hex");
    }
  }
  await visit();
  return files;
}
async function withMCPClient(executable, endpoint, sessionId, use) {
  const child = spawn(path.resolve(executable), ["mcp", "--socket", endpoint, "--session-id", sessionId, "--timeout", "15s"], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let id = 0, buffer = "", stderr = "";
  const pending = new Map();
  const fail = error => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); } pending.clear(); };
  const send = message => child.stdin.write(JSON.stringify(message) + "\n");
  const request = (method, params) => new Promise((resolve, reject) => {
    const requestId = ++id;
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`MCP ${method} timed out`)); }, 20000);
    pending.set(requestId, { resolve, reject, timer });
    send({ jsonrpc: "2.0", id: requestId, method, params });
  });
  child.stdout.on("data", chunk => {
    buffer += chunk.toString();
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      try {
        const response = JSON.parse(line), item = pending.get(response.id);
        if (!item) continue;
        pending.delete(response.id); clearTimeout(item.timer);
        response.error ? item.reject(new Error(JSON.stringify(response.error))) : item.resolve(response.result);
      } catch (error) { fail(error); }
    }
  });
  child.stderr.on("data", chunk => stderr += chunk.toString());
  child.once("error", fail);
  const closed = new Promise(resolve => child.once("exit", code => { fail(new Error(`MCP exited ${code}: ${stderr}`)); resolve(code); }));
  try {
    const initialized = await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "obu-network-integration", version: "1.0.0" } });
    assert.equal(initialized.protocolVersion, "2025-06-18");
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    return await use(async (method, params) => {
      const response = await request("tools/call", { name: "call", arguments: { method, params } });
      assert.equal(response.isError, false, JSON.stringify(response));
      assert.equal(response.structuredContent.error, undefined, JSON.stringify(response));
      return response.structuredContent.result;
    });
  } finally {
    child.stdin.end();
    const code = await Promise.race([closed, delay(2000).then(() => "timeout")]);
    if (code === "timeout") child.kill();
    fail(new Error("MCP fixture closed"));
  }
}
function nativeAdapter(url) {
  return `function __integrationConnectNative(name) {
    const messages = new Set(), disconnects = new Set(), queued = [];
    const socket = new WebSocket(${JSON.stringify(url)} + '?extensionId=' + chrome.runtime.id);
    socket.onopen = () => { for (const message of queued.splice(0)) socket.send(message); };
    socket.onmessage = event => { const message = JSON.parse(event.data); for (const fn of messages) fn(message); };
    socket.onclose = () => { for (const fn of disconnects) fn(); };
    return { name, onMessage: { addListener: fn => messages.add(fn), removeListener: fn => messages.delete(fn) },
      onDisconnect: { addListener: fn => disconnects.add(fn), removeListener: fn => disconnects.delete(fn) },
      postMessage: message => { const text = JSON.stringify(message); if (socket.readyState === 1) socket.send(text); else queued.push(text); },
      disconnect: () => socket.close() };
  }\n`;
}
async function workerConnection(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  let id = 0;
  const pending = new Map();
  const events = [];
  socket.on("message", raw => {
    const message = JSON.parse(raw.toString());
    if (message.method) events.push(message);
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id);
    clearTimeout(item.timer);
    message.error ? item.reject(new Error(JSON.stringify(message.error))) : item.resolve(message.result);
  });
  function call(method, params = {}) {
    return new Promise((resolve, reject) => {
      const requestId = ++id;
      const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`Test CDP timeout: ${method}`)); }, 20000);
      pending.set(requestId, { resolve, reject, timer });
      socket.send(JSON.stringify({ id: requestId, method, params }));
    });
  }
  return {
    call, events,
    close: () => socket.close(),
    async evaluate(expression) {
      const result = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    }
  };
}

const networkFixtures = createNetworkWaitFixtures();
const navigationFixtures = createNavigationWaitFixtures();
const directDownloads = createDirectDownloadFixtures();
let httpPort, actionVisits = 0;
const http = createServer(async (request, response) => {
  if (networkFixtures.handle(request, response, httpPort)) return;
  if (navigationFixtures.handle(request, response)) return;
  if (directDownloads.handle(request, response)) return;
  const route = new URL(request.url, "http://localhost").pathname;
  if (["/ai-snapshot", "/ai-snapshot-leaf", "/ai-snapshot-nested"].includes(route)) { response.setHeader("Content-Type", "text/html; charset=utf-8"); response.end(aiSnapshotFixture(route, httpPort, new URL(request.url, "http://localhost").searchParams)); return; }
  if (route === "/popup-child-authorization") { response.setHeader("Content-Type", "text/html; charset=utf-8"); response.end(popupFixture(httpPort)); return; }
  if (["/element-screenshots", "/element-screenshot-leaf", "/element-screenshot-nested"].includes(route)) { response.setHeader("Content-Type", "text/html; charset=utf-8"); response.end(elementScreenshotFixture(route, httpPort, new URL(request.url, "http://localhost").searchParams.get("replacement"))); return; }
  if (route === "/site-access-redirect") { response.writeHead(302, { Location: `http://localhost:${httpPort}/site-access` }); response.end(); return; }
  if (["/site-access", "/site-access-child"].includes(route)) { response.setHeader("Content-Type", "text/html; charset=utf-8"); response.end(siteAccessFixture(route, httpPort, new URL(request.url, "http://localhost").searchParams)); return; }
  if (route === "/pause-fixture") { response.setHeader("Content-Type", "text/html; charset=utf-8"); response.end(pauseFixture()); return; }
  if (route === "/diagnostics/fail") { request.socket.destroy(); return; }
  if (route === "/diagnostics/redirect") { response.writeHead(302, { Location: "/diagnostics/data" + new URL(request.url, "http://localhost").search }); response.end(); return; }
  if (route === "/diagnostics/data") { response.setHeader("Content-Type", "application/json"); response.end('{"ok":true}'); return; }
  if (route === "/download") {
    response.setHeader("Content-Type", "application/octet-stream");
    response.setHeader("Content-Disposition", 'attachment; filename="owned-download.txt"');
    response.end("Public SDK download bytes"); return;
  }
  if (route === "/fixture.js") {
    response.setHeader("Content-Type", "text/javascript");
    response.end(await fs.readFile(path.join(runDir, "fixture.js"))); return;
  }
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  if (route === "/diagnostics" || route === "/diagnostics/frame") { response.end(diagnosticsFixture(route.endsWith("/frame"), httpPort)); return; }
  if (route === "/transfers" || route === "/transfers-frame") {
    response.end(`<!doctype html><meta charset="utf-8"><label>Upload<input type="file" id="upload" multiple></label><output id="files"></output><a href="/download" download>Download fixture</a>
      ${route === "/transfers" ? `<iframe id="upload-frame" src="http://localhost:${httpPort}/transfers-frame"></iframe>` : ""}
      <script>upload.onchange=async()=>{document.querySelector('#files').textContent=JSON.stringify(await Promise.all([...upload.files].map(async file=>({name:file.name,text:await file.text()}))))};</script>`); return;
  }
  if (route === "/sentinel") { response.end("<title>Untouched sentinel</title><h1>User sentinel</h1>"); return; }
  if (route === "/actions/a" || route === "/actions/b") { response.end(actionsFixture(route, ++actionVisits)); return; }
  if (route === "/frame") {
    response.end(`<label>Frame field<input></label><button onclick="document.querySelector('#frame-result').textContent='clicked'">Frame action</button><output id="frame-result"></output><script>for(const type of ['pointerdown','pointerup','click','input','focusin'])document.addEventListener(type,event=>parent.postMessage({type:'integrationFrameEvent',event:type,url:location.href,target:event.target.tagName,text:event.target.textContent.slice(0,60),x:event.clientX,y:event.clientY,trusted:event.isTrusted,hasFocus:document.hasFocus(),visibility:document.visibilityState,scrollX,scrollY,activeElement:document.activeElement?.tagName},'*'));</script>`); return;
  }
  response.end(`<!doctype html><html><head><title>OBU SDK fixture</title><style>
    body{font:16px sans-serif;margin:20px}button,input,[contenteditable]{padding:8px;margin:4px}section{margin:12px 0}
    #covered{position:relative;display:inline-block}#overlay{position:absolute;inset:0;z-index:10;background:#ddd}
    iframe{width:420px;height:100px}#shadow-host{display:block}</style></head><body>
    <button aria-label="ARIA named action" onclick="document.querySelector('#role-result').textContent='clicked'">Icon</button><output id="role-result"></output>
    <button>Duplicate</button><button>Duplicate</button>
    <section id="covered"><button onclick="document.querySelector('#covered-result').textContent='clicked'">Covered action</button><div id="overlay" hidden></div></section><output id="covered-result"></output>
    <section id="react-root"></section><div role="textbox" aria-label="Rich editor" contenteditable="true">Initial</div>
    <section id="shadow-host"></section><output id="shadow-result"></output>
    <iframe id="same-frame" src="/frame"></iframe><iframe id="cross-frame" src="http://localhost:${httpPort}/frame"></iframe>
    <section><button id="raw-button" onclick="document.querySelector('#raw-result').textContent='clicked'">Raw action</button><output id="raw-result"></output>
    <button id="engine-button" onclick="document.querySelector('#engine-result').textContent=String(Number(document.querySelector('#engine-result').textContent||0)+1)">Engine action</button><output id="engine-result"></output></section>
    <script>globalThis.__integrationFrameEvents=[];globalThis.__integrationRootEvents=[];window.addEventListener('message',event=>{if(event.data?.type==='integrationFrameEvent')globalThis.__integrationFrameEvents.push(event.data)});for(const type of ['pointerdown','pointerup','click'])document.addEventListener(type,event=>globalThis.__integrationRootEvents.push({event:type,target:event.target.tagName,id:event.target.id,x:event.clientX,y:event.clientY,trusted:event.isTrusted}));</script>
    <script src="/fixture.js"></script></body></html>`);
});
const ws = new WebSocketServer({ host: "127.0.0.1", port: 0 });
let host, chrome, worker, browser, sentinel, activeEvents = [], windowFocusEvents = [];
try {
  await build({ entryPoints: [path.join(directory, "react-app.jsx")], outfile: path.join(runDir, "fixture.js"), bundle: true, format: "iife", platform: "browser" });
  await new Promise(resolve => http.listen(0, resolve));
  httpPort = http.address().port;
  if (!ws.address()) await new Promise(resolve => ws.once("listening", resolve));
  const websocketURL = `ws://127.0.0.1:${ws.address().port}`;
  await buildChromeExtension(extension);
  const productionExtensionHashes = await hashTree(extension);
  const backgroundFile = path.join(extension, "background.js");
  const background = await fs.readFile(backgroundFile, "utf8");
  const nativeCall = "chrome.runtime.connectNative(this.hostName)";
  assert.equal(background.split(nativeCall).length, 2, "Production connectNative call changed");
  await fs.writeFile(backgroundFile, nativeAdapter(websocketURL) + background.replace(nativeCall, "__integrationConnectNative(this.hostName)"));
  const manifestFile = path.join(extension, "manifest.json");
  const manifest = JSON.parse(await fs.readFile(manifestFile, "utf8"));
  manifest.content_security_policy.extension_pages = manifest.content_security_policy.extension_pages.replace("connect-src 'self'", `connect-src 'self' ${websocketURL}`);
  await fs.writeFile(manifestFile, JSON.stringify(manifest, null, 2));
  const pythonSnapshot = path.join(runDir, "python-sdk/open_browser_use");
  await fs.mkdir(pythonSnapshot, { recursive: true });
  for (const file of await fs.readdir(path.join(repo, "packages/open-browser-use-python/open_browser_use"))) {
    if (file.endsWith(".py")) await fs.copyFile(path.join(repo, "packages/open-browser-use-python/open_browser_use", file), path.join(pythonSnapshot, file));
  }
  sourceIdentity = {
    gitHead: (await subprocess("git", ["rev-parse", "HEAD"], { cwd: repo })).trim(),
    dirty: (await subprocess("git", ["status", "--porcelain", "--untracked-files=normal"], { cwd: repo })).trim().length > 0,
    sha256: {
      nativeHost: createHash("sha256").update(await fs.readFile(executable)).digest("hex"),
      productionExtension: productionExtensionHashes,
      stagedExtension: await hashTree(extension),
      jsDist: await hashTree(jsSnapshot),
      pythonSDK: await hashTree(pythonSnapshot),
      pythonChecks: createHash("sha256").update(await fs.readFile(pythonChecks)).digest("hex"),
      harness: createHash("sha256").update(await fs.readFile(fileURLToPath(import.meta.url))).digest("hex")
    }
  };
  sourceIdentity.sha256.actionsFixture = createHash("sha256").update(await fs.readFile(path.join(directory, "actions-fixture.mjs"))).digest("hex");
  sourceIdentity.sha256.diagnosticsFixture = createHash("sha256").update(await fs.readFile(path.join(directory, "diagnostics-fixture.mjs"))).digest("hex");
  sourceIdentity.sha256.pauseFixture = createHash("sha256").update(await fs.readFile(path.join(directory, "pause-fixture.mjs"))).digest("hex");
  sourceIdentity.sha256.siteAccessFixture = createHash("sha256").update(await fs.readFile(path.join(directory, "site-access-fixture.mjs"))).digest("hex");
  sourceIdentity.sha256.elementScreenshotFixture = createHash("sha256").update(await fs.readFile(path.join(directory, "element-screenshot-fixture.mjs"))).digest("hex");
  sourceIdentity.sha256.popupFixture = createHash("sha256").update(await fs.readFile(path.join(directory, "popup-fixture.mjs"))).digest("hex");
  sourceIdentity.sha256.aiSnapshotFixture = createHash("sha256").update(await fs.readFile(path.join(directory, "ai-snapshot-fixture.mjs"))).digest("hex");
  sourceIdentity.sha256.networkWaitsFixture = createHash("sha256").update(await fs.readFile(path.join(directory, "network-waits-fixture.mjs"))).digest("hex");
  sourceIdentity.sha256.navigationWaitsFixture = createHash("sha256").update(await fs.readFile(path.join(directory, "navigation-waits-fixture.mjs"))).digest("hex");
  sourceIdentity.sha256.directDownloadsFixture = createHash("sha256").update(await fs.readFile(path.join(directory, "direct-downloads-fixture.mjs"))).digest("hex");
  if (goExecutable) sourceIdentity.sha256.goClient = createHash("sha256").update(await fs.readFile(goExecutable)).digest("hex");

  host = spawn(path.resolve(executable), ["host", "--socket-dir", socketDir], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  host.stderr.on("data", data => hostLog.push(data.toString()));
  host.stdin.on("error", failNativeBridge);
  host.once("error", failNativeBridge);
  host.once("exit", (code, signal) => {
    if (!bridgeClosing) failNativeBridge(new Error(`Native host exited during active acceptance: ${code} ${signal}`));
  });
  let extensionSocket, extensionId, nativeBuffer = Buffer.alloc(0);
  const outbound = [];
  ws.on("connection", (socket, request) => {
    socket.on("error", failNativeBridge);
    if (bridgeClosing || bridgeFailure) { socket.terminate(); return; }
    extensionSocket = socket;
    extensionId = new URL(request.url, websocketURL).searchParams.get("extensionId");
    for (const message of outbound.splice(0)) socket.send(message);
    socket.on("message", writeNativeMessage);
  });
  host.stdout.on("data", data => {
    try {
      nativeBuffer = Buffer.concat([nativeBuffer, data]);
      while (nativeBuffer.length >= 4) {
        const length = os.endianness() === "LE" ? nativeBuffer.readUInt32LE() : nativeBuffer.readUInt32BE();
        assert.ok(length <= 1024 * 1024, "Host message exceeds Chrome's 1 MiB native messaging limit");
        if (nativeBuffer.length < 4 + length) break;
        const message = nativeBuffer.subarray(4, 4 + length).toString();
        nativeBuffer = nativeBuffer.subarray(4 + length);
        nativeFrameStats.frames++;
        nativeFrameStats.maxFrameBytes = Math.max(nativeFrameStats.maxFrameBytes, length);
        const method = JSON.parse(message).method;
        if (method === "obu.native.start") nativeFrameStats.starts++;
        if (method === "obu.native.chunk") nativeFrameStats.chunks++;
        if (method === "obu.native.commit") nativeFrameStats.commits++;
        if (extensionSocket?.readyState === WebSocket.OPEN) extensionSocket.send(message); else outbound.push(message);
      }
    } catch (error) { failNativeBridge(error); }
  });
  const endpoint = (await until(async () => JSON.parse(await fs.readFile(path.join(socketDir, "active.json"), "utf8")), "host endpoint")).socketPath;
  const chromiumBinary = process.env.OBU_TEST_CHROMIUM_BINARY || chromium.executablePath();
  await fs.access(chromiumBinary);
  await fs.mkdir(path.join(profile, "Default"), { recursive: true });
  await fs.mkdir(path.join(runDir, "downloads"));
  await fs.writeFile(path.join(profile, "Default", "Preferences"), JSON.stringify({ download: { default_directory: path.join(runDir, "downloads"), prompt_for_download: false } }));
  chrome = spawn(chromiumBinary, [
    `--user-data-dir=${profile}`, "--remote-debugging-port=0", `--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
    "--no-first-run", "--no-default-browser-check", "--site-per-process", "--no-sandbox", "--enable-logging=stderr", "about:blank"
  ], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
  chrome.stderr.on("data", data => browserLog.push(data.toString()));
  chrome.on("exit", (code, signal) => browserLog.push(`Browser exited: ${code} ${signal}\n`));
  const debugPort = await until(async () => (await fs.readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0], "Chromium debug port");
  await until(() => extensionSocket?.readyState === WebSocket.OPEN && extensionId, "extension native adapter");
  worker = await until(async () => {
    const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
    for (const target of targets.filter(target => target.type === "service_worker" && target.url === `chrome-extension://${extensionId}/background.js`)) {
      const connection = await workerConnection(target.webSocketDebuggerUrl);
      if (await connection.evaluate("chrome.runtime.getManifest().name") === "Open Browser Use") return connection;
      connection.close();
    }
  }, "extension worker");
  versions.chromium = await worker.evaluate("navigator.userAgent");
  versions.extension = await worker.evaluate("chrome.runtime.getManifest().version");
  sentinel = await worker.evaluate(`chrome.tabs.create({url:${JSON.stringify(`http://127.0.0.1:${httpPort}/sentinel`)},active:true})`);
  await worker.evaluate(`globalThis.__integrationActivations=[];globalThis.__integrationFrames=[];chrome.tabs.onActivated.addListener(info=>globalThis.__integrationActivations.push(info));chrome.debugger.onEvent.addListener((source,method,params)=>{if(method==='Target.attachedToTarget'&&params?.targetInfo?.type==='iframe')globalThis.__integrationFrames.push({tabId:source.tabId,source,sessionId:params.sessionId,targetId:params.targetInfo.targetId,type:params.targetInfo.type,url:params.targetInfo.url});})`);
  await worker.evaluate("globalThis.__integrationWindowFocus=[];chrome.windows.onFocusChanged.addListener(windowId=>globalThis.__integrationWindowFocus.push(windowId))");
  const fixtureURL = `http://127.0.0.1:${httpPort}/`;
  console.log("HARNESS", JSON.stringify({ endpoint, fixtureURL, runDir, sentinelId: sentinel.id }));
  browser = await connectOpenBrowserUse({ socketPath: endpoint, sessionId: "js-browser-integration", turnId: "acceptance", timeoutMs: 15000 });
  const tab = await browser.newTab();
  async function activeInvariant() {
    const active = await worker.evaluate(`chrome.tabs.query({active:true,windowId:${sentinel.windowId}})`);
    assert.equal(active[0]?.id, sentinel.id, "Agent action changed the active tab");
    const events = await worker.evaluate("globalThis.__integrationActivations");
    assert.ok(events.every(event => event.tabId === sentinel.id || allowedPopupActivations.some(allowed => allowed.tabId === event.tabId && allowed.windowId === event.windowId)), `Agent temporarily activated another tab: ${JSON.stringify(events)}`);
    for (const allowed of allowedPopupActivations) assert.ok(events.filter(event => event.tabId === allowed.tabId && event.windowId === allowed.windowId).length <= 1, "Popup activation repeated after its sole-tab creation");
    const focusEvents = await worker.evaluate("globalThis.__integrationWindowFocus");
    assert.ok(focusEvents.every((windowId, index) => allowedWindowFocusEvents.some(allowed => allowed.index === index && allowed.windowId === windowId)), `Unexpected browser window focus event: ${JSON.stringify(focusEvents)}`);
    assert.ok(allowedWindowFocusEvents.every(allowed => focusEvents[allowed.index] === allowed.windowId), "Window-focus history changed after attribution");
  }
  async function createAuxiliaryPopup(url) {
    const popup = await worker.evaluate(`chrome.windows.create({url:${JSON.stringify(url)},type:'popup',focused:false,width:520,height:480})`);
    assert.equal(popup.type, "popup"); assert.equal(popup.focused, false); assert.equal(popup.tabs.length, 1);
    allowedPopupActivations.push({ tabId: popup.tabs[0].id, windowId: popup.id, url, fixture: new URL(url).searchParams.get("auxiliary"), reason: "sole tab created in an unfocused popup window" });
    return popup;
  }
  const closeAuxiliaryPopup = id => worker.evaluate(`chrome.windows.remove(${id}).catch(error=>{if(!/No window|Invalid window/i.test(String(error)))throw error})`);
  async function test(name, run) {
    if (bridgeFailure) throw bridgeFailure;
    if (process.env.OBU_TEST_CASES && name !== "js-raw-navigation-before-engine" && !new RegExp(process.env.OBU_TEST_CASES).test(name)) return;
    const start = Date.now();
    let detail, failure;
    try { detail = await run(); } catch (error) { failure = error; }
    try { await activeInvariant(); } catch (error) { failure = failure ? new AggregateError([failure, error], `${failure.message}; ${error.message}`) : error; }
    if (failure) { records.push({ name, passed: false, elapsedMs: Date.now() - start, error: failure.stack }); console.error("FAIL", name, failure.message); }
    else { records.push({ name, passed: true, elapsedMs: Date.now() - start, detail }); console.log("PASS", name); }
  }
  await test("js-file-chooser-public-concurrent", async () => {
    const transfers = await connectOpenBrowserUse({ socketPath: endpoint, sessionId: "js-transfers", timeoutMs: 15000 });
    try {
      const uploadPath = path.join(runDir, "public-upload.txt");
      const text = "Public SDK upload 中文";
      await fs.writeFile(uploadPath, text);
      const owned = await transfers.newTab();
      await transfers.cdp.navigate(owned.id, fixtureURL + "transfers");
      const results = [];
      for (const target of [owned, owned.frameLocator("#upload-frame")]) {
        const [chooser] = await Promise.all([
          transfers.client.waitForFileChooser(owned.id, 5000),
          target.getByLabel("Upload", { exact: true }).click({ timeoutMs: 5000 })
        ]);
        await transfers.client.setFileChooserFiles(chooser.fileChooserId, [uploadPath]);
        await until(async () => (await target.locator("#files").textContent()).includes(text), "actual selected file bytes");
        results.push(JSON.parse(await target.locator("#files").textContent()));
        const [clear] = await Promise.all([
          transfers.client.waitForFileChooser(owned.id, 5000),
          target.getByLabel("Upload", { exact: true }).click({ timeoutMs: 5000 })
        ]);
        await transfers.client.setFileChooserFiles(clear.fileChooserId, []);
        assert.equal(await target.locator("#files").textContent(), "[]");
      }
      return { results };
    } finally { try { await transfers.client.finalizeTabs([]); } finally { transfers.close(); } }
  });
  await test("js-raw-navigation-before-engine", async () => {
    await browser.cdp.navigate(tab.id, fixtureURL);
    assert.equal(await tab.evaluate("document.title"), "OBU SDK fixture");
    await tab.getByRole("button", { name: "ARIA named action", exact: true }).click();
    assert.equal(await tab.locator("#role-result").textContent(), "clicked");
    return tab.engineInfo();
  });
  await test("js-native-large-requests", async () => {
    const clients = [], before = { ...nativeFrameStats }, witnesses = [];
    const hostPID = host.pid;
    try {
      for (let index = 0; index < 2; index++) {
        const client = await connectOpenBrowserUse({ socketPath: endpoint, sessionId: `native-large-${index}`, timeoutMs: 15000 });
        clients.push(client);
        const owned = await client.newTab();
        await client.cdp.navigate(owned.id, fixtureURL);
        const text = `${index}:中文🌏<&>"\\\n`.repeat(140_000);
        const bytes = Buffer.from(text, "utf8"), sha256 = createHash("sha256").update(bytes).digest("hex");
        assert.ok(bytes.length > 2 * 1024 * 1024);
        const expression = `(async()=>{const text=${JSON.stringify(text)};globalThis.__nativeLargeExecutions=(globalThis.__nativeLargeExecutions||0)+1;const bytes=new TextEncoder().encode(text);return {bytes:bytes.length,sha256:Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join(''),executions:globalThis.__nativeLargeExecutions}})()`;
        witnesses.push({ owned, expression, expected: { bytes: bytes.length, sha256, executions: 1 } });
      }
      const results = await Promise.all(witnesses.map(async value => {
        const result = await value.owned.evaluate(value.expression, { awaitPromise: true });
        assert.deepEqual(result, value.expected);
        assert.equal(await value.owned.evaluate("globalThis.__nativeLargeExecutions"), 1);
        return result;
      }));
      for (const client of clients) await client.client.request("ping");
      assert.equal(host.pid, hostPID); assert.equal(host.exitCode, null);
      assert.equal(nativeFrameStats.starts - before.starts, 2);
      assert.equal(nativeFrameStats.commits - before.commits, 2);
      assert.ok(nativeFrameStats.chunks - before.chunks >= 8);
      const detail = { results, sameHostPID: hostPID, endpointUnchanged: true, nativeFrameLimit: 1024 * 1024,
        maxFrameBytes: nativeFrameStats.maxFrameBytes, chunkFrames: nativeFrameStats.chunks - before.chunks };
      await fs.writeFile(path.join(runDir, "native-large-requests.json"), JSON.stringify(detail, null, 2));
      return detail;
    } finally {
      for (const client of clients) { try { await client.client.finalizeTabs([]); } finally { client.close(); } }
    }
  });
  await test("js-element-screenshots-offscreen-frames", async () => checkElementScreenshots({
    browser, fixtureURL,
    saveScreenshot: (name, bytes) => fs.writeFile(path.join(runDir, `${name}.png`), bytes),
    oopifTargets: () => worker.evaluate("globalThis.__integrationFrames")
  }));
  await test("js-child-tab-attachment-authorization", async () => checkChildTabAuthorization({
    connectBrowser: suffix => connectOpenBrowserUse({ socketPath: endpoint, sessionId: `js-${suffix}`, timeoutMs: 15000 }),
    getWorker: () => worker, fixtureURL, assert, until,
    saveDetail: detail => fs.writeFile(path.join(runDir, "child-tab-authorization.json"), JSON.stringify(detail, null, 2))
  }));
  for (const [suffix, check] of [["rendering", checkAuxiliaryPopupRendering], ["lifecycle", checkAuxiliaryPopupLifecycle]]) {
    await test(`js-auxiliary-popup-${suffix}`, async () => check({
      connectBrowser: name => connectOpenBrowserUse({ socketPath: endpoint, sessionId: `js-${name}`, timeoutMs: 15000 }),
      getWorker: () => worker, fixtureURL, createPopup: createAuxiliaryPopup, closePopup: closeAuxiliaryPopup,
      sentinelWindowId: sentinel.windowId, assert, until,
      saveDetail: (name, detail) => fs.writeFile(path.join(runDir, `${name}.json`), JSON.stringify(detail, null, 2)),
      saveScreenshot: async (name, screenshot, owned) => {
        const png = pngDimensions(screenshot.base64);
        await fs.writeFile(path.join(runDir, `${name}.png`), png.bytes);
        const viewport = await owned.evaluate("({width:innerWidth,height:innerHeight,dpr:devicePixelRatio})");
        assert.equal(png.width, Math.round(viewport.width * viewport.dpr));
        assert.equal(png.height, Math.round(viewport.height * viewport.dpr));
        return { width: png.width, height: png.height, bytes: png.bytes.length, viewport };
      }
    }));
  }
  for (const [suffix, check] of [["refs-and-frames", checkAISnapshotRefs], ["lifecycle", checkAISnapshotLifecycle], ["limits-and-cancellation", checkAISnapshotLimits]]) {
    await test(`js-ai-snapshot-${suffix}`, async () => {
      const ai = await connectOpenBrowserUse({ socketPath: endpoint, sessionId: `js-ai-snapshot-${suffix}`, timeoutMs: 15000 });
      try {
        return await check({
          browser: ai, fixtureURL,
          saveDetail: (name, detail) => fs.writeFile(path.join(runDir, `${name}.json`), JSON.stringify(detail, null, 2)),
          saveScreenshot: (name, bytes) => fs.writeFile(path.join(runDir, `${name}.png`), bytes),
          oopifTargets: () => worker.evaluate("globalThis.__integrationFrames"),
          ungroup: tabId => worker.evaluate(`chrome.tabs.ungroup(${tabId})`),
          connectSuccessor: () => connectOpenBrowserUse({ socketPath: endpoint, sessionId: `js-ai-successor-${suffix}`, timeoutMs: 15000 })
        });
      } finally { try { await ai.client.finalizeTabs([]); } finally { ai.close(); } }
    });
  }
  for (const [suffix, check] of [["ready-and-headers", checkNetworkReady], ["matching-and-retention", checkNetworkMatching], ["lifecycle", checkNetworkLifecycle]]) {
    await test(`js-network-waits-${suffix}`, async () => {
      const network = await connectOpenBrowserUse({ socketPath: endpoint, sessionId: `js-network-${suffix}`, timeoutMs: 15000 });
      try {
        assert.equal((await network.client.getInfo()).metadata.networkWaitVersion, 1);
        const detail = await check({ browser: network, fixtureURL, server: networkFixtures, until,
          oopifTargets: () => worker.evaluate("globalThis.__integrationFrames"),
          ungroup: tabId => worker.evaluate(`chrome.tabs.ungroup(${tabId})`),
          connectSuccessor: () => connectOpenBrowserUse({ socketPath: endpoint, sessionId: `js-network-successor-${suffix}`, timeoutMs: 15000 }) });
        await fs.writeFile(path.join(runDir, `network-waits-${suffix}.json`), JSON.stringify(detail, null, 2));
        return detail;
      } finally { try { await network.client.finalizeTabs([]); } finally { network.close(); } }
    });
  }
  for (const [suffix, check] of [["direct-and-ready", checkNavigationDirectAndReady], ["load-states", checkNavigationLoadStates], ["lifecycle", checkNavigationLifecycle]]) {
    await test(`js-navigation-waits-${suffix}`, async () => {
      const navigation = await connectOpenBrowserUse({ socketPath: endpoint, sessionId: `js-navigation-waits-${suffix}`, timeoutMs: 15000 });
      try {
        const detail = await check({ browser: navigation, fixtureURL, server: navigationFixtures, until,
          connectOther: () => connectOpenBrowserUse({ socketPath: endpoint, sessionId: `js-navigation-successor-${suffix}`, timeoutMs: 15000 }),
          ungroup: tabId => worker.evaluate(`chrome.tabs.ungroup(${tabId})`),
          startTrace: tabId => worker.evaluate(`(()=>{
            const tabId=${JSON.stringify(tabId)};
            const traces=globalThis.__integrationNavigationNetwork??=new Map();
            const prior=traces.get(tabId);if(prior)chrome.debugger.onEvent.removeListener(prior.listener);
            const entry={tabId,startedAt:Date.now(),events:[],dropped:0};
            entry.listener=(source,method,params)=>{
              if(source.tabId!==tabId||!['Network.requestWillBeSent','Network.responseReceived','Network.loadingFinished','Network.loadingFailed'].includes(method))return;
              if(entry.events.length>=200){entry.dropped++;return;}
              const event={method,source:{tabId:source.tabId,sessionId:source.sessionId},at:Date.now(),requestId:params.requestId,timestamp:params.timestamp,type:params.type,frameId:params.frameId,loaderId:params.loaderId};
              if(params.request)event.request={url:params.request.url.slice(0,4096),method:params.request.method};
              if(params.response)event.response={url:params.response.url.slice(0,4096),status:params.response.status,protocol:params.response.protocol};
              if(params.redirectResponse)event.redirectResponse={url:params.redirectResponse.url.slice(0,4096),status:params.redirectResponse.status};
              if(method==='Network.loadingFinished')event.encodedDataLength=params.encodedDataLength;
              if(method==='Network.loadingFailed'){event.errorText=params.errorText?.slice(0,512);event.canceled=params.canceled;event.blockedReason=params.blockedReason;}
              entry.events.push(event);
            };
            traces.set(tabId,entry);chrome.debugger.onEvent.addListener(entry.listener);return {tabId,startedAt:entry.startedAt};
          })()`),
          getTrace: tabId => worker.evaluate(`(()=>{
            const tabId=${JSON.stringify(tabId)},traces=globalThis.__integrationNavigationNetwork,entry=traces?.get(tabId);
            if(!entry)return {tabId,error:'Native network trace was not registered'};
            chrome.debugger.onEvent.removeListener(entry.listener);traces.delete(tabId);
            return {tabId,startedAt:entry.startedAt,events:entry.events,dropped:entry.dropped};
          })()`) });
        await fs.writeFile(path.join(runDir, `navigation-waits-${suffix}.json`), JSON.stringify(detail, null, 2));
        return detail;
      } catch (error) {
        if (error.navigationFixture) await fs.writeFile(path.join(runDir, `navigation-waits-${suffix}-failure.json`), JSON.stringify({ error: String(error), ...error.navigationFixture }, null, 2));
        throw error;
      } finally { try { await navigation.client.finalizeTabs([]); } finally { navigation.close(); } }
    });
  }
  await test("js-role-name-yaml-snapshot", async () => {
    const snapshot = await tab.domSnapshot();
    assert.match(snapshot, /button "ARIA named action"/);
    assert.match(snapshot, /textbox "Controlled name"/);
    assert.match(await tab.getByLabel("Controlled name").ariaSnapshot(), /textbox "Controlled name"/);
    assert.match(await tab.frameLocator("#cross-frame").getByRole("button", { name: "Frame action", exact: true }).ariaSnapshot(), /button "Frame action"/);
    await fs.writeFile(path.join(runDir, "snapshot.yaml"), snapshot);
  });
  await test("js-strictness", async () => {
    await assert.rejects(tab.getByRole("button", { name: "Duplicate", exact: true }).click({ timeoutMs: 500 }), /strict mode violation/);
  });
  await test("js-overlay-actionability-wait", async () => {
    await tab.evaluate("document.querySelector('#overlay').hidden=false;setTimeout(()=>document.querySelector('#overlay').hidden=true,700)");
    const started = Date.now();
    await tab.getByRole("button", { name: "Covered action", exact: true }).click({ timeoutMs: 4000 });
    assert.ok(Date.now() - started >= 500, "Click failed to wait for overlay removal");
    assert.equal(await tab.locator("#covered-result").textContent(), "clicked");
  });
  await test("js-controlled-react-and-contenteditable", async () => {
    await tab.getByLabel("Controlled name").fill("Ada 中文");
    assert.equal(await tab.getByLabel("Controlled name").inputValue(), "Ada 中文");
    assert.equal(await tab.locator("#controlled-result").textContent(), "Ada 中文");
    await tab.getByRole("textbox", { name: "Rich editor" }).fill("Rich 中文 content");
    assert.equal(await tab.getByRole("textbox", { name: "Rich editor" }).textContent(), "Rich 中文 content");
  });
  await test("js-open-shadow", async () => {
    await tab.getByRole("button", { name: "Shadow action", exact: true }).click();
    assert.equal(await tab.locator("#shadow-result").textContent(), "clicked");
  });
  for (const [name, selector] of [["same-origin", "#same-frame"], ["out-of-process", "#cross-frame"]]) {
    await test(`js-${name}-frame`, async () => {
      const frame = tab.frameLocator(selector);
      if (name === "out-of-process") {
        const diagnostic = { frames: await worker.evaluate("globalThis.__integrationFrames"), targets: await worker.evaluate("chrome.debugger.getTargets()"), frameDOM: await tab.evaluate("Array.from(document.querySelectorAll('iframe'),frame=>({src:frame.src,box:frame.getBoundingClientRect().toJSON()}))") };
        await fs.writeFile(path.join(runDir, "oopif-before-read.json"), JSON.stringify(diagnostic, null, 2));
      }
      console.log("FRAME", name, "read", await frame.getByLabel("Frame field").inputValue());
      await frame.getByLabel("Frame field").fill(`Frame ${name} 中文`);
      console.log("FRAME", name, "filled");
      await frame.getByRole("button", { name: "Frame action" }).click();
      assert.equal(await frame.getByLabel("Frame field").inputValue(), `Frame ${name} 中文`);
      assert.equal(await frame.locator("#frame-result").textContent(), "clicked");
      if (name === "out-of-process") {
        const targets = await worker.evaluate("globalThis.__integrationFrames");
        assert.ok(targets.some(target => target.tabId === tab.id), "No actual OOPIF target observed");
        return targets;
      }
    });
  }
  await test("js-oopif-created-and-navigated", async () => {
    const trace = [];
    const frameURL = `http://localhost:${httpPort}/frame`;
    await tab.evaluate(`new Promise(resolve=>{const frame=document.createElement('iframe');frame.id='late-frame';frame.onload=()=>resolve(true);frame.src=${JSON.stringify(frameURL + "?created=1")};document.body.append(frame)})`, { awaitPromise: true });
    const frame = tab.frameLocator("#late-frame");
    try {
    await frame.getByLabel("Frame field").fill("Created later 中文");
    assert.equal(await frame.getByLabel("Frame field").inputValue(), "Created later 中文");
    trace.push({ stage: "created-before-click", button: await frame.getByRole("button", { name: "Frame action" }).boundingBox(), iframe: await tab.locator("#late-frame").boundingBox(), root: await tab.evaluate("({scrollX,scrollY,visibility:document.visibilityState,hasFocus:document.hasFocus()})") });
    await frame.getByRole("button", { name: "Frame action" }).click();
    let clickResult = await frame.locator("#frame-result").textContent();
    for (let attempt = 0; clickResult !== "clicked" && attempt < 5; attempt++) { await delay(100); clickResult = await frame.locator("#frame-result").textContent(); }
    assert.equal(clickResult, "clicked", "Created OOPIF button did not receive click");
    await tab.evaluate(`new Promise(resolve=>{const frame=document.querySelector('#late-frame');frame.onload=()=>resolve(true);frame.src=${JSON.stringify(frameURL + "?navigated=2")}})`, { awaitPromise: true });
    assert.equal(await frame.getByLabel("Frame field").inputValue(), "");
    await frame.getByLabel("Frame field").fill("New document 中文");
    trace.push({ stage: "navigated-before-click", button: await frame.getByRole("button", { name: "Frame action" }).boundingBox(), iframe: await tab.locator("#late-frame").boundingBox() });
    await frame.getByRole("button", { name: "Frame action" }).click();
    assert.equal(await frame.locator("#frame-result").textContent(), "clicked");
    assert.equal(await frame.getByLabel("Frame field").inputValue(), "New document 中文");
    } finally {
      await fs.writeFile(path.join(runDir, "dynamic-oopif.json"), JSON.stringify({ trace, events: await tab.evaluate("globalThis.__integrationFrameEvents"), rootEvents: await tab.evaluate("globalThis.__integrationRootEvents") }, null, 2));
    await tab.evaluate("document.querySelector('#late-frame').remove()");
    }
  });
  await test("js-pointer-feedback-and-raw-cdp-coexistence", async () => {
    await tab.evaluate(`globalThis.__integrationClicks=[];new MutationObserver(records=>{for(const record of records)for(const node of record.addedNodes)if(node.dataset?.testid==='browser-agent-click')globalThis.__integrationClicks.push({x:parseFloat(node.style.left),y:parseFloat(node.style.top)});}).observe(document.documentElement,{childList:true,subtree:true})`);
    const expected = await tab.getByRole("button", { name: "Engine action", exact: true }).boundingBox();
    await tab.getByRole("button", { name: "Engine action", exact: true }).click();
    assert.equal(await tab.locator("#engine-result").textContent(), "1");
    const pointer = await tab.evaluate(`(()=>{const root=document.querySelector('#open-browser-use-cursor-root'); const cursor=root?.querySelector('[data-testid="browser-agent-cursor"]'); const target=root?.querySelector('[data-testid="browser-agent-target"]'); return {root:!!root,cursor:!!cursor,cursorVisible:cursor&&getComputedStyle(cursor).visibility!=="hidden"&&getComputedStyle(cursor).display!=="none",targetDisplay:target&&getComputedStyle(target).display,clicks:globalThis.__integrationClicks};})()`);
    assert.ok(pointer.root && pointer.cursor && pointer.cursorVisible, JSON.stringify(pointer));
    assert.equal(pointer.targetDisplay, "block", "The clicked element is not highlighted");
    assert.ok(pointer.clicks.some(point => Math.abs(point.x - expected.x - expected.width / 2) <= 2 && Math.abs(point.y - expected.y - expected.height / 2) <= 2), "No click feedback at the dispatched position");
    assert.equal(await tab.evaluate("document.title"), "OBU SDK fixture");
    await tab.getByRole("button", { name: "ARIA named action", exact: true }).hover();
    return pointer;
  });
  await test("js-mouse-and-keyboard", async () => {
    const input = tab.getByLabel("Controlled name");
    await input.click();
    await tab.keyboard.press("ControlOrMeta+A");
    await tab.keyboard.insertText("Keyboard 中文");
    await tab.keyboard.type("!");
    assert.equal(await input.inputValue(), "Keyboard 中文!");
    assert.equal(await tab.locator("#controlled-result").textContent(), "Keyboard 中文!");
    const box = await tab.getByRole("button", { name: "Raw action", exact: true }).boundingBox();
    await tab.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await tab.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    assert.equal(await tab.locator("#raw-result").textContent(), "clicked");
    await tab.mouse.wheel(0, 20);
  });
  await test("js-screenshot", async () => {
    const dimensions = await tab.evaluate("({width:innerWidth,height:innerHeight,dpr:devicePixelRatio})");
    const screenshot = await tab.screenshot();
    assert.equal(screenshot.mimeType, "image/png");
    const viewport = pngDimensions(screenshot.base64);
    assert.equal(viewport.width, Math.round(dimensions.width * dimensions.dpr));
    assert.equal(viewport.height, Math.round(dimensions.height * dimensions.dpr));
    await fs.writeFile(path.join(runDir, "background-tab.png"), viewport.bytes);
    await tab.evaluate("document.body.style.backgroundColor='rgb(64,180,120)'");
    const changed = pngDimensions((await tab.screenshot()).base64);
    assert.notDeepEqual(changed.bytes, viewport.bytes, "Screenshot is stale after a visible DOM mutation");
    const crop = pngDimensions((await tab.screenshot({ clip: { x: 0, y: 0, width: 100, height: 60 } })).base64);
    assert.equal(crop.width, Math.round(100 * dimensions.dpr));
    assert.equal(crop.height, Math.round(60 * dimensions.dpr));
    await tab.evaluate("document.body.style.minHeight='1600px'");
    const full = pngDimensions((await tab.screenshot({ fullPage: true })).base64);
    assert.ok(full.height >= Math.round(1600 * dimensions.dpr));
    assert.ok(full.height > viewport.height);
    return { viewport: { width: viewport.width, height: viewport.height }, crop: { width: crop.width, height: crop.height }, full: { width: full.width, height: full.height }, bytes: viewport.bytes.length };
  });
  await test("js-navigation", async () => {
    await tab.goto(fixtureURL + "?navigated=1");
    await tab.waitForURL(fixtureURL + "?navigated=1");
    await tab.waitForLoadState();
    assert.equal(await tab.getByLabel("Controlled name").inputValue(), "");
  });
  for (const kind of ["cli", "mcp"]) await test(`${kind}-network-waits-cold-arm`, async () => {
    const sessionId = `${kind}-network-integration`;
    const network = await connectOpenBrowserUse({ socketPath: endpoint, sessionId, turnId: "network-acceptance", timeoutMs: 15000 });
    const key = `${kind}-network-cold`;
    try {
      // Explicit raw navigation keeps the first engine attachment and its
      // ready acknowledgement in the entry point under test.
      const owned = await network.newTab();
      await network.cdp.navigate(owned.id, networkPageURL(fixtureURL, key));
      const scope = { session_id: sessionId, turn_id: network.client.turnId, control_epoch: network.client.controlEpoch };
      const check = async call => {
        const url = networkAPIURL(fixtureURL, key);
        const armed = await call("armNetworkWait", { ...scope, tabId: owned.id, event: "response", match: { url, method: "POST", status: 201 }, timeoutMs: 10000 });
        assert.ok(armed.waiterId && armed.remainingMs > 0);
        try {
          await call("browserAction", { ...scope, tabId: owned.id, action: "click", locator: [{ kind: "role", role: "button", name: networkButton, exact: true }], timeoutMs: 5000 });
          const event = await call("collectNetworkWait", { ...scope, tabId: owned.id, waiterId: armed.waiterId });
          assert.equal(event.event, "response"); assert.equal(event.url, url); assert.equal(event.method, "POST"); assert.equal(event.status, 201);
          assert.ok(event.requestId); assert.equal(event.resourceType, "fetch");
          assert.deepEqual(await call("collectNetworkWait", { ...scope, tabId: owned.id, waiterId: armed.waiterId }), event);
          assert.deepEqual(await owned.evaluate("networkClicks"), [{ trusted: true }]);
          assert.equal(networkFixtures.stats(key).requests.length, 1, `${kind} replayed the HTTP trigger`);
          return { event, server: networkFixtures.stats(key), fixedScope: scope };
        } finally { await call("cancelNetworkWait", { ...scope, tabId: owned.id, waiterId: armed.waiterId }); }
      };
      if (kind === "mcp") return await withMCPClient(executable, endpoint, sessionId, check);
      return await check(async (method, params) => {
        const response = JSON.parse(await subprocess(path.resolve(executable), ["call", "--socket", endpoint, "--session-id", sessionId, "--method", method, "--params", JSON.stringify(params), "--timeout", "15s"]));
        assert.equal(response.error, undefined, JSON.stringify(response));
        return response.result;
      });
    } finally { try { await network.client.finalizeTabs([]); } finally { network.close(); } }
  });
  for (const kind of ["cli", "mcp"]) await test(`${kind}-navigation-waits-cold-arm`, async () => {
    const sessionId = `${kind}-navigation-integration`, key = `${kind}-navigation-cold`;
    const navigation = await connectOpenBrowserUse({ socketPath: endpoint, sessionId, turnId: "navigation-acceptance", timeoutMs: 15000 });
    try {
      const owned = await navigation.newTab();
      await navigation.cdp.navigate(owned.id, navigationPageURL(fixtureURL, key));
      const scope = { session_id: sessionId, turn_id: navigation.client.turnId, control_epoch: navigation.client.controlEpoch };
      const check = async call => {
        const armed = await call("armNavigationWait", { ...scope, tabId: owned.id, event: "url", url: navigationTargetURL(fixtureURL, key), timeoutMs: 10000 });
        assert.ok(armed.waiterId && armed.remainingMs > 0);
        const handle = { ...scope, tabId: owned.id, waiterId: armed.waiterId };
        try {
          await call("browserAction", { ...scope, tabId: owned.id, action: "click", locator: [{ kind: "role", role: "button", name: navigationButton, exact: true }], timeoutMs: 5000 });
          assert.deepEqual(await call("collectNavigationWait", handle), {});
          assert.deepEqual(await call("collectNavigationWait", handle), {});
          return { ...await navigationWitness(owned, navigationFixtures, key), fixedScope: scope };
        } finally { await call("cancelNavigationWait", handle); }
      };
      if (kind === "mcp") return await withMCPClient(executable, endpoint, sessionId, check);
      return await check(async (method, params) => {
        const result = JSON.parse(await subprocess(path.resolve(executable), ["call", "--socket", endpoint, "--session-id", sessionId, "--method", method, "--params", JSON.stringify(params), "--timeout", "15s"]));
        assert.equal(result.error, undefined, JSON.stringify(result)); return result.result;
      });
    } finally { try { await navigation.client.finalizeTabs([]); } finally { navigation.close(); } }
  });
  await test("cli-browser-action", async () => {
    async function call(action, locator, args = {}) {
      const params = { session_id: "js-browser-integration", turn_id: "acceptance", tabId: tab.id, action, locator, args, timeoutMs: 10000 };
      const result = JSON.parse(await subprocess(path.resolve(executable), ["call", "--socket", endpoint, "--session-id", "js-browser-integration", "--method", "browserAction", "--params", JSON.stringify(params), "--timeout", "15s"]));
      assert.equal(result.error, undefined, JSON.stringify(result.error));
      assert.equal(result.result.engine.name, "playwright-crx");
      return result.result;
    }
    const locator = [{ kind: "label", value: "Controlled name", exact: true }];
    await call("fill", locator, { value: "CLI 中文" });
    assert.equal((await call("inputValue", locator)).value, "CLI 中文");
    assert.equal(await tab.locator("#controlled-result").textContent(), "CLI 中文");
    const engine = (await call("snapshot")).engine;
    await tab.evaluate("document.querySelector('#role-result').textContent='';globalThis.__integrationRootEvents=[]");
    const capture = (await call("snapshotAI")).value;
    const reference = [{ kind: "ref", captureId: capture.captureId, ref: fixtureRef(capture, "ARIA named action") }];
    assert.equal((await call("textContent", reference)).value, "Icon");
    await call("click", reference);
    assert.equal(await tab.locator("#role-result").textContent(), "clicked");
    assert.equal(await tab.evaluate("__integrationRootEvents.some(event=>event.event==='click'&&event.trusted)"), true);
    return { engine, aiCaptureId: capture.captureId, aiRef: reference[0].ref };
  });
  await test("mcp-browser-action", async () => {
    await tab.evaluate("document.querySelector('#role-result').textContent='';globalThis.__integrationRootEvents=[]");
    const params = { tabId: tab.id, timeoutMs: 10000 };
    const toolCall = (id, action, locator, args = {}) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "call", arguments: { method: "browserAction", params: { ...params, action, locator, args } } } });
    const messages = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "obu-browser-integration", version: "1.0.0" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "call", arguments: { method: "browserAction", params: { ...params, action: "fill", locator: [{ kind: "label", value: "Controlled name", exact: true }], args: { value: "MCP 中文" } } } } },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "call", arguments: { method: "browserAction", params: { ...params, action: "textContent", locator: [{ kind: "css", selector: "#controlled-result" }] } } } },
      toolCall(4, "snapshotAI")
    ];
    const replies = await new Promise((resolve, reject) => {
      const child = spawn(path.resolve(executable), ["mcp", "--socket", endpoint, "--session-id", "js-browser-integration", "--timeout", "15s"], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      const responses = [];
      let buffer = "", errors = "", reference;
      const timer = setTimeout(() => { child.kill(); reject(new Error("MCP acceptance deadline exceeded")); }, 45000);
      const send = message => child.stdin.write(JSON.stringify(message) + "\n");
      child.stdout.on("data", chunk => {
        buffer += chunk.toString();
        let newline;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          try {
            const response = JSON.parse(line); responses.push(response);
            // Complete the MCP initialization handshake before tools/call.
            if (response.id === 1) { send(messages[1]); send(messages[2]); }
            else if (response.id === 2) send(messages[3]);
            else if (response.id === 3) send(messages[4]);
            else if (response.id === 4) {
              const capture = response.result?.structuredContent?.result?.value;
              assert.ok(capture, JSON.stringify(response));
              reference = [{ kind: "ref", captureId: capture.captureId, ref: fixtureRef(capture, "ARIA named action") }];
              send(toolCall(5, "textContent", reference));
            } else if (response.id === 5) send(toolCall(6, "click", reference));
            else if (response.id === 6) child.stdin.end();
          } catch (error) { child.kill(); reject(error); }
        }
      });
      child.stderr.on("data", chunk => errors += chunk.toString());
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("exit", code => { clearTimeout(timer); code === 0 ? resolve(responses) : reject(new Error(`MCP exited ${code}: ${errors}`)); });
      send(messages[0]);
    });
    assert.equal(replies.length, 6);
    assert.equal(replies[0].result.protocolVersion, "2025-06-18");
    for (const reply of replies.slice(1)) {
      assert.equal(reply.error, undefined);
      assert.equal(reply.result.isError, false, JSON.stringify(reply.result));
      assert.equal(reply.result.structuredContent.error, undefined);
      assert.equal(reply.result.structuredContent.result.engine.name, "playwright-crx");
    }
    assert.equal(replies[2].result.structuredContent.result.value, "MCP 中文");
    assert.equal(replies[4].result.structuredContent.result.value, "Icon");
    assert.equal(await tab.getByLabel("Controlled name").inputValue(), "MCP 中文");
    assert.equal(await tab.locator("#role-result").textContent(), "clicked");
    assert.equal(await tab.evaluate("__integrationRootEvents.some(event=>event.event==='click'&&event.trusted)"), true);
    return { protocolVersion: replies[0].result.protocolVersion, engine: replies[2].result.structuredContent.result.engine,
      aiCaptureId: replies[3].result.structuredContent.result.value.captureId };
  });
  await test("python-public-sdk", async () => {
    const result = await new Promise((resolve, reject) => {
      const python = spawn(process.env.OBU_TEST_PYTHON || "python", [pythonChecks, endpoint, fixtureURL], {
        windowsHide: true, env: { ...process.env, PYTHONPATH: path.dirname(pythonSnapshot), PYTHONIOENCODING: "utf-8", OBU_TEST_DOWNLOAD_ROOT: path.join(runDir, "downloads") }, stdio: ["ignore", "pipe", "pipe"]
      });
      let output = "", error = "";
      python.stdout.on("data", data => output += data.toString());
      python.stderr.on("data", data => error += data.toString());
      const timer = setTimeout(() => { python.kill(); reject(new Error("Python integration deadline exceeded")); }, 120000);
      python.once("error", error => { clearTimeout(timer); reject(error); });
      python.once("exit", code => { clearTimeout(timer); code === 0 ? resolve(JSON.parse(output)) : reject(new Error(`Python exited ${code}: ${error}`)); });
    });
    assert.equal(result.passed, true);
    return result;
  });
  if (goExecutable) await test("go-public-sdk", async () => {
    const result = JSON.parse(await subprocess(goExecutable, [endpoint, fixtureURL], { timeoutMs: 120000, env: { ...process.env, OBU_TEST_DOWNLOAD_ROOT: path.join(runDir, "downloads") } }));
    assert.equal(result.passed, true);
    return result;
  });
  await test("js-session-notification-isolation", async () => {
    const first = await connectOpenBrowserUse({ socketPath: endpoint, sessionId: "notification-first", timeoutMs: 15000 });
    const second = await connectOpenBrowserUse({ socketPath: endpoint, sessionId: "notification-second", timeoutMs: 15000 });
    const firstEvents = [], secondEvents = [];
    first.client.onNotification(event => firstEvents.push(event));
    second.client.onNotification(event => secondEvents.push(event));
    try {
      const firstTab = await first.newTab({ url: fixtureURL });
      const secondTab = await second.newTab({ url: fixtureURL });
      await first.cdp.call(firstTab.id, "Runtime.enable");
      await second.cdp.call(secondTab.id, "Runtime.enable");
      await firstTab.evaluate("console.log('session-event-first')");
      await secondTab.evaluate("console.log('session-event-second')");
      const hasMarker = (events, marker) => events.some(event => event.method === "onCDPEvent" && event.params.method === "Runtime.consoleAPICalled" && event.params.params.args.some(argument => argument.value === marker));
      await until(() => hasMarker(firstEvents, "session-event-first") && hasMarker(secondEvents, "session-event-second"), "session-owned console events", 5000);
      assert.ok(!hasMarker(firstEvents, "session-event-second"));
      assert.ok(!hasMarker(secondEvents, "session-event-first"));
      for (const [events, session, tabId] of [[firstEvents, "notification-first", firstTab.id], [secondEvents, "notification-second", secondTab.id]]) {
        assert.ok(events.filter(event => event.method === "onCDPEvent").every(event => event.params.session_id === session && event.params.tabId === tabId));
      }
      return { firstTab: firstTab.id, secondTab: secondTab.id, firstEvents: firstEvents.length, secondEvents: secondEvents.length };
    } finally {
      try { await first.client.finalizeTabs([]); await second.client.finalizeTabs([]); }
      finally { first.close(); second.close(); }
    }
  });
  await test("js-extended-input-and-history", async () => {
    const actions = await connectOpenBrowserUse({ socketPath: endpoint, sessionId: "js-actions-integration", timeoutMs: 15000 });
    try { return await checkExtendedActions(actions, fixtureURL, assert); }
    finally { await actions.client.finalizeTabs([]); actions.close(); }
  });
  await test("js-public-downloads-session-isolation", async () => {
    const clients = await Promise.all(["first", "second"].map(suffix => connectOpenBrowserUse({ socketPath: endpoint, sessionId: `js-download-${suffix}`, timeoutMs: 15000 })));
    const events = [[], []];
    clients.forEach((client, index) => client.client.onNotification(event => { if (event.method === "onDownloadChange") events[index].push(event.params); }));
    try {
      const tabs = await Promise.all(clients.map(client => client.newTab({ url: fixtureURL + "transfers" })));
      const downloads = await Promise.all(clients.map(async (client, index) => {
        const [download] = await Promise.all([
          client.client.waitForDownload(tabs[index].id, 5000),
          tabs[index].getByRole("link", { name: "Download fixture" }).click({ timeoutMs: 5000 })
        ]);
        assert.equal(typeof download.downloadId, "string");
        return download;
      }));
      assert.notEqual(downloads[0].downloadId, downloads[1].downloadId);
      await until(() => events.every((items, index) => items.some(item => item.id === downloads[index].downloadId && item.status === "complete")), "owned download completion");
      for (let index = 0; index < 2; index++) {
        assert.ok(events[index].every(item => item.session_id === `js-download-${index === 0 ? "first" : "second"}` && item.tabId === tabs[index].id && item.id !== downloads[1 - index].downloadId));
        await assert.rejects(clients[index].client.downloadPath(downloads[1 - index].downloadId), /Unknown or unowned download id/);
        await assert.rejects(clients[index].client.downloadPath("not-a-real-download"), /Unknown or unowned download id/);
        await assert.rejects(clients[index].client.downloadPath(downloads[index].downloadId), /OBU_DOWNLOAD_PATH_UNAVAILABLE/);
        await assert.rejects(clients[index].client.waitForDownload(tabs[index].id, 100), /timed out|timeout/i);
      }
      const files = await until(async () => {
        const names = (await fs.readdir(path.join(runDir, "downloads"))).filter(name => /^owned-download.*\.txt$/.test(name));
        return names.length === 2 ? names : undefined;
      }, "fixture download files");
      for (const file of files) assert.equal(await fs.readFile(path.join(runDir, "downloads", file), "utf8"), "Public SDK download bytes");
      return { downloads, events, files };
    } finally {
      await fs.writeFile(path.join(runDir, "download-events.json"), JSON.stringify(events, null, 2));
      await Promise.all(clients.map(async client => { try { await client.client.finalizeTabs([]); } finally { client.close(); } }));
    }
  });
  await test("js-direct-downloads-files-cookie-and-cancel", async () => {
    const detail = await checkDirectDownloads({
      connectBrowser: suffix => connectOpenBrowserUse({ socketPath: endpoint, sessionId: `js-${suffix}`, timeoutMs: 15000 }),
      fixtureURL, server: directDownloads, until, downloadRoot: path.join(runDir, "downloads"),
      unownedDownload: url => worker.evaluate(`chrome.downloads.download({url:${JSON.stringify(url)},saveAs:false,conflictAction:'uniquify',filename:'unowned-direct-download.txt'})`),
      nativeItem: id => worker.evaluate(`chrome.downloads.search({id:${id}}).then(items=>items[0])`)
    });
    await fs.writeFile(path.join(runDir, "direct-download-files.json"), JSON.stringify(detail, null, 2));
    return detail;
  });
  await test("js-direct-downloads-lifecycle", async () => {
    const detail = await checkDirectDownloadLifecycle({
      connectBrowser: suffix => connectOpenBrowserUse({ socketPath: endpoint, sessionId: `js-${suffix}`, timeoutMs: 15000 }),
      fixtureURL, server: directDownloads, until, ungroup: id => worker.evaluate(`chrome.tabs.ungroup(${id})`)
    });
    await fs.writeFile(path.join(runDir, "direct-download-lifecycle.json"), JSON.stringify(detail, null, 2));
    return detail;
  });
  for (const kind of ["cli", "mcp"]) await test(`${kind}-direct-downloads`, async () => {
    const sessionId = `${kind}-direct-downloads`, owner = await connectOpenBrowserUse({ socketPath: endpoint, sessionId, turnId: "download-acceptance", timeoutMs: 15000 });
    const key = `${kind}-direct`, cancelKey = `${kind}-direct-cancel`;
    try {
      const owned = await prepareDirectDownloadTab(owner, fixtureURL);
      const scope = { session_id: sessionId, turn_id: owner.client.turnId, control_epoch: owner.client.controlEpoch };
      const check = async call => {
        const started = await call("downloadURL", { ...scope, tabId: owned.id, url: directDownloadURL(fixtureURL, key), filename: `${kind}-direct.txt`, timeoutMs: 5000 });
        assert.equal(typeof started.downloadId, "string");
        const result = await call("downloadPath", { ...scope, downloadId: started.downloadId, timeoutMs: 5000 });
        const file = await verifyDownloadedFile(result.path, directDownloads, key, path.join(runDir, "downloads"));
        const slow = await call("downloadURL", { ...scope, tabId: owned.id, url: directDownloadURL(fixtureURL, cancelKey, "slow"), timeoutMs: 5000 });
        await until(() => directDownloads.stats(cancelKey).requests.length === 1, `${kind} pending download`);
        assert.deepEqual(await call("cancelDownload", { ...scope, downloadId: slow.downloadId, timeoutMs: 5000 }), { cancelled: true });
        await until(() => directDownloads.stats(cancelKey).requests[0].closed, `${kind} canceled native response`);
        assert.equal(directDownloads.stats(cancelKey).requests[0].finished, false);
        assert.equal(directDownloads.stats(key).requests.length, 1);
        return { file, cancelled: true, fixedScope: scope };
      };
      if (kind === "mcp") return await withMCPClient(executable, endpoint, sessionId, check);
      return await check(async (method, params) => {
        const result = JSON.parse(await subprocess(path.resolve(executable), ["call", "--socket", endpoint, "--session-id", sessionId, "--method", method, "--params", JSON.stringify(params), "--timeout", "15s"]));
        assert.equal(result.error, undefined, JSON.stringify(result)); return result.result;
      });
    } finally { directDownloads.release(cancelKey); try { await owner.client.finalizeTabs([]); } finally { owner.close(); } }
  });
  await test("js-bounded-console-error-network-diagnostics", async () => {
    const diagnostics = await connectOpenBrowserUse({ socketPath: endpoint, sessionId: "js-diagnostics", timeoutMs: 15000 });
    try { return await checkDiagnostics(diagnostics, fixtureURL, assert, until, {
      ungroup: tabId => worker.evaluate(`chrome.tabs.ungroup(${tabId})`),
      connectSuccessor: () => connectOpenBrowserUse({ socketPath: endpoint, sessionId: "js-diagnostics-successor", timeoutMs: 15000 })
    }); }
    finally { try { await diagnostics.client.finalizeTabs([]); } finally { diagnostics.close(); } }
  });
  await test("js-control-epoch-lifecycle", async () => {
    const lifecycle = await connectOpenBrowserUse({ socketPath: endpoint, sessionId: "js-lifecycle-integration", timeoutMs: 15000 });
    try {
      const owned = await lifecycle.newTab({ url: fixtureURL });
      const oldEpoch = lifecycle.client.controlEpoch, oldTurn = lifecycle.client.turnId;
      const pending = owned.getByRole("button", { name: "Never appears" }).click({ timeoutMs: 10000 }).then(() => ({ succeeded: true }), error => ({ error: error.message }));
      await delay(100);
      const started = Date.now();
      const acknowledgement = await lifecycle.client.turnEnded();
      assert.ok((await pending).error, "turnEnded did not cancel the accepted action");
      assert.ok(Date.now() - started < 5000);
      assert.ok(lifecycle.client.controlEpoch > oldEpoch);
      assert.equal(lifecycle.client.turnId, acknowledgement.nextTurnId);
      await assert.rejects(lifecycle.client.request("getTabs", { turn_id: oldTurn, control_epoch: oldEpoch }), /OBU_STALE_CONTROL_EPOCH/);
      await owned.getByLabel("Controlled name").fill("after end");
      assert.equal(await owned.getByLabel("Controlled name").inputValue(), "after end");
      // A separate explicit token user can end this session. The managed client
      // must remain stale until its owner deliberately refreshes it.
      const managedEpoch = lifecycle.client.controlEpoch;
      await lifecycle.client.request("turnEnded", { control_epoch: managedEpoch });
      assert.equal(lifecycle.client.controlEpoch, managedEpoch);
      await assert.rejects(lifecycle.client.getTabs(), /OBU_STALE_CONTROL_EPOCH/);
      assert.ok((await lifecycle.client.getControlState()).controlEpoch > managedEpoch);
      assert.equal(lifecycle.client.controlEpoch, managedEpoch, "query implicitly refreshed stale control");
      await lifecycle.client.beginTurn();
      assert.ok(lifecycle.client.controlEpoch > managedEpoch);
      assert.equal(await owned.getByLabel("Controlled name").inputValue(), "after end");
      return { oldEpoch, recoveredEpoch: lifecycle.client.controlEpoch, endedTurnId: acknowledgement.endedTurnId };
    } finally { await lifecycle.client.finalizeTabs([]); lifecycle.close(); }
  });
  await test("js-finalize-cancels-pending-action", async () => {
    const started = Date.now();
    const wait = tab.getByRole("button", { name: "Never appears" }).click({ timeoutMs: 10000 }).then(() => ({ succeeded: true }), error => ({ error: error.message }));
    await delay(150);
    await browser.client.finalizeTabs([]);
    const outcome = await wait;
    assert.ok(outcome.error, "Canceled action unexpectedly succeeded");
    assert.ok(Date.now() - started < 5000, "Finalize did not promptly cancel the engine action");
    const tabs = await worker.evaluate("chrome.tabs.query({})");
    assert.ok(!tabs.some(candidate => candidate.id === tab.id), "Finalized tab was not closed");
    return outcome;
  });
  await test("js-control-worker-restart", async () => {
    const recovery = await connectOpenBrowserUse({ socketPath: endpoint, sessionId: "js-worker-recovery", timeoutMs: 15000 });
    let browserControl, popupControl, popupId, auxiliary, observerInstalled = false;
    try {
      const owned = await recovery.newTab({ url: fixtureURL });
      auxiliary = await createAuxiliaryPopup(fixtureURL + "popup-child-authorization?auxiliary=restart");
      const auxiliaryTab = recovery.tab(auxiliary.tabs[0].id);
      await recovery.client.claimUserTab(auxiliaryTab.id);
      await auxiliaryTab.domSnapshot();
      const oldEpoch = recovery.client.controlEpoch;
      const oldTurn = recovery.client.turnId;
      const networkWait = await recovery.client.request("armNetworkWait", { tabId: owned.id, event: "response", match: { url: fixtureURL + "never-worker-network" }, timeoutMs: 120000 });
      const navigationWait = await recovery.client.request("armNavigationWait", { tabId: owned.id, event: "url", url: "**/never-worker-navigation", timeoutMs: 120000 });
      const previousActivations = await worker.evaluate("globalThis.__integrationActivations");
      const previousFocus = await worker.evaluate("globalThis.__integrationWindowFocus");
      const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
      const oldTarget = targets.find(target => target.type === "service_worker" && target.url === `chrome-extension://${extensionId}/background.js`);
      const version = await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json();
      browserControl = await workerConnection(version.webSocketDebuggerUrl);
      // This background page observes tab activations while the worker is down.
      const popup = await browserControl.call("Target.createTarget", { url: `chrome-extension://${extensionId}/popup.html`, background: true });
      popupId = popup.targetId;
      const popupTarget = await until(async () => (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()).find(target => target.id === popupId), "test popup target");
      popupControl = await workerConnection(popupTarget.webSocketDebuggerUrl);
      await until(() => popupControl.evaluate(`location.href===${JSON.stringify(`chrome-extension://${extensionId}/popup.html`)}&&document.readyState==='complete'&&typeof chrome.tabs?.onActivated?.addListener==='function'`), "loaded activation observer document");
      await popupControl.evaluate("globalThis.__restartActivations=[];chrome.tabs.onActivated.addListener(info=>globalThis.__restartActivations.push(info))");
      await popupControl.evaluate("globalThis.__restartWindowFocus=[];chrome.windows.onFocusChanged.addListener(id=>globalThis.__restartWindowFocus.push(id))");
      observerInstalled = true;
      await activeInvariant();
      await popupControl.call("ServiceWorker.enable");
      const workerVersion = await until(() => popupControl.events.filter(event => event.method === "ServiceWorker.workerVersionUpdated").flatMap(event => event.params.versions).find(value => value.scriptURL === oldTarget.url && value.runningStatus === "running"), "extension worker version");
      const priorSocket = extensionSocket;
      worker.close();
      await popupControl.call("ServiceWorker.stopWorker", { versionId: workerVersion.versionId });
      await popupControl.call("ServiceWorker.startWorker", { scopeURL: `chrome-extension://${extensionId}/` });
      const restarted = await until(async () => (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()).find(target => target.id !== oldTarget.id && target.type === "service_worker" && target.url === oldTarget.url), "restarted extension worker");
      worker = await workerConnection(restarted.webSocketDebuggerUrl);
      await until(() => extensionSocket !== priorSocket && extensionSocket?.readyState === WebSocket.OPEN, "restarted native adapter");
      const restartEvents = await popupControl.evaluate("globalThis.__restartActivations");
      assert.ok(Array.isArray(restartEvents), "The activation observer document changed during worker restart");
      await worker.evaluate(`globalThis.__integrationActivations=${JSON.stringify([...previousActivations, ...restartEvents])};chrome.tabs.onActivated.addListener(info=>globalThis.__integrationActivations.push(info))`);
      const restartFocus = await popupControl.evaluate("globalThis.__restartWindowFocus");
      await worker.evaluate(`globalThis.__integrationWindowFocus=${JSON.stringify([...previousFocus, ...restartFocus])};chrome.windows.onFocusChanged.addListener(id=>globalThis.__integrationWindowFocus.push(id))`);
      await assert.rejects(recovery.client.getTabs(), /OBU_STALE_CONTROL_EPOCH|OBU_CONTROL_BOOTSTRAP_REQUIRED/);
      await assert.rejects(recovery.client.request("collectNetworkWait", { tabId: owned.id, waiterId: networkWait.waiterId, turn_id: oldTurn, control_epoch: oldEpoch }), /OBU_STALE_CONTROL_EPOCH|OBU_CONTROL_BOOTSTRAP_REQUIRED/);
      await assert.rejects(recovery.client.request("collectNavigationWait", { tabId: owned.id, waiterId: navigationWait.waiterId, turn_id: oldTurn, control_epoch: oldEpoch }), /OBU_STALE_CONTROL_EPOCH|OBU_CONTROL_BOOTSTRAP_REQUIRED/);
      assert.equal(recovery.client.controlEpoch, oldEpoch, "restart silently refreshed the client");
      await recovery.client.beginTurn();
      assert.ok(recovery.client.controlEpoch > oldEpoch);
      await assert.rejects(recovery.client.request("collectNetworkWait", { tabId: owned.id, waiterId: networkWait.waiterId }), /OBU_NETWORK_WAIT_EXPIRED/);
      await assert.rejects(recovery.client.request("collectNavigationWait", { tabId: owned.id, waiterId: navigationWait.waiterId }), /OBU_NAVIGATION_WAIT_EXPIRED/);
      assert.ok((await recovery.getTabs()).some(tab => tab.id === auxiliaryTab.id));
      await auxiliaryTab.getByRole("button", { name: "Child action", exact: true }).click();
      assert.deepEqual(await auxiliaryTab.evaluate("childClicks"), [{ trusted: true }]);
      assert.equal((await worker.evaluate(`chrome.tabs.get(${auxiliaryTab.id})`)).windowId, auxiliary.id);
      assert.match(await owned.domSnapshot(), /Controlled name/);
      await owned.getByLabel("Controlled name").fill("recovered after worker restart");
      assert.equal(await owned.getByLabel("Controlled name").inputValue(), "recovered after worker restart");
      return { oldEpoch, recoveredEpoch: recovery.client.controlEpoch, oldTarget: oldTarget.id, restartedTarget: restarted.id, restartEvents, restartFocus, auxiliaryWindowPreserved: auxiliary.id, oldNetworkWaitExpired: true, oldNavigationWaitExpired: true };
    } finally {
      try { await recovery.client.finalizeTabs([]); } finally {
        recovery.close();
        if (observerInstalled) {
          const observed = await popupControl.evaluate("globalThis.__restartActivations");
          assert.ok(Array.isArray(observed), "The activation observer document changed before cleanup");
          await worker.evaluate(`globalThis.__integrationActivations.push(...${JSON.stringify(observed)})`);
          const observedFocus = await popupControl.evaluate("globalThis.__restartWindowFocus");
          assert.ok(Array.isArray(observedFocus), "The window-focus observer document changed before cleanup");
          await worker.evaluate(`globalThis.__integrationWindowFocus.push(...${JSON.stringify(observedFocus)})`);
        }
        if (popupId) await browserControl?.call("Target.closeTarget", { targetId: popupId });
        if (auxiliary) await closeAuxiliaryPopup(auxiliary.id);
        popupControl?.close(); browserControl?.close();
      }
    }
  });
  function createPopupFocusTrace(name, reason) {
    const focusTrace = [];
    let beforeActionPopup;
    const traceFocus = async phase => {
      const snapshot = await worker.evaluate(`(async()=>({phase:${JSON.stringify(phase)},at:Date.now(),events:[...globalThis.__integrationWindowFocus],windows:(await chrome.windows.getAll({populate:true})).map(window=>({id:window.id,type:window.type,focused:window.focused,tabs:window.tabs.map(tab=>({id:tab.id,active:tab.active}))})),contexts:(await chrome.runtime.getContexts({contextTypes:['POPUP']})).map(context=>({type:context.contextType,windowId:context.windowId,documentId:context.documentId,documentUrl:context.documentUrl}))}))()`);
      focusTrace.push(snapshot);
      await fs.writeFile(path.join(runDir, `${name}-focus-trace.json`), JSON.stringify(focusTrace, null, 2));
      if (phase === "action-popup:before-open") {
        await activeInvariant();
        beforeActionPopup = snapshot;
      } else if (phase === "action-popup:after-open") {
        assert.ok(beforeActionPopup, "Missing focus checkpoint immediately before intentional action popup opening");
        assert.deepEqual(snapshot.events.slice(0, beforeActionPopup.events.length), beforeActionPopup.events, "Opening the action popup rewrote the focus history");
        const observed = snapshot.events.slice(beforeActionPopup.events.length);
        assert.ok(observed.length === 0 || (observed.length === 2 && observed[0] === sentinel.windowId && observed[1] === -1), `Unexpected focus sequence during action.openPopup: ${JSON.stringify(observed)}`);
        const contexts = snapshot.contexts.filter(context => context.type === "POPUP" && context.documentUrl === `chrome-extension://${extensionId}/popup.html`);
        assert.ok(contexts.length > 0, "Focus attribution requires a live real action POPUP context");
        for (const [offset, windowId] of observed.entries()) allowedWindowFocusEvents.push({
          index: beforeActionPopup.events.length + offset, windowId,
          reason,
          beforeAt: beforeActionPopup.at, afterAt: snapshot.at, popupContexts: contexts
        });
        beforeActionPopup = null;
      }
    };
    return traceFocus;
  }
  async function restartObservedWorker(observer) {
      const previousActivations = await worker.evaluate("globalThis.__integrationActivations");
      const previousFocus = await worker.evaluate("globalThis.__integrationWindowFocus");
      await observer.evaluate("globalThis.__pauseActivations=[];chrome.tabs.onActivated.addListener(info=>globalThis.__pauseActivations.push(info))");
      await observer.evaluate("globalThis.__pauseWindowFocus=[];chrome.windows.onFocusChanged.addListener(id=>globalThis.__pauseWindowFocus.push(id))");
      const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
      const oldTarget = targets.find(target => target.type === "service_worker" && target.url === `chrome-extension://${extensionId}/background.js`);
      await observer.call("ServiceWorker.enable");
      const version = await until(() => observer.events.filter(event => event.method === "ServiceWorker.workerVersionUpdated").flatMap(event => event.params.versions).find(value => value.scriptURL === oldTarget.url && value.runningStatus === "running"), "paused worker version");
      const priorSocket = extensionSocket;
      worker.close();
      await observer.call("ServiceWorker.stopWorker", { versionId: version.versionId });
      await observer.call("ServiceWorker.startWorker", { scopeURL: `chrome-extension://${extensionId}/` });
      const restarted = await until(async () => (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()).find(target => target.id !== oldTarget.id && target.type === "service_worker" && target.url === oldTarget.url), "paused restarted worker");
      worker = await workerConnection(restarted.webSocketDebuggerUrl);
      await until(() => extensionSocket !== priorSocket && extensionSocket?.readyState === WebSocket.OPEN, "paused restarted native adapter");
      const observed = await observer.evaluate("globalThis.__pauseActivations");
      await worker.evaluate(`globalThis.__integrationActivations=${JSON.stringify([...previousActivations, ...observed])};chrome.tabs.onActivated.addListener(info=>globalThis.__integrationActivations.push(info))`);
      const observedFocus = await observer.evaluate("globalThis.__pauseWindowFocus");
      await worker.evaluate(`globalThis.__integrationWindowFocus=${JSON.stringify([...previousFocus, ...observedFocus])};chrome.windows.onFocusChanged.addListener(id=>globalThis.__integrationWindowFocus.push(id))`);
      return { oldTarget: oldTarget.id, restartedTarget: restarted.id, activeEvents: observed, windowFocusEvents: observedFocus };
  }
  await test("js-user-global-pause-popup", async () => {
    const network = await connectOpenBrowserUse({ socketPath: endpoint, sessionId: "js-paused-network", timeoutMs: 15000 });
    let pauseNetworkOutcome, pauseNavigationOutcome, pauseDownloadOutcome, pausedWait, pausedNavigationWait, pausedDownload, pausedTab, pauseAuxiliary;
    const traceFocus = createPopupFocusTrace("pause", "intentional harness chrome.action.openPopup for the user's Pause/Resume control");
    try {
      await traceFocus("pause-case:start");
      pausedTab = await network.newTab({ url: networkPageURL(fixtureURL, "js-paused-network") });
      pauseAuxiliary = await createAuxiliaryPopup(fixtureURL + "popup-child-authorization?auxiliary=pause");
      const auxiliaryId = pauseAuxiliary.tabs[0].id;
      await network.client.claimUserTab(auxiliaryId); await network.tab(auxiliaryId).domSnapshot();
      await traceFocus("pause-auxiliary:claimed");
      pausedWait = await pausedTab.expectResponse({ url: networkAPIURL(fixtureURL, "js-paused-network") }, { timeoutMs: 120000 });
      const pendingNetwork = pausedWait.result({ timeoutMs: 120000 }).then(value => pauseNetworkOutcome = { value }, error => pauseNetworkOutcome = { error: String(error) });
      pausedNavigationWait = await pausedTab.expectURL("**/never-paused-navigation", { timeoutMs: 120000 });
      const pendingNavigation = pausedNavigationWait.result({ timeoutMs: 120000 }).then(() => pauseNavigationOutcome = { succeeded: true }, error => pauseNavigationOutcome = { error: String(error) });
      const downloadTab = await prepareDirectDownloadTab(network, fixtureURL);
      pausedDownload = await downloadTab.downloadURL(directDownloadURL(fixtureURL, "js-paused-direct-download", "slow"));
      await until(() => directDownloads.stats("js-paused-direct-download").requests.length === 1, "owned native download before Pause");
      const pendingDownload = pausedDownload.path({ timeoutMs: 120000 }).then(value => pauseDownloadOutcome = { value }, error => pauseDownloadOutcome = { error: String(error) });
      const detail = await checkGlobalPause({
    connectBrowser: suffix => connectOpenBrowserUse({ socketPath: endpoint, sessionId: `js-${suffix}`, timeoutMs: 15000 }),
    getWorker: () => worker, fixtureURL, popupURL: `chrome-extension://${extensionId}/popup.html`, windowId: sentinel.windowId, assert, until, traceFocus,
    saveDetail: detail => fs.writeFile(path.join(runDir, "pause-control.json"), JSON.stringify({ ...detail, networkWait: pauseNetworkOutcome, navigationWait: pauseNavigationOutcome, directDownload: pauseDownloadOutcome }, null, 2)),
    connectPage: async url => {
      const target = await until(async () => (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()).find(target => target.type === "page" && target.url === url), "extension page target");
      return workerConnection(target.webSocketDebuggerUrl);
    },
    capture: async (name, page) => {
      const screenshot = await page.call("Page.captureScreenshot", { format: "png" });
      const { bytes } = pngDimensions(screenshot.data);
      await fs.writeFile(path.join(runDir, `${name}.png`), bytes);
    },
    restartWorker: async observer => {
      await until(() => pauseNetworkOutcome, "Pause cancelled the pending network collect", 5000);
      assert.match(pauseNetworkOutcome.error, /OBU_NETWORK_WAIT_EXPIRED|paused|ended|cancel|stale/i);
      await until(() => pauseNavigationOutcome, "Pause cancelled the pending navigation collect", 5000);
      assert.match(pauseNavigationOutcome.error, /OBU_NAVIGATION_WAIT_EXPIRED|paused|ended|cancel|stale/i);
      await until(() => pauseDownloadOutcome, "Pause canceled pending download path", 5000);
      assert.match(pauseDownloadOutcome.error, directDownloadErrors.paused);
      await until(() => directDownloads.stats("js-paused-direct-download").requests[0].closed, "Pause canceled exact native download response", 5000);
      assert.equal(directDownloads.stats("js-paused-direct-download").requests[0].finished, false);
      assert.equal(networkFixtures.stats("js-paused-network").requests.length, 0);
      assert.equal((await worker.evaluate("chrome.debugger.getTargets()")).some(target => target.tabId === auxiliaryId && target.attached), false);
      assert.equal((await worker.evaluate(`chrome.tabs.get(${auxiliaryId})`)).windowId, pauseAuxiliary.id);
      return { ...await restartObservedWorker(observer), auxiliaryWindowPreserved: pauseAuxiliary.id };
    }
      });
      await pendingNetwork;
      await pendingNavigation;
      await pendingDownload;
      await assert.rejects(pausedWait.result(), /OBU_STALE_CONTROL_EPOCH|OBU_CONTROL_BOOTSTRAP_REQUIRED|OBU_NETWORK_WAIT_EXPIRED/);
      await assert.rejects(pausedNavigationWait.result(), /OBU_STALE_CONTROL_EPOCH|OBU_CONTROL_BOOTSTRAP_REQUIRED|OBU_NAVIGATION_WAIT_EXPIRED/);
      await assert.rejects(pausedDownload.path({ timeoutMs: 500 }), directDownloadErrors.epoch);
      await network.client.beginTurn();
      await assert.rejects(network.client.request("downloadPath", { downloadId: pausedDownload.downloadId, timeoutMs: 500 }), directDownloadErrors.expired);
      assert.ok((await network.getTabs()).some(tab => tab.id === auxiliaryId));
      await network.tab(auxiliaryId).getByRole("button", { name: "Child action", exact: true }).click();
      assert.deepEqual(await network.tab(auxiliaryId).evaluate("childClicks"), [{ trusted: true }]);
      await traceFocus("pause-auxiliary:resumed-click");
      assert.deepEqual(await pausedTab.evaluate("networkClicks"), [], "Resume replayed a network trigger");
      assert.equal(networkFixtures.stats("js-paused-network").requests.length, 0);
      await network.client.finalizeTabs([]);
      assert.equal(directDownloads.stats("js-paused-direct-download").requests.length, 1, "Resume replayed the native download");
      return { ...detail, networkWait: pauseNetworkOutcome, navigationWait: pauseNavigationOutcome, directDownload: pauseDownloadOutcome, networkNotReplayed: true };
    } finally {
      directDownloads.release("js-paused-direct-download");
      network.close();
      if (pauseAuxiliary) {
        await traceFocus("pause-auxiliary:before-close");
        await closeAuxiliaryPopup(pauseAuxiliary.id);
        await traceFocus("pause-auxiliary:after-close");
      }
    }
  });
  await test("js-user-site-access-popup", async () => {
    const traceFocus = createPopupFocusTrace("site-access", "intentional harness chrome.action.openPopup for the user's website access settings");
    return checkSiteAccess({
      connectBrowser: suffix => connectOpenBrowserUse({ socketPath: endpoint, sessionId: `js-${suffix}`, timeoutMs: 15000 }),
      getWorker: () => worker, fixtureURL, popupURL: `chrome-extension://${extensionId}/popup.html`, windowId: sentinel.windowId,
      assert, until, traceFocus, restartWorker: restartObservedWorker,
      saveDetail: detail => fs.writeFile(path.join(runDir, "site-access-control.json"), JSON.stringify(detail, null, 2)),
      connectPage: async url => {
        const target = await until(async () => (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()).find(target => target.type === "page" && target.url === url), "website settings page target");
        return workerConnection(target.webSocketDebuggerUrl);
      },
      capture: async (name, source) => {
        const data = source.base64 ?? (await source.call("Page.captureScreenshot", { format: "png" })).data;
        const { bytes, width, height } = pngDimensions(data);
        await fs.writeFile(path.join(runDir, `${name}.png`), bytes);
        return { width, height, bytes: bytes.length };
      }
    });
  });
  activeEvents = await worker.evaluate("globalThis.__integrationActivations");
  windowFocusEvents = await worker.evaluate("globalThis.__integrationWindowFocus");
} catch (error) {
  records.push({ name: "fatal", passed: false, error: error.stack }); console.error(error);
} finally {
  // Capture the HTTP witness before teardown can close an unfinished response.
  await fs.writeFile(path.join(runDir, "direct-download-server.json"), JSON.stringify(directDownloads.allStats(), null, 2));
  // Tab/window removal can emit a last extension notification. Stop accepting
  // bridge writes before ending stdin, including callbacks already queued by ws.
  bridgeClosing = true;
  browser?.close();
  if (worker) { try { await worker.evaluate("chrome.windows.getAll().then(windows=>Promise.all(windows.map(window=>chrome.windows.remove(window.id))))"); } catch {} worker.close(); }
  if (chrome && chrome.exitCode === null) chrome.kill();
  if (host && host.exitCode === null) { if (!host.stdin.destroyed && !host.stdin.writableEnded) host.stdin.end(); await Promise.race([new Promise(resolve => host.once("exit", resolve)), delay(1000)]); if (host.exitCode === null) host.kill(); }
  for (const client of ws.clients) client.terminate();
  await new Promise(resolve => ws.close(resolve));
  networkFixtures.close();
  navigationFixtures.close();
  directDownloads.close();
  await new Promise(resolve => http.close(resolve));
  await fs.writeFile(path.join(runDir, "network-server.json"), JSON.stringify(networkFixtures.allStats(), null, 2));
  await fs.writeFile(path.join(runDir, "navigation-server.json"), JSON.stringify(navigationFixtures.allStats(), null, 2));
  await fs.writeFile(path.join(runDir, "results.json"), JSON.stringify({ platform: process.platform, versions, headed: true, productionExtension: true, adapter: "connectNative replaced by loopback WebSocket for isolated testing only", nativeHost: executable, sourceIdentity, nativeFrameStats, activeEvents, allowedPopupActivations, windowFocusEvents, allowedWindowFocusEvents, records }, null, 2));
  await fs.writeFile(path.join(runDir, "host.log"), hostLog.join(""));
  await fs.writeFile(path.join(runDir, "chromium.log"), browserLog.join(""));
  const actualSocketDirectory = await fs.realpath(socketDir);
  const socketDirectoryInfo = await fs.lstat(socketDir);
  assert.ok(!socketDirectoryInfo.isSymbolicLink());
  assert.equal(path.dirname(actualSocketDirectory), temporaryRoot);
  assert.ok(path.basename(actualSocketDirectory).startsWith("obu-browser-"));
  assert.equal(actualSocketDirectory, socketDir);
  await fs.rm(actualSocketDirectory, { recursive: true, force: true });
  console.log("RESULT", path.join(runDir, "results.json"));
  process.exitCode = records.some(record => !record.passed) ? 1 : 0;
}
