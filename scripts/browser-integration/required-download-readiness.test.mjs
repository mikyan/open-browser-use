import assert from "node:assert/strict";
import { createContext, runInContext } from "node:vm";
import test from "node:test";
import { installRequiredDownloadProbe, assertRequiredDownloadProbe, assertRequiredDownloadRejection,
  assertRequiredDownloadRPCs, assertRequiredDownloadZero, checkRequiredDownloadReadiness } from "./required-download-readiness.mjs";

const scope = { session_id: "required-owner", turn_id: "original-turn", control_epoch: 7 };
const defer = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const clone = value => structuredClone(value);

function probeFixture({ hold = true, holdTimeoutMs = 1000, native = () => Promise.resolve({ acknowledged: true }) } = {}) {
  const listeners = new Set(), calls = [], target = {};
  const original = function (...args) { calls.push({ receiver: this, args }); return native(...args); };
  const api = { debugger: { sendCommand: original, onEvent: { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) } } };
  const context = createContext({ structuredClone, setTimeout, clearTimeout, Date, api, target });
  // Running the serialized function catches references to module-only values.
  const install = runInContext(`(${installRequiredDownloadProbe.toString()})`, context);
  install(api, target, { id: "probe", tabId: 42, scope, hold, holdTimeoutMs });
  const rpc = (method = "armDownloadWait", params = {}, id = "rpc:1") => {
    target.__integrationNativeRPCObserver("request", { id, method, params: { ...scope, tabId: 42, timeoutMs: 15000, requirePath: true, ...params } });
  };
  return { api, target, listeners, calls, original, rpc, probe: target.__requiredDownloadProbe };
}

test("serialized probe holds only a successful original root Page.enable ACK and preserves its value/receiver", async () => {
  const actual = defer(), f = probeFixture({ native: () => actual.promise }), receiver = {}, params = { marker: "unchanged" }, result = { acknowledged: "original" };
  f.rpc(); const delivered = f.api.debugger.sendCommand.call(receiver, { tabId: 42 }, "Page.enable", params);
  assert.notEqual(delivered, actual.promise); assert.equal(f.calls[0].receiver, receiver); assert.equal(f.calls[0].args[2], params);
  assert.equal(f.probe.snapshot().nativePending, 1); actual.resolve(result); await tick();
  assertRequiredDownloadProbe(f.probe.snapshot(), { held: true }); assert.equal(f.probe.snapshot().nativePending, 0);
  let published = false; delivered.then(() => { published = true; }); await tick(); assert.equal(published, false);
  f.probe.release(); assert.equal(await delivered, result); const final = f.probe.restore();
  assertRequiredDownloadProbe(final, { complete: true }); assert.equal(f.api.debugger.sendCommand, f.original); assert.equal(f.listeners.size, 0);
  assert.equal(f.target.__integrationNativeRPCObserver, undefined); assert.equal(f.target.__requiredDownloadProbe, undefined);
});

test("no matching arm, a foreign scope, child target, other tab or method preserves the original Promise", async () => {
  for (const mode of ["no-arm", "foreign", "child", "other-tab", "other-method", "no-hold"]) {
    const actual = Promise.resolve({}), f = probeFixture({ native: () => actual, hold: mode !== "no-hold" });
    if (mode !== "no-arm") f.rpc("armDownloadWait", mode === "foreign" ? { turn_id: "foreign" } : {});
    const source = mode === "child" ? { tabId: 42, sessionId: "child" } : { tabId: mode === "other-tab" ? 43 : 42 };
    const returned = f.api.debugger.sendCommand(source, mode === "other-method" ? "Runtime.evaluate" : "Page.enable", {});
    assert.equal(returned, actual); await returned; await tick(); assert.equal(f.probe.snapshot().deliveryPending, 0); f.probe.restore();
  }
});

test("native rejection and sync throw preserve the exact error without fabricating an ACK", async () => {
  for (const synchronous of [false, true]) {
    const error = Error("original native failure"), f = probeFixture({ native: () => { if (synchronous) throw error; return Promise.reject(error); } });
    f.rpc();
    if (synchronous) assert.throws(() => f.api.debugger.sendCommand({ tabId: 42 }, "Page.enable", {}), value => value === error);
    else await assert.rejects(f.api.debugger.sendCommand({ tabId: 42 }, "Page.enable", {}), value => value === error);
    assert.equal(f.probe.snapshot().records.filter(row => row.kind === "held").length, 0); assert.equal(f.probe.snapshot().nativePending, 0); f.probe.restore();
  }
});

test("watchdog releases the original result but fails evidence", async () => {
  const result = {}, f = probeFixture({ holdTimeoutMs: 20, native: () => Promise.resolve(result) }); f.rpc();
  assert.equal(await f.api.debugger.sendCommand({ tabId: 42 }, "Page.enable", {}), result);
  const final = f.probe.restore(); assert.equal(final.watchdog, true); assert.throws(() => assertRequiredDownloadProbe(final, { complete: true }));
});

test("release-before-ACK cannot leave a late held publication stuck", async () => {
  const actual = defer(), f = probeFixture({ native: () => actual.promise }); f.rpc();
  const pending = f.api.debugger.sendCommand({ tabId: 42 }, "Page.enable", {}); f.probe.release(); actual.resolve("original");
  assert.equal(await pending, "original"); assert.equal(f.probe.snapshot().deliveryPending, 0); f.probe.restore();
});

test("probe records actual input and Page events and refuses to turn them into zero-trigger evidence", async () => {
  const f = probeFixture({ hold: false }); await f.api.debugger.sendCommand({ tabId: 42 }, "Input.dispatchMouseEvent", { type: "mousePressed" });
  for (const fn of f.listeners) fn({ tabId: 42 }, "Page.downloadWillBegin", { guid: "real-guid" });
  await tick(); const final = f.probe.restore(); assert.throws(() => assertRequiredDownloadProbe(final, { complete: true }));
  assert.equal(f.calls.length, 1); assert.equal(final.records.filter(row => row.kind === "page-event").length, 1);
});

test("overflow is a failure; restore never overwrites a replacement observer or native method", async () => {
  const f = probeFixture({ hold: false });
  for (let index = 0; index < 40; index++) f.rpc("armDownloadWait", {}, `rpc:${index}`);
  assert.equal(f.probe.snapshot().overflow, true); const replacement = () => Promise.resolve({}); f.api.debugger.sendCommand = replacement;
  assert.throws(() => f.probe.restore(), /replaced/); assert.equal(f.api.debugger.sendCommand, replacement); assert.equal(f.listeners.size, 0);
});

test("expired installation does not mutate native methods or global slots", () => {
  const f = probeFixture(); f.probe.restore();
  assert.throws(() => installRequiredDownloadProbe(f.api, f.target, { id: "late", tabId: 42, scope, installBefore: Date.now() - 1 }), /installation/);
  assert.equal(f.api.debugger.sendCommand, f.original); assert.equal(f.listeners.size, 0); assert.equal(f.target.__requiredDownloadProbe, undefined);
});

test("non-Promise native results and outstanding native ACKs cannot pass complete evidence", async () => {
  const plain = probeFixture({ native: () => "unexpected" }); plain.rpc();
  assert.equal(plain.api.debugger.sendCommand({ tabId: 42 }, "Page.enable", {}), "unexpected");
  assert.throws(() => assertRequiredDownloadProbe(plain.probe.restore(), { complete: true }));
  const actual = defer(), pending = probeFixture({ native: () => actual.promise }); pending.rpc();
  const result = pending.api.debugger.sendCommand({ tabId: 42 }, "Page.enable", {});
  assert.throws(() => pending.probe.restore(), /not settled/); assert.equal(pending.api.debugger.sendCommand, pending.original);
  actual.resolve("original"); assert.equal(await result, "original");
});

test("rejection oracle requires the original backend RPC, exact message, no duplicate reply and a lifecycle-specific error", async () => {
  const f = probeFixture({ hold: false }); f.rpc();
  const error = "OBU_DOWNLOAD_PATH_UNAVAILABLE: binding lost";
  f.target.__integrationNativeRPCObserver("response", { id: "rpc:1", error: { message: error } });
  const snapshot = f.probe.snapshot(); assertRequiredDownloadRejection(snapshot, "armDownloadWait", error);
  for (const change of [x => { x.records.pop(); }, x => { x.records.push({ ...x.records[1], sequence: 3 }); }, x => { x.records[1].error = "timed out"; }, x => { x.records[1].ok = true; }]) {
    const invalid = clone(snapshot); change(invalid); assert.throws(() => assertRequiredDownloadRejection(invalid, "armDownloadWait", error));
  }
  assert.throws(() => assertRequiredDownloadRejection(snapshot, "armDownloadWait", "different caller error")); f.probe.restore();
});

// Unit-only model for orchestration/cleanup. Native browser evidence is supplied
// separately by the root runner; these fake documents never claim isTrusted.
function driverFixture(mode = "") {
  let available = false, generation = 0, nextTab = 40, nextWait = 0, nextRPC = 0, cuts = 0;
  const pages = new Map(), records = new Map(), waits = new Map(), listeners = new Set(), relays = [], input = [];
  const fixture = {
    createCase({ owner }) { const key = `case-${records.size}`, record = { key, consumed: false, urlPath: `/original-download/page?key=${key}`, requests: [], gets: [], owner }; records.set(key, record); return clone(record); },
    stats(key) { return clone(records.get(key)); }
  };
  const native = function (source, method) { if (method.startsWith("Input.")) input.push({ source, method }); return Promise.resolve({}); };
  const chrome = { debugger: { sendCommand: native, onEvent: { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) },
    getTargets: async () => [...pages.values()].map(p => ({ id: `target-${p.tab.id}`, tabId: p.tab.id, attached: true, type: "page" })) },
    tabs: { get: async id => { if (!pages.has(id)) throw Error("No tab"); return clone(pages.get(id).tab); }, query: async () => [...pages.values()].map(p => clone(p.tab)) },
    scripting: { executeScript: async ({ target }) => { const p = pages.get(target.tabId); return [{ frameId: 0, documentId: p.documentId, result: { href: p.tab.url, state: clone(p.state) } }]; } }
  };
  const context = createContext({ chrome, structuredClone, setTimeout, clearTimeout, Date });
  const worker = { evaluate: expression => Promise.resolve(runInContext(expression, context)) };
  const rpc = async (method, tabId, params, operation) => {
    const id = `rpc:${++nextRPC}`;
    context.__integrationNativeRPCObserver?.("request", { id, method, params: { ...scope, tabId, ...params } });
    try { const result = await operation(); const wire = method === "armDownloadWait" ? { waiterId: result.waiterId, remainingMs: result.remainingMs } : result;
      context.__integrationNativeRPCObserver?.("response", { id, result: wire }); return result; }
    catch (error) { context.__integrationNativeRPCObserver?.("response", { id, error: { message: error.message } }); throw error; }
  };
  const owner = { client: { sessionId: scope.session_id, turnId: scope.turn_id, controlEpoch: scope.control_epoch,
    getTabs: async () => [], getInfo: async () => ({ metadata: { downloadWaitPathVersion: 1, pageDownloads: { available, generation: `generation-${generation}` } } }) },
    cdp: { navigate: async (id, url) => { const p = pages.get(id), key = new URL(url).searchParams.get("key"), record = records.get(key); p.tab.url = url; p.state.key = key; record.gets.push({ url }); record.requests.push({ method: "GET", url }); } },
    newTab: async () => {
      const id = ++nextTab; pages.set(id, { tab: { id, url: "about:blank", active: false, windowId: 5, groupId: 6, pinned: false }, documentId: `document-${id}`, state: { documentToken: `nonce-${id}`, clicks: [], frameAdds: [] } });
      return { id, getByRole: () => ({ textContent: async () => { if (mode === "prewarm-failed") throw Error("prewarm failed"); return "Download original report"; } }), close: async () => { pages.delete(id); },
        expectDownload: async options => rpc("armDownloadWait", id, options, async () => {
          assert.equal(options.requirePath, true);
          if (!available && mode !== "false-ready") throw Error("OBU_DOWNLOAD_PATH_UNAVAILABLE: no binding");
          const originalGeneration = generation;
          await chrome.debugger.sendCommand({ tabId: id }, "Page.enable", {});
          if ((!available || generation !== originalGeneration) && mode !== "false-ready") throw Error("OBU_DOWNLOAD_PATH_UNAVAILABLE: original binding changed");
          const waiterId = `waiter-${++nextWait}`;
          const waiter = { waiterId, remainingMs: 14900,
            result: () => rpc("collectDownloadWait", id, { waiterId }, async () => {
              if (!available || generation !== originalGeneration) throw Error("OBU_DOWNLOAD_WAIT_EXPIRED: old original waiter");
              return { downloadId: "unexpected" };
            }),
            cancel: () => rpc("cancelDownloadWait", id, { waiterId }, async () => { waits.delete(waiterId); return {}; }) };
          waits.set(waiterId, waiter); return waiter;
        }) };
    }
  };
  const bindingProof = { extensionId: "a".repeat(32), extensionInstanceId: "instance", workerBootId: "worker", portId: "port" };
  const bind = async () => {
    available = true; generation++;
    const snapshot = { records: [], overflow: false, captureComplete: true, acceptedConnections: 1, upstreamAttempts: 1, reconnects: 0, attemptCount: 1, errors: [], upstream: { closeObserved: false }, downstream: { closeObserved: false }, server: { closeObserved: false } };
    const relay = { snapshot: () => clone(snapshot), disconnect: async () => { cuts++; available = false; snapshot.upstream.closeObserved = snapshot.downstream.closeObserved = true; snapshot.faultInjection = { actualCloseObserved: { at: Date.now() } };
        if (mode === "business-click") { const p = [...pages.values()].at(-1); p.state.clicks.push({ trusted: false }); records.get(p.state.key).requests.push({ method: "POST", url: "/report" }); }
      }, close: async () => { available = false; snapshot.upstream.closeObserved = snapshot.downstream.closeObserved = snapshot.server.closeObserved = true; } };
    relays.push(relay); return { relay, binding: { result: { bound: true, generation: `generation-${generation}` } }, bindingProcess: { closeObserved: true, exitCode: 0 }, proof: clone(bindingProof) };
  };
  const until = async (check, label) => { const deadline = performance.now() + 1000; do { const value = await check(); if (value) return value; await tick(); } while (performance.now() < deadline); throw Error(`unit poll: ${label}`); };
  const connectionState = () => ({ hostPid: mode === "host-changed" && cuts ? 99 : 98, endpoint: "original-pipe", nativePortConnections: 1, nativeSocketReadyState: 1, hostExitCode: null });
  const detail = {};
  return { options: { owner, worker, fixture, fixtureURL: "http://127.0.0.1:1234/", until, bind, connectionState, detail }, detail, pages, relays, context, input, waits, available: () => available };
}

test("driver runs all four readiness boundaries, preserves original host, and exits unavailable with exact cleanup", async () => {
  const f = driverFixture(); const result = await checkRequiredDownloadReadiness(f.options);
  assert.equal(result, f.detail); assert.equal(result.passed, true); assert.equal(result.cases.length, 4); assert.equal(result.bindings.length, 4);
  assert.ok(result.cases.every(item => item.passed)); assert.ok(result.cleanup.every(item => item.ok)); assert.equal(f.pages.size, 0); assert.equal(f.waits.size, 0); assert.equal(f.available(), false);
  assert.deepEqual(f.input, []); assert.equal(f.context.__requiredDownloadProbe, undefined); assert.equal(f.context.__integrationNativeRPCObserver, undefined);
  const held = result.cases[2]; assert.equal(held.beforeRelease.ready, false); assertRequiredDownloadProbe(held.trace, { complete: true });
  const retired = result.cases[3]; assert.equal(retired.collects.length, 2); assert.equal(retired.freshCancelled, true);
});

for (const mode of ["false-ready", "business-click", "host-changed", "prewarm-failed"]) test(`driver fails ${mode}, preserves the failure and still closes exact resources`, async () => {
  const f = driverFixture(mode); let failure;
  try { await checkRequiredDownloadReadiness(f.options); } catch (error) { failure = error; }
  assert.ok(failure); assert.equal(failure.requiredDownloadReadinessDetail, f.detail); assert.equal(f.detail.passed, false);
  assert.equal(f.pages.size, 0); assert.equal(f.available(), false); assert.equal(f.context.__requiredDownloadProbe, undefined); assert.equal(f.context.__integrationNativeRPCObserver, undefined);
  assert.ok(f.relays.every(relay => relay.snapshot().server.closeObserved));
});

test("final RPC evidence rejects late duplicates, missing responses, extra requests and fabricated fresh ready", async () => {
  const f = driverFixture(), result = await checkRequiredDownloadReadiness(f.options), original = result.cases[3];
  assert.deepEqual(assertRequiredDownloadRPCs(original), { requests: 5, responses: 5, ready: 2 });
  for (const change of [
    x => { x.trace.records.push(clone(x.trace.records.find(row => row.kind === "response"))); },
    x => { x.trace.records.splice(x.trace.records.findIndex(row => row.kind === "response"), 1); },
    x => { x.trace.records.push(clone(x.trace.records.find(row => row.kind === "request"))); },
    x => { x.trace.records.find(row => row.kind === "response").requestId = "wrong-original"; },
    x => { x.trace.records.find(row => row.kind === "response").result.waiterId = "fabricated"; },
    x => { x.trace.records.filter(row => row.kind === "response" && row.ok).at(-2).result.remainingMs = 0; },
    x => { x.trace.records.find(row => row.kind === "request" && row.method === "cancelDownloadWait").waiterId = x.ready.waiterId; },
    x => { x.trace.records.find(row => row.kind === "response" && !row.ok).error += " late changed"; },
    x => { x.arms[1].ready = false; },
  ]) { const invalid = clone(original); change(invalid); assert.throws(() => assertRequiredDownloadRPCs(invalid)); }
});

test("zero-trigger oracle rejects changed documents, duplicate navigation, consumed tokens and POST", async () => {
  const f = driverFixture(); const result = await checkRequiredDownloadReadiness(f.options), original = result.cases[0];
  for (const change of [x => { x.after.documents[0].documentId = "replacement"; }, x => { x.after.documents[0].result.state.clicks.push({}); }, x => { x.after.documents[0].result.state.frameAdds.push({}); }]) {
    const item = clone(original); change(item); assert.throws(() => assertRequiredDownloadZero(item, item.server));
  }
  for (const change of [x => { x.consumed = true; }, x => { x.gets.push({}); }, x => { x.requests.push({ method: "POST", url: "/report" }); }]) {
    const server = clone(original.server); change(server); assert.throws(() => assertRequiredDownloadZero(original, server));
  }
});
