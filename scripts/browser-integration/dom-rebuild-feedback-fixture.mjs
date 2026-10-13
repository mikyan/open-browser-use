import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { measureZoomPixels } from "./zoom-feedback-fixture.mjs";

export const domRebuildStages = ["root-children", "root-replacement", "body-only"];
const path = "/dom-rebuild-feedback/", hash = bytes => createHash("sha256").update(bytes).digest("hex");
const errorText = error => error?.stack ?? String(error), center = r => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
const near = (actual, expected, label) => { for (const key of Object.keys(expected)) assert.ok(Number.isFinite(actual?.[key]) && Math.abs(actual[key] - expected[key]) <= 1, `${label}: ${key}`); };

// This is the original application's rebuild. Feedback is only observed, never
// moved or repaired. Retained detached references allow old-source screenshots.
export function installDOMRebuildEvidence(key, documentToken, stage, markup) {
  const originalDocument = document, originalWindow = window, windowToken = crypto.randomUUID(), oldHTML = document.documentElement, oldBody = document.body;
  const oldNodes = ["note", "form", "submit", "panel", "rebuild"].map(id => document.getElementById(id));
  const events = [], focus = [], changes = [], rings = [], roots = [], errors = [], seen = new WeakSet(); let rebuilt = false, overflow = false, receipt = null;
  const add = (rows, row) => { if (rows.length >= 128) overflow = true; else rows.push({ sequence: rows.length + 1, at: performance.now(), ...row }); };
  const box = node => { if (!node) return null; const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
  const observe = () => {
    const current = document.getElementById("open-browser-use-cursor-root");
    if (current && !roots.some(row => row.node === current)) {
      if (roots.length >= 8) overflow = true;
      else { const tree = current.shadowRoot ?? current; roots.push({ node: current, tree, observedConnected: current.isConnected }); new MutationObserver(observe).observe(tree, { childList: true, subtree: true }); }
    }
    for (const [rootIndex, root] of roots.entries()) for (const ring of root.tree.querySelectorAll('[data-testid="browser-agent-click"]')) if (!seen.has(ring)) {
      seen.add(ring); const style = getComputedStyle(ring);
      add(rings, { stage, rebuilt, documentToken, rootIndex, connected: ring.isConnected, currentRoot: root.node === current, rect: box(ring), modelPoint: { x: parseFloat(ring.style.left), y: parseFloat(ring.style.top) }, color: style.borderTopColor, opacity: Number(style.opacity) });
    }
  };
  new MutationObserver(observe).observe(document, { childList: true, subtree: true }); observe();
  window.domRebuildFeedbackState = () => {
    const input = document.getElementById("note"), button = document.getElementById("submit"), panel = document.getElementById("panel"), current = document.getElementById("open-browser-use-cursor-root");
    const selected = roots.find(row => row.node === current) ?? roots.at(-1), tree = selected?.tree;
    const cursor = tree?.querySelector('[data-testid="browser-agent-cursor"]'), target = tree?.querySelector('[data-testid="browser-agent-target"]'), transform = cursor?.style.transform.match(/^translate3d\(([-\d.]+)px,\s*([-\d.]+)px,/);
    return { key, stage, documentToken, windowToken, href: location.href, sameDocument: document === originalDocument, sameWindow: window === originalWindow, rebuilt,
      htmlSame: document.documentElement === oldHTML, bodySame: document.body === oldBody, oldHTMLConnected: oldHTML.isConnected, oldBodyConnected: oldBody.isConnected,
      oldNodes: oldNodes.map(node => ({ id: node.id, connected: node.isConnected, current: node === document.getElementById(node.id), token: node.dataset.token })),
      nodes: ["note", "form", "submit", "panel", "rebuild"].map(id => { const node = document.getElementById(id); return { id, connected: !!node?.isConnected, token: node?.dataset.token ?? null }; }),
      value: input.value, nodeToken: input.dataset.token, activeElement: document.activeElement?.id ?? "", selection: { start: input.selectionStart, end: input.selectionEnd, direction: input.selectionDirection },
      events: structuredClone(events), focus: structuredClone(focus), changes: structuredClone(changes), rings: structuredClone(rings), errors: [...errors], overflow, receipt,
      button: box(button), panel: box(panel), viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
      feedback: { observedConnected: selected?.observedConnected ?? false, currentRoot: !!selected && selected.node === current, connected: !!selected?.node.isConnected,
        rootIndex: selected ? roots.indexOf(selected) : -1, rootCount: roots.length, currentCount: document.querySelectorAll('[id="open-browser-use-cursor-root"]').length,
        cursor: box(cursor), target: target && getComputedStyle(target).display !== "none" ? box(target) : null,
        modelPoint: transform ? { x: Number(transform[1]) + parseFloat(cursor.style.width) / 2, y: Number(transform[2]) + parseFloat(cursor.style.height) / 2 } : null } };
  };
  for (const type of ["input", "click", "submit", "keydown", "keyup"]) document.addEventListener(type, event => add(events, { type, rebuilt, trusted: event.isTrusted, targetId: event.target.id ?? "", nodeToken: event.target.dataset?.token ?? null,
    value: event.target.value ?? null, key: event.key ?? null, ...(type === "click" ? { x: event.clientX, y: event.clientY } : {}) }), { capture: true, passive: true });
  for (const type of ["focusin", "focusout"]) document.addEventListener(type, event => add(focus, { type, rebuilt, trusted: event.isTrusted, targetId: event.target.id ?? "" }), { capture: true, passive: true });
  document.addEventListener("click", event => {
    if (event.target.id !== "rebuild" || rebuilt) return;
    add(changes, { trusted: event.isTrusted, targetId: event.target.id, nodeToken: event.target.dataset.token, stage, documentToken, windowToken });
    const parsed = new DOMParser().parseFromString(markup, "text/html"), copy = node => document.importNode(node, true);
    if (stage === "root-children") document.documentElement.replaceChildren(...[...parsed.documentElement.childNodes].map(copy));
    else if (stage === "root-replacement") document.replaceChild(copy(parsed.documentElement), document.documentElement);
    else document.body.replaceChildren(...[...parsed.body.childNodes].map(copy));
    rebuilt = true;
  });
  document.addEventListener("submit", event => {
    if (event.target.id !== "form") return;
    event.preventDefault(); const body = { key, stage, trustedSubmit: event.isTrusted, snapshot: window.domRebuildFeedbackState() };
    fetch(`/dom-rebuild-feedback/post?key=${key}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      .then(response => { if (!response.ok) throw Error(`Receipt HTTP ${response.status}`); return response.json(); })
      .then(value => { receipt = value; document.getElementById("receipt").textContent = `Saved ${stage} ${value.bodySHA256}`; }).catch(error => errors.push(String(error)));
  });
}

export function domRebuildFeedbackHTML(key, documentToken, stage) {
  const markup = version => `<head><meta charset="utf-8"><title>Original DOM rebuild form</title><style>
  *{box-sizing:border-box}body{margin:0;background:#fff;color:#222;font:16px Arial,sans-serif}
  #panel{margin:32px 40px;padding:20px;width:460px;background:#eee;border:2px solid #555}h1{font-size:18px;margin:0 0 8px}
  label,input,button,output{display:block}input{width:100%;height:40px;margin:6px 0 12px;padding:8px;font:16px Arial}
  button{appearance:none;background:#ddd;color:#222;border:2px solid #777;border-radius:0;width:100%;height:72px;text-align:left;padding-left:12px;font:16px Arial}
  button:focus,input:focus,button:focus-visible,input:focus-visible{outline:2px solid #555;outline-offset:3px}#rebuild{height:32px;margin-top:8px}
  output{font-size:8px;height:28px;padding-top:8px;overflow-wrap:anywhere}</style></head><body><section id="panel" data-token="${key}-${version}-panel"><h1>Original DOM rebuild form</h1>
  <form id="form" data-token="${key}-${version}-form"><label for="note">Rebuild note</label><input id="note" data-token="${key}-${version}-note" autocomplete="off"><button id="submit" data-token="${key}-${version}-submit" type="submit">Save</button><output id="receipt">Waiting</output></form>
  <button id="rebuild" data-token="${key}-${version}-rebuild" type="button">Rebuild application</button></section></body>`;
  return `<!doctype html><html>${markup("original")}<script>(${installDOMRebuildEvidence.toString()})(${JSON.stringify(key)},${JSON.stringify(documentToken)},${JSON.stringify(stage)},${JSON.stringify(markup("rebuilt"))});</script></html>`;
}

export function createDOMRebuildFeedbackFixtures() {
  const records = new Map();
  return { stats: key => structuredClone(records.get(key)), allStats: () => structuredClone([...records.values()]), handle(request, response, url) {
    if (![`${path}page`, `${path}post`].includes(url.pathname)) return false;
    const key = url.searchParams.get("key"), stage = url.searchParams.get("stage");
    if (!/^rebuild-[a-f0-9]{32}$/.test(key ?? "")) { response.writeHead(400); response.end(); return true; }
    if (url.pathname === `${path}page`) {
      if (request.method !== "GET" || !domRebuildStages.includes(stage) || records.has(key) || records.size >= 8) { response.writeHead(400); response.end(); return true; }
      const documentToken = randomUUID(), bytes = Buffer.from(domRebuildFeedbackHTML(key, documentToken, stage));
      records.set(key, { key, stage, documentToken, get: { href: url.href, bytes: bytes.length, sha256: hash(bytes) }, posts: [] });
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
        assert.ok(size <= 65536); post.value = JSON.parse(bytes.toString("utf8")); assert.equal(post.index, 1); assert.equal(post.value.key, key); assert.equal(post.value.stage, record.stage);
        assert.equal(post.value.snapshot.documentToken, record.documentToken); assert.equal(post.value.snapshot.href, record.get.href); assert.equal(post.value.trustedSubmit, true);
        post.receipt = { key, stage: record.stage, index: post.index, bodySHA256: post.bodySHA256 }; response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify(post.receipt));
      } catch { post.error = "Invalid original DOM rebuild receipt"; response.writeHead(400); response.end(post.error); }
    }); return true;
  } };
}

// A detached old model is deliberately sufficient for taking the diagnostic
// screenshot. Only the later visible/pixel oracle can accept rendered feedback.
export async function waitForDOMRebuildFeedback() {
  return new Promise((resolve, reject) => {
    let poll, done = false;
    const finish = (error, state) => { if (done) return; done = true; clearTimeout(timer); clearTimeout(poll); error ? reject(error) : resolve(state); };
    const timer = setTimeout(() => finish(Error("Original DOM rebuild feedback model did not arrive")), 5000);
    const check = () => { if (done) return; try { const state = window.domRebuildFeedbackState(), point = state.feedback.modelPoint, rect = state.button;
      if (point && Math.abs(point.x - rect.x - rect.width / 2) <= 1 && Math.abs(point.y - rect.y - rect.height / 2) <= 1) return finish(null, state);
      poll = setTimeout(check, 16);
    } catch (error) { finish(error); } };
    document.fonts.ready.then(check, error => finish(error));
  });
}

export function checkDOMRebuildBusiness(item, record) {
  assert.equal(record.posts.length, 1); const post = record.posts[0], bytes = Buffer.from(post.bodyBase64, "base64");
  assert.equal(post.error, undefined); assert.equal(bytes.length, post.bodyBytes); assert.equal(hash(bytes), post.bodySHA256); assert.deepEqual(JSON.parse(bytes), post.value);
  const before = item.initial;
  assert.equal(before.rebuilt, false); assert.equal(before.sameDocument, true); assert.equal(before.sameWindow, true); assert.equal(before.htmlSame, true); assert.equal(before.bodySame, true);
  assert.equal(before.feedback.connected, true); assert.equal(before.feedback.currentRoot, true); assert.equal(before.feedback.observedConnected, true); assert.equal(before.feedback.currentCount, 1);
  for (const state of [item.before, item.rendered, item.after, post.value.snapshot]) {
    assert.equal(state.documentToken, record.documentToken); assert.equal(state.documentToken, before.documentToken); assert.equal(state.windowToken, before.windowToken); assert.equal(state.href, record.get.href);
    assert.equal(state.sameDocument, true); assert.equal(state.sameWindow, true); assert.equal(state.rebuilt, true); assert.equal(state.stage, item.stage); assert.equal(state.value, item.value); assert.equal(state.nodeToken, `${item.key}-rebuilt-note`);
    assert.equal(state.htmlSame, item.stage !== "root-replacement"); assert.equal(state.bodySame, item.stage === "body-only"); assert.equal(state.oldHTMLConnected, item.stage !== "root-replacement"); assert.equal(state.oldBodyConnected, item.stage === "body-only");
    assert.deepEqual(state.oldNodes.map(row => [row.id, row.connected, row.current, row.token]), ["note", "form", "submit", "panel", "rebuild"].map(id => [id, false, false, `${item.key}-original-${id}`]));
    assert.deepEqual(state.nodes.map(row => [row.id, row.connected, row.token]), ["note", "form", "submit", "panel", "rebuild"].map(id => [id, true, `${item.key}-rebuilt-${id}`]));
    assert.equal(state.changes.length, 1); assert.equal(state.changes[0].trusted, true); assert.equal(state.changes[0].targetId, "rebuild"); assert.equal(state.changes[0].nodeToken, `${item.key}-original-rebuild`);
    assert.equal(state.overflow, false); assert.deepEqual(state.errors, []); near(state.button, item.originalButtonRect, "Original replacement button moved");
  }
  assert.equal(item.before.activeElement, "note"); assert.equal(item.rendered.activeElement, "note"); assert.deepEqual(item.before.focus, item.rendered.focus); assert.deepEqual(item.before.selection, item.rendered.selection);
  assert.equal(post.value.trustedSubmit, true); assert.deepEqual(item.after.receipt, post.receipt); assert.deepEqual(post.value.snapshot.events, item.after.events);
  for (const [type, id, rebuilt] of [["click", "rebuild", false], ["input", "note", true], ["click", "submit", true], ["submit", "form", true]]) {
    const rows = item.after.events.filter(row => row.type === type && row.targetId === id); assert.equal(rows.length, 1); assert.equal(rows[0].trusted, true); assert.equal(rows[0].rebuilt, rebuilt); assert.equal(rows[0].nodeToken, `${item.key}-${rebuilt ? "rebuilt" : "original"}-${id}`);
  }
  const click = item.after.events.find(row => row.type === "click" && row.targetId === "submit"); near(click, center(item.originalButtonRect), "Original trusted submit point");
  assert.deepEqual(item.after.rings.slice(0, item.rendered.rings.length), item.rendered.rings); item.submitRings = item.after.rings.slice(item.rendered.rings.length);
}

export function checkDOMRebuildVisible(item) {
  const feedback = item.rendered.feedback;
  assert.equal(feedback.currentRoot, true, "Feedback updates a detached old root"); assert.equal(feedback.connected, true); assert.equal(feedback.observedConnected, true); assert.equal(feedback.currentCount, 1);
  assert.equal(feedback.rootIndex === item.initial.feedback.rootIndex, item.stage === "body-only", "Body replacement should retain the connected renderer; root replacement must retire it");
  near(center(feedback.cursor), center(item.originalButtonRect), "Visible cursor center"); near(feedback.target, item.originalButtonRect, "Visible target rectangle");
  assert.ok(item.pixels.cursorDark >= 8 * item.pixels.scale ** 2, "Original cursor pixels missing"); for (const [side, count] of Object.entries(item.pixels.edges)) assert.ok(count >= 4 * item.pixels.scale ** 2, `Original target ${side} pixels missing`);
  assert.equal(item.submitRings.length, 1, "Exactly one new original submit ring"); const ring = item.submitRings[0], click = item.after.events.find(row => row.type === "click" && row.targetId === "submit");
  assert.equal(ring.sequence, item.rendered.rings.length + 1); assert.equal(ring.connected, true); assert.equal(ring.currentRoot, true); assert.equal(ring.rootIndex, feedback.rootIndex); assert.equal(ring.rebuilt, true); assert.equal(ring.stage, item.stage); assert.equal(ring.documentToken, item.rendered.documentToken);
  near(ring.modelPoint, { x: click.x, y: click.y }, "Ring belongs to original click"); near(center(ring.rect), center(item.originalButtonRect), "Visible ring center"); assert.equal(ring.color, "rgb(20, 184, 166)"); assert.ok(ring.opacity > 0);
}

export async function checkDOMRebuildFeedback({ browser, fixtureURL, fixtures, saveArtifact, saveDetail, checkEnd, closeTab = tab => tab.close() }) {
  const detail = { pages: [], states: [], tabIds: [], cleanup: [], boundary: "Same-document application rebuild. Detached model arrival only permits evidence collection; connected geometry and original PNG pixels decide visibility. Ring rectangles are passive transient evidence, not screenshot pixel proof." }, tabs = []; let failure;
  try {
    for (const stage of domRebuildStages) {
      const key = `rebuild-${randomUUID().replaceAll("-", "")}`, url = new URL(`${path}page`, fixtureURL); url.search = new URLSearchParams({ key, stage }).toString();
      const tab = await browser.newTab({ url: url.href }); tabs.push(tab); detail.tabIds.push(tab.id); const item = { key, stage, tabId: tab.id, value: `Original ${stage} π note` }; detail.pages.push({ key, stage, tabId: tab.id }); detail.states.push(item);
      await tab.locator("#submit").hover(); item.initial = await tab.evaluate(`(${waitForDOMRebuildFeedback.toString()})()`, { awaitPromise: true });
      if (stage === "root-replacement") await tab.locator("#rebuild").press("Enter"); else await tab.locator("#rebuild").click();
      item.rebuilt = await tab.evaluate("window.domRebuildFeedbackState()"); await tab.locator("#note").fill(item.value); item.before = await tab.evaluate("window.domRebuildFeedbackState()"); item.originalButtonRect = item.before.button;
      await tab.locator("#submit").hover(); item.arrival = await tab.evaluate(`(${waitForDOMRebuildFeedback.toString()})()`, { awaitPromise: true });
      const shot = await tab.screenshot(); assert.equal(shot.mimeType, "image/png"); const bytes = Buffer.from(shot.base64, "base64"); item.artifact = `dom-rebuild-feedback-${stage}.png`; await saveArtifact(item.artifact, bytes);
      item.rendered = await tab.evaluate("window.domRebuildFeedbackState()"); await tab.locator("#submit").click(); await tab.getByText(`Saved ${stage}`, { exact: false }).waitFor({ timeoutMs: 5000 });
      item.after = await tab.evaluate("window.domRebuildFeedbackState()"); item.server = fixtures.stats(key); item.pixels = measureZoomPixels(bytes, item.rendered);
    }
    for (const item of detail.states) { try { checkDOMRebuildBusiness(item, item.server); item.businessPassed = true; } catch (error) { item.businessPassed = false; item.businessError = errorText(error); failure ??= error; }
      try { checkDOMRebuildVisible(item); item.visible = true; } catch (error) { item.visible = false; item.visibilityError = errorText(error); failure ??= error; } }
    if (!failure && checkEnd) detail.end = await checkEnd(detail);
  } catch (error) { failure ??= error; }
  finally {
    try { detail.serverLedger = fixtures.allStats(); } catch (error) { detail.serverLedgerError = errorText(error); failure ??= error; }
    for (const tab of tabs) try { await closeTab(tab); detail.cleanup.push({ tabId: tab.id, closed: true }); } catch (error) { detail.cleanup.push({ tabId: tab.id, error: errorText(error) }); failure ??= error; }
    if (failure) detail.error = errorText(failure); try { await saveDetail(detail); } catch (error) { failure ??= error; }
  }
  if (failure) throw failure; return detail;
}
