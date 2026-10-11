import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createPublicKey } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { assertExtensionReload, installReloadLifecycleRecorder, reloadLifecycleRecorderSource, reloadLifecycleSnapshotExpression, stageReloadObserver } from "./extension-reload-support.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const digest = value => createHash("sha256").update(value).digest("hex");

test("companion staging creates a distinct minimal extension and refuses an existing directory", async () => {
  const parent = path.join(repo, ".tmp"); await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, "reload-observer-unit-"));
  try {
    const directory = path.join(root, "observer"), staged = await stageReloadObserver({ directory });
    assert.equal(staged.directory, directory);
    assert.deepEqual((await fs.readdir(directory)).sort(), ["integration-observer.html", "integration-observer.js", "manifest.json"]);
    const text = await fs.readFile(path.join(directory, "manifest.json"), "utf8"), manifest = JSON.parse(text);
    assert.deepEqual(manifest.permissions, ["tabs"]);
    assert.deepEqual(Object.keys(manifest).sort(), ["key", "manifest_version", "name", "permissions", "version"]);
    assert.equal(manifest.manifest_version, 3);
    const key = createPublicKey({ key: Buffer.from(manifest.key, "base64"), format: "der", type: "spki" });
    assert.equal(key.asymmetricKeyType, "rsa");
    const id = [...createHash("sha256").update(key.export({ type: "spki", format: "der" })).digest().subarray(0, 16)].flatMap(value => [value >> 4, value & 15]).map(value => String.fromCharCode(97 + value)).join("");
    assert.equal(staged.extensionId, id); assert.match(id, /^[a-p]{32}$/);
    assert.equal(staged.url, `chrome-extension://${id}/integration-observer.html`);
    for (const [kind, name] of [["manifest", "manifest.json"], ["html", "integration-observer.html"], ["script", "integration-observer.js"]]) assert.equal(staged.sha256[kind], digest(await fs.readFile(path.join(directory, name))));
    await assert.rejects(stageReloadObserver({ directory }), { code: "EEXIST" });
    assert.equal(await fs.readFile(path.join(directory, "manifest.json"), "utf8"), text);
    await assert.rejects(stageReloadObserver({ directory: "relative-observer" }), /absolute/);
  } finally {
    const resolved = await fs.realpath(root);
    assert.equal(path.dirname(resolved).toLowerCase(), (await fs.realpath(parent)).toLowerCase());
    assert.ok(path.basename(resolved).startsWith("reload-observer-unit-"));
    await fs.rm(resolved, { recursive: true });
  }
});

function recorder(source = reloadLifecycleRecorderSource) {
  const listeners = {}; let tick = 10;
  const context = vm.createContext({ crypto: { randomUUID: () => "boot-unit" }, Date: { now: () => tick++ }, chrome: { runtime: {
    id: "unit-extension", getManifest: () => ({ version: "1.2.3" }),
    onInstalled: { addListener: callback => listeners.installed = callback },
    onStartup: { addListener: callback => listeners.startup = callback }
  } } });
  vm.runInContext(source, context);
  return { listeners, snapshot: () => JSON.parse(JSON.stringify(vm.runInContext(reloadLifecycleSnapshotExpression, context))) };
}

test("the actual staged recorder passively retains duplicate native callbacks without storage or lifecycle mutation APIs", () => {
  const value = recorder();
  assert.deepEqual(value.snapshot().events, []);
  value.listeners.installed({ reason: "update", previousVersion: "1.2.3" });
  value.listeners.startup(); value.listeners.installed({ reason: "update", previousVersion: "1.2.3" });
  const snapshot = value.snapshot();
  assert.equal(snapshot.bootId, "boot-unit"); assert.equal(snapshot.extensionId, "unit-extension"); assert.equal(snapshot.manifestVersion, "1.2.3");
  assert.deepEqual(snapshot.events.map(event => [event.sequence, event.event, event.reason]), [[0, "onInstalled", "update"], [1, "onStartup", undefined], [2, "onInstalled", "update"]]);
  snapshot.events[0].reason = "mutated";
  assert.equal(value.snapshot().events[0].reason, "update");
});

test("a bounded recorder reports overflow instead of presenting an incomplete history as complete", () => {
  const value = recorder(`(${installReloadLifecycleRecorder.toString()})(chrome,globalThis,2);`);
  value.listeners.startup(); value.listeners.startup(); value.listeners.startup();
  assert.equal(value.snapshot().events.length, 2); assert.equal(value.snapshot().overflow, true);
});

function evidence() {
  const extensionId = "a".repeat(32);
  const lifecycle = (bootId, startedAt, reason) => ({ version: 1, bootId, extensionId, manifestVersion: "1.0.0", startedAt, overflow: false,
    events: [{ sequence: 0, at: startedAt + 1, event: "onInstalled", reason }] });
  const before = { pid: 12, browserId: "/devtools/browser/same", extensionId, extensionInstanceId: "stable-install", incarnation: "incarnation-old", workerTarget: "worker-old", backgroundContextId: "context-old", bootId: "boot-old", observerTarget: "independent-observer", observerExtensionId: "b".repeat(32), hostPid: 34, hostEndpoint: "same-adapter-host", portIndex: 0, lifecycle: lifecycle("boot-old", 100, "install") };
  const after = { ...before, incarnation: "incarnation-new", workerTarget: "worker-new", backgroundContextId: "context-new", bootId: "boot-new", portIndex: 1, lifecycle: lifecycle("boot-new", 201, "update"), liveWorkerTargets: ["worker-new"] };
  const focusBefore = { identity: "observer-document", ready: true, overflow: false, at: 199, events: [{ sequence: 0, at: 150, kind: "focus", value: -1 }] };
  const options = { reloadInvocations: 1, reloadRequestedAt: 200, targetEvents: [
    { method: "Target.targetDestroyed", params: { targetId: "worker-old" } },
    { method: "Target.targetCreated", params: { targetInfo: { targetId: "worker-new", type: "service_worker", url: `chrome-extension://${extensionId}/background.js` } } }
  ], portConnections: [{ extensionId, connectedAt: 101, hello: true, closedAt: 202 }, { extensionId, connectedAt: 203, hello: true }], focusBefore, focusAfter: { ...structuredClone(focusBefore), at: 220 } };
  return { before, after, options };
}
const verify = ({ before, after, options }) => assertExtensionReload(before, after, options);

test("reload evidence requires an exact worker replacement within the same browser, installation and continuous observer", () => {
  assert.equal(verify(evidence()).observerContinuous, true);
  for (const field of ["pid", "browserId", "extensionId", "extensionInstanceId", "observerTarget", "observerExtensionId", "hostPid", "hostEndpoint"]) {
    const value = evidence(); value.after[field] = typeof value.after[field] === "number" ? 99 : "replacement";
    assert.throws(() => verify(value), undefined, field);
  }
  for (const field of ["workerTarget", "backgroundContextId", "bootId", "incarnation"]) {
    const value = evidence(); value.after[field] = value.before[field];
    assert.throws(() => verify(value), undefined, field);
  }
  for (const count of [0, 2]) { const value = evidence(); value.options.reloadInvocations = count; assert.throws(() => verify(value), /exactly once/); }
  const stopped = evidence(); stopped.after.incarnation = stopped.before.incarnation;
  assert.throws(() => verify(stopped), /incarnation/);
  const sameExtension = evidence(); sameExtension.before.observerExtensionId = sameExtension.after.observerExtensionId = sameExtension.before.extensionId;
  assert.throws(() => verify(sameExtension), /belongs to the extension/);
});

test("a returned evaluate reply or new worker alone cannot replace actual Target, Port and native update evidence", () => {
  for (const mutate of [
    value => value.options.targetEvents.shift(), value => value.options.targetEvents.pop(),
    value => value.options.targetEvents[1].params.targetInfo.type = "page",
    value => value.options.targetEvents[1].params.targetInfo.url = "chrome-extension://foreign/background.js",
    value => value.after.liveWorkerTargets.push("worker-old"),
    value => value.after.lifecycle.events = [],
    value => value.after.lifecycle.events[0].reason = "install",
    value => value.after.lifecycle.overflow = true,
    value => value.after.lifecycle.startedAt = 199,
    value => value.after.lifecycle.manifestVersion = "2.0.0",
    value => value.options.portConnections[0].closedAt = undefined,
    value => value.options.portConnections[0].closedAt = 199,
    value => value.options.portConnections[1].hello = false,
    value => value.options.portConnections[1].closedAt = 210,
    value => value.options.portConnections[1].extensionId = "foreign"
  ]) { const value = evidence(); mutate(value); assert.throws(() => verify(value)); }
});

test("reload rejects every observer gap or unapproved activation/focus and preserves any late onStartup as evidence only", () => {
  for (const mutate of [
    value => value.options.focusAfter.identity = "replacement-document",
    value => value.options.focusAfter.events = [],
    value => value.options.focusAfter.ready = false,
    value => value.options.focusAfter.overflow = true,
    value => value.options.focusAfter.events[0].value = 3,
    value => value.options.focusAfter.events.push({ sequence: 1, at: 210, kind: "activation", value: { tabId: 1, windowId: 2 } }),
    value => value.options.focusAfter.events.push({ sequence: 1, at: 210, kind: "focus", value: -1 })
  ]) { const value = evidence(); mutate(value); assert.throws(() => verify(value)); }
  const lateStartup = evidence();
  lateStartup.after.lifecycle.events.push({ sequence: 1, at: 205, event: "onStartup" });
  const result = verify(lateStartup);
  assert.equal(result.observerContinuous, true);
  assert.equal("inputReleased" in result, false); assert.equal("browserRestarted" in result, false);
});
