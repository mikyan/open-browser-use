import test from "node:test";
import assert from "node:assert/strict";
import { FocusLedger, assertQuietObserverSetup, currentWorkerVersion, focusArrays, installFocusObserver, readFocusEvidence } from "./focus-ledger.mjs";

const activation = (tabId = 8, windowId = 4) => ({ kind: "activation", value: { tabId, windowId } });
const focus = value => ({ kind: "focus", value });
const snapshot = (events = [], identity = "observer-one") => ({ identity, ready: true, overflow: false, at: 100,
  events: events.map((event, sequence) => ({ ...event, sequence, at: sequence + 1 })) });
const metadata = { tabId: 8, windowId: 4, reason: "sole popup tab created unfocused" };

test("native observer retains duplicate events and records local delivery order", () => {
  const callbacks = {}, target = {};
  installFocusObserver({ tabs: { onActivated: { addListener: fn => callbacks.activation = fn } }, windows: { onFocusChanged: { addListener: fn => callbacks.focus = fn } } }, target, "instance");
  callbacks.activation({ tabId: 8, windowId: 4, extra: "native" }); callbacks.focus(-1); callbacks.activation({ tabId: 8, windowId: 4, extra: "native" });
  const value = target.__integrationFocusLedger.snapshot();
  assert.deepEqual(value.events.map(event => event.sequence), [0, 1, 2]);
  assert.deepEqual(focusArrays(value), { activeEvents: [{ tabId: 8, windowId: 4, extra: "native" }, { tabId: 8, windowId: 4, extra: "native" }], windowFocusEvents: [-1] });
  value.events[0].value.tabId = 999;
  assert.equal(target.__integrationFocusLedger.snapshot().events[0].value.tabId, 8);
});

test("popup creation permits exactly the observed event index, never later reactivation", () => {
  const ledger = new FocusLedger(), before = snapshot(), after = snapshot([activation()]);
  const permissions = ledger.allowPopupCreation(before, after, metadata);
  ledger.assertAllowed(after, permissions, []);
  assert.throws(() => ledger.assertAllowed(snapshot([activation(), activation()]), permissions, []), /Unexpected native activation/);
});

test("no event during creation gives no allowance to a delayed or sentinel activation", () => {
  const ledger = new FocusLedger(), before = snapshot();
  const permissions = ledger.allowPopupCreation(before, before, metadata);
  assert.deepEqual(permissions, []);
  assert.throws(() => ledger.assertAllowed(snapshot([activation()]), permissions, []), /Unexpected native activation/);
});

test("creation interval rejects preceding unexplained, repeated, foreign and focus events", () => {
  const ledger = new FocusLedger(), before = snapshot([activation(7)]), after = snapshot([activation(7), activation()]);
  const permissions = ledger.allowPopupCreation(before, after, metadata);
  assert.equal(permissions[0].index, 1);
  assert.throws(() => ledger.assertAllowed(after, permissions, []), /Unexpected native activation/);
  for (const events of [[activation(), activation()], [activation(9)], [focus(4)], [activation(), focus(-1)]]) {
    assert.throws(() => ledger.allowPopupCreation(snapshot(), snapshot(events), metadata), /Popup creation/);
  }
});

test("event prefixes cannot be truncated, rewritten or replaced by a new document", () => {
  for (const next of [snapshot(), snapshot([activation(9)]), snapshot([activation()], "new-document")]) {
    const ledger = new FocusLedger(); ledger.accept(snapshot([activation()]));
    assert.throws(() => ledger.accept(next), /truncated|rewritten|document changed/);
  }
  const changedSequence = snapshot([activation()]); changedSequence.events[0].sequence = 1;
  assert.throws(() => new FocusLedger().accept(changedSequence), /sequence changed/);
});

test("observer unavailable or overflow is failure, never an empty clean ledger", () => {
  for (const value of [null, {}, { ...snapshot(), ready: false }, { ...snapshot(), overflow: true }]) {
    assert.throws(() => new FocusLedger().accept(value), /observer/);
  }
  const callbacks = {}, target = {};
  installFocusObserver({ tabs: { onActivated: { addListener: fn => callbacks.activation = fn } }, windows: { onFocusChanged: { addListener: fn => callbacks.focus = fn } } }, target, "instance", 1);
  callbacks.activation({ tabId: 8, windowId: 4 }); callbacks.focus(-1);
  const value = target.__integrationFocusLedger.snapshot();
  assert.equal(value.events.length, 1); assert.equal(value.overflow, true);
  assert.throws(() => new FocusLedger().accept(value), /capacity exceeded/);
});

test("setup requires both observed segments to be quiet without merging them", () => {
  assertQuietObserverSetup(snapshot([], "worker"), snapshot());
  assert.throws(() => assertQuietObserverSetup(snapshot([focus(4)], "worker"), snapshot()), /worker ledger/);
  assert.throws(() => assertQuietObserverSetup(snapshot([], "worker"), snapshot([activation()])), /document ledger/);
});

test("action popup focus requires exact ordered events and live popup proof", () => {
  const ledger = new FocusLedger(), before = snapshot(), after = snapshot([focus(4), focus(-1)]);
  const meta = { windowId: 4, popupURL: "chrome-extension://test/popup.html", popupContexts: [{ type: "POPUP", documentUrl: "chrome-extension://test/popup.html" }], reason: "explicit settings UI" };
  const allowed = ledger.allowActionPopup(before, after, meta);
  ledger.assertAllowed(after, [], allowed);
  assert.throws(() => ledger.allowActionPopup(before, after, { ...meta, popupContexts: [] }), /live real action POPUP/);
  for (const events of [[focus(-1), focus(4)], [focus(4)], [activation(), focus(4), focus(-1)]]) {
    assert.throws(() => ledger.allowActionPopup(before, snapshot(events), meta), /Unexpected/);
  }
});

test("final snapshot detects events after a case passed and missing attribution history", () => {
  const ledger = new FocusLedger(); ledger.assertAllowed(snapshot(), [], []);
  assert.throws(() => ledger.assertAllowed(snapshot([focus(4)]), [], []), /Unexpected native focus/);
  assert.throws(() => new FocusLedger().assertAllowed(snapshot(), [{ ...metadata, index: 0, sequence: 0 }], []), /disappeared/);
  const full = snapshot([activation()]), allowed = ledger.allowPopupCreation(snapshot(), full, metadata);
  assert.throws(() => new FocusLedger().assertAllowed(full, [...allowed, ...allowed], []), /Duplicate/);
});

test("persistent CDP observer uses latest worker state and exact target over repeated restarts", () => {
  const url = "chrome-extension://test/background.js";
  const update = (...versions) => ({ method: "ServiceWorker.workerVersionUpdated", params: { versions } });
  const version = (versionId, runningStatus, targetId) => ({ versionId, scriptURL: url, runningStatus, ...(targetId ? { targetId } : {}) });
  const events = [update(version("1", "running", "old")), update(version("1", "stopped")), update(version("2", "running", "current"))];
  assert.equal(currentWorkerVersion(events, { url, targetId: "current" }).versionId, "2");
  assert.equal(currentWorkerVersion(events, { url, targetId: "other" }), undefined);
  events.push(update(version("2", "stopped")), update(version("2", "running", "third")));
  assert.equal(currentWorkerVersion(events, { url, targetId: "third" }).targetId, "third");
  assert.throws(() => currentWorkerVersion([update(version("1", "running"), version("2", "running"))], { url, targetId: "unknown" }), /Ambiguous/);
});

test("failed observer reads retain accepted raw events and preserve the failed attempt separately", async () => {
  for (const read of [() => undefined, () => snapshot([], "replacement"), () => ({ broken: true }), () => { throw new Error("observer connection lost"); }]) {
    const ledger = new FocusLedger(), evidence = {};
    const valid = snapshot([activation(), focus(-1)]);
    await readFocusEvidence(ledger, evidence, () => valid);
    await assert.rejects(readFocusEvidence(ledger, evidence, read), /observer|Observer|document changed/);
    assert.deepEqual(evidence.lastAccepted, valid);
    assert.deepEqual(evidence.latest, valid);
    assert.equal(evidence.lastAttempted.status, "failed");
    assert.ok(evidence.attemptError);
    assert.deepEqual(focusArrays(evidence.lastAccepted), { activeEvents: [{ tabId: 8, windowId: 4 }], windowFocusEvents: [-1] });
    if (evidence.lastAttempted.valueType === "undefined") assert.equal(evidence.lastAttempted.snapshot, null);
    else if (evidence.lastAttempted.valueType === "snapshot") assert.notDeepEqual(evidence.lastAttempted.snapshot, valid);
  }
});
