import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { managedDialogUnicode } from "./managed-dialog-fixture.mjs";
import { projectManagedOopifEvent, managedOopifWebNavigationEvents, currentManagedRemoteAttachments, proveCurrentManagedRemoteDialog, assertManagedRemoteDialogPair, managedOopifCleanupObservation, assertManagedOopifMode } from "./managed-human-oopif-dialog-evidence.mjs";

function original() {
  const root = { targetId: "root" }, child = { targetId: "root", sessionId: "child-session" };
  const business = { layout: "oopif", tabId: 41, target: { id: "root" }, observerBoundary: { sequence: 10 }, proof: [
    { nativeFrameId: "root", frameId: 0, documentId: "root-doc", documentToken: "root-token", processId: 1, url: "http://127.0.0.1:50000/root" },
    { nativeFrameId: null, frameId: 5, documentId: "leaf-doc", documentToken: "leaf-token", processId: 2, url: "http://localhost:50000/leaf" },
  ] };
  const context = (id, frameId, origin) => ({ context: { id, uniqueId: "unique-" + id, origin, auxData: { isDefault: true, type: "default", frameId } } });
  const events = [
    { sequence: 1, source: root, method: "Target.attachedToTarget", params: { sessionId: "old-sdk", targetInfo: { targetId: "leaf", type: "iframe", url: business.proof[1].url } } },
    { sequence: 11, source: root, method: "Runtime.executionContextCreated", params: context(1, "root", "http://127.0.0.1:50000") },
    { sequence: 12, source: root, method: "Target.attachedToTarget", params: { sessionId: "child-session", targetInfo: { targetId: "leaf", type: "iframe", url: business.proof[1].url } } },
    { sequence: 13, source: child, method: "Runtime.executionContextCreated", params: context(2, "leaf", "http://localhost:50000") },
  ];
  business.remoteTreeRead = { source: child, beforeSequence: 13, afterSequence: 13, originalDocumentId: "leaf-doc", result: { frameTree: { frame: { id: "leaf", parentId: "root", loaderId: "loader", url: business.proof[1].url } } } };
  const record = { opening: { sequence: 15, source: root, method: "Page.javascriptDialogOpening", params: { frameId: "leaf", type: "prompt", url: business.proof[1].url } },
    closed: { sequence: 16, source: root, method: "Page.javascriptDialogClosed", params: { frameId: "leaf", result: true } } };
  return { business, events, root, child, record, context };
}
test("projection captures all selected navigation and target lifecycle metadata without script bodies", () => {
  for (const name of ["frameStartedNavigating", "frameRequestedNavigation", "frameScheduledNavigation", "frameClearedScheduledNavigation", "navigatedWithinDocument", "frameStartedLoading", "frameStoppedLoading", "frameSubtreeWillBeDetached", "lifecycleEvent", "backForwardCacheNotUsed", "domContentEventFired", "loadEventFired"]) {
    const projected = projectManagedOopifEvent({ targetId: "root" }, "Page." + name, { frameId: "leaf", loaderId: "loader", url: "http://localhost/leaf", expression: "do-not-copy" });
    assert.equal(projected.params.frameId, "leaf"); assert.equal(projected.params.expression, undefined);
  }
  for (const name of ["frameNavigated", "documentOpened"]) assert.deepEqual(projectManagedOopifEvent({}, "Page." + name, { frame: { id: "leaf", loaderId: "loader", script: "exclude" } }).params.frame, { id: "leaf", loaderId: "loader" });
  for (const name of managedOopifWebNavigationEvents) {
    const projected = projectManagedOopifEvent({}, "webNavigation." + name, { tabId: 41, documentId: "doc", processId: 2, script: "exclude" });
    assert.deepEqual(projected.params, { tabId: 41, processId: 2, documentId: "doc" });
  }
  assert.equal(projectManagedOopifEvent({}, "Debugger.scriptParsed", { script: "exclude" }), null);
});
test("serialized passive projector needs only its explicit event-list argument, not module globals", () => {
  const project = vm.runInNewContext("(" + projectManagedOopifEvent.toString() + ")", { structuredClone });
  const row = project({ tabId: 41 }, "webNavigation.onCommitted", { documentId: "doc", expression: "exclude" }, [...managedOopifWebNavigationEvents]);
  assert.equal(JSON.stringify(row), JSON.stringify({ source: { tabId: 41 }, method: "webNavigation.onCommitted", params: { documentId: "doc" } }));
});
test("current remote witness binds original child process/document, live session, actual context and child tree", () => {
  const x = original(), witness = proveCurrentManagedRemoteDialog(x.events, x.business, x.business.remoteTreeRead);
  assert.equal(witness.proved, true); assert.equal(witness.frameId, "leaf"); assert.equal(witness.childContext.context.origin, "http://localhost:50000");
  assert.deepEqual(currentManagedRemoteAttachments(x.events, x.business).map(row => row.sessionId), ["child-session"]);
});
test("native opening may route on the root while its emitter belongs to the current remote session", () => {
  const x = original(); assert.equal(assertManagedRemoteDialogPair(x.record, x.business, x.events).proved, true);
  x.record.opening.source = x.record.closed.source = x.child; assert.equal(assertManagedRemoteDialogPair(x.record, x.business, x.events).proved, true);
});
test("old SDK session, wrong root, contradictory source and absent current attachment cannot prove an answer", () => {
  for (const mutate of [x => { x.business.observerBoundary.sequence = 12; }, x => { x.business.remoteTreeRead.source.sessionId = "old-sdk"; }, x => { x.events[2].source = { targetId: "other" }; }, x => { x.events[2].source = { targetId: "root", tabId: 99 }; }, x => { x.events[2].source = { targetId: "root", extensionId: "foreign" }; }]) {
    const x = original(); mutate(x); assert.throws(() => proveCurrentManagedRemoteDialog(x.events, x.business, x.business.remoteTreeRead));
  }
});
test("remote proof refuses unrelated tree, parent, URL, document, process and read interval", () => {
  for (const mutate of [x => { x.business.remoteTreeRead.result.frameTree.frame.parentId = "other"; }, x => { x.business.remoteTreeRead.result.frameTree.frame.id = "other"; }, x => { x.business.remoteTreeRead.result.frameTree.frame.url += "?other"; }, x => { x.business.remoteTreeRead.result.frameTree.frame.loaderId = ""; }, x => { x.business.remoteTreeRead.originalDocumentId = "new"; }, x => { x.business.proof[1].processId = 1; }, x => { x.business.remoteTreeRead.beforeSequence = 11; }, x => { x.business.remoteTreeRead.afterSequence = 12; }]) {
    const x = original(); mutate(x); assert.throws(() => proveCurrentManagedRemoteDialog(x.events, x.business, x.business.remoteTreeRead));
  }
});
test("origin cannot be inferred from frame URL or securityOrigin when actual default context disagrees", () => {
  for (const change of [{ origin: "null" }, { origin: "http://127.0.0.1:50000" }, { uniqueId: "" }, { auxData: { frameId: "leaf", isDefault: false } }]) {
    const x = original(); Object.assign(x.events[3].params.context, change); assert.throws(() => proveCurrentManagedRemoteDialog(x.events, x.business, x.business.remoteTreeRead));
  }
});
test("detach, destroyed target or destroyed/cleared context invalidates original remote proof", () => {
  for (const [source, method, params] of [["root", "Target.detachedFromTarget", { sessionId: "child-session" }], ["root", "Target.targetDestroyed", { targetId: "leaf" }], ["root", "debugger.onDetach", { reason: "canceled_by_user" }], ["child", "Runtime.executionContextDestroyed", { executionContextId: 2 }], ["child", "Runtime.executionContextsCleared", {}]]) {
    const x = original(); x.events.push({ sequence: 14, source: x[source], method, params }); assert.throws(() => assertManagedRemoteDialogPair(x.record, x.business, x.events));
  }
});
test("a root detach cannot be hidden by later target reattachment in the same lease", () => {
  const x = original(); x.events.push({ sequence: 14, source: x.root, method: "debugger.onDetach", params: {} }, { ...structuredClone(x.events[2]), sequence: 17 });
  assert.deepEqual(currentManagedRemoteAttachments(x.events, x.business), []);
});
test("all native document invalidations reject proof, including navigation started before tree read", () => {
  for (const method of ["Page.frameStartedNavigating", "Page.frameNavigated", "Page.documentOpened", "Page.navigatedWithinDocument", "Page.frameDetached", "Page.frameSubtreeWillBeDetached"]) {
    const x = original(); x.events.push({ sequence: 14, source: x.root, method, params: { frameId: "leaf", frame: { id: "leaf" } } });
    x.business.remoteTreeRead.beforeSequence = x.business.remoteTreeRead.afterSequence = 14;
    assert.throws(() => assertManagedRemoteDialogPair(x.record, x.business, x.events));
  }
});
test("a proved root-routed answer requires its exact current lease/dialog and sub-five-second response", () => {
  const x = original(); Object.assign(x.record, { originalScope: { leaseId: "lease", generation: 1 }, pendingDialog: { dialogId: "dialog" }, request: { operation: "humanDialogRespond", leaseId: "lease", generation: 1, dialogId: "dialog", at: 1010 } });
  x.record.opening.at = 1000; x.record.closed.at = 1020; x.record.closed.params.userInput = managedDialogUnicode;
  assert.equal(assertManagedRemoteDialogPair(x.record, x.business, x.events).answered, true);
  for (const change of [{ leaseId: "old" }, { generation: 2 }, { dialogId: "old" }, { at: 999 }, { at: 6000 }]) assert.throws(() => assertManagedRemoteDialogPair({ ...x.record, request: { ...x.record.request, ...change } }, x.business, x.events));
});
test("events after the original Closed cannot invalidate its earlier proof, but pre-Closed replacement does", () => {
  const x = original(); x.events.push({ sequence: 17, source: x.child, method: "Runtime.executionContextsCleared", params: {} });
  assert.equal(assertManagedRemoteDialogPair(x.record, x.business, x.events).proved, true);
  x.events.at(-1).sequence = 14; assert.throws(() => assertManagedRemoteDialogPair(x.record, x.business, x.events));
});
test("webNavigation invalidation and default-context replacement cannot retain old proof", () => {
  for (const method of ["onBeforeNavigate", "onCommitted", "onErrorOccurred", "onHistoryStateUpdated", "onReferenceFragmentUpdated", "onTabReplaced"]) {
    const x = original(); x.events.push({ sequence: 14, source: {}, method: "webNavigation." + method, params: { tabId: 41, frameId: 5, documentId: "leaf-doc" } }); assert.throws(() => assertManagedRemoteDialogPair(x.record, x.business, x.events));
  }
  const x = original(); x.events.push({ sequence: 14, source: x.child, method: "Runtime.executionContextsCleared", params: {} }, { sequence: 15, source: x.child, method: "Runtime.executionContextCreated", params: x.context(3, "leaf", "http://localhost:50000") });
  assert.throws(() => proveCurrentManagedRemoteDialog(x.events, x.business, x.business.remoteTreeRead));
});
test("ambiguous live attachments/default contexts and conflicting native dialog source are rejected", () => {
  let x = original(); x.events.push({ ...structuredClone(x.events[2]), sequence: 14, params: { ...x.events[2].params, sessionId: "another" } }); assert.throws(() => currentManagedRemoteAttachments(x.events, x.business));
  x = original(); x.events.push({ sequence: 14, source: x.child, method: "Runtime.executionContextCreated", params: x.context(3, "leaf", "http://localhost:50000") }); assert.throws(() => proveCurrentManagedRemoteDialog(x.events, x.business, x.business.remoteTreeRead));
  for (const mutate of [x => { x.record.opening.params.frameId = "root"; }, x => { x.record.closed.source = { targetId: "foreign" }; }, x => { x.record.opening.source = { targetId: "root", sessionId: "old-sdk" }; }]) { x = original(); mutate(x); assert.throws(() => assertManagedRemoteDialogPair(x.record, x.business, x.events)); }
});
function ended() { return { human: null, pendingDialog: null, status: { state: "paused" }, viewerCleanupComplete: true, humanCleanup: { leaseId: "original", cleanupConfirmed: true } }; }
const cleanUI = () => ({ error: "", errorVisible: false, humanStatusHidden: true, input: { enabled: "false" }, dialogVisible: false, endDisabled: true });
test("UI cleanup waits for both original state and End response, in either delivery order", () => {
  const input = { leaseId: "original", explicitEnd: true, ui: cleanUI() };
  assert.equal(managedOopifCleanupObservation({ ...input, state: ended() }), null);
  assert.equal(managedOopifCleanupObservation({ ...input, response: ended() }), null);
  assert.equal(managedOopifCleanupObservation({ ...input, state: ended(), response: ended() }).uiCleared, true);
});
test("previous cleanup, pending viewer cleanup and late red message cannot pass current End", () => {
  const input = { leaseId: "original", explicitEnd: true, state: ended(), response: ended(), ui: cleanUI() };
  assert.equal(managedOopifCleanupObservation({ ...input, state: { ...ended(), viewerCleanupComplete: false } }), null);
  assert.equal(managedOopifCleanupObservation({ ...input, response: { ...ended(), humanCleanup: { leaseId: "old", cleanupConfirmed: true } } }), null);
  for (const change of [{ error: "正在释放人工控制", errorVisible: true }, { error: "unrelated error", errorVisible: false }, { humanStatusHidden: false }, { dialogVisible: true }, { input: { enabled: "true" } }, { endDisabled: false }]) assert.equal(managedOopifCleanupObservation({ ...input, ui: { ...cleanUI(), ...change } }).uiCleared, false);
  assert.equal(managedOopifCleanupObservation({ ...input, explicitEnd: false, response: undefined }).uiCleared, true);
});
test("diagnostic cancellation or missing event is never OOPIF acceptance and stale UI also blocks acceptance", () => {
  const rows = ["root", "same", "nested", "oopif"].map(layout => ({ layout, outcome: "answered", cleanupUI: { uiCleared: true }, remoteWitness: { proved: true } }));
  assert.equal(assertManagedOopifMode("acceptance", rows).acceptedLayouts.length, 4);
  for (const outcome of ["native-dialog-cancelled-without-answer", "native-dialog-not-observed"]) { const copy = structuredClone(rows); copy[3].outcome = outcome; assert.throws(() => assertManagedOopifMode("acceptance", copy)); assert.equal(assertManagedOopifMode("diagnostic", copy).diagnosticCompleted, true); }
  for (const change of [{ remoteWitness: null }, { cleanupUI: { uiCleared: false } }]) { const copy = structuredClone(rows); Object.assign(copy[3], change); assert.throws(() => assertManagedOopifMode("acceptance", copy)); }
});
