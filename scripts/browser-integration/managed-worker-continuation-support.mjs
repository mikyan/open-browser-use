import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import WebSocket from "ws";

export function workerRecoveryMode(argv) {
  assert.ok(argv.length <= 1 && (!argv.length || ["--held-input", "--continuation"].includes(argv[0])), "Use explicit environment inputs and at most one of --held-input or --continuation");
  return argv[0] === "--held-input" ? "held-input" : argv[0] === "--continuation" ? "continuation" : "result";
}

// Diagnostic reads may differ in viewport metadata; none of the original page's
// application state or text may change during a rejected authority probe.
export function assertRejectedContinuationUnchanged(before, after) {
  for (const key of ["documentId", "frameId", "draft", "note", "receiptText", "continuationReceiptText", "confirmDisabled"])
    assert.deepEqual(after[key], before[key], `Rejected authority changed ${key}`);
  assert.deepEqual(after.state, before.state, "Rejected authority changed original application state or input events");
  return { documentId: after.documentId, documentToken: after.state.documentToken, events: after.state.events.length, unchanged: true };
}

// A separate authenticated connection avoids injecting IDs into the production
// viewer's counter. It only sends one retired-lease request and status reads;
// caller must join its cleanup with formal managed view before opening the UI.
export async function probeEndedWorkerHumanLease(url, { tabId, deliveryId, lease, lastSequence, timeoutMs = 10000 }) {
  const parsed = new URL(url), token = parsed.hash.slice(8);
  assert.equal(parsed.protocol, "http:"); assert.equal(parsed.hostname, "127.0.0.1"); assert.match(parsed.hash, /^#ticket=[A-Za-z0-9_-]{43}$/);
  assert.ok(Number.isSafeInteger(tabId) && tabId > 0 && typeof deliveryId === "string" && deliveryId);
  assert.ok(typeof lease.leaseId === "string" && lease.leaseId && Number.isSafeInteger(lease.generation) && lease.generation > 0);
  assert.ok(Number.isSafeInteger(lastSequence) && lastSequence > 0);
  const report = { origin: parsed.origin, tokenSHA256: createHash("sha256").update(token).digest("hex"), commands: [], messages: [], startedAt: Date.now() };
  const socket = new WebSocket(`ws://${parsed.host}/ws`, { origin: parsed.origin, handshakeTimeout: timeoutMs });
  const pending = new Map(); let id = 0, authenticatedResolve, authenticatedReject, closedResolve, failure, closing = false;
  const authenticated = new Promise((resolve, reject) => { authenticatedResolve = resolve; authenticatedReject = reject; });
  const closed = new Promise(resolve => { closedResolve = resolve; });
  const fail = error => { failure ??= error; authenticatedReject(error); for (const entry of pending.values()) entry.reject(error); pending.clear(); };
  const timeout = setTimeout(() => { fail(new Error("Retired human lease probe deadline expired")); socket.terminate(); }, timeoutMs);
  socket.on("open", () => socket.send(JSON.stringify({ type: "authenticate", token })));
  socket.on("error", fail);
  socket.on("close", (code, reason) => {
    report.closedAt = Date.now(); report.closeCode = code; report.closeReason = String(reason);
    if (!closing || pending.size) fail(new Error("Retired human lease probe closed before original replies"));
    closedResolve();
  });
  socket.on("message", bytes => {
    try {
      assert.ok(bytes.length <= 65536 && report.messages.length < 128);
      const message = JSON.parse(bytes.toString()); report.messages.push({ ...message, observedAt: Date.now() });
      assert.notEqual(message.type, "frame", "Retired human lease cannot publish frames");
      if (message.type === "authenticated") authenticatedResolve();
      if (message.type === "response") { const entry = pending.get(message.id); assert.ok(entry, "Reply must match original probe request"); pending.delete(message.id); entry.resolve(message); }
    } catch (error) { fail(error); socket.terminate(); }
  });
  const call = operation => new Promise((resolve, reject) => {
    if (failure) return reject(failure);
    if (socket.readyState !== WebSocket.OPEN) return reject(new Error("Retired human lease probe is not open"));
    const request = { id: ++id, ...operation }; report.commands.push({ ...request, sentAt: Date.now() }); pending.set(id, { resolve, reject }); socket.send(JSON.stringify(request));
  });
  const clean = response => {
    assert.equal(response.error, undefined); const state = response.result;
    assert.equal(state.status.state, "paused"); assert.equal(state.status.inputBlocked, true); assert.equal(state.status.cleanupComplete, true); assert.equal(state.viewerCleanupComplete, true);
    assert.equal(state.human, null); assert.equal(state.view, null); assert.equal(state.selectedTabId, null);
    const result = state.tabs.find(tab => tab.id === tabId); assert.equal(result?.kind, "result"); assert.equal(result.deliveryId, deliveryId);
    return state;
  };
  try {
    await authenticated; report.before = clean(await call({ operation: "status" }));
    report.response = await call({ operation: "humanInput", leaseId: lease.leaseId, generation: lease.generation, sequence: lastSequence + 1, input: { type: "text", text: "MUST_NOT_BE_DELIVERED" } });
    assert.equal(report.response.result, undefined); assert.equal(report.response.error?.code, "HUMAN_STALE", "Ended original lease must return exact stale-capability rejection");
    report.after = clean(await call({ operation: "status" })); report.completedAt = Date.now();
    return report;
  } catch (error) { error.workerHumanLeaseProbe = report; throw error; }
  finally {
    closing = true;
    if (socket.readyState !== WebSocket.CLOSED) socket.close(1000, "original ended-human probe complete");
    const forceClose = setTimeout(() => socket.terminate(), 2000); let closeDeadline;
    try { await Promise.race([closed, new Promise((_resolve, reject) => { closeDeadline = setTimeout(() => reject(new Error("Retired human lease original socket termination unconfirmed")), 5000); })]); }
    catch (error) { failure ??= error; }
    finally { clearTimeout(forceClose); clearTimeout(closeDeadline); clearTimeout(timeout); }
    if (failure) { failure.workerHumanLeaseProbe = report; throw failure; }
  }
}
