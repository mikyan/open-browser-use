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
    f.humanBeginGate?.resolve(); f.humanInputGate?.resolve(); f.humanCloseGate?.resolve();
    try { await f.request("disconnect"); } catch { /* already revoked */ }
    for (const timer of timers) clearTimeout(timer);
  });
  return f;
}

function humanFixture(t) {
  const f = fixture(t);
  f.humans = [];
  f.backend.beginManagedHuman = async (tabId, authority, onFrame, onState) => {
    f.calls.push(["humanBegin", tabId]); authority();
    const closed = deferred(), record = { tabId, authority, onFrame, onState, closed, closeCalls: 0, inputCalls: 0,
      info: { state: "starting", leaseId: `human-${f.humans.length + 1}`, tabId, generation: 0, viewport: { width: 800, height: 600 }, lastInputSequence: 0 } };
    const handle = record.handle = {
      info: () => ({ ...record.info }), closed: closed.promise,
      input(envelope) {
        authority(); record.inputCalls++; f.calls.push(["humanInput", envelope.sequence]);
        const pending = record.pending = (async () => {
          await f.humanInputGate?.promise;
          authority();
          if (record.info.generation === envelope.generation) record.info.lastInputSequence = envelope.sequence;
          return { leaseId: envelope.leaseId, generation: envelope.generation, sequence: envelope.sequence, acknowledged: true, ...(f.inputReplyOverride ?? {}) };
        })();
        return pending;
      },
      close() {
        if (record.closing) return record.closing;
        record.closeCalls++; record.info.state = "releasing"; closed.resolve({ reason: "released" });
        record.closing = (async () => {
          await Promise.allSettled([record.pending].filter(Boolean));
          await f.humanCloseGate?.promise;
          if (f.humanCleanupError) throw f.humanCleanupError;
          record.info.state = "released"; f.calls.push(["humanReleased", tabId]);
        })();
        return record.closing;
      }
    };
    f.humans.push(record);
    try {
      await f.humanBeginGate?.promise; authority();
      await f.backend.pauseAutomation(); authority();
      record.info.state = "active";
      if (f.earlyHumanFrame) f.humanFrame(1, {}, record);
      return handle;
    } catch (error) {
      try { await handle.close(); }
      catch (cleanupError) { throw Object.assign(cleanupError, { humanCleanupIncomplete: true }); }
      throw error;
    }
  };
  f.humanFrame = (sequence, extra = {}, record = f.humans.at(-1)) => {
    if (!record.info.generation) record.info.generation = 1;
    record.onFrame({ tabId: record.tabId, streamId: `human-stream-${record.info.leaseId}`, sequence,
      mimeType: "image/png", data: Buffer.from(`human frame ${sequence}`).toString("base64"),
      metadata: { deviceWidth: 800, deviceHeight: 600, pageScaleFactor: 1 },
      controlMode: "human", humanLeaseId: record.info.leaseId, generation: record.info.generation, ...extra });
  };
  f.begin = async () => {
    const result = await f.request("humanBegin", { tabId: 7 });
    f.humanFrame(1); await flush();
    return result;
  };
  f.input = (sequence, extra = {}) => f.request("humanInput", {
    leaseId: f.humans.at(-1).info.leaseId, generation: 1, sequence, input: { type: "text", text: "synthetic" }, ...extra
  });
  f.navigate = (generation, record = f.humans.at(-1)) => {
    Object.assign(record.info, { state: "navigating", generation, viewport: null, lastInputSequence: 0 });
    record.onState({ ...record.info });
  };
  f.arrive = (generation, sequence = 1, record = f.humans.at(-1)) => {
    Object.assign(record.info, { state: "active", generation, viewport: { width: 800, height: 600 } });
    record.onState({ ...record.info });
    f.humanFrame(sequence, { streamId: `human-stream-${record.info.leaseId}-g${generation}` }, record);
  };
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

test("human takeover retires observation, publishes actual geometry and returns an original input receipt", async t => {
  const f = humanFixture(t); await f.open(); await f.request("select", { tabId: 7 });
  const starting = await f.begin();
  assert.equal(f.subscriptions[0].closeCalls, 1);
  assert.equal(starting.status.human.generation, 0);
  assert.equal(starting.status.automation.state, "paused");
  const frames = f.events.filter(event => event.type === "frame");
  assert.equal(frames.length, 1); assert.equal(frames[0].controlMode, "human");
  assert.equal(frames[0].humanLeaseId, "human-1");
  assert.ok(f.events.some(event => event.type === "status" && event.status.human?.generation === 1));
  await assert.rejects(f.request("resume", { expectedRevision: f.state.revision, expectedWorkerBootId: "worker" }), /HUMAN_BUSY/);
  await assert.rejects(f.input(1, { generation: 2 }), /HUMAN_STALE/);
  await assert.rejects(f.input(1, { leaseId: "retired-lease" }), /HUMAN_STALE/);
  assert.equal(f.humans[0].inputCalls, 0);
  const applied = await f.input(1);
  assert.deepEqual(applied.inputReceipt, { leaseId: "human-1", generation: 1, sequence: 1, acknowledged: true });
  const ended = await f.request("humanEnd", { leaseId: "human-1" });
  assert.equal(ended.status.human, null);
  assert.deepEqual(ended.status.humanCleanup, { leaseId: "human-1", cleanupConfirmed: true });
  assert.equal(ended.status.automation.state, "paused");
  await assert.rejects(f.input(2), /HUMAN_STALE/);
});

test("a first human frame during Begin is kept until the original handle becomes active", async t => {
  const f = humanFixture(t); f.earlyHumanFrame = true; await f.open();
  const result = await f.request("humanBegin", { tabId: 7 }); await flush();
  assert.equal(result.status.human.generation, 1);
  assert.deepEqual(f.events.filter(event => event.type === "frame").map(event => [event.humanLeaseId, event.generation, event.frameSequence]), [["human-1", 1, 1]]);
  assert.equal(f.humans[0].closeCalls, 0);
});

test("input acknowledgement cannot be fabricated from the requested sequence", async t => {
  const f = humanFixture(t); await f.open(); await f.begin();
  f.inputReplyOverride = { sequence: 0 };
  await assert.rejects(f.input(1), /HUMAN_UNCONFIRMED/);
  assert.equal(f.humans[0].inputCalls, 1);
  assert.equal(f.humans[0].info.lastInputSequence, 1);
  assert.equal(f.humans[0].info.state, "released");
  await assert.rejects(f.input(2), /HUMAN_STALE/);
});

test("navigation keeps one human lease and publishes the new generation before its first frame", async t => {
  const f = humanFixture(t); await f.open(); await f.begin();
  const start = f.events.length;
  f.navigate(2); await flush();
  const navigating = (await f.request("status")).status;
  assert.equal(navigating.human.state, "navigating");
  assert.equal(navigating.human.leaseId, "human-1");
  assert.equal(navigating.human.viewport, null);
  assert.equal(navigating.selectedTabId, 7);
  assert.equal(navigating.humanCleanup, undefined);
  await assert.rejects(f.input(1), /HUMAN_GENERATION_STALE/);
  await assert.rejects(f.input(1, { generation: 2 }), /HUMAN_GENERATION_STALE/);
  assert.equal(f.humans[0].inputCalls, 0);
  f.arrive(2); await flush();
  const events = f.events.slice(start), frameIndex = events.findIndex(event => event.type === "frame");
  assert.ok(frameIndex > 0);
  assert.ok(events.slice(0, frameIndex).some(event => event.type === "status" && event.status.human.generation === 2));
  assert.equal(events.some(event => event.type === "clear"), false);
  assert.equal(events[frameIndex].generation, 2);
  assert.equal(f.humans[0].closeCalls, 0);
  assert.equal(f.calls.filter(call => call[0] === "humanBegin").length, 1);
  assert.deepEqual((await f.input(1, { generation: 2 })).inputReceipt,
    { leaseId: "human-1", generation: 2, sequence: 1, acknowledged: true });
  assert.equal(f.state.state, "paused");
});

test("a navigation-triggering native acknowledgement belongs to the old generation without ending the new one", async t => {
  const f = humanFixture(t); await f.open(); await f.begin();
  f.humanInputGate = deferred();
  const original = f.input(1); await flush();
  f.navigate(2); f.arrive(2); await flush();
  f.humanInputGate.resolve();
  const reply = await original;
  assert.deepEqual(reply.inputReceipt, { leaseId: "human-1", generation: 1, sequence: 1, acknowledged: true });
  assert.equal(reply.status.human.generation, 2);
  assert.equal(reply.status.human.lastInputSequence, 0);
  assert.equal(f.humans[0].closeCalls, 0);
  assert.deepEqual((await f.input(1, { generation: 2 })).inputReceipt,
    { leaseId: "human-1", generation: 2, sequence: 1, acknowledged: true });
});

test("an exact retired frame credit settles once without clearing the new outstanding credit", async t => {
  const f = humanFixture(t); await f.open(); await f.begin();
  const oldFrame = f.events.findLast(event => event.type === "frame");
  f.navigate(2); f.arrive(2); await flush();
  const newFrame = f.events.findLast(event => event.type === "frame");
  assert.notEqual(newFrame.sequence, oldFrame.sequence);
  await f.request("ack", { sequence: oldFrame.sequence });
  await assert.rejects(f.request("ack", { sequence: oldFrame.sequence }), /ACK/);
  f.humanFrame(2, { streamId: newFrame.streamId });
  assert.equal(f.events.findLast(event => event.type === "frame").sequence, newFrame.sequence);
  await f.request("ack", { sequence: newFrame.sequence });
  assert.equal(f.events.findLast(event => event.type === "frame").frameSequence, 2);
});

test("old human state and old encoded frames cannot revoke or repaint a successor generation", async t => {
  const f = humanFixture(t); await f.open(); await f.begin();
  const record = f.humans[0], oldInfo = { ...record.info };
  f.navigate(2); f.arrive(2); await flush();
  const frameCount = f.events.filter(event => event.type === "frame").length;
  record.onState(oldInfo);
  f.humanFrame(99, { generation: 1, streamId: "original-retired-stream" }); await flush();
  assert.equal(f.events.filter(event => event.type === "frame").length, frameCount);
  assert.equal(record.closeCalls, 0);
  assert.equal((await f.request("status")).status.human.generation, 2);
  const ended = await f.request("humanEnd", { leaseId: "human-1" });
  assert.deepEqual(ended.status.humanCleanup, { leaseId: "human-1", cleanupConfirmed: true });
});

test("coalesced navigation waits for actual state publication and keeps only the newest matching frame", async t => {
  const f = humanFixture(t); await f.open(); await f.begin();
  const held = deferred(), entered = deferred(); let block = true;
  f.backend.getAutomationControlStatus = async () => {
    if (block) { block = false; entered.resolve(); await held.promise; }
    return { ...f.state };
  };
  const start = f.events.length;
  f.navigate(2); await entered.promise;
  f.arrive(2); f.navigate(4); f.arrive(4, 1);
  f.humanFrame(2, { streamId: "human-stream-human-1-g4" });
  assert.equal(f.events.slice(start).some(event => event.type === "frame"), false);
  held.resolve(); await flush();
  const events = f.events.slice(start), frames = events.filter(event => event.type === "frame");
  assert.deepEqual(frames.map(frame => [frame.generation, frame.frameSequence]), [[4, 2]]);
  assert.equal(events[0].type, "status");
  assert.equal(events[0].status.human.generation, 4);
  assert.equal(f.humans[0].closeCalls, 0);
});

test("navigation during publication completion publishes its state without waiting for a frame", async t => {
  const f = humanFixture(t); await f.open(); await f.begin();
  const start = f.events.length;
  let once = true;
  f.backend.getAutomationControlStatus = () => {
    if (once) { once = false; queueMicrotask(() => queueMicrotask(() => f.navigate(2))); }
    return Promise.resolve({ ...f.state });
  };
  f.humans[0].onState({ ...f.humans[0].info });
  await flush();
  // Do not issue a status request: the unsolicited navigation publication is
  // what disables the viewer while no successor frame is available yet.
  const automatic = f.events.slice(start).filter(event => event.type === "status");
  assert.equal(automatic.at(-1).status.human.state, "navigating");
  assert.equal(automatic.at(-1).status.human.generation, 2);
  assert.equal(automatic.at(-1).status.human.viewport, null);
  assert.equal(f.humans[0].closeCalls, 0);
  assert.ok(automatic.length <= 3, "A finite state change must not create an unbounded publication loop");
});

test("human navigation clears the old address and publishes current page metadata with the new frame", async t => {
  const f = humanFixture(t); await f.open(); await f.begin();
  const record = f.humans[0];
  record.handle.tabInfo = () => record.info.state === "navigating"
    ? { id: 7, title: "页面正在跳转", url: "" }
    : { id: 7, title: record.info.generation === 1 ? "Page A" : "Page B", url: `https://example.test/${record.info.generation === 1 ? "a" : "b"}` };
  assert.equal((await f.request("status")).status.tabs[0].url, "https://example.test/a");
  f.navigate(2); await flush();
  assert.deepEqual(f.events.findLast(event => event.type === "status").status.tabs, [{ id: 7, title: "页面正在跳转", url: "" }]);
  f.arrive(2); await flush();
  const current = f.events.findLast(event => event.type === "status");
  assert.deepEqual(current.status.tabs, [{ id: 7, title: "Page B", url: "https://example.test/b" }]);
  const frame = f.events.findLast(event => event.type === "frame");
  assert.ok(current.sequence < frame.sequence);
  assert.equal(record.closeCalls, 0);
});

test("End during navigation releases the whole lease and late state cannot reopen it", async t => {
  const f = humanFixture(t); await f.open(); await f.begin();
  f.navigate(2); await flush();
  const end = await f.request("humanEnd", { leaseId: "human-1" });
  assert.equal(end.status.human, null);
  assert.deepEqual(end.status.humanCleanup, { leaseId: "human-1", cleanupConfirmed: true });
  const count = f.events.filter(event => event.type === "frame").length;
  f.arrive(2); await flush();
  assert.equal(f.events.filter(event => event.type === "frame").length, count);
  assert.equal((await f.request("status")).status.human, null);
  assert.equal(f.humans[0].closeCalls, 1);
});

test("human End revokes immediately but waits for the original input and cleanup", async t => {
  const f = humanFixture(t); await f.open(); await f.begin();
  f.humanInputGate = deferred(); f.humanCloseGate = deferred();
  const input = f.input(1), rejected = assert.rejects(input, /HUMAN_STALE/);
  await flush();
  let ended = false;
  const end = f.request("humanEnd", { leaseId: "human-1" }).then(result => { ended = true; return result; });
  await flush();
  await assert.rejects(f.input(2), /HUMAN_STALE/);
  await assert.rejects(f.request("resume", { expectedRevision: f.state.revision, expectedWorkerBootId: "worker" }), /CLEANUP/);
  assert.equal(ended, false); assert.equal(f.humans[0].closeCalls, 1);
  f.humanInputGate.resolve(); await rejected; await flush(); assert.equal(ended, false);
  f.humanCloseGate.resolve();
  assert.deepEqual((await end).status.humanCleanup, { leaseId: "human-1", cleanupConfirmed: true });
  assert.equal(f.humans[0].inputCalls, 1);
});

test("unselect fences Begin while original tab inspection is still pending", async t => {
  const f = humanFixture(t); await f.open();
  const entered = deferred(), held = deferred(); let first = true;
  f.backend.getManagedViewerTabs = async () => { if (first) { first = false; entered.resolve(); await held.promise; } return f.liveTabs; };
  const begin = f.request("humanBegin", { tabId: 7 }), rejected = assert.rejects(begin, /CLOSED/);
  await entered.promise;
  let completed = false;
  const clear = f.request("select", { tabId: null }).then(result => { completed = true; return result; });
  await flush(); assert.equal(completed, false);
  held.resolve(); await rejected;
  assert.equal((await clear).status.human, null);
  assert.equal(f.humans.length, 0);
});

test("unselect does not queue cancellation behind an in-progress human Begin", async t => {
  const f = humanFixture(t); await f.open(); f.humanBeginGate = deferred(); f.humanCloseGate = deferred();
  const begin = f.request("humanBegin", { tabId: 7 }), rejected = assert.rejects(begin, /HUMAN_STALE/);
  await flush(); assert.equal(f.humans.length, 1);
  let cleared = false;
  const clear = f.request("select", { tabId: null }).then(result => { cleared = true; return result; });
  await flush(); assert.equal(cleared, false);
  assert.throws(f.humans[0].authority, /HUMAN_STALE/);
  f.humanBeginGate.resolve(); await flush(); assert.equal(cleared, false);
  f.humanCloseGate.resolve(); await rejected; await clear;
  assert.equal(f.humans[0].info.state, "released");
  assert.equal(f.calls.some(call => call[0] === "pause"), false);
});

test("Pause retires a queued human Begin without starting it after the old subscription settles", async t => {
  const f = humanFixture(t); await f.open(); f.subscribeGate = deferred();
  const select = f.request("select", { tabId: 7 }), selectRejected = assert.rejects(select, /CLOSED/);
  await flush();
  const begin = f.request("humanBegin", { tabId: 7 }), beginRejected = assert.rejects(begin, /CLOSED/);
  const pause = f.request("pause"); await flush(); f.subscribeGate.resolve();
  await Promise.all([selectRejected, beginRejected, pause]);
  assert.equal(f.humans.length, 0); assert.equal(f.state.state, "paused");
  assert.equal(f.subscriptions[0].closeCalls, 1);
});

test("disconnect waits for original human input release and blocks a replacement channel", async t => {
  const f = humanFixture(t); await f.open(); await f.begin(); f.humanInputGate = deferred();
  const input = f.input(1), rejected = assert.rejects(input, /CLOSED/); await flush();
  let done = false; const close = f.request("disconnect").then(result => { done = true; return result; });
  await flush(); assert.equal(done, false);
  await assert.rejects(f.open({ channelKey: "b".repeat(64) }), /CLEANUP/);
  f.humanInputGate.resolve(); await rejected;
  const result = await close;
  assert.equal(f.humans[0].info.state, "released");
  assert.equal(f.calls.filter(call => call[0] === "humanReleased").length, 1);
  assert.equal(result.status.human, null);
  assert.deepEqual(result.status.humanCleanup, { leaseId: "human-1", cleanupConfirmed: true });
  assert.equal(result.status.cleanupPending, 0);
});

test("disconnect reports the newly released human lease and final event sequence, not the previous lease snapshot", async t => {
  const f = humanFixture(t); await f.open(); await f.begin();
  await f.request("humanEnd", { leaseId: "human-1" });
  await f.begin();
  const before = (await f.request("status")).status;
  assert.equal(before.human.leaseId, "human-2");
  assert.deepEqual(before.humanCleanup, { leaseId: "human-1", cleanupConfirmed: true });
  f.humanCloseGate = deferred();
  let done = false;
  const disconnect = f.request("disconnect").then(result => { done = true; return result; });
  await flush(); assert.equal(done, false);
  assert.equal(f.humans[1].info.state, "releasing");
  f.humanCloseGate.resolve();
  const result = await disconnect;
  assert.equal(f.humans[1].info.state, "released");
  assert.equal(result.disconnected, true);
  assert.equal(result.status.connected, false);
  assert.equal(result.status.selectedTabId, null);
  assert.equal(result.status.human, null);
  assert.deepEqual(result.status.humanCleanup, { leaseId: "human-2", cleanupConfirmed: true });
  assert.equal(result.status.cleanupPending, 0);
  assert.equal(Object.hasOwn(result.status, "cleanupError"), false);
  assert.deepEqual(result.status.stream, { state: "idle", streamId: null });
  assert.deepEqual(result.status.tabs, []);
  assert.equal(f.events.at(-1).type, "closed");
  assert.equal(result.status.eventSequence, f.events.at(-1).sequence);
  assert.ok(result.status.eventSequence > before.eventSequence);
});

test("disconnect never confirms a human close rejection or a resolved close without actual released state", async t => {
  for (const mode of ["reject", "unconfirmed"]) {
    const f = humanFixture(t); await f.open(); await f.begin();
    await f.request("humanEnd", { leaseId: "human-1" }); await f.begin();
    if (mode === "reject") f.humanCleanupError = new Error("original native release unconfirmed");
    else f.humans[1].handle.close = async () => { f.humans[1].info.state = "releasing"; };
    await assert.rejects(f.request("disconnect"), /release.*unconfirmed|release was not confirmed/);
    assert.notEqual(f.humans[1].info.state, "released");
    await assert.rejects(f.open({ channelKey: "b".repeat(64) }), /CLEANUP/);
  }
});

test("disconnect joins a pending Begin that returns its original handle after cancellation", async t => {
  const f = humanFixture(t); await f.open(); await f.begin();
  await f.request("humanEnd", { leaseId: "human-1" });
  const originalBegin = f.backend.beginManagedHuman, delivery = deferred();
  f.backend.beginManagedHuman = async (...args) => { const handle = await originalBegin(...args); await delivery.promise; return handle; };
  const begin = f.request("humanBegin", { tabId: 7 }), rejected = assert.rejects(begin, /CLOSED/);
  await flush(); await flush();
  assert.equal(f.humans[1].info.state, "active");
  f.humanCloseGate = deferred();
  let done = false;
  const disconnect = f.request("disconnect").then(result => { done = true; return result; });
  await flush(); assert.equal(done, false);
  assert.throws(f.humans[1].authority, /CLOSED/);
  delivery.resolve(); await rejected; await flush(); assert.equal(done, false);
  f.humanCloseGate.resolve();
  const result = await disconnect;
  assert.equal(f.humans[1].closeCalls, 1);
  assert.equal(f.humans[1].info.state, "released");
  assert.equal(result.status.human, null);
  assert.deepEqual(result.status.humanCleanup, { leaseId: "human-2", cleanupConfirmed: true });
  assert.equal(result.status.cleanupPending, 0);
});

test("disconnect joins rejected Begin cleanup without inventing an undelivered human lease receipt", async t => {
  const f = humanFixture(t); await f.open(); f.humanBeginGate = deferred(); f.humanCloseGate = deferred();
  const begin = f.request("humanBegin", { tabId: 7 }), rejected = assert.rejects(begin, /CLOSED/);
  await flush(); assert.equal(f.humans.length, 1);
  let done = false;
  const disconnect = f.request("disconnect").then(result => { done = true; return result; });
  await flush(); f.humanBeginGate.resolve(); await flush(); assert.equal(done, false);
  assert.equal(f.humans[0].info.state, "releasing");
  f.humanCloseGate.resolve(); await rejected;
  const result = await disconnect;
  assert.equal(f.humans[0].info.state, "released");
  assert.equal(result.status.human, null);
  assert.equal(result.status.cleanupPending, 0);
  assert.equal(Object.hasOwn(result.status, "humanCleanup"), false);
});

test("disconnect preserves a pending Begin cleanup failure instead of returning a disconnected receipt", async t => {
  const f = humanFixture(t); await f.open(); f.humanBeginGate = deferred(); f.humanCloseGate = deferred();
  f.humanCleanupError = new Error("original pending Begin release unconfirmed");
  const begin = f.request("humanBegin", { tabId: 7 });
  const beginRejected = assert.rejects(begin, /pending Begin release unconfirmed/);
  await flush(); assert.equal(f.humans.length, 1);
  const disconnectRejected = assert.rejects(f.request("disconnect"), /pending Begin release unconfirmed|CLEANUP/);
  f.humanBeginGate.resolve(); await flush();
  assert.equal(f.humans[0].info.state, "releasing");
  f.humanCloseGate.resolve(); await Promise.all([beginRejected, disconnectRejected]);
  assert.notEqual(f.humans[0].info.state, "released");
  await assert.rejects(f.open({ channelKey: "b".repeat(64) }), /CLEANUP/);
});

test("disconnect does not substitute a stale automation snapshot when the final status read fails", async t => {
  const f = humanFixture(t); await f.open(); await f.begin();
  f.backend.getAutomationControlStatus = async () => { throw new Error("original automation status unavailable"); };
  await assert.rejects(f.request("disconnect"), /original automation status unavailable/);
  assert.equal(f.humans[0].info.state, "released");
  assert.equal(f.humans[0].closeCalls, 1);
});

test("disconnect refreshes automation after fencing a pending Resume", async t => {
  const f = fixture(t); await f.open(); await f.request("pause");
  const before = (await f.request("status")).status;
  f.resumeGate = deferred();
  const resume = f.request("resume", { expectedRevision: f.state.revision, expectedWorkerBootId: "worker" });
  const rejected = assert.rejects(resume, /CLOSED/); await flush();
  const disconnect = await f.request("disconnect");
  assert.equal(disconnect.status.automation.state, "paused");
  assert.ok(disconnect.status.automation.revision > before.automation.revision);
  assert.deepEqual(disconnect.status.automation, f.state);
  f.resumeGate.resolve(); await rejected;
  assert.deepEqual(disconnect.status.automation, f.state);
});

test("failed human Begin cleanup remains a sticky barrier with no delivered handle", async t => {
  const f = humanFixture(t); await f.open();
  f.backend.beginManagedHuman = async () => { throw Object.assign(new Error("unconfirmed native release"), { humanCleanupIncomplete: true }); };
  await assert.rejects(f.request("humanBegin", { tabId: 7 }), /unconfirmed native release/);
  await assert.rejects(f.request("select", { tabId: 7 }), /unconfirmed native release|CLEANUP/);
  await assert.rejects(f.request("disconnect"), /unconfirmed native release|CLEANUP/);
  await assert.rejects(f.open({ channelKey: "b".repeat(64) }), /CLEANUP/);
});

test("mismatched human frame cannot grant input or replace the original lease", async t => {
  for (const changed of [{ humanLeaseId: "different" }, { generation: 2 }, { controlMode: undefined }]) {
    const f = humanFixture(t); await f.open(); await f.request("humanBegin", { tabId: 7 });
    f.humanFrame(1, changed); await flush();
    assert.equal(f.events.filter(event => event.type === "frame").length, 0);
    assert.equal(f.humans[0].closeCalls, 1);
    assert.equal((await f.request("status")).status.human, null);
  }
});
