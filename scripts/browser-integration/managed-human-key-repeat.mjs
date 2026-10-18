import assert from "node:assert/strict";

export const humanKeyRepeatCases = Object.freeze([
  { id: "repeat-backspace", key: "Backspace", keyCode: 8, anchor: "End", expectedValue: "abc", expectedSelection: 3, inputType: "deleteContentBackward" },
  { id: "repeat-delete", key: "Delete", keyCode: 46, anchor: "Home", expectedValue: "def", expectedSelection: 0, inputType: "deleteContentForward" },
  { id: "repeat-left", key: "ArrowLeft", keyCode: 37, anchor: "End", expectedValue: "abcdef", expectedSelection: 3 },
  { id: "repeat-right", key: "ArrowRight", keyCode: 39, anchor: "Home", expectedValue: "abcdef", expectedSelection: 3 },
  { id: "repeat-prevented", key: "Backspace", keyCode: 8, anchor: "End", expectedValue: "abcdef", expectedSelection: 6, prevented: true },
  { id: "repeat-held-end", key: "Backspace", keyCode: 8, anchor: "End", expectedValue: "abc", expectedSelection: 3, inputType: "deleteContentBackward", held: true }
].map(spec => Object.freeze({ initial: "abcdef", ...spec })));

export function nativeKeyRepeatGesture(spec) {
  assert.deepEqual(spec, humanKeyRepeatCases.find(row => row.id === spec.id));
  return [false, true, true].map(autoRepeat => ({ type: "keyDown", key: spec.key, code: spec.key,
    windowsVirtualKeyCode: spec.keyCode, nativeVirtualKeyCode: spec.keyCode, autoRepeat }))
    .concat(spec.held ? [] : [{ type: "keyUp", key: spec.key, code: spec.key,
      windowsVirtualKeyCode: spec.keyCode, nativeVirtualKeyCode: spec.keyCode, autoRepeat: false }]);
}

export function installManagedKeyRepeatObserver() {
  const events = [], listeners = []; let active = true, overflow = false;
  for (const type of ["keydown", "keyup", "keypress", "beforeinput", "input"]) {
    const listener = event => {
      if (event.target?.id !== "human-input") return;
      if (events.length >= 256) { overflow = true; return; }
      events.push({ sequence: events.length + 1, at: Date.now(), type, target: event.target.id,
        trusted: event.isTrusted, key: event.key ?? null, code: event.code ?? null, repeat: Boolean(event.repeat),
        defaultPrevented: event.defaultPrevented, inputType: event.inputType ?? null, data: event.data ?? null });
    };
    document.addEventListener(type, listener, { passive: true }); listeners.push({ type, listener });
  }
  const snapshot = () => ({ active, overflow, events: structuredClone(events) });
  Object.defineProperty(globalThis, "__managedKeyRepeatObservation", { value: {
    snapshot, stop() { for (const { type, listener } of listeners) document.removeEventListener(type, listener); active = false; return snapshot(); }
  } });
}

function originalDocument(before, after) {
  assert.ok(before.documentId); assert.equal(after.documentId, before.documentId);
  assert.equal(after.state.documentToken, before.state.documentToken);
  assert.equal(after.state.eventOverflow, false);
  assert.deepEqual(after.state.events.slice(0, before.state.events.length), before.state.events);
  for (const [index, row] of after.state.events.entries()) assert.equal(row.sequence, index + 1);
}

function values(spec, value) {
  assert.equal(value.value, spec.expectedValue);
  assert.equal(value.selectionStart, spec.expectedSelection); assert.equal(value.selectionEnd, spec.expectedSelection);
}

function pageGesture(spec, events, released) {
  assert.ok(events.every(row => row.trusted));
  const downs = events.filter(row => row.type === "keydown" && row.code === spec.key);
  const ups = events.filter(row => row.type === "keyup" && row.code === spec.key);
  assert.deepEqual(downs.map(row => row.repeat), [false, true, true]);
  assert.equal(ups.length, spec.held && !released ? 0 : 1);
  for (const row of [...downs, ...ups]) { assert.equal(row.key, spec.key); assert.equal(row.code, spec.key); assert.equal(row.target, spec.id); }
  assert.ok(downs.every(row => row.defaultPrevented === Boolean(spec.prevented)));
  if (ups.length) { assert.equal(ups[0].repeat, false); assert.ok(ups[0].sequence > downs.at(-1).sequence); }
  assert.equal(events.filter(row => row.type === "keypress").length, 0);
  const beforeInputs = events.filter(row => row.type === "beforeinput"), inputs = events.filter(row => row.type === "input");
  assert.equal(beforeInputs.length, spec.inputType ? 3 : 0); assert.equal(inputs.length, spec.inputType ? 3 : 0);
  for (const [index, event] of beforeInputs.entries()) {
    assert.equal(event.target, spec.id); assert.equal(event.inputType, spec.inputType); assert.equal(event.isComposing, false);
    assert.equal(inputs[index].target, spec.id); assert.equal(inputs[index].inputType, spec.inputType); assert.equal(inputs[index].isComposing, false);
    assert.ok(downs[index].sequence < event.sequence && event.sequence < inputs[index].sequence);
    if (index < 2) assert.ok(inputs[index].sequence < downs[index + 1].sequence);
  }
}

function wireGesture(spec, commands, replies, scope) {
  assert.equal(commands.length, spec.held ? 3 : 4);
  for (const [index, request] of commands.entries()) {
    assert.equal(request.operation, "humanInput"); assert.equal(request.leaseId, scope.leaseId); assert.equal(request.generation, scope.generation);
    assert.equal(request.input.type, "key"); assert.equal(request.input.key, spec.key); assert.equal(request.input.code, spec.key);
    assert.equal(request.input.windowsVirtualKeyCode, spec.keyCode); assert.equal(request.input.action, index === 3 ? "up" : "down");
    if (index === 1 || index === 2) assert.equal(request.input.repeat, true);
    else assert.equal(Object.hasOwn(request.input, "repeat"), false);
    if (index) assert.equal(request.sequence, commands[index - 1].sequence + 1);
    const matches = replies.filter(row => row.type === "response" && row.id === request.id && row.connection === request.connection);
    assert.equal(matches.length, 1); assert.equal(matches[0].error, undefined);
    assert.deepEqual(matches[0].result?.inputReceipt, { leaseId: scope.leaseId, generation: scope.generation, sequence: request.sequence, acknowledged: true });
  }
}

export function assertManagedKeyRepeatCase({ case: spec, before, after, commands, replies, scope, nativeCommands, viewerBefore, viewerAfter }) {
  assert.deepEqual(spec, humanKeyRepeatCases.find(row => row.id === spec.id));
  assert.equal(scope.keyRepeatVersion, 1); originalDocument(before, after);
  assert.equal(before.activeElement, spec.id); assert.equal(before.state.controls[spec.id].value, spec.initial);
  assert.equal(before.state.controls[spec.id].selectionStart, spec.anchor === "End" ? spec.initial.length : 0);
  assert.equal(before.state.controls[spec.id].selectionEnd, before.state.controls[spec.id].selectionStart);
  const events = after.state.events.slice(before.state.events.length);
  assert.ok(events.every(row => row.target === spec.id && ["keydown", "keyup", "keypress", "beforeinput", "input"].includes(row.type)));
  assert.ok(events.filter(row => row.type.startsWith("key")).every(row => row.code === spec.key));
  pageGesture(spec, events, false); values(spec, after.state.controls[spec.id]);
  assert.deepEqual(after.state.heldKeys, spec.held ? [spec.key] : []);
  for (const other of humanKeyRepeatCases.filter(row => row.id !== spec.id)) assert.deepEqual(after.state.controls[other.id], before.state.controls[other.id]);
  wireGesture(spec, commands, replies, scope);
  assert.deepEqual(nativeCommands.map(row => row.params), nativeKeyRepeatGesture(spec));
  for (const row of nativeCommands) { assert.equal(row.method, "Input.dispatchKeyEvent"); assert.ok(row.acknowledgedAt >= row.startedAt); assert.deepEqual(row.result, {}); assert.equal(row.error, undefined); }
  assert.equal(viewerAfter.active, true); assert.equal(viewerAfter.overflow, false);
  assert.deepEqual(viewerAfter.events.slice(0, viewerBefore.events.length), viewerBefore.events);
  const viewerEvents = viewerAfter.events.slice(viewerBefore.events.length);
  assert.deepEqual(viewerEvents.map(row => [row.type, row.code, row.repeat]), nativeKeyRepeatGesture(spec).map(row => [row.type === "keyUp" ? "keyup" : "keydown", row.code, row.autoRepeat]));
  assert.ok(viewerEvents.every(row => row.trusted));
  return { caseId: spec.id, documentId: before.documentId, requestIds: commands.map(row => row.id), eventSequences: events.map(row => row.sequence), value: after.state.controls[spec.id] };
}

export function assertManagedKeyRepeatLedger({ original, after, cases, replies, scope }) {
  originalDocument(original, after); assert.equal(scope.keyRepeatVersion, 1);
  assert.deepEqual(cases.map(row => row.definition), humanKeyRepeatCases);
  assert.deepEqual(after.state.heldKeys, []); assert.deepEqual(after.state.heldButtons, []);
  const events = after.state.events;
  const expectedKeys = humanKeyRepeatCases.flatMap(spec => [
    [spec.id, "keydown", spec.anchor, false], [spec.id, "keyup", spec.anchor, false],
    [spec.id, "keydown", spec.key, false], [spec.id, "keydown", spec.key, true],
    [spec.id, "keydown", spec.key, true], [spec.id, "keyup", spec.key, false]
  ]);
  const actualKeys = events.filter(row => row.type === "keydown" || row.type === "keyup");
  assert.deepEqual(actualKeys.map(row => [row.target, row.type, row.code, row.repeat]), expectedKeys,
    "Every original task key transition must be an anchor, original gesture or the final End release");
  assert.ok(actualKeys.every(row => row.trusted));
  for (const spec of humanKeyRepeatCases) {
    const fieldEvents = events.filter(row => row.target === spec.id && (["beforeinput", "input", "keypress"].includes(row.type) || ["keydown", "keyup"].includes(row.type) && row.code === spec.key));
    pageGesture(spec, fieldEvents, true); values(spec, after.state.controls[spec.id]);
    wireGesture(spec, cases.find(row => row.definition.id === spec.id).commands, replies, scope);
  }
  const commands = cases.flatMap(row => row.commands);
  assert.equal(new Set(commands.map(row => `${row.connection}/${row.id}`)).size, 23);
  assert.equal(events.filter(row => row.type === "input").length, 9);
  assert.equal(events.filter(row => row.type === "beforeinput").length, 9);
  assert.equal(events.filter(row => row.type === "submit").length, 0);
  return { originalDocumentId: original.documentId, requestIds: commands.map(row => row.id), repeatDowns: 12, originalDowns: 6, originalUps: 6, inputs: 9, posts: 0 };
}
