import assert from "node:assert/strict";
import test from "node:test";
import net from "node:net";
import vm from "node:vm";
import WebSocket from "ws";
import { aboutDocumentEvidence, assertNativeBrowserInventory, awaitNativeDiagnosticSocket, braveDeveloperModePoint, canonicalJSON, checkAboutEvidence, checkBrandIdentity, checkBrowserProcess, checkDiscoveredProfile, checkLoadedSentinel, checkTrustedNativeTaskReceipt, classifyPrivateBrowserProcesses, nativeBrowserInstallationPassed, nativeBrowserPlan, observerManifestForVendor, openNativeDiagnosticPage, windowsCommandArguments } from "./native-browser-installation.mjs";

const environment = { LOCALAPPDATA: "D:\\isolated\\local", APPDATA: "D:\\isolated\\roaming" };
test("brand plans use isolated catalogue roots and reject aliases pretending to be actual products", () => {
  assert.equal(nativeBrowserPlan("brave", environment).profileRoot, "D:\\isolated\\local\\BraveSoftware\\Brave-Browser\\User Data");
  assert.equal(nativeBrowserPlan("vivaldi", environment).profileRoot, "D:\\isolated\\local\\Vivaldi\\User Data");
  assert.equal(nativeBrowserPlan("vivaldi", environment).about, "chrome://version/", "CDP must not rely on the Vivaldi address-field About alias rewriter");
  assert.equal(nativeBrowserPlan("vivaldi", environment).manager, "chrome://extensions/", "Use the canonical engine URL in the official package's extension-manager alias mapping");
  assert.equal(nativeBrowserPlan("vivaldi", environment).managerBackground, true, "The unsuccessful foreground setup hypothesis was reverted");
  assert.equal(nativeBrowserPlan("brave", environment).managerBackground, true);
  assert.equal(nativeBrowserPlan("opera", environment).managerBackground, true);
  assert.equal(nativeBrowserPlan("opera", environment).profileRoot, "D:\\isolated\\roaming\\Opera Software\\Opera Stable");
  for (const name of ["chrome", "chromium", "edge", "Brave", "", "toString"]) assert.throws(() => nativeBrowserPlan(name, environment));
  assert.throws(() => nativeBrowserPlan("opera", { APPDATA: "relative" }));
});

test("diagnostic page retains first failed evaluation, actual targets and connection without retrying it", async () => {
  const error = new Error("Runtime.evaluate timed out"), record = {}, snapshots = [], calls = [];
  const target = { id: "page-1", type: "page", url: "chrome://extensions/", title: "Extensions", webSocketDebuggerUrl: "ws://127.0.0.1:1234/page-1" };
  let evaluations = 0;
  const control = { call: async (method, params) => { calls.push({ method, params }); return method === "Target.createTarget" ? { targetId: target.id } : { targetInfo: { targetId: target.id, type: target.type, url: target.url, attached: true } }; } };
  await assert.rejects(openNativeDiagnosticPage({ url: target.url, control, targets: async () => [target], connect: async () => ({ state: () => "open", evaluate: async () => { evaluations++; throw error; } }), record, persist: async () => snapshots.push(structuredClone(record)) }), value => value === error);
  assert.equal(evaluations, 1); assert.equal(record.stage, "document-ready"); assert.equal(record.connection.state, "open");
  assert.match(record.firstEvaluation.error, /Runtime.evaluate timed out/); assert.equal(record.firstEvaluation, record.lastEvaluation);
  assert.deepEqual(record.failureDiagnostics[0].targets, [target]); assert.equal(record.failureDiagnostics[1].target.targetId, target.id);
  assert.deepEqual(calls.map(value => value.method), ["Target.createTarget", "Target.getTargetInfo"]);
  assert.equal(calls[0].params.background, true); assert.equal(snapshots.at(-1).error, error.stack);
  assert.ok(snapshots.some(value => value.firstEvaluation?.requestedAt && !value.firstEvaluation.error), "Persist before awaiting the first CDP evaluation");
});

test("supplemental diagnostic timeout cannot replace the first CDP failure", async () => {
  const error = new Error("first evaluation failed"), record = {}; let lists = 0;
  await assert.rejects(openNativeDiagnosticPage({ url: "chrome://extensions/", record, diagnosticTimeoutMs: 10, persist: async () => {},
    control: { call: async method => method === "Target.createTarget" ? { targetId: "page-1" } : new Promise(() => {}) },
    targets: async () => ++lists === 1 ? [{ id: "page-1", webSocketDebuggerUrl: "ws://localhost/page-1" }] : new Promise(() => {}),
    connect: async () => ({ state: () => "closed", evaluate: async () => { throw error; } }),
  }), value => value === error);
  assert.equal(record.connection.state, "closed"); assert.equal(record.failureDiagnostics.length, 2);
  assert.ok(record.failureDiagnostics.every(value => value.error.includes("timed out"))); assert.equal(lists, 2);
});

test("diagnostic readiness records first and final actual document state with bounded history", async () => {
  const record = {}, states = ["loading", "interactive", "complete"];
  const page = { state: () => "open", evaluate: async () => ({ url: "chrome://version/", title: "About", readyState: states.shift() }) };
  const result = await openNativeDiagnosticPage({ url: "chrome://version/", record, persist: async () => {}, sleep: async () => {}, control: { call: async () => ({ targetId: "page-1" }) }, targets: async () => [{ id: "page-1", webSocketDebuggerUrl: "ws://localhost/page-1" }], connect: async () => page });
  assert.equal(result.page, page); assert.equal(record.stage, "ready"); assert.equal(record.evaluationCount, 3);
  assert.equal(record.firstEvaluation.value.readyState, "loading"); assert.equal(record.lastEvaluation.value.readyState, "complete");
  assert.equal(record.firstEvaluation.value.url, "chrome://version/"); assert.equal(record.error, undefined);
  assert.equal(record.background, true, "Ordinary diagnostic and observer pages remain background by default");
});

test("vendor-created manager does not create a second CDP tab or change observer background defaults", async () => {
  const requests = [], page = { evaluate: async () => ({ url: "chrome://extensions/", title: "Extensions", readyState: "complete" }) };
  const common = { control: { call: async (method, params) => { requests.push({ method, params }); return { targetId: "page-1" }; } }, targets: async () => [{ id: "page-1", webSocketDebuggerUrl: "ws://localhost/page-1" }], connect: async () => page, persist: async () => {} };
  const setup = {}, observer = {}; let creations = 0;
  await openNativeDiagnosticPage({ ...common, url: "chrome://extensions/", createTarget: async () => { creations++; return "page-1"; }, record: setup });
  await openNativeDiagnosticPage({ ...common, url: "chrome-extension://observer/observer.html", record: observer });
  assert.equal(creations, 1); assert.equal(setup.targetId, "page-1"); assert.match(setup.creationMethod, /vendor UI/);
  assert.deepEqual(requests, [{ method: "Target.createTarget", params: { url: "chrome-extension://observer/observer.html", background: true } }]);
  assert.equal(setup.background, true); assert.equal(observer.background, true);
});

test("a stalled real socket handshake terminates once and preserves failure evidence without reconnecting", async () => {
  const peers = new Set(); let accepted = 0;
  const server = net.createServer(peer => { accepted++; peers.add(peer); peer.on("close", () => peers.delete(peer)); peer.on("error", () => {}); peer.resume(); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const record = { requestedAt: Date.now() }, snapshots = [];
  const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}/browser-test`);
  try {
    await assert.rejects(awaitNativeDiagnosticSocket(socket, { record, persist: async () => snapshots.push(structuredClone(record)), timeoutMs: 50 }), /diagnostic CDP connection timed out/);
    assert.equal(accepted, 1); assert.equal(record.stateAtFailure, "connecting"); assert.equal(record.state, "closed");
    assert.ok(record.elapsedMs >= 40); assert.ok(record.terminatedAt && record.closedAt); assert.equal(snapshots.at(-1).state, "closed");
  } finally { socket.terminate(); for (const peer of peers) peer.destroy(); await new Promise(resolve => server.close(resolve)); }
});

test("bounded shadow diagnostics cannot hide a second root profile field beyond the scan limit", () => {
  const plan = nativeBrowserPlan("brave", environment), profile = plan.profileRoot + "\\Default";
  const node = { id: "", localName: "div", checkVisibility: () => true, matches: () => false };
  const field = { id: "profile_path", localName: "td", checkVisibility: () => true, textContent: profile };
  const document = { title: "Brave", documentElement: { outerHTML: "<body>Brave</body>" }, body: { innerText: "Brave" }, querySelectorAll: selector => selector === "td#profile_path" ? [field, { ...field }] : Array(5002).fill(node) };
  const result = vm.runInNewContext(`(${aboutDocumentEvidence.toString()})()`, { document, location: { href: plan.about } });
  assert.equal(result.truncated, true); assert.equal(result.profileFields.length, 2); assert.match(result.profileFieldScope, /complete root document/);
  assert.throws(() => checkAboutEvidence(result, plan), /unique observed profile field/);
});

test("browser process proof requires exact private user-data-dir and a root process", () => {
  const process = { ProcessId: 99, CreationDate: "2026-10-11T01:02:03Z", ExecutablePath: "C:\\Browser Apps\\brave.exe", CommandLine: '"C:\\Browser Apps\\brave.exe" --user-data-dir="D:\\isolated\\User Data" --no-first-run' };
  const expected = { browserPid: 99, profileRoot: "D:\\isolated\\User Data" };
  assert.equal(checkBrowserProcess(process, expected), process);
  assert.equal(checkBrowserProcess({ ...process, CommandLine: 'brave.exe --user-data-dir "D:\\isolated\\User Data"' }, expected).ProcessId, 99);
  for (const CommandLine of [
    'brave.exe --user-data-dir="D:\\isolated\\User Data sibling"',
    'brave.exe --log="--user-data-dir=D:\\isolated\\User Data"',
    process.CommandLine + ' --user-data-dir="D:\\isolated\\User Data"',
    process.CommandLine + " --type=renderer",
    'brave.exe --user-data-dir="D:\\isolated\\User Data',
  ]) assert.throws(() => checkBrowserProcess({ ...process, CommandLine }, expected));
  assert.throws(() => checkBrowserProcess({ ...process, ProcessId: 100 }, expected));
  assert.deepEqual(windowsCommandArguments('app.exe "a' + "\\".repeat(2) + '" plain'), ["app.exe", "a\\", "plain"]);
});

test("cleanup detects pre-CDP handoffs while ancestry alone does not own external system processes", () => {
  const executable = "D:\\fixture\\brave.exe", profileRoot = "D:\\private\\User Data";
  const process = { ProcessId: 55, ParentProcessId: 44, CreationDate: "now", ExecutablePath: executable, CommandLine: 'brave.exe --user-data-dir="D:\\private\\User Data"' };
  const processes = [process, { ProcessId: 56, ParentProcessId: 55, CreationDate: "now", ExecutablePath: executable, CommandLine: "brave.exe --type=renderer" }, { ProcessId: 57, ParentProcessId: 56, CreationDate: "now", ExecutablePath: "C:\\helper.exe", CommandLine: "helper.exe -daemon" }, { ProcessId: 77, ParentProcessId: 1, CreationDate: "now", ExecutablePath: executable, CommandLine: "brave.exe" }];
  const scoped = classifyPrivateBrowserProcesses(processes, { profileRoot, executable, knownIds: [44], previousTreeIds: [77] });
  assert.deepEqual(scoped.owned.map(value => value.ProcessId), [55, 56]);
  assert.deepEqual(scoped.externalDescendants.map(value => value.ProcessId), [57]);
  assert.deepEqual(classifyPrivateBrowserProcesses(processes, { profileRoot, executable, knownIds: [] }).owned.map(value => value.ProcessId), [55, 56, 77]);
  assert.deepEqual(classifyPrivateBrowserProcesses(processes.slice(1), { profileRoot, executable, knownIds: [55, 57], previousTreeIds: [77] }).owned.map(value => value.ProcessId), [56, 57], "An outside executable explicitly in CDP inventory must still exit");
  const externalRoot = { ...process, ProcessId: 88, ExecutablePath: "C:\\other\\app.exe" };
  assert.deepEqual(classifyPrivateBrowserProcesses([externalRoot], { profileRoot, executable }).owned.map(value => value.ProcessId), [88], "Exact private-profile roots cannot be hidden by another executable directory");
  const helper = { ...process, ProcessId: 89, ExecutablePath: "D:\\fixture\\137\\browser-helper.exe", CommandLine: "helper.exe --type=utility" };
  const sibling = { ...helper, ProcessId: 90, ExecutablePath: "D:\\fixture-other\\helper.exe" };
  assert.deepEqual(classifyPrivateBrowserProcesses([helper, sibling], { profileRoot, executable }).owned.map(value => value.ProcessId), [89], "Product helpers belong to the exact executable directory tree, not a string prefix");
  for (const missing of [{ ExecutablePath: null }, { CommandLine: null }, { CreationDate: null }, { CommandLine: 'unclosed "quote' }]) {
    const uncertain = classifyPrivateBrowserProcesses([{ ...processes[2], ...missing }], { profileRoot, executable, knownIds: [56] });
    assert.equal(uncertain.externalDescendants.length, 0); assert.equal(uncertain.unknownDescendants.length, 1, "Unidentified descendants must block cleanup");
  }
  assert.equal(classifyPrivateBrowserProcesses([{ ...externalRoot, CommandLine: externalRoot.CommandLine + " --type=renderer" }], { profileRoot, executable }).owned.length, 1, "Exact private profile remains owned regardless helper type");
});

test("fixed registry comparisons ignore PowerShell object key enumeration order", () => {
  assert.equal(canonicalJSON([{ view: "Registry32", values: [{ name: "", kind: "String", value: "manifest" }], exists: true }]), canonicalJSON([{ exists: true, values: [{ value: "manifest", kind: "String", name: "" }], view: "Registry32" }]));
  assert.notEqual(canonicalJSON({ exists: true, values: ["a"] }), canonicalJSON({ exists: true, values: ["b"] }));
});

test("real brand identity rejects Chrome binary and missing/wrong publisher signatures", () => {
  const value = { path: "D:\\brave.exe", sha256: "a".repeat(64), productName: "Brave Browser", companyName: "Brave Software, Inc.", productVersion: "155.1.97.56", fileVersion: "155.1.97.56", signatureStatus: "Valid", signer: "CN=Brave Software, Inc., O=Brave Software, Inc." };
  assert.equal(checkBrandIdentity(value, "brave"), value);
  for (const changed of [{ productName: "Google Chrome for Testing" }, { signer: "CN=Google LLC" }, { signatureStatus: "NotSigned" }, { sha256: "a".repeat(63) }, { productVersion: "" }]) assert.throws(() => checkBrandIdentity({ ...value, ...changed }, "brave"));
  assert.throws(() => checkBrandIdentity(value, "vivaldi"));
});

test("About evidence needs brand text and exact actual profile in the observed root field", () => {
  const brave = nativeBrowserPlan("brave", environment);
  const field = value => ({ selector: "td#profile_path", tag: "td", id: "profile_path", visible: true, value });
  const evidence = { url: brave.about, text: `Brave\n个人资料路径\t${brave.profileRoot}\\Default\n`, profileFields: [field(brave.profileRoot + "\\Default")] };
  assert.deepEqual(checkAboutEvidence(evidence, brave), { profilePath: brave.profileRoot + "\\Default", directory: "Default" });
  for (const value of [brave.profileRoot + "\\Default-extra", brave.profileRoot + "\\Default\\subdirectory", "C:\\Users\\Actual\\Default"]) assert.throws(() => checkAboutEvidence({ ...evidence, profileFields: [field(value)] }, brave));
  for (const profileFields of [[], [field(brave.profileRoot + "\\Default"), field(brave.profileRoot + "\\Default")], [{ ...field(brave.profileRoot + "\\Default"), visible: false }], [{ ...field(brave.profileRoot + "\\Default"), id: "command_line" }]]) assert.throws(() => checkAboutEvidence({ ...evidence, profileFields }, brave));
  assert.throws(() => checkAboutEvidence({ ...evidence, text: `Chrome\n${brave.profileRoot}\\Default` }, brave));
  assert.throws(() => checkAboutEvidence({ ...evidence, url: "https://example.test/version" }, brave));
  const vivaldi = nativeBrowserPlan("vivaldi", environment), version = { url: vivaldi.about, text: "Vivaldi 8.2.4133.84", profileFields: [field(vivaldi.profileRoot + "\\Default")] };
  assert.equal(checkAboutEvidence(version, vivaldi).directory, "Default");
  assert.throws(() => checkAboutEvidence({ ...version, url: "chrome-error://chromewebdata/" }, vivaldi), "The old error document cannot become brand evidence");
  assert.throws(() => checkAboutEvidence({ ...version, text: "Chromium 152" }, vivaldi), "A generic Chromium version page does not identify Vivaldi");
});

test("Opera identity requires the exact complete observed semantic shadow chain, not cache/install paths", () => {
  const opera = nativeBrowserPlan("opera", environment), brave = nativeBrowserPlan("brave", environment);
  const field = { selector: "p.profile-path > span.value", rootPath: "document > main-view::shadow > about-opera::shadow", id: "", tag: "span", className: "value", parentTag: "p", parentClass: "profile-path", hostVisibility: [true, true], visible: true, value: opera.profileRoot + "\\Default" };
  const evidence = { url: "chrome://about/", text: "Opera One 137", profileStructure: { kind: "opera-about-shadow", mainViewCount: 1, aboutOperaCount: 1, incompleteShadowRoots: 0 }, profileFields: [field] };
  assert.equal(checkAboutEvidence(evidence, opera).directory, "Default");
  assert.equal(checkAboutEvidence({ ...evidence, profileFields: [{ ...field, value: opera.profileRoot }] }, opera).directory, ".");
  for (const change of [{ selector: "p.cache-path > span.value" }, { parentClass: "cache-path" }, { parentClass: "install-path" }, { rootPath: "document > other-view::shadow" }, { tag: "div" }, { id: "profile_path" }, { className: "label" }, { visible: false }, { hostVisibility: [true, false] }, { value: opera.profileRoot + "\\Default-other" }]) assert.throws(() => checkAboutEvidence({ ...evidence, profileFields: [{ ...field, ...change }] }, opera));
  for (const change of [{ mainViewCount: 2 }, { aboutOperaCount: 2 }, { incompleteShadowRoots: 1 }]) assert.throws(() => checkAboutEvidence({ ...evidence, profileStructure: { ...evidence.profileStructure, ...change } }, opera));
  assert.throws(() => checkAboutEvidence({ ...evidence, profileFields: [field, field] }, opera));
  assert.throws(() => checkAboutEvidence({ ...evidence, profileFields: [{ selector: "td#profile_path", id: "profile_path", tag: "td", visible: true, value: field.value }] }, opera));
  assert.throws(() => checkAboutEvidence({ ...evidence, url: brave.about, text: "Brave", profileFields: [{ ...field, value: brave.profileRoot + "\\Default" }] }, brave));
});

test("observer navigation exposure is limited to its HTML and the validated vendor extension identity", () => {
  const original = { manifest_version: 3, name: "observer", version: "1.0.0", key: "key", permissions: ["tabs"] }, vendorId = "mpognobbkildjkofajifpdfhcoklimli";
  const manifest = observerManifestForVendor(original, vendorId);
  assert.equal(original.web_accessible_resources, undefined); assert.equal(manifest.permissions, original.permissions);
  assert.deepEqual(manifest, { ...original, web_accessible_resources: [{ resources: ["integration-observer.html"], extension_ids: [vendorId] }] });
  for (const id of ["*", "https://example.test/*", "a".repeat(31), "q".repeat(32)]) assert.throws(() => observerManifestForVendor(original, id));
  assert.throws(() => observerManifestForVendor({ ...original, web_accessible_resources: [] }, vendorId));
});

test("only one exact disabled native Opera feature is classified after real brand identity proof", () => {
  const feature = { id: "opera-ad-blocker", location: "FROM_STORE", state: "DISABLED", type: "INTERNAL" };
  const identity = { passed: true, actualExecutable: { path: "D:\\opera.exe", sha256: "a".repeat(64), productName: "Opera Internet Browser", companyName: "Opera Software", productVersion: "137.0.6036.39", fileVersion: "137.0.6036.39", signatureStatus: "Valid", signer: "CN=Opera Norway AS" } };
  const fixture = { id: "a".repeat(32), location: "UNPACKED", state: "ENABLED", type: "EXTENSION" }, component = { id: "system", location: "COMPONENT", state: "ENABLED", type: "EXTENSION" };
  const context = { name: "opera", identity };
  assert.deepEqual(assertNativeBrowserInventory([feature, fixture, component], [fixture.id], context), { browserFeatures: [feature], fixture: [fixture], components: [component] });
  assert.deepEqual(assertNativeBrowserInventory([feature], [], context).browserFeatures, [feature]);
  for (const change of [{ state: "ENABLED" }, { type: "EXTENSION" }, { location: "COMPONENT" }, { id: "some-store-extension" }]) assert.throws(() => assertNativeBrowserInventory([{ ...feature, ...change }], [], context));
  assert.throws(() => assertNativeBrowserInventory([feature, feature], [], context));
  assert.throws(() => assertNativeBrowserInventory([feature], [fixture.id], context), /PROFILE_NOT_ISOLATED/);
  for (const name of ["brave", "vivaldi", "chrome"]) assert.throws(() => assertNativeBrowserInventory([feature], [], { ...context, name }));
  assert.throws(() => assertNativeBrowserInventory([feature], [], { ...context, identity: { ...identity, passed: false } }));
  assert.throws(() => assertNativeBrowserInventory([feature], [], { ...context, identity: { ...identity, actualExecutable: { ...identity.actualExecutable, signatureStatus: "NotSigned" } } }));
  assert.throws(() => assertNativeBrowserInventory([feature, { ...fixture, id: "unrecognized" }], [], context), /PROFILE_NOT_ISOLATED/);
});

test("public discovery must join exact brand/profile/extension/instance/endpoint", () => {
  const row = { browser: "opera", directory: ".", extensionId: "a".repeat(32), target: "opera:.", version: "1.2.3", source: "preferences", connected: true, socketPath: "pipe-1", instanceId: "instance-1" };
  const expected = { name: "opera", directory: ".", extensionId: row.extensionId, endpoint: row.socketPath, instanceId: row.instanceId, connected: true };
  assert.equal(checkDiscoveredProfile([row], expected), row);
  for (const delta of [{ browser: "chrome" }, { directory: "Default" }, { extensionId: "b".repeat(32) }, { connected: false }, { socketPath: "pipe-2" }, { instanceId: "instance-2" }]) assert.throws(() => checkDiscoveredProfile([{ ...row, ...delta }], expected));
  assert.throws(() => checkDiscoveredProfile([row, row], expected));
});

test("Brave install click uses only the observed visible inner control geometry", () => {
  const value = { tag: "leo-toggle", id: "toggle", visible: true, disabled: false, checked: false, hostChecked: false, rect: { x: 100, y: 20, width: 32, height: 20 }, viewport: { width: 800, height: 600 } };
  assert.deepEqual(braveDeveloperModePoint(value), { x: 116, y: 30 });
  for (const change of [{ tag: "cr-toggle" }, { id: "pinned-toggle" }, { visible: false }, { disabled: true }, { checked: true }, { hostChecked: true }, { rect: { ...value.rect, width: 0 } }, { rect: { ...value.rect, y: 800 } }]) assert.throws(() => braveDeveloperModePoint({ ...value, ...change }));
});

test("task receipt requires actual bounded trusted input events as well as trusted click", () => {
  const expected = { nonce: "nonce", note: "a delivery note" }, value = { ...expected, trusted: true, inputOverflow: false, inputEvents: [{ type: "input", trusted: true, value: expected.note }, { type: "change", trusted: true, value: expected.note }] };
  assert.equal(checkTrustedNativeTaskReceipt(value, expected), value);
  for (const change of [{ trusted: false }, { inputOverflow: true }, { inputEvents: [] }, { inputEvents: [value.inputEvents[1]] }, { inputEvents: [{ ...value.inputEvents[0], trusted: false }] }, { inputEvents: [{ ...value.inputEvents[0], value: "stale" }] }, { inputEvents: Array(65).fill(value.inputEvents[0]) }]) assert.throws(() => checkTrustedNativeTaskReceipt({ ...value, ...change }, expected));
});

test("sentinel binds requested URL to loaded native identity despite an empty tabs.create URL", () => {
  const url = "http://127.0.0.1:6502/sentinel";
  const created = { id: 123, windowId: 100, url: "", pendingUrl: url, status: "loading", active: true, groupId: -1, pinned: false };
  const loaded = { ...created, url, pendingUrl: undefined, status: "complete" };
  assert.equal(checkLoadedSentinel(created, loaded, url), loaded);
  assert.equal(created.url, "", "Creation evidence must remain the actual pending reply");
  for (const change of [{ url: "" }, { url: url + "?changed" }, { id: 124 }, { windowId: 101 }, { active: false }, { status: "loading" }, { groupId: 12 }, { pinned: true }]) assert.throws(() => checkLoadedSentinel(created, { ...loaded, ...change }, url));
  assert.throws(() => checkLoadedSentinel(created, loaded, ""));
});

test("installation acceptance cannot pass on action success alone or forced/incomplete cleanup", () => {
  const report = { identity: { passed: true }, discovery: { passed: true }, task: { passed: true }, focus: { passed: true }, finalInventory: { passed: true }, eof: { result: { exitCode: 0, exactHandle: true } }, browserExit: { result: { exitCode: 0, exactHandle: true } }, launcherExit: { code: 0, signal: null }, cleanup: { browserProcessesGone: true, nativeProcessesGone: true, endpointUnreachable: true, descriptorsClean: true, fixedRegistrationUnchanged: true, registration: { removed: true }, errors: [] } };
  assert.equal(nativeBrowserInstallationPassed(report), true);
  for (const section of ["identity", "discovery", "task", "focus", "finalInventory"]) assert.equal(nativeBrowserInstallationPassed({ ...report, [section]: { passed: false } }), false);
  for (const field of ["browserProcessesGone", "nativeProcessesGone", "endpointUnreachable", "descriptorsClean", "fixedRegistrationUnchanged"]) assert.equal(nativeBrowserInstallationPassed({ ...report, cleanup: { ...report.cleanup, [field]: false } }), false);
  assert.equal(nativeBrowserInstallationPassed({ ...report, eof: { result: { exitCode: 1, exactHandle: true } } }), false);
  assert.equal(nativeBrowserInstallationPassed({ ...report, browserExit: { result: { exitCode: 1, exactHandle: true } } }), false);
  assert.equal(nativeBrowserInstallationPassed({ ...report, launcherExit: { code: null, signal: "SIGTERM" } }), false);
  assert.equal(nativeBrowserInstallationPassed({ ...report, launcherError: "spawn failed" }), false);
  assert.equal(nativeBrowserInstallationPassed({ ...report, cleanup: { ...report.cleanup, forced: true } }), false);
  assert.equal(nativeBrowserInstallationPassed({ ...report, cleanup: { ...report.cleanup, registration: { untouched: true } } }), false);
  assert.equal(nativeBrowserInstallationPassed({ ...report, error: "Earlier failed step" }), false);
});
