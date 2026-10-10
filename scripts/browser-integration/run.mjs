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

// Playwright supplies the browser executable only. No Playwright page/context
// connection is used: all browser actions go through the public SDK and host.
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
const browserLog = [];
const hostLog = [];
let sourceIdentity;
const versions = { node: process.version, browserRunner: "playwright@1.64.0 (executable lookup only)" };
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(callback, label, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try { const value = await callback(); if (value) return value; } catch {}
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
function frame(message) {
  const body = Buffer.from(JSON.stringify(message));
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

let httpPort, actionVisits = 0;
const http = createServer(async (request, response) => {
  const route = new URL(request.url, "http://localhost").pathname;
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
let host, chrome, worker, browser, sentinel, activeEvents = [];
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
  if (goExecutable) sourceIdentity.sha256.goClient = createHash("sha256").update(await fs.readFile(goExecutable)).digest("hex");

  host = spawn(path.resolve(executable), ["host", "--socket-dir", socketDir], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  host.stderr.on("data", data => hostLog.push(data.toString()));
  let extensionSocket, extensionId, nativeBuffer = Buffer.alloc(0);
  const outbound = [];
  ws.on("connection", (socket, request) => {
    extensionSocket = socket;
    extensionId = new URL(request.url, websocketURL).searchParams.get("extensionId");
    for (const message of outbound.splice(0)) socket.send(message);
    socket.on("message", message => host.stdin.write(frame(JSON.parse(message.toString()))));
  });
  host.stdout.on("data", data => {
    nativeBuffer = Buffer.concat([nativeBuffer, data]);
    while (nativeBuffer.length >= 4) {
      const length = os.endianness() === "LE" ? nativeBuffer.readUInt32LE() : nativeBuffer.readUInt32BE();
      assert.ok(length <= 64 * 1024 * 1024, "Invalid native messaging frame");
      if (nativeBuffer.length < 4 + length) break;
      const message = nativeBuffer.subarray(4, 4 + length).toString();
      nativeBuffer = nativeBuffer.subarray(4 + length);
      if (extensionSocket?.readyState === WebSocket.OPEN) extensionSocket.send(message); else outbound.push(message);
    }
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
  const fixtureURL = `http://127.0.0.1:${httpPort}/`;
  console.log("HARNESS", JSON.stringify({ endpoint, fixtureURL, runDir, sentinelId: sentinel.id }));
  browser = await connectOpenBrowserUse({ socketPath: endpoint, sessionId: "js-browser-integration", turnId: "acceptance", timeoutMs: 15000 });
  const tab = await browser.newTab();
  async function activeInvariant() {
    const active = await worker.evaluate(`chrome.tabs.query({active:true,windowId:${sentinel.windowId}})`);
    assert.equal(active[0]?.id, sentinel.id, "Agent action changed the active tab");
    const events = await worker.evaluate("globalThis.__integrationActivations");
    assert.ok(events.every(event => event.tabId === sentinel.id), `Agent temporarily activated another tab: ${JSON.stringify(events)}`);
  }
  async function test(name, run) {
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
  await test("js-role-name-yaml-snapshot", async () => {
    const snapshot = await tab.domSnapshot();
    assert.match(snapshot, /button "ARIA named action"/);
    assert.match(snapshot, /textbox "Controlled name"/);
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
    return (await call("snapshot")).engine;
  });
  await test("mcp-browser-action", async () => {
    const params = { tabId: tab.id, timeoutMs: 10000 };
    const messages = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "obu-browser-integration", version: "1.0.0" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "call", arguments: { method: "browserAction", params: { ...params, action: "fill", locator: [{ kind: "label", value: "Controlled name", exact: true }], args: { value: "MCP 中文" } } } } },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "call", arguments: { method: "browserAction", params: { ...params, action: "textContent", locator: [{ kind: "css", selector: "#controlled-result" }] } } } }
    ];
    const replies = await new Promise((resolve, reject) => {
      const child = spawn(path.resolve(executable), ["mcp", "--socket", endpoint, "--session-id", "js-browser-integration", "--timeout", "15s"], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      const responses = [];
      let buffer = "", errors = "";
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
            else if (response.id === 3) child.stdin.end();
          } catch (error) { child.kill(); reject(error); }
        }
      });
      child.stderr.on("data", chunk => errors += chunk.toString());
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("exit", code => { clearTimeout(timer); code === 0 ? resolve(responses) : reject(new Error(`MCP exited ${code}: ${errors}`)); });
      send(messages[0]);
    });
    assert.equal(replies.length, 3);
    assert.equal(replies[0].result.protocolVersion, "2025-06-18");
    for (const reply of replies.slice(1)) {
      assert.equal(reply.error, undefined);
      assert.equal(reply.result.isError, false, JSON.stringify(reply.result));
      assert.equal(reply.result.structuredContent.error, undefined);
      assert.equal(reply.result.structuredContent.result.engine.name, "playwright-crx");
    }
    assert.equal(replies[2].result.structuredContent.result.value, "MCP 中文");
    assert.equal(await tab.getByLabel("Controlled name").inputValue(), "MCP 中文");
    return { protocolVersion: replies[0].result.protocolVersion, engine: replies[2].result.structuredContent.result.engine };
  });
  await test("python-public-sdk", async () => {
    const result = await new Promise((resolve, reject) => {
      const python = spawn(process.env.OBU_TEST_PYTHON || "python", [pythonChecks, endpoint, fixtureURL], {
        windowsHide: true, env: { ...process.env, PYTHONPATH: path.dirname(pythonSnapshot), PYTHONIOENCODING: "utf-8" }, stdio: ["ignore", "pipe", "pipe"]
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
    const result = JSON.parse(await subprocess(goExecutable, [endpoint, fixtureURL], { timeoutMs: 120000 }));
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
    let browserControl, popupControl, popupId, observerInstalled = false;
    try {
      const owned = await recovery.newTab({ url: fixtureURL });
      const oldEpoch = recovery.client.controlEpoch;
      const previousActivations = await worker.evaluate("globalThis.__integrationActivations");
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
      await assert.rejects(recovery.client.getTabs(), /OBU_STALE_CONTROL_EPOCH|OBU_CONTROL_BOOTSTRAP_REQUIRED/);
      assert.equal(recovery.client.controlEpoch, oldEpoch, "restart silently refreshed the client");
      await recovery.client.beginTurn();
      assert.ok(recovery.client.controlEpoch > oldEpoch);
      assert.match(await owned.domSnapshot(), /Controlled name/);
      await owned.getByLabel("Controlled name").fill("recovered after worker restart");
      assert.equal(await owned.getByLabel("Controlled name").inputValue(), "recovered after worker restart");
      return { oldEpoch, recoveredEpoch: recovery.client.controlEpoch, oldTarget: oldTarget.id, restartedTarget: restarted.id, restartEvents };
    } finally {
      try { await recovery.client.finalizeTabs([]); } finally {
        recovery.close();
        if (observerInstalled) {
          const observed = await popupControl.evaluate("globalThis.__restartActivations");
          assert.ok(Array.isArray(observed), "The activation observer document changed before cleanup");
          await worker.evaluate(`globalThis.__integrationActivations.push(...${JSON.stringify(observed)})`);
        }
        if (popupId) await browserControl?.call("Target.closeTarget", { targetId: popupId });
        popupControl?.close(); browserControl?.close();
      }
    }
  });
  await test("js-user-global-pause-popup", async () => checkGlobalPause({
    connectBrowser: suffix => connectOpenBrowserUse({ socketPath: endpoint, sessionId: `js-${suffix}`, timeoutMs: 15000 }),
    getWorker: () => worker, fixtureURL, popupURL: `chrome-extension://${extensionId}/popup.html`, windowId: sentinel.windowId, assert, until,
    saveDetail: detail => fs.writeFile(path.join(runDir, "pause-control.json"), JSON.stringify(detail, null, 2)),
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
      const previousActivations = await worker.evaluate("globalThis.__integrationActivations");
      await observer.evaluate("globalThis.__pauseActivations=[];chrome.tabs.onActivated.addListener(info=>globalThis.__pauseActivations.push(info))");
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
      return { oldTarget: oldTarget.id, restartedTarget: restarted.id, activeEvents: observed };
    }
  }));
  activeEvents = await worker.evaluate("globalThis.__integrationActivations");
} catch (error) {
  records.push({ name: "fatal", passed: false, error: error.stack }); console.error(error);
} finally {
  browser?.close();
  if (worker) { try { await worker.evaluate("chrome.windows.getAll().then(windows=>Promise.all(windows.map(window=>chrome.windows.remove(window.id))))"); } catch {} worker.close(); }
  if (chrome && chrome.exitCode === null) chrome.kill();
  if (host && host.exitCode === null) { host.stdin.end(); await Promise.race([new Promise(resolve => host.once("exit", resolve)), delay(1000)]); if (host.exitCode === null) host.kill(); }
  for (const client of ws.clients) client.terminate();
  await new Promise(resolve => ws.close(resolve));
  await new Promise(resolve => http.close(resolve));
  await fs.writeFile(path.join(runDir, "results.json"), JSON.stringify({ platform: process.platform, versions, headed: true, productionExtension: true, adapter: "connectNative replaced by loopback WebSocket for isolated testing only", nativeHost: executable, sourceIdentity, activeEvents, records }, null, 2));
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
