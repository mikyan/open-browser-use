import assert from "node:assert/strict";

export function vivaldiPointerFocusEnabled(value, { name, input = false, taskReadiness = false, keyInput = false, readiness = false, nativeDiagnostics = false, ownership = false } = {}) {
  if (value === undefined || value === "" || value === "0") return false;
  assert.equal(value, "1", "OBU_TEST_VIVALDI_POINTER_FOCUS must be unset, empty, 0 or 1");
  assert.equal(name, "vivaldi", "Pointer focus diagnostics require the actual Vivaldi browser");
  assert.equal(input || taskReadiness || keyInput || readiness || nativeDiagnostics || ownership, false, "Pointer focus diagnostics cannot be combined with other explicit modes");
  return true;
}

export function pointerCommandEvidence(final, { tabId, steps = [], snapshots = [] }) {
  const records = final?.records ?? [], pointer = steps.find(step => step.operation === "pointerFocusClick"), fill = steps.find(step => step.operation === "fill"), submit = steps.find(step => step.operation === "click");
  const mouseCommands = records.filter(record => record.kind === "start" && record.api === "debugger.sendCommand" && record.method === "Input.dispatchMouseEvent").map(start => {
    const finish = records.find(record => record.callId === start.callId && ["settled", "error"].includes(record.kind));
    const within = step => Number.isFinite(step?.requestedAt) && Number.isFinite(step?.completedAt) ? start.at >= step.requestedAt && start.at <= step.completedAt : null;
    return { callId: start.callId, startSequence: start.sequence, requestedAt: start.at, target: start.target, params: start.args?.[2], matchesTaskTab: start.target?.tabId === tabId, matchesRootDebuggee: start.target?.tabId === tabId && Object.keys(start.target).length === 1, finishSequence: finish?.sequence ?? null, finishedAt: finish?.at ?? null, status: finish?.kind ?? "pending", withinPointerTimeWindow: within(pointer), withinSubmitTimeWindow: within(submit) };
  });
  const windowEvidence = key => {
    const commands = mouseCommands.filter(command => command[key] === true), pressed = commands.filter(command => command.params?.type === "mousePressed"), released = commands.filter(command => command.params?.type === "mouseReleased");
    return { commands, types: commands.map(command => command.params?.type ?? null), moveCount: commands.filter(command => command.params?.type === "mouseMoved").length, pressCount: pressed.length, releaseCount: released.length, allRootDebuggeesMatch: commands.length > 0 && commands.every(command => command.matchesRootDebuggee), singlePrimaryPressReleaseObserved: pressed.length === 1 && released.length === 1 && pressed[0].startSequence < released[0].startSequence && [...pressed, ...released].every(command => command.params.button === "left" && command.params.clickCount === 1), completedBeforeNextCommand: commands.length > 0 && commands.every((command, index) => Number.isInteger(command.finishSequence) && (index === commands.length - 1 || command.finishSequence < commands[index + 1].startSequence)) };
  };
  const before = snapshots.find(value => value.phase === "before-pointer-click")?.snapshot, after = snapshots.find(value => value.phase === "after-pointer-click")?.snapshot, beforeFill = snapshots.find(value => value.phase === "before-fill")?.snapshot;
  const pointerDOMEvents = (after?.records ?? []).slice(before?.records?.length ?? 0).filter(record => record.kind === "event" && ["pointerdown", "pointerup", "mousedown", "mouseup", "click"].includes(record.type));
  const pointerWindow = windowEvidence("withinPointerTimeWindow"), submitWindow = windowEvidence("withinSubmitTimeWindow");
  const originalActions = ["pointerFocusClick", "fill", "click"].every(operation => steps.filter(step => step.operation === operation).length === 1) && !steps.some(step => step.operation === "pressSequentially") && Number.isFinite(pointer?.completedAt) && pointer.completedAt <= fill?.requestedAt && Number.isFinite(fill?.completedAt) && fill.completedAt <= submit?.requestedAt;
  return { mouseCommands, pointerWindow, submitWindow, originalActions, pointerDOMEvents, inputInitiallyEmpty: before?.state?.value === "", inputAfterPointerEmpty: after?.state?.value === "", inputBeforeFillEmpty: beforeFill?.state?.value === "", pointerStates: { before: before?.state ?? null, after: after?.state ?? null }, trustedOriginalNoteEvents: pointerDOMEvents.length > 0 && pointerDOMEvents.every(record => record.isTrusted === true && record.target?.originalNote === true && record.target.nodeId === before?.originalNote?.nodeId),
    experimentObserved: originalActions && pointerWindow.commands.length > 0,
    boundary: "Actual native mouse commands and passive DOM events only. One public locator.click may send more than one native sequence; all commands/counts are retained. Entire click, including movement, is the experimental change; no effect is attributed solely to mousedown. Parameter matching, DOM delivery, empty-value preconditions and actual editing remain separate from collection completeness. Missing completion leaves command time-window membership unknown." };
}

export function pointerFocusDiagnosticResult({ inputResult, gateResult, evidence }) {
  const collectionComplete = inputResult?.diagnosticCompleted === true && gateResult?.gateComplete === true;
  const experimentObserved = evidence?.experimentObserved === true;
  return { passed: false, collectionComplete, experimentObserved, diagnosticCompleted: collectionComplete && experimentObserved, exitCode: collectionComplete && experimentObserved ? 0 : 1 };
}
