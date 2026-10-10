// Match the pinned Playwright runner's field-trial testing-config baseline.
// This changes only the isolated test process; browser-default reproduces the
// browser binary's original testing-config behavior. Neither policy overrides
// individual rendering, visibility, or occlusion features.
export function resolveFieldTrialConfig(value) {
  if (value === undefined) return "disabled";
  if (value === "disabled" || value === "browser-default") return value;
  throw new Error("OBU_TEST_FIELD_TRIAL_CONFIG must be disabled or browser-default");
}

export function browserStartupOptions(args, fieldTrialConfig) {
  const policy = resolveFieldTrialConfig(fieldTrialConfig);
  return Object.freeze({
    fieldTrialConfig: policy,
    args: Object.freeze([
      ...(policy === "disabled" ? ["--disable-field-trial-config"] : []),
      ...args
    ]),
    windowsHide: true
  });
}
