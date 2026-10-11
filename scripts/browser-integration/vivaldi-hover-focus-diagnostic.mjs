// Harness-only summaries. No browser action or fixture observer is installed here.
import assert from "node:assert/strict";
import { isDeepStrictEqual as equal } from "node:util";
import { inputDOMTraceComplete } from "./vivaldi-input-diagnostic.mjs";

export function vivaldiHoverFocusEnabled(value, { name, input = false, taskReadiness = false, keyInput = false, pointerFocus = false, domFocus = false, readiness = false, nativeDiagnostics = false, ownership = false } = {}) {
  if (value === undefined || value === "" || value === "0") return false;
  assert.equal(value, "1", "OBU_TEST_VIVALDI_HOVER_FOCUS must be unset, empty, 0 or 1");
  assert.equal(name, "vivaldi", "Hover focus diagnostics require the actual Vivaldi browser");
  assert.equal(input || taskReadiness || keyInput || pointerFocus || domFocus || readiness || nativeDiagnostics || ownership, false, "Hover focus diagnostics cannot be combined with other explicit modes");
  return true;
}

function completePayload(value) {
  if (!value || typeof value !== "object") return true;
  if (value.diagnosticTruncated || value.diagnosticType || value.__diagnosticTruncated) return false;
  return Object.values(value).every(completePayload);
}
const within = (at, step) => Number.isFinite(step?.requestedAt) && Number.isFinite(step?.completedAt) ? at >= step.requestedAt && at <= step.completedAt : null;
// CDP's optional defaults: Input.pdl button=none; Chromium 9007248
// input_handler.cc CreateWebMouseEvent uses buttons.value_or(0).
// Explicit null/invalid values are retained, not converted to absent values.
const optional = (params, key, fallback) => Object.hasOwn(params ?? {}, key) ? params[key] : fallback;
function mouseMatches(command, type, button, buttons) {
  const params = command?.params;
  return command?.method === "Input.dispatchMouseEvent" && params?.type === type && Number.isFinite(params.x) && Number.isFinite(params.y) && optional(params, "button", "none") === button && optional(params, "buttons", 0) === buttons && optional(params, "modifiers", 0) === 0 && optional(params, "pointerType", "mouse") === "mouse" && optional(params, "clickCount", 0) === (type === "mouseMoved" ? 0 : 1);
}
function observedDocument(value) {
  return !!value && typeof value.noteHovered === "boolean" && !!value.noteRect && ["x", "y", "width", "height"].every(key => Number.isFinite(value.noteRect[key])) && value.noteRect.width >= 0 && value.noteRect.height >= 0;
}
function pointInside(point, rect) {
  if (!point || !rect || ![point.x, point.y, rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) return null;
  return point.x >= rect.x && point.y >= rect.y && point.x < rect.x + rect.width && point.y < rect.y + rect.height;
}
function completeNode(value) {
  return !!value && Number.isInteger(value.nodeId) && value.nodeId > 0 && ["tag", "id", "type"].every(key => typeof value[key] === "string") && ["originalNote", "currentNote", "connected"].every(key => typeof value[key] === "boolean");
}
const sameNodeIdentity = (left, right) => completeNode(left) && completeNode(right) && ["nodeId", "tag", "id", "type"].every(key => left[key] === right[key]);

export function hoverFocusCommandEvidence(final, { tabId, note, steps = [], detail = {}, inputSnapshots = [] }) {
  const records = final?.records ?? [];
  const hover = steps.find(step => step.operation === "hoverFocus"), fill = steps.find(step => step.operation === "fill"), submit = steps.find(step => step.operation === "click");
  const inputCommands = records.filter(record => record.kind === "start" && record.api === "debugger.sendCommand" && record.method?.startsWith("Input.")).map(start => {
    const finishes = records.filter(record => record.callId === start.callId && ["settled", "error"].includes(record.kind)), finish = finishes[0];
    return { callId: start.callId, method: start.method, sequence: start.sequence, requestedAt: start.at, target: start.target, params: start.args?.[2], status: finish?.kind ?? "pending", finishCount: finishes.length, finishSequence: finish?.sequence ?? null, finishedAt: finish?.at ?? null, matchesRootDebuggee: equal(start.target, { tabId }), payloadComplete: completePayload(start.target) && Array.isArray(start.args) && start.args.length === 3 && equal(start.target, start.args[0]) && start.method === start.args[1] && !!start.args[2] && typeof start.args[2] === "object" && completePayload(start.args[2]) && completePayload(finish?.result ?? finish?.error), withinHoverTimeWindow: within(start.at, hover), withinFillTimeWindow: within(start.at, fill), withinSubmitTimeWindow: within(start.at, submit) };
  });
  const domFocusCommands = records.filter(record => record.kind === "start" && record.api === "debugger.sendCommand" && record.method === "DOM.focus").map(record => ({ callId: record.callId, sequence: record.sequence, target: record.target, params: record.args?.[2] }));
  const nativeCollectionComplete = inputCommands.length > 0 && inputCommands.every(command => command.payloadComplete && command.finishCount === 1 && Number.isInteger(command.sequence) && Number.isInteger(command.finishSequence) && command.finishSequence > command.sequence);
  const [move, insert, ...mouse] = inputCommands;
  const hoverMoveMatches = mouseMatches(move, "mouseMoved", "none", 0);
  const expectedNote = typeof note === "string" ? /^native-vivaldi-([a-f0-9]{24})$/.exec(note) : null;
  const insertTextMatchesExpected = insert?.method === "Input.insertText" && !!expectedNote && insert.params?.text === note;
  const submitMouseMatches = mouse.length === 3 && mouse.every((command, index) => mouseMatches(command, ["mouseMoved", "mousePressed", "mouseReleased"][index], index === 0 ? "none" : "left", index === 1 ? 1 : 0));
  const nativeInputSequenceMatch = nativeCollectionComplete && inputCommands.length === 5 && inputCommands.every(command => command.status === "settled" && command.matchesRootDebuggee) && hoverMoveMatches && insertTextMatchesExpected && submitMouseMatches && move.finishSequence < insert.sequence && mouse.every((command, index) => insert.finishSequence < command.sequence && (index === 0 || mouse[index - 1].sequence < command.sequence)) && domFocusCommands.length === 0;
  const originalActions = ["hoverFocus", "fill", "click"].every(name => steps.filter(step => step.operation === name).length === 1) && !steps.some(step => ["pressSequentially", "pointerFocusClick", "domFocus"].includes(step.operation)) && [hover, fill, submit].every(step => Number.isFinite(step?.requestedAt) && Number.isFinite(step?.completedAt) && step.requestedAt <= step.completedAt) && hover.completedAt <= fill.requestedAt && fill.completedAt <= submit.requestedAt;
  const before = detail.before?.document?.inputDiagnostic, after = detail.after?.document?.inputDiagnostic, first = inputSnapshots[0]?.snapshot;
  const nonce = expectedNote?.[1] ?? null;
  const beforeComplete = !!before && before.version === 1 && before.nonce === nonce && before.documentId === first?.documentId && before.overflow === false && before.dropped === 0 && before.errors === 0 && before.truncations === 0 && Array.isArray(before.pending) && before.pending.length === 0 && before.maximumRecords === 256 && equal(before.events, first?.events) && Array.isArray(before.records) && before.records.length === before.nextSequence && equal(before.records, first?.records?.slice(0, before.records.length)) && [before.originalNote, before.state?.currentNote, before.state?.originalNote, first?.state?.currentNote, first?.state?.originalNote].every(value => sameNodeIdentity(value, first?.originalNote)) && before.state?.url === first?.state?.url && before.capturedAt <= first?.capturedAt;
  const sameDocumentEvidence = beforeComplete && inputDOMTraceComplete(inputSnapshots, nonce) && equal(after, first) && detail.before?.phase === "before-hover" && detail.after?.phase === "before-fill" && Number.isFinite(detail.before.completedAt) && detail.before.completedAt <= hover?.requestedAt && Number.isFinite(detail.after.requestedAt) && detail.after.requestedAt >= hover?.completedAt && detail.after.completedAt <= fill?.requestedAt && observedDocument(detail.before.document) && observedDocument(detail.after.document);
  const emptyOriginalNodePrecondition = sameDocumentEvidence && [before, after].every(value => [value.originalNote, value.state.originalNote, value.state.currentNote].every(node => node.originalNote === true && node.currentNote === true && node.connected === true) && value.state.value === "");
  const hoverObservations = { beforeHovered: detail.before?.document?.noteHovered ?? null, afterHovered: detail.after?.document?.noteHovered ?? null, beforeRect: detail.before?.document?.noteRect ?? null, afterRect: detail.after?.document?.noteRect ?? null, movePoint: move?.method === "Input.dispatchMouseEvent" ? { x: move.params?.x ?? null, y: move.params?.y ?? null } : null, movePointInsideBeforeRect: pointInside(move?.params, detail.before?.document?.noteRect), movePointInsideAfterRect: pointInside(move?.params, detail.after?.document?.noteRect) };
  return { inputCommands, domFocusCommands, nativeCollectionComplete, nativeInputSequenceMatch, hoverMoveMatches, insertTextMatchesExpected, submitMouseMatches, originalActions, sameDocumentEvidence, emptyOriginalNodePrecondition, hoverObservations,
    collectionComplete: nativeCollectionComplete && sameDocumentEvidence,
    experimentObserved: originalActions && nativeInputSequenceMatch && emptyOriginalNodePrecondition,
    boundary: "A single public hover call does not imply a single native move; all Input commands are counted and retained. Native ordering uses one worker sequence ledger, with local awaited steps checked separately. Cross-context time windows are observations only. The existing INPUT fixture/event set/three snapshots are unchanged. Separate noteHovered/rect/point observations never require a positive hit and do not establish DOM event delivery or widget identity. Ordinary hover CSS, event-handler and scroll effects are possible. Mouse ACKs may overlap. Matching native commands is not proof of text editing; original DOM input events and the actual unique POST determine task success. No fallback, activation, click-to-focus or input replay is performed by this diagnostic." };
}

export function hoverFocusDiagnosticResult({ inputResult, evidence }) {
  const collectionComplete = inputResult?.diagnosticCompleted === true && evidence?.collectionComplete === true;
  const experimentObserved = evidence?.experimentObserved === true;
  return { passed: false, collectionComplete, experimentObserved, diagnosticCompleted: collectionComplete && experimentObserved, exitCode: collectionComplete && experimentObserved ? 0 : 1 };
}
