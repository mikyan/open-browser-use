import assert from "node:assert/strict";
import test from "node:test";
import { BrowserRendering } from "./browser-rendering.js";
import { ManagedHumanPreparationBudget } from "./managed-human-budget.js";

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function fixture(command = async () => {}, { startupData = "aW1hZ2U=", startupFrames = true } = {}) {
  const calls = [], frames = [], listeners = new Set(), queues = new Map(), drains = new Set(), streams = new Map();
  let attachment = {}, allowed = true, external = false;
  const emit = (data = "aW1hZ2U=", metadata = {}) => { for (const listener of [...listeners]) listener({ tabId: 7 }, "Page.screencastFrame", { sessionId: 42, data, metadata }); };
  const broker = new BrowserRendering({ streams, drains,
    queue(tabId, operation) {
      const result = (queues.get(tabId) ?? Promise.resolve()).catch(() => {}).then(operation);
      queues.set(tabId, result); drains.add(result);
      const settled = () => { drains.delete(result); if (queues.get(tabId) === result) queues.delete(tabId); };
      result.then(settled, settled); return result;
    },
    async send(target, method, params, finalCheck) { finalCheck?.(); calls.push({ target, method, params }); const result = await command(method); if (method === "Page.startScreencast" && startupFrames) queueMicrotask(() => emit(startupData)); return result ?? {}; },
    addListener: listener => listeners.add(listener), removeListener: listener => listeners.delete(listener),
    isCurrent: (_tabId, token) => token === attachment,
    isExternal: () => external
  });
  const check = () => { if (!allowed) throw new Error("permission changed"); };
  return { broker, calls, frames, emit, listeners, drains, streams, token: () => attachment,
    subscribe: options => broker.subscribe(7, attachment, check, frame => frames.push(frame), options),
    replace() { const old = attachment; attachment = {}; broker.released(7, old); queues.delete(7); },
    revoke() { allowed = false; }, external() { external = true; } };
}

test("viewer frames have independent monotonic sequences and one native ACK per event", async () => {
  const f = fixture(), subscription = await f.subscribe();
  f.emit("c2Vjb25k", { timestamp: 1, deviceWidth: 800, arbitrary: "not forwarded", pageScaleFactor: Infinity });
  f.emit("dGhpcmQ="); await tick();
  assert.deepEqual(f.frames.map(frame => frame.sequence), [1, 2, 3]);
  assert.equal(new Set(f.frames.map(frame => frame.streamId)).size, 1);
  assert.deepEqual(f.frames[1].metadata, { deviceWidth: 800, timestamp: 1 });
  assert.equal(f.frames[1].mimeType, "image/png");
  assert.equal(f.calls.filter(call => call.method === "Page.screencastFrameAck").length, 3);
  await subscription.close();
  assert.equal(f.listeners.size, 0); assert.equal(f.drains.size, 0);
});

test("an oversized native frame retires the viewer explicitly without cancelling its borrowed action", async () => {
  const f = fixture(), subscription = await f.subscribe();
  let cancelled = false;
  const borrow = f.broker.borrow(7, f.token(), () => { cancelled = true; });
  // This is one decoded byte over the limit, with the same base64 length as
  // an allowed 4 MiB image; the byte limit must also account for padding.
  f.emit(Buffer.alloc(4 * 1024 * 1024 + 1).toString("base64"));
  assert.match((await subscription.closed).reason, /OBU_VIEWER_FRAME_TOO_LARGE/);
  await tick();
  assert.equal(f.frames.length, 1);
  assert.equal(f.calls.filter(call => call.method === "Page.screencastFrameAck").length, 2);
  assert.equal(cancelled, false); borrow.release();
  await subscription.close();
  assert.equal(f.calls.filter(call => call.method === "Page.stopScreencast").length, 1);
  assert.equal(f.drains.size, 0); assert.equal(f.listeners.size, 0);
});

test("an oversized first native frame rejects subscription only after its actual ACK and stop", async () => {
  const ack = deferred(), stop = deferred();
  const f = fixture(method => method === "Page.screencastFrameAck" ? ack.promise : method === "Page.stopScreencast" ? stop.promise : undefined,
    { startupData: "x".repeat(8 * 1024 * 1024) });
  let finished = false;
  const failed = assert.rejects(f.subscribe(), /OBU_VIEWER_FRAME_TOO_LARGE/).then(() => { finished = true; });
  await tick();
  assert.equal(finished, false); assert.equal(f.frames.length, 0); assert.equal(f.listeners.size, 0);
  assert.equal(f.calls.filter(call => call.method === "Page.screencastFrameAck").length, 1);
  assert.equal(f.calls.some(call => call.method === "Page.stopScreencast"), false);
  assert.ok(f.drains.size);
  ack.resolve(); await tick();
  assert.equal(finished, false);
  assert.equal(f.calls.filter(call => call.method === "Page.stopScreencast").length, 1);
  stop.resolve(); await failed;
  assert.equal(f.frames.length, 0); assert.equal(f.drains.size, 0); assert.equal(f.broker.records.size, 0);
});

test("unsubscribe revokes publication immediately and waits for original ACK and stop", async () => {
  const ack = deferred(), stop = deferred(); let holdAck = false;
  const f = fixture(method => method === "Page.screencastFrameAck" && holdAck ? ack.promise : method === "Page.stopScreencast" ? stop.promise : undefined);
  const subscription = await f.subscribe(); holdAck = true; f.emit(); await tick();
  let closed = false; const closing = subscription.close().then(() => { closed = true; });
  await subscription.closed; f.emit(); await tick();
  assert.equal(f.frames.length, 1); assert.equal(closed, false);
  assert.equal(f.calls.some(call => call.method === "Page.stopScreencast"), false);
  ack.resolve(); await tick(); assert.equal(closed, false);
  assert.equal(f.calls.filter(call => call.method === "Page.stopScreencast").length, 1);
  stop.resolve(); await closing; assert.equal(f.drains.size, 0);
});

test("a real pending start remains in cleanup after the startup deadline", async () => {
  const start = deferred(), f = fixture(method => method === "Page.startScreencast" ? start.promise : undefined);
  f.broker.startupTimeoutMs = 10;
  let done = false; const failed = assert.rejects(f.subscribe(), /OBU_VIEWER_TIMEOUT/).then(() => { done = true; });
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(done, false); assert.equal(f.listeners.size, 0); assert.ok(f.drains.size);
  start.resolve(); await failed;
  assert.equal(f.calls.filter(call => call.method === "Page.stopScreencast").length, 1);
  assert.equal(f.drains.size, 0);
});

test("permission changes revoke both delivery and action borrowers before another native ACK", async () => {
  const f = fixture(), subscription = await f.subscribe(); let cancelled;
  f.broker.borrow(7, f.token(), error => { cancelled = error; });
  f.revoke(); f.emit(); await tick();
  assert.match(cancelled.message, /permission changed/);
  assert.match((await subscription.closed).reason, /permission changed/);
  assert.equal(f.frames.length, 1);
  assert.equal(f.calls.filter(call => call.method === "Page.screencastFrameAck").length, 1);
  await subscription.close();
});

test("a destroyed attachment's delayed start never stops the successor stream", async () => {
  const start = deferred(); let starts = 0;
  const f = fixture(method => method === "Page.startScreencast" && ++starts === 1 ? start.promise : undefined);
  const failed = assert.rejects(f.subscribe(), /cancelled because tab control ended/);
  await tick(); f.replace();
  const successor = await f.subscribe(); start.resolve(); await failed;
  assert.equal(f.calls.some(call => call.method === "Page.stopScreencast"), false);
  await successor.close();
  assert.equal(f.calls.filter(call => call.method === "Page.stopScreencast").length, 1);
});

test("native ACK backlog is bounded and a failed stop is retried only by explicit close", async () => {
  const ack = deferred(); let holdAck = false, stops = 0;
  const f = fixture(method => {
    if (method === "Page.screencastFrameAck" && holdAck) return ack.promise;
    if (method === "Page.stopScreencast" && ++stops === 1) throw new Error("native stop refused");
  });
  const subscription = await f.subscribe(); holdAck = true;
  for (let index = 0; index < 6; index++) { f.emit(); await tick(); }
  assert.equal(f.calls.filter(call => call.method === "Page.screencastFrameAck").length, 5);
  assert.match((await subscription.closed).reason, /bounded capacity/);
  ack.resolve(); await tick(); await tick();
  assert.equal(stops, 1);
  await subscription.close(); assert.equal(stops, 2);
});

test("an external owner is never changed or ACKed by a viewer", async () => {
  const f = fixture(); f.external();
  await assert.rejects(f.subscribe(), /caller-owned screencast/);
  f.emit(); await tick(); assert.deepEqual(f.calls, []);
});


test("filtered captures receive their original ACK without satisfying startup", async () => {
  const f = fixture();
  let ready = false;
  const opening = f.broker.subscribe(7, f.token(), () => {}, frame => f.frames.push(frame),
    { acceptFrame: frame => frame.metadata.monotonicTimestamp > 100 }).then(value => { ready = true; return value; });
  await tick(); assert.equal(ready, false); assert.equal(f.frames.length, 0);
  f.emit("b2xk", { timestamp: 9999999999, monotonicTimestamp: 99 }); await tick();
  assert.equal(ready, false); assert.equal(f.calls.filter(call => call.method === "Page.screencastFrameAck").length, 2);
  f.emit("bmV3", { monotonicTimestamp: 101 }); const subscription = await opening;
  assert.equal(f.frames.length, 1); assert.equal(f.frames[0].sequence, 3);
  assert.equal(f.frames[0].metadata.monotonicTimestamp, 101); await subscription.close();
});

test("a failed capture proof retains native ACK and cleanup rather than publishing ready", async () => {
  const f = fixture();
  await assert.rejects(f.broker.subscribe(7, f.token(), () => {}, frame => f.frames.push(frame),
    { acceptFrame: () => { throw new Error("missing capture proof"); } }), /missing capture proof/);
  assert.equal(f.frames.length, 0); assert.equal(f.calls.filter(call => call.method === "Page.screencastFrameAck").length, 1);
  assert.equal(f.calls.filter(call => call.method === "Page.stopScreencast").length, 1);
  assert.equal(f.listeners.size, 0); assert.equal(f.drains.size, 0);
});

function startupClock() {
  let now = 0, sequence = 0; const timers = new Map();
  const timing = { now: () => now, setTimer: (fn, ms) => { timers.set(++sequence, { fn, at: now + ms }); return sequence; }, clearTimer: id => timers.delete(id) };
  return { timing, skip: ms => { now += ms; }, advance(ms) { now += ms; for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); } } };
}

test("an owner preparation budget replaces only the fixed startup timer and does not forget real start", async () => {
  const start = deferred(), f = fixture(method => method === "Page.startScreencast" ? start.promise : undefined), clock = startupClock();
  f.broker.startupTimeoutMs = 5;
  const budget = new ManagedHumanPreparationBudget({ timing: clock.timing, onExpire: () => {} }); budget.openModal({});
  let settled = false;
  const opening = f.broker.subscribe(7, f.token(), () => {}, frame => { f.frames.push(frame); budget.finish(); }, { startupBudget: budget }).then(value => { settled = true; return value; });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(settled, false); assert.equal(f.listeners.size, 1); assert.ok(f.drains.size);
  clock.advance(40000); start.resolve(); const subscription = await opening;
  assert.equal(f.frames.length, 1); await subscription.close(); assert.equal(f.drains.size, 0);
});

test("owner expiry revokes delivery immediately but joins actual start and stop acknowledgements", async () => {
  const start = deferred(), stop = deferred(), clock = startupClock();
  const f = fixture(method => method === "Page.startScreencast" ? start.promise : method === "Page.stopScreencast" ? stop.promise : undefined);
  const budget = new ManagedHumanPreparationBudget({ timing: clock.timing, onExpire: () => {} });
  let settled = false;
  const failed = assert.rejects(f.broker.subscribe(7, f.token(), () => {}, frame => f.frames.push(frame), { startupBudget: budget }), /PREPARATION_TIMEOUT/).then(() => { settled = true; });
  await tick(); clock.advance(5000); await tick();
  assert.equal(f.listeners.size, 0); assert.equal(settled, false); assert.ok(f.drains.size);
  assert.equal(f.calls.some(call => call.method === "Page.stopScreencast"), false);
  start.resolve(); await tick(); assert.equal(settled, false);
  assert.equal(f.calls.filter(call => call.method === "Page.stopScreencast").length, 1);
  stop.resolve(); await failed; assert.equal(f.frames.length, 0); assert.equal(f.drains.size, 0);
});

for (const boundary of ["Page.enable", "Page.screencastFrameAck"]) test(`delayed owner timer cannot authorize startup after ${boundary} ACK`, async () => {
  const gate = deferred(), clock = startupClock(), f = fixture(method => method === boundary ? gate.promise : undefined);
  const budget = new ManagedHumanPreparationBudget({ timing: clock.timing, onExpire: () => {} });
  const opening = f.broker.subscribe(7, f.token(), () => {}, frame => f.frames.push(frame), { startupBudget: budget });
  const outcome = opening.then(subscription => ({ subscription }), error => ({ error }));
  await tick(); clock.skip(5001); gate.resolve(); const result = await outcome;
  if (result.subscription) await result.subscription.close(); // Keep failed counterexample resource-clean.
  budget.finish();
  assert.match(String(result.error?.message), /PREPARATION_TIMEOUT/);
  assert.equal(f.frames.length, 0, "a late real ACK is not permission to publish first geometry");
  if (boundary === "Page.enable") assert.equal(f.calls.some(call => call.method === "Page.startScreencast"), false);
  assert.equal(f.drains.size, 0);
});

test("an owner deadline after successful startup cannot close the established rendering subscription", async () => {
  const f = fixture(), clock = startupClock();
  const budget = new ManagedHumanPreparationBudget({ timing: clock.timing, onExpire: () => {} });
  const subscription = await f.broker.subscribe(7, f.token(), () => {}, frame => f.frames.push(frame), { startupBudget: budget });
  clock.advance(5000); await tick();
  assert.equal(f.listeners.size, 1); assert.equal(f.calls.some(call => call.method === "Page.stopScreencast"), false);
  await subscription.close(); assert.equal(f.drains.size, 0);
});

for (const method of ["Page.enable", "Page.startScreencast"]) test(`the original owner budget is checked at final ${method} native dispatch`, async () => {
  const gate = deferred(), clock = startupClock(), f = fixture(), send = f.broker.send;
  let queued = false;
  f.broker.send = async (target, current, params, finalCheck) => {
    if (current === method) { queued = true; await gate.promise; }
    return send(target, current, params, finalCheck);
  };
  const budget = new ManagedHumanPreparationBudget({ timing: clock.timing, onExpire: () => {} });
  const outcome = f.broker.subscribe(7, f.token(), () => {}, frame => f.frames.push(frame), { startupBudget: budget })
    .then(subscription => ({ subscription }), error => ({ error }));
  await tick(); assert.equal(queued, true); clock.skip(5001); gate.resolve();
  const result = await outcome;
  if (result.subscription) await result.subscription.close();
  budget.finish();
  assert.match(String(result.error?.message), /PREPARATION_TIMEOUT/);
  assert.equal(f.calls.some(call => call.method === method), false, "queued setup is not actual native dispatch");
  assert.equal(f.frames.length, 0); assert.equal(f.drains.size, 0);
});

test("a delayed startup queue cannot introduce native setup after the original owner deadline", async () => {
  const gate = deferred(), clock = startupClock(), f = fixture(), queue = f.broker.queue;
  let first = true;
  f.broker.queue = (tabId, operation) => queue(tabId, async () => { if (first) { first = false; await gate.promise; } return operation(); });
  const budget = new ManagedHumanPreparationBudget({ timing: clock.timing, onExpire: () => {} });
  const failed = assert.rejects(f.broker.subscribe(7, f.token(), () => {}, frame => f.frames.push(frame), { startupBudget: budget }), /PREPARATION_TIMEOUT/);
  await tick(); clock.skip(5001); gate.resolve(); await failed;
  assert.deepEqual(f.calls, []); assert.equal(f.listeners.size, 0); assert.equal(f.drains.size, 0);
});

test("acceptFrame cannot cross the owner deadline and publish expired first geometry", async () => {
  const clock = startupClock(), f = fixture();
  const budget = new ManagedHumanPreparationBudget({ timing: clock.timing, onExpire: () => {} });
  await assert.rejects(f.broker.subscribe(7, f.token(), () => {}, frame => f.frames.push(frame), {
    startupBudget: budget, acceptFrame: () => { clock.skip(5001); return true; }
  }), /PREPARATION_TIMEOUT/);
  assert.equal(f.frames.length, 0); assert.equal(f.calls.filter(call => call.method === "Page.screencastFrameAck").length, 1);
  assert.equal(f.calls.filter(call => call.method === "Page.stopScreencast").length, 1); assert.equal(f.drains.size, 0);
});

test("a first published frame finishes the owner clock while the original start ACK remains pending", async () => {
  const start = deferred(), clock = startupClock(), f = fixture(method => method === "Page.startScreencast" ? start.promise : undefined);
  const budget = new ManagedHumanPreparationBudget({ timing: clock.timing, onExpire: () => {} });
  let settled = false;
  const opening = f.broker.subscribe(7, f.token(), () => {}, frame => { f.frames.push(frame); budget.finish(); }, { startupBudget: budget })
    .then(subscription => { settled = true; return subscription; });
  await tick(); f.emit(); await tick();
  assert.equal(f.frames.length, 1); assert.equal(settled, false); assert.ok(f.drains.size);
  clock.skip(5001); start.resolve(); const subscription = await opening;
  assert.equal(f.frames.length, 2); assert.equal(f.listeners.size, 1);
  await subscription.close(); assert.equal(f.drains.size, 0);
});

for (const options of [undefined, { captureHiddenSurface: false }]) test(`hidden surface capture is opt-in (${options ? "false" : "default"})`, async () => {
  const f = fixture(), subscription = await f.subscribe(options);
  assert.equal(f.calls.some(call => call.method === "Page.captureScreenshot"), false);
  await subscription.close(); assert.equal(f.drains.size, 0);
});

test("hidden surface capture rejects non-boolean options before acquiring resources", async () => {
  for (const captureHiddenSurface of [null, 0, 1, "true", {}, []]) {
    const f = fixture();
    await assert.rejects(f.subscribe({ captureHiddenSurface }), /OBU_VIEWER_INVALID/);
    assert.deepEqual(f.calls, []); assert.equal(f.broker.records.size, 0);
    assert.equal(f.listeners.size, 0); assert.equal(f.drains.size, 0);
  }
});

test("an accepted native frame before start ACK skips hidden surface capture", async () => {
  const start = deferred(), f = fixture(method => method === "Page.startScreencast" ? start.promise : undefined, { startupFrames: false });
  let settled = false;
  const opening = f.subscribe({ captureHiddenSurface: true }).then(value => { settled = true; return value; });
  await tick(); f.emit(); await tick();
  assert.equal(f.frames.length, 1); assert.equal(settled, false);
  assert.equal(f.calls.filter(call => call.method === "Page.screencastFrameAck").length, 1);
  start.resolve(); const subscription = await opening;
  assert.equal(f.calls.some(call => call.method === "Page.captureScreenshot"), false);
  await subscription.close(); assert.equal(f.drains.size, 0);
});

test("hidden surface screenshot ACK cannot replace the original screencast capture barrier", async () => {
  const f = fixture(method => method === "Page.captureScreenshot" ? { data: "c2NyZWVuc2hvdA==" } : undefined, { startupFrames: false });
  let settled = false;
  const opening = f.subscribe({ captureHiddenSurface: true, acceptFrame: frame => frame.metadata.monotonicTimestamp > 100 })
    .then(value => { settled = true; return value; });
  await tick();
  assert.deepEqual(f.calls.map(call => call.method), ["Page.enable", "Page.startScreencast", "Page.captureScreenshot"]);
  assert.deepEqual(f.calls[2], { target: { tabId: 7 }, method: "Page.captureScreenshot", params: { format: "png", fromSurface: true, captureBeyondViewport: false } });
  assert.equal(settled, false); assert.deepEqual(f.frames, []);
  for (const metadata of [{ timestamp: 9999999999 }, { monotonicTimestamp: 99 }, { monotonicTimestamp: 100 }]) {
    f.emit("b2xk", metadata); await tick();
    assert.equal(settled, false); assert.equal(f.frames.length, 0);
  }
  f.emit("bmV3", { monotonicTimestamp: 101 }); const subscription = await opening;
  assert.equal(f.calls.filter(call => call.method === "Page.screencastFrameAck").length, 4);
  assert.equal(f.calls.filter(call => call.method === "Page.captureScreenshot").length, 1);
  assert.equal(f.frames.length, 1); assert.equal(f.frames[0].data, "bmV3");
  assert.equal(f.frames[0].metadata.monotonicTimestamp, 101);
  await subscription.close(); assert.equal(f.drains.size, 0);
});

for (const pendingAck of [false, true]) test(`an ${pendingAck ? "unacknowledged" : "old rejected"} frame cannot skip hidden surface capture`, async () => {
  const start = deferred(), ack = deferred();
  const f = fixture(method => method === "Page.startScreencast" ? start.promise : method === "Page.screencastFrameAck" && pendingAck ? ack.promise : undefined,
    { startupFrames: false });
  const opening = f.subscribe({ captureHiddenSurface: true, acceptFrame: frame => frame.metadata.monotonicTimestamp > 100 });
  await tick(); f.emit("b2xk", { monotonicTimestamp: pendingAck ? 101 : 99 }); await tick();
  assert.equal(f.frames.length, 0);
  assert.equal(f.calls.some(call => call.method === "Page.captureScreenshot"), false, "capture cannot precede the actual start ACK");
  start.resolve(); await tick();
  assert.equal(f.calls.filter(call => call.method === "Page.captureScreenshot").length, 1);
  assert.equal(f.frames.length, 0);
  if (pendingAck) ack.resolve();
  else f.emit("bmV3", { monotonicTimestamp: 101 });
  const subscription = await opening;
  await subscription.close(); assert.equal(f.drains.size, 0);
});

test("a failed hidden surface capture stops the acknowledged stream before rejecting startup", async () => {
  const stop = deferred();
  const f = fixture(method => {
    if (method === "Page.captureScreenshot") throw new Error("original screenshot failed");
    if (method === "Page.stopScreencast") return stop.promise;
  }, { startupFrames: false });
  let settled = false;
  const failed = assert.rejects(f.subscribe({ captureHiddenSurface: true }), /original screenshot failed/).then(() => { settled = true; });
  await tick();
  assert.equal(settled, false); assert.equal(f.listeners.size, 0); assert.equal(f.frames.length, 0);
  assert.equal(f.calls.filter(call => call.method === "Page.stopScreencast").length, 1);
  assert.equal(f.broker.records.size, 1); assert.ok(f.drains.size);
  stop.resolve(); await failed;
  assert.equal(f.broker.records.size, 0); assert.equal(f.drains.size, 0);
});

test("a native frame during pending hidden capture cannot turn a later capture failure into startup success", async () => {
  const capture = deferred(), f = fixture(method => method === "Page.captureScreenshot" ? capture.promise : undefined, { startupFrames: false });
  let settled = false;
  const outcome = f.subscribe({ captureHiddenSurface: true }).then(subscription => ({ subscription }), error => ({ error })).then(value => { settled = true; return value; });
  await tick(); f.emit(); await tick();
  assert.equal(f.frames.length, 1); assert.equal(settled, false); assert.ok(f.drains.size);
  capture.reject(new Error("original capture failed after frame")); const result = await outcome;
  assert.equal(result.subscription, undefined); assert.match(result.error.message, /original capture failed after frame/);
  assert.equal(f.calls.filter(call => call.method === "Page.stopScreencast").length, 1);
  assert.equal(f.listeners.size, 0); assert.equal(f.broker.records.size, 0); assert.equal(f.drains.size, 0);
});

test("the original view timeout retains a pending hidden capture even after an accepted frame", async () => {
  const capture = deferred(), stop = deferred();
  const f = fixture(method => {
    if (method === "Page.captureScreenshot") { f.emit(); return capture.promise; }
    if (method === "Page.stopScreencast") return stop.promise;
  }, { startupFrames: false });
  f.broker.startupTimeoutMs = 20;
  let settled = false;
  const failed = assert.rejects(f.subscribe({ captureHiddenSurface: true }), /OBU_VIEWER_TIMEOUT/).then(() => { settled = true; });
  await tick(); assert.equal(f.frames.length, 1);
  await new Promise(resolve => setTimeout(resolve, 35));
  assert.equal(settled, false); assert.equal(f.listeners.size, 0); assert.ok(f.drains.size);
  assert.equal(f.calls.some(call => call.method === "Page.stopScreencast"), false);
  await assert.rejects(f.subscribe(), /OBU_VIEWER_BUSY/);
  f.emit(); assert.equal(f.frames.length, 1);
  capture.resolve({ data: "bGF0ZQ==" }); await tick();
  assert.equal(settled, false); assert.equal(f.calls.filter(call => call.method === "Page.stopScreencast").length, 1);
  stop.resolve(); await failed; assert.equal(f.broker.records.size, 0); assert.equal(f.drains.size, 0);
});

test("cancelling hidden capture joins its actual reply and stop before allowing a successor", async () => {
  const capture = deferred(), stop = deferred();
  const f = fixture(method => method === "Page.captureScreenshot" ? capture.promise : method === "Page.stopScreencast" ? stop.promise : undefined,
    { startupFrames: false });
  let settled = false, closed = false;
  const failed = assert.rejects(f.subscribe({ captureHiddenSurface: true }), /cancelled because tab control ended/).then(() => { settled = true; });
  await tick(); const record = f.broker.records.get(7);
  const closing = f.broker.cancel(7, f.token()); closing.then(() => { closed = true; });
  assert.equal(f.broker.cancel(7, f.token()), closing);
  await record.closed.promise; f.emit(); await tick();
  assert.equal(f.listeners.size, 0); assert.equal(f.frames.length, 0); assert.equal(settled, false); assert.equal(closed, false);
  await assert.rejects(f.subscribe(), /OBU_VIEWER_BUSY/);
  assert.equal(f.calls.some(call => call.method === "Page.stopScreencast"), false);
  capture.resolve({ data: "bGF0ZQ==" }); await tick();
  assert.equal(settled, false); assert.equal(closed, false);
  assert.equal(f.calls.filter(call => call.method === "Page.stopScreencast").length, 1);
  stop.resolve(); await Promise.all([closing, failed]); assert.equal(f.drains.size, 0);
  const next = f.subscribe(); await tick(); f.emit(); const successor = await next;
  await successor.close(); assert.equal(f.drains.size, 0);
});

test("revocation at the final hidden capture dispatch sends no obsolete native capture", async () => {
  const gate = deferred(), f = fixture(undefined, { startupFrames: false }), send = f.broker.send;
  let queued = false;
  f.broker.send = async (target, method, params, finalCheck) => {
    if (method === "Page.captureScreenshot") { queued = true; await gate.promise; }
    return send(target, method, params, finalCheck);
  };
  const failed = assert.rejects(f.subscribe({ captureHiddenSurface: true }), /cancelled because tab control ended/);
  await tick(); assert.equal(queued, true);
  const closing = f.broker.cancel(7, f.token()); gate.resolve();
  await Promise.all([closing, failed]);
  assert.equal(f.calls.some(call => call.method === "Page.captureScreenshot"), false);
  assert.equal(f.calls.filter(call => call.method === "Page.stopScreencast").length, 1);
  assert.equal(f.frames.length, 0); assert.equal(f.drains.size, 0);
});

test("failed hidden capture cleanup retains the original stop barrier until explicit retry", async () => {
  let stops = 0;
  const f = fixture(method => {
    if (method === "Page.captureScreenshot") throw new Error("original capture failed");
    if (method === "Page.stopScreencast" && ++stops === 1) throw new Error("original stop unconfirmed");
  }, { startupFrames: false });
  await assert.rejects(f.subscribe({ captureHiddenSurface: true }), error => error.viewerCleanupIncomplete === true && /original stop unconfirmed/.test(error.message));
  assert.equal(stops, 1); assert.equal(f.broker.records.size, 1); assert.equal(f.listeners.size, 0);
  await assert.rejects(f.subscribe(), /OBU_VIEWER_BUSY/); assert.equal(stops, 1);
  await f.broker.cancel(7, f.token()); assert.equal(stops, 2); assert.equal(f.broker.records.size, 0);
  const next = f.subscribe(); await tick(); f.emit(); const successor = await next;
  await successor.close(); assert.equal(f.drains.size, 0);
});

test("a destroyed attachment's pending hidden capture never stops the successor stream", async () => {
  const capture = deferred(), f = fixture(method => method === "Page.captureScreenshot" ? capture.promise : undefined, { startupFrames: false });
  const failed = assert.rejects(f.subscribe({ captureHiddenSurface: true }), /cancelled because tab control ended/);
  await tick(); f.replace();
  const next = f.subscribe(); await tick(); f.emit(); const successor = await next;
  assert.ok(f.drains.size, "the original actual capture remains tracked after detach");
  capture.resolve(); await failed;
  assert.equal(f.calls.some(call => call.method === "Page.stopScreencast"), false);
  await successor.close();
  assert.equal(f.calls.filter(call => call.method === "Page.stopScreencast").length, 1); assert.equal(f.drains.size, 0);
});
