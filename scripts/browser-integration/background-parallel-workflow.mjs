// Opt-in, finite attached-tab idle/concurrency acceptance. Never disables the
// browser's background policies or changes the independent focus ledger.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { inflateSync } from "node:zlib";

export const BACKGROUND_PARALLEL_MIN_IDLE_MS = 310000;
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const escape = value => String(value).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
const js = value => JSON.stringify(value).replace(/</g, "\\u003c");
const roles = ["root", "same", "cross"];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

// Drain siblings before cleanup, including when the first branch fails.
export async function settleParallelWork(work) {
  const settled = await Promise.allSettled(work);
  const errors = settled.filter(item => item.status === "rejected").map(item => item.reason);
  if (errors.length) throw new AggregateError(errors, "Parallel work failed after all branches settled");
  return settled.map(item => item.value);
}

export function parallelMarkerCode(nonce, sequence) {
  assert.match(nonce, /^[a-f0-9]{8}$/); assert.ok(Number.isSafeInteger(sequence) && sequence >= 0 && sequence <= 0xffffffff);
  return nonce + sequence.toString(16).padStart(8, "0");
}

function palette(nibble) { return [40 + Math.floor(nibble / 4) * 48, 40 + nibble % 4 * 48, 150]; }

// Chromium's ordinary non-interlaced 8-bit RGB/RGBA screenshots. This decoder
// bounds allocation and reverses every PNG row filter before sampling pixels.
export function decodeParallelPNG(bytes) {
  assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  let width, height, channels, ended = false, position = 8; const parts = [];
  while (position + 12 <= bytes.length) {
    const size = bytes.readUInt32BE(position), type = bytes.toString("ascii", position + 4, position + 8);
    assert.ok(position + size + 12 <= bytes.length, "Truncated PNG chunk");
    const body = bytes.subarray(position + 8, position + 8 + size); position += size + 12;
    if (type === "IHDR") {
      assert.equal(width, undefined); assert.equal(size, 13);
      width = body.readUInt32BE(0); height = body.readUInt32BE(4);
      assert.ok(width > 0 && height > 0 && width * height <= 16 * 1024 * 1024);
      assert.equal(body[8], 8); assert.ok([2, 6].includes(body[9])); channels = body[9] === 2 ? 3 : 4;
      assert.equal(body[10], 0); assert.equal(body[11], 0); assert.equal(body[12], 0);
    } else if (type === "IDAT") parts.push(body);
    else if (type === "IEND") { ended = true; break; }
  }
  assert.ok(width && parts.length && ended, "Truncated PNG or missing required chunks"); assert.equal(position, bytes.length);
  const stride = width * channels, raw = inflateSync(Buffer.concat(parts), { maxOutputLength: (stride + 1) * height });
  assert.equal(raw.length, (stride + 1) * height);
  const pixels = Buffer.alloc(stride * height);
  const paeth = (a, b, c) => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]; assert.ok(filter <= 4);
    for (let x = 0; x < stride; x++) {
      const index = y * stride + x, a = x >= channels ? pixels[index - channels] : 0, b = y ? pixels[index - stride] : 0, c = y && x >= channels ? pixels[index - stride - channels] : 0;
      const predictor = [0, a, b, Math.floor((a + b) / 2), paeth(a, b, c)][filter];
      pixels[index] = (raw[y * (stride + 1) + 1 + x] + predictor) & 255;
    }
  }
  return { width, height, pixel(x, y) { assert.ok(Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < width && y < height); const i = (y * width + x) * channels; return [...pixels.subarray(i, i + 3)]; } };
}

// playwright-crx 0.15.0 Screenshotter.screenshotElement adds main-frame scroll
// to the post-scroll bounding box, then Helper.enclosingIntRect encloses CSS
// pixels before Chromium applies DPR. Fractional origins can add a CSS pixel.
export function parallelElementClip(box) {
  for (const field of ["x", "y", "width", "height"]) assert.ok(Number.isFinite(box[field]));
  const x = Math.floor(box.x + 1e-3), y = Math.floor(box.y + 1e-3);
  return { x, y, width: Math.ceil(box.x + box.width - 1e-3) - x, height: Math.ceil(box.y + box.height - 1e-3) - y, scale: 1 };
}

export function checkParallelPixels(bytes, { nonce, sequence, box, dpr, element = false, documentBox, nativeClip }) {
  const png = decodeParallelPNG(bytes), code = parallelMarkerCode(nonce, sequence), samples = [];
  assert.ok(dpr > 0 && Number.isFinite(dpr)); assert.equal(box.width, 240); assert.equal(box.height, 60);
  let origin = box;
  if (element) {
    assert.ok(documentBox && nativeClip, "Element evidence requires actual native clip and post-scroll document box");
    assert.equal(documentBox.width, box.width); assert.equal(documentBox.height, box.height);
    assert.deepEqual(nativeClip, parallelElementClip(documentBox), "Native clip differs from enclosing post-scroll document box");
    assert.equal(png.width, Math.round(nativeClip.width * dpr)); assert.equal(png.height, Math.round(nativeClip.height * dpr));
    origin = { x: documentBox.x - nativeClip.x, y: documentBox.y - nativeClip.y };
  }
  for (let i = 0; i < code.length; i++) {
    const x = Math.floor((origin.x + (i % 8) * 30 + 15) * dpr);
    const y = Math.floor((origin.y + Math.floor(i / 8) * 30 + 15) * dpr);
    const rgb = png.pixel(x, y), expected = palette(parseInt(code[i], 16));
    assert.deepEqual(rgb, expected, `Wrong document/sequence pixel at marker cell ${i}`);
    samples.push({ x, y, rgb });
  }
  return { width: png.width, height: png.height, bytes: bytes.length, sha256: hash(bytes), nonce, sequence, code, samples };
}

export function createBackgroundParallelFixture({ onChange = () => {} } = {}) {
  const records = new Map();
  const reply = (response, status, body, type = "text/html; charset=utf-8") => { response.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" }); response.end(body); };
  function page(record, role, port) {
    const doc = record.documents[role], base = `/background-parallel/${record.key}`;
    const frames = role === "root" ? `<div class="gap"></div><iframe title="同源记录" src="${base}/frame/same"></iframe><div class="gap"></div><iframe title="跨源记录" src="http://localhost:${port}${base}/frame/cross"></iframe>` : "";
    return `<!doctype html><html><head><meta charset="utf-8"><title>后台记录 ${escape(record.key)} ${role}</title><style>body{margin:16px;font:16px system-ui;background:#f3f6f9}#marker{display:grid;grid-template-columns:repeat(8,30px);grid-template-rows:repeat(2,30px);width:240px;height:60px;margin:12px 0}#marker span{width:30px;height:30px}input,button{font:inherit;padding:8px}input{width:480px;max-width:80%}output{display:block;white-space:pre-wrap;overflow-wrap:anywhere}iframe{display:block;width:700px;height:360px;border:0}.gap{height:900px}</style></head><body><h1>后台资料记录 · ${role}</h1>
      <div id="marker" aria-label="文档与版本色块"></div><form id="record"><label>本页记录 <input aria-label="本页记录" id="text" autocomplete="off" required></label><button id="save">保存记录</button></form><output id="state" data-sequence="${doc.sequence}"></output>${frames}<script>
      const nonce=${js(doc.nonce)},documentRole=${js(role)};let state=${js({ nonce: doc.nonce, document: role, sequence: doc.sequence, text: doc.text })},lastClick;
      function paint(){const code=nonce+state.sequence.toString(16).padStart(8,'0');document.getElementById('marker').replaceChildren(...Array.from(code,n=>{const value=parseInt(n,16),cell=document.createElement('span');cell.style.background='rgb('+(40+Math.floor(value/4)*48)+','+(40+value%4*48)+',150)';return cell;}));const output=document.getElementById('state');output.textContent=JSON.stringify(state);output.dataset.sequence=String(state.sequence);}
      document.getElementById('save').addEventListener('click',event=>{lastClick={type:'click',trusted:event.isTrusted,at:Date.now()};});
      document.getElementById('record').addEventListener('submit',async event=>{event.preventDefault();const button=document.getElementById('save');if(button.disabled)return;button.disabled=true;
        try{const response=await fetch(${js(`${base}/save/${role}`)},{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({nonce,document:documentRole,sequence:state.sequence+1,text:document.getElementById('text').value,click:lastClick,submit:{trusted:event.isTrusted,at:Date.now()}})});const result=await response.json();if(!response.ok)throw new Error(result.error);state=result;paint();}catch(error){document.getElementById('state').textContent='ERROR '+error.message;}finally{button.disabled=false;}});paint();</script></body></html>`;
  }
  return {
    handle(request, response, port) {
      const url = new URL(request.url, `http://${request.headers.host}`), match = /^\/background-parallel\/([A-Za-z0-9_-]{1,100})(?:\/(frame|save)\/(root|same|cross))?$/.exec(url.pathname);
      if (!match) return false;
      const [, key, action, role = "root"] = match;
      if (!records.has(key)) {
        if (action || request.method !== "GET" || records.size >= 64) { reply(response, 404, "Unknown task"); return true; }
        records.set(key, { key, createdAt: Date.now(), documents: Object.fromEntries(roles.map(name => [name, { nonce: hash(randomUUID()).slice(0, 8), sequence: 0, text: "" }])), requests: [], posts: [], overflow: false });
      }
      const record = records.get(key);
      if (record.requests.length >= 512) { record.overflow = true; onChange(); reply(response, 429, "Evidence limit"); return true; }
      record.requests.push({ method: request.method, url: url.href, at: Date.now(), role }); onChange();
      if (request.method === "GET" && action !== "save") { reply(response, 200, page(record, role, port)); return true; }
      if (request.method !== "POST" || action !== "save") { reply(response, 405, "Method not allowed"); return true; }
      let size = 0, chunks = [], exceeded = false;
      request.on("data", chunk => { size += chunk.length; if (size > 16384) exceeded = true; else if (!exceeded) chunks.push(chunk); });
      request.on("end", () => {
        const send = (status, value) => reply(response, status, JSON.stringify(value), "application/json; charset=utf-8");
        if (exceeded) { send(413, { error: "Record too large" }); return; }
        const bytes = Buffer.concat(chunks), raw = bytes.toString("utf8"), entry = { role, at: Date.now(), raw, base64: bytes.toString("base64"), bytes: bytes.length, sha256: hash(bytes), status: 400 };
        record.posts.push(entry);
        try {
          let payload; try { payload = JSON.parse(raw); } catch { send(400, { error: "Malformed record" }); return; }
          const doc = record.documents[role];
          if (payload.nonce !== doc.nonce || payload.document !== role || payload.sequence !== doc.sequence + 1 || typeof payload.text !== "string" || payload.text.length < 1 || payload.text.length > 2048 ||
              payload.click?.trusted !== true || payload.submit?.trusted !== true) { entry.status = 422; send(422, { error: "Wrong document, sequence, text or action" }); return; }
          doc.sequence = payload.sequence; doc.text = payload.text; entry.status = 200;
          send(200, { nonce: doc.nonce, document: role, sequence: doc.sequence, text: doc.text });
        } finally { onChange(); }
      });
      request.on("error", () => { if (!response.writableEnded) reply(response, 400, "Read failed"); });
      return true;
    },
    stats: key => structuredClone(records.get(key) ?? null), allStats: () => structuredClone([...records.values()])
  };
}

// Staged-only observation: forwards the original native command exactly once,
// preserving the result/error. No backend state is read or rewritten.
export function installBackgroundParallelProbe(chrome, target) {
  if (target.__obuBackgroundParallelProbe) throw new Error("Parallel probe already installed");
  const tracked = new Map(), commands = [], events = [], frames = new Map(), observerErrors = []; let overflow = false, sequence = 0;
  const original = chrome.debugger.sendCommand;
  const append = (list, value) => { value.index ??= sequence++; if (list.length < 16000) list.push(value); else overflow = true; };
  const selected = new Set(["Page.enable", "Page.startScreencast", "Page.stopScreencast", "Page.captureScreenshot", "Page.screencastFrameAck"]);
  function wrapper(...args) {
    const [source, method] = args, owner = tracked.get(source?.tabId); if (!owner) return Reflect.apply(original, chrome.debugger, args);
    owner.pending++; owner.commands++; owner.lastCommandAt = Date.now();
    const record = selected.has(method) ? { index: sequence++, tabId: source.tabId, owner: owner.owner, sessionId: source.sessionId ?? null, method, at: Date.now() } : null;
    if (record && method === "Page.screencastFrameAck") record.frameSessionId = args[2]?.sessionId;
    if (record && method === "Page.captureScreenshot") record.clip = args[2]?.clip ? { ...args[2].clip } : null;
    if (record) append(commands, record);
    if (method === "Page.screencastFrameAck") owner.acks++;
    const done = (ok, error) => { owner.pending--; owner.lastSettledAt = Date.now(); if (record) { record.settledAt = owner.lastSettledAt; record.ok = ok; if (!ok) record.error = String(error); } };
    try {
      const result = Reflect.apply(original, chrome.debugger, args);
      if (result?.then) {
        // Observe a side chain; the caller receives the exact native promise.
        result.then(() => done(true), error => done(false, error)).catch(error => { observerErrors.push(String(error)); });
        return result;
      }
      done(true); return result;
    } catch (error) { done(false, error); throw error; }
  }
  const onEvent = (source, method, params) => {
    const owner = tracked.get(source.tabId); if (!owner) return;
    if (method === "Page.screencastFrame" && source.sessionId == null) {
      const state = frames.get(source.tabId) ?? { count: 0, firstAt: Date.now() }; state.count++; state.lastAt = Date.now(); frames.set(source.tabId, state);
      append(events, { type: "frame", tabId: source.tabId, owner: owner.owner, sourceSessionId: source.sessionId ?? null, frameSessionId: params.sessionId, at: Date.now(), metadata: params.metadata, encodedBytes: typeof params.data === "string" ? params.data.length : null });
    } else if (method === "Target.attachedToTarget" && params.targetInfo?.type === "iframe") {
      append(events, { type: "iframe", at: Date.now(), tabId: source.tabId, owner: owner.owner, sourceSessionId: source.sessionId ?? null, sessionId: params.sessionId, targetId: params.targetInfo.targetId, url: params.targetInfo.url });
    }
  };
  const onDetach = (source, reason) => { if (tracked.has(source.tabId)) append(events, { type: "detach", tabId: source.tabId, reason, at: Date.now() }); };
  const onRemoved = tabId => { if (tracked.has(tabId)) append(events, { type: "removed", tabId, at: Date.now() }); };
  chrome.debugger.sendCommand = wrapper; chrome.debugger.onEvent.addListener(onEvent); chrome.debugger.onDetach.addListener(onDetach); chrome.tabs.onRemoved.addListener(onRemoved);
  const snapshot = () => structuredClone({ at: Date.now(), overflow, observerErrors, commands, events, tabs: [...tracked].map(([tabId, value]) => ({ tabId, ...value, frames: frames.get(tabId) ?? { count: 0 } })) });
  target.__obuBackgroundParallelProbe = {
    track(tabId, owner, scope) { if (tracked.has(tabId)) throw new Error("Tab already tracked"); tracked.set(tabId, { owner, scope, pending: 0, commands: 0, acks: 0, lastCommandAt: null, lastSettledAt: null }); },
    snapshot,
    restore() {
      if (chrome.debugger.sendCommand !== wrapper) throw new Error("Native command observer changed during test");
      chrome.debugger.sendCommand = original; chrome.debugger.onEvent.removeListener(onEvent); chrome.debugger.onDetach.removeListener(onDetach); chrome.tabs.onRemoved.removeListener(onRemoved);
      const result = snapshot(); delete target.__obuBackgroundParallelProbe; return result;
    }
  };
}

export function checkParallelNativeEvidence(probe, { tabIds, minOverlap = true } = {}) {
  assert.equal(probe.overflow, false); assert.deepEqual(probe.observerErrors, []); assert.ok(probe.tabs.every(tab => tab.pending === 0), "Native commands still pending");
  const intervals = [], open = new Map();
  for (const command of probe.commands) {
    assert.equal(command.ok, true, `Native ${command.method} failed or did not settle`);
    assert.ok(command.settledAt >= command.at);
    if (command.method === "Page.startScreencast") {
      assert.ok(!open.has(command.tabId), "Overlapping internal streams on one tab"); open.set(command.tabId, command);
    } else if (command.method === "Page.stopScreencast") {
      const start = open.get(command.tabId); assert.ok(start, "Stream stopped without a recorded start");
      assert.ok(command.at >= start.settledAt);
      const frames = probe.events.filter(event => event.type === "frame" && event.tabId === command.tabId && event.index > start.index && event.index < command.index);
      assert.ok(frames.length, "No actual frame observed during rendering interval");
      for (const frame of frames) assert.ok(probe.commands.some(ack => ack.method === "Page.screencastFrameAck" && ack.tabId === frame.tabId && ack.frameSessionId === frame.frameSessionId && ack.index > frame.index && ack.index < command.index && ack.ok), "Native rendering frame was not acknowledged");
      intervals.push({ tabId: command.tabId, owner: start.owner, requestedAt: start.at, from: start.settledAt, to: command.at, stoppedAt: command.settledAt, frameCount: frames.length }); open.delete(command.tabId);
    }
  }
  assert.equal(open.size, 0, "Native stream was not stopped");
  const overlaps = [];
  for (let i = 0; i < intervals.length; i++) for (let j = i + 1; j < intervals.length; j++) {
    const a = intervals[i], b = intervals[j], from = Math.max(a.from, b.from), to = Math.min(a.to, b.to);
    if (a.owner !== b.owner && a.tabId !== b.tabId && from < to) overlaps.push({ first: i, second: j, from, to, milliseconds: to - from });
  }
  if (minOverlap) assert.ok(overlaps.length > 0, "No actual rendering intervals overlapped across owners");
  if (tabIds) for (const tabId of tabIds) {
    const tab = probe.tabs.find(item => item.tabId === tabId); assert.ok(tab && tab.frames.count > 0 && tab.acks > 0);
    assert.ok(probe.events.some(event => event.type === "iframe" && event.tabId === tabId && typeof event.sessionId === "string" && typeof event.targetId === "string"), `Tab ${tabId} had no native iframe target attachment`);
    assert.ok(probe.events.some(event => event.type === "removed" && event.tabId === tabId), `Tab ${tabId} was not actually closed`);
  }
  return { intervals, overlaps, starts: intervals.length, stops: intervals.length };
}

export async function checkBackgroundParallelWorkflow({ connectOpenBrowserUse, endpoint, fixtureURL, fixture, worker,
  idleMs = BACKGROUND_PARALLEL_MIN_IDLE_MS, cadenceMs = 10000, saveScreenshot, onCheckpoint = async () => {} }) {
  assert.ok(Number.isSafeInteger(idleMs) && idleMs >= BACKGROUND_PARALLEL_MIN_IDLE_MS && idleMs <= 600000, "Formal idle interval must be 310000..600000ms");
  assert.ok(Number.isSafeInteger(cadenceMs) && cadenceMs >= 1000 && cadenceMs <= 15000);
  assert.equal(typeof saveScreenshot, "function");
  const runKey = `parallel-${randomUUID()}`, detail = { version: 1, runKey, idleMs, cadenceMs, startedAt: Date.now(), owners: [], operations: [], captures: [], rounds: [], createdTabIds: [], closedTabIds: [], failures: [] };
  let installed = false, failure, monotonicStart, idleOwners;
  const checkpoint = async phase => { detail.phase = phase; await onCheckpoint(structuredClone(detail)); };
  const command = async (owner, tabId, action, work) => {
    const entry = { index: detail.operations.length, owner: owner.name, sessionId: owner.sessionId, turnId: owner.browser.client.turnId, controlEpoch: owner.browser.client.controlEpoch, tabId, action, at: Date.now() };
    detail.operations.push(entry);
    try { const result = await work(); entry.ok = true; return result; } catch (error) { entry.error = String(error); throw error; } finally { entry.completedAt = Date.now(); }
  };
  const probe = () => worker.evaluate("globalThis.__obuBackgroundParallelProbe.snapshot()");
  const scope = owner => ({ session_id: owner.sessionId, turn_id: owner.browser.client.turnId, control_epoch: owner.browser.client.controlEpoch });
  const browserState = () => worker.evaluate(`Promise.all([chrome.tabs.query({}),chrome.debugger.getTargets()]).then(([tabs,targets])=>({at:Date.now(),tabs:tabs.map(({id,url,windowId,groupId,pinned,active})=>({id,url,windowId,groupId,pinned,active})).sort((a,b)=>a.id-b.id),targets:targets.map(({id,tabId,type,url,attached})=>({id,tabId,type,url,attached}))}))`);
  async function screenshot(owner, item, label, { role = "root", element = false, firstResume = false } = {}) {
    const root = role === "root" ? item.tab : item.tab.frameLocator(`iframe[title="${role === "same" ? "同源记录" : "跨源记录"}"]`);
    const marker = root.locator("#marker"), known = item.states[role];
    let box;
    if (firstResume) box = item.initialBox;
    else {
      if (!element) await command(owner, item.id, "root-marker-scroll", () => marker.scrollIntoViewIfNeeded());
      box = await command(owner, item.id, `${role}-marker-box`, () => marker.boundingBox());
    }
    assert.ok(box);
    const previousCapture = element ? await worker.evaluate(`globalThis.__obuBackgroundParallelProbe.snapshot().commands.filter(c=>c.tabId===${item.id}&&c.method==='Page.captureScreenshot').at(-1)?.index??-1`) : null;
    const result = await command(owner, item.id, `${firstResume ? "first-resume-" : ""}${role}-${element ? "element" : "viewport"}-screenshot`, () => element ? marker.screenshot({ timeoutMs: 12000 }) : item.tab.screenshot({ timeoutMs: 12000 }));
    assert.equal(result.mimeType, "image/png"); const bytes = Buffer.from(result.base64, "base64");
    const name = `background-${runKey}-${owner.name}-${item.generation}-${item.slot}-${label}.png`;
    const capture = { filename: name, owner: owner.name, tabId: item.id, role, label, firstResume, box, dpr: item.metrics.dpr, element, nonce: known.nonce, sequence: known.sequence, bytes: bytes.length, sha256: hash(bytes), saved: false };
    detail.captures.push(capture);
    try {
      const saved = await saveScreenshot(name, bytes); assert.ok(saved && typeof saved.filename === "string");
      capture.filename = saved.filename; capture.saved = true;
      if (element) {
        capture.boxAfterScreenshot = await command(owner, item.id, `${role}-post-screenshot-box`, () => marker.boundingBox());
        capture.scrollAfterScreenshot = await command(owner, item.id, "post-element-screenshot-scroll", () => item.tab.evaluate("({x:scrollX,y:scrollY,dpr:devicePixelRatio})"));
        assert.ok(capture.boxAfterScreenshot); assert.equal(capture.scrollAfterScreenshot.dpr, item.metrics.dpr);
        capture.documentBox = { ...capture.boxAfterScreenshot, x: capture.boxAfterScreenshot.x + capture.scrollAfterScreenshot.x, y: capture.boxAfterScreenshot.y + capture.scrollAfterScreenshot.y };
        const nativeCaptures = await worker.evaluate(`globalThis.__obuBackgroundParallelProbe.snapshot().commands.filter(c=>c.tabId===${item.id}&&c.method==='Page.captureScreenshot'&&c.index>${previousCapture})`);
        assert.equal(nativeCaptures.length, 1); assert.equal(nativeCaptures[0].ok, true);
        capture.nativeCaptureIndex = nativeCaptures[0].index; capture.nativeClip = nativeCaptures[0].clip;
      }
      Object.assign(capture, checkParallelPixels(bytes, capture), { pixelsPassed: true });
    }
    catch (error) { if (error.savedScreenshot) { capture.savedScreenshot = error.savedScreenshot; capture.saved = true; } capture.pixelsPassed = false; capture.error = String(error); throw error; }
  }
  async function setup(owner) {
    owner.tabs = [];
    await command(owner, null, "beginTurn", () => owner.browser.client.beginTurn()); owner.scopes.push(scope(owner));
    for (let slot = 0; slot < 2; slot++) {
      const key = `${runKey}-${owner.name}-${owner.generation}-${slot}`;
      const tab = await command(owner, null, "newTab", () => owner.browser.newTab());
      detail.createdTabIds.push(tab.id); owner.createdTabIds.push(tab.id);
      await worker.evaluate(`globalThis.__obuBackgroundParallelProbe.track(${tab.id},${js(owner.name)},${js(scope(owner))})`);
      const item = { id: tab.id, tab, key, slot, generation: owner.generation, states: {} }; owner.tabs.push(item);
      await command(owner, tab.id, "goto", () => tab.goto(new URL(`/background-parallel/${key}`, fixtureURL).href, { timeoutMs: 15000 }));
      item.metrics = await command(owner, tab.id, "read-rendering-metrics", () => tab.evaluate("({dpr:devicePixelRatio,width:innerWidth,height:innerHeight,visibility:document.visibilityState})"));
      for (const role of roles) {
        const root = role === "root" ? tab : tab.frameLocator(`iframe[title="${role === "same" ? "同源记录" : "跨源记录"}"]`);
        item.states[role] = JSON.parse(await command(owner, tab.id, `read-initial-${role}`, () => root.locator("#state").textContent()));
        assert.equal(item.states[role].sequence, 0); assert.equal(item.states[role].document, role);
      }
      await screenshot(owner, item, "baseline");
      item.initialBox = await command(owner, tab.id, "baseline-marker-box", () => tab.locator("#marker").boundingBox());
      owner.pages.push({ key, tabId: tab.id, generation: item.generation, slot, metrics: item.metrics, initialStates: structuredClone(item.states), initialBox: item.initialBox });
    }
  }
  async function cycle(owner, round) {
    await settleParallelWork(owner.tabs.map(async item => {
      const update = async role => {
        const root = role === "root" ? item.tab : item.tab.frameLocator(`iframe[title="${role === "same" ? "同源记录" : "跨源记录"}"]`);
        const before = item.states[role], text = `${item.key}/${role}/round-${round}/${randomUUID()}`;
        await command(owner, item.id, `${role}-fill`, () => root.getByRole("textbox", { name: "本页记录", exact: true }).fill(text));
        await command(owner, item.id, `${role}-click`, () => root.getByRole("button", { name: "保存记录", exact: true }).click({ timeoutMs: 10000 }));
        await command(owner, item.id, `${role}-wait-receipt`, () => root.locator(`#state[data-sequence="${before.sequence + 1}"]`).waitFor({ state: "visible", timeoutMs: 10000 }));
        const actual = JSON.parse(await command(owner, item.id, `${role}-read-receipt`, () => root.locator("#state").textContent()));
        assert.deepEqual(actual, { nonce: before.nonce, document: role, sequence: before.sequence + 1, text }); item.states[role] = actual;
        detail.updates ??= []; detail.updates.push({ owner: owner.name, key: item.key, tabId: item.id, ...actual });
      };
      await update("root"); await screenshot(owner, item, `round-${round}`);
      if (round % 3 === 0) { const role = round % 2 === 0 ? "cross" : "same"; await update(role); await screenshot(owner, item, `round-${round}-${role}`, { role, element: true }); }
    }));
  }
  async function finalize(owner, phase) {
    const endedScope = scope(owner), ids = owner.tabs.map(item => item.id);
    const scopeKey = JSON.stringify(endedScope); assert.ok(!owner.endAttempts.has(scopeKey), "Never repeat an uncertain finalize"); owner.endAttempts.add(scopeKey);
    const attempt = { phase, scope: endedScope, tabIds: ids, at: Date.now(), ok: false }; owner.ends.push(attempt);
    await command(owner, null, `finalize-${phase}`, () => owner.browser.client.finalizeTabs([]));
    detail.closedTabIds.push(...ids); attempt.ok = true; attempt.completedAt = Date.now(); owner.tabs = [];
  }
  try {
    await worker.evaluate(`(${installBackgroundParallelProbe.toString()})(chrome,globalThis)`); installed = true;
    detail.browserBefore = await browserState();
    for (const name of ["idle", "steady", "renewal"]) {
      const sessionId = `${runKey}-${name}`, browser = await connectOpenBrowserUse({ socketPath: endpoint, sessionId, timeoutMs: 20000 });
      const owner = { name, sessionId, browser, generation: 0, tabs: [], scopes: [], pages: [], ends: [], endAttempts: new Set(), createdTabIds: [] };
      idleOwners ??= []; idleOwners.push(owner);
      detail.owners.push({ name, sessionId, scopes: owner.scopes, pages: owner.pages, ends: owner.ends, createdTabIds: owner.createdTabIds });
      await setup(owner);
    }
    const [idle, steady, renewal] = idleOwners;
    detail.browserAfterSetup = await browserState();
    const groups = idleOwners.map(owner => {
      const ids = new Set(owner.tabs.map(item => item.id)), tabs = detail.browserAfterSetup.tabs.filter(tab => ids.has(tab.id));
      assert.equal(tabs.length, 2); assert.ok(tabs.every(tab => tab.groupId >= 0 && !tab.active)); assert.equal(new Set(tabs.map(tab => tab.groupId)).size, 1);
      return tabs[0].groupId;
    });
    assert.equal(new Set(groups).size, 3, "Independent owners must have independent tab groups");
    // Setup all owners first. Do not inspect an idle Page through SDK/CDP during
    // the measured interval; the worker observer itself only reads its own log.
    const warm = await probe();
    const idleTabs = new Set(idle.tabs.map(item => item.id));
    assert.ok(warm.tabs.filter(tab => idleTabs.has(tab.tabId)).every(tab => tab.pending === 0));
    detail.idle = { tabIds: [...idleTabs], warmNative: warm.tabs.filter(tab => idleTabs.has(tab.tabId)), lastSDKCompletedAt: Math.max(...detail.operations.filter(op => idleTabs.has(op.tabId)).map(op => op.completedAt)), startedAt: Date.now() };
    monotonicStart = performance.now(); await checkpoint("quiet-start");
    let round = 0, renewed = false;
    while (performance.now() - monotonicStart < idleMs) {
      const startedAt = Date.now(), elapsed = performance.now() - monotonicStart;
      if (!renewed && elapsed >= idleMs / 2) {
        detail.renewal = { startedAt, oldScope: scope(renewal), steadyScope: scope(steady) };
        await settleParallelWork([cycle(steady, round), (async () => { await finalize(renewal, "midpoint"); renewal.generation++; await setup(renewal); })()]);
        detail.renewal.completedAt = Date.now(); detail.renewal.newScope = scope(renewal); assert.ok(detail.renewal.newScope.control_epoch > detail.renewal.oldScope.control_epoch); renewed = true;
        const ended = renewal.ends.find(end => end.phase === "midpoint");
        detail.renewal.steadyOverlappingOperations = detail.operations.filter(op => op.owner === steady.name && op.ok && op.at < ended.completedAt && op.completedAt > ended.at).map(op => op.index);
        assert.ok(detail.renewal.steadyOverlappingOperations.length, "No steady operation overlapped the other owner's finalization");
        assert.deepEqual(scope(steady), detail.renewal.steadyScope);
        detail.renewal.browser = await browserState();
      } else await settleParallelWork([cycle(steady, round), cycle(renewal, round)]);
      detail.rounds.push({ round, startedAt, completedAt: Date.now(), elapsedMs: performance.now() - monotonicStart });
      round++; await checkpoint("quiet-round");
      const remaining = Math.min(cadenceMs - (Date.now() - startedAt), idleMs - (performance.now() - monotonicStart)); if (remaining > 0) await pause(remaining);
    }
    assert.ok(renewed && detail.rounds.length >= 10, "Insufficient sustained parallel rounds");
    detail.idle.beforeResume = await probe(); detail.idle.elapsedMs = performance.now() - monotonicStart;
    assert.ok(detail.idle.elapsedMs >= idleMs);
    for (const before of detail.idle.warmNative) {
      const now = detail.idle.beforeResume.tabs.find(tab => tab.tabId === before.tabId);
      assert.equal(now.commands, before.commands, "Idle tab received a native command during its quiet interval");
    }
    detail.idle.resumeRequestedAt = Date.now();
    await settleParallelWork(idle.tabs.map(item => screenshot(idle, item, "first-resume", { firstResume: true })));
    detail.idle.resumeCompletedAt = Date.now();
    for (const item of idle.tabs) {
      const state = JSON.parse(await command(idle, item.id, "post-resume-state", () => item.tab.locator("#state").textContent())); assert.deepEqual(state, item.states.root);
      item.afterIdleMetrics = await command(idle, item.id, "post-resume-metrics", () => item.tab.evaluate("({dpr:devicePixelRatio,width:innerWidth,height:innerHeight,visibility:document.visibilityState})"));
      detail.idle.afterMetrics ??= []; detail.idle.afterMetrics.push({ tabId: item.id, ...item.afterIdleMetrics });
    }
    await settleParallelWork([cycle(idle, round), cycle(steady, round), cycle(renewal, round)]);
    assert.deepEqual(scope(steady), detail.renewal.steadyScope);
    assert.deepEqual(scope(idle), idle.scopes[0]);
    detail.renewal.steadyLaterOperations = detail.operations.filter(op => op.owner === steady.name && op.ok && op.at > detail.renewal.completedAt).map(op => op.index);
    assert.ok(detail.renewal.steadyLaterOperations.length, "Steady owner did not continue after the other owner's renewal");
    await settleParallelWork(idleOwners.map(owner => finalize(owner, "final")));
    const removalDeadline = performance.now() + 10000;
    do {
      detail.browserAfter = await browserState(); detail.native = await probe();
      const removed = new Set(detail.native.events.filter(event => event.type === "removed").map(event => event.tabId));
      if (detail.createdTabIds.every(id => removed.has(id)) && detail.native.tabs.every(tab => tab.pending === 0) &&
          detail.browserAfter.tabs.every(tab => !detail.createdTabIds.includes(tab.id)) &&
          detail.browserAfter.targets.every(target => !detail.createdTabIds.includes(target.tabId) && !target.url?.includes(`/background-parallel/${runKey}`))) break;
      assert.ok(performance.now() < removalDeadline, "Owned tabs/native targets did not settle after finalization"); await pause(100);
    } while (true);
    assert.deepEqual(detail.browserAfter.tabs, detail.browserBefore.tabs, "Original tabs changed during concurrent workflow");
    detail.rendering = checkParallelNativeEvidence(detail.native, { tabIds: detail.createdTabIds });
    const allRecords = detail.owners.flatMap(owner => owner.pages).map(page => fixture.stats(page.key)); detail.server = allRecords;
    for (const record of allRecords) {
      assert.ok(record && !record.overflow); const expected = (detail.updates ?? []).filter(update => update.key === record.key);
      assert.equal(record.posts.length, expected.length, "Wrong number of actual writes (no action replay)");
      for (const role of roles) {
        const writes = expected.filter(update => update.document === role);
        const posts = record.posts.filter(post => post.role === role);
        assert.equal(posts.length, writes.length);
        for (let i = 0; i < posts.length; i++) {
          const post = posts[i], payload = JSON.parse(post.raw), update = writes[i]; assert.equal(post.status, 200);
          assert.equal(hash(Buffer.from(post.base64, "base64")), post.sha256); assert.equal(Buffer.byteLength(post.raw), post.bytes);
          assert.equal(payload.nonce, update.nonce); assert.equal(payload.sequence, i + 1); assert.equal(payload.text, update.text); assert.equal(payload.document, role);
          assert.equal(payload.click.trusted, true); assert.equal(payload.submit.trusted, true);
        }
      }
    }
    detail.passed = true;
  } catch (error) { failure = error; detail.failed = true; detail.error = error.stack ?? String(error); }
  finally {
    for (const owner of idleOwners ?? []) {
      if (owner.tabs.length && !owner.endAttempts.has(JSON.stringify(scope(owner)))) { try { await finalize(owner, "cleanup"); } catch (error) { detail.failures.push({ stage: "cleanup", owner: owner.name, error: String(error) }); failure = failure ? new AggregateError([failure, error]) : error; } }
      try { owner.browser.close(); } catch (error) { detail.failures.push({ stage: "client-close", owner: owner.name, error: String(error) }); failure = failure ? new AggregateError([failure, error]) : error; }
    }
    if (installed) {
      try { detail.finalProbe = await worker.evaluate("globalThis.__obuBackgroundParallelProbe.restore()"); detail.probeRestored = true; if (!failure) checkParallelNativeEvidence(detail.finalProbe, { tabIds: detail.createdTabIds }); }
      catch (error) { detail.failures.push({ stage: "probe-restore", error: String(error) }); failure = failure ? new AggregateError([failure, error]) : error; }
    }
    detail.server ??= detail.owners.flatMap(owner => owner.pages).map(page => fixture.stats(page.key)); detail.completedAt = Date.now();
    if (failure) { detail.passed = false; detail.failed = true; detail.error = failure.stack ?? String(failure); }
    try { await checkpoint("complete"); } catch (error) { failure = failure ? new AggregateError([failure, error]) : error; detail.passed = false; detail.failed = true; detail.error = failure.stack ?? String(failure); }
  }
  if (failure) { failure.backgroundParallel = detail; throw failure; }
  return detail;
}
