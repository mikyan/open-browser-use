import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { chromium } from "playwright";
import WebSocket, { WebSocketServer } from "ws";
import { buildChromeExtension } from "../build-chrome-extension.mjs";
import { NativeHostBridge, nativeAdapterSource } from "./native-host-bridge.mjs";
import { browserStartupOptions, resolveFieldTrialConfig } from "./browser-startup.mjs";
import { FocusLedger, assertQuietObserverSetup, currentWorkerVersion, focusArrays, focusObserverHTML, focusObserverSource, focusSnapshotExpression, installFocusObserver, readFocusEvidence } from "./focus-ledger.mjs";
import { allBrowserRestartCasesPassed, assertBrowserReplacement, assertHeldNativeInput, assertIndependentFocusSegments, assertNoNewFocusEvents, assertNoRestoredOwnership, assertRestoredFixtureDocument, assertRestoredTabPreserved, assertSamePopupDocument, assertUnconfirmedInputBlocked, browserRestartCases, popupUIReflectsStatus, restartFixtureHTML } from "./browser-restart-support.mjs";

// Opt-in runner. This file never participates in unit tests and never launches
// a user's browser/profile. Only the caller running this command starts Chrome.
const directory = path.dirname(fileURLToPath(import.meta.url)), repo = path.resolve(directory, "../..");
const policy = resolveFieldTrialConfig(process.env.OBU_TEST_FIELD_TRIAL_CONFIG);
assert.ok(process.env.OBU_TEST_HOST_BINARY, "Set OBU_TEST_HOST_BINARY to the built native host");
const sourceHost = path.resolve(process.env.OBU_TEST_HOST_BINARY);
await fs.access(sourceHost);
const artifactRoot = path.join(repo, ".tmp/browser-integration");
await fs.mkdir(artifactRoot, { recursive: true });
const runDir = await fs.mkdtemp(path.join(artifactRoot, "browser-restart-"));
const profile = path.join(runDir, "profile"), extension = path.join(runDir, "extension");
const hostFile = path.join(runDir, process.platform === "win32" ? "native-host.exe" : "native-host");
await fs.copyFile(sourceHost, hostFile);
const jsSnapshot = path.join(runDir, "js-sdk");
await fs.cp(path.join(repo, "packages/open-browser-use-js/dist"), jsSnapshot, { recursive: true });
const { connectOpenBrowserUse } = await import(pathToFileURL(path.join(jsSnapshot, "index.js")));
const temporaryRoot = await fs.realpath(os.tmpdir()), socketDir = await fs.mkdtemp(path.join(temporaryRoot, "obu-restart-"));
const records = [], generations = [], gaps = [], clients = new Set(), witnesses = [], hostLog = [], browserLog = [];
const report = { scope: "actual same-profile headed browser process restart with explicit --restore-last-session and staged native Port adapter; not native host installation, preference persistence or uninterrupted focus coverage", expectedCases: browserRestartCases,
  profileConfiguration: { sessionRestoration: { source: "command-line", argument: "--restore-last-session", appliesToEveryGeneration: true, preferencesWrittenByRunner: false } },
  records, generations, restartGaps: gaps, serverWitnesses: witnesses };
let bridge, current, fixtureURL, fatalBridgeError, shuttingDown = false;
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const writeJSON = (name, value) => fs.writeFile(path.join(runDir, name), JSON.stringify(value, null, 2));
async function until(check, label, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs; let lastError;
  while (Date.now() < deadline) {
    if (fatalBridgeError) throw fatalBridgeError;
    try { const value = await check(); if (value) return value; } catch (error) { lastError = error; }
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ""}`);
}
async function bounded(promise, timeoutMs, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs); })]); }
  finally { clearTimeout(timer); }
}
async function treeHashes(root) {
  const files = {};
  async function visit(relative = "") {
    for (const item of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
      const name = path.join(relative, item.name);
      if (item.isDirectory()) await visit(name);
      else if (item.isFile()) files[name.replaceAll(path.sep, "/")] = hash(await fs.readFile(path.join(root, name)));
    }
  }
  await visit(); return files;
}
async function cdp(url) {
  const socket = new WebSocket(url), pending = new Map(), events = []; let id = 0;
  await bounded(new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); }), 10000, "test CDP connect");
  const fail = error => { for (const task of pending.values()) { clearTimeout(task.timer); task.reject(error); } pending.clear(); };
  socket.on("error", fail); socket.on("close", () => fail(new Error("Test CDP transport closed")));
  socket.on("message", raw => {
    let message;
    try { message = JSON.parse(raw.toString()); } catch (error) { fail(error); return; }
    if (message.method) events.push(message);
    const task = pending.get(message.id); if (!task) return;
    pending.delete(message.id); clearTimeout(task.timer);
    message.error ? task.reject(new Error(JSON.stringify(message.error))) : task.resolve(message.result);
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    if (socket.readyState !== WebSocket.OPEN) { reject(new Error("Test CDP transport closed")); return; }
    const requestId = ++id, timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`Test CDP ${method} timed out`)); }, 20000);
    pending.set(requestId, { resolve, reject, timer });
    socket.send(JSON.stringify({ id: requestId, method, params }));
  });
  return { call, events, close: () => { fail(new Error("Test CDP closed by fixture")); socket.close(); },
    evaluate: async expression => {
      const value = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (value.exceptionDetails) throw new Error(JSON.stringify(value.exceptionDetails));
      return value.result.value;
    } };
}
const http = createServer((request, response) => {
  const url = new URL(request.url, "http://localhost");
  if (url.pathname === "/witness") { witnesses.push({ at: Date.now(), method: request.method, marker: url.searchParams.get("marker"), kind: url.searchParams.get("kind") }); response.end("ok"); return; }
  if (url.pathname === "/lifecycle" || url.pathname === "/sentinel") { response.setHeader("Content-Type", "text/html; charset=utf-8"); response.end(restartFixtureHTML(url)); return; }
  response.writeHead(404); response.end();
});
const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
async function snapshot(generation) {
  return readFocusEvidence(generation.ledger, generation.record.focus, () => generation.observer.evaluate(focusSnapshotExpression));
}
async function assertFocus(generation) {
  const value = await snapshot(generation);
  const active = await generation.observer.evaluate(`chrome.tabs.query({active:true,windowId:${generation.record.sentinel.windowId}})`);
  assert.equal(active[0]?.id, generation.record.sentinel.id, "Agent changed this browser generation's sentinel");
  generation.ledger.assertAllowed(value, generation.record.focus.allowedActivations, generation.record.focus.allowedFocus);
  return value;
}
async function sealFocus(generation) {
  if (!generation?.observer || generation.record.focus.sealed) return;
  const evidence = generation.record.focus;
  try {
    const value = await assertFocus(generation);
    evidence.finalValidation = "passed"; evidence.coverageEndedAt = value.at;
    Object.assign(evidence, focusArrays(value));
  } catch (error) { evidence.finalValidation = "failed"; evidence.error = error.stack; throw error; }
  finally { evidence.sealed = true; await writeJSON(`focus-${generation.record.generation}.json`, evidence); }
}
async function inventory(generation = current) {
  return generation.worker.evaluate("(async()=>({tabs:await chrome.tabs.query({}),groups:await chrome.tabGroups.query({}),windows:await chrome.windows.getAll()}))()");
}
async function tabMetadata(tabId) {
  const value = await inventory(), tab = value.tabs.find(item => item.id === tabId);
  return { at: Date.now(), tab, group: value.groups.find(group => group.id === tab?.groupId) };
}
const pageURL = marker => fixtureURL + "lifecycle?marker=" + encodeURIComponent(marker);
async function pageState(tabId) {
  const values = await current.worker.evaluate(`chrome.scripting.executeScript({target:{tabId:${tabId}},world:'MAIN',func:()=>({documentToken,clicks:[...clicks],lateClicks,name:document.querySelector('#name').value})})`);
  assert.equal(values.length, 1); assert.equal(values[0].frameId, 0);
  assert.equal(typeof values[0].documentId, "string");
  return { ...values[0].result, documentId: values[0].documentId };
}
// A fixed synthetic-page read, never SDK attach/reattach or page input. Keep the
// original document/capture observable after the worker loses its live tracker.
async function nativeInputState(tabId) {
  const values = await current.worker.evaluate(`chrome.scripting.executeScript({target:{tabId:${tabId}},world:'MAIN',func:()=>{
    const held=document.querySelector('#held'),down=inputEvents.find(event=>event.type==='pointerdown'&&event.target==='held'),rect=held.getBoundingClientRect();
    return {documentToken,inputEvents:[...inputEvents],heldCapture:!!down&&held.hasPointerCapture(down.pointerId),point:{x:rect.x+rect.width/2,y:rect.y+rect.height/2},name:document.querySelector('#name').value};
  }})`);
  assert.equal(values.length, 1); assert.equal(values[0].frameId, 0);
  assert.equal(typeof values[0].documentId, "string");
  return { ...values[0].result, documentId: values[0].documentId };
}
async function lifetimeMarker() {
  const value = await current.worker.evaluate("chrome.storage.session.get('OPEN_BROWSER_USE_BROWSER_LIFETIME').then(value=>value.OPEN_BROWSER_USE_BROWSER_LIFETIME)");
  assert.equal(value?.version, 1); assert.equal(typeof value.incarnation, "string"); assert.ok(value.incarnation.length > 0);
  return value;
}
async function exposeLateAction(tabId) {
  await current.worker.evaluate(`chrome.scripting.executeScript({target:{tabId:${tabId}},world:'MAIN',func:()=>{
    const button=document.createElement('button');button.textContent='Never replay this pending browser action';
    button.onclick=()=>{lateClicks++;fetch('/witness?marker='+encodeURIComponent(new URL(location.href).searchParams.get('marker'))+'&kind=late',{method:'POST'})};document.body.append(button);
  }})`);
}
async function connect(sessionId) {
  const browser = await connectOpenBrowserUse({ socketPath: bridge.endpoint, sessionId, timeoutMs: 15000 });
  clients.add(browser); return browser;
}
const scope = browser => ({ session_id: browser.client.sessionId, turn_id: browser.client.turnId, control_epoch: browser.client.controlEpoch });
async function stale(client, captured, detail, label) {
  await assert.rejects(client.client.request("getTabs", captured), error => {
    detail[label] = error.message; return /OBU_STALE_CONTROL_EPOCH|OBU_CONTROL_BOOTSTRAP_REQUIRED/.test(error.message);
  });
}

let binary, binarySha256, startup;
async function launchBrowser() {
  const generation = { record: { generation: generations.length + 1, profile, startedAt: Date.now(), binary, binarySha256, args: [...startup.args], focus: { allowedActivations: [], allowedFocus: [], finalValidation: "not-started" } }, ledger: new FocusLedger(), plannedClose: false };
  current = generation; generations.push(generation.record);
  generation.record.host = await bridge.start();
  const portFile = path.join(profile, "DevToolsActivePort");
  // Only this runner's exact file, after the previous process exit. Do not
  // modify extension storage or the profile's restored window/session data.
  await fs.rm(portFile, { force: true });
  const child = spawn(binary, startup.args, { windowsHide: startup.windowsHide, stdio: ["ignore", "ignore", "pipe"] });
  generation.child = child; generation.record.pid = child.pid;
  generation.exited = new Promise(resolve => {
    child.once("exit", (code, signal) => {
      Object.assign(generation.record, { exitedAt: Date.now(), exitCode: code, exitSignal: signal });
      if (!generation.plannedClose && !shuttingDown) generation.record.unexpectedExit = true;
      resolve({ code, signal });
    });
    child.once("error", error => { generation.record.spawnError = error.message; resolve({ error: error.message }); });
  });
  child.stderr.on("data", data => browserLog.push(`[generation ${generation.record.generation}] ${data}`));
  generation.debugPort = await until(async () => (await fs.readFile(portFile, "utf8")).split("\n")[0], "new DevToolsActivePort");
  const browserVersion = await until(async () => (await fetch(`http://127.0.0.1:${generation.debugPort}/json/version`)).json(), "new browser endpoint");
  generation.record.browserId = new URL(browserVersion.webSocketDebuggerUrl).pathname;
  generation.record.version = browserVersion;
  generation.control = await cdp(browserVersion.webSocketDebuggerUrl);
  generation.record.processesAtStart = await generation.control.call("SystemInfo.getProcessInfo");
  assert.ok(generation.record.processesAtStart.processInfo.some(item => item.type === "browser" && item.id === child.pid), "Spawned PID is not the actual browser root process");
  await bridge.waitForConnection();
  generation.extensionId = bridge.extensionId;
  const targets = () => fetch(`http://127.0.0.1:${generation.debugPort}/json/list`).then(value => value.json());
  generation.targets = targets;
  const target = await until(async () => (await targets()).find(value => value.type === "service_worker" && value.url === `chrome-extension://${generation.extensionId}/background.js`), "new extension worker");
  generation.worker = await cdp(target.webSocketDebuggerUrl); generation.record.workerTarget = target.id;
  const infoClient = await connect("browser-lifetime-inspection");
  try { generation.record.extensionInstanceId = (await infoClient.client.getInfo()).metadata.extensionInstanceId; }
  finally { infoClient.close(); clients.delete(infoClient); }
  assert.equal(typeof generation.record.extensionInstanceId, "string");
  generation.record.beforeSetup = await inventory(generation);
  // Restored test observers are not reused or mistaken for continuous logs.
  const observerURL = `chrome-extension://${generation.extensionId}/integration-observer.html`;
  for (const restored of (await targets()).filter(value => value.type === "page" && value.url === observerURL)) await generation.control.call("Target.closeTarget", { targetId: restored.id });
  generation.record.sentinel = await generation.worker.evaluate(`chrome.tabs.create({url:${JSON.stringify(fixtureURL + "sentinel?marker=generation-" + generation.record.generation)},active:true})`);
  await generation.worker.evaluate(`(${installFocusObserver.toString()})(chrome,globalThis,'setup-${generation.record.generation}');`);
  generation.observerId = (await generation.control.call("Target.createTarget", { url: observerURL, background: true })).targetId;
  const observerTarget = await until(async () => (await targets()).find(value => value.id === generation.observerId), "new independent focus observer");
  generation.observer = await cdp(observerTarget.webSocketDebuggerUrl);
  await until(() => generation.observer.evaluate("globalThis.__integrationFocusLedger?.snapshot().ready===true"), "new focus observer ready");
  const initial = await snapshot(generation);
  generation.record.focus.setupWorker = await generation.worker.evaluate(focusSnapshotExpression);
  assertQuietObserverSetup(generation.record.focus.setupWorker, initial);
  generation.record.focus.coverageStartedAt = initial.at;
  await writeJSON(`browser-${generation.record.generation}.json`, generation.record);
  return generation;
}

async function stopBrowser(generation, { final = false } = {}) {
  if (!generation) return;
  let failure;
  try { await sealFocus(generation); } catch (error) { failure = error; }
  generation.plannedClose = true;
  generation.record.closeRequestedAt = Date.now();
  try {
    if (generation.control && !generation.record.exitedAt) {
      try { generation.record.processesBeforeClose = await generation.control.call("SystemInfo.getProcessInfo"); }
      catch (error) { generation.record.processInventoryError = error.message; failure ??= error; }
      try { generation.record.closeReply = await bounded(generation.control.call("Browser.close"), 10000, "Browser.close"); }
      catch (error) { generation.record.closeReplyError = error.message; }
    }
    if (generation.child && !generation.record.exitedAt) {
      try { await bounded(generation.exited, 15000, "actual browser exit"); }
      catch (error) {
        generation.record.forcedTeardown = true;
        generation.child.kill();
        await bounded(generation.exited, 5000, "forced private browser exit");
        failure ??= error; // Teardown is not a successful graceful restart.
      }
    }
    if (!final) assert.ok(generation.record.exitedAt && !generation.record.forcedTeardown && !generation.record.spawnError, "No successful actual browser exit");
    const knownPids = [...new Set((generation.record.processesBeforeClose?.processInfo ?? generation.record.processesAtStart?.processInfo ?? [])
      .map(item => item.id).filter(pid => Number.isSafeInteger(pid) && pid > 0))];
    assert.ok(!knownPids.includes(process.pid), "Browser process inventory incorrectly included the runner");
    if (knownPids.length) {
      const remaining = () => knownPids.filter(pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; } });
      try { await until(() => remaining().length === 0, "known private browser processes exited", 10000); }
      finally { generation.record.processExitProbe = { at: Date.now(), knownPids, remaining: remaining() }; }
    }
    const oldHost = bridge.current;
    await bridge.stopGeneration(oldHost, false);
    generation.record.hostFinal = structuredClone(oldHost?.record);
  } finally {
    generation.worker?.close(); generation.observer?.close(); generation.control?.close();
    await writeJSON(`browser-${generation.record.generation}.json`, generation.record);
  }
  if (failure) throw failure;
}
async function restartBrowser(reason) {
  const previous = current;
  const gap = { reason, previousGeneration: previous.record.generation, beginsAt: Date.now(), coverage: "no focus observer survives whole-browser exit; not continuous zero-focus evidence" };
  gaps.push(gap);
  await stopBrowser(previous);
  gap.beginsAt = previous.record.focus.coverageEndedAt;
  gap.browserExitedAt = previous.record.exitedAt;
  const next = await launchBrowser();
  gap.nextGeneration = next.record.generation; gap.endsAt = next.record.focus.coverageStartedAt;
  assertBrowserReplacement(previous.record, next.record);
  return { previousGeneration: previous.record.generation, nextGeneration: next.record.generation, gap };
}

let popupSequence = 0;
async function openControlPopup() {
  const generation = current, before = await snapshot(generation);
  generation.ledger.assertAllowed(before, generation.record.focus.allowedActivations, generation.record.focus.allowedFocus);
  await generation.worker.evaluate(`chrome.action.openPopup({windowId:${generation.record.sentinel.windowId}})`);
  const popupURL = `chrome-extension://${generation.extensionId}/popup.html`;
  const contexts = await until(async () => {
    const value = await generation.worker.evaluate("chrome.runtime.getContexts({contextTypes:['POPUP']})");
    return value.some(item => item.documentUrl === popupURL) && value;
  }, "real trusted popup");
  const after = await snapshot(generation);
  generation.record.focus.allowedFocus.push(...generation.ledger.allowActionPopup(before, after, { windowId: generation.record.sentinel.windowId, popupURL, reason: "intentional harness action popup for persisted Pause verification",
    popupContexts: contexts.map(item => ({ type: item.contextType, windowId: generation.record.sentinel.windowId, documentId: item.documentId, documentUrl: item.documentUrl })) }));
  const target = await until(async () => (await generation.targets()).find(item => item.url === popupURL), "trusted popup CDP target");
  const popup = await cdp(target.webSocketDebuggerUrl);
  const original = contexts.find(context => context.documentUrl === popupURL);
  assertSamePopupDocument(original, contexts);
  return { generation, popup, original, afterOpen: after, closed: false,
    evidence: { targetId: target.id, originalContext: original, focusAfterOpen: after, checkpoints: [] } };
}

async function retainedPopupCheckpoint(session, label) {
  assert.equal(session.closed, false, "The retained popup was already closed");
  const evidence = { label, at: Date.now() };
  session.evidence.checkpoints.push(evidence);
  evidence.contexts = await session.generation.worker.evaluate("chrome.runtime.getContexts({contextTypes:['POPUP']})");
  evidence.windows = await session.generation.worker.evaluate("chrome.windows.getAll()");
  evidence.focus = await assertFocus(session.generation);
  assertSamePopupDocument(session.original, evidence.contexts);
  assertNoNewFocusEvents(session.afterOpen, evidence.focus);
  evidence.target = (await session.popup.call("Target.getTargetInfo")).targetInfo;
  assert.equal(evidence.target.targetId, session.evidence.targetId, "The retained popup CDP target changed");
  assert.equal(evidence.target.url, session.original.documentUrl);
  return evidence;
}

async function closeControlPopup(session, { verifyFocus = false } = {}) {
  if (session.closed) return;
  const evidence = session.evidence.close = { requestedAt: Date.now() };
  try { await session.popup.evaluate("window.close()"); }
  catch (error) { evidence.replyError = error.message; }
  finally { session.popup.close(); }
  if (verifyFocus) {
    await until(async () => {
      evidence.contexts = await session.generation.worker.evaluate("chrome.runtime.getContexts({contextTypes:['POPUP']})");
      return !evidence.contexts.some(context => context.documentId === session.original.documentId);
    }, "original retained popup document closed", 5000);
    evidence.focus = await assertFocus(session.generation);
    assertNoNewFocusEvents(session.afterOpen, evidence.focus);
  }
  evidence.completedAt = Date.now(); session.closed = true;
}

async function popupStatus({ toggle, waitState, session: retained } = {}) {
  const session = retained ?? await openControlPopup();
  const { generation, popup } = session;
  try {
    if (retained) await retainedPopupCheckpoint(session, `before-${toggle ?? waitState ?? "status"}`);
    const read = () => popup.evaluate("chrome.runtime.sendMessage({type:'GET_AUTOMATION_CONTROL_STATUS'})");
    let value = await read(); assert.equal(value.ok, true, JSON.stringify(value));
    if (waitState) value = await until(async () => { const next = await read(); return next.ok && next.status.state === waitState && next; }, `trusted popup initial ${waitState}`);
    const initialStatus = value.status;
    let buttonBefore = null;
    if (toggle) {
      assert.ok(["pause", "retry", "resume"].includes(toggle));
      const wanted = toggle === "resume" ? "running" : "paused";
      assert.notEqual(value.status.state, wanted, "Popup toggle precondition does not match the requested user action");
      await until(() => popup.evaluate("document.querySelector('#automation-toggle')?.disabled===false"), "popup control enabled");
      buttonBefore = await until(async () => {
        const button = await popup.evaluate("(()=>{const button=document.querySelector('#automation-toggle');return {text:button?.textContent.trim(),disabled:button?.disabled}})()");
        return button.text === ({ pause: "Pause all agents", retry: "Retry pause", resume: "Resume control" })[toggle] && !button.disabled && button;
      }, `actual popup ${toggle} button`);
      if (toggle === "retry") assertUnconfirmedInputBlocked(initialStatus);
      await popup.evaluate("document.querySelector('#automation-toggle').click()");
      value = await until(async () => { const next = await read(); return next.ok && next.status.state === wanted && (wanted !== "paused" || next.status.cleanupComplete) && next; }, `trusted popup ${wanted}`);
    }
    // The worker can acknowledge a state before the popup's polling/rendering
    // catches up. Capture the actual terminal UI, not just a fresh RPC status.
    const renderedUI = await until(async () => {
      const ui = await popup.evaluate("(()=>{const button=document.querySelector('#automation-toggle');return {state:document.querySelector('#automation-status-pill')?.dataset.state,label:document.querySelector('#automation-status-label')?.textContent.trim(),buttonText:button?.textContent.trim(),buttonDisabled:button?.disabled,message:document.querySelector('#automation-message')?.textContent.trim(),error:document.querySelector('#automation-error')?.textContent.trim()}})()");
      return popupUIReflectsStatus(value.status, ui) && { ...ui, observedAt: Date.now() };
    }, `rendered popup ${value.status.state} label and enabled button`);
    const png = await popup.call("Page.captureScreenshot", { format: "png" });
    const bytes = Buffer.from(png.data, "base64");
    assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const name = `popup-generation-${generation.record.generation}-${++popupSequence}-${value.status.state}.png`;
    await fs.writeFile(path.join(runDir, name), bytes);
    const checkpoint = retained ? await retainedPopupCheckpoint(session, `after-${value.status.state}-screenshot`) : null;
    return { ...value.status, initialStatus, buttonBefore, renderedUI, popupContexts: checkpoint?.contexts ?? [session.original], popupDocument: { contextId: session.original.contextId, documentId: session.original.documentId, targetId: session.evidence.targetId },
      screenshot: { file: name, bytes: bytes.length, sha256: hash(bytes), width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) } };
  } finally { if (!retained) await closeControlPopup(session); }
}

async function createArtifacts(tag) {
  const task = await connect(`restart-task-${tag}`), producer = await connect(`restart-output-${tag}`);
  const owned = await task.newTab({ url: pageURL(`task-${tag}`) }); await task.client.nameSession(`Restart task ${tag}`);
  await owned.domSnapshot();
  const output = await producer.newTab({ url: pageURL(`deliverable-${tag}`) }); await producer.client.nameSession(`Restart output ${tag}`);
  await producer.client.finalizeTabs([{ tabId: output.id, status: "deliverable" }]);
  const before = await inventory();
  const taskTab = before.tabs.find(tab => tab.id === owned.id), outputTab = before.tabs.find(tab => tab.id === output.id);
  assert.ok(taskTab.groupId >= 0 && outputTab.groupId >= 0); assert.notEqual(taskTab.groupId, outputTab.groupId);
  assert.equal(before.groups.find(group => group.id === taskTab.groupId)?.title, `Restart task ${tag}`);
  return { task, producer, owned, output, taskScope: scope(task), idleScope: scope(producer), before, taskPage: await pageState(owned.id), outputPage: await pageState(output.id) };
}
async function restoredArtifacts(tag, detail) {
  const readiness = detail.restorationReadiness = { startedAt: Date.now(), polls: 0, readErrors: [] };
  return until(async () => {
    const value = await inventory();
    readiness.polls++; readiness.lastObservedAt = Date.now(); readiness.lastInventory = value;
    const task = value.tabs.filter(tab => tab.url === pageURL(`task-${tag}`)), output = value.tabs.filter(tab => tab.url === pageURL(`deliverable-${tag}`));
    assert.ok(task.length <= 1 && output.length <= 1, "Ambiguous restored fixture pages");
    if (task.length !== 1 || output.length !== 1 || task[0].status !== "complete" || task[0].discarded) return false;
    const documents = [];
    for (const tab of [task[0]]) {
      try {
        // Session restore exposes URL metadata before a renderer exists. Only
        // observe readiness; do not activate, reload, navigate, claim or create.
        const results = await current.worker.evaluate(`chrome.scripting.executeScript({target:{tabId:${tab.id}},world:'MAIN',func:()=>({url:location.href,readyState:document.readyState,documentToken:globalThis.documentToken,hasFixture:!!document.querySelector('#name')&&!!document.querySelector('#action')})})`);
        assertRestoredFixtureDocument(tab, tab.url, results);
        documents.push({ tabId: tab.id, ...results[0] });
      } catch (error) {
        if (readiness.readErrors.length < 20) readiness.readErrors.push({ at: Date.now(), tabId: tab.id, error: error.message });
        return false;
      }
    }
    readiness.documents = documents;
    readiness.outputObservation = { mode: "tab/group metadata only; no claim of a loaded deliverable DOM", tabId: output[0].id, status: output[0].status };
    readiness.completedAt = Date.now();
    return { task: task[0], output: output[0], inventory: value };
  }, "actual loaded HTTP task document and restored deliverable tab metadata", 30000);
}
async function exerciseRecovery(captured, restored, detail) {
  const next = await connect(captured.taskScope.session_id), idle = await connect(captured.idleScope.session_id);
  await stale(next, captured.taskScope, detail, "staleActiveEpoch"); await stale(idle, captured.idleScope, detail, "staleIdleEpoch");
  await next.client.beginTurn(); await idle.client.beginTurn();
  detail.newEpoch = next.client.controlEpoch; assert.ok(detail.newEpoch > captured.taskScope.control_epoch);
  detail.ownedAfterBegin = await next.getTabs(); detail.idleOwnedAfterBegin = await idle.getTabs();
  assertNoRestoredOwnership(detail.ownedAfterBegin, [restored.task, restored.output], "task");
  assertNoRestoredOwnership(detail.idleOwnedAfterBegin, [restored.task, restored.output], "deliverable");
  await assert.rejects(next.tab(restored.task.id).getByLabel("Name").fill("must not be implicitly owned"), error => {
    detail.unclaimedError = error.message; return /not part of browser session|ownership/i.test(error.message);
  });
  const prior = await pageState(restored.task.id); assert.equal(prior.name, ""); assert.equal(prior.lateClicks, 0);
  const outputMarker = new URL(restored.output.url).searchParams.get("marker");
  const outputBefore = await tabMetadata(restored.output.id);
  detail.outputPreservation = { mode: "tab/group metadata and server mutation witnesses; unloaded DOM is not inspected", before: outputBefore,
    witnessesBefore: witnesses.filter(value => value.marker === outputMarker) };
  await assert.rejects(idle.tab(restored.output.id).getByLabel("Name").fill("must not implicitly own deliverable"), error => {
    detail.unclaimedOutputError = error.message; return /not part of browser session|ownership/i.test(error.message);
  });
  await idle.client.finalizeTabs([]);
  detail.outputPreservation.after = await tabMetadata(restored.output.id);
  detail.outputPreservation.witnessesAfter = witnesses.filter(value => value.marker === outputMarker);
  assertRestoredTabPreserved(outputBefore, detail.outputPreservation.after);
  assert.deepEqual(detail.outputPreservation.witnessesAfter, detail.outputPreservation.witnessesBefore, "Old deliverable cleanup caused a server-side mutation");
  await next.client.claimUserTab(restored.task.id);
  await next.tab(restored.task.id).getByLabel("Name").fill("explicitly claimed after lifetime change");
  await next.tab(restored.task.id).getByRole("button", { name: "Explicit action", exact: true }).click();
  detail.afterClaim = await pageState(restored.task.id);
  assert.equal(detail.afterClaim.name, "explicitly claimed after lifetime change");
  assert.deepEqual(detail.afterClaim.clicks, [{ trusted: true }]); assert.equal(detail.afterClaim.lateClicks, 0);
  const marker = new URL(restored.task.url).searchParams.get("marker");
  await until(() => witnesses.filter(item => item.marker === marker && item.kind === "explicit").length >= 1, "explicit trusted action server witness");
  detail.serverWitnesses = witnesses.filter(item => item.marker === marker);
  assert.deepEqual(detail.serverWitnesses.map(item => ({ method: item.method, kind: item.kind })), [{ method: "POST", kind: "explicit" }]);
  return next;
}
async function runCase(name, action) {
  const record = { name, passed: false, startedAt: Date.now(), detail: {} }; records.push(record);
  try { await action(record.detail); await assertFocus(current); record.passed = true; console.log("PASS", name); }
  catch (error) { record.error = error.stack; console.error("FAIL", name, error.message); }
  finally { record.elapsedMs = Date.now() - record.startedAt; await writeJSON(`${name}.json`, record); await writeJSON("results.json", report); }
}

try {
  await new Promise(resolve => http.listen(0, "127.0.0.1", resolve)); fixtureURL = `http://127.0.0.1:${http.address().port}/`;
  if (!server.address()) await new Promise(resolve => server.once("listening", resolve));
  const websocketURL = `ws://127.0.0.1:${server.address().port}`;
  await buildChromeExtension(extension);
  const production = await treeHashes(extension), backgroundPath = path.join(extension, "background.js"), background = await fs.readFile(backgroundPath, "utf8"), nativeCall = "chrome.runtime.connectNative(this.hostName)";
  assert.equal(background.split(nativeCall).length, 2);
  await fs.writeFile(backgroundPath, nativeAdapterSource(websocketURL) + background.replace(nativeCall, "__integrationConnectNative(this.hostName)"));
  const manifestPath = path.join(extension, "manifest.json"), manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  manifest.content_security_policy.extension_pages = manifest.content_security_policy.extension_pages.replace("connect-src 'self'", `connect-src 'self' ${websocketURL}`);
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  await fs.writeFile(path.join(extension, "integration-observer.html"), focusObserverHTML); await fs.writeFile(path.join(extension, "integration-observer.js"), focusObserverSource);
  await fs.mkdir(profile, { recursive: true });
  binary = path.resolve(process.env.OBU_TEST_CHROMIUM_BINARY || chromium.executablePath()); binarySha256 = hash(await fs.readFile(binary));
  startup = browserStartupOptions([`--user-data-dir=${profile}`, "--remote-debugging-port=0", `--disable-extensions-except=${extension}`, `--load-extension=${extension}`, "--restore-last-session", "--no-first-run", "--no-default-browser-check", "--site-per-process", "--no-sandbox", "--enable-logging=stderr"], policy);
  report.sourceIdentity = { gitHead: (await promisify(execFile)("git", ["rev-parse", "HEAD"], { cwd: repo, windowsHide: true })).stdout.trim(),
    dirty: (await promisify(execFile)("git", ["status", "--porcelain", "--untracked-files=normal"], { cwd: repo, windowsHide: true })).stdout.trim().length > 0,
    testHooks: ["staged native Port WebSocket adapter", "independent staged focus observer per browser process", "exact synthetic pending locator native command observation", "independent observer exact synthetic-tab onRemoved journal and fixed synthetic-page input-state reads"],
    sha256: { host: hash(await fs.readFile(hostFile)), jsDist: await treeHashes(jsSnapshot), productionExtension: production, stagedExtension: await treeHashes(extension),
      harness: hash(await fs.readFile(fileURLToPath(import.meta.url))), helper: hash(await fs.readFile(path.join(directory, "browser-restart-support.mjs"))), nativeBridge: hash(await fs.readFile(path.join(directory, "native-host-bridge.mjs"))), browserStartup: hash(await fs.readFile(path.join(directory, "browser-startup.mjs"))), focusLedger: hash(await fs.readFile(path.join(directory, "focus-ledger.mjs"))) } };
  bridge = new NativeHostBridge({ server, executable: hostFile, socketDir, log: text => hostLog.push(text), onFailure: error => { fatalBridgeError = error; } });
  console.log("HARNESS", JSON.stringify({ runDir, fixtureURL, profile }));
  await launchBrowser();

  await runCase("browser-restart-unpaused", async detail => {
    const artifacts = await createArtifacts("A");
    Object.assign(detail, { taskScope: artifacts.taskScope, idleScope: artifacts.idleScope, before: artifacts.before, taskPage: artifacts.taskPage, outputPage: artifacts.outputPage });
    const startedAt = Date.now();
    await current.worker.evaluate(`(()=>{const original=chrome.debugger.sendCommand;globalThis.__restartPendingNative={seen:false};chrome.debugger.sendCommand=function(target,method,params){if(target.tabId===${artifacts.owned.id}&&method==='Runtime.callFunctionOn'&&JSON.stringify(params).includes('Never replay this pending browser action'))globalThis.__restartPendingNative.seen=true;return original.call(chrome.debugger,target,method,params)}})()`);
    const pending = artifacts.owned.getByRole("button", { name: "Never replay this pending browser action", exact: true }).click({ timeoutMs: 120000 }).then(value => ({ value, settledAt: Date.now() }), error => ({ error: error.message, settledAt: Date.now() }));
    detail.pendingSubmittedAt = startedAt;
    await until(() => current.worker.evaluate("__restartPendingNative.seen"), "actual native pending locator query before browser exit");
    detail.pendingNativeQueryObservedAt = Date.now();
    detail.restart = await restartBrowser("unpaused browser lifetime");
    detail.pending = await bounded(pending, 5000, "old browser request settlement");
    assert.equal(typeof detail.pending.error, "string");
    const restored = await restoredArtifacts("A", detail); detail.restored = restored;
    await exposeLateAction(restored.task.id);
    detail.numericTabIdIntersections = [artifacts.owned.id, artifacts.output.id].filter(id => restored.inventory.tabs.some(tab => tab.id === id));
    detail.numericGroupIdIntersections = artifacts.before.groups.map(group => group.id).filter(id => restored.inventory.groups.some(group => group.id === id));
    detail.collisionLimit = "Observed intersections only; deterministic reused-ID safety requires backend unit coverage";
    await exerciseRecovery(artifacts, restored, detail);
  });

  if (current?.worker && !current.record.exitedAt) await runCase("browser-restart-paused", async detail => {
    const artifacts = await createArtifacts("B");
    detail.taskScope = artifacts.taskScope; detail.before = artifacts.before;
    detail.paused = await popupStatus({ toggle: "pause" });
    assert.equal(detail.paused.inputBlocked, true); assert.equal(detail.paused.cleanupComplete, true);
    detail.restart = await restartBrowser("persisted user Pause");
    detail.afterRestart = await popupStatus();
    assert.equal(detail.afterRestart.state, "paused"); assert.equal(detail.afterRestart.inputBlocked, true);
    assert.ok(detail.afterRestart.revision >= detail.paused.revision);
    const restored = await restoredArtifacts("B", detail); detail.restored = restored;
    detail.pausedPreservation = { taskBefore: await tabMetadata(restored.task.id), outputBefore: await tabMetadata(restored.output.id), witnessesBefore: [...witnesses] };
    const next = await connect(artifacts.taskScope.session_id);
    detail.pausedErrors = {};
    for (const [name, operation] of [["bootstrap", () => next.client.beginTurn()], ["create", () => next.client.createTab()], ["claim", () => next.client.claimUserTab(restored.task.id)], ["fill", () => next.tab(restored.task.id).getByLabel("Name").fill("must remain paused")], ["raw", () => next.client.request("executeCdp", { ...artifacts.taskScope, target: { tabId: restored.task.id }, method: "Runtime.evaluate", commandParams: { expression: "document.querySelector('#name').value='must not run'" } })]]) {
      await assert.rejects(operation(), error => { detail.pausedErrors[name] = error.message; return /OBU_AUTOMATION_PAUSED/.test(error.message); });
    }
    assert.equal((await pageState(restored.task.id)).name, "");
    Object.assign(detail.pausedPreservation, { taskAfter: await tabMetadata(restored.task.id), outputAfter: await tabMetadata(restored.output.id), witnessesAfter: [...witnesses] });
    assertRestoredTabPreserved(detail.pausedPreservation.taskBefore, detail.pausedPreservation.taskAfter);
    assertRestoredTabPreserved(detail.pausedPreservation.outputBefore, detail.pausedPreservation.outputAfter);
    assert.deepEqual(detail.pausedPreservation.witnessesAfter, detail.pausedPreservation.witnessesBefore, "Rejected paused actions caused a server-side mutation");
    detail.resumed = await popupStatus({ toggle: "resume" });
    await exerciseRecovery(artifacts, restored, detail);
  });

  if (current?.worker && !current.record.exitedAt) await runCase("same-browser-session-state-loss", async detail => {
    const artifacts = await createArtifacts("C");
    detail.taskScope = artifacts.taskScope; detail.idleScope = artifacts.idleScope; detail.before = artifacts.before;
    const generation = current, before = await assertFocus(generation);
    const oldTarget = generation.record.workerTarget, oldSocket = bridge.socket;
    detail.browserBefore = { pid: generation.child.pid, browserId: generation.record.browserId };
    detail.storageSessionKeysBefore = await generation.worker.evaluate("chrome.storage.session.get(null).then(value=>Object.keys(value).sort())");
    await generation.worker.evaluate("chrome.storage.session.clear()");
    detail.storageSessionKeysAfterClear = await generation.worker.evaluate("chrome.storage.session.get(null).then(value=>Object.keys(value).sort())");
    assert.deepEqual(detail.storageSessionKeysAfterClear, []);
    await generation.observer.call("ServiceWorker.enable");
    const workerURL = `chrome-extension://${generation.extensionId}/background.js`;
    const version = await until(() => currentWorkerVersion(generation.observer.events, { url: workerURL, targetId: oldTarget }), "same-browser worker version");
    generation.worker.close();
    await generation.observer.call("ServiceWorker.stopWorker", { versionId: version.versionId });
    await generation.observer.call("ServiceWorker.startWorker", { scopeURL: `chrome-extension://${generation.extensionId}/` });
    const target = await until(async () => (await generation.targets()).find(value => value.type === "service_worker" && value.url === workerURL && value.id !== oldTarget), "same-browser replacement worker");
    generation.worker = await cdp(target.webSocketDebuggerUrl);
    await until(() => bridge.socket && bridge.socket !== oldSocket, "same-browser native Port replacement"); await bridge.waitForConnection();
    detail.worker = { oldTarget, newTarget: target.id };
    detail.browserAfter = { pid: generation.child.pid, browserId: new URL((await (await fetch(`http://127.0.0.1:${generation.debugPort}/json/version`)).json()).webSocketDebuggerUrl).pathname };
    assert.deepEqual(detail.browserAfter, detail.browserBefore); assert.equal(generation.child.exitCode, null);
    const after = await assertFocus(generation); assert.equal(after.identity, before.identity);
    detail.focusInterval = { identity: after.identity, beforeSequence: before.events.length, afterSequence: after.events.length };
    detail.restored = { task: (await inventory()).tabs.find(tab => tab.id === artifacts.owned.id), output: (await inventory()).tabs.find(tab => tab.id === artifacts.output.id) };
    assert.ok(detail.restored.task && detail.restored.output, "Session-state loss removed live user pages");
    await exerciseRecovery(artifacts, detail.restored, detail);
    detail.classification = "storage.session cleared, same browser PID and browser CDP identity; real worker replacement; not extension reload or full browser restart";
  });

  if (current?.worker && !current.record.exitedAt) await runCase("worker-input-state-loss", async detail => {
    const generation = current, beforeFocus = await assertFocus(generation);
    const task = await connect("worker-held-input"), tab = await task.newTab({ url: pageURL("held-before-worker-restart") });
    let heldPopup;
    const save = async stage => {
      detail.stage = stage; (detail.stages ??= []).push({ stage, at: Date.now() });
      await writeJSON("worker-input-state-loss-evidence.json", detail);
    };
    detail.originalTabId = tab.id;
    detail.browserBefore = { pid: generation.child.pid, browserId: generation.record.browserId };
    detail.markerBefore = await lifetimeMarker();
    // The independent observer survives the worker stop and records the native
    // onRemoved event. This is not inferred from a replacement tracker's state.
    await generation.observer.evaluate(`(()=>{globalThis.__restartRemovedTabEvents=[];chrome.tabs.onRemoved.addListener((tabId,removeInfo)=>{if(tabId===${tab.id})globalThis.__restartRemovedTabEvents.push({at:Date.now(),tabId,windowId:removeInfo.windowId,isWindowClosing:removeInfo.isWindowClosing})})})()`);
    try {
      detail.beforeInput = await nativeInputState(tab.id);
      const point = detail.beforeInput.point;
      await task.cdp.call(tab.id, "Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
      await task.cdp.call(tab.id, "Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", buttons: 1, clickCount: 1 });
      await task.cdp.call(tab.id, "Input.dispatchKeyEvent", { type: "keyDown", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, modifiers: 8 });
      detail.oldScope = scope(task);
      detail.heldBeforeRestart = await nativeInputState(tab.id);
      assertHeldNativeInput(detail.heldBeforeRestart);
      await save("trusted-native-input-held");

      const workerURL = `chrome-extension://${generation.extensionId}/background.js`;
      const oldTargets = (await generation.targets()).filter(value => value.type === "service_worker" && value.url === workerURL);
      assert.equal(oldTargets.length, 1);
      const oldTarget = oldTargets[0].id, oldSocket = bridge.socket;
      await generation.observer.call("ServiceWorker.enable");
      const version = await until(() => currentWorkerVersion(generation.observer.events, { url: workerURL, targetId: oldTarget }), "held-input original worker version");
      detail.worker = { oldTarget, version, stopRequestedAt: Date.now() };
      generation.worker.close();
      await generation.observer.call("ServiceWorker.stopWorker", { versionId: version.versionId });
      detail.worker.stopCompletedAt = Date.now();
      await generation.observer.call("ServiceWorker.startWorker", { scopeURL: `chrome-extension://${generation.extensionId}/` });
      const target = await until(async () => (await generation.targets()).find(value => value.type === "service_worker" && value.url === workerURL && value.id !== oldTarget), "held-input replacement worker");
      generation.worker = await cdp(target.webSocketDebuggerUrl);
      Object.assign(detail.worker, { newTarget: target.id, connectedAt: Date.now() });
      await until(() => bridge.socket && bridge.socket !== oldSocket, "held-input replacement native Port"); await bridge.waitForConnection();
      detail.browserAfter = { pid: generation.child.pid, browserId: new URL((await (await fetch(`http://127.0.0.1:${generation.debugPort}/json/version`)).json()).webSocketDebuggerUrl).pathname };
      assert.deepEqual(detail.browserAfter, detail.browserBefore); assert.equal(generation.child.exitCode, null);
      detail.markerAfter = await lifetimeMarker();
      assert.deepEqual(detail.markerAfter, detail.markerBefore, "Worker-only restart changed the browser session marker");
      detail.heldAfterRestart = await nativeInputState(tab.id);
      assertHeldNativeInput(detail.heldAfterRestart, detail.heldBeforeRestart);
      await save("same-browser-worker-replaced-input-still-held");

      heldPopup = await openControlPopup(); detail.retainedPopup = heldPopup.evidence;
      detail.failedStatus = await popupStatus({ waitState: "error", session: heldPopup });
      assertUnconfirmedInputBlocked(detail.failedStatus);
      const next = await connect(detail.oldScope.session_id);
      detail.blockedErrors = {};
      for (const [name, action] of [
        ["bootstrap", () => next.client.beginTurn()],
        ["fill", () => next.client.request("browserAction", { ...detail.oldScope, tabId: tab.id, action: "fill", locator: [{ kind: "label", value: "Name" }], args: { value: "must stay blocked" }, timeoutMs: 1000 })]
      ]) await assert.rejects(action(), error => { detail.blockedErrors[name] = error.message; return /OBU_AUTOMATION_PAUSED|OBU_INPUT_RELEASE_UNCONFIRMED/.test(error.message); });
      detail.heldAfterRejectedActions = await nativeInputState(tab.id);
      assertHeldNativeInput(detail.heldAfterRejectedActions, detail.heldBeforeRestart);
      assert.equal(detail.heldAfterRejectedActions.name, "");
      assert.deepEqual(await generation.observer.evaluate("__restartRemovedTabEvents"), []);
      await retainedPopupCheckpoint(heldPopup, "blocked-actions-before-original-tab-removal");
      await save("replacement-blocks-actions-without-claiming-release");

      detail.removeRequestedAt = Date.now();
      await generation.worker.evaluate(`chrome.tabs.remove(${tab.id})`);
      detail.removeCompletedAt = Date.now();
      detail.removalEvents = await until(async () => {
        const events = await generation.observer.evaluate("__restartRemovedTabEvents");
        return events.length > 0 && events;
      }, "native onRemoved for the exact original held-input tab");
      assert.equal(detail.removalEvents.length, 1); assert.equal(detail.removalEvents[0].tabId, tab.id);
      assert.equal(detail.removalEvents[0].isWindowClosing, false);
      assert.ok(detail.removalEvents[0].at >= detail.removeRequestedAt);
      detail.tabsAfterRemoval = (await inventory()).tabs;
      assert.equal(detail.tabsAfterRemoval.some(value => value.id === tab.id), false);
      await retainedPopupCheckpoint(heldPopup, "original-tab-removed");
      await save("original-target-destruction-observed");

      detail.retryPaused = await popupStatus({ toggle: "retry", waitState: "error", session: heldPopup });
      assert.equal(detail.retryPaused.state, "paused"); assert.equal(detail.retryPaused.inputBlocked, true); assert.equal(detail.retryPaused.cleanupComplete, true);
      assert.deepEqual(detail.retryPaused.popupDocument, detail.failedStatus.popupDocument);
      await save("real-popup-retry-cleanup-complete");
      detail.resumed = await popupStatus({ toggle: "resume", session: heldPopup });
      assert.equal(detail.resumed.state, "running"); assert.equal(detail.resumed.inputBlocked, false);
      assert.deepEqual(detail.resumed.popupDocument, detail.failedStatus.popupDocument);
      await closeControlPopup(heldPopup, { verifyFocus: true });
      await save("same-popup-resume-complete-and-closed-without-focus-events");
      await stale(next, detail.oldScope, detail, "oldEpochAfterResume");
      await next.client.beginTurn(); detail.newScope = scope(next);
      assert.ok(detail.newScope.control_epoch > detail.oldScope.control_epoch);
      const fresh = await next.newTab({ url: pageURL("explicit-after-worker-input-recovery") });
      await fresh.getByLabel("Name").fill("explicit fresh turn after original target closed");
      await fresh.getByRole("button", { name: "Explicit action", exact: true }).click();
      detail.newTabId = fresh.id; detail.freshPage = await pageState(fresh.id);
      assert.equal(detail.freshPage.name, "explicit fresh turn after original target closed");
      assert.deepEqual(detail.freshPage.clicks, [{ trusted: true }]); assert.equal(detail.freshPage.lateClicks, 0);
      await until(() => witnesses.some(value => value.marker === "explicit-after-worker-input-recovery"), "fresh-turn trusted click server witness");
      detail.serverWitnesses = witnesses.filter(value => value.marker === "explicit-after-worker-input-recovery");
      assert.deepEqual(detail.serverWitnesses.map(value => ({ method: value.method, kind: value.kind })), [{ method: "POST", kind: "explicit" }]);
      const afterFocus = await assertFocus(generation);
      assert.equal(afterFocus.identity, beforeFocus.identity);
      assertNoNewFocusEvents(heldPopup.afterOpen, afterFocus);
      detail.focusInterval = { identity: afterFocus.identity, beforeSequence: beforeFocus.events.length, afterSequence: afterFocus.events.length };
      detail.classification = "Same browser and session marker, real worker replacement; held native input remained on the original document until its native onRemoved event. Recovery retained one real Failed popup document through Retry pause and Resume, then explicitly began a new turn; no tracker-empty release inference or added focus allowance after popup opening.";
      await save("explicit-new-turn-trusted-action-succeeded");
    } finally {
      // Failure teardown only: never send a compensating key/mouse release or
      // count tab cleanup here as proof that the asserted recovery succeeded.
      try {
        if ((await inventory()).tabs.some(value => value.id === tab.id)) {
          detail.failureTeardown = { tabId: tab.id, at: Date.now() };
          await generation.worker.evaluate(`chrome.tabs.remove(${tab.id})`);
        }
      } catch (error) { detail.failureTeardownError = error.message; }
      if (heldPopup && !heldPopup.closed) {
        try { await closeControlPopup(heldPopup, { verifyFocus: true }); }
        catch (error) { detail.popupTeardownError = error.message; }
      }
      await writeJSON("worker-input-state-loss-evidence.json", detail);
    }
  });
} catch (error) { records.push({ name: "fatal", passed: false, error: error.stack }); console.error(error); }
finally {
  shuttingDown = true;
  for (const browser of clients) browser.close();
  try { await stopBrowser(current, { final: true }); } catch (error) { records.push({ name: "browser-cleanup-or-final-focus", passed: false, error: error.stack }); }
  try { await bridge?.close(); } catch (error) { records.push({ name: "host-cleanup", passed: false, error: error.stack }); }
  try { assertIndependentFocusSegments(generations.map(generation => generation.focus)); } catch (error) { records.push({ name: "focus-segments", passed: false, error: error.stack }); }
  for (const socket of server.clients) socket.terminate(); await new Promise(resolve => server.close(resolve));
  await new Promise(resolve => http.close(resolve));
  report.nativeHostGenerations = bridge?.generations; report.completedAt = Date.now(); report.passed = allBrowserRestartCasesPassed(records);
  await writeJSON("results.json", report); await fs.writeFile(path.join(runDir, "host.log"), hostLog.join("")); await fs.writeFile(path.join(runDir, "chromium.log"), browserLog.join(""));
  const resolved = await fs.realpath(socketDir); assert.equal(resolved, socketDir); assert.equal(path.dirname(resolved), temporaryRoot); assert.ok(path.basename(resolved).startsWith("obu-restart-")); assert.equal((await fs.lstat(resolved)).isSymbolicLink(), false);
  await fs.rm(resolved, { recursive: true, force: true });
  console.log("RESULT", path.join(runDir, "results.json")); process.exitCode = report.passed ? 0 : 1;
}
