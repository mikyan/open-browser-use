import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { managedHumanSourceFiles } from "./managed-human-source-snapshot.mjs";

const run = promisify(execFile);
test("real Git selection freezes top-level build tests and dependency manifests with original acceptance inputs", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "obu-human-source-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await run("git", ["init", "--quiet"], { cwd: directory });
  const expected = ["cmd/host/main.go", "internal/runtime.go", "apps/chrome-extension/background.js",
    "packages/open-browser-use-js/src/index.ts", "packages/open-browser-use-go/client.go", "packages/open-browser-use-python/client.py",
    "scripts/browser-integration/check.mjs", "scripts/build-chrome-extension.mjs", "scripts/build-chrome-extension.test.mjs",
    "scripts/patch-test.mjs", "scripts/patch-test.test.mjs", "scripts/raw-pointer-feedback.test.mjs",
    "go.mod", "go.sum", "package.json", "pnpm-lock.yaml"];
  for (const file of [...expected, "docs/unrelated.md", "scripts/unrelated.mjs", "scripts/nested/outside.test.mjs", ".gitignore"]) {
    await fs.mkdir(path.dirname(path.join(directory, file)), { recursive: true });
    await fs.writeFile(path.join(directory, file), file === ".gitignore" ? "scripts/ignored.test.mjs\n" : "fixture\n");
  }
  await run("git", ["add", "--", "package.json", "scripts/build-chrome-extension.test.mjs", "apps/chrome-extension/background.js"], { cwd: directory });
  await fs.writeFile(path.join(directory, "scripts/ignored.test.mjs"), "ignored\n");
  const launch = (command, args, options) => ({ completed: run(command, args, { cwd: directory, timeout: options.timeoutMs })
    .then(({ stdout }) => ({ code: 0, stdout })) });
  assert.deepEqual(await managedHumanSourceFiles("acceptance", launch), expected.sort());
  assert.deepEqual(await managedHumanSourceFiles("diagnostic", launch), ["packages/open-browser-use-js/src/index.ts", "scripts/browser-integration/check.mjs"]);
});

test("source selection refuses failed Git output and invalid modes", async () => {
  await assert.rejects(managedHumanSourceFiles("acceptance", () => ({ completed: Promise.resolve({ code: 1, stdout: "package.json\n" }) })));
  let launched = false;
  await assert.rejects(managedHumanSourceFiles("unknown", () => { launched = true; }));
  assert.equal(launched, false);
});
