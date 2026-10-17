// Executes the production bridge with a simulated backend. This fixture proves
// protocol/cleanup ordering only, not native input or browser acceptance.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { installManagedUserBridge } from "../../../apps/chrome-extension/managed-user-bridge.js";

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

export async function captureHumanDisconnectFixture() {
  const identity = { runId: "0123456789abcdef0123456789abcdef", extensionId: "a".repeat(32), extensionInstanceId: "disconnect-instance", workerBootId: "disconnect-worker", portId: "disconnect-port" };
  const channelKey = "d".repeat(64), events = [], handles = [], closeOrder = [];
  const secondCloseEntered = deferred(), secondCloseRelease = deferred();
  const target = { __obuNativeDownloadBinding: Object.freeze({ nonce: "disconnect-nonce", ...identity }), __obuManagedViewerEvent: raw => events.push(JSON.parse(raw)) };
  let automation = { state: "running", inputBlocked: false, revision: 0, cleanupComplete: false };
  const backend = {
    async getAutomationControlStatus() { return { ...automation }; },
    async getManagedViewerTabs() { return automation.state === "running" ? [{ id: 7, title: "Synthetic disconnect page", url: "https://fixture.invalid/" }] : []; },
    async managedViewerSubscribe() { throw Error("Observation is outside this fixture"); },
    async pauseAutomation() { automation = { state: "paused", inputBlocked: true, revision: automation.revision + 1, cleanupComplete: true }; return { ...automation }; },
    async resumeAutomation(revision, authority) {
      authority(); assert.equal(revision, automation.revision);
      automation = { state: "running", inputBlocked: false, revision: automation.revision + 1, cleanupComplete: false };
      return { ...automation };
    },
    async beginManagedHuman(tabId, authority) {
      authority(); await this.pauseAutomation(); authority();
      const ended = deferred(), index = handles.length;
      const info = { state: "active", leaseId: `disconnect-human-${index + 1}`, tabId, generation: 0, viewport: null, lastInputSequence: 0 };
      const record = { info, closeCalls: 0 };
      handles.push(record);
      return {
        info: () => ({ ...info }), closed: ended.promise,
        async input() { throw Error("Native input is outside this fixture"); },
        async close() {
          record.closeCalls++; info.state = "releasing";
          if (index === 1) { secondCloseEntered.resolve(); await secondCloseRelease.promise; }
          info.state = "released"; closeOrder.push(info.leaseId); ended.resolve({ reason: "synthetic release confirmed" });
        }
      };
    }
  };
  const bridge = installManagedUserBridge({ config: { version: 1, nativeHostName: `com.openbrowseruse.managed.n${identity.runId}` }, backend, target,
    getInstanceId: async () => identity.extensionInstanceId, newChannelId: () => "disconnect-channel", now: () => 1000, wallNow: () => 1700000000000,
    setTimer: () => 1, clearTimer() {} });
  const request = (operation, more = {}) => bridge.request({ channelKey, operation, ...more });
  await bridge.open({ version: 1, ...identity, channelKey });
  const firstBegin = await request("humanBegin", { tabId: 7 });
  const firstEnd = await request("humanEnd", { leaseId: firstBegin.status.human.leaseId });
  await request("resume", { expectedRevision: firstEnd.status.automation.revision, expectedWorkerBootId: identity.workerBootId });
  const secondBegin = await request("humanBegin", { tabId: 7 });
  assert.equal(secondBegin.status.humanCleanup.leaseId, firstBegin.status.human.leaseId);

  let settled = false;
  const closing = request("disconnect").then(value => { settled = true; return value; });
  await secondCloseEntered.promise;
  assert.equal(settled, false);
  assert.equal(handles[1].info.state, "releasing");
  await assert.rejects(bridge.open({ version: 1, ...identity, channelKey: "e".repeat(64) }), /CLEANUP/);
  secondCloseRelease.resolve();
  const disconnect = await closing;
  assert.equal(disconnect.disconnected, true);
  assert.equal(disconnect.status.human, null);
  assert.deepEqual(disconnect.status.humanCleanup, { leaseId: secondBegin.status.human.leaseId, cleanupConfirmed: true });
  assert.equal(disconnect.status.cleanupPending, 0);
  assert.equal(Object.hasOwn(disconnect.status, "cleanupError"), false);
  assert.equal(disconnect.status.eventSequence, events.at(-1).sequence);
  assert.deepEqual(handles.map(record => record.closeCalls), [1, 1]);

  return { version: 1, scope: "Production bridge with simulated backend; no native input or browser acceptance", firstBegin, firstEnd, secondBegin, disconnect,
    evidence: { disconnectWaitedForOriginalRelease: true, closeCalls: handles.map(record => record.closeCalls), closeOrder }, events };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const fixtureURL = new URL("./human-disconnect-fixture.json", import.meta.url);
  const actual = await captureHumanDisconnectFixture();
  if (process.argv.includes("--check")) assert.deepEqual(actual, JSON.parse(await readFile(fixtureURL, "utf8")));
  else await writeFile(fixtureURL, JSON.stringify(actual, null, 2) + "\n");
}
