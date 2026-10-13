import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { restrictedDialogPolicyControls } from "./site-access-dialog-fixture.mjs";
import { checkResponseBodyOOPIF } from "./response-body-fixture.mjs";

const basePath = "/restricted-network/", layouts = ["root", "oopif", "dynamic-oopif"];
const hash = value => createHash("sha256").update(value).digest("hex"), text = error => error?.stack ?? String(error), json = value => JSON.stringify(value).replace(/</g, "\\u003c");
const denied = /OBU_SITE_ACCESS_(?:DENIED|UNVERIFIED)/, retired = /OBU_NETWORK_WAIT_EXPIRED|OBU_SITE_ACCESS_(?:DENIED|UNVERIFIED)|OBU_STALE_CONTROL_EPOCH|OBU_CONTROL_BOOTSTRAP_REQUIRED|OBU_AUTOMATION_PAUSED/;
const revokedControl = /OBU_STALE_CONTROL_EPOCH|OBU_CONTROL_BOOTSTRAP_REQUIRED|OBU_AUTOMATION_PAUSED/;
const scopeOf = browser => ({ session_id: browser.client.sessionId, turn_id: browser.client.turnId, control_epoch: browser.client.controlEpoch });
const targetOf = (tab, layout) => layout === "root" ? tab : tab.frameLocator("#network-frame");
export const restrictedNetworkLayouts = layouts;

export function restrictedNetworkURL(base, key, layout = "root", mode = "normal", document = "root") {
  const url = new URL(`${basePath}${document === "child" ? "frame" : "page"}`, base); if (document === "child") url.hostname = "localhost";
  url.search = new URLSearchParams({ key, layout, mode }).toString(); return url.href;
}
export function restrictedNetworkAPIURL(pageURL) {
  const url = new URL(pageURL); url.pathname = `${basePath}api`; if (url.searchParams.get("mode") === "third-party") url.hostname = "localhost"; return url.href;
}

export function installRestrictedNetworkPage(config) {
  const input = document.getElementById("note"), form = document.getElementById("form"), save = document.getElementById("save"), add = document.getElementById("add-network-frame");
  const events = [], completions = [], errors = []; let sequence = 0, overflow = false, receipt = null;
  const record = event => { if (events.length >= 64) overflow = true; else events.push({ sequence: ++sequence, type: event.type, trusted: event.isTrusted, targetId: event.target.id, nodeToken: event.target.dataset?.token ?? null, value: event.target.value ?? null }); };
  for (const type of ["input", "click", "submit"]) document.addEventListener(type, record, { capture: true, passive: true });
  window.restrictedNetworkState = () => ({ ...config, href: location.href, documentToken: config.documentToken, original: [input, form, save, add].filter(Boolean).every(node => node.isConnected && document.getElementById(node.id) === node),
    value: input?.value ?? null, nodeToken: input?.dataset.token ?? null, events: structuredClone(events), completions: structuredClone(completions), errors: [...errors], overflow, receipt });
  add?.addEventListener("click", () => { if (document.getElementById("network-frame")) return; const frame = document.createElement("iframe"); frame.id = "network-frame"; frame.src = config.childURL; document.body.append(frame); add.disabled = true; });
  form?.addEventListener("submit", event => {
    event.preventDefault(); const body = { key: config.key, layout: config.layout, mode: config.mode, documentToken: config.documentToken, nodeToken: input.dataset.token,
      href: location.href, value: input.value, trustedSubmit: event.isTrusted, events: structuredClone(events) };
    fetch(config.apiURL, { method: "POST", headers: { "Content-Type": "text/plain;charset=UTF-8" }, body: JSON.stringify(body) })
      .then(async response => { const result = await response.json(); completions.push({ status: response.status, url: response.url, receipt: result }); receipt = result;
        document.getElementById("receipt").textContent = `Saved ${config.key} ${result.index} ${result.bodySHA256}`; })
      .catch(error => errors.push(String(error)));
  });
}

export function createRestrictedNetworkFixtures() {
  const entries = new Map(), gates = new Map();
  const stats = key => structuredClone(entries.get(key));
  const release = key => { const finish = gates.get(key); gates.delete(key); finish?.(); };
  return { stats, allStats: () => structuredClone([...entries.values()]), release, close: () => { for (const key of [...gates.keys()]) release(key); }, handle(request, response, url) {
    if (!["page", "frame", "api", "redirect-hop", "receipt"].some(kind => url.pathname === basePath + kind)) return false;
    const actualURL = new URL(request.url, `http://${request.headers.host}`);
    if (!["127.0.0.1", "localhost"].includes(actualURL.hostname) || actualURL.protocol !== "http:" || actualURL.port !== url.port) { response.writeHead(400); response.end(); return true; }
    url = actualURL;
    const key = url.searchParams.get("key"), layout = url.searchParams.get("layout"), mode = url.searchParams.get("mode") ?? "normal";
    if (!/^[a-z0-9-]{1,120}$/.test(key ?? "") || !layouts.includes(layout) || !["normal", "503", "redirect", "redirect-denied", "headers-gate", "third-party", "double"].includes(mode)) { response.writeHead(400); response.end(); return true; }
    if ([basePath + "page", basePath + "frame"].includes(url.pathname)) {
      if (request.method !== "GET") { response.writeHead(405); response.end(); return true; }
      if (!entries.has(key)) entries.set(key, { key, layout, mode, documents: [], posts: [], redirects: [] });
      const entry = entries.get(key), child = url.pathname.endsWith("/frame"), documentToken = randomUUID(), apiURL = restrictedNetworkAPIURL(url.href), childURL = restrictedNetworkURL(url.href, key, layout, mode, "child");
      const config = { key, layout, mode, child, documentToken, apiURL, childURL };
      const html = `<!doctype html><meta charset="utf-8"><title>Original restricted network form</title><h1>Original ${child ? "child" : "root"} network document</h1>
        ${child || layout === "root" ? `<form id="form" data-token="${documentToken}-form"><label for="note">Network note</label><input id="note" data-token="${documentToken}-note" autocomplete="off"><button id="save" data-token="${documentToken}-save">Save network note</button><output id="receipt">Waiting</output></form>` : ""}
        ${child ? "" : `<button id="add-network-frame" data-token="${documentToken}-add" type="button">Add network frame</button>${layout === "oopif" ? `<iframe id="network-frame" src="${childURL}"></iframe>` : ""}`}
        <script>(${installRestrictedNetworkPage.toString()})(${json(config)});</script>`;
      const bytes = Buffer.from(html); entry.documents.push({ ...config, href: url.href, bytes: bytes.length, sha256: hash(bytes) });
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }); response.end(bytes); return true;
    }
    const entry = entries.get(key); if (!entry) { response.writeHead(404); response.end(); return true; }
    const cors = { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store", "Content-Type": "application/json" };
    if (url.pathname.endsWith("/receipt") || url.pathname.endsWith("/redirect-hop")) {
      const post = entry.posts[0]; entry.redirects.push({ method: request.method, href: url.href });
      if (request.method !== "GET" || !post?.receipt) { response.writeHead(400); response.end(); return true; }
      if (url.pathname.endsWith("/redirect-hop")) { const next = new URL(url); next.hostname = "127.0.0.1"; next.pathname = basePath + "receipt"; response.writeHead(302, { ...cors, Location: next.href }); response.end(); }
      else { response.writeHead(200, cors); response.end(JSON.stringify(post.receipt)); } return true;
    }
    if (request.method !== "POST" || entry.posts.length >= 4) { response.writeHead(400); response.end(); return true; }
    const post = { method: request.method, href: url.href, receivedAt: Date.now(), index: entry.posts.length + 1 }, chunks = []; let size = 0; entry.posts.push(post);
    request.on("data", chunk => { size += chunk.length; if (size <= 32768) chunks.push(chunk); });
    request.once("error", () => { post.error = "Original request failed"; }); request.once("aborted", () => { post.error = "Original request aborted"; });
    request.once("end", () => {
      const bytes = Buffer.concat(chunks); Object.assign(post, { bodyBytes: size, bodyBase64: bytes.toString("base64"), bodySHA256: hash(bytes) });
      try {
        assert.ok(size <= 32768); post.value = JSON.parse(bytes); assert.equal(post.value.key, key); assert.equal(post.value.trustedSubmit, true);
        assert.equal(entry.documents.filter(doc => doc.documentToken === post.value.documentToken && doc.href === post.value.href).length, 1);
        post.receipt = { key, index: post.index, documentToken: post.value.documentToken, bodySHA256: post.bodySHA256 };
        const finish = () => { if (response.destroyed) { post.responseClosedBeforeHeaders = true; return; } post.status = mode === "503" ? 503 : ["redirect", "redirect-denied"].includes(mode) ? 302 : 201; post.headersAt = Date.now();
          if (["redirect", "redirect-denied"].includes(mode)) { const next = new URL(url); next.hostname = "localhost"; next.pathname = basePath + (mode === "redirect-denied" ? "redirect-hop" : "receipt"); response.writeHead(302, { ...cors, Location: next.href }); response.end(); }
          else { response.writeHead(post.status, cors); response.end(JSON.stringify(post.receipt)); } post.finishedAt = Date.now(); };
        if (mode === "headers-gate") gates.set(key, finish); else finish();
      } catch { post.error = "Invalid original network submission"; response.writeHead(400, cors); response.end(JSON.stringify({ error: post.error })); }
    }); return true;
  } };
}

// An observer only: no Network.enable, request interception or native mutation.
export function installRestrictedNetworkEvidence(api, target, tabId) {
  if (target.__restrictedNetworkEvidence) throw Error("Network evidence already installed");
  const rows = [], selected = new Set(); let overflow = false;
  const listener = (source, method, params) => {
    if (source.tabId !== tabId || !["Network.requestWillBeSent", "Network.responseReceived", "Network.loadingFinished", "Network.loadingFailed", "Page.frameNavigated"].includes(method)) return;
    const identity = `${source.sessionId ?? "root"}:${params.requestId}`, url = params.request?.url ?? params.response?.url;
    if (url?.includes("/restricted-network/")) selected.add(identity);
    if (method === "Page.frameNavigated" ? !params.frame?.url?.includes("/restricted-network/") : !selected.has(identity)) return;
    if (rows.length >= 256) { overflow = true; return; }
    const copy = structuredClone(params); if (copy.request) copy.request = { url: copy.request.url, method: copy.request.method, postData: copy.request.postData };
    if (copy.response) copy.response = { url: copy.response.url, status: copy.response.status, fromServiceWorker: copy.response.fromServiceWorker };
    rows.push({ sequence: rows.length + 1, at: Date.now(), source: { ...source }, method, params: copy });
  };
  api.debugger.onEvent.addListener(listener);
  target.__restrictedNetworkEvidence = { snapshot() { return structuredClone({ rows, overflow }); }, stop() { api.debugger.onEvent.removeListener(listener); delete target.__restrictedNetworkEvidence; return { rows, overflow, restored: !api.debugger.onEvent.hasListener(listener), removed: !target.__restrictedNetworkEvidence }; } };
}

export async function runRestrictedNetworkWireCaller(call, config, detail = {}) {
  Object.assign(detail, { scope: structuredClone(config.scope), tabId: config.tabId }); const handles = []; let failure;
  const invoke = (method, params) => call(method, { ...config.scope, tabId: config.tabId, ...params });
  const action = (action, selector, args = {}, child = config.layout !== "root") => invoke("browserAction", { action, locator: [...(child ? [{ kind: "frame", selector: "#network-frame" }] : []), { kind: "css", selector }], args, timeoutMs: 5000 });
  try {
    for (const event of ["request", "response"]) { const ack = await invoke("armNetworkWait", { event, match: { url: config.apiURL, method: "POST", ...(event === "response" ? { status: 201 } : {}) }, timeoutMs: 10000 }); detail[`${event}Ack`] = ack; handles.push(ack); }
    if (config.layout === "dynamic-oopif") await action("click", "#add-network-frame", {}, false);
    await action("fill", "#note", { value: config.value }); await action("click", "#save");
    for (const event of ["request", "response"]) detail[event] = await invoke("collectNetworkWait", { waiterId: detail[`${event}Ack`].waiterId });
    detail.responseAgain = await invoke("collectNetworkWait", { waiterId: detail.responseAck.waiterId });
    await action("waitFor", `#receipt:has-text("Saved ${config.key} 1 ")`, { state: "visible" }); detail.receipt = (await action("textContent", "#receipt")).value;
  } catch (error) { failure = error; detail.error = text(error); }
  finally { detail.cancelled = true; for (const handle of handles) try { assert.deepEqual(await invoke("cancelNetworkWait", { waiterId: handle.waiterId }), {}); } catch (error) { detail.cancelled = false; (detail.cleanupErrors ??= []).push(text(error)); failure ??= error; } }
  if (failure) throw failure; return detail;
}

async function typedCaller(tab, config, detail) {
  const handles = []; let failure;
  Object.assign(detail, { scope: structuredClone(config.scope), tabId: tab.id });
  try {
    for (const event of ["request", "response"]) { const handle = await tab[event === "request" ? "expectRequest" : "expectResponse"]({ url: config.apiURL, method: "POST", ...(event === "response" ? { status: 201 } : {}) }, { timeoutMs: 10000 }); handles.push(handle); detail[`${event}Ack`] = { waiterId: handle.waiterId, remainingMs: handle.remainingMs }; }
    if (config.layout === "dynamic-oopif") await tab.locator("#add-network-frame").click();
    const target = targetOf(tab, config.layout); await target.locator("#note").fill(config.value); await target.locator("#save").click();
    detail.request = await handles[0].result(); detail.response = await handles[1].result(); detail.responseAgain = await handles[1].result();
    await target.getByText(`Saved ${config.key} 1 `, { exact: false }).waitFor({ timeoutMs: 5000 }); detail.receipt = await target.locator("#receipt").textContent();
  } catch (error) { failure = error; detail.error = text(error); }
  finally { detail.cancelled = true; for (const handle of handles) try { await handle.cancel(); } catch (error) { detail.cancelled = false; (detail.cleanupErrors ??= []).push(text(error)); failure ??= error; } }
  if (failure) throw failure; return detail;
}

async function snapshot(worker, tabId) {
  return worker.evaluate(`(async()=>{const observer=globalThis.__integrationFrameObserver.snapshot();return{observer,frames:await chrome.webNavigation.getAllFrames({tabId:${tabId}}),documents:await chrome.scripting.executeScript({target:{tabId:${tabId},allFrames:true},world:'MAIN',func:()=>window.restrictedNetworkState?.()??null}),targets:await chrome.debugger.getTargets(),oopifs:globalThis.__integrationFrames.filter(row=>row.tabId===${tabId})}})()`);
}
export function checkRestrictedNetworkEvidence(item, record) {
  assert.equal(record.posts.length, 1); const post = record.posts[0], bytes = Buffer.from(post.bodyBase64, "base64"), result = item.callerResult;
  assert.equal(post.error, undefined); assert.equal(bytes.length, post.bodyBytes); assert.equal(hash(bytes), post.bodySHA256); assert.deepEqual(JSON.parse(bytes), post.value); assert.equal(post.status, 201); assert.ok(post.finishedAt);
  const doc = record.documents.filter(doc => doc.child === (item.layout !== "root")); assert.equal(doc.length, 1); const original = doc[0];
  const after = item.after.documents.filter(row => row.result?.documentToken === original.documentToken); assert.equal(after.length, 1); const state = after[0].result;
  assert.equal(state.original, true); assert.equal(state.overflow, false); assert.deepEqual(state.errors, []); assert.equal(state.href, original.href); assert.equal(state.value, item.value); assert.equal(state.nodeToken, `${original.documentToken}-note`);
  assert.equal(post.value.documentToken, original.documentToken); assert.equal(post.value.nodeToken, state.nodeToken); assert.equal(post.value.href, state.href); assert.equal(post.value.value, item.value); assert.equal(post.value.trustedSubmit, true); assert.deepEqual(post.value.events, state.events);
  assert.deepEqual(state.events.map(row => [row.type, row.targetId, row.trusted]), [["input", "note", true], ["click", "save", true], ["submit", "form", true]]);
  assert.deepEqual(state.receipt, post.receipt); assert.equal(state.completions.length, 1); assert.equal(state.completions[0].status, 201); assert.equal(state.completions[0].url, item.apiURL);
  assert.equal(result.receipt, `Saved ${item.key} 1 ${post.bodySHA256}`); assert.equal(result.cancelled, true); assert.deepEqual(result.scope, item.scope); assert.equal(result.tabId, item.tabId);
  for (const event of ["request", "response"]) {
    const ack = result[`${event}Ack`], value = result[event]; assert.ok(ack.waiterId && ack.remainingMs > 0 && ack.remainingMs <= 10000);
    assert.equal(value.event, event); assert.equal(value.url, item.apiURL); assert.equal(value.method, "POST"); assert.equal(value.resourceType, "fetch"); assert.equal(value.frameUrl, original.href); assert.ok(value.requestId);
    assert.deepEqual(Object.keys(value).sort(), (event === "request" ? ["event", "requestId", "url", "method", "resourceType", "frameUrl"] : ["event", "requestId", "url", "method", "resourceType", "frameUrl", "status", "statusText"]).sort());
  }
  assert.notEqual(result.requestAck.waiterId, result.responseAck.waiterId); assert.equal(result.response.status, 201); assert.equal(result.request.requestId, result.response.requestId); assert.deepEqual(result.responseAgain, result.response);
  assert.equal(item.nativeEvidence.overflow, false); assert.equal(item.nativeEvidence.restored, true); assert.equal(item.nativeEvidence.removed, true);
  const sent = item.nativeEvidence.rows.filter(row => row.method === "Network.requestWillBeSent" && row.params.request?.url === item.apiURL && row.params.request.method === "POST"); assert.equal(sent.length, 1);
  const native = sent[0], response = item.nativeEvidence.rows.filter(row => row.method === "Network.responseReceived" && row.params.requestId === native.params.requestId && (row.source.sessionId ?? null) === (native.source.sessionId ?? null));
  assert.equal(response.length, 1); assert.equal(response[0].params.response.url, item.apiURL); assert.equal(response[0].params.response.status, 201); assert.equal(native.source.tabId, item.tabId);
  if (native.params.request.postData !== undefined) assert.equal(native.params.request.postData, bytes.toString("utf8"));
  const root = record.documents.find(row => !row.child); assert.ok(root);
  for (const initial of item.before.documents) { const final = item.after.documents.find(row => row.documentId === initial.documentId); assert.ok(final); assert.equal(final.result.documentToken, initial.result.documentToken); }
  const rootState = item.after.documents.find(row => row.result?.documentToken === root.documentToken).result;
  if (item.layout !== "root") assert.deepEqual(rootState.events.map(row => [row.type, row.targetId, row.trusted]), item.layout === "dynamic-oopif" ? [["click", "add-network-frame", true]] : []);
  if (item.layout !== "root") {
    const proof = checkResponseBodyOOPIF({ ...item.after, tab: { id: item.tabId } }, { tabId: item.tabId, rootURL: root.href, childURL: original.href });
    assert.equal(native.source.sessionId, proof.sessionId); assert.equal(native.params.frameId, proof.targetId); item.oopifProof = proof;
  } else { assert.equal(native.source.sessionId, undefined); const target = item.after.targets.filter(row => row.tabId === item.tabId && row.type === "page"); assert.equal(target.length, 1); assert.equal(native.params.frameId, target[0].id); }
  return { posts: 1, bytes: bytes.length, sha256: hash(bytes), documentId: after[0].documentId, nativeRequestId: native.params.requestId, publicRequestId: result.request.requestId };
}

export async function checkRestrictedNetworkCaller({ kind, browser, fixtureURL, fixtures, getWorker, until, caller, detail = {} }) {
  Object.assign(detail, { caller: kind, variants: [], boundary: "Original metadata only; public request IDs are not native CDP IDs. HTTP bytes and passive original native events bind the same unique submission." }); let failure;
  for (const layout of layouts) {
    const key = `restricted-network-${kind}-${layout}`, url = restrictedNetworkURL(fixtureURL, key, layout), tab = await browser.newTab({ url });
    const item = { key, layout, tabId: tab.id, scope: scopeOf(browser), value: `Original ${kind} ${layout} π`, callerResult: {} }; detail.variants.push(item);
    item.apiURL = restrictedNetworkAPIURL(layout === "root" ? url : restrictedNetworkURL(fixtureURL, key, layout, "normal", "child"));
    let installed = false;
    try {
      await until(async () => { const value = await snapshot(getWorker(), tab.id); return value.documents.length === (layout === "oopif" ? 2 : 1) && value.documents.every(row => row.result?.documentToken) ? (item.before = value) : false; }, "original restricted network documents ready");
      await getWorker().evaluate(`(${installRestrictedNetworkEvidence.toString()})(chrome,globalThis,${tab.id})`); installed = true;
      const config = { ...item, scope: { ...item.scope } }; delete config.before; delete config.callerResult;
      item.callerResult = caller ? await caller(config, item) : await typedCaller(tab, config, item.callerResult);
    } catch (error) { failure = error; item.error = text(error); }
    finally {
      if (installed) try { item.nativeEvidence = await getWorker().evaluate("globalThis.__restrictedNetworkEvidence.stop()"); } catch (error) { item.nativeEvidenceError = text(error); failure ??= error; }
      try { item.after = await snapshot(getWorker(), tab.id); } catch (error) { item.afterError = text(error); failure ??= error; }
      item.server = fixtures.stats(key);
    }
    if (!failure) try { item.proof = checkRestrictedNetworkEvidence(item, item.server); item.passed = true; } catch (error) { failure = error; item.error = text(error); }
    if (failure) break;
  }
  detail.serverLedger = fixtures.allStats(); if (failure) { detail.error = text(failure); throw failure; } return detail;
}

export async function checkRestrictedNetworkPolicy({ popup, fixtureURL, until, runAllowed, runBoundaries, saveDetail }) {
  assert.ok(popup, "Network policy workflow borrows the existing real popup"); const controls = restrictedDialogPolicyControls({ popup, until }), detail = { popupOwnership: "borrowed" }; let failure;
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

export function checkRestrictedNetworkBoundaryEvidence(item) {
  if (item.name === "allowed-document-navigation") return checkRestrictedNetworkNavigationEvidence(item);
  const { server, before, after, nativeEvidence: native } = item;
  assert.equal(native.overflow, false); assert.equal(native.restored, true); assert.equal(native.removed, true);
  const original = before.documents.find(row => row.frameId === 0); assert.ok(original?.documentId); assert.equal(original.result.original, true); assert.deepEqual(original.result.events, []);
  const doc = server.documents.find(row => row.documentToken === original.result.documentToken); assert.ok(doc); assert.equal(doc.href, item.url);
  const current = after.documents.find(row => row.frameId === 0); assert.ok(current?.documentId); assert.equal(current.result.original, true); assert.equal(current.result.overflow, false);
  const business = item.beforeNavigation?.documents.find(row => row.documentId === original.documentId)?.result ?? current.result;
  if (item.beforeNavigation) { assert.equal(business.documentToken, original.result.documentToken); assert.equal(business.original, true); assert.equal(business.overflow, false); assert.deepEqual(business.errors, []); }
  if (item.navigated) { assert.notEqual(current.documentId, original.documentId); assert.notEqual(current.result.documentToken, original.result.documentToken); assert.equal(current.result.href, original.result.href); assert.deepEqual(current.result.events, []); }
  else { assert.equal(current.documentId, original.documentId); assert.equal(current.result.documentToken, original.result.documentToken); assert.equal(current.result.href, doc.href); assert.deepEqual(current.result.errors, []); }
  const expectedEvents = item.submissions.flatMap(() => [["input", "note", true], ["click", "save", true], ["submit", "form", true]]);
  if (item.addedChild) expectedEvents.push(["click", "add-network-frame", true]);
  if (!item.navigated) assert.deepEqual(current.result.events.map(row => [row.type, row.targetId, row.trusted]), expectedEvents);
  if (item.beforeNavigation) assert.deepEqual(business.events.map(row => [row.type, row.targetId, row.trusted]), expectedEvents);
  assert.equal(server.posts.length, item.submissions.length);
  const sent = native.rows.filter(row => row.method === "Network.requestWillBeSent" && row.params.request?.method === "POST" && row.params.request.url === item.apiURL);
  assert.equal(sent.length, server.posts.length); assert.equal(new Set(sent.map(row => `${row.source.sessionId ?? "root"}:${row.params.requestId}`)).size, sent.length);
  const responses = native.rows.filter(row => row.method === "Network.responseReceived");
  for (let index = 0; index < server.posts.length; index++) {
    const post = server.posts[index], submission = item.submissions[index], bytes = Buffer.from(post.bodyBase64, "base64"), request = sent[index];
    assert.equal(post.error, undefined); assert.equal(post.bodyBytes, bytes.length); assert.equal(post.bodySHA256, hash(bytes)); assert.deepEqual(JSON.parse(bytes), post.value);
    assert.equal(post.index, index + 1); assert.equal(post.method, "POST"); assert.equal(post.href, item.apiURL); assert.equal(post.value.trustedSubmit, true); assert.equal(post.value.documentToken, doc.documentToken);
    assert.equal(post.value.nodeToken, `${doc.documentToken}-note`); assert.equal(post.value.href, doc.href); assert.equal(post.value.value, submission.value);
    assert.deepEqual(post.value.events.map(row => [row.type, row.targetId, row.trusted]), expectedEvents.slice(0, (index + 1) * 3));
    assert.equal(request.source.tabId, item.tabId); assert.equal(request.source.sessionId, undefined); assert.ok(request.params.frameId); assert.ok(request.params.loaderId);
    const target = after.targets.find(row => row.tabId === item.tabId && row.type === "page"); assert.ok(target); assert.equal(request.params.frameId, target.id);
    if (request.params.request.postData !== undefined) assert.equal(request.params.request.postData, bytes.toString("utf8"));
    if (submission.completed) {
      assert.equal(submission.receipt, `Saved ${item.key} ${index + 1} ${post.bodySHA256}`);
      const completion = business.completions[index]; assert.deepEqual(completion.receipt, post.receipt); assert.equal(completion.status, submission.status); assert.equal(completion.url, submission.responseURL);
      const nativeResponse = responses.filter(row => row.params.requestId === request.params.requestId && row.params.response.url === submission.responseURL);
      assert.equal(nativeResponse.length, 1); assert.equal(nativeResponse[0].source.tabId, item.tabId); assert.equal(nativeResponse[0].source.sessionId, undefined); assert.equal(nativeResponse[0].params.response.status, submission.status);
      const finished = native.rows.filter(row => row.method === "Network.loadingFinished" && row.params.requestId === request.params.requestId); assert.equal(finished.length, 1); assert.equal(finished[0].source.tabId, item.tabId); assert.equal(finished[0].source.sessionId, undefined);
      assert.ok(request.sequence < nativeResponse[0].sequence && nativeResponse[0].sequence < finished[0].sequence);
    } else assert.equal(item.navigated, true, "Only the original no-response navigation submission may lack a business receipt");
  }
  if (!item.navigated) { assert.equal(current.result.completions.length, item.submissions.length); if (server.posts.length) assert.deepEqual(current.result.receipt, server.posts.at(-1).receipt); }
  for (const [name, ack] of Object.entries(item.acks)) { assert.ok(ack.waiterId, name); assert.ok(ack.remainingMs > 0 && ack.remainingMs <= 10000, name); }
  assert.equal(new Set(Object.values(item.acks).map(row => row.waiterId)).size, Object.values(item.acks).length);
  for (const [name, value] of Object.entries(item.results)) {
    const expectation = item.expectedResults[name]; assert.ok(expectation, `Unexpected public metadata ${name}`);
    assert.deepEqual(Object.keys(value).sort(), ["event", "requestId", "url", "method", "resourceType", "frameUrl", ...(expectation.event === "response" ? ["status", "statusText"] : []), ...(expectation.redirected ? ["redirectedFrom"] : [])].sort());
    assert.equal(value.event, expectation.event); assert.equal(value.url, expectation.url); assert.equal(value.method, expectation.method); assert.equal(value.resourceType, "fetch"); assert.equal(value.frameUrl, doc.href); assert.ok(value.requestId);
    if (expectation.event === "response") assert.equal(value.status, expectation.status);
    if (expectation.redirected) assert.equal(value.redirectedFrom, item.results[expectation.redirected].requestId);
  }
  assert.deepEqual(Object.keys(item.results).sort(), Object.keys(item.expectedResults).sort());
  if (item.results.request && item.results.response && !item.expectedResults.response.redirected) assert.equal(item.results.request.requestId, item.results.response.requestId);
  if (item.results.responseAgain) assert.deepEqual(item.results.responseAgain, item.results.response);
  if (item.results.secondResponse) { assert.notEqual(item.results.response.requestId, item.results.secondResponse.requestId); assert.equal(item.results.secondRequest.requestId, item.results.secondResponse.requestId); }
  if (item.name === "navigation-no-response") { assert.equal(item.rejections.length, 1); assert.equal(item.rejections[0].authority, "no-response"); }
  for (const entry of item.rejections) {
    assert.equal(entry.metadata, undefined);
    if (entry.authority === "no-response") {
      assert.equal(item.name, "navigation-no-response"); assert.equal(item.mode, "headers-gate"); assert.equal(item.navigated, true); assert.equal(sent.length, 1);
      assert.equal(entry.name, "original-response-timeout-after-navigation"); assert.match(entry.error, /^OBU_NETWORK_WAIT_TIMEOUT:/);
      const post = server.posts[0], request = sent[0], timing = item.ackTiming.response;
      assert.equal(request.params.documentURL, original.result.href);
      assert.equal(post.responseClosedBeforeHeaders, true); for (const field of ["headersAt", "status", "finishedAt"]) assert.equal(Object.hasOwn(post, field), false, `The original server must not have sent ${field}`);
      assert.equal(responses.filter(row => row.params.requestId === request.params.requestId).length, 0);
      assert.equal(native.rows.filter(row => row.method === "Network.loadingFinished" && row.params.requestId === request.params.requestId).length, 0);
      assert.deepEqual(item.heldBeforeNavigation.nativePosts, [request]); assert.equal(item.heldBeforeNavigation.nativeResponses.length, 0);
      assert.equal(timing.timeoutMs, 3000); assert.ok(timing.readyAt >= timing.startedAt); assert.ok(entry.at - timing.startedAt >= timing.timeoutMs); assert.ok(item.acks.response.remainingMs <= timing.timeoutMs);
      assert.deepEqual(Object.keys(item.acks), ["response"]); assert.deepEqual(item.results, {}); assert.deepEqual(item.expectedResults, {});
      assert.deepEqual(current.result.completions, []); assert.deepEqual(current.result.errors, []); assert.equal(current.result.receipt, null); assert.equal(current.result.value, "");
      assert.equal(server.documents.length, 2); assert.deepEqual(server.documents.map(row => [row.href, row.documentToken]), [[item.url, original.result.documentToken], [item.url, current.result.documentToken]]);
      const navigations = native.rows.filter(row => row.method === "Network.requestWillBeSent" && row.params.request?.url === item.url); assert.equal(navigations.length, 1); const navigation = navigations[0];
      assert.equal(navigation.params.request.method, "GET"); assert.equal(navigation.params.type, "Document"); assert.equal(navigation.params.documentURL, item.url); assert.equal(navigation.params.frameId, request.params.frameId);
      assert.ok(navigation.params.loaderId); assert.notEqual(navigation.params.loaderId, request.params.loaderId); assert.notEqual(navigation.params.requestId, request.params.requestId);
      const commits = native.rows.filter(row => row.method === "Page.frameNavigated" && row.params.frame.id === request.params.frameId && row.params.frame.url === item.url); assert.equal(commits.length, 1); assert.equal(commits[0].params.frame.loaderId, navigation.params.loaderId);
      const navigationResponses = responses.filter(row => row.params.requestId === navigation.params.requestId); assert.equal(navigationResponses.length, 1); assert.equal(navigationResponses[0].params.response.url, item.url); assert.equal(navigationResponses[0].params.response.status, 200);
      const navigationFinished = native.rows.filter(row => row.method === "Network.loadingFinished" && row.params.requestId === navigation.params.requestId); assert.equal(navigationFinished.length, 1);
      for (const row of [navigation, commits[0], navigationResponses[0], navigationFinished[0]]) { assert.equal(row.source.tabId, item.tabId); assert.equal(row.source.sessionId, undefined); }
      assert.ok(request.sequence < navigation.sequence && navigation.sequence < commits[0].sequence); assert.ok(navigation.sequence < navigationResponses[0].sequence && navigationResponses[0].sequence < navigationFinished[0].sequence);
      // The server observed a closed response before sending headers. Chromium
      // need not deliver loadingFailed for this original POST, so retain any
      // such event without calling this a native cancellation or site denial.
      item.noResponseProof = { classification: "navigation-no-response", serverClosedBeforeHeaders: true, nativeRequestId: request.params.requestId, originalLoaderId: request.params.loaderId,
        navigationRequestId: navigation.params.requestId, navigationLoaderId: navigation.params.loaderId, newDocumentId: current.documentId, elapsedMs: entry.at - timing.startedAt };
    } else assert.match(entry.error, entry.authority === "denied" ? denied : retired);
  }
  for (const cancellation of item.cancellations) {
    if (item.policyRetired) { assert.equal(cancellation.success, undefined); assert.match(cancellation.error, revokedControl); }
    else { assert.equal(cancellation.success, true); assert.equal(cancellation.error, undefined); }
  }
  assert.equal(item.cancellations.length, Object.keys(item.acks).length);
  if (item.addedChild || item.layout === "oopif") {
    const child = server.documents.filter(row => row.child); assert.equal(child.length, 1); assert.equal(new URL(child[0].href).hostname, "localhost");
    // Revocation may correctly detach the debugger; the negative proof is the
    // browser's actual live frame/document/process tree, not a live attachment.
    const rootFrame = after.frames.find(row => row.frameId === 0 && row.documentId === original.documentId), childFrames = after.frames.filter(row => row.parentFrameId === 0 && row.url === child[0].href);
    assert.ok(rootFrame); assert.equal(childFrames.length, 1); const childFrame = childFrames[0]; assert.equal(childFrame.parentDocumentId, rootFrame.documentId); assert.ok(childFrame.documentId); assert.notEqual(childFrame.documentId, rootFrame.documentId);
    for (const frame of [rootFrame, childFrame]) { assert.equal(frame.documentLifecycle, "active"); assert.equal(frame.errorOccurred, false); assert.ok(Number.isSafeInteger(frame.processId) && frame.processId > 0); }
    assert.notEqual(childFrame.processId, rootFrame.processId); item.deniedChildProof = { frameId: childFrame.frameId, documentId: childFrame.documentId, processId: childFrame.processId, parentDocumentId: rootFrame.documentId, rootProcessId: rootFrame.processId };
  }
  if (item.mode.startsWith("redirect")) {
    const expectedURLs = [new URL(item.apiURL)]; expectedURLs[0].hostname = "localhost"; expectedURLs[0].pathname = basePath + (item.mode === "redirect-denied" ? "redirect-hop" : "receipt");
    if (item.mode === "redirect-denied") { const end = new URL(item.apiURL); end.pathname = basePath + "receipt"; expectedURLs.push(end); }
    assert.deepEqual(server.redirects, expectedURLs.map(url => ({ method: "GET", href: url.href })));
    const chain = native.rows.filter(row => row.method === "Network.requestWillBeSent" && row.params.requestId === sent[0].params.requestId);
    assert.deepEqual(chain.map(row => [row.params.request.method, row.params.request.url]), [["POST", item.apiURL], ...expectedURLs.map(url => ["GET", url.href])]);
    for (let i = 1; i < chain.length; i++) { assert.equal(chain[i].params.redirectResponse.status, 302); assert.equal(chain[i].params.redirectResponse.url, chain[i - 1].params.request.url); }
  } else assert.deepEqual(server.redirects, []);
  if (item.heldBeforeArm) { assert.equal(item.heldBeforeArm.headersAt, undefined); assert.equal(item.heldBeforeArm.nativePosts.length, 1); assert.equal(item.heldBeforeArm.nativeResponses.length, 0); assert.ok(item.acks.response); }
  if (item.heldBeforeNavigation) { assert.equal(item.heldBeforeNavigation.headersAt, undefined); assert.equal(item.heldBeforeNavigation.nativePosts.length, 1); assert.equal(item.heldBeforeNavigation.nativeResponses.length, 0); assert.equal(item.navigated, true); }
  return { posts: server.posts.length, bytes: server.posts.reduce((sum, post) => sum + post.bodyBytes, 0), originalDocumentId: original.documentId, publicMetadata: Object.keys(item.results).length,
    authorityRejections: item.rejections.filter(row => row.authority !== "no-response").length, noResponseTimeouts: item.rejections.filter(row => row.authority === "no-response").length };
}

export function checkRestrictedNetworkNavigationEvidence(item) {
  const before = item.before.documents.find(row => row.frameId === 0), after = item.after.documents.find(row => row.frameId === 0), native = item.nativeEvidence;
  assert.ok(before?.documentId); assert.ok(after?.documentId); assert.notEqual(after.documentId, before.documentId); assert.notEqual(after.result.documentToken, before.result.documentToken);
  assert.equal(after.result.href, item.destinationURL); assert.equal(after.result.original, true); assert.deepEqual(after.result.events, []); assert.deepEqual(after.result.completions, []); assert.deepEqual(after.result.errors, []); assert.equal(after.result.overflow, false);
  assert.deepEqual(item.server.posts, []); assert.deepEqual(item.server.redirects, []); assert.deepEqual(item.submissions, []); assert.deepEqual(item.rejections, []); assert.equal(item.server.documents.length, 2);
  assert.equal(item.server.documents[0].documentToken, before.result.documentToken); assert.equal(item.server.documents[1].documentToken, after.result.documentToken);
  assert.equal(native.overflow, false); assert.equal(native.restored, true); assert.equal(native.removed, true);
  const requests = native.rows.filter(row => row.method === "Network.requestWillBeSent" && row.params.request.url === item.destinationURL); assert.equal(requests.length, 1); const request = requests[0];
  assert.equal(request.params.request.method, "GET"); assert.equal(request.params.type, "Document"); assert.equal(request.params.documentURL, item.destinationURL); assert.ok(request.params.loaderId);
  assert.equal(request.source.tabId, item.tabId); assert.equal(request.source.sessionId, undefined);
  const response = native.rows.filter(row => row.method === "Network.responseReceived" && row.params.requestId === request.params.requestId); assert.equal(response.length, 1); assert.equal(response[0].params.response.url, item.destinationURL); assert.equal(response[0].params.response.status, 200);
  const commits = native.rows.filter(row => row.method === "Page.frameNavigated" && row.params.frame.id === request.params.frameId && row.params.frame.loaderId === request.params.loaderId && row.params.frame.url === item.destinationURL);
  assert.equal(commits.length, 1); assert.ok(request.sequence < commits[0].sequence);
  const finished = native.rows.filter(row => row.method === "Network.loadingFinished" && row.params.requestId === request.params.requestId); assert.equal(finished.length, 1);
  for (const row of [response[0], commits[0], finished[0]]) { assert.equal(row.source.tabId, item.tabId); assert.equal(row.source.sessionId, undefined); }
  assert.ok(request.sequence < response[0].sequence && response[0].sequence < finished[0].sequence);
  for (const event of ["request", "response"]) {
    const ack = item.acks[event], value = item.results[event]; assert.ok(ack.waiterId); assert.ok(ack.remainingMs > 0 && ack.remainingMs <= 10000);
    assert.deepEqual(Object.keys(value).sort(), ["event", "requestId", "url", "method", "resourceType", "frameUrl", ...(event === "response" ? ["status", "statusText"] : [])].sort());
    assert.equal(value.event, event); assert.equal(value.url, item.destinationURL); assert.equal(value.method, "GET"); assert.equal(value.resourceType, "document"); assert.equal(value.frameUrl, before.result.href); assert.ok(value.requestId);
  }
  assert.equal(item.results.response.status, 200); assert.equal(item.results.request.requestId, item.results.response.requestId); assert.notEqual(item.acks.request.waiterId, item.acks.response.waiterId);
  assert.deepEqual(Object.keys(item.results).sort(), ["request", "response"]); assert.equal(item.cancellations.length, 2); for (const row of item.cancellations) { assert.equal(row.success, true); assert.equal(row.error, undefined); }
  return { posts: 0, navigationGETs: 1, nativeRequestId: request.params.requestId, nativeLoaderId: request.params.loaderId, oldDocumentId: before.documentId, newDocumentId: after.documentId };
}

export async function checkRestrictedNetworkBoundaries({ connectBrowser, getWorker, fixtureURL, fixtures, controls, until, saveDetail }) {
  const browser = await connectBrowser("js-restricted-network-boundaries"), detail = { tabIds: [], cases: [], boundary: "Page fetches are not blocked by the agent site policy. Native observations and server bytes are independent evidence, never exposed by denied public waits. Navigation is one public goto, not a trusted click. Its frameUrl is the original request-event Frame URL; native documentURL and committed loader are checked separately. No frameless-worker claim is made here." }; let failure;
  const prepare = async (name, mode = "normal", layout = "root") => {
    const key = `restricted-network-boundary-${name}`, url = restrictedNetworkURL(fixtureURL, key, layout, mode), item = { name, key, url, mode, layout, apiURL: restrictedNetworkAPIURL(url), submissions: [], acks: {}, ackTiming: {}, results: {}, expectedResults: {}, rejections: [], cancellations: [] };
    detail.cases.push(item); const tab = await browser.newTab({ url }); item.tabId = tab.id; detail.tabIds.push(tab.id);
    await until(async () => { const state = await snapshot(getWorker(), tab.id); return state.documents.length === (layout === "oopif" ? 2 : 1) && state.documents.every(row => row.result?.documentToken) ? (item.before = state) : false; }, "original network boundary document");
    return { item, tab };
  };
  const run = async (prepared, action) => {
    const { item, tab } = prepared, handles = []; let first, installed = false;
    const arm = async (name, event, match, timeoutMs = 10000) => { const startedAt = performance.now(), handle = await tab[event === "request" ? "expectRequest" : "expectResponse"](match, { timeoutMs }); item.ackTiming[name] = { startedAt, readyAt: performance.now(), timeoutMs }; item.acks[name] = { waiterId: handle.waiterId, remainingMs: handle.remainingMs }; handles.push({ name, handle }); return handle; };
    const result = async (name, handle, expectation) => { item.results[name] = await handle.result(); item.expectedResults[name] = expectation; return item.results[name]; };
    const reject = async (name, operation, authority = "retired") => {
      const entry = { name, authority }; item.rejections.push(entry); try { entry.metadata = await operation(); } catch (error) { entry.error = String(error.message ?? error); } entry.at = performance.now();
      assert.ok(entry.error, `${name} unexpectedly returned metadata`); assert.match(entry.error, authority === "denied" ? denied : authority === "no-response" ? /^OBU_NETWORK_WAIT_TIMEOUT:/ : retired); return entry.error;
    };
    const submit = async (value, status = 201, responseURL = item.apiURL, complete = true) => {
      const submission = { value, status, responseURL, completed: false }; item.submissions.push(submission);
      await tab.locator("#note").fill(value); await tab.locator("#save").click();
      if (complete) await receipt(submission); return submission;
    };
    const receipt = async submission => { const index = item.submissions.indexOf(submission) + 1; await tab.getByText(`Saved ${item.key} ${index} `, { exact: false }).waitFor({ timeoutMs: 5000 }); submission.receipt = await tab.locator("#receipt").textContent(); submission.completed = true; };
    const requestExpected = { event: "request", url: item.apiURL, method: "POST" }, responseExpected = status => ({ event: "response", url: item.apiURL, method: "POST", status });
    try {
      item.scope = scopeOf(browser); await getWorker().evaluate(`(${installRestrictedNetworkEvidence.toString()})(chrome,globalThis,${tab.id})`); installed = true;
      await action({ item, tab, arm, result, reject, submit, receipt, requestExpected, responseExpected });
    } catch (error) { first = error; item.error = text(error); }
    finally {
      fixtures.release(item.key);
      for (const { name, handle } of handles) { const cancellation = { name }; item.cancellations.push(cancellation); try { await handle.cancel(); cancellation.success = true; } catch (error) { cancellation.error = text(error); if (!item.policyRetired || !revokedControl.test(cancellation.error)) first ??= error; } }
      if (installed) try { item.nativeEvidence = await getWorker().evaluate("globalThis.__restrictedNetworkEvidence.stop()"); } catch (error) { item.nativeEvidenceError = text(error); first ??= error; }
      try { item.after = await snapshot(getWorker(), tab.id); } catch (error) { item.afterError = text(error); first ??= error; }
      item.server = fixtures.stats(item.key);
    }
    if (!first) try { item.proof = checkRestrictedNetworkBoundaryEvidence(item); item.passed = true; } catch (error) { first = error; item.error = text(error); }
    if (first) throw first; return item;
  };
  const held = async item => until(async () => {
    const post = fixtures.stats(item.key).posts[0]; if (!post?.bodySHA256) return false;
    const native = await getWorker().evaluate("globalThis.__restrictedNetworkEvidence.snapshot()"); assert.equal(native.overflow, false);
    const nativePosts = native.rows.filter(row => row.method === "Network.requestWillBeSent" && row.params.request?.url === item.apiURL && row.params.request.method === "POST");
    if (nativePosts.length !== 1) return false;
    return { headersAt: post.headersAt, nativePosts, nativeResponses: native.rows.filter(row => row.method === "Network.responseReceived" && row.params.response.url === item.apiURL) };
  }, "original POST held before response headers");
  try {
    await run(await prepare("status-503", "503"), async ({ item, arm, result, submit, requestExpected, responseExpected }) => {
      const request = await arm("request", "request", { url: item.apiURL, method: "POST" }), response = await arm("response", "response", { url: item.apiURL, status: 503 });
      await submit("Original unsuccessful HTTP π", 503); await result("request", request, requestExpected); await result("response", response, responseExpected(503));
    });
    await run(await prepare("same-url-double", "double"), async ({ item, arm, result, submit, requestExpected, responseExpected }) => {
      const request = await arm("request", "request", { url: item.apiURL }), response = await arm("response", "response", { url: item.apiURL });
      await submit("First explicit Save π"); const secondRequest = await arm("secondRequest", "request", { url: item.apiURL }), secondResponse = await arm("secondResponse", "response", { url: item.apiURL });
      await submit("Second explicit Save π"); await result("request", request, requestExpected); await result("response", response, responseExpected(201));
      await result("secondRequest", secondRequest, requestExpected); await result("secondResponse", secondResponse, responseExpected(201)); await result("responseAgain", response, responseExpected(201));
    });
    await run(await prepare("allowed-redirect", "redirect"), async ({ item, arm, result, submit, requestExpected }) => {
      const destination = new URL(item.apiURL); destination.hostname = "localhost"; destination.pathname = basePath + "receipt";
      const request = await arm("request", "request", { url: item.apiURL }), response = await arm("response", "response", { url: destination.href, status: 200 });
      await submit("Original allowed redirect π", 200, destination.href); await result("request", request, requestExpected); await result("response", response, { event: "response", url: destination.href, method: "GET", status: 200, redirected: "request" });
    });
    await run(await prepare("request-before-response-arm", "headers-gate"), async ({ item, arm, result, submit, receipt, responseExpected }) => {
      const submission = await submit("Original request precedes response arm π", 201, item.apiURL, false); item.heldBeforeArm = await held(item);
      const response = await arm("response", "response", { url: item.apiURL, status: 201 }); fixtures.release(item.key); await result("response", response, responseExpected(201)); await receipt(submission);
    });
    await run(await prepare("allowed-document-navigation"), async ({ item, tab, arm, result }) => {
      const destination = new URL(item.url); destination.searchParams.set("navigation", "destination"); item.destinationURL = destination.href;
      const request = await arm("request", "request", { url: item.destinationURL, method: "GET" }), response = await arm("response", "response", { url: item.destinationURL, method: "GET", status: 200 });
      await tab.goto(item.destinationURL); await result("request", request, { event: "request" }); await result("response", response, { event: "response" });
    });
    await run(await prepare("navigation-no-response", "headers-gate"), async ({ item, tab, arm, reject, submit }) => {
      const response = await arm("response", "response", { url: item.apiURL }, 3000); await submit("Original held POST before navigation π", 201, item.apiURL, false); item.heldBeforeNavigation = await held(item);
      await tab.goto(item.url); item.navigated = true; fixtures.release(item.key); await reject("original-response-timeout-after-navigation", () => response.result(), "no-response");
    });
    await run(await prepare("retained-response-navigation"), async ({ item, tab, arm, result, reject, submit, responseExpected }) => {
      const response = await arm("response", "response", { url: item.apiURL }); await submit("Original retained response π"); await result("response", response, responseExpected(201));
      // Preserve the original receipt before navigation replaces the business nodes.
      item.beforeNavigation = await snapshot(getWorker(), tab.id); await tab.goto(item.url); item.navigated = true; await reject("retained-old-document", () => response.result());
    });
    await run(await prepare("cancel-pending"), async ({ item, arm, reject }) => { const response = await arm("response", "response", { url: item.apiURL }); await response.cancel(); item.explicitCancel = true; await reject("cancelled", () => response.result()); });
    const mixed = await prepare("mixed-denied-child", "normal", "oopif"), dynamic = await prepare("future-denied-child", "normal", "dynamic-oopif"), policy = await prepare("policy-revocation");
    await run(policy, async ({ item, arm, reject }) => {
      const response = await arm("response", "response", { url: item.apiURL }); detail.previousEpoch = browser.client.controlEpoch;
      detail.rootOnly = await controls.apply("allow", [new URL(fixtureURL).origin]); item.policyRetired = true; await reject("policy-paused", () => response.result());
      detail.rootOnly.resume = await controls.resume(); await browser.client.beginTurn(); detail.newEpoch = browser.client.controlEpoch;
      assert.ok(Number.isSafeInteger(detail.previousEpoch)); assert.ok(Number.isSafeInteger(detail.newEpoch)); assert.notEqual(detail.previousEpoch, detail.newEpoch);
    });
    await run(mixed, async ({ item, tab, reject }) => { await reject("mixed-arm", () => tab.expectResponse({ url: item.apiURL }, { timeoutMs: 5000 }), "denied"); });
    await run(dynamic, async ({ item, tab, arm, reject }) => {
      const response = await arm("response", "response", { url: basePath + "api", urlMatch: "contains" }); item.addedChild = true;
      try { await tab.locator("#add-network-frame").click(); } catch (error) { item.addError = String(error.message ?? error); assert.match(item.addError, retired); }
      await until(async () => (await getWorker().evaluate(`chrome.webNavigation.getAllFrames({tabId:${tab.id}})`)).some(frame => frame.parentFrameId === 0 && frame.url.startsWith("http://localhost:")), "original denied child committed");
      await reject("future-child", () => response.result());
    });
    for (const mode of ["third-party", "redirect-denied"]) await run(await prepare(mode, mode), async ({ item, arm, reject, submit }) => {
      const destination = new URL(item.apiURL); destination.pathname = basePath + "receipt"; if (mode === "redirect-denied") destination.hostname = "127.0.0.1";
      const match = mode === "third-party" ? { url: `${basePath}api?key=${item.key}`, urlMatch: "contains" } : { url: destination.href, status: 200 };
      const response = await arm("response", "response", match); await submit(`Original ${mode} page fetch π`, mode === "third-party" ? 201 : 200, mode === "third-party" ? item.apiURL : destination.href);
      await reject(mode, () => response.result(), "denied");
    });
  } catch (error) { failure = error; }
  finally {
    try { detail.serverLedger = fixtures.allStats(); } catch (error) { detail.serverLedgerError = text(error); failure ??= error; }
    try { detail.childTargetIds = await getWorker().evaluate(`globalThis.__integrationFrames.filter(row=>${json(detail.tabIds)}.includes(row.tabId)).map(row=>row.targetId)`); } catch (error) { detail.childTargetReadError = text(error); failure ??= error; }
    for (const id of detail.tabIds) try { await getWorker().evaluate(`chrome.tabs.remove(${id})`); } catch (error) { (detail.tabCleanupErrors ??= []).push({ tabId: id, error: text(error) }); failure ??= error; }
    try { assert.ok(Array.isArray(detail.childTargetIds)); detail.cleanup = await getWorker().evaluate(`(async()=>({tabs:(await chrome.tabs.query({})).filter(row=>${json(detail.tabIds)}.includes(row.id)),targets:(await chrome.debugger.getTargets()).filter(row=>${json(detail.tabIds)}.includes(row.tabId)||${json(detail.childTargetIds)}.includes(row.id)),probePresent:!!globalThis.__restrictedNetworkEvidence}))()`); assert.deepEqual(detail.cleanup, { tabs: [], targets: [], probePresent: false }); } catch (error) { detail.cleanupError = text(error); failure ??= error; }
    try { detail.finalizeScope = scopeOf(browser); assert.ok(Number.isSafeInteger(detail.finalizeScope.control_epoch) && detail.finalizeScope.control_epoch > 0, "Cleanup must use an already admitted scope"); detail.finalize = await browser.client.finalizeTabs([]); } catch (error) { detail.finalizeError = text(error); failure ??= error; }
    try { browser.close(); } catch (error) { detail.connectionCleanupError = text(error); failure ??= error; }
    if (failure) detail.error = text(failure); try { await saveDetail(detail); } catch (error) { failure ??= error; }
  }
  if (failure) throw failure; return detail;
}
