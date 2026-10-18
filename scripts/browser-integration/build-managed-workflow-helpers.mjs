// Build the two acceptance-only helpers and bind their bytes to exact sources.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runProcess } from "./normal-browser-downloads-support.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const go = process.env.OBU_TEST_GO_BINARY;
assert.ok(go && path.isAbsolute(go), "Set OBU_TEST_GO_BINARY");
await fs.mkdir(path.join(repo, ".tmp/browser-integration"), { recursive: true });
const directory = await fs.mkdtemp(path.join(repo, ".tmp/browser-integration/mwf-build-"));
const result = { directory, startedAt: Date.now(), commands: [], binaries: {}, passed: false };
const registry = new Set();
async function run(program, args) {
  const record = {}; result.commands.push(record);
  await runProcess(program, args, { cwd: repo, registry, record, timeoutMs: 180000, maximumBytes: 8 * 1024 * 1024 });
  return record.stdout;
}
async function inputs() {
  const files = (await run("git", ["ls-files", "--cached", "--others", "--exclude-standard", "--", "go.mod", "go.sum", "packages/open-browser-use-go", "scripts/browser-integration/windows-observation-probe", "scripts/browser-integration/go-managed-workflow-helper", "scripts/browser-integration/build-managed-workflow-helpers.mjs"])).trim().split(/\r?\n/);
  const entries = [];
  for (const file of [...new Set(files)]) entries.push([file, sha(await fs.readFile(path.join(repo, file)))]);
  return Object.fromEntries(entries);
}
try {
  result.before = await inputs(); result.go = { path: go, sha256: sha(await fs.readFile(go)), version: await run(go, ["version"]) };
  const packages = ["./scripts/browser-integration/windows-observation-probe", "./scripts/browser-integration/go-managed-workflow-helper", "./packages/open-browser-use-go"];
  await run(go, ["test", ...packages]); await run(go, ["vet", ...packages]);
  for (const [key, pkg] of [["observer", packages[0]], ["goWorkflow", packages[1]]]) {
    const file = path.join(directory, `${key}.exe`);
    await run(go, ["build", "-trimpath", "-o", file, pkg]);
    result.binaries[key] = { file, sha256: sha(await fs.readFile(file)), metadata: await run(go, ["version", "-m", file]) };
  }
  result.after = await inputs(); assert.deepEqual(result.before, result.after); assert.equal(registry.size, 0); result.passed = true;
} catch (error) { result.error = error.stack; }
finally {
  result.endedAt = Date.now(); result.liveChildren = [...registry].map(child => child.pid);
  await fs.writeFile(path.join(directory, "results.json"), JSON.stringify(result, null, 2), { flag: "wx" });
  console.log(JSON.stringify({ directory, passed: result.passed })); process.exitCode = result.passed ? 0 : 1;
}
