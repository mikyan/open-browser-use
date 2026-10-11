import assert from "node:assert/strict";
import test from "node:test";
import { goChooserDiagnosticEnabled, goChooserDiagnosticCases, summarizeGoChooserDiagnostic } from "./go-chooser-diagnostic-mode.mjs";

test("Go chooser diagnostic is exclusive and cannot leak the child's JSONL switch", () => {
  assert.equal(goChooserDiagnosticEnabled({}), false);
  assert.equal(goChooserDiagnosticEnabled({ OBU_TEST_GO_CHOOSER_DIAGNOSTIC: "1" }), true);
  for (const value of ["", "0", "true"]) assert.throws(() => goChooserDiagnosticEnabled({ OBU_TEST_GO_CHOOSER_DIAGNOSTIC: value }));
  for (const name of ["OBU_TEST_CASES", "OBU_TEST_CHOOSER_DIAGNOSTIC", "OBU_TEST_DOWNLOAD_DIAGNOSTIC", "OBU_TEST_MCP_BINDING", "OBU_TEST_SNAPSHOT_GEOMETRY", "OBU_TEST_GEOMETRY_DPR", "OBU_TEST_BACKGROUND_PARALLEL", "OBU_TEST_MEMORY_CLIPBOARD"])
    assert.throws(() => goChooserDiagnosticEnabled({ OBU_TEST_GO_CHOOSER_DIAGNOSTIC: "1", [name]: "1" }));
  assert.throws(() => goChooserDiagnosticEnabled({ OBU_GO_CHOOSER_DIAGNOSTIC: "1" }));
});

test("complete diagnostic of a failed task is never task or acceptance success", () => {
  const records = goChooserDiagnosticCases.map(name => ({ name, passed: false }));
  const item = { key: "go-chooser-root", variant: "root", tabId: 7, passed: false };
  const native = { ...item, collectionComplete: true, failureRead: { complete: true } };
  const artifact = { callerResult: { variants: [item] }, childProcess: { protocolComplete: true }, diagnostic: { records: [native], errors: [] } };
  assert.equal(summarizeGoChooserDiagnostic(records, artifact).collectionComplete, true);
  assert.equal(summarizeGoChooserDiagnostic(records, artifact).originalTaskPassed, false);
  assert.equal(summarizeGoChooserDiagnostic(records, artifact).acceptancePassed, false);
  records[0].passed = true;
  assert.equal(summarizeGoChooserDiagnostic(records, artifact).originalTaskPassed, true);
  assert.equal(summarizeGoChooserDiagnostic(records, artifact).acceptancePassed, false);
  for (const invalid of [undefined, {}, { ...artifact, childProcess: { protocolComplete: false } },
    { ...artifact, readError: "missing artifact" }, { ...artifact, callerReadError: "stdout/file mismatch" },
    { ...artifact, callerResult: { variants: [item, { key: "go-chooser-oopif", variant: "oopif", passed: false }] } },
    { ...artifact, callerResult: { variants: [{ ...item, tabId: 99 }] } },
    { ...artifact, diagnostic: { records: [{ ...native, failureRead: null }], errors: [] } },
    { ...artifact, diagnostic: { records: [], errors: [] } },
    { ...artifact, diagnostic: { records: [{ collectionComplete: false }], errors: [] } },
    { ...artifact, diagnostic: { records: [{ collectionComplete: true }], errors: ["cleanup failed"] } }])
    assert.ok(!summarizeGoChooserDiagnostic(records, invalid).collectionComplete);
  for (const invalid of [records.slice(0, 1), [...records].reverse(), [...records, { name: "unexpected", passed: true }]])
    assert.equal(summarizeGoChooserDiagnostic(invalid, artifact).collectionComplete, false);
});
