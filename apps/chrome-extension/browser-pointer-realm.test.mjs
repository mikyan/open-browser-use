import test from "node:test";
import assert from "node:assert/strict";
import { IDBFactory } from "fake-indexeddb";
import forceCloseDatabase from "fake-indexeddb/lib/forceCloseDatabase";
import { PointerRealmIdentity, POINTER_REALM_DATABASE as databaseName, POINTER_REALM_STORE as storeName, POINTER_REALM_KEY as recordKey } from "./browser-pointer-realm.js";

const tick = () => new Promise(setImmediate);
const deferred = () => { let resolve; const promise = new Promise(value => { resolve = value; }); return { promise, resolve }; };
const uuid = number => `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const seed = { version: 1, worldId: uuid(1), kernelId: uuid(2), tokenId: uuid(3) };
const requestResult = request => new Promise((resolve, reject) => {
  request.addEventListener("success", () => resolve(request.result));
  request.addEventListener("error", () => reject(request.error));
});

function harness() {
  const factory = new IDBFactory(), connections = [], transactions = [], events = [];
  let generated = 0, onUpgrade, onOpen, onTransaction;
  const indexedDB = { open(...args) {
    assert.deepEqual(args, [databaseName, 1]);
    const request = factory.open(...args);
    request.addEventListener("upgradeneeded", event => {
      events.push("upgrade");
      request.transaction.addEventListener("complete", () => events.push("upgrade-complete"));
      onUpgrade?.(request, event);
    });
    request.addEventListener("success", () => {
      const database = request.result, original = database.transaction;
      connections.push(database); events.push("open-success");
      database.transaction = function (...args) {
        const transaction = Reflect.apply(original, this, args); transactions.push({ args, transaction });
        transaction.addEventListener("complete", () => events.push("read-complete"));
        onTransaction?.(transaction); return transaction;
      };
      onOpen?.(request);
    });
    return request;
  } };
  const create = (options = {}) => new PointerRealmIdentity({ indexedDB, kernelABI: "native-pointer-v1",
    randomUUID: () => uuid(++generated), ...options });
  return { factory, connections, transactions, events, create, get generated() { return generated; },
    onUpgrade: callback => { onUpgrade = callback; }, onOpen: callback => { onOpen = callback; },
    onTransaction: callback => { onTransaction = callback; } };
}

async function populate(factory, { value = seed, missing = false, wrongStore = false, extraKey = false, keyPath = null, index = false } = {}) {
  const request = factory.open(databaseName, 1);
  request.onupgradeneeded = () => {
    const store = request.result.createObjectStore(wrongStore ? "unexpected" : storeName, { keyPath });
    if (index) store.createIndex("unexpected", "version");
    if (!missing && keyPath === null) store.add(value, recordKey);
    if (extraKey) store.add(seed, "unexpected");
  };
  const database = await requestResult(request); database.close();
}

async function contents(factory) {
  const database = await requestResult(factory.open(databaseName, 1));
  const transaction = database.transaction(storeName, "readonly"), store = transaction.objectStore(storeName);
  const result = await Promise.all([requestResult(store.getAllKeys()), requestResult(store.getAll())]);
  database.close(); return result;
}

test("installation identity is published only after commit and reused by replacement instances", async () => {
  const h = harness(), first = h.create(); assert.equal(first.capture(), null);
  await first.ready; const captured = first.capture(); assert.ok(captured); captured.check();
  assert.equal(h.generated, 3); assert.ok(h.events.indexOf("upgrade-complete") < h.events.indexOf("open-success"));
  assert.deepEqual(h.transactions.map(row => row.args), [[storeName, "readonly"]]);
  const replacement = h.create(); await replacement.ready;
  assert.deepEqual(replacement.capture().identity, captured.identity); assert.equal(h.generated, 3);
  assert.deepEqual(await contents(h.factory), [[recordKey], [seed]]);
  assert.equal(Object.isFrozen(captured), true); assert.equal(Object.isFrozen(captured.identity), true);
  const status = JSON.stringify(first.snapshot());
  for (const value of [seed.worldId, seed.kernelId, seed.tokenId]) assert.equal(status.includes(value), false);
});

test("two real IDB open connections serialize one atomic schema and seed initialization", async () => {
  const h = harness(), added = deferred(); let release = false, first, second;
  h.onUpgrade(request => {
    const database = request.result, original = database.createObjectStore;
    database.createObjectStore = function (...args) {
      const store = Reflect.apply(original, this, args), add = store.add;
      store.add = function (...args) {
        const result = Reflect.apply(add, this, args);
        result.addEventListener("success", () => {
          assert.equal(first.capture(), null); added.resolve();
          const keepActive = () => { if (!release) store.get(recordKey).addEventListener("success", keepActive); };
          keepActive();
        });
        return result;
      };
      return store;
    };
  });
  first = h.create(); second = h.create();
  try {
    await added.promise; await tick(); await tick();
    assert.equal(first.capture(), null); assert.equal(second.capture(), null);
    assert.equal(h.connections.length, 0); assert.equal(h.generated, 3);
  } finally { release = true; }
  await Promise.all([first.ready, second.ready]);
  assert.deepEqual(first.capture().identity, second.capture().identity); assert.equal(h.generated, 3);
  assert.equal(h.events.filter(value => value === "upgrade").length, 1);
});

test("seed add request success followed by upgrade abort never publishes or leaves a partial schema", async () => {
  const h = harness(); let first, observed = false;
  h.onUpgrade(request => {
    const database = request.result, original = database.createObjectStore;
    database.createObjectStore = function (...args) {
      const store = Reflect.apply(original, this, args), add = store.add;
      store.add = function (...args) {
        const result = Reflect.apply(add, this, args);
        result.addEventListener("success", () => { observed = true; assert.equal(first.capture(), null); request.transaction.abort(); });
        return result;
      }; return store;
    };
  });
  first = h.create(); await first.ready;
  assert.equal(observed, true); assert.equal(first.capture(), null); assert.equal(first.snapshot().state, "disabled");
  h.onUpgrade(undefined);
  const replacement = h.create(); await replacement.ready;
  assert.ok(replacement.capture()); assert.equal(h.generated, 6);
  assert.deepEqual((await contents(h.factory))[1], [{ version: 1, worldId: uuid(4), kernelId: uuid(5), tokenId: uuid(6) }]);
});

test("verification request success is not transaction completion and a later abort disables capture", async () => {
  const h = harness(); await populate(h.factory); let identity, observed = false;
  h.onTransaction(transaction => {
    const original = transaction.objectStore;
    transaction.objectStore = function (...args) {
      const store = Reflect.apply(original, this, args), get = store.get;
      store.get = function (...args) {
        const request = Reflect.apply(get, this, args);
        request.addEventListener("success", () => { observed = true; assert.equal(identity.capture(), null); transaction.abort(); });
        return request;
      }; return store;
    };
  });
  identity = h.create(); await identity.ready;
  assert.equal(observed, true); assert.equal(identity.capture(), null); assert.equal(identity.snapshot().reason, "read-aborted");
  assert.equal(h.generated, 0); assert.deepEqual((await contents(h.factory))[1], [seed]);
});

test("a commit before an interrupted consumer still gives its replacement the same stored identity", async () => {
  const h = harness(); let failed = false;
  h.onOpen(request => {
    if (failed) return; failed = true;
    // Initialization committed, but this consumer cannot complete verification.
    request.result.transaction = () => { throw Error("consumer terminated before verification"); };
  });
  const first = h.create(); await first.ready; assert.equal(first.capture(), null);
  const replacement = h.create(); await replacement.ready;
  assert.ok(replacement.capture()); assert.equal(h.generated, 3); assert.deepEqual((await contents(h.factory))[1], [seed]);
});

test("a different explicit kernel ABI changes every injected namespace without rewriting the seed", async () => {
  const h = harness(), first = h.create(); await first.ready;
  const second = h.create({ kernelABI: "native-pointer-v2" }); await second.ready;
  const a = first.capture().identity, b = second.capture().identity;
  for (const property of ["worldName", "kernelKey", "kernelToken"]) assert.notEqual(a[property], b[property]);
  assert.equal(h.generated, 3); assert.deepEqual((await contents(h.factory))[1], [seed]);
});

for (const [name, value] of [["null", null], ["unknown version", { ...seed, version: 2 }],
  ["additional field", { ...seed, extra: true }], ["missing field", { version: 1, worldId: seed.worldId, kernelId: seed.kernelId }],
  ["bad UUID", { ...seed, worldId: "predictable" }], ["duplicate UUIDs", { ...seed, kernelId: seed.worldId }],
  ["array", [seed]]]) test(`existing ${name} record is disabled without replacement`, async () => {
  const h = harness(); await populate(h.factory, { value }); const identity = h.create(); await identity.ready;
  assert.equal(identity.capture(), null); assert.equal(identity.snapshot().reason, "invalid-record"); assert.equal(h.generated, 0);
  assert.deepEqual((await contents(h.factory))[1], [value]);
});

for (const options of [{ missing: true }, { extraKey: true }, { wrongStore: true }, { keyPath: "id", missing: true }, { index: true }])
test(`existing schema or single-record invariant is not repaired: ${JSON.stringify(options)}`, async () => {
  const h = harness(); await populate(h.factory, options); const identity = h.create(); await identity.ready;
  assert.equal(identity.capture(), null); assert.equal(identity.snapshot().state, "disabled"); assert.equal(h.generated, 0);
  if (options.missing && options.keyPath === undefined) assert.deepEqual(await contents(h.factory), [[], []]);
});

test("database versionchange revokes every captured identity before allowing the upgrade", async () => {
  const h = harness(), identity = h.create(); await identity.ready; const captured = identity.capture();
  const upgrade = h.factory.open(databaseName, 2);
  upgrade.onupgradeneeded = () => { assert.equal(identity.capture(), null); assert.throws(captured.check, /OBU_POINTER_REALM_UNAVAILABLE/); };
  const database = await requestResult(upgrade); database.close();
  assert.equal(identity.snapshot().reason, "version-changed");
  const replacement = h.create(); await replacement.ready; assert.equal(replacement.capture(), null); assert.equal(h.generated, 3);
});

test("unexpected native database close revokes already captured checks", async () => {
  const h = harness(), identity = h.create(); await identity.ready; const captured = identity.capture();
  forceCloseDatabase(h.connections[0]);
  assert.equal(identity.capture(), null); assert.throws(captured.check, /OBU_POINTER_REALM_UNAVAILABLE/);
  assert.equal(identity.snapshot().reason, "connection-closed");
});

test("blocked-open handling never admits a late successful original connection", async () => {
  const h = harness();
  // Dispatch just the blocked observer callback; the later open result and its
  // schema/seed transaction are real fake-indexeddb operations.
  h.onOpen(request => request.onblocked());
  const identity = h.create(); await identity.ready; await tick();
  assert.equal(identity.capture(), null); assert.equal(identity.snapshot().reason, "open-blocked");
  assert.equal(h.transactions.length, 0); assert.equal(identity.snapshot().pending, false);
  await requestResult(h.factory.deleteDatabase(databaseName));
});

test("whole-database privileged deletion revokes the old instance without automatic rotation", async () => {
  const h = harness(), identity = h.create(); await identity.ready; const captured = identity.capture();
  await requestResult(h.factory.deleteDatabase(databaseName));
  assert.equal(identity.capture(), null); assert.throws(captured.check, /OBU_POINTER_REALM_UNAVAILABLE/); assert.equal(h.generated, 3);
  // A later constructor cannot distinguish this privileged deletion from first
  // installation. This is an explicit boundary, not destruction proof for worlds.
  const replacement = h.create(); await replacement.ready; assert.ok(replacement.capture()); assert.equal(h.generated, 6);
});

test("unavailable storage, invalid ABI and failed random generation only disable the optional identity", async () => {
  for (const options of [{ indexedDB: undefined, kernelABI: "" },
    { indexedDB: { open() { throw Error("native storage denied"); } }, kernelABI: "v1" }]) {
    const identity = new PointerRealmIdentity(options); await identity.ready;
    assert.equal(identity.capture(), null); assert.equal(identity.snapshot().state, "disabled");
  }
  const h = harness(), identity = h.create({ randomUUID: () => "invalid" }); await identity.ready;
  assert.equal(identity.capture(), null); assert.equal(identity.snapshot().reason, "initialization-failed");
  const replacement = h.create(); await replacement.ready; assert.ok(replacement.capture());
});
