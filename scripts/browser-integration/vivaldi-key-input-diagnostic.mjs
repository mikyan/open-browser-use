import assert from "node:assert/strict";

export function vivaldiKeyInputEnabled(value, { name, input = false, taskReadiness = false, readiness = false, nativeDiagnostics = false, ownership = false } = {}) {
  if (value === undefined || value === "" || value === "0") return false;
  assert.equal(value, "1", "OBU_TEST_VIVALDI_KEY_INPUT must be unset, empty, 0 or 1");
  assert.equal(name, "vivaldi", "Key input diagnostics require the actual Vivaldi browser");
  assert.equal(input || taskReadiness || readiness || nativeDiagnostics || ownership, false, "Key input diagnostics cannot be combined with other explicit modes");
  return true;
}

export function keyCommandEvidence(final, { tabId, note, steps = [] }) {
  const records = final?.records ?? [], operation = steps.find(step => step.operation === "pressSequentially");
  const dispatches = records.filter(record => record.kind === "start" && record.api === "debugger.sendCommand" && record.method === "Input.dispatchKeyEvent").map(start => {
    const finish = records.find(record => record.callId === start.callId && ["settled", "error"].includes(record.kind));
    return { callId: start.callId, startSequence: start.sequence, requestedAt: start.at, target: start.target, params: start.args?.[2], matchesTaskTab: start.target?.tabId === tabId, matchesRootDebuggee: start.target?.tabId === tabId && Object.keys(start.target).length === 1, finishSequence: finish?.sequence ?? null, finishedAt: finish?.at ?? null, status: finish?.kind ?? "pending", withinKeyInputTimeWindow: Number.isFinite(operation?.completedAt) ? start.at >= operation.requestedAt && start.at <= operation.completedAt : null };
  });
  const insertTextCommands = records.filter(record => record.kind === "start" && record.api === "debugger.sendCommand" && record.method === "Input.insertText").map(record => ({ callId: record.callId, sequence: record.sequence, target: record.target, params: record.args?.[2] }));
  const downs = dispatches.filter(value => ["keyDown", "rawKeyDown"].includes(value.params?.type)), ups = dispatches.filter(value => value.params?.type === "keyUp"), chars = dispatches.filter(value => value.params?.type === "char");
  const sentTextArgument = dispatches.filter(value => ["keyDown", "char"].includes(value.params?.type)).map(value => typeof value.params.text === "string" ? value.params.text : "").join("");
  const downKeys = downs.map(value => value.params?.key ?? null), upKeys = ups.map(value => value.params?.key ?? null);
  const expectedDispatchCount = typeof note === "string" ? note.length * 2 : null;
  const exactAlternatingDownUp = dispatches.length > 0 && dispatches.length === expectedDispatchCount && dispatches.every((value, index) => index % 2 === 0 ? ["keyDown", "rawKeyDown"].includes(value.params?.type) : value.params?.type === "keyUp" && value.params.key === dispatches[index - 1].params.key && JSON.stringify(value.target) === JSON.stringify(dispatches[index - 1].target));
  const completedBeforeNextDispatch = dispatches.length > 0 && dispatches.every((value, index) => Number.isInteger(value.finishSequence) && (index === dispatches.length - 1 || value.finishSequence < dispatches[index + 1].startSequence));
  return { dispatches, insertTextCommands, dispatchCount: dispatches.length, expectedDispatchCount, exactAlternatingDownUp, completedBeforeNextDispatch, keyDownCount: downs.length, keyUpCount: ups.length, charCount: chars.length, expectedASCIICharacters: note?.length ?? null, downKeys, upKeys, sentTextArgument, matchesExpectedTextArgument: sentTextArgument === note, matchesExpectedDownKeys: downKeys.join("") === note, matchesExpectedUpKeys: upKeys.join("") === note, allTargetTabIdsMatch: dispatches.length > 0 && dispatches.every(value => value.matchesTaskTab), allRootDebuggeesMatch: dispatches.length > 0 && dispatches.every(value => value.matchesRootDebuggee),
    experimentObserved: dispatches.length > 0 && insertTextCommands.length === 0,
    boundary: "Actual original native command records only. Parameter/text/target comparisons are separate from collection completeness and DOM editing. Native dispatch ACK is not proof of event delivery or text insertion; pending command outcomes remain unknown. No command is synthesized from expected text." };
}

export function keyInputDiagnosticResult({ inputResult, gateResult, evidence }) {
  const collectionComplete = inputResult?.diagnosticCompleted === true && gateResult?.gateComplete === true;
  const experimentObserved = evidence?.experimentObserved === true;
  return { passed: false, collectionComplete, experimentObserved, diagnosticCompleted: collectionComplete && experimentObserved, exitCode: collectionComplete && experimentObserved ? 0 : 1 };
}
