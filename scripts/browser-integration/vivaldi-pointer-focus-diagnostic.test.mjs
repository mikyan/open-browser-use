import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { vivaldiPointerFocusEnabled, pointerCommandEvidence, pointerFocusDiagnosticResult } from "./vivaldi-pointer-focus-diagnostic.mjs";
import { installInputEventDiagnostic, inputFixtureSource, inputDOMTraceComplete, inputNativeTraceComplete, vivaldiInputResult } from "./vivaldi-input-diagnostic.mjs";
import { installNativeAPIDiagnostics } from "./native-api-diagnostics.mjs";
import { nativeBrowserInstallationPassed } from "./native-browser-installation.mjs";

const nonce = "0123456789abcdef01234567", pointerTypes = ["pointerdown", "pointerup", "mousedown", "mouseup", "click"];
const phaseNames = ["before-pointer-click", "after-pointer-click", "before-fill", "after-fill", "final"];
function domFixture(options = {}) {
  const listeners = new Map(), pending = [], registrations = [];
  const note = { localName: "input", id: "note", type: "text", isConnected: true, value: "", selectionStart: 0, selectionEnd: 0, selectionDirection: "none" };
  const document = { location: { href: `http://127.0.0.1/task?nonce=${nonce}` }, readyState: "complete", visibilityState: "hidden", activeElement: null, hasFocus: () => false, querySelector: () => note, addEventListener(type, listener, config) { listeners.set(type, listener); registrations.push(config); }, removeEventListener(type) { listeners.delete(type); } };
  const target = { crypto: { randomUUID: () => "pointer-document" } };
  const controller = installInputEventDiagnostic(document, target, nonce, { microtask: callback => pending.push(callback), ...options });
  const emit = (type, extra = {}) => { const event = { type, target: note, eventPhase: 1, timeStamp: 1, isTrusted: true, defaultPrevented: false, cancelable: true, button: 0, buttons: type.endsWith("down") ? 1 : 0, clientX: 42.5, clientY: 90, pageX: 42.5, pageY: 90, screenX: 80, screenY: 160, ...extra }; listeners.get(type)(event); return event; };
  return { note, document, target, controller, listeners, registrations, pending, emit, drain: () => { for (const callback of pending.splice(0)) callback(); } };
}
const phases = values => values.map((snapshot, index) => ({ phase: phaseNames[index], snapshot }));
const steps = () => [{ operation: "pointerFocusClick", requestedAt: 0, completedAt: 20 }, { operation: "fill", requestedAt: 30, completedAt: 40 }, { operation: "click", requestedAt: 100, completedAt: 120 }];

test("POINTER_FOCUS is actual-Vivaldi-only and exclusive with all six old explicit flags", () => {
  for (const value of [undefined, "", "0"]) assert.equal(vivaldiPointerFocusEnabled(value, { name: "opera", keyInput: true }), false);
  assert.equal(vivaldiPointerFocusEnabled("1", { name: "vivaldi" }), true);
  for (const value of [true, "true", "2", 1, null]) assert.throws(() => vivaldiPointerFocusEnabled(value, { name: "vivaldi" }));
  for (const change of [{ name: "brave" }, { input: true }, { taskReadiness: true }, { keyInput: true }, { readiness: true }, { nativeDiagnostics: true }, { ownership: true }]) assert.throws(() => vivaldiPointerFocusEnabled("1", { name: "vivaldi", ...change }));
});

test("only the explicit pointer fixture adds five passive events while old caps/event sets remain", () => {
  const old = domFixture(), key = domFixture({ keyEvents: true, maximumRecords: 1024 }), pointer = domFixture({ pointerEvents: true });
  assert.equal(old.controller.snapshot().events.length, 10); assert.equal(old.controller.snapshot().maximumRecords, 256);
  assert.equal(key.controller.snapshot().events.length, 13); assert.equal(key.controller.snapshot().maximumRecords, 1024);
  for (const type of pointerTypes) { assert.equal(old.listeners.has(type), false); assert.equal(key.listeners.has(type), false); }
  assert.deepEqual(pointer.controller.snapshot().events.slice(-5), pointerTypes); assert.equal(pointer.controller.snapshot().maximumRecords, 256);
  for (const config of pointer.registrations) assert.deepEqual(config, { capture: true, passive: true });
  assert.throws(() => domFixture({ keyEvents: true, pointerEvents: true }), /exclusive/);
  assert.throws(() => domFixture({ pointerEvents: true, maximumRecords: 1024 }), /capacity/);
  const f = domFixture(); f.controller.restore(); delete f.target.__obuInputEventDiagnostic;
  const context = vm.createContext({ document: f.document, crypto: f.target.crypto, performance: { now: () => 1 }, queueMicrotask: callback => f.pending.push(callback) });
  vm.runInContext(inputFixtureSource(nonce, { pointerFocus: true }), context);
  assert.deepEqual([...context.__obuInputEventDiagnostic.snapshot().events.slice(-5)], pointerTypes);
  assert.throws(() => inputFixtureSource(nonce, { pointerFocus: true, keyInput: true }), /exclusive/);
});

test("five same-document snapshots retain actual pointer coordinates and original-node empty state without editing", () => {
  const f = domFixture({ pointerEvents: true }), before = f.controller.snapshot();
  for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
    const event = f.emit(type, type.startsWith("pointer") ? { pointerId: 1, pointerType: "mouse", isPrimary: true } : {});
    event.eventPhase = 0; f.drain();
  }
  const after = f.controller.snapshot(), snapshots = phases([before, after, f.controller.snapshot(), f.controller.snapshot(), f.controller.snapshot()]);
  assert.equal(inputDOMTraceComplete(snapshots, nonce, { pointerFocus: true }), true);
  assert.equal(inputDOMTraceComplete(snapshots, nonce), false);
  const evidence = pointerCommandEvidence({ records: [] }, { tabId: 44, steps: steps(), snapshots });
  assert.equal(evidence.trustedOriginalNoteEvents, true); assert.equal(evidence.pointerDOMEvents.length, 5);
  assert.equal(evidence.pointerDOMEvents[0].clientX, 42.5); assert.equal(evidence.pointerDOMEvents[0].pointerType, "mouse");
  assert.equal(evidence.inputInitiallyEmpty && evidence.inputAfterPointerEmpty && evidence.inputBeforeFillEmpty, true);
  assert.equal(f.note.value, ""); assert.equal(f.document.activeElement, null);
  const changed = structuredClone(snapshots); changed[4].snapshot.documentId = "replacement";
  assert.equal(inputDOMTraceComplete(changed, nonce, { pointerFocus: true }), false);
  const missingCoordinate = structuredClone(snapshots); delete missingCoordinate[1].snapshot.records[0].clientX;
  assert.equal(inputDOMTraceComplete(missingCoordinate, nonce, { pointerFocus: true }), false);
});

test("absent or wrong-target pointer delivery stays a complete observation, and cancellation may remain unknown", () => {
  const f = domFixture({ pointerEvents: true }), before = f.controller.snapshot();
  const empty = phases([before, f.controller.snapshot(), f.controller.snapshot(), f.controller.snapshot(), f.controller.snapshot()]);
  assert.equal(inputDOMTraceComplete(empty, nonce, { pointerFocus: true }), true);
  assert.equal(pointerCommandEvidence(null, { tabId: 44, snapshots: empty }).trustedOriginalNoteEvents, false);
  f.emit("click", { target: { localName: "button", id: "other", isConnected: true }, isTrusted: false }); f.drain();
  const after = f.controller.snapshot(), values = phases([before, after, f.controller.snapshot(), f.controller.snapshot(), f.controller.snapshot()]);
  assert.equal(inputDOMTraceComplete(values, nonce, { pointerFocus: true }), true);
  assert.equal(after.records[1].finalDefaultPrevented, null); assert.equal(after.finalCancellationUnknown, 1);
  assert.equal(pointerCommandEvidence(null, { tabId: 44, snapshots: values }).trustedOriginalNoteEvents, false);
});

test("pointer observers keep the original 256 capacity and bound retained events before microtasks drain", () => {
  const f = domFixture({ pointerEvents: true });
  for (let i = 0; i < 10000; i++) f.emit("pointerdown");
  assert.equal(f.pending.length, 128); assert.equal(f.controller.snapshot().pending.length, 128); assert.equal(f.controller.snapshot().overflow, true);
  f.drain(); assert.equal(f.controller.snapshot().records.length, 256);
});

function nativeFixture() {
  const api = { tabs: {}, tabGroups: {}, debugger: {} }, calls = [], target = { crypto: { randomUUID: () => "pointer-worker" } }; let now = 1;
  for (const [namespace, methods] of [["tabs", ["create", "group"]], ["tabGroups", ["get", "update"]], ["debugger", ["attach", "detach", "sendCommand"]]]) for (const method of methods) api[namespace][method] = () => Promise.resolve({});
  for (const [namespace, events] of [["tabs", ["onCreated", "onUpdated", "onRemoved", "onAttached", "onDetached", "onMoved", "onReplaced", "onActivated"]], ["tabGroups", ["onCreated", "onUpdated", "onRemoved", "onMoved"]], ["debugger", ["onEvent", "onDetach"]]]) for (const event of events) api[namespace][event] = { addListener() {}, removeListener() {} };
  api.debugger.sendCommand = function (...args) { calls.push({ receiver: this, args }); return Promise.resolve({}); };
  const controller = installNativeAPIDiagnostics(api, target, { clock: () => now++ });
  const click = async (debuggee = { tabId: 44 }) => { for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await api.debugger.sendCommand(debuggee, "Input.dispatchMouseEvent", { type, x: 42.5, y: 90, button: type === "mouseMoved" ? "none" : "left", clickCount: type === "mouseMoved" ? 0 : 1 }); };
  return { api, calls, controller, click, time: value => { now = value; } };
}

test("actual native pointer and Submit windows retain independent command counts, order and root targets", async () => {
  const f = nativeFixture(), initial = f.controller.snapshot(); await f.click(); f.time(31);
  await f.api.debugger.sendCommand({ tabId: 44 }, "Input.insertText", { text: `native-vivaldi-${nonce}` }); f.time(101); await f.click();
  const final = f.controller.snapshot(); assert.equal(inputNativeTraceComplete(initial, final, 44), true);
  const evidence = pointerCommandEvidence(final, { tabId: 44, steps: steps() });
  assert.equal(f.calls.length, 7); assert.equal(evidence.mouseCommands.length, 6);
  for (const window of [evidence.pointerWindow, evidence.submitWindow]) {
    assert.deepEqual([window.moveCount, window.pressCount, window.releaseCount], [1, 1, 1]);
    assert.equal(window.allRootDebuggeesMatch, true); assert.equal(window.singlePrimaryPressReleaseObserved, true); assert.equal(window.completedBeforeNextCommand, true);
  }
  assert.equal(evidence.originalActions, true); assert.equal(evidence.experimentObserved, true);
});

test("one public click can have multiple or wrong-root native sequences; unknown time windows are not guessed", async () => {
  const f = nativeFixture(), initial = f.controller.snapshot(); await f.click({ tabId: 44, sessionId: "child" }); await f.click();
  const final = f.controller.snapshot(); assert.equal(inputNativeTraceComplete(initial, final, 44), true);
  const evidence = pointerCommandEvidence(final, { tabId: 44, steps: steps() });
  assert.equal(evidence.pointerWindow.pressCount, 2); assert.equal(evidence.pointerWindow.singlePrimaryPressReleaseObserved, false); assert.equal(evidence.pointerWindow.allRootDebuggeesMatch, false);
  assert.equal(evidence.experimentObserved, true, "Complete collection retains unexpected native behavior");
  const unknown = pointerCommandEvidence(final, { tabId: 44, steps: [{ operation: "pointerFocusClick", requestedAt: 0 }] });
  assert.ok(unknown.mouseCommands.every(value => value.withinPointerTimeWindow === null));
  assert.equal(unknown.experimentObserved, false);
});

test("mouse sends may precede earlier ACKs while preserving the original move/press/release order", () => {
  const records = ["mouseMoved", "mousePressed", "mouseReleased"].map((type, index) => ({ kind: "start", sequence: index, at: 3 + index, callId: index + 1, api: "debugger.sendCommand", method: "Input.dispatchMouseEvent", target: { tabId: 44 }, args: [{ tabId: 44 }, "Input.dispatchMouseEvent", { type, x: 42.5, y: 90, button: index ? "left" : "none", clickCount: index ? 1 : 0 }] }));
  records.push(...[0, 1, 2].map(index => ({ kind: "settled", sequence: 3 + index, at: 6 + index, callId: index + 1 })));
  const evidence = pointerCommandEvidence({ records }, { tabId: 44, steps: steps() });
  assert.deepEqual(evidence.pointerWindow.types, ["mouseMoved", "mousePressed", "mouseReleased"]);
  assert.equal(evidence.pointerWindow.completedBeforeNextCommand, false);
  assert.equal(evidence.pointerWindow.singlePrimaryPressReleaseObserved, true);
  assert.equal(evidence.experimentObserved, true);
});

test("pointer diagnostic completion remains distinct from editing and exact public action order rejects replay", async () => {
  const f = nativeFixture(); await f.click(); const final = f.controller.snapshot(), actions = steps();
  const inputResult = vivaldiInputResult({ readinessComplete: true, nativeTraceComplete: true, domTraceComplete: true, httpComplete: true, cleanupComplete: true, steps: actions });
  const evidence = pointerCommandEvidence(final, { tabId: 44, steps: actions });
  assert.deepEqual(pointerFocusDiagnosticResult({ inputResult, gateResult: { gateComplete: true }, evidence }), { passed: false, collectionComplete: true, experimentObserved: true, diagnosticCompleted: true, exitCode: 0 });
  for (const changed of [[...actions, actions[0]], [...actions, { operation: "pressSequentially" }], [actions[0], { ...actions[1], requestedAt: 10 }, actions[2]]]) assert.equal(pointerCommandEvidence(final, { tabId: 44, steps: changed }).originalActions, false);
  assert.equal(pointerFocusDiagnosticResult({ inputResult, gateResult: { gateComplete: false }, evidence }).diagnosticCompleted, false);
  assert.equal(nativeBrowserInstallationPassed({ mode: "vivaldi-pointer-focus-diagnostic" }), false);
});
