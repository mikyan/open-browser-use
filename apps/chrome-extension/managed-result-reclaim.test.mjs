import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "./test-support/page-waits-fixture.mjs";

const KEY = "OPEN_BROWSER_USE_AUXILIARY_TABS";
const clone = value => structuredClone(value);
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function delivered(t) {
  const f = await fixture(t, { managed: true });
  f.windows.get(2).type = "normal";
  f.frameRecords.set(8, [{ frameId: 0, parentFrameId: -1, documentId: "original-eight", url: f.tabs.get(8).url }]);
  const reservation = f.backend.auxiliaryTabs.reserveCreation(f.params, { kind: "background-window" });
  await f.backend.auxiliaryTabs.bindCreated(reservation, f.tabs.get(8));
  await f.backend.commitBackgroundWindowTab(reservation, await f.backend.store.getSession("task"), () => {});
  const ended = await f.backend.finalizeTabs({ ...f.params, keep: [
    { tabId: 7, status: "handoff" }, { tabId: 8, status: "deliverable" }
  ] });
  f.params = f.fresh(f.params, ended);
  assert.equal(f.backend.auxiliaryTabs.entry(8), undefined);
  assert.equal(f.backend.managedResults.entries().filter(row => row.tabId === 8).length, 1);
  return f;
}
function noDisposition(f, from) {
  assert.equal(f.calls.slice(from).some(([name, ids]) =>
    ["group", "ungroup", "remove"].includes(name) && [].concat(ids).includes(8)), false);
}

test("reclaim of an original managed deliverable preserves its window without changing primary task grouping", async t => {
  const f = await delivered(t), original = clone(f.tabs.get(8)), from = f.calls.length;
  const result = await f.backend.claimUserTab(f.params);
  assert.equal(result.id, 8);
  assert.deepEqual(f.tabs.get(8), original);
  noDisposition(f, from);
  const claim = f.backend.auxiliaryTabs.owner(8);
  assert.equal(claim?.kind, "managed-result"); assert.equal(claim.origin, "user");
  const session = await f.backend.store.getSession("task");
  assert.equal(session.chromeGroupId, 10); assert.notEqual(session.ungrouped, true);
  assert.equal(session.tabOrigins[8], "user");
  assert.deepEqual(Array.from(await f.backend.getTabs(f.params), tab => tab.id).sort(), [7, 8]);
  assert.equal(f.backend.managedResults.records.has(8), false);
  assert.equal(f.session[KEY].version, 5);
  const again = f.calls.length;
  await f.backend.claimUserTab(f.params);
  assert.equal(f.backend.auxiliaryTabs.owner(8), claim); noDisposition(f, again);
});

for (const disposition of ["omit", "deliverable", "handoff"]) {
  test(`reclaimed user result ${disposition} never moves or closes the original page`, async t => {
    const f = await delivered(t);
    await f.backend.claimUserTab(f.params);
    const before = clone(f.tabs.get(8)), from = f.calls.length;
    await f.backend.finalizeTabs({ ...f.params, keep: disposition === "omit" ? [] : [{ tabId: 8, status: disposition }] });
    assert.deepEqual(f.tabs.get(8), before); noDisposition(f, from);
    assert.equal(f.backend.auxiliaryTabs.owner(8)?.kind, disposition === "handoff" ? "managed-result" : undefined);
    assert.equal(f.backend.managedResults.entries().some(record => record.tabId === 8), disposition !== "omit");
  });
}

for (const change of ["move-return", "pin-return", "document-return", "target", "successor"]) {
  test(`original reclaim cannot cross ${change} while original view cleanup is pending`, async t => {
    const f = await delivered(t), original = clone(f.tabs.get(8)), from = f.calls.length;
    const release = f.backend.managedHuman.revokeView.bind(f.backend.managedHuman);
    f.backend.managedHuman.revokeView = async tabId => {
      await release(tabId);
      if (change === "move-return") {
        f.tabs.get(8).windowId = 3; f.chrome.tabs.onDetached.emit(8, { oldWindowId: 2 });
        f.tabs.get(8).windowId = 2; f.chrome.tabs.onAttached.emit(8, { newWindowId: 2 });
      } else if (change === "pin-return") {
        f.tabs.get(8).pinned = true; f.chrome.tabs.onUpdated.emit(8, { pinned: true });
        f.tabs.get(8).pinned = false; f.chrome.tabs.onUpdated.emit(8, { pinned: false });
      } else if (change === "document-return") {
        f.chrome.webNavigation.onCommitted.emit({ tabId: 8, frameId: 0, documentId: "different", url: original.url });
      } else if (change === "target") {
        f.hooks.targets = () => [...f.tabs.values()].map(tab => ({ tabId: tab.id, type: "page",
          id: tab.id === 8 ? "replacement-target" : `target-${tab.id}`, url: tab.url }));
      } else {
        const current = await f.backend.readManagedPageIdentity(8, () => {});
        const next = f.backend.managedResults.reserve(current);
        f.backend.managedResults.stage(next, current, current);
        f.backend.managedResults.publish([next]);
      }
    };
    await assert.rejects(f.backend.claimUserTab(f.params), /STALE|CANCELLED|EXPIRED|changed/i);
    noDisposition(f, from);
    assert.equal(f.backend.auxiliaryTabs.owner(8), undefined);
    assert.deepEqual(f.tabs.get(8), original);
  });
}

test("placement move-and-return during original committed storage write withdraws reclaim", async t => {
  const f = await delivered(t), from = f.calls.length;
  let changed = false;
  f.hooks.write = async (area, value) => {
    if (!changed && area === "session" && value[KEY]?.records.some(row => row.kind === "managed-result" && row.phase === "committed")) {
      changed = true;
      f.chrome.tabs.onMoved.emit(8);
    }
  };
  await assert.rejects(f.backend.claimUserTab(f.params), /CANCELLED|EXPIRED|changed/i);
  assert.equal(changed, true);
  await tick();
  assert.equal(f.backend.auxiliaryTabs.owner(8), undefined); noDisposition(f, from);
});

test("presentation-only markers do not grant preserve-window authority", async t => {
  const f = await fixture(t, { managed: true });
  f.windows.get(2).type = "normal";
  f.backend.store.state.deliverableTabs = { 8: { tabId: 8, windowId: 2 } };
  await f.backend.claimUserTab(f.params);
  assert.equal(f.tabs.get(8).groupId, 10);
  assert.equal(f.backend.auxiliaryTabs.owner(8), undefined);
});

test("an original grouped or pinned result keeps the ordinary explicit-claim path", async t => {
  for (const kind of ["grouped", "pinned"]) {
    await t.test(kind, async t => {
      const f = await fixture(t, { managed: true });
      f.windows.get(2).type = "normal";
      f.frameRecords.set(8, [{ frameId: 0, parentFrameId: -1, documentId: "original-eight", url: f.tabs.get(8).url }]);
      if (kind === "grouped") { f.tabs.get(8).groupId = 30; f.groups.set(30, { id: 30, windowId: 2 }); }
      else f.tabs.get(8).pinned = true;
      const current = await f.backend.readManagedPageIdentity(8, () => {});
      const record = f.backend.managedResults.reserve(current);
      f.backend.managedResults.stage(record, current, current);
      f.backend.managedResults.publish([record]);
      await f.backend.claimUserTab(f.params);
      assert.equal(f.tabs.get(8).groupId, 10);
      assert.equal(f.backend.auxiliaryTabs.owner(8), undefined);
      assert.equal(f.backend.managedResults.records.has(8), false);
    });
  }
});

for (const event of ["pin", "group", "move"]) {
  test(`reclaimed user membership is withdrawn on later ${event}`, async t => {
    const f = await delivered(t);
    await f.backend.claimUserTab(f.params);
    const claim = f.backend.auxiliaryTabs.owner(8), from = f.calls.length;
    if (event === "pin") { f.tabs.get(8).pinned = true; f.chrome.tabs.onUpdated.emit(8, { pinned: true }); }
    if (event === "group") { f.tabs.get(8).groupId = 20; f.chrome.tabs.onUpdated.emit(8, { groupId: 20 }); }
    if (event === "move") f.chrome.tabs.onMoved.emit(8);
    assert.equal(f.backend.auxiliaryTabs.owner(8), undefined);
    await f.backend.auxiliaryReleases.get(claim);
    noDisposition(f, from); assert.equal(f.tabs.has(8), true);
  });
}

test("reclaimed handoff cannot recover authority across a worker restart", async t => {
  const f = await delivered(t);
  await f.backend.claimUserTab(f.params);
  await f.backend.finalizeTabs({ ...f.params, keep: [{ tabId: 8, status: "handoff" }] });
  const original = clone(f.tabs.get(8)), from = f.calls.length;
  const replacement = new f.Backend();
  await replacement.controlReady;
  assert.equal(replacement.auxiliaryTabs.owner(8), undefined);
  assert.equal(replacement.auxiliaryTabs.entry(8), undefined);
  assert.deepEqual(f.tabs.get(8), original); noDisposition(f, from);
});

test("committed write failure never revives a reclaimed user capability or closes its page", async t => {
  const f = await delivered(t), from = f.calls.length;
  f.hooks.write = async (area, value) => {
    if (area === "session" && value[KEY]?.records.some(row => row.kind === "managed-result" && row.phase === "committed"))
      throw new Error("original commit write failed");
  };
  await assert.rejects(f.backend.claimUserTab(f.params), /original commit write failed/);
  assert.equal(f.backend.auxiliaryTabs.owner(8), undefined);
  assert.equal(f.backend.managedResults.records.has(8), false);
  assert.equal(f.tabs.has(8), true); noDisposition(f, from);
  delete f.hooks.write;
  await f.backend.auxiliaryTabs.writes;
  assert.equal(f.backend.auxiliaryTabs.owner(8), undefined);
});

test("a managed handoff cannot relabel an existing agent-owned background-window claim", async t => {
  const f = await fixture(t, { managed: true });
  f.windows.get(2).type = "normal";
  f.frameRecords.set(8, [{ frameId: 0, parentFrameId: -1, documentId: "original-eight", url: f.tabs.get(8).url }]);
  const reservation = f.backend.auxiliaryTabs.reserveCreation(f.params, { kind: "background-window" });
  await f.backend.auxiliaryTabs.bindCreated(reservation, f.tabs.get(8));
  await f.backend.commitBackgroundWindowTab(reservation, await f.backend.store.getSession("task"), () => {});
  const ended = await f.backend.finalizeTabs({ ...f.params, keep: [{ tabId: 8, status: "handoff" }] });
  const from = f.calls.length;
  await f.backend.claimUserTab(f.fresh(f.params, ended));
  assert.equal(f.backend.auxiliaryTabs.owner(8), reservation);
  assert.equal(reservation.kind, "background-window"); assert.equal(reservation.origin, "agent");
  noDisposition(f, from);
});
