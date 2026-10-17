import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { installManagedUserBridge } from "./managed-user-bridge.js";

const runId = "0123456789abcdef0123456789abcdef";
const config = { version: 1, nativeHostName: `com.openbrowseruse.managed.n${runId}` };
const key = "a".repeat(64);
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const flush = async () => { await delay(0); };

function fixture(t, options = {}) {
  let time = 0, channelCount = 0;
  const timers = new Set(), events = [], subscriptions = [], calls = [], state = { state: "running", revision: 0, cleanupComplete: false };
  const proof = Object.freeze({ nonce: "native-challenge", extensionId: "a".repeat(32), extensionInstanceId: "instance", workerBootId: "worker", portId: "port" });
  const target = { __obuNativeDownloadBinding: proof, __obuManagedViewerEvent: raw => events.push(JSON.parse(raw)) };
  const f = { target, events, subscriptions, calls, state, liveTabs: [{ id: 7, title: "Owned tab", url: "https://example.test/" }], resumeGate: null, subscribeGate: null, closeGate: null,
    openArgs: { version: 1, runId, extensionId: proof.extensionId, extensionInstanceId: proof.extensionInstanceId, workerBootId: proof.workerBootId, portId: proof.portId, channelKey: key } };
  const backend = {
    async getAutomationControlStatus() { return { ...state }; },
    async getManagedViewerTabs() { return f.liveTabs; },
    async managedViewerSubscribe(tabId, onFrame) {
      calls.push(["subscribe", tabId]);
      const closed = deferred();
      const record = { tabId, onFrame, closeCalls: 0, closed, handle: {
        closed: closed.promise,
        async close() { record.closeCalls++; calls.push(["close", tabId]); await f.closeGate?.promise; closed.resolve({ reason: "closed" }); }
      } };
      subscriptions.push(record);
      await f.subscribeGate?.promise;
      return record.handle;
    },
    async pauseAutomation() {
      calls.push(["pause"]); state.state = "pausing";
      await flush(); state.state = "paused"; state.revision++; state.cleanupComplete = true;
      return { ...state };
    },
    async resumeAutomation(revision, assertAuthority) {
      calls.push(["resume", revision]);
      assertAuthority();
      if (revision !== state.revision) throw new Error("OBU_CONTROL_REVISION_CONFLICT");
      if (state.state !== "paused" || !state.cleanupComplete) throw new Error("OBU_AUTOMATION_PAUSE_INCOMPLETE");
      assertAuthority(); await f.resumeGate?.promise; assertAuthority();
      state.state = "running"; state.revision++; state.cleanupComplete = false;
      return { ...state };
    }
  };
  f.backend = backend;
  f.api = installManagedUserBridge({ config, backend, getInstanceId: async () => proof.extensionInstanceId, target,
    now: () => time, wallNow: () => 1700000000000 + time, newChannelId: () => `channel-${++channelCount}`,
    setTimer: (fn, ms) => { const timer = setTimeout(() => { timers.delete(timer); fn(); }, options.fastTimers ? Math.min(ms, 10) : ms); timers.add(timer); return timer; },
    clearTimer: timer => { clearTimeout(timer); timers.delete(timer); }, ...options.install });
  f.open = extra => f.api.open({ ...f.openArgs, ...extra });
  f.request = (operation, extra = {}) => f.api.request({ operation, channelKey: key, ...extra });
  f.frame = (sequence, extra = {}, subscription = subscriptions.at(-1)) => subscription.onFrame({ tabId: subscription.tabId, streamId: `stream-${subscription.tabId}`, sequence,
    mimeType: "image/png", data: Buffer.from(`frame ${sequence}`).toString("base64"), metadata: { deviceWidth: 800, deviceHeight: 600, timestamp: sequence, documentId: "not-proof" }, ...extra });
  f.advance = ms => { time += ms; };
  t.after(async () => {
    f.resumeGate?.resolve(); f.subscribeGate?.resolve(); f.closeGate?.resolve();
    try { await f.request("disconnect"); } catch { /* already revoked */ }
    for (const timer of timers) clearTimeout(timer);
  });
  return f;
}

test("ordinary package installs no control surface; managed surface is immutable", t => {
  const target = {};
  assert.equal(installManagedUserBridge({ config: null, target }), null);
  assert.equal(Object.hasOwn(target, "__obuManagedUser"), false);
  assert.throws(() => installManagedUserBridge({ config: undefined, target }), /OBU_MANAGED_CONFIG_INVALID/);
  const f = fixture(t);
  assert.equal(Object.isFrozen(f.api), true);
  assert.deepEqual(Object.keys(f.api), ["open", "request"]);
  assert.deepEqual(Object.getOwnPropertyDescriptor(f.target, "__obuManagedUser"), { value: f.api, writable: false, configurable: false, enumerable: false });
  assert.throws(() => { f.target.__obuManagedUser = {}; }, TypeError);
});

test("open proves original worker identity and returns metadata without channel secret", async t => {
  const f = fixture(t), opened = await f.open();
  assert.equal(opened.channelId, "channel-1");
  assert.equal(opened.workerBootId, "worker");
  assert.deepEqual(opened.status.tabs, f.liveTabs);
  assert.equal(opened.status.selectedTabId, null);
  assert.equal(opened.status.leaseMs, 10000);
  assert.equal(opened.status.heartbeatMs, 3000);
  assert.equal(JSON.stringify(opened).includes(key), false);
  await assert.rejects(f.open({ channelKey: "b".repeat(64) }), /BUSY/);
  await assert.rejects(f.request("status", { channelKey: "b".repeat(64) }), /IDENTITY/);
  assert.deepEqual(f.calls, []);
});

test("malformed and inherited fields never invoke getters or backend controls", async t => {
  const f = fixture(t);
  let getterCalls = 0;
  const accessor = { ...f.openArgs }; Object.defineProperty(accessor, "runId", { get() { getterCalls++; return runId; } });
  for (const value of [null, [], Object.create(f.openArgs), { ...f.openArgs, extra: true }, { ...f.openArgs, [Symbol("extra")]: true }, accessor])
    await assert.rejects(f.api.open(value), /PROTOCOL/);
  const coercible = { toString() { getterCalls++; return key; } };
  for (const extra of [{ runId: "f".repeat(32) }, { extensionId: "x".repeat(32) }, { extensionId: coercible }, { workerBootId: "other" }, { channelKey: "short" }, { channelKey: `${key}\n` }, { channelKey: coercible }, { version: 2 }])
    await assert.rejects(f.open(extra), /IDENTITY/);
  await f.open();
  const operations = ["evaluate", "click", "attach", "Page.startScreencast", "SET_SITE_ACCESS_POLICY"];
  for (const operation of operations) await assert.rejects(f.request(operation), /PROTOCOL/);
  for (const [operation, extra] of [["status", { tabId: 7 }], ["select", { tabId: "7" }], ["select", { tabId: -1 }], ["resume", { expectedRevision: 0 }], ["ack", { sequence: 0 }], ["pause", { expectedRevision: 0 }]])
    await assert.rejects(f.request(operation, extra), /PROTOCOL/);
  const request = { channelKey: key }; Object.defineProperty(request, "operation", { get() { getterCalls++; return "pause"; } });
  await assert.rejects(f.api.request(request), /PROTOCOL/);
  assert.equal(getterCalls, 0); assert.deepEqual(f.calls, []);
});

test("open cannot cross an asynchronous native proof replacement", async t => {
  const gate = deferred();
  const f = fixture(t, { install: { getInstanceId: () => gate.promise } });
  const pending = f.open();
  f.target.__obuNativeDownloadBinding = Object.freeze({ ...f.target.__obuNativeDownloadBinding });
  gate.resolve("instance");
  await assert.rejects(pending, /IDENTITY/);
  assert.deepEqual(f.calls, []);
});

test("one outstanding frame and one replaceable latest frame, with independent sequences", async t => {
  const f = fixture(t); await f.open(); await f.request("select", { tabId: 7 });
  f.frame(10); f.frame(11); f.frame(12);
  let frames = f.events.filter(event => event.type === "frame");
  assert.equal(frames.length, 1); assert.equal(frames[0].frameSequence, 10);
  assert.equal(frames[0].metadata.documentId, undefined);
  assert.equal(JSON.stringify(f.events).includes(key), false);
  await assert.rejects(f.request("ack", { sequence: frames[0].sequence + 100 }), /ACK/);
  await f.request("heartbeat");
  await f.request("ack", { sequence: frames[0].sequence });
  frames = f.events.filter(event => event.type === "frame");
  assert.deepEqual(frames.map(event => event.frameSequence), [10, 12]);
  assert.ok(frames[1].sequence > frames[0].sequence + 1);
  await assert.rejects(f.request("ack", { sequence: frames[0].sequence }), /ACK/);
  await f.request("ack", { sequence: frames[1].sequence });
  f.frame(12); f.frame(13);
  assert.deepEqual(f.events.filter(event => event.type === "frame").map(event => event.frameSequence), [10, 12, 13]);
});

test("a decoded 4 MiB frame is allowed and oversize or malformed frames revoke viewing", async t => {
  const f = fixture(t); await f.open(); await f.request("select", { tabId: 7 });
  f.frame(1, { data: Buffer.alloc(4 * 1024 * 1024).toString("base64") });
  assert.equal(f.events.filter(event => event.type === "frame").length, 1);
  f.frame(2, { data: Buffer.alloc(4 * 1024 * 1024 + 1).toString("base64") });
  await flush();
  assert.equal(f.subscriptions[0].closeCalls, 1);
  assert.equal((await f.request("status")).status.selectedTabId, null);
  assert.match(f.events.find(event => event.type === "error").error, /4 MiB|oversized/);
  await f.request("select", { tabId: 7 });
  f.frame(3, { data: "!!!!" }); await flush();
  assert.equal(f.subscriptions[1].closeCalls, 1);
});

test("selection only uses live owned attachments and null stops watching without closing channel", async t => {
  const f = fixture(t); await f.open();
  await assert.rejects(f.request("select", { tabId: 8 }), /TAB/);
  assert.deepEqual(f.calls, []);
  await f.request("select", { tabId: 7 }); f.frame(1); f.frame(2);
  await f.request("select", { tabId: null }); f.frame(3);
  assert.equal(f.subscriptions[0].closeCalls, 1);
  assert.equal(f.events.filter(event => event.type === "frame").length, 1);
  assert.equal((await f.request("status")).status.connected, true);
  await f.request("select", { tabId: 7 }); f.frame(1);
  assert.equal(f.subscriptions.length, 2);
  assert.equal(f.events.filter(event => event.type === "frame").length, 2);
});

test("changing selection waits for actual old cleanup and ignores old frames", async t => {
  const f = fixture(t); f.liveTabs.push({ id: 8, title: "Second", url: "https://second.test/" });
  await f.open(); await f.request("select", { tabId: 7 });
  f.closeGate = deferred();
  const switching = f.request("select", { tabId: 8 }); await flush();
  f.frame(1); assert.equal(f.subscriptions.length, 1);
  assert.equal(f.events.filter(event => event.type === "frame").length, 0);
  f.closeGate.resolve(); await switching;
  assert.equal(f.subscriptions.length, 2);
  f.frame(1, {}, f.subscriptions[0]); f.frame(1);
  assert.deepEqual(f.events.filter(event => event.type === "frame").map(event => event.tabId), [8]);
});

test("attachment loss and producer retirement clear the original frame without subscribing again", async t => {
  const f = fixture(t); await f.open(); await f.request("select", { tabId: 7 }); f.frame(1);
  f.subscriptions[0].closed.resolve({ reason: "original attachment revoked" }); await flush();
  assert.equal((await f.request("status")).status.selectedTabId, null);
  f.frame(2); assert.equal(f.events.filter(event => event.type === "frame").length, 1);
  await f.request("select", { tabId: 7 });
  f.liveTabs = [];
  assert.deepEqual((await f.request("status")).status.tabs, []);
  assert.equal(f.subscriptions[1].closeCalls, 1);
  assert.equal(f.calls.filter(call => call[0] === "subscribe").length, 2);
});

test("lease expiration runs asynchronously, cancels its stream, and never resumes automation", async t => {
  const f = fixture(t, { fastTimers: true }); await f.open(); await f.request("select", { tabId: 7 }); f.frame(1);
  f.advance(9999); await delay(15);
  assert.equal(f.events.some(event => event.type === "closed"), false);
  f.advance(1); await delay(25);
  assert.equal(f.subscriptions[0].closeCalls, 1);
  assert.equal(f.events.at(-1).type, "closed");
  f.frame(2); await assert.rejects(f.request("heartbeat"), /CLOSED/);
  assert.equal(f.calls.some(call => call[0] === "resume"), false);
  await assert.rejects(f.open(), /REPLAY/);
});

test("only heartbeat renews the lease; status and frames do not keep it alive", async t => {
  const f = fixture(t); await f.open();
  f.advance(9000); await f.request("heartbeat");
  f.advance(9000); assert.equal((await f.request("status")).status.connected, true);
  f.advance(1000); await assert.rejects(f.request("status"), /CLOSED/);
  assert.equal(f.events.at(-1).type, "closed");
});

test("native proof or binding replacement revokes original channel without publishing late frames", async t => {
  const f = fixture(t); await f.open(); await f.request("select", { tabId: 7 }); f.frame(1);
  f.target.__obuNativeDownloadBinding = Object.freeze({ ...f.target.__obuNativeDownloadBinding });
  f.frame(2); await flush();
  assert.equal(f.events.filter(event => event.type === "frame").length, 1);
  assert.equal(f.subscriptions[0].closeCalls, 1);
  await assert.rejects(f.request("status"), /CLOSED/);
  await f.open({ channelKey: "b".repeat(64) });
  f.target.__obuManagedViewerEvent = () => {};
  await assert.rejects(f.api.request({ channelKey: "b".repeat(64), operation: "pause" }), /CLOSED/);
  assert.equal(f.calls.some(call => call[0] === "pause"), false);
});

test("pause uses existing backend control and resume requires current boot and revision", async t => {
  const f = fixture(t); await f.open(); await f.request("select", { tabId: 7 });
  const paused = await f.request("pause");
  assert.equal(paused.status.automation.state, "paused"); assert.equal(f.subscriptions[0].closeCalls, 1);
  await assert.rejects(f.request("resume", { expectedRevision: 1, expectedWorkerBootId: "old-worker" }), /REVISION/);
  assert.equal(f.calls.some(call => call[0] === "resume"), false);
  await assert.rejects(f.request("resume", { expectedRevision: 0, expectedWorkerBootId: "worker" }), /REVISION_CONFLICT/);
  assert.equal(f.state.state, "paused");
  const resumed = await f.request("resume", { expectedRevision: 1, expectedWorkerBootId: "worker" });
  assert.equal(resumed.status.automation.state, "running");
  assert.equal(resumed.status.workerBootId, "worker");
  assert.equal(f.calls.filter(call => call[0] === "subscribe").length, 1);
});

test("in-flight Resume cannot unblock after lease expiration while persistence is pending", async t => {
  const f = fixture(t, { fastTimers: true }); await f.open(); await f.request("pause");
  f.resumeGate = deferred();
  const resumed = f.request("resume", { expectedRevision: 1, expectedWorkerBootId: "worker" });
  const rejected = assert.rejects(resumed, /CLOSED/);
  await flush(); f.advance(10000); await delay(25);
  assert.equal(f.calls.filter(call => call[0] === "pause").length, 2);
  f.resumeGate.resolve(); await rejected;
  assert.equal(f.state.state, "paused");
});

test("disconnect during pending Subscribe fences callback then awaits original handle cleanup", async t => {
  const f = fixture(t); await f.open(); f.subscribeGate = deferred();
  const selected = f.request("select", { tabId: 7 });
  const rejected = assert.rejects(selected, /CLOSED/); await flush();
  let disconnected = false;
  const stopped = f.request("disconnect").then(value => { disconnected = true; return value; });
  await flush(); f.frame(1);
  assert.equal(disconnected, false); assert.equal(f.events.some(event => event.type === "frame"), false);
  await assert.rejects(f.open({ channelKey: "b".repeat(64) }), /CLEANUP/);
  f.subscribeGate.resolve(); await rejected;
  assert.equal((await stopped).status.connected, false);
  assert.equal(f.subscriptions[0].closeCalls, 1);
});

test("explicit disconnect is final and retired channel keys cannot replay", async t => {
  const f = fixture(t); await f.open();
  assert.equal((await f.request("disconnect")).disconnected, true);
  await assert.rejects(f.request("resume", { expectedRevision: 0, expectedWorkerBootId: "worker" }), /CLOSED/);
  await assert.rejects(f.open(), /REPLAY/);
  const second = await f.open({ channelKey: "b".repeat(64) });
  assert.equal(second.channelId, "channel-2");
  await assert.rejects(f.request("status"), /IDENTITY/);
  await f.api.request({ channelKey: "b".repeat(64), operation: "disconnect" });
});

test("actual close failure is reported and prevents a fresh subscription or channel", async t => {
  const f = fixture(t); await f.open(); await f.request("select", { tabId: 7 });
  f.subscriptions[0].handle.close = async () => { throw new Error("native stop refused"); };
  await assert.rejects(f.request("select", { tabId: null }), /native stop refused/);
  await assert.rejects(f.request("select", { tabId: 7 }), /CLEANUP/);
  await assert.rejects(f.request("disconnect"), /CLEANUP/);
  await assert.rejects(f.open({ channelKey: "b".repeat(64) }), /CLEANUP/);
});

test("disconnect joins cleanup already started by producer retirement", async t => {
  const f = fixture(t); await f.open(); await f.request("select", { tabId: 7 });
  f.closeGate = deferred();
  f.subscriptions[0].closed.resolve({ reason: "original page retired" }); await flush();
  assert.equal((await f.request("status")).status.cleanupPending, 1);
  let settled = false;
  const stopped = f.request("disconnect").then(() => { settled = true; });
  await flush(); assert.equal(settled, false);
  await assert.rejects(f.open({ channelKey: "b".repeat(64) }), /CLEANUP/);
  f.closeGate.resolve(); await stopped;
  assert.equal(f.subscriptions[0].closeCalls, 1);
});

test("new selection joins cleanup started before it was requested", async t => {
  const f = fixture(t); await f.open(); await f.request("select", { tabId: 7 });
  f.closeGate = deferred();
  f.subscriptions[0].closed.resolve({ reason: "original stream retired" }); await flush();
  const selected = f.request("select", { tabId: 7 }); await flush();
  assert.equal(f.subscriptions.length, 1);
  f.closeGate.resolve(); await selected;
  assert.equal(f.subscriptions.length, 2);
});

test("failed Subscribe preserves explicitly unconfirmed native cleanup", async t => {
  const f = fixture(t); await f.open();
  f.backend.managedViewerSubscribe = async () => { throw Object.assign(new Error("native stop failed during startup"), { viewerCleanupIncomplete: true }); };
  await assert.rejects(f.request("select", { tabId: 7 }), /native stop failed/);
  assert.match((await f.request("status")).status.cleanupError, /native stop failed/);
  await assert.rejects(f.request("select", { tabId: 7 }), /CLEANUP/);
  await assert.rejects(f.request("disconnect"), /CLEANUP/);
});

test("live status is bounded and contains only allowed tab metadata", async t => {
  const f = fixture(t);
  f.liveTabs[0].body = "page contents must not be read";
  f.liveTabs[0].secret = "backend-private";
  const opened = await f.open();
  assert.deepEqual(Object.keys(opened.status.tabs[0]), ["id", "title", "url"]);
  f.liveTabs = Array.from({ length: 200 }, (_, id) => ({ id, title: "t", url: "x".repeat(8192) }));
  await assert.rejects(f.request("status"), /CAPACITY/);
  assert.deepEqual(f.calls, []);
});

test("status snapshot sequence matches its actual event and later clear supersedes old replies", async t => {
  const f = fixture(t); const opened = await f.open();
  assert.equal(opened.status.eventSequence, 0);
  const selected = await f.request("select", { tabId: 7 });
  const published = f.events.at(-1);
  assert.equal(selected.status.eventSequence, published.sequence);
  assert.equal(published.status.eventSequence, published.sequence);
  f.frame(1);
  const oldStatus = await f.request("status");
  assert.equal(oldStatus.status.eventSequence, f.events.at(-1).sequence);
  const unselected = await f.request("select", { tabId: null });
  assert.ok(unselected.status.eventSequence > oldStatus.status.eventSequence);
  assert.equal(unselected.status.eventSequence, f.events.at(-1).sequence);
});

test("Resume requires viewer cleanup even when backend automation is otherwise paused", async t => {
  const f = fixture(t); await f.open(); await f.request("select", { tabId: 7 });
  f.closeGate = deferred(); f.subscriptions[0].closed.resolve({ reason: "stream retired" }); await flush();
  Object.assign(f.state, { state: "paused", cleanupComplete: true, revision: 1 });
  await assert.rejects(f.request("resume", { expectedRevision: 1, expectedWorkerBootId: "worker" }), /CLEANUP/);
  assert.equal(f.calls.some(call => call[0] === "resume"), false);
  f.closeGate.resolve(); await flush();
  assert.equal((await f.request("resume", { expectedRevision: 1, expectedWorkerBootId: "worker" })).status.automation.state, "running");
});

test("a status waiting on tab metadata cannot publish automation older than a completed Pause", async t => {
  const f = fixture(t); await f.open();
  const entered = deferred(), held = deferred();
  let first = true;
  f.backend.getManagedViewerTabs = async () => {
    if (first) { first = false; entered.resolve(); await held.promise; }
    return f.liveTabs;
  };
  const older = f.request("status"); await entered.promise;
  const paused = await f.request("pause");
  held.resolve(); const refreshed = await older;
  assert.equal(paused.status.automation.state, "paused");
  assert.equal(refreshed.status.automation.state, "paused");
  assert.equal(refreshed.status.automation.revision, paused.status.automation.revision);
  assert.ok(refreshed.status.eventSequence >= paused.status.eventSequence);
  assert.equal(f.calls.filter(call => call[0] === "pause").length, 1);
});

test("a delayed old automation snapshot is reread after Resume without replaying control", async t => {
  const f = fixture(t); await f.open(); const paused = await f.request("pause");
  const entered = deferred(), held = deferred(); let first = true, observations = 0;
  f.backend.getAutomationControlStatus = async () => {
    observations++; const snapshot = { ...f.state };
    if (first) { first = false; entered.resolve(); await held.promise; }
    return snapshot;
  };
  const older = f.request("status"); await entered.promise;
  const resumed = await f.request("resume", { expectedRevision: paused.status.automation.revision, expectedWorkerBootId: "worker" });
  held.resolve(); const refreshed = await older;
  assert.equal(refreshed.status.automation.state, "running");
  assert.equal(refreshed.status.automation.revision, resumed.status.automation.revision);
  assert.ok(observations >= 3);
  assert.equal(f.calls.filter(call => call[0] === "resume").length, 1);
});
