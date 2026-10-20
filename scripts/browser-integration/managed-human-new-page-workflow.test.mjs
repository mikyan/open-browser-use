import assert from "node:assert/strict";
import test from "node:test";
import { managedHumanNewPageTrigger, managedHumanNewPageMode, assertManagedHumanNewPageSource, assertManagedHumanNewPageGap, assertManagedHumanNewPageTerminal, runManagedHumanNewPageDiagnostic, runManagedHumanNewPageAcceptance, assertManagedHumanNewPageSwitch, assertManagedHumanNewPageClaim, assertManagedHumanNewPageInputs } from "./managed-human-new-page-workflow.mjs";

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
