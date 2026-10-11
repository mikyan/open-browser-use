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
      if (url.pathname.startsWith(countedRoute)) return handleCountedPointerRequest(request, response, url, entry);
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

const countedRoute = "/pointer-counted/";
const countedKeyPattern = /^pointer-counted-[a-f0-9]{32}-(root-double|same-triple|oopif-double|navigation-double)$/;
export const countedPointerCases = Object.freeze([
  Object.freeze({ name: "root-double", layout: "root", action: "dblclick", count: 2, modifiers: [], gate: "observe" }),
  Object.freeze({ name: "same-triple", layout: "same", action: "click", count: 3, modifiers: ["Shift"], gate: "observe" }),
  Object.freeze({ name: "oopif-double", layout: "oopif", action: "dblclick", count: 2, modifiers: ["Shift"], gate: "drop-first" }),
  Object.freeze({ name: "navigation-double", layout: "oopif", action: "click", count: 2, modifiers: [], gate: "observe", navigation: true, delay: 150 })
]);

// This is a passive, finite page ledger, not an input source. Kept separate from
// the original three fixtures so their HTML and eight-event recorder stay exact.
export function installCountedPointerEvidence(document, evidence, node) {
  const types = ["pointermove", "pointerdown", "pointerup", "mousemove", "mousedown", "mouseup", "click", "dblclick", "keydown", "keyup"];
  Object.assign(evidence, { records: [], nextSequence: 0, maximumRecords: 256, overflow: false, errors: [] });
  for (const type of types) document.addEventListener(type, event => {
    if (evidence.records.length >= evidence.maximumRecords) { evidence.overflow = true; return; }
    try {
      const record = { sequence: evidence.nextSequence++, type, documentToken: evidence.documentToken,
        trusted: event.isTrusted, originalNode: event.target === node, targetId: event.target?.id ?? "",
        detail: event.detail, shift: event.shiftKey, ctrl: event.ctrlKey, alt: event.altKey, meta: event.metaKey,
        button: event.button ?? null, buttons: event.buttons ?? null, pointerType: event.pointerType ?? null,
        isPrimary: event.isPrimary ?? null, key: event.key ?? null, code: event.code ?? null,
        clientX: event.clientX ?? null, clientY: event.clientY ?? null, timeStamp: event.timeStamp };
      if (typeof record.targetId !== "string" || record.targetId.length > 128 ||
          (record.key !== null && (typeof record.key !== "string" || record.key.length > 128)) ||
          (record.code !== null && (typeof record.code !== "string" || record.code.length > 128))) throw Error("Unbounded pointer metadata");
      evidence.records.push(record);
    } catch (error) { if (evidence.errors.length < 8) evidence.errors.push(String(error)); }
  }, { capture: true, passive: true });
}

export function countedPointerHTML(url) {
  const key = url.searchParams.get("key"), match = countedKeyPattern.exec(key ?? ""); assert.ok(match);
  const spec = countedPointerCases.find(value => value.name === match[1]);
  const destination = url.pathname === `${countedRoute}destination`, child = url.pathname === `${countedRoute}frame`;
  assert.ok(destination || child || url.pathname === `${countedRoute}page`);
  const ownsTarget = destination || child || spec.layout === "root";
  const frame = new URL(url); frame.pathname = `${countedRoute}frame`; if (spec.layout === "oopif") frame.hostname = "localhost";
  const target = new URL(frame); target.pathname = `${countedRoute}destination`;
  const label = spec.navigation ? "Continue counted receipt" : "Counted receipt";
  return `<!doctype html><meta charset="utf-8"><title>Counted pointer ${key}</title>
<style>html,body{margin:0;background:white;font:16px sans-serif}button,a{display:block;margin:24px;width:240px;height:60px}iframe{display:block;margin:40px 0 0 80px;width:600px;height:240px;border:2px solid #333}</style>
${ownsTarget ? (spec.navigation && !destination ? `<a id="counted" href="${target.href}" target="_top">${label}</a>` : `<button id="counted">${label}</button>`) + '<output id="counted-result">0 clicks / 0 doubles</output>' : `<iframe id="counted-frame" title="Counted frame" src="${frame.href}"></iframe>`}
<script>
const key=${JSON.stringify(key)},spec=${JSON.stringify(spec)},destination=${destination},node=document.querySelector('#counted');
const evidence=globalThis.countedPointerEvidence={key,documentToken:crypto.randomUUID(),clicks:0,doubles:0,posts:0};
(${installCountedPointerEvidence.toString()})(document,evidence,node);
function sendReceipt(event){evidence.posts++;const body={key,href:location.href,trusted:event.isTrusted,documentToken:evidence.documentToken,evidence:structuredClone(evidence)};
try{${spec.navigation ? `const request=new XMLHttpRequest();request.open('POST','${countedRoute}post?'+new URLSearchParams({key}),false);request.setRequestHeader('Content-Type','application/json');request.send(JSON.stringify(body));if(request.status!==200)throw Error('Receipt HTTP '+request.status);` : `fetch('${countedRoute}post?'+new URLSearchParams({key}),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(response=>{if(!response.ok)throw Error('Receipt HTTP '+response.status);return response.json()}).then(receipt=>{evidence.receipt=receipt}).catch(error=>evidence.errors.push(String(error)));`}}
catch(error){evidence.errors.push(String(error))}}
if(node){node.addEventListener('click',event=>{evidence.clicks++;document.querySelector('#counted-result').textContent=evidence.clicks+' clicks / '+evidence.doubles+' doubles';if(!destination&&(spec.navigation||spec.count===3&&event.detail===3))sendReceipt(event)});
node.addEventListener('dblclick',event=>{evidence.doubles++;document.querySelector('#counted-result').textContent=evidence.clicks+' clicks / '+evidence.doubles+' doubles';if(!destination&&!spec.navigation&&spec.count===2)sendReceipt(event)});}
</script>`;
}

function handleCountedPointerRequest(request, response, url, entry) {
  if (!["page", "frame", "post", "destination"].some(value => url.pathname === countedRoute + value)) return false;
  const key = url.searchParams.get("key");
  if (!countedKeyPattern.test(key ?? "")) { response.writeHead(400); response.end("Invalid counted key"); return true; }
  const record = entry(key);
  if (url.pathname !== `${countedRoute}post`) {
    if (request.method !== "GET") { response.writeHead(405); response.end(); return true; }
    const html = countedPointerHTML(url), bytes = Buffer.from(html);
    record.gets.push({ at: Date.now(), method: "GET", path: url.pathname, url: url.href, bytes: bytes.length, sha256: sha256(bytes) });
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }); response.end(html); return true;
  }
  if (request.method !== "POST") { response.writeHead(405); response.end(); return true; }
  const post = { receivedAt: Date.now(), method: "POST" }; record.posts.push(post);
  const chunks = []; let size = 0;
  request.on("data", chunk => { size += chunk.length; if (size <= 96 * 1024) chunks.push(chunk); });
  request.once("aborted", () => { post.error = "HTTP request aborted"; });
  request.once("error", error => { post.error = String(error); });
  request.once("end", () => {
    const bytes = Buffer.concat(chunks); Object.assign(post, { completedAt: Date.now(), bodyBytes: size, bodyBase64: bytes.toString("base64"), bodySHA256: sha256(bytes) });
    try {
      assert.ok(size <= 96 * 1024); post.value = JSON.parse(bytes.toString("utf8")); assert.equal(post.value.key, key);
      post.receipt = { key, index: record.posts.length, bodySHA256: post.bodySHA256 };
      response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify(post.receipt));
    } catch (error) { post.error = errorText(error); response.writeHead(400); response.end("Invalid counted receipt"); }
  }); return true;
}

// Only drop-first synthesizes a result, for the same explicitly controlled
// missing-move model as the original fixture. Key/modifier commands are never
// dropped. The ordinary observer returns every native Promise unchanged.
export function installCountedPointerProbe(api, target, { id, tabId, mode }) {
  if (target.__obuCountedPointer) throw Error("Counted pointer probe already installed");
  if (!id || typeof id !== "string" || !Number.isSafeInteger(tabId) || tabId < 0 || !["observe", "drop-first"].includes(mode)) throw Error("Invalid counted probe identity");
  const original = api.debugger.sendCommand, nativeThen = Promise.prototype.then;
  let sequence = 0, dropped = 0, pending = 0, overflow = false, recordingErrors = 0, restored = false;
  const records = [], append = value => { if (records.length >= 512) { overflow = true; return null; } const record = { sequence: ++sequence, ...value }; records.push(record); return record; };
  const safe = fn => { try { return fn(); } catch { recordingErrors++; return null; } };
  function wrapper(...args) {
    let descriptors; try { descriptors = args[0] && Object.getOwnPropertyDescriptors(args[0]); } catch { return Reflect.apply(original, this, args); }
    if (descriptors?.tabId?.value !== tabId || typeof args[1] !== "string" || !args[1].startsWith("Input.")) return Reflect.apply(original, this, args);
    const drop = mode === "drop-first" && dropped === 0 && Object.keys(descriptors).length === 1 && args[1] === "Input.dispatchMouseEvent" && Object.getOwnPropertyDescriptor(args[2] ?? {}, "type")?.value === "mouseMoved";
    const record = safe(() => append({ kind: "invoke", method: args[1], source: structuredClone(args[0]), params: structuredClone(args[2]), dispatched: !drop }));
    if (drop) { dropped++; safe(() => append({ kind: "synthetic-ack", invocation: record?.sequence, result: {} })); return Promise.resolve({}); }
    let promise;
    try { promise = Reflect.apply(original, this, args); }
    catch (error) { safe(() => append({ kind: "settled", invocation: record?.sequence, ok: false, error: String(error) })); throw error; }
    pending++;
    try { nativeThen.call(promise, result => { pending--; safe(() => append({ kind: "settled", invocation: record?.sequence, ok: true, result: structuredClone(result) })); },
      error => { pending--; safe(() => append({ kind: "settled", invocation: record?.sequence, ok: false, error: String(error) })); }); }
    catch { pending--; recordingErrors++; }
    return promise;
  }
  const snapshot = () => structuredClone({ version: 1, id, tabId, mode, records, dropped, pending, overflow, recordingErrors, restored });
  api.debugger.sendCommand = wrapper; if (api.debugger.sendCommand !== wrapper) throw Error("Counted probe not installed");
  const controller = { id, snapshot, restore() {
    if (!restored) { if (api.debugger.sendCommand !== wrapper) throw Error("Counted probe replaced externally"); api.debugger.sendCommand = original; if (api.debugger.sendCommand !== original) throw Error("Counted probe not restored"); restored = true; }
    const value = snapshot(); if (target.__obuCountedPointer === controller) delete target.__obuCountedPointer; return value;
  } }; target.__obuCountedPointer = controller; return snapshot();
}

export function checkCountedPointerTrace(probe, spec) {
  assert.equal(probe?.version, 1); assert.equal(probe.mode, spec.gate);
  for (const field of ["overflow", "restored"]) assert.equal(probe[field], field === "restored");
  assert.equal(probe.pending, 0); assert.equal(probe.recordingErrors, 0);
  assert.ok(probe.records.every((record, index) => record.sequence === index + 1));
  const calls = probe.records.filter(value => value.kind === "invoke"), acks = new Map();
  assert.ok(calls.length > 0);
  for (const call of calls) {
    assert.deepEqual(call.source, { tabId: probe.tabId }, "Counted input must retain exact root routing");
    const ack = probe.records.filter(value => value.invocation === call.sequence); assert.equal(ack.length, 1); assert.ok(ack[0].sequence > call.sequence);
    assert.equal(ack[0].kind, call.dispatched ? "settled" : "synthetic-ack"); if (call.dispatched) assert.equal(ack[0].ok, true);
    else { assert.equal(call.method, "Input.dispatchMouseEvent"); assert.equal(call.params.type, "mouseMoved"); }
    acks.set(call.sequence, ack[0].sequence);
  }
  assert.equal(probe.records.length, calls.length * 2, "Unassociated native record");
  const mouse = calls.filter(value => value.method === "Input.dispatchMouseEvent"), keys = calls.filter(value => value.method === "Input.dispatchKeyEvent");
  assert.equal(mouse.length + keys.length, calls.length, "Unexpected native input method");
  const moves = mouse.filter(value => value.params.type === "mouseMoved"), buttons = mouse.filter(value => value.params.type !== "mouseMoved");
  assert.equal(moves.filter(value => !value.dispatched).length, spec.gate === "drop-first" ? 1 : 0); assert.equal(probe.dropped, spec.gate === "drop-first" ? 1 : 0);
  const real = moves.filter(value => value.dispatched); assert.ok(real.length > 0);
  const count = spec.navigation ? 1 : spec.count;
  assert.equal(buttons.length, count * 2, "The original counted sequence must not be duplicated or continue in a new document");
  const mask = spec.modifiers.includes("Shift") ? 8 : 0;
  for (const move of moves) { assert.ok(move.sequence < buttons[0].sequence); assert.equal(move.params.modifiers ?? 0, mask); }
  assert.ok(acks.get(real.at(-1).sequence) < buttons[0].sequence, "Buttons preceded real move ACK");
  for (let index = 0; index < buttons.length; index++) {
    const button = buttons[index]; assert.equal(button.dispatched, true); assert.equal(button.params.type, index % 2 ? "mouseReleased" : "mousePressed");
    assert.equal(button.params.button, "left"); assert.equal(button.params.buttons, index % 2 ? 0 : 1);
    assert.equal(button.params.clickCount, Math.floor(index / 2) + 1); assert.equal(button.params.modifiers ?? 0, mask);
    if (index) assert.ok(acks.get(buttons[index - 1].sequence) < button.sequence, "Counted button sends must await the preceding native ACK");
  }
  assert.equal(keys.length % 2, 0);
  if (!mask) assert.equal(keys.length, 0);
  else {
    assert.ok(keys.length >= 2, "Missing explicit modifier setup/restoration");
    for (let index = 0; index < keys.length; index += 2) {
      const down = keys[index], up = keys[index + 1];
      assert.equal(down.params.type, "rawKeyDown"); assert.equal(up.params.type, "keyUp");
      for (const key of [down, up]) { assert.equal(key.params.key, "Shift"); assert.equal(key.params.code, "ShiftLeft"); assert.equal(key.dispatched, true); }
      assert.equal(down.params.modifiers, 8); assert.equal(up.params.modifiers, 0);
      assert.ok(acks.get(down.sequence) < up.sequence);
      if (index + 2 < keys.length) assert.ok(acks.get(up.sequence) < keys[index + 2].sequence, "Retry modifier restoration must complete before setup");
    }
    const finalDown = keys.at(-2), finalUp = keys.at(-1);
    assert.ok(acks.get(finalDown.sequence) < real.at(-1).sequence); assert.ok(acks.get(buttons.at(-1).sequence) < finalUp.sequence);
    const intervals = keys.filter((_, index) => index % 2 === 0).map((down, index) => ({ down, up: keys[index * 2 + 1] }));
    assert.equal(intervals.length, moves.length, "Each attempted move must set up and restore its explicit modifiers");
    for (const [index, { down, up }] of intervals.entries()) {
      assert.equal(moves.filter(call => acks.get(down.sequence) < call.sequence && acks.get(call.sequence) < up.sequence).length, 1);
      assert.equal(buttons.filter(call => call.sequence > down.sequence && call.sequence < up.sequence).length, index === intervals.length - 1 ? buttons.length : 0);
    }
    for (const mouseCall of mouse) {
      assert.equal(intervals.filter(({ down, up }) => acks.get(down.sequence) < mouseCall.sequence && acks.get(mouseCall.sequence) < up.sequence).length, 1,
        "Every move/button must execute and settle inside its own modifier interval");
    }
  }
  return { moves: moves.length, syntheticMoveAcks: probe.dropped, presses: count, releases: count, modifierPairs: keys.length / 2 };
}

function checkCountedLedger(evidence, key) {
  assert.equal(evidence?.key, key); assert.ok(typeof evidence.documentToken === "string" && evidence.documentToken);
  assert.equal(evidence.overflow, false); assert.deepEqual(evidence.errors, []); assert.equal(evidence.maximumRecords, 256);
  assert.equal(evidence.nextSequence, evidence.records.length); assert.ok(evidence.records.length <= 256);
  for (const [index, event] of evidence.records.entries()) {
    assert.equal(event.sequence, index); assert.equal(event.documentToken, evidence.documentToken); assert.equal(typeof event.trusted, "boolean");
  }
}

export function checkCountedPointerDocuments({ spec, key, targetURL, documents, server, destination }) {
  assert.equal(documents.length, spec.layout === "root" || spec.navigation ? 1 : 2);
  for (const doc of documents) checkCountedLedger(doc.evidence, key);
  const target = spec.navigation ? server.posts[0]?.value?.evidence : documents.find(doc => doc.href === targetURL)?.evidence;
  checkCountedLedger(target, key);
  const count = spec.navigation ? 1 : spec.count, doubles = spec.navigation ? 0 : 1;
  assert.equal(target.clicks, count); assert.equal(target.doubles, doubles); assert.equal(target.posts, 1);
  const buttons = target.records.filter(event => ["pointerdown", "mousedown", "pointerup", "mouseup", "click", "dblclick"].includes(event.type));
  const expected = [];
  for (let index = 1; index <= count; index++) { expected.push(...["pointerdown", "mousedown", "pointerup", "mouseup", "click"].map(type => ({ type, count: index }))); if (index === 2) expected.push({ type: "dblclick", count: index }); }
  assert.deepEqual(buttons.map(event => event.type), expected.map(event => event.type));
  for (const [index, event] of buttons.entries()) {
    assert.equal(event.trusted, true); assert.equal(event.originalNode, true); assert.equal(event.targetId, "counted");
    assert.equal(event.shift, spec.modifiers.includes("Shift")); for (const modifier of ["ctrl", "alt", "meta"]) assert.equal(event[modifier], false);
    if (!event.type.startsWith("pointer")) assert.equal(event.detail, expected[index].count);
  }
  assert.ok(target.records.some(event => event.type === "pointermove" && event.trusted && event.originalNode && event.pointerType === "mouse" && event.isPrimary === true && event.buttons === 0 && event.sequence < buttons[0].sequence), "Missing original-node trusted mouse move before counted buttons");
  assert.equal(server.posts.length, 1); const post = server.posts[0], raw = Buffer.from(post.bodyBase64, "base64");
  assert.equal(post.error, undefined); assert.equal(post.method, "POST"); assert.equal(raw.length, post.bodyBytes); assert.equal(sha256(raw), post.bodySHA256);
  assert.deepEqual(JSON.parse(raw.toString("utf8")), post.value); assert.equal(post.receipt.bodySHA256, post.bodySHA256);
  assert.equal(post.value.key, key); assert.equal(post.value.href, targetURL); assert.equal(post.value.trusted, true); assert.equal(post.value.documentToken, target.documentToken);
  checkCountedLedger(post.value.evidence, key);
  assert.deepEqual(post.value.evidence.records, target.records.slice(0, post.value.evidence.records.length), "POST must preserve an exact prefix of the original document events");
  assert.equal(post.value.evidence.clicks, count); assert.equal(post.value.evidence.doubles, doubles); assert.equal(post.value.evidence.posts, 1);
  if (spec.navigation) {
    assert.ok(destination && typeof destination.beforeDocumentId === "string" && destination.beforeDocumentId);
    assert.ok(typeof destination.documentId === "string" && destination.documentId && destination.documentId !== destination.beforeDocumentId);
    assert.equal(destination.href, destination.url); checkCountedLedger(destination.evidence, key);
    assert.notEqual(destination.evidence.documentToken, target.documentToken); assert.equal(destination.evidence.clicks, 0); assert.equal(destination.evidence.doubles, 0); assert.equal(destination.evidence.posts, 0);
    assert.equal(destination.evidence.records.filter(event => ["pointerdown", "mousedown", "pointerup", "mouseup", "click", "dblclick"].includes(event.type)).length, 0);
    assert.equal(server.gets.filter(value => value.path === `${countedRoute}destination`).length, 1);
  } else {
    const visible = documents.find(doc => doc.href === targetURL); assert.equal(visible.visibleResult, `${count} clicks / ${doubles} doubles`);
    if (spec.modifiers.length) {
      const keys = documents.flatMap(doc => doc.evidence.records).filter(event => ["keydown", "keyup"].includes(event.type));
      assert.ok(keys.length >= 2); assert.equal(keys.filter(event => event.type === "keydown").length, keys.filter(event => event.type === "keyup").length);
      assert.ok(keys.every(event => event.trusted && event.key === "Shift" && event.code === "ShiftLeft" && event.shift === (event.type === "keydown") && !event.ctrl && !event.alt && !event.meta));
    }
  }
  return { documentToken: target.documentToken, clicks: count, doubles, posts: 1, nativeDocumentChanged: !!spec.navigation };
}

// Receipt GET proves a request, not commit. Observe only the original tab and
// share the original counted action's absolute deadline; never issue navigation,
// attachment or input to turn a partial first click into a successful sequence.
export async function readCountedNavigationState(api, tabId, deadlineAt) {
  const check = () => { if (Date.now() >= deadlineAt) throw Error("Counted navigation native read exceeded the original action deadline"); };
  check();
  const tab = await api.tabs.get(tabId);
  check();
  const frames = await api.webNavigation.getAllFrames({ tabId });
  check();
  return { tab, frames };
}

export async function waitForCountedNavigationCommit({ read, until, tabId, url, beforeDocumentId, deadlineAt, record, now = Date.now }) {
  Object.assign(record, { requestedAt: now(), deadlineAt, maximumSamples: 80, samples: [], complete: false });
  let originalError, committed, stopped = false;
  const remaining = () => {
    const value = deadlineAt - now();
    if (value <= 0) throw Error("Counted navigation commit exceeded the original action deadline");
    return value;
  };
  try {
    assert.ok(Number.isSafeInteger(tabId) && tabId >= 0); assert.ok(typeof beforeDocumentId === "string" && beforeDocumentId);
    await bounded(until(async () => {
      if (stopped) return true;
      try {
        const timeout = remaining();
        if (record.samples.length >= record.maximumSamples) throw Error("Counted navigation commit exceeded the sample bound");
        const requestedAt = now(), native = await bounded(read(), timeout, "counted navigation commit read");
        if (stopped) return true;
        const sample = { requestedAt, completedAt: now(), ...native }; record.samples.push(sample);
        remaining();
        assert.equal(native?.tab?.id, tabId, "Commit observation returned a different tab");
        assert.equal(native.tab.active, false, "Commit observation must not activate the task tab");
        assert.ok(Array.isArray(native.frames));
        const roots = native.frames.filter(frame => frame.frameId === 0); assert.ok(roots.length <= 1, "Ambiguous native root document");
        if (roots[0]?.errorOccurred) throw Error("Counted navigation native root reported an error");
        const root = roots[0];
        if (native.tab.url !== url || native.tab.status !== "complete" || native.tab.pendingUrl ||
            !root || root.url !== url || root.documentLifecycle !== "active" || root.errorOccurred !== false ||
            typeof root.documentId !== "string" || !root.documentId || root.documentId === beforeDocumentId) return false;
        committed = sample; return true;
      } catch (error) {
        // The runner's generic until swallows predicate errors. Return its stop
        // signal and rethrow the exact original error outside, without rereads.
        originalError = error; return true;
      }
    }, "counted destination commit on the original tab", remaining()), remaining(), "counted navigation commit observation");
    if (originalError) throw originalError;
    remaining(); assert.ok(committed, "Counted navigation did not commit before observation ended");
    record.complete = true; record.completedAt = now(); record.documentId = committed.frames.find(frame => frame.frameId === 0).documentId;
    return committed;
  } catch (error) { record.failedAt = now(); record.error = errorText(error); throw error; }
  finally { stopped = true; }
}

export async function checkCountedPointerDelivery({ browser, worker, fixtureURL, server, until, detail = {} }) {
  Object.assign(detail, { passed: false, cases: [], cleanupErrors: [], boundary: "Four single public counted actions on fresh pages. Only the OOPIF modifier case deliberately suppresses the first root move with a synthetic ACK; all other native calls retain their original Promise. DOM trust is evidence of page delivery, not CDP authentication. Navigation uses the public 150ms inter-click delay. Observed navigation must reject the remaining click; destination commitment is independently verified within the original deadline." });
  try {
    for (const spec of countedPointerCases) {
      const id = randomUUID(), key = `pointer-counted-${id.replaceAll("-", "")}-${spec.name}`, item = { id, key, spec, passed: false }; detail.cases.push(item);
      const tab = await browser.newTab(); item.tabId = tab.id;
      const url = new URL(`${countedRoute}page`, fixtureURL); url.search = new URLSearchParams({ key }).toString(); item.url = url.href;
      const targetURL = new URL(url); if (spec.layout !== "root") targetURL.pathname = `${countedRoute}frame`; if (spec.layout === "oopif") targetURL.hostname = "localhost"; item.targetURL = targetURL.href;
      await browser.cdp.navigate(tab.id, item.url);
      const locator = (spec.layout === "root" ? tab : tab.frameLocator("#counted-frame")).getByRole(spec.navigation ? "link" : "button", { name: spec.navigation ? "Continue counted receipt" : "Counted receipt", exact: true });
      // Establish the original document identity without attaching another CDP
      // client or performing input. This read does not certify click-time routing.
      item.frameReadSamples = []; const frameDeadline = Date.now() + 5000;
      await until(async () => {
        const remaining = frameDeadline - Date.now(); if (remaining <= 0) throw Error("Counted initial frame metadata deadline expired");
        const frames = await bounded(worker.evaluate(`chrome.webNavigation.getAllFrames({tabId:${tab.id}})`), remaining, "counted initial frame metadata");
        if (item.frameReadSamples.length >= 80) throw Error("Counted initial frame metadata exceeded sample bound");
        item.frameReadSamples.push({ at: Date.now(), frames });
        if (Date.now() >= frameDeadline) throw Error("Counted initial frame metadata completed after deadline");
        const roots = frames?.filter(frame => frame.frameId === 0 && frame.url === item.url && frame.documentLifecycle === "active" && frame.errorOccurred === false && frame.documentId) ?? [];
        const children = spec.layout === "root" ? [] : frames?.filter(frame => frame.parentFrameId === 0 && frame.url === item.targetURL && frame.documentLifecycle === "active" && frame.errorOccurred === false && frame.documentId) ?? [];
        if (roots.length !== 1 || spec.layout !== "root" && children.length !== 1) return false;
        if (spec.layout === "oopif") assert.notEqual(roots[0].processId, children[0].processId, "The original navigation/click target must be a real OOPIF");
        item.framesBefore = frames; return true;
      }, "counted original committed frame identities", 5000);
      const beforeRoot = item.framesBefore.filter(frame => frame.frameId === 0 && frame.url === item.url); assert.equal(beforeRoot.length, 1);
      item.scope = chooserScope(browser); let failure, installationAttempted = false;
      try {
        installationAttempted = true; const deadline = Date.now() + 5000;
        item.installation = await bounded(worker.evaluate(`(()=>{if(Date.now()>=${deadline})throw Error('Counted probe setup deadline expired');return (${installCountedPointerProbe.toString()})(chrome,globalThis,${JSON.stringify({ id, tabId: tab.id, mode: spec.gate })})})()`), 5000, "counted probe installation");
        item.options = { timeoutMs: 5000, ...(spec.action === "click" ? { clickCount: spec.count } : {}), ...(spec.modifiers.length ? { modifiers: [...spec.modifiers] } : {}), ...(spec.delay ? { delay: spec.delay } : {}) };
        item.startedAt = Date.now();
        try { await locator[spec.action](item.options); item.completedAt = Date.now(); }
        catch (error) { item.failedAt = Date.now(); item.actionError = errorText(error); if (!spec.navigation) throw error; }
        if (spec.navigation) { assert.equal(item.completedAt, undefined, "Counted action must fail after partial first-click navigation"); assert.match(item.actionError ?? "", /OBU_POINTER_/); }
        const receiptBudget = spec.navigation ? item.startedAt + item.options.timeoutMs - Date.now() : 5000;
        assert.ok(receiptBudget > 0, "Counted navigation receipt exceeded the original action deadline");
        await until(() => server.stats(key).posts.length === 1 && server.stats(key).posts[0].receipt && (!spec.navigation || server.stats(key).gets.some(value => value.path === `${countedRoute}destination`)), "counted pointer original business receipt", receiptBudget);
        if (spec.navigation) {
          const destinationURL = new URL(targetURL); destinationURL.pathname = `${countedRoute}destination`;
          item.commitObservation = {};
          await waitForCountedNavigationCommit({ tabId: tab.id, url: destinationURL.href, beforeDocumentId: beforeRoot[0].documentId,
            deadlineAt: item.startedAt + item.options.timeoutMs, record: item.commitObservation, until,
            read: () => worker.evaluate(`(${readCountedNavigationState.toString()})(chrome,${tab.id},${item.startedAt + item.options.timeoutMs})`) });
        }
      } catch (error) { failure = error; item.error = errorText(error); }
      finally {
        if (installationAttempted) try { item.probe = await bounded(worker.evaluate(`(()=>{const p=globalThis.__obuCountedPointer;if(!p)return null;if(p.id!==${JSON.stringify(id)})throw Error('Counted pointer probe identity changed');return p.restore()})()`), 5000, "counted probe restoration"); }
        catch (error) { item.restoreError = errorText(error); detail.cleanupErrors.push(item.restoreError); failure ??= error; }
      }
      item.server = server.stats(key);
      try {
        assert.deepEqual(chooserScope(browser), item.scope);
        item.native = await worker.evaluate(`(async()=>({tab:await chrome.tabs.get(${tab.id}),frames:await chrome.webNavigation.getAllFrames({tabId:${tab.id}}),targets:await chrome.debugger.getTargets(),attachments:globalThis.__integrationFrames.filter(value=>value.tabId===${tab.id})}))()`);
        assert.equal(item.native.tab.id, tab.id); assert.equal(item.native.tab.active, false);
        const destinationURL = new URL(targetURL); destinationURL.pathname = `${countedRoute}destination`; item.destinationURL = destinationURL.href;
        const rootURL = spec.navigation ? item.destinationURL : item.url;
        assert.equal(item.native.tab.url, rootURL);
        const roots = item.native.frames.filter(frame => frame.frameId === 0 && frame.url === rootURL); assert.equal(roots.length, 1);
        const selected = [...roots];
        if (spec.layout !== "root" && !spec.navigation) {
          const children = item.native.frames.filter(frame => frame.parentFrameId === 0 && frame.url === item.targetURL); assert.equal(children.length, 1); selected.push(children[0]);
          if (spec.layout === "oopif") {
            assert.notEqual(children[0].processId, roots[0].processId, "A real OOPIF is required");
            const targets = item.native.targets.filter(value => value.url === item.targetURL && value.attached); assert.equal(targets.length, 1);
            assert.equal(item.native.attachments.filter(value => value.type === "iframe" && value.targetId === targets[0].id && value.source?.tabId === tab.id && value.source.sessionId === undefined && value.sessionId).length, 1);
          }
        }
        for (const frame of selected) { assert.ok(typeof frame.documentId === "string" && frame.documentId); assert.equal(frame.documentLifecycle, "active"); assert.equal(frame.errorOccurred, false); }
        item.documents = await worker.evaluate(`chrome.scripting.executeScript({target:{tabId:${tab.id},documentIds:${JSON.stringify(selected.map(frame => frame.documentId))}},world:'MAIN',func:()=>({href:location.href,evidence:globalThis.countedPointerEvidence,visibleResult:document.querySelector('#counted-result')?.textContent??null})})`);
        const documents = selected.map(frame => { const values = item.documents.filter(value => value.documentId === frame.documentId && value.frameId === frame.frameId); assert.equal(values.length, 1); assert.equal(values[0].result.href, frame.url); return values[0].result; });
        item.traceProof = checkCountedPointerTrace(item.probe, spec);
        item.documentProof = checkCountedPointerDocuments({ spec, key, targetURL: item.targetURL, documents, server: item.server,
          destination: spec.navigation ? { ...documents[0], beforeDocumentId: beforeRoot[0].documentId, documentId: roots[0].documentId, url: item.destinationURL } : undefined });
      } catch (error) { item.evidenceError = errorText(error); failure ??= error; }
      if (failure) throw failure; item.passed = true;
    }
    detail.server = server.allStats(); detail.passed = true; return detail;
  } catch (error) { detail.error = errorText(error); throw error; }
}
