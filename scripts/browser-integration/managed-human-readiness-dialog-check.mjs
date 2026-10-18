// Independent production-viewer readiness acceptance. Historical runners and evidence remain unchanged.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium as playwrightChromium } from "playwright";
import { createManagedReadinessDialogFixture, readManagedReadinessDialogDocument, measureManagedReadinessDialogLink, managedReadinessDialogCases, managedReadinessDialogUnicode } from "./managed-human-readiness-dialog-fixture.mjs";
import { assertHumanInputReceipt, visibleHumanViewerPoint } from "./managed-human-check.mjs";
import { projectHumanDialogCommand, assertManagedDialogEnded } from "./managed-human-dialog-check.mjs";
import { parseManagedReadyOutput, assertManagedStopReply } from "./managed-download-check.mjs";
import { projectManagedViewerLifecycle, assertManagedViewerTerminal, assertManagedViewerBrowserCommand } from "./managed-viewer-check.mjs";
import { connectNormalCDP, managedProcess, runProcess, bound, poll } from "./normal-browser-downloads-support.mjs";
import { listenFixture } from "./fixture-listener.mjs";
import { browserStartupOptions } from "./browser-startup.mjs";
import { waitPrivateDevToolsEndpoint } from "./private-devtools-endpoint.mjs";
import { observedProcessDescendants as descendants } from "./observed-process-descendants.mjs";
import { managedHumanSourceFiles } from "./managed-human-source-snapshot.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const redact = value => String(value).replace(/(#ticket=)[A-Za-z0-9_-]+/g, "$1[redacted]");
const serialize = value => JSON.stringify(value, (_key, item) => typeof item === "string" ? redact(item) : item, 2);
const inside = (root, file) => { const relative = path.relative(root, file); assert.ok(relative && !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`)); return relative.replaceAll("\\", "/"); };
async function treeHashes(root) {
  const entries = await fs.readdir(root, { recursive: true, withFileTypes: true }); assert.ok(entries.every(entry => !entry.isSymbolicLink()));
  return Object.fromEntries(await Promise.all(entries.filter(entry => entry.isFile()).map(async entry => { const file = path.join(entry.parentPath, entry.name); return [inside(root, file), hash(await fs.readFile(file))]; })));
}

// Reuse stable fixture/geometry/lifecycle assertions without editing historical inputs.
import { assertManagedFrameDialogSourceBinding } from "./managed-human-frame-dialog-check.mjs";
import { assertManagedDialogSource, assertManagedDialogSourceUI, projectManagedOopifEvent, managedOopifWebNavigationEvents, managedOopifCleanupObservation } from "./managed-human-oopif-dialog-evidence.mjs";

export function managedReadinessSource(source, business) {
  if (!source || source.targetId !== business.target.id && source.tabId !== business.tabId) return false;
  assert.equal(source.sessionId, undefined); assert.equal(source.extensionId, undefined);
  if (source.targetId !== undefined) assert.equal(source.targetId, business.target.id);
  if (source.tabId !== undefined) assert.equal(source.tabId, business.tabId);
  return true;
}

// A successful Begin may initially return generation zero. A later current
// state can release the gate, but an old state or a prior view frame cannot.
export function managedReadinessGateCandidate({ beginRequest, beginResponse, state, frames, tabId }) {
  if (!beginRequest || !beginResponse) return null;
  assert.equal(beginRequest.operation, "humanBegin"); assert.equal(beginRequest.tabId, tabId);
  assert.equal(beginResponse.type, "response"); assert.equal(beginResponse.id, beginRequest.id); assert.equal(beginResponse.error, undefined);
  const original = beginResponse.result?.human;
  assert.ok(original && typeof original.leaseId === "string" && original.leaseId && original.tabId === tabId);
  if (!state || state.eventSequence < beginResponse.result.eventSequence || state.status.revision < beginResponse.result.status.revision) return null;
  assert.equal(state.status.state, "paused"); assert.equal(state.human?.leaseId, original.leaseId); assert.equal(state.human.tabId, tabId);
  assert.ok(state.human.generation >= original.generation, "Begin generation cannot roll back in a later state");
  assert.ok(!state.pendingDialog, "unexpected dialog before original gate");
  assert.equal(frames.filter(frame => frame.controlMode === "human" && frame.humanLeaseId === original.leaseId).length, 0, "missed first-frame boundary; no replay permitted");
  assert.equal(state.human.viewport, null, "missed preparing null-viewport boundary");
  assert.ok(["starting", "preparing"].includes(state.human.state), "original preparing window ended before gate");
  if (state.human.state !== "preparing" || state.human.generation === 0) return null;
  assert.ok(Number.isSafeInteger(state.human.generation) && state.human.generation > 0);
  return { beginRequestId: beginRequest.id, beginResponseAt: beginResponse.at, stateEventSequence: state.eventSequence, scope: { leaseId: original.leaseId, generation: state.human.generation } };
}

export function assertManagedReadinessAdmission(business) {
  const { selection, admission, observerBoundary, tabId, delivery } = business;
  assert.ok(selection && admission && observerBoundary);
  assert.ok(typeof delivery?.deliveryId === "string" && delivery.deliveryId);
  assert.ok(Number.isSafeInteger(observerBoundary.sequence) && observerBoundary.sequence >= 0);
  for (const [entry, operation] of [[selection, "select"], [admission, "humanBegin"]]) {
    assert.equal(entry.request.operation, operation); assert.equal(entry.request.tabId, tabId);
    assert.equal(entry.request.deliveryId, delivery.deliveryId);
    assert.equal(entry.response.type, "response"); assert.equal(entry.response.id, entry.request.id); assert.equal(entry.response.error, undefined);
    assert.equal(entry.response.result.selectedTabId, tabId);
    assert.ok(entry.request.at <= entry.response.at);
  }
  const selected = selection.response.result, admitted = admission.response.result;
  assert.ok(typeof selected.workerBootId === "string" && selected.workerBootId);
  assert.ok(selected.view?.leaseId); assert.equal(selected.view.tabId, tabId); assert.equal(selected.view.state, "active");
  assert.ok(selection.response.at <= observerBoundary.at && observerBoundary.at <= admission.request.at);
  assert.ok(selection.request.id < admission.request.id);
  assert.equal(admitted.view, null); assert.equal(admitted.viewerCleanupComplete, true);
  assert.equal(admitted.status.state, "paused"); assert.equal(admitted.status.cleanupComplete, true);
  assert.equal(admitted.human.tabId, tabId); assert.ok(admitted.human.leaseId);
  assert.notEqual(admitted.human.leaseId, selected.view.leaseId);
  assert.equal(admitted.workerBootId, selected.workerBootId);
  assert.ok(admitted.retiredSequence >= selected.eventSequence && admitted.eventSequence >= admitted.retiredSequence);
  return { viewLeaseId: selected.view.leaseId, leaseId: admitted.human.leaseId, beginRequestId: admission.request.id,
    beginEventSequence: admitted.eventSequence, retiredSequence: admitted.retiredSequence, observationBoundary: observerBoundary.sequence,
    evidence: "Original select and Begin replies confirm view retirement; this is not an independently captured detach ACK." };
}

export function managedReadinessPendingObservation(messages, current, { business, scenario, generation }) {
  const admission = assertManagedReadinessAdmission(business), begin = business.admission.response.result;
  const beginIndex = messages.findIndex(message => message.type === "response" && message.id === business.admission.request.id);
  assert.ok(beginIndex >= 0); assert.deepEqual(messages[beginIndex], business.admission.response);
  const index = messages.findIndex((message, index) => {
    if (index < beginIndex) return false;
    const value = message.type === "state" ? message : message.type === "response" ? message.result : null;
    return value?.eventSequence >= admission.beginEventSequence && value.pendingDialog?.leaseId === admission.leaseId;
  });
  if (index < 0) return null;
  const message = messages[index], first = message.type === "state" ? message : message.result;
  assert.equal(first.workerBootId, begin.workerBootId); assert.equal(first.status.state, "paused");
  assert.equal(first.human?.tabId, business.tabId); assert.equal(first.human.leaseId, admission.leaseId);
  assert.equal(first.pendingDialog.generation, first.human.generation);
  assert.ok(Number.isSafeInteger(first.human.generation) && first.human.generation > 0);
  if (scenario === "before-first-frame") assert.equal(first.human.generation, generation);
  else { assert.equal(scenario, "navigation"); assert.ok(first.human.generation > generation); }
  assert.equal(first.human.viewport, null, "first pending publication must prove the preparing boundary");
  assert.ok(["preparing", "navigating"].includes(first.human.state));
  assert.equal(messages.slice(0, index).filter(row => row.type === "frame" && row.humanLeaseId === admission.leaseId && row.generation === first.human.generation).length, 0);
  assertManagedReadinessCurrentDialog(current, first);
  return { messageIndex: index, messageAt: message.at, eventSequence: first.eventSequence,
    firstPublicationPhase: first.human.state, pendingState: structuredClone(first) };
}

export function assertManagedReadinessCurrentDialog(current, first) {
  assert.ok(current && current.human && current.pendingDialog, "original early dialog is no longer available");
  assert.equal(current.workerBootId, first.workerBootId); assert.equal(current.status.state, "paused");
  assert.ok(current.eventSequence >= first.eventSequence && current.status.revision >= first.status.revision);
  for (const key of ["leaseId", "tabId", "generation"]) assert.equal(current.human[key], first.human[key]);
  assert.deepEqual(current.pendingDialog, first.pendingDialog);
  assert.ok(["preparing", "navigating", "active"].includes(current.human.state));
  if (current.human.state === "active") assert.ok(current.human.viewport?.width > 0 && current.human.viewport?.height > 0);
  else assert.equal(current.human.viewport, null);
}

export function assertManagedReadinessNativeBoundary(events, { scenario, business, opening, sourceURL, emitterURL }) {
  assert.ok(managedReadinessDialogCases.includes(scenario));
  let previous = business.observerBoundary.sequence;
  for (const event of events) { assert.ok(Number.isSafeInteger(event.sequence) && event.sequence > previous); previous = event.sequence; assert.ok(managedReadinessSource(event.source, business)); }
  assert.ok(events.some(event => event.sequence === opening.sequence && event.method === "Page.javascriptDialogOpening"));
  assert.equal(opening.params.frameId, business.target.id); assert.equal(opening.params.url, emitterURL);
  let boundary;
  if (scenario === "before-first-frame") {
    assertManagedReadinessAdmission(business);
    // Self-initiated native detach need not produce onDetach. Keep the actual
    // typed retirement reply and the pre-Begin passive observation boundary.
    boundary = business.observerBoundary;
    const defaults = events.filter(event => event.sequence > boundary.sequence && event.sequence < opening.sequence && event.method === "Runtime.executionContextCreated" && event.params.context?.auxData?.isDefault === true && event.params.context.auxData.frameId === business.target.id);
    assert.ok(defaults.length, "current human root context metadata required after view retirement");
    assert.ok(defaults.at(-1).params.context.uniqueId); assert.equal(defaults.at(-1).params.context.origin, new URL(sourceURL).origin);
  } else {
    boundary = events.findLast(event => event.sequence < opening.sequence && event.method === "Page.frameNavigated" && event.params.frame?.id === business.target.id);
    assert.ok(boundary, "original root navigation event required"); assert.equal(boundary.params.frame.url, emitterURL);
    assert.ok(typeof boundary.params.frame.loaderId === "string" && boundary.params.frame.loaderId.length);
    assert.notEqual(sourceURL, emitterURL);
  }
  const frames = events.filter(event => event.sequence > boundary.sequence && event.method === "Page.screencastFrame");
  assert.ok(frames.every(event => event.sequence > opening.sequence), "original modal must precede this document's first native screencast frame");
  return { scenario, boundarySequence: boundary.sequence, openingSequence: opening.sequence, firstNativeFrameSequence: frames[0]?.sequence ?? null, originalRootTargetId: business.target.id };
}

export function assertManagedReadinessInputOutcome(request, response, originalScope) {
  assert.equal(request.leaseId, originalScope.leaseId); assert.equal(request.generation, originalScope.generation);
  assert.equal(response.type, "response"); assert.equal(response.id, request.id);
  if (response.error) {
    assert.equal(request.input.type, "pointer"); assert.equal(request.input.action, "up");
    assert.ok(["HUMAN_GENERATION_STALE", "OPERATION_UNCONFIRMED"].includes(response.error.code));
    assert.equal(response.result?.inputReceipt, undefined);
    return { acknowledged: false, originalGeneration: request.generation, code: response.error.code };
  }
  assertHumanInputReceipt(request, response); return { acknowledged: true, originalGeneration: request.generation };
}

export function assertManagedReadinessDialogRequest(request, scope, dialogId) {
  assert.equal(request.operation, "humanDialogRespond");
  // The shared command projector deliberately replaces prompt text with its
  // original UTF-8 byte count and digest. Native Closed and POST remain exact.
  assert.deepEqual({ leaseId: request.leaseId, generation: request.generation, dialogId: request.dialogId, accept: request.accept,
    promptBytes: request.promptBytes, promptSHA256: request.promptSHA256 },
  { ...scope, dialogId, accept: true, promptBytes: Buffer.byteLength(managedReadinessDialogUnicode), promptSHA256: hash(managedReadinessDialogUnicode) });
}

export function projectManagedReadinessTabUpdate(tabId, changeInfo) {
  if (!Number.isSafeInteger(tabId) || tabId < 0 || !changeInfo || typeof changeInfo !== "object") throw Error("Invalid passive tab update metadata");
  const params = {};
  if (Object.hasOwn(changeInfo, "url")) {
    if (typeof changeInfo.url !== "string" || changeInfo.url.length > 8192) throw Error("Passive tab update URL exceeds evidence bounds");
    params.url = changeInfo.url;
  }
  if (Object.hasOwn(changeInfo, "status")) {
    if (!["loading", "complete"].includes(changeInfo.status)) throw Error("Invalid passive tab update status");
    params.status = changeInfo.status;
  }
  return Object.keys(params).length ? { source: { tabId }, method: "tabs.onUpdated", params } : null;
}

export function installReadinessObservation(chrome, target, project, webEvents, projectTabUpdate) {
  if (target.__managedReadinessDialogDiagnostic || typeof target.__obuManagedReadinessDialogEvent !== "function") throw Error("Original OOPIF observer unavailable");
  if (!chrome.tabs?.onUpdated?.addListener || typeof projectTabUpdate !== "function") throw Error("Required passive tab update observer missing");
  let sequence = 0, overflow = false, active = true; const events = [], navigation = [];
  const append = value => {
    if (!active || !value) return;
    if (events.length >= 4096) { overflow = true; return; }
    const item = { sequence: ++sequence, at: Date.now(), ...value }; events.push(item); target.__obuManagedReadinessDialogEvent(JSON.stringify(item));
  };
  const record = (source, method, params) => {
    if (!active) return;
    append(method === "Page.screencastFrame" ? { source: structuredClone(source), method, params: { sessionId: params.sessionId, metadata: structuredClone(params.metadata) } } : project(source, method, params, webEvents));
  };
  const onUpdated = (tabId, changeInfo) => {
    if (!active) return;
    try { append(projectTabUpdate(tabId, changeInfo)); } catch { overflow = true; }
  };
  const onDetach = (source, reason) => record(source, "debugger.onDetach", { reason });
  chrome.debugger.onEvent.addListener(record); chrome.debugger.onDetach.addListener(onDetach);
  chrome.tabs.onUpdated.addListener(onUpdated);
  for (const name of webEvents) {
    if (!chrome.webNavigation[name]?.addListener) throw Error("Required webNavigation observer missing: " + name);
    const listener = details => record({ tabId: details.tabId }, "webNavigation." + name, details);
    chrome.webNavigation[name].addListener(listener); navigation.push({ name, listener });
  }
  const snapshot = () => ({ sequence, events: structuredClone(events), overflow, active });
  Object.defineProperty(target, "__managedReadinessDialogDiagnostic", { value: {
    snapshot, mark() { return { sequence, at: Date.now(), kind: "passive-observer-boundary-before-humanBegin-request" }; },
    stop() {
      if (active) {
        active = false;
        chrome.debugger.onEvent.removeListener(record); chrome.debugger.onDetach.removeListener(onDetach);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        for (const { name, listener } of navigation) chrome.webNavigation[name].removeListener(listener);
      }
      return snapshot();
    }
  } });
  return { installed: true, readOnly: true, webEvents: [...webEvents], tabEvents: ["onUpdated"], scope: "Passive debugger, webNavigation and bounded tabs.onUpdated URL/status metadata only. Never task attach, Runtime.enable, setAutoAttach, native response or authority creation." };
}

export async function runManagedHumanReadinessDialogCheck() {
  assert.equal(process.platform, "win32");
  const mode = "acceptance", scenario = process.env.OBU_TEST_READINESS_DIALOG_CASE; assert.ok(managedReadinessDialogCases.includes(scenario));
  const executable = process.env.OBU_TEST_HOST_BINARY, extension = process.env.OBU_TEST_EXTENSION_DIR;
  const chromium = process.env.OBU_TEST_CHROMIUM_BINARY, buildFile = process.env.OBU_TEST_BUILD_MANIFEST;
  for (const file of [executable, extension, chromium, buildFile]) { assert.ok(typeof file === "string" && path.isAbsolute(file)); await fs.access(file); }
  await fs.mkdir(path.join(repo, ".tmp/browser-integration"), { recursive: true });
  const runDir = await fs.mkdtemp(path.join(repo, ".tmp/browser-integration/mrd-")), root = path.join(runDir, "r"), name = "n", viewerProfile = path.join(runDir, "v");
  const report = { runDir, mode, scenario, startedAt: Date.now(), steps: [], commands: [], probes: [], lifecycleSnapshots: [], processObservations: [], screenshots: [], frames: [],
    observerReads: [], documents: [], dialogs: [], viewerCommands: [], viewerMessages: [], viewerActions: [], uiObservations: [], nativeEvents: [], unexpectedRequests: [], cleanup: {}, cleanupErrors: [], featurePassed: false,
    scope: "One original production viewer scenario, before-first-frame or navigation. Original Begin must succeed before a preparing positive-generation/null-viewport state can release the first-frame fixture gate. Navigation uses one real viewer link click. Only viewer dialog UI answers the same original early dialog, including after its generation becomes active. No task attachment, native dialog response, task Runtime.enable, rendering suspension, OS input, personal profile, URL reopening or business replay.",
    limits: "A gate is only sequencing. Original native Opening must precede this human document's first observed native frame, and the first pending publication must be preparing/navigating with null viewport. Answering may follow the first frame; its observed publication phase is recorded, not claimed to be a native atomic timing fact. A missed opening boundary fails without retry. Native observer data is passive metadata, not production authority; typed view retirement is not an independent detach capture. Raw uint64 lifecycle bytes are authoritative. This is not full Browser Use parity or ordinary Edge/focus validation." };
  const save = () => fs.writeFile(path.join(runDir, "results.json"), serialize(report));
  const registry = new Set(), frameWrites = [];
  const fixtures = [];
  const server = createServer((req, res) => { if (!fixtures.some(item => item.handle(req, res))) { report.unexpectedRequests.push({ method: req.method, url: req.url, at: Date.now() }); req.resume(); res.writeHead(404); res.end(); } });
  let launcher, info, worker, taskBrowser, viewerProcess, viewerBrowser, page, state, tab, captureError, stopPromise, finalSaved = false;
  let latestObserverEvents = [];
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
  const readDocuments = business => worker.evaluate(`chrome.scripting.executeScript({target:{tabId:${tab.id},${business ? 'documentIds:'+JSON.stringify(business.before.map(row=>row.documentId)) : 'allFrames:true'}},func:${readManagedReadinessDialogDocument.toString()}}).then(rows=>rows.map(row=>({documentId:row.documentId,frameId:row.frameId,...row.result})))`, 5000);
  const observedEvents = () => {
    const events = new Map(latestObserverEvents.map(row => [row.sequence, row]));
    for (const raw of (worker?.events ?? []).filter(row => row.method === "Runtime.bindingCalled" && row.params?.name === "__obuManagedReadinessDialogEvent")) {
      const row = JSON.parse(raw.params.payload), previous = events.get(row.sequence);
      if (previous) { const { receivedAt: _ignored, ...original } = previous; assert.deepEqual(row, original); }
      events.set(row.sequence, { ...row, receivedAt: raw.receivedAt });
    }
    const ordered = [...events.values()].sort((a, b) => a.sequence - b.sequence);
    for (let i = 0; i < ordered.length; i++) assert.equal(ordered[i].sequence, i + 1, "passive native event sequence must be complete");
    return ordered;
  };
  async function refreshObserver(label) {
    const value = await worker.evaluate("__managedReadinessDialogDiagnostic.snapshot()", 3000); assert.equal(value.overflow, false);
    latestObserverEvents = value.events; report.observerReads.push({ label, at: Date.now(), sequence: value.sequence, active: value.active, events: value.events.length });
    return value;
  }
  async function screenshot(label) { const file = `viewer-${label}.png`, bytes = await page.screenshot({ path: path.join(runDir, file), timeout: 5000 }); const value = { file, at: Date.now(), bytes: bytes.length, sha256: hash(bytes) }; report.screenshots.push(value); return value; }
  async function uiObservation(label) {
    const value = await bound(page.evaluate(() => {
      const visible = element => { const r = element.getBoundingClientRect(), s = getComputedStyle(element); return !element.hidden && s.display !== "none" && s.visibility !== "hidden" && r.width > 0 && r.height > 0; };
      return { connection: document.querySelector("#connection")?.textContent, state: document.querySelector("#state")?.textContent,
        humanStatus: document.querySelector("#human-status")?.textContent, error: document.querySelector("#error")?.textContent,
        errorVisible: visible(document.querySelector("#error")), humanStatusHidden: document.querySelector("#human-status").hidden,
        dialogVisible: visible(document.querySelector("#page-dialog")), dialogId: document.querySelector("#page-dialog").dataset.dialogId, endDisabled: document.querySelector("#human-end").disabled,
        dialogSource: document.querySelector("#dialog-source")?.textContent,
        dialogSourcePureText: document.querySelectorAll("#dialog-source").length === 1 && document.querySelector("#dialog-source").childElementCount === 0,
        dialogSourceInCard: document.querySelector("#dialog-source")?.parentElement === document.querySelector("#page-dialog"),
        dialogSourceVisible: Boolean(document.querySelector("#dialog-source") && visible(document.querySelector("#dialog-source"))),
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
      socket.on("framesent", event => { try { const value = projectHumanDialogCommand(JSON.parse(String(event.payload))); if (value) { assert.ok(report.viewerCommands.length < 1024); report.viewerCommands.push({ ...value, at: Date.now(), ...(value.operation === "humanDialogRespond" ? { publishedStateAtSend: structuredClone(state) } : {}) }); } } catch (error) { captureError ??= error; } });
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
            maybeReleaseGate();
          } else {
            report.viewerMessages.push({ ...message, at });
            const next = message.type === "state" ? message : message.type === "response" && message.result?.status ? message.result : null;
            if (next && (!state || next.eventSequence >= state.eventSequence && next.status.revision >= state.status.revision)) state = next;
            maybeReleaseGate();
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
      await cleanup("beforeStopProcesses", () => rememberProcesses("before-stop"));
      await cleanup("beforeStopEvidence", async () => { report.beforeStop = { at: Date.now(), nativeEvents: observedEvents(), fixtures: fixtures.map(item => item.stats()) }; await save(); return { saved: true }; });
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
    return managedHumanSourceFiles(mode, launch);
  }
  async function decodedHuman() {
    return wait(async () => {
      const image = await page.locator("#frame").evaluate(element => ({ hidden: element.hidden, complete: element.complete, width: element.naturalWidth, height: element.naturalHeight, ...element.dataset }));
      const frame = report.frames.findLast(row => row.controlMode === "human" && row.tabId === tab.id && row.streamId === image.streamId && row.sequence === Number(image.frameSequence));
      return frame && !image.hidden && image.complete && image.width > 0 && state?.human?.state === "active" && state.human.leaseId === frame.humanLeaseId && state.human.generation === frame.generation && !state.pendingDialog && await page.locator("#human-input").getAttribute("data-enabled") === "true" && { image, frame };
    }, "decoded current original human frame", 20000);
  }
  function maybeReleaseGate() {
    if(scenario!=="before-first-frame"||!report.gateArmed||report.gateRelease)return;
    const beginRequest=report.viewerCommands.find(row=>row.operation==="humanBegin");
    const beginResponse=beginRequest&&report.viewerMessages.find(row=>row.type==="response"&&row.id===beginRequest.id);
    const candidate=managedReadinessGateCandidate({beginRequest,beginResponse,state,frames:report.frames,tabId:tab.id});
    if(candidate){report.gateProof={...candidate,state:structuredClone(state),at:Date.now()};report.gateRelease=fixtures[0].releaseGate();}
  }
  async function beginHuman(business) {
    const delivered=state.tabs.find(value=>value.id===tab.id);assert.equal(delivered?.kind,"result");assert.equal(delivered.takeover,true);assert.ok(delivered.deliveryId);business.delivery=structuredClone(delivered);
    await uiAction("#tabs","select",tab.id);
    const selectRequest=report.viewerCommands.findLast(value=>value.operation==="select");
    business.selection={request:structuredClone(selectRequest),response:structuredClone(report.viewerMessages.find(value=>value.type==="response"&&value.id===selectRequest.id))};
    business.observerBoundary=await worker.evaluate("__managedReadinessDialogDiagnostic.mark()",3000);
    if(scenario==="before-first-frame")await wait(()=>fixtures[0].stats().requests.some(row=>row.url===new URL(fixtures[0].urls.gate).pathname),"original first-frame gate request",5000);
    report.gateArmed=scenario==="before-first-frame";business.humanStartedAt=Date.now();business.humanBegin=await uiAction("#human-begin","humanBegin");
    const request=report.viewerCommands.findLast(value=>value.operation==="humanBegin");assert.equal(request.tabId,tab.id);assert.equal(request.deliveryId,delivered.deliveryId);assert.equal(business.humanBegin.status.state,"paused");
    business.admission={request:structuredClone(request),response:structuredClone(report.viewerMessages.find(value=>value.type==="response"&&value.id===request.id))};
    business.admissionProof=assertManagedReadinessAdmission(business);
    if(scenario==="before-first-frame")await wait(()=>report.gateRelease,"original admitted preparing gate window",10000);
    else business.decodedHuman=await decodedHuman();
  }
  async function readinessCase(business,fixture) {
    const record={scenario,tabId:tab.id,startedAt:Date.now(),originalLeaseId:business.humanBegin.human.leaseId};report.dialogs.push(record);
    const commandStart=report.viewerCommands.length;
    const nativeEvents=()=>observedEvents().filter(row=>row.sequence>business.observerBoundary.sequence&&managedReadinessSource(row.source,business));
    const dialogs=()=>nativeEvents().filter(row=>["Page.javascriptDialogOpening","Page.javascriptDialogClosed"].includes(row.method));
    let gesture;
    if(scenario==="navigation"){
      const original=business.before[0];
      record.measurement=await worker.evaluate(`chrome.scripting.executeScript({target:{tabId:${tab.id},documentIds:[${JSON.stringify(original.documentId)}]},func:${measureManagedReadinessDialogLink.toString()}}).then(rows=>{if(rows.length!==1||rows[0].documentId!==${JSON.stringify(original.documentId)})throw Error('Original source changed');return rows[0].result})`,3000);
      assert.equal(record.measurement.url,fixture.urls.source);assert.equal(record.measurement.href,fixture.urls.destination);
      const decoded=await decodedHuman();record.inputScope={leaseId:state.human.leaseId,generation:state.human.generation};
      record.pointer=visibleHumanViewerPoint(record.measurement.rect,state.human.viewport,await page.locator("#frame").boundingBox(),decoded.image);
      gesture=page.mouse.click(record.pointer.viewerPoint.x,record.pointer.viewerPoint.y).then(()=>{record.gestureCompletedAt=Date.now();},error=>{record.gestureError=error.stack;});
    }
    record.opening=await wait(()=>dialogs().find(row=>row.method==="Page.javascriptDialogOpening"),"original readiness native Opening",12000);
    assert.equal(record.opening.params.url,fixture.urls[fixture.emitterRole]);assert.equal(record.opening.params.frameId,business.target.id);assert.equal(record.opening.params.type,"prompt");assert.equal(record.opening.params.message,fixture.prompt.message);assert.equal(record.opening.params.defaultPrompt,fixture.prompt.defaultPrompt);
    record.pendingPublication=await wait(()=>managedReadinessPendingObservation(report.viewerMessages,state,{business,scenario,generation:scenario==="navigation"?record.inputScope.generation:report.gateProof.scope.generation}),"original preparing/navigating dialog publication",5000);
    record.pendingState=record.pendingPublication.pendingState;record.pendingDialog=structuredClone(record.pendingState.pendingDialog);record.originalScope={leaseId:record.pendingDialog.leaseId,generation:record.pendingDialog.generation};
    assert.equal(record.originalScope.leaseId,record.originalLeaseId);
    if(scenario==="navigation")assert.ok(record.originalScope.generation>record.inputScope.generation);
    else assert.deepEqual(record.originalScope,report.gateProof.scope);
    const sourceOptions={nativeSource:{targetId:business.target.id},rootFrameId:business.target.id};
    const source=assertManagedDialogSource(record,business,nativeEvents(),sourceOptions);
    assert.deepEqual(record.pendingDialog,{...record.originalScope,dialogId:record.pendingDialog.dialogId,type:"prompt",message:fixture.prompt.message,defaultPrompt:fixture.prompt.defaultPrompt,source});
    record.boundary=assertManagedReadinessNativeBoundary(nativeEvents(),{scenario,business,opening:record.opening,sourceURL:fixture.urls.source,emitterURL:fixture.urls[fixture.emitterRole]});
    const pendingUI=await uiObservation("pending-"+scenario);record.pendingUI=pendingUI;assertManagedDialogSourceUI(pendingUI,source);
    assert.equal(pendingUI.input.enabled,"false");assert.equal(pendingUI.dialogId,record.pendingDialog.dialogId);assert.ok(pendingUI.buttons.some(row=>row.id==="dialog-accept"&&row.visible&&!row.disabled));assert.equal(pendingUI.endDisabled,false);
    await page.locator("#dialog-prompt").fill(managedReadinessDialogUnicode,{timeout:1000});await screenshot("pending-filled-"+scenario);
    assert.ok(Date.now()-record.opening.at<5000,"response must start within original five-second case budget");
    assertManagedReadinessCurrentDialog(state,record.pendingState);
    record.reply=await uiAction("#dialog-accept","humanDialogRespond");record.request=report.viewerCommands.slice(commandStart).find(row=>row.operation==="humanDialogRespond");
    assertManagedReadinessCurrentDialog(record.request.publishedStateAtSend,record.pendingState);
    assertManagedReadinessDialogRequest(record.request,record.originalScope,record.pendingDialog.dialogId);
    record.answerObservation={phase:record.request.publishedStateAtSend.human.state,eventSequence:record.request.publishedStateAtSend.eventSequence,at:record.request.at,note:"Latest original published state when the viewer request was observed; not proof that native answering preceded the first frame."};
    assert.deepEqual(record.reply.dialogReceipt,{...record.originalScope,dialogId:record.pendingDialog.dialogId,acknowledged:true});
    assert.ok(record.request.at>=record.opening.at&&record.request.at-record.opening.at<5000);
    record.closed=await wait(()=>dialogs().find(row=>row.method==="Page.javascriptDialogClosed"),"original readiness native Closed",10000);
    assert.deepEqual(record.closed.source,record.opening.source);assert.equal(record.closed.params.frameId,business.target.id);assert.ok(record.closed.sequence>record.opening.sequence);assert.equal(record.closed.params.result,true);assert.equal(record.closed.params.userInput,managedReadinessDialogUnicode);
    if(gesture){await bound(gesture,5000,"original one navigation gesture");assert.equal(record.gestureError,undefined);}
    const inputs=report.viewerCommands.slice(commandStart).filter(row=>row.operation==="humanInput");
    assert.deepEqual(inputs.map(row=>[row.sequence,row.input.type,row.input.action]),scenario==="navigation"?[[1,"pointer","move"],[2,"pointer","down"],[3,"pointer","up"]]:[]);
    record.inputs=[];
    for(const request of inputs){const response=await wait(()=>report.viewerMessages.find(row=>row.type==="response"&&row.id===request.id),"original navigation input outcome",15000);record.inputs.push({request,response});
      // Navigation may retire the original input generation. Preserve its exact
      // outcome, and never relabel a late native ACK as a successor input receipt.
      record.inputs.at(-1).outcome=assertManagedReadinessInputOutcome(request,response,record.inputScope);
    }
    await wait(()=>fixture.stats().receipt,"original unique readiness POST",10000);
    const frames=await worker.evaluate(`chrome.webNavigation.getAllFrames({tabId:${tab.id}})`,3000);const emitter=frames.filter(row=>row.frameId===0&&row.url===fixture.urls[fixture.emitterRole]);assert.equal(emitter.length,1);business.emitterFrame=emitter[0];
    if(scenario==="before-first-frame")assert.equal(emitter[0].documentId,business.before[0].documentId);else assert.notEqual(emitter[0].documentId,business.before[0].documentId);
    business.after=await wait(async()=>{const rows=await worker.evaluate(`chrome.scripting.executeScript({target:{tabId:${tab.id},documentIds:[${JSON.stringify(emitter[0].documentId)}]},func:${readManagedReadinessDialogDocument.toString()}}).then(rows=>rows.map(row=>({documentId:row.documentId,frameId:row.frameId,...row.result})))`,3000);return rows.length===1&&rows[0].state?.phase==="committed"&&rows[0];},"original document published original POST response",5000);
    business.receipt=fixture.verify(business.after);record.resumed=await decodedHuman();assert.equal(record.resumed.frame.humanLeaseId,record.originalLeaseId);assert.equal(record.resumed.frame.generation,record.originalScope.generation);
    await screenshot("answered-"+scenario);business.humanEnd=await uiAction("#human-end","humanEnd");
    const endRequest=report.viewerCommands.findLast(row=>row.operation==="humanEnd"&&row.leaseId===record.originalLeaseId),endResponse=()=>report.viewerMessages.find(row=>row.type==="response"&&row.id===endRequest.id)?.result;
    await wait(()=>managedOopifCleanupObservation({state,response:endResponse(),explicitEnd:true,leaseId:record.originalLeaseId}),"original lease complete End",15000);assertManagedDialogEnded(state,record.originalLeaseId);
    record.cleanupUI=await wait(async()=>{const value=managedOopifCleanupObservation({state,response:endResponse(),explicitEnd:true,leaseId:record.originalLeaseId,requireSource:true,ui:await uiObservation("ended-"+scenario)});return value?.uiCleared&&value;},"original End clears UI",2000);
    await refreshObserver("original-readiness-completed");
    assertManagedDialogSource(record,business,nativeEvents(),{...sourceOptions,through:record.closed.sequence});
    record.boundary=assertManagedReadinessNativeBoundary(nativeEvents(),{scenario,business,opening:record.opening,sourceURL:fixture.urls.source,emitterURL:fixture.urls[fixture.emitterRole]});
    assert.equal(dialogs().filter(row=>row.method==="Page.javascriptDialogOpening").length,1);assert.equal(dialogs().filter(row=>row.method==="Page.javascriptDialogClosed").length,1);
    assert.equal(report.viewerCommands.slice(commandStart).filter(row=>row.operation==="humanDialogRespond").length,1);
    record.outcome="answered";record.endedAt=Date.now();await screenshot("ended-"+scenario);await save();
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
      if (process.env.OBU_TEST_SOURCE_BINDING_REPORT) {
        const file = process.env.OBU_TEST_SOURCE_BINDING_REPORT; assert.ok(path.isAbsolute(file));
        const bytes = await fs.readFile(file), binding = JSON.parse(bytes);
        report.source.independentBinding = { path: file, file: "source-binding.json", sha256: hash(bytes), ...assertManagedFrameDialogSourceBinding(binding, build, report.buildEvidence.sha256) };
        await fs.writeFile(path.join(runDir, "source-binding.json"), bytes, { flag: "wx" });
      }
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
      fixtures.push(createManagedReadinessDialogFixture({baseURL:report.fixtureURL,scenario}));
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
      await worker.call("Runtime.enable"); await worker.call("Runtime.addBinding", { name: "__obuManagedReadinessDialogEvent" });
      report.nativeObserver = await worker.evaluate(`(${installReadinessObservation.toString()})(chrome,globalThis,${projectManagedOopifEvent.toString()},${JSON.stringify(managedOopifWebNavigationEvents)},${projectManagedReadinessTabUpdate.toString()})`);
      const { connectOpenBrowserUse } = await import(pathToFileURL(path.join(runDir, "sdk-input/index.js")));
      taskBrowser = await connectOpenBrowserUse({ socketPath: info.socketPath, sessionId: "managed-human-readiness-dialog", timeoutMs: 10000 });
      for (const current of fixtures) {
        tab = await taskBrowser.newTab({ url: current.urls.source, backgroundWindow: true });
        const snapshot = await tab.domSnapshot();
        const before = await wait(async () => { const rows = await readDocuments(); return rows.length === 1 && rows.every(row=>row.state?.workflowId===current.workflowId) && rows; }, "original fixture document metadata");
        const business = { tabId: tab.id, scenario, workflowId: current.workflowId, snapshot, before };
        const targets = await worker.evaluate(`chrome.debugger.getTargets().then(rows=>rows.filter(row=>row.type==='page'&&row.tabId===${tab.id}).map(row=>({id:row.id,tabId:row.tabId,url:row.url,attached:row.attached})))`);
        assert.equal(targets.length, 1); business.target = targets[0]; report.documents.push(business);
      }
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
    await step("one-original-readiness-dialog-case", async () => {
      await readinessCase(report.documents[0],fixtures[0]);
      report.nativeEvents=observedEvents();report.observerBeforeStop=await worker.evaluate("__managedReadinessDialogDiagnostic.snapshot()",3000);
      assert.equal(report.observerBeforeStop.overflow,false);assert.equal(report.workerConnection.eventsDropped,0);assert.deepEqual(report.unexpectedRequests,[]);
    });
    await step("formal-stop-of-original-managed-session", stopOriginal);
  } catch (error) { report.error = error.stack ?? String(error); console.error(redact(report.error)); }
  finally {
    if (taskBrowser) await cleanup("sdk", async () => { await bound(taskBrowser.close(), 5000, "original SDK close"); return { closed: true }; });
    if (launcher && !report.supervisorExit) await cleanup("stop", stopOriginal);
    if (launcher && !launcher.record.closedAt) await cleanup("supervisorFallback", async () => { launcher.terminate("managed-dialog-original-supervisor-fallback"); await bound(launcher.completed.catch(() => {}), 12000, "original supervisor fallback close"); throw Error("Original supervisor required forced fallback"); });
    if (launcher && !finalSaved) await cleanup("finalLifecycle", () => lifecycle("final"));
    if (worker) await cleanup("workerObserver", async () => {
      try {
        report.nativeEvents = observedEvents(); report.workerEventOverflow = report.workerConnection.eventsDropped;
        if (worker.state() === "open") { report.observerFinal = await worker.evaluate("__managedReadinessDialogDiagnostic.stop()", 3000); assert.equal(report.observerFinal.overflow, false); }
        else report.observerFinal = { originalWorkerEnded: true, state: worker.state(), noEvaluateAfterClose: true };
        assert.equal(report.workerEventOverflow, 0);
      } finally { await worker.close(); }
      return { closed: true };
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
      if (report.source.independentBinding) {
        assert.equal(hash(await fs.readFile(report.source.independentBinding.path)), report.source.independentBinding.sha256);
        assert.equal(hash(await fs.readFile(path.join(runDir, report.source.independentBinding.file))), report.source.independentBinding.sha256);
      }
      for (const [file, expected] of Object.entries(report.source.builtInputs)) { assert.equal(hash(await fs.readFile(path.join(report.source.buildSnapshot, file))), expected); assert.equal(hash(await fs.readFile(path.join(runDir, "built-source-snapshot", file))), expected); }
      for (const [file, expected] of Object.entries(report.source.snapshot)) { assert.equal(hash(await fs.readFile(path.join(repo, file))), expected); assert.equal(hash(await fs.readFile(path.join(runDir, "source-snapshot", file))), expected); }
      return { unchanged: true };
    });
    report.fixtures = fixtures.map(item => item.stats()); report.liveRunnerChildren = [...registry].map(child => child.pid); report.endedAt = Date.now();
    report.completed = !report.error && report.steps.length === 5 && report.steps.every(row => row.passed) && !report.cleanupErrors.length && !registry.size;
    report.featurePassed = mode === "acceptance" && report.completed; report.diagnosticCompleted = mode === "diagnostic" && report.completed;
    await save(); console.log("RESULT", JSON.stringify({ runDir, mode, scenario, completed: report.completed, featurePassed: report.featurePassed, dialogs: report.dialogs.length }));
  }
  return report;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  assert.equal(process.argv.length, 2, "No retry or alternate business mode");
  const report = await runManagedHumanReadinessDialogCheck(); process.exitCode = report.completed ? 0 : 1;
}
