import assert from "node:assert/strict";
import test from "node:test";
import { AuxiliaryTabOwnership, AUXILIARY_TABS_KEY as KEY } from "./auxiliary-tab-ownership.js";

const clone = value => structuredClone(value);
const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
const until = async predicate => { for (let n = 0; n < 100 && !predicate(); n++) await Promise.resolve(); assert.ok(predicate(), "expected operation reached its deterministic barrier"); };
const params = (tabId = 7, session_id = "task", extra = {}) => ({ tabId, session_id, turn_id: "turn", control_epoch: 1, controlRevision: 0, ...extra });
const persisted = (tabId = 7, extra = {}) => ({ claimId: `claim-${tabId}`, ...params(tabId), windowId: 10, origin: "user", phase: "committed", ...extra });
function environment({ initial, read, write, access, maxRecords = 256 } = {}) {
  const disk = initial === undefined ? {} : { [KEY]: clone(initial) }, calls = [];
  let sequence = 0;
  const storage = {
    async setAccessLevel(value) { assert.equal(this, storage); calls.push(["access", value]); await access?.(value); },
    async get(key) { assert.equal(this, storage); calls.push(["get", key]); await read?.(); return clone(disk); },
    async set(value) { assert.equal(this, storage); calls.push(["set", clone(value[KEY])]); await write?.(value[KEY]); Object.assign(disk, clone(value)); }
  };
  const store = new AuxiliaryTabOwnership({ storage, maxRecords, createId: () => `new-${++sequence}` });
  return { store, storage, disk, calls };
}
const commit = (store, record, options = {}) => store.commit(record, { windowId: 10, check() {}, async validate() {}, ...options });

test("version 5 managed-result requires explicit user admission and never recovers worker-local authority", async () => {
  const { store, disk, storage } = environment(); await store.ready;
  const record = store.reserve(params());
  await commit(store, record, { kind: "managed-result" });
  assert.equal(store.owner(7), record); assert.equal(record.origin, "user");
  assert.equal(disk[KEY].version, 5);
  const recovered = new AuxiliaryTabOwnership({ storage });
  await recovered.ready;
  assert.equal(recovered.owner(7), undefined);
  assert.equal(recovered.entry(7).phase, "quarantined");
  assert.throws(() => recovered.reserve(params()), /CLEANUP_REQUIRED/);
  await recovered.remove(recovered.entry(7));
  assert.deepEqual(disk[KEY].records, []);
});

test("managed-result cannot be created, imported by old schemas, or relabeled as agent/excluded", async () => {
  const { store } = environment(); await store.ready;
  assert.throws(() => store.reserveCreation(params(), { kind: "managed-result" }), /STATE_INVALID/);
  const agent = store.reserveCreation(params(), { kind: "ordinary" });
  await store.bindCreated(agent, { id: 8, windowId: 10 });
  await assert.rejects(commit(store, agent, { kind: "managed-result" }), /Auxiliary commit/);
  for (const value of [
    ...[1, 2, 3, 4].map(version => ({ version, records: [persisted(7, { kind: "managed-result" })] })),
    { version: 5, records: [persisted(7, { kind: "managed-result", origin: "agent" })] },
    { version: 5, records: [persisted(7, { kind: "managed-result", phase: "excluded", excludedGroupId: 10 })] }
  ]) await assert.rejects(environment({ initial: value }).store.ready, /STATE_INVALID/);
});

test("pending managed-result storage and failed cleanup preserve only the original denial", async () => {
  const { store, disk } = environment({ initial: { version: 5, records: [persisted(7, { kind: "managed-result", phase: "pending" })] } });
  await store.ready;
  const record = store.entry(7);
  assert.equal(record.phase, "quarantined"); assert.equal(store.owner(7), undefined);
  await assert.rejects(store.remove(record, { async cleanup() { throw new Error("original detach failed"); } }), /detach failed/);
  assert.equal(store.entry(7), record); assert.equal(disk[KEY].records[0].phase, "quarantined");
  await store.remove(record);
  assert.equal(store.entry(7), undefined);
});

test("explicit session storage and trusted access are required; malformed storage fails closed", async () => {
  assert.throws(() => new AuxiliaryTabOwnership(), /requires chrome.storage.session/);
  for (const initial of [{ version: 9, records: [] }, { version: 1, records: [persisted(), persisted()] },
    { version: 1, records: [persisted(7, { origin: "agent" })] }, { version: 1, records: [persisted(7, { windowId: -1 })] }]) {
    const { store, calls } = environment({ initial });
    await assert.rejects(store.ready, /STATE_INVALID/);
    assert.deepEqual(calls[0], ["access", { accessLevel: "TRUSTED_CONTEXTS" }]);
    assert.equal(store.owner(7), undefined);
    assert.throws(() => store.reserve(params()), /STATE_INVALID/);
  }
  for (const options of [{ read: async () => { throw new Error("read unavailable"); } }, { access: async () => { throw new Error("access denied"); } }]) {
    const { store } = environment(options);
    await assert.rejects(store.ready, /read unavailable|access denied/);
    assert.equal(store.list("task").length, 0);
  }
});

test("reservation is synchronous before load, rejects conflicts, and counts against capacity", async () => {
  const gate = deferred(), { store } = environment({ read: () => gate.promise, maxRecords: 1 });
  const record = store.reserve(params());
  assert.equal(record.phase, "reserved"); assert.equal(store.entry(7), record); assert.equal(store.owner(7), undefined);
  assert.deepEqual(store.controlSnapshot().tabIds, [7]);
  assert.throws(() => store.reserve(params()), /CLAIM_CONFLICT/);
  assert.throws(() => store.reserve(params(7, "other")), /CLAIM_CONFLICT/);
  assert.throws(() => store.reserve(params(8)), /CAPACITY/);
  for (const extra of [{ tabId: -1 }, { session_id: "" }, { turn_id: "" }, { control_epoch: 0 }, { controlRevision: -1 }])
    assert.throws(() => store.reserve({ ...params(), ...extra }), /Invalid auxiliary claim/);
  gate.resolve(); await store.ready;
  await store.remove(record);
  const legacy = store.reserve(params(8, "legacy", { control_epoch: undefined, controlRevision: undefined }));
  assert.equal(legacy.control_epoch, undefined);
  await store.remove(legacy);
});

test("pending write precedes validation; membership waits for committed write and repeat is idempotent", async () => {
  const pending = deferred(), committed = deferred(), phases = [];
  const { store, disk } = environment({ write: async state => {
    phases.push(state.records[0]?.phase);
    if (state.records[0]?.phase === "pending") await pending.promise;
    if (state.records[0]?.phase === "committed") await committed.promise;
  } });
  await store.ready;
  const record = store.reserve(params()); let validated = false, acknowledged = false, settled = false;
  const result = commit(store, record, { control_epoch: 9, controlRevision: 3, async validate(value) { assert.equal(value, record); validated = true; } }).then(value => { acknowledged = true; return value; });
  await until(() => phases.length === 1);
  assert.equal(validated, false); assert.equal(store.owner(7), undefined);
  pending.resolve(); await until(() => phases.length === 2);
  assert.equal(validated, true); assert.equal(record.phase, "committed"); assert.equal(store.owner(7), undefined);
  const waiting = store.settled(7).then(() => { settled = true; });
  assert.equal(acknowledged, false); assert.equal(settled, false);
  committed.resolve(); assert.equal(await result, record); await waiting;
  assert.equal(store.owner(7), record); assert.equal(store.list("task")[0], record);
  assert.equal(disk[KEY].records[0].control_epoch, 9); assert.equal(disk[KEY].records[0].controlRevision, 3);
  assert.equal(store.reserve(params(7, "task", { control_epoch: 10 })), record);
  assert.throws(() => store.reserve(params(7, "foreign")), /CLAIM_CONFLICT/);
  assert.equal(await commit(store, record), record); assert.deepEqual(phases, ["pending", "committed"]);
});

test("normal-window reservation removal never creates auxiliary persisted membership", async () => {
  const { store, calls } = environment(); await store.ready;
  const record = store.reserve(params());
  assert.equal(await store.remove(record), true);
  assert.equal(store.entry(7), undefined); assert.deepEqual(store.controlSnapshot().tabIds, []);
  assert.equal(calls.some(([method]) => method === "set"), false);
});

test("cancel before commit gate quarantines exact claim until successful cleanup", async () => {
  const validation = deferred(), { store, disk } = environment(); await store.ready;
  const record = store.reserve(params()); let entered = false;
  const result = commit(store, record, { async validate() { entered = true; await validation.promise; } });
  const rejected = assert.rejects(result, /CLAIM_EXPIRED/);
  await until(() => entered);
  store.cancelPending("other"); assert.equal(record.phase, "pending");
  store.cancelPending("task"); assert.equal(store.owner(7), undefined);
  validation.resolve(); await rejected;
  assert.equal(record.phase, "quarantined"); assert.throws(() => store.reserve(params()), /CLEANUP_REQUIRED/);
  await assert.rejects(store.remove(record, { async cleanup() { throw new Error("input release failed"); } }), /input release failed/);
  assert.equal(store.entry(7), record); assert.throws(() => store.reserve(params(7, "foreign")), /CLAIM_CONFLICT/);
  let cleaned = 0; await store.remove(record, { async cleanup(value) { assert.equal(value, record); cleaned++; } });
  assert.equal(cleaned, 1); assert.deepEqual(disk[KEY].records, []);
  assert.equal(store.entry(7), undefined);
});

test("end after synchronous commit gate retains membership but cannot make old claim succeed", async () => {
  const write = deferred(); let committedWrite = false, open = true;
  const { store } = environment({ write: async value => { if (value.records[0]?.phase === "committed") { committedWrite = true; await write.promise; } } });
  await store.ready; const record = store.reserve(params());
  const result = commit(store, record, { check() { if (!open) throw new Error("stale epoch"); } });
  const rejected = assert.rejects(result, /stale epoch/);
  await until(() => committedWrite); open = false; store.cancelPending("task");
  assert.equal(record.phase, "committed"); write.resolve(); await rejected;
  assert.equal(store.owner(7), record); assert.equal(store.reserve(params(7, "task", { control_epoch: 2 })), record);
});

test("recovery drops pending, retains quarantined locks, and merges early same-owner reservation", async () => {
  const read = deferred(), initial = { version: 1, records: [persisted(), persisted(8, { phase: "pending" }), persisted(9, { phase: "quarantined" })] };
  const { store, disk } = environment({ initial, read: () => read.promise });
  const early = store.reserve(params()); read.resolve(); await store.ready;
  const restored = store.owner(7); assert.notEqual(restored, early); assert.equal(store.check(early), restored);
  assert.equal(await commit(store, early), restored);
  assert.equal(store.entry(8), undefined); assert.equal(store.owner(9), undefined);
  assert.throws(() => store.reserve(params(9)), /CLEANUP_REQUIRED/);
  assert.deepEqual(disk[KEY].records.map(record => record.tabId), [7, 9]);
  assert.equal(await store.remove(early), false, "obsolete reservation cannot delete recovered identity");
  assert.equal(store.owner(7), restored);
});

test("recovered identity defeats foreign early reservation and never evicts for capacity", async () => {
  const read = deferred(), { store } = environment({ initial: { version: 1, records: [persisted()] }, read: () => read.promise, maxRecords: 1 });
  const early = store.reserve(params(8)); read.resolve(); await store.ready;
  assert.equal(store.owner(7)?.claimId, "claim-7"); assert.equal(store.entry(8), undefined);
  await assert.rejects(commit(store, early), /CAPACITY/);
  const gate = deferred(), env = environment({ initial: { version: 1, records: [persisted()] }, read: () => gate.promise });
  const foreign = env.store.reserve(params(7, "other")); gate.resolve(); await env.store.ready;
  await assert.rejects(commit(env.store, foreign), /CLAIM_CONFLICT/);
  assert.equal(env.store.owner(7)?.session_id, "task");
});

test("read failure does not allow pending reservation to authorize or reset storage", async () => {
  const read = deferred(), { store, calls } = environment({ read: () => read.promise });
  const reservation = store.reserve(params());
  const result = commit(store, reservation); const failed = assert.rejects(result, /read failed/);
  read.reject(new Error("read failed")); await failed;
  assert.equal(store.owner(7), undefined); assert.equal(calls.some(([method]) => method === "set"), false);
  await assert.rejects(store.remove(reservation), /read failed/);
});

test("pending and committed write failures retain exact quarantined identity until retry", async () => {
  for (const phase of ["pending", "committed"]) {
    let fail = true;
    const { store } = environment({ write: async value => { if (fail && value.records[0]?.phase === phase) throw new Error(`${phase} write failed`); } });
    await store.ready; const record = store.reserve(params());
    await assert.rejects(commit(store, record), /write failed/);
    assert.equal(record.phase, "quarantined"); assert.equal(store.owner(7), undefined); assert.equal(store.entry(7), record);
    assert.throws(() => store.reserve(params()), /CLEANUP_REQUIRED/);
    fail = false; await store.remove(record);
    assert.equal(store.entry(7), undefined);
  }
});

test("remove holds reverse lock through cleanup and serialized deletion; stale remove is harmless", async () => {
  const cleanup = deferred(), deletion = deferred(); let deleting = false;
  const { store } = environment({ write: async value => { if (value.records.length === 0) { deleting = true; await deletion.promise; } } });
  await store.ready; const record = store.reserve(params()); await commit(store, record);
  const removed = store.remove(record, { cleanup: () => cleanup.promise });
  assert.equal(store.owner(7), undefined); assert.throws(() => store.reserve(params(7, "other")), /CLAIM_CONFLICT/);
  cleanup.resolve(); await until(() => deleting); assert.equal(store.entry(7), record);
  deletion.resolve(); assert.equal(await removed, true);
  const successor = store.reserve(params(7, "other")); await commit(store, successor);
  let staleCleanup = false; assert.equal(await store.remove(record, { cleanup: async () => { staleCleanup = true; } }), false);
  assert.equal(staleCleanup, false); assert.equal(store.owner(7), successor);
});

test("parallel tab snapshots cannot resurrect an entry while durable deletion is pending", async () => {
  const deletion = deferred(); let deleting = false;
  const { store, disk } = environment({ write: async value => { if (!value.records.some(record => record.tabId === 7) && !deleting) { deleting = true; await deletion.promise; } } });
  await store.ready; const old = store.reserve(params()); await commit(store, old);
  const removal = store.remove(old); await until(() => deleting);
  const other = store.reserve(params(8)); const newer = commit(store, other);
  await until(() => other.phase === "pending"); deletion.resolve(); await Promise.all([removal, newer]);
  assert.deepEqual(disk[KEY].records.map(record => record.tabId), [8]);
});

test("cancellation does not hide an unresolved real storage operation from control drain", async () => {
  const write = deferred(); let entered = false;
  const { store } = environment({ write: async () => { entered = true; await write.promise; } });
  await store.ready; const record = store.reserve(params());
  const result = commit(store, record); const failure = assert.rejects(result, /CLAIM_EXPIRED/);
  await until(() => entered); store.cancelPending();
  let drained = false; const drain = Promise.allSettled(store.controlSnapshot().pending).then(() => { drained = true; });
  await Promise.resolve(); assert.equal(drained, false);
  write.resolve(); await failure; await drain;
  assert.equal(drained, true); assert.equal(store.owner(7), undefined);
  await store.remove(record);
});

test("quarantine denial persists across restart before removal and failed cleanup stays blocked", async () => {
  const { store, storage, disk } = environment(); await store.ready;
  const record = store.reserve(params()); await commit(store, record);
  assert.equal(store.quarantine(record), true); assert.equal(store.owner(7), undefined);
  await store.settled(7);
  assert.equal(disk[KEY].records[0].phase, "quarantined");
  const restarted = new AuxiliaryTabOwnership({ storage }); await restarted.ready;
  assert.equal(restarted.owner(7), undefined); assert.throws(() => restarted.reserve(params()), /CLEANUP_REQUIRED/);
  await assert.rejects(restarted.remove(restarted.entry(7), { async cleanup() { throw new Error("still held"); } }), /still held/);
  assert.equal(restarted.entry(7).claimId, record.claimId);
  await restarted.remove(restarted.entry(7)); assert.deepEqual(disk[KEY].records, []);
});

test("a stuck quarantine write does not prevent native cleanup, and deletion failure retains lock", async () => {
  const writing = deferred(); let blockedWrite = false, failDelete = true;
  const { store } = environment({ write: async state => {
    if (state.records[0]?.phase === "quarantined") { blockedWrite = true; await writing.promise; }
    if (!state.records.length && failDelete) throw new Error("delete failed");
  } });
  await store.ready; const record = store.reserve(params()); await commit(store, record);
  store.quarantine(record); await until(() => blockedWrite);
  let cleaned = false;
  const removed = store.remove(record, { async cleanup() { cleaned = true; } });
  const failed = assert.rejects(removed, /delete failed/);
  await until(() => cleaned); assert.equal(store.entry(7), record);
  writing.resolve(); await failed; assert.equal(store.owner(7), undefined);
  assert.throws(() => store.reserve(params(7, "other")), /CLAIM_CONFLICT/);
  failDelete = false; await store.remove(record); assert.equal(store.entry(7), undefined);
});

test("cancel during initial storage read cannot revive the cancelled reservation through recovery", async () => {
  const read = deferred(), { store } = environment({ initial: { version: 1, records: [persisted()] }, read: () => read.promise });
  const reservation = store.reserve(params()); store.cancelPending();
  read.resolve(); await store.ready;
  await assert.rejects(commit(store, reservation), /CLAIM_EXPIRED/);
  assert.equal(store.owner(7)?.claimId, "claim-7", "pre-existing membership survives; the old claim operation does not");
});

test("version five storage preserves legacy popup and version two ordinary agent/user identity", async () => {
  const legacy = environment({ initial: { version: 1, records: [persisted()] } }); await legacy.store.ready;
  assert.equal(legacy.store.owner(7).kind, "popup"); assert.equal(legacy.disk[KEY].version, 5);
  for (const origin of ["agent", "user"]) {
    const f = environment({ initial: { version: 2, records: [persisted(7, { kind: "ordinary", origin })] } }); await f.store.ready;
    assert.equal(f.store.owner(7).origin, origin);
    assert.equal(f.store.reserve(params()).origin, origin, "An explicit repeat claim cannot change the original disposition");
  }
  for (const record of [persisted(7, { kind: "unexpected" }), persisted(7, { kind: "popup", origin: "agent" }), persisted(7, { kind: "ordinary", extraAuthority: true })]) {
    const f = environment({ initial: { version: 2, records: [record] } }); await assert.rejects(f.store.ready, /STATE_INVALID/);
  }
  const disguisedLegacy = environment({ initial: { version: 1, records: [persisted(7, { kind: "ordinary" })] } });
  await assert.rejects(disguisedLegacy.store.ready, /STATE_INVALID/);
});

test("created-page authority is durable only in its original worker and every recovered phase stays denied", async () => {
  const live = environment(); await live.store.ready;
  const original = live.store.reserve(params());
  await commit(live.store, original, { kind: "created-page" });
  assert.equal(live.store.owner(7), original);
  assert.equal(live.disk[KEY].version, 5);
  assert.equal(live.disk[KEY].records[0].kind, "created-page");
  for (const phase of ["pending", "committed", "quarantined"]) {
    const initial = clone(live.disk[KEY]); initial.records[0].phase = phase;
    const recovered = environment({ initial }); await recovered.store.ready;
    assert.equal(recovered.store.owner(7), undefined);
    assert.deepEqual(recovered.store.list("task"), []);
    assert.equal(recovered.store.entry(7).claimId, original.claimId);
    assert.equal(recovered.store.entry(7).phase, "quarantined");
    assert.equal(recovered.disk[KEY].records[0].phase, "quarantined");
    assert.throws(() => recovered.store.reserve(params()), /CLEANUP_REQUIRED/);
    assert.throws(() => recovered.store.reserve(params(7, "foreign")), /CLAIM_CONFLICT/);
  }
});

test("recovered created-page cannot be displaced by early reservation and requires actual cleanup before explicit admission", async () => {
  const read = deferred(), cleanup = deferred(); let cleaning = false;
  const f = environment({ initial: { version: 4, records: [persisted(7, { kind: "created-page" })] }, read: () => read.promise });
  const early = f.store.reserve(params()); read.resolve(); await f.store.ready;
  await assert.rejects(commit(f.store, early, { kind: "created-page" }), /CLEANUP_REQUIRED/);
  const recovered = f.store.entry(7);
  const removal = f.store.remove(recovered, { async cleanup(record) {
    assert.equal(record, recovered); cleaning = true; await cleanup.promise;
  } });
  await until(() => cleaning);
  assert.throws(() => f.store.reserve(params()), /CLEANUP_REQUIRED/);
  assert.equal(f.store.entry(7), recovered);
  cleanup.resolve(); assert.equal(await removal, true);
  const explicit = f.store.reserve(params());
  await commit(f.store, explicit, { kind: "ordinary" });
  assert.equal(f.store.owner(7), explicit);
  assert.equal(explicit.kind, "ordinary");
  assert.notEqual(explicit.claimId, recovered.claimId);
});

test("created-page persistence requires version four and user origin; invalid shapes never become owners", async () => {
  for (const [version, changes] of [[3, {}], [4, { origin: "agent" }], [4, { phase: "excluded", excludedGroupId: 10 }]]) {
    const f = environment({ initial: { version, records: [persisted(7, { kind: "created-page", ...changes })] } });
    await assert.rejects(f.store.ready, /STATE_INVALID/);
    assert.equal(f.store.owner(7), undefined);
  }
  const f = environment(); await f.store.ready;
  const agent = f.store.reserveCreation(params());
  await f.store.bindCreated(agent, { id: 7, windowId: 10 });
  await assert.rejects(commit(f.store, agent, { kind: "created-page" }), /Auxiliary commit/);
  assert.equal(f.store.owner(7), undefined);
});

test("background-window identity is versioned, durable, and recovery never admits an unfinished creation", async () => {
  for (const phase of ["committed", "pending", "quarantined", "excluded"]) {
    const record = persisted(7, { kind: "background-window", origin: phase === "excluded" ? "user" : "agent", phase });
    const f = environment({ initial: { version: 3, records: [record] } }); await f.store.ready;
    assert.equal(f.store.owner(7)?.kind, phase === "committed" ? "background-window" : undefined);
    assert.equal(f.store.entry(7).phase, phase === "pending" ? "quarantined" : phase);
    assert.equal(f.disk[KEY].version, 5);
  }
  for (const [version, changes] of [[2, {}], [3, { origin: "user" }], [3, { phase: "excluded" }],
    [3, { phase: "excluded", origin: "user", excludedGroupId: 10 }]]) {
    const f = environment({ initial: { version, records: [persisted(7, { kind: "background-window", origin: "agent", ...changes })] } });
    await assert.rejects(f.store.ready, /STATE_INVALID/);
  }
});

test("background-window revocation retains an exact cross-window denial until explicit user admission", async () => {
  const f = environment(); await f.store.ready;
  const record = f.store.reserveCreation(params(), { kind: "background-window" });
  await f.store.bindCreated(record, { id: 7, windowId: 10 });
  await commit(f.store, record); assert.equal(f.store.owner(7), record);
  f.store.quarantine(record); await f.store.excludeBackground(record);
  assert.equal(f.store.owner(7), undefined); assert.equal(record.origin, "user");
  assert.equal(await f.store.remove(record), false);
  const recovered = environment({ initial: f.disk[KEY] }); await recovered.store.ready;
  const reservation = recovered.store.reserve(params());
  assert.equal(reservation.phase, "excluded"); assert.equal(reservation.origin, "user");
  assert.throws(() => recovered.store.reserve(params(7, "foreign")), /CLAIM_CONFLICT/);
  await commit(recovered.store, reservation, { kind: "ordinary", windowId: 20 });
  assert.equal(recovered.store.owner(7).origin, "user"); assert.equal(recovered.store.owner(7).windowId, 20);
});

test("creation reserves capacity before native work and binds only its returned tab identity", async () => {
  const f = environment({ maxRecords: 1 });
  assert.throws(() => f.store.reserveCreation(params()), /completed ownership recovery/);
  await f.store.ready;
  const record = f.store.reserveCreation(params());
  assert.equal(record.tabId, null); assert.equal(f.store.owner(7), undefined);
  assert.throws(() => f.store.reserve(params()), /CAPACITY/);
  let drained = false; const drain = Promise.all(f.store.controlSnapshot().pending).then(() => { drained = true; });
  await Promise.resolve(); assert.equal(drained, false);
  await f.store.bindCreated(record, { id: 42, windowId: 10 });
  assert.equal(f.store.entry(42), record); assert.equal(f.store.owner(42), undefined);
  assert.equal(f.disk[KEY].records[0].phase, "pending"); assert.equal(f.disk[KEY].records[0].origin, "agent");
  await commit(f.store, record); await drain;
  assert.equal(f.store.owner(42), record); assert.equal(record.kind, "ordinary");
  await f.store.remove(record);
});

test("cancelled native creation keeps its slot until actual binding and cleanup", async () => {
  const f = environment({ maxRecords: 1 }); await f.store.ready;
  const record = f.store.reserveCreation(params()); f.store.cancelPending("task");
  assert.equal(await f.store.remove(record), false);
  assert.throws(() => f.store.reserveCreation(params()), /CAPACITY/);
  await assert.rejects(f.store.bindCreated(record, { id: 42, windowId: 10 }), /CLAIM_EXPIRED/);
  assert.equal(f.store.entry(42).phase, "quarantined"); assert.equal(f.store.owner(42), undefined);
  await assert.rejects(f.store.remove(record, { cleanup: async () => { throw new Error("native close failed"); } }), /native close failed/);
  assert.throws(() => f.store.reserveCreation(params()), /CAPACITY/);
  await f.store.remove(record); assert.equal(f.store.entries().length, 0);
});

test("interrupted agent pending is quarantined across recovery rather than lost or automatically owned", async () => {
  const f = environment({ initial: { version: 2, records: [persisted(7, { kind: "ordinary", origin: "agent", phase: "pending" }), persisted(8, { kind: "popup", phase: "pending" })] } });
  await f.store.ready;
  assert.equal(f.store.entry(7).phase, "quarantined"); assert.equal(f.store.owner(7), undefined);
  assert.equal(f.store.entry(8), undefined); assert.equal(f.disk[KEY].records.length, 1);
  assert.throws(() => f.store.reserve(params(7, "other")), /CLAIM_CONFLICT/);
  assert.throws(() => f.store.reserve(params()), /CLEANUP_REQUIRED/);
});

test("excluded ordinary pages remain non-owners through release and recovery with strict persisted identity", async () => {
  const record = persisted(7, { kind: "ordinary", phase: "excluded", excludedGroupId: 30 });
  const { store, disk } = environment({ initial: { version: 2, records: [record] } }); await store.ready;
  const entry = store.entry(7);
  assert.equal(store.owner(7), undefined); store.cancelPending();
  assert.equal(await store.remove(entry), false);
  assert.equal(entry.phase, "excluded"); assert.equal(disk[KEY].records[0].excludedGroupId, 30);
  const claimed = store.reserve(params(7, "task", { turn_id: "later", control_epoch: 9 }));
  assert.equal(claimed, entry); assert.equal(claimed.origin, "user"); assert.equal(claimed.control_epoch, 9);
  assert.throws(() => store.reserve(params(7, "foreign")), /CLAIM_CONFLICT/);
  await store.remove(entry, { releaseExcluded: true }); assert.equal(store.entry(7), undefined);
  for (const invalidRecord of [
    { ...record, origin: "agent" }, { ...record, kind: "popup" }, { ...record, excludedGroupId: -1 },
    { ...record, excludedGroupId: undefined }, { ...record, phase: "quarantined" }
  ]) await assert.rejects(environment({ initial: { version: 2, records: [invalidRecord] } }).store.ready, /STATE_INVALID/);
  await assert.rejects(environment({ initial: { version: 1, records: [record] } }).store.ready, /STATE_INVALID/);
});

test("failed exclusion persistence keeps capacity and retries the same denial without granting membership", async () => {
  let fail = true;
  const { store, disk } = environment({ maxRecords: 1, write: async value => {
    if (fail && value.records[0]?.phase === "excluded") throw new Error("fixture exclusion write failed");
  } }); await store.ready;
  const entry = store.reserveCreation(params()); await store.bindCreated(entry, { id: 7, windowId: 10 });
  await assert.rejects(store.exclude(entry, 30), /fixture exclusion write failed/);
  assert.equal(store.owner(7), undefined); assert.equal(entry.phase, "excluded");
  assert.throws(() => store.reserve(params()), /CLEANUP_REQUIRED/);
  assert.throws(() => store.reserve(params(8)), /CAPACITY/);
  assert.equal(await store.remove(entry), false);
  fail = false; await store.exclude(entry, 30);
  assert.equal(store.reserve(params()), entry); assert.equal(disk[KEY].records[0].phase, "excluded");
});
