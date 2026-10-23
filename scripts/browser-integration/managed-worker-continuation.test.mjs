import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { WebSocketServer } from "ws";
import { workerRecoveryMode, assertRejectedContinuationUnchanged, probeEndedWorkerHumanLease } from "./managed-worker-continuation-support.mjs";

test("continuation is explicit and mutually exclusive with original held-input mode", () => {
  assert.equal(workerRecoveryMode([]), "result");
  assert.equal(workerRecoveryMode(["--held-input"]), "held-input");
  assert.equal(workerRecoveryMode(["--continuation"]), "continuation");
  for (const flags of [["--unknown"], ["continuation"], ["--held-input", "--continuation"], ["--continuation", "--continuation"]]) assert.throws(() => workerRecoveryMode(flags));
});

const original = () => ({ documentId: "doc-one", frameId: 0, draft: "original", note: "human note", receiptText: "original receipt", continuationReceiptText: "Not yet", confirmDisabled: false,
  state: { documentToken: "token-one", receipt: { id: "first" }, events: [{ type: "input", trusted: true }], continuation: { submits: 0, receipt: null }, heldKeys: [], heldButtons: [] } });

test("denial proof tolerates viewport observations but rejects any original application/input mutation", () => {
  const before = original(), after = { ...structuredClone(before), viewport: { width: 1000 } };
  assert.equal(assertRejectedContinuationUnchanged(before, after).unchanged, true);
  for (const mutate of [value => { value.documentId = "other"; }, value => { value.state.documentToken = "other"; }, value => { value.note += "MUST_NOT_BE_DELIVERED"; },
    value => { value.state.events.push({ type: "keydown", trusted: true }); }, value => { value.state.continuation.submits++; }, value => { value.state.heldKeys.push("A"); }]) {
    const changed = structuredClone(before); mutate(changed); assert.throws(() => assertRejectedContinuationUnchanged(before, changed));
  }
});

const cleanStatus = () => ({ status: { state: "paused", inputBlocked: true, cleanupComplete: true }, viewerCleanupComplete: true, human: null, view: null, selectedTabId: null,
  tabs: [{ id: 7, kind: "result", deliveryId: "recovered-delivery" }] });
const options = () => ({ tabId: 7, deliveryId: "recovered-delivery", lease: { leaseId: "ended-lease", generation: 2 }, lastSequence: 13, timeoutMs: 1000 });

async function serverCase(t, onCommand, settings = {}) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 }); await once(server, "listening");
  const commands = [], authentication = [], sockets = [];
  server.on("connection", (socket, request) => {
    sockets.push(socket); assert.equal(request.headers.origin, `http://127.0.0.1:${server.address().port}`);
    socket.on("message", bytes => {
      const value = JSON.parse(bytes.toString());
      if (value.type === "authenticate") { authentication.push(value); if (!settings.noAuthentication) socket.send(JSON.stringify({ type: "authenticated" })); return; }
      commands.push(value); onCommand(socket, value, commands);
    });
  });
  t.after(async () => { for (const socket of sockets) socket.terminate(); await new Promise(resolve => server.close(resolve)); });
  return { url: `http://127.0.0.1:${server.address().port}/#ticket=${"x".repeat(43)}`, commands, authentication, sockets };
}
function reply(socket, request, result, error) { socket.send(JSON.stringify({ type: "response", id: request.id, ...(result === undefined ? {} : { result }), ...(error === undefined ? {} : { error }) })); }

test("retired lease probe sends one original request, retains exact rejection and joins actual socket close", async t => {
  const server = await serverCase(t, (socket, request) => request.operation === "status" ? reply(socket, request, cleanStatus()) : reply(socket, request, undefined, { code: "HUMAN_STALE" }));
  const report = await probeEndedWorkerHumanLease(server.url, options());
  assert.deepEqual(server.commands.map(item => item.operation), ["status", "humanInput", "status"]);
  assert.deepEqual(server.commands[1], { id: 2, operation: "humanInput", leaseId: "ended-lease", generation: 2, sequence: 14, input: { type: "text", text: "MUST_NOT_BE_DELIVERED" } });
  assert.equal(report.response.error.code, "HUMAN_STALE"); assert.ok(report.closedAt >= report.completedAt); assert.equal(report.closeCode, 1000);
  assert.equal(server.authentication.length, 1); assert.equal(JSON.stringify(report).includes("x".repeat(43)), false);
});

for (const [name, response] of [["successful mutation acknowledgement", { result: { acknowledged: true } }], ["unrelated failure", { error: { code: "BACKEND_UNAVAILABLE" } }]]) {
  test(`retired lease probe refuses ${name}`, async t => {
    const server = await serverCase(t, (socket, request) => request.operation === "status" ? reply(socket, request, cleanStatus()) : reply(socket, request, response.result, response.error));
    await assert.rejects(probeEndedWorkerHumanLease(server.url, options()), error => {
      assert.ok(error.workerHumanLeaseProbe?.closedAt); return true;
    });
    assert.equal(server.commands.filter(item => item.operation === "humanInput").length, 1);
    assert.ok(server.commands.length <= 2, "Failed probe cannot retry or continue");
  });
}

test("probe does not submit stale input until paused cleanup is complete", async t => {
  const server = await serverCase(t, (socket, request) => { const state = cleanStatus(); state.status.cleanupComplete = false; reply(socket, request, state); });
  await assert.rejects(probeEndedWorkerHumanLease(server.url, options()));
  assert.deepEqual(server.commands.map(item => item.operation), ["status"]);
});

test("unexpected frame after a valid stale reply cannot turn into a successful probe", async t => {
  const server = await serverCase(t, (socket, request, commands) => {
    if (request.operation === "humanInput") return reply(socket, request, undefined, { code: "HUMAN_STALE" });
    reply(socket, request, cleanStatus());
    if (commands.length === 3) socket.send(JSON.stringify({ type: "frame", data: "unexpected" }));
  });
  await assert.rejects(probeEndedWorkerHumanLease(server.url, options()), /cannot publish frames/);
});

test("authentication deadline is a failure and never permission to send input", async t => {
  const server = await serverCase(t, () => assert.fail("No command before authentication"), { noAuthentication: true });
  await assert.rejects(probeEndedWorkerHumanLease(server.url, { ...options(), timeoutMs: 50 }), /deadline expired/);
  assert.equal(server.commands.length, 0);
});
