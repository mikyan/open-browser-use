const stale = () => new Error("OBU_HUMAN_PAGE_STALE: original browser page choice changed");
const identityKeys = ["tabId", "targetId", "documentId", "incarnation", "windowId", "groupId", "pinned", "policyGeneration", "policyRevision"];
const same = (left, right) => identityKeys.every(key => left[key] === right[key]);
const listingUnavailable = new Error("OBU_HUMAN_PAGE_UNAVAILABLE: page inspection is temporarily unavailable");

// A directory is not task membership. Only an explicit, paused selection may
// publish a real result, through the same durable journal as task deliverables.
export class ManagedHumanPages {
  constructor({ check, available = () => true, assertPaused, listTabs, read, fence, results, released = () => {}, limit = 256, newId = () => crypto.randomUUID() }) {
    Object.assign(this, { check, available, assertPaused, listTabs, read, fence, results, released, limit, newId });
    this.choices = new Map(); this.pending = new Set(); this.closed = false;
    this.listing = null; this.selecting = false; this.cleanupError = null;
  }

  assertOpen() { this.check(); if (this.closed) throw stale(); }

  retain(promise) {
    this.pending.add(promise);
    promise.then(() => this.pending.delete(promise), () => this.pending.delete(promise));
    return promise;
  }

  list() {
    try { this.assertOpen(); } catch (error) { return Promise.reject(error); }
    if (this.listing) return this.listing;
    const operation = this.retain(this.readList().catch(error => {
      if (error === listingUnavailable) return [];
      throw error;
    }));
    this.listing = operation;
    operation.then(() => { this.listing = null; }, () => { this.listing = null; });
    return operation;
  }

  async readList() {
    const check = () => { this.assertOpen(); if (!this.available()) throw listingUnavailable; };
    const retain = promise => this.retain(promise);
    check();
    const tabs = await this.listTabs(check, retain);
    check();
    const visible = [], seen = new Set();
    for (const tabId of tabs) {
      if (visible.length >= this.limit) break;
      let actual;
      try { actual = await this.read(tabId, check, retain); }
      catch { check(); continue; } // Unsupported, closed, or policy-blocked pages are not choices.
      check();
      let choice = this.choices.get(tabId);
      if (!choice || !same(choice.actual, actual)) {
        if (!choice && this.choices.size >= this.limit) this.choices.delete([...this.choices.keys()].find(id => !seen.has(id)));
        choice = { id: this.newId(), actual: Object.freeze({ ...actual }) };
        this.choices.set(tabId, choice);
      }
      seen.add(tabId);
      visible.push({ id: tabId, pageSelectionId: choice.id, title: actual.title, url: actual.url,
        kind: "browser", watchable: true, takeover: true });
    }
    check();
    for (const tabId of this.choices.keys()) if (!seen.has(tabId)) this.choices.delete(tabId);
    return visible.filter(row => this.choices.get(row.id)?.id === row.pageSelectionId);
  }

  select(tabId, pageSelectionId, { check = () => {} } = {}) {
    try {
      this.assertOpen(); check(); this.assertPaused();
      const choice = this.choices.get(tabId);
      if (!Number.isSafeInteger(tabId) || tabId < 0 || !choice || choice.id !== pageSelectionId || this.selecting) throw stale();
      this.selecting = true;
      const operation = this.retain(this.retainPage(choice, check));
      operation.then(() => { this.selecting = false; }, () => { this.selecting = false; });
      return operation;
    } catch (error) { return Promise.reject(error); }
  }

  async retainPage(choice, callerCheck) {
    const tabId = choice.actual.tabId, original = this.fence(tabId);
    const retain = promise => this.retain(promise);
    let record, published = false;
    // Page continuity is independent of the channel. A completed transaction
    // must be published even when its caller disconnects before receiving ACK.
    const pageCheck = () => { original.check(); };
    const admitted = () => {
      this.assertOpen(); callerCheck(); this.assertPaused(); pageCheck();
      if (this.choices.get(tabId) !== choice) throw stale();
    };
    try {
      admitted();
      const actual = await this.read(tabId, admitted, retain);
      admitted(); if (!same(choice.actual, actual)) throw stale();
      const existing = this.results.records.get(tabId);
      if (existing) {
        this.results.validate(existing, actual);
        this.choices.delete(tabId);
        return { tabId, pageSelectionId: choice.id, deliveryId: existing.deliveryId, retained: true };
      }
      record = this.results.reserve(actual);
      const final = await this.read(tabId, admitted, retain);
      admitted(); if (!same(actual, final)) throw stale();
      this.results.stage(record, final, actual);
      await retain(this.results.durableCommit([record], admitted));
      pageCheck();
      this.results.publish([record]); published = true;
      this.choices.delete(tabId);
      this.assertOpen(); callerCheck(); this.assertPaused();
      return { tabId, pageSelectionId: choice.id, deliveryId: record.deliveryId, retained: true };
    } catch (error) {
      if (record && !published) {
        this.results.revoke(tabId, record);
        if (record.revokedPromise) {
          try { await retain(record.revokedPromise); }
          catch (cleanup) { this.cleanupError ??= cleanup; throw cleanup; }
        }
      }
      throw error;
    } finally { original.release(); }
  }

  invalidate(tabId) { this.choices.delete(tabId); }

  revoke() {
    this.closed = true; this.choices.clear();
    // In-flight transactions still own their original page fences until settle.
    if (!this.pending.size) this.released();
  }

  async drain() {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
    if (this.closed) this.released();
    if (this.cleanupError) throw this.cleanupError;
  }
}
