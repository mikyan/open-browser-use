import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { installManagedHumanNativeTrace, managedHumanNativeTraceEnabled, managedHumanNativeTraceOutcome, managedHumanNativeTraceComplete } from "./managed-human-native-trace.mjs";

function eventChannel() {
  const listeners = new Set();
  return { addListener: listener => listeners.add(listener), removeListener: listener => listeners.delete(listener), hasListener: listener => listeners.has(listener),
    emit: (...args) => { for (const listener of listeners) listener(...args); }, size: () => listeners.size };
}
function setup(send = () => Promise.resolve({}), options = {}) {
  const target = {}, calls = [], api = { debugger: { onEvent: eventChannel(), onDetach: eventChannel(),
    sendCommand: function (...args) { calls.push({ receiver: this, args }); return Reflect.apply(send, this, args); } } };
  const original = api.debugger.sendCommand, initial = installManagedHumanNativeTrace(api, target, options);
  return { api, target, calls, original, initial, controller: target.__managedHumanNativeTrace };
}
const settled = async () => { await Promise.resolve(); await Promise.resolve(); };

test("native trace is explicit and restricted to new-page parent navigation", () => {
  for (const value of [undefined, "0"]) assert.equal(managedHumanNativeTraceEnabled("handoff", "standard", value), false);
  assert.equal(managedHumanNativeTraceEnabled("new-page", "parent-navigate", "1"), true);
  for (const [scenario, variant] of [["handoff", "parent-navigate"], ["new-page", "iframe"], ["new-page", "child-close"]]) assert.throws(() => managedHumanNativeTraceEnabled(scenario, variant, "1"));
  for (const value of [null, "", "true", 1]) assert.throws(() => managedHumanNativeTraceEnabled("new-page", "parent-navigate", value));
  assert.deepEqual(managedHumanNativeTraceOutcome(true, true), { instrumented: true, passed: false, featurePassed: false, diagnosticWorkflowPassed: true, diagnosticCompleted: true, diagnosticGapConfirmed: false });
  for (const pair of [[false, true], [true, false], [false, false]]) assert.equal(managedHumanNativeTraceOutcome(...pair).diagnosticCompleted, false);
});

test("installation dispatches nothing, preserves receiver/arguments/exact Promise and restores only its own resources", async () => {
  let resolve; const promise = new Promise(done => { resolve = done; }), state = setup(() => promise);
  assert.equal(state.calls.length, 0); assert.equal(state.initial.records.length, 0); assert.equal(state.initial.listenerPresent, true);
  const source = { targetId: "original-target", sessionId: "original-session" }, params = { maxWidth: 750, format: "png" };
  const result = state.api.debugger.sendCommand(source, "Page.startScreencast", params);
  assert.equal(result, promise); assert.equal(state.calls.length, 1); assert.equal(state.calls[0].receiver, state.api.debugger);
  assert.equal(state.calls[0].args[0], source); assert.equal(state.calls[0].args[2], params);
  assert.equal(state.controller.snapshot().pending.length, 1);
  const response = {}; resolve(response); assert.equal(await result, response); await settled();
  const final = state.controller.stop(); assert.equal(state.api.debugger.sendCommand, state.original);
  assert.equal(state.api.debugger.onEvent.size(), 0); assert.equal(state.api.debugger.onDetach.size(), 0);
  assert.equal(managedHumanNativeTraceComplete(final), true); assert.deepEqual(final.records[0].source, source);
  assert.deepEqual(final.records.map(row => row.kind), ["send", "resolved"]);
  assert.deepEqual(state.controller.stop(), final);
});

test("actual metrics, frame identities and frame timestamps survive while image, URL and input secrets are omitted", async () => {
  const secret = "DO_NOT_RETAIN_SECRET";
  const state = setup((_source, method) => Promise.resolve(method === "Performance.getMetrics" ? { metrics: [{ name: "Timestamp", value: 123.25 }, { name: "NavigationStart", value: 122 }, { name: secret, value: 5 }] }
    : method === "Page.getFrameTree" ? { frameTree: { frame: { id: "root", loaderId: "loader", url: `https://example.test/${secret}` }, childFrames: [{ frame: { id: "child", parentId: "root", loaderId: "child-loader", name: secret } }] } } : { data: secret }));
  const source = { tabId: 12, targetId: "target", sessionId: "session" };
  for (const method of ["Performance.enable", "Performance.getMetrics", "Page.getFrameTree", "Page.captureScreenshot", "Input.dispatchKeyEvent", "Input.insertText"]) await state.api.debugger.sendCommand(source, method, { type: "keyDown", text: secret, key: secret, unmodifiedText: secret });
  state.api.debugger.onEvent.emit(source, "Page.screencastFrame", { data: secret, sessionId: 8, metadata: { timestamp: 123.5, monotonicTimestamp: 42.125, deviceWidth: 750, deviceHeight: 400, secret } });
  state.api.debugger.onEvent.emit(source, "Page.frameNavigated", { frame: { id: "root", loaderId: "loader2", url: secret } });
  state.api.debugger.onEvent.emit(source, "Target.attachedToTarget", { sessionId: "child-session", targetInfo: { targetId: "child-target", type: "iframe", title: secret, url: secret } });
  await settled(); const final = state.controller.stop(); assert.equal(managedHumanNativeTraceComplete(final), true);
  assert.equal(JSON.stringify(final).includes(secret), false);
  assert.deepEqual(final.records.find(row => row.kind === "resolved" && row.method === "Performance.getMetrics").result.metrics, [{ name: "Timestamp", value: 123.25 }, { name: "NavigationStart", value: 122 }]);
  assert.equal(final.records.find(row => row.method === "Page.screencastFrame").params.metadata.timestamp, 123.5);
  assert.equal(final.records.find(row => row.method === "Page.screencastFrame").params.metadata.monotonicTimestamp, 42.125);
  assert.deepEqual(final.records.find(row => row.kind === "resolved" && row.method === "Page.getFrameTree").result.frames, [{ id: "root", loaderId: "loader" }, { id: "child", parentId: "root", loaderId: "child-loader" }]);
  assert.deepEqual(final.records.find(row => row.kind === "send" && row.method === "Input.dispatchKeyEvent").params, { inputType: "keyDown" });
});

test("frame monotonic timestamp remains a distinct optional native value and visibility stays boolean", async () => {
  const state = setup(() => Promise.resolve({ data: "secret-image-payload" }));
  await state.api.debugger.sendCommand({ tabId: 1 }, "Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false, unknown: "secret" });
  state.api.debugger.onEvent.emit({ tabId: 1 }, "Page.screencastFrame", { metadata: { timestamp: 200.5, monotonicTimestamp: Infinity } });
  state.api.debugger.onEvent.emit({ tabId: 1 }, "Page.screencastFrame", { metadata: { timestamp: 201.5, monotonicTimestamp: 99.25 } });
  state.api.debugger.onEvent.emit({ tabId: 1 }, "Page.screencastVisibilityChanged", { visible: false, data: "secret" });
  await settled(); const final = state.controller.stop(); assert.equal(managedHumanNativeTraceComplete(final), true);
  const frames = final.records.filter(row => row.method === "Page.screencastFrame");
  assert.deepEqual(frames[0].params.metadata, { timestamp: 200.5 }); assert.deepEqual(frames[1].params.metadata, { timestamp: 201.5, monotonicTimestamp: 99.25 });
  assert.deepEqual(final.records.find(row => row.method === "Page.screencastVisibilityChanged").params, { visible: false });
  assert.deepEqual(final.records.find(row => row.kind === "send").params, { format: "png", fromSurface: true, captureBeyondViewport: false });
  assert.equal(JSON.stringify(final).includes("secret"), false);
});

test("unlisted methods and callback-style returns pass through untouched and are never adapted", async () => {
  const callback = () => {}, returned = { notPromise: true };
  const state = setup(() => returned);
  assert.equal(state.api.debugger.sendCommand({ tabId: 1 }, "Runtime.evaluate", { expression: "secret" }, callback), returned);
  assert.equal(state.controller.snapshot().records.length, 0); assert.equal(state.calls[0].args[3], callback);
  assert.equal(state.api.debugger.sendCommand({ tabId: 1 }, "Page.enable", {}, callback), returned);
  assert.equal(state.calls[1].args[3], callback); const final = state.controller.stop();
  assert.equal(final.unknownSettlements, 1); assert.equal(managedHumanNativeTraceComplete(final), false);
});

test("synchronous and asynchronous original errors preserve identity and expose only machine classifications", async () => {
  for (const synchronous of [true, false]) {
    const error = Object.assign(new Error("OBU_VIEW_UNAVAILABLE: target closed https://private.test/?secret=DO_NOT_RETAIN"), { code: -32000 });
    const state = setup(() => { if (synchronous) throw error; return Promise.reject(error); });
    if (synchronous) assert.throws(() => state.api.debugger.sendCommand({ tabId: 1 }, "Page.enable", {}), received => received === error);
    else { const promise = state.api.debugger.sendCommand({ tabId: 1 }, "Page.enable", {}); await assert.rejects(promise, received => received === error); }
    await settled(); const final = state.controller.stop(); assert.equal(managedHumanNativeTraceComplete(final), true);
    assert.deepEqual(final.records.at(-1).error, { category: "target-closed", code: "OBU_VIEW_UNAVAILABLE", nativeCode: -32000 });
    assert.equal(JSON.stringify(final).includes("DO_NOT_RETAIN"), false);
  }
});

test("serialized native machine code is retained without its arbitrary error message", async () => {
  const error = new Error('{"code":-32000,"message":"private secret arbitrary text"}'), state = setup(() => Promise.reject(error));
  await assert.rejects(state.api.debugger.sendCommand({ targetId: "target" }, "Page.enable", {}), received => received === error); await settled();
  const final = state.controller.stop(); assert.deepEqual(final.records.at(-1).error, { category: "unclassified", nativeCode: -32000 });
  assert.equal(JSON.stringify(final).includes("private secret"), false);
});

test("argument/result accessors are not invoked by the observer", async () => {
  let getterCalls = 0; const hostile = { get text() { getterCalls++; throw new Error("secret"); }, get metrics() { getterCalls++; throw new Error("secret"); } };
  const state = setup(() => Promise.resolve(hostile)); await state.api.debugger.sendCommand({ tabId: 1 }, "Performance.getMetrics", hostile);
  await settled(); assert.equal(getterCalls, 0); assert.equal(managedHumanNativeTraceComplete(state.controller.stop()), true);
});

test("overflow stops diagnostic retention only and never suppresses an original invocation or settlement", async () => {
  const state = setup(() => Promise.resolve({}), { maximumRecords: 1 });
  const promises = Array.from({ length: 6 }, () => state.api.debugger.sendCommand({ tabId: 1 }, "Page.enable", {})); await Promise.all(promises); await settled();
  const final = state.controller.stop(); assert.equal(state.calls.length, 6); assert.equal(final.overflow, true); assert.ok(final.dropped > 0);
  assert.equal(final.pending.length, 0); assert.equal(managedHumanNativeTraceComplete(final), false);
});

test("stop never waits for pending original calls and retains actual late outcomes without accepting incomplete capture", async () => {
  let resolve; const promise = new Promise(done => { resolve = done; }), state = setup(() => promise);
  assert.equal(state.api.debugger.sendCommand({ tabId: 1 }, "Page.enable", {}), promise);
  const stopped = state.controller.stop(); assert.equal(stopped.pending.length, 1); assert.equal(managedHumanNativeTraceComplete(stopped), false);
  resolve({}); await promise; await settled(); const final = state.controller.snapshot();
  assert.equal(final.pending.length, 0); assert.equal(final.records.at(-1).kind, "resolved"); assert.equal(managedHumanNativeTraceComplete(final), true);
});

test("foreign wrapper and truncated tree cannot claim a complete diagnostic", async () => {
  const state = setup(() => Promise.resolve({ frameTree: { frame: { id: "root" }, childFrames: Array.from({ length: 65 }, (_, i) => ({ frame: { id: `child-${i}` } })) } }));
  await state.api.debugger.sendCommand({ tabId: 1 }, "Page.getFrameTree", {}); await settled();
  const foreign = () => Promise.resolve({}); state.api.debugger.sendCommand = foreign;
  const final = state.controller.stop(); assert.equal(state.api.debugger.sendCommand, foreign); assert.equal(final.restored, false);
  assert.deepEqual(final.restorationErrors, ["WRAPPER_REPLACED"]); assert.equal(final.records.at(-1).result.truncated, true);
  assert.equal(managedHumanNativeTraceComplete(final), false);
});

test("complete trace requires every exact original settlement, bounded payload and actual restoration", async () => {
  const state = setup(); await state.api.debugger.sendCommand({ targetId: "original", sessionId: "session" }, "Page.enable", {}); await settled();
  const good = state.controller.stop(); assert.equal(managedHumanNativeTraceComplete(good), true);
  for (const mutate of [v => { v.records.pop(); }, v => { v.records[1].callId++; }, v => { v.records[1].source.targetId = "other"; },
    v => { v.records[1].method = "Page.getFrameTree"; }, v => { v.records[1].at = null; }, v => { v.projectionErrors++; },
    v => { v.retainedCharacters--; }, v => { v.listenerPresent = true; }, v => { v.pending.push({ callId: 1 }); }, v => { v.restored = false; }]) {
    const broken = structuredClone(good); mutate(broken); assert.equal(managedHumanNativeTraceComplete(broken), false);
  }
});

test("character budget and event whitelist omit irrelevant content without blocking native work", async () => {
  const state = setup(() => Promise.resolve({}), { maximumCharacters: 1024 });
  state.api.debugger.onEvent.emit({ tabId: 1 }, "Runtime.consoleAPICalled", { args: ["secret"] });
  assert.equal(state.controller.snapshot().records.length, 0);
  for (let i = 0; i < 20; i++) state.api.debugger.onEvent.emit({ tabId: 1 }, "Page.screencastFrame", { data: "secret", sessionId: i, metadata: { timestamp: i, deviceWidth: 750, deviceHeight: 400 } });
  await state.api.debugger.sendCommand({ tabId: 1 }, "Page.stopScreencast", {}); await settled();
  const final = state.controller.stop(); assert.equal(state.calls.length, 1); assert.equal(final.overflow, true); assert.ok(final.retainedCharacters <= 1024);
  assert.equal(JSON.stringify(final).includes("secret"), false); assert.equal(managedHumanNativeTraceComplete(final), false);
});

test("serialized installer is self-contained and validates configuration before touching native APIs", () => {
  const state = setup(); assert.throws(() => installManagedHumanNativeTrace(state.api, state.target), /already installed/);
  for (const maximumRecords of [0, 4097, null, "2"]) assert.throws(() => installManagedHumanNativeTrace(state.api, {}, { maximumRecords }));
  const api = { debugger: { sendCommand() { throw new Error("must not dispatch"); }, onEvent: eventChannel(), onDetach: eventChannel() } }, target = {};
  const result = vm.runInNewContext(`(${installManagedHumanNativeTrace.toString()})(api,target)`, { api, target, structuredClone });
  assert.equal(result.diagnosticOnly, true); assert.equal(target.__managedHumanNativeTrace.stop().restored, true);
});
