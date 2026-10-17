import assert from "node:assert/strict";
import test from "node:test";
import { ManagedResultPages } from "./managed-result-pages.js";

function fixture(limit = 2) {
  let n = 0, incarnation = {};
  const registry = new ManagedResultPages({ runId: "run", limit, isCurrent: value => value === incarnation, newId: () => `delivery-${++n}` });
  const page = { tabId: 7, targetId: "target", documentId: "A", incarnation, windowId: 1, groupId: 10, pinned: false };
  const publish = (candidate = page) => { const record = registry.reserve(candidate); registry.stage(record, candidate, candidate); registry.publish([record]); return record; };
  return { registry, page, publish, restart: () => { incarnation = {}; } };
}

test("result authority requires the original final native proof and atomic publication", () => {
  const f = fixture(), record = f.registry.reserve(f.page);
  assert.deepEqual(f.registry.entries(), []);
  assert.throws(() => f.registry.publish([record]), /STALE/);
  assert.throws(() => f.registry.stage(record, { ...f.page, documentId: "B" }, f.page), /STALE/);
  f.registry.stage(record, f.page, f.page);
  assert.throws(() => f.registry.get(7, record.deliveryId), /STALE/);
  f.registry.publish([record]); assert.equal(f.registry.get(7, record.deliveryId), record);
});

test("partial validation cannot publish a batch and exact rollback cannot revoke its successor", () => {
  const f = fixture(), first = f.registry.reserve(f.page), second = f.registry.reserve({ ...f.page, tabId: 8 });
  f.registry.stage(first, f.page, f.page);
  assert.throws(() => f.registry.publish([first, second]), /STALE/);
  assert.deepEqual(f.registry.entries(), []);
  f.registry.revoke(7, first); const successor = f.publish();
  assert.equal(f.registry.revoke(7, first), false); assert.equal(f.registry.get(7, successor.deliveryId), successor);
  assert.throws(() => f.registry.get(7, first.deliveryId), /STALE/);
});

test("document advance requires exact target, position and incarnation; restart restores no record", () => {
  const f = fixture(), record = f.publish();
  for (const mutation of [{ targetId: "replacement" }, { windowId: 2 }, { groupId: 30 }, { pinned: true }, { incarnation: {} }])
    assert.throws(() => f.registry.validate(record, { ...f.page, ...mutation, documentId: "B" }, { advance: true }), /STALE/);
  assert.equal(record.currentDocument, "A");
  f.registry.validate(record, { ...f.page, documentId: "B" }, { advance: true });
  assert.equal(record.currentDocument, "B");
  assert.throws(() => f.registry.validate(record, f.page), /STALE/);
  f.restart(); assert.throws(() => f.registry.get(7, record.deliveryId), /STALE/);
  assert.deepEqual(fixture().registry.entries(), []);
});

test("planned grouping is allowed only before final verification and capacity is bounded", () => {
  const f = fixture(1), record = f.registry.reserve(f.page);
  f.registry.placementChanged(7); f.registry.stage(record, f.page, f.page);
  assert.throws(() => f.registry.reserve({ ...f.page, tabId: 8 }), /CAPACITY/);
  f.registry.placementChanged(7); assert.throws(() => f.registry.publish([record]), /STALE/);
  assert.equal(f.registry.records.size, 0);
});
