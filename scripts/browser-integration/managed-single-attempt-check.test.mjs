import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";

test("fixed single-attempt runner and both task entry points import without starting a browser", async () => {
  const modules = await Promise.all([
    import("./managed-single-attempt-check.mjs"),
    import("./managed-paired-research-check.mjs"),
    import("./managed-agent-form-check.mjs"),
  ]);
  for (const [index, name] of ["runManagedSingleAttemptCheck", "runManagedPairedResearchCheck", "runManagedAgentFormCheck"].entries()) {
    assert.equal(typeof modules[index][name], "function");
  }
  await assert.rejects(modules[0].runManagedSingleAttemptCheck({ kind: "other" }), /fixed managed task kind/);
});

test("agent-form CLI selects an original ready and round without replay or alternate task options", async () => {
  const { parseManagedAgentFormArguments: parse } = await import("./managed-agent-form-check.mjs");
  const file = path.join(os.tmpdir(), "ready.json");
  for (const round of [1, 2]) assert.deepEqual(parse(["--ready", file, "--round", String(round)]), { readyFile: path.resolve(file), round });
  assert.deepEqual(parse(["--round", "2", "--ready", file]), { readyFile: path.resolve(file), round: 2 });
  for (const args of [[], ["--ready", file], ["--ready", file, "--ready", file], ["--ready", "relative.json", "--round", "1"],
    ["--ready", file, "--round", "3"], ["--ready", file, "--retry", "1"], ["--ready", file, "--task", "replacement"]]) assert.throws(() => parse(args));
});
