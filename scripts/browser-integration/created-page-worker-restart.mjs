import assert from "node:assert/strict";
import { createdPageAction } from "./created-page-provenance.mjs";

const scopeOf = browser => ({ session_id: browser.client.sessionId, turn_id: browser.client.turnId, control_epoch: browser.client.controlEpoch });
const stale = /OBU_STALE_CONTROL_EPOCH/;
const expired = /OBU_PAGE_WAIT_EXPIRED/;
const unowned = /not part of browser session|OBU_AUXILIARY_/;

// Serialized into an existing extension page that survives worker termination.
// onChanged delivery is evidence of a storage transition, not the original
// set() Promise acknowledgement. No ownership or browser operation is issued.
export async function installCreatedPageRecoveryStorageObserver(chrome, target, options) {
  const { tabIds, maxRecords = 1024, maxBytes = 4 * 1024 * 1024 } = options ?? {};
  const key = "OPEN_BROWSER_USE_AUXILIARY_TABS";
  if (!chrome?.storage?.onChanged || !chrome.storage.session || !target || target.__createdPageRecoveryStorage ||
      !Array.isArray(tabIds) || tabIds.length < 1 || tabIds.length > 16 || new Set(tabIds).size !== tabIds.length ||
      tabIds.some(id => !Number.isSafeInteger(id) || id < 0) ||
      !Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > 4096 ||
      !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 16 * 1024 * 1024) throw Error("Invalid recovery storage observer installation");
  const selected = new Set(tabIds), records = [], errors = [], encoder = new TextEncoder();
  let sequence = 0, bytes = 0, overflow = false, closed = false, initial = null;
  const clone = value => JSON.parse(JSON.stringify(value));
  const reportError = error => { if (errors.length < 16) errors.push(String(error?.message ?? error).slice(0, 1024)); };
  const state = value => value === undefined ? null : {
    version: value.version ?? null, incarnation: value.incarnation ?? null,
    records: Array.isArray(value.records) ? clone(value.records.filter(record => selected.has(record.tabId))) : null,
  };
  const retain = value => {
    const size = encoder.encode(JSON.stringify(value)).byteLength;
    if (bytes + size > maxBytes) { overflow = true; return false; }
    bytes += size; return true;
  };
  const listener = (changes, areaName) => {
    if (closed || overflow || areaName !== "session" || !Object.hasOwn(changes, key)) return;
    try {
      const row = { sequence: ++sequence, receivedAt: Date.now(), oldValue: state(changes[key].oldValue), newValue: state(changes[key].newValue) };
      if (records.length >= maxRecords) { overflow = true; return; }
      if (retain(row)) records.push(row);
    } catch (error) { reportError(error); }
  };
  const snapshot = () => clone({ tabIds, maxRecords, maxBytes, sequence, bytes, overflow, closed, errors, initial, records,
    boundary: "Independent initial session-storage read and onChanged old/new delivery in one persistent extension page; not original storage.set Promise ACKs." });
  const stop = () => {
    if (!closed) { closed = true; chrome.storage.onChanged.removeListener(listener); }
    return { ...snapshot(), listenerPresent: chrome.storage.onChanged.hasListener(listener) };
  };
  chrome.storage.onChanged.addListener(listener);
  target.__createdPageRecoveryStorage = { snapshot, stop };
  try {
    const value = await chrome.storage.session.get(key);
    if (closed) throw Error("Recovery storage observer stopped before its initial read completed");
    const observed = { sequence, receivedAt: Date.now(), value: state(value?.[key]) };
    if (retain(observed)) initial = observed;
    return { installed: true, tabIds: [...tabIds], initial: clone(initial), maxRecords, maxBytes };
  } catch (error) { reportError(error); stop(); throw error; }
}

export function assertCreatedPageRecoveryStorage({ snapshot, items, allowIncomplete = false }) {
  assert.equal(snapshot.overflow, false); assert.deepEqual(snapshot.errors, []);
  assert.ok(snapshot.initial?.value, "Missing independent pre-restart storage read");
  assert.equal(snapshot.initial.value.version, 4);
  assert.ok(typeof snapshot.initial.value.incarnation === "string" && snapshot.initial.value.incarnation, "Missing original browser incarnation");
  assert.deepEqual([...snapshot.tabIds].sort((a, b) => a - b), items.map(item => item.childId).sort((a, b) => a - b));
  let previousSequence = 0;
  for (const row of snapshot.records) {
    assert.equal(row.sequence, previousSequence + 1); previousSequence = row.sequence;
    assert.ok(Number.isFinite(row.receivedAt));
  }
  assert.equal(snapshot.sequence, previousSequence);
  assert.ok(Number.isSafeInteger(snapshot.initial.sequence) && snapshot.initial.sequence >= 0 && snapshot.initial.sequence <= snapshot.sequence);
  const checks = [], pending = [];
  for (const item of items) {
    const original = item.adopted.owner;
    const find = value => {
      if (value === null) return null;
      assert.equal(value.version, 4); assert.ok(Array.isArray(value.records));
      assert.equal(value.incarnation, snapshot.initial.value.incarnation);
      const found = value.records.filter(record => record.tabId === item.childId);
      assert.ok(found.length <= 1); return found[0] ?? null;
    };
    let current = find(snapshot.initial.value), quarantineSequence, removalSequence;
    assert.equal(current?.phase, "committed"); assert.equal(current.kind, "created-page");
    assert.deepEqual(current, original, "Initial storage did not contain the original admitted claim");
    assert.equal(current.claimId, original.claimId); assert.equal(current.session_id, item.scope.session_id);
    assert.equal(current.turn_id, item.scope.turn_id); assert.equal(current.control_epoch, item.scope.control_epoch);
    for (const row of snapshot.records.filter(row => row.sequence > snapshot.initial.sequence)) {
      const before = find(row.oldValue), after = find(row.newValue);
      assert.deepEqual(before, current, "Storage event chain does not continue the independent initial read");
      if (current && after?.phase === "quarantined") {
        assert.deepEqual(after, { ...current, phase: "quarantined" }, "Quarantine changed the original claim identity");
        quarantineSequence ??= row.sequence;
      }
      if (current && after === null) {
        assert.equal(current.phase, "quarantined", "Created page disappeared without an observed quarantine transition");
        assert.ok(quarantineSequence); removalSequence = row.sequence;
      }
      if (current === null) assert.equal(after, null, "Retired created-page authority was resurrected");
      if (after && after.phase !== "quarantined") assert.deepEqual(after, current, "Unexpected created-page authority transition");
      current = after;
    }
    if (quarantineSequence && removalSequence > quarantineSequence && current === null) {
      checks.push({ childId: item.childId, claimId: original.claimId, quarantineSequence, removalSequence });
    } else {
      assert.equal(allowIncomplete, true, "Missing committed → quarantined → removed storage events");
      pending.push({ childId: item.childId, phase: current?.phase ?? null, quarantineSequence: quarantineSequence ?? null });
    }
  }
  return { evidence: "persistent-extension-page storage.onChanged delivery", complete: pending.length === 0, checks, pending };
}

function assertDocument(frames, original, label) {
  const found = frames.filter(frame => frame.frameId === original.frameId);
  assert.equal(found.length, 1, `${label} frame disappeared`);
  assert.ok(original.documentId, `${label} original document identity missing`);
  assert.equal(found[0].documentId, original.documentId, `${label} original document was replaced`);
  assert.equal(found[0].url, original.url, `${label} original document navigated`);
}

function assertRetired(snapshot, item, tabs) {
  assert.equal(snapshot.tab.id, item.childId); assert.equal(snapshot.tab.windowId, item.createdTab.windowId);
  assert.equal(snapshot.tab.groupId, -1); assert.equal(snapshot.tab.pinned, false); assert.equal(snapshot.tab.url, item.childURL);
  assert.equal(snapshot.entry, null, "Recovery retained a reverse lock, including quarantine");
  assert.equal(snapshot.owner, null); assert.deepEqual(snapshot.stored, []);
  assert.equal(snapshot.targets.some(target => target.tabId === item.childId && target.attached), false);
  if (tabs) {
    assert.equal(tabs.some(tab => tab.id === item.childId), false);
    assert.equal(tabs.filter(tab => tab.id === item.tabId).length, 1, "Original committed background-window source was not recovered");
  }
}

// The caller owns real worker stop/start, persistent focus accounting, fixture
// cleanup and per-worker observer generations. This helper never grants focus
// allowances or marks the complete scene successful. Both budgets are checked
// before and after ACK; underlying RPCs keep their own bounds and are not
// cancelled by these checks. In particular the 30s observation budget does not
// renew any original expectPage deadline.
export async function checkCreatedPageWorkerRestart({ group, waiters, deadline, evaluate, persistentEvaluate, frames, ownership,
  restartWorker, onBeforeRestart, onAfterRestart, readSource, detail = {} }) {
  assert.equal(group.length, 3);
  assert.deepEqual(group.map(({ item }) => item.outcome).sort(), ["collect-restart", "idle-restart", "matched-restart"]);
  assert.ok(group.every(({ item }) => item.variant === "root"));
  for (const values of [group.map(({ item }) => item.key), group.map(({ item }) => item.childId), group.map(({ item }) => item.scope.session_id)]) assert.equal(new Set(values).size, 3);
  assert.equal(typeof persistentEvaluate, "function", "Persistent storage evidence is required for this restart probe");
  const contexts = [], original = operation => createdPageAction(deadline, operation);
  let observerInstalled = false, failure;
  Object.assign(detail, { startedAt: Date.now(), lifecycleVerified: false, cases: [],
    boundary: "Three original root children; one matched-undelivered, one collected-attached, one collected then publicly ended/idle. Same SDK clients explicitly refresh after old-scope probes. Separate 30s restart/observation budget; no deadline renewal, focus allowance, focus restoration, native cancellation or overall success claim." });
  const workerState = item => evaluate(`(()=>{const b=__integrationBackend,r=b.pageWaits.records.get(${JSON.stringify(item.waiterId)});return{control:b.controlLedger.records.get(${JSON.stringify(item.scope.session_id)})??null,sourceOwner:b.auxiliaryTabs.owner(${item.tabId})??null,waiter:r?{state:r.state,invalid:Boolean(r.invalid),delivered:Boolean(r.delivered),remainingMs:r.deadlineAt-b.pageWaits.now(),result:r.result??null}:null}})()`);
  const reject = async (operation, pattern) => {
    let record;
    try { record = { value: await operation() }; } catch (error) { record = { error: String(error), receivedAt: Date.now() }; }
    assert.ok(record.error, "Operation unexpectedly retained created-page authority"); assert.match(record.error, pattern); return record;
  };
  try {
    for (const member of group) {
      const { browser, item, target, tab } = member, waiter = waiters.get(item.key);
      assert.equal(waiter?.waiterId, item.waiterId); assert.deepEqual(scopeOf(browser), item.scope);
      const record = { key: item.key, outcome: item.outcome, childId: item.childId, originalScope: { ...item.scope } };
      item.workerRestart = record; detail.cases.push(record);
      const context = { ...member, waiter, record }; contexts.push(context);
      record.beforeCollect = await original(() => workerState(item));
      assert.equal(record.beforeCollect.waiter?.state, "matched"); assert.equal(record.beforeCollect.waiter.invalid, false);
      assert.equal(record.beforeCollect.waiter.delivered, false); assert.ok(record.beforeCollect.waiter.remainingMs > 0);
      assert.equal(record.beforeCollect.waiter.result.tabId, item.childId);
      record.sourceBefore = await original(() => readSource(target ?? tab, deadline));
      assert.equal(record.sourceBefore.documentToken, item.rootBefore.documentToken);
      if (item.outcome !== "matched-restart") {
        context.child = await original(() => waiter.result()); assert.equal(context.child.id, item.childId);
        record.childBefore = await original(() => readSource(context.child, deadline));
        assert.ok(record.childBefore.documentNonce && record.childBefore.documentToken);
        assert.deepEqual(record.childBefore.clicks, []);
        record.attached = await original(() => ownership(item));
        assert.ok(record.attached.targets.some(target => target.tabId === item.childId && target.attached), "Collected child read did not establish a real attachment");
      }
      if (item.outcome === "idle-restart") {
        record.turnEnded = await original(() => browser.client.turnEnded());
        record.scopeAfterEnd = scopeOf(browser);
        assert.ok(record.scopeAfterEnd.control_epoch > item.scope.control_epoch);
        // Do not read this source through the SDK again before termination:
        // requireSession would admit it and destroy the idle-recovery case.
      }
    }
    for (const { browser, item, record } of contexts) {
      record.beforeRestart = { ownership: await original(() => ownership(item)), state: await original(() => workerState(item)),
        sourceFrames: await original(() => frames(item.tabId)), childFrames: await original(() => frames(item.childId)), sdkScope: scopeOf(browser) };
      const before = record.beforeRestart, claim = before.ownership;
      assert.deepEqual(claim.owner, item.adopted.owner); assert.deepEqual(claim.entry, item.adopted.owner);
      assert.deepEqual(claim.stored, [item.adopted.owner]);
      assert.equal(before.state.control?.status, item.outcome === "idle-restart" ? "idle" : "active");
      assert.equal(before.state.sourceOwner?.claimId, item.sourceClaim.claimId);
      assert.equal(before.state.sourceOwner?.kind, "background-window");
      assert.equal(claim.targets.some(target => target.tabId === item.childId && target.attached), item.outcome === "collect-restart");
      if (item.outcome === "matched-restart") {
        assert.equal(before.state.waiter?.state, "matched"); assert.equal(before.state.waiter.invalid, false);
        assert.equal(before.state.waiter.delivered, false); assert.ok(before.state.waiter.remainingMs > 0);
      }
      assertDocument(before.sourceFrames, item.sourceFrame, "Source"); assertDocument(before.childFrames, item.childFrame, "Child");
    }
    // Mark installation before awaiting its initial read so failure cleanup can
    // still remove a listener installed by an evaluation with a lost response.
    observerInstalled = true;
    detail.storageObserver = await original(() => persistentEvaluate(`(${installCreatedPageRecoveryStorageObserver.toString()})(chrome,globalThis,${JSON.stringify({ tabIds: group.map(({ item }) => item.childId) })})`));
    await original(() => onBeforeRestart({ group, detail }));
    const observationDeadline = performance.now() + 30000, observed = operation => createdPageAction(observationDeadline, operation);
    detail.observation = { startedAt: Date.now(), budgetMs: 30000 };
    detail.restart = await observed(() => restartWorker({ deadline: observationDeadline, detail }));
    await observed(() => onAfterRestart({ group, detail, deadline: observationDeadline }));
    detail.controlReady = await observed(() => evaluate("(async()=>{await __integrationBackend.controlReady;return {ready:true}})()"));
    assert.equal(detail.controlReady?.ready, true);
    for (const { browser, item, record, child } of contexts) {
      record.afterRestart = { ownership: await observed(() => ownership(item)), state: await observed(() => workerState(item)),
        sourceFrames: await observed(() => frames(item.tabId)), childFrames: await observed(() => frames(item.childId)), sdkScope: scopeOf(browser) };
      assertRetired(record.afterRestart.ownership, item);
      assert.equal(record.afterRestart.state.waiter, null, "Worker restart retained an original waiter");
      assert.equal(record.afterRestart.state.sourceOwner?.claimId, item.sourceClaim.claimId);
      assertDocument(record.afterRestart.sourceFrames, item.sourceFrame, "Source"); assertDocument(record.afterRestart.childFrames, item.childFrame, "Child");
      assert.deepEqual(record.afterRestart.sdkScope, record.beforeRestart.sdkScope, "SDK scope changed without an explicit lifecycle operation");
      const oldParams = { ...item.scope, tabId: item.tabId, waiterId: item.waiterId };
      record.oldScope = {
        collect: await observed(options => reject(() => browser.client.request("collectPageWait", oldParams, options), expired)),
        cancel: await observed(options => reject(() => browser.client.request("cancelPageWait", oldParams, options), stale)),
        attach: await observed(options => reject(() => browser.client.request("attach", { ...item.scope, tabId: item.childId }, options), stale)),
      };
      if (child) {
        record.oldScope.typedChild = await observed(options => reject(() => child.locator("#state").textContent(options), stale));
        record.oldScope.typedChildBoundary = item.outcome === "idle-restart"
          ? "Already invalidated by public turnEnded before restart; not independent evidence of worker loss."
          : "Original collected handle, tested before explicit beginTurn on its parent client.";
      }
    }
    // Only after every original scope was tested may clients negotiate a new
    // turn. Never overwrite item.scope, which remains the original evidence.
    for (const { browser, item, record } of contexts) {
      record.beginTurn = await observed(() => browser.client.beginTurn()); item.recoveredScope = scopeOf(browser);
      record.recoveredScope = { ...item.recoveredScope };
      assert.equal(item.recoveredScope.session_id, item.scope.session_id);
      assert.ok(item.recoveredScope.control_epoch > item.scope.control_epoch);
      const fresh = record.fresh = { tabs: await observed(() => browser.getTabs()), ownership: await observed(() => ownership(item)) };
      assertRetired(fresh.ownership, item, fresh.tabs);
      fresh.attach = await observed(options => reject(() => browser.client.request("attach", { tabId: item.childId }, options), unowned));
      fresh.collect = await observed(options => reject(() => browser.client.request("collectPageWait", { ...item.recoveredScope, tabId: item.tabId, waiterId: item.waiterId }, options), expired));
      fresh.cancel = await observed(options => browser.client.request("cancelPageWait", { ...item.recoveredScope, tabId: item.tabId, waiterId: item.waiterId }, options));
      assert.deepEqual(fresh.cancel, {});
      fresh.source = await observed(() => readSource(browser.tab(item.tabId), observationDeadline));
      assert.deepEqual(fresh.source, record.sourceBefore);
      const rearmed = await observed(options => browser.tab(item.tabId).expectPage(options));
      fresh.rearmedWaiterId = rearmed.waiterId; assert.notEqual(rearmed.waiterId, item.waiterId);
      await observed(() => rearmed.cancel()); fresh.rearmedCancelled = true;
      fresh.sourceFrames = await observed(() => frames(item.tabId)); fresh.childFrames = await observed(() => frames(item.childId));
      assertDocument(fresh.sourceFrames, item.sourceFrame, "Source"); assertDocument(fresh.childFrames, item.childFrame, "Child");
      fresh.afterProbes = await observed(() => ownership(item)); assertRetired(fresh.afterProbes, item, fresh.tabs);
    }
    // Delivery to a persistent extension page may lag the storage write ACK.
    // Wait only for an incomplete chain, never swallow a malformed transition.
    do {
      detail.storage = await observed(() => persistentEvaluate("__createdPageRecoveryStorage.snapshot()"));
      detail.storageChecks = assertCreatedPageRecoveryStorage({ snapshot: detail.storage, items: group.map(({ item }) => item), allowIncomplete: true });
      if (!detail.storageChecks.complete) await observed(() => new Promise(resolve => setTimeout(resolve, 20)));
    } while (!detail.storageChecks.complete);
    detail.observation.finishedAt = Date.now();
  } catch (error) { failure = error; detail.error = error?.stack ?? String(error); }
  finally {
    if (observerInstalled) {
      try {
        detail.storage = await persistentEvaluate("globalThis.__createdPageRecoveryStorage?.stop() ?? null");
        assert.ok(detail.storage, "Recovery storage observer installation/cleanup could not be confirmed");
        assert.equal(detail.storage.closed, true); assert.equal(detail.storage.listenerPresent, false);
        assert.equal(detail.storage.overflow, false); assert.deepEqual(detail.storage.errors, []);
        if (!failure) detail.storageChecks = assertCreatedPageRecoveryStorage({ snapshot: detail.storage, items: group.map(({ item }) => item) });
      } catch (error) { detail.storageCleanupError = error?.stack ?? String(error); failure ??= error; }
    }
    detail.finishedAt = Date.now();
  }
  if (failure) { failure.createdPageWorkerRestartDetail = detail; throw failure; }
  detail.lifecycleVerified = true;
  return detail;
}
