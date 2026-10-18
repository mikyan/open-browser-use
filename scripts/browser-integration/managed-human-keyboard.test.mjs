import assert from "node:assert/strict";
import test from "node:test";
import { humanKeyboardCases, assertManagedHumanKeyboardCase, assertManagedHumanKeyboardValues, assertManagedHumanKeyboardLedger } from "./managed-human-keyboard.mjs";

function controls(complete = false) {
  return Object.fromEntries(humanKeyboardCases.map(spec => [spec.id, spec.kind === "contenteditable"
    ? { kind: spec.kind, textContent: spec.initial, innerHTML: spec.initial + (complete ? "<div><br></div>" : ""), innerText: spec.initial + (complete ? "\n\n" : ""), lineBreaks: complete ? 2 : 0 }
    : { kind: spec.kind, value: complete && spec.kind === "textarea" ? spec.expectedValue : spec.initial }]));
}
function proof(spec) {
  const scope = { leaseId: "original", generation: 3 }, before = { documentId: "original-document", activeElement: spec.id,
    state: { documentToken: "original-token", workflowId: "flow", eventOverflow: false, heldKeys: [], submits: 0, events: [], controls: controls() } };
  const after = structuredClone(before); after.state.controls[spec.id] = controls(true)[spec.id];
  const event = (type, values = {}) => ({ type, target: spec.id, trusted: true, defaultPrevented: false, ...values });
  const key = { key: "Enter", code: spec.code, charCode: 0, repeat: false, shiftKey: spec.shift };
  const events = [event("keydown", { ...key, defaultPrevented: spec.kind === "prevented" })];
  if (spec.shift) events.unshift(event("keydown", { key: "Shift", code: "ShiftLeft", repeat: false, shiftKey: true }));
  if (spec.kind !== "prevented") events.push(event("keypress", { ...key, charCode: 13 }));
  if (spec.kind === "submit") { events.push(event("submit", { target: "submit-form", defaultPrevented: true })); after.state.submits = 1; }
  else if (spec.kind !== "prevented") events.push(event("beforeinput", { inputType: spec.inputType, isComposing: false }), event("input", { inputType: spec.inputType, isComposing: false }));
  events.push(event("keyup", key));
  if (spec.shift) events.push(event("keyup", { key: "Shift", code: "ShiftLeft", repeat: false, shiftKey: false }));
  after.state.events = events.map((row, i) => ({ ...row, sequence: i + 1 }));
  const transitions = spec.shift ? [["ShiftLeft", "down"], [spec.code, "down"], [spec.code, "up"], ["ShiftLeft", "up"]] : [[spec.code, "down"], [spec.code, "up"]];
  const commands = transitions.map(([code, action], i) => ({ id: i + 10, operation: "humanInput", connection: 2, ...scope, sequence: i + 20, input: { type: "key", code, action } }));
  const replies = commands.map(row => ({ type: "response", id: row.id, connection: row.connection, result: { inputReceipt: { ...scope, sequence: row.sequence, acknowledged: true } } }));
  return { case: spec, before, after, commands, replies, scope };
}

test("all seven keyboard outcomes use native key events and original receipts without inserted newline text", () => {
  assert.equal(humanKeyboardCases.length, 7);
  for (const spec of humanKeyboardCases) assert.equal(assertManagedHumanKeyboardCase(proof(spec)).caseId, spec.id);
  assert.doesNotThrow(() => assertManagedHumanKeyboardValues(controls(true)));
});

test("unchanged textarea, duplicate newline, missing keypress and extra submitted text fail", () => {
  for (const mutate of [
    row => { row.after.state.controls[row.case.id].value = row.case.initial; },
    row => { row.after.state.controls[row.case.id].value += "\n"; },
    row => { row.after.state.events = row.after.state.events.filter(event => event.type !== "keypress"); },
    row => { row.commands.push({ ...row.commands[0], id: 99, input: { type: "text", text: "\n" } }); },
    row => { row.replies[0].result.inputReceipt.acknowledged = false; },
    row => { row.after.documentId = "successor"; },
    row => { row.after.state.documentToken = "successor"; },
    row => { row.after.state.events.find(event => event.type === "beforeinput").trusted = false; },
    row => { row.after.state.events.find(event => event.type === "input").inputType = "insertText"; }
  ]) { const row = proof(humanKeyboardCases[0]); mutate(row); assert.throws(() => assertManagedHumanKeyboardCase(row)); }
});

test("contenteditable retains raw HTML and original text while requiring native line structure and inputType", () => {
  for (const spec of humanKeyboardCases.filter(row => row.kind === "contenteditable")) for (const mutate of [
    row => { row.after.state.controls[spec.id].innerHTML = spec.initial; },
    row => { row.after.state.controls[spec.id].textContent = spec.initial + "wrong"; },
    row => { row.after.state.controls[spec.id].lineBreaks = 0; },
    row => { row.after.state.events.find(event => event.type === "input").inputType = "insertText"; }
  ]) { const row = proof(spec); mutate(row); assert.throws(() => assertManagedHumanKeyboardCase(row)); }
});

test("preventDefault and implicit submission cannot be replaced by injected text or repeated submits", () => {
  const cancelled = proof(humanKeyboardCases.find(row => row.kind === "prevented"));
  for (const mutate of [
    row => { row.after.state.events[0].defaultPrevented = false; },
    row => { row.after.state.events.push({ type: "input" }); },
    row => { row.after.state.submits = 1; },
    row => { row.after.state.controls[row.case.id].value += "\n"; }
  ]) { const row = structuredClone(cancelled); mutate(row); assert.throws(() => assertManagedHumanKeyboardCase(row)); }
  const submitted = proof(humanKeyboardCases.find(row => row.kind === "submit"));
  for (const mutate of [
    row => { row.after.state.submits = 2; },
    row => { row.after.state.events.find(event => event.type === "submit").trusted = false; },
    row => { row.after.state.events.push({ ...row.after.state.events.find(event => event.type === "submit") }); }
  ]) { const row = structuredClone(submitted); mutate(row); assert.throws(() => assertManagedHumanKeyboardCase(row)); }
});

test("whole-page ledger rejects an extra input between case snapshots and duplicate submission", () => {
  const scope = { leaseId: "original", generation: 3 }, events = [], commands = [], replies = [];
  for (const spec of humanKeyboardCases) {
    const row = proof(spec);
    // This fixture constructs a complete original event ledger directly; the
    // ledger verifier does not manufacture per-case before/after snapshots.
    events.push(...row.after.state.events);
    for (const command of row.commands) {
      const id = commands.length + 50, sequence = commands.length + 100;
      const input = { ...command.input, key: command.input.code === "ShiftLeft" ? "Shift" : "Enter", windowsVirtualKeyCode: command.input.code === "ShiftLeft" ? 16 : 13 };
      commands.push({ ...command, id, sequence, input });
      replies.push({ type: "response", connection: command.connection, id, result: { inputReceipt: { ...scope, sequence, acknowledged: true } } });
    }
  }
  const original = { documentId: "original-document", state: { documentToken: "token", workflowId: "workflow", events: [] } };
  const after = { documentId: original.documentId, state: { ...original.state, events: events.map((row, i) => ({ ...row, sequence: i + 1 })), controls: controls(true), eventOverflow: false, submits: 1, heldKeys: [], heldButtons: [] } };
  const value = { original, after, commands, replies, scope };
  assert.equal(assertManagedHumanKeyboardLedger(value).inputs, 5);
  for (const mutate of [
    row => { row.after.state.events.push({ ...row.after.state.events.find(event => event.type === "input" && event.target === "editable-enter"), sequence: row.after.state.events.length + 1 }); },
    row => { row.after.state.events.push({ ...row.after.state.events.find(event => event.type === "submit"), sequence: row.after.state.events.length + 1 }); },
    row => { row.after.state.events.push({ ...row.after.state.events.find(event => event.type === "keypress"), sequence: row.after.state.events.length + 1 }); },
    row => { row.replies[0].result.inputReceipt.generation++; },
    row => { row.commands.push({ ...row.commands[0], id: 999, sequence: 999 }); },
    row => { row.after.state.controls["textarea-enter"].value += "\n"; }
  ]) { const changed = structuredClone(value); mutate(changed); assert.throws(() => assertManagedHumanKeyboardLedger(changed)); }
});
