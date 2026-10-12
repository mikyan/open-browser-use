import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "./test-support/page-waits-fixture.mjs";

const AUX_KEY = "OPEN_BROWSER_USE_AUXILIARY_TABS";
const sourceId = 7, childId = 8;

async function prepared(t, { end = "turnEnded", grouped = false } = {}) {
  const f = await fixture(t), scope = { ...f.params, tabId: sourceId };
  if (!grouped) {
    const source = f.tabs.get(sourceId);
    source.groupId = -1; source.windowId = 3;
    f.windows.set(3, { id: 3, type: "normal", focused: false });
    const session = await f.backend.store.getSession(scope.session_id);
    session.chromeGroupId = null;
    await f.backend.store.save();
    const claim = f.backend.auxiliaryTabs.reserveCreation(scope, { kind: "background-window" });
    await f.backend.auxiliaryTabs.bindCreated(claim, source);
    await f.backend.auxiliaryTabs.commit(claim, { windowId: source.windowId, kind: "background-window",
      control_epoch: scope.control_epoch, check() {}, async validate() {} });
    f.sourceClaim = structuredClone(claim);
  }
  const child = f.tabs.get(childId);
  child.windowId = f.tabs.get(sourceId).windowId;
  if (grouped) child.groupId = 10;
  const ack = await f.backend.armPageWait({ ...scope, timeoutMs: 5000 });
  f.chrome.webNavigation.onCreatedNavigationTarget.emit({ sourceTabId: sourceId, sourceFrameId: 0,
    sourceProcessId: 4, tabId: childId, url: child.url });
  assert.equal((await f.backend.collectPageWait({ ...scope, waiterId: ack.waiterId })).tabId, childId);
  f.childClaim = structuredClone(f.backend.auxiliaryTabs.owner(childId));
  if (!grouped) assert.equal(f.childClaim.kind, "created-page");
  if (end === "turnEnded") await f.backend.turnEnded(scope);
  else if (end === "handoff") await f.backend.finalizeTabs({ ...scope,
    keep: [{ tabId: sourceId, status: "handoff" }, { tabId: childId, status: "handoff" }] });
  f.scope = scope; f.waiterId = ack.waiterId;
  f.nativeBefore = structuredClone([...f.tabs.values()]);
  f.before = f.calls.length;
  return f;
}

function restart(f) {
  // This simulates worker replacement with the same Chrome lifetime/storage.
  // It is not evidence of a real ServiceWorker.stopWorker/startWorker cycle.
  for (const event of f.events) event.clear();
  for (const event of Object.values(f.chrome.webNavigation)) event.clear?.();
  return new f.Backend();
}

async function assertRevoked(f, backend) {
  assert.equal(backend.auxiliaryTabs.entry(childId), undefined, "Restart must finish exact idle created-page cleanup");
  assert.equal(f.session[AUX_KEY].records.some(record => record.tabId === childId), false);
  const next = await backend.getControlState({ session_id: f.scope.session_id });
  const scope = f.fresh(f.scope, next);
  assert.deepEqual(Array.from(await backend.getTabs(scope), tab => tab.id), [sourceId]);
  await assert.rejects(backend.attach({ ...scope, tabId: childId }), /not part of browser session/);
  await assert.rejects(backend.collectPageWait({ ...scope, waiterId: f.waiterId }), /OBU_PAGE_WAIT_EXPIRED/);
  assert.deepEqual(structuredClone(await backend.cancelPageWait({ ...scope, waiterId: f.waiterId })), {});
  assert.deepEqual([...f.tabs.values()], f.nativeBefore, "Restart must preserve original source and child positions/documents");
  assert.equal(backend.auxiliaryTabs.owner(sourceId)?.claimId, f.sourceClaim.claimId);
  assert.equal(backend.auxiliaryTabs.owner(sourceId)?.kind, "background-window");
  assert.equal(f.calls.slice(f.before).some(([method]) => ["remove", "group", "ungroup", "attach", "attach-start"].includes(method)), false);
  await backend.attach(scope);
  const read = await backend.executeCdp({ ...scope, target: { tabId: sourceId }, method: "Runtime.evaluate",
    commandParams: { expression: "document.title", returnByValue: true } });
  assert.equal(read.result.value, "fixture");
  await backend.detach(scope);
  return scope;
}

for (const end of ["turnEnded", "handoff"]) {
  test(`idle ${end} created-page quarantine is cleaned on worker replacement without restoring authority`, async t => {
    const f = await prepared(t, { end });
    assert.equal(f.backend.controlLedger.records.get("task").status, "idle");
    const beforeEpoch = f.backend.controlLedger.records.get("task").epoch;
    const backend = restart(f); await backend.controlReady;
    const scope = await assertRevoked(f, backend);
    assert.ok(scope.control_epoch > beforeEpoch);
    const writes = f.calls.slice(f.before).filter(([method, value]) => method === "session.set" && value[AUX_KEY]);
    assert.ok(writes.some(([, value]) => value[AUX_KEY].records.some(record => record.claimId === f.childClaim.claimId && record.phase === "quarantined")));
    // Explicit new admission is possible only after the old claim is retired.
    await backend.claimUserTab({ ...scope, tabId: childId });
    assert.notEqual(backend.auxiliaryTabs.owner(childId)?.claimId, f.childClaim.claimId);
  });
}

test("active collected created-page still retires while its original background source survives", async t => {
  const f = await prepared(t, { end: null });
  assert.equal(f.backend.controlLedger.records.get("task").status, "active");
  const backend = restart(f); await backend.controlReady;
  await assertRevoked(f, backend);
});

test("idle inherited group membership is not mistaken for worker-bound created-page authority", async t => {
  const f = await prepared(t, { grouped: true });
  assert.equal(f.childClaim, undefined);
  const epoch = f.backend.controlLedger.records.get("task").epoch;
  const backend = restart(f); await backend.controlReady;
  const scope = f.fresh(f.scope, await backend.getControlState({ session_id: "task" }));
  assert.equal(scope.control_epoch, epoch, "Unrelated idle ownership must not enter restart cleanup");
  assert.deepEqual(Array.from(await backend.getTabs(scope), tab => tab.id).sort(), [sourceId, childId]);
  assert.equal(f.calls.slice(f.before).some(([method]) => ["detach", "remove", "group", "ungroup"].includes(method)), false);
  await backend.attach({ ...scope, tabId: childId });
  assert.equal(f.attached.has(childId), true);
  await backend.detach({ ...scope, tabId: childId });
  assert.deepEqual([...f.tabs.values()], f.nativeBefore);
});

for (const failure of ["native detach", "claim deletion storage"]) {
  test(`idle created-page ${failure} failure stays fenced until explicit bootstrap retries exact cleanup`, async t => {
    const f = await prepared(t);
    if (failure === "native detach") f.hooks.detach = async id => {
      if (id === childId) throw new Error("fixture child detach failed");
    };
    else f.hooks.write = async (area, value) => {
      if (area === "session" && value[AUX_KEY] && !value[AUX_KEY].records.some(record => record.tabId === childId))
        throw new Error("fixture claim deletion failed");
    };
    const backend = restart(f); await backend.controlReady;
    const quarantined = backend.auxiliaryTabs.entry(childId);
    assert.equal(quarantined.claimId, f.childClaim.claimId);
    assert.equal(quarantined.phase, "quarantined");
    assert.equal(backend.auxiliaryTabs.owner(childId), undefined);
    assert.equal(backend.controlLedger.records.get("task").status, "closing");
    const closingScope = { ...f.scope, control_epoch: backend.controlLedger.records.get("task").epoch };
    await assert.rejects(backend.getTabs(closingScope), /OBU_CONTROL_ENDING/);
    await assert.rejects(backend.attach({ ...closingScope, tabId: childId }), /OBU_CONTROL_ENDING/);
    await assert.rejects(backend.getControlState({ session_id: "task" }), /fixture (child detach|claim deletion) failed/);
    assert.equal(backend.auxiliaryTabs.entry(childId), quarantined);
    assert.equal(f.session[AUX_KEY].records.find(record => record.tabId === childId).phase, "quarantined");
    delete f.hooks.detach; delete f.hooks.write;
    await backend.getControlState({ session_id: "task" });
    await assertRevoked(f, backend);
  });
}

test("idle created-page cleanup never detaches a surviving foreign attachment", async t => {
  const f = await prepared(t), backend = restart(f);
  const foreign = { session_id: "other", tabId: childId, attachment: {} };
  backend.attachmentOwners.set(childId, foreign); f.attached.add(childId);
  await backend.controlReady;
  await assertRevoked(f, backend);
  assert.equal(backend.attachmentOwners.get(childId), foreign);
  assert.equal(f.attached.has(childId), true);
  assert.equal(f.calls.slice(f.before).some(([method, id]) => method === "detach" && id === childId), false);
});

test("unknown held input blocks idle created-page recovery before any native release", async t => {
  const f = await prepared(t);
  await f.backend.browserLifetime.markInputRisk({ riskId: "held-before-worker-loss", tabId: sourceId });
  f.before = f.calls.length;
  const backend = restart(f); await backend.controlReady;
  assert.equal(backend.auxiliaryTabs.entry(childId).phase, "quarantined");
  assert.equal(backend.auxiliaryTabs.owner(childId), undefined);
  await assert.rejects(backend.getControlState({ session_id: "task" }), /OBU_AUTOMATION_|OBU_INPUT_RELEASE_UNCONFIRMED/);
  assert.equal(f.calls.slice(f.before).some(([method]) => ["detach", "remove", "group", "ungroup"].includes(method)), false);
  assert.deepEqual([...f.tabs.values()], f.nativeBefore);
});

test("failed initial quarantine persistence cannot admit or clean idle created-page authority", async t => {
  const f = await prepared(t);
  f.hooks.write = async (area, value) => {
    if (area === "session" && value[AUX_KEY]?.records.some(record => record.tabId === childId && record.phase === "quarantined"))
      throw new Error("fixture quarantine storage failed");
  };
  const backend = restart(f);
  await assert.rejects(backend.controlReady, /fixture quarantine storage failed/);
  assert.equal(backend.auxiliaryTabs.owner(childId), undefined);
  await assert.rejects(backend.getControlState({ session_id: "task" }), /fixture quarantine storage failed/);
  assert.equal(f.calls.slice(f.before).some(([method]) => ["detach", "remove", "group", "ungroup"].includes(method)), false);
});

async function evictIdleLedger(f) {
  for (let index = 0; index < 64; index++) await f.backend.getControlState({ session_id: `capacity-${index}` });
  assert.equal(f.backend.controlLedger.records.has("task"), false);
  assert.equal(f.backend.auxiliaryTabs.owner(childId).claimId, f.childClaim.claimId);
  f.before = f.calls.length;
}

test("idle ledger eviction cannot orphan a worker-bound created-page quarantine", async t => {
  const f = await prepared(t); await evictIdleLedger(f);
  const backend = restart(f); await backend.controlReady;
  assert.equal(backend.controlLedger.records.has("task"), false, "Cleanup must not create or evict control ledger entries");
  assert.equal(backend.controlLedger.records.size, 64);
  await assertRevoked(f, backend);
});

test("orphan created-page cleanup failure is retried by its exact session bootstrap", async t => {
  const f = await prepared(t); await evictIdleLedger(f);
  f.hooks.detach = async id => { if (id === childId) throw new Error("fixture orphan detach failed"); };
  const backend = restart(f); await backend.controlReady;
  assert.equal(backend.controlLedger.records.has("task"), false);
  assert.equal(backend.auxiliaryTabs.entry(childId).claimId, f.childClaim.claimId);
  assert.equal(backend.auxiliaryTabs.owner(childId), undefined);
  await assert.rejects(backend.getControlState({ session_id: "task" }), /fixture orphan detach failed/);
  assert.equal(backend.controlLedger.records.has("task"), false);
  delete f.hooks.detach;
  await backend.getControlState({ session_id: "task" });
  await assertRevoked(f, backend);
});
