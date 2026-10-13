import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { installSiteAccessInvalidProbe, siteAccessInvalidPrefix, checkSiteAccessInvalidNative, checkSiteAccessInvalidReplacement } from "./site-access-invalid-fixture.mjs";

const key = "OPEN_BROWSER_USE_SITE_ACCESS_POLICY", markerKey = "__OBU_TEST_SITE_INVALID_0123456789abcdef", nonce = "a".repeat(32), options = { markerKey, nonce };
const malformed = { version: 1, revision: 7, mode: "invalid-fixture-mode", origins: [] }, replacement = { version: 1, revision: 1, mode: "allow", origins: ["https://allowed.test"] };
function fixture({ get, set, marker = { version: 1, nonce, armed: true } } = {}) {
  const calls = [], target = {}, session = marker ? { [markerKey]: marker } : {};
  const local = Object.fromEntries(["get", "set"].map(operation => [operation, function (...args) { const call = { operation, args, receiver: this }; calls.push(call); call.promise = (operation === "get" ? get : set)?.(call) ?? Promise.resolve(operation === "get" ? { [key]: structuredClone(malformed) } : undefined); return call.promise; }]));
  const chrome = { runtime: { id: "original-extension" }, storage: { local, session: { async get(name) { return Object.hasOwn(session, name) ? { [name]: structuredClone(session[name]) } : {}; }, async remove(name) { delete session[name]; } } } };
  return { chrome, target, calls, local, session, originalGet: local.get, originalSet: local.set };
}

test("invalid startup and replacement retain original native Promises, receiver, arguments and successful settlements", async () => {
  const f = fixture(); await installSiteAccessInvalidProbe(f.chrome, f.target, options); assert.deepEqual(f.session, {});
  const receiver = {}, read = f.local.get.call(receiver, key); assert.equal(read, f.calls[0].promise); assert.equal(f.calls[0].receiver, receiver); assert.deepEqual(await read, { [key]: malformed });
  checkSiteAccessInvalidNative(f.target.__siteAccessInvalidProbe.snapshot(), malformed);
  const value = { [key]: replacement }, written = f.local.set(value); assert.equal(written, f.calls[1].promise); assert.equal(f.calls[1].args[0], value); await written;
  checkSiteAccessInvalidNative(f.target.__siteAccessInvalidProbe.snapshot(), malformed, replacement);
  const final = f.target.__siteAccessInvalidProbe.stop(); checkSiteAccessInvalidNative(final, malformed, replacement, { stopped: true });
  assert.equal(f.local.get, f.originalGet); assert.equal(f.local.set, f.originalSet); assert.equal(f.target.__siteAccessInvalidProbe, undefined);
  assert.deepEqual(await installSiteAccessInvalidProbe(f.chrome, f.target, options), { armed: false });
});

test("unselected calls retain exact native Promise and do not enter the policy ledger", async () => {
  const f = fixture(); await installSiteAccessInvalidProbe(f.chrome, f.target, options); const receiver = {};
  for (const [operation, args] of [["get", [[key]]], ["get", [key, undefined]], ["get", ["other"]], ["set", [{ other: true }]]]) {
    const native = f.local[operation].apply(receiver, args), call = f.calls.at(-1); assert.equal(native, call.promise); assert.equal(call.receiver, receiver); assert.deepEqual(call.args, args); await native;
  }
  assert.deepEqual(f.target.__siteAccessInvalidProbe.snapshot().rows, []); f.target.__siteAccessInvalidProbe.stop();
});

test("a real rejected read or write is retained and never becomes successful corrupt replacement evidence", async () => {
  for (const operation of ["get", "set"]) {
    const error = Object.freeze(Error(`original ${operation} failure`)), f = fixture({ [operation]: () => Promise.reject(error) }); await installSiteAccessInvalidProbe(f.chrome, f.target, options);
    if (operation === "set") await f.local.get(key);
    const value = f.local[operation](operation === "get" ? key : { [key]: replacement }); assert.equal(value, f.calls.at(-1).promise); await assert.rejects(value, actual => actual === error);
    const snapshot = f.target.__siteAccessInvalidProbe.stop(); assert.equal(snapshot.rows.at(-1).kind, "native-rejected"); assert.throws(() => checkSiteAccessInvalidNative(snapshot, malformed, replacement, { stopped: true }));
    assert.equal(f.calls.filter(call => call.operation === operation).length, 1);
  }
});

test("pending real replacement cannot claim an ACK or restore the observer before settlement", async () => {
  let resolve; const native = new Promise(done => { resolve = done; }), f = fixture({ set: () => native }); await installSiteAccessInvalidProbe(f.chrome, f.target, options); await f.local.get(key);
  const written = f.local.set({ [key]: replacement }), probe = f.target.__siteAccessInvalidProbe; assert.equal(written, native);
  assert.equal(probe.snapshot().pending, 1); assert.throws(() => probe.stop(), /still pending/); assert.equal(f.target.__siteAccessInvalidProbe, probe); assert.notEqual(f.local.set, f.originalSet);
  assert.throws(() => checkSiteAccessInvalidNative(probe.snapshot(), malformed, replacement)); resolve(); await written;
  checkSiteAccessInvalidNative(probe.stop(), malformed, replacement, { stopped: true }); assert.equal(f.calls.length, 2);
});

test("prefix observes the actual first fulfilled constructor read without inventing a read failure", async () => {
  const f = fixture(), context = { chrome: f.chrome, structuredClone };
  const result = await new vm.Script(`(async()=>{${siteAccessInvalidPrefix(options)}return chrome.storage.local.get(${JSON.stringify(key)})})()`).runInNewContext(context);
  assert.deepEqual(result, { [key]: malformed }); assert.equal(f.calls.length, 1); assert.deepEqual(f.session, {});
  const bad = fixture({ marker: { version: 1, nonce: "b".repeat(32), armed: true } });
  await assert.rejects(installSiteAccessInvalidProbe(bad.chrome, bad.target, options), /Unexpected corrupt-policy probe marker/); assert.equal(bad.local.get, bad.originalGet); assert.equal(bad.calls.length, 0);
});

test("native oracle rejects malformed origin proof, extra writes, argument changes and invented settlement", async () => {
  const f = fixture(); await installSiteAccessInvalidProbe(f.chrome, f.target, options); await f.local.get(key); await f.local.set({ [key]: replacement });
  const original = f.target.__siteAccessInvalidProbe.snapshot();
  for (const mutate of [s => s.rows[1].value[key].mode = "all", s => s.rows[2].args[0][key].origins = [], s => s.rows[3].kind = "native-rejected",
    s => s.rows.push(structuredClone(s.rows[3])), s => s.writes++, s => s.pending++, s => s.rows[2].sequence = 99, s => s.overflow = true]) {
    const changed = structuredClone(original); mutate(changed); assert.throws(() => checkSiteAccessInvalidNative(changed, malformed, replacement));
  }
  f.target.__siteAccessInvalidProbe.stop();
});

test("borrowed popup remains open and original failure survives all exact cleanup attempts", async () => {
  const primary = Object.freeze(Error("original frame read failed")), calls = []; let saved;
  const popup = { evaluate() { throw Error("Popup must not be used before original document read"); }, close() { throw Error("Borrowed popup must not close"); } };
  await assert.rejects(checkSiteAccessInvalidReplacement({
    connectBrowser: async () => ({ client: { controlEpoch: 7 }, newTab: async () => ({ id: 12 }), close() { calls.push("browser-close"); } }),
    getWorker: () => ({ evaluate(source) { if (source === "chrome.tabs.remove(12)") { calls.push("original-tab-remove"); throw Error("native cleanup failed"); } throw primary; } }),
    existingPopup: popup, fixtureURL: "http://original.test", popupURL: "chrome-extension://original-extension/popup.html", markerKey, nonce,
    connectPage: () => { throw Error("No borrowed reconnect"); }, traceFocus: () => { throw Error("No borrowed focus changes"); },
    fixtures: { allStats: () => { calls.push("original-ledger"); return [{ original: true }]; } }, saveDetail: async value => { saved = structuredClone(value); }
  }), error => error === primary);
  assert.deepEqual(calls, ["original-ledger", "original-tab-remove", "browser-close"]); assert.equal(saved.popupOwnership, "borrowed"); assert.match(saved.error, /original frame read failed/); assert.match(saved.tabCleanupError, /native cleanup failed/); assert.deepEqual(saved.serverLedger, [{ original: true }]);
});
