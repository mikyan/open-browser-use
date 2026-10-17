import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { projectNativeRecoveryLifecycle, originalNativeLossAuthority, originalNativeLossSource, assertSameWorkerNativeReplacement, assertNativeRecoveryExit, assertPublicPausedViewerCleanup, probeRejectedViewerToken, readRecommendedBrowserVersion, installManagedNativeRecoveryObserver } from "./managed-native-recovery-support.mjs";

const created = "2026-10-17T02:00:00.0000001Z";
const browser = { ProcessId: 11, ParentProcessId: 1, ExecutablePath: "C:\\private\\chrome.exe", CreationDate: created };
const native = { ProcessId: 22, ParentProcessId: 11, ExecutablePath: "C:\\private\\run\\native-host.exe", CreationDate: "2026-10-17T02:00:01.0000001Z" };
const info = { runId: "a".repeat(32), browserPID: 11, nativePID: 22, runDir: "C:\\private\\run", profileDir: "C:\\private\\profile", extensionId: "a".repeat(32), extensionInstanceId: "instance", nativeHostName: "com.openbrowseruse.managed.n" + "a".repeat(32), socketPath: "\\\\.\\pipe\\original" };
const binding = { bound: true, exclusive: true, behavior: "default", extensionId: info.extensionId, extensionInstanceId: "instance", workerBootId: "worker", portId: "port-original", generation: "1".repeat(32) };
const lifecycle = { state: "ready", info, nativeDescriptor: { pid: 22, socketPath: info.socketPath }, binding };
const exact = { nativeCreationTime: "134051400010000001" };

test("acceptance version follows the one frozen production recommendation, without a 155 fallback", () => {
  assert.equal(readRecommendedBrowserVersion('package test\nconst RecommendedVersion = "156.1.2.3"\n'), "156.1.2.3");
  assert.throws(() => readRecommendedBrowserVersion('const OtherVersion = "155.0.8059.84"'));
  assert.throws(() => readRecommendedBrowserVersion('const RecommendedVersion = "1.2.3.4"\nconst RecommendedVersion = "2.3.4.5"'));
});

test("passive metadata observer preserves missing fields, caps events and never sends/ACKs native input", () => {
  const event = () => { const listeners = new Set(); return { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn), emit: (...args) => { for (const fn of listeners) fn(...args); }, listeners }; };
  const onEvent = event(), onDetach = event(), target = {};
  const chrome = { debugger: { onEvent, onDetach, sendCommand: () => { throw new Error("observer must not send native commands"); } } };
  const metadata = { timestamp: 1792231911, deviceWidth: 758, deviceHeight: 426, pageScaleFactor: 1, offsetTop: 0, arbitraryText: "private page text", monotonicTimestamp: NaN };
  const input = structuredClone(metadata);
  installManagedNativeRecoveryObserver(chrome, target);
  onEvent.emit({ targetId: "original", secret: "private source text" }, "Page.screencastFrame", { data: "private image bytes", sessionId: 1, metadata });
  const first = target.__managedHumanAcceptance.snapshot(); assert.equal(first.events.length, 1);
  assert.deepEqual(first.events[0].metadata, { timestamp: 1792231911, deviceWidth: 758, deviceHeight: 426, pageScaleFactor: 1, offsetTop: 0 });
  assert.deepEqual(metadata, input); assert.ok(!JSON.stringify(first).includes("private"));
  assert.equal(Object.hasOwn(first.events[0].metadata, "monotonicTimestamp"), false);
  for (let i = 0; i < 513; i++) onEvent.emit({ tabId: 3 }, "Page.frameResized", {});
  const final = target.__managedHumanAcceptance.stop(); assert.equal(final.events.length, 512); assert.equal(final.overflow, true); assert.equal(final.listenerPresent, false);
  assert.equal(onEvent.listeners.size, 0); assert.equal(onDetach.listeners.size, 0);
});

test("native fault authority preserves exact uint64 and rejects an old PID ancestry or foreign path", () => {
  const raw = Buffer.from('{"nativeCreationTime":134051400010000001,"nativeConnections":[{"creationTime":134051400010000003}]}');
  const projected = projectNativeRecoveryLifecycle(raw);
  assert.equal(projected.exact.nativeCreationTime, exact.nativeCreationTime);
  assert.equal(projected.exact.nativeConnections[0].creationTime, "134051400010000003");
  const args = { info, lifecycle, exact, processes: [browser, native] };
  assert.equal(originalNativeLossAuthority(args).CreationTimeDecimal, exact.nativeCreationTime);
  assert.throws(() => originalNativeLossAuthority({ ...args, processes: [browser, { ...native, CreationDate: "2026-10-17T01:00:00.0000001Z" }] }), /original browser incarnation/);
  assert.throws(() => originalNativeLossAuthority({ ...args, processes: [browser, { ...native, ExecutablePath: "C:\\other\\native-host.exe" }] }));
  assert.throws(() => originalNativeLossAuthority({ ...args, exact: { nativeCreationTime: 134051400010000001 } }));
  assert.throws(() => originalNativeLossAuthority({ ...args, lifecycle: { ...lifecycle, state: "degraded" } }));
  assert.ok(originalNativeLossSource.indexOf("$null = $original.Handle") < originalNativeLossSource.indexOf("$actualTime ="));
  assert.ok(originalNativeLossSource.indexOf("Original native process identity changed; no termination") < originalNativeLossSource.indexOf("$original.Kill()"));
  assert.equal(originalNativeLossSource.match(/\$original\.Kill\(\)/g).length, 1);
  assert.doesNotMatch(originalNativeLossSource, /taskkill|Stop-Process/);
});

test("replacement proves the same worker and browser while permitting PID reuse only with a new creation identity", () => {
  const before = { info, binding, browser, worker: { targetId: "target", contextUniqueId: "context", workerBootId: "worker" }, nativeCreationTime: exact.nativeCreationTime, epoch: 1 };
  const after = { ...structuredClone(before), info: { ...info, socketPath: "\\\\.\\pipe\\replacement" }, binding: { ...binding, portId: "port-replacement", generation: "2".repeat(32) }, nativeCreationTime: "134051400010000003", epoch: 2 };
  assert.doesNotThrow(() => assertSameWorkerNativeReplacement(before, after));
  for (const mutate of [value => { delete value.worker.contextUniqueId; }, value => { value.worker.targetId = "new-worker"; }, value => { value.epoch = 3; }, value => { value.binding.portId = binding.portId; }, value => { value.binding.generation = binding.generation; }, value => { value.nativeCreationTime = before.nativeCreationTime; }, value => { value.browser.CreationDate = native.CreationDate; }]) {
    const invalid = structuredClone(after); mutate(invalid); assert.throws(() => assertSameWorkerNativeReplacement(before, invalid));
  }
});

test("fault exit preserves the original nonzero error and cannot hide unknown wait failures", () => {
  const receipt = { at: "2026-10-17T02:00:01Z", code: 4294967295, error: "managed process exited with code 4294967295" };
  assert.equal(assertNativeRecoveryExit(receipt, -1, { fault: true }), receipt);
  assert.throws(() => assertNativeRecoveryExit({ ...receipt, error: undefined }, -1, { fault: true }));
  assert.throws(() => assertNativeRecoveryExit({ ...receipt, error: receipt.error + "\nunknown native wait failure" }, -1, { fault: true }));
  assert.throws(() => assertNativeRecoveryExit(receipt, 1, { fault: true }));
  assert.throws(() => assertNativeRecoveryExit({ ...receipt, code: 0, error: undefined }, 0, { fault: true }));
  assert.doesNotThrow(() => assertNativeRecoveryExit({ at: receipt.at, code: 0 }, 0));
});

test("actual public Human End receipt proves cleanup without leaking the private counter", () => {
  // Exact result from original 4J5sp6 WS response 13, connection 1; synthetic
  // localhost fixture only. Retained results.json SHA256:
  // 0e5e86ef54331d77e490b01adf0b70c89d82451e52f7c02fd9003d37dddb793a.
  const receipt = {
    eventSequence: 21, human: null,
    humanCleanup: { leaseId: "20cf3499-1479-499a-a03b-1e0fd65df74a", cleanupConfirmed: true },
    retiredSequence: 21, selectedTabId: null,
    status: { state: "paused", inputBlocked: true, revision: 1, cleanupComplete: true },
    tabs: [{ id: 419880927, title: "Original delivered recovery result", url: "http://127.0.0.1:50926/managed-recovery-form", kind: "result", watchable: true, takeover: true, deliveryId: "f0bd0d32-be7f-41e1-8297-e7b96a3652b2" }],
    view: null, viewerCleanupComplete: true, workerBootId: "fff99af0-93c7-4e06-8ff4-f3dbe2756312"
  };
  const options = { leaseId: receipt.humanCleanup.leaseId };
  assert.equal(Object.hasOwn(receipt, "cleanupPending"), false);
  assert.equal(assertPublicPausedViewerCleanup(receipt, options), receipt);
  const recovered = structuredClone(receipt); delete recovered.humanCleanup;
  assert.doesNotThrow(() => assertPublicPausedViewerCleanup(recovered));
  for (const mutate of [
    value => { delete value.viewerCleanupComplete; value.cleanupPending = 0; },
    value => { value.viewerCleanupComplete = false; },
    value => { value.status.state = "running"; },
    value => { value.status.inputBlocked = false; },
    value => { value.status.cleanupComplete = false; },
    value => { value.human = { leaseId: options.leaseId }; },
    value => { value.view = { leaseId: "still-viewing" }; },
    value => { value.selectedTabId = 419880927; },
    value => { delete value.humanCleanup; },
    value => { value.humanCleanup.leaseId = "another-original-lease"; },
    value => { value.humanCleanup.cleanupConfirmed = false; }
  ]) {
    const invalid = structuredClone(receipt); mutate(invalid);
    assert.throws(() => assertPublicPausedViewerCleanup(invalid, options));
  }
});

async function localSocket(t, connected) {
  const server = createServer(), sockets = new WebSocketServer({ server });
  sockets.on("connection", socket => { socket.on("error", () => {}); socket.on("message", data => connected(socket, JSON.parse(data))); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { for (const client of sockets.clients) client.terminate(); await new Promise(resolve => sockets.close(resolve)); await new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}

test("old token proof requires actual rejection, never a timeout or successful authentication", async t => {
  const token = "x".repeat(43);
  const refused = await localSocket(t, (socket, message) => { assert.deepEqual(message, { type: "authenticate", token }); socket.close(1008, "retired"); });
  const proof = await probeRejectedViewerToken(refused, token, 1000); assert.equal(proof.closeCode, 1008); assert.equal(proof.authenticated, false); assert.ok(!JSON.stringify(proof).includes(token));
  const accepted = await localSocket(t, socket => socket.send('{"type":"authenticated"}'));
  await assert.rejects(probeRejectedViewerToken(accepted, token, 1000), /gained new authority/);
  const silent = await localSocket(t, () => {});
  await assert.rejects(probeRejectedViewerToken(silent, token, 100), /did not actually settle/);
});
