import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "./test-support/page-waits-fixture.mjs";
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

async function setup(t) {
  const f = await fixture(t, { managed: true });
  f.frameRecords.set(8, [{ frameId: 0, parentFrameId: -1, documentId: "popup-original", url: f.tabs.get(8).url }]);
  f.choices = f.backend.createManagedPageChoices({ check() {} });
  t.after(async () => { f.choices.revoke(); await f.choices.drain(); });
  return f;
}

test("native browser page directory is read-only and retains stable choices across refresh", async t => {
  const f = await setup(t), before = structuredClone(f.tabs.get(8)), from = f.calls.length;
  const first = (await f.choices.list()).find(row => row.id === 8);
  assert.equal(first.kind, "browser"); assert.equal(first.takeover, true);
  assert.equal((await f.choices.list()).find(row => row.id === 8).pageSelectionId, first.pageSelectionId);
  assert.deepEqual(f.tabs.get(8), before); assert.equal(f.backend.managedResults.entries().length, 0);
  assert.equal(f.calls.slice(from).some(([name]) => ["attach", "group", "ungroup", "remove"].includes(name)), false);
});

test("explicit paused selection journals and publishes the original page without Agent membership or placement changes", async t => {
  const f = await setup(t), before = structuredClone(f.tabs.get(8));
  const choice = (await f.choices.list()).find(row => row.id === 8);
  await assert.rejects(f.choices.select(8, choice.pageSelectionId, { check() {} }), /PAUSED|UNAVAILABLE/);
  await f.backend.pauseAutomation();
  const result = await f.choices.select(8, choice.pageSelectionId, { check() {} });
  assert.equal(result.retained, true); assert.equal(result.pageSelectionId, choice.pageSelectionId);
  const record = f.backend.managedResults.get(8, result.deliveryId);
  assert.equal(record.currentDocument, "popup-original"); assert.ok(record.commitPromise);
  assert.deepEqual(f.tabs.get(8), before);
  assert.equal(f.backend.auxiliaryTabs.owner(8), undefined);
  assert.equal((await f.backend.store.getSession("task")).tabOrigins[8], undefined);
  await assert.rejects(f.choices.select(8, choice.pageSelectionId, { check() {} }), /STALE/);
});

test("new choices are private to their original channel and cannot be supplied for another tab", async t => {
  const f = await setup(t), other = f.backend.createManagedPageChoices({ check() {} });
  t.after(async () => { other.revoke(); await other.drain(); });
  const choice = (await f.choices.list()).find(row => row.id === 8);
  await other.list(); await f.backend.pauseAutomation();
  await assert.rejects(other.select(8, choice.pageSelectionId), /STALE/);
  await assert.rejects(f.choices.select(7, choice.pageSelectionId), /STALE/);
  assert.equal(f.backend.managedResults.records.size, 0);
});

for (const change of ["navigation", "move-return", "pin-return", "replacement", "removed"]) {
  test(`a ${change} withdraws an old choice even before selection starts`, async t => {
    const f = await setup(t), choice = (await f.choices.list()).find(row => row.id === 8);
    if (change === "navigation") f.chrome.webNavigation.onCommitted.emit({ tabId: 8, frameId: 0, documentId: "new-doc", url: f.tabs.get(8).url });
    if (change === "move-return") { f.chrome.tabs.onDetached.emit(8); f.chrome.tabs.onAttached.emit(8); }
    if (change === "pin-return") { f.chrome.tabs.onUpdated.emit(8, { pinned: true }); f.chrome.tabs.onUpdated.emit(8, { pinned: false }); }
    if (change === "replacement") f.chrome.tabs.onReplaced.emit(80, 8);
    if (change === "removed") { f.tabs.delete(8); f.chrome.tabs.onRemoved.emit(8, {}); }
    await f.backend.pauseAutomation();
    await assert.rejects(f.choices.select(8, choice.pageSelectionId), /STALE/);
    if (change !== "removed") assert.notEqual((await f.choices.list()).find(row => row.id === 8).pageSelectionId, choice.pageSelectionId);
    assert.equal(f.backend.managedResults.records.size, 0);
  });
}

test("a result is reused only with its exact current document and no second journal write", async t => {
  const f = await setup(t);
  let choice = (await f.choices.list()).find(row => row.id === 8);
  await f.backend.pauseAutomation();
  const first = await f.choices.select(8, choice.pageSelectionId);
  const record = f.backend.managedResults.get(8, first.deliveryId), commit = record.commitPromise;
  choice = (await f.choices.list()).find(row => row.id === 8);
  const second = await f.choices.select(8, choice.pageSelectionId);
  assert.equal(second.deliveryId, first.deliveryId); assert.equal(record.commitPromise, commit);
  assert.equal(f.backend.managedJournal.snapshot().state.records.length, 1);
});

function onTransactions(f, hook) {
  const db = f.backend.managedJournal.db, original = db.transaction;
  db.transaction = function (...args) { const transaction = Reflect.apply(original, this, args); hook(transaction); return transaction; };
}

test("actual successful IDB commit still publishes when the original channel closes before its ACK", async t => {
  const f = await setup(t), choice = (await f.choices.list()).find(row => row.id === 8);
  await f.backend.pauseAutomation();
  onTransactions(f, transaction => transaction.addEventListener("complete", () => f.choices.revoke()));
  await assert.rejects(f.choices.select(8, choice.pageSelectionId), /STALE/);
  await f.choices.drain();
  const record = f.backend.managedResults.entries().find(row => row.tabId === 8);
  assert.ok(record); assert.equal(f.backend.managedJournal.snapshot().state.records[0].recordId, record.recordId);
  assert.equal(f.backend.managedPageChoices.size, 0);
});

test("channel withdrawal before the actual commit aborts the transaction and removes only its original reservation", async t => {
  const f = await setup(t), choice = (await f.choices.list()).find(row => row.id === 8);
  await f.backend.pauseAutomation();
  let once = false;
  onTransactions(f, () => { if (!once) { once = true; f.choices.revoke(); } });
  await assert.rejects(f.choices.select(8, choice.pageSelectionId), /STALE/);
  await f.choices.drain();
  assert.equal(f.backend.managedResults.records.size, 0);
  assert.equal(f.backend.managedJournal.snapshot().state.records.length, 0);
});

for (const change of ["navigation", "move-return", "policy"]) {
  test(`actual commit followed by ${change} tombstones the exact original record instead of publishing`, async t => {
    const f = await setup(t), choice = (await f.choices.list()).find(row => row.id === 8);
    await f.backend.pauseAutomation();
    let once = false;
    onTransactions(f, transaction => transaction.addEventListener("complete", () => {
      if (once) return; once = true;
      if (change === "navigation") f.chrome.webNavigation.onCommitted.emit({ tabId: 8, frameId: 0, documentId: "new-doc", url: f.tabs.get(8).url });
      if (change === "move-return") { f.chrome.tabs.onDetached.emit(8); f.chrome.tabs.onAttached.emit(8); }
      if (change === "policy") f.backend.sitePolicyUpdate = {};
    }));
    await assert.rejects(f.choices.select(8, choice.pageSelectionId), /STALE/);
    await f.choices.drain();
    assert.equal(f.backend.managedResults.records.size, 0);
    assert.equal(f.backend.managedJournal.snapshot().state.records.length, 0);
  });
}

test("a move-and-return inside an identity read cannot rebind the selected original page", async t => {
  const f = await setup(t), choice = (await f.choices.list()).find(row => row.id === 8);
  await f.backend.pauseAutomation();
  f.hooks.frame = async tabId => { if (tabId === 8) { f.chrome.tabs.onDetached.emit(8); f.chrome.tabs.onAttached.emit(8); } };
  await assert.rejects(f.choices.select(8, choice.pageSelectionId), /STALE|changed/);
  assert.equal(f.backend.managedResults.records.size, 0);
});

test("an actual sibling identity read stays in drain after another Chrome read rejects", async t => {
  const f = await setup(t), choice = (await f.choices.list()).find(row => row.id === 8);
  await f.backend.pauseAutomation();
  const held = f.gate(); let frameStarted = false;
  f.hooks.getTab = async id => { if (id === 8) throw Error("native get failed"); };
  f.hooks.frame = async id => { if (id === 8) { frameStarted = true; await held.promise; } };
  await assert.rejects(f.choices.select(8, choice.pageSelectionId), /native get failed/);
  assert.equal(frameStarted, true); f.choices.revoke();
  let drained = false; const drain = f.choices.drain().then(() => { drained = true; });
  await tick(); assert.equal(drained, false);
  held.resolve(); await drain; assert.equal(drained, true);
});

test("excluding the exact active human result avoids revalidating or revoking that navigating record", async t => {
  const f = await setup(t), choice = (await f.choices.list()).find(row => row.id === 8);
  await f.backend.pauseAutomation();
  const { deliveryId } = await f.choices.select(8, choice.pageSelectionId);
  const record = f.backend.managedResults.get(8, deliveryId);
  f.backend.captureManagedResultPage = async () => { throw Error("must not inspect excluded human result"); };
  assert.deepEqual(Array.from(await f.backend.getManagedViewerTabs({ excludeTabId: 8 })), []);
  assert.equal(f.backend.managedResults.get(8, deliveryId), record);
});

test("a real Pause transition temporarily empties the directory without retiring the live channel or its choices", async t => {
  const f = await setup(t), choice = (await f.choices.list()).find(row => row.id === 8);
  let queries = 0; f.hooks.query = async () => { queries++; };
  const paused = f.backend.pauseAutomation();
  assert.equal(f.backend.automationControl.state, "pausing");
  await assert.rejects(f.choices.select(8, choice.pageSelectionId), /UNAVAILABLE/);
  assert.deepEqual(await f.choices.list(), []);
  assert.equal(queries, 0);
  await paused;
  assert.equal((await f.choices.list()).find(row => row.id === 8).pageSelectionId, choice.pageSelectionId);
  f.backend.sitePolicyUpdate = {};
  assert.deepEqual(await f.choices.list(), []);
  f.backend.sitePolicyUpdate = null;
  assert.equal((await f.choices.list()).find(row => row.id === 8).pageSelectionId, choice.pageSelectionId);
});

test("temporary availability handling never hides original native or channel loss", async t => {
  const f = await setup(t);
  f.backend.nativeRecovery = { error: Error("original native lost") };
  await assert.rejects(f.choices.list(), /NATIVE_RECOVERY/);
  f.backend.nativeRecovery = null;
  let valid = true;
  const choices = f.backend.createManagedPageChoices({ check() { if (!valid) throw Error("original channel gone"); } });
  t.after(async () => { choices.revoke(); await choices.drain(); });
  await choices.list(); valid = false;
  await assert.rejects(choices.list(), /original channel gone/);
});

test("channel revoke drains the actual catalog query and cannot create late choices", async t => {
  const f = await setup(t), held = f.gate();
  f.hooks.query = async () => held.promise;
  const listing = f.choices.list();
  f.choices.revoke(); let done = false;
  const drained = f.choices.drain().then(() => { done = true; });
  await tick(); assert.equal(done, false);
  const rejected = assert.rejects(listing, /STALE/);
  held.resolve(); await rejected; await drained;
  assert.equal(f.choices.choices.size, 0); assert.equal(f.backend.managedResults.records.size, 0);
});

test("a caller cancelled at transaction completion receives no receipt while the real delivery remains published", async t => {
  const f = await setup(t), choice = (await f.choices.list()).find(row => row.id === 8);
  await f.backend.pauseAutomation();
  let current = true;
  onTransactions(f, transaction => transaction.addEventListener("complete", () => { current = false; }));
  await assert.rejects(f.choices.select(8, choice.pageSelectionId, { check() { if (!current) throw Error("old selection request cancelled"); } }), /old selection request cancelled/);
  assert.equal(f.backend.managedResults.entries().length, 1);
  assert.equal(f.backend.managedJournal.snapshot().state.records.length, 1);
});
