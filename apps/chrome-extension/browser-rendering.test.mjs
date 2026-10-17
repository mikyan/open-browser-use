import assert from "node:assert/strict";
import test from "node:test";
import { BrowserRendering } from "./browser-rendering.js";

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function fixture(command = async () => {}, { startupData = "aW1hZ2U=" } = {}) {
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
    async send(target, method, params) { calls.push({ target, method, params }); await command(method); if (method === "Page.startScreencast") queueMicrotask(() => emit(startupData)); return {}; },
    addListener: listener => listeners.add(listener), removeListener: listener => listeners.delete(listener),
    isCurrent: (_tabId, token) => token === attachment,
    isExternal: () => external
  });
  const check = () => { if (!allowed) throw new Error("permission changed"); };
  return { broker, calls, frames, emit, listeners, drains, streams, token: () => attachment,
    subscribe: () => broker.subscribe(7, attachment, check, frame => frames.push(frame)),
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
