import test from "node:test";
import assert from "node:assert/strict";
import { PrivateTargetStore, PRIVATE_TARGET_LEDGER_KEY as LEDGER, PRIVATE_TARGET_INITIALIZED_KEY as INITIALIZED } from "./browser-private-target-store.js";
import { PrivateTargetRegistry } from "./browser-private-targets.js";

const marker = () => ({ version: 1, allocator: "private-frame-targets" });
const row = () => ({ leaseId: "original-lease", tabId: 7, rootTargetId: "original-root", targetId: "original-child", parentFrameId: "original-parent", phase: "owned" });
const ledger = (records = [], incarnation = "original-browser") => ({ version: 1, incarnation, records });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const event = () => { const listeners = []; return { addListener(fn) { listeners.push(fn); }, emit(details) { listeners.forEach(fn => fn(details)); }, listeners }; };

function fixture({ saved = {}, get, set, lifetime } = {}) {
  const values = structuredClone(saved), calls = [], installed = event(), notices = [];
  const browserLifetime = lifetime ?? { incarnation: "original-browser", ready: Promise.resolve() };
  const storage = { local: {
    async get(keys) {
      calls.push({ method: "get", keys }); await get?.(keys);
      return structuredClone(Object.fromEntries(keys.filter(key => Object.hasOwn(values, key)).map(key => [key, values[key]])));
    },
    async set(update) {
      const captured = structuredClone(update); calls.push({ method: "set", update: captured }); await set?.(captured);
      Object.assign(values, captured);
    }
  } };
  const store = new PrivateTargetStore({ storage, browserLifetime, onInstalled: installed, onAvailable: () => notices.push("available") });
  return { store, storage, values, calls, installed, browserLifetime, notices, writes: () => calls.filter(c => c.method === "set") };
}

function registry(h, clients = new Set()) {
  const calls = [];
  const native = {
    getTargets() { calls.push("getTargets"); return Promise.resolve([{ id: "original-child", attached: false }]); },
    send(target, method) {
      calls.push(method);
      if (method === "Target.getTargetInfo") return clients.has(target.targetId) ? Promise.resolve({ targetInfo: { targetId: target.targetId } }) : Promise.reject(Error(`Debugger is not attached to the target with id: ${target.targetId}.`));
      return Promise.resolve({});
    },
    attach(target) { calls.push("attach"); clients.add(target.targetId); return Promise.resolve(); },
    detach(target) { calls.push("detach"); clients.delete(target.targetId); return Promise.resolve(); }
  };
  const value = new PrivateTargetRegistry({ load: () => h.store.load(), save: value => h.store.save(value), incarnation: () => h.browserLifetime.incarnation, native, randomUUID: () => "new-lease" });
  value.ready.catch(() => {});
  return { value, calls, clients };
}

const acquire = r => r.value.acquire({ root: { tabId: 7, rootTargetId: "original-root", attachment: {}, check() {} }, targetId: "original-child", parentFrameId: "original-parent" });

test("missing storage and a new BrowserLifetime marker do not grant optional ownership", async () => {
  const h = fixture(), r = registry(h); await h.store.ready;
  assert.deepEqual(await h.store.load(), {}); await assert.rejects(r.value.ready, /ownership is unknown/);
  assert.equal(acquire(r), null); assert.deepEqual(r.calls, []); assert.equal(h.writes().length, 0);
  assert.equal(h.store.snapshot().unknown, "missing-ledger");
});

test("real first install consumes marker ACK before empty-ledger ACK and any native attach", async () => {
  const mark = deferred(), empty = deferred();
  const h = fixture({ set(update) { if (update[INITIALIZED]) return mark.promise; if (update[LEDGER]?.records.length === 0) return empty.promise; } });
  h.installed.emit({ reason: "install" }); const r = registry(h); await tick();
  assert.deepEqual(h.writes().map(c => Object.keys(c.update)), [[INITIALIZED]]); assert.equal(acquire(r), null); assert.deepEqual(r.calls, []);
  mark.resolve(); await tick(); assert.deepEqual(h.values[INITIALIZED], marker()); assert.equal(h.values[LEDGER], undefined);
  assert.equal(h.writes().length, 2); assert.deepEqual(r.calls, []);
  empty.resolve(); await r.value.ready; assert.deepEqual(h.values[LEDGER], ledger());
  const lease = acquire(r); await lease.ready; assert.deepEqual(h.values[LEDGER].records.map(value => value.phase), ["owned"]);
  await lease.release(); assert.deepEqual(h.values[LEDGER], ledger());
  assert.deepEqual(r.calls, ["getTargets", "Target.getTargetInfo", "attach", "detach"]);
});

test("late update initializes once and notifies only after its actual ledger ACK", async () => {
  const ack = deferred(); const h = fixture({ set(update) { if (update[LEDGER]) return ack.promise; } });
  await h.store.ready; const first = registry(h); await assert.rejects(first.value.ready);
  h.installed.emit({ reason: "update", previousVersion: "0.0.1" }); await tick();
  assert.deepEqual(h.notices, []); assert.equal(h.store.snapshot().available, false); assert.equal(first.value.snapshot().enabled, false);
  ack.resolve(); await tick(); assert.deepEqual(h.notices, ["available"]);
  const replacement = registry(h); await replacement.value.ready;
  h.installed.emit({ reason: "install" }); h.installed.emit({ reason: "update" }); await tick();
  assert.equal(h.writes().length, 2); assert.deepEqual(h.notices, ["available"]);
});

test("shared module and browser update events cannot initialize the frame ledger", async () => {
  const h = fixture(); await h.store.ready;
  for (const reason of ["shared_module_update", "chrome_update", "startup", undefined]) h.installed.emit({ reason });
  await tick(); assert.deepEqual(await h.store.load(), {}); assert.equal(h.writes().length, 0);
  h.installed.emit({ reason: "install" }); await tick(); assert.equal(h.store.snapshot().available, true);
});

test("worker replacement recovers the same-incarnation durable intent for cleanup only", async () => {
  const original = { ...row(), phase: "intent" };
  const h = fixture({ saved: { [INITIALIZED]: marker(), [LEDGER]: ledger([original]) } });
  const clients = new Set([original.targetId]), r = registry(h, clients); await r.value.ready;
  assert.deepEqual(r.value.snapshot().quarantined, [original.leaseId]); assert.equal(acquire(r), null); assert.deepEqual(r.calls, []);
  await r.value.recover(original.leaseId); assert.equal(clients.size, 0); assert.deepEqual(h.values[LEDGER], ledger());
  assert.deepEqual(r.calls, ["Target.getTargetInfo", "detach"]);
});

test("a consumed marker and lost ledger stay unknown even with a late install or update", async () => {
  for (const reason of ["install", "update"]) {
    const h = fixture({ saved: { [INITIALIZED]: marker() } }); h.installed.emit({ reason }); await h.store.ready; await tick();
    assert.deepEqual(await h.store.load(), {}); assert.equal(h.writes().length, 0); assert.deepEqual(h.notices, []);
    assert.equal(h.store.snapshot().unknown, "invalid-or-missing-ledger");
  }
});

test("events never erase an existing live ledger or restore one deleted after load", async () => {
  const h = fixture({ saved: { [INITIALIZED]: marker(), [LEDGER]: ledger([row()]) } }); await h.store.load();
  h.installed.emit({ reason: "update" }); await tick(); assert.deepEqual(h.values[LEDGER], ledger([row()]));
  delete h.values[LEDGER]; await assert.rejects(h.store.save(ledger()), /storage is unavailable/);
  h.installed.emit({ reason: "install" }); await tick(); assert.equal(h.values[LEDGER], undefined); assert.equal(h.writes().length, 0);
  assert.equal(h.store.snapshot().unknown, "storage-changed");
});

test("only a validated empty old-incarnation ledger can be rebound, after actual storage ACK", async () => {
  const ack = deferred(); const h = fixture({ saved: { [INITIALIZED]: marker(), [LEDGER]: ledger([], "old-browser") }, set: () => ack.promise });
  const r = registry(h); await tick(); assert.equal(acquire(r), null); assert.equal(h.store.snapshot().available, false);
  assert.equal(h.values[LEDGER].incarnation, "old-browser"); ack.resolve(); await r.value.ready;
  assert.deepEqual(h.values[LEDGER], ledger()); assert.equal(h.writes().length, 1); assert.deepEqual(h.notices, []);
});

test("old-incarnation resources remain unknown without native scans, detach, or event erasure", async () => {
  const h = fixture({ saved: { [INITIALIZED]: marker(), [LEDGER]: ledger([row()], "old-browser") } });
  h.installed.emit({ reason: "update" }); const r = registry(h); await assert.rejects(r.value.ready); await tick();
  assert.equal(h.store.snapshot().unknown, "previous-incarnation-resources"); assert.deepEqual(r.calls, []);
  assert.equal(h.writes().length, 0); assert.deepEqual(h.values[LEDGER], ledger([row()], "old-browser"));
});

test("unknown versions, malformed empty ledgers, missing markers, and duplicate targets never bootstrap", async () => {
  const candidates = [
    { [INITIALIZED]: { version: 2, allocator: "private-frame-targets" }, [LEDGER]: ledger() },
    { [INITIALIZED]: marker(), [LEDGER]: { ...ledger([], "old-browser"), future: true } },
    { [INITIALIZED]: marker(), [LEDGER]: { ...ledger(), version: 2 } },
    { [LEDGER]: ledger() },
    { [INITIALIZED]: marker(), [LEDGER]: ledger([row(), { ...row(), leaseId: "another" }]) }
  ];
  for (const saved of candidates) {
    const h = fixture({ saved }); h.installed.emit({ reason: "install" }); await h.store.ready; await tick();
    assert.deepEqual(await h.store.load(), {}); assert.deepEqual(h.values, saved); assert.equal(h.writes().length, 0);
  }
});

test("read failure is optional-only and cannot turn an install event into an empty store", async () => {
  const failure = Error("original storage read failure"); const h = fixture({ get: () => Promise.reject(failure) });
  h.installed.emit({ reason: "install" }); await h.store.ready; await tick();
  assert.deepEqual(await h.store.load(), {}); assert.equal(h.store.snapshot().unknown, "unreadable-storage"); assert.equal(h.writes().length, 0);
});

test("failed marker or empty writes cannot be automatically retried by replaying events", async () => {
  for (const failKey of [INITIALIZED, LEDGER]) {
    const failure = Error(`original ${failKey} write failure`);
    const h = fixture({ set(update) { if (update[failKey]) return Promise.reject(failure); } });
    h.installed.emit({ reason: "install" }); await h.store.ready; await tick();
    const count = h.writes().length; h.installed.emit({ reason: "update" }); await tick();
    assert.equal(h.writes().length, count); assert.deepEqual(await h.store.load(), {}); assert.deepEqual(h.notices, []);
    assert.equal(h.values[LEDGER], undefined); if (failKey === LEDGER) assert.deepEqual(h.values[INITIALIZED], marker());
  }
});

test("incarnation changes during initial read or fresh writes cannot confer authority", async () => {
  const read = deferred(); let gets = 0;
  const h = fixture({ get() { if (++gets === 1) return read.promise; } });
  h.installed.emit({ reason: "install" }); await tick(); h.browserLifetime.incarnation = "replacement-browser";
  read.resolve(); await h.store.ready; await tick(); assert.deepEqual(await h.store.load(), {}); assert.equal(h.writes().length, 0);
  const write = deferred(); const k = fixture({ set(update) { if (update[INITIALIZED]) return write.promise; } });
  k.installed.emit({ reason: "install" }); await tick(); k.browserLifetime.incarnation = "replacement-browser";
  write.resolve(); await k.store.ready; await tick(); assert.deepEqual(await k.store.load(), {}); assert.equal(k.values[LEDGER], undefined);
});

test("a real install before lifetime readiness binds to that lifetime, not a later replacement", async () => {
  const ready = deferred(), lifetime = { incarnation: undefined, ready: ready.promise };
  const h = fixture({ lifetime }); h.installed.emit({ reason: "install" }); await tick(); assert.equal(h.writes().length, 0);
  lifetime.incarnation = "original-browser"; ready.resolve(); await h.store.ready;
  assert.deepEqual(await h.store.load(), { ledger: ledger() });
  lifetime.incarnation = "later-browser"; assert.deepEqual(await h.store.load(), {}); await assert.rejects(h.store.save(ledger([], "later-browser")));
});

test("save captures caller data, serializes actual ACKs, and ignores object key ordering", async () => {
  const first = deferred(); let writes = 0;
  const h = fixture({ saved: { [INITIALIZED]: marker(), [LEDGER]: ledger() }, set() { if (++writes === 1) return first.promise; } });
  await h.store.load(); const next = ledger([row()]); const a = h.store.save(next); next.records[0].targetId = "mutated-after-call";
  const b = h.store.save(ledger()); await tick(); assert.equal(h.writes().length, 1); assert.deepEqual(h.values[LEDGER], ledger());
  first.resolve(); await a; await b; assert.equal(h.writes().length, 2); assert.deepEqual(h.values[LEDGER], ledger());
  h.values[LEDGER] = { records: [], incarnation: "original-browser", version: 1 };
  h.values[INITIALIZED] = { allocator: "private-frame-targets", version: 1 };
  await h.store.save(ledger([row()])); assert.equal(h.values[LEDGER].records[0].targetId, "original-child");
});

test("failed actual save retains its original error and permits an explicit retry when storage is unchanged", async () => {
  const failure = Error("original local set failure"); let writes = 0;
  const h = fixture({ saved: { [INITIALIZED]: marker(), [LEDGER]: ledger([row()]) }, set() { if (++writes === 1) return Promise.reject(failure); } });
  await h.store.load(); await assert.rejects(h.store.save(ledger()), error => error === failure);
  assert.deepEqual(h.values[LEDGER], ledger([row()])); assert.equal(h.store.snapshot().available, true);
  await h.store.save(ledger()); assert.deepEqual(h.values[LEDGER], ledger());
});

test("recovery retains quarantine through durable-clear failure and retries only that clear", async () => {
  const clear = deferred(), failure = Error("original durable-clear failure"); let clears = 0;
  const h = fixture({ saved: { [INITIALIZED]: marker(), [LEDGER]: ledger([row()]) }, set(update) { if (update[LEDGER]?.records.length === 0 && ++clears === 1) return clear.promise; } });
  const r = registry(h, new Set([row().targetId])); await r.value.ready;
  const recovery = r.value.recover(row().leaseId); await tick();
  assert.deepEqual(r.calls, ["Target.getTargetInfo", "detach"]); assert.equal(r.clients.size, 0);
  assert.deepEqual(r.value.snapshot().quarantined, [row().leaseId]); assert.equal(acquire(r), null); assert.deepEqual(h.values[LEDGER], ledger([row()]));
  assert.ok(h.store.snapshot().pending.length > 0);
  clear.reject(failure); await assert.rejects(recovery, error => error === failure);
  assert.deepEqual(r.value.snapshot().failed, [row().leaseId]); assert.equal(acquire(r), null);
  await r.value.retry(row().leaseId);
  assert.deepEqual(r.calls, ["Target.getTargetInfo", "detach"]); assert.equal(clears, 2);
  assert.deepEqual(h.values[LEDGER], ledger()); assert.deepEqual(r.value.snapshot().quarantined, []);
});

test("foreign storage mutation disables saves instead of overwriting another ownership record", async () => {
  const h = fixture({ saved: { [INITIALIZED]: marker(), [LEDGER]: ledger() } }); await h.store.load();
  h.values[LEDGER] = ledger([{ ...row(), leaseId: "foreign-lease" }]);
  await assert.rejects(h.store.save(ledger()), /storage is unavailable/);
  assert.equal(h.writes().length, 0); assert.equal(h.values[LEDGER].records[0].leaseId, "foreign-lease");
  assert.equal(h.store.snapshot().available, false); assert.deepEqual(await h.store.load(), {});
});

test("late availability callback failure does not erase successful storage or replay initialization", async () => {
  const h = fixture(); h.store.onAvailable = () => { throw Error("coordinator failed"); }; await h.store.ready;
  h.installed.emit({ reason: "install" }); await tick(); assert.deepEqual(await h.store.load(), { ledger: ledger() });
  assert.equal(h.store.snapshot().available, true); assert.equal(h.writes().length, 2);
});
