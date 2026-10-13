import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import vm from "node:vm";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { checkZoomBusiness, checkZoomFeedback, checkZoomVisible, createZoomFeedbackFixtures, measureZoomPixels, waitForZoomFeedback } from "./zoom-feedback-fixture.mjs";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const center = rect => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
const geometry = (zoom = 1, dpr = 1) => ({ button: { x: 62 * zoom, y: 150 * zoom, width: 416 * zoom, height: 72 * zoom },
  panel: { x: 40 * zoom, y: 32 * zoom, width: 460 * zoom, height: 312 * zoom }, viewport: { width: 800, height: 600, dpr } });
function chunk(type, bytes) {
  const size = Buffer.alloc(4), crc = Buffer.alloc(4), body = Buffer.concat([Buffer.from(type), bytes]); size.writeUInt32BE(bytes.length);
  let value = 0xffffffff; for (const byte of body) { value ^= byte; for (let i = 0; i < 8; i++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0); }
  crc.writeUInt32BE((value ^ 0xffffffff) >>> 0); return Buffer.concat([size, body, crc]);
}
function png(state, { cursor = true, sides = ["top", "bottom", "left", "right"], offset = 0 } = {}) {
  const { button, viewport } = state, c = center(button), width = viewport.width * viewport.dpr, height = viewport.height * viewport.dpr, rows = Buffer.alloc((width * 3 + 1) * height, 238);
  for (let y = 0; y < height; y++) { rows[y * (width * 3 + 1)] = 0; for (let x = 0; x < width; x++) {
    const px = (x + .5) / viewport.dpr - offset, py = (y + .5) / viewport.dpr; let rgb;
    if (cursor && Math.abs(px - c.x) < 5 && Math.abs(py - c.y) < 6) rgb = [20, 20, 20];
    if ((sides.includes("top") && Math.abs(py - button.y) < 1 || sides.includes("bottom") && Math.abs(py - button.y - button.height) < 1) && px >= button.x && px <= button.x + button.width ||
      (sides.includes("left") && Math.abs(px - button.x) < 1 || sides.includes("right") && Math.abs(px - button.x - button.width) < 1) && py >= button.y && py <= button.y + button.height) rgb = [79, 140, 255];
    if (rgb) for (let channel = 0; channel < 3; channel++) rows[y * (width * 3 + 1) + x * 3 + channel + 1] = rgb[channel];
  } }
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}
function visibleItem(state) {
  const c = center(state.button); return { originalButtonRect: state.button, rendered: { feedback: { cursor: { x: c.x - 20, y: c.y - 20, width: 40, height: 40 }, target: state.button } },
    submitRing: { rect: { x: c.x - 14, y: c.y - 14, width: 28, height: 28 } } };
}

test("pixel ROIs adapt to original 150/75 percent rectangles and DPR, requiring cursor plus all four edges", () => {
  for (const zoom of [1.5, .75]) for (const dpr of [1, 1.25, 2]) {
    const state = geometry(zoom, dpr), bytes = png(state), item = { ...visibleItem(state), pixels: measureZoomPixels(bytes, state) };
    checkZoomVisible(item); assert.equal(item.pixels.sha256, sha(bytes)); assert.equal(item.pixels.scale, dpr);
    for (const options of [{ cursor: false }, { sides: ["top", "bottom", "left"] }, { offset: 100 }]) assert.throws(() => checkZoomVisible({ ...item, pixels: measureZoomPixels(png(state, options), state) }), /pixels missing/);
  }
  assert.throws(() => measureZoomPixels(png(geometry()), { ...geometry(), panel: { x: 70, y: 32, width: 450, height: 312 } }), /inside original opaque panel/);
});

test("renderer wait accepts model arrival even while visible rectangle is zoom-misplaced", async () => {
  const state = { ...geometry(), rings: [], feedback: { modelPoint: center(geometry().button), cursor: { x: 999, y: 999, width: 60, height: 60 } } };
  const context = { document: { getElementById: () => null, fonts: { ready: Promise.resolve() }, images: [] }, window: { zoomFeedbackState: () => state }, setTimeout, clearTimeout };
  assert.equal(await new vm.Script(`(${waitForZoomFeedback.toString()})()`).runInNewContext(context), state);
  const original = Error("original read failed"); context.window.zoomFeedbackState = () => { throw original; };
  await assert.rejects(new vm.Script(`(${waitForZoomFeedback.toString()})()`).runInNewContext(context), error => error === original);
});

test("HTTP ledger binds literal original document bytes and ordered unique stages", async () => {
  const fixtures = createZoomFeedbackFixtures(), server = http.createServer((request, response) => {
    if (!fixtures.handle(request, response, new URL(request.url, `http://127.0.0.1:${server.address().port}`))) { response.writeHead(404); response.end(); }
  }); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`, key = `zoom-${"a".repeat(32)}`, url = `${base}/zoom-feedback/page?key=${key}&zoom=1.5&scope=html`;
    const html = await (await fetch(url)).text(); new vm.Script(html.match(/<script>([\s\S]*)<\/script>/)[1]); const record = fixtures.stats(key);
    assert.equal(record.get.sha256, sha(Buffer.from(html))); const body = { key, stage: "zoom150", trustedSubmit: true, snapshot: { documentToken: record.documentToken, href: url, value: "原文 π" } };
    const send = value => fetch(`${base}/zoom-feedback/post?key=${key}`, { method: "POST", body: JSON.stringify(value) });
    const response = await send(body); assert.equal(response.status, 200); const post = fixtures.stats(key).posts[0]; assert.equal(post.bodySHA256, sha(Buffer.from(JSON.stringify(body)))); assert.equal(post.bodyBase64, Buffer.from(JSON.stringify(body)).toString("base64"));
    assert.equal((await send({ ...body, stage: "zoomChanged", snapshot: { ...body.snapshot, documentToken: "foreign" } })).status, 400);
    assert.equal((await send(body)).status, 400); assert.equal(fixtures.stats(key).posts.length, 3);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

// These protocol doubles verify orchestration and oracle rejection only. The
// independent browser run establishes native trust and actual renderer pixels.
function workflow({ misplaced = false, receiptError } = {}) {
  const records = new Map(), calls = [], artifacts = [], tabs = []; let detail;
  const fixtures = { stats: key => structuredClone(records.get(key)), allStats: () => { calls.push("ledger"); return structuredClone([...records.values()]); } };
  const browser = { async newTab({ url }) {
    const address = new URL(url), key = address.searchParams.get("key"), zoomScope = address.searchParams.get("scope"), initialZoom = Number(address.searchParams.get("zoom")), documentToken = `document-${tabs.length}`;
    const record = { key, zoomScope, initialZoom, documentToken, get: { href: url }, posts: [] }; records.set(key, record);
    const events = [], focus = [], rings = [], changes = [], receipts = {}; let zoom = initialZoom, stage = zoomScope === "body" ? "body150" : zoom === 1.5 ? "zoom150" : "zoom075", value = "", activeElement = "";
    const add = (rows, row) => rows.push({ sequence: rows.length + 1, ...row });
    const state = () => { const dims = geometry(zoom), c = center(dims.button), offset = misplaced && zoomScope === "html" ? 100 : 0;
      return structuredClone({ key, documentToken, href: url, stage, zoomScope, zoom, rootZoom: zoomScope === "html" ? zoom : 1, bodyZoom: zoomScope === "body" ? zoom : 1, value, nodeToken: `${key}-node`, original: true, activeElement,
        selection: { start: value.length, end: value.length, direction: "forward" }, events, focus, rings, changes, errors: [], overflow: false, receipt: receipts[stage] ?? null, ...dims,
        feedback: { cursor: { x: c.x - 20 + offset, y: c.y - 20, width: 40, height: 40 }, target: { ...dims.button, x: dims.button.x + offset }, modelPoint: c, imageLoaded: true } }); };
    const locator = selector => ({ async fill(text) { value = text; activeElement = "note"; add(focus, { type: "focusin", targetId: "note", trusted: true }); add(events, { type: "input", stage, targetId: "note", trusted: true, value, nodeToken: `${key}-node` }); },
      async hover() { calls.push(`hover:${stage}`); }, async click() {
        const changing = selector === "#change-zoom", c = changing ? { x: 111, y: 444 } : center(state().button), offset = misplaced && zoomScope === "html" ? 100 : 0;
        calls.push(`click:${selector}:${stage}`); add(events, { type: "click", stage, trusted: true, targetId: changing ? "change-zoom" : "submit", ...c });
        add(rings, { stage, zoom: state().rootZoom, documentToken, rect: { x: c.x - 14 + offset, y: c.y - 14, width: 28, height: 28 }, modelPoint: c, color: "rgb(20, 184, 166)", opacity: 1 });
        if (changing) { add(changes, { trusted: true, targetId: "change-zoom", from: zoom, to: .75, documentToken }); zoom = .75; stage = "zoomChanged"; return; }
        add(events, { type: "submit", stage, trusted: true, targetId: "form" }); const body = { key, stage, trustedSubmit: true, snapshot: state() }, bytes = Buffer.from(JSON.stringify(body)), receipt = { key, stage, index: record.posts.length + 1, bodySHA256: sha(bytes) };
        record.posts.push({ value: body, bodyBytes: bytes.length, bodyBase64: bytes.toString("base64"), bodySHA256: sha(bytes), ...(receiptError ? { error: "Invalid original zoom receipt" } : { receipt }) }); if (!receiptError) receipts[stage] = receipt;
      }, async waitFor() { if (receiptError) throw receiptError; } });
    const tab = { id: tabs.length + 1, locator, getByText: locator, async evaluate() { return state(); }, async screenshot() { calls.push(`shot:${stage}`); return { mimeType: "image/png", base64: png(state(), { offset: misplaced && zoomScope === "html" ? 100 : 0 }).toString("base64") }; }, async close() { calls.push(`sdk-close:${tab.id}`); } }; tabs.push(tab); return tab;
  } };
  return { browser, fixtures, fixtureURL: "http://fixture/", calls, artifacts, async saveArtifact(name, bytes) { artifacts.push({ name, bytes }); }, async saveDetail(saved) { detail = structuredClone(saved); }, detail: () => detail };
}

test("misplaced baseline still records four original PNGs and four unique POSTs before strict visibility failure", async () => {
  const harness = workflow({ misplaced: true }); let ended = false;
  await assert.rejects(checkZoomFeedback({ ...harness, checkEnd: async () => { ended = true; } }), /cursor center is misplaced/);
  const detail = harness.detail(); assert.equal(ended, false); assert.deepEqual(detail.states.map(item => [item.stage, item.businessPassed, item.visible]), [["zoom150", true, false], ["zoomChanged", true, false], ["zoom075", true, false], ["body150", true, true]]);
  assert.equal(harness.artifacts.length, 4); assert.equal(detail.serverLedger.flatMap(page => page.posts).length, 4); assert.deepEqual(detail.tabIds, [1, 2, 3]);
  assert.equal(detail.states[0].before.documentToken, detail.states[1].after.documentToken); assert.equal(detail.states[0].before.nodeToken, detail.states[1].after.nodeToken);
  for (const item of detail.states) assert.ok(harness.calls.indexOf(`shot:${item.stage}`) < harness.calls.indexOf(`click:#submit:${item.stage}`));
  assert.equal(harness.calls.filter(call => call.startsWith("click:#submit:")).length, 4); assert.equal(harness.calls.filter(call => call.startsWith("click:#change-zoom:")).length, 1);
});

test("success ends before injected exact-tab cleanup, without implicit SDK restart", async () => {
  const harness = workflow(), order = [];
  const detail = await checkZoomFeedback({ ...harness, checkEnd: async value => { assert.equal(value.states.every(item => item.visible), true); order.push("end"); return { checked: true }; }, closeTab: async tab => { assert.equal(order[0], "end"); assert.ok(harness.calls.includes("ledger")); order.push(tab.id); } });
  assert.deepEqual(order, ["end", 1, 2, 3]); assert.equal(harness.calls.some(call => call.startsWith("sdk-close:")), false); assert.equal(detail.cleanup.length, 3);
});

test("receipt failure preserves rejected POST and original error before cleanup without replay", async () => {
  const original = Object.freeze(Error("original receipt timeout")), harness = workflow({ receiptError: original }), closed = [];
  await assert.rejects(checkZoomFeedback({ ...harness, closeTab: async tab => { closed.push(tab.id); throw Error("cleanup failed"); } }), error => error === original);
  const detail = harness.detail(); assert.equal(detail.serverLedger[0].posts.length, 1); assert.equal(detail.serverLedger[0].posts[0].error, "Invalid original zoom receipt"); assert.equal(harness.artifacts.length, 1); assert.deepEqual(closed, [1]);
  assert.equal(harness.calls.filter(call => call.startsWith("click:#submit:")).length, 1); assert.match(detail.error, /original receipt timeout/);
});

test("business and geometry oracles reject wrong ring provenance, movement, document replacement and pixel-only false positives", async () => {
  const harness = workflow(), detail = await checkZoomFeedback(harness), original = detail.states[0];
  for (const mutate of [item => item.rendered.focus.push({ type: "focusout" }), item => item.rendered.selection.start = 0, item => item.after.documentToken = "foreign", item => item.after.original = false,
    item => item.after.rings.at(-1).stage = "zoomChanged", item => item.after.rings.at(-1).zoom = .75, item => item.after.rings.at(-1).modelPoint.x += 40,
    item => item.after.rings.push(structuredClone(item.after.rings.at(-1))), item => item.after.events.find(row => row.type === "click").trusted = false, item => item.server.posts[0].bodySHA256 = "bad"])
    { const changed = structuredClone(original); mutate(changed); assert.throws(() => checkZoomBusiness(changed, changed.server)); }
  for (const mutate of [item => item.submitRing.rect.x += 20, item => item.rendered.feedback.cursor.y += 20, item => item.rendered.feedback.target.width *= .75]) {
    const changed = structuredClone(original); mutate(changed); assert.throws(() => checkZoomVisible(changed));
  }
});
