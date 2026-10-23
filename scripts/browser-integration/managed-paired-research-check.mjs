// Preserve the original paired-research entry point and argument protocol.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseManagedPairedResearchArguments } from "./managed-paired-research-support.mjs";
import { runManagedSingleAttemptCheck } from "./managed-single-attempt-check.mjs";

export async function runManagedPairedResearchCheck({ readyFile, round }) {
  return runManagedSingleAttemptCheck({ readyFile, kind: "paired-research", round });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const result = await runManagedPairedResearchCheck(parseManagedPairedResearchArguments(process.argv.slice(2))); process.exitCode = result.passed ? 0 : 1;
}
