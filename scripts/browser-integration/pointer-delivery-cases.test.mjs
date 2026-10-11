import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { installChooserPointerEvidence } from "./chooser-waits-fixture.mjs";
import { chooserPointerEvidenceComplete } from "./chooser-failure-observation.mjs";
import { checkPointerDeadline, checkPointerDelivery, checkPointerDeliveryDocuments, checkPointerDeliveryTrace, checkPointerNavigationEvidence, createPointerDeliveryFixtures, installPointerDeliveryGate, pointerDeliveryHTML } from "./pointer-delivery-cases.mjs";

const key = "pointer-0123456789abcdef0123456789abcdef-first";
const childURL = `http://localhost:1234/pointer-delivery/frame?key=${key}`;
const hash = value => createHash("sha256").update(value).digest("hex");
const tick = async () => { await Promise.resolve(); await Promise.resolve(); };
const params = (type, more = {}) => ({ type, x: 150, y: 120, button: type === "mouseMoved" ? "none" : "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: type === "mouseMoved" ? 0 : 1, ...more });
function gate(mode = "drop-first", original = function () { return Promise.resolve({}); }) {
  const api = { debugger: { sendCommand: original } }, target = {};
  const installation = installPointerDeliveryGate(api, target, { id: "fixture-id", tabId: 42, mode });
  return { api, target, original, installation, probe: target.__obuPointerDelivery };
}
async function completeTrace(mode = "drop-first", { old = false, concurrentButtons = false } = {}) {
  const f = gate(mode), send = type => f.api.debugger.sendCommand({ tabId: 42 }, "Input.dispatchMouseEvent", params(type));
  await send("mouseMoved");
  if (mode === "drop-all") await send("mouseMoved");
  else {
    if (!old) await send("mouseMoved");
    if (concurrentButtons) await Promise.all([send("mousePressed"), send("mouseReleased")]);
    else { await send("mousePressed"); await send("mouseReleased"); }
  }
  await tick(); return f.probe.restore();
}

test("first-move gate is explicit, forwards all other original receiver/arguments/Promise identities", async () => {
  const calls = [], promise = Promise.resolve({ native: true });
  const original = function (...args) { calls.push({ receiver: this, args }); return promise; };
  const f = gate("drop-first", original), receiver = {}, source = { tabId: 42 }, moved = params("mouseMoved");
  assert.notEqual(Reflect.apply(f.api.debugger.sendCommand, receiver, [source, "Input.dispatchMouseEvent", moved]), promise);
  assert.equal(calls.length, 0);
  assert.equal(Reflect.apply(f.api.debugger.sendCommand, receiver, [source, "Input.dispatchMouseEvent", moved]), promise);
  assert.equal(calls[0].receiver, receiver); assert.equal(calls[0].args[0], source); assert.equal(calls[0].args[2], moved);
  for (const args of [[{ tabId: 43 }, "Input.dispatchMouseEvent", moved], [{ tabId: 42, sessionId: "child" }, "Input.dispatchMouseEvent", moved],
    [source, "Runtime.evaluate", {}], [source, "Input.dispatchMouseEvent", params("mousePressed")]])
    assert.equal(Reflect.apply(f.api.debugger.sendCommand, receiver, args), promise);
  await tick();
  const trace = f.probe.restore(); assert.equal(trace.dropped, 1); assert.equal(trace.pending, 0); assert.equal(trace.restored, true);
  assert.equal(f.api.debugger.sendCommand, original); assert.equal(f.target.__obuPointerDelivery, undefined);
});

test("missing-receipt controlled old ordering fails and a second genuine move followed by one button pair passes", async () => {
  const old = await completeTrace("drop-first", { old: true });
  assert.throws(() => checkPointerDeliveryTrace(old), /did not recover with a real move/);
  const next = await completeTrace();
  assert.deepEqual(checkPointerDeliveryTrace(next), { attempts: 2, syntheticMoveAcks: 1, realMoves: 1, presses: 1, releases: 1 });
});

test("button pair requires actual press settlement before release invocation", async () => {
  const trace = await completeTrace("drop-first", { concurrentButtons: true });
  assert.throws(() => checkPointerDeliveryTrace(trace), /Release began before actual press settlement/);
});

test("no receipt until deadline model can only pass with every move suppressed and no buttons", async () => {
  const trace = await completeTrace("drop-all");
  assert.deepEqual(checkPointerDeliveryTrace(trace), { attempts: 2, syntheticMoveAcks: 2, realMoves: 0, presses: 0, releases: 0 });
  const invalid = structuredClone(trace);
  invalid.records.push({ sequence: 5, kind: "invoke", source: { tabId: 42 }, dispatched: true, params: params("mousePressed") },
    { sequence: 6, kind: "settled", invocation: 5, ok: true });
  assert.throws(() => checkPointerDeliveryTrace(invalid));
});

test("deadline proof rejects early errors even with timeout wording and requires the unchanged action budget", () => {
  const item = { mode: "drop-all", timeoutMs: 5000, clickStartedAt: 10000, clickFailedAt: 15019, clickError: "Browser action timed out after 4999.7ms" };
  assert.deepEqual(checkPointerDeadline(item), { elapsedMs: 5019, timeoutMs: 5000, minimumElapsedMs: 4900 });
  assert.equal(checkPointerDeadline({ ...item, clickFailedAt: 14900 }).elapsedMs, 4900);
  for (const change of [
    { clickFailedAt: 10020, clickError: "OBU_POINTER_DELIVERY_UNCONFIRMED: original context changed" },
    { clickFailedAt: 15019, clickError: "OBU_POINTER_DELIVERY_UNCONFIRMED: original context changed" },
    { clickFailedAt: 10020, clickError: "Browser action timed out" },
    { clickFailedAt: 14899 }, { timeoutMs: 100 }, { clickStartedAt: "10000" },
    { clickStartedAt: NaN }, { clickFailedAt: Infinity }, { clickCompletedAt: 15000 }
  ]) assert.throws(() => checkPointerDeadline({ ...item, ...change }));
});

test("trace rejects root bypass, duplicate or premature presses, missing ACK and overflow", async () => {
  const trace = await completeTrace();
  for (const mutate of [
    value => { value.records.find(record => record.kind === "invoke" && record.params.type === "mousePressed").source.sessionId = "child"; },
    value => { value.records.find(record => record.kind === "invoke" && record.params.type === "mousePressed").params.clickCount = 2; },
    value => { value.records.find(record => record.kind === "settled").ok = false; },
    value => { value.records.splice(3, 1); }, value => { value.pending = 1; }, value => { value.overflow = true; },
    value => { value.recordingErrors = 1; }, value => { value.restored = false; }
  ]) { const invalid = structuredClone(trace); mutate(invalid); assert.throws(() => checkPointerDeliveryTrace(invalid)); }
});

test("native errors retain identity, finite recording fails closed, and a foreign replacement is never restored over", async () => {
  const originalError = Object.freeze(new Error("native failed")), f = gate("drop-first", () => { throw originalError; });
  assert.throws(() => f.api.debugger.sendCommand({ tabId: 42 }, "Input.dispatchMouseEvent", params("mousePressed")), error => error === originalError);
  assert.equal(f.probe.snapshot().records.at(-1).ok, false); f.probe.restore();
  const bounded = gate("drop-all");
  for (let index = 0; index < 140; index++) await bounded.api.debugger.sendCommand({ tabId: 42 }, "Input.dispatchMouseEvent", params("mouseMoved"));
  const trace = bounded.probe.restore(); assert.equal(trace.records.length, 256); assert.equal(trace.overflow, true); assert.throws(() => checkPointerDeliveryTrace(trace));
  const foreign = gate(), replacement = () => Promise.resolve({}); foreign.api.debugger.sendCommand = replacement;
  assert.throws(() => foreign.probe.restore(), /replaced externally/); assert.equal(foreign.api.debugger.sendCommand, replacement);
});

test("serialized gate has no module dependencies and leaves target accessors uninspected", async () => {
  const standalone = runInNewContext(`(${installPointerDeliveryGate.toString()})`, { structuredClone });
  const promise = Promise.resolve({}), api = { debugger: { sendCommand: () => promise } }, target = {};
  standalone(api, target, { id: "serialized", tabId: 42, mode: "drop-first" });
  const hostile = { get tabId() { throw Error("Getter must not run"); } };
  assert.equal(api.debugger.sendCommand(hostile, "Input.dispatchMouseEvent", params("mouseMoved")), promise);
  assert.equal(target.__obuPointerDelivery.snapshot().records.length, 0); target.__obuPointerDelivery.restore();
});

function documentEvidence({ root = false, delivered = true } = {}) {
  const listeners = new Map(), input = { tagName: "BUTTON", id: "upload", type: "button" }, evidence = {
    key, documentToken: root ? "root-document" : "child-document", frameAdds: root ? [{ trusted: true }] : [], posts: !root && delivered ? 1 : 0, errors: []
  };
  installChooserPointerEvidence({ addEventListener(type, listener) { listeners.set(type, listener); } }, evidence, input, null);
  // Controlled synthetic events prove the checker only; real browser trust and
  // native routing are not claimed by these Node fixtures.
  if (!root && delivered) for (const type of ["pointermove", "mousemove", "pointerdown", "mousedown", "pointerup", "mouseup", "click"])
    listeners.get(type)({ type, isTrusted: true, target: input, timeStamp: 1, clientX: 20, clientY: 30, button: 0, buttons: 0, pointerId: 1, pointerType: "mouse" });
  return evidence;
}
function businessEvidence(mode = "drop-first") {
  const root = documentEvidence({ root: true }), child = documentEvidence({ delivered: mode === "drop-first" });
  const value = { key, href: childURL, trusted: true, documentToken: child.documentToken, posts: 1, evidence: structuredClone(child) };
  const bytes = Buffer.from(JSON.stringify(value));
  const server = { posts: mode === "drop-first" ? [{ method: "POST", value, bodyBase64: bytes.toString("base64"), bodyBytes: bytes.length, bodySHA256: hash(bytes), receipt: { bodySHA256: hash(bytes) } }] : [] };
  return { root, child, server, key, childURL, mode };
}

function synchronizeBusinessEvidence(value) {
  const ledger = value.child.pointerEvidence;
  ledger.records.forEach((record, index) => { record.sequence = index; });
  ledger.nextSequence = ledger.records.length;
  ledger.retainedCharacters = ledger.records.reduce((sum, record) => sum + JSON.stringify(record).length, 0);
  const post = value.server.posts[0];
  post.value.evidence = structuredClone(value.child);
  const bytes = Buffer.from(JSON.stringify(post.value));
  Object.assign(post, { bodyBase64: bytes.toString("base64"), bodyBytes: bytes.length, bodySHA256: hash(bytes), receipt: { bodySHA256: hash(bytes) } });
  assert.equal(chooserPointerEvidenceComplete(value.child), true);
  assert.deepEqual(JSON.parse(bytes.toString("utf8")), post.value);
  assert.deepEqual(post.value.evidence, value.child);
  return value;
}

test("coherent POST evidence cannot replace a prior trusted mouse pointermove on the original node", () => {
  const mutations = [
    value => { value.child.pointerEvidence.records.splice(0, 1); },
    value => { value.child.pointerEvidence.records[0].pointerType = "pen"; },
    value => { value.child.pointerEvidence.records[0].pointerType = "touch"; },
    value => { value.child.pointerEvidence.records[0].trusted = false; },
    value => { value.child.pointerEvidence.records[0].buttons = 1; },
    value => { value.child.pointerEvidence.records[0].targetIsOriginalUpload = false; },
    value => { const records = value.child.pointerEvidence.records; records.splice(2, 0, records.shift()); }
  ];
  for (const mutate of mutations) {
    const invalid = businessEvidence(); mutate(invalid); synchronizeBusinessEvidence(invalid);
    assert.throws(() => checkPointerDeliveryDocuments(invalid), /No trusted mouse pointermove on the original child node preceded button delivery/);
  }
});

test("business checker requires child move then one trusted button sequence and exact raw POST/document bytes", () => {
  const good = businessEvidence(); assert.equal(checkPointerDeliveryDocuments(good).posts, 1);
  for (const mutate of [
    value => { value.server.posts.push(structuredClone(value.server.posts[0])); },
    value => { value.server.posts[0].bodySHA256 = "f".repeat(64); },
    value => { value.server.posts[0].value.documentToken = "replacement"; },
    value => { value.child.pointerEvidence.records[2].trusted = false; },
    value => { value.child.pointerEvidence.records[1].type = "pointercancel"; },
    value => { value.child.pointerEvidence.overflow = true; }, value => { value.root.frameAdds[0].trusted = false; }
  ]) { const invalid = structuredClone(good); mutate(invalid); assert.throws(() => checkPointerDeliveryDocuments(invalid)); }
  assert.equal(checkPointerDeliveryDocuments(businessEvidence("drop-all")).posts, 0);
});

test("normal link navigation requires a changed native root document and precisely one destination arrival", () => {
  const business = businessEvidence(), item = { mode: "navigate-first", key, childURL,
    url: `http://127.0.0.1:1234/pointer-delivery/page?key=${key}`,
    destinationURL: `http://localhost:1234/pointer-delivery/destination?key=${key}`,
    navigationBefore: { documentId: "native-old", frameId: 0, result: { href: `http://127.0.0.1:1234/pointer-delivery/page?key=${key}`, evidence: business.root } },
    navigationAfter: { documentId: "native-new", frameId: 0, result: { href: `http://localhost:1234/pointer-delivery/destination?key=${key}`, navigationEvidence: { key, documentToken: "new-root" } } },
    server: { ...business.server, gets: [{ path: "/pointer-delivery/destination" }] } };
  assert.equal(checkPointerNavigationEvidence(item).posts, 1);
  for (const mutate of [
    value => { value.navigationAfter.documentId = value.navigationBefore.documentId; },
    value => { value.navigationAfter.result.navigationEvidence.documentToken = business.root.documentToken; },
    value => { value.navigationAfter.result.href += "#other"; }, value => { value.server.gets.push(value.server.gets[0]); },
    value => { value.server.gets.length = 0; }
  ]) { const invalid = structuredClone(item); mutate(invalid); assert.throws(() => checkPointerNavigationEvidence(invalid)); }
  const navigationKey = "pointer-0123456789abcdef0123456789abcdef-navigation";
  const html = pointerDeliveryHTML(new URL(`http://localhost:1234/pointer-delivery/frame?key=${navigationKey}`));
  assert.match(html, /<a id="upload" href="\/pointer-delivery\/destination\?key=.*target="_top">Continue receipt<\/a>/);
  assert.match(html, /request\.open\('POST'.*,false\)/);
  assert.doesNotMatch(html, /preventDefault|location\s*=|\.click\(\)|dispatchEvent/);
});

function localHTTP(url, { method = "GET", body } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(url, { method, agent: false }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk)); response.once("error", reject);
      response.once("end", () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.setTimeout(3000, () => request.destroy(new Error("Local HTTP timeout")));
    request.once("error", reject); request.end(body);
  });
}

test("real local HTTP fixture retains GET identity and exact submitted body without performing browser input", async () => {
  const fixture = createPointerDeliveryFixtures(), server = http.createServer((request, response) => {
    if (!fixture.handle(request, response, new URL(request.url, `http://127.0.0.1:${server.address().port}`))) { response.writeHead(404); response.end(); }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  try {
    const base = `http://127.0.0.1:${server.address().port}`, page = await localHTTP(`${base}/pointer-delivery/page?key=${key}`);
    assert.equal(page.status, 200); assert.match(page.body, /http:\/\/localhost:/); assert.match(page.body, /Add receipt frame/);
    assert.doesNotMatch(page.body, /dispatchEvent|\.click\(\)|setInterval|setTimeout/);
    const body = JSON.stringify({ key, note: "原始 bytes" });
    assert.equal((await localHTTP(`${base}/pointer-delivery/post?key=${key}`, { method: "POST", body })).status, 200);
    const stats = fixture.stats(key); assert.equal(stats.gets.length, 1); assert.equal(stats.posts.length, 1);
    assert.equal(Buffer.from(stats.posts[0].bodyBase64, "base64").toString(), body); assert.equal(stats.posts[0].bodySHA256, hash(Buffer.from(body)));
    assert.equal((await localHTTP(`${base}/pointer-delivery/page?key=foreign`)).status, 400);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test("fixture preserves original frozen click error through restoration/evidence failures and keeps parent-owned partial", async () => {
  const original = Object.freeze(new Error("original click failed")), detail = {}, calls = [];
  const browser = { client: { sessionId: "owner", turnId: "turn", controlEpoch: 1 },
    newTab: async () => ({ id: 42, getByRole: () => ({ click: async () => { calls.push("add"); } }),
      frameLocator: () => ({ getByRole: () => ({ click: async options => { calls.push(["click", options]); throw original; } }) }) }),
    cdp: { navigate: async () => { calls.push("navigate"); } } };
  const worker = { evaluate: async expression => {
    if (expression.includes("setup deadline expired")) { calls.push("install"); return {}; }
    if (expression.includes("return p.restore()")) { calls.push("restore"); throw Error("restore failed"); }
    calls.push("evidence"); throw Error("read failed");
  } };
  await assert.rejects(checkPointerDelivery({ browser, worker, fixtureURL: "http://127.0.0.1:1234/", detail,
    server: { stats: () => ({ posts: [] }) }, until: async () => { throw Error("No retry permitted"); } }), error => error === original);
  assert.deepEqual(calls, ["navigate", "add", "install", ["click", { timeoutMs: 5000 }], "restore", "evidence"]);
  assert.equal(detail.passed, false); assert.equal(detail.cases.length, 1); assert.match(detail.error, /original click failed/);
  assert.match(detail.cases[0].restoreError, /restore failed/); assert.match(detail.cases[0].evidenceError, /read failed/);
  assert.equal(detail.cleanupErrors.length, 1); assert.equal(original.pointerDeliveryDetail, undefined);
});
