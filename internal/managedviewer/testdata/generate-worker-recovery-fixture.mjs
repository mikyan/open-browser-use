// Actual production-bridge protocol output. Browser execution, journal storage
// and native cleanup are explicitly simulated, not acceptance evidence.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { installManagedUserBridge } from "../../../apps/chrome-extension/managed-user-bridge.js";

export async function captureWorkerRecoveryFixture() {
  const oldIdentity = { runId: "0123456789abcdef0123456789abcdef", extensionId: "a".repeat(32),
    extensionInstanceId: "worker-recovery-instance", workerBootId: "worker-original", portId: "port-original" };
  const newIdentity = { ...oldIdentity, workerBootId: "worker-replacement", portId: "port-replacement" };
  const state = { version: 1, browserIncarnation: "browser-original", journalId: "journal-original", workerEpoch: 1 };
  const recovery = { kind: "worker-replacement", previousWorkerBootId: oldIdentity.workerBootId,
    browserIncarnation: state.browserIncarnation, expectedJournalId: state.journalId,
    expectedWorkerEpoch: state.workerEpoch, nonce: "manager-recovery-nonce" };
  const oldKey = "u".repeat(64), newKey = "w".repeat(64), tabId = 7, oldLeaseId = "view-original";
  const oldEvents = [], newEvents = [], calls = [];
  function install(identity, events, replacement) {
    const target = { __obuNativeDownloadBinding: Object.freeze({ nonce: replacement ? "native-new" : "native-original", ...identity }),
      __obuManagedViewerEvent: value => events.push(JSON.parse(value)) };
    const metadata = { id: tabId, title: "Original delivered result", url: "https://fixture.invalid/result" };
    const backend = {
      onManagedNativeLoss() {}, async waitManagedNativeRecovery() {},
      async prepareManagedUserOpen(request, authority) {
        authority(); assert.equal(request.workerBootId, identity.workerBootId);
        assert.deepEqual(request.recovery, replacement ? recovery : undefined);
        calls.push({ operation: "simulatedAdmission", workerBootId: request.workerBootId });
        return { epoch: null, workerBootId: identity.workerBootId,
          recoveryState: { ...state, workerEpoch: replacement ? 2 : 1 },
          ...(replacement ? { workerRecovery: {
            kind: recovery.kind, nonce: recovery.nonce, previousWorkerBootId: oldIdentity.workerBootId,
            workerBootId: newIdentity.workerBootId, browserIncarnation: state.browserIncarnation, journalId: state.journalId,
            fromWorkerEpoch: 1, toWorkerEpoch: 2, inputRiskClear: true, paused: true,
            retiredViews: [{ leaseId: oldLeaseId, targetId: "target-original", outcome: "stopped-and-detached", stopAcknowledged: true, detachAcknowledged: true }]
          } } : {}) };
      },
      commitManagedUserOpen(admission) {
        assert.equal(admission.workerBootId, identity.workerBootId);
        calls.push({ operation: "simulatedAdmissionCommitted", workerBootId: identity.workerBootId });
      },
      async getAutomationControlStatus() { return { state: "paused", inputBlocked: true, revision: replacement ? 2 : 1, cleanupComplete: true }; },
      async getManagedViewerTabs() { return [{ ...metadata, kind: "result", deliveryId: replacement ? "delivery-replacement" : "delivery-original", watchable: true, takeover: true }]; },
      async managedViewerSubscribe(id, _frame, _state, options, authority) {
        authority(); assert.equal(replacement, false); assert.equal(id, tabId);
        assert.deepEqual(options, { deliveryId: "delivery-original" });
        return { info: () => ({ state: "active", leaseId: oldLeaseId, tabId, generation: 0, viewport: null, lastInputSequence: 0 }),
          tabInfo: () => metadata, closed: new Promise(() => {}),
          async close() { throw new Error("This fixture does not simulate running JavaScript cleanup in a terminated worker"); } };
      },
      async pauseAutomation() { throw new Error("Recovery must already be paused"); },
      async resumeAutomation() { throw new Error("Recovery must not resume the Agent"); },
      async beginManagedHuman() { throw new Error("Native human control is outside this protocol fixture"); }
    };
    return installManagedUserBridge({ config: { version: 1, nativeHostName: `com.openbrowseruse.managed.n${identity.runId}` }, backend, target,
      getInstanceId: async () => identity.extensionInstanceId, newChannelId: () => replacement ? "channel-replacement" : "channel-original",
      now: () => 1000, wallNow: () => 1700000000000, setTimer: () => 1, clearTimer() {} });
  }
  const oldBridge = install(oldIdentity, oldEvents, false);
  const oldOpen = await oldBridge.open({ version: 1, ...oldIdentity, channelKey: oldKey });
  const oldSelect = await oldBridge.request({ channelKey: oldKey, operation: "select", tabId, deliveryId: "delivery-original" });
  assert.equal(oldSelect.status.view.leaseId, oldLeaseId);
  // Two independent JS targets model a manager handoff. No browser worker is
  // stopped here; that fact and all native ACKs need separate real acceptance.
  const newBridge = install(newIdentity, newEvents, true);
  const recoveredOpen = await newBridge.open({ version: 1, ...newIdentity, channelKey: newKey, recovery });
  const status = await newBridge.request({ channelKey: newKey, operation: "status" });
  await assert.rejects(newBridge.request({ channelKey: oldKey, operation: "status" }));
  const disconnect = await newBridge.request({ channelKey: newKey, operation: "disconnect" });
  assert.equal(recoveredOpen.status.automation.state, "paused");
  assert.notEqual(recoveredOpen.status.tabs[0].deliveryId, oldOpen.status.tabs[0].deliveryId);
  return { version: 1, scope: "Production bridge output with simulated worker handoff, journal and native cleanup; no browser, IndexedDB durability or native ACK acceptance",
    oldOpen, oldSelect, recovery, recoveredOpen, status, disconnect, oldEvents, newEvents, calls };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.ok(process.argv.slice(2).every(arg => arg === "--check"));
  const fixture = new URL("./worker-recovery-fixture.json", import.meta.url);
  const bytes = JSON.stringify(await captureWorkerRecoveryFixture(), null, 2) + "\n";
  if (process.argv.includes("--check")) assert.equal(await readFile(fixture, "utf8"), bytes);
  else await writeFile(fixture, bytes);
}
