import { BrowserPageFrames } from "./browser-page-frames.js";

const fields = ["session_id", "turn_id", "control_epoch", "tabId"];
const expired = () => new Error("OBU_PAGE_WAIT_EXPIRED: created-page wait is no longer available");
const timeout = () => new Error("OBU_PAGE_WAIT_TIMEOUT: original created-page deadline expired");
const deferred = () => {
  let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); promise.catch(() => {});
  return { promise, resolve, reject };
};
const same = (left, right) => fields.every(key => left[key] === right[key]);
const text = (value, max) => typeof value === "string" && value.length > 0 && value.length <= max && new TextEncoder().encode(value).length <= max;

function validate(value, handle = false) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("page wait requires an object");
  for (const key of Object.keys(value)) if (![...fields, handle ? "waiterId" : "timeoutMs"].includes(key)) throw new Error(`page wait does not support ${key}`);
  if (!["session_id", "turn_id"].every(key => text(value[key], 4096))) throw new Error("page wait session_id and turn_id must be nonempty and at most 4096 UTF-8 bytes");
  if (!Number.isSafeInteger(value.control_epoch) || value.control_epoch < 1) throw new Error("control_epoch must be a positive safe integer");
  if (!Number.isSafeInteger(value.tabId) || value.tabId < 0) throw new Error("tabId must be a nonnegative safe integer");
  if (handle) { if (!text(value.waiterId, 128)) throw new Error("waiterId must be nonempty and at most 128 UTF-8 bytes"); }
  else {
    const timeoutMs = value.timeoutMs === undefined ? 10000 : value.timeoutMs;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw new Error("timeoutMs must be an integer from 1 to 120000");
    return Object.freeze({ ...value, timeoutMs });
  }
}

// Native event order chooses one candidate synchronously. No URL matching,
// polling of user tabs, click replay, window movement or child closing occurs
// here. The backend performs exact adoption and conditional release.
export class BrowserPageWaits {
  constructor({ assertScope = () => {}, validateScope, snapshotFrames, adopt, release = () => {},
    now = () => performance.now(), setTimer = (fn, delay) => setTimeout(fn, delay), clearTimer = id => clearTimeout(id),
    createId = () => crypto.randomUUID(), maxTotal = 128, maxPerSession = 32, ttlMs = 30000, cleanupTimeoutMs = 10000, frames = new BrowserPageFrames() } = {}) {
    if (![assertScope, validateScope, snapshotFrames, adopt, release].every(value => typeof value === "function")) throw new Error("Page waits require scope, frames and adoption hooks");
    Object.assign(this, { assertScope, validateScope, snapshotFrames, adopt, release, now, setTimer, clearTimer, createId, maxTotal, maxPerSession, ttlMs, cleanupTimeoutMs, frames });
    this.records = new Map(); this.byTab = new Map(); this.operations = new Set();
  }

  reserve(request, { deadlineAt } = {}) {
    const params = validate(request), now = this.now();
    deadlineAt = Math.min(deadlineAt ?? now + params.timeoutMs, now + params.timeoutMs);
    if (!Number.isFinite(deadlineAt) || deadlineAt <= now) throw timeout();
    if (this.byTab.has(params.tabId) || this.records.size >= this.maxTotal || [...this.records.values()].filter(record => record.params.session_id === params.session_id).length >= this.maxPerSession)
      throw new Error("OBU_PAGE_WAIT_LIMIT: one created-page wait per source or capacity reached");
    const waiterId = this.createId(); if (!text(waiterId, 128) || this.records.has(waiterId)) throw new Error("Invalid created-page waiter identity");
    const record = { params, waiterId, deadlineAt, state: "reserved", ready: deferred(), completion: deferred(), cancellation: deferred(), pending: new Set(), frameLedger: this.frames.create(params.tabId) };
    this.records.set(waiterId, record); this.byTab.set(params.tabId, record);
    record.timer = this.setTimer(() => this.fail(record, timeout()), deadlineAt - now);
    return record;
  }

  check(record) {
    if (this.records.get(record?.waiterId) !== record || record.delivered) throw expired();
    if (record.invalid) throw record.error;
    if (this.now() >= record.deadlineAt) { this.fail(record, timeout()); throw record.error; }
    try { this.frames.check(record.frameLedger); if (record.scope) this.assertScope(record.scope, record); }
    catch (error) { this.fail(record, error); throw error; }
  }

  track(record, promise) {
    record.pending.add(promise); this.operations.add(promise);
    const settled = () => { record.pending.delete(promise); this.operations.delete(promise); };
    promise.then(settled, settled); return promise;
  }

  within(record, operation) {
    this.check(record);
    // Track the actual invocation independently from the cancellation race.
    // A timeout cannot release its reverse lock while Chrome still works.
    const actual = this.track(record, Promise.resolve().then(() => { this.check(record); return operation(); }));
    return Promise.race([actual, record.cancellation.promise]).then(result => { this.check(record); return result; });
  }

  bind(record, scope) {
    this.check(record);
    if (record.scope || record.state !== "reserved" || !same(record.params, scope)) throw expired();
    record.scope = Object.freeze({ ...scope }); this.assertScope(record.scope, record); record.state = "arming";
  }

  async snapshot(record) {
    await this.within(record, () => this.frames.snapshot(record.frameLedger, () => this.snapshotFrames(record.scope, record)));
    this.check(record);
    if (record.candidateFrame) this.frames.validate(record.frameLedger, record.candidateFrame);
  }

  async arm(record) {
    try {
      if (record.state !== "arming" || !record.scope) throw expired();
      await this.within(record, () => this.validateScope(record.scope, record));
      await this.snapshot(record);
      await this.within(record, () => this.validateScope(record.scope, record)); this.check(record);
      record.state = "pending"; record.armed = true; record.ready.resolve();
      return { waiterId: record.waiterId, remainingMs: Math.min(record.params.timeoutMs, Math.ceil(record.deadlineAt - this.now())) };
    } catch (error) { this.fail(record, error); throw error; }
  }

  barrier(record) { return this.within(record, async () => { await record.ready.promise; await this.validateScope(record.scope, record); this.check(record); }); }

  observe(event) {
    const record = this.byTab.get(event?.sourceTabId);
    if (!record || record.state !== "pending" || !record.armed) return;
    try { this.check(record); } catch (error) { this.fail(record, error); return; }
    const frame = this.frames.candidate(record.frameLedger, event); if (!frame) return;
    record.state = "matching"; record.candidate = Object.freeze({ ...event }); record.candidateFrame = frame;
    // This operation is real until adoption itself settles, including after a
    // losing cancellation race. A different native child can never replace it.
    const operation = (async () => {
      try {
        await this.within(record, () => this.validateScope(record.scope, record));
        await this.snapshot(record); this.check(record);
        record.adoptionStarted = true;
        const result = await this.within(record, () => this.adopt(record.scope, record.candidate, record));
        this.check(record);
        if (!result || Object.keys(result).length !== 1 || result.tabId !== record.candidate.tabId) throw new Error("OBU_PAGE_WAIT_FAILED: adoption returned a different native child");
        await this.snapshot(record);
        record.result = Object.freeze({ tabId: result.tabId }); record.state = "matched"; record.completion.resolve();
      } catch (error) { this.fail(record, error); }
    })();
    this.operations.add(operation); operation.finally(() => this.operations.delete(operation)).catch(() => {});
  }

  navigation(name, details) {
    const record = this.byTab.get(details?.tabId); if (!record || record.invalid || record.delivered) return;
    this.frames.navigation(record.frameLedger, name, details);
    try { this.check(record); if (record.candidateFrame) this.frames.validate(record.frameLedger, record.candidateFrame); }
    catch (error) { this.fail(record, error); }
  }

  validateHandle(params) { validate(params, true); }
  lookup(params) {
    this.validateHandle(params); const record = this.records.get(params.waiterId);
    if (!record || !same(record.params, params)) throw expired(); this.check(record); return record;
  }

  async collect(params) {
    const record = this.lookup(params);
    if (record.collecting) throw new Error("OBU_PAGE_WAIT_CONFLICT: result is already being collected");
    record.collecting = true;
    try {
      await this.within(record, async () => { await record.ready.promise; await record.completion.promise; });
      await this.within(record, () => this.validateScope(record.scope, record)); await this.snapshot(record); this.check(record);
      const result = { ...record.result }; record.delivered = true; record.state = "delivered";
      this.remove(record); return result;
    } catch (error) { this.fail(record, error); throw error; }
  }

  signalAdmission(record, retry = false) {
    if (!record.cancelAdmission) return;
    const previous = record.admissionCancellation;
    if (previous && (previous.state !== "rejected" || !retry)) return;
    const attempt = { hook: record.cancelAdmission, state: "pending" }; record.admissionCancellation = attempt;
    try {
      const pending = attempt.hook();
      if (pending) this.track(record, Promise.resolve(pending).then(() => { attempt.state = "fulfilled"; }, error => {
        attempt.state = "rejected"; attempt.error = error; record.cleanupError ??= error; throw error;
      }));
      else attempt.state = "fulfilled";
    }
    catch (error) { attempt.state = "rejected"; attempt.error = error; record.cleanupError ??= error; }
  }

  fail(record, error = expired()) {
    if (record.invalid || record.delivered || this.records.get(record.waiterId) !== record) return;
    record.invalid = true; record.error = error; record.state = "failed"; this.clearTimer(record.timer);
    record.ready.reject(error); record.completion.reject(error); record.cancellation.reject(error);
    this.signalAdmission(record);
    this.startCleanup(record);
  }

  startCleanup(record, retry = false) {
    if (retry) {
      if (!record.invalid || !record.cleanupSettled || !record.cleanupError || record.pending.size) return;
      // Only a new explicit cleanup request may clear the previous attempt's
      // error. It cannot revive a waiter or replay its candidate adoption.
      record.cleanupError = undefined;
    } else if (record.cleanup) return;
    record.cleanupSettled = false; record.cleanupAttempts = (record.cleanupAttempts ?? 0) + 1;
    const cleanup = (async () => {
      while (record.pending.size) await Promise.allSettled([...record.pending]);
      // A cancelled setup can install its admission token just before its real
      // promise settles. Cancel that exact late token before releasing it.
      this.signalAdmission(record, retry);
      while (record.pending.size) await Promise.allSettled([...record.pending]);
      try { await this.release(record, record.error); } catch (caught) { record.cleanupError ??= caught; }
      if (record.cleanupError) throw record.cleanupError;
      record.cleaned = true;
      if (this.byTab.get(record.params.tabId) === record) this.byTab.delete(record.params.tabId);
      record.timer = this.setTimer(() => this.remove(record), this.ttlMs);
    })();
    record.cleanup = cleanup; this.operations.add(cleanup);
    const settled = () => { record.cleanupSettled = true; this.operations.delete(cleanup); };
    cleanup.then(settled, settled);
  }

  remove(record) {
    if (this.records.get(record.waiterId) !== record) return;
    this.clearTimer(record.timer); this.records.delete(record.waiterId);
    if (this.byTab.get(record.params.tabId) === record) this.byTab.delete(record.params.tabId);
  }

  async drain(record) {
    while (record.pending.size) await Promise.allSettled([...record.pending]);
    if (record.cleanup) await record.cleanup;
    if (record.cleanupError) throw record.cleanupError;
  }

  async cancel(params) {
    this.validateHandle(params); const record = this.records.get(params.waiterId);
    if (!record || !same(record.params, params)) return {};
    this.fail(record);
    if (record.cleanupSettled && record.cleanupError) this.startCleanup(record, true);
    let timer;
    try {
      await Promise.race([this.drain(record), new Promise((_, reject) => { timer = this.setTimer(() => reject(new Error("OBU_PAGE_WAIT_CLEANUP_TIMEOUT: actual page setup or adoption is still pending")), this.cleanupTimeoutMs); })]);
      return {};
    } finally { this.clearTimer(timer); }
  }

  invalidate(predicate, error = expired()) {
    const records = [...this.records.values()].filter(record => !record.delivered && predicate(record));
    for (const record of records) this.fail(record, error);
    return Promise.all(records.map(record => this.drain(record)));
  }
  invalidateTab(tabId, error, preserve = null, releaseRecord = null) {
    // Conditional rollback can detach this failed record's exact child. It
    // must not await its own cleanup promise, or skip any other live waiter.
    return this.invalidate(record => (record.params.tabId === tabId || record.candidate?.tabId === tabId) &&
      (record !== preserve || record.scope) && !(record === releaseRecord && record.invalid), error);
  }
  invalidateAttachedTab(tabId, error) { return this.invalidate(record => record.scope && (record.params.tabId === tabId || record.candidate?.tabId === tabId), error); }
  invalidateSession(sessionId, error) { return this.invalidate(record => record.params.session_id === sessionId, error); }
  invalidateAll(error) { return this.invalidate(() => true, error); }
  retryFailedCleanup() {
    const records = [...this.records.values()].filter(record => record.invalid && record.cleanupSettled && record.cleanupError && !record.pending.size);
    for (const record of records) this.startCleanup(record, true);
    return Promise.all(records.map(record => this.drain(record)));
  }
  controlSnapshot() {
    // Neither an unbound source request nor a native candidate event grants
    // control. Pending source attachments and admitted children are represented
    // separately by the backend's attachment and auxiliary registries.
    return { tabIds: [...this.byTab.values()].filter(record => record.scope).map(record => record.params.tabId), pending: [...this.operations] };
  }
}
