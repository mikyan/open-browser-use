import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { downloadScope } from "./download-waits-fixture.mjs";
import { readOriginalDownloadProof } from "./original-download-proof.mjs";
import { assertNegativeRelay, negativeNativeDownload } from "./original-download-negative-cases.mjs";
import { checkResponseBodyOOPIF } from "./response-body-fixture.mjs";
import { restrictedDialogPolicyControls } from "./site-access-dialog-fixture.mjs";

const text = error => error?.stack ?? String(error), json = value => JSON.stringify(value).replace(/</g, "\\u003c");
export const restrictedDownloadLayouts = ["root", "oopif", "dynamic-oopif"];

// Original Page and private Native Port evidence. The two explicitly armed
// gates hold only delivery of a real ACK; all other native Promises and replies
// are passed through. Browser raw bytes come from the separate transparent relay.
export function installRestrictedDownloadEvidence(api, target, tabId, backend) {
  if (target.__restrictedDownloadEvidence) throw Error("Restricted download observer already installed");
  const rows = [], commands = [], wire = []; let overflow = false, sequence = 0, pending = 0;
  let holdSource = false, sourceSelected = false, sourceRelease, releaseGuid, heldReply, releaseId, timer, watchdog = false;
  const copy = value => structuredClone(value), append = (list, row) => { if (rows.length + commands.length + wire.length >= 2048) { overflow = true; return; } list.push({ sequence: ++sequence, at: Date.now(), ...copy(row) }); };
  const originalSend = api.debugger.sendCommand, previousRPC = target.__integrationNativeRPCObserver;
  const client = backend?.nativePageDownloads?.(), originalReceive = client?.receive;
  const selectedRequest = message => message.method === "obu.native.pageDownloads" && message.params?.type === "request" && message.params.payload?.tabId === tabId;
  const requests = new Map();
  const observe = (direction, message) => {
    previousRPC?.(direction, message);
    if (direction === "response" && selectedRequest(message)) {
      const p = message.params; requests.set(p.requestId, copy(p)); append(wire, { kind: "native-request", message });
      if (releaseGuid && p.operation === "release" && p.payload.guid === releaseGuid && !releaseId) releaseId = p.requestId;
    } else if (direction === "request" && message.method === "obu.native.pageDownloads" && requests.has(message.params?.requestId)) append(wire, { kind: "native-reply", message });
  };
  const release = () => {
    clearTimeout(timer);
    if (sourceRelease) { const resolve = sourceRelease; sourceRelease = null; append(commands, { kind: "source-delivery-release" }); resolve(); }
    if (heldReply) { const message = heldReply; heldReply = null; append(wire, { kind: "reply-delivery-release", message }); Reflect.apply(originalReceive, client, [message]); }
  };
  const watchdogStart = () => { timer = setTimeout(() => { watchdog = true; release(); }, 25000); };
  if (originalSend) api.debugger.sendCommand = function (source, method, params) {
    if (source.tabId !== tabId || !["Page.getFrameTree", "Page.enable"].includes(method)) return Reflect.apply(originalSend, this, arguments);
    const id = sequence + 1; append(commands, { kind: "invoke", id, source, method, params });
    const selected = holdSource && !sourceSelected && method === "Page.getFrameTree";
    if (selected) { sourceSelected = true; holdSource = false; }
    let native; try { native = Reflect.apply(originalSend, this, arguments); } catch (error) { append(commands, { kind: "throw", id, error: String(error) }); throw error; }
    pending++;
    const settled = native.then(result => { append(commands, { kind: "native-fulfilled", id, result }); pending--; return result; }, error => { append(commands, { kind: "native-rejected", id, error: String(error) }); pending--; throw error; });
    settled.catch(() => {});
    if (!selected) return native;
    return settled.then(async result => { await new Promise(resolve => { sourceRelease = resolve; append(commands, { kind: "source-delivery-held", id }); watchdogStart(); }); return result; });
  };
  if (client) client.receive = function (message) {
    const p = message?.params, request = requests.get(releaseId);
    if (message?.method === "obu.native.pageDownloads" && p?.type === "reply" && p.requestId === releaseId && request && p.nonce === request.nonce && p.generation === request.generation && !heldReply && releaseGuid) {
      heldReply = message; releaseGuid = undefined; append(wire, { kind: "reply-delivery-held", message }); watchdogStart(); return true;
    }
    return Reflect.apply(originalReceive, this, arguments);
  };
  target.__integrationNativeRPCObserver = observe;
  const listener = (source, method, params) => {
    if (source.tabId !== tabId || !["Page.downloadWillBegin", "Page.downloadProgress", "Page.frameNavigated", "Page.frameDetached", "Runtime.executionContextCreated", "Runtime.executionContextDestroyed", "Runtime.executionContextsCleared"].includes(method)) return;
    append(rows, { source, method, params });
  };
  api.debugger.onEvent.addListener(listener);
  const snapshot = () => copy({ rows, commands, wire, overflow, pending, sourceSelected, sourceHeld: !!sourceRelease, replyHeld: !!heldReply, watchdog });
  target.__restrictedDownloadEvidence = { snapshot, release, holdNextSource() { if (sourceSelected || holdSource) throw Error("Source gate already selected"); holdSource = true; }, holdRelease(guid) { if (!client || releaseGuid || releaseId || typeof guid !== "string" || !guid) throw Error("Original release gate unavailable"); releaseGuid = guid; }, stop() {
    if (sourceRelease || heldReply || pending) throw Error("Original download evidence still pending");
    clearTimeout(timer); api.debugger.onEvent.removeListener(listener); if (originalSend) api.debugger.sendCommand = originalSend;
    if (client) client.receive = originalReceive;
    if (previousRPC === undefined) delete target.__integrationNativeRPCObserver; else target.__integrationNativeRPCObserver = previousRPC;
    delete target.__restrictedDownloadEvidence;
    return { ...snapshot(), restored: !api.debugger.onEvent.hasListener(listener) && (!originalSend || api.debugger.sendCommand === originalSend) && (!client || client.receive === originalReceive) && target.__integrationNativeRPCObserver === previousRPC, removed: !target.__restrictedDownloadEvidence };
  } };
}

export function readRestrictedDownloadDocument() {
  const state = document.querySelector("#state"), button = document.querySelector("#download"), add = document.querySelector("#add-frame"), frame = document.querySelector("#download-frame");
  return { href: location.href, origin: globalThis.origin, state: state?.textContent ? JSON.parse(state.textContent) : null,
    childFrame: frame ? { id: frame.id, connected: frame.isConnected, sandbox: frame.getAttribute("sandbox"), src: frame.src } : null,
    button: button ? { id: button.id, connected: button.isConnected, formConnected: button.form?.isConnected === true } : null,
    add: add ? { id: add.id, connected: add.isConnected, disabled: add.disabled } : null };
}
function liveDefaultContext(native, source, frameId, stopBefore) {
  const live = new Map(), sameRoute = row => row.source?.tabId === source.tabId && (row.source?.sessionId ?? "") === (source.sessionId ?? "");
  for (const row of native.rows) {
    if (row === stopBefore) break;
    if (!sameRoute(row)) continue;
    if (row.method === "Runtime.executionContextCreated") live.set(row.params.context.id, row);
    else if (row.method === "Runtime.executionContextDestroyed") {
      const entry = live.get(row.params.executionContextId);
      if (entry && (!row.params.executionContextUniqueId || entry.params.context.uniqueId === row.params.executionContextUniqueId)) live.delete(row.params.executionContextId);
    } else if (row.method === "Runtime.executionContextsCleared") live.clear();
  }
  const matches = [...live.values()].filter(row => row.params.context.auxData?.isDefault === true && row.params.context.auxData.frameId === frameId);
  assert.equal(matches.length, 1, "One original live default context must identify the actual download emitter");
  const row = matches[0], context = row.params.context;
  assert.ok(Number.isSafeInteger(context.id) && context.id > 0); assert.ok(typeof context.uniqueId === "string" && context.uniqueId); assert.equal(typeof context.origin, "string");
  return { source: row.source, context, sequence: row.sequence, at: row.at };
}
export function originalDownloadContext(native, begin) {
  assert.ok(native.rows.includes(begin)); return liveDefaultContext(native, begin.source, begin.params.frameId, begin);
}
async function snapshot(worker, tabId) {
  return worker.evaluate(`(async()=>({observer:globalThis.__integrationFrameObserver.snapshot(),frames:await chrome.webNavigation.getAllFrames({tabId:${tabId}}),documents:await chrome.scripting.executeScript({target:{tabId:${tabId},allFrames:true},world:'MAIN',func:${readRestrictedDownloadDocument.toString()}}),targets:await chrome.debugger.getTargets(),oopifs:globalThis.__integrationFrames.filter(row=>row.tabId===${tabId})}))()`);
}

async function typedCaller(tab, config, result) {
  Object.assign(result, { caller: "js", key: config.key, variant: config.variant, kind: "blob", tabId: config.tabId, scope: { ...config.scope }, requirePath: true });
  let wait, failure;
  try {
    const started = performance.now(); wait = await tab.expectDownload({ timeoutMs: 15000, requirePath: true });
    Object.assign(result, { waiterId: wait.waiterId, remainingMs: wait.remainingMs, readyAt: Date.now() });
    const deadline = Math.min(started + 15000, performance.now() + wait.remainingMs);
    const remaining = () => { const value = Math.floor(deadline - performance.now()); assert.ok(value > 0, "Original download wait deadline expired before further input"); return Math.min(5000, value); };
    await config.afterReady({ waiterId: wait.waiterId, remainingMs: wait.remainingMs, readyAt: result.readyAt, scope: result.scope, tabId: tab.id });
    if (config.variant === "dynamic-oopif") await tab.getByRole("button", { name: "Add download frame", exact: true }).click({ timeoutMs: remaining() });
    const target = config.variant === "root" ? tab : tab.frameLocator("#download-frame"); result.triggerAt = Date.now();
    await target.getByRole("button", { name: "Download original report", exact: true }).click({ timeoutMs: remaining() }); result.triggerCompletedAt = Date.now(); remaining();
    const download = await wait.result(); result.downloadId = download.downloadId; result.collectedAt = Date.now(); result.productPath = await download.path({ timeoutMs: 10000 });
  } catch (error) { failure = error; result.error = text(error); }
  finally { if (wait) { result.waitCleanup = { attempted: true, ok: false }; try { await wait.cancel(); result.waitCleanup.ok = true; } catch (error) { result.waitCleanup.error = text(error); failure ??= error; } } }
  if (failure) throw failure; result.ok = true; return result;
}

export function checkRestrictedDownloadEvidence(item, record) {
  const result = item.callerResult; assert.equal(record.kind, "blob"); assert.equal(record.variant, item.variant); assert.equal(record.key, item.key); assert.equal(result.key, item.key); assert.equal(result.kind, "blob"); assert.equal(result.variant, item.variant); assert.equal(result.tabId, item.tabId); assert.deepEqual(result.scope, item.scope);
  assert.equal(result.ok, true); assert.equal(result.waitCleanup.ok, true); assert.ok(result.waiterId); assert.ok(result.remainingMs > 0 && result.remainingMs <= 15000); assert.ok(result.triggerAt >= result.readyAt); assert.ok(result.collectedAt >= result.triggerAt);
  assert.deepEqual(item.ready.scope, item.scope); assert.equal(item.ready.tabId, item.tabId); assert.equal(item.ready.waiterId, result.waiterId); assert.ok(item.readyObservedAt >= result.readyAt && item.readyObservedAt <= result.triggerAt);
  assert.equal(item.nativeEvidence.overflow, false); assert.equal(item.nativeEvidence.restored, true); assert.equal(item.nativeEvidence.removed, true);
  const rootBefore = item.before.documents.find(row => row.frameId === 0), rootAfter = item.after.documents.find(row => row.frameId === 0); assert.ok(rootBefore.documentId); assert.equal(rootAfter.documentId, rootBefore.documentId); assert.equal(rootAfter.result.state.documentToken, rootBefore.result.state.documentToken);
  const documents = item.after.documents.filter(row => row.result.button); assert.equal(documents.length, 1); const original = documents[0], page = original.result.state;
  assert.equal(page.key, item.key); assert.equal(page.owner, record.owner); assert.equal(page.kind, "blob"); assert.ok(original.documentId && page.documentToken); assert.deepEqual(original.result.button, { id: "download", connected: true, formConnected: true });
  if (item.variant !== "dynamic-oopif") { const prior = item.before.documents.find(row => row.frameId === original.frameId); assert.equal(prior.documentId, original.documentId); assert.equal(prior.result.state.documentToken, page.documentToken); assert.deepEqual(prior.result.state.clicks, []); }
  assert.deepEqual(rootAfter.result.state.frameAdds, item.variant === "dynamic-oopif" ? [{ trusted: true }] : []);
  assert.equal(page.clicks.length, 1); const click = page.clicks[0]; assert.equal(click.trusted, true); assert.equal(click.buttonCount, 1); assert.equal(click.documentToken, page.documentToken); assert.equal(click.revoked, true); assert.equal(click.blobURL, page.blobURL); assert.ok(page.blobURL.startsWith("blob:")); assert.equal(new URL(page.blobURL.slice(5)).origin, new URL(original.result.href).origin);
  const begins = item.nativeEvidence.rows.filter(row => row.method === "Page.downloadWillBegin"); assert.equal(begins.length, 1); const begin = begins[0]; assert.equal(begin.params.guid, result.downloadId); assert.equal(begin.params.url, page.blobURL); assert.equal(begin.params.suggestedFilename, "report.bin"); assert.equal(begin.source.tabId, item.tabId); assert.ok(begin.at >= result.readyAt);
  if (item.variant !== "root") { item.oopifProof = checkResponseBodyOOPIF({ ...item.after, tab: { id: item.tabId } }, { tabId: item.tabId, rootURL: rootAfter.result.href, childURL: original.result.href }); assert.equal(begin.params.frameId, item.oopifProof.targetId); if (begin.source.sessionId !== undefined) assert.equal(begin.source.sessionId, item.oopifProof.sessionId); }
  else { const target = item.after.targets.find(row => row.tabId === item.tabId && row.type === "page"); assert.ok(target); assert.equal(begin.params.frameId, target.id); assert.equal(begin.source.sessionId, undefined); }
  const native = negativeNativeDownload(item.relay, result.downloadId, "completed"); assert.deepEqual(item.browserDownload, native); assert.equal(native.begin.json.params.guid, result.downloadId); assert.equal(native.begin.json.params.frameId, begin.params.frameId); assert.equal(native.begin.json.params.url, begin.params.url); assert.equal(native.terminal.json.params.state, "completed");
  const trees = item.nativeEvidence.commands.filter(row => row.kind === "native-fulfilled" && row.result?.frameTree && row.at <= begin.at), sources = [];
  const visit = (tree, at) => { if (tree.frame.id === begin.params.frameId) sources.push({ frame: tree.frame, at }); for (const child of tree.childFrames ?? []) visit(child, at); }; trees.forEach(row => visit(row.result.frameTree, row.at));
  assert.ok(sources.some(({ frame, at }) => frame.url === original.result.href && frame.loaderId && frame.securityOrigin === new URL(original.result.href).origin && (item.variant === "dynamic-oopif" || at <= result.readyAt)), "Original source native frame/loader/origin is prepared before input");
  item.sourceContext = originalDownloadContext(item.nativeEvidence, begin); assert.equal(item.sourceContext.context.origin, new URL(original.result.href).origin);
  for (const operation of ["claim", "path"]) {
    const calls = item.nativeEvidence.wire.filter(row => row.kind === "native-request" && row.message.params.operation === operation); assert.equal(calls.length, 1); const p = calls[0].message.params;
    assert.equal(p.payload.guid, result.downloadId); assert.equal(p.payload.tabId, item.tabId); assert.equal(p.payload.frameId, begin.params.frameId); for (const key of ["session_id", "turn_id", "control_epoch"]) assert.equal(p.payload[key], item.scope[key]);
    assert.equal(p.payload.rootTargetId, item.after.targets.find(row => row.tabId === item.tabId && row.type === "page").id);
    const replies = item.nativeEvidence.wire.filter(row => row.kind === "native-reply" && row.message.params.requestId === p.requestId); assert.equal(replies.length, 1); assert.equal(replies[0].message.params.nonce, p.nonce); assert.equal(replies[0].message.params.generation, p.generation); assert.equal(replies[0].message.params.error, undefined); assert.deepEqual(replies[0].message.params.result, operation === "path" ? { path: result.productPath } : {});
  }
  assert.equal(item.relay.records.filter(row => row.direction === "upstream->downstream" && row.json.method === "Browser.downloadWillBegin" && row.json.params.frameId === begin.params.frameId).length, 1, "Original document emits only its one download");
  assert.equal(path.normalize(native.terminal.json.params.filePath), path.normalize(result.productPath)); assert.equal(item.file.path, result.productPath); assert.equal(item.file.base64, record.expected.base64); assert.equal(item.file.sha256, record.expected.sha256); assert.equal(item.file.bytes, record.expected.bytes); assert.equal(item.file.analysis.key, record.key); assert.equal(item.file.analysis.nonce, record.nonce); assert.equal(item.file.analysis.owner, record.owner);
  if (result.file) for (const field of ["bytes", "sha256", "base64", "analysis"]) assert.deepEqual(result.file[field], item.file[field]);
  const terminal = item.notifications.filter(row => row.id === result.downloadId && row.status === "complete"); assert.ok(terminal.length >= 1);
  for (const event of item.notifications) { assert.equal(event.id, result.downloadId); assert.equal(event.tabId, item.tabId); for (const key of ["session_id", "turn_id", "control_epoch"]) assert.equal(event[key], item.scope[key]); }
  assert.equal(record.requests.filter(row => row.method !== "GET").length, 0, "Blob workflow issues no POST or refetch"); assert.equal(record.requests.length, item.variant === "root" ? 1 : 2);
  for (const request of record.requests) { assert.equal(request.status, 200); assert.equal(request.finished, true); assert.ok(request.url === record.urlPath || request.url === `/original-download/frame?key=${record.key}`); }
  return { guid: result.downloadId, documentId: original.documentId, bytes: item.file.bytes, sha256: item.file.sha256, files: 1, trustedClicks: 1, revokedBlob: true, reportRequests: 0 };
}

export async function checkRestrictedDownloadCaller({ kind, browser, getWorker, fixture, fixtureURL, downloadRoot, relay, until, caller, detail = {} }) {
  Object.assign(detail, { caller: kind, variants: [], boundary: "The original trusted button creates one Blob, clicks its own link and immediately revokes the URL. Paths are returned by the public product and joined to the original GUID, never inferred from a filename/directory change. This is isolated bound-browser acceptance, not ordinary-browser approval." }); let failure;
  for (const variant of restrictedDownloadLayouts) {
    const record = fixture.createCase({ kind: "blob", owner: `restricted-download-${kind}-${variant}`, variant }), tab = await browser.newTab(), item = { key: record.key, variant, tabId: tab.id, scope: downloadScope(browser), callerResult: {}, notifications: [] }; detail.variants.push(item); let installed = false;
    const unsubscribe = browser.client.onNotification(event => { if (event.method === "onDownloadChange" && event.params.tabId === item.tabId) item.notifications.push(structuredClone(event.params)); });
    try {
      await getWorker().evaluate(`(${installRestrictedDownloadEvidence.toString()})(chrome,globalThis,${tab.id},globalThis.__integrationBackend)`); installed = true; await tab.goto(new URL(record.urlPath, fixtureURL).href);
      await until(async () => { const value = await snapshot(getWorker(), tab.id); return value.documents.length === (variant === "oopif" ? 2 : 1) && value.documents.every(row => row.result?.state?.documentToken) ? (item.before = value) : false; }, "original restricted download documents");
      const config = { key: item.key, variant, kind: "blob", tabId: item.tabId, scope: { ...item.scope }, afterReady: async ack => { assert.deepEqual(ack.scope, item.scope); assert.equal(ack.tabId, item.tabId); assert.ok(ack.waiterId && ack.remainingMs > 0 && ack.remainingMs <= 15000); item.ready = structuredClone(ack); item.readyObservedAt = Date.now(); } };
      item.callerResult = caller ? await caller(config, item) : await typedCaller(tab, config, item.callerResult);
      await until(() => item.notifications.some(row => row.id === item.callerResult.downloadId && row.status === "complete"), "original scoped download completion");
      item.relay = relay.snapshot(); item.browserDownload = negativeNativeDownload(item.relay, item.callerResult.downloadId, "completed");
      item.file = await readOriginalDownloadProof(downloadRoot, item.callerResult.productPath, record.expected);
    } catch (error) { failure = error; item.error = text(error); if (error.originalDownloadCallerDetail) item.callerResult = error.originalDownloadCallerDetail; }
    finally {
      unsubscribe(); if (installed) try { item.nativeEvidence = await getWorker().evaluate("globalThis.__restrictedDownloadEvidence.stop()"); } catch (error) { item.nativeEvidenceError = text(error); failure ??= error; }
      try { item.after = await snapshot(getWorker(), tab.id); } catch (error) { item.afterError = text(error); failure ??= error; }
      try { item.server = fixture.stats(item.key); item.relay ??= relay.snapshot(); } catch (error) { item.serverError = text(error); failure ??= error; }
    }
    if (!failure) try { item.proof = checkRestrictedDownloadEvidence(item, item.server); item.passed = true; } catch (error) { failure = error; item.error = text(error); }
    if (failure) break;
  }
  detail.serverLedger = fixture.allStats(); if (failure) { detail.error = text(failure); throw failure; } return detail;
}

export async function checkRestrictedDownloadPolicy({ popup, fixtureURL, until, runAllowed, runBoundaries, saveDetail }) {
  assert.ok(popup, "Restricted downloads borrow the original settings popup"); const controls = restrictedDialogPolicyControls({ popup, until }), detail = { popupOwnership: "borrowed" }; let failure;
  try { detail.originalPolicy = await controls.read(); detail.origins = [new URL(fixtureURL).origin, new URL(fixtureURL).origin.replace("127.0.0.1", "localhost")].sort(); detail.allowed = await controls.apply("allow", detail.origins); detail.allowed.resume = await controls.resume(); if (runAllowed) await runAllowed(detail.allowed.policy); if (runBoundaries) await runBoundaries(controls, detail.allowed.policy); }
  catch (error) { failure = error; }
  finally { if (detail.originalPolicy) try { detail.restored = await controls.apply(detail.originalPolicy.mode, detail.originalPolicy.origins); detail.restored.resume = await controls.resume(); } catch (error) { detail.restoreError = text(error); failure ??= error; } if (failure) detail.error = text(failure); try { await saveDetail(detail); } catch (error) { failure ??= error; } }
  if (failure) throw failure; return detail;
}

const sourceDenied = /OBU_SITE_ACCESS_(?:DENIED|UNVERIFIED)/;
const controlDenied = /OBU_STALE_CONTROL_EPOCH|OBU_CONTROL_BOOTSTRAP_REQUIRED|OBU_AUTOMATION_PAUSED/;
const retired = /OBU_DOWNLOAD_WAIT_EXPIRED|OBU_DOWNLOAD_EXPIRED|OBU_TRANSFER_CANCELLED|OBU_SITE_ACCESS_(?:DENIED|UNVERIFIED)/;
const noDownloadTimeout = /^OBU_DOWNLOAD_WAIT_TIMEOUT: OBU_TRANSFER_TIMEOUT: original download wait deadline expired$/;
const revokedHTTPClick = "OBU_SITE_ACCESS_DENIED: document access was revoked during the browser action";
const rejectionPattern = authority => authority === "control" ? controlDenied : authority === "source" ? sourceDenied : authority === "browser-no-event" ? noDownloadTimeout : retired;
const outcome = promise => promise.then(value => ({ ok: true, value }), error => ({ ok: false, error: String(error?.message ?? error) }));
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const privateRequests = item => item.nativeEvidence.wire.filter(row => row.kind === "native-request").map(row => row.message.params);

export function checkHTTPDownloadOutcomes(item) {
  assert.ok(item.clickOutcome?.ok === true || item.clickOutcome?.ok === false);
  if (!item.clickOutcome.ok) assert.equal(item.clickOutcome.error, revokedHTTPClick);
  assert.equal(item.collectionOutcome?.ok, false); assert.equal(Object.hasOwn(item.collectionOutcome, "value"), false);
  assert.match(item.collectionOutcome.error, /^OBU_SITE_ACCESS_(?:DENIED|UNVERIFIED):/);
  assert.equal(item.rejections.length, 1); assert.deepEqual(item.rejections[0], { name: "unproven-source-collect", authority: "source", ...item.collectionOutcome });
}

export async function collectRejectedDownloadSource({ wait, click, reject, pending, authority = "source", onSettled, evidence, allowRevokedHTTPClick = false }) {
  // Subscribe to the original terminal result before input: a failed registry
  // record can retire before the public click's completion reaches this caller.
  const publicValue = value => value?.downloadId ? { downloadId: value.downloadId } : value;
  const collected = outcome(wait.result()).then(value => {
    onSettled?.(); if (evidence) evidence.collectionOutcome = value.ok ? { ok: true, value: publicValue(value.value) } : { ...value }; return value;
  }); pending.push(collected);
  let clickFailure;
  try { await click(); if (evidence) evidence.clickOutcome = { ok: true }; }
  catch (error) { clickFailure = error; if (evidence) evidence.clickOutcome = { ok: false, error: String(error?.message ?? error) }; }
  if (clickFailure && !(allowRevokedHTTPClick && clickFailure.message === revokedHTTPClick)) {
    await collected; throw clickFailure;
  }
  await reject(authority === "browser-no-event" ? "browser-no-download-collect" : "unproven-source-collect", collected.then(value => {
    if (!value.ok) throw Error(value.error);
    // A real old-source acceptance is evidence too; retain its public ID without
    // serializing the SDK connection object or issuing an additional path read.
    return publicValue(value.value);
  }), authority);
}

async function downloadInventory(root) {
  const entries = await fs.readdir(root, { withFileTypes: true }); assert.ok(entries.length <= 256);
  return Promise.all(entries.sort((a, b) => a.name.localeCompare(b.name)).map(async entry => {
    assert.ok(entry.isFile() && !entry.isSymbolicLink(), "Isolated download inventory must contain only regular files");
    const value = await fs.lstat(path.join(root, entry.name), { bigint: true });
    return { name: entry.name, dev: String(value.dev), ino: String(value.ino), size: String(value.size), mtimeNs: String(value.mtimeNs) };
  }));
}

function checkSharedOpaqueNoDownload(item) {
  const native = item.nativeEvidence, record = item.server, before = item.before.documents, after = item.after.documents;
  assert.equal(item.classification, "browser-blocked-before-download"); assert.equal(record.sharedBlob, true); assert.equal(record.opaque, true); assert.equal(record.kind, "blob");
  assert.equal(native.overflow, false); assert.equal(native.pending, 0); assert.equal(native.restored, true); assert.equal(native.removed, true); assert.equal(native.watchdog, false); assert.equal(native.sourceHeld, false); assert.equal(native.replyHeld, false);
  assert.equal(before.length, 2); assert.equal(after.length, 2); const root = after.find(row => row.frameId === 0), child = after.find(row => row.frameId !== 0), oldRoot = before.find(row => row.frameId === 0), oldChild = before.find(row => row.frameId === child.frameId);
  assert.ok(root && child && oldRoot && oldChild);
  for (const [current, previous] of [[root, oldRoot], [child, oldChild]]) {
    assert.ok(current.documentId); assert.equal(current.documentId, previous.documentId); assert.equal(current.result.href, previous.result.href); assert.equal(current.result.state.documentToken, previous.result.state.documentToken); assert.equal(current.result.state.key, item.key); assert.equal(previous.result.state.key, item.key);
    assert.deepEqual(previous.result.state.clicks, []); assert.deepEqual(current.result.state.frameAdds, []);
  }
  assert.deepEqual(root.result.state.clicks, []); assert.equal(child.result.origin, "null"); assert.equal(oldChild.result.origin, "null");
  assert.deepEqual(child.result.button, { id: "download", connected: true, formConnected: true });
  const shared = { url: child.result.state.blobURL, creatorOrigin: new URL(root.result.href).origin, creatorDocumentToken: root.result.state.documentToken, childDocumentToken: child.result.state.documentToken, revoked: true };
  assert.equal(root.result.origin, shared.creatorOrigin); assert.equal(oldRoot.result.origin, shared.creatorOrigin); assert.equal(new URL(shared.url).protocol, "blob:"); assert.equal(new URL(shared.url).origin, shared.creatorOrigin);
  for (const row of [root, child]) assert.deepEqual(row.result.state.sharedBlob, shared);
  for (const row of [oldRoot, oldChild]) assert.deepEqual(row.result.state.sharedBlob, { ...shared, revoked: false });
  assert.deepEqual(child.result.state.clicks, [{ trusted: true, buttonCount: 1, documentToken: shared.childDocumentToken, blobURL: shared.url, revocation: "parent-message-ack", revoked: true }]);
  const iframe = { id: "download-frame", connected: true, sandbox: "allow-scripts allow-downloads", src: child.result.href }; assert.deepEqual(root.result.childFrame, iframe); assert.deepEqual(oldRoot.result.childFrame, iframe);
  const rootTarget = item.before.targets.find(row => row.tabId === item.tabId && row.type === "page"); assert.ok(rootTarget);
  const commits = native.rows.filter(row => row.method === "Page.frameNavigated" && row.params.frame.url === child.result.href && row.params.frame.parentId === rootTarget.id); assert.equal(commits.length, 1); const commit = commits[0], frame = commit.params.frame;
  assert.ok(frame.loaderId && commit.at <= item.readyAt); assert.equal(frame.securityOrigin, shared.creatorOrigin);
  const childFrame = item.after.frames.find(row => row.documentId === child.documentId); assert.ok(childFrame); assert.equal(childFrame.parentDocumentId, root.documentId); assert.equal(childFrame.parentFrameId, 0); assert.equal(childFrame.url, child.result.href); assert.equal(childFrame.documentLifecycle, "active"); assert.equal(childFrame.errorOccurred, false);
  const prepared = [], visit = tree => { if (tree.frame.id === frame.id) prepared.push(tree.frame); for (const nested of tree.childFrames ?? []) visit(nested); };
  native.commands.filter(row => row.kind === "native-fulfilled" && row.at <= item.readyAt && row.result?.frameTree).forEach(row => visit(row.result.frameTree));
  assert.ok(prepared.some(value => value.loaderId === frame.loaderId && value.url === child.result.href && value.securityOrigin === shared.creatorOrigin));
  item.sourceContext = liveDefaultContext(native, commit.source, frame.id); assert.ok(item.sourceContext.at <= item.readyAt); assert.ok(["", "://", "null"].includes(item.sourceContext.context.origin));
  item.opaqueSource = { documentId: child.documentId, origin: child.result.origin, frameId: frame.id, loaderId: frame.loaderId, nativeSecurityOrigin: frame.securityOrigin };
  assert.equal(item.requestedTimeoutMs, 15000); assert.ok(item.readyAt >= item.armStartedAt); assert.ok(item.remainingMs > 0 && item.remainingMs <= 15000); assert.ok(item.collectionSettledAt >= item.armStartedAt + 15000); assert.ok(item.collectionSettledAt >= item.readyAt);
  assert.equal(item.rejections.length, 1); assert.equal(item.rejections[0].name, "browser-no-download-collect"); assert.equal(item.rejections[0].authority, "browser-no-event"); assert.equal(item.rejections[0].ok, false); assert.equal(Object.hasOwn(item.rejections[0], "value"), false); assert.match(item.rejections[0].error, noDownloadTimeout); assert.equal(item.cancelled, true);
  assert.deepEqual(native.rows.filter(row => ["Page.downloadWillBegin", "Page.downloadProgress"].includes(row.method)), []); assert.deepEqual(native.wire, []); assert.deepEqual(item.notifications, []);
  assert.deepEqual(assertNegativeRelay(item.relay).filter(row => row.json.method === "Browser.downloadWillBegin" && (row.json.params.frameId === frame.id || row.json.params.url === shared.url)), []);
  for (const key of ["downloadId", "productPath", "file", "browserDownload"]) assert.equal(Object.hasOwn(item, key), false);
  assert.ok(Array.isArray(item.downloadFilesBefore)); assert.deepEqual(item.downloadFilesAfter, item.downloadFilesBefore);
  assert.deepEqual(record.requests.map(row => row.url).sort(), [record.urlPath, `/original-download/frame?key=${item.key}`].sort()); for (const request of record.requests) { assert.equal(request.method, "GET"); assert.equal(request.status, 200); assert.equal(request.finished, true); }
  return { downloads: 0, posts: 0, bytes: 0, delivered: 0, classification: item.classification };
}

export function checkRestrictedDownloadBoundaryEvidence(item) {
  if (item.name === "shared-opaque-no-native-download") return checkSharedOpaqueNoDownload(item);
  const native = item.nativeEvidence, record = item.server, before = item.before.documents.find(row => row.frameId === 0), after = item.after.documents.find(row => row.frameId === 0);
  assert.equal(native.overflow, false); assert.equal(native.pending, 0); assert.equal(native.sourceHeld, false); assert.equal(native.replyHeld, false); assert.equal(native.watchdog, false); assert.equal(native.restored, true); assert.equal(native.removed, true);
  assert.ok(before.documentId && after.documentId); assert.equal(before.result.href, after.result.href); assert.equal(before.result.state.key, item.key); assert.equal(after.result.state.key, item.key);
  const navigated = ["admitted-navigation", "source-ack-navigation"].includes(item.name), triggered = !["explicit-cancel", "mixed-denied-child", "future-denied-child"].includes(item.name);
  if (navigated) { assert.notEqual(before.documentId, after.documentId); assert.notEqual(before.result.state.documentToken, after.result.state.documentToken); assert.deepEqual(after.result.state.clicks, []); }
  else { assert.equal(before.documentId, after.documentId); assert.equal(before.result.state.documentToken, after.result.state.documentToken); }
  for (const row of item.before.documents) assert.deepEqual(row.result.state.clicks, []);
  const witness = navigated ? item.beforeNavigation : item.after, originals = witness.documents.filter(row => row.result.button);
  if (triggered) {
    assert.equal(originals.length, 1); const original = originals[0], state = original.result.state, prior = item.before.documents.find(row => row.frameId === original.frameId);
    assert.equal(original.documentId, prior.documentId); assert.equal(state.documentToken, prior.result.state.documentToken); assert.deepEqual(original.result.button, { id: "download", connected: true, formConnected: true }); assert.equal(state.clicks.length, 1);
    const click = state.clicks[0]; assert.equal(click.trusted, true); assert.equal(click.buttonCount, 1); assert.equal(click.documentToken, state.documentToken);
    if (record.kind === "blob") { assert.equal(click.revoked, true); assert.equal(click.blobURL, state.blobURL); }
  } else for (const row of item.after.documents) assert.deepEqual(row.result.state.clicks, []);
  assert.deepEqual(after.result.state.frameAdds, item.name === "future-denied-child" ? [{ trusted: true }] : []);
  const begins = native.rows.filter(row => row.method === "Page.downloadWillBegin"); assert.equal(begins.length, triggered ? 1 : 0);
  const rootFrame = item.before.targets.find(row => row.type === "page" && row.tabId === item.tabId)?.id; assert.ok(rootFrame);
  const requests = privateRequests(item);
  if (!triggered) { assert.deepEqual(requests, []); assert.deepEqual(item.notifications, []); }
  if (triggered) {
    const begin = begins[0], original = originals[0], expectedURL = record.kind === "blob" ? original.result.state.blobURL : new URL(record.reportPath, original.result.href).href;
    assert.equal(begin.source.tabId, item.tabId); assert.equal(begin.params.url, expectedURL); assert.equal(begin.params.suggestedFilename, "report.bin"); assert.ok(begin.at >= item.readyAt);
    if (item.variant === "root") assert.equal(begin.params.frameId, rootFrame);
    else { const proof = checkResponseBodyOOPIF({ ...witness, tab: { id: item.tabId } }, { tabId: item.tabId, rootURL: witness.documents.find(row => row.frameId === 0).result.href, childURL: original.result.href }); assert.equal(begin.params.frameId, proof.targetId); item.oopifProof = proof; }
    const actual = negativeNativeDownload(item.relay, begin.params.guid, "completed"); assert.deepEqual(item.browserDownload, actual); assert.equal(actual.begin.json.params.url, expectedURL); assert.equal(actual.begin.json.params.frameId, begin.params.frameId);
    assert.equal(item.file.path, actual.terminal.json.params.filePath); for (const key of ["bytes", "sha256", "base64"]) assert.equal(item.file[key], record.expected[key]); assert.equal(item.file.analysis.key, record.key); assert.equal(item.file.analysis.nonce, record.nonce);
    if (item.downloadId) { assert.equal(item.downloadId, begin.params.guid); assert.equal(item.productPath, item.file.path); }
    else { assert.equal(item.productPath, undefined); assert.equal(requests.filter(row => row.operation === "claim").length, 0, "Denied original source must never be privately claimed"); assert.deepEqual(item.notifications, []); }
  }
  for (const rejection of item.rejections) { assert.equal(rejection.ok, false); assert.equal(Object.hasOwn(rejection, "value"), false); assert.notEqual(rejection.authority, "browser-no-event"); assert.match(rejection.error, rejectionPattern(rejection.authority)); }
  const posts = record.requests.filter(row => row.method === "POST"); assert.equal(posts.length, record.kind === "post" ? 1 : 0);
  const gets = record.requests.filter(row => row.method === "GET"); assert.equal(gets.length, (item.variant === "root" ? 1 : 2) + (navigated ? 1 : 0)); assert.equal(record.requests.length, gets.length + posts.length);
  for (const get of gets) { assert.equal(get.status, 200); assert.equal(get.finished, true); assert.ok(get.url === record.urlPath || get.url === `/original-download/frame?key=${record.key}`); }
  if (posts.length) {
    const post = posts[0], original = originals[0]; assert.equal(post.url, record.reportPath); assert.equal(post.status, 200); assert.equal(post.finished, true); assert.equal(record.consumed, true);
    const expected = new URLSearchParams({ owner: record.owner, token: record.token, documentToken: original.result.state.documentToken, trusted: "true", buttonCount: "1" }).toString(), bytes = Buffer.from(post.body.base64, "base64");
    assert.equal(bytes.toString(), expected); assert.equal(post.body.bytes, bytes.length); assert.equal(post.body.sha256, sha(bytes)); for (const key of ["bytes", "sha256", "base64"]) assert.equal(post.response[key], record.expected[key]);
  }
  if (item.name === "http-post-unproven") checkHTTPDownloadOutcomes(item);
  if (item.name === "opaque-source") {
    assert.equal(record.opaque, true); const original = originals[0], prior = item.before.documents.find(row => row.documentId === original.documentId); assert.equal(prior.result.origin, "null"); assert.equal(original.result.origin, "null");
    const frame = { id: "download-frame", connected: true, sandbox: "allow-scripts allow-downloads", src: original.result.href }; assert.deepEqual(before.result.childFrame, frame); assert.deepEqual(after.result.childFrame, frame);
    const sources = [], visit = (tree, at) => { if (tree.frame.id === begins[0].params.frameId && tree.frame.url === original.result.href && tree.frame.loaderId) sources.push({ frame: tree.frame, at }); for (const child of tree.childFrames ?? []) visit(child, at); };
    native.commands.filter(row => row.kind === "native-fulfilled" && row.result?.frameTree).forEach(row => visit(row.result.frameTree, row.at));
    const prepared = sources.find(row => row.at <= item.readyAt), inspected = sources.find(row => row.at >= begins[0].at); assert.ok(prepared && inspected, "Committed original source must be present at preparation and inspection");
    assert.equal(prepared.frame.loaderId, inspected.frame.loaderId); assert.equal(prepared.frame.securityOrigin, inspected.frame.securityOrigin); assert.equal(typeof inspected.frame.securityOrigin, "string");
    assert.ok(native.rows.some(row => row.method === "Page.frameNavigated" && row.at <= item.readyAt && row.params.frame.id === begins[0].params.frameId && row.params.frame.url === original.result.href && row.params.frame.loaderId === inspected.frame.loaderId));
    // Page's origin is derived from the loader URL even for a sandboxed origin.
    // Preserve it separately from the original default context and MAIN origin.
    item.opaqueSource = { documentId: original.documentId, origin: original.result.origin, frameId: inspected.frame.id, loaderId: inspected.frame.loaderId, nativeSecurityOrigin: inspected.frame.securityOrigin };
    item.sourceContext = originalDownloadContext(native, begins[0]); assert.ok(["", "://", "null"].includes(item.sourceContext.context.origin), "Actual original default context must have an opaque origin");
    assert.equal(record.sharedBlob, undefined); assert.match(original.result.state.blobURL, /^blob:null\//);
  }
  if (item.name === "source-ack-navigation") {
    const hold = native.commands.find(row => row.kind === "source-delivery-held"), ack = native.commands.find(row => row.kind === "native-fulfilled" && row.id === hold?.id), release = native.commands.find(row => row.kind === "source-delivery-release");
    assert.ok(hold && ack && release && ack.sequence < hold.sequence && hold.sequence < release.sequence); assert.ok(item.navigationCompletedAt <= release.at); assert.equal(ack.result.frameTree.frame.id, rootFrame); assert.equal(ack.result.frameTree.frame.url, before.result.href);
    assert.ok(native.rows.some(row => row.method === "Page.frameNavigated" && row.params.frame.id === rootFrame && row.params.frame.loaderId !== ack.result.frameTree.frame.loaderId));
    assert.equal(item.rejections.length, 1); assert.equal(item.rejections[0].name, "replaced-source-collect");
  }
  if (item.name === "admitted-navigation") { assert.equal(item.pathAfterNavigation, item.productPath); assert.deepEqual(item.rejections, []); }
  if (item.name === "late-release-policy") {
    assert.equal(item.failedApply.ok, false); assert.match(item.failedApply.error, /Timed out waiting for restricted dialog policy saved|OBU_AUTOMATION_(?:PAUSE_FAILED|CLEANUP_TIMEOUT)/);
    assert.equal(item.cleanupTimeoutMs, 10000); assert.ok(item.pauseFailedAt - item.applyStartedAt >= 10000); assert.equal(item.blocked.state, "error"); assert.equal(item.blocked.inputBlocked, true); assert.equal(item.blocked.cleanupComplete, false); assert.match(item.blocked.error, /OBU_AUTOMATION_PAUSE_FAILED/); assert.match(item.blocked.error, /OBU_AUTOMATION_CLEANUP_TIMEOUT/);
    assert.equal(item.heldAfterFailed.replyHeld, true); assert.equal(item.heldAfterFailed.watchdog, false); assert.deepEqual(item.policyAfterFailed, item.policyBeforeHold); assert.deepEqual(item.durableAfterFailed, item.durableBeforeHold);
    const request = requests.filter(row => row.operation === "release" && row.payload.guid === item.downloadId); assert.equal(request.length, 1); const p = request[0];
    const selected = native.wire.filter(row => ["native-reply", "reply-delivery-held", "reply-delivery-release"].includes(row.kind) && row.message.params.requestId === p.requestId); assert.deepEqual(selected.map(row => row.kind), ["native-reply", "reply-delivery-held", "reply-delivery-release"]);
    for (const row of selected) { assert.equal(row.message.params.nonce, p.nonce); assert.equal(row.message.params.generation, p.generation); assert.deepEqual(row.message.params.result, {}); assert.equal(row.message.params.error, undefined); }
    assert.deepEqual(selected[0].message, selected[2].message); assert.ok(selected[2].at >= item.pauseFailedAt); assert.deepEqual(item.operationsAfterRelease, { operations: 0, resources: 0 }); assert.equal(item.policyChanged.policy.revision, item.policyBeforeHold.revision + 1);
  }
  if (item.newScope) { assert.equal(item.newScope.session_id, item.scope.session_id); assert.ok(item.newScope.turn_id && item.newScope.turn_id !== item.scope.turn_id); assert.ok(Number.isSafeInteger(item.newScope.control_epoch) && item.newScope.control_epoch > item.scope.control_epoch); assert.equal(item.resume.state, "running"); }
  if (["explicit-cancel", "source-ack-navigation", "http-post-unproven", "opaque-source", "future-denied-child"].includes(item.name)) assert.equal(item.cancelled, true);
  return { downloads: begins.length, posts: posts.length, bytes: item.file?.bytes ?? 0, delivered: item.downloadId ? 1 : 0 };
}

export async function checkRestrictedDownloadBoundaries({ connectBrowser, getWorker, fixture, fixtureURL, downloadRoot, relay, controls, until, saveDetail }) {
  const browser = await connectBrowser("restricted-download-boundaries"), detail = { tabIds: [], cases: [], executionOrder: [], boundary: "Private native and file evidence is retained even when the public caller is denied. Neither timeout nor cancellation proves that an already completed file was removed." }; let failure;
  const create = async (name, options = {}) => { const record = fixture.createCase({ kind: "blob", owner: `restricted-download-${name}`, ...options }), tab = await browser.newTab(), item = { name, key: record.key, kind: record.kind, variant: record.variant, tabId: tab.id, url: new URL(record.urlPath, fixtureURL).href, rejections: [], notifications: [] }; detail.tabIds.push(tab.id); detail.cases.push(item); return { item, tab, record }; };
  const ready = async ({ item, tab, record }) => { await tab.goto(item.url); await until(async () => { const value = await snapshot(getWorker(), item.tabId); return value.documents.length === (item.variant === "oopif" ? 2 : 1) && value.documents.every(row => row.result?.state?.documentToken && (!record.sharedBlob || row.result.state.sharedBlob)) ? (item.before = value) : false; }, "original boundary download document"); };
  const run = async (context, action) => {
    const { item, tab, record } = context; detail.executionOrder.push(item.name); let first, installed = false, wait; const pending = [];
    const unsubscribe = browser.client.onNotification(event => { if (event.method === "onDownloadChange" && event.params.tabId === tab.id) item.notifications.push(structuredClone(event.params)); });
    const reject = async (name, promise, authority) => { const result = await outcome(promise); item.rejections.push({ name, authority, ...result }); assert.equal(result.ok, false, `${name} unexpectedly succeeded`); assert.match(result.error, rejectionPattern(authority)); };
    const arm = async () => { item.armStartedAt = Date.now(); item.requestedTimeoutMs = 15000; wait = await tab.expectDownload({ timeoutMs: 15000, requirePath: true }); item.readyAt = Date.now(); item.waiterId = wait.waiterId; item.remainingMs = wait.remainingMs; return wait; };
    const click = () => (item.variant === "root" ? tab : tab.frameLocator("#download-frame")).getByRole("button", { name: "Download original report", exact: true }).click({ timeoutMs: 5000 });
    const collect = async () => { await arm(); await click(); const download = await wait.result(); item.downloadId = download.downloadId; item.productPath = await download.path({ timeoutMs: 10000 }); return download; };
    try { item.scope = downloadScope(browser); await getWorker().evaluate(`(${installRestrictedDownloadEvidence.toString()})(chrome,globalThis,${tab.id},globalThis.__integrationBackend)`); installed = true; if (!item.before) await ready(context); await action({ item, tab, arm, click, collect, reject, pending, cancel: async () => { item.cancelResult = await wait.cancel(); item.cancelled = true; } }); }
    catch (error) { first = error; item.error = text(error); }
    finally {
      if (installed) try { await getWorker().evaluate("globalThis.__restrictedDownloadEvidence.release()"); await Promise.all(pending); await until(() => getWorker().evaluate("globalThis.__restrictedDownloadEvidence.snapshot().pending===0"), "original download native operations settle"); item.nativeEvidence = await getWorker().evaluate("globalThis.__restrictedDownloadEvidence.stop()"); } catch (error) { item.nativeEvidenceError = text(error); first ??= error; }
      unsubscribe();
      try { item.after = await snapshot(getWorker(), tab.id); } catch (error) { item.afterError = text(error); first ??= error; }
      if (record.sharedBlob) try { item.downloadFilesAfter = await downloadInventory(downloadRoot); } catch (error) { item.downloadInventoryError = text(error); first ??= error; }
      try {
        item.server = fixture.stats(item.key); item.relay = relay.snapshot(); const begins = item.nativeEvidence?.rows.filter(row => row.method === "Page.downloadWillBegin") ?? [];
        if (begins.length === 1) { await until(() => relay.snapshot().records.some(row => row.json.method === "Browser.downloadProgress" && row.json.params.guid === begins[0].params.guid && row.json.params.state === "completed"), "original boundary native download completion"); item.relay = relay.snapshot(); item.browserDownload = negativeNativeDownload(item.relay, begins[0].params.guid, "completed"); item.file = await readOriginalDownloadProof(downloadRoot, item.browserDownload.terminal.json.params.filePath, record.expected); }
      } catch (error) { item.evidenceError = text(error); first ??= error; }
    }
    if (!first) try { item.proof = checkRestrictedDownloadBoundaryEvidence(item); item.passed = true; } catch (error) { first = error; item.error = text(error); }
    if (first) throw first;
  };
  try {
    await run(await create("explicit-cancel"), async ({ arm, cancel }) => { await arm(); await cancel(); });
    await run(await create("admitted-navigation"), async ({ item, tab, collect }) => { const download = await collect(); item.beforeNavigation = await snapshot(getWorker(), tab.id); await tab.goto(item.url); item.pathAfterNavigation = await download.path({ timeoutMs: 10000 }); assert.equal(item.pathAfterNavigation, item.productPath); });
    await run(await create("source-ack-navigation"), async ({ item, tab, arm, click, reject, pending, cancel }) => {
      const wait = await arm(); await getWorker().evaluate("globalThis.__restrictedDownloadEvidence.holdNextSource()"); const collected = outcome(wait.result()); pending.push(collected); await click();
      await until(() => getWorker().evaluate("globalThis.__restrictedDownloadEvidence.snapshot().sourceHeld"), "original source frame tree ACK held"); item.beforeNavigation = await snapshot(getWorker(), tab.id); await tab.goto(item.url); item.navigationCompletedAt = Date.now(); await getWorker().evaluate("globalThis.__restrictedDownloadEvidence.release()");
      await reject("replaced-source-collect", collected.then(value => { if (!value.ok) throw Error(value.error); return value.value; }), "retired"); await cancel();
    });
    for (const [name, options] of [["opaque-source", { variant: "oopif", opaque: true }], ["shared-opaque-no-native-download", { variant: "oopif", opaque: true, sharedBlob: true }], ["http-post-unproven", { kind: "post" }]]) await run(await create(name, options), async ({ item, arm, click, reject, pending, cancel }) => {
      if (options.sharedBlob) { item.classification = "browser-blocked-before-download"; item.downloadFilesBefore = await downloadInventory(downloadRoot); }
      const wait = await arm(); await collectRejectedDownloadSource({ wait, click, reject, pending, evidence: item, allowRevokedHTTPClick: name === "http-post-unproven", ...(options.sharedBlob ? { authority: "browser-no-event", onSettled: () => { item.collectionSettledAt = Date.now(); } } : {}) }); await cancel();
      if (options.sharedBlob) await until(async () => (await snapshot(getWorker(), item.tabId)).documents.every(row => row.result.state.sharedBlob?.revoked === true), "original creator revocation acknowledged by the child");
    });
    await run(await create("late-release-policy"), async ({ item, collect, reject, pending }) => {
      const download = await collect(); item.policyBeforeHold = await controls.read(); item.durableBeforeHold = await getWorker().evaluate("chrome.storage.local.get(['OPEN_BROWSER_USE_SITE_ACCESS_POLICY'])"); item.cleanupTimeoutMs = await getWorker().evaluate("globalThis.__integrationBackend.automationCleanupTimeoutMs"); assert.equal(item.cleanupTimeoutMs, 10000);
      await getWorker().evaluate(`globalThis.__restrictedDownloadEvidence.holdRelease(${json(item.downloadId)})`); item.applyStartedAt = Date.now(); const apply = outcome(controls.apply("allow", item.policyBeforeHold.origins)); pending.push(apply); item.failedApply = await apply; item.failedApplyObservation = "Trusted popup saved-status observation, not an original backend reply"; assert.equal(item.failedApply.ok, false, "Apply must not finish while the original release ACK is undelivered");
      await until(async () => { const status = await getWorker().evaluate("globalThis.__integrationBackend.automationControl.status()"); return status.state === "error" && status.inputBlocked && !status.cleanupComplete ? (item.blocked = status) : false; }, "original cleanup budget fails Pause"); item.pauseFailedAt = Date.now(); item.heldAfterFailed = await getWorker().evaluate("globalThis.__restrictedDownloadEvidence.snapshot()"); item.policyAfterFailed = await controls.read(); item.durableAfterFailed = await getWorker().evaluate("chrome.storage.local.get(['OPEN_BROWSER_USE_SITE_ACCESS_POLICY'])");
      await reject("old-policy-path", download.path({ timeoutMs: 1000 }), "control"); await getWorker().evaluate("globalThis.__restrictedDownloadEvidence.release()");
      await until(async () => { const state = await getWorker().evaluate("({operations:globalThis.__integrationBackend.pageDownloadOperations.size,resources:globalThis.__integrationBackend.pageDownloadResources.size})"); return state.operations === 0 && state.resources === 0 ? (item.operationsAfterRelease = state) : false; }, "original release actually settles");
      item.policyChanged = await controls.apply("allow", item.policyBeforeHold.origins); item.resume = await controls.resume(); await browser.client.beginTurn(); item.newScope = downloadScope(browser);
    });
    const mixed = await create("mixed-denied-child", { variant: "oopif" }); await ready(mixed);
    await run(await create("policy-revocation"), async ({ item, collect, reject }) => { const download = await collect(); item.policyChanged = await controls.apply("allow", [new URL(fixtureURL).origin]); await reject("old-policy-path", download.path({ timeoutMs: 1000 }), "control"); await reject("old-policy-cancel", download.cancel({ timeoutMs: 1000 }), "control"); item.resume = await controls.resume(); await browser.client.beginTurn(); item.newScope = downloadScope(browser); });
    await run(mixed, async ({ tab, reject }) => { await reject("mixed-tree-arm", tab.expectDownload({ timeoutMs: 5000, requirePath: true }), "source"); });
    await run(await create("future-denied-child", { variant: "dynamic-oopif" }), async ({ item, tab, arm, reject, cancel }) => {
      const wait = await arm(); try { await tab.getByRole("button", { name: "Add download frame", exact: true }).click({ timeoutMs: 5000 }); } catch (error) { item.addError = text(error); assert.match(item.addError, sourceDenied); }
      await until(async () => (await getWorker().evaluate(`chrome.webNavigation.getAllFrames({tabId:${tab.id}})`)).some(row => row.parentFrameId === 0 && new URL(row.url).hostname === "localhost"), "actual denied child committed"); await reject("future-tree-collect", wait.result(), "retired"); await cancel();
    });
    assert.deepEqual(detail.executionOrder, ["explicit-cancel", "admitted-navigation", "source-ack-navigation", "opaque-source", "shared-opaque-no-native-download", "http-post-unproven", "late-release-policy", "policy-revocation", "mixed-denied-child", "future-denied-child"]);
    detail.proof = { cases: detail.cases.length, downloads: detail.cases.reduce((n, item) => n + item.proof.downloads, 0), posts: detail.cases.reduce((n, item) => n + item.proof.posts, 0), delivered: detail.cases.reduce((n, item) => n + item.proof.delivered, 0) }; assert.deepEqual(detail.proof, { cases: 10, downloads: 6, posts: 1, delivered: 3 });
  } catch (error) { failure = error; }
  finally {
    try { detail.serverLedger = fixture.allStats(); } catch (error) { detail.serverLedgerError = text(error); failure ??= error; }
    try { detail.childTargetIds = await getWorker().evaluate(`globalThis.__integrationFrames.filter(row=>${json(detail.tabIds)}.includes(row.tabId)).map(row=>row.targetId)`); } catch (error) { detail.childTargetReadError = text(error); failure ??= error; }
    for (const tabId of detail.tabIds) try { await getWorker().evaluate(`chrome.tabs.remove(${tabId})`); } catch (error) { (detail.tabCleanupErrors ??= []).push({ tabId, error: text(error) }); failure ??= error; }
    try { assert.ok(Array.isArray(detail.childTargetIds)); detail.cleanup = await getWorker().evaluate(`(async()=>({tabs:(await chrome.tabs.query({})).filter(row=>${json(detail.tabIds)}.includes(row.id)),targets:(await chrome.debugger.getTargets()).filter(row=>${json(detail.tabIds)}.includes(row.tabId)||${json(detail.childTargetIds)}.includes(row.id)),probePresent:!!globalThis.__restrictedDownloadEvidence}))()`); assert.deepEqual(detail.cleanup, { tabs: [], targets: [], probePresent: false }); } catch (error) { detail.cleanupError = text(error); failure ??= error; }
    try { detail.finalizeScope = downloadScope(browser); detail.finalize = await browser.client.finalizeTabs([]); } catch (error) { detail.finalizeError = text(error); failure ??= error; }
    try { browser.close(); } catch (error) { detail.connectionCleanupError = text(error); failure ??= error; }
    if (failure) detail.error = text(failure); try { await saveDetail(detail); } catch (error) { failure ??= error; }
  }
  if (failure) throw failure; return detail;
}
