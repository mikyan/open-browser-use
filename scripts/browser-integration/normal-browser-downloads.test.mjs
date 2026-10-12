import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { WebSocketServer } from "ws";
import { runNormalBrowserDownloads } from "./normal-browser-downloads.mjs";
import { normalStartArguments, assertNormalProcess, parsePrivateDevToolsPort, assertNativeInfo, assertBindingAck, assertOriginalHostExit,
  normalRunOutcome, commandInbox, managedProcess, runProcess, connectNormalCDP, classifyPrivateProcesses, selectPrivateProcesses,
  awaitTaskWithStop, privateInventoryFailure, beginShutdownAttempt, waitPrivateProcessesGone, sleep,
  summarizePrivateProfileAccounts, readPrivateProfileAccountState, assertPrivateProfileAccountState, assertFixtureExtensionInventory } from "./normal-browser-downloads-support.mjs";

const profile = "D:\\isolated task\\profile", executable = "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe";
const root = { ProcessId: 123, ParentProcessId: 10, ExecutablePath: executable, CreationDate: "2026-10-12T01:00:00.000Z",
  CommandLine: `"${executable}" "--user-data-dir=${profile}" --no-first-run --no-default-browser-check edge://inspect/#remote-debugging` };
const processOptions = { profile, browserBinary: executable, nativeExecutable: "D:\\private run\\local\\OpenBrowserUse\\native-host\\open-browser-use.exe", extensionId: "pnbmoicbkopffjjgfgfglopechaiemkp", systemRoot: "C:\\WINDOWS" };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const sink = () => { const output = new PassThrough(); let text = ""; output.on("data", bytes => { text += bytes; }); return { output, text: () => text }; };
const cleanAccountMetadata = () => ({
  localState: { profile: { info_cache: { Default: { is_consented_primary_account: false, edge_sync_enabled: false, gaia_id: "", user_name: "" } } }, profiles: { edge_implicitly_signed_in: [] }, signin: { active_accounts: {} } },
  preferences: { profile: { created_by_version: "156.0.0.0" }, account_info: [], signin: { allowed: true, accounts_metadata_dict: {} }, sync_consent_recorded: false,
    sync: { has_been_enabled: false, has_setup_completed: false, gaia_id: "", transport_data_per_account: {}, keep_everything_synced: true, apps: true, autofill: true, bookmarks: true, extensions: true, passwords: true, preferences: true, tabs: true, typed_urls: true } }
});
const cleanAccountEvidence = () => ({ status: "clean", checks: ["post-bootstrap", "pre-handoff", "pre-bind", "pre-business", "post-business"].map(stage => ({ stage, status: "clean" })) });

test("runner import exposes a callable but does not launch anything", () => assert.equal(typeof runNormalBrowserDownloads, "function"));
test("normal process has only the four explicit ordinary startup arguments", () => {
  assert.equal(normalStartArguments(profile).length, 4);
  assert.equal(assertNormalProcess(root, { profile, executable, browserPid: 123 }), root);
});
for (const forbidden of ["--remote-debugging-port=0", "--enable-unsafe-extension-debugging", "--enable-automation", "--headless", "--load-extension=other", "--no-sandbox"]) {
  test(`actual normal CIM command rejects ${forbidden}`, () => assert.throws(() => assertNormalProcess({ ...root, CommandLine: root.CommandLine + " " + forbidden }, { profile, executable, browserPid: 123 }), /unexpected arguments/));
}
test("normal identity cannot be replaced by a daily profile, helper or another executable", () => {
  for (const row of [{ ...root, ProcessId: 124 }, { ...root, ExecutablePath: "C:\\other.exe" }, { ...root, CommandLine: root.CommandLine.replace(profile, "D:\\daily") }, { ...root, CommandLine: root.CommandLine + " --type=renderer" }])
    assert.throws(() => assertNormalProcess(row, { profile, executable, browserPid: 123 }));
});
test("private port file follows production two-line grammar", () => {
  assert.deepEqual(parsePrivateDevToolsPort("9222\r\n/devtools/browser/original_1.~\r\n"), { port: 9222, browserPath: "/devtools/browser/original_1.~", url: "ws://127.0.0.1:9222/devtools/browser/original_1.~" });
  for (const text of ["\n9222\n/devtools/browser/id", " 9222\n/devtools/browser/id", "09222\n/devtools/browser/id", "9222\n/devtools/browser/id\n\n", "0\n/devtools/browser/id", "65536\n/devtools/browser/id", "9222\n/devtools/page/id", "9222\n/devtools/browser/../id", "9222\n/devtools/browser/id?query", "9222\n/devtools/browser/" + "a".repeat(257)]) assert.throws(() => parsePrivateDevToolsPort(text));
});
test("getInfo must name both the original extension and the random real native host", () => {
  const expected = { extensionId: "a".repeat(32), nativeName: "com.openbrowseruse.lifecycle.n" + "1".repeat(24) };
  const info = { type: "extension", metadata: { ...expected, nativeHostName: expected.nativeName, extensionInstanceId: "instance" } };
  assert.equal(assertNativeInfo(info, expected), info);
  for (const patch of [{ extensionId: "b".repeat(32) }, { nativeHostName: "com.fake" }, { extensionInstanceId: "" }]) assert.throws(() => assertNativeInfo({ ...info, metadata: { ...info.metadata, ...patch } }, expected));
});
test("exact enabled fixture extension inventory is preserved unchanged", () => {
  const value = { extensions: [{ id: "b".repeat(32), name: "Independent observer", enabled: true, path: "D:\\private\\observer" }, { id: "a".repeat(32), name: "Open Browser Use", enabled: true, path: "D:\\private\\extension" }] };
  const copy = structuredClone(value); assert.equal(assertFixtureExtensionInventory(value, ["a".repeat(32), "b".repeat(32)]), value); assert.deepEqual(value, copy);
});
test("unknown extension inventory rejects without names, paths or IDs in evidence or assertion", () => {
  const known = [{ id: "a".repeat(32), enabled: true }, { id: "b".repeat(32), enabled: true }];
  let failure;
  try { assertFixtureExtensionInventory({ extensions: [...known, { id: "c".repeat(32), name: "PRIVATE_EXTENSION_NAME", path: "D:\\PRIVATE_EXTENSION_PATH" }] }, known.map(item => item.id)); }
  catch (error) { failure = error; }
  assert.ok(failure); assert.deepEqual(failure.inventory, { totalCount: 3, fixtureCount: 2, unknownCount: 1 });
  assert.doesNotMatch(JSON.stringify({ message: failure.message, stack: failure.stack, inventory: failure.inventory }), /cccccccc|PRIVATE_EXTENSION/);
  for (const entries of [[known[0], known[0]], [known[0]], [known[0], { ...known[1], enabled: false }], [null, known[1]]])
    assert.throws(() => assertFixtureExtensionInventory({ extensions: entries }, known.map(item => item.id)), /OBU_NORMAL_EXTENSION_INVENTORY/);
});
test("binding requires actual CLI close and exact original instance acknowledgement", () => {
  const result = { bound: true, exclusive: true, behavior: "default", extensionId: "original", extensionInstanceId: "instance", generation: "g", workerBootId: "w", portId: "p" };
  const command = { code: 0, startedAt: 1, exitedAt: 2, closedAt: 3, stdout: JSON.stringify({ jsonrpc: "2.0", id: "bind", result }) };
  assert.deepEqual(assertBindingAck(command, { extensionId: "original", instanceId: "instance" }).result, result);
  for (const patch of [{ closedAt: undefined }, { code: 1 }, { termination: { reason: "timeout" } }]) assert.throws(() => assertBindingAck({ ...command, ...patch }, { extensionId: "original", instanceId: "instance" }));
  assert.throws(() => assertBindingAck(command, { extensionId: "original", instanceId: "replacement" }));
});
test("binding, bootstrap success or stop without a task never becomes a PASS", () => {
  const report = { bootstrap: { shutdown: { complete: true } }, normal: { commandVerified: true }, binding: { verified: true }, cleanup: { complete: true }, profileAccountIsolation: cleanAccountEvidence() };
  assert.equal(normalRunOutcome(report).passed, false);
  assert.deepEqual(normalRunOutcome({ ...report, stopped: {} }), { passed: false, status: "stopped", exitCode: 0 });
  assert.equal(normalRunOutcome({ ...report, task: { verified: true } }).passed, true);
  for (const patch of [{ error: {} }, { stopped: {} }, { cleanup: { complete: false } }, { bootstrap: { shutdown: { complete: false } } }, { task: { passed: true } }]) assert.equal(normalRunOutcome({ ...report, task: { verified: true }, ...patch }).passed, false);
  for (const isolation of [undefined, { status: "contaminated", checks: report.profileAccountIsolation.checks }, { status: "clean", checks: [] }, { status: "clean", checks: [...report.profileAccountIsolation.checks, { stage: "pre-business-client", status: "unavailable" }] }])
    assert.equal(normalRunOutcome({ ...report, task: { verified: true }, profileAccountIsolation: isolation }).passed, false);
});
test("unsigned profile's default sync datatypes do not imply a signed-in sync session", () => {
  const { localState, preferences } = cleanAccountMetadata(), value = summarizePrivateProfileAccounts(localState, preferences);
  assert.equal(assertPrivateProfileAccountState(value), value); assert.equal(value.status, "clean"); assert.deepEqual(value.contaminated, []);
  assert.ok(value.observations.some(item => item.field === "preferences.sync.passwords" && item.value === true && item.authoritative === false));
});
test("initialized unsigned metadata permits absent optional account fields", () => {
  assert.equal(summarizePrivateProfileAccounts({ profile: { info_cache: { Default: {} } } }, { profile: {} }).status, "clean");
});
for (const [source, field, accountValue] of [
  ["localState", "profile.info_cache.Default.is_consented_primary_account", true],
  ["localState", "profile.info_cache.Default.edge_sync_enabled", true],
  ["localState", "profile.info_cache.Default.gaia_id", "PRIVATE_ACCOUNT_ID"],
  ["localState", "profile.info_cache.Default.user_name", "PRIVATE_ACCOUNT_EMAIL"],
  ["localState", "profiles.edge_implicitly_signed_in", [{ secret: "PRIVATE_ACCOUNT_ID" }]],
  ["localState", "signin.active_accounts", { PRIVATE_ACCOUNT_ID: "PRIVATE_ACCOUNT_EMAIL" }],
  ["preferences", "account_info", [{ email: "PRIVATE_ACCOUNT_EMAIL", token: "PRIVATE_ACCOUNT_TOKEN" }]],
  ["preferences", "signin.accounts_metadata_dict", { PRIVATE_ACCOUNT_ID: { token: "PRIVATE_ACCOUNT_TOKEN" } }],
  ["preferences", "sync_consent_recorded", true], ["preferences", "sync.has_been_enabled", true], ["preferences", "sync.has_setup_completed", true],
  ["preferences", "sync.gaia_id", "PRIVATE_ACCOUNT_ID"], ["preferences", "sync.transport_data_per_account", { PRIVATE_ACCOUNT_ID: { secret: "PRIVATE_ACCOUNT_TOKEN" } }]
]) test(`authoritative private-profile account evidence rejects ${source}.${field} without retaining values`, () => {
  const values = cleanAccountMetadata(), parts = field.split("."); let owner = values[source];
  for (const part of parts.slice(0, -1)) owner = owner[part]; owner[parts.at(-1)] = accountValue;
  const value = summarizePrivateProfileAccounts(values.localState, values.preferences);
  assert.equal(value.status, "contaminated"); assert.deepEqual(value.contaminated, [`${source}.${field}`]);
  assert.throws(() => assertPrivateProfileAccountState(value), /OBU_NORMAL_PROFILE_ACCOUNT_CONTAMINATED/);
  assert.doesNotMatch(JSON.stringify(value), /PRIVATE_ACCOUNT/);
});
test("missing initialization and malformed optional account metadata fail closed", () => {
  for (const localState of [undefined, null, [], {}, { profile: { info_cache: { Default: null } } }])
    assert.equal(summarizePrivateProfileAccounts(localState, cleanAccountMetadata().preferences).status, "unavailable");
  for (const preferences of [undefined, null, [], {}, { profile: {}, account_info: {} }, { profile: {}, signin: null }, { profile: {}, sync: { has_setup_completed: "false" } }, { profile: {}, sync_consent_recorded: 0 }]) {
    const value = summarizePrivateProfileAccounts(cleanAccountMetadata().localState, preferences);
    assert.throws(() => assertPrivateProfileAccountState(value), /OBU_NORMAL_PROFILE_ACCOUNT_UNAVAILABLE/);
  }
});
test("private reader never returns filenames or raw metadata from I/O and JSON errors", async () => {
  for (const readMetadata of [async () => { throw new Error("PRIVATE_ACCOUNT_TOKEN in PRIVATE_FOREIGN_PATH"); }, async () => '{"profile":PRIVATE_ACCOUNT_TOKEN}', async () => " ", async () => "x".repeat(8 * 1024 * 1024 + 1)]) {
    const value = await readPrivateProfileAccountState(profile, { readMetadata });
    assert.equal(value.status, "unavailable"); assert.deepEqual(value.files.map(item => item.readable), [false, false]);
    assert.doesNotMatch(JSON.stringify(value), /PRIVATE_ACCOUNT|PRIVATE_FOREIGN_PATH/);
  }
});
test("private reader reads only the two fixed profile metadata files", async () => {
  const values = cleanAccountMetadata(), paths = [];
  const value = await readPrivateProfileAccountState(profile, { readMetadata: async file => { paths.push(file); return JSON.stringify(file.endsWith("Local State") ? values.localState : values.preferences); } });
  assert.equal(value.status, "clean"); assert.deepEqual(paths, [path.join(profile, "Local State"), path.join(profile, "Default/Preferences")]);
  assert.equal(value.files.every(file => file.readable && file.bytes > 1), true);
});
test("actual bounded metadata reads reject missing, truncated, oversize and non-file inputs", async t => {
  const base = path.resolve(".tmp"); await fs.mkdir(base, { recursive: true });
  const directory = await fs.mkdtemp(path.join(base, "normal-account-guard-"));
  t.after(async () => { assert.equal(path.dirname(await fs.realpath(directory)), await fs.realpath(base)); await fs.rm(directory, { recursive: true }); });
  await fs.mkdir(path.join(directory, "Default")); const values = cleanAccountMetadata();
  await fs.writeFile(path.join(directory, "Local State"), JSON.stringify(values.localState));
  assert.equal((await readPrivateProfileAccountState(directory)).status, "unavailable");
  const prefs = path.join(directory, "Default/Preferences"); await fs.writeFile(prefs, JSON.stringify(values.preferences));
  assert.equal((await readPrivateProfileAccountState(directory)).status, "clean");
  for (const text of ['{"profile":', "x".repeat(8 * 1024 * 1024 + 1)]) { await fs.writeFile(prefs, text); assert.equal((await readPrivateProfileAccountState(directory)).status, "unavailable"); }
  await fs.unlink(prefs); await fs.mkdir(prefs); assert.equal((await readPrivateProfileAccountState(directory)).status, "unavailable");
});
test("process disappearance or replacement host exit cannot substitute original native EOF", () => {
  const original = { identity: { process: { ProcessId: 55, CreationDate: "original", ExecutablePath: "D:\\private\\host.exe" } } };
  const evidence = { process: original.identity.process, ready: { pid: 55, readyAt: 10, exactHandle: true }, result: { pid: 55, exitedAt: 20, exitCode: 0, exactHandle: true } };
  assertOriginalHostExit(original, [evidence]);
  for (const values of [undefined, [], [{ ...evidence, process: { ...evidence.process, CreationDate: "replacement" } }], [{ ...evidence, result: { ...evidence.result, exitCode: 1 } }], [{ ...evidence, result: { ...evidence.result, exactHandle: false } }]]) assert.throws(() => assertOriginalHostExit(original, values));
});
test("PID reuse and stale parent IDs cannot adopt another process", () => {
  const unrelated = { ...root, CreationDate: "2026-10-12T03:00:00Z", CommandLine: `"${executable}" --user-data-dir=D:\\daily` };
  const child = { ...unrelated, ProcessId: 456, ParentProcessId: 123, CreationDate: "2026-10-12T02:00:00Z" };
  assert.deepEqual(selectPrivateProcesses([unrelated, child], { ...processOptions, roots: [root] }), []);
  assert.deepEqual(selectPrivateProcesses([root, child], { ...processOptions, roots: [root] }), [root, child]);
  const beforeParent = { ...child, CreationDate: "2026-10-11T01:00:00Z" };
  assert.deepEqual(selectPrivateProcesses([root, beforeParent], { ...processOptions, roots: [root] }), [root]);
});
test("known child identity retains orphan evidence without following replacement PID", () => {
  const child = { ProcessId: 456, ParentProcessId: 123, CreationDate: "2026-10-12T02:00:00Z", ExecutablePath: executable, CommandLine: `"${executable}" --type=gpu-process` };
  assert.deepEqual(selectPrivateProcesses([child], { ...processOptions, known: [child] }), [child]);
  assert.deepEqual(selectPrivateProcesses([{ ...child, CreationDate: "2026-10-12T04:00:00Z" }], { ...processOptions, known: [child] }), []);
});
test("foreign malformed command lines neither fail inventory nor become private", () => {
  const foreign = { ...root, ProcessId: 999, CommandLine: 'unrelated-app.exe "partial quote' };
  assert.deepEqual(selectPrivateProcesses([foreign, root], { ...processOptions, roots: [root] }), [root]);
});
test("Do0PFY input-method daemon remains external even when its original browser parent exits", () => {
  const edge = { ...root, ProcessId: 2560, CreationDate: "2026-10-12T12:40:38.936637Z" };
  const inputMethod = { ProcessId: 51304, ParentProcessId: 2560, ExecutablePath: "D:\\Program Files (x86)\\SogouInput\\16.6.0.4777\\SGTool.exe", CommandLine: '"D:\\Program Files (x86)\\SogouInput\\16.6.0.4777\\SGTool.exe" -daemon', CreationDate: "2026-10-12T12:40:39.44045Z" };
  const live = classifyPrivateProcesses([edge, inputMethod], { ...processOptions, roots: [edge] });
  assert.deepEqual(live.owned.map(value => value.process), [edge]); assert.deepEqual(live.externalDescendants.map(value => value.process), [inputMethod]); assert.equal(live.externalDescendants[0].leftUntouched, true);
  const later = classifyPrivateProcesses([inputMethod], { ...processOptions, roots: [edge], known: [inputMethod] });
  assert.deepEqual(later.owned, []); assert.deepEqual(later.unknownDescendants, []); assert.equal(later.externalDescendants[0].process, inputMethod);
});
test("arbitrary external descendants are recorded without granting historical ownership", () => {
  const foreign = { ...root, ProcessId: 555, ParentProcessId: 123, ExecutablePath: "D:\\unrelated\\helper.exe", CommandLine: "helper.exe --daemon", CreationDate: "2026-10-12T02:00:00Z" };
  for (const known of [[], [{ ...foreign, privateProcessRole: "browser" }]]) {
    const result = classifyPrivateProcesses([root, foreign], { ...processOptions, roots: [root], known });
    assert.deepEqual(result.owned.map(entry => entry.process), [root]); assert.equal(result.externalDescendants[0].leftUntouched, true);
  }
});
test("real Edge renderer and GPU residuals without profile arguments still block exit", () => {
  for (const type of ["renderer", "gpu-process"]) {
    const child = { ...root, ProcessId: 888, ParentProcessId: 123, CommandLine: `"${executable}" --type=${type}`, CreationDate: "2026-10-12T02:00:00Z" };
    assert.deepEqual(classifyPrivateProcesses([root, child], { ...processOptions, roots: [root] }).owned.map(value => value.process), [root, child]);
    assert.deepEqual(selectPrivateProcesses([child], { ...processOptions, known: [{ ...child, privateProcessRole: "browser" }] }), [child]);
  }
});
test("same-install unknown helpers and incomplete related identities continue blocking", () => {
  for (const patch of [{ ExecutablePath: "C:\\Program Files\\Microsoft\\Edge\\Application\\unrecognized.exe" }, { ExecutablePath: null }, { CreationDate: null }, { CommandLine: null }]) {
    const child = { ...root, ProcessId: 666, ParentProcessId: 123, CreationDate: "2026-10-12T02:00:00Z", CommandLine: "component.exe", ...patch };
    const result = classifyPrivateProcesses([root, child], { ...processOptions, roots: [root] });
    assert.equal(result.unknownDescendants[0]?.process, child); assert.equal(result.externalDescendants.length, 0);
    const after = classifyPrivateProcesses([child], { ...processOptions, known: [{ ...child, privateProcessRole: "unknown" }] });
    assert.equal(after.unknownDescendants[0]?.process, child);
  }
});
test("known orphan GPU with incomplete current CIM identity becomes unknown, never absent", () => {
  const known = { ...root, ProcessId: 556, ParentProcessId: 123, CommandLine: `"${executable}" --type=gpu-process`, CreationDate: "2026-10-12T02:00:00Z", privateProcessRole: "browser" };
  for (const patch of [{ ExecutablePath: null }, { CreationDate: null }, { CommandLine: null }]) {
    const row = { ...known, ...patch }, result = classifyPrivateProcesses([row], { ...processOptions, known: [known] });
    assert.deepEqual(result.owned, []); assert.equal(result.unknownDescendants[0]?.process, row);
  }
  assert.deepEqual(classifyPrivateProcesses([{ ...known, ExecutablePath: null, CreationDate: "2026-10-12T04:00:00Z" }], { ...processOptions, known: [known] }), { owned: [], externalDescendants: [], unknownDescendants: [] });
});
test("only exact system-cmd native first-command/origin/paired-pipe shape is owned", () => {
  const wrapper = { ProcessId: 49128, ParentProcessId: 123, ExecutablePath: "C:\\WINDOWS\\system32\\cmd.exe", CreationDate: "2026-10-12T02:00:00Z",
    CommandLine: `C:\\WINDOWS\\system32\\cmd.exe /d /s /c ""${processOptions.nativeExecutable}" chrome-extension://${processOptions.extensionId}/ --parent-window=0" < \\\\.\\pipe\\chrome.nativeMessaging.in.72a323a607d87dbf > \\\\.\\pipe\\chrome.nativeMessaging.out.72a323a607d87dbf` };
  const native = { ProcessId: 52344, ParentProcessId: 49128, ExecutablePath: processOptions.nativeExecutable, CreationDate: "2026-10-12T02:00:01Z", CommandLine: `"${processOptions.nativeExecutable}" chrome-extension://${processOptions.extensionId}/ --parent-window=0` };
  const result = classifyPrivateProcesses([root, wrapper, native], { ...processOptions, roots: [root] });
  assert.deepEqual(result.owned.map(value => value.role), ["browser", "native-launcher", "native-host"]);
  assert.deepEqual(selectPrivateProcesses([wrapper, native], { ...processOptions, known: [{ ...wrapper, privateProcessRole: "native-launcher" }, { ...native, privateProcessRole: "native-host" }] }), [wrapper, native]);
  for (const command of [wrapper.CommandLine.replace('/c ""', '/c "echo "'), wrapper.CommandLine.replace(processOptions.extensionId, "a".repeat(32)), wrapper.CommandLine.replace(/out\.72a323a607d87dbf$/, "out.abcdef"), wrapper.CommandLine + " & echo extra"] ) {
    const wrong = { ...wrapper, CommandLine: command };
    const invalid = classifyPrivateProcesses([root, wrong], { ...processOptions, roots: [root], known: [{ ...wrong, privateProcessRole: "native-launcher" }] });
    assert.deepEqual(invalid.owned.map(value => value.role), ["browser"]); assert.equal(invalid.externalDescendants[0]?.process, wrong);
  }
});
test("failed CIM helper cannot serialize unrelated command lines or error text", async () => {
  let failure;
  try { await runProcess(process.execPath, ["-e", "process.stdout.write('PRIVATE_FOREIGN_COMMAND');process.stderr.write('PRIVATE_ERROR_TEXT');process.exitCode=2"]); }
  catch (error) { failure = privateInventoryFailure(error); }
  assert.ok(failure); assert.equal(failure.result.code, 2); assert.ok(failure.result.closedAt);
  assert.equal(failure.result.stdout.bytes, 23); assert.match(failure.result.stdout.sha256, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify({ message: failure.message, stack: failure.stack, result: failure.result }), /PRIVATE_FOREIGN_COMMAND|PRIVATE_ERROR_TEXT/);
});
test("stop arrives immediately while bind is in progress; arbitrary text is not approval", async () => {
  const input = new PassThrough(), output = sink(), inbox = commandInbox(input, output.output);
  input.write("yes\nbind\n"); assert.equal((await inbox.next()).command, "bind"); assert.match(output.text(), /No action taken/);
  input.write("stop\n"); assert.equal(inbox.signal.aborted, true); assert.equal((await inbox.next()).command, "stop"); inbox.close();
});
test("stdin EOF stops instead of approving or passing", async () => {
  const input = new PassThrough(), inbox = commandInbox(input, sink().output); input.end();
  assert.equal((await inbox.next()).origin, "stdin-eof"); assert.equal(inbox.signal.aborted, true); inbox.close();
});
test("actual subprocess records exit and subsequent close", async () => {
  const registry = new Set();
  const result = await runProcess(process.execPath, ["-e", "process.stdout.write('original');process.stderr.write('error-channel')"], { registry });
  assert.equal(result.stdout, "original"); assert.equal(result.stderr, "error-channel"); assert.equal(result.code, 0);
  assert.ok(result.closedAt >= result.exitedAt && result.exitedAt >= result.startedAt); assert.equal(registry.size, 0);
});
test("browser digest-only stdout/stderr preserve actual close and hashes without synced identifiers", async () => {
  const stdout = "PRIVATE_ACCOUNT_EMAIL", stderr = "Attempt to sync bad ExtensionSpecifics PRIVATE_EXTENSION_ID";
  const result = await runProcess(process.execPath, ["-e", "process.stdout.write(process.env.OBU_TEST_STDOUT);process.stderr.write(process.env.OBU_TEST_STDERR)"], {
    env: { ...process.env, OBU_TEST_STDOUT: stdout, OBU_TEST_STDERR: stderr }, captureOutput: false
  });
  for (const [field, value] of [["stdout", stdout], ["stderr", stderr]]) assert.deepEqual(result[field], { bytes: Buffer.byteLength(value), sha256: createHash("sha256").update(value).digest("hex") });
  assert.equal(result.code, 0); assert.ok(result.closedAt >= result.exitedAt); assert.doesNotMatch(JSON.stringify(result), /PRIVATE_ACCOUNT_EMAIL|PRIVATE_EXTENSION_ID/);
  assert.throws(() => managedProcess(process.execPath, [], { captureOutput: false, onStderr() {} }), /raw stderr callback/);
});
test("original timeout terminates a real helper and waits actual close", async () => {
  const registry = new Set();
  await assert.rejects(runProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], { registry, timeoutMs: 150 }), error => {
    assert.equal(error.result.termination.reason, "timeout"); assert.ok(error.result.closedAt >= error.result.termination.requestedAt); assert.ok(error.result.exitedAt); return true;
  }); assert.equal(registry.size, 0);
});
test("stop cancels a real helper without manufacturing successful exit", async () => {
  const controller = new AbortController(), registry = new Set();
  const process = managedProcess(globalThis.process.execPath, ["-e", "setInterval(()=>{},1000)"], { signal: controller.signal, registry });
  controller.abort(); await assert.rejects(process.completed, error => error.result.termination.reason === "stop" && !!error.result.closedAt); assert.equal(registry.size, 0);
});
test("failed spawn records actual close and does not leave a cleanup registry entry", async () => {
  const registry = new Set(); await assert.rejects(runProcess("obu-nonexistent-test-binary", [], { registry }), error => !!error.result.closedAt); assert.equal(registry.size, 0);
});
test("stop waits the original task's real finally before returning", async () => {
  const controller = new AbortController(), gate = deferred(), record = {}; let finished = false;
  const task = gate.promise.finally(() => { finished = true; });
  const wait = awaitTaskWithStop(task, { signal: controller.signal, record });
  controller.abort(new Error("stop")); await sleep(15); assert.equal(finished, false); assert.equal(record.settledAt, undefined);
  gate.resolve({ verified: true }); await assert.rejects(wait, /stop/); assert.equal(finished, true); assert.ok(record.settledAt); assert.deepEqual(record.settlement.value, { verified: true });
});
test("unsettled task after stop is explicit incomplete failure", async () => {
  const controller = new AbortController(), gate = deferred(), record = {};
  const wait = awaitTaskWithStop(gate.promise, { signal: controller.signal, record, timeoutMs: 20 }); controller.abort(new Error("stop"));
  await assert.rejects(wait, error => error.taskSettlementIncomplete === true); assert.equal(record.incomplete, true); assert.equal(record.settledAt, undefined); gate.resolve();
});
test("second cleanup attempt preserves the first close ACK, exact EOF and failure", () => {
  const runtime = {}, original = beginShutdownAttempt(runtime, "Browser.close");
  Object.assign(original, { closeReply: {}, browserExit: { result: { pid: 123, exitCode: 0, exactHandle: true } }, hostExits: [{ result: { pid: 456, exitCode: 0, exactHandle: true } }], error: { message: "original private process timeout" }, processInventory: { lastRows: [{ ProcessId: 789 }] } });
  const saved = structuredClone(original), cleanup = beginShutdownAttempt(runtime, "exact retained handle CloseMainWindow");
  cleanup.alreadyExited = true; cleanup.error = { message: "later cleanup failure" };
  assert.equal(runtime.shutdown, original); assert.deepEqual(runtime.shutdown, saved); assert.deepEqual(runtime.cleanupShutdownAttempts, [cleanup]);
});
test("failed process-absence poll checkpoints exact selected rows on every read", async () => {
  const record = {}, checkpoints = [], original = [{ ...root, classification: "test selected native row" }]; let reads = 0;
  await assert.rejects(waitPrivateProcessesGone(async () => { reads++; return original; }, { record, persist: async () => checkpoints.push(structuredClone(record)), timeoutMs: 20, intervalMs: 5 }), /timed out/);
  assert.ok(reads >= 2); assert.equal(record.complete, false); assert.equal(record.samples.length, reads);
  assert.deepEqual(record.lastRows, original); assert.deepEqual(record.samples.map(sample => sample.rows), Array.from({ length: reads }, () => original));
  assert.equal(checkpoints.length, reads + 1); assert.equal(checkpoints.at(-1).complete, false);
  original[0].ProcessId = 987; assert.equal(record.lastRows[0].ProcessId, 123, "Evidence must be copied before mutable inputs change");
});
test("successful process-absence poll retains earlier selected rows and final empty inventory", async () => {
  const record = {}; let reads = 0;
  assert.deepEqual(await waitPrivateProcessesGone(async () => ++reads === 1 ? [root] : [], { record, persist: async () => {}, timeoutMs: 100, intervalMs: 1 }), []);
  assert.equal(record.complete, true); assert.deepEqual(record.samples[0].rows, [root]); assert.deepEqual(record.lastRows, []);
});
test("external-only descendants are preserved in exit evidence and do not claim test ownership", async () => {
  const row = { ...root, ExecutablePath: "D:\\external\\input-method.exe", CommandLine: "input-method.exe -daemon", ProcessId: 777 };
  const classification = classifyPrivateProcesses([row], { ...processOptions, known: [row] }), record = {};
  assert.deepEqual(await waitPrivateProcessesGone(async () => classification, { record, persist: async () => {} }), []);
  assert.equal(record.complete, true); assert.deepEqual(record.lastRows, []);
  assert.equal(record.lastClassification.externalDescendants[0].process.ProcessId, 777); assert.equal(record.lastClassification.externalDescendants[0].leftUntouched, true);
});

async function peer(t, onConnection) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 }); await new Promise(resolve => server.once("listening", resolve));
  server.on("connection", onConnection);
  t.after(async () => { for (const socket of server.clients) socket.terminate(); await new Promise(resolve => server.close(resolve)); });
  return `ws://127.0.0.1:${server.address().port}/devtools/browser/test`;
}
test("diagnostic receives original flat-session reply and records actual handshake/close", async t => {
  const url = await peer(t, socket => socket.on("message", bytes => { const request = JSON.parse(bytes); socket.send(JSON.stringify({ id: request.id, sessionId: request.sessionId, result: { original: request.params } })); }));
  const record = {}, notices = [];
  const client = await connectNormalCDP(url, { record, notify: value => notices.push(value) });
  assert.deepEqual(await client.call("Runtime.test", { original: true }, 1000, "frame-original"), { original: { original: true } });
  assert.equal(record.handshakeAcknowledged, true); assert.match(notices[0], /AUTHORIZATION_REQUIRED/); await client.close(); assert.ok(record.closedAt);
});
for (const defect of ["session", "both", "neither", "id"]) test(`diagnostic rejects a ${defect} reply mismatch and retires socket`, async t => {
  const url = await peer(t, socket => socket.on("message", bytes => {
    const request = JSON.parse(bytes), answer = { id: request.id, sessionId: request.sessionId, result: {} };
    if (defect === "session") answer.sessionId = "replacement";
    if (defect === "both") answer.error = { message: "wrong" };
    if (defect === "neither") delete answer.result;
    if (defect === "id") answer.id++;
    socket.send(JSON.stringify(answer));
  }));
  const record = {}, client = await connectNormalCDP(url, { record });
  await assert.rejects(client.call("Runtime.test", {}, 1000, "original"), /mismatch/); await client.close(); assert.ok(record.terminalError && record.closedAt);
});
test("native command timeout retires diagnostic; delayed reply cannot revive it", async t => {
  let original; const url = await peer(t, socket => socket.on("message", bytes => { original = JSON.parse(bytes); }));
  const record = {}, client = await connectNormalCDP(url, { record });
  await assert.rejects(client.call("Original", {}, 20), /retired/); assert.equal(original.method, "Original");
  await assert.rejects(client.call("Successor", {}, 100), /closed/); await client.close(); assert.ok(record.closedAt);
});
test("slow persistence cannot reset original handshake deadline", async t => {
  const url = await peer(t, () => {}), record = {}; let writes = 0;
  await assert.rejects(connectNormalCDP(url, { handshakeTimeoutMs: 20, record, persist: async () => { if (++writes === 1) await sleep(35); } }), /original deadline/);
  assert.equal(record.state, "not-connected"); assert.equal(record.handshakeAcknowledged, undefined);
});
test("post-ACK persistence expiry is rejected and actual socket closes", async t => {
  const url = await peer(t, () => {}), record = {}; let writes = 0;
  await assert.rejects(connectNormalCDP(url, { handshakeTimeoutMs: 40, record, persist: async () => { if (++writes === 2) await sleep(60); } }), /original deadline/);
  assert.equal(record.handshakeAcknowledged, true); assert.ok(record.failedAt && record.closedAt);
});
test("abort during authorization persistence cannot return a usable socket", async t => {
  const url = await peer(t, () => {}), controller = new AbortController(), record = {};
  await assert.rejects(connectNormalCDP(url, { record, signal: controller.signal, persist: async () => { if (record.handshakeAcknowledged) controller.abort(new Error("human-stop")); } }), /human-stop/);
  assert.ok(record.closedAt && record.failedAt);
});
test("diagnostic refuses DNS, credentials, nonloopback, missing ports and alternate target paths", async () => {
  for (const url of ["ws://localhost:9222/devtools/browser/id", "ws://2130706433:9222/devtools/browser/id", "ws://user:password@127.0.0.1:9222/devtools/browser/id", "ws://example.com:9222/devtools/browser/id", "ws://127.0.0.1/devtools/browser/id", "ws://127.0.0.1:9222/json/version", "ws://127.0.0.1:9222/devtools/browser/id?x=1"])
    await assert.rejects(connectNormalCDP(url));
});
