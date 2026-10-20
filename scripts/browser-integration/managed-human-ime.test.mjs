import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import vm from "node:vm";
import { humanIMEText, installManagedIMEObserver, assertManagedIMEStage, assertManagedIMELedger, managedIMEPresentationMode, readManagedIMEPresentation, assessManagedIMEPresentation, managedIMEPresentationOutcome, assertManagedIMEAbandonment } from "./managed-human-ime.mjs";

test("presentation modes are explicitly enabled only for the original IME scenario", () => {
  for (const scenario of ["ime", "handoff", "keyboard", "local-paste"]) assert.equal(managedIMEPresentationMode(scenario), null);
  for (const mode of ["baseline", "acceptance"]) {
    assert.equal(managedIMEPresentationMode("ime", mode), mode);
    assert.throws(() => managedIMEPresentationMode("handoff", mode));
  }
  for (const value of ["", "true", null, true, "diagnostic"]) assert.throws(() => managedIMEPresentationMode("ime", value));
});

function presentation() {
  const style = { display: "block", visibility: "visible", opacity: "1", fontSize: "16px", overflowX: "visible", overflowY: "visible" };
  const screen = { x: 20, y: 100, width: 900, height: 600 };
  return { at: 100, activeElement: "human-input", value: "中文组合", selectionStart: 4, selectionEnd: 4, disabled: false, hidden: false,
    rect: { x: 70, y: 160, width: 220, height: 36 }, style, ancestors: [{ hidden: false, rect: screen, style: { ...style, overflowX: "hidden" } }],
    ancestorOverflow: false, screen, frame: screen, viewport: { width: 1000, height: 800 } };
}
const assess = p => assessManagedIMEPresentation({ phase: "preedit", text: "中文组合", presentation: p, anchor: { x: 75, y: 150 } });

test("presentation accepts native readable local preedit and rejects invisible, tiny, clipped or detached geometry", () => {
  assert.equal(assess(presentation()).passed, true);
  for (const mutate of [p => { p.style.opacity = "0"; }, p => { p.style.visibility = "hidden"; }, p => { p.style.display = "none"; },
    p => { p.rect.width = p.rect.height = 1; }, p => { p.rect.x = -500; }, p => { p.rect.y = 790; }, p => { p.rect.width = 1000; },
    p => { p.rect.x = 650; }, p => { p.ancestors[0].style.opacity = "0"; }, p => { p.ancestors[0].rect.width = 80; },
    p => { p.value = "stale"; }, p => { p.activeElement = "other"; }, p => { p.selectionEnd = 999; },
    p => { p.disabled = true; }, p => { p.ancestorOverflow = true; }, p => { p.style.fontSize = "1px"; }]) {
    const p = presentation(); mutate(p); assert.equal(assess(p).passed, false);
  }
});

test("commit, cancellation and End require both cleared text and withdrawn presentation", () => {
  for (const phase of ["commit", "cancel", "end"]) {
    const p = presentation(); p.value = ""; p.style.opacity = "0";
    assert.equal(assessManagedIMEPresentation({ phase, presentation: p }).passed, true);
    p.value = "stale"; assert.equal(assessManagedIMEPresentation({ phase, presentation: p }).passed, false);
    p.value = ""; p.style.opacity = "1"; assert.equal(assessManagedIMEPresentation({ phase, presentation: p }).passed, false);
  }
});

test("baseline completion never becomes acceptance and requires every original stage and End", () => {
  const stages = ["preedit", "preedit", "commit", "preedit", "preedit", "commit", "preedit", "preedit", "cancel"].map(phase => ({
    phase, presentationProof: { phase, passed: phase !== "preedit", visible: false }, ...(phase === "preedit" ? { presentationScreenshot: { file: "original.png" } } : {}) }));
  const detail = { presentationMode: "baseline", stages, endPresentationProof: { phase: "end", passed: true } };
  assert.deepEqual(managedIMEPresentationOutcome(true, detail), { featurePassed: false, diagnosticCompleted: true, diagnosticGapConfirmed: true });
  assert.deepEqual(managedIMEPresentationOutcome(false, detail), { featurePassed: false, diagnosticCompleted: false, diagnosticGapConfirmed: false });
  for (const change of [d => { d.stages.pop(); }, d => { d.stages[0].phase = "commit"; }, d => { delete d.stages[0].presentationScreenshot; }, d => { delete d.endPresentationProof; }]) {
    const d = structuredClone(detail); change(d); assert.equal(managedIMEPresentationOutcome(true, d).diagnosticGapConfirmed, false);
  }
  detail.presentationMode = "acceptance"; assert.equal(managedIMEPresentationOutcome(true, detail).featurePassed, false);
  for (const row of detail.stages) row.presentationProof.passed = true;
  assert.equal(managedIMEPresentationOutcome(true, detail).featurePassed, false);
  detail.lifecycle = { sameFieldClick: { proof: { passed: true }, newCompositionStarted: true }, endUncommitted: { proof: { passed: true } } };
  assert.equal(managedIMEPresentationOutcome(true, detail).featurePassed, true);
  detail.lifecycle.sameFieldClick.newCompositionStarted = false; assert.equal(managedIMEPresentationOutcome(true, detail).featurePassed, false);
  detail.lifecycle.sameFieldClick.newCompositionStarted = true;
  detail.endPresentationProof.passed = false; assert.equal(managedIMEPresentationOutcome(true, detail).featurePassed, false);
  assert.deepEqual(managedIMEPresentationOutcome(true, {}), {});
});

test("presentation reader copies browser computed geometry without changing native input or page state", () => {
  const p = presentation(), screen = { tagName: "DIV", id: "", hidden: false, parentElement: null, getBoundingClientRect: () => p.screen };
  const input = { value: p.value, selectionStart: 4, selectionEnd: 4, selectionDirection: "none", disabled: false, hidden: false,
    parentElement: screen, closest: selector => { assert.equal(selector, ".screen"); return screen; }, getBoundingClientRect: () => p.rect };
  const frame = { getBoundingClientRect: () => p.frame };
  const context = vm.createContext({ document: { activeElement: { id: "human-input" }, getElementById: id => id === "human-input" ? input : frame },
    getComputedStyle: () => ({ ...p.style }), innerWidth: 1000, innerHeight: 800, scrollX: 0, scrollY: 0, devicePixelRatio: 1 });
  const result = vm.runInContext(`(${readManagedIMEPresentation.toString()})()`, context);
  assert.equal(result.value, "中文组合"); assert.equal(result.rect.width, 220); assert.equal(result.ancestors.length, 1);
  result.rect.width = 999; assert.equal(p.rect.width, 220); assert.equal(input.value, "中文组合");
});

const scope = { leaseId: "original", generation: 2 };
const event = (type, data, value = data) => ({ type, data, value, target: "human-input", trusted: type !== "compositionend", isComposing: type === "input" });
const observe = events => ({ active: true, overflow: false, events: events.map((row, i) => ({ ...row, sequence: i + 1 })) });
const preedit = text => [event("compositionupdate", text), event("beforeinput", text), event("input", text)];
const textRequest = (id, sequence) => ({ id, sequence, connection: 1, operation: "humanInput", ...scope,
  input: { type: "text", textBytes: Buffer.byteLength(humanIMEText), textSHA256: createHash("sha256").update(humanIMEText).digest("hex") } });
const reply = row => ({ type: "response", id: row.id, connection: row.connection, result: { inputReceipt: { ...scope, sequence: row.sequence, acknowledged: true } } });
function proof(phase) {
  const text = phase === "commit" ? humanIMEText : phase === "cancel" ? "" : "中文组合";
  const prefix = phase === "preedit" ? [] : [event("compositionstart", ""), ...preedit("中文组合")];
  const suffix = phase === "preedit" ? [event("compositionstart", ""), ...preedit(text)] : [...preedit(text), event("compositionend", text, "")];
  const commands = phase === "commit" ? [textRequest(10, 4)] : [];
  const draft = "Original draft";
  return { phase, text, scope, viewerBefore: observe(prefix), viewerAfter: observe([...prefix, ...suffix]), commands, replies: commands.map(reply),
    before: { documentId: "document", draft, state: { documentToken: "token", eventOverflow: false, events: [] } },
    after: { documentId: "document", draft: draft + (phase === "commit" ? text : ""), state: { documentToken: "token", eventOverflow: false,
      events: phase === "commit" ? [{ type: "beforeinput", trusted: true, data: text }, { type: "input", trusted: true, data: text }] : [] } },
    expectedDraft: draft + (phase === "commit" ? text : ""),
    nativeCommand: { method: phase === "commit" ? "Input.insertText" : "Input.imeSetComposition", params: phase === "commit" ? { text } : { text, selectionStart: text.length, selectionEnd: text.length },
      startedAt: 100, acknowledgedAt: 110, settledAt: 110, result: {} } };
}

test("IME proof retains native compositionend=false while requiring original ACK and surrounding trusted events", () => {
  for (const phase of ["preedit", "commit", "cancel"]) assert.doesNotThrow(() => assertManagedIMEStage(proof(phase)));
  const commit = proof("commit"); assert.equal(commit.viewerAfter.events.at(-1).trusted, false);
});

test("candidate and cancellation never become remote commands or task mutations", () => {
  for (const phase of ["preedit", "cancel"]) for (const mutate of [
    value => { value.commands.push(textRequest(11, 5)); },
    value => { value.after.draft += "unexpected"; },
    value => { value.after.state.events.push({ type: "input", trusted: true }); },
    value => { value.viewerAfter.events.find(row => row.type === "input").trusted = false; },
    value => { value.nativeCommand.acknowledgedAt = undefined; },
    value => { value.nativeCommand.params.text = "different"; }
  ]) { const value = proof(phase); mutate(value); assert.throws(() => assertManagedIMEStage(value)); }
});

test("commit rejects duplicate/lost/stale receipts, changed document and event provenance", () => {
  for (const mutate of [
    value => { value.commands.push(structuredClone(value.commands[0])); },
    value => { value.commands = []; }, value => { value.replies = []; },
    value => { value.replies[0].result.inputReceipt.generation++; },
    value => { value.after.documentId = "new"; }, value => { value.after.state.documentToken = "new"; },
    value => { value.after.state.events.push({ type: "paste", trusted: true }); },
    value => { value.viewerAfter.events.at(-1).trusted = true; },
    value => { value.viewerAfter.events[0].type = "compositionupdate"; },
    value => { value.nativeCommand.error = "not acknowledged"; }
  ]) { const value = proof("commit"); mutate(value); assert.throws(() => assertManagedIMEStage(value)); }
});

test("whole-lease text ledger preserves identical consecutive commits and rejects late extra text between sampling windows", () => {
  const commands = [textRequest(10, 4), textRequest(11, 5)], replies = commands.map(reply);
  const value = { commands, replies, scope, commitRequestIds: [10, 11] };
  assert.equal(assertManagedIMELedger(value).textCount, 2);
  for (const mutate of [
    row => { row.commands.push(textRequest(20, 12)); },
    row => { row.commands.pop(); }, row => { row.commands[1].generation++; },
    row => { row.commands[1].sequence++; }, row => { row.replies[1].result.inputReceipt.acknowledged = false; },
    row => { row.commitRequestIds.reverse(); }
  ]) { const changed = structuredClone(value); mutate(changed); assert.throws(() => assertManagedIMELedger(changed)); }
});

test("lifecycle gestures preserve every exact intervening ACK without permitting a third text", () => {
  const pointer = { id: 20, sequence: 5, connection: 1, operation: "humanInput", ...scope, input: { type: "pointer", action: "down" } };
  const key = { ...pointer, id: 21, sequence: 6, input: { type: "key", action: "down" } };
  const commands = [textRequest(10, 4), pointer, key, textRequest(11, 7)];
  const value = { commands, replies: commands.map(reply), scope, commitRequestIds: [10, 11], interveningRequestIds: [20, 21] };
  assert.equal(assertManagedIMELedger(value).textCount, 2);
  for (const change of [v => { v.interveningRequestIds.pop(); }, v => { v.replies.splice(1, 1); }, v => { v.commands[1].sequence++; },
    v => { v.commands[1].input = textRequest(20, 5).input; }, v => { v.commands.push(textRequest(99, 8)); }]) {
    const v = structuredClone(value); change(v); assert.throws(() => assertManagedIMELedger(v));
  }
});

test("business segment after an abandoned old composition still requires a fresh native start", () => {
  const p = proof("preedit");
  const old = observe([event("compositionstart", ""), ...preedit("旧候选")]).events;
  p.viewerBefore.events = old;
  p.viewerAfter.events = [...old, ...p.viewerAfter.events.map((row, index) => ({ ...row, sequence: old.length + index + 1 }))];
  p.eventStart = old.length;
  assert.doesNotThrow(() => assertManagedIMEStage(p));
  p.viewerAfter.events.splice(old.length, 1); p.viewerAfter.events.forEach((row, index) => { row.sequence = index + 1; });
  assert.throws(() => assertManagedIMEStage(p), /compositionstart/);
});

function abandonment(kind) {
  const p = presentation(); p.style.opacity = "0"; p.value = "";
  const target = kind === "end" ? "human-end" : "frame";
  const request = kind === "end" ? { id: 30, connection: 1, operation: "humanEnd", leaseId: scope.leaseId } :
    { id: 30, connection: 1, sequence: 8, operation: "humanInput", ...scope, input: { type: "pointer", action: "down" } };
  const response = kind === "end" ? { id: 30, connection: 1, type: "response", result: { humanCleanup: { leaseId: scope.leaseId, cleanupConfirmed: true } } } : reply(request);
  const before = { documentId: "original", draft: "unchanged", state: { documentToken: "original-token", eventOverflow: false, events: [] } };
  return { kind, before, after: structuredClone(before), viewerBefore: { active: true, overflow: false, events: [], lifecycleEvents: [] },
    viewerAfter: { active: true, overflow: false, events: [], lifecycleEvents: ["mousedown", "mouseup", "click"].map((type, index) => ({ type, target, trusted: true, sequence: index + 1 })) },
    commands: [request], replies: [response], scope, presentation: p };
}

test("abandonment observes native click order without requiring a fabricated compositionend", () => {
  for (const kind of ["same-field-click", "end"]) {
    const value = abandonment(kind); assert.equal(assertManagedIMEAbandonment(value).passed, true);
    value.viewerAfter.lifecycleEvents.push({ type: "compositionend", target: "human-input", trusted: false, data: "原生候选", sequence: 4 });
    assert.equal(assertManagedIMEAbandonment(value).nativeCompositionEnds[0].data, "原生候选");
    for (const change of [v => { v.after.draft += "leak"; }, v => { v.after.documentId = "new"; }, v => { v.after.state.events.push({ type: "input" }); },
      v => { v.viewerAfter.lifecycleEvents[0].trusted = false; }, v => { v.viewerAfter.lifecycleEvents[0].type = "click"; },
      v => { v.replies = []; }, v => { v.presentation.value = "stale"; }]) {
      const v = structuredClone(value); change(v); assert.throws(() => assertManagedIMEAbandonment(v));
    }
  }
});

test("opt-in native lifecycle observer is bounded, passive and removes original capture listeners", () => {
  const listeners = [], input = { id: "human-input", value: "原生候选", selectionStart: 4, selectionEnd: 4 };
  const document = { activeElement: input, getElementById: () => input,
    addEventListener(type, listener, options) { assert.equal(options.passive, true); listeners.push({ type, listener, capture: options.capture ?? false }); },
    removeEventListener(type, listener, capture) { const index = listeners.findIndex(row => row.type === type && row.listener === listener && row.capture === capture); assert.ok(index >= 0); listeners.splice(index, 1); } };
  const context = vm.createContext({ document, structuredClone }); vm.runInContext(`(${installManagedIMEObserver.toString()})({lifecycle:true})`, context);
  const down = listeners.find(row => row.type === "mousedown").listener;
  down({ type: "mousedown", target: { id: "frame" }, isTrusted: true, clientX: 20, clientY: 30 });
  const snapshot = context.__managedIMEObservation.snapshot(); assert.equal(snapshot.lifecycleEvents[0].value, "原生候选");
  assert.equal(snapshot.lifecycleEvents[0].trusted, true); snapshot.lifecycleEvents[0].value = "mutated";
  assert.equal(context.__managedIMEObservation.snapshot().lifecycleEvents[0].value, "原生候选");
  for (let index = 0; index < 512; index++) down({ type: "mousedown", target: { id: "frame" }, isTrusted: true });
  assert.equal(context.__managedIMEObservation.snapshot().overflow, true); assert.equal(context.__managedIMEObservation.snapshot().lifecycleEvents.length, 512);
  assert.equal(context.__managedIMEObservation.stop().active, false); assert.equal(listeners.length, 0);
});

test("passive IME observer copies bounded native metadata and removes exact listeners without any input or clipboard API", () => {
  const listeners = new Map(); const document = {
    addEventListener(type, listener, options) { assert.equal(options.passive, true); listeners.set(type, listener); },
    removeEventListener(type, listener) { assert.equal(listeners.get(type), listener); listeners.delete(type); }
  };
  const context = vm.createContext({ document, structuredClone }); vm.runInContext(`(${installManagedIMEObserver.toString()})()`, context);
  const emit = (type, id = "human-input", data = "中文") => listeners.get(type)({ target: { id, value: data, selectionStart: 2, selectionEnd: 2 }, isTrusted: type !== "compositionend", data, defaultPrevented: false });
  emit("compositionstart", "other"); assert.equal(context.__managedIMEObservation.snapshot().events.length, 0);
  emit("compositionend"); const snapshot = context.__managedIMEObservation.snapshot(); assert.equal(snapshot.events[0].trusted, false);
  snapshot.events[0].data = "changed"; assert.equal(context.__managedIMEObservation.snapshot().events[0].data, "中文");
  for (let i = 0; i < 256; i++) emit("compositionupdate");
  assert.equal(context.__managedIMEObservation.snapshot().events.length, 256); assert.equal(context.__managedIMEObservation.snapshot().overflow, true);
  assert.equal(context.__managedIMEObservation.stop().active, false); assert.equal(listeners.size, 0);
});
