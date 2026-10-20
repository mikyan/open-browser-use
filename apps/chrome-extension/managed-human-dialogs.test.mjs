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
  f.open = (params = {}) => { manager.observe("Page.javascriptDialogOpening", { frameId: "root", type: "confirm", message: "Original?", ...params }); return manager.info(); };
  f.closed = (params = { frameId: "root" }) => manager.observe("Page.javascriptDialogClosed", params);
  f.respond = (decision = {}, info = manager.info()) => manager.respond({ leaseId: info.leaseId, generation: info.generation, dialogId: info.dialogId, accept: true, ...decision });
  return Object.assign(f, { calls, failures, states, gates });
}

function pendingFixture() {
  const f = fixture(), reads = [];
  f.manager.capture = () => {
    const read = defer(), epoch = f.epoch, generation = f.generation;
    reads.push({ ...read, epoch, generation, proof: { epoch, generation } });
    return { epoch, pending: read.promise };
  };
  return Object.assign(f, { reads });
}

test("End cancels a pending-proof native dialog before joining the original proof read", async () => {
  const f = pendingFixture(); assert.equal(f.open(), null);
  assert.equal(f.manager.captures.size, 1); assert.equal(f.manager.hasOpen(), true);
  let closed = false; const ending = f.manager.close().then(() => { closed = true; }); await tick();
  assert.deepEqual(f.calls, [{ accept: false }]); assert.equal(closed, false);
  f.gates[0].resolve(); await tick(); assert.equal(closed, false, "native cancel ACK cannot forget pending proof");
  f.reads[0].resolve(f.reads[0].proof); await ending;
  assert.equal(f.manager.info(), null); assert.equal(f.manager.captures.size, 0);
  assert.equal(f.states.some(Boolean), false, "late proof after End must not publish human authority");
});

for (const boundary of ["closed", "retired", "new-document", "ambiguous"]) test(`pending proof cannot publish after ${boundary}`, async () => {
  const f = pendingFixture(); f.open(); const old = f.reads[0];
  if (boundary === "closed") f.closed();
  else if (boundary === "retired") f.manager.retire(f.epoch);
  else if (boundary === "new-document") { f.closed(); f.epoch = {}; f.generation++; f.open({ message: "New native dialog" }); }
  else f.open({ message: "Unpaired new Opening" });
  old.resolve(old.proof); await tick();
  assert.equal(f.manager.info(), null); assert.equal(f.states.some(Boolean), false);
  if (boundary === "new-document") {
    const current = f.reads[1]; current.resolve(current.proof); await tick();
    assert.equal(f.manager.info().generation, 2); assert.equal(f.manager.info().message, "New native dialog");
    f.closed();
  }
  if (boundary === "retired") { assert.deepEqual(f.calls, [{ accept: false }]); f.gates[0].resolve(); }
  if (boundary === "ambiguous") { await assert.rejects(f.manager.close(), /CLEANUP_INCOMPLETE/); f.destroyed = true; }
  await f.manager.close();
});

test("proof descriptor cannot import another epoch even when the new generation is current", async () => {
  const f = pendingFixture(); f.open(); f.epoch = {}; f.generation++;
  f.reads[0].resolve({ epoch: f.epoch, generation: f.generation }); await tick();
  assert.equal(f.manager.info(), null); assert.equal(f.failures.length, 1);
  assert.match(f.failures[0].message, /different original document owner/);
  assert.deepEqual(f.calls, [{ accept: false }]); f.gates[0].resolve(); await f.manager.close();
});

test("a retired proof read failure joins its original cancel without revoking the successor", async () => {
  const f = pendingFixture(); f.open(); const original = f.epoch;
  f.manager.retire(original); f.epoch = {}; f.generation++;
  f.reads[0].reject(new Error("old browser document retired")); await tick();
  assert.deepEqual(f.calls, [{ accept: false }]);
  assert.equal(f.failures.length, 0);
  let drained = false; const cleanup = f.manager.drain(original).then(() => { drained = true; });
  await tick(); assert.equal(drained, false);
  f.gates[0].resolve(); await cleanup;
  f.closed(); f.open({ message: "Current document" });
  f.reads[1].resolve(f.reads[1].proof); await tick();
  assert.equal(f.manager.info().generation, 2); assert.equal(f.manager.info().message, "Current document");
  f.closed(); await f.manager.close();
});

test("old epoch drain joins its proof and actual decision but never the new dialog", async () => {
  const f = pendingFixture(); f.open(); const oldEpoch = f.epoch;
  f.reads[0].resolve(f.reads[0].proof); await tick();
  const oldAnswer = f.respond(); await tick(); f.closed();
  f.epoch = {}; f.generation++; f.open();
  let oldDrained = false; const oldDrain = f.manager.drain(oldEpoch).then(() => { oldDrained = true; }); await tick();
  assert.equal(oldDrained, false, "old actual native ACK remains owned");
  f.gates[0].resolve(); await oldAnswer; await oldDrain;
  assert.equal(f.manager.captures.size, 1, "new proof remains pending independently");
  f.reads[1].resolve(f.reads[1].proof); await tick();
  assert.equal(f.manager.info().generation, 2);
  const newAnswer = f.respond(); await tick(); await f.manager.drain(oldEpoch);
  assert.equal(f.manager.operations.size, 1, "new actual response is not settled by old drain");
  f.gates[1].resolve(); await newAnswer; f.closed(); await f.manager.close();
});

test("late proof publication accounts the deadline from Opening even when its timer is delayed", async () => {
  const f = pendingFixture(); let now = 0; const timers = new Map(); let sequence = 0;
  f.manager.timing = { now: () => now, setTimer: fn => { timers.set(++sequence, fn); return sequence; }, clearTimer: id => timers.delete(id) };
  f.open(); now = 300001; // Deliberately do not run the timer callback.
  f.reads[0].resolve(f.reads[0].proof); await tick();
  assert.equal(f.manager.info(), null); assert.equal(f.states.some(Boolean), false);
  assert.ok(f.failures.some(error => /DIALOG_TIMEOUT/.test(error.message)));
  assert.deepEqual(f.calls, [{ accept: false }]); f.gates[0].resolve(); await f.manager.close();
  assert.equal(timers.size, 0);
});

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

test("Closed belongs to the exact original frame and cannot retire a successor in another frame", async () => {
  const f = fixture(), root = f.open(), first = f.respond(); await tick();
  f.closed(); const child = f.open({ frameId: "child", message: "Child?" });
  for (const params of [{}, { frameId: "root" }, { frameId: "foreign" }]) f.closed(params);
  assert.deepEqual(f.manager.info(), child); assert.equal(f.manager.hasOpen(), true);
  assert.deepEqual(f.calls, [{ accept: true }]);
  f.gates[0].resolve(); assert.equal((await first).dialogId, root.dialogId);
  assert.deepEqual(f.manager.info(), child);
  const next = f.respond({ accept: false }); await tick(); f.gates[1].resolve(); await next;
  f.closed({ frameId: "child" }); await f.manager.close();
});

for (const closed of [{}, { frameId: "foreign" }]) {
  test(`an unmatched Closed followed by Opening fences even queued cancellation (${JSON.stringify(closed)})`, async () => {
    const f = fixture(), old = f.open(), answering = f.respond();
    const rejected = assert.rejects(answering, /DIALOG_STALE/);
    f.closed(closed); f.open({ frameId: "child", message: "Unpaired next?" });
    assert.equal(f.manager.info(), null); await rejected;
    await assert.rejects(f.manager.close(), /CLEANUP_INCOMPLETE/); assert.equal(f.calls.length, 0);
    await assert.rejects(f.respond({}, old), /DIALOG_STALE/);
    f.closed(); f.attached = false;
    await assert.rejects(f.manager.close(), /CLEANUP_INCOMPLETE/, "external detach is not target destruction");
    f.destroyed = true; await f.manager.close(); assert.equal(f.calls.length, 0);
  });
}

test("ambiguous successor retains an already dispatched original response until its actual ACK", async () => {
  const f = fixture(), old = f.open(), answering = f.respond(); await tick();
  f.closed({ frameId: "foreign" }); f.open({ frameId: "child" });
  let ended = false;
  const closing = f.manager.close().then(() => { ended = true; }, error => { ended = true; throw error; });
  const rejected = assert.rejects(closing, /CLEANUP_INCOMPLETE/); await tick();
  assert.equal(ended, false); assert.deepEqual(f.calls, [{ accept: true }]);
  f.gates[0].resolve(); assert.equal((await answering).dialogId, old.dialogId); await rejected;
  f.destroyed = true; await f.manager.close(); assert.deepEqual(f.calls, [{ accept: true }]);
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

test("an unknown type is not offered, and a duplicate opening cannot borrow an original claim", async () => {
  const f = fixture(); assert.equal(f.open({ type: "unknown" }), null); await tick();
  assert.deepEqual(f.calls, [{ accept: false }]); assert.match(f.failures[0].message, /UNSUPPORTED/);
  f.gates[0].resolve(); await f.manager.close();
  const other = fixture(), info = other.open(); other.open();
  assert.equal(other.manager.info(), null); assert.equal(other.failures.length, 1);
  await assert.rejects(other.respond({}, info), /DIALOG_STALE/);
  await assert.rejects(other.manager.close(), /CLEANUP_INCOMPLETE/); assert.deepEqual(other.calls, []);
  other.destroyed = true; await other.manager.close();
});

for (const closedFirst of [false, true]) test(`beforeunload retains native Closed independently from requested accept and ACK (${closedFirst})`, async () => {
  const f = fixture(), closed = [];
  f.manager.onClosed = (_proof, original) => closed.push({ result: original.closedResult, acknowledged: original.acknowledged });
  const info = f.open({ type: "beforeunload", message: "" });
  assert.equal(info.type, "beforeunload"); await assert.rejects(f.respond({ promptText: "never" }), /INVALID/);
  const response = f.respond({ accept: true }); await tick();
  if (closedFirst) f.closed({ frameId: "root", result: false });
  f.gates[0].resolve(); assert.equal((await response).acknowledged, true);
  if (!closedFirst) f.closed({ frameId: "root", result: false });
  assert.deepEqual(closed, [{ result: false, acknowledged: !closedFirst }]);
  assert.deepEqual(f.calls, [{ accept: true }]); await f.manager.close();
});

for (const result of [undefined, null, "false", 0]) test(`beforeunload cannot infer a missing native close result (${result})`, async () => {
  const f = fixture(); let closed = false; f.manager.onClosed = () => { closed = true; };
  f.open({ type: "beforeunload", message: "" }); f.closed({ frameId: "root", result });
  assert.equal(closed, false); assert.match(f.failures[0].message, /UNCONFIRMED/);
  assert.equal(f.manager.hasOpen(), false); await f.manager.close();
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


test("published dialog source comes only from its captured proof", async t => {
  const f = fixture(), source = Object.freeze({ origin: "https://actual-child.test", frame: "child" });
  t.after(async () => { f.closed(); for (const gate of f.gates) gate.resolve(); await f.manager.close(); });
  f.manager.capture = () => ({ generation: f.generation, epoch: f.epoch, source });
  const info = f.open({ url: "https://parent.test/", message: "This message claims https://spoof.test" });
  assert.deepEqual(info.source, source); assert.ok(Object.isFrozen(info.source));
  assert.deepEqual(Object.keys(info.source).sort(), ["frame", "origin"]);
});


test("legacy proof never acquires a display source from native URL or message", async t => {
  const f = fixture(); t.after(async () => { f.closed(); for (const gate of f.gates) gate.resolve(); await f.manager.close(); });
  const info = f.open({ url: "https://spoof.test/", source: { origin: "https://spoof.test", frame: "top-level" }, message: "From https://spoof.test" });
  assert.equal(Object.hasOwn(info, "source"), false);
});

test("late original answer ACK cannot replace a successor dialog source", async t => {
  const f = fixture(); t.after(async () => { f.closed(); for (const gate of f.gates) gate.resolve(); await f.manager.close(); });
  let source = Object.freeze({ origin: "https://first.test", frame: "child" });
  f.manager.capture = () => ({ epoch: f.epoch, generation: f.generation, source });
  const first = f.open(), pending = f.respond(); await tick(); f.closed();
  source = Object.freeze({ origin: "https://next.test", frame: "child" }); const second = f.open();
  f.gates[0].resolve(); const receipt = await pending;
  assert.equal(receipt.dialogId, first.dialogId); assert.equal(f.manager.info(), second);
  assert.deepEqual(second.source, { origin: "https://next.test", frame: "child" });
  assert.deepEqual(Object.keys(receipt).sort(), ["acknowledged", "dialogId", "generation", "leaseId"]);
});
