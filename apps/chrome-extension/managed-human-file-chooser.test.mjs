import assert from "node:assert/strict";
import test from "node:test";
import { validateHumanFileRequest } from "./managed-human-file-chooser.js";

const tuple = { leaseId: "lease", generation: 1, chooserId: "chooser" };
test("private file chooser operations have exact claims and no path on Begin or Cancel", () => {
  for (const [operation, value] of [["begin", { ...tuple, transferId: "original" }],
    ["commit", { ...tuple, transferId: "original", files: ["C:\\private\\中文.txt", "/private/empty"] }],
    ["cancel", tuple], ["cancel", { ...tuple, transferId: "original" }]]) assert.equal(validateHumanFileRequest(value, operation), value);
  for (const value of [{ ...tuple, transferId: "id", files: [] }, { ...tuple, transferId: "id", tabId: 7 },
    { ...tuple, transferId: "id", source: { origin: "https://forged.test" } }])
    assert.throws(() => validateHumanFileRequest(value, "begin"), /FILE_INVALID/);
  assert.throws(() => validateHumanFileRequest({ ...tuple, files: ["C:\\private\\no.txt"] }, "cancel"), /FILE_INVALID/);
});
test("private commit rejects empty, relative, malformed, oversize, sparse and accessor file lists without invoking accessors", () => {
  let calls = 0;
  const getter = []; Object.defineProperty(getter, 0, { enumerable: true, get() { calls++; return "C:\\secret"; } });
  for (const files of [[], ["relative"], [""], ["C:\\bad\0.txt"], ["C:\\bad\ud800.txt"], Array(2), getter,
    Array(17).fill("C:\\too-many"), ["C:\\" + "a".repeat(32768)]])
    assert.throws(() => validateHumanFileRequest({ ...tuple, transferId: "id", files }, "commit"), /FILE_INVALID/);
  assert.equal(calls, 0);
});
test("foreign or undecided chooser metadata cannot manufacture a typed claim", () => {
  for (const changed of [{ generation: 0 }, { generation: 1.5 }, { leaseId: "" }, { chooserId: "bad\nid" }, { transferId: null }])
    assert.throws(() => validateHumanFileRequest({ ...tuple, transferId: "id", ...changed }, "begin"), /FILE_INVALID/);
  assert.throws(() => validateHumanFileRequest(Object.defineProperty({ ...tuple }, "transferId", {
    enumerable: true, get() { assert.fail("must not evaluate request getter"); }
  }), "begin"), /FILE_INVALID/);
});
