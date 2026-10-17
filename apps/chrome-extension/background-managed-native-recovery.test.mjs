import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "./test-support/page-waits-fixture.mjs";

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function until(check) {
  for (let count = 0; count < 100; count++) { if (check()) return; await tick(); }
  throw new Error("original fixture operation did not enter");
}
async function delivered(t) {
  const f = await fixture(t, { managed: true }); f.params.tabId = 7;
  await f.backend.attach(f.params);
  await f.backend.finalizeTabs({ ...f.params, keep: [{ tabId: 7, status: "deliverable" }] });
  f.record = f.backend.managedResults.entries()[0]; assert.ok(f.record);
  return f;
}

test("managed native loss keeps the original result and requires recovered user admission before popup Resume", async t => {
  const f = await delivered(t), original = f.record;
  const recovery = f.backend.nativeDisconnected();
  assert.equal(f.backend.automationControl.inputBlocked, true);
  assert.equal(f.backend.automationControl.cleanupComplete, false);
  await assert.rejects(f.backend.resumeAutomation(0), /NATIVE_RECOVERY/);
  await recovery;
  assert.equal(f.backend.nativeRecovery, null);
  const status = await f.backend.getAutomationControlStatus();
  assert.equal(status.state, "paused"); assert.equal(status.cleanupComplete, true);
  assert.equal(f.backend.managedResults.entries()[0], original);
  assert.equal((await f.backend.getManagedViewerTabs())[0].deliveryId, original.deliveryId);
  await assert.rejects(f.backend.resumeAutomation(status.revision), /MANAGED_NATIVE_RECOVERY_REQUIRED/);
  await assert.rejects(f.backend.getControlState({ session_id: "task" }), /AUTOMATION_PAUSED/);
  const token = await f.backend.prepareManagedUserOpen();
  f.backend.commitManagedUserOpen(token);
  await f.backend.resumeAutomation(status.revision);
  await assert.rejects(f.backend.getTabs(f.params), /STALE_CONTROL_EPOCH/);
  const next = await f.backend.getControlState({ session_id: "task" });
  assert.ok(next.controlEpoch > f.params.control_epoch);
});

test("managed native recovery waits for actual original human mouse release and detach", async t => {
  const f = await delivered(t);
  const handle = await f.backend.beginManagedHuman(7, () => {}, () => {}, () => {}, { deliveryId: f.record.deliveryId });
  const info = handle.info();
  await handle.input({ leaseId: info.leaseId, generation: info.generation, sequence: 1,
    input: { type: "pointer", action: "down", button: "left", x: 10, y: 20, modifiers: 0 } });
  const release = f.gate(); let releasing = false;
  f.hooks.command = async (_target, method, params) => {
    if (method === "Input.dispatchMouseEvent" && params.type === "mouseReleased") { releasing = true; await release.promise; }
  };
  const recovery = f.backend.nativeDisconnected();
  await until(() => releasing);
  let ready = false;
  const opening = f.backend.prepareManagedUserOpen().then(value => { ready = true; return value; });
  await tick(); assert.equal(ready, false); assert.equal(f.attached.has(7), true);
  await assert.rejects(handle.input({ leaseId: info.leaseId, generation: info.generation, sequence: 2,
    input: { type: "pointer", action: "up", button: "left", x: 10, y: 20, modifiers: 0 } }), /REVOKED|STALE|CLOSED|unavailable/i);
  release.resolve(); await recovery; const token = await opening;
  assert.equal(handle.info().state, "released"); assert.equal(f.attached.has(7), false);
  assert.equal(f.backend.browserLifetime.controlSnapshot().pending.length, 0);
  assert.equal(f.calls.filter(([method, , params]) => method === "Input.dispatchMouseEvent" && params.type === "mouseReleased").length, 1);
  f.backend.commitManagedUserOpen(token);
  assert.equal(f.backend.automationControl.state, "paused");
});

test("failed managed Pause persistence keeps old results inaccessible and does not commit a new user open", async t => {
  const f = await delivered(t);
  f.hooks.write = async (_area, value) => {
    if (Object.keys(value).some(key => key.includes("AUTOMATION_CONTROL"))) throw new Error("original Pause persistence failed");
  };
  await assert.rejects(f.backend.nativeDisconnected(), /original Pause persistence failed/);
  await assert.rejects(f.backend.prepareManagedUserOpen(), /original Pause persistence failed/);
  assert.equal(f.backend.managedNativeEpoch.opened, false);
  assert.equal(f.backend.automationControl.inputBlocked, true);
  assert.equal(f.backend.automationControl.cleanupComplete, false);
  assert.equal((await f.backend.getManagedViewerTabs()).length, 0);
  await assert.rejects(f.backend.managedViewerSubscribe(7, () => {}, () => {}, { deliveryId: f.record.deliveryId }), /NATIVE_RECOVERY_FAILED/);
});

test("managed disconnect joins an already dispatched original down ACK before issuing its release", async t => {
  const f = await delivered(t);
  const handle = await f.backend.beginManagedHuman(7, () => {}, () => {}, () => {}, { deliveryId: f.record.deliveryId });
  const info = handle.info(), dispatched = f.gate(); let entered = false;
  f.hooks.command = async (_target, method, params) => {
    if (method === "Input.dispatchMouseEvent" && params.type === "mousePressed") { entered = true; await dispatched.promise; }
  };
  const input = handle.input({ leaseId: info.leaseId, generation: info.generation, sequence: 1,
    input: { type: "pointer", action: "down", button: "left", x: 10, y: 20, modifiers: 0 } });
  await until(() => entered);
  const recovery = f.backend.nativeDisconnected();
  await tick();
  assert.equal(f.calls.some(([method, , params]) => method === "Input.dispatchMouseEvent" && params.type === "mouseReleased"), false);
  assert.equal(f.attached.has(7), true);
  dispatched.resolve();
  const receipt = await input;
  assert.equal(receipt.sequence, 1); assert.equal(receipt.acknowledged, true);
  await recovery;
  assert.equal(handle.info().state, "released");
  assert.equal(f.calls.filter(([method, , params]) => method === "Input.dispatchMouseEvent" && params.type === "mouseReleased").length, 1);
  assert.equal(f.attached.has(7), false);
});

test("a second native loss invalidates a prepared open token without reopening automation", async t => {
  const f = await delivered(t);
  await f.backend.nativeDisconnected();
  const first = await f.backend.prepareManagedUserOpen();
  await f.backend.nativeDisconnected();
  assert.throws(() => f.backend.commitManagedUserOpen(first), /MANAGED_NATIVE_CHANGED/);
  assert.equal(f.backend.managedNativeEpoch.opened, false);
  assert.equal(f.backend.automationControl.state, "paused");
});

test("managed native loss during constructor recovery does not wait on its own Pause transition", async t => {
  const f = await fixture(t, { managed: true });
  const backend = new f.Backend();
  await backend.nativeDisconnected();
  await backend.controlReady;
  assert.equal(backend.automationControl.state, "paused");
  assert.equal(backend.automationControl.cleanupComplete, true);
});
