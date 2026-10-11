import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chooserScope } from "./chooser-waits-fixture.mjs";
import { installCountedPointerEvidence, installCountedPointerProbe } from "./pointer-delivery-cases.mjs";
import { checkTransformedPointerTrace } from "./transformed-pointer-fixture.mjs";

const route = "/element-position/";
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const errorText = error => error?.stack ?? String(error);
export const elementPositionCases = Object.freeze([
  { name: "root-scale-canvas", layout: "root", tag: "canvas", sizing: "content-box", transform: "scale(1.28,.86)", zoom: 1, position: { x: 83.25, y: 61.5 } },
  { name: "root-rotate-border", layout: "root", tag: "div", sizing: "border-box", transform: "rotate(24deg)", zoom: 1, position: { x: 237.25, y: 83.5 } },
  { name: "same-transform", layout: "same", tag: "div", sizing: "content-box", transform: "rotate(-17deg) scale(.91,1.12)", zoom: 1, position: { x: 207.25, y: 66.5 } },
  { name: "dynamic-oopif-transform", layout: "oopif", tag: "div", sizing: "border-box", transform: "rotate(19deg) scale(1.09,.93)", zoom: 1, position: { x: 237.25, y: 73.5 } },
  { name: "root-zoom", layout: "root", tag: "div", sizing: "border-box", transform: "rotate(-11deg) scale(.93,1.07)", zoom: 1.25, position: { x: 237.25, y: 83.5 } },
  { name: "root-perspective", layout: "root", tag: "div", sizing: "content-box", transform: "perspective(650px) rotateY(31deg) rotateZ(9deg)", zoom: 1, position: { x: 237.25, y: 73.5 } },
  { name: "shift-after-move", layout: "root", tag: "div", sizing: "border-box", transform: "rotate(13deg)", zoom: 1, position: { x: 237.25, y: 83.5 }, mutation: "move" },
  { name: "shift-after-first", layout: "oopif", tag: "div", sizing: "border-box", transform: "rotate(-13deg)", zoom: 1, position: { x: 237.25, y: 83.5 }, mutation: "click", outcome: "partial" }
].map(value => Object.freeze({ ...value, position: Object.freeze(value.position), outcome: value.outcome ?? "success" })));
const keyPattern = new RegExp(`^element-position-([a-f0-9]{32})-(${elementPositionCases.map(value => value.name).join("|")})$`);
function specFor(key) { const match = keyPattern.exec(key ?? ""); assert.ok(match, "Invalid element position fixture key"); return elementPositionCases.find(value => value.name === match[2]); }

export function elementPositionURLs(base, key) {
  const spec = specFor(key), root = new URL(`${route}page`, base); root.search = new URLSearchParams({ key });
  const target = spec.layout === "root" ? new URL(root) : new URL(`${route}frame`, root);
  target.search = root.search; if (spec.layout === "oopif") target.hostname = "localhost";
  return { root: root.href, target: target.href };
}

// A second, non-interactive CSS plane is an independent layout witness. Zero-
// sized descendants give projected corners without deriving an affine matrix
// from the target's AABB or reusing production/native quad projection code.
export function installElementPositionDocument(config, recordEvents) {
  const { key, spec, role, childURL } = config, node = document.querySelector("#target"), proof = document.querySelector("#proof-plane");
  const evidence = globalThis.elementPositionEvidence = { key, caseName: spec.name, role, documentToken: crypto.randomUUID(), clicks: 0, posts: 0, mutations: [], samples: [], sampleOverflow: false };
  recordEvents(document, evidence, node);
  const rect = element => { const value = element.getBoundingClientRect(); return { x: value.x, y: value.y, width: value.width, height: value.height }; };
  const describe = element => {
    if (!element) return null; const style = getComputedStyle(element);
    return { id: element.id, connected: element.isConnected, rect: rect(element), transform: style.transform, transformOrigin: style.transformOrigin,
      zoom: style.zoom, width: style.width, height: style.height, boxSizing: style.boxSizing,
      borderLeft: style.borderLeftWidth, borderTop: style.borderTopWidth, paddingLeft: style.paddingLeft, paddingTop: style.paddingTop };
  };
  const geometry = () => ({ viewport: { width: innerWidth, height: innerHeight, devicePixelRatio, scrollX, scrollY }, target: describe(node), proof: describe(proof),
    hotspot: proof ? ["nw", "ne", "se", "sw", "center"].map(id => ({ id, ...rect(document.querySelector(`#proof-${id}`)) })) : null,
    frame: describe(document.querySelector("#position-frame")) });
  globalThis.readElementPositionDocument = () => ({ key, href: location.href, role, geometry: geometry(), evidence: structuredClone(evidence),
    originalNodeConnected: node?.isConnected ?? null, visibleResult: document.querySelector("#result")?.textContent ?? null });
  const inside = (point, corners) => {
    let sign = 0;
    for (let i = 0; i < 4; i++) {
      const a = corners[i], b = corners[(i + 1) % 4], cross = (b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x);
      if (Math.abs(cross) < .001) continue;
      if (sign && sign !== Math.sign(cross)) return false; sign = Math.sign(cross);
    }
    return sign !== 0;
  };
  for (const type of ["pointermove", "pointerdown", "pointerup", "click"]) document.addEventListener(type, event => {
    if (evidence.samples.length >= 256) { evidence.sampleOverflow = true; return; }
    const shape = geometry(), current = evidence.records.at(-1);
    evidence.samples.push({ recordSequence: current?.sequence, type, trusted: event.isTrusted, originalNode: event.target === node,
      clientX: event.clientX, clientY: event.clientY, offsetX: event.offsetX, offsetY: event.offsetY,
      inHotspot: event.target === node && !!shape.hotspot && inside({ x: event.clientX, y: event.clientY }, shape.hotspot.slice(0, 4)), geometry: shape });
  }, { capture: true, passive: true });
  const mutate = event => {
    if (!node || evidence.mutations.length || !event.isTrusted || event.target !== node) return;
    const before = geometry(); node.style.transform = `${spec.transform} translate(37px,19px)`; proof.style.transform = node.style.transform;
    evidence.mutations.push({ kind: spec.mutation, documentToken: evidence.documentToken,
      trigger: { type: event.type, recordSequence: evidence.records.at(-1)?.sequence, trusted: event.isTrusted, originalNode: event.target === node }, before, after: geometry() });
  };
  if (node && spec.mutation === "move") node.addEventListener("pointermove", event => {
    if (event.pointerType === "mouse" && event.isPrimary && event.buttons === 0) mutate(event);
  }, { passive: true });
  document.addEventListener("click", event => {
    evidence.clicks++; if (node) document.querySelector("#result").textContent = `${evidence.clicks} clicks`;
    const sample = evidence.samples.at(-1);
    if (spec.mutation === "click" && event.target === node && evidence.clicks === 1) mutate(event);
    evidence.posts++;
    const body = { key, caseName: spec.name, href: location.href, role, documentToken: evidence.documentToken, trusted: event.isTrusted,
      originalNode: event.target === node, correctPosition: sample?.type === "click" && sample.inHotspot === true, evidence: structuredClone(evidence) };
    fetch(`/element-position/post?${new URLSearchParams({ key })}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      .then(response => { if (!response.ok) throw Error(`Receipt HTTP ${response.status}`); return response.json(); })
      .then(receipt => { evidence.receipt = receipt; }).catch(error => evidence.errors.push(String(error)));
  });
  if (role === "root" && spec.layout === "oopif") queueMicrotask(() => {
    const frame = document.createElement("iframe"); frame.id = "position-frame"; frame.title = "Element position frame"; frame.src = childURL;
    document.querySelector("#frame-container").appendChild(frame);
  });
}

export function elementPositionHTML(url) {
  const key = url.searchParams.get("key"), spec = specFor(key), role = url.pathname === `${route}page` ? "root" : "target";
  assert.ok(url.pathname === `${route}page` || url.pathname === `${route}frame` && spec.layout !== "root");
  const urls = elementPositionURLs(url, key), ownsTarget = spec.layout === "root" || role === "target", { x, y } = spec.position;
  const marker = (id, left, top) => `<i id="proof-${id}" style="left:${left}px;top:${top}px"></i>`;
  const markers = marker("nw", x - 6, y - 6) + marker("ne", x + 6, y - 6) + marker("se", x + 6, y + 6) + marker("sw", x - 6, y + 6) + marker("center", x, y);
  const target = `<${spec.tag} id="target" class="plane" role="button" aria-label="Element position receipt"${spec.tag === "canvas" ? ' width="420" height="220"' : ""}></${spec.tag}><div id="proof-plane" class="plane" aria-hidden="true">${markers}</div><output id="result">0 clicks</output>`;
  return `<!doctype html><meta charset="utf-8"><title>Element position ${key} ${role}</title>
<style>html,body{margin:0;min-height:800px;background:#f8fafc;font:16px sans-serif}.plane{position:absolute;left:145.25px;top:135.5px;width:380.5px;height:210.25px;box-sizing:${spec.sizing};border:7.5px solid #334155;padding:13.25px 17.5px;transform:${spec.transform};transform-origin:31px 23px;zoom:${spec.zoom};margin:0}#target{background:#22c55e}#proof-plane{pointer-events:none;background:transparent;border-color:transparent}#proof-plane i{position:absolute;width:0;height:0;padding:0;margin:0;border:0;pointer-events:none}#result{position:absolute;left:30px;top:20px}iframe{position:absolute;left:55.25px;top:60.5px;width:780px;height:560px;border:4px solid #475569;transform:rotate(3deg) scale(.92,.97);transform-origin:17px 11px}</style>
${ownsTarget ? target : spec.layout === "same" ? `<iframe id="position-frame" title="Element position frame" src="${urls.target}"></iframe>` : '<div id="frame-container"></div>'}
<script>(${installElementPositionDocument.toString()})(${JSON.stringify({ key, spec, role, childURL: urls.target })},${installCountedPointerEvidence.toString()});</script>`;
}

export function createElementPositionFixtures() {
  const records = new Map();
  const entry = key => { specFor(key); if (!records.has(key)) records.set(key, { key, gets: [], posts: [] }); return records.get(key); };
  return { stats: key => structuredClone(entry(key)), allStats: () => structuredClone([...records.values()]), handle(request, response, url) {
    if (![`${route}page`, `${route}frame`, `${route}post`].includes(url.pathname)) return false;
    const key = url.searchParams.get("key"); if (!keyPattern.test(key ?? "")) { response.writeHead(400); response.end("Invalid element position key"); return true; }
    const record = entry(key);
    if (url.pathname !== `${route}post`) {
      if (request.method !== "GET") { response.writeHead(405); response.end(); return true; }
      let html; try { html = elementPositionHTML(url); } catch { response.writeHead(400); response.end("Invalid element position page"); return true; }
      const bytes = Buffer.from(html); record.gets.push({ at: Date.now(), url: url.href, method: "GET", bytes: bytes.length, sha256: hash(bytes) });
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }); response.end(bytes); return true;
    }
    if (request.method !== "POST") { response.writeHead(405); response.end(); return true; }
    const post = { receivedAt: Date.now(), method: "POST", url: url.href }; record.posts.push(post); const chunks = []; let size = 0;
    request.on("data", chunk => { size += chunk.length; if (size <= 512 * 1024) chunks.push(chunk); });
    request.once("aborted", () => { post.error = "HTTP request aborted"; }); request.once("error", error => { post.error = String(error); });
    request.once("end", () => {
      const bytes = Buffer.concat(chunks); Object.assign(post, { completedAt: Date.now(), bodyBytes: size, bodyBase64: bytes.toString("base64"), bodySHA256: hash(bytes) });
      try { assert.ok(size <= 512 * 1024); post.value = JSON.parse(bytes.toString("utf8")); assert.equal(post.value.key, key);
        post.receipt = { key, index: record.posts.length, bodySHA256: post.bodySHA256 }; response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify(post.receipt));
      } catch (error) { post.error = errorText(error); response.writeHead(400); response.end("Invalid element position receipt"); }
    }); return true;
  } };
}

export function checkElementPositionTrace(probe, spec) {
  return checkTransformedPointerTrace(probe, { ...spec, mutation: spec.mutation === "move" ? "shift-move" : undefined });
}

// This is the fixture's authored parent CSS transform, not a reconstruction
// using the production plane helper or the target's native quads. Check its
// actual computed matrix, dimensions and border-box AABB before using it.
export function elementPositionRootPoint(point, spec, rootGeometry) {
  assert.ok(Number.isFinite(point?.x) && Number.isFinite(point?.y));
  if (spec.layout === "root") { assert.equal(rootGeometry.frame, null); return { x: point.x, y: point.y }; }
  const frame = rootGeometry.frame; assert.ok(frame?.connected); assert.equal(frame.id, "position-frame");
  for (const [name, value] of Object.entries({ width: "780px", height: "560px", borderLeft: "4px", borderTop: "4px", paddingLeft: "0px", paddingTop: "0px", boxSizing: "content-box", zoom: "1", transformOrigin: "17px 11px" }))
    assert.equal(frame[name], value, `Parent CSS fixture contract changed: ${name}`);
  assert.equal(rootGeometry.viewport.scrollX, 0); assert.equal(rootGeometry.viewport.scrollY, 0);
  const radians = 3 * Math.PI / 180, matrix = [.92 * Math.cos(radians), .92 * Math.sin(radians), -.97 * Math.sin(radians), .97 * Math.cos(radians), 0, 0];
  const match = /^matrix\(([^)]+)\)$/.exec(frame.transform); assert.ok(match, "Parent CSS matrix unavailable");
  const actual = match[1].split(",").map(Number); assert.equal(actual.length, 6);
  actual.forEach((value, index) => assert.ok(Number.isFinite(value) && Math.abs(value - matrix[index]) <= .000001, "Parent CSS matrix changed"));
  const mapBorderPoint = (x, y) => ({ x: 55.25 + 17 + matrix[0] * (x - 17) + matrix[2] * (y - 11), y: 60.5 + 11 + matrix[1] * (x - 17) + matrix[3] * (y - 11) });
  const corners = [[0, 0], [788, 0], [788, 568], [0, 568]].map(([x, y]) => mapBorderPoint(x, y));
  const x = Math.min(...corners.map(point => point.x)), y = Math.min(...corners.map(point => point.y));
  const expected = { x, y, width: Math.max(...corners.map(point => point.x)) - x, height: Math.max(...corners.map(point => point.y)) - y };
  for (const field of ["x", "y", "width", "height"]) assert.ok(Number.isFinite(frame.rect[field]) && Math.abs(frame.rect[field] - expected[field]) <= .0002, `Parent CSS border box changed: ${field}`);
  return mapBorderPoint(point.x + 4, point.y + 4);
}

export function checkElementPositionDocuments({ spec, key, before, after, server, actionError, probe }) {
  checkElementPositionTrace(probe, spec);
  const roles = spec.layout === "root" ? ["root"] : ["root", "target"];
  assert.deepEqual(before.map(value => value.role), roles); assert.deepEqual(after.map(value => value.role), roles);
  for (let index = 0; index < roles.length; index++) {
    const first = before[index], last = after[index], evidence = last.evidence;
    assert.equal(first.key, key); assert.equal(last.key, key); assert.equal(last.href, first.href);
    assert.equal(evidence.documentToken, first.evidence.documentToken); assert.ok(evidence.documentToken); assert.equal(evidence.key, key); assert.equal(evidence.caseName, spec.name); assert.equal(evidence.role, roles[index]);
    assert.equal(evidence.maximumRecords, 256); assert.equal(evidence.overflow, false); assert.equal(evidence.sampleOverflow, false); assert.deepEqual(evidence.errors, []);
    assert.equal(evidence.nextSequence, evidence.records.length); assert.ok(evidence.records.length <= 256); assert.ok(evidence.samples.length <= 256);
    assert.deepEqual(first.evidence.records, []); assert.deepEqual(first.evidence.samples, []);
    assert.ok(evidence.records.every((value, n) => value.sequence === n && value.documentToken === evidence.documentToken && value.trusted === true));
    assert.ok(last.geometry.viewport.width > 0 && last.geometry.viewport.height > 0);
    if (index !== roles.length - 1) { assert.equal(evidence.posts, 0); assert.equal(evidence.clicks, 0); assert.equal(evidence.records.filter(value => /down|up|click/i.test(value.type)).length, 0, "Input landed in the parent frame"); }
  }
  const target = after.at(-1), first = before.at(-1), evidence = target.evidence;
  assert.deepEqual(before[0].geometry.frame, after[0].geometry.frame, "Parent CSS geometry changed during the action");
  assert.deepEqual(before[0].geometry.viewport, after[0].geometry.viewport, "Root viewport changed during the action");
  assert.equal(target.originalNodeConnected, true); assert.notEqual(first.geometry.target.transform, "none");
  for (const geometry of [first.geometry, target.geometry, ...evidence.samples.map(value => value.geometry)]) {
    for (const field of ["transform", "transformOrigin", "zoom", "width", "height", "boxSizing", "borderLeft", "borderTop", "paddingLeft", "paddingTop"])
      assert.equal(geometry.target[field], geometry.proof[field], `Independent proof plane differs: ${field}`);
    assert.deepEqual(geometry.target.rect, geometry.proof.rect); assert.equal(geometry.hotspot.length, 5);
    assert.ok(geometry.hotspot.every(value => Number.isFinite(value.x) && Number.isFinite(value.y) && value.width === 0 && value.height === 0));
  }
  const moves = evidence.records.filter(value => value.type === "pointermove" && value.originalNode && value.pointerType === "mouse" && value.isPrimary === true && value.buttons === 0);
  assert.ok(moves.length > 0); const expected = ["pointerdown", "mousedown", "pointerup", "mouseup", "click"];
  const buttons = evidence.records.filter(value => /down|up|click/i.test(value.type));
  assert.deepEqual(buttons.map(value => value.type), expected); assert.ok(buttons.every(value => value.originalNode && value.targetId === "target"));
  assert.ok(moves[0].sequence < buttons[0].sequence);
  const nativeButtons = probe.records.filter(value => value.kind === "invoke" && ["mousePressed", "mouseReleased"].includes(value.params.type));
  const positionProof = [], rootDPR = after[0].geometry.viewport.devicePixelRatio;
  assert.ok(Number.isFinite(rootDPR) && rootDPR > 0);
  assert.equal(target.geometry.viewport.devicePixelRatio, rootDPR, "Fixture child DPR differs from the unzoomed parent contract");
  for (const type of ["pointerdown", "pointerup", "click"]) {
    const samples = evidence.samples.filter(value => value.type === type); assert.equal(samples.length, 1);
    const sample = samples[0], record = evidence.records[sample.recordSequence]; assert.equal(record.type, type); assert.equal(record.originalNode, true);
    assert.equal(sample.trusted, true); assert.equal(sample.originalNode, true); assert.equal(sample.clientX, record.clientX); assert.equal(sample.clientY, record.clientY);
    assert.equal(sample.inHotspot, true, "Requested padding position missed the independent 12x12 CSS hotspot");
    if (type !== "click") {
      const center = sample.geometry.hotspot[4]; assert.equal(center.id, "center");
      const phase = type === "pointerdown" ? "mousePressed" : "mouseReleased", native = nativeButtons.find(value => value.params.type === phase);
      assert.ok(native); const ack = probe.records.find(value => value.invocation === native.sequence);
      assert.equal(ack.kind, "settled"); assert.equal(ack.ok, true); assert.ok(ack.sequence > native.sequence);
      const expectedRoot = elementPositionRootPoint(center, spec, after[0].geometry);
      const actualRoot = elementPositionRootPoint({ x: sample.clientX, y: sample.clientY }, spec, after[0].geometry);
      const requestResidualCSS = { x: native.params.x - expectedRoot.x, y: native.params.y - expectedRoot.y };
      const localResidualCSS = { x: sample.clientX - center.x, y: sample.clientY - center.y };
      const deliveryResidualCSS = { x: actualRoot.x - native.params.x, y: actualRoot.y - native.params.y };
      const deliveryResidualPhysical = { x: deliveryResidualCSS.x * rootDPR, y: deliveryResidualCSS.y * rootDPR };
      // Specific to this fixture's authored 3deg, .92/.97 parent: compositor
      // paint-origin rounding contributes <= .5 physical pixels per axis;
      // child layout-unit truncation contributes <= a matrix row sum / 64.
      // Include the independently checked root-request tolerance as well.
      const angle = Math.PI / 60, paintOriginBound = .5;
      const layoutBound = { x: (Math.abs(.92 * Math.cos(angle)) + Math.abs(.97 * Math.sin(angle))) / 64,
        y: (Math.abs(.92 * Math.sin(angle)) + Math.abs(.97 * Math.cos(angle))) / 64 };
      const referenceProjectionBound = .025 * rootDPR;
      const derivedPhysicalBound = { x: paintOriginBound + layoutBound.x + referenceProjectionBound, y: paintOriginBound + layoutBound.y + referenceProjectionBound };
      assert.ok(Math.abs(requestResidualCSS.x) <= .025 && Math.abs(requestResidualCSS.y) <= .025,
        `Native root request differs from independent padding-position center: ${requestResidualCSS.x}, ${requestResidualCSS.y}`);
      if (spec.layout === "oopif") {
        assert.ok(derivedPhysicalBound.x <= 1 && derivedPhysicalBound.y <= 1, "Derived fixture bound exceeds one physical pixel per axis");
        assert.ok(Math.abs(deliveryResidualPhysical.x) <= derivedPhysicalBound.x && Math.abs(deliveryResidualPhysical.y) <= derivedPhysicalBound.y,
          `OOPIF delivered position exceeds the derived physical pixel bound: ${deliveryResidualPhysical.x}, ${deliveryResidualPhysical.y}`);
      }
      else assert.ok(Math.abs(localResidualCSS.x) <= .025 && Math.abs(localResidualCSS.y) <= .025,
        `Pointer differs from independent padding-position center: ${localResidualCSS.x}, ${localResidualCSS.y}`);
      positionProof.push({ type, recordSequence: sample.recordSequence, nativeInvokeSequence: native.sequence, nativeAckSequence: ack.sequence,
        expectedRoot, requestedRoot: { x: native.params.x, y: native.params.y }, deliveredRoot: actualRoot, rootDPR,
        requestResidualCSS, localResidualCSS, deliveryResidualCSS, deliveryResidualPhysical,
        ...(spec.layout === "oopif" ? { derivedPhysicalBound, boundTermsPhysical: { paintOrigin: paintOriginBound, childLayout: layoutBound, referenceProjection: referenceProjectionBound } } : {}),
        deliveryPhysicalLInfinity: Math.max(Math.abs(deliveryResidualPhysical.x), Math.abs(deliveryResidualPhysical.y)),
        deliveryPhysicalEuclidean: Math.hypot(deliveryResidualPhysical.x, deliveryResidualPhysical.y),
        contract: spec.layout === "oopif" ? "root-request-0.025-CSS; delivered-root-derived-physical-bound-within-1-per-axis" : "root-request-and-local-delivery-0.025-CSS" });
    }
    // Independently recompute convex containment; never trust the page boolean.
    const signs = sample.geometry.hotspot.slice(0, 4).map((a, index, points) => { const b = points[(index + 1) % 4]; return Math.sign((b.x - a.x) * (sample.clientY - a.y) - (b.y - a.y) * (sample.clientX - a.x)); }).filter(Boolean);
    assert.ok(signs.length > 0 && signs.every(value => value === signs[0]), "Recorded pointer lies outside the actual hotspot polygon");
  }
  assert.equal(evidence.clicks, 1); assert.equal(evidence.posts, 1); assert.equal(target.visibleResult, "1 clicks");
  if (spec.mutation) {
    assert.equal(evidence.mutations.length, 1); const mutation = evidence.mutations[0], event = evidence.records[mutation.trigger.recordSequence];
    assert.equal(mutation.kind, spec.mutation); assert.equal(mutation.documentToken, evidence.documentToken);
    assert.equal(mutation.trigger.type, spec.mutation === "move" ? "pointermove" : "click"); assert.equal(event.type, mutation.trigger.type); assert.equal(event.originalNode, true); assert.equal(event.trusted, true);
    assert.notEqual(mutation.before.target.transform, mutation.after.target.transform); assert.notDeepEqual(mutation.before.hotspot, mutation.after.hotspot);
    if (spec.mutation === "move") assert.ok(moves.length >= 2, "Target transform change did not cause another verified move");
  } else assert.deepEqual(evidence.mutations, []);
  if (spec.outcome === "partial") assert.match(actionError ?? "", /OBU_POINTER_/); else assert.equal(actionError, undefined);
  assert.equal(server.key, key); assert.equal(server.posts.length, 1, "Expected exactly one original business POST"); const post = server.posts[0];
  assert.equal(post.error, undefined); assert.ok(post.receipt); const bytes = Buffer.from(post.bodyBase64, "base64");
  assert.equal(bytes.length, post.bodyBytes); assert.equal(hash(bytes), post.bodySHA256); assert.deepEqual(JSON.parse(bytes.toString("utf8")), post.value);
  assert.equal(post.receipt.key, key); assert.equal(post.receipt.bodySHA256, post.bodySHA256);
  assert.equal(post.value.documentToken, evidence.documentToken); assert.equal(post.value.href, target.href); assert.equal(post.value.role, target.role);
  assert.equal(post.value.trusted, true); assert.equal(post.value.originalNode, true); assert.equal(post.value.correctPosition, true);
  assert.deepEqual(post.value.evidence.records, evidence.records.slice(0, post.value.evidence.records.length));
  return { targetClicks: 1, posts: 1, bodyBytes: bytes.length, mutations: evidence.mutations.length, hotspotChecks: 3, positionProof };
}

async function bounded(promise, timeoutMs, label) { let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`Element position ${label} timed out`)), timeoutMs); })]); } finally { clearTimeout(timer); } }
function selectFrames(frames, urls, spec) {
  const selected = []; let parentFrameId = -1;
  for (const url of spec.layout === "root" ? [urls.root] : [urls.root, urls.target]) {
    const matches = frames?.filter(value => value.url === url && value.parentFrameId === parentFrameId && value.documentLifecycle === "active" && value.errorOccurred === false && typeof value.documentId === "string" && value.documentId) ?? [];
    if (matches.length !== 1) return null; selected.push(matches[0]); parentFrameId = matches[0].frameId;
  }
  assert.ok(selected.every(value => Number.isSafeInteger(value.frameId) && value.frameId >= 0 && Number.isSafeInteger(value.processId) && value.processId >= 0));
  assert.equal(selected[0].frameId, 0); assert.equal(new Set(selected.map(value => value.documentId)).size, selected.length);
  if (spec.layout === "same") assert.equal(selected[0].processId, selected[1].processId);
  if (spec.layout === "oopif") assert.notEqual(selected[0].processId, selected[1].processId, "A real dynamically-created OOPIF is required");
  return selected;
}
async function readDocuments(worker, tabId, frames) {
  const documents = await bounded(worker.evaluate(`chrome.scripting.executeScript({target:{tabId:${tabId},documentIds:${JSON.stringify(frames.map(value => value.documentId))}},world:'MAIN',func:()=>globalThis.readElementPositionDocument?.()??null})`), 3000, "original document evidence");
  return frames.map(frame => { const matches = documents.filter(value => value.frameId === frame.frameId && value.documentId === frame.documentId); assert.equal(matches.length, 1); assert.ok(matches[0].result); assert.equal(matches[0].result.href, frame.url);
    return { ...matches[0].result, nativeFrameId: frame.frameId, nativeDocumentId: frame.documentId, nativeProcessId: frame.processId }; });
}

// Root runner owns finalization and the continuous, unchanged focus ledger.
export async function checkElementPosition({ browser, worker, fixtureURL, server, until, detail = {} }) {
  Object.assign(detail, { version: 1, passed: false, fullCoverage: true, expectedCases: elementPositionCases.map(value => value.name), cases: [], cleanupErrors: [],
    boundary: "One public original-node position click per scene. Independent non-interactive CSS marker geometry, bounded passive DOM/native ledgers, unique original POST bytes. No synthesized/replayed input or foreground activation. Root runner owns finalization and continuous focus checks." });
  let firstFailure;
  for (const spec of elementPositionCases) {
    const id = randomUUID(), key = `element-position-${id.replaceAll("-", "")}-${spec.name}`, urls = elementPositionURLs(fixtureURL, key);
    const item = { id, key, spec, urls, passed: false }; detail.cases.push(item); let failure, installationAttempted = false;
    try {
      const tab = await browser.newTab(); item.tabId = tab.id; await browser.cdp.navigate(tab.id, urls.root);
      item.frameReadSamples = []; const deadline = Date.now() + 5000;
      await until(async () => { const remaining = deadline - Date.now(); if (remaining <= 0) throw Error("Element position frame preparation expired");
        const frames = await bounded(worker.evaluate(`chrome.webNavigation.getAllFrames({tabId:${tab.id}})`), remaining, "frame preparation");
        if (Date.now() >= deadline) throw Error("Element position frame preparation completed late"); if (item.frameReadSamples.length >= 80) throw Error("Element position frame sample overflow");
        item.frameReadSamples.push({ at: Date.now(), frames }); const selected = selectFrames(frames, urls, spec); if (!selected) return false; item.framesBefore = selected; return true;
      }, "original element position documents committed", 5000);
      item.before = await readDocuments(worker, tab.id, item.framesBefore); item.scope = chooserScope(browser); const setupDeadline = Date.now() + 3000; installationAttempted = true;
      item.installation = await bounded(worker.evaluate(`(()=>{if(Date.now()>=${setupDeadline})throw Error('Element position probe setup expired');return (${installCountedPointerProbe.toString()})(chrome,globalThis,${JSON.stringify({ id, tabId: tab.id, mode: "observe" })})})()`), 3000, "input observer installation");
      const frame = spec.layout === "root" ? tab : tab.frameLocator("#position-frame"), locator = frame.getByRole("button", { name: "Element position receipt", exact: true });
      item.options = { timeoutMs: 5000, position: { ...spec.position }, ...(spec.outcome === "partial" ? { clickCount: 2, delay: 150 } : {}) }; item.startedAt = Date.now();
      try { await locator.click(item.options); item.completedAt = Date.now(); } catch (error) { item.failedAt = Date.now(); item.actionError = errorText(error); if (spec.outcome === "success") failure = error; }
      await until(() => { const posts = server.stats(key).posts; return posts.length > 0 && posts.every(value => value.receipt || value.error); }, "original position business POST completed", 3000);
    } catch (error) { failure ??= error; item.error = errorText(error); }
    finally { if (installationAttempted) try { item.probe = await bounded(worker.evaluate(`(()=>{const probe=globalThis.__obuCountedPointer;if(!probe)return null;if(probe.id!==${JSON.stringify(id)})throw Error('Element position probe identity changed');return probe.restore()})()`), 3000, "input observer restoration"); }
      catch (error) { item.restoreError = errorText(error); detail.cleanupErrors.push(item.restoreError); failure ??= error; } }
    item.server = server.stats(key);
    if (item.framesBefore) try {
      assert.deepEqual(chooserScope(browser), item.scope);
      item.native = await bounded(worker.evaluate(`(async()=>({tab:await chrome.tabs.get(${item.tabId}),frames:await chrome.webNavigation.getAllFrames({tabId:${item.tabId}}),targets:await chrome.debugger.getTargets(),attachments:globalThis.__integrationFrames.filter(value=>value.tabId===${item.tabId})}))()`), 3000, "final native identity");
      assert.equal(item.native.tab.id, item.tabId); assert.equal(item.native.tab.active, false); assert.equal(item.native.tab.url, urls.root);
      const frames = selectFrames(item.native.frames, urls, spec); assert.ok(frames); assert.deepEqual(frames.map(value => [value.frameId, value.documentId, value.processId]), item.framesBefore.map(value => [value.frameId, value.documentId, value.processId]));
      item.after = await readDocuments(worker, item.tabId, item.framesBefore); item.traceProof = checkElementPositionTrace(item.probe, spec);
      item.documentProof = checkElementPositionDocuments({ spec, key, before: item.before, after: item.after, server: item.server, actionError: item.actionError, probe: item.probe });
    } catch (error) { item.evidenceError = errorText(error); failure ??= error; }
    if (failure) { item.error ??= errorText(failure); firstFailure ??= failure; } else item.passed = true;
  }
  detail.server = server.allStats(); detail.passed = !firstFailure && detail.cases.every(value => value.passed);
  if (firstFailure) { detail.error = errorText(firstFailure); throw firstFailure; } return detail;
}
