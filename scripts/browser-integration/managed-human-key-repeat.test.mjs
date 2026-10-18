import assert from "node:assert/strict";
import test from "node:test";
import { humanKeyRepeatCases, nativeKeyRepeatGesture, assertManagedKeyRepeatCase, assertManagedKeyRepeatLedger, installManagedKeyRepeatObserver } from "./managed-human-key-repeat.mjs";

const scope = { leaseId: "original", generation: 2, keyRepeatVersion: 1 };
const controls = () => Object.fromEntries(humanKeyRepeatCases.map(row => [row.id, { value: row.initial, selectionStart: row.anchor === "End" ? 6 : 0, selectionEnd: row.anchor === "End" ? 6 : 0 }]));
function proof(spec, start = 1) {
  const before = { documentId: "original-document", activeElement: spec.id, state: { documentToken: "original-token", events: [], eventOverflow: false, heldKeys: [], heldButtons: [], controls: controls() } };
  const after = structuredClone(before), events = [];
  const push = (type, fields = {}) => events.push({ sequence: events.length + 1, target: spec.id, type, trusted: true, defaultPrevented: false, ...fields });
  for (const repeat of [false, true, true]) {
    push("keydown", { key: spec.key, code: spec.key, repeat, defaultPrevented: Boolean(spec.prevented) });
    if (spec.inputType) for (const type of ["beforeinput", "input"]) push(type, { inputType: spec.inputType, isComposing: false });
  }
  if (!spec.held) push("keyup", { key: spec.key, code: spec.key, repeat: false });
  after.state.events = events; after.state.heldKeys = spec.held ? [spec.key] : [];
  after.state.controls[spec.id] = { value: spec.expectedValue, selectionStart: spec.expectedSelection, selectionEnd: spec.expectedSelection };
  const commands = nativeKeyRepeatGesture(spec).map((row, i) => ({ id: start + i, connection: 1, operation: "humanInput", ...scope, sequence: start + i,
    input: { type: "key", key: row.key, code: row.code, windowsVirtualKeyCode: row.windowsVirtualKeyCode, action: row.type === "keyDown" ? "down" : "up", ...(row.autoRepeat ? { repeat: true } : {}) } }));
  const replies = commands.map(row => ({ type: "response", id: row.id, connection: 1, result: { inputReceipt: { leaseId: scope.leaseId, generation: scope.generation, sequence: row.sequence, acknowledged: true } } }));
  const nativeCommands = nativeKeyRepeatGesture(spec).map(params => ({ method: "Input.dispatchKeyEvent", params, startedAt: 1, acknowledgedAt: 2, result: {} }));
  const viewerBefore = { active: true, overflow: false, events: [] }, viewerAfter = { active: true, overflow: false,
    events: nativeKeyRepeatGesture(spec).map(row => ({ type: row.type === "keyDown" ? "keydown" : "keyup", code: row.code, repeat: row.autoRepeat, trusted: true })) };
  return { case: spec, definition: spec, before, after, commands, replies, scope, nativeCommands, viewerBefore, viewerAfter };
}

test("six native repeat outcomes require original viewer events, exact repeat wire and original receipts", () => {
  for (const spec of humanKeyRepeatCases) assert.equal(assertManagedKeyRepeatCase(proof(spec)).caseId, spec.id);
});

test("dropped repeat, fabricated native repeat, extra text, changed document and false ACK fail", () => {
  for (const mutate of [
    row => { row.commands.splice(1, 1); }, row => { delete row.commands[1].input.repeat; },
    row => { row.commands[0].input.repeat = false; }, row => { row.commands[3].input.repeat = true; },
    row => { row.nativeCommands[1].params.autoRepeat = false; }, row => { row.viewerAfter.events[1].trusted = false; },
    row => { row.after.state.events.find(event => event.type === "input").inputType = "insertText"; },
    row => { row.after.state.controls[row.case.id].value = "abcde"; }, row => { row.after.documentId = "successor"; },
    row => { row.replies[1].result.inputReceipt.acknowledged = false; }, row => { row.scope = { ...scope, keyRepeatVersion: undefined }; }
  ]) { const row = proof(humanKeyRepeatCases[0]); mutate(row); assert.throws(() => assertManagedKeyRepeatCase(row)); }
});

test("prevented keys cannot edit and held final key cannot claim an early release", () => {
  for (const mutate of [row => { row.after.state.events[0].defaultPrevented = false; }, row => { row.after.state.events.push({ sequence: 5, type: "input", target: row.case.id, trusted: true }); }]) {
    const row = proof(humanKeyRepeatCases[4]); mutate(row); assert.throws(() => assertManagedKeyRepeatCase(row));
  }
  const held = proof(humanKeyRepeatCases[5]); held.after.state.heldKeys = []; assert.throws(() => assertManagedKeyRepeatCase(held));
});

function ledger() {
  const original = { documentId: "original-document", state: { documentToken: "original-token", events: [] } };
  const after = { documentId: original.documentId, state: { ...original.state, controls: controls(), heldKeys: [], heldButtons: [], eventOverflow: false, events: [] } };
  const cases = [], replies = []; let id = 1;
  for (const spec of humanKeyRepeatCases) {
    const row = proof(spec, id); id += row.commands.length; cases.push(row); replies.push(...row.replies);
    const key = { target: spec.id, trusted: true, key: spec.anchor, code: spec.anchor, repeat: false };
    after.state.events.push({ ...key, type: "keydown" }, { ...key, type: "keyup" }, ...row.after.state.events);
    if (spec.held) after.state.events.push({ target: spec.id, type: "keyup", key: spec.key, code: spec.key, repeat: false, trusted: true });
    after.state.controls[spec.id] = row.after.state.controls[spec.id];
  }
  after.state.events.forEach((row, index) => { row.sequence = index + 1; });
  return { original, after, cases, replies, scope };
}

test("whole task ledger rejects late duplicate edits, unknown keys/targets and missing End release", () => {
  assert.equal(assertManagedKeyRepeatLedger(ledger()).inputs, 9);
  for (const mutate of [
    row => { row.after.state.events.push({ ...row.after.state.events.find(event => event.type === "input"), sequence: row.after.state.events.length + 1 }); },
    row => { row.after.state.events.push({ type: "keydown", key: "Escape", code: "Escape", target: "repeat-backspace", trusted: true, repeat: false, sequence: row.after.state.events.length + 1 }); },
    row => { row.after.state.events[0].target = "other"; }, row => { row.after.state.events.pop(); },
    row => { row.after.state.events.push({ type: "submit", sequence: row.after.state.events.length + 1 }); },
    row => { row.after.state.controls["repeat-left"].selectionEnd = 4; }
  ]) { const row = ledger(); mutate(row); assert.throws(() => assertManagedKeyRepeatLedger(row)); }
});

test("passive viewer observer preserves native repeat flags and removes all listeners", () => {
  const previous = globalThis.document, listeners = new Map();
  globalThis.document = { addEventListener(type, listener) { listeners.set(type, listener); }, removeEventListener(type, listener) { assert.equal(listeners.get(type), listener); listeners.delete(type); } };
  try {
    installManagedKeyRepeatObserver();
    listeners.get("keydown")({ target: { id: "human-input" }, isTrusted: true, type: "keydown", key: "Backspace", code: "Backspace", repeat: true, defaultPrevented: true });
    const final = globalThis.__managedKeyRepeatObservation.stop(); assert.equal(final.active, false); assert.equal(final.events[0].repeat, true); assert.equal(final.events[0].trusted, true); assert.equal(listeners.size, 0);
  } finally { globalThis.document = previous; }
});
