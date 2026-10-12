import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "./test-support/page-waits-fixture.mjs";

const AUX_KEY = "OPEN_BROWSER_USE_AUXILIARY_TABS", sourceId = 7, childId = 8;
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function until(check, label) {
  for (let count = 0; count < 100; count++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 0)); }
  assert.fail(`Fixture did not reach ${label}`);
}

async function prepared(t) {
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
  return Object.assign(f, { scope, record, waiterId: ack.waiterId, claim: f.backend.auxiliaryTabs.owner(childId), adoptions: () => adoptions, before: f.calls.length });
}

function navigate(f, tabId = sourceId) {
  const url = `https://fixture.test/replaced-${tabId}`;
  f.chrome.webNavigation.onBeforeNavigate.emit({ tabId, frameId: 0, url });
  f.tabs.get(tabId).url = url;
  f.frameRecords.set(tabId, [{ frameId: 0, parentFrameId: -1, documentId: `replacement-root-${tabId}`, url }]);
  f.chrome.webNavigation.onCommitted.emit({ tabId, frameId: 0, parentFrameId: -1, documentId: `replacement-root-${tabId}`, url });
}

const deletes = (area, value, tabId = childId) => area === "session" && value[AUX_KEY] && !value[AUX_KEY].records.some(record => record.tabId === tabId);
function notReplayed(f, adoptions = 1) {
  assert.equal(f.adoptions(), adoptions, "Recovery never replays original child adoption");
  assert.equal(f.calls.slice(f.before).some(([method]) => method.startsWith("Input.")), false, "Recovery sends no new input");
}
async function restore(f) {
  delete f.hooks.write;
  await f.backend.pageWaits.retryFailedCleanup();
}

for (const change of ["source navigation", "child close"]) {
  for (const recovery of ["session bootstrap", "Retry Pause"]) {
    test(`${recovery} recovers failed created-page deletion after ${change}`, { timeout: 3000 }, async t => {
      // Real production registries/backend with simulated Chrome events and a
      // transient storage rejection; no real browser or storage fault injected.
      const f = await prepared(t);
      f.hooks.write = async (area, value) => {
        if (area === "session" && value[AUX_KEY] && !value[AUX_KEY].records.some(record => record.tabId === childId))
          throw new Error("fixture original child deletion rejected");
      };
      try {
        if (change === "source navigation") {
          navigate(f);
        } else await f.chrome.tabs.remove(childId);
        await until(() => f.record.cleanupSettled, "original failed conditional cleanup");
        assert.equal(f.record.invalid, true); assert.equal(f.record.delivered, undefined);
        assert.match(f.record.cleanupError.message, /original child deletion rejected/);
        assert.equal(f.backend.pageWaits.byTab.get(sourceId), f.record);
        assert.equal(f.backend.auxiliaryTabs.owner(childId), undefined);
        assert.equal(f.backend.auxiliaryTabs.entry(childId), f.claim);
        assert.equal(f.claim.phase, "quarantined");
        if (recovery === "session bootstrap") {
          await assert.rejects(f.backend.turnEnded(f.scope), /OBU_CONTROL_RELEASE_FAILED/);
          assert.equal(f.backend.controlLedger.records.get("task").status, "closing");
          await assert.rejects(f.backend.cancelPageWait({ ...f.scope, waiterId: f.waiterId }), /OBU_STALE_CONTROL_EPOCH|OBU_CONTROL_ENDING/);
        } else {
          await assert.rejects(f.backend.pauseAutomation(), /OBU_AUTOMATION_PAUSE_FAILED/);
          assert.equal(f.backend.automationControl.inputBlocked, true);
          await assert.rejects(f.backend.cancelPageWait({ ...f.scope, waiterId: f.waiterId }), /OBU_AUTOMATION_PAUSED/);
        }
        delete f.hooks.write;
        if (recovery === "Retry Pause") {
          const status = await f.backend.pauseAutomation();
          assert.equal(status.state, "paused"); assert.equal(status.cleanupComplete, true);
          await f.backend.resumeAutomation(status.revision);
        }
        const fresh = await f.backend.getControlState({ session_id: "task" });
        assert.ok(fresh.controlEpoch > f.scope.control_epoch);
        assert.equal(f.record.cleaned, true); assert.ok(f.record.cleanupAttempts >= 2);
        assert.equal(f.backend.pageWaits.byTab.has(sourceId), false);
        assert.equal(f.backend.auxiliaryTabs.entry(childId), undefined);
        assert.equal(f.session[AUX_KEY].records.some(record => record.tabId === childId), false);
        const scope = f.fresh(f.scope, fresh);
        assert.deepEqual(Array.from(await f.backend.getTabs(scope), tab => tab.id), [sourceId]);
        await assert.rejects(f.backend.attach({ ...scope, tabId: childId }), /not part of browser session|No tab/);
        const next = await f.backend.armPageWait({ ...scope, timeoutMs: 1000 });
        await f.backend.cancelPageWait({ ...scope, waiterId: next.waiterId });
        notReplayed(f);
        assert.equal(f.tabs.has(childId), change !== "child close");
      } finally {
        delete f.hooks.write;
        // Restore fixture-only resources when this counterexample runs against
        // unfixed code, without converting that public recovery failure to pass.
        await f.backend.pageWaits.retryFailedCleanup();
      }
    });
  }
}

test("session bootstrap retries only its own failed child cleanup", { timeout: 3000 }, async t => {
  const f = await prepared(t), foreignChild = 11, foreignSource = 9;
  f.tabs.set(foreignChild, { id: foreignChild, groupId: -1, windowId: 3, url: "https://fixture.test/foreign-popup", active: false });
  f.frameRecords.set(foreignSource, [{ frameId: 0, parentFrameId: -1, documentId: "foreign-root", url: f.tabs.get(foreignSource).url }]);
  const foreignScope = { ...f.foreign, tabId: foreignSource };
  const ack = await f.backend.armPageWait({ ...foreignScope, timeoutMs: 5000 });
  const foreign = f.backend.pageWaits.records.get(ack.waiterId);
  f.chrome.webNavigation.onCreatedNavigationTarget.emit({ sourceTabId: foreignSource, sourceFrameId: 0,
    sourceProcessId: 4, tabId: foreignChild, url: f.tabs.get(foreignChild).url });
  await foreign.completion.promise;
  const foreignClaim = f.backend.auxiliaryTabs.owner(foreignChild);
  f.hooks.write = async (area, value) => {
    if (deletes(area, value) || deletes(area, value, foreignChild)) throw new Error("fixture both child deletions failed");
  };
  try {
    navigate(f); navigate(f, foreignSource);
    await until(() => f.record.cleanupSettled && foreign.cleanupSettled, "both failed child cleanups");
    await assert.rejects(f.backend.turnEnded(f.scope), /OBU_CONTROL_RELEASE_FAILED/);
    delete f.hooks.write;
    const fresh = await f.backend.getControlState({ session_id: "task" });
    assert.equal(fresh.closing, false);
    assert.equal(f.record.cleaned, true); assert.equal(f.record.cleanupAttempts, 2);
    assert.equal(foreign.cleanupAttempts, 1); assert.equal(foreign.cleaned, undefined);
    assert.equal(f.backend.pageWaits.byTab.get(foreignSource), foreign);
    assert.equal(f.backend.auxiliaryTabs.entry(foreignChild), foreignClaim);
    assert.equal(foreignClaim.phase, "quarantined");
    assert.equal(f.session[AUX_KEY].records.some(record => record.tabId === foreignChild), true);
    notReplayed(f, 2);
  } finally { await restore(f); }
});

for (const recovery of ["session bootstrap", "Retry Pause"]) {
  for (const previous of ["original pending cleanup", "pending explicit retry"]) {
    test(`${recovery} shares ${previous} without duplicate deletion`, { timeout: 3000 }, async t => {
      const f = await prepared(t), gate = f.gate();
      let failing = previous === "pending explicit retry", deletions = 0, finished = false;
      f.hooks.write = async (area, value) => {
        if (!deletes(area, value)) return;
        if (failing) throw new Error("fixture first deletion failed");
        deletions++; await gate.promise;
      };
      try {
        navigate(f);
        let first;
        if (failing) {
          await until(() => f.record.cleanupSettled, "settled original failure");
          await assert.rejects(recovery === "session bootstrap" ? f.backend.turnEnded(f.scope) : f.backend.pauseAutomation(), /fixture first deletion failed/);
          failing = false;
          first = recovery === "session bootstrap" ? f.backend.getControlState({ session_id: "task" }) : f.backend.pauseAutomation();
        } else {
          first = recovery === "session bootstrap" ? f.backend.turnEnded(f.scope) : f.backend.pauseAutomation();
        }
        first.then(() => { finished = true; }, () => {});
        await until(() => deletions === 1, "actual pending deletion");
        if (recovery === "session bootstrap") await until(() => f.backend.controlLedger.records.get("task").status === "closing", "closing session fence");
        const attempts = f.record.cleanupAttempts;
        const second = recovery === "session bootstrap" ? f.backend.getControlState({ session_id: "task" }) : f.backend.pauseAutomation();
        second.catch(() => {});
        if (recovery === "session bootstrap") {
          // A concurrent bootstrap reports closing under the existing contract;
          // it must not grant ordinary-operation authority or start another retry.
          const status = await second;
          assert.equal(status.closing, true);
          await assert.rejects(f.backend.getTabs(f.fresh(f.scope, status)), /OBU_CONTROL_ENDING/);
        } else assert.equal(f.backend.automationControl.inputBlocked, true);
        await tick();
        assert.equal(finished, false); assert.equal(f.record.cleanupSettled, false);
        assert.equal(f.record.cleanupAttempts, attempts); assert.equal(deletions, 1);
        gate.resolve(); await Promise.all([first, second]);
        assert.equal(f.record.cleaned, true); assert.equal(deletions, 1);
        assert.equal(f.record.cleanupAttempts, attempts);
        notReplayed(f);
      } finally { failing = false; gate.resolve(); await restore(f); }
    });
  }

  test(`${recovery} stays fenced through repeated cleanup failures`, { timeout: 3000 }, async t => {
    const f = await prepared(t);
    f.hooks.write = async (area, value) => {
      if (deletes(area, value)) throw new Error(`fixture child deletion attempt ${f.record.cleanupAttempts}`);
    };
    try {
      navigate(f);
      await until(() => f.record.cleanupSettled, "original failure");
      await assert.rejects(recovery === "session bootstrap" ? f.backend.turnEnded(f.scope) : f.backend.pauseAutomation(), /fixture child deletion attempt/);
      const attempts = f.record.cleanupAttempts;
      await assert.rejects(recovery === "session bootstrap" ? f.backend.getControlState({ session_id: "task" }) : f.backend.pauseAutomation(), new RegExp(`fixture child deletion attempt ${attempts + 1}`));
      assert.equal(f.record.cleanupAttempts, attempts + 1);
      assert.match(f.record.cleanupError.message, new RegExp(`attempt ${attempts + 1}`));
      assert.equal(f.record.cleaned, undefined);
      assert.equal(f.backend.pageWaits.byTab.get(sourceId), f.record);
      assert.equal(f.backend.auxiliaryTabs.entry(childId), f.claim);
      assert.equal(f.claim.phase, "quarantined");
      await assert.rejects(f.backend.getTabs(f.scope), /OBU_STALE_CONTROL_EPOCH|OBU_CONTROL_ENDING|OBU_AUTOMATION_PAUSED/);
      delete f.hooks.write;
      if (recovery === "Retry Pause") {
        const status = await f.backend.pauseAutomation();
        assert.equal(status.cleanupComplete, true);
        await f.backend.resumeAutomation(status.revision);
      }
      assert.equal((await f.backend.getControlState({ session_id: "task" })).closing, false);
      assert.equal(f.record.cleanupAttempts, attempts + 2);
      assert.equal(f.record.cleaned, true);
      notReplayed(f);
    } finally { await restore(f); }
  });
}

test("automatic recovery and automatic Pause do not retry settled failed page cleanup", { timeout: 3000 }, async t => {
  const f = await prepared(t);
  f.hooks.write = async (area, value) => { if (deletes(area, value)) throw new Error("fixture original deletion failed"); };
  try {
    navigate(f);
    await until(() => f.record.cleanupSettled, "original failure");
    await assert.rejects(f.backend.turnEnded(f.scope), /fixture original deletion failed/);
    delete f.hooks.write;
    await assert.rejects(f.backend.recoverEndedSession("task", f.backend.controlLedger.records.get("task")), /fixture original deletion failed/);
    assert.equal(f.record.cleanupAttempts, 1);
    await assert.rejects(f.backend.pauseAutomation({ retryPageCleanup: false }), /fixture original deletion failed/);
    assert.equal(f.record.cleanupAttempts, 1);
    assert.equal(f.backend.automationControl.inputBlocked, true);
    assert.equal((await f.backend.pauseAutomation()).cleanupComplete, true);
    assert.equal(f.record.cleanupAttempts, 2);
    notReplayed(f);
  } finally { await restore(f); }
});
