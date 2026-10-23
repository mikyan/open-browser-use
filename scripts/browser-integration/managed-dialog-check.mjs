// One old-runtime diagnostic, using only the production viewer to trigger a
// prompt. This deliberately does not answer it or claim dialog feature success.
import { managedWorkerScriptURL } from "./managed-worker-target.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium as playwrightChromium } from "playwright";
import { createManagedDialogFixture, readManagedDialogDocument, measureManagedDialogButton, managedDialogUnicode } from "./managed-dialog-fixture.mjs";
import { projectHumanCommand, visibleHumanViewerPoint } from "./managed-human-check.mjs";
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
function installDialogObservation(chrome, target, tabId, targetId) {
  if (target.__managedDialogDiagnostic || typeof target.__obuManagedDialogEvent !== "function") throw Error("Original dialog observer unavailable");
  let sequence = 0, overflow = false, active = true;
  const events = [], matches = source => source.tabId === tabId || source.targetId === targetId;
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
  return { installed: true, readOnly: true, tabId, targetId };
}

export async function runManagedDialogCheck() {
  assert.equal(process.platform, "win32");
  const bundle = process.env.OBU_TEST_RELEASE_BUNDLE, chromium = process.env.OBU_TEST_CHROMIUM_BINARY;
  const buildFile = process.env.OBU_TEST_RELEASE_BUILD_REPORT, auditFile = process.env.OBU_TEST_RELEASE_AUDIT;
  for (const file of [bundle, chromium, buildFile, auditFile]) { assert.ok(typeof file === "string" && path.isAbsolute(file)); await fs.access(file); }
  const executable = path.join(bundle, "open-browser-use.exe"), extension = path.join(bundle, "extension");
  await fs.mkdir(path.join(repo, ".tmp/browser-integration"), { recursive: true });
  const runDir = await fs.mkdtemp(path.join(repo, ".tmp/browser-integration/md-")), root = path.join(runDir, "r"), name = "n", viewerProfile = path.join(runDir, "v");
  const report = { runDir, startedAt: Date.now(), steps: [], commands: [], probes: [], lifecycleSnapshots: [], processObservations: [], screenshots: [], frames: [],
    viewerCommands: [], viewerMessages: [], viewerActions: [], uiObservations: [], nativeEvents: [], unexpectedRequests: [], cleanup: {}, cleanupErrors: [], featurePassed: false,
    scope: "Diagnostic only: frozen internal 5d candidate, one original prompt opened by one production viewer mouse click. No task-page CDP attach, dialog handling, input replay, OS input, existing profile, package publication or browser claim for unit tests.",
    limits: "No assertion of dialog feature success or complete parity. Native dialog events are observed without intercepting commands. Viewer command observations are outgoing WebSocket requests, not invented native acknowledgements. CIM identities supplement the original retained-handle/Job lifecycle; exact uint64 native FILETIME is retained as text and raw lifecycle bytes." };
  const save = () => fs.writeFile(path.join(runDir, "results.json"), serialize(report));
  const registry = new Set(), frameWrites = [];
  const fixture = createManagedDialogFixture({ cases: [{ id: "prompt", type: "prompt", answer: managedDialogUnicode }] });
  const server = createServer((req, res) => { if (!fixture.handle(req, res)) { report.unexpectedRequests.push({ method: req.method, url: req.url, at: Date.now() }); req.resume(); res.writeHead(404); res.end(); } });
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
      socket.on("framesent", event => { try { const value = projectHumanCommand(JSON.parse(String(event.payload))); if (value) { assert.ok(report.viewerCommands.length < 256); report.viewerCommands.push({ ...value, at: Date.now() }); } } catch (error) { captureError ??= error; } });
      socket.on("close", () => report.viewerMessages.push({ type: "socketClosed", at: Date.now() }));
      socket.on("framereceived", event => {
        try {
          const message = JSON.parse(String(event.payload)), at = Date.now(); assert.ok(report.viewerMessages.length < 2048);
          if (message.type === "frame") {
            assert.equal(message.mimeType, "image/png"); assert.ok(typeof message.data === "string" && message.data.length < 6 * 1024 * 1024);
            const bytes = Buffer.from(message.data, "base64"); assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]); assert.ok(bytes.length > 24 && report.frames.length < 1024);
            const frame = { ...message, data: undefined, at, index: report.frames.length, bytes: bytes.length, sha256: hash(bytes), width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
            if (frame.index < 12 || frame.index % 10 === 0) { frame.file = `native-frame-${String(frame.index).padStart(4, "0")}.png`; const write = fs.writeFile(path.join(runDir, frame.file), bytes, { flag: "wx" }); frameWrites.push(write); write.catch(error => { captureError ??= error; }); }
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
      await rememberProcesses("before-stop"); report.beforeStop = { at: Date.now(), nativeEvents: observedEvents(), fixture: fixture.stats() }; await save();
      const result = await command(["managed", "stop", "--root", root, "--name", name]); report.stopReply = assertManagedStopReply(JSON.parse(result.stdout), info.runId);
      const ended = await bound(launcher.completed, 10000, "original supervisor actual close"); assert.equal(ended.code, 0); assert.equal(ended.termination, undefined);
      report.supervisorExit = { code: ended.code, exitedAt: ended.exitedAt, closedAt: ended.closedAt };
      const value = await lifecycle("final"); assertManagedViewerTerminal(value, info); return { confirmed: true, at: Date.now() };
    })(); return stopPromise;
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
    await step("freeze-internal-candidate-and-diagnostic-sources", async () => {
      const manifestBytes = await fs.readFile(path.join(bundle, "BUILD-MANIFEST.json")), buildBytes = await fs.readFile(buildFile), auditBytes = await fs.readFile(auditFile);
      const manifest = JSON.parse(manifestBytes), build = JSON.parse(buildBytes), audit = JSON.parse(auditBytes);
      assert.equal(manifest.sourceCommit, "5d42f7a89035fd80235f3283eea48d82fb872e18"); assert.equal(manifest.sourceDirty, false); assert.equal(build.passed, true); assert.equal(audit.verified, true);
      assert.equal(build.sourceCommit, manifest.sourceCommit); assert.equal(audit.sourceCommit, manifest.sourceCommit);
      report.source = { commit: manifest.sourceCommit, tag: manifest.version, executable: hash(await fs.readFile(executable)), browser: hash(await fs.readFile(chromium)), extension: await treeHashes(extension), sdk: await treeHashes(path.join(repo, "packages/open-browser-use-js/dist")), diagnostic: {} };
      assert.equal(report.source.executable, build.exeSHA256); assert.equal(report.source.executable, audit.exeSHA256); assert.equal(report.source.executable, manifest.files["open-browser-use.exe"]);
      assert.equal(report.source.browser, "566971689aecea06a88355ea1e9020c908b7a3b093dd0d2a12ae7073489a77aa");
      assert.equal(Object.keys(report.source.extension).length, audit.bundle.extensionFiles);
      for (const [file, sha] of Object.entries(report.source.extension)) assert.equal(manifest.files[`extension/${file}`], sha);
      for (const [file, bytes] of [["candidate-manifest.json", manifestBytes], ["candidate-build.json", buildBytes], ["candidate-audit.json", auditBytes]]) await fs.writeFile(path.join(runDir, file), bytes, { flag: "wx" });
      // The candidate's own manifest/audit binds its old product source. Current
      // in-development product/UI files are deliberately not substituted for it.
      for (const file of ["managed-worker-target.mjs", "managed-worker-target.test.mjs", "managed-dialog-check.mjs", "managed-dialog-fixture.mjs", "managed-dialog-fixture.test.mjs", "managed-human-check.mjs", "managed-human-check-fixture.mjs", "managed-download-check.mjs", "managed-viewer-check.mjs", "normal-browser-downloads-support.mjs", "fixture-listener.mjs", "browser-startup.mjs", "private-devtools-endpoint.mjs", "observed-process-descendants.mjs", "native-browser-installation.mjs"]) {
        const bytes = await fs.readFile(path.join(repo, "scripts/browser-integration", file)), relative = `scripts/browser-integration/${file}`; report.source.diagnostic[relative] = hash(bytes);
        const target = path.join(runDir, "source-snapshot", relative); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, bytes, { flag: "wx" });
      }
      await fs.cp(path.join(repo, "packages/open-browser-use-js/dist"), path.join(runDir, "sdk-input"), { recursive: true });
      await fs.cp(extension, path.join(runDir, "extension-input"), { recursive: true });
      await listenFixture(server); report.fixtureURL = `http://127.0.0.1:${server.address().port}`;
    });
    await step("formal-managed-start-and-original-agent-page", async () => {
      assert.ok(report.source.diagnostic["scripts/browser-integration/managed-worker-target.mjs"], "Managed worker helper must be frozen before acceptance");
      launcher = launch(executable, ["managed", "run", "--root", root, "--name", name, "--browser-path", chromium, "--extension-dir", extension, "--startup-timeout", "30s"]);
      const ready = await wait(() => { assert.ok(!launcher.record.closedAt && !launcher.record.exitedAt); return parseManagedReadyOutput(launcher.record.stdout); }, "managed ready", 40000);
      assert.equal(ready.state, "ready"); info = ready.info; report.info = info; inside(root, info.runDir);
      const life = await lifecycle("ready"); assertManagedViewerBrowserCommand(life, chromium); assert.deepEqual(life.info, info);
      assert.deepEqual(JSON.parse((await command(["managed", "status", "--root", root, "--name", name])).stdout).info, info);
      const privateEndpoint = await endpoint(info.profileDir, launcher), response = await fetch(`http://127.0.0.1:${privateEndpoint.port}/json/list`, { signal: AbortSignal.timeout(10000) });
      const targets = (await response.json()).filter(row => row.type === "service_worker" && row.url === managedWorkerScriptURL(info)); assert.equal(targets.length, 1);
      report.workerTarget = { id: targets[0].id, url: targets[0].url }; report.workerConnection = {};
      worker = await connectNormalCDP(targets[0].webSocketDebuggerUrl, { record: report.workerConnection, handshakeTimeoutMs: 10000, authorizationRequired: false });
      const { connectOpenBrowserUse } = await import(pathToFileURL(path.join(runDir, "sdk-input/index.js")));
      taskBrowser = await connectOpenBrowserUse({ socketPath: info.socketPath, sessionId: "managed-dialog-diagnostic", timeoutMs: 10000 });
      tab = await taskBrowser.newTab({ url: report.fixtureURL + fixture.paths.page, backgroundWindow: true });
      report.business = { tabId: tab.id, snapshot: await tab.domSnapshot(), before: await readDocument() };
      assert.ok(report.business.before.documentId); assert.equal(report.business.before.state.results.length, 0);
      const original = await worker.evaluate(`chrome.debugger.getTargets().then(rows=>rows.filter(row=>row.type==='page'&&row.tabId===${tab.id}).map(row=>({id:row.id,tabId:row.tabId,url:row.url,attached:row.attached})))`); assert.equal(original.length, 1); report.business.target = original[0];
      await worker.call("Runtime.enable"); await worker.call("Runtime.addBinding", { name: "__obuManagedDialogEvent" });
      report.nativeObserver = await worker.evaluate(`(${installDialogObservation.toString()})(chrome,globalThis,${tab.id},${JSON.stringify(original[0].id)})`);
      await rememberProcesses("managed-ready");
    });
    await step("formal-view-and-human-takeover", async () => {
      const startup = browserStartupOptions([`--user-data-dir=${viewerProfile}`, "--headless=new", "--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "about:blank"], process.env.OBU_TEST_FIELD_TRIAL_CONFIG);
      report.viewerStartup = startup; viewerProcess = launch(chromium, startup.args);
      viewerBrowser = await playwrightChromium.connectOverCDP((await endpoint(viewerProfile, viewerProcess)).url);
      const context = await viewerBrowser.newContext({ viewport: { width: 1280, height: 1000 } }); page = await context.newPage();
      const view = JSON.parse((await command(["managed", "view", "--root", root, "--name", name])).stdout), url = new URL(view.viewerURL); assert.equal(url.hostname, "127.0.0.1"); report.viewerOrigin = url.origin; report.viewerTicketSHA256 = hash(url.hash);
      await openViewer(url.href); await uiAction("#refresh", "status"); await uiAction("#tabs", "select", tab.id); report.humanBegin = await uiAction("#human-begin", "humanBegin");
      assert.equal(report.humanBegin.status.state, "paused");
      report.decodedHuman = await wait(async () => {
        const image = await page.locator("#frame").evaluate(element => ({ hidden: element.hidden, complete: element.complete, width: element.naturalWidth, height: element.naturalHeight, ...element.dataset }));
        const frame = report.frames.findLast(row => row.controlMode === "human" && row.tabId === tab.id && row.streamId === image.streamId && row.sequence === Number(image.frameSequence));
        return frame && !image.hidden && image.complete && image.width > 0 && state?.human?.state === "active" && state.human.leaseId === frame.humanLeaseId && state.human.generation === frame.generation && await page.locator("#human-input").getAttribute("data-enabled") === "true" && { image, frame };
      }, "decoded original human frame", 20000);
      report.business.beforeClick = await readDocument(); assert.equal(report.business.beforeClick.documentId, report.business.before.documentId);
      report.measurement = await worker.evaluate(`chrome.scripting.executeScript({target:{tabId:${tab.id}},func:${measureManagedDialogButton.toString()},args:['prompt']}).then(rows=>rows[0].result)`, 5000); assert.equal(report.measurement.clickable, true);
      const imageBox = await page.locator("#frame").boundingBox();
      report.pointer = visibleHumanViewerPoint(report.measurement.rect, state.human.viewport, imageBox, report.decodedHuman.image);
      await uiObservation("before-prompt"); await screenshot("before-prompt"); await rememberProcesses("both-private-browsers");
    });
    await step("one-viewer-click-and-independent-modal-observation", async () => {
      const start = report.viewerCommands.length; report.trigger = { startedAt: Date.now(), point: report.pointer.viewerPoint, gestureCount: 1, waitsForInputAckBeforeObservation: false };
      const gesture = page.mouse.click(report.pointer.viewerPoint.x, report.pointer.viewerPoint.y).then(() => { report.trigger.viewerGestureCompletedAt = Date.now(); }, error => { report.trigger.viewerGestureError = error.stack; });
      const opening = await wait(() => observedEvents().find(row => row.method === "Page.javascriptDialogOpening"), "original native prompt opening", 15000);
      report.opening = opening; assert.equal(opening.params.type, "prompt"); assert.equal(opening.params.message, fixture.cases[0].message); assert.equal(opening.params.defaultPrompt, fixture.cases[0].defaultValue);
      report.atOpening = { at: Date.now(), commands: report.viewerCommands.slice(start), inputResponses: report.viewerMessages.filter(row => row.type === "response" && report.viewerCommands.slice(start).some(command => command.id === row.id)) };
      console.log("DIALOG_OPENING", JSON.stringify({ runDir, type: opening.params.type, params: opening.params, outgoingInputs: report.atOpening.commands.length, inputResponses: report.atOpening.inputResponses.length }));
      await save(); await uiObservation("native-prompt-opened"); await screenshot("native-prompt-opened");
      try { report.statusWhileModal = { result: await uiAction("#refresh", "status", undefined, 5000) }; } catch (error) { report.statusWhileModal = { error: error.stack }; }
      const until = Date.now() + 12000;
      while (Date.now() < until) { await new Promise(resolve => setTimeout(resolve, 500)); report.nativeEvents = observedEvents(); }
      await bound(gesture, 5000, "original viewer gesture settles");
      const ui = await uiObservation("after-observation-window"); await screenshot("after-observation-window");
      const inputs = report.viewerCommands.slice(start).filter(row => row.operation === "humanInput");
      assert.equal(inputs.filter(row => row.input.type === "pointer" && row.input.action === "down").length, 1);
      assert.equal(inputs.filter(row => row.input.type === "pointer" && row.input.action === "up").length, 1);
      report.inputOutcomes = inputs.map(request => ({ request, response: report.viewerMessages.find(row => row.type === "response" && row.id === request.id) ?? null }));
      report.nativeEvents = observedEvents(); report.fixtureBeforeStop = fixture.stats();
      report.diagnosticGapConfirmed = report.nativeEvents.filter(row => row.method === "Page.javascriptDialogOpening").length === 1 &&
        !report.viewerMessages.some(row => row.pendingDialog || row.result?.pendingDialog) && !ui.dialogUI.some(row => row.visible) &&
        !report.viewerCommands.some(row => row.operation === "humanDialogRespond");
      report.gap = { noPublishedPendingDialog: !report.viewerMessages.some(row => row.pendingDialog || row.result?.pendingDialog), noVisibleDialogUI: !ui.dialogUI.some(row => row.visible),
        nativeClosedBeforeStop: report.nativeEvents.filter(row => row.method === "Page.javascriptDialogClosed"), inputPending: ui.input.pending ?? null,
        interpretation: "The original prompt opened, but this frozen viewer exposed no pending dialog or visible decision controls during the recorded observation window. No answer, input retry or task-page script was issued while the modal was open." };
      assert.equal(report.diagnosticGapConfirmed, true, "The expected old-runtime gap was not confirmed; preserve this different observation");
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
      for (const [file, expected] of Object.entries(report.source.diagnostic)) { assert.equal(hash(await fs.readFile(path.join(repo, file))), expected); assert.equal(hash(await fs.readFile(path.join(runDir, "source-snapshot", file))), expected); }
      return { unchanged: true };
    });
    report.fixture = fixture.stats(); report.liveRunnerChildren = [...registry].map(child => child.pid); report.endedAt = Date.now();
    report.diagnosticCompleted = !report.error && report.steps.length === 5 && report.steps.every(row => row.passed) && !report.cleanupErrors.length && !registry.size;
    report.featurePassed = false; await save(); console.log("RESULT", JSON.stringify({ runDir, diagnosticCompleted: report.diagnosticCompleted, diagnosticGapConfirmed: report.diagnosticGapConfirmed ?? false, featurePassed: false }));
  }
  return report;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  assert.equal(process.argv.length, 2, "No retry or dialog-answer mode in this diagnostic");
  const report = await runManagedDialogCheck(); process.exitCode = report.diagnosticCompleted ? 0 : 1;
}
