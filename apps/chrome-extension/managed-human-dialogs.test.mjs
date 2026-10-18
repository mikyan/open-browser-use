import assert from "node:assert/strict";
import test from "node:test";
import { ManagedHumanDialogs, validateHumanDialogResponse } from "./managed-human-dialogs.js";

const defer = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function fixture() {
  const calls = [], failures = [], states = [], gates = [];
  const f = { generation: 1, authorized: true, attached: true, destroyed: false, epoch: {} };
  const manager = f.manager = new ManagedHumanDialogs({ leaseId: "lease",
    capture: () => ({ generation: f.generation, epoch: f.epoch }),
    assertCurrent: proof => { if (!f.authorized || proof.generation !== f.generation || proof.epoch !== f.epoch) throw new Error("old authority"); },
    attached: () => f.attached, destroyed: () => f.destroyed,
    send: async (params, check) => { check(); const gate = defer(); calls.push({ ...params }); gates.push(gate); return gate.promise; },
    notify: () => states.push(manager.info()), onFailure: error => failures.push(error) });
  f.open = (params = {}) => { manager.observe("Page.javascriptDialogOpening", { type: "confirm", message: "Original?", ...params }); return manager.info(); };
  f.closed = () => manager.observe("Page.javascriptDialogClosed", {});
  f.respond = (decision = {}, info = manager.info()) => manager.respond({ leaseId: info.leaseId, generation: info.generation, dialogId: info.dialogId, accept: true, ...decision });
  return Object.assign(f, { calls, failures, states, gates });
}

test("one dialog claims once, preserves pending state until native Closed, and returns only native ACK", async () => {
  const f = fixture(), info = f.open({ type: "prompt", defaultPrompt: "初始值", message: "<b>plain text</b>" });
  const responding = f.respond({ promptText: "回答" }); await tick();
  assert.deepEqual(f.manager.info(), info); assert.equal(f.manager.hasOpen(), true);
  await assert.rejects(f.respond(), /DIALOG_STALE/); assert.equal(f.calls.length, 1);
  f.gates[0].resolve();
  assert.deepEqual(await responding, { leaseId: "lease", generation: 1, dialogId: info.dialogId, acknowledged: true });
  assert.deepEqual(f.manager.info(), info); assert.equal(f.manager.hasOpen(), true, "ACK is not a Closed event");
  f.closed(); assert.equal(f.manager.info(), null); assert.equal(f.manager.hasOpen(), false); await f.manager.close();
});

test("a new native dialog is independent of a previous response whose ACK is still pending", async () => {
  const f = fixture(), first = f.open(), old = f.respond(); await tick();
  f.closed(); const second = f.open({ message: "Second?" }), next = f.respond({ accept: false }); await tick();
  assert.notEqual(second.dialogId, first.dialogId); assert.equal(f.calls.length, 2);
  f.gates[1].resolve(); await next;
  f.gates[0].resolve(); assert.equal((await old).dialogId, first.dialogId);
  assert.deepEqual(f.manager.info(), second, "old receipt cannot retire the newer dialog");
  f.closed(); await f.manager.close();
});

test("End cancels the original unclaimed dialog exactly once and joins its actual ACK", async () => {
  const f = fixture(); f.open(); let ended = false;
  const closing = f.manager.close().then(() => { ended = true; }); await tick();
  assert.deepEqual(f.calls, [{ accept: false }]); assert.equal(ended, false); assert.equal(f.manager.info(), null);
  const again = f.manager.close(); await tick(); assert.equal(f.calls.length, 1);
  f.gates[0].resolve(); await Promise.all([closing, again]); assert.equal(ended, true);
});

test("End joins a dispatched choice without sending another decision", async () => {
  const f = fixture(); f.open(); const answer = f.respond(); await tick();
  const closing = f.manager.close(); await tick(); assert.deepEqual(f.calls, [{ accept: true }]);
  f.closed(); f.gates[0].resolve(); assert.equal((await answer).acknowledged, true); await closing;
});

test("revocation before native dispatch sends only original cancellation and does not acknowledge the withdrawn choice", async () => {
  const f = fixture(); f.open(); const answer = f.respond({ accept: true }); const rejected = assert.rejects(answer, /DIALOG_STALE/);
  const closing = f.manager.close(); await tick(); assert.deepEqual(f.calls, [{ accept: false }]);
  f.gates[0].resolve(); await rejected; await closing;
});

test("native failure remains unconfirmed until the original Closed or destroyed target, without response replay", async () => {
  for (const boundary of ["closed", "destroyed"]) {
    const f = fixture(); f.open(); const answer = f.respond(); const rejected = assert.rejects(answer, /DIALOG_UNCONFIRMED/);
    await tick(); f.gates[0].reject(new Error("unknown native outcome")); await rejected;
    await assert.rejects(f.manager.close(), /CLEANUP_INCOMPLETE/); assert.equal(f.calls.length, 1);
    if (boundary === "closed") f.closed(); else { f.attached = false; f.destroyed = true; }
    await f.manager.close(); assert.equal(f.calls.length, 1);
  }
});

test("foreign tuples, wrong prompt types and unsafe fields never send native commands", async () => {
  const f = fixture(), info = f.open();
  for (const change of [{ leaseId: "other" }, { generation: 2 }, { dialogId: "other" }, { leaseId: "lease\n" }, { dialogId: "dialog\0" }, { promptText: "not a prompt" }, { accept: false, promptText: "ignored" }, { accept: "yes" }])
    await assert.rejects(f.respond(change), /DIALOG_(STALE|INVALID)/);
  let getter = false;
  const input = { leaseId: info.leaseId, generation: info.generation, dialogId: info.dialogId, accept: true };
  Object.defineProperty(input, "promptText", { get() { getter = true; return "bad"; } });
  await assert.rejects(f.manager.respond(input), /DIALOG_INVALID/); assert.equal(getter, false); assert.equal(f.calls.length, 0);
  f.closed(); await f.manager.close();
});

test("UTF-8 and Unicode bounds apply to messages, defaults and prompt decisions", async () => {
  for (const invalid of ["x".repeat(8193), "中".repeat(2731), "\ud800", "\udc00"]) {
    assert.throws(() => validateHumanDialogResponse({ leaseId: "l", generation: 1, dialogId: "d", accept: true, promptText: invalid }), /DIALOG_INVALID/);
    for (const field of ["message", "defaultPrompt"]) {
      const f = fixture(); assert.equal(f.open({ type: "prompt", [field]: invalid }), null); await tick();
      assert.deepEqual(f.calls, [{ accept: false }]); assert.equal(f.failures.length, 1); f.gates[0].resolve(); await f.manager.close();
    }
  }
  validateHumanDialogResponse({ leaseId: "l", generation: 1, dialogId: "d", accept: true, promptText: "😀".repeat(2048) });
});

test("beforeunload is never offered or accepted, and a duplicate opening cannot replace an original claim", async () => {
  const f = fixture(); assert.equal(f.open({ type: "beforeunload" }), null); await tick();
  assert.deepEqual(f.calls, [{ accept: false }]); assert.match(f.failures[0].message, /UNSUPPORTED/);
  f.gates[0].resolve(); await f.manager.close();
  const other = fixture(), info = other.open(); other.open();
  assert.equal(other.manager.info().dialogId, info.dialogId); assert.equal(other.failures.length, 1);
  const closing = other.manager.close(); await tick(); assert.deepEqual(other.calls, [{ accept: false }]); other.gates[0].resolve(); await closing;
});

test("a closed dialog cannot send a queued choice, and a new dialog during End is independently cancelled", async () => {
  const f = fixture(); f.open(); const answer = f.respond(); const rejected = assert.rejects(answer, /DIALOG_STALE/); f.closed();
  await rejected; assert.equal(f.calls.length, 0);
  f.open(); const closing = f.manager.close(); await tick(); f.closed(); f.open(); await tick();
  assert.deepEqual(f.calls, [{ accept: false }, { accept: false }]);
  f.gates[1].resolve(); f.gates[0].resolve(); await closing;
});

test("unsettled native responses have a hard capacity and never start an unlimited cancellation chain", async () => {
  const f = fixture(), answers = [];
  for (let index = 0; index < 63; index++) {
    f.open(); answers.push(f.respond()); await tick(); f.closed();
  }
  assert.equal(f.open(), null); assert.equal(f.manager.records.size, 64); assert.equal(f.calls.length, 63);
  const closing = assert.rejects(f.manager.close(), /CLEANUP_INCOMPLETE/);
  for (const gate of f.gates) gate.resolve(); await Promise.all(answers); await closing;
  assert.equal(f.calls.length, 63); f.closed(); await f.manager.close(); assert.equal(f.manager.records.size, 0);
});

test("retiring the original document withdraws its metadata and joins its one cancellation", async () => {
  const f = fixture(), info = f.open(); f.manager.retire(f.epoch); f.generation++;
  assert.equal(f.manager.info(), null); await assert.rejects(f.respond({}, info), /DIALOG_STALE/);
  await tick(); assert.deepEqual(f.calls, [{ accept: false }]);
  f.gates[0].resolve(); await f.manager.drain(); f.closed(); await f.manager.close();
});
