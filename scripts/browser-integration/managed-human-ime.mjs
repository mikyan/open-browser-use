import assert from "node:assert/strict";
import { createHash } from "node:crypto";

export const humanIMEText = " 中文组合😀e\u0301";
export const humanIMEPreedit = Object.freeze(["zhongwen", "中文组合"]);

// Passive, isolated-viewer observation. The browser creates every event; this
// listener never dispatches input, reads a clipboard, or talks to the task.
export function installManagedIMEObserver() {
  const events = [], listeners = []; let active = true, overflow = false;
  const bounded = value => {
    if (typeof value !== "string") return null;
    if (value.length > 4096) { overflow = true; return null; }
    return value;
  };
  for (const type of ["compositionstart", "compositionupdate", "compositionend", "beforeinput", "input"]) {
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
  const snapshot = () => ({ events: structuredClone(events), active, overflow });
  Object.defineProperty(globalThis, "__managedIMEObservation", { value: { snapshot, stop() {
    for (const { type, listener } of listeners) document.removeEventListener(type, listener);
    active = false; return snapshot();
  } } });
}

export function assertManagedIMEStage({ phase, viewerBefore, viewerAfter, commands, replies, before, after, expectedDraft, text, scope, nativeCommand }) {
  assert.ok(["preedit", "commit", "cancel"].includes(phase));
  assert.equal(nativeCommand.method, phase === "commit" ? "Input.insertText" : "Input.imeSetComposition");
  assert.deepEqual(nativeCommand.params, phase === "commit" ? { text } : { text, selectionStart: text.length, selectionEnd: text.length });
  assert.equal(nativeCommand.error, undefined); assert.deepEqual(nativeCommand.result, {});
  assert.ok(Number.isSafeInteger(nativeCommand.startedAt) && nativeCommand.acknowledgedAt >= nativeCommand.startedAt && nativeCommand.settledAt >= nativeCommand.acknowledgedAt);
  for (const viewer of [viewerBefore, viewerAfter]) { assert.equal(viewer.overflow, false); assert.equal(viewer.active, true); }
  assert.deepEqual(viewerAfter.events.slice(0, viewerBefore.events.length), viewerBefore.events, "Original event prefix must remain intact");
  const events = viewerAfter.events.slice(viewerBefore.events.length);
  assert.ok(events.length > 0, "Native IME action must produce original viewer events");
  let composing = false;
  for (const [index, event] of viewerAfter.events.entries()) {
    assert.equal(event.sequence, index + 1); assert.equal(event.target, "human-input");
    // Fixed Chromium 156 dispatches the scoped compositionend without setting
    // isTrusted. Preserve that observed native limitation, not a synthetic fix.
    assert.equal(event.trusted, event.type !== "compositionend");
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
export function assertManagedIMELedger({ commands, replies, scope, commitRequestIds, text = humanIMEText }) {
  const inputs = commands.filter(row => row.operation === "humanInput" && row.leaseId === scope.leaseId);
  assert.ok(inputs.length > 0); assert.ok(inputs.every(row => row.generation === scope.generation));
  const texts = inputs.filter(row => row.input.type === "text");
  assert.equal(texts.length, 2); assert.deepEqual(texts.map(row => row.id), commitRequestIds);
  assert.notEqual(texts[0].id, texts[1].id); assert.equal(texts[1].sequence, texts[0].sequence + 1);
  for (const row of texts) {
    assert.deepEqual(row.input, { type: "text", textBytes: Buffer.byteLength(text), textSHA256: createHash("sha256").update(text).digest("hex") });
    const matches = replies.filter(reply => reply.type === "response" && reply.connection === row.connection && reply.id === row.id);
    assert.equal(matches.length, 1); assert.equal(matches[0].error, undefined);
    assert.deepEqual(matches[0].result?.inputReceipt, { leaseId: row.leaseId, generation: row.generation, sequence: row.sequence, acknowledged: true });
  }
  return { leaseId: scope.leaseId, generation: scope.generation, commitRequestIds, textCount: texts.length, lastInputSequence: inputs.at(-1).sequence };
}
