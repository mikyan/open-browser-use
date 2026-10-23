import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";

export function managedBrowserRestartMode(args) {
  if (!args.length) return "normal";
  assert.equal(args.length, 2, "Use --case normal|crash|crash-established|crash-authenticated|default");
  assert.equal(args[0], "--case");
  assert.ok(["normal", "crash", "crash-established", "crash-authenticated", "default"].includes(args[1]));
  return args[1];
}

export async function readManagedRestartPreferences(file, { lstat = fs.lstat, readFile = fs.readFile } = {}) {
  let info, bytes;
  try {
    info = await lstat(file); assert.ok(info.isFile() && !info.isSymbolicLink(), "Native Preferences must be an ordinary file");
    assert.ok(info.size > 0 && info.size <= 4 * 1024 * 1024, "Native Preferences size is outside the diagnostic bound");
    bytes = await readFile(file);
  } catch (error) { if (error.code === "ENOENT") return { exists: false, observedAt: Date.now() }; throw error; }
  assert.ok(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= 4 * 1024 * 1024);
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  assert.ok(value && typeof value === "object" && !Array.isArray(value), "Native Preferences must contain a JSON object");
  assert.ok(value.profile && typeof value.profile === "object" && !Array.isArray(value.profile));
  const exitType = value.profile.exit_type ?? null;
  assert.ok(exitType === null || ["Normal", "Crashed", "SessionEnded"].includes(exitType), "Unknown native profile exit type");
  return { exists: true, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), exitType, observedAt: Date.now() };
}

export function managedRestartTaskGeneration(generations) {
  const original = generations.filter(generation => generation.number === 1);
  assert.equal(original.length, 1, "Replacement must reference the one original task generation, never profile establishment");
  return original[0];
}

export async function readManagedRestartRunInventory(directory, { readdir = fs.readdir } = {}) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === "ENOENT") return { exists: false, runIds: [], observedAt: Date.now() }; throw error; }
  for (const entry of entries) assert.ok(entry.isDirectory() && !entry.isSymbolicLink() && /^[0-9a-f]{32}$/.test(entry.name), "Unexpected entry in original managed runs directory");
  const runIds = entries.map(entry => entry.name).sort(); assert.equal(new Set(runIds).size, runIds.length);
  return { exists: true, runIds, observedAt: Date.now() };
}

export function classifyManagedRestartStartup({ before, after, terminal, readyObserved }) {
  for (const inventory of [before, after]) {
    assert.equal(typeof inventory?.exists, "boolean"); assert.ok(Array.isArray(inventory.runIds));
    assert.ok(inventory.runIds.every(id => typeof id === "string" && /^[0-9a-f]{32}$/.test(id)));
    assert.equal(new Set(inventory.runIds).size, inventory.runIds.length); if (!inventory.exists) assert.deepEqual(inventory.runIds, []);
  }
  assert.ok(!before.exists || after.exists, "Original runs directory disappeared during startup");
  assert.ok(before.runIds.every(id => after.runIds.includes(id)), "An original run disappeared during startup");
  const created = after.runIds.filter(id => !before.runIds.includes(id)); assert.ok(created.length <= 1, "Startup created ambiguous run directories");
  if (created.length === 1) return { phase: "run-created", runId: created[0] };
  assert.equal(readyObserved, false, "Ready was observed but its run directory is missing");
  assert.ok(Number.isSafeInteger(terminal?.pid) && terminal.pid > 0);
  for (const field of ["startedAt", "exitedAt", "closedAt"]) assert.ok(Number.isSafeInteger(terminal[field]) && terminal[field] > 0, "Original launcher has not actually terminated");
  assert.ok(terminal.startedAt <= terminal.exitedAt && terminal.exitedAt <= terminal.closedAt);
  assert.ok(Number.isSafeInteger(terminal.code) && terminal.code !== 0); assert.equal(terminal.signal, null);
  for (const field of ["spawnError", "termination", "closeIncomplete"]) assert.equal(terminal[field], undefined, "Unknown or forced launcher outcome cannot prove startup before run creation");
  assert.equal(typeof terminal.stdout, "string"); assert.equal(terminal.stdout.trim(), "", "Unexpected startup output cannot establish absence of ready"); assert.equal(typeof terminal.stderr, "string");
  return { phase: "before-run-created", readyObserved: false, lifecycleCreated: false, createdRunIds: [],
    launcher: { pid: terminal.pid, startedAt: terminal.startedAt, exitedAt: terminal.exitedAt, closedAt: terminal.closedAt, code: terminal.code, signal: terminal.signal, stdout: terminal.stdout, stderr: terminal.stderr },
    scope: "Original startup failed before a new run directory was observed. This records lifecycle absence, not successful startup or a claim about unrelated profile resources." };
}

export function assertManagedRestartLaunch(life, restore) {
  assert.equal(life.info.restoreRequested === true, restore);
  assert.ok(life.commandLine.includes("--headless=new"));
  for (const flag of ["--restore-last-session", "--hide-crash-restore-bubble"]) assert.deepEqual(life.commandLine.filter(arg => arg === flag || arg.startsWith(`${flag}=`)), restore ? [flag] : []);
  assert.equal(life.commandLine.includes("about:blank"), !restore);
  assert.equal(life.commandLine.includes("--no-sandbox"), false);
  return { restoreRequested: restore, nativeRestoreFlag: restore, nativeExplicitCrashRestoreFlag: restore, headless: true };
}

export function assertManagedRestartManifest(staged, runtime, previousVersion) {
  const fields = value => ({ version: value.version, version_name: value.version_name, background: value.background });
  const version = value => { assert.match(value, /^(0|[1-9][0-9]*)(\.(0|[1-9][0-9]*)){0,3}$/); const parts = value.split(".").map(Number); assert.ok(parts.some(part => part > 0) && parts.every(part => part <= 65535)); return [...parts, ...Array(4 - parts.length).fill(0)]; };
  const current = version(staged.version); assert.ok(typeof staged.version_name === "string" && staged.version_name); assert.deepEqual(fields(runtime), fields(staged), "Worker loaded a manifest different from this run's staged extension");
  let comparison = null;
  if (previousVersion !== undefined) { const previous = version(previousVersion), firstDifference = current.findIndex((part, index) => part !== previous[index]); assert.notEqual(firstDifference, -1, "Replacement run reused the previous extension cache version"); comparison = { previousVersion, currentVersion: staged.version, direction: current[firstDifference] > previous[firstDifference] ? "increase" : "decrease" }; }
  return { staged: fields(staged), runtime: fields(runtime), comparison };
}

export function selectManagedRestartWorker(info, manifest, targets) {
  assert.match(info.runId, /^[0-9a-f]{32}$/); assert.match(info.extensionId, /^[a-p]{32}$/);
  const entry = manifest.background?.service_worker;
  assert.equal(entry, `managed-worker-${info.runId}.js`, "Staged worker entry must belong to this exact run"); assert.equal(manifest.background.type, "module");
  const url = `chrome-extension://${info.extensionId}/${entry}`;
  const candidates = targets.filter(target => target.type === "service_worker" && target.url === url);
  assert.equal(candidates.length, 1, "Expected one worker at the exact staged entry URL");
  assert.ok(typeof candidates[0].id === "string" && candidates[0].id);
  return { entry, url, target: candidates[0] };
}

export function assertManagedRestartWorkerRuntime(selected, runtimeLocation, previous) {
  assert.equal(runtimeLocation, selected.url, "Connected worker is not executing the staged entry URL");
  assert.equal(selected.target.url, runtimeLocation); assert.equal(selected.target.type, "service_worker");
  if (previous) { assert.notEqual(selected.entry, previous.entry, "Replacement run reused the old worker entry"); assert.notEqual(selected.url, previous.url); assert.notEqual(selected.target.id, previous.targetId); }
  return { entry: selected.entry, url: selected.url, targetId: selected.target.id, runtimeLocation, previousEntry: previous?.entry ?? null };
}

export function assertManagedRestartIdentity(before, after) {
  assert.equal(after.info.profileDir, before.info.profileDir);
  for (const field of ["runId", "runDir", "socketPath", "nativeHostName"]) assert.notEqual(after.info[field], before.info[field], `Old ${field} reused`);
  for (const field of ["browserIncarnation", "workerBootId", "browserRoot"]) {
    assert.ok(typeof before[field] === "string" && before[field]); assert.ok(typeof after[field] === "string" && after[field]);
    assert.notEqual(after[field], before[field], `Old ${field} reused`);
  }
  for (const field of ["browser", "native"]) {
    assert.ok(before[field]?.CreationDate && after[field]?.CreationDate);
    assert.notDeepEqual([after[field].ProcessId, after[field].CreationDate], [before[field].ProcessId, before[field].CreationDate], `Old ${field} process reused`);
  }
  assert.equal(after.info.extensionId, before.info.extensionId);
  return { sameProfile: true, newRun: true, newBrowser: true, newNative: true, newIncarnation: true };
}

export function assertManagedRestartOriginalPosts(stats, before) {
  assert.equal(stats.overflow, false);
  assert.equal(stats.originalPOST.length, 3, "Native restore or driver replayed an original POST");
  const statuses = { prg: 303, cache: 200, "no-store": 200 };
  for (const [kind, status] of Object.entries(statuses)) {
    const posts = stats.originalPOST.filter(row => row.kind === kind); assert.equal(posts.length, 1);
    assert.equal(posts[0].status, status); assert.equal(posts[0].processingError, undefined); assert.equal(posts[0].readError, undefined);
    assert.equal(posts[0].receiptId, stats.receipts[kind]?.receiptId); assert.ok(posts[0].receiptId);
  }
  if (before) { assert.deepEqual(stats.originalPOST, before.originalPOST); for (const kind of Object.keys(statuses)) assert.deepEqual(stats.receipts[kind], before.receipts[kind]); }
  return { originalPOSTs: 3, unchanged: Boolean(before), receiptIds: Object.keys(statuses).map(kind => stats.receipts[kind].receiptId) };
}

export function assertManagedRestartFollowup(stats, originalReceipt, note) {
  assertManagedRestartOriginalPosts(stats);
  assert.equal(stats.followupPOST.length, 1); assert.equal(stats.followupPOST[0].status, 303);
  assert.equal(stats.followupPOST[0].processingError, undefined); assert.equal(stats.followupPOST[0].readError, undefined);
  assert.equal(stats.receipts.followup?.originalReceiptId, originalReceipt.receiptId);
  assert.equal(stats.receipts.followup?.source, "work"); assert.equal(stats.receipts.followup?.note, note);
  assert.equal(stats.followupPOST[0].receiptId, stats.receipts.followup?.receiptId);
  return structuredClone(stats.receipts.followup);
}

export function assertManagedRestartPostLedger(stats, rejected, unexpected, followups) {
  assertManagedRestartOriginalPosts(stats);
  assert.ok(followups === 0 || followups === 1); assert.equal(stats.followupPOST.length, followups);
  assert.equal(rejected.overflow, false); assert.deepEqual(rejected.requests.filter(row => row.method === "POST"), []);
  assert.deepEqual(unexpected.filter(row => row.method === "POST"), []);
  const posts = [...stats.originalPOST, ...stats.followupPOST], requests = stats.requests.filter(row => row.method === "POST");
  assert.equal(requests.length, 3 + followups, "Every POST, including an unclassified or rejected route, must be accounted for");
  for (const rows of [posts, requests]) { assert.ok(rows.every(row => Number.isSafeInteger(row.sequence) && row.sequence > 0)); assert.equal(new Set(rows.map(row => row.sequence)).size, rows.length); }
  for (const post of posts) {
    assert.equal(post.processingError, undefined); assert.equal(post.readError, undefined);
    const request = requests.find(row => row.sequence === post.sequence); assert.ok(request, "POST lacks its original request entry");
    assert.equal(request.search, "");
    for (const key of ["path", "at", "status"]) assert.equal(request[key], post[key], `POST ${key} differs from original request`);
    assert.equal(post.path, new URL(post.kind === "followup" ? stats.urls.followup.work : stats.urls.original[post.kind]).pathname);
    if (post.kind === "followup") { assert.equal(post.source, "work"); assert.equal(post.status, 303); }
  }
  return { originalPOSTs: 3, followupPOSTs: followups, allPOSTs: requests.length, rejectedPOSTs: 0, unclassifiedPOSTs: 0 };
}

function authenticatedLogin(stats, original) {
  assert.equal(stats.overflow, false); const auth = stats.auth;
  assert.equal(auth?.required, true); assert.equal(auth.loginPOST.length, 1, "Authenticated restart must never log in again or rotate its cookie");
  assert.deepEqual(auth.refusals, [], "A rejected authenticated request remains a failed observation");
  assert.deepEqual(auth.requests, stats.requests.filter(row => row.authentication), "Protected requests must retain the complete original server authentication entries");
  const receipt = auth.receipt, post = auth.loginPOST[0];
  assert.equal(receipt?.scenarioId, stats.scenarioId); assert.equal(receipt.loginOperationId, auth.loginOperationId);
  for (const value of [receipt.loginId, receipt.principal, auth.cookieName, auth.cookiePath]) assert.ok(typeof value === "string" && value);
  assert.match(auth.cookieSHA256, /^[0-9a-f]{64}$/); assert.equal(receipt.cookieSHA256, auth.cookieSHA256);
  assert.deepEqual(receipt.cookie, { name: auth.cookieName, path: auth.cookiePath, maxAge: 86400, httpOnly: true, sameSite: "Strict" });
  assert.equal(auth.cookiePath, new URL(stats.urls.work).pathname.slice(0, -"work".length));
  assert.equal(post.status, 303); assert.equal(post.path, new URL(stats.urls.auth.login).pathname);
  assert.equal(post.processingError, undefined); assert.equal(post.readError, undefined); assert.equal(post.truncated, false);
  assert.ok(Number.isSafeInteger(post.sequence) && post.sequence > 0); assert.equal(receipt.loginRequestSequence, post.sequence);
  assert.equal(typeof receipt.issuedAt, "string"); const issuedAt = Date.parse(receipt.issuedAt); assert.ok(Number.isFinite(issuedAt) && issuedAt >= post.at);
  assert.ok(Number.isSafeInteger(post.responseFinishedAt) && post.responseFinishedAt >= issuedAt, "Original login response must have finished before profile establishment");
  assert.equal(post.loginId, receipt.loginId);
  for (const field of ["name", "path", "maxAge", "httpOnly", "sameSite"]) assert.equal(post.setCookie?.[field], receipt.cookie[field]);
  assert.equal(post.setCookie.cookieSHA256, receipt.cookieSHA256);
  for (const field of ["valueSHA256", "headerSHA256"]) assert.match(post.setCookie[field], /^[0-9a-f]{64}$/);
  const requests = stats.requests.filter(row => row.sequence === post.sequence); assert.equal(requests.length, 1);
  assert.equal(requests[0].method, "POST"); assert.equal(requests[0].search, "");
  for (const field of ["path", "at", "status"]) assert.equal(requests[0][field], post[field]);
  if (original) { assert.deepEqual(auth.receipt, original.receipt); assert.deepEqual(auth.loginPOST, original.loginPOST); assert.equal(auth.cookieSHA256, original.cookieSHA256); }
  return post;
}

export function assertManagedRestartAuthenticationSeed(stats, rejected, unexpected) {
  const post = authenticatedLogin(stats);
  assert.deepEqual(stats.originalPOST, []); assert.deepEqual(stats.followupPOST, []); assert.deepEqual(stats.receipts, { prg: null, cache: null, "no-store": null, followup: null });
  assert.equal(rejected.overflow, false); assert.deepEqual(rejected.requests.filter(row => row.method === "POST"), []); assert.deepEqual(unexpected.filter(row => row.method === "POST"), []);
  assert.deepEqual(stats.requests.filter(row => row.method === "POST").map(row => row.sequence), [post.sequence]);
  return { loginPOSTs: 1, originalPOSTs: 0, followupPOSTs: 0, allPOSTs: 1, rejectedGETs: rejected.requests.filter(row => row.method === "GET").length,
    unexpectedGETs: unexpected.filter(row => row.method === "GET").length, loginId: stats.auth.receipt.loginId, cookieSHA256: stats.auth.cookieSHA256 };
}

export function assertManagedRestartAuthenticatedPostLedger(stats, rejected, unexpected, followups, originalAuth) {
  assert.ok(originalAuth?.receipt, "Business must retain the originally established login evidence");
  const login = authenticatedLogin(stats, originalAuth);
  const result = assertManagedRestartPostLedger({ ...stats, requests: stats.requests.filter(row => row.sequence !== login.sequence) }, rejected, unexpected, followups);
  for (const post of [...stats.originalPOST, ...stats.followupPOST]) {
    const request = stats.requests.find(row => row.sequence === post.sequence), authentication = request.authentication;
    assert.equal(authentication?.required, true); assert.equal(authentication.accepted, true);
    assert.equal(authentication.loginId, stats.auth.receipt.loginId); assert.equal(authentication.cookieSHA256, stats.auth.cookieSHA256);
  }
  return { ...result, loginPOSTs: 1, businessPOSTs: result.allPOSTs, allPOSTs: result.allPOSTs + 1, loginId: stats.auth.receipt.loginId };
}

export function assertManagedRestartAuthentication(document, stats, originalAuth, generationStartedAt) {
  authenticatedLogin(stats, originalAuth);
  assert.ok(Number.isSafeInteger(generationStartedAt) && generationStartedAt > 0);
  assert.ok(typeof document.serverAuthText === "string" && document.serverAuthText, "A page label or URL cannot prove server authentication");
  const proof = JSON.parse(document.serverAuthText), receipt = stats.auth.receipt, url = new URL(document.url);
  assert.equal(url.search, ""); assert.equal(url.hash, ""); assert.equal(url.origin, new URL(stats.urls.work).origin);
  assert.equal(proof.authenticated, true); assert.equal(proof.scenarioId, stats.scenarioId);
  for (const field of ["loginId", "principal", "loginRequestSequence", "cookieSHA256"]) assert.equal(proof[field], receipt[field]);
  assert.equal(proof.requestMethod, "GET"); assert.equal(proof.requestPath, url.pathname);
  assert.ok(Number.isSafeInteger(proof.requestSequence) && proof.requestSequence > receipt.loginRequestSequence);
  const requests = stats.requests.filter(row => row.sequence === proof.requestSequence); assert.equal(requests.length, 1);
  const request = requests[0]; assert.equal(request.method, "GET"); assert.equal(request.path, url.pathname); assert.equal(request.search, ""); assert.equal(request.status, 200);
  assert.ok(Number.isSafeInteger(request.at) && request.at >= generationStartedAt, "Cached old authentication HTML does not prove this browser generation sent the cookie");
  assert.equal(request.authentication?.required, true); assert.equal(request.authentication.accepted, true);
  assert.equal(request.authentication.loginId, receipt.loginId); assert.equal(request.authentication.cookieSHA256, receipt.cookieSHA256);
  assert.ok(Array.isArray(document.cookieNames)); assert.equal(document.cookieNames.includes(stats.auth.cookieName), false, "HttpOnly login must not be exposed by document.cookie");
  return { proof, serverRequest: structuredClone(request), generationStartedAt, httpOnlyAbsentFromDocumentCookie: true, loginUnchanged: true };
}

export function assertManagedRestartNativeTarget(observation, tabId, previous) {
  assert.equal(observation.overflow, false); assert.ok(Number.isSafeInteger(tabId));
  assert.equal(observation.tabs.filter(row => row.id === tabId).length, 1, "Expected exactly one current native tab");
  const targets = observation.targets.filter(row => row.tabId === tabId); assert.equal(targets.length, 1, "Native tab must bind exactly one target by tabId");
  const target = targets[0]; assert.ok(typeof target.id === "string" && target.id);
  if (previous) { assert.ok(typeof previous.id === "string" && previous.id); assert.notEqual(target.id, previous.id, "Original native target reused after Browser replacement"); }
  return structuredClone(target);
}

// A restored native tab can exist before its document loads. Observing readiness
// never activates it, navigates it, attaches a debugger or replays an operation.
export function managedRestartDocumentReady(observation, expected) {
  assert.ok(Number.isSafeInteger(expected.tabId) && expected.tabId > 0);
  assert.ok(typeof expected.targetId === "string" && expected.targetId);
  const url = new URL(expected.url); assert.ok(["http:", "https:"].includes(url.protocol));
  const tabs = observation.tabs.filter(tab => tab.id === expected.tabId);
  const targets = observation.targets.filter(target => target.tabId === expected.tabId);
  assert.equal(tabs.length, 1, "The original restored tab disappeared or became ambiguous");
  assert.equal(targets.length, 1, "The original restored native target disappeared or became ambiguous");
  const tab = tabs[0], target = targets[0];
  assert.equal(target.id, expected.targetId, "Readiness cannot select a replacement native target");
  assert.ok(["unloaded", "loading", "complete"].includes(tab.status), "Unknown restored tab status");
  assert.equal(tab.url, expected.url, "Restored tab navigated away while awaiting its document");
  assert.ok(!tab.pendingUrl || tab.pendingUrl === expected.url, "Restored tab has an unrelated pending navigation");
  assert.equal(target.url, expected.url, "Restored target URL changed while awaiting its document");
  return tab.status === "complete" && !tab.pendingUrl && !tab.discarded;
}

export function assertManagedRestartFinalResults(observation, viewerState, expected, oldDeliveries) {
  assert.equal(expected.length, 2); assert.equal(new Set(expected.map(row => row.id)).size, 2);
  assert.equal(new Set(expected.map(row => row.deliveryId)).size, 2);
  const oldIDs = new Set(oldDeliveries.map(row => row.deliveryId)); assert.equal(oldIDs.size, oldDeliveries.length);
  for (const entry of expected) {
    assert.equal(entry.kind, "result"); assert.equal(entry.watchable, true); assert.ok(typeof entry.deliveryId === "string" && entry.deliveryId);
    assert.equal(oldIDs.has(entry.deliveryId), false, "Old delivery capability inherited by replacement run");
    const tabs = observation.tabs.filter(row => row.id === entry.id); assert.equal(tabs.length, 1, "Final deliverable tab disappeared or duplicated"); assert.equal(tabs[0].active, false);
  }
  assert.equal(new Set(viewerState.tabs.map(row => row.id)).size, viewerState.tabs.length);
  const order = rows => [...rows].sort((a, b) => a.id - b.id);
  assert.deepEqual(order(viewerState.tabs.filter(row => row.kind === "result")), order(expected), "Viewer must contain exactly the two new delivery records");
  for (const row of viewerState.tabs) if (row.deliveryId !== undefined) assert.equal(oldIDs.has(row.deliveryId), false);
  return { resultTabIds: expected.map(row => row.id), deliveryIds: expected.map(row => row.deliveryId), oldDeliveryInherited: false };
}

export function assertManagedRestartDefaultEmpty(observation, oldURLs) {
  assert.equal(observation.overflow, false);
  const old = new Set(oldURLs); assert.ok(old.size > 0);
  assert.deepEqual(observation.tabs.filter(row => old.has(row.url) || old.has(row.pendingUrl)), [], "Default run restored an old task tab");
  assert.deepEqual(observation.targets.filter(row => old.has(row.url)), [], "Default run restored an old task target");
  return { restoredTaskTabs: 0, restoredTaskTargets: 0 };
}

export function assertManagedRestartRestoredDraft(document, draft, mode) {
  assert.ok(["normal", "crash", "crash-established", "crash-authenticated"].includes(mode));
  assert.equal(document.persistent, draft); assert.equal(document.memory, "未暂存");
  assert.equal(typeof document.cookie, "string");
  if (mode !== "crash-authenticated") assert.equal(document.cookie, draft, "Original mode still requires its newly written draft cookie");
  return { persistent: document.persistent, memory: document.memory, draftCookie: document.cookie,
    newDraftCookiePreserved: document.cookie === draft, newDraftCookieRequired: mode !== "crash-authenticated",
    scope: mode === "crash-authenticated" ? "New draft cookie is an observation only; authenticated recovery separately requires the previously established HttpOnly login." : "Original draft, cookie and memory assertions unchanged." };
}

export function assertManagedRestartCrashTerminal(life, info, evidence) {
  assert.equal(life.version, 1); assert.equal(life.state, "closed"); assert.deepEqual(life.info, info);
  assert.ok(life.readyAt && life.endedAt); assert.equal(life.forced, false, "Crash cleanup required forced Job termination");
  assert.ok(Number.isSafeInteger(life.browserExit?.code) && life.browserExit.code !== 0, "Original Browser crash must have an actual nonzero process exit");
  assert.ok(Number.isFinite(Date.parse(life.browserExit.at)));
  const browserError = `managed process exited with code ${life.browserExit.code}`;
  assert.equal(life.browserExit.error, browserError, "Browser exit error must be its exact original nonzero process exit");
  const requiredErrors = [browserError], optionalErrors = [];
  let browserCloseFault = null;
  assert.ok(Number.isFinite(Date.parse(life.browserClose?.at)));
  if (life.browserClose.error !== undefined) {
    // Narrow, source-derived transport endings only. An unfamiliar first crash
    // remains a failed observation until its exact original error is reviewed.
    const known = new Set(["EOF", "unexpected EOF", "failed to get reader: failed to read frame header: EOF", "failed to get reader: failed to read frame header: unexpected EOF", "failed to write msg: use of closed network connection"]);
    if (!known.has(life.browserClose.error)) {
      // First observed Windows Browser.crash: coder/websocket Write -> frame
      // -> flush, followed by net.OpError's actual original loopback endpoints.
      // This is not a generic wsasend or transport-error exemption.
      const reset = /^failed to write msg: failed to write frame: failed to flush: write tcp 127\.0\.0\.1:([1-9][0-9]{0,4})->127\.0\.0\.1:([1-9][0-9]{0,4}): wsasend: An existing connection was forcibly closed by the remote host\.$/.exec(life.browserClose.error);
      assert.ok(reset && reset[0] === life.browserClose.error, "Unclassified Browser.close failure");
      const localPort = Number(reset[1]), remotePort = Number(reset[2]); assert.ok(localPort <= 65535 && remotePort <= 65535);
      assert.ok(typeof evidence?.browserRoot === "string" && evidence.browserRoot);
      const original = new URL(evidence.browserRoot); assert.equal(original.protocol, "ws:"); assert.equal(original.hostname, "127.0.0.1"); assert.equal(original.username, ""); assert.equal(original.password, ""); assert.equal(original.search, ""); assert.equal(original.hash, ""); assert.match(original.pathname, /^\/devtools\/browser\/[a-zA-Z0-9-]+$/);
      assert.equal(remotePort, Number(original.port || "80"), "Reset belongs to another Browser endpoint");
      const crash = evidence.crash; assert.equal(crash?.command, "Browser.crash"); assert.equal(crash.submissions, 1); assert.equal(crash.originalBrowserRoot, evidence.browserRoot);
      const readyAt = Date.parse(life.readyAt), exitedAt = Date.parse(life.browserExit.at), closeAt = Date.parse(life.browserClose.at);
      assert.ok(Number.isSafeInteger(crash.submittedAt) && crash.submittedAt > 0 && Number.isFinite(readyAt));
      assert.ok(readyAt <= crash.submittedAt && crash.submittedAt <= exitedAt && exitedAt <= closeAt, "Reset lacks original crash -> actual exit -> Browser.close ordering");
      browserCloseFault = { kind: "original-browser-crash-windows-remote-reset", localPort, remotePort, originalBrowserRoot: evidence.browserRoot, crashSubmittedAt: crash.submittedAt, browserExitedAt: life.browserExit.at, closeSettledAt: life.browserClose.at };
    }
    requiredErrors.unshift(`managed Browser.close was not acknowledged: ${life.browserClose.error}`);
  } else assert.deepEqual(life.browserClose.result, {});
  assert.ok(Array.isArray(life.nativeConnections) && life.nativeConnections.length > 0);
  const cleanupProofs = [];
  for (const native of life.nativeConnections) {
    assert.equal(native.exitConfirmed, true); assert.ok(Number.isSafeInteger(native.exit?.code)); assert.ok(Number.isFinite(Date.parse(native.exit.at)));
    assert.equal(native.error, undefined); assert.ok(Number.isSafeInteger(native.epoch) && native.epoch > 0);
    assert.equal(native.exit.error, native.exit.code === 0 ? undefined : `managed process exited with code ${native.exit.code}`);
    if (native.exit.code !== 0) optionalErrors.push(`native connection ${native.epoch} exited during Stop with code ${native.exit.code}`);
    const cleanup = native.controllerCleanup; assert.ok(Number.isFinite(Date.parse(cleanup?.at))); assert.equal(cleanup.error, undefined);
    const result = cleanup.result; assert.equal(result?.status?.connected, false); assert.equal(result.status.selectedTabId, null); assert.ok(result.status.cleanupError === undefined || result.status.cleanupError === null);
    if (result.disconnected === true) {
      assert.equal(result.cleanupProof, undefined); const status = result.status;
      assert.equal(status.runId, info.runId); assert.equal(status.extensionId, info.extensionId);
      for (const field of ["extensionInstanceId", "workerBootId", "portId"]) { assert.ok(native.binding?.[field]); assert.equal(status[field], native.binding[field]); }
      assert.deepEqual(status.tabs, []); assert.equal(status.cleanupPending, 0); assert.equal(status.automation?.cleanupComplete, true);
      for (const field of ["human", "view", "pendingDialog", "pendingFileChooser"]) assert.equal(status[field], null);
      assert.deepEqual(status.stream, { state: "idle", streamId: null }); cleanupProofs.push("original-worker-acknowledgement");
    } else if (result.cleanupProof === "worker-execution-ended") {
      assert.equal(result.transportRetired, true); assert.equal(result.cleanupConfirmed, false);
      const ended = native.executionEnd; assert.ok(Number.isFinite(Date.parse(ended?.at)));
      assert.ok(["Target.targetDestroyed", "Runtime.executionContextDestroyed", "Runtime.executionContextsCleared"].includes(ended.method));
      assert.ok(typeof ended.sessionId === "string" && ended.sessionId);
      for (const field of ["targetId", "contextUniqueId", "workerBootId", "contextId"]) { assert.ok(native.worker?.[field]); assert.equal(ended[field], native.worker[field]); }
      cleanupProofs.push("transport-retired-and-original-job-empty");
    } else {
      assert.equal(result.cleanupConfirmed, true); assert.ok(["worker-terminated", "session-terminated"].includes(result.cleanupProof)); cleanupProofs.push(result.cleanupProof);
    }
  }
  assert.deepEqual(life.nativeExit, life.nativeConnections.at(-1).exit);
  for (const name of ["jobEmpty", "registrationCleanup", "endpointCleanup"]) {
    assert.ok(Number.isFinite(Date.parse(life[name]?.at)), `Missing ${name} actual receipt`); assert.equal(life[name].error, undefined);
  }
  assert.deepEqual(life.jobEmpty.result, { activeProcesses: 0 });
  assert.ok(typeof life.error === "string" && life.error, "Do not erase the original crash outcome");
  const errors = life.error.split("\n"); assert.equal(new Set(errors).size, errors.length);
  for (const expected of requiredErrors) assert.ok(errors.includes(expected), `Original fault missing: ${expected}`);
  assert.ok(errors.every(error => requiredErrors.includes(error) || optionalErrors.includes(error)), "Unknown lifecycle failure cannot be hidden by the original crash");
  return { originalCrashPreserved: true, originalNativeExitsConfirmed: true, originalJobEmpty: true, cleanupProofs, browserCloseFault };
}

// Serialized into the existing owned extension for read-only current DOM evidence.
// Access failure (including chrome-error pages) is retained by the caller.
export function readManagedRestartDocument() {
  const text = selector => document.querySelector(selector)?.textContent ?? null;
  let cookieNames = null;
  try { cookieNames = document.cookie.split(";").map(pair => pair.trim().split("=", 1)[0]).filter(Boolean); } catch { /* Browser-owned error pages may deny cookie reads. */ }
  return { url: location.href, title: document.title, visibility: document.visibilityState, hasFocus: document.hasFocus(),
    documentInstance: text("#document-instance"), persistent: text("#persistent-status"), cookie: text("#cookie-status"), memory: text("#memory-status"),
    serverAuthText: text("#server-auth-json"), cookieNames, receiptText: text("#receipt-json"), body: document.body?.innerText.slice(0, 12000) ?? null };
}
