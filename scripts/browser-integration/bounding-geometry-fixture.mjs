import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chooserScope } from "./chooser-waits-fixture.mjs";
import { decodeParallelPNG, parallelElementClip } from "./background-parallel-workflow.mjs";

const route = "/bounding-geometry/", hash = bytes => createHash("sha256").update(bytes).digest("hex"), errorText = error => error?.stack ?? String(error);
export const boundingGeometryCases = Object.freeze([
  { name: "root", layout: "root", angle: 8, frameAngle: 0, sx: 1, sy: 1 },
  { name: "same", layout: "same", angle: -11, frameAngle: 9, sx: .94, sy: 1.08 },
  { name: "oopif-scale", layout: "oopif", angle: 0, frameAngle: 0, sx: 1.23, sy: .82 },
  { name: "oopif-rotate-leaf", layout: "oopif", angle: -13, frameAngle: 17, sx: .88, sy: 1.07 },
  { name: "nested-localroot", layout: "nested", angle: 11, frameAngle: 8, sx: .98, sy: .94 },
  { name: "navigation", layout: "oopif", angle: 13, frameAngle: -8, sx: 1.05, sy: .96, navigation: true },
  { name: "root-bounds", layout: "root", angle: 0, frameAngle: 0, sx: 1, sy: 1, bounds: true }
].map(Object.freeze));
const keyPattern = new RegExp(`^bounding-([a-f0-9]{32})-(${boundingGeometryCases.map(value => value.name).join("|")})$`);
function specFor(key) { const match = keyPattern.exec(key ?? ""); assert.ok(match, "Invalid bounding geometry key"); return boundingGeometryCases.find(value => value.name === match[2]); }
export function boundingGeometryURLs(base, key, phase = 0) {
  const spec = specFor(key); assert.ok(phase === 0 || phase === 1 && spec.navigation);
  const root = new URL(`${route}page`, base); root.search = new URLSearchParams({ key });
  const target = spec.layout === "root" ? new URL(root) : new URL(`${route}frame`, root);
  if (spec.layout !== "root") { target.search = new URLSearchParams({ key, role: "target", phase }); if (spec.layout !== "same") target.hostname = "localhost"; }
  const middle = spec.layout === "nested" ? new URL(target) : null; if (middle) middle.searchParams.set("role", "middle");
  return { root: root.href, middle: middle?.href ?? null, target: target.href };
}
function hiddenParentURL(base, key) { const url = new URL(`${route}frame`, base); url.hostname = "localhost"; url.search = new URLSearchParams({ key, role: "target", phase: 0, hidden: 1 }); return url.href; }
export function boundingFrameStyle(spec, role) {
  return role === "middle" ? { left: 40.25, top: 45.5, width: 520, height: 340, border: 4, originX: 15, originY: 13, angle: -5, sx: .94, sy: 1.03 } :
    { left: 70.25, top: 65.5, width: 700, height: 480, border: 6, originX: 21, originY: 17, angle: spec.frameAngle, sx: spec.sx, sy: spec.sy };
}

export function installBoundingGeometryDocument(config) {
  const node = document.querySelector("#target"), proof = document.querySelector("#proof"), frame = document.querySelector("#geometry-frame");
  const identity = { key: config.key, role: config.role, phase: config.phase, documentToken: crypto.randomUUID(), inputEvents: 0 };
  for (const type of ["pointerdown", "pointerup", "keydown", "input", "click"]) document.addEventListener(type, () => { identity.inputEvents++; }, { capture: true, passive: true });
  const rect = element => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
  const describe = element => {
    if (!element) return null; const style = getComputedStyle(element), fields = ["width", "height", "left", "top", "transform", "transformOrigin", "zoom", "boxSizing", "display", "borderLeftWidth", "borderRightWidth", "borderTopWidth", "borderBottomWidth", "paddingLeft", "paddingRight", "paddingTop", "paddingBottom"];
    return { id: element.id, connected: element.isConnected, rect: rect(element), styles: Object.fromEntries(fields.map(name => [name, style[name]])) };
  };
  globalThis.readBoundingGeometryDocument = () => ({ ...identity, href: location.href, viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio, scrollX, scrollY },
    originalNode: node ? node === document.querySelector("#target") && node.isConnected : null, target: describe(node), proof: describe(proof), frame: describe(frame),
    markers: proof ? ["nw", "ne", "se", "sw", "body", "patch", "border"].map(id => ({ id, ...rect(document.querySelector(`#mark-${id}`)) })) : [],
    bounds: config.spec.bounds ? Object.fromEntries(["negative", "far", "zero", "zero-height", "hidden"].map(id => [id, describe(document.querySelector(`#${id}`))])) : null });
  globalThis.navigateBoundingGeometryFixture = next => { if (!config.spec.navigation || config.role !== "root" || next !== config.navigationURL || !frame) throw Error("Unexpected fixture navigation"); frame.src = next; return true; };
}

export function boundingGeometryHTML(url) {
  const key = url.searchParams.get("key"), spec = specFor(key), role = url.pathname === `${route}page` ? "root" : url.searchParams.get("role"), phase = Number(url.searchParams.get("phase") ?? "0");
  assert.ok(role === "root" || url.pathname === `${route}frame` && ["target", "middle"].includes(role)); assert.ok(role !== "middle" || spec.layout === "nested");
  const urls = boundingGeometryURLs(url, key, phase), ownsTarget = spec.layout === "root" || role === "target", f = boundingFrameStyle(spec, role);
  const targetAngle = phase ? -9 : spec.angle, left = phase ? 115.25 : 90.25;
  const marker = (id, x, y) => `<i id="mark-${id}" style="left:${x - 8}px;top:${y - 8}px"></i>`;
  const markers = [["nw", 0, 0], ["ne", 280, 0], ["se", 280, 160], ["sw", 0, 160], ["body", 195, 105], ["patch", 63, 48], ["border", 4, 80]].map(args => marker(...args)).join("");
  const bounds = spec.bounds ? '<div id="negative"></div><div id="far"></div><div id="zero"></div><div id="zero-height"></div><div id="hidden"></div>' + (role === "root" ? `<iframe id="hidden-owner" src="${hiddenParentURL(url, key)}"></iframe>` : "") : "";
  const target = `<div id="target" class="tile"><div id="patch"></div></div><div id="proof" class="tile" aria-hidden="true">${markers}</div>${bounds}`;
  const childURL = role === "root" ? urls.middle ?? urls.target : urls.target;
  return `<!doctype html><meta charset="utf-8"><title>Bounding geometry ${key} ${role} ${phase}</title>
<style>html,body{margin:0;min-height:800px;background:#f8fafc}.tile{position:absolute;left:${left}px;top:85.5px;width:280px;height:160px;box-sizing:border-box;border:8px solid #cc2288;padding:0;transform:rotate(${targetAngle}deg);transform-origin:31px 23px;zoom:1;margin:0}#target{background:#22cc88}#patch{position:absolute;left:25px;top:20px;width:60px;height:40px;background:${phase ? "#f4c83d" : "#2299dd"}}#proof{pointer-events:none;background:transparent;border-color:transparent}#proof i{position:absolute;width:0;height:0;border:0;padding:0;margin:0;pointer-events:none}iframe{position:absolute;left:${f.left}px;top:${f.top}px;width:${f.width}px;height:${f.height}px;border:${f.border}px solid #475569;box-sizing:content-box;padding:0;transform:rotate(${f.angle}deg) scale(${f.sx},${f.sy});transform-origin:${f.originX}px ${f.originY}px;zoom:1}#negative{position:absolute;left:-30.5px;top:-18.25px;width:80px;height:40px;background:#fff}#far{position:absolute;left:80.5px;top:1460.25px;width:72px;height:36px;background:#fff}#zero{position:absolute;left:520.5px;top:70.25px;width:0;height:28px}#zero-height{position:absolute;left:560.5px;top:70.25px;width:25px;height:0}#hidden{display:none;width:80px;height:40px}#hidden-owner{display:none}</style>
${ownsTarget ? target : `<iframe id="geometry-frame" title="Geometry ${role}" src="${childURL}"></iframe>`}
<script>(${installBoundingGeometryDocument.toString()})(${JSON.stringify({ key, spec, role, phase, navigationURL: spec.navigation ? boundingGeometryURLs(url, key, 1).target : null })});</script>`;
}

export function createBoundingGeometryFixtures() {
  const records = new Map(), entry = key => { specFor(key); if (!records.has(key)) records.set(key, { key, gets: [] }); return records.get(key); };
  return { stats: key => structuredClone(entry(key)), allStats: () => structuredClone([...records.values()]), handle(request, response, url) {
    if (![`${route}page`, `${route}frame`].includes(url.pathname)) return false;
    const key = url.searchParams.get("key"); if (!keyPattern.test(key ?? "")) { response.writeHead(400); response.end("Invalid bounding key"); return true; }
    if (request.method !== "GET") { response.writeHead(405); response.end(); return true; }
    let html; try { html = boundingGeometryHTML(url); } catch { response.writeHead(400); response.end("Invalid bounding page"); return true; }
    const bytes = Buffer.from(html); entry(key).gets.push({ at: Date.now(), url: url.href, method: "GET", bytes: bytes.length, sha256: hash(bytes) });
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }); response.end(bytes); return true;
  } };
}

// Transparent observer: original receiver, argument objects and Promise are
// retained. Small native screenshot data is kept verbatim for byte comparison.
export function installBoundingGeometryProbe(api, target, { id, tabId }) {
  if (target.__obuBoundingGeometry) throw Error("Bounding geometry observer already installed");
  const original = api.debugger.sendCommand, nativeThen = Promise.prototype.then, records = [];
  const selected = new Set(["DOM.getBoxModel", "DOM.getFrameOwner", "DOM.describeNode", "DOM.resolveNode", "DOM.scrollIntoViewIfNeeded", "Page.captureScreenshot", "Page.startScreencast", "Page.stopScreencast", "Page.screencastFrameAck"]);
  let sequence = 0, phase = "setup", pending = 0, bytes = 0, overflow = false, recordingErrors = 0, restored = false;
  const append = value => {
    try { const row = { sequence: ++sequence, phase, ...value }, size = JSON.stringify(row).length;
      if (records.length >= 1024 || size > 2 * 1024 * 1024 || bytes + size > 8 * 1024 * 1024) { overflow = true; return row; }
      bytes += size; records.push(row); return row;
    } catch { recordingErrors++; return null; }
  };
  function wrapper(...args) {
    if (args[0]?.tabId !== tabId || !selected.has(args[1]) && !args[1]?.startsWith("Input.")) return Reflect.apply(original, this, args);
    const start = append({ kind: "invoke", source: structuredClone(args[0]), method: args[1], params: structuredClone(args[2] ?? {}) }); let result;
    try { result = Reflect.apply(original, this, args); } catch (error) { append({ kind: "settled", invocation: start?.sequence, ok: false, error: String(error) }); throw error; }
    pending++;
    try { nativeThen.call(result, value => { pending--; append({ kind: "settled", invocation: start?.sequence, ok: true, result: structuredClone(value) }); },
      error => { pending--; append({ kind: "settled", invocation: start?.sequence, ok: false, error: String(error) }); }); }
    catch { pending--; recordingErrors++; }
    return result;
  }
  const onEvent = (source, method, params) => { if (source.tabId === tabId && method === "Page.screencastFrame") append({ kind: "frame", source: structuredClone(source), frameSessionId: params.sessionId, dataCharacters: params.data?.length, metadata: structuredClone(params.metadata) }); };
  const snapshot = () => structuredClone({ version: 1, id, tabId, records, pending, overflow, recordingErrors, restored, bytes });
  const controller = { id, snapshot, mark(value) { if (!["bbox", "screenshot", "negative", "far", "zero", "zero-height", "hidden", "hidden-parent"].includes(value)) throw Error("Invalid bounding probe phase"); if (pending) throw Error("Native command still pending at phase boundary"); phase = value; return snapshot(); }, restore() {
    if (!restored) { if (api.debugger.sendCommand !== wrapper) throw Error("Bounding observer replaced"); api.debugger.sendCommand = original; api.debugger.onEvent.removeListener(onEvent); restored = true; }
    const value = snapshot(); if (target.__obuBoundingGeometry === controller) delete target.__obuBoundingGeometry; return value;
  } };
  api.debugger.sendCommand = wrapper; assertInstalled(); api.debugger.onEvent.addListener(onEvent); target.__obuBoundingGeometry = controller; return snapshot();
  function assertInstalled() { if (api.debugger.sendCommand !== wrapper) throw Error("Bounding observer installation failed"); }
}

const near = (actual, expected, tolerance, message) => assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance, `${message}: ${actual} versus ${expected}`);
const matrix = f => { const r = f.angle * Math.PI / 180; return [f.sx * Math.cos(r), f.sx * Math.sin(r), -f.sy * Math.sin(r), f.sy * Math.cos(r), 0, 0]; };
function projectOwner(point, f, viewport) { const [a, b, c, d] = matrix(f), x = point.x + f.border - f.originX, y = point.y + f.border - f.originY; return { x: f.left + f.originX + a * x + c * y - viewport.scrollX, y: f.top + f.originY + b * x + d * y - viewport.scrollY }; }
function aabb(points) { const x = Math.min(...points.map(p => p.x)), y = Math.min(...points.map(p => p.y)); return { x, y, width: Math.max(...points.map(p => p.x)) - x, height: Math.max(...points.map(p => p.y)) - y }; }
export function boundingRootPoint(point, documents, spec, sourceIndex = documents.length - 1) {
  let result = { x: point.x, y: point.y };
  for (let index = sourceIndex - 1; index >= 0; index--) result = projectOwner(result, boundingFrameStyle(spec, documents[index].role), documents[index].viewport);
  return result;
}
function checkOwner(document, spec) {
  const f = boundingFrameStyle(spec, document.role), actual = document.frame; assert.ok(actual?.connected); assert.equal(actual.id, "geometry-frame");
  const wanted = { width: f.width, height: f.height, left: f.left, top: f.top, borderLeftWidth: f.border, borderRightWidth: f.border, borderTopWidth: f.border, borderBottomWidth: f.border, paddingLeft: 0, paddingRight: 0, paddingTop: 0, paddingBottom: 0 };
  for (const [name, value] of Object.entries(wanted)) { assert.match(actual.styles[name], /^-?\d+(?:\.\d+)?px$/); near(Number.parseFloat(actual.styles[name]), value, .00001, `Frame ${name}`); }
  assert.equal(actual.styles.boxSizing, "content-box"); assert.equal(actual.styles.zoom, "1"); assert.equal(actual.styles.transformOrigin, `${f.originX}px ${f.originY}px`);
  const parsed = /^matrix\(([^)]+)\)$/.exec(actual.styles.transform); assert.ok(parsed); const values = parsed[1].split(",").map(Number); assert.equal(values.length, 6);
  values.forEach((value, index) => near(value, matrix(f)[index], .000005, "Authored parent matrix"));
  const points = [[-f.border, -f.border], [f.width + f.border, -f.border], [f.width + f.border, f.height + f.border], [-f.border, f.height + f.border]].map(([x, y]) => projectOwner({ x, y }, f, document.viewport));
  const expected = aabb(points); for (const key of ["x", "y", "width", "height"]) near(actual.rect[key], expected[key], .001, `Authored parent rect ${key}`);
}
export function checkBoundingGeometryDocuments(before, after, spec) {
  const roles = spec.layout === "root" ? ["root"] : spec.layout === "nested" ? ["root", "middle", "target"] : ["root", "target"];
  assert.deepEqual(before.map(value => value.role), roles); assert.deepEqual(after.map(value => value.role), roles);
  for (let i = 0; i < before.length; i++) {
    assert.equal(after[i].href, before[i].href); assert.equal(after[i].documentToken, before[i].documentToken); assert.equal(after[i].nativeDocumentId, before[i].nativeDocumentId);
    assert.equal(after[i].inputEvents, 0); assert.equal(before[i].inputEvents, 0); assert.ok(after[i].viewport.dpr > 0);
    if (i < before.length - 1) { checkOwner(before[i], spec); checkOwner(after[i], spec); }
  }
  for (const document of [before.at(-1), after.at(-1)]) {
    assert.equal(document.originalNode, true); assert.equal(document.target.id, "target"); assert.equal(document.proof.id, "proof");
    assert.deepEqual(document.target.rect, document.proof.rect); assert.deepEqual(document.target.styles, document.proof.styles);
    assert.equal(document.target.styles.width, "280px"); assert.equal(document.target.styles.height, "160px"); assert.equal(document.target.styles.boxSizing, "border-box");
    assert.equal(document.markers.length, 7); assert.ok(document.markers.every(point => Number.isFinite(point.x) && Number.isFinite(point.y) && point.width === 0 && point.height === 0));
  }
  return { originalDocuments: before.map(value => value.nativeDocumentId), beforeBox: aabb(before.at(-1).markers.slice(0, 4).map(p => boundingRootPoint(p, before, spec))), afterBox: aabb(after.at(-1).markers.slice(0, 4).map(p => boundingRootPoint(p, after, spec))) };
}

export function checkBoundingGeometryTrace(probe) {
  assert.equal(probe?.version, 1); assert.equal(probe.restored, true); assert.equal(probe.pending, 0); assert.equal(probe.overflow, false); assert.equal(probe.recordingErrors, 0);
  assert.ok(probe.records.every((value, index) => value.sequence === index + 1));
  const calls = probe.records.filter(value => value.kind === "invoke"), acknowledgements = new Map();
  assert.ok(calls.length > 0); assert.equal(calls.filter(value => value.method.startsWith("Input.")).length, 0, "Geometry reads must not send native Input");
  for (const call of calls) { assert.equal(call.source.tabId, probe.tabId); const matches = probe.records.filter(value => value.invocation === call.sequence); assert.equal(matches.length, 1); assert.equal(matches[0].kind, "settled"); assert.ok(matches[0].sequence > call.sequence); acknowledgements.set(call.sequence, matches[0]); }
  assert.equal(probe.records.filter(value => value.kind === "settled").length, calls.length);
  const captures = calls.filter(value => value.method === "Page.captureScreenshot");
  for (const call of captures) { assert.deepEqual(call.source, { tabId: probe.tabId }); assert.equal(acknowledgements.get(call.sequence).ok, true); assert.equal(typeof acknowledgements.get(call.sequence).result?.data, "string"); }
  return { calls, captures, acknowledgements };
}

function inside(point, polygon) { const cross = polygon.map((a, i) => { const b = polygon[(i + 1) % polygon.length]; return (b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x); }); return cross.every(value => value >= 0) || cross.every(value => value <= 0); }
export function checkBoundingGeometryPixels(bytes, { clip, documents, spec, phase }) {
  const png = decodeParallelPNG(bytes), dpr = documents[0].viewport.dpr;
  assert.equal(png.width, Math.round(clip.width * dpr)); assert.equal(png.height, Math.round(clip.height * dpr));
  const rootScroll = documents[0].viewport, points = documents.at(-1).markers.map(value => ({ ...boundingRootPoint(value, documents, spec), id: value.id }));
  const samples = [], colors = { body: [34, 204, 136], patch: phase ? [244, 200, 61] : [34, 153, 221], border: [204, 34, 136] };
  const check = (id, point, color) => {
    const x = Math.floor((point.x + rootScroll.scrollX - clip.x) * dpr), y = Math.floor((point.y + rootScroll.scrollY - clip.y) * dpr);
    const actual = png.pixel(x, y); assert.deepEqual(actual, color, `Wrong actual screenshot ${id} pixel at ${x},${y}`); samples.push({ id, x, y, color: actual, rootCSS: point });
  };
  for (const [id, color] of Object.entries(colors)) check(id, points.find(value => value.id === id), color);
  const polygon = points.slice(0, 4), box = aabb(polygon);
  const corners = [[box.x + 4, box.y + 4], [box.x + box.width - 4, box.y + 4], [box.x + box.width - 4, box.y + box.height - 4], [box.x + 4, box.y + box.height - 4]].map(([x, y]) => ({ x, y }));
  const background = corners.find(point => !inside(point, polygon) && polygon.every((a, index) => { const b = polygon[(index + 1) % 4]; return Math.abs((b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x)) / Math.hypot(b.x - a.x, b.y - a.y) > 2; }));
  if (background) check("background", background, [248, 250, 252]);
  return { width: png.width, height: png.height, dpr, samples, sha256: hash(bytes), bytes: bytes.length };
}

export function boundingRendererSession(native, frameURL, tabId) {
  // chrome.debugger.getTargets labels OOPIFs "other"; the CDP
  // attachedToTarget event supplies "iframe". Join their exact target ID,
  // rather than equating the two APIs' distinct type vocabularies.
  const targets = native.targets.filter(value => value.url === frameURL);
  assert.equal(targets.length, 1, "Unique original renderer target URL");
  const target = targets[0]; assert.equal(target.attached, true); assert.ok(typeof target.id === "string" && target.id.length > 0);
  const attachments = native.attachments.filter(value => value.targetId === target.id);
  assert.equal(attachments.length, 1, "Unique original renderer session"); const attachment = attachments[0];
  assert.equal(attachment.type, "iframe"); assert.equal(attachment.tabId, tabId); assert.deepEqual(attachment.source, { tabId });
  assert.ok(typeof attachment.sessionId === "string" && attachment.sessionId.length > 0);
  return attachment.sessionId;
}

export function checkBoundingGeometryPhase(item, spec) {
  const documents = checkBoundingGeometryDocuments(item.before, item.after, spec), native = checkBoundingGeometryTrace(item.probe);
  assert.equal(item.boxError, undefined); for (const key of ["x", "y", "width", "height"]) near(item.box?.[key], documents.beforeBox[key], .03, `Formal boundingBox ${key}`);
  assert.equal(item.screenshotError, undefined); assert.equal(item.screenshot?.mimeType, "image/png"); assert.equal(native.captures.length, 1);
  const capture = native.captures[0], ack = native.acknowledgements.get(capture.sequence), bytes = Buffer.from(item.screenshot.base64, "base64");
  assert.deepEqual(Buffer.from(ack.result.data, "base64"), bytes, "Public screenshot differs from the actual native image");
  const documentBox = { ...documents.afterBox, x: documents.afterBox.x + item.after[0].viewport.scrollX, y: documents.afterBox.y + item.after[0].viewport.scrollY };
  const expectedClip = parallelElementClip(documentBox); assert.deepEqual(capture.params.clip, expectedClip, "Actual native clip differs from independently projected border box");
  const nativeBoxes = native.calls.filter(value => value.method === "DOM.getBoxModel" && native.acknowledgements.get(value.sequence).ok).map(call => ({ source: call.source, objectId: call.params.objectId ?? null, nodeId: call.params.nodeId ?? null,
    invocation: call.sequence, acknowledgement: native.acknowledgements.get(call.sequence).sequence, phase: call.phase, model: native.acknowledgements.get(call.sequence).result?.model }));
  assert.ok(nativeBoxes.some(value => value.phase === "bbox" && value.model?.border?.length === 8)); assert.ok(nativeBoxes.some(value => value.phase === "screenshot" && value.model?.border?.length === 8));
  const localRoot = item.before.findIndex(value => value.nativeProcessId !== item.before[0].nativeProcessId), sourceIndex = localRoot < 0 ? 0 : localRoot;
  let targetSession;
  if (sourceIndex) targetSession = boundingRendererSession(item.native, item.before[sourceIndex].href, item.probe.tabId);
  const targetBoxes = ["bbox", "screenshot"].map(phase => {
    const docs = phase === "bbox" ? item.before : item.after, localDocuments = docs.slice(sourceIndex), points = docs.at(-1).markers.slice(0, 4).map(point => boundingRootPoint(point, localDocuments, spec));
    const candidates = nativeBoxes.filter(value => value.phase === phase && value.source.sessionId === targetSession && value.model?.border?.length === 8 && points.every((point, index) => Math.abs(value.model.border[index * 2] - point.x) <= .03 && Math.abs(value.model.border[index * 2 + 1] - point.y) <= .03));
    assert.ok(candidates.length > 0, `Original ${phase} target border quad in its actual renderer session`); return { phase, sessionId: targetSession ?? null, originalDocumentId: docs.at(-1).nativeDocumentId, objectIds: candidates.map(value => value.objectId), invocations: candidates.map(value => value.invocation) };
  });
  const pixels = checkBoundingGeometryPixels(bytes, { clip: capture.params.clip, documents: item.after, spec, phase: item.phase });
  if (spec.bounds) {
    for (const [name, expected] of Object.entries({ negative: { x: -30.5, y: -18.25, width: 80, height: 40 }, far: { x: 80.5, y: 1460.25, width: 72, height: 36 }, zero: { x: 520.5, y: 70.25, width: 0, height: 28 }, "zero-height": { x: 560.5, y: 70.25, width: 25, height: 0 }, hidden: null, "hidden-parent": null })) {
      const observed = item.bounds[name]; assert.equal(observed.error, undefined); assert.deepEqual(observed.box, expected, `Real ${name} boundingBox contract`);
    }
    const [before, after] = [item.hiddenParentBefore, item.hiddenParentAfter]; assert.ok(before && after); assert.equal(before.originalNode, true); assert.equal(after.originalNode, true);
    assert.equal(before.nativeDocumentId, after.nativeDocumentId); assert.equal(before.documentToken, after.documentToken); assert.equal(before.href, after.href); assert.notEqual(before.nativeProcessId, item.before[0].nativeProcessId); assert.equal(after.inputEvents, 0);
    assert.equal(before.target.styles.display, "block"); assert.equal(before.target.styles.width, "280px"); assert.equal(before.target.styles.height, "160px");
  }
  return { ...documents, nativeBoxes, targetBoxes, nativeCapture: { invocation: capture.sequence, acknowledgement: ack.sequence, clip: capture.params.clip }, nativeInputs: 0, pixels };
}

async function bounded(promise, timeoutMs, label) { let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`Bounding geometry ${label} timed out`)), timeoutMs); })]); } finally { clearTimeout(timer); } }
function selectFrames(frames, urls, spec) {
  const selected = []; let parent = -1;
  for (const url of spec.layout === "root" ? [urls.root] : [urls.root, urls.middle, urls.target].filter(Boolean)) {
    const matches = frames?.filter(value => value.url === url && value.parentFrameId === parent && value.documentLifecycle === "active" && value.errorOccurred === false && typeof value.documentId === "string" && value.documentId) ?? [];
    if (matches.length !== 1) return null; selected.push(matches[0]); parent = matches[0].frameId;
  }
  assert.equal(selected[0].frameId, 0); assert.equal(new Set(selected.map(value => value.documentId)).size, selected.length);
  if (spec.layout === "same") assert.equal(selected[0].processId, selected[1].processId);
  if (["oopif", "nested"].includes(spec.layout)) assert.notEqual(selected[0].processId, selected[1].processId, "A real OOPIF is required");
  if (spec.layout === "nested") assert.equal(selected[1].processId, selected[2].processId, "Nested leaf must share the middle renderer local root");
  return selected;
}
async function readDocuments(worker, tabId, frames, timeoutMs = 3000, allowNotReady = false) {
  const documents = await bounded(worker.evaluate(`chrome.scripting.executeScript({target:{tabId:${tabId},documentIds:${JSON.stringify(frames.map(value => value.documentId))}},world:'MAIN',func:()=>globalThis.readBoundingGeometryDocument?.()??null})`), timeoutMs, "original document evidence");
  if (allowNotReady && frames.some(frame => !documents.some(value => value.frameId === frame.frameId && value.documentId === frame.documentId && value.result))) return null;
  return frames.map(frame => { const matches = documents.filter(value => value.frameId === frame.frameId && value.documentId === frame.documentId); assert.equal(matches.length, 1); assert.ok(matches[0].result); assert.equal(matches[0].result.href, frame.url);
    return { ...matches[0].result, nativeFrameId: frame.frameId, nativeDocumentId: frame.documentId, nativeProcessId: frame.processId }; });
}

export async function checkBoundingGeometry({ browser, worker, fixtureURL, until, detail = {}, server, saveScreenshot }) {
  Object.assign(detail, { version: 1, passed: false, cases: [], cleanupErrors: [], expectedCases: boundingGeometryCases.map(value => value.name),
    boundary: "Public locator boundingBox and element screenshot, original documents and nodes, independent non-interactive CSS border markers, native command/ACK ledger and exact image bytes/pixels. No native Input, caller pre-scroll, foreground activation or replay of failed public operations. Root runner owns cleanup and continuous focus checks." });
  let firstFailure;
  for (const spec of boundingGeometryCases) {
    const id = randomUUID(), key = `bounding-${id.replaceAll("-", "")}-${spec.name}`, urls = boundingGeometryURLs(fixtureURL, key);
    const item = { id, key, spec, urls, phases: [], passed: false }; detail.cases.push(item); let caseFailure;
    try {
      const tab = await browser.newTab(); item.tabId = tab.id; await browser.cdp.navigate(tab.id, urls.root); item.scope = chooserScope(browser);
      for (let phase = 0; phase <= (spec.navigation ? 1 : 0); phase++) {
        const currentURLs = boundingGeometryURLs(fixtureURL, key, phase), capture = { phase, urls: currentURLs, passed: false }; item.phases.push(capture); let failure, installed = false;
        try {
          if (phase) { item.navigationURLs = currentURLs; assert.equal(await tab.evaluate(`globalThis.navigateBoundingGeometryFixture(${JSON.stringify(currentURLs.target)})`), true); }
          const deadline = Date.now() + 5000; capture.frameSamples = [];
          await until(async () => { const remaining = deadline - Date.now(); if (remaining <= 0) throw Error("Bounding frame preparation expired");
            const frames = await bounded(worker.evaluate(`chrome.webNavigation.getAllFrames({tabId:${tab.id}})`), remaining, "frame preparation");
            if (Date.now() >= deadline) throw Error("Bounding frame preparation completed late"); if (capture.frameSamples.length >= 80) throw Error("Bounding frame sample overflow");
            capture.frameSamples.push({ at: Date.now(), frames }); const selected = selectFrames(frames, currentURLs, spec); if (!selected) return false;
            const documents = await readDocuments(worker, tab.id, selected, deadline - Date.now(), true); if (Date.now() >= deadline) throw Error("Bounding original reader preparation completed late"); if (!documents) return false;
            capture.framesBefore = selected; capture.before = documents; return true;
          }, "original bounding documents committed", 5000);
          if (spec.bounds) { const hiddenURL = hiddenParentURL(fixtureURL, key); await until(async () => { const remaining = deadline - Date.now(); if (remaining <= 0) throw Error("Hidden parent preparation expired"); const frames = await bounded(worker.evaluate(`chrome.webNavigation.getAllFrames({tabId:${tab.id}})`), remaining, "hidden parent preparation"); const candidates = frames.filter(value => value.url === hiddenURL && value.parentFrameId === 0 && value.documentLifecycle === "active" && !value.errorOccurred); if (candidates.length !== 1) return false;
            const documents = await readDocuments(worker, tab.id, candidates, deadline - Date.now(), true); if (Date.now() >= deadline) throw Error("Hidden parent reader preparation completed late"); if (!documents) return false; capture.hiddenParentFrame = candidates[0]; [capture.hiddenParentBefore] = documents; return true; }, "original hidden OOPIF committed", Math.max(1, deadline - Date.now()));
            assert.notEqual(capture.hiddenParentFrame.processId, capture.framesBefore[0].processId); }
          if (phase) { assert.equal(capture.framesBefore[0].documentId, item.phases[0].framesBefore[0].documentId); assert.notEqual(capture.framesBefore.at(-1).documentId, item.phases[0].framesBefore.at(-1).documentId); }
          const probeId = `${id}-${phase}`, setupDeadline = Date.now() + 3000; capture.probeId = probeId; installed = true;
          capture.installation = await bounded(worker.evaluate(`(()=>{if(Date.now()>=${setupDeadline})throw Error('Bounding probe setup expired');return (${installBoundingGeometryProbe.toString()})(chrome,globalThis,${JSON.stringify({ id: probeId, tabId: tab.id })})})()`), 3000, "observer installation");
          const mark = name => bounded(worker.evaluate(`(()=>{const probe=globalThis.__obuBoundingGeometry;if(probe?.id!==${JSON.stringify(probeId)})throw Error('Bounding observer identity changed');return probe.mark(${JSON.stringify(name)})})()`), 3000, "observer phase");
          let frame = tab; if (spec.layout !== "root") frame = frame.frameLocator("#geometry-frame"); if (spec.layout === "nested") frame = frame.frameLocator("#geometry-frame"); const locator = frame.locator("#target");
          await mark("bbox"); try { capture.box = await locator.boundingBox({ timeoutMs: 6000 }); } catch (error) { capture.boxError = errorText(error); failure ??= error; }
          // Continue to the one original screenshot even when the old engine
          // returned the wrong box; its bad pixels/native clip are evidence.
          await mark("screenshot"); try { capture.screenshot = await locator.screenshot({ timeoutMs: 8000 }); const bytes = Buffer.from(capture.screenshot.base64, "base64");
            capture.screenshotFile = await saveScreenshot?.(`bounding-${spec.name}-${phase}`, bytes); capture.screenshotSHA256 = hash(bytes);
          } catch (error) { capture.screenshotError = errorText(error); failure ??= error; }
          if (spec.bounds) { capture.bounds = {}; for (const name of ["negative", "far", "zero", "zero-height", "hidden", "hidden-parent"]) { await mark(name); try { const selected = name === "hidden-parent" ? tab.frameLocator("#hidden-owner").locator("#target") : tab.locator(`#${name}`); capture.bounds[name] = { box: await selected.boundingBox({ timeoutMs: 3000 }) }; } catch (error) { capture.bounds[name] = { error: errorText(error) }; failure ??= error; } } }
        } catch (error) { capture.error = errorText(error); failure ??= error; }
        finally { if (installed) try { capture.probe = await bounded(worker.evaluate(`(()=>{const probe=globalThis.__obuBoundingGeometry;if(probe?.id!==${JSON.stringify(capture.probeId)})throw Error('Bounding observer identity changed');return probe.restore()})()`), 3000, "observer restoration"); }
          catch (error) { capture.restoreError = errorText(error); detail.cleanupErrors.push(capture.restoreError); failure ??= error; } }
        if (capture.framesBefore) try {
          assert.deepEqual(chooserScope(browser), item.scope);
          capture.native = await bounded(worker.evaluate(`(async()=>({tab:await chrome.tabs.get(${tab.id}),frames:await chrome.webNavigation.getAllFrames({tabId:${tab.id}}),targets:await chrome.debugger.getTargets(),attachments:globalThis.__integrationFrames.filter(value=>value.tabId===${tab.id})}))()`), 3000, "final native identity");
          assert.equal(capture.native.tab.active, false); assert.equal(capture.native.tab.url, urls.root); const selected = selectFrames(capture.native.frames, currentURLs, spec); assert.ok(selected);
          assert.deepEqual(selected.map(value => [value.frameId, value.documentId, value.processId]), capture.framesBefore.map(value => [value.frameId, value.documentId, value.processId]));
          capture.after = await readDocuments(worker, tab.id, capture.framesBefore);
          if (capture.hiddenParentFrame) { assert.ok(capture.native.frames.some(value => value.frameId === capture.hiddenParentFrame.frameId && value.documentId === capture.hiddenParentFrame.documentId && value.processId === capture.hiddenParentFrame.processId)); [capture.hiddenParentAfter] = await readDocuments(worker, tab.id, [capture.hiddenParentFrame]); }
          capture.proof = checkBoundingGeometryPhase(capture, spec);
        } catch (error) { capture.evidenceError = errorText(error); failure ??= error; }
        if (failure) { capture.error ??= errorText(failure); caseFailure ??= failure; } else capture.passed = true;
      }
      if (spec.navigation && item.phases.every(value => value.screenshotSHA256)) assert.notEqual(item.phases[0].screenshotSHA256, item.phases[1].screenshotSHA256, "Replacement document must have distinct screenshot bytes");
    } catch (error) { item.error = errorText(error); caseFailure ??= error; }
    item.server = server.stats(key);
    if (caseFailure) { item.error ??= errorText(caseFailure); firstFailure ??= caseFailure; } else item.passed = item.phases.every(value => value.passed);
  }
  detail.server = server.allStats(); detail.passed = !firstFailure && detail.cases.every(value => value.passed);
  if (firstFailure) { detail.error = errorText(firstFailure); throw firstFailure; } return detail;
}
