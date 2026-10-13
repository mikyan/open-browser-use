import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { installSiteAccessDiagnostics } from "./site-access-diagnostics.mjs";

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const frame = { frameId: 0, parentFrameId: -1, url: "https://fixture.test/form?nonce=original", documentId: "document-original", documentLifecycle: "active", errorOccurred: false };
function fixture({ inspect, getTab, getFrames, navigate, revoke, maxRecords } = {}) {
  const calls = [], target = {};
  const chrome = {
    tabs: { get(...args) { calls.push({ name: "tabs.get", receiver: this, args }); return getTab ? getTab(...args) : Promise.resolve({ id: args[0], url: frame.url, title: "not retained", favIconUrl: "not retained" }); } },
    webNavigation: { getAllFrames(...args) { calls.push({ name: "getAllFrames", receiver: this, args }); return getFrames ? getFrames(...args) : Promise.resolve([frame]); } }
  };
  const backend = {
    siteAccess: { restricted: true, status: () => ({ generation: "generation-original", revision: 4, ready: true }) },
    siteNavigationVersions: new Map([[7, 3]]), sitePendingFrames: new Map(), siteRevokedTabs: new Set(),
    attachedTabs: new Set([7]), pendingAttachmentTabs: new Set(),
    assertSiteTab(...args) { calls.push({ name: "assert", receiver: this, args }); return inspect ? inspect.call(this, chrome, ...args) : Promise.resolve({ tabId: args[0], generation: "generation-original", revision: 4, version: 3 }); },
    onSiteNavigation(details, phase) { if (navigate) return navigate.call(this, details, phase); this.siteNavigationVersions.set(details.tabId, 4); },
    revokeSiteTab(tabId) { if (revoke) return revoke.call(this, tabId); this.siteRevokedTabs.add(tabId); }
  };
  const originals = [backend.assertSiteTab, backend.onSiteNavigation, backend.revokeSiteTab, chrome.tabs.get, chrome.webNavigation.getAllFrames];
  const installed = installSiteAccessDiagnostics(backend, chrome, target, maxRecords === undefined ? {} : { maxRecords });
  return { backend, chrome, target, calls, installed, originals, api: target.__siteAccessDiagnostics };
}
test("observation preserves original Promise, receiver and argument identities without extra native queries", async () => {
  const gate = deferred(), f = fixture({ inspect: () => gate.promise });
  const receiver = {}, options = { recover: true, allowBlank: false };
  const result = f.backend.assertSiteTab.call(receiver, 7, options);
  assert.equal(result, gate.promise); assert.equal(f.calls[0].receiver, receiver); assert.equal(f.calls[0].args[1], options);
  assert.equal(f.calls.length, 1); assert.equal(f.api.snapshot().pending, 1);
  const proof = { tabId: 7, generation: "g", revision: 4, version: 3 };
  gate.resolve(proof); assert.equal(await result, proof);
  const saved = f.api.stop();
  assert.deepEqual(saved.records.map(row => row.kind), ["call", "fulfilled"]);
  assert.equal(saved.pending, 0); assert.deepEqual(saved.errors, []); assert.equal(saved.restored, true); assert.equal(saved.apiRemoved, true);
  assert.deepEqual([f.backend.assertSiteTab, f.backend.onSiteNavigation, f.backend.revokeSiteTab, f.chrome.tabs.get, f.chrome.webNavigation.getAllFrames], f.originals);
  assert.deepEqual(f.api.stop(), saved);
});
test("native snapshots identify the original allowed document and omit unrelated tab fields", async () => {
  const f = fixture();
  const options = { tabId: 7 }, receiver = {};
  await f.chrome.tabs.get.call(receiver, 7); await f.chrome.webNavigation.getAllFrames(options);
  assert.equal(f.calls[0].receiver, receiver); assert.equal(f.calls[1].args[0], options);
  assert.equal(f.calls.length, 2);
  const saved = f.api.stop(), values = saved.records.filter(row => row.kind === "fulfilled").map(row => row.value);
  assert.deepEqual(values[0], { id: 7, url: frame.url });
  assert.deepEqual(values[1], { frameCount: 1, framesTruncated: false, frames: [frame] });
  assert.doesNotMatch(JSON.stringify(saved), /not retained/);
});
test("initial inspection rejection remains visible after a navigation/version change and synchronous revoke", async () => {
  const gate = deferred(), error = Error("OBU_SITE_ACCESS_UNVERIFIED: documents changed during permission inspection");
  const f = fixture({ getFrames: () => gate.promise, async inspect(chrome, tabId) {
    const version = this.siteNavigationVersions.get(tabId);
    await Promise.all([chrome.tabs.get(tabId), chrome.webNavigation.getAllFrames({ tabId })]);
    if (version !== this.siteNavigationVersions.get(tabId)) { this.revokeSiteTab(tabId); throw error; }
  } });
  const result = f.backend.assertSiteTab(7);
  f.backend.onSiteNavigation({ tabId: 7, frameId: 2, url: "https://fixture.test/allowed-child", documentId: "child" }, "committed");
  gate.resolve([frame]); await assert.rejects(result, actual => actual === error);
  const saved = f.api.stop(), calls = saved.records.filter(row => row.kind === "call");
  assert.equal(calls.filter(row => row.method === "tabs.get").length, 1);
  assert.equal(calls.filter(row => row.method === "webNavigation.getAllFrames").length, 1);
  assert.equal(calls.find(row => row.method === "tabs.get").parentInspectionId, calls[0].callId);
  assert.equal(calls[0].state.navigationVersion, 3);
  const rejected = saved.records.find(row => row.method === "assertSiteTab" && row.kind === "rejected");
  assert.equal(rejected.error.message, error.message); assert.equal(rejected.state.navigationVersion, 4); assert.equal(rejected.state.revoked, true);
  assert.match(calls.find(row => row.method === "revokeSiteTab").stack, /revokeSiteTab/);
  assert.deepEqual(saved.errors, []);
});
test("native rejection and synchronous throws keep their exact original error objects", async () => {
  const error = Error("native failed"), f = fixture({ getTab: () => Promise.reject(error), navigate() { throw error; } });
  await assert.rejects(f.chrome.tabs.get(7), actual => actual === error);
  assert.throws(() => f.backend.onSiteNavigation({ tabId: 7 }, "error"), actual => actual === error);
  const saved = f.api.stop();
  assert.equal(saved.records.find(row => row.kind === "rejected").error.message, "native failed");
  assert.equal(saved.records.find(row => row.kind === "threw").error.message, "native failed");
  assert.equal(saved.pending, 0);
});
test("overlapping inspections are not spuriously assigned to each other's asynchronous continuation", async () => {
  const gates = [deferred(), deferred()]; let index = 0;
  const f = fixture({ inspect(chrome, tabId) { const waiting = gates[index++]; chrome.tabs.get(tabId); return waiting.promise; } });
  const first = f.backend.assertSiteTab(7), second = f.backend.assertSiteTab(8);
  gates[1].resolve({ tabId: 8 }); await second; gates[0].resolve({ tabId: 7 }); await first;
  const saved = f.api.stop(), calls = saved.records.filter(row => row.kind === "call");
  for (const native of calls.filter(row => row.method === "tabs.get")) {
    assert.equal(calls.find(row => row.callId === native.parentInspectionId).tabId, native.tabId);
  }
  assert.equal(saved.pending, 0);
});
test("pending stop is explicitly incomplete and late ACK cannot rewrite the saved final evidence", async () => {
  const gate = deferred(), f = fixture({ getFrames: () => gate.promise });
  const result = f.chrome.webNavigation.getAllFrames({ tabId: 7 });
  const saved = f.api.stop(); assert.equal(saved.pending, 1); assert.match(saved.errors[0], /before original observed Promises settled/);
  gate.resolve([frame]); await result; assert.deepEqual(f.api.snapshot(), saved);
});
test("bounded trace fails explicitly on overflow rather than dropping records silently", async () => {
  const f = fixture({ maxRecords: 1 }); await f.backend.assertSiteTab(7);
  const saved = f.api.stop(); assert.equal(saved.records.length, 1); assert.equal(saved.overflow, true); assert.equal(saved.droppedRecords, 1);
});
test("restore preserves a successor wrapper, restores all other methods and reports the conflict", () => {
  const f = fixture(), successor = () => Promise.resolve([]); f.chrome.webNavigation.getAllFrames = successor;
  const saved = f.api.stop(); assert.equal(saved.restored, false); assert.equal(saved.apiRemoved, true);
  assert.match(saved.errors[0], /wrapper replaced/); assert.equal(f.chrome.webNavigation.getAllFrames, successor);
  assert.equal(f.backend.assertSiteTab, f.originals[0]); assert.equal(f.chrome.tabs.get, f.originals[3]);
});
test("observation failure cannot turn a fulfilled original operation into rejection", async () => {
  const proof = { tabId: 7 }, original = Promise.resolve(proof), f = fixture({ inspect: () => original });
  f.backend.siteAccess.status = () => { throw Error("diagnostic state read failed"); };
  const result = f.backend.assertSiteTab(7); assert.equal(result, original); assert.equal(await result, proof);
  const saved = f.api.stop(); assert.ok(saved.errors.length); assert.equal(saved.pending, 0);
});
test("installer is self-contained in a separate realm and cleans inherited methods without creating own replacements", async () => {
  const f = fixture(); f.api.stop();
  const prototype = { assertSiteTab: f.backend.assertSiteTab }; delete f.backend.assertSiteTab; Object.setPrototypeOf(f.backend, prototype);
  const install = vm.runInNewContext(`(${installSiteAccessDiagnostics.toString()})`);
  install(f.backend, f.chrome, f.target); await f.backend.assertSiteTab(7);
  const saved = f.target.__siteAccessDiagnostics.stop();
  assert.equal(saved.restored, true); assert.equal(Object.hasOwn(f.backend, "assertSiteTab"), false);
  assert.equal(f.backend.assertSiteTab, prototype.assertSiteTab);
});
