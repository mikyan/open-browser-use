import assert from "node:assert/strict";
import test from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { ManagedResultJournal } from "./managed-result-journal.js";
import { ManagedResultPages } from "./managed-result-pages.js";

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function fixture(t) {
  const indexedDB = new IDBFactory(), incarnation = {}, journal = new ManagedResultJournal({
    indexedDB, runId: "run-A", incarnation: () => "browser-A", newId: () => "journal-A"
  });
  await journal.claimWorker("worker-A");
  t.after(() => journal.db.close());
  let id = 0;
  const pages = new ManagedResultPages({ runId: "run-A", journal, isCurrent: value => value === incarnation, newId: () => `id-${++id}` });
  const page = { tabId: 7, targetId: "target-A", documentId: "document-A", incarnation, windowId: 1, groupId: -1, pinned: false };
  const record = pages.reserve(page);
  pages.stage(record, page, page);
  await pages.durableCommit([record], () => {});
  pages.publish([record]);
  const originalTransaction = journal.db.transaction;
  let onTransaction, writes = 0;
  journal.db.transaction = function (...args) {
    const transaction = Reflect.apply(originalTransaction, this, args);
    writes++;
    onTransaction?.(transaction);
    return transaction;
  };
  return { pages, journal, record, page, next: documentId => ({ ...page, documentId }),
    writes: () => writes, onTransaction: hook => { onTransaction = hook; } };
}

test("concurrent original callers share one durable same-document advance", async t => {
  const f = await fixture(t), next = f.next("document-B");
  await Promise.all([f.pages.advance(f.record, next, () => {}), f.pages.advance(f.record, next, () => {})]);
  assert.equal(f.writes(), 1);
  assert.equal(f.record.revision, 2);
  assert.equal(f.record.currentDocument, "document-B");
  assert.equal(f.journal.snapshot().state.records[0].currentDocument, "document-B");
  assert.equal(f.journal.snapshot().state.records[0].revision, 2);
});

test("actual commit updates lineage before rejecting the retired caller, and a live caller can reuse it", async t => {
  const f = await fixture(t), next = f.next("document-B");
  let live = true;
  f.onTransaction(transaction => transaction.addEventListener("complete", () => { live = false; }));
  const check = () => { if (!live) throw Error("original caller retired"); };
  const retired = f.pages.advance(f.record, next, check);
  const liveCaller = f.pages.advance(f.record, next, () => {});
  const results = await Promise.allSettled([retired, liveCaller]);
  assert.equal(results[0].status, "rejected");
  assert.match(results[0].reason.message, /caller retired/);
  assert.equal(f.record.currentDocument, "document-B", "actual durable receipt survives the old caller's retirement");
  assert.equal(f.record.revision, 2);
  assert.equal(results[1].status, "fulfilled");
  assert.equal(f.writes(), 1);
  await f.pages.drain();
  assert.equal(f.pages.get(7, f.record.deliveryId), f.record);
});

test("a queued different-document snapshot cannot roll back the newer durable lineage", async t => {
  const f = await fixture(t);
  const results = await Promise.allSettled([
    f.pages.advance(f.record, f.next("document-B"), () => {}),
    f.pages.advance(f.record, f.next("document-C"), () => {})
  ]);
  assert.equal(results[0].status, "fulfilled");
  assert.equal(results[1].status, "rejected");
  assert.match(results[1].reason.message, /RESULT_STALE/);
  assert.equal(f.writes(), 1, "stale queued callers do not submit another CAS");
  assert.equal(f.journal.snapshot().state.records[0].currentDocument, "document-B");
  await f.pages.advance(f.record, f.next("document-C"), () => {});
  assert.equal(f.record.revision, 3, "a newly admitted current snapshot can advance");
});

test("a stale queued caller cannot obtain permission from another caller's durable receipt", async t => {
  const f = await fixture(t);
  let live = true;
  f.onTransaction(transaction => transaction.addEventListener("complete", () => { live = false; }));
  const first = f.pages.advance(f.record, f.next("document-B"), () => {});
  const stale = f.pages.advance(f.record, f.next("document-B"), () => { if (!live) throw Error("queued caller retired"); });
  const results = await Promise.allSettled([first, stale]);
  assert.equal(results[0].status, "fulfilled");
  assert.equal(results[1].status, "rejected");
  assert.match(results[1].reason.message, /queued caller retired/);
  assert.equal(f.writes(), 1);
  assert.equal(f.record.currentDocument, "document-B");
  await f.pages.drain();
});

test("a caller withdrawal before the real write aborts only that operation and preserves a live queued caller", async t => {
  const f = await fixture(t);
  let live = true, aborted = false;
  f.onTransaction(transaction => {
    f.onTransaction(undefined);
    live = false;
    transaction.addEventListener("abort", () => { aborted = true; });
  });
  const first = f.pages.advance(f.record, f.next("document-B"), () => { if (!live) throw Error("original caller retired"); });
  const second = f.pages.advance(f.record, f.next("document-B"), () => {});
  const results = await Promise.allSettled([first, second]);
  assert.equal(results[0].status, "rejected");
  assert.match(results[0].reason.message, /original caller retired/);
  assert.equal(aborted, true);
  assert.equal(results[1].status, "fulfilled");
  assert.equal(f.writes(), 2, "the first transaction really aborted; the second caller owns its own CAS");
  assert.equal(f.record.revision, 2);
  assert.equal(f.journal.snapshot().state.records[0].currentDocument, "document-B");
  await f.pages.drain();
});

test("revoke waits for the original in-flight durable receipt before deleting that exact record", async t => {
  const f = await fixture(t), committed = deferred(), receipt = deferred();
  const advance = f.journal.advance.bind(f.journal);
  f.journal.advance = (...args) => advance(...args).then(async row => {
    committed.resolve(); await receipt.promise; return row;
  });
  const advancing = f.pages.advance(f.record, f.next("document-B"), () => {});
  const observed = advancing.catch(error => error);
  await committed.promise;
  assert.equal(f.journal.snapshot().state.records[0].revision, 2);
  assert.equal(f.pages.revoke(7, f.record), true);
  assert.throws(() => f.pages.get(7, f.record.deliveryId), /STALE/);
  let drained = false;
  const drain = f.pages.drain().then(() => { drained = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(drained, false);
  assert.equal(f.writes(), 1, "revoke does not overtake the real advance receipt");
  receipt.resolve();
  assert.match((await observed).message, /STALE/);
  await drain;
  assert.equal(f.record.currentDocument, "document-B", "even the retired record reflects its actual receipt");
  assert.equal(f.record.revision, 2);
  assert.equal(f.writes(), 2);
  assert.deepEqual(f.journal.snapshot().state.records, []);
  assert.equal(f.pages.pending.size, 0);
  assert.equal(f.journal.pending.size, 0);
});

test("revoke after actual put success cannot leave a committed result behind", async t => {
  const f = await fixture(t);
  let putSucceeded = false;
  f.onTransaction(transaction => {
    f.onTransaction(undefined);
    const objectStore = transaction.objectStore;
    transaction.objectStore = function (...args) {
      const store = Reflect.apply(objectStore, this, args), put = store.put;
      store.put = function (...values) {
        const request = Reflect.apply(put, this, values);
        request.addEventListener("success", () => { putSucceeded = true; f.pages.revoke(7, f.record); });
        return request;
      };
      return store;
    };
  });
  await assert.rejects(f.pages.advance(f.record, f.next("document-B"), () => {}), /STALE/);
  await f.pages.drain();
  assert.equal(putSucceeded, true);
  assert.equal(f.record.currentDocument, "document-B");
  assert.equal(f.record.revision, 2);
  assert.deepEqual(f.journal.snapshot().state.records, []);
});

test("an actual storage failure is retained and never retried by queued or later callers", async t => {
  const f = await fixture(t);
  let putSucceeded = false, aborted = false;
  f.onTransaction(transaction => {
    f.onTransaction(undefined);
    transaction.addEventListener("abort", () => { aborted = true; });
    const objectStore = transaction.objectStore;
    transaction.objectStore = function (...args) {
      const store = Reflect.apply(objectStore, this, args), put = store.put;
      store.put = function (...values) {
        const request = Reflect.apply(put, this, values);
        request.addEventListener("success", () => { putSucceeded = true; transaction.abort(); });
        return request;
      };
      return store;
    };
  });
  const results = await Promise.allSettled([
    f.pages.advance(f.record, f.next("document-B"), () => {}),
    f.pages.advance(f.record, f.next("document-B"), () => {})
  ]);
  assert.equal(putSucceeded, true); assert.equal(aborted, true);
  assert.equal(results[0].status, "rejected"); assert.equal(results[1].status, "rejected");
  assert.match(results[0].reason.message, /transaction aborted/);
  assert.equal(results[1].reason, results[0].reason, "the actual failure survives queue settlement");
  await assert.rejects(f.pages.advance(f.record, f.next("document-B"), () => {}), error => error === results[0].reason);
  await assert.rejects(f.pages.drain(), error => error === results[0].reason);
  assert.throws(() => f.pages.get(7, f.record.deliveryId), error => error === results[0].reason);
  assert.equal(f.writes(), 1);
  assert.equal(f.record.currentDocument, "document-A");
  assert.equal(f.record.revision, 1);
  assert.equal(f.journal.snapshot().state.records[0].currentDocument, "document-A");
});

test("the per-record queue is bounded while the original actual receipt remains pending", async t => {
  const f = await fixture(t), committed = deferred(), receipt = deferred();
  const advance = f.journal.advance.bind(f.journal);
  f.journal.advance = (...args) => advance(...args).then(async row => {
    committed.resolve(); await receipt.promise; return row;
  });
  const calls = Array.from({ length: 64 }, () => f.pages.advance(f.record, f.next("document-B"), () => {}));
  await committed.promise;
  await assert.rejects(f.pages.advance(f.record, f.next("document-B"), () => {}), /CAPACITY/);
  assert.equal(f.pages.pending.size, 64);
  receipt.resolve();
  await Promise.all(calls);
  await f.pages.drain();
  assert.equal(f.writes(), 1);
  assert.equal(f.pages.pending.size, 0);
  await f.pages.advance(f.record, f.next("document-C"), () => {});
  assert.equal(f.record.revision, 3);
});
