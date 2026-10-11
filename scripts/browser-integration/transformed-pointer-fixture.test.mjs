import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { installCountedPointerEvidence, installCountedPointerProbe } from "./pointer-delivery-cases.mjs";
import { transformedPointerCases, transformedPointerURLs, transformedPointerHTML, installTransformedPointerDocument,
  createTransformedPointerFixtures, checkTransformedPointerTrace, checkTransformedPointerDocuments, checkTransformedPointer } from "./transformed-pointer-fixture.mjs";

const specFor = name => transformedPointerCases.find(value => value.name === name);
const keyFor = name => `transformed-0123456789abcdef0123456789abcdef-${name}`;
const hash = value => createHash("sha256").update(value).digest("hex");

// This deterministic DOM model executes the real serialized page recorder and
// mutation handlers. Its isTrusted values are test data, not browser evidence.
function page(role, spec, key, parent) {
  const listeners = new Map(), calls = [], elements = new Map();
  const make = (id, rect) => {
    const events = new Map(), style = { transform: id === "transform-frame" ? "scale(0.86, 1.09)" : id === "transform-wrapper" && role === "root" && spec.layout !== "same" ? "rotate(9deg)" : "none",
      display: id === "cover" ? "none" : "block", transformOrigin: "23px 17px", zoom: "1", visibility: "visible", borderLeftWidth: "4px", borderTopWidth: "4px", paddingLeft: "0px", paddingTop: "0px" };
    const element = { id, style, isConnected: true, textContent: id === "result" ? "0 clicks" : "", events,
      addEventListener(type, callback) { if (!events.has(type)) events.set(type, []); events.get(type).push(callback); },
      getBoundingClientRect() { return { ...rect, x: rect.x + (style.transform.includes("translate") ? 150 : 0), y: rect.y + (style.transform.includes("translate") ? 36 : 0) }; } };
    elements.set(id, element); return element;
  };
  if (role === "target") { make("target", spec.name === "rotate-narrow" ? { x: 137.25, y: 91.5, width: 12, height: 12 } : { x: 55.25, y: 65.5, width: 176, height: 64 }); make("result", { x: 55, y: 145, width: 160, height: 20 }); }
  else { make("transform-frame", { x: 110, y: 95, width: 520, height: 390 }); make("transform-wrapper", { x: 110, y: 95, width: 618, height: 358 }); make("cover", { x: 0, y: 0, width: 900, height: 700 }); }
  const urls = transformedPointerURLs("http://127.0.0.1:1234/", key), href = role === "root" ? urls.root : role === "middle" ? urls.middle : urls.target;
  const context = { config: { role, spec, key }, document: {
    querySelector: selector => elements.get(selector.slice(1)) ?? null,
    addEventListener(type, callback) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(callback); }
  }, crypto: { randomUUID: () => `${key}-${role}-document` }, structuredClone, URLSearchParams,
  getComputedStyle: element => element.style, innerWidth: 900, innerHeight: 700, devicePixelRatio: 1.5, scrollX: 0, scrollY: 0,
  location: { href }, window: {}, parent: parent?.context ?? {}, fetch: async (_url, options) => { calls.push(options.body); return { ok: true, json: async () => ({ accepted: true }) }; } };
  if (parent) parent.elements.get("transform-frame").contentWindow = context.window;
  runInNewContext(`(${installTransformedPointerDocument.toString()})(config,${installCountedPointerEvidence.toString()})`, context);
  let clock = 0;
  return { context, elements, calls, read: () => structuredClone(context.readTransformedPointerDocument()), emit(type, more = {}) {
    const target = elements.get("target") ?? elements.get("cover");
    const event = { type, target, isTrusted: true, detail: type === "click" ? 1 : 0, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false,
      button: type === "pointermove" || type === "mousemove" ? -1 : 0, buttons: /down$/.test(type) ? 1 : 0,
      pointerType: type.startsWith("pointer") ? "mouse" : undefined, isPrimary: type.startsWith("pointer") ? true : undefined,
      clientX: spec.name === "rotate-narrow" ? 143.25 : 100.25, clientY: spec.name === "rotate-narrow" ? 97.5 : 90.5, timeStamp: ++clock, ...more };
    for (const callback of listeners.get(type) ?? []) callback(event);
    for (const callback of target.events.get(type) ?? []) callback(event);
  } };
}

async function documents(name) {
  const spec = specFor(name), key = keyFor(name), root = page("root", spec, key);
  const middle = spec.layout === "nested" ? page("middle", spec, key, root) : null;
  const target = page("target", spec, key, middle ?? root), pages = [root, middle, target].filter(Boolean), before = pages.map(value => value.read());
  target.emit("pointermove"); target.emit("mousemove");
  if (spec.mutation === "shift-move") { target.emit("pointermove", { clientX: 101.5 }); target.emit("mousemove", { clientX: 101.5 }); }
  if (spec.outcome !== "no-buttons") for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) target.emit(type);
  await Promise.resolve(); await Promise.resolve();
  const after = pages.map(value => value.read()), posts = target.calls.map(body => {
    const bytes = Buffer.from(body); return { bodyBytes: bytes.length, bodyBase64: bytes.toString("base64"), bodySHA256: hash(bytes), value: JSON.parse(body), receipt: { key, bodySHA256: hash(bytes) } };
  });
  return { spec, key, before, after, server: { key, posts }, actionError: spec.outcome === "success" ? undefined : spec.outcome === "partial" ? "OBU_POINTER_DELIVERY_UNCONFIRMED: obstruction" : "Browser action timed out after 5000ms", pages, target };
}

async function trace(name, { badSecondPair = false } = {}) {
  const spec = specFor(name), api = { debugger: { sendCommand: () => Promise.resolve({}) } }, global = {};
  installCountedPointerProbe(api, global, { id: "transformed-proof", tabId: 42, mode: "observe" });
  const send = (type, x = 220, clickCount = type === "mouseMoved" ? 0 : 1) => api.debugger.sendCommand({ tabId: 42 }, "Input.dispatchMouseEvent", {
    type, x, y: 180, button: type === "mouseMoved" ? "none" : "left", buttons: type === "mousePressed" ? 1 : 0, clickCount
  });
  await send("mouseMoved"); if (spec.mutation === "shift-move") await send("mouseMoved", 350);
  if (spec.outcome !== "no-buttons" || badSecondPair) { await send("mousePressed", spec.mutation === "shift-move" ? 350 : 220); await send("mouseReleased", spec.mutation === "shift-move" ? 350 : 220); }
  if (spec.outcome === "partial" && badSecondPair) { await send("mousePressed", 220, 2); await send("mouseReleased", 220, 2); }
  return global.__obuCountedPointer.restore();
}

test("seven independent pages retain same-origin synchronous parents and real OOPIF URL boundaries", () => {
  assert.equal(transformedPointerCases.length, 7);
  for (const spec of transformedPointerCases) {
    const key = keyFor(spec.name), urls = transformedPointerURLs("http://127.0.0.1:1234/", key);
    assert.equal(new URL(urls.root).hostname, "127.0.0.1");
    assert.equal(new URL(urls.target).hostname, spec.layout === "same" ? "127.0.0.1" : "localhost");
    if (urls.middle) assert.equal(new URL(urls.middle).origin, new URL(urls.target).origin);
    for (const url of Object.values(urls).filter(Boolean)) {
      const html = transformedPointerHTML(new URL(url)); assert.ok(html.includes(key)); assert.ok(html.includes("installTransformedPointerDocument"));
      assert.equal(/dispatchEvent|\.click\(|postMessage|setTimeout/.test(html), false, "Fixture must not synthesize input or timer-trigger mutations");
      if (url !== urls.target) assert.match(html, /scale\(/);
    }
  }
});

test("all seven real serialized page behaviors and native sequences satisfy their distinct checker contracts", async () => {
  for (const spec of transformedPointerCases) {
    const evidence = await documents(spec.name), native = await trace(spec.name);
    const dom = checkTransformedPointerDocuments(evidence), commands = checkTransformedPointerTrace(native, spec);
    assert.equal(dom.targetClicks, spec.outcome === "no-buttons" ? 0 : 1);
    assert.equal(commands.presses, spec.outcome === "no-buttons" ? 0 : 1);
    assert.equal(dom.parentMutations, spec.mutation ? 1 : 0);
  }
});

test("narrow rotated target detects the observed old projection that only happened to hit the large target", async () => {
  const value = await documents("rotate-narrow"); assert.equal(checkTransformedPointerDocuments(value).targetClicks, 1);
  const invalid = { ...value, pages: undefined, target: undefined };
  invalid.after.at(-1).evidence.records[0].clientX = 108.44792175292969;
  invalid.after.at(-1).evidence.records[0].clientY = 72.65625;
  assert.throws(() => checkTransformedPointerDocuments(invalid), /narrow original target/);
});

test("move mutation is one-time and rejects a foreign source without changing the parent", async () => {
  const value = await documents("cover-after-move"), root = value.pages[0];
  assert.equal(root.read().evidence.mutations.length, 1);
  value.target.emit("pointermove"); assert.equal(root.read().evidence.mutations.length, 1);
  const fresh = page("root", value.spec, value.key);
  assert.throws(() => fresh.context.mutateTransformedParent({}, { key: value.key, trusted: true, originalNode: true, documentToken: "foreign" }), /identity/);
  assert.equal(fresh.elements.get("cover").style.display, "none");
});

test("old transformed short-circuit model is detected by buttons after hover cover and by a second counted pair", async () => {
  for (const name of ["cover-after-move", "cover-after-first"]) {
    const native = await trace(name, { badSecondPair: true });
    assert.throws(() => checkTransformedPointerTrace(native, specFor(name)), /button count/);
  }
  const evidence = await documents("cover-after-move"); evidence.pages[0].emit("pointerdown"); evidence.after[0] = evidence.pages[0].read();
  assert.throws(() => checkTransformedPointerDocuments(evidence), /ancestor\/overlay/);
});

test("partial first click is one real receipt, not a complete counted action or a pre-action timeout", async () => {
  const evidence = await documents("cover-after-first");
  assert.equal(checkTransformedPointerDocuments(evidence).posts, 1);
  for (const mutate of [value => { delete value.actionError; }, value => { value.actionError = "timeout before any click"; },
    value => { value.server.posts = []; }, value => { value.after.at(-1).evidence.clicks = 2; }]) {
    const invalid = structuredClone({ ...evidence, pages: undefined, target: undefined }); mutate(invalid);
    assert.throws(() => checkTransformedPointerDocuments(invalid));
  }
});

test("DOM proof rejects missing receipt, untrusted target, transformed fixture drift, wrong document and hidden overflow", async () => {
  const value = await documents("rotate-oopif"), clean = { ...value, pages: undefined, target: undefined };
  for (const mutate of [
    x => { x.after.at(-1).evidence.records[0].trusted = false; },
    x => { x.after.at(-1).evidence.records[0].pointerType = "pen"; },
    x => { x.after.at(-1).evidence.records[0].isPrimary = false; },
    x => { x.before[0].geometry.frame.transform = "none"; },
    x => { x.before[0].geometry.wrapper.transform = "none"; },
    x => { x.after.at(-1).evidence.documentToken = "successor"; },
    x => { x.after.at(-1).evidence.overflow = true; },
    x => { x.after.at(-1).evidence.errors.push("record failed"); },
    x => { x.after.at(-1).geometry.target.rect.x++; },
    x => { x.server.posts[0].bodyBytes++; },
    x => { x.server.posts.push(x.server.posts[0]); },
    x => { x.server.posts[0].bodySHA256 = "wrong"; }
  ]) { const invalid = structuredClone(clean); mutate(invalid); assert.throws(() => checkTransformedPointerDocuments(invalid)); }
});

test("native proof rejects bypass routing, overlapping down/up, dropped move, incomplete observations and foreign Input", async () => {
  const native = await trace("scale-same");
  for (const mutate of [
    x => { x.records[0].source.sessionId = "child"; }, x => { x.records[0].dispatched = false; },
    x => { x.records[0].method = "Input.insertText"; }, x => { x.records[1].ok = false; },
    x => { [x.records[3], x.records[4]] = [x.records[4], x.records[3]]; x.records.forEach((r, i) => { r.sequence = i + 1; }); x.records[4].invocation = 3; },
    x => { x.pending = 1; }, x => { x.overflow = true; }, x => { x.recordingErrors = 1; }, x => { x.restored = false; },
    x => { x.records.pop(); }, x => { x.records[2].params.clickCount = 2; }
  ]) { const invalid = structuredClone(native); mutate(invalid); assert.throws(() => checkTransformedPointerTrace(invalid, specFor("scale-same"))); }
});

test("hover shift must really alter the parent transform and use a new root move coordinate", async () => {
  const evidence = await documents("shift-after-move"), native = await trace("shift-after-move");
  const invalidNative = structuredClone(native); invalidNative.records.filter(value => value.kind === "invoke").forEach(value => { value.params.x = 220; });
  assert.throws(() => checkTransformedPointerTrace(invalidNative, evidence.spec), /coordinates/);
  const mutation = evidence.after[0].evidence.mutations[0]; mutation.after.frame.transform = mutation.before.frame.transform;
  evidence.after.at(-1).evidence.mutations[0] = structuredClone(mutation);
  assert.throws(() => checkTransformedPointerDocuments(evidence), /Expected.*not.*equal|strictly unequal/);
});

test("HTTP fixture preserves actual request bytes/hash and rejects invalid identities and methods", async t => {
  const fixture = createTransformedPointerFixtures(), server = http.createServer((request, response) => {
    if (!fixture.handle(request, response, new URL(request.url, `http://${request.headers.host}`))) { response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`, key = keyFor("scale-same"), url = transformedPointerURLs(base, key).root;
  const response = await fetch(url), html = await response.text(); assert.equal(response.status, 200);
  assert.equal(fixture.stats(key).gets[0].sha256, hash(Buffer.from(html)));
  const body = JSON.stringify({ key, marker: "original-字节" }), post = await fetch(`${base}/transformed-pointer/post?key=${key}`, { method: "POST", body });
  assert.equal(post.status, 200); await post.json(); const record = fixture.stats(key).posts[0];
  assert.equal(Buffer.from(record.bodyBase64, "base64").toString(), body); assert.equal(record.bodyBytes, Buffer.byteLength(body));
  assert.equal(record.bodySHA256, hash(Buffer.from(body)));
  assert.equal((await fetch(`${base}/transformed-pointer/page?key=foreign`)).status, 400);
  assert.equal((await fetch(url, { method: "POST" })).status, 405);
});

test("subset selection is explicit and failures retain their original Error while continuing every requested case", async () => {
  const failure = Object.freeze(Error("original creation failure")), detail = {}, calls = [];
  await assert.rejects(checkTransformedPointer({ browser: { async newTab() { calls.push("newTab"); throw failure; } }, worker: {},
    fixtureURL: "http://127.0.0.1:1234/", server: createTransformedPointerFixtures(), until: () => { throw Error("unexpected wait"); }, detail,
    caseNames: ["scale-same", "rotate-oopif", "nested-mixed"] }), error => error === failure);
  assert.equal(calls.length, 3); assert.equal(detail.fullCoverage, false); assert.equal(detail.passed, false);
  assert.deepEqual(detail.cases.map(value => value.spec.name), ["scale-same", "rotate-oopif", "nested-mixed"]);
  assert.ok(detail.cases.every(value => value.error.includes("original creation failure") && !value.passed));
  await assert.rejects(checkTransformedPointer({ detail: {}, caseNames: ["scale-same", "scale-same"] }));
  await assert.rejects(checkTransformedPointer({ detail: {}, caseNames: ["rotate-oopif", "scale-same"] }));
});
