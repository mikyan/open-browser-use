import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import vm from "node:vm";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { listenFixture } from "./fixture-listener.mjs";
import { checkDOMRebuildBusiness, checkDOMRebuildFeedback, checkDOMRebuildVisible, createDOMRebuildFeedbackFixtures, domRebuildStages, waitForDOMRebuildFeedback } from "./dom-rebuild-feedback-fixture.mjs";

const sha = bytes => createHash("sha256").update(bytes).digest("hex"), center = r => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
const geometry = { button: { x: 62, y: 150, width: 416, height: 72 }, panel: { x: 40, y: 32, width: 460, height: 312 }, viewport: { width: 800, height: 600, dpr: 1 } };
function chunk(type, bytes) {
  const size = Buffer.alloc(4), crc = Buffer.alloc(4), body = Buffer.concat([Buffer.from(type), bytes]); size.writeUInt32BE(bytes.length);
  let value = 0xffffffff; for (const byte of body) { value ^= byte; for (let i = 0; i < 8; i++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0); }
  crc.writeUInt32BE((value ^ 0xffffffff) >>> 0); return Buffer.concat([size, body, crc]);
}
function png(visible = true) {
  const width = 800, height = 600, rows = Buffer.alloc((width * 3 + 1) * height, 238), b = geometry.button, c = center(b);
  for (let y = 0; y < height; y++) { rows[y * (width * 3 + 1)] = 0; for (let x = 0; x < width; x++) {
    let rgb;
    if (visible && Math.abs(x - c.x) < 5 && Math.abs(y - c.y) < 6) rgb = [20, 20, 20];
    if (visible && ((y === b.y || y === b.y + b.height) && x >= b.x && x <= b.x + b.width || (x === b.x || x === b.x + b.width) && y >= b.y && y <= b.y + b.height)) rgb = [79, 140, 255];
    if (rgb) for (let i = 0; i < 3; i++) rows[y * (width * 3 + 1) + x * 3 + i + 1] = rgb[i];
  } }
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

// Protocol doubles verify orchestration and independent rejection paths. Only
// the separate original browser run proves native trust and renderer pixels.
function workflow({ detached = false, missingRing = false, receiptError } = {}) {
  const records = new Map(), calls = [], artifacts = [], tabs = []; let saved;
  const fixtures = { stats: key => structuredClone(records.get(key)), allStats: () => { calls.push("ledger"); return structuredClone([...records.values()]); } };
  const browser = { async newTab({ url }) {
    const address = new URL(url), key = address.searchParams.get("key"), stage = address.searchParams.get("stage"), documentToken = `document-${tabs.length}`, windowToken = `window-${tabs.length}`;
    const record = { key, stage, documentToken, get: { href: url }, posts: [] }; records.set(key, record);
    const events = [], focus = [], changes = [], rings = []; let rebuilt = false, value = "", activeElement = "", receipt = null;
    const connected = () => !detached || stage === "body-only" || !rebuilt, rootIndex = () => rebuilt && connected() && stage !== "body-only" ? 1 : 0;
    const add = (rows, row) => rows.push({ sequence: rows.length + 1, ...row });
    const ids = ["note", "form", "submit", "panel", "rebuild"], token = id => `${key}-${rebuilt ? "rebuilt" : "original"}-${id}`;
    const state = () => { const point = center(geometry.button); return structuredClone({ key, stage, documentToken, windowToken, href: url, sameDocument: true, sameWindow: true, rebuilt,
      htmlSame: !rebuilt || stage !== "root-replacement", bodySame: !rebuilt || stage === "body-only", oldHTMLConnected: !rebuilt || stage !== "root-replacement", oldBodyConnected: !rebuilt || stage === "body-only",
      oldNodes: ids.map(id => ({ id, connected: !rebuilt, current: !rebuilt, token: `${key}-original-${id}` })), nodes: ids.map(id => ({ id, connected: true, token: token(id) })),
      value, nodeToken: token("note"), activeElement, selection: { start: value.length, end: value.length, direction: "forward" }, events, focus, changes, rings, errors: [], overflow: false, receipt, ...geometry,
      feedback: { observedConnected: true, connected: connected(), currentRoot: connected(), currentCount: connected() ? 1 : 0, rootIndex: rootIndex(), rootCount: rootIndex() + 1,
        cursor: { x: point.x - 20, y: point.y - 20, width: 40, height: 40 }, target: geometry.button, modelPoint: point } }); };
    const click = selector => {
      calls.push(`click:${stage}:${selector}`); const id = selector.slice(1), point = id === "submit" ? center(geometry.button) : { x: 250, y: 300 };
      add(events, { type: "click", targetId: id, trusted: true, rebuilt, nodeToken: token(id), ...point });
      if (!missingRing || id !== "submit") add(rings, { stage, rebuilt, documentToken, rootIndex: rootIndex(), connected: connected(), currentRoot: connected(), rect: { x: point.x - 14, y: point.y - 14, width: 28, height: 28 }, modelPoint: point, color: "rgb(20, 184, 166)", opacity: 1 });
      if (id === "rebuild") { add(changes, { trusted: true, targetId: id, nodeToken: token(id), stage, documentToken, windowToken }); rebuilt = true; return; }
      add(events, { type: "submit", targetId: "form", trusted: true, rebuilt, nodeToken: token("form") }); const body = { key, stage, trustedSubmit: true, snapshot: state() }, bytes = Buffer.from(JSON.stringify(body));
      const reply = { key, stage, index: 1, bodySHA256: sha(bytes) }; record.posts.push({ bodyBytes: bytes.length, bodyBase64: bytes.toString("base64"), bodySHA256: sha(bytes), value: body, ...(receiptError ? { error: "receipt rejected" } : { receipt: reply }) }); if (!receiptError) receipt = reply;
    };
    const locator = selector => ({ async hover() { calls.push(`hover:${stage}:${selector}`); }, async press(key) { assert.equal(selector, "#rebuild"); assert.equal(key, "Enter"); calls.push(`press:${stage}:${key}`); click(selector); }, async click() { click(selector); },
      async fill(text) { value = text; activeElement = "note"; add(focus, { type: "focusin", targetId: "note", trusted: true, rebuilt }); add(events, { type: "input", targetId: "note", trusted: true, rebuilt, nodeToken: token("note"), value }); }, async waitFor() { if (receiptError) throw receiptError; } });
    const tab = { id: tabs.length + 1, locator, getByText: locator, async evaluate() { return state(); }, async screenshot() { calls.push(`shot:${stage}`); return { mimeType: "image/png", base64: png(connected()).toString("base64") }; }, async close() { calls.push(`sdk-close:${tab.id}`); } }; tabs.push(tab); return tab;
  } };
  return { browser, fixtures, fixtureURL: "http://fixture/", calls, artifacts, async saveArtifact(name, bytes) { artifacts.push({ name, bytes }); }, async saveDetail(detail) { saved = structuredClone(detail); }, detail: () => saved };
}

test("detached model arrival permits original evidence capture, not visibility acceptance", async () => {
  const state = { ...geometry, feedback: { connected: false, currentRoot: false, modelPoint: center(geometry.button) } };
  const context = { window: { domRebuildFeedbackState: () => state }, document: { fonts: { ready: Promise.resolve() } }, setTimeout, clearTimeout };
  assert.equal(await new vm.Script(`(${waitForDOMRebuildFeedback.toString()})()`).runInNewContext(context), state);
  const original = Error("original read failed"); context.window.domRebuildFeedbackState = () => { throw original; };
  await assert.rejects(new vm.Script(`(${waitForDOMRebuildFeedback.toString()})()`).runInNewContext(context), error => error === original);
});

test("old detached renderer records all three PNGs and unique original POSTs before strict failure", async () => {
  const harness = workflow({ detached: true }); let ended = false;
  await assert.rejects(checkDOMRebuildFeedback({ ...harness, checkEnd: async () => { ended = true; } }), /detached old root/);
  const detail = harness.detail(); assert.equal(ended, false); assert.deepEqual(detail.states.map(item => [item.stage, item.businessPassed, item.visible]), [["root-children", true, false], ["root-replacement", true, false], ["body-only", true, true]]);
  assert.equal(harness.artifacts.length, 3); assert.equal(detail.serverLedger.flatMap(page => page.posts).length, 3); assert.deepEqual(detail.tabIds, [1, 2, 3]);
  assert.equal(harness.calls.filter(call => call.startsWith("press:")).length, 1);
  for (const stage of domRebuildStages) { assert.equal(harness.calls.filter(call => call === `click:${stage}:#rebuild`).length, 1); assert.equal(harness.calls.filter(call => call === `click:${stage}:#submit`).length, 1); assert.ok(harness.calls.indexOf(`shot:${stage}`) < harness.calls.indexOf(`click:${stage}:#submit`)); }
});

test("missing transient rings fail only after all original business receipts and screenshots", async () => {
  const harness = workflow({ missingRing: true }); await assert.rejects(checkDOMRebuildFeedback(harness), /one new original submit ring/);
  assert.equal(harness.artifacts.length, 3); assert.equal(harness.detail().states.every(item => item.businessPassed), true); assert.equal(harness.detail().serverLedger.flatMap(page => page.posts).length, 3);
});

test("successful end precedes exact injected cleanup without new SDK turn", async () => {
  const harness = workflow(), order = [];
  await checkDOMRebuildFeedback({ ...harness, checkEnd: async detail => { assert.equal(detail.states.every(item => item.visible), true); order.push("end"); }, closeTab: async tab => { assert.equal(order[0], "end"); order.push(tab.id); } });
  assert.deepEqual(order, ["end", 1, 2, 3]); assert.equal(harness.calls.some(call => call.startsWith("sdk-close")), false);
});

test("receipt error retains raw ledger and first failure without replay despite cleanup failure", async () => {
  const original = Error("original receipt timeout"), harness = workflow({ receiptError: original });
  await assert.rejects(checkDOMRebuildFeedback({ ...harness, closeTab: async () => { throw Error("cleanup failed"); } }), error => error === original);
  const detail = harness.detail(); assert.equal(detail.serverLedger[0].posts.length, 1); assert.equal(harness.artifacts.length, 1); assert.match(detail.error, /original receipt timeout/); assert.match(detail.cleanup[0].error, /cleanup failed/);
  assert.equal(harness.calls.filter(call => call.endsWith(":#submit") && call.startsWith("click:")).length, 1);
});

test("oracles reject foreign document/window/node, untrusted rebuild, ring misassociation and pixel-only false passes", async () => {
  const harness = workflow(), detail = await checkDOMRebuildFeedback(harness), original = detail.states[0];
  for (const mutate of [item => item.after.documentToken = "foreign", item => item.after.windowToken = "foreign", item => item.after.sameDocument = false, item => item.after.oldNodes[0].connected = true,
    item => item.after.nodes[0].token = "old", item => item.after.changes[0].trusted = false, item => item.rendered.focus.push({ type: "focusout" }), item => item.rendered.selection.start = 0,
    item => item.server.posts[0].bodySHA256 = "wrong", item => item.after.events.find(row => row.type === "submit").trusted = false]) {
    const changed = structuredClone(original); mutate(changed); assert.throws(() => checkDOMRebuildBusiness(changed, changed.server));
  }
  for (const mutate of [item => item.rendered.feedback.connected = false, item => item.rendered.feedback.currentCount = 2, item => item.rendered.feedback.rootIndex = item.initial.feedback.rootIndex,
    item => item.pixels.cursorDark = 0, item => item.pixels.edges.right = 0, item => item.rendered.feedback.cursor.x += 40, item => item.submitRings[0].modelPoint.x += 50,
    item => item.submitRings[0].connected = false, item => item.submitRings[0].rootIndex += 1, item => item.submitRings.push(structuredClone(item.submitRings[0]))]) {
    const changed = structuredClone(original); mutate(changed); assert.throws(() => checkDOMRebuildVisible(changed));
  }
});

test("HTTP receipts bind original HTML, exact bytes, stage and one document without accepting duplicates", async () => {
  const fixtures = createDOMRebuildFeedbackFixtures(), server = http.createServer((request, response) => { if (!fixtures.handle(request, response, new URL(request.url, `http://127.0.0.1:${server.address().port}`))) { response.writeHead(404); response.end(); } });
  await listenFixture(server);
  try {
    const base = `http://127.0.0.1:${server.address().port}`, key = `rebuild-${"a".repeat(32)}`, url = `${base}/dom-rebuild-feedback/page?key=${key}&stage=root-children`;
    const html = await (await fetch(url)).text(); new vm.Script(html.match(/<script>([\s\S]*)<\/script>/)[1]); const record = fixtures.stats(key); assert.equal(record.get.sha256, sha(Buffer.from(html)));
    const body = { key, stage: "root-children", trustedSubmit: true, snapshot: { documentToken: record.documentToken, href: url, value: "原文 π" } }, bytes = Buffer.from(JSON.stringify(body));
    const send = value => fetch(`${base}/dom-rebuild-feedback/post?key=${key}`, { method: "POST", body: JSON.stringify(value) });
    assert.equal((await send(body)).status, 200); assert.equal(fixtures.stats(key).posts[0].bodySHA256, sha(bytes)); assert.equal(fixtures.stats(key).posts[0].bodyBase64, bytes.toString("base64"));
    assert.equal((await send(body)).status, 400); assert.equal(fixtures.stats(key).posts.length, 2); assert.equal((await fetch(url)).status, 400);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
