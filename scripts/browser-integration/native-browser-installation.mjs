// Opt-in Windows acceptance against a real signed browser, never a relabelled
// Chromium binary. Importing this module never starts a browser or server.
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
import { FocusLedger, focusSnapshotExpression, readFocusEvidence } from "./focus-ledger.mjs";
import { stageReloadObserver } from "./extension-reload-support.mjs";
import { assertFixtureExtensionInventory, assertNativeProcessIdentity, nativeRegistrationSource, nativeWatchSource } from "./native-lifecycle-support.mjs";
import { decodeParallelPNG } from "./background-parallel-workflow.mjs";
import { nativeDiagnosticsEnabled, nativeDiagnosticPrelude, nativeDiagnosticResult, nativeDiagnosticTraceComplete } from "./native-api-diagnostics.mjs";
import { nativeOwnershipEnabled, runNativeOwnershipWorkflow } from "./native-ownership-workflow.mjs";
import { vivaldiReadinessEnabled, openVivaldiReadinessPage, vivaldiReadinessResult } from "./vivaldi-readiness-diagnostic.mjs";
import { vivaldiInputEnabled, inputFixtureSource, captureInputLedgerOnce, inputDOMTraceComplete, inputNativeTraceComplete, inputCommandEvidence, vivaldiInputResult } from "./vivaldi-input-diagnostic.mjs";
import { vivaldiTaskReadinessEnabled, waitForVivaldiTaskCommit, taskReadinessDiagnosticResult } from "./vivaldi-task-readiness-diagnostic.mjs";
import { vivaldiKeyInputEnabled, keyCommandEvidence, keyInputDiagnosticResult } from "./vivaldi-key-input-diagnostic.mjs";
import { vivaldiPointerFocusEnabled, pointerCommandEvidence, pointerFocusDiagnosticResult } from "./vivaldi-pointer-focus-diagnostic.mjs";
import { vivaldiDOMFocusEnabled, runDOMFocusDiagnostic, domFocusCommandEvidence, domFocusDiagnosticResult } from "./vivaldi-dom-focus-diagnostic.mjs";

const brands = Object.freeze({
  brave: { label: "Brave", about: "brave://version/", manager: "brave://extensions/", base: "LOCALAPPDATA", relative: "BraveSoftware/Brave-Browser/User Data", product: /brave/i, publisher: /Brave Software/i },
  opera: { label: "Opera", about: "opera://about/", manager: "opera://extensions/", base: "APPDATA", relative: "Opera Software/Opera Stable", product: /opera/i, publisher: /Opera (?:Norway|Software)/i },
  // Vivaldi's address-bar UI rewrites its About aliases to a component page.
  // Target.createTarget bypasses that UI and normalized vivaldi://about to an
  // invalid chrome://about in 1d9k5o. Request the engine's version route directly;
  // actual Vivaldi body/profile and signed-process identity remain mandatory.
  // Its official 8.2.4133.84 resources/vivaldi/bundle.js also explicitly maps
  // displayUrl "vivaldi://extensions" to url "chrome://extensions".
  vivaldi: { label: "Vivaldi", about: "chrome://version/", manager: "chrome://extensions/", base: "LOCALAPPDATA", relative: "Vivaldi/User Data", product: /vivaldi/i, publisher: /Vivaldi Technologies/i },
});
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const normalized = value => path.win32.resolve(value).toLowerCase();
async function diagnosticBound(promise, timeout, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeout); })]); }
  finally { clearTimeout(timer); }
}
function diagnosticTarget(value) {
  return Object.fromEntries(["id", "targetId", "type", "url", "title", "webSocketDebuggerUrl", "attached", "browserContextId"].filter(key => value?.[key] !== undefined).map(key => [key, typeof value[key] === "string" ? value[key].slice(0, 2000) : value[key]]));
}
export async function awaitNativeDiagnosticSocket(socket, { record, persist, timeoutMs }) {
  const state = () => ["connecting", "open", "closing", "closed"][socket.readyState];
  try {
    await diagnosticBound(new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); socket.once("close", () => reject(new Error("Diagnostic CDP closed before handshake"))); }), timeoutMs, "diagnostic CDP connection");
    record.connectedAt = Date.now(); record.elapsedMs = record.connectedAt - record.requestedAt; record.state = state(); await persist();
  } catch (error) {
    record.failedAt = Date.now(); record.elapsedMs = record.failedAt - record.requestedAt; record.stateAtFailure = state(); record.error = error.stack ?? String(error);
    const closed = socket.readyState === WebSocket.CLOSED ? Promise.resolve() : new Promise(resolve => socket.once("close", resolve));
    socket.terminate(); record.terminatedAt = Date.now();
    try { await diagnosticBound(closed, 1000, "failed CDP socket close"); record.closedAt = Date.now(); } catch (closeError) { record.closeError = closeError.message; }
    record.state = state(); try { await persist(); } catch (persistError) { record.persistenceError = persistError.stack ?? String(persistError); }
    throw error;
  }
}
// Only reads the isolated browser's target metadata and page readiness. Keep
// the original failure even if obtaining supplemental diagnostics also fails.
export async function openNativeDiagnosticPage({ url, background = true, createTarget, control, targets, connect, record, persist, timeoutMs = 25000, diagnosticTimeoutMs = 2500, now = Date.now, sleep = delay }) {
  let page;
  assert.equal(typeof background, "boolean");
  Object.assign(record, { requestedUrl: url, background, requestedAt: now(), stage: "create-target" });
  try {
    await persist();
    record.creationMethod = createTarget ? "observed vendor UI chrome.tabs.create and unique new target association" : "Target.createTarget";
    record.targetId = createTarget ? await createTarget() : (await control.call("Target.createTarget", { url, background })).targetId;
    assert.ok(record.targetId); record.createdAt = now(); record.stage = "target-advertised"; await persist();
    const targetDeadline = now() + timeoutMs;
    do {
      const values = await diagnosticBound(targets(), Math.max(1, targetDeadline - now()), "diagnostic target list");
      const target = values.find(value => value.id === record.targetId);
      if (target) { record.advertisedTarget = diagnosticTarget(target); break; }
      if (now() >= targetDeadline) throw new Error("Diagnostic target was not advertised before deadline");
      await sleep(75);
    } while (true);
    record.stage = "connect"; record.connection = { requestedAt: now(), url: record.advertisedTarget.webSocketDebuggerUrl, state: "connecting" }; await persist();
    page = await diagnosticBound(connect(record.advertisedTarget.webSocketDebuggerUrl), 10000, "diagnostic CDP connection");
    record.connection.connectedAt = now(); record.connection.state = page.state?.() ?? "connected"; record.stage = "document-ready"; await persist();
    const deadline = now() + timeoutMs;
    record.evaluationCount = 0;
    do {
      const evaluation = { requestedAt: now() };
      record.evaluationCount++; record.lastEvaluation = evaluation;
      if (record.evaluationCount === 1) { record.firstEvaluation = evaluation; await persist(); }
      try {
        evaluation.value = await diagnosticBound(page.evaluate("({url:location.href,title:document.title,readyState:document.readyState})"), Math.max(1, deadline - now()), "diagnostic document ready");
        evaluation.completedAt = now();
      } catch (error) { evaluation.error = error.stack ?? String(error); evaluation.failedAt = now(); throw error; }
      assert.ok(["loading", "interactive", "complete"].includes(evaluation.value?.readyState), "Diagnostic evaluation did not return a document state");
      if (evaluation.value.readyState === "complete") break;
      if (now() >= deadline) throw new Error("Diagnostic document did not complete before deadline");
      if (record.evaluationCount === 1) await persist();
      await sleep(75);
    } while (true);
    record.stage = "ready"; record.completedAt = now(); await persist(); return { targetId: record.targetId, page };
  } catch (error) {
    record.failedAt = now(); record.error = error.stack ?? String(error);
    if (record.connection) record.connection.state = page?.state?.() ?? (page ? "connected" : "not-connected");
    // These are independent, bounded reads; none reloads or changes the target.
    const diagnostics = await Promise.allSettled([
      diagnosticBound(targets(), diagnosticTimeoutMs, "failure target list"),
      record.targetId ? diagnosticBound(control.call("Target.getTargetInfo", { targetId: record.targetId }), diagnosticTimeoutMs, "failure target info") : Promise.resolve(null),
    ]);
    record.failureDiagnostics = diagnostics.map((result, index) => result.status === "fulfilled"
      ? { kind: index ? "target-info" : "target-list", at: now(), ...(index ? { target: result.value ? diagnosticTarget(result.value.targetInfo) : null } : { count: result.value.length, truncated: result.value.length > 80, targets: result.value.slice(0, 80).map(diagnosticTarget) }) }
      : { kind: index ? "target-info" : "target-list", at: now(), error: result.reason.stack ?? String(result.reason) });
    try { await persist(); } catch (persistError) { record.persistenceError = persistError.stack ?? String(persistError); }
    throw error;
  }
}
// PowerShell 7 can pass its module directory to powershell.exe 5.1. Loading the
// PS7 Security module there fails with duplicate ObjectSecurity type members.
// These fixture helpers only need the OS-shipped modules of their own runtime.
export function windowsPowerShellCommand(source) {
  return "$env:PSModulePath=[IO.Path]::Combine($PSHOME,'Modules'); $taskUTF8=[System.Text.UTF8Encoding]::new($false); [Console]::OutputEncoding=$taskUTF8; $OutputEncoding=$taskUTF8; $ErrorActionPreference='Stop'; " + source;
}
export function canonicalJSON(value) {
  return JSON.stringify(Array.isArray(value) ? value.map(item => JSON.parse(canonicalJSON(item))) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, JSON.parse(canonicalJSON(value[key]))])) : value);
}
export function nativeBrowserPlan(name, environment) {
  assert.ok(Object.hasOwn(brands, name), `Unsupported native browser: ${name}`);
  const brand = brands[name]; assert.ok(path.win32.isAbsolute(environment[brand.base]));
  return { name, managerBackground: true, ...brand, profileRoot: path.win32.join(environment[brand.base], brand.relative) };
}

// Executed in the real About document. Only the previously observed semantic
// root field or Opera's exact component chain supplies identity. Other shadow
// structures are bounded diagnostics, never a fallback path matcher.
export function aboutDocumentEvidence(name) {
  // Identity is an independent complete root-document query. The bounded
  // shadow traversal below must never imply that it proved unique identity.
  const profileFields = [], profileStructure = { kind: "root-document" };
  if (name === "opera") {
    // Observed in Opera 137 wjg9cX and defined by the shipped About Paragraph
    // resource. Query the full exact semantic chain independently of the
    // bounded diagnostic walk; install/cache paths are different paragraphs.
    const hosts = [...document.querySelectorAll("main-view")];
    Object.assign(profileStructure, { kind: "opera-about-shadow", mainViewCount: hosts.length, aboutOperaCount: 0, incompleteShadowRoots: 0 });
    for (const main of hosts) {
      if (!main.shadowRoot) { profileStructure.incompleteShadowRoots++; continue; }
      const aboutHosts = [...main.shadowRoot.querySelectorAll("about-opera")]; profileStructure.aboutOperaCount += aboutHosts.length;
      for (const about of aboutHosts) {
        if (!about.shadowRoot) { profileStructure.incompleteShadowRoots++; continue; }
        for (const node of about.shadowRoot.querySelectorAll("p.profile-path > span.value")) profileFields.push({ selector: "p.profile-path > span.value", rootPath: "document > main-view::shadow > about-opera::shadow", id: node.id, tag: node.localName, className: node.className, parentTag: node.parentElement.localName, parentClass: node.parentElement.className, hostVisibility: [main.checkVisibility(), about.checkVisibility()], visible: node.checkVisibility(), value: node.textContent.trim(), html: node.outerHTML, parentHTML: node.parentElement.outerHTML });
      }
    }
  } else for (const node of document.querySelectorAll("td#profile_path")) profileFields.push({ selector: "td#profile_path", id: node.id, tag: node.localName, visible: node.checkVisibility(), value: node.textContent.trim() });
  const result = { url: location.href, title: document.title, text: "", html: document.documentElement.outerHTML.slice(0, 32000), profileFields, profileStructure, profileFieldScope: name === "opera" ? "complete exact main-view/about-opera shadow chain query, independent of diagnostic truncation" : "complete root document query; shadow nodes are diagnostics only", shadowRoots: [], fieldNodes: [], scanned: 0, truncated: false };
  const roots = [{ root: document, path: "document" }]; let htmlRemaining = 120000, textRemaining = 24000;
  const addText = text => { const value = (text ?? "").slice(0, textRemaining); result.text += value + "\n"; textRemaining -= value.length; };
  addText(document.body?.innerText);
  while (roots.length && result.scanned < 5000) {
    const { root, path } = roots.shift();
    for (const node of root.querySelectorAll("*")) {
      if (++result.scanned > 5000) { result.truncated = true; break; }
      const identity = `${node.localName}${node.id ? "#" + node.id : ""}`, visible = node.checkVisibility();
      if (visible && result.fieldNodes.length < 120 && node.matches("dt,dd,th,td,label,[id],[aria-label]")) result.fieldNodes.push({ rootPath: path, tag: node.localName, id: node.id, label: node.getAttribute("aria-label"), text: (node.innerText ?? node.textContent ?? "").slice(0, 600), html: node.outerHTML.slice(0, 1200) });
      if (!node.shadowRoot) continue;
      if (result.shadowRoots.length >= 20) { result.truncated = true; continue; }
      const rootPath = `${path} > ${identity}::shadow`, html = node.shadowRoot.innerHTML.slice(0, Math.min(16000, htmlRemaining)); htmlRemaining -= html.length;
      const text = [...node.shadowRoot.children].filter(value => !value.matches("style,script,template") && value.checkVisibility()).map(value => value.innerText ?? "").join("\n").slice(0, 12000);
      result.shadowRoots.push({ rootPath, host: identity, visible, html, text }); if (visible) addText(text);
      roots.push({ root: node.shadowRoot, path: rootPath });
    }
  }
  if (roots.length || !htmlRemaining || !textRemaining) result.truncated = true;
  result.text = result.text.slice(0, 24000); return result;
}

// The process command line must name the exact private root, not a prefix or
// an arbitrary occurrence of that path in another argument.
export function windowsCommandArguments(command) {
  const result = []; let i = 0;
  while (i < command.length) {
    while (/\s/.test(command[i] ?? "") && i < command.length) i++;
    if (i === command.length) break;
    let value = "", quoted = false;
    while (i < command.length && (quoted || !/\s/.test(command[i]))) {
      let slashes = 0; while (command[i] === "\\") { slashes++; i++; }
      if (command[i] === '"') {
        value += "\\".repeat(Math.floor(slashes / 2));
        if (slashes % 2) value += '"'; else quoted = !quoted;
        i++;
      } else { value += "\\".repeat(slashes); if (i < command.length && (quoted || !/\s/.test(command[i]))) value += command[i++]; }
    }
    assert.equal(quoted, false, "Unterminated Windows command-line quote"); result.push(value);
  }
  return result;
}
export function checkBrowserProcess(process, { profileRoot, browserPid }) {
  assert.equal(process?.ProcessId, browserPid); assert.ok(process.ExecutablePath && process.CreationDate);
  const args = windowsCommandArguments(process.CommandLine ?? "");
  const roots = args.flatMap((value, index) => value === "--user-data-dir" ? [args[index + 1]] : value.startsWith("--user-data-dir=") ? [value.slice(16)] : []);
  assert.equal(roots.length, 1, "Browser process must have exactly one explicit private profile");
  assert.equal(normalized(roots[0]), normalized(profileRoot), "Browser process uses another profile");
  assert.equal(args.some(value => value.startsWith("--type=")), false, "CDP browser PID is a renderer/helper");
  return process;
}
function withinExecutableDirectory(file, executable) {
  if (!file || !executable) return false;
  const relative = path.win32.relative(path.win32.dirname(normalized(executable)), normalized(file));
  return relative !== ".." && !relative.startsWith("..\\") && !path.win32.isAbsolute(relative);
}
export function classifyPrivateBrowserProcesses(processes, { profileRoot, knownIds = [], executable, actualExecutable = executable, previousTreeIds = [] }) {
  const ids = new Set(knownIds), roots = new Set(), known = new Set(knownIds), uncertain = new Set();
  const inBrowserTree = process => [executable, actualExecutable].some(value => withinExecutableDirectory(process.ExecutablePath, value));
  for (const process of processes) {
    // Catch a launcher handoff or orphaned product helper even before CDP is
    // available. Pre-existing processes in that installation remain unrelated.
    if (inBrowserTree(process) && !previousTreeIds.includes(process.ProcessId)) ids.add(process.ProcessId);
    if (!process.ExecutablePath || !path.win32.isAbsolute(process.ExecutablePath) || !process.CreationDate || !process.CommandLine) uncertain.add(process.ProcessId);
    try {
      const args = windowsCommandArguments(process.CommandLine ?? "");
      const profiles = args.flatMap((value, index) => value === "--user-data-dir" ? [args[index + 1]] : value.startsWith("--user-data-dir=") ? [value.slice(16)] : []);
      if (profiles.some(value => normalized(value) === normalized(profileRoot))) { ids.add(process.ProcessId); roots.add(process.ProcessId); }
    } catch { uncertain.add(process.ProcessId); }
  }
  let changed = true; while (changed) { changed = false; for (const process of processes) if (!ids.has(process.ProcessId) && ids.has(process.ParentProcessId)) { ids.add(process.ProcessId); changed = true; } }
  const related = processes.filter(process => ids.has(process.ProcessId)), owned = [], externalDescendants = [], unknownDescendants = [];
  for (const process of related) {
    if (known.has(process.ProcessId) || roots.has(process.ProcessId) || (inBrowserTree(process) && !previousTreeIds.includes(process.ProcessId))) owned.push(process);
    else if (uncertain.has(process.ProcessId)) unknownDescendants.push({ ...process, classification: "descendant identity/path/command line incomplete; cannot establish that it is outside browser ownership" });
    else externalDescendants.push({ ...process, leftUntouched: true, classification: "outside the verified browser executable directories, absent from CDP/launcher IDs, and no exact private profile argument; ancestry alone is not browser ownership" });
  }
  return { owned, externalDescendants, unknownDescendants, directories: [...new Set([executable, actualExecutable].map(value => path.win32.dirname(normalized(value))))] };
}
export function checkBrandIdentity(value, name) {
  const plan = brands[name]; assert.ok(plan);
  assert.equal(value.signatureStatus, "Valid", "Browser executable signature is not valid");
  assert.match(value.productName ?? "", plan.product, "Executable product is another browser");
  assert.match(value.signer ?? "", plan.publisher, "Executable signer is another browser vendor");
  assert.match(value.sha256 ?? "", /^[0-9a-f]{64}$/); assert.ok(value.productVersion && value.fileVersion && value.path);
  return value;
}
export function checkAboutEvidence(value, { name, profileRoot }) {
  assert.ok(value && typeof value.text === "string");
  const brandText = value.text.split(/\r?\n/).filter(line => !line.includes("\\") && !line.includes("--user-data-dir") && !line.includes("://")).join("\n");
  assert.match(brandText, brands[name].product, "About page does not identify the actual brand");
  assert.ok([name + ":", "chrome:"].includes(new URL(value.url).protocol), "About evidence is not an internal browser document");
  const candidates = [path.win32.join(profileRoot, "Default"), ...(name === "opera" ? [profileRoot] : [])];
  // Actual Brave 1.97.56 Chinese version page uses this same semantic TD as
  // Chromium's English page. Do not infer a profile from localized body labels
  // or the --user-data-dir text elsewhere on the page.
  assert.ok(Array.isArray(value.profileFields)); assert.equal(value.profileFields.length, 1, "About page has no unique observed profile field");
  const field = value.profileFields[0];
  if (name === "opera") {
    assert.deepEqual(value.profileStructure, { kind: "opera-about-shadow", mainViewCount: 1, aboutOperaCount: 1, incompleteShadowRoots: 0 });
    assert.equal(field.selector, "p.profile-path > span.value"); assert.equal(field.rootPath, "document > main-view::shadow > about-opera::shadow");
    assert.equal(field.tag, "span"); assert.equal(field.id, ""); assert.equal(field.className, "value"); assert.equal(field.parentTag, "p"); assert.equal(field.parentClass, "profile-path"); assert.deepEqual(field.hostVisibility, [true, true]);
  } else { assert.equal(field.selector, "td#profile_path"); assert.equal(field.id, "profile_path"); assert.equal(field.tag, "td"); }
  assert.equal(field.visible, true); assert.ok(path.win32.isAbsolute(field.value));
  const matches = candidates.filter(candidate => normalized(field.value) === normalized(candidate));
  assert.equal(matches.length, 1, "About page must report one exact isolated profile path");
  return { profilePath: matches[0], directory: normalized(matches[0]) === normalized(profileRoot) ? "." : "Default" };
}
export function observerManifestForVendor(manifest, vendorId) {
  assert.match(vendorId, /^[a-p]{32}$/); assert.equal(manifest.web_accessible_resources, undefined, "Only extend this fixture's unexposed observer manifest");
  return { ...manifest, web_accessible_resources: [{ resources: ["integration-observer.html"], extension_ids: [vendorId] }] };
}
export function assertNativeBrowserInventory(entries, expectedIds, { name, identity }) {
  assert.ok(Array.isArray(entries));
  const browserFeatures = entries.filter(value => value.id === "opera-ad-blocker");
  if (browserFeatures.length) {
    // Official Opera calls this exact identifier a zero-byte built-in native
    // feature. Its disabled tuple is from qYeSRb's actual manager API, not a
    // claim about a native default extracted from the executable.
    assert.equal(name, "opera", "Opera browser feature cannot be classified in another brand");
    assert.equal(identity?.passed, true, "Browser feature classification requires verified About/profile identity");
    checkBrandIdentity(identity.actualExecutable, "opera");
    assert.equal(browserFeatures.length, 1, "Duplicate Opera browser feature entries");
    assert.deepEqual(browserFeatures[0], { id: "opera-ad-blocker", location: "FROM_STORE", state: "DISABLED", type: "INTERNAL" }, "Only the observed disabled Opera native feature tuple is recognized");
  }
  return { ...assertFixtureExtensionInventory(entries.filter(value => !browserFeatures.includes(value)), expectedIds), browserFeatures };
}
export function checkDiscoveredProfile(rows, { name, directory, extensionId, endpoint, instanceId, connected }) {
  assert.ok(Array.isArray(rows)); assert.equal(rows.length, 1, "Isolated environment should discover exactly one installed profile");
  const row = rows[0]; assert.equal(row.browser, name); assert.equal(row.directory, directory); assert.equal(row.extensionId, extensionId);
  assert.ok(row.target && row.version && row.source);
  if (connected) { assert.equal(row.connected, true); assert.equal(row.socketPath, endpoint); assert.equal(row.instanceId, instanceId); }
  return row;
}
export function braveDeveloperModePoint(value) {
  assert.equal(value?.tag, "leo-toggle"); assert.equal(value.id, "toggle");
  assert.equal(value.visible, true); assert.equal(value.disabled, false); assert.equal(value.checked, false); assert.equal(value.hostChecked, false);
  for (const key of ["x", "y", "width", "height"]) assert.ok(Number.isFinite(value.rect?.[key]));
  assert.ok(value.rect.width > 0 && value.rect.height > 0);
  const x = value.rect.x + value.rect.width / 2, y = value.rect.y + value.rect.height / 2;
  assert.ok(x >= 0 && x < value.viewport.width && y >= 0 && y < value.viewport.height, "Observed Brave developer-mode control is outside the viewport");
  return { x, y };
}
export function checkTrustedNativeTaskReceipt(value, { nonce, note }) {
  const { inputEvents, inputOverflow, ...receipt } = value;
  assert.deepEqual(receipt, { nonce, note, trusted: true }); assert.equal(inputOverflow, false);
  assert.ok(Array.isArray(inputEvents) && inputEvents.length > 0 && inputEvents.length <= 64);
  for (const event of inputEvents) { assert.deepEqual(Object.keys(event).sort(), ["trusted", "type", "value"]); assert.ok(["input", "change"].includes(event.type)); assert.equal(event.trusted, true); assert.equal(typeof event.value, "string"); }
  const inputs = inputEvents.filter(event => event.type === "input"); assert.ok(inputs.length > 0); assert.equal(inputs.at(-1).value, note);
  return value;
}
export function checkLoadedSentinel(created, loaded, requestedURL) {
  assert.ok(typeof requestedURL === "string" && requestedURL.length > 0);
  assert.ok(Number.isSafeInteger(created?.id) && Number.isSafeInteger(created.windowId));
  assert.equal(loaded?.id, created.id); assert.equal(loaded.windowId, created.windowId);
  assert.equal(loaded.status, "complete"); assert.equal(loaded.url, requestedURL);
  assert.equal(loaded.active, true); assert.equal(loaded.groupId, created.groupId); assert.equal(loaded.pinned, created.pinned);
  return loaded;
}
export function nativeBrowserInstallationCleaned(report) {
  return report.eof?.result?.exitCode === 0 &&
    report.eof?.result?.exactHandle === true && report.browserExit?.result?.exitCode === 0 && report.browserExit?.result?.exactHandle === true &&
    report.launcherExit?.code === 0 && !report.launcherExit.signal && !report.launcherError && report.cleanup?.browserProcessesGone === true && report.cleanup?.nativeProcessesGone === true &&
    report.cleanup?.endpointUnreachable === true && report.cleanup?.descriptorsClean === true && report.cleanup?.fixedRegistrationUnchanged === true &&
    report.cleanup?.registration?.removed === true && report.cleanup?.forced !== true && !report.cleanup?.errors?.length;
}
export function nativeBrowserInstallationPassed(report) {
  return !["native-api-diagnostic", "vivaldi-readiness-diagnostic", "vivaldi-input-diagnostic", "vivaldi-task-readiness-diagnostic", "vivaldi-key-input-diagnostic", "vivaldi-pointer-focus-diagnostic", "vivaldi-dom-focus-diagnostic"].includes(report.mode) && !report.error && report.identity?.passed === true && report.discovery?.passed === true && report.task?.passed === true &&
    (report.ownershipRequested !== true || report.ownership?.passed === true) && report.focus?.passed === true && report.finalInventory?.passed === true && nativeBrowserInstallationCleaned(report);
}

// Fixed production leaves are read only, in both registry views. The returned
// data is hashed, never used to overwrite or restore a user's existing values.
const fixedRegistrationSource = String.raw`$ErrorActionPreference='Stop'
$records=@(); foreach($view in @([Microsoft.Win32.RegistryView]::Registry32,[Microsoft.Win32.RegistryView]::Registry64)) {
  $base=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser,$view)
  try { $key=$base.OpenSubKey('Software\Google\Chrome\NativeMessagingHosts\com.ifuryst.open_browser_use.extension',$false)
    try { $values=@(); if($key){foreach($name in @($key.GetValueNames() | Sort-Object)){$values+=@{name=$name;kind=$key.GetValueKind($name).ToString();value=$key.GetValue($name,$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)}}}
      $records+=@{view=$view.ToString();exists=[bool]$key;values=$values;subkeys=if($key){@($key.GetSubKeyNames() | Sort-Object)}else{@()}}
    } finally {if($key){$key.Dispose()}}
  } finally {$base.Dispose()}
}; ConvertTo-Json -InputObject $records -Depth 8 -Compress`;

async function main() {
  assert.equal(process.platform, "win32", "Native browser installation acceptance currently supports Windows only");
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const nativeDiagnosticsRequested = nativeDiagnosticsEnabled(process.env.OBU_TEST_NATIVE_DIAGNOSTICS);
  const ownershipEnabled = nativeOwnershipEnabled(process.env.OBU_TEST_NATIVE_OWNERSHIP);
  const name = process.env.OBU_TEST_NATIVE_BROWSER;
  assert.ok(Object.hasOwn(brands, name), "Set OBU_TEST_NATIVE_BROWSER to brave, opera or vivaldi");
  const readinessRequested = vivaldiReadinessEnabled(process.env.OBU_TEST_VIVALDI_READINESS, { name, nativeDiagnostics: nativeDiagnosticsRequested });
  const inputRequested = vivaldiInputEnabled(process.env.OBU_TEST_VIVALDI_INPUT, { name, nativeDiagnostics: nativeDiagnosticsRequested, readiness: readinessRequested, ownership: ownershipEnabled });
  const taskReadinessRequested = vivaldiTaskReadinessEnabled(process.env.OBU_TEST_VIVALDI_TASK_READY, { name, input: inputRequested, readiness: readinessRequested, nativeDiagnostics: nativeDiagnosticsRequested, ownership: ownershipEnabled });
  const keyInputEnabled = vivaldiKeyInputEnabled(process.env.OBU_TEST_VIVALDI_KEY_INPUT, { name, input: inputRequested, taskReadiness: taskReadinessRequested, readiness: readinessRequested, nativeDiagnostics: nativeDiagnosticsRequested, ownership: ownershipEnabled });
  const pointerFocusEnabled = vivaldiPointerFocusEnabled(process.env.OBU_TEST_VIVALDI_POINTER_FOCUS, { name, input: inputRequested, taskReadiness: taskReadinessRequested, keyInput: keyInputEnabled, readiness: readinessRequested, nativeDiagnostics: nativeDiagnosticsRequested, ownership: ownershipEnabled });
  const domFocusEnabled = vivaldiDOMFocusEnabled(process.env.OBU_TEST_VIVALDI_DOM_FOCUS, { name, input: inputRequested, taskReadiness: taskReadinessRequested, keyInput: keyInputEnabled, pointerFocus: pointerFocusEnabled, readiness: readinessRequested, nativeDiagnostics: nativeDiagnosticsRequested, ownership: ownershipEnabled });
  const taskReadinessEnabled = taskReadinessRequested || keyInputEnabled || pointerFocusEnabled;
  const inputEnabled = inputRequested || taskReadinessEnabled || domFocusEnabled;
  const inputOperation = keyInputEnabled ? "pressSequentially" : "fill";
  const diagnosticsEnabled = nativeDiagnosticsRequested || inputEnabled, readinessEnabled = readinessRequested || inputEnabled;
  const recordTaskRequests = diagnosticsEnabled || ownershipEnabled || readinessEnabled;
  assert.ok(process.env.OBU_TEST_CHROMIUM_BINARY && process.env.OBU_TEST_HOST_BINARY, "Set OBU_TEST_CHROMIUM_BINARY and OBU_TEST_HOST_BINARY");
  const binary = path.resolve(process.env.OBU_TEST_CHROMIUM_BINARY), sourceHost = path.resolve(process.env.OBU_TEST_HOST_BINARY);
  await Promise.all([fs.access(binary), fs.access(sourceHost)]);
  const outputRoot = path.join(repo, ".tmp/browser-integration"); await fs.mkdir(outputRoot, { recursive: true });
  const runDir = await fs.mkdtemp(path.join(outputRoot, `native-installation-${name}-`));
  const env = { ...process.env, TEMP: path.join(runDir, "temp"), TMP: path.join(runDir, "temp"), LOCALAPPDATA: path.join(runDir, "local"), APPDATA: path.join(runDir, "roaming"), USERPROFILE: path.join(runDir, "home"), HOME: path.join(runDir, "home") };
  const plan = nativeBrowserPlan(name, env), profile = plan.profileRoot;
  for (const directory of [env.TEMP, env.LOCALAPPDATA, env.APPDATA, env.USERPROFILE, profile]) await fs.mkdir(directory, { recursive: true });
  const report = { name, runDir, profileRoot: profile, startedAt: Date.now(), passed: false, mode: domFocusEnabled ? "vivaldi-dom-focus-diagnostic" : pointerFocusEnabled ? "vivaldi-pointer-focus-diagnostic" : keyInputEnabled ? "vivaldi-key-input-diagnostic" : taskReadinessEnabled ? "vivaldi-task-readiness-diagnostic" : inputEnabled ? "vivaldi-input-diagnostic" : readinessEnabled ? "vivaldi-readiness-diagnostic" : diagnosticsEnabled ? "native-api-diagnostic" : "acceptance",
    scope: "Actual signed Windows brand; native manifest export plus unique Google HKCU fixture registration; real connectNative launcher, catalogue/profile selectors and one JS SDK background task. Production fixed-leaf installer, other OS, browser restart/update and complete brand parity are not claimed.",
    helperPolicy: "Windows PowerShell 5.1 helpers use their own PSHOME/Modules only, with UTF-8 stdout/stderr; environment change is local to each helper child",
    focus: { allowedActivations: [], allowedFocus: [] }, cli: [], inventories: [], cleanup: { errors: [] } };
  if (diagnosticsEnabled) report.diagnostics = { enabled: true, snapshots: [], errors: [], boundary: "Opt-in staged-worker native API and selected passive-event observations only. Original task/focus/receipt failures remain failures; diagnostic completion never implies acceptance. Pending command outcomes and truncated payload values remain unknown; no retry, activation, input replacement, or private production-map reads." };
  if (readinessEnabled) report.readinessDiagnostic = { enabled: true, timeoutMs: 25000, boundary: "Harness-only pre-first-target-connection native tabs.get and original target readiness gate for vendor-created manager/observer. One absolute budget per open covers creation, identity, metadata, connection and evaluation. No activation or action replay. " + (inputEnabled ? `Explicit input mode also stages the existing native API prelude and passive fixture events; single ${inputOperation}/click selected before execution.` : "No staged API prelude or production task change. Diagnostic completion requires both gates, task reached and strict cleanup; task/focus failures remain recorded and passed is always false.") };
  if (inputEnabled) report.inputDiagnostic = { enabled: true, snapshots: [], errors: [], fixtureResponses: [], fixtureOverflow: false, fixtureDropped: 0, boundary: `Explicit input diagnostic combines the unchanged readiness gate and native API observer with passive fixture event capture. Single preselected ${inputOperation}/click and original trusted POST assertions remain. The final public ledger read is attempted once after receipt or during failure teardown; no input replay. DOM focus is not actual widget focus, and native ACK alone does not prove delivery or a root cause. This mode always has passed:false.` };
  if (keyInputEnabled) { report.keyInputDiagnostic = { enabled: true, operation: inputOperation, locator: "getByLabel('Delivery note')", maximumDOMRecords: 1024, fixtureDifference: "Only KEY_INPUT adds passive keydown/keypress/keyup and an explicit 1024-record cap. Shared serialized observer source changed; older INPUT fixture HTML is not byte-identical to the prior baseline, although its original event set and 256 cap remain. Non-diagnostic fixture bytes are unchanged." }; report.inputDiagnostic.keyInput = report.keyInputDiagnostic; }
  if (pointerFocusEnabled) { report.pointerFocusDiagnostic = { enabled: true, operation: "pointerFocusClick", locator: "getByLabel('Delivery note')", maximumDOMRecords: 256, selectedActionDifference: "Exactly one public input locator.click before the unchanged single fill and Submit click. No activation, explicit focus, input replacement or fallback. Actual native mouse sequences are recorded independently of the public click count.", fixtureDifference: "Only POINTER_FOCUS adds passive pointerdown/pointerup/mousedown/mouseup/click metadata. Shared serialized diagnostic observer source changed, so previous diagnostic HTML bytes differ; old event sets/caps and non-diagnostic fixture bytes remain unchanged." }; report.inputDiagnostic.pointerFocus = report.pointerFocusDiagnostic; }
  if (domFocusEnabled) { report.domFocusDiagnostic = { enabled: true, operation: "domFocus", before: {}, selectedActionDifference: "One public CDP DOM.getDocument/querySelector/describeNode/focus chain on original #note after goto, before the unchanged single fill and Submit. One 5s total diagnostic budget; no fallback, activation, extra mouse/key action or task-readiness harness gate. DOM.focus can cause normal focus/scroll; native ACK is not input delivery.", fixtureDifference: "Uses unchanged INPUT fixture HTML/event set. The extra pre-focus observation is separate from the original three input snapshots." }; report.inputDiagnostic.domFocus = report.domFocusDiagnostic; }
  if (taskReadinessEnabled) report.taskReadinessDiagnostic = { enabled: true, ready: false, timeoutMs: 5000, maximumSamples: 80, scopeBoundary: "Extra task initial-commit diagnostic stage; not inherited from newTab and not an extension of the unchanged original goto deadline" };
  if (ownershipEnabled) { report.ownershipRequested = true; report.ownership = { enabled: true, passed: false }; }
  const save = (file, value) => fs.writeFile(path.join(runDir, file), JSON.stringify(value, null, 2));
  const checkpoint = async () => {
    if (inputEnabled) try { await Promise.all([save("input-diagnostic.json", report.inputDiagnostic), ...inputFixtureResponses.map(value => fs.writeFile(path.join(runDir, value.file), value.body))]); }
    catch (error) { report.inputDiagnostic.persistenceFailures = (report.inputDiagnostic.persistenceFailures ?? 0) + 1; report.inputDiagnostic.lastPersistenceError = error.stack ?? String(error); report.inputDiagnostic.domTraceComplete = false; if (report.diagnosticCompleted === true) report.diagnosticCompleted = false; }
    if (taskReadinessEnabled) try { await save("task-readiness.json", report.taskReadinessDiagnostic); }
    catch (error) { report.taskReadinessDiagnostic.persistenceFailures = (report.taskReadinessDiagnostic.persistenceFailures ?? 0) + 1; report.taskReadinessDiagnostic.lastPersistenceError = error.stack ?? String(error); if (report.diagnosticCompleted === true) report.diagnosticCompleted = false; }
    await Promise.all([save("results.json", report), ...(recordTaskRequests ? [save("task-requests.json", taskRequests)] : []), ...(ownershipEnabled ? [save("ownership.json", report.ownership)] : [])]);
  };
  console.log("HARNESS", JSON.stringify({ runDir, name, profileRoot: profile, mode: report.mode }));
  const helpers = new Set(), connections = new Set(), browserLogs = [], posts = [], inputFixtureResponses = [];
  const taskRequests = { maximumRecords: 128, overflow: false, dropped: 0, requests: [] };
  let diagnosticInitial, diagnosticFinal;
  let inputTaskTab;
  let child, childExit, control, manager, observer, worker, companion, extensionId, endpoint, nativeExecutable, browserPid, debugPort, owner, fixedBefore, registryAttempted = false;
  const host = path.join(runDir, "native-host.exe"), extension = path.join(runDir, "extension"), sdk = path.join(runDir, "js-sdk");
  const endpointDirectory = path.join(env.TEMP, "open-browser-use"), endpointFile = path.join(endpointDirectory, "active.json"), registryScript = path.join(runDir, "registry.ps1");
  const nativeName = `com.openbrowseruse.lifecycle.n${randomBytes(12).toString("hex")}`, ledger = new FocusLedger();
  async function captureNativeDiagnostics(label) {
    if (!diagnosticsEnabled) return;
    const record = { label, requestedAt: Date.now() }; report.diagnostics.snapshots.push(record);
    try {
      assert.ok(worker, "No same-worker CDP connection available for diagnostic snapshot");
      // Read the observer in the worker, never via an SDK action on the task tab.
      const snapshot = await worker.evaluate("globalThis.__obuNativeAPIDiagnostics?.snapshot()");
      assert.equal(snapshot?.version, 1, "Native diagnostic controller missing or invalid");
      const bytes = JSON.stringify(snapshot, null, 2), file = `native-api-diagnostics-${label}.json`;
      await fs.writeFile(path.join(runDir, file), bytes);
      Object.assign(record, { completedAt: Date.now(), file, bytes: Buffer.byteLength(bytes), sha256: digest(bytes), bootId: snapshot.bootId, nextSequence: snapshot.nextSequence, overflow: snapshot.overflow, dropped: snapshot.dropped, pending: snapshot.pending });
      if (label === "native-connected") diagnosticInitial = snapshot;
      if (label === "before-browser-close") diagnosticFinal = snapshot;
    } catch (error) { record.error = error.stack ?? String(error); report.diagnostics.errors.push({ label, error: record.error }); }
    try { await checkpoint(); }
    catch (error) { record.persistenceError = error.stack ?? String(error); report.diagnostics.errors.push({ label: `${label}-persistence`, error: record.persistenceError }); }
  }
  async function captureFinalInput() {
    if (!inputEnabled || !inputTaskTab || !report.task?.steps.some(step => step.operation === inputOperation)) return;
    await captureInputLedgerOnce(report.inputDiagnostic, { read: () => inputTaskTab.evaluate("globalThis.__obuInputEventDiagnostic?.snapshot()"), persist: checkpoint });
  }
  async function until(read, label, timeout = 25000) {
    const end = Date.now() + timeout; let last;
    do { try { const value = await read(); if (value) return value; } catch (error) { last = error; } await delay(75); } while (Date.now() < end);
    throw new Error(`Timed out ${label}${last ? `: ${last.message}` : ""}`);
  }
  async function bounded(promise, timeout, label) { let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeout); })]); } finally { clearTimeout(timer); } }
  function subprocess(command, args, { timeoutMs = 30000, allowFailure = false, ...options } = {}) {
    return new Promise((resolve, reject) => {
      const task = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], ...options }); helpers.add(task);
      task.stdout.setEncoding("utf8"); task.stderr.setEncoding("utf8");
      let stdout = "", stderr = "", timeoutError, killTimer;
      task.stdout.on("data", value => stdout += value); task.stderr.on("data", value => stderr += value);
      const timer = setTimeout(() => { timeoutError = new Error(`${path.basename(command)} timed out`); task.kill(); killTimer = setTimeout(() => reject(new Error("Timed-out helper did not close; registration cleanup must be withheld")), 10000); }, timeoutMs);
      task.once("error", error => { clearTimeout(timer); clearTimeout(killTimer); if (!task.pid) helpers.delete(task); reject(error); });
      task.once("close", (code, signal) => { clearTimeout(timer); clearTimeout(killTimer); helpers.delete(task); const result = { code, signal, stdout, stderr }; timeoutError ? reject(timeoutError) : code === 0 || allowFailure ? resolve(result) : reject(Object.assign(new Error(`${path.basename(command)} exited ${code}: ${stderr}`), { result })); });
    });
  }
  const powershell = async (source, options = {}) => (await subprocess("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", windowsPowerShellCommand(source)], { env, ...options })).stdout;
  // Pass script path and arguments as data, never concatenate Windows paths
  // into shell source. The same bootstrap runs before imported .ps1 helpers.
  const script = (file, args = [], options = {}) => powershell("$taskArguments=ConvertFrom-Json -InputObject $env:OBU_TEST_PS_ARGUMENTS; & $env:OBU_TEST_PS_SCRIPT @taskArguments", { ...options, env: { ...env, ...options.env, OBU_TEST_PS_SCRIPT: file, OBU_TEST_PS_ARGUMENTS: JSON.stringify(args) } });
  async function hashes(directory) { const result = {}; async function walk(relative = "") { for (const entry of await fs.readdir(path.join(directory, relative), { withFileTypes: true })) { const next = path.join(relative, entry.name); if (entry.isDirectory()) await walk(next); else if (entry.isFile()) result[next.replaceAll(path.sep, "/")] = digest(await fs.readFile(path.join(directory, next))); } } await walk(); return result; }
  async function processTable() { return JSON.parse(await powershell("ConvertTo-Json -InputObject @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine,@{n='CreationDate';e={$_.CreationDate.ToUniversalTime().ToString('o')}}) -Compress")); }
  async function executableIdentity(file) {
    const value = JSON.parse(await powershell("$v=(Get-Item -LiteralPath $env:OBU_TEST_IDENTITY_BINARY).VersionInfo; $s=Get-AuthenticodeSignature -LiteralPath $env:OBU_TEST_IDENTITY_BINARY; @{path=$env:OBU_TEST_IDENTITY_BINARY;productName=$v.ProductName;productVersion=$v.ProductVersion;fileVersion=$v.FileVersion;companyName=$v.CompanyName;signatureStatus=$s.Status.ToString();signer=$s.SignerCertificate.Subject;thumbprint=$s.SignerCertificate.Thumbprint;powerShell=@{version=$PSVersionTable.PSVersion.ToString();home=$PSHOME;securityModule=(Get-Module Microsoft.PowerShell.Security).Path;encoding=[Console]::OutputEncoding.WebName}} | ConvertTo-Json -Depth 4 -Compress", { env: { ...env, OBU_TEST_IDENTITY_BINARY: file } }));
    value.sha256 = digest(await fs.readFile(file)); return checkBrandIdentity(value, name);
  }
  async function fixedRegistration() { const value = JSON.parse(await powershell(fixedRegistrationSource)); return { sha256: digest(canonicalJSON(value)), views: value.map(({ view, exists }) => ({ view, exists })) }; }
  async function cdp(url, { handshakeTimeoutMs = 10000, connectionRecord = {}, budget } = {}) {
    if (budget) handshakeTimeoutMs = Math.min(handshakeTimeoutMs, budget.remaining());
    Object.assign(connectionRecord, { requestedUrl: url, requestedAt: Date.now(), handshakeTimeoutMs, state: "connecting", attemptedConnections: 1 });
    await checkpoint();
    if (budget) handshakeTimeoutMs = Math.min(handshakeTimeoutMs, budget.remaining());
    const socket = new WebSocket(url), pending = new Map(); let serial = 0;
    const fail = error => { for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); } pending.clear(); };
    socket.on("error", fail); socket.on("close", () => fail(new Error("Diagnostic CDP closed")));
    socket.on("message", bytes => { const value = JSON.parse(bytes), entry = pending.get(value.id); if (!entry) return; pending.delete(value.id); clearTimeout(entry.timer); value.error ? entry.reject(new Error(JSON.stringify(value.error))) : entry.resolve(value.result); });
    const call = (method, params = {}, options = {}) => new Promise((resolve, reject) => { const timeout = options.budget ? Math.min(20000, options.budget.remaining()) : 20000; if (socket.readyState !== WebSocket.OPEN) return reject(new Error("Diagnostic CDP closed")); const id = ++serial, timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, timeout); pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params })); });
    const value = { call, state: () => ["connecting", "open", "closing", "closed"][socket.readyState], close: () => { fail(new Error("Fixture closing diagnostic CDP")); if (socket.readyState === WebSocket.CONNECTING) socket.terminate(); else socket.close(); }, evaluate: async (expression, options) => { const answer = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, options); if (answer.exceptionDetails) throw new Error(JSON.stringify(answer.exceptionDetails)); return answer.result.value; } };
    connections.add(value); // Track before handshake, including timed-out sockets.
    await awaitNativeDiagnosticSocket(socket, { record: connectionRecord, persist: checkpoint, timeoutMs: handshakeTimeoutMs }); return value;
  }
  const targets = async budget => {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`, { signal: AbortSignal.timeout(budget ? Math.min(5000, budget.remaining()) : 5000) });
    assert.equal(response.ok, true, `Diagnostic target list HTTP ${response.status}`);
    const values = await response.json(); assert.ok(Array.isArray(values)); return values;
  };
  async function openDiagnostic(url, createTarget, purpose) {
    const record = {}; report.diagnosticPages ??= []; report.diagnosticPages.push(record);
    if (readinessEnabled && createTarget) return openVivaldiReadinessPage({ url, purpose, createTarget, targets, failureTargets: () => targets(), connect: cdp, record, persist: async () => { await save("diagnostic-pages.json", report.diagnosticPages); await checkpoint(); } });
    return openNativeDiagnosticPage({ url, createTarget, control, targets, connect: cdp, record, persist: async () => { await save("diagnostic-pages.json", report.diagnosticPages); await checkpoint(); } });
  }
  async function createVivaldiDiagnostic(url, purpose, budget) {
    const read = (operation, label) => budget ? budget.run(operation, label) : operation();
    const evaluate = expression => read(() => ui.evaluate(expression, budget ? { budget } : undefined), "vendor UI evaluation");
    const record = { purpose, requestedUrl: url, requestedAt: Date.now() }; report.vendorUICreations ??= []; report.vendorUICreations.push(record);
    if (purpose === "installation-manager") report.installationUI.vendorCreation = record;
    await checkpoint();
    const before = await read(() => targets(budget), "vendor target list"); record.targetsBefore = before.slice(0, 80).map(diagnosticTarget);
    const prior = report.vendorUICreations.find(value => value !== record && value.vendorIdentity)?.vendorTarget;
    const matches = before.filter(target => { try { const url = new URL(target.url); return target.type === "app" && (prior ? target.id === prior.id && target.url === prior.url : target.title === "Vivaldi") && url.protocol === "chrome-extension:" && url.pathname === "/window.html"; } catch { return false; } });
    assert.equal(matches.length, 1, "Require one actually observed Vivaldi vendor window app");
    record.vendorTarget = diagnosticTarget(matches[0]); record.connection = {}; await checkpoint();
    const ui = await read(() => cdp(matches[0].webSocketDebuggerUrl, { connectionRecord: record.connection, ...(budget ? { budget } : {}) }), "vendor UI connection");
    record.vendorIdentity = await evaluate("(async()=>({url:location.href,title:document.title,runtimeId:chrome.runtime.id,manifestName:chrome.runtime.getManifest().name,hasTabsCreate:typeof chrome.tabs?.create==='function',window:await chrome.windows.getCurrent()}))()");
    await checkpoint(); const identity = record.vendorIdentity;
    assert.equal(identity.url, matches[0].url); assert.equal(identity.runtimeId, new URL(identity.url).hostname); assert.match(identity.manifestName, /vivaldi/i); assert.equal(identity.hasTabsCreate, true); assert.ok(Number.isInteger(identity.window?.id)); assert.equal(identity.window.type, "normal");
    record.arguments = { url, windowId: identity.window.id, active: false }; record.createRequestedAt = Date.now(); await checkpoint();
    // The shipped bundle's openURL path uses tabs.create({url,windowId,
    // active:!inBackground}). Do not call private webpack exports or retry.
    record.reply = await evaluate(`chrome.tabs.create(${JSON.stringify(record.arguments)}).then(({id,windowId,active,url,pendingUrl,status})=>({id,windowId,active,url,pendingUrl,status}))`);
    record.createCompletedAt = Date.now(); await checkpoint();
    assert.ok(Number.isInteger(record.reply.id)); assert.equal(record.reply.windowId, identity.window.id); assert.equal(record.reply.active, false); assert.ok([record.reply.url, record.reply.pendingUrl].includes(url));
    const oldIds = new Set(before.map(target => target.id));
    const targetDeadline = budget?.deadline ?? Date.now() + 25000; let target;
    do {
      const current = await read(() => targets(budget), "vendor-created target association"); record.targetsAfter = current.slice(0, 80).map(diagnosticTarget);
      const candidates = current.filter(target => !oldIds.has(target.id) && target.type === "page" && target.url === url);
      assert.ok(candidates.length <= 1, "Ambiguous new Vivaldi manager targets"); target = candidates[0]; if (target) break;
      assert.ok(Date.now() < targetDeadline, "No unique vendor-created extension manager target before deadline"); await read(() => delay(budget ? Math.min(75, budget.remaining()) : 75), "vendor target interval");
    } while (true);
    record.target = diagnosticTarget(target); record.association = "Unique new exact-URL page target after one native tabs.create; CDP TargetInfo has no numeric tabId"; await checkpoint();
    if (budget) { budget.remaining(); return { targetId: target.id, tabId: record.reply.id, windowId: record.reply.windowId, target, readTab: (readBudget = budget) => readBudget.run(() => ui.evaluate(`chrome.tabs.get(${record.reply.id}).then(({id,windowId,active,url,pendingUrl,status,pinned,groupId,discarded,frozen})=>({id,windowId,active,url,pendingUrl,status,pinned,groupId,discarded,frozen}))`, { budget: readBudget }), "native tabs.get via existing vendor UI") }; }
    return target.id;
  }
  async function inventory(label, expected = [extensionId, companion.extensionId]) {
    const record = { label, at: Date.now() }; report.inventories.push(record);
    record.entries = await manager.evaluate("chrome.developerPrivate.getExtensionsInfo({includeDisabled:true,includeTerminated:true}).then(values=>values.map(({id,location,state,type})=>({id,location,state,type})))");
    Object.assign(record, assertNativeBrowserInventory(record.entries, expected, { name, identity: report.identity })); record.passed = true; await checkpoint(); return record;
  }
  async function settingsDiagnostic(label) {
    const value = await manager.evaluate(`(async()=>{const roots=[document],controls=[],shadows=[];let scanned=0;while(roots.length&&scanned<5000){for(const n of roots.shift().querySelectorAll('*')){if(++scanned>5000)break;if(n.shadowRoot){roots.push(n.shadowRoot);if(shadows.length<20)shadows.push({tag:n.localName,id:n.id,html:n.shadowRoot.innerHTML.slice(0,10000)})}if(controls.length<200&&(n.matches('input,button,[role],[aria-label]')||n.localName.includes('toggle')))controls.push({tag:n.localName,id:n.id,label:n.getAttribute('aria-label'),role:n.getAttribute('role'),text:(n.innerText??n.textContent??'').slice(0,200),checked:n.checked,disabled:n.disabled,visible:n.checkVisibility(),html:n.outerHTML.slice(0,1200)})}}return{url:location.href,title:document.title,text:document.body?.innerText.slice(0,15000),html:document.documentElement.outerHTML.slice(0,20000),controls,shadows,scanned,configuration:await chrome.developerPrivate.getProfileConfiguration()}})()`);
    await save(`settings-${label}.json`, value); return value;
  }
  async function focus(label) {
    const snapshot = await readFocusEvidence(ledger, report.focus, () => observer.evaluate(focusSnapshotExpression));
    const windows = await observer.evaluate("chrome.windows.getAll({populate:true}).then(values=>values.map(({id,type,state,focused,tabs})=>({id,type,state,focused,tabs:tabs.map(({id,active,url,windowId,groupId,pinned})=>({id,active,url,windowId,groupId,pinned}))})))");
    const value = { label, at: Date.now(), snapshot, windows }; report.focus.checkpoints ??= []; report.focus.checkpoints.push(value); await checkpoint();
    ledger.assertAllowed(snapshot, [], []);
    const window = windows.find(value => value.id === report.sentinel.windowId); assert.ok(window); const sentinel = window.tabs.find(tab => tab.id === report.sentinel.id); assert.equal(sentinel?.active, true); assert.equal(sentinel.url, report.sentinelRequest.url);
    return value;
  }
  async function cli(args, allowFailure = false) {
    const record = { args, requestedAt: Date.now() }; report.cli.push(record);
    try { Object.assign(record, await subprocess(host, args, { env, allowFailure })); record.completedAt = Date.now(); await checkpoint(); return record; }
    catch (error) { record.error = error.message; if (error.result) Object.assign(record, error.result); await checkpoint(); throw error; }
  }
  async function descriptors() {
    const values = []; for (const file of await fs.readdir(endpointDirectory).catch(error => error.code === "ENOENT" ? [] : Promise.reject(error))) if (file.endsWith(".json")) { try { values.push({ file, record: JSON.parse(await fs.readFile(path.join(endpointDirectory, file), "utf8")) }); } catch (error) { if (error.code !== "ENOENT") throw error; } } return values;
  }
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost"); response.setHeader("Cache-Control", "no-store");
    if (url.pathname === "/submit" && request.method === "POST") {
      const buffers = []; let size = 0; for await (const chunk of request) { size += chunk.length; if (size > 4096) { response.writeHead(413); response.end(); return; } buffers.push(chunk); }
      const bytes = Buffer.concat(buffers); posts.push({ at: Date.now(), url: request.url, body: bytes.toString("utf8"), sha256: digest(bytes) }); await save("server.json", posts);
      response.setHeader("Content-Type", "application/json"); response.end(bytes); return;
    }
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    if (url.pathname !== "/task") { response.end('<!doctype html><title>OBU foreground sentinel</title><h1>Foreground sentinel</h1>'); return; }
    const nonce = url.searchParams.get("nonce"); if (!/^[a-f0-9]{24}$/.test(nonce ?? "")) { response.writeHead(400); response.end(); return; }
    if (recordTaskRequests) {
      if (taskRequests.requests.length < taskRequests.maximumRecords) taskRequests.requests.push({ sequence: taskRequests.requests.length, at: Date.now(), method: request.method, url: request.url, nonce });
      else { taskRequests.overflow = true; taskRequests.dropped++; }
    }
    const rgb = [...Buffer.from(nonce.slice(0, 6), "hex")];
    const html = `<!doctype html><meta charset="utf-8"><title>Native browser task ${nonce}</title><style>body{font:20px system-ui;margin:70px 30px}#marker{position:fixed;left:8px;top:8px;width:40px;height:40px;background:rgb(${rgb.join(",")})}input,button{font:inherit;padding:12px}</style><div id="marker"></div><h1>Native browser task</h1><p id="nonce">${nonce}</p><label>Delivery note<input id="note"></label><button id="submit">Submit note</button><pre id="receipt"></pre><script>${inputEnabled ? inputFixtureSource(nonce, { keyInput: keyInputEnabled, pointerFocus: pointerFocusEnabled }) : ""}globalThis.submissions=[];const inputEvents=[];globalThis.__nativeTaskInputEvents=inputEvents;let inputOverflow=false;for(const type of ['input','change'])document.querySelector('#note').addEventListener(type,event=>{if(inputEvents.length>=64){inputOverflow=true;return}inputEvents.push({type,trusted:event.isTrusted,value:event.target.value})});document.querySelector('#submit').onclick=async event=>{const value={nonce:${JSON.stringify(nonce)},note:document.querySelector('#note').value,trusted:event.isTrusted,inputEvents:inputEvents.map(value=>({...value})),inputOverflow};submissions.push(value);const result=await fetch('/submit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)}).then(r=>r.json());document.querySelector('#receipt').textContent=JSON.stringify(result)};</script>`;
    if (inputEnabled) {
      if (inputFixtureResponses.length < 4) {
        const file = `input-fixture-response-${inputFixtureResponses.length + 1}.html`;
        inputFixtureResponses.push({ file, body: html });
        report.inputDiagnostic.fixtureResponses.push({ file, at: Date.now(), nonce, url: request.url, bytes: Buffer.byteLength(html), sha256: digest(html) });
      } else { report.inputDiagnostic.fixtureOverflow = true; report.inputDiagnostic.fixtureDropped++; }
    }
    response.end(html);
  });
  try {
    fixedBefore = await fixedRegistration(); report.fixedRegistrationBefore = fixedBefore;
    await fs.copyFile(sourceHost, host); await fs.cp(path.join(repo, "packages/open-browser-use-js/dist"), sdk, { recursive: true });
    report.sourceIdentity = { gitHead: (await subprocess("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim(), dirty: !!(await subprocess("git", ["status", "--porcelain"], { cwd: repo })).stdout.trim(), host: digest(await fs.readFile(host)), harness: digest(await fs.readFile(fileURLToPath(import.meta.url))), jsSDK: await hashes(sdk), dependencies: {} };
    for (const file of ["browser-startup.mjs", "focus-ledger.mjs", "extension-reload-support.mjs", "native-lifecycle-support.mjs", "background-parallel-workflow.mjs", "native-api-diagnostics.mjs", "native-ownership-workflow.mjs", "vivaldi-readiness-diagnostic.mjs", "vivaldi-input-diagnostic.mjs", "vivaldi-task-readiness-diagnostic.mjs", "vivaldi-key-input-diagnostic.mjs", "vivaldi-pointer-focus-diagnostic.mjs", "vivaldi-dom-focus-diagnostic.mjs", "../build-chrome-extension.mjs"]) report.sourceIdentity.dependencies[file] = digest(await fs.readFile(path.join(repo, "scripts/browser-integration", file)));
    report.identity = { suppliedExecutable: await executableIdentity(binary) }; await checkpoint();
    await buildChromeExtension(extension); report.productionExtensionHashes = await hashes(extension);
    const backgroundFile = path.join(extension, "background.js"), background = await fs.readFile(backgroundFile, "utf8"), nativeConstant = 'const NATIVE_HOST_NAME = "com.ifuryst.open_browser_use.extension";';
    assert.equal(background.split(nativeConstant).length, 2); assert.equal(background.split("chrome.runtime.connectNative(this.hostName)").length, 2);
    const prelude = diagnosticsEnabled ? nativeDiagnosticPrelude({ metadataReads: inputEnabled }) : "";
    await fs.writeFile(backgroundFile, prelude + background.replace(nativeConstant, `const NATIVE_HOST_NAME = ${JSON.stringify(nativeName)};`));
    if (diagnosticsEnabled) report.diagnostics.staging = { file: "background.js", preludeBytes: Buffer.byteLength(prelude), preludeSHA256: digest(prelude), originalSHA256: digest(background), helperSHA256: report.sourceIdentity.dependencies["native-api-diagnostics.mjs"], reason: `Explicit ${domFocusEnabled ? "OBU_TEST_VIVALDI_DOM_FOCUS" : pointerFocusEnabled ? "OBU_TEST_VIVALDI_POINTER_FOCUS" : keyInputEnabled ? "OBU_TEST_VIVALDI_KEY_INPUT" : taskReadinessEnabled ? "OBU_TEST_VIVALDI_TASK_READY" : inputEnabled ? "OBU_TEST_VIVALDI_INPUT" : "OBU_TEST_NATIVE_DIAGNOSTICS"}=1; transparent single-invocation API trace before the staged worker body; connectNative and action implementations unchanged` };
    const manifestFile = path.join(extension, "manifest.json"), manifest = JSON.parse(await fs.readFile(manifestFile, "utf8"));
    manifest.key ??= (await fs.readFile(path.join(repo, "cmd/open-browser-use/main.go"), "utf8")).match(/const betaExtensionPublicKey = "([^"]+)"/)?.[1]; assert.ok(manifest.key);
    extensionId = digest(Buffer.from(manifest.key, "base64")).slice(0, 32).replace(/[0-9a-f]/g, value => String.fromCharCode(97 + parseInt(value, 16))); await fs.writeFile(manifestFile, JSON.stringify(manifest, null, 2));
    report.extensionId = extensionId; report.stagedExtensionHashes = await hashes(extension); report.stagingExceptions = ["random native host-name constant only; real connectNative untouched", "public unpacked extension key"];
    if (diagnosticsEnabled) report.stagingExceptions.push("explicit diagnostic prelude in staged background.js only; original API receiver/arguments/Promise preserved; never acceptance");
    assert.deepEqual(Object.keys(report.productionExtensionHashes).filter(file => report.productionExtensionHashes[file] !== report.stagedExtensionHashes[file]).sort(), ["background.js", "manifest.json"]);
    companion = await stageReloadObserver({ directory: path.join(runDir, "observer-extension") }); report.observer = companion;
    const manifestPath = path.join(runDir, "native-host.json");
    await cli(["install-manifest", "--browser", name, "--extension-id", extensionId, "--path", host, "--output", manifestPath]);
    const native = JSON.parse(await fs.readFile(manifestPath, "utf8")); assert.equal(native.name, "com.ifuryst.open_browser_use.extension"); assert.deepEqual(native.allowed_origins, [`chrome-extension://${extensionId}/`]);
    nativeExecutable = native.path; const relative = path.relative(runDir, path.resolve(nativeExecutable)); assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative)); assert.equal(digest(await fs.readFile(nativeExecutable)), report.sourceIdentity.host);
    native.name = nativeName; await fs.writeFile(manifestPath, JSON.stringify(native, null, 2)); report.nativeManifest = native;
    await fs.writeFile(registryScript, nativeRegistrationSource); await fs.writeFile(path.join(runDir, "watch-native.ps1"), nativeWatchSource);
    await save("registration.json", { Name: nativeName, Browser: "chrome", Manifest: manifestPath, Owner: randomBytes(16).toString("hex") }); registryAttempted = true;
    report.registration = JSON.parse(await script(registryScript, ["create"])); report.registrationScope = "Unique temporary host under HKCU Google/Chrome, regardless actual brand; no fixed-name production registration or install UI is changed";
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); const fixtureURL = `http://127.0.0.1:${server.address().port}`;
    report.startup = browserStartupOptions([`--user-data-dir=${profile}`, "--remote-debugging-port=0", "--enable-unsafe-extension-debugging", "--no-first-run", "--no-default-browser-check", "--disable-sync", "--disable-background-networking", "--site-per-process", "--no-sandbox", "--enable-logging=stderr", "about:blank"], resolveFieldTrialConfig(process.env.OBU_TEST_FIELD_TRIAL_CONFIG));
    report.preLaunchBrowserTreePids = (await processTable()).filter(value => withinExecutableDirectory(value.ExecutablePath, binary)).map(value => value.ProcessId);
    child = spawn(binary, report.startup.args, { env, windowsHide: report.startup.windowsHide, stdio: ["ignore", "ignore", "pipe"] }); report.launcherPid = child.pid;
    child.stderr.setEncoding("utf8"); child.stderr.on("data", value => browserLogs.push(value)); childExit = new Promise(resolve => { child.once("exit", (code, signal) => { report.launcherExit = { code, signal, at: Date.now() }; resolve(report.launcherExit); }); child.once("error", error => { report.launcherError = error.message; resolve({ error: error.message }); }); });
    const lines = await until(async () => (await fs.readFile(path.join(profile, "DevToolsActivePort"), "utf8")).trim().split("\n"), "private browser debug endpoint", 45000); debugPort = Number(lines[0]); assert.ok(debugPort > 0);
    report.browserConnection = {}; control = await cdp(`ws://127.0.0.1:${debugPort}${lines[1]}`, { handshakeTimeoutMs: 45000, connectionRecord: report.browserConnection }); report.browserVersion = await control.call("Browser.getVersion");
    report.initialProcesses = await control.call("SystemInfo.getProcessInfo"); const roots = report.initialProcesses.processInfo.filter(value => value.type === "browser"); assert.equal(roots.length, 1); browserPid = roots[0].id;
    report.identity.process = checkBrowserProcess((await processTable()).find(value => value.ProcessId === browserPid), { profileRoot: profile, browserPid });
    report.identity.actualExecutable = await executableIdentity(report.identity.process.ExecutablePath);
    report.identity.aboutRequest = { url: plan.about, route: "direct CDP Target.createTarget engine navigation, not the browser address-field alias rewriter" };
    const about = await openDiagnostic(plan.about); report.identity.aboutTarget = about.targetId;
    report.identity.about = await until(async () => { const value = await about.page.evaluate(`(${aboutDocumentEvidence.toString()})(${JSON.stringify(name)})`); await save("browser-about.json", value); return { ...value, ...checkAboutEvidence(value, plan) }; }, "real brand and exact profile on About page");
    report.identity.passed = true; await checkpoint();
    report.installationUI = { managerBackground: true, phase: "before sentinel and independent focus ledger", method: name === "vivaldi" ? "Observed vendor UI app chrome.tabs.create with active:false; official openURL creation path" : "Background Target.createTarget", taskAndObserverBackground: true };
    await checkpoint();
    const settings = await openDiagnostic(plan.manager, name === "vivaldi" ? budget => createVivaldiDiagnostic(plan.manager, "installation-manager", budget) : undefined, "installation-manager"); manager = settings.page; report.settingsTarget = settings.targetId;
    const diagnostic = await settingsDiagnostic("before-install"); await inventory("before-install", []);
    assert.equal(diagnostic.configuration.canLoadUnpacked, true); assert.equal(diagnostic.configuration.isDeveloperModeControlledByPolicy, false);
    // Use Chromium's actual rendered control only after recording its DOM.
    // A brand with a different manager fails with diagnostics, never a guessed click.
    const toggle = "document.querySelector('extensions-manager')?.shadowRoot?.querySelector('extensions-toolbar')?.shadowRoot?.querySelector('#devMode')";
    report.developerModeBefore = await manager.evaluate(`(()=>{const n=${toggle};return n?{tag:n.localName,id:n.id,checked:n.checked,disabled:n.disabled,visible:n.checkVisibility()}:null})()`);
    assert.ok(report.developerModeBefore, "Browser has a different extension-manager UI; inspect captured DOM before adding an adapter");
    assert.equal(report.developerModeBefore.disabled, false); assert.equal(report.developerModeBefore.visible, true);
    assert.equal(report.developerModeBefore.checked, diagnostic.configuration.inDeveloperMode, "Native and rendered developer-mode state disagree before setup");
    if (!report.developerModeBefore.checked) {
      if (name === "brave") {
        // Brave's observed cr-toggle wraps leo-toggle; calling the outer host's
        // click() did not toggle it in IEcYYK. Send exactly one browser-native
        // click to the visible inner control's observed center. No OS mouse.
        report.developerModeTarget = await manager.evaluate(`(()=>{const host=${toggle},node=host?.shadowRoot?.querySelector('leo-toggle#toggle');if(!node)return null;const rect=node.getBoundingClientRect();return{tag:node.localName,id:node.id,checked:node.checked,hostChecked:host.checked,disabled:node.disabled,visible:node.checkVisibility(),rect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height},viewport:{width:innerWidth,height:innerHeight},html:node.outerHTML.slice(0,2000)}})()`);
        const point = braveDeveloperModePoint(report.developerModeTarget);
        report.developerModeInteraction = { method: "CDP Input at observed Brave inner leo-toggle center; one press/release, no OS cursor", point, requestedAt: Date.now() };
        await manager.call("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", buttons: 1, clickCount: 1 });
        await manager.call("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", buttons: 0, clickCount: 1 });
        report.developerModeInteraction.completedAt = Date.now();
      } else await manager.evaluate(`(${toggle}).click()`);
    }
    report.developerModeAfter = await until(async () => { const value = await manager.evaluate(`(async()=>{const host=${toggle},inner=host.shadowRoot?.querySelector('leo-toggle#toggle');return{configuration:await chrome.developerPrivate.getProfileConfiguration(),checked:host.checked,inner:inner?{checked:inner.checked,visible:inner.checkVisibility(),disabled:inner.disabled}:null}})()`); return value.configuration.inDeveloperMode === true && value.checked === true && (name !== "brave" || (value.inner?.checked === true && value.inner.visible === true && value.inner.disabled === false)) && value; }, "native and rendered developer-mode agreement");
    if (name === "vivaldi") {
      const vendorId = report.installationUI.vendorCreation.vendorIdentity.runtimeId, file = path.join(companion.directory, "manifest.json"), original = await fs.readFile(file);
      const manifest = observerManifestForVendor(JSON.parse(original), vendorId), staged = JSON.stringify(manifest, null, 2);
      await fs.writeFile(file, staged); companion.sha256.manifest = digest(staged);
      report.observerNavigationAccess = { writtenAt: Date.now(), scope: "temporary independent observer only", vendorId, resources: manifest.web_accessible_resources, originalManifestSHA256: digest(original), manifestSHA256: companion.sha256.manifest, permissionsUnchanged: manifest.permissions, reason: "Allow cross-extension navigation only from the actually observed Vivaldi component; observer retains its original independent script and no product/Port adapter" }; await checkpoint();
    }
    report.installed = []; for (const [directory, expected] of [[companion.directory, companion.extensionId], [extension, extensionId]]) { const requestedAt = Date.now(), loaded = await control.call("Extensions.loadUnpacked", { path: directory }); report.installed.push({ directory, loaded, requestedAt, completedAt: Date.now() }); assert.equal(loaded.id, expected); }
    const workerTarget = await until(async () => (await targets()).find(value => value.type === "service_worker" && value.url === `chrome-extension://${extensionId}/background.js`), "actual extension worker"); worker = await cdp(workerTarget.webSocketDebuggerUrl); report.workerTarget = workerTarget.id;
    const { connectOpenBrowserUse } = await import(pathToFileURL(path.join(sdk, "index.js")));
    endpoint = await until(async () => { const value = JSON.parse(await fs.readFile(endpointFile, "utf8")); const identity = assertNativeProcessIdentity(value, await processTable(), { executable: nativeExecutable, browserPid }); const status = await worker.evaluate("chrome.storage.local.get('OPEN_BROWSER_USE_NATIVE_HOST_STATUS').then(v=>v.OPEN_BROWSER_USE_NATIVE_HOST_STATUS)"); return status?.state === "connected" && status.hostName === nativeName && { ...value, identity, status }; }, "real browser-launched native host", 45000);
    report.endpoint = endpoint; owner = await connectOpenBrowserUse({ socketPath: endpoint.socketPath, sessionId: `native-installation-${name}-${randomBytes(8).toString("hex")}`, timeoutMs: 15000 });
    report.info = await owner.client.getInfo(); assert.equal(report.info.metadata.extensionId, extensionId); assert.ok(report.info.metadata.extensionInstanceId);
    if (diagnosticsEnabled) {
      // A service-worker target can be advertised before its module body runs.
      // The existing native handshake proves that body has now run; take one
      // snapshot without retrying, resetting the trace, or adding a readiness poll.
      report.diagnostics.initialBarrier = { at: Date.now(), evidence: "Existing connected native-host status and successful public getInfo with exact extension identity", workerTarget: report.workerTarget, nativePid: endpoint.pid, extensionInstanceId: report.info.metadata.extensionInstanceId };
      await captureNativeDiagnostics("native-connected");
    }
    await inventory("after-install");
    report.discovery = {};
    const expected = { name, directory: report.identity.about.directory, extensionId, endpoint: endpoint.socketPath, instanceId: report.info.metadata.extensionInstanceId };
    report.discovery.installed = await until(async () => { const result = await cli(["profiles", "--json"]); return checkDiscoveredProfile(JSON.parse(result.stdout), expected); }, "public installed profile discovery");
    report.discovery.connected = await until(async () => { const result = await cli(["profiles", "--connected", "--json", "--socket-dir", endpointDirectory]); return checkDiscoveredProfile(JSON.parse(result.stdout), { ...expected, connected: true }); }, "public connected profile discovery");
    const selectorArgs = ["call", "--method", "getInfo", "--browser", name, "--profile", expected.directory, "--socket-dir", endpointDirectory, "--timeout", "5s"];
    const selected = await cli(selectorArgs); report.discovery.selectedInfo = JSON.parse(selected.stdout); assert.equal(report.discovery.selectedInfo.result.metadata.extensionInstanceId, expected.instanceId);
    report.discovery.rejections = [];
    for (const [wrongName, wrongProfile] of [[name === "brave" ? "vivaldi" : "brave", expected.directory], [name, "OBU-NOT-A-PROFILE"]]) {
      const result = await cli(["call", "--method", "getInfo", "--browser", wrongName, "--profile", wrongProfile, "--socket-dir", endpointDirectory, "--timeout", "2s"], true);
      assert.notEqual(result.code, 0); assert.match(result.stderr, /no running Open Browser Use host matched/i); report.discovery.rejections.push(result);
    }
    report.discovery.passed = true; await checkpoint();
    report.sentinelRequest = { url: fixtureURL + "/sentinel", requestedAt: Date.now() };
    report.sentinelCreateReply = await worker.evaluate(`chrome.tabs.create({url:${JSON.stringify(report.sentinelRequest.url)},active:true})`);
    const loadedSentinel = await until(async () => {
      const value = await worker.evaluate(`chrome.tabs.get(${report.sentinelCreateReply.id})`); report.sentinelLastObserved = value;
      return value.status === "complete" && value.url === report.sentinelRequest.url && value;
    }, "foreground sentinel exact requested URL loaded");
    report.sentinel = checkLoadedSentinel(report.sentinelCreateReply, loadedSentinel, report.sentinelRequest.url); report.sentinelRequest.loadedAt = Date.now();
    const observing = await openDiagnostic(companion.url, name === "vivaldi" ? budget => createVivaldiDiagnostic(companion.url, "focus-observer", budget) : undefined, "focus-observer"); observer = observing.page; report.observerTarget = observing.targetId; await until(() => observer.evaluate("globalThis.__integrationFocusLedger?.snapshot().ready"), "independent focus observer ready");
    await focus("before-task");
    report.task = { nonce: randomBytes(12).toString("hex"), steps: [] }; const task = report.task;
    async function step(operation, run) { const record = { operation, requestedAt: Date.now() }; task.steps.push(record); try { const value = await run(); record.completedAt = Date.now(); await checkpoint(); return value; } catch (error) { record.error = error.message; await checkpoint(); throw error; } }
    await step("beginTurn", () => owner.client.beginTurn()); task.scope = { session_id: owner.client.sessionId, turn_id: owner.client.turnId, control_epoch: owner.client.controlEpoch };
    const tab = await step("newTab", () => owner.newTab()); task.tabId = tab.id; if (inputEnabled) inputTaskTab = tab;
    if (taskReadinessEnabled) {
      Object.assign(report.taskReadinessDiagnostic, { scope: { ...task.scope }, newTabStep: { ...task.steps.find(step => step.operation === "newTab") }, newTabResult: { tabId: tab.id }, observerTarget: report.observerTarget, workerTarget: report.workerTarget, originalGoto: { url: `${fixtureURL}/task?nonce=${task.nonce}`, options: "Unchanged tab.goto(url) call; no timeout override" } });
      await waitForVivaldiTaskCommit({ tabId: tab.id, windowId: report.sentinel.windowId, record: report.taskReadinessDiagnostic,
        readTab: budget => observer.evaluate(`chrome.tabs.get(${tab.id}).then(({id,windowId,active,url,pendingUrl,status,width,height,groupId,pinned,discarded,frozen})=>({id,windowId,active,url,pendingUrl,status,width,height,groupId,pinned,discarded,frozen}))`, { budget }),
        readTargets: budget => worker.evaluate("chrome.debugger.getTargets()", { budget }),
        persist: async () => { await checkpoint(); assert.ok(!report.taskReadinessDiagnostic.persistenceFailures, "Task readiness evidence could not be saved"); },
      });
    }
    await step("goto", () => tab.goto(`${fixtureURL}/task?nonce=${task.nonce}`));
    const note = `native-${name}-${task.nonce}`;
    task.inputObservations = [];
    async function observeInput(phase, { diagnosticSnapshot = true, record = {} } = {}) {
      Object.assign(record, { phase, requestedAt: Date.now() }); task.inputObservations.push(record);
      record.document = await step(`read input ${phase}`, () => tab.evaluate("({url:location.href,readyState:document.readyState,value:document.querySelector('#note')?.value,selectionStart:document.querySelector('#note')?.selectionStart,selectionEnd:document.querySelector('#note')?.selectionEnd,activeElement:{tag:document.activeElement?.localName,id:document.activeElement?.id},hasFocus:document.hasFocus(),visibility:document.visibilityState,inputEvents:globalThis.__nativeTaskInputEvents" + (inputEnabled ? ",inputDiagnostic:globalThis.__obuInputEventDiagnostic?.snapshot()" : "") + "})"));
      if (inputEnabled && diagnosticSnapshot) report.inputDiagnostic.snapshots.push({ phase, requestedAt: record.requestedAt, completedAt: Date.now(), snapshot: record.document.inputDiagnostic });
      record.completedAt = Date.now(); await checkpoint();
    }
    if (keyInputEnabled) { assert.match(note, /^[\x20-\x7e]{39}$/); report.keyInputDiagnostic.expectedNote = note; }
    if (domFocusEnabled) {
      report.domFocusDiagnostic.expectedNote = note;
      await observeInput("before-dom-focus", { diagnosticSnapshot: false, record: report.domFocusDiagnostic.before });
      await step("domFocus", () => runDOMFocusDiagnostic({ tabId: tab.id, url: `${fixtureURL}/task?nonce=${task.nonce}`, record: report.domFocusDiagnostic,
        call: (method, params, options) => owner.cdp.call(tab.id, method, params, options),
      }));
    }
    if (pointerFocusEnabled) {
      report.pointerFocusDiagnostic.expectedNote = note;
      await observeInput("before-pointer-click");
      await step("pointerFocusClick", () => tab.getByLabel("Delivery note").click());
      await observeInput("after-pointer-click");
    }
    await observeInput(keyInputEnabled ? "before-key-input" : "before-fill");
    if (keyInputEnabled) await step("pressSequentially", () => tab.getByLabel("Delivery note").pressSequentially(note));
    else await step("fill", () => tab.getByLabel("Delivery note").fill(note));
    await observeInput(keyInputEnabled ? "after-key-input" : "after-fill");
    await step("click", () => tab.getByRole("button", { name: "Submit note", exact: true }).click());
    await step("receipt visible", () => tab.locator("#receipt").filter({ hasText: task.nonce }).waitFor({ state: "visible" }));
    task.receipt = JSON.parse(await step("read receipt", () => tab.locator("#receipt").innerText()));
    if (inputEnabled) await captureFinalInput();
    task.fixtureEvidence = "Unique POST contains actual trusted click and bounded DOM input/change events; no synthetic trusted flag or production hook";
    checkTrustedNativeTaskReceipt(task.receipt, { nonce: task.nonce, note });
    assert.equal(posts.length, 1); assert.deepEqual(JSON.parse(posts[0].body), task.receipt); task.server = structuredClone(posts);
    task.viewport = await step("read viewport", () => tab.evaluate("({width:innerWidth,height:innerHeight,dpr:devicePixelRatio})"));
    const screenshot = await step("screenshot", () => tab.screenshot()); const bytes = Buffer.from(screenshot.base64, "base64"); await fs.writeFile(path.join(runDir, "background-task.png"), bytes); task.screenshot = { file: "background-task.png", bytes: bytes.length, sha256: digest(bytes) }; await checkpoint();
    assert.equal(screenshot.mimeType, "image/png"); const png = decodeParallelPNG(bytes); task.screenshot.width = png.width; task.screenshot.height = png.height;
    assert.equal(png.width, Math.round(task.viewport.width * task.viewport.dpr)); assert.equal(png.height, Math.round(task.viewport.height * task.viewport.dpr));
    task.screenshot.sample = png.pixel(Math.round(24 * task.viewport.dpr), Math.round(24 * task.viewport.dpr)); assert.deepEqual(task.screenshot.sample, [...Buffer.from(task.nonce.slice(0, 6), "hex")]);
    await focus("after-background-action"); task.nativeTab = await observer.evaluate(`chrome.tabs.get(${tab.id}).then(({id,active,url,windowId,groupId})=>({id,active,url,windowId,groupId}))`); assert.equal(task.nativeTab.active, false);
    task.finalizeAttemptedAt = Date.now(); task.finalize = await step("finalizeTabs", () => owner.client.finalizeTabs([]));
    task.removal = await until(async () => { const tabs = await observer.evaluate("chrome.tabs.query({}).then(values=>values.map(({id,active,url,windowId,groupId})=>({id,active,url,windowId,groupId})))"); const targets = await worker.evaluate("chrome.debugger.getTargets()"); return !tabs.some(value => value.id === tab.id) && !targets.some(value => value.tabId === tab.id && value.attached) && { at: Date.now(), tabs, debuggerTargets: targets }; }, "finalized task tab and attachment removed");
    await focus("after-finalize"); task.passed = true; await checkpoint();
    if (ownershipEnabled) await runNativeOwnershipWorkflow({
      detail: report.ownership, fixtureURL, posts, requests: taskRequests, until, focus, checkpoint, checkReceipt: checkTrustedNativeTaskReceipt,
      connect: label => connectOpenBrowserUse({ socketPath: endpoint.socketPath, sessionId: `native-ownership-${label}-${randomBytes(8).toString("hex")}`, timeoutMs: 15000 }),
      readNative: async () => ({ at: Date.now(),
        tabs: await observer.evaluate("chrome.tabs.query({}).then(values=>values.map(({id,active,url,windowId,groupId,pinned})=>({id,active,url,windowId,groupId,pinned})))"),
        debuggerTargets: await worker.evaluate("chrome.debugger.getTargets()"),
      }),
    });
  } catch (error) { report.error = error.stack; console.error(error); if (manager) try { await settingsDiagnostic("failure"); } catch (failure) { report.settingsDiagnosticError = failure.message; } }
  finally {
    if (inputEnabled) await captureFinalInput();
    if (diagnosticsEnabled) await captureNativeDiagnostics("task-terminal");
    if (manager && report.installed?.length === 2) try { report.finalInventory = await inventory("before-browser-exit"); } catch (error) { report.cleanup.errors.push({ stage: "inventory", error: error.message }); }
    if (observer) try { await focus("before-browser-exit"); report.focus.passed = true; } catch (error) { report.focus.passed = false; report.focus.error = error.stack; }
    owner?.close();
    let watcher, browserWatcher;
    // Keep a native process handle for the actual CDP browser PID as well as
    // the stdio host; a launcher exiting successfully is not browser EOF proof.
    if (browserPid && report.identity?.process) try {
      const process = checkBrowserProcess((await processTable()).find(value => value.ProcessId === browserPid), { profileRoot: profile, browserPid });
      assert.equal(process.CreationDate, report.identity.process.CreationDate); assert.equal(normalized(process.ExecutablePath), normalized(report.identity.process.ExecutablePath));
      // Do not await the completed observation until after Browser.close.
      const file = path.join(runDir, "browser-exit-identity.json"), ready = path.join(runDir, "browser-exit-ready.json"); await fs.writeFile(file, JSON.stringify(process));
      browserWatcher = script(path.join(runDir, "watch-native.ps1"), [file, ready], { timeoutMs: 50000 }).then(value => ({ result: JSON.parse(value) }), error => ({ error: error.message }));
      report.browserExitReady = await until(async () => JSON.parse(await fs.readFile(ready, "utf8")), "actual browser exit observer ready", 10000); assert.equal(report.browserExitReady.pid, browserPid);
    } catch (error) { report.cleanup.errors.push({ stage: "browser exit observer", error: error.message }); }
    if (endpoint && browserPid) try {
      const identity = assertNativeProcessIdentity(endpoint, await processTable(), { executable: nativeExecutable, browserPid });
      const file = path.join(runDir, "eof-identity.json"), ready = path.join(runDir, "eof-ready.json"); await fs.writeFile(file, JSON.stringify(identity.process));
      watcher = script(path.join(runDir, "watch-native.ps1"), [file, ready], { timeoutMs: 50000 }).then(value => ({ result: JSON.parse(value) }), error => ({ error: error.message }));
      report.eofReady = await until(async () => JSON.parse(await fs.readFile(ready, "utf8")), "native EOF observer ready", 10000); assert.equal(report.eofReady.pid, endpoint.pid);
    } catch (error) { report.cleanup.errors.push({ stage: "EOF observer", error: error.message }); }
    if (control) {
      try { report.processesBeforeClose = await control.call("SystemInfo.getProcessInfo"); } catch (error) { report.cleanup.errors.push({ stage: "process inventory", error: error.message }); }
      if (diagnosticsEnabled) await captureNativeDiagnostics("before-browser-close");
      try { report.browserCloseAt = Date.now(); await control.call("Browser.close"); } catch (error) { report.browserCloseReplyError = error.message; }
    }
    if (child) {
      try { await bounded(childExit, 15000, "private browser launcher exit"); }
      catch (error) { report.cleanup.forced = true; report.cleanup.errors.push({ stage: "launcher exit", error: error.message }); child.kill(); try { await bounded(childExit, 10000, "terminated launcher exit"); } catch (failure) { report.cleanup.errors.push({ stage: "forced launcher exit", error: failure.message }); } }
      const known = new Set([child.pid, browserPid, ...(report.initialProcesses?.processInfo ?? []).map(value => value.id), ...(report.processesBeforeClose?.processInfo ?? []).map(value => value.id)].filter(Boolean));
      const externalSeen = new Map();
      try { report.cleanup.browserProcessEvidence = await until(async () => {
        const classification = classifyPrivateBrowserProcesses(await processTable(), { profileRoot: profile, knownIds: [...known], executable: binary, actualExecutable: report.identity?.process?.ExecutablePath ?? binary, previousTreeIds: report.preLaunchBrowserTreePids ?? [] });
        const remaining = [...classification.owned, ...classification.unknownDescendants];
        for (const process of classification.owned) known.add(process.ProcessId);
        for (const process of classification.externalDescendants) externalSeen.set(`${process.ProcessId}:${process.CreationDate}`, { ...process, observedAt: Date.now() });
        report.cleanup.externalBrowserDescendants = [...externalSeen.values()];
        report.cleanup.unknownBrowserDescendants = classification.unknownDescendants;
        report.cleanup.browserExecutableDirectories = classification.directories;
        report.cleanup.lastRemainingBrowserProcesses = remaining;
        return !remaining.length && { at: Date.now(), checkedPids: [...known], remaining, externalDescendants: [...externalSeen.values()], directories: classification.directories };
      }, "all private browser processes gone (including pre-CDP handoffs)", 15000); report.cleanup.browserProcessesGone = true; }
      catch (error) { report.cleanup.errors.push({ stage: "browser processes", error: error.message }); }
    }
    for (const value of connections) value.close();
    if (watcher) report.eof = await watcher;
    if (browserWatcher) report.browserExit = await browserWatcher;
    try {
      report.cleanup.nativeProcessEvidence = await until(async () => { const remaining = (await processTable()).filter(value => value.ExecutablePath && normalized(value.ExecutablePath) === normalized(nativeExecutable ?? host)); return !remaining.length && { at: Date.now(), remaining }; }, "all private native hosts gone", 10000); report.cleanup.nativeProcessesGone = true;
      if (endpoint) {
        report.cleanup.endpointEvidence = await until(() => bounded(new Promise((resolve, reject) => { const socket = net.createConnection(endpoint.socketPath); socket.once("connect", () => { socket.destroy(); resolve(false); }); socket.once("error", error => { socket.destroy(); ["ENOENT", "ECONNREFUSED"].includes(error.code) ? resolve({ code: error.code, at: Date.now() }) : reject(error); }); }), 2000, "old pipe probe"), "old native endpoint unavailable", 5000); report.cleanup.endpointUnreachable = true;
        report.cleanup.descriptors = await until(async () => { const records = await descriptors(); report.cleanup.lastDescriptors = records; return records.length === 0 && records; }, "all descriptors in private TEMP removed after native EOF", 10000); report.cleanup.descriptorsClean = true;
      }
    } catch (error) { report.cleanup.errors.push({ stage: "native host cleanup", error: error.message }); }
    if (helpers.size) { for (const task of helpers) try { task.kill(); } catch {} try { await until(() => !helpers.size, "all helper handles drained", 10000); } catch (error) { report.cleanup.errors.push({ stage: "helper cleanup", error: error.message }); } }
    if (registryAttempted && !helpers.size && report.cleanup.nativeProcessesGone && (!child || report.cleanup.browserProcessesGone)) {
      try { report.cleanup.registration = JSON.parse(await script(registryScript, ["cleanup"])); } catch (error) { report.cleanup.errors.push({ stage: "registry cleanup", error: error.message }); }
    } else if (registryAttempted) report.cleanup.errors.push({ stage: "registry cleanup", error: "Withheld while a browser, native host or fixture helper may remain live" });
    if (fixedBefore) try { report.fixedRegistrationAfter = await fixedRegistration(); assert.deepEqual(report.fixedRegistrationAfter, fixedBefore); report.cleanup.fixedRegistrationUnchanged = true; } catch (error) { report.cleanup.errors.push({ stage: "fixed registration changed", error: error.message }); }
    server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve));
    await fs.writeFile(path.join(runDir, "browser.log"), browserLogs.join("")); await save("server.json", posts);
    if (recordTaskRequests) await save("task-requests.json", taskRequests);
    if (diagnosticsEnabled) {
      report.diagnostics.taskOutcome = { taskPassed: report.task?.passed === true, focusPassed: report.focus?.passed === true, error: report.error ?? null, focusError: report.focus.error ?? null };
      report.diagnostics.traceComplete = !report.diagnostics.errors.length && !taskRequests.overflow && nativeDiagnosticTraceComplete(diagnosticInitial, diagnosticFinal);
      report.diagnostics.cleanupComplete = nativeBrowserInstallationCleaned(report);
    }
    let result = readinessEnabled ? vivaldiReadinessResult({ pages: report.diagnosticPages?.filter(page => page.mode === "vivaldi-readiness-diagnostic"), taskReached: !!report.task?.steps?.length, cleanupComplete: nativeBrowserInstallationCleaned(report), taskRequestsOverflow: taskRequests.overflow }) : nativeDiagnosticResult({ enabled: diagnosticsEnabled, acceptancePassed: nativeBrowserInstallationPassed(report), taskReached: !!report.task?.steps?.length, traceComplete: report.diagnostics?.traceComplete, cleanupComplete: report.diagnostics?.cleanupComplete });
    if (readinessEnabled) Object.assign(report.readinessDiagnostic, { observationsComplete: result.observationsComplete, cleanupComplete: nativeBrowserInstallationCleaned(report), taskRequestsOverflow: taskRequests.overflow, taskOutcome: { taskPassed: report.task?.passed === true, focusPassed: report.focus?.passed === true, error: report.error ?? null, focusError: report.focus.error ?? null } });
    if (inputEnabled) {
      const detail = report.inputDiagnostic, nonce = report.task?.nonce;
      detail.nativeTraceComplete = !report.diagnostics.errors.length && inputNativeTraceComplete(diagnosticInitial, diagnosticFinal, report.task?.tabId);
      detail.commands = inputCommandEvidence(diagnosticFinal, { tabId: report.task?.tabId, note: `native-${name}-${nonce}`, steps: report.task?.steps });
      detail.commandEvidenceBoundary = "Indices bind to the original native trace. Task tab/text comparisons are observations, not collection-completeness conditions. Timestamp windows alone are not exact IPC scope proof; raw task scope, tab creation/attachment and context events remain necessary. Long Runtime function bodies can be truncated in the raw trace; omitted values are unknown.";
      detail.domTraceComplete = !detail.errors.length && !detail.persistenceFailures && inputDOMTraceComplete(detail.snapshots, nonce, { keyInput: keyInputEnabled, pointerFocus: pointerFocusEnabled });
      detail.httpComplete = !taskRequests.overflow && taskRequests.requests.length === 1 && taskRequests.requests[0].method === "GET" && taskRequests.requests[0].nonce === nonce && !detail.fixtureOverflow && detail.fixtureResponses.length === 1 && detail.fixtureResponses[0].nonce === nonce && posts.length === 1 && (() => { try { return JSON.parse(posts[0].body).nonce === nonce && digest(posts[0].body) === posts[0].sha256; } catch { return false; } })();
      detail.readinessComplete = report.readinessDiagnostic.observationsComplete;
      detail.cleanupComplete = nativeBrowserInstallationCleaned(report);
      detail.taskOutcome = report.readinessDiagnostic.taskOutcome;
      result = vivaldiInputResult({ ...detail, steps: report.task?.steps, inputOperation });
    }
    if (taskReadinessEnabled) {
      const inputResult = result;
      result = taskReadinessDiagnosticResult({ gate: report.taskReadinessDiagnostic, inputResult });
      report.taskReadinessDiagnostic.gateComplete = result.gateComplete;
      if (keyInputEnabled) {
        Object.assign(report.keyInputDiagnostic, keyCommandEvidence(diagnosticFinal, { tabId: report.task?.tabId, note: report.keyInputDiagnostic.expectedNote, steps: report.task?.steps }));
        result = keyInputDiagnosticResult({ inputResult, gateResult: result, evidence: report.keyInputDiagnostic });
        report.keyInputDiagnostic.collectionComplete = result.collectionComplete;
        report.keyInputDiagnostic.experimentObserved = result.experimentObserved;
      }
      if (pointerFocusEnabled) {
        Object.assign(report.pointerFocusDiagnostic, pointerCommandEvidence(diagnosticFinal, { tabId: report.task?.tabId, steps: report.task?.steps, snapshots: report.inputDiagnostic.snapshots }));
        result = pointerFocusDiagnosticResult({ inputResult, gateResult: result, evidence: report.pointerFocusDiagnostic });
        report.pointerFocusDiagnostic.collectionComplete = result.collectionComplete;
        report.pointerFocusDiagnostic.experimentObserved = result.experimentObserved;
      }
    }
    if (domFocusEnabled) {
      Object.assign(report.domFocusDiagnostic, domFocusCommandEvidence(diagnosticFinal, { tabId: report.task?.tabId, steps: report.task?.steps, detail: report.domFocusDiagnostic, inputSnapshots: report.inputDiagnostic.snapshots }));
      result = domFocusDiagnosticResult({ inputResult: result, evidence: report.domFocusDiagnostic });
      report.domFocusDiagnostic.collectionComplete = result.collectionComplete;
      report.domFocusDiagnostic.experimentObserved = result.experimentObserved;
    }
    report.completedAt = Date.now(); report.passed = result.passed;
    if (diagnosticsEnabled || readinessEnabled) report.diagnosticCompleted = result.diagnosticCompleted;
    await checkpoint(); console.log("RESULT", JSON.stringify({ file: path.join(runDir, "results.json"), mode: report.mode, passed: report.passed, diagnosticCompleted: report.diagnosticCompleted })); process.exitCode = (inputEnabled && report.inputDiagnostic.persistenceFailures) || (taskReadinessEnabled && report.taskReadinessDiagnostic.persistenceFailures) ? 1 : result.exitCode;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
