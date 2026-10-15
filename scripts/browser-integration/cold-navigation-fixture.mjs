import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { coldWorldContexts, waitForColdWorldRealm } from "./cold-world-lifetime-fixture.mjs";
import { measureFrameTargetPixels, waitForFrameTargetFeedback } from "./frame-target-feedback-fixture.mjs";

const route = "/cold-navigation/", hash = bytes => createHash("sha256").update(bytes).digest("hex");
const errorText = error => error?.stack ?? String(error), center = rect => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
const scopeOf = browser => ({ session_id: browser.client.sessionId, turn_id: browser.client.turnId, control_epoch: browser.client.controlEpoch });
const near = (actual, expected, label) => { for (const key of Object.keys(expected)) assert.ok(Number.isFinite(actual?.[key]) && Math.abs(actual[key] - expected[key]) <= 1, `${label}: ${key}`); };
export const coldNavigationGeometry = Object.freeze({ a: Object.freeze({ x: 46, y: 134, width: 280, height: 64 }),
  b: Object.freeze({ x: 370, y: 250, width: 330, height: 84 }), input: Object.freeze({ x: 370, y: 164, width: 330, height: 40 }) });

// Each real navigation installs its own application ledger. No old DOM is
// transferred to B, and no script focuses, navigates or repairs the page.
export function installColdNavigationDocument(config) {
  const originalDocument = document, originalWindow = window, originalRoot = document.documentElement, windowToken = crypto.randomUUID();
  const nodes = new Map(["note", "submit", "form", "panel"].map(id => [id, document.getElementById(id)]));
  const events = [], focus = [], rings = [], errors = [], roots = [], seen = new WeakSet(); let receipt = null, overflow = false;
  const add = (rows, row) => { if (rows.length >= 128) overflow = true; else rows.push({ sequence: rows.length + 1, ...row }); };
  const rect = node => { if (!node) return null; const b = node.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; };
  const visible = node => !!node?.isConnected && node.getClientRects().length > 0 && getComputedStyle(node).visibility !== "hidden" && Number(getComputedStyle(node).opacity) > 0;
  const observe = () => {
    const current = document.getElementById("open-browser-use-cursor-root");
    if (current && !roots.some(row => row.node === current)) { if (roots.length >= 8) overflow = true; else { const tree = current.shadowRoot ?? current; roots.push({ node: current, tree }); new MutationObserver(observe).observe(tree, { childList: true, subtree: true }); } }
    for (const [rootIndex, root] of roots.entries()) for (const ring of root.tree.querySelectorAll('[data-testid="browser-agent-click"]')) if (!seen.has(ring)) {
      seen.add(ring); const style = getComputedStyle(ring); add(rings, { documentToken: config.documentToken, stage: config.stage, rootIndex, connected: ring.isConnected, currentRoot: current === root.node,
        rect: rect(ring), modelPoint: { x: parseFloat(ring.style.left), y: parseFloat(ring.style.top) }, color: style.borderTopColor, opacity: Number(style.opacity) });
    }
  };
  new MutationObserver(observe).observe(document, { childList: true, subtree: true }); observe();
  window.coldNavigationState = window.frameTargetFeedbackState = () => {
    const input = nodes.get("note"), current = document.getElementById("open-browser-use-cursor-root"), selected = roots.find(row => row.node === current), tree = selected?.tree;
    const cursor = tree?.querySelector('[data-testid="browser-agent-cursor"]'), target = tree?.querySelector('[data-testid="browser-agent-target"]'), transform = cursor?.style.transform.match(/^translate3d\(([-\d.]+)px,\s*([-\d.]+)px,/);
    return { business: { key: config.key, stage: config.stage, documentToken: config.documentToken, windowToken, href: location.href,
      sameDocument: document === originalDocument, sameWindow: window === originalWindow, sameRoot: document.documentElement === originalRoot, rootToken: originalRoot.dataset.token,
      nodes: [...nodes].map(([id, node]) => ({ id, token: node.dataset.token, connected: node.isConnected, original: node === document.getElementById(id) })),
      value: input.value, activeElement: document.activeElement?.id ?? "", selection: { start: input.selectionStart, end: input.selectionEnd, direction: input.selectionDirection },
      events: structuredClone(events), focus: structuredClone(focus), errors: [...errors], overflow, receipt },
      geometry: { button: rect(nodes.get("submit")), input: rect(input), parents: [], viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio, scrollX, scrollY } },
      rings: structuredClone(rings), feedback: { connected: !!selected?.node.isConnected, currentRoot: !!selected, currentCount: document.querySelectorAll('[id="open-browser-use-cursor-root"]').length,
        rootIndex: selected ? roots.indexOf(selected) : -1, cursor: rect(cursor), target: target && getComputedStyle(target).display !== "none" ? rect(target) : null,
        openAgentLayers: [...(tree?.querySelectorAll('[data-testid="browser-agent-layer"]') ?? [])].filter(node => node.matches(":popover-open")).length,
        cursorOpacity: cursor ? Number(getComputedStyle(cursor).opacity) : 0, cursorVisible: visible(cursor), targetVisible: visible(target),
        visibleRings: [...(tree?.querySelectorAll('[data-testid="browser-agent-click"]') ?? [])].filter(visible).length,
        modelPoint: transform ? { x: Number(transform[1]) + parseFloat(cursor.style.width) / 2, y: Number(transform[2]) + parseFloat(cursor.style.height) / 2 } : null } };
  };
  for (const type of ["input", "click", "submit", "pointerdown", "pointerup", "keydown", "keyup"]) document.addEventListener(type, event => add(events, { type, targetId: event.target.id ?? "", nodeToken: event.target.dataset?.token ?? null, trusted: event.isTrusted,
    value: event.target.value ?? null, ...(["click", "pointerdown", "pointerup"].includes(type) ? { x: event.clientX, y: event.clientY } : {}) }), { capture: true, passive: true });
  for (const type of ["focusin", "focusout"]) document.addEventListener(type, event => add(focus, { type, targetId: event.target.id ?? "", trusted: event.isTrusted }), { capture: true, passive: true });
  nodes.get("form").addEventListener("submit", event => {
    event.preventDefault(); const body = { key: config.key, trustedSubmit: event.isTrusted, business: window.coldNavigationState().business };
    fetch(`/cold-navigation/post?key=${config.key}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      .then(response => { if (!response.ok) throw Error(`Receipt HTTP ${response.status}`); return response.json(); })
      .then(value => { receipt = value; document.getElementById("receipt").textContent = `Saved ${value.bodySHA256}`; }).catch(error => errors.push(String(error)));
  });
}

export function coldNavigationHTML(key, stage, documentToken) {
  assert.ok(["a", "b"].includes(stage)); const button = coldNavigationGeometry[stage], input = stage === "b" ? coldNavigationGeometry.input : { x: 46, y: 48, width: 280, height: 36 };
  const style = rect => `left:${rect.x}px;top:${rect.y}px;width:${rect.width}px;height:${rect.height}px`, token = id => `data-token="${key}-${stage}-${id}"`;
  return `<!doctype html><html ${token("html")}><head><meta charset="utf-8"><title>Original cold navigation ${stage}</title><style>
html,body{margin:0;background:#eee;color:#333;font:16px sans-serif}*{box-sizing:border-box}#panel{position:absolute;inset:0;background:#eee}input,button{position:absolute}input{${style(input)};background:#fafafa;border:1px solid #777}button{${style(button)};border:0;margin:0;padding-left:12px;background:#ddd;color:#333;text-align:left;font:16px sans-serif}input:focus,button:focus{outline:2px solid #555}#receipt{position:absolute;left:46px;top:380px;font-size:12px}
</style></head><body><section id="panel" ${token("panel")}><form id="form" ${token("form")}><input id="note" aria-label="Original note" autocomplete="off" ${token("note")}><button id="submit" ${token("submit")}>Save ${stage}</button></form><output id="receipt"></output></section><script>(${installColdNavigationDocument.toString()})(${JSON.stringify({ key, stage, documentToken })});</script></body></html>`;
}

export function createColdNavigationFixtures() {
  const records = new Map();
  return { stats: key => structuredClone(records.get(key)), allStats: () => structuredClone([...records.values()]), handle(request, response, suppliedURL) {
    if (![`${route}page`, `${route}post`].includes(suppliedURL.pathname)) return false;
    const url = new URL(request.url, `http://${request.headers.host}`), key = url.searchParams.get("key"), stage = url.searchParams.get("stage");
    if (!/^cold-navigation-[a-f0-9]{32}$/.test(key ?? "") || !["127.0.0.1", "localhost"].includes(url.hostname)) { response.writeHead(400); response.end("Invalid navigation fixture"); return true; }
    if (!records.has(key)) records.set(key, { key, gets: [], posts: [] }); const record = records.get(key);
    if (url.pathname.endsWith("/page")) {
      if (request.method !== "GET" || stage !== ["a", "b"][record.gets.length]) { response.writeHead(400); response.end("Each original document must load once in order"); return true; }
      const documentToken = randomUUID(), bytes = Buffer.from(coldNavigationHTML(key, stage, documentToken));
      record.gets.push({ stage, url: url.href, documentToken, bytes: bytes.length, sha256: hash(bytes) });
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }); response.end(bytes); return true;
    }
    if (request.method !== "POST") { response.writeHead(405); response.end(); return true; }
    const post = { index: record.posts.length + 1, url: url.href }, chunks = []; let size = 0; record.posts.push(post);
    request.on("data", chunk => { size += chunk.length; if (size <= 128 * 1024) chunks.push(chunk); });
    request.once("error", error => { post.error = String(error); }); request.once("aborted", () => { post.error = "Original POST aborted"; });
    request.once("end", () => { const bytes = Buffer.concat(chunks); Object.assign(post, { bodyBytes: size, bodyBase64: bytes.toString("base64"), bodySHA256: hash(bytes) });
      try { assert.ok(size <= 128 * 1024); post.value = JSON.parse(bytes); assert.equal(post.index, 1); assert.equal(post.value.key, key); assert.equal(post.value.trustedSubmit, true);
        assert.equal(record.gets.length, 2); assert.equal(post.value.business.stage, "b"); assert.equal(post.value.business.documentToken, record.gets[1].documentToken); assert.equal(post.value.business.href, record.gets[1].url);
        post.receipt = { key, index: post.index, bodySHA256: post.bodySHA256 }; response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify(post.receipt));
      } catch (error) { post.error = errorText(error); response.writeHead(400); response.end("Invalid original navigation receipt"); }
    }); return true;
  } };
}

export function checkColdNavigationIdentity(detail) {
  assert.deepEqual(detail.phases.map(phase => phase.name), ["a", "b"]); const [a, b] = detail.phases;
  for (const phase of detail.phases) {
    assert.deepEqual(phase.contexts, coldWorldContexts(phase.native, phase.tree.frameTree.frame.id));
    assert.equal(phase.contexts.defaults.length, 1); assert.equal(phase.contexts.worlds.length, 1);
    for (const context of [...phase.contexts.defaults, ...phase.contexts.worlds]) assert.ok(typeof context.uniqueId === "string" && context.uniqueId.length);
    assert.equal(phase.identity.root.node.frameId, phase.tree.frameTree.frame.id); assert.equal(phase.identity.contextId, phase.contexts.defaults[0].id);
    for (const [name, nodeName, id] of [["root", "HTML", "html"], ["button", "BUTTON", "submit"]]) {
      const node = phase.identity[name].node; assert.ok(Number.isSafeInteger(node.backendNodeId) && node.backendNodeId > 0); assert.equal(node.nodeName, nodeName); assert.ok(Array.isArray(node.attributes));
      const attributes = Object.fromEntries(Array.from({ length: node.attributes.length / 2 }, (_, index) => node.attributes.slice(index * 2, index * 2 + 2)));
      assert.equal(attributes["data-token"], `${detail.key}-${phase.name}-${id}`); if (name === "button") assert.equal(attributes.id, "submit");
    }
    assert.equal(phase.identity.released, true);
    for (const snapshot of [phase.before, phase.after]) {
      for (const field of ["nativeDocumentId", "nativeFrameId", "nativeProcessId"]) assert.equal(snapshot[field], phase.before[field]);
      assert.equal(snapshot.business.key, detail.key); assert.equal(snapshot.business.stage, phase.name); assert.equal(snapshot.business.href, phase.url);
      for (const field of ["sameDocument", "sameWindow", "sameRoot"]) assert.equal(snapshot.business[field], true);
      assert.deepEqual(snapshot.business.errors, []); assert.equal(snapshot.business.overflow, false); assert.equal(snapshot.business.rootToken, `${detail.key}-${phase.name}-html`);
      for (const node of snapshot.business.nodes) { assert.equal(node.connected, true); assert.equal(node.original, true); assert.equal(node.token, `${detail.key}-${phase.name}-${node.id}`); }
      assert.deepEqual(snapshot.geometry.button, coldNavigationGeometry[phase.name]); assert.deepEqual(snapshot.business.events, []); assert.deepEqual(snapshot.business.focus, []); assert.equal(snapshot.business.value, "");
    }
    assert.deepEqual(phase.after.business, phase.before.business, "Hover/screenshot changed original page state or focus"); assert.deepEqual(phase.after.geometry, phase.before.geometry);
  }
  assert.equal(new URL(a.url).origin, new URL(b.url).origin); assert.notEqual(a.url, b.url);
  assert.notEqual(a.before.nativeDocumentId, b.before.nativeDocumentId); assert.notEqual(a.tree.frameTree.frame.loaderId, b.tree.frameTree.frame.loaderId);
  for (const field of ["documentToken", "windowToken"]) assert.notEqual(a.before.business[field], b.before.business[field]);
  for (const name of ["defaults", "worlds"]) assert.notEqual(a.contexts[name][0].uniqueId, b.contexts[name][0].uniqueId);
  assert.equal(a.contexts.worlds[0].name, b.contexts.worlds[0].name); assert.ok(a.contexts.worlds[0].name.startsWith("Open Browser Use passive pointer "));
  // Context/frame/backend numeric IDs may legitimately be reused across native documents.
  const old = new Set([a.contexts.defaults[0].uniqueId, a.contexts.worlds[0].uniqueId]); assert.ok(b.contexts.all.every(context => !old.has(context.uniqueId)));
}

export function checkColdNavigationBusiness(detail) {
  assert.deepEqual(detail.server.gets.map(row => row.stage), ["a", "b"]); assert.equal(detail.server.posts.length, 1);
  for (const [index, phase] of detail.phases.entries()) { assert.equal(phase.before.business.documentToken, detail.server.gets[index].documentToken); assert.equal(phase.url, detail.server.gets[index].url); }
  const b = detail.phases[1], last = detail.after, post = detail.server.posts[0], bytes = Buffer.from(post.bodyBase64, "base64");
  assert.equal(post.error, undefined); assert.equal(bytes.length, post.bodyBytes); assert.equal(hash(bytes), post.bodySHA256); assert.deepEqual(JSON.parse(bytes), post.value);
  for (const field of ["nativeDocumentId", "nativeFrameId", "nativeProcessId"]) assert.equal(last[field], b.before[field]);
  for (const field of ["key", "stage", "documentToken", "windowToken", "href", "nodes", "sameDocument", "sameWindow", "sameRoot", "rootToken"]) assert.deepEqual(last.business[field], b.after.business[field]);
  assert.deepEqual(last.geometry, b.after.geometry); assert.deepEqual(last.business.errors, []); assert.equal(last.business.overflow, false);
  assert.equal(last.business.value, detail.value); assert.equal(post.value.trustedSubmit, true); assert.deepEqual({ ...post.value.business, receipt: post.receipt }, last.business);
  assert.deepEqual(last.business.events.map(event => [event.type, event.targetId]), [["pointerdown", "note"], ["pointerup", "note"], ["click", "note"], ["input", "note"], ["pointerdown", "submit"], ["pointerup", "submit"], ["click", "submit"], ["submit", "form"]]);
  for (const event of last.business.events) { assert.equal(event.trusted, true); assert.equal(event.nodeToken, `${detail.key}-b-${event.targetId}`); }
  for (const [id, box] of [["note", coldNavigationGeometry.input], ["submit", coldNavigationGeometry.b]]) near(last.business.events.find(event => event.type === "click" && event.targetId === id), center(box), `Original ${id} click`);
}

export function checkColdNavigationVisible(detail) {
  assert.deepEqual(detail.observationErrors, [], "Original visual observations failed");
  const initialB = detail.phases[1].before.feedback;
  assert.equal(initialB.openAgentLayers, 0); assert.equal(initialB.cursorVisible, false); assert.equal(initialB.targetVisible, false); assert.equal(initialB.visibleRings, 0);
  for (const phase of detail.phases) {
    const feedback = phase.after.feedback, box = coldNavigationGeometry[phase.name];
    assert.equal(feedback.connected, true); assert.equal(feedback.currentRoot, true); assert.equal(feedback.currentCount, 1);
    near(feedback.cursor && center(feedback.cursor), center(box), "Original visible cursor"); near(feedback.target, box, "Original visible leaf rectangle");
    assert.ok(phase.pixels.cursorDark >= 8 * phase.pixels.scale ** 2); for (const count of Object.values(phase.pixels.edges)) assert.ok(count >= 4 * phase.pixels.scale ** 2);
  }
  const b = detail.phases[1]; assert.deepEqual(b.after.rings, []); assert.equal(detail.after.rings.length, 2);
  for (const [index, ring] of detail.after.rings.entries()) { const point = center(index ? coldNavigationGeometry.b : coldNavigationGeometry.input);
    assert.equal(ring.stage, "b"); assert.equal(ring.documentToken, detail.after.business.documentToken); assert.equal(ring.connected, true); assert.equal(ring.currentRoot, true); assert.equal(ring.rootIndex, b.after.feedback.rootIndex);
    assert.equal(ring.color, "rgb(20, 184, 166)"); assert.ok(ring.opacity > 0); near(ring.modelPoint, point, "Original ring model"); near(center(ring.rect), point, "Original ring rectangle");
  }
}

export const coldNavigationHeldMove = Object.freeze({ type: "mouseMoved", x: 210, y: 166, buttons: 0 });

export function coldNavigationInputs(value, { heldReadNavigation = false } = {}) {
  const move = box => ({ type: "mouseMoved", ...center(box), buttons: 0 });
  const click = box => [move(box), { type: "mousePressed", ...center(box), button: "left", buttons: 1, clickCount: 1 }, { type: "mouseReleased", ...center(box), button: "left", buttons: 0, clickCount: 1 }];
  return [move(coldNavigationGeometry.a), ...(heldReadNavigation ? [coldNavigationHeldMove] : []), move(coldNavigationGeometry.b), ...click(coldNavigationGeometry.input), { text: value }, ...click(coldNavigationGeometry.b)];
}

export function checkColdNavigationNative(detail, pngs, { heldReadNavigation = false } = {}) {
  const bInputIndex = heldReadNavigation ? 2 : 1;
  const probe = detail.native; assert.equal(probe.restored, true); assert.equal(probe.pending, 0); assert.equal(probe.overflow, false); assert.equal(probe.recordingErrors, 0);
  assert.ok(probe.records.every((row, index) => row.sequence === index + 1));
  const calls = probe.records.filter(row => row.kind === "call"), acks = new Map();
  for (const call of calls) { const rows = probe.records.filter(row => row.kind === "settled" && row.invocation === call.sequence); assert.equal(rows.length, 1); assert.ok(rows[0].sequence > call.sequence); acks.set(call.sequence, rows[0]); }
  const beforeEnd = detail.beforeEnd.records.at(-1).sequence, nativeAbsences = [];
  assert.deepEqual(detail.beforeEnd.records, probe.records.slice(0, beforeEnd)); assert.equal(detail.beforeEnd.pending, 0);
  for (const field of ["pointerPending", "privateLeases"]) assert.equal(detail.beforeEnd.state[field], 0);
  assert.equal(detail.beforeEnd.state.engineAbsent, true); assert.equal(detail.beforeEnd.state.sameAttachment, true);
  assert.ok(calls.filter(row => row.sequence <= beforeEnd).every(row => acks.get(row.sequence).sequence <= beforeEnd), "Original calls settle before End");
  assert.equal(detail.endEvidence?.endRequested, true); assert.equal(detail.endEvidence.endAcknowledged, true);
  assert.equal(detail.endCleanup?.hidden, true); assert.equal(detail.endCleanup.originalDocuments, 1); assert.ok(detail.endCleanup.hiddenObservedMs >= 550);
  assert.deepEqual(detail.endCleanup.evidence, detail.endEvidence); assert.equal(detail.endCleanup.hiddenObservedMs, detail.endEvidence.hiddenObservedMs);
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
  const expected = coldNavigationInputs(detail.value, { heldReadNavigation }); assert.deepEqual(inputs.map(row => row.params), expected); assert.deepEqual(inputs.map(row => row.method), expected.map(params => "text" in params ? "Input.insertText" : "Input.dispatchMouseEvent"));
  for (let index = 1; index < inputs.length; index++) assert.ok(acks.get(inputs[index - 1].sequence).sequence < inputs[index].sequence);
  const enable = own.filter(row => row.method === "Runtime.enable"); assert.equal(enable.length, 1); assert.ok(acks.get(enable[0].sequence).sequence < inputs[0].sequence);
  for (const call of calls.filter(row => row.sequence >= enable[0].sequence && row.sequence <= beforeEnd)) assert.deepEqual(call.target, { tabId: detail.tabId }, "Root-only cold workflow cannot allocate on an unobserved target");
  for (const call of own.filter(row => row.sequence >= enable[0].sequence && row.sequence <= beforeEnd)) { assert.equal(call.state.engineAbsent, true); assert.equal(call.state.sameAttachment, true); }
  assert.equal(own.filter(row => row.method === "debugger.attach").length, 1);
  assert.equal(own.filter(row => row.method === "debugger.detach" && row.sequence <= beforeEnd).length, 0);
  for (const call of calls) assert.ok(!["DOM.enable", "Runtime.disable", "Target.setAutoAttach"].includes(call.method), `Unexpected caller-domain mutation ${call.method}`);
  const shots = own.filter(row => row.method === "Page.captureScreenshot"); assert.equal(shots.length, 2);
  for (const [index, shot] of shots.entries()) { assert.deepEqual(shot.params, { format: "png" }); assert.deepEqual(Buffer.from(acks.get(shot.sequence).value.data, "base64"), pngs[index]); assert.ok(acks.get(inputs[index ? bInputIndex : 0].sequence).sequence < shot.sequence); }
  const groups = new Map();
  for (const call of own) if (["Runtime.evaluate", "Runtime.callFunctionOn"].includes(call.method)) {
    const remotes = [acks.get(call.sequence).value?.result, acks.get(call.sequence).value?.exceptionDetails?.exception];
    if (remotes.some(remote => remote?.objectId)) assert.ok(typeof call.params.objectGroup === "string" && call.params.objectGroup.length, "Original native object must have an explicit released group");
    if (!call.params.objectGroup) continue;
    let group = groups.get(call.params.objectGroup); if (!group) groups.set(call.params.objectGroup, group = { calls: [], objects: [] }); group.calls.push(call.sequence);
    for (const remote of remotes) if (remote?.objectId) group.objects.push({ objectId: remote.objectId, invocation: call.sequence, ack: acks.get(call.sequence).sequence });
  }
  for (const [name, group] of groups) { const release = own.filter(row => row.method === "Runtime.releaseObjectGroup" && row.params.objectGroup === name); assert.equal(release.length, 1, `Original group ${name} release`); assert.ok(group.calls.every(sequence => acks.get(sequence).sequence < release[0].sequence)); group.release = { invocation: release[0].sequence, ack: acks.get(release[0].sequence).sequence }; assert.ok(group.release.ack <= beforeEnd, "Original native groups release before End/detach"); }
  const navigations = own.filter(row => row.method === "Page.navigate"); assert.equal(navigations.length, 2);
  const navigationProof = [];
  for (const [index, phase] of detail.phases.entries()) {
    const nav = navigations[index], ack = acks.get(nav.sequence), last = phase.native.records.at(-1).sequence, frame = phase.tree.frameTree.frame;
    assert.deepEqual(nav.params, { url: phase.url }); assert.equal(ack.value.errorText, undefined);
    assert.equal(ack.value.frameId, frame.id); assert.equal(ack.value.loaderId, frame.loaderId); assert.equal(frame.url, phase.url);
    assert.ok(ack.sequence < phase.moveBoundary); assert.deepEqual(phase.native.records, probe.records.slice(0, last));
    const commits = probe.records.filter(row => row.kind === "event" && row.source.tabId === detail.tabId && !row.source.sessionId && row.method === "Page.frameNavigated" && row.params.frame.id === frame.id && row.params.frame.loaderId === frame.loaderId && row.params.frame.url === phase.url);
    assert.equal(commits.length, 1); assert.ok(commits[0].sequence > nav.sequence && commits[0].sequence < phase.moveBoundary);
    const contextsAtMove = coldWorldContexts({ ...probe, records: probe.records.slice(0, phase.moveBoundary) }, frame.id);
    assert.deepEqual(contextsAtMove.defaults, phase.contexts.defaults);
    for (const context of [...phase.contexts.defaults, ...phase.contexts.worlds]) {
      const created = probe.records.filter(row => row.kind === "event" && row.source.tabId === detail.tabId && !row.source.sessionId && row.method === "Runtime.executionContextCreated" && row.params.context.uniqueId === context.uniqueId);
      assert.equal(created.length, 1); assert.ok(created[0].sequence > nav.sequence && created[0].sequence <= last);
    }
    if (index) {
      const boundary = detail.navigationBoundary, end = boundary.records.at(-1).sequence;
      assert.equal(boundary.pending, 0); assert.equal(boundary.state.pointerPending, 0); assert.equal(boundary.state.privateLeases, 0); assert.equal(boundary.state.sameAttachment, true); assert.equal(boundary.state.engineAbsent, true);
      assert.deepEqual(boundary.records, probe.records.slice(0, end)); assert.ok(end < nav.sequence);
      assert.ok(calls.filter(row => row.sequence <= end).every(row => acks.get(row.sequence).sequence <= end), "Original A calls settle before B navigation");
      for (const group of groups.values()) if (group.calls.some(sequence => sequence <= end)) assert.ok(group.calls.every(sequence => sequence <= end) && group.release.ack <= end, "All A groups release before B navigation");
      assert.ok(acks.get(shots[0].sequence).sequence <= end && nav.sequence < inputs[bInputIndex].sequence);
      const between = probe.records.slice(end, phase.moveBoundary).filter(row => row.kind === "event" && row.source.tabId === detail.tabId && !row.source.sessionId);
      for (const old of [...detail.phases[0].contexts.defaults, ...detail.phases[0].contexts.worlds]) assert.ok(between.some(row => row.method === "Runtime.executionContextsCleared" || row.method === "Runtime.executionContextDestroyed" && (row.params.executionContextUniqueId ? row.params.executionContextUniqueId === old.uniqueId : row.params.executionContextId === old.id)), "Original A context leaves the current Runtime set");
    }
    navigationProof.push({ invocation: nav.sequence, ack: ack.sequence, committed: commits[0].sequence, frameId: frame.id, loaderId: frame.loaderId });
  }
  const productionProof = [];
  for (const phase of detail.phases) {
    assert.ok(groups.has(phase.identity.group));
    const production = own.filter(row => row.sequence > phase.moveBoundary && row.sequence <= phase.native.records.at(-1).sequence && row.method === "DOM.describeNode");
    for (const name of ["root", "button"]) assert.ok(production.some(row => acks.get(row.sequence).value?.node?.backendNodeId === phase.identity[name].node.backendNodeId), `Production ${phase.name} ${name} must match independently read native node`);
    const hit = production.find(row => acks.get(row.sequence).value?.node?.backendNodeId === phase.identity.button.node.backendNodeId);
    const boxCalls = own.filter(row => row.sequence > hit.sequence && row.sequence <= phase.native.records.at(-1).sequence && row.method === "DOM.getBoxModel" && row.params.objectId === hit.params.objectId);
    assert.equal(boxCalls.length, 1); const border = acks.get(boxCalls[0].sequence).value?.model?.border, box = coldNavigationGeometry[phase.name];
    assert.ok(Array.isArray(border) && border.length === 8);
    for (const [index, point] of [[box.x, box.y], [box.x + box.width, box.y], [box.x + box.width, box.y + box.height], [box.x, box.y + box.height]].entries()) near({ x: border[index * 2], y: border[index * 2 + 1] }, { x: point[0], y: point[1] }, "Native hit border matches independently authored CSS");
    productionProof.push({ phase: phase.name, buttonBackendNodeId: phase.identity.button.node.backendNodeId, described: hit.sequence, box: boxCalls[0].sequence, boxACK: acks.get(boxCalls[0].sequence).sequence });
    const worlds = own.filter(row => row.sequence > phase.moveBoundary && row.sequence <= phase.native.records.at(-1).sequence && row.method === "Page.createIsolatedWorld"); assert.ok(worlds.length);
    for (const call of worlds) { assert.equal(call.params.frameId, phase.tree.frameTree.frame.id); assert.equal(call.params.worldName, phase.contexts.worlds[0].name); assert.equal(call.params.grantUniveralAccess, false); assert.equal(acks.get(call.sequence).value.executionContextId, phase.contexts.worlds[0].id); }
  }
  return { nativeAbsences, navigationProof, productionProof, inputs: inputs.map(row => ({ invocation: row.sequence, ack: acks.get(row.sequence).sequence })), screenshots: shots.map(row => ({ invocation: row.sequence, ack: acks.get(row.sequence).sequence })), groups: [...groups].map(([name, group]) => ({ name, ...group })) };
}

async function readDocument(worker, tabId, frame) {
  const rows = await worker.evaluate(`chrome.scripting.executeScript({target:{tabId:${tabId},documentIds:[${JSON.stringify(frame.documentId)}]},world:'MAIN',func:()=>window.coldNavigationState?.()??null})`);
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

export async function checkColdNavigation({ connectBrowser, getWorker, fixtureURL, fixtures, until, saveArtifact, saveDetail, closeTab, checkEnd, heldReadNavigation }) {
  const detail = { key: `cold-navigation-${randomUUID().replaceAll("-", "")}`, phases: [], tabIds: [], states: [], observationErrors: [], cleanupErrors: [],
    boundary: "One same-tab same-origin full A-to-B navigation after A's actual cold read/group drain. Original root attachment and persistent realm remain. Independent default-context identity reads add observation roundtrips. Native navigate's reply and subsequent identity observations are distinct; fixture observations do not expand the SDK load promise. Runtime events establish the current context set, not physical destruction of A's heap. Visual observations, including B's initially hidden feedback before its first input, are checked after both screenshots, unique B POST, End and cleanup; no held-read, BFCache, worker or iframe claim." };
  if (heldReadNavigation) {
    assert.equal(heldReadNavigation.kind, "late-hit-navigation");
    for (const name of ["afterADrain", "beforeBMove", "releaseFinally", "restore", "check"]) assert.equal(typeof heldReadNavigation[name], "function");
    detail.boundary = "One declared additional A move holds a successful original native hit handle's delivery across same-tab same-origin navigation. Native fulfillment and controlled delivery are separate. B input starts only after the old candidate and actual group cleanup settle. No B queued-display deadline, natural Chrome latency or reordered native execution is claimed.";
  }
  let browser, tab, failure; const pngs = [], control = (method, args = []) => getWorker().evaluate(`(()=>{const p=globalThis.__obuColdWorldLifetime;if(!p)throw Error('Cold world prefix missing');return p[${JSON.stringify(method)}](...${JSON.stringify(args)})})()`);
  const cleanup = async (stage, fn) => { try { return await fn(); } catch (error) { detail.cleanupErrors.push({ stage, error: errorText(error) }); failure ??= error; } };
  const observe = async (stage, fn) => { try { return await fn(); } catch (error) { detail.observationErrors.push({ stage, error: errorText(error) }); } };
  const drain = () => until(async () => { const probe = await control("snapshot"); return probe.pending === 0 && probe.state.pointerPending === 0 && probe.state.privateLeases === 0; }, "original cold navigation native reads settle", 5000);
  try {
    browser = await connectBrowser("cold-navigation"); await browser.client.beginTurn("cold-navigation-original"); detail.scope = scopeOf(browser);
    tab = await browser.newTab(); detail.tabIds.push(tab.id); detail.tabId = tab.id;
    detail.createdTab = await getWorker().evaluate(`chrome.tabs.get(${tab.id})`); assert.equal(detail.createdTab.active, false);
    await control("select", [tab.id]);
    const mouse = params => browser.cdp.call(tab.id, "Input.dispatchMouseEvent", params), move = box => mouse({ type: "mouseMoved", ...center(box), buttons: 0 });
    const click = async box => { await move(box); await mouse({ type: "mousePressed", ...center(box), button: "left", buttons: 1, clickCount: 1 }); await mouse({ type: "mouseReleased", ...center(box), button: "left", buttons: 0, clickCount: 1 }); };
    for (const name of ["a", "b"]) {
      const phase = { name, identity: {}, url: new URL(`${route}page?key=${detail.key}&stage=${name}`, fixtureURL).href }; detail.phases.push(phase);
      if (name === "b") { await drain(); detail.navigationBoundary = await control("mark", ["A-drained-before-original-B-navigation"]);
        if (heldReadNavigation) await heldReadNavigation.afterADrain({ browser, tab, detail });
      }
      phase.navigation = await browser.cdp.navigate(tab.id, phase.url);
      await until(async () => { const frames = await getWorker().evaluate(`chrome.webNavigation.getAllFrames({tabId:${tab.id}})`); const exact = frames.filter(frame => frame.frameId === 0 && frame.url === phase.url && frame.documentLifecycle === "active" && !frame.errorOccurred); if (exact.length !== 1) return false; phase.frames = exact; return true; }, `original navigation ${name} document`, 5000);
      detail.states = [{ tabId: tab.id, frames: phase.frames }];
      if (name === "a") { detail.runtimeEnable = await browser.cdp.call(tab.id, "Runtime.enable", {}); detail.realmReadiness = { observations: [] }; await waitForColdWorldRealm({ getWorker, until, evidence: detail.realmReadiness }); }
      phase.before = await readDocument(getWorker(), tab.id, phase.frames[0]); phase.tree = await browser.cdp.call(tab.id, "Page.getFrameTree", {});
      const prior = await control("snapshot"), defaults = coldWorldContexts(prior, phase.tree.frameTree.frame.id).defaults; assert.equal(defaults.length, 1);
      await readNodeIdentity(browser, tab.id, defaults[0].id, `fixture-cold-navigation-${detail.key}-${name}`, phase.identity);
      if (name === "b" && heldReadNavigation) await heldReadNavigation.beforeBMove({ browser, tab, detail, phase });
      phase.moveBoundary = (await control("mark", [`${name}-before-original-move`])).records.at(-1).sequence;
      await move(coldNavigationGeometry[name]);
      phase.arrival = await observe(`${name}-arrival`, () => getWorker().evaluate(`chrome.scripting.executeScript({target:{tabId:${tab.id},documentIds:[${JSON.stringify(phase.frames[0].documentId)}]},world:'MAIN',func:${waitForFrameTargetFeedback.toString()},args:[${JSON.stringify({ ...center(coldNavigationGeometry[name]), rectangle: coldNavigationGeometry[name] })}]})`));
      await observe(`${name}-png`, async () => { const shot = await browser.cdp.call(tab.id, "Page.captureScreenshot", { format: "png" }); const bytes = pngs[detail.phases.length - 1] = Buffer.from(shot.data, "base64"); phase.artifact = `cold-navigation-${name}.png`; await saveArtifact(phase.artifact, bytes); });
      phase.after = await readDocument(getWorker(), tab.id, phase.frames[0]);
      phase.pixels = await observe(`${name}-pixels`, () => measureFrameTargetPixels(pngs[detail.phases.length - 1], phase.after.geometry));
      await drain(); phase.native = await control("mark", [`${name}-after-original-screenshot`]); phase.contexts = coldWorldContexts(phase.native, phase.tree.frameTree.frame.id);
    }
    detail.value = "Original navigation B π note";
    await click(coldNavigationGeometry.input); await browser.cdp.call(tab.id, "Input.insertText", { text: detail.value }); await click(coldNavigationGeometry.b);
    await until(async () => { detail.after = await readDocument(getWorker(), tab.id, detail.phases[1].frames[0]); return !!detail.after.business.receipt; }, "original B document receipt", 5000);
    await drain(); detail.beforeEnd = await control("mark", ["after-original-B-business"]);
    if (checkEnd) await cleanup("original-turn-end", async () => { detail.endCleanup = await checkEnd(detail, browser); });
  } catch (error) { failure ??= error; detail.workflowError = errorText(error); }
  finally {
    if (heldReadNavigation) await cleanup("held-read-finally-release", () => heldReadNavigation.releaseFinally({ browser, tab, detail }));
    await cleanup("original-server-ledger", () => { detail.server = fixtures.stats(detail.key); });
    if (browser) await cleanup("original-owner-finalize", async () => { detail.finalizeScope = scopeOf(browser); detail.finalized = await browser.client.finalizeTabs([]); });
    if (tab) await cleanup("original-exact-tab-close", async () => { const tabs = await getWorker().evaluate("chrome.tabs.query({})"); if (tabs.some(value => value.id === tab.id)) await closeTab(tab); });
    if (browser) await cleanup("original-owner-close", () => browser.close());
    await cleanup("original-observer-drain", () => until(async () => (await control("snapshot")).pending === 0, "original navigation observer drain", 5000));
    if (heldReadNavigation) await cleanup("held-read-observer-restore", () => heldReadNavigation.restore({ browser, tab, detail }));
    await cleanup("original-observer-restore", async () => { detail.native = await control("restore"); });
    await cleanup("original-exact-inventory", async () => { detail.cleanup = await getWorker().evaluate(`(async()=>({tabs:(await chrome.tabs.query({})).filter(t=>t.id===${tab?.id ?? -1}),targets:(await chrome.debugger.getTargets()).filter(t=>t.tabId===${tab?.id ?? -1})}))()`); assert.deepEqual(detail.cleanup, { tabs: [], targets: [] }); });
  }
  if (!failure) try { checkColdNavigationIdentity(detail); checkColdNavigationBusiness(detail); detail.nativeProof = checkColdNavigationNative(detail, pngs, { heldReadNavigation: !!heldReadNavigation }); if (heldReadNavigation) detail.heldReadProof = heldReadNavigation.check(detail); checkColdNavigationVisible(detail); }
  catch (error) { failure = error; detail.oracleError = errorText(error); }
  detail.passed = !failure; if (failure) detail.error = errorText(failure);
  try { await saveDetail(detail); } catch (error) { failure ??= error; }
  if (failure) throw failure; return detail;
}
