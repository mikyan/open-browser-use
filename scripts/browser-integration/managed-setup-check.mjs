// Production setup -> closed original browser -> production run with the same
// owned profile. The synthetic human actor uses CDP; no OS mouse or real account.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium as playwrightChromium } from "playwright";
import { managedProcess, runProcess, bound, poll, privateInventoryFailure } from "./normal-browser-downloads-support.mjs";
import { listenFixture } from "./fixture-listener.mjs";
import { assertManagedViewerTerminal } from "./managed-viewer-check.mjs";
import { createManagedSetupFixture, setupCookieName, setupStorageKey } from "./managed-setup-fixture.mjs";
import { setupWindowProbe, assertVisibleSetupWindow } from "./managed-setup-window-probe.mjs";
import { waitPrivateDevToolsEndpoint } from "./private-devtools-endpoint.mjs";
import { observedProcessDescendants as descendants } from "./observed-process-descendants.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const setupRefusal = /manual login setup/;
const taskInfoFields = ["socketPath", "nativeHostName", "extensionId", "extensionInstanceId"];
const nativeLifecycleFields = ["nativeDescriptor", "nativeCreationTime", "binding", "nativeExit", "registrationCleanup", "endpointCleanup"];

export function deriveSetupExtensionIdentities(manifest, mainSource) {
  const keyMatch = /^const betaExtensionPublicKey = "([A-Za-z0-9+/=]+)"\s*$/m.exec(mainSource);
  const storeMatch = /^const defaultChromeExtensionID = "([a-p]{32})"\s*$/m.exec(mainSource);
  assert.ok(keyMatch && storeMatch, "Production project extension identities are missing from the captured source");
  const id = key => {
    assert.ok(typeof key === "string" && key.length > 0);
    const bytes = Buffer.from(key, "base64"); assert.equal(bytes.toString("base64"), key, "Extension public key must be canonical base64");
    return hash(bytes).slice(0, 32).split("").map(value => String.fromCharCode(97 + parseInt(value, 16))).join("");
  };
  const managedId = id(keyMatch[1]), manifestId = manifest.key === undefined ? null : id(manifest.key);
  return { managedId, manifestId, storeId: storeMatch[1], projectIds: [...new Set([managedId, manifestId, storeMatch[1]].filter(Boolean))],
    managedPublicKeySHA256: hash(Buffer.from(keyMatch[1], "base64")), manifestKeyPresent: manifestId !== null,
    source: "managed CLI explicitly supplies betaExtensionPublicKey; manifest key is additionally checked when present; store ID comes from the same captured main.go" };
}

export function assertSetupTargetInventory(targets, identities) {
  assert.ok(Array.isArray(targets)); assert.ok(identities.projectIds.includes(identities.managedId));
  assert.equal(targets.filter(value => value.type === "page").length, 1, "Expected only the original setup about:blank page");
  const unclassified = [];
  for (const target of targets) {
    assert.ok(typeof target.targetId === "string" && typeof target.type === "string" && typeof target.url === "string");
    if (!/^chrome-extension:\/\//i.test(target.url)) continue;
    const extensionId = new URL(target.url).hostname.toLowerCase(); assert.match(extensionId, /^[a-p]{32}$/);
    assert.ok(!identities.projectIds.includes(extensionId), "Setup loaded a project extension target");
    unclassified.push({ targetId: target.targetId, type: target.type, url: target.url, extensionId, classification: "unclassified non-project extension target" });
  }
  return { projectTargetCount: 0, checkedProjectIds: [...identities.projectIds], unclassified,
    boundary: "The observed absence of project extension targets is checked with setup launch arguments, empty task endpoint and absent native host files. Other extension targets are recorded, not assumed built-in, safe, or authorized." };
}

export function assertSetupInfo(info) {
  assert.equal(info?.mode, "setup");
  assert.ok(typeof info.runId === "string" && /^[0-9a-f]{32}$/.test(info.runId));
  assert.ok(Number.isSafeInteger(info.browserPID) && info.browserPID > 0);
  assert.equal(info.nativePID, 0);
  for (const field of taskInfoFields) assert.equal(info[field], "", `Setup must have no ${field}`);
  assert.equal(info.viewerURL, undefined);
}

export function assertSetupTerminal(lifecycle, info, reason) {
  assertSetupInfo(info);
  assert.equal(lifecycle.version, 1); assert.equal(lifecycle.state, "closed");
  assert.deepEqual(lifecycle.info, info); assert.ok(lifecycle.readyAt && lifecycle.endedAt);
  assert.equal(lifecycle.error, undefined); assert.equal(lifecycle.forced, false); assert.equal(lifecycle.forceReason, undefined);
  assert.equal(lifecycle.closeReason, reason);
  for (const field of nativeLifecycleFields) assert.equal(lifecycle[field], undefined, `Setup cannot fabricate ${field}`);
  for (const field of ["browserExit", "jobEmpty"]) {
    assert.ok(Number.isFinite(Date.parse(lifecycle[field]?.at)), `Missing actual ${field} receipt`);
    assert.equal(lifecycle[field].error, undefined);
  }
  assert.equal(lifecycle.browserExit.code, 0); assert.deepEqual(lifecycle.jobEmpty.result, { activeProcesses: 0 });
  if (reason === "requested") {
    assert.ok(Number.isFinite(Date.parse(lifecycle.browserClose?.at))); assert.equal(lifecycle.browserClose.error, undefined);
    assert.deepEqual(lifecycle.browserClose.result, {});
  } else { assert.equal(reason, "browser-exited"); assert.equal(lifecycle.browserClose, undefined, "Natural exit cannot invent a Browser.close ACK"); }
  assert.ok(Array.isArray(lifecycle.commandLine));
  for (const flag of ["--headless", "--no-sandbox", "--disable-setuid-sandbox", "--load-extension", "--disable-extensions-except"])
    assert.ok(!lifecycle.commandLine.some(value => value === flag || value.startsWith(flag + "=")), `Setup includes forbidden ${flag}`);
  assert.ok(lifecycle.commandLine.includes("--user-data-dir=" + info.profileDir));
}

export function assertSetupTransaction(fixture, loginState, receipt, protectedState) {
  assert.equal(fixture.overflow, false); assert.equal(fixture.loggedIn, true); assert.equal(fixture.committed, true);
  const logins = fixture.requests.filter(row => row.method === "POST" && row.path === "/setup-login");
  const commits = fixture.requests.filter(row => row.method === "POST" && row.path === "/setup-receipt");
  assert.equal(logins.length, 1); assert.equal(commits.length, 1);
  const login = logins[0], commit = commits[0];
  for (const row of [login, commit]) {
    assert.equal(row.status, 200); assert.equal(row.once, true); assert.equal(row.trusted, true); assert.equal(row.buttonCount, 1);
    assert.equal(row.body.truncated, false); assert.ok(row.body.bytes > 0); assert.match(row.body.sha256, /^[0-9a-f]{64}$/);
    assert.equal(row.finished, true); assert.equal(row.closed, true); assert.equal(row.aborted, false); assert.deepEqual(row.errors, []);
  }
  assert.equal(login.credentialsMatch, true); assert.equal(login.cookieIssued, true); assert.equal(login.cookieAuthenticated, false);
  assert.equal(login.documentToken, loginState.documentToken); assert.deepEqual(loginState.clicks, [{ trusted: true, sequence: 1 }]);
  assert.equal(commit.cookieAuthenticated, true); assert.equal(commit.storageMatches, true);
  assert.equal(commit.storageSHA256, fixture.storage.sha256); assert.equal(commit.documentToken, protectedState.documentToken);
  assert.deepEqual(protectedState.clicks, [{ trusted: true, sequence: 1 }]);
  assert.deepEqual(receipt, commit.publicReceipt); assert.equal(receipt.workflowId, fixture.workflowId);
  const gets = fixture.requests.filter(row => row.method === "GET" && row.path === "/setup-protected" && row.status === 200);
  assert.equal(gets.length, 1); assert.equal(gets[0].cookieAuthenticated, true); assert.equal(gets[0].documentToken, protectedState.documentToken);
  assert.ok(login.at < gets[0].at && gets[0].at <= commit.at);
  return { loginPOSTs: 1, authenticatedPOSTs: 1, loginBodySHA256: login.body.sha256, receiptBodySHA256: commit.body.sha256, cookieSHA256: fixture.cookie.sha256, storageSHA256: fixture.storage.sha256 };
}

async function treeHashes(root) {
  const entries = await fs.readdir(root, { recursive: true, withFileTypes: true });
  const files = entries.filter(entry => entry.isFile()).map(entry => path.join(entry.parentPath, entry.name)).sort();
  return Object.fromEntries(await Promise.all(files.map(async file => [path.relative(root, file).replaceAll("\\", "/"), hash(await fs.readFile(file))])));
}
function privatePath(root, file) {
  const relative = path.relative(root, file);
  assert.ok(relative && !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

export async function runManagedSetupCheck() {
  assert.equal(process.platform, "win32");
  const executable = process.env.OBU_TEST_HOST_BINARY, chromium = process.env.OBU_TEST_CHROMIUM_BINARY, extension = process.env.OBU_TEST_EXTENSION_DIR;
  assert.ok(executable && chromium && extension, "Set explicit host, Chromium and built extension paths");
  await Promise.all([executable, chromium, extension].map(file => fs.access(file)));
  await fs.mkdir(path.join(repo, ".tmp/browser-integration"), { recursive: true });
  const runDir = await fs.mkdtemp(path.join(repo, ".tmp/browser-integration/managed-setup-"));
  const root = path.join(runDir, "owned-root"), name = "setup-acceptance", naturalName = "natural-setup";
  const fixture = createManagedSetupFixture(), registry = new Set(), sessions = [], actors = [];
  const report = { runDir, startedAt: Date.now(), commands: [], steps: [], cleanup: {}, screenshots: [], sessions: [],
    scope: "Production Windows setup and subsequent run; synthetic CDP-driven human actor on the original visible setup page. No real credentials, manual user, MFA, OS focus/mouse, installed-browser or company-policy acceptance.",
    privacy: "Raw synthetic password, cookie, localStorage marker and login POST/response bytes are not retained. Their original byte counts/hash and server validation are recorded. Private profile contains the synthetic persistent state." };
  const redact = value => fixture.redact(String(value)).replace(/(#ticket=)[A-Za-z0-9_-]+/g, "$1[redacted]");
  const save = () => fs.writeFile(path.join(runDir, "results.json"), JSON.stringify(report, (_key, value) => typeof value === "string" ? redact(value) : value, 2));
  const server = createServer((request, response) => { if (!fixture.handle(request, response)) { request.resume(); response.writeHead(404); response.end(); } });
  let sdk, originalPage, taskTab;
  const launch = (args, options = {}) => { const record = {}; report.commands.push(record); return managedProcess(executable, args, { cwd: repo, registry, record, maximumBytes: 2 * 1024 * 1024, ...options }); };
  async function command(args, code = 0) {
    const result = await launch(args, { timeoutMs: args[1] === "stop" ? 55000 : 45000 }).completed;
    assert.equal(result.code, code, redact(result.stderr)); return result;
  }
  async function processTable() {
    const record = {};
    try { await runProcess("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,ExecutablePath,@{n='CreationDate';e={$_.CreationDate.ToUniversalTime().ToString('o')}}) | ConvertTo-Json -Compress"], { record, registry, timeoutMs: 15000 }); }
    catch (error) { throw privateInventoryFailure(error); }
    return JSON.parse(record.stdout);
  }
  async function observeWindows(browserPID) {
    const record = {};
    await runProcess("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", setupWindowProbe], {
      env: { ...process.env, OBU_SETUP_OBSERVER_PID: String(browserPID) }, registry, record, timeoutMs: 20000, maximumBytes: 262144
    });
    assert.equal(record.stderr, "");
    return { ...JSON.parse(record.stdout), probeProcess: { pid: record.pid, startedAt: record.startedAt, exitedAt: record.exitedAt, closedAt: record.closedAt, code: record.code } };
  }
  async function step(label, operation) {
    const record = { name: label, startedAt: Date.now() }; report.steps.push(record); console.log("STEP", label);
    try { await operation(); record.passed = true; }
    catch (error) { record.passed = false; record.error = redact(error.stack); report.firstFailure ??= { step: label, at: Date.now(), error: record.error }; throw error; }
    finally { record.endedAt = Date.now(); await save(); }
  }
  const argsFor = (mode, selectedName) => ["managed", mode, "--root", root, "--name", selectedName, "--browser-path", chromium,
    ...(mode === "run" ? ["--extension-dir", extension] : []), "--startup-timeout", "30s"];
  async function start(mode, selectedName) {
    const launcher = launch(argsFor(mode, selectedName)), item = { mode, name: selectedName, launcher, record: { mode, name: selectedName } }; sessions.push(item);
    report.sessions.push(item.record);
    const ready = await poll(() => {
      if (launcher.record.closedAt) throw new Error(`Original ${mode} launcher exited before readiness: ${redact(launcher.record.stderr)}`);
      try { return JSON.parse(launcher.record.stdout); } catch { return null; }
    }, { timeoutMs: 40000, intervalMs: 30, label: `production ${mode} ready` });
    assert.equal(ready.state, mode === "setup" ? "setup" : "ready");
    item.info = item.record.info = ready.info; assert.equal(ready.runId, item.info.runId); assert.equal(item.info.name, selectedName);
    privatePath(root, item.info.runDir); privatePath(root, item.info.profileDir);
    if (mode === "setup") { assertSetupInfo(item.info); assert.equal(ready.viewerURL, undefined); }
    item.record.originalProcesses = descendants(await processTable(), item.info.browserPID);
    assert.ok(item.record.originalProcesses.some(row => row.ProcessId === item.info.browserPID));
    if (mode === "run") assert.ok(item.record.originalProcesses.some(row => row.ProcessId === item.info.nativePID));
    if (mode === "setup") {
      item.record.visibleWindowObservation = await observeWindows(item.info.browserPID);
      item.record.visibleWindowProof = assertVisibleSetupWindow(item.record.visibleWindowObservation, item.info.browserPID);
    }
    const status = JSON.parse((await command(["managed", "status", "--root", root, "--name", selectedName])).stdout);
    assert.equal(status.state, ready.state); assert.deepEqual(status.info, item.info); assert.equal(status.viewerURL, undefined); item.record.status = status;
    return item;
  }
  async function actor(item) {
    const endpoint = await waitPrivateDevToolsEndpoint(item.info.profileDir, { assertAlive: () => {
      const original = item.launcher.record;
      assert.ok(!original.exitedAt && !original.closedAt && !original.spawnError, "Original setup supervisor exited during private endpoint observation");
    } });
    const browser = await playwrightChromium.connectOverCDP(endpoint.url); actors.push(browser);
    assert.equal(browser.contexts().length, 1); const context = browser.contexts()[0]; assert.equal(context.pages().length, 1);
    const page = context.pages()[0]; assert.equal(page.url(), "about:blank");
    const native = await browser.newBrowserCDPSession();
    item.record.targetInventory = { at: Date.now(), response: await native.send("Target.getTargets") };
    const targets = item.record.targetInventory.response.targetInfos;
    // Preserve the actual response before any classification/assertion fails.
    await save();
    item.record.targetInventory.proof = assertSetupTargetInventory(targets, report.projectExtensionIdentities);
    const target = targets.find(value => value.type === "page"); item.record.originalTarget = { targetId: target.targetId, type: target.type, url: target.url };
    await native.detach();
    browser.on("disconnected", () => { item.record.actorDisconnectedAt = Date.now(); });
    return { browser, context, page };
  }
  async function capture(page, file) {
    const bytes = await page.screenshot({ path: path.join(runDir, file) }); const record = { file, bytes: bytes.length, sha256: hash(bytes), at: Date.now() }; report.screenshots.push(record); return record;
  }
  async function finish(item, { natural = false } = {}) {
    if (!item.record.preCloseProcesses) item.record.preCloseProcesses = descendants(await processTable(), item.info.browserPID);
    if (!natural) {
      item.record.stop = JSON.parse((await command(["managed", "stop", "--root", root, "--name", item.name])).stdout);
      assert.equal(item.record.stop.state, "stopped"); assert.equal(item.record.stop.runId, item.info.runId);
    }
    const result = await bound(item.launcher.completed, 15000, "original supervisor terminal exit"); assert.equal(result.code, 0, redact(result.stderr));
    item.record.lifecycle = JSON.parse(await fs.readFile(path.join(item.info.runDir, "lifecycle.json"), "utf8"));
    if (item.mode === "setup") {
      assertSetupTerminal(item.record.lifecycle, item.info, natural ? "browser-exited" : "requested");
      const files = await fs.readdir(item.info.runDir); item.record.runFiles = files;
      for (const file of ["native-host.exe", "native-host.json", "extension", "browser.log", "chrome.log"]) assert.ok(!files.includes(file), `Setup created forbidden ${file}`);
    } else assertManagedViewerTerminal(item.record.lifecycle, item.info);
    const originals = [...item.record.originalProcesses, ...item.record.preCloseProcesses];
    item.record.processesGone = await poll(async () => {
      const rows = await processTable(); const remaining = originals.filter(before => rows.some(after => before.ProcessId === after.ProcessId && before.CreationDate === after.CreationDate));
      return !remaining.length && { at: Date.now(), snapshotRows: originals.length, uniqueIdentities: new Set(originals.map(value => `${value.ProcessId}/${value.CreationDate}`)).size, remaining };
    }, { timeoutMs: 15000, label: "original owned process identities gone" });
    if (item.mode === "setup") {
      item.record.closedWindowObservation = await observeWindows(item.info.browserPID);
      assert.deepEqual(item.record.closedWindowObservation.windows, [], "Original setup process still owns windows after actual exit");
    }
    item.record.finalStatus = await command(["managed", "status", "--root", root, "--name", item.name], 1);
    assert.match(item.record.finalStatus.stderr, /has no reachable supervisor:/, "Final status failed for a reason other than the absent original supervisor"); item.finished = true;
  }
  async function rejectMCP() {
    // Existing process helper intentionally uses ignored stdin. This one bounded
    // stdio exchange preserves actual original MCP replies without a shell.
    const args = ["mcp", "--managed", name, "--managed-root", root], record = { command: executable, args, startedAt: Date.now(), stdout: "", stderr: "" };
    report.commands.push(record);
    const child = spawn(executable, args, { cwd: repo, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }); registry.add(child); record.pid = child.pid;
    let failure;
    const timer = setTimeout(() => { record.termination = { reason: "MCP deadline", at: Date.now() }; child.kill(); }, 15000);
    const completed = new Promise((resolve, reject) => {
      child.on("error", error => { record.spawnError = redact(error.message); failure = error; });
      for (const field of ["stdout", "stderr"]) child[field].on("data", bytes => { if (Buffer.byteLength(record[field]) + bytes.length > 1048576) { record.termination = { reason: "MCP output overflow", at: Date.now() }; child.kill(); } else record[field] += bytes; });
      child.on("exit", (code, signal) => Object.assign(record, { code, signal, exitedAt: Date.now() }));
      child.on("close", (code, signal) => { clearTimeout(timer); registry.delete(child); Object.assign(record, { code, signal, closedAt: Date.now() }); failure ? reject(failure) : resolve(record); });
    });
    child.stdin.on("error", error => { record.stdinError = redact(error.message); });
    child.stdin.end([{ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "managed-setup-acceptance", version: "1" } } },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "info", arguments: {} } }].map(value => JSON.stringify(value)).join("\n") + "\n");
    await bound(completed, 25000, "MCP actual terminal exit"); assert.equal(record.termination, undefined); assert.equal(record.code, 0, record.stderr);
    const replies = record.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line)), rejected = replies.find(value => value.id === 2);
    assert.ok(rejected?.error || rejected?.result?.isError); assert.match(JSON.stringify(rejected), setupRefusal); return { replies, commandPID: record.pid };
  }
  try {
    report.source = { executable: hash(await fs.readFile(executable)), browser: hash(await fs.readFile(chromium)), extension: await treeHashes(extension), sdk: await treeHashes(path.join(repo, "packages/open-browser-use-js/dist")) };
    await fs.cp(extension, path.join(runDir, "extension-input"), { recursive: true }); await fs.cp(path.join(repo, "packages/open-browser-use-js/dist"), path.join(runDir, "sdk-input"), { recursive: true });
    for (const source of ["cmd/open-browser-use/main.go", "cmd/open-browser-use/managed.go", "cmd/open-browser-use/managed_setup.go", "internal/managedbrowser", "internal/managedviewer", "scripts/browser-integration/managed-setup-check.mjs", "scripts/browser-integration/managed-setup-fixture.mjs", "scripts/browser-integration/managed-setup-window-probe.mjs", "scripts/browser-integration/private-devtools-endpoint.mjs", "scripts/browser-integration/observed-process-descendants.mjs", "scripts/browser-integration/managed-viewer-check.mjs", "scripts/browser-integration/normal-browser-downloads-support.mjs", "scripts/browser-integration/native-browser-installation.mjs", "scripts/browser-integration/fixture-listener.mjs", "scripts/browser-integration/package.json", "scripts/browser-integration/package-lock.json"]) {
      const target = path.join(runDir, "source-snapshot", source); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.cp(path.join(repo, source), target, { recursive: true });
    }
    report.source.snapshot = await treeHashes(path.join(runDir, "source-snapshot"));
    report.projectExtensionIdentities = deriveSetupExtensionIdentities(JSON.parse(await fs.readFile(path.join(runDir, "extension-input/manifest.json"), "utf8")), await fs.readFile(path.join(runDir, "source-snapshot/cmd/open-browser-use/main.go"), "utf8"));
    await listenFixture(server); const origin = `http://127.0.0.1:${server.address().port}`; report.fixtureOrigin = origin;
    let setup, running;
    await step("production-setup-isolation-and-task-rejections", async () => {
      setup = await start("setup", name); report.setup = setup.record;
      const before = (await fs.readdir(path.dirname(setup.info.runDir))).sort();
      report.collisions = [];
      for (const mode of ["setup", "run"]) {
        const collision = await command(argsFor(mode, name), 1);
        assert.match(collision.stderr, mode === "setup" ? /managed profile is already supervised or cannot be reserved:/ : /managed supervisor is already running or cannot be created:/);
        assert.deepEqual((await fs.readdir(path.dirname(setup.info.runDir))).sort(), before); report.collisions.push({ mode, pid: collision.pid });
      }
      const cli = await command(["info", "--managed", name, "--managed-root", root], 1); assert.match(cli.stderr, setupRefusal); report.setup.cliRefusal = cli.stderr;
      report.setup.mcpRefusal = await rejectMCP();
      const viewing = await command(["managed", "view", "--name", name, "--root", root], 1); assert.match(viewing.stderr, /managed setup is for manual login/);
      assert.deepEqual(JSON.parse((await command(["managed", "status", "--root", root, "--name", name])).stdout).info, setup.info);
      let privateEndpoints = [];
      try { privateEndpoints = await fs.readdir(path.join(setup.info.runDir, "temp/open-browser-use")); } catch (error) { if (error.code !== "ENOENT") throw error; }
      report.setup.privateEndpointFiles = privateEndpoints; assert.deepEqual(privateEndpoints, []);
    });
    await step("original-synthetic-human-login-on-visible-setup-page", async () => {
      const human = await actor(setup); originalPage = human.page;
      const response = await originalPage.goto(origin + "/setup-login", { waitUntil: "domcontentloaded" }); assert.equal(response.status(), 200);
      report.login = { actor: "Playwright CDP input on original setup page; no OS input", before: JSON.parse(await originalPage.locator("#state").textContent()), actions: [] };
      const credentials = fixture.credentials();
      for (const [label, value] of [["Fixture user", credentials.login], ["Fixture password", credentials.password]]) {
        const action = { label, startedAt: Date.now() }; report.login.actions.push(action); await originalPage.getByLabel(label, { exact: true }).fill(value); action.completedAt = Date.now();
      }
      const submit = { label: "Sign in to local fixture", startedAt: Date.now() }; report.login.actions.push(submit);
      await originalPage.getByRole("button", { name: submit.label, exact: true }).click(); submit.completedAt = Date.now();
      report.login.receipt = await poll(async () => { const value = await originalPage.locator("#result").textContent(); return value && JSON.parse(value); }, { label: "original synthetic login response" });
      assert.equal(report.login.receipt.ok, true); assert.equal(await originalPage.getByLabel("Fixture password", { exact: true }).inputValue(), "");
      report.login.after = JSON.parse(await originalPage.locator("#state").textContent());
      assert.equal(report.login.before.documentToken, report.login.after.documentToken); assert.deepEqual(report.login.before.clicks, []);
      assert.deepEqual(report.login.after.clicks, [{ trusted: true, sequence: 1 }]);
      report.login.storage = fixture.verifyStorage(await originalPage.evaluate(key => localStorage.getItem(key), setupStorageKey));
      const cookies = await human.context.cookies(origin); assert.equal(cookies.length, 1); report.login.cookie = fixture.verifyCookie(cookies.find(value => value.name === setupCookieName));
      assert.equal(await originalPage.evaluate(() => document.cookie), "", "HttpOnly session must not be readable by page JavaScript");
      report.login.screenshot = await capture(originalPage, "synthetic-login-complete.png");
      assert.equal(fixture.stats().requests.filter(value => value.method === "POST").length, 1);
    });
    await step("requested-setup-stop-and-original-profile-lock-release", async () => {
      await finish(setup); assert.ok(setup.record.actorDisconnectedAt); assert.equal(originalPage.isClosed(), true);
    });
    await step("production-run-reuses-authenticated-profile-once", async () => {
      running = await start("run", name); report.run = running.record;
      assert.equal(running.info.extensionId, report.projectExtensionIdentities.managedId, "Original run extension differs from captured managed public-key identity");
      assert.equal(running.info.profileDir, setup.info.profileDir); assert.notEqual(running.info.runId, setup.info.runId);
      const runs = (await fs.readdir(path.dirname(running.info.runDir))).sort();
      const blocked = await command(argsFor("setup", name), 1); assert.match(blocked.stderr, /managed profile is already supervised or cannot be reserved:/);
      assert.deepEqual((await fs.readdir(path.dirname(running.info.runDir))).sort(), runs); report.run.concurrentSetupRefusal = blocked.stderr;
      assert.ok(running.record.originalProcesses.every(row => !setup.record.originalProcesses.some(old => old.ProcessId === row.ProcessId && old.CreationDate === row.CreationDate)));
      const { connectOpenBrowserUse } = await import(pathToFileURL(path.join(repo, "packages/open-browser-use-js/dist/index.js")));
      sdk = await connectOpenBrowserUse({ socketPath: running.info.socketPath, sessionId: "managed-setup-persistence", turnId: "after-explicit-setup-close", timeoutMs: 10000 });
      taskTab = await sdk.newTab({ url: origin + "/setup-protected", backgroundWindow: true });
      report.authenticated = { tabId: taskTab.id, before: JSON.parse(await taskTab.locator("#state").textContent({ timeoutMs: 5000 })) };
      assert.deepEqual(report.authenticated.before.clicks, []);
      report.authenticated.storage = fixture.verifyStorage(await taskTab.evaluate(`localStorage.getItem(${JSON.stringify(setupStorageKey)})`));
      report.authenticated.submit = { startedAt: Date.now() };
      await taskTab.getByRole("button", { name: "Commit authenticated receipt", exact: true }).click({ timeoutMs: 10000 }); report.authenticated.submit.completedAt = Date.now();
      report.authenticated.receipt = await poll(async () => { const value = await taskTab.locator("#result").textContent({ timeoutMs: 5000 }); return value && JSON.parse(value); }, { label: "one authenticated original POST" });
      report.authenticated.after = JSON.parse(await taskTab.locator("#state").textContent({ timeoutMs: 5000 }));
      assert.equal(report.authenticated.before.documentToken, report.authenticated.after.documentToken);
      report.transaction = assertSetupTransaction(fixture.stats(), report.login.after, report.authenticated.receipt, report.authenticated.after);
      const png = Buffer.from((await taskTab.screenshot({ timeoutMs: 10000 })).base64, "base64"); assert.deepEqual([...png.subarray(0, 8)], [137,80,78,71,13,10,26,10]);
      await fs.writeFile(path.join(runDir, "authenticated-task-receipt.png"), png); report.screenshots.push({ file: "authenticated-task-receipt.png", bytes: png.length, sha256: hash(png), at: Date.now() });
      await finish(running); sdk.close(); sdk = null;
    });
    await step("separate-setup-natural-window-close-without-business-replay", async () => {
      const natural = await start("setup", naturalName); report.naturalSetup = natural.record;
      assert.notEqual(natural.info.profileDir, setup.info.profileDir);
      const human = await actor(natural);
      const denied = await human.page.goto(origin + "/setup-protected", { waitUntil: "domcontentloaded" });
      assert.equal(denied.status(), 401); report.naturalSetup.unrelatedProfileStatus = denied.status();
      report.naturalSetup.preCloseProcesses = descendants(await processTable(), natural.info.browserPID);
      report.naturalSetup.closeAction = { method: "original last page.close; no Browser.close or managed stop", startedAt: Date.now() };
      await human.page.close({ runBeforeUnload: false }); report.naturalSetup.closeAction.completedAt = Date.now();
      await finish(natural, { natural: true });
      assert.ok(natural.record.actorDisconnectedAt);
      report.transaction = assertSetupTransaction(fixture.stats(), report.login.after, report.authenticated.receipt, report.authenticated.after);
    });
  } catch (error) { report.error = redact(error.stack); report.firstFailure ??= { at: Date.now(), error: report.error }; console.error(report.error); }
  finally {
    sdk?.close();
    for (const item of sessions) if (!item.launcher.record.closedAt) {
      try { report.cleanup[`${item.mode}-${item.name}-stop`] = JSON.parse((await command(["managed", "stop", "--root", root, "--name", item.name])).stdout); }
      catch (error) { report.cleanup[`${item.mode}-${item.name}-stopError`] = redact(error.stack); }
      try { await bound(item.launcher.completed, 15000, "original launcher cleanup exit"); }
      catch (error) { report.cleanup[`${item.mode}-${item.name}-exitError`] = redact(error.stack); item.launcher.terminate("acceptance-cleanup"); try { await item.launcher.completed; } catch (error) { report.cleanup[`${item.mode}-${item.name}-forcedError`] = redact(error.stack); } }
    }
    for (const actor of actors) if (actor.isConnected()) report.cleanup.actorStillConnected = true;
    server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve));
    try {
      assert.equal(hash(await fs.readFile(executable)), report.source.executable); assert.equal(hash(await fs.readFile(chromium)), report.source.browser);
      assert.deepEqual(await treeHashes(extension), report.source.extension); assert.deepEqual(await treeHashes(path.join(repo, "packages/open-browser-use-js/dist")), report.source.sdk);
      assert.deepEqual(await treeHashes(path.join(runDir, "extension-input")), report.source.extension); assert.deepEqual(await treeHashes(path.join(runDir, "sdk-input")), report.source.sdk);
      assert.deepEqual(await treeHashes(path.join(runDir, "source-snapshot")), report.source.snapshot);
      for (const [relative, expected] of Object.entries(report.source.snapshot)) assert.equal(hash(await fs.readFile(path.join(repo, relative))), expected, "Original source drift: " + relative);
    } catch (error) { report.cleanup.sourceChanged = redact(error.stack); }
    report.fixture = fixture.stats(); report.liveRunnerChildren = [...registry].map(value => value.pid); report.endedAt = Date.now();
    report.passed = !report.error && report.steps.length === 5 && report.steps.every(value => value.passed) && !Object.keys(report.cleanup).length && !registry.size;
    await save(); console.log("RESULT", JSON.stringify({ runDir, passed: report.passed }));
  }
  return report;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const report = await runManagedSetupCheck(); process.exitCode = report.passed ? 0 : 1;
}
