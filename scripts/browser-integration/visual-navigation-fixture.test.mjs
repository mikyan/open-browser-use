import assert from "node:assert/strict";
import test from "node:test";
import { installVisualNavigationObserver } from "./visual-navigation-fixture.mjs";

for (const rejected of [false, true]) test(`presence observer preserves the actual original read and settlement: rejected=${rejected}`, async () => {
  let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }), calls = [], target = {};
  const original = function (...args) { calls.push({ receiver: this, args }); return promise; };
  const api = { tabs: { sendMessage: () => Promise.resolve() }, scripting: { executeScript: original }, runtime: { onMessage: { addListener() {}, removeListener() {} } } };
  installVisualNavigationObserver(api, target, "presence");
  const options = { target: { tabId: 7, documentIds: ["original-document"] }, world: "ISOLATED",
    func: () => Object.getOwnPropertyDescriptor(globalThis, Symbol.for("open-browser-use.cursor.receiver")) === undefined };
  const returned = api.scripting.executeScript(options);
  assert.equal(returned, promise); assert.equal(calls[0].receiver, api.scripting); assert.equal(calls[0].args[0], options);
  assert.throws(() => target.__obuVisualNavigation.restore(), /not settled/);
  const result = [{ frameId: 0, documentId: "original-document", result: true }], error = Error("Original read rejected");
  if (rejected) { reject(error); await assert.rejects(returned, value => value === error); }
  else { resolve(result); assert.equal(await returned, result); }
  const trace = target.__obuVisualNavigation.restore();
  assert.equal(trace.pending, 0); assert.equal(trace.restored, true); assert.equal(api.scripting.executeScript, original);
  assert.deepEqual(trace.records.map(row => row.kind), ["presence-call", "presence-settled"]);
  assert.deepEqual(trace.records[0].target, options.target); assert.equal(trace.records[0].source, options.func.toString());
  assert.equal(trace.records[1].ok, !rejected);
  if (rejected) assert.match(trace.records[1].error, /Original read rejected/);
  else assert.deepEqual(trace.records[1].value, result);
});

test("navigation observer preserves the exact native Promise/arguments and rejects restore until settled", async () => {
  let resolve; const promise = new Promise(done => { resolve = done; }), calls = [], listeners = new Set(), target = {};
  const original = function (...args) { calls.push({ receiver: this, args }); return promise; };
  const api = { tabs: { sendMessage: original }, runtime: { onMessage: { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) } } };
  installVisualNavigationObserver(api, target, "original");
  const args = [7, { type: "OPEN_BROWSER_USE_CURSOR", receiverToken: "original-token" }, { documentId: "original-document" }];
  assert.equal(api.tabs.sendMessage(...args), promise); assert.equal(calls.length, 1); assert.equal(calls[0].receiver, api.tabs); assert.deepEqual(calls[0].args, args);
  assert.throws(() => target.__obuVisualNavigation.restore(), /not settled/);
  for (const fn of listeners) assert.equal(fn({ type: "OPEN_BROWSER_USE_VISUAL_RETIRED", receiverToken: "original-token" }, { tab: { id: 7 }, frameId: 0, documentId: "original-document", url: "https://fixture.test" }), false);
  resolve({ ok: true }); await promise; await Promise.resolve();
  const result = target.__obuVisualNavigation.restore();
  assert.equal(result.restored, true); assert.equal(result.pending, 0); assert.equal(result.overflow, false);
  assert.deepEqual(result.records.map(row => row.kind), ["call", "retired", "settled"]);
  assert.deepEqual(result.records[1].sender, { tabId: 7, frameId: 0, documentId: "original-document", url: "https://fixture.test" });
  assert.deepEqual(result.records[2].value, { ok: true }); assert.equal(api.tabs.sendMessage, original); assert.equal(listeners.size, 0); assert.equal(target.__obuVisualNavigation, undefined);
});

test("navigation observer retains native rejection without manufacturing a cleanup response", async () => {
  const error = Error("Original receiver unavailable"), promise = Promise.reject(error), target = {};
  const api = { tabs: { sendMessage: () => promise }, runtime: { onMessage: { addListener() {}, removeListener() {} } } };
  installVisualNavigationObserver(api, target, "rejection");
  const returned = api.tabs.sendMessage(7, { type: "OPEN_BROWSER_USE_CURSOR_STATE", state: { isVisible: false }, receiverToken: "original" }, { documentId: "document" });
  assert.equal(returned, promise); await assert.rejects(returned, value => value === error); await Promise.resolve();
  const result = target.__obuVisualNavigation.restore(); assert.equal(result.records[1].ok, false); assert.match(result.records[1].error, /Original receiver unavailable/); assert.equal(result.records[1].value, undefined);
});

test("native navigation observation preserves original Promise, synchronous failure and bounded records", async () => {
  const target = {}, listeners = new Set(), calls = [], failure = Error("native failure"); let resolve;
  const promise = new Promise(done => { resolve = done; });
  const original = function (...args) { calls.push({ receiver: this, args }); if (args[2]?.fail) throw failure; return promise; };
  const api = { tabs: { sendMessage: () => Promise.resolve() }, runtime: { onMessage: { addListener() {}, removeListener() {} } },
    debugger: { sendCommand: original, onEvent: { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) } } };
  installVisualNavigationObserver(api, target, "native");
  const args = [{ tabId: 7 }, "Page.getFrameTree", {}];
  assert.equal(api.debugger.sendCommand(...args), promise); assert.deepEqual(calls[0], { receiver: api.debugger, args });
  assert.throws(() => api.debugger.sendCommand({ tabId: 7 }, "Page.navigate", { fail: true }), error => error === failure);
  assert.throws(() => target.__obuVisualNavigation.restore(), /not settled/);
  for (let i = 0; i < 2050; i++) for (const fn of listeners) fn({ tabId: 7 }, "Runtime.executionContextsCleared", {});
  assert.equal(api.debugger.sendCommand(...args), promise, "Overflow does not alter the native operation");
  resolve({ frameTree: { frame: { id: "original" } } }); await promise; await Promise.resolve();
  const result = target.__obuVisualNavigation.restore();
  assert.equal(result.records.length, 2048); assert.equal(result.overflow, true); assert.equal(result.pending, 0);
  assert.equal(api.debugger.sendCommand, original); assert.equal(listeners.size, 0);
});
