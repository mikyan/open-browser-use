// One original workflow through the production managed CLI. No fixture host
// registry, Native Port shim or replacement browser launcher is used here.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createCreatedPageFixtures } from "./created-page-fixture.mjs";
import { installCreatedPageObserver, assertCreatedPageSource, assertCreatedPageReceipt } from "./created-page-provenance.mjs";
import { connectNormalCDP } from "./normal-browser-downloads-support.mjs";
import { listenFixture } from "./fixture-listener.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
assert.equal(process.platform, "win32");
const executable = process.env.OBU_TEST_HOST_BINARY, chromium = process.env.OBU_TEST_CHROMIUM_BINARY, extension = process.env.OBU_TEST_EXTENSION_DIR;
assert.ok(executable && chromium && extension, "Set host, Chromium and built extension paths explicitly");
await Promise.all([executable, chromium, extension].map(file => fs.access(file)));
await fs.mkdir(path.join(repo, ".tmp/browser-integration"), { recursive: true });
const runDir = await fs.mkdtemp(path.join(repo, ".tmp/browser-integration/managed-launcher-"));
const root = path.join(runDir, "owned-root"), name = "acceptance";
const report = { runDir, startedAt: Date.now(), commands: [], steps: [], cleanup: {}, scope: "Windows production managed launcher; no viewer or OS foreground acceptance" };
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
async function treeHashes(root) {
  const entries = await fs.readdir(root, { recursive: true, withFileTypes: true });
  const files = entries.filter(entry => entry.isFile()).map(entry => path.join(entry.parentPath, entry.name)).sort();
  return Object.fromEntries(await Promise.all(files.map(async file => [path.relative(root, file).replaceAll("\\", "/"), hash(await fs.readFile(file))])));
}
const save = () => fs.writeFile(path.join(runDir, "results.json"), JSON.stringify(report, null, 2));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(operation, label, timeout = 10000) {
  const deadline = Date.now() + timeout;
  do { const value = await operation(); if (value) return value; await delay(30); } while (Date.now() < deadline);
  throw new Error(`${label} timed out`);
}
function launch(args, stdin = "") {
  const entry = { args, startedAt: Date.now(), stdout: "", stderr: "" }; report.commands.push(entry);
  const child = spawn(executable, args, { cwd: repo, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }); entry.pid = child.pid;
  child.stdout.on("data", value => { entry.stdout += value; }); child.stderr.on("data", value => { entry.stderr += value; });
  const done = new Promise(resolve => { child.once("error", error => { entry.error = error.stack; }); child.once("close", (code, signal) => { Object.assign(entry, { code, signal, endedAt: Date.now() }); resolve(entry); }); });
  if (stdin !== null) child.stdin.end(stdin);
  return { entry, child, done };
}
async function command(args, { expect = 0, stdin = "", timeout = 45000 } = {}) {
  const running = launch(args, stdin);
  const timer = setTimeout(() => { running.entry.forcedTermination = true; running.child.kill(); }, timeout);
  const entry = await running.done; clearTimeout(timer);
  assert.equal(entry.forcedTermination, undefined, "CLI command deadline exceeded");
  assert.equal(entry.code, expect, entry.stderr); return entry;
}
async function processSnapshot() {
  // Independent read-only observation. The product does not depend on CIM.
  const script = "@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,ExecutablePath,@{n='CreationDate';e={$_.CreationDate.ToUniversalTime().ToString('o')}}) | ConvertTo-Json -Compress";
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-Command", script], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = ""; const timer = setTimeout(() => child.kill(), 15000);
    child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", code => { clearTimeout(timer); if (code !== 0) reject(new Error(`Read-only process inventory exited ${code}: ${stderr}`)); else try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); } });
  });
}
function ownedProcesses(table, pid) {
  const ids = new Set([pid]); let added;
  do { added = false; for (const process of table) if (ids.has(process.ParentProcessId) && !ids.has(process.ProcessId)) { ids.add(process.ProcessId); added = true; } } while (added);
  return table.filter(process => ids.has(process.ProcessId));
}
async function step(name, fn) {
  const entry = { name, startedAt: Date.now() }; report.steps.push(entry); console.log("STEP", name);
  try { await fn(); entry.passed = true; } catch (error) { entry.passed = false; entry.error = error.stack; throw error; }
  finally { entry.endedAt = Date.now(); await save(); }
}
const fixtures = createCreatedPageFixtures();
const server = createServer((request, response) => { if (!fixtures.handle(request, response)) { request.resume(); response.writeHead(404); response.end("NOT_FOUND"); } });
const { connectOpenBrowserUse } = await import(pathToFileURL(path.join(repo, "packages/open-browser-use-js/dist/index.js")));
let launcher, info, browser, worker, stopped = false;
const runArgs = ["managed", "run", "--root", root, "--name", name, "--browser-path", chromium, "--extension-dir", extension, "--startup-timeout", "30s"];
try {
  report.source = { executable: hash(await fs.readFile(executable)), browser: hash(await fs.readFile(chromium)), runner: hash(await fs.readFile(fileURLToPath(import.meta.url))) };
  report.source.extension = await treeHashes(extension);
  report.source.sdk = await treeHashes(path.join(repo, "packages/open-browser-use-js/dist"));
  await step("production-launch-and-live-selection", async () => {
    launcher = launch(runArgs, null);
    const ready = await until(() => {
      if (launcher.entry.endedAt) throw new Error(`launcher exited ${launcher.entry.code}: ${launcher.entry.stderr}`);
      try { return JSON.parse(launcher.entry.stdout); } catch { return null; }
    }, "production ready", 40000);
    assert.equal(ready.state, "ready"); info = ready.info; report.info = info;
    assert.equal(info.name, name); assert.ok(info.runId && info.nativePID > 0 && info.browserPID > 0);
    assert.ok(path.relative(root, info.runDir) && !path.relative(root, info.runDir).startsWith(".."));
    report.originalProcesses = ownedProcesses(await processSnapshot(), info.browserPID);
    assert.ok(report.originalProcesses.some(process => process.ProcessId === info.nativePID), "Real native host must descend from this browser");
    const status = JSON.parse((await command(["managed", "status", "--root", root, "--name", name])).stdout);
    assert.deepEqual(status.info, info);
    const response = JSON.parse((await command(["info", "--managed", name, "--managed-root", root])).stdout);
    report.cliInfo = response; assert.equal(response.result.metadata.nativeHostName, info.nativeHostName);
    const runsBefore = (await fs.readdir(path.dirname(info.runDir))).sort();
    const collision = await command(runArgs, { expect: 1 });
    assert.match(collision.stderr, /managed supervisor is already running or cannot be created:/);
    assert.deepEqual((await fs.readdir(path.dirname(info.runDir))).sort(), runsBefore, "Rejected collision must not stage a second run");
    assert.deepEqual(JSON.parse((await command(["managed", "status", "--root", root, "--name", name])).stdout).info, info);
    const mcpInput = [{ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "managed-acceptance", version: "1" } } }, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "info", arguments: {} } }].map(value => JSON.stringify(value)).join("\n") + "\n";
    const mcp = await command(["mcp", "--managed", name, "--managed-root", root], { stdin: mcpInput });
    report.mcpReplies = mcp.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
    const mcpInfo = report.mcpReplies.find(value => value.id === 2); assert.ok(mcpInfo?.result && !mcpInfo.result.isError); assert.ok(JSON.stringify(mcpInfo).includes(info.nativeHostName));
  });
  await listenFixture(server); const fixtureURL = `http://127.0.0.1:${server.address().port}`;
  await step("original-native-child-and-receipt", async () => {
    const lines = (await fs.readFile(path.join(info.profileDir, "DevToolsActivePort"), "utf8")).trim().split("\n");
    const targets = await (await fetch(`http://127.0.0.1:${lines[0]}/json/list`)).json();
    const target = targets.find(value => value.type === "service_worker" && value.url === `chrome-extension://${info.extensionId}/background.js`); assert.ok(target);
    report.observerConnection = {};
    worker = await connectNormalCDP(target.webSocketDebuggerUrl, { record: report.observerConnection, handshakeTimeoutMs: 10000, authorizationRequired: false });
    report.observer = await worker.evaluate(`(${installCreatedPageObserver.toString()})(chrome,globalThis,{maxSources:1})`);
    browser = await connectOpenBrowserUse({ socketPath: info.socketPath, sessionId: "managed-launcher-acceptance", turnId: "original", timeoutMs: 10000 });
    const fixture = fixtures.createCase({ owner: "managed-launcher", variant: "root" });
    const source = await browser.newTab({ url: fixtureURL + fixture.urlPath, backgroundWindow: true });
    const state = async tab => JSON.parse(await tab.locator("#state").textContent({ timeoutMs: 5000 }));
    const frames = tabId => worker.evaluate(`chrome.webNavigation.getAllFrames({tabId:${tabId}})`);
    const item = report.child = { key: fixture.key, owner: fixture.owner, tabId: source.id, childURL: fixtureURL + "/created-page/child" };
    item.sourceBefore = await state(source); item.sourceFrame = (await frames(source.id)).find(frame => frame.frameId === 0);
    item.observerReady = await worker.evaluate(`__createdPageProvenance.register(${source.id})`);
    const deadline = Date.now() + 30000, remaining = () => { const left = deadline - Date.now(); assert.ok(left > 0); return Math.min(left, 10000); };
    const waiter = await source.expectPage({ timeoutMs: remaining() });
    await source.getByRole("link", { name: "Open original child", exact: true }).click({ modifiers: ["Control"], timeoutMs: remaining() });
    const child = await waiter.result(); item.childId = child.id;
    item.events = (await worker.evaluate("__createdPageProvenance.snapshot()")).events;
    item.sourceAfter = await state(source); item.sourceFrames = await frames(source.id);
    assert.equal(assertCreatedPageSource({ item, events: item.events, afterFrames: item.sourceFrames, sourceState: item.sourceAfter }), child.id);
    item.childBefore = await state(child); item.childFrame = (await frames(child.id)).find(frame => frame.frameId === 0);
    await child.getByLabel("Source key", { exact: true }).fill(item.key, { timeoutMs: remaining() });
    await child.getByLabel("Owner", { exact: true }).fill(item.owner, { timeoutMs: remaining() });
    await child.getByRole("button", { name: "Commit child receipt", exact: true }).click({ timeoutMs: remaining() });
    item.receipt = await until(async () => { const value = await child.locator("#result").textContent({ timeoutMs: remaining() }); return value && JSON.parse(value); }, "original receipt", remaining());
    item.childAfter = await state(child); item.childFrames = await frames(child.id);
    const stats = fixtures.allStats(); assert.equal(stats.children.length, 1); assert.equal(stats.requests.filter(value => value.method === "POST").length, 1);
    item.business = assertCreatedPageReceipt({ item, child: stats.children[0], state: item.childAfter, receipt: item.receipt, frames: item.childFrames }); remaining();
    const png = Buffer.from((await child.screenshot({ timeoutMs: 10000 })).base64, "base64"); assert.deepEqual([...png.subarray(0, 8)], [137,80,78,71,13,10,26,10]);
    report.png = { bytes: png.length, sha256: hash(png), width: png.readUInt32BE(16), height: png.readUInt32BE(20) }; await fs.writeFile(path.join(runDir, "child.png"), png);
    report.turnEnded = await browser.client.turnEnded();
    await assert.rejects(() => child.domSnapshot({ timeoutMs: 1000 }), /STALE|epoch|ended/i);
    report.observerFinal = await worker.evaluate("__createdPageProvenance.stop()"); assert.equal(report.observerFinal.listenerPresent, false);
    await worker.close(); worker = null; browser.close(); browser = null;
  });
  await step("production-stop-and-terminal-exit", async () => {
    report.preCloseProcesses = ownedProcesses(await processSnapshot(), info.browserPID);
    report.stop = JSON.parse((await command(["managed", "stop", "--root", root, "--name", name])).stdout);
    assert.equal(report.stop.state, "stopped"); assert.equal(report.stop.runId, info.runId); stopped = true;
    const terminal = await Promise.race([launcher.done, delay(10000).then(() => { throw new Error("launcher did not exit after stop"); })]); assert.equal(terminal.code, 0, terminal.stderr);
    report.lifecycle = JSON.parse(await fs.readFile(path.join(info.runDir, "lifecycle.json"), "utf8"));
    const lifecycle = report.lifecycle;
    assert.equal(lifecycle.version, 1); assert.equal(lifecycle.state, "closed");
    assert.deepEqual(lifecycle.info, info); assert.ok(lifecycle.readyAt && lifecycle.endedAt);
    assert.equal(lifecycle.error, undefined); assert.equal(lifecycle.forced, false); assert.equal(lifecycle.forceReason, undefined);
    for (const field of ["browserClose", "browserExit", "nativeExit", "jobEmpty", "registrationCleanup", "endpointCleanup"]) {
      assert.ok(Number.isFinite(Date.parse(lifecycle[field]?.at)), `Missing original ${field} receipt`);
      assert.equal(lifecycle[field].error, undefined, `${field} reported an error`);
    }
    assert.deepEqual(lifecycle.browserClose.result, {});
    assert.equal(lifecycle.browserExit.code, 0); assert.equal(lifecycle.nativeExit.code, 0);
    assert.deepEqual(lifecycle.jobEmpty.result, { activeProcesses: 0 });
    assert.equal(lifecycle.nativeDescriptor.pid, info.nativePID);
    assert.equal(lifecycle.nativeDescriptor.socketPath, info.socketPath);
    assert.ok(lifecycle.nativeCreationTime > 0);
    assert.equal(lifecycle.binding.bound, true); assert.equal(lifecycle.binding.exclusive, true);
    assert.equal(lifecycle.binding.extensionInstanceId, info.extensionInstanceId);
    report.processesGone = await until(async () => {
      const table = await processSnapshot();
      const old = [...report.originalProcesses, ...report.preCloseProcesses];
      const remaining = old.filter(before => table.some(after => after.ProcessId === before.ProcessId && after.CreationDate === before.CreationDate));
      return remaining.length === 0 && { at: Date.now(), originalIdentities: old.length, remaining };
    }, "original browser process identities gone");
    await command(["managed", "status", "--root", root, "--name", name], { expect: 1 });
  });
} catch (error) { report.error = error.stack; console.error(error.stack); }
finally {
  if (worker) try { await worker.close(); } catch (error) { report.cleanup.observerError = error.stack; }
  browser?.close();
  if (launcher && !launcher.entry.endedAt) {
    if (!stopped) try { report.cleanup.stop = await command(["managed", "stop", "--root", root, "--name", name]); } catch (error) { report.cleanup.stopError = error.stack; }
    const exited = await Promise.race([launcher.done, delay(5000).then(() => null)]);
    if (!exited) { report.cleanup.forcedSupervisorExit = true; launcher.child.kill(); await launcher.done; }
  }
  server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve));
  report.fixture = fixtures.allStats(); report.endedAt = Date.now();
  try {
    assert.equal(hash(await fs.readFile(executable)), report.source.executable);
    assert.deepEqual(await treeHashes(extension), report.source.extension);
    assert.deepEqual(await treeHashes(path.join(repo, "packages/open-browser-use-js/dist")), report.source.sdk);
  } catch (error) { report.cleanup.sourceChanged = error.stack; }
  report.passed = !report.error && report.steps.length === 3 && report.steps.every(value => value.passed) && !Object.keys(report.cleanup).length;
  await save(); console.log("RESULT", JSON.stringify({ runDir, passed: report.passed })); process.exitCode = report.passed ? 0 : 1;
}
