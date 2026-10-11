// Harness-only experiment. This module never runs in the production extension.
import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { inputDOMTraceComplete } from "./vivaldi-input-diagnostic.mjs";

const methods = ["DOM.getDocument", "DOM.querySelector", "DOM.describeNode", "DOM.focus"];

export function vivaldiDOMFocusEnabled(value, { name, input = false, taskReadiness = false, keyInput = false, pointerFocus = false, readiness = false, nativeDiagnostics = false, ownership = false } = {}) {
  if (value === undefined || value === "" || value === "0") return false;
  assert.equal(value, "1", "OBU_TEST_VIVALDI_DOM_FOCUS must be unset, empty, 0 or 1");
  assert.equal(name, "vivaldi", "DOM focus diagnostics require the actual Vivaldi browser");
  assert.equal(input || taskReadiness || keyInput || pointerFocus || readiness || nativeDiagnostics || ownership, false, "DOM focus diagnostics cannot be combined with other explicit modes");
  return true;
}

function nodeIdentity(node) {
  if (!node || typeof node !== "object") return null;
  const result = {};
  for (const key of ["nodeId", "backendNodeId", "nodeType", "nodeName", "localName", "documentURL", "frameId"]) if (node[key] !== undefined) {
    assert.ok(["string", "number"].includes(typeof node[key]), `Invalid DOM identity ${key}`);
    assert.ok(typeof node[key] !== "string" || node[key].length <= 2000, `Oversized DOM identity ${key}`);
    result[key] = node[key];
  }
  if (node.attributes !== undefined) {
    assert.ok(Array.isArray(node.attributes) && node.attributes.length <= 64 && node.attributes.every(value => typeof value === "string" && value.length <= 512), "Invalid or oversized DOM attributes");
    result.attributes = [...node.attributes];
  }
  return result;
}

// The injected call is the existing owner's public cdp.call, bound to the exact
// task tab. Each call uses its remaining portion of this one declared budget.
// No persistence, polling, separate debugger connection, activation or fallback
// is performed. Public cdp.call still applies its normal attachment/owner check.
export async function runDOMFocusDiagnostic({ tabId, url, call, record, budgetMs = 5000, now = Date.now }) {
  assert.ok(Number.isInteger(tabId) && tabId > 0);
  assert.ok(typeof url === "string" && url.length <= 2000);
  assert.ok(typeof call === "function" && record && typeof record === "object");
  assert.ok(Number.isInteger(budgetMs) && budgetMs > 0 && budgetMs <= 5000);
  assert.equal(Object.hasOwn(record, "requestedAt"), false, "DOM focus diagnostic cannot be replayed");
  const requestedAt = now(), deadline = requestedAt + budgetMs;
  Object.assign(record, { version: 1, tabId, url, requestedAt, deadline, budgetMs, stage: "starting", operations: [], completed: false });
  let expired = false;
  const remaining = () => {
    const value = deadline - now();
    if (expired || value <= 0) throw new Error("Vivaldi DOM focus absolute deadline expired");
    return value;
  };
  async function command(method, params, select) {
    const timeoutMs = remaining(), operation = { method, params, requestedAt: now(), timeoutMs };
    record.stage = method; record.operations.push(operation); let timer;
    try {
      const result = await Promise.race([call(method, params, { timeoutMs }), new Promise((_, reject) => {
        timer = setTimeout(() => { expired = true; reject(new Error(`${method}: Vivaldi DOM focus absolute deadline expired`)); }, timeoutMs);
      })]);
      remaining(); operation.result = select(result); operation.completedAt = now(); return result;
    } catch (error) { operation.error = error.stack ?? String(error); operation.failedAt = now(); throw error; }
    finally { clearTimeout(timer); }
  }
  try {
    const document = await command(methods[0], { depth: 0 }, result => ({ root: nodeIdentity(result?.root) }));
    assert.ok(Number.isInteger(document?.root?.nodeId) && document.root.nodeId > 0, "Missing original document node ID");
    assert.equal(document.root.nodeType, 9, "Expected the original document node");
    assert.equal(document.root.documentURL, url, "DOM document URL differs from the original task URL");
    record.documentNodeId = document.root.nodeId;
    const match = await command(methods[1], { nodeId: record.documentNodeId, selector: "#note" }, result => ({ nodeId: result?.nodeId ?? null }));
    assert.ok(Number.isInteger(match?.nodeId) && match.nodeId > 0, "Original task input was not found"); record.nodeId = match.nodeId;
    const description = await command(methods[2], { nodeId: record.nodeId, depth: 0 }, result => ({ node: nodeIdentity(result?.node) }));
    const node = description?.node;
    assert.equal(node?.nodeId, record.nodeId, "Described node identity changed"); assert.equal(node.nodeType, 1);
    assert.equal(node.localName, "input"); assert.equal(node.nodeName, "INPUT");
    assert.ok(Array.isArray(node.attributes) && node.attributes.length % 2 === 0, "Invalid original input attributes");
    const ids = node.attributes.flatMap((name, index) => index % 2 === 0 && name === "id" ? [node.attributes[index + 1]] : []);
    assert.equal(ids.length, 1, "Original input has no unique id attribute");
    assert.equal(ids[0], "note", "Described input is not #note");
    await command(methods[3], { nodeId: record.nodeId }, result => { assert.deepEqual(result, {}, "Unexpected DOM.focus result"); return {}; });
    remaining(); record.completedAt = now(); record.completed = true; record.stage = "completed"; return record;
  } catch (error) { record.stage = "failed"; record.error = error.stack ?? String(error); record.failedAt = now(); throw error; }
}

function completePayload(value) {
  if (!value || typeof value !== "object") return true;
  if (value.diagnosticTruncated || value.diagnosticType || value.__diagnosticTruncated) return false;
  return Object.values(value).every(completePayload);
}
const equal = isDeepStrictEqual;
const within = (at, operation) => Number.isFinite(operation?.requestedAt) && Number.isFinite(operation?.completedAt) ? at >= operation.requestedAt && at <= operation.completedAt : null;
function containsResult(actual, selected) {
  if (Array.isArray(selected) || !selected || typeof selected !== "object") return equal(actual, selected);
  return !!actual && typeof actual === "object" && Object.entries(selected).every(([key, value]) => Object.hasOwn(actual, key) && containsResult(actual[key], value));
}
function criticalResultComplete(method, result) {
  if (!completePayload(result)) return false;
  if (method === "DOM.getDocument") return Number.isInteger(result?.root?.nodeId) && Number.isInteger(result.root.nodeType) && typeof result.root.documentURL === "string";
  if (method === "DOM.querySelector") return Number.isInteger(result?.nodeId);
  if (method === "DOM.describeNode") return Number.isInteger(result?.node?.nodeId) && Number.isInteger(result.node.nodeType) && typeof result.node.localName === "string" && typeof result.node.nodeName === "string" && Array.isArray(result.node.attributes) && result.node.attributes.length % 2 === 0 && result.node.attributes.every(value => typeof value === "string");
  return !!result && typeof result === "object" && !Array.isArray(result);
}

export function domFocusCommandEvidence(final, { tabId, steps = [], detail = {}, inputSnapshots = [] }) {
  const records = final?.records ?? [], operations = detail.operations ?? [];
  const commands = records.filter(record => record.kind === "start" && record.api === "debugger.sendCommand" && methods.includes(record.method)).map(start => {
    const finishes = records.filter(record => record.callId === start.callId && ["settled", "error"].includes(record.kind));
    const finish = finishes[0];
    return { callId: start.callId, method: start.method, startSequence: start.sequence, requestedAt: start.at, target: start.target, params: start.args?.[2], result: finish?.result ?? null, status: finish?.kind ?? "pending", finishCount: finishes.length, finishSequence: finish?.sequence ?? null, finishedAt: finish?.at ?? null, matchesRootDebuggee: equal(start.target, { tabId }), payloadComplete: Array.isArray(start.args) && start.args.length === 3 && equal(start.args[0], start.target) && start.args[1] === start.method && completePayload(start.target) && completePayload(start.args[2]) && criticalResultComplete(start.method, finish?.result), operationIndexes: operations.flatMap((operation, index) => operation.method === start.method && within(start.at, operation) === true ? [index] : []) };
  });
  // Native and caller Date.now values are separate clock observations. Match
  // the entire unique method chain, then use the worker's own sequence ledger.
  const chain = methods.map(method => commands.filter(command => command.method === method));
  const nativeChainComplete = operations.length === 4 && commands.length === 4 && chain.every(values => values.length === 1 && values[0].finishCount === 1 && values[0].payloadComplete && values[0].finishSequence > values[0].startSequence);
  const nativeCommandMatch = nativeChainComplete && chain.every(([command], index) => commands[index] === command && command.matchesRootDebuggee && equal(command.params, operations[index].params) && (index === 3 ? equal(command.result, operations[index].result) : containsResult(command.result, operations[index].result)) && command.status === "settled" && (index === 0 || chain[index - 1][0].finishSequence < command.startSequence));
  const focusCommands = commands.filter(command => command.method === "DOM.focus");
  const fill = steps.find(step => step.operation === "fill"), submit = steps.find(step => step.operation === "click"), focus = steps.find(step => step.operation === "domFocus");
  const originalActions = ["domFocus", "fill", "click"].every(name => steps.filter(step => step.operation === name).length === 1) && !steps.some(step => ["pressSequentially", "pointerFocusClick"].includes(step.operation)) && Number.isFinite(focus?.completedAt) && focus.completedAt <= fill?.requestedAt && Number.isFinite(fill?.completedAt) && fill.completedAt <= submit?.requestedAt;
  const inputCommands = records.filter(record => record.kind === "start" && record.api === "debugger.sendCommand" && record.method?.startsWith("Input.")).map(record => {
    const finishes = records.filter(value => value.callId === record.callId && ["settled", "error"].includes(value.kind));
    const finish = finishes[0];
    return { callId: record.callId, sequence: record.sequence, at: record.at, method: record.method, target: record.target, params: record.args?.[2], finishCount: finishes.length, finishSequence: finish?.sequence ?? null, finishedAt: finish?.at ?? null, status: finish?.kind ?? "pending" };
  });
  const preFillInputCommands = inputCommands.filter(command => Number.isFinite(detail.before?.requestedAt) && Number.isFinite(fill?.requestedAt) && command.at >= detail.before.requestedAt && command.at < fill.requestedAt);
  const keyCommands = inputCommands.filter(command => command.method === "Input.dispatchKeyEvent");
  const mouseOutsideSubmit = inputCommands.filter(command => command.method === "Input.dispatchMouseEvent" && within(command.at, submit) !== true);
  const insertTextCommands = inputCommands.filter(command => command.method === "Input.insertText");
  const singleOriginalInsertText = insertTextCommands.length === 1 && within(insertTextCommands[0].at, fill) === true && equal(insertTextCommands[0].target, { tabId });
  const insertTextMatchesExpected = typeof detail.expectedNote === "string" && /^[\x20-\x7e]{39}$/.test(detail.expectedNote) && insertTextCommands.length === 1 && insertTextCommands[0].params?.text === detail.expectedNote;
  const mouseCommands = inputCommands.filter(command => command.method === "Input.dispatchMouseEvent");
  const completeInput = command => command.finishCount === 1 && command.status === "settled" && command.finishSequence > command.sequence && equal(command.target, { tabId }) && completePayload(command.params);
  const nativeInputSequenceMatch = nativeCommandMatch && insertTextCommands.length === 1 && mouseCommands.length === 3 && inputCommands.length === 4 && inputCommands[0] === insertTextCommands[0] && inputCommands.every(completeInput) && chain[3][0].finishSequence < insertTextCommands[0].sequence && mouseCommands.every((command, index) => inputCommands[index + 1] === command && command.params?.type === ["mouseMoved", "mousePressed", "mouseReleased"][index] && command.sequence > insertTextCommands[0].finishSequence && (index === 0 || mouseCommands[index - 1].sequence < command.sequence));
  const before = detail.before?.document?.inputDiagnostic, first = inputSnapshots[0]?.snapshot;
  const nonce = (() => { try { return new URL(detail.url).searchParams.get("nonce"); } catch { return null; } })();
  const active = before?.state?.activeElement;
  const activeIdentityKnown = !!before?.state && Object.hasOwn(before.state, "activeElement") && (active === null || !!active && Number.isInteger(active.nodeId) && active.nodeId > 0 && typeof active.tag === "string" && typeof active.id === "string" && ["originalNote", "currentNote", "connected"].every(key => typeof active[key] === "boolean"));
  const initialFocusState = !activeIdentityKnown ? "unknown" : active?.nodeId === before?.originalNote?.nodeId ? "focused" : "unfocused";
  const beforeComplete = !!before && activeIdentityKnown && detail.before.phase === "before-dom-focus" && Number.isFinite(detail.before.completedAt) && detail.before.completedAt <= detail.requestedAt && Number.isFinite(inputSnapshots[0]?.requestedAt) && inputSnapshots[0].requestedAt >= detail.completedAt && before.version === 1 && before.nonce === nonce && before.documentId === first?.documentId && before.overflow === false && before.dropped === 0 && before.errors === 0 && before.truncations === 0 && before.pending?.length === 0 && before.maximumRecords === 256 && equal(before.events, first?.events) && Array.isArray(before.records) && before.nextSequence === before.records.length && equal(before.records, first?.records?.slice(0, before.records.length)) && before.originalNote?.nodeId === first?.originalNote?.nodeId && before.state?.url === detail.url && before.state?.currentNote?.nodeId === before.originalNote?.nodeId && before.state?.originalNote?.nodeId === before.originalNote?.nodeId && before.capturedAt <= first?.capturedAt && inputDOMTraceComplete(inputSnapshots, nonce);
  const beforeFillOriginalNode = beforeComplete && before.originalNote?.originalNote === true && before.originalNote.connected === true && before.state?.currentNote?.connected === true;
  const experimentalPreconditions = beforeFillOriginalNode && before.state.value === "" && initialFocusState === "unfocused";
  const chainCompleted = detail.completed === true && detail.stage === "completed" && !detail.error && Number.isInteger(detail.budgetMs) && detail.budgetMs > 0 && detail.budgetMs <= 5000 && detail.deadline === detail.requestedAt + detail.budgetMs && detail.completedAt < detail.deadline && operations.length === 4 && operations.every((operation, index) => operation.method === methods[index] && Number.isFinite(operation.requestedAt) && Number.isFinite(operation.completedAt) && operation.requestedAt >= detail.requestedAt && operation.requestedAt <= operation.completedAt && operation.completedAt <= detail.completedAt && (index === 0 || operations[index - 1].completedAt <= operation.requestedAt) && !operation.error);
  return { commands, focusCommandCount: focusCommands.length, nativeChainComplete, nativeCommandMatch, nativeInputSequenceMatch, originalActions, preFillInputCommands, keyCommands, mouseOutsideSubmit, insertTextCommands, mouseCommands, singleOriginalInsertText, insertTextMatchesExpected, beforeComplete, experimentalPreconditions, inputInitiallyEmpty: before?.state?.value === "", initialFocusState, originalNodeInitiallyFocused: activeIdentityKnown ? initialFocusState === "focused" : null,
    collectionComplete: chainCompleted && nativeChainComplete && beforeComplete,
    experimentObserved: chainCompleted && originalActions && focusCommands.length === 1 && nativeCommandMatch && nativeInputSequenceMatch && insertTextMatchesExpected && experimentalPreconditions,
    boundary: "Original public CDP chain and native records only. Native order uses one worker's sequence ledger; the caller's awaited order and declared deadline are checked separately. operationIndexes, preFillInputCommands, mouseOutsideSubmit and singleOriginalInsertText use cross-context wall-clock windows only as observations, never experiment conditions or deadline proof. Mouse sends may precede earlier mouse ACKs. Diagnostic WeakMap node IDs and CDP node IDs belong to different namespaces; no numerical equivalence is inferred. Document URL, selector/describe identity and unchanged passive document/node prefixes provide separate evidence. DOM.focus can cause ordinary focus/scroll; ACK does not prove widget focus, event delivery or editing. Empty and initially unfocused input are observed experimental preconditions, never enforced by blur or assignment. Missing completion leaves time-window membership unknown." };
}

export function domFocusDiagnosticResult({ inputResult, evidence }) {
  const collectionComplete = inputResult?.diagnosticCompleted === true && evidence?.collectionComplete === true;
  const experimentObserved = evidence?.experimentObserved === true;
  return { passed: false, collectionComplete, experimentObserved, diagnosticCompleted: collectionComplete && experimentObserved, exitCode: collectionComplete && experimentObserved ? 0 : 1 };
}
