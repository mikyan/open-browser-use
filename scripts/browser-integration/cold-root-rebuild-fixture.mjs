import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { coldWorldContexts, waitForColdWorldRealm } from "./cold-world-lifetime-fixture.mjs";
import { measureFrameTargetPixels, waitForFrameTargetFeedback } from "./frame-target-feedback-fixture.mjs";

const route = "/cold-root-rebuild/", hash = bytes => createHash("sha256").update(bytes).digest("hex");
const errorText = error => error?.stack ?? String(error), center = r => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
const scopeOf = browser => ({ session_id: browser.client.sessionId, turn_id: browser.client.turnId, control_epoch: browser.client.controlEpoch });
export const coldRootRebuildGeometry = Object.freeze({
  original: Object.freeze({ x: 46, y: 134, width: 280, height: 64 }),
  rebuilt: Object.freeze({ x: 370, y: 250, width: 330, height: 84 }),
  rebuild: Object.freeze({ x: 46, y: 240, width: 240, height: 40 }),
  input: Object.freeze({ x: 370, y: 164, width: 330, height: 40 })
});
const near = (actual, expected, label) => { for (const key of Object.keys(expected)) assert.ok(Number.isFinite(actual?.[key]) && Math.abs(actual[key] - expected[key]) <= 1, `${label}: ${key}`); };

// The application's one real click replaces its document element. The retained
// document/window and detached node references are observations, not repairs.
export function installColdRootRebuildDocument(config, replacement) {
  const originalDocument = document, originalWindow = window, originalRoot = document.documentElement, windowToken = crypto.randomUUID();
  const ids = ["note", "submit", "form", "panel", "rebuild"], oldNodes = ids.map(id => document.getElementById(id));
  const events = [], focus = [], changes = [], rings = [], roots = [], errors = [], seen = new WeakSet();
  let rebuilt = false, overflow = false, receipt = null;
  const add = (rows, row) => { if (rows.length >= 128) overflow = true; else rows.push({ sequence: rows.length + 1, ...row }); };
  const rect = node => { if (!node) return null; const b = node.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; };
  const observe = () => {
    const current = document.getElementById("open-browser-use-cursor-root");
    if (current && !roots.some(row => row.node === current)) {
      if (roots.length >= 8) overflow = true;
      else { const tree = current.shadowRoot ?? current; roots.push({ node: current, tree }); new MutationObserver(observe).observe(tree, { childList: true, subtree: true }); }
    }
    for (const [rootIndex, root] of roots.entries()) for (const ring of root.tree.querySelectorAll('[data-testid="browser-agent-click"]')) if (!seen.has(ring)) {
      seen.add(ring); const style = getComputedStyle(ring);
      add(rings, { rebuilt, documentToken: config.documentToken, rootIndex, connected: ring.isConnected, currentRoot: current === root.node,
        rect: rect(ring), modelPoint: { x: parseFloat(ring.style.left), y: parseFloat(ring.style.top) }, color: style.borderTopColor, opacity: Number(style.opacity) });
    }
  };
  new MutationObserver(observe).observe(document, { childList: true, subtree: true }); observe();
  window.coldRootRebuildState = window.frameTargetFeedbackState = () => {
    const input = document.getElementById("note"), current = document.getElementById("open-browser-use-cursor-root");
    const selected = roots.find(row => row.node === current) ?? roots.at(-1), tree = selected?.tree;
    const cursor = tree?.querySelector('[data-testid="browser-agent-cursor"]'), target = tree?.querySelector('[data-testid="browser-agent-target"]');
    const transform = cursor?.style.transform.match(/^translate3d\(([-\d.]+)px,\s*([-\d.]+)px,/);
    return { business: { key: config.key, documentToken: config.documentToken, windowToken, href: location.href,
      sameDocument: document === originalDocument, sameWindow: window === originalWindow, rebuilt,
      sameRoot: document.documentElement === originalRoot, oldRootConnected: originalRoot.isConnected, rootToken: document.documentElement.dataset.token,
      oldNodes: oldNodes.map(node => ({ id: node.id, token: node.dataset.token, connected: node.isConnected, current: node === document.getElementById(node.id) })),
      nodes: ids.map(id => { const node = document.getElementById(id); return { id, token: node?.dataset.token ?? null, connected: !!node?.isConnected }; }),
      value: input.value, activeElement: document.activeElement?.id ?? "", selection: { start: input.selectionStart, end: input.selectionEnd, direction: input.selectionDirection },
      events: structuredClone(events), focus: structuredClone(focus), changes: structuredClone(changes), errors: [...errors], overflow, receipt },
      geometry: { button: rect(document.getElementById("submit")), input: rect(input), parents: [], viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio, scrollX, scrollY } },
      rings: structuredClone(rings), feedback: { connected: !!selected?.node.isConnected, currentRoot: !!selected && selected.node === current,
        rootIndex: selected ? roots.indexOf(selected) : -1, currentCount: document.querySelectorAll('[id="open-browser-use-cursor-root"]').length,
        roots: roots.map(row => ({ connected: row.node.isConnected, current: row.node === current })), cursor: rect(cursor),
        target: target && getComputedStyle(target).display !== "none" ? rect(target) : null,
        modelPoint: transform ? { x: Number(transform[1]) + parseFloat(cursor.style.width) / 2, y: Number(transform[2]) + parseFloat(cursor.style.height) / 2 } : null } };
  };
  for (const type of ["input", "click", "submit", "pointerdown", "pointerup", "keydown", "keyup"]) document.addEventListener(type, event => add(events, {
    type, rebuilt, targetId: event.target.id ?? "", nodeToken: event.target.dataset?.token ?? null, trusted: event.isTrusted, value: event.target.value ?? null,
    ...(["click", "pointerdown", "pointerup"].includes(type) ? { x: event.clientX, y: event.clientY } : {}) }), { capture: true, passive: true });
  for (const type of ["focusin", "focusout"]) document.addEventListener(type, event => add(focus, { type, rebuilt, targetId: event.target.id ?? "", trusted: event.isTrusted }), { capture: true, passive: true });
  document.addEventListener("click", event => {
    if (event.target.id !== "rebuild" || rebuilt) return;
    add(changes, { trusted: event.isTrusted, nodeToken: event.target.dataset.token, documentToken: config.documentToken, windowToken });
    const parsed = new DOMParser().parseFromString(replacement, "text/html");
    document.replaceChild(document.importNode(parsed.documentElement, true), document.documentElement); rebuilt = true;
  });
  document.addEventListener("submit", event => {
    if (event.target.id !== "form") return;
    event.preventDefault(); const body = { key: config.key, trustedSubmit: event.isTrusted, business: window.coldRootRebuildState().business };
    fetch(`/cold-root-rebuild/post?key=${config.key}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      .then(response => { if (!response.ok) throw Error(`Receipt HTTP ${response.status}`); return response.json(); })
      .then(value => { receipt = value; document.getElementById("receipt").textContent = `Saved ${value.bodySHA256}`; }).catch(error => errors.push(String(error)));
  });
}

export function coldRootRebuildHTML(key, documentToken) {
  const markup = version => { const next = version === "rebuilt", button = coldRootRebuildGeometry[version], input = next ? coldRootRebuildGeometry.input : { x: 46, y: 48, width: 280, height: 36 };
    const style = r => `left:${r.x}px;top:${r.y}px;width:${r.width}px;height:${r.height}px`, token = id => `data-token="${key}-${version}-${id}"`;
    return `<html ${token("html")}><head><meta charset="utf-8"><title>Original cold root rebuild</title><style>
html,body{margin:0;background:#eee;color:#333;font:16px sans-serif}*{box-sizing:border-box}#panel{position:absolute;inset:0;background:#eee}input,button{position:absolute}input{${style(input)};background:#fafafa;border:1px solid #777}button{border:0;margin:0;padding-left:12px;background:#ddd;color:#333;text-align:left;font:16px sans-serif}input:focus,button:focus{outline:2px solid #555}#submit{${style(button)}}#rebuild{${style(coldRootRebuildGeometry.rebuild)}}#receipt{position:absolute;left:46px;top:380px;font-size:12px}
</style></head><body><section id="panel" ${token("panel")}><form id="form" ${token("form")}><input id="note" aria-label="Original note" autocomplete="off" ${token("note")}><button id="submit" ${token("submit")}>Save ${version}</button></form><button id="rebuild" type="button" ${token("rebuild")}>Rebuild application</button><output id="receipt"></output></section></body></html>`; };
  return `<!doctype html>${markup("original").replace("</body>", `<script>(${installColdRootRebuildDocument.toString()})(${JSON.stringify({ key, documentToken })},${JSON.stringify(markup("rebuilt"))});</script></body>`)}`;
}

export function createColdRootRebuildFixtures() {
  const records = new Map();
  return { stats: key => structuredClone(records.get(key)), allStats: () => structuredClone([...records.values()]), handle(request, response, suppliedURL) {
    if (![`${route}page`, `${route}post`].includes(suppliedURL.pathname)) return false;
    const url = new URL(request.url, `http://${request.headers.host}`), key = url.searchParams.get("key");
    if (!/^root-rebuild-[a-f0-9]{32}$/.test(key ?? "") || !["127.0.0.1", "localhost"].includes(url.hostname)) { response.writeHead(400); response.end("Invalid rebuild request"); return true; }
    if (!records.has(key)) records.set(key, { key, gets: [], posts: [] }); const record = records.get(key);
    if (url.pathname.endsWith("/page")) {
      if (request.method !== "GET" || record.gets.length) { response.writeHead(400); response.end("Original document may load once"); return true; }
      const documentToken = randomUUID(), bytes = Buffer.from(coldRootRebuildHTML(key, documentToken));
      record.gets.push({ url: url.href, documentToken, bytes: bytes.length, sha256: hash(bytes) });
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }); response.end(bytes); return true;
    }
    if (request.method !== "POST") { response.writeHead(405); response.end(); return true; }
    const post = { index: record.posts.length + 1, url: url.href }, chunks = []; let size = 0; record.posts.push(post);
    request.on("data", chunk => { size += chunk.length; if (size <= 128 * 1024) chunks.push(chunk); });
    request.once("error", error => { post.error = String(error); }); request.once("aborted", () => { post.error = "Original POST aborted"; });
    request.once("end", () => { const bytes = Buffer.concat(chunks); Object.assign(post, { bodyBytes: size, bodyBase64: bytes.toString("base64"), bodySHA256: hash(bytes) });
      try { assert.ok(size <= 128 * 1024); post.value = JSON.parse(bytes); assert.equal(post.index, 1); assert.equal(post.value.key, key); assert.equal(post.value.trustedSubmit, true);
        assert.equal(record.gets.length, 1); assert.equal(post.value.business.documentToken, record.gets[0].documentToken); assert.equal(post.value.business.href, record.gets[0].url);
        post.receipt = { key, index: post.index, bodySHA256: post.bodySHA256 }; response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify(post.receipt));
      } catch (error) { post.error = errorText(error); response.writeHead(400); response.end("Invalid original rebuild receipt"); }
    }); return true;
  } };
}

export function checkColdRootRebuildIdentity(detail) {
  assert.equal(detail.phases.length, 2); const [a, b] = detail.phases;
  assert.deepEqual(a.contexts.defaults, b.contexts.defaults); assert.equal(a.contexts.defaults.length, 1); assert.ok(a.contexts.defaults[0].uniqueId);
  assert.deepEqual(a.contexts.worlds, b.contexts.worlds); assert.equal(a.contexts.worlds.length, 1); assert.ok(a.contexts.worlds[0].uniqueId);
  for (const phase of detail.phases) {
    assert.deepEqual(phase.contexts, coldWorldContexts(phase.native, phase.tree.frameTree.frame.id));
    assert.equal(phase.tree.frameTree.frame.id, a.tree.frameTree.frame.id); assert.equal(phase.tree.frameTree.frame.loaderId, a.tree.frameTree.frame.loaderId);
    assert.equal(phase.identity.root.node.frameId, a.tree.frameTree.frame.id); assert.equal(phase.identity.contextId, a.contexts.defaults[0].id);
    for (const name of ["root", "button"]) assert.ok(Number.isSafeInteger(phase.identity[name].node.backendNodeId) && phase.identity[name].node.backendNodeId > 0);
    for (const [name, nodeName, id] of [["root", "HTML", "html"], ["button", "BUTTON", "submit"]]) {
      const node = phase.identity[name].node; assert.equal(node.nodeName, nodeName); assert.ok(Array.isArray(node.attributes));
      const attributes = Object.fromEntries(Array.from({ length: node.attributes.length / 2 }, (_, index) => node.attributes.slice(index * 2, index * 2 + 2)));
      assert.equal(attributes["data-token"], `${detail.key}-${phase.name}-${id}`); if (name === "button") assert.equal(attributes.id, "submit");
    }
    assert.equal(phase.identity.released, true);
    for (const snapshot of [phase.before, phase.after]) {
      for (const field of ["nativeDocumentId", "nativeFrameId", "nativeProcessId"]) assert.equal(snapshot[field], a.before[field]);
      for (const field of ["key", "documentToken", "windowToken", "href"]) assert.equal(snapshot.business[field], a.before.business[field]);
      assert.equal(snapshot.business.sameDocument, true); assert.equal(snapshot.business.sameWindow, true); assert.deepEqual(snapshot.business.errors, []); assert.equal(snapshot.business.overflow, false);
      const rebuilt = phase.name === "rebuilt"; assert.equal(snapshot.business.rebuilt, rebuilt); assert.equal(snapshot.business.sameRoot, !rebuilt); assert.equal(snapshot.business.oldRootConnected, !rebuilt);
      assert.equal(snapshot.business.rootToken, `${detail.key}-${phase.name}-html`);
      for (const node of snapshot.business.oldNodes) { assert.equal(node.connected, !rebuilt); assert.equal(node.current, !rebuilt); assert.equal(node.token, `${detail.key}-original-${node.id}`); }
      for (const node of snapshot.business.nodes) { assert.equal(node.connected, true); assert.equal(node.token, `${detail.key}-${phase.name}-${node.id}`); }
      assert.deepEqual(snapshot.geometry.button, coldRootRebuildGeometry[phase.name]);
    }
    assert.deepEqual(phase.after.business, phase.before.business, "Hover and screenshot changed original application state/focus"); assert.deepEqual(phase.after.geometry, phase.before.geometry);
  }
  for (const name of ["root", "button"]) assert.notEqual(a.identity[name].node.backendNodeId, b.identity[name].node.backendNodeId, `Original ${name} was not replaced`);
  assert.notDeepEqual(a.after.geometry.button, b.after.geometry.button);
}

export function checkColdRootRebuildBusiness(detail) {
  assert.equal(detail.server.gets.length, 1); assert.equal(detail.server.posts.length, 1);
  const [a, b] = detail.phases, last = detail.after, post = detail.server.posts[0], bytes = Buffer.from(post.bodyBase64, "base64");
  assert.equal(post.error, undefined); assert.equal(bytes.length, post.bodyBytes); assert.equal(hash(bytes), post.bodySHA256); assert.deepEqual(JSON.parse(bytes), post.value);
  assert.equal(a.before.business.documentToken, detail.server.gets[0].documentToken); assert.equal(a.before.business.href, detail.server.gets[0].url);
  for (const field of ["nativeDocumentId", "nativeFrameId", "nativeProcessId"]) assert.equal(last[field], a.before[field]);
  for (const field of ["documentToken", "windowToken", "nodes", "oldNodes", "sameDocument", "sameWindow", "sameRoot", "oldRootConnected", "rootToken", "changes"]) assert.deepEqual(last.business[field], b.after.business[field]);
  assert.deepEqual(last.geometry, b.after.geometry); assert.deepEqual(last.business.errors, []); assert.equal(last.business.overflow, false);
  assert.equal(last.business.value, detail.value); assert.equal(post.value.trustedSubmit, true); assert.deepEqual({ ...post.value.business, receipt: post.receipt }, last.business);
  assert.deepEqual(a.before.business.events, []); assert.deepEqual(a.before.business.focus, []);
  assert.equal(last.business.changes.length, 1); assert.deepEqual(last.business.changes[0], { sequence: 1, trusted: true, nodeToken: `${detail.key}-original-rebuild`, documentToken: a.before.business.documentToken, windowToken: a.before.business.windowToken });
  const expected = [["pointerdown", "rebuild"], ["pointerup", "rebuild"], ["click", "rebuild"], ["pointerdown", "note"], ["pointerup", "note"], ["click", "note"], ["input", "note"], ["pointerdown", "submit"], ["pointerup", "submit"], ["click", "submit"], ["submit", "form"]];
  assert.deepEqual(last.business.events.map(event => [event.type, event.targetId]), expected);
  for (const event of last.business.events) { const rebuilt = event.targetId !== "rebuild"; assert.equal(event.trusted, true); assert.equal(event.rebuilt, rebuilt); assert.equal(event.nodeToken, `${detail.key}-${rebuilt ? "rebuilt" : "original"}-${event.targetId}`); }
  for (const [id, rect] of [["rebuild", coldRootRebuildGeometry.rebuild], ["note", coldRootRebuildGeometry.input], ["submit", coldRootRebuildGeometry.rebuilt]]) near(last.business.events.find(event => event.type === "click" && event.targetId === id), center(rect), `Original ${id} click`);
}

export function checkColdRootRebuildVisible(detail) {
  assert.deepEqual(detail.observationErrors, [], "Original visual observations failed");
  for (const phase of detail.phases) {
    const feedback = phase.after.feedback, box = coldRootRebuildGeometry[phase.name];
    assert.equal(feedback.connected, true); assert.equal(feedback.currentRoot, true); assert.equal(feedback.currentCount, 1);
    near(feedback.cursor && center(feedback.cursor), center(box), "Original visible cursor"); near(feedback.target, box, "Original visible leaf rectangle");
    assert.ok(phase.pixels.cursorDark >= 8 * phase.pixels.scale ** 2); for (const count of Object.values(phase.pixels.edges)) assert.ok(count >= 4 * phase.pixels.scale ** 2);
  }
  const [a, b] = detail.phases; assert.notEqual(a.after.feedback.rootIndex, b.after.feedback.rootIndex);
  assert.equal(b.after.feedback.roots[a.after.feedback.rootIndex].connected, false);
  assert.deepEqual(detail.after.rings.slice(0, b.after.rings.length), b.after.rings);
  const rings = detail.after.rings.slice(b.after.rings.length); assert.equal(rings.length, 2);
  for (const [index, ring] of rings.entries()) { const point = center(index ? coldRootRebuildGeometry.rebuilt : coldRootRebuildGeometry.input);
    assert.equal(ring.rebuilt, true); assert.equal(ring.documentToken, detail.after.business.documentToken); assert.equal(ring.connected, true); assert.equal(ring.currentRoot, true); assert.equal(ring.rootIndex, b.after.feedback.rootIndex);
    assert.equal(ring.color, "rgb(20, 184, 166)"); assert.ok(ring.opacity > 0); near(ring.modelPoint, point, "Original ring model"); near(center(ring.rect), point, "Original ring rectangle");
  }
}

export function coldRootRebuildInputs(value) {
  const move = rect => ({ type: "mouseMoved", ...center(rect), buttons: 0 });
  const click = rect => [move(rect), { type: "mousePressed", ...center(rect), button: "left", buttons: 1, clickCount: 1 }, { type: "mouseReleased", ...center(rect), button: "left", buttons: 0, clickCount: 1 }];
  return [move(coldRootRebuildGeometry.original), ...click(coldRootRebuildGeometry.rebuild), move(coldRootRebuildGeometry.rebuilt), ...click(coldRootRebuildGeometry.input), { text: value }, ...click(coldRootRebuildGeometry.rebuilt)];
}

export function checkColdRootRebuildNative(detail, pngs) {
  const probe = detail.native; assert.equal(probe.restored, true); assert.equal(probe.pending, 0); assert.equal(probe.overflow, false); assert.equal(probe.recordingErrors, 0);
  assert.ok(probe.records.every((row, index) => row.sequence === index + 1));
  const calls = probe.records.filter(row => row.kind === "call"), acks = new Map();
  for (const call of calls) { const rows = probe.records.filter(row => row.kind === "settled" && row.invocation === call.sequence); assert.equal(rows.length, 1); assert.ok(rows[0].sequence > call.sequence); acks.set(call.sequence, rows[0]); }
  const beforeEnd = detail.beforeEnd.records.at(-1).sequence, nativeAbsences = [];
  for (const call of calls.filter(row => acks.get(row.sequence).ok !== true)) {
    // Exact absence after a completed original detach is a native rejection,
    // not a successful ACK. Never admit a first detach failure or a live read.
    const rejected = acks.get(call.sequence);
    assert.equal(call.method, "debugger.detach"); assert.deepEqual(call.target, { tabId: detail.tabId }); assert.deepEqual(call.params, { version: null });
    assert.equal(rejected.ok, false); assert.equal(rejected.error, `Error: Debugger is not attached to the tab with id: ${detail.tabId}.`); assert.equal(rejected.synchronous, undefined);
    assert.ok(call.sequence > beforeEnd); assert.deepEqual(detail.beforeEnd.records, probe.records.slice(0, beforeEnd));
    assert.equal(detail.endCleanup?.hidden, true); assert.equal(detail.endCleanup.originalDocuments, 1); assert.ok(detail.endCleanup.hiddenObservedMs >= 550);
    assert.equal(detail.endEvidence?.endRequested, true); assert.equal(detail.endEvidence.endAcknowledged, true);
    assert.deepEqual(detail.endCleanup.evidence, detail.endEvidence); assert.equal(detail.endCleanup.hiddenObservedMs, detail.endEvidence.hiddenObservedMs);
    assert.equal(detail.finalizeScope?.session_id, detail.scope.session_id); assert.equal(detail.finalized?.lifecycleVersion, 1);
    assert.equal(detail.finalized.endedTurnId, detail.finalizeScope.turn_id); assert.ok(typeof detail.finalized.nextTurnId === "string" && detail.finalized.nextTurnId !== detail.finalizeScope.turn_id);
    assert.ok(Number.isSafeInteger(detail.finalized.controlEpoch) && detail.finalized.controlEpoch > detail.finalizeScope.control_epoch);
    assert.deepEqual(detail.cleanup, { tabs: [], targets: [] });
    for (const current of [call.state, probe.state]) {
      assert.equal(current.engineAbsent, true); assert.equal(current.attached, false); assert.equal(current.originalAttachmentSeen, true); assert.equal(current.sameAttachment, false);
      assert.equal(current.pointerPending, 0); assert.equal(current.privateLeases, 0);
    }
    const first = calls.find(row => row.method === "debugger.detach" && row.target.tabId === detail.tabId);
    assert.ok(first && first.sequence > beforeEnd && first.sequence < call.sequence);
    assert.deepEqual(first.target, { tabId: detail.tabId }); assert.deepEqual(first.params, { version: null });
    assert.equal(acks.get(first.sequence).ok, true); assert.ok(acks.get(first.sequence).sequence < call.sequence);
    assert.equal(first.state.attached, true); assert.equal(first.state.sameAttachment, true); assert.equal(first.state.originalAttachmentSeen, true);
    assert.equal(first.state.pointerPending, 0); assert.equal(first.state.privateLeases, 0);
    assert.ok(calls.filter(row => row.sequence < call.sequence).every(row => acks.get(row.sequence).sequence < call.sequence), "Original native calls must settle before absence classification");
    assert.ok(!calls.some(row => row.sequence > first.sequence && (row.method === "debugger.attach" || row.method.startsWith("Input."))), "No successor attachment/input after original detach");
    nativeAbsences.push({ classification: "already-detached", invocation: call.sequence, settlement: rejected.sequence, ok: false, error: rejected.error, afterSuccessfulDetachACK: acks.get(first.sequence).sequence });
  }
  const own = calls.filter(row => row.target.tabId === detail.tabId && !row.target.sessionId), inputs = own.filter(row => row.method.startsWith("Input."));
  const expected = coldRootRebuildInputs(detail.value); assert.deepEqual(inputs.map(row => row.params), expected); assert.deepEqual(inputs.map(row => row.method), expected.map(params => "text" in params ? "Input.insertText" : "Input.dispatchMouseEvent"));
  for (let index = 1; index < inputs.length; index++) assert.ok(acks.get(inputs[index - 1].sequence).sequence < inputs[index].sequence);
  const enable = own.filter(row => row.method === "Runtime.enable"); assert.equal(enable.length, 1); assert.ok(acks.get(enable[0].sequence).sequence < inputs[0].sequence);
  for (const call of own.filter(row => row.sequence >= enable[0].sequence && row.sequence <= beforeEnd)) { assert.equal(call.state.engineAbsent, true); assert.equal(call.state.sameAttachment, true); }
  assert.equal(own.filter(row => row.method === "debugger.attach").length, 1);
  assert.equal(own.filter(row => row.method === "debugger.detach" && row.sequence <= beforeEnd).length, 0);
  for (const call of calls) assert.ok(!["DOM.enable", "Runtime.disable", "Target.setAutoAttach"].includes(call.method), `Unexpected caller-domain mutation ${call.method}`);
  const shots = own.filter(row => row.method === "Page.captureScreenshot"); assert.equal(shots.length, 2);
  for (const [index, shot] of shots.entries()) { assert.deepEqual(shot.params, { format: "png" }); assert.deepEqual(Buffer.from(acks.get(shot.sequence).value.data, "base64"), pngs[index]); assert.ok(acks.get(inputs[index ? 4 : 0].sequence).sequence < shot.sequence); }
  const groups = new Map();
  for (const call of own) if (["Runtime.evaluate", "Runtime.callFunctionOn"].includes(call.method)) {
    const remotes = [acks.get(call.sequence).value?.result, acks.get(call.sequence).value?.exceptionDetails?.exception];
    if (remotes.some(remote => remote?.objectId)) assert.ok(typeof call.params.objectGroup === "string" && call.params.objectGroup.length, "Original native object must have an explicit released group");
    if (!call.params.objectGroup) continue;
    let group = groups.get(call.params.objectGroup); if (!group) groups.set(call.params.objectGroup, group = { calls: [], objects: [] }); group.calls.push(call.sequence);
    for (const remote of remotes) if (remote?.objectId) group.objects.push({ objectId: remote.objectId, invocation: call.sequence, ack: acks.get(call.sequence).sequence });
  }
  for (const [name, group] of groups) { const release = own.filter(row => row.method === "Runtime.releaseObjectGroup" && row.params.objectGroup === name); assert.equal(release.length, 1, `Original group ${name} release`); assert.ok(group.calls.every(sequence => acks.get(sequence).sequence < release[0].sequence)); group.release = { invocation: release[0].sequence, ack: acks.get(release[0].sequence).sequence }; }
  for (const phase of detail.phases) {
    assert.ok(groups.has(phase.identity.group));
    const production = own.filter(row => row.sequence > phase.moveBoundary && row.sequence <= phase.native.records.at(-1).sequence && row.method === "DOM.describeNode");
    for (const name of ["root", "button"]) assert.ok(production.some(row => acks.get(row.sequence).value?.node?.backendNodeId === phase.identity[name].node.backendNodeId), `Production ${phase.name} ${name} must match independently read native node`);
    const worlds = own.filter(row => row.sequence > phase.moveBoundary && row.sequence <= phase.native.records.at(-1).sequence && row.method === "Page.createIsolatedWorld"); assert.ok(worlds.length);
    for (const call of worlds) { assert.equal(call.params.frameId, phase.tree.frameTree.frame.id); assert.equal(call.params.worldName, phase.contexts.worlds[0].name); assert.equal(call.params.grantUniveralAccess, false); assert.equal(acks.get(call.sequence).value.executionContextId, phase.contexts.worlds[0].id); }
  }
  return { nativeAbsences, inputs: inputs.map(row => ({ invocation: row.sequence, ack: acks.get(row.sequence).sequence })), screenshots: shots.map(row => ({ invocation: row.sequence, ack: acks.get(row.sequence).sequence })), groups: [...groups].map(([name, group]) => ({ name, ...group })) };
}

async function readDocument(worker, tabId, frame) {
  const rows = await worker.evaluate(`chrome.scripting.executeScript({target:{tabId:${tabId},documentIds:[${JSON.stringify(frame.documentId)}]},world:'MAIN',func:()=>window.coldRootRebuildState?.()??null})`);
  assert.equal(rows.length, 1); assert.equal(rows[0].documentId, frame.documentId); assert.equal(rows[0].frameId, 0); assert.ok(rows[0].result);
  return { ...rows[0].result, nativeDocumentId: frame.documentId, nativeFrameId: frame.frameId, nativeProcessId: frame.processId };
}

async function readNodeIdentity(browser, tabId, contextId, group, evidence) {
  Object.assign(evidence, { contextId, group, released: false }); let failure;
  try { for (const [name, expression] of [["root", "document.documentElement"], ["button", "document.getElementById('submit')"]]) {
    const row = evidence[name] = {};
    row.remote = await browser.cdp.call(tabId, "Runtime.evaluate", { expression, contextId, objectGroup: group, returnByValue: false, awaitPromise: false, userGesture: false, silent: true });
    assert.equal(row.remote.exceptionDetails, undefined); assert.ok(row.remote.result?.objectId);
    row.node = (await browser.cdp.call(tabId, "DOM.describeNode", { objectId: row.remote.result.objectId, depth: 0 })).node;
  } } catch (error) { failure = error; evidence.error = errorText(error); }
  finally { try { evidence.releaseACK = await browser.cdp.call(tabId, "Runtime.releaseObjectGroup", { objectGroup: group }); evidence.released = true; } catch (error) { evidence.releaseError = errorText(error); failure ??= error; } }
  if (failure) throw failure;
}

export async function checkColdRootRebuild({ connectBrowser, getWorker, fixtureURL, fixtures, until, saveArtifact, saveDetail, closeTab, checkEnd }) {
  const detail = { key: `root-rebuild-${randomUUID().replaceAll("-", "")}`, phases: [], tabIds: [], states: [], observationErrors: [], cleanupErrors: [],
    boundary: "Single original documentElement replacement, production cold raw CDP. Independent default-context identity reads add observation roundtrips. Passive realm/context reuse is checked from actual Runtime events; no reader geometry is supplied to the PNG oracle. Snapshot visibility is checked only after both original screenshots, the unique business POST, End and cleanup." };
  let browser, tab, failure; const pngs = [], control = (method, args = []) => getWorker().evaluate(`(()=>{const p=globalThis.__obuColdWorldLifetime;if(!p)throw Error('Cold world prefix missing');return p[${JSON.stringify(method)}](...${JSON.stringify(args)})})()`);
  const cleanup = async (stage, fn) => { try { return await fn(); } catch (error) { detail.cleanupErrors.push({ stage, error: errorText(error) }); failure ??= error; } };
  const observe = async (stage, fn) => { try { return await fn(); } catch (error) { detail.observationErrors.push({ stage, error: errorText(error) }); } };
  const drain = () => until(async () => { const probe = await control("snapshot"); return probe.pending === 0 && probe.state.pointerPending === 0 && probe.state.privateLeases === 0; }, "original cold root native reads settle", 5000);
  try {
    browser = await connectBrowser("cold-root-rebuild"); await browser.client.beginTurn("cold-root-rebuild-original"); detail.scope = scopeOf(browser);
    tab = await browser.newTab(); detail.tabIds.push(tab.id); detail.tabId = tab.id; detail.url = new URL(`${route}page?key=${detail.key}`, fixtureURL).href;
    detail.createdTab = await getWorker().evaluate(`chrome.tabs.get(${tab.id})`); assert.equal(detail.createdTab.active, false);
    await control("select", [tab.id]); await browser.cdp.navigate(tab.id, detail.url);
    await until(async () => { const frames = await getWorker().evaluate(`chrome.webNavigation.getAllFrames({tabId:${tab.id}})`); const exact = frames.filter(frame => frame.frameId === 0 && frame.url === detail.url && frame.documentLifecycle === "active" && !frame.errorOccurred); if (exact.length !== 1) return false; detail.frames = exact; return true; }, "original root rebuild document", 5000);
    detail.states.push({ tabId: tab.id, frames: detail.frames });
    detail.runtimeEnable = await browser.cdp.call(tab.id, "Runtime.enable", {});
    detail.realmReadiness = { observations: [] }; await waitForColdWorldRealm({ getWorker, until, evidence: detail.realmReadiness });
    const mouse = params => browser.cdp.call(tab.id, "Input.dispatchMouseEvent", params), move = rect => mouse({ type: "mouseMoved", ...center(rect), buttons: 0 });
    const click = async rect => { await move(rect); await mouse({ type: "mousePressed", ...center(rect), button: "left", buttons: 1, clickCount: 1 }); await mouse({ type: "mouseReleased", ...center(rect), button: "left", buttons: 0, clickCount: 1 }); };
    for (const name of ["original", "rebuilt"]) {
      if (name === "rebuilt") { await click(coldRootRebuildGeometry.rebuild); detail.rebuilt = await readDocument(getWorker(), tab.id, detail.frames[0]); }
      const phase = { name, identity: {} }; detail.phases.push(phase);
      phase.before = await readDocument(getWorker(), tab.id, detail.frames[0]); phase.tree = await browser.cdp.call(tab.id, "Page.getFrameTree", {});
      const prior = await control("snapshot"), defaults = coldWorldContexts(prior, phase.tree.frameTree.frame.id).defaults; assert.equal(defaults.length, 1);
      await readNodeIdentity(browser, tab.id, defaults[0].id, `fixture-cold-root-${detail.key}-${name}`, phase.identity);
      phase.moveBoundary = (await control("mark", [`${name}-before-original-move`])).records.at(-1).sequence;
      await move(coldRootRebuildGeometry[name]);
      phase.arrival = await observe(`${name}-arrival`, () => getWorker().evaluate(`chrome.scripting.executeScript({target:{tabId:${tab.id},documentIds:[${JSON.stringify(detail.frames[0].documentId)}]},world:'MAIN',func:${waitForFrameTargetFeedback.toString()},args:[${JSON.stringify({ ...center(coldRootRebuildGeometry[name]), rectangle: coldRootRebuildGeometry[name] })}]})`));
      await observe(`${name}-png`, async () => { const shot = await browser.cdp.call(tab.id, "Page.captureScreenshot", { format: "png" }); const bytes = pngs[detail.phases.length - 1] = Buffer.from(shot.data, "base64"); phase.artifact = `cold-root-rebuild-${name}.png`; await saveArtifact(phase.artifact, bytes); });
      phase.after = await readDocument(getWorker(), tab.id, detail.frames[0]);
      phase.pixels = await observe(`${name}-pixels`, () => measureFrameTargetPixels(pngs[detail.phases.length - 1], phase.after.geometry));
      await drain(); phase.native = await control("mark", [`${name}-after-original-screenshot`]); phase.contexts = coldWorldContexts(phase.native, phase.tree.frameTree.frame.id);
    }
    detail.value = "Original replacement root π note";
    await click(coldRootRebuildGeometry.input); await browser.cdp.call(tab.id, "Input.insertText", { text: detail.value }); await click(coldRootRebuildGeometry.rebuilt);
    await until(async () => { detail.after = await readDocument(getWorker(), tab.id, detail.frames[0]); return !!detail.after.business.receipt; }, "original rebuilt document receipt", 5000);
    await drain(); detail.beforeEnd = await control("mark", ["after-original-business"]);
    if (checkEnd) await cleanup("original-turn-end", async () => { detail.endCleanup = await checkEnd(detail, browser); });
  } catch (error) { failure ??= error; detail.workflowError = errorText(error); }
  finally {
    await cleanup("original-server-ledger", () => { detail.server = fixtures.stats(detail.key); });
    if (browser) await cleanup("original-owner-finalize", async () => { detail.finalizeScope = scopeOf(browser); detail.finalized = await browser.client.finalizeTabs([]); });
    if (tab) await cleanup("original-exact-tab-close", async () => { const tabs = await getWorker().evaluate("chrome.tabs.query({})"); if (tabs.some(value => value.id === tab.id)) await closeTab(tab); });
    if (browser) await cleanup("original-owner-close", () => browser.close());
    await cleanup("original-observer-drain", () => until(async () => (await control("snapshot")).pending === 0, "original root observer drain", 5000));
    await cleanup("original-observer-restore", async () => { detail.native = await control("restore"); });
    await cleanup("original-exact-inventory", async () => { detail.cleanup = await getWorker().evaluate(`(async()=>({tabs:(await chrome.tabs.query({})).filter(t=>t.id===${tab?.id ?? -1}),targets:(await chrome.debugger.getTargets()).filter(t=>t.tabId===${tab?.id ?? -1})}))()`); assert.deepEqual(detail.cleanup, { tabs: [], targets: [] }); });
  }
  if (!failure) try { checkColdRootRebuildIdentity(detail); checkColdRootRebuildBusiness(detail); detail.nativeProof = checkColdRootRebuildNative(detail, pngs); checkColdRootRebuildVisible(detail); }
  catch (error) { failure = error; detail.oracleError = errorText(error); }
  detail.passed = !failure; if (failure) detail.error = errorText(failure);
  try { await saveDetail(detail); } catch (error) { failure ??= error; }
  if (failure) throw failure; return detail;
}
