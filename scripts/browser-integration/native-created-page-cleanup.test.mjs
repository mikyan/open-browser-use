import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "../../apps/chrome-extension/test-support/page-waits-fixture.mjs";
import { installCreatedPageCleanupFault } from "./created-page-cleanup-fault.mjs";
import { assertCreatedPageCleanupFailure, assertCreatedPageCleanupRecovered, assertCreatedPageCleanupDocuments,
  assertCreatedPageCleanupIdentity, assertCreatedPageCleanupNoReplay, requireCreatedPageCleanupCollectionRejection } from "./native-created-page-cleanup.mjs";

const plain = value => JSON.parse(JSON.stringify(value));
const KEY = "OPEN_BROWSER_USE_AUXILIARY_TABS", testKey = "__OBU_TEST_CLEANUP_QUOTA_native_check";
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function until(check) { for (let i = 0; i < 100; i++) { if (check()) return; await tick(); } assert.fail("Cleanup did not settle"); }

async function evidence(t) {
  // Real product backend and serialized fault, simulated Chrome. This provides
  // counterexample evidence for the verifier, not a browser/native quota test.
  const f = await fixture(t), scope = { ...f.params, tabId: 7 };
  f.tabs.get(7).pinned = false; f.tabs.get(8).pinned = false;
  f.frameRecords.set(8, [{ frameId: 0, parentFrameId: -1, documentId: "original-child", url: f.tabs.get(8).url }]);
  const ack = await f.backend.armPageWait({ ...scope, timeoutMs: 20000 }), record = f.backend.pageWaits.records.get(ack.waiterId);
  f.chrome.webNavigation.onCreatedNavigationTarget.emit({ sourceTabId: 7, sourceFrameId: 0, sourceProcessId: 4, tabId: 8, url: f.tabs.get(8).url });
  await record.completion.promise;
  const item = { waiterId: ack.waiterId, tabId: 7, childId: 8, scope, createdTab: plain(f.tabs.get(7)),
    adopted: { owner: plain(f.backend.auxiliaryTabs.owner(8)), tab: plain(f.tabs.get(8)), incarnation: f.session[KEY].incarnation },
    sourceFrame: plain(f.frameRecords.get(7)[0]), childFrame: plain(f.frameRecords.get(8)[0]), matched: { deadlineAt: record.deadlineAt },
    replacementSourceURL: "https://fixture.test/replacement" };
  f.chrome.storage.session.QUOTA_BYTES = 128;
  f.hooks.write = async (area, value) => { if (area === "session" && Object.hasOwn(value, testKey)) throw Error("simulated QUOTA_BYTES quota rejection"); };
  const target = {};
  installCreatedPageCleanupFault(f.backend, f.chrome, target, { waiterId: ack.waiterId, childId: 8, claimId: item.adopted.owner.claimId, testKey });
  const fault = target.__createdPageCleanupFault;
  const ownership = () => ({ source: plain(f.tabs.get(7)), tab: plain(f.tabs.get(8)),
    entry: plain(f.backend.auxiliaryTabs.entry(8) ?? null), owner: plain(f.backend.auxiliaryTabs.owner(8) ?? null),
    stored: plain(f.session[KEY].records.filter(value => value.tabId === 8)), incarnation: f.session[KEY].incarnation, testStorage: {}, targets: [] });
  try {
    f.chrome.webNavigation.onBeforeNavigate.emit({ tabId: 7, frameId: 0, url: item.replacementSourceURL });
    f.tabs.get(7).url = item.replacementSourceURL;
    item.replacementSourceFrame = { frameId: 0, parentFrameId: -1, documentId: "replacement-source", url: item.replacementSourceURL };
    f.frameRecords.set(7, [item.replacementSourceFrame]);
    f.chrome.webNavigation.onCommitted.emit({ tabId: 7, ...item.replacementSourceFrame });
    await until(() => record.cleanupSettled);
    const failed = { fault: plain(fault.snapshot()), ownership: ownership(), item: plain(item), timely: true };
    assertCreatedPageCleanupFailure(failed);
    await assert.rejects(f.backend.turnEnded(scope), /OBU_CONTROL_RELEASE_FAILED/);
    await assert.rejects(f.backend.getControlState({ session_id: "task" }), /quota/);
    item.failedCleanupAttempts = record.cleanupAttempts;
    fault.disable(); const fresh = await f.backend.getControlState({ session_id: "task" });
    const params = f.fresh(scope, fresh), tabs = plain(await f.backend.getTabs(params));
    const recovered = { item: plain(item), fault: plain(fault.snapshot()), ownership: ownership(), change: "source-navigation",
      sourceFrames: plain(f.frameRecords.get(7)), childFrames: plain(f.frameRecords.get(8)), tabs };
    assertCreatedPageCleanupRecovered(recovered);
    const old = { ...scope, waiterId: ack.waiterId };
    const rejection = await requireCreatedPageCleanupCollectionRejection(() => f.backend.collectPageWait(old), "source-navigation");
    assert.match(rejection.error, /^Error: OBU_PAGE_WAIT_SOURCE_CHANGED:/);
    await assert.rejects(f.backend.cancelPageWait(old), /OBU_STALE_CONTROL_EPOCH/);
    f.backend.pageWaits.remove(record);
    const retired = await requireCreatedPageCleanupCollectionRejection(() => f.backend.collectPageWait(old), "source-navigation");
    assert.match(retired.error, /^Error: OBU_PAGE_WAIT_EXPIRED:/);
    return { failed, recovered };
  } finally {
    fault.disable(); delete f.hooks.write;
    await f.backend.pageWaits.retryFailedCleanup(); fault.stop();
  }
}

test("cleanup verifier rejects incomplete native failure and forged recovery evidence", async t => {
  const { failed, recovered } = await evidence(t);
  for (const [label, mutate, check] of [
    ["quota key actually persisted", x => { x.ownership.testStorage = { unexpectedKey: true }; }, /Oversized/],
    ["claim disappeared despite failed write", x => { x.ownership.stored = []; }, /claim disappeared/],
    ["original cleanup lock was released early", x => { x.fault.current.reverseLocked = false; }, /false !== true/],
    ["native rejection occurred after deadline", x => { x.fault.current.remainingMs = 0; }, /after original deadline/],
    ["observer failure cannot be called quota evidence", x => { x.fault.errors = ["observer lost settlement"]; }, /observer lost/],
    ["pending native rejection is not settled", x => { x.fault.pendingCount = 1; }, /1 !== 0/],
  ]) await t.test(label, () => {
    const altered = structuredClone(failed); mutate(altered); assert.throws(() => assertCreatedPageCleanupFailure(altered), check);
  });
  for (const [label, mutate, check] of [
    ["same waiter deadline silently extended", x => { x.fault.current.deadlineAt++; }, /deadline changed/],
    ["private replacement record fabricated recovery", x => { x.fault.current.recordReplaced = true; }, /true !== false/],
    ["cleaned flag without native deletion ACK", x => {
      x.fault.records = x.fault.records.filter(row => row.injected); x.fault.bytes = x.fault.records.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row)), 0);
    }, /successful deletion/],
    ["fresh scope inherited original child", x => { x.tabs.push(x.ownership.tab); }, /authority inherited/],
    ["source moved to another window", x => { x.ownership.source.windowId++; }, /Source native windowId/],
    ["source document replaced after transition", x => { x.sourceFrames[0].documentId += "-again"; }, /Source document replaced/],
    ["same URL replacement child is not original", x => { x.childFrames[0].documentId += "-replacement"; }, /Original child document replaced/],
    ["browser incarnation changed", x => { x.fault.current.sameIncarnation = false; }, /false !== true/],
    ["boolean flags cannot conceal a different scope", x => { x.fault.scope.turn_id = "foreign-turn"; }, /foreign-turn/],
  ]) await t.test(label, () => {
    const altered = structuredClone(recovered); mutate(altered); assert.throws(() => assertCreatedPageCleanupRecovered(altered), check);
  });
  await t.test("closed-child evidence rejects resurrection even without inherited authority", () => {
    const closed = structuredClone(recovered); closed.change = "child-close";
    closed.ownership.source.url = closed.item.sourceFrame.url; closed.sourceFrames = [closed.item.sourceFrame];
    closed.ownership.tab = null; closed.childFrames = null;
    assertCreatedPageCleanupDocuments(closed);
    closed.ownership.tab = closed.item.adopted.tab;
    assert.throws(() => assertCreatedPageCleanupDocuments(closed), /Closed original child reappeared/);
  });
});

test("closed original child collection preserves the registry's exact expiration reason", async t => {
  const f = await fixture(t), scope = { ...f.params, tabId: 7 };
  const ack = await f.backend.armPageWait({ ...scope, timeoutMs: 20000 }), record = f.backend.pageWaits.records.get(ack.waiterId);
  f.chrome.webNavigation.onCreatedNavigationTarget.emit({ sourceTabId: 7, sourceFrameId: 0, sourceProcessId: 4, tabId: 8, url: f.tabs.get(8).url });
  await record.completion.promise; await f.chrome.tabs.remove(8); await until(() => record.cleanupSettled);
  assert.match(String(record.error), /^Error: OBU_PAGE_WAIT_EXPIRED:/);
  await f.backend.turnEnded(scope); await f.backend.getControlState({ session_id: "task" });
  const old = { ...scope, waiterId: ack.waiterId };
  const value = await requireCreatedPageCleanupCollectionRejection(() => f.backend.collectPageWait(old), "child-close");
  assert.match(value.error, /^Error: OBU_PAGE_WAIT_EXPIRED:/);
  await assert.rejects(f.backend.cancelPageWait(old), /OBU_STALE_CONTROL_EPOCH/);
});

test("collection rejection accepts only the scenario's lifecycle code, never success or arbitrary failure", async () => {
  for (const change of ["source-navigation", "child-close"]) {
    await assert.rejects(requireCreatedPageCleanupCollectionRejection(async () => ({ tabId: 8 }), change), /unexpectedly retained/);
    for (const code of ["OBU_PAGE_WAIT_TIMEOUT", "OBU_STALE_CONTROL_EPOCH", "OBU_NATIVE_CONNECTION_LOST", "OBU_CONTROL_RELEASE_FAILED",
      ...(change === "child-close" ? ["OBU_PAGE_WAIT_SOURCE_CHANGED"] : [])])
      await assert.rejects(requireCreatedPageCleanupCollectionRejection(async () => { throw Error(`${code}: different failure`); }, change), /did not match/);
  }
});

test("recovery identity excludes a replaced worker or native host", () => {
  const hostProcess = { ProcessId: 12, ParentProcessId: 11, ExecutablePath: "C:\\fixture\\host.exe", CreationDate: "host-start" };
  const before = { browserPid: 11, browserId: "browser", extensionId: "extension", extensionInstanceId: "instance", workerTarget: "worker", contextId: 4,
    incarnation: "incarnation", observerTarget: "observer", lifecycle: { bootId: "boot" }, host: { pid: 12, socketPath: "pipe", startedAt: "start" },
    hostProcess: { process: hostProcess, ancestry: [hostProcess, { ProcessId: 11, ParentProcessId: 10, ExecutablePath: "C:\\fixture\\browser.exe", CreationDate: "browser-start" }] } };
  assertCreatedPageCleanupIdentity(before, structuredClone(before));
  for (const change of [x => { x.workerTarget = "replacement"; }, x => { x.host.pid++; }, x => { x.lifecycle.bootId = "replacement"; },
    x => { x.hostProcess.process.CreationDate = "PID-reused"; }, x => { delete x.hostProcess; }, x => { x.hostProcess.ancestry.at(-1).ProcessId = 99; }]) {
    const after = structuredClone(before); change(after); assert.throws(() => assertCreatedPageCleanupIdentity(before, after));
  }
});

test("cleanup no-replay gate rejects input after transition and child attachment or read", () => {
  const base = { overflow: false, errors: [], pendingOperations: [], records: [{ kind: "mark", sequence: 1, label: "created-page-cleanup-trigger" }] };
  assertCreatedPageCleanupNoReplay(base, { childId: 8 });
  for (const [api, args] of [["debugger.sendCommand", [{ tabId: 7 }, "Input.dispatchMouseEvent", {}]],
    ["debugger.attach", [{ tabId: 8 }, "1.3"]], ["debugger.sendCommand", [{ tabId: 8 }, "Runtime.evaluate", { expression: "document.body" }]]]) {
    const value = structuredClone(base); value.records.push({ kind: "call", sequence: 2, api, args });
    assert.throws(() => assertCreatedPageCleanupNoReplay(value, { childId: 8 }));
  }
});
