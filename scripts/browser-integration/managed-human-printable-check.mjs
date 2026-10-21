import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { runManagedHumanFileChooserBaseline } from "./managed-human-file-chooser-check.mjs";

export function managedPrintableMode(value) {
  assert.ok(["baseline", "acceptance"].includes(value), "OBU_TEST_HUMAN_PRINTABLE_MODE must explicitly select baseline or acceptance");
  return value;
}

export async function runManagedHumanPrintableCheck() {
  return runManagedHumanFileChooserBaseline({ printableMode: managedPrintableMode(process.env.OBU_TEST_HUMAN_PRINTABLE_MODE) });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  assert.equal(process.argv.length, 2, "No retry or alternate business action");
  const report = await runManagedHumanPrintableCheck();
  // Baseline collection can complete while the feature has genuinely failed.
  // It never exits successfully or declares feature acceptance.
  process.exitCode = report.passed ? 0 : 1;
}
