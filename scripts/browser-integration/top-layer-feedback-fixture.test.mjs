import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import vm from "node:vm";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { checkTopLayerBusiness, checkTopLayerFeedback, checkTopLayerPixels, createTopLayerFeedbackFixtures, measureTopLayerPixels } from "./top-layer-feedback-fixture.mjs";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const geometry = { button: { x: 140, y: 280, width: 500, height: 80 }, panel: { x: 100, y: 100, width: 600, height: 400 }, viewport: { width: 800, height: 600, dpr: 1 } };
function chunk(type, bytes) {
  const size = Buffer.alloc(4), crc = Buffer.alloc(4), body = Buffer.concat([Buffer.from(type), bytes]); size.writeUInt32BE(bytes.length);
  let value = 0xffffffff; for (const byte of body) { value ^= byte; for (let i = 0; i < 8; i++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0); }
  crc.writeUInt32BE((value ^ 0xffffffff) >>> 0); return Buffer.concat([size, body, crc]);
}
function png({ dpr = 1, cursor = true, outline = true, stray = false } = {}) {
  const width = 800 * dpr, height = 600 * dpr, rows = Buffer.alloc((width * 3 + 1) * height, 238);
  for (let y = 0; y < height; y++) { rows[y * (width * 3 + 1)] = 0; for (let x = 0; x < width; x++) {
    const px = (x + .5) / dpr, py = (y + .5) / dpr; let rgb;
    if (cursor && px >= 386 && px < 394 && py >= 314 && py < 326) rgb = [20, 20, 20];
    if (outline && px >= 140 && px < 640 && (py >= 280 && py < 282 || py >= 358 && py < 360)) rgb = [79, 140, 255];
    if (stray && px >= 20 && px < 70 && py >= 20 && py < 70) rgb = [79, 140, 255];
    if (rgb) for (let c = 0; c < 3; c++) rows[y * (width * 3 + 1) + x * 3 + c + 1] = rgb[c];
  } }
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

test("pixel evidence requires separate cursor and outline inside the opaque panel at actual PNG scale", () => {
  for (const dpr of [1, 1.25, 2]) {
    const bytes = png({ dpr }), result = measureTopLayerPixels(bytes, { ...geometry, viewport: { ...geometry.viewport, dpr } });
    checkTopLayerPixels(result); assert.equal(result.sha256, sha(bytes)); assert.equal(result.width, 800 * dpr); assert.equal(result.scale, dpr);
  }
  for (const options of [{ cursor: false }, { outline: false }, { cursor: false, outline: false, stray: true }]) assert.throws(() => checkTopLayerPixels(measureTopLayerPixels(png(options), geometry)), /pixels missing/);
  const badPanel = structuredClone(geometry); badPanel.panel.x = 145;
  assert.throws(() => measureTopLayerPixels(png(), badPanel), /inside opaque panel/);
  assert.throws(() => measureTopLayerPixels(png({ dpr: 2 }), geometry), /PNG scale/);
});

test("HTTP fixture retains original bytes and document identity, rejects duplicate stage and foreign document", async () => {
  const fixtures = createTopLayerFeedbackFixtures(), server = http.createServer((request, response) => {
    if (!fixtures.handle(request, response, new URL(request.url, `http://127.0.0.1:${server.address().port}`))) { response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`, key = `top-${"a".repeat(32)}`, url = `${base}/top-layer-feedback/page?key=${key}&page=modal`;
    const html = await (await fetch(url)).text(); new vm.Script(html.match(/<script>([\s\S]*)<\/script>/)[1]);
    assert.equal(fixtures.stats(key).get.sha256, sha(Buffer.from(html)));
    const state = fixtures.stats(key), body = { key, stage: "outer", trustedSubmit: true, snapshot: { documentToken: state.documentToken, href: url } };
    // HTTP units use synthetic flags; only the root-run browser establishes trust.
    const send = value => fetch(`${base}/top-layer-feedback/post?key=${key}`, { method: "POST", body: JSON.stringify(value) });
    const receipt = await (await send(body)).json(), post = fixtures.stats(key).posts[0];
    assert.deepEqual(post.value, body); assert.equal(post.bodyBase64, Buffer.from(JSON.stringify(body)).toString("base64")); assert.equal(receipt.bodySHA256, sha(Buffer.from(JSON.stringify(body))));
    assert.equal((await send(body)).status, 400);
    assert.equal((await send({ ...body, stage: "inner", snapshot: { ...body.snapshot, documentToken: "foreign" } })).status, 400);
    assert.equal(fixtures.stats(key).posts.length, 3);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

// Protocol doubles verify orchestration, failure order and byte-oracle mutations;
// they deliberately do not claim real native input or browser rendering evidence.
function workflow({ visible = false, hoverError, receiptError } = {}) {
  const records = new Map(), calls = [], saved = [], artifacts = [], tabs = []; let lastDetail;
  const fixtures = { stats: key => structuredClone(records.get(key)), allStats: () => { calls.push("server-ledger"); return structuredClone([...records.values()]); } };
  const browser = { async newTab({ url }) {
    const address = new URL(url), key = address.searchParams.get("key"), page = address.searchParams.get("page"), documentToken = `document-${tabs.length}`;
    const record = { key, page, documentToken, get: { href: url }, posts: [] }; records.set(key, record);
    const events = [], focus = [], toggles = [], capturedToggles = [], values = {}, receipts = {}; let stage, activeElement;
    const layers = { outer: null, inner: null, manual: null, auto: null };
    for (const id of page === "modal" ? ["outer", "inner"] : ["manual", "auto"]) layers[id] = { open: false, modal: false };
    const add = (rows, row) => rows.push({ sequence: rows.length + 1, ...row });
    const state = name => structuredClone({ key, documentToken, href: url, stage: name, value: values[name], nodeToken: `${key}-${name}-node`, original: true,
      activeElement, selection: { start: values[name]?.length, end: values[name]?.length, direction: "forward" }, layers, events, focus, toggles, capturedToggles, overflow: false, errors: [], receipt: receipts[name] ?? null, ...geometry });
    const locator = selector => ({ async hover() { calls.push(`hover:${selector}`); if (hoverError && selector.endsWith("-submit")) throw hoverError; },
      async fill(value) { stage = selector.slice(1, -6); values[stage] = value; activeElement = selector.slice(1); add(focus, { type: "focusin", trusted: true, targetId: activeElement }); add(events, { type: "input", trusted: true, targetId: activeElement, nodeToken: `${key}-${stage}-node`, value }); },
      async click() {
        calls.push(`click:${selector}`); add(events, { type: "click", trusted: true, targetId: selector.slice(1), nodeToken: null, value: null });
        if (selector.startsWith("#open-")) { const id = selector.slice(6); layers[id].open = true; layers[id].modal = ["outer", "inner"].includes(id);
          for (const type of ["beforetoggle", "toggle"]) { add(toggles, { type, id, oldState: "closed", newState: "open", trusted: true }); for (const scope of ["document", "window"]) add(capturedToggles, { scope, type, targetId: id, oldState: "closed", newState: "open", trusted: true }); } return; }
        add(events, { type: "submit", trusted: true, targetId: `${stage}-form`, nodeToken: null, value: null });
        const value = { key, stage, trustedSubmit: true, snapshot: state(stage) }, bytes = Buffer.from(JSON.stringify(value));
        const receipt = { key, stage, index: record.posts.length + 1, bodySHA256: sha(bytes) };
        record.posts.push({ method: "POST", index: receipt.index, bodyBytes: bytes.length, bodyBase64: bytes.toString("base64"), bodySHA256: sha(bytes), value,
          ...(receiptError ? { error: "Invalid original form receipt" } : { receipt }) }); if (!receiptError) receipts[stage] = receipt;
      }, async waitFor() { calls.push("receipt"); if (receiptError) throw receiptError; } });
    const tab = { id: tabs.length + 1, locator, getByText: locator, async evaluate(expression) { const match = expression.match(/^window\.topLayerState\("(\w+)"\)$/); return match ? state(match[1]) : true; },
      async screenshot() { calls.push(`screenshot:${stage}`); return { mimeType: "image/png", base64: png({ cursor: visible, outline: visible }).toString("base64") }; }, async close() { calls.push(`close:${tab.id}`); } };
    tabs.push(tab); return tab;
  } };
  return { browser, fixtureURL: "http://fixture/", fixtures, calls, saved, artifacts,
    async saveArtifact(name, bytes) { artifacts.push({ name, bytes }); }, async saveDetail(detail) { lastDetail = detail; saved.push(structuredClone(detail)); }, detail: () => lastDetail };
}

test("hidden baseline captures all three original screenshots and unique POSTs before final failure, without calling turn-end", async () => {
  const harness = workflow(); let ended = false;
  await assert.rejects(checkTopLayerFeedback({ ...harness, checkEnd: async () => { ended = true; } }), /cursor pixels missing/);
  const detail = harness.detail(); assert.equal(ended, false); assert.deepEqual(detail.states.map(item => [item.stage, item.businessPassed, item.visible]), [["outer", true, false], ["inner", true, false], ["popover", true, false]]);
  assert.equal(harness.artifacts.length, 3); assert.equal(detail.pages.flatMap(page => page.server.posts).length, 3); assert.deepEqual(detail.tabIds, [1, 2]);
  assert.deepEqual(harness.calls.filter(call => call.startsWith("click:") && call.endsWith("-submit")), ["click:#outer-submit", "click:#inner-submit", "click:#popover-submit"]);
  for (const stage of ["outer", "inner", "popover"]) assert.ok(harness.calls.indexOf(`screenshot:${stage}`) < harness.calls.indexOf(`click:#${stage}-submit`));
  assert.deepEqual(detail.cleanup, [{ tabId: 1, closed: true }, { tabId: 2, closed: true }]);
});

test("successful workflow invokes optional end check before closing exact tabs", async () => {
  const harness = workflow({ visible: true });
  const detail = await checkTopLayerFeedback({ ...harness, checkEnd: async value => { assert.equal(value.states.every(item => item.visible), true); assert.equal(harness.calls.some(call => call.startsWith("close:")), false); return { checked: true }; } });
  assert.deepEqual(detail.end, { checked: true }); assert.equal(detail.states.length, 3); assert.equal(detail.cleanup.length, 2);
});

test("injected cleanup runs after turn end for exact created tabs without SDK close", async () => {
  const harness = workflow({ visible: true }), order = [];
  const detail = await checkTopLayerFeedback({ ...harness,
    checkEnd: async value => { order.push("ended"); assert.deepEqual(value.tabIds, [1, 2]); return { ended: true }; },
    closeTab: async tab => { assert.equal(order[0], "ended"); assert.ok(harness.calls.includes("server-ledger")); order.push(tab.id); }
  });
  assert.deepEqual(order, ["ended", 1, 2]); assert.equal(harness.calls.some(call => call.startsWith("close:")), false);
  assert.deepEqual(detail.cleanup, [{ tabId: 1, closed: true }, { tabId: 2, closed: true }]);
});

test("injected cleanup still runs after end-check failure and cannot replace its original error", async () => {
  const harness = workflow({ visible: true }), original = Error("original end-check failure"), closed = [];
  await assert.rejects(checkTopLayerFeedback({ ...harness,
    checkEnd: async () => { throw original; },
    closeTab: async tab => { closed.push(tab.id); if (tab.id === 1) throw Error("native close failed"); }
  }), error => error === original);
  assert.deepEqual(closed, [1, 2]); assert.equal(harness.calls.some(call => call.startsWith("close:")), false);
  assert.match(harness.detail().cleanup[0].error, /native close failed/); assert.equal(harness.detail().cleanup[1].closed, true);
  assert.match(harness.detail().error, /original end-check failure/); assert.equal(harness.detail().serverLedger.length, 2);
});

test("first public input failure is preserved without submitting, replaying or leaking the original tab", async () => {
  const failure = Error("original hover failure"), harness = workflow({ hoverError: failure });
  await assert.rejects(checkTopLayerFeedback(harness), error => error === failure);
  assert.equal(harness.calls.filter(call => call === "hover:#outer-submit").length, 1); assert.equal(harness.calls.some(call => call === "click:#outer-submit"), false);
  assert.deepEqual(harness.detail().cleanup, [{ tabId: 1, closed: true }]); assert.match(harness.detail().error, /original hover failure/);
});

test("failed receipt wait retains the original rejected POST ledger before cleanup and preserves the first failure", async () => {
  const failure = Error("original receipt wait timeout"), harness = workflow({ receiptError: failure });
  await assert.rejects(checkTopLayerFeedback(harness), error => error === failure);
  const detail = harness.detail(); assert.equal(detail.serverLedger.length, 1); assert.equal(detail.serverLedger[0].posts.length, 1);
  const post = detail.serverLedger[0].posts[0], bytes = Buffer.from(post.bodyBase64, "base64");
  assert.equal(post.error, "Invalid original form receipt"); assert.equal(post.receipt, undefined); assert.equal(post.bodyBytes, bytes.length);
  assert.equal(post.bodySHA256, sha(bytes)); assert.deepEqual(post.value, JSON.parse(bytes.toString("utf8")));
  assert.equal(post.value.snapshot.documentToken, detail.serverLedger[0].documentToken);
  assert.equal(harness.calls.filter(call => call === "click:#outer-submit").length, 1);
  assert.ok(harness.calls.indexOf("server-ledger") < harness.calls.indexOf("close:1"));
  assert.deepEqual(detail.cleanup, [{ tabId: 1, closed: true }]); assert.match(detail.error, /original receipt wait timeout/);
});

test("business oracle rejects focus/selection movement, leaked agent toggle, hidden reopen, untrusted input and wrong raw POST", async () => {
  const harness = workflow({ visible: true }), detail = await checkTopLayerFeedback(harness), original = detail.states[0];
  const mutations = [item => item.rendered.focus.push({ type: "focusout" }), item => item.rendered.selection.start = 0,
    item => item.after.capturedToggles.push({ targetId: "open-browser-use-cursor-root" }), item => item.after.toggles.push({ type: "toggle", newState: "closed" }),
    item => item.after.events.find(row => row.type === "input").trusted = false, item => item.after.documentToken = "foreign",
    item => item.server.posts[0].bodySHA256 = "bad", item => item.server.posts.push(structuredClone(item.server.posts[0]))];
  for (const mutate of mutations) { const item = structuredClone(original); mutate(item); assert.throws(() => checkTopLayerBusiness(item, item.server)); }
});
