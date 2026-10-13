import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { installDialogEvidence } from "./dialog-fixture.mjs";

const text = error => error?.stack ?? String(error);
const denied = /OBU_SITE_ACCESS_(?:DENIED|UNVERIFIED)/;
const retired = /OBU_DIALOG_EXPIRED|OBU_SITE_ACCESS_(?:DENIED|UNVERIFIED)|OBU_STALE_CONTROL_EPOCH|OBU_CONTROL_BOOTSTRAP_REQUIRED|OBU_AUTOMATION_PAUSED/;
const json = value => JSON.stringify(value).replace(/</g, "\\u003c");

export function createRestrictedDialogFixtures() {
  const entries = new Map();
  const entry = key => { if (!entries.has(key)) entries.set(key, { documents: [], posts: [] }); return entries.get(key); };
  return {
    stats: key => structuredClone(entry(key)),
    allStats: () => structuredClone([...entries].map(([key, value]) => ({ key, ...value }))),
    handle(request, response, url) {
      if (url.pathname !== "/restricted-dialog-boundary") return false;
      const key = url.searchParams.get("key");
      if (!key || !/^[a-z0-9-]{1,120}$/.test(key)) { response.writeHead(400); response.end(); return true; }
      if (request.method === "POST") {
        const chunks = []; let bytes = 0;
        request.on("data", chunk => { bytes += chunk.length; if (bytes > 32768) request.destroy(); else chunks.push(chunk); });
        request.on("end", () => { const body = Buffer.concat(chunks); entry(key).posts.push({ bytes: body.length, bodyBase64: body.toString("base64"), method: request.method, path: request.url }); response.end("saved"); });
        return true;
      }
      if (request.method !== "GET") { response.writeHead(405); response.end(); return true; }
      const token = randomUUID(), child = url.searchParams.get("document") === "child", href = `http://${request.headers.host}${request.url}`;
      entry(key).documents.push({ key, token, child, href });
      const childURL = new URL(href); childURL.hostname = "localhost"; childURL.searchParams.set("document", "child");
      response.setHeader("Content-Type", "text/html; charset=utf-8"); response.setHeader("Cache-Control", "no-store");
      response.end(child ? '<!doctype html><meta charset="utf-8"><p>Denied embedded document</p>' : `<!doctype html><meta charset="utf-8"><title>Restricted dialog boundary</title>
        <button id="confirm">Confirm boundary action</button><button id="add">Add denied frame</button>
        ${url.searchParams.has("mixed") ? `<iframe id="denied-frame" src="${childURL.href}"></iframe>` : ""}
        <script>
        const state={key:${json(key)},token:${json(token)},href:location.href,triggers:[],results:[]};
        const confirmButton=document.querySelector('#confirm'),addButton=document.querySelector('#add');
        window.restrictedDialogSnapshot=()=>({...state,original:confirmButton===document.querySelector('#confirm')&&confirmButton.isConnected&&addButton===document.querySelector('#add')&&addButton.isConnected});
        confirmButton.onclick=event=>{state.triggers.push({type:'confirm',trusted:event.isTrusted});const answer=confirm('boundary: '+state.key);state.results.push(answer);fetch(location.href,{method:'POST',body:JSON.stringify(state)});};
        addButton.onclick=event=>{state.triggers.push({type:'add',trusted:event.isTrusted});const frame=document.createElement('iframe');frame.id='denied-frame';frame.src=${json(childURL.href)};document.body.append(frame);addButton.disabled=true;};
        </script>`);
      return true;
    }
  };
}

// These reads use the already-open, real action popup. The helper never opens,
// connects, focuses or closes it, including when an original case fails.
export function restrictedDialogPolicyControls({ popup, until }) {
  const read = async () => {
    const reply = await popup.evaluate("chrome.runtime.sendMessage({type:'GET_SITE_ACCESS_POLICY'})");
    assert.equal(reply.ok, true); assert.equal(reply.policy.ready, true);
    assert.equal(typeof reply.policy.generation, "string"); return reply.policy;
  };
  const view = () => popup.evaluate(`({mode:document.querySelector('#site-access-mode').value,origins:document.querySelector('#site-access-origins').value,status:document.querySelector('#site-access-status').textContent,revision:Number(document.querySelector('#site-access-status').dataset.revision),error:document.querySelector('#site-access-error').textContent,automation:document.querySelector('#automation-status-label').textContent})`);
  const apply = async (mode, origins) => {
    const before = await read();
    await popup.evaluate("document.querySelector('#site-access-reload').click()");
    await until(async () => { const current = await view(); return current.revision === before.revision && ["Saved", "Default"].includes(current.status); }, "restricted dialog settings review");
    await popup.evaluate(`(()=>{const mode=document.querySelector('#site-access-mode'),origins=document.querySelector('#site-access-origins');mode.value=${json(mode)};mode.dispatchEvent(new Event('change',{bubbles:true}));origins.value=${json(origins.join("\n"))};origins.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#site-access-apply').click()})()`);
    await until(async () => { const current = await view(); if (current.error) throw Error(current.error); return current.status === "Saved" && current.revision === before.revision + 1; }, "restricted dialog policy saved", 15000);
    const policy = await read(); assert.equal(policy.generation, before.generation); assert.equal(policy.revision, before.revision + 1);
    assert.equal(policy.mode, mode); assert.deepEqual(policy.origins, origins); assert.equal(policy.stored, true);
    const control = await popup.evaluate("chrome.runtime.sendMessage({type:'GET_AUTOMATION_CONTROL_STATUS'})");
    assert.equal(control.ok, true); assert.equal(control.status.state, "paused"); assert.equal(control.status.inputBlocked, true); assert.equal(control.status.cleanupComplete, true);
    const durable = await popup.evaluate("chrome.storage.local.get(['OPEN_BROWSER_USE_SITE_ACCESS_POLICY'])");
    const { version, revision } = policy; assert.deepEqual(durable, { OPEN_BROWSER_USE_SITE_ACCESS_POLICY: { version, revision, mode, origins } });
    return { policy, control: control.status, durable };
  };
  const resume = async () => {
    await until(async () => (await view()).automation === "Paused", "restricted dialog paused UI");
    await popup.evaluate("document.querySelector('#automation-toggle').click()");
    await until(async () => (await view()).automation === "Running", "explicit restricted dialog Resume");
    const control = await popup.evaluate("chrome.runtime.sendMessage({type:'GET_AUTOMATION_CONTROL_STATUS'})");
    // Resume clears the completed-Pause witness when it permits new work.
    assert.equal(control.ok, true); assert.equal(control.status.state, "running"); assert.equal(control.status.inputBlocked, false); assert.equal(control.status.cleanupComplete, false);
    return control.status;
  };
  return { read, apply, resume };
}

export async function checkRestrictedDialogPolicy({ popup, fixtureURL, until, runAllowed, runBoundaries, saveDetail }) {
  assert.ok(popup, "Restricted dialogs must borrow an existing real settings popup");
  const controls = restrictedDialogPolicyControls({ popup, until });
  const origins = [new URL(fixtureURL).origin, new URL(fixtureURL).origin.replace("127.0.0.1", "localhost")].sort();
  assert.equal(new Set(origins).size, 2);
  const detail = { popupOwnership: "borrowed", origins }; let failure;
  try {
    detail.originalPolicy = await controls.read(); detail.allowed = await controls.apply("allow", origins); detail.allowed.resume = await controls.resume();
    if (runAllowed) await runAllowed(detail.allowed.policy);
    if (runBoundaries) await runBoundaries(controls, detail.allowed.policy);
  } catch (error) { failure = error; }
  finally {
    if (detail.originalPolicy) try {
      detail.restored = await controls.apply(detail.originalPolicy.mode, detail.originalPolicy.origins); detail.restored.resume = await controls.resume();
    } catch (error) { detail.restoreError = text(error); failure ??= error; }
    if (failure) detail.error = text(failure);
    try { await saveDetail(detail); } catch (error) { failure ??= error; }
  }
  if (failure) throw failure; return detail;
}

export function checkRestrictedDialogBoundaryEvidence(detail) {
  assert.equal(detail.nativeEvidence.overflow, false); assert.deepEqual(detail.nativeEvidence.events, []); assert.deepEqual(detail.nativeEvidence.commands, []);
  assert.match(detail.policyRetired.error, retired); assert.match(detail.mixed.armError, denied); assert.match(detail.mixed.rootActionError, denied);
  assert.match(detail.dynamic.collectError, retired);
  if (detail.dynamic.clickError) assert.match(detail.dynamic.clickError, /OBU_SITE_ACCESS_|OBU_DIALOG_|closed|detached|cancel/i);
  assert.equal(typeof detail.policyRetired.dialogId, "string"); assert.ok(detail.policyRetired.dialogId);
  assert.equal(typeof detail.dynamic.dialogId, "string"); assert.ok(detail.dynamic.dialogId);
  assert.notEqual(detail.dynamic.dialogId, detail.policyRetired.dialogId);
  assert.ok(Number.isSafeInteger(detail.previousEpoch) && detail.previousEpoch > 0); assert.ok(Number.isSafeInteger(detail.newEpoch) && detail.newEpoch > 0); assert.notEqual(detail.previousEpoch, detail.newEpoch);
  for (const item of [detail.mixed, detail.dynamic, detail.policyRetired]) {
    const originals = item.server.documents.filter(document => !document.child); assert.equal(originals.length, 1);
    const original = originals[0]; assert.equal(item.after.token, original.token); assert.equal(item.after.href, original.href); assert.equal(item.after.key, original.key);
    assert.equal(item.before.token, original.token); assert.equal(item.after.original, true); assert.equal(item.before.original, true);
    assert.deepEqual(item.before.triggers, []); assert.deepEqual(item.before.results, []); assert.deepEqual(item.after.results, []); assert.deepEqual(item.server.posts, []);
    assert.deepEqual(item.after.triggers, item === detail.dynamic ? [{ type: "add", trusted: true }] : []);
    assert.equal(item.frames.filter(frame => frame.frameId === 0 && frame.documentId === item.documentId && frame.url === original.href).length, 1);
    if (item !== detail.policyRetired) {
      const children = item.server.documents.filter(document => document.child); assert.equal(children.length, 1);
      assert.equal(new URL(children[0].href).hostname, "localhost");
      assert.equal(item.frames.filter(frame => frame.parentFrameId === 0 && frame.url === children[0].href && frame.documentId).length, 1);
    }
  }
  return { passed: true, trustedAdds: 1, postCount: 0, nativeDialogCount: 0 };
}

export async function checkRestrictedDialogBoundaries({ connectBrowser, getWorker, fixtureURL, fixtures, controls, until, saveDetail }) {
  const browser = await connectBrowser("js-restricted-dialog-boundaries"), detail = { tabIds: [] }; let failure, finishEvidence;
  const read = item => getWorker().evaluate(`chrome.scripting.executeScript({target:{tabId:${item.tabId},documentIds:[${json(item.documentId)}]},world:'MAIN',func:()=>window.restrictedDialogSnapshot()}).then(rows=>{if(rows.length!==1||rows[0].documentId!==${json(item.documentId)})throw Error('Original restricted dialog document changed');return rows[0].result})`);
  const prepare = async (name, mixed = false) => {
    const key = `restricted-dialog-${name.replace(/[A-Z]/g, char => "-" + char.toLowerCase())}`, url = new URL("restricted-dialog-boundary", fixtureURL); url.searchParams.set("key", key); if (mixed) url.searchParams.set("mixed", "1");
    const item = detail[name] = { key }, tab = await browser.newTab({ url: url.href }); item.tabId = tab.id; detail.tabIds.push(tab.id);
    await tab.getByRole("button", { name: "Confirm boundary action", exact: true }).waitFor({ state: "visible" });
    const frames = await until(async () => { const rows = await getWorker().evaluate(`chrome.webNavigation.getAllFrames({tabId:${tab.id}})`); return rows.length === (mixed ? 2 : 1) && rows.every(frame => frame.documentId && frame.url.startsWith("http:")) ? rows : false; }, "original restricted dialog frame tree");
    item.documentId = frames.find(frame => frame.frameId === 0).documentId; item.before = await read(item); return tab;
  };
  const reject = async (operation, pattern) => { let error; try { await operation(); } catch (value) { error = value; } assert.ok(error, "Forbidden or retired dialog operation unexpectedly succeeded"); assert.match(String(error.message ?? error), pattern); return String(error.message ?? error); };
  try {
    detail.frameObserver = await getWorker().evaluate("globalThis.__integrationFrameObserver.snapshot()");
    finishEvidence = await installDialogEvidence(getWorker());
    const mixed = await prepare("mixed", true), dynamic = await prepare("dynamic"), policy = await prepare("policyRetired");
    const old = await policy.expectDialog({ type: "confirm", accept: true }, { timeoutMs: 10000 }); detail.policyRetired.dialogId = old.dialogId; detail.previousEpoch = browser.client.controlEpoch;
    detail.rootOnly = await controls.apply("allow", [new URL(fixtureURL).origin]); detail.rootOnly.resume = await controls.resume();
    detail.policyRetired.error = await reject(() => old.result(), retired);
    await browser.client.beginTurn(); detail.newEpoch = browser.client.controlEpoch;
    detail.mixed.armError = await reject(() => mixed.expectDialog({ type: "confirm", accept: true }, { timeoutMs: 5000 }), denied);
    detail.mixed.rootActionError = await reject(() => mixed.getByRole("button", { name: "Confirm boundary action", exact: true }).click(), denied);
    const wait = await dynamic.expectDialog({ type: "confirm", accept: true }, { timeoutMs: 10000 }); detail.dynamic.dialogId = wait.dialogId;
    try { await dynamic.getByRole("button", { name: "Add denied frame", exact: true }).click(); }
    catch (error) { detail.dynamic.clickError = String(error.message ?? error); }
    await until(async () => (await getWorker().evaluate(`chrome.webNavigation.getAllFrames({tabId:${dynamic.id}})`)).some(frame => frame.parentFrameId === 0 && new URL(frame.url).hostname === "localhost"), "actual denied child commit");
    detail.dynamic.collectError = await reject(() => wait.result(), retired);
    for (const item of [detail.mixed, detail.dynamic, detail.policyRetired]) {
      item.after = await read(item); item.frames = await getWorker().evaluate(`chrome.webNavigation.getAllFrames({tabId:${item.tabId}})`); item.server = fixtures.stats(item.key);
    }
  } catch (error) { failure = error; }
  finally {
    try { detail.serverLedger = fixtures.allStats(); } catch (error) { detail.serverLedgerError = text(error); failure ??= error; }
    if (finishEvidence) try { detail.nativeEvidence = await finishEvidence(); if (!failure) detail.proof = checkRestrictedDialogBoundaryEvidence(detail); } catch (error) { detail.nativeEvidenceError = text(error); failure ??= error; }
    try { detail.childTargetIds = await getWorker().evaluate(`globalThis.__integrationFrames.filter(value=>${json(detail.tabIds)}.includes(value.tabId)).map(value=>value.targetId)`); }
    catch (error) { detail.childTargetReadError = text(error); failure ??= error; }
    for (const id of detail.tabIds) try { await getWorker().evaluate(`chrome.tabs.remove(${id})`); }
    catch (error) { (detail.tabCleanupErrors ??= []).push({ tabId: id, error: text(error) }); failure ??= error; }
    try {
      assert.ok(Array.isArray(detail.childTargetIds), "Original child target inventory required for complete cleanup");
      detail.cleanup = await getWorker().evaluate(`(async()=>({tabs:(await chrome.tabs.query({})).filter(tab=>${json(detail.tabIds)}.includes(tab.id)),targets:(await chrome.debugger.getTargets()).filter(target=>${json(detail.tabIds)}.includes(target.tabId)||${json(detail.childTargetIds)}.includes(target.id))}))()`);
      assert.deepEqual(detail.cleanup, { tabs: [], targets: [] });
    } catch (error) { detail.cleanupError = text(error); failure ??= error; }
    try { browser.close(); } catch (error) { detail.connectionCleanupError = text(error); failure ??= error; }
    if (failure) detail.error = text(failure); try { await saveDetail(detail); } catch (error) { failure ??= error; }
  }
  if (failure) throw failure; return detail;
}
