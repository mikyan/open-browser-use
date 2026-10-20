import assert from "node:assert/strict";

const initial = "alpha BRAVO charlie\nsecond paragraph\n";
export const humanMultiClickCases = Object.freeze([
  // Fixed Windows CfT 156.0.8078.12 selects the trailing word space. Independent
  // native-reference-qtvms6 (no extension/managed UI) proves [6,12], not [6,11].
  // This is a pinned-runtime expectation, not a cross-platform selection rule.
  Object.freeze({ id: "double-word", count: 2, initial, selection: [6, 12], selected: "BRAVO " }),
  Object.freeze({ id: "triple-line", count: 3, initial, selection: [0, 20], selected: "alpha BRAVO charlie\n" })
]);

export function managedMultiClickMode(scenario, value) {
  if (value !== undefined) assert.equal(scenario, "multi-click");
  assert.ok(value === undefined || value === "baseline" || value === "acceptance");
  return value ?? "acceptance";
}

export function installManagedMultiClickObserver() {
  const events = [], listeners = []; let overflow = false, active = true;
  for (const type of ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "dblclick"]) {
    const listener = event => {
      if (event.target?.id !== "frame") return;
      if (events.length >= 128) { overflow = true; return; }
      events.push({ sequence: events.length + 1, at: Date.now(), type, trusted: event.isTrusted, detail: event.detail,
        button: event.button, buttons: event.buttons, defaultPrevented: event.defaultPrevented });
    };
    document.addEventListener(type, listener, { passive: true }); listeners.push({ type, listener });
  }
  const snapshot = () => ({ active, overflow, events: structuredClone(events) });
  Object.defineProperty(globalThis, "__managedMultiClickObservation", { configurable: true, value: {
    snapshot, stop() { for (const { type, listener } of listeners) document.removeEventListener(type, listener); active = false; return snapshot(); }
  } });
}

export async function nativeMultiClickGesture(mouse, count, ledger) {
  assert.ok(count === 2 || count === 3);
  for (let clickCount = 1; clickCount <= count; clickCount++) for (const action of ["down", "up"]) {
    const row = { action, options: { button: "left", clickCount }, startedAt: Date.now() }; ledger.push(row);
    try { await mouse[action](row.options); row.acknowledgedAt = Date.now(); }
    catch (error) { row.error = String(error); throw error; }
    finally { row.settledAt = Date.now(); }
  }
}

export function assertManagedMultiClickCase(row, replies, scope, mode = "acceptance") {
  assert.ok(mode === "acceptance" || mode === "baseline");
  const spec = humanMultiClickCases.find(value => value.id === row.definition.id); assert.deepEqual(row.definition, spec);
  const { before, after, commands, nativeCommands, viewerBefore, viewerAfter } = row;
  assert.ok(before.documentId); assert.equal(after.documentId, before.documentId);
  assert.equal(after.state.documentToken, before.state.documentToken); assert.equal(after.state.eventOverflow, false);
  assert.deepEqual(after.state.heldButtons, []); assert.equal(after.activeElement, spec.id);
  assert.deepEqual(after.state.events.slice(0, before.state.events.length), before.state.events);
  for (const definition of humanMultiClickCases) assert.equal(after.controls[definition.id].value, definition.initial);
  assert.deepEqual(Object.fromEntries(Object.entries(after.controls).filter(([id]) => id !== spec.id)),
    Object.fromEntries(Object.entries(before.controls).filter(([id]) => id !== spec.id)));
  assert.equal(viewerBefore.active, true); assert.equal(viewerAfter.active, true);
  assert.equal(viewerBefore.overflow, false); assert.equal(viewerAfter.overflow, false);
  assert.deepEqual(viewerAfter.events.slice(0, viewerBefore.events.length), viewerBefore.events);
  const viewerEvents = viewerAfter.events.slice(viewerBefore.events.length);
  assert.ok(viewerEvents.every(value => value.trusted));
  assert.deepEqual(viewerEvents.filter(value => value.type.startsWith("pointer")).map(value => [value.type, value.button]),
    Array.from({ length: spec.count }, () => [["pointerdown", 0], ["pointerup", 0]]).flat());
  if (mode === "acceptance") assert.deepEqual(
    viewerEvents.filter(value => ["mousedown", "mouseup"].includes(value.type)).map(value => [value.type, value.detail, value.button]),
    Array.from({ length: spec.count }, (_, index) => [["mousedown", index + 1, 0], ["mouseup", index + 1, 0]]).flat(),
    "The original trusted viewer mouse detail, not only driver parameters, must carry each click count");
  const pairs = Array.from({ length: spec.count }, (_, index) => [["down", index + 1], ["up", index + 1]]).flat();
  assert.equal(nativeCommands.length, pairs.length); assert.equal(commands.length, pairs.length);
  for (let index = 0; index < pairs.length; index++) {
    const [action, clickCount] = pairs[index], native = nativeCommands[index], command = commands[index];
    assert.equal(native.action, action); assert.deepEqual(native.options, { button: "left", clickCount });
    assert.equal(native.error, undefined); assert.ok(native.startedAt <= native.acknowledgedAt && native.acknowledgedAt <= native.settledAt);
    assert.equal(command.operation, "humanInput"); assert.equal(command.leaseId, scope.leaseId); assert.equal(command.generation, scope.generation);
    assert.equal(command.input.type, "pointer"); assert.equal(command.input.action, action); assert.equal(command.input.button, "left");
    assert.equal(command.input.modifiers ?? 0, 0);
    if (mode === "acceptance") assert.equal(command.input.clickCount ?? 1, clickCount);
    else assert.equal(command.input.clickCount ?? 1, 1);
    if (index) {
      assert.equal(command.sequence, commands[index - 1].sequence + 1);
      assert.equal(command.input.x, commands[0].input.x); assert.equal(command.input.y, commands[0].input.y);
    }
    const matches = replies.filter(value => value.id === command.id && value.connection === command.connection && value.type === "response");
    assert.equal(matches.length, 1); assert.equal(matches[0].error, undefined);
    assert.deepEqual(matches[0].result.inputReceipt, { leaseId: scope.leaseId, generation: scope.generation, sequence: command.sequence, acknowledged: true });
  }
  const events = after.state.events.slice(before.state.events.length);
  assert.ok(events.every(value => value.trusted && value.target === spec.id && !value.defaultPrevented));
  assert.deepEqual(after.state.events.map(value => value.sequence), after.state.events.map((_value, index) => index + 1));
  assert.ok(events.every(value => ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "dblclick"].includes(value.type)));
  assert.deepEqual(events.filter(value => value.type.startsWith("pointer")).map(value => [value.type, value.button]),
    Array.from({ length: spec.count }, () => [["pointerdown", 0], ["pointerup", 0]]).flat());
  assert.equal(events.some(value => ["input", "beforeinput"].includes(value.type)), false, "Selection must not insert text");
  const mouse = events.filter(value => ["mousedown", "mouseup", "click", "dblclick"].includes(value.type));
  const expected = [];
  for (let index = 1; index <= spec.count; index++) {
    const detail = mode === "baseline" ? 1 : index;
    for (const type of ["mousedown", "mouseup", "click"]) expected.push([type, detail, 0]);
    if (mode === "acceptance" && index === 2) expected.push(["dblclick", 2, 0]);
  }
  assert.deepEqual(mouse.map(value => [value.type, value.detail, value.button]), expected);
  const control = after.controls[spec.id];
  if (mode === "acceptance") {
    assert.deepEqual([control.selectionStart, control.selectionEnd], spec.selection); assert.equal(control.selected, spec.selected);
  } else {
    assert.equal(control.selectionStart, control.selectionEnd); assert.equal(control.selected, "");
  }
  return { caseId: spec.id, originalDocumentId: before.documentId, originalRequestIds: commands.map(value => value.id),
    featurePassed: mode === "acceptance", gapConfirmed: mode === "baseline", nativeMouseEvents: mouse.length,
    selection: [control.selectionStart, control.selectionEnd], selected: control.selected };
}

export function assertManagedMultiClickLedger(detail, includeFinal = false) {
  assert.deepEqual(detail.cases.map(row => row.definition.id), humanMultiClickCases.map(row => row.id));
  let previous = detail.original;
  const same = (left, right, label) => {
    assert.equal(right.documentId, left.documentId, label);
    assert.equal(right.state.documentToken, left.state.documentToken, label);
    assert.equal(right.state.eventOverflow, false, label); assert.deepEqual(right.state.heldButtons, [], label);
    assert.deepEqual(right.state.events, left.state.events, label);
    assert.deepEqual(right.controls, left.controls, label);
  };
  for (const row of detail.cases) {
    same(previous, row.before, `No unrecorded event/selection between original cases: ${row.definition.id}`);
    assert.equal(row.after.documentId, detail.original.documentId);
    assert.equal(row.after.state.documentToken, detail.original.state.documentToken);
    assert.deepEqual(row.after.state.events.slice(0, row.before.state.events.length), row.before.state.events);
    assert.ok(row.after.state.events.length > row.before.state.events.length);
    previous = row.after;
  }
  same(previous, detail.after, "No extra input after the final gesture");
  same(detail.after, detail.released, "End cannot append unrecorded task input");
  if (includeFinal) same(detail.released, detail.finalDocument, "No late input during resumed handoff");
  return { originalDocumentId: detail.original.documentId, cases: detail.cases.length, taskEvents: detail.released.state.events.length, includesFinal: includeFinal };
}

export function assertManagedMultiClickTerminal(stats, detail, handoffStats) {
  const ledger = assertManagedMultiClickLedger(detail, true);
  assert.equal(stats.overflow, false); assert.equal(stats.requests.length, 1);
  const hit = stats.requests[0]; assert.equal(hit.method, "GET"); assert.equal(hit.status, 200);
  assert.equal(hit.finished, true); assert.equal(hit.aborted, false); assert.equal(hit.documentToken, detail.original.state.documentToken);
  assert.equal(detail.finalDocument.documentId, detail.original.documentId);
  assert.equal(detail.finalDocument.state.documentToken, detail.original.state.documentToken);
  assert.equal(detail.finalDocument.state.eventOverflow, false); assert.deepEqual(detail.finalDocument.state.heldButtons, []);
  assert.deepEqual(detail.cases.map(row => row.definition.id), humanMultiClickCases.map(row => row.id));
  assert.ok(detail.cases.every(row => row.proof.originalDocumentId === detail.original.documentId));
  assert.deepEqual(detail.finalDocument.state.events, detail.released.state.events);
  assert.deepEqual(detail.finalDocument.controls, detail.released.controls);
  assert.equal(handoffStats.requests.filter(value => value.method === "POST").length, 1);
  return { originalFixtureGETs: 1, originalFixturePOSTs: 0, originalHandoffPOSTs: 1, ledger };
}
