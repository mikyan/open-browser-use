// One independent agent-form attempt; this entry point never performs task actions.
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { runManagedSingleAttemptCheck } from "./managed-single-attempt-check.mjs";

export function parseManagedAgentFormArguments(args) {
  assert.equal(args.length, 4, "Usage: managed-agent-form-check.mjs --ready <absolute ready.json> --round <1|2>");
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    assert.ok(["--ready", "--round"].includes(args[index]) && !values.has(args[index]), "Unknown or repeated agent-form argument");
    values.set(args[index], args[index + 1]);
  }
  assert.ok(typeof values.get("--ready") === "string" && path.isAbsolute(values.get("--ready")), "Original absolute ready path required");
  assert.ok(["1", "2"].includes(values.get("--round")), "Select the original round 1 or 2");
  return { readyFile: path.resolve(values.get("--ready")), round: Number(values.get("--round")) };
}

export async function runManagedAgentFormCheck({ readyFile, round }) {
  return runManagedSingleAttemptCheck({ readyFile, kind: "agent-form", round });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const result = await runManagedAgentFormCheck(parseManagedAgentFormArguments(process.argv.slice(2))); process.exitCode = result.passed ? 0 : 1;
}
