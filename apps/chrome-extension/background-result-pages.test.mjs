import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "./test-support/page-waits-fixture.mjs";

const clone = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function delivered(t, status = "deliverable") {
  const f = await fixture(t, { managed: true });
  f.params.tabId = 7;
  await f.backend.attach(f.params);
  f.ended = await f.backend.finalizeTabs({ ...f.params, keep: [{ tabId: 7, status }] });
  f.record = f.backend.managedResults.entries()[0];
  assert.ok(f.record);
  return f;
}
const view = (f, frames = []) => f.backend.managedViewerSubscribe(7, frame => frames.push(frame), () => {}, { deliveryId: f.record.deliveryId }, () => {});

test("only successful explicit finalize publishes native result identity; turnEnded and markers do not", async t => {
  const f = await delivered(t);
  assert.equal(f.backend.attachmentOwners.size, 0);
  assert.deepEqual(clone(await f.backend.getManagedViewerTabs()), [{ id: 7, title: "", url: "https://fixture.test/main", kind: "result", deliveryId: f.record.deliveryId, watchable: true, takeover: true }]);
  assert.equal(f.record.targetId, "target-7"); assert.equal(f.record.currentDocument, "root-one");
  const restarted = new f.Backend(); await restarted.controlReady;
  assert.deepEqual(clone(await restarted.getManagedViewerTabs()), []);
  const ended = await fixture(t, { managed: true });
  await ended.backend.attach({ ...ended.params, tabId: 7 });
  await ended.backend.turnEnded(ended.params);
  assert.deepEqual(ended.backend.managedResults.entries(), []);
});

test("finalization publishes inside its original fence after storage and native validation", async t => {
  const f = await fixture(t, { managed: true }); f.params.tabId = 7;
  await f.backend.attach(f.params);
  const entered = f.gate(), release = f.gate(); let captured = false, committed = false;
  f.hooks.targets = async () => {
    if (f.backend.endingSessions.has("task") && !captured) { captured = true; entered.resolve(); await release.promise; }
  };
  const original = f.backend.managedResults.publish.bind(f.backend.managedResults);
  f.backend.managedResults.publish = records => {
    assert.equal(f.backend.endingSessions.has("task"), true);
    assert.equal(f.backend.controlLedger.records.get("task").status, "idle");
    original(records); committed = true;
  };
  const finishing = f.backend.finalizeTabs({ ...f.params, keep: [{ tabId: 7, status: "handoff" }] });
  await entered.promise;
  assert.deepEqual(f.backend.managedResults.entries(), []);
  const next = await f.backend.getControlState({ session_id: "task" });
  await assert.rejects(f.backend.attach(f.fresh(f.params, next)), /ENDING/);
  release.resolve(); await finishing;
  assert.equal(committed, true); assert.equal(f.backend.endingSessions.size, 0);
});

test("final storage or original document failure never publishes a result", async t => {
  for (const failure of ["storage", "document", "target"]) await t.test(failure, async t => {
    const f = await fixture(t, { managed: true }); f.params.tabId = 7; await f.backend.attach(f.params);
    if (failure === "storage") f.hooks.write = () => { if (f.backend.endingSessions.has("task")) throw new Error("original storage failed"); };
    else if (failure === "document") f.hooks.frame = () => { if (f.backend.endingSessions.has("task")) f.frameRecords.get(7)[0].documentId = "replacement"; };
    else f.hooks.targets = () => f.backend.endingSessions.has("task") ? [{ id: "replacement", tabId: 7, type: "page" }] : undefined;
    await assert.rejects(f.backend.finalizeTabs({ ...f.params, keep: [{ tabId: 7, status: "handoff" }] }));
    assert.deepEqual(f.backend.managedResults.entries(), []); assert.equal(f.backend.managedResults.records.size, 0);
  });
});

test("user view owns an independent native stream in running and paused control without input", async t => {
  const f = await delivered(t), frames = [];
  const handle = await view(f, frames);
  assert.equal(typeof handle.input, "undefined"); assert.equal(handle.info().state, "active");
  assert.equal(frames[0].controlMode, "user-view"); assert.equal(frames[0].viewLeaseId, handle.info().leaseId);
  assert.equal(f.backend.automationControl.state, "running");
  await handle.close(); await f.backend.pauseAutomation();
  const paused = await view(f); assert.equal(paused.info().state, "active");
  assert.equal(f.backend.automationControl.state, "paused"); await paused.close();
});

test("old or paused task requests cannot revoke the result or close its original view", async t => {
  const f = await delivered(t, "handoff"), handle = await view(f);
  const requests = [() => f.backend.attach(f.params), () => f.backend.claimUserTab(f.params),
    () => f.backend.browserAction({ ...f.params, action: "snapshot" }),
    () => f.backend.executeCdp({ ...f.params, target: { tabId: 7 }, method: "Runtime.evaluate", commandParams: { expression: "1" } })];
  for (const request of requests) { await assert.rejects(request(), /STALE_CONTROL_EPOCH/); assert.equal(handle.info().state, "active"); assert.equal(f.backend.managedResults.get(7, f.record.deliveryId), f.record); }
  await handle.close(); await f.backend.pauseAutomation();
  const paused = await view(f);
  for (const request of requests) { await assert.rejects(request(), /AUTOMATION_PAUSED/); assert.equal(paused.info().state, "active"); assert.equal(f.backend.managedResults.get(7, f.record.deliveryId), f.record); }
  await paused.close();
});

test("new task admission revokes immediately but waits original view detach before native attach", async t => {
  const f = await delivered(t, "handoff"), handle = await view(f), entered = f.gate(), release = f.gate();
  const next = f.fresh(f.params, f.ended); let finished = false;
  f.hooks.detach = () => { entered.resolve(); return release.promise; };
  const attaching = f.backend.attach(next).then(() => { finished = true; });
  await entered.promise;
  assert.equal(f.backend.managedResults.records.size, 0); assert.equal(handle.info().state, "releasing");
  await tick(); assert.equal(finished, false);
  release.resolve(); await attaching;
  assert.equal(handle.info().state, "released"); assert.equal(finished, true);
});

test("unconfirmed view cleanup blocks task admission and never restores a revoked delivery", async t => {
  const f = await delivered(t, "handoff"), handle = await view(f);
  const before = f.calls.filter(([method]) => method === "attach").length;
  f.hooks.detach = () => { throw new Error("native detach unconfirmed"); };
  await assert.rejects(f.backend.attach(f.fresh(f.params, f.ended)), /native detach unconfirmed/);
  assert.equal(f.backend.managedResults.records.size, 0);
  assert.equal(f.calls.filter(([method]) => method === "attach").length, before);
  assert.equal(handle.info().state, "error");
  delete f.hooks.detach; await handle.close();
});

test("navigation after an earlier final page proof aborts the whole original publication", async t => {
  const f = await fixture(t, { managed: true }); f.params.tabId = 7;
  f.tabs.set(6, { id: 6, windowId: 1, groupId: 10, pinned: false, url: "https://fixture.test/second" });
  f.frameRecords.set(6, [{ frameId: 0, parentFrameId: -1, documentId: "second", url: "https://fixture.test/second" }]);
  await f.backend.attach(f.params);
  let invalidated = false;
  f.hooks.frame = tabId => {
    if (tabId === 6 && f.backend.managedResults.records.get(7)?.phase === "verified") {
      invalidated = true; f.frameRecords.get(7)[0].documentId = "new-original";
      f.chrome.webNavigation.onCommitted.emit({ tabId: 7, frameId: 0, documentId: "new-original", url: f.tabs.get(7).url });
    }
  };
  await assert.rejects(f.backend.finalizeTabs({ ...f.params, keep: [{ tabId: 7, status: "handoff" }, { tabId: 6, status: "handoff" }] }), /RESULT_STALE/);
  assert.equal(invalidated, true); assert.equal(f.backend.managedResults.records.size, 0);
});

test("Pause while a result listing awaits native proof hides it without deleting its authority", async t => {
  const f = await delivered(t), entered = f.gate(), release = f.gate();
  let first = true;
  f.hooks.frame = async () => { if (first) { first = false; entered.resolve(); await release.promise; } };
  const listing = f.backend.getManagedViewerTabs(); await entered.promise;
  f.backend.automationControl.state = "pausing";
  release.resolve(); assert.deepEqual(clone(await listing), []);
  assert.equal(f.backend.managedResults.get(7, f.record.deliveryId), f.record);
  f.backend.automationControl.state = "running";
});

test("result human operation advances the exact document and can be viewed again after End", async t => {
  const f = await delivered(t), handle = await f.backend.beginManagedHuman(7, () => {}, () => {}, () => {}, { deliveryId: f.record.deliveryId });
  assert.equal(f.backend.automationControl.state, "paused");
  f.frameRecords.get(7)[0].documentId = "B"; f.frameRecords.get(7)[0].url = "https://fixture.test/B"; f.tabs.get(7).url = "https://fixture.test/B";
  const candidate = await f.backend.validateManagedHumanPage(f.backend.managedHuman.current.candidate, { advance: true });
  assert.equal(candidate.documentId, "B"); assert.equal(f.record.currentDocument, "B");
  await handle.close(); const watching = await view(f); assert.equal(watching.info().state, "active"); await watching.close();
  assert.equal(f.backend.automationControl.state, "paused");
});

test("real result lease navigation recovers native B frames and End permits a fresh view of B", async t => {
  for (const mode of ["view", "human"]) await t.test(mode, async t => {
    const f = await delivered(t), frames = [];
    const handle = mode === "view" ? await view(f, frames) :
      await f.backend.beginManagedHuman(7, () => {}, frame => frames.push(frame), () => {}, { deliveryId: f.record.deliveryId });
    const lease = handle.info().leaseId, generation = handle.info().generation;
    Object.assign(f.frameRecords.get(7)[0], { documentId: "B", url: "https://fixture.test/B" });
    f.tabs.get(7).url = "https://fixture.test/B";
    f.chrome.webNavigation.onCommitted.emit({ tabId: 7, frameId: 0, documentId: "B", url: "https://fixture.test/B" });
    assert.equal(handle.info().state, "navigating");
    for (let i = 0; i < 100 && handle.info().state === "navigating"; i++) await tick();
    assert.equal(handle.info().state, "active"); assert.equal(handle.info().leaseId, lease);
    assert.ok(handle.info().generation > generation); assert.equal(f.record.currentDocument, "B");
    assert.equal(frames.at(-1).generation, handle.info().generation);
    await handle.close();
    const watching = await view(f); assert.equal(watching.tabInfo().url, "https://fixture.test/B");
    await watching.close();
  });
});

test("navigation listing keeps original result but cannot grant a new capture before document proof", async t => {
  const f = await delivered(t), handle = await view(f);
  f.frameRecords.get(7)[0].documentId = "B";
  f.backend.managedHuman.current.state = "navigating";
  const listed = await f.backend.getManagedViewerTabs();
  assert.equal(listed[0].deliveryId, f.record.deliveryId);
  assert.equal(f.record.currentDocument, "root-one");
  await handle.close();
  await assert.rejects(view(f), /RESULT_STALE/); assert.equal(f.backend.managedResults.records.size, 0);
});

test("retired B document verification cannot revoke or overwrite the current C result authority", async t => {
  for (const outcome of ["failed-read", "late-success"]) await t.test(outcome, async t => {
    const f = await delivered(t), handle = await view(f), entered = f.gate(), release = f.gate();
    const owner = f.backend.managedHuman.current, original = owner.candidate, oldEpoch = owner.epoch;
    f.frameRecords.get(7)[0].documentId = "B";
    let first = true;
    f.hooks.frame = async () => {
      if (!first) return; first = false; entered.resolve(); await release.promise;
      if (outcome === "failed-read") throw new Error("old B document disappeared");
    };
    const proof = f.backend.validateManagedHumanPage(original, { advance: true }); proof.catch(() => {});
    await entered.promise;
    oldEpoch.retired = true;
    owner.epoch = { ...oldEpoch, id: oldEpoch.id + 1, retired: false };
    owner.generation++; f.frameRecords.get(7)[0].documentId = "C";
    f.record.currentDocument = "C";
    release.resolve(); await assert.rejects(proof, /old B|GENERATION_STALE/);
    assert.equal(f.backend.managedResults.get(7, f.record.deliveryId), f.record);
    assert.equal(f.record.currentDocument, "C");
    // This test advances only the validation seam; restore the actual native
    // resource tracker so its original close still proves cleanup.
    owner.epoch = oldEpoch; oldEpoch.retired = false;
    await handle.close();
  });
});

test("active result status uses the current lease metadata without a competing native document read", async t => {
  const f = await delivered(t), handle = await view(f);
  f.backend.managedHuman.current.state = "navigating";
  f.hooks.frame = () => { throw new Error("status must not read a second document"); };
  f.hooks.targets = () => { throw new Error("status must not open an independent target proof"); };
  const listed = await f.backend.getManagedViewerTabs();
  assert.equal(listed[0].deliveryId, f.record.deliveryId); assert.equal(listed[0].url, "");
  delete f.hooks.frame; delete f.hooks.targets; await handle.close();
});

test("a status read started before view admission cannot later revoke the newly admitted original lease", async t => {
  const f = await delivered(t), entered = f.gate(), release = f.gate(); let first = true;
  f.hooks.frame = async () => {
    if (!first) return; first = false; entered.resolve(); await release.promise; throw new Error("old status read failed");
  };
  const listing = f.backend.getManagedViewerTabs(); await entered.promise;
  const handle = await view(f); release.resolve();
  const listed = await listing;
  assert.equal(listed[0].deliveryId, f.record.deliveryId);
  assert.equal(f.backend.managedResults.get(7, f.record.deliveryId), f.record);
  assert.equal(handle.info().state, "active"); await handle.close();
});

test("original result moves, replacement and outside navigation withdraw its delivery capability", async t => {
  for (const event of ["move", "replace", "navigate"]) await t.test(event, async t => {
    const f = await delivered(t);
    if (event === "move") f.chrome.tabs.onMoved.emit(7, { windowId: 1, fromIndex: 0, toIndex: 1 });
    else if (event === "replace") f.chrome.tabs.onReplaced.emit(8, 7);
    else f.chrome.webNavigation.onBeforeNavigate.emit({ tabId: 7, frameId: 0, url: "https://fixture.test/B" });
    await assert.rejects(view(f), /RESULT_STALE/); assert.equal(f.backend.managedResults.records.size, 0);
  });
});
