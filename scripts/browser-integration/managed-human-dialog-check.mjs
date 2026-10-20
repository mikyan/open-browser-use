// Real managed viewer dialog acceptance. Only production viewer gestures answer
// native dialogs; the worker observer records original events and reads documents.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium as playwrightChromium } from "playwright";
import { createManagedDialogFixture, readManagedDialogDocument, measureManagedDialogButton, managedDialogUnicode } from "./managed-dialog-fixture.mjs";
import { projectHumanCommand, assertHumanInputReceipt, visibleHumanViewerPoint } from "./managed-human-check.mjs";
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

export function projectHumanDialogCommand(message) {
  if (message?.operation !== "humanDialogRespond") return projectHumanCommand(message);
  const fields = ["id", "operation", "leaseId", "generation", "dialogId", "accept"];
  if (Object.hasOwn(message, "promptText")) fields.push("promptText");
  assert.deepEqual(Object.keys(message).sort(), fields.sort());
  assert.ok(Number.isSafeInteger(message.id) && message.id > 0);
  assert.ok(typeof message.leaseId === "string" && message.leaseId.length > 0 && message.leaseId.length <= 128);
  assert.ok(!/[\x00-\x1f\x7f]/.test(message.leaseId));
  assert.ok(Number.isSafeInteger(message.generation) && message.generation > 0);
  assert.ok(typeof message.dialogId === "string" && message.dialogId.length > 0 && message.dialogId.length <= 128);
  assert.ok(!/[\x00-\x1f\x7f]/.test(message.dialogId));
  assert.equal(typeof message.accept, "boolean");
  const result = { ...message };
  if (Object.hasOwn(message, "promptText")) {
    assert.equal(message.accept, true); assert.equal(typeof message.promptText, "string");
    assert.ok(message.promptText.isWellFormed() && Buffer.byteLength(message.promptText) <= 8192);
    delete result.promptText; result.promptBytes = Buffer.byteLength(message.promptText); result.promptSHA256 = hash(message.promptText);
  }
  return result;
}

export function assertManagedDialogNativePair(record, original, decision) {
  const { opening, closed } = record;
  assert.equal(opening.method, "Page.javascriptDialogOpening"); assert.equal(closed.method, "Page.javascriptDialogClosed");
  for (const event of [opening, closed]) {
    assert.ok(event.source && Object.keys(event.source).length > 0);
    assert.ok(Object.keys(event.source).every(key => ["tabId", "targetId"].includes(key)), "Only the original root attachment may emit this dialog");
    if (Object.hasOwn(event.source, "tabId")) assert.equal(event.source.tabId, original.tabId);
    if (Object.hasOwn(event.source, "targetId")) assert.equal(event.source.targetId, original.target.id);
    assert.equal(event.params.frameId, original.target.id, "Dialog must belong to the original root frame");
    assert.ok(Number.isSafeInteger(event.sequence) && event.sequence > 0);
    assert.ok(Number.isSafeInteger(event.at) && event.at > 0);
  }
  assert.deepEqual(closed.source, opening.source); assert.equal(closed.sequence, opening.sequence + 1);
  assert.equal(decision.operation, record.endInstead ? "humanEnd" : "humanDialogRespond");
  assert.equal(decision.leaseId, record.originalScope.leaseId);
  if (!record.endInstead) {
    assert.equal(decision.generation, record.originalScope.generation); assert.equal(decision.dialogId, record.pendingDialog.dialogId);
  }
  assert.ok(Number.isSafeInteger(decision.at) && decision.at >= opening.at && decision.at - opening.at < 5000, "The original request must actually be sent within five seconds");
  assert.ok(closed.at >= decision.at, "Original native close cannot precede its decision request");
  return { originalTabId: original.tabId, originalTargetId: original.target.id, openingSequence: opening.sequence, closedSequence: closed.sequence, decisionDelayMs: decision.at - opening.at };
}

export function assertManagedDialogEnded(value, leaseId) {
  assert.equal(value.human, null); assert.equal(value.pendingDialog, null); assert.equal(value.status.state, "paused");
  assert.equal(value.viewerCleanupComplete, true); assert.deepEqual(value.humanCleanup, { leaseId, cleanupConfirmed: true });
}

export function assertManagedHumanDialogScenario(scenario) {
  if (scenario === undefined) return;
  assert.ok(["beforeunload-diagnostic", "beforeunload-acceptance"].includes(scenario.kind));
  assert.equal(scenario.instrumented, scenario.kind === "beforeunload-diagnostic");
  assert.ok(Array.isArray(scenario.fixtures) && scenario.fixtures.length === 1);
  for (const key of ["readDocument", "measureButton", "installObservation", "isTraceComplete", "run"]) assert.equal(typeof scenario[key], "function", key);
  assert.equal(scenario.observerExpression, scenario.instrumented ? "__managedHumanNativeTrace" : "__managedBeforeunloadObservation");
}

export function managedDialogScenarioOutcome(scenario, completed, observationComplete) {
  const featurePassed = completed === true && (!scenario || scenario.instrumented === false && observationComplete === true);
  return { featurePassed, ...(scenario ? { passed: featurePassed, traceComplete: observationComplete === true,
    diagnosticCompleted: scenario.instrumented === true && completed === true && observationComplete === true } : {}) };
}

export async function runManagedHumanDialogCheck({ scenario } = {}) {
  assertManagedHumanDialogScenario(scenario);
  assert.equal(process.platform, "win32");
  const executable = process.env.OBU_TEST_HOST_BINARY, extension = process.env.OBU_TEST_EXTENSION_DIR;
  const chromium = process.env.OBU_TEST_CHROMIUM_BINARY, buildFile = process.env.OBU_TEST_BUILD_MANIFEST;
  for (const file of [executable, extension, chromium, buildFile]) { assert.ok(typeof file === "string" && path.isAbsolute(file)); await fs.access(file); }
  await fs.mkdir(path.join(repo, ".tmp/browser-integration"), { recursive: true });
  const runDir = await fs.mkdtemp(path.join(repo, scenario ? ".tmp/browser-integration/mbu-" : ".tmp/browser-integration/mhd-")), root = path.join(runDir, "r"), name = "n", viewerProfile = path.join(runDir, "v");
  const report = { runDir, startedAt: Date.now(), steps: [], commands: [], probes: [], lifecycleSnapshots: [], processObservations: [], screenshots: [], frames: [],
    documents: [], dialogs: [], viewerCommands: [], viewerMessages: [], viewerActions: [], uiObservations: [], nativeEvents: [], unexpectedRequests: [], cleanup: {}, cleanupErrors: [], featurePassed: false,
    scope: "Six real native dialogs on two original fixture documents explicitly finalized as deliverables before viewer access: five production viewer answers, then End cancels one unanswered prompt. No task-page CDP attach, direct dialog handling, input replay, OS input, existing profile or package publication.",
    limits: "This is bounded deterministic workflow acceptance, not complete Browser Use parity, a model solver comparison, ordinary company Edge acceptance, or OS foreground observation. Native dialog events are recorded without intercepting commands. CIM identities supplement original retained-handle/Job lifecycle; raw uint64 native FILETIME remains text and original bytes." };
  if (scenario) Object.assign(report, { scenario: scenario.kind, instrumented: scenario.instrumented, passed: false, diagnosticCompleted: false, scope: scenario.scope, limits: scenario.limits });
  const save = () => fs.writeFile(path.join(runDir, "results.json"), serialize(report));
  const registry = new Set(), frameWrites = [];
  const fixture = scenario ? null : createManagedDialogFixture(), endFixture = scenario ? null : createManagedDialogFixture({ cases: [{ id: "prompt-end", type: "prompt", answer: null }] });
  const fixtures = scenario ? scenario.fixtures : [fixture, endFixture];
  const documentReader = scenario?.readDocument ?? readManagedDialogDocument, buttonMeasurer = scenario?.measureButton ?? measureManagedDialogButton;
  const observerExpression = scenario?.observerExpression ?? "__managedDialogDiagnostic";
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
  const readDocument = () => worker.evaluate(`chrome.scripting.executeScript({target:{tabId:${tab.id}},func:${documentReader.toString()}}).then(rows=>{if(rows.length!==1)throw Error('Ambiguous original page');return {documentId:rows[0].documentId,frameId:rows[0].frameId,...rows[0].result}})`, 5000);
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
      socket.on("framesent", event => { try { const value = projectHumanDialogCommand(JSON.parse(String(event.payload))); if (value) { assert.ok(report.viewerCommands.length < 256); report.viewerCommands.push({ ...value, at: Date.now() }); } } catch (error) { captureError ??= error; } });
      socket.on("close", () => report.viewerMessages.push({ type: "socketClosed", at: Date.now() }));
      socket.on("framereceived", event => {
        try {
          const message = JSON.parse(String(event.payload)), at = Date.now(); assert.ok(report.viewerMessages.length < 2048);
          if (message.type === "frame") {
            assert.equal(message.mimeType, "image/png"); assert.ok(typeof message.data === "string" && message.data.length < 6 * 1024 * 1024);
            const bytes = Buffer.from(message.data, "base64"); assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]); assert.ok(bytes.length > 24 && report.frames.length < 1024);
            const frame = { ...message, data: undefined, at, index: report.frames.length, bytes: bytes.length, sha256: hash(bytes), width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
            if (scenario?.instrumented === false || frame.index < 12 || frame.index % 10 === 0) { frame.file = `native-frame-${String(frame.index).padStart(4, "0")}.png`; const write = fs.writeFile(path.join(runDir, frame.file), bytes, { flag: "wx" }); frameWrites.push(write); write.catch(error => { captureError ??= error; }); }
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
      if (scenario && worker?.state() === "open") {
        try { report.diagnosticBeforeStop = await worker.evaluate(`${observerExpression}.stop()`, 3000); }
        catch (error) { report.diagnosticStopObservationError = error.stack; }
      }
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
    const selected = await launch("git", ["ls-files", "--cached", "--others", "--exclude-standard", "--", "cmd", "internal", "apps/chrome-extension", "packages/open-browser-use-js", "packages/open-browser-use-go", "packages/open-browser-use-python", "scripts/browser-integration", "scripts/build-chrome-extension.mjs", ":(glob)scripts/patch-*.mjs", ":(glob)scripts/*.test.mjs", "go.mod", "go.sum", "package.json", "pnpm-lock.yaml"], { timeoutMs: 15000 }).completed;
    assert.equal(selected.code, 0); return [...new Set(selected.stdout.trim().split(/\r?\n/))].sort();
  }
  const measureButton = caseId => scenario?.measureOriginal ? scenario.measureOriginal({ worker, tabId: tab.id, caseId })
    : worker.evaluate(`chrome.scripting.executeScript({target:{tabId:${tab.id}},func:${buttonMeasurer.toString()},args:[${JSON.stringify(caseId)}]}).then(rows=>{if(rows.length!==1)throw Error('Ambiguous original measurement');return rows[0].result})`, 5000);
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
  async function dialogCase(item, business, currentFixture, endInstead) {
    const decoded = await decodedHuman(), measurement = await measureButton(item.id); assert.equal(measurement.clickable, true);
    const before = await readDocument(); assert.equal(before.documentId, business.before.documentId); assert.equal(before.state.documentToken, business.before.state.documentToken);
    const pointer = visibleHumanViewerPoint(measurement.rect, state.human.viewport, await page.locator("#frame").boundingBox(), decoded.image);
    const originalScope = { leaseId: state.human.leaseId, generation: state.human.generation };
    const eventStart = nativeFor(business).length, commandStart = report.viewerCommands.length;
    const record = { caseId: item.id, type: item.type, tabId: tab.id, endInstead, startedAt: Date.now(), measurement, pointer, originalScope, gestureCount: 1, waitsForInputAckBeforeObservation: false };
    report.dialogs.push(record);
    const gesture = page.mouse.click(pointer.viewerPoint.x, pointer.viewerPoint.y).then(() => { record.gestureCompletedAt = Date.now(); }, error => { record.gestureError = error.stack; });
    const opening = await wait(() => nativeFor(business).slice(eventStart).find(row => row.method === "Page.javascriptDialogOpening"), "original native dialog opening", 10000);
    record.opening = opening; assert.equal(opening.params.type, item.type); assert.equal(opening.params.message, item.message);
    assert.equal(opening.params.url, report.fixtureURL + currentFixture.paths.page); assert.equal(opening.params.hasBrowserHandler, true);
    if (item.type === "prompt") assert.equal(opening.params.defaultPrompt, item.defaultValue);
    record.pendingDialog = await wait(async () => state?.pendingDialog && await page.locator("#page-dialog").isVisible() && await page.locator("#dialog-accept").isEnabled() && structuredClone(state.pendingDialog), "published exact native dialog and ready controls", 4000);
    assert.deepEqual(record.pendingDialog, { ...originalScope, dialogId: record.pendingDialog.dialogId, type: item.type, message: item.message, ...(item.type === "prompt" ? { defaultPrompt: item.defaultValue } : {}) });
    assert.ok(typeof record.pendingDialog.dialogId === "string" && record.pendingDialog.dialogId.length > 0);
    assert.equal(await page.locator("#dialog-message").textContent(), item.message);
    record.atOpening = { at: Date.now(), requests: report.viewerCommands.slice(commandStart), replies: report.viewerMessages.filter(row => row.type === "response" && report.viewerCommands.slice(commandStart).some(command => command.id === row.id)) };
    if (item.type === "prompt") {
      assert.equal(await page.locator("#dialog-prompt").inputValue(), item.defaultValue);
      if (!endInstead && item.answer !== null) await page.locator("#dialog-prompt").fill(item.answer, { timeout: 1000 });
    }
    await uiObservation(`pending-${item.id}`); await screenshot(`pending-${item.id}`);
    assert.equal(report.viewerCommands.slice(commandStart).filter(row => row.operation === "humanEnd").length, 0, "No unrelated focus revocation during original modal");
    record.answerStartedAt = Date.now(); assert.ok(record.answerStartedAt - opening.at < 5000, "Respond promptly without extending the original operation deadline");
    if (endInstead) {
      record.endReply = await uiAction("#human-end", "humanEnd"); assertManagedDialogEnded(record.endReply, originalScope.leaseId); business.humanEnd = record.endReply;
      const requests = report.viewerCommands.slice(commandStart).filter(row => row.operation === "humanEnd"); assert.equal(requests.length, 1); record.endRequest = requests[0];
    } else {
      const accept = item.type === "alert" || item.answer !== null && item.answer !== false;
      record.reply = await uiAction(accept ? "#dialog-accept" : "#dialog-cancel", "humanDialogRespond");
      const requests = report.viewerCommands.slice(commandStart).filter(row => row.operation === "humanDialogRespond"); assert.equal(requests.length, 1);
      record.request = requests[0];
      assert.deepEqual({ leaseId: record.request.leaseId, generation: record.request.generation, dialogId: record.request.dialogId }, { ...originalScope, dialogId: record.pendingDialog.dialogId }); assert.equal(record.request.accept, accept);
      if (item.type === "prompt" && accept) { assert.equal(record.request.promptBytes, Buffer.byteLength(item.answer)); assert.equal(record.request.promptSHA256, hash(item.answer)); }
      else { assert.equal(record.request.promptBytes, undefined); assert.equal(record.request.promptSHA256, undefined); }
      assert.deepEqual(record.reply.dialogReceipt, { ...originalScope, dialogId: record.pendingDialog.dialogId, acknowledged: true });
    }
    record.closed = await wait(() => nativeFor(business).slice(eventStart).find(row => row.method === "Page.javascriptDialogClosed"), "original native dialog closed");
    record.nativePair = assertManagedDialogNativePair(record, business, record.request ?? record.endRequest);
    assert.equal(record.closed.params.result, !endInstead && (item.type === "alert" || item.answer !== null && item.answer !== false));
    assert.equal(record.closed.params.userInput, item.type === "prompt" && item.answer !== null ? item.answer : "");
    await bound(gesture, 5000, "single original viewer gesture completion"); assert.equal(record.gestureError, undefined);
    await wait(() => !state?.pendingDialog, "published pending dialog cleared after real close");
    const inputs = report.viewerCommands.slice(commandStart).filter(row => row.operation === "humanInput");
    assert.equal(inputs.filter(row => row.input.type === "pointer" && row.input.action === "down").length, 1);
    assert.equal(inputs.filter(row => row.input.type === "pointer" && row.input.action === "up").length, 1);
    record.inputs = [];
    for (const request of inputs) {
      const response = await wait(() => report.viewerMessages.find(row => row.type === "response" && row.id === request.id), "original input outcome after dialog closes");
      record.inputs.push({ request, response }); if (!endInstead) assertHumanInputReceipt(request, response);
      else if (!response.error) assertHumanInputReceipt(request, response);
    }
    const after = await readDocument(); assert.equal(after.documentId, business.before.documentId); assert.equal(after.state.documentToken, business.before.state.documentToken);
    assert.equal(after.state.error, null); assert.equal(after.state.activeCase, null);
    const index = currentFixture.cases.findIndex(value => value.id === item.id);
    assert.deepEqual(after.state.results, currentFixture.cases.slice(0, index + 1).map(value => ({ caseId: value.id, type: value.type, answer: value.answer })));
    assert.deepEqual(after.state.clicks, currentFixture.cases.slice(0, index + 1).map((value, i) => ({ sequence: i + 1, caseId: value.id, trusted: true, button: 0, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false })));
    record.after = after; record.endedAt = Date.now(); record.passed = true; report.nativeEvents = observedEvents(); await save();
    console.log("DIALOG", JSON.stringify({ caseId: item.id, type: item.type, endInstead, passed: true }));
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
      assert.equal(report.source.executable, build.exeSHA256); assert.deepEqual(report.source.extension, build.extensionFiles);
      assert.equal(report.source.browser, "566971689aecea06a88355ea1e9020c908b7a3b093dd0d2a12ae7073489a77aa");
      report.buildEvidence = { file: "build-manifest.json", path: buildFile, sha256: hash(buildBytes) };
      await fs.writeFile(path.join(runDir, "build-manifest.json"), buildBytes, { flag: "wx" });
      const files = await sourceFiles();
      for (const file of files) {
        inside(repo, path.resolve(repo, file)); const bytes = await fs.readFile(path.join(repo, file)); report.source.snapshot[file] = hash(bytes);
        const destination = path.join(runDir, "source-snapshot", file); await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.writeFile(destination, bytes, { flag: "wx" });
      }
      for (const [file, expected] of Object.entries(build.sourceInputs)) assert.equal(report.source.snapshot[file], expected, `Build source must match actual acceptance input: ${file}`);
      const runtime = file => /^(cmd\/|internal\/|apps\/chrome-extension\/)/.test(file) && !/\.test\.|_test\.go$/.test(file);
      assert.deepEqual(files.filter(runtime).sort(), Object.keys(build.sourceInputs).filter(runtime).sort(), "Build must cover the current complete production runtime set");
      await fs.cp(path.join(repo, "packages/open-browser-use-js/dist"), path.join(runDir, "sdk-input"), { recursive: true });
      await fs.cp(extension, path.join(runDir, "extension-input"), { recursive: true });
      await listenFixture(server); report.fixtureURL = `http://127.0.0.1:${server.address().port}`;
    });
    await step(scenario ? "formal-managed-start-and-original-delivered-draft" : "formal-managed-start-and-two-delivered-original-pages", async () => {
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
      report.nativeObserver = scenario ? await scenario.installObservation({ worker, originals })
        : await worker.evaluate(`(${installDialogObservation.toString()})(chrome,globalThis,${JSON.stringify(originals)})`);
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
    if (scenario) await step(scenario.instrumented ? "original-viewer-beforeunload-diagnostic" : "original-beforeunload-stay-leave-and-agent-submit", () => scenario.run({
      report, fixture: fixtures[0], worker, taskBrowser, page, business: report.documents[0], state: () => state,
      readDocument, measureButton, decodedHuman, nativeEvents: observedEvents, wait, uiAction, uiObservation, screenshot, save,
    }));
    else {
    await step("five-original-dialog-answers-through-viewer", async () => {
      for (const item of fixture.cases) await dialogCase(item, report.documents[0], fixture, false);
      const after = await wait(async () => { const value = await readDocument(); return value.state.phase === "committed" && value; }, "first original receipt");
      assert.equal(after.documentId, report.documents[0].before.documentId); report.documents[0].after = after; report.documents[0].receipt = fixture.verify(after);
      await uiObservation("five-dialogs-original-receipt"); await screenshot("five-dialogs-original-receipt");
      report.documents[0].humanEnd = await uiAction("#human-end", "humanEnd"); assertManagedDialogEnded(report.documents[0].humanEnd, report.documents[0].humanBegin.human.leaseId);
    });
    await step("unanswered-original-prompt-cancelled-by-end", async () => {
      tab = { id: report.documents[1].tabId }; await beginHuman(report.documents[1]);
      await dialogCase(endFixture.cases[0], report.documents[1], endFixture, true);
      const after = await wait(async () => { const value = await readDocument(); return value.state.phase === "committed" && value; }, "End cancellation original receipt");
      assert.equal(after.documentId, report.documents[1].before.documentId); report.documents[1].after = after; report.documents[1].receipt = endFixture.verify(after);
      await uiObservation("end-cancel-original-receipt"); await screenshot("end-cancel-original-receipt");
      report.nativeEvents = observedEvents();
      assert.equal(report.nativeEvents.filter(row => row.method === "Page.javascriptDialogOpening").length, 6);
      assert.equal(report.nativeEvents.filter(row => row.method === "Page.javascriptDialogClosed").length, 6);
      assert.equal(report.viewerCommands.filter(row => row.operation === "humanDialogRespond").length, 5);
      assert.equal(report.viewerCommands.filter(row => row.operation === "humanEnd").length, 2);
      assert.deepEqual(state.tabs.map(row => row.id).sort(), report.documents.map(row => row.tabId).sort());
      for (const business of report.documents) assert.equal(state.tabs.find(row => row.id === business.tabId).deliveryId, business.delivery.deliveryId);
      assert.equal(new Set(report.dialogs.map(row => row.pendingDialog.dialogId)).size, 6);
      report.observerBeforeStop = await worker.evaluate("__managedDialogDiagnostic.snapshot()", 3000);
      assert.equal(report.observerBeforeStop.overflow, false); assert.equal(report.observerBeforeStop.active, true);
      assert.ok(!report.workerConnection.eventsDropped);
      assert.ok(report.viewerMessages.filter(row => row.type === "response" && row.error).every(row => {
        const request = report.viewerCommands.find(value => value.id === row.id); return request?.operation === "humanInput" && report.dialogs[5].inputs.some(value => value.request.id === row.id) && row.error.code === "OPERATION_UNCONFIRMED";
      }), "Only an explicitly ended input may lack native acknowledgement");
      assert.deepEqual(report.unexpectedRequests, []);
    });
    }
    await step("formal-stop-of-original-managed-session", stopOriginal);
  } catch (error) { report.error = error.stack ?? String(error); console.error(redact(report.error)); }
  finally {
    if (taskBrowser) await cleanup("sdk", async () => { await bound(taskBrowser.close(), 5000, "original SDK close"); return { closed: true }; });
    if (launcher && !report.supervisorExit) await cleanup("stop", stopOriginal);
    if (launcher && !launcher.record.closedAt) await cleanup("supervisorFallback", async () => { launcher.terminate("managed-dialog-original-supervisor-fallback"); await bound(launcher.completed.catch(() => {}), 12000, "original supervisor fallback close"); throw Error("Original supervisor required forced fallback"); });
    if (launcher && !finalSaved) await cleanup("finalLifecycle", () => lifecycle("final"));
    if (worker) await cleanup("workerObserver", async () => {
      report.nativeEvents = observedEvents(); report.workerEventOverflow = report.workerConnection.eventsDropped;
      if (worker.state() === "open") report.observerFinal = await worker.evaluate(`${observerExpression}.stop()`, 3000);
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
      for (const [file, expected] of Object.entries(report.source.snapshot)) { assert.equal(hash(await fs.readFile(path.join(repo, file))), expected); assert.equal(hash(await fs.readFile(path.join(runDir, "source-snapshot", file))), expected); }
      return { unchanged: true };
    });
    report.fixtures = fixtures.map(item => item.stats()); report.liveRunnerChildren = [...registry].map(child => child.pid); report.endedAt = Date.now();
    const completed = !report.error && report.steps.length === (scenario ? 5 : 6) && report.steps.every(row => row.passed) && !report.cleanupErrors.length && !registry.size &&
      (scenario?.instrumented !== false || report.beforeunload?.businessCompleted === true);
    const exactPassiveEvents = scenario?.instrumented !== false || JSON.stringify(report.nativeEvents.map(({ receivedAt: _receivedAt, ...event }) => event)) === JSON.stringify(report.diagnosticBeforeStop?.records);
    Object.assign(report, managedDialogScenarioOutcome(scenario, completed, scenario?.isTraceComplete(report.diagnosticBeforeStop) && !report.workerEventOverflow && exactPassiveEvents));
    await save(); console.log("RESULT", JSON.stringify({ runDir, featurePassed: report.featurePassed, dialogs: report.dialogs.length }));
  }
  return report;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  assert.equal(process.argv.length, 2, "No retry or alternate business mode");
  const report = await runManagedHumanDialogCheck(); process.exitCode = report.featurePassed ? 0 : 1;
}
