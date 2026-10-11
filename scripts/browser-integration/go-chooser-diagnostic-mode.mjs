import assert from "node:assert/strict";

export const goChooserDiagnosticCases = ["go-file-chooser-ready-two-connections", "js-raw-navigation-before-engine"];

export function goChooserDiagnosticEnabled(env) {
  const flag = env.OBU_TEST_GO_CHOOSER_DIAGNOSTIC;
  assert.ok(flag === undefined || flag === "1", "OBU_TEST_GO_CHOOSER_DIAGNOSTIC must be 1 or unset");
  // The child switch is private to the runner. It must never silently change a
  // normal caller's stdout protocol through the invoking shell's environment.
  assert.equal(env.OBU_GO_CHOOSER_DIAGNOSTIC, undefined, "Use OBU_TEST_GO_CHOOSER_DIAGNOSTIC instead of the private child switch");
  if (flag !== "1") return false;
  for (const name of ["OBU_TEST_CASES", "OBU_TEST_CHOOSER_DIAGNOSTIC", "OBU_TEST_DOWNLOAD_DIAGNOSTIC", "OBU_TEST_MCP_BINDING", "OBU_TEST_SNAPSHOT_GEOMETRY", "OBU_TEST_GEOMETRY_DPR", "OBU_TEST_BACKGROUND_PARALLEL", "OBU_TEST_MEMORY_CLIPBOARD"])
    assert.equal(env[name], undefined, `Go chooser diagnostic cannot be combined with ${name}`);
  return true;
}

export function summarizeGoChooserDiagnostic(records, artifact) {
  const selectionComplete = records.length === goChooserDiagnosticCases.length && records.every((record, index) => record.name === goChooserDiagnosticCases[index]);
  const diagnostic = artifact?.diagnostic;
  const variants = artifact?.callerResult?.variants ?? artifact?.variants;
  const variantCoverage = Array.isArray(variants) && variants.length > 0 && variants.length === diagnostic?.records?.length &&
    variants.every((item, index) => {
      const record = diagnostic.records[index];
      return item.key === record.key && item.variant === record.variant && item.tabId === record.tabId &&
        (item.passed === true || (item.passed === false && record.failureRead?.complete === true));
    });
  return {
    mode: "go-chooser-ready-diagnostic", acceptancePassed: false, selectionComplete, variantCoverage,
    originalTaskPassed: records.find(record => record.name === goChooserDiagnosticCases[0])?.passed ?? false,
    observationScope: "native-trace-and-browser-metadata", domObservation: "not-requested",
    collectionComplete: selectionComplete && variantCoverage && !artifact?.readError && !artifact?.callerReadError && artifact?.childProcess?.protocolComplete === true &&
      diagnostic?.records?.length > 0 && diagnostic.records.every(record => record.collectionComplete === true) &&
      diagnostic.errors?.length === 0,
    evidence: "chooser-go.json", readError: artifact?.readError
  };
}
