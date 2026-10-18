// Independent OOPIF follow-up. The published frame runner and all original runs remain unchanged.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium as playwrightChromium } from "playwright";
import { managedDialogUnicode } from "./managed-dialog-fixture.mjs";
import { createManagedFrameDialogFixture, readManagedFrameDialogDocument, measureManagedFrameDialogElement, managedFrameDialogLayouts } from "./managed-human-frame-dialog-fixture.mjs";
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

// Reuse stable fixture/geometry/lifecycle assertions without editing historical inputs.
import { proveManagedFrameDialogDocuments, managedFrameDialogRootPoint, assertManagedFrameDialogOpening, assertManagedFrameDialogPair, classifyManagedFrameDialog, assertManagedFrameDialogSourceBinding, managedFrameDialogDocumentsReady } from "./managed-human-frame-dialog-check.mjs";
import { projectManagedOopifEvent, managedOopifWebNavigationEvents, currentManagedRemoteAttachments, proveCurrentManagedRemoteDialog, assertManagedRemoteDialogPair, managedOopifCleanupObservation, assertManagedOopifMode } from "./managed-human-oopif-dialog-evidence.mjs";

function installOopifObservation(chrome, target, project, webEvents) {
  if (target.__managedOopifDialogDiagnostic || typeof target.__obuManagedOopifDialogEvent !== "function") throw Error("Original OOPIF observer unavailable");
  let sequence = 0, overflow = false, active = true; const events = [], navigation = [];
  const record = (source, method, params) => {
    const value = project(source, method, params, webEvents); if (!value) return;
    if (events.length >= 4096) { overflow = true; return; }
    const item = { sequence: ++sequence, at: Date.now(), ...value }; events.push(item); target.__obuManagedOopifDialogEvent(JSON.stringify(item));
  };
  const onDetach = (source, reason) => record(source, "debugger.onDetach", { reason });
  chrome.debugger.onEvent.addListener(record); chrome.debugger.onDetach.addListener(onDetach);
  for (const name of webEvents) {
    if (!chrome.webNavigation[name]?.addListener) throw Error("Required webNavigation observer missing: " + name);
    const listener = details => record({ tabId: details.tabId }, "webNavigation." + name, details);
    chrome.webNavigation[name].addListener(listener); navigation.push({ name, listener });
  }
  const snapshot = () => ({ sequence, events: structuredClone(events), overflow, active });
  Object.defineProperty(target, "__managedOopifDialogDiagnostic", { value: {
    snapshot, mark() { return { sequence, at: Date.now(), kind: "passive-observer-boundary-before-humanBegin-request" }; },
    stop() { chrome.debugger.onEvent.removeListener(record); chrome.debugger.onDetach.removeListener(onDetach); for (const { name, listener } of navigation) chrome.webNavigation[name].removeListener(listener); active = false; return snapshot(); }
  } });
  return { installed: true, readOnly: true, webEvents: [...webEvents], scope: "Passive debugger and webNavigation metadata only. Never task attach, Runtime.enable, setAutoAttach, native response or authority creation." };
}

export async function runManagedHumanOopifDialogCheck() {
  assert.equal(process.platform, "win32");
  const mode = process.env.OBU_TEST_OOPIF_DIALOG_MODE; assert.ok(["diagnostic", "acceptance"].includes(mode));
  const executable = process.env.OBU_TEST_HOST_BINARY, extension = process.env.OBU_TEST_EXTENSION_DIR;
  const chromium = process.env.OBU_TEST_CHROMIUM_BINARY, buildFile = process.env.OBU_TEST_BUILD_MANIFEST;
  for (const file of [executable, extension, chromium, buildFile]) { assert.ok(typeof file === "string" && path.isAbsolute(file)); await fs.access(file); }
  await fs.mkdir(path.join(repo, ".tmp/browser-integration"), { recursive: true });
  const runDir = await fs.mkdtemp(path.join(repo, ".tmp/browser-integration/mod-")), root = path.join(runDir, "r"), name = "n", viewerProfile = path.join(runDir, "v");
  const report = { runDir, mode, startedAt: Date.now(), steps: [], commands: [], probes: [], lifecycleSnapshots: [], processObservations: [], screenshots: [], frames: [],
    observerReads: [], documents: [], dialogs: [], viewerCommands: [], viewerMessages: [], viewerActions: [], uiObservations: [], nativeEvents: [], unexpectedRequests: [], cleanup: {}, cleanupErrors: [], featurePassed: false,
    scope: "Four original delivered root/same/nested/OOPIF pages. One native prompt attempt and one viewer click per page; only the emitter posts its actual result. Acceptance requires all four original answers and a live current production-owned OOPIF attachment/default-context proof; diagnostic records missing native evidence and cancellation without claiming support. Only a pre-modal read-only child Page.getFrameTree on an already observed current production attachment is permitted; no task attach, native response, Runtime.enable on task, setAutoAttach, replay, OS input, personal profile or publication.",
    limits: "Diagnostic completion is not feature success. Missing remote nodes in a root frame tree are not absent OOPIFs. Context origins are raw default Runtime metadata, not inferred from URL or securityOrigin. Original uint64 lifecycle bytes are authoritative. This does not establish full Browser Use parity or ordinary Edge/focus behavior." };
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
  const readDocuments = business => worker.evaluate(`chrome.scripting.executeScript({target:{tabId:${tab.id},${business ? 'documentIds:'+JSON.stringify(business.before.map(row=>row.documentId)) : 'allFrames:true'}},func:${readManagedFrameDialogDocument.toString()}}).then(rows=>rows.map(row=>({documentId:row.documentId,frameId:row.frameId,...row.result})))`, 5000);
  const observedEvents = () => {
    const events = new Map(latestObserverEvents.map(row => [row.sequence, row]));
    for (const raw of (worker?.events ?? []).filter(row => row.method === "Runtime.bindingCalled" && row.params?.name === "__obuManagedOopifDialogEvent")) {
      const row = JSON.parse(raw.params.payload), previous = events.get(row.sequence);
      if (previous) { const { receivedAt: _ignored, ...original } = previous; assert.deepEqual(row, original); }
      events.set(row.sequence, { ...row, receivedAt: raw.receivedAt });
    }
    return [...events.values()].sort((a, b) => a.sequence - b.sequence);
  };
  async function refreshObserver(label) {
    const value = await worker.evaluate("__managedOopifDialogDiagnostic.snapshot()", 3000); assert.equal(value.overflow, false);
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
        dialogVisible: visible(document.querySelector("#page-dialog")), endDisabled: document.querySelector("#human-end").disabled,
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
    await uiAction("#tabs", "select", tab.id);
    business.observerBoundary = await worker.evaluate("__managedOopifDialogDiagnostic.mark()", 3000);
    business.humanStartedAt = Date.now(); business.humanBegin = await uiAction("#human-begin", "humanBegin");
    const request = report.viewerCommands.findLast(value => value.operation === "humanBegin");
    assert.equal(request.tabId, tab.id); assert.equal(request.deliveryId, delivered.deliveryId);
    assert.equal(business.humanBegin.status.state, "paused"); business.decodedHuman = await decodedHuman();
    business.beforeHuman = await readDocuments(business);
    assert.deepEqual(business.beforeHuman.map(row=>[row.documentId,row.state.documentToken]).sort(), business.before.map(row=>[row.documentId,row.state.documentToken]).sort());
  }
  async function frameCase(business, fixture) {
    const commandStart = report.viewerCommands.length, eventStart = observedEvents().length;
    const record = { layout: fixture.layout, tabId: tab.id, startedAt: Date.now(), originalScope: { leaseId: state.human.leaseId, generation: state.human.generation }, gestureCount: 1, pendingSeen: false };
    report.dialogs.push(record);
    business.webFrames = await worker.evaluate(`chrome.webNavigation.getAllFrames({tabId:${tab.id}})`);
    business.nativeTree = await worker.evaluate(`chrome.debugger.sendCommand({targetId:${JSON.stringify(business.target.id)}},'Page.getFrameTree')`);
    business.proof = proveManagedFrameDialogDocuments(fixture, business.webFrames, business.beforeHuman, business.nativeTree, business.target);
    business.contextEventsAtClick = observedEvents().filter(row => row.method.startsWith("Runtime.executionContext") && row.at >= business.humanStartedAt);
    business.defaultContextsAtClick = business.contextEventsAtClick.filter(row => row.method === "Runtime.executionContextCreated" && row.params.context?.auxData?.isDefault === true);
    business.defaultContextObservation = business.defaultContextsAtClick.length ? "metadata-recorded; inspect original lifecycle before treating as current" : "missing; no origin inferred from frame URL";
    business.attachEventsAtClick = observedEvents().filter(row => row.method.startsWith("Target."));
    if (fixture.layout === "oopif") {
      const before = await refreshObserver("before-current-remote-tree");
      business.currentRemoteAttachments = currentManagedRemoteAttachments(before.events, business);
      if (business.currentRemoteAttachments.length === 1) {
        const attachment = business.currentRemoteAttachments[0];
        // This source comes only from the current passive attachment window.
        // Reading its tree cannot attach or revive an old SDK session.
        business.remoteTreeRead = { source: structuredClone(attachment.source), originalDocumentId: business.proof.at(-1).documentId, beforeSequence: before.sequence, startedAt: Date.now(), command: "Page.getFrameTree" };
        try {
          business.remoteTreeRead.result = await worker.evaluate(`chrome.debugger.sendCommand(${JSON.stringify(attachment.source)},'Page.getFrameTree')`, 3000);
          const after = await refreshObserver("after-current-remote-tree");
          business.remoteTreeRead.afterSequence = after.sequence; business.remoteTreeRead.endedAt = Date.now();
          business.remoteWitnessAtClick = proveCurrentManagedRemoteDialog(after.events, business, business.remoteTreeRead, after.sequence);
          record.remoteWitness = structuredClone(business.remoteWitnessAtClick);
          Object.assign(business.proof.at(-1), { nativeFrameId: record.remoteWitness.frameId, loaderId: record.remoteWitness.loaderId, nativeTreeWitness: "current-owned-remote-session-read" });
        } catch (error) { business.remoteProofError = error.message; }
      } else business.remoteProofError = business.currentRemoteAttachments.length ? "Ambiguous current remote attachments; no query or answer" : "No current production-owned remote attachment; old SDK sessions cannot substitute";
    }
    const measurements = [];
    for (const original of business.proof) {
      const id = original.role === fixture.emitterRole ? "prompt" : "child";
      const measured = await worker.evaluate(`chrome.scripting.executeScript({target:{tabId:${tab.id},documentIds:[${JSON.stringify(original.documentId)}]},func:${measureManagedFrameDialogElement.toString()},args:[${JSON.stringify(id)}]}).then(rows=>{if(rows.length!==1||rows[0].documentId!==${JSON.stringify(original.documentId)})throw Error('Original measurement document changed');return rows[0].result})`);
      assert.equal(measured.url, original.url); measurements.push(measured);
    }
    record.measurements = measurements; record.nativePoint = managedFrameDialogRootPoint(measurements);
    const leafRect = measurements.at(-1).rect, rootRect = { ...leafRect, x: record.nativePoint.x - leafRect.width / 2, y: record.nativePoint.y - leafRect.height / 2 };
    const decoded = await decodedHuman(); record.pointer = visibleHumanViewerPoint(rootRect, state.human.viewport, await page.locator("#frame").boundingBox(), decoded.image);
    assert.deepEqual(record.pointer.nativePoint, record.nativePoint);
    const gesture = page.mouse.click(record.pointer.viewerPoint.x, record.pointer.viewerPoint.y).then(() => { record.gestureCompletedAt = Date.now(); }, error => { record.gestureError = error.stack; });
    const dialogs = () => observedEvents().slice(eventStart).filter(row => ["Page.javascriptDialogOpening", "Page.javascriptDialogClosed"].includes(row.method));
    await wait(() => dialogs().some(row => row.method === "Page.javascriptDialogOpening") || fixture.stats().committed, "original native opening or completed actual return", 12000);
    record.opening = dialogs().find(row => row.method === "Page.javascriptDialogOpening");
    if (record.opening) {
      assert.equal(record.opening.params.message, fixture.prompt.message); assert.equal(record.opening.params.defaultPrompt, fixture.prompt.defaultValue);
      try { if (fixture.layout === "oopif") record.remoteWitness = assertManagedRemoteDialogPair(record, business, observedEvents()); else assertManagedFrameDialogOpening(record, business, observedEvents()); record.emitterProved = true; } catch (error) { record.emitterProofError = error.message; }
      try { await wait(() => state?.pendingDialog || dialogs().some(row => row.method === "Page.javascriptDialogClosed"), "published original frame dialog or original cancellation", 2000); } catch (error) { record.publicationTimeout = error.message; }
      if (state?.pendingDialog) {
        record.pendingSeen = true; record.pendingDialog = structuredClone(state.pendingDialog);
        assert.deepEqual(record.pendingDialog, { ...record.originalScope, dialogId: record.pendingDialog.dialogId, type: "prompt", message: fixture.prompt.message, defaultPrompt: fixture.prompt.defaultValue });
        await screenshot('pending-'+fixture.layout);
        if (record.emitterProved) {
          await page.locator("#dialog-prompt").fill(managedDialogUnicode, { timeout: 1000 });
          assert.ok(Date.now() - record.opening.at < 5000, "Do not start an answer outside the original five-second case budget");
          record.reply = await uiAction("#dialog-accept", "humanDialogRespond"); record.request = report.viewerCommands.slice(commandStart).find(row => row.operation === "humanDialogRespond");
          assert.deepEqual(record.reply.dialogReceipt, { ...record.originalScope, dialogId: record.pendingDialog.dialogId, acknowledged: true });
        }
      }
      if (!record.request && !dialogs().some(row => row.method === "Page.javascriptDialogClosed") && state?.human) {
        record.explicitDiagnosticCleanup = { reason: "No proved answer UI; end this original lease without native response or replay", startedAt: Date.now() };
        business.humanEnd = await uiAction("#human-end", "humanEnd"); record.explicitDiagnosticCleanup.endedAt = Date.now();
      }
      record.closed = await wait(() => dialogs().find(row => row.method === "Page.javascriptDialogClosed"), "original native Closed", 15000);
      if (record.emitterProved) record.nativePair = fixture.layout === "oopif" ? assertManagedRemoteDialogPair(record, business, observedEvents()) : assertManagedFrameDialogPair(record, business, observedEvents());
    }
    await bound(gesture, 5000, "single original viewer gesture"); assert.equal(record.gestureError, undefined);
    const inputs = report.viewerCommands.slice(commandStart).filter(row => row.operation === "humanInput");
    assert.deepEqual(inputs.map(row=>[row.sequence,row.input.type,row.input.action]), [[1,"pointer","move"],[2,"pointer","down"],[3,"pointer","up"]]);
    record.inputs = [];
    for (const request of inputs) {
      const response = await wait(() => report.viewerMessages.find(row => row.type === "response" && row.id === request.id), "original input outcome", 15000);
      record.inputs.push({ request, response }); if (record.request || !response.error) assertHumanInputReceipt(request, response);
    }
    await wait(() => fixture.stats().committed, "single original emitter POST", 10000);
    // Flush the passive worker's event stream after the original input settles.
    // A late binding delivery must not turn a real native cancel into "no event".
    record.terminalObserver = await refreshObserver("original-input-settled");
    assert.equal(record.terminalObserver.overflow, false);
    if (!record.opening) {
      record.opening = dialogs().find(row => row.method === "Page.javascriptDialogOpening");
      record.closed = dialogs().find(row => row.method === "Page.javascriptDialogClosed");
      if (record.opening) {
        assert.equal(record.opening.params.message, fixture.prompt.message); assert.equal(record.opening.params.defaultPrompt, fixture.prompt.defaultValue);
        try { record.nativePair = fixture.layout === "oopif" ? assertManagedRemoteDialogPair(record, business, observedEvents()) : assertManagedFrameDialogPair(record, business, observedEvents()); record.emitterProved = true; } catch (error) { record.emitterProofError = error.message; }
      }
    }
    // No task script ran while a native modal was open. Read only original IDs.
    business.after = await wait(async () => managedFrameDialogDocumentsReady(await readDocuments(business), business, fixture), "original emitter processed its single POST response", 5000);
    assert.deepEqual(business.after.map(row=>[row.documentId,row.state.documentToken]).sort(), business.before.map(row=>[row.documentId,row.state.documentToken]).sort());
    business.afterWebFrames = await worker.evaluate(`chrome.webNavigation.getAllFrames({tabId:${tab.id}})`);
    assert.deepEqual(business.afterWebFrames.map(row=>[row.frameId,row.documentId,row.processId]).sort(), business.webFrames.map(row=>[row.frameId,row.documentId,row.processId]).sort());
    business.receipt = fixture.verify(business.after, { answer: fixture.stats().receipt.answer });
    record.outcome = classifyManagedFrameDialog({ ...record, receipt: business.receipt });
    if (record.outcome === "answered") assert.ok(record.nativePair?.answered);
    if (state?.human) business.humanEnd = await uiAction("#human-end", "humanEnd");
    const endRequest = report.viewerCommands.slice(commandStart).findLast(row => row.operation === "humanEnd" && row.leaseId === record.originalScope.leaseId);
    const endResponse = () => endRequest ? report.viewerMessages.find(row => row.type === "response" && row.id === endRequest.id)?.result : undefined;
    await wait(() => managedOopifCleanupObservation({ state, response: endResponse(), explicitEnd: Boolean(endRequest), leaseId: record.originalScope.leaseId }), "current lease state and original End response cleanup", 15000);
    business.humanEnd = structuredClone(state); assertManagedDialogEnded(business.humanEnd, record.originalScope.leaseId);
    const readEndUI = async () => managedOopifCleanupObservation({ state, response: endResponse(), explicitEnd: Boolean(endRequest), leaseId: record.originalScope.leaseId, ui: await uiObservation("ended-" + fixture.layout) });
    try { record.cleanupUI = await wait(async () => { const value = await readEndUI(); record.cleanupUI = value; return value?.uiCleared && value; }, "current completed End clears stale UI without refresh", 2000); }
    catch (error) { record.cleanupUIGap = error.message; if (mode === "acceptance") throw error; }
    assert.equal(dialogs().filter(row => row.method === "Page.javascriptDialogOpening").length, record.opening ? 1 : 0);
    assert.equal(dialogs().filter(row => row.method === "Page.javascriptDialogClosed").length, record.closed ? 1 : 0);
    record.evidenceComplete = true; record.endedAt = Date.now(); report.nativeEvents = observedEvents(); await screenshot('closed-'+fixture.layout); await save();
    console.log("FRAME_DIALOG", JSON.stringify({ layout: fixture.layout, outcome: record.outcome, nativeEmitterProved: Boolean(record.emitterProved) }));
    if (mode === "acceptance") assert.equal(record.outcome, "answered");
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
      fixtures.push(...managedFrameDialogLayouts.map(layout => createManagedFrameDialogFixture({ baseURL: report.fixtureURL, layout })));
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
      await worker.call("Runtime.enable"); await worker.call("Runtime.addBinding", { name: "__obuManagedOopifDialogEvent" });
      report.nativeObserver = await worker.evaluate(`(${installOopifObservation.toString()})(chrome,globalThis,${projectManagedOopifEvent.toString()},${JSON.stringify(managedOopifWebNavigationEvents)})`);
      const { connectOpenBrowserUse } = await import(pathToFileURL(path.join(runDir, "sdk-input/index.js")));
      taskBrowser = await connectOpenBrowserUse({ socketPath: info.socketPath, sessionId: "managed-human-oopif-dialog", timeoutMs: 10000 });
      for (const current of fixtures) {
        tab = await taskBrowser.newTab({ url: current.urls.root, backgroundWindow: true });
        const snapshot = await tab.domSnapshot();
        await wait(() => Object.keys(current.stats().tokens).length === current.roles.length, "original frame documents loaded");
        const before = await wait(async () => { const rows = await readDocuments(); return rows.length === current.roles.length && rows.every(row=>row.state?.workflowId===current.workflowId) && rows; }, "original fixture document metadata");
        const business = { tabId: tab.id, layout: current.layout, workflowId: current.workflowId, snapshot, before };
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
    await step("four-original-frame-dialog-cases", async () => {
      for (let i = 0; i < fixtures.length; i++) {
        tab = { id: report.documents[i].tabId }; if (i) await beginHuman(report.documents[i]);
        await frameCase(report.documents[i], fixtures[i]);
      }
      report.modeResult = assertManagedOopifMode(mode, report.dialogs);
      report.nativeEvents = observedEvents(); report.observerBeforeStop = await worker.evaluate("__managedOopifDialogDiagnostic.snapshot()", 3000);
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
      if (worker.state() === "open") report.observerFinal = await worker.evaluate("__managedOopifDialogDiagnostic.stop()", 3000);
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
    await save(); console.log("RESULT", JSON.stringify({ runDir, mode, completed: report.completed, featurePassed: report.featurePassed, dialogs: report.dialogs.length }));
  }
  return report;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  assert.equal(process.argv.length, 2, "No retry or alternate business mode");
  const report = await runManagedHumanOopifDialogCheck(); process.exitCode = report.completed ? 0 : 1;
}
