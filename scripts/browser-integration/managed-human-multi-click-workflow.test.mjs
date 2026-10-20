import assert from "node:assert/strict";
import test from "node:test";
import { humanMultiClickCases, managedMultiClickMode, nativeMultiClickGesture, installManagedMultiClickObserver, assertManagedMultiClickCase, assertManagedMultiClickLedger, assertManagedMultiClickTerminal } from "./managed-human-multi-click-workflow.mjs";

const scope = { leaseId: "original-lease", generation: 2 };
function evidence(spec, mode = "acceptance") {
  const controls = Object.fromEntries(humanMultiClickCases.map(row => [row.id, { value: row.initial, selectionStart: 0, selectionEnd: 0, selectionDirection: "forward", selected: "" }]));
  const before = { documentId: "original-document", state: { documentToken: "original-token", events: [], eventOverflow: false, heldButtons: [] }, controls };
  const after = structuredClone(before); after.activeElement = spec.id;
  const commands = [], replies = [], nativeCommands = [], viewerEvents = [];
  for (let count = 1; count <= spec.count; count++) {
    const detail = mode === "baseline" ? 1 : count;
    for (const action of ["down", "up"]) {
      const id = commands.length + 1;
      commands.push({ operation: "humanInput", id, connection: 1, ...scope, sequence: id,
        input: { type: "pointer", action, button: "left", x: 100, y: 80, modifiers: 0, ...(mode === "acceptance" ? { clickCount: count } : {}) } });
      replies.push({ type: "response", id, connection: 1, result: { inputReceipt: { ...scope, sequence: id, acknowledged: true } } });
      nativeCommands.push({ action, options: { button: "left", clickCount: count }, startedAt: 1, acknowledgedAt: 2, settledAt: 3 });
      viewerEvents.push({ type: "pointer" + action, button: 0, trusted: true });
      if (mode === "acceptance") viewerEvents.push({ type: "mouse" + action, button: 0, trusted: true, detail: count });
      for (const type of ["pointer" + action, "mouse" + action]) after.state.events.push({ type, target: spec.id, trusted: true, defaultPrevented: false, detail, button: 0 });
    }
    after.state.events.push({ type: "click", target: spec.id, trusted: true, defaultPrevented: false, detail, button: 0 });
    if (mode === "acceptance" && count === 2) after.state.events.push({ type: "dblclick", target: spec.id, trusted: true, defaultPrevented: false, detail: 2, button: 0 });
  }
  after.state.events.forEach((row, index) => { row.sequence = index + 1; });
  const [selectionStart, selectionEnd] = mode === "acceptance" ? spec.selection : [8, 8];
  after.controls[spec.id] = { value: spec.initial, selectionStart, selectionEnd, selected: mode === "acceptance" ? spec.selected : "", selectionDirection: "forward" };
  return { definition: spec, before, after, commands, replies, nativeCommands,
    viewerBefore: { active: true, overflow: false, events: [] }, viewerAfter: { active: true, overflow: false, events: viewerEvents } };
}
const verify = (row, mode) => assertManagedMultiClickCase(row, row.replies, scope, mode);

test("double word and triple original line require native counts, original ACKs, trusted events and exact selections", () => {
  for (const spec of humanMultiClickCases) {
    assert.equal(verify(evidence(spec)).featurePassed, true);
    const baseline = verify(evidence(spec, "baseline"), "baseline");
    assert.equal(baseline.featurePassed, false); assert.equal(baseline.gapConfirmed, true);
    assert.throws(() => verify(evidence(spec, "baseline")));
    assert.throws(() => verify(evidence(spec), "baseline"));
  }
});

test("wrong original identity, synthetic or duplicate events, missing native receipts and count collapse cannot pass", () => {
  const mutations = [
    row => { row.after.documentId = "successor"; }, row => { row.after.state.documentToken = "replacement"; },
    row => { row.after.state.eventOverflow = true; }, row => { row.after.state.events[0].trusted = false; },
    row => { row.after.state.events[0].target = "other"; }, row => { row.after.state.events[0].sequence = 2; },
    row => { row.after.state.events.find(event => event.type === "dblclick").detail = 1; },
    row => { row.after.state.events.push({ ...row.after.state.events.at(-1), sequence: row.after.state.events.length + 1 }); },
    row => { row.after.state.events.splice(0, 1); },
    row => { row.after.controls[row.definition.id].selectionEnd--; }, row => { row.after.controls[row.definition.id].value += "X"; },
    row => { row.after.state.heldButtons = [0]; }, row => { row.commands[2].input.clickCount = 1; },
    row => { row.commands[1].input.clickCount = 2; }, row => { row.commands[1].sequence++; },
    row => { row.commands[1].input.x++; }, row => { row.commands[1].generation++; }, row => { row.commands[1].leaseId = "next"; },
    row => { row.replies[1].result.inputReceipt.acknowledged = false; },
    row => { row.replies[1].result.inputReceipt.sequence++; }, row => { row.replies.push(row.replies[0]); },
    row => { row.nativeCommands[1].options.clickCount = 3; }, row => { delete row.nativeCommands[1].acknowledgedAt; },
    row => { row.viewerAfter.events[0].trusted = false; }, row => { row.viewerAfter.overflow = true; },
    row => { row.viewerAfter.events.find(value => value.type === "mousedown" && value.detail === 2).detail = 1; },
    row => { row.viewerAfter.events.find(value => value.type === "mouseup" && value.detail === 1).detail = 2; },
    row => { row.viewerAfter.events.pop(); }
  ];
  for (const mutate of mutations) { const row = evidence(humanMultiClickCases[0]); mutate(row); assert.throws(() => verify(row)); }
});

test("native mouse gesture preserves complete down/up counts and stops after original rejection without replay", async () => {
  const called = [], ledger = [];
  const mouse = Object.fromEntries(["down", "up"].map(action => [action, async options => { called.push([action, options.clickCount]); }]));
  await nativeMultiClickGesture(mouse, 3, ledger);
  assert.deepEqual(called, [["down", 1], ["up", 1], ["down", 2], ["up", 2], ["down", 3], ["up", 3]]);
  assert.ok(ledger.every(row => row.acknowledgedAt !== undefined && row.settledAt !== undefined));
  const failure = [], original = new Error("original native rejection"); let calls = 0;
  await assert.rejects(nativeMultiClickGesture({ down: async () => { calls++; }, up: async () => { calls++; throw original; } }, 2, failure), error => error === original);
  assert.equal(calls, 2); assert.equal(failure.length, 2); assert.equal(failure[1].acknowledgedAt, undefined); assert.match(failure[1].error, /original native rejection/);
});

test("baseline is explicit and cannot be enabled for another scenario", () => {
  assert.equal(managedMultiClickMode("handoff"), "acceptance");
  for (const value of ["baseline", "acceptance"]) assert.equal(managedMultiClickMode("multi-click", value), value);
  for (const value of ["baseline", "", "0", null]) assert.throws(() => managedMultiClickMode("handoff", value));
  assert.throws(() => managedMultiClickMode("multi-click", "yes"));
});

test("passive viewer observer keeps actual trust/detail and removes listeners", () => {
  const prior = globalThis.document, listeners = new Map();
  globalThis.document = { addEventListener(type, listener) { listeners.set(type, listener); }, removeEventListener(type, listener) { assert.equal(listeners.get(type), listener); listeners.delete(type); } };
  try {
    installManagedMultiClickObserver();
    listeners.get("mousedown")({ target: { id: "frame" }, isTrusted: true, detail: 2, button: 0, buttons: 1, defaultPrevented: true });
    listeners.get("mousedown")({ target: { id: "other" }, isTrusted: true });
    const result = globalThis.__managedMultiClickObservation.stop();
    assert.equal(result.events.length, 1); assert.equal(result.events[0].trusted, true); assert.equal(result.events[0].detail, 2);
    assert.equal(result.active, false); assert.equal(result.overflow, false); assert.equal(listeners.size, 0);
  } finally { globalThis.document = prior; delete globalThis.__managedMultiClickObservation; }
});

function fullLedger() {
  const rows = humanMultiClickCases.map(spec => evidence(spec));
  rows[1].before = structuredClone(rows[0].after);
  rows[1].after.controls["double-word"] = structuredClone(rows[0].after.controls["double-word"]);
  rows[1].after.state.events = [...structuredClone(rows[0].after.state.events), ...rows[1].after.state.events];
  rows[1].after.state.events.forEach((row, index) => { row.sequence = index + 1; });
  return { original: rows[0].before, after: structuredClone(rows.at(-1).after), released: structuredClone(rows.at(-1).after), finalDocument: structuredClone(rows.at(-1).after),
    cases: rows.map(row => ({ ...row, proof: verify(row) })) };
}

test("whole original event ledger rejects an extra trusted event hidden between individually valid cases", () => {
  const detail = fullLedger(); assert.equal(assertManagedMultiClickLedger(detail, true).cases, 2);
  const hidden = { ...detail.cases[0].after.state.events.at(-1), sequence: detail.cases[0].after.state.events.length + 1 };
  for (const document of [detail.cases[1].before, detail.cases[1].after, detail.after, detail.released, detail.finalDocument]) {
    document.state.events.splice(hidden.sequence - 1, 0, structuredClone(hidden));
    document.state.events.forEach((event, index) => { event.sequence = index + 1; });
  }
  // Both per-case prefix/delta checks still pass; the full lease must reject.
  for (const row of detail.cases) assert.equal(verify(row).featurePassed, true);
  assert.throws(() => assertManagedMultiClickLedger(detail, true), /No unrecorded event/);
});

test("terminal evidence rejects late POST, task input, duplicate GET and changed original selection", () => {
  const detail = fullLedger();
  const stats = { overflow: false, requests: [{ method: "GET", status: 200, finished: true, aborted: false, documentToken: "original-token" }] };
  const handoff = { requests: [{ method: "POST" }] };
  assert.equal(assertManagedMultiClickTerminal(stats, detail, handoff).originalHandoffPOSTs, 1);
  for (const mutate of [
    data => { data.stats.requests.push(data.stats.requests[0]); }, data => { data.stats.overflow = true; },
    data => { data.handoff.requests.push({ method: "POST" }); },
    data => { data.detail.finalDocument.state.events.push({ type: "click" }); },
    data => { data.detail.finalDocument.controls["double-word"].selectionEnd++; },
    data => { data.detail.cases.pop(); }
  ]) { const data = structuredClone({ stats, detail, handoff }); mutate(data); assert.throws(() => assertManagedMultiClickTerminal(data.stats, data.detail, data.handoff)); }
});
