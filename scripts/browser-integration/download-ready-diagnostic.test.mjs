import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createContext, runInContext, runInNewContext } from "node:vm";
import { installChooserDiagnostic, chooserTraceComplete } from "./chooser-ready-diagnostic.mjs";
import { downloadDiagnosticCases, downloadDiagnosticEnabled, downloadDocumentObservation, downloadNativeObservation, createDownloadDiagnostic } from "./download-ready-diagnostic.mjs";
import { checkDownloadReady } from "./download-waits-fixture.mjs";

const tick = async () => { await Promise.resolve(); await Promise.resolve(); };
function native(sendCommand = () => Promise.resolve({})) {
  const listeners = new Set(), target = { crypto: { randomUUID } };
  const api = {
    debugger: { sendCommand, onEvent: { addListener: value => listeners.add(value), removeListener: value => listeners.delete(value) } },
    tabs: { get: async id => ({ id, windowId: 4, active: false, status: "complete", url: "http://fixture/page" }) },
    windows: { getAll: async () => [{ id: 4, focused: true, state: "normal" }], getCurrent: async () => ({ id: 4, focused: true }) },
    webNavigation: { getAllFrames: async () => [{ frameId: 0, parentFrameId: -1, url: "http://fixture/page" }] }
  };
  return { api, target, listeners, event: (...args) => [...listeners].forEach(fn => fn(...args)) };
}
function probe(sendCommand, options = {}) {
  const value = native(sendCommand); value.installed = installChooserDiagnostic(value.api, value.target, 42, { ...options, kind: "download" });
  value.probe = value.target.__obuDownloadDiagnostic; return value;
}
const child = { tabId: 42, source: { tabId: 42 }, type: "iframe", sessionId: "child", targetId: "frame" };
const domResult = () => ({ result: { value: { truncated: false, href: "http://fixture/frame", readyState: "complete", downloadEvidence: { documentToken: "original-document", clicks: [], frameAdds: [] } } } });
function harness({ attachments = [child], request = async () => domResult(), intercept } = {}) {
  const state = native(), calls = [], expressions = [];
  const context = createContext({ chrome: state.api, crypto: { randomUUID }, __integrationFrames: attachments, Date, performance, Promise, Reflect, Object, Set, Map, JSON, Number, Error });
  const worker = { evaluate: async expression => {
    expressions.push(expression);
    const evaluate = async () => {
      const result = await runInContext(expression, context);
      return result === undefined ? undefined : JSON.parse(JSON.stringify(result));
    };
    return intercept ? intercept(expression, evaluate) : evaluate();
  } };
  const owner = { client: { sessionId: "owner", turnId: "turn", controlEpoch: 7,
    request: async (...args) => { calls.push(args); return request(...args); } } };
  let focusReads = 0;
  const diagnostic = createDownloadDiagnostic({ worker, readFocus: async () => { focusReads++; return { events: [] }; } });
  return { ...state, context, worker, owner, calls, expressions, diagnostic, item: { tabId: 42, variant: "dynamic-oopif" }, focusReads: () => focusReads };
}

test("download diagnostic is disabled by default and exclusive with every main special mode", () => {
  assert.equal(downloadDiagnosticEnabled({}), false); assert.equal(downloadDiagnosticEnabled({ OBU_TEST_DOWNLOAD_DIAGNOSTIC: "1" }), true);
  assert.deepEqual(downloadDiagnosticCases, ["js-page-download-ready-two-connections", "js-raw-navigation-before-engine"]);
  for (const value of ["0", "", "true"]) assert.throws(() => downloadDiagnosticEnabled({ OBU_TEST_DOWNLOAD_DIAGNOSTIC: value }));
  for (const flag of ["OBU_TEST_CASES", "OBU_TEST_CHOOSER_DIAGNOSTIC", "OBU_TEST_MCP_BINDING", "OBU_TEST_GEOMETRY_DPR", "OBU_TEST_SNAPSHOT_GEOMETRY", "OBU_TEST_BACKGROUND_PARALLEL", "OBU_TEST_MEMORY_CLIPBOARD"])
    assert.throws(() => downloadDiagnosticEnabled({ OBU_TEST_DOWNLOAD_DIAGNOSTIC: "1", [flag]: "1" }));
});

test("download probe preserves exact receiver, arguments and cross-realm Promise with shared command/event ordering", async () => {
  let observed; const promise = runInNewContext("Promise.resolve({native:true})");
  const state = probe(function (...args) { observed = { receiver: this, args }; return promise; });
  const receiver = {}, target = { tabId: 42, sessionId: "child" }, params = { type: "mousePressed", x: 21, y: 31 };
  assert.equal(Reflect.apply(state.api.debugger.sendCommand, receiver, [target, "Input.dispatchMouseEvent", params]), promise);
  assert.equal(observed.receiver, receiver); assert.equal(observed.args[0], target); assert.equal(observed.args[2], params);
  state.event({ tabId: 42, sessionId: "child" }, "Page.downloadWillBegin", { guid: "real-event", url: "http://fixture/file" });
  params.x = 999; await promise; await tick();
  const trace = state.probe.restore();
  assert.equal(trace.kind, "download"); assert.deepEqual(trace.records.map(item => item.kind), ["start", "event", "settled"]);
  assert.equal(trace.records[0].params.x, 21); assert.equal(chooserTraceComplete(trace), true); assert.equal(state.listeners.size, 0);
});

test("original sync error and async rejection identity survive; failed native action can be completely observed", async () => {
  const error = new Error("native fault"), sync = probe(() => { throw error; });
  assert.throws(() => sync.api.debugger.sendCommand({ tabId: 42 }, "Page.enable"), value => value === error);
  assert.equal(chooserTraceComplete(sync.probe.restore()), true);
  const promise = Promise.reject(error), asyncState = probe(() => promise);
  assert.equal(asyncState.api.debugger.sendCommand({ tabId: 42 }, "Input.insertText", {}), promise);
  await assert.rejects(promise, value => value === error); await tick();
  assert.equal(chooserTraceComplete(asyncState.probe.restore()), true);
});

test("probe records only exact-tab download setup/input and frame/download events; getters remain unread", async () => {
  let calls = 0; const state = probe(() => { calls++; return Promise.resolve({}); });
  for (const method of ["Page.enable", "Page.disable", "Input.dispatchMouseEvent", "Runtime.runIfWaitingForDebugger"])
    await state.api.debugger.sendCommand({ tabId: 42 }, method, {});
  for (const method of ["Page.setInterceptFileChooserDialog", "Runtime.evaluate", "DOM.focus", "Page.enableOther"])
    await state.api.debugger.sendCommand({ tabId: 42 }, method, {});
  await state.api.debugger.sendCommand({ tabId: 99 }, "Page.enable", {});
  await state.api.debugger.sendCommand({ get tabId() { throw new Error("getter must not run"); } }, "Page.enable");
  for (const method of ["Page.frameAttached", "Page.frameNavigated", "Page.frameDetached", "Target.attachedToTarget", "Target.detachedFromTarget", "Page.downloadWillBegin", "Page.downloadProgress"])
    state.event({ tabId: 42 }, method, {});
  state.event({ tabId: 99 }, "Page.downloadWillBegin", {}); state.event({ tabId: 42 }, "Page.fileChooserOpened", {});
  await tick(); const trace = state.probe.restore();
  assert.equal(calls, 10); assert.equal(trace.records.length, 15); assert.equal(chooserTraceComplete(trace), true);
});

test("overflow, truncation, pending ACK and unobservable callback settlement cannot be complete", async () => {
  const capacity = probe(undefined, { maximumRecords: 1 }); await capacity.api.debugger.sendCommand({ tabId: 42 }, "Page.enable", {}); await tick();
  assert.equal(chooserTraceComplete(capacity.probe.restore()), false);
  const large = probe(); await large.api.debugger.sendCommand({ tabId: 42 }, "Input.insertText", { text: "x".repeat(3000) }); await tick();
  assert.equal(chooserTraceComplete(large.probe.restore()), false);
  const callback = probe(() => undefined); callback.api.debugger.sendCommand({ tabId: 42 }, "Page.enable");
  assert.equal(chooserTraceComplete(callback.probe.restore()), false);
  let resolve; const pending = probe(() => new Promise(done => { resolve = done; }));
  pending.api.debugger.sendCommand({ tabId: 42 }, "Page.enable"); assert.equal(chooserTraceComplete(pending.probe.snapshot()), false);
  resolve({}); await tick(); assert.equal(chooserTraceComplete(pending.probe.restore()), true);
});

test("failure reads original scope and exact observed child once, with native root point never projected to child", async () => {
  const state = harness(); await state.diagnostic.start(state);
  await state.api.debugger.sendCommand({ tabId: 42 }, "Input.dispatchMouseEvent", { type: "mousePressed", x: 123, y: 234 }); await tick();
  state.owner.client.turnId = "later-turn"; state.item.tabId = 99;
  await state.diagnostic.failure(state); await state.diagnostic.failure(state); await state.diagnostic.finish(state); await state.diagnostic.finish(state);
  assert.equal(state.calls.length, 2); assert.deepEqual(state.calls.map(([, params]) => params.target), [{ tabId: 42 }, { tabId: 42, sessionId: "child" }]);
  for (const [method, params, options] of state.calls) {
    assert.equal(method, "executeCdp"); assert.equal(params.method, "Runtime.evaluate"); assert.equal(params.turn_id, "turn"); assert.equal(params.control_epoch, 7);
    assert.equal(params.commandParams.awaitPromise, false); assert.equal(params.timeoutMs, options.timeoutMs); assert.ok(params.timeoutMs <= 3000); assert.equal(params.waiterId, undefined);
  }
  assert.match(state.calls[0][1].commandParams.expression, /"x":123,"y":234/); assert.match(state.calls[1][1].commandParams.expression, /\}\)\(null\)$/);
  assert.equal(state.item.diagnostic.collectionComplete, true); assert.equal(state.item.diagnostic.acceptancePassed, false);
  assert.equal(state.context.__obuDownloadDiagnostic, undefined); assert.equal(state.listeners.size, 0);
});

test("ambiguous or detached child does not route by URL and yields incomplete observation", async () => {
  for (const detached of [false, true]) {
    const state = harness({ attachments: detached ? [child] : [child, { ...child, sessionId: "other", targetId: "other-frame" }] });
    await state.diagnostic.start(state);
    if (detached) state.event({ tabId: 42 }, "Target.detachedFromTarget", { sessionId: "child" });
    await state.diagnostic.failure(state); await state.diagnostic.finish(state);
    assert.equal(state.calls.length, 1); assert.equal(state.item.diagnostic.failureRead.child.target, null);
    assert.equal(state.item.diagnostic.traceComplete, true); assert.equal(state.item.diagnostic.observationComplete, false);
  }
});

test("current DOM capture is bounded and read-only; child center is labeled later, empty evidence is valid observation", () => {
  const hits = [], rectangle = { x: 10, y: 20, width: 80, height: 40 };
  const link = { tagName: "A", id: "download", href: "http://fixture/file", getAttribute: name => name === "href" ? "/file" : "", getBoundingClientRect: () => rectangle };
  const context = { document: { querySelector: selector => selector === "#download" ? link : null, querySelectorAll: () => [], activeElement: null,
    hasFocus: () => false, readyState: "complete", visibilityState: "visible", elementFromPoint: (x, y) => { hits.push([x, y]); return link; } },
    location: { href: "http://fixture/frame" }, downloadEvidence: { documentToken: "original", clicks: [], frameAdds: [] },
    innerWidth: 620, innerHeight: 260, scrollX: 0, scrollY: 0, devicePixelRatio: 1.5 };
  const result = runInNewContext(`(${downloadDocumentObservation.toString()})(null)`, context);
  assert.equal(result.nativeRootHit, null); assert.equal(result.link.href, "http://fixture/file"); assert.deepEqual(hits, [[50, 40]]);
  assert.equal(result.downloadEvidence.clicks.length, 0); assert.equal(result.truncated, false); assert.match(result.boundary, /later child-viewport/);
  context.downloadEvidence.clicks = Array.from({ length: 30 }, () => ({ trusted: true, sequence: 1 }));
  const bounded = runInNewContext(`(${downloadDocumentObservation.toString()})({x:1,y:2})`, context);
  assert.equal(bounded.downloadEvidence.clicks.length, 16); assert.equal(bounded.truncated, true);
});

test("native metadata is bounded without adding mutation or serial delayed API calls", async () => {
  const state = native(); state.api.windows.getAll = async () => Array.from({ length: 70 }, (_, id) => ({ id }));
  const value = await downloadNativeObservation(state.api, 42);
  assert.equal(value.overflow, true); assert.equal(value.windows.value.total, 70); assert.equal(value.windows.value.entries.length, 64);
  assert.equal(value.tab.value.id, 42);
});

test("one failure budget prohibits child after late root and DOM after late native metadata", async t => {
  let clock = 1000; t.mock.method(Date, "now", () => clock);
  for (const late of ["root", "native"]) {
    const state = harness({ request: async () => { clock += 3001; return domResult(); }, intercept: async (expression, evaluate) => {
      const result = await evaluate(); if (late === "native" && expression.startsWith("(async function downloadNativeObservation")) clock += 3001; return result;
    } });
    await state.diagnostic.start(state); await state.diagnostic.failure(state); await state.diagnostic.finish(state);
    assert.equal(state.calls.length, late === "root" ? 1 : 0); assert.equal(state.focusReads(), late === "root" ? 1 : 0);
    assert.equal(state.item.diagnostic.collectionComplete, false); assert.equal(state.item.diagnostic.traceComplete, true);
  }
});

test("setup shares 1.5s budget and a late installation expression cannot install after expiry", async t => {
  let clock = 1000; t.mock.method(Date, "now", () => clock);
  const state = harness({ intercept: async (expression, evaluate) => {
    if (expression.includes("const snapshot=")) clock += 1501;
    return evaluate();
  } });
  await assert.rejects(state.diagnostic.start(state), /setup deadline expired in worker/);
  await state.diagnostic.finish(state);
  assert.equal(state.context.__obuDownloadDiagnostic, undefined); assert.equal(state.listeners.size, 0);
  assert.equal(state.item.diagnostic.collectionComplete, false); assert.ok(state.item.diagnostic.setupError);
});

test("installation ACK loss restores only this setup; pre-existing foreign probe is left intact", async () => {
  const error = new Error("install ACK lost"), state = harness({ intercept: async (expression, evaluate) => {
    const result = await evaluate(); if (expression.includes("const snapshot=")) throw error; return result;
  } });
  await assert.rejects(state.diagnostic.start(state), caught => caught === error);
  assert.ok(state.context.__obuDownloadDiagnostic); await state.diagnostic.finish(state);
  assert.equal(state.context.__obuDownloadDiagnostic, undefined); assert.equal(state.item.diagnostic.collectionComplete, false);
  const foreign = harness(); installChooserDiagnostic(foreign.api, foreign.context, 42, { kind: "download" });
  const old = foreign.context.__obuDownloadDiagnostic;
  await assert.rejects(foreign.diagnostic.start(foreign)); await foreign.diagnostic.finish(foreign);
  assert.equal(foreign.context.__obuDownloadDiagnostic, old); assert.equal(old.snapshot().restored, false); old.restore();
});

test("worker replacement, revoked scope and DOM exception stay incomplete without replacing a business error", async () => {
  for (const kind of ["worker", "scope", "exception", "truncated"]) {
    const state = harness({ request: async () => {
      if (kind === "scope") throw new Error("OBU_STALE_CONTROL_EPOCH");
      if (kind === "exception") return { exceptionDetails: { text: "DOM read failed" } };
      const value = domResult(); if (kind === "truncated") value.result.value.truncated = true; return value;
    } });
    await state.diagnostic.start(state);
    if (kind === "worker") await state.worker.evaluate("globalThis.__obuDownloadDiagnostic.restore(); delete globalThis.__obuDownloadDiagnostic");
    await state.diagnostic.failure(state); await state.diagnostic.finish(state);
    assert.equal(state.item.diagnostic.collectionComplete, false, kind); assert.equal(state.item.diagnostic.acceptancePassed, false);
  }
});

test("a probe restored before finish cannot masquerade as continuous collection", async () => {
  for (const failed of [false, true]) {
    const state = harness(); await state.diagnostic.start(state);
    await state.worker.evaluate("globalThis.__obuDownloadDiagnostic.restore()");
    if (failed) await state.diagnostic.failure(state);
    await state.diagnostic.finish(state);
    assert.equal(state.item.diagnostic.trace.restoredBeforeFinish, true);
    assert.equal(state.item.diagnostic.collectionComplete, false);
    assert.equal(state.context.__obuDownloadDiagnostic, undefined);
  }
});

test("a permanently pending DOM read ends at the actual shared 3s budget without another target send", async () => {
  const state = harness({ request: () => new Promise(() => {}) }); await state.diagnostic.start(state);
  const started = performance.now(); await state.diagnostic.failure(state);
  assert.ok(performance.now() - started < 4500); assert.equal(state.calls.length, 1);
  await state.diagnostic.finish(state); assert.equal(state.item.diagnostic.collectionComplete, false); assert.equal(state.listeners.size, 0);
});

test("original download error survives diagnostic/cancel failures with single original click and cleanup", async () => {
  const original = new Error("original download timeout"), order = [];
  const wait = { waiterId: "waiter", remainingMs: 10000, result: async () => { order.push("collect"); throw original; }, cancel: async () => { order.push("cancel"); throw new Error("cleanup failed"); } };
  const owner = { client: { getInfo: async () => ({ metadata: { downloadWaitVersion: 1 } }) }, newTab: async () => ({ id: 42, expectDownload: async () => wait }), cdp: { navigate: async () => {} } };
  const trigger = { tab: () => ({ getByRole: () => ({ click: async () => { order.push("click"); } }) }) };
  const diagnostic = { start: async ({ item }) => { item.diagnostic = {}; }, failure: async () => { order.push("observe"); throw new Error("diagnostic failed"); }, finish: async () => { order.push("finish"); throw new Error("restore failed"); } };
  await assert.rejects(checkDownloadReady({ owner, trigger, diagnostic, fixtureURL: "http://fixture/", prefix: "unit" }), error => {
    assert.equal(error, original); const item = error.downloadDetail.variants[0];
    assert.match(item.cancelError, /cleanup failed/); assert.match(item.diagnosticFailureError, /diagnostic failed/); assert.match(item.diagnosticFinishError, /restore failed/);
    return true;
  });
  assert.deepEqual(order, ["click", "collect", "observe", "cancel", "finish"]);
});
