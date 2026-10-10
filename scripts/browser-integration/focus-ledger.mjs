import assert from "node:assert/strict";

// Staged test document only. The sequence is this observer's local delivery
// order, not a Chrome-wide event ID. Keep duplicate native events verbatim.
export function installFocusObserver(chrome, target, identity, maxEvents = 10000) {
  const events = [];
  let overflow = false;
  const append = (kind, value) => {
    if (events.length >= maxEvents) { overflow = true; return; }
    events.push({ sequence: events.length, at: Date.now(), kind, value });
  };
  chrome.tabs.onActivated.addListener(info => append("activation", { ...info }));
  chrome.windows.onFocusChanged.addListener(windowId => append("focus", windowId));
  target.__integrationFocusLedger = {
    snapshot: () => ({ identity, ready: true, overflow, at: Date.now(), events: events.map(event => ({ ...event, ...(event.kind === "activation" ? { value: { ...event.value } } : {}) })) })
  };
}

export const focusObserverHTML = '<!doctype html><meta charset="utf-8"><title>OBU integration event observer</title><script src="integration-observer.js"></script>';
export const focusObserverSource = `(${installFocusObserver.toString()})(chrome, globalThis, crypto.randomUUID());\n`;
export const focusSnapshotExpression = "globalThis.__integrationFocusLedger?.snapshot()";

function checked(snapshot) {
  assert.ok(snapshot && snapshot.ready === true && typeof snapshot.identity === "string" && snapshot.identity, "Focus observer unavailable or not ready");
  assert.equal(snapshot.overflow, false, "Focus observer event capacity exceeded");
  assert.ok(Array.isArray(snapshot.events), "Focus observer event history unavailable");
  for (const [index, event] of snapshot.events.entries()) {
    assert.equal(event.sequence, index, "Focus observer sequence changed or contains a gap");
    assert.ok(Number.isFinite(event.at), "Focus observer event time unavailable");
    assert.ok(event.kind === "activation" || event.kind === "focus", "Unknown focus observer event");
    if (event.kind === "activation") {
      assert.ok(Number.isSafeInteger(event.value?.tabId) && Number.isSafeInteger(event.value?.windowId), "Invalid native activation event");
    } else assert.ok(Number.isSafeInteger(event.value), "Invalid native focus event");
  }
  return snapshot;
}

function suffix(before, after) {
  checked(before); checked(after);
  assert.equal(after.identity, before.identity, "Focus observer document changed");
  assert.ok(after.events.length >= before.events.length, "Focus observer history was truncated");
  assert.deepEqual(after.events.slice(0, before.events.length), before.events, "Focus observer history was rewritten");
  return after.events.slice(before.events.length);
}

export function focusArrays(snapshot) {
  checked(snapshot);
  return {
    activeEvents: snapshot.events.filter(event => event.kind === "activation").map(event => ({ ...event.value })),
    windowFocusEvents: snapshot.events.filter(event => event.kind === "focus").map(event => event.value)
  };
}

export function assertQuietObserverSetup(workerSnapshot, observerSnapshot) {
  checked(workerSnapshot); checked(observerSnapshot);
  assert.deepEqual(workerSnapshot.events, [], "Observer setup caused native activation/focus events in the worker ledger");
  assert.deepEqual(observerSnapshot.events, [], "Observer setup caused native activation/focus events in the document ledger");
}

// The observer's CDP session also survives worker restarts. Select from the
// latest state of each native version, never an old historical "running" item.
export function currentWorkerVersion(events, { url, targetId }) {
  const latest = new Map(events.filter(event => event.method === "ServiceWorker.workerVersionUpdated")
    .flatMap(event => event.params.versions).map(value => [value.versionId, value]));
  const candidates = [...latest.values()].filter(value => value.scriptURL === url && value.runningStatus === "running" && (!value.targetId || value.targetId === targetId));
  assert.ok(candidates.length <= 1, "Ambiguous running extension worker versions");
  return candidates[0];
}

export async function readFocusEvidence(ledger, evidence, read) {
  const attempt = { at: Date.now(), status: "reading" };
  evidence.lastAttempted = attempt;
  try {
    const snapshot = await read();
    // JSON omits undefined, so preserve that outcome explicitly as well.
    attempt.valueType = snapshot === undefined ? "undefined" : "snapshot";
    attempt.snapshot = snapshot === undefined ? null : structuredClone(snapshot);
    ledger.accept(snapshot);
    evidence.lastAccepted = structuredClone(ledger.latest);
    evidence.latest = evidence.lastAccepted;
    attempt.status = "accepted";
    delete evidence.attemptError;
    return snapshot;
  } catch (error) {
    attempt.status = "failed";
    attempt.error = error.stack ?? String(error);
    evidence.attemptError = attempt.error;
    throw error;
  }
}

export class FocusLedger {
  constructor() { this.latest = null; }

  accept(snapshot) {
    checked(snapshot);
    if (this.latest) suffix(this.latest, snapshot);
    this.latest = structuredClone(snapshot);
    return snapshot;
  }

  allowPopupCreation(before, after, metadata) {
    const delta = suffix(before, after);
    assert.ok(delta.length <= 1, "Popup creation emitted repeated or unrelated native events");
    assert.ok(delta.every(event => event.kind === "activation" && event.value.tabId === metadata.tabId && event.value.windowId === metadata.windowId), "Popup creation changed another tab or window focus");
    // No observed event means no permission for an event arriving later.
    return delta.map(event => ({ ...metadata, index: after.events.slice(0, event.sequence).filter(item => item.kind === "activation").length, sequence: event.sequence,
      beforeAt: before.at, afterAt: after.at }));
  }

  allowActionPopup(before, after, { windowId, popupURL, popupContexts, reason }) {
    const delta = suffix(before, after);
    assert.ok(Array.isArray(popupContexts) && popupContexts.some(context => context.type === "POPUP" && context.documentUrl === popupURL), "Focus attribution requires a live real action POPUP context");
    assert.ok(delta.length === 0 || (delta.length === 2 && delta[0].kind === "focus" && delta[0].value === windowId && delta[1].kind === "focus" && delta[1].value === -1), "Unexpected activation/focus sequence during action.openPopup");
    return delta.map(event => ({ index: after.events.slice(0, event.sequence).filter(item => item.kind === "focus").length, sequence: event.sequence, windowId: event.value,
      reason, beforeAt: before.at, afterAt: after.at, popupContexts: structuredClone(popupContexts) }));
  }

  assertAllowed(snapshot, allowedActivations, allowedFocus) {
    this.accept(snapshot);
    for (const [kind, permissions] of [["activation", allowedActivations], ["focus", allowedFocus]]) {
      const events = snapshot.events.filter(event => event.kind === kind);
      const seen = new Set();
      for (const permission of permissions) {
        assert.ok(Number.isSafeInteger(permission.index) && permission.index >= 0 && !seen.has(permission.index), "Duplicate or invalid event attribution");
        seen.add(permission.index);
        const event = events[permission.index];
        assert.ok(event && event.sequence === permission.sequence, "Attributed native event disappeared or moved");
        if (kind === "activation") assert.deepEqual([event.value.tabId, event.value.windowId], [permission.tabId, permission.windowId], "Attributed activation changed");
        else assert.equal(event.value, permission.windowId, "Attributed window focus changed");
      }
      assert.ok(events.every((_, index) => seen.has(index)), `Unexpected native ${kind} event: ${JSON.stringify(events)}`);
    }
  }
}
