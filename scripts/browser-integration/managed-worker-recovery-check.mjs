// One service-worker stop/replacement in an owned Browser; independent positive
// and held-input modes. No page reload, business replay, adapter or OS input.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium as playwrightChromium } from "playwright";
import { createManagedNativeRecoveryFixture, readManagedNativeRecoveryDocument, assertManagedNativeRecoveryReceipt, recoveryAfterNote } from "./managed-native-recovery-fixture.mjs";
import { projectNativeRecoveryLifecycle, assertNativeRecoveryExit, assertPublicPausedViewerCleanup, probeRejectedViewerToken, readRecommendedBrowserVersion, installManagedNativeRecoveryObserver } from "./managed-native-recovery-support.mjs";
import { replaceOriginalWorker, assertWorkerExecutionEnded, assertWorkerReplacement, assertWorkerRecoveryReceipt, assertSameResultPlacement, assertHeldInputUnreleased, probeRetiredDelivery } from "./managed-worker-recovery-support.mjs";
import { createManagedWorkerHeldFixture, readManagedWorkerHeldDocument, assertZeroBusinessHeldFixture } from "./managed-worker-recovery-fixture.mjs";
import { parseManagedReadyOutput, assertManagedStopReply } from "./managed-download-check.mjs";
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

import { projectHumanCommand, assertHumanInputReceipt, captureTaskAuthority, requestOriginalSnapshot, visibleHumanViewerPoint } from "./managed-human-check.mjs";

async function treeHashes(root) {
  const entries = await fs.readdir(root, { recursive: true, withFileTypes: true });
  const files = entries.filter(entry => entry.isFile()).map(entry => path.join(entry.parentPath, entry.name)).sort();
  return Object.fromEntries(await Promise.all(files.map(async file => [path.relative(root, file).replaceAll("\\", "/"), hash(await fs.readFile(file))])));
}

export async function runManagedWorkerRecoveryCheck({ mode = "result" } = {}) {
  assert.ok(["result", "held-input"].includes(mode), "Worker recovery accepts only result or independent held-input mode");
  assert.equal(process.platform, "win32");
  const executable = process.env.OBU_TEST_HOST_BINARY, chromium = process.env.OBU_TEST_CHROMIUM_BINARY, extension = process.env.OBU_TEST_EXTENSION_DIR;
  assert.ok(executable && chromium && extension, "Set explicit OBU_TEST_HOST_BINARY, OBU_TEST_CHROMIUM_BINARY, OBU_TEST_EXTENSION_DIR");
  for (const file of [executable, chromium, extension]) { assert.ok(path.isAbsolute(file)); await fs.access(file); }
  const validationFile = process.env.OBU_TEST_HOST_VALIDATION;
  await fs.mkdir(path.join(repo, ".tmp/browser-integration"), { recursive: true });
  // Keep the owned Chromium profile shallow. The first long-path run failed
  // creating IndexedDB's 262-character MANIFEST path; the same frozen inputs
  // admitted the initial journal at 181 characters in a zero-business check.
  const runDir = await fs.mkdtemp(path.join(repo, `.tmp/browser-integration/mwr-${mode === "result" ? "r" : "h"}-`));
  const root = path.join(runDir, "r"), name = "n", viewerProfile = path.join(runDir, "viewer-profile");
  const report = { runDir, mode, startedAt: Date.now(), commands: [], steps: [], cleanup: {}, frames: [], viewerCommands: [], viewerMessages: [], viewerActions: [], viewerDecodedFrames: [], viewerErrors: [], denied: [], business: {}, lifecycleSnapshots: [], unexpectedFixtureRequests: [],
    scope: mode === "result" ? "One original synthetic POST and SDK finalize, actual active result-view stream during exact service-worker stop/start, explicit recovery with a new worker context and boot (target may be reused), fresh paused view/human on the same original result document without another POST." : "Independent zero-business original document: exactly acknowledged held Shift and pointer survive actual worker replacement; explicit recovery must refuse unknown input; only final formal Stop terminates the owned browser.",
    limits: "No ordinary profile, extension reload, browser restart, real account, IME, SSO/MFA or arbitrary worker-down move-return history is tested. Current original tab position is compared before and after replacement. CIM is supplemental non-atomic observation; retained Go process/Job and exact execution/cleanup receipts remain authority." };
  const save = () => fs.writeFile(path.join(runDir, "results.json"), serialize(report));
  const registry = new Set(), frameWrites = [], screenshots = [];
  let launcher, info, worker, rootObserver, serviceObserver, taskBrowser, viewerProcess, viewerBrowser, viewerContext, page, captureError, state, stopped = false;
  let oldTaskTab, oldTaskAuthority, original, beforeIdentity, oldViewerURL, finalLifecycleSaved = false, stopPromise, currentWorkerTargetId, managedEndpoint;
  const fixture = mode === "result" ? createManagedNativeRecoveryFixture() : createManagedWorkerHeldFixture();
  const server = createServer((request, response) => { if (!fixture.handle(request, response)) { report.unexpectedFixtureRequests.push({ method: request.method, url: request.url, at: Date.now() }); request.resume(); response.writeHead(404); response.end("NOT_FOUND"); } });
  const launch = (program, args, options = {}) => { const record = {}; report.commands.push(record); return managedProcess(program, args, { cwd: repo, registry, record, maximumBytes: 2 * 1024 * 1024, ...options }); };
  async function command(args, expected = 0) {
    const child = launch(executable, args, { timeoutMs: args[1] === "recover" ? 70000 : args[1] === "stop" ? 55000 : 45000 });
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
    if (selector === "#tabs" && operation === "select") await page.locator(selector).selectOption(String(tabId)); else await page.locator(selector).click();
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
  const readDocument = mode === "result" ? readManagedNativeRecoveryDocument : readManagedWorkerHeldDocument;
  const documentRead = tabId => worker.evaluate(`chrome.scripting.executeScript({target:{tabId:${tabId}},func:${readDocument.toString()}}).then(results=>{if(results.length!==1)throw new Error('ambiguous root read');return {documentId:results[0].documentId,frameId:results[0].frameId,...results[0].result}})`);
  const nativeMap = tabId => worker.evaluate(`chrome.debugger.getTargets().then(items=>items.filter(item=>item.type==='page'&&item.tabId===${tabId}).map(item=>({id:item.id,tabId:item.tabId,type:item.type,attached:item.attached,url:item.url})))`);
  const placement = tabId => worker.evaluate(`chrome.tabs.get(${tabId}).then(tab=>({id:tab.id,windowId:tab.windowId,groupId:tab.groupId,pinned:tab.pinned}))`);
  const endpointTargets = async () => (await fetch(`http://127.0.0.1:${managedEndpoint.port}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
  async function bindWorkerObserver(label, expectedTargetId) {
    const target = await wait(async () => {
      const targets = (await endpointTargets()).filter(item => item.type === "service_worker" && item.url === `chrome-extension://${info.extensionId}/background.js`);
      if (!targets.length) return null; assert.equal(targets.length, 1); return targets[0];
    }, `unique ${label} worker diagnostic target`);
    assert.equal(target.id, expectedTargetId);
    const record = {}; (report.workerObserverConnections ??= []).push({ label, targetId: target.id, record });
    worker = await connectNormalCDP(target.webSocketDebuggerUrl, { record, handshakeTimeoutMs: 10000, authorizationRequired: false });
    currentWorkerTargetId = target.id; await worker.call("Runtime.enable");
    await wait(() => worker.events.some(event => event.method === "Runtime.executionContextCreated"), `${label} original execution context`);
    (report.observers ??= []).push({ label, installation: await worker.evaluate(`(${installManagedNativeRecoveryObserver.toString()})(chrome,globalThis)`) });
    return target;
  }
  const posts = () => fixture.stats().requests.filter(item => item.method === "POST");
  async function decodeHumanFrame(lease, minimumGeneration = 1) {
    const proof = await wait(async () => {
      const frame = report.frames.findLast(item => item.connection === connection && item.controlMode === "human" && item.humanLeaseId === lease.leaseId && item.tabId === lease.tabId && item.generation >= minimumGeneration);
      if (!frame) return null;
      const decoded = await page.locator("#frame").evaluate(element => ({ hidden: element.hidden, complete: element.complete, width: element.naturalWidth, height: element.naturalHeight, ...element.dataset }));
      const ready = await page.locator("#human-input").getAttribute("data-enabled");
      return ready === "true" && state?.human?.state === "active" && state.human.leaseId === lease.leaseId && state.human.generation === frame.generation && state.human.viewport?.width > 0 && state.human.viewport?.height > 0 &&
        !decoded.hidden && decoded.complete && decoded.width > 0 && decoded.height > 0 && decoded.controlMode === "human" && decoded.humanLeaseId === lease.leaseId && decoded.streamId === frame.streamId && Number(decoded.generation) === frame.generation && Number(decoded.frameSequence) >= frame.sequence && { frame, decoded };
    }, `viewer decoded current human generation >= ${minimumGeneration}`, 35000);
    const first = report.frames.find(item => item.connection === connection && item.controlMode === "human" && item.humanLeaseId === lease.leaseId && item.generation === proof.frame.generation);
    const frameIndex = report.viewerMessages.findIndex(item => item.connection === connection && item.type === "frame" && item.streamId === first.streamId && item.sequence === first.sequence);
    const stateIndex = report.viewerMessages.findIndex(item => { if (item.connection !== connection) return false;
      const human = item.type === "state" ? item.human : item.type === "response" ? item.result?.human : null;
      return human?.state === "active" && human.leaseId === lease.leaseId && human.generation === proof.frame.generation && human.viewport?.width > 0;
    });
    assert.ok(stateIndex >= 0 && frameIndex > stateIndex, "Matching active status must precede the generation's first published frame");
    report.viewerDecodedFrames.push({ at: Date.now(), frame: { streamId: proof.frame.streamId, sequence: proof.frame.sequence, humanLeaseId: proof.frame.humanLeaseId, generation: proof.frame.generation }, decoded: proof.decoded, stateIndex, frameIndex });
    return proof.frame;
  }
  async function decodeResultView() {
    const proof = await wait(async () => {
      const view = state?.view;
      if (view?.state !== "active" || view.tabId !== oldTaskTab.id || state.selectedTabId !== oldTaskTab.id ||
          !state.tabs.some(tab => tab.id === oldTaskTab.id && tab.deliveryId === report.business.deliveryId)) return null;
      const frame = report.frames.findLast(item => item.connection === connection && item.controlMode === "user-view" && item.tabId === oldTaskTab.id && item.viewLeaseId === view.leaseId && item.generation === view.generation);
      if (!frame) return null;
      const decoded = await page.locator("#frame").evaluate(element => ({ hidden: element.hidden, complete: element.complete, width: element.naturalWidth, ...element.dataset }));
      return !decoded.hidden && decoded.complete && decoded.width > 0 && decoded.controlMode === "user-view" && decoded.viewLeaseId === view.leaseId &&
        decoded.streamId === frame.streamId && Number(decoded.generation) === view.generation && Number(decoded.frameSequence) >= frame.sequence && { view, frame, decoded };
    }, "original result-view decoded after matching lease announcement", 35000);
    const frameIndex = report.viewerMessages.findIndex(item => item.connection === connection && item.type === "frame" && item.controlMode === "user-view" && item.tabId === oldTaskTab.id &&
      item.viewLeaseId === proof.view.leaseId && item.generation === proof.view.generation && item.streamId === proof.frame.streamId);
    const stateIndex = report.viewerMessages.findIndex(item => { if (item.connection !== connection) return false; const view = item.type === "state" ? item.view : item.type === "response" ? item.result?.view : null;
      return view?.state === "active" && view.leaseId === proof.view.leaseId && view.generation === proof.view.generation; });
    assert.ok(stateIndex >= 0 && stateIndex < frameIndex, "Result frame must not authorize its own lease");
    report.viewerDecodedFrames.push({ kind: "user-view", ...proof }); return proof;
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
            report.viewerMessages.push({ type: "frame", at, connection: originalConnection, tabId: frame.tabId, streamId: frame.streamId, sequence: frame.sequence, controlMode: frame.controlMode, humanLeaseId: frame.humanLeaseId, viewLeaseId: frame.viewLeaseId, generation: frame.generation, sha256: frame.sha256 });
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

  async function lifecycle(label) {
    let directory = info?.runDir;
    if (!directory) {
      const runs = path.join(root, name, "runs"), entries = await fs.readdir(runs, { withFileTypes: true });
      assert.equal(entries.length, 1); assert.ok(entries[0].isDirectory() && /^[0-9a-f]{32}$/.test(entries[0].name)); directory = path.join(runs, entries[0].name);
    }
    const file = path.join(directory, "lifecycle.json"), bytes = await fs.readFile(file), projected = projectNativeRecoveryLifecycle(bytes), copy = `lifecycle-${label}.json`;
    await fs.writeFile(path.join(runDir, copy), bytes, { flag: "wx" });
    report.lifecycleSnapshots.push({ label, file, copy, bytes: projected.bytes, sha256: projected.sha256, nativeCreationTimeDecimal: projected.exact.nativeCreationTime });
    if (label === "final") { report.lifecycle = projected.value; report.lifecycleExact = projected.exact; finalLifecycleSaved = true; }
    return projected;
  }
  async function exactIdentity(epoch, life) {
    const nativeProof = await worker.evaluate("({extensionId:chrome.runtime.id,binding:globalThis.__obuNativeDownloadBinding})");
    const binding = life.value.binding; assert.equal(binding.bound, true); assert.equal(binding.exclusive, true); assert.equal(binding.behavior, "default");
    assert.equal(nativeProof.extensionId, info.extensionId);
    for (const key of ["extensionId", "extensionInstanceId", "workerBootId", "portId"]) assert.equal(nativeProof.binding?.[key], binding[key]);
    const destroyed = worker.events.filter(event => ["Runtime.executionContextDestroyed", "Runtime.executionContextsCleared"].includes(event.method));
    assert.deepEqual(destroyed, [], "Original worker context must not end");
    const contexts = worker.events.filter(event => event.method === "Runtime.executionContextCreated"); assert.equal(contexts.length, 1, "Original worker context must be unique");
    const context = contexts[0].params.context; assert.ok(context.id && typeof context.uniqueId === "string" && context.uniqueId);
    const targets = (await rootObserver.call("Target.getTargets")).targetInfos.filter(item => item.type === "service_worker" && item.url === `chrome-extension://${info.extensionId}/background.js`);
    assert.equal(targets.length, 1); assert.equal(targets[0].targetId, currentWorkerTargetId);
    const tree = descendants(await processTable(), info.browserPID), browser = tree.find(item => item.ProcessId === info.browserPID);
    const host = tree.find(item => item.ProcessId === info.nativePID); assert.ok(host);
    const observedWorker = { targetId: targets[0].targetId, contextId: context.id, contextUniqueId: context.uniqueId, workerBootId: binding.workerBootId };
    const record = life.value.nativeConnections.find(entry => entry.epoch === epoch); assert.ok(record);
    assert.deepEqual(record.worker, observedWorker, "Production controller and independent observer must identify the same execution");
    assert.equal(record.recoveryState?.version, 1); assert.ok(record.recoveryState.workerEpoch >= 1);
    return { epoch, info: { ...info }, browser, native: host, nativeCreationTime: life.exact.nativeCreationTime, binding,
      worker: observedWorker, recoveryState: record.recoveryState, nativeProofNonceSHA256: hash(nativeProof.binding.nonce) };
  }
  async function readSameResult() {
    const value = await documentRead(oldTaskTab.id); assert.equal(value.documentId, original.documentId); assert.equal(value.state.documentToken, original.state.documentToken);
    assert.equal(value.draft, fixture.draft); assert.equal(value.state.submits, 1); assert.deepEqual(value.state.receipt, report.business.receipt);
    const targets = await nativeMap(oldTaskTab.id); assert.equal(targets.length, 1); assert.equal(targets[0].id, report.business.originalTarget.id);
    assertManagedNativeRecoveryReceipt(fixture.stats(), original, value); return value;
  }
  async function readHeldDocument() {
    const value = await documentRead(oldTaskTab.id); assert.equal(value.documentId, original.documentId); assert.equal(value.state.documentToken, original.state.documentToken);
    const targets = await nativeMap(oldTaskTab.id); assert.equal(targets.length, 1); assert.equal(targets[0].id, report.business.originalTarget.id);
    assertSameResultPlacement(report.business.originalPlacement, await placement(oldTaskTab.id));
    return value;
  }
  async function selectOriginalResult() {
    await uiAction("#refresh", "status");
    const result = state.tabs.find(item => item.id === oldTaskTab.id);
    assert.equal(result?.kind, "result"); assert.equal(result.deliveryId, report.business.deliveryId); assert.equal(result.watchable, true); assert.equal(result.takeover, true);
    if (await page.locator("#tabs").inputValue() === String(oldTaskTab.id)) await uiAction("#watch", "select", oldTaskTab.id);
    else await uiAction("#tabs", "select", oldTaskTab.id);
    return decodeResultView();
  }
  async function editResult(label, text, review) {
    const before = report.viewerCommands.length, begun = await uiAction("#human-begin", "humanBegin");
    assert.equal(begun.status.state, "paused"); assert.equal(begun.human.tabId, oldTaskTab.id);
    const frame = await decodeHumanFrame(begun.human), document = await readSameResult(), point = await viewerPoint(document.boxes.note);
    await inputAction(`${label}: focus original result note`, () => page.mouse.click(point.x, point.y));
    await inputAction(`${label}: original note caret`, () => page.keyboard.press("End"));
    await inputAction(`${label}: committed local result text`, () => page.keyboard.insertText(text));
    if (review) { const current = await readSameResult(), p = await viewerPoint(current.boxes.review); await inputAction(`${label}: trusted local review click`, () => page.mouse.click(p.x, p.y)); }
    const edited = await readSameResult(), screenshotProof = await screenshot(`viewer-${label}.png`);
    const ended = await uiAction("#human-end", "humanEnd");
    assertPublicPausedViewerCleanup(ended, { leaseId: begun.human.leaseId });
    const settled = await readSameResult(); assert.deepEqual(settled.state.heldKeys, []); assert.deepEqual(settled.state.heldButtons, []);
    const targets = await nativeMap(oldTaskTab.id); assert.equal(targets[0].attached, false);
    const inputs = report.viewerCommands.slice(before).filter(item => item.operation === "humanInput"); assert.ok(inputs.length);
    for (let index = 0; index < inputs.length; index++) { assert.equal(inputs[index].leaseId, begun.human.leaseId); assert.equal(inputs[index].sequence, index + 1); assertHumanInputReceipt(inputs[index], await replyFor(inputs[index].id)); }
    return { begun, frame, edited, ended, settled, screenshot: screenshotProof, nativeInputs: inputs.length };
  }
  async function stopOriginal() {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      // Supplemental inventory cannot prevent the one formal Stop attempt.
      try { report.preCloseProcesses = descendants(await processTable(), info.browserPID); } catch (error) { report.cleanup.preCloseInventory = error.stack; }
      report.stopReply = assertManagedStopReply(JSON.parse((await command(["managed", "stop", "--root", root, "--name", name])).stdout), info.runId); stopped = true;
      const exit = await bound(launcher.completed, 10000, "original supervisor terminal exit"); report.supervisorExit = { code: exit.code, exitedAt: exit.exitedAt, closedAt: exit.closedAt };
      assert.equal(exit.code, 0, redact(exit.stderr)); return lifecycle("final");
    })();
    return stopPromise;
  }
  async function verifyResourcesGone() {
    const originalInfo = report.initialInfo ?? info;
    const scopes = { host: info.nativeHostName, pipes: [...new Set([originalInfo.socketPath, info.socketPath, ...(report.lifecycle?.nativeConnections ?? []).map(entry => entry.descriptor.socketPath)])] };
    const script = String.raw`$ErrorActionPreference='Stop'
$scope=$env:OBU_RECOVERY_RESOURCE_PROBE | ConvertFrom-Json
$keys=@()
foreach($view in @([Microsoft.Win32.RegistryView]::Registry32,[Microsoft.Win32.RegistryView]::Registry64)) {
  $base=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser,$view);$key=$null
  try {$key=$base.OpenSubKey(('Software\Google\Chrome\NativeMessagingHosts\'+$scope.host),$false);$keys+=@{view=$view.ToString();absent=($null -eq $key)}} finally {if($null -ne $key){$key.Close()};$base.Close()}
}
$present=@([IO.Directory]::GetFiles('\\.\pipe\') | Where-Object {$scope.pipes -contains $_})
@{registration=$keys;presentOriginalPipes=$present} | ConvertTo-Json -Compress -Depth 5`;
    const record = {}; report.resourceProbe = record;
    await runProcess("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { registry, record, timeoutMs: 15000, env: { ...process.env, OBU_RECOVERY_RESOURCE_PROBE: JSON.stringify(scopes) } });
    const result = JSON.parse(record.stdout); assert.equal(result.registration.length, 2); assert.ok(result.registration.every(item => item.absent)); assert.deepEqual(result.presentOriginalPipes, []);
    const endpointDir = path.join(info.runDir, "temp", "open-browser-use");
    report.endpointFilesAfterStop = await fs.readdir(endpointDir); assert.deepEqual(report.endpointFilesAfterStop, []); return result;
  }

  try {
    report.source = { executable: hash(await fs.readFile(executable)), browser: hash(await fs.readFile(chromium)), extension: await treeHashes(extension), sdk: await treeHashes(path.join(repo, "packages/open-browser-use-js/dist")) };
    const snapshot = path.join(runDir, "source-snapshot");
    const builder = await fs.readFile(path.join(repo, "scripts/build-chrome-extension.mjs"), "utf8");
    const declaration = builder.match(/const productionFiles\s*=\s*(\[[\s\S]*?\]);/); assert.ok(declaration, "The frozen builder must declare its exact production inputs");
    const productionFiles = JSON.parse(declaration[1]); assert.equal(new Set(productionFiles).size, productionFiles.length);
    assert.ok(["managed-human-control.js", "managed-result-journal.js"].every(name => productionFiles.includes(name)), "Worker recovery requires the actual persistent journal production module");
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
    const runtimeSource = "internal/managedruntime/runtime.go";
    report.recommendedBrowser = { version: readRecommendedBrowserVersion(await fs.readFile(path.join(snapshot, runtimeSource), "utf8")), source: runtimeSource, sourceSHA256: report.source.snapshot[runtimeSource] };
    await fs.cp(extension, path.join(runDir, "extension-input"), { recursive: true });
    await fs.cp(path.join(repo, "packages/open-browser-use-js/dist"), path.join(runDir, "sdk-input"), { recursive: true });
    const { connectOpenBrowserUse } = await import(pathToFileURL(path.join(runDir, "sdk-input/index.js")));
    await listenFixture(server); const fixtureURL = `http://127.0.0.1:${server.address().port}`;

    if (validationFile) {
      const bytes = await fs.readFile(validationFile), validation = JSON.parse(bytes);
      assert.equal(validation.passed, true); assert.equal(validation.sourceUnchanged, true); assert.deepEqual(validation.before, validation.after);
      for (const phase of ["test", "vet", "build", "buildInfo"]) assert.equal(validation[phase].exitCode, 0);
      assert.equal(validation.executableSHA256, report.source.executable); assert.ok(Object.keys(validation.before).length);
      for (const [relative, expected] of Object.entries(validation.before)) { const file = path.resolve(repo, relative), inside = path.relative(repo, file); assert.ok(inside && !path.isAbsolute(inside) && inside !== ".." && !inside.startsWith(`..${path.sep}`)); assert.equal(hash(await fs.readFile(file)), expected, `Verified build source changed: ${relative}`); }
      await fs.writeFile(path.join(runDir, "host-build-validation.json"), bytes, { flag: "wx" }); report.hostBuild = { mode: "caller supplied original verified build; not rebuilt by runner", validationSHA256: hash(bytes), executableSHA256: validation.executableSHA256, copy: "host-build-validation.json" };
    } else report.hostBuild = { mode: "caller supplied binary; source/build provenance unverified", executableSHA256: report.source.executable };

    await step("original-managed-run-worker-binding-and-viewer", async () => {
      launcher = launch(executable, ["managed", "run", "--root", root, "--name", name, "--browser-path", chromium, "--extension-dir", extension, "--startup-timeout", "30s"]);
      const ready = await wait(() => { if (launcher.record.closedAt) throw new Error(`Original launcher ended: ${redact(launcher.record.stderr)}`); return parseManagedReadyOutput(launcher.record.stdout); }, "one formal managed ready", 40000);
      assert.equal(ready.state, "ready"); info = ready.info; report.initialInfo = { ...info }; report.info = { ...info };
      const inside = path.relative(root, info.runDir); assert.ok(inside && !path.isAbsolute(inside) && inside !== ".." && !inside.startsWith(`..${path.sep}`));
      assert.equal(info.name, name); assert.match(info.runId, /^[0-9a-f]{32}$/); assert.ok(info.browserPID > 0 && info.nativePID > 0);
      const status = JSON.parse((await command(["managed", "status", "--root", root, "--name", name])).stdout);
      assert.equal(status.state, "ready"); assert.equal(status.nativeEpoch, 1); assert.deepEqual(status.info, info); report.initialStatus = status;
      report.originalProcesses = descendants(await processTable(), info.browserPID); assert.ok(report.originalProcesses.some(item => item.ProcessId === info.nativePID));
      managedEndpoint = await endpointFor(info.profileDir, launcher);
      report.rootObserverConnection = {}; rootObserver = await connectNormalCDP(managedEndpoint.url, { record: report.rootObserverConnection, handshakeTimeoutMs: 10000, authorizationRequired: false });
      await rootObserver.call("Target.setDiscoverTargets", { discover: true });
      const targets = await endpointTargets();
      const workers = targets.filter(item => item.type === "service_worker" && item.url === `chrome-extension://${info.extensionId}/background.js`); assert.equal(workers.length, 1);
      report.workerTargetId = workers[0].id; await bindWorkerObserver("original", report.workerTargetId);
      const diagnostic = await rootObserver.call("Target.createTarget", { url: "about:blank", background: true });
      report.serviceWorkerDiagnosticTarget = { targetId: diagnostic.targetId, url: "about:blank", background: true, browserPID: info.browserPID, createdAt: Date.now(), role: "Independent ServiceWorker domain; no production recovery authority or business-page attachment" };
      const observerTarget = await wait(async () => (await endpointTargets()).find(item => item.id === diagnostic.targetId && item.type === "page" && item.url === "about:blank"), "original diagnostic page target");
      report.serviceObserverConnection = {}; serviceObserver = await connectNormalCDP(observerTarget.webSocketDebuggerUrl, { record: report.serviceObserverConnection, handshakeTimeoutMs: 10000, authorizationRequired: false });
      beforeIdentity = report.beforeIdentity = await exactIdentity(status.nativeEpoch, await lifecycle("ready"));
      assert.equal(JSON.parse((await fs.readFile(path.join(runDir, "lifecycle-ready.json"))).toString()).browserVersion.product, `Chrome/${report.recommendedBrowser.version}`, "This acceptance targets the frozen production recommendation");
      taskBrowser = await connectOpenBrowserUse({ socketPath: info.socketPath, sessionId: "managed-worker-recovery-acceptance", turnId: mode === "result" ? "original-one-shot-business" : "independent-zero-business-held", timeoutMs: 10000 });
      const backend = await taskBrowser.client.getInfo(); report.originalBackendInfo = backend;
      assert.equal(backend.metadata.extensionId, info.extensionId); assert.equal(backend.metadata.extensionInstanceId, info.extensionInstanceId);
      assert.equal(backend.metadata.pageDownloads.generation, beforeIdentity.binding.generation);
      const startup = browserStartupOptions([`--user-data-dir=${viewerProfile}`, "--headless=new", "--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "about:blank"], process.env.OBU_TEST_FIELD_TRIAL_CONFIG);
      report.viewerStartup = startup; viewerProcess = launch(chromium, startup.args);
      viewerBrowser = await bound(playwrightChromium.connectOverCDP((await endpointFor(viewerProfile, viewerProcess)).url), 15000, "independent private viewer connect");
      viewerContext = await viewerBrowser.newContext({ viewport: { width: 1280, height: 1000 } });
      report.viewerProcesses = descendants(await processTable(), viewerProcess.record.pid); assert.ok(!report.viewerProcesses.some(item => item.ProcessId === info.browserPID));
      oldViewerURL = new URL(ready.viewerURL); report.oldViewer = { origin: oldViewerURL.origin, ticketSHA256: hash(oldViewerURL.hash.slice(8)), unused: false };
      await openViewer(ready.viewerURL); report.viewerInitial = await screenshot("viewer-initial.png"); assert.equal(state.status.state, "running");
    });

    await step(mode === "result" ? "one-original-post-finalize-and-active-result-view" : "independent-zero-business-confirmed-held-key-and-pointer", async () => {
      oldTaskTab = await taskBrowser.newTab({ url: fixtureURL + fixture.paths.form, backgroundWindow: true });
      if (mode === "result") await oldTaskTab.getByLabel("Original draft", { exact: true }).fill(fixture.draft, { timeoutMs: 10000 });
      else await oldTaskTab.domSnapshot({ timeoutMs: 10000 });
      oldTaskAuthority = captureTaskAuthority(taskBrowser.client, oldTaskTab.id);
      original = await documentRead(oldTaskTab.id); assert.equal(original.frameId, 0); assert.ok(original.documentId);
      const targets = await nativeMap(oldTaskTab.id); assert.equal(targets.length, 1);
      Object.assign(report.business, { tabId: oldTaskTab.id, original, originalAuthority: oldTaskAuthority, originalTarget: targets[0] });
      assert.equal(posts().length, 0);
      if (mode === "result") {
        assert.equal(original.draft, fixture.draft);
        await oldTaskTab.getByRole("button", { name: "Commit once", exact: true }).click({ timeoutMs: 10000 });
        const committed = await wait(async () => { const value = await documentRead(oldTaskTab.id); return value.state?.receipt?.ok && value; }, "one original POST response");
        report.business.receipt = committed.state.receipt;
        report.business.originalReceiptProof = assertManagedNativeRecoveryReceipt(fixture.stats(), original, committed);
        report.business.finalize = await taskBrowser.client.finalizeTabs([{ tabId: oldTaskTab.id, status: "deliverable" }]);
        await denied("original task authority after finalize", () => requestOriginalSnapshot(taskBrowser.client, oldTaskAuthority), /OBU_STALE_CONTROL_EPOCH/);
        await uiAction("#refresh", "status"); const result = state.tabs.find(item => item.id === oldTaskTab.id);
        assert.equal(result?.kind, "result"); assert.ok(result.deliveryId);
        report.business.originalDeliveryId = report.business.deliveryId = result.deliveryId;
        report.business.originalPlacement = await placement(oldTaskTab.id);
        report.business.baselineResultView = await selectOriginalResult();
        report.business.originalView = { leaseId: state.view.leaseId, targetId: targets[0].id };
        assert.equal((await nativeMap(oldTaskTab.id))[0].attached, true);
        report.business.beforeReplacement = await readSameResult();
        assert.equal(report.business.beforeReplacement.note, "");
        report.business.activeViewScreenshot = await screenshot("viewer-active-original-result.png");
        assert.equal(posts().length, 1);
      } else {
        report.business.originalPlacement = await placement(oldTaskTab.id);
        await uiAction("#refresh", "status"); await uiAction("#tabs", "select", oldTaskTab.id);
        const begun = report.business.originalHuman = await uiAction("#human-begin", "humanBegin");
        assert.equal(begun.human.tabId, oldTaskTab.id); await decodeHumanFrame(begun.human);
        // Focus only the local viewer input surface. No click/up is sent to the
        // original page before the sole held pointer press.
        await page.locator("#human-input").focus();
        await inputAction("held original Shift down", () => page.keyboard.down("Shift"));
        const point = await viewerPoint((await documentRead(oldTaskTab.id)).boxes.held);
        await inputAction("held pointer move", () => page.mouse.move(point.x, point.y));
        await inputAction("held original left pointer down", () => page.mouse.down({ button: "left" }));
        const held = await readHeldDocument();
        assert.equal(held.state.overflow, false);
        assert.ok(held.state.events.some(event => event.type === "keydown" && event.code === "ShiftLeft" && event.trusted === true));
        assert.ok(held.state.events.some(event => event.type === "mousedown" && event.button === 0 && event.target === "held" && event.trusted === true));
        assertHeldInputUnreleased(held, held); report.business.held = held;
        report.business.heldScreenshot = await screenshot("viewer-held-original-input.png");
        report.business.zeroBusiness = assertZeroBusinessHeldFixture(fixture.stats());
      }
      report.business.beforeFaultCommands = report.viewerCommands.length;
      assert.equal(report.viewerCommands.filter(item => item.operation === "resume" || item.operation === "humanEnd").length, 0);
      taskBrowser.close(); taskBrowser = null;
    });

    await step("exact-original-worker-stop-native-eof-and-new-execution", async () => {
      report.beforeFaultLifecycle = (await lifecycle("before-worker-stop")).value;
      assertSameResultPlacement(report.business.originalPlacement, await placement(oldTaskTab.id));
      report.observerBeforeReplacement = await worker.evaluate("__managedHumanAcceptance.stop()");
      assert.equal(report.observerBeforeReplacement.overflow, false);
      report.workerEventsBeforeReplacement = worker.events.filter(event => event.method?.startsWith("Runtime.executionContext"));
      report.workerReplacement = {};
      let running;
      try { running = await replaceOriginalWorker({ service: serviceObserver, worker,
        scriptURL: `chrome-extension://${info.extensionId}/background.js`, targetId: beforeIdentity.worker.targetId,
        until: wait, detail: report.workerReplacement,
        originalTerminated: async timeoutMs => {
          const ended = await poll(async () => {
            const bytes = await fs.readFile(path.join(info.runDir, "lifecycle.json"));
            const value = projectNativeRecoveryLifecycle(bytes).value, entry = value.nativeConnections?.[0];
            if (value.state !== "degraded" || entry?.exitConfirmed !== true || !entry.executionEnd) return null;
            assertNativeRecoveryExit(entry.exit, 0); assertWorkerExecutionEnded(entry.executionEnd, beforeIdentity.worker);
            return { executionEnd: entry.executionEnd, exit: entry.exit, exitConfirmed: entry.exitConfirmed, observedAt: Date.now() };
          }, { timeoutMs, intervalMs: 80, label: "original production context ended and original native EOF confirmed" });
          report.degradedLifecycle = (await lifecycle("degraded-before-start")).value;
          return ended;
        }
      }); } finally {
        // The observer was removed before the fault. Retire only this exact
        // closed diagnostic handle; a reused targetId can name a new worker.
        if (worker?.state() === "closed") worker = null;
      }
      await bindWorkerObserver("replacement", running.targetId);
      const contexts = worker.events.filter(event => event.method === "Runtime.executionContextCreated");
      assert.equal(contexts.length, 1); assert.notEqual(contexts[0].params.context.uniqueId, beforeIdentity.worker.contextUniqueId);
      report.replacementContext = contexts[0].params.context;
      const degraded = JSON.parse((await command(["managed", "status", "--root", root, "--name", name])).stdout);
      assert.equal(degraded.state, "degraded"); assert.equal(degraded.nativeEpoch, 1);
      assert.equal(degraded.info.runId, info.runId); assert.equal(degraded.info.browserPID, info.browserPID); assert.equal(degraded.info.socketPath, "");
      report.degraded = degraded;
      const noView = await command(["managed", "view", "--root", root, "--name", name], 1);
      assert.match(noView.stderr, /recover|unavailable/i); report.degradedViewRejected = true;
      const tree = descendants(await processTable(), info.browserPID);
      assert.deepEqual(tree.find(item => item.ProcessId === info.browserPID), beforeIdentity.browser);
      report.replacementProcessesBeforeRecovery = tree;
      assertSameResultPlacement(report.business.originalPlacement, await placement(oldTaskTab.id));
      if (mode === "result") {
        report.business.afterWorkerReplacement = await readSameResult();
        report.business.orphanAttachment = (await nativeMap(oldTaskTab.id))[0];
        assert.equal(report.business.orphanAttachment.attached, true, "This positive run must recover the actual original orphan view attachment");
      }
      else report.business.afterWorkerReplacement = assertHeldInputUnreleased(report.business.held, await readHeldDocument());
      assert.equal(report.viewerCommands.slice(report.business.beforeFaultCommands).filter(item => item.operation === "humanInput").length, 0, "Worker loss must not be replaced with a synthetic UI release");
      assert.equal(report.viewerCommands.filter(item => item.operation === "resume").length, 0);
    });

    await step(mode === "result" ? "explicit-worker-recovery-new-delivery-and-old-capability-rejection" : "explicit-recovery-refuses-unknown-original-held-input", async () => {
      if (mode === "held-input") {
        const rejected = await command(["managed", "recover", "--root", root, "--name", name], 1);
        assert.match(rejected.stderr, /original worker ended before human cleanup was confirmed; waiting for owned browser exit|original human input cleanup remains unknown; Stop this run/);
        report.recoveryRejected = { code: rejected.code, stderr: rejected.stderr, at: Date.now() };
        const status = JSON.parse((await command(["managed", "status", "--root", root, "--name", name])).stdout);
        assert.equal(status.state, "degraded"); assert.equal(status.nativeEpoch, 1); assert.equal(status.info.socketPath, ""); report.rejectedStatus = status;
        report.business.afterRejectedRecovery = assertHeldInputUnreleased(report.business.held, await readHeldDocument());
        report.replacementProcesses = descendants(await processTable(), info.browserPID);
        report.oldListenerProbe = await probeRejectedViewerToken(oldViewerURL.origin, oldViewerURL.hash.slice(8));
        return;
      }
      const recovered = JSON.parse((await command(["managed", "recover", "--root", root, "--name", name])).stdout);
      assert.equal(recovered.state, "recovered"); assert.equal(recovered.runId, info.runId); assert.equal(recovered.nativeEpoch, 2);
      info = recovered.info; report.info = { ...info };
      report.recovery = { ...recovered, viewerURL: undefined, viewerOrigin: new URL(recovered.viewerURL).origin, ticketSHA256: hash(new URL(recovered.viewerURL).hash.slice(8)) };
      const life = await lifecycle("recovered"); report.afterIdentity = await exactIdentity(2, life);
      assertWorkerReplacement(beforeIdentity, report.afterIdentity);
      assert.equal(life.value.nativeConnections.length, 2);
      const previous = life.value.nativeConnections[0], current = life.value.nativeConnections[1];
      assertWorkerExecutionEnded(previous.executionEnd, beforeIdentity.worker);
      const replacement = report.workerReplacement;
      assert.ok(Date.parse(previous.executionEnd.at) <= replacement.terminationConfirmedAt);
      assert.ok(Date.parse(previous.exit.at) <= replacement.terminationConfirmedAt);
      if (replacement.startMode === "explicit") {
        assert.equal(replacement.startInvocations, 1);
        assert.ok(replacement.terminationConfirmedAt <= replacement.startRequestedAt);
      } else {
        assert.equal(replacement.startMode, "browser-automatic"); assert.equal(replacement.startInvocations, 0);
        assert.equal(replacement.startRequestedAt, undefined);
        assert.ok(replacement.automaticStartup.at >= replacement.stopped.at);
      }
      assert.equal(current.workerRecovery.error, undefined); assert.ok(Number.isFinite(Date.parse(current.workerRecovery.at)));
      report.workerRecoveryReceipt = assertWorkerRecoveryReceipt(current.workerRecovery.result, { before: beforeIdentity, after: report.afterIdentity, recoveryState: beforeIdentity.recoveryState, originalView: report.business.originalView });
      assert.equal(current.recoveryState.workerEpoch, beforeIdentity.recoveryState.workerEpoch + 1);
      report.business.retiredAttachment = (await nativeMap(oldTaskTab.id))[0];
      assert.equal(report.business.retiredAttachment.id, report.business.originalTarget.id);
      assert.equal(report.business.retiredAttachment.attached, false, "Fresh delivery must follow actual orphan detach, before selecting a new view");
      report.replacementProcesses = descendants(await processTable(), info.browserPID);
      const freshURL = new URL(recovered.viewerURL); assert.notEqual(freshURL.hash, oldViewerURL.hash);
      report.oldListenerProbe = await probeRejectedViewerToken(oldViewerURL.origin, oldViewerURL.hash.slice(8));
      report.oldTokenOnNewListenerProbe = await probeRejectedViewerToken(freshURL.origin, oldViewerURL.hash.slice(8));
      // Inspect only the actual public status through the fresh UI before a
      // separate probe. Closing that UI uses the formal view cleanup barrier.
      const oldPage = page; await openViewer(freshURL.href); await oldPage.close();
      assertPublicPausedViewerCleanup(state); assert.equal(state.workerBootId, report.afterIdentity.worker.workerBootId);
      const result = state.tabs.find(item => item.id === oldTaskTab.id);
      assert.equal(result?.kind, "result"); assert.ok(result.deliveryId); assert.notEqual(result.deliveryId, report.business.originalDeliveryId);
      report.business.deliveryId = result.deliveryId; report.recoveredViewerState = state;
      const initialRecoveredPage = page; await initialRecoveredPage.close(); assert.equal(initialRecoveredPage.isClosed(), true); page = null;
      const probeTicket = JSON.parse((await command(["managed", "view", "--root", root, "--name", name])).stdout);
      assert.equal(probeTicket.state, "viewer"); assert.equal(probeTicket.runId, info.runId);
      try { report.oldDeliveryProbe = await probeRetiredDelivery(probeTicket.viewerURL, { tabId: oldTaskTab.id, oldDeliveryId: report.business.originalDeliveryId, newDeliveryId: report.business.deliveryId }); }
      catch (error) { report.oldDeliveryProbe = error.workerDeliveryProbe; throw error; }
      const next = JSON.parse((await command(["managed", "view", "--root", root, "--name", name])).stdout);
      assert.equal(next.state, "viewer"); assert.equal(next.runId, info.runId);
      report.probeRetirement = { actualSocketClosedAt: report.oldDeliveryProbe.closedAt, serverCleanupBarrierAt: Date.now(), proof: "one formal managed view joins previous reader/workers and actual cleanup" };
      await openViewer(next.viewerURL); assertPublicPausedViewerCleanup(state);
      report.business.afterRecovery = await readSameResult(); assertSameResultPlacement(report.business.originalPlacement, await placement(oldTaskTab.id));
      const currentStatus = JSON.parse((await command(["managed", "status", "--root", root, "--name", name])).stdout);
      assert.equal(currentStatus.state, "ready"); assert.equal(currentStatus.nativeEpoch, 2); assert.deepEqual(currentStatus.info, info); report.recoveredStatus = currentStatus;
    });

    await step(mode === "result" ? "fresh-paused-view-and-real-human-continuation-without-replay" : "unknown-input-remains-held-until-formal-stop", async () => {
      if (mode === "result") {
        report.business.recoveredResultView = await selectOriginalResult(); assert.equal(state.status.state, "paused");
        assert.notEqual(state.view.leaseId, report.business.originalView.leaseId);
        assert.notEqual(report.business.recoveredResultView.frame.streamId, report.business.baselineResultView.frame.streamId);
        report.business.recoveredHuman = await editResult("after-worker-recovery", recoveryAfterNote, true);
        const final = report.business.recoveredHuman.settled;
        assert.equal(final.note, recoveryAfterNote); assert.deepEqual(final.state.reviews, [{ trusted: true, sequence: 1 }]);
        assert.ok(final.state.events.filter(event => event.type === "input" && event.target === "note").every(event => event.trusted));
        report.business.finalReceiptProof = assertManagedNativeRecoveryReceipt(fixture.stats(), original, final);
        assert.equal(report.viewerCommands.filter(item => item.operation === "humanBegin").length, 1);
        assert.equal(report.viewerCommands.filter(item => item.operation === "humanEnd").length, 1);
        for (const request of report.viewerCommands.filter(item => ["select", "humanBegin"].includes(item.operation) && item.tabId !== null)) {
          assert.equal(request.deliveryId, request.connection === 1 ? report.business.originalDeliveryId : report.business.deliveryId);
        }
        assert.ok(report.frames.filter(frame => frame.connection > 1).every(frame => frame.viewLeaseId !== report.business.originalView.leaseId), "Retired view frames must never cross a fresh viewer connection");
      } else {
        report.business.beforeStopHeld = assertHeldInputUnreleased(report.business.held, await readHeldDocument());
        report.business.zeroBusiness = assertZeroBusinessHeldFixture(fixture.stats());
        assert.equal(report.viewerCommands.slice(report.business.beforeFaultCommands).filter(item => item.operation === "humanInput").length, 0);
        assert.equal(launcher.record.closedAt, undefined, "Rejected recovery must not terminate the original browser implicitly");
      }
      assertSameResultPlacement(report.business.originalPlacement, await placement(oldTaskTab.id));
      assert.equal(report.viewerCommands.filter(item => item.operation === "resume").length, 0);
      assert.equal(report.unexpectedFixtureRequests.filter(item => item.method === "POST").length, 0);
      report.observerFinal = await worker.evaluate("__managedHumanAcceptance.stop()"); assert.equal(report.observerFinal.overflow, false); assert.equal(report.observerFinal.listenerPresent, false);
      report.workerContextFinal = worker.events.filter(item => item.method?.startsWith("Runtime.executionContext"));
      assert.equal(report.workerContextFinal.filter(item => item.method === "Runtime.executionContextCreated").length, 1);
      assert.equal(report.workerContextFinal.filter(item => item.method !== "Runtime.executionContextCreated").length, 0);
      for (const observation of report.workerObserverConnections) assert.equal(observation.record.eventsDropped, 0);
      assert.equal(report.serviceObserverConnection.eventsDropped, 0); assert.equal(report.rootObserverConnection.eventsDropped, 0);
      await worker.close(); worker = null;
    });

    await step("formal-stop-original-browser-native-generations-and-owned-resources", async () => {
      const life = await stopOriginal(); assertManagedViewerTerminal(life.value, info);
      assert.equal(life.value.nativeConnections.length, 2, "Single replacement must retain both original native process handles, including a denied unbound candidate");
      for (let index = 0; index < 2; index++) {
        const entry = life.value.nativeConnections[index]; assert.equal(entry.epoch, index + 1);
        assert.ok(Number.isSafeInteger(entry.descriptor.pid) && entry.descriptor.pid > 0);
        assert.match(life.exact.nativeConnections[index].creationTime, /^[1-9][0-9]{0,19}$/);
        assert.equal(entry.error, undefined); assert.equal(entry.exitConfirmed, true); assertNativeRecoveryExit(entry.exit, 0);
        if (index === 0 || mode === "result") {
          const source = index === 0 ? beforeIdentity : report.afterIdentity;
          assert.equal(entry.descriptor.pid, source.info.nativePID); assert.equal(entry.descriptor.socketPath, source.info.socketPath);
          assert.equal(life.exact.nativeConnections[index].creationTime, source.nativeCreationTime); assert.deepEqual(entry.binding, source.binding);
          assert.equal(entry.controllerCleanup.error, undefined); assert.ok(entry.controllerCleanup.at && entry.controllerCleanup.result);
        } else {
          assert.equal(entry.binding, undefined, "A held-risk replacement native must not receive a task binding");
          assert.equal(entry.workerRecovery, undefined, "Unknown held input must not create a successful worker recovery receipt");
        }
      }
      assertWorkerExecutionEnded(life.value.nativeConnections[0].executionEnd, beforeIdentity.worker);
      report.serviceWorkerEvents = serviceObserver.events.filter(event => event.method?.startsWith("ServiceWorker."));
      report.diagnosticTargetEvents = rootObserver.events.filter(event => event.params?.targetId === report.serviceWorkerDiagnosticTarget.targetId || event.params?.targetInfo?.targetId === report.serviceWorkerDiagnosticTarget.targetId);
      report.diagnosticTargetTermination = { targetId: report.serviceWorkerDiagnosticTarget.targetId, proof: "original Browser.close and retained Browser process exit plus empty original Job", browserExit: life.value.browserExit, jobEmpty: life.value.jobEmpty };
      const originals = [...report.originalProcesses, ...report.replacementProcessesBeforeRecovery, ...report.replacementProcesses, ...(report.preCloseProcesses ?? [])];
      report.processesGone = await poll(async () => { const table = await processTable(), remaining = originals.filter(before => table.some(after => before.ProcessId === after.ProcessId && before.CreationDate === after.CreationDate)); return !remaining.length && { at: Date.now(), originalIdentities: originals.length, remaining }; }, { timeoutMs: 15000, intervalMs: 100, label: "all original managed process identities gone" });
      report.resourcesGone = await verifyResourcesGone();
      const status = await command(["managed", "status", "--root", root, "--name", name], 1); assert.match(status.stderr, /has no reachable supervisor/);
    });
  } catch (error) {
    report.error = error.stack; report.firstFailure ??= { at: Date.now(), error: error.stack }; console.error(redact(error.stack ?? error));
    if (worker && oldTaskTab) try { report.failureDocument = await bound(documentRead(oldTaskTab.id), 5000, "same failed original document observation"); } catch (failure) { report.failureDocumentError = redact(failure.stack); }
    if (page) try { report.failureViewer = await bound(page.evaluate(() => ({ state: document.getElementById("state")?.textContent, error: document.getElementById("error")?.textContent, input: { ...document.getElementById("human-input")?.dataset }, activeElement: document.activeElement?.id })), 5000, "original failed viewer observation"); } catch (failure) { report.failureViewerError = redact(failure.stack); }
  } finally {
    if (worker) { try { report.cleanupObserver = await worker.evaluate("__managedHumanAcceptance.stop()"); } catch (error) { report.cleanup.observer = error.stack; } try { await worker.close(); } catch (error) { report.cleanup.workerTransport = error.stack; } }
    if (serviceObserver) try { await serviceObserver.close(); } catch (error) { report.cleanup.serviceTransport = error.stack; }
    if (rootObserver) try { await rootObserver.close(); } catch (error) { report.cleanup.rootTransport = error.stack; }
    taskBrowser?.close();
    if (launcher && !launcher.record.closedAt) {
      if (!stopped) try { await stopOriginal(); } catch (error) { report.cleanup.stop = error.stack; }
      try { await bound(launcher.completed, 12000, "original supervisor cleanup terminal exit"); }
      catch (error) { report.cleanup.supervisor = error.stack; launcher.terminate("acceptance-cleanup"); try { await bound(launcher.completed, 12000, "owned supervisor forced terminal exit"); } catch (failure) { report.cleanup.forcedSupervisor = failure.stack; } }
    }
    if (launcher && !finalLifecycleSaved) try { await lifecycle("final"); } catch (error) { report.cleanup.finalLifecycle = error.stack; }
    if (viewerBrowser) {
      try { report.viewerPreCloseProcesses = descendants(await processTable(), viewerProcess.record.pid); } catch (error) { report.cleanup.viewerInventory = error.stack; }
      try { const cdp = await viewerBrowser.newBrowserCDPSession(); report.viewerClose = { requestedAt: Date.now(), acknowledgement: await bound(cdp.send("Browser.close"), 5000, "original viewer Browser.close ACK"), acknowledgedAt: Date.now() }; } catch (error) { report.cleanup.viewerClose = error.stack; }
    }
    if (viewerProcess) try { const result = await bound(viewerProcess.completed, 10000, "independent viewer actual terminal exit"); assert.equal(result.code, 0); report.viewerExit = { code: result.code, exitedAt: result.exitedAt, closedAt: result.closedAt }; }
    catch (error) { report.cleanup.viewerExit = error.stack; viewerProcess.terminate("acceptance-cleanup"); try { await bound(viewerProcess.completed, 10000, "owned viewer forced terminal exit"); } catch (failure) { report.cleanup.forcedViewer = failure.stack; } }
    if (viewerBrowser) try { await bound(viewerBrowser.close(), 5000, "viewer transport release"); } catch (error) { report.cleanup.viewerTransport = error.stack; }
    if (report.viewerProcesses) try {
      const originals = [...report.viewerProcesses, ...(report.viewerPreCloseProcesses ?? [])];
      report.viewerProcessesGone = await poll(async () => { const table = await processTable(), remaining = originals.filter(before => table.some(after => before.ProcessId === after.ProcessId && before.CreationDate === after.CreationDate)); return !remaining.length && { at: Date.now(), originalIdentities: originals.length, remaining }; }, { timeoutMs: 15000, intervalMs: 100, label: "independent viewer original identities gone" });
    } catch (error) { report.cleanup.viewerProcesses = error.stack; }
    server.closeAllConnections(); if (server.listening) await bound(new Promise(resolve => server.close(resolve)), 5000, "fixture close");
    try { await bound(Promise.all(frameWrites), 5000, "actual captured frame writes"); checkCapture(); } catch (error) { report.cleanup.frameWrites = error.stack; }
    try {
      assert.equal(hash(await fs.readFile(executable)), report.source.executable); assert.equal(hash(await fs.readFile(chromium)), report.source.browser);
      assert.deepEqual(await treeHashes(extension), report.source.extension); assert.deepEqual(await treeHashes(path.join(repo, "packages/open-browser-use-js/dist")), report.source.sdk);
      assert.deepEqual(await treeHashes(path.join(runDir, "source-snapshot")), report.source.snapshot);
      for (const [relative, expected] of Object.entries(report.source.snapshot)) assert.equal(hash(await fs.readFile(path.join(repo, relative))), expected, `Source changed during acceptance: ${relative}`);
      if (validationFile) assert.equal(hash(await fs.readFile(validationFile)), report.hostBuild.validationSHA256); report.sourceUnchanged = true;
    } catch (error) { report.cleanup.sourceChanged = error.stack; }
    report.fixture = fixture.stats(); report.screenshots = screenshots; report.endedAt = Date.now();
    report.frameRetention = { observedFrames: report.frames.length, savedPNGs: report.frames.filter(item => item.file).length, maximumSavedPNGs: 96, policy: "First 96 native PNG payloads retained; every frame keeps header/hash, decoded frames require actual viewer decode. No claim that every retained PNG was decoded." };
    report.liveRunnerChildren = [...registry].map(value => value.pid);
    report.passed = !report.error && report.steps.length === 6 && report.steps.every(item => item.passed) && !Object.keys(report.cleanup).length && !registry.size && report.viewerExit?.code === 0;
    await save(); console.log("RESULT", JSON.stringify({ runDir, passed: report.passed }));
  }
  return report;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  assert.ok(process.argv.length === 2 || process.argv.length === 3 && process.argv[2] === "--held-input", "Use explicit environment inputs and optional --held-input for an independent zero-business run");
  const report = await runManagedWorkerRecoveryCheck({ mode: process.argv[2] === "--held-input" ? "held-input" : "result" }); process.exitCode = report.passed ? 0 : 1;
}
