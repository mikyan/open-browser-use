import test from "node:test";
import assert from "node:assert/strict";
import { allBrowserRestartCasesPassed, assertBrowserReplacement, assertHeldNativeInput, assertIndependentFocusSegments, assertNoNewFocusEvents, assertNoRestoredOwnership, assertRestoredFixtureDocument, assertRestoredTabPreserved, assertSamePopupDocument, assertUnconfirmedInputBlocked, browserRestartCases, popupUIReflectsStatus } from "./browser-restart-support.mjs";

const old = { pid: 1, browserId: "browser-A", workerTarget: "worker-A", profile: "same-profile", binarySha256: "hash", args: ["--restore-last-session", "same"], extensionInstanceId: "stable", host: { pid: 10, endpoint: "old" }, exitedAt: 20 };
const next = { ...old, pid: 2, browserId: "browser-B", workerTarget: "worker-B", host: { pid: 11, endpoint: "new" }, startedAt: 21 };

test("whole-browser evidence rejects a worker-only restart, changed profile and overlapping lifetime", () => {
  assertBrowserReplacement(old, next);
  for (const invalid of [{ pid: 1 }, { browserId: "browser-A" }, { profile: "other-profile" }, { extensionInstanceId: "fresh" }, { startedAt: 19 }, { host: old.host }]) {
    assert.throws(() => assertBrowserReplacement(old, { ...next, ...invalid }));
  }
});

test("restart evidence requires explicit restoration instead of an unverified seeded preference", () => {
  for (const args of [["same"], ["--restore-last-session", "--restore-last-session", "same"]]) {
    assert.throws(() => assertBrowserReplacement({ ...old, args }, { ...next, args }), /restoration flag/);
  }
});

test("focus evidence across browser processes requires independent validated observers", () => {
  const first = { finalValidation: "passed", lastAccepted: { identity: "a" }, coverageStartedAt: 1, coverageEndedAt: 2 };
  const second = { ...first, lastAccepted: { identity: "b" }, coverageStartedAt: 3, coverageEndedAt: 4 };
  assertIndependentFocusSegments([first, second]);
  assert.throws(() => assertIndependentFocusSegments([first, { ...second, lastAccepted: first.lastAccepted }]));
  assert.throws(() => assertIndependentFocusSegments([first, { ...second, finalValidation: "failed" }]));
});

test("restored task or deliverable cannot become owned only by a reused numeric ID", () => {
  assertNoRestoredOwnership([], [{ id: 3 }, { id: 9 }], "new lifetime");
  assert.throws(() => assertNoRestoredOwnership([{ id: 9, url: "different-document" }], [{ id: 9 }], "new lifetime"), /authorized restored pages/);
});

test("restored URL metadata alone cannot be treated as an accessible HTTP fixture document", () => {
  const url = "http://127.0.0.1:1234/lifecycle?marker=task", tab = { url, status: "complete", discarded: false };
  const document = { frameId: 0, documentId: "real-document", result: { url, readyState: "complete", documentToken: "synthetic-token", hasFixture: true } };
  assertRestoredFixtureDocument(tab, url, [document]);
  for (const invalid of [{ status: "unloaded" }, { status: "loading" }, { discarded: true }]) assert.throws(() => assertRestoredFixtureDocument({ ...tab, ...invalid }, url, [document]));
  for (const invalid of [{ url: "about:blank" }, { readyState: "loading" }, { documentToken: undefined }, { hasFixture: false }]) {
    assert.throws(() => assertRestoredFixtureDocument(tab, url, [{ ...document, result: { ...document.result, ...invalid } }]));
  }
  assert.throws(() => assertRestoredFixtureDocument(tab, url, [{ ...document, frameId: 1 }]));
  assert.throws(() => assertRestoredFixtureDocument(tab, url, [{ ...document, documentId: "" }]));
});

test("lazy restored deliverable preservation checks exact tab/group identity without claiming a DOM", () => {
  const before = { tab: { id: 10, url: "http://localhost/lifecycle?marker=deliverable", windowId: 20, groupId: 30, status: "unloaded" }, group: { id: 30, windowId: 20, title: "Deliverables", color: "green" } };
  assertRestoredTabPreserved(before, structuredClone(before));
  assertRestoredTabPreserved(before, { ...before, tab: { ...before.tab, status: "complete", title: "Naturally loaded fixture" } });
  for (const invalid of [{ id: 11 }, { url: "http://localhost/replacement" }, { windowId: 21 }, { groupId: -1 }]) {
    assert.throws(() => assertRestoredTabPreserved(before, { ...before, tab: { ...before.tab, ...invalid } }));
  }
  for (const invalid of [{ id: 31 }, { windowId: 21 }, { title: "Foreign session" }, { color: "red" }]) {
    assert.throws(() => assertRestoredTabPreserved(before, { ...before, group: { ...before.group, ...invalid } }));
  }
  assert.throws(() => assertRestoredTabPreserved(before, { group: before.group }));
  assert.throws(() => assertRestoredTabPreserved(before, { tab: before.tab }));
});

test("worker replacement requires actual trusted held input on the unchanged original document", () => {
  const state = { documentId: "original-document", documentToken: "original-page-token", heldCapture: true,
    inputEvents: [{ type: "pointerdown", target: "held", trusted: true, buttons: 1, pointerId: 1 }, { type: "keydown", target: "held", key: "Shift", trusted: true }] };
  assertHeldNativeInput(state); assertHeldNativeInput(structuredClone(state), state);
  for (const invalid of [
    { inputEvents: [] }, { heldCapture: false },
    { inputEvents: [{ ...state.inputEvents[0], trusted: false }, state.inputEvents[1]] },
    { inputEvents: [state.inputEvents[0]] },
    { inputEvents: [...state.inputEvents, { type: "pointerup", trusted: true }] },
    { inputEvents: [...state.inputEvents, { type: "keyup", key: "Shift", trusted: true }] },
    { inputEvents: [...state.inputEvents, { type: "lostpointercapture", trusted: true }] }
  ]) assert.throws(() => assertHeldNativeInput({ ...state, ...invalid }));
  assert.throws(() => assertHeldNativeInput({ ...state, documentId: "replacement-document" }, state));
  assert.throws(() => assertHeldNativeInput({ ...state, documentToken: "reloaded-page-token" }, state));
  assert.throws(() => assertHeldNativeInput({ ...state, inputEvents: [...state.inputEvents].reverse() }, state));
});

test("unknown native input cannot be reported as cleanup complete by an empty new tracker", () => {
  const status = { state: "error", inputBlocked: true, cleanupComplete: false, error: "OBU_INPUT_RELEASE_UNCONFIRMED: original target is still live" };
  assertUnconfirmedInputBlocked(status);
  for (const invalid of [{ state: "running" }, { state: "paused" }, { inputBlocked: false }, { cleanupComplete: true }, { error: "unrelated failure" }]) {
    assert.throws(() => assertUnconfirmedInputBlocked({ ...status, ...invalid }));
  }
});

test("Retry and Resume require the original live popup document, not another same-URL page", () => {
  const context = { contextType: "POPUP", contextId: "context", documentId: "document", documentUrl: "chrome-extension://test/popup.html", tabId: -1 };
  assertSamePopupDocument(context, [structuredClone(context)]);
  for (const change of [{ contextType: "TAB" }, { contextId: "replacement" }, { documentId: "replacement" }, { documentUrl: "chrome-extension://test/other.html" }, { tabId: 42 }]) {
    assert.throws(() => assertSamePopupDocument(context, [{ ...context, ...change }]));
  }
  assert.throws(() => assertSamePopupDocument(context, []));
  assert.throws(() => assertSamePopupDocument(context, [context, context]));
});

test("retained-popup recovery permits no new focus or activation event after its opening interval", () => {
  const before = { identity: "continuous-observer", ready: true, overflow: false, events: [
    { sequence: 0, at: 10, kind: "focus", value: 20 }, { sequence: 1, at: 11, kind: "focus", value: -1 }
  ] };
  assertNoNewFocusEvents(before, { ...structuredClone(before), at: 40 });
  for (const event of [{ sequence: 2, at: 30, kind: "focus", value: 20 }, { sequence: 2, at: 30, kind: "activation", value: { tabId: 1, windowId: 20 } }]) {
    assert.throws(() => assertNoNewFocusEvents(before, { ...before, events: [...before.events, event] }));
  }
  for (const change of [{ identity: "new-observer" }, { ready: false }, { overflow: true }, { events: [] }, { events: [...before.events].reverse() }]) {
    assert.throws(() => assertNoNewFocusEvents(before, { ...before, ...change }));
  }
});

test("popup screenshots require the rendered label and enabled action to match the acknowledged state", () => {
  const cases = [["error", "Failed", "Retry pause"], ["paused", "Paused", "Resume control"], ["running", "Running", "Pause all agents"]];
  for (const [state, label, buttonText] of cases) {
    const status = { state, cleanupComplete: state !== "error" };
    const ui = { state, label, buttonText, buttonDisabled: false };
    assert.equal(popupUIReflectsStatus(status, ui), true);
    for (const change of [{ state: "pausing" }, { label: "Checking" }, { buttonText: "Resuming…" }, { buttonDisabled: true }]) {
      assert.equal(popupUIReflectsStatus(status, { ...ui, ...change }), false);
    }
    assert.equal(popupUIReflectsStatus(status, undefined), false);
  }
  assert.equal(popupUIReflectsStatus({ state: "paused", cleanupComplete: false }, { state: "paused", label: "Paused", buttonText: "Resume control", buttonDisabled: false }), false);
});

test("browser-restart acceptance requires all eight distinct cases and no cleanup failure", () => {
  const records = browserRestartCases.map(name => ({ name, passed: true }));
  assert.equal(records.length, 8); assert.equal(allBrowserRestartCasesPassed(records), true);
  for (let index = 0; index < records.length; index++) {
    assert.equal(allBrowserRestartCasesPassed(records.filter((_, i) => i !== index)), false);
    assert.equal(allBrowserRestartCasesPassed(records.map((record, i) => i === index ? { ...record, passed: false } : record)), false);
  }
  assert.equal(allBrowserRestartCasesPassed([...records.slice(0, -1), records[0]]), false);
  assert.equal(allBrowserRestartCasesPassed([...records, { name: "cleanup", passed: false }]), false);
});
