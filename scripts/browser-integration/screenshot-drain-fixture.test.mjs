import test from "node:test";
import assert from "node:assert/strict";
import { installScreenshotDrainProbe, assertScreenshotDrainHeld, assertScreenshotDrainEvidence, assertOriginalScreenshotTimeout, checkScreenshotDrain } from "./screenshot-drain-fixture.mjs";

const scope = { session_id: "screenshot-task", turn_id: "original-turn", control_epoch: 3 };
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function setup(sendCommand, options = {}) {
  const listeners = new Set(), target = {}, originalTail = Promise.resolve();
  const backend = { renderingQueues: new Map([[7, originalTail]]), renderingDrains: new Set([originalTail]), automationCleanupTimeoutMs: 5000,
    automationControl: { status: () => ({ state: "running", inputBlocked: false, cleanupComplete: false, revision: 2 }) } };
  const api = { debugger: { sendCommand, onEvent: { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) } } };
  installScreenshotDrainProbe(api, target, backend, { id: "probe", tabId: 7, scope, ...options });
  const controller = target.__obuScreenshotDrain;
  return { api, target, backend, originalTail, listeners, controller,
    request: (method, id, changes = {}) => target.__integrationNativeRPCObserver("request", { id, method: "executeCdp", params: { ...scope, target: { tabId: 7 }, method, timeoutMs: 1000, ...changes } }),
    response: (id, error) => target.__integrationNativeRPCObserver("response", { id, ...(error ? { error: { message: error } } : { result: {} }) }) };
}

test("real native result, receiver and original arguments survive the delivery hold exactly once", async () => {
  const native = deferred(), calls = [], value = { data: "original-png", extra: { native: true } };
  const f = setup(function(...args) { calls.push({ receiver: this, args }); return native.promise; });
  const args = [{ tabId: 7 }, "Page.captureScreenshot", { format: "png", captureBeyondViewport: false }];
  const result = f.api.debugger.sendCommand(...args); let delivered = false; result.then(() => { delivered = true; });
  assert.equal(calls.length, 1); assert.equal(calls[0].receiver, f.api.debugger);
  assert.ok(calls[0].args.every((arg, i) => arg === args[i]));
  assert.equal(f.controller.snapshot().nativePending, 1); assert.equal(f.controller.snapshot().deliveryPending, 0);
  native.resolve(value); const held = await f.controller.wait("held");
  assertScreenshotDrainHeld(held); assert.equal(held.nativePending, 0); assert.equal(held.deliveryPending, 1); assert.equal(delivered, false);
  assert.deepEqual(f.controller.capture(), { data: "original-png" });
  assert.ok(!held.records.some(r => r.kind === "frame"), "Probe must never fabricate a frame");
  f.controller.release("test"); assert.equal(await result, value);
  assert.equal(f.controller.restore().restored, true); assert.equal(f.listeners.size, 0);
  assert.equal(f.api.debugger.sendCommand, calls[0].receiver.sendCommand);
  assert.equal(calls.length, 1);
});

test("unrelated tab, child session and nonselected commands retain the actual native Promise", async () => {
  const native = deferred(), calls = [], f = setup(function(...args) { calls.push(args); return native.promise; });
  for (const args of [[{ tabId: 8 }, "Page.captureScreenshot", {}], [{ tabId: 7, sessionId: "child" }, "Page.captureScreenshot", {}],
    [{ tabId: 7 }, "Runtime.evaluate", { expression: "1" }], [{ tabId: 7 }, "Page.startScreencast", {}]])
    assert.equal(f.api.debugger.sendCommand(...args), native.promise);
  native.resolve({}); await native.promise;
  assert.equal(f.controller.snapshot().records.filter(r => r.kind === "send").length, 1);
  assert.equal(f.controller.snapshot().deliveryPending, 0); assert.equal(calls.length, 4); f.controller.restore();
});

test("native failures are never held, converted to success, retried or replaced", async () => {
  const original = Object.freeze(Error("native failure")); let calls = 0;
  const a = setup(() => { calls++; throw original; });
  assert.throws(() => a.api.debugger.sendCommand({ tabId: 7 }, "Page.captureScreenshot", {}), error => error === original);
  assert.equal(a.controller.restore().deliveryPending, 0);
  const b = setup(() => { calls++; return Promise.reject(original); });
  await assert.rejects(b.api.debugger.sendCommand({ tabId: 7 }, "Page.captureScreenshot", {}), error => error === original);
  assert.equal(b.controller.restore().records.some(r => r.kind === "capture-held"), false); assert.equal(calls, 2);
});

test("successor handshake reads exact production queue identity and never substitutes a queue", async () => {
  const f = setup(() => Promise.resolve({ data: "native" }));
  const result = f.api.debugger.sendCommand({ tabId: 7 }, "Page.captureScreenshot", {});
  await f.controller.wait("held");
  f.request("Page.startScreencast", 2);
  await assert.rejects(f.controller.wait("successor-queued", 20), /handshake timed out/);
  assert.equal(f.backend.renderingQueues.get(7), f.originalTail);
  const successor = Promise.resolve(); f.backend.renderingQueues.set(7, successor); f.backend.renderingDrains.add(successor);
  const queued = await f.controller.wait("successor-queued"); assertScreenshotDrainHeld(queued, { successor: true });
  assert.equal(f.backend.renderingQueues.get(7), successor);
  f.backend.renderingQueues.delete(7);
  const detached = f.controller.snapshot(); assert.equal(detached.backend.queuePresent, false); assertScreenshotDrainHeld(detached);
  f.controller.release("test"); await result; f.controller.restore();
});

test("external stop then start require two separately observed real queue tails, not two delivered requests", async () => {
  const f = setup(() => Promise.resolve({ data: "native" }));
  const result = f.api.debugger.sendCommand({ tabId: 7 }, "Page.captureScreenshot", {}); await f.controller.wait("held");
  f.request("Page.stopScreencast", 2); const stopTail = Promise.resolve(); f.backend.renderingQueues.set(7, stopTail);
  assertScreenshotDrainHeld(await f.controller.wait("successor-queued"), { successor: true, queuedMethods: ["Page.stopScreencast"] });
  f.request("Page.startScreencast", 3);
  await assert.rejects(f.controller.wait("second-successor-queued", 20), /handshake timed out/);
  assert.equal(f.backend.renderingQueues.get(7), stopTail);
  const startTail = Promise.resolve(); f.backend.renderingQueues.set(7, startTail);
  assertScreenshotDrainHeld(await f.controller.wait("second-successor-queued"), { successor: true, queuedMethods: ["Page.stopScreencast", "Page.startScreencast"] });
  assert.equal(f.backend.renderingQueues.get(7), startTail); f.controller.release("test"); await result; f.controller.restore();
});

test("native-settled is not delivered or drained, including after attachment queue retirement", async () => {
  const f = setup(() => Promise.resolve({ data: "native" }));
  const result = f.api.debugger.sendCommand({ tabId: 7 }, "Page.captureScreenshot", {});
  await f.controller.wait("held"); f.backend.renderingQueues.delete(7);
  await assert.rejects(f.controller.wait("drained", 20), /handshake timed out/);
  f.controller.release("test"); await result; await f.controller.wait("delivered");
  await assert.rejects(f.controller.wait("drained", 20), /handshake timed out/);
  f.backend.renderingDrains.delete(f.originalTail);
  const drained = await f.controller.wait("drained"); assert.equal(drained.deliveryPending, 0); f.controller.restore();
});

test("exact original RPC scope includes raw and public high-level screenshots; foreign data is excluded", async () => {
  const f = setup(() => Promise.resolve({}));
  for (const changes of [{ session_id: "foreign" }, { turn_id: "foreign" }, { control_epoch: 4 }, { target: { tabId: 8 } }, { target: { tabId: 7, sessionId: "child" } }]) f.request("Page.captureScreenshot", 99, changes);
  f.response(99, "private foreign error"); assert.equal(f.controller.snapshot().records.length, 0);
  f.request("Page.captureScreenshot", 1); f.response(1, "Timed out after 1000ms");
  f.target.__integrationNativeRPCObserver("request", { id: 2, method: "browserAction", params: { ...scope, tabId: 7, action: "screenshot", timeoutMs: 1000 } });
  f.response(2, "Timeout 1000ms exceeded.");
  const records = f.controller.snapshot().records;
  assert.deepEqual(records.filter(r => r.kind === "request").map(r => r.method), ["Page.captureScreenshot", "browserAction:screenshot"]);
  assert.deepEqual(records.filter(r => r.kind === "response").map(r => r.requestId), [1, 2]);
  assert.ok(!JSON.stringify(records).includes("foreign")); f.controller.restore();
});

test("watchdog releases a real result but always invalidates acceptance evidence", async () => {
  const value = { data: "native" }, f = setup(() => Promise.resolve(value), { holdTimeoutMs: 20 });
  const result = f.api.debugger.sendCommand({ tabId: 7 }, "Page.captureScreenshot", {});
  await f.controller.wait("held"); assert.equal(await result, value);
  assert.equal(f.controller.snapshot().watchdog, true);
  await assert.rejects(f.controller.wait("delivered"), /watchdog/);
  assert.throws(() => assertScreenshotDrainHeld(f.controller.snapshot())); f.controller.restore();
});

test("restoration cannot report success while native result delivery is pending", async () => {
  const original = () => Promise.resolve({ data: "native" }), f = setup(original);
  const result = f.api.debugger.sendCommand({ tabId: 7 }, "Page.captureScreenshot", {});
  await f.controller.wait("held");
  assert.throws(() => f.controller.restore(), /delivery still pending/);
  assert.equal(f.api.debugger.sendCommand, original); assert.equal(f.listeners.size, 0);
  assert.equal(f.target.__obuScreenshotDrain, undefined); assert.equal(f.target.__integrationNativeRPCObserver, undefined);
  await result; assert.equal(f.controller.snapshot().restored, false);
});

test("replacement observer identity is not overwritten during failure cleanup", () => {
  const f = setup(() => Promise.resolve({})), foreign = () => {};
  f.api.debugger.sendCommand = foreign; f.target.__integrationNativeRPCObserver = foreign;
  assert.throws(() => f.controller.restore(), /identity changed/);
  assert.equal(f.api.debugger.sendCommand, foreign); assert.equal(f.target.__integrationNativeRPCObserver, foreign); assert.equal(f.listeners.size, 0);
});

test("evidence capacity is bounded and duplicate request IDs cannot silently pass", () => {
  const f = setup(() => Promise.resolve({})); f.request("Page.captureScreenshot", 1); f.request("Page.captureScreenshot", 1);
  assert.equal(f.controller.snapshot().overflow, true);
  for (const listener of f.listeners) for (let i = 0; i < 4100; i++) listener({ tabId: 7 }, "Page.screencastFrame", { sessionId: i });
  assert.equal(f.controller.snapshot().records.length, 4096); f.controller.restore();
});

function evidence({ pause = false, api = "raw", lease = "internal" } = {}) {
  let sequence = 0; const records = [];
  const add = values => { const r = { sequence: ++sequence, at: 100 + sequence, ...values }; records.push(r); return r; };
  const send = (method, params = {}) => add({ kind: "send", method, source: { tabId: 7 }, params });
  const settle = s => add({ kind: "native-settled", sendSequence: s.sequence, ok: true });
  const request = add({ kind: "request", method: api === "high-level" ? "browserAction:screenshot" : "Page.captureScreenshot", requestId: 1, timeoutMs: 1000 });
  settle(send("Page.startScreencast"));
  const capture = send("Page.captureScreenshot"); settle(capture); add({ kind: "capture-held", sendSequence: capture.sequence });
  add({ kind: "response", requestId: request.requestId, method: request.method, ok: false, error: "Timed out after 1000ms" });
  const queued = [];
  if (api === "raw") {
    if (lease === "external") queued.push(add({ kind: "request", method: "Page.stopScreencast", requestId: 2, scope }));
    queued.push(add({ kind: "request", method: "Page.startScreencast", requestId: lease === "external" ? 3 : 2, scope }));
  }
  add({ kind: "release", reason: "explicit" }); add({ kind: "capture-delivered", sendSequence: capture.sequence });
  if (!pause) {
    settle(send("Page.stopScreencast"));
    if (lease === "external") add({ kind: "response", requestId: 2, ok: true });
    settle(send("Page.startScreencast")); add({ kind: "response", requestId: lease === "external" ? 3 : 2, ok: true });
    add({ kind: "frame", source: { tabId: 7 }, frameSessionId: 2 }); settle(send("Page.screencastFrameAck", { sessionId: 2 })); settle(send("Page.stopScreencast"));
  } else for (const request of queued) add({ kind: "response", requestId: request.requestId, ok: false, error: "OBU_AUTOMATION_PAUSED" });
  return { tabId: 7, scope, records, nativePending: 0, deliveryPending: 0, watchdog: false, overflow: false,
    backend: { originalDrainPresent: false } };
}

test("native order distinguishes successful successor from canceled Pause branch and high-level timeout", () => {
  for (const options of [{}, { pause: true }, { lease: "external" }, { lease: "external", pause: true }, { pause: true, api: "high-level" }]) assertScreenshotDrainEvidence(evidence(options), options);
});

for (const [name, change, pause = false] of [
  ["old duplicate-start contract without a queued stop", p => { p.records = p.records.filter(r => !(r.kind === "request" && r.method === "Page.stopScreencast")); }],
  ["replacement start before actual stop ACK", p => { const stops = p.records.filter(r => r.kind === "send" && r.method === "Page.stopScreencast"), ack = p.records.find(r => r.kind === "native-settled" && r.sendSequence === stops[0].sequence); ack.sequence = 999; }],
  ["foreign-scope stop request", p => { p.records.find(r => r.kind === "request" && r.method === "Page.stopScreencast").scope = { ...scope, turn_id: "foreign" }; }],
  ["stop API reports failure after native ordering", p => { p.records.find(r => r.kind === "response" && r.requestId === 2).ok = false; }],
  ["cancelled stop replays after Pause", p => { p.records.push({ kind: "send", method: "Page.stopScreencast", sequence: 999, source: { tabId: 7 }, params: {} }); }, true],
  ["cancelled stop reports success after Pause", p => { p.records.find(r => r.kind === "response" && r.requestId === 2).ok = true; }, true]
]) test(`external stream acceptance rejects ${name}`, () => { const options = { lease: "external", pause }, p = evidence(options); change(p); assert.throws(() => assertScreenshotDrainEvidence(p, options)); });

test("SDK deadline followed by a later worker timeout cannot masquerade as the original timeout ACK", () => {
  for (const api of ["raw", "high-level"]) {
    const p = evidence({ pause: true, api }); p.released = false;
    const reply = p.records.find(r => r.kind === "response"), caller = { ok: false, error: "Timed out after 1000ms", settledAt: reply.at + 1 };
    assertOriginalScreenshotTimeout(p, caller, api);
    reply.at = caller.settledAt + 1; assert.throws(() => assertOriginalScreenshotTimeout(p, caller, api));
    p.records = p.records.filter(r => r.kind !== "response"); assert.throws(() => assertOriginalScreenshotTimeout(p, caller, api));
  }
});

test("only high-level screenshot accepts an integer remaining wire budget within the original 1000ms", () => {
  for (const api of ["raw", "high-level"]) {
    const p = evidence({ pause: true, api }); p.released = false;
    const request = p.records.find(r => r.kind === "request"), reply = p.records.find(r => r.kind === "response");
    const caller = { ok: false, error: "Browser action timed out", settledAt: reply.at + 1 };
    for (const timeoutMs of [1, 999, 1000]) {
      request.timeoutMs = timeoutMs;
      if (api === "raw" && timeoutMs !== 1000) assert.throws(() => assertOriginalScreenshotTimeout(p, caller, api));
      else assert.equal(assertOriginalScreenshotTimeout(p, caller, api).requestedTimeoutMs, timeoutMs);
    }
    for (const timeoutMs of [0, -1, 0.5, 999.5, NaN, Infinity, "999", true, undefined, 1001]) {
      request.timeoutMs = timeoutMs; assert.throws(() => assertOriginalScreenshotTimeout(p, caller, api));
    }
  }
});

test("reduced high-level budget still requires the original held native capture and timely wire timeout", () => {
  const original = evidence({ pause: true, api: "high-level" }); original.released = false;
  original.records.find(r => r.kind === "request").timeoutMs = 999;
  const caller = { ok: false, error: "Browser action timed out", settledAt: original.records.find(r => r.kind === "response").at + 1 };
  assertOriginalScreenshotTimeout(original, caller, "high-level");
  assertScreenshotDrainEvidence(original, { pause: true, api: "high-level" });
  for (const mutate of [p => { p.records = p.records.filter(r => r.kind !== "response"); },
    p => { p.records.find(r => r.kind === "response").at = caller.settledAt + 1; },
    p => { p.records.find(r => r.kind === "response").ok = true; }, p => { p.released = true; }]) {
    const changed = structuredClone(original); mutate(changed); assert.throws(() => assertOriginalScreenshotTimeout(changed, caller, "high-level"));
  }
  for (const mutate of [p => { p.records.find(r => r.kind === "response").sequence = 999; },
    p => { p.records = p.records.filter(r => r.kind !== "capture-held"); },
    p => { const capture = p.records.find(r => r.kind === "send" && r.method === "Page.captureScreenshot"); p.records = p.records.filter(r => !(r.kind === "native-settled" && r.sendSequence === capture.sequence)); }]) {
    const changed = structuredClone(original); mutate(changed); assert.throws(() => assertScreenshotDrainEvidence(changed, { pause: true, api: "high-level" }));
  }
});

for (const [name, change] of [
  ["second native capture", p => p.records.push({ ...p.records.find(r => r.kind === "send" && r.method === "Page.captureScreenshot"), sequence: 100 })],
  ["SDK-only timeout without original wire reply", p => { p.records = p.records.filter(r => r.kind !== "response"); }],
  ["late original success", p => { p.records.find(r => r.kind === "response").ok = true; }],
  ["timeout after gate release", p => { p.records.find(r => r.kind === "response").sequence = 999; }],
  ["successor bypass before delivery", p => { p.records.filter(r => r.kind === "send" && r.method === "Page.startScreencast")[1].sequence = p.records.find(r => r.kind === "capture-held").sequence + 0.1; }],
  ["original stream stopped while delivery held", p => { p.records.find(r => r.kind === "send" && r.method === "Page.stopScreencast").sequence = p.records.find(r => r.kind === "capture-held").sequence + 0.1; }],
  ["wrong frame acknowledged", p => { p.records.find(r => r.kind === "send" && r.method === "Page.screencastFrameAck").params.sessionId = 999; }],
  ["no successor frame", p => { p.records = p.records.filter(r => r.kind !== "frame"); }],
  ["lost original drain", p => { p.backend.originalDrainPresent = true; }],
  ["native ACK still pending", p => { p.nativePending = 1; }],
  ["watchdog used as success", p => { p.watchdog = true; }],
  ["overflow", p => { p.overflow = true; }]
]) test(`acceptance rejects ${name}`, () => { const p = evidence(); change(p); assert.throws(() => assertScreenshotDrainEvidence(p)); });

test("held assertion catches old false cleanup ACK and lost drain even after source queue deletion", () => {
  const p = evidence({ pause: true }), release = p.records.find(r => r.kind === "release").sequence;
  p.records = p.records.filter(r => r.sequence < release); p.released = false; p.deliveryPending = 1;
  p.backend = { originalDrainPresent: true, queuePresent: false, automation: { inputBlocked: true, cleanupComplete: false } };
  assertScreenshotDrainHeld(p, { paused: true });
  p.backend.automation.cleanupComplete = true; assert.throws(() => assertScreenshotDrainHeld(p, { paused: true }));
  p.backend.automation.cleanupComplete = false; p.backend.originalDrainPresent = false; assert.throws(() => assertScreenshotDrainHeld(p, { paused: true }));
});

test("fixture preserves frozen primary failure and records cleanup failures separately", async () => {
  const primary = Object.freeze(Error("original connect failure")), closeError = Error("original connection close failed");
  let connections = 0, saved, closed = 0;
  await assert.rejects(checkScreenshotDrain({
    connectBrowser: async () => { if (++connections === 2) throw primary; return { close: () => { closed++; throw closeError; } }; },
    worker: { evaluate: () => { throw Error("No worker operation expected before both clients exist"); } }, fixtureURL: "http://127.0.0.1/",
    saveScreenshot: () => { throw Error("No screenshot expected"); }, saveDetail: async detail => { saved = structuredClone(detail); }
  }), error => error === primary);
  assert.equal(connections, 2); assert.equal(closed, 1); assert.equal(saved.passed, false); assert.equal(saved.cases.length, 1);
  assert.match(saved.error, /original connect failure/); assert.deepEqual(saved.cases[0].cleanupErrors.map(r => r.stage), ["close-connection"]);
});
