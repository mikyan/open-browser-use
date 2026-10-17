// One original business transaction and real viewer DOM controls. The viewer
// owns a second headless profile; task input uses only the production OBU SDK.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium as playwrightChromium } from "playwright";
import { createCreatedPageFixtures } from "./created-page-fixture.mjs";
import { installCreatedPageObserver, assertCreatedPageSource, assertCreatedPageReceipt } from "./created-page-provenance.mjs";
import { connectNormalCDP, managedProcess, runProcess, bound, poll, sleep } from "./normal-browser-downloads-support.mjs";
import { listenFixture } from "./fixture-listener.mjs";
import { browserStartupOptions } from "./browser-startup.mjs";
import { waitPrivateDevToolsEndpoint } from "./private-devtools-endpoint.mjs";
import { observedProcessDescendants as descendants } from "./observed-process-descendants.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10];
const redact = text => text.replace(/(#ticket=)[A-Za-z0-9_-]+/g, "$1[redacted]");
const serialize = value => JSON.stringify(value, (_key, item) => typeof item === "string" ? redact(item) : item, 2);

export function projectViewerCommand(message) {
  if (message?.type === "authenticate") return null;
  assert.ok(message && typeof message === "object" && !Array.isArray(message), "Invalid viewer command envelope");
  assert.ok(Number.isSafeInteger(message.id) && message.id > 0, "Invalid viewer command ID");
  assert.ok(["status", "select", "pause", "resume", "stop"].includes(message.operation), "Unexpected viewer operation");
  const result = { id: message.id, operation: message.operation };
  const allowed = new Set(["id", "operation"]);
  if (message.operation === "select") {
    assert.ok(message.tabId === null || Number.isSafeInteger(message.tabId) && message.tabId > 0, "Invalid viewer selection");
    allowed.add("tabId"); result.tabId = message.tabId;
    if (message.deliveryId !== undefined) {
      assert.ok(message.tabId !== null && typeof message.deliveryId === "string" && message.deliveryId.length > 0 && message.deliveryId.length <= 128 && !/[\x00-\x1f\x7f]/.test(message.deliveryId), "Invalid original delivery identity");
      allowed.add("deliveryId"); result.deliveryId = message.deliveryId;
    }
  }
  if (message.operation === "resume") {
    assert.ok(Number.isSafeInteger(message.expectedRevision) && message.expectedRevision >= 0, "Invalid viewer revision");
    assert.ok(typeof message.expectedWorkerBootId === "string" && message.expectedWorkerBootId.length > 0 && message.expectedWorkerBootId.length <= 256, "Invalid viewer worker identity");
    allowed.add("expectedRevision"); allowed.add("expectedWorkerBootId");
    result.expectedRevision = message.expectedRevision; result.expectedWorkerBootId = message.expectedWorkerBootId;
  }
  assert.ok(Object.keys(message).every(key => allowed.has(key)), "Unexpected viewer command field");
  return result;
}

export function assertManagedViewerFrames(frames, { tabId, streamId, minFrames = 3 }) {
  const selected = frames.filter(frame => frame.tabId === tabId && frame.streamId === streamId);
  assert.ok(selected.length >= minFrames, "Not enough original native frames");
  let sequence = 0;
  for (const frame of selected) {
    assert.ok(Number.isSafeInteger(frame.sequence) && frame.sequence > sequence, "Native frame sequence must increase within the same stream");
    assert.equal(frame.mimeType, "image/png");
    assert.ok(frame.bytes > 24 && frame.bytes <= 4 * 1024 * 1024);
    assert.match(frame.sha256, /^[0-9a-f]{64}$/);
    assert.ok(frame.width > 0 && frame.height > 0);
    sequence = frame.sequence;
  }
  assert.ok(new Set(selected.map(frame => frame.sha256)).size >= Math.min(3, minFrames), "Frames must contain real changing pixels, not repeated screenshots");
  return { tabId, streamId, frames: selected.length, firstSequence: selected[0].sequence, lastSequence: sequence };
}

export function assertManagedViewerTerminal(lifecycle, info) {
  assert.equal(lifecycle.version, 1); assert.equal(lifecycle.state, "closed");
  assert.deepEqual(lifecycle.info, info); assert.ok(lifecycle.readyAt && lifecycle.endedAt);
  assert.equal(lifecycle.error, undefined); assert.equal(lifecycle.forced, false); assert.equal(lifecycle.forceReason, undefined);
  for (const field of ["browserClose", "browserExit", "nativeExit", "jobEmpty", "registrationCleanup", "endpointCleanup"]) {
    assert.ok(Number.isFinite(Date.parse(lifecycle[field]?.at)), `Missing original ${field} receipt`);
    assert.equal(lifecycle[field].error, undefined, `${field} failed`);
  }
  assert.deepEqual(lifecycle.browserClose.result, {});
  assert.equal(lifecycle.browserExit.code, 0); assert.equal(lifecycle.nativeExit.code, 0);
  assert.deepEqual(lifecycle.jobEmpty.result, { activeProcesses: 0 });
  assert.equal(lifecycle.nativeDescriptor.pid, info.nativePID);
  assert.equal(lifecycle.nativeDescriptor.socketPath, info.socketPath);
  assert.ok(lifecycle.nativeCreationTime > 0);
  assert.equal(lifecycle.binding.bound, true); assert.equal(lifecycle.binding.exclusive, true);
  assert.equal(lifecycle.binding.extensionInstanceId, info.extensionInstanceId);
}

async function treeHashes(root) {
  const entries = await fs.readdir(root, { recursive: true, withFileTypes: true });
  const files = entries.filter(entry => entry.isFile()).map(entry => path.join(entry.parentPath, entry.name)).sort();
  return Object.fromEntries(await Promise.all(files.map(async file => [path.relative(root, file).replaceAll("\\", "/"), hash(await fs.readFile(file))])));
}
function assertPrivatePath(root, file) {
  const relative = path.relative(root, file);
  assert.ok(relative && !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`), "Expected a path inside the original private run");
}
async function devToolsEndpoint(profile, owner) {
  return waitPrivateDevToolsEndpoint(profile, { assertAlive() {
    const record = owner.record;
    if (record.exitedAt !== undefined || record.closedAt !== undefined || record.spawnError !== undefined) {
      throw new Error(`Original private browser owner ended before DevTools publication (PID ${record.pid}, code ${record.code ?? "unknown"})`);
    }
  } });
}

export async function runManagedViewerCheck() {
  assert.equal(process.platform, "win32");
  const executable = process.env.OBU_TEST_HOST_BINARY, chromium = process.env.OBU_TEST_CHROMIUM_BINARY, extension = process.env.OBU_TEST_EXTENSION_DIR;
  assert.ok(executable && chromium && extension, "Set OBU_TEST_HOST_BINARY, OBU_TEST_CHROMIUM_BINARY and OBU_TEST_EXTENSION_DIR explicitly");
  await Promise.all([executable, chromium, extension].map(file => fs.access(file)));
  await fs.mkdir(path.join(repo, ".tmp/browser-integration"), { recursive: true });
  const runDir = await fs.mkdtemp(path.join(repo, ".tmp/browser-integration/managed-viewer-"));
  const root = path.join(runDir, "owned-root"), name = "viewer-acceptance", viewerProfile = path.join(runDir, "viewer-profile");
  const report = { runDir, startedAt: Date.now(), commands: [], steps: [], cleanup: {}, frames: [], viewerMessages: [], viewerCommands: [], viewerActions: [], viewerDecodedFrames: [], viewerErrors: [],
    scope: "Production managed launcher, original SDK transaction, independent headless viewer using real DOM controls; no OS foreground or login-handoff acceptance" };
  const save = () => fs.writeFile(path.join(runDir, "results.json"), serialize(report));
  const registry = new Set(), screenshots = [], frameWrites = [];
  let launcher, info, worker, taskBrowser, viewerProcess, viewerBrowser, page, stopped = false, captureError, lastUIState;
  const fixtures = createCreatedPageFixtures();
  const server = createServer((request, response) => { if (!fixtures.handle(request, response)) { request.resume(); response.writeHead(404); response.end("NOT_FOUND"); } });
  const launch = (program, args, options = {}) => {
    const record = {}; report.commands.push(record);
    return managedProcess(program, args, { cwd: repo, registry, record, maximumBytes: 2 * 1024 * 1024, ...options });
  };
  async function command(args, expected = 0) {
    const running = launch(executable, args, { timeoutMs: args[0] === "managed" && args[1] === "stop" ? 55000 : 45000 });
    const result = await running.completed;
    assert.equal(result.code, expected, redact(result.stderr));
    return result;
  }
  async function processTable() {
    const record = {};
    await runProcess("powershell.exe", ["-NoProfile", "-Command", "@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,ExecutablePath,@{n='CreationDate';e={$_.CreationDate.ToUniversalTime().ToString('o')}}) | ConvertTo-Json -Compress"], { record, registry, timeoutMs: 15000 });
    return JSON.parse(record.stdout);
  }
  const checkCapture = () => { if (captureError) throw captureError; };
  const wait = (read, label, timeoutMs = 15000) => poll(async () => { checkCapture(); return read(); }, { timeoutMs, intervalMs: 40, label });
  async function step(label, operation) {
    const record = { name: label, startedAt: Date.now() }; report.steps.push(record); console.log("STEP", label);
    try { await operation(); checkCapture(); record.passed = true; }
    catch (error) { record.passed = false; record.error = error.stack; report.firstFailure ??= { step: label, at: Date.now(), error: error.stack }; throw error; }
    finally { record.endedAt = Date.now(); await save(); }
  }
  async function screenshot(file) {
    const png = await page.screenshot({ path: path.join(runDir, file) });
    const record = { file, at: Date.now(), sha256: hash(png), bytes: png.length }; screenshots.push(record); return record;
  }
  const frameCount = () => report.frames.length;
  const latestFrame = () => report.frames.at(-1);
  async function nextFrame(after, tabId) {
    return wait(() => report.frames.slice(after).find(frame => frame.tabId === tabId), "native frame after the original action");
  }
  async function decodedFrame(frame) {
    const state = await wait(async () => {
      const state = await page.locator("#frame").evaluate(element => ({ hidden: element.hidden, complete: element.complete, width: element.naturalWidth, height: element.naturalHeight, ...element.dataset }));
      state.freshness = await page.locator("#freshness").textContent();
      return !state.hidden && state.complete && state.width > 0 && state.height > 0 && state.freshness.startsWith("实时") && state.streamId === frame.streamId && Number(state.frameSequence) >= frame.sequence && state;
    }, "real viewer image decoded");
    report.viewerDecodedFrames.push({ at: Date.now(), requested: { streamId: frame.streamId, sequence: frame.sequence }, ...state });
    return state;
  }
  async function viewerAction(selector, operation, tabId) {
    const action = { selector, operation, ...(tabId === undefined ? {} : { tabId }), startedAt: Date.now() };
    report.viewerActions.push(action);
    const before = report.viewerCommands.length;
    try {
      if (operation === "select") await page.locator(selector).selectOption(String(tabId));
      else await page.locator(selector).click();
      action.dispatchedAt = Date.now();
      const matches = () => report.viewerCommands.slice(before).filter(value => value.operation === operation && (operation !== "select" || value.tabId === tabId));
      const request = await wait(() => matches()[0], `outgoing ${operation} from original DOM action`);
      action.requestId = request.id;
      const response = await wait(() => report.viewerMessages.find(value => value.type === "response" && value.id === request.id), `actual ${operation} response`, operation === "stop" ? 55000 : 35000);
      action.responseAt = response.at;
      assert.equal(matches().length, 1, "Original DOM action must submit exactly one matching command");
      assert.equal(response.error, undefined, serialize(response.error));
      action.completedAt = Date.now();
      return response;
    } catch (error) { action.error = error.stack; throw error; }
  }
  async function denied(label, operation, pattern) {
    const record = { label, at: Date.now() }; (report.denied ??= []).push(record);
    try { await operation(); }
    catch (error) { record.error = error.stack; assert.match(error.message, pattern); record.verified = true; return; }
    throw new Error(`${label} unexpectedly succeeded`);
  }
  const frames = tabId => worker.evaluate(`chrome.webNavigation.getAllFrames({tabId:${tabId}})`);
  const readState = async tab => JSON.parse(await tab.locator("#state").textContent({ timeoutMs: 5000 }));
  const posts = () => fixtures.allStats().requests.filter(value => value.method === "POST");
  let child, freshChild, fixture, item;

  try {
    report.source = { executable: hash(await fs.readFile(executable)), browser: hash(await fs.readFile(chromium)), extension: await treeHashes(extension), sdk: await treeHashes(path.join(repo, "packages/open-browser-use-js/dist")) };
    const snapshot = path.join(runDir, "source-snapshot");
    for (const source of ["cmd/open-browser-use/managed.go", "internal/managedbrowser", "internal/managedviewer", "apps/chrome-extension/browser-rendering.js", "apps/chrome-extension/managed-user-bridge.js", "apps/chrome-extension/background.js", "scripts/browser-integration/managed-viewer-check.mjs", "scripts/browser-integration/private-devtools-endpoint.mjs", "scripts/browser-integration/observed-process-descendants.mjs", "scripts/browser-integration/created-page-fixture.mjs", "scripts/browser-integration/created-page-provenance.mjs", "scripts/browser-integration/normal-browser-downloads-support.mjs", "scripts/browser-integration/native-browser-installation.mjs", "scripts/browser-integration/browser-startup.mjs", "scripts/browser-integration/fixture-listener.mjs", "scripts/browser-integration/package.json", "scripts/browser-integration/package-lock.json"]) {
      const destination = path.join(snapshot, source); await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.cp(path.join(repo, source), destination, { recursive: true });
    }
    report.source.snapshot = await treeHashes(snapshot);
    await fs.cp(extension, path.join(runDir, "extension-input"), { recursive: true });
    await fs.cp(path.join(repo, "packages/open-browser-use-js/dist"), path.join(runDir, "sdk-input"), { recursive: true });
    const { connectOpenBrowserUse } = await import(pathToFileURL(path.join(runDir, "sdk-input/index.js")));
    await listenFixture(server); const fixtureURL = `http://127.0.0.1:${server.address().port}`;
    await step("production-run-and-independent-viewer", async () => {
      launcher = launch(executable, ["managed", "run", "--root", root, "--name", name, "--browser-path", chromium, "--extension-dir", extension, "--startup-timeout", "30s"]);
      const ready = await wait(() => {
        if (launcher.record.closedAt) throw new Error(`Managed launcher exited ${launcher.record.code}: ${launcher.record.stderr}`);
        const text = launcher.record.stdout.trim(); if (!text.endsWith("}")) return null;
        return JSON.parse(text);
      }, "production managed ready", 40000);
      assert.equal(ready.state, "ready"); info = ready.info; report.info = info;
      assert.equal(info.name, name); assertPrivatePath(root, info.runDir);
      assert.ok(info.runId && info.nativePID > 0 && info.browserPID > 0);
      assert.equal(JSON.stringify(info).includes("ticket="), false);
      report.originalProcesses = descendants(await processTable(), info.browserPID);
      assert.ok(report.originalProcesses.some(value => value.ProcessId === info.nativePID));
      const status = JSON.parse((await command(["managed", "status", "--root", root, "--name", name])).stdout);
      assert.deepEqual(status.info, info); assert.equal(JSON.stringify(status).includes("ticket="), false);
      const fresh = JSON.parse((await command(["managed", "view", "--root", root, "--name", name])).stdout);
      assert.equal(fresh.state, "viewer"); assert.equal(fresh.runId, info.runId);
      const originalURL = new URL(ready.viewerURL), viewerURL = new URL(fresh.viewerURL);
      assert.equal(viewerURL.origin, originalURL.origin); assert.equal(viewerURL.hostname, "127.0.0.1");
      assert.match(viewerURL.hash, /^#ticket=[A-Za-z0-9_-]{43}$/); assert.notEqual(viewerURL.hash, originalURL.hash);
      report.viewerTicket = { origin: viewerURL.origin, originalSha256: hash(originalURL.hash), currentSha256: hash(viewerURL.hash), rotated: true };
      const startup = browserStartupOptions([`--user-data-dir=${viewerProfile}`, "--headless=new", "--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "about:blank"], process.env.OBU_TEST_FIELD_TRIAL_CONFIG);
      report.viewerStartup = startup;
      viewerProcess = launch(chromium, startup.args);
      const endpoint = await devToolsEndpoint(viewerProfile, viewerProcess);
      viewerBrowser = await playwrightChromium.connectOverCDP(endpoint.url);
      const context = viewerBrowser.contexts()[0]; page = context.pages()[0] ?? await context.newPage();
      await page.setViewportSize({ width: 1180, height: 900 });
      report.viewerProcesses = descendants(await processTable(), viewerProcess.record.pid);
      assert.ok(report.viewerProcesses.length > 0 && !report.viewerProcesses.some(value => value.ProcessId === info.browserPID));
      page.on("pageerror", error => { report.viewerErrors.push({ at: Date.now(), error: error.stack }); captureError ??= error; });
      page.on("websocket", socket => {
        try { assert.equal(new URL(socket.url()).origin.replace("ws:", "http:"), viewerURL.origin); }
        catch (error) { captureError ??= error; return; }
        socket.on("framesent", event => {
          try {
            const command = projectViewerCommand(JSON.parse(String(event.payload)));
            if (command === null) return;
            if (report.viewerCommands.length >= 2048) throw new Error("Viewer outgoing command capacity exceeded");
            report.viewerCommands.push({ ...command, at: Date.now() });
          } catch (error) { captureError ??= error; }
        });
        socket.on("framereceived", event => {
          try {
            const message = JSON.parse(String(event.payload)), at = Date.now();
            if (report.viewerMessages.length >= 4096) throw new Error("Viewer observation event capacity exceeded");
            if (message.type === "frame") {
              if (report.frames.length >= 1024) throw new Error("Viewer frame observation capacity exceeded");
              assert.equal(message.mimeType, "image/png");
              assert.ok(typeof message.data === "string" && message.data.length <= 4 * Math.ceil(4 * 1024 * 1024 / 3));
              const png = Buffer.from(message.data, "base64"); assert.deepEqual([...png.subarray(0, 8)], pngSignature);
              const frame = { ...message, data: undefined, at, bytes: png.length, sha256: hash(png), width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
              if (report.frames.length < 64) {
                frame.file = `native-frame-${String(report.frames.length).padStart(4, "0")}.png`;
                const write = fs.writeFile(path.join(runDir, frame.file), png); frameWrites.push(write); write.catch(error => { captureError ??= error; });
              }
              report.frames.push(frame); report.viewerMessages.push({ type: "frame", at, tabId: frame.tabId, streamId: frame.streamId, sequence: frame.sequence, sha256: frame.sha256 });
            } else {
              report.viewerMessages.push({ ...message, at });
              if (message.type === "state") lastUIState = message;
              if (message.type === "response" && message.result?.status) lastUIState = message.result;
            }
          } catch (error) { captureError ??= error; }
        });
      });
      await page.goto(viewerURL.href, { waitUntil: "domcontentloaded" });
      await wait(async () => await page.locator("#connection").textContent() === "已连接", "real viewer authentication");
      assert.equal(new URL(page.url()).hash, ""); assert.equal(lastUIState.status.state, "running");
      report.viewerInitial = { state: lastUIState, screenshot: await screenshot("viewer-initial.png") };
    });

    await step("original-child-and-native-frame-stream", async () => {
      const endpoint = await devToolsEndpoint(info.profileDir, launcher);
      const targets = await (await fetch(`http://127.0.0.1:${endpoint.port}/json/list`)).json();
      const target = targets.find(value => value.type === "service_worker" && value.url === `chrome-extension://${info.extensionId}/background.js`); assert.ok(target);
      report.observerConnection = {};
      worker = await connectNormalCDP(target.webSocketDebuggerUrl, { record: report.observerConnection, handshakeTimeoutMs: 10000, authorizationRequired: false });
      report.observer = await worker.evaluate(`(${installCreatedPageObserver.toString()})(chrome,globalThis,{maxSources:1})`);
      taskBrowser = await connectOpenBrowserUse({ socketPath: info.socketPath, sessionId: "managed-viewer-acceptance", turnId: "original", timeoutMs: 10000 });
      fixture = fixtures.createCase({ owner: "managed-viewer", variant: "root" });
      const source = await taskBrowser.newTab({ url: fixtureURL + fixture.urlPath, backgroundWindow: true });
      item = report.business = { key: fixture.key, owner: fixture.owner, tabId: source.id, childURL: fixtureURL + "/created-page/child" };
      item.sourceBefore = await readState(source); item.sourceFrame = (await frames(source.id)).find(frame => frame.frameId === 0);
      item.observerReady = await worker.evaluate(`__createdPageProvenance.register(${source.id})`);
      const waiter = await source.expectPage({ timeoutMs: 15000 });
      await source.getByRole("link", { name: "Open original child", exact: true }).click({ modifiers: ["Control"], timeoutMs: 10000 });
      child = await waiter.result(); item.childId = child.id;
      item.events = (await worker.evaluate("__createdPageProvenance.snapshot()")).events;
      item.sourceAfter = await readState(source); item.sourceFrames = await frames(source.id);
      assert.equal(assertCreatedPageSource({ item, events: item.events, afterFrames: item.sourceFrames, sourceState: item.sourceAfter }), child.id);
      item.childBefore = await readState(child); item.childFrame = (await frames(child.id)).find(frame => frame.frameId === 0);
      await viewerAction("#refresh", "status");
      await wait(async () => await page.locator(`#tabs option[value="${child.id}"]`).count(), "original attached child in trusted viewer");
      const before = frameCount(); await viewerAction("#tabs", "select", child.id);
      const first = await nextFrame(before, child.id); await decodedFrame(first); report.originalStream = first.streamId;
      for (const [label, value] of [["Source key", item.key], ["Owner", item.owner]]) {
        const count = frameCount();
        await child.getByLabel(label, { exact: true }).fill(value, { timeoutMs: 10000 });
        (report.inputReceipts ??= []).push({ label, at: Date.now(), valueSha256: hash(value) });
        await nextFrame(count, child.id);
      }
      const count = frameCount(); await child.getByRole("button", { name: "Commit child receipt", exact: true }).hover({ timeoutMs: 10000 });
      await nextFrame(count, child.id); await decodedFrame(latestFrame());
      report.feedback = await child.evaluate(`(()=>{const root=document.getElementById('open-browser-use-cursor-root'),shadow=root?.shadowRoot;const read=id=>{const e=shadow?.querySelector('[data-testid="'+id+'"]');if(!e)return null;const r=e.getBoundingClientRect(),s=getComputedStyle(e);return {display:s.display,visibility:s.visibility,x:r.x,y:r.y,width:r.width,height:r.height,opacity:s.opacity}};return {root:!!root,viewport:{width:innerWidth,height:innerHeight},cursor:read('browser-agent-cursor'),target:read('browser-agent-target')}})()`);
      assert.equal(report.feedback.root, true);
      for (const value of [report.feedback.cursor, report.feedback.target]) {
        assert.ok(value && value.width > 0 && value.height > 0 && Number(value.opacity) > 0);
        assert.notEqual(value.display, "none"); assert.notEqual(value.visibility, "hidden");
        assert.ok(value.x + value.width > 0 && value.x < report.feedback.viewport.width && value.y + value.height > 0 && value.y < report.feedback.viewport.height);
      }
      const png = Buffer.from((await child.screenshot({ timeoutMs: 10000 })).base64, "base64");
      assert.deepEqual([...png.subarray(0, 8)], pngSignature); await fs.writeFile(path.join(runDir, "original-child-feedback.png"), png);
      report.feedbackScreenshot = { bytes: png.length, sha256: hash(png), file: "original-child-feedback.png" };
      report.streaming = assertManagedViewerFrames(report.frames, { tabId: child.id, streamId: first.streamId });
      report.viewerStreaming = await screenshot("viewer-streaming-feedback.png");
      assert.equal(posts().length, 0); item.beforePause = await readState(child); assert.deepEqual(item.beforePause.clicks, []);
    });

    await step("trusted-pause-and-explicit-resume-without-replay", async () => {
      await viewerAction("#control", "pause");
      await wait(async () => await page.locator("#state").textContent() === "已暂停", "Pause actual cleanup receipt");
      report.pause = { at: Date.now(), state: lastUIState, frameCount: frameCount(), screenshot: await screenshot("viewer-paused.png") };
      assert.equal(lastUIState.status.state, "paused"); assert.equal(lastUIState.status.cleanupComplete, true); assert.equal(lastUIState.selectedTabId, null);
      await denied("paused original input", () => child.mouse.move(2, 2, { timeoutMs: 1500 }), /OBU_AUTOMATION_PAUSED/);
      assert.equal(posts().length, 0);
      assert.equal(await page.locator("#control").textContent(), "继续操作");
      await viewerAction("#control", "resume");
      await wait(async () => await page.locator("#state").textContent() === "正在运行", "explicit Resume ACK");
      assert.ok(lastUIState.status.revision > report.pause.state.status.revision);
      assert.equal(lastUIState.selectedTabId, null); assert.deepEqual(lastUIState.tabs, []);
      await denied("retired handle after Resume", () => child.domSnapshot({ timeoutMs: 1500 }), /STALE|epoch|BOOTSTRAP_REQUIRED|ended/i);
      const quiet = frameCount(); await sleep(350); checkCapture();
      assert.equal(frameCount(), quiet, "Resume must not restart the retired stream"); assert.equal(posts().length, 0, "Resume must not replay a business submit");
      report.resume = { at: Date.now(), state: lastUIState, quietFrameCount: quiet, screenshot: await screenshot("viewer-resumed-idle.png") };
      report.newTurn = await taskBrowser.client.beginTurn("explicit-after-user-resume");
      freshChild = taskBrowser.tab(child.id); await freshChild.domSnapshot({ timeoutMs: 10000 });
      await denied("old child handle after explicit new turn", () => child.domSnapshot({ timeoutMs: 1500 }), /STALE|epoch|BOOTSTRAP_REQUIRED|ended/i);
      const unchanged = await freshChild.evaluate("({key:document.querySelector('input[name=key]').value,owner:document.querySelector('input[name=owner]').value,state:JSON.parse(document.querySelector('#state').textContent)})");
      report.afterResumeDocument = unchanged;
      assert.deepEqual(unchanged, { key: item.key, owner: item.owner, state: item.beforePause });
      await viewerAction("#refresh", "status");
      await wait(async () => await page.locator(`#tabs option[value="${child.id}"]`).count(), "explicit new task attachment in viewer");
      const count = frameCount(); await viewerAction("#tabs", "select", child.id);
      const resumed = await nextFrame(count, child.id); await decodedFrame(resumed);
      assert.notEqual(resumed.streamId, report.originalStream); report.resumedStream = resumed.streamId;
      assert.equal(posts().length, 0);
      await freshChild.getByRole("button", { name: "Commit child receipt", exact: true }).click({ timeoutMs: 10000 });
      item.receipt = await wait(async () => { const value = await freshChild.locator("#result").textContent({ timeoutMs: 5000 }); return value && JSON.parse(value); }, "one original POST response");
      item.childAfter = await readState(freshChild); item.childFrames = await frames(child.id);
      const stats = fixtures.allStats(); assert.equal(stats.children.length, 1); assert.equal(posts().length, 1);
      item.receiptProof = assertCreatedPageReceipt({ item, child: stats.children[0], state: item.childAfter, receipt: item.receipt, frames: item.childFrames });
      report.viewerReceipt = await screenshot("viewer-unique-receipt.png");
      report.observerFinal = await worker.evaluate("__createdPageProvenance.stop()"); assert.equal(report.observerFinal.listenerPresent, false);
      await worker.close(); worker = null;
    });

    await step("trusted-stop-and-original-process-exit", async () => {
      report.preCloseProcesses = descendants(await processTable(), info.browserPID);
      await viewerAction("#stop", "stop");
      await wait(async () => await page.locator("#state").textContent() === "会话已停止", "Stop UI real terminal ACK", 55000);
      assert.ok(report.viewerMessages.some(value => value.type === "response" && value.result?.stopped === true), "Actual Stop response is required");
      stopped = true;
      report.viewerStopped = await screenshot("viewer-stopped.png");
      const terminal = await bound(launcher.completed, 10000, "original supervisor terminal exit"); assert.equal(terminal.code, 0, terminal.stderr);
      report.lifecycle = JSON.parse(await fs.readFile(path.join(info.runDir, "lifecycle.json"), "utf8"));
      assertManagedViewerTerminal(report.lifecycle, info);
      report.processesGone = await wait(async () => {
        const table = await processTable(), originals = [...report.originalProcesses, ...report.preCloseProcesses];
        const remaining = originals.filter(before => table.some(after => before.ProcessId === after.ProcessId && before.CreationDate === after.CreationDate));
        return !remaining.length && { at: Date.now(), originalIdentities: originals.length, remaining };
      }, "all original managed process identities gone");
      await command(["managed", "status", "--root", root, "--name", name], 1);
    });
  } catch (error) { report.error = error.stack; report.firstFailure ??= { at: Date.now(), error: error.stack }; console.error(redact(error.stack ?? String(error))); }
  finally {
    if (worker) try { report.cleanup.observerStop = await worker.evaluate("__createdPageProvenance.stop()"); await worker.close(); } catch (error) { report.cleanup.observerError = error.stack; }
    taskBrowser?.close();
    if (launcher && !launcher.record.closedAt) {
      if (!stopped) try { report.cleanup.stop = JSON.parse((await command(["managed", "stop", "--root", root, "--name", name])).stdout); } catch (error) { report.cleanup.stopError = error.stack; }
      try { await bound(launcher.completed, 10000, "supervisor cleanup terminal exit"); }
      catch (error) { report.cleanup.supervisorError = error.stack; launcher.terminate("acceptance-cleanup"); try { await launcher.completed; } catch (failure) { report.cleanup.forcedSupervisor = failure.stack; } }
    }
    if (viewerBrowser) try {
      report.viewerPreCloseProcesses = descendants(await processTable(), viewerProcess.record.pid);
      const session = await viewerBrowser.newBrowserCDPSession();
      await session.send("Browser.close");
    } catch (error) { report.cleanup.viewerCloseError = error.stack; }
    if (viewerProcess) try { const result = await bound(viewerProcess.completed, 10000, "independent viewer terminal exit"); assert.equal(result.code, 0); report.viewerExit = { code: result.code, exitedAt: result.exitedAt, closedAt: result.closedAt }; }
    catch (error) { report.cleanup.viewerExitError = error.stack; viewerProcess.terminate("acceptance-cleanup"); try { await viewerProcess.completed; } catch (failure) { report.cleanup.forcedViewer = failure.stack; } }
    if (viewerBrowser) try { await viewerBrowser.close(); } catch (error) { report.cleanup.viewerTransportError = error.stack; }
    if (report.viewerProcesses) try {
      report.viewerProcessesGone = await poll(async () => {
        const table = await processTable(), originals = [...report.viewerProcesses, ...(report.viewerPreCloseProcesses ?? [])];
        const remaining = originals.filter(before => table.some(after => before.ProcessId === after.ProcessId && before.CreationDate === after.CreationDate));
        return !remaining.length && { at: Date.now(), originalIdentities: originals.length, remaining };
      }, { timeoutMs: 15000, intervalMs: 100, label: "independent viewer original process identities gone" });
    } catch (error) { report.cleanup.viewerProcessesError = error.stack; }
    server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve));
    try { await Promise.all(frameWrites); checkCapture(); } catch (error) { report.cleanup.frameWriteError = error.stack; }
    try {
      assert.equal(hash(await fs.readFile(executable)), report.source.executable);
      assert.equal(hash(await fs.readFile(chromium)), report.source.browser);
      assert.deepEqual(await treeHashes(extension), report.source.extension);
      assert.deepEqual(await treeHashes(path.join(repo, "packages/open-browser-use-js/dist")), report.source.sdk);
      assert.deepEqual(await treeHashes(path.join(runDir, "source-snapshot")), report.source.snapshot);
      for (const [relative, expected] of Object.entries(report.source.snapshot)) {
        assert.equal(hash(await fs.readFile(path.join(repo, relative))), expected, `Original source/helper changed during acceptance: ${relative}`);
      }
    } catch (error) { report.cleanup.sourceChanged = error.stack; }
    report.fixture = fixtures.allStats(); report.screenshots = screenshots; report.endedAt = Date.now();
    report.frameRetention = { observedFrames: report.frames.length, savedPNGs: report.frames.filter(frame => frame.file).length, maximumSavedPNGs: 64,
      metadataOnlyFrames: report.frames.filter(frame => !frame.file).length, policy: "Only the first 64 received PNG payloads are retained for independent decoding; all frames retain original hash/header metadata. viewerDecodedFrames records specific successful browser image decodes, not a claim that every metadata-only frame was decoded." };
    report.liveRunnerChildren = [...registry].map(value => value.pid);
    report.passed = !report.error && report.steps.length === 4 && report.steps.every(value => value.passed) && !Object.keys(report.cleanup).length && !registry.size && report.viewerExit?.code === 0;
    await save(); console.log("RESULT", JSON.stringify({ runDir, passed: report.passed }));
  }
  return report;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const report = await runManagedViewerCheck(); process.exitCode = report.passed ? 0 : 1;
}
