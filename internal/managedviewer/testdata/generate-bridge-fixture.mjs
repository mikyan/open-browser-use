// Protocol fixture only: executes the real bridge with a simulated backend.
// It does not establish browser, native PNG, or user-control acceptance.
import { writeFile } from "node:fs/promises";
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await writeFile(new URL("./bridge-fixture.json", import.meta.url), JSON.stringify(await captureFixture(), null, 2) + "\n");
}
