import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import vm from "node:vm";
import { createHash } from "node:crypto";
import { createManagedPrintableFixture, managedPrintableCases } from "./managed-human-printable-fixture.mjs";
import { assertManagedPrintableCase, assessManagedPrintableCase, managedPrintableOutcome, printableExpectedControls, proveManagedPrintableFrames, assertManagedPrintableLocalSequence, assertManagedPrintableLease } from "./managed-human-printable-workflow.mjs";
import { managedPrintableRepeatCases, assertManagedPrintableRepeat, assertManagedPrintableHeldEnd, printableLateRelease } from "./managed-human-printable-repeat.mjs";
import { projectHumanCommand } from "./managed-human-check.mjs";
import { managedPrintableMode } from "./managed-human-printable-check.mjs";
import { listenFixture } from "./fixture-listener.mjs";

const initial = () => ({ checkbox: false, buttonClicks: 0, grid: "", blocked: "seed", lower: "", upper: "", symbol: "" });
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const localRow = (sequence, type, extra = {}) => ({ sequence, type, trusted: true, target: "human-input", activeElement: "human-input", sinkDisabled: false, sinkValue: "", ...extra });
const localSnapshot = () => ({ activeElement: "human-input", sink: { disabled: false, value: "" } });
function completeCase(id) {
  const spec = managedPrintableCases.find(value => value.id === id), events = [];
  const add = (type, extra = {}) => events.push({ sequence: events.length + 1, type, target: id, trusted: true, defaultPrevented: false, ...extra });
  const key = { key: spec.character, code: spec.code, repeat: false, shiftKey: Boolean(spec.shift), ctrlKey: false, altKey: false, metaKey: false };
  add("keydown", { ...key, defaultPrevented: Boolean(spec.prevented) });
  if (!spec.prevented) add("keypress", { ...key, charCode: spec.character.charCodeAt(0) });
  if (["lower", "upper", "symbol"].includes(id)) for (const type of ["beforeinput", "input"]) add(type, { data: spec.character, inputType: "insertText", isComposing: false });
  add("keyup", key);
  if (["checkbox", "space-button"].includes(id)) add("click");
  if (id === "checkbox") { add("input"); add("change"); }
  const before = { documentId: "original-doc", url: "http://127.0.0.1/original", activeElement: id, controls: initial(),
    state: { documentToken: "original-token", workflowId: "workflow", events: [], overflow: false, heldKeys: [], heldButtons: [] } };
  const after = structuredClone(before); after.state.events = events;
  const changed = id === "space-button" ? "buttonClicks" : id; after.controls[changed] = printableExpectedControls[changed];
  return { caseId: id, before: [before], after: [after], gesture: {
    commands: ["down", "up"].map((action, i) => ({ id: i + 1, input: { type: "key", code: spec.code, action, ...(action === "down" ? { text: spec.character } : {}) } })),
    viewer: { overflow: false, before: localSnapshot(), after: localSnapshot(), events: [
      localRow(1, "keydown", { key: spec.character, code: spec.code }),
      localRow(2, "beforeinput", { inputType: "insertText", data: spec.character, isComposing: false }),
      localRow(3, "keyup", { key: spec.character, code: spec.code })] }
  } };
}

for (const spec of managedPrintableCases) test(`printable proof binds original trusted ${spec.id} behavior and one character`, () => {
  const row = completeCase(spec.id); assert.equal(assertManagedPrintableCase(row).verified, true);
  for (const mutate of [
    row => { row.after[0].documentId = "replacement"; },
    row => { row.after[0].state.events[0].trusted = false; },
    row => { row.after[0].state.events = row.after[0].state.events.filter(value => value.type !== "keydown"); },
    row => { row.after[0].state.heldKeys = [spec.code]; },
    row => { row.gesture.commands.push({ id: 3, input: { type: "text", text: spec.character } }); },
    row => { row.gesture.viewer.events[0].trusted = false; },
    row => { row.gesture.viewer.events[0].activeElement = "other-field"; },
    row => { row.gesture.viewer.events[1].sequence = 0; },
  ]) { const changed = structuredClone(row); mutate(changed); assert.equal(assessManagedPrintableCase(changed).passed, false); }
});

test("blocked key cannot be relabelled successful from final ACK or wrong text value", () => {
  const row = completeCase("blocked"); row.after[0].controls.blocked += "x";
  assert.equal(assessManagedPrintableCase(row).passed, false);
  const noCancel = completeCase("blocked"); noCancel.after[0].state.events[0].defaultPrevented = false;
  assert.equal(assessManagedPrintableCase(noCancel).passed, false);
  const duplicate = completeCase("upper"); duplicate.after[0].controls.upper = "AA";
  assert.equal(assessManagedPrintableCase(duplicate).passed, false);
});

test("baseline completed collection remains failed and can never establish acceptance", () => {
  const rows = ["root", "oopif"].map(kind => ({ kind, leaseProof: { verified: true }, cases: managedPrintableCases.map(spec => ({ caseId: spec.id, assessment: { passed: true } })),
    extended: { cases: managedPrintableRepeatCases.map(spec => ({ caseId: spec.id, assessment: { passed: true } })), endProof: { verified: true } } }));
  assert.equal(managedPrintableOutcome("baseline", true, rows).featurePassed, false);
  assert.equal(managedPrintableOutcome("baseline", true, rows).passed, false);
  assert.equal(managedPrintableOutcome("acceptance", true, rows).featurePassed, true);
  rows[0].cases[0].assessment.passed = false;
  assert.deepEqual(managedPrintableOutcome("baseline", true, rows), { passed: false, featurePassed: false, diagnosticCompleted: true,
    observedOutcome: "failed", featureObserved: false, failedCases: ["checkbox"], baselineGapConfirmed: true });
  assert.equal(managedPrintableOutcome("acceptance", true, rows).passed, false);
  assert.equal(managedPrintableOutcome("baseline", false, rows).baselineGapConfirmed, false);
  assert.equal(managedPrintableOutcome("baseline", true, rows.slice(0, 1)).featureObserved, false);
  for (const mode of [undefined, "", "workflow", "diagnostic"]) assert.throws(() => managedPrintableMode(mode));
  assert.equal(managedPrintableMode("baseline"), "baseline"); assert.equal(managedPrintableMode("acceptance"), "acceptance");
});

test("only bounded printable key-down text is retained by the shared wire projector", () => {
  const request = { id: 1, operation: "humanInput", leaseId: "original", generation: 1, sequence: 1,
    input: { type: "key", action: "down", key: "A", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 8, text: "A" } };
  assert.deepEqual(projectHumanCommand(request), request);
  for (const change of [{ action: "up" }, { text: "" }, { text: "abcd" }, { text: "\n" }, { text: "\ud800" }, { key: "Enter" }, { key: "\0" }])
    assert.throws(() => projectHumanCommand({ ...request, input: { ...request.input, ...change } }));
});

test("whole lease rejects unrecorded inputs, late task keys and duplicate or mismatched ACKs", () => {
  const result = completeCase("grid"), lease = { leaseId: "original-lease", generation: 1 };
  const commands = result.gesture.commands.map((value, i) => ({ ...value, operation: "humanInput", ...lease, sequence: i + 1 }));
  result.gesture.commands = commands;
  const messages = commands.map(request => ({ type: "response", id: request.id, result: { inputReceipt: {
    ...lease, sequence: request.sequence, acknowledged: true
  } } }));
  const row = { lease, cases: [result], before: result.before, released: result.after };
  assert.equal(assertManagedPrintableLease(row, commands, messages, false).verified, true);
  for (const mutate of [
    value => { value.commands.push({ ...value.commands[0], id: 99, sequence: 3 }); },
    value => { value.row.released[0].state.events.push({ type: "keyup", code: "KeyZ", trusted: true }); },
    value => { value.messages.push(structuredClone(value.messages[0])); },
    value => { value.messages[0].result.inputReceipt.generation++; },
    value => { value.row.released[0].state.heldKeys = ["KeyZ"]; },
  ]) {
    const changed = structuredClone({ row, commands, messages }); mutate(changed);
    assert.throws(() => assertManagedPrintableLease(changed.row, changed.commands, changed.messages, false));
  }
});

function repeatCase(spec) {
  const before = { documentId: "same", activeElement: spec.field, controls: { ...printableExpectedControls },
    state: { documentToken: "token", events: [], overflow: false, heldKeys: [], heldButtons: [] } };
  const after = structuredClone(before), events = after.state.events, local = [];
  const append = (type, extra) => events.push({ sequence: events.length + 1, target: spec.field, trusted: true, type, ...extra });
  for (const command of spec.commands) {
    const isDown = command.type === "keyDown", key = !isDown && command.code === spec.code ? spec.upKey : command.key;
    append(isDown ? "keydown" : "keyup", { key, code: command.code, repeat: command.autoRepeat, shiftKey: Boolean(command.modifiers & 8), defaultPrevented: false });
    local.push(localRow(local.length + 1, isDown ? "keydown" : "keyup", { key: command.key, code: command.code, repeat: command.autoRepeat }));
    if (command.text) {
      append("keypress", { key: command.key });
      for (const type of ["beforeinput", "input"]) append(type, { data: command.text, inputType: "insertText", isComposing: false });
      local.push(localRow(local.length + 1, "beforeinput", { data: command.text, inputType: "insertText", isComposing: false }));
    }
  }
  after.controls[spec.field] = spec.finalValue; after.state.heldKeys = spec.held ? [spec.code] : [];
  return { caseId: spec.id, before: [before], after: [after], gesture: {
    nativeCommands: spec.commands.map(params => ({ method: "Input.dispatchKeyEvent", params, startedAt: 1, acknowledgedAt: 2, result: {} })),
    commands: spec.commands.map((value, i) => ({ id: i + 1, input: { type: "key", action: value.type === "keyUp" ? "up" : "down", code: value.code,
      ...(value.autoRepeat ? { repeat: true } : {}), ...(value.text ? { text: value.text } : {}) } })),
    viewer: { events: local, overflow: false, before: localSnapshot(), after: localSnapshot() }
  } };
}

for (const spec of managedPrintableRepeatCases) test(`${spec.id} requires original native repeats, changed character and one editing effect each`, () => {
  const row = repeatCase(spec); assert.equal(assertManagedPrintableRepeat(row).verified, true);
  assert.equal(assertManagedPrintableLocalSequence(row.gesture.viewer, spec.characters).verified, true);
  for (const mutate of [
    row => { row.after[0].controls[spec.field] += "x"; },
    row => { row.gesture.nativeCommands[0].result = { synthetic: true }; },
    row => { row.gesture.commands.find(value => value.input.text).input.type = "text"; },
    row => { row.after[0].state.events.find(value => value.type === "keydown" && value.code === spec.code).repeat = true; },
    row => { row.after[0].state.events.find(value => value.type === "input").data = "wrong"; },
  ]) { const changed = structuredClone(row); mutate(changed); assert.throws(() => assertManagedPrintableRepeat(changed)); }
  const wrongSink = structuredClone(row.gesture.viewer); wrongSink.events[0].activeElement = "other";
  assert.throws(() => assertManagedPrintableLocalSequence(wrongSink, spec.characters));
});

test("End contributes exactly the original hold release and rejects late text or remote replay", () => {
  const held = repeatCase(managedPrintableRepeatCases.find(value => value.held)).after;
  const released = structuredClone(held), leaf = released[0]; leaf.state.heldKeys = [];
  leaf.state.events.push({ sequence: leaf.state.events.length + 1, type: "keyup", code: "KeyH", key: "h", target: "symbol", trusted: true });
  const late = { commands: [], viewer: { after: { sink: { disabled: true } } },
    nativeCommands: printableLateRelease.map(params => ({ params, startedAt: 1, acknowledgedAt: 2, result: {} })) };
  const row = { before: held, released, afterLocalRelease: structuredClone(released), late };
  assert.equal(assertManagedPrintableHeldEnd(row).verified, true);
  for (const mutate of [row => { row.late.commands.push({ operation: "humanInput" }); }, row => { row.released[0].controls.symbol += "h"; },
    row => { row.released[0].state.events.push({ type: "keyup" }); }, row => { row.afterLocalRelease[0].state.heldKeys.push("KeyZ"); }]) {
    const changed = structuredClone(row); mutate(changed); assert.throws(() => assertManagedPrintableHeldEnd(changed));
  }
});

test("OOPIF proof requires original document, native session and actual process separation", () => {
  const item = { fixture: { kind: "oopif" }, tabId: 5, target: { id: "target" } };
  const documents = [{ documentId: "root-doc", frameId: 0, url: "http://127.0.0.1:7/root", controls: null },
    { documentId: "leaf-doc", frameId: 4, url: "http://localhost:7/leaf", controls: {} }];
  const frames = documents.map((value, i) => ({ ...value, processId: i + 10, ...(i ? { parentDocumentId: "root-doc" } : {}) }));
  const context = (sequence, origin, frameId, sessionId) => ({ sequence, at: 100 + sequence, source: { tabId: 5, ...(sessionId ? { sessionId } : {}) }, method: "Runtime.executionContextCreated",
    params: { context: { id: sequence, uniqueId: String(sequence), origin, auxData: { isDefault: true, frameId } } } });
  const events = [context(1, "http://127.0.0.1:7", "target"), { sequence: 2, at: 102, source: { targetId: "target" }, method: "Target.attachedToTarget",
    params: { sessionId: "child-session", targetInfo: { type: "iframe", url: documents[1].url, targetId: "child-target" } } }, context(3, "http://localhost:7", "child-target", "child-session")];
  assert.equal(proveManagedPrintableFrames(item, documents, frames, events, 100).leafProcessId, 11);
  const sameProcess = structuredClone(frames); sameProcess[1].processId = 10;
  assert.throws(() => proveManagedPrintableFrames(item, documents, sameProcess, events, 100));
  const foreign = structuredClone(events); foreign[2].source.tabId = 6;
  assert.throws(() => proveManagedPrintableFrames(item, documents, frames, foreign, 100));
  assert.throws(() => proveManagedPrintableFrames(item, documents, frames, events.filter(row => row.method !== "Target.attachedToTarget"), 100));
});

for (const kind of ["root", "oopif"]) test(`original ${kind} fixture retains failed behavior POST bytes without accepting a replay`, async () => {
  let fixture; const server = createServer((req, res) => { if (!fixture.handle(req, res)) res.writeHead(404).end(); });
  await listenFixture(server); fixture = createManagedPrintableFixture({ kind, baseURL: `http://127.0.0.1:${server.address().port}` });
  try {
    for (const url of [fixture.urls.root, ...(kind === "oopif" ? [fixture.urls.emitter] : [])]) {
      const response = await fetch(url), text = await response.text(); assert.equal(response.status, 200);
      assert.doesNotThrow(() => new vm.Script(text.match(/<script>([\s\S]*?)<\/script>/)[1]));
    }
    const controls = initial(); controls.blocked = "seedx";
    const body = JSON.stringify({ workflowId: fixture.workflowId, documentToken: fixture.stats().tokens[kind === "oopif" ? "leaf" : "root"], posts: 1,
      controls, events: [{ type: "submit", trusted: true, sequence: 1 }] });
    const response = await fetch(fixture.urls.receipt, { method: "POST", body }), receipt = await response.json();
    assert.equal(response.status, 200); assert.equal(receipt.recorded, true); assert.deepEqual(receipt.controls, controls);
    assert.equal(receipt.ok, undefined, "Recording is not a feature success claim"); assert.equal(receipt.bodySHA256, sha(body));
    const post = fixture.stats().requests.find(row => row.method === "POST"); assert.equal(Buffer.from(post.body.base64, "base64").toString(), body);
    assert.equal(post.body.sha256, sha(body)); assert.equal(post.body.truncated, false);
    assert.equal((await fetch(fixture.urls.receipt, { method: "POST", body })).status, 400);
    assert.equal((await fetch(fixture.urls.root)).status, 409);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
