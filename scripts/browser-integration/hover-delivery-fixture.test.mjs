import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { installCountedPointerProbe, installPointerDeliveryGate } from "./pointer-delivery-cases.mjs";
import { hoverDeliveryCases, hoverDeliveryURLs, hoverDeliveryHTML, createHoverDeliveryFixtures, installHoverEvidence, readHoverEvidence,
  checkHoverTrace, checkHoverDocuments, checkHoverDeadline, installHoverAckHold, checkHoverHold, checkHoverWireTimeout, checkHoverDelivery,
  installHoverRPCObserver, checkHoverRPCDeadline, checkHoverDropAllDeadline, checkHoverPauseDeadline, createHoverRPCRelay } from "./hover-delivery-fixture.mjs";

const keyFor = spec => `hover-0123456789abcdef0123456789abcdef-${spec.name}`;
const tick = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };
const defer = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const scope = { session_id: "unit-session", turn_id: "unit-turn", control_epoch: 2 };
const spec = hoverDeliveryCases[0];
const move = more => ({ type: "mouseMoved", x: 185, y: 105, button: "none", buttons: 0, ...more });
const relaySnapshot = probe => ({ version: 1, tabId: probe.tabId, scope: structuredClone(probe.scope), overflow: false, recordingErrors: 0, stopped: true,
  records: probe.records.filter(value => ["request", "response"].includes(value.kind)).map((value, index) => ({ ...structuredClone(value), sequence: index + 1, ...(value.kind === "response" ? { requestSequence: 1 } : {}) })) });

async function traceFor(selected) {
  const target = {}, api = { debugger: { sendCommand: () => Promise.resolve({ native: true }) } };
  const dropAll = selected.gate === "drop-all";
  (dropAll ? installPointerDeliveryGate : installCountedPointerProbe)(api, target, { id: "trace-id", tabId: 42, mode: selected.gate });
  const send = (method, params) => api.debugger.sendCommand({ tabId: 42 }, method, params);
  const movements = selected.gate === "observe" ? 1 : 2;
  for (let index = 0; index < movements; index++) {
    if (selected.modifiers.includes("Shift")) await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Shift", code: "ShiftLeft", modifiers: 8 });
    await send("Input.dispatchMouseEvent", move({ modifiers: selected.modifiers.includes("Shift") ? 8 : 0 }));
    if (selected.modifiers.includes("Shift")) await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Shift", code: "ShiftLeft", modifiers: 0 });
  }
  await tick(); return target[dropAll ? "__obuPointerDelivery" : "__obuCountedPointer"].restore();
}

test("matrix uses seven distinct bounded public-hover scenarios and no duplicated shared fixture", () => {
  assert.equal(hoverDeliveryCases.length, 7); assert.equal(new Set(hoverDeliveryCases.map(value => value.name)).size, 7);
  assert.ok(hoverDeliveryCases.some(value => value.disabled)); assert.ok(hoverDeliveryCases.some(value => value.layout === "transformed"));
  for (const selected of hoverDeliveryCases) {
    const key = keyFor(selected), urls = hoverDeliveryURLs("http://127.0.0.1:1234/", key);
    const html = hoverDeliveryHTML(new URL(urls.root)); assert.match(html, /installHoverEvidence/); assert.match(html, /"pointermove", "mousemove"/);
    assert.ok(!html.includes(".click()") && !html.includes("dispatchEvent("));
    if (["oopif", "transformed"].includes(selected.layout)) assert.equal(new URL(urls.target).hostname, "localhost");
    if (selected.layout === "same") assert.equal(new URL(urls.target).hostname, "127.0.0.1");
    if (selected.disabled) assert.match(hoverDeliveryHTML(new URL(urls.target)), /data-token=.*disabled/);
  }
  assert.throws(() => hoverDeliveryURLs("http://localhost/", "hover-unknown"));
});

for (const selected of hoverDeliveryCases) test(`native evidence checker accepts one committed move or no delivered move: ${selected.name}`, async () => {
  const trace = await traceFor(selected), result = checkHoverTrace(trace, selected);
  assert.equal(result.nativeMoves, selected.gate === "drop-all" ? 0 : 1); assert.equal(result.mouseButtons, 0);
});

test("native checker rejects duplicate move, missing ACK, root bypass, button input and unbalanced modifiers", async () => {
  const trace = await traceFor(spec);
  for (const mutate of [
    value => { value.pending = 1; }, value => { value.overflow = true; }, value => { value.restored = false; }, value => { value.recordingErrors = 1; },
    value => { value.records.find(record => record.kind === "invoke").source.sessionId = "child"; },
    value => { value.records.find(record => record.kind === "settled").ok = false; },
    value => { value.records.find(record => record.params?.type === "mouseMoved").params.type = "mousePressed"; },
    value => { value.records.find(record => record.params?.type === "keyUp").params.key = "Alt"; },
    value => { value.records.find(record => record.params?.type === "mouseMoved").params.modifiers = 0; },
    value => { value.records.find(record => record.params?.type === "mouseMoved").params.modifiers = 10; },
    value => { value.records.find(record => record.params?.type === "keyUp").params.modifiers = 8; },
    value => { value.records.splice(1, 1); }
  ]) { const invalid = structuredClone(trace); mutate(invalid); assert.throws(() => checkHoverTrace(invalid, spec)); }
  const duplicate = structuredClone(trace), invocation = duplicate.records.length + 1;
  duplicate.records.push({ sequence: invocation, kind: "invoke", method: "Input.dispatchMouseEvent", source: { tabId: 42 }, params: move({ modifiers: 8 }), dispatched: true },
    { sequence: invocation + 1, kind: "settled", invocation, ok: true });
  assert.throws(() => checkHoverTrace(duplicate, spec), /Exactly one/);
});

test("the drop-all deadline checker rejects early error text and timeout budget drift", () => {
  const item = { timeoutMs: 5000, startedAt: 10000, failedAt: 15020, actionError: "Browser action timed out after 4998ms" };
  assert.equal(checkHoverDeadline(item).elapsedMs, 5020);
  for (const change of [{ failedAt: 10020 }, { failedAt: 20000 }, { completedAt: 15000 }, { timeoutMs: 10000 }, { actionError: "Pointer target disappeared" }, { startedAt: NaN }])
    assert.throws(() => checkHoverDeadline({ ...item, ...change }));
});

// Unit-only DOM model: isTrusted values below model the checker, never claim
// browser trust. Real trust/renderer routing requires the independent native run.
async function documentModel(selected, { target = true, delivered = true, compatibility = true } = {}) {
  const key = keyFor(selected), listeners = new Map(), targetListeners = new Map(), menu = { id: "menu", hidden: true, style: {}, dataset: {} };
  const node = { id: "hover-target", dataset: { token: `${key}-node` }, style: {}, removed: false, disabled: Boolean(selected.disabled),
    addEventListener(type, listener) { targetListeners.set(type, listener); }, remove() { this.removed = true; } };
  const doc = { querySelector(selector) { return selector === "#hover-target" ? (target && !node.removed ? node : null) : menu; },
    addEventListener(type, listener) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(listener); } };
  const posts = [], urls = hoverDeliveryURLs("http://127.0.0.1:1234/", key), href = target ? urls.target : urls.root;
  const sandbox = { document: doc, crypto: { randomUUID: () => target ? "native-target-document" : "native-root-document" }, location: { href }, structuredClone, URLSearchParams,
    fetch: async (_url, options) => { posts.push(options); return { ok: true, json: async () => ({ key, index: 1 }) }; } };
  const install = runInNewContext(`(${installHoverEvidence.toString()})`, sandbox); install(doc, selected, key);
  if (target && delivered) {
    const event = { type: "pointermove", isTrusted: true, pointerType: "mouse", isPrimary: true, buttons: 0,
      target: node, shiftKey: selected.modifiers.includes("Shift"), altKey: false, ctrlKey: false, metaKey: false, composedPath: () => [node, doc] };
    for (const listener of listeners.get("pointermove")) listener(event); targetListeners.get("pointermove")(event);
    if (compatibility && selected.effect === "cover") {
      const mouse = { ...event, type: "mousemove", target: menu, pointerType: undefined, isPrimary: undefined, composedPath: () => [menu, doc] };
      for (const listener of listeners.get("mousemove")) listener(mouse);
    }
  }
  await tick(); return { ...structuredClone(runInNewContext(`(${readHoverEvidence.toString()})()`, sandbox)), posts, node, menu };
}

async function receiptFor(selected = spec, options = {}) {
  const delivered = selected.gate !== "drop-all", target = await documentModel(selected, { delivered, ...options }), key = keyFor(selected);
  const documents = [{ documentId: "native-target", frameId: selected.layout === "root" ? 0 : 7, result: { href: target.href, evidence: target.evidence, state: target.state } }];
  if (selected.layout !== "root") { const root = await documentModel(selected, { target: false, delivered: false }); documents.unshift({ documentId: "native-root", frameId: 0, result: { href: root.href, evidence: root.evidence, state: root.state } }); }
  const posts = target.posts.map(post => { const bytes = Buffer.from(post.body), sha256 = digest(bytes); return { method: "POST", bodyBytes: bytes.length, bodyBase64: bytes.toString("base64"), bodySHA256: sha256, value: JSON.parse(post.body), receipt: { key, index: 1, bodySHA256: sha256 } }; });
  return { key, targetURL: target.href, documents, server: { posts }, model: target };
}

for (const selected of hoverDeliveryCases) test(`independent document/POST evidence and normal hover side effect: ${selected.name}`, async () => {
  const item = await receiptFor(selected), proof = checkHoverDocuments(item, selected);
  assert.equal(proof.posts, selected.gate === "drop-all" ? 0 : 1);
  if (selected.gate === "drop-all") assert.equal(item.model.menu.hidden, true);
  else if (selected.effect === "remove") assert.equal(item.model.node.removed, true);
  else if (selected.effect === "move") assert.equal(item.model.node.style.transform, "translate(140px, 50px)");
  else assert.equal(item.model.menu.hidden, false);
});

test("document checker rejects untrusted/replayed/wrong-node input and inconsistent original server bytes", async () => {
  const { model: _model, ...item } = await receiptFor(spec);
  for (const mutate of [
    value => { value.documents[0].result.evidence.events[0].trusted = false; },
    value => { value.documents[0].result.evidence.events[0].nodeToken = "replacement-node"; },
    value => { value.documents[0].result.evidence.events[0].type = "pointerdown"; },
    value => { value.documents[0].result.evidence.events.push(structuredClone(value.documents[0].result.evidence.events[0])); },
    value => { value.documents[0].result.evidence.events[0].shift = false; },
    value => { value.documents[0].result.evidence.events[0].ctrl = true; },
    value => { value.documents[0].result.evidence.events[0].alt = true; },
    value => { value.documents[0].result.evidence.events[0].meta = true; },
    value => { value.server.posts[0].bodySHA256 = "wrong"; }, value => { value.server.posts[0].value.moves = 2; },
    value => { value.server.posts.push(value.server.posts[0]); }, value => { value.documents[0].result.evidence.overflow = true; },
    value => { value.documents[0].result.state.menuVisible = false; }, value => { value.server.overflow = true; }
  ]) { const invalid = structuredClone(item); mutate(invalid); assert.throws(() => checkHoverDocuments(invalid, spec)); }
});

test("cover menu oracle rejects hover success without its real compatibility-event business initialization", async () => {
  const selected = hoverDeliveryCases.find(value => value.effect === "cover");
  const blocked = await receiptFor(selected, { compatibility: false });
  assert.equal(blocked.model.evidence.moves, 1); assert.equal(blocked.server.posts.length, 1); assert.equal(blocked.model.menu.hidden, false);
  assert.throws(() => checkHoverDocuments(blocked, selected), /compatibility initialization/);
  const { model: _model, ...valid } = await receiptFor(selected); checkHoverDocuments(valid, selected);
  for (const mutate of [value => { value.documents[1].result.evidence.compatibilityInitializations = 2; },
    value => { value.documents[1].result.state.menuInitialized = null; },
    value => { value.documents[1].result.evidence.events.find(event => event.type === "mousemove").trusted = false; },
    value => { value.documents[1].result.evidence.events = value.documents[1].result.evidence.events.filter(event => event.type !== "mousemove"); }]) {
    const invalid = structuredClone(valid); mutate(invalid); assert.throws(() => checkHoverDocuments(invalid, selected));
  }
});

function heldFixture({ original, holdTimeoutMs = 1000 } = {}) {
  const actual = defer(), calls = [], receiver = {};
  const native = original ?? function (...args) { calls.push({ receiver: this, args }); return actual.promise; };
  const api = { debugger: { sendCommand: native } }, target = {};
  installHoverAckHold(api, target, { id: "hold-id", tabId: 42, scope, holdTimeoutMs });
  return { actual, calls, receiver, native, api, target, probe: target.__obuHoverHold };
}

test("ACK hold waits real native settlement once then publishes original result only on explicit release", async () => {
  const f = heldFixture(), source = { tabId: 42 }, params = move(), response = { original: "ack" };
  let delivered = false;
  const promise = Reflect.apply(f.api.debugger.sendCommand, f.receiver, [source, "Input.dispatchMouseEvent", params]).then(value => { delivered = true; return value; });
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].receiver, f.receiver); assert.equal(f.calls[0].args[0], source); assert.equal(f.calls[0].args[2], params);
  assert.equal(f.probe.snapshot().held, false); assert.equal(delivered, false);
  f.actual.resolve(response); await tick(); checkHoverHold(f.probe.snapshot()); assert.equal(delivered, false);
  f.probe.release(); assert.equal(await promise, response); await tick();
  const proof = f.probe.restore(); checkHoverHold(proof, { complete: true }); assert.equal(f.api.debugger.sendCommand, f.native);
});

test("hold preserves other targets, errors, and early release without fabricating held success", async () => {
  const nativeError = new Error("native failed"), nativePromise = Promise.reject(nativeError); nativePromise.catch(() => {});
  const f = heldFixture({ original: () => nativePromise });
  assert.equal(f.api.debugger.sendCommand({ tabId: 99 }, "Input.dispatchMouseEvent", move()), nativePromise);
  await assert.rejects(f.api.debugger.sendCommand({ tabId: 42 }, "Input.dispatchMouseEvent", move()), error => error === nativeError);
  assert.equal(f.probe.snapshot().held, false); assert.throws(() => checkHoverHold(f.probe.snapshot())); f.probe.restore();
  const early = heldFixture(), pending = early.api.debugger.sendCommand({ tabId: 42 }, "Input.dispatchMouseEvent", move());
  early.probe.release(); early.actual.resolve({}); await pending;
  const snapshot = early.probe.restore(); assert.equal(snapshot.records.filter(value => value.kind === "held").length, 0); assert.throws(() => checkHoverHold(snapshot, { complete: true }));
});

test("hold watchdog, overflow and foreign wrapper replacement remain failures", async () => {
  const f = heldFixture({ holdTimeoutMs: 10 }), pending = f.api.debugger.sendCommand({ tabId: 42 }, "Input.dispatchMouseEvent", move());
  const rejected = assert.rejects(pending, /watchdog expired/); f.actual.resolve({}); await rejected;
  assert.match(f.probe.snapshot().failure, /watchdog/); assert.throws(() => f.probe.release(), /watchdog/);
  assert.throws(() => checkHoverHold(f.probe.restore(), { complete: true }));
  const overflow = heldFixture({ original: () => Promise.resolve({}) });
  for (let index = 0; index < 70; index++) await overflow.api.debugger.sendCommand({ tabId: 42 }, "Input.dispatchKeyEvent", { type: "keyUp", key: "Shift" });
  assert.equal(overflow.probe.snapshot().overflow, true); overflow.probe.restore();
  const foreign = heldFixture(); foreign.api.debugger.sendCommand = () => Promise.resolve({});
  assert.throws(() => foreign.probe.restore(), /replaced externally/);
});

test("serialized hold function needs no module scope and never inspects target accessors", () => {
  const install = runInNewContext(`(${installHoverAckHold.toString()})`, { structuredClone, setTimeout, clearTimeout }), promise = Promise.resolve({});
  const api = { debugger: { sendCommand: () => promise } }, target = {};
  install(api, target, { id: "standalone", tabId: 42, scope });
  assert.equal(api.debugger.sendCommand({ get tabId() { throw Error("must not read"); } }, "Input.dispatchMouseEvent", move()), promise);
  assert.equal(target.__obuHoverHold.snapshot().records.length, 0); target.__obuHoverHold.restore();
});

test("wire proof requires exact-scope backend timeout before caller outcome while original move stays held", async () => {
  const f = heldFixture(), request = { id: "obu:1", method: "browserAction", params: { ...scope, tabId: 42, action: "hover", timeoutMs: 1000 } };
  const rpc = f.target.__integrationNativeRPCObserver;
  rpc("request", { ...request, id: "other", params: { ...request.params, turn_id: "foreign" } });
  rpc("response", { id: "other", error: { message: "not included" } });
  assert.equal(f.probe.snapshot().records.length, 0);
  const startedAt = Date.now();
  rpc("request", request);
  const pending = f.api.debugger.sendCommand({ tabId: 42 }, "Input.dispatchMouseEvent", move()); f.actual.resolve({}); await tick();
  const outcome = { ok: false, error: "Browser action timed out", errorMessage: "Browser action timed out", settledAt: Date.now() + 1 };
  assert.throws(() => checkHoverWireTimeout(f.probe.snapshot(), outcome, startedAt, relaySnapshot(f.probe.snapshot())), /SDK-only/);
  rpc("response", { id: request.id, error: { message: "Browser action timed out" } });
  outcome.settledAt = Date.now(); const valid = f.probe.snapshot(), relay = relaySnapshot(valid); checkHoverWireTimeout(valid, outcome, startedAt, relay);
  for (const mutate of [value => { value.records.find(r => r.kind === "response").ok = true; },
    value => { value.records.find(r => r.kind === "response").error = "Different browser timeout"; },
    value => { value.records.find(r => r.kind === "request").scope.turn_id = "foreign"; },
    value => { value.records.find(r => r.kind === "request").timeoutMs = 5000; }]) {
    const invalid = structuredClone(valid); mutate(invalid); assert.throws(() => checkHoverWireTimeout(invalid, outcome, startedAt, relay));
  }
  const skewed = structuredClone(valid); skewed.records.forEach(record => { record.at += 100; });
  checkHoverWireTimeout(skewed, outcome, startedAt, relay); // Cross-process clocks are diagnostics, never causal authority.
  for (const errorMessage of [undefined, "Different browser timeout", "Open Browser Use request timed out: browserAction"])
    assert.throws(() => checkHoverWireTimeout(valid, { ...outcome, errorMessage }, startedAt, relay));
  f.probe.release(); await pending; f.probe.restore(); assert.equal(f.target.__integrationNativeRPCObserver, undefined);
});

test("restoring after watchdog failure still removes own observers and never overwrites a replacement", async () => {
  const f = heldFixture({ holdTimeoutMs: 10 }), pending = f.api.debugger.sendCommand({ tabId: 42 }, "Input.dispatchMouseEvent", move());
  const rejected = assert.rejects(pending, /watchdog/); f.actual.resolve({}); await rejected;
  assert.throws(() => f.probe.release(), /watchdog/); const restored = f.probe.restore();
  assert.equal(restored.restored, true); assert.match(restored.failure, /watchdog/); assert.equal(f.target.__integrationNativeRPCObserver, undefined);
  const foreign = heldFixture(), replacement = () => {};
  foreign.target.__integrationNativeRPCObserver = replacement;
  assert.throws(() => foreign.probe.restore(), /replaced/);
  assert.equal(foreign.target.__integrationNativeRPCObserver, replacement); assert.equal(foreign.api.debugger.sendCommand, foreign.native);
});

for (const selected of hoverDeliveryCases.filter(value => value.gate === "drop-all")) test(`${selected.name} requires original wire timeout and all Input entrypoints match the inner mouse gate`, async () => {
  const target = {}, api = { debugger: { sendCommand: () => Promise.resolve({}) } }, id = "drop-all-id";
  installPointerDeliveryGate(api, target, { id, tabId: 42, mode: "drop-all" });
  installHoverRPCObserver(api, target, { id, tabId: 42, scope });
  const relay = createHoverRPCRelay(), observation = relay.arm(42, scope);
  const rpc = (direction, message) => { relay.observe(direction, message); target.__integrationNativeRPCObserver(direction, message); };
  const request = { id: "obu:1", method: "browserAction", params: { ...scope, tabId: 42, action: "hover", timeoutMs: 5000 } };
  const startedAt = Date.now();
  rpc("request", request);
  for (let index = 0; index < 2; index++) await api.debugger.sendCommand({ tabId: 42 }, "Input.dispatchMouseEvent", move({ modifiers: 0 }));
  await tick(); const outcome = { ok: false, error: "Browser action timed out", errorMessage: "Browser action timed out", settledAt: Date.now() };
  assert.throws(() => checkHoverRPCDeadline(target.__obuHoverRPC.snapshot(), outcome, 5000, startedAt, observation.snapshot()), /SDK-only/);
  rpc("response", { id: request.id, error: { message: outcome.error } }); outcome.settledAt = Date.now();
  const item = { rpcProbe: target.__obuHoverRPC.restore(), relayProbe: observation.stop(), probe: target.__obuPointerDelivery.restore(), actionError: outcome.error,
    actionErrorMessage: outcome.errorMessage, startedAt, failedAt: outcome.settledAt, timeoutMs: 5000 };
  checkHoverTrace(item.probe, selected); checkHoverDropAllDeadline(item);
  for (const change of [value => { value.rpcProbe.records.pop(); }, value => { value.rpcProbe.inputPending = 1; },
    value => { value.rpcProbe.inputRecordingErrors = 1; }, value => { value.rpcProbe.inputCalls.push({ source: { tabId: 42 }, method: "Input.dispatchKeyEvent", params: { type: "rawKeyDown", key: "Alt" }, settled: "fulfilled" }); },
    value => { value.rpcProbe.records.find(r => r.kind === "response").error = "Permission denied"; }]) {
    const invalid = structuredClone(item); change(invalid); assert.throws(() => checkHoverDropAllDeadline(invalid));
  }
  assert.equal(target.__integrationNativeRPCObserver, undefined);
});

test("wire budget accounts conservatively for observed elapsed time without inventing an exact send instant", () => {
  const callerStartedAt = 10000, budget = 1000;
  const sample = (elapsed, wireBudget) => ({ version: 1, tabId: 42, overflow: false, scope,
    records: [{ sequence: 1, at: callerStartedAt + elapsed, kind: "request", requestId: "obu:1", method: "browserAction:hover", scope: { ...scope }, timeoutMs: wireBudget },
      { sequence: 2, at: 12000, kind: "response", requestId: "obu:1", requestSequence: 1, ok: false, error: "Browser action timed out" }] });
  const outcome = { ok: false, error: "Browser action timed out", errorMessage: "Browser action timed out", settledAt: 12000 };
  for (const [elapsed, wire] of [[0, 1000], [1, 999], [1, 1000], [300, 700], [300, 1000], [999, 1]]) {
    const proof = checkHoverRPCDeadline(sample(elapsed, wire), outcome, budget, callerStartedAt, relaySnapshot(sample(elapsed, wire)));
    assert.equal(proof.minimumWireBudgetMs, budget - elapsed); assert.equal(proof.observedWireBudgetMs, wire);
  }
  for (const [elapsed, wire] of [[-1, 1000], [1000, 1], [1001, 1], [0.5, 1000], [NaN, 1000],
    [1, 0], [1, -1], [1, NaN], [1, Infinity], [1, 999.5], [1, 1001], [1, 998], [300, 699]])
    assert.throws(() => checkHoverRPCDeadline(sample(elapsed, wire), outcome, budget, callerStartedAt, relaySnapshot(sample(elapsed, wire))));
  for (const mutate of [value => { value.records[0].scope.turn_id = "foreign"; }, value => { value.records.splice(1); },
    value => { value.records.push({ ...value.records[0], sequence: 3 }); }, value => { value.records[1].at = outcome.settledAt + 1; }]) {
    const invalid = sample(1, 999); mutate(invalid); assert.throws(() => checkHoverRPCDeadline(invalid, outcome, budget, callerStartedAt, relaySnapshot(invalid)));
  }
});

test("same-process relay is bounded, exact-scope, immutable to the caller and cannot stop a successor observer", () => {
  const relay = createHoverRPCRelay(), capturedScope = { ...scope }, first = relay.arm(42, capturedScope);
  capturedScope.turn_id = "changed"; assert.throws(() => relay.arm(43, scope), /already armed/);
  const request = { id: "obu:1", method: "browserAction", params: { ...scope, tabId: 42, action: "hover", timeoutMs: 1000 } };
  relay.observe("request", { ...request, id: "foreign", params: { ...request.params, session_id: "foreign" } });
  relay.observe("response", { id: "foreign", error: { message: "Foreign private data" } });
  assert.equal(first.snapshot().records.length, 0);
  relay.observe("request", request); relay.observe("response", { id: request.id, error: { message: "Browser action timed out" } });
  const snapshot = first.snapshot(); assert.deepEqual(snapshot.records.map(value => value.kind), ["request", "response"]);
  assert.ok(snapshot.records[1].at >= snapshot.records[0].at); assert.deepEqual(snapshot.scope, scope);
  snapshot.records.length = 0; assert.equal(first.snapshot().records.length, 2);
  first.stop(); const second = relay.arm(42, scope); first.stop();
  relay.observe("request", request); assert.equal(second.snapshot().records.length, 1); assert.equal(first.snapshot().records.length, 2);
  relay.observe("request", request); assert.equal(second.snapshot().overflow, true);
  for (let index = 0; index < 24; index++) relay.observe("response", { id: request.id, error: { message: "x".repeat(4096) } });
  assert.equal(second.snapshot().records.length, 16); assert.equal(second.snapshot().records[1].error.length, 2048);
  second.stop(); relay.observe("response", { id: request.id, error: { message: "late" } }); assert.equal(second.snapshot().records.length, 16);
});

test("relay observer records malformed matching input without throwing into the native bridge", () => {
  const relay = createHoverRPCRelay(), observation = relay.arm(42, scope);
  assert.doesNotThrow(() => relay.observe("request", { get params() { throw Error("malformed"); } }));
  assert.equal(observation.snapshot().recordingErrors, 1); observation.stop();
  for (const invalid of [{ ...scope, session_id: "" }, { ...scope, turn_id: "x".repeat(1025) }, { ...scope, control_epoch: 0 }]) assert.throws(() => relay.arm(42, invalid));
});

test("final stopped relay proof rejects corruption arriving after the early successful timeout snapshot", () => {
  for (const late of [
    (relay, request) => relay.observe("response", { id: request.id, error: { message: "Browser action timed out" } }),
    (relay, request) => relay.observe("request", { ...request, id: "obu:2" }),
    (relay, request) => relay.observe("request", request),
    relay => relay.observe("request", { get params() { throw Error("late observation error"); } })
  ]) {
    const relay = createHoverRPCRelay(), observation = relay.arm(42, scope), startedAt = Date.now();
    const request = { id: "obu:1", method: "browserAction", params: { ...scope, tabId: 42, action: "hover", timeoutMs: 1000 } };
    relay.observe("request", request); relay.observe("response", { id: request.id, error: { message: "Browser action timed out" } });
    const workerProof = observation.snapshot(), outcome = { ok: false, error: "Browser action timed out", errorMessage: "Browser action timed out", settledAt: Date.now() };
    checkHoverRPCDeadline(workerProof, outcome, 1000, startedAt, observation.snapshot());
    late(relay, request);
    assert.throws(() => checkHoverRPCDeadline(workerProof, outcome, 1000, startedAt, observation.stop()));
  }
});

test("RPC observer preserves original Input Promise/receiver and excludes foreign task data", async () => {
  const actual = defer(), calls = [], native = function (...args) { calls.push({ receiver: this, args }); return actual.promise; };
  const api = { debugger: { sendCommand: native } }, target = {}, receiver = {};
  const install = runInNewContext(`(${installHoverRPCObserver.toString()})`, { structuredClone });
  install(api, target, { id: "scoped", tabId: 42, scope });
  const source = { tabId: 42 }, params = { type: "rawKeyDown", key: "Control" };
  assert.equal(Reflect.apply(api.debugger.sendCommand, receiver, [source, "Input.dispatchKeyEvent", params]), actual.promise);
  assert.equal(calls[0].receiver, receiver); assert.equal(calls[0].args[0], source); assert.equal(calls[0].args[2], params);
  target.__integrationNativeRPCObserver("request", { id: "foreign", method: "browserAction", params: { ...scope, tabId: 99, action: "hover", timeoutMs: 5000 } });
  target.__integrationNativeRPCObserver("response", { id: "foreign", error: { message: "private foreign error" } });
  assert.equal(target.__obuHoverRPC.snapshot().records.length, 0); assert.equal(target.__obuHoverRPC.snapshot().inputPending, 1);
  actual.resolve({}); await tick(); const restored = target.__obuHoverRPC.restore();
  assert.equal(restored.inputPending, 0); assert.equal(restored.inputCalls[0].method, "Input.dispatchKeyEvent"); assert.equal(api.debugger.sendCommand, native);
});

test("RPC observer bounds matched records, rejects duplicate request IDs, and restores only its own wrappers", () => {
  const original = () => Promise.resolve({}), api = { debugger: { sendCommand: original } }, target = {};
  installHoverRPCObserver(api, target, { id: "bounds", tabId: 42, scope });
  const request = { id: "obu:1", method: "browserAction", params: { ...scope, tabId: 42, action: "hover", timeoutMs: 5000 } };
  target.__integrationNativeRPCObserver("request", request); target.__integrationNativeRPCObserver("request", request);
  for (let index = 0; index < 32; index++) target.__integrationNativeRPCObserver("response", { id: request.id, error: { message: "x".repeat(4096) } });
  const snapshot = target.__obuHoverRPC.snapshot(); assert.equal(snapshot.overflow, true); assert.equal(snapshot.records.length, 16);
  assert.ok(snapshot.records.filter(r => r.kind === "response").every(r => r.error.length === 2048));
  const foreign = () => {}; target.__integrationNativeRPCObserver = foreign;
  assert.throws(() => target.__obuHoverRPC.restore(), /replaced/);
  assert.equal(target.__integrationNativeRPCObserver, foreign); assert.equal(api.debugger.sendCommand, original); assert.equal(target.__obuHoverRPC, undefined);
});

test("Pause proof rejects early/unrelated failures and requires unchanged ten-second cleanup deadline while ACK remains held", async () => {
  const f = heldFixture(), pending = f.api.debugger.sendCommand({ tabId: 42 }, "Input.dispatchMouseEvent", move());
  f.actual.resolve({}); await tick();
  const error = "OBU_AUTOMATION_PAUSE_FAILED: OBU_AUTOMATION_CLEANUP_TIMEOUT: browser cleanup is unconfirmed";
  const detail = { cleanupTimeoutMs: 10000, pauseStartedAt: 1000, pauseSettledAt: 11005, pause: { ok: false, error },
    failed: { ok: true, value: { state: "error", error, inputBlocked: true, cleanupComplete: false } }, stillHeld: f.probe.snapshot() };
  assert.equal(checkHoverPauseDeadline(detail).elapsedMs, 10005);
  for (const change of [value => { value.pauseSettledAt = 1200; }, value => { value.pauseSettledAt = 16000; },
    value => { value.cleanupTimeoutMs = 500; }, value => { value.pause.error = "OBU_AUTOMATION_PAUSE_FAILED: Storage failed"; },
    value => { value.failed.value.error = "Other cleanup error"; }, value => { value.failed.value.state = "paused"; },
    value => { value.failed.value.cleanupComplete = true; }, value => { value.stillHeld.held = false; }]) {
    const invalid = structuredClone(detail); change(invalid); assert.throws(() => checkHoverPauseDeadline(invalid));
  }
  f.probe.release(); await pending; f.probe.restore();
});

test("driver preserves primary failure, attempts exact tab cleanup, and fails on remaining native target", async () => {
  const original = Error("public hover failed"), closeError = Error("exact close failed"), calls = [], detail = {};
  const locator = { textContent: async () => "Hover menu", count: async () => 1, hover: async () => { throw original; } };
  const browser = { client: { sessionId: scope.session_id, turnId: scope.turn_id, controlEpoch: scope.control_epoch },
    cdp: { navigate: async () => {} }, newTab: async () => ({ id: 42, getByRole: () => locator, close: async () => { calls.push("close"); throw closeError; } }) };
  const worker = { evaluate: async expression => { calls.push(expression);
    if (expression.includes("installCountedPointerProbe")) return {};
    if (expression.includes("p.restore()")) return { restored: true };
    if (expression.includes("getAllFrames")) throw Error("evidence read failed");
    if (expression.includes("tabs.query")) return { tabs: [{ id: 42 }], targets: [{ tabId: 42 }] };
    throw Error("Unexpected fixture operation");
  } };
  const server = createHoverDeliveryFixtures();
  await assert.rejects(checkHoverDelivery({ browser, worker, fixtureURL: "http://127.0.0.1:1234", server, until: () => assert.fail(), rpcRelay: createHoverRPCRelay(), detail }), error => error === original);
  assert.equal(detail.passed, false); assert.equal(original.hoverDeliveryDetail, detail);
  assert.ok(calls.includes("close") && calls.some(value => value.includes("p.restore()")));
  assert.deepEqual(detail.cleanupErrors.map(value => value.stage), ["tab.close", "native-tab-target-absence"]);
  assert.deepEqual(detail.after, { tabIds: [42], tabs: [{ id: 42 }], targets: [{ tabId: 42 }] });
});

test("HTTP fixture preserves actual POST bytes and rejects invalid routes/oversized bodies", async () => {
  const fixture = createHoverDeliveryFixtures();
  const server = http.createServer((request, response) => {
    if (!fixture.handle(request, response, new URL(request.url, "http://127.0.0.1"))) { response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`, key = keyFor(spec), url = hoverDeliveryURLs(base, key).root;
    const html = await (await fetch(url)).text(); assert.equal(fixture.stats(key).gets[0].sha256, digest(Buffer.from(html)));
    const body = JSON.stringify({ key, marker: "原始悬停🚀" });
    const response = await fetch(`${base}/hover-delivery/post?key=${key}`, { method: "POST", body }); assert.equal(response.status, 200);
    assert.equal(fixture.stats(key).posts[0].bodyBase64, Buffer.from(body).toString("base64"));
    assert.equal((await fetch(`${base}/hover-delivery/post?key=${key}`, { method: "POST", body: "a".repeat(65537) })).status, 400);
    assert.equal((await fetch(`${base}/hover-delivery/page?key=invalid`)).status, 400);
    assert.equal((await fetch(`${base}/other`)).status, 404);
    const copy = fixture.stats(key); copy.posts.length = 0; assert.equal(fixture.stats(key).posts.length, 2);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
