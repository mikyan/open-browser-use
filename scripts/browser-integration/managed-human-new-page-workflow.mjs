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
  assert.equal(details.sourceTabId, row.tabId); assert.equal(details.sourceFrameId, original.frameId);
  assert.ok(Number.isSafeInteger(details.sourceProcessId) && details.sourceProcessId >= 0);
  assert.ok(Number.isFinite(details.timeStamp)); assert.equal(details.url, urls.child);
  assert.ok(Number.isSafeInteger(details.tabId) && details.tabId >= 0 && details.tabId !== row.tabId);
  assert.equal(nativeBefore.targets.length, 1); assert.equal(nativeAfter.targets.length, 1);
  assert.equal(nativeAfter.targets[0].id, nativeBefore.targets[0].id);
  assert.equal(nativeBefore.targets[0].tabId, row.tabId); assert.equal(nativeAfter.targets[0].tabId, row.tabId);
  const before = nativeBefore.frames.filter(frame => frame.frameId === original.frameId), after = nativeAfter.frames.filter(frame => frame.frameId === original.frameId);
  assert.equal(before.length, 1); assert.equal(after.length, 1);
  assert.equal(before[0].frameId, 0); assert.equal(before[0].documentId, original.documentId);
  assert.equal(after[0].documentId, original.documentId); assert.equal(after[0].url, before[0].url);
  if (before[0].processId >= 0) assert.equal(details.sourceProcessId, before[0].processId);
  if (after[0].processId >= 0) assert.equal(details.sourceProcessId, after[0].processId);
  sameDocument(original, afterClick); assert.equal(original.state.role, "parent");
  assert.deepEqual(original.state.events, []);
  assert.deepEqual(afterClick.state.events.map(e => e.type), ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]);
  for (const e of afterClick.state.events) {
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
    sourceProcessId: details.sourceProcessId, sourceDocumentId: original.documentId, sourceTargetId: nativeBefore.targets[0].id,
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
  row.observerInstall = await f.installObserver(); row.observerReady = await f.register(row.tabId);
  await f.select(row.tabId); row.begin = await f.begin(); row.firstFrame = await f.frame(row.begin.human);
  row.lease = f.state().human; assert.equal(row.lease.tabId, row.tabId);
  row.measured = await f.read(row.tabId, row.original.documentId); sameDocument(row.original, row.measured);
  row.point = await f.point(row.measured.point);
  row.positionCommands = await f.position(row.point);
  row.commands = await f.click(row.point); row.replies = f.messages();
  try { row.observerAfter = await f.waitCreated(row.tabId); }
  catch (error) { row.observerAfter = await f.trace(); row.classification = "native-child-unobserved"; throw error; }
  row.nativeAfter = await f.native(row.tabId); row.afterClick = await f.read(row.tabId, row.original.documentId);
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

export function assertManagedHumanNewPageSwitch(value, oldLease, tabId, requireChoice = false) {
  ended(oldLease, value.end, value.endRequest);
  const request = value.selectRequest;
  assert.equal(request.operation, "select"); assert.equal(request.tabId, tabId);
  assert.ok(request.at >= value.endCompletedAt);
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
    endRequestId: value.endRequest.id, selectRequestId: request.id, beginRequestId: value.beginRequest.id };
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
  assert.equal(value.receipt.id, row.tabId); assert.equal(value.receipt.url, row.urls.parent); assert.ok(value.claimCompletedAt >= value.startedAt);
  assert.ok(value.readStartedAt >= value.claimCompletedAt); assert.ok(value.readCompletedAt >= value.readStartedAt);
  stableNative(value.beforeNative, value.afterNative, row.tabId);
  assert.equal(value.beforeNative.targets[0].id, row.nativeBefore.targets[0].id);
  sameDocument(row.original, value.before, [row.callback]); sameDocument(row.original, value.after, [row.callback]);
  assert.deepEqual(value.before.state.events, row.afterClick.state.events); assert.deepEqual(value.after.state.events, row.afterClick.state.events);
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
      assert.equal(matching.length, 1); assert.equal(matching[0].error, undefined);
      assert.deepEqual(matching[0].result.inputReceipt, { leaseId: command.leaseId, generation: command.generation, sequence: command.sequence, acknowledged: true });
    }
  }
  return scopes.map(scope => ({ leaseId: scope.lease.leaseId, requestIds: scope.inputs.map(input => input.id) }));
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
  row.childPositionCommands = await f.position(row.childPoint); row.childCommands = await f.click(row.childPoint);
  assert.deepEqual(row.childCommands.map(command => command.input.action), ["down", "up"]);
  for (const command of row.childCommands) {
    assert.equal(command.input.type, "pointer"); assert.equal(command.input.button, "left"); assert.equal(command.input.modifiers, 0);
    assert.equal(command.leaseId, row.childSwitch.lease.leaseId); assert.equal(command.generation, row.childSwitch.lease.generation);
  }
  row.childAfterClick = await f.waitCallback(row.sourceProof.childTabId, row.child.documentId);
  row.callback = row.childAfterClick.state.receipt;
  assert.deepEqual(row.callback, { key: row.original.state.key, documentToken: row.child.state.documentToken, sequence: 1 });
  assert.deepEqual(row.childAfterClick.state.events, [{ type: "click", trusted: true }]); assert.equal(row.childAfterClick.state.submitted, true);
  row.childScreenshot = await f.screenshot("viewer-original-child-returned.png");
  row.parentSwitch = {}; Object.assign(row.parentSwitch, await f.switchPage(row.tabId, row.parentSwitch));
  row.parentSwitch.proof = assertManagedHumanNewPageSwitch(row.parentSwitch, row.childSwitch.lease, row.tabId);
  row.parentReturned = await f.waitParent(row.tabId, row.original.documentId);
  sameDocument(row.original, row.parentReturned, [row.callback]); assert.deepEqual(row.parentReturned.state.events, row.afterClick.state.events);
  row.parentScreenshot = await f.screenshot("viewer-original-parent-returned.png");
  row.end = await f.end(); row.endRequest = f.lastCommand("humanEnd"); ended(row.parentSwitch.lease, row.end, row.endRequest);
  row.released = await f.read(row.tabId, row.original.documentId);
  sameDocument(row.original, row.released, [row.callback]); assert.deepEqual(row.released.state.events, row.afterClick.state.events);
  row.childAfterEnd = await f.read(row.sourceProof.childTabId, row.child.documentId);
  assert.equal(row.childAfterEnd.documentId, row.child.documentId); assert.deepEqual(row.childAfterEnd.state, row.childAfterClick.state);
  row.childNativeAfterEnd = await f.native(row.sourceProof.childTabId);
  originalChild(row, row.childAfterEnd, row.childNativeAfterEnd, true); assert.equal(row.childNativeAfterEnd.targets[0].id, row.childNative.targets[0].id);
  row.resume = await f.resume(); assert.equal(row.resume.status.state, "running");
  row.newTurn = await f.newTurn(); row.newTurnCompletedAt = Date.now();
  row.agent = {}; Object.assign(row.agent, await f.claimAndRead(row.tabId, row.original.documentId, row.agent));
  row.agentProof = assertManagedHumanNewPageClaim(row);
  row.observerAfterResume = await f.trace(); assert.deepEqual(row.observerAfterResume.events, row.observerAfter.events);
  row.classification = "explicit-user-selection-original-child-and-parent";
  row.featurePassed = true;
  return row.proof = { classification: row.classification, featurePassed: true, diagnosticGapConfirmed: false,
    childTabId: row.sourceProof.childTabId, originalParentDraft: true, originalCallback: true,
    boundary: "Native source only locates the child. Explicit viewer selection retains the managed-browser page; SDK separately claims the original parent after Resume and a new turn. No full SSO or OS-focus claim." };
}

export function assertManagedHumanNewPageTerminal(row, fixture, handoff) {
  const accepted = row.mode === "acceptance";
  assert.equal(fixture.overflow, false); assert.equal(fixture.closed, true); assert.equal(fixture.pendingReads, 0);
  assert.deepEqual(fixture.callback, accepted ? row.callback : null); assert.equal(fixture.requests.filter(hit => hit.method === "POST").length, accepted ? 1 : 0);
  for (const suffix of ["/parent", "/child", "/await-return"]) {
    const hits = fixture.requests.filter(hit => hit.path.endsWith(suffix)); assert.equal(hits.length, 1);
    assert.equal(hits[0].method, "GET");
    if (accepted || suffix !== "/await-return") { assert.equal(hits[0].status, 200); assert.equal(hits[0].finished, true); assert.equal(hits[0].aborted, false); }
  }
  assert.equal(fixture.requests.length, accepted ? 4 : 3);
  if (accepted) {
    const hit = fixture.requests.find(hit => hit.method === "POST"); assert.ok(hit.path.endsWith("/callback"));
    assert.equal(hit.status, 200); assert.equal(hit.finished, true); assert.equal(hit.aborted, false); assert.deepEqual(hit.receipt, row.callback);
    assert.equal(hit.bodyBytes, Buffer.byteLength(JSON.stringify({ key: row.original.state.key, documentToken: row.child.state.documentToken, trusted: true })));
    assert.equal(row.proof.featurePassed, true); assertManagedHumanNewPageClaim(row);
  }
  assert.equal(fixture.parentToken, row.original.state.documentToken); assert.equal(fixture.childToken, row.child.state.documentToken);
  sameDocument(row.original, row.finalParent, accepted ? [row.callback] : []); assert.deepEqual(row.finalParent.state.events, row.released.state.events);
  assert.deepEqual(row.finalChild.state, row.childAfterEnd.state); assert.equal(row.finalChild.documentId, row.child.documentId);
  assert.equal(row.finalParentNative.targets.length, 1); assert.equal(row.finalParentNative.targets[0].id, row.nativeBefore.targets[0].id);
  originalChild(row, row.finalChild, row.finalChildNative, accepted); assert.equal(row.finalChildNative.targets[0].id, row.childNative.targets[0].id);
  assert.equal(row.observerFinal.closed, true); assert.equal(row.observerFinal.listenerPresent, false); assert.equal(row.observerFinal.overflow, false);
  assert.deepEqual(row.observerFinal.events, row.observerAfter.events);
  assert.equal(handoff.requests.filter(hit => hit.method === "POST").length, 1, "The independent handoff has exactly one original POST");
  return { childCallbackPOSTs: accepted ? 1 : 0, independentHandoffPOSTs: 1, originalParentRetained: true, originalChildRetained: true };
}
