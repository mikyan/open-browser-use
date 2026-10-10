import assert from "node:assert/strict";
import test from "node:test";
import { assertMemoryClipboardGuard, checkPythonClipboard, checkGoClipboard, checkCLIClipboard, checkMCPClipboard } from "./clipboard-callers.mjs";

const guard = { verified: true, mode: "chromium-headless-memory", version: "156.0.8078.4",
  revision: "f842f52ef39fd97b449eb27cff414bf05a98ddce", executableSha256: "7f08161bbeb2853ffe1780a9ded4985087f52efb9725d7d8207aabdd42f7cfb9" };
test("all clipboard callers reject absent or different memory proof before any subprocess or file read", async () => {
  const previous = process.env.OBU_TEST_MEMORY_CLIPBOARD;
  let launched = 0;
  const options = { runDir: "does-not-exist", memoryClipboardGuard: guard, subprocess: () => { launched++; }, withMCPClient: () => { launched++; } };
  try {
    delete process.env.OBU_TEST_MEMORY_CLIPBOARD;
    for (const check of [checkPythonClipboard, checkGoClipboard, checkCLIClipboard, checkMCPClipboard]) await assert.rejects(check(options), /explicit memory-clipboard/);
    process.env.OBU_TEST_MEMORY_CLIPBOARD = "1";
    for (const key of Object.keys(guard)) {
      const wrong = { ...guard, [key]: key === "verified" ? false : "another-build" };
      for (const check of [checkPythonClipboard, checkGoClipboard, checkCLIClipboard, checkMCPClipboard]) await assert.rejects(check({ ...options, memoryClipboardGuard: wrong }), /Unverified memory clipboard/);
    }
    assert.doesNotThrow(() => assertMemoryClipboardGuard(guard));
    assert.equal(launched, 0);
  } finally {
    if (previous === undefined) delete process.env.OBU_TEST_MEMORY_CLIPBOARD;
    else process.env.OBU_TEST_MEMORY_CLIPBOARD = previous;
  }
});
