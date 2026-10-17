// Protocol fixture only: executes the real bridge with a simulated backend.
// It does not establish browser, native PNG, or user-control acceptance.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { installManagedUserBridge } from "../../../apps/chrome-extension/managed-user-bridge.js";

export async function captureFixture() {
  const identity = { runId: "0123456789abcdef0123456789abcdef", extensionId: "a".repeat(32), extensionInstanceId: "fixture-instance", workerBootId: "fixture-worker", portId: "fixture-port" };
  const channelKey = "b".repeat(64), events = [];
  const target = { __obuNativeDownloadBinding: Object.freeze({ nonce: "fixture-nonce", ...identity }), __obuManagedViewerEvent: value => events.push(JSON.parse(value)) };
  let frame, humanFrame, humanInfo, state = { state: "running", inputBlocked: false, revision: 0, cleanupComplete: false };
  const backend = {
    async getAutomationControlStatus() { return { ...state }; },
    async getManagedViewerTabs() { return state.state === "running" ? [{ id: 7, title: "Fixture tab", url: "https://fixture.invalid/" }] : []; },
    async managedViewerSubscribe(id, callback) { frame = callback; return { async close() {} }; },
    async pauseAutomation() { state = { state: "paused", inputBlocked: true, revision: state.revision + 1, cleanupComplete: true }; return state; },
    async resumeAutomation(revision, assertAuthority) { assertAuthority(); if (revision !== state.revision) throw Error("revision conflict"); state = { state: "running", inputBlocked: false, revision: state.revision + 1, cleanupComplete: false }; return state; },
    async beginManagedHuman(tabId, assertAuthority, callback) {
      assertAuthority(); await this.pauseAutomation(); assertAuthority();
      humanInfo = { state: "active", leaseId: "fixture-human-lease", tabId, generation: 0, viewport: null, lastInputSequence: 0 };
      humanFrame = callback;
      let release;
      const closed = new Promise(resolve => { release = resolve; });
      return { info: () => ({ ...humanInfo }), closed,
        async input(envelope) { assertAuthority(); if (envelope.leaseId !== humanInfo.leaseId || envelope.generation !== humanInfo.generation || envelope.sequence !== humanInfo.lastInputSequence + 1) throw Error("fixture input identity mismatch"); humanInfo.lastInputSequence = envelope.sequence; return { leaseId: envelope.leaseId, generation: envelope.generation, sequence: envelope.sequence, acknowledged: true }; },
        async close() { humanInfo.state = "released"; release({ reason: "fixture release" }); }
      };
    }
  };
  const bridge = installManagedUserBridge({ config: { version: 1, nativeHostName: `com.openbrowseruse.managed.n${identity.runId}` }, backend, target, getInstanceId: async () => identity.extensionInstanceId, newChannelId: () => "fixture-channel", now: () => 1000, wallNow: () => 1700000000000, setTimer: () => 1, clearTimer: () => {} });
  const request = (operation, more = {}) => bridge.request({ channelKey, operation, ...more });
  const open = await bridge.open({ version: 1, ...identity, channelKey });
  const select = await request("select", { tabId: 7 });
  frame({ tabId: 7, streamId: "fixture-stream", sequence: 1, mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7FQAAAAASUVORK5CYII=", metadata: { deviceWidth: 1, deviceHeight: 1, pageScaleFactor: 1, timestamp: 1 } });
  const status = await request("status");
  const pause = await request("pause");
  const resume = await request("resume", { expectedRevision: pause.status.automation.revision, expectedWorkerBootId: identity.workerBootId });
  const humanBegin = await request("humanBegin", { tabId: 7 });
  humanInfo.generation = 1;
  humanInfo.viewport = { width: 1, height: 1 };
  humanFrame({ tabId: 7, streamId: "fixture-human-stream", sequence: 1, mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7FQAAAAASUVORK5CYII=", metadata: { deviceWidth: 1, deviceHeight: 1, pageScaleFactor: 1, timestamp: 2 }, controlMode: "human", humanLeaseId: humanInfo.leaseId, generation: 1 });
  const humanStatus = await request("status");
  const humanInput = await request("humanInput", { leaseId: humanInfo.leaseId, generation: 1, sequence: 1, input: { type: "text", text: "fixture synthetic" } });
  const humanEnd = await request("humanEnd", { leaseId: humanInfo.leaseId });
  const humanResume = await request("resume", { expectedRevision: humanEnd.status.automation.revision, expectedWorkerBootId: identity.workerBootId });
  const disconnect = await request("disconnect");
  return { scope: "Actual bridge protocol output using simulated backend; no browser/native frame acceptance", open, select, status, pause, resume, humanBegin, humanStatus, humanInput, humanEnd, humanResume, disconnect, events };
}

export async function captureResultFixture() {
  // The original delivery and native lease lifecycle below are simulated. All
  // public bridge replies, event ordering and cleanup receipts are produced by
  // installManagedUserBridge, never hand-written protocol golden values.
  const identity = { runId: "0123456789abcdef0123456789abcdef", extensionId: "a".repeat(32), extensionInstanceId: "result-instance", workerBootId: "result-worker", portId: "result-port" };
  const channelKey = "c".repeat(64), events = [], backendCalls = [];
  const deliveryId = "fixture-delivery-original", tabId = 7;
  const pages = {
    a: { documentId: "simulated-document-A", title: "Delivered A", url: "https://fixture.invalid/result-a" },
    aRoute: { documentId: "simulated-document-A", title: "Delivered A route", url: "https://fixture.invalid/result-a#view" },
    b: { documentId: "simulated-document-B", title: "Continued B", url: "https://fixture.invalid/result-b" }
  };
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7FQAAAAASUVORK5CYII=";
  const target = { __obuNativeDownloadBinding: Object.freeze({ nonce: "result-nonce", ...identity }), __obuManagedViewerEvent: value => events.push(JSON.parse(value)) };
  let automation = { state: "running", inputBlocked: false, revision: 0, cleanupComplete: false };
  let page = pages.a, active = null, leases = 0;
  const metadata = () => ({ id: tabId, title: page.title, url: page.url });
  const flush = () => new Promise(resolve => setImmediate(resolve));
  function emitFrame(record) {
    record.authority();
    record.onFrame({ tabId, streamId: `${record.info.leaseId}-g${record.info.generation}`, sequence: 1, mimeType: "image/png", data: png,
      metadata: { deviceWidth: 1, deviceHeight: 1, pageScaleFactor: 1, offsetTop: 0, monotonicTimestamp: 100 + record.info.generation },
      generation: record.info.generation, ...(record.mode === "view" ? { controlMode: "user-view", viewLeaseId: record.info.leaseId } : { controlMode: "human", humanLeaseId: record.info.leaseId }) });
  }
  async function createLease(mode, selectedTabId, authority, onFrame, onState, options) {
    assert.equal(selectedTabId, tabId); assert.deepEqual(options, { deliveryId }); assert.equal(active, null, "original simulated cleanup must finish before a new lease");
    authority();
    if (mode === "human") await backend.pauseAutomation();
    authority();
    const record = { mode, authority, onFrame, onState,
      info: { state: "active", leaseId: `result-${mode}-${++leases}`, tabId, generation: 1, viewport: { width: 1, height: 1 }, lastInputSequence: 0 } };
    active = record;
    backendCalls.push({ operation: `${mode}Begin`, deliveryId, documentId: page.documentId, leaseId: record.info.leaseId });
    let resolveClosed;
    const closed = new Promise(resolve => { resolveClosed = resolve; });
    const handle = {
      info: () => ({ ...record.info }), tabInfo: metadata, closed,
      async close() {
        if (record.info.state === "released") return;
        record.info.state = "releasing"; resolveClosed({ reason: "simulated original release" });
        await Promise.resolve();
        assert.equal(active, record); active = null; record.info.state = "released";
        backendCalls.push({ operation: `${mode}Released`, leaseId: record.info.leaseId });
      }
    };
    if (mode === "human") handle.input = async envelope => {
      authority(); assert.equal(active, record); assert.equal(record.info.state, "active");
      assert.equal(envelope.leaseId, record.info.leaseId); assert.equal(envelope.generation, record.info.generation); assert.equal(envelope.sequence, record.info.lastInputSequence + 1);
      record.info.lastInputSequence = envelope.sequence;
      backendCalls.push({ operation: "simulatedInputAcknowledged", leaseId: envelope.leaseId, generation: envelope.generation, sequence: envelope.sequence });
      return Object.freeze({ leaseId: envelope.leaseId, generation: envelope.generation, sequence: envelope.sequence, acknowledged: true });
    };
    // Match the producer's startup ordering: a verified first frame arrives
    // before begin resolves. The bridge must announce its state before copying
    // that early frame to the manager; the frame cannot authorize itself.
    onState({ ...record.info }); emitFrame(record);
    return Object.freeze(handle);
  }
  const backend = {
    async getAutomationControlStatus() { return { ...automation }; },
    async getManagedViewerTabs() { return [{ ...metadata(), kind: "result", deliveryId, watchable: true, takeover: true }]; },
    managedViewerSubscribe(id, onFrame, onState, options, authority) { return createLease("view", id, authority, onFrame, onState, options); },
    beginManagedHuman(id, authority, onFrame, onState, options) { return createLease("human", id, authority, onFrame, onState, options); },
    async pauseAutomation() {
      automation = { state: "paused", inputBlocked: true, revision: automation.revision + 1, cleanupComplete: true };
      backendCalls.push({ operation: "pause", revision: automation.revision }); return { ...automation };
    },
    async resumeAutomation() { throw new Error("this result scenario must never authorize the Agent"); }
  };
  const bridge = installManagedUserBridge({ config: { version: 1, nativeHostName: `com.openbrowseruse.managed.n${identity.runId}` }, backend, target,
    getInstanceId: async () => identity.extensionInstanceId, newChannelId: () => "result-channel", now: () => 1000, wallNow: () => 1700000000000, setTimer: () => 1, clearTimer: () => {} });
  const request = async (operation, more = {}) => { const reply = await bridge.request({ channelKey, operation, ...more }); await flush(); return reply; };
  const select = () => request("select", { tabId, deliveryId });
  async function navigate(next) {
    const record = active; assert.ok(record);
    Object.assign(record.info, { state: "navigating", generation: record.info.generation + 1, viewport: null, lastInputSequence: 0 });
    record.onState({ ...record.info }); await flush();
    const navigating = await request("status");
    page = next;
    Object.assign(record.info, { state: "active", viewport: { width: 1, height: 1 } });
    record.onState({ ...record.info }); emitFrame(record); await flush();
    return { navigating, active: await request("status") };
  }
  const open = await bridge.open({ version: 1, ...identity, channelKey });
  const viewRunning = await select(), viewRunningStatus = await request("status");
  const viewNavigation = await navigate(pages.aRoute);
  const pause = await request("pause");
  assert.equal(active, null);
  const viewPaused = await select(), viewPausedStatus = await request("status");
  const humanBegin = await request("humanBegin", { tabId, deliveryId });
  const humanLease = active.info.leaseId;
  const humanInput = await request("humanInput", { leaseId: humanLease, generation: 1, sequence: 1, input: { type: "text", text: "simulated result edit" } });
  const humanNavigation = await navigate(pages.b);
  const humanEnd = await request("humanEnd", { leaseId: humanLease });
  const viewAfterHuman = await select(), viewAfterHumanStatus = await request("status");
  const secondHumanBegin = await request("humanBegin", { tabId, deliveryId });
  const secondLease = active.info.leaseId;
  assert.notEqual(secondLease, humanLease);
  const secondHumanEnd = await request("humanEnd", { leaseId: secondLease });
  const disconnect = await request("disconnect");
  assert.equal(active, null); assert.equal(page.documentId, pages.b.documentId);
  for (const event of events.filter(event => event.type === "frame")) {
    const mode = event.controlMode === "human" ? "human" : "view", lease = event.humanLeaseId ?? event.viewLeaseId;
    assert.ok(events.some(prior => prior.type === "status" && prior.sequence < event.sequence && prior.status[mode]?.state === "active" &&
      prior.status[mode].leaseId === lease && prior.status[mode].generation === event.generation && prior.status.stream.streamId === event.streamId), "the real bridge must announce every lease generation before publishing its frame");
  }
  assert.ok(!backendCalls.some(call => call.operation === "resume"));
  return { scope: "Actual bridge result/view/human protocol output using simulated original delivery and backend; no browser, native input, PNG, finalize, or persistence acceptance",
    delivery: { tabId, deliveryId, originalDocumentId: pages.a.documentId, finalDocumentId: page.documentId },
    open, viewRunning, viewRunningStatus, viewNavigation, pause, viewPaused, viewPausedStatus, humanBegin, humanInput, humanNavigation, humanEnd,
    viewAfterHuman, viewAfterHumanStatus, secondHumanBegin, secondHumanEnd, disconnect, events, backendCalls };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.ok(process.argv.slice(2).every(arg => arg === "--check"), "unknown fixture-generator argument");
  for (const [file, capture] of [["bridge-fixture.json", captureFixture], ["result-bridge-fixture.json", captureResultFixture]]) {
    const bytes = JSON.stringify(await capture(), null, 2) + "\n", url = new URL(`./${file}`, import.meta.url);
    if (process.argv.includes("--check")) assert.equal(await readFile(url, "utf8"), bytes, `${file} must match its original bridge output`);
    else await writeFile(url, bytes);
  }
}
