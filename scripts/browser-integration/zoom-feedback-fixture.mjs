import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { decodeParallelPNG } from "./background-parallel-workflow.mjs";

const path = "/zoom-feedback/", stages = ["zoom150", "zoomChanged", "zoom075", "body150"];
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const errorText = error => error?.stack ?? String(error);
const center = rect => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
const near = (actual, expected, message) => { for (const key of Object.keys(expected)) assert.ok(Number.isFinite(actual?.[key]) && Math.abs(actual[key] - expected[key]) <= 1, `${message}: ${key}`); };

// Original application listeners and passive geometry recording. No feedback
// node, style, animation, input, focus or selection is modified by observation.
export function installZoomEvidence(key, documentToken, initialZoom, zoomScope) {
  const input = document.getElementById("note"), form = document.getElementById("form"), button = document.getElementById("submit"), panel = document.getElementById("panel");
  const events = [], focus = [], rings = [], changes = [], errors = [], receipts = {}, seen = new WeakSet(); let overflow = false, stage = zoomScope === "body" ? "body150" : initialZoom === 1.5 ? "zoom150" : "zoom075", tree;
  const add = (rows, row) => { if (rows.length >= 128) overflow = true; else rows.push({ sequence: rows.length + 1, at: performance.now(), ...row }); };
  const box = node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
  const observeRings = () => {
    const root = document.getElementById("open-browser-use-cursor-root"), current = root?.shadowRoot ?? root;
    if (current && current !== tree) { tree = current; new MutationObserver(observeRings).observe(tree, { childList: true, subtree: true }); }
    for (const ring of tree?.querySelectorAll('[data-testid="browser-agent-click"]') ?? []) if (!seen.has(ring)) {
      seen.add(ring); const style = getComputedStyle(ring);
      add(rings, { stage, documentToken, zoom: Number(getComputedStyle(document.documentElement).zoom), rect: box(ring), modelPoint: { x: parseFloat(ring.style.left), y: parseFloat(ring.style.top) }, color: style.borderTopColor, opacity: Number(style.opacity) });
    }
  };
  new MutationObserver(observeRings).observe(document.documentElement, { childList: true, subtree: true }); observeRings();
  window.zoomFeedbackState = () => {
    const root = document.getElementById("open-browser-use-cursor-root"), feedback = root?.shadowRoot ?? root;
    const cursor = feedback?.querySelector('[data-testid="browser-agent-cursor"]'), target = feedback?.querySelector('[data-testid="browser-agent-target"]');
    const translate = cursor?.style.transform.match(/^translate3d\(([-\d.]+)px,\s*([-\d.]+)px,/);
    return { key, documentToken, href: location.href, stage, zoomScope, zoom: Number(getComputedStyle(zoomScope === "body" ? document.body : document.documentElement).zoom), rootZoom: Number(getComputedStyle(document.documentElement).zoom), bodyZoom: Number(getComputedStyle(document.body).zoom), value: input.value, nodeToken: input.dataset.token,
      original: [input, form, button, panel].every(node => node.isConnected) && input === document.getElementById("note") && form === document.getElementById("form") && button === document.getElementById("submit") && panel === document.getElementById("panel"),
      activeElement: document.activeElement?.id ?? "", selection: { start: input.selectionStart, end: input.selectionEnd, direction: input.selectionDirection },
      events: structuredClone(events), focus: structuredClone(focus), rings: structuredClone(rings), changes: structuredClone(changes), overflow, errors: [...errors], receipt: receipts[stage] ?? null,
      button: box(button), panel: box(panel), viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
      feedback: { cursor: cursor ? box(cursor) : null, target: target && getComputedStyle(target).display !== "none" ? box(target) : null,
        modelPoint: translate ? { x: Number(translate[1]) + parseFloat(cursor.style.width) / 2, y: Number(translate[2]) + parseFloat(cursor.style.height) / 2 } : null, imageLoaded: !!cursor?.querySelector("img")?.naturalWidth } };
  };
  for (const type of ["input", "click", "submit"]) document.addEventListener(type, event => add(events, { type, stage, trusted: event.isTrusted, targetId: event.target.id, nodeToken: event.target.dataset?.token ?? null,
    value: event.target.value ?? null, ...(type === "click" ? { x: event.clientX, y: event.clientY } : {}) }), { capture: true, passive: true });
  for (const type of ["focusin", "focusout"]) document.addEventListener(type, event => add(focus, { type, stage, trusted: event.isTrusted, targetId: event.target.id }), { capture: true, passive: true });
  document.getElementById("change-zoom").addEventListener("click", event => {
    add(changes, { trusted: event.isTrusted, targetId: event.target.id, from: Number(getComputedStyle(document.documentElement).zoom), to: .75, documentToken });
    document.documentElement.style.zoom = ".75"; stage = "zoomChanged";
  });
  form.addEventListener("submit", event => {
    event.preventDefault(); const submittedStage = stage, body = { key, stage, trustedSubmit: event.isTrusted, snapshot: window.zoomFeedbackState() };
    fetch(`/zoom-feedback/post?key=${key}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      .then(response => { if (!response.ok) throw Error(`Receipt HTTP ${response.status}`); return response.json(); })
      .then(receipt => { receipts[submittedStage] = receipt; document.getElementById("receipt").textContent = `Saved ${submittedStage} ${receipt.bodySHA256}`; })
      .catch(error => errors.push(String(error)));
  });
}

export function zoomFeedbackHTML(key, documentToken, zoom, zoomScope = "html") {
  return `<!doctype html><html style="zoom:${zoomScope === "html" ? zoom : 1}"><meta charset="utf-8"><title>Original zoom form</title><style>
  *{box-sizing:border-box}body{zoom:${zoomScope === "body" ? zoom : 1};margin:0;background:#fff;color:#222;font:16px Arial,sans-serif}
  #panel{margin:32px 40px;padding:20px;width:460px;background:#eee;border:2px solid #555}h1{font-size:18px;margin:0 0 8px}
  label,input,button,output{display:block}input{width:100%;height:40px;margin:6px 0 12px;padding:8px;font:16px Arial}
  button{appearance:none;background:#ddd;color:#222;border:2px solid #777;border-radius:0;width:100%;height:72px;text-align:left;padding-left:12px;font:16px Arial}
  button:focus,input:focus,button:focus-visible,input:focus-visible{outline:2px solid #555;outline-offset:3px}
  output{font-size:8px;height:28px;padding-top:8px;overflow-wrap:anywhere}#change-zoom{height:32px;margin-top:8px}
  </style><section id="panel"><h1>Original zoom form</h1><form id="form"><label for="note">Zoom note</label><input id="note" data-token="${key}-node" autocomplete="off"><button id="submit" type="submit">Save</button><output id="receipt">Waiting</output></form><button id="change-zoom" type="button">Use 75% page scale</button></section>
  <script>(${installZoomEvidence.toString()})(${JSON.stringify(key)},${JSON.stringify(documentToken)},${zoom},${JSON.stringify(zoomScope)});</script></html>`;
}

export function createZoomFeedbackFixtures() {
  const records = new Map();
  return { stats: key => structuredClone(records.get(key)), allStats: () => structuredClone([...records.values()]), handle(request, response, url) {
    if (![`${path}page`, `${path}post`].includes(url.pathname)) return false;
    const key = url.searchParams.get("key"), zoom = Number(url.searchParams.get("zoom")), zoomScope = url.searchParams.get("scope") ?? "html";
    if (!/^zoom-[a-f0-9]{32}$/.test(key ?? "")) { response.writeHead(400); response.end(); return true; }
    if (url.pathname === `${path}page`) {
      if (request.method !== "GET" || ![1.5, .75].includes(zoom) || !["html", "body"].includes(zoomScope) || (zoomScope === "body" && zoom !== 1.5) || records.has(key) || records.size >= 8) { response.writeHead(400); response.end(); return true; }
      const documentToken = randomUUID(), bytes = Buffer.from(zoomFeedbackHTML(key, documentToken, zoom, zoomScope));
      records.set(key, { key, initialZoom: zoom, zoomScope, documentToken, get: { href: url.href, bytes: bytes.length, sha256: hash(bytes) }, posts: [] });
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }); response.end(bytes); return true;
    }
    const record = records.get(key);
    if (request.method !== "POST" || !record || record.posts.length >= 8) { response.writeHead(400); response.end(); return true; }
    const post = { method: request.method, index: record.posts.length + 1 }, chunks = []; let size = 0; record.posts.push(post);
    request.on("data", chunk => { size += chunk.length; if (size <= 65536) chunks.push(chunk); });
    request.once("error", () => { post.error = "HTTP request failed"; }); request.once("aborted", () => { post.error = "HTTP request aborted"; });
    request.once("end", () => {
      const bytes = Buffer.concat(chunks); Object.assign(post, { bodyBytes: size, bodyBase64: bytes.toString("base64"), bodySHA256: hash(bytes) });
      try {
        assert.ok(size <= 65536); post.value = JSON.parse(bytes.toString("utf8")); assert.equal(post.value.key, key);
        assert.equal(post.value.stage, (record.zoomScope === "body" ? ["body150"] : record.initialZoom === 1.5 ? ["zoom150", "zoomChanged"] : ["zoom075"])[post.index - 1]);
        assert.equal(post.value.snapshot.documentToken, record.documentToken); assert.equal(post.value.snapshot.href, record.get.href); assert.equal(post.value.trustedSubmit, true);
        post.receipt = { key, stage: post.value.stage, index: post.index, bodySHA256: post.bodySHA256 };
        response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify(post.receipt));
      } catch { post.error = "Invalid original zoom receipt"; response.writeHead(400); response.end(post.error); }
    }); return true;
  } };
}

// Renderer model arrival is intentionally independent of its visible rectangle.
// Waiting for the visible center would hide the zoom regression behind a timeout.
export async function waitForZoomFeedback(ringAfter = null) {
  return new Promise((resolve, reject) => {
    let poll, done = false;
    const finish = (error, state) => { if (done) return; done = true; clearTimeout(timer); clearTimeout(poll); error ? reject(error) : resolve(state); };
    const timer = setTimeout(() => finish(Error("Original zoom feedback model did not arrive")), 5000);
    const check = () => { if (done) return; try { const state = window.zoomFeedbackState(), point = state.feedback.modelPoint, rect = state.button;
      if (ringAfter !== null ? state.rings.length > ringAfter : point && Math.abs(point.x - rect.x - rect.width / 2) <= 1 && Math.abs(point.y - rect.y - rect.height / 2) <= 1) return finish(null, state);
      poll = setTimeout(check, 16);
    } catch (error) { finish(error); } };
    const root = document.getElementById("open-browser-use-cursor-root"), tree = root?.shadowRoot ?? root;
    const ready = ringAfter === null ? Promise.all([document.fonts.ready, ...[...document.images, ...(tree?.querySelectorAll("img") ?? [])].map(image => image.decode())]) : Promise.resolve();
    ready.then(check, error => finish(error));
  });
}

export function measureZoomPixels(bytes, { button, panel, viewport }) {
  const png = decodeParallelPNG(bytes), sx = png.width / viewport.width, sy = png.height / viewport.height;
  assert.ok(sx > 0 && sy > 0 && Math.abs(sx - sy) < .01 && Math.abs(sx - viewport.dpr) < .02, "Unexpected viewport PNG scale");
  for (const rect of [button, panel]) for (const key of ["x", "y", "width", "height"]) assert.ok(Number.isFinite(rect[key]));
  assert.ok(button.width >= 240 && button.height >= 48 && panel.x >= 0 && panel.y >= 0 && panel.x + panel.width <= viewport.width && panel.y + panel.height <= viewport.height);
  assert.ok(button.x - 4 > panel.x && button.y - 4 > panel.y && button.x + button.width + 4 < panel.x + panel.width && button.y + button.height + 4 < panel.y + panel.height, "ROIs must be inside original opaque panel");
  const c = center(button), edges = { top: 0, bottom: 0, left: 0, right: 0 }; let cursorDark = 0;
  for (let y = Math.floor((button.y - 3) * sy); y < Math.ceil((button.y + button.height + 3) * sy); y++) for (let x = Math.floor((button.x - 3) * sx); x < Math.ceil((button.x + button.width + 3) * sx); x++) {
    const px = (x + .5) / sx, py = (y + .5) / sy, [r, g, b] = png.pixel(x, y);
    if (Math.abs(px - c.x) <= 20 && Math.abs(py - c.y) <= 20) { if (Math.max(r, g, b) < 90) cursorDark++; }
    else if (b - r >= 35 && b - g >= 10) {
      if (px > button.x + button.width * .2 && px < button.x + button.width * .8) { if (Math.abs(py - button.y) <= 3) edges.top++; if (Math.abs(py - button.y - button.height) <= 3) edges.bottom++; }
      if (py > button.y + button.height * .2 && py < button.y + button.height * .8) { if (Math.abs(px - button.x) <= 3) edges.left++; if (Math.abs(px - button.x - button.width) <= 3) edges.right++; }
    }
  }
  return { width: png.width, height: png.height, byteLength: bytes.length, sha256: hash(bytes), cursorDark, edges, scale: sx };
}

export function checkZoomBusiness(item, record) {
  const posts = record.posts.filter(post => post.value?.stage === item.stage); assert.equal(posts.length, 1);
  const post = posts[0], bytes = Buffer.from(post.bodyBase64, "base64"); assert.equal(post.error, undefined); assert.equal(bytes.length, post.bodyBytes); assert.equal(hash(bytes), post.bodySHA256); assert.deepEqual(JSON.parse(bytes), post.value);
  for (const state of [item.before, item.rendered, item.after, post.value.snapshot]) {
    assert.equal(state.original, true); assert.equal(state.stage, item.stage); assert.equal(state.zoom, item.zoom); assert.equal(state.documentToken, record.documentToken); assert.equal(state.href, record.get.href); assert.equal(state.nodeToken, `${record.key}-node`);
    assert.equal(state.zoomScope, record.zoomScope); assert.equal(state.rootZoom, record.zoomScope === "body" ? 1 : item.zoom); assert.equal(state.bodyZoom, record.zoomScope === "body" ? item.zoom : 1);
    assert.equal(state.value, item.value); assert.equal(state.overflow, false); assert.deepEqual(state.errors, []); near(state.button, item.originalButtonRect, "Original button moved");
  }
  assert.equal(item.before.activeElement, "note"); assert.equal(item.rendered.activeElement, "note"); assert.deepEqual(item.rendered.focus, item.before.focus); assert.deepEqual(item.rendered.selection, item.before.selection);
  assert.deepEqual(post.value.snapshot.events, item.after.events); assert.equal(post.value.trustedSubmit, true); assert.deepEqual(item.after.receipt, post.receipt);
  for (const [type, targetId] of [["input", "note"], ["click", "submit"], ["submit", "form"]]) { const rows = item.after.events.filter(row => row.stage === item.stage && row.type === type && row.targetId === targetId); assert.equal(rows.length, 1); assert.equal(rows[0].trusted, true); if (type === "input") { assert.equal(rows[0].value, item.value); assert.equal(rows[0].nodeToken, item.before.nodeToken); } }
  const click = item.after.events.find(row => row.stage === item.stage && row.type === "click" && row.targetId === "submit"); near(click, center(item.originalButtonRect), "Original trusted click missed button center");
  assert.deepEqual(item.after.rings.slice(0, item.rendered.rings.length), item.rendered.rings);
  const rings = item.after.rings.slice(item.rendered.rings.length); assert.equal(rings.length, 1, "Exactly one new original submit ring, no nearest-time selection");
  item.submitRing = rings[0]; assert.equal(item.submitRing.sequence, item.rendered.rings.length + 1); assert.equal(item.submitRing.documentToken, record.documentToken); assert.equal(item.submitRing.stage, item.stage);
  assert.equal(item.submitRing.zoom, item.rendered.rootZoom, "Ring sampling uses the feedback host's html zoom, not target body zoom");
  near(item.submitRing.modelPoint, { x: click.x, y: click.y }, "Ring belongs to original trusted submit point"); assert.equal(item.submitRing.color, "rgb(20, 184, 166)"); assert.ok(item.submitRing.opacity > 0);
}

export function checkZoomVisible(item) {
  near(center(item.rendered.feedback.cursor), center(item.originalButtonRect), "Visible cursor center is misplaced");
  near(item.rendered.feedback.target, item.originalButtonRect, "Visible target rectangle is misplaced");
  near(center(item.submitRing.rect), center(item.originalButtonRect), "Visible submit ring center is misplaced");
  assert.ok(item.pixels.cursorDark >= 8 * item.pixels.scale ** 2, "Original cursor pixels missing");
  for (const [side, count] of Object.entries(item.pixels.edges)) assert.ok(count >= 4 * item.pixels.scale ** 2, `Original target ${side} pixels missing`);
}

export async function checkZoomFeedback({ browser, fixtureURL, fixtures, saveArtifact, saveDetail, checkEnd, closeTab = tab => tab.close() }) {
  const detail = { states: [], pages: [], tabIds: [], cleanup: [], boundary: "CSS zoom geometry; original ring rectangles are passive transient evidence, not screenshot pixel proof." }, tabs = []; let failure;
  try {
    for (const [zoomScope, initialZoom] of [["html", 1.5], ["html", .75], ["body", 1.5]]) {
      const key = `zoom-${randomUUID().replaceAll("-", "")}`, url = new URL(`${path}page`, fixtureURL); url.search = new URLSearchParams({ key, zoom: initialZoom, scope: zoomScope }).toString();
      const tab = await browser.newTab({ url: url.href }); tabs.push(tab); detail.tabIds.push(tab.id); const page = { key, tabId: tab.id, initialZoom, zoomScope }; detail.pages.push(page);
      for (const stage of zoomScope === "body" ? ["body150"] : initialZoom === 1.5 ? ["zoom150", "zoomChanged"] : ["zoom075"]) {
        const item = { key, stage, zoom: ["zoom150", "body150"].includes(stage) ? 1.5 : .75, value: `Original ${stage} π note` }; detail.states.push(item);
        if (stage === "zoomChanged") {
          item.changeBefore = await tab.evaluate("window.zoomFeedbackState()"); await tab.locator("#change-zoom").click();
          item.changeAfter = await tab.evaluate(`(${waitForZoomFeedback.toString()})(${item.changeBefore.rings.length})`, { awaitPromise: true });
          assert.equal(item.changeAfter.documentToken, item.changeBefore.documentToken); assert.equal(item.changeAfter.nodeToken, item.changeBefore.nodeToken);
          assert.deepEqual(item.changeAfter.changes.map(row => ({ trusted: row.trusted, targetId: row.targetId, from: row.from, to: row.to, documentToken: row.documentToken })), [{ trusted: true, targetId: "change-zoom", from: 1.5, to: .75, documentToken: item.changeBefore.documentToken }]);
        }
        await tab.locator("#note").fill(item.value); item.before = await tab.evaluate("window.zoomFeedbackState()"); item.originalButtonRect = item.before.button;
        await tab.locator("#submit").hover(); item.arrival = await tab.evaluate(`(${waitForZoomFeedback.toString()})()`, { awaitPromise: true });
        const shot = await tab.screenshot(); assert.equal(shot.mimeType, "image/png"); const bytes = Buffer.from(shot.base64, "base64"); item.artifact = `zoom-feedback-${stage}.png`; await saveArtifact(item.artifact, bytes);
        item.rendered = await tab.evaluate("window.zoomFeedbackState()"); await tab.locator("#submit").click(); await tab.getByText(`Saved ${stage}`, { exact: false }).waitFor({ timeoutMs: 5000 });
        item.after = await tab.evaluate(`(${waitForZoomFeedback.toString()})(${item.rendered.rings.length})`, { awaitPromise: true }); item.server = fixtures.stats(key);
        checkZoomBusiness(item, item.server); item.businessPassed = true; item.pixels = measureZoomPixels(bytes, item.rendered);
      }
      page.server = fixtures.stats(key); assert.equal(page.server.posts.length, zoomScope === "html" && initialZoom === 1.5 ? 2 : 1);
    }
    assert.deepEqual(detail.states.map(item => item.stage), stages);
    for (const item of detail.states) try { checkZoomVisible(item); item.visible = true; } catch (error) { item.visible = false; item.visibilityError = errorText(error); failure ??= error; }
    if (!failure && checkEnd) detail.end = await checkEnd(detail);
  } catch (error) { failure ??= error; }
  finally {
    try { detail.serverLedger = fixtures.allStats(); } catch (error) { detail.serverLedgerError = errorText(error); failure ??= error; }
    for (const tab of tabs) try { await closeTab(tab); detail.cleanup.push({ tabId: tab.id, closed: true }); } catch (error) { detail.cleanup.push({ tabId: tab.id, error: errorText(error) }); failure ??= error; }
    if (failure) detail.error = errorText(failure); try { await saveDetail(detail); } catch (error) { failure ??= error; }
  }
  if (failure) throw failure; return detail;
}
