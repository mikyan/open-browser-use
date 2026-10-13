import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { decodeParallelPNG } from "./background-parallel-workflow.mjs";

const path = "/top-layer-feedback/", stages = ["outer", "inner", "popover"];
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const errorText = error => error?.stack ?? String(error);

// This is the page's original application code. Automation only reads its
// evidence and uses public locator input; it never opens or moves a layer.
export function installTopLayerEvidence(key, documentToken) {
  const originals = Object.fromEntries(["outer", "inner", "popover"].map(stage => [stage, {
    input: document.getElementById(`${stage}-input`), form: document.getElementById(`${stage}-form`), button: document.getElementById(`${stage}-submit`)
  }]));
  const events = [], focus = [], toggles = [], capturedToggles = [], errors = [], receipts = {}; let overflow = false;
  const add = (rows, row) => { if (rows.length >= 128) overflow = true; else rows.push({ sequence: rows.length + 1, ...row }); };
  const layers = () => Object.fromEntries(["outer", "inner", "manual", "auto"].map(id => {
    const node = document.getElementById(id); return [id, node ? { open: node.tagName === "DIALOG" ? node.open : node.matches(":popover-open"), modal: node.matches(":modal") } : null];
  }));
  const box = node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
  window.topLayerState = stage => {
    const original = originals[stage], root = document.getElementById("open-browser-use-cursor-root");
    const feedback = root?.shadowRoot ?? root;
    const cursor = feedback?.querySelector('[data-testid="browser-agent-cursor"]'), target = feedback?.querySelector('[data-testid="browser-agent-target"]');
    return { key, documentToken, href: location.href, stage, value: original.input.value, nodeToken: original.input.dataset.token,
      original: Object.entries(original).every(([kind, node]) => node.isConnected && node === document.getElementById(`${stage}-${kind === "button" ? "submit" : kind}`)),
      activeElement: document.activeElement?.id ?? "", selection: { start: original.input.selectionStart, end: original.input.selectionEnd, direction: original.input.selectionDirection }, layers: layers(), events: structuredClone(events), focus: structuredClone(focus), toggles: structuredClone(toggles), capturedToggles: structuredClone(capturedToggles), overflow, errors: [...errors], receipt: receipts[stage] ?? null,
      button: box(original.button), panel: box(original.form.closest("dialog,[popover]")), viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
      feedback: { root: !!root, cursor: cursor ? box(cursor) : null, target: target ? box(target) : null, imageLoaded: !!cursor?.querySelector("img")?.naturalWidth } };
  };
  for (const type of ["input", "click", "submit"]) document.addEventListener(type, event => add(events, {
    type, trusted: event.isTrusted, targetId: event.target.id, nodeToken: event.target.dataset?.token ?? null, value: event.target.value ?? null
  }), { capture: true, passive: true });
  for (const type of ["focusin", "focusout"]) document.addEventListener(type, event => add(focus, { type, trusted: event.isTrusted, targetId: event.target.id }), { capture: true, passive: true });
  // Application policy permits only its known top-layer controls. Agent-only
  // events must remain encapsulated, rather than leaking into this policy.
  document.addEventListener("beforetoggle", event => { if (event.newState === "open" && !["outer", "inner", "manual", "auto"].includes(event.target.id)) event.preventDefault(); }, { capture: true });
  for (const [name, scope] of [["document", document], ["window", window]]) for (const type of ["beforetoggle", "toggle"]) scope.addEventListener(type, event => add(capturedToggles, { scope: name, type, targetId: event.target.id, oldState: event.oldState, newState: event.newState, trusted: event.isTrusted }), { capture: true, passive: true });
  for (const id of ["outer", "inner", "manual", "auto"]) for (const type of ["beforetoggle", "toggle", "close", "cancel"]) document.getElementById(id)?.addEventListener(type, event => add(toggles, { type, id, oldState: event.oldState ?? null, newState: event.newState ?? null, trusted: event.isTrusted }));
  for (const [id, target, method] of [["open-outer", "outer", "showModal"], ["open-inner", "inner", "showModal"], ["open-manual", "manual", "showPopover"], ["open-auto", "auto", "showPopover"]]) document.getElementById(id)?.addEventListener("click", () => document.getElementById(target)[method]());
  for (const [stage, original] of Object.entries(originals)) original.form?.addEventListener("submit", event => {
    event.preventDefault();
    const body = { key, stage, trustedSubmit: event.isTrusted, snapshot: window.topLayerState(stage) };
    fetch(`/top-layer-feedback/post?key=${key}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      .then(response => { if (!response.ok) throw Error(`Receipt HTTP ${response.status}`); return response.json(); })
      .then(receipt => { receipts[stage] = receipt; document.getElementById(`${stage}-receipt`).textContent = `Saved ${stage} ${receipt.bodySHA256}`; })
      .catch(error => errors.push(String(error)));
  });
}

export function topLayerFeedbackHTML(key, documentToken, page) {
  const form = stage => `<form id="${stage}-form"><label for="${stage}-input">${stage} note</label><input id="${stage}-input" data-token="${key}-${stage}-node" autocomplete="off"><button id="${stage}-submit" type="submit">Save</button><output id="${stage}-receipt">Waiting</output></form>`;
  return `<!doctype html><meta charset="utf-8"><title>Original top layer form</title><style>
  *{box-sizing:border-box}body{margin:24px;font:16px Arial,sans-serif;color:#222;background:#fff}
  dialog,[popover]{padding:24px;width:560px;color:#222;background:#eee;border:2px solid #555}
  dialog::backdrop{background:rgb(80 80 80 / .7)}h2{margin:0 0 12px;font-size:20px}
  label,input,button,output{display:block}input{width:100%;height:44px;margin:8px 0 16px;padding:8px;font:16px Arial}
  button{appearance:none;background:#ddd;color:#222;border:2px solid #777;border-radius:0;height:80px;width:100%;text-align:left;padding-left:16px;font:16px Arial}
  button:focus,input:focus,button:focus-visible,input:focus-visible{outline:2px solid #555;outline-offset:3px}
  output{font-size:10px;margin:12px 0;overflow-wrap:anywhere}#open-inner,#open-auto{height:44px;margin-top:12px}
  #open-outer,#open-manual{width:320px}#manual{inset:24px auto auto 24px;width:650px;height:480px}#auto{inset:0;margin:auto}
  </style>${page === "modal" ? `<button id="open-outer">Open original modal</button><dialog id="outer"><h2>Original outer form</h2>${form("outer")}<button id="open-inner">Open original confirmation</button><dialog id="inner"><h2>Original confirmation</h2>${form("inner")}</dialog></dialog>` : `<button id="open-manual">Open original manual panel</button><section id="manual" popover="manual"><h2>Original manual panel</h2><button id="open-auto">Open original automatic panel</button><section id="auto" popover="auto"><h2>Original automatic form</h2>${form("popover")}</section></section>`}
  <script>(${installTopLayerEvidence.toString()})(${JSON.stringify(key)},${JSON.stringify(documentToken)});</script>`;
}

export function createTopLayerFeedbackFixtures() {
  const records = new Map();
  return { stats: key => structuredClone(records.get(key)), allStats: () => structuredClone([...records.values()]), handle(request, response, url) {
    if (![`${path}page`, `${path}post`].includes(url.pathname)) return false;
    const key = url.searchParams.get("key"), page = url.searchParams.get("page");
    if (!/^top-[a-f0-9]{32}$/.test(key ?? "")) { response.writeHead(400); response.end(); return true; }
    if (url.pathname === `${path}page`) {
      if (request.method !== "GET" || !["modal", "popover"].includes(page) || records.has(key) || records.size >= 16) { response.writeHead(400); response.end(); return true; }
      const documentToken = randomUUID(), bytes = Buffer.from(topLayerFeedbackHTML(key, documentToken, page));
      records.set(key, { key, page, documentToken, get: { href: url.href, bytes: bytes.length, sha256: hash(bytes) }, posts: [] });
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }); response.end(bytes); return true;
    }
    const record = records.get(key);
    if (request.method !== "POST" || !record || record.posts.length >= 8) { response.writeHead(400); response.end(); return true; }
    const post = { method: request.method, index: record.posts.length + 1 }; record.posts.push(post); const chunks = []; let size = 0;
    request.on("data", chunk => { size += chunk.length; if (size <= 65536) chunks.push(chunk); });
    request.once("error", () => { post.error = "HTTP request failed"; }); request.once("aborted", () => { post.error = "HTTP request aborted"; });
    request.once("end", () => {
      const bytes = Buffer.concat(chunks); Object.assign(post, { bodyBytes: size, bodyBase64: bytes.toString("base64"), bodySHA256: hash(bytes) });
      try {
        assert.ok(size <= 65536); post.value = JSON.parse(bytes.toString("utf8")); assert.equal(post.value.key, key);
        assert.ok((record.page === "modal" ? ["outer", "inner"] : ["popover"]).includes(post.value.stage));
        assert.equal(post.value.snapshot.documentToken, record.documentToken); assert.equal(post.value.snapshot.href, record.get.href);
        assert.equal(post.value.trustedSubmit, true); assert.equal(record.posts.filter(row => row.value?.stage === post.value.stage).length, 1);
        post.receipt = { key, stage: post.value.stage, index: post.index, bodySHA256: post.bodySHA256 };
        response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify(post.receipt));
      } catch { post.error = "Invalid original form receipt"; response.writeHead(400); response.end(post.error); }
    }); return true;
  } };
}

export function measureTopLayerPixels(bytes, { button, panel, viewport }) {
  const png = decodeParallelPNG(bytes), sx = png.width / viewport.width, sy = png.height / viewport.height;
  assert.ok(sx > 0 && sy > 0 && Math.abs(sx - sy) < .01 && Math.abs(sx - viewport.dpr) < .02, "Unexpected viewport PNG scale");
  for (const rect of [button, panel]) for (const name of ["x", "y", "width", "height"]) assert.ok(Number.isFinite(rect[name]));
  assert.ok(button.width >= 240 && button.height >= 64 && panel.x >= 0 && panel.y >= 0 && panel.x + panel.width <= viewport.width && panel.y + panel.height <= viewport.height);
  assert.ok(button.x - 4 > panel.x && button.y - 4 > panel.y && button.x + button.width + 4 < panel.x + panel.width && button.y + button.height + 4 < panel.y + panel.height, "Pixel ROIs must be inside opaque panel");
  const cx = button.x + button.width / 2, cy = button.y + button.height / 2;
  let cursorDark = 0, outlineBlue = 0, centerSamples = 0, edgeSamples = 0;
  for (let y = Math.floor((button.y - 3) * sy); y < Math.ceil((button.y + button.height + 3) * sy); y++) for (let x = Math.floor((button.x - 3) * sx); x < Math.ceil((button.x + button.width + 3) * sx); x++) {
    const px = (x + .5) / sx, py = (y + .5) / sy, [r, g, b] = png.pixel(x, y);
    if (Math.abs(px - cx) <= 24 && Math.abs(py - cy) <= 24) { centerSamples++; if (Math.max(r, g, b) < 90) cursorDark++; }
    else if (px < button.x + 4 || px > button.x + button.width - 4 || py < button.y + 4 || py > button.y + button.height - 4) { edgeSamples++; if (b - r >= 35 && b - g >= 10) outlineBlue++; }
  }
  return { width: png.width, height: png.height, byteLength: bytes.length, sha256: hash(bytes), cursorDark, outlineBlue, centerSamples, edgeSamples, scale: sx };
}
export function checkTopLayerPixels(pixels) {
  assert.ok(pixels.cursorDark >= 8 * pixels.scale ** 2, `Top-layer cursor pixels missing: ${pixels.cursorDark}`);
  assert.ok(pixels.outlineBlue >= 32 * pixels.scale ** 2, `Top-layer outline pixels missing: ${pixels.outlineBlue}`);
}

export function checkTopLayerBusiness(item, record) {
  const { stage, before, rendered, after } = item, posts = record.posts.filter(post => post.value?.stage === stage);
  assert.equal(posts.length, 1); const post = posts[0], bytes = Buffer.from(post.bodyBase64, "base64");
  assert.equal(post.error, undefined); assert.equal(bytes.length, post.bodyBytes); assert.equal(hash(bytes), post.bodySHA256); assert.deepEqual(JSON.parse(bytes.toString("utf8")), post.value);
  for (const state of [before, rendered, after, post.value.snapshot]) {
    assert.equal(state.original, true); assert.equal(state.documentToken, record.documentToken); assert.equal(state.href, record.get.href); assert.equal(state.nodeToken, `${record.key}-${stage}-node`);
    assert.equal(state.value, item.value); assert.equal(state.overflow, false); assert.deepEqual(state.errors, []);
    for (const id of stage === "outer" ? ["outer"] : stage === "inner" ? ["outer", "inner"] : ["manual", "auto"]) assert.equal(state.layers[id].open, true);
    if (stage !== "popover") assert.equal(state.layers[stage].modal, true);
    assert.equal(state.toggles.some(row => row.newState === "closed" || ["close", "cancel"].includes(row.type)), false, "Business layers were closed/reopened");
    assert.equal(state.capturedToggles.some(row => !["outer", "inner", "manual", "auto"].includes(row.targetId)), false, "Agent layer leaked toggle events into application capture listeners");
  }
  assert.equal(before.activeElement, `${stage}-input`); assert.equal(rendered.activeElement, before.activeElement); assert.deepEqual(rendered.focus, before.focus, "Hover/screenshot changed original DOM focus");
  assert.deepEqual(rendered.selection, before.selection, "Hover/screenshot changed original input selection");
  assert.deepEqual(post.value.snapshot.events, after.events); assert.equal(post.value.trustedSubmit, true); assert.deepEqual(after.receipt, post.receipt);
  const input = after.events.filter(row => row.type === "input" && row.targetId === `${stage}-input`);
  assert.equal(input.length, 1); assert.equal(input[0].trusted, true); assert.equal(input[0].value, item.value); assert.equal(input[0].nodeToken, before.nodeToken);
  for (const [type, targetId] of [["click", `${stage}-submit`], ["submit", `${stage}-form`]]) {
    const rows = after.events.filter(row => row.type === type && row.targetId === targetId); assert.equal(rows.length, 1); assert.equal(rows[0].trusted, true);
  }
}

export async function checkTopLayerFeedback({ browser, fixtureURL, fixtures, saveArtifact, saveDetail, checkEnd, closeTab = tab => tab.close() }) {
  const detail = { states: [], pages: [], tabIds: [], cleanup: [] }, tabs = []; let failure;
  try {
    for (const page of ["modal", "popover"]) {
      const key = `top-${randomUUID().replaceAll("-", "")}`, url = new URL(`${path}page`, fixtureURL); url.search = new URLSearchParams({ key, page }).toString();
      const tab = await browser.newTab({ url: url.href }); tabs.push(tab); detail.tabIds.push(tab.id); const pageDetail = { key, page, tabId: tab.id }; detail.pages.push(pageDetail);
      const opener = tab.locator(page === "modal" ? "#open-outer" : "#open-manual"); await opener.hover();
      pageDetail.preexistingCursor = await tab.evaluate(`(()=>{const root=document.getElementById('open-browser-use-cursor-root');return !!(root?.shadowRoot??root)?.querySelector('[data-testid="browser-agent-cursor"]')})()`); assert.equal(pageDetail.preexistingCursor, true);
      await opener.click(); if (page === "popover") await tab.locator("#open-auto").click();
      for (const stage of page === "modal" ? ["outer", "inner"] : ["popover"]) {
        if (stage === "inner") await tab.locator("#open-inner").click();
        const item = { stage, key, value: `Original ${stage} π note` }; detail.states.push(item);
        await tab.locator(`#${stage}-input`).fill(item.value); item.before = await tab.evaluate(`window.topLayerState(${JSON.stringify(stage)})`);
        await tab.locator(`#${stage}-submit`).hover();
        // Await only the existing image/font loads and original cursor arrival.
        // No animation settings, layer methods, focus or business DOM are changed.
        item.arrival = await tab.evaluate(`new Promise((resolve,reject)=>{let frame,done=false;const timer=setTimeout(()=>finish(Error('Original cursor did not arrive')),5000);function finish(error){if(done)return;done=true;clearTimeout(timer);if(frame)cancelAnimationFrame(frame);error?reject(error):resolve(true)}const root=document.getElementById('open-browser-use-cursor-root'),layer=root?.shadowRoot??root;Promise.all([document.fonts.ready,...[...document.images,...(layer?.querySelectorAll('img')??[])].map(image=>image.decode())]).then(()=>{function check(){if(done)return;const cursor=layer?.querySelector('[data-testid="browser-agent-cursor"]')?.getBoundingClientRect(),button=document.getElementById('${stage}-submit').getBoundingClientRect();if(cursor&&Math.abs(cursor.x+cursor.width/2-button.x-button.width/2)<=1&&Math.abs(cursor.y+cursor.height/2-button.y-button.height/2)<=1)return finish();frame=requestAnimationFrame(check)}check()},finish)})`, { awaitPromise: true });
        const shot = await tab.screenshot(); assert.equal(shot.mimeType, "image/png"); const bytes = Buffer.from(shot.base64, "base64");
        item.artifact = `top-layer-${stage}.png`; await saveArtifact(item.artifact, bytes);
        item.rendered = await tab.evaluate(`window.topLayerState(${JSON.stringify(stage)})`);
        // Capture first, submit once, then assess visibility. A hidden baseline
        // must still preserve its original successful business transaction.
        await tab.locator(`#${stage}-submit`).click();
        await tab.getByText(`Saved ${stage}`, { exact: false }).waitFor({ timeoutMs: 5000 });
        item.after = await tab.evaluate(`window.topLayerState(${JSON.stringify(stage)})`); item.server = fixtures.stats(key);
        checkTopLayerBusiness(item, item.server); item.businessPassed = true; item.pixels = measureTopLayerPixels(bytes, item.rendered);
      }
    }
    for (const page of detail.pages) { page.server = fixtures.stats(page.key); assert.equal(page.server.posts.length, page.page === "modal" ? 2 : 1); }
    assert.deepEqual(detail.states.map(item => item.stage), stages);
    for (const item of detail.states) { try { checkTopLayerPixels(item.pixels); item.visible = true; } catch (error) { item.visible = false; item.visibilityError = errorText(error); failure ??= error; } }
    if (!failure && checkEnd) detail.end = await checkEnd(detail);
  } catch (error) { failure ??= error; }
  finally {
    // Preserve rejected/incomplete original POSTs even when no Saved receipt
    // appeared. Observe before closing the exact tabs, without replaying input.
    try { detail.serverLedger = fixtures.allStats(); } catch (error) { detail.serverLedgerError = errorText(error); failure ??= error; }
    for (const tab of tabs) { try { await closeTab(tab); detail.cleanup.push({ tabId: tab.id, closed: true }); } catch (error) { detail.cleanup.push({ tabId: tab.id, error: errorText(error) }); failure ??= error; } }
    if (failure) detail.error = errorText(failure);
    try { await saveDetail(detail); } catch (error) { failure ??= error; }
  }
  if (failure) throw failure; return detail;
}
