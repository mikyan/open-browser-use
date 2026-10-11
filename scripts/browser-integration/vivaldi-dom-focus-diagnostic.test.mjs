import assert from "node:assert/strict";
import test from "node:test";
import { vivaldiDOMFocusEnabled, runDOMFocusDiagnostic, domFocusCommandEvidence, domFocusDiagnosticResult } from "./vivaldi-dom-focus-diagnostic.mjs";
import { installInputEventDiagnostic } from "./vivaldi-input-diagnostic.mjs";

const tabId = 44, nonce = "0123456789abcdef01234567", url = `http://127.0.0.1/task?nonce=${nonce}`;
const methods = ["DOM.getDocument", "DOM.querySelector", "DOM.describeNode", "DOM.focus"];
const responses = () => [{ root: { nodeId: 1, backendNodeId: 100, nodeType: 9, nodeName: "#document", localName: "", documentURL: url, frameId: "root-frame" } }, { nodeId: 7 }, { node: { nodeId: 7, backendNodeId: 107, nodeType: 1, nodeName: "INPUT", localName: "input", attributes: ["class", "id", "id", "note"] } }, {}];

test("DOM_FOCUS is explicitly enabled, Vivaldi-only and exclusive with all old modes", () => {
  for (const value of [undefined, "", "0"]) assert.equal(vivaldiDOMFocusEnabled(value, { name: "opera", input: true }), false);
  assert.equal(vivaldiDOMFocusEnabled("1", { name: "vivaldi" }), true);
  for (const value of [true, "true", "2", 1, null]) assert.throws(() => vivaldiDOMFocusEnabled(value, { name: "vivaldi" }));
  for (const change of [{ name: "brave" }, ...["input", "taskReadiness", "keyInput", "pointerFocus", "readiness", "nativeDiagnostics", "ownership"].map(key => ({ [key]: true }))]) assert.throws(() => vivaldiDOMFocusEnabled("1", { name: "vivaldi", ...change }));
});

test("four public calls use exact node identities and one diminishing declared budget", async () => {
  const values = responses(), calls = [], record = {}; let time = 100;
  await runDOMFocusDiagnostic({ tabId, url, record, now: () => time, call: async (method, params, options) => { calls.push({ method, params, options }); time += 10; return values.shift(); } });
  assert.deepEqual(calls.map(value => value.method), methods);
  assert.deepEqual(calls.map(value => value.params), [{ depth: 0 }, { nodeId: 1, selector: "#note" }, { nodeId: 7, depth: 0 }, { nodeId: 7 }]);
  assert.deepEqual(calls.map(value => value.options.timeoutMs), [5000, 4990, 4980, 4970]);
  assert.equal(record.completed, true); assert.equal(record.deadline, 5100); assert.equal(record.completedAt, 140);
  assert.equal(record.operations.length, 4); assert.equal(record.documentNodeId, 1); assert.equal(record.nodeId, 7);
  await assert.rejects(runDOMFocusDiagnostic({ tabId, url, record, call: () => { throw new Error("must not replay"); } }), /cannot be replayed/);
});

test("wrong document, missing node and changed described identity stop before DOM.focus without fallback", async () => {
  const changes = [values => { values[0].root.documentURL = `${url}&other=1`; }, values => { values[1].nodeId = 0; }, values => { values[2].node.nodeId = 8; }, values => { values[2].node.localName = "textarea"; }, values => { values[2].node.attributes = ["id", "other"]; }, values => { values[2].node.attributes = ["id", "note", "id", "note"]; }];
  for (const change of changes) {
    const values = responses(), calls = [], record = {}; change(values);
    await assert.rejects(runDOMFocusDiagnostic({ tabId, url, record, call: async method => { calls.push(method); return values.shift(); } }));
    assert.equal(record.completed, false); assert.equal(record.stage, "failed"); assert.ok(!calls.includes("DOM.focus"));
    assert.equal(new Set(calls).size, calls.length);
  }
});

test("a synchronous or rejected public call keeps the original error and never sends the next command", async () => {
  for (const synchronous of [false, true]) {
    const error = new Error("original public call error"), calls = [], record = {};
    await assert.rejects(runDOMFocusDiagnostic({ tabId, url, record, call(method) { calls.push(method); if (synchronous) throw error; return Promise.reject(error); } }), value => value === error);
    assert.deepEqual(calls, ["DOM.getDocument"]); assert.match(record.operations[0].error, /original public call error/);
  }
});

test("a completed read after the absolute deadline cannot trigger a subsequent command", async () => {
  let time = 1; const calls = [], record = {};
  await assert.rejects(runDOMFocusDiagnostic({ tabId, url, record, budgetMs: 100, now: () => time, call: async method => { calls.push(method); time = 101; return responses()[0]; } }), /deadline expired/);
  assert.deepEqual(calls, ["DOM.getDocument"]); assert.equal(record.operations[0].completedAt, undefined);
});

test("a genuinely pending call is bounded, and late completion neither continues nor overwrites failure", async () => {
  let release; const calls = [], record = {}, held = new Promise(resolve => { release = resolve; });
  await assert.rejects(runDOMFocusDiagnostic({ tabId, url, record, budgetMs: 20, call: method => { calls.push(method); return held; } }), /deadline expired/);
  const failed = structuredClone(record); release(responses()[0]); await held; await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ["DOM.getDocument"]); assert.deepEqual(record, failed);
});

test("oversized identity results fail closed without retaining unrelated document trees", async () => {
  const values = responses(), record = {}; values[0].root.children = [{ privateUnrelatedData: "not retained" }];
  await runDOMFocusDiagnostic({ tabId, url, record, call: async () => values.shift() });
  assert.equal(record.operations[0].result.root.children, undefined);
  const bad = responses(); bad[2].node.attributes.push("data-unexpected", "x".repeat(513)); const calls = [];
  await assert.rejects(runDOMFocusDiagnostic({ tabId, url, record: {}, call: async method => { calls.push(method); return bad.shift(); } }), /oversized DOM attributes/);
  assert.ok(!calls.includes("DOM.focus"));
});

function passiveFixture() {
  const note = { localName: "input", id: "note", type: "text", isConnected: true, value: "", selectionStart: 0, selectionEnd: 0, selectionDirection: "none" };
  const document = { location: { href: url }, readyState: "complete", visibilityState: "hidden", activeElement: null, hasFocus: () => false, querySelector: () => note, addEventListener() {}, removeEventListener() {} };
  const controller = installInputEventDiagnostic(document, { crypto: { randomUUID: () => "original-document" } }, nonce, { clock: () => 1, monotonic: () => 1 });
  return { controller, note, document };
}
async function evidenceFixture() {
  const dom = passiveFixture(), before = { phase: "before-dom-focus", requestedAt: 1, completedAt: 2, document: { inputDiagnostic: dom.controller.snapshot() } };
  const detail = { before, expectedNote: `native-vivaldi-${nonce}` }, records = [], values = responses(); let time = 10, sequence = 0, callId = 0;
  const call = async (method, params) => {
    const id = ++callId, target = { tabId }; records.push({ kind: "start", sequence: sequence++, callId: id, at: time++, api: "debugger.sendCommand", method, target, args: [target, method, structuredClone(params)] });
    const result = values.shift(); records.push({ kind: "settled", sequence: sequence++, callId: id, at: time++, api: "debugger.sendCommand", method, target, result: structuredClone(result) }); return result;
  };
  await runDOMFocusDiagnostic({ tabId, url, record: detail, call, now: () => time });
  const steps = [{ operation: "domFocus", requestedAt: 9, completedAt: 20 }, { operation: "fill", requestedAt: 30, completedAt: 40 }, { operation: "click", requestedAt: 50, completedAt: 60 }];
  const inputSnapshots = ["before-fill", "after-fill", "final"].map((phase, index) => ({ phase, requestedAt: 25 + index * 20, completedAt: 26 + index * 20, snapshot: dom.controller.snapshot() }));
  const addInput = (method, at, target = { tabId }, params = {}) => { const id = ++callId; records.push({ kind: "start", sequence: sequence++, callId: id, at, api: "debugger.sendCommand", method, target, args: [target, method, params] }, { kind: "settled", sequence: sequence++, callId: id, at: at + 1, result: {} }); };
  addInput("Input.insertText", 31, { tabId }, { text: `native-vivaldi-${nonce}` });
  for (const [index, type] of ["mouseMoved", "mousePressed", "mouseReleased"].entries()) addInput("Input.dispatchMouseEvent", 51 + index, { tabId }, { type });
  const options = { tabId, steps, detail, inputSnapshots };
  return { dom, detail, records, steps, inputSnapshots, options, addInput, evidence: () => domFocusCommandEvidence({ records }, options) };
}

test("native chain, separate extra snapshot and original INPUT three snapshots prove the experiment without inventing editing", async () => {
  const f = await evidenceFixture(), evidence = f.evidence();
  assert.equal(evidence.collectionComplete, true); assert.equal(evidence.experimentObserved, true); assert.equal(evidence.focusCommandCount, 1);
  assert.equal(evidence.nativeCommandMatch, true); assert.equal(evidence.beforeComplete, true); assert.equal(evidence.experimentalPreconditions, true);
  assert.equal(f.inputSnapshots.length, 3); assert.equal(f.inputSnapshots[2].snapshot.state.value, "", "No input success is synthesized from ACKs");
  assert.equal(f.detail.nodeId, 7); assert.equal(f.detail.before.document.inputDiagnostic.originalNote.nodeId, 1, "CDP and passive node IDs are not equated");
  assert.deepEqual(domFocusDiagnosticResult({ inputResult: { diagnosticCompleted: true }, evidence }), { passed: false, collectionComplete: true, experimentObserved: true, diagnosticCompleted: true, exitCode: 0 });
});

test("wrong native root or response stays visible and complete but does not match the declared experiment", async () => {
  for (const mutation of [f => { f.records[6].target = { tabId, sessionId: "child" }; f.records[6].args[0] = f.records[6].target; }, f => { f.records[3].result.nodeId = 8; }]) {
    const f = await evidenceFixture(); mutation(f); const evidence = f.evidence();
    assert.equal(evidence.collectionComplete, true); assert.equal(evidence.nativeCommandMatch, false); assert.equal(evidence.experimentObserved, false);
  }
});

test("missing, ambiguous or truncated native identity evidence cannot claim collection complete", async () => {
  for (const mutation of [f => { f.records.splice(1, 1); }, f => { f.records[1].result.root.documentURL = { diagnosticTruncated: true }; }, f => { f.records[5].result = {}; }, f => { f.records.push(structuredClone(f.records[7])); }]) {
    const f = await evidenceFixture(); mutation(f); assert.equal(f.evidence().collectionComplete, false);
  }
});

test("already-focused input, extra native input, duplicate public action and unknown windows are not silently corrected", async () => {
  for (const mutation of [f => { f.detail.before.document.inputDiagnostic.state.activeElement = f.detail.before.document.inputDiagnostic.originalNote; }, f => f.addInput("Input.dispatchMouseEvent", 5), f => f.addInput("Input.dispatchKeyEvent", 31), f => f.addInput("Input.insertText", 39), f => f.steps.push({ ...f.steps[0] }), f => { delete f.steps[0].completedAt; }]) {
    const f = await evidenceFixture(); mutation(f); const evidence = f.evidence();
    assert.equal(evidence.collectionComplete, true); assert.equal(evidence.experimentObserved, false);
  }
});

test("missing active-element identity stays unknown, while a recorded null or different node proves unfocused", async () => {
  for (const value of [undefined, {}, { nodeId: 2 }, { nodeId: 0, tag: "body", id: "", originalNote: false, currentNote: false, connected: true }]) {
    const f = await evidenceFixture(); if (value === undefined) delete f.detail.before.document.inputDiagnostic.state.activeElement; else f.detail.before.document.inputDiagnostic.state.activeElement = value;
    const evidence = f.evidence(); assert.equal(evidence.initialFocusState, "unknown"); assert.equal(evidence.originalNodeInitiallyFocused, null); assert.equal(evidence.collectionComplete, false); assert.equal(evidence.experimentObserved, false);
  }
  for (const value of [null, { nodeId: 2, tag: "body", id: "", originalNote: false, currentNote: false, connected: true }]) {
    const f = await evidenceFixture(); f.detail.before.document.inputDiagnostic.state.activeElement = value;
    assert.equal(f.evidence().initialFocusState, "unfocused"); assert.equal(f.evidence().experimentObserved, true);
  }
});

test("a wrong or missing insertText parameter is retained but does not establish the unchanged input experiment", async () => {
  for (const text of [undefined, "wrong-note"]) {
    const f = await evidenceFixture(), insert = f.records.find(record => record.kind === "start" && record.method === "Input.insertText");
    insert.args[2].text = text; const evidence = f.evidence();
    assert.equal(evidence.collectionComplete, true); assert.equal(evidence.singleOriginalInsertText, true); assert.equal(evidence.insertTextMatchesExpected, false); assert.equal(evidence.experimentObserved, false);
  }
});

test("replaced document/node, changed event prefix, late extra snapshot and capture failure cannot qualify", async () => {
  for (const mutation of [f => { f.detail.before.document.inputDiagnostic.documentId = "replacement"; }, f => { f.detail.before.document.inputDiagnostic.originalNote.nodeId = 999; }, f => { f.detail.before.document.inputDiagnostic.records.push({ sequence: 0 }); }, f => { f.detail.before.completedAt = f.detail.requestedAt + 1; }, f => { f.detail.before.document.inputDiagnostic.truncations = 1; }]) {
    const f = await evidenceFixture(); mutation(f); assert.equal(f.evidence().collectionComplete, false);
  }
  assert.equal(domFocusDiagnosticResult({ inputResult: { diagnosticCompleted: false }, evidence: { collectionComplete: true, experimentObserved: true } }).diagnosticCompleted, false);
  assert.equal(domFocusDiagnosticResult({ inputResult: { diagnosticCompleted: true }, evidence: { collectionComplete: true, experimentObserved: false } }).passed, false);
});

test("object field order is semantic but attribute-array order and actual values must still match", async () => {
  const f = await evidenceFixture();
  f.records[4].args[2] = { depth: 0, nodeId: 7 };
  f.records[1].result.root = Object.fromEntries(Object.entries(f.records[1].result.root).reverse());
  assert.equal(f.evidence().nativeCommandMatch, true); assert.equal(f.evidence().experimentObserved, true);
  for (const attributes of [["id", "class", "id", "note"], ["class", "id", "id", "other"]]) {
    const changed = await evidenceFixture(); changed.records[5].result.node.attributes = attributes;
    assert.equal(changed.evidence().collectionComplete, true); assert.equal(changed.evidence().nativeCommandMatch, false); assert.equal(changed.evidence().experimentObserved, false);
  }
});

test("large positive or negative native clock offsets change observations but never sequence-based experiment conclusions", async () => {
  for (const offset of [-60000, 60000]) {
    const f = await evidenceFixture(); for (const record of f.records) record.at += offset;
    const evidence = f.evidence();
    assert.ok(evidence.commands.every(command => command.operationIndexes.length === 0));
    assert.equal(evidence.singleOriginalInsertText, false); assert.equal(evidence.mouseOutsideSubmit.length, 3);
    assert.equal(evidence.nativeChainComplete, true); assert.equal(evidence.nativeCommandMatch, true); assert.equal(evidence.nativeInputSequenceMatch, true); assert.equal(evidence.experimentObserved, true);
  }
  const f = await evidenceFixture(); f.records[7].at = f.detail.operations[3].completedAt + 1;
  assert.equal(f.evidence().nativeCommandMatch, true, "Cross-context +1ms completion is not a native ordering failure");
});

test("the entire native chain rejects extra commands, changed nodes, wrong roots and reordered inputs independently of time windows", async () => {
  const mutations = [
    f => f.records.push({ ...structuredClone(f.records[4]), callId: 999, sequence: 999, at: -100000 }),
    f => { f.records[6].args[2].nodeId = 999; },
    f => { f.records[7].result = { unexpected: true }; },
    f => { f.records.find(record => record.kind === "start" && record.method === "Input.insertText").target = { tabId, sessionId: "child" }; },
    f => { f.records.find(record => record.kind === "start" && record.method === "Input.insertText").sequence = 6; },
    f => { f.records.find(record => record.kind === "start" && record.args?.[2]?.type === "mousePressed").sequence = 9; },
    f => { f.records.find(record => record.kind === "start" && record.args?.[2]?.type === "mouseReleased").args[2].type = "mousePressed"; },
    f => { f.records.find(record => record.kind === "settled" && record.callId === 7).kind = "error"; },
  ];
  for (const mutation of mutations) { const f = await evidenceFixture(); mutation(f); assert.equal(f.evidence().experimentObserved, false); }
});

test("Submit mouse starts may precede earlier mouse ACKs, while local awaited order and deadline remain strict", async () => {
  const f = await evidenceFixture(), starts = f.records.filter(record => record.kind === "start" && record.method === "Input.dispatchMouseEvent");
  for (const [index, start] of starts.entries()) { start.sequence = 10 + index; f.records.find(record => record.kind === "settled" && record.callId === start.callId).sequence = 13 + index; }
  f.records.sort((left, right) => left.sequence - right.sequence);
  assert.equal(f.evidence().nativeInputSequenceMatch, true); assert.equal(f.evidence().experimentObserved, true);
  for (const mutation of [value => { value.detail.operations[1].requestedAt = value.detail.operations[0].completedAt - 1; }, value => { value.detail.deadline = value.detail.completedAt; }]) {
    const changed = await evidenceFixture(); mutation(changed); assert.equal(changed.evidence().collectionComplete, false); assert.equal(changed.evidence().experimentObserved, false);
  }
});
