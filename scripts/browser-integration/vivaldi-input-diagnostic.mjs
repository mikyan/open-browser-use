import assert from "node:assert/strict";
import { nativeDiagnosticTraceComplete } from "./native-api-diagnostics.mjs";

export function vivaldiInputEnabled(value, { name, nativeDiagnostics = false, readiness = false, ownership = false } = {}) {
  if (value === undefined || value === "" || value === "0") return false;
  assert.equal(value, "1", "OBU_TEST_VIVALDI_INPUT must be unset, empty, 0 or 1");
  assert.equal(name, "vivaldi", "Input diagnostics require the actual Vivaldi browser");
  assert.equal(nativeDiagnostics || readiness || ownership, false, "Vivaldi input diagnostics cannot be combined with other diagnostic/ownership switches");
  return true;
}

// Serialized into the fixture HTML only. It never assigns a DOM value, focuses
// an element, dispatches an event, or prevents/stops native event propagation.
export function installInputEventDiagnostic(document, target, nonce, options = {}) {
  const key = "__obuInputEventDiagnostic";
  if (Object.hasOwn(target, key)) throw new Error("Input fixture observer already installed");
  const keyEvents = options.keyEvents === true;
  const pointerEvents = options.pointerEvents === true;
  if (keyEvents && pointerEvents) throw new Error("Input diagnostic variants are exclusive");
  const maximumRecords = options.maximumRecords ?? 256;
  if (!Number.isInteger(maximumRecords) || maximumRecords < 2 || maximumRecords > (keyEvents ? 1024 : 256)) throw new Error("Invalid input diagnostic capacity");
  const clock = options.clock ?? Date.now, monotonic = options.monotonic ?? (() => performance.now());
  const microtask = options.microtask ?? queueMicrotask;
  const originalNote = document.querySelector("#note"), identities = new WeakMap(), records = [], pending = new Set(), listeners = [];
  if (originalNote?.localName !== "input" || originalNote.id !== "note") throw new Error("Original fixture input missing");
  let nodeSerial = 0, sequence = 0, eventSerial = 0, dropped = 0, errors = 0, truncations = 0, finalCancellationUnknown = 0;
  const documentId = target.crypto.randomUUID(), installedAt = clock();
  const limited = value => {
    if (value === undefined || value === null) return null;
    if (typeof value === "boolean" || typeof value === "number") return value;
    if (typeof value !== "string") return null;
    if (value.length <= 512) return value;
    truncations++; return { truncated: true, length: value.length, preview: value.slice(0, 512) };
  };
  const node = value => {
    if (!value) return null;
    if (!identities.has(value)) identities.set(value, ++nodeSerial);
    return { nodeId: identities.get(value), tag: limited(value.localName), id: limited(value.id), type: limited(value.type), originalNote: value === originalNote, currentNote: value === document.querySelector("#note"), connected: value.isConnected === true };
  };
  const state = () => ({ url: limited(document.location.href), readyState: document.readyState, visibility: document.visibilityState, hasFocus: document.hasFocus(), originalNote: node(originalNote), currentNote: node(document.querySelector("#note")), activeElement: node(document.activeElement), value: limited(originalNote?.value), selectionStart: originalNote?.selectionStart ?? null, selectionEnd: originalNote?.selectionEnd ?? null, selectionDirection: originalNote?.selectionDirection ?? null });
  const append = value => { const index = sequence++; if (records.length >= maximumRecords) { dropped++; return; } records.push({ sequence: index, at: clock(), monotonicAt: monotonic(), ...value }); };
  const safe = run => { try { return run(); } catch { errors++; } };
  const types = ["focus", "blur", "select", "selectionchange", "beforeinput", "input", "change", "compositionstart", "compositionupdate", "compositionend"];
  const pointerTypes = ["pointerdown", "pointerup", "mousedown", "mouseup", "click"];
  if (keyEvents) types.push("keydown", "keypress", "keyup");
  if (pointerEvents) types.push(...pointerTypes);
  for (const type of types) {
    const listener = event => safe(() => {
      const eventId = ++eventSerial;
      // Reserve the paired microtask record before retaining the event. Once
      // full, do not retain an Event reference or schedule another observer.
      if (records.length + pending.size + 2 > maximumRecords) { dropped += 2; sequence += 2; return; }
      append({ kind: "event", eventId, type: event.type, eventTimeStamp: event.timeStamp, eventPhase: event.eventPhase, target: node(event.target), isTrusted: event.isTrusted, defaultPreventedAtCapture: event.defaultPrevented, cancelable: event.cancelable, data: limited(event.data), inputType: limited(event.inputType), isComposing: event.isComposing ?? null, key: limited(event.key), code: limited(event.code), ...(pointerEvents && pointerTypes.includes(event.type) ? { button: event.button, buttons: event.buttons, clientX: event.clientX, clientY: event.clientY, pageX: event.pageX, pageY: event.pageY, screenX: event.screenX, screenY: event.screenY, pointerId: event.pointerId ?? null, pointerType: limited(event.pointerType), isPrimary: event.isPrimary ?? null } : {}), state: state() });
      pending.add(eventId);
      microtask(() => safe(() => {
        const dispatchComplete = event.eventPhase === 0;
        if (!dispatchComplete) finalCancellationUnknown++;
        append({ kind: "after-microtask", eventId, type: event.type, eventPhase: event.eventPhase, defaultPrevented: event.defaultPrevented, dispatchComplete, finalDefaultPrevented: dispatchComplete ? event.defaultPrevented : null });
        pending.delete(eventId);
      }));
    });
    document.addEventListener(type, listener, { capture: true, passive: true }); listeners.push({ type, listener });
  }
  const controller = Object.freeze({
    snapshot() {
      const currentState = state(), originalIdentity = node(originalNote);
      const snapshot = { version: 1, nonce, documentId, installedAt, capturedAt: clock(), monotonicAt: monotonic(), maximumRecords, nextSequence: sequence, eventCount: eventSerial, dropped, overflow: dropped > 0, errors, truncations, finalCancellationUnknown, pending: [...pending], events: [...types], originalNote: originalIdentity, state: currentState, records,
        boundary: "Only this fixture document after installation. Passive capture listeners and one microtask per event add observation work. Capture-phase defaultPrevented is not final. The later value is final only when eventPhase is NONE (0); otherwise final cancellation remains unknown. DOM hasFocus may be emulated and does not identify the actual render widget. No event interception, focus, assignment or replay." };
      return JSON.parse(JSON.stringify(snapshot));
    },
    restore() { for (const { type, listener } of listeners) document.removeEventListener(type, listener, { capture: true }); return this.snapshot(); },
  });
  Object.defineProperty(target, key, { value: controller, configurable: true }); return controller;
}

export function inputFixtureSource(nonce, { keyInput = false, pointerFocus = false } = {}) {
  assert.match(nonce, /^[a-f0-9]{24}$/);
  assert.equal(keyInput && pointerFocus, false, "Input diagnostic variants are exclusive");
  return `;try { (${installInputEventDiagnostic.toString()})(document,globalThis,${JSON.stringify(nonce)}${keyInput ? ',{keyEvents:true,maximumRecords:1024}' : pointerFocus ? ',{pointerEvents:true}' : ''}); } catch { /* Missing observer makes diagnostics incomplete, never blocks the task script. */ }`;
}

export async function captureInputLedgerOnce(detail, { read, persist, now = Date.now }) {
  if (Object.hasOwn(detail, "finalAttemptedAt")) return;
  detail.finalAttemptedAt = now();
  const record = { phase: "final", requestedAt: detail.finalAttemptedAt }; detail.snapshots.push(record);
  try { record.snapshot = await read(); record.completedAt = now(); }
  catch (error) { record.error = error.stack ?? String(error); detail.errors.push({ phase: "final", error: record.error }); }
  try { await persist(); }
  catch (error) { record.persistenceError = error.stack ?? String(error); detail.errors.push({ phase: "final-persistence", error: record.persistenceError }); }
}

export function inputDOMTraceComplete(snapshots, nonce, { keyInput = false, pointerFocus = false } = {}) {
  if (keyInput && pointerFocus) return false;
  const phases = pointerFocus ? "before-pointer-click,after-pointer-click,before-fill,after-fill,final" : keyInput ? "before-key-input,after-key-input,final" : "before-fill,after-fill,final";
  if (!Array.isArray(snapshots) || snapshots.length !== (pointerFocus ? 5 : 3) || snapshots.map(value => value.phase).join(",") !== phases) return false;
  let previous;
  const expectedEvents = ["focus", "blur", "select", "selectionchange", "beforeinput", "input", "change", "compositionstart", "compositionupdate", "compositionend"];
  if (keyInput) expectedEvents.push("keydown", "keypress", "keyup");
  if (pointerFocus) expectedEvents.push("pointerdown", "pointerup", "mousedown", "mouseup", "click");
  for (const { snapshot: value } of snapshots) {
    if (!value || value.version !== 1 || value.nonce !== nonce || typeof value.documentId !== "string" || !value.documentId || value.overflow !== false || value.dropped !== 0 || value.errors !== 0 || value.truncations !== 0 || !Array.isArray(value.pending) || value.pending.length) return false;
    try { if (new URL(value.state?.url).searchParams.get("nonce") !== nonce) return false; } catch { return false; }
    if (JSON.stringify(value.events) !== JSON.stringify(expectedEvents) || !Array.isArray(value.records) || value.records.length !== value.nextSequence || value.maximumRecords !== (keyInput ? 1024 : 256) || value.records.length > value.maximumRecords) return false;
    if (value.originalNote?.originalNote !== true || value.originalNote?.tag !== "input" || value.originalNote?.id !== "note" || value.state?.currentNote?.nodeId !== value.originalNote.nodeId || value.state?.originalNote?.nodeId !== value.originalNote.nodeId) return false;
    let events = 0, unknown = 0; const open = new Map();
    for (let index = 0; index < value.records.length; index++) {
      const record = value.records[index];
      if (record.sequence !== index || !Number.isFinite(record.at) || !Number.isFinite(record.monotonicAt)) return false;
      if (record.kind === "event") {
        if (record.eventId !== ++events || !expectedEvents.includes(record.type) || record.state?.originalNote?.nodeId !== value.originalNote.nodeId) return false;
        if (pointerFocus && ["pointerdown", "pointerup", "mousedown", "mouseup", "click"].includes(record.type) && !["button", "buttons", "clientX", "clientY", "pageX", "pageY", "screenX", "screenY"].every(field => Number.isFinite(record[field]))) return false;
        open.set(record.eventId, record);
      } else if (record.kind === "after-microtask") {
        const start = open.get(record.eventId);
        if (!start || start.type !== record.type || typeof record.defaultPrevented !== "boolean" || record.dispatchComplete !== (record.eventPhase === 0) || record.finalDefaultPrevented !== (record.dispatchComplete ? record.defaultPrevented : null)) return false;
        if (!record.dispatchComplete) unknown++;
        open.delete(record.eventId);
      } else return false;
    }
    if (open.size || events !== value.eventCount || unknown !== value.finalCancellationUnknown) return false;
    if (previous && (value.documentId !== previous.documentId || value.originalNote.nodeId !== previous.originalNote.nodeId || value.records.length < previous.records.length || JSON.stringify(value.records.slice(0, previous.records.length)) !== JSON.stringify(previous.records))) return false;
    previous = value;
  }
  return true;
}

function completePayload(value) {
  if (!value || typeof value !== "object") return true;
  if (value.diagnosticTruncated || value.diagnosticType || value.__diagnosticTruncated) return false;
  return Object.values(value).every(completePayload);
}

export function inputNativeTraceComplete(initial, final, tabId) {
  if (!Number.isInteger(tabId) || !nativeDiagnosticTraceComplete(initial, final)) return false;
  for (const record of final.records) if (record.kind === "start" && record.api === "debugger.sendCommand" && typeof record.method === "string" && record.method.startsWith("Input.")) {
    if (!completePayload(record.target) || !Number.isInteger(record.target?.tabId) || !Array.isArray(record.args) || record.args.length !== 3 || JSON.stringify(record.target) !== JSON.stringify(record.args[0]) || record.args[1] !== record.method || !completePayload(record.args[2])) return false;
    if (record.method === "Input.insertText" && typeof record.args[2]?.text !== "string") return false;
  }
  return true;
}

export function inputCommandEvidence(final, { tabId, note, steps = [] }) {
  const fill = steps.find(step => step.operation === "fill"), values = final?.records ?? [];
  return values.filter(record => record.kind === "start" && record.api === "debugger.sendCommand" && (record.method === "Input.insertText" || record.method === "Runtime.callFunctionOn")).map(start => {
    const finish = values.find(record => record.callId === start.callId && ["settled", "error"].includes(record.kind));
    return { callId: start.callId, method: start.method, target: start.target, startSequence: start.sequence, requestedAt: start.at, status: finish?.kind ?? "pending", finishSequence: finish?.sequence ?? null, finishedAt: finish?.at ?? null, matchesTaskTab: start.target?.tabId === tabId, withinFillTimeWindow: Number.isFinite(fill?.completedAt) ? start.at >= fill.requestedAt && start.at <= fill.completedAt : null,
      ...(start.method === "Input.insertText" ? { text: start.args?.[2]?.text, matchesExpectedText: start.args?.[2]?.text === note } : { objectId: start.args?.[2]?.objectId ?? null, executionContextId: start.args?.[2]?.executionContextId ?? null, utilityResultValue: finish?.result?.result?.value ?? null }) };
  });
}

export function vivaldiInputResult({ readinessComplete, nativeTraceComplete, domTraceComplete, httpComplete, cleanupComplete, steps = [], inputOperation = "fill" }) {
  const originalActions = ["fill", "pressSequentially"].includes(inputOperation) && [inputOperation, "click"].every(operation => steps.filter(step => step.operation === operation).length === 1) && !steps.some(step => ["fill", "pressSequentially"].includes(step.operation) && step.operation !== inputOperation);
  const diagnosticCompleted = originalActions && [readinessComplete, nativeTraceComplete, domTraceComplete, httpComplete, cleanupComplete].every(value => value === true);
  return { passed: false, diagnosticCompleted, exitCode: diagnosticCompleted ? 0 : 1 };
}
