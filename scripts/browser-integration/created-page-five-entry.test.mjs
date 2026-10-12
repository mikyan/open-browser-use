import assert from "node:assert/strict";
import test from "node:test";
import { createdPageBarrier, withinCreatedPageBudget, readCreatedPageGate, runCreatedPageJSCaller, assertCreatedPageGate } from "./created-page-five-entry.mjs";
import { installCreatedPageObserver } from "./created-page-provenance.mjs";

test("all five callers must arrive before either gate releases", async () => {
  const readyDetail = {}, preparedDetail = {}, ready = createdPageBarrier(5, readyDetail), prepared = createdPageBarrier(5, preparedDetail);
  const advanced = [], completed = [];
  const jobs = Array.from({ length: 4 }, (_, index) => ready.enter(index, { waiterId: index }).then(() => advanced.push(index)));
  await Promise.resolve(); assert.deepEqual(advanced, []); assert.equal(readyDetail.releasedAt, null);
  await ready.enter(4, {}); await Promise.all(jobs); assert.equal(advanced.length, 4); assert.ok(readyDetail.releasedAt);
  const waiting = Array.from({ length: 4 }, (_, index) => prepared.enter(index, {}).then(() => completed.push(index)));
  await Promise.resolve(); assert.deepEqual(completed, []);
  await prepared.enter(4, {}); await Promise.all(waiting); assert.equal(completed.length, 4);
});

test("failed or duplicate arrivals reject existing and late callers without releasing input", async () => {
  for (const duplicate of [false, true]) {
    const detail = {}, gate = createdPageBarrier(2, detail), first = gate.enter("first", {});
    if (duplicate) await assert.rejects(gate.enter("first", {}), /Duplicate/);
    else gate.abort(new Error("Caller actually closed"));
    await assert.rejects(first, duplicate ? /Duplicate/ : /actually closed/);
    await assert.rejects(gate.enter("last", {}), duplicate ? /Duplicate/ : /actually closed/);
    assert.equal(detail.releasedAt, null);
  }
});

test("a gate cannot reset an expired original deadline or accept its late acknowledgement", async () => {
  let called = false;
  await assert.rejects(withinCreatedPageBudget(20, () => { called = true; }, () => 21), /expired before/); assert.equal(called, false);
  let clock = 10;
  await assert.rejects(withinCreatedPageBudget(20, () => { clock = 21; return true; }, () => clock), /expired at acknowledgement/);
  await assert.rejects(withinCreatedPageBudget(performance.now() + 20, () => new Promise(() => {})), /expired during gate/);
});

test("file publication retries only ENOENT and preserves exact token", async () => {
  let reads = 0;
  const result = await readCreatedPageGate({ path: "unused", token: "token", child: new Promise(() => {}), deadline: performance.now() + 1000,
    readFile: async () => { if (!reads++) throw Object.assign(new Error("not yet"), { code: "ENOENT" }); return '{"token":"token","waiterId":"original"}'; } });
  assert.equal(result.waiterId, "original"); assert.equal(reads, 2);
  for (const value of ["{", '{"token":"wrong"}', "x".repeat(65537)]) {
    reads = 0;
    await assert.rejects(readCreatedPageGate({ path: "unused", token: "token", child: new Promise(() => {}), deadline: performance.now() + 1000,
      readFile: async () => { reads++; return value; } }));
    assert.equal(reads, 1);
  }
  await assert.rejects(readCreatedPageGate({ path: "unused", token: "token", child: new Promise(() => {}), deadline: performance.now() + 1000,
    readFile: async () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); } }), /denied/);
});

test("process completion while awaiting publication is an immediate failure, not readiness", async () => {
  await assert.rejects(readCreatedPageGate({ path: "unused", token: "token", child: Promise.resolve("done"), deadline: performance.now() + 5000,
    readFile: async () => { throw Object.assign(new Error("not yet"), { code: "ENOENT" }); } }), /exited before gate/);
});

test("gate acknowledgements bind original identity and cannot replenish the remaining budget", () => {
  const item = { scope: { session_id: "first", turn_id: "turn", control_epoch: 1 }, tabId: 4, key: "key", owner: "owner", variant: "root", ready: { waiterId: "waiter", remainingMs: 1000 } };
  const value = { ...item, waiterId: "waiter", remainingMs: 999, preparedAt: 100, readyAt: 90 };
  assertCreatedPageGate(value, item, true);
  for (const mutate of [v => { v.remainingMs = "999"; }, v => { v.remainingMs = Infinity; }, v => { v.remainingMs = 1001; }, v => { v.waiterId = 5; },
    v => { v.preparedAt = "100"; }, v => { v.scope.control_epoch++; }, v => { v.tabId++; }, v => { v.owner = "different"; }]) {
    const wrong = structuredClone(value); mutate(wrong); assert.throws(() => assertCreatedPageGate(wrong, item, true));
  }
});

test("15-source passive observer retains bound and does not loosen default six-source mode", () => {
  for (const maxSources of [6, 15]) {
    const listeners = new Set(), target = {}, event = { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn), hasListener: fn => listeners.has(fn) };
    installCreatedPageObserver({ webNavigation: { onCreatedNavigationTarget: event } }, target, maxSources === 6 ? undefined : { maxSources });
    for (let index = 0; index < maxSources; index++) target.__createdPageProvenance.register(index);
    assert.throws(() => target.__createdPageProvenance.register(maxSources), /Invalid/);
    assert.equal(target.__createdPageProvenance.stop().listenerPresent, false);
  }
  for (const maxSources of [0, -1, 17, 1.1, "15"]) assert.throws(() => installCreatedPageObserver({}, {}, { maxSources }), /capacity/);
});

test("JS second gate failure cannot submit the original link and still cancels/closes", async () => {
  const calls = [], scope = { session_id: "original", turn_id: "turn", control_epoch: 3 };
  const state = { key: "key", owner: "owner", sourceNonce: "original-source", documentToken: "original-dom", frameAdds: [], clicks: [] };
  const tab = { locator: () => ({ textContent: async () => JSON.stringify(state), click: async () => { calls.push("click"); } }),
    expectPage: async () => ({ waiterId: "original-waiter", remainingMs: 15000, cancel: async () => { calls.push("cancel"); } }) };
  const browser = { client: { sessionId: scope.session_id, turnId: scope.turn_id, controlEpoch: scope.control_epoch,
    request: async () => ({ controlEpoch: 3, closing: false, nextTurnId: "turn", lifecycleVersion: 1 }) }, tab: () => tab, close: async () => { calls.push("close"); } };
  const detail = {};
  await assert.rejects(runCreatedPageJSCaller({ connect: async () => browser, scope, tabId: 1, variant: "root", key: "key", owner: "owner", detail,
    afterReady: async () => { calls.push("ready"); }, afterPrepared: async value => { assert.deepEqual(value.sourceBefore, state); throw new Error("peer failed"); } }), /peer failed/);
  assert.deepEqual(calls, ["ready", "cancel", "close"]); assert.equal(detail.ok, false); assert.equal(detail.waitCleanup.ok, true); assert.equal(detail.clientClose.ok, true);
});
