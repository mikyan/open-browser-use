const changed = () => new Error("OBU_MANAGED_RESULT_STALE: original delivered page identity or placement changed");
const positionKeys = ["windowId", "groupId", "pinned"];
const ADVANCE_LIMIT = 64;

// Grants remain worker-local. The separate journal records committed lineage,
// not capabilities; explicit recovery must verify the original live page and
// issue a fresh delivery ID. Presentation markers never enter this path.
export class ManagedResultPages {
  constructor({ runId, isCurrent, journal = null, limit = 256, newId = () => crypto.randomUUID() }) {
    Object.assign(this, { runId, isCurrent, journal, limit, newId });
    this.records = new Map();
    this.advances = new WeakMap();
    this.pending = new Set(); this.error = null;
  }

  reserve(candidate) {
    if (!this.runId || !this.isCurrent(candidate.incarnation) || !Number.isSafeInteger(candidate.tabId) || candidate.tabId < 0 ||
        typeof candidate.targetId !== "string" || !candidate.targetId || typeof candidate.documentId !== "string" || !candidate.documentId)
      throw changed();
    if (this.records.has(candidate.tabId) || this.records.size >= this.limit)
      throw new Error("OBU_MANAGED_RESULT_CAPACITY: original result record must be released before another delivery");
    const record = { deliveryId: this.newId(), runId: this.runId, tabId: candidate.tabId, targetId: candidate.targetId,
      incarnation: candidate.incarnation, originalDocument: candidate.documentId, currentDocument: candidate.documentId,
      phase: "captured", invalid: false, position: null, recordId: this.newId(), revision: 1 };
    this.records.set(record.tabId, record);
    return record;
  }

  assert(record, { published = true } = {}) {
    this.assertSettled();
    if (!record || record.invalid || this.records.get(record.tabId) !== record || record.runId !== this.runId ||
        !this.isCurrent(record.incarnation) || published && record.phase !== "published") throw changed();
  }

  assertSettled() { if (this.error) throw this.error; }

  track(promise) {
    this.pending.add(promise);
    promise.then(() => this.pending.delete(promise), error => { this.error ??= error; this.pending.delete(promise); });
    return promise;
  }

  async drain() {
    while (this.pending.size) await Promise.all([...this.pending]);
    this.assertSettled();
  }

  durableCommit(records, check) {
    if (!this.journal || !records.length) return Promise.resolve();
    const assertAll = () => { check(); for (const record of records) this.assert(record, { published: false }); };
    assertAll();
    const rows = records.map(record => ({ recordId: record.recordId, revision: record.revision, tabId: record.tabId,
      targetId: record.targetId, originalDocument: record.originalDocument, currentDocument: record.currentDocument, position: record.position }));
    const committed = this.journal.commitResults(rows, assertAll);
    for (const record of records) record.commitPromise = committed;
    // This Promise follows IDB transaction completion, not request success.
    // Once committed, a lost caller ACK does not undo the original delivery.
    return committed;
  }

  async advance(record, actual, check) {
    check(); this.validate(record, actual, { advance: true, apply: false });
    actual = { ...actual };
    const revision = record.revision, documentId = record.currentDocument;
    let queue = this.advances.get(record);
    if (!queue) { queue = { tail: Promise.resolve(), size: 0 }; this.advances.set(record, queue); }
    if (queue.size >= ADVANCE_LIMIT) throw new Error("OBU_MANAGED_RESULT_CAPACITY: original document advances are still pending");
    queue.size++;
    const operation = queue.tail.then(async () => {
      const verify = () => { check(); this.validate(record, actual, { advance: true, apply: false }); };
      verify();
      if (record.currentDocument !== actual.documentId) {
        // A concurrent proof may reuse the same committed document, but an old
        // different-document snapshot cannot advance from a newer lineage.
        if (record.revision !== revision || record.currentDocument !== documentId) throw changed();
        if (this.journal) {
          let withdrawn, row;
          try {
            row = await this.journal.advance(record.recordId, revision, actual.documentId, () => {
              try { verify(); } catch (error) { withdrawn = error; throw error; }
            });
          } catch (error) {
            // A known permission withdrawal aborts the original transaction.
            // Unknown storage failure remains terminal; never retry its CAS.
            if (error !== withdrawn) this.error ??= error;
            throw error;
          }
          // The actual transaction completed. Preserve its lineage even if the
          // original caller or record was retired before this continuation.
          record.revision = row.revision;
          record.currentDocument = row.currentDocument;
        } else record.currentDocument = actual.documentId;
      }
      check(); this.validate(record, actual);
    });
    // Cleanup waits for the full original operation, not a caller's permission
    // result. Expected stale callers do not poison a live successor's queue.
    const settled = operation.then(() => {}, () => {});
    queue.tail = settled;
    this.pending.add(settled);
    settled.then(() => { queue.size--; this.pending.delete(settled); });
    return operation;
  }

  restore(row, actual) {
    if (actual.targetId !== row.targetId || actual.documentId !== row.currentDocument ||
        positionKeys.some(key => actual[key] !== row.position[key])) throw changed();
    const record = this.reserve(actual);
    record.recordId = row.recordId; record.revision = row.revision;
    record.originalDocument = row.originalDocument; record.currentDocument = row.currentDocument;
    record.position = Object.freeze({ ...row.position }); record.phase = "published";
    record.commitPromise = Promise.resolve();
    return record;
  }

  stage(record, actual, expectedPosition) {
    this.assert(record, { published: false });
    if (record.phase !== "captured" || actual.tabId !== record.tabId || actual.targetId !== record.targetId ||
        actual.documentId !== record.originalDocument || actual.incarnation !== record.incarnation ||
        positionKeys.some(key => actual[key] !== expectedPosition[key])) throw changed();
    record.position = Object.freeze(Object.fromEntries(positionKeys.map(key => [key, actual[key]])));
    record.phase = "verified";
  }

  publish(records) {
    for (const record of records) {
      this.assert(record, { published: false });
      if (record.phase !== "verified") throw changed();
    }
    for (const record of records) record.phase = "published";
  }

  get(tabId, deliveryId) {
    const record = this.records.get(tabId);
    this.assert(record);
    if (typeof deliveryId !== "string" || !deliveryId || record.deliveryId !== deliveryId) throw changed();
    return record;
  }

  validate(record, actual, { advance = false, apply = true } = {}) {
    this.assert(record);
    if (actual.tabId !== record.tabId || actual.targetId !== record.targetId || actual.incarnation !== record.incarnation ||
        typeof actual.documentId !== "string" || !actual.documentId || positionKeys.some(key => actual[key] !== record.position[key]) ||
        !advance && actual.documentId !== record.currentDocument) throw changed();
    if (advance && apply) record.currentDocument = actual.documentId;
  }

  entries() { return [...this.records.values()].filter(record => record.phase === "published" && !record.invalid); }

  revoke(tabId, expected) {
    const record = this.records.get(tabId);
    if (!record || expected && record !== expected) return false;
    record.invalid = true;
    this.records.delete(tabId);
    if (this.journal && record.commitPromise) {
      // Queue after this record's original commit, even if the caller has not
      // received its ACK. Never delete a successor by tab number.
      record.revokedPromise = this.track(Promise.all([record.commitPromise.catch(() => {}), this.advances.get(record)?.tail])
        .then(() => this.journal.revoke(record.recordId)));
    }
    return true;
  }

  placementChanged(tabId) {
    const record = this.records.get(tabId);
    // Finalize may perform its own planned grouping before the final native
    // snapshot. Once verified, even a move-and-return withdraws that record.
    if (record && record.phase !== "captured") this.revoke(tabId, record);
  }
}
