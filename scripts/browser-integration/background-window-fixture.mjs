import assert from "node:assert/strict";

const scope = browser => ({ session_id: browser.client.sessionId, turn_id: browser.client.turnId, control_epoch: browser.client.controlEpoch });
const errorDetail = error => ({ message: String(error?.message ?? error), stack: error?.stack });
const byId = values => [...values].sort((a, b) => a.id - b.id);
const stableTabs = values => byId(values.map(({ id, windowId, groupId, pinned, url }) => ({ id, windowId, groupId, pinned, url })));
const stableWindows = values => byId(values.map(({ id, type, focused, state }) => ({ id, type, focused, state })));

export function checkBackgroundWindowCreated(before, after, tabId) {
  assert.ok(Number.isSafeInteger(tabId), "Public newTab did not return an exact native tab ID");
  assert.ok(!before.tabs.some(tab => tab.id === tabId));
  const tab = after.tabs.find(tab => tab.id === tabId);
  assert.ok(tab, "Public background tab is absent from native tabs");
  const window = after.windows.find(window => window.id === tab.windowId);
  assert.ok(window && !before.windows.some(value => value.id === window.id), "backgroundWindow reused an existing window");
  assert.equal(window.type, "normal"); assert.equal(window.focused, false);
  assert.equal(tab.active, true); assert.equal(tab.groupId, -1);
  assert.deepEqual(after.tabs.filter(value => value.windowId === window.id).map(value => value.id), [tabId]);
  assert.deepEqual(stableTabs(after.tabs.filter(value => value.id !== tabId)), stableTabs(before.tabs), "Creating a background window changed existing tabs");
  assert.deepEqual(stableWindows(after.windows.filter(value => value.id !== window.id)), stableWindows(before.windows), "Creating a background window changed existing windows");
  return { tabId, windowId: window.id };
}

// The event allowance is restricted to this public create call and its exact
// returned native tab/window. No test window creation or explicit claim occurs.
export function createBackgroundWindowRecorder({ browser, readNative, readFocus, focusLedger, allowedActivations, allowedFocus }) {
  const records = [];
  return {
    records,
    async createTab() {
      const record = { requestedAt: Date.now(), scope: scope(browser) }; records.push(record);
      try {
        record.before = await readNative(); record.focusBefore = await readFocus();
        focusLedger.assertAllowed(record.focusBefore, allowedActivations, allowedFocus);
        record.request = { backgroundWindow: true };
        const tab = await browser.newTab(record.request); record.tabId = tab.id; record.completedAt = Date.now();
        record.after = await readNative(); record.focusAfter = await readFocus();
        Object.assign(record, checkBackgroundWindowCreated(record.before, record.after, tab.id));
        assert.deepEqual(scope(browser), record.scope, "Public creation changed the original control scope");
        record.allowances = focusLedger.allowPopupCreation(record.focusBefore, record.focusAfter, {
          tabId: tab.id, windowId: record.windowId, reason: "sole tab created by public backgroundWindow in a new unfocused normal window", publicBackgroundWindow: true
        });
        allowedActivations.push(...record.allowances);
        focusLedger.assertAllowed(record.focusAfter, allowedActivations, allowedFocus);
        return tab;
      } catch (error) { record.error = errorDetail(error); throw error; }
    }
  };
}

export function checkBackgroundWindowCleanup(snapshot, records) {
  for (const { tabId, windowId } of records) {
    assert.ok(Number.isSafeInteger(tabId) && Number.isSafeInteger(windowId), "Creation identity is incomplete");
    assert.equal(snapshot.tabs.some(tab => tab.id === tabId), false, "Agent background tab survived finalize");
    assert.equal(snapshot.windows.some(window => window.id === windowId), false, "Empty agent background window survived finalize");
    assert.equal(snapshot.targets.some(target => target.tabId === tabId && target.attached), false, "Finalized background tab retained an attachment");
  }
}

export function checkBackgroundWindowSuccessor({ before, after, focusBefore, focusAfter, agentTabId, extraTabId, windowId }) {
  const originalWindow = before.windows.find(value => value.id === windowId), finalWindow = after.windows.find(value => value.id === windowId);
  assert.ok(originalWindow && finalWindow); assert.equal(originalWindow.type, "normal");
  assert.equal(originalWindow.focused, false); assert.equal(finalWindow.focused, false);
  const original = before.tabs.filter(tab => tab.windowId === windowId), retained = after.tabs.filter(tab => tab.windowId === windowId);
  assert.deepEqual(original.map(tab => tab.id).sort((a, b) => a - b), [agentTabId, extraTabId].sort((a, b) => a - b));
  assert.equal(original.find(tab => tab.id === agentTabId).active, true);
  assert.equal(original.find(tab => tab.id === extraTabId).active, false);
  assert.equal(after.tabs.some(tab => tab.id === agentTabId), false);
  assert.equal(retained.length, 1); assert.equal(retained[0].id, extraTabId); assert.equal(retained[0].active, true);
  assert.deepEqual(stableTabs(retained), stableTabs(original.filter(tab => tab.id === extraTabId)), "Finalization changed the retained fixture user page");
  assert.equal(focusAfter.identity, focusBefore.identity);
  assert.deepEqual(focusAfter.events.slice(0, focusBefore.events.length), focusBefore.events);
  const delta = focusAfter.events.slice(focusBefore.events.length);
  assert.ok(delta.length <= 1, "Background finalization emitted repeated/unrelated events");
  assert.ok(delta.every(event => event.kind === "activation" && event.value.tabId === extraTabId && event.value.windowId === windowId), "Background finalization changed another tab/window focus");
  assert.ok(delta.every(event => event.at >= focusBefore.at && event.at <= focusAfter.at), "Successor event is outside the observed finalization interval");
  return delta.map(event => ({ tabId: extraTabId, windowId, closedAgentTabId: agentTabId,
    sequence: event.sequence, index: focusAfter.events.slice(0, event.sequence).filter(value => value.kind === "activation").length,
    beforeAt: focusBefore.at, afterAt: focusAfter.at, reason: "sole retained fixture user tab naturally activated after exact background agent-tab finalization" }));
}

// A mixed public session, plus one deliberately test-created, unclaimed user
// page. Only that extra page is removed by the test; agent pages use finalize.
export async function checkBackgroundWindowOwnership({ browser, fixtureURL, recorder, readNative, readFocus, focusLedger, allowedActivations, allowedFocus, createExtra, removeExtra, until }) {
  const detail = { scope: scope(browser), steps: [], creations: recorder.records, finalizeAttempted: false, cleanup: {}, boundary: "Public SDK grouped/background-window creation and finalize; native read-only identity snapshots. One extra test-owned unclaimed user tab, no private profile pages." };
  let failure, extra;
  const step = async (name, operation) => {
    const value = { name, requestedAt: Date.now(), scope: scope(browser) }; detail.steps.push(value);
    try { value.result = await operation(); value.completedAt = Date.now(); return value.result; }
    catch (error) { value.error = errorDetail(error); throw error; }
  };
  try {
    detail.info = await browser.client.getInfo(); assert.equal(detail.info.metadata.backgroundWindowVersion, 1);
    detail.before = await readNative();
    const grouped = await step("createGrouped", async () => ({ id: (await browser.newTab()).id }));
    detail.groupedTabId = grouped.id;
    await step("navigateGrouped", () => browser.cdp.navigate(grouped.id, new URL("?background-window=grouped", fixtureURL).href));
    const background = await recorder.createTab(); detail.backgroundTabId = background.id;
    detail.backgroundWindowId = recorder.records.at(-1).windowId;
    await step("navigateBackground", () => browser.cdp.navigate(background.id, new URL("?background-window=owned", fixtureURL).href));
    const later = await step("createGroupedAfterBackground", async () => ({ id: (await browser.newTab()).id })); detail.laterGroupedTabId = later.id;
    await step("navigateLaterGrouped", () => browser.cdp.navigate(later.id, new URL("?background-window=later-grouped", fixtureURL).href));
    detail.mixed = await readNative();
    const a = detail.mixed.tabs.find(tab => tab.id === grouped.id), b = detail.mixed.tabs.find(tab => tab.id === background.id), c = detail.mixed.tabs.find(tab => tab.id === later.id);
    assert.ok(a && b && c); assert.ok(a.groupId >= 0); assert.equal(c.groupId, a.groupId); assert.equal(c.windowId, a.windowId);
    assert.notEqual(a.windowId, b.windowId); assert.equal(a.active, false); assert.equal(c.active, false); assert.equal(b.active, true); assert.equal(b.groupId, -1);
    detail.ownerTabs = await browser.client.getTabs();
    assert.deepEqual(detail.ownerTabs.map(tab => tab.id).sort((a, b) => a - b), [grouped.id, background.id, later.id].sort((a, b) => a - b));
    const url = new URL("?background-window=fixture-user", fixtureURL).href;
    extra = await createExtra({ windowId: b.windowId, url, active: false }); detail.extra = extra;
    assert.ok(Number.isSafeInteger(extra.id)); assert.equal(extra.windowId, b.windowId); assert.equal(extra.active, false);
    await until(async () => { const snapshot = await readNative(); detail.beforeFinalize = snapshot; return snapshot.tabs.some(tab => tab.id === extra.id && tab.url === url && tab.status === "complete"); }, "test user tab committed in background window", 5000);
    detail.ownerTabsWithExtra = await browser.client.getTabs(); assert.equal(detail.ownerTabsWithExtra.some(tab => tab.id === extra.id), false);
    detail.focusBeforeFinalize = await readFocus(); focusLedger.assertAllowed(detail.focusBeforeFinalize, allowedActivations, allowedFocus);
    detail.finalizeAttempted = true;
    await step("finalize", () => browser.client.finalizeTabs([]));
    await until(async () => { const snapshot = await readNative(); detail.afterFinalize = snapshot; return [grouped.id, background.id, later.id].every(id => !snapshot.tabs.some(tab => tab.id === id)) && snapshot.tabs.some(tab => tab.id === extra.id); }, "agent tabs removed and fixture user tab retained", 5000);
    detail.focusAfterFinalize = await readFocus();
    detail.successorAllowances = checkBackgroundWindowSuccessor({ before: detail.beforeFinalize, after: detail.afterFinalize, focusBefore: detail.focusBeforeFinalize, focusAfter: detail.focusAfterFinalize, agentTabId: background.id, extraTabId: extra.id, windowId: b.windowId });
    allowedActivations.push(...detail.successorAllowances); focusLedger.assertAllowed(detail.focusAfterFinalize, allowedActivations, allowedFocus);
    assert.deepEqual(stableTabs(detail.afterFinalize.tabs.filter(tab => tab.id !== extra.id)), stableTabs(detail.before.tabs), "Finalization altered unrelated baseline tabs");
    assert.deepEqual(stableWindows(detail.afterFinalize.windows.filter(window => window.id !== b.windowId)), stableWindows(detail.before.windows));
    assert.ok([grouped.id, background.id, later.id, extra.id].every(id => !detail.afterFinalize.targets.some(target => target.tabId === id && target.attached)));
    await browser.client.beginTurn(); detail.freshScope = scope(browser); detail.ownerTabsAfterFinalize = await browser.client.getTabs(); assert.deepEqual(detail.ownerTabsAfterFinalize, []);
    detail.passed = true; return detail;
  } catch (error) { failure = error; detail.passed = false; detail.error = errorDetail(error); error.backgroundWindowDetail = detail; throw error; }
  finally {
    const errors = [];
    if (!detail.finalizeAttempted) {
      detail.finalizeAttempted = true;
      try { detail.cleanup.finalize = await browser.client.finalizeTabs([]); } catch (error) { errors.push(error); detail.cleanup.finalizeError = errorDetail(error); }
    }
    if (extra) {
      try { await removeExtra({ tabId: extra.id, windowId: extra.windowId }); detail.cleanup.extraRemoved = true; }
      catch (error) { errors.push(error); detail.cleanup.extraError = errorDetail(error); }
    }
    try {
      await until(async () => { detail.cleanup.after = await readNative(); const ids = [detail.groupedTabId, detail.backgroundTabId, detail.laterGroupedTabId, extra?.id].filter(Number.isSafeInteger); return ids.every(id => !detail.cleanup.after.tabs.some(tab => tab.id === id)) && (!detail.backgroundWindowId || !detail.cleanup.after.windows.some(window => window.id === detail.backgroundWindowId)); }, "background-window fixture cleanup", 5000);
    } catch (error) { errors.push(error); detail.cleanup.observationError = errorDetail(error); }
    if (errors.length) {
      detail.passed = false;
      if (failure) detail.cleanup.errors = errors.map(errorDetail);
      else { const error = new AggregateError(errors, "Background-window fixture cleanup failed"); error.backgroundWindowDetail = detail; throw error; }
    }
  }
}
