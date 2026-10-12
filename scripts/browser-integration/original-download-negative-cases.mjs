import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import WebSocket from "ws";
import { downloadScope } from "./download-waits-fixture.mjs";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const stamp = () => ({ at: Date.now(), monotonicMs: performance.now() });
const disconnected = /OBU_(?:NATIVE_)?DOWNLOAD_(?:PATH_UNAVAILABLE|DISCONNECTED)|OBU_BROWSER_BIND_DISCONNECTED/;
const unowned = /OBU_DOWNLOAD_EXPIRED:.*(?:unknown|unowned)/i;
const describe = error => ({ name: error?.name, message: error?.message ?? String(error), stack: error?.stack });

// These witnesses inspect original messages; they never infer a GUID/path from
// fixture URLs, filename collisions, a directory delta or arrival timestamps.
export function assertNegativeRelay(snapshot) {
  assert.equal(snapshot.overflow, false); assert.equal(snapshot.captureComplete, true);
  assert.equal(snapshot.acceptedConnections, 1); assert.equal(snapshot.upstreamAttempts, 1); assert.equal(snapshot.reconnects, 0);
  for (const [index, row] of snapshot.records.entries()) {
    assert.equal(row.sequence, index);
    const bytes = Buffer.from(row.bodyBase64, "base64");
    assert.equal(bytes.length, row.bytes); assert.equal(sha(bytes), row.sha256);
    assert.equal(row.binary, false); assert.equal(bytes.toString(), row.text);
    assert.deepEqual(JSON.parse(row.text), row.json);
  }
  return snapshot.records;
}

export function negativeNativeDownload(snapshot, guid, terminal) {
  const events = assertNegativeRelay(snapshot).filter(row => row.direction === "upstream->downstream" && row.json.params?.guid === guid);
  const begins = events.filter(row => row.json.method === "Browser.downloadWillBegin");
  assert.equal(begins.length, 1, "Exact GUID needs one original Browser begin");
  assert.equal(begins[0].json.sessionId, undefined); assert.ok(begins[0].forwarded);
  const result = { begin: begins[0], progress: events.filter(row => row.json.method === "Browser.downloadProgress") };
  if (terminal) {
    const ends = result.progress.filter(row => row.json.params.state !== "inProgress");
    assert.equal(ends.length, 1, "Exact GUID needs one original terminal event");
    assert.equal(ends[0].json.params.state, terminal); assert.equal(ends[0].json.sessionId, undefined); assert.ok(ends[0].forwarded);
    result.terminal = ends[0];
  }
  return result;
}

export function assertNegativeHTTPReceipt(record, page, state) {
  assert.equal(page.key, record.key); assert.equal(page.nonce, record.nonce); assert.equal(page.owner, record.owner);
  assert.equal(page.expectedSHA, record.expected.sha256); assert.equal(page.clicks.length, 1);
  assert.deepEqual(page.clicks[0], { key: record.key, nonce: record.nonce, documentToken: page.documentToken, trusted: true, buttonCount: 1 });
  assert.equal(record.gets.length, 1);
  const html = Buffer.from(record.gets[0].base64, "base64");
  assert.equal(html.length, record.gets[0].bytes); assert.equal(sha(html), record.gets[0].sha256);
  const gets = record.requests.filter(hit => hit.method === "GET"); assert.equal(gets.length, 1);
  assert.equal(gets[0].url, record.urlPath); assert.equal(gets[0].status, 200); assert.equal(gets[0].finished, true);
  assert.deepEqual(gets[0].response, { bytes: html.length, sha256: sha(html), base64: html.toString("base64") });
  const posts = record.requests.filter(hit => hit.method === "POST");
  assert.equal(posts.length, 1, "No repeated original POST");
  const hit = posts[0];
  assert.equal(hit.url, record.reportPath); assert.equal(hit.status, 200); assert.equal(hit.once, true); assert.equal(hit.range, null);
  assert.equal(hit.body.truncated, false); assert.equal(hit.receivedBytes, hit.body.bytes);
  const body = Buffer.from(hit.body.base64, "base64"); assert.equal(body.length, hit.body.bytes); assert.equal(sha(body), hit.body.sha256);
  assert.deepEqual([...new URLSearchParams(body.toString())], hit.fieldEntries);
  assert.deepEqual(hit.fields, { key: record.key, nonce: record.nonce, documentToken: page.documentToken, trusted: "true", buttonCount: "1" });
  assert.deepEqual(hit.response, record.expected); assert.equal(hit.closed, state !== "held");
  if (state === "complete") { assert.equal(hit.finished, true); assert.equal(hit.aborted, false); assert.equal(hit.queuedBytes, record.expected.bytes); }
  else {
    assert.equal(hit.prefixFlushed, true); assert.equal(hit.prefixBytes, 4096); assert.equal(hit.queuedBytes, 4096); assert.equal(hit.finished, false);
    if (state === "interrupted") { assert.equal(hit.interrupted, true); assert.equal(hit.socketDestroyed, true); assert.equal(hit.aborted, true); }
    else assert.equal(state, "held");
  }
  return hit;
}

export async function readNegativeOriginalFile(filename, expected, root) {
  assert.equal(typeof filename, "string"); assert.ok(path.isAbsolute(filename));
  const relative = path.relative(path.resolve(root), filename);
  assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative), "Original path must stay in this isolated download directory");
  const file = await fs.open(filename, "r");
  try {
    const stat = await file.stat(); assert.ok(stat.isFile()); assert.equal(stat.size, expected.bytes); assert.ok(stat.size <= 65536);
    const bytes = await file.readFile(); assert.equal(bytes.length, expected.bytes); assert.equal(sha(bytes), expected.sha256);
    assert.deepEqual(bytes, Buffer.from(expected.base64, "base64"));
    return { path: filename, bytes: bytes.length, sha256: sha(bytes), base64: bytes.toString("base64"), analysis: JSON.parse(bytes.subarray(0, bytes.indexOf(10)).toString()) };
  } finally { await file.close(); }
}

// The one rejected GET is evidence to classify, never proof of its initiator.
// A separate mandatory gate must join the closed browser's complete NetLog to
// this exact server receipt. Five original POSTs and their bytes remain strict.
export function assertNegativeReportRequests(stats, originalPosts) {
  assert.equal(originalPosts.length, 5); assert.equal(new Set(originalPosts.map(hit => hit.fields.key)).size, 5);
  const reports = stats.requests.filter(hit => hit.url.split("?")[0] === "/original-negative/report");
  const posts = reports.filter(hit => hit.method === "POST"); assert.equal(posts.length, 5);
  for (const original of originalPosts) {
    assert.equal(original.url, "/original-negative/report"); assert.equal(original.status, 200); assert.equal(original.once, true);
    const matches = posts.filter(hit => hit.fields?.key === original.fields.key); assert.equal(matches.length, 1); assert.deepEqual(matches[0], original);
  }
  const extra = reports.filter(hit => hit.method !== "POST"); assert.equal(extra.length, 1, "Exactly one rejected browser-resume candidate requires independent provenance");
  const hit = extra[0], denied = Buffer.from("ORIGINAL_REPORT_REQUIRES_POST\n");
  assert.equal(hit.method, "GET"); assert.equal(hit.url, "/original-negative/report"); assert.equal(hit.status, 405); assert.equal(hit.range, null); assert.equal(hit.once, false);
  assert.equal(hit.error, "ORIGINAL_REPORT_REQUIRES_POST"); assert.equal(hit.prefixWritten, false); assert.equal(hit.prefixFlushed, false); assert.equal(hit.prefixBytes, 0);
  assert.equal(hit.queuedBytes, denied.length); assert.equal(hit.finished, true); assert.equal(hit.closed, true); assert.equal(hit.aborted, false); assert.deepEqual(hit.errors, []);
  assert.deepEqual(hit.response, { bytes: denied.length, sha256: sha(denied), base64: denied.toString("base64") });
  return structuredClone(hit);
}

// An independent actor for exactly one harness-created, unowned page. CDP input
// does not move the OS pointer. This actor never configures Browser downloads.
export async function connectNegativePageActor(url, { timeoutMs = 5000 } = {}) {
  const endpoint = new URL(url);
  assert.ok(["ws:", "wss:"].includes(endpoint.protocol) && ["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname));
  assert.match(endpoint.pathname, /^\/devtools\/page\/[^/]+$/); assert.ok(!endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash);
  assert.ok(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 10000);
  const detail = { url, started: stamp(), records: [], closeObserved: false, events: [], overflow: false };
  const socket = new WebSocket(url, { handshakeTimeout: timeoutMs, maxPayload: 1024 * 1024 });
  const pending = new Map(); let next = 0, failure, closing = false, totalBytes = 0;
  let openResolve, openReject, closedResolve;
  const opened = new Promise((resolve, reject) => { openResolve = resolve; openReject = reject; });
  const closed = new Promise(resolve => { closedResolve = resolve; });
  const fail = error => { failure ??= error; detail.error ??= describe(error); openReject(error); for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); } pending.clear(); socket.terminate(); };
  const record = (direction, bytes, json) => {
    totalBytes += bytes.length;
    if (detail.records.length >= 512 || totalBytes > 4 * 1024 * 1024) { detail.overflow = true; throw Error("Unowned actor evidence overflow"); }
    const row = { sequence: detail.records.length, ...stamp(), direction, bytes: bytes.length, sha256: sha(bytes), bodyBase64: bytes.toString("base64"), json };
    detail.records.push(row); return row;
  };
  socket.once("open", () => { detail.opened = stamp(); openResolve(); });
  socket.on("error", fail);
  socket.once("close", (code, reason) => {
    Object.assign(detail, { closeObserved: true, closed: stamp(), closeCode: code, closeReason: reason.toString() });
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(failure ?? Error("Unowned actor original socket closed")); } pending.clear();
    if (!closing) fail(Error("Unowned actor original socket closed"));
    closedResolve();
  });
  socket.on("message", (raw, binary) => {
    try {
      assert.equal(binary, false); const bytes = Buffer.from(raw), message = JSON.parse(bytes.toString());
      const row = record("receive", bytes, message);
      if (message.method) { detail.events.push(row); return; }
      const entry = pending.get(message.id); assert.ok(entry, "Unexpected actor response ID"); pending.delete(message.id); clearTimeout(entry.timer);
      if (message.error) entry.reject(Error(JSON.stringify(message.error))); else entry.resolve(message.result);
    } catch (error) { fail(error); }
  });
  async function close() {
    closing = true;
    if (socket.readyState < WebSocket.CLOSING) { detail.closeRequested = stamp(); socket.close(); }
    const timer = setTimeout(() => { detail.terminateRequested = stamp(); socket.terminate(); }, 1000);
    try { await closed; } finally { clearTimeout(timer); }
    assert.equal(pending.size, 0, "Actor closed with an unsettled original command");
  }
  try { await opened; } catch (error) { await close(); error.negativeActorDetail = detail; throw error; }
  return {
    detail, close,
    call(method, params = {}, options = {}) {
      if (failure || closing || socket.readyState !== WebSocket.OPEN) return Promise.reject(failure ?? Error("Unowned actor closed"));
      const budget = Math.min(timeoutMs, options.timeoutMs ?? timeoutMs);
      assert.ok(Number.isInteger(budget) && budget > 0);
      return new Promise((resolve, reject) => {
        const id = ++next, json = { id, method, params }, bytes = Buffer.from(JSON.stringify(json));
        try { record("send", bytes, json); } catch (error) { fail(error); reject(error); return; }
        const timer = setTimeout(() => fail(Error(`Original unowned actor command timed out: ${method}`)), budget);
        pending.set(id, { resolve, reject, timer }); socket.send(bytes, { binary: false }, error => { if (error) fail(error); });
      });
    },
    async evaluate(expression) {
      const result = await this.call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      assert.equal(result.exceptionDetails, undefined); return result.result.value;
    }
  };
}

// Prepare only the independently attached unowned page. This renderer focus
// emulation never activates a browser tab/window or moves the operating-system
// pointer. The original first frame and its ACK must precede any input.
export async function withNegativePageRendering(actor, operation, { timeoutMs = 5000 } = {}) {
  assert.ok(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 5000);
  assert.equal(actor.detail.rendering, undefined, "One rendering lease per unowned actor");
  const lease = actor.detail.rendering = { started: stamp(), timeoutMs, cleanup: [] };
  const deadline = performance.now() + timeoutMs;
  const command = (method, params) => {
    const remaining = Math.floor(deadline - performance.now());
    assert.ok(remaining > 0, "Unowned rendering preparation expired before input");
    return actor.call(method, params, { timeoutMs: remaining });
  };
  let focusRequested = false, captureRequested = false, failure, result;
  try {
    focusRequested = true; await command("Emulation.setFocusEmulationEnabled", { enabled: true }); lease.focusAcknowledged = stamp();
    captureRequested = true; await command("Page.startScreencast", { format: "png", maxWidth: 64, maxHeight: 64, everyNthFrame: 1 }); lease.startAcknowledged = stamp();
    let frame;
    while (!(frame = actor.detail.events.find(row => row.json.method === "Page.screencastFrame"))) {
      if (actor.detail.error || actor.detail.closeObserved) throw Error(actor.detail.error?.message ?? "Unowned actor closed before first rendering frame");
      assert.ok(performance.now() < deadline, "Unowned rendering preparation expired before first frame; no input");
      await new Promise(resolve => setTimeout(resolve, Math.min(5, Math.max(1, deadline - performance.now()))));
    }
    assert.ok(Number.isInteger(frame.json.params.sessionId));
    const png = Buffer.from(frame.json.params.data, "base64");
    assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
    assert.ok(width > 0 && width <= 64 && height > 0 && height <= 64 && png.length <= 65536, "Bounded original rendering PNG");
    lease.firstFrame = { sequence: frame.sequence, sessionId: frame.json.params.sessionId, bytes: png.length, sha256: sha(png), width, height };
    await command("Page.screencastFrameAck", { sessionId: frame.json.params.sessionId }); lease.frameAcknowledged = stamp();
    assert.ok(performance.now() < deadline, "Unowned rendering preparation expired after first frame ACK; no input");
    lease.inputStarted = stamp(); result = await operation();
  } catch (error) { failure = error; lease.error = describe(error); }
  finally {
    for (const [needed, method, params] of [[captureRequested, "Page.stopScreencast", {}], [focusRequested, "Emulation.setFocusEmulationEnabled", { enabled: false }]]) {
      if (!needed) continue;
      const cleanup = { method, params, started: stamp() }; lease.cleanup.push(cleanup);
      try { await actor.call(method, params); cleanup.acknowledged = stamp(); }
      catch (error) { cleanup.error = describe(error); if (!failure) { failure = error; lease.error = describe(error); } }
    }
    lease.completed = stamp();
  }
  if (failure) throw failure;
  return result;
}

export function installNegativeTrace() {
  if (globalThis.__originalNegativeTrace || globalThis.__integrationNativeRPCObserver) throw Error("Original-negative observer slot is already occupied");
  const trace = globalThis.__originalNegativeTrace = { page: [], private: [], overflow: false };
  const append = (rows, value) => { if (rows.length >= 512) { trace.overflow = true; return; } rows.push({ at: Date.now(), monotonicMs: performance.now(), ...structuredClone(value) }); };
  trace.listener = (source, method, params) => {
    if (["Page.downloadWillBegin", "Page.downloadProgress"].includes(method)) append(trace.page, { source, method, params });
    const network = trace.network;
    if (source.tabId !== network?.tabId || !["Network.requestWillBeSent", "Network.requestWillBeSentExtraInfo", "Network.responseReceived", "Network.responseReceivedExtraInfo", "Network.loadingFinished", "Network.loadingFailed"].includes(method)) return;
    const value = { at: Date.now(), monotonicMs: performance.now(), source, method, params };
    const bytes = new TextEncoder().encode(JSON.stringify(value)).length;
    if (network.events.length >= 512 || network.bytes + bytes > 2 * 1024 * 1024) { network.overflow = true; return; }
    network.bytes += bytes; network.events.push(structuredClone(value));
  };
  globalThis.__integrationNativeRPCObserver = (direction, message) => { if (message.method === "obu.native.pageDownloads") append(trace.private, { direction, message }); };
  chrome.debugger.onEvent.addListener(trace.listener);
}
const readTrace = worker => worker.evaluate("({page:__originalNegativeTrace.page,private:__originalNegativeTrace.private,overflow:__originalNegativeTrace.overflow,network:__originalNegativeTrace.network})");
const pageState = target => target.evaluate("JSON.parse(document.querySelector('#state').textContent)");

export function negativeActionBudget(deadline) {
  const remaining = Math.floor(deadline - performance.now());
  assert.ok(remaining > 0, "Original download observation expired before trigger; no new click");
  return Math.min(5000, remaining);
}

export async function checkOriginalDownloadNegatives({ owner, foreign, worker, fixture, fixtureURL, downloadRoot, until, browserURL, relay, connectionState, rebind, detail = {} }) {
  Object.assign(detail, { boundary: "JS-only negative acceptance in a caller-owned isolated Chromium; no ordinary approval UI or all-entry negative claim", operations: [], cases: [], notifications: { owner: [], foreign: [] }, cleanup: [], connections: {}, relays: [] });
  const owned = [], waiters = [], releases = new Set(), inFlight = new Set(); let actor, unownedTab, networkTab, traceInstalled = false, failure, currentRelay = relay;
  const unsubscribes = [owner, foreign].map((client, index) => client.client.onNotification(event => {
    if (event.method === "onDownloadChange") {
      const rows = detail.notifications[index ? "foreign" : "owner"];
      if (rows.length >= 512) { detail.notificationOverflow = true; return; } rows.push(structuredClone(event.params));
    }
  }));
  const operation = async (label, params, fn) => {
    const row = { label, params: structuredClone(params), started: stamp() }; detail.operations.push(row);
    const actual = Promise.resolve().then(() => fn(row)); inFlight.add(actual);
    try { const result = await actual; row.result = result === undefined ? null : structuredClone(result); row.completed = stamp(); return result; }
    catch (error) { row.error = describe(error); row.failed = stamp(); throw error; }
    finally { inFlight.delete(actual); }
  };
  const reject = async (label, params, fn, pattern) => {
    let error; try { await operation(label, params, fn); } catch (caught) { error = caught; }
    assert.ok(error, `${label} unexpectedly succeeded`); assert.match(error.message, pattern); return error;
  };
  const post = item => fixture.stats(item.key).requests.find(hit => hit.method === "POST" && hit.once);
  const rememberPage = async item => {
    item.page = await pageState(item.target);
    item.server = fixture.stats(item.key); return item;
  };
  const waitNative = async (item, state, selectedRelay = currentRelay) => {
    await until(() => selectedRelay.snapshot().records.some(row => row.forwarded && row.json?.method === "Browser.downloadProgress" && row.json.params.guid === item.guid && row.json.params.state === state), `original ${item.label} Browser ${state}`, 10000);
    item.native = negativeNativeDownload(selectedRelay.snapshot(), item.guid, state); return item.native;
  };
  const waitNotification = (item, status) => until(() => detail.notifications.owner.find(event => event.id === item.guid && event.status === status), `original ${item.label} owned ${status} notification`, 5000);
  const ownedStart = async (label, kind) => {
    const record = fixture.createCase({ owner: `negative-${label}`, kind });
    const item = { label, key: record.key, record, scope: downloadScope(owner), started: stamp() }; detail.cases.push(item);
    const tab = await owner.newTab(); owned.push(tab); item.tabId = tab.id;
    if (kind === "interrupted") {
      await worker.evaluate(`(()=>{const trace=globalThis.__originalNegativeTrace;if(trace.network)throw Error('Original interrupted network observer already exists');trace.network={tabId:${JSON.stringify(tab.id)},startedAt:Date.now(),events:[],bytes:0,overflow:false};})()`);
      networkTab = tab;
      const setup = detail.networkSetup = { tabId: tab.id, method: "Network.enable", params: { maxPostDataSize: 65536 }, started: stamp() };
      setup.result = await owner.cdp.call(tab.id, setup.method, setup.params, { timeoutMs: 5000 }); setup.acknowledged = stamp();
    }
    await owner.cdp.navigate(tab.id, new URL(record.urlPath, fixtureURL).href);
    const armStarted = performance.now();
    const waiter = await tab.expectDownload({ timeoutMs: 15000 }); waiters.push(waiter);
    const waitDeadline = Math.min(armStarted + 15000, performance.now() + waiter.remainingMs);
    item.waiterId = waiter.waiterId; item.readyAt = Date.now(); item.remainingMs = waiter.remainingMs;
    const timeoutMs = negativeActionBudget(waitDeadline);
    item.triggerAt = Date.now(); await operation(`${label}.click`, { ...item.scope, tabId: tab.id, timeoutMs }, row => {
      row.params.timeoutMs = Math.min(timeoutMs, negativeActionBudget(waitDeadline));
      return tab.getByRole("button", { name: "Download original report", exact: true }).click({ timeoutMs: row.params.timeoutMs });
    });
    const download = await waiter.result(); item.guid = download.downloadId; item.collectedAt = Date.now();
    Object.defineProperties(item, { download: { value: download }, target: { value: tab } });
    await rememberPage(item);
    await until(() => currentRelay.snapshot().records.some(row => row.forwarded && row.json?.method === "Browser.downloadWillBegin" && row.json.params.guid === item.guid), `original ${label} Browser begin`, 5000);
    item.native = negativeNativeDownload(currentRelay.snapshot(), item.guid);
    const trace = await readTrace(worker), begin = trace.page.filter(row => row.method === "Page.downloadWillBegin" && row.params.guid === item.guid);
    assert.equal(begin.length, 1); assert.equal(begin[0].source.tabId, item.tabId); assert.equal(begin[0].params.frameId, item.native.begin.json.params.frameId); item.pageBegin = begin[0];
    if (kind !== "complete") { releases.add(item.key); await until(() => post(item)?.prefixFlushed, `${label} original prefix flushed`, 5000); }
    return item;
  };
  const pathResult = async (item, label = item.label) => {
    const filename = await operation(`${label}.path`, { ...item.scope, downloadId: item.guid, timeoutMs: 5000 }, () => item.download.path({ timeoutMs: 5000 }));
    item.file = await readNegativeOriginalFile(filename, item.record.expected, downloadRoot); return filename;
  };
  const oldRejected = async (items, phase) => { for (const item of items) for (const method of ["path", "cancel"]) await reject(`${phase}.${item.label}.${method}`, { ...item.scope, downloadId: item.guid, timeoutMs: 3000 }, () => item.download[method]({ timeoutMs: 3000 }), disconnected); };
  try {
    await owner.client.getTabs(); await foreign.client.getTabs();
    detail.scope = downloadScope(owner); detail.foreignScope = downloadScope(foreign); assert.notEqual(detail.scope.session_id, detail.foreignScope.session_id);
    detail.connections.before = await connectionState(); assert.equal(detail.connections.before.nativeSocketReadyState, 1); assert.equal(detail.connections.before.hostExitCode, null);
    detail.capabilitiesBefore = await owner.client.getInfo(); const generationA = detail.capabilitiesBefore.metadata.pageDownloads.generation;
    assert.equal(detail.capabilitiesBefore.metadata.pageDownloads.available, true); assert.ok(generationA);
    detail.controlBefore = await owner.client.getControlState(); detail.proofBefore = await worker.evaluate("globalThis.__obuNativeDownloadBinding"); assert.ok(detail.proofBefore?.nonce);
    await worker.evaluate(`(${installNegativeTrace.toString()})()`); traceInstalled = true;
    const warm = await ownedStart("warm", "complete"); await waitNative(warm, "completed");
    const originalPath = await pathResult(warm); assert.equal(await pathResult(warm, "warm.repeat"), originalPath);
    await until(() => post(warm)?.closed, "warm original response close", 5000); await rememberPage(warm); assertNegativeHTTPReceipt(warm.server, warm.page, "complete"); await waitNotification(warm, "complete");
    const held = await ownedStart("held", "held");

    const externalRecord = fixture.createCase({ owner: "negative-unowned", kind: "held" });
    const external = { label: "unowned", key: externalRecord.key, record: externalRecord }; detail.cases.push(external); releases.add(external.key);
    const externalURL = new URL(externalRecord.urlPath, fixtureURL).href;
    unownedTab = await worker.evaluate(`chrome.tabs.create({url:${JSON.stringify(externalURL)},active:false})`); external.createdTab = structuredClone(unownedTab); external.tabId = unownedTab.id; assert.equal(unownedTab.active, false);
    const root = new URL(browserURL); assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(root.hostname));
    const listURL = new URL("/json/list", root.protocol === "wss:" ? `https://${root.host}` : `http://${root.host}`);
    external.target = await until(async () => {
      const native = await worker.evaluate(`chrome.debugger.getTargets()`), target = native.find(value => value.tabId === external.tabId && value.type === "page" && value.url === externalURL);
      if (!target) return false;
      const response = await fetch(listURL, { signal: AbortSignal.timeout(2000) }); assert.equal(response.ok, true);
      const values = await response.json(), match = values.find(value => value.id === target.id && value.type === "page" && value.url === externalURL);
      return match ? { ...match, tabId: external.tabId } : false;
    }, "exact unowned page endpoint", 5000);
    actor = await connectNegativePageActor(external.target.webSocketDebuggerUrl); detail.actor = actor.detail;
    await actor.call("Page.enable"); external.frameTree = await actor.call("Page.getFrameTree");
    await until(() => actor.evaluate("Boolean(document.querySelector('#download')&&document.querySelector('#state')?.textContent)"), "unowned original document ready", 5000);
    external.point = await actor.evaluate("(()=>{const b=document.querySelector('#download'),r=b.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;if(document.elementFromPoint(x,y)!==b||x<0||y<0||x>=innerWidth||y>=innerHeight)throw Error('Unowned button is not hittable');return{x,y}})()");
    await withNegativePageRendering(actor, async () => {
      external.triggerAt = Date.now();
      await actor.call("Input.dispatchMouseEvent", { type: "mouseMoved", ...external.point, button: "none", buttons: 0 });
      await actor.call("Input.dispatchMouseEvent", { type: "mousePressed", ...external.point, button: "left", buttons: 1, clickCount: 1 });
      await actor.call("Input.dispatchMouseEvent", { type: "mouseReleased", ...external.point, button: "left", buttons: 0, clickCount: 1 });
    });
    await until(() => actor.detail.events.some(row => row.json.method === "Page.downloadWillBegin"), "unowned original Page GUID", 5000);
    const externalBegins = actor.detail.events.filter(row => row.json.method === "Page.downloadWillBegin"); assert.equal(externalBegins.length, 1);
    external.pageBegin = externalBegins[0]; external.guid = external.pageBegin.json.params.guid;
    assert.equal(external.pageBegin.json.params.frameId, external.frameTree.frameTree.frame.id);
    external.page = await actor.evaluate("JSON.parse(document.querySelector('#state').textContent)");
    await until(() => post(external)?.prefixFlushed, "unowned original prefix flushed", 5000);
    external.server = fixture.stats(external.key); assertNegativeHTTPReceipt(external.server, external.page, "held");
    await until(() => relay.snapshot().records.some(row => row.forwarded && row.json?.method === "Browser.downloadWillBegin" && row.json.params.guid === external.guid), "original unowned Browser begin", 5000);
    external.native = negativeNativeDownload(relay.snapshot(), external.guid); assert.equal(external.native.begin.json.params.frameId, external.pageBegin.json.params.frameId);
    for (const [who, client] of [["owner", owner], ["foreign", foreign]]) for (const method of ["downloadPath", "cancelDownload"]) {
      const params = { ...downloadScope(client), downloadId: external.guid, timeoutMs: 3000 };
      await reject(`unowned.${who}.${method}`, params, () => client.client.request(method, params, { timeoutMs: 4000 }), unowned);
    }
    fixture.release(external.key); releases.delete(external.key); await waitNative(external, "completed");
    external.file = await readNegativeOriginalFile(external.native.terminal.json.params.filePath, external.record.expected, downloadRoot);
    await until(() => post(external)?.closed, "unowned original response completes", 5000);
    external.server = fixture.stats(external.key); assertNegativeHTTPReceipt(external.server, external.page, "complete");
    await actor.close(); external.actorClosedAt = Date.now(); assert.equal(actor.detail.closeObserved, true);

    const interrupted = await ownedStart("interrupted", "interrupted"); fixture.interrupt(interrupted.key); releases.delete(interrupted.key);
    await waitNative(interrupted, "canceled"); await reject("interrupted.path", { ...interrupted.scope, downloadId: interrupted.guid }, () => interrupted.download.path({ timeoutMs: 5000 }), /OBU_NATIVE_DOWNLOAD_CANCELED/);
    await until(() => post(interrupted)?.closed, "interrupted response close", 5000); await rememberPage(interrupted); assertNegativeHTTPReceipt(interrupted.server, interrupted.page, "interrupted");
    await waitNotification(interrupted, "canceled");
    detail.capabilitiesAfterHTTPFailure = await owner.client.getInfo(); assert.deepEqual(detail.capabilitiesAfterHTTPFailure.metadata.pageDownloads, detail.capabilitiesBefore.metadata.pageDownloads);

    const pending = operation("held.pathAcrossDisconnect", { ...held.scope, downloadId: held.guid, timeoutMs: 5000 }, () => held.download.path({ timeoutMs: 5000 }));
    const settled = pending.then(result => ({ result }), error => ({ error }));
    await Promise.race([
      until(async () => { const trace = await readTrace(worker); return trace.private.find(row => row.direction === "response" && row.message.params?.type === "request" && row.message.params.operation === "path" && row.message.params.payload.guid === held.guid); }, "original held path actually submitted", 3000),
      settled.then(value => { throw value.error ?? Error("Held original path unexpectedly completed before disconnect"); })
    ]).then(row => { detail.pendingPathAdmission = row; });
    detail.disconnectStarted = stamp(); await relay.disconnect(); detail.disconnectCompleted = stamp();
    const rejected = await settled; assert.ok(rejected.error); assert.match(rejected.error.message, disconnected);
    detail.capabilitiesDisconnected = await until(async () => { const info = await owner.client.getInfo(); return info.metadata.pageDownloads.available === false ? info : false; }, "original Browser capability revoked", 5000);
    assert.equal(detail.capabilitiesDisconnected.metadata.pageDownloads.generation, generationA);
    await oldRejected([warm, held], "disconnected");
    detail.connections.disconnected = await connectionState(); assert.deepEqual(detail.connections.disconnected, detail.connections.before);
    detail.controlDisconnected = await owner.client.getControlState(); assert.deepEqual(detail.controlDisconnected, detail.controlBefore);
    detail.healthyPageRead = await warm.target.locator("#state").textContent(); assert.equal(JSON.parse(detail.healthyPageRead).key, warm.key);
    fixture.release(held.key); releases.delete(held.key);
    await until(() => post(held)?.closed, "held HTTP finishes after Browser transport loss", 5000);
    await until(async () => (await readTrace(worker)).page.some(row => row.method === "Page.downloadProgress" && row.params.guid === held.guid && row.params.state === "completed"), "healthy extension Page completion after Browser transport loss", 5000);
    await rememberPage(held); assertNegativeHTTPReceipt(held.server, held.page, "complete");
    await waitNotification(held, "complete");
    warm.fileAfterDisconnect = await readNegativeOriginalFile(originalPath, warm.record.expected, downloadRoot);
    detail.relays.push(relay.snapshot()); assertNegativeRelay(detail.relays[0]); assert.equal(detail.relays[0].attemptCount, 1);
    assert.equal(detail.relays[0].upstream.closeObserved, true); assert.equal(detail.relays[0].downstream.closeObserved, true);

    detail.rebindStarted = stamp(); const replacement = await rebind(); detail.rebindCompleted = stamp();
    currentRelay = replacement.relay; assert.notEqual(currentRelay, relay);
    detail.rebinding = Object.fromEntries(Object.entries(replacement).filter(([key]) => key !== "relay"));
    detail.capabilitiesRebound = await owner.client.getInfo(); const generationB = detail.capabilitiesRebound.metadata.pageDownloads.generation;
    assert.equal(detail.capabilitiesRebound.metadata.pageDownloads.available, true); assert.ok(generationB && generationB !== generationA);
    assert.equal(replacement.binding.result.generation, generationB); assert.equal(replacement.bindingProcess.closeObserved, true); assert.equal(replacement.bindingProcess.exitCode, 0);
    detail.proofRebound = await worker.evaluate("globalThis.__obuNativeDownloadBinding"); assert.notEqual(detail.proofRebound.nonce, detail.proofBefore.nonce);
    for (const key of ["extensionId", "extensionInstanceId", "workerBootId", "portId"]) assert.equal(detail.proofRebound[key], detail.proofBefore[key]);
    await oldRejected([warm, held], "rebound");
    const fresh = await ownedStart("fresh", "complete"); await waitNative(fresh, "completed"); await pathResult(fresh);
    await until(() => post(fresh)?.closed, "fresh original response close", 5000); await rememberPage(fresh); assertNegativeHTTPReceipt(fresh.server, fresh.page, "complete");
    await waitNotification(fresh, "complete");
    detail.connections.rebound = await connectionState(); assert.deepEqual(detail.connections.rebound, detail.connections.before);
    assert.deepEqual(downloadScope(owner), detail.scope); assert.deepEqual(await owner.client.getControlState(), detail.controlBefore);
    detail.trace = await readTrace(worker); assert.equal(detail.trace.overflow, false); assert.equal(detail.notificationOverflow, undefined);
    assert.equal(detail.trace.network.overflow, false);
    assert.equal(detail.trace.private.filter(row => row.message.params?.operation === "claim" && row.message.params.payload?.guid === external.guid).length, 0);
    const revoked = detail.trace.private.filter(row => row.direction === "request" && row.message.params?.type === "ready" && row.message.params.available === false && row.message.params.generation === generationA);
    assert.equal(revoked.length, 1); detail.revocation = revoked[0];
    for (const rows of Object.values(detail.notifications)) assert.equal(rows.filter(row => row.id === external.guid).length, 0);
    assert.equal(detail.notifications.foreign.length, 0);
    const ownedIds = new Map(detail.cases.filter(item => item.scope).map(item => [item.guid, item]));
    for (const event of detail.notifications.owner) { const item = ownedIds.get(event.id); assert.ok(item); assert.equal(event.tabId, item.tabId); for (const key of ["session_id", "turn_id", "control_epoch"]) assert.equal(event[key], item.scope[key]); }
    for (const snapshot of [relay.snapshot(), currentRelay.snapshot()]) {
      assertNegativeRelay(snapshot); assert.equal(snapshot.attemptCount, 1);
      assert.equal(snapshot.records.filter(row => row.direction === "downstream->upstream" && row.json.method === "Browser.cancelDownload").length, 0, "Rejected cancellation must never reach any native GUID");
    }
    detail.browserResumeRequest = assertNegativeReportRequests(fixture.allStats(), detail.cases.map(item => item.server.requests.find(hit => hit.method === "POST")));
    detail.networkProvenance = { required: true, status: "pending", gate: "js-original-download-network-provenance", boundary: "This helper does not establish GET initiator; require the independent complete-NetLog gate after actual Browser close" };
    detail.passed = true;
  } catch (error) { failure = error; detail.error = describe(error); }
  finally {
    await Promise.allSettled([...inFlight]);
    // Release observation/owned tabs, never cancel a browser download as cleanup.
    for (const waiter of waiters) try { await waiter.cancel(); detail.cleanup.push({ kind: "waiter", waiterId: waiter.waiterId, ok: true }); } catch (error) { detail.cleanup.push({ kind: "waiter", waiterId: waiter.waiterId, error: describe(error) }); failure ??= error; }
    for (const key of releases) try { if (fixture.stats(key).kind === "held" && fixture.stats(key).requests.some(hit => hit.prefixFlushed && !hit.closed)) fixture.release(key); } catch (error) { detail.cleanup.push({ kind: "response", key, error: describe(error) }); failure ??= error; }
    if (actor) try { await actor.close(); } catch (error) { detail.cleanup.push({ kind: "actor", error: describe(error) }); failure ??= error; }
    if (networkTab) {
      const cleanup = { kind: "network", tabId: networkTab.id, method: "Network.disable", started: stamp() }; detail.cleanup.push(cleanup);
      try { cleanup.result = await owner.cdp.call(networkTab.id, "Network.disable", {}, { timeoutMs: 5000 }); cleanup.acknowledged = stamp(); }
      catch (error) { cleanup.error = describe(error); failure ??= error; }
    }
    for (const tab of owned) try { await tab.close(); detail.cleanup.push({ kind: "ownedTab", tabId: tab.id, ok: true }); } catch (error) { detail.cleanup.push({ kind: "ownedTab", tabId: tab.id, error: describe(error) }); failure ??= error; }
    if (unownedTab) try { await worker.evaluate(`chrome.tabs.remove(${JSON.stringify(unownedTab.id)})`); detail.cleanup.push({ kind: "unownedTab", tabId: unownedTab.id, ok: true }); } catch (error) { detail.cleanup.push({ kind: "unownedTab", error: describe(error) }); failure ??= error; }
    if (traceInstalled) try {
      detail.trace = await readTrace(worker);
      await worker.evaluate("(()=>{chrome.debugger.onEvent.removeListener(__originalNegativeTrace.listener);delete globalThis.__originalNegativeTrace;delete globalThis.__integrationNativeRPCObserver})()");
    } catch (error) { detail.cleanup.push({ kind: "trace", error: describe(error) }); failure ??= error; }
    for (const unsubscribe of unsubscribes) unsubscribe();
    detail.relays = [relay.snapshot(), ...(currentRelay !== relay ? [currentRelay.snapshot()] : [])]; detail.server = fixture.allStats(); detail.completed = stamp();
    if (failure) { detail.passed = false; failure.originalDownloadNegativeDetail = detail; }
  }
  if (failure) throw failure;
  return detail;
}
