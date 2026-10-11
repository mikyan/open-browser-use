import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { runInNewContext } from "node:vm";
import { readFileSync } from "node:fs";
import { chooserDiagnosticCases, chooserDiagnosticEnabled, installChooserDiagnostic, chooserTraceComplete, chooserChildTarget, createChooserDiagnostic, chooserDocumentObservation, chooserNativeObservation, chooserPointerEvidenceComplete } from "./chooser-ready-diagnostic.mjs";
import { checkChooserReady, installChooserPointerEvidence } from "./chooser-waits-fixture.mjs";

function setup(sendCommand = function () { return Promise.resolve({}); }, options) {
  const listeners = new Set(), target = { crypto: { randomUUID } };
  const api = { debugger: { sendCommand, onEvent: { addListener: listener => listeners.add(listener), removeListener: listener => listeners.delete(listener) } } };
  const installed = installChooserDiagnostic(api, target, 42, options);
  return { api, target, installed, listeners, probe: target.__obuChooserDiagnostic, event: (...args) => [...listeners].forEach(fn => fn(...args)) };
}
const tick = async () => { await Promise.resolve(); await Promise.resolve(); };

test("chooser opt-in is exclusive and selects the original case plus mandatory raw control", () => {
  assert.equal(chooserDiagnosticEnabled({}), false);
  assert.equal(chooserDiagnosticEnabled({ OBU_TEST_CHOOSER_DIAGNOSTIC: "1" }), true);
  assert.deepEqual(chooserDiagnosticCases, ["js-file-chooser-ready-two-connections", "js-raw-navigation-before-engine"]);
  for (const value of ["0", "", "true"]) assert.throws(() => chooserDiagnosticEnabled({ OBU_TEST_CHOOSER_DIAGNOSTIC: value }));
  for (const key of ["OBU_TEST_CASES", "OBU_TEST_SNAPSHOT_GEOMETRY", "OBU_TEST_BACKGROUND_PARALLEL", "OBU_TEST_MEMORY_CLIPBOARD"])
    assert.throws(() => chooserDiagnosticEnabled({ OBU_TEST_CHOOSER_DIAGNOSTIC: "1", [key]: "1" }));
});

test("native Promise identity, receiver, args and cross-realm settlement survive shared command/event sequencing", async () => {
  let observed; const result = runInNewContext("Promise.resolve({answer: 7})");
  const state = setup(function (...args) { observed = { receiver: this, args }; return result; });
  const nativeTarget = { tabId: 42, sessionId: "child" }, params = { enabled: true }, receiver = { testReceiver: true };
  assert.equal(Reflect.apply(state.api.debugger.sendCommand, receiver, [nativeTarget, "Page.setInterceptFileChooserDialog", params]), result);
  assert.equal(observed.receiver, receiver); assert.equal(observed.args[0], nativeTarget); assert.equal(observed.args[2], params);
  state.event({ tabId: 42, sessionId: "child" }, "Page.fileChooserOpened", { frameId: "frame", backendNodeId: 9 });
  params.enabled = false; await result; await tick();
  const trace = state.probe.restore();
  assert.deepEqual(trace.records.map(record => [record.sequence, record.kind]), [[0, "start"], [1, "event"], [2, "settled"]]);
  assert.equal(trace.records[0].params.enabled, true); assert.equal(trace.records[2].result.answer, 7);
  assert.equal(chooserTraceComplete(trace), true); assert.equal(state.listeners.size, 0);
});

test("sync thrown and async rejected errors retain identity; failed native operations still have complete evidence", async () => {
  const error = new Error("native failure");
  const sync = setup(() => { throw error; });
  assert.throws(() => sync.api.debugger.sendCommand({ tabId: 42 }, "Input.dispatchMouseEvent", {}), value => value === error);
  assert.equal(chooserTraceComplete(sync.probe.restore()), true);
  const promise = Promise.reject(error), asyncState = setup(() => promise);
  assert.equal(asyncState.api.debugger.sendCommand({ tabId: 42 }, "Page.disable", {}), promise);
  await assert.rejects(promise, value => value === error); await tick();
  const trace = asyncState.probe.restore(); assert.equal(trace.records[1].kind, "error"); assert.equal(chooserTraceComplete(trace), true);
});

test("filters exact tab and finite native setup methods, leaves accessors and foreign calls untouched", async () => {
  let calls = 0; const state = setup(() => { calls++; return Promise.resolve({}); });
  for (const method of ["Page.enable", "Page.disable", "Runtime.runIfWaitingForDebugger", "Input.dispatchMouseEvent"])
    await state.api.debugger.sendCommand({ tabId: 42 }, method, {});
  for (const method of ["Page.enableOther", "Runtime.evaluate", "DOM.focus", "Page.navigate"])
    await state.api.debugger.sendCommand({ tabId: 42 }, method, {});
  await state.api.debugger.sendCommand({ tabId: 43 }, "Page.disable", {});
  await state.api.debugger.sendCommand({ get tabId() { throw new Error("Do not read getter"); } }, "Page.enable", {});
  state.event({ tabId: 43 }, "Page.fileChooserOpened", {});
  state.event({ tabId: 42 }, "Runtime.consoleAPICalled", {});
  await tick(); const trace = state.probe.restore();
  assert.equal(calls, 10); assert.equal(trace.records.length, 8); assert.equal(chooserTraceComplete(trace), true);
});

test("bounded records/payloads, unknown settlement and held ACK cannot appear complete", async () => {
  const overflow = setup(undefined, { maximumRecords: 1 }); await overflow.api.debugger.sendCommand({ tabId: 42 }, "Page.enable", {}); await tick();
  assert.equal(chooserTraceComplete(overflow.probe.restore()), false);
  const huge = setup(); await huge.api.debugger.sendCommand({ tabId: 42 }, "Input.insertText", { text: "x".repeat(3000) }); await tick();
  assert.ok(huge.probe.snapshot().truncations > 0); assert.equal(chooserTraceComplete(huge.probe.restore()), false);
  const callback = setup(() => 123); assert.equal(callback.api.debugger.sendCommand({ tabId: 42 }, "Page.enable", {}), 123);
  assert.equal(chooserTraceComplete(callback.probe.restore()), false);
  let release; const pending = setup(() => new Promise(resolve => { release = resolve; }));
  pending.api.debugger.sendCommand({ tabId: 42 }, "Page.enable", {});
  assert.equal(chooserTraceComplete(pending.probe.snapshot()), false);
  release({}); await tick(); assert.equal(chooserTraceComplete(pending.probe.restore()), true);
});

test("unwritable API installation fails, replacement is never overwritten, serialized function has no module dependencies", () => {
  const original = () => Promise.resolve({}), api = { debugger: { onEvent: { addListener() {} } } };
  Object.defineProperty(api.debugger, "sendCommand", { value: original, writable: false });
  assert.throws(() => installChooserDiagnostic(api, { crypto: { randomUUID } }, 42)); assert.equal(api.debugger.sendCommand, original);
  const state = setup(); const foreign = () => Promise.resolve({}); state.api.debugger.sendCommand = foreign;
  const trace = state.probe.restore(); assert.equal(trace.restored, false); assert.equal(state.api.debugger.sendCommand, foreign); assert.equal(chooserTraceComplete(trace), false);
  const standalone = runInNewContext(`(${installChooserDiagnostic.toString()})`, { performance, Date, Promise, Reflect, Object, Set, Map, JSON, Number, Error });
  const another = { debugger: { sendCommand: original, onEvent: { addListener() {}, removeListener() {} } } }, target = { crypto: { randomUUID } };
  standalone(another, target, 4); assert.equal(target.__obuChooserDiagnostic.restore().restored, true);
});

test("child routing requires a unique observed attachment and removes detached sessions, never selects by URL", () => {
  const trace = { tabId: 42, records: [] };
  const child = { tabId: 42, source: { tabId: 42 }, type: "iframe", sessionId: "one", targetId: "frame" };
  assert.deepEqual(chooserChildTarget(trace, [child]).target, { tabId: 42, sessionId: "one" });
  assert.equal(chooserChildTarget(trace, [child, { ...child, sessionId: "two" }]).target, null);
  trace.records.push({ kind: "event", source: { tabId: 42 }, method: "Target.detachedFromTarget", params: { sessionId: "one" } });
  assert.equal(chooserChildTarget(trace, [child]).target, null);
});

test("failure capture uses original scope and raw executeCdp once per observed target, without extending waiter or attaching", async () => {
  const state = setup(), calls = [], reads = [];
  const owner = { client: { sessionId: "session", turnId: "turn", controlEpoch: 8, request: async (...args) => { calls.push(args); return { result: { value: { chooserEvidence: { documentToken: "document" } } } }; } } };
  const worker = { evaluate: async expression => {
    reads.push(expression);
    if (expression.includes("__integrationFrames")) return [{ tabId: 42, source: { tabId: 42 }, type: "iframe", sessionId: "child", targetId: "frame" }];
    if (expression.startsWith("(function installChooserDiagnostic")) return state.installed;
    if (expression.includes("probe.restore()")) return state.probe.restore();
    if (expression.includes("?.snapshot()")) return state.probe.snapshot();
    return { tab: { value: { id: 42 } }, windows: { value: [] }, currentWindow: { value: {} }, frames: { value: [] } };
  } };
  const diagnostic = createChooserDiagnostic({ worker, readFocus: async () => ({ events: [] }) });
  const item = { tabId: 42, variant: "dynamic-oopif" };
  await diagnostic.start({ owner, item }); owner.client.turnId = "new-turn";
  await diagnostic.failure({ owner, item }); await diagnostic.failure({ owner, item }); await diagnostic.finish({ item });
  assert.equal(calls.length, 2);
  for (const [method, params, transport] of calls) {
    assert.equal(method, "executeCdp"); assert.equal(params.turn_id, "turn"); assert.equal(params.control_epoch, 8);
    assert.equal(params.method, "Runtime.evaluate"); assert.ok(params.timeoutMs <= 3000); assert.equal(transport.timeoutMs, params.timeoutMs);
    assert.equal(params.commandParams.awaitPromise, false); assert.ok(!("waiterId" in params));
  }
  assert.deepEqual(calls.map(([, params]) => params.target), [{ tabId: 42 }, { tabId: 42, sessionId: "child" }]);
  assert.match(calls[1][1].commandParams.expression, /\}\)\(null,\d+\)$/);
  assert.equal(item.diagnostic.collectionComplete, true);
});

test("one original observation deadline forbids a child send after late root, or focus/DOM after late metadata", async t => {
  let clock = 1000; t.mock.method(Date, "now", () => clock);
  for (const lateStage of ["root", "metadata"]) {
    const state = setup(), calls = []; let focusReads = 0;
    const item = { tabId: 42, variant: "dynamic-oopif", diagnostic: { installed: state.installed,
      scope: { session_id: "owner", turn_id: "turn", control_epoch: 1 },
      initialAttachments: [{ tabId: 42, source: { tabId: 42 }, type: "iframe", sessionId: "child", targetId: "frame" }] } };
    const owner = { client: { request: async (...args) => { calls.push(args); clock += 3001; return { result: { value: {} } }; } } };
    const worker = { evaluate: async expression => {
      if (expression.includes("?.snapshot()")) return state.probe.snapshot();
      if (expression.includes("probe.restore()")) return state.probe.restore();
      if (lateStage === "metadata") clock += 3001;
      return { tab: { value: {} }, windows: { value: [] }, currentWindow: { value: {} }, frames: { value: [] } };
    } };
    const diagnostic = createChooserDiagnostic({ worker, readFocus: async () => { focusReads++; return { events: [] }; } });
    await diagnostic.failure({ owner, item }); await diagnostic.finish({ item });
    assert.equal(item.diagnostic.traceComplete, true); assert.equal(item.diagnostic.observationComplete, false); assert.equal(item.diagnostic.collectionComplete, false);
    assert.equal(calls.length, lateStage === "root" ? 1 : 0); assert.equal(focusReads, lateStage === "root" ? 1 : 0);
    assert.equal(item.diagnostic.failureRead.complete, false);
  }
});

test("original task timeout survives diagnostic failure and cancellation failure, cleanup is still attempted once", async () => {
  const error = new Error("original chooser timeout"), order = [];
  const wait = { waiterId: "waiter", remainingMs: 10000, result: async () => { throw error; }, cancel: async () => { order.push("cancel"); throw new Error("cleanup failed"); } };
  const owner = { client: { getInfo: async () => ({ metadata: { fileChooserWaitVersion: 1 } }) }, newTab: async () => ({ id: 42, expectFileChooser: async () => wait }), cdp: { navigate: async () => {} } };
  const trigger = { tab: () => ({ getByLabel: () => ({ click: async () => { order.push("click"); } }) }) };
  const diagnostic = { start: async ({ item }) => { item.diagnostic = {}; }, failure: async ({ item }) => { if (!item.diagnostic.observed) { order.push("observe"); item.diagnostic.observed = true; } }, finish: async () => { order.push("restore"); } };
  await assert.rejects(checkChooserReady({ owner, trigger, diagnostic, fixtureURL: "http://127.0.0.1/", prefix: "unit", server: { stats: () => ({ posts: [] }) }, worker: { evaluate: async () => ({ events: [], overflow: false }) } }), failure => {
    assert.equal(failure, error); const item = failure.chooserDetail.variants[0];
    assert.match(item.waits[0].cancelError, /cleanup failed/); return true;
  });
  assert.deepEqual(order, ["click", "observe", "cancel", "restore"]);
});

test("lost worker and revoked scope remain explicit, are not replayed, and do not throw over original failure", async () => {
  const item = { tabId: 42, variant: "root", diagnostic: { installed: { bootId: "one" }, scope: {} } };
  const diagnostic = createChooserDiagnostic({ worker: { evaluate: async () => undefined }, readFocus: async () => ({}) });
  await diagnostic.failure({ owner: {}, item }); await diagnostic.finish({ item });
  assert.match(item.diagnostic.failureRead.errors[0].error, /incarnation/); assert.equal(item.diagnostic.collectionComplete, false);
});

test("runner keeps default case filtering and explicitly labels this diagnostic as non-acceptance", () => {
  const runner = readFileSync(new URL("./run.mjs", import.meta.url), "utf8");
  assert.match(runner, /if \(chooserDiagnostic && !chooserDiagnosticCases\.includes\(name\)\) return/);
  assert.match(runner, /mode: "chooser-ready-diagnostic", acceptancePassed: false/);
  assert.match(runner, /originalTaskPassed:/);
  const fixture = readFileSync(new URL("./chooser-waits-fixture.mjs", import.meta.url), "utf8");
  assert.ok(fixture.indexOf("await diagnostic.failure({ owner, item })") < fixture.indexOf("await wait.cancel()"));
  assert.match(fixture, /expectFileChooser\(\{ timeoutMs: 10000 \}\)/);
});

function emptyPointerEvidence() {
  const evidence = { documentToken: "original-document" };
  installChooserPointerEvidence({ addEventListener() {} }, evidence, null, null);
  return evidence;
}

test("pointer evidence requires bounded complete metadata but no delivered events or successful clicks", () => {
  assert.equal(chooserPointerEvidenceComplete(emptyPointerEvidence()), true);
  for (const mutate of [
    value => { delete value.pointerEvidence; },
    value => { delete value.pointerEvidence.recordingErrors; },
    value => { value.pointerEvidence.installed = false; },
    value => { value.pointerEvidence.dropped = 1; },
    value => { value.pointerEvidence.overflow = true; },
    value => { value.pointerEvidence.truncations = 1; },
    value => { value.pointerEvidence.recordingErrors = 1; },
    value => { value.pointerEvidence.installationErrors = 1; },
    value => { value.pointerEvidence.documentToken = "another-document"; },
    value => { value.pointerEvidence.nextSequence = 1; },
    value => { value.pointerEvidence.retainedCharacters = 1; },
    value => { value.pointerEvidence.eventTypes.pop(); }
  ]) { const evidence = emptyPointerEvidence(); mutate(evidence); assert.equal(chooserPointerEvidenceComplete(evidence), false); }
});

test("failure collection validates each requested pointer ledger; success requests no DOM evidence", async () => {
  for (const kind of ["success", "empty", "missing-child", "overflow-child", "recording-error"]) {
    const state = setup(); let domReads = 0;
    const owner = { client: { sessionId: "session", turnId: "turn", controlEpoch: 1, request: async (_method, params) => {
      domReads++; const evidence = emptyPointerEvidence();
      if (params.target.sessionId && kind === "missing-child") delete evidence.pointerEvidence;
      if (params.target.sessionId && kind === "overflow-child") evidence.pointerEvidence.overflow = true;
      if (kind === "recording-error") evidence.pointerEvidence.recordingErrors = 1;
      return { result: { value: { chooserEvidence: evidence } } };
    } } };
    const worker = { evaluate: async expression => {
      if (expression.includes("__integrationFrames")) return [{ tabId: 42, source: { tabId: 42 }, type: "iframe", sessionId: "child", targetId: "frame" }];
      if (expression.startsWith("(function installChooserDiagnostic")) return state.installed;
      if (expression.includes("probe.restore()")) return state.probe.restore();
      if (expression.includes("?.snapshot()")) return state.probe.snapshot();
      return { tab: { value: {} }, windows: { value: [] }, currentWindow: { value: {} }, frames: { value: [] } };
    } };
    const diagnostic = createChooserDiagnostic({ worker, readFocus: async () => ({ events: [] }), pointerEvidence: true });
    const item = { tabId: 42, variant: "dynamic-oopif" };
    await diagnostic.start({ owner, item });
    if (kind !== "success") await diagnostic.failure({ owner, item });
    await diagnostic.finish({ item });
    assert.equal(domReads, kind === "success" ? 0 : 2);
    assert.equal(item.diagnostic.pointerObservationRequested, kind !== "success");
    assert.equal(item.diagnostic.pointerObservationComplete, kind === "success" ? null : kind === "empty");
    assert.equal(item.diagnostic.collectionComplete, ["success", "empty"].includes(kind));
    assert.equal(item.diagnostic.traceComplete, true, "native completeness remains separate from DOM completeness");
  }
});

test("queued serialized native/DOM observations refuse all reads when the original deadline has expired", async () => {
  let nativeCalls = 0, domReads = 0;
  const chrome = { tabs: { get() { nativeCalls++; } }, windows: { getAll() { nativeCalls++; }, getCurrent() { nativeCalls++; } }, webNavigation: { getAllFrames() { nativeCalls++; } } };
  const context = { chrome, Date: { now: () => 5000 } };
  const native = runInNewContext(`(${chooserNativeObservation.toString()})(chrome,42,4000)`, context);
  await assert.rejects(native, /budget expired/);
  assert.equal(nativeCalls, 0);
  Object.defineProperty(context, "document", { get() { domReads++; throw new Error("DOM touched"); } });
  Object.defineProperty(context, "location", { get() { domReads++; throw new Error("location touched"); } });
  assert.throws(() => runInNewContext(`(${chooserDocumentObservation.toString()})(null,4000)`, context), /budget expired/);
  assert.equal(domReads, 0);
});

test("serialized native metadata drains a started rejection when the budget prevents the next API", async () => {
  let clock = 1000, calls = 0, reject;
  const chrome = { tabs: { get() { calls++; clock = 5000; return new Promise((_, no) => { reject = no; }); } },
    windows: { getAll() { calls++; }, getCurrent() { calls++; } }, webNavigation: { getAllFrames() { calls++; } } };
  const result = runInNewContext(`(${chooserNativeObservation.toString()})(chrome,42,4000)`, { chrome, Date: { now: () => clock } });
  assert.equal(calls, 1); reject(new Error("late native failure"));
  await assert.rejects(result, /budget expired/); assert.equal(calls, 1);
});
