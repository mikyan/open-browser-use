import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chooserScope, installChooserPointerEvidence } from "./chooser-waits-fixture.mjs";
import { chooserPointerEvidenceComplete } from "./chooser-failure-observation.mjs";

const route = "/pointer-delivery/";
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const errorText = error => error?.stack ?? String(error);
const keyPattern = /^pointer-[a-f0-9]{32}-(?:first|all|navigation)$/;

export function pointerDeliveryHTML(url) {
  const key = url.searchParams.get("key"); assert.match(key, keyPattern);
  const child = url.pathname === `${route}frame`, navigation = key.endsWith("-navigation");
  if (url.pathname === `${route}destination`) return `<!doctype html><title>Pointer navigation completed</title><p>Navigation receipt ${key}</p><script>globalThis.navigationEvidence={key:${JSON.stringify(key)},documentToken:crypto.randomUUID()};</script>`;
  assert.ok(child || url.pathname === `${route}page`);
  const frame = new URL(url); frame.hostname = "localhost"; frame.pathname = `${route}frame`;
  return `<!doctype html><meta charset="utf-8"><title>Pointer delivery ${key}</title>
<style>html,body{margin:0;background:white;font:16px sans-serif}button,a{display:block;margin:24px;width:240px;height:60px}iframe{display:block;margin:20px 0 0 80px;width:600px;height:240px;border:2px solid #333}</style>
${child ? (navigation ? `<a id="upload" href="${route}destination?key=${key}" target="_top">Continue receipt</a>` : '<button id="upload">Submit receipt</button>') + '<output id="receipt"></output>' : '<button id="add">Add receipt frame</button><div id="holder"></div>'}
<script>
const key=${JSON.stringify(key)},button=document.querySelector('#upload'),add=document.querySelector('#add');
globalThis.pointerDeliveryEvidence={key,documentToken:crypto.randomUUID(),frameAdds:[],posts:0,errors:[]};
(${installChooserPointerEvidence.toString()})(document,pointerDeliveryEvidence,button,add);
if(add)add.addEventListener('click',event=>{pointerDeliveryEvidence.frameAdds.push({trusted:event.isTrusted});if(document.querySelector('#pointer-frame'))throw Error('Duplicate frame add');const frame=document.createElement('iframe');frame.id='pointer-frame';frame.title='Receipt frame';frame.src=${JSON.stringify(frame.href)};document.querySelector('#holder').append(frame)});
if(button)button.addEventListener('click',async event=>{pointerDeliveryEvidence.posts++;const body={key,href:location.href,trusted:event.isTrusted,documentToken:pointerDeliveryEvidence.documentToken,posts:pointerDeliveryEvidence.posts,evidence:structuredClone(pointerDeliveryEvidence)};try{${navigation ? `const request=new XMLHttpRequest();request.open('POST','${route}post?'+new URLSearchParams({key}),false);request.setRequestHeader('Content-Type','application/json');request.send(JSON.stringify(body));if(request.status!==200)throw Error('Receipt HTTP '+request.status);` : `const response=await fetch('${route}post?'+new URLSearchParams({key}),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});if(!response.ok)throw Error('Receipt HTTP '+response.status);document.querySelector('#receipt').textContent=JSON.stringify(await response.json());`}}catch(error){pointerDeliveryEvidence.errors.push(String(error))}});
</script>`;
}

export function createPointerDeliveryFixtures() {
  const records = new Map();
  const entry = key => { if (!records.has(key)) records.set(key, { key, gets: [], posts: [] }); return records.get(key); };
  return {
    stats: key => structuredClone(entry(key)),
    allStats: () => structuredClone([...records.values()]),
    handle(request, response, url) {
      if (![`${route}page`, `${route}frame`, `${route}post`, `${route}destination`].includes(url.pathname)) return false;
      const key = url.searchParams.get("key");
      if (!keyPattern.test(key ?? "")) { response.writeHead(400); response.end("Invalid fixture key"); return true; }
      const record = entry(key);
      if (url.pathname !== `${route}post`) {
        if (request.method !== "GET") { response.writeHead(405); response.end(); return true; }
        const html = pointerDeliveryHTML(url);
        record.gets.push({ at: Date.now(), method: request.method, path: url.pathname, sha256: sha256(Buffer.from(html)) });
        response.setHeader("Content-Type", "text/html; charset=utf-8"); response.end(html); return true;
      }
      if (request.method !== "POST") { response.writeHead(405); response.end(); return true; }
      const post = { receivedAt: Date.now(), method: request.method }; record.posts.push(post);
      const chunks = []; let size = 0, overflow = false;
      request.on("data", chunk => { size += chunk.length; if (size <= 96 * 1024) chunks.push(chunk); else overflow = true; });
      request.once("aborted", () => { post.error = "HTTP request aborted"; });
      request.once("error", error => { post.error = String(error); });
      request.once("end", () => {
        const bytes = Buffer.concat(chunks);
        Object.assign(post, { completedAt: Date.now(), bodyBytes: size, bodyBase64: bytes.toString("base64"), bodySHA256: sha256(bytes) });
        try {
          assert.equal(overflow, false, "Receipt body exceeds bound");
          post.value = JSON.parse(bytes.toString("utf8")); assert.equal(post.value.key, key);
          post.receipt = { key, index: record.posts.length, bodySHA256: post.bodySHA256 };
          response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify(post.receipt));
        } catch (error) { post.error = errorText(error); response.writeHead(400); response.end("Invalid receipt"); }
      });
      return true;
    }
  };
}

// Controlled negative, NOT a transparent production observer: selected root
// mouseMoved calls are deliberately NOT dispatched and receive synthetic {}.
// All other calls preserve original receiver, arguments, Promise and error.
// This models missing DOM move receipt, not Chromium/Viz hit-test behavior.
export function installPointerDeliveryGate(api, target, { id, tabId, mode }) {
  if (target.__obuPointerDelivery) throw new Error("Pointer delivery gate already installed");
  if (typeof id !== "string" || !id || !Number.isSafeInteger(tabId) || tabId < 0 || !["drop-first", "drop-all"].includes(mode)) throw new Error("Invalid pointer gate identity");
  const original = api.debugger.sendCommand, nativeThen = Promise.prototype.then;
  if (typeof original !== "function") throw new Error("Native sendCommand missing");
  const records = []; let sequence = 0, dropped = 0, pending = 0, overflow = false, recordingErrors = 0, restored = false;
  const append = value => { if (records.length === 256) { overflow = true; return null; } const record = { sequence: ++sequence, at: Date.now(), ...value }; records.push(record); return record; };
  const safe = operation => { try { return operation(); } catch { recordingErrors++; return null; } };
  function wrapper(...args) {
    const source = args[0], method = args[1], params = args[2];
    let descriptors;
    try { descriptors = source && Object.getOwnPropertyDescriptors(source); } catch { return Reflect.apply(original, this, args); }
    if (descriptors?.tabId?.value !== tabId || method !== "Input.dispatchMouseEvent") return Reflect.apply(original, this, args);
    const root = Object.keys(descriptors).length === 1;
    const type = params && Object.getOwnPropertyDescriptor(params, "type")?.value;
    const drop = root && type === "mouseMoved" && (mode === "drop-all" || dropped === 0);
    const record = safe(() => append({ kind: "invoke", source: structuredClone(source), params: structuredClone(params), dispatched: !drop }));
    if (drop) {
      dropped++; safe(() => append({ kind: "synthetic-ack", invocation: record?.sequence, result: {} })); return Promise.resolve({});
    }
    let promise;
    try { promise = Reflect.apply(original, this, args); }
    catch (error) { safe(() => append({ kind: "settled", invocation: record?.sequence, ok: false, error: String(error) })); throw error; }
    pending++;
    try { nativeThen.call(promise,
      value => { pending--; safe(() => append({ kind: "settled", invocation: record?.sequence, ok: true, result: structuredClone(value) })); },
      error => { pending--; safe(() => append({ kind: "settled", invocation: record?.sequence, ok: false, error: String(error) })); }); }
    catch { pending--; recordingErrors++; }
    return promise;
  }
  const snapshot = () => structuredClone({ version: 1, id, tabId, mode, records, dropped, pending, overflow, recordingErrors, restored });
  api.debugger.sendCommand = wrapper;
  if (api.debugger.sendCommand !== wrapper) throw new Error("Pointer delivery gate not installed");
  const controller = { id, snapshot, restore() {
    if (!restored) {
      if (api.debugger.sendCommand !== wrapper) throw new Error("Pointer delivery gate replaced externally");
      api.debugger.sendCommand = original;
      if (api.debugger.sendCommand !== original) throw new Error("Pointer delivery gate not restored");
      restored = true;
    }
    const value = snapshot(); if (target.__obuPointerDelivery === controller) delete target.__obuPointerDelivery; return value;
  } };
  target.__obuPointerDelivery = controller; return snapshot();
}

export function checkPointerDeliveryTrace(probe) {
  assert.equal(probe?.version, 1); assert.equal(probe.overflow, false); assert.equal(probe.recordingErrors, 0);
  assert.equal(probe.pending, 0); assert.equal(probe.restored, true);
  const calls = probe.records.filter(record => record.kind === "invoke");
  assert.ok(calls.length > 0, "No original move was intercepted");
  assert.ok(probe.records.every((record, index) => record.sequence === index + 1));
  for (const call of calls) {
    assert.deepEqual(call.source, { tabId: probe.tabId }, "All input must retain root routing");
    const settlements = probe.records.filter(record => record.invocation === call.sequence);
    assert.equal(settlements.length, 1); assert.ok(settlements[0].sequence > call.sequence);
    assert.equal(settlements[0].kind, call.dispatched ? "settled" : "synthetic-ack");
    if (call.dispatched) assert.equal(settlements[0].ok, true);
    else assert.equal(call.params.type, "mouseMoved", "Only original moves may be dropped");
  }
  const moves = calls.filter(call => call.params.type === "mouseMoved"), dropped = moves.filter(call => !call.dispatched);
  assert.equal(dropped.length, probe.dropped); assert.ok(dropped.length > 0);
  assert.equal(calls[0], dropped[0], "A button was sent before the missing first move");
  const presses = calls.filter(call => call.params.type === "mousePressed"), releases = calls.filter(call => call.params.type === "mouseReleased");
  assert.equal(calls.length, moves.length + presses.length + releases.length, "Unexpected mouse command");
  if (probe.mode === "drop-all") {
    assert.equal(moves.length, dropped.length); assert.equal(presses.length, 0); assert.equal(releases.length, 0);
  } else {
    assert.equal(probe.mode, "drop-first"); assert.equal(dropped.length, 1);
    const delivered = moves.filter(call => call.dispatched);
    assert.ok(delivered.length > 0, "Original click did not recover with a real move");
    assert.equal(presses.length, 1); assert.equal(releases.length, 1);
    assert.ok(delivered.every(call => call.sequence < presses[0].sequence));
    assert.ok(presses[0].sequence < releases[0].sequence);
    for (const call of [presses[0], releases[0]]) { assert.equal(call.params.button, "left"); assert.equal(call.params.clickCount, 1); }
    const lastMove = delivered.at(-1), ack = probe.records.find(record => record.invocation === lastMove.sequence);
    assert.ok(ack.sequence < presses[0].sequence, "Buttons began before actual move settlement");
    const pressAck = probe.records.find(record => record.invocation === presses[0].sequence);
    assert.ok(pressAck.sequence < releases[0].sequence, "Release began before actual press settlement");
  }
  return { attempts: moves.length, syntheticMoveAcks: dropped.length, realMoves: moves.length - dropped.length,
    presses: presses.length, releases: releases.length };
}

export function checkPointerDeadline(item) {
  assert.equal(item?.mode, "drop-all");
  assert.equal(item.timeoutMs, 5000, "The original click deadline must remain unchanged");
  assert.ok(Number.isFinite(item.clickStartedAt) && Number.isFinite(item.clickFailedAt), "Original click timestamps are required");
  assert.equal(item.clickCompletedAt, undefined, "A fulfilled click is not a deadline failure");
  assert.equal(typeof item.clickError, "string");
  assert.match(item.clickError, /timeout|timed out|deadline/i, "A delivery error alone does not prove deadline exhaustion");
  const elapsedMs = item.clickFailedAt - item.clickStartedAt;
  // Both samples belong to this caller. Allow 100ms for sampling/timer
  // granularity; this never changes or renews the actual 5000ms action budget.
  // No upper wall-clock cap: delayed error delivery cannot authorize input.
  const minimumElapsedMs = item.timeoutMs - 100;
  assert.ok(Number.isFinite(elapsedMs) && elapsedMs >= minimumElapsedMs, "The click failed before its original deadline");
  return { elapsedMs, timeoutMs: item.timeoutMs, minimumElapsedMs };
}

export function checkPointerDeliveryDocuments({ root, child, server, key, childURL, mode }) {
  for (const document of [root, child]) {
    assert.equal(document.key, key); assert.equal(chooserPointerEvidenceComplete(document), true);
    assert.deepEqual(document.errors, []);
  }
  assert.deepEqual(root.frameAdds, [{ trusted: true }]); assert.deepEqual(child.frameAdds, []);
  const events = child.pointerEvidence.records;
  if (mode === "drop-all") {
    assert.equal(child.posts, 0); assert.equal(server.posts.length, 0);
    assert.equal(events.filter(event => ["pointerdown", "mousedown", "pointerup", "mouseup", "click"].includes(event.type)).length, 0);
  } else {
    assert.equal(child.posts, 1); assert.equal(server.posts.length, 1);
    const types = ["pointerdown", "mousedown", "pointerup", "mouseup", "click"];
    const buttons = events.filter(event => types.includes(event.type));
    assert.deepEqual(buttons.map(event => event.type), types);
    assert.ok(buttons.every(event => event.trusted && event.targetIsOriginalUpload));
    const moves = events.filter(event => event.type === "pointermove" && event.trusted && event.pointerType === "mouse" &&
      event.buttons === 0 && event.targetIsOriginalUpload);
    assert.ok(moves.some(event => event.sequence < buttons[0].sequence), "No trusted mouse pointermove on the original child node preceded button delivery");
    const post = server.posts[0], bytes = Buffer.from(post.bodyBase64, "base64");
    assert.equal(post.error, undefined); assert.equal(post.method, "POST"); assert.equal(bytes.length, post.bodyBytes); assert.equal(sha256(bytes), post.bodySHA256);
    const value = JSON.parse(bytes.toString("utf8")); assert.deepEqual(value, post.value);
    assert.equal(value.key, key); assert.equal(value.href, childURL); assert.equal(value.documentToken, child.documentToken);
    assert.equal(value.trusted, true); assert.equal(value.posts, 1); assert.deepEqual(value.evidence, child);
    assert.equal(post.receipt?.bodySHA256, post.bodySHA256);
  }
  return { childDocumentToken: child.documentToken, childEvents: events.length, posts: server.posts.length };
}

export function checkPointerNavigationEvidence(item) {
  assert.equal(item.mode, "navigate-first");
  const before = item.navigationBefore, after = item.navigationAfter;
  assert.ok(typeof before?.documentId === "string" && before.documentId);
  assert.ok(typeof after?.documentId === "string" && after.documentId && after.documentId !== before.documentId, "Root document did not change");
  assert.equal(before.frameId, 0); assert.equal(after.frameId, 0);
  assert.equal(before.result?.href, item.url); assert.equal(after.result?.href, item.destinationURL);
  assert.equal(after.result.navigationEvidence?.key, item.key);
  assert.ok(typeof after.result.navigationEvidence.documentToken === "string" && after.result.navigationEvidence.documentToken);
  assert.notEqual(after.result.navigationEvidence.documentToken, before.result.evidence.documentToken);
  assert.equal(item.server.gets.filter(value => value.path === `${route}destination`).length, 1, "Navigation destination arrived more or less than once");
  const child = item.server.posts[0]?.value?.evidence;
  return checkPointerDeliveryDocuments({ root: before.result.evidence, child, server: item.server, key: item.key, childURL: item.childURL, mode: "drop-first" });
}

async function bounded(promise, timeoutMs, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Pointer fixture ${label} timed out`)), timeoutMs); })]); }
  finally { clearTimeout(timer); }
}

export async function checkPointerDelivery({ browser, worker, fixtureURL, server, until, detail = {} }) {
  Object.assign(detail, { passed: false, cases: [], cleanupErrors: [], boundary: "Test-only root move suppression with synthetic ACK, followed by real routed input. It proves recovery ordering and once-only business effect under this controlled missing-receipt condition, not reproduction or resolution of a natural Viz/OOPIF failure." });
  let originalError;
  try {
    for (const mode of ["drop-first", "navigate-first", "drop-all"]) {
      const id = randomUUID(), key = `pointer-${id.replaceAll("-", "")}-${mode === "drop-first" ? "first" : mode === "drop-all" ? "all" : "navigation"}`;
      const item = { id, key, mode, passed: false }; detail.cases.push(item);
      const tab = await browser.newTab(); item.tabId = tab.id;
      const url = new URL(`${route}page`, fixtureURL); url.search = new URLSearchParams({ key }).toString();
      const childURL = new URL(url); childURL.hostname = "localhost"; childURL.pathname = `${route}frame`;
      item.url = url.href; item.childURL = childURL.href;
      await browser.cdp.navigate(tab.id, url.href);
      await tab.getByRole("button", { name: "Add receipt frame", exact: true }).click({ timeoutMs: 5000 });
      if (mode === "navigate-first") {
        const destination = new URL(childURL); destination.pathname = `${route}destination`; item.destinationURL = destination.href;
        const reads = await worker.evaluate(`chrome.scripting.executeScript({target:{tabId:${tab.id},frameIds:[0]},world:'MAIN',func:()=>({href:location.href,evidence:globalThis.pointerDeliveryEvidence})})`);
        assert.equal(reads.length, 1); item.navigationBefore = reads[0];
      }
      item.scope = chooserScope(browser); let installAttempted = false, failure;
      try {
        installAttempted = true;
        const setupDeadline = Date.now() + 5000;
        item.gateMode = mode === "drop-all" ? "drop-all" : "drop-first";
        item.installation = await bounded(worker.evaluate(`(()=>{if(Date.now()>=${setupDeadline})throw Error('Pointer gate setup deadline expired');return (${installPointerDeliveryGate.toString()})(chrome,globalThis,${JSON.stringify({ id, tabId: tab.id, mode: item.gateMode })})})()`), 5000, "gate installation");
        item.clickStartedAt = Date.now(); item.timeoutMs = 5000;
        try { await tab.frameLocator("#pointer-frame").getByRole(mode === "navigate-first" ? "link" : "button", { name: mode === "navigate-first" ? "Continue receipt" : "Submit receipt", exact: true }).click({ timeoutMs: item.timeoutMs }); item.clickCompletedAt = Date.now(); }
        catch (error) { item.clickFailedAt = Date.now(); item.clickError = errorText(error); if (mode !== "drop-all") throw error; }
        if (mode === "drop-all") {
          item.deadlineProof = checkPointerDeadline(item);
        } else await until(() => server.stats(key).posts.length === 1 && server.stats(key).posts[0].receipt &&
          (mode !== "navigate-first" || server.stats(key).gets.filter(value => value.path === `${route}destination`).length === 1), "pointer delivery single business POST/navigation", 5000);
      } catch (error) { failure = error; item.error = errorText(error); }
      finally {
        if (installAttempted) try {
          item.probe = await bounded(worker.evaluate(`(()=>{const p=globalThis.__obuPointerDelivery;if(!p)return null;if(p.id!==${JSON.stringify(id)})throw Error('Pointer delivery gate identity changed');return p.restore()})()`), 5000, "gate restoration");
        } catch (error) { item.restoreError = errorText(error); detail.cleanupErrors.push(item.restoreError); failure ??= error; }
      }
      item.server = server.stats(key);
      // Only after the one original click settles: independent current native
      // document IDs and the already-recorded page events. No readiness action.
      try {
        assert.deepEqual(chooserScope(browser), item.scope);
        item.native = await worker.evaluate(`(async()=>({tab:await chrome.tabs.get(${tab.id}),frames:await chrome.webNavigation.getAllFrames({tabId:${tab.id}}),targets:await chrome.debugger.getTargets(),attachments:globalThis.__integrationFrames.filter(value=>value.tabId===${tab.id})}))()`);
        assert.equal(item.native.tab.id, tab.id); assert.equal(item.native.tab.active, false);
        if (mode === "navigate-first") {
          assert.equal(item.native.tab.url, item.destinationURL);
          const roots = item.native.frames.filter(frame => frame.frameId === 0 && frame.url === item.destinationURL);
          assert.equal(roots.length, 1); assert.equal(roots[0].documentLifecycle, "active"); assert.equal(roots[0].errorOccurred, false);
          const reads = await worker.evaluate(`chrome.scripting.executeScript({target:{tabId:${tab.id},documentIds:${JSON.stringify([roots[0].documentId])}},world:'MAIN',func:()=>({href:location.href,navigationEvidence:globalThis.navigationEvidence})})`);
          assert.equal(reads.length, 1); item.navigationAfter = reads[0]; assert.equal(reads[0].documentId, roots[0].documentId);
          item.traceProof = checkPointerDeliveryTrace(item.probe); item.documentProof = checkPointerNavigationEvidence(item);
          if (failure) throw failure;
          item.passed = true; continue;
        }
        assert.equal(item.native.tab.url, url.href);
        const roots = item.native.frames.filter(frame => frame.frameId === 0 && frame.url === url.href), children = item.native.frames.filter(frame => frame.parentFrameId === 0 && frame.url === childURL.href);
        assert.equal(roots.length, 1); assert.equal(children.length, 1); assert.notEqual(roots[0].processId, children[0].processId, "A real OOPIF is required");
        if (mode !== "drop-all") {
          const targets = item.native.targets.filter(target => target.url === childURL.href && target.attached === true); assert.equal(targets.length, 1);
          assert.equal(item.native.attachments.filter(value => value.type === "iframe" && value.targetId === targets[0].id && value.source?.tabId === tab.id && value.source.sessionId === undefined && value.sessionId).length, 1);
        } // Timeout cleanup may legitimately detach; no new attachment is made.
        const documents = [roots[0], children[0]];
        assert.ok(documents.every(frame => typeof frame.documentId === "string" && frame.documentId && frame.documentLifecycle === "active" && frame.errorOccurred === false));
        assert.notEqual(documents[0].documentId, documents[1].documentId);
        item.documents = await worker.evaluate(`chrome.scripting.executeScript({target:{tabId:${tab.id},documentIds:${JSON.stringify(documents.map(frame => frame.documentId))}},world:'MAIN',func:()=>({href:location.href,evidence:globalThis.pointerDeliveryEvidence})})`);
        const reads = documents.map(frame => { const values = item.documents.filter(value => value.documentId === frame.documentId && value.frameId === frame.frameId); assert.equal(values.length, 1); assert.equal(values[0].result?.href, frame.url); return values[0].result.evidence; });
        item.traceProof = checkPointerDeliveryTrace(item.probe);
        item.documentProof = checkPointerDeliveryDocuments({ root: reads[0], child: reads[1], server: item.server, key, childURL: childURL.href, mode });
      } catch (error) { item.evidenceError = errorText(error); failure ??= error; }
      if (failure) throw failure;
      item.passed = true;
    }
    detail.server = server.allStats(); detail.passed = true; return detail;
  } catch (error) { originalError = error; detail.error = errorText(error); throw error; }
  finally {
    if (originalError) try { originalError.pointerDeliveryDetail = detail; } catch { /* Retain the original error identity. */ }
  }
}
