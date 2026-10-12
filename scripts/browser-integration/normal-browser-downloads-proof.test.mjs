import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { resolveNormalDownloadRoot, installNormalDownloadWitness, selectNormalWorker, attachNormalTarget, verifyNormalBinding,
  summarizeNormalDownloads, removeProvenNormalFile, checkNormalBrowserDownloadsProof } from "./normal-browser-downloads-proof.mjs";
import { createOriginalDownloadFixtures } from "./original-download-fixture.mjs";
import * as originalProof from "./original-download-proof.mjs";
import { FocusLedger, assertQuietObserverSetup, focusSnapshotExpression } from "./focus-ledger.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
async function temporary(t) { const directory = await fs.mkdtemp(path.join(os.tmpdir(), "obu-normal-proof-")); t.after(() => fs.rm(directory, { recursive: true, force: true })); return directory; }
async function preferences(directory, value) { await fs.mkdir(path.join(directory, "Default")); await fs.writeFile(path.join(directory, "Default/Preferences"), JSON.stringify(value)); }

test("normal default root uses actual preference, not returned path or private HOME", async t => {
  const root = await temporary(t), downloads = path.join(root, "actual downloads"); await fs.mkdir(downloads);
  await preferences(root, { download: { default_directory: downloads } });
  const result = await resolveNormalDownloadRoot(root, { knownFolder: () => { throw new Error("must not fall back"); } });
  assert.equal(result.directory, downloads); assert.equal(result.realPath, await fs.realpath(downloads)); assert.match(result.source, /Preferences/); assert.match(result.preferencesSHA256, /^[a-f0-9]{64}$/);
});
test("missing default reads actual Known Folder callback once, without writing prefs", async t => {
  const root = await temporary(t), downloads = path.join(root, "known"); await fs.mkdir(downloads); let calls = 0;
  const result = await resolveNormalDownloadRoot(root, { knownFolder: async () => { calls++; return downloads; } });
  assert.equal(calls, 1); assert.equal(result.directory, downloads); assert.match(result.source, /SHGetKnownFolderPath/);
  await assert.rejects(fs.stat(path.join(root, "Default/Preferences")), { code: "ENOENT" });
});
for (const invalid of ["", "relative/path", null, 23]) test(`invalid configured default ${JSON.stringify(invalid)} cannot silently fall back`, async t => {
  const root = await temporary(t); await preferences(root, { download: { default_directory: invalid } }); let fallback = false;
  await assert.rejects(resolveNormalDownloadRoot(root, { knownFolder: () => { fallback = true; return root; } }), /absolute/); assert.equal(fallback, false);
});
test("malformed private prefs are retained as a failure", async t => {
  const root = await temporary(t); await fs.mkdir(path.join(root, "Default")); await fs.writeFile(path.join(root, "Default/Preferences"), "{");
  await assert.rejects(resolveNormalDownloadRoot(root, { knownFolder: () => root }), SyntaxError);
});
test("regular file cannot be used as the expected download directory", async t => {
  const root = await temporary(t), file = path.join(root, "file"); await fs.writeFile(file, "x"); await preferences(root, { download: { default_directory: file } });
  await assert.rejects(resolveNormalDownloadRoot(root), /regular directory/);
});

function hookFixture(maximum = 2) {
  const event = () => ({ listeners: new Set(), addListener(fn) { this.listeners.add(fn); }, removeListener(fn) { this.listeners.delete(fn); }, send(...values) { for (const fn of this.listeners) fn(...values); } });
  const chrome = { debugger: { onEvent: event() }, tabs: { onActivated: event() }, windows: { onFocusChanged: event() } }, target = {};
  const context = vm.createContext({ chrome, target, structuredClone, Date });
  vm.runInContext(`(${installNormalDownloadWitness.toString()})(chrome,target,'witness',${maximum})`, context);
  return { chrome, target };
}
test("serialized passive witness observes original iframe source/session and removes listeners", () => {
  const { chrome, target } = hookFixture(); const source = { tabId: 42, sessionId: "parent" }, params = { sessionId: "child", targetInfo: { type: "iframe", targetId: "frame", url: "http://localhost/" } };
  chrome.debugger.onEvent.send(source, "Target.attachedToTarget", params); source.tabId = 99;
  chrome.tabs.onActivated.send({ tabId: 7, windowId: 4 }); chrome.windows.onFocusChanged.send(4);
  const value = target.__normalDownloadWitness.stop();
  assert.equal(value.frames[0].tabId, 42); assert.equal(value.frames[0].source.tabId, 42); assert.equal(value.frames[0].sessionId, "child"); assert.equal(value.focus.events.length, 2);
  for (const event of [chrome.debugger.onEvent, chrome.tabs.onActivated, chrome.windows.onFocusChanged]) assert.equal(event.listeners.size, 0);
  assert.equal(target.__normalDownloadWitness, undefined); assert.equal(target.__integrationFrames, undefined);
});
test("witness bounded overflow fails visibly and never wraps native APIs", () => {
  const { chrome, target } = hookFixture(1);
  for (let i = 0; i < 2; i++) { chrome.debugger.onEvent.send({ tabId: 1 }, "Target.attachedToTarget", { sessionId: "s", targetInfo: { type: "iframe", targetId: `f${i}` } }); chrome.windows.onFocusChanged.send(i); }
  const value = target.__normalDownloadWitness.stop(); assert.equal(value.frameOverflow, true); assert.equal(value.focus.overflow, true); assert.equal(value.frames.length, 1);
});
test("replaced witness is not silently deleted", () => {
  const { target } = hookFixture(); const api = target.__normalDownloadWitness; target.__integrationFrames = ["replacement"];
  assert.throws(() => api.stop(), /replaced/); assert.deepEqual(target.__integrationFrames, ["replacement"]);
});
test("normal worker selection rejects ambiguous, wrong extension and wrong target type", () => {
  const id = "a".repeat(32), worker = { type: "service_worker", url: `chrome-extension://${id}/background.js`, targetId: "exact" };
  assert.equal(selectNormalWorker({ targetInfos: [worker] }, id), worker);
  for (const values of [[], [worker, { ...worker, targetId: "other" }], [{ ...worker, type: "page" }], [{ ...worker, url: "chrome-extension://wrong/background.js" }]]) assert.throws(() => selectNormalWorker({ targetInfos: values }, id), /absent or ambiguous/);
});
test("worker adapter uses the original approved Browser WS with flattened session", async () => {
  const calls = [], cdp = { call: async (...args) => { calls.push(args); return { sessionId: "flat" }; }, evaluate: async (...args) => { calls.push(args); return "observed"; } };
  const worker = await attachNormalTarget(cdp, "worker"); assert.equal(await worker.evaluate("expression", 1234), "observed");
  assert.deepEqual(calls, [["Target.attachToTarget", { targetId: "worker", flatten: true }, 10000], ["expression", 1234, "flat"]]);
});
function bindingFixture() {
  const binding = { bound: true, exclusive: true, behavior: "default", generation: "g", extensionId: "a".repeat(32), extensionInstanceId: "i", workerBootId: "w", portId: "p" };
  return { binding, identity: { extensionId: binding.extensionId, binding: { ...binding } }, infos: [{ metadata: { extensionId: binding.extensionId, extensionInstanceId: "i", downloadWaitPathVersion: 1, pageDownloads: { available: true, generation: "g" } } }] };
}
test("public capability and worker original Native Port fields agree", () => { const v = bindingFixture(); verifyNormalBinding(v.binding, v.identity, v.infos); });
for (const field of ["extensionId", "extensionInstanceId", "workerBootId", "portId"]) test(`replacement ${field} cannot pass native binding proof`, () => {
  const v = bindingFixture(); v.identity.binding[field] = "replacement"; assert.throws(() => verifyNormalBinding(v.binding, v.identity, v.infos));
});
test("stale public generation or unavailable original connection is rejected", () => {
  for (const patch of [{ generation: "other" }, { available: false }]) { const v = bindingFixture(); Object.assign(v.infos[0].metadata.pageDownloads, patch); assert.throws(() => verifyNormalBinding(v.binding, v.identity, v.infos)); }
});
function analysisFixture() {
  const fixture = createOriginalDownloadFixtures(), proof = { cases: [], cleanupErrors: [], missingFileRejected: true };
  for (const variant of ["root", "oopif", "dynamic-oopif"]) for (const kind of ["post", "blob"]) for (let i = 0; i < 3; i++) {
    const record = fixture.createCase({ kind, variant, owner: `${variant}-${kind}-${i}` }), bytes = Buffer.from(record.expected.base64, "base64");
    proof.cases.push({ key: record.key, variant, kind, requirePath: true, downloadId: randomUUID(), file: { ...record.expected, identity: { ino: "1" }, analysis: JSON.parse(bytes.subarray(0, bytes.indexOf(10))) }, server: { requests: kind === "post" ? [{ method: "POST" }] : [] } });
  }
  return { proof, fixture };
}
test("analysis totals all 18 original payloads and six files per actual layout", () => {
  const { proof, fixture } = analysisFixture(), result = summarizeNormalDownloads(proof, fixture);
  assert.equal(result.files, 18); assert.equal(result.postRequests, 9); assert.equal(result.bytes, proof.cases.reduce((sum, item) => sum + item.file.bytes, 0));
});
for (const mutation of [p => p.cases.pop(), p => p.missingFileRejected = false, p => p.cases[0].file.analysis.nonce = "forged", p => p.cases[0].downloadId = p.cases[1].downloadId, p => p.cases[0].server.requests.push({ method: "POST" }), p => p.cases[0].requirePath = false]) test("analysis rejects incomplete, replayed or misattributed original proof", () => {
  const { proof, fixture } = analysisFixture(); mutation(proof); assert.throws(() => summarizeNormalDownloads(proof, fixture));
});
test("cleanup removes only the exact proven original file", async t => {
  const root = await temporary(t), fixture = createOriginalDownloadFixtures(), record = fixture.createCase({ kind: "post", owner: "owner" }), file = path.join(root, "report.bin");
  await fs.writeFile(file, Buffer.from(record.expected.base64, "base64"));
  const opened = await originalProof.openOriginalDownloadFile(root, file); await opened.handle.close();
  const item = { productPath: file, file: { identity: opened.identity, sha256: record.expected.sha256, analysis: { key: record.key, nonce: record.nonce } } };
  assert.equal((await removeProvenNormalFile(root, item, record)).removed, true); await assert.rejects(fs.stat(file), { code: "ENOENT" });
});
test("cleanup leaves replacement contents untouched", async t => {
  const root = await temporary(t), fixture = createOriginalDownloadFixtures(), record = fixture.createCase({ kind: "post", owner: "owner" }), file = path.join(root, "report.bin");
  await fs.writeFile(file, Buffer.from(record.expected.base64, "base64")); const opened = await originalProof.openOriginalDownloadFile(root, file); await opened.handle.close();
  const item = { productPath: file, file: { identity: opened.identity, sha256: record.expected.sha256, analysis: { key: record.key, nonce: record.nonce } } }; await fs.writeFile(file, "replacement");
  await assert.rejects(removeProvenNormalFile(root, item, record)); assert.equal(await fs.readFile(file, "utf8"), "replacement");
});
test("cleanup keeps a file that grows after opening, with a hard read bound and content-free error", async t => {
  const root = await temporary(t), fixture = createOriginalDownloadFixtures(), record = fixture.createCase({ kind: "post", owner: "owner" }), file = path.join(root, "report.bin");
  await fs.writeFile(file, Buffer.from(record.expected.base64, "base64"));
  const opened = await originalProof.openOriginalDownloadFile(root, file); await opened.handle.close();
  const item = { productPath: file, file: { identity: opened.identity, sha256: record.expected.sha256, analysis: { key: record.key, nonce: record.nonce } } };
  const nativeOpen = fs.open.bind(fs), secret = "UNRELATED_GROWING_CONTENT_d92d4d", lengths = [];
  let grew = false, unboundedReads = 0;
  const patched = t.mock.method(fs, "open", async (...args) => {
    const handle = await nativeOpen(...args);
    if (args[0] !== file) return handle;
    return new Proxy(handle, { get(target, key) {
      if (key === "readFile") return () => { unboundedReads++; throw new Error("Unbounded cleanup readFile invoked"); };
      if (key === "read") return async (buffer, offset, length, position) => {
        lengths.push(length);
        if (!grew) { grew = true; await fs.appendFile(file, secret.repeat(4096)); }
        return target.read(buffer, offset, length, position);
      };
      const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
    } });
  });
  let failure;
  try { await removeProvenNormalFile(root, item, record); } catch (error) { failure = error; }
  finally { patched.mock.restore(); }
  assert.match(failure?.message ?? "", /size bound/); assert.equal(unboundedReads, 0);
  assert.ok(lengths.length > 0 && lengths.every(length => length > 0 && length <= 65536));
  assert.equal(lengths.reduce((sum, length) => sum + length, 0), 65536);
  assert.doesNotMatch(JSON.stringify({ error: failure, stack: failure.stack, actual: failure.actual }), new RegExp(secret));
  assert.ok((await fs.stat(file)).size > 65536, "Growing file must remain untouched");
});
test("permission refusal preserves failure, makes one connection attempt and executes no task", async t => {
  const profile = await temporary(t), root = path.join(profile, "downloads"); await fs.mkdir(root); await preferences(profile, { download: { default_directory: root } });
  const saved = [], report = {}; let connections = 0, tasks = 0;
  const ctx = { profile, report, devTools: { url: "ws://127.0.0.1:1/devtools/browser/id" }, checkpoint: async () => {}, save: async (name, value) => saved.push({ name, value: structuredClone(value) }),
    connectCDP: async () => { connections++; throw new Error("Human refused diagnostic connection"); }, connectBrowser: async () => { tasks++; } };
  await assert.rejects(checkNormalBrowserDownloadsProof(ctx), /Human refused/); assert.equal(connections, 1); assert.equal(tasks, 0);
  assert.equal(report.downloadProof.verified, false); assert.equal(saved.length, 1); assert.equal(saved[0].value.verified, false); assert.equal(saved[0].value.server.requests.length, 0);
});

// Execute the actual exported orchestration with explicit VM dependencies. Only
// the already separately tested business fixture is stubbed; no browser starts.
function orchestration({ setupActivation = false, scopeChange = false, finalizeFailure = false, taskFocus = false, abortTask = false } = {}) {
  const evidence = analysisFixture(), native = bindingFixture(), saved = [], report = {}, commands = [];
  let done = false, state = "open", sentinelURL, clientsClosed = 0;
  const controller = new AbortController();
  const focus = () => ({ identity: "observer", ready: true, overflow: false, at: Date.now(), events: done && taskFocus ? [{ sequence: 0, at: Date.now(), kind: "focus", value: -1 }] : [] });
  const snapshot = () => ({ nonce: "fixed-nonce", url: sentinelURL, value: "fixed-nonce", start: 2, end: 7, active: "note", focused: true, visibility: "visible", width: 900, height: 700 });
  const cdp = {
    call: async (method, params) => { commands.push({ method, params });
      if (method === "Target.getTargets") return { targetInfos: [{ type: "service_worker", targetId: "worker", url: `chrome-extension://${native.binding.extensionId}/background.js` }, ...(sentinelURL ? [{ type: "page", targetId: "sentinel", url: sentinelURL }] : [])] };
      if (method === "Target.attachToTarget") return { sessionId: params.targetId };
      if (method === "Target.createTarget") return { targetId: "observer" };
      if (method === "Target.closeTarget") return { success: true };
      return {};
    },
    evaluate: async (expression, timeout, session) => {
      if (session === "sentinel") return snapshot();
      if (session === "observer") {
        if (expression.startsWith("location.href")) return true;
        if (expression.includes("chrome.windows.getAll")) return { windows: [{ id: 2, focused: true, tabs: [{ id: 1, active: true }] }], ledger: focus() };
        return focus();
      }
      if (expression.includes("extensionId:chrome.runtime.id")) { const value = structuredClone(native.identity); if (done && scopeChange) value.binding.portId = "new-port"; return value; }
      if (expression.startsWith("chrome.tabs.create")) { sentinelURL = JSON.parse(expression.match(/url:(".*"),active/)[1]); return { id: 1 }; }
      if (expression.startsWith("chrome.tabs.get")) return { id: 1, windowId: 2, url: sentinelURL, status: "complete" };
      if (expression.includes("installNormalDownloadWitness")) return { identity: "witness" };
      if (expression.includes("__normalDownloadWitness.snapshot")) return { focus: { ...focus(), events: setupActivation ? [{ sequence: 0, at: Date.now(), kind: "activation", value: { tabId: 3, windowId: 2 } }] : [] } };
      if (expression.includes("__normalDownloadWitness.stop")) return { frames: [], frameOverflow: false, focus: { overflow: false } };
      if (expression.includes("chrome.debugger.getTargets")) return { tabs: [], targets: [] };
      throw new Error(`Unexpected evaluation: ${expression}`);
    }, close: async () => { state = "closed"; }, state: () => state
  };
  const context = vm.createContext({ assert, Date, performance, Promise, Error, JSON, structuredClone,
    digest: hash, randomUUID: () => "fixed-nonce", delay: async () => {}, resolveNormalDownloadRoot: async () => ({ directory: "root" }),
    createOriginalDownloadFixtures: () => evidence.fixture, FocusLedger, assertQuietObserverSetup, focusSnapshotExpression,
    selectNormalWorker, attachNormalTarget, verifyNormalBinding, summarizeNormalDownloads, installNormalDownloadWitness,
    sentinelHTML: () => "fixture", sentinelSnapshot: "sentinelSnapshot", workerIdentity: "extensionId:chrome.runtime.id", listenFixture: async () => {},
    http: { createServer: () => ({ address: () => ({ port: 55555 }), close(callback) { callback(); }, closeAllConnections() {} }) },
    originalProof: { checkOriginalDownloadProof: async () => { done = true; if (abortTask) controller.abort(new Error("explicit stop")); return evidence.proof; } }
  });
  const run = vm.runInContext(`(${checkNormalBrowserDownloadsProof.toString()})`, context);
  const ctx = { profile: "profile", report, signal: controller.signal, devTools: { url: "ws://fixture" }, observer: { url: "chrome-extension://observer/page", extensionId: "observer" }, extensionId: native.binding.extensionId,
    binding: { verified: true, reply: { result: native.binding } }, checkpoint: async () => {}, save: async (name, value) => saved.push(structuredClone(value)), connectCDP: async () => cdp,
    connectBrowser: async () => ({ client: { getInfo: async () => native.infos[0], finalizeTabs: async () => { if (finalizeFailure) throw new Error("actual finalization rejected"); return {}; } }, close() { clientsClosed++; } }) };
  return { run: () => run(ctx), report, saved, commands, businessReached: () => done, clientsClosed: () => clientsClosed };
}
test("orchestration records continuous task focus and awaits diagnostic close", async () => {
  const fixture = orchestration(); const result = await fixture.run(); assert.equal(result.verified, true);
  assert.equal(result.focus.snapshots.length, 3); assert.equal(result.cleanup.find(row => row.name === "close diagnostic Browser WebSocket").value.closed, true);
});
test("observer-setup activation is never reset away or mistaken for task acceptance", async () => {
  const fixture = orchestration({ setupActivation: true }); await assert.rejects(fixture.run(), /setup caused/);
  assert.equal(fixture.businessReached(), false); assert.equal(fixture.saved[0].verified, false); assert.equal(fixture.report.downloadProof.focus.readyAt, undefined);
});
test("replacement Native Port after file success remains a failed run", async () => {
  const fixture = orchestration({ scopeChange: true }); await assert.rejects(fixture.run(), /portId changed/); assert.equal(fixture.saved[0].verified, false);
});
test("finalize failure cannot leave successful business proof marked verified", async () => {
  const fixture = orchestration({ finalizeFailure: true }); await assert.rejects(fixture.run(), /finalization rejected/);
  assert.equal(fixture.businessReached(), true); assert.equal(fixture.saved[0].verified, false); assert.equal(fixture.report.downloadProof.cleanup.filter(row => row.name.startsWith("finalize") && !row.ok).length, 3);
});
test("unattributed native focus during task is preserved through teardown", async () => {
  const fixture = orchestration({ taskFocus: true }); await assert.rejects(fixture.run(), /Unexpected native focus/); assert.equal(fixture.saved[0].verified, false);
});
test("explicit stop closes existing SDK clients and cannot become verified", async () => {
  const fixture = orchestration({ abortTask: true }); await assert.rejects(fixture.run(), /explicit stop/);
  assert.equal(fixture.report.downloadProof.stop.clients, 3); assert.equal(fixture.clientsClosed(), 6); assert.equal(fixture.saved[0].verified, false);
});
