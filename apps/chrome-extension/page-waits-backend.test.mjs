import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "./test-support/page-waits-fixture.mjs";
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function until(check, label) {
  for (let attempt = 0; attempt < 100; attempt++) { if (check()) return; await tick(); }
  throw new Error(`Fixture did not reach ${label}`);
}

const sourceParams = f => ({ ...f.params, tabId: 7 });
const created = (f, tabId = 8, sourceFrameId = 0) => f.chrome.webNavigation.onCreatedNavigationTarget.emit({
  sourceTabId: 7, sourceFrameId, sourceProcessId: 4, tabId, url: f.tabs.get(tabId).url, timeStamp: 1
});

test("Pause drains an unbound foreign-source setup without attaching or detaching its requested tab", { timeout: 3000 }, async t => {
  const f = await fixture(t), bootstrap = f.gate(), originalReady = f.backend.controlReady;
  f.backend.controlReady = bootstrap.promise.then(() => originalReady);
  const armed = f.backend.armPageWait({ ...f.params, tabId: 8, timeoutMs: 2000 });
  armed.catch(() => {});
  const record = [...f.backend.pageWaits.records.values()][0];
  await tick();
  const before = f.backend.globalControlSnapshot();
  assert.equal(record.scope, undefined); assert.ok(record.pending.size > 0);
  let pauseSettled = false;
  const paused = f.backend.pauseAutomation();
  const pauseObserved = paused.then(() => { pauseSettled = true; }, error => { pauseSettled = true; throw error; });
  pauseObserved.catch(() => {});
  t.after(() => Promise.allSettled([armed, paused, pauseObserved]));
  await assert.rejects(armed, /OBU_AUTOMATION_PAUSED/); await tick();
  assert.equal(pauseSettled, false); assert.notEqual(record.cleaned, true); assert.ok(record.pending.size > 0);
  bootstrap.resolve(); await pauseObserved;
  assert.equal(record.cleaned, true); assert.equal(record.pending.size, 0);
  assert.equal(before.tabIds.has(8), false);
  assert.equal(f.calls.some(([method, tabId]) => tabId === 8 && ["attach-start", "attach", "detach"].includes(method)), false);
  assert.ok(f.tabs.has(8));
  assert.equal(f.backend.auxiliaryTabs.entry(8), undefined);
  assert.deepEqual(f.backend.pageWaits.controlSnapshot().pending, []);
});

test("page wait readiness adopts an ungrouped native child without losing its grouped source", { timeout: 5000 }, async t => {
  const f = await fixture(t), scope = sourceParams(f);
  assert.equal((await f.backend.getInfo()).metadata.pageWaitVersion, 1);
  const ack = await f.backend.armPageWait({ ...scope, timeoutMs: 2000 });
  assert.ok(ack.remainingMs > 0 && ack.remainingMs <= 2000);
  created(f);
  const result = await f.backend.collectPageWait({ ...scope, waiterId: ack.waiterId });
  assert.equal(result.tabId, 8);
  assert.equal(f.backend.auxiliaryTabs.owner(8).kind, "created-page");
  const owned = await f.backend.getTabs(scope);
  assert.deepEqual(Array.from(owned, tab => tab.id).sort(), [7, 8]);
  assert.equal(f.tabs.get(8).windowId, 2);
  await f.backend.claimUserTab({ ...scope, tabId: 8 });
  assert.equal(f.backend.auxiliaryTabs.owner(8).kind, "created-page");
  assert.equal(f.calls.some(([method]) => ["group", "ungroup", "remove"].includes(method)), false);
  await f.backend.finalizeTabs({ ...scope, keep: [] });
  assert.ok(f.tabs.has(8), "Native child is preserved on task finalization");
  assert.equal(f.backend.auxiliaryTabs.owner(8), undefined);
});

test("inherited native group membership is validated without an auxiliary claim or page move", { timeout: 5000 }, async t => {
  const f = await fixture(t), scope = sourceParams(f);
  f.tabs.set(11, { id: 11, groupId: 10, windowId: 1, url: "https://fixture.test/child" });
  const ack = await f.backend.armPageWait({ ...scope, timeoutMs: 2000 }); created(f, 11);
  assert.equal((await f.backend.collectPageWait({ ...scope, waiterId: ack.waiterId })).tabId, 11);
  assert.equal(f.backend.auxiliaryTabs.entry(11), undefined);
  assert.equal(f.calls.some(([method]) => ["group", "ungroup", "remove"].includes(method)), false);
});

test("cancelling a matched child retires only the new admission and drains without self-deadlock", { timeout: 5000 }, async t => {
  const f = await fixture(t), scope = sourceParams(f);
  const ack = await f.backend.armPageWait({ ...scope, timeoutMs: 2000 }); created(f);
  await until(() => f.backend.pageWaits.records.get(ack.waiterId)?.state === "matched", "matched native child");
  await f.backend.cancelPageWait({ ...scope, waiterId: ack.waiterId });
  assert.equal(f.backend.auxiliaryTabs.entry(8), undefined);
  assert.ok(f.tabs.has(8));
  assert.equal(f.calls.some(([method]) => ["group", "ungroup", "remove"].includes(method)), false);
  await assert.rejects(f.backend.collectPageWait({ ...scope, waiterId: ack.waiterId }), /OBU_PAGE_WAIT_EXPIRED/);
});

test("native child competing ownership is never overridden", { timeout: 5000 }, async t => {
  const f = await fixture(t), scope = sourceParams(f);
  await f.backend.claimUserTab(f.foreign);
  const foreignClaim = f.backend.auxiliaryTabs.owner(8);
  const ack = await f.backend.armPageWait({ ...scope, timeoutMs: 2000 }); created(f);
  await assert.rejects(f.backend.collectPageWait({ ...scope, waiterId: ack.waiterId }), /OBU_PAGE_WAIT_EXPIRED/);
  await f.backend.cancelPageWait({ ...scope, waiterId: ack.waiterId });
  assert.equal(f.backend.auxiliaryTabs.owner(8), foreignClaim);
  assert.ok(f.tabs.has(8));
});

test("external child detach and waiter rollback share real native cleanup without a cycle", { timeout: 5000 }, async t => {
  const f = await fixture(t), scope = sourceParams(f);
  const ack = await f.backend.armPageWait({ ...scope, timeoutMs: 2000 }); created(f);
  await until(() => f.backend.pageWaits.records.get(ack.waiterId)?.state === "matched", "matched native child");
  await Promise.all([f.backend.detachTab(8), f.backend.detachTab(8)]);
  await f.backend.cancelPageWait({ ...scope, waiterId: ack.waiterId });
  assert.equal(f.backend.auxiliaryTabs.entry(8), undefined);
  assert.ok(f.tabs.has(8));
  assert.equal(f.backend.controlReleases.has(8), false);
});

test("source document navigation withdraws readiness and child-window movement prevents delivery", { timeout: 5000 }, async t => {
  const f = await fixture(t), scope = sourceParams(f);
  const ack = await f.backend.armPageWait({ ...scope, timeoutMs: 2000 });
  f.chrome.webNavigation.onBeforeNavigate.emit({ tabId: 7, frameId: 0, url: "https://fixture.test/replaced" });
  created(f);
  await assert.rejects(f.backend.collectPageWait({ ...scope, waiterId: ack.waiterId }), /OBU_PAGE_WAIT_SOURCE_CHANGED/);
  await f.backend.cancelPageWait({ ...scope, waiterId: ack.waiterId });
  const next = await f.backend.armPageWait({ ...scope, timeoutMs: 2000 }); created(f);
  await until(() => f.backend.pageWaits.records.get(next.waiterId)?.state === "matched", "second child");
  f.tabs.get(8).windowId = 1;
  f.chrome.tabs.onDetached.emit(8, { oldWindowId: 2 });
  await assert.rejects(f.backend.collectPageWait({ ...scope, waiterId: next.waiterId }), /OBU_PAGE_WAIT_EXPIRED/);
  await f.backend.cancelPageWait({ ...scope, waiterId: next.waiterId });
  assert.ok(f.tabs.has(8));
});
