import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chooserScope } from "./chooser-waits-fixture.mjs";

const route = "/drag-commit/", sha256 = value => createHash("sha256").update(value).digest("hex"), errorText = error => error?.stack ?? String(error);
export const dragCommitCases = Object.freeze([
  { name: "root-html", layout: "root", mode: "html", outcome: "drop" },
  { name: "oopif-html", layout: "oopif", mode: "html", outcome: "drop" },
  { name: "source-hover-shift", layout: "root", mode: "html", outcome: "drop", change: "source-hover-shift" },
  { name: "enter-cover", layout: "oopif", mode: "html", outcome: "reject", change: "enter-cover" },
  { name: "replace-after-down", layout: "root", mode: "html", outcome: "reject", change: "replace-after-down" },
  { name: "pointer-capture", layout: "root", mode: "pointer", outcome: "pointer" },
  { name: "late-dragover-cover", layout: "root", mode: "html", outcome: "reject", change: "late-dragover-cover" },
  ...[{ name: "explicit-position", outcome: "drop" }, { name: "late-individual-rotate", outcome: "reject", change: "late-individual-rotate" }, { name: "late-border-origin", outcome: "reject", change: "late-border-origin" }].map(value => ({ ...value, layout: "root", mode: "html", hotspot: true, sourcePosition: { x: 24, y: 20 }, targetPosition: { x: 40, y: 30 } }))
].map(Object.freeze));
const keyPattern = new RegExp(`^drag-commit-[a-f0-9]{32}-(${dragCommitCases.map(value => value.name).join("|")})$`);
function specFor(key) { const match = keyPattern.exec(key ?? ""); assert.ok(match, "Invalid drag fixture key"); return dragCommitCases.find(value => value.name === match[1]); }
export function dragCommitURLs(base, key) {
  const spec = specFor(key), root = new URL(`${route}page`, base); root.search = new URLSearchParams({ key });
  const target = new URL(root); if (spec.layout === "oopif") { target.pathname = `${route}frame`; target.hostname = "localhost"; }
  return { root: root.href, target: target.href };
}

// Serialized into the fixture's original page. All mutations are ordinary
// trusted page-event handlers; the observer never dispatches browser input.
export function installDragCommitDocument({ key, spec, role }) {
  const originalDocument = document, source = document.querySelector("#source"), destination = document.querySelector("#destination"), documentToken = crypto.randomUUID();
  const ledger = [], mutations = [], receipts = [], errors = []; let sequence = 0, overflow = false, recordingErrors = 0, pendingReceipts = 0, dragovers = 0, businessDrops = 0, cover, replacement, shifted = false, lastPointerMove;
  const rect = node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
  const identify = node => node ? { id: node.id, token: node.dataset.token ?? null, connected: node.isConnected, sameDocument: node.ownerDocument === originalDocument, rect: rect(node) } : null;
  const append = value => { try { if (ledger.length >= 256) { overflow = true; return; } ledger.push({ sequence: ++sequence, at: performance.timeOrigin + performance.now(), ...value }); } catch { recordingErrors++; } };
  const eventData = event => ({ type: event.type, trusted: event.isTrusted, target: event.target?.id ?? null, targetToken: event.target?.dataset?.token ?? null,
    sourceInPath: source ? event.composedPath().includes(source) : false, destinationInPath: destination ? event.composedPath().includes(destination) : false,
    replacementInPath: replacement ? event.composedPath().includes(replacement) : false, coverInPath: cover ? event.composedPath().includes(cover) : false,
    clientX: Number.isFinite(event.clientX) ? event.clientX : null, clientY: Number.isFinite(event.clientY) ? event.clientY : null,
    buttons: event.buttons ?? null, button: event.button ?? null, pointerId: event.pointerId ?? null, pointerType: event.pointerType ?? null });
  const mutate = (kind, event) => { const value = { kind, event: eventData(event), dragovers, source: identify(source), destination: identify(destination), currentDestination: identify(document.querySelector("#destination")), cover: identify(cover) }; mutations.push(value); append({ kind: "mutation", mutation: value }); };
  const submit = (reason, correct, event, extra = {}) => {
    const receipt = { key, scene: spec.name, role, href: location.href, documentToken, index: receipts.length + 1, reason, correct, event: eventData(event),
      source: identify(source), destination: identify(destination), currentDestination: identify(document.querySelector("#destination")), sourceIsOriginal: source === document.querySelector("#source"), destinationIsOriginal: destination === document.querySelector("#destination"),
      dragovers, mutations: structuredClone(mutations), ledger: structuredClone(ledger), ...extra };
    receipts.push({ receipt, acknowledged: false }); const record = receipts.at(-1); pendingReceipts++;
    fetch("/drag-commit/post?" + new URLSearchParams({ key }), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(receipt) })
      .then(async response => { if (!response.ok) throw Error("Business receipt HTTP " + response.status); const reply = await response.json(); if (reply.key !== key || reply.index !== receipt.index) throw Error("Wrong business receipt ACK"); record.acknowledged = true; })
      .catch(error => { errors.push(String(error)); }).finally(() => { pendingReceipts--; });
  };
  for (const type of ["pointermove", "pointerdown", "pointerup", "pointercancel", "mousedown", "mousemove", "mouseup", "click", "dragstart", "dragenter", "dragover", "drop", "dragend", "gotpointercapture", "lostpointercapture"]) {
    window.addEventListener(type, event => {
      append({ kind: "event", ...eventData(event) });
      if (type === "pointerdown" && event.isTrusted && (!source || !event.composedPath().includes(source))) submit("wrong-source-down", false, event);
    }, { capture: true, passive: true });
  }
  const acceptDrop = (node, expected) => {
    node.addEventListener("dragover", event => { if (event.isTrusted) event.preventDefault(); });
    node.addEventListener("drop", event => { businessDrops++; event.preventDefault(); const data = event.dataTransfer?.getData("text/plain");
      submit(expected ? "original-drop" : "wrong-drop", expected && event.isTrusted && destination.isConnected && destination === document.querySelector("#destination") && data === key, event, { data }); });
  };
  const addCover = event => {
    if (cover) return; const r = destination.getBoundingClientRect(); cover = document.createElement("div"); cover.id = "cover"; cover.dataset.token = "cover"; cover.textContent = "Wrong drop area";
    Object.assign(cover.style, { position: "fixed", left: r.x + "px", top: r.y + "px", width: r.width + "px", height: r.height + "px", zIndex: "50", background: "#f59e0b" });
    acceptDrop(cover, false); document.body.append(cover); mutate(spec.change, event);
  };
  if (source && destination) {
    source.dataset.token = "original-source"; destination.dataset.token = "original-destination";
    source.addEventListener("pointermove", event => {
      if (!event.isTrusted) return;
      if (spec.change === "source-hover-shift" && event.buttons === 0 && !shifted) { shifted = true; source.style.transform = "translateX(160px)"; mutate("source-hover-shift", event); }
      if (spec.mode === "pointer" && event.buttons === 1) lastPointerMove = eventData(event);
    });
    source.addEventListener("pointerdown", event => {
      if (!event.isTrusted) return;
      if (spec.change === "replace-after-down" && !replacement) { replacement = destination.cloneNode(true); replacement.dataset.token = "replacement-destination"; replacement.textContent = "Replacement drop area"; acceptDrop(replacement, false); destination.replaceWith(replacement); mutate("replace-after-down", event); }
      if (spec.mode === "pointer") source.setPointerCapture(event.pointerId);
    });
    source.addEventListener("dragstart", event => { if (event.isTrusted) event.dataTransfer.setData("text/plain", key); });
    if (spec.mode === "pointer") source.addEventListener("pointerup", event => {
      const r = destination.getBoundingClientRect(), inside = event.clientX > r.x && event.clientX < r.x + r.width && event.clientY > r.y && event.clientY < r.y + r.height;
      submit("captured-pointer-up", event.isTrusted && inside && source.hasPointerCapture(event.pointerId) && lastPointerMove?.sourceInPath && lastPointerMove.buttons === 1, event, { lastPointerMove, captured: source.hasPointerCapture(event.pointerId) });
    });
    acceptDrop(destination, true);
    destination.addEventListener("dragenter", event => { if (event.isTrusted && spec.change === "enter-cover") addCover(event); });
    destination.addEventListener("dragover", event => { if (!event.isTrusted) return; dragovers++; if (spec.change === "late-dragover-cover" && dragovers === 2) addCover(event); });
  }
  globalThis.readDragCommitDocument = () => ({ version: 1, key, scene: spec.name, role, href: location.href, documentToken, originalDocument: document === originalDocument,
    source: identify(source), destination: identify(destination), currentSource: identify(document.querySelector("#source")), currentDestination: identify(document.querySelector("#destination")),
    sourceIsOriginal: source ? source === document.querySelector("#source") : null, destinationIsOriginal: destination ? destination === document.querySelector("#destination") : null,
    viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio, scrollX, scrollY }, ledger: structuredClone(ledger), mutations: structuredClone(mutations), receipts: structuredClone(receipts),
    pendingReceipts, dragovers, businessDrops, overflow, recordingErrors, errors: [...errors], shifted, cover: identify(cover), capturedPointer: source && lastPointerMove ? source.hasPointerCapture(lastPointerMove.pointerId) : false });
}

// This function is serialized only for the three new geometry scenes.
export function installDragCommitHotspotDocument({ key, spec, role }) {
  const originalDocument = document, source = document.querySelector("#source"), destination = document.querySelector("#destination"), documentToken = crypto.randomUUID();
  const ledger = [], mutations = [], receipts = [], errors = []; let sequence = 0, overflow = false, recordingErrors = 0, pendingReceipts = 0, dragovers = 0, businessDrops = 0;
  const boxes = { source: { x: 60, y: 70, width: 130, height: 80 }, destination: { x: 430, y: 210, width: 170, height: 110 } };
  const positions = { source: spec.sourcePosition, destination: spec.targetPosition }, markers = {};
  for (const node of [source, destination]) {
    node.dataset.token = "original-" + node.id;
    const marker = document.createElement("i"); marker.dataset.proofMarker = node.id;
    Object.assign(marker.style, { position: "absolute", left: positions[node.id].x + "px", top: positions[node.id].y + "px", width: "0px", height: "0px", padding: "0px", border: "0px", margin: "0px", pointerEvents: "none", transform: "none" });
    node.append(marker); markers[node.id] = marker;
  }
  const rect = node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
  const identify = node => ({ id: node.id, token: node.dataset.token, connected: node.isConnected, sameDocument: node.ownerDocument === originalDocument, rect: rect(node) });
  const hotspot = (node, event) => {
    const box = boxes[node.id], request = positions[node.id], style = getComputedStyle(node), marker = rect(markers[node.id]);
    const border = { x: parseFloat(style.borderLeftWidth), y: parseFloat(style.borderTopWidth) }, rotated = style.rotate === "180deg";
    const point = { x: box.x + (rotated ? box.width - border.x - request.x : border.x + request.x), y: box.y + (rotated ? box.height - border.y - request.y : border.y + request.y) };
    const local = event && { x: (rotated ? box.width - (event.clientX - box.x) : event.clientX - box.x) - border.x, y: (rotated ? box.height - (event.clientY - box.y) : event.clientY - box.y) - border.y };
    return { request, border, expectedClientPoint: point, markerPoint: { x: marker.x, y: marker.y }, markerSize: { width: marker.width, height: marker.height }, rect: rect(node),
      css: { boxSizing: style.boxSizing, left: style.left, top: style.top, width: style.width, height: style.height, transform: style.transform, transformOrigin: style.transformOrigin, rotate: style.rotate, zoom: style.zoom, borderLeftWidth: style.borderLeftWidth, borderTopWidth: style.borderTopWidth },
      ...(event ? { actualClientPoint: { x: event.clientX, y: event.clientY }, local, correct: Math.abs(local.x - request.x) <= 6 && Math.abs(local.y - request.y) <= 6 } : {}) };
  };
  const eventData = event => ({ type: event.type, trusted: event.isTrusted, target: event.target?.id ?? null, targetToken: event.target?.dataset?.token ?? null,
    sourceInPath: event.composedPath().includes(source), destinationInPath: event.composedPath().includes(destination), replacementInPath: false, coverInPath: false,
    clientX: event.clientX, clientY: event.clientY, buttons: event.buttons ?? null, button: event.button ?? null, pointerId: event.pointerId ?? null, pointerType: event.pointerType ?? null,
    ...(event.type === "pointerdown" ? { sourceHotspot: hotspot(source, event) } : {}), ...(event.type === "drop" ? { destinationHotspot: hotspot(destination, event) } : {}) });
  const append = value => { try { if (ledger.length >= 256) { overflow = true; return; } ledger.push({ sequence: ++sequence, at: performance.timeOrigin + performance.now(), ...value }); } catch { recordingErrors++; } };
  const submit = (reason, correct, event, extra = {}) => {
    const receipt = { key, scene: spec.name, role, href: location.href, documentToken, index: receipts.length + 1, reason, correct, event: eventData(event), source: identify(source), destination: identify(destination), currentDestination: identify(destination),
      sourceIsOriginal: source === document.querySelector("#source"), destinationIsOriginal: destination === document.querySelector("#destination"), dragovers, mutations: structuredClone(mutations), ledger: structuredClone(ledger), ...extra };
    const record = { receipt, acknowledged: false }; receipts.push(record); pendingReceipts++;
    fetch("/drag-commit/post?" + new URLSearchParams({ key }), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(receipt) })
      .then(async response => { if (!response.ok) throw Error("Business receipt HTTP " + response.status); const reply = await response.json(); if (reply.key !== key || reply.index !== receipt.index) throw Error("Wrong business receipt ACK"); record.acknowledged = true; })
      .catch(error => errors.push(String(error))).finally(() => pendingReceipts--);
  };
  for (const type of ["pointermove", "pointerdown", "pointerup", "pointercancel", "mousedown", "mousemove", "mouseup", "click", "dragstart", "dragenter", "dragover", "drop", "dragend", "gotpointercapture", "lostpointercapture"]) window.addEventListener(type, event => {
    append({ kind: "event", ...eventData(event) });
    if (type === "pointerdown" && event.isTrusted && (!event.composedPath().includes(source) || !hotspot(source, event).correct)) submit("wrong-source-down", false, event);
  }, { capture: true, passive: true });
  source.addEventListener("dragstart", event => { if (event.isTrusted) event.dataTransfer.setData("text/plain", key); });
  destination.addEventListener("dragover", event => {
    if (!event.isTrusted) return; event.preventDefault(); dragovers++;
    if (dragovers !== 2 || !spec.change) return;
    const before = hotspot(destination);
    if (spec.change === "late-individual-rotate") destination.style.rotate = "180deg";
    if (spec.change === "late-border-origin") { destination.style.borderLeftWidth = "24px"; destination.style.borderTopWidth = "24px"; }
    const mutation = { kind: spec.change, event: eventData(event), dragovers, source: identify(source), destination: identify(destination), beforeHotspot: before, afterHotspot: hotspot(destination) };
    mutations.push(mutation); append({ kind: "mutation", mutation });
  });
  destination.addEventListener("drop", event => {
    businessDrops++; event.preventDefault(); const data = event.dataTransfer?.getData("text/plain"), proof = hotspot(destination, event);
    submit(proof.correct ? "original-drop" : "wrong-hotspot-drop", event.isTrusted && proof.correct && data === key && destination.isConnected && destination === document.querySelector("#destination"), event, { data, hotspot: proof });
  });
  globalThis.readDragCommitDocument = () => ({ version: 1, key, scene: spec.name, role, href: location.href, documentToken, originalDocument: document === originalDocument,
    source: identify(source), destination: identify(destination), currentSource: identify(source), currentDestination: identify(destination), sourceIsOriginal: source === document.querySelector("#source"), destinationIsOriginal: destination === document.querySelector("#destination"),
    viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio, scrollX, scrollY }, ledger: structuredClone(ledger), mutations: structuredClone(mutations), receipts: structuredClone(receipts),
    pendingReceipts, dragovers, businessDrops, overflow, recordingErrors, errors: [...errors], shifted: false, cover: null, capturedPointer: false, hotspots: { source: hotspot(source), destination: hotspot(destination) } });
}

export function checkDragCommitHotspot(proof, name) {
  const box = name === "source" ? { x: 60, y: 70, width: 130, height: 80 } : { x: 430, y: 210, width: 170, height: 110 };
  const position = name === "source" ? { x: 24, y: 20 } : { x: 40, y: 30 };
  assert.deepEqual(proof.request, position); assert.deepEqual(proof.markerSize, { width: 0, height: 0 });
  assert.equal(proof.css.boxSizing, "border-box"); assert.equal(proof.css.transform, "none"); assert.ok(["none", "180deg"].includes(proof.css.rotate)); assert.equal(proof.css.zoom, "1");
  for (const [property, expected] of [["left", box.x], ["top", box.y], ["width", box.width], ["height", box.height]]) assert.equal(proof.css[property], expected + "px");
  assert.equal(proof.css.transformOrigin, `${box.width / 2}px ${box.height / 2}px`);
  assert.deepEqual(proof.rect, box, "The mutation preserves the exact border-box AABB");
  assert.ok([4, 24].includes(proof.border.x)); assert.ok([4, 24].includes(proof.border.y));
  assert.equal(proof.css.borderLeftWidth, proof.border.x + "px"); assert.equal(proof.css.borderTopWidth, proof.border.y + "px");
  const rotated = proof.css.rotate === "180deg", expected = { x: box.x + (rotated ? box.width - proof.border.x - position.x : proof.border.x + position.x), y: box.y + (rotated ? box.height - proof.border.y - position.y : proof.border.y + position.y) };
  assert.deepEqual(proof.expectedClientPoint, expected);
  assert.ok(Math.abs(proof.markerPoint.x - expected.x) <= .025 && Math.abs(proof.markerPoint.y - expected.y) <= .025, "Independent layout marker agrees with authored padding-local geometry");
  if (proof.actualClientPoint) {
    const local = { x: (rotated ? box.width - (proof.actualClientPoint.x - box.x) : proof.actualClientPoint.x - box.x) - proof.border.x, y: (rotated ? box.height - (proof.actualClientPoint.y - box.y) : proof.actualClientPoint.y - box.y) - proof.border.y };
    assert.deepEqual(proof.local, local); assert.equal(proof.correct, Math.abs(local.x - position.x) <= 6 && Math.abs(local.y - position.y) <= 6);
  }
  return expected;
}


export function dragCommitHTML(url) {
  const key = url.searchParams.get("key"), spec = specFor(key); assert.ok([`${route}page`, `${route}frame`].includes(url.pathname));
  const role = url.pathname === `${route}page` ? "root" : "target"; assert.ok(role === "root" || spec.layout === "oopif"); const urls = dragCommitURLs(url, key);
  if (spec.hotspot) return `<!doctype html><meta charset="utf-8"><title>Drag hotspot ${key}</title><style>html,body{margin:0;min-height:640px;background:#f8fafc;font:16px sans-serif}#source,#destination{position:absolute;box-sizing:border-box;border:4px solid #334155;display:grid;place-items:center;user-select:none;transform-origin:50% 50%}#source{left:60px;top:70px;width:130px;height:80px;background:#38bdf8}#destination{left:430px;top:210px;width:170px;height:110px;background:#86efac}</style><div id="source" draggable="true">Original source</div><div id="destination">Original destination</div><script>(${installDragCommitHotspotDocument.toString()})(${JSON.stringify({ key, spec, role })});</script>`;
  const target = `<div id="trap">Old source area</div><div id="source" draggable="${spec.mode === "html"}">Original source</div><div id="destination">Original destination</div>`;
  return `<!doctype html><meta charset="utf-8"><title>Drag commit ${key} ${role}</title><style>html,body{margin:0;min-height:640px;background:#f8fafc;font:16px sans-serif}#source,#trap,#destination{position:absolute;box-sizing:border-box;border:4px solid #334155;display:grid;place-items:center;user-select:none}#source,#trap{left:60px;top:70px;width:130px;height:80px}#source{z-index:2;background:#38bdf8}#trap{background:#fb7185}#destination{left:430px;top:210px;width:170px;height:110px;background:#86efac}iframe{position:absolute;left:75px;top:65px;width:720px;height:460px;border:4px solid #475569;transform-origin:17px 13px;transform:rotate(7deg) scale(.94,.91)}</style>
${spec.layout === "root" || role === "target" ? target : `<iframe id="drag-frame" title="Drag document" src="${urls.target}"></iframe>`}
<script>(${installDragCommitDocument.toString()})(${JSON.stringify({ key, spec, role })});</script>`;
}

export function createDragCommitFixtures() {
  const records = new Map(), entry = key => { specFor(key); if (!records.has(key)) records.set(key, { key, gets: [], posts: [] }); return records.get(key); };
  return { stats: key => structuredClone(entry(key)), allStats: () => structuredClone([...records.values()]), handle(request, response, url) {
    if (![`${route}page`, `${route}frame`, `${route}post`].includes(url.pathname)) return false;
    const key = url.searchParams.get("key"); if (!keyPattern.test(key ?? "")) { response.writeHead(400); response.end("Invalid drag fixture key"); return true; }
    if (url.pathname !== `${route}post`) {
      if (request.method !== "GET") { response.writeHead(405); response.end(); return true; }
      let html; try { html = dragCommitHTML(url); } catch { response.writeHead(400); response.end(); return true; }
      const bytes = Buffer.from(html); entry(key).gets.push({ url: url.href, at: Date.now(), bytes: bytes.length, sha256: sha256(bytes) }); response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }); response.end(bytes); return true;
    }
    if (request.method !== "POST") { response.writeHead(405); response.end(); return true; }
    const record = { at: Date.now(), url: url.href, method: request.method, chunks: 0, bytes: 0 }; entry(key).posts.push(record); const chunks = [];
    request.on("data", chunk => { record.chunks++; record.bytes += chunk.length; if (record.bytes <= 128 * 1024) chunks.push(Buffer.from(chunk)); });
    request.on("error", error => { record.error = String(error); });
    request.on("end", () => { try { assert.ok(record.bytes <= 128 * 1024, "Drag business body too large"); const bytes = Buffer.concat(chunks); record.bodyBase64 = bytes.toString("base64"); record.sha256 = sha256(bytes); record.receipt = JSON.parse(bytes.toString("utf8")); assert.equal(record.receipt.key, key); assert.equal(record.receipt.scene, specFor(key).name); record.completedAt = Date.now(); response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify({ key, index: record.receipt.index })); }
      catch (error) { record.error = errorText(error); response.writeHead(400); response.end("Invalid drag receipt"); } });
    return true;
  } };
}

export function installDragCommitProbe(api, target, { id, tabId }) {
  if (target.__obuDragCommit) throw Error("Drag observer already installed");
  const original = api.debugger.sendCommand, nativeThen = Promise.prototype.then, records = [], guards = new Set(); let sequence = 0, pending = 0, overflow = false, recordingErrors = 0, restored = false, retained = 0;
  const cancelDeclaration = "async function() { try { await this.cancel(); return true; } catch { return false; } }";
  const guardKey = (source, objectId) => `${source.tabId}:${source.sessionId ?? ""}:${objectId}`;
  const append = value => { try { const row = { sequence: ++sequence, at: Date.now(), ...value }, bytes = JSON.stringify(row).length; if (records.length >= 1024 || bytes > 256 * 1024 || retained + bytes > 2 * 1024 * 1024) { overflow = true; return row; } retained += bytes; records.push(row); return row; } catch { recordingErrors++; return null; } };
  function wrapper(...args) {
    if (args[0]?.tabId !== tabId) return Reflect.apply(original, this, args);
    const params = args[2] ?? {}, knownGuard = typeof params.objectId === "string" && guards.has(guardKey(args[0], params.objectId));
    const observationRole = args[1] === "Runtime.callFunctionOn" && params.functionDeclaration?.includes("function createDragCommitGuard(") ? "guard-install" :
      args[1] === "Runtime.callFunctionOn" && knownGuard && params.functionDeclaration === cancelDeclaration ? "guard-cancel" : args[1] === "Runtime.releaseObject" && knownGuard ? "guard-release" : undefined;
    if (!args[1]?.startsWith("Input.") && !observationRole) return Reflect.apply(original, this, args);
    const call = append({ kind: "invoke", source: structuredClone(args[0]), method: args[1], params: structuredClone(params), ...(observationRole ? { observationRole } : {}) }); let result;
    try { result = Reflect.apply(original, this, args); } catch (error) { append({ kind: "settled", invocation: call?.sequence, ok: false, error: String(error) }); throw error; }
    pending++; try { nativeThen.call(result, value => { pending--; if (observationRole === "guard-install" && typeof value?.result?.objectId === "string") guards.add(guardKey(args[0], value.result.objectId)); append({ kind: "settled", invocation: call?.sequence, ok: true, result: value === undefined ? null : structuredClone(value) }); }, error => { pending--; append({ kind: "settled", invocation: call?.sequence, ok: false, error: String(error) }); }); } catch { pending--; recordingErrors++; }
    return result;
  }
  const onEvent = (source, method, params) => { if (source.tabId === tabId && method === "Input.dragIntercepted") append({ kind: "event", source: structuredClone(source), method, params: structuredClone(params) }); };
  const snapshot = () => structuredClone({ version: 1, id, tabId, records, pending, overflow, recordingErrors, restored });
  const controller = { id, snapshot, restore() { if (!restored) { if (api.debugger.sendCommand !== wrapper) throw Error("Drag observer replaced"); api.debugger.sendCommand = original; api.debugger.onEvent.removeListener(onEvent); restored = true; } const value = snapshot(); if (target.__obuDragCommit === controller) delete target.__obuDragCommit; return value; } };
  api.debugger.sendCommand = wrapper; api.debugger.onEvent.addListener(onEvent); target.__obuDragCommit = controller; return snapshot();
}

export function checkDragCommitGuardTrace(probe) {
  const calls = probe.records.filter(value => value.kind === "invoke" && value.observationRole), installs = calls.filter(value => value.observationRole === "guard-install"), used = new Set(), leases = [];
  const acknowledged = call => { const rows = probe.records.filter(value => value.kind === "settled" && value.invocation === call.sequence); assert.equal(rows.length, 1); assert.equal(rows[0].ok, true); assert.ok(rows[0].sequence > call.sequence); return rows[0]; };
  for (const install of installs) {
    assert.equal(install.method, "Runtime.callFunctionOn"); assert.ok(install.params.functionDeclaration.includes("function createDragCommitGuard(")); const installed = acknowledged(install), objectId = installed.result?.result?.objectId; assert.ok(typeof objectId === "string" && objectId.length > 0);
    const sameSource = value => JSON.stringify(value.source) === JSON.stringify(install.source), cancel = calls.filter(value => value.observationRole === "guard-cancel" && value.params.objectId === objectId && sameSource(value)), release = calls.filter(value => value.observationRole === "guard-release" && value.params.objectId === objectId && sameSource(value));
    assert.equal(cancel.length, 1, "Original guard has one native cancel"); assert.equal(release.length, 1, "Original guard has one native release");
    assert.equal(cancel[0].method, "Runtime.callFunctionOn"); assert.equal(cancel[0].params.functionDeclaration, "async function() { try { await this.cancel(); return true; } catch { return false; } }"); assert.equal(release[0].method, "Runtime.releaseObject");
    const cancelled = acknowledged(cancel[0]), released = acknowledged(release[0]); assert.equal(cancelled.result?.result?.value, true, "Original guard cancel must actually return true");
    assert.ok(installed.sequence < cancel[0].sequence); assert.ok(cancelled.sequence < release[0].sequence, "Guard release follows successful native cancel ACK");
    for (const call of [install, cancel[0], release[0]]) { assert.ok(!used.has(call.sequence), "Cleanup belongs to exactly one original guard"); used.add(call.sequence); }
    leases.push({ objectId, source: install.source, installInvocation: install.sequence, installAcknowledgement: installed.sequence, cancelInvocation: cancel[0].sequence, cancelAcknowledgement: cancelled.sequence, releaseInvocation: release[0].sequence, releaseAcknowledgement: released.sequence });
  }
  assert.equal(used.size, calls.length, "Every observed guard cleanup binds its exact original installation");
  return { installed: leases.length, leases, boundary: "Empty baseline guard evidence is retained as absent, not proof of candidate cleanup. Only this factory and cleanup of its returned original object IDs are observed." };
}

export function checkDragCommitTrace(probe, spec) {
  assert.equal(probe?.version, 1); assert.equal(probe.pending, 0); assert.equal(probe.restored, true); assert.equal(probe.overflow, false); assert.equal(probe.recordingErrors, 0);
  assert.ok(probe.records.every((record, index) => record.sequence === index + 1)); const calls = probe.records.filter(value => value.kind === "invoke"), acknowledgements = new Map();
  assert.ok(calls.length > 0); for (const call of calls) { assert.equal(call.source.tabId, probe.tabId); if (call.method.startsWith("Input.")) assert.deepEqual(call.source, { tabId: probe.tabId }, "Native drag input keeps its original root route"); const matches = probe.records.filter(value => value.kind === "settled" && value.invocation === call.sequence); assert.equal(matches.length, 1); assert.ok(matches[0].sequence > call.sequence); acknowledgements.set(call.sequence, matches[0]); }
  assert.equal(probe.records.filter(value => value.kind === "settled").length, calls.length);
  const down = calls.filter(value => value.method === "Input.dispatchMouseEvent" && value.params.type === "mousePressed"), drops = calls.filter(value => value.method === "Input.dispatchDragEvent" && value.params.type === "drop"), up = calls.filter(value => value.method === "Input.dispatchMouseEvent" && value.params.type === "mouseReleased");
  assert.equal(down.length, 1, "A committed drag source press must not repeat"); assert.equal(acknowledgements.get(down[0].sequence).ok, true);
  const beforeDown = calls.filter(value => value.method === "Input.dispatchMouseEvent" && value.params.type === "mouseMoved" && value.sequence < down[0].sequence); assert.ok(beforeDown.length > 0); assert.ok(beforeDown.every(value => value.params.buttons === 0 && acknowledgements.get(value.sequence).ok && acknowledgements.get(value.sequence).sequence < down[0].sequence));
  if (spec.change === "source-hover-shift") { assert.ok(beforeDown.length >= 2, "Source hover change must require a fresh original move"); assert.notDeepEqual([beforeDown[0].params.x, beforeDown[0].params.y], [beforeDown.at(-1).params.x, beforeDown.at(-1).params.y]); }
  if (spec.outcome === "drop") { assert.equal(drops.length, 1); assert.equal(acknowledgements.get(drops[0].sequence).ok, true); assert.ok(drops[0].sequence > acknowledgements.get(down[0].sequence).sequence); }
  if (spec.outcome === "pointer") { assert.equal(drops.length, 0); assert.equal(up.length, 1); assert.equal(acknowledgements.get(up[0].sequence).ok, true); }
  if (spec.outcome === "reject") assert.equal(drops.length, (spec.change === "late-dragover-cover" || spec.hotspot) ? 1 : 0, "Drop dispatch must be prevented before its mutation window; late native dragover is checked at DOM dispatch");
  if (spec.hotspot) { for (const call of [...down, ...drops]) { const expected = down.includes(call) ? { x: 88, y: 94 } : { x: 474, y: 244 }; assert.ok(Math.abs(call.params.x - expected.x) <= .025 && Math.abs(call.params.y - expected.y) <= .025, "Native explicit point matches the original independent hotspot"); } }
  return { nativeCalls: calls.length, guardCleanup: checkDragCommitGuardTrace(probe), presses: down.map(value => ({ invocation: value.sequence, acknowledgement: acknowledgements.get(value.sequence).sequence, point: { x: value.params.x, y: value.params.y } })), drops: drops.map(value => ({ invocation: value.sequence, acknowledgement: acknowledgements.get(value.sequence).sequence })), releases: up.length, commands: calls.map(value => ({ invocation: value.sequence, acknowledgement: acknowledgements.get(value.sequence).sequence, method: value.method, type: value.params.type ?? null, ok: acknowledgements.get(value.sequence).ok })) };
}

export function checkDragCommitDocuments(item) {
  const { spec, before, after, key, server } = item, roles = spec.layout === "root" ? ["root"] : ["root", "target"];
  assert.deepEqual(before.map(value => value.role), roles); assert.deepEqual(after.map(value => value.role), roles);
  for (let i = 0; i < before.length; i++) {
    const a = before[i], b = after[i]; assert.equal(a.key, key); assert.equal(b.key, key); assert.equal(a.documentToken, b.documentToken); assert.equal(a.nativeDocumentId, b.nativeDocumentId); assert.equal(a.nativeFrameId, b.nativeFrameId); assert.equal(a.href, b.href); assert.equal(a.originalDocument, true); assert.equal(b.originalDocument, true);
    assert.equal(b.overflow, false); assert.equal(b.recordingErrors, 0); assert.deepEqual(b.errors, []); assert.equal(b.pendingReceipts, 0); assert.ok(b.ledger.every((value, index) => value.sequence === index + 1));
    assert.deepEqual(b.ledger.slice(0, a.ledger.length), a.ledger); assert.equal(a.ledger.length, 0, "No fixture input before the one public dragTo");
  }
  const original = before.at(-1), final = after.at(-1); assert.equal(original.sourceIsOriginal, true); assert.equal(original.destinationIsOriginal, true); assert.equal(final.sourceIsOriginal, true);
  assert.equal(original.source.token, "original-source"); assert.equal(final.source.token, "original-source"); assert.equal(final.source.connected, true);
  const replaced = spec.change === "replace-after-down"; assert.equal(final.destinationIsOriginal, !replaced); assert.equal(final.destination.connected, !replaced); assert.equal(final.destination.token, "original-destination");
  if (replaced) assert.equal(final.currentDestination.token, "replacement-destination");
  const events = after.flatMap(value => value.ledger.filter(row => row.kind === "event")), sourcePresses = events.filter(value => value.type === "pointerdown");
  assert.equal(sourcePresses.length, 1, "Exactly one real source pointerdown, including parent document events"); assert.equal(sourcePresses[0].trusted, true); assert.equal(sourcePresses[0].sourceInPath, true); assert.equal(sourcePresses[0].targetToken, "original-source");
  assert.ok(events.filter(value => ["pointerdown", "pointerup", "dragstart", "dragenter", "dragover", "drop", "dragend"].includes(value.type)).every(value => value.trusted));
  assert.deepEqual(final.mutations.map(value => value.kind), spec.change ? [spec.change] : []);
  if (spec.change === "late-dragover-cover" || spec.hotspot && spec.change) { assert.equal(final.mutations[0].dragovers, 2); assert.equal(final.mutations[0].event.type, "dragover"); }
  if (spec.change === "enter-cover") assert.equal(final.mutations[0].event.type, "dragenter");
  if (spec.mode === "html") { const starts = events.filter(value => value.type === "dragstart" && value.sourceInPath).length; if (spec.change === "replace-after-down") assert.ok(starts <= 1); else assert.equal(starts, 1); }
  if (spec.hotspot) {
    for (const snapshot of [original, final]) for (const name of ["source", "destination"]) checkDragCommitHotspot(snapshot.hotspots[name], name);
    const press = sourcePresses[0].sourceHotspot; checkDragCommitHotspot(press, "source"); assert.equal(press.correct, true); assert.ok(Math.abs(press.actualClientPoint.x - press.markerPoint.x) <= .025 && Math.abs(press.actualClientPoint.y - press.markerPoint.y) <= .025);
    assert.deepEqual(original.hotspots.destination.border, { x: 4, y: 4 }); assert.equal(original.hotspots.destination.css.rotate, "none");
    if (spec.change) { const mutation = final.mutations[0]; checkDragCommitHotspot(mutation.beforeHotspot, "destination"); checkDragCommitHotspot(mutation.afterHotspot, "destination"); assert.deepEqual(mutation.beforeHotspot, original.hotspots.destination); assert.deepEqual(mutation.afterHotspot, final.hotspots.destination); assert.notDeepEqual(mutation.beforeHotspot.expectedClientPoint, mutation.afterHotspot.expectedClientPoint);
      if (spec.change === "late-individual-rotate") { assert.equal(final.hotspots.destination.css.rotate, "180deg"); assert.deepEqual(final.hotspots.destination.border, { x: 4, y: 4 }); }
      if (spec.change === "late-border-origin") { assert.equal(final.hotspots.destination.css.rotate, "none"); assert.deepEqual(final.hotspots.destination.border, { x: 24, y: 24 }); }
    }
    for (const post of server.posts) {
      const proof = post.receipt.hotspot; checkDragCommitHotspot(proof, "destination"); assert.equal(post.receipt.correct, proof.correct);
      if (spec.outcome === "drop") assert.ok(Math.abs(proof.actualClientPoint.x - proof.markerPoint.x) <= .025 && Math.abs(proof.actualClientPoint.y - proof.markerPoint.y) <= .025,
        "Root explicit drop must match the independent marker within .025 CSS pixels on each axis");
    }
  }
  if (spec.outcome === "reject") { assert.equal(typeof item.actionError, "string"); assert.equal(server.posts.length, 0, "Rejected drag must not submit original, replacement or cover drop"); assert.equal(final.businessDrops, 0, "No original, replacement or cover business drop handler may run");
    // A native drop observed by the fixture's earlier passive window listener
    // can subsequently be stopped by the production utility-world guard. Keep
    // that raw event; only the internal second-dragover case permits it.
    if (spec.change !== "late-dragover-cover" && !spec.hotspot) assert.equal(events.filter(value => value.type === "drop").length, 0); }
  else {
    assert.equal(item.actionError, undefined); assert.equal(server.posts.length, 1, "Exactly one original business receipt"); const post = server.posts[0]; assert.equal(post.error, undefined); assert.ok(post.completedAt); const bytes = Buffer.from(post.bodyBase64, "base64"); assert.equal(bytes.length, post.bytes); assert.equal(sha256(bytes), post.sha256); assert.deepEqual(JSON.parse(bytes.toString("utf8")), post.receipt);
    const receipt = post.receipt; assert.equal(receipt.key, key); assert.equal(receipt.documentToken, original.documentToken); assert.equal(receipt.href, original.href); assert.equal(receipt.correct, true); assert.equal(receipt.index, 1); assert.equal(receipt.sourceIsOriginal, true); assert.equal(receipt.destinationIsOriginal, true);
    assert.equal(receipt.reason, spec.outcome === "pointer" ? "captured-pointer-up" : "original-drop"); assert.equal(receipt.event.trusted, true); assert.equal(final.receipts.length, 1); assert.equal(final.receipts[0].acknowledged, true); assert.deepEqual(final.receipts[0].receipt, receipt);
    if (spec.outcome === "pointer") { assert.equal(receipt.captured, true); assert.equal(receipt.event.sourceInPath, true); assert.equal(final.capturedPointer, false); assert.equal(events.filter(value => value.type === "drop" || value.type === "dragstart").length, 0); }
    else { assert.equal(receipt.data, key); assert.equal(receipt.event.destinationInPath, true); assert.equal(events.filter(value => value.type === "drop").length, 1); assert.equal(final.businessDrops, 1); }
  }
  return { originalDocuments: before.map(value => value.nativeDocumentId), originalSource: original.source.token, originalDestination: original.destination.token, mutations: final.mutations, sourcePresses: sourcePresses.length, observedDropEvents: events.filter(value => value.type === "drop").length, businessDrops: final.businessDrops, posts: server.posts.map(value => ({ bytes: value.bytes, sha256: value.sha256, correct: value.receipt?.correct })) };
}

async function bounded(promise, timeoutMs, label) { let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`Drag fixture ${label} timed out`)), timeoutMs); })]); } finally { clearTimeout(timer); } }
function selectFrames(frames, urls, spec) {
  const root = frames?.filter(value => value.frameId === 0 && value.parentFrameId === -1 && value.url === urls.root && value.documentLifecycle === "active" && !value.errorOccurred && value.documentId);
  if (root?.length !== 1) return null; if (spec.layout === "root") return root;
  const child = frames.filter(value => value.parentFrameId === 0 && value.url === urls.target && value.documentLifecycle === "active" && !value.errorOccurred && value.documentId); if (child.length !== 1) return null;
  assert.notEqual(child[0].processId, root[0].processId, "Real OOPIF required"); assert.notEqual(child[0].documentId, root[0].documentId); return [...root, ...child];
}
async function readDocuments(worker, tabId, frames, timeoutMs = 2500, preparing = false) {
  const results = await bounded(worker.evaluate(`chrome.scripting.executeScript({target:{tabId:${tabId},documentIds:${JSON.stringify(frames.map(value => value.documentId))}},world:'MAIN',func:()=>globalThis.readDragCommitDocument?.()??null})`), timeoutMs, "original document read");
  if (preparing && frames.some(frame => !results.some(value => value.documentId === frame.documentId && value.frameId === frame.frameId && value.result))) return null;
  return frames.map(frame => { const found = results.filter(value => value.documentId === frame.documentId && value.frameId === frame.frameId); assert.equal(found.length, 1); assert.ok(found[0].result); assert.equal(found[0].result.href, frame.url); return { ...found[0].result, nativeFrameId: frame.frameId, nativeDocumentId: frame.documentId, nativeProcessId: frame.processId }; });
}

export async function checkDragCommit({ browser, worker, fixtureURL, server, until, detail = {} }) {
  Object.assign(detail, { version: 1, passed: false, expectedCases: dragCommitCases.map(value => value.name), cases: [], cleanupErrors: [],
    boundary: "One formal SDK dragTo per scene; no caller preparation input, activated tab, replay or new focus allowance. Page handlers perform real hover/down/drag mutations. Original document/node ledgers, native Input invocation/ACK and raw unique business POST bytes are retained. A trusted DOM event cannot authenticate a CDP request. Native drop's internal dragover is a distinct tested mutation window. Root runner owns exact cleanup." });
  let firstFailure;
  for (const spec of dragCommitCases) {
    const id = randomUUID(), key = `drag-commit-${id.replaceAll("-", "")}-${spec.name}`, urls = dragCommitURLs(fixtureURL, key), item = { id, key, spec, urls, passed: false }; detail.cases.push(item); let failure, installed = false;
    try {
      const tab = await browser.newTab(); item.tabId = tab.id; await browser.cdp.navigate(tab.id, urls.root); item.scope = chooserScope(browser); item.frameSamples = [];
      const deadline = Date.now() + 5000; await until(async () => { const remaining = deadline - Date.now(); if (remaining <= 0) throw Error("Drag document preparation expired"); const frames = await bounded(worker.evaluate(`chrome.webNavigation.getAllFrames({tabId:${tab.id}})`), remaining, "document preparation"); if (Date.now() >= deadline) throw Error("Drag preparation completed late"); assert.ok(item.frameSamples.length < 80); item.frameSamples.push({ at: Date.now(), frames }); const selected = selectFrames(frames, urls, spec); if (!selected) return false;
        const documents = await readDocuments(worker, tab.id, selected, deadline - Date.now(), true); if (Date.now() >= deadline) throw Error("Drag reader preparation completed late"); if (!documents) return false; item.framesBefore = selected; item.before = documents; return true;
      }, "original drag documents prepared", 5000);
      const setupDeadline = Date.now() + 2500; installed = true; item.installation = await bounded(worker.evaluate(`(()=>{if(Date.now()>=${setupDeadline})throw Error('Drag observer setup expired');return (${installDragCommitProbe.toString()})(chrome,globalThis,${JSON.stringify({ id, tabId: tab.id })})})()`), 2500, "observer installation");
      const frame = spec.layout === "root" ? tab : tab.frameLocator("#drag-frame"); item.options = { timeoutMs: 5000, ...(spec.hotspot ? { sourcePosition: spec.sourcePosition, targetPosition: spec.targetPosition } : {}) }; item.startedAt = Date.now();
      try { await frame.locator("#source").dragTo(frame.locator("#destination"), item.options); item.completedAt = Date.now(); }
      catch (error) { item.failedAt = Date.now(); item.actionError = errorText(error); if (spec.outcome !== "reject") failure = error; }
      item.publicActionSettledAt = Date.now();
      const snapshot = await bounded(worker.evaluate(`(()=>{const probe=globalThis.__obuDragCommit;if(probe?.id!==${JSON.stringify(id)})throw Error('Drag observer identity changed');return probe.snapshot()})()`), 2500, "native settlement witness"); item.settlementProbe = snapshot;
      assert.equal(snapshot.pending, 0, "Do not read task DOM while original native input is unsettled"); item.nativeInputSettled = true;
      const readDeadline = Date.now() + 2500; await until(async () => { const remaining = readDeadline - Date.now(); if (remaining <= 0) throw Error("Original drag receipt observation expired"); const documents = await readDocuments(worker, tab.id, item.framesBefore, remaining); if (Date.now() >= readDeadline) throw Error("Drag receipt read completed late"); item.after = documents; return documents.every(value => value.pendingReceipts === 0); }, "original business POST acknowledgements settled", 2500);
    } catch (error) { item.error = errorText(error); failure ??= error; }
    finally { if (installed) try { item.probe = await bounded(worker.evaluate(`(()=>{const probe=globalThis.__obuDragCommit;if(probe?.id!==${JSON.stringify(id)})throw Error('Drag observer identity changed');return probe.restore()})()`), 2500, "observer restoration"); }
      catch (error) { item.restoreError = errorText(error); detail.cleanupErrors.push(item.restoreError); failure ??= error; } }
    item.server = server.stats(key);
    if (item.framesBefore) try {
      assert.deepEqual(chooserScope(browser), item.scope); item.native = await bounded(worker.evaluate(`(async()=>({tab:await chrome.tabs.get(${item.tabId}),frames:await chrome.webNavigation.getAllFrames({tabId:${item.tabId}}),targets:await chrome.debugger.getTargets(),attachments:globalThis.__integrationFrames.filter(value=>value.tabId===${item.tabId})}))()`), 2500, "final native identity");
      assert.equal(item.native.tab.active, false); assert.equal(item.native.tab.url, urls.root); const frames = selectFrames(item.native.frames, urls, spec); assert.ok(frames); assert.deepEqual(frames.map(value => [value.frameId, value.documentId, value.processId]), item.framesBefore.map(value => [value.frameId, value.documentId, value.processId]));
      assert.equal(item.nativeInputSettled, true); assert.ok(item.after);
      item.observation = { actionRejected: !!item.actionError, dragovers: item.after.at(-1).dragovers, mutations: item.after.at(-1).mutations.map(value => value.kind), businessDrops: item.after.at(-1).businessDrops,
        observedDrops: item.after.flatMap(value => value.ledger).filter(value => value.type === "drop").length,
        nativePresses: item.probe.records.filter(value => value.kind === "invoke" && value.method === "Input.dispatchMouseEvent" && value.params.type === "mousePressed").length,
        nativeDrops: item.probe.records.filter(value => value.kind === "invoke" && value.method === "Input.dispatchDragEvent" && value.params.type === "drop").length,
        posts: item.server.posts.map(value => ({ reason: value.receipt?.reason, correct: value.receipt?.correct, bytes: value.bytes, sha256: value.sha256 })) };
      item.traceProof = checkDragCommitTrace(item.probe, spec); item.documentProof = checkDragCommitDocuments(item);
    } catch (error) { item.evidenceError = errorText(error); failure ??= error; }
    if (failure) { item.error ??= errorText(failure); firstFailure ??= failure; } else item.passed = true;
  }
  detail.server = server.allStats(); detail.passed = !firstFailure && detail.cases.every(value => value.passed); if (firstFailure) { detail.error = errorText(firstFailure); throw firstFailure; } return detail;
}
