// Serialized only into an isolated staged worker. This observer never changes
// a storage argument or fabricates a native result. Its one gate holds producer
// Promise publication AFTER the original storage operation has fulfilled.
export function installAuxiliaryDeliveryGate(backend, chrome, target, options) {
  const { scope, tabIds, stage, gateTabId, holdTimeoutMs = 15000, maxRecords = 128, maxBytes = 262144 } = options ?? {};
  const apiKey = "__auxiliaryDeliveryGate", auxiliaryKey = "OPEN_BROWSER_USE_AUXILIARY_TABS", sessionKey = "OPEN_BROWSER_USE_SESSION_STATE";
  const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
  const identifier = value => typeof value === "string" && value.length > 0 && value.length <= 256;
  const auxiliary = backend?.auxiliaryTabs, incarnation = backend?.browserLifetime?.incarnation;
  if (!target || Object.hasOwn(target, apiKey) || !Object.isExtensible(target) ||
      !options || Object.keys(options).some(key => !["scope", "tabIds", "stage", "gateTabId", "holdTimeoutMs", "maxRecords", "maxBytes"].includes(key)) ||
      !scope || Object.keys(scope).some(key => !["session_id", "turn_id", "control_epoch"].includes(key)) ||
      !identifier(scope.session_id) || !identifier(scope.turn_id) || !integer(scope.control_epoch, 1, Number.MAX_SAFE_INTEGER) ||
      !Array.isArray(tabIds) || tabIds.length < 1 || tabIds.length > 16 || new Set(tabIds).size !== tabIds.length ||
      tabIds.some(id => !integer(id, 0, Number.MAX_SAFE_INTEGER)) || !["claim-delete", "marker-write"].includes(stage) ||
      (stage === "claim-delete" ? !tabIds.includes(gateTabId) : gateTabId !== undefined) ||
      !integer(holdTimeoutMs, 1, 30000) || !integer(maxRecords, 1, 2048) || !integer(maxBytes, 1, 4 * 1024 * 1024) ||
      !identifier(incarnation) || !auxiliary || typeof auxiliary.entry !== "function" || typeof auxiliary.state !== "function" ||
      !backend.auxiliaryDeliveries || !backend.endingSessions || !backend.controlLedger?.records)
    throw Error("Invalid auxiliary delivery gate installation");
  const originalScope = { ...scope }, ids = [...tabIds];
  const sameScope = record => record?.session_id === originalScope.session_id && record.turn_id === originalScope.turn_id &&
    record.control_epoch === originalScope.control_epoch;
  const claims = ids.map(tabId => {
    const claim = auxiliary.entry(tabId);
    if (!sameScope(claim) || claim.tabId !== tabId || !identifier(claim.claimId) || claim.phase !== "committed" ||
        !["popup", "created-page"].includes(claim.kind) || claim.origin !== "user" || !integer(claim.windowId, 0, Number.MAX_SAFE_INTEGER) ||
        auxiliary.owner(tabId) !== claim || !auxiliary.state(claim)?.persisted)
      throw Error("Auxiliary delivery gate requires exact committed original claims");
    return { tabId, claimId: claim.claimId, windowId: claim.windowId, kind: claim.kind, record: claim };
  });
  const ledger = backend.controlLedger.records.get(scope.session_id);
  if (!ledger || ledger.epoch !== scope.control_epoch || ledger.status !== "active" || backend.endingSessions.has(scope.session_id) ||
      claims.some(item => backend.auxiliaryDeliveries.has(item.tabId)) ||
      (stage === "claim-delete" && claims.find(item => item.tabId === gateTabId)?.kind !== "popup"))
    throw Error("Auxiliary delivery gate requires an active task before finalization");
  const patches = ["session", "local"].map(area => {
    const object = chrome?.storage?.[area], descriptor = object && Object.getOwnPropertyDescriptor(object, "set"), original = object?.set;
    if (typeof original !== "function" || descriptor && (!Object.hasOwn(descriptor, "value") || !descriptor.writable) ||
        !descriptor && !Object.isExtensible(object)) throw Error(`Cannot wrap original chrome.storage.${area}.set`);
    return { area, object, original, descriptor, api: `storage.${area}.set` };
  });
  const copy = value => JSON.parse(JSON.stringify(value));
  const errorValue = error => ({ name: String(error?.name ?? "Error").slice(0, 128), message: String(error?.message ?? error).slice(0, 1024) });
  const records = [], errors = [], pending = new Map(), encoder = new TextEncoder();
  let bytes = 0, overflow = false, closed = false, restored = false, apiRemoved = false, nextOperation = 0;
  let gate = null, timer, releaseGate, finalSnapshot;
  const problem = error => { if (errors.length < 16) errors.push(errorValue(error).message); };
  // Selection reads own data descriptors; arbitrary getters/toJSON from an
  // unrelated write are neither invoked nor copied into this task's evidence.
  const data = (object, key) => {
    if (!object || typeof object !== "object") return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (descriptor && !Object.hasOwn(descriptor, "value")) throw Error("Storage argument accessor was not read");
    return descriptor?.value;
  };
  const state = () => ({ sameIncarnation: backend.browserLifetime.incarnation === incarnation,
    ending: backend.endingSessions.has(originalScope.session_id), finalizing: backend.endingSessions.get(originalScope.session_id)?.finalizing === true,
    control: { epoch: ledger.epoch, status: ledger.status, sameRecord: backend.controlLedger.records.get(originalScope.session_id) === ledger },
    claims: claims.map(item => {
      const current = auxiliary.entry(item.tabId), proof = backend.auxiliaryDeliveries.get(item.tabId), marker = backend.store?.state?.deliverableTabs?.[item.tabId];
      return { tabId: item.tabId, claimId: item.claimId, present: current === item.record, replaced: Boolean(current && current !== item.record),
        phase: item.record.phase, removing: auxiliary.state(item.record)?.removing === true,
        proofPresent: proof?.record === item.record, released: proof?.released === true,
        markerId: proof?.record === item.record && marker === proof.marker && typeof marker?.deliveryId === "string" ? marker.deliveryId.slice(0, 128) : null };
    }) });
  const safeState = () => { try { return state(); } catch (error) { problem(error); return null; } };
  const emit = (kind, operationId, value = {}) => {
    if (closed || overflow) return null;
    try {
      const row = copy({ sequence: records.length + 1, kind, operationId, at: Date.now(), ...value });
      const size = encoder.encode(JSON.stringify(row)).byteLength;
      if (records.length >= maxRecords || bytes + size > maxBytes) { overflow = true; return null; }
      records.push(row); bytes += size; return row.sequence;
    } catch (error) { problem(error); return null; }
  };
  const proofIntact = item => {
    const proof = backend.auxiliaryDeliveries.get(item.tabId);
    return sameScope(item.record) && item.record.claimId === item.claimId && item.record.tabId === item.tabId &&
      item.record.windowId === item.windowId && proof?.record === item.record && proof.position.id === item.tabId;
  };
  const match = (area, args) => {
    if (args.length !== 1 || !args[0] || typeof args[0] !== "object" || Array.isArray(args[0]) ||
        backend.browserLifetime.incarnation !== incarnation || !backend.endingSessions.has(originalScope.session_id) || !claims.every(proofIntact)) return null;
    if (area === "session") {
      const value = data(args[0], auxiliaryKey), entries = data(value, "records");
      if (data(value, "version") !== 4 || data(value, "incarnation") !== incarnation || !Array.isArray(entries) || entries.length > 256) return null;
      const selected = new Map();
      for (let index = 0; index < entries.length; index++) {
        const entry = data(entries, String(index)), tabId = data(entry, "tabId"), claimId = data(entry, "claimId");
        if (!integer(tabId, 0, Number.MAX_SAFE_INTEGER) || !identifier(claimId)) return null;
        const item = claims.find(item => item.tabId === tabId || item.claimId === claimId);
        if (!item) continue;
        if (selected.has(item.tabId) || item.tabId !== tabId || item.claimId !== claimId ||
            data(entry, "session_id") !== originalScope.session_id || data(entry, "turn_id") !== originalScope.turn_id || data(entry, "control_epoch") !== originalScope.control_epoch ||
            data(entry, "phase") !== item.record.phase) return null;
        selected.set(tabId, { tabId, claimId, phase: data(entry, "phase") });
      }
      const removed = claims.filter(item => !selected.has(item.tabId) && auxiliary.entry(item.tabId) === item.record &&
        item.record.phase === "quarantined" && auxiliary.state(item.record)?.persisted && auxiliary.state(item.record)?.removing);
      if (!removed.length) return null;
      return { stage: "claim-delete", summary: { key: auxiliaryKey, version: 4, incarnation,
        omitted: removed.map(({ tabId, claimId }) => ({ tabId, claimId })), selectedRemaining: [...selected.values()] },
        eligible: removed.length === 1 && removed[0].tabId === gateTabId && claims.every(item => item.tabId === gateTabId ||
          selected.has(item.tabId) && auxiliary.entry(item.tabId) === item.record &&
          auxiliary.state(item.record)?.persisted && !auxiliary.state(item.record)?.removing) };
    }
    const value = data(args[0], sessionKey), markers = data(value, "deliverableTabs");
    if (data(value, "incarnation") !== incarnation || !markers || typeof markers !== "object" || Array.isArray(markers)) return null;
    const selected = [];
    for (const item of claims) {
      const proof = backend.auxiliaryDeliveries.get(item.tabId), marker = proof.marker, stored = data(markers, String(item.tabId));
      if (!proof.released || auxiliary.entry(item.tabId) !== undefined || !marker || !stored ||
          typeof marker.deliveryId !== "string" || !marker.deliveryId || marker.deliveryId.length > 128) return null;
      const captured = { tabId: item.tabId };
      for (const key of ["windowId", "groupId", "pinned", "deliveryId", "deliveredAt"]) {
        if (data(stored, key) !== data(marker, key)) return null;
        captured[key] = data(stored, key);
      }
      selected.push(captured);
    }
    return { stage: "marker-write", eligible: true, summary: { key: sessionKey, incarnation, markers: selected } };
  };
  const release = reason => {
    if (!gate || gate.released || gate.published) return false;
    gate.released = true; gate.releasedAt = Date.now(); gate.releaseReason = reason;
    clearTimeout(timer); timer = undefined;
    gate.releaseSequence = emit("released", gate.operationId, { reason });
    releaseGate?.(); releaseGate = undefined; return true;
  };
  for (const patch of patches) patch.wrapper = function (...args) {
    if (closed) return Reflect.apply(patch.original, this, args);
    let selection;
    try { selection = match(patch.area, args); } catch (error) { problem(error); }
    if (!selection) return Reflect.apply(patch.original, this, args);
    if (nextOperation >= maxRecords) { overflow = true; return Reflect.apply(patch.original, this, args); }
    const operationId = ++nextOperation, selectedGate = !gate && selection.stage === stage && selection.eligible;
    const operation = { operationId, api: patch.api, stage: selection.stage, selectedGate, nativePending: true, publicationPending: true };
    pending.set(operationId, operation);
    const callSequence = emit("call", operationId, { api: patch.api, stage: selection.stage, selectedGate, args: selection.summary, state: safeState() });
    if (selectedGate) gate = { operationId, stage, ...(gateTabId === undefined ? {} : { gateTabId }), callSequence,
      nativeSettled: false, held: false, released: false, published: false };
    let result;
    try { result = Reflect.apply(patch.original, this, args); }
    catch (error) {
      pending.delete(operationId);
      // The native error itself is forwarded by identity, not serialized. A
      // storage error may quote unrelated keys/values from the same write.
      const sequence = emit("native-threw", operationId, { error: { message: "Original storage.set threw synchronously" } });
      if (selectedGate) { gate.nativeSettled = true; gate.nativeAt = Date.now(); gate.nativeSequence = sequence;
        gate.rejected = true; gate.published = true; gate.publishedAt = Date.now(); }
      throw error;
    }
    try {
      return Promise.prototype.then.call(result, async value => {
        operation.nativePending = false;
        const nativeAt = Date.now(), nativeSequence = emit("native-fulfilled", operationId);
        if (selectedGate) {
          gate.nativeSettled = true; gate.nativeAt = nativeAt; gate.nativeSequence = nativeSequence;
          if (!closed && !gate.released) {
            const publication = new Promise(resolve => { releaseGate = resolve; });
            gate.held = true; gate.heldAt = Date.now(); gate.heldSequence = emit("held", operationId, { nativeSequence });
            timer = setTimeout(() => { gate.timedOut = true; problem("Auxiliary delivery publication hold expired"); release("timeout"); }, holdTimeoutMs);
            await publication;
          }
          gate.held = false; gate.published = true; gate.publishedAt = Date.now();
          gate.publishedSequence = emit("published", operationId);
        } else emit("published", operationId);
        operation.publicationPending = false; pending.delete(operationId); return value;
      }, error => {
        operation.nativePending = false; operation.publicationPending = false; pending.delete(operationId);
        const sequence = emit("native-rejected", operationId, { error: { message: "Original storage.set rejected" } });
        if (selectedGate) { gate.nativeSettled = true; gate.nativeAt = Date.now(); gate.nativeSequence = sequence; gate.rejected = true; gate.published = true; gate.publishedAt = Date.now(); }
        throw error;
      });
    } catch (error) {
      pending.delete(operationId); problem("Original storage.set did not return an observable native Promise");
      emit("settlement-unobserved", operationId, { error: errorValue(error) }); return result;
    }
  };
  const liveSnapshot = () => ({ version: 1, scope: originalScope, tabIds: ids, claims: claims.map(({ record, ...item }) => item),
    incarnation, stage, ...(gateTabId === undefined ? {} : { gateTabId }), holdTimeoutMs, maxRecords, maxBytes,
    records, errors, bytes, overflow, gate, closed, restored, apiRemoved, pendingOperations: [...pending.values()], current: safeState(),
    boundary: "Staged-only exact original storage-call observer. Arguments and receiver are unchanged and native runs once. Held means native storage already fulfilled; only producer Promise publication is test-delayed. No native-pending claim, fabricated failure, rollback, focus change or persistent gate. A replaced worker has no gate. Stop before native/publication settlement records incomplete evidence." });
  const snapshot = () => copy(finalSnapshot ?? liveSnapshot());
  const installed = [];
  const restore = () => {
    let complete = true;
    for (const patch of installed.toReversed()) try {
      if (patch.object.set !== patch.wrapper) throw Error(`${patch.api} gate replaced before stop; restore in reverse order`);
      if (patch.descriptor) Object.defineProperty(patch.object, "set", patch.descriptor); else delete patch.object.set;
      if (patch.object.set !== patch.original) throw Error(`${patch.api} restoration failed`);
    } catch (error) { complete = false; problem(error); }
    return complete;
  };
  const api = {
    snapshot,
    release() { release("explicit"); return snapshot(); },
    stop() {
      if (closed) return snapshot();
      release("stop"); closed = true; restored = restore();
      try {
        if (Object.getOwnPropertyDescriptor(target, apiKey)?.value !== api) throw Error("Auxiliary delivery gate API replaced before stop");
        delete target[apiKey]; apiRemoved = !Object.hasOwn(target, apiKey);
        if (!apiRemoved) throw Error("Auxiliary delivery gate API removal failed");
      } catch (error) { problem(error); }
      if (pending.size) problem("Stopped before original storage/publication operations settled");
      finalSnapshot = copy(liveSnapshot()); return snapshot();
    }
  };
  try {
    for (const patch of patches) {
      Object.defineProperty(patch.object, "set", patch.descriptor ? { ...patch.descriptor, value: patch.wrapper } :
        { value: patch.wrapper, configurable: true, writable: true, enumerable: false });
      installed.push(patch);
    }
    Object.defineProperty(target, apiKey, { value: api, configurable: true, writable: false, enumerable: false });
  } catch (error) { closed = true; restore(); throw error; }
  return { installed: true, version: 1, scope: { ...originalScope }, tabIds: [...ids], stage,
    ...(gateTabId === undefined ? {} : { gateTabId }), incarnation, holdTimeoutMs, maxRecords, maxBytes };
}
