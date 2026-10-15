import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import vm from "node:vm";
import { createHash } from "node:crypto";
import { listenFixture } from "./fixture-listener.mjs";
import { coldWorldContexts } from "./cold-world-lifetime-fixture.mjs";
import { coldNavigationGeometry as boxes, coldNavigationHTML, createColdNavigationFixtures, checkColdNavigation,
  checkColdNavigationIdentity, checkColdNavigationBusiness, checkColdNavigationNative, checkColdNavigationVisible, coldNavigationInputs, coldNavigationHeldMove } from "./cold-navigation-fixture.mjs";

const copy = value => structuredClone(value), hash = bytes => createHash("sha256").update(bytes).digest("hex");
const center = rect => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }), key = `cold-navigation-${"a".repeat(32)}`;
const ids = ["note", "submit", "form", "panel"], url = name => `http://127.0.0.1:55000/cold-navigation/page?key=${key}&stage=${name}`;
const state = { engineAbsent: true, attached: true, originalAttachmentSeen: true, sameAttachment: true, pointerPending: 0, privateLeases: 0 };
const contexts = name => [ { id: 1, name: "", uniqueId: `${name}-default-unique`, auxData: { frameId: "frame", isDefault: true } },
  { id: 2, name: "Open Browser Use passive pointer persistent", uniqueId: `${name}-passive-unique`, auxData: { frameId: "frame", isDefault: false } } ];
const tree = name => ({ frameTree: { frame: { id: "frame", loaderId: `${name}-loader`, url: url(name) } } });
function events() { return [["pointerdown", "note"], ["pointerup", "note"], ["click", "note"], ["input", "note"], ["pointerdown", "submit"], ["pointerup", "submit"], ["click", "submit"], ["submit", "form"]].map(([type, targetId], i) => ({ sequence: i + 1, type, targetId, trusted: true, nodeToken: `${key}-b-${targetId}`,
  ...(["pointerdown", "pointerup", "click"].includes(type) ? center(targetId === "note" ? boxes.input : boxes.b) : {}) })); }
function document(name) {
  const point = center(boxes[name]);
  return { nativeDocumentId: `${name}-native-document`, nativeFrameId: 0, nativeProcessId: 15,
    business: { key, stage: name, documentToken: `${name}-doc-token`, windowToken: `${name}-window-token`, href: url(name), sameDocument: true, sameWindow: true, sameRoot: true, rootToken: `${key}-${name}-html`,
      nodes: ids.map(id => ({ id, token: `${key}-${name}-${id}`, connected: true, original: true })), value: "", activeElement: "", selection: { start: 0, end: 0, direction: "none" }, events: [], focus: [], errors: [], overflow: false, receipt: null },
    geometry: { button: copy(boxes[name]), input: name === "b" ? copy(boxes.input) : { x: 46, y: 48, width: 280, height: 36 }, parents: [], viewport: { width: 1000, height: 700, dpr: 1, scrollX: 0, scrollY: 0 } }, rings: [],
    feedback: { connected: true, currentRoot: true, currentCount: 1, rootIndex: 0, cursor: { x: point.x - 12, y: point.y - 12, width: 24, height: 24 }, target: copy(boxes[name]), modelPoint: point,
      openAgentLayers: 1, cursorOpacity: 1, cursorVisible: true, targetVisible: true, visibleRings: 0 } };
}
function probe() { return { tabId: 7, workerId: "original-worker", pending: 0, overflow: false, recordingErrors: 0, restored: false, state: copy(state), records: [] }; }
function append(p, row) { const value = { sequence: p.records.length + 1, ...row }; p.records.push(value); return value; }
function call(p, method, params = {}, value = {}) { const row = append(p, { kind: "call", target: { tabId: 7 }, method, params: copy(params), state: copy(state) }); append(p, { kind: "settled", invocation: row.sequence, ok: true, value: copy(value) }); return row; }
function event(p, method, params) { return append(p, { kind: "event", source: { tabId: 7 }, method, params: copy(params) }); }
function fixture() {
  const phases = ["a", "b"].map(name => { const snapshot = document(name), before = copy(snapshot), native = probe(); for (const context of contexts(name)) event(native, "Runtime.executionContextCreated", { context });
    Object.assign(before.feedback, { openAgentLayers: 0, cursorVisible: false, targetVisible: false, visibleRings: 0 });
    return { name, url: url(name), before, after: snapshot, tree: tree(name), native, contexts: coldWorldContexts(native, "frame"),
      identity: { contextId: 1, group: `fixture-${name}`, released: true, root: { node: { backendNodeId: 100, frameId: "frame", nodeName: "HTML", attributes: ["data-token", `${key}-${name}-html`] } }, button: { node: { backendNodeId: 200, nodeName: "BUTTON", attributes: ["id", "submit", "data-token", `${key}-${name}-submit`] } } },
      pixels: { scale: 1, cursorDark: 80, edges: { top: 20, bottom: 20, left: 20, right: 20 } } }; });
  const after = copy(phases[1].after), value = "Original B π"; after.business.events = events(); after.business.value = value; after.business.activeElement = "submit";
  after.rings = [boxes.input, boxes.b].map((box, i) => ({ sequence: i + 1, stage: "b", documentToken: "b-doc-token", connected: true, currentRoot: true, rootIndex: 0, modelPoint: center(box), rect: { x: center(box).x - 12, y: center(box).y - 12, width: 24, height: 24 }, color: "rgb(20, 184, 166)", opacity: 1 }));
  const body = { key, trustedSubmit: true, business: copy(after.business) }, bytes = Buffer.from(JSON.stringify(body)), receipt = { key, index: 1, bodySHA256: hash(bytes) }; after.business.receipt = receipt;
  return { key, value, tabId: 7, phases, after, observationErrors: [], server: { gets: ["a", "b"].map(stage => ({ stage, documentToken: `${stage}-doc-token`, url: url(stage) })), posts: [{ value: body, receipt, bodyBytes: bytes.length, bodyBase64: bytes.toString("base64"), bodySHA256: hash(bytes) }] } };
}
function nativeFixture() {
  const detail = fixture(), p = probe(), inputs = coldNavigationInputs(detail.value), pngs = [Buffer.from("native A PNG"), Buffer.from("native B PNG")];
  call(p, "debugger.attach", { version: "1.3" });
  const input = index => call(p, "text" in inputs[index] ? "Input.insertText" : "Input.dispatchMouseEvent", inputs[index]);
  for (const [index, phase] of detail.phases.entries()) {
    if (index) detail.navigationBoundary = copy(p);
    call(p, "Page.navigate", { url: phase.url }, { frameId: "frame", loaderId: `${phase.name}-loader` });
    if (index) event(p, "Runtime.executionContextsCleared", {});
    event(p, "Page.frameNavigated", { frame: copy(phase.tree.frameTree.frame) });
    if (!index) call(p, "Runtime.enable");
    event(p, "Runtime.executionContextCreated", { context: contexts(phase.name)[0] });
    for (const name of ["root", "button"]) { call(p, "Runtime.evaluate", { objectGroup: phase.identity.group }, { result: { objectId: `${phase.name}-oracle-${name}` } }); call(p, "DOM.describeNode", { objectId: `${phase.name}-oracle-${name}` }, { node: copy(phase.identity[name].node) }); }
    call(p, "Runtime.releaseObjectGroup", { objectGroup: phase.identity.group });
    phase.moveBoundary = append(p, { kind: "marker", label: "before move" }).sequence; input(index);
    call(p, "Page.createIsolatedWorld", { frameId: "frame", worldName: contexts(phase.name)[1].name, grantUniveralAccess: false }, { executionContextId: 2 });
    event(p, "Runtime.executionContextCreated", { context: contexts(phase.name)[1] });
    const group = `production-${phase.name}`; call(p, "Runtime.evaluate", { objectGroup: group }, { result: { objectId: `${group}-capture` } });
    for (const name of ["root", "button"]) { call(p, "Runtime.callFunctionOn", { objectGroup: group }, { result: { objectId: `${group}-${name}` } }); call(p, "DOM.describeNode", { objectId: `${group}-${name}` }, { node: copy(phase.identity[name].node) }); }
    const box = boxes[phase.name]; call(p, "DOM.getBoxModel", { objectId: `${group}-button` }, { model: { border: [box.x, box.y, box.x + box.width, box.y, box.x + box.width, box.y + box.height, box.x, box.y + box.height] } });
    call(p, "Runtime.releaseObjectGroup", { objectGroup: group }); call(p, "Page.captureScreenshot", { format: "png" }, { data: pngs[index].toString("base64") });
    phase.native = copy(p); phase.contexts = coldWorldContexts(phase.native, "frame");
  }
  for (let i = 2; i < inputs.length; i++) input(i);
  detail.beforeEnd = copy(p); call(p, "debugger.detach", { version: null }); p.state = { ...copy(state), attached: false, sameAttachment: false }; p.restored = true; detail.native = p;
  detail.endEvidence = { endRequested: true, endAcknowledged: true, hiddenObservedMs: 560 }; detail.endCleanup = { hidden: true, originalDocuments: 1, hiddenObservedMs: 560, evidence: copy(detail.endEvidence) };
  detail.scope = { session_id: "original-session", turn_id: "original-turn", control_epoch: 1 }; detail.finalizeScope = { session_id: "original-session", turn_id: "after-end-turn", control_epoch: 2 };
  detail.finalized = { lifecycleVersion: 1, endedTurnId: "after-end-turn", nextTurnId: "finalized-turn", controlEpoch: 3 }; detail.cleanup = { tabs: [], targets: [] };
  return { detail, pngs };
}

test("new documents and context unique IDs reuse world name, never require numeric IDs to change", () => {
  checkColdNavigationIdentity(fixture());
  for (const mutate of [d => { d.phases[1].before.nativeDocumentId = "a-native-document"; d.phases[1].after.nativeDocumentId = "a-native-document"; },
    d => { d.phases[1].tree.frameTree.frame.loaderId = "a-loader"; }, d => { d.phases[1].contexts.defaults[0].uniqueId = "a-default-unique"; },
    d => { d.phases[1].contexts.worlds[0].uniqueId = "a-passive-unique"; }, d => { d.phases[1].contexts.worlds[0].name += "different"; },
    d => { d.phases[1].contexts.worlds.push(copy(d.phases[1].contexts.worlds[0])); }, d => { d.phases[1].identity.button.node.nodeName = "DIV"; },
    d => { d.phases[1].identity.root.node.attributes[1] = `${key}-a-html`; }, d => { d.phases[1].identity.released = false; },
    d => { d.phases[1].after.business.focus.push({ type: "focusin", targetId: "submit" }); }, d => { d.phases[1].after.business.nodes[0].original = false; }
  ]) { const d = fixture(); mutate(d); assert.throws(() => checkColdNavigationIdentity(d)); }
});

test("A/B GETs and unique trusted B POST match original bytes and original B nodes", () => {
  checkColdNavigationBusiness(fixture());
  for (const mutate of [d => { d.server.gets.push(copy(d.server.gets[1])); }, d => { d.server.posts.push(copy(d.server.posts[0])); },
    d => { d.after.nativeDocumentId = "a-native-document"; }, d => { d.after.business.events[2].trusted = false; }, d => { d.after.business.events[6].nodeToken = `${key}-a-submit`; },
    d => { d.server.posts[0].bodySHA256 = "different"; }, d => { d.after.business.events[6].x += 3; }
  ]) { const d = fixture(); mutate(d); assert.throws(() => checkColdNavigationBusiness(d)); }
});

test("visible B cursor/outline and two original rings cannot use A geometry or a model without pixels", () => {
  checkColdNavigationVisible(fixture());
  for (const mutate of [d => { d.phases[1].after.feedback.target = copy(boxes.a); }, d => { d.phases[1].after.feedback.connected = false; },
    d => { d.phases[0].pixels.cursorDark = 0; }, d => { d.phases[1].pixels.edges.left = 0; }, d => { d.after.rings[1].documentToken = "a-doc-token"; },
    d => { d.after.rings[1].rect.x += 3; }, d => { d.after.rings.push(copy(d.after.rings[0])); }, d => { d.observationErrors.push({ error: "Original observation failure" }); }
  ]) { const d = fixture(); mutate(d); assert.throws(() => checkColdNavigationVisible(d)); }
});

test("B bootstrap is hidden before its first input, including when a renderer already exists", () => {
  const d = fixture(); assert.equal(d.phases[1].before.feedback.connected, true); assert.equal(d.phases[1].before.feedback.cursorOpacity, 1); checkColdNavigationVisible(d);
  for (const field of ["openAgentLayers", "cursorVisible", "targetVisible", "visibleRings"]) { const value = fixture(); value.phases[1].before.feedback[field] = field.endsWith("Visible") ? true : 1; assert.throws(() => checkColdNavigationVisible(value)); }
});

test("original two navigation ACKs, one attachment, native node/box and released groups join", () => {
  const { detail, pngs } = nativeFixture(), proof = checkColdNavigationNative(detail, pngs);
  assert.equal(proof.inputs.length, 9); assert.equal(proof.groups.length, 4); assert.equal(proof.navigationProof.length, 2); assert.equal(proof.productionProof.length, 2);
  for (const mutate of [d => { d.native.records.find(row => row.method === "Input.dispatchMouseEvent").params.x++; },
    d => { const row = d.native.records.find(row => row.method === "Runtime.releaseObjectGroup"); d.native.records.find(ack => ack.invocation === row.sequence).ok = false; },
    d => { d.native.records.find(row => row.method === "Input.dispatchMouseEvent").state.sameAttachment = false; },
    d => { d.native.records.find(row => row.method === "Input.dispatchMouseEvent").state.engineAbsent = false; },
    d => { delete d.native.records.find(row => row.method === "Runtime.evaluate").params.objectGroup; },
    d => { d.native.records.find(row => row.method === "Runtime.evaluate").target.sessionId = "unobserved-child"; },
    d => { const row = d.native.records.find(row => row.method === "Page.captureScreenshot"); d.native.records.find(ack => ack.invocation === row.sequence).value.data = "ZGlmZmVyZW50"; },
    d => { const row = d.native.records.find(row => row.method === "DOM.getBoxModel"); d.native.records.find(ack => ack.invocation === row.sequence).value.model.border[0] += 3; },
    d => { const row = d.native.records.filter(row => row.method === "Page.navigate")[1]; d.native.records.find(ack => ack.invocation === row.sequence).value.loaderId = "a-loader"; },
    d => { d.beforeEnd.pending = 1; }, d => { d.beforeEnd.state.pointerPending = 1; }, d => { d.beforeEnd.state.privateLeases = 1; },
    d => { delete d.endEvidence.endAcknowledged; delete d.endCleanup.evidence.endAcknowledged; }
  ]) { const value = nativeFixture(); mutate(value.detail); assert.throws(() => checkColdNavigationNative(value.detail, value.pngs)); }
});

test("A actual work must be drained and released before B; native context retirement cannot be implicit map replacement", () => {
  for (const mutate of [
    d => { d.navigationBoundary.pending = 1; }, d => { d.navigationBoundary.state.pointerPending = 1; }, d => { d.navigationBoundary.state.privateLeases = 1; },
    d => { const row = d.native.records.find(row => row.method === "Runtime.releaseObjectGroup" && row.params.objectGroup === "production-a"); d.native.records.find(ack => ack.invocation === row.sequence).sequence = d.native.records.filter(row => row.method === "Page.navigate")[1].sequence + 1; },
    d => { for (const probe of [d.native, d.phases[1].native, d.beforeEnd]) { const row = probe.records.find(row => row.method === "Runtime.executionContextsCleared"); row.method = "Unrelated.event"; } },
    d => { for (const probe of [d.native, d.phases[1].native, d.beforeEnd]) probe.records.find(row => row.method === "Runtime.executionContextsCleared").source.sessionId = "foreign"; }
  ]) { const { detail, pngs } = nativeFixture(); mutate(detail); assert.throws(() => checkColdNavigationNative(detail, pngs)); }
});

function withAbsence() {
  const value = nativeFixture(), p = value.detail.native;
  const row = call(p, "debugger.detach", { version: null }); row.state = copy(p.state);
  Object.assign(p.records.at(-1), { ok: false, error: "Error: Debugger is not attached to the tab with id: 7." }); return value;
}
test("exact post-End native absence remains a rejection and requires original End/finalize/cleanup evidence", () => {
  const { detail, pngs } = withAbsence(), original = copy(detail.native); const proof = checkColdNavigationNative(detail, pngs);
  assert.equal(proof.nativeAbsences.length, 1); assert.equal(proof.nativeAbsences[0].ok, false); assert.deepEqual(detail.native, original);
  for (const mutate of [
    d => { d.native.records.find(row => row.ok === false).error = "Error: Debugger is not attached to the tab with id: 8."; },
    d => { d.native.records.find(row => row.ok === false).error += " other error"; },
    d => { d.native.records.filter(row => row.method === "debugger.detach")[1].target = { tabId: 8 }; },
    d => { d.native.records.filter(row => row.method === "debugger.detach")[1].state.pointerPending = 1; },
    d => { const row = d.native.records.find(row => row.method === "debugger.detach"); Object.assign(d.native.records.find(ack => ack.invocation === row.sequence), { ok: false, error: "Error: Debugger is not attached to the tab with id: 7." }); },
    d => { d.endCleanup.evidence = { ...d.endEvidence, differentReceipt: true }; }, d => { d.finalized.endedTurnId = "other"; },
    d => { call(d.native, "Input.dispatchMouseEvent", coldNavigationInputs(d.value)[0]); }, d => { call(d.native, "debugger.attach", { version: "1.3" }); }, d => { d.cleanup.targets.push({ id: "owned" }); }
  ]) { const value = withAbsence(); mutate(value.detail); assert.throws(() => checkColdNavigationNative(value.detail, value.pngs)); }
});

function workflow({ navigationError, cleanupError } = {}) {
  const value = fixture(), trace = probe(), calls = [], artifacts = [], inputs = [];
  let stage = "a", created = true, submitted = false, saved, requestKey, actualURL;
  const adapt = snapshot => JSON.parse(JSON.stringify(snapshot).replaceAll(key, requestKey ?? key));
  const browser = { client: { sessionId: "session", turnId: "turn", controlEpoch: 1, async beginTurn() {}, async finalizeTabs() { calls.push("finalize"); return {}; } },
    async newTab(...args) { assert.equal(args.length, 0); return { id: 7, locator() { throw Error("No locator allowed"); } }; }, async close() { calls.push("close-owner"); },
    cdp: { async navigate(tabId, target) { assert.equal(tabId, 7); actualURL = target; const u = new URL(target); requestKey = u.searchParams.get("key"); stage = u.searchParams.get("stage"); calls.push(`navigate:${stage}`); if (stage === "b" && navigationError) throw navigationError;
      event(trace, "Runtime.executionContextsCleared", {}); for (const context of contexts(stage)) event(trace, "Runtime.executionContextCreated", { context }); return { frameId: "frame", loaderId: `${stage}-loader` }; }, async call(tabId, method, params) {
      assert.equal(tabId, 7); if (method === "Page.getFrameTree") return adapt(tree(stage)); if (method === "Runtime.enable") return {};
      if (method === "Runtime.evaluate") { assert.equal(params.userGesture, false); assert.equal(params.awaitPromise, false); return { result: { objectId: `${stage}-${params.expression.includes("getElementById") ? "button" : "root"}` } }; }
      if (method === "DOM.describeNode") return { node: adapt(value.phases[stage === "a" ? 0 : 1].identity[params.objectId.endsWith("button") ? "button" : "root"].node) };
      if (method === "Runtime.releaseObjectGroup") { calls.push(`release:${stage}`); return {}; }
      if (method === "Page.captureScreenshot") { calls.push(`png:${stage}`); return { data: Buffer.from(`original-${stage}-native-png`).toString("base64") }; }
      assert.ok(method.startsWith("Input.")); inputs.push({ method, params: copy(params) });
      if (params.type === "mouseReleased" && params.y === center(boxes.b).y) { submitted = true; calls.push("submit"); } return {};
    } } };
  const worker = { async evaluate(source) {
    if (source.includes("realm.snapshot()")) return { mode: "persistent-identity", snapshot: { available: true, state: "ready" } };
    if (source.includes("chrome.tabs.get")) return { id: 7, active: false };
    if (source.includes("chrome.webNavigation.getAllFrames")) return [{ frameId: 0, documentId: `${stage}-native-document`, processId: 15, documentLifecycle: "active", errorOccurred: false, url: actualURL }];
    if (source.includes("chrome.scripting.executeScript")) { if (source.includes("Original frame feedback model did not arrive")) { calls.push(`arrival:${stage}`); throw Error(`Original ${stage} visual wait failure`); }
      return [{ frameId: 0, documentId: `${stage}-native-document`, result: adapt(submitted ? value.after : value.phases[stage === "a" ? 0 : 1].after) }]; }
    if (source.includes("__obuColdWorldLifetime")) { const method = source.match(/return p\[("[^"]+")\]/)?.[1]; if (method === '"restore"') { calls.push("restore"); trace.restored = true; } if (method === '"mark"') append(trace, { kind: "marker", label: "original" }); return copy(trace); }
    if (source.includes("chrome.debugger.getTargets")) return { tabs: [], targets: [] };
    if (source.includes("chrome.tabs.query")) return created ? [{ id: 7 }] : []; throw Error(`Unexpected read: ${source}`);
  } };
  return { connectBrowser: async () => browser, getWorker: () => worker, fixtureURL: "http://127.0.0.1:55000", fixtures: { stats: () => { const record = adapt(value.server); if (!submitted) record.posts = []; return record; } },
    until: async check => { const result = await check(); assert.ok(result); return result; }, saveArtifact: async (name, bytes) => artifacts.push({ name, bytes }), saveDetail: async detail => { saved = copy(detail); },
    closeTab: async tab => { assert.equal(tab.id, 7); created = false; calls.push("close-tab"); if (cleanupError) throw cleanupError; },
    checkEnd: async detail => { assert.equal(submitted, true); assert.equal(detail.states[0].frames[0].documentId, "b-native-document"); calls.push("end"); return { hidden: true }; },
    calls, artifacts, inputs, detail: () => saved };
}

test("visual observation failures retain both PNG attempts, B's unique submission and original End without replay", async () => {
  const harness = workflow(); await assert.rejects(checkColdNavigation(harness)); const detail = harness.detail();
  assert.deepEqual(harness.calls.filter(call => call.startsWith("navigate:")), ["navigate:a", "navigate:b"]);
  assert.equal(harness.artifacts.length, 2); assert.deepEqual(harness.artifacts.map(row => row.bytes.toString()), ["original-a-native-png", "original-b-native-png"]);
  assert.equal(detail.observationErrors.length, 4); assert.equal(detail.server.posts.length, 1); assert.equal(harness.calls.filter(call => call === "submit").length, 1);
  assert.ok(harness.calls.indexOf("release:a") < harness.calls.indexOf("navigate:b")); assert.ok(harness.calls.indexOf("png:b") < harness.calls.indexOf("submit"));
  assert.ok(harness.calls.indexOf("submit") < harness.calls.indexOf("end")); assert.ok(harness.calls.indexOf("end") < harness.calls.indexOf("finalize"));
  assert.equal(detail.native.restored, true); assert.deepEqual(detail.cleanup, { tabs: [], targets: [] }); assert.deepEqual(harness.inputs.map(row => row.params), coldNavigationInputs(detail.value));
});

test("original navigation error remains primary with cleanup errors and no navigation or input replay", async () => {
  const original = Error("Original B navigation failed"), harness = workflow({ navigationError: original, cleanupError: Error("Original cleanup failed") });
  await assert.rejects(checkColdNavigation(harness), error => error === original); const detail = harness.detail();
  assert.match(detail.workflowError, /Original B navigation failed/); assert.ok(detail.cleanupErrors.some(row => /Original cleanup failed/.test(row.error)));
  assert.equal(detail.native.restored, true); assert.equal(harness.inputs.length, 1); assert.equal(harness.artifacts.length, 1); assert.equal(detail.server.posts.length, 0);
});

test("held-read hook adds one declared A move while visual failure still saves PNGs, B POST and End", async () => {
  const harness = workflow(); const hook = { kind: "late-hit-navigation",
    async afterADrain({ browser, tab }) { harness.calls.push("hold-A"); await browser.cdp.call(tab.id, "Input.dispatchMouseEvent", coldNavigationHeldMove); },
    async beforeBMove() { harness.calls.push("release-after-B-commit"); },
    async releaseFinally() { harness.calls.push("finally-release"); }, async restore() { harness.calls.push("restore-gate"); }, check() {} };
  await assert.rejects(checkColdNavigation({ ...harness, heldReadNavigation: hook }));
  const detail = harness.detail(); assert.equal(detail.observationErrors.length, 4); assert.equal(harness.artifacts.length, 2);
  assert.deepEqual(harness.inputs.map(row => row.params), coldNavigationInputs(detail.value, { heldReadNavigation: true }));
  assert.equal(harness.calls.filter(call => call === "submit").length, 1); assert.equal(detail.server.posts.length, 1);
  assert.ok(harness.calls.indexOf("png:a") < harness.calls.indexOf("hold-A"));
  assert.ok(harness.calls.indexOf("hold-A") < harness.calls.indexOf("navigate:b"));
  assert.ok(harness.calls.indexOf("navigate:b") < harness.calls.indexOf("release-after-B-commit"));
  assert.ok(harness.calls.indexOf("release-after-B-commit") < harness.calls.indexOf("png:b"));
  assert.ok(harness.calls.indexOf("end") < harness.calls.indexOf("finally-release"));
  assert.ok(harness.calls.indexOf("finally-release") < harness.calls.indexOf("finalize"));
  assert.equal(harness.calls.filter(call => call === "restore-gate").length, 1); assert.equal(detail.native.restored, true);
});

test("held navigation failure releases before finalize and preserves first error despite failed gate cleanup", async () => {
  const original = Error("Original navigation rejected"), harness = workflow({ navigationError: original });
  await assert.rejects(checkColdNavigation({ ...harness, heldReadNavigation: { kind: "late-hit-navigation",
    async afterADrain({ browser, tab }) { await browser.cdp.call(tab.id, "Input.dispatchMouseEvent", coldNavigationHeldMove); },
    async beforeBMove() { assert.fail("No B move after failed navigation"); },
    async releaseFinally() { harness.calls.push("gate-release"); throw Error("Original held cleanup failed"); },
    async restore() { harness.calls.push("gate-restore"); }, check() {} } }), error => error === original);
  assert.equal(harness.inputs.length, 2); assert.equal(harness.artifacts.length, 1); assert.equal(harness.detail().server.posts.length, 0);
  assert.ok(harness.calls.indexOf("gate-release") < harness.calls.indexOf("finalize"));
  assert.ok(harness.detail().cleanupErrors.some(row => /Original held cleanup failed/.test(row.error)));
  assert.equal(harness.calls.filter(call => call === "gate-restore").length, 1); assert.equal(harness.detail().native.restored, true);
});

test("original markup has distinct authored A/B geometry and no programmatic focus/navigation", () => {
  for (const name of ["a", "b"]) new vm.Script(coldNavigationHTML(key, name, `${name}-doc`).match(/<script>([\s\S]*)<\/script>/)[1]);
  for (const field of ["x", "y", "width", "height"]) assert.notEqual(boxes.a[field], boxes.b[field]);
  assert.doesNotMatch(coldNavigationHTML(key, "b", "doc"), /\.focus\(|dispatchEvent\(|location\.(?:assign|replace)|location\.href\s*=/);
});

test("HTTP preserves Host, ordered single GET per document and original B POST bytes", async t => {
  const fixtures = createColdNavigationFixtures(), server = http.createServer((request, response) => { if (!fixtures.handle(request, response, new URL(request.url, "http://127.0.0.1"))) { response.writeHead(404); response.end(); } });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); })); const port = await listenFixture(server), origin = `http://127.0.0.1:${port}`;
  const get = stage => new Promise((resolve, reject) => { const req = http.get(`${origin}/cold-navigation/page?key=${key}&stage=${stage}`, { headers: { Host: `localhost:${port}` } }, reply => { const chunks = []; reply.on("data", chunk => chunks.push(chunk)); reply.on("end", () => resolve({ status: reply.statusCode, html: Buffer.concat(chunks).toString() })); reply.on("error", reject); }); req.on("error", reject); });
  assert.equal((await get("b")).status, 400);
  for (const stage of ["a", "b"]) { const page = await get(stage); assert.equal(page.status, 200); new vm.Script(page.html.match(/<script>([\s\S]*)<\/script>/)[1]); }
  const original = fixtures.stats(key).gets[1]; assert.equal(original.url, `http://localhost:${port}/cold-navigation/page?key=${key}&stage=b`);
  const bytes = Buffer.from(JSON.stringify({ key, trustedSubmit: true, business: { stage: "b", documentToken: original.documentToken, href: original.url } }));
  const response = await fetch(`${origin}/cold-navigation/post?key=${key}`, { method: "POST", body: bytes }); assert.equal(response.status, 200); assert.equal((await response.json()).bodySHA256, hash(bytes));
  assert.equal(fixtures.stats(key).posts[0].bodyBase64, bytes.toString("base64")); assert.equal((await get("b")).status, 400);
});
