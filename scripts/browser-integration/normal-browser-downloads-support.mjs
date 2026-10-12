import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import path from "node:path";
import fs from "node:fs/promises";
import { performance } from "node:perf_hooks";
import WebSocket from "ws";
import { checkBrowserProcess, windowsCommandArguments } from "./native-browser-installation.mjs";

export const normalBindBudgetMs = 120000;
export const normalInspectURL = "edge://inspect/#remote-debugging";
const normalized = value => path.win32.resolve(value).toLowerCase();
export const normalStartArguments = profile => [`--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", normalInspectURL];

const profileMetadataLimit = 8 * 1024 * 1024;
const metadataObject = value => value !== null && typeof value === "object" && !Array.isArray(value);

// Only these fixed field names and boolean/count summaries can leave the reader.
// In particular JSON parser errors, account-map keys and arbitrary string values
// are never returned. Datatype defaults do not prove an account or sync session.
export function summarizePrivateProfileAccounts(localState, preferences) {
  const observations = [], invalid = [], contaminated = [];
  const field = (root, source, name, type, authoritative = true) => {
    let value = root;
    for (const part of name.split(".")) {
      if (value === undefined) break;
      if (!metadataObject(value)) { invalid.push(`${source}.${name}`); return; }
      value = Object.hasOwn(value, part) ? value[part] : undefined;
    }
    const item = { field: `${source}.${name}`, present: value !== undefined, authoritative };
    if (value !== undefined) {
      const valid = type === "boolean" ? typeof value === "boolean" : type === "array" ? Array.isArray(value) : type === "object" ? metadataObject(value) : typeof value === "string";
      if (!valid) { invalid.push(item.field); return; }
      if (type === "boolean") item.value = value;
      else if (type === "string") item.nonempty = value.length > 0;
      else item.count = Object.keys(value).length;
      if (authoritative && (item.value === true || item.nonempty === true || item.count > 0)) contaminated.push(item.field);
    }
    observations.push(item);
  };
  // Both files must be initialized profile metadata, not an empty/default JSON
  // object manufactured by a failed read. Optional sign-in fields can be absent.
  for (const [source, value, initialized] of [
    ["localState", localState, metadataObject(localState?.profile?.info_cache?.Default)],
    ["preferences", preferences, metadataObject(preferences?.profile)]
  ]) if (!metadataObject(value) || !initialized) invalid.push(`${source}.profile-initialization`);
  for (const [source, value, name, type] of [
    ["localState", localState, "profile.info_cache.Default.is_consented_primary_account", "boolean"],
    ["localState", localState, "profile.info_cache.Default.edge_sync_enabled", "boolean"],
    ["localState", localState, "profile.info_cache.Default.gaia_id", "string"],
    ["localState", localState, "profile.info_cache.Default.user_name", "string"],
    ["localState", localState, "profiles.edge_implicitly_signed_in", "array"],
    ["localState", localState, "signin.active_accounts", "object"],
    ["preferences", preferences, "account_info", "array"],
    ["preferences", preferences, "signin.accounts_metadata_dict", "object"],
    ["preferences", preferences, "sync_consent_recorded", "boolean"],
    ["preferences", preferences, "sync.has_been_enabled", "boolean"],
    ["preferences", preferences, "sync.has_setup_completed", "boolean"],
    ["preferences", preferences, "sync.gaia_id", "string"],
    ["preferences", preferences, "sync.transport_data_per_account", "object"]
  ]) field(value, source, name, type);
  for (const name of ["keep_everything_synced", "apps", "autofill", "bookmarks", "extensions", "passwords", "preferences", "tabs", "typed_urls"])
    field(preferences, "preferences", `sync.${name}`, "boolean", false);
  return { version: 1, status: invalid.length ? "unavailable" : contaminated.length ? "contaminated" : "clean", observations, invalid, contaminated };
}

async function readProfileMetadata(file) {
  const handle = await fs.open(file, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 2 || stat.size > profileMetadataLimit) throw new Error("metadata-size");
    const buffer = Buffer.alloc(stat.size + 1), result = await handle.read(buffer, 0, buffer.length, 0);
    if (result.bytesRead !== stat.size || (await handle.stat()).size !== stat.size) throw new Error("metadata-changed");
    return buffer.subarray(0, result.bytesRead);
  } finally { await handle.close(); }
}

export async function readPrivateProfileAccountState(profile, { readMetadata = readProfileMetadata } = {}) {
  const values = [], files = [];
  for (const relative of ["Local State", "Default/Preferences"]) {
    try {
      const bytes = await readMetadata(path.join(profile, relative));
      if (!(typeof bytes === "string" || Buffer.isBuffer(bytes)) || Buffer.byteLength(bytes) < 2 || Buffer.byteLength(bytes) > profileMetadataLimit) throw new Error("metadata-size");
      values.push(JSON.parse(String(bytes)));
      files.push({ file: relative, readable: true, bytes: Buffer.byteLength(bytes) });
    } catch {
      // Even JSON.parse's error message can quote an account/token value.
      values.push(undefined); files.push({ file: relative, readable: false });
    }
  }
  const result = summarizePrivateProfileAccounts(...values);
  return { ...result, checkedAt: Date.now(), files };
}

export function assertPrivateProfileAccountState(value) {
  if (value.status !== "clean") throw new Error(value.status === "contaminated"
    ? "OBU_NORMAL_PROFILE_ACCOUNT_CONTAMINATED: private profile has account or sync-session metadata; business verification is forbidden"
    : "OBU_NORMAL_PROFILE_ACCOUNT_UNAVAILABLE: initialized private profile metadata could not be verified");
  return value;
}

export function assertFixtureExtensionInventory(value, expectedIds) {
  const expected = new Set(expectedIds), entries = value?.extensions;
  const fixture = Array.isArray(entries) ? entries.filter(item => metadataObject(item) && expected.has(item.id)) : [];
  const summary = { totalCount: Array.isArray(entries) ? entries.length : null, fixtureCount: fixture.length,
    unknownCount: Array.isArray(entries) ? entries.length - fixture.length : null };
  if (expected.size !== 2 || !metadataObject(value) || Object.keys(value).some(key => key !== "extensions") ||
      !Array.isArray(entries) || entries.length !== 2 || fixture.length !== 2 || new Set(fixture.map(item => item.id)).size !== 2 || fixture.some(item => item.enabled !== true))
    throw Object.assign(new Error("OBU_NORMAL_EXTENSION_INVENTORY: exactly the two enabled fixture extensions are required; unexpected extension metadata was not retained"), { inventory: summary });
  return value;
}

export function assertNormalProcess(row, { profile, executable, browserPid }) {
  checkBrowserProcess(row, { profileRoot: profile, browserPid });
  assert.equal(normalized(row.ExecutablePath), normalized(executable), "Normal browser executable changed");
  const args = windowsCommandArguments(row.CommandLine);
  assert.equal(normalized(args[0]), normalized(executable));
  assert.deepEqual(args.slice(1), normalStartArguments(profile), "Normal startup has unexpected arguments; bootstrap/debugging flags are forbidden");
  return row;
}

export function parsePrivateDevToolsPort(text) {
  assert.ok(typeof text === "string" && Buffer.byteLength(text) <= 4096);
  const match = /^([1-9][0-9]{0,4})\r?\n(\/devtools\/browser\/[A-Za-z0-9._~-]{1,256})(\r?\n)?$/.exec(text);
  assert.ok(match, "Private DevToolsActivePort must have exactly two lines");
  const port = Number(match[1]); assert.ok(port <= 65535);
  return { port, browserPath: match[2], url: `ws://127.0.0.1:${port}${match[2]}` };
}

// A stale PID/parent PID alone never establishes ownership. Preserve exact
// identities while a root is live, so its genuine orphaned children can still
// be checked after exit without adopting a later PID reuse.
export function classifyPrivateProcesses(rows, { profile, browserBinary, nativeExecutable, extensionId, systemRoot = process.env.SystemRoot ?? "C:\\Windows", roots = [], known = [] }) {
  assert.ok(path.win32.isAbsolute(browserBinary), "An explicit original browser executable is required");
  const same = (a, b) => a.ProcessId === b.ProcessId && a.CreationDate === b.CreationDate && a.ExecutablePath && b.ExecutablePath && normalized(a.ExecutablePath) === normalized(b.ExecutablePath);
  const stillUnknown = (a, b) => a.ProcessId === b.ProcessId && (!a.CreationDate || !b.CreationDate || !a.ExecutablePath || !b.ExecutablePath) &&
    (!a.CreationDate || !b.CreationDate || a.CreationDate === b.CreationDate) &&
    (!a.ExecutablePath || !b.ExecutablePath || normalized(a.ExecutablePath) === normalized(b.ExecutablePath));
  const related = new Map(), reasons = new Map(), browserDirectory = path.win32.dirname(normalized(browserBinary));
  const complete = row => path.win32.isAbsolute(row.ExecutablePath ?? "") && Number.isFinite(Date.parse(row.CreationDate)) && typeof row.CommandLine === "string" && row.CommandLine.length > 0;
  const browser = row => row.ExecutablePath && normalized(row.ExecutablePath) === normalized(browserBinary);
  const native = row => row.ExecutablePath && nativeExecutable && normalized(row.ExecutablePath) === normalized(nativeExecutable);
  const privateProfile = row => row.CommandLine?.includes(profile) && windowsCommandArguments(row.CommandLine).includes(`--user-data-dir=${profile}`);
  const inBrowserDirectory = row => {
    if (!path.win32.isAbsolute(row.ExecutablePath ?? "")) return false;
    const relative = path.win32.relative(browserDirectory, normalized(row.ExecutablePath));
    return relative !== ".." && !relative.startsWith("..\\") && !path.win32.isAbsolute(relative);
  };
  const nativeWrapper = row => {
    if (!nativeExecutable || !/^[a-p]{32}$/.test(extensionId ?? "") || !row.ExecutablePath || normalized(row.ExecutablePath) !== normalized(path.win32.join(systemRoot, "System32/cmd.exe"))) return false;
    // This is cmd's actual native-messaging /d /s /c command, not argv quoting.
    // Require the original native executable to be the first executed command,
    // followed only by the observed extension/parent/paired-pipe arguments.
    const match = /^(?:"([^"]+)"|([^\s"]+))\s+\/d\s+\/s\s+\/c\s+""([^"]+)"\s+chrome-extension:\/\/([a-p]{32})\/\s+--parent-window=\d+"\s+<\s+\\\\\.\\pipe\\chrome\.nativeMessaging\.in\.([0-9a-f]+)\s+>\s+\\\\\.\\pipe\\chrome\.nativeMessaging\.out\.\5\s*$/i.exec(row.CommandLine ?? "");
    return !!match && normalized(match[1] ?? match[2]) === normalized(row.ExecutablePath) && normalized(match[3]) === normalized(nativeExecutable) && match[4] === extensionId;
  };
  for (const row of rows) {
    const exact = [...roots, ...known].some(value => same(row, value) || stillUnknown(row, value));
    if (exact || privateProfile(row) || native(row)) { related.set(row.ProcessId, row); reasons.set(row.ProcessId, exact ? "exact recorded process identity" : native(row) ? "exact staged native executable" : "exact private profile argument"); }
  }
  let changed = true;
  while (changed) { changed = false; for (const row of rows) {
    const parent = related.get(row.ParentProcessId);
    if (!parent || related.has(row.ProcessId)) continue;
    if (Number.isFinite(Date.parse(row.CreationDate)) && Date.parse(row.CreationDate) < Date.parse(parent.CreationDate)) continue;
    related.set(row.ProcessId, row); reasons.set(row.ProcessId, "descendant of a currently observed related process"); changed = true;
  } }
  const owned = [], externalDescendants = [], unknownDescendants = [], ownership = new Map();
  // Reassess the executable role even for previously recorded identities. An
  // input method or shell launched by Edge does not become test-owned history.
  for (let pending = [...related.values()]; pending.length;) {
    let advanced = false;
    for (const row of [...pending]) {
      if (related.has(row.ParentProcessId) && !ownership.has(row.ParentProcessId)) continue;
      let role, reason;
      const history = known.find(value => same(row, value));
      const originalRoot = roots.some(value => same(row, value));
      const ownerParent = ["browser", "native-host", "native-launcher"].includes(ownership.get(row.ParentProcessId));
      if (!complete(row)) { role = "unknown"; reason = "Related process identity is incomplete"; }
      else if (native(row)) { role = "native-host"; reason = "Exact private staged native executable"; }
      else if (browser(row) && (privateProfile(row) || originalRoot || ownerParent || history && [undefined, "browser"].includes(history.privateProcessRole))) { role = "browser"; reason = "Exact original browser executable and private profile/parent/recorded identity"; }
      else if (nativeWrapper(row) && (ownerParent || history && [undefined, "native-launcher"].includes(history.privateProcessRole))) { role = "native-launcher"; reason = "System cmd launches the exact native executable as its sole first command"; }
      else if (inBrowserDirectory(row)) { role = "unknown"; reason = "Related process in the browser installation has an unverified role"; }
      else { role = "external"; reason = "Executable is outside the verified browser/native roles; not test-owned and left running"; }
      ownership.set(row.ProcessId, role);
      const entry = { process: row, role, reason, association: reasons.get(row.ProcessId), ...(role === "external" && { leftUntouched: true }) };
      (role === "unknown" ? unknownDescendants : role === "external" ? externalDescendants : owned).push(entry);
      pending = pending.filter(value => value !== row); advanced = true;
    }
    if (!advanced) { for (const row of pending) unknownDescendants.push({ process: row, role: "unknown", reason: "Related process ancestry could not be resolved", association: reasons.get(row.ProcessId) }); break; }
  }
  return { owned, externalDescendants, unknownDescendants };
}

export function selectPrivateProcesses(rows, options) {
  const value = classifyPrivateProcesses(rows, options);
  return [...value.owned, ...value.unknownDescendants].map(entry => entry.process);
}

export function privateInventoryFailure(error) {
  const source = error.result ?? {}, result = {};
  for (const field of ["pid", "startedAt", "exitedAt", "closedAt", "code", "signal", "termination", "closeIncomplete"]) if (source[field] !== undefined) result[field] = source[field];
  for (const field of ["stdout", "stderr"]) if (typeof source[field] === "string") result[field] = { bytes: Buffer.byteLength(source[field]), sha256: createHash("sha256").update(source[field]).digest("hex") };
  return Object.assign(new Error("Private CIM inventory failed; unrelated command-line output was not retained"), { result });
}

export function assertNativeInfo(info, { extensionId, nativeName }) {
  assert.equal(info?.type, "extension");
  assert.equal(info.metadata?.extensionId, extensionId);
  assert.equal(info.metadata?.nativeHostName, nativeName);
  assert.ok(typeof info.metadata?.extensionInstanceId === "string" && info.metadata.extensionInstanceId.length > 0);
  return info;
}

export function assertBindingAck(command, { extensionId, instanceId }) {
  assert.equal(command.code, 0); assert.ok(command.closedAt >= command.startedAt && command.exitedAt >= command.startedAt);
  assert.equal(command.termination, undefined, "A terminated CLI cannot acknowledge binding");
  const reply = JSON.parse(command.stdout);
  assert.equal(reply.jsonrpc, "2.0"); assert.equal(reply.error, undefined);
  const result = reply.result;
  assert.equal(result?.bound, true); assert.equal(result.exclusive, true); assert.equal(result.behavior, "default");
  assert.equal(result.extensionId, extensionId); assert.equal(result.extensionInstanceId, instanceId);
  for (const field of ["generation", "workerBootId", "portId"]) assert.ok(typeof result[field] === "string" && result[field].length > 0);
  return reply;
}

export function assertOriginalHostExit(original, hostExits) {
  if (!original) return;
  const expected = original.identity.process;
  const values = (hostExits ?? []).filter(value => value.process.ProcessId === expected.ProcessId && value.process.CreationDate === expected.CreationDate && value.process.ExecutablePath === expected.ExecutablePath);
  assert.equal(values.length, 1, "Original native host lacks its exact retained-handle exit evidence");
  const value = values[0]; assert.equal(value.error, undefined); assert.equal(value.ready.pid, expected.ProcessId); assert.equal(value.ready.exactHandle, true);
  assert.equal(value.result.pid, expected.ProcessId); assert.equal(value.result.exactHandle, true); assert.equal(value.result.exitCode, 0);
  assert.ok(value.result.exitedAt >= value.ready.readyAt);
}

export function normalRunOutcome(report) {
  const isolation = report.profileAccountIsolation;
  const cleanProfile = isolation?.status === "clean" && Array.isArray(isolation.checks) && ["post-bootstrap", "pre-handoff", "pre-bind", "pre-business", "post-business"]
    .every(stage => isolation.checks.some(check => check.stage === stage && check.status === "clean")) && isolation.checks.every(check => check.status === "clean");
  const passed = report.task?.verified === true && !report.error && !report.stopped &&
    report.bootstrap?.shutdown?.complete === true && report.normal?.commandVerified === true &&
    report.binding?.verified === true && cleanProfile && report.cleanup?.complete === true;
  return { passed, status: passed ? "completed" : report.error || report.cleanup?.complete !== true ? "failed" : "stopped", exitCode: passed || report.stopped && !report.error && report.cleanup?.complete === true ? 0 : 1 };
}

export function bound(promise, ms, label) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms); })]).finally(() => clearTimeout(timer));
}
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function poll(read, { timeoutMs = 15000, intervalMs = 100, signal, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  do {
    signal?.throwIfAborted();
    const value = await read(); if (value) return value;
    if (Date.now() >= deadline) break;
    await sleep(Math.min(intervalMs, Math.max(1, deadline - Date.now())));
  } while (true);
  throw new Error(`${label} timed out`);
}

// Teardown failures are often the most useful evidence. A second cleanup
// attempt must never replace the original close ACK, exact EOF or failed poll.
export function beginShutdownAttempt(runtimeRecord, method) {
  const value = { requestedAt: Date.now(), method, complete: false };
  if (runtimeRecord.shutdown) (runtimeRecord.cleanupShutdownAttempts ??= []).push(value);
  else runtimeRecord.shutdown = value;
  return value;
}

export async function waitPrivateProcessesGone(read, { record, persist, timeoutMs = 15000, intervalMs = 100, label = "all exact private browser/native processes gone" }) {
  Object.assign(record, { requestedAt: Date.now(), timeoutMs, samples: [] });
  try {
    const result = await poll(async () => {
      const requestedAt = Date.now(), value = await read();
      const classification = Array.isArray(value) ? null : value;
      const rows = classification ? [...classification.owned, ...classification.unknownDescendants].map(entry => entry.process) : value;
      assert.ok(Array.isArray(rows));
      record.lastRows = structuredClone(rows); record.lastObservedAt = Date.now();
      if (classification) record.lastClassification = structuredClone(classification);
      record.samples.push({ requestedAt, completedAt: record.lastObservedAt, rows: structuredClone(rows), ...(classification && { classification: structuredClone(classification) }) });
      await persist();
      return rows.length === 0 && rows;
    }, { timeoutMs, intervalMs, label });
    record.complete = true; record.completedAt = Date.now(); return result;
  } catch (error) { record.complete = false; record.failedAt = Date.now(); record.error = error.message; throw error; }
  finally { await persist(); }
}

export async function awaitTaskWithStop(task, { signal, record, timeoutMs = 30000 }) {
  let abortListener;
  const aborted = new Promise((_, reject) => { abortListener = () => reject(signal.reason); if (signal.aborted) abortListener(); else signal.addEventListener("abort", abortListener, { once: true }); });
  try { return await Promise.race([task, aborted]); }
  catch (error) {
    if (signal.aborted) {
      Object.assign(record, { requestedAt: Date.now(), settlementBudgetMs: timeoutMs });
      const settled = task.then(value => ({ value }), failure => ({ error: { message: failure.message, stack: failure.stack } }));
      try { record.settlement = await bound(settled, timeoutMs, "original onBound task settlement after stop"); record.settledAt = Date.now(); }
      catch (settlementError) { record.incomplete = true; record.error = settlementError.message; throw Object.assign(settlementError, { taskSettlementIncomplete: true }); }
    }
    throw error;
  } finally { signal.removeEventListener("abort", abortListener); }
}

// No approval is inferred from EOF, a timeout or an arbitrary input string.
// stop is delivered immediately even while a bind command is still pending.
export function commandInbox(input, output = process.stdout) {
  const controller = new AbortController(), records = [], queued = [];
  let waiter, closed = false;
  const reader = createInterface({ input, crlfDelay: Infinity, terminal: false });
  const accept = (command, origin) => {
    if (closed) return;
    const record = { command, origin, at: Date.now() }; records.push(record);
    if (command === "stop") controller.abort(new Error("OBU_NORMAL_RUN_STOPPED"));
    if (command !== "bind" && command !== "stop") { output.write("Expected bind or stop. No action taken.\n"); return; }
    if (waiter) { const resolve = waiter; waiter = undefined; resolve(record); } else queued.push(record);
  };
  reader.on("line", line => accept(line.trim(), "stdin"));
  reader.on("close", () => accept("stop", "stdin-eof"));
  return { signal: controller.signal, records, next: async () => queued.length ? queued.shift() : new Promise(resolve => { assert.equal(waiter, undefined); waiter = resolve; }),
    stop: () => accept("stop", "runner"), close() { closed = true; reader.close(); } };
}

// Resolves only on actual stdio close, not merely exit or kill submission.
// A failed close remains in registry so teardown cannot claim all helpers gone.
export function managedProcess(command, args, { env, cwd, registry = new Set(), record = {}, timeoutMs = 0, signal, onStderr, maximumBytes = 1024 * 1024, captureOutput = true } = {}) {
  signal?.throwIfAborted();
  assert.equal(typeof captureOutput, "boolean"); assert.ok(captureOutput || !onStderr, "Digest-only output cannot expose a raw stderr callback");
  const digests = captureOutput ? null : { stdout: createHash("sha256"), stderr: createHash("sha256") };
  Object.assign(record, { command, args: [...args], startedAt: Date.now(), stdout: captureOutput ? "" : { bytes: 0, sha256: digests.stdout.copy().digest("hex") }, stderr: captureOutput ? "" : { bytes: 0, sha256: digests.stderr.copy().digest("hex") } });
  const child = spawn(command, args, { cwd, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  record.pid = child.pid; registry.add(child);
  let timer, closeTimer, failure, settled = false;
  const append = (field, chunk) => {
    if (!captureOutput) {
      digests[field].update(chunk); record[field] = { bytes: record[field].bytes + chunk.length, sha256: digests[field].copy().digest("hex") };
      if (record[field].bytes > maximumBytes) terminate("output-overflow");
      return;
    }
    const value = String(chunk);
    if (Buffer.byteLength(record[field]) + Buffer.byteLength(value) > maximumBytes) { terminate("output-overflow"); return; }
    record[field] += value; if (field === "stderr") onStderr?.(value);
  };
  if (captureOutput) { child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8"); }
  child.stdout.on("data", chunk => append("stdout", chunk)); child.stderr.on("data", chunk => append("stderr", chunk));
  let rejectResult;
  function terminate(reason) {
    if (record.closedAt || record.termination) return;
    record.termination = { reason, requestedAt: Date.now(), submitted: child.kill() };
    failure = new Error(`${path.basename(command)} terminated: ${reason}`);
    closeTimer = setTimeout(() => { if (settled) return; settled = true; record.closeIncomplete = true; rejectResult(Object.assign(failure, { result: record })); }, 10000);
  }
  const abort = () => terminate("stop");
  const completed = new Promise((resolve, reject) => {
    rejectResult = reject;
    child.once("error", error => { record.spawnError = error.message; failure = error; });
    child.once("exit", (code, nativeSignal) => Object.assign(record, { exitedAt: Date.now(), code, signal: nativeSignal }));
    child.once("close", (code, nativeSignal) => {
      Object.assign(record, { closedAt: Date.now(), code, signal: nativeSignal }); registry.delete(child);
      clearTimeout(timer); clearTimeout(closeTimer); signal?.removeEventListener("abort", abort);
      if (settled) return; settled = true;
      failure ? reject(Object.assign(failure, { result: record })) : resolve(record);
    });
  });
  // Prevent unhandled rejection while long-lived browser handles are retained.
  completed.catch(() => {});
  if (timeoutMs) timer = setTimeout(() => terminate("timeout"), timeoutMs);
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  return { child, record, completed, terminate };
}

export async function runProcess(command, args, options = {}) {
  const value = await managedProcess(command, args, { timeoutMs: 30000, ...options }).completed;
  if (value.code !== 0) throw Object.assign(new Error(`${path.basename(command)} exited ${value.code}: ${value.stderr}`), { result: value });
  return value;
}

// Normal-start connections use only the discovered Browser WebSocket. Each
// connection retains its own human authorization outcome and actual close.
export async function connectNormalCDP(url, { handshakeTimeoutMs = normalBindBudgetMs, record = {}, signal, persist = async () => {}, notify = () => {}, authorizationRequired = true } = {}) {
  assert.match(url, /^ws:\/\/(?:127\.0\.0\.1|\[::1\]):[1-9][0-9]{0,4}\/devtools\/(?:browser|page)\/[A-Za-z0-9._~-]{1,256}$/);
  const parsed = new URL(url);
  assert.equal(parsed.protocol, "ws:"); assert.ok(["127.0.0.1", "[::1]"].includes(parsed.hostname));
  assert.equal(parsed.username + parsed.password, ""); assert.ok(/^[1-9][0-9]{0,4}$/.test(parsed.port) && Number(parsed.port) <= 65535);
  assert.match(parsed.pathname, /^\/devtools\/(?:browser|page)\/[A-Za-z0-9._~-]{1,256}$/); assert.equal(parsed.search + parsed.hash, "");
  assert.ok(Number.isInteger(handshakeTimeoutMs) && handshakeTimeoutMs > 0 && handshakeTimeoutMs <= normalBindBudgetMs);
  const deadline = performance.now() + handshakeTimeoutMs;
  const remaining = () => { signal?.throwIfAborted(); const value = deadline - performance.now(); if (value <= 0) throw new Error("diagnostic authorization original deadline expired"); return value; };
  signal?.throwIfAborted();
  Object.assign(record, { url, requestedAt: Date.now(), handshakeTimeoutMs, authorizationRequired, state: "connecting", eventsDropped: 0 });
  if (authorizationRequired) notify("AUTHORIZATION_REQUIRED: Allow this additional diagnostic connection in the private Edge window.\n");
  await persist();
  try { remaining(); } catch (error) { Object.assign(record, { failedAt: Date.now(), state: "not-connected", handshakeError: error.message }); await persist(); throw error; }
  const socket = new WebSocket(url), pending = new Map(), events = []; let serial = 0, closeResolve;
  const closed = new Promise(resolve => { closeResolve = resolve; });
  const fail = error => { for (const value of pending.values()) { clearTimeout(value.timer); value.reject(error); } pending.clear(); };
  const terminal = error => { record.terminalError ??= { at: Date.now(), message: error.message }; fail(error); socket.terminate(); };
  socket.on("error", error => { record.socketError = error.message; fail(error); });
  socket.once("close", (code, reason) => {
    Object.assign(record, { state: "closed", closedAt: Date.now(), closeCode: code, closeReason: String(reason) });
    fail(new Error("Diagnostic CDP closed")); closeResolve();
  });
  socket.on("message", bytes => {
    let value; try { value = JSON.parse(bytes); } catch (error) { terminal(error); return; }
    if (!value || typeof value !== "object" || Array.isArray(value)) { terminal(new Error("Malformed CDP envelope")); return; }
    if (value.id === undefined) { if (events.length < 10000) events.push({ ...value, receivedAt: Date.now() }); else record.eventsDropped++; return; }
    const entry = pending.get(value.id);
    if (!entry || value.sessionId !== entry.sessionId || Object.hasOwn(value, "result") === Object.hasOwn(value, "error")) { terminal(new Error("CDP reply identity/session/envelope mismatch")); return; }
    pending.delete(value.id); clearTimeout(entry.timer);
    value.error ? entry.reject(new Error(JSON.stringify(value.error))) : entry.resolve(value.result);
  });
  const abort = () => terminal(signal.reason ?? new Error("Diagnostic cancelled"));
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  try {
    const handshakeRemaining = remaining();
    await bound(new Promise((resolve, reject) => {
      socket.once("open", resolve); socket.once("error", reject); socket.once("close", () => reject(new Error("Diagnostic closed before authorization")));
    }), handshakeRemaining, "diagnostic authorization handshake");
    remaining();
    Object.assign(record, { connectedAt: Date.now(), state: "open", handshakeAcknowledged: true }); await persist();
    remaining(); assert.equal(socket.readyState, WebSocket.OPEN, "Diagnostic closed while recording authorization");
  } catch (error) {
    Object.assign(record, { failedAt: Date.now(), handshakeError: error.message }); socket.terminate();
    try { await bound(closed, 2000, "failed diagnostic actual close"); } catch (closeError) { record.closeError = closeError.message; }
    signal?.removeEventListener("abort", abort); await persist(); throw error;
  }
  const call = (method, params = {}, timeoutMs = 20000, sessionId) => new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    if (socket.readyState !== WebSocket.OPEN) return reject(new Error("Diagnostic CDP closed"));
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > normalBindBudgetMs) return reject(new Error("Invalid CDP command budget"));
    const id = ++serial, timer = setTimeout(() => terminal(new Error(`${method} timed out; diagnostic connection retired`)), timeoutMs);
    pending.set(id, { resolve, reject, timer, sessionId }); socket.send(JSON.stringify({ id, method, params, ...(sessionId && { sessionId }) }));
  });
  return { call, events, state: () => record.state,
    evaluate: async (expression, timeoutMs = 20000, sessionId) => { const value = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, timeoutMs, sessionId); if (value.exceptionDetails) throw new Error(JSON.stringify(value.exceptionDetails)); return value.result.value; },
    close: async () => { if (socket.readyState !== WebSocket.CLOSED) socket.close(); try { await bound(closed, 2000, "diagnostic actual close"); } catch (error) { record.closeError = error.message; socket.terminate(); await bound(closed, 2000, "terminated diagnostic actual close"); } finally { signal?.removeEventListener("abort", abort); await persist(); } }
  };
}

// Retain the exact process handle before sending WM_CLOSE. No activation,
// focus restoration, OS mouse operation, process-name kill or tree kill.
export const closePrivateBrowserSource = `param([string]$EvidenceFile)
$ErrorActionPreference='Stop'
$expected=Get-Content -LiteralPath $EvidenceFile -Raw | ConvertFrom-Json
$handle=[System.Diagnostics.Process]::GetProcessById([int]$expected.ProcessId)
try {
  $null=$handle.Handle
  $actual=Get-CimInstance Win32_Process -Filter ('ProcessId = '+[int]$expected.ProcessId)
  if (!$actual -or $actual.ExecutablePath -ne $expected.ExecutablePath -or $actual.CreationDate.ToUniversalTime().ToString('o') -ne $expected.CreationDate) { throw 'Private browser identity changed before close' }
  $at=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $submitted=$handle.CloseMainWindow()
  $graceful=$handle.WaitForExit(10000)
  $forced=$false
  if (!$graceful) { $forced=$true; $handle.Kill(); if (!$handle.WaitForExit(10000)) { throw 'Exact private browser did not exit' } }
  @{pid=$expected.ProcessId;requestedAt=$at;closeMainWindowSubmitted=$submitted;graceful=$graceful;forced=$forced;exitedAt=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();exitCode=$handle.ExitCode;exactHandle=$true} | ConvertTo-Json -Compress
} finally { $handle.Dispose() }
`;
