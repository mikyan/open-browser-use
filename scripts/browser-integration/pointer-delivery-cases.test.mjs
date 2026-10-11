import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { installChooserPointerEvidence } from "./chooser-waits-fixture.mjs";
import { chooserPointerEvidenceComplete } from "./chooser-failure-observation.mjs";
import { checkPointerDeadline, checkPointerDelivery, checkPointerDeliveryDocuments, checkPointerDeliveryTrace, checkPointerNavigationEvidence, createPointerDeliveryFixtures, installPointerDeliveryGate, pointerDeliveryHTML,
  countedPointerCases, countedPointerHTML, installCountedPointerEvidence, installCountedPointerProbe, checkCountedPointerTrace, checkCountedPointerDocuments, checkCountedPointerDelivery, waitForCountedNavigationCommit, readCountedNavigationState } from "./pointer-delivery-cases.mjs";

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

const countedKey = spec => `pointer-counted-0123456789abcdef0123456789abcdef-${spec.name}`;
async function countedTrace(spec) {
  const api = { debugger: { sendCommand: () => Promise.resolve({}) } }, target = {};
  installCountedPointerProbe(api, target, { id: "counted-test", tabId: 42, mode: spec.gate });
  const send = (method, value) => api.debugger.sendCommand({ tabId: 42 }, method, value), mask = spec.modifiers.length ? 8 : 0;
  const key = down => send("Input.dispatchKeyEvent", { type: down ? "rawKeyDown" : "keyUp", key: "Shift", code: "ShiftLeft", modifiers: down ? 8 : 0 });
  const mouse = (type, count = 0) => send("Input.dispatchMouseEvent", { ...params(type, { clickCount: count }), modifiers: mask });
  if (mask) await key(true);
  await mouse("mouseMoved");
  if (spec.gate === "drop-first") { if (mask) { await key(false); await key(true); } await mouse("mouseMoved"); }
  for (let count = 1; count <= (spec.navigation ? 1 : spec.count); count++) { await mouse("mousePressed", count); await mouse("mouseReleased", count); }
  if (mask) await key(false);
  await tick(); return target.__obuCountedPointer.restore();
}

test("counted cases distinguish root dblclick, same-frame three clicks, dropped OOPIF move with modifiers and partial navigation", async () => {
  assert.deepEqual(countedPointerCases.map(spec => spec.name), ["root-double", "same-triple", "oopif-double", "navigation-double"]);
  for (const spec of countedPointerCases) {
    const proof = checkCountedPointerTrace(await countedTrace(spec), spec);
    assert.equal(proof.presses, spec.navigation ? 1 : spec.count); assert.equal(proof.releases, proof.presses);
    assert.equal(proof.syntheticMoveAcks, spec.gate === "drop-first" ? 1 : 0);
    assert.equal(proof.modifierPairs, spec.modifiers.length ? spec.gate === "drop-first" ? 2 : 1 : 0);
  }
});

test("counted native proof rejects duplicated count, missing modifier restore, wrong root, premature pair and navigation second click", async () => {
  const spec = countedPointerCases[2], trace = await countedTrace(spec);
  for (const change of [
    value => { value.records.find(record => record.params?.clickCount === 2).params.clickCount = 1; },
    value => { value.records.find(record => record.params?.type === "mousePressed").params.modifiers = 0; },
    value => { value.records.find(record => record.params?.type === "mouseReleased").source.sessionId = "child"; },
    value => { value.records.filter(record => record.params?.type === "keyUp").at(-1).params.modifiers = 8; },
    value => { value.records.find(record => record.params?.type === "rawKeyDown").params.key = "Control"; },
    value => { const down = value.records.find(record => record.params?.type === "mousePressed"), ack = value.records.find(record => record.invocation === down.sequence), up = value.records.find(record => record.params?.type === "mouseReleased"); const original = ack.sequence; ack.sequence = up.sequence; up.sequence = original; value.records.sort((a, b) => a.sequence - b.sequence); value.records.find(record => record.invocation === original + 1).invocation = up.sequence; },
    value => { value.pending = 1; }, value => { value.overflow = true; }, value => { value.recordingErrors = 1; }
  ]) { const invalid = structuredClone(trace); change(invalid); assert.throws(() => checkCountedPointerTrace(invalid, spec)); }
  const navigation = countedPointerCases[3], invalid = await countedTrace({ ...navigation, navigation: false });
  assert.throws(() => checkCountedPointerTrace(invalid, navigation), /must not be duplicated or continue in a new document/);
  const missing = await countedTrace(spec);
  const finalUp = missing.records.findLast(record => record.params?.type === "keyUp");
  missing.records = missing.records.filter(record => record !== finalUp && record.invocation !== finalUp.sequence);
  assert.throws(() => checkCountedPointerTrace(missing, spec));
});

test("counted observer preserves native Promise/receiver/errors and never drops keys or foreign input", async () => {
  const calls = [], originalError = Object.freeze(new Error("native key failure")), promise = Promise.resolve({ native: true });
  const original = function (...args) { calls.push({ receiver: this, args }); if (args[2]?.fail) throw originalError; return promise; };
  const api = { debugger: { sendCommand: original } }, target = {}, receiver = {};
  const serialized = runInNewContext(`(${installCountedPointerProbe.toString()})`, { structuredClone });
  serialized(api, target, { id: "serialized-counted", tabId: 42, mode: "drop-first" });
  const args = [{ tabId: 42 }, "Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Shift" }];
  assert.equal(Reflect.apply(api.debugger.sendCommand, receiver, args), promise); assert.equal(calls[0].receiver, receiver); assert.equal(calls[0].args[2], args[2]);
  for (const value of [[{ tabId: 77 }, "Input.dispatchMouseEvent", params("mouseMoved")], [{ tabId: 42, sessionId: "child" }, "Input.dispatchMouseEvent", params("mouseMoved")], [{ get tabId() { throw Error("Do not inspect getter"); } }, "Input.dispatchMouseEvent", params("mouseMoved")]]) assert.equal(api.debugger.sendCommand(...value), promise);
  assert.throws(() => api.debugger.sendCommand({ tabId: 42 }, "Input.dispatchKeyEvent", { fail: true }), error => error === originalError);
  await tick(); const probe = target.__obuCountedPointer.restore(); assert.equal(probe.dropped, 0); assert.equal(probe.pending, 0); assert.equal(api.debugger.sendCommand, original);
  assert.equal(probe.records.filter(record => record.kind === "invoke").length, 3);
});

function resequenceCountedRecords(records) {
  const newSequence = new Map(records.map((record, index) => [record.sequence, index + 1]));
  return records.map((record, index) => ({ ...record, sequence: index + 1, ...(record.invocation === undefined ? {} : { invocation: newSequence.get(record.invocation) }) }));
}

test("each dropped-move attempt restores Shift before the next setup, and even synthetic moves require a settled keydown", async () => {
  const spec = countedPointerCases[2], good = await countedTrace(spec);
  const shared = structuredClone(good), keyCalls = shared.records.filter(record => record.params?.key === "Shift");
  const remove = new Set([keyCalls[1].sequence, keyCalls[2].sequence]);
  shared.records = resequenceCountedRecords(shared.records.filter(record => !remove.has(record.sequence) && !remove.has(record.invocation)));
  assert.throws(() => checkCountedPointerTrace(shared, spec), /Each attempted move must set up and restore/);
  const early = structuredClone(good), move = early.records.find(record => record.kind === "invoke" && !record.dispatched), ack = early.records.find(record => record.invocation === move.sequence);
  early.records = resequenceCountedRecords([move, ack, ...early.records.filter(record => record !== move && record !== ack)]);
  assert.throws(() => checkCountedPointerTrace(early, spec));
});

function countedDocument(key, token, { node = true } = {}) {
  const evidence = { key, documentToken: token, clicks: 0, doubles: 0, posts: 0 }, listeners = new Map(), original = node ? { id: "counted" } : null;
  const standalone = runInNewContext(`(${installCountedPointerEvidence.toString()})`);
  standalone({ addEventListener(type, fn) { listeners.set(type, fn); } }, evidence, original);
  return { evidence, emit(type, more = {}) { listeners.get(type)({ target: original ?? { id: "" }, isTrusted: true, detail: 0, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, button: 0, buttons: 0, timeStamp: 1, clientX: 20.25, clientY: 30.75, ...more }); } };
}

function countedBusiness(spec) {
  const key = countedKey(spec), url = `http://127.0.0.1:1234/pointer-counted/page?key=${key}`,
    targetURL = spec.layout === "root" ? url : `http://${spec.layout === "same" ? "127.0.0.1" : "localhost"}:1234/pointer-counted/frame?key=${key}`;
  const root = countedDocument(key, "old-root", { node: spec.layout === "root" }), target = spec.layout === "root" ? root : countedDocument(key, "old-child");
  const shift = spec.modifiers.length > 0;
  if (shift) root.emit("keydown", { key: "Shift", code: "ShiftLeft", shiftKey: true });
  target.emit("pointermove", { pointerType: "mouse", isPrimary: true, shiftKey: shift }); target.emit("mousemove", { shiftKey: shift });
  for (let count = 1; count <= (spec.navigation ? 1 : spec.count); count++) {
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) target.emit(type, { detail: type.startsWith("pointer") ? 0 : count, buttons: ["pointerdown", "mousedown"].includes(type) ? 1 : 0, pointerType: type.startsWith("pointer") ? "mouse" : undefined, isPrimary: type.startsWith("pointer") ? true : undefined, shiftKey: shift });
    target.evidence.clicks++;
    if (count === 2) { target.emit("dblclick", { detail: 2, shiftKey: shift }); target.evidence.doubles++; }
  }
  target.evidence.posts++;
  const value = { key, href: targetURL, trusted: true, documentToken: target.evidence.documentToken, evidence: structuredClone(target.evidence) }, bytes = Buffer.from(JSON.stringify(value));
  if (shift) target.emit("keyup", { key: "Shift", code: "ShiftLeft", shiftKey: false });
  const visibleResult = `${target.evidence.clicks} clicks / ${target.evidence.doubles} doubles`;
  let documents = [{ href: url, evidence: root.evidence, visibleResult: spec.layout === "root" ? visibleResult : null }];
  if (spec.layout !== "root") documents.push({ href: targetURL, evidence: target.evidence, visibleResult });
  let destination;
  if (spec.navigation) {
    const after = countedDocument(key, "new-root"), href = targetURL.replace("/frame?", "/destination?");
    documents = [{ href, evidence: after.evidence, visibleResult: "0 clicks / 0 doubles" }];
    destination = { ...documents[0], url: href, documentId: "native-new-root", beforeDocumentId: "native-old-root" };
  }
  return structuredClone({ spec, key, targetURL, documents, destination, server: { gets: spec.navigation ? [{ path: "/pointer-counted/destination" }] : [],
    posts: [{ method: "POST", value, bodyBase64: bytes.toString("base64"), bodyBytes: bytes.length, bodySHA256: hash(bytes), receipt: { bodySHA256: hash(bytes) } }] } });
}

function refreshCountedPost(value) {
  const post = value.server.posts[0], raw = Buffer.from(JSON.stringify(post.value));
  Object.assign(post, { bodyBase64: raw.toString("base64"), bodyBytes: raw.length, bodySHA256: hash(raw), receipt: { bodySHA256: hash(raw) } });
}

test("counted business evidence requires trusted counts/modifiers, visible effect and one original POST prefix", () => {
  for (const spec of countedPointerCases) assert.equal(checkCountedPointerDocuments(countedBusiness(spec)).posts, 1);
  const good = countedBusiness(countedPointerCases[2]);
  for (const mutate of [
    value => { value.documents[1].visibleResult = "1 clicks / 0 doubles"; },
    value => { value.documents[1].evidence.records.find(event => event.type === "click").detail = 2; },
    value => { value.documents[1].evidence.records.find(event => event.type === "mousedown").shift = false; },
    value => { value.documents[1].evidence.records.find(event => event.type === "pointermove").pointerType = "pen"; },
    value => { value.documents[1].evidence.records.find(event => event.type === "pointermove").isPrimary = false; },
    value => { value.documents[1].evidence.records.find(event => event.type === "click").originalNode = false; },
    value => { value.documents[1].evidence.records.find(event => event.type === "keyup").shift = true; },
    value => { value.documents[1].evidence.overflow = true; },
    value => { value.server.posts[0].value.evidence.documentToken = "replacement"; refreshCountedPost(value); },
    value => { value.server.posts[0].value.evidence.records[0].clientX++; refreshCountedPost(value); },
    value => { value.server.posts.push(structuredClone(value.server.posts[0])); },
    value => { value.server.posts[0].bodySHA256 = "f".repeat(64); }
  ]) { const invalid = structuredClone(good); mutate(invalid); assert.throws(() => checkCountedPointerDocuments(invalid)); }
});

test("partial first-click navigation requires a different native document, one GET and no destination button events", () => {
  const good = countedBusiness(countedPointerCases[3]); assert.equal(checkCountedPointerDocuments(good).nativeDocumentChanged, true);
  for (const change of [
    value => { value.destination.documentId = value.destination.beforeDocumentId; },
    value => { value.destination.evidence.documentToken = value.server.posts[0].value.documentToken; },
    value => { value.destination.evidence.clicks = 1; },
    value => { value.server.gets.push(value.server.gets[0]); },
    value => { value.server.posts[0].value.evidence.clicks = 2; refreshCountedPost(value); },
    value => { value.destination.href += "#other"; }
  ]) { const invalid = structuredClone(good); change(invalid); assert.throws(() => checkCountedPointerDocuments(invalid)); }
});

test("counted HTML is passive and static, preserves genuine link navigation and serves exact raw bytes", async () => {
  for (const spec of countedPointerCases) {
    const html = countedPointerHTML(new URL(`http://127.0.0.1:1234/pointer-counted/page?key=${countedKey(spec)}`));
    assert.doesNotMatch(html, /dispatchEvent|preventDefault|\.click\(\)|setInterval|setTimeout/);
    assert.equal(html.includes('<iframe id="counted-frame"'), spec.layout !== "root");
    if (spec.layout === "oopif") assert.match(html, /http:\/\/localhost:1234\/pointer-counted\/frame/);
    if (spec.layout === "same") assert.match(html, /http:\/\/127\.0\.0\.1:1234\/pointer-counted\/frame/);
  }
  const spec = countedPointerCases[3], key = countedKey(spec), html = countedPointerHTML(new URL(`http://localhost:1234/pointer-counted/frame?key=${key}`));
  assert.match(html, /<a id="counted".*target="_top"/); assert.match(html, /request\.open\('POST'.*,false\)/);
  const fixture = createPointerDeliveryFixtures(), server = http.createServer((request, response) => {
    if (!fixture.handle(request, response, new URL(request.url, `http://127.0.0.1:${server.address().port}`))) { response.writeHead(404); response.end(); }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  try {
    const base = `http://127.0.0.1:${server.address().port}`, response = await localHTTP(`${base}/pointer-counted/page?key=${key}`);
    assert.equal(response.status, 200); assert.equal(fixture.stats(key).gets[0].sha256, hash(Buffer.from(response.body)));
    const raw = JSON.stringify({ key, exact: "原始 counted bytes" }); assert.equal((await localHTTP(`${base}/pointer-counted/post?key=${key}`, { method: "POST", body: raw })).status, 200);
    const stats = fixture.stats(key); assert.equal(stats.posts.length, 1); assert.equal(Buffer.from(stats.posts[0].bodyBase64, "base64").toString(), raw);
    assert.equal((await localHTTP(`${base}/pointer-counted/page?key=foreign`)).status, 400);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test("counted fixture preserves the original frozen action failure through restore and observation errors", async () => {
  const original = Object.freeze(new Error("original counted failure")), detail = {}, calls = [];
  const browser = { client: { sessionId: "owner", turnId: "turn", controlEpoch: 1 }, newTab: async () => ({ id: 42,
    getByRole: () => ({ dblclick: async options => { calls.push(["dblclick", options]); throw original; } }) }), cdp: { navigate: async () => { calls.push("navigate"); } } };
  const worker = { evaluate: async expression => {
    if (expression.startsWith("chrome.webNavigation")) { calls.push("before"); return [{ frameId: 0, documentId: "old", url: detail.cases[0].url, documentLifecycle: "active", errorOccurred: false }]; }
    if (expression.includes("Counted probe setup deadline expired")) { calls.push("install"); return {}; }
    if (expression.includes("return p.restore()")) { calls.push("restore"); throw Error("restore failed"); }
    calls.push("evidence"); throw Error("read failed");
  } };
  await assert.rejects(checkCountedPointerDelivery({ browser, worker, fixtureURL: "http://127.0.0.1:1234/", server: { stats: () => ({ posts: [] }) }, detail, until: async (callback, label) => { assert.match(label, /original committed frame/); assert.equal(await callback(), true); } }), error => error === original);
  assert.deepEqual(calls, ["navigate", "before", "install", ["dblclick", { timeoutMs: 5000 }], "restore", "evidence"]);
  assert.equal(detail.cases.length, 1); assert.match(detail.error, /original counted failure/); assert.equal(detail.cleanupErrors.length, 1);
  assert.match(detail.cases[0].restoreError, /restore failed/); assert.match(detail.cases[0].evidenceError, /read failed/);
});

function commitObservationFixture(read) {
  const url = "http://localhost:1234/pointer-counted/destination?key=original", record = {};
  let time = 1000, reads = 0;
  const committed = { tab: { id: 42, active: false, status: "complete", url }, frames: [{ frameId: 0, url, documentId: "native-new", documentLifecycle: "active", errorOccurred: false }] };
  const loading = { tab: { id: 42, active: false, status: "loading", url: "http://127.0.0.1:1234/original" }, frames: [{ frameId: 0, url: "http://127.0.0.1:1234/original", documentId: "native-old", documentLifecycle: "active", errorOccurred: false }] };
  const run = overrides => waitForCountedNavigationCommit({ read: async () => { reads++; return read({ committed: structuredClone(committed), loading: structuredClone(loading), reads, advance: value => { time += value; } }); },
    until: async callback => { for (let index = 0; index < 90; index++) { if (await callback()) return; time += 100; } throw Error("Test poll exhausted"); },
    tabId: 42, url, beforeDocumentId: "native-old", deadlineAt: 1500, record, now: () => time, ...overrides });
  return { run, record, reads: () => reads };
}

test("navigation observation retains old loading samples until the exact original tab has a new complete native document", async () => {
  const f = commitObservationFixture(({ reads, loading, committed }) => reads === 1 ? loading : committed);
  const native = await f.run(); assert.equal(native.tab.status, "complete"); assert.equal(f.reads(), 2);
  assert.equal(f.record.complete, true); assert.equal(f.record.deadlineAt, 1500); assert.equal(f.record.documentId, "native-new");
  assert.deepEqual(f.record.samples.map(sample => sample.tab.status), ["loading", "complete"]);
  assert.equal(f.record.completedAt, 1100);
});

test("navigation observation rejects never-committed, same-document, pending or late success within the unchanged absolute budget", async () => {
  for (const [index, read] of [
    ({ loading }) => loading,
    ({ committed }) => ({ ...committed, frames: [{ ...committed.frames[0], documentId: "native-old" }] }),
    ({ committed }) => ({ ...committed, tab: { ...committed.tab, pendingUrl: committed.tab.url } }),
    ({ committed, advance }) => { advance(501); return committed; }
  ].entries()) {
    const f = commitObservationFixture(read); await assert.rejects(f.run(), /original action deadline/);
    assert.equal(f.record.complete, false); assert.equal(f.record.deadlineAt, 1500); assert.ok(f.reads() <= 5);
    assert.equal(f.record.samples.length, index === 3 ? 0 : f.reads());
    if (index === 3) assert.equal(f.reads(), 1, "The late successful read was sent but cannot publish a sample after outer expiry");
  }
  const expired = commitObservationFixture(() => { throw Error("Must not read"); });
  await assert.rejects(expired.run({ deadlineAt: 1000 }), /original action deadline/); assert.equal(expired.reads(), 0);
});

test("native commit read errors and unsafe identities terminate once without hiding the original error or retrying input", async () => {
  const original = Object.freeze(new Error("native tabs.get failed")), f = commitObservationFixture(() => { throw original; });
  await assert.rejects(f.run(), error => error === original); assert.equal(f.reads(), 1); assert.equal(f.record.complete, false);
  for (const change of [
    value => { value.tab.id = 43; }, value => { value.tab.active = true; },
    value => { value.frames[0].errorOccurred = true; }, value => { value.frames.push({ ...value.frames[0] }); }
  ]) {
    const bad = commitObservationFixture(({ committed }) => { change(committed); return committed; });
    await assert.rejects(bad.run()); assert.equal(bad.reads(), 1); assert.equal(bad.record.complete, false);
  }
});

test("a timed-out native commit read cannot publish late success or launch another read", async () => {
  let settle, callback, reads = 0;
  const pending = new Promise(resolve => { settle = resolve; }), record = {}, deadlineAt = Date.now() + 20;
  await assert.rejects(waitForCountedNavigationCommit({ read: () => { reads++; return pending; }, until: async predicate => { callback = predicate; await predicate(); },
    tabId: 42, url: "http://localhost/destination", beforeDocumentId: "old", deadlineAt, record }), /timed out|deadline/);
  const snapshot = structuredClone(record);
  settle({ tab: { id: 42, active: false, status: "complete", url: "http://localhost/destination" }, frames: [{ frameId: 0, url: "http://localhost/destination", documentId: "new", documentLifecycle: "active", errorOccurred: false }] });
  await tick(); assert.equal(await callback(), true); assert.equal(reads, 1); assert.deepEqual(record, snapshot); assert.equal(record.complete, false);
});

test("outer observation timeout winning before the inner read timer prevents a late successful sample", async context => {
  const timers = [];
  context.mock.method(globalThis, "setTimeout", (callback, delay) => { const timer = { callback, delay, cleared: false }; timers.push(timer); return timer; });
  context.mock.method(globalThis, "clearTimeout", timer => { if (timer) timer.cleared = true; });
  let settle, callback, reads = 0;
  const pending = new Promise(resolve => { settle = resolve; }), record = {};
  const operation = waitForCountedNavigationCommit({ read: () => { reads++; return pending; }, until: async predicate => { callback = predicate; await predicate(); },
    tabId: 42, url: "http://localhost/destination", beforeDocumentId: "old", deadlineAt: 1500, record, now: () => 1000 });
  assert.equal(timers.length, 2); assert.deepEqual(timers.map(timer => timer.delay), [500, 500]);
  // Deliberately deliver only the outer timeout. The inner read is still live;
  // a wall-clock timeout/sleep cannot guarantee this exact interleaving.
  timers[1].callback();
  await assert.rejects(operation, /counted navigation commit observation timed out/);
  assert.equal(timers[0].cleared, false); assert.equal(timers[1].cleared, true);
  const snapshot = structuredClone(record);
  settle({ tab: { id: 42, active: false, status: "complete", url: "http://localhost/destination" }, frames: [{ frameId: 0, url: "http://localhost/destination", documentId: "new", documentLifecycle: "active", errorOccurred: false }] });
  await tick(); await tick();
  assert.equal(timers[0].cleared, true); assert.deepEqual(record, snapshot); assert.equal(record.complete, false); assert.deepEqual(record.samples, []);
  assert.equal(await callback(), true); assert.equal(reads, 1);
});

test("serialized native commit reader refuses late execution and never starts frame lookup after a held tab read expires", async () => {
  let time = 1000, resolveTab;
  const read = runInNewContext(`(${readCountedNavigationState.toString()})`, { Date: { now: () => time } });
  const calls = [], pending = new Promise(resolve => { resolveTab = resolve; });
  const api = { tabs: { get: id => { calls.push(["tab", id]); return pending; } }, webNavigation: { getAllFrames: ({ tabId }) => { calls.push(["frames", tabId]); return Promise.resolve([]); } } };
  await assert.rejects(read(api, 42, 1000), /original action deadline/); assert.deepEqual(calls, []);
  const operation = read(api, 42, 1500); assert.deepEqual(calls, [["tab", 42]]);
  time = 1500; resolveTab({ id: 42 }); await assert.rejects(operation, /original action deadline/);
  assert.deepEqual(calls, [["tab", 42]], "No second native request may start after the shared deadline");
});

test("serialized native commit reader preserves native failure identity and rejects late frame completion", async () => {
  let time = 1000, resolveFrames;
  const read = runInNewContext(`(${readCountedNavigationState.toString()})`, { Date: { now: () => time } });
  const original = Object.freeze(new Error("native read failed"));
  await assert.rejects(read({ tabs: { get: () => Promise.reject(original) } }, 42, 1500), error => error === original);
  const frames = new Promise(resolve => { resolveFrames = resolve; }), calls = [];
  const operation = read({ tabs: { get: async id => { calls.push(["tab", id]); return { id }; } }, webNavigation: { getAllFrames: ({ tabId }) => { calls.push(["frames", tabId]); return frames; } } }, 42, 1500);
  await tick(); assert.deepEqual(calls, [["tab", 42], ["frames", 42]]);
  time = 1500; resolveFrames([]); await assert.rejects(operation, /original action deadline/);
  time = 1000;
  const result = await read({ tabs: { get: async id => ({ id }) }, webNavigation: { getAllFrames: async () => [] } }, 42, 1500);
  assert.deepEqual(structuredClone(result), { tab: { id: 42 }, frames: [] });
});
