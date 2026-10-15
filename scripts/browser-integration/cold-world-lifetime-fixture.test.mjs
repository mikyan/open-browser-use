import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { listenFixture } from "./fixture-listener.mjs";
import { installColdWorldLifetimeProbe, coldWorldLifetimeProbePrefix, createColdWorldLifetimeFixtures,
  coldWorldContexts, checkColdWorldCardinality, checkColdWorldNative, checkColdWorldBusiness, waitForColdWorldRealm } from "./cold-world-lifetime-fixture.mjs";

const copy = value => structuredClone(value), prefix = "Open Browser Use passive pointer ";
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const state = () => ({ engineAbsent: true, sameAttachment: true, privateLeases: 0, pointerPending: 0 });
const context = (id, name, uniqueId = `unique-${id}`) => ({ id, name, uniqueId, origin: "http://127.0.0.1:55000", auxData: { frameId: "original-root", isDefault: name === "", type: name === "" ? "default" : "isolated" } });

test("diagnostic readiness holds original input while loading without awaiting storage in the input operation", async () => {
  let reads = 0, inputs = 0, release; const held = new Promise(resolve => { release = resolve; }), evidence = { observations: [] };
  const getWorker = () => ({ evaluate: async source => { assert.match(source, /realm\.snapshot\(\)/); assert.doesNotMatch(source, /realm\.ready|capture\(|Input\./); reads++; return { mode: "persistent-identity", snapshot: { state: reads === 1 ? "loading" : "ready", available: reads !== 1 } }; } });
  const until = async (check, label, timeout) => { assert.equal(timeout, 5000); assert.equal(await check(), false); assert.equal(inputs, 0); await held; return check(); };
  const task = waitForColdWorldRealm({ getWorker, until, evidence }).then(() => { inputs++; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(inputs, 0); assert.equal(reads, 1); release(); await task;
  assert.equal(inputs, 1); assert.equal(reads, 2); assert.equal(evidence.snapshot.state, "ready"); assert.equal(evidence.observations.length, 2);
});

test("disabled realm exits the retrying runner immediately and legacy source does not claim storage readiness", async () => {
  let reads = 0, inputs = 0;
  const until = async check => { for (let index = 0; index < 3; index++) { try { const result = await check(); if (result) return result; } catch {} } throw Error("Unexpected retry timeout"); };
  await assert.rejects(waitForColdWorldRealm({ getWorker: () => ({ evaluate: async () => { reads++; return { mode: "persistent-identity", snapshot: { state: "disabled", available: false, reason: "invalid-record" } }; } }), until }).then(() => { inputs++; }), /disabled: invalid-record/);
  assert.equal(reads, 1); assert.equal(inputs, 0);
  const legacy = await waitForColdWorldRealm({ getWorker: () => ({ evaluate: async () => ({ mode: "legacy-module" }) }), until });
  assert.deepEqual(legacy, { observations: [{ mode: "legacy-module" }], mode: "legacy-module" }); assert.equal(Object.hasOwn(legacy, "snapshot"), false);
});
function trace() { return { workerId: "worker-0", tabId: 7, records: [], pending: 0, overflow: false, recordingErrors: 0, restored: false, state: state() }; }
function append(probe, row) { const value = { sequence: probe.records.length + 1, ...row }; probe.records.push(value); return value; }
function event(probe, value, source = { tabId: 7 }) { return append(probe, { kind: "event", source, method: "Runtime.executionContextCreated", params: { context: value } }); }
function call(probe, method, params = {}, value = {}, overrides = {}) {
  const row = append(probe, { kind: "call", target: { tabId: 7 }, method, params, state: state(), ...overrides });
  append(probe, { kind: "settled", invocation: row.sequence, ok: true, value }); return row;
}
function document() {
  return { nativeDocumentId: "original-native-document", nativeFrameId: 0, nativeProcessId: 45,
    business: { key: `world-${"a".repeat(32)}`, documentToken: "original-server-document", windowToken: "original-window", href: "http://127.0.0.1:55000/cold-world-lifetime/page", sameDocument: true, sameWindow: true, sameRoot: true,
      nodes: ["note", "submit", "form", "panel"].map(id => ({ id, token: `world-${"a".repeat(32)}-${id}`, connected: true, original: true })), value: "", activeElement: "", selection: { start: 0, end: 0, direction: "none" }, events: [], focus: [], errors: [], overflow: false, receipt: null },
    geometry: { button: { x: 46, y: 134, width: 280, height: 64 }, input: { x: 46, y: 48, width: 280, height: 36 }, parents: [], viewport: { width: 1000, height: 700, dpr: 1, scrollX: 0, scrollY: 0 } },
    feedback: { connected: true, currentRoot: true, currentCount: 1, target: { x: 46, y: 134, width: 280, height: 64 } }, rings: [] };
}
function phase(index, growing = false) {
  const probe = trace(); probe.workerId = `worker-${index}`; const before = document();
  event(probe, context(1, ""));
  for (let value = 0; value <= (growing ? index : 0); value++) event(probe, context(value + 2, `${prefix}world-${value}`));
  return { index, tree: { frameTree: { frame: { id: "original-root", loaderId: "original-loader" } } }, before, after: copy(before), beforeRestore: probe,
    native: { ...copy(probe), restored: true }, contexts: coldWorldContexts(probe, "original-root"), pixels: { scale: 1, cursorDark: 80, edges: { top: 20, left: 20, right: 20, bottom: 20 } } };
}
function nativePhase(final = false) {
  const value = phase(2), probe = value.beforeRestore, png = Buffer.from("original-native-PNG-bytes"), move = { type: "mouseMoved", x: 186, y: 166, buttons: 0 };
  call(probe, "Runtime.enable");
  call(probe, "Input.dispatchMouseEvent", move); call(probe, "Page.createIsolatedWorld", { frameId: "original-root", worldName: `${prefix}world-0`, grantUniveralAccess: false }, { executionContextId: 2 });
  call(probe, "Input.dispatchMouseEvent", move); call(probe, "Page.createIsolatedWorld", { frameId: "original-root", worldName: `${prefix}world-0`, grantUniveralAccess: false }, { executionContextId: 2 });
  call(probe, "Page.captureScreenshot", { format: "png" }, { data: png.toString("base64") });
  if (final) { value.value = "original text"; for (const params of [{ type: "mouseMoved", x: 186, y: 66, buttons: 0 }, { type: "mousePressed", x: 186, y: 66, button: "left", buttons: 1, clickCount: 1 },
    { type: "mouseReleased", x: 186, y: 66, button: "left", buttons: 0, clickCount: 1 }, { text: value.value }, move,
    { type: "mousePressed", x: 186, y: 166, button: "left", buttons: 1, clickCount: 1 }, { type: "mouseReleased", x: 186, y: 166, button: "left", buttons: 0, clickCount: 1 }]) call(probe, "text" in params ? "Input.insertText" : "Input.dispatchMouseEvent", params); }
  value.contexts = coldWorldContexts(probe, "original-root"); return { value, png };
}

function reclaimedNativePhase() {
  const value = nativePhase(); value.value.index = 1;
  value.value.restart = { oldTarget: "old-worker", restartedTarget: "new-worker" };
  value.value.claim = { id: 7 };
  const probe = value.value.beforeRestore, existing = probe.records; probe.records = [];
  const untracked = { ...state(), attached: false, originalAttachmentSeen: false, sameAttachment: null };
  call(probe, "debugger.detach", { version: null }, undefined, { state: untracked });
  const query = call(probe, "Target.getTargetInfo", {}, undefined, { state: untracked });
  Object.assign(probe.records.find(row => row.invocation === query.sequence), { ok: false, error: "Error: Debugger is not attached to the tab with id: 7." });
  call(probe, "debugger.attach", { version: "1.3" }, undefined, { state: untracked });
  for (const row of existing) probe.records.push({ ...row, sequence: row.sequence + 6, ...(row.invocation ? { invocation: row.invocation + 6 } : {}) });
  return value;
}

test("actual replacement claim's exact no-client probe rejection precedes its successful original attach", () => {
  const { value, png } = reclaimedNativePhase(); checkColdWorldNative(value, 7, png);
});

test("no-client exception cannot admit wrong error, params, identity, phase or late/failed attach", () => {
  for (const mutate of [
    phase => { phase.beforeRestore.records[3].error = "Error: Debugger is not attached to the tab with id: 8."; },
    phase => { phase.beforeRestore.records[3].error += " permission denied"; },
    phase => { phase.beforeRestore.records[2].params = { targetId: "other" }; },
    phase => { phase.beforeRestore.records[2].target.extra = true; },
    phase => { phase.beforeRestore.records[2].state.attached = true; },
    phase => { phase.beforeRestore.records[3].synchronous = true; },
    phase => { phase.beforeRestore.records[3].sequence = phase.beforeRestore.records[4].sequence + 1; },
    phase => { phase.beforeRestore.records[5].ok = false; },
    phase => { phase.claim.id = 8; }, phase => { phase.index = 0; },
    phase => { phase.restart.restartedTarget = phase.restart.oldTarget; },
    phase => { phase.beforeRestore.records[3].error = "Error: permission denied"; }
  ]) { const { value, png } = reclaimedNativePhase(); mutate(value); assert.throws(() => checkColdWorldNative(value, 7, png)); }
});

test("passive observer preserves original Promise/receiver and observes native enumeration before Backend exists", async () => {
  let resolve; const promise = new Promise(done => { resolve = done; }), listeners = new Set(), detachListeners = new Set(), calls = [];
  const native = function (...args) { calls.push({ receiver: this, args }); return promise; };
  const debuggerAPI = { sendCommand: native, attach: native, detach: native, onEvent: { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) }, onDetach: { addListener: fn => detachListeners.add(fn), removeListener: fn => detachListeners.delete(fn) } };
  const target = {}; installColdWorldLifetimeProbe({ debugger: debuggerAPI }, target); const observer = target.__obuColdWorldLifetime;
  observer.select(7); const params = {}, result = debuggerAPI.sendCommand({ tabId: 7 }, "Runtime.enable", params);
  assert.equal(result, promise); assert.equal(calls[0].receiver, debuggerAPI); assert.equal(calls[0].args[2], params); assert.equal(observer.snapshot().pending, 1);
  assert.throws(() => observer.restore(), /remain pending/);
  for (const fn of listeners) fn({ tabId: 7 }, "Runtime.executionContextCreated", { context: context(2, `${prefix}world-0`) });
  resolve({ exact: "original ACK" }); await result;
  assert.equal(observer.snapshot().pending, 0); assert.deepEqual(observer.snapshot().records.find(row => row.kind === "settled").value, { exact: "original ACK" });
  assert.equal(coldWorldContexts(observer.snapshot(), "original-root").worlds.length, 1);
  const snapshot = observer.restore(); assert.equal(snapshot.restored, true); assert.equal(debuggerAPI.sendCommand, native); assert.equal(listeners.size, 0); assert.equal(detachListeners.size, 0); assert.equal(target.__obuColdWorldLifetime, undefined);
  assert.equal(calls.length, 1, "Observer does not enable another domain or create a world"); assert.match(coldWorldLifetimeProbePrefix(), /^;\(/);
});

test("native context identity uses exact root route/frame, clear and destroyed events", () => {
  const probe = trace(); event(probe, context(1, "")); event(probe, context(2, `${prefix}one`));
  event(probe, context(3, `${prefix}wrong-tab`), { tabId: 8 }); event(probe, context(4, `${prefix}child-session`), { tabId: 7, sessionId: "child" });
  event(probe, { ...context(5, `${prefix}wrong-frame`), auxData: { frameId: "other-frame", isDefault: false } });
  assert.equal(coldWorldContexts(probe, "original-root").worlds.length, 1);
  append(probe, { kind: "event", source: { tabId: 7 }, method: "Runtime.executionContextDestroyed", params: { executionContextUniqueId: "unique-2" } });
  assert.equal(coldWorldContexts(probe, "original-root").worlds.length, 0);
  event(probe, context(6, `${prefix}next`)); append(probe, { kind: "event", source: { tabId: 7 }, method: "Runtime.executionContextsCleared", params: {} });
  assert.deepEqual(coldWorldContexts(probe, "original-root"), { all: [], defaults: [], worlds: [] });
});

test("two real worker replacements must reuse the one original live world, not just make successful reads", () => {
  checkColdWorldCardinality({ phases: [phase(0), phase(1), phase(2)] });
  assert.throws(() => checkColdWorldCardinality({ phases: [phase(0, true), phase(1, true), phase(2, true)] }), /accumulated passive worlds after worker generation 1/);
  const changed = [phase(0), phase(1), phase(2)]; changed[1].contexts.worlds[0].uniqueId = "replacement-context";
  changed[1].beforeRestore.records[1].params.context.uniqueId = "replacement-context";
  assert.throws(() => checkColdWorldCardinality({ phases: changed }), /must be reused/);
});

test("missing native enumeration, reload, warming, overflow and reused worker IDs cannot satisfy cardinality", () => {
  for (const mutate of [p => { p[1].beforeRestore.records = p[1].beforeRestore.records.slice(1); p[1].contexts = coldWorldContexts(p[1].beforeRestore, "original-root"); },
    p => { p[1].after.nativeDocumentId = "new-document"; }, p => { p[1].tree.frameTree.frame.loaderId = "new-loader"; },
    p => { p[1].native.state.engineAbsent = false; }, p => { p[1].native.overflow = true; }, p => { p[1].native.workerId = p[0].native.workerId; }]) {
    const phases = [phase(0), phase(1), phase(2)]; mutate(phases); assert.throws(() => checkColdWorldCardinality({ phases }));
  }
});

test("raw inputs and native screenshots retain original ordered ACKs; no replay or domain reset", () => {
  for (const final of [false, true]) { const { value, png } = nativePhase(final); checkColdWorldNative(value, 7, png, final); }
  for (const mutate of [p => { const input = p.records.find(row => row.method === "Input.dispatchMouseEvent"); p.records.push(copy(input)); },
    p => { const shot = p.records.find(row => row.method === "Page.captureScreenshot"); p.records.find(row => row.invocation === shot.sequence).value.data = Buffer.from("substitute").toString("base64"); },
    p => { const input = p.records.find(row => row.method === "Input.dispatchMouseEvent"); p.records = p.records.filter(row => row.invocation !== input.sequence); },
    p => { const input = p.records.find(row => row.method === "Input.dispatchMouseEvent"); p.records.find(row => row.invocation === input.sequence).ok = false; },
    p => { call(p, "Runtime.disable"); }, p => { p.records.find(row => row.method === "Input.dispatchMouseEvent").state.sameAttachment = false; }]) {
    const { value, png } = nativePhase(); mutate(value.beforeRestore); assert.throws(() => checkColdWorldNative(value, 7, png));
  }
});

function business() {
  const phases = [phase(0), phase(1), phase(2)], after = copy(phases[2].after), key = after.business.key, value = "Original π";
  after.business.value = value; after.business.activeElement = "submit"; after.business.selection = { start: value.length, end: value.length, direction: "none" };
  after.business.events = [["pointerdown", "note"], ["pointerup", "note"], ["click", "note"], ["input", "note"], ["pointerdown", "submit"], ["pointerup", "submit"], ["click", "submit"], ["submit", "form"]].map(([type, targetId], index) => ({ sequence: index + 1, type, targetId, nodeToken: `${key}-${targetId}`, trusted: true }));
  after.rings = [66, 166].map((y, index) => ({ sequence: index + 1, documentToken: after.business.documentToken, connected: true, currentRoot: true, color: "rgb(20, 184, 166)", opacity: 1, modelPoint: { x: 186, y }, rect: { x: 174, y: y - 12, width: 24, height: 24 } }));
  const body = { key, trustedSubmit: true, business: copy(after.business) }, bytes = Buffer.from(JSON.stringify(body)), receipt = { key, index: 1, bodySHA256: hash(bytes) }; after.business.receipt = receipt;
  return { phases, after, key, value, server: { gets: [{ documentToken: after.business.documentToken, url: after.business.href }], posts: [{ value: body, receipt, bodyBytes: bytes.length, bodyBase64: bytes.toString("base64"), bodySHA256: hash(bytes) }] } };
}
test("original POST bytes, trust and visible pixels are independent of world cardinality", () => {
  const detail = business(); checkColdWorldBusiness(detail);
  detail.phases[1].contexts.worlds.push(context(3, `${prefix}old-growth`)); checkColdWorldBusiness(detail);
  for (const mutate of [v => { v.server.posts.push(copy(v.server.posts[0])); }, v => { v.server.posts[0].bodySHA256 = "substitute"; },
    v => { v.after.business.events[0].trusted = false; }, v => { v.phases[1].pixels.edges.left = 0; }, v => { v.after.rings[1].rect.x++; v.after.rings[1].rect.x++; },
    v => { v.after.nativeDocumentId = "reloaded"; }]) { const value = business(); mutate(value); assert.throws(() => checkColdWorldBusiness(value)); }
});

test("original loopback document and unique POST ledger retain actual host and raw bytes", async t => {
  const fixtures = createColdWorldLifetimeFixtures(), server = http.createServer((request, response) => { if (!fixtures.handle(request, response, new URL(request.url, "http://127.0.0.1"))) { response.writeHead(404); response.end(); } });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); })); const port = await listenFixture(server), key = `world-${"b".repeat(32)}`, url = `http://127.0.0.1:${port}/cold-world-lifetime/page?key=${key}`;
  const response = await fetch(url); assert.equal(response.status, 200); const html = await response.text(); assert.match(html, /coldWorldLifetimeState/); assert.equal(fixtures.stats(key).gets.length, 1);
  const original = fixtures.stats(key).gets[0], payload = Buffer.from(JSON.stringify({ key, trustedSubmit: true, business: { documentToken: original.documentToken, href: original.url } }));
  const post = await fetch(url.replace("/page?", "/post?"), { method: "POST", headers: { "Content-Type": "application/json" }, body: payload }); assert.equal(post.status, 200);
  assert.equal((await post.json()).bodySHA256, hash(payload)); assert.equal(fixtures.stats(key).posts[0].bodyBase64, payload.toString("base64"));
  const repeated = await fetch(url); assert.equal(repeated.status, 400); await repeated.text();
});
