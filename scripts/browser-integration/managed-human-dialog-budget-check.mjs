// Real, bounded native modal waiting. The existing six-case prompt response
// runner and its five-second assertions remain unchanged.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium as playwrightChromium } from "playwright";
import { createManagedDialogFixture, readManagedDialogDocument, measureManagedDialogButton, managedDialogUnicode } from "./managed-dialog-fixture.mjs";
import { assertHumanInputReceipt, visibleHumanViewerPoint } from "./managed-human-check.mjs";
import { projectHumanDialogCommand, assertManagedDialogEnded } from "./managed-human-dialog-check.mjs";
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

// The binding forwards copies of original events from the already-owned worker
// to this diagnostic socket. It never wraps sendCommand or attaches a Page.
function installDialogObservation(chrome, target, originals) {
  if (target.__managedDialogDiagnostic || typeof target.__obuManagedDialogEvent !== "function") throw Error("Original dialog observer unavailable");
  let sequence = 0, overflow = false, active = true;
  const events = [], matches = source => originals.some(original => source.tabId === original.tabId || source.targetId === original.targetId);
  const record = (source, method, params) => {
    if (!matches(source)) return;
    if (events.length >= 64) { overflow = true; return; }
    const value = { sequence: ++sequence, at: Date.now(), source: { ...source }, method, params: structuredClone(params) };
    events.push(value); target.__obuManagedDialogEvent(JSON.stringify(value));
  };
  const onEvent = (source, method, params) => { if (["Page.javascriptDialogOpening", "Page.javascriptDialogClosed"].includes(method)) record(source, method, params); };
  const onDetach = (source, reason) => record(source, "debugger.onDetach", { reason });
  chrome.debugger.onEvent.addListener(onEvent); chrome.debugger.onDetach.addListener(onDetach);
  const snapshot = () => ({ events: structuredClone(events), overflow, active });
  Object.defineProperty(target, "__managedDialogDiagnostic", { configurable: true, value: Object.freeze({ snapshot,
    stop() { chrome.debugger.onEvent.removeListener(onEvent); chrome.debugger.onDetach.removeListener(onDetach); active = false; return snapshot(); } }) });
  return { installed: true, readOnly: true, originals };
}

export const dialogBudgetLimits = Object.freeze({ deliberateMs: 40000, capMs: 300000, capObservationMs: 340000, capEarliestCloseMs: 299750, capLatestCloseMs: 305000 });
export function managedDialogBudgetCases(mode) {
  assert.ok(["old-cap-diagnostic", "acceptance"].includes(mode));
  return mode === "old-cap-diagnostic" ? [[{ id: "prompt-old-cap", type: "prompt", answer: null }]] :
    [[{ id: "prompt-deliberate", type: "prompt", answer: managedDialogUnicode }], [{ id: "prompt-cap", type: "prompt", answer: null }]];
}
export function assertDialogBudgetHeld(sample, record) {
  assert.ok(sample.at >= record.opening.at); assert.equal(sample.human?.state, "active");
  assert.equal(sample.human.leaseId, record.originalScope.leaseId); assert.equal(sample.human.generation, record.originalScope.generation);
  assert.deepEqual(sample.pendingDialog, record.pendingDialog); assert.equal(sample.triggerResponse, null, "Original pending input must not gain a manufactured acknowledgement");
  assert.equal(sample.nativeClosed, null); assert.equal(sample.dialogVisible, true);
}
export async function readDialogBudgetSample({ readStatus, readTriggerResponse, readNativeClosed, readDialogVisible, readViewerInput, now = Date.now }) {
  const at = now();
  const dialogVisible = await readDialogVisible(), viewerInput = await readViewerInput();
  // UI reads are not atomic with native events. Re-read original events and
  // protocol state after both awaits; retain the complete observation interval.
  const status = readStatus();
  return { at, human: status?.human ? structuredClone(status.human) : null,
    pendingDialog: status?.pendingDialog ? structuredClone(status.pendingDialog) : null,
    triggerResponse: readTriggerResponse() ?? null, nativeClosed: readNativeClosed() ?? null,
    dialogVisible, viewerInput, completedAt: now() };
}
function assertObservedCapWindow(elapsedMs) {
  assert.ok(elapsedMs >= dialogBudgetLimits.capEarliestCloseMs && elapsedMs < dialogBudgetLimits.capLatestCloseMs,
    "Observed native cancellation must be approximately 300s within the declared passive-listener window");
}
export function assertDialogBudgetSample(sample, record, kind) {
  assert.ok(["old-cap-diagnostic", "deliberate", "cap"].includes(kind));
  assert.ok(Number.isSafeInteger(sample.at) && sample.at >= record.opening.at);
  assert.ok(Number.isSafeInteger(sample.completedAt) && sample.completedAt >= sample.at,
    "A complete observation interval is required; legacy samples cannot be retrofitted");
  if (kind === "cap" && sample.nativeClosed) assertObservedCapWindow(sample.nativeClosed.at - record.opening.at);
  const heldUntil = kind === "cap" ? dialogBudgetLimits.capEarliestCloseMs : dialogBudgetLimits.deliberateMs;
  const mustRemainHeld = kind !== "old-cap-diagnostic" && !sample.nativeClosed && sample.completedAt - record.opening.at < heldUntil;
  if (mustRemainHeld) assertDialogBudgetHeld(sample, record);
  return mustRemainHeld;
}
export function assertDialogBudgetNativePair(record, business, kind) {
  const { opening, closed } = record;
  for (const event of [opening, closed]) {
    assert.deepEqual(event.source, { targetId: business.target.id }); assert.equal(event.params.frameId, business.target.id);
    assert.ok(Number.isSafeInteger(event.at) && event.at > 0);
  }
  assert.equal(opening.method, "Page.javascriptDialogOpening"); assert.equal(closed.method, "Page.javascriptDialogClosed");
  assert.equal(closed.sequence, opening.sequence + 1);
  const elapsedMs = closed.at - opening.at; assert.ok(elapsedMs >= 0);
  if (kind === "deliberate") {
    assert.ok(record.request.at - opening.at >= dialogBudgetLimits.deliberateMs);
    assert.ok(record.request.at - opening.at < dialogBudgetLimits.capMs);
    assert.ok(closed.at >= record.request.at); assert.equal(record.request.operation, "humanDialogRespond");
    assert.equal(record.request.leaseId, record.originalScope.leaseId); assert.equal(record.request.generation, record.originalScope.generation);
    assert.equal(record.request.dialogId, record.pendingDialog.dialogId);
    assert.equal(closed.params.result, true); assert.equal(closed.params.userInput, managedDialogUnicode);
  } else {
    assert.equal(record.request, undefined); assert.equal(closed.params.result, false); assert.equal(closed.params.userInput, "");
    if (kind === "cap") assertObservedCapWindow(elapsedMs);
    else assert.equal(kind, "old-cap-diagnostic");
  }
  return { kind, elapsedMs, originalTargetId: business.target.id };
}

export async function runManagedHumanDialogBudgetCheck() {
  assert.equal(process.platform, "win32");
  const mode = process.env.OBU_TEST_DIALOG_BUDGET_MODE; managedDialogBudgetCases(mode);
  const executable = process.env.OBU_TEST_HOST_BINARY, extension = process.env.OBU_TEST_EXTENSION_DIR;
  const chromium = process.env.OBU_TEST_CHROMIUM_BINARY, buildFile = process.env.OBU_TEST_BUILD_MANIFEST;
  for (const file of [executable, extension, chromium, buildFile]) { assert.ok(typeof file === "string" && path.isAbsolute(file)); await fs.access(file); }
  await fs.mkdir(path.join(repo, ".tmp/browser-integration"), { recursive: true });
  const runDir = await fs.mkdtemp(path.join(repo, ".tmp/browser-integration/mdb-")), root = path.join(runDir, "r"), name = "n", viewerProfile = path.join(runDir, "v");
  const report = { runDir, mode, startedAt: Date.now(), steps: [], commands: [], probes: [], lifecycleSnapshots: [], processObservations: [], screenshots: [], frames: [],
    documents: [], dialogs: [], viewerCommands: [], viewerMessages: [], viewerActions: [], uiObservations: [], nativeEvents: [], unexpectedRequests: [], cleanup: {}, cleanupErrors: [], featurePassed: false,
    scope: "Bounded real modal waiting on original delivered pages. Old-cap mode diagnoses the frozen previous runtime without answering; acceptance delays one Unicode response for 40 seconds and lets a separate original prompt reach its real 300-second cap. No task-page script while modal, direct CDP dialog response, input replay, OS input, existing profile or publication.",
    limits: "This is bounded deterministic workflow acceptance, not complete Browser Use parity, a model solver comparison, ordinary company Edge acceptance, or OS foreground observation. Native dialog events are recorded without intercepting commands. CIM identities supplement original retained-handle/Job lifecycle; raw uint64 native FILETIME remains text and original bytes.",
    budgetObservation: { ...dialogBudgetLimits, capLatestCloseExclusive: true, sampleIntervalVersion: 1,
      interpretation: "Raw passive-listener opening/closed timestamps measure an approximately 300-second natural cap, not the product's internal monotonic clock. The 250ms early tolerance accounts for the observer seeing opening after production handling; it does not shorten the 300000ms product budget. Exact production boundaries require separate monotonic fake-clock tests. The delayed answer still requires an actual outgoing request at least 40000ms after observed opening and a pending original input throughout that wait." } };
  const save = () => fs.writeFile(path.join(runDir, "results.json"), serialize(report));
  const registry = new Set(), frameWrites = [];
  const fixtures = managedDialogBudgetCases(mode).map(cases => createManagedDialogFixture({ cases }));
  const server = createServer((req, res) => { if (!fixtures.some(item => item.handle(req, res))) { report.unexpectedRequests.push({ method: req.method, url: req.url, at: Date.now() }); req.resume(); res.writeHead(404); res.end(); } });
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
  const readDocument = () => worker.evaluate(`chrome.scripting.executeScript({target:{tabId:${tab.id}},func:${readManagedDialogDocument.toString()}}).then(rows=>{if(rows.length!==1)throw Error('Ambiguous original page');return {documentId:rows[0].documentId,frameId:rows[0].frameId,...rows[0].result}})`, 5000);
  const observedEvents = () => (worker?.events ?? []).filter(row => row.method === "Runtime.bindingCalled" && row.params?.name === "__obuManagedDialogEvent").map(row => ({ ...JSON.parse(row.params.payload), receivedAt: row.receivedAt }));
  async function screenshot(label) { const file = `viewer-${label}.png`, bytes = await page.screenshot({ path: path.join(runDir, file), timeout: 5000 }); const value = { file, at: Date.now(), bytes: bytes.length, sha256: hash(bytes) }; report.screenshots.push(value); return value; }
  async function uiObservation(label) {
    const value = await bound(page.evaluate(() => {
      const visible = element => { const r = element.getBoundingClientRect(), s = getComputedStyle(element); return !element.hidden && s.display !== "none" && s.visibility !== "hidden" && r.width > 0 && r.height > 0; };
      return { connection: document.querySelector("#connection")?.textContent, state: document.querySelector("#state")?.textContent,
        humanStatus: document.querySelector("#human-status")?.textContent, error: document.querySelector("#error")?.textContent,
        input: { ...document.querySelector("#human-input")?.dataset },
        buttons: [...document.querySelectorAll("button")].map(el => ({ id: el.id, text: el.textContent, disabled: el.disabled, visible: visible(el) })),
        dialogUI: [...document.querySelectorAll("#page-dialog,dialog,[role=dialog]")].map(el => ({ id: el.id, visible: visible(el), text: el.textContent.slice(0, 2048) })) };
    }), 5000, "viewer-only UI observation");
    const item = { label, at: Date.now(), ...value, publishedState: state ? structuredClone(state) : null }; report.uiObservations.push(item); return item;
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
      socket.on("framesent", event => { try { const value = projectHumanDialogCommand(JSON.parse(String(event.payload))); if (value) { assert.ok(report.viewerCommands.length < 1024); report.viewerCommands.push({ ...value, at: Date.now() }); } } catch (error) { captureError ??= error; } });
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
      await rememberProcesses("before-stop"); report.beforeStop = { at: Date.now(), nativeEvents: observedEvents(), fixtures: fixtures.map(item => item.stats()) }; await save();
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
    const selectedPaths = mode === "acceptance" ? ["cmd", "internal", "apps/chrome-extension", "packages/open-browser-use-js", "packages/open-browser-use-go", "packages/open-browser-use-python", "scripts/browser-integration", "scripts/build-chrome-extension.mjs", ":(glob)scripts/patch-*.mjs", "go.mod", "go.sum", "package.json", "pnpm-lock.yaml"] : ["packages/open-browser-use-js", "scripts/browser-integration"];
    const selected = await launch("git", ["ls-files", "--cached", "--others", "--exclude-standard", "--", ...selectedPaths], { timeoutMs: 15000 }).completed;
    assert.equal(selected.code, 0); return [...new Set(selected.stdout.trim().split(/\r?\n/))].sort();
  }
  const measureButton = caseId => worker.evaluate(`chrome.scripting.executeScript({target:{tabId:${tab.id}},func:${measureManagedDialogButton.toString()},args:[${JSON.stringify(caseId)}]}).then(rows=>{if(rows.length!==1)throw Error('Ambiguous original measurement');return rows[0].result})`, 5000);
  const nativeFor = business => observedEvents().filter(row => row.source.tabId === business.tabId || row.source.targetId === business.target.id);
  async function decodedHuman() {
    return wait(async () => {
      const image = await page.locator("#frame").evaluate(element => ({ hidden: element.hidden, complete: element.complete, width: element.naturalWidth, height: element.naturalHeight, ...element.dataset }));
      const frame = report.frames.findLast(row => row.controlMode === "human" && row.tabId === tab.id && row.streamId === image.streamId && row.sequence === Number(image.frameSequence));
      return frame && !image.hidden && image.complete && image.width > 0 && state?.human?.state === "active" && state.human.leaseId === frame.humanLeaseId && state.human.generation === frame.generation && !state.pendingDialog && await page.locator("#human-input").getAttribute("data-enabled") === "true" && { image, frame };
    }, "decoded current original human frame", 20000);
  }
  async function beginHuman(business) {
    const delivered = state.tabs.find(value => value.id === tab.id);
    assert.equal(delivered?.kind, "result"); assert.equal(delivered.takeover, true); assert.ok(delivered.deliveryId);
    business.delivery = structuredClone(delivered);
    await uiAction("#tabs", "select", tab.id); business.humanBegin = await uiAction("#human-begin", "humanBegin");
    const request = report.viewerCommands.findLast(value => value.operation === "humanBegin");
    assert.equal(request.tabId, tab.id); assert.equal(request.deliveryId, delivered.deliveryId);
    assert.equal(business.humanBegin.status.state, "paused"); business.decodedHuman = await decodedHuman();
    business.beforeHuman = await readDocument(); assert.equal(business.beforeHuman.documentId, business.before.documentId);
    assert.equal(business.beforeHuman.state.documentToken, business.before.state.documentToken);
  }
  async function budgetCase(business, currentFixture, kind) {
    const item = currentFixture.cases[0], decoded = await decodedHuman(), measurement = await measureButton(item.id); assert.equal(measurement.clickable, true);
    const before = await readDocument(); assert.equal(before.documentId, business.before.documentId); assert.equal(before.state.documentToken, business.before.state.documentToken);
    const pointer = visibleHumanViewerPoint(measurement.rect, state.human.viewport, await page.locator("#frame").boundingBox(), decoded.image);
    const originalScope = { leaseId: state.human.leaseId, generation: state.human.generation };
    const eventStart = nativeFor(business).length, commandStart = report.viewerCommands.length;
    const record = { caseId: item.id, kind, tabId: tab.id, startedAt: Date.now(), measurement, pointer, originalScope, gestureCount: 1, samples: [] };
    report.dialogs.push(record);
    const gesture = page.mouse.click(pointer.viewerPoint.x, pointer.viewerPoint.y).then(() => { record.gestureCompletedAt = Date.now(); }, error => { record.gestureError = error.stack; });
    record.opening = await wait(() => nativeFor(business).slice(eventStart).find(row => row.method === "Page.javascriptDialogOpening"), "original native prompt opening", 10000);
    assert.deepEqual(record.opening.source, { targetId: business.target.id }); assert.equal(record.opening.params.frameId, business.target.id);
    assert.equal(record.opening.params.type, "prompt"); assert.equal(record.opening.params.message, item.message);
    assert.equal(record.opening.params.defaultPrompt, item.defaultValue); assert.equal(record.opening.params.url, report.fixtureURL + currentFixture.paths.page);
    record.pendingDialog = await wait(() => state?.pendingDialog && structuredClone(state.pendingDialog), "published original pending dialog", 4000);
    assert.deepEqual(record.pendingDialog, { ...originalScope, dialogId: record.pendingDialog.dialogId, type: item.type, message: item.message, defaultPrompt: item.defaultValue });
    record.triggerRequest = await wait(() => report.viewerCommands.slice(commandStart).find(row => row.operation === "humanInput" && row.input.type === "pointer" && row.input.action === "up"), "original triggering pointer-up");
    await uiObservation(`opened-${item.id}`); await screenshot(`opened-${item.id}`);
    const sampleOriginal = () => readDialogBudgetSample({ readStatus: () => state,
      readTriggerResponse: () => report.viewerMessages.find(row => row.type === "response" && row.id === record.triggerRequest.id),
      readNativeClosed: () => nativeFor(business).slice(eventStart).find(row => row.method === "Page.javascriptDialogClosed"),
      readDialogVisible: () => page.locator("#page-dialog").isVisible(),
      readViewerInput: () => page.locator("#human-input").getAttribute("data-enabled") });
    let nextProgress = 0;
    const limit = kind === "cap" ? dialogBudgetLimits.capObservationMs : dialogBudgetLimits.deliberateMs;
    while (Date.now() - record.opening.at < limit) {
      check(); const sample = await sampleOriginal();
      assert.ok(record.samples.length < 345); record.samples.push(sample);
      assertDialogBudgetSample(sample, record, kind);
      if (sample.nativeClosed) { record.closed = sample.nativeClosed; break; }
      const elapsed = Date.now() - record.opening.at;
      if (elapsed >= nextProgress) {
        console.log("MODAL_WAIT", JSON.stringify({ runDir, mode, caseId: item.id, elapsedMs: elapsed, active: sample.human?.state, inputAcknowledged: Boolean(sample.triggerResponse?.result?.inputReceipt) }));
        nextProgress += 30000; report.nativeEvents = observedEvents(); await save();
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    if (kind === "deliberate") {
      const last = await sampleOriginal();
      assertDialogBudgetHeld(last, record); record.afterFortySeconds = last;
      assert.ok(last.at - record.opening.at >= dialogBudgetLimits.deliberateMs);
      await page.locator("#dialog-prompt").fill(managedDialogUnicode, { timeout: 2000 }); await screenshot("deliberate-unicode-before-answer");
      record.reply = await uiAction("#dialog-accept", "humanDialogRespond"); record.request = report.viewerCommands.slice(commandStart).find(row => row.operation === "humanDialogRespond");
      assert.deepEqual(record.reply.dialogReceipt, { ...originalScope, dialogId: record.pendingDialog.dialogId, acknowledged: true });
      assert.equal(record.request.promptBytes, Buffer.byteLength(managedDialogUnicode)); assert.equal(record.request.promptSHA256, hash(managedDialogUnicode));
    }
    if (kind === "old-cap-diagnostic" && !record.closed) {
      report.diagnosticGapConfirmed = false; record.interpretation = "No native cancellation within the observation window; do not manufacture a delayed acknowledgement or claim the old deadline gap was reproduced.";
      await bound(gesture, 5000, "original old-runtime viewer gesture"); await screenshot("old-gap-not-confirmed"); return;
    }
    record.closed ??= await wait(() => nativeFor(business).slice(eventStart).find(row => row.method === "Page.javascriptDialogClosed"), "original native modal closed", 5000);
    record.nativePair = assertDialogBudgetNativePair(record, business, kind);
    await bound(gesture, 5000, "original viewer gesture completion"); assert.equal(record.gestureError, undefined);
    const inputs = report.viewerCommands.slice(commandStart).filter(row => row.operation === "humanInput");
    assert.deepEqual(inputs.map(row => [row.input.type, row.input.action]), [["pointer", "move"], ["pointer", "down"], ["pointer", "up"]]);
    record.inputs = [];
    for (const request of inputs) {
      const response = await wait(() => report.viewerMessages.find(row => row.type === "response" && row.id === request.id), "original input outcome"); record.inputs.push({ request, response });
      if (kind === "deliberate" || !response.error) assertHumanInputReceipt(request, response);
    }
    const after = await wait(async () => { const value = await readDocument(); return value.state.phase === "committed" && value; }, "original one-POST receipt");
    assert.equal(after.documentId, business.before.documentId); assert.equal(after.state.documentToken, business.before.state.documentToken);
    business.after = after; business.receipt = currentFixture.verify(after);
    if (kind === "deliberate") business.humanEnd = await uiAction("#human-end", "humanEnd");
    else business.humanEnd = await wait(() => state?.human === null && state.humanCleanup?.cleanupConfirmed && structuredClone(state), "original automatic modal retirement cleanup", 20000);
    assertManagedDialogEnded(business.humanEnd, originalScope.leaseId);
    if (kind === "old-cap-diagnostic") {
      const trigger = record.inputs.find(value => value.request.id === record.triggerRequest.id);
      report.diagnosticGapConfirmed = record.nativePair.elapsedMs < dialogBudgetLimits.deliberateMs && Boolean(trigger.response.error) && !record.request;
    }
    record.passed = true; record.endedAt = Date.now(); report.nativeEvents = observedEvents(); await uiObservation(`closed-${item.id}`); await screenshot(`closed-${item.id}`); await save();
    console.log("BUDGET_CASE", JSON.stringify({ kind, elapsedMs: record.nativePair.elapsedMs, passed: true }));
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

  try {
    await step("freeze-built-runtime-and-acceptance-inputs", async () => {
      const buildBytes = await fs.readFile(buildFile), build = JSON.parse(buildBytes);
      assert.equal(build.passed, true); assert.ok(build.sourceInputs && build.extensionFiles);
      report.source = { commit: build.sourceCommit, executable: hash(await fs.readFile(executable)), browser: hash(await fs.readFile(chromium)), extension: await treeHashes(extension), sdk: await treeHashes(path.join(repo, "packages/open-browser-use-js/dist")), snapshot: {} };
      report.source.provenance = "The build manifest commit is its recorded base, not a claim of a clean checkout. Its exact sourceInputs and immutable source-snapshot bytes define the executable's implementation. Current acceptance harness and SDK inputs are frozen separately.";
      assert.equal(report.source.executable, build.exeSHA256); assert.deepEqual(report.source.extension, build.extensionFiles);
      assert.equal(report.source.browser, "566971689aecea06a88355ea1e9020c908b7a3b093dd0d2a12ae7073489a77aa");
      report.buildEvidence = { file: "build-manifest.json", path: buildFile, sha256: hash(buildBytes) };
      await fs.writeFile(path.join(runDir, "build-manifest.json"), buildBytes, { flag: "wx" });
      const files = await sourceFiles();
      for (const file of files) {
        inside(repo, path.resolve(repo, file)); const bytes = await fs.readFile(path.join(repo, file)); report.source.snapshot[file] = hash(bytes);
        const destination = path.join(runDir, "source-snapshot", file); await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.writeFile(destination, bytes, { flag: "wx" });
      }
      report.source.builtInputs = build.sourceInputs;
      const buildSnapshot = path.join(path.dirname(buildFile), "source-snapshot"); report.source.buildSnapshot = buildSnapshot;
      for (const [file, expected] of Object.entries(build.sourceInputs)) {
        inside(buildSnapshot, path.resolve(buildSnapshot, file)); const bytes = await fs.readFile(path.join(buildSnapshot, file)); assert.equal(hash(bytes), expected);
        const target = path.join(runDir, "built-source-snapshot", file); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, bytes, { flag: "wx" });
        if (mode === "acceptance") assert.equal(report.source.snapshot[file], expected, `Current product must match this build: ${file}`);
      }
      if (mode === "acceptance") {
        const runtime = file => /^(cmd\/|internal\/|apps\/chrome-extension\/)/.test(file) && !/\.test\.|_test\.go$/.test(file);
        assert.deepEqual(files.filter(runtime).sort(), Object.keys(build.sourceInputs).filter(runtime).sort());
      }
      await fs.cp(path.join(repo, "packages/open-browser-use-js/dist"), path.join(runDir, "sdk-input"), { recursive: true });
      await fs.cp(extension, path.join(runDir, "extension-input"), { recursive: true });
      await listenFixture(server); report.fixtureURL = `http://127.0.0.1:${server.address().port}`;
    });
    await step("formal-managed-start-and-delivered-original-pages", async () => {
      launcher = launch(executable, ["managed", "run", "--root", root, "--name", name, "--browser-path", chromium, "--extension-dir", extension, "--startup-timeout", "30s"]);
      const ready = await wait(() => { assert.ok(!launcher.record.closedAt && !launcher.record.exitedAt); return parseManagedReadyOutput(launcher.record.stdout); }, "managed ready", 40000);
      assert.equal(ready.state, "ready"); info = ready.info; report.info = info; inside(root, info.runDir);
      const life = await lifecycle("ready"); assertManagedViewerBrowserCommand(life, chromium); assert.deepEqual(life.info, info);
      assert.deepEqual(JSON.parse((await command(["managed", "status", "--root", root, "--name", name])).stdout).info, info);
      const privateEndpoint = await endpoint(info.profileDir, launcher), response = await fetch(`http://127.0.0.1:${privateEndpoint.port}/json/list`, { signal: AbortSignal.timeout(10000) });
      const targets = (await response.json()).filter(row => row.type === "service_worker" && row.url === `chrome-extension://${info.extensionId}/background.js`); assert.equal(targets.length, 1);
      report.workerTarget = { id: targets[0].id, url: targets[0].url }; report.workerConnection = {};
      worker = await connectNormalCDP(targets[0].webSocketDebuggerUrl, { record: report.workerConnection, handshakeTimeoutMs: 10000, authorizationRequired: false });
      const { connectOpenBrowserUse } = await import(pathToFileURL(path.join(runDir, "sdk-input/index.js")));
      taskBrowser = await connectOpenBrowserUse({ socketPath: info.socketPath, sessionId: "managed-human-dialog-acceptance", timeoutMs: 10000 });
      for (const current of fixtures) {
        tab = await taskBrowser.newTab({ url: report.fixtureURL + current.paths.page, backgroundWindow: true });
        const business = { tabId: tab.id, workflowId: current.workflowId, snapshot: await tab.domSnapshot(), before: await readDocument() };
        assert.ok(business.before.documentId); assert.equal(business.before.state.results.length, 0);
        const original = await worker.evaluate(`chrome.debugger.getTargets().then(rows=>rows.filter(row=>row.type==='page'&&row.tabId===${tab.id}).map(row=>({id:row.id,tabId:row.tabId,url:row.url,attached:row.attached})))`);
        assert.equal(original.length, 1); business.target = original[0]; report.documents.push(business);
        // Measure every original button before any native business interaction.
        business.preflight = [];
        for (const item of current.cases) {
          const measurement = await measureButton(item.id); assert.equal(measurement.clickable, true, `Original button must be visible: ${item.id}`); business.preflight.push(measurement);
        }
      }
      await worker.call("Runtime.enable"); await worker.call("Runtime.addBinding", { name: "__obuManagedDialogEvent" });
      const originals = report.documents.map(item => ({ tabId: item.tabId, targetId: item.target.id }));
      report.nativeObserver = await worker.evaluate(`(${installDialogObservation.toString()})(chrome,globalThis,${JSON.stringify(originals)})`);
      const keep = report.documents.map(item => ({ tabId: item.tabId, status: "deliverable" }));
      report.finalize = { keep, before: { turnId: taskBrowser.client.turnId, controlEpoch: taskBrowser.client.controlEpoch }, startedAt: Date.now() };
      report.finalize.result = await taskBrowser.client.finalizeTabs(keep); report.finalize.endedAt = Date.now();
      assert.equal(report.finalize.result.endedTurnId, report.finalize.before.turnId);
      assert.ok(report.finalize.result.controlEpoch > report.finalize.before.controlEpoch);
      await rememberProcesses("managed-ready");
    });
    await step("formal-view-and-first-human-takeover", async () => {
      const startup = browserStartupOptions([`--user-data-dir=${viewerProfile}`, "--headless=new", "--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "about:blank"], process.env.OBU_TEST_FIELD_TRIAL_CONFIG);
      report.viewerStartup = startup; viewerProcess = launch(chromium, startup.args);
      viewerBrowser = await playwrightChromium.connectOverCDP((await endpoint(viewerProfile, viewerProcess)).url);
      const context = await viewerBrowser.newContext({ viewport: { width: 1280, height: 1000 } }); page = await context.newPage();
      const view = JSON.parse((await command(["managed", "view", "--root", root, "--name", name])).stdout), url = new URL(view.viewerURL); assert.equal(url.hostname, "127.0.0.1"); report.viewerOrigin = url.origin; report.viewerTicketSHA256 = hash(url.hash);
      await openViewer(url.href); await uiAction("#refresh", "status");
      tab = { id: report.documents[0].tabId }; await beginHuman(report.documents[0]);
      await rememberProcesses("both-private-browsers");
    });
    await step("bounded-original-modal-waiting", async () => {
      await budgetCase(report.documents[0], fixtures[0], mode === "old-cap-diagnostic" ? mode : "deliberate");
      if (mode === "acceptance") {
        tab = { id: report.documents[1].tabId }; await beginHuman(report.documents[1]); await budgetCase(report.documents[1], fixtures[1], "cap");
        assert.equal(report.viewerCommands.filter(row => row.operation === "humanDialogRespond").length, 1);
      } else assert.equal(report.viewerCommands.some(row => row.operation === "humanDialogRespond"), false);
      report.nativeEvents = observedEvents(); report.observerBeforeStop = await worker.evaluate("__managedDialogDiagnostic.snapshot()", 3000);
      assert.equal(report.observerBeforeStop.overflow, false); assert.ok(!report.workerConnection.eventsDropped); assert.deepEqual(report.unexpectedRequests, []);
    });
    await step("formal-stop-of-original-managed-session", stopOriginal);
  } catch (error) { report.error = error.stack ?? String(error); console.error(redact(report.error)); }
  finally {
    if (taskBrowser) await cleanup("sdk", async () => { await bound(taskBrowser.close(), 5000, "original SDK close"); return { closed: true }; });
    if (launcher && !report.supervisorExit) await cleanup("stop", stopOriginal);
    if (launcher && !launcher.record.closedAt) await cleanup("supervisorFallback", async () => { launcher.terminate("managed-dialog-original-supervisor-fallback"); await bound(launcher.completed.catch(() => {}), 12000, "original supervisor fallback close"); throw Error("Original supervisor required forced fallback"); });
    if (launcher && !finalSaved) await cleanup("finalLifecycle", () => lifecycle("final"));
    if (worker) await cleanup("workerObserver", async () => {
      report.nativeEvents = observedEvents(); report.workerEventOverflow = report.workerConnection.eventsDropped;
      if (worker.state() === "open") report.observerFinal = await worker.evaluate("__managedDialogDiagnostic.stop()", 3000);
      else report.observerFinal = { originalWorkerEnded: true, state: worker.state(), noEvaluateAfterClose: true };
      await worker.close(); return { closed: true };
    });
    if (viewerBrowser) await cleanup("viewerBrowser", async () => {
      const session = await bound(viewerBrowser.newBrowserCDPSession(), 5000, "original viewer close session"); await bound(session.send("Browser.close"), 5000, "original viewer close");
      const result = await bound(viewerProcess.completed, 12000, "original viewer actual exit"); assert.equal(result.code, 0); assert.equal(result.termination, undefined);
      await bound(viewerBrowser.close(), 5000, "original viewer client close"); return { code: result.code, exitedAt: result.exitedAt, closedAt: result.closedAt };
    });
    if (viewerProcess && !viewerProcess.record.closedAt) await cleanup("viewerFallback", async () => { viewerProcess.terminate("managed-dialog-original-viewer-fallback"); await bound(viewerProcess.completed.catch(() => {}), 12000, "original viewer forced close"); throw Error("Original viewer required forced fallback"); });
    if (info) await cleanup("privateResources", resources);
    if (report.processObservations.length) await cleanup("originalProcesses", async () => {
      const originals = [...new Map(report.processObservations.flatMap(row => row.groups).flatMap(row => row.processes).map(row => [`${row.ProcessId}/${row.CreationDate}`, row])).values()]; report.originalProcesses = originals;
      return poll(async () => { const rows = await table(), remaining = originals.filter(before => rows.some(after => before.ProcessId === after.ProcessId && before.CreationDate === after.CreationDate)); return !remaining.length && { at: Date.now(), originalIdentities: originals.length, remaining }; }, { timeoutMs: 15000, intervalMs: 100, label: "original process identities gone" });
    });
    await cleanup("frames", async () => { await Promise.all(frameWrites); check(); return { observed: report.frames.length, saved: frameWrites.length }; });
    await cleanup("fixture", async () => { server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve)); return { closed: !server.listening }; });
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
    report.fixtures = fixtures.map(item => item.stats()); report.liveRunnerChildren = [...registry].map(child => child.pid); report.endedAt = Date.now();
    report.completed = !report.error && report.steps.length === 5 && report.steps.every(row => row.passed) && !report.cleanupErrors.length && !registry.size;
    report.featurePassed = mode === "acceptance" && report.completed; report.diagnosticCompleted = mode === "old-cap-diagnostic" && report.completed;
    await save(); console.log("RESULT", JSON.stringify({ runDir, mode, completed: report.completed, featurePassed: report.featurePassed, diagnosticGapConfirmed: report.diagnosticGapConfirmed ?? false, dialogs: report.dialogs.length }));
  }
  return report;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  assert.equal(process.argv.length, 2, "No retry or alternate business mode");
  const report = await runManagedHumanDialogBudgetCheck(); process.exitCode = report.completed ? 0 : 1;
}
