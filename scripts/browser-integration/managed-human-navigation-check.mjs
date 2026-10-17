// Actual continuous managed human navigation acceptance. The task page is controlled only by
// the production SDK and the production viewer. Observer scripting only reads.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium as playwrightChromium } from "playwright";
import { createManagedHumanNavigationFixture, readManagedHumanNavigationDocument, assertManagedHumanNavigationReceipt, navigationASCII, navigationContinuation, navigationUnicode } from "./managed-human-navigation-fixture.mjs";
import { assertManagedViewerTerminal } from "./managed-viewer-check.mjs";
import { connectNormalCDP, managedProcess, runProcess, bound, poll } from "./normal-browser-downloads-support.mjs";
import { listenFixture } from "./fixture-listener.mjs";
import { browserStartupOptions } from "./browser-startup.mjs";
import { waitPrivateDevToolsEndpoint } from "./private-devtools-endpoint.mjs";
import { observedProcessDescendants as descendants } from "./observed-process-descendants.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const redact = text => String(text).replace(/(#ticket=)[A-Za-z0-9_-]+/g, "$1[redacted]");
const serialize = value => JSON.stringify(value, (_key, item) => typeof item === "string" ? redact(item) : item, 2);

import { projectHumanCommand, assertHumanInputReceipt, captureTaskAuthority, requestOriginalSnapshot, visibleHumanViewerPoint, installManagedHumanObserver } from "./managed-human-check.mjs";

async function treeHashes(root) {
  const entries = await fs.readdir(root, { recursive: true, withFileTypes: true });
  const files = entries.filter(entry => entry.isFile()).map(entry => path.join(entry.parentPath, entry.name)).sort();
  return Object.fromEntries(await Promise.all(files.map(async file => [path.relative(root, file).replaceAll("\\", "/"), hash(await fs.readFile(file))])));
}

export async function runManagedHumanNavigationCheck() {
  assert.equal(process.platform, "win32");
  const executable = process.env.OBU_TEST_HOST_BINARY, chromium = process.env.OBU_TEST_CHROMIUM_BINARY, extension = process.env.OBU_TEST_EXTENSION_DIR;
  assert.ok(executable && chromium && extension, "Set explicit OBU_TEST_HOST_BINARY, OBU_TEST_CHROMIUM_BINARY, OBU_TEST_EXTENSION_DIR");
  await Promise.all([executable, chromium, extension].map(file => fs.access(file)));
  await fs.mkdir(path.join(repo, ".tmp/browser-integration"), { recursive: true });
  const runDir = await fs.mkdtemp(path.join(repo, ".tmp/browser-integration/managed-human-navigation-"));
  const root = path.join(runDir, "owned-root"), name = "human-navigation-acceptance", viewerProfile = path.join(runDir, "viewer-profile");
  const report = { runDir, startedAt: Date.now(), commands: [], steps: [], cleanup: {}, frames: [], viewerCommands: [], viewerMessages: [], viewerActions: [], viewerDecodedFrames: [], viewerErrors: [], denied: [],
    scope: "Production managed human UI; one Begin across original form A, one-use Next GET with 302 to B, child-frame navigation and same-document SPA; one explicit End/Resume and one final SDK POST; no real credentials, OS input, input retry, or extra task page CDP attachment" };
  const save = () => fs.writeFile(path.join(runDir, "results.json"), serialize(report));
  const registry = new Set(), frameWrites = [], screenshots = [];
  let launcher, info, worker, taskBrowser, viewerProcess, viewerBrowser, viewerContext, page, captureError, state, stopped = false;
  let oldTaskTab, oldTaskAuthority, freshTaskTab, original, originalB, businessLease;
  const fixture = createManagedHumanNavigationFixture({ requireFrameNavigation: true });
  const server = createServer((request, response) => { if (!fixture.handle(request, response)) { request.resume(); response.writeHead(404); response.end("NOT_FOUND"); } });
  const launch = (program, args, options = {}) => { const record = {}; report.commands.push(record); return managedProcess(program, args, { cwd: repo, registry, record, maximumBytes: 2 * 1024 * 1024, ...options }); };
  async function command(args, expected = 0) {
    const child = launch(executable, args, { timeoutMs: args[0] === "managed" && args[1] === "stop" ? 55000 : 45000 });
    const result = await child.completed; assert.equal(result.code, expected, redact(result.stderr)); return result;
  }
  async function processTable() {
    const record = {}; await runProcess("powershell.exe", ["-NoProfile", "-Command", "@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,ExecutablePath,@{n='CreationDate';e={$_.CreationDate.ToUniversalTime().ToString('o')}}) | ConvertTo-Json -Compress"], { record, registry, timeoutMs: 15000 });
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
  async function screenshot(file) { const png = await page.screenshot({ path: path.join(runDir, file) }); const record = { file, at: Date.now(), sha256: hash(png), bytes: png.length }; screenshots.push(record); return record; }
  const endpointFor = (profile, owner) => waitPrivateDevToolsEndpoint(profile, { assertAlive() { if (owner.record.exitedAt !== undefined || owner.record.closedAt !== undefined || owner.record.spawnError !== undefined) throw new Error("Original browser owner ended before endpoint"); } });
  const replyFor = (id, timeoutMs = 35000) => wait(() => report.viewerMessages.find(value => value.type === "response" && value.id === id && value.connection === connection), `original response ${id}`, timeoutMs);
  let connection = 0;
  async function uiAction(selector, operation, tabId) {
    const before = report.viewerCommands.length, action = { selector, operation, tabId, connection, startedAt: Date.now() }; report.viewerActions.push(action);
    if (operation === "select") await page.locator(selector).selectOption(String(tabId)); else await page.locator(selector).click();
    const request = await wait(() => report.viewerCommands.slice(before).find(item => item.operation === operation && (operation !== "select" || item.tabId === tabId)), `original DOM ${operation}`);
    action.requestId = request.id; const reply = await replyFor(request.id, operation === "stop" ? 55000 : 35000); action.completedAt = Date.now();
    assert.equal(report.viewerCommands.slice(before).filter(item => item.operation === operation && (operation !== "select" || item.tabId === tabId)).length, 1);
    assert.equal(reply.error, undefined, serialize(reply.error)); return reply.result;
  }
  async function inputAction(label, operation) {
    const before = report.viewerCommands.length, action = { label, connection, startedAt: Date.now(), kind: "real viewer input" }; report.viewerActions.push(action);
    await operation();
    await wait(() => report.viewerCommands.length > before, `outgoing native input ${label}`);
    // Serialize the fixture's UI gestures. Finite command replies are required;
    // a caller-side timeout must never be relabelled a native acknowledgement.
    await wait(async () => await page.locator("#human-input").getAttribute("data-pending") === "0", `all original UI input settled: ${label}`);
    const commands = report.viewerCommands.slice(before); assert.ok(commands.length); assert.ok(commands.every(item => item.operation === "humanInput"));
    action.requestIds = commands.map(item => item.id);
    for (const request of commands) assertHumanInputReceipt(request, await replyFor(request.id));
    const acknowledged = Number(await page.locator("#human-input").getAttribute("data-acknowledged-sequence"));
    assert.equal(acknowledged, commands.at(-1).sequence, "UI must have accepted the exact last native receipt before this gesture completes");
    action.acknowledgedSequence = acknowledged;
    action.completedAt = Date.now(); return commands;
  }
  async function denied(label, operation, pattern) { const record = { label, at: Date.now() }; report.denied.push(record); try { await operation(); } catch (error) { record.error = error.stack; assert.match(error.message, pattern); record.verified = true; return; } throw new Error(`${label} unexpectedly succeeded`); }
  const documentRead = tabId => worker.evaluate(`chrome.scripting.executeScript({target:{tabId:${tabId}},func:${readManagedHumanNavigationDocument.toString()}}).then(results=>{if(results.length!==1)throw new Error('ambiguous root read');return {documentId:results[0].documentId,frameId:results[0].frameId,...results[0].result}})`);
  const nativeMap = tabId => worker.evaluate(`chrome.debugger.getTargets().then(items=>items.filter(item=>item.type==='page'&&item.tabId===${tabId}).map(item=>({id:item.id,tabId:item.tabId,type:item.type,attached:item.attached,url:item.url})))`);
  const observerSnapshot = () => worker.evaluate("__managedHumanAcceptance.snapshot()");
  const posts = () => fixture.stats().requests.filter(item => item.method === "POST");
  async function decodeHumanFrame(lease, minimumGeneration = 1) {
    const proof = await wait(async () => {
      const frame = report.frames.findLast(item => item.controlMode === "human" && item.humanLeaseId === lease.leaseId && item.tabId === lease.tabId && item.generation >= minimumGeneration);
      if (!frame) return null;
      const decoded = await page.locator("#frame").evaluate(element => ({ hidden: element.hidden, complete: element.complete, width: element.naturalWidth, height: element.naturalHeight, ...element.dataset }));
      const ready = await page.locator("#human-input").getAttribute("data-enabled");
      return ready === "true" && state?.human?.state === "active" && state.human.leaseId === lease.leaseId && state.human.generation === frame.generation && state.human.viewport?.width > 0 && state.human.viewport?.height > 0 &&
        !decoded.hidden && decoded.complete && decoded.width > 0 && decoded.height > 0 && decoded.controlMode === "human" && decoded.humanLeaseId === lease.leaseId && decoded.streamId === frame.streamId && Number(decoded.generation) === frame.generation && Number(decoded.frameSequence) >= frame.sequence && { frame, decoded };
    }, `viewer decoded current human generation >= ${minimumGeneration}`, 35000);
    const first = report.frames.find(item => item.controlMode === "human" && item.humanLeaseId === lease.leaseId && item.generation === proof.frame.generation);
    const frameIndex = report.viewerMessages.findIndex(item => item.type === "frame" && item.streamId === first.streamId && item.sequence === first.sequence);
    const stateIndex = report.viewerMessages.findIndex(item => {
      const human = item.type === "state" ? item.human : item.type === "response" ? item.result?.human : null;
      return human?.state === "active" && human.leaseId === lease.leaseId && human.generation === proof.frame.generation && human.viewport?.width > 0;
    });
    assert.ok(stateIndex >= 0 && frameIndex > stateIndex, "Matching active status must precede the generation's first published frame");
    report.viewerDecodedFrames.push({ at: Date.now(), frame: { streamId: proof.frame.streamId, sequence: proof.frame.sequence, humanLeaseId: proof.frame.humanLeaseId, generation: proof.frame.generation }, decoded: proof.decoded, stateIndex, frameIndex });
    return proof.frame;
  }
  async function navigationAction(label, operation, expectedDocument) {
    const before = report.viewerCommands.length, generation = state.human.generation;
    const action = { label, connection, generation, startedAt: Date.now(), kind: "real viewer navigation input" }; report.viewerActions.push(action);
    await operation();
    await wait(() => report.viewerCommands.length > before, `original navigation input ${label}`);
    action.document = await wait(async () => { const value = await documentRead(oldTaskTab.id); return expectedDocument(value) && value; }, `original navigation document ${label}`);
    const frame = await decodeHumanFrame(businessLease, generation + 1);
    // Original triggering inputs may settle after navigation. Their own native
    // receipts remain required; a successor UI counter is not their receipt.
    const commands = report.viewerCommands.slice(before);
    assert.ok(commands.length && commands.every(item => item.operation === "humanInput" && item.generation === generation));
    for (const request of commands) assertHumanInputReceipt(request, await replyFor(request.id));
    action.requestIds = commands.map(item => item.id); action.successorFrame = frame; action.completedAt = Date.now();
    assert.equal(state.human.leaseId, businessLease.leaseId); assert.equal(state.human.tabId, businessLease.tabId);
    assert.equal(state.status.state, "paused");
    assert.equal(report.viewerCommands.filter(item => item.operation === "humanBegin").length, 1);
    assert.equal(report.viewerCommands.filter(item => ["humanEnd", "resume"].includes(item.operation)).length, 0);
    const targets = await nativeMap(oldTaskTab.id); assert.equal(targets.length, 1); assert.equal(targets[0].id, report.business.originalTarget.id);
    action.targets = targets;
    const metadata = state.tabs.find(tab => tab.id === oldTaskTab.id);
    assert.ok(metadata); assert.equal(metadata.url, action.document.url, "Viewer address must describe the newly displayed document");
    const title = await page.locator("#page-title").textContent();
    assert.equal(title, `${metadata.title} · ${metadata.url}`);
    assert.equal(await page.locator("#tabs option:checked").textContent(), metadata.title);
    action.displayedMetadata = { ...metadata, caption: title };
    return frame;
  }
  async function viewerPoint(box) {
    const [image, decoded] = await Promise.all([
      page.locator("#frame").boundingBox(),
      page.locator("#frame").evaluate(element => ({ hidden: element.hidden, complete: element.complete, width: element.naturalWidth, height: element.naturalHeight, ...element.dataset }))
    ]);
    assert.ok(!decoded.hidden && decoded.complete && state.human?.viewport);
    assert.equal(decoded.controlMode, "human"); assert.equal(decoded.humanLeaseId, state.human.leaseId); assert.equal(Number(decoded.generation), state.human.generation);
    assert.ok(report.frames.some(frame => frame.connection === connection && frame.streamId === decoded.streamId && frame.sequence === Number(decoded.frameSequence) && frame.humanLeaseId === state.human.leaseId && frame.generation === state.human.generation), "Pointer must use an actual decoded frame from the current stream");
    const proof = visibleHumanViewerPoint(box, state.human.viewport, image, { width: decoded.width, height: decoded.height });
    (report.pointerTargets ??= []).push({ at: Date.now(), connection, leaseId: state.human.leaseId, generation: state.human.generation, streamId: decoded.streamId, frameSequence: Number(decoded.frameSequence), ...proof });
    return proof.viewerPoint;
  }
  async function openViewer(url) {
    connection++; const originalConnection = connection; state = undefined;
    // CDP's default context has no managed native viewport: emulating a larger
    // DOM there can leave wheel coordinates outside the original small window.
    // All viewer pages use the same explicitly sized, private test context.
    page = await viewerContext.newPage();
    const geometrySession = await viewerContext.newCDPSession(page);
    try {
      const nativeWindow = await bound(geometrySession.send("Browser.getWindowForTarget"), 5000, "original viewer native window");
      const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
      (report.viewerWindows ??= []).push({ at: Date.now(), connection: originalConnection, nativeWindow, viewport });
      assert.deepEqual(viewport, { width: 1280, height: 1000 });
      assert.ok(nativeWindow.bounds.width >= viewport.width && nativeWindow.bounds.height >= viewport.height, "Original viewer window must contain its emulated viewport");
    } finally { await geometrySession.detach(); }
    page.on("pageerror", error => { report.viewerErrors.push({ at: Date.now(), connection: originalConnection, error: error.stack }); captureError ??= error; });
    page.on("websocket", socket => {
      try { assert.equal(new URL(socket.url()).origin.replace("ws:", "http:"), new URL(url).origin); } catch (error) { captureError ??= error; return; }
      socket.on("close", () => report.viewerMessages.push({ type: "socketClosed", at: Date.now(), connection: originalConnection }));
      socket.on("framesent", event => { try { const raw = JSON.parse(String(event.payload)), projected = projectHumanCommand(raw); if (!projected) return; if (report.viewerCommands.length >= 2048) throw new Error("Viewer command capacity"); report.viewerCommands.push({ ...projected, at: Date.now(), connection: originalConnection }); } catch (error) { captureError ??= error; } });
      socket.on("framereceived", event => {
        try {
          const message = JSON.parse(String(event.payload)), at = Date.now();
          if (report.viewerMessages.length >= 4096) throw new Error("Viewer event capacity");
          if (message.type === "frame") {
            assert.equal(message.mimeType, "image/png"); assert.ok(typeof message.data === "string" && message.data.length <= 4 * Math.ceil(4 * 1024 * 1024 / 3));
            const png = Buffer.from(message.data, "base64"); assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]); assert.ok(png.length <= 4 * 1024 * 1024 && png.length > 24);
            const frame = { ...message, data: undefined, at, connection: originalConnection, bytes: png.length, sha256: hash(png), width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
            if (report.frames.length < 96) { frame.file = `native-frame-${String(report.frames.length).padStart(4, "0")}.png`; const write = fs.writeFile(path.join(runDir, frame.file), png); frameWrites.push(write); write.catch(error => { captureError ??= error; }); }
            if (report.frames.length >= 1024) throw new Error("Frame observation capacity"); report.frames.push(frame);
            report.viewerMessages.push({ type: "frame", at, connection: originalConnection, tabId: frame.tabId, streamId: frame.streamId, sequence: frame.sequence, controlMode: frame.controlMode, humanLeaseId: frame.humanLeaseId, generation: frame.generation, sha256: frame.sha256 });
          } else {
            report.viewerMessages.push({ ...message, at, connection: originalConnection });
            if (originalConnection === connection && (message.type === "state" || message.type === "response" && message.result?.status)) {
              const next = message.type === "state" ? message : message.result;
              if (!state || next.eventSequence >= state.eventSequence && next.status.revision >= state.status.revision) state = next;
            }
          }
        } catch (error) { captureError ??= error; }
      });
    });
    await page.goto(url, { waitUntil: "domcontentloaded" }); await wait(async () => await page.locator("#connection").textContent() === "已连接", "viewer authenticated");
    assert.equal(new URL(page.url()).hash, ""); await uiAction("#refresh", "status");
  }

  try {
    report.source = { executable: hash(await fs.readFile(executable)), browser: hash(await fs.readFile(chromium)), extension: await treeHashes(extension), sdk: await treeHashes(path.join(repo, "packages/open-browser-use-js/dist")) };
    const snapshot = path.join(runDir, "source-snapshot");
    const builder = await fs.readFile(path.join(repo, "scripts/build-chrome-extension.mjs"), "utf8");
    const declaration = builder.match(/const productionFiles\s*=\s*(\[[\s\S]*?\]);/); assert.ok(declaration, "The frozen builder must declare its exact production inputs");
    const productionFiles = JSON.parse(declaration[1]); assert.equal(new Set(productionFiles).size, productionFiles.length); assert.ok(productionFiles.includes("managed-human-control.js"));
    const productionInputs = {};
    for (const name of productionFiles) {
      const bytes = await fs.readFile(path.join(repo, "apps/chrome-extension", name));
      assert.equal(report.source.extension[name], hash(bytes), `Provided extension does not contain the exact current production source: ${name}`);
      productionInputs[name] = hash(bytes);
    }
    report.source.productionExtensionInputs = productionInputs;
    const sourceNames = (await fs.readdir(path.join(repo, "apps/chrome-extension"))).filter(file => /\.(js|json|html|css)$/.test(file) && !file.includes(".test."));
    const extensionSources = [...new Set([...sourceNames, ...productionFiles])].map(file => `apps/chrome-extension/${file}`);
    const builderSources = (await fs.readdir(path.join(repo, "scripts"))).filter(file => /^patch-.*\.mjs$/.test(file) && !file.includes(".test.")).map(file => `scripts/${file}`);
    const integrationSources = (await fs.readdir(path.join(repo, "scripts/browser-integration"))).filter(file => file.endsWith(".mjs") || ["package.json", "package-lock.json"].includes(file)).map(file => `scripts/browser-integration/${file}`);
    for (const source of ["cmd/open-browser-use", "internal", "packages/open-browser-use-go", "go.mod", "go.sum", "scripts/build-chrome-extension.mjs", ...builderSources, ...extensionSources, ...integrationSources]) {
      const destination = path.join(snapshot, source); await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.cp(path.join(repo, source), destination, { recursive: true });
    }
    report.source.snapshot = await treeHashes(snapshot);
    await fs.cp(extension, path.join(runDir, "extension-input"), { recursive: true });
    await fs.cp(path.join(repo, "packages/open-browser-use-js/dist"), path.join(runDir, "sdk-input"), { recursive: true });
    const { connectOpenBrowserUse } = await import(pathToFileURL(path.join(runDir, "sdk-input/index.js")));
    await listenFixture(server); const fixtureURL = `http://127.0.0.1:${server.address().port}`;

    await step("production-run-and-original-worker-observer", async () => {
      launcher = launch(executable, ["managed", "run", "--root", root, "--name", name, "--browser-path", chromium, "--extension-dir", extension, "--startup-timeout", "30s"]);
      const ready = await wait(() => {
        if (launcher.record.closedAt) throw new Error(`Managed launcher exited ${launcher.record.code}: ${redact(launcher.record.stderr)}`);
        const text = launcher.record.stdout.trim(); return text.endsWith("}") ? JSON.parse(text) : null;
      }, "production managed ready", 40000);
      assert.equal(ready.state, "ready"); info = ready.info; report.info = info;
      const relative = path.relative(root, info.runDir); assert.ok(relative && !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
      assert.equal(info.name, name); assert.ok(info.runId && info.browserPID > 0 && info.nativePID > 0);
      report.originalProcesses = descendants(await processTable(), info.browserPID); assert.ok(report.originalProcesses.some(item => item.ProcessId === info.nativePID));
      const status = JSON.parse((await command(["managed", "status", "--root", root, "--name", name])).stdout); assert.deepEqual(status.info, info);
      const startup = browserStartupOptions([`--user-data-dir=${viewerProfile}`, "--headless=new", "--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "about:blank"], process.env.OBU_TEST_FIELD_TRIAL_CONFIG);
      report.viewerStartup = startup; viewerProcess = launch(chromium, startup.args);
      viewerBrowser = await playwrightChromium.connectOverCDP((await endpointFor(viewerProfile, viewerProcess)).url);
      viewerContext = await viewerBrowser.newContext({ viewport: { width: 1280, height: 1000 } });
      report.viewerProcesses = descendants(await processTable(), viewerProcess.record.pid);
      assert.ok(!report.viewerProcesses.some(item => item.ProcessId === info.browserPID));
      const fresh = JSON.parse((await command(["managed", "view", "--root", root, "--name", name])).stdout);
      const viewerURL = new URL(fresh.viewerURL); assert.equal(viewerURL.hostname, "127.0.0.1"); assert.equal(viewerURL.origin, new URL(ready.viewerURL).origin);
      report.viewerOrigin = viewerURL.origin; report.viewerTicketSHA256 = hash(viewerURL.hash);
      await openViewer(viewerURL.href); assert.equal(state.status.state, "running"); report.viewerInitial = await screenshot("viewer-initial.png");
      const endpoint = await endpointFor(info.profileDir, launcher);
      const targets = await (await fetch(`http://127.0.0.1:${endpoint.port}/json/list`)).json();
      const workers = targets.filter(value => value.type === "service_worker" && value.url === `chrome-extension://${info.extensionId}/background.js`); assert.equal(workers.length, 1);
      report.observerConnection = {}; worker = await connectNormalCDP(workers[0].webSocketDebuggerUrl, { record: report.observerConnection, handshakeTimeoutMs: 10000, authorizationRequired: false });
      report.observer = await worker.evaluate(`(${installManagedHumanObserver.toString()})(chrome,globalThis)`);
      taskBrowser = await connectOpenBrowserUse({ socketPath: info.socketPath, sessionId: "managed-human-navigation-acceptance", turnId: "original-navigation-workflow", timeoutMs: 10000 });
    });

    await step("original-agent-form-a-and-unsubmitted-draft", async () => {
      oldTaskTab = await taskBrowser.newTab({ url: fixtureURL + fixture.paths.a, backgroundWindow: true });
      await oldTaskTab.getByLabel("Original draft", { exact: true }).fill(fixture.draft, { timeoutMs: 10000 });
      oldTaskAuthority = captureTaskAuthority(taskBrowser.client, oldTaskTab.id);
      original = await documentRead(oldTaskTab.id); assert.equal(original.draft, fixture.draft);
      assert.ok(original.documentId); assert.equal(original.frameId, 0);
      const targets = await nativeMap(oldTaskTab.id); assert.equal(targets.length, 1);
      report.business = { tabId: oldTaskTab.id, original, originalAuthority: oldTaskAuthority, originalTarget: targets[0], originalFrames: await worker.evaluate(`chrome.webNavigation.getAllFrames({tabId:${oldTaskTab.id}})`) };
      await uiAction("#refresh", "status"); await uiAction("#tabs", "select", oldTaskTab.id);
      assert.equal(posts().length, 0); report.agentDraft = await screenshot("viewer-agent-form-a.png");
    });

    await step("one-human-begin-original-a-input-and-302-to-b", async () => {
      report.business.observerStart = (await observerSnapshot()).events.length;
      const begun = await uiAction("#human-begin", "humanBegin"); assert.equal(begun.status.state, "paused");
      assert.ok(["active", "navigating"].includes(begun.human.state));
      businessLease = begun.human; report.business.humanBegin = begun;
      report.business.firstHumanFrame = await decodeHumanFrame(businessLease); businessLease = { ...state.human };
      const transferred = await documentRead(oldTaskTab.id); assert.equal(transferred.documentId, original.documentId); assert.equal(transferred.draft, fixture.draft);
      await denied("task input during continuous human lease", () => oldTaskTab.mouse.move(2, 2, { timeoutMs: 1500 }), /OBU_AUTOMATION_PAUSED/);
      const draftPoint = await viewerPoint(transferred.boxes.input);
      await inputAction("focus original A draft", () => page.mouse.click(draftPoint.x, draftPoint.y));
      await inputAction("move A caret to end", () => page.keyboard.press("End"));
      await inputAction("append A ASCII", () => page.keyboard.type(navigationASCII));
      report.business.beforeNext = await documentRead(oldTaskTab.id); assert.equal(report.business.beforeNext.draft, fixture.expectedNextDraft);
      const nextPoint = await viewerPoint(report.business.beforeNext.boxes.next);
      report.business.redirectFrame = await navigationAction("one trusted Next through 302 to B", () => page.mouse.click(nextPoint.x, nextPoint.y), value => value.state?.page === "B" && value.childState?.step === 0);
      originalB = await documentRead(oldTaskTab.id); report.business.originalB = originalB;
      assert.ok(originalB.documentId && originalB.documentId !== original.documentId); assert.equal(originalB.draft, fixture.expectedNextDraft);
      assert.equal(posts().length, 0); report.business.redirectScreenshot = await screenshot("viewer-human-form-b.png");
    });

    await step("same-lease-b-input-child-navigation-spa-and-unicode", async () => {
      const draftPoint = await viewerPoint(originalB.boxes.input);
      await inputAction("focus B continuation draft", () => page.mouse.click(draftPoint.x, draftPoint.y));
      await inputAction("move B caret to end", () => page.keyboard.press("End"));
      await inputAction("append B continuation", () => page.keyboard.type(navigationContinuation));
      report.business.beforeChild = await documentRead(oldTaskTab.id); assert.equal(report.business.beforeChild.draft, fixture.expectedBDraft);
      const beforeFrames = await worker.evaluate(`chrome.webNavigation.getAllFrames({tabId:${oldTaskTab.id}})`);
      const childPoint = await viewerPoint(report.business.beforeChild.boxes.frameNavigate);
      report.business.childFrame = await navigationAction("one child-only navigation", () => page.mouse.click(childPoint.x, childPoint.y), value => value.childState?.step === 1);
      report.business.afterChild = await documentRead(oldTaskTab.id);
      const afterFrames = await worker.evaluate(`chrome.webNavigation.getAllFrames({tabId:${oldTaskTab.id}})`);
      assert.equal(report.business.afterChild.documentId, originalB.documentId); assert.equal(report.business.afterChild.draft, fixture.expectedBDraft);
      assert.equal(beforeFrames.find(item => item.frameId === 0).documentId, afterFrames.find(item => item.frameId === 0).documentId);
      assert.ok(beforeFrames.some(before => before.frameId !== 0 && afterFrames.some(after => after.frameId === before.frameId && after.documentId !== before.documentId)), "Original child document must actually change");
      report.business.childDocuments = { before: beforeFrames, after: afterFrames };
      const spaPoint = await viewerPoint(report.business.afterChild.boxes.spa);
      report.business.spaFrame = await navigationAction("one same-document SPA route", () => page.mouse.click(spaPoint.x, spaPoint.y), value => value.state?.route === "spa" && new URL(value.url).hash === "#spa");
      report.business.afterSPA = await documentRead(oldTaskTab.id); assert.equal(report.business.afterSPA.documentId, originalB.documentId);
      const finalPoint = await viewerPoint(report.business.afterSPA.boxes.input);
      await inputAction("focus continued SPA draft", () => page.mouse.click(finalPoint.x, finalPoint.y));
      await inputAction("move continued SPA caret to end", () => page.keyboard.press("End"));
      await inputAction("append Unicode after both navigations", () => page.keyboard.insertText(navigationUnicode));
      report.business.afterHuman = await documentRead(oldTaskTab.id); assert.equal(report.business.afterHuman.documentId, originalB.documentId); assert.equal(report.business.afterHuman.draft, fixture.expectedDraft);
      assert.equal(posts().length, 0); report.business.humanScreenshot = await screenshot("viewer-human-spa-edited.png");
      const inputs = report.viewerCommands.filter(item => item.operation === "humanInput");
      const groups = Object.groupBy(inputs, item => item.generation);
      for (const items of Object.values(groups)) for (let i = 0; i < items.length; i++) assert.equal(items[i].sequence, i + 1, "Input sequence must restart at one for each used generation");
      assert.ok(Object.keys(groups).length >= 4); report.business.inputGenerations = Object.fromEntries(Object.entries(groups).map(([generation, items]) => [generation, { count: items.length, firstSequence: items[0].sequence, lastSequence: items.at(-1).sequence }]));
      const observed = await observerSnapshot(); assert.equal(observed.overflow, false);
      const events = observed.events.slice(report.business.observerStart).filter(item => item.method === "Page.screencastFrame"); assert.ok(events.length > 0);
      for (const event of events) { assert.equal(event.source.sessionId, undefined); if (event.source.targetId !== undefined) assert.equal(event.source.targetId, report.business.originalTarget.id); else assert.equal(event.source.tabId, oldTaskTab.id); }
      report.business.nativeRouting = { originalTargetId: report.business.originalTarget.id, events, boundary: "Read-only original native event identities; no native command interception or invented ACK log." };
    });

    await step("one-end-explicit-resume-and-original-workflow-post", async () => {
      const ended = await uiAction("#human-end", "humanEnd");
      assert.equal(ended.human, null); assert.deepEqual(ended.humanCleanup, { leaseId: businessLease.leaseId, cleanupConfirmed: true });
      assert.equal(ended.status.state, "paused"); assert.equal(ended.status.cleanupComplete, true); report.business.humanEnd = ended;
      const targets = await nativeMap(oldTaskTab.id); assert.equal(targets.length, 1); assert.equal(targets[0].id, report.business.originalTarget.id); assert.equal(targets[0].attached, false);
      assert.equal(report.viewerCommands.filter(item => item.operation === "humanBegin").length, 1); assert.equal(report.viewerCommands.filter(item => item.operation === "humanEnd").length, 1);
      report.business.resume = await uiAction("#control", "resume"); assert.equal(report.business.resume.status.state, "running");
      await denied("original Agent authority before explicit new turn", () => oldTaskTab.domSnapshot({ timeoutMs: 1500 }), /OBU_STALE_CONTROL_EPOCH/);
      report.business.newTurn = await taskBrowser.client.beginTurn("explicit-after-continuous-human-navigation"); freshTaskTab = taskBrowser.tab(oldTaskTab.id); await freshTaskTab.domSnapshot({ timeoutMs: 10000 });
      await denied("original Agent authority after explicit new turn", () => requestOriginalSnapshot(taskBrowser.client, oldTaskAuthority), /OBU_STALE_CONTROL_EPOCH/);
      const continued = await documentRead(oldTaskTab.id); assert.equal(continued.documentId, originalB.documentId); assert.equal(continued.draft, fixture.expectedDraft);
      report.business.beforeSubmit = continued; assert.equal(posts().length, 0);
      await freshTaskTab.getByRole("button", { name: "Commit original receipt", exact: true }).click({ timeoutMs: 10000 });
      const receipt = await wait(async () => { const value = await freshTaskTab.locator("#result").textContent({ timeoutMs: 5000 }); return value && JSON.parse(value); }, "one original navigation POST response");
      const after = await documentRead(oldTaskTab.id); report.business.after = after; report.business.receipt = receipt;
      report.business.receiptProof = assertManagedHumanNavigationReceipt(fixture.stats(), original, originalB, after, receipt);
      assert.equal(after.documentId, originalB.documentId);
      await uiAction("#refresh", "status"); await uiAction("#tabs", "select", oldTaskTab.id); report.business.receiptScreenshot = await screenshot("viewer-navigation-receipt.png");
      report.observerFinal = await worker.evaluate("__managedHumanAcceptance.stop()"); assert.equal(report.observerFinal.listenerPresent, false); assert.equal(report.observerFinal.overflow, false);
      await worker.close(); worker = null;
    });

    await step("trusted-stop-and-original-process-exit", async () => {
      report.preCloseProcesses = descendants(await processTable(), info.browserPID);
      const stop = await uiAction("#stop", "stop"); assert.equal(stop.stopped, true); stopped = true;
      await wait(async () => await page.locator("#state").textContent() === "会话已停止", "actual Stop UI reply", 55000);
      report.viewerStopped = await screenshot("viewer-stopped.png");
      const terminal = await bound(launcher.completed, 10000, "original supervisor terminal exit"); assert.equal(terminal.code, 0, redact(terminal.stderr));
      const lifecycleFile = path.join(info.runDir, "lifecycle.json"), lifecycleBytes = await fs.readFile(lifecycleFile);
      // Native FILETIME can exceed JavaScript's exact integer range. Retain
      // the original Go JSON bytes as authority alongside this JS projection.
      report.lifecycleSource = { file: path.relative(runDir, lifecycleFile).replaceAll("\\", "/"), bytes: lifecycleBytes.length, sha256: hash(lifecycleBytes) };
      report.lifecycle = JSON.parse(lifecycleBytes); assertManagedViewerTerminal(report.lifecycle, info);
      report.processesGone = await wait(async () => { const table = await processTable(), originals = [...report.originalProcesses, ...report.preCloseProcesses]; const remaining = originals.filter(before => table.some(after => before.ProcessId === after.ProcessId && before.CreationDate === after.CreationDate)); return !remaining.length && { at: Date.now(), originalIdentities: originals.length, remaining }; }, "original managed tree gone");
      const status = await command(["managed", "status", "--root", root, "--name", name], 1); assert.match(status.stderr, /has no reachable supervisor/);
    });
  } catch (error) {
    report.error = error.stack; report.firstFailure ??= { at: Date.now(), error: error.stack };
    console.error(redact(error.stack ?? error));
    // Observe the same failed document before original cleanup. These bounded
    // reads run only after failure; they cannot change prior input/ACK ordering.
    if (worker && oldTaskTab) try {
      report.failureDocument = { at: Date.now(), value: await bound(documentRead(oldTaskTab.id), 5000, "failed original document observation") };
    } catch (failure) { report.failureDocumentError = redact(String(failure)); }
    if (page) try {
      report.failureViewer = { at: Date.now(), value: await bound(page.evaluate(() => ({
        state: document.getElementById("state")?.textContent,
        error: document.getElementById("error")?.textContent,
        input: { ...document.getElementById("human-input")?.dataset },
        activeElement: document.activeElement?.id
      })), 5000, "failed original viewer observation") };
    } catch (failure) { report.failureViewerError = redact(String(failure)); }
  }
  finally {
    if (worker) try { report.cleanup.observerStop = await worker.evaluate("__managedHumanAcceptance.stop()"); await worker.close(); } catch (error) { report.cleanup.observerError = error.stack; }
    taskBrowser?.close();
    if (launcher && !launcher.record.closedAt) {
      if (!stopped) try { report.cleanup.stop = JSON.parse((await command(["managed", "stop", "--root", root, "--name", name])).stdout); } catch (error) { report.cleanup.stopError = error.stack; }
      try { await bound(launcher.completed, 10000, "original supervisor cleanup terminal exit"); }
      catch (error) { report.cleanup.supervisorError = error.stack; launcher.terminate("acceptance-cleanup"); try { await launcher.completed; } catch (failure) { report.cleanup.forcedSupervisor = failure.stack; } }
    }
    if (viewerBrowser) try { report.viewerPreCloseProcesses = descendants(await processTable(), viewerProcess.record.pid); const session = await viewerBrowser.newBrowserCDPSession(); report.viewerClose = { requestedAt: Date.now(), acknowledgement: await session.send("Browser.close"), acknowledgedAt: Date.now() }; } catch (error) { report.cleanup.viewerCloseError = error.stack; }
    if (viewerProcess) try { const result = await bound(viewerProcess.completed, 10000, "independent viewer terminal exit"); assert.equal(result.code, 0); report.viewerExit = { code: result.code, exitedAt: result.exitedAt, closedAt: result.closedAt }; }
    catch (error) { report.cleanup.viewerExitError = error.stack; viewerProcess.terminate("acceptance-cleanup"); try { await viewerProcess.completed; } catch (failure) { report.cleanup.forcedViewer = failure.stack; } }
    if (viewerBrowser) try { await viewerBrowser.close(); } catch (error) { report.cleanup.viewerTransportError = error.stack; }
    if (report.viewerProcesses) try {
      report.viewerProcessesGone = await poll(async () => { const table = await processTable(), originals = [...report.viewerProcesses, ...(report.viewerPreCloseProcesses ?? [])]; const remaining = originals.filter(before => table.some(after => before.ProcessId === after.ProcessId && before.CreationDate === after.CreationDate)); return !remaining.length && { at: Date.now(), originalIdentities: originals.length, remaining }; }, { timeoutMs: 15000, intervalMs: 100, label: "independent viewer original process identities gone" });
    } catch (error) { report.cleanup.viewerProcessesError = error.stack; }
    server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve));
    try { await Promise.all(frameWrites); checkCapture(); } catch (error) { report.cleanup.frameWriteError = error.stack; }
    try {
      assert.equal(hash(await fs.readFile(executable)), report.source.executable); assert.equal(hash(await fs.readFile(chromium)), report.source.browser);
      assert.deepEqual(await treeHashes(extension), report.source.extension); assert.deepEqual(await treeHashes(path.join(repo, "packages/open-browser-use-js/dist")), report.source.sdk);
      assert.deepEqual(await treeHashes(path.join(runDir, "source-snapshot")), report.source.snapshot);
      for (const [relative, expected] of Object.entries(report.source.snapshot)) assert.equal(hash(await fs.readFile(path.join(repo, relative))), expected, `Source changed during acceptance: ${relative}`);
    } catch (error) { report.cleanup.sourceChanged = error.stack; }
    report.fixture = fixture.stats(); report.screenshots = screenshots; report.endedAt = Date.now();
    report.frameRetention = { observedFrames: report.frames.length, savedPNGs: report.frames.filter(frame => frame.file).length, maximumSavedPNGs: 96, metadataOnlyFrames: report.frames.filter(frame => !frame.file).length,
      policy: "The first 96 actual native PNG payloads are retained for independent decoding; all received frames retain hash/header metadata. viewerDecodedFrames identifies actual browser decodes, not unperformed decodes of every frame." };
    report.liveRunnerChildren = [...registry].map(value => value.pid);
    report.passed = !report.error && report.steps.length === 6 && report.steps.every(value => value.passed) && !Object.keys(report.cleanup).length && !registry.size && report.viewerExit?.code === 0;
    await save(); console.log("RESULT", JSON.stringify({ runDir, passed: report.passed }));
  }
  return report;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const report = await runManagedHumanNavigationCheck(); process.exitCode = report.passed ? 0 : 1;
}
