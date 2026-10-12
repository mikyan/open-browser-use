// Serialized only into an isolated test worker after its original native child
// has matched. This deliberately changes one class of storage API arguments;
// it is a targeted native quota rejection, not a spontaneous storage failure.
// All nonmatching calls and every returned native Promise remain unchanged.
export function installCreatedPageCleanupFault(backend, chrome, target, options) {
  const { waiterId, childId, claimId, testKey, maxAttempts = 32, maxRecords = 128, maxBytes = 262144 } = options ?? {};
  const key = "OPEN_BROWSER_USE_AUXILIARY_TABS", apiKey = "__createdPageCleanupFault";
  const waits = backend?.pageWaits, auxiliary = backend?.auxiliaryTabs, storage = chrome?.storage?.session;
  const record = waits?.records?.get(waiterId), claim = auxiliary?.entry(childId);
  const incarnation = backend?.browserLifetime?.incarnation, quotaBytes = storage?.QUOTA_BYTES;
  const identifier = value => typeof value === "string" && value.length > 0 && value.length <= 256;
  const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
  if (!target || Object.hasOwn(target, apiKey) || !Object.isExtensible(target) ||
      !identifier(waiterId) || !integer(childId, 0, Number.MAX_SAFE_INTEGER) || !identifier(claimId) ||
      typeof testKey !== "string" || !/^__OBU_TEST_CLEANUP_QUOTA_[A-Za-z0-9_-]{8,100}$/.test(testKey) ||
      !record || record.state !== "matched" || record.invalid || record.delivered || record.result?.tabId !== childId ||
      !claim || claim.claimId !== claimId || claim.kind !== "created-page" || claim.origin !== "user" || claim.phase !== "committed" ||
      record.pageAdmission !== claim || !identifier(record.params?.session_id) || !identifier(record.params?.turn_id) ||
      !integer(record.params?.tabId, 0, Number.MAX_SAFE_INTEGER) || !integer(record.params?.control_epoch, 1, Number.MAX_SAFE_INTEGER) ||
      claim.session_id !== record.params.session_id || claim.turn_id !== record.params.turn_id || claim.control_epoch !== record.params.control_epoch ||
      typeof auxiliary.state !== "function" || !auxiliary.state(claim)?.persisted || !identifier(incarnation) ||
      !integer(quotaBytes, 1, 16 * 1024 * 1024) || !integer(maxAttempts, 1, 256) ||
      !integer(maxRecords, 1, 2048) || !integer(maxBytes, 1, 4 * 1024 * 1024))
    throw Error("Invalid created-page cleanup fault installation");
  const descriptor = Object.getOwnPropertyDescriptor(storage, "set");
  if (descriptor && (!Object.hasOwn(descriptor, "value") || !descriptor.writable) ||
      !descriptor && !Object.isExtensible(storage)) throw Error("Cannot wrap original chrome.storage.session.set");
  const original = storage.set;
  if (typeof original !== "function") throw Error("Cannot wrap original chrome.storage.session.set");
  const scope = { session_id: record.params.session_id, turn_id: record.params.turn_id,
    control_epoch: record.params.control_epoch, tabId: record.params.tabId };
  const originalDeadline = record.deadlineAt, paddingBytes = quotaBytes + 1024;
  let padding = "q".repeat(paddingBytes), enabled = true, closed = false, restored = false, apiRemoved = false;
  let attempts = 0, injectedAttempts = 0, pendingCount = 0, bytes = 0, overflow = false, finalSnapshot;
  const records = [], errors = [], pending = new Set(), encoder = new TextEncoder();
  const copy = value => JSON.parse(JSON.stringify(value));
  const errorValue = error => ({ name: String(error?.name ?? "Error").slice(0, 128), message: String(error?.message ?? error).slice(0, 1024) });
  const problem = error => { if (errors.length < 16) errors.push(errorValue(error).message); };
  const sameScope = () => record.params?.session_id === scope.session_id && record.params?.turn_id === scope.turn_id &&
    record.params?.control_epoch === scope.control_epoch && record.params?.tabId === scope.tabId &&
    claim.session_id === scope.session_id && claim.turn_id === scope.turn_id && claim.control_epoch === scope.control_epoch &&
    claim.tabId === childId && claim.claimId === claimId && record.pageAdmission === claim && record.deadlineAt === originalDeadline;
  const state = () => {
    const currentRecord = waits.records.get(waiterId), currentClaim = auxiliary.entry(childId);
    const sameIncarnation = backend.browserLifetime.incarnation === incarnation, scopeIntact = sameScope();
    return { state: record.state, invalid: Boolean(record.invalid), delivered: Boolean(record.delivered),
      cleanupAttempts: record.cleanupAttempts ?? 0, cleanupSettled: Boolean(record.cleanupSettled), cleaned: Boolean(record.cleaned),
      cleanupError: record.cleanupError ? errorValue(record.cleanupError).message : null,
      deadlineAt: record.deadlineAt, remainingMs: record.deadlineAt - waits.now(),
      recordPresent: currentRecord === record, recordReplaced: Boolean(currentRecord && currentRecord !== record),
      claimPresent: currentClaim === claim, claimReplaced: Boolean(currentClaim && currentClaim !== claim),
      claimPhase: claim.phase, reverseLocked: waits.byTab.get(scope.tabId) === record,
      removing: Boolean(auxiliary.state(claim)?.removing), sameIncarnation, scopeIntact,
      noReplacement: (!currentRecord || currentRecord === record) && (!currentClaim || currentClaim === claim) && sameIncarnation && scopeIntact };
  };
  const safeState = () => { try { return state(); } catch (error) { problem(error); return null; } };
  const emit = (kind, attemptId, extra = {}) => {
    if (closed || overflow) return;
    try {
      const row = copy({ sequence: records.length + 1, kind, attemptId, at: Date.now(), ...extra, state: state() });
      const size = encoder.encode(JSON.stringify(row)).byteLength;
      if (records.length >= maxRecords || bytes + size > maxBytes) { overflow = true; return; }
      records.push(row); bytes += size;
    } catch (error) { problem(error); }
  };
  // Never invoke argument getters or toJSON while identifying a native write.
  const data = (object, name) => {
    const value = Object.getOwnPropertyDescriptor(object, name);
    if (value && !Object.hasOwn(value, "value")) throw Error("Storage argument accessor cannot be inspected");
    return value?.value;
  };
  const deletion = args => {
    if (args.length !== 1 || !args[0] || typeof args[0] !== "object" || Array.isArray(args[0])) return null;
    const value = data(args[0], key);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const current = state();
    if (!current.noReplacement || !current.recordPresent || !current.claimPresent || !current.invalid || current.delivered ||
        current.claimPhase !== "quarantined" || !current.removing || !auxiliary.state(claim).persisted) return null;
    if (data(value, "version") !== 4 || data(value, "incarnation") !== incarnation) return null;
    const values = data(value, "records");
    if (!Array.isArray(values) || values.length > 256) return null;
    const remaining = [];
    for (let index = 0; index < values.length; index++) {
      const item = data(values, String(index));
      if (!item || typeof item !== "object" || Array.isArray(item)) return null;
      const id = data(item, "tabId"), identity = data(item, "claimId");
      if (!integer(id, 0, Number.MAX_SAFE_INTEGER) || !identifier(identity)) return null;
      if (id === childId || identity === claimId) return null;
      remaining.push({ tabId: id, claimId: identity });
    }
    const descriptors = Object.getOwnPropertyDescriptors(args[0]), keys = Object.keys(descriptors).filter(name => descriptors[name].enumerable);
    if (keys.length > 32 || keys.some(name => name.length > 256)) throw Error("Storage argument keys exceed evidence bounds");
    if (Object.hasOwn(descriptors, testKey)) throw Error("Quota test key already exists in original write");
    if (keys.some(name => !Object.hasOwn(descriptors[name], "value"))) throw Error("Storage argument accessor cannot be copied");
    return { descriptors, summary: { keys, version: 4, incarnation, recordCount: values.length, remaining,
      omittedChildId: childId, omittedClaimId: claimId, paddingKey: testKey, paddingBytes } };
  };
  const wrapper = function (...args) {
    if (closed) return Reflect.apply(original, this, args);
    let match;
    try { match = deletion(args); } catch (error) { problem(error); }
    if (!match) return Reflect.apply(original, this, args);
    const injected = enabled;
    let callArgs = args;
    if (injected) {
      try {
        const value = Object.create(Object.getPrototypeOf(args[0]), match.descriptors);
        Object.defineProperty(value, testKey, { value: padding, enumerable: true, configurable: true, writable: true });
        callArgs = [value];
      } catch (error) { problem(error); return Reflect.apply(original, this, args); }
    }
    const attemptId = ++attempts, tracked = attemptId <= maxAttempts;
    if (injected) injectedAttempts++;
    // Evidence limits must never silently remove the active fault. Later calls
    // still reach native quota validation, with overflow invalidating evidence.
    if (!tracked) overflow = true;
    pendingCount++; if (tracked) pending.add(attemptId);
    emit("call", attemptId, { injected, args: { ...match.summary, paddingBytes: injected ? paddingBytes : 0 } });
    const finish = (kind, error) => {
      if (closed) return;
      pendingCount--; pending.delete(attemptId);
      emit(kind, attemptId, { injected, ...(error === undefined ? {} : { error: errorValue(error) }) });
      if (injected && kind === "fulfilled") problem("Injected oversized storage.set unexpectedly fulfilled");
    };
    let result;
    try { result = Reflect.apply(original, this, callArgs); }
    catch (error) { finish("threw", error); throw error; }
    try { Promise.prototype.then.call(result, () => finish("fulfilled"), error => finish("rejected", error)); }
    catch (error) { finish("settlement-unobserved", error); problem("Original storage.set did not return an observable native Promise"); }
    return result;
  };
  const liveSnapshot = () => ({ version: 1, waiterId, childId, claimId, scope, incarnation, testKey, quotaBytes, paddingBytes,
    enabled, closed, restored, apiRemoved, attempts, injectedAttempts, pendingCount, pendingAttempts: [...pending], records, errors,
    overflow, bytes, maxAttempts, maxRecords, maxBytes, current: safeState(),
    boundary: "Private real-worker API argument fault injection. Matching logical claim deletion uses a native storage.session.set with an oversized test key. Native rejection must be verified externally; unit tests do not establish a real Chrome failure. No input, adoption, deadline or original claim replacement. Stop before settlement retains incomplete evidence." });
  const snapshot = () => copy(finalSnapshot ?? liveSnapshot());
  const api = {
    snapshot,
    disable() { enabled = false; return snapshot(); },
    stop() {
      if (closed) return snapshot();
      enabled = false; closed = true;
      try {
        if (storage.set !== wrapper) throw Error("Storage fault wrapper replaced before stop; restore wrappers in reverse order");
        if (descriptor) Object.defineProperty(storage, "set", descriptor); else delete storage.set;
        if (storage.set !== original) throw Error("Original storage.set restoration failed");
        restored = true;
      } catch (error) { problem(error); }
      try {
        if (Object.getOwnPropertyDescriptor(target, apiKey)?.value !== api) throw Error("Cleanup fault API replaced before stop");
        delete target[apiKey];
        if (Object.hasOwn(target, apiKey)) throw Error("Cleanup fault API removal failed");
        apiRemoved = true;
      } catch (error) { problem(error); }
      if (pendingCount) problem(`Stopped before ${pendingCount} original storage call(s) settled`);
      padding = null;
      finalSnapshot = copy(liveSnapshot()); return snapshot();
    },
  };
  try {
    Object.defineProperty(storage, "set", descriptor ? { ...descriptor, value: wrapper } :
      { value: wrapper, configurable: true, writable: true, enumerable: false });
    Object.defineProperty(target, apiKey, { value: api, configurable: true, writable: false, enumerable: false });
  } catch (error) {
    if (storage.set === wrapper) { if (descriptor) Object.defineProperty(storage, "set", descriptor); else delete storage.set; }
    throw error;
  }
  return { installed: true, waiterId, childId, claimId, testKey, quotaBytes, paddingBytes, scope: { ...scope }, maxAttempts, maxRecords, maxBytes };
}
