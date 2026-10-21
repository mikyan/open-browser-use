// One original A -> B -> Back task through the frozen managed launcher and SDK.
// The exact worker observer records native events and reads original documents;
// it never sends page/debugger commands, repairs an attachment or replays input.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createManagedOopifBfcacheFixture, readManagedOopifBfcacheDocument, assessManagedOopifBfcacheDocuments, assertManagedOopifBfcacheReceipt } from "./managed-oopif-bfcache-fixture.mjs";
import { parseManagedReadyOutput, assertManagedStopReply } from "./managed-download-check.mjs";
import { assertManagedViewerTerminal } from "./managed-viewer-check.mjs";
import { connectNormalCDP, managedProcess, runProcess, bound, poll } from "./normal-browser-downloads-support.mjs";
import { verifyNormalBinding } from "./normal-browser-downloads-proof.mjs";
import { waitPrivateDevToolsEndpoint } from "./private-devtools-endpoint.mjs";
import { observedProcessDescendants } from "./observed-process-descendants.mjs";
import { managedHumanSourceFiles } from "./managed-human-source-snapshot.mjs";
import { listenFixture } from "./fixture-listener.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const redact = text => String(text).replace(/(#ticket=)[A-Za-z0-9_-]+/g, "$1[redacted]");
const serialize = value => JSON.stringify(value, (_key, item) => typeof item === "string" ? redact(item) : item, 2);
const processQuery = "@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,ExecutablePath,@{n='CreationDate';e={$_.CreationDate.ToUniversalTime().ToString('o')}}) | ConvertTo-Json -Compress";
const workerIdentity = "({extensionId:chrome.runtime.id,version:chrome.runtime.getManifest().version,binding:globalThis.__obuNativeDownloadBinding})";
const resourceQuery = String.raw`$ErrorActionPreference='Stop'
$scope=$env:OBU_BFCACHE_RESOURCE_PROBE | ConvertFrom-Json
$keys=@()
foreach($view in @([Microsoft.Win32.RegistryView]::Registry32,[Microsoft.Win32.RegistryView]::Registry64)) {
  $base=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser,$view);$key=$null
  try {$key=$base.OpenSubKey(('Software\Google\Chrome\NativeMessagingHosts\'+$scope.host),$false);$keys+=@{view=$view.ToString();absent=($null -eq $key)}} finally {if($null -ne $key){$key.Close()};$base.Close()}
}
$present=@([IO.Directory]::GetFiles('\\.\pipe\') | Where-Object {$scope.pipes -contains $_})
@{registration=$keys;presentOriginalPipes=$present} | ConvertTo-Json -Compress -Depth 5`;

function inside(root, file) {
  const relative = path.relative(root, file);
  assert.ok(relative && !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`), "Expected original private path");
  return relative.replaceAll("\\", "/");
}
async function treeHashes(root) {
  const entries = await fs.readdir(root, { recursive: true, withFileTypes: true });
  assert.ok(entries.every(entry => !entry.isSymbolicLink()));
  const files = entries.filter(entry => entry.isFile()).map(entry => path.join(entry.parentPath, entry.name)).sort();
  return Object.fromEntries(await Promise.all(files.map(async file => [inside(root, file), hash(await fs.readFile(file))])));
}

// Observe original events and command settlements without enabling domains,
// attaching a target, or sending any additional command. The non-async wrapper
// returns the exact original value/Promise and rethrows the exact original error.
export function installManagedOopifBfcacheObserver(chrome, target) {
  if (target.__managedOopifBfcacheObservation) throw Error("Observer already installed");
  const events = [], commands = [], observationErrors = []; let overflow = false, stopped = false, stoppedAt = null, pendingAtStop = [], observedOrder = 0;
  const debuggerAPI = chrome.debugger, originalSend = debuggerAPI.sendCommand;
  const originalDescriptor = Object.getOwnPropertyDescriptor(debuggerAPI, "sendCommand");
  if (typeof originalSend !== "function" || originalDescriptor && !("value" in originalDescriptor)) throw Error("Original debugger command function is unavailable");
  const errorSummary = error => ({ name: typeof error?.name === "string" ? error.name.slice(0, 128) : typeof error,
    message: typeof error?.message === "string" ? error.message.slice(0, 2048) : String(error).slice(0, 2048) });
  const fault = (phase, error) => {
    // Observation failure must never change original native control flow.
    try { if (observationErrors.length < 16) observationErrors.push({ phase, at: Date.now(), ...errorSummary(error) }); else overflow = true; }
    catch { overflow = true; }
  };
  const ownValue = (value, name) => value && typeof value === "object" ? Object.getOwnPropertyDescriptor(value, name)?.value : undefined;
  function nativeTree(tree, depth = 0, budget = { nodes: 0 }) {
    if (++budget.nodes > 128 || depth > 16) throw Error("Native frame tree observation limit");
    const frame = ownValue(tree, "frame"); if (!frame) throw Error("Native frame tree lacks frame");
    const result = { frame: {} };
    for (const name of ["id", "parentId", "loaderId"]) {
      const value = ownValue(frame, name);
      if (value !== undefined) { if (typeof value !== "string" || value.length > 256) throw Error("Invalid native frame identity"); result.frame[name] = value; }
    }
    const children = ownValue(tree, "childFrames");
    if (children !== undefined) { if (!Array.isArray(children) || children.length > 128) throw Error("Invalid native child frame inventory"); result.childFrames = children.map(child => nativeTree(child, depth + 1, budget)); }
    return result;
  }
  function settle(row, state, value) {
    // Stop exports an immutable terminal snapshot. Pending command identities
    // are explicit and fail acceptance; their later ACKs are not invented.
    if (!row || stopped) return;
    try {
      row.state = state; row.settledOrder = ++observedOrder; row.settledAt = Date.now();
      if (state === "rejected" || state === "threw") row.error = errorSummary(value);
      else if (row.method === "Page.getFrameTree") {
        const tree = ownValue(value, "frameTree"); row.frameTree = tree ? nativeTree(tree) : null;
      }
    } catch (error) { fault("command-settlement", error); }
  }
  function observedSendCommand(...args) {
    let row;
    if (!stopped) try {
      if (commands.length >= 1024) overflow = true;
      else {
        row = { sequence: commands.length + 1, startedOrder: ++observedOrder, startedAt: Date.now(), state: "pending", method: typeof args[1] === "string" ? args[1].slice(0, 256) : "<non-string>", target: {} };
        commands.push(row);
        for (const name of ["tabId", "sessionId", "targetId"]) {
          const value = ownValue(args[0], name);
          if (value !== undefined) {
            if (name === "tabId" ? !Number.isSafeInteger(value) : typeof value !== "string" || value.length > 256) throw Error("Invalid original command target observation");
            row.target[name] = value;
          }
        }
        if (args[1] === "Page.setLifecycleEventsEnabled") row.enabled = ownValue(args[2], "enabled");
      }
    } catch (error) { fault("command-start", error); }
    let result;
    try { result = Reflect.apply(originalSend, this, args); }
    catch (error) { settle(row, "threw", error); throw error; }
    try {
      if (result !== null && (typeof result === "object" || typeof result === "function") && typeof result.then === "function") {
        if (row) row.returnKind = "promise";
        // Use the native Promise observer without chaining or replacing the
        // Promise returned to the original caller. Callbacks never throw.
        Reflect.apply(Promise.prototype.then, result, [value => settle(row, "fulfilled", value), error => settle(row, "rejected", error)]);
      } else { if (row) row.returnKind = "synchronous"; settle(row, "returned", result); }
    } catch (error) { fault("command-observer-attachment", error); }
    return result;
  }
  Object.defineProperty(debuggerAPI, "sendCommand", originalDescriptor ? { ...originalDescriptor, value: observedSendCommand } : { value: observedSendCommand, configurable: true, enumerable: true, writable: true });
  if (debuggerAPI.sendCommand !== observedSendCommand) throw Error("Native command observer was not installed");
  const methods = new Set(["Target.attachedToTarget", "Target.detachedFromTarget", "Target.targetInfoChanged",
    "Page.frameAttached", "Page.frameDetached", "Page.frameNavigated", "Page.lifecycleEvent", "Page.backForwardCacheNotUsed",
    "Runtime.executionContextCreated", "Runtime.executionContextDestroyed", "Runtime.executionContextsCleared"]);
  const listener = (source, method, params) => {
    if (stopped) return;
    if (!methods.has(method)) return;
    if (events.length >= 2048) { overflow = true; return; }
    try { events.push({ sequence: events.length + 1, observedOrder: ++observedOrder, at: Date.now(), source: structuredClone(source), method, params: structuredClone(params) }); }
    catch (error) { fault("native-event", error); }
  };
  chrome.debugger.onEvent.addListener(listener);
  const snapshot = () => ({ events: structuredClone(events), commands: structuredClone(commands), observationErrors: structuredClone(observationErrors), overflow, stopped, stoppedAt, pendingAtStop: [...pendingAtStop] });
  let sendCommandRestored = false;
  target.__managedOopifBfcacheObservation = {
    snapshot,
    stop() {
      if (!stopped) {
        chrome.debugger.onEvent.removeListener(listener);
        pendingAtStop = commands.filter(row => row.state === "pending").map(row => row.sequence);
        stoppedAt = Date.now(); stopped = true;
        try {
          if (debuggerAPI.sendCommand !== observedSendCommand) throw Error("Native command observer was externally replaced");
          if (originalDescriptor) Object.defineProperty(debuggerAPI, "sendCommand", originalDescriptor);
          else delete debuggerAPI.sendCommand;
          sendCommandRestored = debuggerAPI.sendCommand === originalSend;
          if (!sendCommandRestored) throw Error("Original native command function was not restored");
        } catch (error) { fault("command-observer-stop", error); }
      }
      return { ...snapshot(), listenerPresent: chrome.debugger.onEvent.hasListener(listener), sendCommandRestored };
    }
  };
  return { installed: true, methods: [...methods], nativeCommandObservation: true, limits: { events: 2048, commands: 1024, frameNodes: 128, frameDepth: 16 } };
}

export function originalManagedOopifNativeIdentity(observation, tabId, urls) {
  assert.equal(observation.overflow, false);
  const events = observation.events.filter(row => row.source.tabId === tabId);
  const root = events.findLast(row => row.method === "Page.frameNavigated" && !row.source.sessionId && row.params.frame?.url === urls.root);
  const leaf = events.findLast(row => row.method === "Page.frameNavigated" && row.source.sessionId && row.params.frame?.url === urls.leaf);
  assert.ok(root?.params.frame.id && root.params.frame.loaderId, "Original root native frame/loader missing");
  assert.ok(leaf?.params.frame.id && leaf.params.frame.loaderId, "Original child native frame/loader missing");
  const attached = events.findLast(row => row.method === "Target.attachedToTarget" && row.params.sessionId === leaf.source.sessionId && row.params.targetInfo?.type === "iframe");
  assert.ok(attached?.params.targetInfo.targetId, "Cross-origin URLs alone do not establish native OOPIF ownership");
  assert.equal(attached.params.targetInfo.targetId, leaf.params.frame.id);
  assert.equal(leaf.params.frame.parentId, root.params.frame.id);
  return { tabId, root: { frameId: root.params.frame.id, loaderId: root.params.frame.loaderId, eventSequence: root.sequence },
    leaf: { frameId: leaf.params.frame.id, loaderId: leaf.params.frame.loaderId, sessionId: leaf.source.sessionId, targetId: attached.params.targetInfo.targetId, origin: new URL(urls.leaf).origin, eventSequence: leaf.sequence, attachSequence: attached.sequence } };
}

export function assessManagedOopifNativeReturn(observation, original, afterSequence) {
  assert.equal(observation.overflow, false);
  const events = observation.events.filter(row => row.source.tabId === original.tabId && row.sequence > afterSequence);
  const restore = events.find(row => row.method === "Page.frameNavigated" && !row.source.sessionId && row.params.type === "BackForwardCacheRestore" && row.params.frame?.id === original.root.frameId);
  const attached = events.filter(row => row.method === "Target.attachedToTarget" && row.params.targetInfo?.type === "iframe" && row.params.targetInfo.targetId === original.leaf.targetId);
  const contexts = events.filter(row => row.method === "Runtime.executionContextCreated" && row.params.context?.auxData?.frameId === original.leaf.frameId);
  const sessions = new Map(), liveContexts = new Map();
  const clearSession = sessionId => { for (const [key, row] of liveContexts) if (row.source.sessionId === sessionId) liveContexts.delete(key); };
  for (const row of observation.events.filter(item => item.source.tabId === original.tabId)) {
    const sessionId = row.source.sessionId, params = row.params;
    if (row.method === "Target.attachedToTarget") sessions.set(params.sessionId, row);
    if (row.method === "Target.detachedFromTarget") { sessions.delete(params.sessionId); clearSession(params.sessionId); }
    if (row.method === "Runtime.executionContextsCleared") clearSession(sessionId);
    if (row.method === "Runtime.executionContextCreated") liveContexts.set(`${sessionId ?? "root"}/${params.context.id}`, row);
    if (row.method === "Runtime.executionContextDestroyed") for (const [key, context] of liveContexts) {
      if (context.source.sessionId === sessionId && (context.params.context.id === params.executionContextId ||
          params.executionContextUniqueId && context.params.context.uniqueId === params.executionContextUniqueId)) liveContexts.delete(key);
    }
  }
  const liveLeafSessions = [...sessions.values()].filter(row => row.params.targetInfo?.type === "iframe" && row.params.targetInfo.targetId === original.leaf.targetId);
  const liveLeafContexts = [...liveContexts.values()].filter(row => typeof row.params.context.uniqueId === "string" && row.params.context.uniqueId.length > 0 && row.params.context.auxData?.frameId === original.leaf.frameId && row.params.context.auxData.isDefault === true &&
    row.params.context.origin === original.leaf.origin && liveLeafSessions.some(attachment => attachment.params.sessionId === row.source.sessionId));
  const leafFrame = events.findLast(row => row.method === "Page.frameNavigated" && row.params.frame?.id === original.leaf.frameId && liveLeafContexts.some(context => context.source.sessionId === row.source.sessionId));
  const restoredLeafFrameLoaderVerified = !!leafFrame && leafFrame.params.frame.loaderId === original.leaf.loaderId && leafFrame.params.frame.parentId === original.root.frameId;
  // Session/context validity follows the actual event stream, including detach,
  // clear and destroy. Absence of a fresh leaf frame event is recorded explicitly;
  // old loader data is never relabelled as a new native observation.
  return { originalRootRestoreVerified: !!restore && restore.params.frame.loaderId === original.root.loaderId,
    restoredOopifContextVerified: liveLeafSessions.length === 1 && liveLeafContexts.length === 1,
    rootRestore: restore ?? null, leafAttachments: attached, leafContexts: contexts, liveLeafSessions, liveLeafContexts,
    returnedLeafFrame: leafFrame ?? null, restoredLeafFrameLoaderVerified,
    notObserved: leafFrame ? [] : ["returned-leaf-native-frame-loader-parent"] };
}

export async function runManagedOopifBfcacheCheck() {
  assert.equal(process.platform, "win32");
  const executable = process.env.OBU_TEST_HOST_BINARY, chromium = process.env.OBU_TEST_CHROMIUM_BINARY;
  const extension = process.env.OBU_TEST_EXTENSION_DIR, buildFile = process.env.OBU_TEST_BUILD_MANIFEST;
  for (const file of [executable, chromium, extension, buildFile]) { assert.ok(typeof file === "string" && path.isAbsolute(file), "Explicit frozen runtime and build manifest required"); await fs.access(file); }
  await fs.mkdir(path.join(repo, ".tmp/browser-integration"), { recursive: true });
  const runDir = await fs.mkdtemp(path.join(repo, ".tmp/browser-integration/mof-"));
  const root = path.join(runDir, "r"), name = "n", snapshot = path.join(runDir, "source-snapshot");
  const extensionInput = path.join(runDir, "extension-input"), sdkInput = path.join(runDir, "sdk-input");
  const report = { runDir, startedAt: Date.now(), commands: [], probes: [], steps: [], actions: [], cleanup: {}, cleanupErrors: [], business: {}, unexpectedRequests: [],
    scope: "One formal managed A -> B -> Back transaction on frozen production. Original root and cross-site OOPIF drafts, native Target/Page/Runtime observation, public SDK snapshots/locators and one original leaf POST. No viewer, account, OS input, direct page CDP control, restoration adapter, action retry or business replay.",
    limitations: "A non-BFCache return is unverified coverage, not a restoration pass. One fixture and Chromium build cannot prove all frame topologies. Stale capture-ref rejection in a different document is not exercised. Returned leaf native loader/parent are only proved when a corresponding native frame event is observed; missing fields remain explicit. Worker event arrival order is observed, not Chromium internal causation. CIM identities supplement original Go process/Job/Stop receipts; original lifecycle bytes preserve uint64 precision." };
  const save = () => fs.writeFile(path.join(runDir, "results.json"), serialize(report));
  const registry = new Set(); let fixture, launcher, info, worker, owner, tab, stopPromise, finalLifecycleSaved = false;
  const server = createServer((request, response) => {
    if (fixture?.handle(request, response)) return;
    report.unexpectedRequests.push({ method: request.method, url: request.url, at: Date.now() }); request.resume(); response.writeHead(404); response.end("NOT_FOUND");
  });
  const launch = (program, args, options = {}) => { const record = {}; report.commands.push(record); return managedProcess(program, args, { cwd: repo, registry, record, maximumBytes: 8 * 1024 * 1024, ...options }); };
  async function command(args, expected = 0) {
    const result = await launch(executable, args, { timeoutMs: args[1] === "stop" ? 55000 : 45000 }).completed;
    assert.equal(result.code, expected, redact(result.stderr)); return result;
  }
  async function probe(label, script, env) {
    const record = { label }; report.probes.push(record);
    try { await runProcess("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { cwd: repo, env, registry, record, timeoutMs: 15000, maximumBytes: 2 * 1024 * 1024 }); return JSON.parse(record.stdout.replace(/^\uFEFF/, "").trim()); }
    finally { if (typeof record.stdout === "string") record.stdout = { bytes: Buffer.byteLength(record.stdout), sha256: hash(record.stdout) }; }
  }
  const processTable = () => probe("read-only original process inventory", processQuery);
  const until = (read, label, timeoutMs = 15000) => poll(read, { timeoutMs, intervalMs: 50, label });
  async function step(label, operation) {
    const row = { name: label, startedAt: Date.now() }; report.steps.push(row); console.log("STEP", label);
    try { await operation(); row.passed = true; } catch (error) { row.passed = false; row.error = error.stack ?? String(error); report.firstFailure ??= { step: label, at: Date.now(), error: row.error }; throw error; }
    finally { row.endedAt = Date.now(); await save(); }
  }
  async function action(label, operation) {
    const row = { label, startedAt: Date.now() }; report.actions.push(row);
    try { row.result = await operation(); row.passed = true; return row.result; }
    catch (error) { row.passed = false; row.error = { name: error.name, message: error.message, code: error.code, stack: error.stack }; throw error; }
    finally { row.settledAt = Date.now(); await save(); }
  }
  async function cleanup(label, operation) { try { report.cleanup[label] = await operation(); } catch (error) { report.cleanupErrors.push({ label, at: Date.now(), error: error.stack ?? String(error) }); } }
  async function lifecycle(label) {
    let directory = info?.runDir;
    if (!directory) { const entries = await fs.readdir(path.join(root, name, "runs"), { withFileTypes: true }); assert.equal(entries.length, 1); assert.ok(entries[0].isDirectory() && /^[0-9a-f]{32}$/.test(entries[0].name)); directory = path.join(root, name, "runs", entries[0].name); }
    const file = path.join(directory, "lifecycle.json"); inside(root, file);
    const bytes = await fs.readFile(file); assert.ok(bytes.length <= 1024 * 1024);
    const copy = `lifecycle-${label}.json`; await fs.writeFile(path.join(runDir, copy), bytes, { flag: "wx" });
    const source = { file: inside(runDir, file), copy, bytes: bytes.length, sha256: hash(bytes), nativeCreationTimeDecimal: /"nativeCreationTime"\s*:\s*(\d+)/.exec(bytes.toString())?.[1] ?? null };
    const value = JSON.parse(bytes);
    if (label === "final") { report.lifecycleSource = source; report.lifecycle = value; finalLifecycleSaved = true; } else { report.readyLifecycleSource = source; report.readyLifecycle = value; }
    return value;
  }
  async function binding() {
    const identity = await worker.evaluate(workerIdentity, 10000), infos = [await owner.client.getInfo()];
    verifyNormalBinding(report.readyLifecycle.binding, identity, infos); assert.equal(identity.extensionId, info.extensionId);
    return { identity, infos, checkedAt: Date.now() };
  }
  const frames = () => worker.evaluate(`chrome.webNavigation.getAllFrames({tabId:${tab.id}})`);
  const nativeEvents = async () => {
    const value = await worker.evaluate("__managedOopifBfcacheObservation.snapshot()");
    assert.equal(value.overflow, false); assert.deepEqual(value.observationErrors, []);
    return value;
  };
  async function readDocuments(originals) {
    const ids = originals.map(row => row.documentId); assert.equal(ids.length, 2); assert.equal(new Set(ids).size, 2);
    return worker.evaluate(`chrome.scripting.executeScript({target:{tabId:${tab.id},documentIds:${JSON.stringify(ids)}},world:'MAIN',func:${readManagedOopifBfcacheDocument.toString()}}).then(rows=>rows.map(row=>({documentId:row.documentId,frameId:row.frameId,...row.result})))`);
  }
  async function processExitProof() {
    const originals = [...new Map([...(report.originalProcesses ?? []), ...(report.preCloseProcesses ?? [])].map(row => [`${row.ProcessId}/${row.CreationDate}`, row])).values()];
    assert.ok(originals.length);
    return until(async () => { const table = await processTable(), remaining = originals.filter(before => table.some(after => before.ProcessId === after.ProcessId && before.CreationDate === after.CreationDate)); report.lastProcessObservation = { at: Date.now(), originals: originals.length, remaining }; return !remaining.length && report.lastProcessObservation; }, "original process identities gone");
  }
  async function resourceExitProof() {
    assert.match(info.nativeHostName, /^com\.openbrowseruse\.managed\.n[0-9a-f]{32}$/);
    const controlPipe = "\\\\.\\pipe\\open-browser-use-managed-" + hash(path.resolve(root).toLowerCase() + "\0" + name).slice(0, 40);
    const value = await probe("read-only exact registration and pipe absence", resourceQuery, { ...process.env, OBU_BFCACHE_RESOURCE_PROBE: JSON.stringify({ host: info.nativeHostName, pipes: [info.socketPath, controlPipe] }) });
    assert.deepEqual(value.registration.map(row => row.view).sort(), ["Registry32", "Registry64"]); assert.ok(value.registration.every(row => row.absent)); assert.deepEqual(value.presentOriginalPipes, []);
    const endpointDir = path.join(info.runDir, "temp", "open-browser-use"), entries = await fs.readdir(endpointDir); assert.deepEqual(entries, []);
    return { ...value, checkedAt: Date.now(), host: info.nativeHostName, pipes: [info.socketPath, controlPipe], endpointDir, entries };
  }
  function stopOriginal() {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      if (info && !launcher.record.closedAt) try {
        const table = await processTable(), original = report.originalProcesses?.find(row => row.ProcessId === info.browserPID);
        assert.ok(original && table.some(row => row.ProcessId === original.ProcessId && row.CreationDate === original.CreationDate && row.ExecutablePath === original.ExecutablePath));
        report.preCloseProcesses = observedProcessDescendants(table, info.browserPID);
      } catch (error) { report.cleanupErrors.push({ label: "pre-close inventory", error: error.stack }); }
      const result = await command(["managed", "stop", "--root", root, "--name", name]);
      report.stop = { at: Date.now(), result: assertManagedStopReply(JSON.parse(result.stdout), info?.runId) };
      const terminal = await bound(launcher.completed, 10000, "original supervisor actual close"); assert.equal(terminal.code, 0); assert.equal(terminal.termination, undefined); assert.ok(terminal.exitedAt && terminal.closedAt);
      report.supervisorExit = { code: terminal.code, exitedAt: terminal.exitedAt, closedAt: terminal.closedAt };
      const value = await lifecycle("final"); assertManagedViewerTerminal(value, info); assert.deepEqual(value.binding, report.readyLifecycle.binding);
      report.processesGone = await processExitProof(); report.resourcesGone = await resourceExitProof();
      const status = await command(["managed", "status", "--root", root, "--name", name], 1); assert.match(status.stderr, /has no reachable supervisor/); report.statusAfterStop = { code: status.code, checkedAt: Date.now() };
      return { confirmed: true, at: Date.now() };
    })(); return stopPromise;
  }

  try {
    await step("freeze-original-runtime-and-harness", async () => {
      report.source = { executable: hash(await fs.readFile(executable)), browser: hash(await fs.readFile(chromium)), extension: await treeHashes(extension), sdk: await treeHashes(path.join(repo, "packages/open-browser-use-js/dist")) };
      const git = await launch("git", ["rev-parse", "HEAD"], { timeoutMs: 10000 }).completed; assert.equal(git.code, 0); report.source.head = git.stdout.trim();
      for (const relative of await managedHumanSourceFiles("acceptance", launch)) { inside(repo, path.resolve(repo, relative)); const dest = path.join(snapshot, relative); await fs.mkdir(path.dirname(dest), { recursive: true }); await fs.copyFile(path.join(repo, relative), dest); }
      report.source.snapshot = await treeHashes(snapshot);
      const bytes = await fs.readFile(buildFile), build = JSON.parse(bytes); assert.equal(build.passed, true);
      assert.equal(build.exeSHA256, report.source.executable); assert.deepEqual(build.extensionFiles, report.source.extension);
      report.buildEvidence = { path: buildFile, file: "build-manifest.json", sha256: hash(bytes), originalBuildReused: true };
      await fs.writeFile(path.join(runDir, "build-manifest.json"), bytes, { flag: "wx" }); report.source.builtInputs = build.sourceInputs;
      report.source.buildSnapshot = path.join(path.dirname(buildFile), "source-snapshot");
      for (const [relative, expected] of Object.entries(build.sourceInputs)) {
        assert.equal(report.source.snapshot[relative], expected, `Current source differs from original build: ${relative}`);
        const tested = await fs.readFile(path.join(report.source.buildSnapshot, relative)); assert.equal(hash(tested), expected);
        const dest = path.join(runDir, "built-source-snapshot", relative); await fs.mkdir(path.dirname(dest), { recursive: true }); await fs.writeFile(dest, tested, { flag: "wx" });
      }
      await fs.cp(extension, extensionInput, { recursive: true }); await fs.cp(path.join(repo, "packages/open-browser-use-js/dist"), sdkInput, { recursive: true });
      assert.deepEqual(await treeHashes(extensionInput), report.source.extension); assert.deepEqual(await treeHashes(sdkInput), report.source.sdk);
      await listenFixture(server); fixture = createManagedOopifBfcacheFixture({ baseURL: `http://127.0.0.1:${server.address().port}/` }); report.fixtureSetup = { workflowId: fixture.workflowId, urls: fixture.urls };
    });
    await step("production-managed-run-and-readonly-native-observer", async () => {
      launcher = launch(executable, ["managed", "run", "--root", root, "--name", name, "--browser-path", chromium, "--extension-dir", extensionInput, "--startup-timeout", "30s"], { timeoutMs: 8 * 60 * 1000 });
      const ready = await until(() => { if (launcher.record.exitedAt || launcher.record.closedAt || launcher.record.spawnError) throw Error(`Original launch ended: ${redact(launcher.record.stderr)}`); return parseManagedReadyOutput(launcher.record.stdout); }, "original managed ready", 40000);
      assert.equal(ready.state, "ready"); info = ready.info; report.info = info; inside(root, info.runDir); assert.equal(info.name, name);
      report.originalProcesses = observedProcessDescendants(await processTable(), info.browserPID);
      const browser = report.originalProcesses.find(row => row.ProcessId === info.browserPID), native = report.originalProcesses.find(row => row.ProcessId === info.nativePID);
      assert.ok(browser && native); assert.equal(path.resolve(browser.ExecutablePath).toLowerCase(), path.resolve(chromium).toLowerCase());
      assert.equal(path.resolve(native.ExecutablePath).toLowerCase(), path.join(info.runDir, "native-host.exe").toLowerCase()); assert.equal(hash(await fs.readFile(native.ExecutablePath)), report.source.executable);
      report.status = JSON.parse((await command(["managed", "status", "--root", root, "--name", name])).stdout); assert.deepEqual(report.status.info, info);
      await lifecycle("ready"); assert.equal(report.readyLifecycle.state, "ready"); assert.deepEqual(report.readyLifecycle.info, info);
      const endpoint = await waitPrivateDevToolsEndpoint(info.profileDir, { assertAlive() { assert.ok(!launcher.record.exitedAt && !launcher.record.closedAt && !launcher.record.spawnError); } });
      const response = await fetch(`http://127.0.0.1:${endpoint.port}/json/list`, { signal: AbortSignal.timeout(10000) }); assert.equal(response.status, 200);
      const workers = (await response.json()).filter(row => row.type === "service_worker" && row.url === `chrome-extension://${info.extensionId}/background.js`); assert.equal(workers.length, 1);
      report.workerTarget = workers[0]; report.observerConnection = {};
      worker = await connectNormalCDP(workers[0].webSocketDebuggerUrl, { record: report.observerConnection, authorizationRequired: false, handshakeTimeoutMs: 10000 });
      report.observerReady = await worker.evaluate(`(${installManagedOopifBfcacheObserver.toString()})(chrome,globalThis)`);
      const { connectOpenBrowserUse } = await import(pathToFileURL(path.join(sdkInput, "index.js")));
      owner = await connectOpenBrowserUse({ socketPath: info.socketPath, sessionId: "managed-oopif-bfcache", turnId: "original-workflow", timeoutMs: 20000 }); report.bindingBefore = await binding();
    });
    await step("original-two-document-drafts-and-oopif-witness", async () => {
      await action("newTab-original-A", async () => { tab = await owner.newTab({ url: fixture.urls.root, backgroundWindow: true }); return { id: tab.id }; });
      report.business.tabId = tab.id;
      const child = tab.frameLocator("#child");
      const rootInstructions = JSON.parse(await action("read-root-instructions", () => tab.locator("#instructions").textContent()));
      const leafInstructions = JSON.parse(await action("read-leaf-instructions", () => child.locator("#instructions").textContent()));
      assert.equal(rootInstructions.role, "root"); assert.equal(leafInstructions.role, "leaf");
      await action("fill-root-draft", () => tab.getByLabel("Root unsaved draft", { exact: true }).fill(rootInstructions.draft));
      await action("fill-leaf-draft", () => child.getByLabel("Frame unsaved draft", { exact: true }).fill(leafInstructions.draft));
      report.business.originalFrames = await frames();
      const originals = report.business.originalFrames.filter(row => row.url === fixture.urls.root || row.url === fixture.urls.leaf); assert.equal(originals.length, 2);
      report.business.originalDocuments = await until(async () => {
        const rows = await readDocuments(originals);
        return rows.length === 2 && rows.every(row => row.state?.lifecycle?.some(event => event.type === "pageshow" && event.persisted === false && event.trusted === true)) && rows;
      }, "two original native initial pageshow observations");
      for (const row of report.business.originalDocuments) { assert.equal(row.draft, fixture.drafts[row.state.role]); assert.equal(row.state.posts, 0); assert.equal(row.state.overflow, false); }
      report.business.beforeNative = await nativeEvents(); assert.equal(report.business.beforeNative.overflow, false);
      report.business.originalNativeIdentity = originalManagedOopifNativeIdentity(report.business.beforeNative, tab.id, fixture.urls);
    });
    await step("original-A-to-B-and-single-public-goBack", async () => {
      await action("click-original-away-link", () => tab.getByRole("link", { name: "Review separate page B", exact: true }).click());
      assert.match(await action("read-original-B", () => tab.locator("#away").textContent()), /Separate page B/);
      report.business.awayFrames = await frames(); report.business.beforeBackNative = await nativeEvents();
      let backError;
      try { report.business.goBackResult = await action("goBack-original-once", () => tab.goBack({ timeoutMs: 15000 })); }
      catch (error) { backError = error; report.firstFailure ??= { step: "original-A-to-B-and-single-public-goBack", action: "goBack-original-once", at: Date.now(), error: error.stack ?? String(error) }; }
      // These are observations after the exact original command settles. Do not
      // retry goBack or attach/enable Runtime to make the SDK state look healed.
      const diagnosticErrors = report.business.returnedDiagnosticErrors = [];
      try { report.business.afterBackNative = await nativeEvents(); } catch (error) { diagnosticErrors.push({ observation: "native-event-stream", error: error.stack }); }
      try { report.business.returnedFrames = await frames(); } catch (error) { diagnosticErrors.push({ observation: "current-webNavigation-frames", error: error.stack }); }
      try { report.business.restoredDocuments = await readDocuments(report.business.originalDocuments); }
      catch (error) { report.business.restoredObservationError = { message: error.message, stack: error.stack }; }
      report.business.fixtureWitness = assessManagedOopifBfcacheDocuments({ before: report.business.originalDocuments, restored: report.business.restoredDocuments });
      if (report.business.afterBackNative) try { report.business.nativeReturn = assessManagedOopifNativeReturn(report.business.afterBackNative, report.business.originalNativeIdentity, report.business.beforeBackNative.events.at(-1)?.sequence ?? 0); }
      catch (error) { diagnosticErrors.push({ observation: "native-return-assessment", error: error.stack }); }
      report.coverage = report.business.fixtureWitness.bfcacheWitnessVerified && report.business.nativeReturn?.originalRootRestoreVerified ? "original-root-and-leaf-BFCache-return" : "BFCache-return-unverified";
      if (backError) throw backError;
      assert.deepEqual(diagnosticErrors, []);
      assert.equal(report.coverage, "original-root-and-leaf-BFCache-return", serialize(report.business.fixtureWitness));
      assert.equal(report.business.fixtureWitness.originalDraftsPreserved, true, serialize(report.business.fixtureWitness));
    });
    await step("public-restored-observation-locator-and-one-original-POST", async () => {
      report.business.domSnapshot = await action("restored-domSnapshot", () => tab.domSnapshot({ timeoutMs: 10000 }));
      report.business.snapshotAI = await action("restored-snapshotAI", () => tab.snapshotAI({ timeoutMs: 10000 }));
      assert.match(report.business.domSnapshot, /Root unsaved draft/);
      assert.match(report.business.snapshotAI.snapshot, /Frame unsaved draft/);
      assert.equal(report.business.snapshotAI.stats.frames, 2);
      const child = tab.frameLocator("#child");
      report.business.leafSnapshot = await action("restored-leaf-ariaSnapshot", () => child.locator("body").ariaSnapshot({ timeoutMs: 10000 }));
      assert.match(report.business.leafSnapshot, /Frame unsaved draft/);
      assert.equal(await action("restored-root-inputValue", () => tab.getByLabel("Root unsaved draft", { exact: true }).inputValue()), fixture.drafts.root);
      assert.equal(await action("restored-leaf-inputValue", () => child.getByLabel("Frame unsaved draft", { exact: true }).inputValue()), fixture.drafts.leaf);
      await action("submit-original-leaf-once", () => child.getByRole("button", { name: "Submit original frame draft once", exact: true }).click());
      await action("wait-original-receipt-visible", () => child.locator("#receipt").filter({ hasText: '"recorded":true' }).waitFor({ state: "visible", timeoutMs: 10000 }));
      report.business.receipt = JSON.parse(await action("read-original-receipt", () => child.locator("#receipt").textContent()));
      report.business.finalDocuments = await readDocuments(report.business.originalDocuments); report.business.finalNative = await nativeEvents();
      assert.equal(report.business.finalNative.overflow, false);
      report.business.finalNativeReturn = assessManagedOopifNativeReturn(report.business.finalNative, report.business.originalNativeIdentity, report.business.beforeBackNative.events.at(-1)?.sequence ?? 0);
      assert.deepEqual(report.unexpectedRequests, []);
      report.business.receiptProof = assertManagedOopifBfcacheReceipt(fixture.stats(), { before: report.business.originalDocuments, restored: report.business.restoredDocuments, after: report.business.finalDocuments, receipt: report.business.receipt });
      assert.equal(report.business.finalNativeReturn.restoredOopifContextVerified, true, "Current native leaf target/session/default context is not proved live");
      report.bindingAfter = await binding(); assert.deepEqual(report.bindingAfter.identity, report.bindingBefore.identity);
      report.business.passed = true;
    });
  } catch (error) {
    report.error = error.stack ?? String(error); report.firstFailure ??= { at: Date.now(), error: report.error }; console.error(redact(report.error));
    if (worker && tab && report.business.originalDocuments) try { report.failureDocuments = await readDocuments(report.business.originalDocuments); } catch (failure) { report.failureDocumentError = failure.stack; }
  }
  finally {
    report.fixtureBeforeCleanup = fixture?.stats();
    if (owner) await cleanup("turnEnd", async () => {
      const startedAt = Date.now(), result = await owner.client.turnEnded(); report.turnEnd = { startedAt, settledAt: Date.now(), result };
      return report.turnEnd;
    });
    if (worker) await cleanup("nativeObserver", async () => {
      report.nativeEventsFinal = await worker.evaluate("__managedOopifBfcacheObservation.stop()");
      assert.equal(report.nativeEventsFinal.overflow, false); assert.equal(report.nativeEventsFinal.listenerPresent, false);
      assert.deepEqual(report.nativeEventsFinal.observationErrors, []); assert.deepEqual(report.nativeEventsFinal.pendingAtStop, []);
      assert.equal(report.nativeEventsFinal.sendCommandRestored, true); return { stopped: true, nativeCommandFunctionRestored: true };
    });
    if (worker) await cleanup("observerTransport", async () => { await worker.close(); return { closed: true }; });
    if (owner) await cleanup("sdkTransport", async () => { owner.close(); return { closed: true }; });
    if (launcher) await cleanup("originalStop", stopOriginal);
    if (launcher && !launcher.record.closedAt) await cleanup("supervisorFallback", async () => { launcher.terminate("bfcache-check-cleanup"); await bound(launcher.completed.catch(() => {}), 15000, "original supervisor fallback close"); throw Error("Supervisor required forced termination"); });
    if (launcher && !finalLifecycleSaved) await cleanup("finalLifecycle", () => lifecycle("final"));
    if (info && !report.processesGone) await cleanup("originalProcessObservation", async () => { report.processesGone = await processExitProof(); return report.processesGone; });
    if (info && !report.resourcesGone) await cleanup("privateResourceObservation", async () => { report.resourcesGone = await resourceExitProof(); return report.resourcesGone; });
    await cleanup("fixture", async () => { server.closeAllConnections(); if (server.listening) await bound(new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())), 5000, "original fixture close"); return { closed: !server.listening }; });
    if (report.source?.snapshot) await cleanup("sourceIntegrity", async () => {
      assert.equal(hash(await fs.readFile(executable)), report.source.executable); assert.equal(hash(await fs.readFile(chromium)), report.source.browser);
      assert.deepEqual(await treeHashes(extension), report.source.extension); assert.deepEqual(await treeHashes(extensionInput), report.source.extension);
      assert.deepEqual(await treeHashes(path.join(repo, "packages/open-browser-use-js/dist")), report.source.sdk); assert.deepEqual(await treeHashes(sdkInput), report.source.sdk);
      assert.deepEqual(await treeHashes(snapshot), report.source.snapshot);
      for (const [relative, expected] of Object.entries(report.source.snapshot)) assert.equal(hash(await fs.readFile(path.join(repo, relative))), expected, `Source changed during run: ${relative}`);
      assert.equal(hash(await fs.readFile(buildFile)), report.buildEvidence.sha256); assert.equal(hash(await fs.readFile(path.join(runDir, "build-manifest.json"))), report.buildEvidence.sha256);
      assert.deepEqual(await treeHashes(path.join(runDir, "built-source-snapshot")), report.source.builtInputs);
      for (const [relative, expected] of Object.entries(report.source.builtInputs)) assert.equal(hash(await fs.readFile(path.join(report.source.buildSnapshot, relative))), expected);
      return { unchanged: true, at: Date.now() };
    });
    report.fixture = fixture?.stats(); report.liveRunnerChildren = [...registry].map(child => child.pid); report.endedAt = Date.now();
    report.passed = !report.error && report.steps.length === 5 && report.steps.every(row => row.passed) && report.business.passed === true && report.cleanupErrors.length === 0 && !registry.size && report.supervisorExit?.code === 0 && report.cleanup.sourceIntegrity?.unchanged === true;
    report.featurePassed = report.passed && report.coverage === "original-root-and-leaf-BFCache-return";
    await save(); console.log("RESULT", JSON.stringify({ runDir, passed: report.passed, coverage: report.coverage }));
  }
  return report;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  assert.equal(process.argv.length, 2, "No retry or alternate business arguments");
  const report = await runManagedOopifBfcacheCheck(); process.exitCode = report.passed ? 0 : 1;
}
