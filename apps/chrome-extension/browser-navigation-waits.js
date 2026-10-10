// Bounded lifetimes for native Playwright navigation observers. URL matching,
// cached lifecycle state and navigation errors belong to the pinned runtime;
// this module owns readiness, control identity, cancellation and retention.
const encoder = new TextEncoder();
const scopeFields = ["session_id", "turn_id", "control_epoch", "tabId"];
const terminal = state => ["matched", "timed-out", "failed"].includes(state);
const expired = () => new Error("OBU_NAVIGATION_WAIT_EXPIRED: navigation wait is no longer available");
const timedOut = () => new Error("OBU_NAVIGATION_WAIT_TIMEOUT: the original navigation wait deadline expired");
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function keys(value, allowed, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`${label} does not support ${key}`);
}
function text(value, label, maxBytes) {
  if (typeof value !== "string" || !value.length || value.length > maxBytes || encoder.encode(value).length > maxBytes)
    throw new Error(`${label} must be a non-empty string of at most ${maxBytes} UTF-8 bytes`);
}
function scopeParams(params, allowed, allowLegacyEpoch = false) {
  keys(params, [...scopeFields, ...allowed], "navigation wait");
  text(params.session_id, "session_id", 4096);
  text(params.turn_id, "turn_id", 4096);
  if (!(allowLegacyEpoch && params.control_epoch === undefined) && (!Number.isSafeInteger(params.control_epoch) || params.control_epoch < 1))
    throw new Error("control_epoch must be a positive safe integer");
  if (!Number.isSafeInteger(params.tabId) || params.tabId < 0) throw new Error("tabId must be a nonnegative safe integer");
}
export function validateNavigationWait(params, { allowLegacyEpoch = false } = {}) {
  scopeParams(params, ["event", "url", "waitUntil", "state", "timeoutMs"], allowLegacyEpoch);
  if (!["url", "loadstate"].includes(params.event)) throw new Error("event must be url or loadstate");
  const timeoutMs = params.timeoutMs === undefined ? 10000 : params.timeoutMs;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw new Error("timeoutMs must be an integer from 1 to 120000");
  if (params.event === "url") {
    if (Object.hasOwn(params, "state")) throw new Error("url wait does not support state");
    text(params.url, "url", 4096);
    const waitUntil = params.waitUntil === undefined ? "load" : params.waitUntil;
    if (!["load", "domcontentloaded", "networkidle", "commit"].includes(waitUntil)) throw new Error("Invalid navigation waitUntil");
    return Object.freeze({ ...params, waitUntil, timeoutMs });
  }
  if (Object.hasOwn(params, "url") || Object.hasOwn(params, "waitUntil")) throw new Error("loadstate wait does not support url or waitUntil");
  const state = params.state === undefined ? "load" : params.state;
  if (!["load", "domcontentloaded", "networkidle"].includes(state)) throw new Error("Invalid navigation load state");
  return Object.freeze({ ...params, state, timeoutMs });
}
function handleParams(params) { scopeParams(params, ["waiterId"]); text(params.waiterId, "waiterId", 128); }
function sameScope(left, right) { return scopeFields.every(key => left[key] === right[key]); }

export class BrowserNavigationWaits {
  constructor({ now = () => performance.now(), setTimer = (callback, delay) => setTimeout(callback, delay), clearTimer = timer => clearTimeout(timer), ttlMs = 30000, maxPerTab = 16, maxPerSession = 32, maxTotal = 128 } = {}) {
    Object.assign(this, { now, setTimer, clearTimer, ttlMs, maxPerTab, maxPerSession, maxTotal });
    this.records = new Map();
    this.operations = new Set();
  }

  reserve(request, { deadlineAt, allowLegacyEpoch = false } = {}) {
    const params = validateNavigationWait(request, { allowLegacyEpoch });
    const now = this.now();
    deadlineAt ??= now + params.timeoutMs;
    if (!Number.isFinite(deadlineAt) || deadlineAt <= now) throw timedOut();
    deadlineAt = Math.min(deadlineAt, now + params.timeoutMs);
    const records = [...this.records.values()];
    if (records.length >= this.maxTotal || records.filter(record => record.params.tabId === params.tabId).length >= this.maxPerTab || records.filter(record => record.params.session_id === params.session_id).length >= this.maxPerSession)
      throw new Error("OBU_NAVIGATION_WAIT_LIMIT: navigation wait capacity reached");
    const completion = deferred(), cancellation = deferred(), disposed = deferred();
    const record = { params, deadlineAt, waiterId: crypto.randomUUID(), state: "reserved", ready: false, completion, cancellation, disposed, cancelled: cancellation.promise };
    this.records.set(record.waiterId, record);
    record.timer = this.setTimer(() => this.finish(record, "timed-out", timedOut()), deadlineAt - now);
    return record;
  }

  check(record, selectedResult = false) {
    if (this.records.get(record.waiterId) !== record) throw expired();
    if (["timed-out", "failed"].includes(record.state)) throw record.error;
    if (this.now() >= (selectedResult ? record.validationDeadlineAt : record.deadlineAt)) throw timedOut();
  }

  track(promise) {
    this.operations.add(promise);
    promise.finally(() => this.operations.delete(promise)).catch(() => {});
    return promise;
  }

  within(record, operation, { selectedResult = false } = {}) {
    return this.track((async () => {
      this.check(record, selectedResult);
      let timer;
      const deadline = new Promise((_, reject) => {
        const checkDeadline = () => {
          const remaining = (selectedResult ? record.validationDeadlineAt : record.deadlineAt) - this.now();
          if (remaining <= 0) reject(timedOut());
          else timer = this.setTimer(checkDeadline, remaining);
        };
        checkDeadline();
      });
      try {
        const result = await Promise.race([Promise.resolve().then(() => { this.check(record, selectedResult); return operation(); }), record.cancelled.then(error => { throw error; }), deadline]);
        this.check(record, selectedResult);
        return result;
      } finally { this.clearTimer(timer); }
    })());
  }

  cancelObserver(record, error) {
    if (record.observerCancelled || !record.observer) return;
    record.observerCancelled = true;
    record.observer.cancel(error);
  }

  finish(record, state, error) {
    if (this.records.get(record.waiterId) !== record || terminal(record.state)) return;
    this.clearTimer(record.timer);
    record.state = state;
    if (state !== "matched") {
      record.error = error;
      record.cancellation.resolve(error);
      this.cancelObserver(record, error);
    }
    record.completion.resolve();
    record.timer = this.setTimer(() => this.remove(record), this.ttlMs);
  }

  remove(record) {
    if (this.records.get(record.waiterId) !== record) return;
    this.records.delete(record.waiterId);
    this.clearTimer(record.timer);
    const error = expired();
    record.cancellation.resolve(error);
    record.disposed.resolve(error);
    record.completion.resolve();
    this.cancelObserver(record, error);
  }

  fail(record, error) {
    if (!record.ready) this.remove(record);
    else this.finish(record, "failed", error);
  }

  async arm(record, observer, scope, validateScope) {
    // Attach rejection handlers before any scope/ready await. Native cached
    // state, navigation errors and cancellation can all settle immediately.
    const validObserver = observer && typeof observer.ready?.then === "function" && typeof observer.result?.then === "function" && typeof observer.cancel === "function";
    if (!validObserver) { this.remove(record); throw new Error("Invalid native navigation observer"); }
    observer.ready.catch(() => {});
    // Even a late/rejected registration has a real native cleanup lifetime.
    // Track it before checking admission so global drain cannot miss its
    // cancellation merely because the reservation or owner already expired.
    const nativeResult = this.track(observer.result.then(
      () => { if (record.observer === observer) this.observe(record); },
      error => { if (record.observer === observer) this.observe(record, error, true); }
    ));
    try {
      this.check(record);
      if (record.state !== "reserved" || typeof validateScope !== "function" || !Number.isSafeInteger(scope?.control_epoch) || scope.control_epoch < 1 ||
        !["session_id", "turn_id", "tabId"].every(key => record.params[key] === scope[key]) ||
        (record.params.control_epoch !== undefined && record.params.control_epoch !== scope.control_epoch)) throw new Error("Invalid navigation wait registration scope");
      // Only internal direct-wait compatibility can reserve without an epoch.
      // It is bound once to the real admitted attachment before publication.
      if (record.params.control_epoch === undefined) record.params = Object.freeze({ ...record.params, control_epoch: scope.control_epoch });
      record.scope = Object.freeze({ ...scope });
      record.validateScope = validateScope;
      record.observer = observer;
      record.state = "arming";
      record.nativeResult = nativeResult;
      await this.within(record, async () => {
        await validateScope(record.scope);
        this.check(record);
        await observer.ready;
        this.check(record);
        await validateScope(record.scope);
      });
      this.check(record);
      record.ready = true;
      if (record.state === "arming") record.state = "pending";
      return { waiterId: record.waiterId, remainingMs: Math.max(1, Math.min(record.params.timeoutMs, Math.ceil(record.deadlineAt - this.now()))) };
    } catch (error) {
      if (record.observer !== observer) observer.cancel(error);
      this.remove(record);
      throw error;
    }
  }

  observe(record, error, failed = false) {
    if (this.records.get(record.waiterId) !== record || !["arming", "pending"].includes(record.state)) return;
    if (this.now() >= record.deadlineAt) { this.finish(record, "timed-out", timedOut()); return; }
    if (failed) { this.finish(record, "failed", error); return; }
    record.state = "matching";
    record.selectedAt = this.now();
    record.validationDeadlineAt = this.now() + 10000;
    this.clearTimer(record.timer);
    record.timer = this.setTimer(() => this.finish(record, "failed", new Error("OBU_NAVIGATION_WAIT_FAILED: completion scope validation timed out")), 10000);
    this.within(record, () => record.validateScope(record.scope), { selectedResult: true }).then(() => {
      this.finish(record, "matched");
    }, () => { if (!["timed-out", "failed"].includes(record.state)) this.remove(record); });
  }

  lookup(params) {
    handleParams(params);
    const record = this.records.get(params.waiterId);
    if (!record || !sameScope(params, record.params)) throw expired();
    return record;
  }

  validateResultScope(record) {
    return this.track((async () => {
      if (this.records.get(record.waiterId) !== record || !record.ready) throw expired();
      let timer;
      const deadline = new Promise((_, reject) => { timer = this.setTimer(() => reject(new Error("OBU_NAVIGATION_WAIT_FAILED: result scope validation timed out")), 10000); });
      try {
        await Promise.race([Promise.resolve().then(() => record.validateScope(record.scope)), record.disposed.promise.then(error => { throw error; }), deadline,
          ...(!terminal(record.state) ? [record.cancelled.then(error => { throw error; })] : [])]);
        if (this.records.get(record.waiterId) !== record) throw expired();
      } catch (error) { if (!["timed-out", "failed"].includes(record.state)) this.remove(record); throw error; }
      finally { this.clearTimer(timer); }
    })());
  }

  collect(params) { return this.track((async () => {
    const record = this.lookup(params);
    await this.validateResultScope(record);
    await record.completion.promise;
    if (this.records.get(record.waiterId) !== record) throw expired();
    await this.validateResultScope(record);
    if (record.state !== "matched") throw record.error ?? expired();
    return {};
  })()); }

  async cancel(params) {
    handleParams(params);
    const record = this.records.get(params.waiterId);
    if (!record || !sameScope(record.params, params)) return {};
    await this.validateResultScope(record);
    this.remove(record);
    return {};
  }

  invalidateTab(tabId) { for (const record of this.records.values()) if (record.params.tabId === tabId) this.remove(record); }
  invalidateAttachedTab(tabId) { for (const record of this.records.values()) if (record.params.tabId === tabId && record.scope) this.remove(record); }
  invalidateSession(sessionId) { for (const record of this.records.values()) if (record.params.session_id === sessionId) this.remove(record); }
  invalidateAll() { for (const record of this.records.values()) this.remove(record); }
  controlSnapshot() { return { tabIds: [...new Set([...this.records.values()].map(record => record.params.tabId))], pending: [...this.operations, ...[...this.records.values()].map(record => record.completion.promise)] }; }
}
