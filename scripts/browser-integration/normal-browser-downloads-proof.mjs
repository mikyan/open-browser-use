import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { FocusLedger, assertQuietObserverSetup, focusSnapshotExpression } from "./focus-ledger.mjs";
import { createOriginalDownloadFixtures } from "./original-download-fixture.mjs";
import { listenFixture } from "./fixture-listener.mjs";
import * as originalProof from "./original-download-proof.mjs";

const digest = value => createHash("sha256").update(value).digest("hex");
const runFile = promisify(execFile);
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const knownFolderSource = `Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class OBUKnownDownloads {
 [DllImport("shell32.dll")] static extern int SHGetKnownFolderPath([MarshalAs(UnmanagedType.LPStruct)] Guid id, uint flags, IntPtr token, out IntPtr value);
 public static string Read() { IntPtr p; int hr=SHGetKnownFolderPath(new Guid("374DE290-123F-4565-9164-39C4925E467B"),0,IntPtr.Zero,out p); Marshal.ThrowExceptionForHR(hr); try{return Marshal.PtrToStringUni(p);}finally{Marshal.FreeCoTaskMem(p);} }
}
'@
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
ConvertTo-Json -Compress -InputObject ([OBUKnownDownloads]::Read())`;

export async function readKnownDownloadsFolder() {
  assert.equal(process.platform, "win32", "Normal browser download proof currently requires Windows");
  const { stdout } = await runFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", knownFolderSource], { windowsHide: true, timeout: 10000, maxBuffer: 65536, encoding: "utf8" });
  return JSON.parse(stdout.replace(/^\uFEFF/, "").trim());
}

// This is an independently read default, never dirname(productPath), a glob, or
// a test-written preference. SHGetKnownFolderPath uses the actual process token.
export async function resolveNormalDownloadRoot(profile, { knownFolder = readKnownDownloadsFolder } = {}) {
  assert.ok(path.isAbsolute(profile));
  const preferencesFile = path.join(profile, "Default", "Preferences");
  let bytes, preferences;
  try {
    bytes = await fs.readFile(preferencesFile); assert.ok(bytes.length <= 16 * 1024 * 1024, "Private Preferences exceeds evidence bound");
    preferences = JSON.parse(bytes.toString("utf8"));
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const configured = preferences?.download?.default_directory;
  const directory = configured === undefined ? await knownFolder() : configured;
  assert.ok(typeof directory === "string" && path.isAbsolute(directory), "Actual default download directory must be absolute");
  const stat = await fs.lstat(directory); assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), "Default download directory must be a regular directory");
  const realPath = await fs.realpath(directory);
  return { directory, realPath, source: configured === undefined ? "SHGetKnownFolderPath(FOLDERID_Downloads), actual Windows token" : "isolated Default/Preferences download.default_directory",
    preferencesFile, preferencesSHA256: bytes ? digest(bytes) : null, configured: configured ?? null,
    boundary: "Read-only default location; enterprise redirects or Save As may cause a preserved failure. No preference or Browser download path is set." };
}

// Serialized into the already-approved, exact production worker. No product API
// is wrapped. The old proof consumes this passive native attachment history.
export function installNormalDownloadWitness(chrome, target, identity, maximum = 1024) {
  if (target.__normalDownloadWitness || target.__integrationFrames) throw new Error("Normal download witness already exists");
  const frames = [], events = []; let frameOverflow = false, focusOverflow = false;
  const append = (kind, value) => { if (events.length >= maximum) { focusOverflow = true; return; } events.push({ sequence: events.length, at: Date.now(), kind, value }); };
  const activation = value => append("activation", { ...value });
  const focus = value => append("focus", value);
  const listener = (source, method, params) => {
    if (method !== "Target.attachedToTarget" || params?.targetInfo?.type !== "iframe") return;
    if (frames.length >= maximum) { frameOverflow = true; return; }
    frames.push({ tabId: source.tabId, source: structuredClone(source), sessionId: params.sessionId, targetId: params.targetInfo.targetId, type: params.targetInfo.type, url: params.targetInfo.url });
  };
  const snapshot = () => ({ identity, frames: structuredClone(frames), frameOverflow,
    focus: { identity, ready: true, overflow: focusOverflow, at: Date.now(), events: structuredClone(events) } });
  const api = { snapshot, stop: () => {
    if (target.__normalDownloadWitness !== api || target.__integrationFrames !== frames) throw new Error("Normal download witness replaced");
    chrome.debugger.onEvent.removeListener(listener); chrome.tabs.onActivated.removeListener(activation); chrome.windows.onFocusChanged.removeListener(focus);
    const result = snapshot(); delete target.__normalDownloadWitness; delete target.__integrationFrames; return result;
  } };
  target.__integrationFrames = frames; target.__normalDownloadWitness = api;
  chrome.debugger.onEvent.addListener(listener); chrome.tabs.onActivated.addListener(activation); chrome.windows.onFocusChanged.addListener(focus);
  return snapshot();
}

export function selectNormalWorker(targets, extensionId) {
  assert.match(extensionId, /^[a-p]{32}$/);
  const matches = targets.targetInfos.filter(value => value.type === "service_worker" && value.url === `chrome-extension://${extensionId}/background.js`);
  assert.equal(matches.length, 1, "Exact production worker absent or ambiguous");
  assert.ok(typeof matches[0].targetId === "string" && matches[0].targetId); return matches[0];
}

export async function attachNormalTarget(cdp, targetId) {
  const reply = await cdp.call("Target.attachToTarget", { targetId, flatten: true }, 10000);
  assert.ok(typeof reply.sessionId === "string" && reply.sessionId);
  return { targetId, sessionId: reply.sessionId, evaluate: (expression, timeoutMs = 10000) => cdp.evaluate(expression, timeoutMs, reply.sessionId) };
}

export function verifyNormalBinding(binding, identity, infos) {
  assert.equal(binding.bound, true); assert.equal(binding.exclusive, true); assert.equal(binding.behavior, "default");
  for (const key of ["extensionId", "extensionInstanceId", "workerBootId", "portId"]) {
    assert.ok(typeof binding[key] === "string" && binding[key]); assert.equal(identity.binding?.[key], binding[key], `Original Native Port ${key} changed`);
  }
  assert.equal(identity.extensionId, binding.extensionId);
  for (const info of infos) {
    assert.equal(info.metadata.extensionId, binding.extensionId);
    assert.equal(info.metadata.extensionInstanceId, binding.extensionInstanceId);
    assert.equal(info.metadata.downloadWaitPathVersion, 1);
    assert.equal(info.metadata.pageDownloads.available, true);
    assert.equal(info.metadata.pageDownloads.generation, binding.generation);
  }
}

export function summarizeNormalDownloads(proof, fixture) {
  assert.equal(proof.cases.length, 18); assert.equal(proof.missingFileRejected, true); assert.deepEqual(proof.cleanupErrors, []);
  const summary = { files: 18, bytes: 0, postRequests: 0, variants: {}, originalGUIDs: [], sha256: [] };
  for (const item of proof.cases) {
    const record = fixture.stats(item.key), bytes = Buffer.from(item.file.base64, "base64");
    assert.equal(item.kind, record.kind); assert.equal(item.variant, record.variant);
    assert.equal(item.requirePath, true); assert.ok(item.file.identity);
    assert.equal(item.file.analysis.key, record.key); assert.equal(item.file.analysis.nonce, record.nonce);
    assert.equal(item.file.analysis.owner, record.owner); assert.equal(item.file.analysis.kind, record.kind);
    assert.equal(item.file.bytes, bytes.length); assert.equal(item.file.sha256, digest(bytes));
    assert.deepEqual(bytes, Buffer.from(record.expected.base64, "base64"));
    const slot = summary.variants[item.variant] ??= { files: 0, bytes: 0, post: 0, blob: 0 };
    assert.ok(["root", "oopif", "dynamic-oopif"].includes(item.variant));
    slot.files++; slot.bytes += bytes.length; slot[item.kind]++; summary.bytes += bytes.length;
    summary.postRequests += item.server.requests.filter(hit => hit.method === "POST").length;
    summary.originalGUIDs.push(item.downloadId); summary.sha256.push(item.file.sha256);
  }
  for (const value of Object.values(summary.variants)) { assert.equal(value.files, 6); assert.equal(value.post, 3); assert.equal(value.blob, 3); }
  assert.equal(Object.keys(summary.variants).length, 3); assert.equal(summary.postRequests, 9);
  assert.equal(new Set(summary.originalGUIDs).size, 18); assert.equal(new Set(summary.sha256).size, 18);
  return summary;
}

export async function removeProvenNormalFile(root, item, record) {
  assert.equal(item.file.analysis.key, record.key); assert.equal(item.file.analysis.nonce, record.nonce);
  const verified = await originalProof.readOriginalDownloadProof(root, item.productPath, record.expected);
  assert.deepEqual(verified.identity, item.file.identity, "Original file identity changed before cleanup");
  assert.equal(verified.sha256, item.file.sha256);
  const final = await originalProof.openOriginalDownloadFile(root, item.productPath);
  try { assert.deepEqual(final.identity, item.file.identity, "Original file identity changed at deletion boundary"); }
  finally { await final.handle.close(); }
  await fs.unlink(item.productPath);
  await assert.rejects(fs.lstat(item.productPath), { code: "ENOENT" });
  return { path: item.productPath, sha256: item.file.sha256, removed: true, boundary: "Checked exact original identity and bytes; check-to-unlink is not an atomic concurrent-filesystem guarantee." };
}

function sentinelHTML(nonce) {
  return `<!doctype html><meta charset="utf-8"><title>Normal Edge download sentinel</title><textarea id="note">${nonce}</textarea><script>document.querySelector('#note').focus();document.querySelector('#note').setSelectionRange(2,7);globalThis.sentinelNonce=${JSON.stringify(nonce)}</script>`;
}
const sentinelSnapshot = "({nonce:globalThis.sentinelNonce,url:location.href,value:document.querySelector('#note')?.value,start:document.querySelector('#note')?.selectionStart,end:document.querySelector('#note')?.selectionEnd,active:document.activeElement?.id,focused:document.hasFocus(),visibility:document.visibilityState,width:innerWidth,height:innerHeight})";
const workerIdentity = "({extensionId:chrome.runtime.id,version:chrome.runtime.getManifest().version,binding:globalThis.__obuNativeDownloadBinding})";

// No import-time browser/OS/file effects. The runner alone owns browser launch,
// registry installation, human approval and actual process/Native Host cleanup.
export async function checkNormalBrowserDownloadsProof(ctx) {
  const detail = { verified: false, boundary: "Three JS sessions, 18 original POST/Blob files in a normally launched isolated Edge. Human authorization and deliberate sentinel setup precede task focus coverage. Independent observer document shares one separately approved diagnostic Browser WebSocket; product Native Port/Browser WebSocket remain real and separate.",
    setup: {}, focus: { allowedActivations: [], allowedFocus: [] }, cleanup: [], errors: [] };
  ctx.report.downloadProof = detail;
  const owners = [], sessions = [], fixture = createOriginalDownloadFixtures(), ledger = new FocusLedger();
  let cdp, worker, observer, sentinel, server, observerTarget, witnessInstalled = false, failure, initialSentinel, root;
  const checkAbort = () => { if (ctx.signal?.aborted) throw ctx.signal.reason ?? new Error("Normal download proof aborted"); };
  const stop = () => {
    detail.stop = { at: Date.now(), clients: owners.length };
    for (const owner of owners) try { owner.close(); } catch (error) { detail.errors.push(error.stack ?? String(error)); }
  };
  ctx.signal?.addEventListener("abort", stop, { once: true });
  const until = async (read, label, timeoutMs = 10000) => {
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) { checkAbort(); const value = await read(); if (value) return value; await delay(Math.min(50, Math.max(1, deadline - performance.now()))); }
    throw new Error(`Timed out waiting for ${label}`);
  };
  async function cleanup(name, action) {
    const row = { name, at: Date.now(), ok: false }; detail.cleanup.push(row);
    try { row.value = await action(); row.ok = true; } catch (error) { row.error = error.stack ?? String(error); detail.errors.push(row.error); }
  }
  async function focus(label) {
    const state = await observer.evaluate(`(async()=>({label:${JSON.stringify(label)},windows:await chrome.windows.getAll({populate:true}),ledger:${focusSnapshotExpression}}))()`);
    ledger.assertAllowed(state.ledger, [], []);
    const window = state.windows.find(value => value.id === detail.setup.sentinel.windowId);
    assert.ok(window && window.focused, "Original sentinel window is no longer focused");
    assert.equal(window.tabs.find(value => value.active)?.id, detail.setup.sentinel.id);
    const actual = await sentinel.evaluate(sentinelSnapshot);
    for (const key of ["nonce", "url", "value", "start", "end", "active", "focused", "visibility"]) assert.equal(actual[key], initialSentinel[key], `Sentinel ${key} changed`);
    detail.focus.snapshots ??= []; detail.focus.snapshots.push({ at: Date.now(), ...state, sentinel: actual });
    return state;
  }
  try {
    checkAbort(); root = detail.downloadRoot = await resolveNormalDownloadRoot(ctx.profile);
    detail.setup.authorization = {}; await ctx.checkpoint();
    cdp = await ctx.connectCDP(ctx.devTools.url, { handshakeTimeoutMs: 120000, record: detail.setup.authorization });
    detail.setup.authorizationCompletedAt = Date.now(); checkAbort();
    const target = selectNormalWorker(await cdp.call("Target.getTargets"), ctx.extensionId);
    worker = await attachNormalTarget(cdp, target.targetId); sessions.push(worker); detail.setup.worker = { targetId: target.targetId, sessionId: worker.sessionId };
    detail.identityBefore = await worker.evaluate(workerIdentity);
    for (let index = 0; index < 3; index++) { owners.push(await ctx.connectBrowser(`normal-original-${index}-${randomUUID()}`)); checkAbort(); }
    assert.equal(ctx.binding.verified, true);
    detail.infoBefore = await Promise.all(owners.map(owner => owner.client.getInfo())); verifyNormalBinding(ctx.binding.reply.result, detail.identityBefore, detail.infoBefore);
    const nonce = randomUUID(), html = sentinelHTML(nonce);
    server = http.createServer((request, response) => {
      const base = `http://127.0.0.1:${server.address().port}/`;
      if (fixture.handle(request, response, base)) return;
      if (request.method === "GET" && request.url === "/sentinel") { response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }); response.end(html); }
      else { response.writeHead(404); response.end(); }
    });
    await listenFixture(server);
    const fixtureURL = `http://127.0.0.1:${server.address().port}/`; detail.fixtureURL = fixtureURL;
    detail.setup.sentinelHTMLSHA256 = digest(html); detail.setup.sentinelRequestedAt = Date.now();
    const tab = await worker.evaluate(`chrome.tabs.create({url:${JSON.stringify(fixtureURL + "sentinel")},active:true})`);
    detail.setup.sentinel = await until(async () => { const value = await worker.evaluate(`chrome.tabs.get(${tab.id})`); return value.url === fixtureURL + "sentinel" && value.status === "complete" && value; }, "original sentinel load");
    const sentinelTarget = (await cdp.call("Target.getTargets")).targetInfos.filter(value => value.type === "page" && value.url === fixtureURL + "sentinel"); assert.equal(sentinelTarget.length, 1);
    sentinel = await attachNormalTarget(cdp, sentinelTarget[0].targetId); sessions.push(sentinel);
    initialSentinel = detail.setup.sentinelDOM = await sentinel.evaluate(sentinelSnapshot); assert.equal(initialSentinel.nonce, nonce); assert.equal(initialSentinel.start, 2); assert.equal(initialSentinel.end, 7);
    detail.setup.witness = await worker.evaluate(`(${installNormalDownloadWitness.toString()})(chrome,globalThis,${JSON.stringify(randomUUID())})`); witnessInstalled = true;
    assert.notEqual(ctx.observer.extensionId, ctx.extensionId);
    observerTarget = (await cdp.call("Target.createTarget", { url: ctx.observer.url, background: true })).targetId;
    observer = await attachNormalTarget(cdp, observerTarget); sessions.push(observer); detail.setup.observer = { targetId: observerTarget, sessionId: observer.sessionId, url: ctx.observer.url, extensionId: ctx.observer.extensionId };
    await until(() => observer.evaluate(`location.href===${JSON.stringify(ctx.observer.url)}&&globalThis.__integrationFocusLedger?.snapshot().ready===true`), "independent observer document");
    detail.setup.workerFocus = (await worker.evaluate("__normalDownloadWitness.snapshot()" )).focus;
    detail.setup.observerFocus = await observer.evaluate(focusSnapshotExpression);
    assertQuietObserverSetup(detail.setup.workerFocus, detail.setup.observerFocus);
    detail.focus.readyAt = Date.now(); await focus("before-task"); await ctx.checkpoint();
    try { detail.original = await originalProof.checkOriginalDownloadProof({ owners, worker, fixture, fixtureURL, downloadRoot: root.directory, until, behavior: "default", product: true }); }
    catch (error) { detail.original = error.originalDownloadDetail; throw error; }
    checkAbort();
    detail.analysis = summarizeNormalDownloads(detail.original, fixture);
    detail.identityAfter = await worker.evaluate(workerIdentity); detail.infoAfter = await Promise.all(owners.map(owner => owner.client.getInfo()));
    verifyNormalBinding(ctx.binding.reply.result, detail.identityAfter, detail.infoAfter); assert.deepEqual(detail.identityAfter, detail.identityBefore);
    await focus("after-18-original-files");
  } catch (error) { failure = error; detail.errors.push(error.stack ?? String(error)); }
  finally {
    for (const [index, owner] of owners.entries()) await cleanup(`finalize owner ${index}`, async () => { try { return await owner.client.finalizeTabs([]); } finally { owner.close(); } });
    if (observer && detail.focus.readyAt) await cleanup("final task focus", async () => { const state = await focus("after-owner-finalize"); detail.focus.coverageEndedAt = Date.now(); detail.focus.durationMs = detail.focus.coverageEndedAt - detail.focus.readyAt; return state.ledger; });
    if (witnessInstalled) await cleanup("stop passive native witness", async () => { const value = await worker.evaluate("__normalDownloadWitness.stop()"); detail.nativeWitness = value; assert.equal(value.frameOverflow, false); assert.equal(value.focus.overflow, false); return value; });
    for (const [index, item] of (detail.original?.cases ?? []).entries()) {
      if (!item.file?.identity || !item.productPath) continue;
      await cleanup(`remove proven original file ${index}`, async () => {
        if (index === 0 && detail.original.missingFileRejected) { await assert.rejects(fs.lstat(item.productPath), { code: "ENOENT" }); return { path: item.productPath, removedByOriginalMissingFileCheck: true }; }
        return removeProvenNormalFile(root.directory, item, fixture.stats(item.key));
      });
    }
    if (worker && detail.original?.cases?.length) await cleanup("original task tabs and targets absent", async () => {
      const value = await worker.evaluate("(async()=>({tabs:await chrome.tabs.query({}),targets:await chrome.debugger.getTargets()}))()");
      for (const item of detail.original.cases) { assert.ok(!value.tabs.some(tab => tab.id === item.tabId)); assert.ok(!value.targets.some(target => target.tabId === item.tabId)); } return value;
    });
    for (const session of sessions.reverse()) await cleanup(`detach diagnostic ${session.targetId}`, () => cdp.call("Target.detachFromTarget", { sessionId: session.sessionId }, 5000));
    if (observerTarget) await cleanup("close independent observer document", async () => { const value = await cdp.call("Target.closeTarget", { targetId: observerTarget }, 5000); assert.equal(value.success, true); return value; });
    if (cdp) await cleanup("close diagnostic Browser WebSocket", async () => { await cdp.close(); assert.equal(cdp.state(), "closed"); return { closed: true, boundary: "Runner separately records actual browser/native EOF cleanup" }; });
    if (server) await cleanup("close original fixture server", () => new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve({ closed: true })); server.closeAllConnections(); }));
    detail.server = fixture.allStats();
    ctx.signal?.removeEventListener("abort", stop);
    detail.verified = !failure && !ctx.signal?.aborted && detail.errors.length === 0 && detail.analysis?.files === 18;
    try { await ctx.save("normal-download-proof.json", detail); await ctx.checkpoint(); }
    catch (error) { detail.verified = false; detail.errors.push(error.stack ?? String(error)); failure ??= error; }
  }
  if (!detail.verified) throw Object.assign(failure ?? new Error(detail.errors.join("; ") || "Normal download proof incomplete"), { normalDownloadDetail: detail });
  return detail;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { runNormalBrowserDownloads } = await import("./normal-browser-downloads.mjs");
  const report = await runNormalBrowserDownloads({ browserBinary: process.env.OBU_TEST_CHROMIUM_BINARY, hostBinary: process.env.OBU_TEST_HOST_BINARY, onBound: checkNormalBrowserDownloadsProof });
  process.exitCode = report.exitCode;
}
