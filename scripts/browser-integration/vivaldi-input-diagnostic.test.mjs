import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { installInputEventDiagnostic, inputFixtureSource, captureInputLedgerOnce, inputDOMTraceComplete, inputNativeTraceComplete, inputCommandEvidence, vivaldiInputEnabled, vivaldiInputResult } from "./vivaldi-input-diagnostic.mjs";
import { installNativeAPIDiagnostics } from "./native-api-diagnostics.mjs";
import { nativeBrowserInstallationPassed } from "./native-browser-installation.mjs";

const nonce = "0123456789abcdef01234567";
function fixture(options = {}) {
  const listeners = new Map(), microtasks = [], registrations = [], note = { localName: "input", id: "note", type: "text", isConnected: true, value: "", selectionStart: 0, selectionEnd: 0, selectionDirection: "none" };
  let now = 100, current = note;
  const document = { location: { href: `http://127.0.0.1:123/task?nonce=${nonce}` }, readyState: "complete", visibilityState: "hidden", activeElement: null, hasFocus: () => true, querySelector: selector => { assert.equal(selector, "#note"); return current; }, addEventListener: (type, listener, config) => { listeners.set(type, listener); registrations.push({ type, config }); }, removeEventListener: (type, listener, config) => { assert.equal(listeners.get(type), listener); assert.deepEqual(config, { capture: true }); listeners.delete(type); } };
  const target = { crypto: { randomUUID: () => "document-1" } };
  const controller = installInputEventDiagnostic(document, target, nonce, { clock: () => now++, monotonic: () => now / 10, microtask: callback => microtasks.push(callback), ...options });
  const emit = (type, extra = {}) => { const event = { type, target: note, eventPhase: 1, timeStamp: now / 10, isTrusted: true, defaultPrevented: false, cancelable: true, ...extra }; listeners.get(type)(event); return event; };
  return { controller, note, document, target, listeners, registrations, microtasks, emit, drain: () => { for (const callback of microtasks.splice(0)) callback(); }, replaceNote: value => { current = value; } };
}
const phases = snapshots => snapshots.map((snapshot, index) => ({ phase: ["before-fill", "after-fill", "final"][index], snapshot }));

test("input diagnostic is one explicit Vivaldi switch and excludes every other opt-in mode", () => {
  for (const value of [undefined, "", "0"]) assert.equal(vivaldiInputEnabled(value, { name: "opera", nativeDiagnostics: true, readiness: true, ownership: true }), false);
  assert.equal(vivaldiInputEnabled("1", { name: "vivaldi" }), true);
  for (const value of ["true", "2", " 1", 1, null]) assert.throws(() => vivaldiInputEnabled(value, { name: "vivaldi" }));
  for (const change of [{ name: "brave" }, { nativeDiagnostics: true }, { readiness: true }, { ownership: true }]) assert.throws(() => vivaldiInputEnabled("1", { name: "vivaldi", ...change }));
});

test("passive observer retains original-node identity, actual values and paired event cancellation observations", () => {
  const f = fixture(), before = f.controller.snapshot();
  for (const { config } of f.registrations) assert.deepEqual(config, { capture: true, passive: true });
  f.document.activeElement = f.note;
  const event = f.emit("beforeinput", { data: "task-note", inputType: "insertText", isComposing: false });
  const pending = f.controller.snapshot(); assert.deepEqual(pending.pending, [1]);
  assert.equal(pending.records[0].state.value, ""); assert.equal(pending.records[0].target.nodeId, before.originalNote.nodeId);
  assert.equal(pending.records[0].state.activeElement.originalNote, true);
  // This change simulates a later listener; the observer itself never writes it.
  event.defaultPrevented = true; event.eventPhase = 0; f.drain();
  const after = f.controller.snapshot();
  assert.deepEqual(after.records.slice(0, pending.records.length), pending.records);
  assert.equal(after.records[1].finalDefaultPrevented, true); assert.equal(after.records[1].dispatchComplete, true);
  assert.equal(after.records[0].defaultPreventedAtCapture, false);
  assert.equal(inputDOMTraceComplete(phases([before, after, f.controller.snapshot()]), nonce), true);
  assert.equal(f.note.value, ""); assert.equal(f.note.selectionStart, 0);
});

test("a microtask during propagation keeps final cancellation explicitly unknown", () => {
  const f = fixture(), before = f.controller.snapshot(); f.emit("focus"); f.drain();
  const after = f.controller.snapshot();
  assert.equal(after.records[1].dispatchComplete, false); assert.equal(after.records[1].finalDefaultPrevented, null);
  assert.equal(after.finalCancellationUnknown, 1);
  assert.equal(inputDOMTraceComplete(phases([before, after, f.controller.snapshot()]), nonce), true, "Complete observation is distinct from knowing the final cancellation result");
});

test("original note replacement, document replacement, missing/altered prefixes and pending reads fail completeness", () => {
  const f = fixture(), before = f.controller.snapshot(); const event = f.emit("input", { data: "x", inputType: "insertText" });
  assert.equal(inputDOMTraceComplete(phases([before, f.controller.snapshot(), f.controller.snapshot()]), nonce), false);
  event.eventPhase = 0; f.drain(); const after = f.controller.snapshot(), final = f.controller.snapshot();
  for (const mutate of [
    value => { value[2].documentId = "replacement"; }, value => { value[2].nonce = "another"; },
    value => { value[2].records[0].isTrusted = false; }, value => { value[2].records[0].sequence++; },
    value => { value[2].state.currentNote.nodeId++; }, value => { value[2].state.url = "http://127.0.0.1:123/wrong"; },
  ]) { const values = structuredClone([before, after, final]); mutate(values); assert.equal(inputDOMTraceComplete(phases(values), nonce), false); }
  f.replaceNote({ ...f.note }); assert.equal(inputDOMTraceComplete(phases([before, after, f.controller.snapshot()]), nonce), false);
});

test("capacity reservation bounds retained Event references and microtasks even before they drain", () => {
  const f = fixture({ maximumRecords: 4 });
  for (let i = 0; i < 10000; i++) f.emit("selectionchange");
  const pending = f.controller.snapshot();
  assert.equal(pending.records.length, 2); assert.equal(pending.pending.length, 2); assert.equal(f.microtasks.length, 2);
  assert.equal(pending.dropped, 19996); assert.equal(pending.overflow, true);
  f.drain(); const final = f.controller.snapshot(); assert.equal(final.records.length, 4); assert.deepEqual(final.pending, []);
});

test("event read failures and oversized payloads are bounded diagnostic failures without changing dispatch", () => {
  const f = fixture(); const event = f.emit("beforeinput", { data: "x".repeat(10000), inputType: "insertText" }); event.eventPhase = 0; f.drain();
  assert.equal(f.controller.snapshot().records[0].data.preview.length, 512); assert.ok(f.controller.snapshot().truncations > 0);
  const g = fixture();
  assert.doesNotThrow(() => g.listeners.get("input")({ get type() { throw new Error("read failed"); } }));
  assert.equal(g.controller.snapshot().errors, 1); assert.equal(g.note.value, "");
  const h = fixture(), before = h.controller.snapshot(), after = h.controller.snapshot();
  h.note.value = "x".repeat(513);
  const final = h.controller.snapshot(); assert.ok(final.truncations > 0); assert.equal(final.state.value.preview.length, 512);
  assert.equal(inputDOMTraceComplete(phases([before, after, final]), nonce), false, "First truncation during final snapshot cannot reuse the earlier zero counter");
});

test("serialized fixture source is standalone and failed installation cannot block the original task script", () => {
  const f = fixture(); f.controller.restore(); delete f.target.__obuInputEventDiagnostic;
  const context = vm.createContext({ document: f.document, crypto: f.target.crypto, performance: { now: () => 1 }, queueMicrotask: callback => f.microtasks.push(callback) });
  vm.runInContext(inputFixtureSource(nonce) + ";globalThis.originalTaskExecuted=true;", context);
  assert.equal(context.originalTaskExecuted, true); assert.equal(context.__obuInputEventDiagnostic.snapshot().nonce, nonce);
  const broken = vm.createContext({ document: { querySelector() { throw new Error("missing document"); } } });
  vm.runInContext(inputFixtureSource(nonce) + ";globalThis.originalTaskExecuted=true;", broken);
  assert.equal(broken.originalTaskExecuted, true); assert.equal(broken.__obuInputEventDiagnostic, undefined);
  assert.throws(() => inputFixtureSource("</script>"));
});

test("terminal ledger read is attempted once and read/persistence failures cannot prevent cleanup or replace the task error", async () => {
  const detail = { snapshots: [], errors: [] }, taskError = new Error("original task failure"); let reads = 0, saves = 0, cleaned = false, original;
  const options = { read: async () => { reads++; throw new Error("ledger unavailable"); }, persist: async () => { saves++; throw new Error("disk failure"); } };
  try { throw taskError; } catch (error) { original = error; }
  finally { await captureInputLedgerOnce(detail, options); await captureInputLedgerOnce(detail, options); cleaned = true; }
  assert.equal(cleaned, true); assert.equal(original, taskError); assert.equal(reads, 1); assert.equal(saves, 1);
  assert.equal(detail.snapshots.length, 1); assert.match(detail.snapshots[0].error, /ledger unavailable/); assert.match(detail.snapshots[0].persistenceError, /disk failure/);
});

function nativeFixture() {
  const api = { tabs: {}, tabGroups: {}, debugger: {} }, target = { crypto: { randomUUID: () => "worker-1" } }, calls = [];
  for (const [namespace, methods] of [["tabs", ["create", "group"]], ["tabGroups", ["get", "update"]], ["debugger", ["attach", "detach", "sendCommand"]]]) for (const method of methods) api[namespace][method] = () => Promise.resolve({});
  for (const [namespace, events] of [["tabs", ["onCreated", "onUpdated", "onRemoved", "onAttached", "onDetached", "onMoved", "onReplaced", "onActivated"]], ["tabGroups", ["onCreated", "onUpdated", "onRemoved", "onMoved"]], ["debugger", ["onEvent", "onDetach"]]]) for (const event of events) api[namespace][event] = { addListener() {}, removeListener() {} };
  const utility = { result: { type: "string", value: "needsinput" } };
  const utilityPromise = Promise.resolve(utility), inputPromise = Promise.resolve({});
  api.debugger.sendCommand = function (...args) { calls.push({ receiver: this, args }); return args[1] === "Runtime.callFunctionOn" ? utilityPromise : inputPromise; };
  const controller = installNativeAPIDiagnostics(api, target);
  return { api, controller, calls, utility, utilityPromise, inputPromise };
}

test("unmodified native wrapper preserves single Runtime utility and Input calls, exact receiver/Promise/text/target", async () => {
  const f = nativeFixture(), initial = f.controller.snapshot(), receiver = {}, target = { tabId: 44, sessionId: "actual-child" };
  const utilityParams = { objectId: "object-1", functionDeclaration: "function longUtility() {" + " ".repeat(600) + "}", returnByValue: true };
  const utility = f.api.debugger.sendCommand.call(receiver, target, "Runtime.callFunctionOn", utilityParams);
  assert.equal(utility, f.utilityPromise); assert.equal(await utility, f.utility);
  const params = { text: "native-vivaldi-unique-note" }, input = f.api.debugger.sendCommand.call(receiver, target, "Input.insertText", params);
  assert.equal(input, f.inputPromise); await input;
  assert.equal(f.calls.length, 2); assert.equal(f.calls[1].receiver, receiver); assert.equal(f.calls[1].args[0], target); assert.equal(f.calls[1].args[2], params);
  const final = f.controller.snapshot(); assert.equal(inputNativeTraceComplete(initial, final, 44), true);
  const evidence = inputCommandEvidence(final, { tabId: 44, note: params.text, steps: [{ operation: "fill", requestedAt: 0 }] });
  assert.equal(evidence[0].utilityResultValue, "needsinput"); assert.equal(evidence[1].matchesExpectedText, true); assert.equal(evidence[1].matchesTaskTab, true);
  assert.equal(evidence[1].withinFillTimeWindow, null, "A fill with no known completion cannot claim an unbounded time window");
  assert.ok(final.payloadTruncations > 0, "Unrelated long Runtime source remains explicitly truncated");
});

test("wrong input target/text remains observable; truncated critical Input arguments are incomplete", async () => {
  const f = nativeFixture(), initial = f.controller.snapshot();
  await f.api.debugger.sendCommand({ tabId: 999 }, "Input.insertText", { text: "wrong-text" });
  const final = f.controller.snapshot(); assert.equal(inputNativeTraceComplete(initial, final, 44), true);
  const [evidence] = inputCommandEvidence(final, { tabId: 44, note: "expected" });
  assert.equal(evidence.matchesTaskTab, false); assert.equal(evidence.matchesExpectedText, false);
  const g = nativeFixture(), start = g.controller.snapshot();
  await g.api.debugger.sendCommand({ tabId: 44 }, "Input.insertText", { text: "x".repeat(1000) });
  assert.equal(inputNativeTraceComplete(start, g.controller.snapshot(), 44), false);
});

test("diagnostic completion never becomes acceptance or requires successful input, and rejects replay/missing evidence", () => {
  const value = { readinessComplete: true, nativeTraceComplete: true, domTraceComplete: true, httpComplete: true, cleanupComplete: true, steps: [{ operation: "fill", error: "original failure" }, { operation: "click" }] };
  assert.deepEqual(vivaldiInputResult(value), { passed: false, diagnosticCompleted: true, exitCode: 0 });
  for (const key of ["readinessComplete", "nativeTraceComplete", "domTraceComplete", "httpComplete", "cleanupComplete"]) assert.equal(vivaldiInputResult({ ...value, [key]: false }).exitCode, 1);
  for (const steps of [[], [...value.steps, { operation: "fill" }], [{ operation: "fill" }]]) assert.equal(vivaldiInputResult({ ...value, steps }).exitCode, 1);
  assert.equal(nativeBrowserInstallationPassed({ mode: "vivaldi-input-diagnostic" }), false);
});
