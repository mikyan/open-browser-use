// Optional visual work owns no debugger/tab authority. Its actual Chrome API
// Promises nevertheless outlive display timeouts and must precede final hide.
const ownerKeys = ["tabId", "session_id", "turn_id", "control_epoch"];
const sameOwner = (a, b) => ownerKeys.every(key => a[key] === b[key]);
const expired = () => new Error("OBU_VISUAL_EXPIRED: original visual producer was retired");
const cleanupFailed = cause => new Error("OBU_VISUAL_CLEANUP_FAILED: original document hide was not acknowledged", { cause });
const validToken = value => typeof value === "string" && value.length > 0 && value.length <= 128;

export class VisualDeliveries {
  constructor({ hide, maxOwners = 128, maxPending = 512 }) {
    this.hide = hide;
    this.maxOwners = maxOwners;
    this.maxPending = maxPending;
    this.records = new Set();
    this.pending = new Set();
    this.cleanups = new Set();
    this.retirementSignals = new WeakMap();
  }

  ticket(scope, check = () => {}) {
    check();
    let record = [...this.records].find(value => !value.closed && sameOwner(value.scope, scope));
    if (!record) {
      if (this.records.size >= this.maxOwners) throw expired();
      record = { scope: Object.freeze({ ...scope }), documents: new Set(), closed: false, removed: false, cleanupState: null, promise: null };
      this.records.add(record);
    }
    const original = Object.freeze({ ...scope });
    let documentId;
    let state;
    const retain = value => {
      if (record.documents.has(value)) return;
      if (record.documents.size >= 128) throw expired();
      record.documents.add(value);
    };
    const assert = () => { if (record.closed || state?.retired) throw expired(); check(); };
    return {
      scope: original,
      check: assert,
      get documentId() { return documentId; },
      get receiverToken() { return state?.token; },
      bind: async id => {
        assert();
        if (typeof id !== "string" || !id || (documentId !== undefined && documentId !== id)) throw expired();
        documentId = id;
        state ??= { documentId, token: null, needsHide: false, hidden: false, retired: false };
        // A successor's optional display may wait here, never native input.
        // Failed cleanup is not retried by opening a new visual producer.
        const barriers = [...this.cleanups].filter(value => value !== record && value.scope.tabId === original.tabId && [...value.documents].some(item => item.documentId === id)).map(value => value.promise);
        await Promise.all(barriers);
        assert();
        return { documentId: id };
      },
      acceptToken: response => {
        assert();
        if (documentId === undefined || response?.ok !== true || !validToken(response.receiverToken)) throw expired();
        if (state.token && state.token !== response.receiverToken) throw expired();
        const existing = [...record.documents].find(item => item.documentId === documentId && item.token === response.receiverToken);
        if (existing) {
          existing.needsHide ||= state.needsHide;
          if (existing !== state) { record.documents.delete(state); state = existing; }
        } else {
          retain(state); state.token = response.receiverToken;
        }
        assert();
      },
      run: (kind, operation, { mayDisplay = false } = {}) => {
        assert();
        if (mayDisplay && (documentId === undefined || kind !== "INJECT" && !state?.token)) throw expired();
        if (this.pending.size >= this.maxPending) throw expired();
        // An injected script can only bootstrap hidden before its original
        // token is known. Actual injection still drains; rejection is never
        // interpreted as "did not execute". Only an authorized visible send
        // (or an already visible same-owner generation) requires final hide.
        if (mayDisplay) { retain(state); state.needsHide ||= kind !== "INJECT"; }
        return this.track(record, Object.freeze({ ...original, ...(documentId ? { documentId } : {}), ...(state?.token ? { receiverToken: state.token } : {}) }), kind, operation);
      }
    };
  }

  track(record, scope, kind, operation, retirement) {
    // Keep the original returned Promise, not the caller's timeout/race wrapper.
    let promise;
    try { promise = operation(); }
    catch (error) { promise = Promise.reject(error); }
    if (!promise || typeof promise.then !== "function") promise = Promise.resolve(promise);
    // A pure hide cannot publish content. Exact receiver retirement can prove
    // its obligation independently while Chromium holds its reply in BFCache.
    // Keep the actual Promise (and capacity) until native settlement regardless.
    const pending = { scope, kind, promise, record, cleanup: retirement ? Promise.race([promise, retirement]) : promise };
    pending.cleanup.catch(() => {});
    this.pending.add(pending);
    promise.then(() => this.pending.delete(pending), () => this.pending.delete(pending));
    return pending.cleanup;
  }

  snapshot(predicate = () => true) {
    return [...this.pending].filter(value => predicate(value.scope)).map(value => value.cleanup);
  }

  recover(scope, inspect, { retryFailed = false } = {}) {
    let record = [...this.records].find(value => value.recovery && sameOwner(value.scope, scope));
    if (!record) {
      if (this.records.size >= this.maxOwners) return Promise.reject(cleanupFailed());
      record = { scope: Object.freeze({ ...scope }), documents: new Set(), closed: true, removed: false, cleanupState: null, promise: null, recovery: true };
      this.records.add(record);
    }
    if (!record.preparation || retryFailed && record.cleanupState === "failed" && record.preparationFailed) {
      record.preparationFailed = false;
      record.preparation = this.track(record, record.scope, "RECOVERY", async () => {
        const receiver = await inspect((kind, operation) => this.track(record, record.scope, kind, operation));
        if (!receiver) return;
        if (typeof receiver.documentId !== "string" || !validToken(receiver.receiverToken)) throw cleanupFailed();
        record.documents.add({ documentId: receiver.documentId, token: receiver.receiverToken, needsHide: true, hidden: false, retired: false });
      }).catch(error => { record.preparationFailed = true; throw error; });
      record.preparation.catch(() => {});
    }
    return this.closeRecord(record, retryFailed);
  }

  bootstrapAllowed(tabId, documentId, receiverToken, scope) {
    if (typeof documentId !== "string" || !documentId || !validToken(receiverToken)) return false;
    if ([...this.cleanups].some(value => value.scope.tabId === tabId && [...value.documents].some(item => item.documentId === documentId && item.token === receiverToken))) return false;
    return [...this.records].some(value => !value.closed && sameOwner(value.scope, scope) && value.scope.tabId === tabId &&
      [...value.documents].some(item => item.documentId === documentId && item.token === receiverToken && item.needsHide && !item.retired));
  }

  retired(tabId, documentId, receiverToken) {
    if (!validToken(receiverToken) || typeof documentId !== "string") return false;
    let known = false;
    for (const record of this.records) if (record.scope.tabId === tabId) {
      for (const state of record.documents) if (state.documentId === documentId && state.token === receiverToken) {
        state.retired = true; state.hidden = true; known = true;
        this.retirementSignals.get(state)?.resolve();
      }
    }
    return known;
  }

  observeBootstrap(tabId, documentId, receiverToken) {
    if (!validToken(receiverToken) || typeof documentId !== "string" || !documentId) return false;
    const candidates = [...this.records].filter(record => record.scope.tabId === tabId).flatMap(record =>
      [...record.documents].filter(state => state.documentId === documentId && !state.token &&
        [...this.pending].some(value => value.record === record && value.kind === "INJECT" && value.scope.documentId === documentId)));
    if (candidates.length !== 1) return false;
    candidates[0].token = receiverToken;
    // Identity only: no visible authority is granted by a bootstrap request.
    return true;
  }

  close(predicate = () => true, { retryFailed = false } = {}) {
    const records = [...this.records].filter(value => predicate(value.scope));
    // Synchronous revocation comes before any await or final-hide attempt.
    for (const record of records) record.closed = true;
    return Promise.all(records.map(record => this.closeRecord(record, retryFailed))).then(() => undefined);
  }

  closeRecord(record, retryFailed) {
    if (record.promise && !(retryFailed && record.cleanupState === "failed")) return record.promise;
    this.cleanups.add(record);
    record.cleanupState = "pending";
    record.promise = Promise.resolve().then(async () => {
      await Promise.allSettled([...this.pending].filter(value => value.record === record).map(value => value.cleanup));
      // A failed recovery lookup is not confirmation that the old overlay was
      // absent. Retain the original failure instead of inventing a receiver.
      if (record.preparation) {
        try { await record.preparation; }
        catch (error) { if (!record.removed) throw error; }
      }
      for (const state of record.documents) {
        const { documentId } = state;
        if (!state.needsHide || state.hidden || record.removed) continue;
        let response;
        try {
          if (!validToken(state.token)) throw cleanupFailed();
          let resolve;
          const retirement = new Promise(done => { resolve = done; });
          this.retirementSignals.set(state, { resolve });
          response = await this.track(record, Object.freeze({ ...record.scope, documentId, receiverToken: state.token }), "HIDDEN_STATE", () => this.hide(record.scope.tabId, documentId, state.token), retirement);
        } catch (error) { if (!record.removed && !state.hidden) throw cleanupFailed(error); }
        if (!record.removed && !state.hidden && (response?.ok !== true || response.receiverToken !== state.token)) throw cleanupFailed();
        state.hidden = true;
      }
    }).then(() => {
      record.cleanupState = "complete";
      this.cleanups.delete(record);
      this.records.delete(record);
    }, error => {
      record.cleanupState = "failed";
      record.error = error;
      throw error;
    });
    // Automatic failure release starts cleanup without extending input's
    // deadline. Its failure stays inspectable until explicit cleanup/retry.
    record.promise.catch(() => {});
    return record.promise;
  }

  tabRemoved(tabId) {
    for (const record of this.records) if (record.scope.tabId === tabId) {
      record.removed = true;
      for (const state of record.documents) this.retirementSignals.get(state)?.resolve();
    }
    // Exact tab destruction removes the hide requirement, never settlement of
    // an already dispatched Chrome API. Ordinary navigation is not destruction.
    return this.close(scope => scope.tabId === tabId, { retryFailed: true });
  }
}
