import assert from "node:assert/strict";
import test from "node:test";
import { allNativeLifecycleCasesPassed, assertFixtureExtensionInventory, assertNativeProcessIdentity, nativeIdleDurationMs, nativeLifecycleCases, nativeLifecycleOutcome, resolveNativeLifecycleMode } from "./native-lifecycle-support.mjs";

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
