const changed = () => new Error("OBU_MANAGED_RESULT_STALE: original delivered page identity or placement changed");
const positionKeys = ["windowId", "groupId", "pinned"];

// User result authority is deliberately worker-local. Neither a persisted
// presentation marker nor a group title can create or restore one of these
// records. Only the original successful finalize transaction may publish it.
export class ManagedResultPages {
  constructor({ runId, isCurrent, limit = 256, newId = () => crypto.randomUUID() }) {
    Object.assign(this, { runId, isCurrent, limit, newId });
    this.records = new Map();
  }

  reserve(candidate) {
    if (!this.runId || !this.isCurrent(candidate.incarnation) || !Number.isSafeInteger(candidate.tabId) || candidate.tabId < 0 ||
        typeof candidate.targetId !== "string" || !candidate.targetId || typeof candidate.documentId !== "string" || !candidate.documentId)
      throw changed();
    if (this.records.has(candidate.tabId) || this.records.size >= this.limit)
      throw new Error("OBU_MANAGED_RESULT_CAPACITY: original result record must be released before another delivery");
    const record = { deliveryId: this.newId(), runId: this.runId, tabId: candidate.tabId, targetId: candidate.targetId,
      incarnation: candidate.incarnation, originalDocument: candidate.documentId, currentDocument: candidate.documentId,
      phase: "captured", invalid: false, position: null };
    this.records.set(record.tabId, record);
    return record;
  }

  assert(record, { published = true } = {}) {
    if (!record || record.invalid || this.records.get(record.tabId) !== record || record.runId !== this.runId ||
        !this.isCurrent(record.incarnation) || published && record.phase !== "published") throw changed();
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

  validate(record, actual, { advance = false } = {}) {
    this.assert(record);
    if (actual.tabId !== record.tabId || actual.targetId !== record.targetId || actual.incarnation !== record.incarnation ||
        typeof actual.documentId !== "string" || !actual.documentId || positionKeys.some(key => actual[key] !== record.position[key]) ||
        !advance && actual.documentId !== record.currentDocument) throw changed();
    if (advance) record.currentDocument = actual.documentId;
  }

  entries() { return [...this.records.values()].filter(record => record.phase === "published" && !record.invalid); }

  revoke(tabId, expected) {
    const record = this.records.get(tabId);
    if (!record || expected && record !== expected) return false;
    record.invalid = true;
    this.records.delete(tabId);
    return true;
  }

  placementChanged(tabId) {
    const record = this.records.get(tabId);
    // Finalize may perform its own planned grouping before the final native
    // snapshot. Once verified, even a move-and-return withdraws that record.
    if (record && record.phase !== "captured") this.revoke(tabId, record);
  }
}
