import test from "node:test";
import assert from "node:assert/strict";
import { createContext, runInContext } from "node:vm";
import { fixture } from "../../apps/chrome-extension/test-support/page-waits-fixture.mjs";
import { installNativeCreatedPageLossObserver, assertNativeCreatedPageImmediateLoss, assertNativeCreatedPageRetired,
  requireNativeCreatedPageRejection } from "./native-created-page-loss.mjs";

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function prepared(t, change = () => {}, options = {}) {
  // Actual backend/page-wait implementation, simulated Chrome APIs. These
  // tests validate passive evidence and its rejection boundaries, not a real
  // native process, natural click, browser document or public window creation.
  const f = await fixture(t), scope = { ...f.params, tabId: 7 };
  const handle = await f.backend.armPageWait({ ...scope, timeoutMs: 20000 });
  const record = f.backend.pageWaits.records.get(handle.waiterId);
  f.chrome.webNavigation.onCreatedNavigationTarget.emit({ sourceTabId: 7, sourceFrameId: 0, sourceProcessId: 4, tabId: 8, url: f.tabs.get(8).url });
  await record.completion.promise;
  const claim = f.backend.auxiliaryTabs.owner(8); assert.ok(claim);
  await change(f, record);
  const originals = { fail: f.backend.pageWaits.fail, nativeDisconnected: f.backend.nativeDisconnected, releaseAuxiliaryClaim: f.backend.releaseAuxiliaryClaim };
  const context = createContext({ backend: f.backend, TextEncoder, Date });
  runInContext(`(${installNativeCreatedPageLossObserver.toString()})(backend,globalThis,${JSON.stringify({ waiterId: handle.waiterId, childId: 8, claimId: claim.claimId, ...options })})`, context);
  const observer = context.__nativeCreatedPageLoss;
  t.after(() => observer.stop());
  return Object.assign(f, { record, claim, observer, originals, snapshot: () => structuredClone(observer.snapshot()), stop: () => structuredClone(observer.stop()) });
}

test("serialized observer preserves actual native recovery promise, exact original claim and method descriptors", async t => {
  const f = await prepared(t), promise = f.backend.nativeDisconnected();
  assert.equal(promise, f.backend.nativeRecovery.promise, "Observer must return the original promise");
  await promise; await tick();
  const snapshot = f.stop(), checks = assertNativeCreatedPageImmediateLoss(snapshot, { stopped: true });
  assert.ok(checks.cleanupRemainingMs > 0); assert.equal(snapshot.current.entry, null);
  assert.equal(f.backend.pageWaits.fail, f.originals.fail);
  assert.equal(f.backend.nativeDisconnected, f.originals.nativeDisconnected);
  assert.equal(f.backend.releaseAuxiliaryClaim, f.originals.releaseAuxiliaryClaim);
  assert.equal(Object.hasOwn(f.backend, "nativeDisconnected"), false);
  assert.ok(snapshot.rows.some(row => row.kind === "releaseAuxiliaryClaim-enter" && row.exactClaim));
  snapshot.rows[0].snapshot.entry.claimId = "changed-copy";
  assert.equal(f.snapshot().rows[0].snapshot.entry.claimId, f.claim.claimId);
});

for (const mode of ["no-invalidation", "expire-only"]) test(`actual registry cannot pass host-loss evidence through ${mode}`, async t => {
  const f = await prepared(t, (state, record) => {
    state.backend.nativeDisconnected = function () {
      if (mode === "no-invalidation") return Promise.resolve();
      this.pageWaits.fail(record, Error("OBU_PAGE_WAIT_TIMEOUT: original created-page deadline expired"));
      return record.cleanup;
    };
  });
  await f.backend.nativeDisconnected(); await tick();
  assert.throws(() => assertNativeCreatedPageImmediateLoss(f.stop()), mode === "no-invalidation" ? /Missing actual/ : /NATIVE_CONNECTION_LOST/);
});

test("late original deletion is observed but cannot pass the original deadline gate", async t => {
  const f = await prepared(t), gate = f.gate(); let deleting = false;
  f.hooks.write = async (area, value) => {
    if (area === "session" && value.OPEN_BROWSER_USE_AUXILIARY_TABS && !value.OPEN_BROWSER_USE_AUXILIARY_TABS.records.some(record => record.tabId === 8)) {
      deleting = true; await gate.promise;
    }
  };
  const recovery = f.backend.nativeDisconnected();
  for (let count = 0; count < 100 && !deleting; count++) await tick();
  assert.equal(deleting, true);
  assert.throws(() => assertNativeCreatedPageImmediateLoss(f.snapshot()), /Missing actual/);
  f.backend.pageWaits.now = () => f.record.deadlineAt + 1;
  gate.resolve(); await recovery; await tick();
  assert.throws(() => assertNativeCreatedPageImmediateLoss(f.stop()), /after the original deadline/);
});

test("failed original cleanup remains rejected evidence rather than a false lifecycle success", async t => {
  const f = await prepared(t);
  f.hooks.write = async (area, value) => {
    if (area === "session" && value.OPEN_BROWSER_USE_AUXILIARY_TABS && !value.OPEN_BROWSER_USE_AUXILIARY_TABS.records.some(record => record.tabId === 8))
      throw Error("original exact-claim storage rejected");
  };
  await assert.rejects(f.backend.nativeDisconnected(), /original exact-claim storage rejected/); await tick();
  const snapshot = f.stop(); assert.ok(snapshot.rows.some(row => row.kind === "cleanup-rejected"));
  assert.throws(() => assertNativeCreatedPageImmediateLoss(snapshot), /Missing actual/);
  delete f.hooks.write; await f.backend.getControlState({ session_id: "task" });
});

test("original synchronous throws preserve identity and observer corruption cannot pass", async t => {
  const original = Error("original synchronous disconnect throw");
  const f = await prepared(t, state => { state.backend.nativeDisconnected = function () { assert.equal(this, state.backend); throw original; }; });
  assert.throws(() => f.backend.nativeDisconnected(), error => error === original);
  assert.match(f.snapshot().rows.at(-1).error, /original synchronous/);
  f.backend.pageWaits.fail = () => {};
  const stopped = f.stop(); assert.equal(stopped.restored, false); assert.match(stopped.errors[0], /observer replaced/);
  assert.throws(() => assertNativeCreatedPageImmediateLoss(stopped, { stopped: true }));
  f.backend.pageWaits.fail = f.originals.fail;
});

for (const options of [{ maxRecords: 1 }, { maxBytes: 1 }]) test(`observer limit ${JSON.stringify(options)} cannot quietly lose critical evidence`, async t => {
  const f = await prepared(t, undefined, options); await f.backend.nativeDisconnected(); await tick();
  const snapshot = f.stop(); assert.equal(snapshot.overflow, true);
  assert.throws(() => assertNativeCreatedPageImmediateLoss(snapshot));
});

function retiredFixture() {
  const item = { tabId: 7, childId: 8, childURL: "https://fixture.test/child", createdTab: { id: 7, windowId: 4, groupId: -1, pinned: false },
    sourceFrame: { frameId: 0, documentId: "source-original", url: "https://fixture.test/source" },
    childFrame: { frameId: 0, documentId: "child-original", url: "https://fixture.test/child" } };
  return { item, snapshot: { source: { ...item.createdTab }, tab: { id: 8, windowId: 4, groupId: -1, pinned: false, url: item.childURL }, entry: null, owner: null, stored: [], targets: [] },
    sourceFrames: [item.sourceFrame], childFrames: [item.childFrame], tabs: [{ id: 7 }] };
}

test("old scope success, inherited child authority and document replacement fail explicit independent gates", async () => {
  await assert.rejects(requireNativeCreatedPageRejection(async () => ({}), /STALE/), /unexpectedly retained/);
  await assert.rejects(requireNativeCreatedPageRejection(async () => { throw Error("unrelated timeout"); }, /STALE/), /STALE/);
  assert.match((await requireNativeCreatedPageRejection(async () => { throw Error("OBU_STALE_CONTROL_EPOCH"); }, /STALE/)).error, /STALE/);
  const value = retiredFixture(), { item } = value;
  assertNativeCreatedPageRetired(value);
  for (const alter of [data => data.tabs.push({ id: 8 }), data => { data.childFrames[0].documentId = "replacement"; },
    data => { data.sourceFrames[0].documentId = "replacement"; }, data => { data.snapshot.entry = { phase: "quarantined" }; },
    data => { data.snapshot.targets.push({ tabId: 8, attached: true }); }, data => { data.snapshot.tab.windowId = 99; }]) {
    const changed = structuredClone(value); changed.item = item; alter(changed);
    assert.throws(() => assertNativeCreatedPageRetired(changed));
  }
});

for (const [field, replacement, error] of [["windowId", 99, /Source moved/], ["groupId", 33, /Source group/], ["pinned", true, /Source pinned/]])
  test(`retirement rejects changed source ${field} despite preserved document identities and child location`, () => {
    const value = retiredFixture(); assertNativeCreatedPageRetired(value);
    value.snapshot.source[field] = replacement;
    assert.throws(() => assertNativeCreatedPageRetired(value), error);
  });
