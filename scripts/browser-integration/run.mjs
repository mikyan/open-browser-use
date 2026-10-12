import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";
import WebSocket, { WebSocketServer } from "ws";
import { buildChromeExtension } from "../build-chrome-extension.mjs";
import { actionsFixture, checkExtendedActions } from "./actions-fixture.mjs";
import { createDragCommitFixtures, checkDragCommit } from "./drag-commit-fixture.mjs";
import { createCreatedPageFixtures } from "./created-page-fixture.mjs";
import { checkCreatedPageProvenance } from "./created-page-provenance.mjs";
import { checkCreatedPageFiveEntry, readCreatedPageGate, withinCreatedPageBudget } from "./created-page-five-entry.mjs";
import { runCreatedPageCaller } from "./created-page-callers.mjs";
import { checkCreatedPageUnowned } from "./created-page-unowned.mjs";
import { listenFixture } from "./fixture-listener.mjs";
import { createSDKConnectionFixtures, checkSDKConnections, sdkConnectionKinds } from "./sdk-connection-fixture.mjs";
import { diagnosticsFixture, checkDiagnostics } from "./diagnostics-fixture.mjs";
import { pauseFixture, checkGlobalPause } from "./pause-fixture.mjs";
import { siteAccessFixture, checkSiteAccess } from "./site-access-fixture.mjs";
import { pageExportFixture, preparePageExportTab, verifyExportBytes, checkPageExports, checkPageExportLifecycle } from "./page-exports-fixture.mjs";
import { createMediaDownloadFixtures, checkMediaDownloads, verifyMediaFile, mediaPNG } from "./media-downloads-fixture.mjs";
import { createEmbeddedMediaFixtures, prepareEmbeddedMediaTab, checkEmbeddedMedia, checkEmbeddedMediaNegative, verifyEmbeddedMediaFile, readMediaFrameEvidence } from "./media-embedded-fixture.mjs";
import { mediaAssetIdentity } from "./media-fixture-assets.mjs";
import { checkMediaLifecycle, checkMediaNavigationCleanup } from "./media-lifecycle-fixture.mjs";
import { checkMediaReadCancellation } from "./media-content-lifecycle-fixture.mjs";
import { checkMediaReferences } from "./media-reference-fixture.mjs";
import { clipboardFixture, clipboardPNG, checkClipboard, checkClipboardLifecycle, holdClipboardPreparation } from "./clipboard-fixture.mjs";
import { verifyMemoryClipboard } from "./memory-clipboard.mjs";
import { checkPythonClipboard, checkGoClipboard, checkCLIClipboard, checkMCPClipboard } from "./clipboard-callers.mjs";
import { elementScreenshotFixture, checkElementScreenshots } from "./element-screenshot-fixture.mjs";
import { createBoundingGeometryFixtures, checkBoundingGeometry } from "./bounding-geometry-fixture.mjs";
import { popupFixture, checkChildTabAuthorization, checkAuxiliaryPopupRendering, checkAuxiliaryPopupLifecycle } from "./popup-fixture.mjs";
import { aiSnapshotFixture, fixtureRef, checkAISnapshotRefs, checkAISnapshotLifecycle, checkAISnapshotLimits } from "./ai-snapshot-fixture.mjs";
import { createNetworkWaitFixtures, networkPageURL, networkAPIURL, networkButton, checkNetworkReady, checkNetworkMatching, checkNetworkLifecycle } from "./network-waits-fixture.mjs";
import { createNavigationWaitFixtures, navigationPageURL, navigationTargetURL, navigationButton, navigationWitness, checkNavigationDirectAndReady, checkNavigationLoadStates, checkNavigationLifecycle } from "./navigation-waits-fixture.mjs";
import { createDirectDownloadFixtures, directDownloadURL, directDownloadErrors, prepareDirectDownloadTab, verifyDownloadedFile, checkDirectDownloads, checkDirectDownloadLifecycle } from "./direct-downloads-fixture.mjs";
import { FocusLedger, assertQuietObserverSetup, currentWorkerVersion, focusArrays, focusObserverHTML, focusObserverSource, focusSnapshotExpression, installFocusObserver, readFocusEvidence } from "./focus-ledger.mjs";
import { browserStartupOptions, resolveFieldTrialConfig } from "./browser-startup.mjs";
import { NativeHostBridge, nativeAdapterSource } from "./native-host-bridge.mjs";
import { lifecycleRecoveryFixture, checkOwnedTabRevocation, checkNativeHostRestart } from "./lifecycle-recovery-fixture.mjs";
import { createFormWorkflowFixture, checkFormWorkflow, checkFormReceipt } from "./form-workflow-fixture.mjs";
import { createResearchWorkflowFixture, checkResearchReceipt } from "./research-workflow-fixture.mjs";
import { checkResearchWorkflow } from "./research-workflow-checks.mjs";
import { checkResearchTabDisposition } from "./research-workflow-evidence.mjs";
import { createBackgroundParallelFixture, checkBackgroundParallelWorkflow } from "./background-parallel-workflow.mjs";
import { createChooserWaitFixtures, prepareChooserFiles, checkChooserReady, checkChooserLifecycle, chooserExpired, chooserFrameEvidence } from "./chooser-waits-fixture.mjs";
import { checkChooserWireCaller, checkChooserCallerResult } from "./chooser-waits-callers.mjs";
import { checkChooserSubmission } from "./chooser-submission-fixture.mjs";
import { observeChooserCallerFailure, finishChooserCase } from "./chooser-failure-observation.mjs";
import { createDirectoryUploadFixtures, prepareDirectoryFiles, checkDirectoryUpload, checkInactiveDirectoryRejection, checkInactiveDirectoryCancellation } from "./directory-upload-fixture.mjs";
import { createBackgroundWindowRecorder, checkBackgroundWindowCleanup, checkBackgroundWindowOwnership } from "./background-window-fixture.mjs";
import { directoryWorldHTML, checkDirectoryWorld } from "./directory-world-fixture.mjs";
import { createDownloadWaitFixtures, startDownloadEvidence, checkDownloadReady, checkDownloadLifecycle, downloadExpired } from "./download-waits-fixture.mjs";
import { checkDownloadWireCaller, checkDownloadCallerResult } from "./download-waits-callers.mjs";
import { createOriginalDownloadFixtures } from "./original-download-fixture.mjs";
import { connectOriginalDownloadObserver } from "./original-download-observer.mjs";
import { checkOriginalDownloadProof, checkProductDownloadLifecycle } from "./original-download-proof.mjs";
import { runOriginalDownloadCaller, runOriginalDownloadProcess } from "./original-download-callers.mjs";
import { createOriginalDownloadNegativeFixtures } from "./original-download-negative-fixture.mjs";
import { createOriginalDownloadRelay } from "./original-download-relay.mjs";
import { checkOriginalDownloadNegatives } from "./original-download-negative-cases.mjs";
import { assertOriginalNegativeNetlog } from "./original-download-negative-netlog.mjs";
import { createSnapshotGeometryFixture, checkGeometryCaller, checkGeometryPhase, checkGeometryLimits, resolveGeometryDPR } from "./snapshot-geometry-fixture.mjs";
import { chooserDiagnosticMode, chooserDiagnosticCases, chooserPointerContextCases, chooserPointerContextKeys, chooserPointerGoContextKeys, chooserPointerAllContextKeys, chooserPointerAllContextArtifacts, chooserPointerAllContextSummary, createChooserDiagnostic, chooserPointerDiagnosticSummary, chooserPointerContextSummary, chooserPointerGoContextSummary } from "./chooser-ready-diagnostic.mjs";
import { mcpBindingEnabled, mcpBindingCases, createMCPBindingFixture, checkMCPConnectionBinding, checkMCPBindingSelection } from "./mcp-binding-fixture.mjs";
import { downloadDiagnosticEnabled, downloadDiagnosticCases, createDownloadDiagnostic } from "./download-ready-diagnostic.mjs";
import { goChooserDiagnosticEnabled, goChooserDiagnosticCases, summarizeGoChooserDiagnostic } from "./go-chooser-diagnostic-mode.mjs";
import { createGoChooserDiagnostic } from "./go-chooser-diagnostic.mjs";
import { runChooserProcess } from "./chooser-process.mjs";
import { screencastConcurrencyHTML, installScreencastConcurrencyProbe, checkScreencastConcurrency } from "./screencast-concurrency-fixture.mjs";
import { createPointerDeliveryFixtures, checkPointerDelivery, checkCountedPointerDelivery } from "./pointer-delivery-cases.mjs";
import { createTransformedPointerFixtures, checkTransformedPointer } from "./transformed-pointer-fixture.mjs";
import { createElementPositionFixtures, checkElementPosition } from "./element-position-fixture.mjs";
import { createDirectLocatorUploadFixtures, prepareDirectLocatorUploadFiles } from "./direct-locator-upload-fixture.mjs";
import { checkDirectLocatorUpload, checkDirectLocatorDirectory } from "./direct-locator-upload-callers.mjs";

// Playwright supplies the executable and the fixture's static YAML parser. No
// page/context connection is used: actions go through the public SDK and host.
const directory = path.dirname(fileURLToPath(import.meta.url));
// Reject unknown settings before filesystem setup, servers, or process launch.
const fieldTrialConfig = resolveFieldTrialConfig(process.env.OBU_TEST_FIELD_TRIAL_CONFIG);
const goChooserDiagnostic = goChooserDiagnosticEnabled(process.env);
const downloadDiagnostic = downloadDiagnosticEnabled(process.env);
const createdPageProof = process.env.OBU_TEST_CREATED_PAGES;
if (createdPageProof !== undefined && !["provenance", "ready", "five-entry", "unowned", "worker-restart"].includes(createdPageProof))
  throw new Error("OBU_TEST_CREATED_PAGES must be provenance, ready, five-entry, unowned, worker-restart or unset");
if (createdPageProof === "five-entry" && !process.env.OBU_TEST_GO_CREATED_PAGE_BINARY)
  throw new Error("Set OBU_TEST_GO_CREATED_PAGE_BINARY for five-entry created pages");
if (createdPageProof && ["OBU_TEST_ORIGINAL_DOWNLOADS", "OBU_TEST_MEMORY_CLIPBOARD", "OBU_TEST_DOWNLOAD_DIAGNOSTIC", "OBU_TEST_CHOOSER_DIAGNOSTIC", "OBU_TEST_GO_CHOOSER_DIAGNOSTIC", "OBU_TEST_MCP_BINDING", "OBU_TEST_SNAPSHOT_GEOMETRY", "OBU_TEST_BACKGROUND_PARALLEL", "OBU_TEST_CASES"].some(key => process.env[key] !== undefined))
  throw new Error("Created page provenance is a separate headed mode");
const originalDownloadBehavior = process.env.OBU_TEST_ORIGINAL_DOWNLOADS;
if (originalDownloadBehavior !== undefined && !["default", "allowAndName", "product", "five-entry", "auto-connect", "negative"].includes(originalDownloadBehavior))
  throw new Error("OBU_TEST_ORIGINAL_DOWNLOADS must be default, allowAndName, product, five-entry, auto-connect, negative, or unset");
const negativeDownloads = originalDownloadBehavior === "negative";
const autoConnectDownloads = originalDownloadBehavior === "auto-connect";
const fiveEntryDownloads = originalDownloadBehavior === "five-entry" || autoConnectDownloads;
const productDownloads = originalDownloadBehavior === "product" || fiveEntryDownloads || negativeDownloads;
const originalDownloadTestName = negativeDownloads ? "js-original-download-negative-lifecycle" : autoConnectDownloads ? "five-entry-original-download-auto-connect" : fiveEntryDownloads ? "five-entry-original-download-paths" : "js-original-download-native-proof";
if (fiveEntryDownloads && !process.env.OBU_TEST_GO_ORIGINAL_DOWNLOAD_BINARY)
  throw new Error("Set OBU_TEST_GO_ORIGINAL_DOWNLOAD_BINARY for five-entry original downloads");
if (originalDownloadBehavior && ["OBU_TEST_MEMORY_CLIPBOARD", "OBU_TEST_DOWNLOAD_DIAGNOSTIC", "OBU_TEST_CHOOSER_DIAGNOSTIC", "OBU_TEST_GO_CHOOSER_DIAGNOSTIC", "OBU_TEST_MCP_BINDING", "OBU_TEST_SNAPSHOT_GEOMETRY", "OBU_TEST_BACKGROUND_PARALLEL", "OBU_TEST_CASES"].some(key => process.env[key] !== undefined))
  throw new Error("Original download proof is a separate headed mode");
const mcpBinding = mcpBindingEnabled(process.env);
const chooserMode = chooserDiagnosticMode(process.env);
const chooserDiagnostic = chooserMode !== null;
const chooserAllPointers = chooserMode === "pointer-all-context";
const memoryClipboard = process.env.OBU_TEST_MEMORY_CLIPBOARD === "1";
if (process.env.OBU_TEST_BACKGROUND_PARALLEL !== undefined && process.env.OBU_TEST_BACKGROUND_PARALLEL !== "1")
  throw new Error("OBU_TEST_BACKGROUND_PARALLEL must be 1 or unset");
const backgroundParallel = process.env.OBU_TEST_BACKGROUND_PARALLEL === "1";
if (backgroundParallel && memoryClipboard) throw new Error("Background parallel acceptance requires the headed browser");
if (process.env.OBU_TEST_SNAPSHOT_GEOMETRY !== undefined && process.env.OBU_TEST_SNAPSHOT_GEOMETRY !== "1") throw new Error("OBU_TEST_SNAPSHOT_GEOMETRY must be 1 or unset");
const snapshotGeometry = process.env.OBU_TEST_SNAPSHOT_GEOMETRY === "1";
const geometryDPR = resolveGeometryDPR(process.env.OBU_TEST_GEOMETRY_DPR, snapshotGeometry);
if (snapshotGeometry && (backgroundParallel || memoryClipboard)) throw new Error("Snapshot geometry is a separate headed acceptance mode");
if (snapshotGeometry && !process.env.OBU_TEST_GO_GEOMETRY_BINARY) throw new Error("Set OBU_TEST_GO_GEOMETRY_BINARY for the five-entry geometry acceptance");
let memoryClipboardGuard;
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
const focusLedger = new FocusLedger();
const focusEvidence = { scope: "single test observer delivery history, after ready through final snapshot; fixture startup and teardown are outside agent coverage", setup: {} };
let focusObserver, observerBrowserControl, observerTargetId, observerSetupStarted = false;
async function readFocusLedger() {
  return readFocusEvidence(focusLedger, focusEvidence, () => {
    assert.ok(focusObserver, "Persistent focus observer is unavailable");
    return focusObserver.evaluate(focusSnapshotExpression);
  });
}
async function readWindowFocusState(label) {
  assert.ok(focusObserver, "Persistent focus observer is unavailable");
  // Read-only sampling in the independent observer. Preserve the full native
  // window/tab objects and ledger, with the async query interval made explicit.
  return focusObserver.evaluate(`(async()=>{const startedAt=Date.now();const windows=await chrome.windows.getAll({populate:true});const active=await chrome.tabs.query({active:true,windowId:${sentinel.windowId}});const ledger=${focusSnapshotExpression};return{label:${JSON.stringify(label)},startedAt,completedAt:Date.now(),windows,active,ledger}})()`);
}
const browserLog = [];
const negativeBrowserLifecycle = {};
let negativeBrowserClosed;
const createdPageBrowserLifecycle = {};
let createdPageBrowserClosed;
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
function pngDimensions(base64) {
  const bytes = Buffer.from(base64, "base64");
  assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  assert.equal(bytes.subarray(12, 16).toString(), "IHDR");
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  assert.ok(width > 0 && height > 0);
  return { bytes, width, height };
}
function subprocess(command, args, { input, timeoutMs = 30000, processEvidence, ...options } = {}) {
  return new Promise((resolve, reject) => {
    if (processEvidence) Object.assign(processEvidence, { startedAt: Date.now(), closeObserved: false });
    const process = spawn(command, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], ...options });
    if (processEvidence) processEvidence.pid = process.pid ?? null;
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { if (processEvidence) processEvidence.terminationRequestedAt = Date.now(); process.kill(); reject(new Error(`${command} exceeded test deadline`)); }, timeoutMs);
    process.stdout.setEncoding("utf8"); process.stderr.setEncoding("utf8");
    process.stdout.on("data", data => stdout += data);
    process.stderr.on("data", data => stderr += data);
    process.once("error", error => { if (processEvidence) processEvidence.spawnError = String(error); clearTimeout(timer); reject(error); });
    // Exit can precede the final pipe data. Close confirms both output streams
    // have drained, including a split UTF-8 sequence at the end of the response.
    process.once("close", (code, signal) => {
      if (processEvidence) Object.assign(processEvidence, { closeObserved: true, closedAt: Date.now(), exitCode: code, signal: signal ?? null });
      clearTimeout(timer); code === 0 ? resolve(stdout) : reject(new Error(`${command} exited ${code}: ${stderr}`));
    });
    process.stdin.end(input);
  });
}
async function hashTree(root, include = /\.(m?js|py|json)$/) {
  const files = {};
  async function visit(relative = "") {
    for (const item of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
      const name = path.join(relative, item.name);
      if (item.isDirectory() && item.name !== "__pycache__") await visit(name);
      else if (item.isFile() && include.test(name)) files[name.replaceAll(path.sep, "/")] = createHash("sha256").update(await fs.readFile(path.join(root, name))).digest("hex");
    }
  }
  await visit();
  return files;
}
async function withMCPClient(executable, endpoint, sessionId, use, processEvidence) {
  if (processEvidence) Object.assign(processEvidence, { startedAt: Date.now(), closeObserved: false });
  const child = spawn(path.resolve(executable), ["mcp", "--socket", endpoint, "--session-id", sessionId, "--timeout", "15s"], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  if (processEvidence) processEvidence.pid = child.pid ?? null;
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
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
    buffer += chunk;
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
  child.stderr.on("data", chunk => stderr += chunk);
  child.once("error", error => { if (processEvidence) processEvidence.spawnError = String(error); fail(error); });
  const closed = new Promise(resolve => child.once("close", (code, signal) => {
    if (processEvidence) Object.assign(processEvidence, { closeObserved: true, closedAt: Date.now(), exitCode: code, signal: signal ?? null });
    fail(new Error(`MCP exited ${code}: ${stderr}`)); resolve(code);
  }));
  try {
    const initialized = await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "obu-network-integration", version: "1.0.0" } });
    assert.equal(initialized.protocolVersion, "2025-06-18");
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    return await use(async (method, params) => {
      const response = await request("tools/call", { name: "call", arguments: { method, params } });
      assert.equal(response.isError, false, JSON.stringify(response));
      assert.equal(response.structuredContent.error, undefined, JSON.stringify(response));
      return response.structuredContent.result;
    }, (name, args) => request("tools/call", { name, arguments: args }));
  } finally {
    child.stdin.end();
    const code = await Promise.race([closed, delay(2000).then(() => "timeout")]);
    if (code === "timeout") { if (processEvidence) processEvidence.terminationRequestedAt = Date.now(); child.kill(); }
    fail(new Error("MCP fixture closed"));
  }
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
const pointerDeliveryFixtures = createPointerDeliveryFixtures();
const transformedPointerFixtures = createTransformedPointerFixtures();
const elementPositionFixtures = createElementPositionFixtures();
const boundingGeometryFixtures = createBoundingGeometryFixtures();
const dragCommitFixtures = createDragCommitFixtures();
const createdPageFixtures = createCreatedPageFixtures();
const sdkConnectionFixtures = createSDKConnectionFixtures();
const directUploads = createDirectLocatorUploadFixtures();
const directDownloads = createDirectDownloadFixtures();
const mediaDownloads = createMediaDownloadFixtures();
const embeddedMedia = createEmbeddedMediaFixtures();
const formWorkflows = createFormWorkflowFixture();
const researchWorkflows = createResearchWorkflowFixture();
const backgroundParallelFixture = createBackgroundParallelFixture();
const chooserFixtures = createChooserWaitFixtures({ pointerEvidence: chooserDiagnostic,
  ...(chooserAllPointers ? { pointerEvidenceKeys: chooserPointerAllContextKeys, pointerEvidenceNonEnumerable: true } :
    chooserMode === "pointer-context" ? { pointerEvidenceKeys: chooserPointerContextKeys } :
    chooserMode === "pointer-go-context" ? { pointerEvidenceKeys: chooserPointerGoContextKeys } : {}) });
const directoryUploads = createDirectoryUploadFixtures({ pointerEvidence: chooserAllPointers });
const downloadWaitFixtures = createDownloadWaitFixtures();
const originalDownloadFixtures = createOriginalDownloadFixtures();
const originalDownloadNegativeFixtures = createOriginalDownloadNegativeFixtures();
const snapshotGeometryFixtures = createSnapshotGeometryFixture();
const mcpBindingFixture = createMCPBindingFixture();
let httpPort, actionVisits = 0;
const http = createServer(async (request, response) => {
  if (createdPageProof && createdPageFixtures.handle(request, response)) return;
  if (originalDownloadFixtures.handle(request, response, `http://127.0.0.1:${httpPort}/`)) return;
  if (originalDownloadNegativeFixtures.handle(request, response)) return;
  if (pointerDeliveryFixtures.handle(request, response, new URL(request.url, `http://127.0.0.1:${httpPort}`))) return;
  if (transformedPointerFixtures.handle(request, response, new URL(request.url, `http://127.0.0.1:${httpPort}`))) return;
  if (elementPositionFixtures.handle(request, response, new URL(request.url, `http://127.0.0.1:${httpPort}`))) return;
  if (boundingGeometryFixtures.handle(request, response, new URL(request.url, `http://127.0.0.1:${httpPort}`))) return;
  if (dragCommitFixtures.handle(request, response, new URL(request.url, `http://127.0.0.1:${httpPort}`))) return;
  if (sdkConnectionFixtures.handle(request, response, new URL(request.url, `http://127.0.0.1:${httpPort}`))) return;
  if (directUploads.handle(request, response, httpPort)) return;
  if (networkFixtures.handle(request, response, httpPort)) return;
  if (navigationFixtures.handle(request, response)) return;
  if (directDownloads.handle(request, response)) return;
  if (mediaDownloads.handle(request, response, httpPort)) return;
  if (embeddedMedia.handle(request, response, httpPort)) return;
  if (formWorkflows.handle(request, response, httpPort)) return;
  if (researchWorkflows.handle(request, response, httpPort)) return;
  if (backgroundParallelFixture.handle(request, response, httpPort)) return;
  if (chooserFixtures.handle(request, response, httpPort)) return;
  if (directoryUploads.handle(request, response, httpPort)) return;
  if (downloadWaitFixtures.handle(request, response, httpPort)) return;
  if (snapshotGeometryFixtures.handle(request, response, httpPort)) return;
  if (mcpBinding && mcpBindingFixture.handle(request, response)) return;
  const route = new URL(request.url, "http://localhost").pathname;
  if (route === "/screencast-concurrency") {
    const nonce = new URL(request.url, "http://localhost").searchParams.get("nonce");
    if (!/^[a-f0-9]{8}$/.test(nonce ?? "")) { response.writeHead(400); response.end("Invalid fixture nonce"); return; }
    response.setHeader("Content-Type", "text/html; charset=utf-8"); response.setHeader("Cache-Control", "no-store"); response.end(screencastConcurrencyHTML(nonce)); return;
  }
  if (route === "/directory-world") { response.setHeader("Content-Type", "text/html; charset=utf-8"); response.end(directoryWorldHTML); return; }
  if (route === "/lifecycle-recovery") { response.setHeader("Content-Type", "text/html; charset=utf-8"); response.end(lifecycleRecoveryFixture()); return; }
  if (route === "/clipboard") {
    const fixture = clipboardFixture();
    response.setHeader("Content-Type", fixture.type); response.end(fixture.body); return;
  }
  if (route === "/page-exports" || route.startsWith("/page-exports/")) {
    const fixture = pageExportFixture(route, httpPort);
    response.setHeader("Content-Type", fixture.type); response.end(fixture.body); return;
  }
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
let nativeBridge, chrome, worker, browser, sentinel, activeEvents = [], windowFocusEvents = [];
try {
  await build({ entryPoints: [path.join(directory, "react-app.jsx")], outfile: path.join(runDir, "fixture.js"), bundle: true, format: "iife", platform: "browser" });
  httpPort = await listenFixture(http);
  if (!ws.address()) await new Promise(resolve => ws.once("listening", resolve));
  const websocketURL = `ws://127.0.0.1:${ws.address().port}`;
  await buildChromeExtension(extension);
  const productionExtensionHashes = await hashTree(extension);
  const backgroundFile = path.join(extension, "background.js");
  const background = await fs.readFile(backgroundFile, "utf8");
  const nativeCall = "chrome.runtime.connectNative(this.hostName)";
  assert.equal(background.split(nativeCall).length, 2, "Production connectNative call changed");
  // The optional clipboard fixture can hold an actual scope check. Expose the
  // instance only in this isolated staged build, never in a production package.
  const clipboardTestHook = memoryClipboard ? "\nglobalThis.__integrationClipboardBackend = backend;\n" : "";
  const createdPageTestHook = ["unowned", "worker-restart"].includes(createdPageProof) ? "\nglobalThis.__integrationBackend = backend;\n" : "";
  // Preserve the original release failure before a subsequent Pause clears it.
  // This staged-only observer returns the exact production promise and does
  // not change synchronous ordering, admission, or cleanup outcomes.
  const recoveryAuditHook = `\n{
    globalThis.__integrationReleaseFailures=[];
    const pause=backend.pauseAutomation;
    backend.pauseAutomation=function(...args){
      if(this.pauseReleaseFailures.size&&__integrationReleaseFailures.length<64)
        __integrationReleaseFailures.push({at:Date.now(),failures:[...this.pauseReleaseFailures].map(([tabId,error])=>({tabId,error:error.stack??String(error)}))});
      return pause.apply(this,args);
    };
  }\n`;
  await fs.writeFile(backgroundFile, nativeAdapterSource(websocketURL) + background.replace(nativeCall, "__integrationConnectNative(this.hostName)") + clipboardTestHook + recoveryAuditHook + createdPageTestHook);
  const manifestFile = path.join(extension, "manifest.json");
  const manifest = JSON.parse(await fs.readFile(manifestFile, "utf8"));
  manifest.content_security_policy.extension_pages = manifest.content_security_policy.extension_pages.replace("connect-src 'self'", `connect-src 'self' ${websocketURL}`);
  await fs.writeFile(manifestFile, JSON.stringify(manifest, null, 2));
  // A single staged-only document survives every worker restart. It is never
  // packaged in the production extension or controlled through the SDK.
  await fs.writeFile(path.join(extension, "integration-observer.html"), focusObserverHTML);
  await fs.writeFile(path.join(extension, "integration-observer.js"), focusObserverSource);
  const pythonSnapshot = path.join(runDir, "python-sdk/open_browser_use");
  await fs.mkdir(pythonSnapshot, { recursive: true });
  for (const file of await fs.readdir(path.join(repo, "packages/open-browser-use-python/open_browser_use"))) {
    if (file.endsWith(".py")) await fs.copyFile(path.join(repo, "packages/open-browser-use-python/open_browser_use", file), path.join(pythonSnapshot, file));
  }
  sourceIdentity = {
    testHooks: ["staged-only persistent activation/focus observer document", "staged-only observer of original release failures before Pause", "research cases: bounded passive tabs.onCreated/onRemoved listeners in the independent observer; no task page or production changes", "chooser fixtures: failure-only current loopback document observation with exact native document IDs and one separate 3-second budget; no success-path calls/listeners, input replay, attachment or deadline extension", "chooser CLI/MCP/Python callers: local partial stage and click-ACK records preserve original errors and separate cleanup errors; parent CLI/MCP/Python/Go failure reads require confirmed child process close plus exact ordered caller/tab/key identity before any browser read; no new success-path browser requests", ...(memoryClipboard ? ["staged-only backend reference for clipboard lifecycle fault injection"] : [])],
    gitHead: (await subprocess("git", ["rev-parse", "HEAD"], { cwd: repo })).trim(),
    dirty: (await subprocess("git", ["status", "--porcelain", "--untracked-files=normal"], { cwd: repo })).trim().length > 0,
    sha256: {
      nativeHost: createHash("sha256").update(await fs.readFile(executable)).digest("hex"),
      productionExtension: productionExtensionHashes,
      stagedExtension: await hashTree(extension),
      jsDist: await hashTree(jsSnapshot),
      pythonSDK: await hashTree(pythonSnapshot),
      goSDK: await hashTree(path.join(repo, "packages/open-browser-use-go"), /\.go$/),
      pythonChecks: createHash("sha256").update(await fs.readFile(pythonChecks)).digest("hex"),
      harness: createHash("sha256").update(await fs.readFile(fileURLToPath(import.meta.url))).digest("hex")
    }
  };
  if (chooserAllPointers) sourceIdentity.testHooks.push("chooser pointer-all-context diagnostic: original 13-case order; passive pointer/mouse HTML for exactly 18 chooser keys and this run's three registered directory-upload keys; six other context cases explicitly uninstrumented; chooser ledger is non-enumerable so existing submission success reads retain original data; no new success browser request, input retry, native wrapper or deadline change; failure-only exact documentId read within original 3-second budget, external callers require actual close; recorder may affect scheduling");
  if (createdPageProof) {
    if (createdPageProof === "worker-restart") sourceIdentity.testHooks.push("created page worker restart: three natural unowned root children in matched/collected/ended-idle states; original adoption and pre/post-worker native control/RPC observers; persistent session-storage onChanged observer; real ServiceWorker stop/start, same host and explicit client beginTurn. Existing focus failures are retained through lifecycle observation and fail the final unchanged ledger gate; no added focus allowance, child replacement or input replay");
    else
    sourceIdentity.testHooks.push(createdPageProof === "unowned" ? "created page unowned: staged backend reference and bounded passive original adoption/tabs.get/storage/auxiliary ACK observers; natural public backgroundWindow sources, exact creation and finalization successor activation allowances; matched cancellation and collected finalization; no synthetic child, ungrouping, explicit claim, focus restoration or replay" : createdPageProof === "five-entry" ? "created page five-entry: JS/Python/Go/CLI/MCP, two all-caller barriers, bounded passive native event and actual native RPC observers; same original workflow deadline; no synthetic child, explicit claim, focus restoration or replay" : createdPageProof === "ready" ? "created page readiness: public JS expectPage and result Tab, passive native event observer independently verifies exact original child identity; original Control-click, no synthesized child, explicit claim, focus restoration or replay" : "created page provenance: bounded passive webNavigation.onCreatedNavigationTarget observer, exact source and child document observations; original public Control-click and explicit claimUserTab, no product ready/collect API, synthesized child creation, focus restoration or input replay");
    for (const name of ["created-page-fixture.mjs", "created-page-provenance.mjs"])
      sourceIdentity.sha256[name] = createHash("sha256").update(await fs.readFile(path.join(directory, name))).digest("hex");
  }
  sourceIdentity.sha256.fixtureListener = createHash("sha256").update(await fs.readFile(path.join(directory, "fixture-listener.mjs"))).digest("hex");
  sourceIdentity.sha256.actionsFixture = createHash("sha256").update(await fs.readFile(path.join(directory, "actions-fixture.mjs"))).digest("hex");
  sourceIdentity.sha256.dragCommitFixture = createHash("sha256").update(await fs.readFile(path.join(directory, "drag-commit-fixture.mjs"))).digest("hex");
  for (const name of ["sdk-connection-fixture.mjs", "sdk-connection-js.mjs", "sdk-connection-python.py", "go-sdk-connection-checks/main.go"])
    sourceIdentity.sha256[name] = createHash("sha256").update(await fs.readFile(path.join(directory, name))).digest("hex");
  sourceIdentity.sha256.pointerDeliveryFixture = createHash("sha256").update(await fs.readFile(path.join(directory, "pointer-delivery-cases.mjs"))).digest("hex");
  sourceIdentity.sha256.transformedPointerFixture = createHash("sha256").update(await fs.readFile(path.join(directory, "transformed-pointer-fixture.mjs"))).digest("hex");
  sourceIdentity.sha256.elementPositionFixture = createHash("sha256").update(await fs.readFile(path.join(directory, "element-position-fixture.mjs"))).digest("hex");
  for (const name of ["build-chrome-extension.mjs", "patch-frame-geometry.mjs", "patch-pointer-delivery.mjs", "patch-drag-delivery.mjs"]) sourceIdentity.sha256[name] = createHash("sha256").update(await fs.readFile(path.join(directory, "..", name))).digest("hex");
  for (const name of ["direct-locator-upload-fixture.mjs", "direct-locator-upload-callers.mjs", "direct-locator-upload-native.mjs", "direct-locator-upload-checks.py", "go-direct-locator-upload-checks/main.go"]) sourceIdentity.sha256[name] = createHash("sha256").update(await fs.readFile(path.join(directory, name))).digest("hex");
  sourceIdentity.sha256.focusLedger = createHash("sha256").update(await fs.readFile(path.join(directory, "focus-ledger.mjs"))).digest("hex");
  sourceIdentity.sha256.nativeHostBridge = createHash("sha256").update(await fs.readFile(path.join(directory, "native-host-bridge.mjs"))).digest("hex");
  sourceIdentity.sha256.lifecycleRecoveryFixture = createHash("sha256").update(await fs.readFile(path.join(directory, "lifecycle-recovery-fixture.mjs"))).digest("hex");
  for (const name of ["chooser-waits-fixture.mjs", "chooser-submission-fixture.mjs", "chooser-failure-observation.mjs", "directory-upload-fixture.mjs", "directory-world-fixture.mjs", "background-window-fixture.mjs", "chooser-waits-callers.mjs", "chooser-waits-checks.py", "go-chooser-waits-checks/main.go"]) sourceIdentity.sha256[name] = createHash("sha256").update(await fs.readFile(path.join(directory, name))).digest("hex");
  for (const file of (await fs.readdir(path.join(directory, "go-chooser-waits-checks"))).filter(name => name.endsWith(".go")).sort()) {
    const name = `go-chooser-waits-checks/${file}`;
    sourceIdentity.sha256[name] = createHash("sha256").update(await fs.readFile(path.join(directory, name))).digest("hex");
  }
  for (const name of ["download-waits-fixture.mjs", "download-waits-callers.mjs", "download-waits-checks.py", "go-download-waits-checks/main.go"]) sourceIdentity.sha256[name] = createHash("sha256").update(await fs.readFile(path.join(directory, name))).digest("hex");
  sourceIdentity.sha256.browserStartup = createHash("sha256").update(await fs.readFile(path.join(directory, "browser-startup.mjs"))).digest("hex");
  sourceIdentity.sha256.focusObserverHTML = createHash("sha256").update(focusObserverHTML).digest("hex");
  sourceIdentity.sha256.diagnosticsFixture = createHash("sha256").update(await fs.readFile(path.join(directory, "diagnostics-fixture.mjs"))).digest("hex");
  sourceIdentity.sha256.pauseFixture = createHash("sha256").update(await fs.readFile(path.join(directory, "pause-fixture.mjs"))).digest("hex");
  sourceIdentity.sha256.siteAccessFixture = createHash("sha256").update(await fs.readFile(path.join(directory, "site-access-fixture.mjs"))).digest("hex");
  sourceIdentity.sha256.pageExportsFixture = createHash("sha256").update(await fs.readFile(path.join(directory, "page-exports-fixture.mjs"))).digest("hex");
  sourceIdentity.sha256.clipboardFixture = createHash("sha256").update(await fs.readFile(path.join(directory, "clipboard-fixture.mjs"))).digest("hex");
  sourceIdentity.sha256.memoryClipboardGuard = createHash("sha256").update(await fs.readFile(path.join(directory, "memory-clipboard.mjs"))).digest("hex");
  sourceIdentity.sha256.clipboardCallers = createHash("sha256").update(await fs.readFile(path.join(directory, "clipboard-callers.mjs"))).digest("hex");
  sourceIdentity.sha256.elementScreenshotFixture = createHash("sha256").update(await fs.readFile(path.join(directory, "element-screenshot-fixture.mjs"))).digest("hex");
  sourceIdentity.sha256.boundingGeometryFixture = createHash("sha256").update(await fs.readFile(path.join(directory, "bounding-geometry-fixture.mjs"))).digest("hex");
  sourceIdentity.sha256.popupFixture = createHash("sha256").update(await fs.readFile(path.join(directory, "popup-fixture.mjs"))).digest("hex");
  sourceIdentity.sha256.aiSnapshotFixture = createHash("sha256").update(await fs.readFile(path.join(directory, "ai-snapshot-fixture.mjs"))).digest("hex");
  sourceIdentity.sha256.snapshotGeometryFixture = createHash("sha256").update(await fs.readFile(path.join(directory, "snapshot-geometry-fixture.mjs"))).digest("hex");
  if (chooserDiagnostic) sourceIdentity.sha256.chooserDiagnostic = createHash("sha256").update(await fs.readFile(path.join(directory, "chooser-ready-diagnostic.mjs"))).digest("hex");
  if (goChooserDiagnostic) for (const name of ["go-chooser-diagnostic-mode.mjs", "go-chooser-diagnostic.mjs", "chooser-process.mjs", "chooser-ready-diagnostic.mjs", "download-ready-diagnostic.mjs"])
    sourceIdentity.sha256[name] = createHash("sha256").update(await fs.readFile(path.join(directory, name))).digest("hex");
  if (mcpBinding) sourceIdentity.sha256.mcpBindingFixture = createHash("sha256").update(await fs.readFile(path.join(directory, "mcp-binding-fixture.mjs"))).digest("hex");
  if (downloadDiagnostic) {
    sourceIdentity.sha256.downloadDiagnostic = createHash("sha256").update(await fs.readFile(path.join(directory, "download-ready-diagnostic.mjs"))).digest("hex");
    sourceIdentity.sha256.sharedNativeDiagnostic = createHash("sha256").update(await fs.readFile(path.join(directory, "chooser-ready-diagnostic.mjs"))).digest("hex");
  }
  if (snapshotGeometry) for (const name of ["snapshot-geometry-checks.py", "go-snapshot-geometry-checks/main.go"]) sourceIdentity.sha256[name] = createHash("sha256").update(await fs.readFile(path.join(directory, name))).digest("hex");
  if (originalDownloadBehavior) for (const name of ["original-download-fixture.mjs", "original-download-observer.mjs", "original-download-proof.mjs"])
    sourceIdentity.sha256[name] = createHash("sha256").update(await fs.readFile(path.join(directory, name))).digest("hex");
  if (negativeDownloads) for (const name of ["original-download-negative-fixture.mjs", "original-download-negative-cases.mjs", "original-download-relay.mjs", "original-download-callers.mjs", "original-download-negative-netlog.mjs"])
    sourceIdentity.sha256[name] = createHash("sha256").update(await fs.readFile(path.join(directory, name))).digest("hex");
  sourceIdentity.sha256.networkWaitsFixture = createHash("sha256").update(await fs.readFile(path.join(directory, "network-waits-fixture.mjs"))).digest("hex");
  sourceIdentity.sha256.navigationWaitsFixture = createHash("sha256").update(await fs.readFile(path.join(directory, "navigation-waits-fixture.mjs"))).digest("hex");
  sourceIdentity.sha256.directDownloadsFixture = createHash("sha256").update(await fs.readFile(path.join(directory, "direct-downloads-fixture.mjs"))).digest("hex");
  sourceIdentity.sha256.mediaDownloadsFixture = createHash("sha256").update(await fs.readFile(path.join(directory, "media-downloads-fixture.mjs"))).digest("hex");
  sourceIdentity.sha256.mediaEmbeddedFixture = createHash("sha256").update(await fs.readFile(path.join(directory, "media-embedded-fixture.mjs"))).digest("hex");
  sourceIdentity.sha256.mediaFixtureAssets = createHash("sha256").update(await fs.readFile(path.join(directory, "media-fixture-assets.mjs"))).digest("hex");
  sourceIdentity.mediaAssets = mediaAssetIdentity;
  sourceIdentity.sha256.mediaLifecycleFixture = createHash("sha256").update(await fs.readFile(path.join(directory, "media-lifecycle-fixture.mjs"))).digest("hex");
  sourceIdentity.sha256.mediaContentLifecycleFixture = createHash("sha256").update(await fs.readFile(path.join(directory, "media-content-lifecycle-fixture.mjs"))).digest("hex");
  sourceIdentity.sha256.mediaReferenceFixture = createHash("sha256").update(await fs.readFile(path.join(directory, "media-reference-fixture.mjs"))).digest("hex");
  sourceIdentity.sha256.formWorkflowFixture = createHash("sha256").update(await fs.readFile(path.join(directory, "form-workflow-fixture.mjs"))).digest("hex");
  sourceIdentity.sha256.formWorkflowPython = createHash("sha256").update(await fs.readFile(path.join(directory, "form-workflow-checks.py"))).digest("hex");
  sourceIdentity.sha256.formWorkflowGo = createHash("sha256").update(await fs.readFile(path.join(directory, "go-form-workflow-checks/main.go"))).digest("hex");
  for (const name of ["research-workflow-fixture.mjs", "research-workflow-checks.mjs", "research-workflow-evidence.mjs", "research-workflow-checks.py", "go-research-workflow-checks/main.go"]) {
    sourceIdentity.sha256[name] = createHash("sha256").update(await fs.readFile(path.join(directory, name))).digest("hex");
  }
  sourceIdentity.sha256.backgroundParallelWorkflow = createHash("sha256").update(await fs.readFile(path.join(directory, "background-parallel-workflow.mjs"))).digest("hex");
  sourceIdentity.sha256.screencastConcurrencyFixture = createHash("sha256").update(await fs.readFile(path.join(directory, "screencast-concurrency-fixture.mjs"))).digest("hex");
  sourceIdentity.sha256.screencastConcurrencyProbe = createHash("sha256").update(installScreencastConcurrencyProbe.toString()).digest("hex");
  if (goExecutable) sourceIdentity.sha256.goClient = createHash("sha256").update(await fs.readFile(goExecutable)).digest("hex");

  nativeBridge = new NativeHostBridge({ server: ws, executable, socketDir, stats: nativeFrameStats,
    log: text => hostLog.push(text), onFailure: failNativeBridge });
  let { endpoint } = await nativeBridge.start();
  const chromiumBinary = process.env.OBU_TEST_CHROMIUM_BINARY || chromium.executablePath();
  await fs.access(chromiumBinary);
  await fs.mkdir(path.join(profile, "Default"), { recursive: true });
  await fs.mkdir(path.join(runDir, "downloads"));
  await fs.writeFile(path.join(profile, "Default", "Preferences"), JSON.stringify({ download: { default_directory: path.join(runDir, "downloads"), prompt_for_download: false } }));
  const startup = browserStartupOptions([
    ...(memoryClipboard ? ["--headless=new", "--enable-automation", "--disable-background-networking", "--disable-component-update"] : []),
    ...(snapshotGeometry ? [`--force-device-scale-factor=${geometryDPR}`] : []),
    ...(negativeDownloads ? [`--log-net-log=${path.join(runDir, "original-download-negative-netlog.json")}`] : []),
    `--user-data-dir=${profile}`, "--remote-debugging-port=0", `--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
    "--no-first-run", "--no-default-browser-check", "--site-per-process", "--no-sandbox", "--enable-logging=stderr", "about:blank"
  ], fieldTrialConfig);
  await fs.writeFile(path.join(runDir, "browser-startup.json"), JSON.stringify({
    ...startup,
    ...(snapshotGeometry ? { expectedGeometryDPR: geometryDPR } : {}),
    binary: path.resolve(chromiumBinary),
    binarySha256: createHash("sha256").update(await fs.readFile(chromiumBinary)).digest("hex")
  }, null, 2));
  chrome = spawn(chromiumBinary, startup.args, { windowsHide: startup.windowsHide, stdio: ["ignore", "ignore", "pipe"] });
  if (negativeDownloads) negativeBrowserClosed = new Promise(resolve => chrome.once("close", (code, signal) => {
    Object.assign(negativeBrowserLifecycle, { closeObserved: true, closedAt: Date.now(), code, signal }); resolve();
  }));
  if (createdPageProof) createdPageBrowserClosed = new Promise(resolve => chrome.once("close", (code, signal) => {
    Object.assign(createdPageBrowserLifecycle, { closeObserved: true, closedAt: Date.now(), code, signal }); resolve();
  }));
  chrome.stderr.on("data", data => browserLog.push(data.toString()));
  chrome.on("exit", (code, signal) => browserLog.push(`Browser exited: ${code} ${signal}\n`));
  const debugPort = await until(async () => (await fs.readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0], "Chromium debug port");
  if (memoryClipboard) {
    const nativeInfo = await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json();
    const connection = await workerConnection(nativeInfo.webSocketDebuggerUrl);
    try { memoryClipboardGuard = await verifyMemoryClipboard(connection, chromiumBinary); }
    finally { connection.close(); }
    await fs.writeFile(path.join(runDir,"memory-clipboard-guard.json"),JSON.stringify(memoryClipboardGuard,null,2));
    await fs.writeFile(path.join(runDir,"clipboard-input.png"),clipboardPNG());
  }
  await nativeBridge.waitForConnection();
  const extensionId = nativeBridge.extensionId;
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
  await worker.evaluate(`globalThis.__integrationFrames=[];chrome.debugger.onEvent.addListener((source,method,params)=>{if(method==='Target.attachedToTarget'&&params?.targetInfo?.type==='iframe')globalThis.__integrationFrames.push({tabId:source.tabId,source,sessionId:params.sessionId,targetId:params.targetInfo.targetId,type:params.targetInfo.type,url:params.targetInfo.url});})`);
  observerSetupStarted = true;
  await worker.evaluate(`(${installFocusObserver.toString()})(chrome,globalThis,'setup-worker');`);
  focusEvidence.setup.before = await worker.evaluate(focusSnapshotExpression);
  const observerURL = `chrome-extension://${extensionId}/integration-observer.html`;
  const browserVersion = await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json();
  observerBrowserControl = await workerConnection(browserVersion.webSocketDebuggerUrl);
  observerTargetId = (await observerBrowserControl.call("Target.createTarget", { url: observerURL, background: true })).targetId;
  focusEvidence.targetId = observerTargetId;
  const observerTarget = await until(async () => (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()).find(target => target.id === observerTargetId), "persistent focus observer target");
  focusObserver = await workerConnection(observerTarget.webSocketDebuggerUrl);
  await until(() => focusObserver.evaluate(`location.href===${JSON.stringify(observerURL)}&&globalThis.__integrationFocusLedger?.snapshot().ready===true`), "persistent focus observer ready");
  focusEvidence.setup.observer = await readFocusLedger();
  focusEvidence.setup.worker = await worker.evaluate(focusSnapshotExpression);
  assertQuietObserverSetup(focusEvidence.setup.worker, focusEvidence.setup.observer);
  // Both observed setup segments must be quiet. They are not merged and do not
  // establish atomic cross-context coverage before the observer was ready.
  focusEvidence.readyAt = Date.now();
  focusEvidence.initialState = await readWindowFocusState("observer-ready-before-first-case");
  await readFocusEvidence(focusLedger, focusEvidence, async () => focusEvidence.initialState.ledger);
  await fs.writeFile(path.join(runDir, "focus-initial-state.json"), JSON.stringify(focusEvidence.initialState, null, 2));
  const fixtureURL = `http://127.0.0.1:${httpPort}/`;
  console.log("HARNESS", JSON.stringify({ endpoint, fixtureURL, runDir, sentinelId: sentinel.id }));
  browser = await connectOpenBrowserUse({ socketPath: endpoint, sessionId: "js-browser-integration", turnId: "acceptance", timeoutMs: 15000 });
  const tab = await browser.newTab();
  async function activeInvariant() {
    const active = await focusObserver.evaluate(`chrome.tabs.query({active:true,windowId:${sentinel.windowId}})`);
    assert.equal(active[0]?.id, sentinel.id, "Agent action changed the active tab");
    focusLedger.assertAllowed(await readFocusLedger(), allowedPopupActivations, allowedWindowFocusEvents);
  }
  async function createFixtureWindow(url, type) {
    const before = await readFocusLedger();
    focusLedger.assertAllowed(before, allowedPopupActivations, allowedWindowFocusEvents);
    const popup = await worker.evaluate(`chrome.windows.create({url:${JSON.stringify(url)},type:${JSON.stringify(type)},focused:false,width:520,height:480})`);
    const after = await readFocusLedger();
    assert.equal(popup.type, type); assert.equal(popup.focused, false); assert.equal(popup.tabs.length, 1);
    allowedPopupActivations.push(...focusLedger.allowPopupCreation(before, after, { tabId: popup.tabs[0].id, windowId: popup.id, url, fixture: new URL(url).searchParams.get("auxiliary"), reason: `sole tab created in an unfocused ${type} window` }));
    return popup;
  }
  const createAuxiliaryPopup = url => createFixtureWindow(url, "popup");
  const closeAuxiliaryPopup = id => worker.evaluate(`chrome.windows.remove(${id}).catch(error=>{if(!/No window|Invalid window/i.test(String(error)))throw error})`);
  const readBackgroundWindowState = () => worker.evaluate(`(async()=>{const requestedAt=Date.now();const [tabs,windows,targets]=await Promise.all([chrome.tabs.query({}),chrome.windows.getAll({populate:false}),chrome.debugger.getTargets()]);return{requestedAt,completedAt:Date.now(),tabs,windows,targets}})()`);
  const backgroundWindowRecorder = owner => createBackgroundWindowRecorder({ browser: owner, readNative: readBackgroundWindowState, readFocus: readFocusLedger, focusLedger, allowedActivations: allowedPopupActivations, allowedFocus: allowedWindowFocusEvents });
  async function test(name, run) {
    if (bridgeFailure) throw bridgeFailure;
    if (createdPageProof && !["js-raw-navigation-before-engine", "js-created-page-provenance", "js-created-page-ready", "five-entry-created-page-ready", "js-created-page-unowned"].includes(name)) return;
    if (originalDownloadBehavior && name !== "js-raw-navigation-before-engine" && name !== originalDownloadTestName) return;
    if (goChooserDiagnostic && !goChooserDiagnosticCases.includes(name)) return;
    if (downloadDiagnostic && !downloadDiagnosticCases.includes(name)) return;
    if (mcpBinding && !mcpBindingCases.includes(name)) return;
    if (chooserDiagnostic && !(["pointer-context", "pointer-go-context", "pointer-all-context"].includes(chooserMode) ? chooserPointerContextCases : chooserDiagnosticCases).includes(name)) return;
    if (snapshotGeometry && name !== "js-raw-navigation-before-engine" && !name.includes("snapshot-geometry") && !name.startsWith("js-ai-snapshot-")) return;
    if (process.env.OBU_TEST_CASES && name !== "js-raw-navigation-before-engine" && !new RegExp(process.env.OBU_TEST_CASES).test(name)) return;
    const start = Date.now();
    let detail, failure;
    try { detail = await run(); } catch (error) { failure = error; }
    try { await activeInvariant(); } catch (error) { failure = failure ? new AggregateError([failure, error], `${failure.message}; ${error.message}`) : error; }
    if (failure) {
      let recovery;
      try { recovery = await worker.evaluate("(async()=>({failures:globalThis.__integrationReleaseFailures??[],automation:await chrome.storage.local.get('OPEN_BROWSER_USE_AUTOMATION_CONTROL')}))()"); }
      catch (error) { recovery = { observationError: error.message }; }
      records.push({ name, passed: false, elapsedMs: Date.now() - start, error: failure.stack, recovery }); console.error("FAIL", name, failure.message);
    }
    else { records.push({ name, passed: true, elapsedMs: Date.now() - start, detail }); console.log("PASS", name); }
  }
  if (negativeDownloads) await test(originalDownloadTestName, async () => {
    const owners = [], relays = [], detail = { boundary: "Production JS negative checks on an isolated launch-flag Chromium; transparent Browser WebSocket fault injection, not natural network loss", bindings: [] };
    let failure;
    const connectionState = () => ({ hostPid: nativeBridge.host.pid, endpoint,
      hostGeneration: nativeBridge.current.record.generation,
      nativePortConnections: nativeBridge.current.record.connections.length,
      nativePortConnectedAt: nativeBridge.current.record.connections.at(-1)?.connectedAt,
      extensionId: nativeBridge.extensionId, nativeSocketReadyState: nativeBridge.socket.readyState,
      hostExitCode: nativeBridge.host.exitCode });
    try {
      const url = new URL(browserVersion.webSocketDebuggerUrl);
      const activePort = (await fs.readFile(path.join(profile, "DevToolsActivePort"), "utf8")).trim().split(/\r?\n/);
      assert.equal(url.port, activePort[0]); assert.equal(url.pathname, activePort[1]);
      const targets = await observerBrowserControl.call("Target.getTargets", {});
      const matchingWorkers = targets.targetInfos.filter(target => target.type === "service_worker" && target.url === `chrome-extension://${extensionId}/background.js`);
      assert.equal(matchingWorkers.length, 1);
      assert.equal(await worker.evaluate("chrome.runtime.id"), extensionId);
      detail.identity = { pid: chrome.pid, profile, activePort, browserVersion, extensionId, worker: matchingWorkers[0], targets };
      const bind = async () => {
        const relay = await createOriginalDownloadRelay({ targetURL: url.href }); relays.push(relay);
        const record = { startedAt: Date.now(), relayURL: relay.url, capabilities: { before: await browser.client.getInfo() }, bindingProcess: {} };
        detail.bindings.push(record);
        assert.equal(record.capabilities.before.metadata.pageDownloads.available, false);
        record.binding = JSON.parse(await runOriginalDownloadProcess({ command: executable,
          args: ["bind-browser", "--socket", endpoint, "--cdp-url", relay.url, "--exclusive", "--timeout", "20s"],
          detail: record.bindingProcess, timeoutMs: 25000 }));
        assert.equal(record.bindingProcess.closeObserved, true); assert.equal(record.bindingProcess.exitCode, 0);
        assert.equal(record.binding.result.bound, true);
        record.capabilities.after = await browser.client.getInfo();
        assert.equal(record.capabilities.after.metadata.pageDownloads.available, true);
        assert.equal(record.capabilities.after.metadata.pageDownloads.generation, record.binding.result.generation);
        record.proof = await worker.evaluate("globalThis.__obuNativeDownloadBinding");
        for (const key of ["extensionId", "extensionInstanceId", "workerBootId", "portId"]) assert.equal(record.proof[key], record.binding.result[key]);
        record.completedAt = Date.now();
        return { relay, ...record };
      };
      const initial = await bind();
      for (const sessionId of ["original-negative-owner", "original-negative-foreign"])
        owners.push(await connectOpenBrowserUse({ socketPath: endpoint, sessionId, turnId: "negative-proof", timeoutMs: 20000 }));
      sourceIdentity.testHooks.push("original negative downloads: bounded transparent Browser WebSocket message relay; exact real transport terminated only after original private path submission; no altered CDP response, inferred GUID/path, automatic rebind or native-port restart; independent CDP actor only on the exact synthetic unowned tab, with emulated focus and a real first screencast frame/ACK before its unique input sequence; no OS focus or input retry");
      detail.checks = {};
      await checkOriginalDownloadNegatives({ owner: owners[0], foreign: owners[1], worker,
        fixture: originalDownloadNegativeFixtures, fixtureURL, downloadRoot: path.join(runDir, "downloads"), until,
        browserURL: url.href, relay: initial.relay, connectionState, rebind: bind, detail: detail.checks });
    } catch (error) {
      failure = error; detail.error = error.stack;
      if (error.originalDownloadNegativeDetail) detail.checks = error.originalDownloadNegativeDetail;
    } finally {
      detail.ownerCleanup = [];
      for (const owner of owners) {
        try { detail.ownerCleanup.push(await owner.client.finalizeTabs([])); }
        catch (error) { detail.ownerCleanup.push({ error: error.stack }); failure ??= error; }
        finally { owner.close(); }
      }
      for (const relay of relays) try { await relay.close(); }
      catch (error) { (detail.relayCleanupErrors ??= []).push(error.stack); failure ??= error; }
      detail.relays = relays.map(relay => relay.snapshot());
      detail.server = originalDownloadNegativeFixtures.allStats();
      await fs.writeFile(path.join(runDir, "original-download-negative.json"), JSON.stringify(detail, null, 2));
    }
    if (failure) throw failure;
    return { evidence: "original-download-negative.json", bindingAttempts: detail.bindings.length };
  });
  if (originalDownloadBehavior && !negativeDownloads) await test(originalDownloadTestName, async () => {
    const owners = [], detail = { boundary: productDownloads ? "Production CLI binding and SDK original paths" : "Native transport feasibility proof, not a public path implementation" };
    let native, failure;
    try {
      const activePort = (await fs.readFile(path.join(profile, "DevToolsActivePort"), "utf8")).trim().split(/\r?\n/);
      const url = new URL(browserVersion.webSocketDebuggerUrl);
      assert.equal(url.port, activePort[0]); assert.equal(url.pathname, activePort[1]);
      if (!productDownloads) native = await connectOriginalDownloadObserver({ webSocketURL: url.href, ownedIsolatedProfile: path.resolve(profile) });
      const targets = native ? await native.call("Target.getTargets") : await observerBrowserControl.call("Target.getTargets", {});
      const workerTargets = (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json())
        .filter(target => target.type === "service_worker" && target.url === `chrome-extension://${extensionId}/background.js`);
      assert.equal(workerTargets.length, 1);
      assert.ok(targets.targetInfos.some(target => target.targetId === workerTargets[0].id));
      assert.equal(await worker.evaluate("chrome.runtime.id"), extensionId);
      detail.identity = { pid: chrome.pid, profile, activePort, browserVersion, extensionId, worker: workerTargets[0], targets };
      if (productDownloads) {
        const before = await browser.client.getInfo();
        detail.bindingCapabilities = { before };
        assert.equal(before.metadata.pageDownloads.available, false);
        detail.bindingProcess = {};
        detail.connectionMode = autoConnectDownloads ? {
          discovery: "production DevToolsActivePort read from explicit isolated user-data root",
          browser: "chrome", userDataDir: path.resolve(profile),
          boundary: "Isolated launch-flag Chromium; does not validate normal-start browser approval, default user-data discovery, or Edge runtime",
        } : { discovery: "explicit Browser WebSocket URL" };
        const bindingArgs = ["bind-browser", "--socket", endpoint,
          ...(autoConnectDownloads ? ["--auto-connect", "--browser", "chrome", "--user-data-dir", path.resolve(profile)] : ["--cdp-url", url.href]),
          "--exclusive", "--timeout", autoConnectDownloads ? "60s" : "20s"];
        detail.binding = JSON.parse(await runOriginalDownloadProcess({ command: executable, args: bindingArgs,
          detail: detail.bindingProcess, timeoutMs: autoConnectDownloads ? 65000 : 25000 }));
        assert.equal(detail.bindingProcess.closeObserved, true);
        assert.equal(detail.bindingProcess.exitCode, 0);
        assert.equal(detail.binding.result.bound, true);
        const after = await browser.client.getInfo();
        detail.bindingCapabilities.after = after;
        assert.equal(after.metadata.pageDownloads.available, true);
        assert.equal(after.metadata.pageDownloads.generation, detail.binding.result.generation);
        detail.bindingProof = await worker.evaluate("globalThis.__obuNativeDownloadBinding");
        for (const key of ["extensionId", "extensionInstanceId", "workerBootId", "portId"]) assert.equal(detail.bindingProof[key], detail.binding.result[key]);
        sourceIdentity.testHooks.push("production original downloads: explicit bind-browser to exact owned isolated Browser root; no independent Browser download observer/configuration; passive Page trace and returned product path byte inspection");
        if (autoConnectDownloads) sourceIdentity.testHooks.push("auto-connect: production CLI reads actual isolated DevToolsActivePort; no cdp-url passed; launch-flag Chromium only, not normal-start permission UI or Edge/default profile acceptance");
      } else {
        await native.start({ behavior: originalDownloadBehavior, ...(originalDownloadBehavior === "allowAndName" ? { downloadPath: path.join(runDir, "downloads") } : {}) });
        sourceIdentity.testHooks.push("original download proof: real Browser root connection changes only fresh isolated profile download behavior/events; passive Page trace, exact GUID/frame merge and native filePath reads; no product fallback or directory delta");
      }
      let callers;
      const kinds = fiveEntryDownloads ? ["js", "cli", "mcp", "python", "go"] : ["js", "js", "js"];
      for (let index = 0; index < kinds.length; index++) owners.push(await connectOpenBrowserUse({ socketPath: endpoint, sessionId: `original-download-${index}`, turnId: "native-proof", timeoutMs: 20000 }));
      if (fiveEntryDownloads) {
        const pythonCaller = path.join(runDir, "python-original-download-checks.py");
        const goCaller = path.join(runDir, process.platform === "win32" ? "go-original-download-checks.exe" : "go-original-download-checks");
        const readyDirectory = path.join(runDir, "original-gates"); await fs.mkdir(readyDirectory);
        await fs.copyFile(path.join(directory, "python-original-download-checks.py"), pythonCaller, fsConstants.COPYFILE_EXCL);
        await fs.copyFile(process.env.OBU_TEST_GO_ORIGINAL_DOWNLOAD_BINARY, goCaller, fsConstants.COPYFILE_EXCL);
        detail.callers = { kinds, pythonSHA256: createHash("sha256").update(await fs.readFile(pythonCaller)).digest("hex"), goBinarySHA256: createHash("sha256").update(await fs.readFile(goCaller)).digest("hex") };
        for (const name of ["original-download-callers.mjs", "python-original-download-checks.py", "go-original-download-checks/main.go"]) sourceIdentity.sha256[name] = createHash("sha256").update(await fs.readFile(path.join(directory, name))).digest("hex");
        callers = kinds.map(kind => kind === "js" ? null : async ({ scope, afterReady, ...input }) => {
          const params = { socketPath: endpoint, sessionId: scope.session_id, turnId: scope.turn_id, controlEpoch: scope.control_epoch, ...input };
          const evidence = { kind, input: params }, artifact = path.join(runDir, `original-caller-${kind}-${input.key}.json`);
          try {
            if (kind === "cli" || kind === "mcp") {
              evidence.result = await runOriginalDownloadCaller({ ...params, downloadKind: input.kind, kind, executable, afterReady });
            } else {
              evidence.process = {};
              const readyPath = path.join(readyDirectory, `${input.key}.ready.json`), releasePath = path.join(readyDirectory, `${input.key}.release`);
              params.readyGate = { readyPath, releasePath, token: randomUUID() };
              const child = runOriginalDownloadProcess({ command: kind === "python" ? process.env.OBU_TEST_PYTHON || "python" : goCaller,
                args: kind === "python" ? [pythonCaller] : [], input: JSON.stringify(params), timeoutMs: 45000, detail: evidence.process,
                env: { ...process.env, PYTHONPATH: path.dirname(pythonSnapshot), PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8", PYTHONDONTWRITEBYTECODE: "1" } });
              let ready, observing = true;
              try {
                await Promise.race([
                  until(async () => { if (!observing) return true; ready = JSON.parse(await fs.readFile(readyPath, "utf8")); return true; }, "typed original-download ready receipt", 15000),
                  child.then(() => { throw new Error("Typed caller exited before all-ready release"); })
                ]).finally(() => { observing = false; });
                assert.equal(ready.token, params.readyGate.token);
                evidence.ready = ready;
                await Promise.race([
                  afterReady(ready),
                  child.then(() => { throw new Error("Typed caller exited during all-ready barrier"); })
                ]);
                const temporary = releasePath + ".pending";
                await fs.writeFile(temporary, params.readyGate.token, { flag: "wx" });
                await fs.rename(temporary, releasePath); evidence.releasePublishedAt = Date.now();
                evidence.result = JSON.parse(await child);
              } catch (error) {
                try { await child; } catch (childError) { evidence.childError = childError.stack; }
                throw error;
              }
            }
            assert.equal(evidence.result.caller, kind); return evidence.result;
          } catch (error) { evidence.error = error.stack; evidence.partial = error.originalDownloadCallerDetail ?? error.originalDownloadDetail; error.originalDownloadDetail = evidence; throw error; }
          finally { await fs.writeFile(artifact, JSON.stringify(evidence, null, 2), { flag: "wx" }); }
        });
      }
      Object.assign(detail, await checkOriginalDownloadProof({ owners, worker, native, fixture: originalDownloadFixtures, fixtureURL, downloadRoot: path.join(runDir, "downloads"), until, behavior: productDownloads ? "default" : originalDownloadBehavior, product: productDownloads, callers }));
      if (productDownloads) await checkProductDownloadLifecycle({ owner: owners[0], fixture: downloadWaitFixtures, fixtureURL, until, detail });
    } catch (error) { failure = error; Object.assign(detail, error.originalDownloadDetail ?? {}, { error: error.stack, ...(error.observerSnapshot ? { observerFailure: error.observerSnapshot } : {}) }); }
    finally {
      detail.cleanup = [];
      for (const owner of owners) {
        try { detail.cleanup.push(await owner.client.finalizeTabs([])); }
        catch (error) { detail.cleanup.push({ error: error.stack }); failure ??= error; }
        finally { owner.close(); }
      }
      if (native) {
        try { await native.close(); } catch (error) { detail.nativeCloseError = error.stack; failure ??= error; }
        detail.browserTrace = native.snapshot();
      }
      detail.server = originalDownloadFixtures.allStats();
      await fs.writeFile(path.join(runDir, "original-download-proof.json"), JSON.stringify(detail, null, 2));
    }
    if (failure) throw failure;
    return { evidence: "original-download-proof.json", behavior: originalDownloadBehavior, originalFiles: detail.cases.length, publicPathImplemented: productDownloads };
  });
  for (const kind of ["js", "cli", "mcp", "python", "go", "lifecycle"]) await test(kind === "lifecycle" ? "js-page-download-ready-lifecycle" : `${kind}-page-download-ready-two-connections`, async () => {
    const prefix = `${kind === "lifecycle" ? "js-lifecycle" : kind}-page-download`, options = { socketPath: endpoint, sessionId: prefix, turnId: "download-ready", timeoutMs: 15000 };
    const owner = await connectOpenBrowserUse(options), trigger = ["js", "lifecycle"].includes(kind) ? await connectOpenBrowserUse(options) : null;
    const foreign = kind === "lifecycle" ? await connectOpenBrowserUse({ ...options, sessionId: "page-download-successor" }) : null;
    let detail = {}, failure, finishEvidence, callerOutput;
    try {
      sourceIdentity.testHooks.push(`page download ${kind}: bounded passive original Page.downloadWillBegin/progress listener; isolated directory delta checked against original HTTP response bytes, not a public GUID/path mapping; no backend hooks`);
      finishEvidence = await startDownloadEvidence({ worker, owner, server: downloadWaitFixtures, downloadRoot: path.join(runDir, "downloads"), until });
      if (kind === "js" || kind === "lifecycle") {
        if (downloadDiagnostic) sourceIdentity.testHooks.push("download diagnostic opt-in: exact-tab original Input/Page.enable/disable/Runtime.runIfWaitingForDebugger commands and download/frame events share a bounded sequence; original receiver/Promise retained, scheduling may change; one total 3-second original-scope DOM/window/focus pass on failure before cancellation, no input replay or attachment");
        const parameters = { owner, trigger, foreign, fixtureURL, server: downloadWaitFixtures, worker, until, prefix,
          ...(downloadDiagnostic ? { diagnostic: createDownloadDiagnostic({ worker, readFocus: readFocusLedger }) } : {}) };
        detail = await (kind === "js" ? checkDownloadReady(parameters) : checkDownloadLifecycle(parameters));
      } else if (kind === "cli" || kind === "mcp") {
        const cliCall = async (method, params) => {
          const response = JSON.parse(await subprocess(path.resolve(executable), ["call", "--socket", endpoint, "--session-id", prefix, "--method", method, "--params", JSON.stringify(params), "--timeout", "15s"]));
          assert.equal(response.error, undefined, JSON.stringify(response)); return response.result;
        };
        const parameters = { kind, owner, fixtureURL };
        detail = kind === "mcp" ? await withMCPClient(executable, endpoint, prefix, callA => withMCPClient(executable, endpoint, prefix, callB => checkDownloadWireCaller({ ...parameters, callA, callB }))) : await checkDownloadWireCaller({ ...parameters, callA: cliCall, callB: cliCall });
      } else {
        const output = path.join(runDir, `download-ready-${kind}-caller.json`), source = path.join(directory, kind === "python" ? "download-waits-checks.py" : "go-download-waits-checks/main.go");
        callerOutput = output;
        const frozen = path.join(runDir, kind === "python" ? "download-waits-checks.py" : "download-waits-checks.go");
        await fs.copyFile(source, frozen, fsConstants.COPYFILE_EXCL);
        let executablePath = process.env.OBU_TEST_PYTHON || "python", args = [frozen, endpoint, fixtureURL, prefix, output];
        const proof = { sourceSHA256: createHash("sha256").update(await fs.readFile(frozen)).digest("hex") }; detail.proof = proof;
        if (kind === "go") {
          assert.ok(process.env.OBU_TEST_GO_DOWNLOAD_WAIT_BINARY, "Set OBU_TEST_GO_DOWNLOAD_WAIT_BINARY for typed Go page download waits");
          executablePath = path.join(runDir, process.platform === "win32" ? "go-download-waits-client.exe" : "go-download-waits-client");
          await fs.copyFile(process.env.OBU_TEST_GO_DOWNLOAD_WAIT_BINARY, executablePath, fsConstants.COPYFILE_EXCL);
          proof.binarySHA256 = createHash("sha256").update(await fs.readFile(executablePath)).digest("hex"); args = [endpoint, fixtureURL, prefix, output];
        }
        const result = JSON.parse(await subprocess(executablePath, args, { timeoutMs: 120000, env: { ...process.env, PYTHONPATH: path.dirname(pythonSnapshot), PYTHONIOENCODING: "utf-8", PYTHONDONTWRITEBYTECODE: "1" } }));
        assert.deepEqual(result, JSON.parse(await fs.readFile(output, "utf8"))); detail = { ...checkDownloadCallerResult(result, kind), proof };
      }
    } catch (error) {
      failure = error;
      if (callerOutput) { try { detail.partialCaller = JSON.parse(await fs.readFile(callerOutput, "utf8")); } catch (readError) { detail.partialCallerReadError = readError.message; } }
      detail = { ...detail, ...(error.downloadDetail ?? {}), error: error.stack };
    }
    finally {
      downloadWaitFixtures.release("js-page-download-lifecycle");
      try { if (finishEvidence) await finishEvidence(detail, !failure); }
      catch (error) { detail.evidenceError = error.stack; failure ??= error; }
      await fs.writeFile(path.join(runDir, `download-ready-${kind}.json`), JSON.stringify(detail, null, 2));
      try { await owner.client.finalizeTabs([]); if (foreign) await foreign.client.finalizeTabs([]); } finally { owner.close(); trigger?.close(); foreign?.close(); }
    }
    if (failure) throw failure;
    return detail;
  });
  let chooserFiles;
  const getChooserFiles = async () => chooserFiles ??= await prepareChooserFiles(runDir);
  let directoryFiles;
  const getDirectoryFiles = async () => directoryFiles ??= await prepareDirectoryFiles(runDir);
  await test("js-file-chooser-directory-world-reconnect", async () => {
    const owner = await connectOpenBrowserUse({ socketPath: endpoint, sessionId: "js-directory-world", turnId: "directory-world", timeoutMs: 15000 });
    let detail;
    try { detail = await checkDirectoryWorld({ browser: owner, fixtureURL, worker }); return detail; }
    catch (error) { detail = { ...(error.directoryWorldDetail ?? {}), error: error.stack }; throw error; }
    finally {
      await fs.writeFile(path.join(runDir, "directory-world.json"), JSON.stringify(detail, null, 2));
      try { await owner.client.finalizeTabs([]); } finally { owner.close(); }
    }
  });
  await test("js-file-chooser-directory-inactive-rejection", async () => {
    const owner = await connectOpenBrowserUse({ socketPath: endpoint, sessionId: "js-directory-inactive", turnId: "directory-inactive", timeoutMs: 15000 });
    let detail, failure;
    try { detail = await checkInactiveDirectoryRejection({ browser: owner, fixtureURL, server: directoryUploads, files: await getDirectoryFiles(), worker, expectedWindowId: sentinel.windowId }); }
    catch (error) { failure = error; detail = { ...(error.directoryDetail ?? {}), error: error.stack }; }
    finally {
      detail ??= {};
      try { detail.finalize = await owner.client.finalizeTabs([]); }
      catch (error) { detail.cleanupError = error.stack; failure ??= error; }
      finally { owner.close(); }
      if (detail.key) {
        detail.afterFinalizeServer = directoryUploads.stats(detail.key);
        if (!failure) try { checkInactiveDirectoryCancellation(detail.afterFinalizeServer, detail); assert.deepEqual(detail.afterFinalizeServer, detail.atReturn); } catch (error) { failure = error; detail.error = error.stack; }
      }
      await fs.writeFile(path.join(runDir, "directory-inactive.json"), JSON.stringify(detail, null, 2));
      await fs.writeFile(path.join(runDir, "directory-upload-server.json"), JSON.stringify(directoryUploads.allStats(), null, 2));
    }
    if (failure) throw failure; return detail;
  });
  await test("js-file-chooser-directory-background-window", async () => {
    const owner = await connectOpenBrowserUse({ socketPath: endpoint, sessionId: "js-directory-upload", turnId: "directory-upload", timeoutMs: 15000 });
    const recorder = backgroundWindowRecorder(owner);
    let detail, failure;
    try {
      const info = await owner.client.getInfo(); assert.equal(info.metadata.backgroundWindowVersion, 1);
      detail = await checkDirectoryUpload({ browser: owner, fixtureURL, server: directoryUploads, files: await getDirectoryFiles(), worker, until, createTab: () => recorder.createTab(), pointerEvidence: chooserAllPointers });
    } catch (error) { failure = error; detail = { ...(error.directoryDetail ?? {}), error: error.stack, server: directoryUploads.allStats() }; }
    finally {
      detail ??= {}; detail.backgroundWindows = recorder.records;
      await finishChooserCase({ detail, originalError: failure, cleanup: [
        { name: "finalize-and-verify", run: async () => {
          detail.finalize = await owner.client.finalizeTabs([]);
          await until(async () => { detail.cleanup = await readBackgroundWindowState(); checkBackgroundWindowCleanup(detail.cleanup, recorder.records); return true; }, "public background directory tabs/windows removed", 5000);
        } },
        { name: "owner-close", run: () => owner.close() }
      ], save: async value => {
        await fs.writeFile(path.join(runDir, "directory-upload.json"), JSON.stringify(value, null, 2));
        await fs.writeFile(path.join(runDir, "directory-upload-server.json"), JSON.stringify(directoryUploads.allStats(), null, 2));
      } });
    }
    if (failure) throw failure; return detail;
  });
  await test("js-background-window-mixed-finalize", async () => {
    const owner = await connectOpenBrowserUse({ socketPath: endpoint, sessionId: "js-background-window-mixed", turnId: "background-window-mixed", timeoutMs: 15000 });
    let detail;
    try {
      detail = await checkBackgroundWindowOwnership({ browser: owner, fixtureURL, recorder: backgroundWindowRecorder(owner), readNative: readBackgroundWindowState,
        readFocus: readFocusLedger, focusLedger, allowedActivations: allowedPopupActivations, allowedFocus: allowedWindowFocusEvents, until,
        createExtra: options => worker.evaluate(`chrome.tabs.create(${JSON.stringify(options)})`),
        removeExtra: ({ tabId, windowId }) => worker.evaluate(`(async()=>{const tab=await chrome.tabs.get(${tabId});if(tab.id!==${tabId}||tab.windowId!==${windowId})throw new Error('Fixture extra tab identity changed');await chrome.tabs.remove(${tabId})})()`)
      });
      return detail;
    } catch (error) { detail = { ...(error.backgroundWindowDetail ?? {}), error: error.stack }; throw error; }
    finally { owner.close(); await fs.writeFile(path.join(runDir, "background-window-mixed.json"), JSON.stringify(detail, null, 2)); }
  });
  await test("js-file-chooser-single-submission", async () => {
    const options = { socketPath: endpoint, sessionId: "js-chooser-submission", turnId: "chooser-submission", timeoutMs: 15000 };
    const owner = await connectOpenBrowserUse(options), trigger = await connectOpenBrowserUse(options);
    let detail, failure;
    try {
      detail = await checkChooserSubmission({ owner, trigger, fixtureURL, server: chooserFixtures, files: await getChooserFiles(), worker, until, pointerEvidence: chooserAllPointers });
      return detail;
    } catch (error) { failure = error; detail = { ...(error.chooserDetail ?? {}), error: error.stack, server: chooserFixtures.allStats() }; throw error; }
    finally {
      await finishChooserCase({ detail: detail ??= {}, originalError: failure, cleanup: [
        { name: "finalize", run: () => owner.client.finalizeTabs([]) },
        { name: "owner-close", run: () => owner.close() }, { name: "trigger-close", run: () => trigger.close() }
      ], save: value => fs.writeFile(path.join(runDir, "chooser-submission.json"), JSON.stringify(value, null, 2)) });
    }
  });
  for (const lifecycle of [false, true]) await test(lifecycle ? "js-file-chooser-ready-lifecycle" : "js-file-chooser-ready-two-connections", async () => {
    const sessionId = lifecycle ? "js-chooser-lifecycle" : "js-chooser-ready", options = { socketPath: endpoint, sessionId, turnId: "chooser-ready", timeoutMs: 15000 };
    const owner = await connectOpenBrowserUse(options), trigger = await connectOpenBrowserUse(options);
    const foreign = lifecycle ? await connectOpenBrowserUse({ ...options, sessionId: "js-chooser-successor" }) : null;
    const artifact = path.join(runDir, lifecycle ? "chooser-js-lifecycle.json" : "chooser-js.json"); let detail, failure;
    try {
      if (lifecycle) sourceIdentity.testHooks.push("chooser lifecycle: bounded passive native Page.fileChooserOpened listener only, removed after the uncollected-cancel case; no native event or result changes");
      else sourceIdentity.testHooks.push("chooser ready JS: per-variant bounded passive chrome.debugger.onEvent frame/target/fileChooserOpened trace for the exact tab; original native payloads retained on success/failure, listener removed afterward; no backend hooks or event/result changes");
      if (!lifecycle && chooserMode === "native") sourceIdentity.testHooks.push("chooser diagnostic opt-in: exact-tab original native Input/chooser-interception/Page.enable/disable/Runtime.runIfWaitingForDebugger commands and chooser/frame events share one bounded sequence; opt-in fixture HTML records bounded passive root/child pointer and mouse events; recording may affect scheduling; once-only current-scope raw DOM/window/focus reads on failure before cancellation; no action replay, new attachment or production hook; default HTML unchanged");
      if (!lifecycle && chooserMode === "pointer-only") sourceIdentity.testHooks.push("chooser pointer-only diagnostic: opt-in fixture HTML records bounded passive root/child pointer and mouse events; no additional pre-arm handshake or native command wrapper; original default onEvent trace retained; failure-only exact documentId observation within one 3-second budget; recording may affect scheduling; no input replay or success-path DOM read, default HTML unchanged");
      if (!lifecycle && chooserMode === "pointer-context") sourceIdentity.testHooks.push("chooser pointer-context diagnostic: exact 13-case JwX2Bc order; passive pointer/mouse HTML only for js-chooser-root/oopif/dynamic-oopif keys, all other fixture HTML unchanged; JS ready only failure-time documentId read with the original 3-second observation budget; no native command wrapper, additional pre-arm handshake, input replay or success-path DOM read; recorder may affect scheduling");
      const parameters = { owner, trigger, foreign, fixtureURL, files: await getChooserFiles(), server: chooserFixtures, worker, until, prefix: "js-chooser",
        ...(!lifecycle && chooserMode === "native" ? { diagnostic: createChooserDiagnostic({ worker, readFocus: readFocusLedger, pointerEvidence: true }) } :
          !lifecycle && ["pointer-only", "pointer-context", "pointer-all-context"].includes(chooserMode) ? { pointerEvidence: true } : {}) };
      detail = await (lifecycle ? checkChooserLifecycle(parameters) : checkChooserReady(parameters)); return detail;
    } catch (error) { failure = error; detail = { ...(error.chooserDetail ?? {}), error: error.stack, server: chooserFixtures.allStats() }; throw error; }
    finally {
      await finishChooserCase({ detail: detail ??= {}, originalError: failure, cleanup: [
        { name: "finalize", run: () => owner.client.finalizeTabs([]) },
        ...(foreign ? [{ name: "foreign-finalize", run: () => foreign.client.finalizeTabs([]) }] : []),
        { name: "owner-close", run: () => owner.close() }, { name: "trigger-close", run: () => trigger.close() },
        ...(foreign ? [{ name: "foreign-close", run: () => foreign.close() }] : [])
      ], save: value => fs.writeFile(artifact, JSON.stringify(value, null, 2)) });
    }
  });
  for (const kind of ["cli", "mcp"]) await test(`${kind}-file-chooser-ready-two-connections`, async () => {
    const sessionId = `${kind}-chooser-ready`, owner = await connectOpenBrowserUse({ socketPath: endpoint, sessionId, turnId: "chooser-ready", timeoutMs: 15000 });
    const callerResult = { caller: kind, independentConnections: true, variants: [] }, callerProcesses = [];
    let detail, failure, callerFailure;
    const cliCall = async (method, params) => {
      const processEvidence = { method }; callerProcesses.push(processEvidence);
      const response = JSON.parse(await subprocess(path.resolve(executable), ["call", "--socket", endpoint, "--session-id", sessionId, "--method", method, "--params", JSON.stringify(params), "--timeout", "15s"], { processEvidence }));
      assert.equal(response.error, undefined, JSON.stringify(response)); return response.result;
    };
    try {
      const parameters = { kind, owner, fixtureURL, files: await getChooserFiles(), server: chooserFixtures, worker, until, detail: callerResult };
      const runCaller = (callA, callB) => checkChooserWireCaller({ ...parameters, callA, callB }).catch(error => { callerFailure = error; throw error; });
      if (kind === "mcp") {
        const first = { role: "owner" }, second = { role: "trigger" }; callerProcesses.push(first, second);
        detail = await withMCPClient(executable, endpoint, sessionId,
          callA => withMCPClient(executable, endpoint, sessionId, callB => runCaller(callA, callB), second), first);
      } else detail = await runCaller(cliCall, cliCall);
      return detail;
    } catch (error) {
      failure = callerFailure ?? error;
      detail = { error: failure?.stack ?? String(failure), callerResult, callerProcesses, server: chooserFixtures.allStats(),
        ...(error !== failure ? { connectionCleanupError: error?.stack ?? String(error) } : {}) };
      await observeChooserCallerFailure({ detail, callerResult, kind, prefix: `${kind}-chooser`, sessionId,
        callerClosed: callerProcesses.length > 0 && callerProcesses.every(process => process.closeObserved === true),
        pointerEvidence: chooserAllPointers,
        worker, fixtureURL, timing: `After the original ${kind.toUpperCase()} callers' confirmed process close and waiter cancellation attempts; before parent task finalization` });
      throw failure;
    } finally {
      detail ??= { callerResult };
      detail.callerProcesses = callerProcesses;
      await finishChooserCase({ detail, originalError: failure, cleanup: [
        { name: "finalize", run: () => owner.client.finalizeTabs([]) }, { name: "owner-close", run: () => owner.close() }
      ], save: value => fs.writeFile(path.join(runDir, `chooser-${kind}.json`), JSON.stringify(value, null, 2)) });
    }
  });
  for (const kind of ["python", "go"]) await test(`${kind}-file-chooser-ready-two-connections`, async () => {
    const prefix = `${kind}-chooser`, files = await getChooserFiles(), output = path.join(runDir, `chooser-${kind}-caller.json`);
    const source = path.join(directory, kind === "python" ? "chooser-waits-checks.py" : "go-chooser-waits-checks/main.go"), frozen = path.join(runDir, kind === "python" ? "chooser-waits-checks.py" : "chooser-waits-checks.go");
    await fs.copyFile(source, frozen, fsConstants.COPYFILE_EXCL);
    let executablePath = process.env.OBU_TEST_PYTHON || "python", args = [frozen, endpoint, fixtureURL, prefix, output, ...files.map(file => file.path)], detail;
    const proof = { sourceSHA256: createHash("sha256").update(await fs.readFile(frozen)).digest("hex") };
    if (kind === "go") {
      const sourceDirectory = path.join(directory, "go-chooser-waits-checks"), frozenDirectory = path.join(runDir, "go-chooser-source");
      await fs.mkdir(frozenDirectory);
      proof.sourceFiles = {};
      for (const file of (await fs.readdir(sourceDirectory)).filter(name => name.endsWith(".go")).sort()) {
        const destination = path.join(frozenDirectory, file);
        await fs.copyFile(path.join(sourceDirectory, file), destination, fsConstants.COPYFILE_EXCL);
        proof.sourceFiles[file] = createHash("sha256").update(await fs.readFile(destination)).digest("hex");
      }
      assert.ok(process.env.OBU_TEST_GO_CHOOSER_BINARY, "Set OBU_TEST_GO_CHOOSER_BINARY for typed Go chooser ready acceptance");
      executablePath = path.join(runDir, process.platform === "win32" ? "go-chooser-client.exe" : "go-chooser-client");
      await fs.copyFile(process.env.OBU_TEST_GO_CHOOSER_BINARY, executablePath, fsConstants.COPYFILE_EXCL);
      proof.binarySHA256 = createHash("sha256").update(await fs.readFile(executablePath)).digest("hex"); args = [endpoint, fixtureURL, prefix, output, ...files.map(file => file.path)];
    }
    const owner = await connectOpenBrowserUse({ socketPath: endpoint, sessionId: prefix, turnId: "chooser-ready", timeoutMs: 15000 });
    const diagnostic = kind === "go" && goChooserDiagnostic ? createGoChooserDiagnostic({ worker, readFocus: readFocusLedger }) : null;
    if (kind === "go" && chooserMode === "pointer-go-context") sourceIdentity.testHooks.push("chooser pointer-go-context diagnostic: original 13-case order; passive pointer/mouse HTML only for go-chooser-root/oopif/dynamic-oopif keys, all JS and other fixture HTML unchanged; original Go process arguments/actions/cancel/close retained without native diagnostic hooks; parent failure-only exact documentId observation after Go cancellation/close and before parent finalize, same 3-second budget; no success read or input replay; recorder may affect scheduling");
    const callerProcess = {};
    let childProcess, callerResult, failure;
    try {
      const env = { ...process.env, PYTHONPATH: path.dirname(pythonSnapshot), PYTHONIOENCODING: "utf-8", PYTHONDONTWRITEBYTECODE: "1" };
      if (diagnostic) {
        sourceIdentity.testHooks.push("Go chooser diagnostic opt-in: bounded JSONL start/failure/finish acknowledgements around the original Go operations; exact-tab native Input/chooser-interception/Page/frame trace; original promises retained, timing may change; one total 3-second native metadata/focus read before remaining cleanup (operation failure before cancel; cancel-only failure after the attempted cancel); no task DOM read, new scope, input replay or attachment");
        const items = new Map();
        childProcess = await runChooserProcess(executablePath, args, { timeoutMs: 120000, env: { ...env, OBU_GO_CHOOSER_DIAGNOSTIC: "1" }, onHook: async hook => {
          if (hook.kind === "start") items.set(hook.item.key, { ...hook.item });
          const item = items.get(hook.item.key);
          assert.ok(item, "Go chooser diagnostic hook has no original item");
          await diagnostic[hook.kind]({ item });
        } });
        callerResult = childProcess.result;
        assert.equal(childProcess.protocolComplete, true, JSON.stringify(childProcess.errors));
        assert.equal(childProcess.process.exitCode, 0, childProcess.process.stderr || callerResult?.error || "Go chooser process failed");
      } else {
        const stdout = await subprocess(executablePath, args, { timeoutMs: 120000, env, processEvidence: callerProcess });
        callerResult = JSON.parse(stdout);
      }
      assert.deepEqual(callerResult, JSON.parse(await fs.readFile(output, "utf8")));
      // Receipt/frame annotations must never mutate the original child result.
      detail = { ...checkChooserCallerResult(structuredClone(callerResult), kind, prefix, files, chooserFixtures), proof };
      for (const item of detail.variants) item.frames = await chooserFrameEvidence(worker, item.tabId, item.key, item.variant);
      return detail;
    } catch (error) {
      failure = error;
      let callerReadError;
      try {
        assert.ok((await fs.stat(output)).size <= 4 * 1024 * 1024, "Go/Python chooser partial artifact exceeds limit");
        const saved = JSON.parse(await fs.readFile(output, "utf8"));
        if (callerResult) assert.deepEqual(callerResult, saved, "Go/Python stdout result differs from saved partial result");
        callerResult = saved;
      } catch (readError) { callerReadError = String(readError); }
      detail = { error: error?.stack ?? String(error), proof, callerResult, callerReadError, callerProcess, server: chooserFixtures.allStats() };
      if (!diagnostic) {
        await observeChooserCallerFailure({ detail, callerResult, kind, prefix, sessionId: prefix, callerReadError,
          callerClosed: callerProcess.closeObserved === true, worker, fixtureURL,
          ...(kind === "go" && chooserMode === "pointer-go-context" ? { pointerEvidence: true } : {}),
          ...(chooserAllPointers ? { pointerEvidence: true } : {}),
          timing: `After original ${kind} process failure and confirmed close, including its waiter cancellation/connection close attempts; before parent task finalization` });
      }
      throw error;
    } finally {
      detail ??= { proof, callerResult };
      if (!diagnostic) detail.callerProcess = callerProcess;
      await finishChooserCase({ detail, originalError: failure, cleanup: [
        ...(diagnostic ? [{ name: "diagnostic-cleanup", run: async () => {
          try { await diagnostic.cleanup(); }
          finally { detail.childProcess = childProcess; detail.diagnostic = { records: diagnostic.records, errors: diagnostic.errors }; }
        } }] : []),
        { name: "finalize", run: () => owner.client.finalizeTabs([]) }, { name: "owner-close", run: () => owner.close() }
      ], save: value => fs.writeFile(path.join(runDir, `chooser-${kind}.json`), JSON.stringify(value, null, 2)) });
    }
  });
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
  if (mcpBinding) await test("mcp-connection-binding", () => checkMCPConnectionBinding({
    executable, socketDir, fixtureURL, fixture: mcpBindingFixture, until,
    restartHost: async () => {
      await activeInvariant();
      const result = await nativeBridge.restart();
      endpoint = result.newEndpoint;
      await activeInvariant();
      return result;
    },
    readNative: () => focusObserver.evaluate("(async()=>({at:Date.now(),tabs:await chrome.tabs.query({}),targets:await chrome.debugger.getTargets()}))()"),
    save: detail => fs.writeFile(path.join(runDir, "mcp-connection-binding.json"), JSON.stringify(detail, null, 2))
  }));
  await test("js-native-large-requests", async () => {
    const clients = [], before = { ...nativeFrameStats }, witnesses = [];
    const hostPID = nativeBridge.host.pid;
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
      assert.equal(nativeBridge.host.pid, hostPID); assert.equal(nativeBridge.host.exitCode, null);
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
  await test("js-bounding-geometry", async () => {
    sourceIdentity.testHooks.push("bounding geometry: transparent exact-tab native geometry/screenshot recorder; independent CSS border-corner witnesses and actual PNG dimensions/pixels verify public locator boundingBox and screenshot; original native document identities and exact task cleanup; no new focus allowance");
    const owner = await connectOpenBrowserUse({ socketPath: endpoint, sessionId: "js-bounding-geometry", turnId: "transformed-element-bounds", timeoutMs: 20000 });
    const detail = {}; let failure;
    try { await checkBoundingGeometry({ browser: owner, worker, fixtureURL, server: boundingGeometryFixtures, until, detail,
      saveScreenshot: async (name, bytes) => { const filename = `${name}.png`; await fs.writeFile(path.join(runDir, filename), bytes); return filename; }
    }); } catch (error) { failure = error; }
    await finishChooserCase({ detail, originalError: failure, cleanup: [
      { name: "finalize-bounding-geometry-tabs", run: async () => { detail.finalize = await owner.client.finalizeTabs([]); } },
      { name: "close-bounding-geometry-client", run: () => owner.close() },
      { name: "verify-bounding-geometry-cleanup", run: async () => {
        detail.finalNative = await worker.evaluate(`(async()=>({tabs:await chrome.tabs.query({}),targets:await chrome.debugger.getTargets()}))()`);
        for (const item of detail.cases ?? []) {
          assert.ok(!detail.finalNative.tabs.some(tab => tab.id === item.tabId), "Bounding geometry task tab remains after finalize");
          const urls = [...new Set([
            ...Object.values(item.urls ?? {}), ...Object.values(item.navigationURLs ?? {}),
            ...(item.phases ?? []).flatMap(phase => [...Object.values(phase.urls ?? {}), phase.hiddenParentFrame?.url,
              ...(phase.native?.frames ?? []).map(frame => frame.url)])
          ].filter(value => typeof value === "string" && value.includes(item.key)))];
          assert.ok(!detail.finalNative.targets.some(target => urls.includes(target.url)), "Bounding geometry task target remains after finalize");
        }
      } }
    ], save: async value => {
      await fs.writeFile(path.join(runDir, "bounding-geometry.json"), JSON.stringify(value, null, 2));
      await fs.writeFile(path.join(runDir, "bounding-geometry-server.json"), JSON.stringify(boundingGeometryFixtures.allStats(), null, 2));
    } });
    if (failure) throw failure;
    return detail;
  });
  if (createdPageProof === "five-entry") await test("five-entry-created-page-ready", async () => {
    const pythonCaller = path.join(runDir, "python-created-page-checks.py"), goCaller = path.join(runDir, process.platform === "win32" ? "go-created-page-checks.exe" : "go-created-page-checks");
    const gateDirectory = path.join(runDir, "created-page-gates"); await fs.mkdir(gateDirectory);
    await fs.copyFile(path.join(directory, "python-created-page-checks.py"), pythonCaller, fsConstants.COPYFILE_EXCL);
    await fs.copyFile(process.env.OBU_TEST_GO_CREATED_PAGE_BINARY, goCaller, fsConstants.COPYFILE_EXCL);
    const detail = { callers: { pythonSHA256: createHash("sha256").update(await fs.readFile(pythonCaller)).digest("hex"), goBinarySHA256: createHash("sha256").update(await fs.readFile(goCaller)).digest("hex") } };
    for (const name of ["created-page-five-entry.mjs", "created-page-callers.mjs", "created-page-wire.mjs", "python-created-page-checks.py", "go-created-page-checks/main.go", "original-download-callers.mjs"])
      sourceIdentity.sha256[name] = createHash("sha256").update(await fs.readFile(path.join(directory, name))).digest("hex");
    const callExternal = async (kind, { scope, afterReady, afterPrepared, ...input }) => {
      const params = { socketPath: endpoint, sessionId: scope.session_id, turnId: scope.turn_id, controlEpoch: scope.control_epoch, ...input };
      const evidence = { kind, input: params }, artifact = path.join(runDir, `created-page-caller-${kind}-${input.key}.json`);
      try {
        if (kind === "cli" || kind === "mcp") {
          evidence.result = await runCreatedPageCaller({ ...params, kind, executable, afterReady, afterPrepared });
        } else {
          evidence.process = {};
          for (const name of ["readyGate", "preparedGate"]) params[name] = {
            readyPath: path.join(gateDirectory, `${input.key}.${name}.json`), releasePath: path.join(gateDirectory, `${input.key}.${name}.release`), token: randomUUID()
          };
          const deadline = performance.now() + 20000;
          const child = runOriginalDownloadProcess({ command: kind === "python" ? process.env.OBU_TEST_PYTHON || "python" : goCaller,
            args: kind === "python" ? [pythonCaller] : [], input: JSON.stringify(params), timeoutMs: 35000, detail: evidence.process,
            env: { ...process.env, PYTHONPATH: path.dirname(pythonSnapshot), PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8", PYTHONDONTWRITEBYTECODE: "1" } });
          child.catch(() => {});
          try {
            for (const [name, callback] of [["readyGate", afterReady], ["preparedGate", afterPrepared]]) {
              const gate = params[name];
              const ready = await readCreatedPageGate({ path: gate.readyPath, token: gate.token, child, deadline }); evidence[name] = { record: ready };
              await withinCreatedPageBudget(deadline, () => Promise.race([callback(ready), child.then(() => { throw new Error("Typed created-page caller exited during gate"); })]));
              const temporary = gate.releasePath + ".pending";
              await fs.writeFile(temporary, gate.token, { flag: "wx" });
              try { await fs.link(temporary, gate.releasePath); } finally { await fs.unlink(temporary); }
              evidence[name].releasePublishedAt = Date.now();
            }
            evidence.result = JSON.parse(await child);
          } catch (error) {
            try { await child; } catch (childError) { evidence.childError = childError.stack; }
            if (evidence.process.stdout) try { evidence.partial = JSON.parse(evidence.process.stdout); } catch {}
            error.createdPageCallerDetail ??= evidence.partial; throw error;
          }
        }
        assert.equal(evidence.result.caller, kind); return evidence.result;
      } catch (error) { evidence.error = error.stack; evidence.partial ??= error.createdPageCallerDetail; throw error; }
      finally { await fs.writeFile(artifact, JSON.stringify(evidence, null, 2), { flag: "wx" }); }
    };
    return checkCreatedPageFiveEntry({ detail, callExternal,
      connectBrowser: suffix => connectOpenBrowserUse({ socketPath: endpoint, sessionId: suffix, turnId: "created-five-original", timeoutMs: 20000 }),
      connectCaller: scope => connectOpenBrowserUse({ socketPath: endpoint, sessionId: scope.session_id, turnId: scope.turn_id, timeoutMs: 20000 }),
      getWorker: () => worker, connectionState: () => ({ generation: nativeBridge.current.record.generation, hostPid: nativeBridge.host.pid, endpoint: nativeBridge.endpoint }),
      fixtureURL, server: createdPageFixtures, saveDetail: value => fs.writeFile(path.join(runDir, "created-page-five-entry.json"), JSON.stringify(value, null, 2))
    });
  });
  if (["unowned", "worker-restart"].includes(createdPageProof)) await test("js-created-page-unowned", async () => {
    for (const name of ["created-page-unowned.mjs", "created-page-unowned-wire.mjs", "created-page-adoption-observer.mjs", "created-page-native-control.mjs", "created-page-wire.mjs", "created-page-worker-restart.mjs"])
      sourceIdentity.sha256[name] = createHash("sha256").update(await fs.readFile(path.join(directory, name))).digest("hex");
    return checkCreatedPageUnowned({
      connectBrowser: suffix => connectOpenBrowserUse({ socketPath: endpoint, sessionId: suffix, turnId: "created-unowned-original", timeoutMs: 20000 }),
      getWorker: () => worker, recorderFor: backgroundWindowRecorder, readNative: readBackgroundWindowState, readFocus: readFocusLedger,
      focusLedger, allowedActivations: allowedPopupActivations, allowedFocus: allowedWindowFocusEvents,
      connectionState: () => ({ generation: nativeBridge.current.record.generation, hostPid: nativeBridge.host.pid, endpoint: nativeBridge.endpoint }),
      ...(createdPageProof === "worker-restart" ? { restartWorker: restartObservedWorker, persistentEvaluate: expression => focusObserver.evaluate(expression) } : {}),
      fixtureURL, server: createdPageFixtures, saveDetail: value => fs.writeFile(path.join(runDir, "created-page-unowned.json"), JSON.stringify(value, null, 2))
    });
  });
  if (["provenance", "ready"].includes(createdPageProof)) await test(createdPageProof === "ready" ? "js-created-page-ready" : "js-created-page-provenance", async () => checkCreatedPageProvenance({
    productReady: createdPageProof === "ready",
    connectBrowser: suffix => connectOpenBrowserUse({ socketPath: endpoint, sessionId: `js-${suffix}`, timeoutMs: 15000 }),
    getWorker: () => worker, fixtureURL, server: createdPageFixtures, until,
    saveDetail: detail => fs.writeFile(path.join(runDir, "created-page-provenance.json"), JSON.stringify(detail, null, 2))
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
  if (snapshotGeometry) {
    for (const kind of ["js", "cli", "mcp", "python", "go"]) await test(`${kind}-snapshot-geometry`, async () => {
      const key = `geometry-${kind}-${randomUUID().slice(0, 8)}`, output = path.join(runDir, `snapshot-geometry-${kind}-caller.json`);
      let detail, failure;
      try {
        if (["js", "cli", "mcp"].includes(kind)) {
          try { detail = await checkGeometryCaller({ kind, key, endpoint, fixtureURL, expectedDPR: geometryDPR, connectOpenBrowserUse, executable, subprocess, withMCPClient }); }
          catch (error) { detail = error.geometryEvidence; throw error; }
        } else {
          const source = path.join(directory, kind === "python" ? "snapshot-geometry-checks.py" : "go-snapshot-geometry-checks/main.go");
          const copy = path.join(runDir, kind === "python" ? "snapshot-geometry-checks.py" : "snapshot-geometry-checks.go");
          await fs.copyFile(source, copy, fsConstants.COPYFILE_EXCL);
          let binary = process.env.OBU_TEST_PYTHON || "python", args = [copy, endpoint, fixtureURL, output, String(geometryDPR)];
          if (kind === "go") {
            binary = path.join(runDir, process.platform === "win32" ? "go-snapshot-geometry-client.exe" : "go-snapshot-geometry-client");
            await fs.copyFile(process.env.OBU_TEST_GO_GEOMETRY_BINARY, binary, fsConstants.COPYFILE_EXCL);
            sourceIdentity.sha256.goGeometryClient = createHash("sha256").update(await fs.readFile(binary)).digest("hex");
            args = [endpoint, fixtureURL, output, String(geometryDPR)];
          }
          try { await subprocess(binary, args, { timeoutMs: 120000, env: { ...process.env, PYTHONPATH: path.dirname(pythonSnapshot), PYTHONIOENCODING: "utf-8", PYTHONDONTWRITEBYTECODE: "1" } }); }
          finally { try { detail = JSON.parse(await fs.readFile(output, "utf8")); } catch {} }
        }
      } catch (error) { failure = error; }
      if (["js", "cli", "mcp"].includes(kind)) await fs.writeFile(output, JSON.stringify(detail ?? { error: String(failure) }, null, 2), { flag: "wx" });
      try {
        assert.ok(detail); assert.equal(detail.kind, kind); assert.equal(detail.expectedDPR, geometryDPR); assert.equal(detail.error, undefined, detail.error); assert.equal(detail.phases.length, 3);
        const images = [];
        for (const item of detail.phases) {
          assert.equal(item.dpr, geometryDPR);
          const filename = `snapshot-geometry-${kind}-${item.phase}.png`, bytes = Buffer.from(item.screenshot.base64, "base64");
          await fs.writeFile(path.join(runDir, filename), bytes, { flag: "wx" });
          const checked = checkGeometryPhase(item); images.push(checked);
          item.screenshot = { filename, ...checked.png };
        }
        detail.checked = images;
        const server = snapshotGeometryFixtures.allStats().find(record => record.key === detail.key); assert.ok(server); assert.equal(server.overflow, false);
        assert.equal(server.nonce, detail.phases[0].before.nonce); assert.deepEqual(server.requests.map(record => record.role).sort(), ["cross", "inner", "nested", "root", "same"]);
        detail.server = server;
        detail.oopifTargets = (await worker.evaluate("globalThis.__integrationFrames")).filter(target => target.tabId === detail.tabId);
        assert.ok(detail.oopifTargets.some(target => target.type === "iframe"), "No real OOPIF observed for geometry");
        assert.equal(detail.finalizeResult.endedTurnId, detail.scope.turn_id); assert.ok(detail.finalizeResult.controlEpoch > detail.scope.control_epoch);
        detail.removal = await until(async () => { const state = await worker.evaluate(`(async()=>({at:Date.now(),tabs:await chrome.tabs.query({}),targets:await chrome.debugger.getTargets()}))()`); return !state.tabs.some(tab => tab.id === detail.tabId) && !state.targets.some(target => target.tabId === detail.tabId) && state; }, "geometry task tab removed");
      } catch (error) { failure ??= error; }
      await fs.writeFile(path.join(runDir, `snapshot-geometry-${kind}.json`), JSON.stringify({ ...detail, error: failure?.stack ?? detail?.error }, null, 2));
      if (failure) throw failure;
      return { kind, tabId: detail.tabId, phases: detail.checked, finalized: true };
    });
    await test("js-snapshot-geometry-limits", async () => {
      const owner = await connectOpenBrowserUse({ socketPath: endpoint, sessionId: "snapshot-geometry-limits", timeoutMs: 15000 });
      try { const result = await checkGeometryLimits({ browser: owner, fixtureURL }); await fs.writeFile(path.join(runDir, "snapshot-geometry-limits.json"), JSON.stringify(result, null, 2)); return result; }
      finally { try { await owner.client.finalizeTabs([]); } finally { owner.close(); } }
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
  if (memoryClipboard) await test("js-clipboard", async () => {
    const owner = await connectOpenBrowserUse({ socketPath:endpoint, sessionId:"js-clipboard", timeoutMs:15000 });
    const foreign = await connectOpenBrowserUse({ socketPath:endpoint, sessionId:"js-clipboard-foreign", timeoutMs:15000 });
    try { return await checkClipboard({browser:owner,foreignBrowser:foreign,fixtureURL,guard:memoryClipboardGuard,
      saveArtifact: (name,data)=>fs.writeFile(path.join(runDir,name),data)}); }
    finally { await owner.client.finalizeTabs([]); await foreign.client.finalizeTabs([]); owner.close(); foreign.close(); }
  });
  if (memoryClipboard) for (const [kind, check] of [["python",checkPythonClipboard],["go",checkGoClipboard],["cli",checkCLIClipboard],["mcp",checkMCPClipboard]]) {
    await test(`${kind}-clipboard`,()=>check({endpoint,fixtureURL,runDir,
      pngPath:path.join(runDir,"clipboard-input.png"),executable,
      goClipboardExe:process.env.OBU_TEST_GO_CLIPBOARD_BINARY,
      pythonSDKSnapshot:path.dirname(pythonSnapshot),pythonExecutable:"python",subprocess,withMCPClient,memoryClipboardGuard}));
  }
  if (memoryClipboard) await test("js-clipboard-lifecycle",async()=>{
    const owner=await connectOpenBrowserUse({socketPath:endpoint,sessionId:"js-clipboard-lifecycle",timeoutMs:15000});
    try { return await checkClipboardLifecycle({browser:owner,fixtureURL,guard:memoryClipboardGuard,worker,until}); }
    finally { await owner.client.finalizeTabs([]);owner.close(); }
  });
  await test("js-page-exports", async () => {
    const owner = await connectOpenBrowserUse({ socketPath: endpoint, sessionId: "js-page-exports", timeoutMs: 15000 });
    const foreign = await connectOpenBrowserUse({ socketPath: endpoint, sessionId: "js-page-exports-foreign", timeoutMs: 15000 });
    try {
      return await checkPageExports({ browser: owner, foreignBrowser: foreign, fixtureURL, assert,
        saveArtifact: async (name, data) => { await fs.writeFile(path.join(runDir, name), data); return name; },
        saveDetail: detail => fs.writeFile(path.join(runDir, "page-exports-js.json"), JSON.stringify(detail, null, 2)) });
    } finally { await owner.client.finalizeTabs([]); await foreign.client.finalizeTabs([]); owner.close(); foreign.close(); }
  });
  await test("js-page-exports-lifecycle", async () => {
    const owner = await connectOpenBrowserUse({ socketPath: endpoint, sessionId: "js-page-exports-lifecycle", timeoutMs: 15000 });
    try {
      return await checkPageExportLifecycle({ browser: owner, fixtureURL, worker, assert, until,
        saveDetail: detail => fs.writeFile(path.join(runDir, "page-exports-lifecycle.json"), JSON.stringify(detail, null, 2)) });
    } finally { await owner.client.finalizeTabs([]); owner.close(); }
  });
  for (const kind of ["cli", "mcp"]) await test(`${kind}-page-exports`, async () => {
    const sessionId = `${kind}-page-exports`;
    const owner = await connectOpenBrowserUse({ socketPath: endpoint, sessionId, timeoutMs: 15000 });
    try {
      const owned = await preparePageExportTab(owner, fixtureURL, assert);
      const check = async tool => {
        const detail = {};
        for (const format of ["pdf", "mhtml"]) {
          const target = path.join(runDir, `page-export-${kind}.${format}`);
          const args = { tab_id: owned.id, format, output_path: target, max_bytes: 16 * 1024 * 1024, timeout_ms: 10000 };
          if (format === "pdf") args.pdf = { printBackground: true, preferCSSPageSize: true };
          let metadata;
          if (kind === "mcp") {
            const response = await tool("export_page", args);
            assert.equal(response.isError, false, JSON.stringify(response));
            metadata = response.structuredContent;
            const existing = await tool("export_page", args);
            assert.equal(existing.isError, true, "MCP overwrote an existing artifact");
          } else {
            const argv = ["export-page", "--socket", endpoint, "--session-id", sessionId, "--tab-id", String(owned.id), "--format", format, "--output", target, "--timeout", "15s"];
            if (args.pdf) argv.push("--pdf-options", JSON.stringify(args.pdf));
            metadata = JSON.parse(await subprocess(path.resolve(executable), argv));
            await assert.rejects(subprocess(path.resolve(executable), argv), /already exists/i);
          }
          assert.deepEqual(Object.keys(metadata).sort(), ["byteLength", "format", "mimeType", "path"]);
          assert.equal(metadata.path, target); assert.equal(metadata.format, format);
          assert.equal(metadata.mimeType, format === "pdf" ? "application/pdf" : "multipart/related");
          const bytes = await fs.readFile(target);
          assert.equal(metadata.byteLength, bytes.length);
          detail[format] = { ...verifyExportBytes(bytes, format, assert), artifact: path.basename(target), noOverwrite: true };
        }
        return detail;
      };
      if (kind === "mcp") return await withMCPClient(executable, endpoint, sessionId, (_call, tool) => check(tool));
      return await check();
    } finally { await owner.client.finalizeTabs([]); owner.close(); }
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
  await test("js-screencast-concurrency", async () => {
    sourceIdentity.testHooks.push("screencast concurrency: exact-tab native command/frame recorder and first actual screenshot ACK delivery gate; two public SDK connections share one scope, a same-client read barrier and 300ms controlled overlap are not queue-admission/native-execution proof; actual stream command ordering, frames, public ACKs and PNG pixels are checked; no simulated result/frame, production private queue wrapper, focus allowance or natural failure/performance claim");
    return checkScreencastConcurrency({
      connectBrowser: () => connectOpenBrowserUse({ socketPath: endpoint, sessionId: "js-screencast-concurrency", turnId: "native-stream-concurrency", timeoutMs: 20000 }),
      worker, fixtureURL,
      saveScreenshot: (name, bytes) => fs.writeFile(path.join(runDir, name), bytes, { flag: "wx" }),
      saveDetail: detail => fs.writeFile(path.join(runDir, "screencast-concurrency.json"), JSON.stringify(detail, null, 2))
    });
  });
  await test("js-pointer-delivery", async () => {
    sourceIdentity.testHooks.push("pointer delivery controlled negative: exact-tab root mouseMoved calls receive explicitly synthetic ACKs without native dispatch (first or all moves); other native calls preserve receiver/parameters/Promise; real child event ledgers, once-only buttons, server POST and ordinary navigation checked; no natural Viz reproduction or CDP-to-DOM authentication claim");
    const owner = await connectOpenBrowserUse({ socketPath: endpoint, sessionId: "js-pointer-delivery", turnId: "pre-press-delivery", timeoutMs: 20000 });
    const detail = {}; let failure;
    try { await checkPointerDelivery({ browser: owner, worker, fixtureURL, server: pointerDeliveryFixtures, until, detail }); }
    catch (error) { failure = error; }
    await finishChooserCase({ detail, originalError: failure, cleanup: [
      { name: "finalize-pointer-tabs", run: async () => { detail.finalize = await owner.client.finalizeTabs([]); } },
      { name: "close-pointer-client", run: () => owner.close() }
    ], save: async value => {
      await fs.writeFile(path.join(runDir, "pointer-delivery.json"), JSON.stringify(value, null, 2));
      await fs.writeFile(path.join(runDir, "pointer-delivery-server.json"), JSON.stringify(pointerDeliveryFixtures.allStats(), null, 2));
    } });
    if (failure) throw failure;
    return detail;
  });
  await test("js-pointer-transformed-frames", async () => {
    sourceIdentity.testHooks.push("transformed iframe input: transparent exact-tab native Input invocation/settlement recorder; fresh same-origin, OOPIF and nested fixtures retain trusted DOM events and original POST bytes; synchronous fixture hover/first-click parent mutations exercise ancestor rejection without changing native commands; no input simulation, new focus allowance or atomic-layout claim");
    const owner = await connectOpenBrowserUse({ socketPath: endpoint, sessionId: "js-pointer-transformed-frames", turnId: "transformed-frame-input", timeoutMs: 20000 });
    const detail = {}; let failure;
    try { await checkTransformedPointer({ browser: owner, worker, fixtureURL, server: transformedPointerFixtures, until, detail }); }
    catch (error) { failure = error; }
    await finishChooserCase({ detail, originalError: failure, cleanup: [
      { name: "finalize-transformed-pointer-tabs", run: async () => { detail.finalize = await owner.client.finalizeTabs([]); } },
      { name: "close-transformed-pointer-client", run: () => owner.close() },
      { name: "verify-transformed-pointer-cleanup", run: async () => {
        detail.finalNative = await worker.evaluate(`(async()=>({tabs:await chrome.tabs.query({}),targets:await chrome.debugger.getTargets()}))()`);
        for (const item of detail.cases ?? []) {
          assert.ok(!detail.finalNative.tabs.some(tab => tab.id === item.tabId), "Transformed task tab remains after finalize");
          const urls = Object.values(item.urls ?? {}).filter(Boolean);
          assert.ok(!detail.finalNative.targets.some(target => urls.includes(target.url)), "Transformed task target remains after finalize");
        }
      } }
    ], save: async value => {
      await fs.writeFile(path.join(runDir, "pointer-transformed-frames.json"), JSON.stringify(value, null, 2));
      await fs.writeFile(path.join(runDir, "pointer-transformed-server.json"), JSON.stringify(transformedPointerFixtures.allStats(), null, 2));
    } });
    if (failure) throw failure;
    return detail;
  });
  await test("js-element-position-geometry", async () => {
    sourceIdentity.testHooks.push("element position geometry: transparent exact-tab native Input recorder; fixed fixture layout witnesses and trusted original-node pointer events plus original POST bodies verify local hotspots; synchronous hover/first-click element transforms exercise preparation and post-commit rejection; no new focus allowance");
    const owner = await connectOpenBrowserUse({ socketPath: endpoint, sessionId: "js-element-position-geometry", turnId: "element-position-input", timeoutMs: 20000 });
    const detail = {}; let failure;
    try { await checkElementPosition({ browser: owner, worker, fixtureURL, server: elementPositionFixtures, until, detail }); }
    catch (error) { failure = error; }
    await finishChooserCase({ detail, originalError: failure, cleanup: [
      { name: "finalize-element-position-tabs", run: async () => { detail.finalize = await owner.client.finalizeTabs([]); } },
      { name: "close-element-position-client", run: () => owner.close() },
      { name: "verify-element-position-cleanup", run: async () => {
        detail.finalNative = await worker.evaluate(`(async()=>({tabs:await chrome.tabs.query({}),targets:await chrome.debugger.getTargets()}))()`);
        for (const item of detail.cases ?? []) {
          assert.ok(!detail.finalNative.tabs.some(tab => tab.id === item.tabId), "Element position task tab remains after finalize");
          const urls = Object.values(item.urls ?? {}).filter(Boolean);
          assert.ok(!detail.finalNative.targets.some(target => urls.includes(target.url)), "Element position task target remains after finalize");
        }
      } }
    ], save: async value => {
      await fs.writeFile(path.join(runDir, "element-position.json"), JSON.stringify(value, null, 2));
      await fs.writeFile(path.join(runDir, "element-position-server.json"), JSON.stringify(elementPositionFixtures.allStats(), null, 2));
    } });
    if (failure) throw failure;
    return detail;
  });
  await test("js-pointer-counted-delivery", async () => {
    sourceIdentity.testHooks.push("counted pointer delivery: exact-tab native input invocation/settlement recorder; one OOPIF scenario explicitly drops only the first root mouseMoved with synthetic ACK; real trusted multi-click/modifier events, exact button counts, server POST and first-click navigation checked; read-only tab/document commit observations after partial navigation share the original action deadline while the native probe stays installed; no natural Viz reproduction, CDP-to-DOM authentication or new focus allowance");
    const owner = await connectOpenBrowserUse({ socketPath: endpoint, sessionId: "js-pointer-counted-delivery", turnId: "counted-pre-press-delivery", timeoutMs: 20000 });
    const detail = {}; let failure;
    try { await checkCountedPointerDelivery({ browser: owner, worker, fixtureURL, server: pointerDeliveryFixtures, until, detail }); }
    catch (error) { failure = error; }
    await finishChooserCase({ detail, originalError: failure, cleanup: [
      { name: "finalize-counted-pointer-tabs", run: async () => { detail.finalize = await owner.client.finalizeTabs([]); } },
      { name: "close-counted-pointer-client", run: () => owner.close() }
    ], save: async value => {
      await fs.writeFile(path.join(runDir, "pointer-counted-delivery.json"), JSON.stringify(value, null, 2));
      await fs.writeFile(path.join(runDir, "pointer-counted-delivery-server.json"), JSON.stringify(pointerDeliveryFixtures.allStats(), null, 2));
    } });
    if (failure) throw failure;
    return detail;
  });
  let directUploadFiles;
  for (const kind of ["js", "cli", "mcp", "python", "go"]) await test(`${kind}-direct-locator-upload`, async () => {
    sourceIdentity.testHooks.push(`direct locator ${kind}: exact-tab bounded native command/settlement and frame observer starts after public tab creation, before goto; typed callers use bounded start/finish JSONL preparation acknowledgements, separate from each original 10-second action deadline; original receiver/Promise/arguments retained, scheduling may change; parent only observes and checks original file/POST bytes, never performs business actions; no chooser, input synthesis or cold timing claim`);
    const detail = {}; let failure;
    try {
      directUploadFiles ??= await prepareDirectLocatorUploadFiles(runDir);
      let goBinary, pythonSource;
      if (["python", "go"].includes(kind)) {
        const source = path.join(directory, kind === "python" ? "direct-locator-upload-checks.py" : "go-direct-locator-upload-checks/main.go");
        const frozen = path.join(runDir, kind === "python" ? "direct-locator-upload-checks.py" : "direct-locator-upload-checks.go");
        await fs.copyFile(source, frozen, fsConstants.COPYFILE_EXCL);
        detail.proof = { sourceSHA256: createHash("sha256").update(await fs.readFile(frozen)).digest("hex") };
        if (kind === "python") pythonSource = frozen;
        else {
          assert.ok(process.env.OBU_TEST_GO_LOCATOR_UPLOAD_BINARY, "Set OBU_TEST_GO_LOCATOR_UPLOAD_BINARY for typed Go direct uploads");
          goBinary = path.join(runDir, process.platform === "win32" ? "go-direct-locator-upload.exe" : "go-direct-locator-upload");
          await fs.copyFile(process.env.OBU_TEST_GO_LOCATOR_UPLOAD_BINARY, goBinary, fsConstants.COPYFILE_EXCL);
          detail.proof.binarySHA256 = createHash("sha256").update(await fs.readFile(goBinary)).digest("hex");
          sourceIdentity.sha256.goLocatorUploadClient = detail.proof.binarySHA256;
        }
      }
      await checkDirectLocatorUpload({ kind, worker, files: directUploadFiles, server: directUploads,
        fixtureURL, endpoint, connectOpenBrowserUse, executable, subprocess, withMCPClient, runDir, detail,
        pythonExecutable: process.env.OBU_TEST_PYTHON || "python", pythonSource, goExecutable: goBinary,
        env: { ...process.env, PYTHONPATH: path.dirname(pythonSnapshot), PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8", PYTHONDONTWRITEBYTECODE: "1" } });
    } catch (error) { failure = error; }
    await finishChooserCase({ detail, originalError: failure, cleanup: [], save: async value => {
      await fs.writeFile(path.join(runDir, `direct-locator-${kind}.json`), JSON.stringify(value, null, 2), { flag: "wx" });
      await fs.writeFile(path.join(runDir, `direct-locator-${kind}-server.json`), JSON.stringify(directUploads.allStats(), null, 2), { flag: "wx" });
    } });
    if (failure) throw failure;
    return detail;
  });
  await test("js-direct-locator-directory", async () => {
    sourceIdentity.testHooks.push("direct locator directory: same bounded original native observer and byte/receipt checks; public backgroundWindow creation gets only the existing exact own-first-tab activation allowance, no window focus allowance; final native inventory verifies that task window/tab/debugger targets are removed");
    const owner = await connectOpenBrowserUse({ socketPath: endpoint, sessionId: "js-direct-locator-directory", turnId: "direct-directory", timeoutMs: 15000 });
    const recorder = backgroundWindowRecorder(owner), detail = {}; let failure;
    try {
      detail.initialControl = await owner.client.beginTurn();
      await checkDirectLocatorDirectory({ browser: owner, worker, fixtureURL, server: directUploads,
        files: await getDirectoryFiles(), detail, createTab: () => recorder.createTab() });
    } catch (error) { failure = error; }
    detail.backgroundWindows = recorder.records;
    await finishChooserCase({ detail, originalError: failure, cleanup: [
      { name: "verify-direct-directory-cleanup", run: () => until(async () => {
        detail.cleanup = await readBackgroundWindowState(); checkBackgroundWindowCleanup(detail.cleanup, recorder.records); return true;
      }, "direct directory tabs/windows removed", 5000) },
      { name: "close-direct-directory-client", run: () => owner.close() }
    ], save: async value => {
      await fs.writeFile(path.join(runDir, "direct-locator-directory.json"), JSON.stringify(value, null, 2), { flag: "wx" });
      await fs.writeFile(path.join(runDir, "direct-locator-directory-server.json"), JSON.stringify(directUploads.allStats(), null, 2), { flag: "wx" });
    } });
    if (failure) throw failure;
    return detail;
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
        windowsHide: true, env: { ...process.env, PYTHONPATH: path.dirname(pythonSnapshot), PYTHONIOENCODING: "utf-8", OBU_TEST_DOWNLOAD_ROOT: path.join(runDir, "downloads"), OBU_TEST_EXPORT_ROOT: runDir }, stdio: ["ignore", "pipe", "pipe"]
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
    const result = JSON.parse(await subprocess(goExecutable, [endpoint, fixtureURL], { timeoutMs: 120000, env: { ...process.env, OBU_TEST_DOWNLOAD_ROOT: path.join(runDir, "downloads"), OBU_TEST_EXPORT_ROOT: runDir } }));
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
  await test("js-drag-commit", async () => {
    sourceIdentity.testHooks.push("drag commit: transparent exact-tab native Input recorder and passive original-document event/POST witnesses; dynamic source/destination business handlers; no new focus allowance");
    const owner = await connectOpenBrowserUse({ socketPath: endpoint, sessionId: "js-drag-commit", turnId: "drag-delivery-commit", timeoutMs: 20000 });
    const detail = {}; let failure;
    try { await checkDragCommit({ browser: owner, worker, fixtureURL, server: dragCommitFixtures, until, detail }); }
    catch (error) { failure = error; }
    await finishChooserCase({ detail, originalError: failure, cleanup: [
      { name: "finalize-drag-commit-tabs", run: () => owner.client.finalizeTabs([]) },
      { name: "close-drag-commit-client", run: () => owner.close() },
      { name: "verify-drag-commit-cleanup", run: async () => {
        detail.finalNative = await worker.evaluate(`(async()=>({tabs:await chrome.tabs.query({}),targets:await chrome.debugger.getTargets()}))()`);
        for (const item of detail.cases ?? []) {
          assert.ok(!detail.finalNative.tabs.some(tab => tab.id === item.tabId), "Drag task tab remains after finalize");
          const urls = Object.values(item.urls ?? {}).filter(value => typeof value === "string");
          assert.ok(!detail.finalNative.targets.some(target => urls.includes(target.url)), "Drag task target remains after finalize");
        }
      } }
    ], save: async value => {
      await fs.writeFile(path.join(runDir, "drag-commit.json"), JSON.stringify(value, null, 2));
      await fs.writeFile(path.join(runDir, "drag-commit-server.json"), JSON.stringify(dragCommitFixtures.allStats(), null, 2));
    } });
    if (failure) throw failure;
    return detail;
  });
  for (const kind of sdkConnectionKinds) await test(`${kind}-sdk-connection-identity`, async () => {
    const detail = { kind };
    try {
      sourceIdentity.testHooks.push(`${kind} SDK connection identity: transparent local byte relay to the real host; original idle connection cut or explicitly closed; no native Port, epoch, browser ownership or focus allowance changes`);
      let command, args = [], artifact;
      const env = { ...process.env, PYTHONPATH: path.dirname(pythonSnapshot), PYTHONUTF8: "1", OBU_JS_SDK_ENTRY: path.join(jsSnapshot, "index.js") };
      if (kind === "go") {
        assert.ok(process.env.OBU_TEST_GO_CONNECTION_BINARY, "Set OBU_TEST_GO_CONNECTION_BINARY for Go SDK connection acceptance");
        artifact = path.join(runDir, process.platform === "win32" ? "go-sdk-connection.exe" : "go-sdk-connection");
        await fs.copyFile(process.env.OBU_TEST_GO_CONNECTION_BINARY, artifact, fsConstants.COPYFILE_EXCL); command = artifact;
      } else {
        artifact = path.join(runDir, kind === "js" ? "sdk-connection-js.mjs" : "sdk-connection-python.py");
        await fs.copyFile(path.join(directory, path.basename(artifact)), artifact, fsConstants.COPYFILE_EXCL);
        command = kind === "js" ? process.execPath : process.env.OBU_TEST_PYTHON || "python"; args = kind === "js" ? [artifact] : ["-u", artifact];
      }
      detail.callerSHA256 = createHash("sha256").update(await fs.readFile(artifact)).digest("hex");
      return await checkSDKConnections({ kind, commands: { command, args, env }, detail, fixtureURL, server: sdkConnectionFixtures,
        socketDir, endpoint, until, worker, connect: sessionId => connectOpenBrowserUse({ socketPath: endpoint, sessionId, timeoutMs: 15000 }) });
    } finally {
      await fs.writeFile(path.join(runDir, `sdk-connection-${kind}.json`), JSON.stringify(detail, null, 2));
      await fs.writeFile(path.join(runDir, "sdk-connection-server.json"), JSON.stringify(sdkConnectionFixtures.allStats(), null, 2));
    }
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
  await test("js-media-downloads", async () => {
    const owner = await connectOpenBrowserUse({socketPath:endpoint,sessionId:"media-js",timeoutMs:15000});
    const foreign = await connectOpenBrowserUse({socketPath:endpoint,sessionId:"media-foreign",timeoutMs:15000});
    try {
      const detail = await checkMediaDownloads({browser:owner,foreignBrowser:foreign,fixtureURL,server:mediaDownloads,downloadRoot:path.join(runDir,"downloads")});
      await fs.writeFile(path.join(runDir,"media-js.json"),JSON.stringify(detail,null,2));
      return detail;
    } finally { try { await owner.client.finalizeTabs([]); await foreign.client.finalizeTabs([]); } finally { owner.close();foreign.close(); } }
  });
  await test("js-media-downloads-references", async () => {
    const owner = await connectOpenBrowserUse({ socketPath: endpoint, sessionId: "media-references", timeoutMs: 15000 });
    let detail, failure;
    try {
      detail = await checkMediaReferences({ browser: owner, fixtureURL, server: mediaDownloads, downloadRoot: path.join(runDir, "downloads") });
    } catch (error) { failure = error; }
    finally {
      try { await owner.client.finalizeTabs([]); }
      catch (error) { if (failure) failure.finalizeError = error.message; else failure = error; }
      finally { owner.close(); }
    }
    await fs.writeFile(path.join(runDir, "media-references.json"), JSON.stringify(failure ? {
      failed: true, error: failure.message, finalizeError: failure.finalizeError, detail: failure.mediaReferences ?? detail
    } : detail, null, 2));
    if (failure) throw failure;
    return detail;
  });
  for (const [name, check] of [["lifecycle", checkMediaLifecycle], ["navigation-cleanup", checkMediaNavigationCleanup]]) {
    await test(`js-media-downloads-${name}`, async () => {
      const owner = await connectOpenBrowserUse({ socketPath: endpoint, sessionId: `media-${name}`, timeoutMs: 15000 });
      const artifact = path.join(runDir, `media-${name}.json`);
      sourceIdentity.testHooks.push(`media ${name}: Runtime.callFunctionOn response delivery held after actual native settlement; exact-tab native navigation mutation and fixed read-only MAIN-world scripting evidence`);
      let detail, failure;
      try {
        detail = await check({ browser: owner, fixtureURL, server: mediaDownloads, worker, until });
      } catch (error) { failure = error; }
      finally {
        try { await owner.client.finalizeTabs([]); }
        catch (error) { if (failure) failure.finalizeError = error.message; else failure = error; }
        finally { owner.close(); }
      }
      await fs.writeFile(artifact, JSON.stringify(failure ? {
        failed: true, error: failure.message, finalizeError: failure.finalizeError, detail: failure.mediaLifecycle ?? detail
      } : detail, null, 2));
      if (failure) throw failure;
      return detail;
    });
  }
  await test("js-media-read-cancellation", async () => {
    const owner = await connectOpenBrowserUse({ socketPath: endpoint, sessionId: "media-read-lifecycle", timeoutMs: 15000 });
    sourceIdentity.testHooks.push("media read cancellation: exact utility fetch AbortSignal gate keeps actual renderer read pending; native Port observer records cleanup state synchronously before turnEnded acknowledgement; native download observer is passive");
    let detail, failure;
    try { detail = await checkMediaReadCancellation({ browser: owner, fixtureURL, server: mediaDownloads, worker, until }); }
    catch (error) { failure = error; }
    finally { owner.close(); }
    await fs.writeFile(path.join(runDir, "media-read-cancellation.json"), JSON.stringify(failure ? {
      failed: true, error: failure.message, detail: failure.mediaContentEvidence ?? detail
    } : detail, null, 2));
    if (failure) throw failure;
    return detail;
  });
  for (const kind of ["cli","mcp"]) await test(`${kind}-media-downloads`, async () => {
    const sessionId = `media-${kind}`, owner = await connectOpenBrowserUse({socketPath:endpoint,sessionId,timeoutMs:15000});
    try {
      const tab = await owner.newTab({url:fixtureURL+"media-downloads/page"});
      await tab.waitForLoadState({state:"load"});
      const scope = {session_id:sessionId,turn_id:owner.client.turnId,control_epoch:owner.client.controlEpoch};
      const check = async call => {
        const before = mediaDownloads.stats().length;
        const ack = await call("downloadMedia",{...scope,tabId:tab.id,locator:[{kind:"css",selector:"#selected"}],filename:`${kind}-media.png`,timeoutMs:5000});
        const result = await call("downloadPath",{...scope,downloadId:ack.downloadId,timeoutMs:5000});
        const file = await verifyMediaFile(result.path,path.join(runDir,"downloads"));
        assert.deepEqual(await call("cancelDownload",{...scope,downloadId:ack.downloadId,timeoutMs:5000}),{cancelled:true});
        const requests = mediaDownloads.stats().slice(before);
        assert.equal(requests.length,1);assert.equal(requests[0].path,"/media-downloads/selected.png");assert.equal(requests[0].cookie,true);
        assert.deepEqual(await tab.evaluate("({events:mediaEvents,traps:getterTraps})"),{events:[],traps:[]});
        return {file,requests,scope};
      };
      const detail = kind === "mcp" ? await withMCPClient(executable,endpoint,sessionId,check) : await check(async (method,params) => {
        const response = JSON.parse(await subprocess(path.resolve(executable),["call","--socket",endpoint,"--session-id",sessionId,"--method",method,"--params",JSON.stringify(params),"--timeout","15s"]));
        assert.equal(response.error,undefined,JSON.stringify(response));return response.result;
      });
      await fs.writeFile(path.join(runDir,`media-${kind}.json`),JSON.stringify(detail,null,2));return detail;
    } finally {try {await owner.client.finalizeTabs([]);} finally {owner.close();}}
  });
  for (const kind of ["python","go"]) await test(`${kind}-media-downloads`, async () => {
    const script = path.join(directory, kind === "python" ? "media-checks.py" : "go-media-checks/main.go");
    const frozenSource = path.join(runDir, kind === "python" ? "media-checks.py" : "media-checks.go");
    await fs.copyFile(script,frozenSource,fsConstants.COPYFILE_EXCL);
    const artifact = path.join(runDir,`media-${kind}.json`);
    let executablePath = process.env.OBU_TEST_PYTHON || "python", args = [frozenSource,endpoint,fixtureURL,artifact];
    const proof = {sourceSHA256:createHash("sha256").update(await fs.readFile(frozenSource)).digest("hex")};
    if (kind === "go") {
      assert.ok(process.env.OBU_TEST_GO_MEDIA_BINARY,"Set OBU_TEST_GO_MEDIA_BINARY for the media Go caller");
      executablePath=path.join(runDir,"go-media-client.exe");
      await fs.copyFile(process.env.OBU_TEST_GO_MEDIA_BINARY,executablePath,fsConstants.COPYFILE_EXCL);
      args=[endpoint,fixtureURL,artifact];proof.binarySHA256=createHash("sha256").update(await fs.readFile(executablePath)).digest("hex");
    }
    const result=JSON.parse(await subprocess(executablePath,args,{timeoutMs:45000,env:{...process.env,PYTHONPATH:path.dirname(pythonSnapshot),PYTHONIOENCODING:"utf-8",PYTHONDONTWRITEBYTECODE:"1",OBU_TEST_DOWNLOAD_ROOT:path.join(runDir,"downloads")}}));
    assert.equal(result.passed,true);assert.deepEqual(Buffer.from(result.base64,"base64"),mediaPNG);
    const file=await verifyMediaFile(result.path,path.join(runDir,"downloads"));
    assert.equal(result.sha256,file.sha256);assert.equal(result.bytes,file.bytes);
    await fs.writeFile(path.join(runDir,`media-${kind}-proof.json`),JSON.stringify(proof,null,2));
    return {...result,proof};
  });
  for (const [name, check] of [["js-media-breadth", checkEmbeddedMedia], ["js-media-breadth-negative", checkEmbeddedMediaNegative]]) {
    await test(name, async () => {
      const owner = await connectOpenBrowserUse({ socketPath: endpoint, sessionId: name, timeoutMs: 20000 });
      const foreign = await connectOpenBrowserUse({ socketPath: endpoint, sessionId: `${name}-foreign`, timeoutMs: 15000 });
      try {
        return await check({ browser: owner, foreignBrowser: foreign, fixtureURL, server: embeddedMedia,
          worker, downloadRoot: path.join(runDir, "downloads"),
          saveDetail: detail => fs.writeFile(path.join(runDir, `${name}.json`), JSON.stringify(detail, null, 2)) });
      } finally {
        const cleanup = await Promise.allSettled([owner.client.finalizeTabs([]), foreign.client.finalizeTabs([])]);
        owner.close(); foreign.close();
        const errors = cleanup.filter(item => item.status === "rejected");
        if (errors.length) throw new AggregateError(errors.map(item => item.reason), `${name} finalization failed`);
      }
    });
  }
  for (const kind of ["cli", "mcp"]) await test(`${kind}-media-breadth`, async () => {
    const sessionId = `media-breadth-${kind}`, owner = await connectOpenBrowserUse({ socketPath: endpoint, sessionId, timeoutMs: 20000 });
    const detail = { caller: kind };
    try {
      const { tab, readiness } = await prepareEmbeddedMediaTab(owner, fixtureURL);
      Object.assign(detail, { tabId: tab.id, readiness });
      const scope = { session_id: sessionId, turn_id: owner.client.turnId, control_epoch: owner.client.controlEpoch };
      detail.scope = scope;
      const check = async call => {
        const before = embeddedMedia.stats().length;
        const mediaKind = kind === "cli" ? "webm" : "canvas", selector = kind === "cli" ? "#data-webm" : "#canvas";
        const ack = await call("downloadMedia", { ...scope, tabId: tab.id, locator: [{ kind: "css", selector }], filename: `breadth-${kind}.${mediaKind === "canvas" ? "png" : "webm"}`, timeoutMs: 5000 });
        detail.downloadId = ack.downloadId;
        try {
          const result = await call("downloadPath", { ...scope, downloadId: ack.downloadId, timeoutMs: 5000 });
          detail.file = await verifyEmbeddedMediaFile(result.path, path.join(runDir, "downloads"), mediaKind, readiness.canvasBase64);
        } finally {
          detail.cancel = await call("cancelDownload", { ...scope, downloadId: ack.downloadId, timeoutMs: 5000 });
          assert.deepEqual(detail.cancel, { cancelled: true });
        }
        detail.requests = embeddedMedia.stats().slice(before); assert.deepEqual(detail.requests, []);
        detail.frames = await readMediaFrameEvidence(worker, tab.id);
        return detail;
      };
      return kind === "mcp" ? await withMCPClient(executable, endpoint, sessionId, check) : await check(async (method, params) => {
        const response = JSON.parse(await subprocess(path.resolve(executable), ["call", "--socket", endpoint, "--session-id", sessionId, "--method", method, "--params", JSON.stringify(params), "--timeout", "15s"]));
        assert.equal(response.error, undefined, JSON.stringify(response)); return response.result;
      });
    } finally {
      await fs.writeFile(path.join(runDir, `media-breadth-${kind}.json`), JSON.stringify(detail, null, 2));
      try { await owner.client.finalizeTabs([]); } finally { owner.close(); }
    }
  });
  for (const kind of ["python", "go"]) await test(`${kind}-media-breadth`, async () => {
    const script = path.join(directory, kind === "python" ? "media-checks.py" : "go-media-checks/main.go");
    const frozenSource = path.join(runDir, kind === "python" ? "media-breadth-checks.py" : "media-breadth-checks.go");
    await fs.copyFile(script, frozenSource, fsConstants.COPYFILE_EXCL);
    const artifact = path.join(runDir, `media-breadth-${kind}.json`);
    let executablePath = process.env.OBU_TEST_PYTHON || "python", args = [frozenSource, endpoint, fixtureURL, artifact];
    const proof = { sourceSHA256: createHash("sha256").update(await fs.readFile(frozenSource)).digest("hex") };
    if (kind === "go") {
      assert.ok(process.env.OBU_TEST_GO_MEDIA_BINARY, "Set OBU_TEST_GO_MEDIA_BINARY for the media Go caller");
      executablePath = path.join(runDir, "go-media-breadth-client.exe");
      await fs.copyFile(process.env.OBU_TEST_GO_MEDIA_BINARY, executablePath, fsConstants.COPYFILE_EXCL);
      args = [endpoint, fixtureURL, artifact]; proof.binarySHA256 = createHash("sha256").update(await fs.readFile(executablePath)).digest("hex");
    }
    await fs.writeFile(path.join(runDir, `media-breadth-${kind}-proof.json`), JSON.stringify(proof, null, 2));
    const before = embeddedMedia.stats().length;
    const result = JSON.parse(await subprocess(executablePath, args, { timeoutMs: 60000, env: { ...process.env,
      PYTHONPATH: path.dirname(pythonSnapshot), PYTHONIOENCODING: "utf-8", PYTHONDONTWRITEBYTECODE: "1",
      OBU_TEST_MEDIA_VARIANT: "breadth", OBU_TEST_DOWNLOAD_ROOT: path.join(runDir, "downloads") } }));
    assert.equal(result.passed, true);
    assert.equal(result.kind, kind === "python" ? "wav" : "canvas");
    const file = await verifyEmbeddedMediaFile(result.path, path.join(runDir, "downloads"), result.kind, result.readiness.canvasBase64);
    assert.equal(result.sha256, file.sha256); assert.equal(result.bytes, file.bytes);
    assert.deepEqual(Buffer.from(result.base64, "base64"), await fs.readFile(file.path));
    assert.deepEqual(result.page, { events: [], traps: [] });
    const requests = embeddedMedia.stats().slice(before);
    assert.equal(requests.some(request => request.path === "/media-breadth/poison"), false);
    const counts = Object.fromEntries(["page", "selected.wav", "selected.webm"].map(name => [name, requests.filter(request => request.path === `/media-breadth/${name}`).length]));
    assert.deepEqual(counts, { page: 4, "selected.wav": 4, "selected.webm": 4 }, "Expected only the four documents and their native preload requests");
    assert.equal(requests.length, 12); assert.ok(requests.every(request => request.method === "GET"));
    return { ...result, proof, requests };
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
  for (const [kind, variant] of [["js", 1], ["js", 2], ["js", 3], ["cli", 1], ["mcp", 1]]) {
    await test(`${kind}-form-workflow-v${variant}`, async () => {
      const key = `${kind}-form-${variant}-${randomUUID()}`, sessionId = key, calls = [];
      const artifact = path.join(runDir, `form-workflow-${kind}-v${variant}.json`);
      const route = kind === "js" ? "typed JS SDK" : `${kind.toUpperCase()} browserAction with descriptors produced by typed JS Locator builders`;
      let owner, detail, failure, scope;
      try {
        owner = await connectOpenBrowserUse({ socketPath: endpoint, sessionId, timeoutMs: 15000 });
        await owner.client.beginTurn();
        scope = Object.freeze({ session_id: sessionId, turn_id: owner.client.turnId, control_epoch: owner.client.controlEpoch });
        assert.ok(Number.isSafeInteger(scope.control_epoch) && scope.control_epoch > 0);
        const runWorkflow = async call => {
          if (call) owner.client.browserAction = async (tabId, action, options = {}) => {
            assert.equal(owner.client.turnId, scope.turn_id);
            assert.equal(owner.client.controlEpoch, scope.control_epoch);
            const params = { ...scope, tabId, action, ...(options.locator ? { locator: options.locator } : {}),
              ...(options.args ? { args: options.args } : {}), timeoutMs: options.timeoutMs ?? 10000 };
            const witness = { index: calls.length, params: structuredClone(params), startedAt: performance.now() };
            calls.push(witness);
            try {
              const response = await call("browserAction", params);
              assert.ok(response && Object.hasOwn(response, "value"));
              assert.equal(response.engine?.name, "playwright-crx");
              witness.passed = true;
              return response;
            } catch (error) { witness.error = String(error); throw error; }
            finally { witness.elapsedMs = performance.now() - witness.startedAt; }
          };
          return checkFormWorkflow({ browser: owner, fixtureURL: new URL(`/form-task/${key}`, fixtureURL).href,
            server: formWorkflows, variant, key,
            onReceipt: async (receiptTab, receiptDetail) => {
              const screenshot = await receiptTab.screenshot({ type: "png", timeoutMs: 10000 });
              assert.equal(screenshot.mimeType, "image/png");
              const image = pngDimensions(screenshot.base64), filename = `form-workflow-${kind}-v${variant}-receipt.png`;
              await fs.writeFile(path.join(runDir, filename), image.bytes, { flag: "wx" });
              receiptDetail.screenshot = { filename, bytes: image.bytes.length, width: image.width, height: image.height,
                sha256: createHash("sha256").update(image.bytes).digest("hex") };
            } });
        };
        if (kind === "mcp") detail = await withMCPClient(executable, endpoint, sessionId, runWorkflow);
        else if (kind === "cli") detail = await runWorkflow(async (method, params) => {
          const envelope = JSON.parse(await subprocess(path.resolve(executable), ["call", "--socket", endpoint,
            "--session-id", sessionId, "--method", method, "--params", JSON.stringify(params), "--timeout", "15s"]));
          assert.equal(envelope.error, undefined, JSON.stringify(envelope.error));
          return envelope.result;
        });
        else detail = await runWorkflow();
        if (kind !== "js") {
          assert.ok(calls.some(call => call.params.action === "selectOption"));
          assert.ok(calls.some(call => call.params.action === "click"));
          assert.ok(calls.every(call => call.passed), "Every workflow browserAction used the selected public transport successfully");
        }
      } catch (error) { failure = error; }
      finally {
        if (owner) {
          try { await owner.client.finalizeTabs([]); }
          catch (error) { if (failure) failure.finalizeError = String(error); else failure = error; }
          finally { owner.close(); }
        }
      }
      const evidence = { ...(failure?.formWorkflow ?? detail ?? {}), key, variant, route, scope, calls,
        setupAndCleanup: "JS SDK connection, explicit beginTurn, newTab/goto, navigation waiter and tab/session cleanup; all fixture Locator operations and receipt screenshots use the selected browserAction entry",
        finalLedger: formWorkflows.stats(key), ...(failure ? { failed: true, error: String(failure), finalizeError: failure.finalizeError } : {}) };
      await fs.writeFile(artifact, JSON.stringify(evidence, null, 2));
      if (failure) { failure.formWorkflow = evidence; throw failure; }
      return evidence;
    });
  }
  for (const kind of ["python", "go"]) await test(`${kind}-form-workflow`, async () => {
    const source = path.join(directory, kind === "python" ? "form-workflow-checks.py" : "go-form-workflow-checks/main.go");
    const frozenSource = path.join(runDir, kind === "python" ? "form-workflow-checks.py" : "form-workflow-checks.go");
    const callerOutput = path.join(runDir, `form-workflow-${kind}-caller.json`), artifact = path.join(runDir, `form-workflow-${kind}.json`);
    const beforeKeys = new Set(formWorkflows.allStats().map(record => record.key));
    const proof = {}, baseURL = new URL("/", fixtureURL).href;
    let detail, failure, caller;
    try {
      await fs.copyFile(source, frozenSource, fsConstants.COPYFILE_EXCL);
      proof.sourceSHA256 = createHash("sha256").update(await fs.readFile(frozenSource)).digest("hex");
      let binary = process.env.OBU_TEST_PYTHON || "python", args = [frozenSource, endpoint, baseURL, callerOutput];
      if (kind === "go") {
        assert.ok(process.env.OBU_TEST_GO_FORM_BINARY, "Set OBU_TEST_GO_FORM_BINARY for the complete form Go caller");
        binary = path.join(runDir, process.platform === "win32" ? "go-form-workflow-client.exe" : "go-form-workflow-client");
        await fs.copyFile(process.env.OBU_TEST_GO_FORM_BINARY, binary, fsConstants.COPYFILE_EXCL);
        proof.binarySHA256 = createHash("sha256").update(await fs.readFile(binary)).digest("hex");
        sourceIdentity.sha256.goFormClient = proof.binarySHA256;
        args = [endpoint, baseURL, callerOutput];
      }
      const stdout = await subprocess(binary, args, { timeoutMs: 180000, env: { ...process.env,
        PYTHONPATH: path.dirname(pythonSnapshot), PYTHONIOENCODING: "utf-8", PYTHONDONTWRITEBYTECODE: "1" } });
      caller = JSON.parse(stdout);
      assert.deepEqual(JSON.parse(await fs.readFile(callerOutput, "utf8")), caller, "Caller stdout must match its retained artifact");
      assert.equal(caller.passed, true); assert.equal(caller.variant, 1); assert.match(caller.key, /^[A-Za-z0-9_-]{1,80}$/);
      assert.equal(beforeKeys.has(caller.key), false, "Each caller must use a fresh task key");
      const ledger = formWorkflows.stats(caller.key);
      const receipt = checkFormReceipt(caller.receipt, ledger, 1);
      assert.deepEqual(caller.evidence.receipt, ledger.receipt);
      assert.deepEqual(caller.evidence.posts, ledger.posts);
      assert.equal(formWorkflows.allStats().filter(record => !beforeKeys.has(record.key)).length, 1);
      detail = { ...caller, ...receipt, ledger, proof, route: `typed ${kind} SDK; independent Node receipt and server ledger validation` };
    } catch (error) { failure = error; }
    const evidence = failure ? { failed: true, error: String(failure), proof, caller,
      serverRecords: formWorkflows.allStats().filter(record => !beforeKeys.has(record.key)),
      failureEvidence: "Caller stderr and complete server records are retained; checker trace is available only when the checker emits its output artifact" } : detail;
    await fs.writeFile(artifact, JSON.stringify(evidence, null, 2));
    if (failure) { failure.formWorkflow = evidence; throw failure; }
    return detail;
  });
  for (const kind of ["js", "cli", "mcp", "python", "go"]) for (const variant of [1, 2, 3]) {
    await test(`${kind}-research-workflow-v${variant}`, async () => {
      const artifact = path.join(runDir, `research-workflow-${kind}-v${variant}.json`);
      const key = `${kind}-research-${variant}-${randomUUID()}`;
      const beforeKeys = new Set(researchWorkflows.allStats().map(record => record.key));
      const proof = {}, baseURL = new URL("/", fixtureURL).href;
      let caller, failure, lifecycle, checkedReceipt;
      // Passive, bounded independent observer; no task tab/page manipulation.
      const before = await focusObserver.evaluate(`(async()=>{
        if(globalThis.__researchLifecycle)throw new Error('Research observer already installed');
        const state={events:[],overflow:false};
        const record=event=>{if(state.events.length<256)state.events.push(event);else state.overflow=true};
        state.created=tab=>record({type:'created',at:Date.now(),tab});
        state.removed=(tabId,removeInfo)=>record({type:'removed',at:Date.now(),tabId,removeInfo});
        chrome.tabs.onCreated.addListener(state.created);chrome.tabs.onRemoved.addListener(state.removed);
        globalThis.__researchLifecycle=state;return chrome.tabs.query({});
      })()`);
      try {
        if (["js", "cli", "mcp"].includes(kind)) {
          caller = await checkResearchWorkflow({ kind, variant, key, fixtureURL: baseURL, endpoint, executable,
            connectOpenBrowserUse, subprocess, withMCPClient });
        } else {
          const source = path.join(directory, kind === "python" ? "research-workflow-checks.py" : "go-research-workflow-checks/main.go");
          const frozen = path.join(runDir, `research-workflow-${kind}-v${variant}.${kind === "python" ? "py" : "go"}`);
          const output = path.join(runDir, `research-workflow-${kind}-v${variant}-caller.json`);
          await fs.copyFile(source, frozen, fsConstants.COPYFILE_EXCL);
          proof.sourceSHA256 = createHash("sha256").update(await fs.readFile(frozen)).digest("hex");
          let binary = process.env.OBU_TEST_PYTHON || "python", args = [frozen, endpoint, baseURL, output, String(variant)];
          if (kind === "go") {
            assert.ok(process.env.OBU_TEST_GO_RESEARCH_BINARY, "Set OBU_TEST_GO_RESEARCH_BINARY for complete research tasks");
            binary = path.join(runDir, `go-research-workflow-v${variant}${process.platform === "win32" ? ".exe" : ""}`);
            await fs.copyFile(process.env.OBU_TEST_GO_RESEARCH_BINARY, binary, fsConstants.COPYFILE_EXCL);
            proof.binarySHA256 = createHash("sha256").update(await fs.readFile(binary)).digest("hex");
            args = [endpoint, baseURL, output, String(variant)];
          }
          try {
            const stdout = await subprocess(binary, args, { timeoutMs: 180000, env: { ...process.env,
              PYTHONPATH: path.dirname(pythonSnapshot), PYTHONIOENCODING: "utf-8", PYTHONDONTWRITEBYTECODE: "1" } });
            caller = JSON.parse(stdout);
            assert.deepEqual(JSON.parse(await fs.readFile(output, "utf8")), caller);
          } catch (error) {
            try { caller = JSON.parse(await fs.readFile(output, "utf8")); } catch {}
            throw error;
          }
        }
        assert.equal(caller.caller, kind);
        assert.equal(caller.variant, variant);
        assert.ok(caller.screenshot, "Retain the visible final report");
        assert.equal(beforeKeys.has(caller.key), false);
        assert.equal(researchWorkflows.allStats().filter(record => !beforeKeys.has(record.key)).length, 1);
        checkedReceipt = checkResearchReceipt(caller.receipt, researchWorkflows.stats(caller.key));
      } catch (error) { failure = error; caller ??= error.researchWorkflow; }
      finally {
        try {
          const observation = await focusObserver.evaluate(`(async()=>{
            const state=globalThis.__researchLifecycle;if(!state)throw new Error('Missing research observer');
            try{return{after:await chrome.tabs.query({}),events:state.events,overflow:state.overflow}}
            finally{chrome.tabs.onCreated.removeListener(state.created);chrome.tabs.onRemoved.removeListener(state.removed);delete globalThis.__researchLifecycle}
          })()`);
          lifecycle = { before, ...observation };
          assert.equal(observation.overflow, false);
          if (!failure) checkResearchTabDisposition(caller, before, observation.after, observation.events, baseURL);
        } catch (error) { failure = failure ? new AggregateError([failure, error]) : error; }
      }
      if (caller?.screenshot) {
        const screenshot = caller.screenshot;
        const base64 = typeof screenshot === "string" ? screenshot : screenshot.base64;
        const filename = `research-workflow-${kind}-v${variant}-report.png`;
        try {
          if (base64) {
            const { bytes, width, height } = pngDimensions(base64);
            await fs.writeFile(path.join(runDir, filename), bytes);
            caller.screenshot = { filename, bytes: bytes.length, width, height, sha256: createHash("sha256").update(bytes).digest("hex") };
          } else {
            assert.equal(path.basename(screenshot.filename), screenshot.filename);
            const bytes = await fs.readFile(path.join(runDir, screenshot.filename));
            const dimensions = pngDimensions(bytes.toString("base64"));
            assert.equal(screenshot.bytes, bytes.length);
            assert.equal(screenshot.sha256, createHash("sha256").update(bytes).digest("hex"));
            assert.equal(screenshot.width, dimensions.width); assert.equal(screenshot.height, dimensions.height);
          }
        } catch (error) { failure ??= error; }
      }
      const evidence = { caller, proof, lifecycle, checkedReceipt,
        serverRecords: researchWorkflows.allStats().filter(record => !beforeKeys.has(record.key)),
        ...(failure ? { failed: true, error: failure.stack ?? String(failure) } : {}) };
      await fs.writeFile(artifact, JSON.stringify(evidence, null, 2));
      if (failure) throw failure;
      return evidence;
    });
  }
  if (backgroundParallel) await test("js-background-parallel-long-idle", async () => {
    sourceIdentity.testHooks.push("background parallel: bounded passive original chrome.debugger command/event observer, restored after task; no native arguments/results or backend state changed");
    const artifact = path.join(runDir, "background-parallel.json");
    let detail, failure, checkpoints = 0, checkpointWrites = Promise.resolve();
    const save = async value => {
      const recorded = JSON.stringify(value, null, 2), serverRecorded = JSON.stringify(backgroundParallelFixture.allStats(), null, 2);
      checkpointWrites = checkpointWrites.then(async () => {
        await fs.writeFile(artifact, recorded);
        await fs.writeFile(path.join(runDir, "background-parallel-server.json"), serverRecorded);
      });
      await checkpointWrites;
      if (++checkpoints % 5 === 0) console.log("PROGRESS background-parallel", { checkpoint: checkpoints, elapsedMs: Date.now() - startedAt });
    };
    const startedAt = Date.now();
    try {
      detail = await checkBackgroundParallelWorkflow({ connectOpenBrowserUse, endpoint, fixtureURL,
        fixture: backgroundParallelFixture, worker, onCheckpoint: async value => {
          await save(value);
          await activeInvariant();
        },
        saveScreenshot: async (name, bytes) => {
          assert.equal(path.basename(name), name); assert.match(name, /^background-parallel-.*\.png$/);
          await fs.writeFile(path.join(runDir, name), bytes, { flag: "wx" });
          const saved = { filename: name, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
          try { return { ...saved, ...pngDimensions(Buffer.from(bytes).toString("base64")) }; }
          catch (error) { error.savedScreenshot = saved; throw error; }
        } });
    } catch (error) { failure = error; detail = { ...(error.backgroundParallel ?? {}), failed: true, error: error.stack ?? String(error) }; }
    finally {
      await save(detail ?? { failed: true, error: "No background parallel task result" });
      await fs.writeFile(path.join(runDir, "background-parallel-server.json"), JSON.stringify(backgroundParallelFixture.allStats(), null, 2));
    }
    if (failure) throw failure;
    return detail;
  });
  await test("js-bounded-console-error-network-diagnostics", async () => {
    sourceIdentity.testHooks.push("diagnostics: passive native console/exception/Log observer records real replay timestamps and fresh Page capture evidence; no native event is altered or fabricated");
    const diagnostics = await connectOpenBrowserUse({ socketPath: endpoint, sessionId: "js-diagnostics", timeoutMs: 15000 });
    try { return await checkDiagnostics(diagnostics, fixtureURL, assert, until, {
      worker,
      saveDetail: detail => fs.writeFile(path.join(runDir, "diagnostics-evidence.json"), JSON.stringify(detail, null, 2)),
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
  await test(memoryClipboard ? "js-clipboard-worker-restart" : "js-control-worker-restart", async () => {
    const recovery = await connectOpenBrowserUse({ socketPath: endpoint, sessionId: "js-worker-recovery", timeoutMs: 15000 });
    let auxiliary, clipboardPending, clipboardOutcome;
    const clipboardSentinel = "OBU clipboard survives worker restart 中文";
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
      if (memoryClipboard) {
        assert.equal(memoryClipboardGuard?.verified, true);
        await owned.clipboard.writeText(clipboardSentinel);
        await holdClipboardPreparation(worker);
        clipboardPending = owned.clipboard.writeText("must not replay after restart", { timeoutMs: 5000 }).then(
          () => { clipboardOutcome = { succeeded: true }; }, error => { clipboardOutcome = { error: error.message }; });
        await until(() => worker.evaluate("__clipboardReady"), "prepared clipboard write before worker restart");
      }
      const restarted = await restartObservedWorker();
      await assert.rejects(recovery.client.getTabs(), /OBU_STALE_CONTROL_EPOCH|OBU_CONTROL_BOOTSTRAP_REQUIRED/);
      await assert.rejects(recovery.client.request("collectNetworkWait", { tabId: owned.id, waiterId: networkWait.waiterId, turn_id: oldTurn, control_epoch: oldEpoch }), /OBU_STALE_CONTROL_EPOCH|OBU_CONTROL_BOOTSTRAP_REQUIRED/);
      await assert.rejects(recovery.client.request("collectNavigationWait", { tabId: owned.id, waiterId: navigationWait.waiterId, turn_id: oldTurn, control_epoch: oldEpoch }), /OBU_STALE_CONTROL_EPOCH|OBU_CONTROL_BOOTSTRAP_REQUIRED/);
      assert.equal(recovery.client.controlEpoch, oldEpoch, "restart silently refreshed the client");
      await recovery.client.beginTurn();
      assert.ok(recovery.client.controlEpoch > oldEpoch);
      if (memoryClipboard) {
        await clipboardPending;
        assert.ok(clipboardOutcome?.error, "Old clipboard write succeeded after worker restart");
        assert.equal(await owned.clipboard.readText(), clipboardSentinel, "Worker recovery replayed a prepared clipboard write");
        assert.deepEqual(await worker.evaluate("chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']})"), []);
      }
      await assert.rejects(recovery.client.request("collectNetworkWait", { tabId: owned.id, waiterId: networkWait.waiterId }), /OBU_NETWORK_WAIT_EXPIRED/);
      await assert.rejects(recovery.client.request("collectNavigationWait", { tabId: owned.id, waiterId: navigationWait.waiterId }), /OBU_NAVIGATION_WAIT_EXPIRED/);
      assert.ok((await recovery.getTabs()).some(tab => tab.id === auxiliaryTab.id));
      await auxiliaryTab.getByRole("button", { name: "Child action", exact: true }).click();
      assert.deepEqual(await auxiliaryTab.evaluate("childClicks"), [{ trusted: true }]);
      assert.equal((await worker.evaluate(`chrome.tabs.get(${auxiliaryTab.id})`)).windowId, auxiliary.id);
      assert.match(await owned.domSnapshot(), /Controlled name/);
      await owned.getByLabel("Controlled name").fill("recovered after worker restart");
      assert.equal(await owned.getByLabel("Controlled name").inputValue(), "recovered after worker restart");
      return { oldEpoch, recoveredEpoch: recovery.client.controlEpoch, oldTarget: restarted.oldTarget, restartedTarget: restarted.restartedTarget, restartEvents: restarted.activeEvents, restartFocus: restarted.windowFocusEvents, auxiliaryWindowPreserved: auxiliary.id, oldNetworkWaitExpired: true, oldNavigationWaitExpired: true,
        ...(memoryClipboard ? {clipboardUnchanged:true,clipboardNotReplayed:true,oldClipboardOutcome:clipboardOutcome} : {}) };
    } finally {
      if (memoryClipboard) {
        let ending;
        if (clipboardPending && !clipboardOutcome) {
          ending = recovery.client.turnEnded();
          ending.catch(()=>{});
          await until(()=>clipboardOutcome,"clipboard restart fixture cleanup cancellation").catch(()=>{});
        }
        await worker.evaluate("globalThis.__clipboardContinue?.();if(globalThis.__clipboardOriginalValidation)__clipboardBroker.validateScope=__clipboardOriginalValidation;").catch(()=>{});
        await clipboardPending;
        await ending?.catch(()=>{});
      }
      try { await recovery.client.finalizeTabs([]); } finally {
        recovery.close();
        if (auxiliary) await closeAuxiliaryPopup(auxiliary.id);
      }
    }
  });
  function createPopupFocusTrace(name, reason) {
    const focusTrace = [];
    let beforeActionPopup;
    const traceFocus = async phase => {
      const metadata = await focusObserver.evaluate("(async()=>({windows:(await chrome.windows.getAll({populate:true})).map(window=>({id:window.id,type:window.type,focused:window.focused,tabs:window.tabs.map(tab=>({id:tab.id,active:tab.active}))})),contexts:(await chrome.runtime.getContexts({contextTypes:['POPUP']})).map(context=>({type:context.contextType,windowId:context.windowId,documentId:context.documentId,documentUrl:context.documentUrl}))}))()");
      const ledger = await readFocusLedger();
      const snapshot = { phase, at: ledger.at, events: focusArrays(ledger).windowFocusEvents, ledger, ...metadata };
      focusTrace.push(snapshot);
      await fs.writeFile(path.join(runDir, `${name}-focus-trace.json`), JSON.stringify(focusTrace, null, 2));
      if (phase === "action-popup:before-open") {
        await activeInvariant();
        beforeActionPopup = ledger;
      } else if (phase === "action-popup:after-open") {
        assert.ok(beforeActionPopup, "Missing focus checkpoint immediately before intentional action popup opening");
        const contexts = snapshot.contexts.filter(context => context.type === "POPUP" && context.documentUrl === `chrome-extension://${extensionId}/popup.html`);
        allowedWindowFocusEvents.push(...focusLedger.allowActionPopup(beforeActionPopup, ledger, {
          windowId: sentinel.windowId, popupURL: `chrome-extension://${extensionId}/popup.html`, popupContexts: contexts, reason
        }));
        beforeActionPopup = null;
      }
    };
    return traceFocus;
  }
  async function restartObservedWorker() {
      const focusFailures = [];
      const verifyFocus = (snapshot, phase) => {
        try { focusLedger.assertAllowed(snapshot, allowedPopupActivations, allowedWindowFocusEvents); }
        catch (error) {
          if (createdPageProof !== "worker-restart") throw error;
          focusFailures.push({ phase, error: error.stack ?? String(error), snapshot });
        }
      };
      const before = await readFocusLedger();
      verifyFocus(before, "before-worker-restart");
      const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
      const oldTarget = targets.find(target => target.type === "service_worker" && target.url === `chrome-extension://${extensionId}/background.js`);
      await focusObserver.call("ServiceWorker.enable");
      const version = await until(() => currentWorkerVersion(focusObserver.events, { url: oldTarget.url, targetId: oldTarget.id }), "unique running worker version");
      const priorSocket = nativeBridge.socket;
      worker.close();
      await focusObserver.call("ServiceWorker.stopWorker", { versionId: version.versionId });
      await focusObserver.call("ServiceWorker.startWorker", { scopeURL: `chrome-extension://${extensionId}/` });
      const restarted = await until(async () => (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()).find(target => target.id !== oldTarget.id && target.type === "service_worker" && target.url === oldTarget.url), "paused restarted worker");
      worker = await workerConnection(restarted.webSocketDebuggerUrl);
      await until(() => nativeBridge.socket !== priorSocket && nativeBridge.socket?.readyState === WebSocket.OPEN, "paused restarted native adapter");
      const after = await readFocusLedger();
      verifyFocus(after, "after-worker-restart");
      // Only derive a report of this interval. Never overwrite, concatenate or
      // deduplicate the authoritative observer's full delivery history.
      const delta = after.events.slice(before.events.length);
      return { oldTarget: oldTarget.id, restartedTarget: restarted.id, observerIdentity: after.identity,
        focusFailures,
        beforeSequence: before.events.length, afterSequence: after.events.length,
        activeEvents: delta.filter(event => event.kind === "activation").map(event => event.value),
        windowFocusEvents: delta.filter(event => event.kind === "focus").map(event => event.value) };
  }
  await test("js-user-global-pause-popup", async () => {
    const network = await connectOpenBrowserUse({ socketPath: endpoint, sessionId: "js-paused-network", timeoutMs: 15000 });
    let pauseNetworkOutcome, pauseNavigationOutcome, pauseDownloadOutcome, pauseChooserOutcome, pausePageDownloadOutcome, pausedWait, pausedNavigationWait, pausedChooserWait, pausedPageDownloadWait, pausedDownload, pausedTab, pauseAuxiliary;
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
      pausedChooserWait = await pausedTab.expectFileChooser({ timeoutMs: 120000 });
      const pendingChooser = pausedChooserWait.result().then(value => pauseChooserOutcome = { value }, error => pauseChooserOutcome = { error: String(error) });
      pausedPageDownloadWait = await pausedTab.expectDownload({ timeoutMs: 120000 });
      const pendingPageDownload = pausedPageDownloadWait.result().then(value => pausePageDownloadOutcome = { downloadId: value.downloadId }, error => pausePageDownloadOutcome = { error: String(error) });
      const downloadTab = await prepareDirectDownloadTab(network, fixtureURL);
      pausedDownload = await downloadTab.downloadURL(directDownloadURL(fixtureURL, "js-paused-direct-download", "slow"));
      await until(() => directDownloads.stats("js-paused-direct-download").requests.length === 1, "owned native download before Pause");
      const pendingDownload = pausedDownload.path({ timeoutMs: 120000 }).then(value => pauseDownloadOutcome = { value }, error => pauseDownloadOutcome = { error: String(error) });
      const detail = await checkGlobalPause({
    connectBrowser: suffix => connectOpenBrowserUse({ socketPath: endpoint, sessionId: `js-${suffix}`, timeoutMs: 15000 }),
    getWorker: () => worker, fixtureURL, popupURL: `chrome-extension://${extensionId}/popup.html`, windowId: sentinel.windowId, assert, until, traceFocus,
    saveDetail: detail => fs.writeFile(path.join(runDir, "pause-control.json"), JSON.stringify({ ...detail, networkWait: pauseNetworkOutcome, navigationWait: pauseNavigationOutcome, fileChooserWait: pauseChooserOutcome, pageDownloadWait: pausePageDownloadOutcome, directDownload: pauseDownloadOutcome }, null, 2)),
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
      await until(() => pauseChooserOutcome, "Pause cancelled the pending file chooser collect", 5000);
      assert.match(pauseChooserOutcome.error, chooserExpired);
      await until(() => pausePageDownloadOutcome, "Pause cancelled pending page download observation", 5000);
      assert.match(pausePageDownloadOutcome.error, downloadExpired);
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
      await pendingChooser;
      await pendingPageDownload;
      await pendingDownload;
      await assert.rejects(pausedWait.result(), /OBU_STALE_CONTROL_EPOCH|OBU_CONTROL_BOOTSTRAP_REQUIRED|OBU_NETWORK_WAIT_EXPIRED/);
      await assert.rejects(pausedNavigationWait.result(), /OBU_STALE_CONTROL_EPOCH|OBU_CONTROL_BOOTSTRAP_REQUIRED|OBU_NAVIGATION_WAIT_EXPIRED/);
      await assert.rejects(pausedChooserWait.result(), chooserExpired);
      await assert.rejects(pausedPageDownloadWait.result(), downloadExpired);
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
      return { ...detail, networkWait: pauseNetworkOutcome, navigationWait: pauseNavigationOutcome, fileChooserWait: pauseChooserOutcome, pageDownloadWait: pausePageDownloadOutcome, directDownload: pauseDownloadOutcome, networkNotReplayed: true };
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
      saveArtifact: async (name, data) => { await fs.writeFile(path.join(runDir, name), data); return { artifact: name, bytes: data.length, sha256: createHash("sha256").update(data).digest("hex") }; },
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
  await test("js-owned-tab-revocation", () => checkOwnedTabRevocation({
    connect: sessionId => connectOpenBrowserUse({ socketPath: endpoint, sessionId, timeoutMs: 15000 }),
    fixtureURL, worker, until, createWindow: url => createFixtureWindow(url, "normal"), closeWindow: closeAuxiliaryPopup,
    saveDetail: detail => fs.writeFile(path.join(runDir, "recovery-tab-ownership.json"), JSON.stringify(detail, null, 2))
  }));
  await test("js-native-host-restart", async () => {
    const detail = await checkNativeHostRestart({
      connect: sessionId => connectOpenBrowserUse({ socketPath: endpoint, sessionId, timeoutMs: 15000 }),
      fixtureURL, worker, until,
      restartHost: async () => {
        const before = await readFocusLedger();
        focusLedger.assertAllowed(before, allowedPopupActivations, allowedWindowFocusEvents);
        const result = await nativeBridge.restart();
        endpoint = result.newEndpoint;
        const after = await readFocusLedger();
        focusLedger.assertAllowed(after, allowedPopupActivations, allowedWindowFocusEvents);
        return { ...result, observerIdentity: after.identity, beforeSequence: before.events.length, afterSequence: after.events.length };
      },
      saveDetail: detail => fs.writeFile(path.join(runDir, "recovery-native-host.json"), JSON.stringify(detail, null, 2))
    });
    // This is an explicit harness recovery, never an SDK replay or implicit
    // epoch refresh. The fixture first checks that the old client is fenced.
    browser.close();
    browser = await connectOpenBrowserUse({ socketPath: endpoint, sessionId: "js-browser-integration", timeoutMs: 15000 });
    await browser.client.beginTurn();
    return { ...detail, harnessRecovery: { explicitReconnect: true, explicitBeginTurn: true, controlEpoch: browser.client.controlEpoch } };
  });
} catch (error) {
  records.push({ name: "fatal", passed: false, error: error.stack }); console.error(error);
} finally {
  // A failed setup/test must retain its evidence. The final exact snapshot is
  // validated too, so events delivered after the last case cannot yield exit 0.
  if (observerSetupStarted) {
    if (!focusEvidence.setup.worker && worker) {
      try { focusEvidence.setup.worker = await worker.evaluate(focusSnapshotExpression); }
      catch (error) { focusEvidence.setup.workerError = error.message; }
    }
    try {
      let state, stateError;
      try {
        assert.ok(focusObserver, "Persistent focus observer was never ready");
        state = await readWindowFocusState("after-last-case-before-teardown");
        focusEvidence.finalState = state;
      } catch (error) {
        stateError = error;
        focusEvidence.finalStateError = error.stack ?? String(error);
      }
      // Attempt the raw snapshot even if the final window query failed.
      const snapshot = await readFocusLedger();
      ({ activeEvents, windowFocusEvents } = focusArrays(snapshot));
      focusEvidence.finalState = state;
      focusEvidence.coverageEndedAt = snapshot.at;
      if (stateError) throw stateError;
      assert.equal(state.active[0]?.id, sentinel.id, "Agent action changed the active sentinel tab");
      focusLedger.assertAllowed(snapshot, allowedPopupActivations, allowedWindowFocusEvents);
      focusEvidence.finalValidation = "passed";
    } catch (error) {
      focusEvidence.finalValidation = "failed";
      focusEvidence.error = error.stack ?? String(error);
      records.push({ name: "focus-ledger-final", passed: false, error: focusEvidence.error });
    }
  } else focusEvidence.finalValidation = "not-started";
  // A failed final read still reports every previously accepted native event,
  // explicitly as an incomplete known prefix, not a fresh empty clean ledger.
  if (focusEvidence.lastAccepted) ({ activeEvents, windowFocusEvents } = focusArrays(focusEvidence.lastAccepted));
  focusEvidence.rawHistoryStatus = focusEvidence.finalValidation === "passed" ? "validated-final-snapshot" : "incomplete-known-prefix";
  focusEvidence.teardown = "begins after final snapshot validation and persistence; observer destruction and test window removals are outside agent coverage";
  await fs.writeFile(path.join(runDir, "focus-ledger.json"), JSON.stringify({ ...focusEvidence, activeEvents, allowedPopupActivations, windowFocusEvents, allowedWindowFocusEvents }, null, 2));
  await fs.writeFile(path.join(runDir, "focus-final-state.json"), JSON.stringify(focusEvidence.finalState ?? { error: focusEvidence.finalStateError ?? "Observer setup did not reach window state capture" }, null, 2));
  // Capture the HTTP witness before teardown can close an unfinished response.
  await fs.writeFile(path.join(runDir, "direct-download-server.json"), JSON.stringify(directDownloads.allStats(), null, 2));
  await fs.writeFile(path.join(runDir, "media-download-server.json"), JSON.stringify(mediaDownloads.stats(), null, 2));
  await fs.writeFile(path.join(runDir, "media-breadth-server.json"), JSON.stringify(embeddedMedia.stats(), null, 2));
  await fs.writeFile(path.join(runDir, "form-workflow-server.json"), JSON.stringify(formWorkflows.allStats(), null, 2));
  await fs.writeFile(path.join(runDir, "research-workflow-server.json"), JSON.stringify(researchWorkflows.allStats(), null, 2));
  if (backgroundParallel) await fs.writeFile(path.join(runDir, "background-parallel-server.json"), JSON.stringify(backgroundParallelFixture.allStats(), null, 2));
  if (snapshotGeometry) await fs.writeFile(path.join(runDir, "snapshot-geometry-server.json"), JSON.stringify(snapshotGeometryFixtures.allStats(), null, 2));
  if (mcpBinding) await fs.writeFile(path.join(runDir, "mcp-binding-server.json"), JSON.stringify(mcpBindingFixture.snapshot(), null, 2));
  // Tab/window removal can emit a last extension notification. Stop accepting
  // bridge writes before ending stdin, including callbacks already queued by ws.
  bridgeClosing = true;
  if (nativeBridge) nativeBridge.closing = true;
  browser?.close();
  if (observerTargetId) {
    try { await observerBrowserControl?.call("Target.closeTarget", { targetId: observerTargetId }); }
    catch (error) { hostLog.push(`Focus observer teardown: ${error.message}\n`); }
  }
  if (createdPageProof || (negativeDownloads && observerBrowserControl && chrome && chrome.exitCode === null)) {
    const lifecycle = createdPageProof ? createdPageBrowserLifecycle : negativeBrowserLifecycle;
    const closed = createdPageProof ? createdPageBrowserClosed : negativeBrowserClosed;
    const closeName = createdPageProof ? "created-page-browser-close" : "negative-browser-close";
    let closeTimer;
    try {
      if (createdPageProof) {
        assert.ok(observerBrowserControl && chrome && closed, "Created-page browser close requires the original browser connection and child process");
        assert.equal(chrome.exitCode, null, "Created-page browser exited before Browser.close");
      }
      lifecycle.closeRequestedAt = Date.now();
      lifecycle.closeResponse = await observerBrowserControl.call("Browser.close");
      if (createdPageProof) assert.deepEqual(lifecycle.closeResponse, {}, "Original Browser.close ACK required");
      await Promise.race([closed, new Promise((_, reject) => { closeTimer = setTimeout(() => reject(new Error(createdPageProof ? "Isolated created-page browser did not actually close" : "Isolated negative browser did not actually close")), 5000); })]);
      assert.equal(lifecycle.code, 0);
      if (createdPageProof) {
        assert.equal(lifecycle.closeObserved, true);
        assert.equal(lifecycle.signal, null);
      }
    } catch (error) {
      lifecycle.error = error.stack;
      records.push({ name: closeName, passed: false, error: error.stack });
    } finally { clearTimeout(closeTimer); }
  }
  focusObserver?.close(); observerBrowserControl?.close();
  if (worker) { if (!negativeDownloads && !createdPageProof) try { await worker.evaluate("chrome.windows.getAll().then(windows=>Promise.all(windows.map(window=>chrome.windows.remove(window.id))))"); } catch {} worker.close(); }
  if (chrome && chrome.exitCode === null) chrome.kill();
  try { await nativeBridge?.close(); }
  catch (error) { records.push({ name: "native-host-cleanup", passed: false, error: error.stack ?? String(error) }); }
  for (const client of ws.clients) client.terminate();
  await new Promise(resolve => ws.close(resolve));
  networkFixtures.close();
  navigationFixtures.close();
  directDownloads.close();
  downloadWaitFixtures.close();
  originalDownloadNegativeFixtures.close();
  await fs.writeFile(path.join(runDir, "download-waits-server.json"), JSON.stringify(downloadWaitFixtures.allStats(), null, 2));
  await new Promise(resolve => http.close(resolve));
  if (negativeDownloads) await fs.writeFile(path.join(runDir, "original-download-negative-server.json"), JSON.stringify(originalDownloadNegativeFixtures.allStats(), null, 2));
  if (negativeDownloads) await fs.writeFile(path.join(runDir, "original-download-negative-browser-close.json"), JSON.stringify(negativeBrowserLifecycle, null, 2));
  if (createdPageProof) await fs.writeFile(path.join(runDir, "created-page-browser-close.json"), JSON.stringify(createdPageBrowserLifecycle, null, 2));
  if (negativeDownloads) {
    const validation = { evidence: "original-download-negative-network-provenance.json", passed: false };
    try {
      const filename = path.join(runDir, "original-download-negative-netlog.json");
      const stat = await fs.stat(filename); assert.ok(stat.isFile() && stat.size > 0 && stat.size <= 32 * 1024 * 1024, "Bounded complete Browser NetLog required");
      const raw = await fs.readFile(filename); assert.equal(raw.length, stat.size);
      validation.netlog = { bytes: raw.length, sha256: createHash("sha256").update(raw).digest("hex") };
      const detail = JSON.parse(await fs.readFile(path.join(runDir, "original-download-negative.json"), "utf8"));
      validation.detail = assertOriginalNegativeNetlog({ netlog: JSON.parse(raw.toString("utf8")), detail, browserClose: negativeBrowserLifecycle });
      validation.passed = true;
    } catch (error) { validation.error = error.stack; }
    records.push({ name: "js-original-download-network-provenance", passed: validation.passed,
      ...(validation.passed ? { detail: { evidence: validation.evidence } } : { error: validation.error }) });
    await fs.writeFile(path.join(runDir, validation.evidence), JSON.stringify(validation, null, 2));
    console.log(validation.passed ? "PASS" : "FAIL", "js-original-download-network-provenance", validation.error ?? "");
  }
  await fs.writeFile(path.join(runDir, "network-server.json"), JSON.stringify(networkFixtures.allStats(), null, 2));
  if (createdPageProof) await fs.writeFile(path.join(runDir, "created-page-server.json"), JSON.stringify(createdPageFixtures.allStats(), null, 2));
  await fs.writeFile(path.join(runDir, "navigation-server.json"), JSON.stringify(navigationFixtures.allStats(), null, 2));
  let chooserDiagnosticResult;
  if (chooserAllPointers) {
    const artifacts = {};
    for (const name of chooserPointerAllContextArtifacts) {
      try {
        assert.ok((await fs.stat(path.join(runDir, name))).size <= 4 * 1024 * 1024, "Chooser pointer artifact exceeds limit");
        artifacts[name] = JSON.parse(await fs.readFile(path.join(runDir, name), "utf8"));
      } catch (error) { artifacts[name] = { readError: String(error) }; }
    }
    chooserDiagnosticResult = chooserPointerAllContextSummary(artifacts, records);
    await fs.writeFile(path.join(runDir, "chooser-diagnostic.json"), JSON.stringify(chooserDiagnosticResult, null, 2));
  } else if (chooserDiagnostic) {
    let artifact;
    try { artifact = JSON.parse(await fs.readFile(path.join(runDir, chooserMode === "pointer-go-context" ? "chooser-go.json" : "chooser-js.json"), "utf8")); }
    catch (error) { artifact = { readError: String(error) }; }
    const originalTaskPassed = records.find(record => record.name === "js-file-chooser-ready-two-connections")?.passed ?? false;
    chooserDiagnosticResult = chooserMode === "pointer-go-context" ? chooserPointerGoContextSummary(artifact, records) :
      chooserMode === "pointer-context" ? chooserPointerContextSummary(artifact, records) :
      chooserMode === "pointer-only" ? chooserPointerDiagnosticSummary(artifact, originalTaskPassed) : { mode: "chooser-ready-diagnostic", acceptancePassed: false,
      originalTaskPassed,
      collectionComplete: artifact.variants?.length > 0 && artifact.variants.every(item => item.diagnostic?.collectionComplete === true),
      evidence: "chooser-js.json", readError: artifact.readError };
    await fs.writeFile(path.join(runDir, "chooser-diagnostic.json"), JSON.stringify(chooserDiagnosticResult, null, 2));
  }
  let goChooserDiagnosticResult;
  if (goChooserDiagnostic) {
    let artifact;
    try { artifact = JSON.parse(await fs.readFile(path.join(runDir, "chooser-go.json"), "utf8")); }
    catch (error) { artifact = { readError: String(error) }; }
    goChooserDiagnosticResult = summarizeGoChooserDiagnostic(records, artifact);
    await fs.writeFile(path.join(runDir, "go-chooser-diagnostic.json"), JSON.stringify(goChooserDiagnosticResult, null, 2));
  }
  let mcpBindingResult;
  if (mcpBinding) {
    mcpBindingResult = { mode: "mcp-connection-binding", acceptancePassed: false, evidence: "mcp-connection-binding.json", server: "mcp-binding-server.json" };
    try { mcpBindingResult.acceptancePassed = checkMCPBindingSelection(records); }
    catch (error) { records.push({ name: "mcp-binding-case-selection", passed: false, error: error.stack ?? String(error) }); }
  }
  let downloadDiagnosticResult;
  if (downloadDiagnostic) {
    let artifact;
    try { artifact = JSON.parse(await fs.readFile(path.join(runDir, "download-ready-js.json"), "utf8")); }
    catch (error) { artifact = { readError: String(error) }; }
    const selectionComplete = records.length === downloadDiagnosticCases.length && records.every((record, index) => record.name === downloadDiagnosticCases[index]);
    downloadDiagnosticResult = { mode: "download-ready-diagnostic", acceptancePassed: false, selectionComplete,
      originalTaskPassed: records.find(record => record.name === "js-page-download-ready-two-connections")?.passed ?? false,
      collectionComplete: selectionComplete && artifact.variants?.length > 0 && artifact.variants.every(item => item.diagnostic?.collectionComplete === true && !item.diagnosticFailureError && !item.diagnosticFinishError),
      evidence: "download-ready-js.json", readError: artifact.readError };
    await fs.writeFile(path.join(runDir, "download-diagnostic.json"), JSON.stringify(downloadDiagnosticResult, null, 2));
  }
  await fs.writeFile(path.join(runDir, "results.json"), JSON.stringify({ platform: process.platform, versions, headed: !memoryClipboard, memoryClipboardGuard, ...(chooserDiagnosticResult ? { chooserDiagnostic: chooserDiagnosticResult } : {}), ...(goChooserDiagnosticResult ? { goChooserDiagnostic: goChooserDiagnosticResult } : {}), ...(mcpBindingResult ? { mcpBinding: mcpBindingResult } : {}), ...(downloadDiagnosticResult ? { downloadDiagnostic: downloadDiagnosticResult } : {}), productionExtension: true, adapter: "connectNative replaced by loopback WebSocket for isolated testing only", nativeHost: executable, sourceIdentity, nativeFrameStats, nativeHostGenerations: nativeBridge?.generations, focusLedger: focusEvidence, activeEvents, allowedPopupActivations, windowFocusEvents, allowedWindowFocusEvents, records }, null, 2));
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
  process.exitCode = records.some(record => !record.passed) || chooserDiagnosticResult?.collectionComplete === false || (goChooserDiagnosticResult && !goChooserDiagnosticResult.collectionComplete) || (downloadDiagnosticResult && !downloadDiagnosticResult.collectionComplete) ? 1 : 0;
}
