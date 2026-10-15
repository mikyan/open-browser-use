import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const entry = path.join(repository, "scripts", "browser-integration", "run.mjs");
const environment = { ...process.env };
for (const key of Object.keys(environment)) if (key.startsWith("OBU_TEST_")) delete environment[key];

for (const [name, settings, message] of [
  ["invalid enable value", { OBU_TEST_COLD_NAVIGATION: "0" }, "OBU_TEST_COLD_NAVIGATION must be 1 when set"],
  ["unrelated case selection", { OBU_TEST_COLD_NAVIGATION: "1", OBU_TEST_CASES: "^js-navigation$" }, "Cold navigation is a separate two-case mode"],
  ["another cold diagnostic", { OBU_TEST_COLD_NAVIGATION: "1", OBU_TEST_COLD_ROOT_REBUILD: "1" }, "Cold navigation cannot be combined with another diagnostic mode"]
]) test(`cold navigation rejects ${name} before starting a browser`, { timeout: 20000 }, () => {
  const result = spawnSync(process.execPath, [entry], {
    cwd: repository, env: { ...environment, ...settings },
    encoding: "utf8", windowsHide: true, timeout: 15000
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.equal(result.signal, null);
  assert.ok(result.stderr.includes(message), result.stderr);
  assert.equal(/HARNESS |RESULT /.test(result.stdout), false);
});
