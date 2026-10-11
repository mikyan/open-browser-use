import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const chooserVariants = ["root", "oopif", "dynamic-oopif"];
export const chooserExpired = /OBU_FILE_CHOOSER_WAIT_EXPIRED|OBU_TRANSFER_CANCELLED|OBU_AUTOMATION_PAUSED|OBU_STALE_CONTROL_EPOCH|OBU_CONTROL_BOOTSTRAP_REQUIRED|not part of browser session/i;
export const chooserPageURL = (base, key, variant) => base + "chooser-waits/page?" + new URLSearchParams({ key, variant });
export const chooserScope = browser => ({ session_id: browser.client.sessionId, turn_id: browser.client.turnId, control_epoch: browser.client.controlEpoch });
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

// Runs only in the isolated worker's diagnostic Runtime.evaluate context.
// Preserve native payloads and delivery order without wrapping backend methods.
export function installChooserTrace(chrome, target, tabId, maxEvents = 256) {
  if (target.__chooserReadyTrace) throw new Error("Chooser trace already installed");
  const methods = new Set(["Page.frameAttached", "Page.frameNavigated", "Page.frameDetached", "Page.documentOpened", "Target.attachedToTarget", "Target.detachedFromTarget", "Page.fileChooserOpened"]);
  const trace = { tabId, startedAt: Date.now(), events: [], overflow: false };
  trace.listener = (source, method, params) => {
    if (source.tabId !== tabId || !methods.has(method)) return;
    if (trace.events.length >= maxEvents) { trace.overflow = true; return; }
    trace.events.push({ sequence: trace.events.length, at: Date.now(), monotonicMs: performance.now(), source: structuredClone(source), method, params: structuredClone(params) });
  };
  target.__chooserReadyTrace = trace; chrome.debugger.onEvent.addListener(trace.listener);
}

export function chooserPageHTML(url, port) {
  const key = url.searchParams.get("key"), variant = url.searchParams.get("variant");
  assert.match(key, /^[a-z0-9-]{1,100}$/); assert.ok(chooserVariants.includes(variant));
  const root = url.pathname.endsWith("/page"), childURL = `http://localhost:${port}/chooser-waits/frame?` + new URLSearchParams({ key, variant });
  const upload = !root || variant === "root";
  return `<!doctype html><meta charset="utf-8"><title>Chooser ready fixture</title>
    <style>body{font:16px sans-serif}button,input{padding:12px;margin:15px}iframe{width:600px;height:260px}</style>
    ${upload ? `<label>Upload fixture<input type="file" id="upload" ${variant === "root" ? "" : "multiple"}></label><output id="receipt"></output>` : ""}
    ${root && variant === "oopif" ? `<iframe id="upload-frame" src="${childURL}"></iframe>` : ""}
    ${root && variant === "dynamic-oopif" ? '<button id="add-frame">Add upload frame</button>' : ""}
    <script>
      const key=${JSON.stringify(key)},variant=${JSON.stringify(variant)};
      globalThis.chooserEvidence={documentToken:crypto.randomUUID(),clicks:[],changes:[],frameAdds:[]};
      const input=document.querySelector('#upload'),add=document.querySelector('#add-frame');
      if(add)add.onclick=event=>{chooserEvidence.frameAdds.push({trusted:event.isTrusted});const frame=document.createElement('iframe');frame.id='upload-frame';frame.src=${JSON.stringify(childURL)};document.body.append(frame);add.disabled=true};
      if(input){input.onclick=event=>chooserEvidence.clicks.push({trusted:event.isTrusted});input.onchange=async event=>{
        const sequence=chooserEvidence.changes.length+1;
        chooserEvidence.changes.push({trusted:event.isTrusted,count:input.files.length});
        const files=await Promise.all([...input.files].map(async file=>{const bytes=new Uint8Array(await file.arrayBuffer());let raw='';for(const byte of bytes)raw+=String.fromCharCode(byte);return{name:file.name,size:file.size,type:file.type,base64:btoa(raw)}}));
        const response=await fetch('/chooser-waits/upload?'+new URLSearchParams({key,variant}),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key,variant,sequence,files,documentToken:chooserEvidence.documentToken,clicks:[...chooserEvidence.clicks],changes:[...chooserEvidence.changes],href:location.href})});
        const receipt=await response.json();if(!response.ok)throw new Error(JSON.stringify(receipt));document.querySelector('#receipt').textContent=JSON.stringify(receipt);
      }}
    </script>`;
}

export function createChooserWaitFixtures() {
  const records = new Map();
  const entry = key => { if (!records.has(key)) records.set(key, { key, posts: [] }); return records.get(key); };
  return {
    stats: key => structuredClone(entry(key)),
    allStats: () => [...records.values()].map(value => structuredClone(value)),
    handle(request, response, port) {
      const url = new URL(request.url, "http://127.0.0.1");
      if (!url.pathname.startsWith("/chooser-waits/")) return false;
      const key = url.searchParams.get("key"), variant = url.searchParams.get("variant");
      if (!/^[a-z0-9-]{1,100}$/.test(key ?? "") || !chooserVariants.includes(variant)) { response.writeHead(400); response.end("invalid fixture key/variant"); return true; }
      if (["/chooser-waits/page", "/chooser-waits/frame"].includes(url.pathname)) {
        response.setHeader("Content-Type", "text/html; charset=utf-8"); response.setHeader("Cache-Control", "no-store"); response.end(chooserPageHTML(url, port)); return true;
      }
      if (url.pathname !== "/chooser-waits/upload" || request.method !== "POST") { response.writeHead(404); response.end(); return true; }
      const record = entry(key), hit = { at: Date.now(), method: request.method, variant }; record.posts.push(hit);
      const chunks = []; let length = 0;
      request.on("data", chunk => { length += chunk.length; if (length <= 256 * 1024) chunks.push(chunk); });
      request.on("end", () => {
        try {
          assert.ok(length <= 256 * 1024, "fixture upload too large");
          const body = Buffer.concat(chunks), value = JSON.parse(body.toString("utf8"));
          assert.equal(value.key, key); assert.equal(value.variant, variant); assert.ok(Array.isArray(value.files));
          hit.bodyBytes = length; hit.bodyBase64 = body.toString("base64"); hit.bodySHA256 = sha256(body); hit.documentToken = value.documentToken; hit.sequence = value.sequence; hit.clicks = value.clicks; hit.changes = value.changes; hit.href = value.href;
          hit.files = value.files.map(file => {
            const bytes = Buffer.from(file.base64, "base64"); assert.equal(bytes.toString("base64"), file.base64); assert.equal(bytes.length, file.size);
            return { name: file.name, size: bytes.length, sha256: sha256(bytes) };
          });
          hit.receipt = { key, variant, sequence: hit.sequence, documentToken: hit.documentToken, files: hit.files };
          response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(hit.receipt));
        } catch (error) { hit.error = error.message; response.writeHead(400, { "Content-Type": "application/json" }); response.end(JSON.stringify({ error: error.message })); }
      });
      return true;
    }
  };
}

export async function prepareChooserFiles(runDir) {
  const values = [{ name: "chooser-unicode.txt", bytes: Buffer.from("Browser chooser 中文🙂\n") }, { name: "chooser-binary.dat", bytes: Buffer.from([0, 1, 2, 127, 128, 254, 255, 10]) }];
  return Promise.all(values.map(async value => { const filename = path.join(runDir, value.name); await fs.writeFile(filename, value.bytes, { flag: "wx" }); return { path: filename, name: value.name, size: value.bytes.length, sha256: sha256(value.bytes) }; }));
}

export function checkChooserReceipts(record, files, variant, { clickOffset = 0 } = {}) {
  assert.equal(record.posts.length, 2, "Exactly one upload and one clear POST required");
  const expected = (variant === "root" ? files.slice(0, 1) : files).map(({ name, size, sha256 }) => ({ name, size, sha256 }));
  for (const [index, hit] of record.posts.entries()) {
    assert.equal(hit.error, undefined); assert.equal(hit.method, "POST"); assert.equal(hit.variant, variant); assert.equal(hit.sequence, index + 1);
    const body = Buffer.from(hit.bodyBase64, "base64"); assert.equal(body.length, hit.bodyBytes); assert.equal(sha256(body), hit.bodySHA256);
    const original = JSON.parse(body.toString("utf8"));
    assert.deepEqual(original.files.map(file => ({ name: file.name, size: Buffer.from(file.base64, "base64").length, sha256: sha256(Buffer.from(file.base64, "base64")) })), hit.files);
    assert.deepEqual(hit.files, index ? [] : expected);
    assert.deepEqual(hit.clicks, Array.from({ length: index + 1 + clickOffset }, () => ({ trusted: true })));
    // Nonempty native DOM.setFileInputFiles emits trusted change; the existing
    // clear contract dispatches a programmatic change and must stay untrusted.
    assert.deepEqual(hit.changes, [{ trusted: true, count: expected.length }, ...(index ? [{ trusted: false, count: 0 }] : [])]);
    assert.equal(typeof hit.documentToken, "string"); assert.ok(hit.documentToken.length > 0);
    assert.equal(new URL(hit.href).hostname, variant === "root" ? "127.0.0.1" : "localhost");
  }
  assert.equal(record.posts[0].documentToken, record.posts[1].documentToken, "Upload/clear used different documents");
  return record;
}

export async function chooserFrameEvidence(worker, tabId, key, variant) {
  const value = await worker.evaluate(`(async()=>({frames:await chrome.webNavigation.getAllFrames({tabId:${tabId}}),targets:await chrome.debugger.getTargets(),attachedTargets:globalThis.__integrationFrames.filter(target=>target.tabId===${tabId})}))()`);
  const related = value.targets.filter(target => target.url?.includes(`/chooser-waits/frame?key=${key}&`));
  if (variant !== "root") {
    assert.ok(value.frames.some(frame => frame.parentFrameId === 0 && frame.url.includes(`key=${key}&`)), "Cross-origin child is missing");
    assert.ok(value.attachedTargets.some(target => target.type === "iframe" && target.sessionId), "No native OOPIF attachment event observed for this tab");
  }
  return { frames: value.frames, targets: related, attachedTargets: value.attachedTargets };
}

export async function checkChooserReady({ owner, trigger, fixtureURL, server, files, worker, until, prefix }) {
  assert.equal((await owner.client.getInfo()).metadata.fileChooserWaitVersion, 1);
  const detail = { caller: "js", independentConnections: true, variants: [] };
  try {
  for (const variant of chooserVariants) {
    const key = `${prefix}-${variant}`, tab = await owner.newTab();
    await owner.cdp.navigate(tab.id, chooserPageURL(fixtureURL, key, variant));
    const sender = trigger.tab(tab.id), target = variant === "root" ? sender : sender.frameLocator("#upload-frame");
    const item = { key, variant, tabId: tab.id, waits: [] }; detail.variants.push(item);
    await worker.evaluate(`(${installChooserTrace.toString()})(chrome,globalThis,${tab.id})`);
    try {
    for (let sequence = 1; sequence <= 2; sequence++) {
      item.armStartedAt = Date.now();
      const wait = await tab.expectFileChooser({ timeoutMs: 10000 });
      const event = { waiterId: wait.waiterId, remainingMs: wait.remainingMs, armStartedAt: item.armStartedAt, readyAt: Date.now() }; item.waits.push(event);
      assert.ok(wait.waiterId && wait.remainingMs > 0);
      try {
        if (variant === "dynamic-oopif" && sequence === 1) { event.addFrameSubmittedAt = Date.now(); await sender.getByRole("button", { name: "Add upload frame", exact: true }).click(); event.addFrameCompletedAt = Date.now(); }
        event.triggerSubmittedAt = Date.now(); await target.getByLabel("Upload fixture", { exact: true }).click({ timeoutMs: 5000 });
        event.triggerCompletedAt = Date.now(); event.collectSubmittedAt = Date.now();
        event.result = await wait.result(); event.collectedAt = Date.now(); assert.equal(event.result.isMultiple, variant !== "root");
        assert.equal(typeof event.result.fileChooserId, "string");
        await owner.client.setFileChooserFiles(event.result.fileChooserId, sequence === 1 ? (variant === "root" ? files.slice(0, 1) : files).map(file => file.path) : []);
        await until(() => server.stats(key).posts.length === sequence && server.stats(key).posts.at(-1).receipt, "chooser server received selected file bytes");
      } catch (error) { event.error = error.stack; event.failedAt = Date.now(); throw error; }
      finally { event.cancelSubmittedAt = Date.now(); await wait.cancel(); event.cancelCompletedAt = Date.now(); }
    }
    item.scope = chooserScope(owner); assert.deepEqual(chooserScope(trigger), item.scope, "Independent connections did not share the same scope");
    item.server = checkChooserReceipts(server.stats(key), files, variant); item.frames = await chooserFrameEvidence(worker, tab.id, key, variant);
    if (variant === "dynamic-oopif") assert.deepEqual(await tab.evaluate("chooserEvidence.frameAdds"), [{ trusted: true }]);
    assert.notEqual(item.waits[0].result.fileChooserId, item.waits[1].result.fileChooserId, "Old chooser event satisfied the next waiter");
    const historical = await tab.expectFileChooser({ timeoutMs: 250 });
    try { await assert.rejects(historical.result(), /OBU_FILE_CHOOSER_WAIT_TIMEOUT|deadline|timeout|timed out/i); }
    finally { await historical.cancel(); }
    assert.equal(server.stats(key).posts.length, 2, "A historical chooser replayed an upload"); item.historicalEventRejected = true;
    } catch (error) { item.error = error.stack; item.failedAt = Date.now(); throw error; }
    finally {
      item.nativeTrace = await worker.evaluate("(()=>{const trace=globalThis.__chooserReadyTrace;if(!trace)throw new Error('Chooser trace missing');chrome.debugger.onEvent.removeListener(trace.listener);delete globalThis.__chooserReadyTrace;return{tabId:trace.tabId,startedAt:trace.startedAt,completedAt:Date.now(),events:trace.events,overflow:trace.overflow}})()");
      item.serverAtEnd = server.stats(key); assert.equal(item.nativeTrace.overflow, false, "Chooser native trace overflow");
    }
  }
  return detail;
  } catch (error) { error.chooserDetail = detail; throw error; }
}

export async function checkChooserLifecycle({ owner, trigger, foreign, fixtureURL, files, server, worker, until }) {
  const detail = { negatives: [] }, key = "js-chooser-lifecycle", tab = await owner.newTab();
  await owner.cdp.navigate(tab.id, chooserPageURL(fixtureURL, key, "root"));
  await tab.domSnapshot(); // Deadline negatives do not depend on cold engine startup.
  const timeout = await tab.expectFileChooser({ timeoutMs: 250 }), submittedAt = Date.now();
  await new Promise(resolve => setTimeout(resolve, 350));
  await assert.rejects(timeout.result(), /OBU_FILE_CHOOSER_WAIT_TIMEOUT|deadline|timeout|timed out/i); await timeout.cancel();
  await assert.rejects(owner.client.request("collectFileChooserWait", { tabId: tab.id, waiterId: timeout.waiterId }), /OBU_FILE_CHOOSER_WAIT_TIMEOUT|OBU_FILE_CHOOSER_WAIT_EXPIRED/);
  detail.negatives.push({ kind: "original-deadline", elapsedMs: Date.now() - submittedAt });
  const cancelled = await tab.expectFileChooser({ timeoutMs: 5000 }); await cancelled.cancel(); await cancelled.cancel();
  await assert.rejects(cancelled.result(), chooserExpired); detail.negatives.push({ kind: "cancelled" });
  const scoped = await tab.expectFileChooser({ timeoutMs: 5000 }), scope = chooserScope(owner);
  await assert.rejects(foreign.client.request("collectFileChooserWait", { tabId: tab.id, waiterId: scoped.waiterId }), chooserExpired);
  await assert.rejects(owner.client.request("collectFileChooserWait", { ...scope, turn_id: "foreign-chooser-turn", tabId: tab.id, waiterId: scoped.waiterId }), chooserExpired);
  await scoped.cancel(); detail.negatives.push({ kind: "foreign-session-and-turn" });
  const navigated = await tab.expectFileChooser({ timeoutMs: 5000 });
  await trigger.cdp.navigate(tab.id, chooserPageURL(fixtureURL, key, "root") + "&revision=2");
  await assert.rejects(navigated.result(), chooserExpired); await navigated.cancel(); detail.negatives.push({ kind: "navigation" });
  const moved = await tab.expectFileChooser({ timeoutMs: 5000 });
  await worker.evaluate(`chrome.tabs.ungroup(${tab.id})`); await foreign.client.claimUserTab(tab.id);
  await assert.rejects(moved.result(), chooserExpired); detail.negatives.push({ kind: "move-and-claim" });
  // An explicit new owner can arm anew. The exact same page must upload/clear
  // once; old cancelled/expired events may neither deliver nor replay input.
  const replacement = foreign.tab(tab.id), receipts = [];
  for (let sequence = 1; sequence <= 2; sequence++) {
    const wait = await replacement.expectFileChooser({ timeoutMs: 5000 });
    try {
      await replacement.getByLabel("Upload fixture", { exact: true }).click();
      const result = await wait.result(); receipts.push(result);
      await foreign.client.setFileChooserFiles(result.fileChooserId, sequence === 1 ? [files[0].path] : []);
      await until(() => server.stats(key).posts.length === sequence && server.stats(key).posts.at(-1).receipt, "replacement owner file POST");
    } finally { await wait.cancel(); }
  }
  assert.notEqual(receipts[0].fileChooserId, receipts[1].fileChooserId);
  detail.server = checkChooserReceipts(server.stats(key), files, "root"); detail.results = receipts;
  const conflictKey = "js-chooser-conflict", conflictTab = await owner.newTab();
  await owner.cdp.navigate(conflictTab.id, chooserPageURL(fixtureURL, conflictKey, "root"));
  const held = await conflictTab.expectFileChooser({ timeoutMs: 10000 });
  await assert.rejects(trigger.tab(conflictTab.id).expectFileChooser({ timeoutMs: 10000 }), /OBU_FILE_CHOOSER_WAIT_LIMIT/);
  try { detail.foreignCancel = await foreign.client.request("cancelFileChooserWait", { tabId: conflictTab.id, waiterId: held.waiterId }); }
  catch (error) { assert.match(error.message, chooserExpired); detail.foreignCancel = { error: error.message }; }
  const params = { ...chooserScope(owner), tabId: conflictTab.id, waiterId: held.waiterId };
  const outcomes = [owner, trigger].map((connection, index) => connection.client.request("collectFileChooserWait", params).then(result => ({ index, result }), error => ({ index, error: error.message })));
  let timer;
  try {
    // Either connection may arrive first. A real CONFLICT before any click is
    // the acknowledgement that the other collect was already admitted.
    detail.collectConflict = await Promise.race([
      ...outcomes.map(pending => pending.then(value => { assert.match(value.error ?? "", /OBU_FILE_CHOOSER_WAIT_CONFLICT/); return value; })),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("No concurrent collect conflict before trigger")), 5000); })
    ]);
  } finally { clearTimeout(timer); }
  await trigger.tab(conflictTab.id).getByLabel("Upload fixture", { exact: true }).click();
  detail.collectOutcomes = await Promise.all(outcomes);
  const success = detail.collectOutcomes.filter(value => value.result), rejected = detail.collectOutcomes.filter(value => value.error);
  assert.equal(success.length, 1); assert.equal(rejected.length, 1); assert.match(rejected[0].error, /OBU_FILE_CHOOSER_WAIT_CONFLICT/);
  await owner.client.setFileChooserFiles(success[0].result.fileChooserId, [files[0].path]);
  await until(() => server.stats(conflictKey).posts[0]?.receipt, "original waiter survived duplicate arm/foreign cancel/concurrent collect");
  await held.cancel();
  const clear = await conflictTab.expectFileChooser({ timeoutMs: 5000 });
  try {
    await trigger.tab(conflictTab.id).getByLabel("Upload fixture", { exact: true }).click();
    await owner.client.setFileChooserFiles((await clear.result()).fileChooserId, []);
    await until(() => server.stats(conflictKey).posts[1]?.receipt, "concurrent collect fixture cleared once");
  } finally { await clear.cancel(); }
  detail.concurrentServer = checkChooserReceipts(server.stats(conflictKey), files, "root");

  const matchKey = "js-chooser-matched-cancel", matchTab = await owner.newTab();
  await owner.cdp.navigate(matchTab.id, chooserPageURL(fixtureURL, matchKey, "root"));
  await matchTab.domSnapshot();
  const uncollectedDeadline = Date.now() + 2000, uncollected = await matchTab.expectFileChooser({ timeoutMs: 2000 });
  await worker.evaluate(`(()=>{if(globalThis.__chooserOpenedProbe)throw new Error('chooser probe already installed');const probe={events:[],overflow:false};probe.listener=(source,method,params)=>{if(source.tabId===${matchTab.id}&&method==='Page.fileChooserOpened'){if(probe.events.length===20){probe.overflow=true;return}probe.events.push({at:Date.now(),source,method,params})}};globalThis.__chooserOpenedProbe=probe;chrome.debugger.onEvent.addListener(probe.listener)})()`);
  try {
    await trigger.tab(matchTab.id).getByLabel("Upload fixture", { exact: true }).click();
    detail.uncollectedEvents = await until(() => worker.evaluate("__chooserOpenedProbe.events.length?{events:__chooserOpenedProbe.events,overflow:__chooserOpenedProbe.overflow}:null"), "real chooser event before cancellation without collect");
    assert.equal(detail.uncollectedEvents.overflow, false); assert.equal(detail.uncollectedEvents.events.length, 1);
    await uncollected.cancel(); await assert.rejects(uncollected.result(), chooserExpired);
    assert.deepEqual(server.stats(matchKey).posts, [], "Cancelling an uncollected chooser submitted files");
    for (let sequence = 1; sequence <= 2; sequence++) {
      const next = await matchTab.expectFileChooser({ timeoutMs: 5000 });
      try {
        await trigger.tab(matchTab.id).getByLabel("Upload fixture", { exact: true }).click();
        await owner.client.setFileChooserFiles((await next.result()).fileChooserId, sequence === 1 ? [files[0].path] : []);
        await until(() => server.stats(matchKey).posts.length === sequence && server.stats(matchKey).posts.at(-1).receipt, "new wait alone delivered after uncollected cancellation");
      } finally { await next.cancel(); }
    }
    await new Promise(resolve => setTimeout(resolve, Math.max(0, uncollectedDeadline + 250 - Date.now())));
    detail.uncollectedServer = checkChooserReceipts(server.stats(matchKey), files, "root", { clickOffset: 1 });
    const retained = await matchTab.evaluate("chooserEvidence");
    assert.equal(retained.documentToken, detail.uncollectedServer.posts[0].documentToken);
    assert.deepEqual(retained.clicks, [{ trusted: true }, { trusted: true }, { trusted: true }]);
    assert.deepEqual(retained.changes, [{ trusted: true, count: 1 }, { trusted: false, count: 0 }]);
    detail.uncollectedObservation = { originalDeadline: uncollectedDeadline, observedThrough: Date.now(), retained };
  } finally { await worker.evaluate("(()=>{const probe=globalThis.__chooserOpenedProbe;if(probe)chrome.debugger.onEvent.removeListener(probe.listener);delete globalThis.__chooserOpenedProbe})()"); }
  return detail;
}
