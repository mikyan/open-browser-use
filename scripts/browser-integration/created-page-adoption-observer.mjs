import assert from "node:assert/strict";

// Serialized into the isolated staged worker. These wrappers observe calls the
// product already makes. They never query Chrome, await a gate, replace a
// returned promise, or change a record. Promise reactions only retain evidence;
// their sequence is observation order, not atomic native-event/document proof.
export function installCreatedPageAdoptionObserver(backend, chrome, target = globalThis, options) {
  const { sessions, maxRecords = 4000, maxBytes = 4 * 1024 * 1024 } = options ?? {};
  const auxiliary = backend?.auxiliaryTabs;
  if (!target || target.__createdPageAdoption || !Array.isArray(sessions) || sessions.length < 1 || sessions.length > 128 ||
      sessions.some(value => typeof value !== "string" || !value || value.length > 4096) || new Set(sessions).size !== sessions.length ||
      !Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > 10000 ||
      !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 8 * 1024 * 1024 ||
      !auxiliary || typeof auxiliary.entry !== "function" || typeof auxiliary.owner !== "function")
    throw Error("Invalid created-page adoption observer installation");
  const patches = [
    [backend, "adoptCreatedPage"], [auxiliary, "reserve"], [auxiliary, "commit"],
    [chrome?.tabs, "get"], [chrome?.storage?.session, "set"],
  ].map(([object, name]) => {
    const descriptor = object && Object.getOwnPropertyDescriptor(object, name), original = object?.[name];
    if (typeof original !== "function" || descriptor && (!Object.hasOwn(descriptor, "value") || descriptor.writable === false))
      throw Error(`Cannot observe original ${name} method`);
    if (!descriptor && !Object.isExtensible(object)) throw Error(`Cannot install original ${name} observer`);
    return { object, name, original, descriptor };
  });
  const selected = new Set(sessions), records = [], errors = [], children = new Map(), pending = new Map();
  const encoder = new TextEncoder();
  let bytes = 0, overflow = false, closed = false, restored = false, nextOperation = 0, nextAdoption = 0;
  const copy = value => JSON.parse(JSON.stringify(value));
  const failure = value => { if (errors.length < 16) errors.push(String(value?.message ?? value).slice(0, 1024)); };
  const safely = operation => { try { return operation(); } catch (error) { failure(error); return undefined; } };
  const emit = (kind, value) => {
    if (closed || overflow) return;
    const row = copy({ sequence: records.length + 1, receivedAt: Date.now(), kind, ...value });
    const size = encoder.encode(JSON.stringify(row)).byteLength;
    if (records.length >= maxRecords || bytes + size > maxBytes) { overflow = true; return; }
    records.push(row); bytes += size;
  };
  const ownership = tabId => ({ entry: auxiliary.entry(tabId) ?? null, owner: auxiliary.owner(tabId) ?? null });
  const errorValue = error => ({ name: String(error?.name ?? "Error"), message: String(error?.message ?? error).slice(0, 1024) });
  const relevant = (value, childId = value?.tabId) => !closed && !overflow && selected.has(value?.session_id) && children.has(childId);
  const context = childId => ({ adoptionId: children.get(childId)?.adoptionId, childId });
  const settle = (promise, operationId, kind, metadata, fulfilled = result => ({ result: result ?? null })) => {
    if (closed) return;
    pending.set(operationId, { operationId, kind, ...metadata });
    try {
      // Returning this derived promise would alter the product's identity and
      // continuation. Only register observers; the caller receives `promise`.
      Promise.prototype.then.call(promise, result => {
        if (closed) return;
        pending.delete(operationId);
        safely(() => emit(`${kind}-fulfilled`, { operationId, ...metadata, ...fulfilled(result) }));
      }, error => {
        if (closed) return;
        pending.delete(operationId);
        safely(() => emit(`${kind}-rejected`, { operationId, ...metadata, error: errorValue(error) }));
      });
    } catch (error) { failure(error); }
  };
  const invoke = (patch, receiver, args, operationId, kind, metadata, fulfilled) => {
    let result;
    try { result = patch.original.apply(receiver, args); }
    catch (error) {
      safely(() => emit(`${kind}-threw`, { operationId, ...metadata, error: errorValue(error) }));
      throw error;
    }
    safely(() => settle(result, operationId, kind, metadata, fulfilled));
    return result;
  };
  const [adoptPatch, reservePatch, commitPatch, getPatch, storagePatch] = patches;
  adoptPatch.hook = function (...args) {
    const [scope, event, record] = args;
    if (closed || overflow || !selected.has(scope?.session_id)) return adoptPatch.original.apply(this, args);
    const operationId = ++nextOperation, adoptionId = ++nextAdoption, metadata = { adoptionId, childId: event?.tabId };
    safely(() => {
      if (!Number.isSafeInteger(event?.tabId) || event.tabId < 0 || children.has(event.tabId) || children.size >= 128)
        throw Error("Invalid, duplicate or excess observed native child adoption");
      children.set(event.tabId, { adoptionId, scope: copy(scope) });
      emit("adoption-enter", { operationId, ...metadata, scope, event,
        waiter: { waiterId: record?.waiterId, params: record?.params, state: record?.state, deadlineAt: record?.deadlineAt },
        source: ownership(scope.tabId), child: ownership(event.tabId) });
    });
    return invoke(adoptPatch, this, args, operationId, "adoption", metadata,
      result => ({ result: result ?? null, after: ownership(event.tabId) }));
  };
  reservePatch.hook = function (...args) {
    const params = args[0];
    if (!relevant(params)) return reservePatch.original.apply(this, args);
    const operationId = ++nextOperation, metadata = context(params.tabId);
    safely(() => emit("reserve-enter", { operationId, ...metadata, params, before: ownership(params.tabId) }));
    let result;
    try { result = reservePatch.original.apply(this, args); }
    catch (error) { safely(() => emit("reserve-threw", { operationId, ...metadata, error: errorValue(error) })); throw error; }
    safely(() => emit("reserve-return", { operationId, ...metadata, result, after: ownership(params.tabId) }));
    return result;
  };
  commitPatch.hook = function (...args) {
    const [record, options] = args;
    if (!relevant(record)) return commitPatch.original.apply(this, args);
    const operationId = ++nextOperation, metadata = context(record.tabId);
    safely(() => emit("commit-enter", { operationId, ...metadata, record,
      options: { windowId: options?.windowId, kind: options?.kind, control_epoch: options?.control_epoch,
        controlRevision: options?.controlRevision, check: typeof options?.check === "function", validate: typeof options?.validate === "function" },
      before: ownership(record.tabId) }));
    return invoke(commitPatch, this, args, operationId, "commit", metadata,
      result => ({ result: result ?? null, after: ownership(record.tabId) }));
  };
  getPatch.hook = function (...args) {
    const tabId = args[0];
    if (closed || overflow || !children.has(tabId)) return getPatch.original.apply(this, args);
    const operationId = ++nextOperation, metadata = { ...context(tabId), tabId };
    safely(() => emit("tabs-get-call", { operationId, ...metadata }));
    return invoke(getPatch, this, args, operationId, "tabs-get", metadata);
  };
  storagePatch.hook = function (...args) {
    const originalValue = args[0]?.OPEN_BROWSER_USE_AUXILIARY_TABS;
    let matching;
    safely(() => { if (!closed && !overflow && Array.isArray(originalValue?.records)) matching = originalValue.records.filter(value => relevant(value)); });
    if (!matching?.length) return storagePatch.original.apply(this, args);
    const operationId = ++nextOperation;
    const metadata = { childIds: matching.map(value => value.tabId) };
    safely(() => emit("storage-set-call", { operationId, ...metadata,
      value: { ...originalValue, records: matching } }));
    return invoke(storagePatch, this, args, operationId, "storage-set", metadata);
  };
  const restore = () => {
    let complete = true;
    for (const patch of patches.toReversed()) {
      try {
        if (patch.object[patch.name] !== patch.hook) throw Error(`${patch.name} observer replaced before stop`);
        if (patch.descriptor) Object.defineProperty(patch.object, patch.name, patch.descriptor);
        else delete patch.object[patch.name];
        if (patch.object[patch.name] !== patch.original) throw Error(`${patch.name} observer restoration failed`);
      } catch (error) { complete = false; failure(error); }
    }
    return complete;
  };
  const snapshot = () => copy({ sessions, records, bytes, maxRecords, maxBytes, overflow, errors, closed, restored,
    pendingOperations: [...pending.values()] });
  const api = { snapshot, stop() { if (!closed) { closed = true; restored = restore(); } return snapshot(); } };
  const installed = [];
  try {
    for (const patch of patches) {
      Object.defineProperty(patch.object, patch.name, patch.descriptor ? { ...patch.descriptor, value: patch.hook } :
        { configurable: true, enumerable: false, writable: true, value: patch.hook });
      installed.push(patch);
    }
    Object.defineProperty(target, "__createdPageAdoption", { configurable: true, enumerable: false, writable: true, value: api });
  } catch (error) {
    for (const patch of installed.toReversed()) {
      if (patch.object[patch.name] !== patch.hook) continue;
      if (patch.descriptor) Object.defineProperty(patch.object, patch.name, patch.descriptor); else delete patch.object[patch.name];
    }
    throw error;
  }
  return { installed: true, sessions: [...sessions], maxRecords, maxBytes };
}

// This checks historical admission, so later cancellation/finalization may
// release authority. Those lifecycles require their own native/wire evidence.
export function assertCreatedPageAdoption({ snapshot, items }) {
  assert.ok(snapshot && Array.isArray(items) && items.length > 0, "Original adoption evidence");
  assert.equal(snapshot.closed, true, "Adoption observer stopped");
  assert.equal(snapshot.restored, true, "All original methods restored");
  assert.equal(snapshot.overflow, false, "Complete bounded adoption observation");
  assert.deepEqual(snapshot.errors, [], "No observer errors");
  assert.deepEqual(snapshot.pendingOperations, [], "Every observed original promise settled before stop");
  assert.ok(Number.isSafeInteger(snapshot.maxRecords) && snapshot.maxRecords > 0 && snapshot.maxRecords <= 10000);
  assert.ok(Number.isSafeInteger(snapshot.maxBytes) && snapshot.maxBytes > 0 && snapshot.maxBytes <= 8 * 1024 * 1024);
  assert.ok(Array.isArray(snapshot.records) && snapshot.records.length <= snapshot.maxRecords);
  assert.equal(snapshot.bytes, snapshot.records.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row)), 0), "Original serialized byte accounting");
  assert.ok(snapshot.bytes <= snapshot.maxBytes);
  assert.deepEqual([...snapshot.sessions].sort(), [...new Set(items.map(item => item.sessionId))].sort(), "Original selected sessions");
  const rows = snapshot.records, checks = [], operations = new Map();
  const pairs = new Map([["adoption-enter", "adoption"], ["reserve-enter", "reserve"], ["commit-enter", "commit"], ["tabs-get-call", "tabs-get"], ["storage-set-call", "storage-set"]]);
  const ends = new Set(["fulfilled", "rejected", "threw", "return"]);
  for (const [index, row] of rows.entries()) {
    assert.equal(row.sequence, index + 1, "Contiguous original observation sequence");
    assert.ok(Number.isFinite(row.receivedAt) && Number.isSafeInteger(row.operationId) && row.operationId > 0);
    if (pairs.has(row.kind)) {
      assert.ok(!operations.has(row.operationId), "Unique original operation identity");
      operations.set(row.operationId, { start: row, kind: pairs.get(row.kind) });
    } else {
      const operation = operations.get(row.operationId), suffix = operation && row.kind.slice(operation.kind.length + 1);
      assert.ok(operation && !operation.end && row.kind.startsWith(`${operation.kind}-`) && ends.has(suffix), "Exactly one matching original outcome");
      assert.deepEqual(row.adoptionId, operation.start.adoptionId, "Outcome retains original adoption");
      assert.deepEqual(row.childId, operation.start.childId, "Outcome retains original child");
      operation.end = row;
    }
  }
  assert.ok([...operations.values()].every(operation => operation.end), "Original outcomes complete");
  const enters = rows.filter(row => row.kind === "adoption-enter");
  assert.equal(enters.length, items.length, "One original adoption per expected native child");
  assert.equal(new Set(items.map(item => item.tabId)).size, items.length, "Distinct original source tabs");
  assert.equal(new Set(items.map(item => item.childId)).size, items.length, "Distinct original native children");
  const one = (values, label) => { assert.equal(values.length, 1, label); return values[0]; };
  const protectedScope = value => ({ session_id: value?.session_id, turn_id: value?.turn_id, control_epoch: value?.control_epoch });
  for (const item of items) {
    assert.ok(typeof item.sessionId === "string" && item.sessionId && typeof item.turnId === "string" && item.turnId);
    assert.ok(Number.isSafeInteger(item.controlEpoch) && item.controlEpoch > 0);
    assert.ok(Number.isSafeInteger(item.tabId) && item.tabId >= 0 && Number.isSafeInteger(item.childId) && item.childId >= 0 && item.tabId !== item.childId);
    const expectedScope = { session_id: item.sessionId, turn_id: item.turnId, control_epoch: item.controlEpoch };
    const entry = one(enters.filter(row => row.childId === item.childId), "Exact native child adoption entry");
    assert.deepEqual(protectedScope(entry.scope), expectedScope, "Original protected adoption scope");
    assert.equal(entry.scope.tabId, item.tabId); assert.equal(entry.event.tabId, item.childId); assert.equal(entry.event.sourceTabId, item.tabId);
    if (item.childURL !== undefined) assert.equal(entry.event.url, item.childURL);
    if (item.sourceFrame) assert.equal(entry.event.sourceFrameId, item.sourceFrame.frameId);
    assert.equal(entry.waiter.params.tabId, item.tabId); assert.deepEqual(protectedScope(entry.waiter.params), expectedScope);
    assert.ok(typeof entry.waiter.waiterId === "string" && entry.waiter.waiterId);
    if (item.waiterId !== undefined) assert.equal(entry.waiter.waiterId, item.waiterId);
    assert.deepEqual(entry.child, { entry: null, owner: null }, "No child auxiliary reservation or authority at entry");
    assert.deepEqual(entry.source.entry, entry.source.owner, "Source has committed original auxiliary authority");
    const source = entry.source.owner;
    assert.ok(source); assert.equal(source.kind, "background-window"); assert.equal(source.origin, "agent"); assert.equal(source.phase, "committed");
    assert.equal(source.tabId, item.tabId); assert.deepEqual(protectedScope(source), expectedScope);
    const own = rows.filter(row => row.adoptionId === entry.adoptionId);
    const reserve = one(own.filter(row => row.kind === "reserve-enter"), "One first native-child reservation");
    assert.deepEqual(reserve.before, { entry: null, owner: null }, "Still no auxiliary entry or owner immediately before reserve");
    assert.deepEqual(protectedScope(reserve.params), expectedScope); assert.equal(reserve.params.tabId, item.childId);
    const firstGet = own.find(row => row.kind === "tabs-get-call"), tab = firstGet && operations.get(firstGet.operationId).end;
    assert.ok(firstGet && tab.kind === "tabs-get-fulfilled" && entry.sequence < firstGet.sequence && tab.sequence < reserve.sequence,
      "First actual observed child lookup acknowledged before reserve");
    // Restricted site validation can perform more reads, and later inspection
    // can read the same child. Keep every original call instead of pretending
    // the hook's tab-ID correlation establishes a private call-site identity.
    for (const read of own.filter(row => row.kind === "tabs-get-fulfilled" && row.sequence < reserve.sequence)) {
      assert.equal(read.result.id, item.childId); assert.equal(read.result.groupId, -1); assert.equal(read.result.windowId, source.windowId);
      assert.equal(read.result.active, false); assert.equal(read.result.pinned, false);
    }
    const reservation = operations.get(reserve.operationId).end;
    assert.equal(reservation.kind, "reserve-return"); assert.equal(reservation.result.tabId, item.childId);
    assert.deepEqual(protectedScope(reservation.result), expectedScope); assert.equal(reservation.result.phase, "reserved");
    assert.equal(reservation.result.origin, "user"); assert.ok(typeof reservation.result.claimId === "string" && reservation.result.claimId);
    assert.equal(reservation.after.owner, null); assert.deepEqual(reservation.after.entry, reservation.result);
    const commit = one(own.filter(row => row.kind === "commit-enter"), "One created-page commit");
    assert.ok(reservation.sequence < commit.sequence); assert.deepEqual(commit.record, reservation.result);
    assert.equal(commit.options.kind, "created-page"); assert.equal(commit.options.windowId, source.windowId);
    assert.equal(commit.options.control_epoch, item.controlEpoch); assert.equal(commit.options.check, true); assert.equal(commit.options.validate, true);
    const committed = operations.get(commit.operationId).end, adopted = operations.get(entry.operationId).end;
    assert.equal(committed.kind, "commit-fulfilled"); assert.equal(adopted.kind, "adoption-fulfilled");
    assert.ok(commit.sequence < committed.sequence && committed.sequence < adopted.sequence);
    assert.equal(committed.result.kind, "created-page"); assert.equal(committed.result.origin, "user"); assert.equal(committed.result.phase, "committed");
    assert.equal(committed.result.claimId, reservation.result.claimId); assert.equal(committed.result.tabId, item.childId);
    assert.equal(committed.result.windowId, source.windowId); assert.deepEqual(protectedScope(committed.result), expectedScope);
    assert.deepEqual(committed.after, { entry: committed.result, owner: committed.result }, "Commit outcome has actual durable admission");
    assert.deepEqual(adopted.result, { tabId: item.childId }); assert.deepEqual(adopted.after, committed.after);
    const writes = rows.filter(row => row.kind === "storage-set-call" && row.sequence > commit.sequence && row.sequence < committed.sequence)
      .flatMap(row => row.value.records.filter(value => value.tabId === item.childId).map(value => ({ row, value, ack: operations.get(row.operationId).end })));
    // Saves contain the whole persisted ledger, so concurrent children can
    // legitimately appear in several original pending/committed writes. Use
    // actual acknowledgements, retain all of them, and require the ordered
    // pending -> committed persistence chain before this commit resolves.
    const eligible = writes.filter(write => ["pending", "committed"].includes(write.value.phase) && write.ack.sequence < committed.sequence);
    const pendingWrite = eligible.find(write => write.value.phase === "pending");
    const committedWrite = pendingWrite && eligible.find(write => write.value.phase === "committed" && pendingWrite.ack.sequence < write.row.sequence);
    assert.ok(pendingWrite && committedWrite, "Original pending ACK then committed call and ACK before commit");
    for (const { row, value, ack } of eligible) {
      assert.equal(row.value.version, 4); assert.ok(typeof row.value.incarnation === "string" && row.value.incarnation, "Original browser incarnation in actual Chrome storage write");
      assert.equal(value.claimId, reservation.result.claimId); assert.equal(value.kind, "created-page"); assert.equal(value.origin, "user");
      assert.equal(value.windowId, source.windowId); assert.deepEqual(protectedScope(value), expectedScope);
      assert.equal(ack.kind, "storage-set-fulfilled"); assert.deepEqual(ack.childIds, row.childIds); assert.ok(row.sequence < ack.sequence && ack.sequence < committed.sequence);
    }
    assert.equal(pendingWrite.row.value.incarnation, committedWrite.row.value.incarnation);
    assert.ok(pendingWrite.ack.sequence < committedWrite.row.sequence, "Pending persistence acknowledged before committed persistence");
    checks.push({ sessionId: item.sessionId, tabId: item.tabId, childId: item.childId, adoptionId: entry.adoptionId,
      claimId: reservation.result.claimId, entrySequence: entry.sequence, originalTabAckSequence: tab.sequence,
      reserveSequence: reserve.sequence, pendingStorageAckSequence: pendingWrite.ack.sequence,
      committedStorageAckSequence: committedWrite.ack.sequence, storageWrites: writes.map(write => ({ callSequence: write.row.sequence, ackSequence: write.ack.sequence, phase: write.value.phase })),
      commitSequence: committed.sequence, adoptedSequence: adopted.sequence });
  }
  return { adoptions: checks.length, checks };
}
