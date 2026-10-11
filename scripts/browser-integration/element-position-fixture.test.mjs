import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { installCountedPointerEvidence, installCountedPointerProbe } from "./pointer-delivery-cases.mjs";
import { elementPositionCases, elementPositionURLs, elementPositionHTML, installElementPositionDocument,
  createElementPositionFixtures, checkElementPositionTrace, checkElementPositionDocuments, checkElementPosition, elementPositionRootPoint } from "./element-position-fixture.mjs";

const keyFor = name => `element-position-0123456789abcdef0123456789abcdef-${name}`;
const specFor = name => elementPositionCases.find(value => value.name === name);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");

// Execute the actual serialized page observer in a small deterministic model.
// Its trusted flags and rectangles are unit-test data, never browser evidence.
function page(spec, role, key) {
  const ownsTarget = spec.layout === "root" || role === "target", elements = new Map(), listeners = new Map(), calls = [], microtasks = [];
  const make = (id, rect) => {
    const events = new Map(), style = { transform: spec.transform, transformOrigin: "31px 23px", zoom: String(spec.zoom), width: "380.5px", height: "210.25px", boxSizing: spec.sizing,
      borderLeftWidth: "7.5px", borderTopWidth: "7.5px", paddingLeft: "17.5px", paddingTop: "13.25px" };
    if (["position-frame", "iframe"].includes(id)) {
      rect = { x: 28.354839324951172, y: 60.02608871459961, width: 752.801513671875, height: 588.146484375 };
      Object.assign(style, { transform: "matrix(0.918739, 0.0481491, -0.0507659, 0.968671, 0, 0)", transformOrigin: "17px 11px", zoom: "1", width: "780px", height: "560px", boxSizing: "content-box", borderLeftWidth: "4px", borderTopWidth: "4px", paddingLeft: "0px", paddingTop: "0px" });
    }
    const element = { id, style, isConnected: true, events, textContent: id === "result" ? "0 clicks" : "",
      addEventListener(type, callback) { if (!events.has(type)) events.set(type, []); events.get(type).push(callback); },
      getBoundingClientRect() { const shifted = (elements.get("proof-plane")?.style.transform ?? style.transform).includes("translate"); return { ...rect, x: rect.x + (shifted ? 37 : 0), y: rect.y + (shifted ? 19 : 0) }; },
      appendChild(child) { elements.set(child.id, child); } };
    elements.set(id, element); return element;
  };
  if (ownsTarget) {
    make("target", { x: 100, y: 100, width: 380, height: 210 }); make("proof-plane", { x: 100, y: 100, width: 380, height: 210 }); make("result", { x: 30, y: 20, width: 100, height: 20 });
    for (const [id, x, y] of [["nw", 194, 144], ["ne", 206, 144], ["se", 206, 156], ["sw", 194, 156], ["center", 200, 150]]) make(`proof-${id}`, { x, y, width: 0, height: 0 });
  } else { make("frame-container", { x: 0, y: 0, width: 800, height: 600 }); if (spec.layout === "same") make("position-frame", { x: 55, y: 60, width: 780, height: 560 }); }
  const urls = elementPositionURLs("http://127.0.0.1:1234", key);
  const context = { config: { key, spec, role, childURL: urls.target }, document: {
    querySelector: selector => elements.get(selector.slice(1)) ?? null,
    createElement: tag => make(tag, { x: 55, y: 60, width: 780, height: 560 }),
    addEventListener(type, callback) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(callback); }
  }, crypto: { randomUUID: () => `${key}-${role}-document` }, structuredClone, URLSearchParams,
    getComputedStyle: element => element.style, innerWidth: 1000, innerHeight: 800, devicePixelRatio: 1, scrollX: 0, scrollY: 0,
    queueMicrotask: callback => microtasks.push(callback), location: { href: role === "root" ? urls.root : urls.target },
    fetch: async (_url, options) => { calls.push(options.body); return { ok: true, json: async () => ({ accepted: true }) }; } };
  runInNewContext(`(${installElementPositionDocument.toString()})(config,${installCountedPointerEvidence.toString()})`, context);
  for (const callback of microtasks) callback(); let clock = 0;
  return { context, elements, calls, read: () => structuredClone(context.readElementPositionDocument()), emit(type, options = {}) {
    const shifted = elements.get("target")?.style.transform.includes("translate"), target = options.target ?? elements.get("target") ?? elements.get("frame-container");
    const event = { type, target, isTrusted: true, detail: type === "click" ? 1 : 0, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false,
      button: type.includes("move") ? -1 : 0, buttons: /down$/.test(type) ? 1 : 0, pointerType: type.startsWith("pointer") ? "mouse" : undefined,
      isPrimary: type.startsWith("pointer") ? true : undefined, clientX: 200 + (shifted ? 37 : 0), clientY: 150 + (shifted ? 19 : 0), offsetX: spec.position.x * spec.zoom,
      offsetY: spec.position.y * spec.zoom, timeStamp: ++clock, ...options };
    for (const callback of listeners.get(type) ?? []) callback(event);
    for (const callback of target.events.get(type) ?? []) callback(event);
  } };
}

async function documents(name, wrongPosition = false) {
  const spec = specFor(name), key = keyFor(name), root = page(spec, "root", key), target = spec.layout === "root" ? root : page(spec, "target", key);
  const pages = root === target ? [root] : [root, target], before = pages.map(value => value.read());
  target.emit("pointermove"); target.emit("mousemove"); if (spec.mutation === "move") { target.emit("pointermove"); target.emit("mousemove"); }
  for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) target.emit(type, wrongPosition ? { clientX: 175, clientY: 140 } : {});
  await Promise.resolve(); await Promise.resolve();
  const after = pages.map(value => value.read()), posts = pages.flatMap(value => value.calls).map(body => {
    const bytes = Buffer.from(body); return { bodyBytes: bytes.length, bodyBase64: bytes.toString("base64"), bodySHA256: hash(bytes), value: JSON.parse(body), receipt: { key, bodySHA256: hash(bytes) } };
  });
  const probe = await trace(name, false, { before, after });
  return { spec, key, before, after, probe, server: { key, posts }, actionError: spec.outcome === "partial" ? "OBU_POINTER_DELIVERY_UNCONFIRMED: target transform changed" : undefined, pages, target };
}
const clean = value => structuredClone({ ...value, pages: undefined, target: undefined });
async function trace(name, secondPair = false, documents) {
  const spec = specFor(name), api = { debugger: { sendCommand: async () => ({}) } }, global = {};
  installCountedPointerProbe(api, global, { id: "element-position-proof", tabId: 42, mode: "observe" });
  const send = (type, x, count = 1) => {
    let point = { x, y: 150 };
    if (documents) {
      const geometry = type === "mouseMoved" && x === 200 ? documents.before.at(-1).geometry : documents.after.at(-1).evidence.samples.find(value => value.type === "pointerdown").geometry;
      point = { x: geometry.hotspot[4].x, y: geometry.hotspot[4].y };
      if (spec.layout !== "root") {
        const angle = Math.PI / 60, dx = point.x + 4 - 17, dy = point.y + 4 - 11;
        point = { x: 72.25 + Math.cos(angle) * .92 * dx - Math.sin(angle) * .97 * dy, y: 71.5 + Math.sin(angle) * .92 * dx + Math.cos(angle) * .97 * dy };
      }
    }
    return api.debugger.sendCommand({ tabId: 42 }, "Input.dispatchMouseEvent", { type, ...point, button: type === "mouseMoved" ? "none" : "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: type === "mouseMoved" ? 0 : count });
  };
  await send("mouseMoved", 200); if (spec.mutation === "move") await send("mouseMoved", 237);
  await send("mousePressed", spec.mutation === "move" ? 237 : 200); await send("mouseReleased", spec.mutation === "move" ? 237 : 200);
  if (secondPair) { await send("mousePressed", 200, 2); await send("mouseReleased", 200, 2); }
  return global.__obuCountedPointer.restore();
}

test("eight scenes retain explicit non-center positions, root canvas, CSS sizing, zoom, perspective and actual frame boundaries", () => {
  assert.equal(elementPositionCases.length, 8); assert.equal(new Set(elementPositionCases.map(value => value.name)).size, 8);
  for (const spec of elementPositionCases) {
    const key = keyFor(spec.name), urls = elementPositionURLs("http://127.0.0.1:1234", key);
    assert.equal(new URL(urls.root).hostname, "127.0.0.1"); assert.equal(new URL(urls.target).hostname, spec.layout === "oopif" ? "localhost" : "127.0.0.1");
    for (const url of new Set(Object.values(urls))) {
      const html = elementPositionHTML(new URL(url)); assert.ok(html.includes(key)); assert.ok(html.includes(spec.transform));
      assert.match(html, /pointer-events:none/); assert.equal(/dispatchEvent|\.click\(|postMessage|setTimeout/.test(html), false);
      if (url === urls.target) for (const id of ["target", "proof-plane", "proof-nw", "proof-ne", "proof-se", "proof-sw", "proof-center"]) assert.ok(html.includes(`id="${id}"`));
    }
    if (spec.layout === "oopif") { const html = elementPositionHTML(new URL(urls.root)); assert.equal(html.includes('<iframe id="position-frame"'), false); assert.match(html, /queueMicrotask/); }
  }
  assert.equal(specFor("root-scale-canvas").tag, "canvas"); assert.equal(specFor("root-zoom").zoom, 1.25); assert.match(specFor("root-perspective").transform, /perspective/);
});

test("all eight actual serialized observer behaviors and native ledgers satisfy separate geometry contracts", async () => {
  for (const spec of elementPositionCases) {
    const value = await documents(spec.name); assert.equal(checkElementPositionDocuments(value).hotspotChecks, 3);
    assert.equal(checkElementPositionTrace(await trace(spec.name), spec).presses, 1);
  }
});

test("a real wrong-location click still creates a business POST and fails exact hotspot checks", async () => {
  const value = await documents("root-rotate-border", true);
  assert.equal(value.server.posts.length, 1); assert.equal(value.server.posts[0].value.correctPosition, false);
  assert.throws(() => checkElementPositionDocuments(value), /hotspot/);
});

test("page hotspot boolean cannot replace independent polygon containment", async () => {
  const value = clean(await documents("root-perspective"));
  const sample = value.after[0].evidence.samples.find(value => value.type === "click"); sample.clientX = 100;
  value.after[0].evidence.records[sample.recordSequence].clientX = 100;
  assert.throws(() => checkElementPositionDocuments(value), /polygon/);
});

test("a point inside the hotspot still fails when it misses the requested subpixel center", async () => {
  const value = clean(await documents("root-scale-canvas")), sample = value.after[0].evidence.samples.find(value => value.type === "pointerdown");
  sample.clientX += .1; value.after[0].evidence.records[sample.recordSequence].clientX = sample.clientX;
  assert.throws(() => checkElementPositionDocuments(value), /padding-position center/);
});

test("known CSS zoom does not turn event offset coordinates into unscaled padding coordinates", async () => {
  const value = await documents("root-zoom"), sample = value.after[0].evidence.samples.find(value => value.type === "pointerdown");
  assert.equal(sample.offsetX, value.spec.position.x * 1.25); assert.notEqual(sample.offsetX, value.spec.position.x);
  assert.equal(checkElementPositionDocuments(value).targetClicks, 1);
});

test("independent fixed parent CSS map checks actual dimensions, border, zoom, matrix and AABB", async () => {
  const value = await documents("dynamic-oopif-transform"), geometry = value.after[0].geometry;
  const point = elementPositionRootPoint({ x: 378.861572265625, y: 285.1488952636719 }, value.spec, geometry);
  assert.ok(Math.abs(point.x - 394.260885201306) < .000001); assert.ok(Math.abs(point.y - 358.550568831672) < .000001);
  for (const mutate of [x => { x.frame.borderLeft = "3px"; }, x => { x.frame.width = "779px"; }, x => { x.frame.zoom = "1.25"; },
    x => { x.frame.transform = "matrix(1,0,0,1,0,0)"; }, x => { x.frame.rect.x += .001; }, x => { x.viewport.scrollY = 1; }]) {
    const invalid = structuredClone(geometry); mutate(invalid); assert.throws(() => elementPositionRootPoint({ x: 200, y: 150 }, value.spec, invalid));
  }
});

function shiftDeliveredPointers(value, dx, dy) {
  const evidence = value.after.at(-1).evidence;
  for (const sample of evidence.samples.filter(value => ["pointerdown", "pointerup"].includes(value.type))) {
    sample.clientX += dx; sample.clientY += dy;
    Object.assign(evidence.records[sample.recordSequence], { clientX: sample.clientX, clientY: sample.clientY });
  }
  const post = value.server.posts[0]; post.value.evidence.records = structuredClone(evidence.records); post.value.evidence.samples = structuredClone(evidence.samples);
  const bytes = Buffer.from(JSON.stringify(post.value)); Object.assign(post, { bodyBytes: bytes.length, bodyBase64: bytes.toString("base64"), bodySHA256: hash(bytes) }); post.receipt.bodySHA256 = post.bodySHA256;
}

test("OOPIF routing quantization keeps a strict root request and reports separately derived physical and actual local residuals", async () => {
  const value = clean(await documents("dynamic-oopif-transform")); shiftDeliveredPointers(value, -.1, -.17);
  const { positionProof } = checkElementPositionDocuments(value); assert.equal(positionProof.length, 2);
  for (const proof of positionProof) {
    assert.ok(Math.abs(proof.requestResidualCSS.x) < .000001 && Math.abs(proof.requestResidualCSS.y) < .000001);
    assert.ok(Math.abs(proof.localResidualCSS.x + .1) < .000001 && Math.abs(proof.localResidualCSS.y + .17) < .000001);
    assert.equal(proof.rootDPR, 1); assert.ok(proof.deliveryPhysicalLInfinity > .1); assert.ok(proof.deliveryPhysicalEuclidean >= proof.deliveryPhysicalLInfinity);
    assert.ok(proof.derivedPhysicalBound.x < 1 && proof.derivedPhysicalBound.y < 1);
    assert.equal(proof.derivedPhysicalBound.x, .5 + proof.boundTermsPhysical.childLayout.x + .025);
    assert.ok(proof.nativeAckSequence > proof.nativeInvokeSequence);
  }
});

test("OOPIF physical budget cannot conceal a bad API root point, missing ACK or extra button", async () => {
  for (const mutate of [
    x => { x.probe.records.filter(value => value.kind === "invoke" && value.params.type !== "mouseMoved").forEach(value => { value.params.x += .1; }); },
    x => { x.probe.records[3].ok = false; }, x => { x.probe.records[4].source.sessionId = "bypass"; }
  ]) { const invalid = clean(await documents("dynamic-oopif-transform")); mutate(invalid); assert.throws(() => checkElementPositionDocuments(invalid)); }
});

test("derived OOPIF bound rejects residuals below one pixel but above the calculated bound; same-process stays strict", async () => {
  const invalid = clean(await documents("dynamic-oopif-transform")); shiftDeliveredPointers(invalid, .65, 0);
  assert.throws(() => checkElementPositionDocuments(invalid), /derived physical pixel bound/);
  const same = clean(await documents("same-transform")); shiftDeliveredPointers(same, .1, 0);
  assert.throws(() => checkElementPositionDocuments(same), /padding-position center/);
});

test("trusted hover changes both target and independent geometry once and needs another original move", async () => {
  const value = await documents("shift-after-move"); assert.equal(value.after[0].evidence.mutations.length, 1);
  value.target.emit("pointermove"); assert.equal(value.target.read().evidence.mutations.length, 1);
  const native = await trace("shift-after-move"); native.records.filter(value => value.kind === "invoke").forEach(value => { value.params.x = 200; });
  assert.throws(() => checkElementPositionTrace(native, value.spec), /coordinates/);
  const invalid = clean(value); invalid.after[0].evidence.mutations[0].after.target.transform = invalid.after[0].evidence.mutations[0].before.target.transform;
  assert.throws(() => checkElementPositionDocuments(invalid));
});

test("first-click transformation preserves one receipt but forbids a second native button pair", async () => {
  const value = await documents("shift-after-first"); assert.equal(checkElementPositionDocuments(value).posts, 1);
  const native = await trace("shift-after-first", true); assert.throws(() => checkElementPositionTrace(native, value.spec), /button count/);
  for (const mutate of [value => { value.actionError = undefined; }, value => { value.actionError = "timeout before first click"; }, value => { value.server.posts = []; }]) {
    const invalid = clean(value); mutate(invalid); assert.throws(() => checkElementPositionDocuments(invalid));
  }
});

test("original document, proof geometry, native record and HTTP byte corruption are rejected", async () => {
  const value = await documents("dynamic-oopif-transform");
  for (const mutate of [
    value => { value.after.at(-1).evidence.documentToken = "successor"; },
    value => { value.after.at(-1).evidence.records[0].trusted = false; },
    value => { value.after.at(-1).geometry.proof.zoom = "2"; },
    value => { value.after.at(-1).geometry.proof.rect.x++; },
    value => { value.after.at(-1).geometry.hotspot[0].width = 1; },
    value => { value.after.at(-1).evidence.overflow = true; },
    value => { value.after.at(-1).evidence.sampleOverflow = true; },
    value => { value.after.at(-1).evidence.errors.push("lost record"); },
    value => { value.server.posts[0].bodyBytes++; },
    value => { value.server.posts[0].bodySHA256 = "wrong"; },
    value => { value.server.posts.push(value.server.posts[0]); }
  ]) { const invalid = clean(value); mutate(invalid); assert.throws(() => checkElementPositionDocuments(invalid)); }
});

test("a parent miss is recorded and posted rather than hidden by a missing target receipt", async () => {
  const spec = specFor("same-transform"), key = keyFor(spec.name), root = page(spec, "root", key), before = root.read();
  root.emit("pointerdown"); root.emit("mousedown"); root.emit("pointerup"); root.emit("mouseup"); root.emit("click");
  assert.equal(before.evidence.posts, 0); assert.equal(root.calls.length, 1); assert.equal(JSON.parse(root.calls[0]).correctPosition, false); assert.equal(JSON.parse(root.calls[0]).originalNode, false);
});

test("HTTP fixture captures original non-ASCII bytes, rejects unknown identities and unsupported methods", async t => {
  const fixture = createElementPositionFixtures(), server = http.createServer((request, response) => {
    if (!fixture.handle(request, response, new URL(request.url, `http://${request.headers.host}`))) { response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`, key = keyFor("root-scale-canvas"), url = elementPositionURLs(base, key).root;
  const response = await fetch(url), html = await response.text(); assert.equal(response.status, 200); assert.equal(fixture.stats(key).gets[0].sha256, hash(Buffer.from(html)));
  const body = JSON.stringify({ key, marker: "原始-bytes", correctPosition: false }), post = await fetch(`${base}/element-position/post?key=${key}`, { method: "POST", body });
  assert.equal(post.status, 200); await post.json(); const recorded = fixture.stats(key).posts[0];
  assert.equal(recorded.bodyBytes, Buffer.byteLength(body)); assert.equal(Buffer.from(recorded.bodyBase64, "base64").toString(), body); assert.equal(recorded.bodySHA256, hash(Buffer.from(body)));
  assert.equal((await fetch(`${base}/element-position/page?key=unknown`)).status, 400); assert.equal((await fetch(url, { method: "POST" })).status, 405);
  assert.equal((await fetch(`${base}/element-position/frame?key=${key}`)).status, 400);
});

test("every scene is retained on failures and original exception identity is not replaced", async () => {
  const original = Object.freeze(Error("original creation failure")), detail = {}; let calls = 0;
  await assert.rejects(checkElementPosition({ browser: { async newTab() { calls++; throw original; } }, worker: {}, fixtureURL: "http://127.0.0.1:1234", server: createElementPositionFixtures(), until: () => { throw Error("unexpected wait"); }, detail }), error => error === original);
  assert.equal(calls, 8); assert.equal(detail.fullCoverage, true); assert.equal(detail.passed, false); assert.deepEqual(detail.cases.map(value => value.spec.name), elementPositionCases.map(value => value.name));
  assert.ok(detail.cases.every(value => !value.passed && value.error.includes("original creation failure")));
});
