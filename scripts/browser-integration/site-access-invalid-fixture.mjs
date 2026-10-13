import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { checkSiteAccessStartupSubmission } from "./site-access-startup-fixture.mjs";

const policyKey = "OPEN_BROWSER_USE_SITE_ACCESS_POLICY";
const errorText = error => error?.stack ?? String(error);
const generation = value => assert.match(value, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

// Private-profile observation only: no fault, argument changes or derived
// delivery. Every selected call returns its exact original native Promise.
export async function installSiteAccessInvalidProbe(chrome, target, { markerKey, nonce }) {
  if (!/^__OBU_TEST_SITE_INVALID_[a-f0-9]{16}$/.test(markerKey) || !/^[a-f0-9]{32}$/.test(nonce)) throw Error("Invalid corrupt-policy probe identity");
  const marker = (await chrome.storage.session.get(markerKey))[markerKey]; if (marker === undefined) return { armed: false };
  if (!marker || Object.keys(marker).length !== 3 || marker.version !== 1 || marker.nonce !== nonce || marker.armed !== true) throw Error("Unexpected corrupt-policy probe marker");
  await chrome.storage.session.remove(markerKey);
  const key = "OPEN_BROWSER_USE_SITE_ACCESS_POLICY", apiKey = "__siteAccessInvalidProbe", storage = chrome.storage.local;
  const originals = { get: storage.get, set: storage.set }, descriptors = Object.fromEntries(["get", "set"].map(name => [name, Object.getOwnPropertyDescriptor(storage, name)]));
  if (Object.hasOwn(target, apiKey) || Object.values(originals).some(value => typeof value !== "function") || Object.values(descriptors).some(value => value && (!Object.hasOwn(value, "value") || !value.writable))) throw Error("Unobservable corrupt-policy storage methods");
  const rows = [], errors = []; let reads = 0, writes = 0, pending = 0, stopped = false, overflow = false, final;
  const record = row => { try { const copy = structuredClone(row); if (rows.length >= 64 || JSON.stringify(copy).length > 65536) overflow = true; else rows.push({ sequence: rows.length + 1, at: Date.now(), ...copy }); } catch { if (errors.length < 8) errors.push("Unrecordable native storage observation"); } };
  const wrappers = Object.fromEntries(["get", "set"].map(operation => [operation, function (...args) {
    if (stopped || args.length !== 1 || (operation === "get" ? args[0] !== key : !args[0] || !Object.hasOwn(args[0], key))) return Reflect.apply(originals[operation], this, args);
    const attempt = operation === "get" ? ++reads : ++writes; record({ kind: "call", operation, attempt, args });
    let native; try { native = Reflect.apply(originals[operation], this, args); } catch (error) { record({ kind: "native-threw", operation, attempt, error: String(error) }); throw error; }
    pending++;
    try { Promise.prototype.then.call(native, value => { pending--; record({ kind: "native-fulfilled", operation, attempt, ...(operation === "get" ? { value } : {}) }); }, error => { pending--; record({ kind: "native-rejected", operation, attempt, error: String(error?.message ?? error) }); }); }
    catch (error) { pending--; errors.push("Storage did not return its original Promise"); throw error; }
    return native;
  }]));
  const snapshot = () => structuredClone(final ?? { nonce, markerKey, extensionId: chrome.runtime.id, consumedMarker: marker, reads, writes, pending, stopped, overflow, errors, rows });
  const api = { snapshot, stop() {
    if (stopped) return snapshot(); if (pending) throw Error("Original corrupt-policy storage operation still pending");
    if (target[apiKey] !== api || ["get", "set"].some(name => storage[name] !== wrappers[name])) throw Error("Corrupt-policy observer identity changed");
    for (const name of ["get", "set"]) { if (descriptors[name]) Object.defineProperty(storage, name, descriptors[name]); else delete storage[name]; }
    stopped = true; delete target[apiKey]; final = { ...snapshot(), restored: storage.get === originals.get && storage.set === originals.set, apiRemoved: !Object.hasOwn(target, apiKey) }; return snapshot();
  } };
  try {
    for (const name of ["get", "set"]) Object.defineProperty(storage, name, descriptors[name] ? { ...descriptors[name], value: wrappers[name] } : { value: wrappers[name], writable: true, configurable: true });
    Object.defineProperty(target, apiKey, { value: api, configurable: true });
  } catch (error) { for (const name of ["get", "set"]) { if (descriptors[name]) Object.defineProperty(storage, name, descriptors[name]); else delete storage[name]; } throw error; }
  return { armed: true, nonce, markerConsumed: true };
}

export function siteAccessInvalidPrefix(options) { return `\nawait (${installSiteAccessInvalidProbe.toString()})(chrome,globalThis,${JSON.stringify(options)});\n`; }

export function checkSiteAccessInvalidNative(snapshot, malformed, replacement, { stopped = false } = {}) {
  assert.equal(snapshot.reads, 1); assert.equal(snapshot.writes, replacement ? 1 : 0); assert.equal(snapshot.pending, 0); assert.equal(snapshot.overflow, false); assert.deepEqual(snapshot.errors, []);
  assert.deepEqual(snapshot.rows.map(row => [row.kind, row.operation, row.attempt]), [["call", "get", 1], ["native-fulfilled", "get", 1], ...(replacement ? [["call", "set", 1], ["native-fulfilled", "set", 1]] : [])]);
  for (const [index, row] of snapshot.rows.entries()) assert.equal(row.sequence, index + 1);
  assert.deepEqual(snapshot.rows[0].args, [policyKey]); assert.deepEqual(snapshot.rows[1].value, { [policyKey]: malformed });
  if (replacement) assert.deepEqual(snapshot.rows[2].args, [{ [policyKey]: replacement }]);
  assert.equal(snapshot.stopped, stopped); if (stopped) { assert.equal(snapshot.restored, true); assert.equal(snapshot.apiRemoved, true); }
}

export async function checkSiteAccessInvalidReplacement({ connectBrowser, getWorker, connectPage, popupURL, windowId, fixtureURL,
  restartWorker, capture, saveDetail, until, traceFocus, fixtures, markerKey, nonce, existingPopup }) {
  const detail = { popupOwnership: existingPopup ? "borrowed" : "owned", boundary: "Actual malformed policy setup and actual worker restart; native successful read/unique replacement write observed without fault injection. Explicit popup replacement stays paused; no corruption fallback or browser action replay." };
  const browser = await connectBrowser("site-access-invalid"), key = `startup-${randomBytes(16).toString("hex")}`, url = new URL("/site-access-startup/page", fixtureURL); url.searchParams.set("key", key);
  let popup = existingPopup, tab, failure, armed = false, safeToRestore = true;
  const readPolicy = async () => { const result = await popup.evaluate("chrome.runtime.sendMessage({type:'GET_SITE_ACCESS_POLICY'})"); assert.equal(result.ok, true); generation(result.policy.generation); return result.policy; };
  const view = () => popup.evaluate(`({label:document.querySelector('#site-access-status').textContent,mode:document.querySelector('#site-access-mode').value,origins:document.querySelector('#site-access-origins').value,automation:document.querySelector('#automation-status-label').textContent,error:document.querySelector('#site-access-error').textContent,reviewDisabled:document.querySelector('#site-access-replace-review')?.disabled??true,replaceDisabled:document.querySelector('#site-access-replace')?.disabled??true,effect:document.querySelector('#site-access-replace-effect')?.textContent??''})`);
  const paused = async () => { const result = await popup.evaluate("chrome.runtime.sendMessage({type:'GET_AUTOMATION_CONTROL_STATUS'})"); assert.equal(result.ok, true); assert.equal(result.status.state, "paused"); assert.equal(result.status.inputBlocked, true); assert.equal(result.status.cleanupComplete, true); return result; };
  const resume = async () => { await until(async () => (await view()).automation === "Paused", "invalid replacement paused UI"); await popup.evaluate("document.querySelector('#automation-toggle').click()"); await until(async () => (await view()).automation === "Running", "explicit invalid replacement Resume"); };
  const state = () => getWorker().evaluate(`chrome.scripting.executeScript({target:{tabId:${tab.id},documentIds:[${JSON.stringify(detail.documentId)}]},world:'MAIN',func:()=>window.siteAccessStartupSnapshot()}).then(rows=>{if(rows.length!==1||rows[0].documentId!==${JSON.stringify(detail.documentId)})throw Error('Original replacement document changed');return rows[0].result})`);
  const selectPolicy = (mode, origins) => popup.evaluate(`(()=>{const mode=document.querySelector('#site-access-mode'),origins=document.querySelector('#site-access-origins');mode.value=${JSON.stringify(mode)};mode.dispatchEvent(new Event('change',{bubbles:true}));origins.value=${JSON.stringify(origins.join("\n"))};origins.dispatchEvent(new Event('input',{bubbles:true}))})()`);
  try {
    tab = await browser.newTab({ url: url.href }); detail.tabId = tab.id; detail.oldEpoch = browser.client.controlEpoch;
    const frames = await getWorker().evaluate(`chrome.webNavigation.getAllFrames({tabId:${tab.id}}).then(rows=>rows.filter(row=>row.frameId===0))`);
    assert.equal(frames.length, 1); assert.equal(frames[0].url, url.href); assert.equal(typeof frames[0].documentId, "string"); detail.documentId = frames[0].documentId; detail.before = await state();
    if (!popup) { await traceFocus("action-popup:before-open"); await getWorker().evaluate(`chrome.action.openPopup({windowId:${windowId}})`); await traceFocus("action-popup:after-open"); popup = await connectPage(popupURL); }
    await until(async () => ["Saved", "Default"].includes((await view()).label), "initial invalid replacement settings"); detail.originalPolicy = await readPolicy();
    detail.malformed = { version: 1, revision: 7, mode: "invalid-fixture-mode", origins: [] };
    detail.setup = await getWorker().evaluate(`(async()=>{const value=${JSON.stringify({ [policyKey]: detail.malformed })};await chrome.storage.local.set(value);return {nativeSetAcknowledged:true,value:await chrome.storage.local.get([${JSON.stringify(policyKey)}])}})()`);
    assert.deepEqual(detail.setup, { nativeSetAcknowledged: true, value: { [policyKey]: detail.malformed } });
    assert.deepEqual(await getWorker().evaluate(`chrome.storage.session.get(${JSON.stringify(markerKey)})`), {});
    await getWorker().evaluate(`chrome.storage.session.set({[${JSON.stringify(markerKey)}]:{version:1,nonce:${JSON.stringify(nonce)},armed:true}})`); armed = true;
    detail.restart = await restartWorker(popup);
    detail.invalid = await until(async () => { const current = await readPolicy(); return current.recovery?.state === "invalid" && current.recovery.id ? current : false; }, "actual invalid startup policy");
    assert.equal(detail.invalid.ready, false); assert.equal(detail.invalid.stored, undefined); assert.equal(detail.invalid.retryable, undefined); assert.notEqual(detail.invalid.generation, detail.originalPolicy.generation);
    detail.nativeInvalid = await getWorker().evaluate("__siteAccessInvalidProbe.snapshot()"); checkSiteAccessInvalidNative(detail.nativeInvalid, detail.malformed);
    assert.equal(detail.nativeInvalid.extensionId, new URL(popupURL).hostname); assert.equal(detail.nativeInvalid.nonce, nonce); assert.equal(detail.nativeInvalid.markerKey, markerKey);
    assert.deepEqual(detail.nativeInvalid.consumedMarker, { version: 1, nonce, armed: true });
    assert.deepEqual(await readPolicy(), detail.invalid); assert.deepEqual(await getWorker().evaluate("__siteAccessInvalidProbe.snapshot()"), detail.nativeInvalid);
    detail.pausedInvalid = await paused(); await assert.rejects(tab.getByLabel("Recovery note").fill("must remain blocked"), /OBU_AUTOMATION_PAUSED|OBU_SITE_ACCESS_UNAVAILABLE|OBU_CONTROL_BOOTSTRAP_REQUIRED/);
    detail.blockedBefore = await state(); assert.equal(detail.blockedBefore.value, ""); assert.deepEqual(detail.blockedBefore.events, []); assert.equal(fixtures.stats(key).posts.length, 0);
    await until(async () => { const current = await view(); return current.label === "Unavailable" && current.mode === "" && !current.reviewDisabled; }, "invalid policy replacement available");
    await popup.evaluate("document.querySelector('#site-access-replace-review').click()"); detail.blankDraft = await view(); assert.equal(detail.blankDraft.mode, ""); assert.equal(detail.blankDraft.replaceDisabled, true);
    detail.candidate = { mode: "allow", origins: [new URL(fixtureURL).origin] }; await selectPolicy(detail.candidate.mode, detail.candidate.origins);
    detail.review = await until(async () => { const current = await view(); return !current.replaceDisabled ? current : false; }, "explicit restrictive replacement review");
    assert.equal(detail.review.mode, "allow"); assert.equal(detail.review.origins, detail.candidate.origins[0]); assert.match(detail.review.effect, /only.*listed/i); await capture("site-access-invalid-reviewed", popup);
    await popup.evaluate("document.querySelector('#site-access-replace').click()");
    detail.replaced = await until(async () => { const current = await readPolicy(); return current.ready ? current : false; }, "actual replacement native write", 15000);
    detail.expected = { version: 1, revision: 1, ...detail.candidate }; assert.deepEqual(detail.replaced, { ...detail.expected, generation: detail.replaced.generation, ready: true, stored: true }); assert.notEqual(detail.replaced.generation, detail.invalid.generation);
    detail.nativeReplaced = await getWorker().evaluate("__siteAccessInvalidProbe.snapshot()"); checkSiteAccessInvalidNative(detail.nativeReplaced, detail.malformed, detail.expected);
    detail.durable = await getWorker().evaluate(`chrome.storage.local.get([${JSON.stringify(policyKey)}])`); assert.deepEqual(detail.durable, { [policyKey]: detail.expected });
    detail.staleReplacement = await popup.evaluate(`chrome.runtime.sendMessage(${JSON.stringify({ type: "REPLACE_INVALID_SITE_ACCESS_POLICY", policy: detail.candidate, expectedRecoveryId: detail.invalid.recovery.id })})`);
    assert.equal(detail.staleReplacement.ok, false); assert.match(detail.staleReplacement.error, /OBU_SITE_ACCESS_RECOVERY_(?:UNAVAILABLE|CONFLICT)/);
    assert.deepEqual(await getWorker().evaluate("__siteAccessInvalidProbe.snapshot()"), detail.nativeReplaced);
    detail.pausedReplaced = await paused(); await assert.rejects(tab.getByLabel("Recovery note").fill("must still remain blocked"), /OBU_AUTOMATION_PAUSED/);
    detail.blockedAfter = await state(); assert.equal(detail.blockedAfter.value, ""); assert.deepEqual(detail.blockedAfter.events, []); assert.equal(fixtures.stats(key).posts.length, 0); await capture("site-access-invalid-replaced-paused", popup);
    await resume(); await assert.rejects(tab.domSnapshot(), /OBU_STALE_CONTROL_EPOCH|OBU_CONTROL_BOOTSTRAP_REQUIRED/); assert.equal(browser.client.controlEpoch, detail.oldEpoch);
    await browser.client.beginTurn(); detail.newEpoch = browser.client.controlEpoch; assert.notEqual(detail.newEpoch, detail.oldEpoch);
    const text = `Explicit invalid replacement ${key} 中文`; await tab.getByLabel("Recovery note").fill(text); await tab.getByRole("button", { name: "Submit original recovery note", exact: true }).click();
    await tab.getByText("Saved ", { exact: false }).waitFor({ timeoutMs: 5000 }); detail.after = await state(); detail.submission = fixtures.stats(key); checkSiteAccessStartupSubmission(detail.submission, detail.after, text);
    assert.equal(detail.after.documentToken, detail.before.documentToken); assert.equal(detail.after.nodeToken, detail.before.nodeToken);
  } catch (error) { failure = error; }
  finally {
    try { detail.serverLedger = fixtures.allStats(); } catch (error) { detail.serverLedgerError = errorText(error); failure ??= error; }
    if (armed) try {
      detail.nativeFinal = await getWorker().evaluate("globalThis.__siteAccessInvalidProbe?.stop()??null");
      await getWorker().evaluate(`chrome.storage.session.remove(${JSON.stringify(markerKey)})`); detail.markerCleanup = await getWorker().evaluate(`chrome.storage.session.get(${JSON.stringify(markerKey)})`); assert.deepEqual(detail.markerCleanup, {});
      if (!failure) checkSiteAccessInvalidNative(detail.nativeFinal, detail.malformed, detail.expected, { stopped: true });
    } catch (error) { safeToRestore = false; detail.probeCleanupError = errorText(error); failure ??= error; }
    if (popup && detail.originalPolicy?.ready && safeToRestore) try {
      let current = await readPolicy();
      if (!current.ready && current.recovery?.state === "invalid" && current.recovery.id) {
        // Failure-only private-profile restoration is not user replacement
        // evidence. Never overwrite while a real storage operation is pending.
        const { version, revision, mode, origins } = detail.originalPolicy;
        detail.cleanupSetup = await getWorker().evaluate(`chrome.storage.local.set(${JSON.stringify({ [policyKey]: { version, revision, mode, origins } })}).then(()=>({nativeSetAcknowledged:true}))`);
        detail.cleanupRestart = await restartWorker(popup); current = await until(async () => { const status = await readPolicy(); return status.ready ? status : false; }, "private invalid policy cleanup read");
      }
      if (current.ready) {
        await popup.evaluate("document.querySelector('#site-access-reload').click()"); await until(async () => ["Saved", "Default"].includes((await view()).label), "review restored policy");
        await selectPolicy(detail.originalPolicy.mode, detail.originalPolicy.origins); await popup.evaluate("document.querySelector('#site-access-apply').click()");
        detail.restored = await until(async () => { const status = await readPolicy(); return status.ready && status.generation === current.generation && status.revision === current.revision + 1 ? status : false; }, "restore original popup permissions", 15000); await resume();
      }
    } catch (error) { detail.restoreError = errorText(error); failure ??= error; }
    if (tab) try { await getWorker().evaluate(`chrome.tabs.remove(${tab.id})`); } catch (error) { detail.tabCleanupError = errorText(error); failure ??= error; }
    if (popup && !existingPopup) try { await traceFocus("invalid-popup:before-close"); try { await popup.evaluate("window.close()"); } catch {} popup.close(); await traceFocus("invalid-popup:after-close"); } catch (error) { detail.popupCleanupError = errorText(error); failure ??= error; }
    try { browser.close(); } catch (error) { detail.connectionCleanupError = errorText(error); failure ??= error; }
    if (failure) detail.error = errorText(failure); try { await saveDetail(detail); } catch (error) { failure ??= error; }
  }
  if (failure) throw failure; return detail;
}
