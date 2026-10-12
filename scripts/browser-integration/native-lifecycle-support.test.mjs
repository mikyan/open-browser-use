import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { allNativeLifecycleCasesPassed, assertFixtureExtensionInventory, assertNativeProcessIdentity, clickCleanupPopup, nativeIdleDurationMs, nativeLifecycleCases, nativeLifecycleOutcome, resolveNativeLifecycleMode, resolveNativeCleanupScenario, selectCleanupPopupWindow } from "./native-lifecycle-support.mjs";

const executable = "C:\\fixture\\native-host.exe", browserPid = 100;
const processes = [
  { ProcessId: 100, ParentProcessId: 1, ExecutablePath: "C:\\browser\\chrome.exe", CreationDate: "today" },
  { ProcessId: 101, ParentProcessId: 100, ExecutablePath: "C:\\Windows\\cmd.exe", CreationDate: "today" },
  { ProcessId: 102, ParentProcessId: 101, ExecutablePath: executable, CreationDate: "today" }
];
test("native process identity accepts direct and launcher-child ancestry", () => {
  assert.deepEqual(assertNativeProcessIdentity({ pid: 102 }, processes, { executable, browserPid }).ancestry.map(value => value.ProcessId), [102, 101, 100]);
  assert.equal(assertNativeProcessIdentity({ pid: 102 }, [{ ...processes[2], ParentProcessId: 100 }, processes[0]], { executable, browserPid }).ancestry.length, 2);
});
test("native process identity rejects missing, reused, foreign and cyclic PIDs", () => {
  for (const list of [processes.slice(0, 2), processes.map(value => value.ProcessId === 102 ? { ...value, ExecutablePath: "C:\\other.exe" } : value), processes.map(value => value.ProcessId === 101 ? { ...value, ParentProcessId: 999 } : value), processes.map(value => value.ProcessId === 101 ? { ...value, ParentProcessId: 102 } : value)]) {
    assert.throws(() => assertNativeProcessIdentity({ pid: 102 }, list, { executable, browserPid }));
  }
});
test("native lifecycle acceptance requires exactly all three unique passing cases", () => {
  const records = nativeLifecycleCases.map(name => ({ name, passed: true }));
  assert.equal(allNativeLifecycleCasesPassed(records), true);
  for (const record of records) {
    assert.equal(allNativeLifecycleCasesPassed(records.filter(value => value !== record)), false);
    assert.equal(allNativeLifecycleCasesPassed(records.map(value => value === record ? { ...value, passed: false } : value)), false);
  }
  assert.equal(allNativeLifecycleCasesPassed([...records, records[0]]), false);
});
test("native mode defaults to acceptance and rejects unknown or empty values", () => {
  assert.equal(resolveNativeLifecycleMode(), "acceptance");
  assert.equal(resolveNativeLifecycleMode("idle-diagnostic"), "idle-diagnostic");
  for (const value of ["", "idle", "all", null]) assert.throws(() => resolveNativeLifecycleMode(value), /Unknown OBU_TEST_NATIVE_MODE/);
});
test("idle diagnostic completion retains failed focus without claiming lifecycle acceptance", () => {
  const report = {
    mode: "idle-diagnostic", records: [], focus: { observationComplete: true, finalValidation: "failed" },
    diagnostic: { observationComplete: true, originalHostUnchanged: true, durationMs: nativeIdleDurationMs, startedAt: 100, observedThrough: 10100 },
    registrationCleanup: { removed: true }, nativeCleanup: {}, browserProcessesGone: {},
    finalExtensionInventory: { passed: true }, extensionInventories: [{ passed: true }]
  };
  assert.deepEqual(nativeLifecycleOutcome(report), { passed: false, diagnosticComplete: true, exitCode: 0 });
  for (const patch of [
    { error: "setup failed" }, { browserCleanupError: "still live" }, { nativeCleanupError: "host live" },
    { registrationCleanup: { removed: false } }, { extensionInventories: [{ passed: false }] },
    { focus: { observationComplete: false } }, { records: [{ name: "native-host-exit", passed: true }] },
    ...[{ observationComplete: false }, { originalHostUnchanged: false }, { observedThrough: 10099 }].map(value => ({ diagnostic: { ...report.diagnostic, ...value } }))
  ]) assert.deepEqual(nativeLifecycleOutcome({ ...report, ...patch }), { passed: false, diagnosticComplete: false, exitCode: 1 });
  const acceptance = { ...report, mode: "acceptance", records: nativeLifecycleCases.map(name => ({ name, passed: true })), focus: { finalValidation: "passed" } };
  assert.deepEqual(nativeLifecycleOutcome(acceptance), { passed: true, exitCode: 0 });
  assert.deepEqual(nativeLifecycleOutcome({ ...acceptance, focus: { finalValidation: "failed" } }), { passed: false, exitCode: 1 });
  assert.deepEqual(nativeLifecycleOutcome({ ...acceptance, records: [] }), { passed: false, exitCode: 1 });
});
test("profile isolation inventories all states and only explicitly marked components are exempt", () => {
  const fixtures = [{ id: "fixture", location: "UNPACKED", state: "ENABLED" }, { id: "observer", location: "UNPACKED", state: "ENABLED" }];
  assert.equal(assertFixtureExtensionInventory(fixtures, ["fixture", "observer"]).fixture.length, 2);
  assert.equal(assertFixtureExtensionInventory([...fixtures, { id: "built-in", location: "COMPONENT" }], ["fixture", "observer"]).components.length, 1);
  for (const state of ["ENABLED", "DISABLED", "TERMINATED", "BLOCKLISTED"]) assert.throws(() => assertFixtureExtensionInventory([...fixtures, { id: "foreign", location: "FROM_STORE", state }], ["fixture", "observer"]), /OBU_TEST_PROFILE_NOT_ISOLATED/);
  assert.throws(() => assertFixtureExtensionInventory(fixtures.slice(0, 1), ["fixture", "observer"]), /OBU_TEST_PROFILE_NOT_ISOLATED/);
  assert.throws(() => assertFixtureExtensionInventory([...fixtures, fixtures[0]], ["fixture", "observer"]), /duplicate/);
  assert.deepEqual(assertFixtureExtensionInventory([], []), { fixture: [], components: [] });
});

test("created-page native loss requires its exact scene, cleanup and unchanged focus gate", () => {
  assert.equal(resolveNativeLifecycleMode("created-page-host-loss"), "created-page-host-loss");
  const report = { mode: "created-page-host-loss", records: [{ name: "native-created-page-host-loss", passed: true }],
    focus: { finalValidation: "passed" }, registrationCleanup: { removed: true }, nativeCleanup: {},
    browserProcessesGone: {}, finalExtensionInventory: { passed: true }, extensionInventories: [{ passed: true }] };
  assert.deepEqual(nativeLifecycleOutcome(report), { passed: true, exitCode: 0 });
  for (const patch of [{ records: [] }, { records: [...report.records, ...report.records] },
    { records: nativeLifecycleCases.map(name => ({ name, passed: true })) },
    { records: [{ name: "native-created-page-host-loss", passed: false, detail: { lifecycleVerified: true } }] },
    { focus: { finalValidation: "failed" } }, { registrationCleanup: { removed: false } },
    { nativeCleanupError: "still running" }, { browserProcessCleanupError: "still running" }])
    assert.deepEqual(nativeLifecycleOutcome({ ...report, ...patch }), { passed: false, exitCode: 1 });
});

test("native cleanup selectors require one exact scenario and cannot leak into other modes", () => {
  for (const change of ["source-navigation", "child-close"]) for (const recovery of ["session-bootstrap", "retry-pause"]) {
    assert.deepEqual(resolveNativeCleanupScenario("created-page-cleanup", change, recovery),
      { change, recovery, name: `native-created-page-cleanup-${change}-${recovery}` });
  }
  for (const invalid of [undefined, null, "", "all", "source-navigation,child-close"]) {
    assert.throws(() => resolveNativeCleanupScenario("created-page-cleanup", invalid, "retry-pause"), /OBU_TEST_NATIVE_CHANGE/);
    assert.throws(() => resolveNativeCleanupScenario("created-page-cleanup", "child-close", invalid), /OBU_TEST_NATIVE_RECOVERY/);
  }
  for (const mode of ["acceptance", "idle-diagnostic", "created-page-host-loss"]) {
    assert.equal(resolveNativeCleanupScenario(mode), null);
    assert.throws(() => resolveNativeCleanupScenario(mode, "child-close", "retry-pause"), /requires created-page-cleanup/);
    assert.throws(() => resolveNativeCleanupScenario(mode, undefined, "retry-pause"), /requires created-page-cleanup/);
  }
});

test("native cleanup evidence never converts failed focus or partial lifecycle into acceptance", () => {
  for (const change of ["source-navigation", "child-close"]) for (const recovery of ["session-bootstrap", "retry-pause"]) {
    const cleanupScenario = resolveNativeCleanupScenario("created-page-cleanup", change, recovery);
    const record = { name: cleanupScenario.name, passed: true, detail: { change, recovery, recoveryVerified: true } };
    const report = { mode: "created-page-cleanup", cleanupScenario, records: [record], focus: { finalValidation: "passed" },
      registrationCleanup: { removed: true }, nativeCleanup: {}, browserProcessesGone: {},
      finalExtensionInventory: { passed: true }, extensionInventories: [{ passed: true }] };
    assert.deepEqual(nativeLifecycleOutcome(report), { passed: true, exitCode: 0 });
    for (const patch of [{ records: [] }, { records: [record, record] }, { records: [{ ...record, name: "native-created-page-host-loss" }] },
      { records: [{ ...record, passed: false }] }, { records: [{ ...record, detail: { ...record.detail, recoveryVerified: false } }] },
      { records: [{ ...record, detail: { ...record.detail, change: "other" } }] }, { records: [{ ...record, detail: { ...record.detail, recovery: "other" } }] },
      { focus: { finalValidation: "failed" } }, { registrationCleanup: { removed: false } }, { nativeCleanupError: "live" }])
      assert.deepEqual(nativeLifecycleOutcome({ ...report, ...patch }), { passed: false, exitCode: 1 });
  }
});

test("cleanup popup selects only an already focused exact fixture window", () => {
  const windows = [{ id: 7, type: "normal", focused: false }, { id: 8, type: "normal", focused: true }];
  const expected = { sentinelWindowId: 7, sourceWindowId: 8 }, before = structuredClone(windows);
  assert.equal(selectCleanupPopupWindow(windows, expected), 8); assert.deepEqual(windows, before);
  assert.equal(selectCleanupPopupWindow(windows.map(window => ({ ...window, focused: window.id === 7 })), expected), 7);
  for (const values of [[], windows.map(window => ({ ...window, focused: false })), windows.map(window => ({ ...window, focused: true })),
    [{ id: 9, type: "normal", focused: true }], [{ id: 8, type: "popup", focused: true }]])
    assert.throws(() => selectCleanupPopupWindow(values, expected));
});

// These execute the same serialized browser function, with a controlled native
// lookup boundary. They establish script guards, not a real Chrome popup run.
function cleanupPopupFixture({ action = "pause", label = "Pause all agents" } = {}) {
  const original = { contextType: "POPUP", contextId: "original-context", documentId: "original-document",
    documentUrl: "chrome-extension://fixture/popup.html", tabId: -1 };
  const expected = { action, label, expiresAt: 2000 };
  let resolve, reject;
  const lookup = new Promise((yes, no) => { resolve = yes; reject = no; });
  const state = { now: 1000, reads: 0, clicks: 0, button: { textContent: label, disabled: false,
    dataset: { action }, click() { state.clicks++; } } };
  const document = { URL: original.documentUrl, querySelector(selector) {
    assert.equal(selector, "#automation-toggle"); return state.button;
  } };
  const context = vm.createContext({ document, Date: { now: () => state.now }, chrome: { runtime: {
    getContexts(options) { assert.deepEqual(JSON.parse(JSON.stringify(options)), { contextTypes: ["POPUP"] }); state.reads++; return lookup; }
  } } });
  const run = (click = expected, originalContext = original) => vm.runInContext(
    `(${clickCleanupPopup.toString()})(${JSON.stringify(click)},${JSON.stringify(originalContext)})`, context);
  return { original, expected, state, context, document, run, reject, resolve: (value = [original]) => resolve(value) };
}

test("serialized cleanup popup click uses only the unique original context and current button", async () => {
  for (const [action, label] of [["pause", "Pause all agents"], ["pause", "Retry pause"], ["resume", "Resume control"]]) {
    const fixture = cleanupPopupFixture({ action, label }), pending = fixture.run();
    assert.equal(fixture.state.reads, 1); assert.equal(fixture.state.clicks, 0);
    fixture.resolve();
    assert.deepEqual(JSON.parse(JSON.stringify(await pending)), { clickedAt: 1000, action, label, context: fixture.original });
    assert.equal(fixture.state.clicks, 1);
  }
});

test("serialized cleanup popup click rejects replacement document or context before mutation", async () => {
  for (const field of ["contextType", "contextId", "documentId", "documentUrl", "tabId"]) {
    const fixture = cleanupPopupFixture(), pending = fixture.run();
    fixture.resolve([{ ...fixture.original, [field]: field === "tabId" ? 5 : "replacement" }]);
    await assert.rejects(pending, /Original cleanup popup context changed/); assert.equal(fixture.state.clicks, 0);
  }
});

test("serialized cleanup popup click rejects missing, ambiguous or invalid live contexts", async () => {
  for (const kind of ["missing", "duplicate", "null", "nonarray"]) {
    const fixture = cleanupPopupFixture(), pending = fixture.run();
    fixture.resolve({ missing: [], duplicate: [fixture.original, fixture.original], null: null, nonarray: {} }[kind]);
    await assert.rejects(pending, /Original cleanup popup context changed/); assert.equal(fixture.state.clicks, 0);
  }
});

test("serialized cleanup popup click keeps the original absolute deadline across native lookup", async () => {
  for (const now of [2000, 2001]) {
    const fixture = cleanupPopupFixture(), pending = fixture.run();
    fixture.state.now = now; fixture.resolve();
    await assert.rejects(pending, /deadline expired/); assert.equal(fixture.state.clicks, 0);
  }
  const fixture = cleanupPopupFixture(); fixture.state.now = 2000;
  await assert.rejects(fixture.run(), /deadline expired/); assert.equal(fixture.state.reads, 0); assert.equal(fixture.state.clicks, 0);
});

test("serialized cleanup popup click rereads button state after asynchronous context lookup", async () => {
  const mutations = [
    fixture => { fixture.state.button = null; },
    fixture => { fixture.state.button.disabled = true; },
    fixture => { fixture.state.button.textContent = "Resume control"; },
    fixture => { fixture.state.button.dataset.action = "resume"; }
  ];
  for (const mutate of mutations) {
    const fixture = cleanupPopupFixture(), pending = fixture.run(); mutate(fixture); fixture.resolve();
    await assert.rejects(pending, /button changed/); assert.equal(fixture.state.clicks, 0);
  }
});

test("serialized cleanup popup click rejects a different evaluation document after native lookup", async () => {
  for (const replaceDocument of [false, true]) {
    const fixture = cleanupPopupFixture(), pending = fixture.run();
    if (replaceDocument) fixture.context.document = { ...fixture.document };
    else fixture.document.URL = "chrome-extension://fixture/other.html";
    fixture.resolve(); await assert.rejects(pending, /document changed/); assert.equal(fixture.state.clicks, 0);
  }
});

test("serialized cleanup popup click preserves lookup failures and rejects malformed expectations", async () => {
  const fixture = cleanupPopupFixture(), failure = Error("native context lookup failed"), pending = fixture.run();
  fixture.reject(failure); await assert.rejects(pending, error => error === failure); assert.equal(fixture.state.clicks, 0);
  for (const patch of [{ action: "retry" }, { label: "Resume control" }, { expiresAt: null }]) {
    const invalid = cleanupPopupFixture();
    await assert.rejects(invalid.run({ ...invalid.expected, ...patch }), /Invalid cleanup popup click expectation/);
    assert.equal(invalid.state.reads, 0); assert.equal(invalid.state.clicks, 0);
  }
  const invalid = cleanupPopupFixture();
  await assert.rejects(invalid.run(invalid.expected, { ...invalid.original, documentId: "" }), /Invalid original cleanup popup context/);
  assert.equal(invalid.state.reads, 0); assert.equal(invalid.state.clicks, 0);
});
