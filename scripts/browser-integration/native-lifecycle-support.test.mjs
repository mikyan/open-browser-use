import assert from "node:assert/strict";
import test from "node:test";
import { allNativeLifecycleCasesPassed, assertFixtureExtensionInventory, assertNativeProcessIdentity, nativeLifecycleCases } from "./native-lifecycle-support.mjs";

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
test("profile isolation inventories all states and only explicitly marked components are exempt", () => {
  const fixtures = [{ id: "fixture", location: "UNPACKED", state: "ENABLED" }, { id: "observer", location: "UNPACKED", state: "ENABLED" }];
  assert.equal(assertFixtureExtensionInventory(fixtures, ["fixture", "observer"]).fixture.length, 2);
  assert.equal(assertFixtureExtensionInventory([...fixtures, { id: "built-in", location: "COMPONENT" }], ["fixture", "observer"]).components.length, 1);
  for (const state of ["ENABLED", "DISABLED", "TERMINATED", "BLOCKLISTED"]) assert.throws(() => assertFixtureExtensionInventory([...fixtures, { id: "foreign", location: "FROM_STORE", state }], ["fixture", "observer"]), /OBU_TEST_PROFILE_NOT_ISOLATED/);
  assert.throws(() => assertFixtureExtensionInventory(fixtures.slice(0, 1), ["fixture", "observer"]), /OBU_TEST_PROFILE_NOT_ISOLATED/);
  assert.throws(() => assertFixtureExtensionInventory([...fixtures, fixtures[0]], ["fixture", "observer"]), /duplicate/);
  assert.deepEqual(assertFixtureExtensionInventory([], []), { fixture: [], components: [] });
});
