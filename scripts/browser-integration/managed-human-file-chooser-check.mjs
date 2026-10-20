// Shared isolated lifecycle for the frozen baseline and production upload workflow.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium as playwrightChromium } from "playwright";
import { createManagedHumanFileChooserFixture, readManagedHumanFileChooserDocument, assertManagedHumanFileChooserDocument,
  createManagedFileWorkflowFixture, managedFileWorkflowCases, readManagedFileWorkflowDocument } from "./managed-human-file-chooser-fixture.mjs";
import { projectManagedFileCommand, runManagedFileWorkflow, assertManagedFileWorkflowFinalFixtures } from "./managed-human-file-chooser-workflow.mjs";
import { installManagedFileChooserErrorDiagnostic } from "./managed-human-file-chooser-diagnostic.mjs";
import { projectHumanCommand, assertHumanInputReceipt, visibleHumanViewerPoint } from "./managed-human-check.mjs";
import { assertManagedDialogEnded } from "./managed-human-dialog-check.mjs";
import { parseManagedReadyOutput, assertManagedStopReply } from "./managed-download-check.mjs";
import { projectManagedViewerLifecycle, assertManagedViewerTerminal, assertManagedViewerBrowserCommand } from "./managed-viewer-check.mjs";
import { connectNormalCDP, managedProcess, runProcess, bound, poll } from "./normal-browser-downloads-support.mjs";
import { listenFixture } from "./fixture-listener.mjs";
import { browserStartupOptions } from "./browser-startup.mjs";
import { waitPrivateDevToolsEndpoint } from "./private-devtools-endpoint.mjs";
import { observedProcessDescendants as descendants } from "./observed-process-descendants.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const redact = value => String(value).replace(/(#ticket=)[A-Za-z0-9_-]+/g, "$1[redacted]");
const serialize = value => JSON.stringify(value, (_key, item) => typeof item === "string" ? redact(item) : item, 2);
const inside = (root, file) => { const relative = path.relative(root, file); assert.ok(relative && !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`)); return relative.replaceAll("\\", "/"); };
async function treeHashes(root) {
  const entries = await fs.readdir(root, { recursive: true, withFileTypes: true }); assert.ok(entries.every(entry => !entry.isSymbolicLink()));
  return Object.fromEntries(await Promise.all(entries.filter(entry => entry.isFile()).map(async entry => { const file = path.join(entry.parentPath, entry.name); return [inside(root, file), hash(await fs.readFile(file))]; })));
}

export function installManagedFileChooserObserver(chrome, target = globalThis) {
  if (target.__managedFileChooserDiagnostic) throw Error("Original chooser observer already installed");
  let active = true, overflow = false, sequence = 0; const events = [];
  const record = (source, method, params) => {
    const keys = { "Page.fileChooserOpened": ["frameId", "mode", "backendNodeId"],
      "Page.frameNavigated": [], "Page.frameDetached": ["frameId", "reason"],
      "Runtime.executionContextsCleared": [], "Page.screencastFrame": ["sessionId"], "debugger.onDetach": ["reason"],
      "Runtime.executionContextCreated": ["context"], "Runtime.executionContextDestroyed": ["executionContextId", "executionContextUniqueId"],
      "Target.attachedToTarget": ["sessionId", "targetInfo"], "Target.detachedFromTarget": ["sessionId", "targetId"] }[method];
    if (!keys) return;
    if (events.length >= 512) { overflow = true; return; }
    const projected = method === "Page.frameNavigated" ? { frame: Object.fromEntries(["id", "parentId", "loaderId", "url"].filter(k => Object.hasOwn(params.frame ?? {}, k)).map(k => [k, params.frame[k]])) }
      : method === "Target.attachedToTarget" ? { sessionId: params.sessionId, targetInfo: Object.fromEntries(["targetId", "type", "url"].map(k => [k, params.targetInfo?.[k]])) }
      : method === "Runtime.executionContextCreated" ? { context: {
        ...Object.fromEntries(["id", "uniqueId", "origin"].filter(k => Object.hasOwn(params.context ?? {}, k)).map(k => [k, params.context[k]])),
        auxData: Object.fromEntries(["frameId", "isDefault", "type"].filter(k => Object.hasOwn(params.context?.auxData ?? {}, k)).map(k => [k, params.context.auxData[k]])),
      } }
      : Object.fromEntries(keys.filter(k => Object.hasOwn(params, k)).map(k => [k, params[k]]));
    events.push({ sequence: ++sequence, at: Date.now(), source: { ...source }, method, params: projected });
  };
  const detach = (source, reason) => record(source, "debugger.onDetach", { reason });
  chrome.debugger.onEvent.addListener(record); chrome.debugger.onDetach.addListener(detach);
  const snapshot = () => ({ events: structuredClone(events), overflow, active });
  Object.defineProperty(target, "__managedFileChooserDiagnostic", { value: { snapshot, stop() {
    chrome.debugger.onEvent.removeListener(record); chrome.debugger.onDetach.removeListener(detach); active = false; return snapshot();
  } } });
  return { installed: true, passive: true, interceptionEnabledByObserver: false };
}

export function classifyManagedFileChooserBaseline({ events, target, frameId, clickAt, ui, inputReplies }) {
  assert.ok(Array.isArray(events)); assert.ok(Number.isSafeInteger(clickAt));
  assert.equal(ui.fileInputs.length, 0, "A visible upload channel requires new acceptance, not the old baseline");
  assert.deepEqual(ui.chooserStateKeys, []);
  const openings = events.filter(row => row.method === "Page.fileChooserOpened" && row.at >= clickAt);
  assert.ok(openings.length <= 1, "One original click must not produce ambiguous chooser openings");
  for (const row of openings) {
    assert.equal(row.params.frameId, frameId); assert.equal(row.params.mode, "selectSingle");
    assert.ok(Number.isSafeInteger(row.params.backendNodeId) && row.params.backendNodeId > 0);
    assert.ok(row.source.targetId !== undefined || row.source.tabId !== undefined);
    if (row.source.targetId !== undefined) assert.equal(row.source.targetId, target.id);
    if (row.source.tabId !== undefined) assert.equal(row.source.tabId, target.tabId);
    assert.equal(row.source.sessionId, undefined, "Root-only baseline cannot borrow a child session");
  }
  const failed = inputReplies.some(row => row.error), pending = inputReplies.some(row => row.pending);
  return { outcome: !openings.length ? "native-chooser-unobserved" : "observed-native-chooser-without-upload-channel",
    nativeChooserObserved: openings.length === 1, missingChannelObserved: openings.length === 1,
    inputOutcome: failed ? "native-input-error" : pending ? "native-input-pending-at-observation" : "acknowledged",
    featurePassed: false, nativeOpening: openings[0] ?? null };
}

export function assertManagedFileChooserLedger(commands, lease) {
  const inputs = commands.filter(row => row.operation === "humanInput" && row.leaseId === lease.leaseId);
  assert.ok(inputs.length >= 2 && inputs.every(row => row.generation === lease.generation && row.input.type === "pointer"));
  assert.deepEqual(inputs.filter(row => row.input.action !== "move").map(row => [row.input.action, row.input.button]), [["down", "left"], ["up", "left"]]);
  assert.deepEqual(inputs.map(row => row.sequence), inputs.map((_row, i) => i + 1));
  return inputs;
}

export function managedFileChooserCompletion(mode, diagnostic, completed) {
  assert.ok(["baseline", "workflow"].includes(mode));
  assert.equal(typeof diagnostic, "boolean"); assert.equal(typeof completed, "boolean");
  assert.ok(!diagnostic || mode === "workflow", "Private diagnostics require the explicit workflow mode");
  return { featurePassed: mode === "workflow" && !diagnostic && completed,
    diagnosticCompleted: (mode === "baseline" || diagnostic) && completed };
}

export async function submitManagedFileWorkflowOriginal(current, item, row) {
  const snapshot = { startedAt: Date.now() };
  row.submission = { snapshot };
  try {
    const value = await current.domSnapshot({ timeoutMs: 10000 });
    snapshot.resolvedAt = Date.now();
    const bytes = Buffer.from(value, "utf8");
    const text = Array.from(value).slice(0, 4096).join("");
    snapshot.result = { text, bytes: bytes.length, sha256: hash(bytes), truncated: text !== value };
  } catch (error) {
    snapshot.rejectedAt = Date.now(); snapshot.error = String(error.stack ?? error).slice(0, 8192); throw error;
  }
  const click = { startedAt: Date.now(), selector: "#submit", frameSelector: item.fixture.kind === "oopif" ? "#child" : null };
  row.submission.click = click;
  try {
    const locator = item.fixture.kind === "oopif" ? current.frameLocator("#child").locator("#submit") : current.locator("#submit");
    await locator.click({ timeoutMs: 10000 }); click.resolvedAt = Date.now();
  } catch (error) {
    click.rejectedAt = Date.now(); click.error = String(error.stack ?? error).slice(0, 8192); throw error;
  }
}

export async function readManagedFileTarget(chromeAPI, tabId) {
  const targets = (await chromeAPI.debugger.getTargets()).filter(row => row.type === "page" && row.tabId === tabId);
  if (targets.length !== 1) throw Error("Original file workflow target is not unique");
  const target = targets[0], tab = await chromeAPI.tabs.get(tabId), window = await chromeAPI.windows.get(tab.windowId);
  return { id: target.id, tabId: target.tabId, url: target.url, attached: target.attached,
    tab: { id: tab.id, windowId: tab.windowId, groupId: tab.groupId, active: tab.active, pinned: tab.pinned },
    window: { id: window.id, type: window.type, state: window.state, focused: window.focused } };
}

export async function runManagedHumanFileChooserBaseline() {
  assert.equal(process.platform, "win32");
  const mode = process.env.OBU_TEST_HUMAN_FILE_CHOOSER_MODE ?? "baseline";
  assert.ok(["baseline", "workflow"].includes(mode)); const workflow = mode === "workflow";
  const diagnostic = process.env.OBU_TEST_HUMAN_FILE_CHOOSER_DIAGNOSTIC === "1";
  managedFileChooserCompletion(mode, diagnostic, false);
  const executable = process.env.OBU_TEST_HOST_BINARY, extension = process.env.OBU_TEST_EXTENSION_DIR;
  const chromium = process.env.OBU_TEST_CHROMIUM_BINARY, buildFile = process.env.OBU_TEST_BUILD_MANIFEST;
  for (const file of [executable, extension, chromium, buildFile]) { assert.ok(typeof file === "string" && path.isAbsolute(file)); await fs.access(file); }
  await fs.mkdir(path.join(repo, ".tmp/browser-integration"), { recursive: true });
  const runDir = await fs.mkdtemp(path.join(repo, ".tmp/browser-integration/mfc-")), root = path.join(runDir, "r"), name = "f", viewerProfile = path.join(runDir, "v");
  const report = { runDir, mode, instrumented: diagnostic, startedAt: Date.now(), steps: [], commands: [], probes: [], lifecycleSnapshots: [], processObservations: [], screenshots: [], frames: [],
    viewerCommands: [], viewerMessages: [], viewerActions: [], uiObservations: [], nativeEvents: [], unexpectedRequests: [], cleanup: {}, cleanupErrors: [], featurePassed: false,
    scope: "One delivered root document and one real viewer click. Original human attachment only. Observational Page.enable(enableFileChooserOpenedEvent:true) and Page.getFrameTree are explicitly recorded; no interception, task attach, task CDP input, file assignment, OS input, personal profile or replay.",
    limits: "Diagnostic completion is not upload capability. An absent native chooser event is unproved, not success. Headless native picker request evidence does not prove a visible OS picker. No file bytes are supplied." };
  const save = () => fs.writeFile(path.join(runDir, "results.json"), serialize(report));
  if (workflow) {
    report.scope = "Production managed viewer file picker/byte transfer on four original delivered pages: root, OOPIF, transfer-End and fixture-gated navigation. Root and OOPIF are submitted once only after End, explicit Resume and public claim of the same original page. Each claim must preserve the original window/group/tab activation/window focus. Native event observer is passive; no diagnostic chooser interception or task file assignment.";
    report.limits = "Playwright intercepts only the independent viewer tab's local file picker and supplies File payloads after a real production Choose click establishes picker intent. This validates the upload channel after local file selection, not OS picker window/focus behavior. Claim placement is observed only in isolated headless Chromium, not an OS foreground/focus acceptance. No task setInputFiles, OS mouse or personal profile. Transfer cancellation uses the original ongoing transfer, never a retry; fixture-gated navigation is explicit test control.";
  }
  if (diagnostic) {
    report.scope += " Explicit private-worker diagnostic hooks observe original calls and settlements; business steps are unchanged.";
    report.limits += " This instrumented diagnostic can never establish feature acceptance. Hook installation capabilities and bounded original observations are recorded separately.";
    report.privateDiagnostic = { requested: true, snapshots: [], errors: [] };
  }
  const registry = new Set(), frameWrites = [], fixture = createManagedHumanFileChooserFixture(), workflowFixtures = [], workflowCases = [];
  const server = createServer((req, res) => { if (![fixture, ...workflowFixtures].some(value => value.handle(req, res))) { report.unexpectedRequests.push({ method: req.method, url: req.url }); req.resume(); res.writeHead(404); res.end(); } });
  let launcher, info, worker, taskBrowser, viewerProcess, viewerBrowser, page, state, tab, captureError, stopPromise, finalSaved = false;
  const launch = (program, args, options = {}) => { const record = {}; report.commands.push(record); return managedProcess(program, args, { cwd: repo, registry, record, maximumBytes: 8 * 1024 * 1024, ...options }); };
  const check = () => { if (captureError) throw captureError; };
  const wait = (read, label, timeoutMs = 15000) => poll(async () => { check(); return read(); }, { timeoutMs, intervalMs: 50, label });
  async function command(args) { const value = await launch(executable, args, { timeoutMs: args[1] === "stop" ? 55000 : 35000 }).completed; assert.equal(value.code, 0, redact(value.stderr)); return value; }
  async function step(name, operation) {
    const item = { name, startedAt: Date.now() }; report.steps.push(item); console.log("STEP", name);
    try { await operation(); check(); item.passed = true; } catch (error) { item.passed = false; item.error = error.stack; throw error; }
    finally { item.endedAt = Date.now(); await save(); }
  }
  async function cleanup(label, operation) { try { report.cleanup[label] = await operation(); } catch (error) { report.cleanupErrors.push({ label, at: Date.now(), error: error.stack ?? String(error) }); } }
  async function table() {
    const record = {}; report.probes.push(record);
    try {
      await runProcess("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,ExecutablePath,@{n='CreationDate';e={$_.CreationDate.ToUniversalTime().ToString('o')}}) | ConvertTo-Json -Compress"], { registry, record, timeoutMs: 15000 });
      return JSON.parse(record.stdout);
    } finally { if (typeof record.stdout === "string") record.stdout = { bytes: Buffer.byteLength(record.stdout), sha256: hash(record.stdout) }; }
  }
  async function rememberProcesses(label) {
    const rows = await table(), groups = [];
    for (const [kind, pid] of [["managed", info?.browserPID], ["viewer", viewerProcess?.record.pid]]) if (pid) groups.push({ kind, rootPID: pid, processes: descendants(rows, pid) });
    report.processObservations.push({ label, at: Date.now(), groups }); return groups;
  }
  async function lifecycle(label) {
    let directory = info?.runDir;
    if (!directory) { const runs = path.join(root, name, "runs"), rows = await fs.readdir(runs, { withFileTypes: true }); assert.equal(rows.length, 1); assert.ok(rows[0].isDirectory() && /^[0-9a-f]{32}$/.test(rows[0].name)); directory = path.join(runs, rows[0].name); }
    const source = path.join(directory, "lifecycle.json"); inside(root, source);
    const bytes = await fs.readFile(source), { value, ...metadata } = projectManagedViewerLifecycle(bytes), file = `lifecycle-${label}.json`;
    await fs.writeFile(path.join(runDir, file), bytes, { flag: "wx" }); report.lifecycleSnapshots.push({ label, file, ...metadata });
    if (label === "final") { report.lifecycle = value; finalSaved = true; } else report.readyLifecycle = value;
    return value;
  }
  const endpoint = (profile, owner) => waitPrivateDevToolsEndpoint(profile, { assertAlive() { assert.ok(!owner.record.exitedAt && !owner.record.closedAt && !owner.record.spawnError, "Original browser owner ended"); } });
  const readDocument = original => worker.evaluate(`chrome.scripting.executeScript({target:{tabId:${tab.id},${original ? 'documentIds:'+JSON.stringify([original.documentId]) : 'frameIds:[0]'}},func:${readManagedHumanFileChooserDocument.toString()}}).then(rows=>rows.map(row=>({documentId:row.documentId,frameId:row.frameId,...row.result})))`, 5000);
  const observedEvents = () => report.nativeEvents;
  const observerSnapshot = async () => { const value = await worker.evaluate("__managedFileChooserDiagnostic.snapshot()", 3000); assert.equal(value.overflow, false); assert.equal(report.workerConnection.eventsDropped, 0); report.nativeEvents = value.events; return value; };
  async function privateDiagnosticSnapshot(label) {
    if (!diagnostic || !report.privateDiagnostic.installation) return;
    const row = { label, startedAt: Date.now() }; report.privateDiagnostic.snapshots.push(row);
    if (worker?.state() !== "open") { row.originalWorkerEnded = true; return; }
    try {
      row.value = await worker.evaluate("__managedFileChooserErrorDiagnostic.snapshot()", 3000); row.endedAt = Date.now();
      assert.equal(row.value.overflow, false); assert.equal(row.value.actionOverflow, false);
    }
    catch (error) {
      // Do not project arbitrary runtime error messages into this private trace.
      row.error = { name: /^[A-Za-z]+Error$/.test(error.name) ? error.name : "Error", code: "DIAGNOSTIC_SNAPSHOT_FAILED" };
      report.privateDiagnostic.errors.push({ label, ...row.error });
    }
  }
  async function screenshot(label) { const file = `viewer-${label}.png`, bytes = await page.screenshot({ path: path.join(runDir, file), timeout: 5000 }); const value = { file, at: Date.now(), bytes: bytes.length, sha256: hash(bytes) }; report.screenshots.push(value); return value; }
  async function uiObservation(label) {
    const value = await bound(page.evaluate(() => ({ state: document.querySelector("#state")?.textContent,
      error: document.querySelector("#error")?.textContent, humanStatus: document.querySelector("#human-status")?.textContent,
      input: { ...document.querySelector("#human-input")?.dataset },
      fileInputs: [...document.querySelectorAll('input[type="file"]')].map(el => ({ id: el.id, hidden: el.hidden, disabled: el.disabled })),
      buttons: [...document.querySelectorAll("button")].map(el => ({ id: el.id, text: el.textContent, disabled: el.disabled })) })), 5000, "viewer-only state");
    const item = { label, at: Date.now(), ...value, chooserStateKeys: Object.keys(state ?? {}).filter(k => /chooser|upload/i.test(k)), publishedState: structuredClone(state) };
    report.uiObservations.push(item); return item;
  }
  async function uiAction(selector, operation, tabId, budget = 15000) {
    const start = report.viewerCommands.length, item = { selector, operation, tabId, startedAt: Date.now() }; report.viewerActions.push(item);
    if (selector === "#tabs") await page.locator(selector).selectOption(String(tabId), { timeout: 5000 }); else await page.locator(selector).click({ timeout: 5000 });
    const sent = await wait(() => report.viewerCommands.slice(start).find(row => row.operation === operation), `viewer ${operation} request`, 5000); item.requestId = sent.id;
    const reply = await wait(() => report.viewerMessages.find(row => row.type === "response" && row.id === sent.id), `viewer ${operation} response`, budget);
    item.reply = reply; item.endedAt = Date.now(); assert.equal(reply.error, undefined, JSON.stringify(reply.error)); return reply.result;
  }
  async function openViewer(url) {
    page.on("pageerror", error => { (report.viewerErrors ??= []).push(error.stack); captureError ??= error; });
    page.on("websocket", socket => {
      if (new URL(socket.url()).origin.replace("ws:", "http:") !== new URL(url).origin) { captureError ??= Error("Unexpected viewer socket"); return; }
      socket.on("framesent", event => { try { const value = projectManagedFileCommand(JSON.parse(String(event.payload)), projectHumanCommand); if (value) { assert.ok(report.viewerCommands.length < 2048); report.viewerCommands.push({ ...value, at: Date.now() }); } } catch (error) { captureError ??= error; } });
      socket.on("close", () => report.viewerMessages.push({ type: "socketClosed", at: Date.now() }));
      socket.on("framereceived", event => {
        try {
          const message = JSON.parse(String(event.payload)), at = Date.now(); assert.ok(report.viewerMessages.length < 8192);
          if (message.type === "frame") {
            assert.equal(message.mimeType, "image/png"); assert.ok(typeof message.data === "string" && message.data.length < 6 * 1024 * 1024);
            const bytes = Buffer.from(message.data, "base64"); assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]); assert.ok(bytes.length > 24 && report.frames.length < 4096);
            const frame = { ...message, data: undefined, at, index: report.frames.length, bytes: bytes.length, sha256: hash(bytes), width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
            if (frame.index < 12 || frame.index % 30 === 0) { frame.file = `native-frame-${String(frame.index).padStart(4, "0")}.png`; const write = fs.writeFile(path.join(runDir, frame.file), bytes, { flag: "wx" }); frameWrites.push(write); write.catch(error => { captureError ??= error; }); }
            report.frames.push(frame); report.viewerMessages.push({ type: "frame", at, tabId: frame.tabId, streamId: frame.streamId, sequence: frame.sequence, humanLeaseId: frame.humanLeaseId, generation: frame.generation, sha256: frame.sha256 });
          } else {
            report.viewerMessages.push({ ...message, at });
            const next = message.type === "state" ? message : message.type === "response" && message.result?.status ? message.result : null;
            if (next && (!state || next.eventSequence >= state.eventSequence && next.status.revision >= state.status.revision)) state = next;
          }
        } catch (error) { captureError ??= error; }
      });
    });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
    await wait(async () => await page.locator("#connection").textContent() === "已连接", "original viewer authenticated"); assert.equal(new URL(page.url()).hash, "");
  }
  async function stopOriginal() {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      await privateDiagnosticSnapshot("before-formal-stop");
      if (worker?.state() === "open") {
        try { report.observerBeforeStop = await observerSnapshot(); }
        catch (error) { report.cleanupErrors.push({ label: "pre-stop-observer", at: Date.now(), error: String(error) }); }
      }
      await rememberProcesses("before-stop"); report.beforeStop = { at: Date.now(), nativeEvents: observedEvents(), fixture: fixture.stats() }; await save();
      const result = await command(["managed", "stop", "--root", root, "--name", name]); report.stopReply = assertManagedStopReply(JSON.parse(result.stdout), info.runId);
      const ended = await bound(launcher.completed, 10000, "original supervisor actual close"); assert.equal(ended.code, 0); assert.equal(ended.termination, undefined);
      report.supervisorExit = { code: ended.code, exitedAt: ended.exitedAt, closedAt: ended.closedAt };
      const value = await lifecycle("final"); assertManagedViewerTerminal(value, info);
      const readyIdentity = report.lifecycleSnapshots.find(row => row.label === "ready"), finalIdentity = report.lifecycleSnapshots.find(row => row.label === "final");
      assert.equal(finalIdentity.nativeCreationTimeDecimal, readyIdentity.nativeCreationTimeDecimal);
      report.lifecycleIdentityAuthority = { file: finalIdentity.file, sha256: finalIdentity.sha256, nativeCreationTimeDecimal: finalIdentity.nativeCreationTimeDecimal,
        note: "Original lifecycle file and the extracted decimal text are authoritative for uint64 FILETIME. Parsed JSON number copies are not exact process identity values." };
      return { confirmed: true, at: Date.now() };
    })(); return stopPromise;
  }
  async function sourceFiles() {
    const result = await launch("git", ["ls-files", "--cached", "--others", "--exclude-standard", "--", "packages/open-browser-use-js", "scripts/browser-integration"], { timeoutMs: 15000 }).completed;
    assert.equal(result.code, 0); return [...new Set([...result.stdout.trim().split(/\r?\n/), ...(workflow ? Object.keys(report.source.builtInputs) : [])])].sort();
  }
  async function decodedHuman() {
    return wait(async () => {
      const image = await page.locator("#frame").evaluate(element => ({ hidden: element.hidden, complete: element.complete, width: element.naturalWidth, height: element.naturalHeight, ...element.dataset }));
      const frame = report.frames.findLast(row => row.controlMode === "human" && row.tabId === tab.id && row.streamId === image.streamId && row.sequence === Number(image.frameSequence));
      return frame && !image.hidden && image.complete && image.width > 0 && state?.human?.state === "active" && state.human.leaseId === frame.humanLeaseId && state.human.generation === frame.generation && !state.pendingDialog && await page.locator("#human-input").getAttribute("data-enabled") === "true" && { image, frame };
    }, "decoded current original human frame", 20000);
  }
  async function resources() {
    const scope = { host: info.nativeHostName, pipes: [info.socketPath, "\\\\.\\pipe\\open-browser-use-managed-" + hash(path.resolve(root).toLowerCase() + "\0" + name).slice(0, 40)] };
    assert.match(scope.host, /^com\.openbrowseruse\.managed\.n[0-9a-f]{32}$/);
    const script = String.raw`$ErrorActionPreference='Stop'
$scope=$env:OBU_DIALOG_RESOURCE_PROBE | ConvertFrom-Json
$keys=@()
foreach($view in @([Microsoft.Win32.RegistryView]::Registry32,[Microsoft.Win32.RegistryView]::Registry64)) {
 $base=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser,$view);$key=$null
 try {$key=$base.OpenSubKey(('Software\Google\Chrome\NativeMessagingHosts\'+$scope.host),$false);$keys+=@{view=$view.ToString();absent=($null -eq $key)}} finally {if($null -ne $key){$key.Close()};$base.Close()}
}
$present=@([IO.Directory]::GetFiles('\\.\pipe\') | Where-Object {$scope.pipes -contains $_})
@{registration=$keys;presentOriginalPipes=$present} | ConvertTo-Json -Compress -Depth 5`;
    const record = {}; report.resourceProbe = record; await runProcess("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { registry, record, env: { ...process.env, OBU_DIALOG_RESOURCE_PROBE: JSON.stringify(scope) }, timeoutMs: 15000 });
    const value = JSON.parse(record.stdout); assert.equal(value.registration.length, 2); assert.ok(value.registration.every(row => row.absent)); assert.deepEqual(value.presentOriginalPipes, []);
    const endpointEntries = await fs.readdir(path.join(info.runDir, "temp/open-browser-use")); assert.deepEqual(endpointEntries, []); return { ...value, endpointEntries };
  }

  async function observeCommand(method, params) {
    assert.ok(["Page.enable", "Page.getFrameTree"].includes(method));
    if (method === "Page.enable") assert.deepEqual(params, { enableFileChooserOpenedEvent: true });
    const row = { method, params, source: { targetId: report.target.id }, startedAt: Date.now() };
    (report.observationCommands ??= []).push(row);
    try { row.result = await worker.evaluate(`chrome.debugger.sendCommand(${JSON.stringify(row.source)},${JSON.stringify(method)},${JSON.stringify(params)})`, 5000); row.acknowledgedAt = Date.now(); return row.result; }
    catch (error) { row.error = String(error); throw error; }
  }
  async function readWorkflow(item, original = true) {
    const selection = original ? `documentIds:${JSON.stringify(item.before.map(value => value.documentId))}` : "allFrames:true";
    const rows = await worker.evaluate(`chrome.scripting.executeScript({target:{tabId:${item.tabId},${selection}},func:${readManagedFileWorkflowDocument.toString()}}).then(rows=>rows.filter(row=>row.result).map(row=>({documentId:row.documentId,frameId:row.frameId,...row.result})))`, 5000);
    if (original) assert.deepEqual(rows.map(value => value.documentId).sort(), item.before.map(value => value.documentId).sort());
    return rows;
  }
  async function originalTarget(tabId) {
    return worker.evaluate(`(${readManagedFileTarget.toString()})(chrome,${tabId})`, 5000);
  }
  function workflowFacade() {
    return {
      instrumented: diagnostic, state: () => state, commands: () => report.viewerCommands, messages: () => report.viewerMessages, wait, uiAction, screenshot,
      record: results => { report.workflow = results; }, read: readWorkflow,
      async begin(item) {
        tab = { id: item.tabId };
        const delivered = state.tabs.find(value => value.id === item.tabId);
        assert.equal(delivered?.kind, "result"); assert.equal(delivered.takeover, true);
        await uiAction("#tabs", "select", item.tabId);
        const result = await uiAction("#human-begin", "humanBegin"); await decodedHuman();
        const target = await originalTarget(item.tabId);
        assert.equal(target.id, item.target.id); assert.equal(target.attached, true); return result;
      },
      async webFrames(item) { return worker.evaluate(`chrome.webNavigation.getAllFrames({tabId:${item.tabId}})`); },
      async nativeEvents() { return (await observerSnapshot()).events; },
      async clickInput(item, documents) {
        const decoded = await decodedHuman(), rootDocument = documents.find(value => value.frameId === 0);
        const emitter = documents.find(value => value.inputRect); assert.ok(rootDocument && emitter);
        const rect = { ...emitter.inputRect, width: Math.min(80, emitter.inputRect.width) };
        if (emitter !== rootDocument) {
          assert.ok(rootDocument.childRect && rootDocument.childInset);
          rect.x += rootDocument.childRect.x + rootDocument.childInset.x;
          rect.y += rootDocument.childRect.y + rootDocument.childInset.y;
        }
        const box = await page.locator("#frame").boundingBox(); assert.ok(box);
        const point = visibleHumanViewerPoint(rect, state.human.viewport, box, decoded.image);
        const offset = report.viewerCommands.length, value = { startedAt: Date.now(), point };
        await page.mouse.click(point.viewerPoint.x, point.viewerPoint.y); value.viewerGestureAcknowledgedAt = Date.now();
        const up = await wait(() => report.viewerCommands.slice(offset).find(row => row.operation === "humanInput" && row.input.type === "pointer" && row.input.action === "up"), "original pointer up");
        const reply = await wait(() => report.viewerMessages.find(row => row.type === "response" && row.id === up.id), "original pointer up ACK");
        const inputs = report.viewerCommands.slice(offset).filter(row => row.operation === "humanInput");
        assert.ok(inputs.every(row => row.input.type === "pointer"));
        assert.deepEqual(inputs.filter(row => row.input.action !== "move").map(row => [row.input.action, row.input.button]), [["down", "left"], ["up", "left"]]);
        for (const request of inputs) {
          const responses = report.viewerMessages.filter(row => row.type === "response" && row.id === request.id);
          assert.equal(responses.length, 1); assertHumanInputReceipt(request, responses[0]);
        }
        assertHumanInputReceipt(up, reply); value.inputRequests = inputs.map(row => row.id);
        value.upReply = reply; return value;
      },
      async pick(files) {
        const startedAt = Date.now(), pending = structuredClone(state.pendingFileChooser);
        const card = await page.evaluate(() => ({ hidden: document.querySelector("#file-chooser").hidden,
          chooserId: document.querySelector("#file-chooser").dataset.chooserId, source: document.querySelector("#file-source").textContent }));
        assert.equal(card.hidden, false); assert.equal(card.chooserId, pending.chooserId);
        assert.ok(card.source.includes(pending.source.origin));
        const chooserPromise = page.waitForEvent("filechooser", { timeout: 5000 });
        // Attach rejection handling immediately; the real choose click owns the intent.
        chooserPromise.catch(() => {});
        await page.locator("#file-choose").click({ timeout: 5000 });
        const chooser = await chooserPromise; assert.equal(chooser.isMultiple(), pending.multiple);
        const pickerIntentPhase = await page.locator("#file-status").getAttribute("data-phase");
        assert.equal(pickerIntentPhase, "picking");
        await chooser.setFiles(files, { timeout: 10000 });
        return { startedAt, suppliedAt: Date.now(), pending, card, pickerIntentPhase, count: files.length, viaTrustedChooseButton: true };
      },
      async waitReply(operation, pending, budget) {
        const request = await wait(() => report.viewerCommands.find(row => row.operation === operation && row.leaseId === pending.leaseId && row.chooserId === pending.chooserId), `original ${operation}`, budget);
        const reply = await wait(() => report.viewerMessages.find(row => row.type === "response" && row.id === request.id), `original ${operation} ACK`, budget);
        assert.equal(reply.error, undefined); return reply;
      },
      pagePending() { return report.viewerCommands.some(row => row.operation.startsWith("humanFile") && !report.viewerMessages.some(reply => reply.type === "response" && reply.id === row.id)); },
      async end(lease) {
        let result;
        if (state.human?.leaseId === lease.leaseId) result = await uiAction("#human-end", "humanEnd", undefined, 30000);
        else result = await wait(() => { try { assertManagedDialogEnded(state, lease.leaseId); return structuredClone(state); } catch { return false; } }, "original automatic file End");
        assertManagedDialogEnded(result, lease.leaseId); assert.equal(result.pendingFileChooser, null);
        await wait(async () => await page.locator("#file-chooser").evaluate(element => element.hidden), "original chooser UI cleared after End");
        return result;
      },
      async transferFiles(transferId, payloads) {
        assert.match(transferId, /^[A-Za-z0-9_-]+$/);
        const directory = path.join(info.runDir, "u", transferId); inside(info.runDir, directory);
        const actual = await treeHashes(directory), expected = Object.fromEntries(payloads.map((file, i) => [`${i}/${file.name}`, hash(file.buffer)]));
        assert.deepEqual(actual, expected);
        return { directory: inside(info.runDir, directory), files: actual, checkedAt: Date.now() };
      },
      async waitTransferRemoved(transferId) {
        assert.match(transferId, /^[A-Za-z0-9_-]+$/);
        const directory = path.join(info.runDir, "u", transferId); inside(info.runDir, directory);
        return wait(async () => { try { await fs.lstat(directory); return false; } catch (error) { if (error.code !== "ENOENT") throw error; return { absent: true, checkedAt: Date.now(), directory: inside(info.runDir, directory) }; } }, "original retired staging removed");
      },
      async resumeAgent() {
        report.resume = await uiAction("#control", "resume"); assert.equal(report.resume.status.state, "running");
        report.newTurn = await taskBrowser.client.beginTurn("after-original-human-file-transfer");
      },
      originalTarget: item => originalTarget(item.tabId),
      claimOriginal: item => taskBrowser.client.claimUserTab(item.tabId),
      submitOriginal: (item, row) => submitManagedFileWorkflowOriginal(taskBrowser.tab(item.tabId), item, row),
    };
  }
  try {
    await step(workflow ? "freeze-runtime-and-upload-workflow" : "freeze-runtime-and-baseline-harness", async () => {
      const bytes = await fs.readFile(buildFile), build = JSON.parse(bytes); assert.equal(build.passed, true);
      report.source = { executable: hash(await fs.readFile(executable)), browser: hash(await fs.readFile(chromium)), extension: await treeHashes(extension), sdk: await treeHashes(path.join(repo, "packages/open-browser-use-js/dist")), snapshot: {}, builtInputs: build.sourceInputs, buildSnapshot: path.join(path.dirname(buildFile), "source-snapshot") };
      assert.equal(report.source.executable, build.exeSHA256); assert.deepEqual(report.source.extension, build.extensionFiles);
      assert.equal(report.source.browser, "566971689aecea06a88355ea1e9020c908b7a3b093dd0d2a12ae7073489a77aa");
      report.buildEvidence = { path: buildFile, file: "build-manifest.json", sha256: hash(bytes), scope: workflow ? "Frozen production build; this workflow harness is separately frozen." : "Previously tested frozen runtime; new baseline harness is separately frozen, not retroactively part of that build." };
      await fs.writeFile(path.join(runDir, "build-manifest.json"), bytes, { flag: "wx" });
      for (const [file, expected] of Object.entries(build.sourceInputs)) {
        inside(report.source.buildSnapshot, path.resolve(report.source.buildSnapshot, file)); const original = await fs.readFile(path.join(report.source.buildSnapshot, file)); assert.equal(hash(original), expected);
        if (workflow) assert.equal(hash(await fs.readFile(path.join(repo, file))), expected, `Current production must match frozen build: ${file}`);
        const target = path.join(runDir, "built-source-snapshot", file); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, original, { flag: "wx" });
      }
      for (const file of await sourceFiles()) {
        inside(repo, path.resolve(repo, file)); const original = await fs.readFile(path.join(repo, file)); report.source.snapshot[file] = hash(original);
        const target = path.join(runDir, "source-snapshot", file); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, original, { flag: "wx" });
      }
      await fs.cp(extension, path.join(runDir, "extension-input"), { recursive: true });
      await fs.cp(path.join(repo, "packages/open-browser-use-js/dist"), path.join(runDir, "sdk-input"), { recursive: true });
      await listenFixture(server); report.fixtureURL = `http://127.0.0.1:${server.address().port}${fixture.route}`;
      if (workflow) for (const kind of managedFileWorkflowCases) workflowFixtures.push(createManagedFileWorkflowFixture({ kind, baseURL: new URL(report.fixtureURL).origin }));
    });
    await step(workflow ? "formal-session-and-four-original-delivered-pages" : "formal-session-and-original-delivered-page", async () => {
      launcher = launch(executable, ["managed", "run", "--root", root, "--name", name, "--browser-path", chromium, "--extension-dir", extension, "--startup-timeout", "30s"]);
      const ready = await wait(() => { assert.ok(!launcher.record.closedAt && !launcher.record.exitedAt); return parseManagedReadyOutput(launcher.record.stdout); }, "managed ready", 40000);
      info = report.info = ready.info; inside(root, info.runDir); assert.equal(ready.state, "ready");
      const life = await lifecycle("ready"); assertManagedViewerBrowserCommand(life, chromium);
      assert.equal(life.browserVersion.product, "Chrome/156.0.8078.12"); assert.equal(life.browserVersion.revision, "@634b046faf2137b83af71c87baf362b533af9104");
      assert.deepEqual(JSON.parse((await command(["managed", "status", "--root", root, "--name", name])).stdout).info, info);
      const privateEndpoint = await endpoint(info.profileDir, launcher);
      const targets = (await (await fetch(`http://127.0.0.1:${privateEndpoint.port}/json/list`, { signal: AbortSignal.timeout(10000) })).json()).filter(row => row.type === "service_worker" && row.url === `chrome-extension://${info.extensionId}/background.js`);
      assert.equal(targets.length, 1); report.workerConnection = {};
      worker = await connectNormalCDP(targets[0].webSocketDebuggerUrl, { record: report.workerConnection, handshakeTimeoutMs: 10000, authorizationRequired: false });
      report.observer = await worker.evaluate(`(${installManagedFileChooserObserver.toString()})(chrome,globalThis)`);
      if (diagnostic) {
        report.privateDiagnostic.installation = await worker.evaluate(`(${installManagedFileChooserErrorDiagnostic.toString()})(chrome,globalThis)`, 5000);
        await privateDiagnosticSnapshot("installed-before-business");
      }
      const { connectOpenBrowserUse } = await import(pathToFileURL(path.join(runDir, "sdk-input/index.js")));
      taskBrowser = await connectOpenBrowserUse({ socketPath: info.socketPath, sessionId: workflow ? "managed-human-file-chooser-workflow" : "managed-human-file-chooser-baseline", timeoutMs: 10000 });
      if (workflow) {
        for (const value of workflowFixtures) {
          const original = await taskBrowser.newTab({ url: value.urls.root, backgroundWindow: true });
          const item = { fixture: value, tabId: original.id };
          workflowCases.push(item);
          item.snapshot = await original.domSnapshot({ timeoutMs: 10000 });
          item.before = await wait(async () => { const rows = await readWorkflow(item, false); return rows.length === (value.kind === "oopif" ? 2 : 1) && rows.every(row => row.state.workflowId === value.workflowId) && rows; }, "original upload documents loaded");
          item.target = await originalTarget(original.id);
          assert.equal(item.target.url, value.urls.root);
        }
        report.originalPages = workflowCases.map(({ fixture: value, ...item }) => ({ ...item, kind: value.kind, urls: value.urls }));
        report.finalize = await taskBrowser.client.finalizeTabs(workflowCases.map(item => ({ tabId: item.tabId, status: "deliverable" })));
        await rememberProcesses("managed-original"); return;
      }
      tab = await taskBrowser.newTab({ url: report.fixtureURL, backgroundWindow: true }); report.originalSnapshot = await tab.domSnapshot({ timeoutMs: 10000 });
      const rows = await readDocument(); assert.equal(rows.length, 1); report.originalDocument = rows[0]; assert.equal(rows[0].frameId, 0); assert.equal(rows[0].state.workflowId, fixture.workflowId);
      report.finalize = await taskBrowser.client.finalizeTabs([{ tabId: tab.id, status: "deliverable" }]);
      await rememberProcesses("managed-original");
    });
    await step(workflow ? "formal-viewer-original-uploads-cancel-and-after-End-submit" : "formal-viewer-and-one-original-click", async () => {
      report.viewerStartup = browserStartupOptions([`--user-data-dir=${viewerProfile}`, "--headless=new", "--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "about:blank"], process.env.OBU_TEST_FIELD_TRIAL_CONFIG);
      viewerProcess = launch(chromium, report.viewerStartup.args);
      viewerBrowser = await playwrightChromium.connectOverCDP((await endpoint(viewerProfile, viewerProcess)).url);
      const context = await viewerBrowser.newContext({ viewport: { width: 1280, height: 1000 } }); page = await context.newPage();
      const view = JSON.parse((await command(["managed", "view", "--root", root, "--name", name])).stdout), url = new URL(view.viewerURL);
      assert.equal(url.hostname, "127.0.0.1"); report.viewerOrigin = url.origin; report.viewerTicketSHA256 = hash(url.hash);
      await openViewer(url.href); await uiAction("#refresh", "status");
      if (workflow) {
        await rememberProcesses("both-private-browsers");
        await runManagedFileWorkflow(workflowFacade(), workflowCases);
        report.observerFinal = await worker.evaluate("__managedFileChooserDiagnostic.stop()", 3000);
        report.nativeEvents = report.observerFinal.events; assert.equal(report.observerFinal.overflow, false); assert.equal(report.observerFinal.active, false); assert.equal(report.workerConnection.eventsDropped, 0);
        assert.deepEqual(report.unexpectedRequests, []); return;
      }
      const delivered = state.tabs.find(row => row.id === tab.id); assert.equal(delivered?.kind, "result"); assert.equal(delivered.takeover, true); report.delivery = structuredClone(delivered);
      await uiAction("#tabs", "select", tab.id); report.begin = await uiAction("#human-begin", "humanBegin");
      report.decoded = await decodedHuman(); report.lease = structuredClone(state.human);
      const targets = await worker.evaluate(`chrome.debugger.getTargets().then(rows=>rows.filter(row=>row.type==='page'&&row.tabId===${tab.id}).map(row=>({id:row.id,tabId:row.tabId,url:row.url,attached:row.attached})))`);
      assert.equal(targets.length, 1); report.target = targets[0]; assert.equal(report.target.attached, true); assert.equal(report.target.url, report.fixtureURL);
      // Fixed .12 InspectorPageAgent::enable only enables reporting; it does not
      // set suppress_file_chooser_ or cancel_file_chooser_. No interception here.
      await observeCommand("Page.enable", { enableFileChooserOpenedEvent: true });
      report.nativeTree = await observeCommand("Page.getFrameTree", {});
      const rootFrame = report.nativeTree.frameTree.frame; assert.equal(rootFrame.id, report.target.id); assert.equal(rootFrame.url, report.fixtureURL); assert.ok(rootFrame.loaderId);
      const rows = await readDocument(report.originalDocument); assert.equal(rows.length, 1); report.before = rows[0]; assert.equal(report.before.clickable, true);
      assert.equal(report.before.documentId, report.originalDocument.documentId); assert.equal(report.before.fileCount, 0);
      report.uiBefore = await uiObservation("before-click"); await screenshot("before-click");
      const box = await page.locator("#frame").boundingBox(); assert.ok(box);
      const measured = { ...report.before.rect, width: Math.min(80, report.before.rect.width) };
      report.point = visibleHumanViewerPoint(measured, state.human.viewport, box, report.decoded.image);
      await rememberProcesses("both-private-browsers");
      report.click = { startedAt: Date.now() }; await page.mouse.click(report.point.viewerPoint.x, report.point.viewerPoint.y); report.click.viewerGestureAcknowledgedAt = Date.now();
      // Observe for a fixed bounded window, without refresh/blur, retries or
      // requiring the remote input ACK before looking for the native chooser.
      report.samples = [];
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        await observerSnapshot(); report.samples.push(await uiObservation("after-click"));
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      report.observationEndedAt = Date.now(); report.inputs = assertManagedFileChooserLedger(report.viewerCommands, report.lease);
      report.inputReplies = report.inputs.map(request => report.viewerMessages.find(row => row.type === "response" && row.id === request.id) ?? { id: request.id, pending: true });
      for (let i = 0; i < report.inputs.length; i++) if (!report.inputReplies[i].pending && !report.inputReplies[i].error) assertHumanInputReceipt(report.inputs[i], report.inputReplies[i]);
      report.uiAfter = await uiObservation("observation-end"); await screenshot("native-chooser-observation");
      report.classification = classifyManagedFileChooserBaseline({ events: report.nativeEvents, target: report.target, frameId: rootFrame.id, clickAt: report.click.startedAt, ui: report.uiAfter, inputReplies: report.inputReplies });
      if (state?.human?.leaseId === report.lease.leaseId) report.end = await uiAction("#human-end", "humanEnd", undefined, 30000);
      else report.end = await wait(() => { try { assertManagedDialogEnded(state, report.lease.leaseId); return structuredClone(state); } catch { return false; } }, "original automatic End");
      assertManagedDialogEnded(report.end, report.lease.leaseId);
      const after = await readDocument(report.originalDocument); assert.equal(after.length, 1); report.after = after[0]; report.documentProof = assertManagedHumanFileChooserDocument(report.before, report.after);
      report.inputRepliesAfterEnd = report.inputs.map(request => report.viewerMessages.find(row => row.type === "response" && row.id === request.id) ?? { id: request.id, pending: true });
      assertManagedFileChooserLedger(report.viewerCommands, report.lease);
      report.observerFinal = await worker.evaluate("__managedFileChooserDiagnostic.stop()", 3000);
      report.nativeEvents = report.observerFinal.events; assert.equal(report.observerFinal.overflow, false); assert.equal(report.observerFinal.active, false); assert.equal(report.workerConnection.eventsDropped, 0);
      assert.deepEqual(report.unexpectedRequests, []); const stats = fixture.stats(); assert.equal(stats.overflow, false); assert.equal(stats.requests.length, 1); assert.equal(stats.requests[0].status, 200); assert.equal(stats.requests[0].finished, true); assert.equal(stats.requests[0].aborted, false);
      await screenshot("ended");
    });
    await step("formal-stop-of-original-managed-session", stopOriginal);
  } catch (error) {
    report.error = error.stack ?? String(error);
    report.failureKind = /timeout|timed out|deadline/i.test(String(error)) ? "observation-or-operation-timeout" : "diagnostic-failure";
    console.error(redact(report.error));
  }
  finally {
    if (workflow && report.error) {
      const row = report.workflow?.findLast(value => value.submitStartedAt);
      const item = row && workflowCases.find(value => value.tabId === row.tabId);
      if (item) {
        const observation = { startedAt: Date.now(), tabId: item.tabId,
          documentIds: item.before.map(value => value.documentId), fixtureBefore: item.fixture.stats() };
        row.failureObservation = observation;
        try {
          if (worker?.state() !== "open") observation.originalWorkerEnded = true;
          else {
            // One read of the exact original documents before cleanup. Never
            // repeat a snapshot, click, claim or POST to obtain this evidence.
            const value = await worker.evaluate(`(async()=>{
              const target=[await (${readManagedFileTarget.toString()})(chrome,${item.tabId})];
              const documents=(await chrome.scripting.executeScript({target:{tabId:${item.tabId},documentIds:${JSON.stringify(observation.documentIds)}},func:${readManagedFileWorkflowDocument.toString()}})).filter(row=>row.result).map(row=>({documentId:row.documentId,frameId:row.frameId,...row.result}));
              const json=JSON.stringify({target,documents}),bytes=new TextEncoder().encode(json).length;
              return bytes<=65536?{json,bytes,limitExceeded:false}:{bytes,limitExceeded:true};
            })()`, 5000);
            observation.result = { bytes: value.bytes, limitExceeded: value.limitExceeded,
              ...(value.json === undefined ? {} : { value: JSON.parse(value.json) }) };
            observation.resolvedAt = Date.now();
          }
        } catch (error) { observation.rejectedAt = Date.now(); observation.error = String(error.stack ?? error).slice(0, 8192); }
        observation.fixtureAfter = item.fixture.stats();
      }
    }
    await privateDiagnosticSnapshot("before-cleanup");
    if (taskBrowser) await cleanup("sdk", async () => { await bound(taskBrowser.close(), 5000, "original SDK close"); return { closed: true }; });
    if (launcher && !report.supervisorExit) await cleanup("stop", stopOriginal);
    if (launcher && !launcher.record.closedAt) await cleanup("supervisorFallback", async () => { launcher.terminate("managed-chooser-original-supervisor-fallback"); await bound(launcher.completed.catch(() => {}), 12000, "original supervisor fallback close"); throw Error("Original supervisor required forced fallback"); });
    if (launcher && !finalSaved) await cleanup("finalLifecycle", () => lifecycle("final"));
    if (worker) await cleanup("workerObserver", async () => {
      report.nativeEvents = observedEvents(); report.workerEventOverflow = report.workerConnection.eventsDropped;
      if (worker.state() === "open") {
        report.observerAtCleanup = await worker.evaluate("__managedFileChooserDiagnostic.stop()", 3000);
        report.nativeEvents = report.observerAtCleanup.events;
        assert.equal(report.observerAtCleanup.overflow, false);
      } else report.observerAtCleanup = { originalWorkerEnded: true, state: worker.state(), noEvaluateAfterClose: true };
      assert.equal(report.workerEventOverflow, 0);
      await worker.close(); return { closed: true };
    });
    if (viewerBrowser) await cleanup("viewerBrowser", async () => {
      const session = await bound(viewerBrowser.newBrowserCDPSession(), 5000, "original viewer close session"); await bound(session.send("Browser.close"), 5000, "original viewer close");
      const result = await bound(viewerProcess.completed, 12000, "original viewer actual exit"); assert.equal(result.code, 0); assert.equal(result.termination, undefined);
      await bound(viewerBrowser.close(), 5000, "original viewer client close"); return { code: result.code, exitedAt: result.exitedAt, closedAt: result.closedAt };
    });
    if (viewerProcess && !viewerProcess.record.closedAt) await cleanup("viewerFallback", async () => { viewerProcess.terminate("managed-chooser-original-viewer-fallback"); await bound(viewerProcess.completed.catch(() => {}), 12000, "original viewer forced close"); throw Error("Original viewer required forced fallback"); });
    if (info) await cleanup("privateResources", resources);
    if (workflow && info) await cleanup("uploadFilesAfterBrowserExit", async () => {
      const directory = path.join(info.runDir, "u");
      try { assert.deepEqual(await fs.readdir(directory), []); return { empty: true }; }
      catch (error) { if (error.code !== "ENOENT") throw error; return { absent: true }; }
    });
    if (report.processObservations.length) await cleanup("originalProcesses", async () => {
      const originals = [...new Map(report.processObservations.flatMap(row => row.groups).flatMap(row => row.processes).map(row => [`${row.ProcessId}/${row.CreationDate}`, row])).values()]; report.originalProcesses = originals;
      return poll(async () => { const rows = await table(), remaining = originals.filter(before => rows.some(after => before.ProcessId === after.ProcessId && before.CreationDate === after.CreationDate)); return !remaining.length && { at: Date.now(), originalIdentities: originals.length, remaining }; }, { timeoutMs: 15000, intervalMs: 100, label: "original process identities gone" });
    });
    await cleanup("frames", async () => { await Promise.all(frameWrites); check(); return { observed: report.frames.length, saved: frameWrites.length }; });
    await cleanup("fixture", async () => { server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve)); return { closed: !server.listening }; });
    if (workflow) await cleanup("terminalFixtureProof", async () => {
      // Preserve the actual terminal observations even when a late POST makes
      // this proof fail. Any failure joins cleanupErrors and fails the run.
      report.workflowFixtures = workflowFixtures.map(value => value.stats());
      return assertManagedFileWorkflowFinalFixtures(report.workflowFixtures, report.workflow ?? []);
    });
    if (report.source) await cleanup("sourceIntegrity", async () => {
      assert.equal(hash(await fs.readFile(executable)), report.source.executable); assert.equal(hash(await fs.readFile(chromium)), report.source.browser);
      assert.deepEqual(await treeHashes(extension), report.source.extension); assert.deepEqual(await treeHashes(path.join(runDir, "extension-input")), report.source.extension);
      assert.deepEqual(await treeHashes(path.join(repo, "packages/open-browser-use-js/dist")), report.source.sdk); assert.deepEqual(await treeHashes(path.join(runDir, "sdk-input")), report.source.sdk);
      assert.deepEqual(await sourceFiles(), Object.keys(report.source.snapshot).sort());
      assert.equal(hash(await fs.readFile(buildFile)), report.buildEvidence.sha256);
      for (const [file, expected] of Object.entries(report.source.builtInputs)) { assert.equal(hash(await fs.readFile(path.join(report.source.buildSnapshot, file))), expected); assert.equal(hash(await fs.readFile(path.join(runDir, "built-source-snapshot", file))), expected); }
      for (const [file, expected] of Object.entries(report.source.snapshot)) { assert.equal(hash(await fs.readFile(path.join(repo, file))), expected); assert.equal(hash(await fs.readFile(path.join(runDir, "source-snapshot", file))), expected); }
      return { unchanged: true };
    });
    report.fixture = fixture.stats(); if (workflow) report.workflowFixtures = workflowFixtures.map(value => value.stats());
    report.liveRunnerChildren = [...registry].map(child => child.pid); report.endedAt = Date.now();
    report.completed = !report.error && report.steps.length === 4 && report.steps.every(row => row.passed) && !report.cleanupErrors.length && !registry.size &&
      (!diagnostic || !report.privateDiagnostic.errors.length);
    Object.assign(report, managedFileChooserCompletion(mode, diagnostic, report.completed));
    await save(); console.log("RESULT", JSON.stringify({ runDir, completed: report.completed, featurePassed: report.featurePassed, classification: report.classification?.outcome }));
  }
  return report;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  assert.equal(process.argv.length, 2, "No retry or alternate business mode");
  const report = await runManagedHumanFileChooserBaseline(); process.exitCode = report.completed ? 0 : 1;
}
