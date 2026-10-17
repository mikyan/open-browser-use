import assert from "node:assert/strict";
import test from "node:test";
import { observedProcessDescendants } from "./observed-process-descendants.mjs";

const row = (pid, parent, time) => ({ ProcessId: pid, ParentProcessId: parent, CreationDate: time, ExecutablePath: `synthetic-${pid}.exe` });

test("reused viewer PID does not inherit a two-day-old child or that child's new subtree", () => {
  const table = [
    row(1108, 500, "2026-10-17T10:00:00.1000000Z"),
    row(900, 1108, "2026-10-15T10:00:00.0000000Z"),
    row(901, 900, "2026-10-17T10:00:01.0000000Z"),
    row(1110, 1108, "2026-10-17T10:00:00.1000001Z"),
  ];
  assert.deepEqual(observedProcessDescendants(table, 1108).map(value => value.ProcessId), [1108, 1110]);
});

test("every descendant edge compares against its current parent, not only the root", () => {
  const table = [
    row(10, 1, "2026-10-17T10:00:00.1000000Z"),
    row(20, 10, "2026-10-17T10:00:00.1000002Z"),
    row(30, 20, "2026-10-17T10:00:00.1000001Z"),
    row(40, 30, "2026-10-17T10:00:01.0000000Z"),
    row(50, 20, "2026-10-17T10:00:00.1000003Z"),
  ];
  assert.equal(Date.parse(table[1].CreationDate), Date.parse(table[2].CreationDate), "Counterexample must share a millisecond");
  assert.deepEqual(observedProcessDescendants(table, 10), [table[0], table[1], table[4]]);
});

test("new children and equal-time descendants are observed independent of table order without changing original identities", () => {
  const table = [
    row(30, 20, "2026-10-17T10:00:00.1000001Z"),
    row(20, 10, "2026-10-17T10:00:00.1000000Z"),
    row(10, 1, "2026-10-17T10:00:00.1000000Z"),
    row(50, 999, "2026-10-17T10:00:01.0000000Z"),
  ];
  const before = structuredClone(table), actual = observedProcessDescendants(table, 10);
  assert.deepEqual(actual, table.slice(0, 3)); assert.equal(actual[0], table[0]); assert.deepEqual(table, before);
});

test("missing or ambiguous roots do not manufacture a tree from an orphan ParentProcessId", () => {
  const child = row(20, 10, "2026-10-17T10:00:01.0000000Z");
  assert.throws(() => observedProcessDescendants([child], 10), /root is missing/);
  const root = row(10, 1, "2026-10-17T10:00:00.0000000Z");
  assert.throws(() => observedProcessDescendants([root, { ...root }, child], 10), /Ambiguous.*root/);
  assert.throws(() => observedProcessDescendants([root, child, { ...child }], 10), /Ambiguous descendant/);
});

test("invalid relevant timestamps cannot be silently truncated or interpreted in a local timezone", () => {
  for (const value of [null, "2026-10-17T10:00:00.100Z", "2026-10-17T10:00:00.1000000+00:00", "2026-02-30T10:00:00.1000000Z", "2026-10-17T25:00:00.1000000Z"]) {
    assert.throws(() => observedProcessDescendants([row(10, 1, value)], 10), /CreationDate/);
    assert.throws(() => observedProcessDescendants([row(10, 1, "2026-10-17T10:00:00.0000000Z"), row(20, 10, value)], 10), /CreationDate/);
  }
  // System inventory rows unrelated to the original root are not evidence for it.
  const root = row(10, 1, "2026-10-17T10:00:00.0000000Z");
  assert.deepEqual(observedProcessDescendants([root, row(0, 0, null)], 10), [root]);
});
