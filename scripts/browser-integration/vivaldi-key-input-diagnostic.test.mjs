import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { vivaldiKeyInputEnabled, keyCommandEvidence, keyInputDiagnosticResult } from "./vivaldi-key-input-diagnostic.mjs";
import { installInputEventDiagnostic, inputFixtureSource, inputDOMTraceComplete, inputNativeTraceComplete, vivaldiInputResult } from "./vivaldi-input-diagnostic.mjs";
import { installNativeAPIDiagnostics } from "./native-api-diagnostics.mjs";
import { nativeBrowserInstallationPassed } from "./native-browser-installation.mjs";

const nonce = "0123456789abcdef01234567", note = `native-vivaldi-${nonce}`;
function domFixture(options = {}) {
  const listeners = new Map(), pending = [], registrations = [];
  const node = { localName: "input", id: "note", type: "text", isConnected: true, value: "", selectionStart: 0, selectionEnd: 0, selectionDirection: "none" };
  const document = { location: { href: `http://127.0.0.1/task?nonce=${nonce}` }, readyState: "complete", visibilityState: "hidden", activeElement: node, hasFocus: () => true, querySelector: () => node, addEventListener: (type, listener, config) => { listeners.set(type, listener); registrations.push(config); }, removeEventListener: type => listeners.delete(type) };
  const target = { crypto: { randomUUID: () => "key-document" } };
  const controller = installInputEventDiagnostic(document, target, nonce, { microtask: callback => pending.push(callback), ...options });
  const emit = (type, key) => { const event = { type, key, code: key === "-" ? "Minus" : `Key${key.toUpperCase()}`, target: node, eventPhase: 1, timeStamp: 1, isTrusted: true, defaultPrevented: false, cancelable: true, isComposing: false }; listeners.get(type)(event); return event; };
  return { node, document, target, listeners, pending, registrations, controller, emit, drain: () => { for (const callback of pending.splice(0)) callback(); } };
}
const phases = snapshots => snapshots.map((snapshot, i) => ({ phase: ["before-key-input", "after-key-input", "final"][i], snapshot }));

test("KEY_INPUT is exclusive with every old explicit mode and restricted to actual Vivaldi", () => {
  for (const value of [undefined, "", "0"]) assert.equal(vivaldiKeyInputEnabled(value, { name: "opera", input: true }), false);
  assert.equal(vivaldiKeyInputEnabled("1", { name: "vivaldi" }), true);
  for (const value of [true, "true", "2", 1, null]) assert.throws(() => vivaldiKeyInputEnabled(value, { name: "vivaldi" }));
  for (const change of [{ name: "brave" }, { input: true }, { taskReadiness: true }, { readiness: true }, { nativeDiagnostics: true }, { ownership: true }]) assert.throws(() => vivaldiKeyInputEnabled("1", { name: "vivaldi", ...change }));
});

test("old INPUT listener set and 256 capacity remain unchanged; 1024 needs explicit key mode", () => {
  const old = domFixture(); assert.equal(old.controller.snapshot().maximumRecords, 256);
  assert.equal(old.listeners.has("keydown"), false); assert.equal(old.listeners.has("keypress"), false); assert.equal(old.listeners.has("keyup"), false);
  assert.throws(() => domFixture({ maximumRecords: 1024 }), /capacity/);
  const keys = domFixture({ keyEvents: true, maximumRecords: 1024 });
  assert.equal(keys.controller.snapshot().maximumRecords, 1024);
  assert.deepEqual(keys.controller.snapshot().events.slice(-3), ["keydown", "keypress", "keyup"]);
  for (const config of keys.registrations) assert.deepEqual(config, { capture: true, passive: true });
});

test("39 ASCII key sequences can be fully observed while original DOM input stays empty", () => {
  assert.equal(note.length, 39);
  const f = domFixture({ keyEvents: true, maximumRecords: 1024 }), before = f.controller.snapshot();
  for (const key of note) for (const type of ["keydown", "keypress", "keyup"]) { const event = f.emit(type, key); event.eventPhase = 0; f.drain(); }
  const after = f.controller.snapshot(), final = f.controller.snapshot();
  assert.equal(after.records.length, 234); assert.equal(after.eventCount, 117); assert.equal(after.state.value, "");
  assert.equal(inputDOMTraceComplete(phases([before, after, final]), nonce, { keyInput: true }), true);
  assert.equal(inputDOMTraceComplete(phases([before, after, final]), nonce), false, "Key-mode evidence cannot silently pass the old INPUT contract");
  assert.deepEqual(after.records.filter(value => value.kind === "event" && value.type === "keydown").map(value => value.key).join(""), note);
});

test("1024 capacity still bounds Event references/microtasks and cancellation remains unknown during propagation", () => {
  const f = domFixture({ keyEvents: true, maximumRecords: 1024 });
  for (let i = 0; i < 10000; i++) f.emit("keydown", "a");
  assert.equal(f.pending.length, 512); assert.equal(f.controller.snapshot().pending.length, 512);
  assert.equal(f.controller.snapshot().overflow, true); f.drain();
  const final = f.controller.snapshot(); assert.equal(final.records.length, 1024); assert.deepEqual(final.pending, []);
  assert.equal(final.finalCancellationUnknown, 512); assert.ok(final.records.filter(record => record.kind === "after-microtask").every(record => record.finalDefaultPrevented === null));
});

test("serialized fixture enables extra keys/capacity only for the explicit key variant", () => {
  for (const keyInput of [false, true]) {
    const f = domFixture(); f.controller.restore(); delete f.target.__obuInputEventDiagnostic;
    const context = vm.createContext({ document: f.document, crypto: f.target.crypto, performance: { now: () => 1 }, queueMicrotask: callback => f.pending.push(callback) });
    vm.runInContext(inputFixtureSource(nonce, { keyInput }), context);
    const snapshot = context.__obuInputEventDiagnostic.snapshot();
    assert.equal(snapshot.maximumRecords, keyInput ? 1024 : 256); assert.equal(snapshot.events.includes("keydown"), keyInput);
  }
});

function nativeFixture() {
  const api = { tabs: {}, tabGroups: {}, debugger: {} }, calls = [], target = { crypto: { randomUUID: () => "key-worker" } };
  for (const [namespace, methods] of [["tabs", ["create", "group"]], ["tabGroups", ["get", "update"]], ["debugger", ["attach", "detach", "sendCommand"]]]) for (const method of methods) api[namespace][method] = () => Promise.resolve({});
  for (const [namespace, events] of [["tabs", ["onCreated", "onUpdated", "onRemoved", "onAttached", "onDetached", "onMoved", "onReplaced", "onActivated"]], ["tabGroups", ["onCreated", "onUpdated", "onRemoved", "onMoved"]], ["debugger", ["onEvent", "onDetach"]]]) for (const event of events) api[namespace][event] = { addListener() {}, removeListener() {} };
  let lastPromise;
  api.debugger.sendCommand = function (...args) { calls.push({ receiver: this, args }); lastPromise = Promise.resolve({}); return lastPromise; };
  const controller = installNativeAPIDiagnostics(api, target);
  return { api, calls, controller, originalPromise: () => lastPromise };
}

test("original native wrapper records a single 78-command sequence with exact receiver/Promise/parameters", async () => {
  const f = nativeFixture(), initial = f.controller.snapshot(), receiver = {}, target = { tabId: 44, sessionId: "original-child" };
  for (const key of note) for (const type of ["keyDown", "keyUp"]) {
    const params = { type, key, text: type === "keyDown" ? key : "", modifiers: 0, autoRepeat: false };
    const result = f.api.debugger.sendCommand.call(receiver, target, "Input.dispatchKeyEvent", params);
    assert.equal(result, f.originalPromise()); await result;
    assert.equal(f.calls.at(-1).receiver, receiver); assert.equal(f.calls.at(-1).args[0], target); assert.equal(f.calls.at(-1).args[2], params);
  }
  const final = f.controller.snapshot(); assert.equal(inputNativeTraceComplete(initial, final, 44), true);
  const evidence = keyCommandEvidence(final, { tabId: 44, note, steps: [{ operation: "pressSequentially", requestedAt: 0, completedAt: Date.now() + 1 }] });
  assert.equal(f.calls.length, 78); assert.equal(evidence.dispatchCount, 78); assert.equal(evidence.expectedDispatchCount, 78);
  assert.equal(evidence.exactAlternatingDownUp, true); assert.equal(evidence.completedBeforeNextDispatch, true);
  assert.equal(evidence.sentTextArgument, note); assert.equal(evidence.matchesExpectedDownKeys, true); assert.equal(evidence.matchesExpectedUpKeys, true);
  assert.equal(evidence.allTargetTabIdsMatch, true); assert.equal(evidence.allRootDebuggeesMatch, false, "A same-tab child session is not the original root debuggee");
  assert.ok(evidence.dispatches.every(value => value.matchesRootDebuggee === false && value.target.sessionId === "original-child"));
  assert.equal(evidence.insertTextCommands.length, 0); assert.equal(evidence.experimentObserved, true);
});

test("wrong or incomplete keys/targets remain raw observations; insertText violates the selected experiment", async () => {
  const f = nativeFixture(), initial = f.controller.snapshot();
  await f.api.debugger.sendCommand({ tabId: 999 }, "Input.dispatchKeyEvent", { type: "keyDown", key: "wrong", text: "wrong" });
  const complete = f.controller.snapshot(); assert.equal(inputNativeTraceComplete(initial, complete, 44), true);
  const evidence = keyCommandEvidence(complete, { tabId: 44, note });
  assert.equal(evidence.allTargetTabIdsMatch, false); assert.equal(evidence.allRootDebuggeesMatch, false); assert.equal(evidence.matchesExpectedTextArgument, false); assert.equal(evidence.exactAlternatingDownUp, false);
  assert.equal(evidence.dispatches[0].withinKeyInputTimeWindow, null); assert.equal(evidence.experimentObserved, true);
  const root = nativeFixture(); await root.api.debugger.sendCommand({ tabId: 44 }, "Input.dispatchKeyEvent", { type: "keyDown", key: "n", text: "n" });
  assert.equal(keyCommandEvidence(root.controller.snapshot(), { tabId: 44, note }).allRootDebuggeesMatch, true);
  await f.api.debugger.sendCommand({ tabId: 44 }, "Input.insertText", { text: note });
  assert.equal(keyCommandEvidence(f.controller.snapshot(), { tabId: 44, note }).experimentObserved, false);
});

test("selected pressSequentially counts forbid fill fallback and diagnostic completion never implies task success", () => {
  const detail = { readinessComplete: true, nativeTraceComplete: true, domTraceComplete: true, httpComplete: true, cleanupComplete: true, steps: [{ operation: "pressSequentially" }, { operation: "click" }], inputOperation: "pressSequentially" };
  const inputResult = vivaldiInputResult(detail); assert.equal(inputResult.diagnosticCompleted, true);
  assert.equal(vivaldiInputResult({ ...detail, steps: [...detail.steps, { operation: "fill" }] }).diagnosticCompleted, false);
  const result = keyInputDiagnosticResult({ inputResult, gateResult: { gateComplete: true }, evidence: { experimentObserved: true } });
  assert.deepEqual(result, { passed: false, collectionComplete: true, experimentObserved: true, diagnosticCompleted: true, exitCode: 0 });
  assert.equal(keyInputDiagnosticResult({ inputResult, gateResult: { gateComplete: true }, evidence: { experimentObserved: false } }).diagnosticCompleted, false);
  assert.equal(nativeBrowserInstallationPassed({ mode: "vivaldi-key-input-diagnostic" }), false);
});
