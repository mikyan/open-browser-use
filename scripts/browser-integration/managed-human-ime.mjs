import assert from "node:assert/strict";
import { createHash } from "node:crypto";

export const humanIMEText = " 中文组合😀e\u0301";
export const humanIMEPreedit = Object.freeze(["zhongwen", "中文组合"]);

export function managedIMEPresentationMode(scenario, value) {
  if (value === undefined) return null;
  assert.equal(scenario, "ime", "IME presentation mode is restricted to the explicit ime scenario");
  assert.ok(["baseline", "acceptance"].includes(value), "Use baseline or acceptance for OBU_TEST_HUMAN_IME_MODE");
  return value;
}

// Read only. Keep the actual layout and focused native editing value instead of
// trusting a product dataset flag. This does not locate an OS candidate window.
export function readManagedIMEPresentation() {
  const input = document.getElementById("human-input"), screen = input?.closest(".screen"), frame = document.getElementById("frame");
  const rect = element => { const r = element?.getBoundingClientRect(); return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null; };
  const styles = element => {
    const s = getComputedStyle(element);
    return { display: s.display, visibility: s.visibility, opacity: s.opacity, fontSize: s.fontSize,
      color: s.color, backgroundColor: s.backgroundColor, overflowX: s.overflowX, overflowY: s.overflowY,
      position: s.position, padding: s.padding, lineHeight: s.lineHeight, transform: s.transform };
  };
  const ancestors = []; let parent = input?.parentElement;
  while (parent && ancestors.length < 32) { ancestors.push({ tag: parent.tagName, id: parent.id, hidden: parent.hidden, rect: rect(parent), style: styles(parent) }); parent = parent.parentElement; }
  return { at: Date.now(), activeElement: document.activeElement?.id ?? null,
    value: input?.value ?? null, selectionStart: input?.selectionStart ?? null, selectionEnd: input?.selectionEnd ?? null,
    selectionDirection: input?.selectionDirection ?? null, disabled: input?.disabled ?? null, hidden: input?.hidden ?? null,
    rect: rect(input), style: input ? styles(input) : null, ancestors, ancestorOverflow: Boolean(parent),
    screen: rect(screen), frame: rect(frame), viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY, devicePixelRatio } };
}

export function assessManagedIMEPresentation({ phase, text, presentation: p, anchor }) {
  assert.ok(["preedit", "commit", "cancel", "end"].includes(phase));
  const validRect = r => r && [r.x, r.y, r.width, r.height].every(Number.isFinite) && r.width >= 0 && r.height >= 0;
  const checks = [];
  const check = (name, value) => checks.push({ name, passed: value === true });
  check("complete-layout-observation", Boolean(p && validRect(p.rect) && validRect(p.screen) && validRect(p.frame) &&
    Number.isFinite(p.viewport?.width) && p.viewport.width > 0 && Number.isFinite(p.viewport?.height) && p.viewport.height > 0 &&
    p.style && Array.isArray(p.ancestors) && p.ancestorOverflow === false));
  if (!checks[0].passed) return { phase, passed: false, checks, visible: false };
  const hiddenStyle = s => !s || s.display === "none" || ["hidden", "collapse"].includes(s.visibility) || Number(s.opacity) === 0;
  const hidden = p.hidden === true || hiddenStyle(p.style) || p.ancestors.some(row => row.hidden || hiddenStyle(row.style)) || p.rect.width <= 1 || p.rect.height <= 1;
  const visible = !hidden;
  if (phase !== "preedit") {
    check("finished-value-cleared", p.value === ""); check("finished-preedit-hidden", hidden);
    return { phase, passed: checks.every(row => row.passed), checks, visible };
  }
  check("native-preedit-value", p.value === text && typeof text === "string" && text.length > 0);
  check("original-native-input-focused", p.activeElement === "human-input" && p.disabled === false);
  check("native-selection-bounded", Number.isSafeInteger(p.selectionStart) && Number.isSafeInteger(p.selectionEnd) && p.selectionStart >= 0 && p.selectionEnd >= p.selectionStart && p.selectionEnd <= text.length);
  check("preedit-visible", visible);
  check("readable-preedit-area", p.rect.width >= 40 && p.rect.height >= 20 && parseFloat(p.style.fontSize) >= 12 &&
    Number(p.style.opacity) >= 0.9 && p.ancestors.every(row => Number(row.style.opacity) >= 0.9));
  const within = (r, box, tolerance = 1) => r.x >= box.x - tolerance && r.y >= box.y - tolerance &&
    r.x + r.width <= box.x + box.width + tolerance && r.y + r.height <= box.y + box.height + tolerance;
  check("inside-viewer-viewport", within(p.rect, { x: 0, y: 0, width: p.viewport.width, height: p.viewport.height }));
  check("inside-native-screen", within(p.rect, p.screen));
  check("not-clipped-by-ancestor", p.ancestors.every(row => validRect(row.rect) &&
    (!/(hidden|clip|auto|scroll)/.test(`${row.style.overflowX} ${row.style.overflowY}`) || within(p.rect, row.rect))));
  const dx = anchor ? Math.max(p.rect.x - anchor.x, 0, anchor.x - p.rect.x - p.rect.width) : NaN;
  const dy = anchor ? Math.max(p.rect.y - anchor.y, 0, anchor.y - p.rect.y - p.rect.height) : NaN;
  check("near-original-viewer-click", Number.isFinite(dx) && Number.isFinite(dy) && Math.hypot(dx, dy) <= 48);
  return { phase, passed: checks.every(row => row.passed), checks, visible, anchorDistance: Math.hypot(dx, dy),
    boundary: "Local preedit layout near the original viewer click; not remote caret or Windows IME candidate-window geometry" };
}

export function managedIMEPresentationOutcome(workflowPassed, detail) {
  if (!detail?.presentationMode) return {};
  const phases = ["preedit", "preedit", "commit", "preedit", "preedit", "commit", "preedit", "preedit", "cancel"];
  const complete = workflowPassed === true && detail.stages?.length === phases.length && detail.stages.every((row, index) =>
    row.phase === phases[index] && row.presentationProof?.phase === row.phase && (row.phase !== "preedit" || row.presentationScreenshot?.file)) &&
    detail.endPresentationProof?.phase === "end";
  return { featurePassed: detail.presentationMode === "acceptance" && complete && detail.stages.every(row => row.presentationProof.passed) && detail.endPresentationProof.passed &&
      detail.lifecycle?.sameFieldClick?.proof?.passed === true && detail.lifecycle?.sameFieldClick?.newCompositionStarted === true && detail.lifecycle?.endUncommitted?.proof?.passed === true,
    diagnosticCompleted: detail.presentationMode === "baseline" && complete,
    diagnosticGapConfirmed: detail.presentationMode === "baseline" && complete && detail.stages.filter(row => row.phase === "preedit").every(row => row.presentationProof.visible === false) };
}

export function assertManagedIMEAbandonment({ kind, before, after, viewerBefore, viewerAfter, commands, replies, scope, presentation }) {
  assert.ok(["same-field-click", "end"].includes(kind));
  assert.equal(after.documentId, before.documentId); assert.equal(after.state.documentToken, before.state.documentToken);
  assert.equal(after.draft, before.draft); assert.equal(after.state.eventOverflow, false);
  assert.deepEqual(after.state.events.slice(0, before.state.events.length), before.state.events);
  const taskEvents = after.state.events.slice(before.state.events.length);
  assert.equal(taskEvents.some(row => ["input", "beforeinput", "paste", "copy", "cut"].includes(row.type) || row.type.startsWith("composition")), false,
    "Abandoned local composition must never enter the original task document");
  for (const observation of [viewerBefore, viewerAfter]) { assert.equal(observation.active, true); assert.equal(observation.overflow, false); assert.ok(Array.isArray(observation.lifecycleEvents)); }
  assert.deepEqual(viewerAfter.events.slice(0, viewerBefore.events.length), viewerBefore.events);
  assert.deepEqual(viewerAfter.lifecycleEvents.slice(0, viewerBefore.lifecycleEvents.length), viewerBefore.lifecycleEvents);
  for (const [index, event] of viewerAfter.lifecycleEvents.entries()) assert.equal(event.sequence, index + 1);
  const nativeEvents = viewerAfter.lifecycleEvents.slice(viewerBefore.lifecycleEvents.length), target = kind === "end" ? "human-end" : "frame";
  let prior = -1;
  for (const type of ["mousedown", "mouseup", "click"]) {
    const index = nativeEvents.findIndex(row => row.type === type && row.target === target && row.trusted);
    assert.ok(index > prior, `Missing or reordered original native ${target} ${type}`); prior = index;
  }
  for (const request of commands) {
    assert.equal(request.leaseId, scope.leaseId); if (kind !== "end") assert.equal(request.generation, scope.generation);
    assert.equal(request.operation, kind === "end" ? "humanEnd" : "humanInput");
    if (kind !== "end") assert.ok(["pointer", "key"].includes(request.input.type));
    const matches = replies.filter(row => row.type === "response" && row.connection === request.connection && row.id === request.id);
    assert.equal(matches.length, 1); assert.equal(matches[0].error, undefined);
    if (kind === "end") assert.deepEqual(matches[0].result?.humanCleanup, { leaseId: scope.leaseId, cleanupConfirmed: true });
    else assert.deepEqual(matches[0].result?.inputReceipt, { leaseId: request.leaseId, generation: request.generation, sequence: request.sequence, acknowledged: true });
  }
  assert.ok(commands.length > 0); if (kind === "end") assert.equal(commands.length, 1);
  const cleared = assessManagedIMEPresentation({ phase: "end", presentation }); assert.equal(cleared.passed, true);
  return { passed: true, kind, requestIds: commands.map(row => row.id), taskEvents, nativeEvents,
    nativeCompositionEnds: nativeEvents.filter(row => row.type === "compositionend"),
    boundary: "Native compositionend may be absent or carry its original data; zero remote text, cleared presentation and the subsequent fresh composition are checked separately" };
}

// Passive, isolated-viewer observation. The browser creates every event; this
// listener never dispatches input, reads a clipboard, or talks to the task.
export function installManagedIMEObserver({ lifecycle = false } = {}) {
  const events = [], listeners = []; let active = true, overflow = false;
  const lifecycleEvents = [];
  const bounded = value => {
    if (typeof value !== "string") return null;
    if (value.length > 4096) { overflow = true; return null; }
    return value;
  };
  const compositionTypes = ["compositionstart", "compositionupdate", "compositionend", "beforeinput", "input"];
  if (lifecycle) for (const type of [...compositionTypes, "mousedown", "mouseup", "click", "focus", "blur"]) {
    const listener = event => {
      if (!active || !["human-input", "frame", "human-end"].includes(event.target?.id)) return;
      if (lifecycleEvents.length >= 512) { overflow = true; return; }
      lifecycleEvents.push({ sequence: lifecycleEvents.length + 1, at: Date.now(), type, target: event.target.id,
        trusted: event.isTrusted, data: bounded(event.data), value: bounded(document.getElementById("human-input")?.value),
        activeElement: document.activeElement?.id ?? null, clientX: event.clientX ?? null, clientY: event.clientY ?? null });
    };
    document.addEventListener(type, listener, { passive: true, capture: true }); listeners.push({ type, listener, capture: true });
  }
  for (const type of compositionTypes) {
    const listener = event => {
      if (!active || event.target?.id !== "human-input") return;
      if (events.length >= 256) { overflow = true; return; }
      events.push({ sequence: events.length + 1, at: Date.now(), type, target: event.target.id,
        trusted: event.isTrusted, defaultPrevented: event.defaultPrevented,
        inputType: bounded(event.inputType), data: bounded(event.data), isComposing: event.isComposing ?? null,
        value: bounded(event.target.value), selectionStart: event.target.selectionStart, selectionEnd: event.target.selectionEnd });
    };
    document.addEventListener(type, listener, { passive: true }); listeners.push({ type, listener });
  }
  const snapshot = () => ({ events: structuredClone(events), active, overflow, ...(lifecycle ? { lifecycleEvents: structuredClone(lifecycleEvents) } : {}) });
  Object.defineProperty(globalThis, "__managedIMEObservation", { value: { snapshot, stop() {
    for (const { type, listener, capture = false } of listeners) document.removeEventListener(type, listener, capture);
    active = false; return snapshot();
  } } });
}

export function assertManagedIMEStage({ phase, viewerBefore, viewerAfter, commands, replies, before, after, expectedDraft, text, scope, nativeCommand, eventStart = 0 }) {
  assert.ok(["preedit", "commit", "cancel"].includes(phase));
  assert.equal(nativeCommand.method, phase === "commit" ? "Input.insertText" : "Input.imeSetComposition");
  assert.deepEqual(nativeCommand.params, phase === "commit" ? { text } : { text, selectionStart: text.length, selectionEnd: text.length });
  assert.equal(nativeCommand.error, undefined); assert.deepEqual(nativeCommand.result, {});
  assert.ok(Number.isSafeInteger(nativeCommand.startedAt) && nativeCommand.acknowledgedAt >= nativeCommand.startedAt && nativeCommand.settledAt >= nativeCommand.acknowledgedAt);
  for (const viewer of [viewerBefore, viewerAfter]) { assert.equal(viewer.overflow, false); assert.equal(viewer.active, true); }
  assert.deepEqual(viewerAfter.events.slice(0, viewerBefore.events.length), viewerBefore.events, "Original event prefix must remain intact");
  const events = viewerAfter.events.slice(viewerBefore.events.length);
  assert.ok(events.length > 0, "Native IME action must produce original viewer events");
  assert.ok(Number.isSafeInteger(eventStart) && eventStart >= 0 && eventStart <= viewerBefore.events.length);
  let composing = false;
  for (const [index, event] of viewerAfter.events.entries()) {
    assert.equal(event.sequence, index + 1); assert.equal(event.target, "human-input");
    // Fixed Chromium 156 dispatches the scoped compositionend without setting
    // isTrusted. Preserve that observed native limitation, not a synthetic fix.
    assert.equal(event.trusted, event.type !== "compositionend");
    if (index < eventStart) continue;
    if (event.type === "compositionstart") { assert.equal(composing, false); composing = true; }
    if (event.type === "compositionupdate" || event.type === "compositionend") assert.equal(composing, true, "Original compositionstart must precede update/end");
    if (event.type === "compositionend") composing = false;
  }
  assert.equal(composing, phase === "preedit");
  assert.equal(after.documentId, before.documentId); assert.equal(after.state.documentToken, before.state.documentToken);
  assert.equal(after.state.eventOverflow, false); assert.equal(after.draft, expectedDraft);
  assert.deepEqual(after.state.events.slice(0, before.state.events.length), before.state.events);
  const nativeEvents = after.state.events.slice(before.state.events.length);
  const ended = events.filter(event => event.type === "compositionend");
  if (phase !== "commit") {
    assert.deepEqual(commands, [], "Preedit and cancellation must send no remote humanInput or other command");
    assert.equal(after.draft, before.draft); assert.deepEqual(nativeEvents, [], "No remote DOM input during local preedit/cancellation");
    if (phase === "preedit") {
      assert.equal(ended.length, 0);
      assert.ok(events.some(event => event.type === "compositionupdate" && event.data === text));
      assert.ok(events.some(event => event.type === "input" && event.isComposing === true && event.value === text));
    } else { assert.equal(ended.length, 1); assert.equal(ended[0].data, ""); }
    return { phase, eventSequences: events.map(event => event.sequence), remoteInputs: 0 };
  }
  assert.equal(ended.length, 1); assert.equal(ended[0].data, text);
  assert.equal(commands.length, 1, "Each original composition commit must be sent exactly once");
  const request = commands[0]; assert.equal(request.operation, "humanInput");
  assert.equal(request.leaseId, scope.leaseId); assert.equal(request.generation, scope.generation);
  assert.deepEqual(request.input, { type: "text", textBytes: Buffer.byteLength(text), textSHA256: createHash("sha256").update(text).digest("hex") });
  const matches = replies.filter(reply => reply.type === "response" && reply.id === request.id && reply.connection === request.connection);
  assert.equal(matches.length, 1); assert.equal(matches[0].error, undefined);
  assert.deepEqual(matches[0].result?.inputReceipt, { leaseId: request.leaseId, generation: request.generation, sequence: request.sequence, acknowledged: true });
  assert.equal(after.draft, before.draft + text);
  assert.ok(nativeEvents.some(event => event.type === "beforeinput" && event.trusted));
  assert.ok(nativeEvents.some(event => event.type === "input" && event.trusted));
  assert.equal(nativeEvents.some(event => /^composition/.test(event.type) || ["paste", "copy", "cut"].includes(event.type)), false,
    "Task receives committed text, not local composition or clipboard events");
  return { phase, requestId: request.id, sequence: request.sequence, leaseId: request.leaseId, generation: request.generation,
    textBytes: request.input.textBytes, textSHA256: request.input.textSHA256, eventSequences: events.map(event => event.sequence), nativeEvents };
}

// Close the inter-stage sampling gaps using the entire original lease ledger.
// Explicit stale-wire negative probes occur only after this End-boundary check.
export function assertManagedIMELedger({ commands, replies, scope, commitRequestIds, interveningRequestIds = [], text = humanIMEText }) {
  const inputs = commands.filter(row => row.operation === "humanInput" && row.leaseId === scope.leaseId);
  assert.ok(inputs.length > 0); assert.ok(inputs.every(row => row.generation === scope.generation));
  const texts = inputs.filter(row => row.input.type === "text");
  assert.equal(texts.length, 2); assert.deepEqual(texts.map(row => row.id), commitRequestIds);
  assert.notEqual(texts[0].id, texts[1].id);
  const intervening = inputs.filter(row => row.sequence > texts[0].sequence && row.sequence < texts[1].sequence);
  assert.deepEqual(intervening.map(row => row.id), interveningRequestIds, "Only the exact original lifecycle gestures may occur between commits");
  assert.equal(texts[1].sequence, texts[0].sequence + intervening.length + 1);
  assert.ok(intervening.every((row, index) => ["pointer", "key"].includes(row.input.type) && row.sequence === texts[0].sequence + index + 1));
  for (const row of texts) {
    assert.deepEqual(row.input, { type: "text", textBytes: Buffer.byteLength(text), textSHA256: createHash("sha256").update(text).digest("hex") });
  }
  for (const row of [...texts, ...intervening]) {
    const matches = replies.filter(reply => reply.type === "response" && reply.connection === row.connection && reply.id === row.id);
    assert.equal(matches.length, 1); assert.equal(matches[0].error, undefined);
    assert.deepEqual(matches[0].result?.inputReceipt, { leaseId: row.leaseId, generation: row.generation, sequence: row.sequence, acknowledged: true });
  }
  return { leaseId: scope.leaseId, generation: scope.generation, commitRequestIds, textCount: texts.length, lastInputSequence: inputs.at(-1).sequence };
}
