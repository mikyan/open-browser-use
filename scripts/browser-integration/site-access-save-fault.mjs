// Private fixture only. Alter the matching native storage argument, preserving
// the original Promise and receiver; the browser must produce the quota error.
export function installSiteAccessSaveFault(chrome, target, { revision, testKey }) {
  const key = "OPEN_BROWSER_USE_SITE_ACCESS_POLICY", apiKey = "__siteAccessSaveFault";
  const storage = chrome.storage.local, original = storage.set;
  const descriptor = Object.getOwnPropertyDescriptor(storage, "set");
  const quota = storage.QUOTA_BYTES;
  if (!Number.isSafeInteger(revision) || revision < 1 ||
      !/^__OBU_TEST_SITE_QUOTA_[a-f0-9]{16}$/.test(testKey) ||
      !Number.isSafeInteger(quota) || quota < 1 || quota > 16 * 1024 * 1024 ||
      typeof original !== "function" || Object.hasOwn(target, apiKey) ||
      descriptor && (!Object.hasOwn(descriptor, "value") || !descriptor.writable))
    throw Error("Invalid website policy quota fixture");
  let enabled = true, closed = false, pending = 0, attempts = 0, overflow = false;
  let restored = false, apiRemoved = false, final;
  const rows = [], errors = [], padding = "q".repeat(quota + 1024);
  const copy = value => JSON.parse(JSON.stringify(value));
  const record = row => {
    if (rows.length >= 32) { overflow = true; return; }
    rows.push({ sequence: rows.length + 1, at: Date.now(), ...row });
  };
  const wrapper = function (...args) {
    const value = args.length === 1 && args[0] && Object.getOwnPropertyDescriptor(args[0], key)?.value;
    if (closed || !value || value.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < revision)
      return Reflect.apply(original, this, args);
    const descriptors = Object.getOwnPropertyDescriptors(args[0]);
    if (Object.hasOwn(descriptors, testKey) || Object.values(descriptors).some(item => !Object.hasOwn(item, "value")))
      throw Error("Unsafe quota fixture storage argument");
    const candidate = { version: value.version, revision: value.revision, mode: value.mode, origins: [...value.origins] };
    const injected = enabled && value.revision === revision;
    let callArgs = args;
    if (injected) {
      const next = Object.create(Object.getPrototypeOf(args[0]), descriptors);
      Object.defineProperty(next, testKey, { value: padding, enumerable: true });
      callArgs = [next];
    }
    const attempt = ++attempts;
    pending++;
    record({ kind: "call", attempt, injected, candidate, paddingBytes: injected ? padding.length : 0 });
    const finish = (kind, error) => {
      pending--;
      record({ kind, attempt, injected, ...(error ? { error: String(error.message ?? error).slice(0, 1024) } : {}) });
      if (injected && kind === "fulfilled") errors.push("Oversized native write unexpectedly succeeded");
    };
    let result;
    try { result = Reflect.apply(original, this, callArgs); }
    catch (error) { finish("threw", error); throw error; }
    Promise.prototype.then.call(result, () => finish("fulfilled"), error => finish("rejected", error));
    return result;
  };
  const snapshot = () => copy(final ?? { revision, testKey, quota, enabled, closed, pending, attempts, rows, errors,
    restored, apiRemoved, overflow, boundary: "Targeted private-profile native storage.local argument quota fault; no synthetic rejection or Promise replacement." });
  const api = {
    snapshot,
    disable() { enabled = false; return snapshot(); },
    stop() {
      if (closed) return snapshot();
      enabled = false;
      if (storage.set !== wrapper) throw Error("Website policy fault wrapper replaced");
      if (descriptor) Object.defineProperty(storage, "set", descriptor); else delete storage.set;
      restored = storage.set === original;
      if (target[apiKey] !== api) throw Error("Website policy fault API replaced");
      delete target[apiKey]; apiRemoved = !Object.hasOwn(target, apiKey);
      if (pending) errors.push("Stopped before native storage settled");
      closed = true; final = snapshot(); return snapshot();
    }
  };
  Object.defineProperty(storage, "set", descriptor ? { ...descriptor, value: wrapper } : { value: wrapper, configurable: true, writable: true });
  try { Object.defineProperty(target, apiKey, { value: api, configurable: true }); }
  catch (error) { if (descriptor) Object.defineProperty(storage, "set", descriptor); else delete storage.set; throw error; }
  return { revision, testKey, quota, installed: true };
}
