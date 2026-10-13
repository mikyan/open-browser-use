import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { restrictedDialogPolicyControls } from "./site-access-dialog-fixture.mjs";
import { checkResponseBodyOOPIF, checkOriginalResponseBody, installResponseBodyProbe } from "./response-body-fixture.mjs";

const basePath = "/restricted-diagnostics/";
export const restrictedDiagnosticsLayouts = ["root", "oopif", "dynamic-oopif"];
const hash = bytes => createHash("sha256").update(bytes).digest("hex"), text = error => error?.stack ?? String(error);
const json = value => JSON.stringify(value).replace(/</g, "\\u003c");
const scopeOf = browser => ({ session_id: browser.client.sessionId, turn_id: browser.client.turnId, control_epoch: browser.client.controlEpoch });
const targetOf = (tab, layout) => layout === "root" ? tab : tab.frameLocator("#diagnostics-frame");

export function restrictedDiagnosticsURL(base, key, layout = "root", child = false, mode = "normal") {
  const url = new URL(basePath + (child ? "frame" : "page"), base); if (child) url.hostname = "localhost";
  url.search = new URLSearchParams({ key, layout, ...(mode === "normal" ? {} : { mode }) }).toString(); return url.href;
}
export function restrictedDiagnosticsAPIURL(pageURL) { const url = new URL(pageURL); url.pathname = basePath + "api"; if (url.searchParams.get("mode") === "third-party") url.hostname = "localhost"; return url.href; }

export function installRestrictedDiagnosticsPage(config) {
  const input = document.getElementById("note"), form = document.getElementById("form"), save = document.getElementById("save"), add = document.getElementById("add-diagnostics-frame");
  const events = [], errors = []; let overflow = false, receipt = null;
  const record = event => { if (events.length >= 32) overflow = true; else events.push({ sequence: events.length + 1, type: event.type, trusted: event.isTrusted, targetId: event.target.id, nodeToken: event.target.dataset?.token ?? null, value: event.target.value ?? null }); };
  for (const type of ["input", "click", "submit"]) document.addEventListener(type, record, { capture: true, passive: true });
  window.restrictedDiagnosticsState = () => ({ ...config, href: location.href, original: [input, form, save, add].filter(Boolean).every(node => node.isConnected && document.getElementById(node.id) === node),
    value: input?.value ?? null, nodeToken: input?.dataset.token ?? null, events: structuredClone(events), errors: [...errors], overflow, receipt, visibleText: document.body.innerText });
  add?.addEventListener("click", () => { if (document.getElementById("diagnostics-frame")) return; const frame = document.createElement("iframe"); frame.id = "diagnostics-frame"; frame.src = config.childURL; document.body.append(frame); add.disabled = true; });
  form?.addEventListener("submit", event => {
    event.preventDefault();
    console.log(`Original diagnostics console ${config.key}`);
    queueMicrotask(() => { throw new Error(`Original diagnostics error ${config.key}`); });
    const body = { key: config.key, layout: config.layout, documentToken: config.documentToken, nodeToken: input.dataset.token, href: location.href,
      value: input.value, trustedSubmit: event.isTrusted, events: structuredClone(events) };
    fetch(config.apiURL, { method: "POST", headers: { "Content-Type": "text/plain;charset=UTF-8" }, body: JSON.stringify(body) }).then(async response => {
      // Consume the original response, without rendering or retaining its nonce.
      const bytes = await response.arrayBuffer(); receipt = { status: response.status, url: response.url, bytes: bytes.byteLength };
      document.getElementById("receipt").textContent = `Saved ${config.key}`;
    }).catch(error => errors.push(String(error)));
  });
}

export function createRestrictedDiagnosticsFixtures() {
  const entries = new Map(), failures = new Map();
  const fail = key => { const close = failures.get(key); failures.delete(key); close?.(); };
  return { stats: key => structuredClone(entries.get(key)), allStats: () => structuredClone([...entries.values()]), fail, close() { for (const key of [...failures.keys()]) fail(key); }, handle(request, response, suppliedURL) {
    if (!["page", "frame", "api", "hop", "final"].some(kind => suppliedURL.pathname === basePath + kind)) return false;
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (!["127.0.0.1", "localhost"].includes(url.hostname) || url.protocol !== "http:" || url.port !== suppliedURL.port) { response.writeHead(400); response.end(); return true; }
    const key = url.searchParams.get("key"), layout = url.searchParams.get("layout"), mode = url.searchParams.get("mode") ?? "normal";
    if (!/^[a-z0-9-]{1,120}$/.test(key ?? "") || !restrictedDiagnosticsLayouts.includes(layout) || !["normal", "redirect", "redirect-denied", "third-party", "failed"].includes(mode)) { response.writeHead(400); response.end(); return true; }
    if ([basePath + "page", basePath + "frame"].includes(url.pathname)) {
      if (request.method !== "GET") { response.writeHead(405); response.end(); return true; }
      if (!entries.has(key)) entries.set(key, { key, layout, mode, documents: [], posts: [], redirects: [] });
      const config = { key, layout, mode, child: url.pathname.endsWith("/frame"), documentToken: randomUUID(), apiURL: restrictedDiagnosticsAPIURL(url.href), childURL: restrictedDiagnosticsURL(url.href, key, layout, true, mode) };
      const html = `<!doctype html><meta charset="utf-8"><title>Original diagnostics task</title><h1>Original diagnostics ${config.child ? "child" : "root"}</h1>
        ${config.child || layout === "root" ? `<form id="form" data-token="${config.documentToken}-form"><label for="note">Diagnostics note</label><input id="note" data-token="${config.documentToken}-note" autocomplete="off"><button id="save" data-token="${config.documentToken}-save">Save diagnostics note</button><output id="receipt">Waiting</output></form>` : ""}
        ${config.child ? "" : `<button id="add-diagnostics-frame" data-token="${config.documentToken}-add" type="button">Add diagnostics frame</button>${layout === "oopif" ? `<iframe id="diagnostics-frame" src="${config.childURL}"></iframe>` : ""}`}
        <script>(${installRestrictedDiagnosticsPage.toString()})(${json(config)});</script>`;
      const bytes = Buffer.from(html); entries.get(key).documents.push({ ...config, href: url.href, bytes: bytes.length, sha256: hash(bytes) });
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }); response.end(bytes); return true;
    }
    const entry = entries.get(key); if (!entry) { response.writeHead(404); response.end(); return true; }
    if ([basePath + "hop", basePath + "final"].includes(url.pathname)) {
      const post = entry.posts[0]; if (!post || request.method !== "GET") { response.writeHead(400); response.end(); return true; }
      const hop = { href: url.href, method: "GET", status: url.pathname.endsWith("/hop") ? 302 : 200 }; entry.redirects.push(hop);
      if (hop.status === 302) { const next = new URL(url); next.hostname = "127.0.0.1"; next.pathname = basePath + "final"; response.writeHead(302, { "Access-Control-Allow-Origin": "*", Location: next.href }); response.end(); }
      else { const bytes = Buffer.from(post.responseBase64, "base64"); Object.assign(hop, { responseBytes: bytes.length, responseBase64: post.responseBase64, responseSHA256: post.responseSHA256 }); response.writeHead(200, { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); response.end(bytes); }
      hop.finishedAt = Date.now(); return true;
    }
    if (request.method !== "POST") { response.writeHead(400); response.end(); return true; }
    const post = { method: request.method, href: url.href, receivedAt: Date.now(), index: entry.posts.length + 1 }, chunks = []; let size = 0; entry.posts.push(post);
    request.on("data", chunk => { size += chunk.length; if (size <= 32768) chunks.push(chunk); });
    request.once("error", () => { post.error = "Original request failed"; }); request.once("aborted", () => { post.error = "Original request aborted"; });
    request.once("end", () => {
      const bytes = Buffer.concat(chunks); Object.assign(post, { bodyBytes: size, bodyBase64: bytes.toString("base64"), bodySHA256: hash(bytes) });
      try {
        assert.ok(size <= 32768); post.value = JSON.parse(bytes); assert.equal(post.value.key, key); assert.equal(post.value.trustedSubmit, true);
        assert.equal(entry.documents.filter(doc => doc.documentToken === post.value.documentToken && doc.href === post.value.href).length, 1);
        const result = { key, nonce: randomUUID(), documentToken: post.value.documentToken, note: post.value.value, bodySHA256: post.bodySHA256 }, responseBytes = Buffer.from(JSON.stringify(result));
        Object.assign(post, { responseValue: result, responseBytes: responseBytes.length, responseBase64: responseBytes.toString("base64"), responseSHA256: hash(responseBytes), status: ["redirect", "redirect-denied"].includes(mode) ? 302 : 201, headersAt: Date.now() });
        const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" };
        if (post.status === 302) { const next = new URL(url); next.hostname = "localhost"; next.pathname = basePath + (mode === "redirect-denied" ? "hop" : "final"); response.writeHead(302, { ...headers, Location: next.href }); response.end(); post.finishedAt = Date.now(); }
        else if (mode === "failed") { response.writeHead(201, headers); response.write('{"originalIncomplete":'); response.flushHeaders(); failures.set(key, () => { post.socketDestroyedAt = Date.now(); response.destroy(); }); }
        else { response.writeHead(201, headers); response.end(responseBytes); post.finishedAt = Date.now(); }
      } catch { post.error = "Invalid original diagnostics submission"; response.writeHead(400); response.end(); }
    }); return true;
  } };
}

// Passive original events only. Register before goto so context creation and its
// frame identity are observed; no enable, evaluate or synthetic page event here.
export function installRestrictedDiagnosticsEvidence(api, target, tabId) {
  if (target.__restrictedDiagnosticsEvidence) throw Error("Diagnostics evidence already installed");
  const rows = []; let overflow = false;
  const listener = (source, method, params) => {
    if (source.tabId !== tabId || !["Runtime.executionContextCreated", "Runtime.executionContextDestroyed", "Runtime.executionContextsCleared", "Runtime.consoleAPICalled", "Runtime.exceptionThrown", "Log.entryAdded", "Network.requestWillBeSent", "Network.responseReceived", "Network.loadingFinished", "Network.loadingFailed", "Page.frameNavigated"].includes(method)) return;
    if (rows.length >= 512) { overflow = true; return; }
    const copy = structuredClone(params);
    if (copy.request) copy.request = { url: copy.request.url, method: copy.request.method, postData: copy.request.postData };
    if (copy.response) copy.response = { url: copy.response.url, status: copy.response.status, fromServiceWorker: copy.response.fromServiceWorker };
    rows.push({ sequence: rows.length + 1, at: Date.now(), source: { ...source }, method, params: copy });
  };
  api.debugger.onEvent.addListener(listener);
  target.__restrictedDiagnosticsEvidence = { snapshot: () => structuredClone({ rows, overflow }), stop() { api.debugger.onEvent.removeListener(listener); delete target.__restrictedDiagnosticsEvidence; return { rows, overflow, restored: !api.debugger.onEvent.hasListener(listener), removed: !target.__restrictedDiagnosticsEvidence }; } };
}

export function selectRestrictedDiagnostics(capture, config) {
  const consoleEntries = capture.entries.filter(entry => entry.kind === "console" && entry.text === `Original diagnostics console ${config.key}`);
  const errors = capture.entries.filter(entry => entry.kind === "pageerror" && entry.message === `Original diagnostics error ${config.key}`);
  const responses = capture.entries.filter(entry => entry.kind === "response" && entry.url === config.apiURL && entry.method === "POST" && entry.status === 201);
  const finished = responses.length && capture.entries.some(entry => entry.kind === "requestfinished" && entry.requestId === responses[0].requestId);
  return consoleEntries.length && errors.length && responses.length && finished ? { consoleEntries, errors, responses } : null;
}

async function workflow(operations, config, detail) {
  Object.assign(detail, { scope: structuredClone(config.scope), tabId: config.tabId });
  try {
    detail.initial = await operations.diagnostics({ limit: 200, timeoutMs: 5000 });
    if (config.layout === "dynamic-oopif") await operations.click("#add-diagnostics-frame", false);
    await operations.fill("#note", config.value); await operations.click("#save");
    await operations.waitReceipt(); detail.receipt = await operations.receipt();
    const deadline = Date.now() + 5000; detail.snapshots = [];
    for (;;) {
      const capture = await operations.diagnostics({ after: detail.initial.cursor, limit: 200, timeoutMs: Math.max(1, deadline - Date.now()) }); detail.snapshots.push(capture);
      if (selectRestrictedDiagnostics(capture, config)) { detail.capture = capture; break; }
      if (Date.now() >= deadline || detail.snapshots.length >= 64) throw Error("Original diagnostics events did not arrive within their read deadline");
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    const selected = selectRestrictedDiagnostics(detail.capture, config); assert.equal(selected.responses.length, 1);
    detail.reference = { captureId: detail.capture.captureId, requestId: selected.responses[0].requestId };
    detail.body = await operations.body(detail.reference); detail.decoded = JSON.parse(Buffer.from(detail.body.data, "base64").toString("utf8"));
    return detail;
  } catch (error) { detail.error = text(error); throw error; }
}

export function runRestrictedDiagnosticsWireCaller(call, config, detail = {}) {
  const action = async (action, args, selector, child = config.layout !== "root", timeoutMs = 5000) => {
    const params = { ...config.scope, tabId: config.tabId, action, args, timeoutMs };
    if (selector) params.locator = [...(child ? [{ kind: "frame", selector: "#diagnostics-frame" }] : []), { kind: "css", selector }];
    return (await call("browserAction", params)).value;
  };
  return workflow({ diagnostics: ({ timeoutMs, ...args }) => action("diagnostics", args, null, false, timeoutMs),
    click: (selector, child) => action("click", {}, selector, child), fill: (selector, value) => action("fill", { value }, selector),
    waitReceipt: () => action("waitFor", { state: "visible" }, `#receipt:has-text("Saved ${config.key}")`), receipt: () => action("textContent", {}, "#receipt"),
    body: ref => action("responseBody", { ...ref, maxBytes: 65536 }, null, false, 10000) }, config, detail);
}
function typedCaller(tab, config, detail) {
  const locator = (selector, child = config.layout !== "root") => (child ? tab.frameLocator("#diagnostics-frame") : tab).locator(selector);
  return workflow({ diagnostics: options => tab.diagnostics(options), click: (selector, child) => locator(selector, child).click(), fill: (selector, value) => locator(selector).fill(value),
    waitReceipt: () => locator(`#receipt:has-text("Saved ${config.key}")`).waitFor({ timeoutMs: 5000 }), receipt: () => locator("#receipt").textContent(), body: ref => tab.responseBody(ref, { maxBytes: 65536, timeoutMs: 10000 }) }, config, detail);
}

async function snapshot(worker, tabId) {
  return worker.evaluate(`(async()=>{const observer=globalThis.__integrationFrameObserver.snapshot();return{observer,frames:await chrome.webNavigation.getAllFrames({tabId:${tabId}}),documents:await chrome.scripting.executeScript({target:{tabId:${tabId},allFrames:true},world:'MAIN',func:()=>window.restrictedDiagnosticsState?.()??null}),targets:await chrome.debugger.getTargets(),oopifs:globalThis.__integrationFrames.filter(row=>row.tabId===${tabId})}})()`);
}
const sameSource = (left, right) => left.tabId === right.tabId && left.sessionId === right.sessionId;
export function checkRestrictedDiagnosticsEvidence(item, record) {
  const result = item.callerResult, native = item.nativeEvidence, probe = item.bodyProbe;
  assert.equal(record.posts.length, 1); const post = record.posts[0], bytes = Buffer.from(post.bodyBase64, "base64");
  assert.equal(post.error, undefined); assert.equal(post.bodyBytes, bytes.length); assert.equal(post.bodySHA256, hash(bytes)); assert.deepEqual(JSON.parse(bytes), post.value); assert.equal(post.status, 201); assert.ok(post.finishedAt);
  const original = record.documents.filter(doc => doc.child === (item.layout !== "root")); assert.equal(original.length, 1); const doc = original[0];
  const after = item.after.documents.filter(row => row.result?.documentToken === doc.documentToken); assert.equal(after.length, 1); const state = after[0].result;
  assert.equal(state.original, true); assert.equal(state.overflow, false); assert.deepEqual(state.errors, []); assert.equal(state.href, doc.href); assert.equal(state.value, item.value); assert.equal(state.nodeToken, `${doc.documentToken}-note`);
  assert.equal(post.value.documentToken, doc.documentToken); assert.equal(post.value.nodeToken, state.nodeToken); assert.equal(post.value.href, state.href); assert.equal(post.value.value, item.value); assert.equal(post.value.trustedSubmit, true); assert.deepEqual(post.value.events, state.events);
  assert.deepEqual(state.events.map(row => [row.type, row.targetId, row.trusted]), [["input", "note", true], ["click", "save", true], ["submit", "form", true]]);
  assert.deepEqual(state.receipt, { status: 201, url: item.apiURL, bytes: post.responseBytes }); assert.equal(result.receipt, `Saved ${item.key}`);
  assert.equal(typeof post.responseValue.nonce, "string"); assert.ok(post.responseValue.nonce.length > 20); assert.equal(state.visibleText.includes(post.responseValue.nonce), false);
  assert.deepEqual(result.decoded, post.responseValue); assert.deepEqual(result.decoded, JSON.parse(Buffer.from(result.body.data, "base64"))); assert.deepEqual(result.scope, item.scope); assert.equal(result.tabId, item.tabId); assert.equal(result.error, undefined);
  assert.equal(result.initial.captureId, result.capture.captureId); assert.ok(Number.isSafeInteger(result.initial.dropped) && result.initial.dropped >= 0);
  assert.ok(Number.isSafeInteger(result.capture.dropped) && result.capture.dropped >= result.initial.dropped); assert.ok(result.capture.cursor.sequence > result.initial.cursor.sequence);
  const selected = selectRestrictedDiagnostics(result.capture, item); assert.ok(selected);
  for (const values of Object.values(selected)) assert.equal(values.length, 1);
  assert.equal(selected.consoleEntries[0].location.url, doc.href); assert.equal(selected.errors[0].name, "Error"); assert.ok(selected.errors[0].stack.includes(doc.href));
  const response = selected.responses[0]; assert.equal(response.frameUrl, doc.href); assert.equal(response.resourceType, "fetch"); assert.match(response.requestId, /^diag-request-/);
  const requests = result.capture.entries.filter(entry => entry.kind === "request" && entry.requestId === response.requestId); assert.equal(requests.length, 1); assert.equal(requests[0].url, item.apiURL); assert.equal(requests[0].frameUrl, doc.href);
  const finished = result.capture.entries.filter(entry => entry.kind === "requestfinished" && entry.requestId === response.requestId); assert.equal(finished.length, 1);
  // Blank-document startup and unproven native Log events may be dropped. The
  // public aggregate is not an event identity: retain it without attributing a
  // native row to a drop. Every returned row must still have a known purpose.
  const permittedURLs = new Set([...record.documents.map(value => value.href), item.apiURL]);
  for (const entry of result.capture.entries) {
    if (entry.kind === "console") assert.equal(entry.text, `Original diagnostics console ${item.key}`);
    else if (entry.kind === "pageerror") assert.equal(entry.message, `Original diagnostics error ${item.key}`);
    else { assert.ok(permittedURLs.has(entry.url), "No unrelated source metadata may be returned"); assert.ok(["request", "response", "requestfinished"].includes(entry.kind)); }
  }
  assert.deepEqual(result.reference, { captureId: result.capture.captureId, requestId: response.requestId }); const bodyProof = checkOriginalResponseBody(result.body, result.reference, post);
  assert.equal(native.overflow, false); assert.equal(native.restored, true); assert.equal(native.removed, true);
  const sent = native.rows.filter(row => row.method === "Network.requestWillBeSent" && row.params.request?.method === "POST" && row.params.request.url === item.apiURL); assert.equal(sent.length, 1); const request = sent[0];
  assert.equal(request.source.tabId, item.tabId); assert.ok(request.params.loaderId); assert.equal(request.params.request.postData, bytes.toString("utf8"));
  for (const method of ["Network.responseReceived", "Network.loadingFinished"]) { const rows = native.rows.filter(row => row.method === method && row.params.requestId === request.params.requestId && sameSource(row.source, request.source)); assert.equal(rows.length, 1); if (method === "Network.responseReceived") { assert.equal(rows[0].params.response.url, item.apiURL); assert.equal(rows[0].params.response.status, 201); } }
  const consoles = native.rows.filter(row => row.method === "Runtime.consoleAPICalled" && row.params.args?.some(arg => arg.value === `Original diagnostics console ${item.key}`)); assert.equal(consoles.length, 1);
  const errors = native.rows.filter(row => row.method === "Runtime.exceptionThrown" && row.params.exceptionDetails.exception?.description?.startsWith(`Error: Original diagnostics error ${item.key}`)); assert.equal(errors.length, 1);
  for (const event of [consoles[0], errors[0]]) {
    assert.ok(sameSource(event.source, request.source)); const contextId = event.params.executionContextId ?? event.params.exceptionDetails.executionContextId;
    const contexts = native.rows.filter(row => row.sequence < event.sequence && row.method === "Runtime.executionContextCreated" && row.params.context.id === contextId && sameSource(row.source, event.source)); assert.ok(contexts.length >= 1);
    assert.equal(contexts.at(-1).params.context.auxData.frameId, request.params.frameId); assert.equal(contexts.at(-1).params.context.auxData.isDefault, true);
  }
  assert.equal(probe.overflow, false); assert.equal(probe.pending, 0); assert.equal(probe.restored, true); assert.equal(probe.expired, false);
  assert.equal(probe.rows.filter(row => row.kind === "alternative-native").length, 0);
  const calls = probe.rows.filter(row => row.kind === "native"); assert.equal(calls.length, 1); assert.equal(calls[0].params.requestId, request.params.requestId); assert.ok(sameSource(calls[0].source, request.source));
  const acks = probe.rows.filter(row => row.kind === "native-ack" && row.call === calls[0].sequence); assert.equal(acks.length, 1);
  const acknowledgedBytes = Buffer.from(acks[0].result.body, acks[0].result.base64Encoded ? "base64" : "utf8"); assert.equal(acknowledgedBytes.toString("base64"), post.responseBase64);
  assert.equal(probe.rows.filter(row => row.kind === "delivered" && row.call === calls[0].sequence).length, 1); assert.equal(probe.rows.filter(row => row.kind === "native-rejected").length, 0);
  const rpcs = probe.rows.filter(row => row.kind === "request"); assert.equal(rpcs.length, 1); assert.deepEqual(rpcs[0].message.params.args, { ...result.reference, maxBytes: 65536 });
  for (const [key, value] of Object.entries(item.scope)) assert.equal(rpcs[0].message.params[key], value);
  assert.equal(probe.rows.filter(row => row.kind === "response" && row.id === rpcs[0].message.id && row.ok).length, 1);
  const root = record.documents.find(doc => !doc.child), beforeRoot = item.before.documents.find(row => row.result?.documentToken === root.documentToken), afterRoot = item.after.documents.find(row => row.result?.documentToken === root.documentToken);
  assert.ok(beforeRoot?.documentId); assert.equal(afterRoot.documentId, beforeRoot.documentId);
  if (item.layout !== "dynamic-oopif") { const before = item.before.documents.find(row => row.result?.documentToken === doc.documentToken); assert.equal(after[0].documentId, before.documentId); }
  if (item.layout !== "root") {
    assert.deepEqual(afterRoot.result.events.map(row => [row.type, row.targetId, row.trusted]), item.layout === "dynamic-oopif" ? [["click", "add-diagnostics-frame", true]] : []);
    item.oopifProof = checkResponseBodyOOPIF({ ...item.after, tab: { id: item.tabId } }, { tabId: item.tabId, rootURL: root.href, childURL: doc.href });
    assert.equal(request.source.sessionId, item.oopifProof.sessionId); assert.equal(request.params.frameId, item.oopifProof.targetId);
  } else { assert.equal(request.source.sessionId, undefined); const targets = item.after.targets.filter(row => row.tabId === item.tabId && row.type === "page"); assert.equal(targets.length, 1); assert.equal(request.params.frameId, targets[0].id); }
  return { posts: 1, bytes: bytes.length, responseBytes: bodyProof.byteLength, responseSHA256: bodyProof.sha256, nativeRequestId: request.params.requestId, publicRequestId: response.requestId, documentId: after[0].documentId, console: 1, pageerror: 1, nativeReads: 1,
    dropped: { initial: result.initial.dropped, final: result.capture.dropped, delta: result.capture.dropped - result.initial.dropped, boundary: "Aggregate only; no per-native-event drop attribution is claimed. Required original business entries are each present exactly once." } };
}

export async function checkRestrictedDiagnosticsCaller({ kind, browser, fixtureURL, fixtures, getWorker, until, caller, detail = {} }) {
  Object.assign(detail, { caller: kind, variants: [], boundary: "Each caller captures diagnostics before its own single trusted form submission, then reads the original response; nonce is absent from page DOM. Native events and original bytes are independently retained." }); let failure;
  for (const layout of restrictedDiagnosticsLayouts) {
    const key = `restricted-diagnostics-${kind}-${layout}`, url = restrictedDiagnosticsURL(fixtureURL, key, layout), tab = await browser.newTab();
    const item = { key, layout, tabId: tab.id, scope: scopeOf(browser), value: `Original ${kind} ${layout} π`, callerResult: {} }; detail.variants.push(item);
    item.apiURL = restrictedDiagnosticsAPIURL(layout === "root" ? url : restrictedDiagnosticsURL(fixtureURL, key, layout, true)); let installed = false, bodyInstalled = false;
    try {
      await getWorker().evaluate(`(${installRestrictedDiagnosticsEvidence.toString()})(chrome,globalThis,${tab.id})`); installed = true;
      item.bodyProbeInstallation = await getWorker().evaluate(`(${installResponseBodyProbe.toString()})(chrome,globalThis,${json({ tabId: tab.id, scope: item.scope, id: randomUUID() })})`); bodyInstalled = true;
      await tab.goto(url);
      await until(async () => { const value = await snapshot(getWorker(), tab.id); return value.documents.length === (layout === "oopif" ? 2 : 1) && value.documents.every(row => row.result?.documentToken) ? (item.before = value) : false; }, "original restricted diagnostics documents ready");
      const config = { key, layout, tabId: tab.id, scope: structuredClone(item.scope), apiURL: item.apiURL, value: item.value };
      item.callerResult = caller ? await caller(config, item) : await typedCaller(tab, config, item.callerResult);
    } catch (error) { failure = error; item.error = text(error); }
    finally {
      if (bodyInstalled) try { await until(() => getWorker().evaluate("globalThis.__responseBodyProbe.snapshot().pending===0"), "original body native operation settled"); item.bodyProbe = await getWorker().evaluate("globalThis.__responseBodyProbe.restore()"); } catch (error) { item.bodyProbeError = text(error); failure ??= error; }
      if (installed) try { item.nativeEvidence = await getWorker().evaluate("globalThis.__restrictedDiagnosticsEvidence.stop()"); } catch (error) { item.nativeEvidenceError = text(error); failure ??= error; }
      try { item.after = await snapshot(getWorker(), tab.id); } catch (error) { item.afterError = text(error); failure ??= error; }
      item.server = fixtures.stats(key);
    }
    if (!failure) try { item.proof = checkRestrictedDiagnosticsEvidence(item, item.server); item.passed = true; } catch (error) { failure = error; item.error = text(error); }
    if (failure) break;
  }
  detail.serverLedger = fixtures.allStats(); if (failure) { detail.error = text(failure); throw failure; } return detail;
}

export async function checkRestrictedDiagnosticsPolicy({ popup, fixtureURL, until, runAllowed, runBoundaries, saveDetail }) {
  assert.ok(popup, "Diagnostics policy workflow borrows the existing real popup"); const controls = restrictedDialogPolicyControls({ popup, until }), detail = { popupOwnership: "borrowed" }; let failure;
  try {
    detail.originalPolicy = await controls.read(); detail.origins = [new URL(fixtureURL).origin, new URL(fixtureURL).origin.replace("127.0.0.1", "localhost")].sort();
    detail.allowed = await controls.apply("allow", detail.origins); detail.allowed.resume = await controls.resume();
    if (runAllowed) await runAllowed(detail.allowed.policy); if (runBoundaries) await runBoundaries(controls, detail.allowed.policy);
  } catch (error) { failure = error; }
  finally {
    if (detail.originalPolicy) try { detail.restored = await controls.apply(detail.originalPolicy.mode, detail.originalPolicy.origins); detail.restored.resume = await controls.resume(); } catch (error) { detail.restoreError = text(error); failure ??= error; }
    if (failure) detail.error = text(failure); try { await saveDetail(detail); } catch (error) { failure ??= error; }
  }
  if (failure) throw failure; return detail;
}

const sourceDenied = /OBU_SITE_ACCESS_(?:DENIED|UNVERIFIED)/;
const oldBody = /OBU_RESPONSE_BODY_EXPIRED|OBU_SITE_ACCESS_(?:DENIED|UNVERIFIED)/;
const oldControl = /OBU_STALE_CONTROL_EPOCH|OBU_CONTROL_BOOTSTRAP_REQUIRED|OBU_AUTOMATION_PAUSED|OBU_TURN_(?:ENDED|ENDING)/;
const outcome = promise => promise.then(value => ({ ok: true, value, at: Date.now() }), error => ({ ok: false, error: text(error), at: Date.now() }));

export function checkRestrictedDiagnosticsBoundaryEvidence(item) {
  const { server, nativeEvidence: native, bodyProbe: probe } = item;
  assert.equal(native.overflow, false); assert.equal(native.restored, true); assert.equal(native.removed, true);
  assert.equal(probe.overflow, false); assert.equal(probe.pending, 0); assert.equal(probe.restored, true); assert.equal(probe.expired, false);
  assert.equal(probe.rows.filter(row => row.kind === "alternative-native").length, 0);
  const original = item.before.documents.find(row => row.frameId === 0), current = item.after.documents.find(row => row.frameId === 0);
  assert.ok(original?.documentId); assert.ok(current?.documentId); assert.equal(original.result.original, true); assert.equal(current.result.original, true); assert.equal(current.result.overflow, false);
  assert.deepEqual(original.result.events, []); const doc = server.documents.find(row => row.documentToken === original.result.documentToken); assert.ok(doc); assert.equal(doc.href, item.url);
  if (item.navigated) { assert.notEqual(current.documentId, original.documentId); assert.notEqual(current.result.documentToken, original.result.documentToken); assert.equal(current.result.href, doc.href); assert.deepEqual(current.result.events, []); }
  else { assert.equal(current.documentId, original.documentId); assert.equal(current.result.documentToken, original.result.documentToken); }
  assert.equal(server.posts.length, item.submitted ? 1 : 0);
  const sent = native.rows.filter(row => row.method === "Network.requestWillBeSent" && row.params.request?.method === "POST" && row.params.request.url === item.apiURL); assert.equal(sent.length, server.posts.length);
  let post, request;
  if (item.submitted) {
    [post] = server.posts; [request] = sent; const bytes = Buffer.from(post.bodyBase64, "base64"), state = item.beforeNavigation?.documents.find(row => row.documentId === original.documentId)?.result ?? current.result;
    assert.equal(post.error, undefined); assert.equal(post.bodyBytes, bytes.length); assert.equal(post.bodySHA256, hash(bytes)); assert.deepEqual(JSON.parse(bytes), post.value);
    assert.equal(post.value.documentToken, doc.documentToken); assert.equal(post.value.nodeToken, `${doc.documentToken}-note`); assert.equal(post.value.href, doc.href); assert.equal(post.value.value, item.value); assert.equal(post.value.trustedSubmit, true);
    const events = [["input", "note", true], ["click", "save", true], ["submit", "form", true]];
    assert.deepEqual(post.value.events.map(row => [row.type, row.targetId, row.trusted]), events); assert.deepEqual(state.events, post.value.events);
    assert.equal(state.visibleText.includes(post.responseValue.nonce), false); assert.equal(request.params.request.postData, bytes.toString("utf8")); assert.ok(request.params.loaderId);
    assert.equal(request.source.tabId, item.tabId); assert.equal(request.source.sessionId, undefined);
    const target = item.after.targets.find(row => row.tabId === item.tabId && row.type === "page"); assert.ok(target); assert.equal(request.params.frameId, target.id);
    if (item.mode === "failed") {
      assert.ok(post.socketDestroyedAt); assert.equal(post.finishedAt, undefined); assert.equal(state.receipt, null); assert.equal(state.errors.length, 1);
      const failed = native.rows.filter(row => row.method === "Network.loadingFailed" && row.params.requestId === request.params.requestId && sameSource(row.source, request.source)); assert.equal(failed.length, 1); assert.ok(failed[0].params.errorText);
      assert.equal(native.rows.filter(row => row.method === "Network.loadingFinished" && row.params.requestId === request.params.requestId && sameSource(row.source, request.source)).length, 0);
      assert.equal(item.capture.entries.filter(row => row.kind === "requestfailed" && row.requestId === item.reference.requestId).length, 1);
    } else { assert.ok(post.finishedAt); assert.equal(item.receipt, `Saved ${item.key}`); assert.deepEqual(state.errors, []); assert.ok(state.receipt?.bytes > 0); }
    const consoles = native.rows.filter(row => row.method === "Runtime.consoleAPICalled" && row.params.args?.some(arg => arg.value === `Original diagnostics console ${item.key}`));
    const errors = native.rows.filter(row => row.method === "Runtime.exceptionThrown" && row.params.exceptionDetails.exception?.description?.startsWith(`Error: Original diagnostics error ${item.key}`));
    assert.equal(consoles.length, 1); assert.equal(errors.length, 1);
    for (const event of [consoles[0], errors[0]]) { assert.ok(sameSource(event.source, request.source)); const id = event.params.executionContextId ?? event.params.exceptionDetails.executionContextId;
      const context = native.rows.filter(row => row.method === "Runtime.executionContextCreated" && row.sequence < event.sequence && row.params.context.id === id && sameSource(row.source, event.source)).at(-1); assert.ok(context); assert.equal(context.params.context.auxData.frameId, request.params.frameId); }
  } else assert.deepEqual(current.result.events.map(row => [row.type, row.targetId, row.trusted]), item.addedChild ? [["click", "add-diagnostics-frame", true]] : []);
  for (const rejected of item.rejections) {
    assert.equal(Object.hasOwn(rejected, "value"), false); assert.ok(rejected.error);
    const pattern = { denied: sourceDenied, body: oldBody, control: oldControl, unavailable: /OBU_RESPONSE_BODY_UNAVAILABLE/, failed: /OBU_RESPONSE_BODY_FAILED/, timeout: /OBU_RESPONSE_BODY_TIMEOUT/ }[rejected.authority]; assert.ok(pattern); assert.match(rejected.error, pattern);
  }
  const nativeReads = probe.rows.filter(row => row.kind === "native"); assert.equal(nativeReads.length, item.reads.length);
  const expected = {
    "allowed-redirect": { rejected: ["unavailable"], reads: 1 }, "failed-original-request": { rejected: ["failed"], reads: 0 },
    "same-url-new-document": { rejected: ["body"], reads: 0 }, "late-native-policy": { rejected: ["timeout", "control"], reads: 1 },
    "policy-revocation": { rejected: ["control", "control"], reads: 0 }, "mixed-denied-child": { rejected: ["denied"], reads: 0 },
    "future-denied-child": { rejected: ["denied"], reads: 0 }, "third-party": { rejected: [], reads: 0 }, "redirect-denied": { rejected: [], reads: 0 }
  }[item.name];
  assert.ok(expected, "Known original boundary case required"); assert.deepEqual(item.rejections.map(row => row.authority), expected.rejected); assert.equal(nativeReads.length, expected.reads);
  for (let index = 0; index < nativeReads.length; index++) {
    const call = nativeReads[index], read = item.reads[index]; assert.equal(call.params.requestId, read.nativeRequestId); assert.equal(call.source.tabId, item.tabId); assert.equal(call.source.sessionId, undefined);
    const rpc = probe.rows.filter(row => row.kind === "request" && row.sequence < call.sequence).at(-1); assert.ok(rpc); assert.equal(rpc.message.params.args.captureId, read.reference.captureId); assert.equal(rpc.message.params.args.requestId, read.reference.requestId);
    for (const [key, value] of Object.entries(item.scope)) assert.equal(rpc.message.params[key], value);
    const acks = probe.rows.filter(row => row.kind === "native-ack" && row.call === call.sequence); assert.equal(acks.length, 1);
    assert.equal(Buffer.from(acks[0].result.body, acks[0].result.base64Encoded ? "base64" : "utf8").toString("base64"), post.responseBase64);
    assert.equal(probe.rows.filter(row => row.kind === "delivered" && row.call === call.sequence).length, 1);
    if (read.value) checkOriginalResponseBody(read.value, read.reference, post);
  }
  if (item.name === "same-url-new-document") {
    assert.equal(item.navigated, true); assert.ok(item.beforeNavigation); assert.ok(item.afterNavigationCapture);
    for (const row of item.afterNavigationCapture.entries) { assert.notEqual(row.requestId, item.reference.requestId); assert.notEqual(row.text, `Original diagnostics console ${item.key}`); assert.notEqual(row.message, `Original diagnostics error ${item.key}`); }
    const navigations = native.rows.filter(row => row.method === "Network.requestWillBeSent" && row.params.request?.method === "GET" && row.params.request.url === item.url && row.params.type === "Document");
    assert.equal(navigations.length, 2); assert.notEqual(navigations[0].params.loaderId, navigations[1].params.loaderId); assert.equal(navigations[1].params.frameId, request.params.frameId);
    assert.ok(native.rows.some(row => row.method === "Page.frameNavigated" && row.params.frame.id === request.params.frameId && row.params.frame.loaderId === navigations[1].params.loaderId));
  }
  if (["third-party", "redirect-denied"].includes(item.name)) {
    assert.ok(item.capture); assert.equal(JSON.stringify(item.capture).includes(post.responseValue.nonce), false);
    const deniedURLs = item.name === "third-party" ? [item.apiURL] : server.redirects.map(row => row.href);
    for (const row of item.capture.entries) assert.equal(deniedURLs.includes(row.url), false, "Original denied candidate metadata must not leak");
    for (const url of deniedURLs) assert.ok(native.rows.some(row => row.method === "Network.responseReceived" && row.params.response.url === url || row.method === "Network.requestWillBeSent" && row.params.redirectResponse?.url === url), "The original page request must actually have received the denied response (redirect ACK or final response)");
  }
  if (["allowed-redirect", "redirect-denied"].includes(item.name)) {
    assert.equal(server.redirects.length, item.name === "allowed-redirect" ? 1 : 2); assert.equal(post.status, 302);
    const chain = native.rows.filter(row => row.method === "Network.requestWillBeSent" && row.params.requestId === request.params.requestId && sameSource(row.source, request.source));
    assert.deepEqual(chain.map(row => row.params.request.url), [item.apiURL, ...server.redirects.map(row => row.href)]);
    for (let index = 1; index < chain.length; index++) { assert.equal(chain[index].params.redirectResponse.url, chain[index - 1].params.request.url); assert.equal(chain[index].params.redirectResponse.status, 302); }
    if (item.name === "allowed-redirect") { const final = item.capture.entries.find(row => row.kind === "response" && row.url === server.redirects[0].href); assert.ok(final); assert.equal(final.redirectedFrom, item.reference.requestId); assert.equal(item.reads[0].reference.requestId, final.requestId); }
  }
  if (item.name === "late-native-policy") {
    assert.equal(item.held.pending, 1); assert.equal(item.held.held, true); assert.equal(item.blocked.inputBlocked, true); assert.equal(item.blocked.cleanupComplete, false); assert.equal(item.applySettledWhileHeld, false);
    assert.ok(item.expiredAt - item.readStartedAt >= 900); assert.equal(item.rejections.filter(row => row.authority === "timeout").length, 1);
    assert.equal(probe.rows.filter(row => row.kind === "response" && row.ok).length, 0); assert.equal(probe.rows.filter(row => row.kind === "native-rejected").length, 0);
  }
  if (["late-native-policy", "policy-revocation"].includes(item.name)) assert.ok(item.policyChanged);
  if (item.policyChanged) { assert.equal(item.policyChanged.control.cleanupComplete, true); assert.equal(item.policyChanged.control.inputBlocked, true); assert.equal(item.resume.inputBlocked, false); assert.notEqual(item.newScope.control_epoch, item.scope.control_epoch); }
  if (item.name === "mixed-denied-child" || item.name === "future-denied-child") {
    const child = item.after.frames.filter(row => row.parentFrameId === 0 && new URL(row.url).hostname === "localhost"); assert.equal(child.length, 1); assert.ok(child[0].documentId);
    assert.equal(item.rejections.length, 1); assert.equal(item.rejections[0].authority, "denied");
  }
  return { posts: server.posts.length, bytes: server.posts.reduce((sum, row) => sum + row.bodyBytes, 0), nativeReads: nativeReads.length, authorityRejections: item.rejections.length, originalDocumentId: original.documentId };
}

export async function checkRestrictedDiagnosticsBoundaries({ connectBrowser, getWorker, fixtureURL, fixtures, controls, until, saveDetail }) {
  const browser = await connectBrowser("js-restricted-diagnostics-boundaries"), detail = { tabIds: [], cases: [], executionOrder: [], boundary: "Original page fetches are not blocked by agent policy. Public diagnostics are checked independently from private native/server evidence. The late-ACK test delays delivery only after a real native ACK. No input/request replay or frameless-worker coverage is claimed." }; let failure;
  const create = async (name, mode = "normal", layout = "root") => {
    const key = `restricted-diagnostics-boundary-${name}`, tab = await browser.newTab(), item = { name, key, mode, layout, tabId: tab.id, url: restrictedDiagnosticsURL(fixtureURL, key, layout, false, mode), value: `Original ${name} π`, snapshots: [], rejections: [], reads: [] };
    detail.cases.push(item); detail.tabIds.push(tab.id); item.apiURL = restrictedDiagnosticsAPIURL(item.url); return { item, tab };
  };
  const ready = async ({ item, tab }) => { await tab.goto(item.url); await until(async () => { const value = await snapshot(getWorker(), tab.id); return value.documents.length === (item.layout === "oopif" ? 2 : 1) && value.documents.every(row => row.result?.documentToken) ? (item.before = value) : false; }, "original diagnostics boundary document"); };
  const run = async (context, action) => {
    const { item, tab } = context; let first, installed = false, bodyInstalled = false; const pending = [];
    detail.executionOrder.push(item.name);
    const capture = async (predicate = () => true, all = false) => {
      const deadline = Date.now() + 5000; let value;
      await until(async () => { assert.ok(item.snapshots.length < 128, "Bounded original diagnostics observations"); value = await tab.diagnostics({ ...(all ? {} : { after: item.initial.cursor }), limit: 200, timeoutMs: Math.max(1, deadline - Date.now()) }); item.snapshots.push(value); return predicate(value); }, "original diagnostics boundary events", 5000); item.capture = value; return value;
    };
    const reject = async (name, promise, authority) => { const result = { name, authority, ...await outcome(promise) }; item.rejections.push(result); assert.equal(result.ok, false, `${name} unexpectedly returned data`); return result; };
    const submit = async (complete = true) => { item.submitted = true; await tab.locator("#note").fill(item.value); await tab.locator("#save").click(); if (complete) { await tab.getByText(`Saved ${item.key}`, { exact: true }).waitFor({ timeoutMs: 5000 }); item.receipt = await tab.locator("#receipt").textContent(); } };
    const reference = async () => { const value = await capture(value => value.entries.some(row => row.kind === "response" && row.url === item.apiURL)); const response = value.entries.find(row => row.kind === "response" && row.url === item.apiURL); return item.reference = { captureId: value.captureId, requestId: response.requestId }; };
    const nativeRequest = async () => { const rows = await getWorker().evaluate("globalThis.__restrictedDiagnosticsEvidence.snapshot().rows"); const requests = rows.filter(row => row.method === "Network.requestWillBeSent" && row.params.request?.method === "POST" && row.params.request.url === item.apiURL); assert.equal(requests.length, 1); return requests[0].params.requestId; };
    try {
      item.scope = scopeOf(browser); await getWorker().evaluate(`(${installRestrictedDiagnosticsEvidence.toString()})(chrome,globalThis,${tab.id})`); installed = true;
      await getWorker().evaluate(`(${installResponseBodyProbe.toString()})(chrome,globalThis,${json({ tabId: tab.id, scope: item.scope, id: randomUUID() })})`); bodyInstalled = true;
      if (!item.before) await ready(context);
      if (item.name !== "mixed-denied-child") item.initial = await tab.diagnostics({ limit: 200 });
      await action({ item, tab, capture, reject, submit, reference, nativeRequest, pending });
    } catch (error) { first = error; item.error = text(error); }
    finally {
      fixtures.fail(item.key);
      if (bodyInstalled) try { await getWorker().evaluate("globalThis.__responseBodyProbe.release()"); await Promise.all(pending); await until(() => getWorker().evaluate("globalThis.__responseBodyProbe.snapshot().pending===0"), "original boundary body operation settles"); item.bodyProbe = await getWorker().evaluate("globalThis.__responseBodyProbe.restore()"); } catch (error) { item.bodyProbeError = text(error); first ??= error; }
      if (installed) try { item.nativeEvidence = await getWorker().evaluate("globalThis.__restrictedDiagnosticsEvidence.stop()"); } catch (error) { item.nativeEvidenceError = text(error); first ??= error; }
      try { item.after = await snapshot(getWorker(), tab.id); } catch (error) { item.afterError = text(error); first ??= error; }
      try { item.server = fixtures.stats(item.key); } catch (error) { item.serverLedgerError = text(error); first ??= error; }
    }
    if (!first) try { item.proof = checkRestrictedDiagnosticsBoundaryEvidence(item); item.passed = true; } catch (error) { first = error; item.error = text(error); }
    if (first) throw first;
  };
  try {
    await run(await create("allowed-redirect", "redirect"), async ({ item, tab, submit, capture, reference, reject, nativeRequest }) => {
      await submit(); await reference(); await reject("original-redirect-hop", tab.responseBody(item.reference), "unavailable");
      const value = await capture(value => value.entries.some(row => row.kind === "response" && row.status === 200)); const final = value.entries.find(row => row.kind === "response" && row.status === 200);
      const ref = { captureId: value.captureId, requestId: final.requestId }, read = { reference: ref, nativeRequestId: await nativeRequest() }; item.reads.push(read); read.value = await tab.responseBody(ref, { maxBytes: 65536 });
    });
    await run(await create("failed-original-request", "failed"), async ({ item, tab, submit, reference, capture, reject }) => {
      await submit(false); await reference(); fixtures.fail(item.key);
      await capture(value => value.entries.some(row => row.kind === "requestfailed" && row.requestId === item.reference.requestId));
      await until(async () => (await snapshot(getWorker(), tab.id)).documents.some(row => row.result?.errors.length === 1), "original fetch failure delivered to page");
      await reject("original-failed-body", tab.responseBody(item.reference), "failed");
    });
    await run(await create("same-url-new-document"), async ({ item, tab, submit, reference, capture, reject }) => {
      await submit(); await reference(); item.beforeNavigation = await snapshot(getWorker(), tab.id); await tab.goto(item.url); item.navigated = true;
      item.afterNavigationCapture = await capture(() => true, true); await reject("old-document-body", tab.responseBody(item.reference), "body");
    });
    await run(await create("late-native-policy"), async ({ item, tab, submit, reference, nativeRequest, reject, pending }) => {
      await submit(); const ref = await reference(); await getWorker().evaluate("globalThis.__responseBodyProbe.hold()"); item.readStartedAt = Date.now();
      const read = { reference: ref, nativeRequestId: await nativeRequest() }; item.reads.push(read); const result = outcome(tab.responseBody(ref, { timeoutMs: 1000 })); pending.push(result);
      await until(() => getWorker().evaluate("globalThis.__responseBodyProbe.snapshot().held"), "original native response body ACK held"); item.held = await getWorker().evaluate("globalThis.__responseBodyProbe.snapshot()");
      const expired = await result; item.expiredAt = Date.now(); item.rejections.push({ name: "original-body-deadline", authority: "timeout", ...expired }); assert.equal(expired.ok, false);
      let settled = false; const policy = outcome(controls.apply("allow", [new URL(fixtureURL).origin, new URL(fixtureURL).origin.replace("127.0.0.1", "localhost")].sort())).then(value => { settled = true; return value; }); pending.push(policy);
      await until(async () => { const status = await getWorker().evaluate("globalThis.__integrationBackend.automationControl.status()"); return status.inputBlocked && !status.cleanupComplete ? (item.blocked = status) : false; }, "Pause retains actual native cleanup"); item.applySettledWhileHeld = settled;
      await getWorker().evaluate("globalThis.__responseBodyProbe.release()"); const changed = await policy; assert.equal(changed.ok, true, changed.error); item.policyChanged = changed.value;
      await reject("old-policy-body", browser.client.request("browserAction", { ...item.scope, tabId: tab.id, action: "responseBody", args: ref, timeoutMs: 1000 }), "control");
      item.resume = await controls.resume(); await browser.client.beginTurn(); item.newScope = scopeOf(browser);
    });
    // The existing denied child must have existed before the explicit policy
    // change; creating a denied page through the public API is not a substitute.
    const mixed = await create("mixed-denied-child", "normal", "oopif"); await ready(mixed);
    await run(await create("policy-revocation"), async ({ item, tab, submit, reference, reject }) => {
      await submit(); const ref = await reference(); item.policyChanged = await controls.apply("allow", [new URL(fixtureURL).origin]);
      for (const action of ["diagnostics", "responseBody"]) await reject(`old-policy-${action}`, browser.client.request("browserAction", { ...item.scope, tabId: tab.id, action, args: action === "responseBody" ? ref : {}, timeoutMs: 1000 }), "control");
      item.resume = await controls.resume(); await browser.client.beginTurn(); item.newScope = scopeOf(browser);
    });
    await run(mixed, async ({ tab, reject }) => { await reject("mixed-tree-diagnostics", tab.diagnostics(), "denied"); });
    await run(await create("future-denied-child", "normal", "dynamic-oopif"), async ({ item, tab, reject }) => {
      item.addedChild = true; try { await tab.locator("#add-diagnostics-frame").click(); } catch (error) { item.addError = text(error); assert.match(item.addError, sourceDenied); }
      await until(async () => (await getWorker().evaluate(`chrome.webNavigation.getAllFrames({tabId:${tab.id}})`)).some(row => row.parentFrameId === 0 && new URL(row.url).hostname === "localhost"), "original future denied child committed");
      await reject("future-tree-diagnostics", tab.diagnostics(), "denied");
    });
    for (const mode of ["third-party", "redirect-denied"]) await run(await create(mode, mode), async ({ item, submit, capture }) => {
      await submit(); await capture(value => value.entries.some(row => row.kind === "console" && row.text === `Original diagnostics console ${item.key}`) && value.entries.some(row => row.kind === "pageerror" && row.message === `Original diagnostics error ${item.key}`));
    });
    assert.deepEqual(detail.executionOrder, ["allowed-redirect", "failed-original-request", "same-url-new-document", "late-native-policy", "policy-revocation", "mixed-denied-child", "future-denied-child", "third-party", "redirect-denied"]);
    assert.equal(detail.cases.length, 9); assert.ok(detail.cases.every(item => item.passed));
    detail.proof = { cases: 9, posts: detail.cases.reduce((sum, item) => sum + item.proof.posts, 0), bytes: detail.cases.reduce((sum, item) => sum + item.proof.bytes, 0), nativeReads: detail.cases.reduce((sum, item) => sum + item.proof.nativeReads, 0) };
    assert.equal(detail.proof.posts, 7); assert.equal(detail.proof.nativeReads, 2);
  } catch (error) { failure = error; }
  finally {
    try { detail.serverLedger = fixtures.allStats(); } catch (error) { detail.serverLedgerError = text(error); failure ??= error; }
    try { detail.childTargetIds = await getWorker().evaluate(`globalThis.__integrationFrames.filter(row=>${json(detail.tabIds)}.includes(row.tabId)).map(row=>row.targetId)`); } catch (error) { detail.childTargetReadError = text(error); failure ??= error; }
    for (const id of detail.tabIds) try { await getWorker().evaluate(`chrome.tabs.remove(${id})`); } catch (error) { (detail.tabCleanupErrors ??= []).push({ tabId: id, error: text(error) }); failure ??= error; }
    try { assert.ok(Array.isArray(detail.childTargetIds)); detail.cleanup = await getWorker().evaluate(`(async()=>({tabs:(await chrome.tabs.query({})).filter(row=>${json(detail.tabIds)}.includes(row.id)),targets:(await chrome.debugger.getTargets()).filter(row=>${json(detail.tabIds)}.includes(row.tabId)||${json(detail.childTargetIds)}.includes(row.id)),probePresent:!!globalThis.__restrictedDiagnosticsEvidence||!!globalThis.__responseBodyProbe}))()`); assert.deepEqual(detail.cleanup, { tabs: [], targets: [], probePresent: false }); } catch (error) { detail.cleanupError = text(error); failure ??= error; }
    try { detail.finalizeScope = scopeOf(browser); assert.ok(Number.isSafeInteger(detail.finalizeScope.control_epoch) && detail.finalizeScope.control_epoch > 0); detail.finalize = await browser.client.finalizeTabs([]); } catch (error) { detail.finalizeError = text(error); failure ??= error; }
    try { browser.close(); } catch (error) { detail.connectionCleanupError = text(error); failure ??= error; }
    if (failure) detail.error = text(failure); try { await saveDetail(detail); } catch (error) { failure ??= error; }
  }
  if (failure) throw failure; return detail;
}
