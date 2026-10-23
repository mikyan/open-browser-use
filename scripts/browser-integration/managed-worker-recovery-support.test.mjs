import assert from "node:assert/strict";
import test from "node:test";
import { managedWorkerScriptURL } from "./managed-worker-target.mjs";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { exactRunningWorkerVersion, workerReplacementProgress, replaceOriginalWorker, assertWorkerExecutionEnded, assertWorkerReplacement, assertWorkerRecoveryReceipt, assertSameResultPlacement, assertHeldInputUnreleased, probeRetiredDelivery } from "./managed-worker-recovery-support.mjs";
import { createManagedWorkerHeldFixture, assertZeroBusinessHeldFixture } from "./managed-worker-recovery-fixture.mjs";

const scriptURL = managedWorkerScriptURL({ extensionId: "a".repeat(32), runId: "b".repeat(32) });
const version = { versionId: "12", registrationId: "4", scriptURL, targetId: "same-target", runningStatus: "running", status: "activated" };
const event = value => ({ method: "ServiceWorker.workerVersionUpdated", receivedAt: Date.now(), params: { versions: [value] } });
const browser = { ProcessId: 17, ExecutablePath: "C:\\owned\\chrome.exe", CreationDate: "2026-10-17T12:00:00.0000001Z" };
const before = { epoch: 1, browser, info: { runId: "a".repeat(32), browserPID: 17, nativePID: 23, profileDir: "C:\\owned\\profile", extensionId: "a".repeat(32), extensionInstanceId: "instance", nativeHostName: "com.openbrowseruse.managed.n" + "a".repeat(32), socketPath: "old-pipe" },
  binding: { bound: true, exclusive: true, behavior: "default", workerBootId: "old-boot", portId: "old-port", generation: "a".repeat(32) },
  nativeCreationTime: "134051400010000001", worker: { targetId: "same-target", contextId: 1, contextUniqueId: "old-context", workerBootId: "old-boot" } };
const replacement = () => ({ ...structuredClone(before), epoch: 2, info: { ...before.info, socketPath: "new-pipe" }, nativeCreationTime: "134051400010000003", binding: { ...before.binding, workerBootId: "new-boot", portId: "new-port", generation: "b".repeat(32) }, worker: { ...before.worker, contextUniqueId: "new-context", workerBootId: "new-boot" } });

test("worker identity is latest exact script and target; stopped and ambiguous candidates cannot become running", () => {
  assert.equal(exactRunningWorkerVersion([event(version)], { scriptURL, targetId: version.targetId }).versionId, "12");
  assert.equal(exactRunningWorkerVersion([event(version), event({ ...version, runningStatus: "stopped" })], { scriptURL, targetId: version.targetId }), null);
  assert.equal(exactRunningWorkerVersion([event({ ...version, scriptURL: scriptURL + "?foreign" })], { scriptURL, targetId: version.targetId }), null);
  assert.throws(() => exactRunningWorkerVersion([event(version), event({ ...version, versionId: "13" })], { scriptURL, targetId: version.targetId }), /unique/);
});

function controlledReplacement({ stopped = true, witnessError = false, automatic } = {}) {
  const calls = [], events = [event(version)]; let closed = false;
  const service = { events, async call(method, params) {
    calls.push({ method, params });
    if (method === "ServiceWorker.stopWorker") { assert.equal(closed, true); if (stopped) events.push(event({ ...version, runningStatus: "stopped" })); }
    if (method === "ServiceWorker.startWorker") events.push(event(version));
    return {};
  } };
  return { calls, service, worker: { async close() { closed = true; } }, until: async (read, label) => {
    if (automatic === "starting" && label === "actual replacement worker running event") events.push(event(version));
    const value = await read(); assert.ok(value, label); return value;
  }, originalTerminated: async () => {
    calls.push({ method: "original-production-witness" });
    if (automatic) events.push(event({ ...version, runningStatus: automatic === "running" ? "running" : "starting" }));
    if (witnessError) throw Error("original native/context exit unknown"); return { confirmed: true };
  } };
}

test("single stop/start requires actual stopped plus original termination and permits reused target", async () => {
  const control = controlledReplacement(), detail = {};
  const result = await replaceOriginalWorker({ ...control, scriptURL, targetId: version.targetId, detail });
  assert.equal(result.targetId, version.targetId); assert.equal(detail.targetReused, true);
  assert.deepEqual(control.calls.map(x => x.method), ["ServiceWorker.enable", "ServiceWorker.stopWorker", "original-production-witness", "ServiceWorker.startWorker"]);
  assert.deepEqual(control.calls[1].params, { versionId: "12" }); assert.deepEqual(control.calls.at(-1).params, { scopeURL: "chrome-extension://" + "a".repeat(32) + "/" });
  assert.equal(detail.stopInvocations, 1); assert.equal(detail.startInvocations, 1);
  assert.equal(detail.startMode, "explicit"); assert.ok(detail.startRequestedAt >= detail.terminationConfirmedAt);
});

test("invalid managed worker URL is rejected before any browser operation", async () => {
  for (const invalid of [undefined, null, scriptURL.replace("chrome-extension:", "https:"), scriptURL.replace(/managed-worker-[a-f0-9]+\.js$/, "background.js"), scriptURL + "?query", scriptURL + "#fragment", scriptURL + "\n", scriptURL.replace("//", "//user@"), scriptURL.replace("/managed-worker-", ":80/managed-worker-"), scriptURL.replace("/managed-worker-", "/%6danaged-worker-"), scriptURL.replace("b".repeat(32), "g".repeat(32)), scriptURL.replace("a".repeat(32), "q".repeat(32))]) {
    const calls = [];
    await assert.rejects(replaceOriginalWorker({ scriptURL: invalid, targetId: "target", detail: {}, service: { call() { calls.push("service"); } }, worker: { close() { calls.push("close"); } } }));
    assert.deepEqual(calls, []);
  }
});

test("automatic starting or running after actual stopped suppresses explicit Start but still requires running", async () => {
  for (const automatic of ["starting", "running"]) {
    const control = controlledReplacement({ automatic }), detail = {};
    assert.equal((await replaceOriginalWorker({ ...control, scriptURL, targetId: version.targetId, detail })).runningStatus, "running");
    assert.equal(detail.stopInvocations, 1); assert.equal(detail.startInvocations, 0); assert.equal(detail.startMode, "browser-automatic");
    assert.equal(detail.startRequestedAt, undefined); assert.equal(detail.startReply, undefined); assert.equal(detail.startAcknowledgedAt, undefined);
    assert.ok(detail.automaticStartup.at >= detail.stopped.at); assert.ok(detail.terminationConfirmedAt);
    assert.equal(control.calls.filter(x => x.method === "ServiceWorker.startWorker").length, 0);
  }
});

test("stop ACK, unknown original exit or a starting-only event cannot authorize success or retry", async () => {
  for (const options of [{ stopped: false }, { witnessError: true }, { automatic: "running", witnessError: true }, { automatic: "starting-only" }]) {
    const control = controlledReplacement(options), detail = {};
    await assert.rejects(replaceOriginalWorker({ ...control, scriptURL, targetId: version.targetId, detail }));
    assert.equal(control.calls.filter(x => x.method === "ServiceWorker.stopWorker").length, 1);
    assert.equal(control.calls.filter(x => x.method === "ServiceWorker.startWorker").length, 0);
  }
});

test("one replacement accepts repeated phase details but rejects another stop/start or ambiguous identity", () => {
  const options = { scriptURL, versionId: version.versionId, registrationId: version.registrationId };
  const sequence = phases => phases.map(phase => event({ ...version, runningStatus: phase }));
  const valid = sequence(["stopping", "stopped", "starting", "starting", "running", "running"]);
  delete valid[2].params.versions[0].targetId;
  const result = workerReplacementProgress(valid, options); assert.equal(result.running.targetId, version.targetId); assert.equal(result.phase, "running");
  for (const phases of [["running"], ["stopped", "starting", "stopped"], ["stopped", "starting", "stopping"], ["stopped", "running", "starting"], ["stopped", "unknown"]])
    assert.throws(() => workerReplacementProgress(sequence(phases), options));
  for (const changed of [{ versionId: "13" }, { registrationId: "5" }, { targetId: "different-second-target" }, { targetId: "" }]) {
    const values = sequence(["stopped", "starting", "running"]); Object.assign(values.at(-1).params.versions[0], changed);
    assert.throws(() => workerReplacementProgress(values, options));
  }
});

test("new execution and native identity required even when target and PID are legitimately reused", () => {
  assert.doesNotThrow(() => assertWorkerReplacement(before, replacement()));
  for (const mutate of [x => { x.worker.contextUniqueId = before.worker.contextUniqueId; }, x => { x.worker.workerBootId = before.worker.workerBootId; }, x => { x.nativeCreationTime = before.nativeCreationTime; }, x => { x.binding.portId = before.binding.portId; }, x => { x.epoch = 3; }, x => { x.browser.CreationDate += "new"; }]) {
    const after = replacement(); mutate(after); assert.throws(() => assertWorkerReplacement(before, after));
  }
  const changed = replacement(); changed.worker.targetId = "new-target"; assert.doesNotThrow(() => assertWorkerReplacement(before, changed));
});

test("execution witness excludes detach, wrong execution and missing original session", () => {
  const end = { ...before.worker, at: "2026-10-17T12:00:01Z", method: "Runtime.executionContextDestroyed", sessionId: "original-flat-session" };
  assert.equal(assertWorkerExecutionEnded(end, before.worker), end);
  for (const change of [{ method: "Target.detachedFromTarget" }, { contextUniqueId: "other-context" }, { workerBootId: "new-boot" }, { sessionId: "" }]) assert.throws(() => assertWorkerExecutionEnded({ ...end, ...change }, before.worker));
});

test("recovery receipt must retire exact original view with stop and detach, not empty replacement state", () => {
  const recoveryState = { version: 1, browserIncarnation: "browser-original", journalId: "journal-original", workerEpoch: 4 }, originalView = { leaseId: "original-view", targetId: "original-page" }, after = replacement();
  const receipt = { kind: "worker-replacement", nonce: "n".repeat(32), previousWorkerBootId: before.worker.workerBootId, workerBootId: after.worker.workerBootId,
    browserIncarnation: recoveryState.browserIncarnation, journalId: recoveryState.journalId, fromWorkerEpoch: 4, toWorkerEpoch: 5, inputRiskClear: true, paused: true,
    retiredViews: [{ ...originalView, outcome: "stopped-and-detached", stopAcknowledged: true, detachAcknowledged: true }] };
  const args = { before, after, recoveryState, originalView }; assert.equal(assertWorkerRecoveryReceipt(receipt, args), receipt);
  for (const mutate of [x => { x.retiredViews = []; }, x => { x.retiredViews[0].targetId = "other-page"; }, x => { x.retiredViews[0].stopAcknowledged = false; }, x => { x.inputRiskClear = false; }, x => { x.fromWorkerEpoch = 3; }, x => { x.previousWorkerBootId = "other-worker"; }]) {
    const value = structuredClone(receipt); mutate(value); assert.throws(() => assertWorkerRecoveryReceipt(value, args));
  }
});

test("original result placement and held input evidence cannot silently change", () => {
  const placement = { id: 8, windowId: 2, groupId: 5, pinned: false }; assert.equal(assertSameResultPlacement(placement, { ...placement }).id, 8);
  for (const change of [{ windowId: 3 }, { groupId: 6 }, { pinned: true }]) assert.throws(() => assertSameResultPlacement(placement, { ...placement, ...change }));
  const document = { documentId: "original-doc", state: { documentToken: "token", overflow: false, heldKeys: ["ShiftLeft"], heldButtons: [0], pointerCaptured: true, events: [{ type: "keydown", trusted: true }, { type: "mousedown", trusted: true }] } };
  assert.equal(assertHeldInputUnreleased(document, structuredClone(document)).documentId, document.documentId);
  for (const mutate of [x => { x.documentId = "new-doc"; }, x => { x.state.heldKeys = []; }, x => { x.state.pointerCaptured = false; }, x => { x.state.overflow = true; }, x => { x.state.events.push({ type: "keyup", trusted: true }); }, x => { x.state.events.push({ type: "keydown", trusted: true }); }, x => { x.state.events.push({ type: "mousedown", trusted: true }); }]) { const changed = structuredClone(document); mutate(changed); assert.throws(() => assertHeldInputUnreleased(document, changed)); }
});

async function deliveryProbeServer(t, finalMessage) {
  const server = createServer(), websocket = new WebSocketServer({ server }), requests = [];
  websocket.on("connection", socket => {
    let statusCount = 0;
    socket.on("message", bytes => {
      const request = JSON.parse(bytes); requests.push(request);
      if (request.type === "authenticate") return socket.send(JSON.stringify({ type: "authenticated" }));
      const result = request.operation === "status" ? {
        status: { state: "paused", inputBlocked: true, cleanupComplete: true }, viewerCleanupComplete: true,
        human: null, view: null, selectedTabId: null, tabs: [{ id: 8, kind: "result", deliveryId: "new-delivery" }]
      } : undefined;
      socket.send(JSON.stringify({ type: "response", id: request.id, ...(result ? { result } : { error: { code: "HUMAN_STALE" } }) }));
      if (request.operation === "status" && ++statusCount === 3 && finalMessage) socket.send(JSON.stringify(finalMessage));
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { for (const socket of websocket.clients) socket.terminate(); await new Promise(resolve => websocket.close(resolve)); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { url: `http://127.0.0.1:${server.address().port}/#ticket=${"t".repeat(43)}`, requests };
}

test("old delivery probe waits for actual close after both public rejections", async t => {
  const server = await deliveryProbeServer(t);
  const result = await probeRetiredDelivery(server.url, { tabId: 8, oldDeliveryId: "old-delivery", newDeliveryId: "new-delivery" });
  assert.equal(result.closeCode, 1000); assert.ok(result.closedAt >= result.completedAt);
  assert.deepEqual(server.requests.slice(1).map(request => request.operation), ["status", "select", "status", "humanBegin", "status"]);
});

test("old delivery probe rejects a frame or unmatched reply after the final status response", async t => {
  for (const finalMessage of [{ type: "frame", data: "unwanted" }, { type: "response", id: 999, result: {} }]) {
    const server = await deliveryProbeServer(t, finalMessage);
    await assert.rejects(probeRetiredDelivery(server.url, { tabId: 8, oldDeliveryId: "old-delivery", newDeliveryId: "new-delivery" }), error => {
      assert.match(error.message, /must not publish a new frame|must match an original probe request/);
      assert.ok(error.workerDeliveryProbe.closedAt); return true;
    });
  }
});

test("zero-business fixture serves one original document with bounded bytes and refuses reopen or POST", async t => {
  const fixture = createManagedWorkerHeldFixture(), server = createServer((req, res) => { if (!fixture.handle(req, res)) { req.resume(); res.writeHead(404); res.end(); } });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}${fixture.paths.form}`;
  assert.equal((await fetch(url)).status, 200); assertZeroBusinessHeldFixture(fixture.stats());
  assert.equal((await fetch(url)).status, 409); assert.equal((await fetch(url, { method: "POST", body: "no business" })).status, 409);
  assert.equal(fixture.stats().requests.filter(x => x.method === "POST" && x.status === 200).length, 0);
});
