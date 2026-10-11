import assert from "node:assert/strict";
import { test } from "node:test";
import { NativeInputTracker } from "./browser-input-adapter.js";

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const down = { type: "mousePressed", button: "left", x: 8, y: 9 };
const up = { ...down, type: "mouseReleased" };
function fixture(hooks = {}) {
  const tracker = new NativeInputTracker(hooks), token = {}, calls = [];
  tracker.register(7, token);
  return { tracker, token, calls,
    send: (params = down, operation = async () => calls.push(params.type)) => tracker.send({ tabId: 7 }, token, "Input.dispatchMouseEvent", params, operation),
    release: () => tracker.release(7, token, async (_target, method, params) => calls.push([method, params.type])) };
}

test("native input waits for durable intent and cleanup waits for the same write", async () => {
  const mark = deferred(), f = fixture({ beforeInput: () => mark.promise });
  const input = f.send();
  const rejected = assert.rejects(input, /RELEASE_IN_PROGRESS/);
  await tick();
  assert.deepEqual(f.calls, []);
  let ended = false;
  const release = f.release().then(() => { ended = true; });
  await tick();
  assert.equal(ended, false);
  mark.resolve();
  await Promise.all([release, rejected]);
  assert.equal(f.calls.includes("mousePressed"), false, "Pause fences the late native send");
});

test("failed intent persistence never delivers native input and retains uncertain state", async () => {
  const f = fixture({ beforeInput: async () => { throw new Error("intent write failed"); } });
  await assert.rejects(f.send(), /intent write failed/);
  assert.deepEqual(f.calls, []);
  assert.throws(() => f.tracker.forget(7, f.token), /UNCONFIRMED/);
});

test("a control fence that wins during persistence prevents the late native send", async () => {
  const mark = deferred();
  let revoked = false;
  const f = fixture({ beforeInput: () => mark.promise, assertInput: () => {
    if (revoked) throw new Error("control revoked");
  } });
  const input = f.send();
  revoked = true;
  mark.resolve();
  await assert.rejects(input, /control revoked/);
  assert.deepEqual(f.calls, []);
});

test("ordinary up durably clears only after the last actual input settles", async () => {
  const last = deferred(), events = [];
  const f = fixture({ beforeInput: async () => events.push("mark"), released: async () => events.push("clear") });
  await f.send();
  const pendingMove = f.send({ type: "mouseMoved", x: 2, y: 3 }, () => last.promise);
  await f.send(up);
  assert.equal(events.includes("clear"), false);
  last.resolve();
  await pendingMove;
  assert.equal(events.filter(value => value === "clear").length, 1);
});

test("durable clears are part of the public input result and teardown snapshot", async () => {
  const clear = deferred(), f = fixture({ beforeInput: async () => {}, released: () => clear.promise });
  await f.send();
  let completed = false;
  const result = f.send(up).then(() => { completed = true; });
  await tick();
  assert.equal(completed, false);
  assert.ok(f.tracker.controlSnapshot().pending.length);
  clear.resolve();
  await result;
  assert.equal(f.tracker.controlSnapshot().pending.length, 0);
});

test("failed durable clear keeps cleanup unconfirmed until an explicit successful retry", async () => {
  let fail = true;
  const f = fixture({ beforeInput: async () => {}, released: async () => { if (fail) throw new Error("clear failed"); } });
  await f.send();
  await assert.rejects(f.send(up), /clear failed/);
  assert.throws(() => f.tracker.forget(7, f.token), /UNCONFIRMED/);
  fail = false;
  await f.release();
  assert.deepEqual(f.calls, ["mousePressed", "mouseReleased"], "A confirmed up is never replayed");
  f.tracker.forget(7, f.token);
});

test("destroyed old attachment clears its own intent and cannot send after a pending write", async () => {
  const mark = deferred(), clear = deferred(), destroyed = [];
  const f = fixture({ beforeInput: () => mark.promise, onDestroyed: (tabId, token) => { destroyed.push([tabId, token]); return clear.promise; } });
  const input = f.send();
  const rejected = assert.rejects(input, /ATTACHMENT_CHANGED/);
  f.tracker.forget(7, f.token, { destroyed: true });
  const successor = {};
  f.tracker.register(7, successor);
  mark.resolve();
  await rejected;
  assert.deepEqual(f.calls, []);
  assert.deepEqual(destroyed, [[7, f.token]]);
  assert.ok(f.tracker.controlSnapshot().pending.length);
  clear.resolve();
  await Promise.allSettled(f.tracker.controlSnapshot().pending);
  assert.equal(f.tracker.attachments.get(7).token, successor);
});

test("a late ordinary completion cannot clear intent belonging to a replacement token", async () => {
  const native = deferred(), cleared = [];
  const f = fixture({ beforeInput: async () => {}, released: async (...args) => cleared.push(args) });
  const input = f.send({ type: "mouseMoved", x: 1, y: 2 }, () => native.promise);
  await tick();
  f.tracker.forget(7, f.token, { destroyed: true });
  f.tracker.register(7, {});
  native.resolve();
  await input;
  assert.deepEqual(cleared, []);
});

test("non-input protocol traffic does not create input intent", async () => {
  const f = fixture({ beforeInput: async () => { throw new Error("unexpected journal write"); } });
  assert.equal(await f.tracker.send({ tabId: 7 }, f.token, "Runtime.evaluate", {}, async () => 42), 42);
});
