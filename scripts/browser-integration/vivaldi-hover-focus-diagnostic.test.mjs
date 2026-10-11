import assert from "node:assert/strict";
import test from "node:test";
import { vivaldiHoverFocusEnabled, hoverFocusCommandEvidence, hoverFocusDiagnosticResult } from "./vivaldi-hover-focus-diagnostic.mjs";
import { installInputEventDiagnostic, inputDOMTraceComplete } from "./vivaldi-input-diagnostic.mjs";

const tabId = 44, nonce = "0123456789abcdef01234567", note = `native-vivaldi-${nonce}`;
function fixture() {
  let now = 1, sequence = 0, callId = 0;
  const input = { localName: "input", id: "note", type: "text", isConnected: true, value: "", selectionStart: 0, selectionEnd: 0, selectionDirection: "none" };
  const document = { location: { href: `http://127.0.0.1/task?nonce=${nonce}` }, readyState: "complete", visibilityState: "hidden", activeElement: null, hasFocus: () => false, querySelector: () => input, addEventListener() {}, removeEventListener() {} };
  const controller = installInputEventDiagnostic(document, { crypto: { randomUUID: () => "original-document" } }, nonce, { clock: () => now++, monotonic: () => now });
  const doc = hovered => ({ inputDiagnostic: controller.snapshot(), noteHovered: hovered, noteRect: { x: 30, y: 70, width: 240, height: 60 } });
  const before = { phase: "before-hover", requestedAt: 1, completedAt: 2, document: doc(false) }, after = { phase: "before-fill", requestedAt: 25, completedAt: 26, document: doc(true) };
  const detail = { before, after }, inputSnapshots = [{ phase: "before-fill", requestedAt: 25, completedAt: 26, snapshot: after.document.inputDiagnostic }, ...["after-fill", "final"].map((phase, index) => ({ phase, requestedAt: 45 + 20 * index, completedAt: 46 + 20 * index, snapshot: controller.snapshot() }))];
  const steps = [{ operation: "hoverFocus", requestedAt: 10, completedAt: 20 }, { operation: "fill", requestedAt: 30, completedAt: 40 }, { operation: "click", requestedAt: 50, completedAt: 60 }];
  const records = [];
  const add = (method, params, at, target = { tabId }) => {
    const id = ++callId;
    const start = { kind: "start", sequence: sequence++, callId: id, at, api: "debugger.sendCommand", method, target: structuredClone(target), args: [structuredClone(target), method, structuredClone(params)] };
    const finish = { kind: "settled", sequence: sequence++, callId: id, at: at + 1, result: {} }; records.push(start, finish); return { start, finish };
  };
  add("Input.dispatchMouseEvent", { type: "mouseMoved", x: 150, y: 100, button: "none", buttons: 0, modifiers: 0 }, 11);
  add("Input.insertText", { text: note }, 31);
  for (const [index, type] of ["mouseMoved", "mousePressed", "mouseReleased"].entries()) add("Input.dispatchMouseEvent", { type, x: 480, y: 100, button: index ? "left" : "none", buttons: index === 1 ? 1 : 0, clickCount: index ? 1 : 0 }, 51 + index);
  return { controller, input, document, detail, inputSnapshots, steps, records, add, evidence: () => hoverFocusCommandEvidence({ records }, { tabId, note, steps, detail, inputSnapshots }) };
}

test("HOVER_FOCUS is Vivaldi-only and exclusive with all eight earlier explicit modes", () => {
  for (const value of [undefined, "", "0"]) assert.equal(vivaldiHoverFocusEnabled(value, { name: "opera", domFocus: true }), false);
  assert.equal(vivaldiHoverFocusEnabled("1", { name: "vivaldi" }), true);
  for (const value of [true, "true", "2", 1, null]) assert.throws(() => vivaldiHoverFocusEnabled(value, { name: "vivaldi" }));
  for (const change of [{ name: "brave" }, ...["input", "taskReadiness", "keyInput", "pointerFocus", "domFocus", "readiness", "nativeDiagnostics", "ownership"].map(key => ({ [key]: true }))]) assert.throws(() => vivaldiHoverFocusEnabled("1", { name: "vivaldi", ...change }));
});

test("one native move, original insert and Submit sequence establish the experiment, never invented text editing", () => {
  const f = fixture(), evidence = f.evidence();
  assert.equal(evidence.collectionComplete, true); assert.equal(evidence.experimentObserved, true); assert.equal(evidence.nativeInputSequenceMatch, true);
  assert.equal(evidence.inputCommands.length, 5); assert.equal(evidence.sameDocumentEvidence, true); assert.equal(evidence.emptyOriginalNodePrecondition, true);
  assert.equal(f.inputSnapshots.length, 3); assert.equal(inputDOMTraceComplete(f.inputSnapshots, nonce), true);
  assert.equal(f.inputSnapshots[2].snapshot.state.value, "", "Actual input outcome remains empty even with all native ACKs");
  assert.equal(f.controller.snapshot().events.length, 10); assert.equal(f.controller.snapshot().maximumRecords, 256);
  assert.deepEqual(hoverFocusDiagnosticResult({ inputResult: { diagnosticCompleted: true }, evidence }), { passed: false, collectionComplete: true, experimentObserved: true, diagnosticCompleted: true, exitCode: 0 });
});

test("hovered and coordinate hit outcomes are observations, so wrong-widget evidence remains collected", () => {
  const f = fixture(); f.detail.before.document.noteHovered = true; f.detail.after.document.noteHovered = false;
  f.detail.after.document.noteRect = { x: 500, y: 500, width: 0, height: 0 };
  const evidence = f.evidence(); assert.equal(evidence.collectionComplete, true); assert.equal(evidence.experimentObserved, true);
  assert.equal(evidence.hoverObservations.beforeHovered, true); assert.equal(evidence.hoverObservations.afterHovered, false);
  assert.equal(evidence.hoverObservations.movePointInsideBeforeRect, true); assert.equal(evidence.hoverObservations.movePointInsideAfterRect, false);
});

test("absent optional mouse fields use protocol defaults, while explicit null and non-default values do not", () => {
  const f = fixture(); for (const index of [0, 4]) for (const field of ["button", "buttons", "clickCount", "modifiers", "pointerType"]) delete f.records[index].args[2][field];
  assert.equal(f.evidence().experimentObserved, true);
  for (const [field, value] of [["button", null], ["buttons", null], ["button", "left"], ["buttons", 1], ["modifiers", 2], ["pointerType", "pen"], ["clickCount", 1]]) {
    const changed = fixture(); changed.records[0].args[2][field] = value;
    assert.equal(changed.evidence().collectionComplete, true); assert.equal(changed.evidence().experimentObserved, false);
  }
});

test("every real native move is counted; duplicate moves, keys, extra insertion and DOM.focus are not accepted", () => {
  for (const [method, params] of [["Input.dispatchMouseEvent", { type: "mouseMoved", x: 150, y: 100 }], ["Input.dispatchKeyEvent", { type: "keyDown", key: "a" }], ["Input.insertText", { text: note }], ["DOM.focus", { nodeId: 7 }]]) {
    const f = fixture(); f.add(method, params, -60000);
    assert.equal(f.evidence().collectionComplete, true); assert.equal(f.evidence().experimentObserved, false);
  }
});

test("wrong tab/session/text, mouse buttons, order and failed ACK remain visible without claiming a valid experiment", () => {
  const changes = [
    f => { f.records[0].target = { tabId: 45 }; f.records[0].args[0] = { tabId: 45 }; },
    f => { f.records[2].target = { tabId, sessionId: "child" }; f.records[2].args[0] = { tabId, sessionId: "child" }; },
    f => { f.records[2].args[2].text = "wrong text"; },
    f => { f.records[6].args[2].button = "right"; },
    f => { f.records[1].sequence = 3; },
    f => { f.records[6].sequence = 2; },
    f => { f.records[9].kind = "error"; f.records[9].error = { message: "original browser error" }; delete f.records[9].result; },
  ];
  for (const change of changes) { const f = fixture(); change(f); const evidence = f.evidence(); assert.equal(evidence.experimentObserved, false); assert.equal(evidence.inputCommands.length, 5); }
});

test("pending, duplicate settlement and truncated critical payloads cannot claim collection complete", () => {
  const changes = [f => { f.records.splice(1, 1); }, f => { f.records.push(structuredClone(f.records[1])); }, f => { f.records[0].args[2] = { diagnosticTruncated: true }; }, f => { f.records[2].target = { diagnosticTruncated: true }; }, f => { f.records[0].args[0] = { tabId: 45 }; }];
  for (const change of changes) { const f = fixture(); change(f); assert.equal(f.evidence().collectionComplete, false); assert.equal(f.evidence().experimentObserved, false); }
});

test("all Submit mouse starts may precede their ACKs and still preserve the declared native order", () => {
  const f = fixture(), starts = f.records.filter(record => record.kind === "start" && record.callId >= 3);
  for (const [index, start] of starts.entries()) { start.sequence = 4 + index; f.records.find(record => record.kind === "settled" && record.callId === start.callId).sequence = 7 + index; }
  f.records.sort((left, right) => left.sequence - right.sequence);
  assert.equal(f.evidence().nativeInputSequenceMatch, true); assert.equal(f.evidence().experimentObserved, true);
});

test("object key order and arbitrarily shifted native wall clocks never alter sequence-based conclusions", () => {
  for (const shift of [-60000, 60000]) {
    const f = fixture(); for (const record of f.records) record.at += shift;
    f.records[0].args[2] = Object.fromEntries(Object.entries(f.records[0].args[2]).reverse());
    const evidence = f.evidence(); assert.equal(evidence.experimentObserved, true);
    assert.ok(evidence.inputCommands.every(command => command.withinHoverTimeWindow === false && command.withinFillTimeWindow === false && command.withinSubmitTimeWindow === false));
  }
});

test("document/node continuity, snapshot prefix, original three phases and complete hover observations are required", () => {
  const changes = [
    f => { f.detail.before.document.inputDiagnostic.documentId = "replacement"; },
    f => { f.detail.before.document.inputDiagnostic.originalNote.nodeId = 999; },
    f => { f.detail.before.document.inputDiagnostic.records.push({ sequence: 0 }); },
    f => { f.inputSnapshots[0].phase = "after-hover"; },
    f => { f.detail.after.document = structuredClone(f.detail.after.document); f.detail.after.document.inputDiagnostic.state.value = "changed"; },
    f => { delete f.detail.after.document.noteHovered; },
    f => { f.detail.before.document.noteRect = null; },
    f => { f.detail.before.document.inputDiagnostic.overflow = true; },
    f => { f.detail.before.document.inputDiagnostic.truncations = 1; },
  ];
  for (const change of changes) { const f = fixture(); change(f); assert.equal(f.evidence().collectionComplete, false); }
});

test("nonempty input or disconnected original node is an observed failed precondition, never silently corrected", () => {
  for (const change of [f => { f.detail.before.document.inputDiagnostic.state.value = "preexisting"; }, f => { f.detail.before.document.inputDiagnostic.originalNote.connected = false; }]) {
    const f = fixture(); change(f); assert.equal(f.evidence().collectionComplete, true); assert.equal(f.evidence().emptyOriginalNodePrecondition, false); assert.equal(f.evidence().experimentObserved, false);
  }
});

test("local action duplication/reordering and missing original INPUT completion stay distinct from task success", () => {
  for (const change of [f => { f.steps.push({ ...f.steps[0] }); }, f => { f.steps.push({ operation: "domFocus" }); }, f => { f.steps[0].completedAt = 31; }, f => { delete f.steps[0].completedAt; }]) {
    const f = fixture(); change(f); assert.equal(f.evidence().experimentObserved, false);
  }
  const evidence = fixture().evidence();
  assert.equal(hoverFocusDiagnosticResult({ inputResult: { diagnosticCompleted: false }, evidence }).diagnosticCompleted, false);
  assert.equal(hoverFocusDiagnosticResult({ inputResult: { diagnosticCompleted: true }, evidence: { ...evidence, experimentObserved: false } }).diagnosticCompleted, false);
  assert.equal(hoverFocusDiagnosticResult({ inputResult: { diagnosticCompleted: true }, evidence }).passed, false);
});

test("missing original-node descriptor fields remain unknown instead of passing from nodeId alone", () => {
  for (const path of ["originalNote", "state.originalNote", "state.currentNote"]) for (const key of ["nodeId", "tag", "id", "type", "originalNote", "currentNote", "connected"]) {
    const f = fixture(); const node = path.split(".").reduce((value, part) => value[part], f.detail.before.document.inputDiagnostic); delete node[key];
    assert.equal(f.evidence().collectionComplete, false); assert.equal(f.evidence().experimentObserved, false);
  }
  for (const change of [node => { node.type = "password"; }, node => { node.id = "other"; }]) {
    const f = fixture(); change(f.detail.before.document.inputDiagnostic.state.currentNote); assert.equal(f.evidence().collectionComplete, false);
  }
  const f = fixture(); f.detail.before.document.inputDiagnostic.state.originalNote.currentNote = false;
  assert.equal(f.evidence().collectionComplete, true); assert.equal(f.evidence().experimentObserved, false);
});

test("expected text must retain the exact native-vivaldi prefix and lowercase 24-hex nonce", () => {
  for (const badNote of [`other--vivaldi-${nonce}`, `native-vivaldi-${nonce.toUpperCase()}`, `native-vivaldi-${"g".repeat(24)}`]) {
    const f = fixture(); f.records[2].args[2].text = badNote;
    const evidence = hoverFocusCommandEvidence({ records: f.records }, { tabId, note: badNote, steps: f.steps, detail: f.detail, inputSnapshots: f.inputSnapshots });
    assert.equal(evidence.insertTextMatchesExpected, false); assert.equal(evidence.collectionComplete, false); assert.equal(evidence.experimentObserved, false);
  }
});
