import assert from "node:assert/strict";

// Acceptance freezes both the built inputs and the independently executed
// harness/SDKs. Build-manifest byte comparisons remain the callers' authority.
export async function managedHumanSourceFiles(mode, launch) {
  assert.ok(["acceptance", "diagnostic"].includes(mode));
  const selectedPaths = mode === "acceptance" ? [
    "cmd", "internal", "apps/chrome-extension", "packages/open-browser-use-js", "packages/open-browser-use-go",
    "packages/open-browser-use-python", "scripts/browser-integration", "scripts/build-chrome-extension.mjs",
    ":(glob)scripts/patch-*.mjs", ":(glob)scripts/*.test.mjs", "go.mod", "go.sum", "package.json", "pnpm-lock.yaml"
  ] : ["packages/open-browser-use-js", "scripts/browser-integration"];
  const selected = await launch("git", ["ls-files", "--cached", "--others", "--exclude-standard", "--", ...selectedPaths], { timeoutMs: 15000 }).completed;
  assert.equal(selected.code, 0);
  return [...new Set(selected.stdout.trim().split(/\r?\n/).filter(Boolean))].sort();
}
