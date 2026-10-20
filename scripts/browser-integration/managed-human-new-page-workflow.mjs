import assert from "node:assert/strict";

export function managedHumanNewPageTrigger(scenario, value) {
  if (value !== undefined) assert.equal(scenario, "new-page");
  assert.ok(value === undefined || value === "window-open" || value === "target-blank");
  return value ?? "window-open";
}

export function managedHumanNewPageMode(scenario, value) {
  if (value !== undefined) assert.equal(scenario, "new-page");
  assert.ok(value === undefined || value === "diagnostic" || value === "acceptance");
  return value ?? "diagnostic";
}

export function managedHumanNewPageVariant(scenario, mode, trigger, value) {
  if (value !== undefined) assert.equal(scenario, "new-page");
  const variant = value === undefined ? "standard" : value;
  assert.ok(["standard", "iframe", "parent-navigate", "child-close"].includes(variant));
  if (variant !== "standard") { assert.equal(mode, "acceptance"); assert.equal(trigger, "window-open"); }
  return variant;
}

export function managedHumanParentReadonlyEnabled(scenario, mode, trigger, variant, nativeTrace, value) {
  assert.ok(value === undefined || value === "0" || value === "1", "OBU_TEST_HUMAN_PARENT_READONLY must be 0 or 1");
  if (value === "1") {
    assert.equal(scenario, "new-page"); assert.equal(mode, "acceptance");
    assert.equal(trigger, "window-open"); assert.equal(variant, "parent-navigate");
    assert.equal(nativeTrace, false, "Readonly parent acceptance cannot use instrumented native tracing");
  }
  return value === "1";
}

export function assertManagedHumanParentReadonly(row) {
  assert.equal(row.parentReadonly, true); assert.equal(row.variant, "parent-navigate");
  const value = row.parentSwitch, observed = value.readonly, lease = value.selected.view;
  assert.equal(value.endSelector, "#human-end"); assert.equal(value.beginSelector, "#human-begin");
  assert.equal(value.selected.human, null); assert.equal(value.selected.status.state, "paused");
  assert.equal(lease.state, "active"); assert.equal(lease.tabId, row.tabId); assert.ok(lease.leaseId); assert.ok(lease.generation > 0);
  assert.deepEqual(observed.lease, lease);
  assert.deepEqual(observed.commandsBeforeBegin, [value.selectRequest]);
  assert.ok(observed.completedAt >= value.selectCompletedAt); assert.ok(value.beginRequest.at >= observed.completedAt);
  const { frame, decoded, screenshot } = observed;
  assert.equal(frame.controlMode, "user-view"); assert.equal(frame.humanLeaseId, undefined);
  assert.equal(frame.tabId, row.tabId); assert.equal(frame.viewLeaseId, lease.leaseId); assert.equal(frame.generation, lease.generation);
  assert.equal(frame.connection, value.selectRequest.connection); assert.ok(frame.at >= value.selectRequest.at);
  assert.ok(frame.streamId); assert.ok(Number.isSafeInteger(frame.sequence) && frame.sequence > 0);
  assert.ok(Number.isFinite(frame.metadata.monotonicTimestamp) && frame.metadata.monotonicTimestamp > 0);
  assert.match(frame.file, /^native-frame-\d{4}\.png$/); assert.match(frame.sha256, /^[a-f0-9]{64}$/);
  assert.ok(frame.bytes > 24); assert.equal(observed.savedSHA256, frame.sha256); assert.equal(observed.savedBytes, frame.bytes);
  assert.equal(decoded.controlMode, "user-view"); assert.equal(decoded.viewLeaseId, lease.leaseId); assert.equal(decoded.humanLeaseId, "");
  assert.equal(decoded.streamId, frame.streamId); assert.equal(Number(decoded.frameSequence), frame.sequence);
  assert.equal(Number(decoded.generation), frame.generation); assert.equal(Number(decoded.eventSequence), frame.eventSequence);
  assert.equal(decoded.hidden, false); assert.equal(decoded.complete, true);
  assert.equal(decoded.width, frame.width); assert.equal(decoded.height, frame.height);
  assert.equal(frame.width, lease.viewport.width); assert.equal(frame.height, lease.viewport.height);
  assert.ok(observed.decodedAt >= frame.at); assert.ok(screenshot.at >= observed.decodedAt); assert.ok(observed.completedAt >= screenshot.at);
  assert.equal(screenshot.file, "viewer-parent-readonly-before-begin.png"); assert.match(screenshot.sha256, /^[a-f0-9]{64}$/); assert.ok(screenshot.bytes > 24);
  assert.equal(observed.state.human, null); assert.deepEqual(observed.state.view, lease); assert.equal(observed.state.selectedTabId, row.tabId);
  const messages = observed.messagesBeforeBegin;
  assert.equal(messages.filter(message => message.type === "response" && message.id === value.selectRequest.id).length, 1);
  assert.ok(messages.filter(message => message.type === "state" || message.type === "response").every(message => !(message.type === "state" ? message : message.result)?.human));
  assert.ok(messages.some(message => message.type === "frame" && message.connection === frame.connection && message.streamId === frame.streamId && message.sequence === frame.sequence && message.sha256 === frame.sha256));
  const document = observed.document, original = row.parentNavigated, native = observed.native;
  returnedParent(row, document); assert.equal(document.documentId, original.documentId);
  assert.equal(document.hasFocus, false); assert.equal(document.visibilityState, "hidden");
  assert.equal(original.hasFocus, false); assert.equal(original.visibilityState, "hidden");
  assert.equal(original.native.tab.active, false);
  assert.equal(native.targets.length, 1); assert.equal(native.targets[0].id, original.native.targets[0].id); assert.equal(native.targets[0].tabId, row.tabId);
  assert.equal(native.tab.id, row.tabId); assert.equal(native.tab.active, false);
  for (const key of ["windowId", "groupId", "pinned"]) assert.equal(native.tab[key], original.native.tab[key]);
  assert.equal(typeof original.native.window.focused, "boolean");
  for (const key of ["id", "type", "state", "focused"]) assert.equal(native.window[key], original.native.window[key], `readonly preserves window ${key}`);
  const root = native.frames.filter(frame => frame.frameId === 0); assert.equal(root.length, 1);
  assert.equal(root[0].documentId, original.documentId); assert.equal(root[0].url, original.url);
  return { originalReadonlyFrame: true, leaseId: lease.leaseId, streamId: frame.streamId, sequence: frame.sequence,
    sha256: frame.sha256, documentId: document.documentId, targetId: native.targets[0].id, beforeBegin: true };
}

function sameDocument(before, after, callbacks = []) {
  assert.ok(before.documentId); assert.equal(after.documentId, before.documentId);
  assert.equal(after.frameId, before.frameId); assert.equal(after.url, before.url);
  assert.equal(after.state.documentToken, before.state.documentToken);
  assert.equal(after.state.key, before.state.key); assert.equal(after.draft, before.draft);
  assert.equal(after.state.overflow, false); assert.deepEqual(after.state.callbacks, callbacks);
}

export function assertManagedHumanNewPageSource(row) {
  const { nativeBefore, nativeAfter, original, afterClick, observerReady, observerAfter, urls } = row;
  assert.equal(observerAfter.overflow, false); assert.equal(observerAfter.closed, false);
  assert.deepEqual(observerAfter.sourceTabIds, [row.tabId]);
  assert.equal(observerAfter.events.length, 1, "Only one original native child is evidence; absence is not a gap proof");
  const event = observerAfter.events[0], details = event.details;
  assert.equal(event.sequence, observerReady.readySequence + 1);
  const source = row.sourceOriginal ?? original, sourceAfter = row.sourceAfterClick ?? afterClick;
  assert.equal(details.sourceTabId, row.tabId); assert.equal(details.sourceFrameId, source.frameId);
  assert.ok(Number.isSafeInteger(details.sourceProcessId) && details.sourceProcessId >= 0);
  assert.ok(Number.isFinite(details.timeStamp)); assert.equal(details.url, urls.child);
  assert.ok(Number.isSafeInteger(details.tabId) && details.tabId >= 0 && details.tabId !== row.tabId);
  assert.equal(nativeBefore.targets.length, 1); assert.equal(nativeAfter.targets.length, 1);
  assert.equal(nativeAfter.targets[0].id, nativeBefore.targets[0].id);
  assert.equal(nativeBefore.targets[0].tabId, row.tabId); assert.equal(nativeAfter.targets[0].tabId, row.tabId);
  const before = nativeBefore.frames.filter(frame => frame.frameId === source.frameId), after = nativeAfter.frames.filter(frame => frame.frameId === source.frameId);
  assert.equal(before.length, 1); assert.equal(after.length, 1);
  assert.equal(before[0].documentId, source.documentId);
  assert.equal(after[0].documentId, source.documentId); assert.equal(after[0].url, before[0].url);
  if (row.variant === "iframe") {
    assert.ok(source.frameId > 0); assert.equal(source.state.role, "source-frame"); assert.equal(source.url, urls.frame);
    assert.notEqual(new URL(source.url).origin, new URL(original.url).origin);
    const rootBefore = nativeBefore.frames.find(frame => frame.frameId === 0), rootAfter = nativeAfter.frames.find(frame => frame.frameId === 0);
    assert.equal(rootBefore.documentId, original.documentId); assert.equal(rootAfter.documentId, original.documentId);
    assert.deepEqual(afterClick.state.events, []); sameDocument(source, sourceAfter);
  } else assert.equal(before[0].frameId, 0);
  if (before[0].processId >= 0) assert.equal(details.sourceProcessId, before[0].processId);
  if (after[0].processId >= 0) assert.equal(details.sourceProcessId, after[0].processId);
  sameDocument(original, afterClick); assert.equal(original.state.role, "parent");
  assert.deepEqual(original.state.events, []); assert.deepEqual(source.state.events, []);
  assert.deepEqual(sourceAfter.state.events.map(e => e.type), ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]);
  for (const e of sourceAfter.state.events) {
    assert.equal(e.trusted, true); assert.equal(e.button, 0);
    assert.equal(e.ctrlKey || e.metaKey || e.altKey || e.shiftKey, false);
  }
  const pointer = row.commands.filter(command => command.operation === "humanInput");
  assert.equal(pointer.length, 2); assert.deepEqual(pointer.map(command => command.input.action), ["down", "up"]);
  for (const command of pointer) {
    assert.equal(command.input.type, "pointer"); assert.equal(command.input.button, "left"); assert.equal(command.input.modifiers, 0);
    assert.equal(command.leaseId, row.lease.leaseId); assert.equal(command.generation, row.lease.generation);
    const replies = row.replies.filter(reply => reply.type === "response" && reply.id === command.id && reply.connection === command.connection);
    assert.equal(replies.length, 1); assert.equal(replies[0].error, undefined);
    assert.deepEqual(replies[0].result.inputReceipt, { leaseId: command.leaseId, generation: command.generation, sequence: command.sequence, acknowledged: true });
  }
  assert.equal(pointer[1].sequence, pointer[0].sequence + 1);
  return { childTabId: details.tabId, sourceTabId: row.tabId, sourceFrameId: details.sourceFrameId,
    sourceProcessId: details.sourceProcessId, sourceDocumentId: source.documentId, sourceTargetId: nativeBefore.targets[0].id,
    eventSequence: event.sequence, nativeTimeStamp: details.timeStamp, inputRequestIds: pointer.map(command => command.id) };
}

function originalChild(row, value, native, operated = false) {
  assert.equal(native.targets.length, 1); assert.equal(native.targets[0].tabId, row.sourceProof.childTabId);
  assert.equal(native.targets[0].url, row.urls.child); assert.equal(value.url, row.urls.child);
  assert.equal(value.frameId, 0); assert.ok(value.documentId); assert.equal(value.state.role, "child");
  assert.equal(value.state.key, row.original.state.key); assert.equal(value.state.overflow, false);
  if (!operated) { assert.deepEqual(value.state.events, []); assert.equal(value.state.submitted, false); assert.equal(value.state.receipt, null); }
  const root = native.frames.filter(frame => frame.frameId === 0); assert.equal(root.length, 1);
  assert.equal(root[0].documentId, value.documentId); assert.equal(root[0].url, value.url);
}

export function assertManagedHumanNewPageGap(row) {
  row.sourceProof = assertManagedHumanNewPageSource(row);
  originalChild(row, row.child, row.childNative);
  originalChild(row, row.childAfterEnd, row.childNativeAfterEnd);
  assert.equal(row.childAfterEnd.documentId, row.child.documentId);
  assert.equal(row.childAfterEnd.state.documentToken, row.child.state.documentToken);
  assert.equal(row.childNativeAfterEnd.targets[0].id, row.childNative.targets[0].id);
  sameDocument(row.original, row.released); assert.deepEqual(row.released.state.events, row.afterClick.state.events);
  assert.equal(row.end.human, null); assert.equal(row.end.status.state, "paused"); assert.equal(row.end.status.cleanupComplete, true);
  assert.deepEqual(row.end.humanCleanup, { leaseId: row.lease.leaseId, cleanupConfirmed: true });
  assert.equal(row.freshStatus.human, null); assert.equal(row.freshStatus.status.state, "paused");
  assert.ok(Array.isArray(row.freshStatus.tabs)); assert.ok(Array.isArray(row.optionsAfterEnd));
  assert.ok(!row.freshStatus.tabs.some(tab => tab.id === row.sourceProof.childTabId));
  assert.ok(!row.optionsAfterEnd.some(option => option.value === String(row.sourceProof.childTabId)));
  assert.ok(row.statusRequest && row.statusRequest.operation === "status" && row.statusRequest.at >= row.endRequest.at);
  assert.equal(row.endRequest.operation, "humanEnd"); assert.equal(row.endRequest.leaseId, row.lease.leaseId);
  return { classification: "native-child-created-not-selectable", diagnosticGapConfirmed: true, featurePassed: false,
    childTabId: row.sourceProof.childTabId, childTargetId: row.childNative.targets[0].id, childDocumentId: row.child.documentId,
    boundary: "Native provenance locates the child; it does not grant authority to control it. No child adoption, waiter or direct child input." };
}

// A deliberately small facade reuses the production runner's real UI input,
// exact native receipts and lifecycle. It exposes no child-control operation.
async function prepareOriginalChild(f, row) {
  row.featurePassed = false; row.classification = "not-observed";
  row.tabId = await f.createParent(row.urls.parent);
  row.original = await f.read(row.tabId); row.nativeBefore = await f.native(row.tabId);
  if (row.variant === "iframe") { row.sourceOriginal = await f.readSource(row.tabId, row.urls.frame); row.nativeBefore = await f.native(row.tabId); }
  row.observerInstall = await f.installObserver(); row.observerReady = await f.register(row.tabId);
  await f.select(row.tabId); row.begin = await f.begin(); row.firstFrame = await f.frame(row.begin.human);
  row.lease = f.state().human; assert.equal(row.lease.tabId, row.tabId);
  row.measured = await f.read(row.tabId, row.original.documentId); sameDocument(row.original, row.measured);
  if (row.variant === "iframe") {
    row.sourceMeasured = await f.read(row.tabId, row.sourceOriginal.documentId); sameDocument(row.sourceOriginal, row.sourceMeasured);
    const frame = row.measured.point, control = row.sourceMeasured.point;
    assert.ok(control.x >= 0 && control.y >= 0 && control.x + control.width <= frame.width && control.y + control.height <= frame.height);
    row.point = await f.point({ ...control, x: frame.x + control.x, y: frame.y + control.y });
  } else row.point = await f.point(row.measured.point);
  row.positionCommands = await f.position(row.point);
  row.commands = await f.click(row.point); row.replies = f.messages();
  try { row.observerAfter = await f.waitCreated(row.tabId); }
  catch (error) { row.observerAfter = await f.trace(); row.classification = "native-child-unobserved"; throw error; }
  row.nativeAfter = await f.native(row.tabId); row.afterClick = await f.read(row.tabId, row.original.documentId);
  if (row.variant === "iframe") row.sourceAfterClick = await f.read(row.tabId, row.sourceOriginal.documentId);
  row.sourceProof = assertManagedHumanNewPageSource(row);
  row.child = await f.waitChild(row.sourceProof.childTabId, row.urls.child);
  row.childNative = await f.native(row.sourceProof.childTabId);
  originalChild(row, row.child, row.childNative);
}

export async function runManagedHumanNewPageDiagnostic(f, row) {
  row.mode = "diagnostic";
  await prepareOriginalChild(f, row);
  row.activeStatus = f.state(); row.optionsBeforeEnd = await f.options(); row.screenshot = await f.screenshot("viewer-native-child-missing.png");
  row.end = await f.end(); row.endRequest = f.lastCommand("humanEnd");
  row.released = await f.read(row.tabId, row.original.documentId);
  // Refresh is intentionally after End: focusing Refresh during human input
  // could itself trigger blur cleanup and falsify the navigation diagnosis.
  row.freshStatus = await f.refresh(); row.statusRequest = f.lastCommand("status"); row.optionsAfterEnd = await f.options();
  row.childNativeAfterEnd = await f.native(row.sourceProof.childTabId);
  row.childAfterEnd = await f.read(row.sourceProof.childTabId, row.child.documentId);
  row.proof = assertManagedHumanNewPageGap(row); row.classification = row.proof.classification;
  row.resume = await f.resume(); assert.equal(row.resume.status.state, "running");
  row.newTurn = await f.newTurn(); row.observerAfterResume = await f.trace();
  assert.deepEqual(row.observerAfterResume.events, row.observerAfter.events);
  return row.proof;
}

function ended(lease, result, request) {
  assert.equal(request.operation, "humanEnd"); assert.equal(request.leaseId, lease.leaseId);
  assert.equal(result.human, null); assert.equal(result.status.state, "paused");
  assert.equal(result.status.cleanupComplete, true); assert.equal(result.viewerCleanupComplete, true);
  assert.deepEqual(result.humanCleanup, { leaseId: lease.leaseId, cleanupConfirmed: true });
}

export function assertManagedHumanNewPageClosed(row, value) {
  assert.equal(row.variant, "child-close");
  assert.equal(value.status.human, null); assert.equal(value.status.view, null);
  assert.equal(value.status.status.state, "paused"); assert.equal(value.status.status.cleanupComplete, true);
  assert.equal(value.status.viewerCleanupComplete, true);
  assert.deepEqual(value.status.humanCleanup, { leaseId: row.childSwitch.lease.leaseId, cleanupConfirmed: true });
  assert.equal(value.native.tabId, row.sourceProof.childTabId); assert.equal(value.native.targetId, row.childNative.targets[0].id);
  assert.deepEqual(value.native.tabs, []); assert.deepEqual(value.native.targets, []);
  assert.ok(value.observedAt >= value.callbackReceivedAt); assert.ok(value.message.at >= value.callbackReceivedAt);
  assert.deepEqual(value.message.type === "state" ? value.message : value.message.result, value.status);
  assert.ok(!value.status.tabs.some(tab => tab.id === row.sourceProof.childTabId));
  assert.ok(Array.isArray(value.endReplies)); assert.ok(value.endReplies.every(reply => !reply.error)); assert.equal(value.viewerErrors, "");
  for (const command of value.commands.filter(command => command.operation === "humanEnd")) {
    assert.equal(command.leaseId, row.childSwitch.lease.leaseId);
    const replies = value.endReplies.filter(reply => reply.id === command.id && reply.connection === command.connection); assert.equal(replies.length, 1);
    ended(row.childSwitch.lease, replies[0].result, command);
  }
  return { leaseId: row.childSwitch.lease.leaseId, originalTabClosed: true, originalTargetClosed: true, cleanupConfirmed: true };
}

export function assertManagedHumanNewPageSwitch(value, oldLease, tabId, requireChoice = false, closed = null) {
  if (closed) {
    assert.equal(value.end, undefined); assert.equal(value.endRequest, undefined);
    assert.ok(value.selectionReadyAt >= closed.observedAt); assert.deepEqual(value.closedCleanup, closed.status.humanCleanup);
  } else ended(oldLease, value.end, value.endRequest);
  const request = value.selectRequest;
  assert.equal(request.operation, "select"); assert.equal(request.tabId, tabId);
  assert.ok(request.at >= (closed ? value.selectionReadyAt : value.endCompletedAt));
  assert.ok(value.options.some(option => option.value === String(tabId)));
  const choice = value.status.tabs.find(tab => tab.id === tabId); assert.ok(choice);
  assert.equal(value.status.human, null); assert.equal(value.status.status.state, "paused");
  if (requireChoice) { assert.equal(choice.kind, "browser"); assert.ok(choice.pageSelectionId); }
  if (request.pageSelectionId !== undefined) {
    assert.equal(request.pageSelectionId, choice.pageSelectionId); assert.equal(request.deliveryId, undefined);
    const receipt = value.selected.pageSelectionReceipt;
    assert.deepEqual(Object.keys(receipt).sort(), ["deliveryId", "pageSelectionId", "retained", "tabId"]);
    assert.equal(receipt.tabId, tabId); assert.equal(receipt.pageSelectionId, request.pageSelectionId);
    assert.equal(receipt.retained, true); assert.ok(typeof receipt.deliveryId === "string" && receipt.deliveryId.length);
    assert.equal(value.beginRequest.deliveryId, receipt.deliveryId);
  } else {
    assert.equal(value.selected.pageSelectionReceipt, undefined);
    if (choice.deliveryId) assert.equal(request.deliveryId, choice.deliveryId);
    assert.equal(value.beginRequest.deliveryId, request.deliveryId);
  }
  assert.equal(value.beginRequest.operation, "humanBegin"); assert.equal(value.beginRequest.tabId, tabId);
  assert.equal(value.beginRequest.pageSelectionId, undefined); assert.ok(value.beginRequest.at >= value.selectCompletedAt);
  assert.equal(value.begin.status.state, "paused"); assert.equal(value.begin.human.tabId, tabId);
  assert.equal(value.lease.tabId, tabId); assert.equal(value.lease.leaseId, value.begin.human.leaseId);
  assert.notEqual(value.lease.leaseId, oldLease.leaseId);
  assert.ok(value.lease.generation > 0); assert.equal(value.frame.humanLeaseId, value.lease.leaseId);
  return { originalLeaseId: oldLease.leaseId, newLeaseId: value.lease.leaseId, tabId,
    ...(closed ? { closedCleanup: value.closedCleanup } : { endRequestId: value.endRequest.id }), selectRequestId: request.id, beginRequestId: value.beginRequest.id };
}

function returnedParent(row, value) {
  if (row.variant === "parent-navigate") {
    assert.equal(value.frameId, 0); assert.ok(value.documentId); assert.notEqual(value.documentId, row.original.documentId);
    assert.equal(value.url, row.urls.returnedParent); assert.equal(value.state.role, "parent-returned");
    assert.notEqual(value.state.documentToken, row.original.state.documentToken);
    assert.equal(value.state.previousDocumentToken, row.original.state.documentToken);
    assert.equal(value.state.key, row.original.state.key); assert.equal(value.state.overflow, false);
    assert.equal(value.draft, row.original.draft); assert.deepEqual(value.state.callbacks, [row.callback]); assert.deepEqual(value.state.events, []);
    if (row.parentReturned) { assert.equal(value.documentId, row.parentReturned.documentId); assert.equal(value.state.documentToken, row.parentReturned.state.documentToken); }
  } else {
    sameDocument(row.original, value, [row.callback]); assert.deepEqual(value.state.events, row.afterClick.state.events);
  }
  assert.equal(value.state.waitState, "returned");
}

function stableNative(before, after, tabId) {
  assert.equal(before.targets.length, 1); assert.equal(after.targets.length, 1);
  assert.equal(before.targets[0].tabId, tabId); assert.equal(after.targets[0].tabId, tabId);
  assert.equal(after.targets[0].id, before.targets[0].id);
  assert.deepEqual(after.frames, before.frames);
  for (const key of ["windowId", "groupId", "active", "pinned"]) assert.equal(after.tab[key], before.tab[key], `claim preserves ${key}`);
  for (const key of ["id", "type", "state", "focused"]) assert.equal(after.window[key], before.window[key], `claim preserves window ${key}`);
}

export function assertManagedHumanNewPageClaim(row) {
  const value = row.agent;
  assert.equal(row.resume.status.state, "running"); assert.ok(value.startedAt >= row.newTurnCompletedAt);
  assert.equal(value.receipt.id, row.tabId); assert.equal(value.receipt.url, row.variant === "parent-navigate" ? row.urls.returnedParent : row.urls.parent); assert.ok(value.claimCompletedAt >= value.startedAt);
  assert.ok(value.readStartedAt >= value.claimCompletedAt); assert.ok(value.readCompletedAt >= value.readStartedAt);
  stableNative(value.beforeNative, value.afterNative, row.tabId);
  assert.equal(value.beforeNative.targets[0].id, row.nativeBefore.targets[0].id);
  returnedParent(row, value.before); returnedParent(row, value.after);
  assert.deepEqual(value.state, value.after.state); assert.equal(value.draft, row.original.draft);
  assert.equal(value.state.waitState, "returned");
  return { tabId: row.tabId, targetId: value.afterNative.targets[0].id, documentId: value.after.documentId,
    source: "public SDK claimUserTab then original locator textContent/inputValue", originalPlacementPreserved: true };
}

export function assertManagedHumanNewPageInputs(row, all, replies) {
  const scopes = [{ lease: row.lease, inputs: [...row.positionCommands, ...row.commands] }];
  if (row.mode === "acceptance") scopes.push({ lease: row.childSwitch.lease, inputs: [...row.childPositionCommands, ...row.childCommands] }, { lease: row.parentSwitch.lease, inputs: [] });
  for (const scope of scopes) {
    const inputs = all.filter(command => command.operation === "humanInput" && command.leaseId === scope.lease.leaseId);
    assert.deepEqual(inputs, scope.inputs, "Full original lease includes no late or extra input");
    for (const command of inputs) {
      const matching = replies.filter(reply => reply.type === "response" && reply.id === command.id && reply.connection === command.connection);
      assert.equal(matching.length, 1);
      if (matching[0].error) {
        assert.equal(row.variant, "child-close"); assert.equal(scope.lease.leaseId, row.childSwitch.lease.leaseId);
        assert.equal(command.input.action, "up"); assert.equal(command.input.type, "pointer");
        assert.ok(["HUMAN_STALE", "HUMAN_UNAVAILABLE"].includes(matching[0].error.code));
        assertManagedHumanNewPageClosed(row, row.childClosed);
      } else assert.deepEqual(matching[0].result.inputReceipt, { leaseId: command.leaseId, generation: command.generation, sequence: command.sequence, acknowledged: true });
    }
  }
  return scopes.map(scope => ({ leaseId: scope.lease.leaseId, requestIds: scope.inputs.map(input => input.id),
    ...(row.variant === "child-close" ? { results: scope.inputs.map(input => { const reply = replies.find(value => value.type === "response" && value.id === input.id && value.connection === input.connection); return { requestId: input.id, ...(reply.error ? { acknowledged: false, error: reply.error } : { acknowledged: true }) }; }) } : {}) }));
}

export async function runManagedHumanNewPageAcceptance(f, row) {
  row.mode = "acceptance";
  await prepareOriginalChild(f, row);
  if (row.trigger === "target-blank") assert.equal(row.child.openerPresent, false, "Native target=_blank has no opener");
  row.childSwitch = {}; Object.assign(row.childSwitch, await f.switchPage(row.sourceProof.childTabId, row.childSwitch));
  row.childSwitch.proof = assertManagedHumanNewPageSwitch(row.childSwitch, row.lease, row.sourceProof.childTabId, true);
  row.childBeforeClick = await f.read(row.sourceProof.childTabId, row.child.documentId);
  assert.deepEqual(row.childBeforeClick.state, row.child.state);
  row.childPoint = await f.point(row.childBeforeClick.point);
  row.childPositionCommands = await f.position(row.childPoint); row.childCommands = row.variant === "child-close" ? await f.clickClosing(row.childPoint) : await f.click(row.childPoint);
  assert.deepEqual(row.childCommands.map(command => command.input.action), ["down", "up"]);
  for (const command of row.childCommands) {
    assert.equal(command.input.type, "pointer"); assert.equal(command.input.button, "left"); assert.equal(command.input.modifiers, 0);
    assert.equal(command.leaseId, row.childSwitch.lease.leaseId); assert.equal(command.generation, row.childSwitch.lease.generation);
  }
  if (row.variant === "child-close") {
    row.callbackObservation = await f.waitClosedCallback(); row.callback = row.callbackObservation.receipt;
    row.childClosed = await f.waitClosed(row, row.callbackObservation.receivedAt);
    row.childClosed.proof = assertManagedHumanNewPageClosed(row, row.childClosed);
  } else {
    row.childAfterClick = await f.waitCallback(row.sourceProof.childTabId, row.child.documentId);
    row.callback = row.childAfterClick.state.receipt;
    assert.deepEqual(row.childAfterClick.state.events, [{ type: "click", trusted: true }]); assert.equal(row.childAfterClick.state.submitted, true);
  }
  assert.deepEqual(row.callback, { key: row.original.state.key, documentToken: row.child.state.documentToken, sequence: 1 });
  row.childScreenshot = await f.screenshot(row.variant === "child-close" ? "viewer-original-child-closed.png" : "viewer-original-child-returned.png");
  if (row.variant === "parent-navigate") {
    row.parentNavigated = await f.waitNavigatedParent(row.tabId, row.urls.returnedParent);
    returnedParent(row, row.parentNavigated);
    assert.equal(row.parentNavigated.native.targets.length, 1); assert.equal(row.parentNavigated.native.targets[0].id, row.nativeBefore.targets[0].id);
    assert.equal(row.parentNavigated.native.targets[0].tabId, row.tabId);
    for (const key of ["windowId", "groupId", "pinned"]) assert.equal(row.parentNavigated.native.tab[key], row.nativeBefore.tab[key]);
  }
  row.parentSwitch = {}; Object.assign(row.parentSwitch, await f.switchPage(row.tabId, row.parentSwitch, row.childClosed));
  row.parentSwitch.proof = assertManagedHumanNewPageSwitch(row.parentSwitch, row.childSwitch.lease, row.tabId, row.variant === "parent-navigate", row.childClosed);
  if (row.parentReadonly) row.parentReadonlyProof = assertManagedHumanParentReadonly(row);
  row.parentReturned = await f.waitParent(row.tabId, row.parentNavigated?.documentId ?? row.original.documentId);
  returnedParent(row, row.parentReturned);
  if (row.parentNavigated) { assert.equal(row.parentReturned.documentId, row.parentNavigated.documentId); assert.equal(row.parentReturned.state.documentToken, row.parentNavigated.state.documentToken); }
  row.parentScreenshot = await f.screenshot("viewer-original-parent-returned.png");
  row.end = await f.end(); row.endRequest = f.lastCommand("humanEnd"); ended(row.parentSwitch.lease, row.end, row.endRequest);
  row.released = await f.read(row.tabId, row.parentReturned.documentId); returnedParent(row, row.released);
  if (row.variant === "child-close") row.childAbsentAfterEnd = await f.closedNative(row);
  else {
    row.childAfterEnd = await f.read(row.sourceProof.childTabId, row.child.documentId);
    assert.equal(row.childAfterEnd.documentId, row.child.documentId); assert.deepEqual(row.childAfterEnd.state, row.childAfterClick.state);
    row.childNativeAfterEnd = await f.native(row.sourceProof.childTabId);
    originalChild(row, row.childAfterEnd, row.childNativeAfterEnd, true); assert.equal(row.childNativeAfterEnd.targets[0].id, row.childNative.targets[0].id);
  }
  row.resume = await f.resume(); assert.equal(row.resume.status.state, "running");
  row.newTurn = await f.newTurn(); row.newTurnCompletedAt = Date.now();
  row.agent = {}; Object.assign(row.agent, await f.claimAndRead(row.tabId, row.parentReturned.documentId, row.agent));
  row.agentProof = assertManagedHumanNewPageClaim(row);
  row.observerAfterResume = await f.trace(); assert.deepEqual(row.observerAfterResume.events, row.observerAfter.events);
  row.classification = "explicit-user-selection-original-child-and-parent";
  row.featurePassed = true;
  return row.proof = { classification: row.classification, featurePassed: true, diagnosticGapConfirmed: false,
    childTabId: row.sourceProof.childTabId, variant: row.variant ?? "standard", originalParentDraft: true, originalCallback: true,
    ...(row.parentReadonly ? { originalParentReadonlyFrame: row.parentReadonlyProof.originalReadonlyFrame } : {}),
    ...(row.variant === "parent-navigate" ? { draftPreservation: "fixture application migrates its own draft through sessionStorage during callback navigation" } : {}),
    boundary: "Native source only locates the child. Explicit viewer selection retains the managed-browser page; SDK separately claims the original parent after Resume and a new turn. No full SSO or OS-focus claim." };
}

export function assertManagedHumanNewPageTerminal(row, fixture, handoff) {
  const accepted = row.mode === "acceptance";
  assert.equal(fixture.overflow, false); assert.equal(fixture.closed, true); assert.equal(fixture.pendingReads, 0);
  assert.deepEqual(fixture.callback, accepted ? row.callback : null); assert.equal(fixture.requests.filter(hit => hit.method === "POST").length, accepted ? 1 : 0);
  for (const suffix of ["/parent", "/child", "/await-return", ...(row.variant === "iframe" ? ["/frame"] : []), ...(row.variant === "parent-navigate" ? ["/parent-returned"] : [])]) {
    const hits = fixture.requests.filter(hit => hit.path.endsWith(suffix)); assert.equal(hits.length, 1);
    assert.equal(hits[0].method, "GET");
    if (accepted || suffix !== "/await-return") { assert.equal(hits[0].status, 200); assert.equal(hits[0].finished, true); assert.equal(hits[0].aborted, false); }
  }
  assert.equal(fixture.requests.length, (accepted ? 4 : 3) + (["iframe", "parent-navigate"].includes(row.variant) ? 1 : 0));
  if (accepted) {
    const hit = fixture.requests.find(hit => hit.method === "POST"); assert.ok(hit.path.endsWith("/callback"));
    assert.equal(hit.status, 200); assert.equal(hit.finished, true); assert.equal(hit.aborted, false); assert.deepEqual(hit.receipt, row.callback);
    const expectedBody = { key: row.original.state.key, documentToken: row.child.state.documentToken, trusted: true,
      ...(row.variant === "child-close" ? { events: [{ type: "click", trusted: true }], submitted: true, closeRequested: true } : {}) };
    assert.equal(hit.bodyBytes, Buffer.byteLength(JSON.stringify(expectedBody)));
    if (row.variant === "child-close") { assert.equal(hit.body, JSON.stringify(expectedBody)); assertManagedHumanNewPageClosed(row, row.childClosed); }
    assert.equal(row.proof.featurePassed, true); assertManagedHumanNewPageClaim(row);
    if (row.parentReadonly) assertManagedHumanParentReadonly(row);
  }
  assert.equal(fixture.parentToken, row.original.state.documentToken); assert.equal(fixture.childToken, row.child.state.documentToken);
  if (accepted) returnedParent(row, row.finalParent); else sameDocument(row.original, row.finalParent);
  assert.deepEqual(row.finalParent.state.events, row.released.state.events);
  assert.equal(row.finalParentNative.targets.length, 1); assert.equal(row.finalParentNative.targets[0].id, row.nativeBefore.targets[0].id);
  if (row.variant === "child-close") {
    assert.deepEqual(row.finalChildAbsent, row.childClosed.native); assert.deepEqual(row.childAbsentAfterEnd, row.childClosed.native);
    assert.equal(row.finalChild, undefined); assert.equal(row.finalChildNative, undefined);
  } else {
    assert.deepEqual(row.finalChild.state, row.childAfterEnd.state); assert.equal(row.finalChild.documentId, row.child.documentId);
    originalChild(row, row.finalChild, row.finalChildNative, accepted); assert.equal(row.finalChildNative.targets[0].id, row.childNative.targets[0].id);
  }
  if (row.variant === "iframe") { sameDocument(row.sourceOriginal, row.finalSource); assert.deepEqual(row.finalSource.state.events, row.sourceAfterClick.state.events); assert.equal(fixture.frameToken, row.sourceOriginal.state.documentToken); }
  if (row.variant === "parent-navigate") assert.equal(fixture.returnedParentToken, row.finalParent.state.documentToken);
  assert.equal(row.observerFinal.closed, true); assert.equal(row.observerFinal.listenerPresent, false); assert.equal(row.observerFinal.overflow, false);
  assert.deepEqual(row.observerFinal.events, row.observerAfter.events);
  assert.equal(handoff.requests.filter(hit => hit.method === "POST").length, 1, "The independent handoff has exactly one original POST");
  return { childCallbackPOSTs: accepted ? 1 : 0, independentHandoffPOSTs: 1, originalParentRetained: true, originalChildRetained: row.variant !== "child-close",
    ...(row.variant === "child-close" ? { originalChildClosed: true, originalCleanupConfirmed: true } : {}), ...(row.variant === "parent-navigate" ? { originalParentNewDocument: true } : {}) };
}
