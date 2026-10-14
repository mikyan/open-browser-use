import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const json = value => JSON.stringify(value).replaceAll("<", "\\u003c");
const layouts = ["root", "oopif", "dynamic-oopif"];
export const responseBodyKinds = ["binary", "utf8", "empty", "unavailable-status"];
export const responseBodyURL = (base, key, layout = "root") => base + "response-body/page?" + new URLSearchParams({ key, layout });
export function responseBodyBytes(key, kind, ordinal = 1) {
  if (kind === "empty") return Buffer.alloc(0);
  if (kind === "binary") return Buffer.concat([Buffer.from([0, 255, 254, 128, 13, 10, 1, 127]), Buffer.from(`${key}:${ordinal}`)]);
  return Buffer.from(`${kind}:${key}:${ordinal}\n原始响应 🧪\u0000尾行\n`, "utf8");
}

function pageHTML({ key, layout, child, port, nonce }) {
  const config = { key, nonce, child, layout }, frame = `http://localhost:${port}/response-body/frame?${new URLSearchParams({ key, layout })}`;
  return `<!doctype html><meta charset="utf-8"><title>Original response body</title><h1>Original response body ${child ? "child" : "root"}</h1>
    ${[...responseBodyKinds, "gate", "redirect", "failed", "pair"].map(kind => `<button data-kind="${kind}">Send ${kind}</button>`).join("")}
    <button id="release">Release original body</button><button id="add">Add response frame</button><output id="state">ready</output>
    ${!child && layout === "oopif" ? `<iframe id="response-frame" src="${frame}"></iframe>` : ""}
    <script>const config=${json(config)},token=crypto.randomUUID();globalThis.responseBodyEvidence={...config,documentToken:token,clicks:[],completions:[],errors:[]};
    const ledger=responseBodyEvidence;for(const button of document.querySelectorAll('[data-kind]'))button.addEventListener('click',async event=>{
      const kind=button.dataset.kind,sequence=ledger.clicks.length+1;ledger.clicks.push({kind,sequence,trusted:event.isTrusted});
      const send=async ordinal=>{const payload={key:config.key,nonce:config.nonce,documentToken:token,href:location.href,kind,sequence,ordinal,trusted:event.isTrusted};
        try{const response=await fetch('/response-body/api?'+new URLSearchParams({key:config.key,kind}),{method:'POST',body:JSON.stringify(payload),cache:'no-store'});
          const bytes=new Uint8Array(await response.arrayBuffer());let text='';for(const byte of bytes)text+=String.fromCharCode(byte);
          ledger.completions.push({kind,sequence,ordinal,status:response.status,data:btoa(text),byteLength:bytes.length});document.querySelector('#state').textContent='complete';
        }catch(error){ledger.errors.push({kind,sequence,ordinal,error:String(error)});document.querySelector('#state').textContent='failed';}};
      await Promise.all(kind==='pair'?[send(1),send(2)]:[send(1)]);
    });document.querySelector('#release').onclick=async event=>{ledger.clicks.push({kind:'release',sequence:ledger.clicks.length+1,trusted:event.isTrusted});await fetch('/response-body/release?'+new URLSearchParams({key:config.key}),{method:'POST',body:JSON.stringify({key:config.key,documentToken:token,trusted:event.isTrusted})});};
    document.querySelector('#add').onclick=event=>{if(!event.isTrusted||document.querySelector('#response-frame'))throw Error('Original frame creation only');const frame=document.createElement('iframe');frame.id='response-frame';frame.src=${json(frame)};document.body.append(frame);};</script>`;
}

// Every route, including unexpected methods and explicit gate releases, is
// retained. Reading a body cannot be hidden by an unrecorded HTTP re-fetch.
export function createResponseBodyFixtures() {
  const records = new Map(), gates = new Map();
  const entry = key => { if (!records.has(key)) records.set(key, { key, documents: [], attempts: [], overflow: false }); return records.get(key); };
  const release = key => { const pending = gates.get(key) ?? []; gates.delete(key); for (const finish of pending) finish(); };
  return {
    stats: key => structuredClone(entry(key)), allStats: () => [...records.values()].map(value => structuredClone(value)), release,
    close() { for (const key of [...gates.keys()]) release(key); },
    handle(request, response, port) {
      const url = new URL(request.url, "http://localhost");
      if (!url.pathname.startsWith("/response-body/")) return false;
      const key = url.searchParams.get("key");
      if (!key || !/^[a-zA-Z0-9-]{1,180}$/.test(key)) { response.writeHead(400); response.end(); return true; }
      const record = entry(key);
      if (record.attempts.length >= 80) { record.overflow = true; response.writeHead(429); response.end(); return true; }
      const attempt = { method: request.method, path: request.url, at: Date.now() }; record.attempts.push(attempt);
      if (["/response-body/page", "/response-body/frame"].includes(url.pathname)) {
        if (request.method !== "GET") { response.writeHead(405); response.end(); return true; }
        const layout = url.searchParams.get("layout") ?? "root", nonce = randomUUID();
        if (!layouts.includes(layout)) { response.writeHead(400); response.end(); return true; }
        const bytes = Buffer.from(pageHTML({ key, layout, child: url.pathname.endsWith("frame"), port, nonce }));
        record.documents.push({ path: request.url, nonce, bytes: bytes.length, sha256: sha(bytes), at: Date.now() });
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }); response.end(bytes); return true;
      }
      if (!["/response-body/api", "/response-body/final", "/response-body/release"].includes(url.pathname)) { response.writeHead(404); response.end(); return true; }
      if (request.method !== "POST") { response.writeHead(405); response.end(); return true; }
      const chunks = []; let size = 0, bad = false;
      request.on("data", chunk => { size += chunk.length; if (size > 32768) { bad = true; response.destroy(); } else chunks.push(chunk); });
      request.on("end", () => {
        if (bad) return;
        const body = Buffer.concat(chunks); Object.assign(attempt, { bodyBase64: body.toString("base64"), bodyBytes: body.length, bodySHA256: sha(body) });
        try { attempt.value = JSON.parse(body.toString()); } catch { response.writeHead(400); response.end(); return; }
        if (url.pathname.endsWith("release")) { attempt.finishedAt = Date.now(); response.writeHead(200); response.end("released"); release(key); return; }
        const kind = url.searchParams.get("kind"), value = attempt.value;
        if (!record.documents.some(doc => doc.nonce === value.nonce) || value.key !== key || !value.trusted || value.kind !== kind) {
          response.writeHead(400); response.end(); return;
        }
        const status = kind === "unavailable-status" ? 503 : 200;
        if (kind === "redirect" && url.pathname.endsWith("api")) {
          attempt.status = 307; attempt.headersAt = attempt.finishedAt = Date.now();
          response.writeHead(307, { Location: `/response-body/final?${new URLSearchParams({ key, kind })}`, "Cache-Control": "no-store" }); response.end(); return;
        }
        const bytes = responseBodyBytes(key, kind, value.ordinal);
        Object.assign(attempt, { status, responseBytes: bytes.length, responseBase64: bytes.toString("base64"), responseSHA256: sha(bytes), headersAt: Date.now() });
        response.writeHead(status, { "Content-Type": kind === "binary" ? "application/octet-stream" : "text/plain; charset=utf-8", "Cache-Control": "no-store", "Content-Length": bytes.length });
        response.flushHeaders();
        response.once("finish", () => { attempt.finishedAt = Date.now(); });
        response.once("close", () => { attempt.closedAt = Date.now(); if (!attempt.finishedAt) attempt.aborted = true; });
        const finish = () => { if (!response.destroyed) response.end(bytes); };
        if (kind === "failed") { response.write(bytes.subarray(0, 1)); setImmediate(() => response.destroy()); }
        else if (kind === "gate") { const pending = gates.get(key) ?? []; pending.push(finish); gates.set(key, pending); }
        else finish();
      });
      return true;
    }
  };
}

// Serialized into the original worker. Nonselected calls return the exact
// original Promise. The optional fault delays only publication AFTER native ACK.
export function installResponseBodyProbe(api, target, options) {
  const { tabId, scope, id, holdTimeoutMs = 30000 } = options;
  if (target.__responseBodyProbe || target.__integrationNativeRPCObserver || !Number.isSafeInteger(tabId) || !id ||
      !scope?.session_id || !scope.turn_id || !Number.isSafeInteger(scope.control_epoch) || !Number.isInteger(holdTimeoutMs) || holdTimeoutMs < 10 || holdTimeoutMs > 30000)
    throw Error("Response body probe already installed or invalid");
  const original = api.debugger.sendCommand, rows = [], requests = new Set();
  let sequence = 0, pending = 0, held = false, holdNext = false, released = false, releaseGate, timer, expired = false, overflow = false, restored = false;
  const append = value => { if (rows.length >= 2048) { overflow = true; return { sequence: -1 }; } const row = { sequence: ++sequence, at: Date.now(), ...value }; rows.push(row); return row; };
  const release = () => { clearTimeout(timer); released = true; if (releaseGate) { append({ kind: "release" }); releaseGate(); releaseGate = null; } };
  function wrapper(...args) {
    const [source, method, params] = args;
    if (source?.tabId === tabId && ["Network.loadNetworkResource", "Fetch.enable"].includes(method))
      append({ kind: "alternative-native", source: { ...source }, method });
    if (source?.tabId !== tabId || method !== "Network.getResponseBody") return Reflect.apply(original, this, args);
    const call = append({ kind: "native", source: { ...source }, method, params: structuredClone(params) }), selected = holdNext; holdNext = false; pending++;
    let actual; try { actual = Reflect.apply(original, this, args); } catch (error) { pending--; append({ kind: "native-rejected", call: call.sequence }); throw error; }
    const observed = actual.then(async value => {
      append({ kind: "native-ack", call: call.sequence, result: typeof value?.body === "string" && value.body.length <= 16384 ? structuredClone(value) : { bodyCharacters: value?.body?.length, base64Encoded: value?.base64Encoded } });
      if (selected && !released) { held = true; append({ kind: "held", call: call.sequence }); await new Promise(resolve => { releaseGate = resolve; timer = setTimeout(() => { expired = true; release(); }, holdTimeoutMs); }); }
      append({ kind: "delivered", call: call.sequence }); return value;
    }, error => { append({ kind: "native-rejected", call: call.sequence }); throw error; }).finally(() => { pending--; }); observed.catch(() => {}); return selected ? observed : actual;
  }
  const event = (source, method, params) => {
    if (source?.tabId !== tabId || !["Network.requestWillBeSent", "Network.responseReceived", "Network.loadingFinished", "Network.loadingFailed"].includes(method)) return;
    const url = params.request?.url ?? params.response?.url, key = `${source.sessionId ?? "root"}:${params.requestId}`;
    if (url?.includes("/response-body/")) requests.add(key);
    if (!requests.has(key)) return;
    append({ kind: "event", source: { ...source }, method, requestId: params.requestId, ...(url ? { url } : {}), ...(params.response ? { status: params.response.status } : {}), ...(params.errorText ? { error: params.errorText } : {}) });
  };
  const rpc = (direction, message) => {
    const p = message.params;
    if (direction === "request" && message.method === "browserAction" && p?.tabId === tabId && p.action === "responseBody") {
      append({ kind: "request", message: structuredClone(message) }); requests.add(`rpc:${message.id}`);
    } else if (direction === "response" && requests.has(`rpc:${message.id}`)) append({ kind: "response", id: message.id, ok: !message.error, error: message.error?.message });
  };
  const snapshot = () => structuredClone({ id, tabId, scope, rows, pending, held, released, expired, overflow, restored });
  const controller = { snapshot, hold() { if (pending || held || holdNext) throw Error("Body hold already used or pending"); holdNext = true; released = false; }, release,
    restore() { release(); if (pending) throw Error("Original body delivery still pending"); if (api.debugger.sendCommand !== wrapper || target.__integrationNativeRPCObserver !== rpc || target.__responseBodyProbe !== controller) throw Error("Body probe identity changed");
      api.debugger.sendCommand = original; api.debugger.onEvent.removeListener(event); delete target.__integrationNativeRPCObserver; delete target.__responseBodyProbe; restored = true; return snapshot(); } };
  api.debugger.sendCommand = wrapper; api.debugger.onEvent.addListener(event); target.__integrationNativeRPCObserver = rpc; target.__responseBodyProbe = controller; return snapshot();
}

export function readResponseBodyDocument() { return { href: location.href, evidence: globalThis.responseBodyEvidence ?? null }; }
const scopeOf = browser => ({ session_id: browser.client.sessionId, turn_id: browser.client.turnId, control_epoch: browser.client.controlEpoch });
const errorText = error => error?.stack ?? String(error);
const outcome = promise => promise.then(value => ({ ok: true, value, at: Date.now() }), error => ({ ok: false, error: errorText(error), at: Date.now() }));
const targetOf = (tab, layout) => layout === "root" ? tab : tab.frameLocator("#response-frame");
async function documents(worker, tabId) { return worker.evaluate(`chrome.scripting.executeScript({target:{tabId:${tabId},allFrames:true},world:'MAIN',func:${readResponseBodyDocument.toString()}})`); }
export function selectResponseBodyTargets(targets, tabId, key, oopifs = []) {
  const ids = new Set(oopifs.filter(event => event.tabId === tabId && event.source?.tabId === tabId && event.type === "iframe").map(event => event.targetId));
  return targets.filter(target => {
    if (target.tabId === tabId || ids.has(target.id)) return true;
    if (target.type !== "other") return false;
    try { const url = new URL(target.url); return url.pathname === "/response-body/frame" && url.searchParams.get("key") === key; }
    catch { return false; }
  });
}
export function checkResponseBodyOOPIF(native, { tabId, rootURL, childURL }) {
  assert.equal(native.tab.id, tabId);
  const roots = native.frames.filter(frame => frame.frameId === 0 && frame.url === rootURL), children = native.frames.filter(frame => frame.frameId !== 0 && frame.url === childURL);
  assert.equal(roots.length, 1); assert.equal(children.length, 1);
  const root = roots[0], child = children[0];
  assert.equal(child.parentFrameId, 0); assert.equal(child.parentDocumentId, root.documentId);
  for (const frame of [root, child]) { assert.ok(frame.documentId); assert.ok(Number.isSafeInteger(frame.processId) && frame.processId > 0); assert.equal(frame.documentLifecycle, "active"); assert.equal(frame.errorOccurred, false); }
  assert.notEqual(root.documentId, child.documentId); assert.notEqual(root.processId, child.processId, "Real OOPIF process required");
  const parents = native.targets.filter(target => target.tabId === tabId && target.type === "page" && target.url === rootURL && target.attached);
  assert.equal(parents.length, 1);
  const matches = native.oopifs.filter(event => event.tabId === tabId && event.source?.tabId === tabId && event.source.sessionId === undefined && event.type === "iframe" && event.targetId && event.sessionId)
    .flatMap(event => native.targets.filter(target => target.id === event.targetId && target.type === "other" && target.url === childURL && target.attached).map(target => ({ event, target })));
  assert.equal(matches.length, 1, "Original iframe attachment must match current native target");
  const { event, target } = matches[0]; assert.notEqual(target.id, parents[0].id);
  return { targetId: target.id, sessionId: event.sessionId, rootTargetId: parents[0].id, documentId: child.documentId, rootDocumentId: root.documentId, frameId: child.frameId, processId: child.processId, rootProcessId: root.processId };
}
async function nativeState(worker, tabId, key) { return worker.evaluate(`(async()=>{const oopifs=(globalThis.__integrationFrames??[]).filter(event=>event.tabId===${tabId});return{tab:await chrome.tabs.get(${tabId}),frames:await chrome.webNavigation.getAllFrames({tabId:${tabId}}),oopifs,targets:(${selectResponseBodyTargets.toString()})(await chrome.debugger.getTargets(),${tabId},${json(key)},oopifs)}})()`); }
async function install(worker, item) { item.installation = await worker.evaluate(`(${installResponseBodyProbe.toString()})(chrome,globalThis,${json({ id: item.id, tabId: item.tabId, scope: item.scope })})`); }
async function restore(worker, item, until) {
  await worker.evaluate("globalThis.__responseBodyProbe?.release()");
  await until(() => worker.evaluate("!globalThis.__responseBodyProbe || globalThis.__responseBodyProbe.snapshot().pending===0"), "original native body delivery settles");
  item.probe = await worker.evaluate("globalThis.__responseBodyProbe?.restore()");
}
// Page.close acknowledges dispatch of beforeunload, not removal from the tab
// strip. Keep its native Promise unchanged and observe actual removal separately.
// Chromium 156: content/browser/devtools/protocol/page_handler.cc:715-723.
export function installResponseBodyCloseProbe(api, target, { id, tabIds, targetIds }) {
  const key = "__responseBodyCloseProbe";
  if (target[key]) throw Error("Response close observer already installed");
  const original = api.debugger.sendCommand, nativeThen = Promise.prototype.then;
  const watched = new Set(tabIds), ownedTargets = new Set(targetIds), rows = [], pending = new Set();
  let overflow = false, restored = false;
  const append = value => {
    if (rows.length >= 1024) { overflow = true; return; }
    rows.push(structuredClone({ sequence: rows.length + 1, ...value }));
  };
  const track = promise => {
    pending.add(promise);
    nativeThen.call(promise, () => pending.delete(promise), () => pending.delete(promise));
    return promise;
  };
  const wrapper = function (...args) {
    const [source, method, params] = args;
    if (!watched.has(source?.tabId) || source.sessionId != null || typeof method !== "string" || (method !== "Page.close" && !method.startsWith("Input."))) return Reflect.apply(original, this, args);
    const call = rows.length + 1;
    append({ kind: "native", source, method, params: params ?? {} });
    let promise;
    try { promise = Reflect.apply(original, this, args); }
    catch (error) { append({ kind: "native-settled", call, ok: false, synchronous: true, error: String(error) }); throw error; }
    track(promise);
    nativeThen.call(promise, value => append({ kind: "native-settled", call, ok: true, value }),
      error => append({ kind: "native-settled", call, ok: false, error: String(error) }));
    return promise;
  };
  const removed = (tabId, info) => { if (watched.has(tabId)) append({ kind: "removed", tabId, info }); };
  const snapshot = () => structuredClone({ id, tabIds, targetIds, rows, pending: pending.size, overflow, restored });
  const controller = {
    snapshot,
    async inventory() {
      // Both original native reads remain tracked even if their observer deadline
      // expires, or one rejects before the other has actually settled.
      const [tabs, targets] = await Promise.all([track(api.tabs.query({})), track(api.debugger.getTargets())]);
      return { tabIds, targetIds, tabs: tabs.filter(tab => watched.has(tab.id)),
        targets: targets.filter(value => watched.has(value.tabId) || ownedTargets.has(value.id)), probePresent: !!target.__responseBodyProbe };
    },
    restore() {
      if (pending.size) throw Error("Original close observer native operations still pending");
      if (target[key] !== controller || api.debugger.sendCommand !== wrapper) throw Error("Response close observer identity changed");
      api.debugger.sendCommand = original; api.tabs.onRemoved.removeListener(removed);
      restored = true; const result = snapshot(); delete target[key]; return result;
    }
  };
  api.debugger.sendCommand = wrapper; api.tabs.onRemoved.addListener(removed); target[key] = controller;
  return snapshot();
}

export async function closeResponseBodyTabs(browser, worker, items, detail, { timeoutMs = 5000, pollMs = 100 } = {}) {
  const tabIds = [...new Set(items.map(item => item.tabId).filter(Number.isSafeInteger))];
  const targetIds = [...new Set(items.flatMap(item => [item.nativeBefore, item.nativeAfter].flatMap(state => (state?.targets ?? []).map(target => target.id))))];
  const evidence = detail.closeEvidence = { id: randomUUID(), tabIds, targetIds, timeoutMs, attempts: [], observations: 0, timedOut: false };
  const timeout = () => Object.assign(new Error("Timed out observing original response-body tab removal"), { code: "OBU_TEST_CLOSE_OBSERVATION_TIMEOUT" });
  const bounded = async (operation, budget) => {
    let timer;
    try { return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(timeout()), Math.max(0, budget)); })]); }
    finally { clearTimeout(timer); }
  };
  const control = method => worker.evaluate(`globalThis.__responseBodyCloseProbe.${method}()`);
  let installed = false, failure;
  try {
    evidence.installation = await worker.evaluate(`(${installResponseBodyCloseProbe.toString()})(chrome,globalThis,${json(evidence)})`); installed = true;
    evidence.initial = await bounded(control("inventory"), timeoutMs);
    evidence.alreadyAbsent = tabIds.filter(id => !evidence.initial.tabs.some(tab => tab.id === id));
    for (const id of tabIds.filter(id => !evidence.alreadyAbsent.includes(id))) {
      const attempt = { tabId: id }; evidence.attempts.push(attempt);
      try { attempt.value = await browser.tab(id).close(); attempt.ok = true; }
      catch (error) { attempt.ok = false; attempt.error = errorText(error); throw error; }
    }
    // This observation budget begins after the original close calls. It neither
    // changes their deadlines nor retries close, input, or a failed native read.
    const deadline = performance.now() + timeoutMs;
    while (true) {
      if (performance.now() >= deadline) throw timeout();
      const inventory = await bounded(control("inventory"), deadline - performance.now());
      detail.cleanup = inventory; evidence.observations++;
      evidence.firstAfterClose ??= inventory; evidence.final = inventory;
      if (performance.now() >= deadline) throw timeout();
      evidence.observer = await bounded(control("snapshot"), deadline - performance.now());
      if (performance.now() >= deadline) throw timeout();
      const probe = evidence.observer;
      assert.equal(probe.overflow, false); assert.equal(probe.id, evidence.id);
      assert.equal(probe.rows.some(row => row.kind === "native" && row.method.startsWith("Input.")), false);
      let removedAll = true;
      for (const attempt of evidence.attempts) {
        const calls = probe.rows.filter(row => row.kind === "native" && row.method === "Page.close" && row.source.tabId === attempt.tabId);
        assert.equal(calls.length, 1, "Each original tab closes exactly once");
        const acks = probe.rows.filter(row => row.kind === "native-settled" && row.call === calls[0].sequence);
        assert.equal(acks.length, 1); assert.equal(acks[0].ok, true); assert.ok(acks[0].sequence > calls[0].sequence);
        const events = probe.rows.filter(row => row.kind === "removed" && row.tabId === attempt.tabId);
        assert.ok(events.length <= 1); if (!events.length) removedAll = false;
        else assert.ok(events[0].sequence > calls[0].sequence);
      }
      if (!inventory.tabs.length && !inventory.targets.length && removedAll && probe.pending === 0) {
        assert.equal(inventory.probePresent, false); break;
      }
      await new Promise(resolve => setTimeout(resolve, Math.min(pollMs, Math.max(0, deadline - performance.now()))));
    }
  } catch (error) {
    failure = error; evidence.error = errorText(error); evidence.timedOut = error?.code === "OBU_TEST_CLOSE_OBSERVATION_TIMEOUT";
  } finally {
    if (installed) {
      try { evidence.observer = await bounded(control("snapshot"), 1000); }
      catch (error) { evidence.snapshotError = errorText(error); failure ??= error; }
      try { evidence.restoration = await bounded(control("restore"), 1000); }
      catch (error) { evidence.restoreError = errorText(error); failure ??= error; }
    }
  }
  if (failure) throw failure;
}
async function openCase({ browser, worker, fixtureURL, entry, layout, detail }) {
  const key = `body-${entry}-${layout}-${randomUUID().replaceAll("-", "")}`, tab = await browser.newTab();
  const item = { id: randomUUID(), key, layout, tabId: tab.id, scope: scopeOf(browser), reads: [], passed: false }; detail.cases.push(item);
  await install(worker, item);
  await browser.cdp.navigate(tab.id, responseBodyURL(fixtureURL, key, layout));
  item.initial = await tab.diagnostics({ limit: 200 });
  if (layout === "dynamic-oopif") await tab.getByRole("button", { name: "Add response frame", exact: true }).click();
  await targetOf(tab, layout).getByRole("heading", { name: `Original response body ${layout === "root" ? "root" : "child"}`, exact: true }).textContent();
  item.before = await documents(worker, tab.id); item.nativeBefore = await nativeState(worker, tab.id, key);
  assert.equal(item.nativeBefore.tab.active, false);
  if (layout !== "root") {
    const childURL = new URL(item.nativeBefore.tab.url); childURL.hostname = "localhost"; childURL.pathname = "/response-body/frame";
    item.oopif = checkResponseBodyOOPIF(item.nativeBefore, { tabId: tab.id, rootURL: responseBodyURL(fixtureURL, key, layout), childURL: childURL.href });
  }
  return { tab, item, target: targetOf(tab, layout) };
}
async function diagnosticResponses(tab, item, kind, until, count = 1, eventKind = "response") {
  let capture, events;
  await until(async () => { capture = await tab.diagnostics({ after: item.initial.cursor, limit: 200 }); events = capture.entries.filter(e => e.kind === eventKind && e.url?.includes(`/response-body/`) && new URL(e.url).searchParams.get("kind") === kind); return events.length >= count; }, `original ${kind} diagnostic ${eventKind}`);
  assert.equal(capture.captureId, item.initial.captureId); assert.equal(events.length, count); return { capture, events };
}

export function checkOriginalResponseBody(value, reference, attempt) {
  assert.deepEqual(Object.keys(value).sort(), ["captureId", "requestId", "encoding", "data", "byteLength"].sort());
  assert.equal(value.captureId, reference.captureId); assert.equal(value.requestId, reference.requestId); assert.equal(value.encoding, "base64");
  const bytes = Buffer.from(value.data, "base64"); assert.equal(bytes.toString("base64"), value.data); assert.equal(bytes.length, value.byteLength);
  assert.equal(value.data, attempt.responseBase64); assert.equal(sha(bytes), attempt.responseSHA256); assert.equal(bytes.length, attempt.responseBytes);
  return { byteLength: bytes.length, sha256: sha(bytes) };
}
export function checkResponseBodyEvidence(item, stats, kinds = responseBodyKinds) {
  assert.equal(stats.overflow, false); const api = stats.attempts.filter(x => new URL(x.path, "http://localhost").pathname === "/response-body/api");
  assert.deepEqual(api.map(x => x.value.kind), kinds); assert.ok(stats.attempts.every(x => x.method === (x.path.startsWith("/response-body/page") || x.path.startsWith("/response-body/frame") ? "GET" : "POST")));
  const original = item.before.find(x => x.result.evidence?.child === (item.layout !== "root")), final = item.after.find(x => x.documentId === original.documentId);
  assert.ok(original && final); assert.equal(final.frameId, original.frameId); assert.equal(final.result.evidence.documentToken, original.result.evidence.documentToken); assert.equal(final.result.evidence.nonce, original.result.evidence.nonce);
  assert.deepEqual(final.result.evidence.clicks.map(x => [x.kind, x.trusted]), kinds.map(x => [x, true])); assert.deepEqual(final.result.evidence.errors, []);
  assert.equal(final.result.evidence.completions.length, kinds.length); assert.equal(item.reads.length, kinds.length);
  assert.equal(item.probe.overflow, false); assert.equal(item.probe.expired, false); assert.equal(item.probe.restored, true); assert.equal(item.probe.pending, 0);
  assert.equal(item.probe.rows.filter(row => row.kind === "alternative-native").length, 0);
  const native = item.probe.rows.filter(x => x.kind === "native"), requests = item.probe.rows.filter(x => x.kind === "request"); assert.equal(native.length, kinds.length); assert.equal(requests.length, kinds.length);
  for (let n = 0; n < kinds.length; n++) {
    const attempt = api[n], read = item.reads[n], source = original.result.evidence;
    assert.equal(attempt.method, "POST"); assert.ok(attempt.finishedAt); assert.equal(attempt.value.trusted, true); assert.equal(attempt.value.nonce, source.nonce); assert.equal(attempt.value.documentToken, source.documentToken);
    const bytes = Buffer.from(attempt.bodyBase64, "base64"); assert.equal(bytes.length, attempt.bodyBytes); assert.equal(sha(bytes), attempt.bodySHA256);
    const completion = final.result.evidence.completions.find(x => x.kind === kinds[n]); assert.equal(completion.data, attempt.responseBase64); assert.equal(completion.byteLength, attempt.responseBytes); assert.equal(completion.status, attempt.status);
    checkOriginalResponseBody(read.value, read.reference, attempt);
    const p = requests[n].message.params; for (const [field, v] of Object.entries(item.scope)) assert.equal(p[field], v); assert.equal(p.tabId, item.tabId); assert.deepEqual(p.args, { ...read.reference, maxBytes: 4096 });
    const call = native[n], ack = item.probe.rows.filter(x => x.kind === "native-ack" && x.call === call.sequence), response = item.probe.rows.filter(x => x.kind === "response" && x.id === requests[n].message.id);
    assert.equal(ack.length, 1); assert.equal(response.length, 1); assert.equal(response[0].ok, true); assert.ok(requests[n].sequence < call.sequence && call.sequence < ack[0].sequence && ack[0].sequence < response[0].sequence);
    const originalResponse = item.probe.rows.find(x => x.kind === "event" && x.method === "Network.responseReceived" && x.requestId === call.params.requestId && (x.source.sessionId ?? null) === (call.source.sessionId ?? null));
    assert.equal(originalResponse.url, read.event.url); assert.equal(originalResponse.status, attempt.status);
  }
  return { requests: api.length, reads: item.reads.length, responseBytes: api.reduce((n, x) => n + x.responseBytes, 0), originalDocumentId: original.documentId };
}

export function checkResponseBodyEdgesEvidence(detail) {
  const expected = [
    ["body-gate", ["gate"], 1, 1], ["identity-and-limits", ["binary", "pair", "pair"], 5, 0],
    ["redirect-and-failure", ["redirect", "redirect", "failed"], 1, 0], ["wait-id-and-turn", ["utf8"], 0, 0], ["late-native-Pause", ["utf8"], 1, 0]
  ];
  assert.equal(detail.cases.length, expected.length);
  for (const [index, [name, kinds, nativeCount, releases]] of expected.entries()) {
    const item = detail.cases[index], stats = item.server;
    assert.ok(item.key.startsWith(`body-${name}-`)); assert.equal(stats.overflow, false);
    assert.equal(stats.documents.length, 1); assert.equal(stats.attempts.filter(x => x.method === "GET").length, 1);
    assert.ok(stats.attempts.every(x => x.method === (x.path.startsWith("/response-body/page?") ? "GET" : "POST")));
    const api = stats.attempts.filter(x => /^\/response-body\/(api|final)\?/.test(x.path));
    assert.deepEqual(api.map(x => x.value?.kind), kinds); assert.equal(stats.attempts.filter(x => x.path.startsWith("/response-body/release?")).length, releases);
    const before = item.before.find(x => x.result.evidence?.child === false), after = item.after.find(x => x.documentId === before.documentId);
    assert.ok(after); assert.equal(after.frameId, before.frameId); assert.equal(after.result.evidence.documentToken, before.result.evidence.documentToken);
    for (const request of api) {
      assert.equal(request.value.trusted, true); assert.equal(request.value.documentToken, before.result.evidence.documentToken); assert.equal(request.value.nonce, before.result.evidence.nonce);
      const bytes = Buffer.from(request.bodyBase64, "base64"); assert.equal(bytes.length, request.bodyBytes); assert.equal(sha(bytes), request.bodySHA256);
    }
    const probe = item.probe; assert.equal(probe.restored, true); assert.equal(probe.pending, 0); assert.equal(probe.expired, false); assert.equal(probe.overflow, false);
    assert.equal(probe.rows.filter(row => row.kind === "alternative-native").length, 0);
    const calls = probe.rows.filter(x => x.kind === "native"); assert.equal(calls.length, nativeCount, `${name}: exact original native body read count`);
    for (const call of calls) {
      const ack = probe.rows.filter(x => x.kind === "native-ack" && x.call === call.sequence), delivered = probe.rows.filter(x => x.kind === "delivered" && x.call === call.sequence);
      assert.equal(ack.length, 1); assert.equal(delivered.length, 1); assert.ok(call.sequence < ack[0].sequence && ack[0].sequence < delivered[0].sequence);
    }
    if (name === "late-native-Pause") {
      const held = probe.rows.filter(x => x.kind === "held"), released = probe.rows.filter(x => x.kind === "release"); assert.equal(held.length, 1); assert.equal(released.length, 1);
      assert.ok(probe.rows.find(x => x.kind === "native-ack").sequence < held[0].sequence && held[0].sequence < released[0].sequence && released[0].sequence < probe.rows.find(x => x.kind === "delivered").sequence);
      assert.equal(item.expiredRead.ok, false); assert.equal(item.failedPause.ok, false); assert.equal(item.retryPause.value.cleanupComplete, true); assert.equal(item.resume.ok, true);
      checkResponseBodyPauseFailure(item);
      assert.equal(probe.rows.filter(x => x.kind === "response" && x.ok).length, 0, "Expired original read cannot publish late success");
    }
  }
  return { cases: 5, originalPostAttempts: 9, explicitReleasePosts: 1, nativeReads: 8, noRefetch: true };
}

export function checkResponseBodyPauseFailure(item) {
  assert.equal(item.cleanupTimeoutMs, 10000);
  assert.equal(item.failedPause.ok, false);
  assert.match(item.failedPause.error, /^OBU_AUTOMATION_PAUSE_FAILED: OBU_AUTOMATION_CLEANUP_TIMEOUT:/);
  assert.equal(item.failedPause.state.inputBlocked, true); assert.equal(item.failedPause.state.cleanupComplete, false); assert.equal(item.failedPause.state.state, "error");
  assert.ok(item.pauseSettledAt - item.pauseStartedAt >= item.cleanupTimeoutMs, "Original cleanup budget must actually expire");
}

// Only responseBody changes public entry point. All setup/trigger/cleanup is
// explicitly JS-owned; external callers never fabricate their own request IDs.
export async function checkResponseBodyMatrix({ browser, worker, fixtureURL, server, until, readBody = (tab, ref, options) => tab.responseBody(ref, options), entry = "js", detail = {} }) {
  Object.assign(detail, { entry, scope: "Five entry response-body reads; JS-owned trusted trigger and cleanup", cases: [], cleanupErrors: [], passed: false });
  let failure;
  try {
    for (const layout of layouts) {
      const { tab, item, target } = await openCase({ browser, worker, fixtureURL, entry, layout, detail });
      let itemFailure;
      try {
        for (const kind of responseBodyKinds) {
          await target.getByRole("button", { name: `Send ${kind}`, exact: true }).click();
          const { capture, events } = await diagnosticResponses(tab, item, kind, until), event = events[0], reference = { captureId: capture.captureId, requestId: event.requestId };
          const read = { kind, event, reference, startedAt: Date.now() }; item.reads.push(read);
          read.value = await readBody(tab, reference, { maxBytes: 4096, timeoutMs: 10000 }); read.completedAt = Date.now();
          await until(() => server.stats(item.key).attempts.some(x => x.value?.kind === kind && x.finishedAt), "original response finish");
        }
        await until(async () => (await documents(worker, tab.id)).some(x => x.result.evidence?.completions.length === responseBodyKinds.length), "original document consumes all bodies");
        item.after = await documents(worker, tab.id); item.nativeAfter = await nativeState(worker, tab.id, item.key); assert.equal(item.nativeAfter.tab.active, false);
      } catch (error) { itemFailure = error; item.error = errorText(error); }
      try { await restore(worker, item, until); }
      catch (error) { detail.cleanupErrors.push(errorText(error)); itemFailure ??= error; }
      if (itemFailure) throw itemFailure;
      item.server = server.stats(item.key); item.proof = checkResponseBodyEvidence(item, item.server); item.passed = true;
    }
  } catch (error) { failure = error; detail.error = errorText(error); }
  finally {
    try { const active = detail.cases.at(-1); if (active && !active.probe) await restore(worker, active, until); }
    catch (error) { detail.cleanupErrors.push(errorText(error)); failure ??= error; }
    try { await closeResponseBodyTabs(browser, worker, detail.cases, detail); } catch (error) { detail.cleanupErrors.push(errorText(error)); failure ??= error; }
    detail.server = detail.cases.map(item => server.stats(item.key));
  }
  if (failure) { failure.responseBodyDetail = detail; throw failure; } detail.passed = true; return detail;
}

export async function checkResponseBodyEdges({ browser, worker, fixtureURL, server, until, detail = {} }) {
  Object.assign(detail, { entry: "js-edges", cases: [], cleanupErrors: [], passed: false, pauseAttempted: false,
    boundary: "Native ACK publication hold retains the original Promise/value; it is not a pending raster/network task or a synthetic native success. No failed read, POST or native command is replayed." });
  let failure;
  const backend = (method, revision) => worker.evaluate(`(async()=>{const b=globalThis.__integrationBackend;try{return{ok:true,value:await b[${json(method)}](${revision === undefined ? "" : json(revision)})}}catch(e){return{ok:false,error:String(e?.message??e),state:b.automationControl.status()}}})()`);
  const run = async (name, action) => {
    const ctx = await openCase({ browser, worker, fixtureURL, entry: name, layout: "root", detail }), { item, tab } = ctx;
    let primary; const pending = [];
    try { await action({ ...ctx, pending }); }
    catch (error) { primary = error; item.error = errorText(error); }
    finally {
      server.release(item.key);
      try { await worker.evaluate("globalThis.__responseBodyProbe?.release()"); await Promise.all(pending); await restore(worker, item, until); }
      catch (error) { detail.cleanupErrors.push(errorText(error)); primary ??= error; }
      item.server = server.stats(item.key);
      try { item.after = await documents(worker, tab.id); } catch (error) { item.afterError = errorText(error); primary ??= error; }
      try { if (item.probe) { assert.equal(item.probe.expired, false); assert.equal(item.probe.overflow, false); } }
      catch (error) { detail.cleanupErrors.push(errorText(error)); primary ??= error; }
    }
    if (primary) throw primary;
    item.passed = true;
    await tab.close();
  };
  const trigger = async ({ tab, target, item }, kind, count = 1, eventKind = "response") => {
    await target.getByRole("button", { name: `Send ${kind}`, exact: true }).click();
    const { capture, events } = await diagnosticResponses(tab, item, kind, until, count, eventKind);
    return events.map(event => ({ event, ref: { captureId: capture.captureId, requestId: event.requestId } }));
  };
  const reject = async (promise, pattern) => { const result = await outcome(promise); assert.equal(result.ok, false); assert.match(result.error, pattern); return result; };
  try {
    await run("body-gate", async ctx => {
      const [{ ref }] = await trigger(ctx, "gate"); const stats = server.stats(ctx.item.key);
      assert.ok(stats.attempts.find(x => x.value?.kind === "gate").headersAt); assert.equal(stats.attempts.find(x => x.value?.kind === "gate").finishedAt, undefined);
      let settled = false; const result = outcome(ctx.tab.responseBody(ref, { timeoutMs: 10000 })).then(value => { settled = true; return value; }); ctx.pending.push(result);
      await until(() => worker.evaluate("globalThis.__responseBodyProbe.snapshot().rows.some(r=>r.kind==='request')"), "original waiting responseBody admitted");
      ctx.item.heldBeforeRelease = await worker.evaluate("globalThis.__responseBodyProbe.snapshot()"); assert.equal(settled, false); assert.equal(ctx.item.heldBeforeRelease.rows.filter(x => x.kind === "native").length, 0);
      await ctx.target.getByRole("button", { name: "Release original body", exact: true }).click({ timeoutMs: 3000 });
      ctx.item.result = await result; assert.equal(ctx.item.result.ok, true);
      const attempt = server.stats(ctx.item.key).attempts.find(x => x.value?.kind === "gate"); checkOriginalResponseBody(ctx.item.result.value, ref, attempt);
      const releases = server.stats(ctx.item.key).attempts.filter(x => x.path.startsWith("/response-body/release")); assert.equal(releases.length, 1); assert.equal(releases[0].value.trusted, true);
    });
    await run("identity-and-limits", async ctx => {
      const [{ ref }] = await trigger(ctx, "binary"); ctx.item.limit = await reject(ctx.tab.responseBody(ref, { maxBytes: 3 }), /OBU_RESPONSE_BODY_TOO_LARGE/);
      const attempt = server.stats(ctx.item.key).attempts.find(x => x.value?.kind === "binary");
      ctx.item.repeat = [];
      for (let n = 0; n < 2; n++) { const value = await ctx.tab.responseBody(ref); checkOriginalResponseBody(value, ref, attempt); ctx.item.repeat.push(value); }
      const afterRepeated = await worker.evaluate("globalThis.__responseBodyProbe.snapshot()"); assert.equal(afterRepeated.rows.filter(x => x.kind === "native").length, 3, "Every explicit read uses original native once; no response cache");
      const pair = await trigger(ctx, "pair", 2); assert.notEqual(pair[0].ref.requestId, pair[1].ref.requestId); assert.equal(pair[0].event.url, pair[1].event.url);
      const results = await Promise.all(pair.map(async value => ({ ...value, body: await ctx.tab.responseBody(value.ref) })));
      const originals = server.stats(ctx.item.key).attempts.filter(x => x.value?.kind === "pair"); assert.equal(originals.length, 2);
      assert.deepEqual(results.map(x => x.body.data).sort(), originals.map(x => x.responseBase64).sort()); assert.notEqual(results[0].body.data, results[1].body.data); ctx.item.sameURL = results;
      await browser.client.detach(ctx.tab.id); const next = await ctx.tab.diagnostics(); assert.notEqual(next.captureId, ref.captureId);
      ctx.item.oldCapture = await reject(ctx.tab.responseBody(ref), /OBU_RESPONSE_BODY_EXPIRED/);
    });
    await run("redirect-and-failure", async ctx => {
      const redirects = await trigger(ctx, "redirect", 2), first = redirects.find(x => x.event.status === 307), last = redirects.find(x => x.event.status === 200);
      assert.ok(first && last); assert.equal(last.event.redirectedFrom, first.ref.requestId);
      ctx.item.redirectOld = await reject(ctx.tab.responseBody(first.ref), /OBU_RESPONSE_BODY_UNAVAILABLE/);
      ctx.item.redirectFinal = await ctx.tab.responseBody(last.ref); checkOriginalResponseBody(ctx.item.redirectFinal, last.ref, server.stats(ctx.item.key).attempts.find(x => x.path.startsWith("/response-body/final")));
      const [{ ref }] = await trigger(ctx, "failed", 1, "requestfailed"); ctx.item.failed = await reject(ctx.tab.responseBody(ref), /OBU_RESPONSE_BODY_FAILED/);
    });
    await run("wait-id-and-turn", async ctx => {
      const wait = await ctx.tab.expectResponse({ url: `/response-body/api?key=${ctx.item.key}&kind=utf8`, urlMatch: "contains" }, { timeoutMs: 10000 });
      let ref;
      try { [{ ref }] = await trigger(ctx, "utf8"); const event = await wait.result(); assert.notEqual(event.requestId, ref.requestId);
        ctx.item.networkWaitID = await reject(ctx.tab.responseBody({ captureId: ref.captureId, requestId: event.requestId }), /OBU_RESPONSE_BODY_(EXPIRED|UNAVAILABLE)/);
      } finally { await wait.cancel(); }
      const originalScope = { ...ctx.item.scope };
      ctx.item.finalized = await browser.client.finalizeTabs([{ tabId: ctx.tab.id, status: "handoff" }]);
      ctx.item.oldTurn = await reject(browser.client.request("browserAction", { ...originalScope, tabId: ctx.tab.id, action: "responseBody", args: ref, timeoutMs: 1000 }), /STALE|ENDED|ENDING/);
      await browser.client.beginTurn(); await browser.client.attach(ctx.tab.id);
      ctx.item.newTurnOldCapture = await reject(ctx.tab.responseBody(ref), /OBU_RESPONSE_BODY_EXPIRED/);
    });
    await run("late-native-Pause", async ctx => {
      ctx.item.cleanupTimeoutMs = await worker.evaluate("globalThis.__integrationBackend.automationCleanupTimeoutMs"); assert.equal(ctx.item.cleanupTimeoutMs, 10000);
      const [{ ref }] = await trigger(ctx, "utf8"); await worker.evaluate("globalThis.__responseBodyProbe.hold()");
      ctx.item.submittedAt = Date.now(); const result = outcome(ctx.tab.responseBody(ref, { timeoutMs: 1000 })); ctx.pending.push(result);
      await until(() => worker.evaluate("globalThis.__responseBodyProbe.snapshot().held"), "original native body ACK held");
      ctx.item.held = await worker.evaluate("globalThis.__responseBodyProbe.snapshot()"); assert.equal(ctx.item.held.pending, 1); assert.equal(ctx.item.held.expired, false);
      ctx.item.expiredRead = await result; assert.equal(ctx.item.expiredRead.ok, false); assert.match(ctx.item.expiredRead.error, /OBU_RESPONSE_BODY_TIMEOUT|Timeout|timed out/i);
      detail.pauseAttempted = true; ctx.item.pauseStartedAt = Date.now(); ctx.item.failedPause = await backend("pauseAutomation"); ctx.item.pauseSettledAt = Date.now(); checkResponseBodyPauseFailure(ctx.item);
      const held = await worker.evaluate("globalThis.__responseBodyProbe.snapshot()"); assert.equal(held.pending, 1); assert.equal(held.expired, false);
      ctx.item.earlyResume = await backend("resumeAutomation", ctx.item.failedPause.state.revision); assert.equal(ctx.item.earlyResume.ok, false);
      await worker.evaluate("globalThis.__responseBodyProbe.release()"); await until(() => worker.evaluate("globalThis.__responseBodyProbe.snapshot().pending===0"), "same native body Promise delivered");
      ctx.item.retryPause = await backend("pauseAutomation"); assert.equal(ctx.item.retryPause.ok, true); assert.equal(ctx.item.retryPause.value.cleanupComplete, true);
      ctx.item.resume = await backend("resumeAutomation", ctx.item.retryPause.value.revision); assert.equal(ctx.item.resume.ok, true); detail.pauseAttempted = false; detail.globalPauseExercised = true;
      ctx.item.oldScope = await reject(browser.client.request("getTabs", ctx.item.scope), /STALE|ENDED|ENDING/);
      await browser.client.beginTurn(); await browser.client.attach(ctx.tab.id);
      ctx.item.oldReference = await reject(ctx.tab.responseBody(ref), /OBU_RESPONSE_BODY_EXPIRED/);
      const final = await worker.evaluate("globalThis.__responseBodyProbe.snapshot()"); assert.equal(final.rows.filter(x => x.kind === "native").length, 1); assert.equal(final.rows.filter(x => x.kind === "delivered").length, 1);
      assert.equal(server.stats(ctx.item.key).attempts.filter(x => x.path.startsWith("/response-body/api")).length, 1);
    });
  } catch (error) { failure = error; detail.error = errorText(error); }
  finally {
    for (const item of detail.cases) server.release(item.key);
    try {
      await worker.evaluate("globalThis.__responseBodyProbe?.release()");
      if (detail.pauseAttempted) {
        const retry = await backend("pauseAutomation"); assert.equal(retry.ok, true); const resume = await backend("resumeAutomation", retry.value.revision); assert.equal(resume.ok, true); await browser.client.beginTurn(); detail.cleanupRecovery = { retry, resume }; detail.globalPauseExercised = true;
      }
      const item = detail.cases.at(-1); if (item && !item.probe) await restore(worker, item, until);
    } catch (error) { detail.cleanupErrors.push(errorText(error)); failure ??= error; }
    try { await closeResponseBodyTabs(browser, worker, detail.cases, detail); } catch (error) { detail.cleanupErrors.push(errorText(error)); failure ??= error; }
    detail.server = detail.cases.map(item => server.stats(item.key));
  }
  if (failure) { failure.responseBodyDetail = detail; throw failure; }
  try { detail.proof = checkResponseBodyEdgesEvidence(detail); }
  catch (error) { detail.error = errorText(error); error.responseBodyDetail = detail; throw error; }
  detail.passed = true; return detail;
}
