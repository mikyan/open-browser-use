import assert from "node:assert/strict";
import test from "node:test";
import { managedHumanNewPageTrigger, managedHumanNewPageMode, managedHumanNewPageVariant, managedHumanParentReadonlyEnabled, assertManagedHumanParentReadonly, assertManagedHumanNewPageSource, assertManagedHumanNewPageGap, assertManagedHumanNewPageTerminal, runManagedHumanNewPageDiagnostic, runManagedHumanNewPageAcceptance, assertManagedHumanNewPageSwitch, assertManagedHumanNewPageClaim, assertManagedHumanNewPageInputs, assertManagedHumanNewPageClosed } from "./managed-human-new-page-workflow.mjs";

function evidence() {
  const urls = { parent: "http://127.0.0.1:50001/parent", child: "http://localhost:50001/child" };
  const original = { documentId: "parent-document", frameId: 0, url: urls.parent, draft: "original draft", point: { x: 1, y: 2, width: 3, height: 4 },
    state: { role: "parent", key: "key", documentToken: "parent-token", events: [], callbacks: [], overflow: false } };
  const afterClick = structuredClone(original); afterClick.state.events = ["pointerdown", "mousedown", "pointerup", "mouseup", "click"].map(type => ({ type, trusted: true, button: 0, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false }));
  const parentNative = { targets: [{ id: "parent-target", tabId: 10, url: urls.parent }], frames: [{ frameId: 0, documentId: original.documentId, url: urls.parent, processId: 99 }] };
  const child = { documentId: "child-document", frameId: 0, url: urls.child,
    state: { role: "child", key: "key", documentToken: "child-token", events: [], overflow: false, submitted: false, receipt: null } };
  const childNative = { targets: [{ id: "child-target", tabId: 11, url: urls.child }], frames: [{ frameId: 0, documentId: child.documentId, url: urls.child }] };
  const lease = { leaseId: "original", generation: 1, tabId: 10 };
  const commands = ["down", "up"].map((action, i) => ({ id: i + 2, connection: 1, operation: "humanInput", leaseId: lease.leaseId, generation: 1, sequence: i + 2,
    input: { type: "pointer", action, button: "left", modifiers: 0 } }));
  const replies = commands.map(command => ({ id: command.id, connection: 1, type: "response", result: { inputReceipt: { leaseId: command.leaseId, generation: 1, sequence: command.sequence, acknowledged: true } } }));
  const observerAfter = { sourceTabIds: [10], overflow: false, closed: false, events: [{ sequence: 1, receivedAt: 100,
    details: { sourceTabId: 10, sourceFrameId: 0, sourceProcessId: 99, tabId: 11, timeStamp: 123.5, url: urls.child } }] };
  const row = { urls, tabId: 10, original, afterClick, nativeBefore: parentNative, nativeAfter: structuredClone(parentNative), observerReady: { readySequence: 0 }, observerAfter,
    commands, replies, lease, child, childAfterEnd: structuredClone(child), childNative, childNativeAfterEnd: structuredClone(childNative), released: structuredClone(afterClick),
    end: { human: null, status: { state: "paused", cleanupComplete: true }, humanCleanup: { leaseId: lease.leaseId, cleanupConfirmed: true } },
    endRequest: { operation: "humanEnd", leaseId: lease.leaseId, at: 101 }, statusRequest: { operation: "status", at: 102 },
    freshStatus: { human: null, status: { state: "paused" }, tabs: [{ id: 10 }] }, optionsAfterEnd: [{ value: "" }, { value: "10" }] };
  row.sourceProof = assertManagedHumanNewPageSource(row);
  return row;
}

test("new-page mode is explicit and does not apply trigger settings to ordinary acceptance", () => {
  assert.equal(managedHumanNewPageTrigger("handoff", undefined), "window-open");
  assert.equal(managedHumanNewPageTrigger("new-page", "target-blank"), "target-blank");
  for (const value of [null, "", "acceptance", true]) assert.throws(() => managedHumanNewPageTrigger("new-page", value));
  assert.throws(() => managedHumanNewPageTrigger("handoff", "window-open"));
  assert.equal(managedHumanNewPageMode("new-page", undefined), "diagnostic");
  assert.equal(managedHumanNewPageMode("new-page", "acceptance"), "acceptance");
  assert.throws(() => managedHumanNewPageMode("handoff", "acceptance"));
  for (const mode of [null, "", "true"]) assert.throws(() => managedHumanNewPageMode("new-page", mode));
});

test("new-page variants are opt-in acceptance only with a single fixed trigger", () => {
  assert.equal(managedHumanNewPageVariant("handoff", "diagnostic", "window-open", undefined), "standard");
  for (const variant of ["iframe", "parent-navigate", "child-close"]) {
    assert.equal(managedHumanNewPageVariant("new-page", "acceptance", "window-open", variant), variant);
    assert.throws(() => managedHumanNewPageVariant("handoff", "acceptance", "window-open", variant));
    assert.throws(() => managedHumanNewPageVariant("new-page", "diagnostic", "window-open", variant));
    assert.throws(() => managedHumanNewPageVariant("new-page", "acceptance", "target-blank", variant));
  }
  for (const variant of [null, "", "iframe,child-close", "unknown"]) assert.throws(() => managedHumanNewPageVariant("new-page", "acceptance", "window-open", variant));
});

test("readonly parent pixels require their explicit uninstrumented single-scenario acceptance flag", () => {
  const accepted = ["new-page", "acceptance", "window-open", "parent-navigate", false];
  for (const flag of [undefined, "0"]) assert.equal(managedHumanParentReadonlyEnabled(...accepted, flag), false);
  assert.equal(managedHumanParentReadonlyEnabled(...accepted, "1"), true);
  for (const flag of [null, "", true, 1, "true"]) assert.throws(() => managedHumanParentReadonlyEnabled(...accepted, flag));
  for (const [index, value] of [[0, "handoff"], [1, "diagnostic"], [2, "target-blank"], [3, "iframe"], [3, "standard"], [3, "child-close"], [4, true]]) {
    const invalid = [...accepted]; invalid[index] = value;
    assert.throws(() => managedHumanParentReadonlyEnabled(...invalid, "1"));
  }
});

function frameEvidence() {
  const row = evidence(); row.variant = "iframe"; row.urls.frame = "http://localhost:50001/frame";
  row.sourceOriginal = structuredClone(row.original); row.sourceOriginal.frameId = 3; row.sourceOriginal.documentId = "source-document";
  row.sourceOriginal.url = row.urls.frame; row.sourceOriginal.state.role = "source-frame"; row.sourceOriginal.state.documentToken = "frame-token";
  row.sourceAfterClick = structuredClone(row.sourceOriginal); row.sourceAfterClick.state.events = row.afterClick.state.events; row.afterClick.state.events = [];
  row.original.point = { x: 18, y: 180, width: 620, height: 180 }; row.afterClick.point = structuredClone(row.original.point);
  row.observerAfter.events[0].details.sourceFrameId = 3; row.observerAfter.events[0].details.sourceProcessId = 100;
  for (const native of [row.nativeBefore, row.nativeAfter]) native.frames.push({ frameId: 3, documentId: "source-document", processId: 100, url: row.urls.frame });
  return row;
}

test("iframe opener proof binds original cross-site frame document and trusted source input while root stays untouched", () => {
  const row = frameEvidence(); const proof = assertManagedHumanNewPageSource(row);
  assert.equal(proof.sourceFrameId, 3); assert.equal(proof.sourceDocumentId, "source-document");
  for (const change of [r => { r.sourceAfterClick.documentId = "replacement"; }, r => { r.afterClick.state.events.push({ type: "click" }); },
    r => { r.observerAfter.events[0].details.sourceFrameId = 0; }, r => { r.nativeAfter.frames[1].documentId = "replacement"; },
    r => { r.nativeAfter.frames[0].documentId = "replacement"; }, r => { r.sourceAfterClick.state.events.at(-1).trusted = false; }]) {
    const broken = frameEvidence(); change(broken); assert.throws(() => assertManagedHumanNewPageSource(broken));
  }
});

function switched(oldLease, tabId, index) {
  const lease = { leaseId: `lease-${index}`, generation: 1, tabId }, pageSelectionId = `choice-${tabId}`, deliveryId = `retained-${tabId}`;
  const end = { human: null, viewerCleanupComplete: true, status: { state: "paused", cleanupComplete: true }, humanCleanup: { leaseId: oldLease.leaseId, cleanupConfirmed: true } };
  return { end, endRequest: { id: index * 10, operation: "humanEnd", leaseId: oldLease.leaseId }, endCompletedAt: 10,
    options: [{ value: String(tabId) }], status: { human: null, status: { state: "paused" }, tabs: [{ id: tabId, kind: "browser", pageSelectionId }] },
    selectRequest: { id: index * 10 + 1, operation: "select", tabId, pageSelectionId, at: 11 }, selectCompletedAt: 12,
    selected: { pageSelectionReceipt: { tabId, pageSelectionId, deliveryId, retained: true } },
    beginRequest: { id: index * 10 + 2, operation: "humanBegin", tabId, deliveryId, at: 13 }, begin: { human: lease, status: { state: "paused" } }, lease, frame: { humanLeaseId: lease.leaseId } };
}

test("explicit page switch requires original End, matching choice retention and one successor lease", () => {
  const row = evidence(), value = switched(row.lease, 11, 1);
  assert.equal(assertManagedHumanNewPageSwitch(value, row.lease, 11, true).tabId, 11);
  for (const change of [v => { v.end.humanCleanup.leaseId = "old"; }, v => { v.end.viewerCleanupComplete = false; },
    v => { v.selected.pageSelectionReceipt.pageSelectionId = "other"; }, v => { v.selected.pageSelectionReceipt.tabId = 12; },
    v => { v.beginRequest.deliveryId = "other"; }, v => { v.beginRequest.at = 9; }, v => { v.selectRequest.at = 9; },
    v => { v.lease.leaseId = row.lease.leaseId; }, v => { v.options = []; }]) {
    const broken = structuredClone(value); change(broken); assert.throws(() => assertManagedHumanNewPageSwitch(broken, row.lease, 11, true));
  }
});

function accepted() {
  const row = evidence(); row.mode = "acceptance"; row.trigger = "target-blank"; row.child.openerPresent = false;
  row.childSwitch = switched(row.lease, 11, 1); row.parentSwitch = switched(row.childSwitch.lease, 10, 2);
  row.callback = { key: "key", documentToken: "child-token", sequence: 1 };
  row.released.state.callbacks = [row.callback]; row.released.state.waitState = "returned";
  row.childAfterClick = structuredClone(row.child); row.childAfterClick.state.events = [{ type: "click", trusted: true }];
  row.childAfterClick.state.submitted = true; row.childAfterClick.state.receipt = row.callback; row.childAfterEnd = structuredClone(row.childAfterClick);
  row.resume = { status: { state: "running" } }; row.newTurnCompletedAt = 100;
  const native = { ...structuredClone(row.nativeBefore), tab: { windowId: 1, groupId: -1, active: true, pinned: false }, window: { id: 1, type: "normal", state: "normal", focused: false } };
  row.agent = { startedAt: 101, claimCompletedAt: 102, readStartedAt: 103, readCompletedAt: 104, receipt: { id: 10, url: row.urls.parent }, beforeNative: native, afterNative: structuredClone(native),
    before: structuredClone(row.released), after: structuredClone(row.released), state: structuredClone(row.released.state), draft: row.original.draft };
  row.proof = { featurePassed: true };
  row.finalParent = structuredClone(row.released); row.finalChild = structuredClone(row.childAfterEnd);
  row.finalParentNative = structuredClone(row.nativeBefore); row.finalChildNative = structuredClone(row.childNative);
  row.observerFinal = { ...structuredClone(row.observerAfter), closed: true, listenerPresent: false };
  const fixture = { ...terminal().fixture, callback: row.callback };
  fixture.requests.push({ method: "POST", path: "/callback", status: 200, finished: true, aborted: false, receipt: row.callback, bodyBytes: Buffer.byteLength(JSON.stringify({ key: "key", documentToken: "child-token", trusted: true })) });
  return { row, fixture, handoff: { requests: [{ method: "POST" }] } };
}

function navigated() {
  const value = accepted(), { row, fixture } = value; row.variant = "parent-navigate"; row.urls.returnedParent = "http://127.0.0.1:50001/parent-returned";
  const returned = structuredClone(row.released); returned.documentId = "returned-document"; returned.url = row.urls.returnedParent;
  returned.state.role = "parent-returned"; returned.state.previousDocumentToken = row.original.state.documentToken; returned.state.documentToken = "returned-token"; returned.state.events = [];
  row.parentReturned = structuredClone(returned); row.released = structuredClone(returned); row.finalParent = structuredClone(returned);
  row.agent.receipt.url = returned.url; row.agent.before = structuredClone(returned); row.agent.after = structuredClone(returned); row.agent.state = structuredClone(returned.state);
  for (const native of [row.agent.beforeNative, row.agent.afterNative, row.finalParentNative]) {
    native.targets[0].url = returned.url; native.frames[0].url = returned.url; native.frames[0].documentId = returned.documentId;
  }
  fixture.returnedParentToken = "returned-token"; fixture.requests.push({ path: "/parent-returned", method: "GET", status: 200, finished: true, aborted: false });
  return value;
}

function readonlyParent() {
  const result = navigated(), { row } = result, value = row.parentSwitch;
  row.parentReadonly = true; row.trigger = "window-open";
  row.parentNavigated = { ...structuredClone(row.parentReturned), native: structuredClone(row.agent.beforeNative) };
  row.parentNavigated.hasFocus = false; row.parentNavigated.visibilityState = "hidden"; row.parentNavigated.native.tab.active = false;
  const lease = { state: "active", leaseId: "readonly-parent", tabId: 10, generation: 1, viewport: { width: 800, height: 600 } };
  Object.assign(value.selected, { human: null, status: { state: "paused" }, view: lease });
  value.endSelector = "#human-end"; value.beginSelector = "#human-begin"; value.selectRequest.connection = 1; value.beginRequest.at = 20;
  const frame = { controlMode: "user-view", tabId: 10, viewLeaseId: lease.leaseId, generation: 1, connection: 1, at: 12,
    streamId: "readonly-stream", sequence: 1, eventSequence: 31, metadata: { monotonicTimestamp: 123.4 },
    file: "native-frame-0001.png", sha256: "a".repeat(64), bytes: 100, width: 800, height: 600 };
  const decoded = { controlMode: "user-view", viewLeaseId: lease.leaseId, humanLeaseId: "", streamId: frame.streamId,
    frameSequence: "1", generation: "1", eventSequence: "31", hidden: false, complete: true, width: 800, height: 600 };
  const document = { ...structuredClone(row.parentReturned), hasFocus: false, visibilityState: "hidden" };
  const native = structuredClone(row.parentNavigated.native); Object.assign(native.tab, { id: 10, active: false });
  value.readonly = { lease: structuredClone(lease), frame, decoded, decodedAt: 13, savedSHA256: frame.sha256, savedBytes: frame.bytes,
    screenshot: { file: "viewer-parent-readonly-before-begin.png", at: 14, sha256: "b".repeat(64), bytes: 200 },
    state: { human: null, view: structuredClone(lease), selectedTabId: 10 }, document, native, completedAt: 15,
    commandsBeforeBegin: [structuredClone(value.selectRequest)],
    messagesBeforeBegin: [{ type: "response", id: value.selectRequest.id, result: structuredClone(value.selected) }, { type: "frame", ...frame }] };
  return result;
}

test("readonly parent proof binds retained PNG and actual decoded scope before explicit Begin", () => {
  const { row } = readonlyParent();
  assert.deepEqual(assertManagedHumanParentReadonly(row), { originalReadonlyFrame: true, leaseId: "readonly-parent", streamId: "readonly-stream",
    sequence: 1, sha256: "a".repeat(64), documentId: "returned-document", targetId: "parent-target", beforeBegin: true });
  for (const focused of [true, false]) {
    const { row } = readonlyParent();
    row.parentNavigated.native.window.focused = focused; row.parentSwitch.readonly.native.window.focused = focused;
    assert.equal(assertManagedHumanParentReadonly(row).originalReadonlyFrame, true);
  }
  const mutations = [
    r => { r.parentSwitch.endSelector = "#human-switch"; }, r => { r.parentSwitch.beginSelector = undefined; },
    r => { r.parentSwitch.readonly.commandsBeforeBegin.push({ operation: "humanBegin" }); },
    r => { r.parentSwitch.readonly.commandsBeforeBegin.push({ operation: "humanInput" }); },
    r => { r.parentSwitch.beginRequest.at = 14; }, r => { r.parentSwitch.readonly.frame.controlMode = "human"; },
    r => { r.parentSwitch.readonly.frame.viewLeaseId = "successor"; }, r => { r.parentSwitch.readonly.frame.generation = 2; },
    r => { r.parentSwitch.readonly.frame.file = undefined; }, r => { r.parentSwitch.readonly.savedSHA256 = "c".repeat(64); },
    r => { r.parentSwitch.readonly.decoded.complete = false; }, r => { r.parentSwitch.readonly.decoded.streamId = "another"; },
    r => { r.parentSwitch.readonly.decoded.frameSequence = "2"; }, r => { r.parentSwitch.readonly.decoded.viewLeaseId = "successor"; },
    r => { r.parentSwitch.readonly.document.documentId = r.original.documentId; }, r => { r.parentSwitch.readonly.document.hasFocus = true; },
    r => { r.parentSwitch.readonly.document.visibilityState = "visible"; }, r => { r.parentSwitch.readonly.native.tab.active = true; },
    r => { r.parentNavigated.hasFocus = true; }, r => { r.parentNavigated.native.tab.active = true; },
    r => { r.parentSwitch.readonly.native.targets[0].id = "replacement"; }, r => { r.parentSwitch.readonly.native.window.id = 2; },
    r => { r.parentSwitch.readonly.native.window.focused = true; }, r => { r.parentSwitch.readonly.native.window.state = "minimized"; },
    r => { r.parentSwitch.readonly.native.window.type = "popup"; },
    r => { r.parentNavigated.native.window.focused = "false"; r.parentSwitch.readonly.native.window.focused = "false"; },
    r => { r.parentSwitch.readonly.state.human = { leaseId: "early-human" }; },
    r => { r.parentSwitch.readonly.messagesBeforeBegin.push({ type: "state", human: { leaseId: "early-human" } }); },
    r => { r.parentSwitch.readonly.messagesBeforeBegin.pop(); }, r => { r.parentSwitch.readonly.screenshot.at = 12; }
  ];
  for (const change of mutations) { const { row } = readonlyParent(); change(row); assert.throws(() => assertManagedHumanParentReadonly(row)); }
});

test("parent callback navigation accepts a new document on the original target with explicit application draft migration", () => {
  const value = navigated(); assert.equal(assertManagedHumanNewPageClaim(value.row).documentId, "returned-document");
  assert.equal(assertManagedHumanNewPageTerminal(value.row, value.fixture, value.handoff).originalParentNewDocument, true);
  for (const change of [r => { r.agent.after.documentId = r.original.documentId; }, r => { r.agent.after.state.previousDocumentToken = "other"; },
    r => { r.agent.after.state.documentToken = r.original.state.documentToken; }, r => { r.agent.afterNative.targets[0].id = "replacement"; },
    r => { r.agent.after.draft = "lost"; }, r => { r.agent.receipt.url = r.urls.parent; }]) {
    const { row } = navigated(); change(row); assert.throws(() => assertManagedHumanNewPageClaim(row));
  }
});

function closed() {
  const value = accepted(), { row, fixture } = value; row.variant = "child-close";
  const status = { human: null, view: null, humanCleanup: { leaseId: row.childSwitch.lease.leaseId, cleanupConfirmed: true },
    status: { state: "paused", cleanupComplete: true }, viewerCleanupComplete: true, tabs: [{ id: 10 }] };
  row.childClosed = { status, message: { type: "response", result: structuredClone(status), at: 20 }, callbackReceivedAt: 10, observedAt: 21,
    native: { tabId: 11, targetId: "child-target", tabs: [], targets: [] }, commands: [], endReplies: [], viewerErrors: "" };
  row.childAbsentAfterEnd = structuredClone(row.childClosed.native); row.finalChildAbsent = structuredClone(row.childClosed.native);
  delete row.finalChild; delete row.finalChildNative;
  const hit = fixture.requests.at(-1); hit.body = JSON.stringify({ key: "key", documentToken: "child-token", trusted: true, events: [{ type: "click", trusted: true }], submitted: true, closeRequested: true }); hit.bodyBytes = Buffer.byteLength(hit.body);
  return value;
}

test("native child closure requires original tab/target absence and matching production cleanup without a fabricated End", () => {
  const value = closed(); assert.equal(assertManagedHumanNewPageClosed(value.row, value.row.childClosed).cleanupConfirmed, true);
  assert.equal(assertManagedHumanNewPageTerminal(value.row, value.fixture, value.handoff).originalChildClosed, true);
  for (const change of [v => { v.status.humanCleanup.leaseId = "other"; }, v => { v.native.tabs.push({ id: 11 }); }, v => { v.native.targets.push({ id: "child-target" }); },
    v => { v.status.viewerCleanupComplete = false; }, v => { v.observedAt = 9; }, v => { v.endReplies.push({ error: { code: "HUMAN_STALE" } }); },
    v => { v.viewerErrors = "stale human"; }, v => { v.commands.push({ operation: "humanEnd", id: 99, leaseId: "lease-1" }); }]) {
    const { row } = closed(); change(row.childClosed); assert.throws(() => assertManagedHumanNewPageClosed(row, row.childClosed));
  }
});

test("selection after native child closure uses explicit Begin only after actual original cleanup", () => {
  const { row } = closed(), value = row.parentSwitch;
  delete value.end; delete value.endRequest; delete value.endCompletedAt;
  value.selectionReadyAt = 22; value.closedCleanup = structuredClone(row.childClosed.status.humanCleanup);
  value.selectRequest.at = 23; value.selectCompletedAt = 24; value.beginRequest.at = 25;
  assert.equal(assertManagedHumanNewPageSwitch(value, row.childSwitch.lease, 10, true, row.childClosed).closedCleanup.cleanupConfirmed, true);
  const broken = structuredClone(value); broken.end = {};
  assert.throws(() => assertManagedHumanNewPageSwitch(broken, row.childSwitch.lease, 10, true, row.childClosed));
});

test("closing child records a native up failure as unconfirmed and never changes it into an ACK", () => {
  const { row } = closed(); row.positionCommands = []; row.childPositionCommands = [];
  row.childCommands = row.commands.map((command, index) => ({ ...command, id: command.id + 10, leaseId: row.childSwitch.lease.leaseId, sequence: index + 1 }));
  const childReplies = row.childCommands.map(command => ({ type: "response", id: command.id, connection: command.connection, result: { inputReceipt: { leaseId: command.leaseId, generation: command.generation, sequence: command.sequence, acknowledged: true } } }));
  delete childReplies[1].result; childReplies[1].error = { code: "HUMAN_STALE", message: "original child closed" };
  const all = [...row.commands, ...row.childCommands], replies = [...row.replies, ...childReplies];
  const ledger = assertManagedHumanNewPageInputs(row, all, replies); assert.equal(ledger[1].results[1].acknowledged, false); assert.equal(ledger[1].results[1].error.code, "HUMAN_STALE");
  assert.throws(() => assertManagedHumanNewPageInputs(row, all, replies.slice(0, -1)));
  const broken = structuredClone(replies); broken.at(-1).error.code = "UNKNOWN"; assert.throws(() => assertManagedHumanNewPageInputs(row, all, broken));
  row.childClosed.native.targets.push({ id: "child-target" }); assert.throws(() => assertManagedHumanNewPageInputs(row, all, replies));
});

test("SDK reclaim proof requires exact original document, placement and public read after new turn", () => {
  assert.equal(assertManagedHumanNewPageClaim(accepted().row).originalPlacementPreserved, true);
  for (const change of [r => { r.agent.startedAt = 99; }, r => { r.agent.receipt.id = 11; }, r => { r.agent.readStartedAt = 101; },
    r => { r.agent.afterNative.targets[0].id = "replacement"; }, r => { r.agent.afterNative.tab.windowId++; },
    r => { r.agent.afterNative.window.focused = true; }, r => { r.agent.after.documentId = "replacement"; },
    r => { r.agent.state.callbacks = []; }, r => { r.agent.draft = "lost"; }]) {
    const { row } = accepted(); change(row); assert.throws(() => assertManagedHumanNewPageClaim(row));
  }
});

test("acceptance terminal requires one original callback, retained identities and no late activity", () => {
  const good = accepted(); assert.equal(assertManagedHumanNewPageTerminal(good.row, good.fixture, good.handoff).childCallbackPOSTs, 1);
  for (const change of [v => { v.fixture.requests.push({ method: "POST", path: "/callback" }); }, v => { v.fixture.requests[2].aborted = true; },
    v => { v.fixture.requests.at(-1).receipt = {}; }, v => { v.row.finalChild.state.events.push({ type: "click", trusted: true }); },
    v => { v.row.finalParent.state.callbacks.push({}); }, v => { v.row.finalChildNative.targets[0].id = "replacement"; }]) {
    const value = accepted(); change(value); assert.throws(() => assertManagedHumanNewPageTerminal(value.row, value.fixture, value.handoff));
  }
});

test("full switch lease ledger refuses missing ACK and late successor input", () => {
  const { row } = accepted(); row.positionCommands = []; row.childPositionCommands = []; row.childCommands = [];
  assert.equal(assertManagedHumanNewPageInputs(row, row.commands, row.replies).length, 3);
  assert.throws(() => assertManagedHumanNewPageInputs(row, row.commands, row.replies.slice(1)));
  assert.throws(() => assertManagedHumanNewPageInputs(row, [...row.commands, { ...row.commands[0], leaseId: row.parentSwitch.lease.leaseId }], row.replies));
});

test("acceptance facade switches twice, End/Resume/newTurn precedes original SDK claim, and never reopens child", async () => {
  const value = accepted().row, row = { trigger: "target-blank", urls: value.urls }, calls = []; let reads = 0;
  const call = (name, result) => async () => { calls.push(name); return structuredClone(result); };
  await runManagedHumanNewPageAcceptance({
    createParent: call("createParent", 10), read: async id => {
      if (id === 11) return structuredClone(calls.includes("End") ? value.childAfterEnd : value.child);
      return structuredClone(++reads <= 2 ? value.original : calls.includes("End") ? value.released : value.afterClick);
    }, native: async id => structuredClone(id === 10 ? value.nativeBefore : value.childNative),
    installObserver: call("observer", {}), register: call("register", value.observerReady), select: call("select-parent", {}), begin: call("begin-parent", { human: value.lease }),
    frame: call("frame", {}), state: () => ({ human: value.lease }), point: call("point", {}), position: call("position", []),
    click: async () => { const second = calls.includes("trusted-click"); calls.push("trusted-click"); return structuredClone(value.commands).map(command => ({ ...command, ...(second ? { leaseId: value.childSwitch.lease.leaseId } : {}) })); },
    messages: () => value.replies, waitCreated: call("created", value.observerAfter), waitChild: call("read-original-child", value.child),
    switchPage: async id => { calls.push(`switch-${id}`); return structuredClone(id === 11 ? value.childSwitch : value.parentSwitch); },
    waitCallback: call("callback", value.childAfterClick), waitParent: call("parent-returned", value.released), screenshot: call("screenshot", {}),
    end: call("End", { ...value.parentSwitch.end, humanCleanup: { leaseId: value.parentSwitch.lease.leaseId, cleanupConfirmed: true } }),
    lastCommand: () => ({ operation: "humanEnd", leaseId: value.parentSwitch.lease.leaseId }), resume: call("Resume", value.resume), newTurn: call("newTurn", {}),
    claimAndRead: async id => { calls.push(`SDK-claim-read-${id}`); const result = structuredClone(value.agent); result.startedAt = Date.now(); result.claimCompletedAt = result.startedAt; result.readStartedAt = result.startedAt; result.readCompletedAt = result.startedAt; return result; },
    trace: call("trace", value.observerAfter)
  }, row);
  assert.equal(row.proof.featurePassed, true); assert.equal(calls.filter(name => name === "trusted-click").length, 2);
  assert.equal(calls.filter(name => name === "createParent").length, 1);
  for (const [a, b] of [["switch-11", "callback"], ["callback", "switch-10"], ["switch-10", "End"], ["End", "Resume"], ["Resume", "newTurn"], ["newTurn", "SDK-claim-read-10"]]) assert.ok(calls.indexOf(a) < calls.indexOf(b));
});

for (const [variant, parentReadonly] of [["iframe", false], ["parent-navigate", false], ["child-close", false], ["parent-navigate", true]]) test(`${variant}${parentReadonly ? " readonly" : ""} acceptance facade uses original input, native state and explicit selection in order`, async () => {
  const value = parentReadonly ? readonlyParent().row : variant === "parent-navigate" ? navigated().row : variant === "child-close" ? closed().row : accepted().row;
  value.variant = variant; value.trigger = "window-open"; const calls = []; let parentReads = 0;
  if (variant === "iframe") {
    const frame = frameEvidence();
    for (const key of ["urls", "original", "afterClick", "sourceOriginal", "sourceAfterClick", "nativeBefore", "nativeAfter", "observerAfter"]) value[key] = frame[key];
    value.released.state.events = []; value.agent.before.state.events = []; value.agent.after.state.events = []; value.agent.state.events = [];
  }
  if (variant === "parent-navigate") {
    value.nativeBefore.tab = { windowId: 1, groupId: -1, pinned: false };
    value.parentNavigated ??= { ...structuredClone(value.released), native: structuredClone(value.agent.beforeNative) };
  }
  if (variant === "child-close") {
    delete value.parentSwitch.end; delete value.parentSwitch.endRequest; delete value.parentSwitch.endCompletedAt;
    Object.assign(value.parentSwitch, { selectionReadyAt: 22, closedCleanup: structuredClone(value.childClosed.status.humanCleanup) });
    value.parentSwitch.selectRequest.at = 23; value.parentSwitch.selectCompletedAt = 24; value.parentSwitch.beginRequest.at = 25;
  }
  const row = { trigger: value.trigger, variant, parentReadonly, urls: value.urls }, call = (name, result) => async () => { calls.push(name); return structuredClone(result); };
  await runManagedHumanNewPageAcceptance({
    createParent: call("create-parent", 10), read: async (id, documentId) => {
      if (documentId === "source-document") return structuredClone(calls.includes("trusted-parent-click") ? value.sourceAfterClick : value.sourceOriginal);
      if (id === 11) return structuredClone(calls.includes("End") ? value.childAfterEnd : value.child);
      return structuredClone(++parentReads <= 2 ? value.original : calls.includes("End") ? value.released : value.afterClick);
    }, native: async id => structuredClone(id === 10 ? value.nativeBefore : value.childNative), readSource: call("read-source", value.sourceOriginal),
    installObserver: call("observer", {}), register: call("register", value.observerReady), select: call("select-parent", {}), begin: call("begin-parent", { human: value.lease }),
    frame: call("frame", {}), state: () => ({ human: value.lease }), point: call("point", {}), position: call("position", []),
    click: async () => { const second = calls.includes("trusted-parent-click"); calls.push(second ? "trusted-child-click" : "trusted-parent-click"); return structuredClone(value.commands).map(command => ({ ...command, ...(second ? { leaseId: value.childSwitch.lease.leaseId } : {}) })); },
    clickClosing: async () => { calls.push("trusted-closing-click"); return structuredClone(value.commands).map(command => ({ ...command, leaseId: value.childSwitch.lease.leaseId })); },
    messages: () => value.replies, waitCreated: call("created", value.observerAfter), waitChild: call("read-child", value.child),
    switchPage: async (id, _target, closedProof) => { calls.push(`switch-${id}`); if (variant === "child-close" && id === 10) assert.deepEqual(closedProof, { ...value.childClosed, proof: assertManagedHumanNewPageClosed(value, value.childClosed) }); return structuredClone(id === 11 ? value.childSwitch : value.parentSwitch); },
    waitCallback: call("callback", value.childAfterClick), waitClosedCallback: call("callback-before-close", { receipt: value.callback, receivedAt: 10 }),
    waitClosed: call("native-closed-and-cleaned", value.childClosed), closedNative: call("still-closed", value.childClosed?.native),
    waitNavigatedParent: call("parent-new-document", value.parentNavigated), waitParent: call("parent-returned", value.released), screenshot: call("screenshot", {}),
    end: call("End", { human: null, viewerCleanupComplete: true, status: { state: "paused", cleanupComplete: true }, humanCleanup: { leaseId: value.parentSwitch.lease.leaseId, cleanupConfirmed: true } }),
    lastCommand: () => ({ operation: "humanEnd", leaseId: value.parentSwitch.lease.leaseId }), resume: call("Resume", value.resume), newTurn: call("newTurn", {}),
    claimAndRead: async () => { calls.push("SDK-claim-read"); const result = structuredClone(value.agent); result.startedAt = Date.now(); result.claimCompletedAt = result.startedAt; result.readStartedAt = result.startedAt; result.readCompletedAt = result.startedAt; return result; },
    trace: call("trace", value.observerAfter)
  }, row);
  assert.equal(row.proof.featurePassed, true); assert.equal(row.proof.variant, variant);
  assert.ok(calls.indexOf("End") < calls.indexOf("Resume")); assert.ok(calls.indexOf("newTurn") < calls.indexOf("SDK-claim-read"));
  if (variant === "iframe") assert.equal(row.sourceProof.sourceDocumentId, "source-document");
  if (variant === "parent-navigate") { assert.ok(calls.indexOf("parent-new-document") < calls.indexOf("switch-10")); assert.match(row.proof.draftPreservation, /fixture application/); }
  if (parentReadonly) { assert.equal(row.parentReadonlyProof.originalReadonlyFrame, true); assert.equal(row.proof.originalParentReadonlyFrame, true); }
  if (variant === "child-close") { assert.equal(calls.includes("callback"), false); assert.ok(calls.indexOf("native-closed-and-cleaned") < calls.indexOf("switch-10")); assert.equal(row.parentSwitch.end, undefined); }
});

test("exact native provenance plus fresh viewer omission is only a diagnostic gap", () => {
  const proof = assertManagedHumanNewPageGap(evidence());
  assert.equal(proof.diagnosticGapConfirmed, true); assert.equal(proof.featurePassed, false);
  assert.equal(proof.childTabId, 11); assert.equal(proof.childDocumentId, "child-document");
});

for (const [label, change] of [
  ["no native event", row => { row.observerAfter.events = []; }],
  ["duplicate child", row => { row.observerAfter.events.push(structuredClone(row.observerAfter.events[0])); }],
  ["wrong native source", row => { row.observerAfter.events[0].details.sourceTabId++; }],
  ["wrong original process", row => { row.observerAfter.events[0].details.sourceProcessId++; }],
  ["parent navigation", row => { row.afterClick.documentId = "replacement"; }],
  ["source target replaced", row => { row.nativeAfter.targets[0].id = "replacement"; }],
  ["invented click", row => { row.afterClick.state.events.at(-1).trusted = false; }],
  ["modifier click", row => { row.afterClick.state.events.at(-1).ctrlKey = true; }],
  ["missing native up ACK", row => { row.replies.pop(); }],
  ["wrong native receipt", row => { row.replies[0].result.inputReceipt.generation++; }],
  ["wrong child target", row => { row.childNativeAfterEnd.targets[0].id = "replacement"; }],
  ["child navigated", row => { row.childAfterEnd.documentId = "replacement"; }],
  ["child secretly operated", row => { row.child.state.events.push({ type: "click", trusted: true }); }],
  ["invented callback", row => { row.released.state.callbacks.push({}); }],
  ["child already eligible", row => { row.freshStatus.tabs.push({ id: 11 }); }],
  ["child selectable in menu", row => { row.optionsAfterEnd.push({ value: "11" }); }],
  ["stale cleanup", row => { row.end.humanCleanup.leaseId = "old"; }],
  ["observer overflow", row => { row.observerAfter.overflow = true; }],
  ["refresh before End", row => { row.statusRequest.at = 100; }]
]) test(`new-page gap rejects ${label}`, () => { const row = evidence(); change(row); assert.throws(() => assertManagedHumanNewPageGap(row)); });

function terminal() {
  const row = evidence(); row.finalParent = structuredClone(row.released); row.finalChild = structuredClone(row.childAfterEnd);
  row.finalParentNative = structuredClone(row.nativeBefore); row.finalChildNative = structuredClone(row.childNative);
  row.observerFinal = { ...structuredClone(row.observerAfter), closed: true, listenerPresent: false };
  const fixture = { overflow: false, closed: true, pendingReads: 0, callback: null, parentToken: "parent-token", childToken: "child-token",
    requests: ["/parent", "/child", "/await-return"].map(path => ({ path, method: "GET", status: 200, finished: true, aborted: false })) };
  return { row, fixture, handoff: { requests: [{ method: "POST" }] } };
}
test("final fixture observes zero callback and exactly one independent handoff POST", () => {
  const { row, fixture, handoff } = terminal(); assert.equal(assertManagedHumanNewPageTerminal(row, fixture, handoff).independentHandoffPOSTs, 1);
});
for (const [label, mutate] of [
  ["late callback POST", v => v.fixture.requests.push({ path: "/callback", method: "POST" })],
  ["late parent click", v => v.row.finalParent.state.events.push({ type: "click" })],
  ["late child input", v => v.row.finalChild.state.events.push({ type: "click" })],
  ["late child target replaced", v => { v.row.finalChildNative.targets[0].id = "replacement"; }],
  ["extra native child", v => v.row.observerFinal.events.push({})],
  ["late second handoff", v => v.handoff.requests.push({ method: "POST" })]
]) test(`terminal new-page proof rejects ${label}`, () => { const value = terminal(); mutate(value); assert.throws(() => assertManagedHumanNewPageTerminal(value.row, value.fixture, value.handoff)); });

test("diagnostic facade ends before fresh status, resumes, and never offers child-control methods", async () => {
  const value = evidence(), row = { urls: value.urls }, calls = []; let reads = 0;
  const call = (name, result) => async () => { calls.push(name); return structuredClone(result); };
  await runManagedHumanNewPageDiagnostic({
    createParent: call("createParent", 10), read: async id => id === 11 ? structuredClone(value.child) : structuredClone(++reads <= 2 ? value.original : value.afterClick),
    native: async id => structuredClone(id === 10 ? value.nativeBefore : value.childNative), installObserver: call("installObserver", { installed: true }), register: call("register", value.observerReady),
    select: call("select-parent", null), begin: call("begin", { human: value.lease }), frame: call("frame", {}), state: () => ({ human: value.lease }),
    point: call("point", {}), position: call("position", []), click: call("click-once", value.commands), messages: () => value.replies,
    waitCreated: call("wait-created", value.observerAfter), waitChild: call("read-child", value.child),
    options: call("options-read-only", value.optionsAfterEnd), screenshot: call("screenshot", {}), end: call("End", value.end),
    lastCommand: operation => operation === "humanEnd" ? value.endRequest : value.statusRequest,
    refresh: call("fresh-status", value.freshStatus), resume: call("Resume", { status: { state: "running" } }), newTurn: call("newTurn", {}), trace: call("trace", value.observerAfter)
  }, row);
  assert.equal(row.proof.featurePassed, false); assert.equal(calls.filter(name => name === "click-once").length, 1);
  assert.ok(calls.indexOf("End") < calls.indexOf("fresh-status")); assert.ok(calls.indexOf("fresh-status") < calls.indexOf("Resume"));
  assert.ok(calls.indexOf("Resume") < calls.indexOf("newTurn"));
});
