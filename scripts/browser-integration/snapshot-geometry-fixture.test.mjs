import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { geometryHTML, createSnapshotGeometryFixture, checkGeometryPhase, checkGeometryCaller, resolveGeometryDPR } from "./snapshot-geometry-fixture.mjs";

const nonce = "0123456789abcdef01234567";
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]), header = Buffer.alloc(4), trailer = Buffer.alloc(4); header.writeUInt32BE(data.length);
  let crc = 0xffffffff; for (const byte of body) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  trailer.writeUInt32BE((crc ^ 0xffffffff) >>> 0); return Buffer.concat([header, body, trailer]);
}
function markerPNG(dpr, phase, markerNonce = nonce) {
  const width = Math.round(1100 * dpr), height = Math.round(850 * dpr), stride = width * 3, raw = Buffer.alloc((stride + 1) * height, 255);
  for (let y = 0; y < height; y++) raw[y * (stride + 1)] = 0;
  const code = markerNonce.slice(0, 8) + phase.toString(16).padStart(8, "0");
  for (let y = Math.ceil(16 * dpr); y < 76 * dpr; y++) for (let x = Math.ceil(24 * dpr); x < 264 * dpr; x++) {
    const cell = Math.floor(((y + 0.5) / dpr - 16) / 30) * 8 + Math.floor(((x + 0.5) / dpr - 24) / 30), n = parseInt(code[cell], 16), offset = y * (stride + 1) + 1 + x * 3;
    raw[offset] = 40 + Math.floor(n / 4) * 48; raw[offset + 1] = 40 + n % 4 * 48; raw[offset + 2] = 150;
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
function sample(phase = 0, dpr = 1) {
  const box = { x: 80.25, y: 130.5, width: 170.5, height: 44.25 };
  const doc = (role, children = []) => ({ role, nonce, documentId: `document-${role}`, phase,
    viewport: { width: role === "root" ? 1100 : role === "inner" ? 340 : 400, height: role === "root" ? 850 : role === "inner" ? 190 : 250, scrollX: phase ? role === "root" ? 36 : 12 : 0, scrollY: phase ? role === "root" ? 160 : 72 : 0, devicePixelRatio: dpr },
    targets: [{ role, box: { ...box, x: box.x - (phase ? role === "root" ? 36 : 12 : 0), y: box.y - (phase ? role === "root" ? 160 : 72 : 0) } }],
    owners: children.map((child, index) => ({ role: child.role, box: { x: 20.5 + index * 450 - (phase ? 36 : 0), y: 210.25 - (phase ? 160 : 0), width: phase === 2 ? 456.137893 : 412, height: phase === 2 ? 298.7234 : 262 } })), children });
  const before = doc("root", [doc("same"), doc("cross"), doc("nested", [doc("inner")])]);
  before.targets.push({ role: "shadow", box: { x: 300.5 - (phase ? 36 : 0), y: 130.25 - (phase ? 160 : 0), width: 177.5, height: 43.25 } }, { role: "marker", box: { x: 24, y: 16, width: 240, height: 60 } });
  const frames = [], boxes = [], lines = [], refs = [], mapping = new Map(); let frameIndex = 0;
  const add = (document, parentId = null, ownerRef = null) => {
    const id = parentId === null ? "root" : `f${++frameIndex}`; mapping.set(document.role, id); let counter = 0;
    frames.push({ id, parentId, ownerRef, viewport: { ...document.viewport } });
    const put = (name, box, kind) => { const ref = `${id === "root" ? "" : id}e${++counter}`; refs.push(ref); boxes.push({ ref, frameId: id, box: { ...box } }); lines.push(`- ${kind} "Geometry ${name} action" [ref=${ref}] [box=${box.x},${box.y},${box.width},${box.height}]`); return ref; };
    for (const target of document.targets) put(target.role, target.box, "button");
    const owners = document.owners.map(owner => put(owner.role, owner.box, "iframe"));
    document.children.forEach((child, index) => add(child, id, owners[index]));
  };
  add(before);
  const snapshot = lines.join("\n"), capture = { captureId: "capture-unit", complete: true, snapshot, refs,
    stats: { frames: 5, nodes: refs.length, refs: refs.length, bytes: Buffer.byteLength(snapshot) }, geometry: { coordinateSpace: "frame-viewport-css", frames, boxes } };
  const old = { captureId: "capture-old", complete: true, snapshot: "- button old", refs: ["e1"], stats: { frames: 5, nodes: 1, refs: 1, bytes: 12 } };
  return { phase, dpr, before, after: structuredClone(before), capture, defaultCapture: old, falseCapture: structuredClone(old), screenshot: { mimeType: "image/png", base64: markerPNG(dpr, phase).toString("base64") } };
}

test("frame-local snapshot boxes and the native marker box map exactly to PNG pixels at three DPRs", () => {
  for (const dpr of [1, 1.5, 2]) for (const phase of [0, 1, 2]) {
    const input = sample(phase, dpr), result = checkGeometryPhase(input);
    assert.equal(result.checked.length, 7); assert.equal(result.maximumBoxDeviation, 0); assert.equal(result.png.samples.length, 16);
    assert.equal(result.png.sha256, sha(Buffer.from(input.screenshot.base64, "base64")));
    assert.ok(result.png.samples.every(value => value.ref === result.checked.find(item => item.role === "marker").ref));
  }
});

test("checker rejects parent-offset projection, wrong frame ancestry, missing boxes and inline divergence", () => {
  const mutations = [
    item => { item.capture.geometry.boxes.find(box => box.ref === "f2e1").box.x += 450; },
    item => { item.capture.geometry.frames.find(frame => frame.id === "f4").parentId = "root"; },
    item => { item.capture.geometry.boxes.pop(); },
    item => { item.capture.snapshot = item.capture.snapshot.replace("[box=80.25,130.5,170.5,44.25]", "[box=80.26,130.5,170.5,44.25]"); },
    item => { item.capture.geometry.frames[2].viewport.devicePixelRatio = 99; },
    item => { item.after.children[1].viewport.scrollY++; },
    item => { item.after.children[2].children[0].documentId = "replaced-document"; },
    item => { item.falseCapture.geometry = item.capture.geometry; }
  ];
  for (const mutate of mutations) { const item = sample(); mutate(item); assert.throws(() => checkGeometryPhase(item)); }
});

test("checker rejects a stale PNG nonce or phase and distinguishes pixel evidence from CSS tolerance", () => {
  for (const [pngNonce, pngPhase] of [["1123456789abcdef01234567", 0], [nonce, 1]]) {
    const item = sample(); item.screenshot.base64 = markerPNG(1, pngPhase, pngNonce).toString("base64"); assert.throws(() => checkGeometryPhase(item));
  }
  const item = sample(2), child = item.capture.geometry.boxes.find(box => box.ref === "f4e1");
  child.box.x += 5e-7;
  item.capture.snapshot = item.capture.snapshot.replace(/(\[ref=f4e1\] )\[box=[^\]]+\]/, `$1[box=${child.box.x},${child.box.y},${child.box.width},${child.box.height}]`);
  item.capture.stats.bytes = Buffer.byteLength(item.capture.snapshot);
  assert.ok(checkGeometryPhase(item).maximumBoxDeviation > 0);
  child.box.x += 2e-6; assert.throws(() => checkGeometryPhase(item));
});

function request(fixture, route, method = "GET") {
  const response = { status: 200, headers: {}, writeHead(value) { this.status = value; }, setHeader(key, value) { this.headers[key] = value; }, end(value) { this.body = value; } };
  const handled = fixture.handle({ url: route, method, headers: { host: "127.0.0.1:4567" } }, response, 4567);
  return { handled, ...response };
}
test("fixture serves only nonce-bound documents, exact origins and parseable independent DOM scripts", () => {
  const fixture = createSnapshotGeometryFixture();
  assert.equal(request(fixture, "/other").handled, false);
  assert.equal(request(fixture, "/snapshot-geometry-frame?key=one&role=inner").status, 404);
  assert.equal(request(fixture, "/snapshot-geometry?key=one", "POST").status, 400);
  const root = request(fixture, "/snapshot-geometry?key=one"); assert.equal(root.status, 200);
  const record = fixture.allStats()[0]; assert.equal(record.requests[0].sha256, sha(root.body));
  assert.match(root.body, /button id="marker" aria-label="Geometry marker action"/);
  assert.match(root.body, /http:\/\/localhost:4567\/snapshot-geometry-frame\?key=one&role=cross/);
  for (const role of ["root", "same", "cross", "nested", "inner"]) {
    const html = geometryHTML(role, record.nonce, "one", 4567);
    for (const script of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new vm.Script(script[1]);
    assert.ok(html.includes("getBoundingClientRect")); assert.ok(!html.includes("boundingBox("));
    if (role !== "root") assert.equal(request(fixture, `/snapshot-geometry-frame?key=one&role=${role}`).status, 200);
  }
  request(fixture, "/snapshot-geometry?key=two"); assert.notEqual(fixture.allStats()[1].nonce, record.nonce);
  record.requests.length = 0; assert.equal(fixture.allStats()[0].requests.length, 5);
  for (let index = 5; index < 64; index++) assert.equal(request(fixture, "/snapshot-geometry?key=one").status, 200);
  assert.equal(request(fixture, "/snapshot-geometry?key=one").status, 429); assert.equal(fixture.allStats()[0].overflow, true);
});

test("caller preserves an unknown finalize outcome without issuing a second finalize", async () => {
  let finalizes = 0, closed = 0;
  const capture = sample().capture;
  const tab = { id: 77, goto: async () => {}, evaluate: async () => ({}), snapshotAI: async () => capture, screenshot: async () => ({}),
    getByRef: (_id, ref) => ({ count: async () => 1, innerText: async () => { const line = capture.snapshot.split("\n").find(line => line.includes(`[ref=${ref}]`)); return /button "([^"]+)"/.exec(line)[1]; } }) };
  const browser = { client: { turnId: "turn", controlEpoch: 1, beginTurn: async () => ({}), finalizeTabs: async () => { finalizes++; throw new Error("response lost"); } }, newTab: async () => tab, cdp: { call: async () => {} }, close: () => closed++ };
  await assert.rejects(checkGeometryCaller({ kind: "js", key: "unit", endpoint: "unused", fixtureURL: "http://127.0.0.1:4567/", expectedDPR: 1, connectOpenBrowserUse: async () => browser }), /response lost/);
  assert.equal(finalizes, 1); assert.equal(closed, 1);
});

test("startup DPR is explicit, enum-limited and rejected outside the opt-in geometry mode", () => {
  assert.equal(resolveGeometryDPR(undefined, false), undefined);
  for (const value of ["1", "1.5", "2"]) assert.equal(resolveGeometryDPR(value, true), Number(value));
  for (const value of [undefined, "", "01", "1.0", "3", "NaN", "1 --headless"]) assert.throws(() => resolveGeometryDPR(value, true));
  for (const value of ["1", "1.5", "2", ""]) assert.throws(() => resolveGeometryDPR(value, false));
});

test("all phases use the fixed startup DPR and issue no dynamic metrics commands", async () => {
  const operations = [], capture = sample().capture;
  const tab = { id: 77, goto: async () => {}, evaluate: async () => ({}), snapshotAI: async () => capture, screenshot: async () => ({}),
    getByRef: (_id, ref) => ({ count: async () => 1, innerText: async () => /button "([^"]+)"/.exec(capture.snapshot.split("\n").find(line => line.includes(`[ref=${ref}]`)))[1] }) };
  const browser = { client: { turnId: "turn", controlEpoch: 1, beginTurn: async () => ({}), finalizeTabs: async () => ({}) }, newTab: async () => tab, cdp: { call: async method => operations.push(method) }, close() {} };
  const result = await checkGeometryCaller({ kind: "js", key: "unit", endpoint: "unused", fixtureURL: "http://127.0.0.1:4567/", expectedDPR: 1.5, connectOpenBrowserUse: async () => browser });
  assert.deepEqual(result.phases.map(item => item.dpr), [1.5, 1.5, 1.5]); assert.equal(result.expectedDPR, 1.5);
  assert.deepEqual(operations, []); assert.ok(result.trace.every(item => !item.operation.startsWith("Emulation.")));
});
