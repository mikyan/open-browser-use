// Observe the first Page download after explicit readiness. This registry never
// starts, replays or cancels a browser download, and never disables shared Page.
const scopeFields = ["session_id", "turn_id", "control_epoch", "tabId"];
const expired = () => new Error("OBU_DOWNLOAD_WAIT_EXPIRED: OBU_TRANSFER_CANCELLED: download wait is no longer available");
const timeout = () => new Error("OBU_DOWNLOAD_WAIT_TIMEOUT: OBU_TRANSFER_TIMEOUT: original download wait deadline expired");
const same = (a, b) => scopeFields.every(key => a[key] === b[key]);
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  promise.catch(() => {});
  return { promise, resolve, reject };
};
function validate(params, extra, legacy = false) {
  if (!params || typeof params !== "object" || Array.isArray(params)) throw new Error("download wait requires an object");
  for (const key of Object.keys(params)) if (![...scopeFields, ...extra].includes(key)) throw new Error(`download wait does not support ${key}`);
  for (const key of ["session_id", "turn_id"])
    if (typeof params[key] !== "string" || !params[key] || new TextEncoder().encode(params[key]).length > 4096) throw new Error(`${key} must be nonempty and at most 4096 UTF-8 bytes`);
  if (!(legacy && params.control_epoch === undefined) && (!Number.isSafeInteger(params.control_epoch) || params.control_epoch < 1)) throw new Error("control_epoch must be a positive safe integer");
  if (!Number.isSafeInteger(params.tabId) || params.tabId < 0) throw new Error("tabId must be a nonnegative safe integer");
  if (extra.includes("waiterId") && (typeof params.waiterId !== "string" || !params.waiterId || new TextEncoder().encode(params.waiterId).length > 128)) throw new Error("waiterId must be nonempty and at most 128 UTF-8 bytes");
}

export class BrowserDownloadWaits {
  constructor({ send, assertScope, validateScope, sourceAlive, publish, discard, deliver = () => {}, now = () => Date.now(),
    setTimer = (fn, delay) => globalThis.setTimeout(fn, delay), clearTimer = id => globalThis.clearTimeout(id), maxTotal = 128, cleanupTimeoutMs = 10000 } = {}) {
    Object.assign(this, { send, assertScope, validateScope, sourceAlive, publish, discard, deliver, now, setTimer, clearTimer, maxTotal, cleanupTimeoutMs });
    this.records = new Map(); this.byTab = new Map(); this.operations = new Set();
  }

  reserve(params, { legacy = false } = {}) {
    validate(params, ["timeoutMs"], legacy);
    const timeoutMs = params.timeoutMs ?? 10000;
    if (params.timeoutMs === null || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw new Error("timeoutMs must be an integer from 1 to 120000");
    if (this.byTab.has(params.tabId) || this.records.size >= this.maxTotal) throw new Error("OBU_DOWNLOAD_WAIT_LIMIT: download wait capacity reached");
    const record = { params: Object.freeze({ ...params, timeoutMs }), legacy, waiterId: crypto.randomUUID(), deadlineAt: this.now() + timeoutMs,
      state: "reserved", ready: deferred(), completion: deferred(), cancellation: deferred(), targets: new Map(), pending: new Set() };
    this.records.set(record.waiterId, record); this.byTab.set(params.tabId, record);
    record.timer = this.setTimer(() => this.fail(record, timeout()), timeoutMs);
    return record;
  }

  check(record) {
    if (this.records.get(record.waiterId) !== record || record.invalid || record.delivered) throw record.error ?? expired();
    if (this.now() >= record.deadlineAt) { this.fail(record, timeout()); throw record.error; }
    if (record.scope) this.assertScope(record.scope);
  }

  track(record, promise) {
    record.pending.add(promise); this.operations.add(promise);
    const settled = () => { record.pending.delete(promise); this.operations.delete(promise); this.retire(record); };
    promise.then(settled, settled);
    return promise;
  }

  async within(record, operation) {
    this.check(record);
    const value = await Promise.race([Promise.resolve().then(() => { this.check(record); return operation(); }), record.cancellation.promise]);
    this.check(record);
    return value;
  }

  bind(record, scope) {
    this.check(record);
    if (record.scope || record.state !== "reserved" || scopeFields.some(key => key !== "control_epoch" && record.params[key] !== scope[key]) ||
      (!record.legacy && record.params.control_epoch !== scope.control_epoch)) throw expired();
    record.scope = Object.freeze({ ...scope });
    record.params = Object.freeze({ ...record.params, control_epoch: scope.control_epoch });
    record.state = "arming";
  }

  enable(record, sessionId) {
    try { this.check(record); } catch (error) { return Promise.reject(error); }
    if (!record.scope || !["arming", "pending"].includes(record.state)) return Promise.resolve();
    if (record.targets.has(sessionId)) return record.targets.get(sessionId);
    const pending = this.track(record, Promise.resolve().then(async () => {
      this.check(record);
      if (!this.sourceAlive(record.scope, sessionId)) {
        if (sessionId !== undefined) return; // A removed child cannot produce an eligible event.
        throw expired();
      }
      try { await this.send(record.scope, sessionId); }
      catch (error) { if (this.sourceAlive(record.scope, sessionId)) throw error; }
    }));
    record.targets.set(sessionId, pending);
    pending.catch(error => this.fail(record, error));
    return pending;
  }

  async settleTargets(record) {
    while (true) {
      const targets = [...record.targets.values()];
      await Promise.all(targets); this.check(record);
      if (targets.length === record.targets.size) return;
    }
  }

  arm(record, sessions) {
    return this.within(record, async () => {
      await Promise.all(sessions.map(session => this.enable(record, session)));
      await this.validateScope(record.scope, record); this.check(record);
      await this.settleTargets(record);
      if (record.state === "arming") record.state = "pending";
      record.ready.resolve();
      return { waiterId: record.waiterId, remainingMs: Math.min(record.params.timeoutMs, record.deadlineAt - this.now()) };
    });
  }

  barrier(record) {
    return this.within(record, async () => { await record.ready.promise; await this.settleTargets(record); });
  }

  observe(record, sessionId, createResult) {
    if (!record || record.invalid || !["arming", "pending"].includes(record.state)) return;
    try { this.check(record); } catch { return; }
    if (!record.targets.has(sessionId) || !this.sourceAlive(record.scope, sessionId)) return;
    // Native arrival order decides the candidate, before ownership reads await.
    record.state = "matching";
    try { record.result = createResult(record); }
    catch (error) { this.fail(record, error); return; }
    this.track(record, (async () => {
      try {
        await this.within(record, async () => {
          await record.ready.promise;
          await this.validateScope(record.scope, record); this.check(record);
          record.state = "matched";
          this.publish(record.result, record);
          record.completion.resolve();
        });
      } catch (error) { this.fail(record, error); }
    })());
  }

  fail(record, error = expired()) {
    if (record.invalid || record.delivered) return;
    record.invalid = true; record.error = error; this.clearTimer(record.timer);
    record.ready.reject(error); record.completion.reject(error); record.cancellation.reject(error);
    const cleanup = record.cancelAdmission?.();
    if (cleanup) this.track(record, Promise.resolve(cleanup));
    if (record.result) this.discard(record.result, record);
    this.retire(record);
  }

  retire(record) {
    if (!(record.invalid || record.delivered) || record.pending.size) return;
    this.clearTimer(record.timer);
    if (this.records.get(record.waiterId) === record) this.records.delete(record.waiterId);
    if (this.byTab.get(record.params.tabId) === record) this.byTab.delete(record.params.tabId);
  }

  validateHandle(params) { validate(params, ["waiterId"]); }
  lookup(params) {
    this.validateHandle(params);
    const record = this.records.get(params.waiterId);
    if (!record || !same(params, record.params)) throw expired();
    this.check(record); return record;
  }

  collect(params) {
    const record = this.lookup(params);
    if (record.collecting) throw new Error("OBU_DOWNLOAD_WAIT_CONFLICT: download result is already being collected");
    record.collecting = true;
    return this.within(record, async () => {
      await record.ready.promise; await record.completion.promise;
      await this.validateScope(record.scope, record); this.check(record);
      return { ...record.result };
    }).then(result => {
      this.check(record); this.deliver(result, record); record.delivered = true; this.retire(record); return result;
    }, error => { this.fail(record, error); throw error; });
  }

  async drain(record) {
    while (record.pending.size) await Promise.allSettled([...record.pending]);
    this.retire(record);
  }

  async cancel(params) {
    this.validateHandle(params);
    const record = this.records.get(params.waiterId);
    if (!record || !same(params, record.params)) return {};
    this.fail(record);
    let timer;
    try {
      await Promise.race([this.drain(record), new Promise((_, reject) => {
        timer = this.setTimer(() => reject(new Error("OBU_DOWNLOAD_WAIT_CLEANUP_TIMEOUT: native download observation setup is still pending")), this.cleanupTimeoutMs);
      })]);
      return {};
    } finally { this.clearTimer(timer); }
  }

  invalidate(predicate, error = expired()) {
    const records = [...this.records.values()].filter(predicate);
    for (const record of records) this.fail(record, error);
    return Promise.all(records.map(record => this.drain(record)));
  }
  invalidateTab(tabId, error, preserve = null) { return this.invalidate(record => record.params.tabId === tabId && (record !== preserve || record.scope), error); }
  invalidateAttachedTab(tabId, error) { return this.invalidate(record => record.params.tabId === tabId && record.scope, error); }
  invalidateSession(sessionId, error) { return this.invalidate(record => record.params.session_id === sessionId, error); }
  invalidateAll(error) { return this.invalidate(() => true, error); }
  controlSnapshot() { return { tabIds: [...this.byTab.keys()], pending: [...this.operations] }; }
}
