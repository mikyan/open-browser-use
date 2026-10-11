import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { installNativeAPIDiagnostics, nativeDiagnosticPrelude, nativeDiagnosticResult, nativeDiagnosticTraceComplete, nativeDiagnosticsEnabled } from "./native-api-diagnostics.mjs";
import { nativeBrowserInstallationCleaned, nativeBrowserInstallationPassed } from "./native-browser-installation.mjs";

function fixture(options = {}) {
  const calls = [], events = {}, originals = {};
  const api = { tabs: {}, tabGroups: {}, debugger: {} };
  for (const [namespace, methods] of [["tabs", ["create", "group", "get"]], ["tabGroups", ["get", "update"]], ["debugger", ["attach", "detach", "sendCommand", "getTargets"]]]) for (const method of methods) {
    const name = `${namespace}.${method}`;
    api[namespace][method] = originals[name] = function (...args) { calls.push({ name, receiver: this, args }); return Promise.resolve({ ok: true }); };
  }
  for (const [namespace, names] of [["tabs", ["onCreated", "onUpdated", "onRemoved", "onAttached", "onDetached", "onMoved", "onReplaced", "onActivated"]], ["tabGroups", ["onCreated", "onUpdated", "onRemoved", "onMoved"]], ["debugger", ["onEvent", "onDetach"]]]) for (const name of names) {
    const listeners = new Set();
    api[namespace][name] = events[`${namespace}.${name}`] = { addListener: value => listeners.add(value), removeListener: value => listeners.delete(value), emit: (...args) => { for (const listener of listeners) listener(...args); }, listeners };
  }
  const target = { crypto: { randomUUID: () => "test-worker-incarnation" } };
  return { api, target, calls, events, originals, install: () => installNativeAPIDiagnostics(api, target, options) };
}
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

test("opt-in metadata reads preserve actual native calls and are absent from the default trace", async () => {
  const plain = fixture(), old = plain.install(), before = old.snapshot();
  await plain.api.tabs.get(17); await plain.api.debugger.getTargets();
  assert.equal(old.snapshot().records.length, 0);
  const legacy = structuredClone(before); delete legacy.metadataReads;
  assert.equal(nativeDiagnosticTraceComplete(legacy, legacy), true);
  assert.equal(plain.api.tabs.get, plain.originals["tabs.get"]);

  const f = fixture({ metadataReads: true }), tab = deferred(), targets = deferred(), receiver = {}, calls = [];
  f.api.tabs.get = function (...args) { calls.push({ api: "tabs.get", receiver: this, args }); return tab.promise; };
  f.api.debugger.getTargets = function (...args) { calls.push({ api: "debugger.getTargets", receiver: this, args }); return targets.promise; };
  const trace = f.install(), initial = trace.snapshot();
  assert.equal(calls.length, 0, "Observer installation must not issue reads");
  const a = f.api.tabs.get.call(receiver, 17), b = f.api.debugger.getTargets.call(receiver);
  assert.equal(a, tab.promise); assert.equal(b, targets.promise);
  assert.deepEqual(calls, [{ api: "tabs.get", receiver, args: [17] }, { api: "debugger.getTargets", receiver, args: [] }]);
  const liveTab = { id: 17, url: "about:blank", status: "complete", active: false };
  const liveTargets = [{ id: "original-target", tabId: 17, type: "page", url: "about:blank", attached: false }];
  tab.resolve(liveTab); targets.resolve(liveTargets);
  assert.equal(await a, liveTab); assert.equal(await b, liveTargets);
  const final = trace.snapshot();
  assert.deepEqual(final.records.map(record => record.kind), ["start", "start", "settled", "settled"]);
  assert.equal(final.records[0].tabId, 17); assert.equal(final.records[1].target, undefined);
  assert.deepEqual(final.records[2].result, liveTab); assert.deepEqual(final.records[3].result, liveTargets);
  assert.equal(nativeDiagnosticTraceComplete(initial, final), true);
  assert.equal(nativeDiagnosticTraceComplete(before, final), false);
  const corrupt = structuredClone(final); corrupt.metadataReads = "true";
  assert.equal(nativeDiagnosticTraceComplete(initial, corrupt), false);
  assert.ok(nativeDiagnosticPrelude({ metadataReads: true }).includes("(chrome,globalThis,{metadataReads:true})"));
  assert.throws(() => nativeDiagnosticPrelude({ metadataReads: "true" }));
  trace.restore(); assert.equal(calls.length, 2);
});

test("native wrapper preserves receiver, exact arguments and original Promise while recording each call once", async () => {
  const f = fixture(), d = deferred(), receiver = {}, target = { tabId: 41, sessionId: "child-9" }, params = { text: "unique-note" }, calls = [];
  f.api.debugger.sendCommand = function (...args) { calls.push({ receiver: this, args }); return d.promise; };
  const controller = f.install(), initial = controller.snapshot();
  const result = f.api.debugger.sendCommand.call(receiver, target, "Input.insertText", params);
  assert.equal(result, d.promise); assert.equal(calls.length, 1); assert.equal(calls[0].receiver, receiver);
  assert.equal(calls[0].args[0], target); assert.equal(calls[0].args[2], params);
  const pending = controller.snapshot(); assert.equal(pending.pending.length, 1);
  assert.equal(nativeDiagnosticTraceComplete(initial, pending), true, "Unsettled native commands are retained as unknown outcomes, not overflow");
  const response = { result: "original" }; d.resolve(response); assert.equal(await result, response);
  const final = controller.snapshot(); assert.deepEqual(final.records.map(value => value.kind), ["start", "settled"]);
  assert.equal(final.records[0].method, "Input.insertText"); assert.deepEqual(final.records[0].target, target);
  assert.equal(final.records[1].callId, final.records[0].callId); assert.equal(final.pending.length, 0);
  assert.equal(nativeDiagnosticTraceComplete(initial, final), true);
});

test("sync throw and async rejection are original errors with one invocation and no result replacement", async () => {
  const f = fixture(), sync = new Error("native sync failure"), asyncError = new Error("native rejection"), d = deferred(); let count = 0;
  f.api.tabs.group = () => { count++; throw sync; }; f.api.debugger.attach = () => { count++; return d.promise; };
  const controller = f.install(), initial = controller.snapshot();
  assert.throws(() => f.api.tabs.group({ tabIds: [3] }), error => error === sync);
  const result = f.api.debugger.attach({ tabId: 3 }, "1.3"); assert.equal(result, d.promise);
  d.reject(asyncError); await assert.rejects(result, error => error === asyncError);
  assert.equal(count, 2); const final = controller.snapshot();
  assert.deepEqual(final.records.filter(value => value.kind === "error").map(value => value.error.message), [sync.message, asyncError.message]);
  assert.equal(nativeDiagnosticTraceComplete(initial, final), true);
});

test("initial snapshot after existing readiness preserves earlier trace records and never backfills a failed initial observation", async () => {
  const f = fixture(), controller = f.install();
  // Native startup work can occur before the runner's existing handshake ACK.
  f.events["tabs.onUpdated"].emit(7, { status: "loading" }, { id: 7, active: false });
  await f.api.tabGroups.get(3);
  const initial = controller.snapshot();
  assert.equal(initial.records[0].sequence, 0); assert.equal(initial.records[0].event, "tabs.onUpdated");
  assert.equal(initial.records.length, 3);
  await f.api.tabs.create({ active: false });
  const final = controller.snapshot();
  assert.deepEqual(final.records.slice(0, initial.records.length), initial.records);
  assert.equal(nativeDiagnosticTraceComplete(initial, final), true);
  assert.equal(nativeDiagnosticTraceComplete(undefined, final), false, "An earlier failed run still lacks its required initial evidence");
});

test("commands and selected native events share sequence with exact root/child identities and pending initialization", async () => {
  const f = fixture({ clock: () => 123 }), d = deferred(), commands = [];
  f.api.debugger.sendCommand = function (target, method, params) { commands.push({ target, method, params }); return method === "Page.enable" ? d.promise : Promise.resolve({}); };
  const controller = f.install(), initial = controller.snapshot();
  const enabling = f.api.debugger.sendCommand({ tabId: 17 }, "Page.enable");
  f.events["tabs.onCreated"].emit({ id: 17, active: false });
  f.events["debugger.onEvent"].emit({ tabId: 17 }, "Page.frameNavigated", { frame: { id: "root", url: "http://fixture/task" } });
  f.events["debugger.onEvent"].emit({ tabId: 17, sessionId: "child" }, "Runtime.executionContextCreated", { context: { id: 6 } });
  f.events["debugger.onEvent"].emit({ tabId: 17 }, "Target.attachedToTarget", { sessionId: "child", targetInfo: { type: "iframe" } });
  f.events["debugger.onEvent"].emit({ tabId: 17 }, "Network.dataReceived", { dataLength: 12 });
  await f.api.debugger.sendCommand({ tabId: 17, sessionId: "child" }, "Page.navigate", { url: "http://fixture/task" });
  f.events["debugger.onDetach"].emit({ tabId: 17 }, "target_closed");
  const final = controller.snapshot();
  assert.deepEqual(final.records.map(value => value.sequence), Array.from({ length: 8 }, (_, i) => i));
  assert.equal(final.records[3].method, "Runtime.executionContextCreated"); assert.equal(final.records[3].target.sessionId, "child");
  assert.equal(final.records[5].method, "Page.navigate"); assert.equal(final.records[7].reason, "target_closed");
  assert.equal(final.records.some(value => value.method === "Network.dataReceived"), false);
  assert.equal(final.pending[0].method, "Page.enable"); assert.equal(nativeDiagnosticTraceComplete(initial, final), true);
  d.resolve({}); await enabling; assert.equal(commands.length, 2);
});

test("clock and serialization failures cannot prevent or change the actual API result", async () => {
  const f = fixture({ clock: () => { throw new Error("clock failure"); } }), value = { real: true }, promise = Promise.resolve(value); let calls = 0;
  const argument = new Proxy({}, { ownKeys() { throw new Error("unreadable log payload"); } });
  f.api.debugger.sendCommand = (target, method, params) => { calls++; assert.equal(params, argument); return promise; };
  const controller = f.install(), initial = controller.snapshot();
  const result = f.api.debugger.sendCommand({ tabId: 2 }, "Runtime.evaluate", argument);
  assert.equal(result, promise); assert.equal(await result, value); assert.equal(calls, 1);
  const final = controller.snapshot(); assert.ok(final.recordingErrors > 0); assert.equal(nativeDiagnosticTraceComplete(initial, final), false);
});

test("bounded payload excerpts never invoke accessors or expand sparse arrays/prototype keys", async () => {
  const f = fixture(), controller = f.install(), initial = controller.snapshot(); let getterCalls = 0;
  const params = JSON.parse('{"__proto__":{"poisoned":true}}');
  params.text = "x".repeat(1000000); params.sparse = []; params.sparse[1000000] = "tail";
  Object.defineProperty(params, "secret", { enumerable: true, get() { getterCalls++; throw new Error("must not invoke getter"); } });
  await f.api.debugger.sendCommand({ tabId: 2 }, "Runtime.evaluate", params);
  const final = controller.snapshot(), copy = final.records[0].args[2];
  assert.equal(getterCalls, 0); assert.equal(copy.text.diagnosticTruncated, true); assert.equal(copy.text.length, 1000000);
  assert.equal(copy.secret.diagnosticType, "accessor-not-read"); assert.equal(copy.sparse.length, 25);
  assert.equal(Object.hasOwn(copy, "__proto__"), true); assert.equal({}.poisoned, undefined);
  assert.ok(JSON.stringify(final).length < 15000); assert.ok(final.payloadTruncations > 0);
  assert.equal(nativeDiagnosticTraceComplete(initial, final), true, "The trace covers calls; marked omitted payload values are not completeness claims");
});

test("bounded trace overflow is explicit and cannot count as complete diagnostic collection", async () => {
  const f = fixture({ maximumRecords: 2 }), controller = f.install(), initial = controller.snapshot();
  await f.api.tabs.create({ active: false }); await f.api.tabs.group({ tabIds: [1] });
  const final = controller.snapshot(); assert.equal(final.records.length, 2); assert.equal(final.nextSequence, 4); assert.equal(final.dropped, 2); assert.equal(final.overflow, true);
  assert.equal(nativeDiagnosticTraceComplete(initial, final), false);
});

test("total character budget stops retention independently of count and oversized record data stays marked", async () => {
  const f = fixture({ maximumTraceCharacters: 400 }), controller = f.install(), initial = controller.snapshot();
  await f.api.debugger.sendCommand({ tabId: 7 }, "Runtime.evaluate", { expression: "x".repeat(1000) });
  const final = controller.snapshot(); assert.equal(final.overflow, true); assert.ok(final.retainedCharacters <= 400);
  assert.ok(final.records.length < final.maximumRecords); assert.equal(nativeDiagnosticTraceComplete(initial, final), false);
  const other = fixture(), trace = other.install(), before = trace.snapshot();
  const deep = {}; for (let i = 0; i < 24; i++) deep["long-property-".repeat(9) + i] = Array.from({ length: 24 }, () => ({ text: "x".repeat(512) }));
  await other.api.debugger.sendCommand({ tabId: 8 }, "Runtime.evaluate", deep);
  const after = trace.snapshot(); assert.ok(after.payloadTruncations > 0);
  assert.ok(after.records.every(record => JSON.stringify(record).length <= after.maximumRecordCharacters));
  assert.equal(nativeDiagnosticTraceComplete(before, after), true);
});

test("callback-style return is not adapted or replayed and marks unknown settlement", () => {
  const f = fixture(); let received, calls = 0;
  f.api.tabs.create = function (...args) { calls++; received = args; return undefined; };
  const controller = f.install(), initial = controller.snapshot(), callback = () => {}, args = { active: false };
  assert.equal(f.api.tabs.create(args, callback), undefined); assert.equal(calls, 1);
  assert.equal(received[0], args); assert.equal(received[1], callback);
  const final = controller.snapshot(); assert.equal(final.unknownSettlements, 1); assert.equal(final.records[1].kind, "settlement-unobserved");
  assert.equal(nativeDiagnosticTraceComplete(initial, final), false);
});

test("missing listeners/install failure fail closed, and duplicate installation never double-wraps", async () => {
  const f = fixture(); delete f.api.debugger.onEvent;
  const controller = f.install(), wrapper = f.api.tabs.create, initial = controller.snapshot();
  assert.equal(initial.installErrors[0].event, "debugger.onEvent");
  assert.equal(f.install(), controller); assert.equal(f.api.tabs.create, wrapper);
  await f.api.tabs.create({ active: false }); assert.equal(f.calls.length, 1);
  assert.equal(controller.snapshot().duplicateInstallations, 1); assert.equal(nativeDiagnosticTraceComplete(initial, controller.snapshot()), false);
});

test("restore removes only this observer and returns original API functions", async () => {
  const f = fixture(), outside = () => {}; f.events["tabs.onCreated"].addListener(outside);
  const controller = f.install(); await f.api.tabs.group({ tabIds: [4] });
  controller.restore();
  for (const [name, original] of Object.entries(f.originals)) { const [namespace, method] = name.split("."); assert.equal(f.api[namespace][method], original); }
  assert.deepEqual([...f.events["tabs.onCreated"].listeners], [outside]);
  assert.equal(f.events["debugger.onEvent"].listeners.size, 0);
  const length = controller.snapshot().records.length; await f.api.tabs.create({ active: false }); assert.equal(controller.snapshot().records.length, length);
});

test("serialized worker prelude is self-contained and startup continues even when the observer cannot install", async () => {
  const f = fixture(), context = { chrome: f.api, crypto: f.target.crypto };
  vm.runInNewContext(nativeDiagnosticPrelude() + "globalThis.productionBodyReached = true;", context);
  assert.equal(context.productionBodyReached, true); assert.equal(context.__obuNativeAPIDiagnostics.snapshot().apis.length, 7);
  await f.api.debugger.sendCommand({ tabId: 7 }, "Input.insertText", { text: "note" });
  assert.equal(context.__obuNativeAPIDiagnostics.snapshot().records.at(-1).kind, "settled");
  const broken = { chrome: f.api, __obuNativeAPIDiagnostics: null };
  vm.runInNewContext(nativeDiagnosticPrelude() + "globalThis.productionBodyReached = true;", broken);
  assert.equal(broken.productionBodyReached, true); assert.equal(broken.__obuNativeAPIDiagnostics, null);
});

test("trace completeness rejects worker replacement, missing/reordered evidence and falsified pending settlement", async () => {
  const f = fixture(), controller = f.install(), initial = controller.snapshot();
  await f.api.debugger.sendCommand({ tabId: 7 }, "Page.navigate", { url: "http://fixture/task" });
  const final = controller.snapshot(); assert.equal(nativeDiagnosticTraceComplete(initial, final), true);
  for (const mutate of [value => value.bootId = "different-worker", value => value.records.shift(), value => value.records[1].callId = 2, value => value.pending.push({ callId: 1, startSequence: 0, api: "debugger.sendCommand" }), value => value.records[1].target.tabId = 8, value => value.apis.pop()]) {
    const altered = structuredClone(final); mutate(altered); assert.equal(nativeDiagnosticTraceComplete(initial, altered), false);
  }
  const laterInitial = structuredClone(final); laterInitial.records[0].args[2].url = "http://different/";
  assert.equal(nativeDiagnosticTraceComplete(laterInitial, final), false);
  const wrongAPI = structuredClone(final); wrongAPI.apis[0] = "tabs.update"; assert.equal(nativeDiagnosticTraceComplete(initial, wrongAPI), false);
  const g = fixture(), d = deferred(); g.api.debugger.sendCommand = () => d.promise;
  const pendingController = g.install(), pendingInitial = pendingController.snapshot();
  const result = g.api.debugger.sendCommand({ tabId: 7 }, "Page.enable"), pending = pendingController.snapshot();
  pending.pending[0].method = "Page.navigate"; assert.equal(nativeDiagnosticTraceComplete(pendingInitial, pending), false);
  d.resolve({}); await result;
});

test("diagnostic mode is explicit, completion is not acceptance, and strict actual cleanup remains mandatory", () => {
  for (const value of [undefined, "", "0"]) assert.equal(nativeDiagnosticsEnabled(value), false);
  assert.equal(nativeDiagnosticsEnabled("1"), true); for (const value of ["yes", "true", "2", 1]) assert.throws(() => nativeDiagnosticsEnabled(value));
  const complete = { enabled: true, acceptancePassed: true, taskReached: true, traceComplete: true, cleanupComplete: true };
  assert.deepEqual(nativeDiagnosticResult(complete), { passed: false, diagnosticCompleted: true, exitCode: 0 });
  assert.deepEqual(nativeDiagnosticResult({ ...complete, acceptancePassed: false }), { passed: false, diagnosticCompleted: true, exitCode: 0 });
  for (const field of ["taskReached", "traceComplete", "cleanupComplete"]) assert.deepEqual(nativeDiagnosticResult({ ...complete, [field]: false }), { passed: false, diagnosticCompleted: false, exitCode: 1 });
  assert.deepEqual(nativeDiagnosticResult({ enabled: false, acceptancePassed: true }), { passed: true, exitCode: 0 });
  assert.deepEqual(nativeDiagnosticResult({ enabled: false, acceptancePassed: false }), { passed: false, exitCode: 1 });
  const report = { identity: { passed: true }, discovery: { passed: true }, task: { passed: true }, focus: { passed: true }, finalInventory: { passed: true }, eof: { result: { exitCode: 0, exactHandle: true } }, browserExit: { result: { exitCode: 0, exactHandle: true } }, launcherExit: { code: 0, signal: null }, cleanup: { browserProcessesGone: true, nativeProcessesGone: true, endpointUnreachable: true, descriptorsClean: true, fixedRegistrationUnchanged: true, registration: { removed: true }, errors: [] } };
  assert.equal(nativeBrowserInstallationCleaned(report), true); assert.equal(nativeBrowserInstallationPassed(report), true);
  assert.equal(nativeBrowserInstallationPassed({ ...report, mode: "native-api-diagnostic" }), false);
  assert.equal(nativeBrowserInstallationCleaned({ ...report, error: "original task failed", task: { passed: false } }), true);
  for (const value of [{ ...report, browserExit: { result: { exitCode: 1, exactHandle: true } } }, { ...report, cleanup: { ...report.cleanup, forced: true } }, { ...report, cleanup: { ...report.cleanup, registration: { removed: false } } }]) assert.equal(nativeBrowserInstallationCleaned(value), false);
});
