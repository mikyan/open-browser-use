import assert from "node:assert/strict";

const emitter = documents => documents.find(value => value.controls !== null);
const down = (key, code, vk, text, autoRepeat = false, modifiers = 0) => ({ type: "keyDown", key, code,
  windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers, autoRepeat, ...(text ? { text, unmodifiedText: text.toLowerCase() } : {}) });
const up = (key, code, vk, modifiers = 0) => ({ type: "keyUp", key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers, autoRepeat: false });
export const managedPrintableRepeatCases = Object.freeze([
  { id: "repeat-b", field: "lower", code: "KeyB", characters: ["b", "b", "b"], finalValue: "abbb", upKey: "b",
    commands: [down("b", "KeyB", 66, "b"), down("b", "KeyB", 66, "b", true), down("b", "KeyB", 66, "b", true), up("b", "KeyB", 66)] },
  { id: "shift-repeat-a", field: "upper", code: "KeyA", characters: ["A", "A", "a"], finalValue: "AAAa", upKey: "A",
    commands: [down("Shift", "ShiftLeft", 16, "", false, 8), down("A", "KeyA", 65, "A", false, 8), down("A", "KeyA", 65, "A", true, 8),
      up("Shift", "ShiftLeft", 16), down("a", "KeyA", 65, "a", true), up("a", "KeyA", 65)] },
  { id: "held-end-h", field: "symbol", code: "KeyH", characters: ["h", "h", "h"], finalValue: "!hhh", upKey: "h", held: true,
    commands: [down("h", "KeyH", 72, "h"), down("h", "KeyH", 72, "h", true), down("h", "KeyH", 72, "h", true)] },
].map(value => Object.freeze({ ...value, characters: Object.freeze(value.characters), commands: Object.freeze(value.commands.map(Object.freeze)) })));

export const printableLateRelease = Object.freeze([up("h", "KeyH", 72), down("z", "KeyZ", 90, "z"), up("z", "KeyZ", 90)].map(Object.freeze));

export function assertManagedPrintableRepeat(row) {
  const spec = managedPrintableRepeatCases.find(value => value.id === row.caseId); assert.ok(spec);
  const before = emitter(row.before), after = emitter(row.after); assert.equal(before.activeElement, spec.field);
  assert.equal(after.documentId, before.documentId); assert.equal(after.state.documentToken, before.state.documentToken);
  assert.deepEqual(after.state.events.slice(0, before.state.events.length), before.state.events);
  assert.equal(after.state.overflow, false); assert.deepEqual(before.state.heldKeys, []);
  const events = after.state.events.slice(before.state.events.length); assert.ok(events.every(value => value.trusted && value.target === spec.field));
  const downs = events.filter(value => value.type === "keydown" && value.code === spec.code), ups = events.filter(value => value.type === "keyup" && value.code === spec.code);
  assert.deepEqual(downs.map(value => [value.key, value.repeat, value.shiftKey]), spec.characters.map((value, i) => [value, i > 0, spec.id === "shift-repeat-a" && i < 2]));
  assert.ok(downs.every(value => value.defaultPrevented === false)); assert.equal(ups.length, spec.held ? 0 : 1);
  if (!spec.held) { assert.equal(ups[0].key, spec.upKey); assert.equal(ups[0].repeat, false); assert.equal(ups[0].shiftKey, false); }
  const presses = events.filter(value => value.type === "keypress"); assert.deepEqual(presses.map(value => value.key), spec.characters);
  for (const type of ["beforeinput", "input"]) assert.deepEqual(events.filter(value => value.type === type).map(value => [value.data, value.inputType, value.isComposing]),
    spec.characters.map(value => [value, "insertText", false]));
  for (let i = 0; i < 3; i++) {
    const beforeInput = events.filter(value => value.type === "beforeinput")[i], input = events.filter(value => value.type === "input")[i];
    assert.ok(downs[i].sequence < presses[i].sequence && presses[i].sequence < beforeInput.sequence && beforeInput.sequence < input.sequence);
    if (i < 2) assert.ok(input.sequence < downs[i + 1].sequence);
  }
  assert.equal(after.controls[spec.field], spec.finalValue);
  for (const field of Object.keys(before.controls).filter(value => value !== spec.field)) assert.equal(after.controls[field], before.controls[field]);
  assert.deepEqual(after.state.heldKeys, spec.held ? [spec.code] : []); assert.deepEqual(after.state.heldButtons, []);
  assert.deepEqual(row.gesture.nativeCommands.map(value => value.params), spec.commands);
  for (const call of row.gesture.nativeCommands) { assert.equal(call.method, "Input.dispatchKeyEvent"); assert.ok(call.acknowledgedAt >= call.startedAt); assert.equal(call.error, undefined); assert.deepEqual(call.result, {}); }
  const commands = row.gesture.commands; assert.ok(commands.every(value => value.input.type === "key"));
  assert.deepEqual(commands.map(value => [value.input.code, value.input.action, value.input.repeat ?? false]),
    spec.commands.map(value => [value.code, value.type === "keyUp" ? "up" : "down", value.autoRepeat]));
  assert.deepEqual(commands.filter(value => value.input.code === spec.code && value.input.action === "down").map(value => value.input.text), spec.characters);
  assert.ok(commands.filter(value => value.input.action === "up").every(value => !Object.hasOwn(value.input, "text")));
  const localKeys = row.gesture.viewer.events.filter(value => ["keydown", "keyup"].includes(value.type));
  assert.deepEqual(localKeys.map(value => [value.type, value.code, value.key, value.repeat]),
    spec.commands.map(value => [value.type === "keyUp" ? "keyup" : "keydown", value.code, value.key, value.autoRepeat]));
  return { verified: true, caseId: spec.id, originalDowns: 1, repeatedDowns: 2, originalUps: ups.length, value: after.controls[spec.field] };
}

export function assertManagedPrintableHeldEnd({ before, released, afterLocalRelease, late }) {
  const original = emitter(before), ended = emitter(released), after = emitter(afterLocalRelease);
  assert.equal(ended.documentId, original.documentId); assert.equal(after.documentId, original.documentId);
  assert.deepEqual(original.state.heldKeys, ["KeyH"]); assert.deepEqual(ended.state.heldKeys, []);
  assert.deepEqual(ended.state.events.slice(0, original.state.events.length), original.state.events);
  const additions = ended.state.events.slice(original.state.events.length);
  assert.equal(additions.length, 1); assert.equal(additions[0].type, "keyup"); assert.equal(additions[0].code, "KeyH");
  assert.equal(additions[0].key, "h"); assert.equal(additions[0].trusted, true); assert.equal(additions[0].target, "symbol");
  assert.deepEqual(ended.controls, original.controls); assert.deepEqual(after.state, ended.state); assert.deepEqual(after.controls, ended.controls);
  assert.deepEqual(late.commands, []); assert.deepEqual(late.nativeCommands.map(value => value.params), printableLateRelease);
  for (const call of late.nativeCommands) { assert.ok(call.acknowledgedAt >= call.startedAt); assert.equal(call.error, undefined); assert.deepEqual(call.result, {}); }
  assert.equal(late.viewer.after.sink.disabled, true);
  return { verified: true, originalReleaseEvents: 1, afterEndInputRequests: 0, noAdditionalText: true };
}
