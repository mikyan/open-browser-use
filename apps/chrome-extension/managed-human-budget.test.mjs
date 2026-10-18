import assert from "node:assert/strict";
import test from "node:test";
import { ManagedHumanInputBudget, ManagedHumanDialogDeadline, ManagedHumanPreparationBudget } from "./managed-human-budget.js";

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function clock() {
  let time = 0, sequence = 0; const timers = new Map();
  const timing = { now: () => time, setTimer: (fn, ms) => { const id = ++sequence; timers.set(id, { at: time + ms, fn }); return id; }, clearTimer: id => timers.delete(id) };
  return { timing, timers, skip: ms => { time += ms; }, advance: ms => {
    const end = time + ms;
    while (true) {
      const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      const [id, timer] = next; timers.delete(id); time = timer.at; timer.fn();
    }
    time = end;
  } };
}

test("ordinary input expires at 30 seconds, synchronously fences authority, and leaves the actual Promise intact", async () => {
  const c = clock(), native = deferred(); let revoked = false, settled = false;
  native.promise.then(() => { settled = true; });
  const budget = new ManagedHumanInputBudget({ timing: c.timing, onExpire: () => { revoked = true; } });
  const observer = budget.observe(native.promise), rejected = assert.rejects(observer, /INPUT_TIMEOUT.*normal/);
  c.advance(29999); assert.equal(revoked, false); c.advance(1); assert.equal(revoked, true);
  await rejected; assert.equal(settled, false); native.resolve("original ACK");
  assert.equal(await native.promise, "original ACK"); assert.equal(c.timers.size, 0);
});

test("only local original modal events suspend normal time and multiple dialogs share 300 seconds", async () => {
  const c = clock(), native = deferred(), failures = [];
  const budget = new ManagedHumanInputBudget({ timing: c.timing, onExpire: error => failures.push(error) });
  const rejected = assert.rejects(budget.observe(native.promise), /INPUT_TIMEOUT.*modal/);
  const first = {}, second = {}; c.advance(10000); budget.openModal(first);
  c.advance(180000); budget.closeModal({}); assert.equal(failures.length, 0);
  budget.closeModal(first); c.advance(10000); budget.openModal(second);
  c.advance(119999); assert.equal(failures.length, 0); c.advance(1);
  assert.equal(failures.length, 1); await rejected; native.resolve();
});

test("modal pause preserves the remaining ordinary budget instead of resetting it", async () => {
  const c = clock(), native = deferred(); let expired = false;
  const budget = new ManagedHumanInputBudget({ timing: c.timing, onExpire: () => { expired = true; } });
  const rejected = assert.rejects(budget.observe(native.promise), /INPUT_TIMEOUT.*normal/);
  const dialog = {}; c.advance(29000); budget.openModal(dialog); c.advance(45000); budget.closeModal(dialog);
  c.advance(999); assert.equal(expired, false); c.advance(1); await rejected; native.resolve();
});

test("an actual input ACK finishes only its input clock while the independently open dialog still has a cap", async () => {
  const c = clock(), native = deferred(), failures = [];
  const input = new ManagedHumanInputBudget({ timing: c.timing, onExpire: error => failures.push(error) });
  const dialog = new ManagedHumanDialogDeadline({ timing: c.timing, onExpire: error => failures.push(error) });
  input.openModal(dialog); const observing = input.observe(native.promise); c.advance(45000); native.resolve("ACK");
  assert.equal(await observing, "ACK"); assert.equal(c.timers.size, 1);
  c.advance(255000); assert.equal(failures.length, 1); assert.match(failures[0].message, /DIALOG_TIMEOUT/);
});

test("late timer scheduling cannot grant extra time through an opening or late ACK", async () => {
  for (const event of ["open", "ack"]) {
    const c = clock(), native = deferred(); let expired = false;
    const budget = new ManagedHumanInputBudget({ timing: c.timing, onExpire: () => { expired = true; } });
    const rejected = assert.rejects(budget.observe(native.promise), /INPUT_TIMEOUT/);
    c.skip(30001); if (event === "open") budget.openModal({}); native.resolve("late actual ACK");
    await rejected; assert.equal(expired, true); assert.equal(await native.promise, "late actual ACK"); assert.equal(c.timers.size, 0);
  }
});

test("closed or revoked dialog clocks cannot expire a later dialog", () => {
  const c = clock(), failures = [];
  const first = new ManagedHumanDialogDeadline({ timing: c.timing, onExpire: error => failures.push(error) });
  c.advance(200000); first.finish();
  const next = new ManagedHumanDialogDeadline({ timing: c.timing, onExpire: error => failures.push(error) });
  c.advance(100001); assert.equal(failures.length, 0); next.finish(); assert.equal(c.timers.size, 0);
});

test("a queued stale timer callback cannot expire a finished original clock", () => {
  let callback, expired = 0;
  const deadline = new ManagedHumanDialogDeadline({ onExpire: () => { expired++; }, timing: {
    now: () => 999999, setTimer: fn => { callback = fn; return 1; }, clearTimer: () => {}
  } });
  deadline.finish(); callback(); assert.equal(expired, 0);
});

for (const navigation of [false, true]) test(`${navigation ? "navigation" : "initial"} preparation has an independent bounded ordinary clock and retains actual work`, async () => {
  const c = clock(), native = deferred(), failures = [], limit = navigation ? 10000 : 5000;
  const budget = new ManagedHumanPreparationBudget({ navigation, timing: c.timing, onExpire: error => failures.push(error) });
  let actualSettled = false; native.promise.then(() => { actualSettled = true; });
  const failed = assert.rejects(budget.observe(native.promise), /PREPARATION_TIMEOUT.*normal/);
  c.advance(limit - 1); assert.equal(failures.length, 0); c.advance(1);
  await failed; assert.equal(actualSettled, false); assert.equal(failures.length, 1);
  native.resolve("original setup ACK"); assert.equal(await native.promise, "original setup ACK");
});

for (const navigation of [false, true]) test(`one ${navigation ? "navigation" : "initial"} preparation shares 300 seconds across original dialogs and redirects`, async () => {
  const c = clock(), native = deferred(), failures = [], first = {}, second = {};
  const budget = new ManagedHumanPreparationBudget({ navigation, timing: c.timing, onExpire: error => failures.push(error) });
  const failed = assert.rejects(budget.observe(native.promise), /PREPARATION_TIMEOUT.*modal/);
  c.advance(2000); budget.openModal(first); c.advance(180000);
  budget.openModal({}); budget.closeModal({}); // Unrelated state/objects cannot reset the original cap.
  budget.closeModal(first); c.advance(1000); budget.openModal(second);
  c.advance(119999); assert.equal(failures.length, 0); c.advance(1); await failed;
  assert.deepEqual(budget.used, { normal: 3000, modal: 300000 }); native.resolve();
});

test("preparation preserves its remaining ordinary time after a proved modal", async () => {
  const c = clock(), native = deferred(), dialog = {};
  const budget = new ManagedHumanPreparationBudget({ timing: c.timing, onExpire: () => {} });
  const failed = assert.rejects(budget.observe(native.promise), /PREPARATION_TIMEOUT.*normal/);
  c.advance(4900); budget.openModal(dialog); c.advance(40000); budget.closeModal(dialog);
  c.advance(99); assert.equal(budget.finished, false); c.advance(1); await failed; native.resolve();
});

for (const boundary of ["opening", "guard", "actual ACK"]) test(`delayed preparation timer cannot authorize late ${boundary}`, async () => {
  const c = clock(), native = deferred(), failures = [];
  const budget = new ManagedHumanPreparationBudget({ timing: c.timing, onExpire: error => failures.push(error) });
  const failed = assert.rejects(budget.observe(native.promise), /PREPARATION_TIMEOUT/);
  c.skip(5001);
  if (boundary === "opening") budget.openModal({});
  if (boundary === "guard") assert.throws(() => budget.assertAvailable(), /PREPARATION_TIMEOUT/);
  native.resolve("late ACK"); await failed;
  assert.equal(failures.length, 1); assert.equal(await native.promise, "late ACK");
});

test("a real first frame completes only its original preparation clock", async () => {
  const c = clock(); let expired = 0;
  const old = new ManagedHumanPreparationBudget({ timing: c.timing, onExpire: () => { expired++; } });
  c.advance(4000); const originalTimer = [...c.timers.values()][0].fn; old.finish();
  const next = new ManagedHumanPreparationBudget({ navigation: true, timing: c.timing, onExpire: () => { expired++; } });
  originalTimer(); c.advance(6000); assert.equal(expired, 0);
  c.advance(4000); assert.equal(expired, 1); next.finish();
});
