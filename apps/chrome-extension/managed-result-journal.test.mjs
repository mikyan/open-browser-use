import test from "node:test";
import assert from "node:assert/strict";
import { IDBFactory } from "fake-indexeddb";
import { ManagedResultJournal, MANAGED_RESULT_DATABASE as databaseName, MANAGED_RESULT_STORE as storeName } from "./managed-result-journal.js";

const page = () => ({ recordId: "result-A", revision: 1, tabId: 7, targetId: "target-A", originalDocument: "document-A",
  currentDocument: "document-A", position: { windowId: 1, groupId: -1, pinned: false } });
const owner = () => ({ leaseId: "view-A", recordId: "result-A", tabId: 7, targetId: "target-A", documentId: "document-A" });
const requestResult = request => new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
function fixture() {
  const factory = new IDBFactory(), databases = [];
  let onTransaction;
  const indexedDB = { open(...args) {
    const request = factory.open(...args);
    request.addEventListener("success", () => {
      const db = request.result, transaction = db.transaction;
      databases.push(db);
      db.transaction = function (...args) { const value = Reflect.apply(transaction, this, args); onTransaction?.(value); return value; };
    });
    return request;
  } };
  const make = () => new ManagedResultJournal({ indexedDB, runId: "run-A", incarnation: () => "browser-A", newId: () => "journal-A" });
  const expected = epoch => ({ previousWorkerBootId: epoch === 1 ? "worker-A" : "worker-B", browserIncarnation: "browser-A", expectedJournalId: "journal-A", expectedWorkerEpoch: epoch });
  return { factory, databases, make, expected, onTransaction: hook => { onTransaction = hook; } };
}

test("initial and same-worker opens preserve journal; replacement changes epoch without creating grants", async () => {
  const f = fixture(), first = f.make();
  await first.claimWorker("worker-A"); await first.commitResults([page()]);
  assert.deepEqual(first.identity(), { version: 1, browserIncarnation: "browser-A", journalId: "journal-A", workerEpoch: 1 });
  assert.equal((await first.claimWorker("worker-A")).workerEpoch, 1);
  const second = f.make();
  await assert.rejects(second.claimWorker("worker-B"), /explicit worker recovery/);
  const restored = await second.claimWorker("worker-B", f.expected(1));
  assert.deepEqual(restored.records, [page()]); assert.equal(restored.workerEpoch, 2);
  assert.equal(Object.hasOwn(restored.records[0], "deliveryId"), false, "stored provenance is not a runtime capability");
  await assert.rejects(first.revoke("result-A"), /writer was retired/);
  assert.deepEqual(second.snapshot().state.records, [page()]);
});

test("a replacement cannot initialize a missing journal or accept an incorrect original identity", async () => {
  const f = fixture(), first = f.make();
  await assert.rejects(first.claimWorker("worker-B", f.expected(1)), /does not match/);
  await first.claimWorker("worker-A");
  for (const fields of [{ expectedJournalId: "other" }, { expectedWorkerEpoch: 2 }, { previousWorkerBootId: "other" }, { browserIncarnation: "other" }])
    await assert.rejects(f.make().claimWorker("worker-B", { ...f.expected(1), ...fields }), /does not match/);
  assert.equal(first.snapshot().state.workerEpoch, 1);
});

test("native view intent is committed before attach and unconfirmed intent blocks replacement", async () => {
  const f = fixture(), first = f.make(); await first.claimWorker("worker-A"); await first.commitResults([page()]);
  await first.beginView(owner());
  await assert.rejects(f.make().claimWorker("worker-B", f.expected(1)), /attachment outcome is unknown/);
  await first.attachedView("view-A");
  const second = f.make(), recovered = await second.claimWorker("worker-B", f.expected(1));
  assert.deepEqual(recovered.views, [{ ...owner(), phase: "attached" }]);
  await second.finishView("view-A"); assert.deepEqual(second.snapshot().state.views, []);
});

test("revoking a result never removes its native cleanup owner or lets a successor bypass it", async () => {
  const f = fixture(), journal = f.make(); await journal.claimWorker("worker-A"); await journal.commitResults([page()]);
  await journal.beginView(owner()); await journal.attachedView("view-A"); await journal.revoke("result-A");
  assert.deepEqual(journal.snapshot().state.records, []); assert.equal(journal.snapshot().state.views.length, 1);
  await assert.rejects(journal.commitResults([{ ...page(), recordId: "result-B" }]), /native cleanup still owns/);
  await journal.finishView("view-A"); await journal.commitResults([{ ...page(), recordId: "result-B" }]);
  await journal.revoke("result-A"); assert.equal(journal.snapshot().state.records[0].recordId, "result-B");
});

test("current document advance is durable and exact revision protects a successor from late native validation", async () => {
  const f = fixture(), first = f.make(); await first.claimWorker("worker-A"); await first.commitResults([page()]);
  await first.advance("result-A", 1, "document-B");
  await assert.rejects(first.advance("result-A", 1, "document-C"), /revision was retired/);
  const second = f.make(), recovered = await second.claimWorker("worker-B", f.expected(1));
  assert.equal(recovered.records[0].originalDocument, "document-A");
  assert.equal(recovered.records[0].currentDocument, "document-B"); assert.equal(recovered.records[0].revision, 2);
  await assert.rejects(second.beginView(owner()), /no exact original result owner/);
  await second.beginView({ ...owner(), documentId: "document-B" });
});

test("a write request success followed by transaction abort is not a committed result or cleanup", async () => {
  const f = fixture(), journal = f.make(); await journal.claimWorker("worker-A");
  let putSucceeded = false;
  f.onTransaction(transaction => {
    const objectStore = transaction.objectStore;
    transaction.objectStore = function (...args) {
      const store = Reflect.apply(objectStore, this, args), put = store.put;
      store.put = function (...args) {
        const request = Reflect.apply(put, this, args);
        request.addEventListener("success", () => { putSucceeded = true; transaction.abort(); }); return request;
      }; return store;
    };
  });
  await assert.rejects(journal.commitResults([page()]), /transaction aborted/);
  assert.equal(putSucceeded, true); assert.deepEqual(journal.snapshot().state.records, []);
  f.onTransaction(undefined);
  const second = f.make(); assert.deepEqual((await second.claimWorker("worker-B", f.expected(1))).records, []);
});

test("authority revoked while opening storage prevents the original queued commit", async () => {
  const f = fixture(), journal = f.make(); await journal.claimWorker("worker-A");
  let current = true;
  f.onTransaction(() => { current = false; });
  await assert.rejects(journal.commitResults([page()], () => { if (!current) throw Error("original authority revoked"); }), /authority revoked/);
  assert.deepEqual(journal.snapshot().state.records, []);
});

test("corrupt or extra persisted records fail closed and are not repaired", async () => {
  const f = fixture(), journal = f.make(); await journal.claimWorker("worker-A");
  const db = await requestResult(f.factory.open(databaseName, 1));
  await new Promise((resolve, reject) => { const transaction = db.transaction(storeName, "readwrite"); transaction.objectStore(storeName).put({}, "foreign"); transaction.oncomplete = resolve; transaction.onabort = reject; });
  await assert.rejects(f.make().claimWorker("worker-B", f.expected(1)), /corrupt or extra/);
  db.close();
});

test("an incompatible existing store rejects after its actual transaction abort without hanging or repairing it", async t => {
  for (const kind of ["keyPath", "autoIncrement", "index"]) await t.test(kind, async () => {
    const f = fixture(), opening = f.factory.open(databaseName, 1);
    opening.onupgradeneeded = () => {
      const store = opening.result.createObjectStore(storeName,
        kind === "keyPath" ? { keyPath: "foreign" } : kind === "autoIncrement" ? { autoIncrement: true } : undefined);
      if (kind === "index") store.createIndex("foreign", "foreign");
    };
    const original = await requestResult(opening); original.close();
    let aborted = false, timer;
    f.onTransaction(transaction => transaction.addEventListener("abort", () => { aborted = true; }));
    const journal = f.make();
    try {
      await assert.rejects(Promise.race([
        journal.claimWorker("worker-A"),
        new Promise((_, reject) => { timer = setTimeout(() => reject(Error("journal operation remained pending")), 1000); })
      ]), /unexpected journal schema/);
      assert.equal(aborted, true, "rejection follows the actual abort event");
      assert.equal(journal.writer, undefined); assert.equal(journal.state, null);
      assert.equal(journal.pending.size, 0);
      const transaction = journal.db.transaction(storeName, "readonly"), store = transaction.objectStore(storeName);
      assert.equal(await requestResult(store.count()), 0);
      assert.equal(store.keyPath, kind === "keyPath" ? "foreign" : null);
      assert.equal(store.autoIncrement, kind === "autoIncrement");
      assert.equal(store.indexNames.contains("foreign"), kind === "index");
    } finally { clearTimeout(timer); journal.db?.close(); }
  });
});

test("the next run may create provenance only in a different actual browser incarnation", async () => {
  const f = fixture(), first = f.make(); await first.claimWorker("worker-A"); await first.commitResults([page()]);
  const invalid = new ManagedResultJournal({ indexedDB: f.factory, runId: "run-B", incarnation: () => "browser-A", newId: () => "journal-B" });
  await assert.rejects(invalid.claimWorker("worker-B"), /another run owns/);
  const next = new ManagedResultJournal({ indexedDB: f.factory, runId: "run-B", incarnation: () => "browser-B", newId: () => "journal-B" });
  const state = await next.claimWorker("worker-B"); assert.deepEqual(state.records, []); assert.deepEqual(state.views, []);
  await assert.rejects(first.revoke("result-A"), /writer was retired/);
});
