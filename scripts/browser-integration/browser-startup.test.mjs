import assert from "node:assert/strict";
import test from "node:test";
import { browserStartupOptions, resolveFieldTrialConfig } from "./browser-startup.mjs";

const originalArgs = Object.freeze([
  "--user-data-dir=isolated-profile", "--remote-debugging-port=0",
  "--no-first-run", "--site-per-process", "about:blank"
]);

test("default test baseline adds only the field-trial testing-config switch", () => {
  const options = browserStartupOptions(originalArgs);
  assert.equal(resolveFieldTrialConfig(undefined), "disabled");
  assert.equal(options.fieldTrialConfig, "disabled");
  assert.equal(options.windowsHide, true);
  assert.deepEqual(options.args, ["--disable-field-trial-config", ...originalArgs]);
  assert.deepEqual(browserStartupOptions(originalArgs, "disabled"), options);
  assert.equal(originalArgs.length, 5);
  assert.ok(Object.isFrozen(options));
  assert.ok(Object.isFrozen(options.args));
});

test("browser-default reproduces original arguments without a feature override", () => {
  const options = browserStartupOptions(originalArgs, "browser-default");
  assert.equal(options.fieldTrialConfig, "browser-default");
  assert.equal(options.windowsHide, true);
  assert.deepEqual(options.args, originalArgs);
  assert.notEqual(options.args, originalArgs);
});

test("unknown or ambiguous environment values fail before a startup plan exists", () => {
  for (const value of ["", "DISABLED", " disabled", "disabled ", "default", "false", "0", null, false]) {
    assert.throws(() => resolveFieldTrialConfig(value), /OBU_TEST_FIELD_TRIAL_CONFIG/);
    assert.throws(() => browserStartupOptions(originalArgs, value), /OBU_TEST_FIELD_TRIAL_CONFIG/);
  }
});

test("headless guard arguments remain unchanged under both policies", () => {
  const headlessArgs = ["--headless=new", "--enable-automation", ...originalArgs];
  for (const policy of ["disabled", "browser-default"]) {
    const options = browserStartupOptions(headlessArgs, policy);
    assert.deepEqual(options.args.slice(policy === "disabled" ? 1 : 0), headlessArgs);
    assert.equal(options.args.filter(arg => arg === "--disable-field-trial-config").length, policy === "disabled" ? 1 : 0);
    assert.ok(!options.args.some(arg => /occlusion|--disable-features|--enable-features/.test(arg)));
  }
});
