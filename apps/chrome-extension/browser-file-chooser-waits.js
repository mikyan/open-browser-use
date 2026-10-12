// Ready-first file chooser waits. Native interception belongs to one exact
// attachment; a caller timeout never substitutes for a native cleanup result.
const fields = ["session_id", "turn_id", "control_epoch", "tabId"];
const expired = () => new Error("OBU_FILE_CHOOSER_WAIT_EXPIRED: OBU_TRANSFER_CANCELLED: file chooser wait is no longer available");
const timeout = () => new Error("OBU_FILE_CHOOSER_WAIT_TIMEOUT: OBU_TRANSFER_TIMEOUT: original file chooser deadline expired");
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  promise.catch(() => {});
  return { promise, resolve, reject };
};
const same = (a, b) => fields.every(key => a[key] === b[key]);
function validate(params, extra, legacy = false) {
  if (!params || typeof params !== "object" || Array.isArray(params)) throw new Error("file chooser wait requires an object");
  for (const key of Object.keys(params)) if (![...fields, ...extra].includes(key)) throw new Error(`file chooser wait does not support ${key}`);
  for (const key of ["session_id", "turn_id"])
    if (typeof params[key] !== "string" || !params[key] || new TextEncoder().encode(params[key]).length > 4096) throw new Error(`${key} must be nonempty and at most 4096 UTF-8 bytes`);
  if (!(legacy && params.control_epoch === undefined) && (!Number.isSafeInteger(params.control_epoch) || params.control_epoch < 1)) throw new Error("control_epoch must be a positive safe integer");
  if (!Number.isSafeInteger(params.tabId) || params.tabId < 0) throw new Error("tabId must be a nonnegative safe integer");
  if (extra.includes("waiterId") && (typeof params.waiterId !== "string" || !params.waiterId || new TextEncoder().encode(params.waiterId).length > 128)) throw new Error("waiterId must be nonempty and at most 128 UTF-8 bytes");
}

export class BrowserFileChooserWaits {
  constructor({ send, assertScope, validateScope, targetAlive, discard, now = () => Date.now(),
    // Browser timers require their global receiver, not this registry instance.
    setTimer = (callback, delay) => globalThis.setTimeout(callback, delay), clearTimer = id => globalThis.clearTimeout(id),
    maxTotal = 128, cleanupTimeoutMs = 10000 } = {}) {
    Object.assign(this, { send, assertScope, validateScope, targetAlive, discard, now, setTimer, clearTimer, maxTotal, cleanupTimeoutMs });
    this.records = new Map();
    this.byTab = new Map();
    this.operations = new Set();
  }

  reserve(params, { legacy = false } = {}) {
    validate(params, ["timeoutMs"], legacy);
    const timeoutMs = params.timeoutMs ?? 10000;
    if (params.timeoutMs === null || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw new Error("timeoutMs must be an integer from 1 to 120000");
    if (this.byTab.has(params.tabId) || this.records.size >= this.maxTotal) throw new Error("OBU_FILE_CHOOSER_WAIT_LIMIT: file chooser wait capacity reached");
    const record = { params: Object.freeze({ ...params, timeoutMs }), legacy, waiterId: crypto.randomUUID(),
      deadlineAt: this.now() + timeoutMs, ready: deferred(), completion: deferred(), cancellation: deferred(),
      targets: new Map(), newFrames: new Map(), state: "reserved", processing: false, cleanupComplete: false };
    this.records.set(record.waiterId, record);
    this.byTab.set(params.tabId, record);
    record.timer = this.setTimer(() => this.fail(record, timeout()), timeoutMs);
    return record;
  }

  check(record) {
    if (this.records.get(record.waiterId) !== record || record.invalid || record.delivered) throw record.error ?? expired();
    if (this.now() >= record.deadlineAt) { this.fail(record, timeout()); throw record.error; }
    if (record.scope) this.assertScope(record.scope);
  }

  track(operation) {
    this.operations.add(operation);
    operation.then(() => this.operations.delete(operation), () => this.operations.delete(operation));
    return operation;
  }

  async within(record, operation) {
    this.check(record);
    // The timer belongs to the record, not each arm/collect/validation call.
    const pending = Promise.resolve().then(() => { this.check(record); return operation(); });
    const result = await Promise.race([pending, record.cancellation.promise]);
    this.check(record);
    return result;
  }

  bind(record, scope) {
    this.check(record);
    if (record.scope || record.state !== "reserved" || fields.some(key => key !== "control_epoch" && record.params[key] !== scope[key]) ||
        (!record.legacy && record.params.control_epoch !== scope.control_epoch)) throw expired();
    record.scope = Object.freeze({ ...scope });
    record.params = Object.freeze({ ...record.params, control_epoch: scope.control_epoch });
    record.state = "arming";
  }

  enable(record, sessionId) {
    try { this.check(record); } catch (error) { return Promise.reject(error); }
    if (!record.scope || !["arming", "pending"].includes(record.state)) return Promise.resolve();
    if (record.targets.has(sessionId)) return record.targets.get(sessionId).enable;
    const target = { sessionId, started: false, disabled: false };
    record.targets.set(sessionId, target);
    const pending = Promise.resolve().then(() => {
      this.check(record);
      if (!this.targetAlive(record.scope, sessionId)) throw expired();
      target.started = true;
      return this.send(record.scope, sessionId, true);
    });
    // Keep the real send promise, including a failure whose side effect is
    // unknown. Cleanup issues disable only after this exact enable settles.
    target.enable = this.track(pending);
    pending.catch(error => this.fail(record, error));
    return pending;
  }

  async barrier(record) {
    return this.within(record, async () => {
      await record.ready.promise;
      while (["arming", "pending"].includes(record.state)) {
        const targets = [...record.targets.values()];
        await Promise.all(targets.map(target => target.enable));
        this.check(record);
        if (targets.length === record.targets.size) break;
      }
    });
  }

  async arm(record, sessions) {
    return this.within(record, async () => {
      await Promise.all(sessions.map(sessionId => this.enable(record, sessionId)));
      await this.validateScope(record.scope, record);
      this.check(record);
      // A newly attached child may have arrived while the initial sends ran.
      while (true) {
        const targets = [...record.targets.values()];
        await Promise.all(targets.map(target => target.enable));
        this.check(record);
        if (targets.length === record.targets.size) break;
      }
      if (record.state === "arming") record.state = "pending";
      record.ready.resolve();
      return { waiterId: record.waiterId, remainingMs: Math.min(record.params.timeoutMs, record.deadlineAt - this.now()) };
    });
  }

  observe(record, sessionId, resolveChooser) {
    if (!record || record.invalid || !["arming", "pending"].includes(record.state)) return;
    try { this.check(record); } catch { return; }
    if (!record.targets.has(sessionId) || !this.targetAlive(record.scope, sessionId)) return;
    record.state = "matching"; // Reserve the first event before any await.
    record.processing = true;
    const processing = (async () => {
      try {
        await this.within(record, async () => {
          await this.validateScope(record.scope, record);
          this.check(record);
          const result = await resolveChooser(() => this.check(record));
          record.result = result;
          this.check(record);
          await this.cleanup(record);
          this.check(record);
          record.state = "matched";
          record.completion.resolve();
        });
      } catch (error) { this.fail(record, error); }
      finally { record.processing = false; this.retire(record); }
    })();
    this.track(processing);
  }

  async cleanupTarget(record, target) {
    await target.enable?.catch(() => {});
    if (target.disabled || !target.started) return;
    if (!this.targetAlive(record.scope, target.sessionId)) { target.disabled = true; return; }
    // No await between the exact attachment check and native dispatch.
    await this.send(record.scope, target.sessionId, false);
    target.disabled = true;
  }

  cleanup(record, retry = false) {
    if (record.cleanupComplete) return Promise.resolve();
    if (record.cleanupPromise) return record.cleanupPromise;
    if (record.cleanupError && !retry) return Promise.reject(record.cleanupError);
    const operation = this.track((async () => {
      const results = await Promise.allSettled([...record.targets.values()].map(target => this.cleanupTarget(record, target)));
      const failure = results.find(result => result.status === "rejected");
      if (failure) throw new Error(`OBU_FILE_CHOOSER_CLEANUP_FAILED: ${String(failure.reason?.message ?? failure.reason)}`);
      record.cleanupError = null;
      record.cleanupComplete = true;
    })());
    record.cleanupPromise = operation;
    operation.then(() => { record.cleanupPromise = null; this.retire(record); }, error => { record.cleanupPromise = null; record.cleanupError = error; });
    return operation;
  }

  fail(record, error = expired()) {
    if (record.delivered || record.invalid) return;
    record.invalid = true;
    record.error = error;
    record.cancelAdmission?.();
    this.clearTimer(record.timer);
    record.ready.reject(error);
    record.completion.reject(error);
    record.cancellation.reject(error);
    if (record.result) this.discard(record.result);
    this.cleanup(record).catch(() => {});
    this.retire(record);
  }

  retire(record) {
    if (!(record.invalid || record.delivered) || !record.cleanupComplete || record.processing) return;
    if (record.invalid && record.result) this.discard(record.result);
    this.clearTimer(record.timer);
    if (this.records.get(record.waiterId) === record) this.records.delete(record.waiterId);
    if (this.byTab.get(record.params.tabId) === record) this.byTab.delete(record.params.tabId);
  }

  lookup(params) {
    validate(params, ["waiterId"]);
    const record = this.records.get(params.waiterId);
    if (!record || !same(params, record.params)) throw expired();
    this.check(record);
    return record;
  }

  validateHandle(params) { validate(params, ["waiterId"]); }

  collect(params) {
    const record = this.lookup(params);
    if (record.collecting) throw new Error("OBU_FILE_CHOOSER_WAIT_CONFLICT: file chooser result is already being collected");
    record.collecting = true;
    return this.within(record, async () => {
      await record.ready.promise;
      await record.completion.promise;
      await this.validateScope(record.scope, record);
      this.check(record);
      // No await after ownership verification before consuming this result.
      return { ...record.result };
    }).then(result => {
      this.check(record);
      record.delivered = true;
      this.retire(record);
      return result;
    }, error => { this.fail(record, error); throw error; });
  }

  async cancel(params) {
    validate(params, ["waiterId"]);
    const record = this.records.get(params.waiterId);
    if (!record || !same(params, record.params)) return {};
    this.fail(record);
    const cleanup = this.cleanup(record, true);
    let timer;
    try {
      await Promise.race([cleanup, new Promise((_, reject) => {
        timer = this.setTimer(() => reject(new Error("OBU_FILE_CHOOSER_CLEANUP_TIMEOUT: original native cleanup is still pending")), this.cleanupTimeoutMs);
      })]);
      return {};
    } finally { this.clearTimer(timer); }
  }

  invalidate(predicate, error = expired()) {
    const records = [...this.records.values()].filter(predicate);
    for (const record of records) this.fail(record, error);
    const result = Promise.allSettled(records.map(record => this.cleanup(record, true))).then(results => {
      const failure = results.find(result => result.status === "rejected");
      if (failure) throw failure.reason;
    });
    result.catch(() => {});
    return result;
  }
  invalidateTab(tabId, error, preserve = null) { return this.invalidate(record => record.params.tabId === tabId && (record !== preserve || record.scope), error); }
  invalidateAttachedTab(tabId, error) { return this.invalidate(record => record.params.tabId === tabId && record.scope, error); }
  invalidateSession(sessionId, error) { return this.invalidate(record => record.params.session_id === sessionId, error); }
  invalidateAll(error) { return this.invalidate(() => true, error); }
  controlSnapshot() { return { tabIds: [...this.byTab.values()].filter(record => record.scope).map(record => record.params.tabId), pending: [...this.operations] }; }
}
