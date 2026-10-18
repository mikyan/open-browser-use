// Passive evidence only. None of these functions creates debugger authority.
import assert from "node:assert/strict";
import { managedDialogUnicode } from "./managed-dialog-fixture.mjs";

export const managedOopifWebNavigationEvents = Object.freeze([
  "onBeforeNavigate", "onCommitted", "onDOMContentLoaded", "onCompleted", "onErrorOccurred",
  "onHistoryStateUpdated", "onReferenceFragmentUpdated", "onCreatedNavigationTarget", "onTabReplaced",
]);
export function projectManagedOopifEvent(source, method, params, webEvents = managedOopifWebNavigationEvents) {
  const pick = (value, keys) => Object.fromEntries(keys.filter(key => Object.hasOwn(value ?? {}, key)).map(key => [key, structuredClone(value[key])]));
  const frame = value => pick(value, ["id", "parentId", "loaderId", "url", "urlFragment", "securityOrigin"]);
  let value;
  if (["Page.javascriptDialogOpening", "Page.javascriptDialogClosed"].includes(method)) value = pick(params, ["frameId", "url", "type", "message", "defaultPrompt", "hasBrowserHandler", "result", "userInput"]);
  else if (method === "Target.attachedToTarget") value = { ...pick(params, ["sessionId", "waitingForDebugger"]), targetInfo: pick(params.targetInfo, ["targetId", "type", "url", "attached", "openerId", "openerFrameId", "browserContextId"]) };
  else if (["Target.targetCreated", "Target.targetInfoChanged"].includes(method)) value = { targetInfo: pick(params.targetInfo, ["targetId", "type", "url", "attached", "openerId", "openerFrameId", "browserContextId"]) };
  else if (["Target.detachedFromTarget", "Target.targetDestroyed", "Target.targetCrashed"].includes(method)) value = pick(params, ["sessionId", "targetId", "status", "errorCode"]);
  else if (method === "Runtime.executionContextCreated") value = { context: { ...pick(params.context, ["id", "uniqueId", "origin"]), auxData: pick(params.context?.auxData, ["isDefault", "type", "frameId"]) } };
  else if (method === "Runtime.executionContextDestroyed") value = pick(params, ["executionContextId", "executionContextUniqueId"]);
  else if (method === "Runtime.executionContextsCleared") value = {};
  else if (["Page.frameNavigated", "Page.documentOpened"].includes(method)) value = { frame: frame(params.frame), ...pick(params, ["type"]) };
  else if (["Page.frameAttached", "Page.frameDetached"].includes(method)) value = pick(params, ["frameId", "parentFrameId", "reason"]);
  else if (["Page.frameStartedNavigating", "Page.frameRequestedNavigation", "Page.frameScheduledNavigation", "Page.frameClearedScheduledNavigation", "Page.navigatedWithinDocument", "Page.frameStartedLoading", "Page.frameStoppedLoading", "Page.frameSubtreeWillBeDetached", "Page.lifecycleEvent", "Page.backForwardCacheNotUsed", "Page.domContentEventFired", "Page.loadEventFired"].includes(method)) value = pick(params, ["frameId", "loaderId", "url", "navigationType", "reason", "disposition", "delay", "name", "timestamp"]);
  else if (method === "debugger.onDetach") value = pick(params, ["reason"]);
  else if (method.startsWith("webNavigation.") && webEvents.includes(method.slice(14))) value = pick(params, ["tabId", "frameId", "parentFrameId", "processId", "documentId", "parentDocumentId", "documentLifecycle", "url", "timeStamp", "error", "transitionType", "transitionQualifiers", "sourceTabId", "sourceFrameId", "replacedTabId"]);
  else return null;
  return { source: structuredClone(source), method, params: value };
}

function sourceMatches(source, business, sessionId) {
  if (!source || !Object.keys(source).every(key => ["tabId", "targetId", "sessionId"].includes(key))) return false;
  if (source.tabId === undefined && source.targetId === undefined) return false;
  if (source.tabId !== undefined && source.tabId !== business.tabId) return false;
  if (source.targetId !== undefined && source.targetId !== business.target.id) return false;
  return source.sessionId === sessionId;
}
function windowEvents(events, business, through = Infinity) {
  const boundary = business.observerBoundary;
  assert.ok(boundary && Number.isSafeInteger(boundary.sequence) && boundary.sequence >= 0);
  let previous = 0;
  for (const row of events) { assert.ok(Number.isSafeInteger(row.sequence) && row.sequence > previous); previous = row.sequence; }
  return events.filter(row => row.sequence > boundary.sequence && row.sequence <= through);
}
export function currentManagedRemoteAttachments(events, business, through = Infinity) {
  const rows = windowEvents(events, business, through), active = new Map(); let rootLost = false;
  for (const row of rows) {
    if (row.method === "debugger.onDetach" && sourceMatches(row.source, business, undefined)) { active.clear(); rootLost = true; }
    if (row.method === "Target.attachedToTarget" && sourceMatches(row.source, business, undefined) && row.params.targetInfo?.type === "iframe") {
      const { sessionId, targetInfo } = row.params;
      assert.ok(typeof sessionId === "string" && sessionId && typeof targetInfo.targetId === "string" && targetInfo.targetId);
      assert.ok(!active.has(sessionId), "duplicate live child attachment is ambiguous");
      active.set(sessionId, { source: { ...row.source, sessionId }, sessionId, targetId: targetInfo.targetId, attachSequence: row.sequence, url: targetInfo.url ?? "" });
    }
    if (row.method === "Target.detachedFromTarget" && (sourceMatches(row.source, business, undefined) || sourceMatches(row.source, business, row.params.sessionId))) active.delete(row.params.sessionId);
    if (["Target.targetDestroyed", "Target.targetCrashed"].includes(row.method)) for (const [id, value] of active) if (row.params.targetId === value.targetId) active.delete(id);
  }
  const values = rootLost ? [] : [...active.values()]; assert.ok(values.length <= 8, "bounded current remote attachment set");
  assert.equal(new Set(values.map(row => row.targetId)).size, values.length, "multiple live sessions for one remote target are ambiguous");
  return values;
}
function defaultContext(events, business, source, nativeFrameId, origin, through) {
  const rows = windowEvents(events, business, through).filter(row => sourceMatches(row.source, business, source.sessionId));
  const active = new Map();
  for (const row of rows) {
    if (row.method === "Runtime.executionContextsCleared" || row.method === "debugger.onDetach") active.clear();
    if (row.method === "Runtime.executionContextDestroyed") {
      for (const [id, item] of active) if (row.params.executionContextId === id || row.params.executionContextUniqueId === item.context.uniqueId) active.delete(id);
    }
    if (row.method === "Runtime.executionContextCreated" && row.params.context?.auxData?.isDefault === true) {
      const context = row.params.context;
      assert.ok(Number.isSafeInteger(context.id) && context.id > 0 && typeof context.uniqueId === "string" && context.uniqueId);
      assert.ok(!active.has(context.id), "unretired native context ID cannot be reused");
      active.set(context.id, { sequence: row.sequence, source: structuredClone(row.source), context: structuredClone(context) });
    }
  }
  const matches = [...active.values()].filter(item => item.context.auxData.frameId === nativeFrameId);
  assert.equal(matches.length, 1, "one current native default context is required");
  assert.equal(matches[0].context.auxData.type, "default");
  if (origin !== undefined) assert.equal(matches[0].context.origin, origin, "use actual default-context origin, never URL-derived securityOrigin");
  return matches[0];
}
const invalidatingPage = new Set(["Page.frameStartedNavigating", "Page.frameNavigated", "Page.documentOpened", "Page.navigatedWithinDocument", "Page.frameDetached", "Page.frameSubtreeWillBeDetached"]);
const invalidatingWeb = new Set(["webNavigation.onBeforeNavigate", "webNavigation.onCommitted", "webNavigation.onErrorOccurred", "webNavigation.onHistoryStateUpdated", "webNavigation.onReferenceFragmentUpdated", "webNavigation.onTabReplaced"]);
export function assertManagedDialogSource(record, business, events, { nativeSource, rootFrameId, through = record.opening.sequence }) {
  const opening = record.opening, frameId = opening.params.frameId;
  assert.ok(Number.isSafeInteger(through) && through >= opening.sequence);
  assert.equal(opening.method, "Page.javascriptDialogOpening");
  assert.ok(sourceMatches(opening.source, business, undefined), "the original dialog is delivered by its root attachment");
  assert.ok(typeof rootFrameId === "string" && rootFrameId && typeof frameId === "string" && frameId);
  assert.ok(sourceMatches(nativeSource, business, nativeSource.sessionId));
  const original = defaultContext(events, business, nativeSource, frameId, undefined, opening.sequence);
  assert.ok(original.sequence < opening.sequence);
  const current = defaultContext(events, business, nativeSource, frameId, undefined, through);
  assert.deepEqual(current, original, "a later context cannot replace the original displayed source");
  for (const row of windowEvents(events, business, through)) {
    if (row.sequence <= original.sequence || !invalidatingPage.has(row.method)) continue;
    if ((sourceMatches(row.source, business, undefined) || sourceMatches(row.source, business, nativeSource.sessionId)) &&
        (row.params.frameId ?? row.params.frame?.id) === frameId) assert.fail("original emitter changed after its context source was observed");
  }
  const origin = original.context.origin, url = new URL(origin);
  assert.ok(["http:", "https:"].includes(url.protocol) && url.origin === origin && Buffer.byteLength(origin) <= 2048);
  const source = { origin, frame: frameId === rootFrameId ? "top-level" : "child" };
  assert.deepEqual(record.pendingDialog.source, source, "display source must equal the original default context, never the tab URL");
  return source;
}
export function assertManagedDialogSourceUI(ui, source) {
  assert.equal(ui.dialogSource, `来源：${source.frame === "child" ? "子页面" : "主页面"} · ${source.origin}`);
  assert.equal(ui.dialogSourcePureText, true); assert.equal(ui.dialogSourceInCard, true); assert.equal(ui.dialogSourceVisible, true);
}
export function proveCurrentManagedRemoteDialog(events, business, treeRead, through = Infinity) {
  assert.equal(business.layout, "oopif");
  const root = business.proof[0], leaf = business.proof.at(-1);
  assert.equal(business.proof.length, 2); assert.equal(root.nativeFrameId, business.target.id);
  assert.ok(leaf.documentId && leaf.documentToken && root.documentId && root.documentToken);
  assert.notEqual(root.documentId, leaf.documentId); assert.notEqual(root.processId, leaf.processId);
  assert.notEqual(new URL(root.url).origin, new URL(leaf.url).origin);
  assert.ok(treeRead && Number.isSafeInteger(treeRead.beforeSequence) && Number.isSafeInteger(treeRead.afterSequence));
  assert.ok(treeRead.beforeSequence <= treeRead.afterSequence && treeRead.afterSequence <= through);
  const candidates = currentManagedRemoteAttachments(events, business, through).filter(row => row.sessionId === treeRead.source?.sessionId);
  assert.equal(candidates.length, 1, "read-only child tree must use an already current production attachment");
  const attachment = candidates[0]; assert.deepEqual(treeRead.source, attachment.source);
  assert.ok(attachment.attachSequence <= treeRead.beforeSequence);
  assert.equal(treeRead.originalDocumentId, leaf.documentId);
  const native = treeRead.result?.frameTree?.frame;
  assert.ok(native && typeof native.loaderId === "string" && native.loaderId);
  assert.equal(native.id, attachment.targetId); assert.equal(native.parentId, root.nativeFrameId);
  assert.equal(native.url + (native.urlFragment ?? ""), leaf.url);
  const childContext = defaultContext(events, business, attachment.source, native.id, new URL(leaf.url).origin, through);
  const rootContext = defaultContext(events, business, { targetId: business.target.id }, root.nativeFrameId, new URL(root.url).origin, through);
  assert.ok(childContext.sequence > attachment.attachSequence && childContext.sequence <= treeRead.beforeSequence);
  assert.ok(rootContext.sequence <= treeRead.beforeSequence);
  for (const row of windowEvents(events, business, through)) {
    const nativeId = row.params.frameId ?? row.params.frame?.id;
    const created = nativeId === root.nativeFrameId ? rootContext.sequence : nativeId === native.id ? childContext.sequence : Infinity;
    if (invalidatingPage.has(row.method) && row.sequence > created &&
        (sourceMatches(row.source, business, undefined) || sourceMatches(row.source, business, attachment.sessionId))) assert.fail("original frame changed after its default context was observed");
    if (invalidatingWeb.has(row.method) && row.params.tabId === business.tabId &&
        row.sequence > Math.min(rootContext.sequence, childContext.sequence) &&
        (row.method === "webNavigation.onTabReplaced" || [root.frameId, leaf.frameId].includes(row.params.frameId))) assert.fail("original browser document changed after the child tree read");
  }
  return { proved: true, attachment, rootContext, childContext, originalDocumentId: leaf.documentId,
    frameId: native.id, parentFrameId: native.parentId, loaderId: native.loaderId, url: leaf.url,
    originalProcessId: leaf.processId, rootProcessId: root.processId, readSequence: treeRead.afterSequence };
}
export function assertManagedRemoteDialogPair(record, business, events, through = record.closed?.sequence ?? record.opening?.sequence) {
  const witness = proveCurrentManagedRemoteDialog(events, business, business.remoteTreeRead, through);
  assert.equal(record.opening.method, "Page.javascriptDialogOpening");
  assert.equal(record.opening.params.frameId, witness.frameId);
  assert.equal(record.opening.params.url, witness.url); assert.equal(record.opening.params.type, "prompt");
  const source = record.opening.source;
  assert.ok(sourceMatches(source, business, undefined) || sourceMatches(source, business, witness.attachment.sessionId), "dialog must route through the current root or proved child session");
  assert.ok(record.opening.sequence > witness.readSequence);
  if (record.closed) {
    assert.equal(record.closed.method, "Page.javascriptDialogClosed");
    assert.deepEqual(record.closed.source, source); assert.equal(record.closed.params.frameId, witness.frameId);
    assert.ok(record.closed.sequence > record.opening.sequence);
    if (record.request) {
      assert.equal(record.request.operation, "humanDialogRespond"); assert.equal(record.request.leaseId, record.originalScope.leaseId);
      assert.equal(record.request.generation, record.originalScope.generation); assert.equal(record.request.dialogId, record.pendingDialog.dialogId);
      assert.ok(Number.isSafeInteger(record.request.at) && Number.isSafeInteger(record.opening.at) && Number.isSafeInteger(record.closed.at));
      assert.ok(record.request.at >= record.opening.at && record.request.at - record.opening.at < 5000 && record.closed.at >= record.request.at);
      assert.equal(record.closed.params.result, true); assert.equal(record.closed.params.userInput, managedDialogUnicode);
    }
  }
  return { ...witness, answered: Boolean(record.request) };
}
function ended(value, leaseId) {
  return value?.human === null && value?.pendingDialog === null && value?.status?.state === "paused" &&
    value?.viewerCleanupComplete === true && value?.humanCleanup?.leaseId === leaseId && value?.humanCleanup?.cleanupConfirmed === true;
}
export function managedOopifCleanupObservation({ state, response, explicitEnd, leaseId, ui, requireSource = false }) {
  assert.ok(typeof leaseId === "string" && leaseId);
  if (!ended(state, leaseId) || explicitEnd && !ended(response, leaseId)) return null;
  const uiCleared = Boolean(ui && ui.error === "" && ui.errorVisible === false && ui.humanStatusHidden === true &&
    ui.input?.enabled === "false" && ui.dialogVisible === false && ui.endDisabled === true && (!requireSource || ui.dialogSource === ""));
  return { cleanupConfirmed: true, leaseId, responseObserved: Boolean(response), uiCleared, ui: structuredClone(ui ?? null) };
}
export function assertManagedOopifMode(mode, outcomes) {
  assert.ok(["diagnostic", "acceptance"].includes(mode)); assert.deepEqual(outcomes.map(row => row.layout), ["root", "same", "nested", "oopif"]);
  if (mode === "acceptance") {
    for (const row of outcomes) { assert.equal(row.outcome, "answered", `required ${row.layout} answer missing`); assert.equal(row.cleanupUI?.uiCleared, true); }
    assert.equal(outcomes.at(-1).remoteWitness?.proved, true, "OOPIF answer needs current remote proof");
  }
  return { diagnosticCompleted: mode === "diagnostic", acceptedLayouts: mode === "acceptance" ? ["root", "same", "nested", "oopif"] : [],
    oopifOutcome: outcomes.at(-1).outcome, cleanupUIGaps: outcomes.filter(row => !row.cleanupUI?.uiCleared).map(row => row.layout) };
}
