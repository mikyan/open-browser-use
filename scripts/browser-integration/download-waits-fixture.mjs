import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const downloadVariants = ["root", "oopif", "dynamic-oopif"];
export const downloadExpired = /OBU_DOWNLOAD_WAIT_EXPIRED|OBU_DOWNLOAD_WAIT_INVALID|OBU_TRANSFER_CANCELLED|OBU_AUTOMATION_PAUSED|OBU_STALE_CONTROL_EPOCH|OBU_CONTROL_BOOTSTRAP_REQUIRED|not part of browser session/i;
export const downloadTimeout = /OBU_DOWNLOAD_WAIT_TIMEOUT|OBU_TRANSFER_TIMEOUT|deadline|timed out|timeout/i;
export const downloadScope = browser => ({ session_id: browser.client.sessionId, turn_id: browser.client.turnId, control_epoch: browser.client.controlEpoch });
export const downloadPageURL = (base, key, variant = "root") => base + "download-waits/page?" + new URLSearchParams({ key, variant });
const hash = bytes => createHash("sha256").update(bytes).digest("hex");

export function downloadPageHTML(url, port) {
  const key = url.searchParams.get("key"), variant = url.searchParams.get("variant");
  assert.match(key, /^[a-z0-9-]{1,100}$/); assert.ok(downloadVariants.includes(variant));
  const root = url.pathname.endsWith("/page"), child = `http://localhost:${port}/download-waits/frame?` + new URLSearchParams({ key, variant });
  return `<!doctype html><meta charset="utf-8"><title>Page download ready fixture</title>
    <style>body{font:16px sans-serif}a,button{display:block;padding:16px;margin:15px}iframe{width:620px;height:260px}</style>
    ${!root || variant === "root" ? '<a id="download" href="#" download>Download fixture</a><output id="evidence"></output>' : ""}
    ${root && variant === "oopif" ? `<iframe id="download-frame" src="${child}"></iframe>` : ""}
    ${root && variant === "dynamic-oopif" ? '<button id="add-frame">Add download frame</button>' : ""}
    <script>
      const key=${JSON.stringify(key)},variant=${JSON.stringify(variant)};
      globalThis.downloadEvidence={documentToken:crypto.randomUUID(),clicks:[],frameAdds:[]};
      const link=document.querySelector('#download'),add=document.querySelector('#add-frame');
      if(add)add.onclick=event=>{downloadEvidence.frameAdds.push({trusted:event.isTrusted});const frame=document.createElement('iframe');frame.id='download-frame';frame.src=${JSON.stringify(child)};document.body.append(frame);add.disabled=true};
      if(link)link.onclick=event=>{const sequence=downloadEvidence.clicks.length+1;downloadEvidence.clicks.push({trusted:event.isTrusted,sequence});link.href='/download-waits/file?'+new URLSearchParams({key,variant,sequence});document.querySelector('#evidence').textContent=JSON.stringify(downloadEvidence)};
    </script>`;
}

// Hold only a real HTTP response suffix. The native download and its progress
// continue independently of observation handles; no download API is substituted.
export function createDownloadWaitFixtures() {
  const records = new Map(), held = new Set(), gates = new Map();
  const entry = key => { if (!records.has(key)) records.set(key, { key, requests: [] }); return records.get(key); };
  return {
    stats: key => structuredClone(entry(key)), allStats: () => [...records.values()].map(value => structuredClone(value)),
    hold(key) { held.add(key); },
    release(key) { held.delete(key); for (const [response, gate] of gates) if (gate.key === key) { gates.delete(response); gate.finish(); } },
    close() { for (const response of gates.keys()) response.destroy(); gates.clear(); },
    handle(request, response, port) {
      const url = new URL(request.url, "http://127.0.0.1");
      if (!url.pathname.startsWith("/download-waits/")) return false;
      const key = url.searchParams.get("key"), variant = url.searchParams.get("variant");
      if (!/^[a-z0-9-]{1,100}$/.test(key ?? "") || !downloadVariants.includes(variant)) { response.writeHead(400); response.end(); return true; }
      response.setHeader("Cache-Control", "no-store");
      if (["/download-waits/page", "/download-waits/frame"].includes(url.pathname)) {
        response.setHeader("Content-Type", "text/html; charset=utf-8"); response.end(downloadPageHTML(url, port)); return true;
      }
      if (url.pathname !== "/download-waits/file" || request.method !== "GET") { response.writeHead(404); response.end(); return true; }
      const record = entry(key), sequence = Number(url.searchParams.get("sequence")), nonce = randomUUID();
      const heading = Buffer.from(JSON.stringify({ key, sequence, nonce }) + "\n中文 page bytes\n");
      const bytes = Buffer.concat([heading, Buffer.alloc(4096 - heading.length, 0xa5), Buffer.from([0, 255, 10])]);
      const hit = { at: Date.now(), key, variant, sequence, nonce, method: request.method, url: request.url, bytes: bytes.length, sha256: hash(bytes), base64: bytes.toString("base64"), sentPrefixBytes: 4096, finished: false, closed: false };
      record.requests.push(hit);
      response.on("close", () => { hit.closed = true; gates.delete(response); });
      response.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Disposition": 'attachment; filename="page-download.bin"', "Content-Length": bytes.length });
      response.write(bytes.subarray(0, 4096));
      const finish = () => { if (!response.destroyed) { hit.finished = true; hit.finishedAt = Date.now(); response.end(bytes.subarray(4096)); } };
      if (held.has(key)) gates.set(response, { key, finish }); else finish();
      return true;
    }
  };
}

export function installDownloadTrace(chrome, target, maxEvents = 512) {
  if (target.__downloadReadyTrace) throw new Error("Download trace already installed");
  const trace = { startedAt: Date.now(), events: [], overflow: false, guids: new Set() };
  trace.listener = (source, method, params) => {
    if (method === "Page.downloadWillBegin" && typeof params.url === "string" && params.url.includes("/download-waits/file?")) trace.guids.add(params.guid);
    if (!["Page.downloadWillBegin", "Page.downloadProgress"].includes(method) || !trace.guids.has(params.guid)) return;
    if (trace.events.length >= maxEvents) { trace.overflow = true; return; }
    trace.events.push({ sequence: trace.events.length, at: Date.now(), monotonicMs: performance.now(), source: structuredClone(source), method, params: structuredClone(params) });
  };
  target.__downloadReadyTrace = trace; chrome.debugger.onEvent.addListener(trace.listener);
}

export const readDownloadTrace = worker => worker.evaluate("({startedAt:__downloadReadyTrace.startedAt,events:__downloadReadyTrace.events,overflow:__downloadReadyTrace.overflow})");
export async function downloadFrameEvidence(worker, item) {
  const value = await worker.evaluate(`(async()=>({frames:await chrome.webNavigation.getAllFrames({tabId:${item.tabId}}),targets:await chrome.debugger.getTargets(),attachedTargets:globalThis.__integrationFrames.filter(target=>target.tabId===${item.tabId})}))()`);
  item.frames = value;
  if (item.variant !== "root") {
    const root = value.frames.find(frame => frame.frameId === 0), child = value.frames.find(frame => frame.parentFrameId === 0 && frame.url.includes(`/download-waits/frame?key=${item.key}&`));
    assert.ok(root && child, "Cross-origin download child missing"); assert.notEqual(child.processId, root.processId, "Download child is not out of process");
    const attachment = value.attachedTargets.find(target => target.type === "iframe" && target.sessionId && target.targetId === item.nativeGUID.params.frameId);
    assert.ok(attachment, "Native download frame is not this tab's actual OOPIF attachment");
    assert.ok(value.targets.some(target => target.id === attachment.targetId && target.url === child.url), "Native target URL does not identify the fixture child document");
    if (item.nativeGUID.source.sessionId !== undefined) assert.equal(item.nativeGUID.source.sessionId, attachment.sessionId, "Native download source is a different child session");
  }
  return value;
}

// File content is an independent harness witness, never a public GUID→path join.
// Suggested filenames deliberately collide. Match the complete response bytes,
// including the server-generated nonce, in the isolated directory's new files.
export async function verifyDownloadFiles(root, before, requests, until) {
  assert.equal(new Set(requests.map(hit => hit.sha256)).size, requests.length);
  return until(async () => {
    const names = (await fs.readdir(root)).filter(name => !before.includes(name));
    const completed = names.filter(name => !name.endsWith(".crdownload"));
    if (completed.length !== requests.length || completed.length !== names.length) return null;
    const files = [];
    for (const name of completed) {
      const filename = path.join(root, name), stat = await fs.stat(filename);
      if (!stat.isFile() || stat.size > 16384) throw new Error("Unexpected file in isolated download delta");
      const bytes = await fs.readFile(filename), sha256 = hash(bytes), expected = requests.find(hit => hit.sha256 === sha256);
      assert.ok(expected, "New file is not an exact fixture response"); assert.deepEqual(bytes, Buffer.from(expected.base64, "base64"));
      assert.equal(expected.finished, true); assert.equal(expected.method, "GET");
      files.push({ path: filename, bytes: bytes.length, sha256, key: expected.key, sequence: expected.sequence, nonce: expected.nonce });
    }
    assert.equal(new Set(files.map(file => file.sha256)).size, requests.length, "Duplicate file content replaced a missing response");
    return files;
  }, "all original page response bytes reached isolated download files", 15000);
}

export async function startDownloadEvidence({ worker, owner, server, downloadRoot, until }) {
  const before = await fs.readdir(downloadRoot), existing = new Set(server.allStats().flatMap(value => value.requests.map(hit => hit.nonce))), notifications = [];
  let notificationOverflow = false;
  const unsubscribe = owner.client.onNotification(event => { if (event.method === "onDownloadChange") { if (notifications.length === 512) notificationOverflow = true; else notifications.push(structuredClone(event.params)); } });
  const monitorAssociation = { method: "getTabs", startedAt: Date.now() };
  try {
    // onNotification only registers a local callback. The real host associates
    // this otherwise idle monitor connection after a request with session_id.
    // Await a public read-only scoped ACK before any separate caller can trigger.
    monitorAssociation.tabs = await owner.client.getTabs();
    monitorAssociation.scope = downloadScope(owner); monitorAssociation.completedAt = Date.now();
    assert.ok(Number.isSafeInteger(monitorAssociation.scope.control_epoch) && monitorAssociation.scope.control_epoch > 0);
    await worker.evaluate(`(${installDownloadTrace.toString()})(chrome,globalThis)`);
  } catch (error) { unsubscribe(); error.downloadDetail = { monitorAssociation }; throw error; }
  return async (detail, verify = true) => {
    try {
      detail.monitorAssociation = monitorAssociation;
      const requests = server.allStats().flatMap(value => value.requests).filter(hit => !existing.has(hit.nonce));
      detail.serverRequests = requests;
      detail.fileEvidenceBoundary = "Harness directory delta matched by complete server response bytes/nonce; no public GUID-to-path mapping or inferred filename/URL ownership.";
      if (verify) detail.files = await verifyDownloadFiles(downloadRoot, before, requests, until);
      detail.nativeTrace = await readDownloadTrace(worker); detail.notifications = notifications;
      assert.equal(detail.nativeTrace.overflow, false); assert.equal(notificationOverflow, false, "Download notification ledger overflow");
      if (verify) for (const item of [...(detail.variants ?? []), ...(detail.downloads ?? [])]) {
        const id = item.result?.downloadId ?? item.downloadId;
        const begin = detail.nativeTrace.events.filter(event => event.method === "Page.downloadWillBegin" && event.params.guid === id);
        assert.equal(begin.length, 1, "Collected id must be exactly one actual Page GUID"); assert.equal(begin[0].source.tabId, item.tabId);
        assert.equal(typeof begin[0].params.frameId, "string"); if (item.readyAt) assert.ok(begin[0].at >= item.readyAt);
        const ledger = item.scope.session_id === owner.client.sessionId ? notifications : (detail.foreignNotifications ?? []);
        await until(() => ledger.some(event => event.id === id && event.status === "complete"), "scoped Page download completed");
        for (const event of ledger.filter(value => value.id === id)) {
          assert.equal(event.tabId, item.tabId);
          for (const field of ["session_id", "turn_id", "control_epoch"]) assert.equal(event[field], item.scope[field]);
        }
        item.nativeGUID = begin[0];
        if (item.variant) { item.frames = await downloadFrameEvidence(worker, item); assert.equal(requests.filter(hit => hit.key === item.key).length, 1, "Trigger replayed a native request"); }
      }
    } finally {
      // Preserve original events on failure as well; never clear an active ledger.
      unsubscribe();
      detail.notifications = notifications; detail.notificationOverflow = notificationOverflow;
      try { detail.nativeTrace = await readDownloadTrace(worker); assert.equal(detail.nativeTrace.overflow, false); }
      finally { await worker.evaluate("(()=>{chrome.debugger.onEvent.removeListener(__downloadReadyTrace.listener);delete globalThis.__downloadReadyTrace})()"); }
    }
  };
}

export async function checkDownloadReady({ owner, trigger, fixtureURL, prefix, diagnostic }) {
  assert.equal((await owner.client.getInfo()).metadata.downloadWaitVersion, 1);
  const detail = { caller: "js", independentConnections: true, variants: [] };
  try {
    for (const variant of downloadVariants) {
      const key = `${prefix}-${variant}`, tab = await owner.newTab();
      await owner.cdp.navigate(tab.id, downloadPageURL(fixtureURL, key, variant));
      const sender = trigger.tab(tab.id), target = variant === "root" ? sender : sender.frameLocator("#download-frame");
      const item = { key, variant, tabId: tab.id, scope: downloadScope(owner) }; detail.variants.push(item);
      let wait, failure, phase;
      const begin = name => { if (diagnostic) { item.stages ??= []; phase = { name, startedAt: Date.now() }; item.stages.push(phase); } };
      const complete = () => { if (phase) { phase.completedAt = Date.now(); phase = null; } };
      try {
        if (diagnostic) await diagnostic.start({ owner, item });
        begin("arm"); wait = await tab.expectDownload({ timeoutMs: 10000 });
        Object.assign(item, { waiterId: wait.waiterId, remainingMs: wait.remainingMs, readyAt: Date.now() }); complete();
        if (variant === "dynamic-oopif") { begin("add-frame"); await sender.getByRole("button", { name: "Add download frame", exact: true }).click(); complete(); }
        begin("click");
        item.triggerSubmittedAt = Date.now(); await target.getByRole("link", { name: "Download fixture", exact: true }).click({ timeoutMs: 5000 });
        complete(); begin("collect");
        const download = await wait.result(); item.result = { downloadId: download.downloadId }; item.collectedAt = Date.now();
        complete(); begin("verify");
        await assert.rejects(download.path({ timeoutMs: 1000 }), /OBU_DOWNLOAD_PATH_UNAVAILABLE/);
        item.page = JSON.parse(await target.locator("#evidence").textContent()); assert.deepEqual(item.page.clicks, [{ trusted: true, sequence: 1 }]);
        if (variant === "dynamic-oopif") { item.frameAdds = await tab.evaluate("downloadEvidence.frameAdds"); assert.deepEqual(item.frameAdds, [{ trusted: true }]); }
        assert.deepEqual(downloadScope(trigger), item.scope);
        complete();
      } catch (error) {
        failure = error;
        if (phase) { phase.failedAt = Date.now(); phase.error = String(error); phase = null; }
        if (diagnostic) try { await diagnostic.failure({ owner, item }); } catch (observationError) { item.diagnosticFailureError = String(observationError); }
      } finally {
        if (wait) {
          begin("cancel");
          try { await wait.cancel(); complete(); }
          catch (error) {
            item.cancelError = String(error); failure ??= error;
            if (phase) { phase.failedAt = Date.now(); phase.error = String(error); phase = null; }
          }
        }
        if (diagnostic) try { await diagnostic.finish({ item }); } catch (observationError) { item.diagnosticFinishError = String(observationError); }
        if (diagnostic && item.cancelError && item.diagnostic) item.diagnostic.collectionComplete = false;
      }
      if (failure) throw failure;
    }
    return detail;
  } catch (error) { error.downloadDetail = detail; throw error; }
}

export async function checkDownloadLifecycle({ owner, trigger, foreign, fixtureURL, server, worker, until }) {
  const detail = { negatives: [], downloads: [], foreignNotifications: [], ownedNotifications: [] }, key = "js-page-download-lifecycle", tab = await owner.newTab();
  const unsubscribeForeign = foreign.client.onNotification(event => { if (event.method === "onDownloadChange") detail.foreignNotifications.push(structuredClone(event.params)); });
  const unsubscribeOwner = owner.client.onNotification(event => { if (event.method === "onDownloadChange") detail.ownedNotifications.push(structuredClone(event.params)); });
  const remember = (kind, download, browser = owner, target = tab) => detail.downloads.push({ kind, downloadId: download.downloadId, scope: downloadScope(browser), tabId: target.id });
  try {
  await owner.cdp.navigate(tab.id, downloadPageURL(fixtureURL, key)); await tab.domSnapshot();
  const click = () => trigger.tab(tab.id).getByRole("link", { name: "Download fixture", exact: true }).click();
  const expired = await tab.expectDownload({ timeoutMs: 250 }), originalDeadline = Date.now() + expired.remainingMs;
  await trigger.cdp.navigate(tab.id, downloadPageURL(fixtureURL, key) + "&revision=2");
  await new Promise(resolve => setTimeout(resolve, Math.max(0, originalDeadline + 50 - Date.now())));
  await assert.rejects(expired.result(), downloadTimeout); await expired.cancel();
  await assert.rejects(owner.client.request("collectDownloadWait", { tabId: tab.id, waiterId: expired.waiterId }), /OBU_DOWNLOAD_WAIT_TIMEOUT|OBU_DOWNLOAD_WAIT_EXPIRED/);
  detail.negatives.push({ kind: "original-deadline-across-navigation", originalDeadline, observedAt: Date.now() });

  const navigated = await tab.expectDownload({ timeoutMs: 10000 });
  await trigger.cdp.navigate(tab.id, downloadPageURL(fixtureURL, key) + "&revision=3"); await click();
  remember("pending-survives-navigation", await navigated.result()); await navigated.cancel();
  const historical = await tab.expectDownload({ timeoutMs: 250 }); await assert.rejects(historical.result(), downloadTimeout); await historical.cancel();
  detail.negatives.push({ kind: "historical-begin-and-progress-do-not-match" });

  const held = await tab.expectDownload({ timeoutMs: 10000 }), scope = downloadScope(owner);
  await assert.rejects(trigger.tab(tab.id).expectDownload({ timeoutMs: 10000 }), /OBU_DOWNLOAD_WAIT_LIMIT/);
  await assert.rejects(foreign.client.request("collectDownloadWait", { tabId: tab.id, waiterId: held.waiterId }), downloadExpired);
  await assert.rejects(owner.client.request("collectDownloadWait", { ...scope, turn_id: "foreign-download-turn", tabId: tab.id, waiterId: held.waiterId }), downloadExpired);
  try { detail.foreignCancel = await foreign.client.request("cancelDownloadWait", { tabId: tab.id, waiterId: held.waiterId }); }
  catch (error) { assert.match(error.message, downloadExpired); detail.foreignCancel = { error: error.message }; }
  const params = { ...scope, tabId: tab.id, waiterId: held.waiterId };
  const outcomes = [owner, trigger].map((connection, index) => connection.client.request("collectDownloadWait", params).then(result => ({ index, result }), error => ({ index, error: error.message })));
  let timer;
  try { detail.collectConflict = await Promise.race([...outcomes.map(pending => pending.then(value => { assert.match(value.error ?? "", /OBU_DOWNLOAD_WAIT_CONFLICT/); return value; })), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("No admitted concurrent collect conflict before click")), 5000); })]); }
  finally { clearTimeout(timer); }
  await click(); detail.collectOutcomes = await Promise.all(outcomes);
  assert.equal(detail.collectOutcomes.filter(value => value.result).length, 1); assert.equal(detail.collectOutcomes.filter(value => /OBU_DOWNLOAD_WAIT_CONFLICT/.test(value.error ?? "")).length, 1);
  remember("duplicate-arm-foreign-cancel-concurrent-collect", detail.collectOutcomes.find(value => value.result).result); await held.cancel();

  const first = await tab.expectDownload({ timeoutMs: 5000 }), beforeRace = (await readDownloadTrace(worker)).events.length;
  await click(); await click();
  const begins = await until(async () => { const events = (await readDownloadTrace(worker)).events.slice(beforeRace).filter(event => event.method === "Page.downloadWillBegin" && event.source.tabId === tab.id); return events.length >= 2 ? events : null; }, "two actual native download starts before collect evidence");
  const firstResult = await first.result(); await first.cancel();
  assert.equal(begins.length, 2); assert.equal(firstResult.downloadId, begins[0].params.guid); assert.notEqual(firstResult.downloadId, begins[1].params.guid);
  remember("first-event-wins-two-real-clicks-before-collect", firstResult); detail.firstEventRace = begins;
  const noHistory = await tab.expectDownload({ timeoutMs: 250 }); await assert.rejects(noHistory.result(), downloadTimeout); await noHistory.cancel();

  const isolated = await tab.expectDownload({ timeoutMs: 10000 }), otherTab = await foreign.newTab();
  await foreign.cdp.navigate(otherTab.id, downloadPageURL(fixtureURL, "js-page-download-foreign"));
  const otherWait = await otherTab.expectDownload({ timeoutMs: 5000 });
  await otherTab.getByRole("link", { name: "Download fixture", exact: true }).click();
  const otherResult = await otherWait.result(); await otherWait.cancel(); remember("foreign-tab-source", otherResult, foreign, otherTab);
  await click(); const ownResult = await isolated.result(); await isolated.cancel(); remember("exact-source-after-foreign-event", ownResult);
  assert.notEqual(ownResult.downloadId, otherResult.downloadId);
  await assert.rejects(owner.client.downloadPath(otherResult.downloadId), /Unknown or unowned download id/);
  await until(() => detail.foreignNotifications.some(event => event.id === otherResult.downloadId && event.status === "complete"), "foreign source's own completion notification");
  assert.ok(detail.foreignNotifications.every(event => event.id !== ownResult.downloadId));
  assert.ok(detail.ownedNotifications.every(event => event.id !== otherResult.downloadId));

  server.hold(key);
  const cancelled = await tab.expectDownload({ timeoutMs: 5000 }), before = (await readDownloadTrace(worker)).events.length;
  await click();
  const matched = await until(async () => (await readDownloadTrace(worker)).events.slice(before).find(event => event.method === "Page.downloadWillBegin" && event.source.tabId === tab.id), "matched uncollected native download");
  await cancelled.cancel(); await cancelled.cancel(); await assert.rejects(cancelled.result(), downloadExpired);
  await assert.rejects(owner.client.request("collectDownloadWait", { tabId: tab.id, waiterId: cancelled.waiterId }), /OBU_DOWNLOAD_WAIT_EXPIRED/);
  const next = await tab.expectDownload({ timeoutMs: 5000 });
  server.release(key);
  await until(() => server.stats(key).requests.at(-1)?.finished, "cancel observer did not cancel native response");
  await until(async () => (await readDownloadTrace(worker)).events.some(event => event.method === "Page.downloadProgress" && event.params.guid === matched.params.guid && event.params.state === "completed"), "old native transfer completed while successor waited");
  await click(); const fresh = await next.result(); await next.cancel();
  assert.notEqual(fresh.downloadId, matched.params.guid); remember("cancel-observer-only", fresh); detail.cancelledNativeGUID = matched.params.guid;

  await until(() => detail.downloads.filter(item => item.scope.session_id === owner.client.sessionId).every(item => detail.ownedNotifications.some(event => event.id === item.downloadId && event.status === "complete")), "old scope's started downloads complete before ending its turn");

  const ended = await tab.expectDownload({ timeoutMs: 5000 }), oldScope = downloadScope(owner);
  await owner.client.turnEnded(); await assert.rejects(ended.result(), downloadExpired);
  await owner.client.beginTurn(); await trigger.client.beginTurn();
  await assert.rejects(owner.client.request("collectDownloadWait", { ...oldScope, tabId: tab.id, waiterId: ended.waiterId }), downloadExpired);
  const moved = await tab.expectDownload({ timeoutMs: 5000 });
  await worker.evaluate(`chrome.tabs.ungroup(${tab.id})`); await foreign.client.claimUserTab(tab.id);
  await assert.rejects(moved.result(), downloadExpired);
  const replacement = foreign.tab(tab.id), ready = await replacement.expectDownload({ timeoutMs: 5000 });
  await replacement.getByRole("link", { name: "Download fixture", exact: true }).click();
  remember("explicit-successor", await ready.result(), foreign); await ready.cancel();
  detail.negatives.push({ kind: "end-old-epoch-move-explicit-claim" });
  detail.page = await replacement.evaluate("downloadEvidence");
  assert.deepEqual(detail.page.clicks, Array.from({ length: 8 }, (_, index) => ({ trusted: true, sequence: index + 1 })));
  assert.equal(server.stats(key).requests.length, 8, "Cancellation or lifecycle replayed a page download click");
  await until(() => detail.downloads.filter(item => item.scope.session_id === foreign.client.sessionId).every(item => detail.foreignNotifications.some(event => event.id === item.downloadId && event.status === "complete")), "successor's own native completion notifications");
  return detail;
  } catch (error) { error.downloadDetail = detail; throw error; }
  finally { unsubscribeForeign(); unsubscribeOwner(); }
}
