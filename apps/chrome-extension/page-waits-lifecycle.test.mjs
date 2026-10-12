import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "./test-support/page-waits-fixture.mjs";

async function until(check) {
  for (let n = 0; n < 100; n++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 0)); }
  assert.fail("Fixture did not reach its deterministic barrier");
}

for (const change of ["moved", "pinned", "inventory"]) {
  test(`created-page ${change} cleanup drains when original collect validation is still pending`, { timeout: 3000 }, async t => {
    const f = await fixture(t), scope = { ...f.params, tabId: 7 };
    const ack = await f.backend.armPageWait({ ...scope, timeoutMs: 2000 });
    f.chrome.webNavigation.onCreatedNavigationTarget.emit({ sourceTabId: 7, sourceFrameId: 0, sourceProcessId: 4, tabId: 8, url: f.tabs.get(8).url });
    const record = f.backend.pageWaits.records.get(ack.waiterId);
    await until(() => record.state === "matched");
    const gate = f.gate(); let entered = false;
    f.hooks.getTab = async id => { if (id === 8 && !entered) { entered = true; await gate.promise; } };
    const collecting = f.backend.collectPageWait({ ...scope, waiterId: ack.waiterId });
    const rejected = assert.rejects(collecting, /OBU_PAGE_WAIT_|OBU_AUXILIARY_|no longer owned/);
    await until(() => entered);
    f.tabs.get(8).pinned = change === "pinned";
    if (change === "moved") {
      f.chrome.tabs.onMoved.emit(8, { windowId: 2, fromIndex: 1, toIndex: 0 });
    } else if (change === "pinned") {
      f.chrome.tabs.onUpdated.emit(8, { pinned: true }, { ...f.tabs.get(8) });
    } else {
      f.tabs.get(8).windowId = 3;
      // Real inventory validation is another entry point into the same release.
      const inventory = f.backend.getSessionTabs(scope.session_id, { strict: true });
      inventory.catch(() => {}); t.after(() => inventory);
    }
    gate.resolve();
    await rejected;
    await f.backend.cancelPageWait({ ...scope, waiterId: ack.waiterId });
    assert.equal(f.backend.auxiliaryTabs.entry(8), undefined);
    assert.equal(f.backend.controlReleases.has(8), false);
    assert.ok(f.tabs.has(8), "Cleanup must preserve the original native child");
  });
}

test("created-page native cleanup failure preserves the exact denial until explicit cleanup succeeds", { timeout: 3000 }, async t => {
  const f = await fixture(t), scope = { ...f.params, tabId: 7 };
  const ack = await f.backend.armPageWait({ ...scope, timeoutMs: 2000 });
  f.chrome.webNavigation.onCreatedNavigationTarget.emit({ sourceTabId: 7, sourceFrameId: 0, sourceProcessId: 4, tabId: 8, url: f.tabs.get(8).url });
  const record = f.backend.pageWaits.records.get(ack.waiterId);
  await until(() => record.state === "matched");
  const claim = f.backend.auxiliaryTabs.owner(8);
  f.hooks.detach = async id => { if (id === 8) throw new Error("fixture original detach failed"); };
  f.chrome.tabs.onMoved.emit(8, { windowId: 2, fromIndex: 1, toIndex: 0 });
  await until(() => record.cleanupSettled);
  assert.match(record.cleanupError.message, /fixture original detach failed/);
  assert.equal(f.backend.auxiliaryTabs.entry(8), claim);
  assert.equal(f.backend.auxiliaryTabs.owner(8), undefined);
  await assert.rejects(f.backend.claimUserTab(f.params), /CLEANUP_REQUIRED/);
  delete f.hooks.detach;
  await f.backend.cancelPageWait({ ...scope, waiterId: ack.waiterId });
  assert.equal(f.backend.auxiliaryTabs.entry(8), undefined);
  assert.ok(f.tabs.has(8));
});

for (const type of ["normal", "popup"]) {
  test(`explicitly claiming an already delivered created-page preserves its ${type} window and ownership`, { timeout: 3000 }, async t => {
    const f = await fixture(t), scope = { ...f.params, tabId: 7 };
    f.windows.get(2).type = type;
    const ack = await f.backend.armPageWait({ ...scope, timeoutMs: 2000 });
    f.chrome.webNavigation.onCreatedNavigationTarget.emit({ sourceTabId: 7, sourceFrameId: 0, sourceProcessId: 4, tabId: 8, url: f.tabs.get(8).url });
    await f.backend.collectPageWait({ ...scope, waiterId: ack.waiterId });
    const original = f.backend.auxiliaryTabs.owner(8);
    const tab = await f.backend.claimUserTab(f.params);
    assert.equal(tab.id, 8); assert.equal(tab.active, true);
    assert.equal(f.backend.auxiliaryTabs.owner(8), original);
    assert.equal(original.kind, "created-page");
    assert.equal(f.tabs.get(8).windowId, 2); assert.equal(f.tabs.get(8).groupId, -1);
    assert.equal(f.calls.some(([method]) => ["group", "ungroup", "remove"].includes(method)), false);
  });
}
