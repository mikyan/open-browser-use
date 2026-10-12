import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "./test-support/page-waits-fixture.mjs";

const AUX_KEY = "OPEN_BROWSER_USE_AUXILIARY_TABS";
const sourceId = 7, childId = 8;
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function until(check, label) {
  for (let count = 0; count < 100; count++) { if (check()) return; await tick(); }
  throw new Error(`Fixture did not reach ${label}`);
}

async function prepared(t, { collected = false } = {}) {
  const f = await fixture(t), scope = { ...f.params, tabId: sourceId };
  let adoptions = 0;
  const adopt = f.backend.adoptCreatedPage.bind(f.backend);
  f.backend.adoptCreatedPage = (...args) => { adoptions++; return adopt(...args); };
  const ack = await f.backend.armPageWait({ ...scope, timeoutMs: 5000 });
  const record = f.backend.pageWaits.records.get(ack.waiterId);
  f.chrome.webNavigation.onCreatedNavigationTarget.emit({ sourceTabId: sourceId, sourceFrameId: 0,
    sourceProcessId: 4, tabId: childId, url: f.tabs.get(childId).url });
  await record.completion.promise;
  assert.equal(record.state, "matched");
  assert.ok(f.backend.pageWaits.now() < record.deadlineAt);
  const claim = f.backend.auxiliaryTabs.owner(childId);
  assert.equal(claim.kind, "created-page");
  if (collected) {
    assert.equal((await f.backend.collectPageWait({ ...scope, waiterId: ack.waiterId })).tabId, childId);
    await f.backend.attach({ ...scope, tabId: childId });
  }
  return Object.assign(f, { scope, record, claim, waiterId: ack.waiterId,
    before: f.calls.length, nativeBefore: structuredClone([...f.tabs.values()]), adoptions: () => adoptions });
}

function unchanged(f) {
  assert.equal(f.adoptions(), 1, "Recovery never replays candidate adoption");
  assert.deepEqual([...f.tabs.values()], f.nativeBefore, "Host recovery preserves native documents and positions");
  assert.equal(f.calls.slice(f.before).some(([method]) => ["remove", "group", "ungroup", "attach", "attach-start"].includes(method)), false);
}

async function assertMatchedRetired(f, fresh) {
  assert.equal(f.backend.auxiliaryTabs.entry(childId), undefined);
  assert.equal(f.session[AUX_KEY].records.some(record => record.tabId === childId), false);
  assert.equal(f.record.cleaned, true);
  assert.equal(f.backend.pageWaits.byTab.has(sourceId), false);
  assert.ok(fresh.controlEpoch > f.scope.control_epoch);
  await assert.rejects(f.backend.getTabs(f.scope), /OBU_STALE_CONTROL_EPOCH/);
  const scope = f.fresh(f.scope, fresh);
  assert.deepEqual(Array.from(await f.backend.getTabs(scope), tab => tab.id), [sourceId]);
  await assert.rejects(f.backend.attach({ ...scope, tabId: childId }), /not part of browser session/);
  await assert.rejects(f.backend.collectPageWait({ ...scope, waiterId: f.waiterId }), /OBU_PAGE_WAIT_EXPIRED/);
  assert.deepEqual(structuredClone(await f.backend.cancelPageWait({ ...scope, waiterId: f.waiterId })), {});
  unchanged(f);
  const next = await f.backend.armPageWait({ ...scope, timeoutMs: 1000 });
  await f.backend.cancelPageWait({ ...scope, waiterId: next.waiterId });
}

test("native host loss revokes a matched undelivered child before its original deadline", async t => {
  // The real backend is exercised against simulated Chrome callbacks. This
  // does not claim to terminate a real native host process or its SDK sockets.
  const f = await prepared(t);
  const recovery = f.backend.nativeDisconnected();
  assert.equal(f.backend.nativeDisconnected(), recovery);
  assert.equal(f.record.invalid, true, "The old waiter is invalid before the first cleanup await");
  await assert.rejects(f.backend.getTabs(f.scope), /OBU_NATIVE_RECOVERY_PENDING/);
  await recovery;
  assert.equal(f.backend.nativeRecovery, null);
  await assertMatchedRetired(f, await f.backend.getControlState({ session_id: "task" }));
});

test("native host loss retains a delivered child's membership but retires its old control and attachment", async t => {
  const f = await prepared(t, { collected: true });
  assert.equal(f.attached.has(childId), true);
  await f.backend.nativeDisconnected();
  assert.equal(f.attached.has(childId), false);
  assert.equal(f.backend.auxiliaryTabs.owner(childId), f.claim);
  assert.equal(f.claim.phase, "committed");
  await assert.rejects(f.backend.getTabs(f.scope), /OBU_STALE_CONTROL_EPOCH/);
  const fresh = await f.backend.getControlState({ session_id: "task" });
  assert.ok(fresh.controlEpoch > f.scope.control_epoch);
  const scope = f.fresh(f.scope, fresh);
  assert.deepEqual(Array.from(await f.backend.getTabs(scope), tab => tab.id).sort(), [sourceId, childId]);
  await assert.rejects(f.backend.collectPageWait({ ...scope, waiterId: f.waiterId }), /OBU_PAGE_WAIT_EXPIRED/);
  unchanged(f);
  await f.backend.attach({ ...scope, tabId: childId });
  assert.equal(f.attached.has(childId), true);
  await f.backend.detach({ ...scope, tabId: childId });
});

test("native recovery waits for the original child cleanup without duplicating pending deletion", async t => {
  const f = await prepared(t), gate = f.gate();
  let deletionCalls = 0;
  f.hooks.write = async (area, value) => {
    if (area === "session" && value[AUX_KEY] && !value[AUX_KEY].records.some(record => record.tabId === childId)) {
      deletionCalls++;
      await gate.promise;
    }
  };
  const recovery = f.backend.nativeDisconnected();
  await until(() => deletionCalls === 1, "original child deletion");
  assert.equal(f.backend.nativeDisconnected(), recovery);
  const bootstrap = f.backend.getControlState({ session_id: "task" });
  let acknowledged = false; bootstrap.then(() => { acknowledged = true; });
  await tick();
  assert.equal(acknowledged, false);
  assert.equal(deletionCalls, 1);
  assert.equal(f.record.cleanupAttempts, 1);
  assert.equal(f.backend.auxiliaryTabs.owner(childId), undefined);
  gate.resolve(); await recovery;
  await assertMatchedRetired(f, await bootstrap);
  assert.equal(deletionCalls, 1);
});

for (const failure of ["native detach", "claim deletion storage"]) {
  test(`explicit native recovery retries settled matched-child ${failure} failure`, async t => {
    const f = await prepared(t);
    if (failure === "native detach") f.hooks.detach = async id => {
      if (id === childId) throw new Error("fixture child detach failed");
    };
    else f.hooks.write = async (area, value) => {
      if (area === "session" && value[AUX_KEY] && !value[AUX_KEY].records.some(record => record.tabId === childId))
        throw new Error("fixture claim deletion failed");
    };
    try {
      await assert.rejects(f.backend.nativeDisconnected(), /fixture (child detach|claim deletion) failed/);
      assert.equal(f.backend.auxiliaryTabs.entry(childId), f.claim);
      assert.equal(f.backend.auxiliaryTabs.owner(childId), undefined);
      assert.equal(f.claim.phase, "quarantined");
      assert.equal(f.record.cleanupSettled, true);
      assert.ok(f.record.cleanupError);
      assert.equal(f.backend.pageWaits.byTab.get(sourceId), f.record);
      assert.equal(f.record.cleanupAttempts, 1);
      await assert.rejects(f.backend.getTabs(f.scope), /OBU_NATIVE_RECOVERY_FAILED/);
      // A repeated disconnect signal is not authorization to retry cleanup.
      await assert.rejects(f.backend.nativeDisconnected(), /fixture (child detach|claim deletion) failed/);
      assert.equal(f.record.cleanupAttempts, 1);
      delete f.hooks.detach; delete f.hooks.write;
      const fresh = await f.backend.getControlState({ session_id: "task" });
      assert.equal(f.record.cleanupAttempts, 2);
      assert.equal(f.backend.nativeRecovery, null);
      await assertMatchedRetired(f, fresh);
    } finally {
      delete f.hooks.detach; delete f.hooks.write;
      // Restore fixture-only resources even when this is run against old code.
      await f.backend.pageWaits.retryFailedCleanup();
    }
  });
}

test("each explicit failed recovery keeps its new cleanup error and original child quarantine", async t => {
  const f = await prepared(t);
  let failDeletion = true;
  f.hooks.write = async (area, value) => {
    if (failDeletion && area === "session" && value[AUX_KEY] && !value[AUX_KEY].records.some(record => record.tabId === childId))
      throw new Error(`fixture deletion attempt ${f.record.cleanupAttempts}`);
  };
  try {
    await assert.rejects(f.backend.nativeDisconnected(), /fixture deletion attempt 1/);
    await assert.rejects(f.backend.getControlState({ session_id: "task" }), /fixture deletion attempt 2/);
    assert.equal(f.record.cleanupAttempts, 2);
    assert.match(f.record.cleanupError.message, /fixture deletion attempt 2/);
    assert.equal(f.backend.auxiliaryTabs.entry(childId), f.claim);
    assert.equal(f.claim.phase, "quarantined");
    assert.equal(f.backend.auxiliaryTabs.owner(childId), undefined);
    await assert.rejects(f.backend.getTabs(f.scope), /OBU_NATIVE_RECOVERY_FAILED/);
    failDeletion = false;
    const fresh = await f.backend.getControlState({ session_id: "task" });
    assert.equal(f.record.cleanupAttempts, 3);
    await assertMatchedRetired(f, fresh);
  } finally {
    failDeletion = false;
    await f.backend.pageWaits.retryFailedCleanup();
  }
});

test("overlapping explicit bootstraps share the actual retry without duplicating pending child cleanup", async t => {
  const f = await prepared(t), gate = f.gate();
  let failDeletion = true, deletions = 0;
  f.hooks.write = async (area, value) => {
    if (area !== "session" || !value[AUX_KEY] || value[AUX_KEY].records.some(record => record.tabId === childId)) return;
    if (failDeletion) throw new Error("fixture first deletion failed");
    deletions++; await gate.promise;
  };
  try {
    await assert.rejects(f.backend.nativeDisconnected(), /fixture first deletion failed/);
    failDeletion = false;
    const first = f.backend.getControlState({ session_id: "task" });
    first.catch(() => {});
    await until(() => deletions === 1, "retried child deletion");
    const retry = f.backend.nativeRecovery.promise;
    const second = f.backend.getControlState({ session_id: "task" });
    second.catch(() => {});
    let acknowledgements = 0;
    first.then(() => acknowledgements++, () => {}); second.then(() => acknowledgements++, () => {});
    await tick();
    assert.equal(f.backend.nativeDisconnected(), retry);
    assert.equal(f.record.cleanupAttempts, 2);
    assert.equal(deletions, 1);
    assert.equal(acknowledgements, 0);
    assert.equal(f.backend.auxiliaryTabs.owner(childId), undefined);
    gate.resolve();
    const [fresh, other] = await Promise.all([first, second]);
    assert.deepEqual(fresh, other);
    assert.equal(deletions, 1);
    await assertMatchedRetired(f, fresh);
  } finally {
    failDeletion = false; gate.resolve();
    await f.backend.pageWaits.retryFailedCleanup();
  }
});
