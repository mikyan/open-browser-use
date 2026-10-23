const MANAGED_HOST_PREFIX = "com.openbrowseruse.managed.n";

export function resolveManagedNativeHost(config, defaultHostName) {
  if (config === null) return defaultHostName;
  const keys = config && typeof config === "object" && !Array.isArray(config) ? Reflect.ownKeys(config) : [];
  const name = config?.nativeHostName;
  if (keys.length !== 2 || !keys.includes("version") || !keys.includes("nativeHostName") ||
      config.version !== 1 || typeof name !== "string" ||
      name.length !== MANAGED_HOST_PREFIX.length + 32 ||
      !/^com\.openbrowseruse\.managed\.n[0-9a-f]{32}$/.test(name)) {
    throw new Error("OBU_MANAGED_CONFIG_INVALID: expected version 1 and a private managed native host name");
  }
  return name;
}

// Offscreen documents lack runtime.getManifest. Their packaged configuration
// still identifies the exact worker entry, without accepting a sender's claim.
export function resolveManagedWorkerScript(config) {
  if (config === null) return "background.js";
  const nativeHost = resolveManagedNativeHost(config);
  return `managed-worker-${nativeHost.slice(MANAGED_HOST_PREFIX.length)}.js`;
}
