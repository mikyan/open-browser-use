// Isolated native rendering diagnostic. This does not connect Playwright to a
// page, load the production extension, touch a user profile, or use a clipboard.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import WebSocket from "ws";

const modes = ["startup-and-secondary", "no-startup-window", "popup-then-normal", "app-startup"];
if (process.argv[2] === "--help" && process.argv.length === 3) {
  console.log(`Usage: node scripts/browser-integration/rendering-probe.mjs [${modes.join("|")}]`);
  process.exit(0);
}
assert.ok(process.argv.length <= 3, "Only one rendering probe mode is accepted");
const mode = process.argv[2] ?? modes[0];
assert.ok(modes.includes(mode), `Unknown rendering probe mode: ${mode}`);

const sourceFile = fileURLToPath(import.meta.url);
const repo = await fs.realpath(path.resolve(path.dirname(sourceFile), "../.."));
const artifactRoot = path.join(repo, ".tmp/browser-integration");
await fs.mkdir(artifactRoot, { recursive: true });
function assertInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  assert.ok(relative && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative), "Probe path escaped its parent");
}
assertInside(repo, await fs.realpath(artifactRoot));
const runDir = await fs.mkdtemp(path.join(artifactRoot, "rendering-"));
const extension = path.join(runDir, "extension"), profile = path.join(runDir, "profile");
await fs.mkdir(extension); await fs.mkdir(profile);
assertInside(await fs.realpath(runDir), await fs.realpath(profile));
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const sourceBytes = await fs.readFile(sourceFile);
await fs.writeFile(path.join(runDir, "probe-source.mjs"), sourceBytes);

const extensionName = "Open Browser Use isolated rendering probe";
const workerSource = `chrome.runtime.onInstalled.addListener(() => {});
globalThis.probeLedger = { activations: [], focus: [], created: [] };
globalThis.probeNativeRecords = [];
chrome.tabs.onActivated.addListener(event => probeLedger.activations.push({ ...event, at: Date.now() }));
chrome.windows.onFocusChanged.addListener(windowId => probeLedger.focus.push({ windowId, at: Date.now() }));
chrome.windows.onCreated.addListener(window => probeLedger.created.push({ id: window.id, type: window.type, focused: window.focused, at: Date.now() }));
`;
await fs.writeFile(path.join(extension, "manifest.json"), JSON.stringify({
  manifest_version: 3, name: extensionName, version: "1.0.0",
  permissions: ["tabs", "debugger"], background: { service_worker: "background.js" }
}));
await fs.writeFile(path.join(extension, "background.js"), workerSource);
const fixture = `<!doctype html><meta charset="utf-8"><title>Rendering probe synthetic page</title>
<style>body{margin:24px;background:#f5f8fb;color:#182c48;font:18px sans-serif}button{display:block;margin:24px 0;padding:16px;border:2px solid #2b62a1;background:#ecf3fe}</style>
<h1>Native render diagnostic</h1><button id="action">Record trusted click</button><output id="count">0</output>
<script>globalThis.clicks=[];globalThis.sizes=[];
addEventListener('resize',()=>sizes.push({kind:'resize',width:innerWidth,height:innerHeight}));
visualViewport.addEventListener('resize',()=>sizes.push({kind:'visualResize',width:visualViewport.width,height:visualViewport.height}));
document.querySelector('button').onclick=e=>{clicks.push({trusted:e.isTrusted,x:e.clientX,y:e.clientY});document.querySelector('output').value=clicks.length};</script>`;
const server = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  response.end(fixture);
});
const report = {
  runDir, mode, startedAt: new Date().toISOString(), sourceSHA256: sha256(sourceBytes),
  workerSHA256: sha256(workerSource), fixtureSHA256: sha256(fixture),
  syntheticOnly: true, windowsHide: true, noOcclusionFlags: true,
  ledgerCoverage: "Raw extension events from worker listener installation; native process startup may precede those listeners. No foreground HWND claim is made.",
  nativeWindowState: { observed: false, reason: "This portable probe does not inspect native HWND/foreground state." },
  scenarios: [], failures: [], allowedActivationEvents: [], windowCreations: [], cleanup: {}
};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function observe(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      promise.then(value => ({ settled: true, value }), error => ({ settled: true, error: String(error) })),
      new Promise(resolve => { timer = setTimeout(() => resolve({ settled: false, observationTimedOut: true, timeoutMs, label }), timeoutMs); })
    ]);
  } finally { clearTimeout(timer); }
}
async function until(operation, label, timeoutMs = 15000) {
  const deadline = performance.now() + timeoutMs;
  let lastError;
  while (performance.now() < deadline) {
    try { const result = await operation(); if (result) return result; } catch (error) { lastError = error; }
    await delay(50);
  }
  throw new Error(`Timed out: ${label}${lastError ? ` (${lastError.message})` : ""}`);
}

async function connect(url) {
  const socket = new WebSocket(url), pending = new Map();
  const opened = await observe(new Promise((resolve, reject) => {
    socket.once("open", resolve); socket.once("error", reject);
  }), 5000, "CDP connection");
  if (!opened.settled || opened.error) { socket.terminate(); throw new Error(opened.error ?? "CDP connection timed out"); }
  let nextId = 0;
  const fail = error => {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    pending.clear();
  };
  socket.on("error", fail); socket.on("close", () => fail(new Error("CDP connection closed")));
  socket.on("message", bytes => {
    const message = JSON.parse(bytes), entry = pending.get(message.id);
    if (!entry) return;
    clearTimeout(entry.timer); pending.delete(message.id);
    message.error ? entry.reject(new Error(JSON.stringify(message.error))) : entry.resolve(message.result);
  });
  return {
    call(method, params = {}, timeoutMs = 40000) {
      return new Promise((resolve, reject) => {
        const id = ++nextId, timer = setTimeout(() => {
          pending.delete(id); reject(new Error(`CDP observation deadline: ${method}; native execution may still be pending`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    async evaluate(expression) {
      const result = await this.call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    },
    close() { socket.terminate(); fail(new Error("Probe closed its CDP connection")); }
  };
}

// Evaluated only in our minimal extension's worker. Actual native promises are
// journaled separately from observation deadlines; a race timeout never marks a
// native operation settled or proves that cleanup succeeded.
async function nativeCheck(tabId) {
  const target = { tabId }, start = performance.now(), pending = new Set();
  const result = { tabId, nativeCommands: [], frames: [], acks: 0, cleanup: {} };
  probeNativeRecords.push(result);
  let attachAttempted = false, streamAttempted = false, releaseMouseNeeded = false, mousePosition, frameDeadline, resolveFirst;
  const first = new Promise(resolve => { resolveFirst = resolve; });
  const bounded = async (promise, timeoutMs, label) => {
    let timer;
    try {
      return await Promise.race([
        promise.then(value => ({ settled: true, value }), error => ({ settled: true, error: String(error) })),
        new Promise(resolve => { timer = setTimeout(() => resolve({ settled: false, observationTimedOut: true, timeoutMs, label }), timeoutMs); })
      ]);
    } finally { clearTimeout(timer); }
  };
  function native(method, operation) {
    const entry = { id: result.nativeCommands.length + 1, method, startedMs: performance.now() - start, status: "pending" };
    result.nativeCommands.push(entry);
    const promise = Promise.resolve().then(operation);
    pending.add(promise);
    promise.then(() => { entry.status = "fulfilled"; }, error => { entry.status = "rejected"; entry.error = String(error); })
      .then(() => { entry.endedMs = performance.now() - start; pending.delete(promise); });
    return promise;
  }
  const send = (method, params = {}) => native(method, () => chrome.debugger.sendCommand(target, method, params));
  async function requireResult(promise, label, timeoutMs = 3000) {
    const observed = await bounded(promise, timeoutMs, label);
    if (!observed.settled || observed.error) throw new Error(JSON.stringify(observed));
    return observed.value;
  }
  async function evaluate(expression) {
    const response = await requireResult(send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }), "native Runtime.evaluate");
    if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
    return response.result.value;
  }
  const state = () => evaluate(`({visibility:document.visibilityState,focus:document.hasFocus(),ready:document.readyState,viewport:[innerWidth,innerHeight],visual:[visualViewport.width,visualViewport.height],dpr:devicePixelRatio,scroll:[scrollX,scrollY],sizes:[...sizes],clicks:[...clicks]})`);
  const receive = (source, method, params) => {
    if (source.tabId !== tabId || source.sessionId != null || method !== "Page.screencastFrame") return;
    const frame = { atMs: performance.now() - start, sessionId: params.sessionId, metadata: params.metadata };
    result.frames.push(frame);
    send("Page.screencastFrameAck", { sessionId: params.sessionId }).then(() => {
      const acknowledgedAt = performance.now();
      result.acks++; frame.acknowledged = true; frame.acknowledgedAtMs = acknowledgedAt - start;
      frame.acknowledgedWithinDeadline = acknowledgedAt < frameDeadline;
      resolveFirst(frame.acknowledgedWithinDeadline);
    }, error => { frame.ackError = String(error); });
  };
  try {
    attachAttempted = true;
    await requireResult(native("chrome.debugger.attach", () => chrome.debugger.attach(target, "1.3")), "native attach");
    await requireResult(send("Page.enable"), "Page.enable");
    await requireResult(send("Emulation.setFocusEmulationEnabled", { enabled: true }), "focus emulation");
    result.before = await state();
    result.raf = await evaluate(`Promise.race([new Promise(r=>requestAnimationFrame(t=>r({at:t}))),new Promise(r=>setTimeout(()=>r({observationTimedOut:true}),500))])`);
    chrome.debugger.onEvent.addListener(receive);
    const frameStart = performance.now(); frameDeadline = frameStart + 10000; streamAttempted = true;
    result.firstFrameDeadlineMs = frameDeadline - start;
    await requireResult(send("Page.startScreencast", { format: "png", everyNthFrame: 1 }), "start screencast", Math.min(3000, Math.max(0, frameDeadline - performance.now())));
    result.startScreencastMs = performance.now() - frameStart;
    const remainingMs = frameDeadline - performance.now();
    result.firstFrame = remainingMs > 0
      ? await bounded(first, remainingMs, "first acknowledged screencast frame; shared start+ACK deadline")
      : { settled: false, observationTimedOut: true, timeoutMs: 0, label: "start consumed the first-frame deadline" };
    result.firstFrameWaitMs = performance.now() - frameStart;
    if (result.firstFrame.settled && result.firstFrame.value === true) {
      const box = await evaluate(`(()=>{const r=document.querySelector('button').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
      mousePosition = box;
      await requireResult(send("Input.dispatchMouseEvent", { type: "mouseMoved", ...box }), "mouse move");
      releaseMouseNeeded = true;
      await requireResult(send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", buttons: 1, clickCount: 1, ...box }), "mouse press");
      await requireResult(send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", buttons: 0, clickCount: 1, ...box }).then(value => { releaseMouseNeeded = false; return value; }), "mouse release");
      result.screenshot = await bounded(send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false }), 5000, "native screenshot (no clip)");
    }
    result.after = await state();
  } catch (error) { result.error = String(error); }
  finally {
    if (releaseMouseNeeded) result.cleanup.mouseRelease = await bounded(send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", buttons: 0, clickCount: 1, ...mousePosition }), 1000, "best-effort held mouse release (can emit click)");
    if (streamAttempted) result.cleanup.stop = await bounded(send("Page.stopScreencast"), 1000, "stop screencast");
    chrome.debugger.onEvent.removeListener(receive);
    if (attachAttempted) result.cleanup.detach = await bounded(native("chrome.debugger.detach", () => chrome.debugger.detach(target)), 1000, "native detach");
    result.cleanup.pendingDrain = await bounded(Promise.allSettled([...pending]), 1000, "actual native promises after detach");
    result.pendingNative = result.nativeCommands.filter(command => command.status === "pending").map(command => command.id);
  }
  return result;
}

let browser, worker, browserConnection;
const browserLogs = [];
async function persist() { await fs.writeFile(path.join(runDir, "results.json"), JSON.stringify(report, null, 2)); }
async function ledger() { return worker.evaluate("structuredClone(probeLedger)"); }
const failure = (stage, detail) => report.failures.push({ stage, detail });
function assertLedgerPrefix(before, after) {
  for (const kind of ["activations", "focus", "created"]) {
    assert.deepEqual(after[kind].slice(0, before[kind].length), before[kind], `${kind} ledger prefix changed`);
  }
}
async function createUnfocusedWindow(options, reason) {
  const before = await ledger();
  const created = await worker.evaluate(`chrome.windows.create(${JSON.stringify({ ...options, focused: false })})`);
  const after = await ledger();
  report.windowCreations.push({ reason, before, after, created });
  assertLedgerPrefix(before, after);
  assert.equal(created.focused, false);
  assert.deepEqual(after.focus.slice(before.focus.length), [], "Unfocused window creation changed focus");
  const active = created.tabs.find(tab => tab.active); assert.ok(active);
  const delta = after.activations.slice(before.activations.length);
  assert.ok(delta.length <= 1, "Window creation emitted duplicate/additional activation events");
  if (delta.length) {
    assert.equal(delta[0].tabId, active.id); assert.equal(delta[0].windowId, created.id);
    report.allowedActivationEvents.push({ index: before.activations.length, event: delta[0], reason });
  }
  return created;
}
function assertFinalLedger(current) {
  assertLedgerPrefix(report.initialLedger, current);
  assert.deepEqual(current.focus.slice(report.initialLedger.focus.length), []);
  const permits = new Map(report.allowedActivationEvents.map(permit => [permit.index, permit]));
  assert.equal(permits.size, report.allowedActivationEvents.length, "Duplicate activation permission index");
  assert.equal(current.activations.length - report.initialLedger.activations.length, permits.size, "Unpermitted or missing activation event");
  for (let index = report.initialLedger.activations.length; index < current.activations.length; index++) {
    assert.deepEqual(current.activations[index], permits.get(index)?.event, `Unpermitted activation at exact event index ${index}`);
  }
}
try {
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const binary = chromium.executablePath(); report.binary = binary;
  report.binarySHA256 = sha256(await fs.readFile(binary));
  const initialArgs = ["no-startup-window", "popup-then-normal"].includes(mode) ? ["--no-startup-window"]
    : mode === "app-startup" ? [`--app=${base}/sentinel-app`] : ["about:blank"];
  report.args = [`--user-data-dir=${profile}`, "--remote-debugging-port=0",
    `--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
    "--no-first-run", "--no-default-browser-check", "--site-per-process", "--no-sandbox", "--enable-logging=stderr", ...initialArgs];
  browser = spawn(binary, report.args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
  report.pid = browser.pid;
  browser.on("error", error => { report.spawnError = String(error); });
  browser.stderr.on("data", bytes => browserLogs.push(bytes.toString()));
  const port = await until(async () => (await fs.readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split(/\r?\n/)[0], "private browser DevTools port");
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  browserConnection = await connect(version.webSocketDebuggerUrl);
  report.browserVersion = await browserConnection.call("Browser.getVersion");
  worker = await until(async () => {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    for (const target of targets.filter(candidate => candidate.type === "service_worker")) {
      const connection = await connect(target.webSocketDebuggerUrl);
      try {
        if (await connection.evaluate(`chrome.runtime.getManifest().name===${JSON.stringify(extensionName)}&&typeof chrome.debugger==='object'`)) return connection;
      } catch { /* Built-in extensions are not the diagnostic worker. */ }
      connection.close();
    }
  }, "exact diagnostic extension worker");
  report.initialWindows = await worker.evaluate("chrome.windows.getAll({populate:true})");
  report.initialLedger = await ledger();
  const background = await fs.readFile(path.join(repo, "apps/chrome-extension/background.js"), "utf8");
  const start = background.indexOf("async function chooseWindowId()"), end = background.indexOf("async function readGroupTitles", start);
  assert.ok(start >= 0 && end > start, "Production window selection source shape changed");
  const selectionSource = background.slice(start, end).trim();
  assert.ok(selectionSource.includes('windowTypes: ["normal"]'), "Production window selection no longer filters normal windows");
  report.selectionSourceSHA256 = sha256(selectionSource);
  const chooseWindow = () => worker.evaluate(`(${selectionSource})()`);
  report.normalChoiceBefore = await chooseWindow();
  const scenarios = [];
  let preservedAppOrPopup;
  if (mode === "startup-and-secondary" || mode === "app-startup") {
    assert.equal(report.initialWindows.length, 1);
    const initial = report.initialWindows[0];
    assert.equal(initial.type, mode === "app-startup" ? "app" : "normal");
    const sentinel = initial.tabs.find(tab => tab.active); assert.ok(sentinel);
    if (mode === "app-startup") {
      assert.equal(report.normalChoiceBefore, null);
      preservedAppOrPopup = sentinel;
      scenarios.push({ name: "startup-app", sentinel, target: sentinel, targetIsSyntheticSentinel: true,
        note: "App windows cannot host a second tab in the prior native probe; tabs.create redirected to another normal window. This mode does not repeat that operation." });
    } else {
      await worker.evaluate(`chrome.tabs.update(${sentinel.id},{url:${JSON.stringify(base + "/sentinel-startup")}})`);
      scenarios.push({ name: "startup-normal", sentinel });
    }
  } else {
    assert.deepEqual(report.initialWindows, []); assert.equal(report.normalChoiceBefore, null);
    if (mode === "popup-then-normal") {
      const popup = await createUnfocusedWindow({ type: "popup", url: base + "/sentinel-popup" }, "initial popup sole-tab creation");
      report.popupWindow = popup;
      assert.equal(popup.type, "popup"); assert.equal(popup.focused, false);
      preservedAppOrPopup = popup.tabs.find(tab => tab.active); assert.ok(preservedAppOrPopup);
      assert.equal(await chooseWindow(), null);
    }
  }
  if (preservedAppOrPopup) {
    await until(() => worker.evaluate(`chrome.tabs.get(${preservedAppOrPopup.id}).then(t=>t.status==='complete')`), "preserved sentinel load");
    preservedAppOrPopup = await worker.evaluate(`chrome.tabs.get(${preservedAppOrPopup.id})`);
    report.preservedSentinel = preservedAppOrPopup;
  }
  const stages = ["startup-and-secondary", "app-startup"].includes(mode) ? 2 : 1;
  for (let index = 0; index < stages; index++) {
    let scenario = scenarios[index];
    if (!scenario) {
      const created = await createUnfocusedWindow({ type: "normal", left: 10, top: 10, width: 1266, height: 1372, url: base + "/sentinel-normal" }, "normal window sole-tab creation");
      assert.equal(created.type, "normal"); assert.equal(created.focused, false);
      scenario = { name: mode === "no-startup-window" ? "first-explicit-normal" : "secondary-explicit-normal", sentinel: created.tabs.find(tab => tab.active), createdWindow: created };
      assert.ok(scenario.sentinel);
    }
    report.scenarios.push(scenario);
    scenario.ledgerBefore = await ledger();
    const target = scenario.target ?? await worker.evaluate(`chrome.tabs.create({windowId:${scenario.sentinel.windowId},active:false,url:${JSON.stringify(base + "/fixture")}})`);
    scenario.target = target;
    assert.equal(target.windowId, scenario.sentinel.windowId);
    if (!scenario.targetIsSyntheticSentinel) assert.equal(target.active, false);
    await until(() => worker.evaluate(`chrome.tabs.get(${target.id}).then(t=>t.status==='complete')`), "synthetic target load");
    scenario.observation = await worker.evaluate(`(${nativeCheck.toString()})(${target.id})`);
    const observation = scenario.observation;
    const data = observation.screenshot?.value?.data;
    if (typeof data === "string") {
      const png = Buffer.from(data, "base64");
      assert.ok(png.length >= 33, "PNG is missing its complete IHDR chunk");
      assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
      assert.equal(png.readUInt32BE(8), 13, "PNG IHDR length");
      assert.equal(png.subarray(12, 16).toString("ascii"), "IHDR", "PNG first chunk type");
      assert.ok(png.readUInt32BE(16) > 0 && png.readUInt32BE(20) > 0, "PNG dimensions must be nonzero");
      const filename = `${scenario.name}.png`; await fs.writeFile(path.join(runDir, filename), png);
      observation.screenshot.value = { filename, bytes: png.length, sha256: sha256(png), width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
    }
    scenario.activeAfter = await worker.evaluate(`chrome.tabs.query({active:true,windowId:${scenario.sentinel.windowId}})`);
    scenario.ledgerAfter = await ledger(); scenario.normalChoice = await chooseWindow();
    assertLedgerPrefix(scenario.ledgerBefore, scenario.ledgerAfter);
    assert.equal(scenario.activeAfter[0].id, scenario.sentinel.id);
    assert.deepEqual(scenario.ledgerAfter.activations.slice(scenario.ledgerBefore.activations.length), []);
    assert.deepEqual(scenario.ledgerAfter.focus.slice(scenario.ledgerBefore.focus.length), []);
    if (scenario.name === "startup-app") assert.equal(scenario.normalChoice, null);
    else if (mode !== "startup-and-secondary") assert.equal(scenario.normalChoice, scenario.sentinel.windowId);
    if (!observation.firstFrame?.settled || observation.firstFrame.value !== true) failure(scenario.name, "No acknowledged native first frame within the original deadline");
    if (observation.error) failure(scenario.name, observation.error);
    if (observation.after?.clicks?.length !== 1 || observation.after.clicks[0].trusted !== true) failure(scenario.name, "Exactly one trusted click was not observed");
    if (!observation.screenshot?.settled || !observation.screenshot.value?.filename) failure(scenario.name, "Native PNG was not completed");
    if (observation.before && observation.after) {
      assert.deepEqual(observation.after.viewport, observation.before.viewport);
      assert.deepEqual(observation.after.visual, observation.before.visual);
      assert.equal(observation.after.dpr, observation.before.dpr);
      assert.deepEqual(observation.after.scroll, observation.before.scroll);
      assert.deepEqual(observation.after.sizes, observation.before.sizes, "Resize/visualViewport events occurred during the native probe");
    }
    await persist();
    console.log(JSON.stringify({ stage: scenario.name, firstFrame: observation.firstFrame, frames: observation.frames.length, acks: observation.acks }));
  }
  report.finalLedger = await ledger(); report.finalWindows = await worker.evaluate("chrome.windows.getAll({populate:true})");
  assertFinalLedger(report.finalLedger);
  if (preservedAppOrPopup) {
    const current = await worker.evaluate(`chrome.tabs.query({active:true,windowId:${preservedAppOrPopup.windowId}})`);
    report.preservedSentinelAfter = current;
    assert.equal(current[0].id, preservedAppOrPopup.id); assert.equal(current[0].url, preservedAppOrPopup.url);
  }
} catch (error) { report.error = error.stack; failure("probe", String(error)); }
finally {
  if (worker) {
    try {
      report.preCleanupLedger = await ledger();
      report.preCleanupWindows = await worker.evaluate("chrome.windows.getAll({populate:true})");
      report.finalNativeSettlement = await worker.evaluate("probeNativeRecords.map(r=>({tabId:r.tabId,commands:r.nativeCommands,pending:r.nativeCommands.filter(c=>c.status==='pending').map(c=>c.id),acks:r.acks,frames:r.frames,cleanup:r.cleanup}))");
      report.finalNativeSettlementCapturedAt = new Date().toISOString();
      if (report.initialLedger) assertFinalLedger(report.preCleanupLedger);
      if (report.finalLedger) assert.deepEqual(report.preCleanupLedger, report.finalLedger);
      for (const record of report.finalNativeSettlement) {
        if (record.pending.length) failure("native cleanup", `Unsettled native command IDs for tab ${record.tabId}: ${record.pending.join(",")}`);
        if (record.commands.some(command => command.status === "rejected")) failure("native cleanup", `Native command rejected for tab ${record.tabId}; inspect journal`);
      }
    } catch (error) { report.cleanup.snapshotError = String(error); failure("cleanup snapshot", String(error)); }
    // This worker belongs exclusively to the fresh profile created above.
    report.cleanup.closeOwnWindows = await observe(worker.evaluate("chrome.windows.getAll().then(w=>Promise.all(w.map(x=>chrome.windows.remove(x.id))))"), 3000, "close this profile's windows");
  }
  if (browserConnection && browser?.exitCode === null) {
    report.cleanup.browserClose = await observe(browserConnection.call("Browser.close", {}, 3000), 3000, "close private browser instance");
  }
  worker?.close(); browserConnection?.close();
  if (browser && browser.exitCode === null && browser.signalCode === null) {
    report.cleanup.processExit = await observe(new Promise(resolve => browser.once("exit", (code, signal) => resolve({ code, signal }))), 3000, "private browser root exit");
    if (!report.cleanup.processExit.settled) {
      report.cleanup.fallbackKill = { attempted: true, reason: "Private spawned root did not exit after window/Browser.close" };
      browser.kill();
      report.cleanup.afterKillExit = await observe(new Promise(resolve => browser.once("exit", (code, signal) => resolve({ code, signal }))), 3000, "spawned browser root after kill");
      failure("cleanup", "Graceful browser exit was not observed; fallback kill is not evidence that every native promise settled");
    }
  }
  report.cleanup.browserRootExitCode = browser?.exitCode ?? null;
  report.cleanup.browserRootSignal = browser?.signalCode ?? null;
  report.cleanup.browserRootExited = !!browser && (browser.exitCode !== null || browser.signalCode !== null);
  report.cleanup.descendantProcessInventory = "not observed; no claim that a timed-out native promise fulfilled";
  if (browser && !report.cleanup.browserRootExited) failure("cleanup", "Private browser root is still running");
  if (server.listening) await new Promise(resolve => server.close(resolve));
  report.endedAt = new Date().toISOString(); report.passed = report.failures.length === 0;
  await fs.writeFile(path.join(runDir, "browser.log"), browserLogs.join("")); await persist();
  console.log(JSON.stringify({ runDir, mode, passed: report.passed, failures: report.failures }, null, 2));
  if (!report.passed) process.exitCode = 1;
}
