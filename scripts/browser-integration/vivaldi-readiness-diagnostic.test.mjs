import assert from "node:assert/strict";
import test from "node:test";
import { openVivaldiReadinessPage, readinessBudget, vivaldiReadinessEnabled, vivaldiReadinessResult } from "./vivaldi-readiness-diagnostic.mjs";
import { nativeBrowserInstallationPassed, openNativeDiagnosticPage } from "./native-browser-installation.mjs";

const url = "chrome://extensions/";
const target = () => ({ id: "original", type: "page", url, webSocketDebuggerUrl: "ws://127.0.0.1:123/original", attached: false });
const tab = () => ({ id: 44, windowId: 3, active: false, url, status: "complete" });
function fixture(overrides = {}) {
  let time = 1000; const record = {}, calls = [];
  const page = { evaluate: async (_expression, options) => { calls.push(["evaluate", options.budget.remaining()]); return { url, title: "Extensions", readyState: "complete" }; } };
  const options = {
    url, purpose: "installation-manager", record, now: () => time,
    persist: async () => {}, sleep: async ms => { time += ms; },
    createTarget: async budget => {
      calls.push(["create", budget.remaining()]);
      return { targetId: "original", tabId: 44, windowId: 3, target: target(), readTab: async () => { calls.push(["tab", budget.remaining()]); return tab(); } };
    },
    targets: async budget => { calls.push(["targets", budget.remaining()]); return [target()]; },
    connect: async (_url, options) => { calls.push(["connect", options.budget.remaining()]); return page; },
    ...overrides,
  };
  return { options, record, calls, page, advance: ms => time += ms };
}

test("readiness is explicit, brand restricted and incompatible with API prelude diagnostics", () => {
  for (const value of [undefined, "", "0"]) assert.equal(vivaldiReadinessEnabled(value, { name: "opera", nativeDiagnostics: true }), false);
  assert.equal(vivaldiReadinessEnabled("1", { name: "vivaldi" }), true);
  for (const value of ["true", "2", " 1", 1, null]) assert.throws(() => vivaldiReadinessEnabled(value, { name: "vivaldi" }));
  assert.throws(() => vivaldiReadinessEnabled("1", { name: "brave" }));
  assert.throws(() => vivaldiReadinessEnabled("1", { name: "vivaldi", nativeDiagnostics: true }));
});

test("first target connection follows successful committed native state and original target identity", async () => {
  const f = fixture(); const create = f.options.createTarget; let reads = 0;
  f.options.createTarget = async budget => { const value = await create(budget); value.readTab = async () => { f.calls.push(["tab", budget.remaining()]); return ++reads === 1 ? { ...tab(), url: "", pendingUrl: url, status: "loading" } : tab(); }; return value; };
  const result = await openVivaldiReadinessPage(f.options);
  assert.equal(result.page, f.page); assert.equal(result.targetId, "original");
  assert.deepEqual(f.calls.map(([name]) => name), ["create", "tab", "targets", "tab", "targets", "connect", "evaluate"]);
  assert.equal(f.record.firstSample.tab.status, "loading"); assert.equal(f.record.lastSample.tab.status, "complete");
  assert.equal(f.record.connectionCount, 1); assert.equal(f.record.evaluationCount, 1);
  assert.equal(f.record.connection.requestedAt - f.record.requestedAt, 75);
  assert.equal(f.record.deadline, 26000); assert.equal(f.record.stage, "ready");
});

test("all phases consume the original deadline, including evidence persistence", async () => {
  const f = fixture(); const create = f.options.createTarget, list = f.options.targets, connect = f.options.connect;
  f.options.persist = async () => { f.advance(20); };
  f.options.createTarget = async budget => { f.advance(1000); const value = await create(budget); const read = value.readTab; value.readTab = async () => { f.advance(2000); return read(); }; return value; };
  f.options.targets = async budget => { f.advance(3000); return list(budget); };
  f.options.connect = async (...args) => { f.advance(4000); return connect(...args); };
  await openVivaldiReadinessPage(f.options);
  assert.deepEqual(f.calls, [["create", 23980], ["tab", 21980], ["targets", 18980], ["connect", 14960], ["evaluate", 14960]]);
  assert.equal(f.record.deadline, 26000);
});

test("native read failures are terminal and preserve the original error without attaching", async () => {
  const f = fixture(), error = new Error("tabs.get unavailable"), create = f.options.createTarget;
  f.options.createTarget = async budget => ({ ...await create(budget), readTab: async () => { throw error; } });
  await assert.rejects(openVivaldiReadinessPage(f.options), value => value === error);
  assert.deepEqual(f.calls.map(([name]) => name), ["create"]);
  assert.equal(f.record.sampleCount, 1); assert.match(f.record.firstSample.error, /tabs.get unavailable/);
});

test("exact tab/window/active/URL/target identity violations do not trigger a fallback connection", async () => {
  for (const mutation of [
    value => { value.tab.id++; }, value => { value.tab.windowId++; }, value => { value.tab.active = true; },
    value => { value.tab.url = "chrome://settings/"; }, value => { value.tab.pendingUrl = "chrome://settings/"; },
    value => { value.tab.status = "unknown"; }, value => { value.target.id = "replacement"; },
    value => { value.target.url = "chrome://settings/"; }, value => { value.target.type = "app"; },
    value => { value.target.webSocketDebuggerUrl += "other"; }, value => { value.target.attached = true; },
  ]) {
    const f = fixture(), create = f.options.createTarget, values = { tab: tab(), target: target() }; mutation(values);
    f.options.createTarget = async budget => ({ ...await create(budget), readTab: async () => values.tab });
    f.options.targets = async () => [values.target];
    await assert.rejects(openVivaldiReadinessPage(f.options));
    assert.equal(f.record.connectionCount, 0); assert.equal(f.record.evaluationCount, 0);
  }
});

test("successful incomplete reads reach the deadline without a connection or new creation", async () => {
  const f = fixture({ timeoutMs: 150 }), create = f.options.createTarget;
  f.options.createTarget = async budget => ({ ...await create(budget), readTab: async () => ({ ...tab(), status: "loading" }) });
  await assert.rejects(openVivaldiReadinessPage(f.options), /absolute deadline expired/);
  assert.equal(f.record.sampleCount, 2); assert.equal(f.record.connectionCount, 0);
  assert.equal(f.calls.filter(([name]) => name === "create").length, 1);
  assert.equal(f.record.lastSample.ready, false);
});

test("expired budget prevents invoking a new operation and late create cannot attach", async () => {
  let time = 0, invoked = 0;
  const budget = readinessBudget({ requestedAt: 0, timeoutMs: 10, now: () => time });
  time = 10;
  await assert.rejects(budget.run(() => { invoked++; }, "forbidden"), /absolute deadline expired/);
  assert.equal(invoked, 0);
  const f = fixture({ timeoutMs: 15 }); let resolveCreate;
  f.options.createTarget = () => new Promise(resolve => { resolveCreate = resolve; });
  await assert.rejects(openVivaldiReadinessPage(f.options), /absolute deadline expired/);
  resolveCreate({ targetId: "original", tabId: 44, windowId: 3, target: target(), readTab: async () => { invoked++; return tab(); } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(invoked, 0); assert.equal(f.record.connectionCount, 0); assert.equal(f.record.evaluationCount, 0);
});

test("timeout during connection cannot issue a late first evaluation", async () => {
  const f = fixture({ timeoutMs: 15 }); let resolveConnect;
  f.options.connect = () => new Promise(resolve => { resolveConnect = resolve; });
  await assert.rejects(openVivaldiReadinessPage(f.options), /absolute deadline expired/);
  resolveConnect(f.page); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.record.connectionCount, 1); assert.equal(f.record.evaluationCount, 0);
  assert.ok(!f.calls.some(([name]) => name === "evaluate"));
});

test("connection and first evaluation errors are terminal, including persistence failures", async () => {
  for (const phase of ["connect", "evaluate"]) {
    const f = fixture(), error = new Error(`${phase} original failure`);
    if (phase === "connect") f.options.connect = async () => { throw error; };
    else f.page.evaluate = async () => { throw error; };
    f.options.persist = async () => { if (f.record.error) throw new Error("saving failed"); };
    await assert.rejects(openVivaldiReadinessPage(f.options), value => value === error);
    assert.equal(f.record.connectionCount, 1); assert.equal(f.record.evaluationCount, phase === "connect" ? 0 : 1);
    assert.match(f.record.persistenceError, /saving failed/);
  }
});

test("bounded sampling retains first and last evidence but overflow/truncated identities fail closed", async () => {
  const f = fixture({ maximumSamples: 1 }), create = f.options.createTarget;
  f.options.createTarget = async budget => ({ ...await create(budget), readTab: async () => ({ ...tab(), status: "loading" }) });
  await assert.rejects(openVivaldiReadinessPage(f.options), /overflowed/);
  assert.equal(f.record.samples.length, 1); assert.equal(f.record.firstSample.index, 1); assert.equal(f.record.lastSample.index, 2);
  assert.equal(f.record.dropped, 1); assert.equal(f.record.connectionCount, 0);
  const g = fixture(); g.options.targets = async () => [{ ...target(), title: "x".repeat(2001) }];
  await assert.rejects(openVivaldiReadinessPage(g.options), /truncated/);
  assert.equal(g.record.lastSample.target.title.length, 2000); assert.equal(g.record.payloadTruncated, true);
});

test("successful readonly document polling shares budget and does not reconnect", async () => {
  const f = fixture(); let count = 0;
  f.page.evaluate = async (_expression, { budget }) => ({ url, title: "Extensions", readyState: ++count === 1 ? "interactive" : (assert.equal(budget.remaining(), 24925), "complete") });
  await openVivaldiReadinessPage(f.options);
  assert.equal(f.record.connectionCount, 1); assert.equal(f.record.evaluationCount, 2);
  assert.equal(f.record.firstEvaluation.value.readyState, "interactive");
});

test("new mode never passes acceptance and completion requires both bounded gates plus task/cleanup", async () => {
  const a = fixture(), b = fixture({ purpose: "focus-observer" }); await openVivaldiReadinessPage(a.options); await openVivaldiReadinessPage(b.options);
  const params = { pages: [a.record, b.record], taskReached: true, cleanupComplete: true };
  assert.deepEqual(vivaldiReadinessResult(params), { passed: false, diagnosticCompleted: true, observationsComplete: true, exitCode: 0 });
  for (const change of [{ taskReached: false }, { cleanupComplete: false }, { taskRequestsOverflow: true }, { pages: [a.record] }, { pages: [a.record, a.record] }, { pages: [a.record, { ...b.record, overflow: true }] }]) assert.equal(vivaldiReadinessResult({ ...params, ...change }).exitCode, 1);
  assert.equal(nativeBrowserInstallationPassed({ mode: "vivaldi-readiness-diagnostic" }), false);
});

test("failure-only bounded original-target snapshot retains the original evaluation error", async () => {
  for (const hangs of [false, true]) {
    const f = fixture({ diagnosticTimeoutMs: 5 }), error = new Error("original evaluation failure");
    f.page.evaluate = async () => { throw error; };
    let reads = 0;
    f.options.failureTargets = async () => { reads++; return hangs ? new Promise(() => {}) : [{ ...target(), url: "" }]; };
    await assert.rejects(openVivaldiReadinessPage(f.options), value => value === error);
    assert.equal(reads, 1); assert.equal(f.record.connectionCount, 1); assert.equal(f.record.evaluationCount, 1);
    assert.equal(f.record.failureDiagnostics.outsideSuccessBudget, true);
    if (hangs) assert.match(f.record.failureDiagnostics.error, /absolute deadline expired/);
    else assert.equal(f.record.failureDiagnostics.originalTarget.url, "");
  }
});

test("post-failure native metadata uses a separate short budget without touching the failed page", async () => {
  const f = fixture({ timeoutMs: 15 }), create = f.options.createTarget, readBudgets = [];
  f.options.createTarget = async budget => ({ ...await create(budget), readTab: async readBudget => { readBudgets.push(readBudget); readBudget.remaining(); return { ...tab(), frozen: false, discarded: false }; } });
  f.options.connect = () => new Promise(() => {});
  f.options.failureTargets = async () => [target()];
  await assert.rejects(openVivaldiReadinessPage(f.options), /absolute deadline expired/);
  assert.equal(readBudgets.length, 2); assert.notEqual(readBudgets[0], readBudgets[1]);
  assert.throws(readBudgets[0].remaining, /absolute deadline expired/);
  assert.equal(readBudgets[1].deadline - f.options.now(), 2500);
  assert.equal(f.record.failureDiagnostics.nativeTab.frozen, false);
  assert.equal(f.record.failureDiagnostics.nativeTab.id, 44);
  assert.equal(f.record.connectionCount, 1); assert.equal(f.record.evaluationCount, 0);
});

test("ordinary page opening keeps its original independent budgets and creates no native read gate", async () => {
  const calls = [], record = {}, page = { evaluate: async () => { calls.push("evaluate"); return { url, readyState: "complete" }; } };
  const result = await openNativeDiagnosticPage({ url, createTarget: async (...args) => { assert.equal(args.length, 0); calls.push("create"); return "original"; }, targets: async (...args) => { assert.equal(args.length, 0); calls.push("targets"); return [target()]; }, connect: async (...args) => { assert.equal(args.length, 1); calls.push("connect"); return page; }, record, persist: async () => {} });
  assert.equal(result.page, page); assert.deepEqual(calls, ["create", "targets", "connect", "evaluate"]);
  assert.equal(record.mode, undefined); assert.equal(record.deadline, undefined); assert.equal(record.samples, undefined);
});
