// Opt-in Windows acceptance. The browser itself launches each native host.
// Never run this file from unit tests; it creates only an isolated test profile
// and one random, ownership-fenced HKCU NativeMessagingHosts leaf.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import WebSocket from "ws";
import { buildChromeExtension } from "../build-chrome-extension.mjs";
import { browserStartupOptions, resolveFieldTrialConfig } from "./browser-startup.mjs";
import { FocusLedger, focusArrays, focusSnapshotExpression, readFocusEvidence } from "./focus-ledger.mjs";
import { stageReloadObserver, reloadLifecycleRecorderSource, reloadLifecycleSnapshotExpression } from "./extension-reload-support.mjs";
import { assertNoNewFocusEvents, assertSamePopupDocument, popupUIReflectsStatus, restartFixtureHTML } from "./browser-restart-support.mjs";
import { checkNativeHostRestart, lifecycleRecoveryFixture } from "./lifecycle-recovery-fixture.mjs";
import { assertFixtureExtensionInventory, assertNativeProcessIdentity, nativeIdleDurationMs, nativeLifecycleCases, nativeLifecycleOutcome, nativeRegistrationSource, nativeTerminateSource, nativeWatchSource, resolveNativeLifecycleMode } from "./native-lifecycle-support.mjs";

const mode = resolveNativeLifecycleMode(process.env.OBU_TEST_NATIVE_MODE);
assert.equal(process.platform, "win32", "Real native lifecycle registration currently supports Windows only");
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const browserName = process.env.OBU_TEST_NATIVE_BROWSER ?? "chrome";
assert.ok(["chrome", "edge"].includes(browserName));
assert.ok(process.env.OBU_TEST_HOST_BINARY && process.env.OBU_TEST_CHROMIUM_BINARY, "Set OBU_TEST_HOST_BINARY and OBU_TEST_CHROMIUM_BINARY");
const binary = path.resolve(process.env.OBU_TEST_CHROMIUM_BINARY), sourceHost = path.resolve(process.env.OBU_TEST_HOST_BINARY);
await Promise.all([fs.access(binary), fs.access(sourceHost)]);
const root = path.join(repo, ".tmp/browser-integration"); await fs.mkdir(root, { recursive: true });
const runDir = await fs.mkdtemp(path.join(root, "native-lifecycle-"));
const extension = path.join(runDir, "extension"), profile = path.join(runDir, "profile"), temporary = path.join(runDir, "temp");
const host = path.join(runDir, "native-host.exe"), jsSnapshot = path.join(runDir, "js-sdk");
for (const name of ["profile", "temp", "local", "roaming", "home"]) await fs.mkdir(path.join(runDir, name));
const env = { ...process.env, TEMP: temporary, TMP: temporary, LOCALAPPDATA: path.join(runDir, "local"), APPDATA: path.join(runDir, "roaming"), USERPROFILE: path.join(runDir, "home"), HOME: path.join(runDir, "home") };
await fs.copyFile(sourceHost, host); await fs.cp(path.join(repo, "packages/open-browser-use-js/dist"), jsSnapshot, { recursive: true });
const { connectOpenBrowserUse } = await import(pathToFileURL(path.join(jsSnapshot, "index.js")));
const nativeName = `com.openbrowseruse.lifecycle.n${randomBytes(12).toString("hex")}`;
const records = [], hostGenerations = [], clients = new Set(), witnesses = [], browserLogs = [], diagnostics = [];
const report = { scope: "Windows real browser native launcher, host termination and same-version unpacked runtime.reload; no native Port adapter; not signed update, full browser restart, other platforms or user profile", mode, runDir, browserName, profile, nativeName, expectedCases: mode === "acceptance" ? nativeLifecycleCases : [], records, hostGenerations, witnesses, diagnostics, startedAt: Date.now(), focus: { allowedActivations: [], allowedFocus: [] }, ...(mode === "idle-diagnostic" && { diagnostic: { complete: false, durationMs: nativeIdleDurationMs, samples: [], scope: "read-only idle post-install control; no SDK calls, browser actions, host termination or runtime.reload during observation; not lifecycle acceptance" } }) };
const hash = data => createHash("sha256").update(data).digest("hex"), delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const subprocessChildren = new Set();
const save = (name, value) => fs.writeFile(path.join(runDir, name), JSON.stringify(value, null, 2));
async function until(operation, label, timeoutMs = 25000) {
  const end = Date.now() + timeoutMs; let last;
  while (Date.now() < end) { try { const value = await operation(); if (value) return value; } catch (error) { last = error; } await delay(50); }
  throw new Error(`Timed out ${label}${last ? `: ${last.message}` : ""}`);
}
async function bounded(operation, ms, label) {
  let timer; try { return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms); })]); } finally { clearTimeout(timer); }
}
function subprocess(command, args, options = {}) {
  const { timeoutMs = 30000, ...spawnOptions } = options;
  return new Promise((resolve, reject) => {
    const task = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], ...spawnOptions });
    subprocessChildren.add(task);
    task.stdout.setEncoding("utf8"); task.stderr.setEncoding("utf8");
    let stdout = "", stderr = "", timeoutError, killDeadline; task.stdout.on("data", value => stdout += value); task.stderr.on("data", value => stderr += value);
    const timer = setTimeout(() => {
      timeoutError = new Error(`${path.basename(command)} timed out`); task.kill();
      // Cleanup never races this child: normal timeout rejects only on close;
      // failed termination leaves the handle tracked and suppresses registry cleanup.
      killDeadline = setTimeout(() => reject(new Error(`${path.basename(command)} did not close after timeout termination`)), 10000);
    }, timeoutMs);
    task.once("error", error => { clearTimeout(timer); clearTimeout(killDeadline); if (!task.pid) subprocessChildren.delete(task); reject(error); });
    // Process exit can precede the final output bytes; close drains both pipes.
    task.once("close", code => { clearTimeout(timer); clearTimeout(killDeadline); subprocessChildren.delete(task); timeoutError ? reject(timeoutError) : code === 0 ? resolve(stdout) : reject(new Error(`${path.basename(command)} exited ${code}: ${stderr}`)); });
  });
}
async function hashes(directory) {
  const result = {};
  async function walk(relative = "") { for (const entry of await fs.readdir(path.join(directory, relative), { withFileTypes: true })) { const name = path.join(relative, entry.name); if (entry.isDirectory()) await walk(name); else if (entry.isFile()) result[name.replaceAll(path.sep, "/")] = hash(await fs.readFile(path.join(directory, name))); } }
  await walk(); return result;
}
async function cdp(url) {
  const socket = new WebSocket(url), pending = new Map(), events = []; let serial = 0;
  await bounded(new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); }), 10000, "diagnostic CDP connection");
  const fail = error => { for (const value of pending.values()) { clearTimeout(value.timer); value.reject(error); } pending.clear(); };
  socket.on("error", fail); socket.on("close", () => fail(new Error("Diagnostic CDP closed")));
  socket.on("message", bytes => { const value = JSON.parse(bytes); if (value.method) events.push({ ...value, observedAt: Date.now() }); const task = pending.get(value.id); if (!task) return; pending.delete(value.id); clearTimeout(task.timer); value.error ? task.reject(new Error(JSON.stringify(value.error))) : task.resolve(value.result); });
  const call = (method, params = {}) => new Promise((resolve, reject) => { if (socket.readyState !== WebSocket.OPEN) return reject(new Error("Diagnostic CDP closed")); const id = ++serial, timer = setTimeout(() => { pending.delete(id); reject(new Error(`Diagnostic ${method} timed out`)); }, 20000); pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params })); });
  return { call, events, close: () => { fail(new Error("Fixture closed CDP")); socket.close(); }, evaluate: async expression => { const result = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails)); return result.result.value; } };
}

let child, childExit, control, worker, workerTarget, observer, observerTarget, companion, extensionId, endpoint, nativeExecutable, debugPort, fixtureURL, settingsManager, settingsManagerTarget, registryAttempted = false;
const ledger = new FocusLedger(), endpointFile = path.join(temporary, "open-browser-use/active.json"), registryScript = path.join(runDir, "registry.ps1");
const server = createServer((request, response) => {
  const url = new URL(request.url, "http://localhost"); response.setHeader("Cache-Control", "no-store");
  if (url.pathname === "/witness") { witnesses.push({ at: Date.now(), method: request.method, marker: url.searchParams.get("marker"), kind: url.searchParams.get("kind") }); response.end("ok"); return; }
  response.setHeader("Content-Type", "text/html; charset=utf-8"); response.end(url.pathname === "/lifecycle-recovery" ? lifecycleRecoveryFixture() : restartFixtureHTML(url));
});
const targets = async () => (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
const nativeStatus = () => worker.evaluate("chrome.storage.local.get('OPEN_BROWSER_USE_NATIVE_HOST_STATUS').then(value=>value.OPEN_BROWSER_USE_NATIVE_HOST_STATUS)");
async function processTable() { return JSON.parse(await subprocess("powershell.exe", ["-NoProfile", "-Command", "@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,ExecutablePath,@{n='CreationDate';e={$_.CreationDate.ToUniversalTime().ToString('o')}}) | ConvertTo-Json -Compress"])); }
async function processIdentity(value) { return assertNativeProcessIdentity(value, await processTable(), { executable: nativeExecutable, browserPid: child.pid }); }
async function endpointRecords() {
  const directory = path.dirname(endpointFile), values = [];
  for (const name of await fs.readdir(directory).catch(error => error.code === "ENOENT" ? [] : Promise.reject(error))) {
    if (!name.endsWith(".json")) continue;
    try { values.push({ file: name, record: JSON.parse(await fs.readFile(path.join(directory, name), "utf8")) }); } catch (error) { if (error.code !== "ENOENT") throw error; }
  } return values;
}
async function unreachable(socketPath) {
  return bounded(new Promise((resolve, reject) => { const socket = net.createConnection(socketPath); socket.once("connect", () => { socket.destroy(); resolve(false); }); socket.once("error", error => { socket.destroy(); if (["ENOENT", "ECONNREFUSED"].includes(error.code)) resolve({ code: error.code, at: Date.now() }); else reject(error); }); }), 2000, "old endpoint probe");
}
async function waitHost(previous, label) {
  const value = await until(async () => {
    const next = JSON.parse(await fs.readFile(endpointFile, "utf8"));
    if (previous && (next.pid === previous.pid || next.socketPath === previous.socketPath || next.startedAt === previous.startedAt)) return false;
    const identity = await processIdentity(next), status = await nativeStatus();
    if (status?.state !== "connected" || status.hostName !== nativeName) return false;
    const browser = await connectOpenBrowserUse({ socketPath: next.socketPath, sessionId: "native-lifecycle-inspection", timeoutMs: 2000 });
    try { const info = await browser.client.getInfo(); assert.equal(typeof info.metadata.extensionInstanceId, "string"); assert.ok(info.metadata.extensionInstanceId.length > 0); return { ...next, identity, status, info, observedAt: Date.now() }; } finally { browser.close(); }
  }, label, 45000);
  endpoint = value; hostGenerations.push(value); return value;
}
async function waitOldHostGone(previous, { cleanEOF }) {
  const missing = await until(async () => !(await processTable()).some(value => value.ProcessId === previous.pid) && { at: Date.now() }, "original native host process exit", 15000);
  const oldEndpoint = await until(() => unreachable(previous.socketPath), "old named pipe unavailable", 5000);
  let entries = await endpointRecords();
  if (cleanEOF) entries = await until(async () => { const values = await endpointRecords(); return values.every(value => value.record.socketPath !== previous.socketPath) && values; }, "EOF host descriptor cleanup", 10000);
  return { missing, oldEndpoint, recordsAfter: entries, cleanupExpectation: cleanEOF ? "normal native EOF removes old active/endpoint descriptor" : "forced process exit may retain stale descriptors; no production cleanup inferred" };
}
let watchSequence = 0;
async function observeEOF(previous) {
  const label = `native-exit-${++watchSequence}`, identityFile = path.join(runDir, `${label}-identity.json`), readyFile = path.join(runDir, `${label}-ready.json`);
  await fs.writeFile(identityFile, JSON.stringify((await processIdentity(previous)).process));
  // Attach the rejection handler immediately; a failed native reload must still
  // retain the observation error instead of causing an unhandled rejection.
  const completed = subprocess("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(runDir, "watch-native.ps1"), identityFile, readyFile], { timeoutMs: 50000 }).then(value => ({ result: JSON.parse(value) }), error => ({ error: error.message }));
  const ready = await until(async () => JSON.parse(await fs.readFile(readyFile, "utf8")), "native process exit observer ready", 10000); assert.equal(ready.pid, previous.pid);
  return { ready, completed };
}
async function connect(sessionId) { const value = await connectOpenBrowserUse({ socketPath: endpoint.socketPath, sessionId, timeoutMs: 20000 }); clients.add(value); return value; }
const scope = browser => ({ session_id: browser.client.sessionId, turn_id: browser.client.turnId, control_epoch: browser.client.controlEpoch });
async function focus() { return readFocusEvidence(ledger, report.focus, () => observer.evaluate(focusSnapshotExpression)); }
async function assertFocus() {
  const current = await focus(); ledger.assertAllowed(current, report.focus.allowedActivations, report.focus.allowedFocus);
  const tabs = await observer.evaluate(`chrome.tabs.query({active:true,windowId:${report.sentinel.windowId}})`); assert.equal(tabs[0]?.id, report.sentinel.id); return current;
}
async function observeIdle() {
  const detail = report.diagnostic, original = endpoint;
  detail.originalHost = { pid: original.pid, socketPath: original.socketPath, startedAt: original.startedAt, identity: original.identity };
  detail.startedAt = Date.now(); const deadline = detail.startedAt + detail.durationMs;
  do {
    const sample = { requestedAt: Date.now() }; detail.samples.push(sample);
    // Reading and validating ledger continuity must succeed. An unwanted event
    // is a recorded observation, never a reason to truncate the idle interval.
    sample.focus = await focus();
    sample.windows = await observer.evaluate("chrome.windows.getAll().then(values=>values.map(({id,focused,state,type})=>({id,focused,state,type})))");
    sample.sentinel = await observer.evaluate(`chrome.tabs.get(${report.sentinel.id}).then(({id,windowId,active})=>({id,windowId,active}))`);
    sample.nativeStatus = await nativeStatus();
    sample.inventory = await extensionInventory(`idle-sample-${detail.samples.length}`);
    try {
      ledger.assertAllowed(sample.focus, report.focus.allowedActivations, report.focus.allowedFocus);
      assert.equal(sample.sentinel.active, true); assert.equal(sample.sentinel.windowId, report.sentinel.windowId);
      sample.focusValidation = "passed";
    } catch (error) { sample.focusValidation = "failed"; sample.focusError = error.stack; }
    sample.completedAt = Date.now(); await save("idle-diagnostic.json", detail);
    if (sample.focus.at >= deadline) break;
    await delay(Math.min(1000, Math.max(0, deadline - Date.now())));
  } while (true);
  detail.observedThrough = detail.samples.at(-1).focus.at;
  const current = JSON.parse(await fs.readFile(endpointFile, "utf8"));
  detail.hostAfter = { ...current, identity: await processIdentity(current), status: await nativeStatus(), observedAt: Date.now() };
  for (const key of ["pid", "socketPath", "startedAt"]) assert.equal(current[key], original[key], `Idle control native host changed: ${key}`);
  assert.equal(detail.hostAfter.identity.process.CreationDate, original.identity.process.CreationDate, "Idle control native PID was reused");
  assert.equal(detail.hostAfter.status?.state, "connected"); assert.equal(detail.hostAfter.status.hostName, nativeName);
  detail.originalHostUnchanged = true; detail.observationComplete = true;
  detail.focusValidation = detail.samples.every(sample => sample.focusValidation === "passed") ? "passed" : "failed";
  await save("idle-diagnostic.json", detail);
}
async function extensionInventory(label, expectedIds = [extensionId, companion.extensionId]) {
  const record = { label, requestedAt: Date.now(), settingsTarget: settingsManagerTarget };
  report.extensionInventories ??= []; report.extensionInventories.push(record);
  try {
    const target = (await settingsManager.call("Target.getTargetInfo")).targetInfo;
    assert.equal(target.targetId, settingsManagerTarget, "Inventory settings document changed");
    record.entries = await settingsManager.evaluate("chrome.developerPrivate.getExtensionsInfo({includeDisabled:true,includeTerminated:true}).then(values=>values.map(({id,location,state,type})=>({id,location,state,type})))");
    record.completedAt = Date.now(); Object.assign(record, assertFixtureExtensionInventory(record.entries, expectedIds)); record.passed = true; return record;
  } catch (error) { record.passed = false; record.error = error.message; throw error; }
  finally { await save("extension-inventory.json", report.extensionInventories); }
}
async function artifactCheckpoint(tag, phase) {
  const record = { tag, phase, requestedAt: Date.now() }; report.artifactFocusCheckpoints ??= []; report.artifactFocusCheckpoints.push(record);
  try {
    record.focus = await focus();
    record.windows = await observer.evaluate("chrome.windows.getAll().then(values=>values.map(({id,focused,state,type})=>({id,focused,state,type})))");
    record.sentinel = await observer.evaluate(`chrome.tabs.get(${report.sentinel.id}).then(({id,windowId,active})=>({id,windowId,active}))`);
    ledger.assertAllowed(record.focus, report.focus.allowedActivations, report.focus.allowedFocus); assert.equal(record.sentinel.active, true); assert.equal(record.sentinel.windowId, report.sentinel.windowId); record.passed = true;
  } catch (error) { record.passed = false; record.error = error.message; throw error; }
  finally { record.completedAt = Date.now(); await save("artifact-focus-checkpoints.json", report.artifactFocusCheckpoints); }
}
async function bindWorker(oldTarget) {
  const target = await until(async () => { const all = await targets(); return (!oldTarget || !all.some(value => value.id === oldTarget)) && all.find(value => value.type === "service_worker" && value.url === `chrome-extension://${extensionId}/background.js`); }, "exact native replacement worker");
  worker?.close(); worker = await cdp(target.webSocketDebuggerUrl); workerTarget = target.id; return target;
}
async function installExtensions() {
  const targetId = (await control.call("Target.createTarget", { url: browserName === "edge" ? "edge://extensions/" : "chrome://extensions/", background: true })).targetId;
  const target = await until(async () => (await targets()).find(value => value.id === targetId), "private extensions settings"); const settings = await cdp(target.webSocketDebuggerUrl);
  settingsManager = settings; settingsManagerTarget = targetId;
  const evidence = report.installation = { scope: "setup before foreground coverage; CDP bootstrap followed by ordinary extension manager reload", entries: [] };
  // Private browser setup diagnostics only. Edge does not necessarily use the
  // Chromium extensions-manager shadow tree; preserve actual rendered controls
  // before selecting an implementation instead of guessing another selector.
  async function settingsDiagnostic(label) {
    const value = await settings.evaluate(`(async()=>{
      const roots=[document],controls=[],shadows=[],seen=new Set();let scanned=0,truncated=false;
      const text=value=>String(value??'').slice(0,500);
      while(roots.length){const root=roots.shift();for(const node of root.querySelectorAll('*')){
        if(++scanned>5000){truncated=true;break}
        if(node.shadowRoot&&!seen.has(node.shadowRoot)){seen.add(node.shadowRoot);roots.push(node.shadowRoot);if(shadows.length<20)shadows.push({host:node.localName,id:node.id,html:node.shadowRoot.innerHTML.slice(0,10000)})}
        if(controls.length<200&&(node.matches('input,button,label,[role],[aria-label],select')||node.localName.includes('toggle')))controls.push({tag:node.localName,id:node.id,type:node.getAttribute('type'),role:node.getAttribute('role'),label:node.getAttribute('aria-label'),labelledBy:node.getAttribute('aria-labelledby'),text:text(node.innerText??node.textContent),checked:typeof node.checked==='boolean'?node.checked:null,ariaChecked:node.getAttribute('aria-checked'),disabled:typeof node.disabled==='boolean'?node.disabled:null,html:node.outerHTML.slice(0,1500)});
      }if(truncated)break}
      const api=globalThis.chrome?.developerPrivate;let configuration,configurationError;
      try{if(typeof api?.getProfileConfiguration==='function')configuration=await api.getProfileConfiguration()}catch(error){configurationError=String(error)}
      return{url:location.href,readyState:document.readyState,title:document.title,text:document.body?.innerText.slice(0,15000),html:document.documentElement.outerHTML.slice(0,30000),scripts:[...document.scripts].slice(0,30).map(node=>node.src),controls,shadows,scanned,truncated,api:{getProfileConfiguration:typeof api?.getProfileConfiguration,updateProfileConfiguration:typeof api?.updateProfileConfiguration,reload:typeof api?.reload},configuration,configurationError};
    })()`);
    evidence.settingsDiagnostics ??= []; evidence.settingsDiagnostics.push({ label, at: Date.now(), ...value });
    await save(`settings-${label}.json`, value); return value;
  }
  try {
    await until(() => settings.evaluate("document.readyState==='complete'"), "extensions manager document ready");
    await extensionInventory("setup-before-install", []);
    const initialSettings = await settingsDiagnostic("before-setup");
    if (browserName === "edge") {
      // Actual Edge 153 diagnostics exposed two responsive fluent-switch
      // #dev-switch instances inside open shadow roots, not Chromium's toolbar.
      // Edge's local switch state did not follow a direct native API update in
      // the diagnostic run. Click its one visible switch, then require native
      // configuration and that rendered control to agree. The hidden drawer's
      // duplicate remains diagnostic data, not a second interaction target.
      assert.equal(initialSettings.configuration.isDeveloperModeControlledByPolicy, false);
      assert.equal(initialSettings.configuration.canLoadUnpacked, true);
      const nodes = `(()=>{const roots=[document],found=[];let scanned=0;while(roots.length){for(const node of roots.shift().querySelectorAll('*')){if(++scanned>5000)throw new Error('Edge settings control scan exceeded bound');if(node.shadowRoot)roots.push(node.shadowRoot);if(node.matches('fluent-switch#dev-switch'))found.push(node)}}return found})()`;
      const switches = `(${nodes}).map(node=>{const rect=node.getBoundingClientRect();return{tag:node.localName,id:node.id,label:node.getAttribute('aria-label'),checked:node.checked,disabled:node.disabled,visible:node.checkVisibility(),width:rect.width,height:rect.height}})`;
      evidence.developerModeBefore = { configuration: initialSettings.configuration, switches: await settings.evaluate(switches) };
      assert.ok(evidence.developerModeBefore.switches.length > 0, "Observed Edge developer-mode switches are missing");
      assert.ok(evidence.developerModeBefore.switches.every(value => typeof value.checked === "boolean" && value.disabled === false));
      const visibleBefore = evidence.developerModeBefore.switches.filter(value => value.visible && value.width > 0 && value.height > 0);
      assert.equal(visibleBefore.length, 1, "Edge developer-mode UI has no unique visible switch");
      assert.equal(visibleBefore[0].checked, initialSettings.configuration.inDeveloperMode, "Edge native and rendered developer-mode state disagree before setup");
      evidence.developerModeMethod = "click actual visible Edge fluent-switch#dev-switch, confirmed by native profile state and rendered switch";
      if (!initialSettings.configuration.inDeveloperMode) evidence.developerModeClick = await settings.evaluate(`(()=>{const found=(${nodes}).filter(node=>{const rect=node.getBoundingClientRect();return node.checkVisibility()&&rect.width>0&&rect.height>0});if(found.length!==1||found[0].disabled||found[0].checked)throw new Error('Edge developer-mode click precondition changed');const node=found[0],before={checked:node.checked,label:node.getAttribute('aria-label')};node.click();return{at:Date.now(),before}})()`);
      evidence.developerModeAfter = await until(async () => {
        const value = await settings.evaluate(`(async()=>({configuration:await chrome.developerPrivate.getProfileConfiguration(),switches:${switches}}))()`);
        const visible = value.switches.filter(item => item.visible && item.width > 0 && item.height > 0);
        return value.configuration.inDeveloperMode === true && visible.length === 1 && visible[0].checked === true && visible[0].disabled === false && value;
      }, "Edge native profile state and rendered developer-mode switch confirmation");
      await settingsDiagnostic("developer-mode-enabled");
    } else {
      const toggle = "document.querySelector('extensions-manager')?.shadowRoot?.querySelector('extensions-toolbar')?.shadowRoot?.querySelector('#devMode')";
      evidence.developerModeBefore = await until(() => settings.evaluate(`(()=>{const value=${toggle};return value&&{checked:value.checked,disabled:value.disabled}})()`), "developer-mode UI");
      assert.equal(evidence.developerModeBefore.disabled, false);
      if (!evidence.developerModeBefore.checked) await settings.evaluate(`(${toggle}).click()`);
      evidence.developerModeAfter = await until(async () => { const value = await settings.evaluate("chrome.developerPrivate.getProfileConfiguration()"); return value.inDeveloperMode && value; }, "native developer-mode configuration");
    }
    for (const directory of [companion.directory, extension]) {
      const entry = { directory, loaded: await control.call("Extensions.loadUnpacked", { path: directory }) }; evidence.entries.push(entry);
      let before;
      if (directory === extension) {
        assert.equal(entry.loaded.id, extensionId); await bindWorker();
        entry.initialLifecycle = await until(async () => { const value = await worker.evaluate(reloadLifecycleSnapshotExpression); return value.events.some(item => item.event === "onInstalled" && item.reason === "install") && value; }, "initial genuine install event");
        before = await waitHost(null, "browser-launched bootstrap native host"); entry.oldWorkerTarget = workerTarget;
      }
      entry.reloadAt = Date.now(); entry.reloadReply = await settings.evaluate(`chrome.developerPrivate.reload(${JSON.stringify(entry.loaded.id)},{failQuietly:true,populateErrorForUnpacked:true})`); assert.ok(entry.reloadReply == null);
      if (directory === extension) {
        await bindWorker(entry.oldWorkerTarget); entry.newWorkerTarget = workerTarget;
        entry.reloadLifecycle = await until(async () => { const value = await worker.evaluate(reloadLifecycleSnapshotExpression); return value.events.some(item => item.event === "onInstalled" && item.reason === "update") && value; }, "normal setup reload native event");
        entry.host = await waitHost(before, "browser-launched post-install native host"); entry.oldHost = await waitOldHostGone(before, { cleanEOF: true });
      }
    }
    evidence.extensions = await control.call("Extensions.getExtensions"); assert.equal(evidence.extensions.extensions.length, 2); assert.ok(evidence.extensions.extensions.every(value => value.enabled));
    evidence.fullInventory = await extensionInventory("setup-after-install");
    evidence.retainedInventorySettingsPage = { targetId, background: true, scope: "same initial manager page kept for read-only inventory until browser teardown" };
  } catch (error) {
    if (error.code !== "OBU_TEST_PROFILE_NOT_ISOLATED") try { await settingsDiagnostic("setup-failed"); } catch (diagnosticError) { evidence.settingsDiagnosticError = diagnosticError.message; }
    throw error;
  }
}
async function pageState(tabId) {
  const values = await worker.evaluate(`chrome.scripting.executeScript({target:{tabId:${tabId}},world:'MAIN',func:()=>({documentToken,clicks:[...clicks],lateClicks,name:document.querySelector('#name').value})})`);
  assert.equal(values.length, 1); assert.equal(values[0].frameId, 0); assert.equal(typeof values[0].documentId, "string"); return { ...values[0].result, documentId: values[0].documentId };
}
async function tabIdentity(tabId) { const tab = await worker.evaluate(`chrome.tabs.get(${tabId})`); const group = await worker.evaluate(`chrome.tabGroups.get(${tab.groupId})`); return { id: tab.id, url: tab.url, windowId: tab.windowId, groupId: tab.groupId, groupTitle: group.title, groupColor: group.color }; }
async function runtimeIdentity() {
  const lifecycle = await worker.evaluate(reloadLifecycleSnapshotExpression), contexts = await worker.evaluate("chrome.runtime.getContexts({contextTypes:['BACKGROUND']})"), marker = await worker.evaluate("chrome.storage.session.get('OPEN_BROWSER_USE_BROWSER_LIFETIME').then(value=>value.OPEN_BROWSER_USE_BROWSER_LIFETIME)");
  assert.equal(contexts.length, 1); assert.equal(lifecycle.overflow, false);
  return { at: Date.now(), browserPid: child.pid, browserId: report.browserId, extensionId, extensionInstanceId: endpoint.info.metadata.extensionInstanceId, workerTarget, contextId: contexts[0].contextId, incarnation: marker.incarnation, lifecycle, host: endpoint, observerTarget, focus: await assertFocus() };
}
async function reload(detail) {
  detail.before = await runtimeIdentity(); const targetStart = control.events.length;
  const exitObserver = await observeEOF(detail.before.host); detail.exitObserverReady = exitObserver.ready;
  detail.requestedAt = Date.now(); detail.invocations = 1;
  try { detail.triggerReply = await worker.evaluate("setTimeout(()=>chrome.runtime.reload(),0);'reload scheduled'"); } catch (error) { detail.triggerReplyError = error.message; }
  await bindWorker(detail.before.workerTarget);
  await until(async () => (await worker.evaluate(reloadLifecycleSnapshotExpression)).events.some(value => value.event === "onInstalled" && value.reason === "update"), "actual runtime.reload update event");
  await waitHost(detail.before.host, "new browser native host following runtime.reload");
  detail.oldHost = await waitOldHostGone(detail.before.host, { cleanEOF: true }); detail.processExit = await exitObserver.completed;
  assert.equal(detail.processExit.error, undefined, "Native EOF process observation failed"); assert.equal(detail.processExit.result.exitCode, 0, "Native host did not exit cleanly after native Port EOF");
  detail.after = await runtimeIdentity(); detail.targetEvents = control.events.slice(targetStart);
  for (const key of ["browserPid", "browserId", "extensionId", "extensionInstanceId", "observerTarget"]) assert.equal(detail.after[key], detail.before[key]);
  for (const key of ["workerTarget", "contextId", "incarnation"]) assert.notEqual(detail.after[key], detail.before[key]);
  assert.notEqual(detail.after.lifecycle.bootId, detail.before.lifecycle.bootId); assert.equal(detail.after.lifecycle.manifestVersion, detail.before.lifecycle.manifestVersion);
  assert.ok(detail.targetEvents.some(value => value.method === "Target.targetDestroyed" && value.params.targetId === detail.before.workerTarget));
  assert.ok(detail.targetEvents.some(value => value.method === "Target.targetCreated" && value.params.targetInfo.targetId === detail.after.workerTarget));
  assertNoNewFocusEvents(detail.before.focus, detail.after.focus);
}

let popupSequence = 0;
async function openPopup() {
  const before = await assertFocus(); await worker.evaluate(`chrome.action.openPopup({windowId:${report.sentinel.windowId}})`);
  const url = `chrome-extension://${extensionId}/popup.html`, contexts = await until(async () => { const value = await worker.evaluate("chrome.runtime.getContexts({contextTypes:['POPUP']})"); return value.some(item => item.documentUrl === url) && value; }, "real action popup");
  const after = await focus(); report.focus.allowedFocus.push(...ledger.allowActionPopup(before, after, { windowId: report.sentinel.windowId, popupURL: url, reason: "explicit test Pause/Resume action popup", popupContexts: contexts.map(value => ({ type: value.contextType, documentUrl: value.documentUrl, documentId: value.documentId })) }));
  const target = await until(async () => (await targets()).find(value => value.url === url), "real popup target"), popup = await cdp(target.webSocketDebuggerUrl), original = contexts.find(value => value.documentUrl === url);
  assertSamePopupDocument(original, contexts); return { popup, original, afterOpen: after, targetId: target.id };
}
async function popupStatus(session, { action, state } = {}) {
  assertSamePopupDocument(session.original, await worker.evaluate("chrome.runtime.getContexts({contextTypes:['POPUP']})")); assertNoNewFocusEvents(session.afterOpen, await assertFocus());
  const read = async () => { const value = await session.popup.evaluate("chrome.runtime.sendMessage({type:'GET_AUTOMATION_CONTROL_STATUS'})"); assert.equal(value.ok, true); return value.status; };
  let status = await read(); if (state) status = await until(async () => { const value = await read(); return value.state === state && value; }, `popup ${state}`);
  if (action) {
    const initial = status; const expected = action === "pause" ? "Pause all agents" : "Resume control";
    await until(async () => { const value = await session.popup.evaluate("(()=>{const b=document.querySelector('#automation-toggle');return{label:b?.textContent.trim(),disabled:b?.disabled}})()"); return value.label === expected && !value.disabled; }, `actual ${action} button`);
    await session.popup.evaluate("document.querySelector('#automation-toggle').click()");
    status = await until(async () => { const value = await read(); return value.revision > initial.revision && value.state === (action === "pause" ? "paused" : "running") && (action !== "pause" || value.cleanupComplete) && value; }, `explicit ${action} acknowledgement`);
  }
  const ui = await until(async () => { const value = await session.popup.evaluate("(()=>{const b=document.querySelector('#automation-toggle');return{state:document.querySelector('#automation-status-pill')?.dataset.state,label:document.querySelector('#automation-status-label')?.textContent.trim(),buttonText:b?.textContent.trim(),buttonDisabled:b?.disabled,message:document.querySelector('#automation-message')?.textContent.trim(),hint:document.querySelector('#automation-hint')?.textContent.trim()}})()"); return popupUIReflectsStatus(status, value) && value; }, "terminal popup rendering");
  const bytes = Buffer.from((await session.popup.call("Page.captureScreenshot", { format: "png" })).data, "base64"), file = `popup-${++popupSequence}-${status.state}.png`;
  assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])); await fs.writeFile(path.join(runDir, file), bytes);
  assertSamePopupDocument(session.original, await worker.evaluate("chrome.runtime.getContexts({contextTypes:['POPUP']})")); assertNoNewFocusEvents(session.afterOpen, await assertFocus());
  return { ...status, ui, context: session.original, screenshot: { file, bytes: bytes.length, sha256: hash(bytes), width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) } };
}
async function closePopup(session) {
  try { await session.popup.evaluate("window.close()"); } catch (error) { diagnostics.push({ phase: "popup close reply", error: error.message }); } finally { session.popup.close(); }
  await until(async () => !(await worker.evaluate("chrome.runtime.getContexts({contextTypes:['POPUP']})")).some(value => value.documentId === session.original.documentId), "original popup closed"); assertNoNewFocusEvents(session.afterOpen, await assertFocus());
}

async function artifacts(tag) {
  await artifactCheckpoint(tag, "before-connect");
  const owner = await connect(`native-lifecycle-${tag}`); await artifactCheckpoint(tag, "after-owner-connect");
  const producer = await connect(`native-output-${tag}`); await artifactCheckpoint(tag, "after-producer-connect");
  const task = await owner.newTab({ url: fixtureURL + `lifecycle?marker=task-${tag}` }); await artifactCheckpoint(tag, "after-task-create-and-navigate");
  const output = await producer.newTab({ url: fixtureURL + `lifecycle?marker=output-${tag}` }); await artifactCheckpoint(tag, "after-output-create-and-navigate");
  await task.domSnapshot(); await artifactCheckpoint(tag, "after-task-snapshot");
  await producer.client.finalizeTabs([{ tabId: output.id, status: "deliverable" }]); await artifactCheckpoint(tag, "after-output-finalize");
  const value = { owner, producer, task, output, oldScope: scope(owner), outputScope: scope(producer), taskIdentity: await tabIdentity(task.id), outputIdentity: await tabIdentity(output.id), taskPage: await pageState(task.id), outputPage: await pageState(output.id) };
  await artifactCheckpoint(tag, "after-identity-and-document-reads"); return value;
}
async function preserve(value, detail) {
  detail.taskIdentity = await tabIdentity(value.task.id); detail.outputIdentity = await tabIdentity(value.output.id); detail.taskPage = await pageState(value.task.id); detail.outputPage = await pageState(value.output.id);
  assert.deepEqual(detail.taskIdentity, value.taskIdentity); assert.deepEqual(detail.outputIdentity, value.outputIdentity); assert.deepEqual(detail.taskPage, value.taskPage); assert.deepEqual(detail.outputPage, value.outputPage);
}
async function explicitRecovery(value, detail) {
  const next = await connect(value.oldScope.session_id);
  await assert.rejects(next.client.request("getTabs", value.oldScope), error => { detail.staleEpochError = error.message; return /OBU_STALE_CONTROL_EPOCH|OBU_CONTROL_BOOTSTRAP_REQUIRED/.test(error.message); });
  await next.client.beginTurn(); detail.newEpoch = next.client.controlEpoch; assert.ok(detail.newEpoch > value.oldScope.control_epoch);
  detail.ownedBeforeClaim = await next.getTabs(); assert.equal(detail.ownedBeforeClaim.some(tab => tab.id === value.task.id), false);
  await assert.rejects(next.tab(value.task.id).getByLabel("Name").fill("unclaimed must fail"), error => { detail.unclaimedError = error.message; return /not part|ownership/i.test(error.message); });
  await next.client.claimUserTab(value.task.id); await next.tab(value.task.id).getByLabel("Name").fill("explicit new turn and claim"); await next.tab(value.task.id).getByRole("button", { name: "Explicit action", exact: true }).click();
  detail.afterClaim = await pageState(value.task.id); assert.equal(detail.afterClaim.name, "explicit new turn and claim"); assert.deepEqual(detail.afterClaim.clicks, [{ trusted: true }]); assert.equal(detail.afterClaim.lateClicks, 0);
  const marker = new URL(value.taskIdentity.url).searchParams.get("marker"); await until(() => witnesses.some(item => item.marker === marker), "trusted explicit action server witness");
  detail.witnesses = witnesses.filter(item => item.marker === marker); assert.deepEqual(detail.witnesses.map(item => ({ method: item.method, kind: item.kind })), [{ method: "POST", kind: "explicit" }]);
  assert.deepEqual(await pageState(value.output.id), value.outputPage); assert.deepEqual(await tabIdentity(value.output.id), value.outputIdentity);
}
async function runCase(name, action) {
  const record = { name, passed: false, startedAt: Date.now(), detail: {} }; records.push(record);
  try { record.inventoryBefore = await extensionInventory(`${name}-before`); await assertFocus(); await action(record.detail); await assertFocus(); record.passed = true; }
  catch (error) { record.error = error.stack; console.error("FAIL", name, error.message); }
  finally {
    try { record.inventoryAfter = await extensionInventory(`${name}-after`); await assertFocus(); } catch (error) { record.passed = false; record.finalInventoryOrFocusError = error.stack; console.error("FAIL", name, error.message); }
    if (record.passed) console.log("PASS", name);
    record.completedAt = Date.now(); await save(`${name}.json`, record); await save("results.json", report);
  }
  return record.passed;
}

try {
  report.sourceIdentity = { gitHead: (await subprocess("git", ["rev-parse", "HEAD"], { cwd: repo })).trim(), dirty: !!(await subprocess("git", ["status", "--porcelain"], { cwd: repo })).trim(), host: hash(await fs.readFile(host)), browser: hash(await fs.readFile(binary)), jsSDK: await hashes(jsSnapshot), harness: hash(await fs.readFile(fileURLToPath(import.meta.url))), support: hash(await fs.readFile(path.join(repo, "scripts/browser-integration/native-lifecycle-support.mjs"))) };
  report.sourceIdentity.dependencies = {};
  for (const name of ["lifecycle-recovery-fixture.mjs", "extension-reload-support.mjs", "browser-restart-support.mjs", "focus-ledger.mjs", "browser-startup.mjs"]) report.sourceIdentity.dependencies[name] = hash(await fs.readFile(path.join(repo, "scripts/browser-integration", name)));
  report.sourceIdentity.buildScript = hash(await fs.readFile(path.join(repo, "scripts/build-chrome-extension.mjs")));
  await buildChromeExtension(extension); report.productionExtensionHashes = await hashes(extension);
  const backgroundFile = path.join(extension, "background.js"), background = await fs.readFile(backgroundFile, "utf8"), original = 'const NATIVE_HOST_NAME = "com.ifuryst.open_browser_use.extension";';
  assert.equal(background.split(original).length, 2); assert.equal(background.split("chrome.runtime.connectNative(this.hostName)").length, 2);
  await fs.writeFile(backgroundFile, reloadLifecycleRecorderSource + background.replace(original, `const NATIVE_HOST_NAME = ${JSON.stringify(nativeName)};`));
  const manifestFile = path.join(extension, "manifest.json"), manifest = JSON.parse(await fs.readFile(manifestFile, "utf8")), cli = await fs.readFile(path.join(repo, "cmd/open-browser-use/main.go"), "utf8");
  const key = manifest.key ?? cli.match(/const betaExtensionPublicKey = "([^"]+)"/)?.[1]; assert.ok(key); manifest.key = key;
  extensionId = hash(Buffer.from(key, "base64")).slice(0, 32).replace(/[0-9a-f]/g, value => String.fromCharCode(97 + parseInt(value, 16))); await fs.writeFile(manifestFile, JSON.stringify(manifest, null, 2));
  report.extensionId = extensionId; report.stagedExtensionHashes = await hashes(extension);
  report.stagingExceptions = ["unique native host-name constant", "public unpacked extension key", "passive native lifecycle listener only; production connectNative unchanged"];
  assert.deepEqual(Object.keys(report.productionExtensionHashes).filter(name => report.productionExtensionHashes[name] !== report.stagedExtensionHashes[name]).sort(), ["background.js", "manifest.json"]);
  companion = await stageReloadObserver({ directory: path.join(runDir, "observer-extension") }); report.observer = companion;
  const manifestPath = path.join(runDir, "native-host.json"); await subprocess(host, ["install-manifest", "--browser", browserName, "--extension-id", extensionId, "--path", host, "--output", manifestPath], { env });
  const native = JSON.parse(await fs.readFile(manifestPath, "utf8")); native.name = nativeName; await fs.writeFile(manifestPath, JSON.stringify(native, null, 2)); nativeExecutable = native.path;
  assert.ok(path.relative(runDir, path.resolve(nativeExecutable)) && !path.relative(runDir, path.resolve(nativeExecutable)).startsWith(".."), "Native executable escaped private run directory");
  assert.equal(hash(await fs.readFile(nativeExecutable)), report.sourceIdentity.host); report.nativeManifest = native;
  await fs.writeFile(registryScript, nativeRegistrationSource); await fs.writeFile(path.join(runDir, "terminate-native.ps1"), nativeTerminateSource); await fs.writeFile(path.join(runDir, "watch-native.ps1"), nativeWatchSource);
  await save("registration.json", { Name: nativeName, Browser: browserName, Manifest: manifestPath, Owner: randomBytes(16).toString("hex") }); registryAttempted = true;
  report.registration = JSON.parse(await subprocess("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", registryScript, "create"]));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); fixtureURL = `http://127.0.0.1:${server.address().port}/`;
  const startup = browserStartupOptions([`--user-data-dir=${profile}`, "--remote-debugging-port=0", "--enable-unsafe-extension-debugging", "--no-first-run", "--no-default-browser-check", "--disable-sync", "--disable-background-networking", "--site-per-process", "--no-sandbox", "--enable-logging=stderr", "about:blank"], resolveFieldTrialConfig(process.env.OBU_TEST_FIELD_TRIAL_CONFIG)); report.startup = startup;
  report.environmentIsolation = { flags: ["--disable-sync", "--disable-background-networking"], scope: "same explicit private-profile test policy for Chrome and Edge; not a product configuration change", inventory: "complete extensions-manager list including disabled and terminated, projected to id/location/state/type only; setup and each case boundaries", allowedComponents: "only entries explicitly reported by the API with location COMPONENT", upstreamComponentVisibility: "ShouldDisplayInExtensionSettings normally hides component extensions, themes and non-unpacked hosted apps; no show-component-extension-options flag", primarySources: ["https://raw.githubusercontent.com/chromium/chromium/main/chrome/browser/extensions/api/developer_private/extension_info_generator.cc", "https://raw.githubusercontent.com/chromium/chromium/main/extensions/browser/ui_util.cc"] };
  child = spawn(binary, startup.args, { env, windowsHide: startup.windowsHide, stdio: ["ignore", "ignore", "pipe"] }); report.browserPid = child.pid;
  child.stderr.on("data", value => browserLogs.push(value.toString())); childExit = new Promise(resolve => { child.once("exit", (code, signal) => { report.browserExit = { code, signal, at: Date.now() }; resolve(report.browserExit); }); child.once("error", error => resolve({ error: error.message })); });
  const lines = await until(async () => (await fs.readFile(path.join(profile, "DevToolsActivePort"), "utf8")).trim().split("\n"), "isolated native browser CDP endpoint"); debugPort = lines[0]; report.browserId = lines[1];
  control = await cdp(`ws://127.0.0.1:${debugPort}${lines[1]}`); await control.call("Target.setDiscoverTargets", { discover: true }); report.browserVersion = await control.call("Browser.getVersion");
  await installExtensions();
  report.sentinel = await worker.evaluate(`chrome.tabs.create({url:${JSON.stringify(fixtureURL + "sentinel?marker=sentinel")},active:true})`);
  await until(async () => (await worker.evaluate(`chrome.tabs.get(${report.sentinel.id})`)).status === "complete", "foreground sentinel loaded");
  observerTarget = (await control.call("Target.createTarget", { url: companion.url, background: true })).targetId;
  observer = await cdp((await until(async () => (await targets()).find(value => value.id === observerTarget), "independent observer target")).webSocketDebuggerUrl);
  await until(() => observer.evaluate("globalThis.__integrationFocusLedger?.snapshot().ready"), "independent observer initialized");
  const firstFocus = mode === "acceptance" ? await assertFocus() : await focus();
  if (mode === "acceptance") assert.deepEqual(firstFocus.events, []);
  report.focus.coverageStartedAt = firstFocus.at;
  console.log("HARNESS", JSON.stringify({ runDir, mode, browserName, browserPid: child.pid, hostPid: endpoint.pid }));

  if (mode === "idle-diagnostic") await observeIdle();
  else {
  if (!await runCase("native-host-exit", async detail => {
    detail.before = await runtimeIdentity();
    detail.recovery = await checkNativeHostRestart({ connect, fixtureURL, worker, until, saveDetail: value => { detail.recovery = value; return save("native-host-recovery-detail.json", value); }, restartHost: async () => {
      const previous = endpoint, identity = await processIdentity(previous); await save("kill-identity.json", identity.process);
      const killed = JSON.parse(await subprocess("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(runDir, "terminate-native.ps1"), path.join(runDir, "kill-identity.json")]));
      // Expose the previously missing selector while its original deadline is
      // live, before waiting for automatic reconnect. This is fixture DOM only.
      const late = await worker.evaluate("(async()=>{const tabId=globalThis.__recoveryJournal.tabIds[0];const values=await chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:()=>{const b=document.createElement('button');b.id='late-action';b.textContent='Late action';b.onclick=()=>globalThis.lateClicks++;document.body.append(b);return{lateClicks}}});return{tabId,values,at:Date.now()}})()");
      const old = await waitOldHostGone(previous, { cleanEOF: false }), next = await waitHost(previous, "automatic reconnect via production alarm/timer");
      // The original click has a 15-second deadline and was already pending
      // before this kill. Keep its document/late target alive beyond that entire
      // budget, including time after a new host has connected.
      await delay(Math.max(0, killed.requestedAt + 15250 - Date.now()));
      return { previous, identity, killed, late, old, next, observedThrough: Date.now() };
    } });
    detail.after = await runtimeIdentity();
    for (const key of ["browserPid", "browserId", "workerTarget", "contextId", "incarnation", "extensionInstanceId", "observerTarget"]) assert.equal(detail.after[key], detail.before[key]);
    assertNoNewFocusEvents(detail.before.focus, detail.after.focus); assert.equal(detail.recovery.after.documentId, detail.recovery.before.documentId);
    for (const type of ["pointerup", "keyup"]) assert.equal(detail.recovery.after.events.filter(value => value.type === type && value.trusted && (type !== "keyup" || value.key === "Shift")).length, 1);
    assert.ok(detail.recovery.restart.observedThrough >= detail.recovery.preDisconnect.deadline + 250, "No-replay observation ended before the old click deadline");
    detail.recovery.replayOpportunityMs = detail.recovery.preDisconnect.deadline - detail.recovery.restart.late.at;
    assert.ok(detail.recovery.replayOpportunityMs >= 1000, "No meaningful original-deadline replay opportunity");
  })) throw new Error("Native host recovery failed; refusing to obscure it with later scenarios");

  if (!await runCase("native-extension-reload", async detail => {
    const value = await artifacts("reload"); detail.original = { ...value, owner: undefined, producer: undefined, task: { id: value.task.id }, output: { id: value.output.id } };
    await worker.evaluate(`(()=>{const original=chrome.debugger.sendCommand;globalThis.__nativePendingQuery=false;chrome.debugger.sendCommand=function(target,method,params){if(target.tabId===${value.task.id}&&method==='Runtime.callFunctionOn'&&JSON.stringify(params).includes('Never replay this pending browser action'))globalThis.__nativePendingQuery=true;return original.call(chrome.debugger,target,method,params)}})()`);
    detail.pendingSubmittedAt = Date.now(); detail.pendingDeadlineMs = 20000; let outcome;
    const pending = value.task.getByRole("button", { name: "Never replay this pending browser action", exact: true }).click({ timeoutMs: detail.pendingDeadlineMs }).then(result => (outcome = { result, settledAt: Date.now() }), error => (outcome = { error: error.message, settledAt: Date.now() }));
    await until(() => worker.evaluate("__nativePendingQuery"), "actual native pending locator"); assert.equal(outcome, undefined); detail.pendingObservedAt = Date.now();
    detail.reload = {}; await reload(detail.reload); await preserve(value, detail);
    detail.pending = await bounded(pending, 1000, "native EOF settles original SDK request"); assert.equal(typeof detail.pending.error, "string"); assert.doesNotMatch(detail.pending.error, /timed out|timeout|20000ms exceeded/i);
    assert.ok(detail.pending.settledAt - detail.reload.requestedAt < 10000, "EOF did not promptly settle the original SDK request");
    await worker.evaluate(`chrome.scripting.executeScript({target:{tabId:${value.task.id}},world:'MAIN',func:()=>{const b=document.createElement('button');b.textContent='Never replay this pending browser action';b.onclick=()=>{lateClicks++;fetch('/witness?marker='+encodeURIComponent(new URL(location.href).searchParams.get('marker'))+'&kind=late',{method:'POST'})};document.body.append(b)}})`);
    detail.lateTargetExposedAt = Date.now(); detail.replayOpportunityMs = detail.pendingSubmittedAt + detail.pendingDeadlineMs - detail.lateTargetExposedAt; assert.ok(detail.replayOpportunityMs >= 1000, "No meaningful original-deadline replay opportunity");
    await explicitRecovery(value, detail);
    await delay(Math.max(0, detail.pendingSubmittedAt + detail.pendingDeadlineMs + 250 - Date.now()));
    detail.observedThrough = Date.now(); detail.afterDeadline = await pageState(value.task.id);
    detail.witnessesAfterDeadline = witnesses.filter(item => item.marker === new URL(value.taskIdentity.url).searchParams.get("marker"));
    assert.ok(detail.observedThrough >= detail.pendingSubmittedAt + detail.pendingDeadlineMs + 250);
    assert.equal(detail.afterDeadline.documentId, value.taskPage.documentId);
    assert.equal(detail.afterDeadline.lateClicks, 0);
    assert.deepEqual(detail.witnessesAfterDeadline.map(item => ({ method: item.method, kind: item.kind })), [{ method: "POST", kind: "explicit" }]);
  })) throw new Error("Native extension reload failed; refusing to obscure it with later scenarios");

  await runCase("native-paused-reload", async detail => {
    const value = await artifacts("paused"); detail.original = { oldScope: value.oldScope, taskPage: value.taskPage, outputPage: value.outputPage };
    const beforePopup = await openPopup(); try { detail.paused = await popupStatus(beforePopup, { action: "pause" }); } finally { await closePopup(beforePopup); }
    detail.reload = {}; await reload(detail.reload); await preserve(value, detail);
    const retained = await openPopup(); detail.retainedPopup = { original: retained.original, targetId: retained.targetId, focusAfterOpen: retained.afterOpen };
    try {
      detail.afterReload = await popupStatus(retained, { state: "paused" }); assert.equal(detail.afterReload.inputBlocked, true); assert.equal(detail.afterReload.cleanupComplete, true);
      const next = await connect(value.oldScope.session_id); detail.blockedErrors = {}; const beforeWitnesses = [...witnesses];
      for (const [name, action] of [["beginTurn", () => next.client.beginTurn()], ["create", () => next.client.createTab()], ["claim", () => next.client.claimUserTab(value.task.id)], ["fill", () => next.tab(value.task.id).getByLabel("Name").fill("must remain paused")], ["raw", () => next.client.request("executeCdp", { ...value.oldScope, target: { tabId: value.task.id }, method: "Runtime.evaluate", commandParams: { expression: "document.querySelector('#name').value='must not run'" } })]]) await assert.rejects(action(), error => { detail.blockedErrors[name] = error.message; return /OBU_AUTOMATION_PAUSED/.test(error.message); });
      await preserve(value, detail); assert.deepEqual(witnesses, beforeWitnesses); detail.resumed = await popupStatus(retained, { action: "resume" });
    } finally { await closePopup(retained); }
    await explicitRecovery(value, detail);
  });
  }
} catch (error) { report.error = error.stack; console.error(error); }
finally {
  if (settingsManager && report.installation?.fullInventory) { try { report.finalExtensionInventory = await extensionInventory("before-browser-teardown"); } catch (error) { report.finalExtensionInventoryError = error.message; } }
  if (observer) {
    try {
      const value = await focus(), sentinel = await observer.evaluate(`chrome.tabs.get(${report.sentinel.id}).then(({id,windowId,active})=>({id,windowId,active}))`);
      Object.assign(report.focus, focusArrays(value), { observationComplete: true, coverageEndedAt: value.at, finalSentinel: sentinel });
      ledger.assertAllowed(value, report.focus.allowedActivations, report.focus.allowedFocus);
      assert.equal(sentinel.active, true); assert.equal(sentinel.windowId, report.sentinel.windowId); report.focus.finalValidation = "passed";
    } catch (error) { report.focus.finalValidation = "failed"; report.focus.error = error.stack; }
  }
  for (const client of clients) client.close();
  if (control) {
    try { report.browserProcessesBeforeClose = await control.call("SystemInfo.getProcessInfo"); } catch (error) { report.browserProcessInventoryError = error.message; }
    try { await control.call("Browser.close"); } catch (error) { diagnostics.push({ phase: "Browser.close", error: error.message }); }
  }
  if (child) { try { await bounded(childExit, 15000, "private browser exit"); } catch (error) { report.browserCleanupError = error.message; child.kill(); try { await bounded(childExit, 10000, "forced private browser exit"); } catch (second) { diagnostics.push({ phase: "forced browser exit", error: second.message }); } } }
  worker?.close(); observer?.close(); settingsManager?.close(); control?.close();
  if (child) {
    try {
      const ids = new Set([child.pid, ...(report.browserProcessesBeforeClose?.processInfo ?? []).map(value => value.id)]);
      report.browserProcessesGone = await until(async () => { const alive = (await processTable()).filter(value => ids.has(value.ProcessId)); return !alive.length && { checkedPids: [...ids], remaining: alive, observedAt: Date.now() }; }, "all observed private browser processes exited", 15000);
    } catch (error) { report.browserProcessCleanupError = error.message; }
  }
  try {
    const alive = await until(async () => { const values = await processTable(); const owned = values.filter(value => value.ExecutablePath && path.win32.resolve(value.ExecutablePath).toLowerCase() === path.win32.resolve(nativeExecutable ?? host).toLowerCase()); return !owned.length && { ownedProcesses: owned, observedAt: Date.now() }; }, "all private native host processes exited", 10000);
    report.nativeCleanup = { ...alive, endpointRecords: await endpointRecords(), ...(endpoint && { lastHost: await waitOldHostGone(endpoint, { cleanEOF: true }) }) };
  } catch (error) { report.nativeCleanupError = error.message; }
  if (subprocessChildren.size) {
    const pendingChildren = [...subprocessChildren];
    for (const task of pendingChildren) { try { task.kill(); } catch {} }
    try { await until(() => !subprocessChildren.size, "tracked fixture helper processes exited", 10000); } catch (error) { report.helperCleanupError = error.message; }
  }
  if (registryAttempted && !subprocessChildren.size) { try { report.registrationCleanup = JSON.parse(await subprocess("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", registryScript, "cleanup"])); } catch (error) { report.registrationCleanupError = error.message; } }
  else if (registryAttempted) report.registrationCleanupError = "A fixture helper remains live; registry cleanup withheld to avoid a late create/cleanup race";
  server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve));
  await fs.writeFile(path.join(runDir, "browser.log"), browserLogs.join(""));
  for (const name of ["chrome_debug.log", "debug.log"]) { try { await fs.copyFile(path.join(profile, name), path.join(runDir, name)); } catch (error) { if (error.code !== "ENOENT") diagnostics.push({ phase: "log copy", error: error.message }); } }
  const outcome = nativeLifecycleOutcome(report); report.passed = outcome.passed; report.exitCode = outcome.exitCode;
  if (report.diagnostic) { report.diagnostic.complete = outcome.diagnosticComplete; await save("idle-diagnostic.json", report.diagnostic); console.log("DIAGNOSTIC", JSON.stringify({ complete: report.diagnostic.complete, focusValidation: report.focus.finalValidation, acceptancePassed: false })); }
  report.completedAt = Date.now(); await save("results.json", report); console.log("RESULT", path.join(runDir, "results.json")); process.exitCode = outcome.exitCode;
}
