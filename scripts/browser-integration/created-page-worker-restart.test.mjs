import test from "node:test";
import assert from "node:assert/strict";
import { createContext, runInContext } from "node:vm";
import { installCreatedPageRecoveryStorageObserver, assertCreatedPageRecoveryStorage, checkCreatedPageWorkerRestart } from "./created-page-worker-restart.mjs";

const key = "OPEN_BROWSER_USE_AUXILIARY_TABS";
const copy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const emitter = () => {
  const listeners = new Set();
  return { addListener: listener => listeners.add(listener), removeListener: listener => listeners.delete(listener), hasListener: listener => listeners.has(listener),
    emit: (...args) => { for (const listener of listeners) listener(...args); }, get size() { return listeners.size; } };
};
const claim = index => ({ tabId: index + 20, claimId: `claim-${index}`, session_id: `session-${index}`, turn_id: `turn-${index}`, control_epoch: index + 1,
  windowId: index + 100, kind: "created-page", origin: "user", phase: "committed" });
const stored = records => ({ version: 4, incarnation: "original-browser-incarnation", records: copy(records) });
function storageFixture(records = [claim(0)]) {
  let value = stored(records);
  const onChanged = emitter(), calls = [];
  const chrome = { storage: { onChanged, session: { get: async requested => { calls.push(requested); return copy({ [key]: value }); } } } };
  const context = createContext({ chrome, Date, TextEncoder });
  const evaluate = async expression => copy(await runInContext(expression, context));
  return { chrome, context, evaluate, calls, get value() { return copy(value); },
    change(next, area = "session", changedKey = key) { const old = value; if (area === "session" && changedKey === key) value = next; onChanged.emit({ [changedKey]: { oldValue: old, newValue: next } }, area); },
    install: options => evaluate(`(${installCreatedPageRecoveryStorageObserver.toString()})(chrome,globalThis,${JSON.stringify({ tabIds: records.map(record => record.tabId), ...options })})`),
    snapshot: () => copy(context.__createdPageRecoveryStorage.snapshot()), stop: () => copy(context.__createdPageRecoveryStorage.stop()),
  };
}
const itemsFor = records => records.map(record => ({ childId: record.tabId, scope: { session_id: record.session_id, turn_id: record.turn_id, control_epoch: record.control_epoch }, adopted: { owner: record } }));

test("serialized persistent observer records original old/new transitions and removes only its listener", async () => {
  const original = [claim(0), claim(1), claim(2)], fixture = storageFixture(original), unrelated = () => {};
  fixture.chrome.storage.onChanged.addListener(unrelated);
  await fixture.install(); assert.deepEqual(fixture.calls, [key]);
  fixture.change(stored([]), "local"); fixture.change(stored([]), "session", "OTHER_KEY");
  const quarantined = original.map(record => ({ ...record, phase: "quarantined" })); fixture.change(stored(quarantined));
  // Recovery may remove entries one at a time and write the full shared ledger.
  fixture.change(stored(quarantined.slice(1))); fixture.change(stored(quarantined.slice(2))); fixture.change(stored([]));
  const snapshot = fixture.stop(), result = assertCreatedPageRecoveryStorage({ snapshot, items: itemsFor(original) });
  assert.equal(snapshot.closed, true); assert.equal(snapshot.listenerPresent, false); assert.equal(fixture.chrome.storage.onChanged.size, 1);
  assert.deepEqual(result.checks.map(check => check.removalSequence), [2, 3, 4]);
  assert.equal(snapshot.records.length, 4); assert.equal(snapshot.records[0].oldValue.records[0].phase, "committed");
  snapshot.records[0].oldValue.records[0].phase = "tampered";
  assert.equal(fixture.snapshot().records[0].oldValue.records[0].phase, "committed");
  const before = fixture.snapshot(); fixture.change(stored(original)); assert.deepEqual(fixture.snapshot(), before);
  assert.deepEqual(fixture.stop(), fixture.stop());
});

test("storage verifier rejects deletion without quarantine, lingering idle quarantine, claim substitution and resurrection", async () => {
  for (const variant of ["skip-quarantine", "idle-leak", "replace-claim", "resurrection", "wrong-incarnation"]) {
    const original = [claim(0), claim(1), claim(2)], fixture = storageFixture(original); await fixture.install();
    const quarantined = original.map(record => ({ ...record, phase: "quarantined" }));
    if (variant === "replace-claim") quarantined[2].claimId = "replacement";
    if (variant !== "skip-quarantine") fixture.change(stored(quarantined));
    fixture.change(variant === "wrong-incarnation" ? { ...stored([]), incarnation: "different-browser" } : stored(variant === "idle-leak" ? quarantined.slice(2) : []));
    if (variant === "resurrection") fixture.change(stored(original));
    assert.throws(() => assertCreatedPageRecoveryStorage({ snapshot: fixture.stop(), items: itemsFor(original) }), undefined, variant);
  }
});

test("observer overflow is explicit for records and bytes; failed installation removes its listener", async () => {
  for (const options of [{ maxRecords: 1 }, { maxBytes: 1 }]) {
    const fixture = storageFixture(); await fixture.install(options);
    fixture.change(stored([{ ...claim(0), phase: "quarantined" }])); fixture.change(stored([]));
    const snapshot = fixture.stop(); assert.equal(snapshot.overflow, true); assert.equal(snapshot.listenerPresent, false);
    assert.throws(() => assertCreatedPageRecoveryStorage({ snapshot, items: itemsFor([claim(0)]) }));
  }
  const fixture = storageFixture(), error = Error("original read failure");
  fixture.chrome.storage.session.get = () => Promise.reject(error);
  await assert.rejects(fixture.install(), value => value === error);
  assert.equal(fixture.chrome.storage.onChanged.size, 0); assert.match(fixture.snapshot().errors[0], /original read failure/);
});

test("observer records malformed event errors instead of throwing into Chrome's dispatcher", async () => {
  const fixture = storageFixture(); await fixture.install();
  assert.doesNotThrow(() => fixture.chrome.storage.onChanged.emit({ [key]: { newValue: null } }, "session"));
  assert.equal(fixture.stop().errors.length, 1);
});

test("incomplete delivery may wait, but malformed or missing event history cannot masquerade as delivery lag", async () => {
  const fixture = storageFixture(), items = itemsFor([claim(0)]); await fixture.install();
  const initial = assertCreatedPageRecoveryStorage({ snapshot: fixture.snapshot(), items, allowIncomplete: true });
  assert.equal(initial.complete, false); assert.equal(initial.pending[0].phase, "committed");
  fixture.change(stored([{ ...claim(0), phase: "quarantined" }]));
  assert.equal(assertCreatedPageRecoveryStorage({ snapshot: fixture.snapshot(), items, allowIncomplete: true }).pending[0].phase, "quarantined");
  fixture.change(stored([]));
  assert.equal(assertCreatedPageRecoveryStorage({ snapshot: fixture.snapshot(), items, allowIncomplete: true }).complete, true);
  const gap = fixture.snapshot(); gap.records.splice(0, 1);
  assert.throws(() => assertCreatedPageRecoveryStorage({ snapshot: gap, items, allowIncomplete: true }));
  fixture.stop();
});

function workflowFixture(options = {}) {
  const records = [claim(0), claim(1), claim(2)], storage = storageFixture(records), calls = [], waiters = new Map(), controls = new Map();
  const claims = new Map(records.map(record => [record.tabId, copy(record)])), nativeTabs = new Map(), nativeFrames = new Map(), pageWaits = new Map(), attached = new Set();
  let restarted = false;
  const stateBySource = new Map();
  const group = ["collect-restart", "matched-restart", "idle-restart"].map((outcome, index) => {
    const childClaim = records[index], tabId = index + 10, childId = childClaim.tabId, sourceURL = `http://fixture/source/${index}`, childURL = "http://fixture/child";
    const scope = { session_id: childClaim.session_id, turn_id: childClaim.turn_id, control_epoch: childClaim.control_epoch };
    const sourceClaim = { ...childClaim, tabId, claimId: `source-${index}`, kind: "background-window", origin: "agent" };
    claims.set(tabId, sourceClaim); controls.set(scope.session_id, { epoch: scope.control_epoch, status: "active" });
    const sourceFrame = { frameId: 0, url: sourceURL, documentId: `source-document-${index}` }, childFrame = { frameId: 0, url: childURL, documentId: `child-document-${index}` };
    nativeFrames.set(tabId, [copy(sourceFrame)]); nativeFrames.set(childId, [copy(childFrame)]);
    nativeTabs.set(childId, { id: childId, url: childURL, windowId: childClaim.windowId, groupId: -1, pinned: false });
    const sourceState = { key: `key-${index}`, documentToken: `source-token-${index}`, clicks: [{ trusted: true }], frameAdds: [] };
    stateBySource.set(tabId, sourceState);
    const item = { variant: "root", outcome, key: `key-${index}`, tabId, childId, scope, waiterId: `waiter-${index}`, sourceURL, childURL,
      sourceClaim, sourceFrame, childFrame, rootBefore: copy(sourceState), createdTab: { windowId: childClaim.windowId }, adopted: { owner: childClaim } };
    pageWaits.set(item.waiterId, { state: "matched", invalid: false, delivered: false, deadlineAt: performance.now() + 20000, result: { tabId: childId } });
    const client = {
      sessionId: scope.session_id, turnId: scope.turn_id, controlEpoch: scope.control_epoch,
      async request(method, params = {}) {
        calls.push({ operation: method, params: copy(params), index, restarted });
        if (options.acceptOld && !item.recoveredScope && method === "attach") return {};
        if (method === "collectPageWait") throw Error("OBU_PAGE_WAIT_EXPIRED");
        if (params.control_epoch !== undefined && params.control_epoch === scope.control_epoch) throw Error("OBU_STALE_CONTROL_EPOCH");
        if (method === "attach") throw Error("Tab is not part of browser session");
        if (method === "cancelPageWait") return {};
        throw Error(`unexpected request ${method}`);
      },
      async turnEnded() {
        calls.push({ operation: "turnEnded", index }); const record = controls.get(scope.session_id); record.epoch += 10; record.status = "idle";
        client.controlEpoch = record.epoch; client.turnId = `ended-${index}`; attached.delete(childId); pageWaits.delete(item.waiterId);
        return { controlEpoch: record.epoch, endedTurnId: scope.turn_id };
      },
      async beginTurn() {
        calls.push({ operation: "beginTurn", index }); client.controlEpoch = controls.get(scope.session_id).epoch; client.turnId = `fresh-${index}`;
        return { controlEpoch: client.controlEpoch };
      },
    };
    const source = { id: tabId,
      locator: () => ({ async textContent() {
        calls.push({ operation: "readSource", index, restarted, status: controls.get(scope.session_id).status });
        if (!restarted && controls.get(scope.session_id).status === "idle") throw Error("Test reactivated idle source before restart");
        controls.get(scope.session_id).status = "active"; return JSON.stringify(sourceState);
      } }),
      async expectPage() { calls.push({ operation: "rearm", index }); return { waiterId: `rearmed-${index}`, cancel: async () => { calls.push({ operation: "cancelRearm", index }); } }; },
    };
    const child = { id: childId, locator: () => ({ async textContent() {
      calls.push({ operation: "readChild", index, restarted });
      if (restarted || client.controlEpoch !== scope.control_epoch) throw Error("OBU_STALE_CONTROL_EPOCH");
      attached.add(childId); return JSON.stringify({ documentNonce: `nonce-${index}`, documentToken: `child-token-${index}`, clicks: [] });
    } }) };
    const waiter = { waiterId: item.waiterId, async result() {
      calls.push({ operation: "collectTyped", index }); pageWaits.get(item.waiterId).delivered = true; return child;
    } };
    waiters.set(item.key, waiter);
    const browser = { client, tab: id => { assert.equal(id, tabId); return source; }, async getTabs() {
      calls.push({ operation: "getTabs", index }); controls.get(scope.session_id).status = "active";
      return options.inventoryLeak ? [{ id: tabId }, { id: childId }] : [{ id: tabId }];
    } };
    return { item, browser, tab: source, target: source };
  });
  const backend = { controlReady: Promise.resolve(), controlLedger: { records: controls }, pageWaits: { records: pageWaits, now: () => performance.now() },
    auxiliaryTabs: { owner: tabId => claims.get(tabId)?.phase === "committed" ? claims.get(tabId) : null } };
  const context = createContext({ __integrationBackend: backend });
  const detail = {}, args = { group, waiters, deadline: performance.now() + 20000, detail,
    evaluate: async expression => copy(await runInContext(expression, context)), persistentEvaluate: storage.evaluate,
    frames: async tabId => copy(nativeFrames.get(tabId)),
    ownership: async item => copy({ tab: nativeTabs.get(item.childId), entry: claims.get(item.childId) ?? null,
      owner: backend.auxiliaryTabs.owner(item.childId), stored: storage.value.records.filter(record => record.tabId === item.childId),
      targets: [...attached].map(tabId => ({ tabId, attached: true })) }),
    readSource: async target => JSON.parse(await target.locator("#state").textContent()),
    onBeforeRestart: async () => { calls.push({ operation: "beforeRestart" }); if (options.beforeFailure) throw options.beforeFailure; },
    onAfterRestart: async () => { calls.push({ operation: "afterRestart" }); if (options.afterFailure) throw options.afterFailure; },
    restartWorker: async () => {
      calls.push({ operation: "restart" }); assert.equal(controls.get(records[2].session_id).status, "idle");
      restarted = true; attached.clear(); pageWaits.clear();
      for (const control of controls.values()) if (control.status === "active") { control.epoch += 10; control.status = "idle"; }
      const quarantined = records.map(record => ({ ...record, phase: "quarantined" }));
      if (!options.skipQuarantine) storage.change(stored(quarantined));
      for (const record of records) claims.delete(record.tabId);
      if (options.idleLeak) claims.set(records[2].tabId, quarantined[2]);
      storage.change(stored(options.idleLeak ? [quarantined[2]] : []));
      if (options.documentChanged) nativeFrames.get(records[1].tabId)[0].documentId = "replacement-document";
      return { oldTarget: "old-worker", newTarget: "new-worker", sameHost: true };
    },
  };
  return { args, detail, group, storage, calls, nativeFrames, controls };
}

test("three-state workflow uses one real-restart seam, probes every old scope before refreshing, and preserves original evidence", async () => {
  const fixture = workflowFixture(), originalScopes = fixture.group.map(({ item }) => copy(item.scope));
  await checkCreatedPageWorkerRestart(fixture.args);
  assert.equal(fixture.detail.lifecycleVerified, true); assert.equal(fixture.storage.chrome.storage.onChanged.size, 0);
  assert.deepEqual(fixture.group.map(({ item }) => item.scope), originalScopes);
  assert.ok(fixture.group.every(({ item }) => item.ok === undefined && item.recoveredScope.control_epoch > item.scope.control_epoch));
  assert.deepEqual(fixture.calls.filter(call => call.operation === "collectTyped").map(call => call.index), [0, 2]);
  const restart = fixture.calls.findIndex(call => call.operation === "restart"), begin = fixture.calls.findIndex(call => call.operation === "beginTurn");
  assert.equal(fixture.calls.filter(call => call.operation === "restart").length, 1);
  assert.equal(fixture.calls.slice(restart, begin).filter(call => call.operation === "attach").length, 3);
  assert.equal(fixture.calls.slice(restart, begin).filter(call => call.operation === "cancelPageWait").length, 3);
  assert.deepEqual(fixture.calls.filter(call => call.operation === "rearm").map(call => call.index), [0, 1, 2]);
  assert.match(fixture.detail.cases[2].oldScope.typedChildBoundary, /Already invalidated/);
  assert.equal(fixture.detail.storageChecks.checks.length, 3);
});

test("idle quarantine leakage fails before fresh admission and still stops the persistent observer", async () => {
  const fixture = workflowFixture({ idleLeak: true });
  await assert.rejects(checkCreatedPageWorkerRestart(fixture.args), /Recovery retained a reverse lock/);
  assert.equal(fixture.detail.lifecycleVerified, false); assert.equal(fixture.storage.chrome.storage.onChanged.size, 0);
  assert.equal(fixture.calls.some(call => call.operation === "beginTurn"), false);
  assert.equal(fixture.detail.storage.closed, true);
});

test("replaced child document, inherited inventory and missing quarantine never count as successful recovery", async () => {
  for (const options of [{ documentChanged: true }, { inventoryLeak: true }, { skipQuarantine: true }, { acceptOld: true }]) {
    const fixture = workflowFixture(options);
    await assert.rejects(checkCreatedPageWorkerRestart(fixture.args));
    assert.equal(fixture.detail.lifecycleVerified, false); assert.equal(fixture.storage.chrome.storage.onChanged.size, 0);
    assert.ok(fixture.group.every(({ item }) => item.ok === undefined));
  }
});

test("pre/post restart callback failures remain the original failure and always retire storage observation", async () => {
  for (const location of ["beforeFailure", "afterFailure"]) {
    const error = Error(location), fixture = workflowFixture({ [location]: error });
    await assert.rejects(checkCreatedPageWorkerRestart(fixture.args), value => value === error);
    assert.equal(fixture.detail.lifecycleVerified, false); assert.equal(fixture.storage.chrome.storage.onChanged.size, 0);
    assert.equal(fixture.detail.storage.listenerPresent, false);
  }
});

test("an expired original action budget cannot install observers, collect, or restart", async () => {
  const fixture = workflowFixture(); fixture.args.deadline = performance.now() - 1;
  await assert.rejects(checkCreatedPageWorkerRestart(fixture.args), /Original created page deadline expired/);
  assert.deepEqual(fixture.calls, []); assert.equal(fixture.storage.chrome.storage.onChanged.size, 0);
  assert.equal(fixture.detail.lifecycleVerified, false);
});

test("a late restart ACK fails the observation budget and starts no post-restart request", async t => {
  const fixture = workflowFixture(), now = performance.now.bind(performance); let advance = 0;
  t.mock.method(performance, "now", () => now() + advance);
  fixture.args.restartWorker = async () => { fixture.calls.push({ operation: "lateRestart" }); advance = 31000; return { stopped: true, started: true }; };
  await assert.rejects(checkCreatedPageWorkerRestart(fixture.args), /deadline expired at ACK/);
  assert.equal(fixture.calls.some(call => call.operation === "afterRestart"), false);
  assert.equal(fixture.detail.lifecycleVerified, false); assert.equal(fixture.storage.chrome.storage.onChanged.size, 0);
});
