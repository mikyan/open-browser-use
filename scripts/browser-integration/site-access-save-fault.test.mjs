import assert from "node:assert/strict";
import test from "node:test";
import { installSiteAccessSaveFault } from "./site-access-save-fault.mjs";

const key = "OPEN_BROWSER_USE_SITE_ACCESS_POLICY", testKey = "__OBU_TEST_SITE_QUOTA_0123456789abcdef";
const candidate = revision => ({ [key]: { version: 1, revision, mode: "allow", origins: ["https://example.test"] } });
// These are method simulations; only the real-browser fixture proves quota
// enforcement. Here we verify exact Promise/receiver and argument transparency.
function setup(native) {
  const calls = [], target = {};
  const storage = { QUOTA_BYTES: 128, set(...args) {
    const call = { args, receiver: this }; calls.push(call);
    call.result = native ? native(call) : Object.hasOwn(args[0], testKey) ? Promise.reject(Error("simulated quota")) : Promise.resolve();
    return call.result;
  } };
  const descriptor = Object.getOwnPropertyDescriptor(storage, "set");
  const installed = installSiteAccessSaveFault({ storage: { local: storage } }, target, { revision: 5, testKey });
  return { storage, descriptor, calls, installed, target, api: target.__siteAccessSaveFault };
}
test("matching native write keeps Promise/receiver, adds only padding and restores descriptor", async () => {
  const f = setup(), value = candidate(5), copy = structuredClone(value), receiver = {};
  const result = f.storage.set.call(receiver, value);
  assert.equal(result, f.calls[0].result); assert.equal(f.calls[0].receiver, receiver);
  assert.deepEqual(value, copy); assert.equal(f.calls[0].args[0][key], value[key]);
  assert.equal(f.calls[0].args[0][testKey].length, 1152);
  await assert.rejects(result, /simulated quota/);
  f.api.disable(); const next = candidate(6), retry = f.storage.set(next);
  assert.equal(retry, f.calls[1].result); assert.equal(f.calls[1].args[0], next); await retry;
  const final = f.api.stop();
  assert.deepEqual(final.rows.map(row => row.kind), ["call", "rejected", "call", "fulfilled"]);
  assert.equal(final.pending, 0); assert.deepEqual(final.errors, []);
  assert.equal(final.restored, true); assert.equal(final.apiRemoved, true);
  assert.deepEqual(Object.getOwnPropertyDescriptor(f.storage, "set"), f.descriptor);
  assert.deepEqual(f.api.stop(), final);
});
test("unrelated and prior-revision writes keep exact arguments and are not recorded", async () => {
  const f = setup();
  for (const value of [{ unrelated: true }, candidate(4)]) {
    const result = f.storage.set(value); assert.equal(result, f.calls.at(-1).result);
    assert.equal(f.calls.at(-1).args[0], value); await result;
  }
  assert.equal(f.api.stop().attempts, 0);
});
test("unsettled native Promise stays pending, never invents rejection or hides incomplete stop", async () => {
  let resolve;
  const gate = new Promise(done => { resolve = done; }), f = setup(() => gate);
  const result = f.storage.set(candidate(5)); assert.equal(result, gate);
  assert.equal(f.api.snapshot().pending, 1); assert.equal(f.api.snapshot().rows.length, 1);
  const final = f.api.stop(); assert.equal(final.pending, 1);
  assert.match(final.errors[0], /before native storage settled/);
  resolve(); await result;
  assert.deepEqual(f.api.snapshot(), final, "late settlement rewrote final evidence");
});
test("wrong fixture scope is rejected without replacing the native method", () => {
  const storage = { QUOTA_BYTES: 128, set() {} }, original = storage.set;
  assert.throws(() => installSiteAccessSaveFault({ storage: { local: storage } }, {}, { revision: 0, testKey }));
  assert.equal(storage.set, original);
});
