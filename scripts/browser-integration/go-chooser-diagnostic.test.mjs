import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createContext, runInContext, runInNewContext } from "node:vm";
import { installChooserDiagnostic } from "./chooser-ready-diagnostic.mjs";
import { createGoChooserDiagnostic, goChooserNativeObservation } from "./go-chooser-diagnostic.mjs";

const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const child = { tabId: 42, source: { tabId: 42 }, sessionId: "native-child", targetId: "native-frame", type: "iframe", url: "http://localhost/frame" };
function harness({ attachments = [child], intercept, sendCommand = () => Promise.resolve({}), focus } = {}) {
  const listeners = new Set(), calls = [], expressions = [];
  const original = sendCommand;
  const api = {
    debugger: { sendCommand, onEvent: { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) } },
    tabs: { get: async id => { calls.push(["tabs.get", id]); return { id, windowId: 7, active: false, status: "complete", url: "http://127.0.0.1/page" }; } },
    windows: {
      getAll: async options => { calls.push(["windows.getAll", options]); return [{ id: 7, focused: true, state: "normal" }]; },
      getCurrent: async options => { calls.push(["windows.getCurrent", options]); return { id: 7, focused: true }; }
    },
    webNavigation: { getAllFrames: async options => { calls.push(["webNavigation.getAllFrames", options]); return [{ frameId: 0, parentFrameId: -1, processId: 1, documentId: "document", url: "http://127.0.0.1/page" }]; } }
  };
  const context = createContext({ chrome: api, crypto: { randomUUID }, __integrationFrames: attachments, Date, performance, Promise, Reflect, Object, Set, Map, JSON, Number, Error });
  const worker = { evaluate: async expression => {
    expressions.push(expression);
    const evaluate = async () => {
      const result = await runInContext(expression, context);
      return result === undefined ? undefined : JSON.parse(JSON.stringify(result));
    };
    return intercept ? intercept(expression, evaluate) : evaluate();
  } };
  let focusReads = 0;
  const diagnostic = createGoChooserDiagnostic({ worker, readFocus: async () => { focusReads++; return focus ? focus() : { identity: "continuous-observer", events: [], overflow: false }; } });
  return { api, context, original, listeners, calls, expressions, worker, diagnostic, focusReads: () => focusReads,
    item: { key: "go-chooser-dynamic-oopif", variant: "dynamic-oopif", tabId: 42 },
    event: (...args) => [...listeners].forEach(fn => fn(...args)) };
}

test("Go diagnostic observes the exact tab and original native Promise without SDK, DOM, attachment or input actions", async () => {
  let receiver, args;
  const promise = runInNewContext("Promise.resolve({native:true})");
  const state = harness({ sendCommand: function (...input) { receiver = this; args = input; return promise; } });
  await state.diagnostic.start(state);
  const target = { tabId: 42, sessionId: "native-child" }, params = { enabled: true };
  assert.equal(state.api.debugger.sendCommand(target, "Page.setInterceptFileChooserDialog", params), promise);
  assert.equal(receiver, state.api.debugger); assert.equal(args[0], target); assert.equal(args[2], params);
  state.event({ tabId: 42, sessionId: "native-child" }, "Page.fileChooserOpened", { backendNodeId: 12, frameId: "native-frame" });
  state.event({ tabId: 43 }, "Page.fileChooserOpened", {});
  await tick(); await state.diagnostic.failure(state); await state.diagnostic.failure(state);
  await state.diagnostic.finish(state); await state.diagnostic.finish(state); await state.diagnostic.cleanup();
  const value = state.item.diagnostic;
  assert.equal(state.diagnostic.records[0], value);
  assert.equal(value.collectionComplete, true); assert.equal(value.acceptancePassed, false);
  assert.equal(value.observationScope, "native-trace-and-browser-metadata"); assert.equal(value.domObservation, "not-requested");
  assert.deepEqual(value.initialAttachments, [child]);
  assert.deepEqual(value.trace.records.map(record => record.kind), ["start", "event", "settled"]);
  assert.equal(value.trace.records[1].source.sessionId, "native-child");
  assert.deepEqual(state.calls.map(([method]) => method), ["tabs.get", "windows.getAll", "windows.getCurrent", "webNavigation.getAllFrames"]);
  assert.equal(state.focusReads(), 1); assert.equal(state.api.debugger.sendCommand, state.original); assert.equal(state.listeners.size, 0);
  assert.equal(state.context.__obuChooserDiagnostic, undefined);
  assert.ok(!state.expressions.some(expression => /executeCdp|Runtime\.evaluate|document\.|\.attach\(/.test(expression)));
});

test("native sync error and rejection identities survive the shared probe and do not imply incomplete collection", async () => {
  for (const synchronous of [true, false]) {
    const originalError = new Error("native failure"), promise = Promise.reject(originalError); promise.catch(() => {});
    const state = harness({ sendCommand: () => { if (synchronous) throw originalError; return promise; } });
    await state.diagnostic.start(state);
    if (synchronous) assert.throws(() => state.api.debugger.sendCommand({ tabId: 42 }, "Page.disable", {}), error => error === originalError);
    else {
      assert.equal(state.api.debugger.sendCommand({ tabId: 42 }, "Page.disable", {}), promise);
      await assert.rejects(promise, error => error === originalError);
    }
    await tick(); await state.diagnostic.finish(state);
    assert.equal(state.item.diagnostic.collectionComplete, true);
    assert.equal(state.item.diagnostic.trace.records[1].kind, "error");
  }
});

test("pending commands, record overflow and payload truncation remain incomplete after restore", async () => {
  for (const mode of ["pending", "overflow", "payload"]) {
    let release;
    const state = harness({ sendCommand: mode === "pending" ? () => new Promise(resolve => { release = resolve; }) : undefined });
    await state.diagnostic.start(state);
    if (mode === "pending") state.api.debugger.sendCommand({ tabId: 42 }, "Page.enable", {});
    if (mode === "overflow") for (let i = 0; i < 1025; i++) state.event({ tabId: 42 }, "Page.frameAttached", { frameId: `f${i}` });
    if (mode === "payload") await state.api.debugger.sendCommand({ tabId: 42 }, "Input.insertText", { text: "x".repeat(3000) });
    await tick(); await state.diagnostic.finish(state);
    assert.equal(state.item.diagnostic.collectionComplete, false, mode);
    assert.equal(state.item.diagnostic.traceComplete, false, mode);
    assert.equal(state.listeners.size, 0);
    release?.({}); await tick();
    assert.equal(state.item.diagnostic.collectionComplete, false, "Late ACK cannot retroactively change retained evidence");
  }
});

test("one failure deadline prevents metadata after a late trace and focus after late metadata", async t => {
  let clock = 1000; t.mock.method(Date, "now", () => clock);
  for (const late of ["trace", "metadata", "focus"]) {
    const state = harness({ focus: () => { if (late === "focus") clock += 3001; return { events: [] }; },
      intercept: async (expression, evaluate) => {
        const result = await evaluate();
        if ((late === "trace" && expression.includes("return{...probe.snapshot()")) ||
            (late === "metadata" && expression.startsWith("(async function goChooserNativeObservation"))) clock += 3001;
        return result;
      } });
    await state.diagnostic.start(state); await state.diagnostic.failure(state); await state.diagnostic.finish(state);
    assert.equal(state.item.diagnostic.failureRead.complete, false, late);
    assert.equal(state.item.diagnostic.collectionComplete, false, late);
    assert.equal(state.calls.length, late === "trace" ? 0 : 4);
    assert.equal(state.focusReads(), late === "focus" ? 1 : 0);
    assert.equal(state.item.diagnostic.traceComplete, true);
  }
});

test("held metadata returns at the fixed 3s budget and its late result cannot continue to focus", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let release;
  const state = harness(); await state.diagnostic.start(state);
  state.api.tabs.get = () => new Promise(resolve => { release = resolve; });
  const pending = state.diagnostic.failure(state); await tick();
  t.mock.timers.tick(3000); await pending;
  assert.equal(state.item.diagnostic.failureRead.complete, false); assert.equal(state.focusReads(), 0);
  release({ id: 42 }); await tick(); assert.equal(state.focusReads(), 0);
  await state.diagnostic.finish(state); assert.equal(state.item.diagnostic.collectionComplete, false);
});

test("setup shares one budget and never installs after a late attachment read", async t => {
  let clock = 1000; t.mock.method(Date, "now", () => clock);
  const state = harness({ intercept: async (expression, evaluate) => { const value = await evaluate(); if (expression.includes("const all=globalThis.__integrationFrames")) clock += 1501; return value; } });
  await assert.rejects(state.diagnostic.start(state), /settled after/);
  assert.equal(state.expressions.length, 1); assert.equal(state.context.__obuChooserDiagnostic, undefined);
  await state.diagnostic.finish(state); await state.diagnostic.cleanup();
  assert.equal(state.item.diagnostic.collectionComplete, false);
});

test("cleanup nonce tombstone rejects an overtaken installation even before its worker clock deadline", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let delayed;
  const state = harness({ intercept: (expression, evaluate) => {
    if (expression.includes("const snapshot=")) { delayed = evaluate; return new Promise(() => {}); }
    return evaluate();
  } });
  const starting = state.diagnostic.start(state); const rejection = assert.rejects(starting, /read outcome unknown/);
  await tick(); assert.ok(delayed); t.mock.timers.tick(1500); await rejection;
  await state.diagnostic.cleanup();
  await assert.rejects(delayed(), /cancelled or already attempted/);
  assert.equal(state.context.__obuChooserDiagnostic, undefined); assert.equal(state.listeners.size, 0);
  assert.equal(state.item.diagnostic.cleanup.complete, true);
});

test("lost installation ACK is cleaned by its nonce without pretending setup or collection succeeded", async () => {
  const originalError = new Error("installation ACK lost");
  const state = harness({ intercept: async (expression, evaluate) => { const result = await evaluate(); if (expression.includes("const snapshot=")) throw originalError; return result; } });
  await assert.rejects(state.diagnostic.start(state), error => error === originalError);
  assert.ok(state.context.__obuChooserDiagnostic); await state.diagnostic.finish(state); await state.diagnostic.cleanup();
  assert.equal(state.item.diagnostic.collectionComplete, false); assert.equal(state.context.__obuChooserDiagnostic, undefined);
  assert.equal(state.api.debugger.sendCommand, state.original);
});

test("cleanup during an outstanding initial read prevents subsequent installation", async () => {
  let release;
  const state = harness({ intercept: (expression, evaluate) => {
    if (expression.includes("const all=globalThis.__integrationFrames")) return new Promise(resolve => { release = async () => resolve(await evaluate()); });
    return evaluate();
  } });
  const starting = state.diagnostic.start(state); const rejected = assert.rejects(starting, /cleaned up during setup/);
  await tick(); await state.diagnostic.cleanup(); await release(); await rejected;
  assert.equal(state.expressions.length, 1); assert.equal(state.context.__obuChooserDiagnostic, undefined);
});

test("initial attachment overflow or oversized identities reject before native wrapper installation", async () => {
  for (const attachments of [Array.from({ length: 65 }, () => child), [{ ...child, url: "x".repeat(9000) }]]) {
    const state = harness({ attachments }); await assert.rejects(state.diagnostic.start(state), /observation incomplete/);
    assert.equal(state.item.diagnostic.initialAttachmentRead.overflow, true);
    assert.ok(state.item.diagnostic.initialAttachmentRead.entries.length <= 64);
    assert.equal(state.context.__obuChooserDiagnostic, undefined); assert.equal(state.expressions.length, 1);
    await state.diagnostic.cleanup();
  }
});

test("foreign controller and worker replacement stay intact and cannot impersonate continuous trace", async () => {
  for (const replacement of [false, true]) {
    const state = harness();
    if (replacement) { await state.diagnostic.start(state); state.context.__obuChooserDiagnostic.restore(); delete state.context.__obuChooserDiagnostic; }
    installChooserDiagnostic(state.api, state.context, 42);
    const foreign = state.context.__obuChooserDiagnostic;
    if (!replacement) await assert.rejects(state.diagnostic.start(state), /already installed/);
    await state.diagnostic.failure(state); await state.diagnostic.finish(state); await state.diagnostic.cleanup();
    assert.equal(state.item.diagnostic.collectionComplete, false);
    assert.equal(state.context.__obuChooserDiagnostic, foreign); assert.equal(foreign.snapshot().restored, false);
    foreign.restore();
  }
});

test("changed boot with copied nonce is rejected before cleanup can restore the foreign controller", async () => {
  const state = harness(); await state.diagnostic.start(state);
  const setupId = state.item.diagnostic.setupId;
  state.context.__obuChooserDiagnostic.restore(); delete state.context.__obuChooserDiagnostic;
  installChooserDiagnostic(state.api, state.context, 42); const foreign = state.context.__obuChooserDiagnostic; foreign.goChooserSetupId = setupId;
  await state.diagnostic.failure(state); await state.diagnostic.finish(state); await state.diagnostic.cleanup();
  assert.equal(state.item.diagnostic.collectionComplete, false); assert.equal(state.item.diagnostic.cleanup.complete, false);
  assert.equal(foreign.snapshot().restored, false); foreign.restore();
});

test("original business error survives failed observation, finish and cleanup; diagnostic fields retain all failures", async () => {
  let broken = false;
  const originalError = new Error("original Go chooser timeout"), observationError = new Error("worker gone");
  const state = harness({ intercept: (expression, evaluate) => { if (broken) throw observationError; return evaluate(); } });
  await state.diagnostic.start(state); broken = true;
  await assert.rejects((async () => {
    try { throw originalError; }
    catch (error) { await state.diagnostic.failure(state); throw error; }
    finally { await state.diagnostic.finish(state); await state.diagnostic.cleanup(); }
  })(), error => error === originalError);
  const value = state.item.diagnostic;
  assert.match(value.failureRead.errors[0].error, /worker gone/); assert.match(value.error, /worker gone/); assert.match(value.cleanup.error, /worker gone/);
  assert.equal(value.collectionComplete, false); assert.equal(state.diagnostic.errors.length, 3);
  broken = false; state.context.__obuChooserDiagnostic.restore();
});

test("bounded metadata, API rejection, exact tab mismatch and absent focus cannot count as complete observations", async () => {
  for (const mode of ["overflow", "error", "tab", "focus"]) {
    const state = harness({ focus: mode === "focus" ? () => null : undefined });
    await state.diagnostic.start(state);
    if (mode === "overflow") state.api.windows.getAll = async () => Array.from({ length: 65 }, (_, id) => ({ id }));
    if (mode === "error") state.api.webNavigation.getAllFrames = async () => { throw new Error("tab gone"); };
    if (mode === "tab") state.api.tabs.get = async () => ({ id: 43 });
    await state.diagnostic.failure(state); await state.diagnostic.finish(state);
    assert.equal(state.item.diagnostic.observationComplete, false, mode); assert.equal(state.item.diagnostic.collectionComplete, false, mode);
    if (mode === "overflow") assert.equal(state.item.diagnostic.failureRead.nativeState.windows.value.entries.length, 64);
  }
  const state = harness(); state.api.tabs.get = async () => ({ id: 42, url: "x".repeat(9000) });
  const result = await goChooserNativeObservation(state.api, 42); assert.equal(result.overflow, true); assert.equal(result.tab.value.url.length, 8192);
});

test("early restore is incomplete and cleanup/finish cannot steal a successor installation", async () => {
  const state = harness(); await state.diagnostic.start(state);
  state.context.__obuChooserDiagnostic.restore(); await state.diagnostic.finish(state);
  assert.equal(state.item.diagnostic.trace.restoredBeforeFinish, true); assert.equal(state.item.diagnostic.collectionComplete, false);
  const next = { item: { tabId: 43, key: "next", variant: "root" } }; await state.diagnostic.start(next);
  const successor = state.context.__obuChooserDiagnostic;
  await state.diagnostic.finish(state); assert.equal(state.context.__obuChooserDiagnostic, successor);
  await state.diagnostic.finish(next); assert.equal(next.item.diagnostic.collectionComplete, true);
  await state.diagnostic.cleanup(); assert.equal(state.context.__obuChooserDiagnostic, undefined);
  const count = state.expressions.length; await state.diagnostic.cleanup(); assert.equal(state.expressions.length, count);
  await assert.rejects(state.diagnostic.start({ item: { tabId: 44 } }), /already cleaned up/);
});

test("held finish times out explicitly and eventual cleanup never converts it to successful evidence", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let hold = false, delayed;
  const state = harness({ intercept: (expression, evaluate) => {
    if (hold && expression.includes("restoredBeforeFinish")) { delayed = evaluate; return new Promise(() => {}); }
    return evaluate();
  } });
  await state.diagnostic.start(state); hold = true;
  const ending = state.diagnostic.finish(state); await tick(); t.mock.timers.tick(1500); await ending;
  assert.equal(state.item.diagnostic.collectionComplete, false); assert.match(state.item.diagnostic.error, /read outcome unknown/);
  await delayed(); hold = false; await state.diagnostic.cleanup();
  assert.equal(state.item.diagnostic.collectionComplete, false); assert.equal(state.api.debugger.sendCommand, state.original);
});
