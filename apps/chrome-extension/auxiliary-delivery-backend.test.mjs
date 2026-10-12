import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "./test-support/page-waits-fixture.mjs";

const AUX_KEY = "OPEN_BROWSER_USE_AUXILIARY_TABS";
const STATE_KEY = "OPEN_BROWSER_USE_SESSION_STATE";
const changed = /OBU_AUXILIARY_DELIVERY_CHANGED/;
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const clone = value => structuredClone(value);
const denied = /not part of browser session|OBU_AUXILIARY_|STALE_CONTROL_EPOCH|CONTROL_ENDING|TURN_ENDED/i;
async function until(check, label) {
  for (let attempt = 0; attempt < 100; attempt++) { if (check()) return; await tick(); }
  throw new Error(`Fixture did not reach ${label}`);
}

async function deliveryFixture(t) {
  const f = await fixture(t), attach = f.backend.browserEngine.attach;
  // The page-wait helper stubs the native Page, but delivery also exercises
  // input cleanup. Run the production post-attach hook so every stub-created
  // attachment has the same input-tracker registration as a real CRX Page.
  f.backend.browserEngine.attach = async tabId => {
    await attach(tabId);
    await f.backend.registerEngineAttachment(tabId);
  };
  return f;
}

async function owned(t, kind = "popup") {
  const f = await deliveryFixture(t);
  if (kind === "created-page") {
    const source = { ...f.params, tabId: 7 };
    const armed = await f.backend.armPageWait({ ...source, timeoutMs: 2000 });
    f.chrome.webNavigation.onCreatedNavigationTarget.emit({ sourceTabId: 7, sourceFrameId: 0,
      sourceProcessId: 4, tabId: 8, url: f.tabs.get(8).url, timeStamp: 1 });
    assert.equal((await f.backend.collectPageWait({ ...source, waiterId: armed.waiterId })).tabId, 8);
    await f.backend.cancelPageWait({ ...source, waiterId: armed.waiterId });
  } else await f.backend.claimUserTab(f.params);
  assert.equal(f.backend.auxiliaryTabs.owner(8).kind, kind);
  // These tests exercise real Backend/native-detach paths, not the helper's
  // engine stub. The stub is needed only for public created-page readiness.
  f.backend.browserEngine = undefined;
  await f.backend.attach(f.params);
  return f;
}

const finishing = f => f.backend.finalizeTabs({ ...f.params, keep: [{ tabId: 8, status: "deliverable" }] });
const outcome = promise => promise.then(value => ({ value }), error => ({ error }));
const marker = f => f.backend.store.state.deliverableTabs?.[8];
const persistedMarker = f => f.local[STATE_KEY]?.deliverableTabs?.[8];
function noDisposition(f, from, id = 8) {
  assert.equal(f.calls.slice(from).some(([name, ids]) => ["group", "ungroup", "remove"].includes(name) && [].concat(ids).includes(id)), false);
}
function holdDetach(f) {
  const gate = f.gate(); let entered = false;
  f.hooks.detach = async id => { if (id === 8 && !entered) { entered = true; await gate.promise; } };
  return { gate, ready: () => entered };
}
function holdDeliveryWrite(f) {
  const gate = f.gate(); let entered = false;
  f.hooks.write = async (area, value) => {
    if (area === "local" && value[STATE_KEY]?.deliverableTabs?.[8] && !entered) { entered = true; await gate.promise; }
  };
  return { gate, ready: () => entered };
}
function holdFinalDeliveryProof(f) {
  const gate = f.gate(); let entered = false;
  f.hooks.getTab = async id => {
    if (id === 8 && marker(f) && persistedMarker(f) && !entered) { entered = true; await gate.promise; }
  };
  return { gate, ready: () => entered };
}
async function promptly(promise, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Fixture request hung at ${label}`)), 1000);
    })]);
  } finally { clearTimeout(timer); }
}
async function assertSessionStillClosing(f) {
  const state = await promptly(f.backend.getControlState({ session_id: "task" }), "closing bootstrap");
  assert.equal(state.closing, true, "Bootstrap must not advertise reusable control before final acknowledgement");
  const fresh = f.fresh(f.params, state);
  await assert.rejects(f.backend.getTabs(fresh), /OBU_CONTROL_ENDING/);
  await assert.rejects(f.backend.attach(fresh), /OBU_CONTROL_ENDING/);
  return state;
}

function assertPreserved(f, before, from) {
  assert.deepEqual(f.tabs.get(8), before);
  assert.equal(f.attached.has(8), false);
  assert.equal(f.backend.auxiliaryTabs.entry(8), undefined);
  assert.equal((f.session[AUX_KEY]?.records ?? []).some(record => record.tabId === 8), false);
  assert.equal(f.calls.slice(from).some(([name, ids]) => ["group", "ungroup", "remove"].includes(name) && [].concat(ids).includes(8)), false);
  assert.equal(f.backend.store.state.deliverableTabs?.[8]?.windowId, before.windowId);
}

test("mixed finalization closes only agent work, releases user work, and keeps handoff and native deliverables distinct", async t => {
  const f = await deliveryFixture(t);
  f.tabs.set(10, { id: 10, groupId: 10, windowId: 1, url: "https://fixture.test/user", active: false });
  f.tabs.set(11, { id: 11, groupId: -1, windowId: 3, url: "https://fixture.test/child", active: true });
  f.tabs.set(12, { id: 12, groupId: -1, windowId: 2, url: "https://fixture.test/handoff", active: false });
  (await f.backend.store.getSession("task")).tabOrigins[10] = "user";
  await f.backend.store.save();
  const source = { ...f.params, tabId: 7 };
  const armed = await f.backend.armPageWait({ ...source, timeoutMs: 2000 });
  f.chrome.webNavigation.onCreatedNavigationTarget.emit({ sourceTabId: 7, sourceFrameId: 0,
    sourceProcessId: 4, tabId: 11, url: f.tabs.get(11).url, timeStamp: 1 });
  assert.equal((await f.backend.collectPageWait({ ...source, waiterId: armed.waiterId })).tabId, 11);
  await f.backend.cancelPageWait({ ...source, waiterId: armed.waiterId });
  await f.backend.claimUserTab(f.params);
  await f.backend.claimUserTab({ ...f.params, tabId: 12 });
  assert.equal(f.backend.auxiliaryTabs.owner(11).origin, "user");
  f.backend.browserEngine = undefined;
  for (const tabId of [7, 8, 10, 11, 12]) await f.backend.attach({ ...f.params, tabId });
  const before = new Map([8, 9, 11, 12].map(id => [id, clone(f.tabs.get(id))])), from = f.calls.length;
  const result = await f.backend.finalizeTabs({ ...f.params, keep: [
    { tabId: 8, status: "deliverable" }, { tabId: 11, status: "deliverable" }, { tabId: 12, status: "handoff" }
  ] });
  assert.equal(f.tabs.has(7), false);
  assert.equal(f.tabs.get(10).groupId, -1);
  for (const id of [8, 9, 11, 12]) { assert.deepEqual(f.tabs.get(id), before.get(id)); noDisposition(f, from, id); }
  for (const id of [8, 11]) {
    assert.equal(f.backend.auxiliaryTabs.entry(id), undefined);
    assert.equal(f.backend.store.state.deliverableTabs[id].windowId, before.get(id).windowId);
  }
  assert.equal(f.backend.auxiliaryTabs.owner(12).origin, "user");
  assert.equal(f.backend.store.state.deliverableTabs[12], undefined);
  assert.equal(f.attached.size, 0);
  const next = f.fresh(f.params, result);
  assert.deepEqual(Array.from(await f.backend.getTabs(next), tab => tab.id), [12]);
  await f.backend.attach({ ...next, tabId: 12 });
  for (const tabId of [8, 10, 11]) await assert.rejects(f.backend.attach({ ...next, tabId }), denied);
});

test("a pending native release cannot acknowledge delivery or start tab disposition", async t => {
  const f = await owned(t), hold = holdDetach(f), from = f.calls.length;
  let settled = false;
  const pending = outcome(finishing(f)).finally(() => { settled = true; });
  await until(hold.ready, "native detach");
  await tick();
  assert.equal(settled, false); assert.equal(marker(f), undefined); assert.equal(persistedMarker(f), undefined);
  assert.equal(f.tabs.has(7), true); assert.equal(f.attached.has(8), true); noDisposition(f, from);
  hold.gate.resolve();
  const result = await pending; assert.equal(result.error, undefined);
  assert.equal(f.attached.has(8), false); assert.ok(persistedMarker(f));
});

test("native release failure fences finalization until explicit cleanup retry, without replaying disposition", async t => {
  const f = await owned(t), before = clone(f.tabs.get(8)), from = f.calls.length;
  f.hooks.detach = async id => { if (id === 8) throw new Error("fixture release failure"); };
  await assert.rejects(finishing(f), /fixture release failure/);
  assert.equal(marker(f), undefined); assert.equal(persistedMarker(f), undefined);
  assert.equal(f.tabs.has(7), true); assert.deepEqual(f.tabs.get(8), before); noDisposition(f, from);
  assert.equal(f.attached.has(8), true);
  await assert.rejects(f.backend.attach(f.params), /STALE_CONTROL_EPOCH|CONTROL_ENDING/);
  delete f.hooks.detach;
  const next = f.fresh(f.params, await f.backend.getControlState({ session_id: "task" }));
  assert.equal(f.attached.has(8), false);
  assert.equal(marker(f), undefined, "Recovery must not replay a failed delivery");
  await f.backend.finalizeTabs({ ...next, keep: [{ tabId: 8, status: "deliverable" }] });
  assert.ok(persistedMarker(f));
});

test("auxiliary removal write failure cannot publish delivery and explicit recovery retries exact cleanup", async t => {
  const f = await owned(t), old = f.backend.auxiliaryTabs.owner(8), before = clone(f.tabs.get(8));
  let failed = false;
  f.hooks.write = async (area, value) => {
    if (area === "session" && value[AUX_KEY] && !value[AUX_KEY].records.some(item => item.tabId === 8)) {
      failed = true; throw new Error("fixture ownership deletion failure");
    }
  };
  await assert.rejects(finishing(f), /fixture ownership deletion failure/);
  assert.equal(failed, true); assert.equal(marker(f), undefined); assert.equal(persistedMarker(f), undefined);
  assert.equal(f.backend.auxiliaryTabs.entry(8), old); assert.equal(old.phase, "quarantined");
  assert.deepEqual(f.tabs.get(8), before); assert.equal(f.attached.has(8), false);
  delete f.hooks.write;
  await f.backend.getControlState({ session_id: "task" });
  assert.equal(f.backend.auxiliaryTabs.entry(8), undefined);
  assert.equal(marker(f), undefined, "Cleanup recovery must not publish the failed delivery");
  assert.deepEqual(f.tabs.get(8), before);
});

test("delivery metadata write failure rolls back memory before any later session save", async t => {
  const f = await owned(t), before = clone(f.tabs.get(8)); let failed = false;
  f.hooks.write = async (area, value) => {
    if (area === "local" && value[STATE_KEY]?.deliverableTabs?.[8] && !failed) {
      failed = true; throw new Error("fixture delivery metadata quota");
    }
  };
  await assert.rejects(finishing(f), /fixture delivery metadata quota/);
  assert.equal(failed, true); assert.equal(marker(f), undefined); assert.equal(persistedMarker(f), undefined);
  await f.backend.store.save();
  assert.equal(persistedMarker(f), undefined, "A later save persisted a rejected delivery");
  assert.deepEqual(f.tabs.get(8), before); assert.equal(f.attached.has(8), false);
  const next = f.fresh(f.params, await f.backend.getControlState({ session_id: "task" }));
  await assert.rejects(f.backend.attach(next), denied);
  await f.backend.claimUserTab(next);
  await f.backend.finalizeTabs({ ...next, keep: [{ tabId: 8, status: "deliverable" }] });
  assert.ok(persistedMarker(f));
});

for (const phase of ["native release", "delivery persistence"]) for (const mutation of ["move", "pin", "close"]) {
  test(`${mutation} during ${phase} rejects the selected delivery without native disposition`, async t => {
    const f = await owned(t), hold = phase === "native release" ? holdDetach(f) : holdDeliveryWrite(f), from = f.calls.length;
    const pending = outcome(finishing(f)); await until(hold.ready, phase);
    // Mutate the native inventory without an event: the final proof must use
    // fresh Chrome state, not depend on event delivery preceding the Promise.
    if (mutation === "move") f.tabs.get(8).windowId = 3;
    else if (mutation === "pin") f.tabs.get(8).pinned = true;
    else f.tabs.delete(8);
    hold.gate.resolve();
    const result = await pending; assert.match(String(result.error), changed);
    assert.equal(marker(f), undefined); assert.equal(persistedMarker(f), undefined);
    noDisposition(f, from); assert.ok(f.tabs.has(9));
  });
}

test("a new claim reserved during delivery persistence survives the old finalizer", async t => {
  const f = await owned(t), hold = holdDeliveryWrite(f);
  const pending = outcome(finishing(f)); await until(hold.ready, "delivery persistence");
  assert.equal(f.backend.auxiliaryTabs.entry(8), undefined, "Old task must release before presentation persistence");
  const foreignClaim = outcome(f.backend.claimUserTab(f.foreign));
  const replacement = f.backend.auxiliaryTabs.entry(8);
  assert.ok(replacement); assert.equal(replacement.session_id, "other");
  hold.gate.resolve();
  assert.match(String((await pending).error), changed);
  assert.equal((await foreignClaim).error, undefined);
  assert.equal(f.backend.auxiliaryTabs.owner(8), replacement);
  assert.equal(marker(f), undefined); assert.equal(persistedMarker(f), undefined);
  await f.backend.attach(f.foreign);
  assert.equal(f.backend.attachmentOwners.get(8).session_id, "other");
  assert.equal(f.tabs.get(8).windowId, 2);
});

test("a stale finalizer rolls back only its own metadata object", async t => {
  const f = await owned(t), hold = holdDeliveryWrite(f);
  const pending = outcome(finishing(f)); await until(hold.ready, "delivery persistence");
  const replacement = { windowId: 2, groupId: -1, pinned: false, deliveryId: "replacement-presentation", deliveredAt: Date.now() + 1 };
  // Exercise the presentation store's own replacement seam; metadata itself
  // grants no tab authority and must survive an older transaction's rollback.
  f.backend.store.setDeliverables([[8, replacement]]);
  hold.gate.resolve();
  assert.match(String((await pending).error), changed);
  assert.equal(marker(f), replacement);
  assert.deepEqual(persistedMarker(f), replacement);
  assert.equal(f.backend.auxiliaryTabs.entry(8), undefined);
  await assert.rejects(f.backend.attach(f.foreign), denied);
});

test("a native detach-and-return event cannot revive an old placement proof", async t => {
  const f = await owned(t), hold = holdDeliveryWrite(f), before = clone(f.tabs.get(8));
  const pending = outcome(finishing(f)); await until(hold.ready, "delivery persistence");
  // Native event evidence invalidates the transaction even when its final
  // inventory happens to look identical again (the user moved the tab back).
  f.chrome.tabs.onDetached.emit(8, { oldWindowId: 2, oldPosition: 0 });
  f.chrome.tabs.onAttached.emit(8, { newWindowId: 2, newPosition: 0 });
  hold.gate.resolve();
  assert.match(String((await pending).error), changed);
  assert.equal(marker(f), undefined); assert.equal(persistedMarker(f), undefined);
  assert.deepEqual(f.tabs.get(8), before);
});

test("Pause waits for real delivery persistence and prevents its late successful ACK", async t => {
  const f = await owned(t), hold = holdDeliveryWrite(f);
  const pending = outcome(finishing(f)); await until(hold.ready, "delivery persistence");
  let pauseSettled = false;
  const pause = outcome(f.backend.pauseAutomation()).finally(() => { pauseSettled = true; });
  await tick();
  assert.equal(f.backend.automationControl.inputBlocked, true);
  assert.equal(pauseSettled, false);
  hold.gate.resolve();
  assert.match(String((await pending).error), /OBU_AUTOMATION_PAUSED/);
  const result = await pause; assert.equal(result.error, undefined); assert.equal(result.value.cleanupComplete, true);
  assert.equal(marker(f), undefined); assert.equal(persistedMarker(f), undefined);
  assert.equal(f.tabs.get(8).windowId, 2); assert.equal(f.attached.has(8), false);
});

test("the session stays fenced after metadata ACK until the final native proof completes", async t => {
  const f = await owned(t), hold = holdFinalDeliveryProof(f);
  let settled = false;
  const pending = outcome(finishing(f)).finally(() => { settled = true; });
  try {
    await until(hold.ready, "final native proof after metadata ACK");
    assert.ok(persistedMarker(f)); assert.equal(settled, false);
    const state = await assertSessionStillClosing(f);
    assert.equal(settled, false);
    hold.gate.resolve();
    const result = await pending; assert.equal(result.error, undefined);
    assert.equal(result.value.controlEpoch, state.controlEpoch);
    const next = f.fresh(f.params, result.value);
    assert.deepEqual(Array.from(await f.backend.getTabs(next), tab => tab.id), []);
    await assert.rejects(f.backend.attach(next), denied);
  } finally { hold.gate.resolve(); await pending; }
});

test("capacity eviction cannot remove a session with a final delivery ACK pending", async t => {
  const f = await owned(t), hold = holdFinalDeliveryProof(f), record = f.backend.controlLedger.records.get("task");
  const pending = outcome(finishing(f));
  try {
    await until(hold.ready, "final native proof");
    // The task is the first/oldest ledger entry and finishEnd has persisted
    // idle. New sessions must evict other idle entries while its ACK is fenced.
    for (let index = 0; index < 70; index++) await f.backend.getControlState({ session_id: `fresh-${index}` });
    assert.equal(f.backend.controlLedger.records.get("task"), record);
    assert.ok(f.backend.controlLedger.records.size <= 64);
    await assertSessionStillClosing(f);
    hold.gate.resolve();
    assert.equal((await pending).error, undefined);
  } finally { hold.gate.resolve(); await pending; }
});

test("a failed final proof keeps the session fenced until the actual rollback write ACK", async t => {
  const f = await owned(t), proof = holdFinalDeliveryProof(f), rollback = f.gate();
  let rollbackEntered = false, rollbackWrites = 0, settled = false;
  const pending = outcome(finishing(f)).finally(() => { settled = true; });
  try {
    await until(proof.ready, "final native proof");
    f.hooks.write = async (area, value) => {
      if (area === "local" && value[STATE_KEY] && !value[STATE_KEY].deliverableTabs?.[8]) {
        rollbackWrites++; rollbackEntered = true; await rollback.promise;
      }
    };
    f.tabs.get(8).windowId = 3;
    proof.gate.resolve();
    await until(() => rollbackEntered, "rollback persistence");
    assert.equal(marker(f), undefined); assert.ok(persistedMarker(f), "Rollback is not yet durable");
    await assertSessionStillClosing(f);
    assert.equal(settled, false); assert.equal(rollbackWrites, 1);
    rollback.resolve();
    assert.match(String((await pending).error), changed);
    assert.equal(rollbackWrites, 1); assert.equal(persistedMarker(f), undefined);
    assert.equal((await f.backend.getControlState({ session_id: "task" })).closing, false);
  } finally { proof.gate.resolve(); rollback.resolve(); await pending; }
});

test("failed delivery rollback is attempted once and only explicit bootstrap retries its real write", async t => {
  const f = await owned(t), proof = holdFinalDeliveryProof(f); let rollbackWrites = 0, rejectRollback = true;
  const pending = outcome(finishing(f));
  try {
    await until(proof.ready, "final native proof");
    f.hooks.write = async (area, value) => {
      if (area === "local" && value[STATE_KEY] && !value[STATE_KEY].deliverableTabs?.[8]) {
        rollbackWrites++;
        if (rejectRollback) throw new Error("fixture rollback persistence failure");
      }
    };
    f.tabs.get(8).windowId = 3; proof.gate.resolve();
    const result = await pending;
    assert.match(String(result.error), /OBU_AUXILIARY_DELIVERY_CLEANUP_FAILED/);
    assert.match(String(result.error), /fixture rollback persistence failure/);
    assert.equal(rollbackWrites, 1, "The rejected finalizer must not silently retry its failed rollback");
    assert.equal(marker(f), undefined); assert.ok(persistedMarker(f));
    const nativeCalls = clone(f.calls.filter(([name]) => ["attach", "detach", "remove", "group", "ungroup"].includes(name)));
    await f.backend.getInfo(); await tick();
    assert.equal(rollbackWrites, 1);
    rejectRollback = false;
    const next = f.fresh(f.params, await f.backend.getControlState({ session_id: "task" }));
    assert.equal(rollbackWrites, 2); assert.equal(persistedMarker(f), undefined);
    assert.deepEqual(f.calls.filter(([name]) => ["attach", "detach", "remove", "group", "ungroup"].includes(name)), nativeCalls);
    await assert.rejects(f.backend.attach(next), denied);
  } finally { proof.gate.resolve(); rejectRollback = false; await pending; }
});

test("a failed second claim deletion does not publish or replay a partially released batch", async t => {
  const f = await owned(t);
  f.tabs.set(10, { id: 10, groupId: -1, windowId: 3, url: "https://fixture.test/second-popup", active: false });
  await f.backend.claimUserTab({ ...f.params, tabId: 10 });
  await f.backend.attach({ ...f.params, tabId: 10 });
  const original = new Map([8, 10].map(id => [id, clone(f.tabs.get(id))]));
  f.hooks.write = async (area, value) => {
    if (area === "session" && value[AUX_KEY] && !value[AUX_KEY].records.some(item => item.tabId === 10))
      throw new Error("fixture second claim deletion failure");
  };
  await assert.rejects(f.backend.finalizeTabs({ ...f.params, keep: [8, 10].map(tabId => ({ tabId, status: "deliverable" })) }), /fixture second claim deletion failure/);
  assert.equal(f.backend.auxiliaryTabs.entry(8), undefined);
  assert.equal(f.backend.auxiliaryTabs.entry(10)?.phase, "quarantined");
  for (const id of [8, 10]) {
    assert.deepEqual(f.tabs.get(id), original.get(id));
    assert.equal(f.backend.store.state.deliverableTabs?.[id], undefined);
    assert.equal(f.local[STATE_KEY]?.deliverableTabs?.[id], undefined);
    assert.equal(f.attached.has(id), false);
  }
  await assert.rejects(f.backend.attach(f.params), /STALE_CONTROL_EPOCH|CONTROL_ENDING/);
  delete f.hooks.write;
  const next = f.fresh(f.params, await f.backend.getControlState({ session_id: "task" }));
  assert.equal(f.backend.auxiliaryTabs.entry(10), undefined);
  for (const tabId of [8, 10]) {
    assert.equal(f.backend.store.state.deliverableTabs?.[tabId], undefined);
    await assert.rejects(f.backend.attach({ ...next, tabId }), denied);
  }
});

for (const boundary of ["simulated worker replacement", "native host disconnect"]) {
  test(`delivery presentation never restores authority after ${boundary}`, async t => {
    const f = await owned(t, "created-page");
    const ended = await finishing(f), before = clone(f.tabs.get(8)), delivered = clone(persistedMarker(f));
    let backend = f.backend;
    if (boundary === "simulated worker replacement") {
      // Real Backend reconstruction with the same storage/native inventory;
      // this is a VM recovery regression, not a claim of a native worker test.
      for (const event of f.events) event.clear();
      backend = new f.Backend(); await backend.controlReady;
      t.after(() => Promise.allSettled([...backend.attachedTabs].map(id => backend.detachTab(id))));
    } else await backend.nativeDisconnected();
    assert.deepEqual(f.tabs.get(8), before);
    assert.deepEqual(persistedMarker(f), delivered);
    assert.equal(backend.auxiliaryTabs.entry(8), undefined);
    const next = f.fresh(f.params, await backend.getControlState({ session_id: "task" }));
    assert.equal((await backend.getTabs(next)).some(tab => tab.id === 8), false);
    await assert.rejects(backend.attach(f.params), denied);
    await assert.rejects(backend.attach(next), denied);
    if (boundary === "native host disconnect") await assert.rejects(backend.attach(f.fresh(f.params, ended)), denied);
    await backend.claimUserTab(next);
    assert.equal(backend.auxiliaryTabs.owner(8).session_id, "task");
    assert.equal(backend.store.state.deliverableTabs?.[8], undefined);
    await backend.attach(next);
  });
}

test("replacement of an exact claim while native release is pending cannot be treated as successful removal", async t => {
  const f = await owned(t), old = f.backend.auxiliaryTabs.owner(8), hold = holdDetach(f);
  const pending = outcome(finishing(f)); await until(hold.ready, "native release");
  await f.backend.auxiliaryTabs.remove(old, { cleanup: async () => {} });
  const foreignClaim = outcome(f.backend.claimUserTab(f.foreign));
  const replacement = f.backend.auxiliaryTabs.entry(8);
  assert.ok(replacement); assert.notEqual(replacement, old);
  hold.gate.resolve();
  assert.match(String((await pending).error), changed);
  assert.equal((await foreignClaim).error, undefined);
  assert.equal(f.backend.auxiliaryTabs.owner(8), replacement);
  assert.equal(marker(f), undefined); assert.equal(persistedMarker(f), undefined);
  await f.backend.attach(f.foreign);
  assert.equal(f.backend.attachmentOwners.get(8).session_id, "other");
});

test("presentation metadata is bounded, keeps the new delivery, and never grants ownership", async t => {
  const f = await owned(t);
  f.backend.store.state.deliverableTabs = Object.fromEntries(Array.from({ length: 256 }, (_, index) =>
    [String(1000 + index), { windowId: 1, groupId: -1, pinned: false, deliveryId: `old-${index}`, deliveredAt: index }]));
  await f.backend.store.save();
  const from = f.calls.length;
  await finishing(f);
  assert.equal(Object.keys(f.backend.store.state.deliverableTabs).length, 256);
  assert.equal(Object.keys(f.local[STATE_KEY].deliverableTabs).length, 256);
  assert.ok(marker(f)); assert.equal(f.backend.store.state.deliverableTabs[1000], undefined);
  assert.equal(f.calls.slice(from).some(([name, ids]) => ["group", "ungroup", "remove", "detach"].includes(name) && [].concat(ids).some(id => id >= 1000)), false);
  await assert.rejects(f.backend.attach(f.foreign), denied);
  assert.equal(f.backend.auxiliaryTabs.entry(8), undefined);
});

for (const boundary of ["close", "explicit reclaim"]) test(`${boundary} prunes persisted delivery presentation without granting incidental control`, async t => {
  const f = await owned(t);
  await finishing(f); assert.ok(marker(f)); assert.ok(persistedMarker(f));
  await assert.rejects(f.backend.attach(f.foreign), denied);
  if (boundary === "close") {
    await f.chrome.tabs.remove(8);
    await until(() => !marker(f) && !persistedMarker(f), "delivery metadata pruning");
    assert.equal(f.backend.auxiliaryTabs.entry(8), undefined);
  } else {
    await f.backend.claimUserTab(f.foreign);
    assert.equal(marker(f), undefined); assert.equal(persistedMarker(f), undefined);
    assert.equal(f.backend.auxiliaryTabs.owner(8).session_id, "other");
    await f.backend.attach(f.foreign);
  }
});

for (const kind of ["popup", "created-page"]) {
  test(`${kind} deliverable preserves its native page and releases task authority`, async t => {
    const f = await owned(t, kind), before = clone(f.tabs.get(8)), from = f.calls.length;
    const result = await f.backend.finalizeTabs({ ...f.params, keep: [{ tabId: 8, status: "deliverable" }] });
    assertPreserved(f, before, from);
    assert.equal((await f.backend.getInfo()).metadata.auxiliaryDeliveryVersion, 1);
    await assert.rejects(f.backend.attach(f.params), denied);
    const next = f.fresh(f.params, result);
    assert.equal((await f.backend.getTabs(next)).some(tab => tab.id === 8), false);
    await assert.rejects(f.backend.attach(next), denied);
    assert.equal(f.tabs.has(7), false, "Omitted agent work page closes");
    assert.ok(f.tabs.has(9), "Foreign task page survives");
  });
}
