import assert from "node:assert/strict";
import test from "node:test";
import { vivaldiTaskReadinessEnabled, waitForVivaldiTaskCommit, taskReadinessDiagnosticResult } from "./vivaldi-task-readiness-diagnostic.mjs";
import { nativeBrowserInstallationPassed } from "./native-browser-installation.mjs";

const tab = () => ({ id: 44, windowId: 3, active: false, url: "about:blank", status: "complete", width: 0, height: 0, groupId: -1 });
const target = () => ({ id: "native-target-1", tabId: 44, type: "page", url: "about:blank", attached: false });
function fixture(overrides = {}) {
  let time = 1000; const record = {}, calls = [];
  const options = { tabId: 44, windowId: 3, record, now: () => time, sleep: async ms => { time += ms; }, persist: async () => {},
    readTab: async budget => { calls.push(["tabs.get", budget.remaining()]); return tab(); },
    readTargets: async budget => { calls.push(["debugger.getTargets", budget.remaining()]); return [target()]; }, ...overrides };
  return { options, record, calls, advance: ms => time += ms };
}

test("task gate is an exclusive actual-Vivaldi opt-in, leaving all other modes disabled by default", () => {
  for (const value of [undefined, "", "0"]) assert.equal(vivaldiTaskReadinessEnabled(value, { name: "opera", input: true }), false);
  assert.equal(vivaldiTaskReadinessEnabled("1", { name: "vivaldi" }), true);
  for (const value of ["true", "2", 1, null]) assert.throws(() => vivaldiTaskReadinessEnabled(value, { name: "vivaldi" }));
  for (const change of [{ name: "brave" }, { input: true }, { readiness: true }, { nativeDiagnostics: true }, { ownership: true }]) assert.throws(() => vivaldiTaskReadinessEnabled("1", { name: "vivaldi", ...change }));
});

test("only existing native metadata is read before first committed blank document, without a geometry condition", async () => {
  const f = fixture(); let reads = 0;
  f.options.readTab = async budget => { f.calls.push(["tabs.get", budget.remaining()]); return ++reads === 1 ? { ...tab(), url: "", pendingUrl: "about:blank", status: "loading" } : tab(); };
  const result = await waitForVivaldiTaskCommit(f.options);
  assert.equal(result, f.record); assert.equal(result.ready, true); assert.equal(result.targetId, "native-target-1");
  assert.equal(result.deadline - result.requestedAt, 5000); assert.equal(result.samples.length, 2);
  assert.equal(result.lastSample.tab.width, 0); assert.equal(result.lastSample.tab.height, 0);
  assert.deepEqual(f.calls, [["tabs.get", 5000], ["debugger.getTargets", 5000], ["tabs.get", 4925], ["debugger.getTargets", 4925]]);
  assert.equal(result.lastSample.tabReadAt <= result.lastSample.targetsRequestedAt, true);
});

test("missing target may first appear later and binds by exact numeric tab ID, never by matching URL alone", async () => {
  const f = fixture(); let count = 0;
  f.options.readTargets = async () => ++count === 1 ? [{ ...target(), tabId: 99 }] : [target(), { ...target(), id: "other", tabId: 99 }];
  await waitForVivaldiTaskCommit(f.options);
  assert.equal(f.record.samples[0].matchingTargetCount, 0); assert.equal(f.record.samples[1].matchingTargetCount, 1);
  assert.equal(f.record.targetId, "native-target-1");
});

test("bound target disappearance, replacement, attachment and ambiguous targets fail without target switching", async () => {
  for (const second of [[], [{ ...target(), id: "replacement" }], [{ ...target(), attached: true }], [target(), { ...target(), id: "duplicate" }]]) {
    const f = fixture(); let count = 0;
    f.options.readTab = async () => ({ ...tab(), status: "loading" });
    f.options.readTargets = async () => ++count === 1 ? [target()] : second;
    await assert.rejects(waitForVivaldiTaskCommit(f.options));
    assert.equal(count, 2); assert.equal(f.record.targetId, "native-target-1"); assert.equal(f.record.ready, false);
  }
});

test("exact native tab/window/inactive/URL and target-type identity violations terminate immediately", async () => {
  for (const change of [{ id: 55 }, { windowId: 7 }, { active: true }, { url: "https://other.example/" }, { pendingUrl: "https://other.example/" }, { status: "unknown" }]) {
    const f = fixture({ readTab: async () => ({ ...tab(), ...change }) });
    await assert.rejects(waitForVivaldiTaskCommit(f.options));
    assert.equal(f.record.sampleCount, 1); assert.equal(f.calls.length, 0);
  }
  for (const change of [{ type: "iframe" }, { url: "https://other.example/" }, { attached: true }]) {
    const f = fixture({ readTargets: async () => [{ ...target(), ...change }] });
    await assert.rejects(waitForVivaldiTaskCommit(f.options)); assert.equal(f.record.sampleCount, 1);
  }
});

test("first metadata read failure is retained and never retried or followed by another read", async () => {
  const error = new Error("native tabs.get failed"), f = fixture({ readTab: async () => { throw error; } });
  await assert.rejects(waitForVivaldiTaskCommit(f.options), value => value === error);
  assert.equal(f.calls.length, 0); assert.equal(f.record.sampleCount, 1); assert.match(f.record.firstSample.error, /native tabs.get failed/);
});

test("successful incomplete states consume one absolute budget and do not invoke the caller goto", async () => {
  const f = fixture({ timeoutMs: 150, readTab: async () => ({ ...tab(), status: "loading" }) }); let goto = 0;
  await assert.rejects((async () => { await waitForVivaldiTaskCommit(f.options); goto++; })(), /absolute deadline expired/);
  assert.equal(goto, 0); assert.equal(f.record.ready, false); assert.equal(f.record.sampleCount, 2);
  assert.equal(f.record.deadline - f.record.requestedAt, 150);
});

test("late metadata settlement cannot start the next read or caller goto", async () => {
  let finish, goto = 0; const f = fixture({ timeoutMs: 15, readTab: () => new Promise(resolve => { finish = resolve; }) });
  await assert.rejects((async () => { await waitForVivaldiTaskCommit(f.options); goto++; })(), /absolute deadline expired/);
  finish(tab()); await new Promise(resolve => setImmediate(resolve));
  assert.equal(goto, 0); assert.equal(f.calls.length, 0); assert.equal(f.record.ready, false);
});

test("late final persistence is inside the absolute gate budget and cannot authorize goto", async () => {
  let finish, saves = 0, goto = 0;
  const f = fixture({ timeoutMs: 15, persist: () => ++saves === 2 ? new Promise(resolve => { finish = resolve; }) : Promise.resolve() });
  await assert.rejects((async () => { await waitForVivaldiTaskCommit(f.options); goto++; })(), /absolute deadline expired/);
  finish(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(goto, 0); assert.equal(f.record.ready, false); assert.equal(f.record.stage, "failed"); assert.equal(saves, 2);
});

test("an indefinitely pending initial evidence write times out without retrying it or blocking caller cleanup", async () => {
  let saves = 0, cleaned = false, goto = 0;
  const f = fixture({ timeoutMs: 15, persist: () => { saves++; return new Promise(() => {}); } });
  try { await assert.rejects((async () => { await waitForVivaldiTaskCommit(f.options); goto++; })(), /absolute deadline expired/); }
  finally { cleaned = true; }
  assert.equal(cleaned, true); assert.equal(saves, 1); assert.equal(goto, 0); assert.equal(f.calls.length, 0); assert.equal(f.record.stage, "failed");
});

test("bounded samples preserve first/last and overflow/truncated identities cannot become ready", async () => {
  const f = fixture({ maximumSamples: 1, readTab: async () => ({ ...tab(), status: "loading" }) });
  await assert.rejects(waitForVivaldiTaskCommit(f.options), /overflow/);
  assert.equal(f.record.samples.length, 1); assert.equal(f.record.firstSample.index, 1); assert.equal(f.record.lastSample.index, 2); assert.equal(f.record.overflow, true);
  const g = fixture({ readTargets: async () => [{ ...target(), title: "x".repeat(2001) }] });
  await assert.rejects(waitForVivaldiTaskCommit(g.options), /truncated/);
  assert.equal(g.record.lastSample.targets[0].title.length, 2000); assert.equal(g.record.payloadTruncated, true);
});

test("ready diagnostics remain nonacceptance and require the unchanged downstream input evidence", async () => {
  const f = fixture(); await waitForVivaldiTaskCommit(f.options);
  assert.deepEqual(taskReadinessDiagnosticResult({ gate: f.record, inputResult: { diagnosticCompleted: true } }), { passed: false, diagnosticCompleted: true, gateComplete: true, exitCode: 0 });
  assert.equal(taskReadinessDiagnosticResult({ gate: f.record, inputResult: { diagnosticCompleted: false } }).diagnosticCompleted, false);
  for (const change of [{ ready: false }, { overflow: true }, { persistenceFailures: 1 }, { completedAt: f.record.deadline }]) assert.equal(taskReadinessDiagnosticResult({ gate: { ...f.record, ...change }, inputResult: { diagnosticCompleted: true } }).diagnosticCompleted, false);
  assert.equal(nativeBrowserInstallationPassed({ mode: "vivaldi-task-readiness-diagnostic" }), false);
});
