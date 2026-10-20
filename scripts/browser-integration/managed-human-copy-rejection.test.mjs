import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { installManagedCopyRejectionRoute } from "./managed-human-copy-rejection.mjs";

const scope = { leaseId: "original-human", generation: 2 };
const command = (extra = {}) => ({ id: 7, operation: "humanInput", ...scope, sequence: 3,
  input: { type: "key", action: "down", key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17, modifiers: 2 }, ...extra });
const response = (q = command()) => ({ type: "response", id: q.id, result: { inputReceipt: {
  leaseId: q.leaseId, generation: q.generation, sequence: q.sequence, acknowledged: true
} } });
const json = value => JSON.stringify(value);
async function setup() {
  const toPage = [], toServer = [];
  let predicate, handler;
  const server = { send(raw) { toServer.push(raw); }, onMessage(fn) { this.receive = fn; } };
  const route = { connectToServer() { return server; }, onMessage(fn) { this.receive = fn; }, send(raw) { toPage.push(raw); } };
  const gate = await installManagedCopyRejectionRoute({ async routeWebSocket(match, callback) { predicate = match; handler = callback; } },
    "http://127.0.0.1:12345/?unused=ignored#ticket=DO_NOT_RECORD");
  handler(route);
  return { gate, route, server, toPage, toServer, predicate, handler };
}

test("exact original /ws URL and default passthrough preserve auth without recording it", async () => {
  const h = await setup();
  assert.equal(h.gate.release(), null);
  assert.equal(h.predicate(new URL("ws://127.0.0.1:12345/ws")), true);
  for (const url of ["ws://127.0.0.1:12346/ws", "ws://localhost:12345/ws", "ws://127.0.0.1:12345/ws?ticket=secret", "ws://127.0.0.1:12345/else"])
    assert.equal(h.predicate(new URL(url)), false);
  const auth = json({ type: "authenticate", ticket: "DO_NOT_RECORD" }), frame = Buffer.from("original binary frame");
  h.route.receive(auth); h.server.receive(frame);
  assert.equal(h.toServer[0], auth); assert.equal(h.toPage[0], frame);
  assert.doesNotMatch(json(h.gate.snapshot()), /DO_NOT_RECORD|ticket|original binary frame/);
});

test("only the exact original successful Ctrl-down ACK is held and released byte-for-byte once", async () => {
  const h = await setup(); h.gate.arm(scope);
  const q = json(command()), raw = Buffer.from(" " + json(response()) + "\n");
  h.route.receive(q); h.server.receive(raw);
  const before = h.gate.snapshot();
  assert.equal(h.toServer[0], q); assert.equal(h.toPage.length, 0);
  assert.equal(before.held, true); assert.equal(before.request.id, 7); assert.equal(before.response.id, 7);
  assert.equal(before.response.bytes, raw.length);
  assert.equal(before.response.rawSHA256, createHash("sha256").update(raw).digest("hex"));
  const original = Buffer.from(raw); raw.fill(0);
  const first = h.gate.release(), second = h.gate.release();
  assert.deepEqual(first, second); assert.equal(h.toPage.length, 1); assert.deepEqual(h.toPage[0], original);
  assert.equal(h.gate.snapshot().held, false);
  assert.equal(Object.hasOwn(first, "delivered"), false);
  assert.ok(first.attemptedAt >= before.response.serverArrivedAt);
});

test("other scope, generation, controls and nonresponse frames always pass unchanged", async () => {
  const h = await setup(); h.gate.arm(scope);
  for (const q of [
    command({ id: 1, leaseId: "other" }), command({ id: 2, generation: 3 }),
    command({ id: 3, input: { ...command().input, code: "ControlRight" } }),
    command({ id: 4, input: { ...command().input, action: "up" } }),
    command({ id: 5, input: { ...command().input, repeat: true } })
  ]) { const raw = json(q), ack = json(response(q)); h.route.receive(raw); h.server.receive(ack); assert.equal(h.toServer.at(-1), raw); assert.equal(h.toPage.at(-1), ack); }
  const frame = json({ type: "frame", id: 7, data: "untouched" }); h.server.receive(frame);
  assert.equal(h.toPage.at(-1), frame); assert.equal(h.gate.snapshot().held, false);
  h.route.receive(json(command())); h.server.receive(json({ type: "state", id: 7 }));
  assert.equal(h.gate.snapshot().held, false);
  h.server.receive(json(response())); assert.equal(h.gate.snapshot().held, true);
});

test("invalid native receipt is not converted into a successful held ACK", async () => {
  const h = await setup(); h.gate.arm(scope); h.route.receive(json(command()));
  const bad = response(); bad.result.inputReceipt.generation++;
  const raw = json(bad); h.server.receive(raw);
  assert.equal(h.toPage[0], raw); assert.equal(h.gate.snapshot().held, false);
  assert.match(h.gate.snapshot().errors[0], /exact native input/);
  assert.equal(h.gate.release(), null);
});

test("arm is single-use, snapshots are detached and failed forwarding cannot retry the ACK", async () => {
  const h = await setup(); h.gate.arm(scope);
  assert.throws(() => h.gate.arm(scope), /only once/);
  const snap = h.gate.snapshot(); snap.scope.leaseId = "changed"; snap.requests.push({});
  h.route.receive(json(command())); h.server.receive(json(response()));
  let attempts = 0; h.route.send = () => { attempts++; throw Error("test delivery failure"); };
  assert.throws(() => h.gate.release(), /test delivery failure/);
  const attempt = h.gate.release();
  assert.equal(attempt.id, 7); assert.equal(attempts, 1); assert.equal(h.gate.snapshot().requests.length, 1);
  assert.match(h.gate.snapshot().errors.at(-1), /Forwarding/);
});

test("bounded accounting flags overflow while actual commands and frames still forward", async () => {
  const h = await setup(); h.gate.arm(scope);
  for (let i = 1; i <= 129; i++) {
    const q = command({ id: i, sequence: i, input: { type: "text", text: "PRIVATE_NOT_RECORDED" } });
    h.route.receive(json(q)); h.server.receive(json(response(q)));
  }
  const snapshot = h.gate.snapshot();
  assert.equal(snapshot.overflow, true); assert.equal(snapshot.requests.length, 128);
  assert.equal(snapshot.responses.length, 128);
  assert.equal(h.toServer.length, 129); assert.equal(h.toPage.length, 129);
  assert.doesNotMatch(json(snapshot), /PRIVATE_NOT_RECORDED/);
});
