import assert from "node:assert/strict";
import { createContext, runInContext } from "node:vm";
import test from "node:test";
import { installCreatedPageNativeControlObserver } from "./created-page-native-control.mjs";

const plain = value => JSON.parse(JSON.stringify(value));
const emitter = () => {
  const listeners = new Set();
  return { addListener: value => listeners.add(value), removeListener: value => listeners.delete(value), hasListener: value => listeners.has(value),
    emit: (...args) => { for (const listener of listeners) listener(...args); }, get size() { return listeners.size; } };
};
const methodNames = ["debugger.sendCommand", "debugger.attach", "debugger.detach", "tabs.update", "tabs.create", "tabs.move", "tabs.group", "tabs.ungroup", "windows.create", "windows.update"];
const eventNames = ["tabs.onCreated", "tabs.onActivated", "windows.onFocusChanged", "webNavigation.onCreatedNavigationTarget"];
const resolvePath = (value, path) => path.split(".").reduce((object, name) => object[name], value);
const ownerPath = (value, path) => resolvePath(value, path.slice(0, path.lastIndexOf(".")));

function fixture({ options = {}, native, beforeInstall, target: suppliedTarget } = {}) {
  const calls = [], originalMethods = new Map(), descriptors = new Map();
  const chrome = { debugger: {}, tabs: {}, windows: {}, webNavigation: {} };
  for (const path of methodNames) {
    const object = ownerPath(chrome, path), name = path.split(".").at(-1);
    const original = function (...args) {
      const call = { path, receiver: this, args }; calls.push(call);
      const value = native ? native(call) : Promise.resolve({ shouldNotRetain: "original-native-result", huge: "z".repeat(10000) });
      call.result = value; return value;
    };
    Object.defineProperty(object, name, { value: original, configurable: true, enumerable: false, writable: true });
    originalMethods.set(path, original); descriptors.set(path, Object.getOwnPropertyDescriptor(object, name));
  }
  for (const path of eventNames) ownerPath(chrome, path)[path.split(".").at(-1)] = emitter();
  beforeInstall?.(chrome);
  const context = suppliedTarget ?? createContext({ chrome, Date, TextEncoder });
  const installed = suppliedTarget ? installCreatedPageNativeControlObserver(chrome, context, options) :
    plain(runInContext(`(${installCreatedPageNativeControlObserver.toString()})(chrome,globalThis,${JSON.stringify(options)})`, context));
  const api = context.__createdPageNativeControl;
  return { chrome, context, api, installed, calls, originalMethods, descriptors,
    snapshot: () => plain(api.snapshot()), stop: () => plain(api.stop()),
    invoke: (path, ...args) => Reflect.apply(resolvePath(chrome, path), ownerPath(chrome, path), args) };
}

function complete(snapshot) {
  assert.equal(snapshot.closed, true); assert.equal(snapshot.restored, true); assert.equal(snapshot.listenersRemoved, true);
  assert.equal(snapshot.overflow, false); assert.deepEqual(snapshot.errors, []); assert.deepEqual(snapshot.pendingOperations, []);
  assert.equal(snapshot.bytes, snapshot.records.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row)), 0));
  snapshot.records.forEach((row, index) => assert.equal(row.sequence, index + 1));
  const calls = snapshot.records.filter(row => row.kind === "call"), outcomes = snapshot.records.filter(row => ["fulfilled", "rejected", "threw"].includes(row.kind));
  assert.equal(calls.length, outcomes.length);
  for (const call of calls) {
    const matching = outcomes.filter(row => row.operationId === call.operationId);
    assert.equal(matching.length, 1); assert.equal(matching[0].api, call.api); assert.ok(matching[0].sequence > call.sequence);
  }
}

test("serialized diagnostic retains every actual API call/ACK, exact args/this/promise, and restores descriptors", async () => {
  const observed = fixture();
  assert.deepEqual(observed.installed.methods, methodNames); assert.deepEqual(observed.installed.events, eventNames);
  assert.equal(observed.calls.length, 0, "Installation makes no native calls");
  const argsByMethod = new Map([
    ["debugger.sendCommand", [{ tabId: 7, sessionId: "oopif" }, "Input.dispatchMouseEvent", { type: "mousePressed", x: 1.25, y: 2.75, modifiers: 2 }]],
    ["debugger.attach", [{ tabId: 7 }, "1.3"]], ["debugger.detach", [{ tabId: 7 }]],
    ["tabs.update", [7, { active: true, url: "http://example.invalid" }]], ["tabs.create", [{ active: false, windowId: 3 }]],
    ["tabs.move", [7, { windowId: 3, index: 0 }]], ["tabs.group", [{ tabIds: [7], groupId: 8 }]], ["tabs.ungroup", [[7]]],
    ["windows.create", [{ focused: false, type: "normal", url: "about:blank" }]], ["windows.update", [3, { focused: true, drawAttention: true }]],
  ]);
  const promises = [];
  for (const [path, args] of argsByMethod) {
    const result = observed.invoke(path, ...args), call = observed.calls.at(-1);
    assert.equal(result, call.result); assert.equal(call.receiver, ownerPath(observed.chrome, path));
    args.forEach((argument, index) => assert.equal(call.args[index], argument)); promises.push(result);
  }
  await Promise.all(promises);
  const snapshot = observed.stop(); complete(snapshot);
  const calls = snapshot.records.filter(row => row.kind === "call"); assert.equal(calls.length, methodNames.length);
  for (const row of calls) assert.deepEqual(row.args, argsByMethod.get(row.api));
  assert.ok(!JSON.stringify(snapshot).includes("shouldNotRetain"), "Large original results are acknowledged without copying payloads");
  for (const path of methodNames) {
    assert.equal(resolvePath(observed.chrome, path), observed.originalMethods.get(path));
    assert.deepEqual(Object.getOwnPropertyDescriptor(ownerPath(observed.chrome, path), path.split(".").at(-1)), observed.descriptors.get(path));
  }
  assert.deepEqual(observed.stop(), snapshot);
});

test("all CDP methods retain actual target and parameters, including Runtime and activation paths", async () => {
  const observed = fixture(), methods = [
    "Input.dispatchKeyEvent", "Input.dispatchMouseEvent", "Emulation.setFocusEmulationEnabled", "Page.bringToFront",
    "Page.createIsolatedWorld", "Target.activateTarget", "Target.sendMessageToTarget", "Browser.setWindowBounds", "Runtime.evaluate", "Runtime.callFunctionOn", "DOM.resolveNode",
  ];
  const commands = methods.map((method, index) => ({ target: { tabId: 7 + index, sessionId: `original-${index}` }, method,
    params: { enabled: true, expression: "window.focus()", nested: { exact: "保留原参数", index } } }));
  await Promise.all(commands.map(({ target, method, params }) => observed.invoke("debugger.sendCommand", target, method, params)));
  const snapshot = observed.stop(); complete(snapshot);
  const calls = snapshot.records.filter(row => row.kind === "call");
  assert.deepEqual(calls.map(row => row.args), commands.map(value => [value.target, value.method, value.params]));
});

test("native events and stage markers share call/ACK order and listener removal preserves existing observers", async () => {
  let priorEvents = 0;
  const observed = fixture({ beforeInstall: chrome => chrome.tabs.onCreated.addListener(() => priorEvents++) });
  observed.api.mark("original-trigger-before", { tabIds: [7, 8] });
  const native = observed.invoke("debugger.sendCommand", { tabId: 7 }, "Input.dispatchMouseEvent", { type: "mouseReleased" });
  const originalTab = { id: 11, windowId: 3, active: false, groupId: -1, url: "http://example.invalid/child" };
  observed.chrome.tabs.onCreated.emit(originalTab);
  observed.chrome.windows.onFocusChanged.emit(3);
  observed.chrome.tabs.onActivated.emit({ tabId: 7, windowId: 3 });
  observed.chrome.webNavigation.onCreatedNavigationTarget.emit({ sourceTabId: 7, sourceFrameId: 0, sourceProcessId: 1, tabId: 11, timeStamp: 12.34, url: originalTab.url });
  originalTab.active = true;
  await native;
  const snapshot = observed.stop(); complete(snapshot);
  assert.deepEqual(snapshot.records.map(row => row.kind), ["mark", "call", "event", "event", "event", "event", "fulfilled"]);
  assert.equal(snapshot.records[2].args[0].active, false, "Original native event is cloned immediately");
  assert.equal(priorEvents, 1); observed.chrome.tabs.onCreated.emit({ id: 22 }); assert.equal(priorEvents, 2);
  for (const path of eventNames) assert.equal(resolvePath(observed.chrome, path).size, path === "tabs.onCreated" ? 1 : 0);
  assert.deepEqual(observed.snapshot(), snapshot);
});

test("synchronous original throw and rejection retain exact identity and matching failure records", async () => {
  const synchronous = Error("original synchronous failure"), asynchronous = Error("original asynchronous failure");
  const rejection = Promise.reject(asynchronous); rejection.catch(() => {});
  const observed = fixture({ native: call => { if (call.path === "tabs.update") throw synchronous; return rejection; } });
  assert.throws(() => observed.invoke("tabs.update", 7, { active: true }), error => error === synchronous);
  const result = observed.invoke("windows.update", 3, { focused: true }); assert.equal(result, rejection);
  await assert.rejects(result, error => error === asynchronous);
  const snapshot = observed.stop(); complete(snapshot);
  assert.deepEqual(snapshot.records.filter(row => row.kind !== "call").map(row => ({ kind: row.kind, error: row.error.message })), [
    { kind: "threw", error: synchronous.message }, { kind: "rejected", error: asynchronous.message },
  ]);
});

test("record and byte overflow are explicit, bounded and never suppress original commands", async () => {
  for (const options of [{ maxRecords: 2 }, { maxBytes: 1 }, { maxBytes: 512 }]) {
    const observed = fixture({ options });
    for (let index = 0; index < 5; index++) await observed.invoke("debugger.sendCommand", { tabId: 7 }, "Runtime.evaluate", { expression: "z".repeat(2000) });
    const snapshot = observed.stop(); assert.equal(observed.calls.length, 5); assert.equal(snapshot.overflow, true);
    assert.ok(snapshot.records.length <= snapshot.maxRecords && snapshot.bytes <= snapshot.maxBytes);
    assert.equal(observed.chrome.debugger.sendCommand, observed.originalMethods.get("debugger.sendCommand"));
  }
});

test("argument accessors and cyclic data fail evidence without invoking the getter or changing the original call", async () => {
  let reads = 0;
  const observed = fixture(), target = { get tabId() { reads++; throw Error("Must not read getter"); } }, cyclic = { exact: 1 }; cyclic.self = cyclic;
  const first = observed.invoke("debugger.sendCommand", target, "Page.bringToFront", {});
  const second = observed.invoke("debugger.sendCommand", { tabId: 7 }, "Runtime.evaluate", cyclic);
  assert.equal(reads, 0); assert.equal(observed.calls[0].args[0], target); assert.equal(observed.calls[1].args[2], cyclic);
  await Promise.all([first, second]); const snapshot = observed.stop();
  assert.equal(snapshot.errors.length, 2); assert.match(snapshot.errors.join(" "), /accessor.*Cyclic/); assert.equal(observed.calls.length, 2);
});

test("non-promise original return remains unchanged and is never reported as native success", () => {
  const observed = fixture({ native: () => 123 });
  assert.equal(observed.invoke("tabs.update", 7, { active: false }), 123);
  const snapshot = observed.stop(); assert.equal(snapshot.errors.length, 1);
  assert.equal(snapshot.records.at(-1).kind, "settlement-unobserved"); assert.deepEqual(snapshot.pendingOperations, []);
});

test("stop before actual native completion preserves pending evidence and snapshots are independent", async () => {
  const deferred = Promise.withResolvers(), observed = fixture({ native: () => deferred.promise });
  const actual = observed.invoke("windows.update", 3, { focused: true }); assert.equal(actual, deferred.promise);
  const snapshot = observed.stop(); assert.equal(snapshot.pendingOperations.length, 1);
  deferred.resolve({ focused: true }); await actual;
  assert.deepEqual(observed.snapshot(), snapshot); assert.equal(snapshot.records.length, 1);
  snapshot.records[0].args[1].focused = false;
  assert.equal(observed.snapshot().records[0].args[1].focused, true);
});

test("stop leaves third-party method replacements intact while restoring other methods and event listeners", () => {
  const observed = fixture(), replacement = () => Promise.resolve(); observed.chrome.tabs.update = replacement;
  const snapshot = observed.stop(); assert.equal(snapshot.restored, false); assert.equal(snapshot.listenersRemoved, true);
  assert.equal(observed.chrome.tabs.update, replacement); assert.match(snapshot.errors.join(" "), /tabs.update observer replaced/);
  assert.equal(observed.chrome.debugger.sendCommand, observed.originalMethods.get("debugger.sendCommand"));
  for (const path of eventNames) assert.equal(resolvePath(observed.chrome, path).size, 0);
});

test("failed listener installation rolls back every installed method and listener", () => {
  let chrome;
  assert.throws(() => fixture({ beforeInstall: value => {
    chrome = value; chrome.tabs.onActivated.addListener = () => { throw Error("Native listener failure"); };
  } }), /Native listener failure/);
  assert.equal(chrome.tabs.onCreated.size, 0);
  assert.equal(chrome.tabs.onActivated.size, 0);
  assert.equal(chrome.debugger.sendCommand.name, "original");
});

test("invalid limits, nonwritable original methods and duplicate installation are rejected before mutation", () => {
  for (const options of [{ maxRecords: 0 }, { maxRecords: 64001 }, { maxBytes: 0 }, { maxBytes: 16 * 1024 * 1024 + 1 }]) assert.throws(() => fixture({ options }), /Invalid/);
  let original, chrome;
  assert.throws(() => fixture({ beforeInstall: value => {
    chrome = value; original = chrome.debugger.sendCommand; Object.defineProperty(chrome.windows, "update", { writable: false });
  } }), /Cannot observe/);
  assert.equal(chrome.debugger.sendCommand, original);
  const observed = fixture(), installed = observed.chrome.debugger.sendCommand;
  assert.throws(() => installCreatedPageNativeControlObserver(observed.chrome, observed.context), /Invalid/);
  assert.equal(observed.chrome.debugger.sendCommand, installed); observed.stop();
});
