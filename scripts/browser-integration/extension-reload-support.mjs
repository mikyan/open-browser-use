import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { FocusLedger, focusObserverHTML, focusObserverSource } from "./focus-ledger.mjs";

const digest = value => createHash("sha256").update(value).digest("hex");

// A separate unpacked extension, not a document of the extension being reloaded.
// Its static page has no background worker, content scripts, host permissions,
// debugger access or product-storage access. It only records native focus events.
export async function stageReloadObserver({ directory }) {
  assert.equal(typeof directory, "string");
  assert.ok(path.isAbsolute(directory), "Observer staging directory must be absolute");
  // Refuse to replace a previous observer or any existing directory.
  await fs.mkdir(directory);
  const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "der" } });
  const extensionId = digest(publicKey).slice(0, 32).replace(/[0-9a-f]/g, value => String.fromCharCode(97 + parseInt(value, 16)));
  const manifest = JSON.stringify({ manifest_version: 3, name: "OBU isolated lifecycle observer", version: "1.0.0", key: publicKey.toString("base64"), permissions: ["tabs"] }, null, 2);
  const files = { "manifest.json": manifest, "integration-observer.html": focusObserverHTML, "integration-observer.js": focusObserverSource };
  for (const [name, source] of Object.entries(files)) await fs.writeFile(path.join(directory, name), source, { flag: "wx" });
  return { directory, extensionId, url: `chrome-extension://${extensionId}/integration-observer.html`,
    sha256: { manifest: digest(manifest), html: digest(focusObserverHTML), script: digest(focusObserverSource) } };
}

// Prepend only to the isolated staged OBU worker. These listeners observe native
// events; they neither invoke lifecycle events nor write product/session storage.
// Unpacked reload's onInstalled(update) is not evidence of a version upgrade.
export function installReloadLifecycleRecorder(chrome, target, maxEvents = 128) {
  const bootId = crypto.randomUUID(), startedAt = Date.now(), events = [];
  const extensionId = chrome.runtime.id, manifestVersion = chrome.runtime.getManifest().version;
  let overflow = false;
  const append = (event, details) => {
    if (events.length >= maxEvents) { overflow = true; return; }
    events.push({ sequence: events.length, at: Date.now(), event,
      ...(details && { reason: details.reason, ...(details.previousVersion !== undefined && { previousVersion: details.previousVersion }) }) });
  };
  chrome.runtime.onInstalled.addListener(details => append("onInstalled", details));
  chrome.runtime.onStartup.addListener(() => append("onStartup"));
  target.__integrationReloadLifecycle = { snapshot: () => ({ version: 1, bootId, extensionId, manifestVersion, startedAt, overflow, events: events.map(event => ({ ...event })) }) };
}

export const reloadLifecycleRecorderSource = `(${installReloadLifecycleRecorder.toString()})(chrome, globalThis);\n`;
export const reloadLifecycleSnapshotExpression = "globalThis.__integrationReloadLifecycle?.snapshot()";

function nonempty(value, label) {
  assert.ok(typeof value === "string" && value.length > 0, `${label} is unavailable`);
}

function checkLifecycle(value) {
  assert.equal(value?.version, 1, "Lifecycle recorder unavailable");
  for (const name of ["bootId", "extensionId", "manifestVersion"]) nonempty(value[name], `Lifecycle ${name}`);
  assert.ok(Number.isFinite(value.startedAt), "Lifecycle start time unavailable");
  assert.equal(value.overflow, false, "Lifecycle event history overflowed");
  assert.ok(Array.isArray(value.events), "Lifecycle native events unavailable");
  for (const [index, event] of value.events.entries()) {
    assert.equal(event.sequence, index, "Lifecycle native events were truncated or reordered");
    assert.ok(Number.isFinite(event.at) && event.at >= value.startedAt, "Invalid lifecycle event time");
    assert.ok(event.event === "onStartup" || event.event === "onInstalled", "Unexpected lifecycle event type");
    if (event.event === "onInstalled") {
      assert.ok(["install", "update", "chrome_update", "shared_module_update"].includes(event.reason), "Invalid native install reason");
      if (event.previousVersion !== undefined) nonempty(event.previousVersion, "Previous manifest version");
    }
  }
}

// This validates evidence; it never causes or retries a reload. The runner sends
// chrome.runtime.reload() once, then captures browser-level Target events and
// rebinds the exact replacement worker. A Runtime.evaluate reply is insufficient.
export function assertExtensionReload(before, after, { targetEvents, reloadInvocations, reloadRequestedAt, portConnections, focusBefore, focusAfter }) {
  assert.equal(reloadInvocations, 1, "Extension reload must be invoked exactly once");
  assert.ok(Number.isFinite(reloadRequestedAt), "Reload invocation time unavailable");
  for (const state of [before, after]) {
    for (const name of ["browserId", "extensionId", "extensionInstanceId", "incarnation", "workerTarget", "backgroundContextId", "bootId", "observerTarget", "observerExtensionId", "hostEndpoint"]) nonempty(state?.[name], `Reload ${name}`);
    assert.notEqual(state.observerExtensionId, state.extensionId, "Reload observer belongs to the extension being reloaded");
    for (const name of ["pid", "hostPid"]) assert.ok(Number.isSafeInteger(state[name]) && state[name] > 0, `Reload ${name} unavailable`);
    assert.ok(Number.isSafeInteger(state.portIndex) && state.portIndex >= 0, "Native Port index unavailable");
    checkLifecycle(state.lifecycle);
    assert.equal(state.lifecycle.bootId, state.bootId, "Lifecycle boot identity mismatch");
    assert.equal(state.lifecycle.extensionId, state.extensionId, "Lifecycle extension identity mismatch");
  }
  for (const name of ["pid", "browserId", "extensionId", "extensionInstanceId", "observerTarget", "observerExtensionId", "hostPid", "hostEndpoint"]) {
    assert.equal(after[name], before[name], `Extension reload changed ${name}`);
  }
  for (const name of ["workerTarget", "backgroundContextId", "bootId", "incarnation"]) {
    assert.notEqual(after[name], before[name], `Extension reload did not replace ${name}`);
  }
  assert.equal(after.lifecycle.manifestVersion, before.lifecycle.manifestVersion, "This fixture tests same-version reload, not an update distribution");
  assert.ok(after.lifecycle.startedAt >= reloadRequestedAt, "Replacement worker predates the reload invocation");
  assert.ok(after.lifecycle.events.some(event => event.event === "onInstalled" && event.reason === "update"), "No native unpacked-reload update event observed");
  // A late profile onStartup is recorded, not interpreted as input-release proof.
  assert.deepEqual(after.liveWorkerTargets, [after.workerTarget], "Old or ambiguous OBU worker remains live");
  assert.ok(Array.isArray(targetEvents), "Browser Target event history unavailable");
  assert.ok(targetEvents.some(event => event.method === "Target.targetDestroyed" && event.params?.targetId === before.workerTarget), "No native destruction event for the old worker");
  assert.ok(targetEvents.some(event => event.method === "Target.targetCreated" && event.params?.targetInfo?.targetId === after.workerTarget && event.params.targetInfo.type === "service_worker" && event.params.targetInfo.url === `chrome-extension://${after.extensionId}/background.js`), "No native creation event for the replacement worker");
  assert.ok(after.portIndex > before.portIndex && Array.isArray(portConnections), "Native Port did not change");
  const oldPort = portConnections[before.portIndex], newPort = portConnections[after.portIndex];
  for (const port of [oldPort, newPort]) {
    assert.equal(port?.extensionId, before.extensionId, "Native Port extension identity mismatch");
    assert.equal(port.hello, true, "Native Port hello was not observed");
    assert.ok(Number.isFinite(port.connectedAt), "Native Port connection time unavailable");
  }
  assert.ok(oldPort.connectedAt <= reloadRequestedAt && Number.isFinite(oldPort.closedAt) && oldPort.closedAt >= reloadRequestedAt, "Original native Port close was not observed during reload");
  assert.ok(newPort.connectedAt >= reloadRequestedAt && newPort.closedAt === undefined, "Replacement native Port is not live after reload");
  const ledger = new FocusLedger();
  ledger.accept(focusBefore); ledger.accept(focusAfter);
  assert.deepEqual(focusAfter.events, focusBefore.events, "Extension reload changed native activation/focus");
  return { classification: "same-version unpacked chrome.runtime.reload with a continuous independent extension observer and native Port adapter; not a browser restart, host EOF or update delivery", nativeWorkerDestroyed: true, nativeWorkerCreated: true, observerContinuous: true };
}
