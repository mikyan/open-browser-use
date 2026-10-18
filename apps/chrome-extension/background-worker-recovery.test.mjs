import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./test-support/page-waits-fixture.mjs";

const clone = value => structuredClone(value);
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function until(check) {
  for (let i = 0; i < 200; i++) { if (check()) return; await tick(); }
  throw new Error("original operation did not reach its expected boundary");
}
async function delivered(t) {
  const f = await fixture(t, { managed: true }); f.params.tabId = 7;
  await f.backend.attach(f.params);
  await f.backend.finalizeTabs({ ...f.params, keep: [{ tabId: 7, status: "deliverable" }] });
  f.original = f.backend.managedResults.entries()[0];
  f.recovery = { kind: "worker-replacement", previousWorkerBootId: "fixture-worker-A",
    browserIncarnation: f.backend.managedJournal.identity().browserIncarnation,
    expectedJournalId: f.backend.managedJournal.identity().journalId, expectedWorkerEpoch: 1, nonce: "original-recovery-nonce" };
  f.view = () => f.backend.managedViewerSubscribe(7, () => {}, () => {}, { deliveryId: f.original.deliveryId });
  return f;
}
async function replaceWorker(f) {
  // Destroy only the fixture's JS observers, not its native attachment or
  // persisted stores. This models worker replacement, not Browser shutdown.
  for (const namespace of Object.values(f.chrome)) if (namespace && typeof namespace === "object")
    for (const item of Object.values(namespace)) item?.clear?.();
  f.backend.managedHuman.current = null;
  const next = new f.Backend(); await next.controlReady;
  return next;
}
const recover = (f, next, check = () => {}) => next.prepareManagedUserOpen({ workerBootId: "fixture-worker-B", recovery: f.recovery }, check);

test("explicit replacement joins original view cleanup, issues fresh authority, and preserves the original page", async t => {
  const f = await delivered(t), handle = await f.view(), oldIdentity = f.backend.managedJournal.identity();
  const nativeView = clone(f.backend.managedJournal.state.views[0]);
  assert.equal(nativeView.phase, "attached");
  const next = await replaceWorker(f), before = f.calls.length;
  assert.equal(f.attached.has(7), true);
  await assert.rejects(next.getControlState({ session_id: "task" }), /WORKER_RECOVERY_REQUIRED/);
  await assert.rejects(next.prepareManagedUserOpen({ workerBootId: "fixture-worker-B" }), /explicit worker recovery/);
  assert.equal(f.calls.slice(before).some(([method]) => method === "Page.stopScreencast"), false);
  const token = await recover(f, next);
  assert.deepEqual(clone(token.recoveryState), { ...oldIdentity, workerEpoch: 2 });
  assert.deepEqual(clone(token.workerRecovery), { kind: "worker-replacement", nonce: f.recovery.nonce,
    previousWorkerBootId: "fixture-worker-A", workerBootId: "fixture-worker-B", browserIncarnation: oldIdentity.browserIncarnation,
    journalId: oldIdentity.journalId, fromWorkerEpoch: 1, toWorkerEpoch: 2, inputRiskClear: true, paused: true,
    retiredViews: [{ leaseId: handle.info().leaseId, targetId: "target-7", outcome: "stopped-and-detached", stopAcknowledged: true, detachAcknowledged: true }] });
  next.commitManagedUserOpen(token);
  const current = next.managedResults.entries()[0];
  assert.notEqual(current.deliveryId, f.original.deliveryId);
  assert.equal(current.recordId, f.original.recordId);
  assert.equal(current.targetId, f.original.targetId); assert.equal(current.currentDocument, "root-one");
  assert.equal(next.automationControl.state, "paused"); assert.equal(f.attached.has(7), false);
  assert.throws(() => next.managedResults.get(7, f.original.deliveryId), /RESULT_STALE/);
  assert.throws(() => next.beginManagedHuman(7, () => {}, () => {}, () => {}, { deliveryId: f.original.deliveryId }), /RESULT_STALE/);
  assert.equal(f.calls.slice(before).some(([method]) => method.startsWith("Input.") || ["attach", "group", "remove"].includes(method)), false);
  await assert.rejects(next.getTabs(f.params), /AUTOMATION_PAUSED/);
  assert.deepEqual(next.managedJournal.state.views, []);
});

test("replacement open waits for actual stop, pending original frame ACK, and detach instead of worker death", async t => {
  const f = await delivered(t); await f.view(); const next = await replaceWorker(f);
  const stop = f.gate(), ack = f.gate(), detach = f.gate(); let stopping = false, detaching = false, settled = false;
  f.hooks.command = async (target, method) => {
    if (method === "Page.stopScreencast") {
      stopping = true;
      f.chrome.debugger.onEvent.emit(target, "Page.screencastFrame", { sessionId: 52 });
      await stop.promise;
    }
    if (method === "Page.screencastFrameAck") await ack.promise;
  };
  f.hooks.detach = async tabId => { if (tabId === 7) { detaching = true; await detach.promise; } };
  const opening = recover(f, next).then(value => { settled = true; return value; });
  await until(() => stopping); stop.resolve(); await tick();
  assert.equal(settled, false); assert.equal(detaching, false);
  ack.resolve(); await until(() => detaching);
  assert.equal(settled, false); assert.equal(next.managedJournal.state.views.length, 1);
  detach.resolve(); const token = await opening; next.commitManagedUserOpen(token);
  assert.equal(next.managedJournal.state.views.length, 0);
});

test("replacement seals orphan frame admission after detach before durable view retirement", async t => {
  const f = await delivered(t); await f.view(); const next = await replaceWorker(f);
  const finish = f.gate(), ack = f.gate(); let finishing = false, settled = false;
  const originalFinish = next.managedJournal.finishView.bind(next.managedJournal);
  next.managedJournal.finishView = async leaseId => {
    finishing = true; await finish.promise; return originalFinish(leaseId);
  };
  f.hooks.command = async (_target, method) => { if (method === "Page.screencastFrameAck") await ack.promise; };
  const opening = recover(f, next).then(value => { settled = true; return value; });
  opening.catch(() => {});
  try {
    await until(() => finishing);
    assert.equal(f.attached.has(7), false);
    assert.equal(settled, false); assert.equal(next.managedWorkerOpened, false);
    assert.equal(next.managedJournal.state.views.length, 1);
    const before = f.calls.filter(([method]) => method === "Page.screencastFrameAck").length;
    // This event arrives after the actual detach ACK. It must not be accepted
    // as another cleanup obligation for the retired native attachment.
    f.chrome.debugger.onEvent.emit({ targetId: "target-7" }, "Page.screencastFrame", { sessionId: 91 });
    await tick();
    assert.equal(f.calls.filter(([method]) => method === "Page.screencastFrameAck").length, before);
    finish.resolve(); const token = await opening; next.commitManagedUserOpen(token);
    assert.equal(next.managedJournal.state.views.length, 0);
    assert.equal(token.workerRecovery.retiredViews.length, 1);
  } finally {
    finish.resolve(); ack.resolve(); await opening.catch(() => {});
  }
});

test("replacement drains frames accepted during detach before retiring durable view obligations", async t => {
  for (const outcome of ["acknowledged", "failed"]) await t.test(outcome, async t => {
    const f = await delivered(t); await f.view(); const next = await replaceWorker(f);
    const detach = f.gate(), ack = f.gate(); let detaching = false, settled = false, finishCalls = 0;
    const originalFinish = next.managedJournal.finishView.bind(next.managedJournal);
    next.managedJournal.finishView = async leaseId => { finishCalls++; return originalFinish(leaseId); };
    f.hooks.command = async (_target, method) => {
      if (method === "Page.screencastFrameAck") {
        await ack.promise;
        if (outcome === "failed") throw Error("original frame ACK unknown");
      }
    };
    f.hooks.detach = async tabId => {
      if (tabId !== 7) return;
      detaching = true;
      assert.equal(f.attached.has(7), true);
      f.chrome.debugger.onEvent.emit({ targetId: "target-7" }, "Page.screencastFrame", { sessionId: 92 });
      await detach.promise;
    };
    const opening = recover(f, next).then(value => { settled = true; return value; }, error => { settled = true; throw error; });
    opening.catch(() => {});
    try {
      await until(() => detaching); detach.resolve(); await until(() => !f.attached.has(7)); await tick();
      assert.equal(settled, false); assert.equal(finishCalls, 0);
      assert.equal(next.managedWorkerOpened, false); assert.equal(next.managedPreparedOpen, undefined);
      assert.equal(next.managedJournal.state.views.length, 1);
      ack.resolve();
      if (outcome === "failed") {
        await assert.rejects(opening, /original frame ACK unknown/);
        assert.equal(finishCalls, 0); assert.equal(next.managedJournal.state.views.length, 1);
        assert.equal(next.managedWorkerOpened, false); assert.equal(next.managedPreparedOpen, undefined);
        assert.deepEqual(next.managedResults.entries(), []);
      } else {
        const token = await opening; next.commitManagedUserOpen(token);
        assert.equal(finishCalls, 1); assert.equal(next.managedJournal.state.views.length, 0);
        assert.equal(token.workerRecovery.retiredViews.length, 1);
      }
    } finally {
      detach.resolve(); ack.resolve(); await opening.catch(() => {});
    }
  });
});

test("native cleanup failure preserves original obligations and cannot be bypassed by an initial open", async t => {
  for (const method of ["Page.stopScreencast", "detach"]) await t.test(method, async t => {
    const f = await delivered(t); await f.view(); const next = await replaceWorker(f);
    if (method === "detach") f.hooks.detach = async tabId => { if (tabId === 7) throw Error("original detach unknown"); };
    else f.hooks.command = async (_target, operation) => { if (operation === method) throw Error("original stop unknown"); };
    await assert.rejects(recover(f, next), /original .* unknown/);
    assert.equal(next.managedJournal.state.views.length, 1); assert.equal(f.attached.has(7), true);
    assert.equal(next.managedWorkerOpened, false);
    await assert.rejects(next.prepareManagedUserOpen({ workerBootId: "fixture-worker-B" }), /requires Stop/);
    assert.deepEqual(next.managedResults.entries(), []);
  });
});

test("confirmed current document advance survives replacement without reopening an original URL", async t => {
  const f = await delivered(t), handle = await f.view();
  f.tabs.get(7).url = "https://fixture.test/B";
  Object.assign(f.frameRecords.get(7)[0], { documentId: "document-B", url: f.tabs.get(7).url });
  f.chrome.webNavigation.onCommitted.emit({ tabId: 7, frameId: 0, documentId: "document-B", url: f.tabs.get(7).url });
  await until(() => handle.info().state === "active" && f.original.currentDocument === "document-B");
  assert.equal(f.backend.managedJournal.state.records[0].currentDocument, "document-B");
  const next = await replaceWorker(f), token = await recover(f, next); next.commitManagedUserOpen(token);
  const restored = next.managedResults.entries()[0];
  assert.equal(restored.originalDocument, "root-one"); assert.equal(restored.currentDocument, "document-B");
  assert.equal((await next.getManagedViewerTabs())[0].url, "https://fixture.test/B");
  const watching = await next.managedViewerSubscribe(7, () => {}, () => {}, { deliveryId: restored.deliveryId });
  assert.equal(watching.tabInfo().url, "https://fixture.test/B"); await watching.close();
});

test("durably revoked move-and-return authority never returns from presentation markers", async t => {
  const f = await delivered(t);
  f.chrome.tabs.onMoved.emit(7, {});
  await f.backend.managedResults.drain();
  assert.deepEqual(f.backend.managedJournal.state.records, []);
  const next = await replaceWorker(f), token = await recover(f, next); next.commitManagedUserOpen(token);
  assert.deepEqual(next.managedResults.entries(), []);
  assert.deepEqual(clone(await next.getManagedViewerTabs()), []);
});

test("a native attachment intent without its durable attached ACK refuses replacement without cleanup commands", async t => {
  const f = await delivered(t), row = f.backend.managedJournal.state.records[0];
  await f.backend.managedJournal.beginView({ leaseId: "unknown-view", recordId: row.recordId, tabId: row.tabId, targetId: row.targetId, documentId: row.currentDocument });
  const next = await replaceWorker(f), before = f.calls.length;
  await assert.rejects(recover(f, next), /attachment outcome is unknown/);
  assert.equal(next.managedJournal.writer, undefined);
  assert.equal(f.calls.slice(before).some(([method, tabId]) => method === "Page.stopScreencast" || method === "detach" && tabId === 7 || method.startsWith("Input.")), false);
});

test("held human key and pointer survive only as unknown durable risk, never as an empty replacement tracker", async t => {
  const f = await delivered(t), handle = await f.backend.beginManagedHuman(7, () => {}, () => {}, () => {}, { deliveryId: f.original.deliveryId });
  const info = handle.info();
  for (const [index, input] of [
    { type: "key", action: "down", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, modifiers: 8 },
    { type: "pointer", action: "down", button: "left", x: 20, y: 20, modifiers: 8 }
  ].entries()) await handle.input({ leaseId: info.leaseId, generation: info.generation, sequence: index + 1, input });
  const before = f.calls.length, next = await replaceWorker(f);
  await assert.rejects(recover(f, next), /INPUT_RELEASE_UNCONFIRMED/);
  assert.equal(next.managedJournal.writer, undefined);
  assert.equal(f.attached.has(7), true);
  assert.equal(f.calls.slice(before).some(([method]) => method.startsWith("Input.") || method === "detach" || method === "Page.stopScreencast"), false);
  assert.equal(next.browserLifetime.recovered.size, 1);
});

test("changed target, document or placement cannot create replacement result authority", async t => {
  for (const kind of ["target", "document", "position"]) await t.test(kind, async t => {
    const f = await delivered(t), next = await replaceWorker(f);
    if (kind === "target") f.hooks.targets = () => [{ id: "foreign-target", tabId: 7, type: "page" }];
    if (kind === "document") f.frameRecords.get(7)[0].documentId = "unobserved-document";
    if (kind === "position") f.tabs.get(7).windowId = 2;
    await assert.rejects(recover(f, next), /RESULT_STALE|UNAVAILABLE/);
    assert.equal(next.managedWorkerOpened, false); assert.deepEqual(next.managedResults.entries(), []);
  });
});
