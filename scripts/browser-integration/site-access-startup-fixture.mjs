import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";

const policyKey = "OPEN_BROWSER_USE_SITE_ACCESS_POLICY";
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const errorText = error => error?.stack ?? String(error);

// Staged private-profile bootstrap only. The original native get actually
// fulfills; exactly one derived delivery rejects. This is NOT a natural native
// storage failure. All unselected calls retain receiver, arguments and Promise.
export async function installSiteAccessStartupProbe(chrome, target, { markerKey, nonce }) {
  if (!/^__OBU_TEST_SITE_STARTUP_[a-f0-9]{16}$/.test(markerKey) || !/^[a-f0-9]{32}$/.test(nonce)) throw Error("Invalid startup probe identity");
  const marker = (await chrome.storage.session.get(markerKey))[markerKey];
  if (marker === undefined) return { armed: false };
  if (!marker || Object.keys(marker).length !== 3 || marker.version !== 1 || marker.nonce !== nonce || marker.armed !== true) throw Error("Unexpected startup probe marker");
  await chrome.storage.session.remove(markerKey);
  const key = "OPEN_BROWSER_USE_SITE_ACCESS_POLICY", apiKey = "__siteAccessStartupProbe", storage = chrome.storage.local;
  const originals = { get: storage.get, set: storage.set }, descriptors = Object.fromEntries(["get", "set"].map(name => [name, Object.getOwnPropertyDescriptor(storage, name)]));
  if (Object.hasOwn(target, apiKey) || Object.values(originals).some(value => typeof value !== "function") || Object.values(descriptors).some(value => value && (!Object.hasOwn(value, "value") || !value.writable))) throw Error("Unobservable startup storage methods");
  const rows = [], errors = []; let pending = 0, reads = 0, writes = 0, overflow = false, stopped = false, final;
  const record = row => {
    try { const copy = structuredClone(row); if (rows.length >= 64 || JSON.stringify(copy).length > 65536) { overflow = true; return; } rows.push({ sequence: rows.length + 1, at: Date.now(), ...copy }); }
    catch { if (errors.length < 8) errors.push("Startup probe record failed"); }
  };
  const observe = (promise, operation, attempt) => {
    pending++;
    try { Promise.prototype.then.call(promise, value => { pending--; record({ kind: "native-fulfilled", operation, attempt, ...(operation === "get" ? { value } : {}) }); }, error => { pending--; record({ kind: "native-rejected", operation, attempt, error: String(error?.message ?? error) }); }); }
    catch (error) { pending--; errors.push("Native storage did not return its original Promise"); throw error; }
  };
  const wrappers = {
    get: function (...args) {
      if (stopped || args.length !== 1 || args[0] !== key) return Reflect.apply(originals.get, this, args);
      const attempt = ++reads, controlled = attempt === 1; record({ kind: "call", operation: "get", attempt, args, controlled });
      let native;
      try { native = Reflect.apply(originals.get, this, args); } catch (error) { record({ kind: "native-threw", operation: "get", attempt, error: String(error) }); throw error; }
      observe(native, "get", attempt);
      if (!controlled) return native;
      return Promise.prototype.then.call(native, () => { record({ kind: "controlled-delivery-rejected", operation: "get", attempt }); throw Error("OBU_TEST_STARTUP_READ_DELIVERY: original native read fulfilled; controlled delivery failure"); });
    },
    set: function (...args) {
      if (stopped || args.length !== 1 || !args[0] || !Object.hasOwn(args[0], key)) return Reflect.apply(originals.set, this, args);
      const attempt = ++writes; record({ kind: "call", operation: "set", attempt, args });
      const native = Reflect.apply(originals.set, this, args); observe(native, "set", attempt); return native;
    }
  };
  const snapshot = () => structuredClone(final ?? { nonce, markerKey, extensionId: chrome.runtime.id, consumedMarker: marker,
    reads, writes, pending, overflow, errors, rows, stopped,
    boundary: "Original native get fulfillment retained; first matching startup delivery deliberately rejects through a derived Promise. Not a natural native get rejection." });
  const api = { snapshot, stop() {
    if (stopped) return snapshot();
    for (const name of ["get", "set"]) { if (storage[name] !== wrappers[name]) throw Error("Startup probe method replaced"); }
    if (target[apiKey] !== api) throw Error("Startup probe API replaced");
    for (const name of ["get", "set"]) { if (descriptors[name]) Object.defineProperty(storage, name, descriptors[name]); else delete storage[name]; }
    if (pending) errors.push("Stopped with unsettled original storage calls");
    stopped = true; delete target[apiKey]; final = { ...snapshot(), restored: storage.get === originals.get && storage.set === originals.set, apiRemoved: !Object.hasOwn(target, apiKey) }; return snapshot();
  } };
  try {
    for (const name of ["get", "set"]) Object.defineProperty(storage, name, descriptors[name] ? { ...descriptors[name], value: wrappers[name] } : { value: wrappers[name], writable: true, configurable: true });
    Object.defineProperty(target, apiKey, { value: api, configurable: true });
  } catch (error) { for (const name of ["get", "set"]) { if (descriptors[name]) Object.defineProperty(storage, name, descriptors[name]); else delete storage[name]; } throw error; }
  return { armed: true, nonce, markerConsumed: true };
}

export function siteAccessStartupPrefix(options) {
  return `\nawait (${installSiteAccessStartupProbe.toString()})(chrome,globalThis,${JSON.stringify(options)});\n`;
}

export function createSiteAccessStartupFixtures() {
  const records = new Map();
  return { stats: key => structuredClone(records.get(key)), allStats: () => structuredClone([...records.values()]), handle(request, response, url) {
    if (!["/site-access-startup/page", "/site-access-startup/post"].includes(url.pathname)) return false;
    const key = url.searchParams.get("key"); if (!/^startup-[a-f0-9]{32}$/.test(key ?? "")) { response.writeHead(400); response.end(); return true; }
    if (url.pathname.endsWith("/page")) {
      if (request.method !== "GET" || records.has(key) || records.size >= 8) { response.writeHead(400); response.end(); return true; }
      const documentToken = randomUUID(), nodeToken = `${key}-input`;
      const bytes = Buffer.from(`<!doctype html><meta charset="utf-8"><title>Original recovery form</title><style>body{font:18px Arial;margin:32px}input,button{display:block;margin:16px 0;padding:14px}</style>
      <form><label for="original-note">Recovery note</label><input id="original-note" data-token="${nodeToken}"><button>Submit original recovery note</button></form><output id="receipt">Waiting</output>
      <script>(()=>{const input=document.querySelector('input'),form=document.querySelector('form'),events=[];let overflow=false,submits=0,receipt=null;const errors=[];
      window.siteAccessStartupSnapshot=()=>({key:${JSON.stringify(key)},documentToken:${JSON.stringify(documentToken)},nodeToken:input.dataset.token,href:location.href,original:input.isConnected&&input===document.querySelector('input')&&form===document.querySelector('form'),value:input.value,events:structuredClone(events),overflow,submits,receipt,errors:[...errors]});
      for(const type of ['input','click','submit'])document.addEventListener(type,event=>{if(events.length>=64){overflow=true;return}events.push({sequence:events.length+1,type,trusted:event.isTrusted,originalInput:event.target===input,originalForm:event.target===form,target:event.target.tagName,value:input.value})},{capture:true,passive:true});
      form.addEventListener('submit',event=>{event.preventDefault();submits++;fetch('/site-access-startup/post?key=${key}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({trustedSubmit:event.isTrusted,snapshot:window.siteAccessStartupSnapshot()})}).then(response=>{if(!response.ok)throw Error('Receipt HTTP '+response.status);return response.json()}).then(value=>{receipt=value;document.querySelector('#receipt').textContent='Saved '+value.bodySHA256}).catch(error=>errors.push(String(error)))});})();</script>`);
      records.set(key, { key, documentToken, nodeToken, get: { href: url.href, byteLength: bytes.length, sha256: hash(bytes) }, posts: [] });
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }); response.end(bytes); return true;
    }
    const record = records.get(key); if (request.method !== "POST" || !record || record.posts.length >= 8) { response.writeHead(400); response.end(); return true; }
    const post = { method: request.method, index: record.posts.length + 1 }, chunks = []; record.posts.push(post); let size = 0;
    request.on("data", chunk => { size += chunk.length; if (size <= 65536) chunks.push(chunk); });
    request.once("aborted", () => { post.error = "HTTP request aborted"; }); request.once("error", () => { post.error = "HTTP request failed"; });
    request.once("end", () => { const bytes = Buffer.concat(chunks); Object.assign(post, { bodyBytes: size, bodyBase64: bytes.toString("base64"), bodySHA256: hash(bytes) });
      try {
        assert.ok(size <= 65536); post.value = JSON.parse(bytes.toString("utf8")); const state = post.value.snapshot;
        assert.equal(post.index, 1); assert.equal(post.value.trustedSubmit, true); assert.equal(state.key, key); assert.equal(state.documentToken, record.documentToken);
        assert.equal(state.href, record.get.href); assert.equal(state.nodeToken, record.nodeToken); assert.equal(state.original, true); assert.equal(state.submits, 1);
        post.receipt = { key, index: post.index, bodySHA256: post.bodySHA256 }; response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify(post.receipt));
      } catch { post.error = "Invalid original recovery receipt"; response.writeHead(400); response.end(post.error); }
    }); return true;
  } };
}

export function checkSiteAccessStartupNative(snapshot, expectedPolicy, { recovered = false, stopped = false } = {}) {
  assert.equal(snapshot.reads, recovered ? 2 : 1); assert.equal(snapshot.writes, 0); assert.equal(snapshot.pending, 0); assert.equal(snapshot.overflow, false); assert.deepEqual(snapshot.errors, []);
  assert.deepEqual(snapshot.rows.map(row => row.kind), ["call", "native-fulfilled", "controlled-delivery-rejected", ...(recovered ? ["call", "native-fulfilled"] : [])]);
  for (const [index, row] of snapshot.rows.entries()) { assert.equal(row.sequence, index + 1); assert.equal(row.operation, "get"); assert.equal(row.attempt, index < 3 ? 1 : 2); }
  for (const row of snapshot.rows.filter(row => row.kind === "native-fulfilled")) assert.deepEqual(row.value, { [policyKey]: expectedPolicy });
  assert.equal(snapshot.rows[0].controlled, true); assert.deepEqual(snapshot.rows[0].args, [policyKey]);
  if (recovered) { assert.equal(snapshot.rows[3].controlled, false); assert.deepEqual(snapshot.rows[3].args, [policyKey]); }
  assert.equal(snapshot.stopped, stopped); if (stopped) { assert.equal(snapshot.restored, true); assert.equal(snapshot.apiRemoved, true); }
}

export function checkSiteAccessStartupSubmission(record, document, expectedValue) {
  assert.equal(record.posts.length, 1); const post = record.posts[0], bytes = Buffer.from(post.bodyBase64, "base64"), state = post.value.snapshot;
  assert.equal(post.error, undefined); assert.equal(post.bodyBytes, bytes.length); assert.equal(post.bodySHA256, hash(bytes)); assert.deepEqual(JSON.parse(bytes.toString("utf8")), post.value);
  assert.equal(state.documentToken, record.documentToken); assert.equal(state.nodeToken, record.nodeToken); assert.equal(state.href, record.get.href); assert.equal(state.original, true);
  assert.equal(state.value, expectedValue); assert.equal(state.submits, 1); assert.equal(state.overflow, false); assert.deepEqual(state.errors, []); assert.equal(post.value.trustedSubmit, true);
  const inputs = state.events.filter(row => row.type === "input"), submits = state.events.filter(row => row.type === "submit"), clicks = state.events.filter(row => row.type === "click" && row.target === "BUTTON");
  assert.equal(inputs.length, 1); assert.equal(submits.length, 1); assert.equal(clicks.length, 1);
  assert.equal(inputs[0].trusted && inputs[0].originalInput && submits[0].trusted && submits[0].originalForm && clicks[0].trusted, true);
  assert.equal(inputs[0].value, expectedValue); assert.ok(inputs[0].sequence < clicks[0].sequence && clicks[0].sequence < submits[0].sequence);
  assert.deepEqual(document.events, state.events); assert.deepEqual(document.receipt, post.receipt); assert.equal(document.documentToken, state.documentToken); assert.equal(document.original, true);
}

export async function checkSiteAccessStartupRecovery({ connectBrowser, getWorker, connectPage, popupURL, windowId, fixtureURL,
  restartWorker, capture, saveDetail, until, traceFocus, fixtures, markerKey, nonce, existingPopup }) {
  const detail = { boundary: "Controlled startup delivery failure after successful original native get; explicit read-only recovery, not corruption replacement.",
    popupOwnership: existingPopup ? "borrowed" : "owned" };
  const browser = await connectBrowser("site-access-startup"), key = `startup-${randomBytes(16).toString("hex")}`, url = new URL("/site-access-startup/page", fixtureURL); url.searchParams.set("key", key);
  let popup = existingPopup, allowed, failure, expected, probeInstalled = false;
  const readPolicy = async () => { const response = await popup.evaluate("chrome.runtime.sendMessage({type:'GET_SITE_ACCESS_POLICY'})"); assert.equal(response.ok, true); return response.policy; };
  const view = () => popup.evaluate(`({label:document.querySelector('#site-access-status').textContent,mode:document.querySelector('#site-access-mode').value,error:document.querySelector('#site-access-error').textContent,automation:document.querySelector('#automation-status-label').textContent,recoverDisabled:document.querySelector('#site-access-recover')?.disabled??true})`);
  const resume = async () => { await until(async () => (await view()).automation === "Paused", "actual paused startup popup"); await popup.evaluate("document.querySelector('#automation-toggle').click()"); await until(async () => (await view()).automation === "Running", "explicit startup recovery Resume"); };
  const apply = async (mode, origins) => {
    const before = await readPolicy(); await popup.evaluate("document.querySelector('#site-access-reload').click()");
    await until(async () => ["Saved", "Default"].includes((await view()).label), "review original saved settings");
    await popup.evaluate(`(()=>{const mode=document.querySelector('#site-access-mode'),text=document.querySelector('#site-access-origins');mode.value=${JSON.stringify(mode)};mode.dispatchEvent(new Event('change',{bubbles:true}));text.value=${JSON.stringify(origins.join("\n"))};text.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#site-access-apply').click()})()`);
    await until(async () => { const value = await readPolicy(); return value.ready && value.revision === before.revision + 1; }, "actual policy save before restart", 15000); return readPolicy();
  };
  const documentState = async () => getWorker().evaluate(`chrome.scripting.executeScript({target:{tabId:${allowed.id},documentIds:[${JSON.stringify(detail.documentId)}]},world:'MAIN',func:()=>window.siteAccessStartupSnapshot()}).then(rows=>{if(rows.length!==1||rows[0].documentId!==${JSON.stringify(detail.documentId)})throw Error('Original recovery document replaced');return rows[0].result})`);
  try {
    allowed = await browser.newTab({ url: url.href }); detail.tabId = allowed.id; detail.oldEpoch = browser.client.controlEpoch;
    const frame = await getWorker().evaluate(`chrome.webNavigation.getAllFrames({tabId:${allowed.id}}).then(rows=>rows.filter(row=>row.frameId===0))`);
    assert.equal(frame.length, 1); assert.equal(frame[0].url, url.href); assert.equal(typeof frame[0].documentId, "string"); detail.documentId = frame[0].documentId; detail.before = await documentState();
    if (!existingPopup) {
      await traceFocus("action-popup:before-open"); await getWorker().evaluate(`chrome.action.openPopup({windowId:${windowId}})`); await traceFocus("action-popup:after-open");
      popup = await connectPage(popupURL);
    }
    await until(async () => ["Saved", "Default"].includes((await view()).label), "initial startup settings");
    detail.originalPolicy = await readPolicy(); detail.restrictive = await apply("allow", [new URL(fixtureURL).origin]);
    expected = { version: 1, revision: detail.restrictive.revision, mode: "allow", origins: [new URL(fixtureURL).origin] };
    detail.durableBefore = await getWorker().evaluate(`chrome.storage.local.get([${JSON.stringify(policyKey)}])`); assert.deepEqual(detail.durableBefore, { [policyKey]: expected });
    assert.deepEqual(await getWorker().evaluate(`chrome.storage.session.get(${JSON.stringify(markerKey)})`), {});
    await getWorker().evaluate(`chrome.storage.session.set({[${JSON.stringify(markerKey)}]:{version:1,nonce:${JSON.stringify(nonce)},armed:true}})`); probeInstalled = true;
    detail.restart = await restartWorker(popup);
    detail.failed = await until(async () => { const status = await readPolicy(); return status.recovery?.state === "read-error" && status.recovery.id ? status : false; }, "initial policy delivery failure");
    assert.equal(detail.failed.ready, false); assert.equal(detail.failed.retryable, undefined); assert.equal(detail.failed.stored, undefined);
    detail.nativeFailure = await getWorker().evaluate("__siteAccessStartupProbe.snapshot()"); checkSiteAccessStartupNative(detail.nativeFailure, expected);
    assert.equal(detail.nativeFailure.nonce, nonce); assert.equal(detail.nativeFailure.markerKey, markerKey); assert.equal(detail.nativeFailure.extensionId, new URL(popupURL).hostname);
    assert.deepEqual(detail.nativeFailure.consumedMarker, { version: 1, nonce, armed: true });
    for (let i = 0; i < 2; i++) assert.deepEqual(await readPolicy(), detail.failed);
    detail.nativeAfterGET = await getWorker().evaluate("__siteAccessStartupProbe.snapshot()"); assert.deepEqual(detail.nativeAfterGET, detail.nativeFailure);
    detail.markerAfterRestart = await getWorker().evaluate(`chrome.storage.session.get(${JSON.stringify(markerKey)})`); assert.deepEqual(detail.markerAfterRestart, {});
    detail.failedControl = await popup.evaluate("chrome.runtime.sendMessage({type:'GET_AUTOMATION_CONTROL_STATUS'})");
    assert.equal(detail.failedControl.status.state, "paused"); assert.equal(detail.failedControl.status.inputBlocked, true); assert.equal(detail.failedControl.status.cleanupComplete, true);
    await assert.rejects(allowed.getByLabel("Recovery note").fill("must stay blocked"), /OBU_AUTOMATION_PAUSED|OBU_SITE_ACCESS_UNAVAILABLE|OBU_CONTROL_BOOTSTRAP_REQUIRED/);
    detail.blockedDocument = await documentState(); assert.equal(detail.blockedDocument.value, ""); assert.deepEqual(detail.blockedDocument.events, []); assert.equal(fixtures.stats(key).posts.length, 0);
    await until(async () => { const state = await view(); return state.label === "Unavailable" && state.mode === "" && !state.recoverDisabled; }, "explicit recovery available without default policy");
    detail.failedView = await view(); await capture("site-access-startup-unavailable", popup);
    await popup.evaluate("document.querySelector('#site-access-recover').click()");
    detail.recovered = await until(async () => { const status = await readPolicy(); return status.ready ? status : false; }, "explicit read-only policy recovery", 15000);
    assert.deepEqual(detail.recovered, { ...expected, ready: true, stored: true });
    detail.staleRecovery = await popup.evaluate(`chrome.runtime.sendMessage({type:'RECOVER_SITE_ACCESS_POLICY',expectedRecoveryId:${JSON.stringify(detail.failed.recovery.id)}})`); assert.equal(detail.staleRecovery.ok, false);
    assert.match(detail.staleRecovery.error, /OBU_SITE_ACCESS_RECOVERY_(?:UNAVAILABLE|CONFLICT)/);
    detail.nativeRecovered = await getWorker().evaluate("__siteAccessStartupProbe.snapshot()"); checkSiteAccessStartupNative(detail.nativeRecovered, expected, { recovered: true });
    detail.durableAfter = await getWorker().evaluate(`chrome.storage.local.get([${JSON.stringify(policyKey)}])`); assert.deepEqual(detail.durableAfter, detail.durableBefore);
    detail.pausedAfter = await popup.evaluate("chrome.runtime.sendMessage({type:'GET_AUTOMATION_CONTROL_STATUS'})");
    assert.equal(detail.pausedAfter.status.state, "paused"); assert.equal(detail.pausedAfter.status.inputBlocked, true); assert.equal(detail.pausedAfter.status.cleanupComplete, true);
    await assert.rejects(allowed.getByLabel("Recovery note").fill("must still stay blocked"), /OBU_AUTOMATION_PAUSED/);
    assert.equal(fixtures.stats(key).posts.length, 0); await capture("site-access-startup-recovered-paused", popup);
    await resume(); await assert.rejects(allowed.domSnapshot(), /OBU_STALE_CONTROL_EPOCH|OBU_CONTROL_BOOTSTRAP_REQUIRED/); assert.equal(browser.client.controlEpoch, detail.oldEpoch);
    await browser.client.beginTurn(); detail.newEpoch = browser.client.controlEpoch; assert.notEqual(detail.newEpoch, detail.oldEpoch);
    const text = `Explicit startup recovery ${key} 中文`; await allowed.getByLabel("Recovery note").fill(text); await allowed.getByRole("button", { name: "Submit original recovery note", exact: true }).click();
    await allowed.getByText("Saved ", { exact: false }).waitFor({ timeoutMs: 5000 }); detail.after = await documentState(); detail.submission = fixtures.stats(key);
    checkSiteAccessStartupSubmission(detail.submission, detail.after, text); assert.equal(detail.after.documentToken, detail.before.documentToken); assert.equal(detail.after.nodeToken, detail.before.nodeToken);
  } catch (error) { failure = error; }
  finally {
    try { detail.serverLedger = fixtures.allStats(); } catch (error) { detail.serverLedgerError = errorText(error); failure ??= error; }
    try {
      if (probeInstalled) {
        detail.nativeFinal = await getWorker().evaluate("globalThis.__siteAccessStartupProbe?.stop()??null");
        await getWorker().evaluate(`chrome.storage.session.remove(${JSON.stringify(markerKey)})`);
        detail.markerCleanup = await getWorker().evaluate(`chrome.storage.session.get(${JSON.stringify(markerKey)})`); assert.deepEqual(detail.markerCleanup, {});
        if (!failure) checkSiteAccessStartupNative(detail.nativeFinal, expected, { recovered: true, stopped: true });
      }
    }
    catch (error) { detail.probeCleanupError = errorText(error); failure ??= error; }
    try {
      if (popup) {
        // Explicit private-fixture restoration, recorded separately from the
        // verified read-only operation; never retries a browser action.
        let status = await readPolicy();
        if (!status.ready && status.recovery?.id) { detail.cleanupRecovery = await popup.evaluate(`chrome.runtime.sendMessage({type:'RECOVER_SITE_ACCESS_POLICY',expectedRecoveryId:${JSON.stringify(status.recovery.id)}})`); status = await readPolicy(); }
        if (status.ready && detail.originalPolicy?.ready) { detail.restored = await apply(detail.originalPolicy.mode, detail.originalPolicy.origins); await resume(); }
      }
    } catch (error) { detail.restoreError = errorText(error); failure ??= error; }
    if (allowed) try { await getWorker().evaluate(`chrome.tabs.remove(${allowed.id})`); } catch (error) { detail.tabCleanupError = errorText(error); failure ??= error; }
    if (popup && !existingPopup) try { await traceFocus("startup-popup:before-close"); try { await popup.evaluate("window.close()"); } catch {} popup.close(); await traceFocus("startup-popup:after-close"); }
    catch (error) { detail.popupCleanupError = errorText(error); failure ??= error; }
    try { browser.close(); } catch (error) { detail.connectionCleanupError = errorText(error); failure ??= error; } if (failure) detail.error = errorText(failure);
    try { await saveDetail(detail); } catch (error) { failure ??= error; }
  }
  if (failure) throw failure; return detail;
}
