import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import vm from "node:vm";
import { createHash } from "node:crypto";
import { listenFixture } from "./fixture-listener.mjs";
import { coldWorldContexts } from "./cold-world-lifetime-fixture.mjs";
import { coldRootRebuildGeometry as boxes, coldRootRebuildHTML, createColdRootRebuildFixtures, checkColdRootRebuild,
  checkColdRootRebuildIdentity, checkColdRootRebuildBusiness, checkColdRootRebuildNative, checkColdRootRebuildVisible, coldRootRebuildInputs } from "./cold-root-rebuild-fixture.mjs";

const copy = value => structuredClone(value), hash = bytes => createHash("sha256").update(bytes).digest("hex");
const center = r => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 }), key = `root-rebuild-${"a".repeat(32)}`;
const ids = ["note", "submit", "form", "panel", "rebuild"];
const contexts = [ { id: 1, name: "", uniqueId: "same-default-unique", auxData: { frameId: "frame", isDefault: true } },
  { id: 2, name: "Open Browser Use passive pointer original", uniqueId: "same-passive-unique", auxData: { frameId: "frame", isDefault: false } } ];
const state = { engineAbsent: true, sameAttachment: true, pointerPending: 0, privateLeases: 0 };
const tree = { frameTree: { frame: { id: "frame", loaderId: "loader" } } };
const change = { sequence: 1, trusted: true, nodeToken: `${key}-original-rebuild`, documentToken: "doc-token", windowToken: "window-token" };
function events() {
  return [["pointerdown", "rebuild"], ["pointerup", "rebuild"], ["click", "rebuild"], ["pointerdown", "note"], ["pointerup", "note"], ["click", "note"], ["input", "note"], ["pointerdown", "submit"], ["pointerup", "submit"], ["click", "submit"], ["submit", "form"]].map(([type, targetId], i) => ({ sequence: i + 1, type, targetId, trusted: true, rebuilt: targetId !== "rebuild", nodeToken: `${key}-${targetId === "rebuild" ? "original" : "rebuilt"}-${targetId}`,
    ...(["pointerdown", "pointerup", "click"].includes(type) ? center(boxes[targetId === "submit" ? "rebuilt" : targetId === "note" ? "input" : "rebuild"]) : {}) }));
}
function document(name) {
  const rebuilt = name === "rebuilt", point = center(boxes[name]);
  return { nativeDocumentId: "native-document", nativeFrameId: 0, nativeProcessId: 15,
    business: { key, documentToken: "doc-token", windowToken: "window-token", href: `http://127.0.0.1:55000/cold-root-rebuild/page?key=${key}`,
      sameDocument: true, sameWindow: true, rebuilt, sameRoot: !rebuilt, oldRootConnected: !rebuilt, rootToken: `${key}-${name}-html`,
      oldNodes: ids.map(id => ({ id, token: `${key}-original-${id}`, connected: !rebuilt, current: !rebuilt })),
      nodes: ids.map(id => ({ id, token: `${key}-${name}-${id}`, connected: true })), value: "", activeElement: "", selection: { start: 0, end: 0, direction: "none" },
      events: rebuilt ? events().slice(0, 3) : [], focus: rebuilt ? [{ type: "focusin", targetId: "rebuild", trusted: true }] : [], changes: rebuilt ? [copy(change)] : [], errors: [], overflow: false, receipt: null },
    geometry: { button: copy(boxes[name]), input: rebuilt ? copy(boxes.input) : { x: 46, y: 48, width: 280, height: 36 }, parents: [], viewport: { width: 1000, height: 700, dpr: 1, scrollX: 0, scrollY: 0 } }, rings: [],
    feedback: { connected: true, currentRoot: true, currentCount: 1, rootIndex: rebuilt ? 1 : 0, roots: rebuilt ? [{ connected: false, current: false }, { connected: true, current: true }] : [{ connected: true, current: true }],
      cursor: { x: point.x - 12, y: point.y - 12, width: 24, height: 24 }, target: copy(boxes[name]), modelPoint: point } };
}
function probe() { return { tabId: 7, workerId: "worker", pending: 0, overflow: false, recordingErrors: 0, restored: false, state: copy(state), records: contexts.map((context, i) => ({ sequence: i + 1, kind: "event", source: { tabId: 7 }, method: "Runtime.executionContextCreated", params: { context: copy(context) } })) }; }
function append(p, row) { const value = { sequence: p.records.length + 1, ...row }; p.records.push(value); return value; }
function call(p, method, params = {}, value = {}) {
  const c = append(p, { kind: "call", target: { tabId: 7 }, method, params, state: copy(state) }); append(p, { kind: "settled", invocation: c.sequence, ok: true, value }); return c;
}
function fixture() {
  const phases = ["original", "rebuilt"].map((name, i) => { const snapshot = document(name), native = probe(); return { name, before: copy(snapshot), after: snapshot, tree: copy(tree), native, contexts: coldWorldContexts(native, "frame"),
    identity: { contextId: 1, group: `fixture-${name}`, released: true, root: { node: { backendNodeId: 100 + i, frameId: "frame", nodeName: "HTML", attributes: ["data-token", `${key}-${name}-html`] } }, button: { node: { backendNodeId: 200 + i, nodeName: "BUTTON", attributes: ["id", "submit", "data-token", `${key}-${name}-submit`] } } }, pixels: { scale: 1, cursorDark: 80, edges: { top: 20, left: 20, bottom: 20, right: 20 } } }; });
  const after = copy(phases[1].after), value = "Original π"; after.business.events = events(); after.business.value = value; after.business.activeElement = "submit";
  after.rings = [boxes.input, boxes.rebuilt].map((box, i) => ({ sequence: i + 1, rebuilt: true, documentToken: "doc-token", connected: true, currentRoot: true, rootIndex: 1, modelPoint: center(box), rect: { x: center(box).x - 12, y: center(box).y - 12, width: 24, height: 24 }, color: "rgb(20, 184, 166)", opacity: 1 }));
  const body = { key, trustedSubmit: true, business: copy(after.business) }, bytes = Buffer.from(JSON.stringify(body)), receipt = { key, index: 1, bodySHA256: hash(bytes) }; after.business.receipt = receipt;
  return { key, value, tabId: 7, phases, after, observationErrors: [], server: { gets: [{ documentToken: "doc-token", url: after.business.href }], posts: [{ value: body, receipt, bodyBytes: bytes.length, bodyBase64: bytes.toString("base64"), bodySHA256: hash(bytes) }] } };
}
function nativeFixture() {
  const detail = fixture(), p = probe(), inputs = coldRootRebuildInputs(detail.value), pngs = [Buffer.from("original native A PNG"), Buffer.from("original native B PNG")];
  call(p, "debugger.attach", { version: "1.3" }); call(p, "Runtime.enable");
  const input = index => call(p, "text" in inputs[index] ? "Input.insertText" : "Input.dispatchMouseEvent", inputs[index]);
  for (const [i, phase] of detail.phases.entries()) {
    if (i) for (let index = 1; index < 4; index++) input(index);
    for (const name of ["root", "button"]) { call(p, "Runtime.evaluate", { objectGroup: phase.identity.group }, { result: { objectId: `${phase.name}-oracle-${name}` } }); call(p, "DOM.describeNode", { objectId: `${phase.name}-oracle-${name}` }, { node: copy(phase.identity[name].node) }); }
    call(p, "Runtime.releaseObjectGroup", { objectGroup: phase.identity.group });
    phase.moveBoundary = append(p, { kind: "marker", label: "before move" }).sequence; input(i ? 4 : 0);
    call(p, "Page.createIsolatedWorld", { frameId: "frame", worldName: contexts[1].name, grantUniveralAccess: false }, { executionContextId: 2 });
    const group = `production-${phase.name}`; call(p, "Runtime.evaluate", { objectGroup: group }, { result: { objectId: `${group}-capture` } });
    for (const name of ["root", "button"]) { call(p, "Runtime.callFunctionOn", { objectGroup: group }, { result: { objectId: `${group}-${name}` } }); call(p, "DOM.describeNode", { objectId: `${group}-${name}` }, { node: copy(phase.identity[name].node) }); }
    call(p, "Runtime.releaseObjectGroup", { objectGroup: group }); call(p, "Page.captureScreenshot", { format: "png" }, { data: pngs[i].toString("base64") });
    phase.native = copy(p); phase.contexts = coldWorldContexts(phase.native, "frame");
  }
  for (let index = 5; index < inputs.length; index++) input(index);
  detail.beforeEnd = copy(p); call(p, "debugger.detach", { version: null }); p.restored = true; detail.native = p;
  return { detail, pngs };
}

function detachedNativeFixture() {
  const value = nativeFixture(), d = value.detail, p = d.native;
  d.endEvidence = { endRequested: true, endAcknowledged: true, hiddenObservedMs: 560 };
  d.endCleanup = { hidden: true, originalDocuments: 1, hiddenObservedMs: 560, evidence: copy(d.endEvidence) };
  d.scope = { session_id: "original-session", turn_id: "original-turn", control_epoch: 1 };
  d.finalizeScope = { session_id: "original-session", turn_id: "after-end-turn", control_epoch: 2 };
  d.finalized = { lifecycleVersion: 1, endedTurnId: "after-end-turn", nextTurnId: "finalized-turn", controlEpoch: 3 };
  d.cleanup = { tabs: [], targets: [] };
  p.records.find(row => row.method === "debugger.detach").state = { ...copy(state), attached: true, originalAttachmentSeen: true };
  p.state = { ...copy(state), attached: false, originalAttachmentSeen: true, sameAttachment: false };
  for (let index = 0; index < 5; index++) {
    const row = call(p, "debugger.detach", { version: null });
    row.state = { ...copy(state), attached: false, originalAttachmentSeen: true, sameAttachment: false };
    Object.assign(p.records.at(-1), { ok: false, error: "Error: Debugger is not attached to the tab with id: 7." });
  }
  return value;
}

test("post-End detach's original exact absence is recorded after the successful detach ACK, never as success", () => {
  const { detail, pngs } = detachedNativeFixture(), before = copy(detail.native);
  const proof = checkColdRootRebuildNative(detail, pngs);
  assert.equal(proof.nativeAbsences.length, 5);
  for (const absence of proof.nativeAbsences) {
    assert.equal(absence.classification, "already-detached"); assert.equal(absence.ok, false);
    assert.equal(absence.error, "Error: Debugger is not attached to the tab with id: 7.");
    assert.ok(absence.afterSuccessfulDetachACK < absence.invocation); assert.ok(absence.invocation < absence.settlement);
  }
  assert.deepEqual(detail.native, before, "Retain actual failed native outcomes");
});

test("detach absence cannot hide early, foreign, pending, malformed or successor-input native failures", () => {
  for (const mutate of [
    d => { d.native.records.find(row => row.method === "debugger.detach").method = "Target.getTargetInfo"; },
    d => { const row = d.native.records.find(row => row.method === "debugger.detach"); Object.assign(d.native.records.find(ack => ack.invocation === row.sequence), { ok: false, error: "Error: Debugger is not attached to the tab with id: 7." }); },
    d => { d.native.records.filter(row => row.method === "debugger.detach")[1].target = { tabId: 8 }; },
    d => { d.native.records.filter(row => row.method === "debugger.detach")[1].target.sessionId = "child"; },
    d => { d.native.records.find(row => row.ok === false).error = "Error: Debugger is not attached to the tab with id: 8."; },
    d => { d.native.records.find(row => row.ok === false).error += " permission denied"; },
    d => { d.native.records.filter(row => row.method === "debugger.detach")[1].params.version = "1.3"; },
    d => { d.native.records.find(row => row.ok === false).synchronous = true; },
    d => { d.native.records.filter(row => row.method === "debugger.detach")[1].state.attached = true; },
    d => { d.native.records.filter(row => row.method === "debugger.detach")[1].state.pointerPending = 1; },
    d => { d.native.records.filter(row => row.method === "debugger.detach")[1].state.privateLeases = 1; },
    d => { d.native.pending = 1; }, d => { d.endCleanup.hidden = false; }, d => { d.cleanup.targets.push({ id: "still-owned" }); },
    d => { d.finalized.endedTurnId = "other-turn"; },
    d => { call(d.native, "Input.dispatchMouseEvent", coldRootRebuildInputs(d.value)[0]); },
    d => { call(d.native, "debugger.attach", { version: "1.3" }); },
    d => { const rows = d.native.records, prior = rows.find(row => row.method === "debugger.detach"), firstFailure = rows.find(row => row.ok === false), ack = rows.find(row => row.invocation === prior.sequence); ack.sequence = firstFailure.sequence; },
    d => { const callRow = d.native.records.find(row => row.method === "Runtime.releaseObjectGroup"), failed = d.native.records.find(row => row.ok === false); d.native.records.find(row => row.invocation === callRow.sequence).sequence = failed.sequence; }
  ]) { const { detail, pngs } = detachedNativeFixture(); mutate(detail); assert.throws(() => checkColdRootRebuildNative(detail, pngs)); }
});

test("finalize detach absence requires the actual End request and ACK in the identical returned evidence", () => {
  for (const mutate of [
    d => { delete d.endEvidence.endRequested; delete d.endCleanup.evidence.endRequested; },
    d => { delete d.endEvidence.endAcknowledged; delete d.endCleanup.evidence.endAcknowledged; },
    d => { d.endEvidence.endAcknowledged = false; d.endCleanup.evidence.endAcknowledged = false; },
    d => { d.endCleanup.evidence = { ...d.endEvidence, differentOriginalEnd: true }; },
    d => { d.endCleanup.evidence.hiddenObservedMs = 559; },
    d => { d.endCleanup.hiddenObservedMs = 561; }
  ]) { const { detail, pngs } = detachedNativeFixture(); mutate(detail); assert.throws(() => checkColdRootRebuildNative(detail, pngs)); }
});

test("same document and persistent realm identity permit new root/button, never substituted old nodes", () => {
  checkColdRootRebuildIdentity(fixture());
  for (const mutate of [d => { d.phases[1].identity.root.node.backendNodeId = 100; }, d => { d.phases[1].identity.button.node.backendNodeId = 200; },
    d => { d.phases[1].contexts.defaults[0].uniqueId = "reused-number-new-context"; }, d => { d.phases[1].contexts.worlds[0].uniqueId = "new-world"; },
    d => { d.phases[1].after.business.oldRootConnected = true; }, d => { d.phases[1].before.business.oldNodes[1].connected = true; },
    d => { d.phases[1].tree.frameTree.frame.loaderId = "new-loader"; }, d => { d.phases[1].after.nativeDocumentId = "other-document"; },
    d => { d.phases[1].identity.root.node.frameId = "other-frame"; }, d => { d.phases[1].identity.released = false; },
    d => { d.phases[1].identity.button.node.nodeName = "DIV"; }, d => { d.phases[1].identity.root.node.attributes[1] = "other-root"; },
    d => { d.phases[1].after.business.focus.push({ type: "focusin", targetId: "submit" }); }]) { const d = fixture(); mutate(d); assert.throws(() => checkColdRootRebuildIdentity(d)); }
});

test("one trusted rebuild and original unique POST retain exact document and bytes", () => {
  checkColdRootRebuildBusiness(fixture());
  for (const mutate of [d => { d.after.business.changes.push(copy(change)); }, d => { d.after.business.events[2].trusted = false; },
    d => { d.after.business.events[9].nodeToken = `${key}-original-submit`; }, d => { d.server.posts.push(copy(d.server.posts[0])); },
    d => { d.server.posts[0].bodySHA256 = "other"; }, d => { d.after.nativeProcessId++; }, d => { d.after.business.events[2].x++; d.after.business.events[2].x++; }]) {
    const d = fixture(); mutate(d); assert.throws(() => checkColdRootRebuildBusiness(d));
  }
});

test("visible new root geometry and original ring cannot be replaced by old model or cursor alone", () => {
  checkColdRootRebuildVisible(fixture());
  for (const mutate of [d => { d.phases[1].after.feedback.target = copy(boxes.original); }, d => { d.phases[1].after.feedback.connected = false; },
    d => { d.phases[1].after.feedback.roots[0].connected = true; }, d => { d.phases[1].pixels.edges.bottom = 0; },
    d => { d.phases[1].pixels.cursorDark = 0; }, d => { d.after.rings[1].rect.x += 3; }, d => { d.after.rings.push(copy(d.after.rings[1])); },
    d => { d.observationErrors.push({ stage: "rebuilt-arrival", error: "Original timeout" }); }]) { const d = fixture(); mutate(d); assert.throws(() => checkColdRootRebuildVisible(d)); }
});

test("actual native inputs, original screenshot bytes, production node IDs and all object-group ACKs join", () => {
  const { detail, pngs } = nativeFixture(), proof = checkColdRootRebuildNative(detail, pngs);
  assert.equal(proof.inputs.length, 12); assert.equal(proof.groups.length, 4); assert.equal(proof.groups.flatMap(group => group.objects).length, 10);
  for (const mutate of [
    d => { d.native.records.find(row => row.method === "Input.dispatchMouseEvent").params.x++; },
    d => { const row = d.native.records.find(row => row.method === "Runtime.releaseObjectGroup"); d.native.records.find(ack => ack.invocation === row.sequence).ok = false; },
    d => { const row = d.native.records.find(row => row.method === "Input.dispatchMouseEvent"); d.native.records.find(ack => ack.invocation === row.sequence).sequence = 0; },
    d => { d.native.records.find(row => row.method === "Input.dispatchMouseEvent").state.sameAttachment = false; },
    d => { delete d.native.records.find(row => row.method === "Runtime.evaluate").params.objectGroup; },
    d => { const row = d.native.records.find(row => row.method === "Page.captureScreenshot"); d.native.records.find(ack => ack.invocation === row.sequence).value.data = Buffer.from("different").toString("base64"); },
    d => { for (const row of d.native.records.filter(row => row.method === "DOM.describeNode" && row.params.objectId === "production-rebuilt-button")) d.native.records.find(ack => ack.invocation === row.sequence).value.node.backendNodeId = 200; },
    d => { const row = d.native.records.find(row => row.method === "Runtime.releaseObjectGroup"); row.params.objectGroup = "wrong-group"; }
  ]) { const value = nativeFixture(); mutate(value.detail); assert.throws(() => checkColdRootRebuildNative(value.detail, value.pngs)); }
});

function workflow({ clickError, cleanupError } = {}) {
  const value = fixture(), trace = probe(), calls = [], artifacts = [], inputs = [], frames = [{ frameId: 0, documentId: "native-document", processId: 15, documentLifecycle: "active", errorOccurred: false }];
  let stage = "original", created = true, submitted = false, saved, requestKey, url;
  const adapt = snapshot => JSON.parse(JSON.stringify(snapshot).replaceAll(key, requestKey ?? key).replaceAll(`http://127.0.0.1:55000/cold-root-rebuild/page?key=${requestKey ?? key}`, url ?? value.after.business.href));
  const browser = { client: { sessionId: "session", turnId: "turn", controlEpoch: 1, async beginTurn() {}, async finalizeTabs() { calls.push("finalize"); return {}; } },
    async newTab(...args) { assert.equal(args.length, 0); return { id: 7, locator() { throw Error("No locator allowed"); } }; }, async close() { calls.push("close-owner"); },
    cdp: { async navigate(tabId, target) { assert.equal(tabId, 7); url = target; requestKey = new URL(url).searchParams.get("key"); frames[0].url = url; }, async call(tabId, method, params) {
      assert.equal(tabId, 7);
      if (method === "Page.getFrameTree") return copy(tree);
      if (method === "Runtime.enable") return {};
      if (method === "Runtime.evaluate") { assert.equal(params.userGesture, false); assert.equal(params.awaitPromise, false); return { result: { objectId: `${stage}-${params.expression.includes("getElementById") ? "button" : "root"}` } }; }
      if (method === "DOM.describeNode") return { node: copy(value.phases[stage === "original" ? 0 : 1].identity[params.objectId.endsWith("button") ? "button" : "root"].node) };
      if (method === "Runtime.releaseObjectGroup") { calls.push("release-group"); return {}; }
      if (method === "Page.captureScreenshot") { calls.push(`png:${stage}`); return { data: Buffer.from(`original-${stage}-native-png`).toString("base64") }; }
      assert.ok(method.startsWith("Input.")); inputs.push({ method, params: copy(params) });
      if (params.type === "mouseReleased" && params.y === center(boxes.rebuild).y) { if (clickError) throw clickError; stage = "rebuilt"; calls.push("rebuild"); }
      if (params.type === "mouseReleased" && params.y === center(boxes.rebuilt).y) { submitted = true; calls.push("submit"); }
      return {};
    } } };
  const worker = { async evaluate(source) {
    if (source.includes("realm.snapshot()")) return { mode: "persistent-identity", snapshot: { available: true, state: "ready" } };
    if (source.includes("chrome.tabs.get")) return { id: 7, active: false };
    if (source.includes("chrome.webNavigation.getAllFrames")) return copy(frames);
    if (source.includes("chrome.scripting.executeScript")) {
      if (source.includes("Original frame feedback model did not arrive")) { calls.push(`arrival:${stage}`); throw Error(`Original ${stage} visual wait failure`); }
      return [{ frameId: 0, documentId: "native-document", result: adapt(submitted ? value.after : value.phases[stage === "original" ? 0 : 1].after) }];
    }
    if (source.includes("__obuColdWorldLifetime")) { const method = source.match(/return p\[("[^"]+")\]/)?.[1]; if (method === '"restore"') { calls.push("restore"); trace.restored = true; } if (method === '"mark"') append(trace, { kind: "marker", label: "original" }); return copy(trace); }
    if (source.includes("chrome.debugger.getTargets")) return { tabs: [], targets: [] };
    if (source.includes("chrome.tabs.query")) return created ? [{ id: 7 }] : [];
    throw Error(`Unexpected read: ${source}`);
  } };
  return { connectBrowser: async () => browser, getWorker: () => worker, fixtureURL: "http://127.0.0.1:55000", fixtures: { stats: () => { const record = adapt(value.server); if (!submitted) record.posts = []; return record; } },
    until: async check => { const result = await check(); assert.ok(result); return result; }, saveArtifact: async (name, bytes) => artifacts.push({ name, bytes }),
    saveDetail: async detail => { saved = copy(detail); }, closeTab: async tab => { assert.equal(tab.id, 7); created = false; calls.push("close-tab"); if (cleanupError) throw cleanupError; },
    checkEnd: async detail => { assert.equal(submitted, true); assert.equal(detail.phases.length, 2); calls.push("end"); return { hidden: true }; },
    calls, artifacts, inputs, detail: () => saved };
}

test("visual wait and pixel failures still save both native PNGs, submit once and End without input replay", async () => {
  const harness = workflow(); await assert.rejects(checkColdRootRebuild(harness));
  const detail = harness.detail(); assert.equal(harness.artifacts.length, 2); assert.deepEqual(harness.artifacts.map(row => row.bytes.toString()), ["original-original-native-png", "original-rebuilt-native-png"]);
  assert.equal(detail.observationErrors.length, 4); assert.equal(detail.server.posts.length, 1); assert.equal(harness.calls.filter(call => call === "rebuild").length, 1); assert.equal(harness.calls.filter(call => call === "submit").length, 1);
  assert.ok(harness.calls.indexOf("png:rebuilt") < harness.calls.indexOf("submit")); assert.ok(harness.calls.indexOf("submit") < harness.calls.indexOf("end")); assert.ok(harness.calls.indexOf("end") < harness.calls.indexOf("finalize"));
  assert.equal(detail.native.restored, true); assert.deepEqual(detail.cleanup, { tabs: [], targets: [] });
  assert.deepEqual(harness.inputs.map(row => row.params), coldRootRebuildInputs(detail.value));
});

test("real application input error stays primary through original observer restoration and cleanup error", async () => {
  const original = Error("Original native release failed"), harness = workflow({ clickError: original, cleanupError: Error("Original cleanup failure") });
  await assert.rejects(checkColdRootRebuild(harness), error => error === original);
  const detail = harness.detail(); assert.match(detail.workflowError, /Original native release failed/); assert.ok(detail.cleanupErrors.some(row => /Original cleanup failure/.test(row.error)));
  assert.equal(detail.native.restored, true); assert.equal(harness.inputs.length, 4); assert.equal(harness.artifacts.length, 1); assert.equal(detail.server.posts.length, 0);
});

test("original application markup compiles and authored A/B boxes cannot coincide", () => {
  const html = coldRootRebuildHTML(key, "document"); new vm.Script(html.match(/<script>([\s\S]*)<\/script>/)[1]);
  assert.notEqual(boxes.original.x, boxes.rebuilt.x); assert.notEqual(boxes.original.y, boxes.rebuilt.y); assert.notEqual(boxes.original.width, boxes.rebuilt.width); assert.notEqual(boxes.original.height, boxes.rebuilt.height);
  assert.match(html, /document\.replaceChild\(document\.importNode/); assert.doesNotMatch(html, /\.focus\(|dispatchEvent\(/);
});

test("HTTP records original Host, one original GET and raw unique POST bytes", async t => {
  const fixtures = createColdRootRebuildFixtures(), server = http.createServer((request, response) => { if (!fixtures.handle(request, response, new URL(request.url, "http://127.0.0.1"))) { response.writeHead(404); response.end(); } });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); })); const port = await listenFixture(server), origin = `http://127.0.0.1:${port}`, path = `/cold-root-rebuild/page?key=${key}`;
  const page = await new Promise((resolve, reject) => { const req = http.get(`${origin}${path}`, { headers: { Host: `localhost:${port}` } }, reply => { const chunks = []; reply.on("data", chunk => chunks.push(chunk)); reply.on("end", () => resolve({ status: reply.statusCode, html: Buffer.concat(chunks).toString() })); reply.on("error", reject); }); req.on("error", reject); });
  assert.equal(page.status, 200); new vm.Script(page.html.match(/<script>([\s\S]*)<\/script>/)[1]);
  const original = fixtures.stats(key).gets[0]; assert.equal(original.url, `http://localhost:${port}${path}`);
  const bytes = Buffer.from(JSON.stringify({ key, trustedSubmit: true, business: { documentToken: original.documentToken, href: original.url } }));
  const response = await fetch(`${origin}/cold-root-rebuild/post?key=${key}`, { method: "POST", body: bytes }); assert.equal(response.status, 200); assert.equal((await response.json()).bodySHA256, hash(bytes));
  assert.equal(fixtures.stats(key).posts[0].bodyBase64, bytes.toString("base64"));
  const repeat = await fetch(`${origin}${path}`); assert.equal(repeat.status, 400); await repeat.text();
});
