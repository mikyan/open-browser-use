import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import WebSocket from "ws";
import { managedWorkerScriptURL } from "./managed-worker-target.mjs";

const fields = ["versionId", "registrationId", "scriptURL", "runningStatus", "status", "targetId", "scriptLastModified", "scriptResponseTime"];
export function workerVersionEvents(events, { scriptURL, versionId } = {}) {
  return events.flatMap(event => event.method === "ServiceWorker.workerVersionUpdated" ?
    (event.params?.versions ?? []).filter(version => version.scriptURL === scriptURL && (versionId === undefined || version.versionId === versionId))
      .map(version => ({ at: event.receivedAt, ...Object.fromEntries(fields.filter(key => Object.hasOwn(version, key)).map(key => [key, version[key]])) })) : []);
}

export function exactRunningWorkerVersion(events, { scriptURL, targetId }) {
  const latest = new Map();
  for (const version of workerVersionEvents(events, { scriptURL })) latest.set(version.versionId, version);
  const candidates = [...latest.values()].filter(version => version.runningStatus === "running" && version.targetId === targetId);
  if (!candidates.length) return null;
  assert.equal(candidates.length, 1, "Original extension worker version must be unique");
  const version = candidates[0];
  assert.ok(typeof version.versionId === "string" && version.versionId.length > 0);
  assert.ok(typeof version.registrationId === "string" && version.registrationId.length > 0);
  return version;
}

// Repeated notifications of one phase are normal (including a starting event
// followed by the same phase with a targetId). A second stop/start cycle is not.
export function workerReplacementProgress(events, { scriptURL, versionId, registrationId }) {
  let stopped = null, startup = null, running = null, phase = "stopping", targetId;
  for (const version of workerVersionEvents(events, { scriptURL })) {
    assert.equal(version.versionId, versionId, "Another worker version appeared during the original replacement");
    assert.equal(version.registrationId, registrationId, "Original worker registration changed");
    if (!stopped) {
      assert.ok(["stopping", "stopped"].includes(version.runningStatus), "Replacement started before the original stopped event");
      if (version.runningStatus === "stopped") { stopped = version; phase = "stopped"; }
      continue;
    }
    if (version.runningStatus === "stopped") {
      assert.equal(startup, null, "Replacement stopped again before its original execution was verified");
      continue;
    }
    assert.ok(["starting", "running"].includes(version.runningStatus), "Unexpected second worker stop or unknown replacement phase");
    assert.ok(phase !== "running" || version.runningStatus === "running", "Replacement began another start after running");
    if (version.targetId !== undefined) {
      assert.ok(typeof version.targetId === "string" && version.targetId.length > 0);
      if (targetId !== undefined) assert.equal(version.targetId, targetId, "Replacement target changed during one start");
      targetId = version.targetId;
    }
    startup ??= version; phase = version.runningStatus;
    if (phase === "running") {
      assert.ok(typeof version.targetId === "string" && version.targetId.length > 0, "Running replacement has no original target");
      running = version;
    }
  }
  return { stopped, startup, running, phase };
}

// This operates only the independent diagnostic page's ServiceWorker domain.
// It never reloads the extension, terminates a process or touches a page target.
// One actual Stop is followed by an automatic restart or at most one explicit
// Start. Old execution/native termination must be confirmed before returning;
// only the explicit Start invocation is ordered after those witnesses.
export async function replaceOriginalWorker({ service, worker, scriptURL, targetId, until, originalTerminated, detail, timeoutMs = 40000 }) {
  assert.equal(typeof scriptURL, "string");
  const parsed = new URL(scriptURL), entry = /^\/managed-worker-([0-9a-f]{32})\.js$/.exec(parsed.pathname);
  assert.ok(entry, "Expected the exact managed worker entry");
  assert.equal(scriptURL, managedWorkerScriptURL({ extensionId: parsed.hostname, runId: entry[1] }));
  const scopeURL = new URL(".", scriptURL).href;
  assert.ok(typeof targetId === "string" && targetId.length > 0);
  const deadline = performance.now() + timeoutMs;
  const remaining = () => { const value = Math.floor(deadline - performance.now()); assert.ok(value > 0, "Original worker replacement deadline expired"); return value; };
  detail.scriptURL = scriptURL; detail.oldTargetId = targetId;
  await service.call("ServiceWorker.enable", {}, remaining());
  detail.version = await until(() => exactRunningWorkerVersion(service.events, { scriptURL, targetId }), "exact original running worker version", remaining());
  await worker.close(); detail.harnessWorkerObserverClosedAt = Date.now();
  const offset = service.events.length;
  detail.stopRequestedAt = Date.now(); detail.stopInvocations = 1;
  try {
    detail.stopReply = await service.call("ServiceWorker.stopWorker", { versionId: detail.version.versionId }, remaining());
    detail.stopAcknowledgedAt = Date.now();
    const progress = () => workerReplacementProgress(service.events.slice(offset), { scriptURL, versionId: detail.version.versionId, registrationId: detail.version.registrationId });
    detail.stopped = await until(() => progress().stopped, "actual original worker stopped event", remaining());
    assert.ok(detail.stopped.at >= detail.stopRequestedAt);
    detail.originalTermination = await originalTerminated(remaining());
    detail.terminationConfirmedAt = Date.now();
    const beforeStart = progress();
    detail.startInvocations = 0;
    if (beforeStart.startup) {
      detail.startMode = "browser-automatic"; detail.automaticStartup = beforeStart.startup;
    } else {
      assert.equal(beforeStart.phase, "stopped");
      detail.startMode = "explicit"; detail.startRequestedAt = Date.now(); detail.startInvocations = 1;
      detail.startReply = await service.call("ServiceWorker.startWorker", { scopeURL }, remaining());
      detail.startAcknowledgedAt = Date.now();
    }
    detail.running = await until(() => progress().running, "actual replacement worker running event", remaining());
    if (detail.startMode === "explicit") assert.ok(detail.running.at >= detail.startRequestedAt);
    assert.ok(typeof detail.running.targetId === "string" && detail.running.targetId.length > 0);
    detail.targetReused = detail.running.targetId === targetId;
    detail.completedAt = Date.now();
    return detail.running;
  } finally { detail.events = workerVersionEvents(service.events.slice(offset), { scriptURL, versionId: detail.version.versionId }); }
}

export function assertWorkerExecutionEnded(end, original) {
  assert.ok(Number.isFinite(Date.parse(end?.at)), "Original execution end needs a recorded time");
  assert.ok(["Runtime.executionContextDestroyed", "Runtime.executionContextsCleared", "Target.targetDestroyed"].includes(end.method), "Transport detach or generic crash alone cannot prove worker execution ended");
  for (const key of ["targetId", "contextId", "contextUniqueId", "workerBootId"]) assert.equal(end[key], original[key], `Execution end changed original ${key}`);
  assert.ok(typeof end.sessionId === "string" && end.sessionId.length > 0, "Execution end must identify the original production flat session");
  return end;
}

export function assertWorkerReplacement(before, after) {
  for (const value of [before, after]) {
    assert.ok(value?.info && value.binding && value.browser && value.worker);
    for (const key of ["targetId", "contextUniqueId", "workerBootId"]) assert.ok(typeof value.worker[key] === "string" && value.worker[key].length);
    assert.equal(value.worker.workerBootId, value.binding.workerBootId);
    assert.match(value.nativeCreationTime, /^[1-9][0-9]{0,19}$/);
    assert.match(value.binding.generation, /^[0-9a-f]{32}$/);
    assert.equal(value.binding.bound, true); assert.equal(value.binding.exclusive, true); assert.equal(value.binding.behavior, "default");
  }
  for (const key of ["runId", "browserPID", "profileDir", "extensionId", "extensionInstanceId", "nativeHostName"]) assert.equal(after.info[key], before.info[key], `Worker replacement changed ${key}`);
  assert.deepEqual(after.browser, before.browser, "Original browser incarnation changed");
  for (const key of ["contextUniqueId", "workerBootId"]) assert.notEqual(after.worker[key], before.worker[key], `Worker execution was not replaced: ${key}`);
  for (const key of ["portId", "generation"]) assert.notEqual(after.binding[key], before.binding[key], `Old Native identity reused: ${key}`);
  assert.notEqual(after.info.socketPath, before.info.socketPath);
  assert.notDeepEqual({ pid: after.info.nativePID, created: after.nativeCreationTime }, { pid: before.info.nativePID, created: before.nativeCreationTime });
  assert.equal(after.epoch, before.epoch + 1);
}

export function assertWorkerRecoveryReceipt(receipt, { before, after, recoveryState, originalView }) {
  assert.equal(receipt?.kind, "worker-replacement");
  assert.ok(typeof receipt.nonce === "string" && receipt.nonce.length >= 16 && receipt.nonce.length <= 128);
  assert.equal(receipt.previousWorkerBootId, before.worker.workerBootId);
  assert.equal(receipt.workerBootId, after.worker.workerBootId);
  assert.equal(recoveryState.version, 1);
  assert.equal(receipt.browserIncarnation, recoveryState.browserIncarnation);
  assert.equal(receipt.journalId, recoveryState.journalId);
  assert.equal(receipt.fromWorkerEpoch, recoveryState.workerEpoch);
  assert.equal(receipt.toWorkerEpoch, recoveryState.workerEpoch + 1);
  assert.equal(receipt.inputRiskClear, true); assert.equal(receipt.paused, true);
  assert.ok(Array.isArray(receipt.retiredViews));
  assert.equal(receipt.retiredViews.length, 1, "Exactly the originally active view must be retired");
  assert.deepEqual(receipt.retiredViews[0], { leaseId: originalView.leaseId, targetId: originalView.targetId, outcome: "stopped-and-detached", stopAcknowledged: true, detachAcknowledged: true });
  return receipt;
}

export function assertSameResultPlacement(before, after) {
  for (const key of ["id", "windowId", "groupId", "pinned"]) assert.equal(after[key], before[key], `Original result placement changed ${key}`);
  return after;
}

export function assertHeldInputUnreleased(before, after) {
  assert.equal(after.documentId, before.documentId);
  assert.equal(after.state.documentToken, before.state.documentToken);
  assert.equal(before.state.overflow, false); assert.equal(after.state.overflow, false);
  assert.deepEqual(after.state.heldKeys, ["ShiftLeft"]);
  assert.deepEqual(after.state.heldButtons, [0]);
  assert.equal(after.state.pointerCaptured, true);
  assert.deepEqual(after.state.events, before.state.events, "Worker replacement must not replay held key or pointer events");
  assert.ok(!after.state.events.some(event => event.type === "keyup" || event.type === "mouseup" || event.type === "pointerup" || event.type === "lostpointercapture"), "Worker replacement must not manufacture release or close the original document");
  return after;
}

// Consume a fresh ticket on a separate real WebSocket, so rejected test requests
// cannot jump or rewrite the production UI's monotonically increasing IDs.
// The caller must obtain another ticket through formal managed view afterwards.
export async function probeRetiredDelivery(url, { tabId, oldDeliveryId, newDeliveryId, timeoutMs = 10000 }) {
  const parsed = new URL(url), token = parsed.hash.slice(8);
  assert.equal(parsed.protocol, "http:"); assert.equal(parsed.hostname, "127.0.0.1"); assert.match(parsed.hash, /^#ticket=[A-Za-z0-9_-]{43}$/);
  assert.ok(Number.isSafeInteger(tabId) && tabId > 0); assert.notEqual(oldDeliveryId, newDeliveryId);
  const report = { origin: parsed.origin, tokenSHA256: createHash("sha256").update(token).digest("hex"), commands: [], messages: [], startedAt: Date.now() };
  const socket = new WebSocket(`ws://${parsed.host}/ws`, { origin: parsed.origin, handshakeTimeout: timeoutMs });
  const pending = new Map(); let id = 0, authenticatedResolve, authenticatedReject, closedResolve, failure, closing = false;
  const authenticated = new Promise((resolve, reject) => { authenticatedResolve = resolve; authenticatedReject = reject; });
  const closed = new Promise(resolve => { closedResolve = resolve; });
  // A frame or malformed event can arrive after the last status reply resolved.
  // Retain that failure through actual socket close, even with no pending call.
  const fail = error => { failure ??= error; authenticatedReject(error); for (const item of pending.values()) item.reject(error); pending.clear(); };
  const timeout = setTimeout(() => { fail(new Error("Retired delivery probe original deadline expired")); socket.terminate(); }, timeoutMs);
  socket.on("open", () => socket.send(JSON.stringify({ type: "authenticate", token })));
  socket.on("error", fail);
  socket.on("close", (code, reason) => {
    report.closedAt = Date.now(); report.closeCode = code; report.closeReason = String(reason);
    if (!closing || pending.size) fail(new Error("Retired delivery probe socket closed before all original replies"));
    closedResolve();
  });
  socket.on("message", bytes => {
    try {
      assert.ok(bytes.length <= 65536 && report.messages.length < 128);
      const message = JSON.parse(bytes.toString()); report.messages.push({ ...message, observedAt: Date.now() });
      assert.notEqual(message.type, "frame", "Rejected old delivery must not publish a new frame");
      if (message.type === "authenticated") authenticatedResolve();
      if (message.type === "response") { const entry = pending.get(message.id); assert.ok(entry, "Reply must match an original probe request"); pending.delete(message.id); entry.resolve(message); }
    } catch (error) { fail(error); socket.terminate(); }
  });
  const call = operation => new Promise((resolve, reject) => {
    if (failure) return reject(failure);
    if (socket.readyState !== WebSocket.OPEN) return reject(new Error("Retired delivery probe is not open"));
    const request = { id: ++id, ...operation }; report.commands.push({ ...request, sentAt: Date.now() }); pending.set(id, { resolve, reject }); socket.send(JSON.stringify(request));
  });
  const clean = response => {
    assert.equal(response.error, undefined); const state = response.result;
    assert.equal(state.status.state, "paused"); assert.equal(state.status.inputBlocked, true); assert.equal(state.status.cleanupComplete, true); assert.equal(state.viewerCleanupComplete, true);
    assert.equal(state.human, null); assert.equal(state.view, null); assert.equal(state.selectedTabId, null);
    const result = state.tabs.find(tab => tab.id === tabId); assert.equal(result?.kind, "result"); assert.equal(result.deliveryId, newDeliveryId); assert.notEqual(result.deliveryId, oldDeliveryId);
    return state;
  };
  try {
    await authenticated; report.before = clean(await call({ operation: "status" }));
    for (const operation of ["select", "humanBegin"]) {
      const response = await call({ operation, tabId, deliveryId: oldDeliveryId });
      assert.equal(response.result, undefined); assert.ok(["OPERATION_UNCONFIRMED", "HUMAN_STALE", "HUMAN_UNAVAILABLE"].includes(response.error?.code), "Old delivery must return an actual public rejection");
      report.after = clean(await call({ operation: "status" }));
    }
    report.completedAt = Date.now(); return report;
  } catch (error) { error.workerDeliveryProbe = report; throw error; }
  finally {
    closing = true;
    if (socket.readyState !== WebSocket.CLOSED) socket.close(1000, "original retired-delivery probe complete");
    const forceClose = setTimeout(() => socket.terminate(), 2000);
    let closeDeadline;
    try { await Promise.race([closed, new Promise((_resolve, reject) => { closeDeadline = setTimeout(() => reject(new Error("Retired delivery original socket termination unconfirmed")), 5000); })]); }
    catch (error) { failure ??= error; }
    finally { clearTimeout(forceClose); clearTimeout(closeDeadline); clearTimeout(timeout); }
    if (failure) { failure.workerDeliveryProbe = report; throw failure; }
  }
}
