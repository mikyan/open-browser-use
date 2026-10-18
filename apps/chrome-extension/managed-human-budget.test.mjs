import assert from "node:assert/strict";
import test from "node:test";
import { ManagedHumanInputBudget, ManagedHumanDialogDeadline } from "./managed-human-budget.js";

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
