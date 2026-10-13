// One-shot native dialog decisions. Registration and response ACKs are real
// promises; expiry withdraws authority without pretending a sent response ended.
const encoder = new TextEncoder();
const fields = ["session_id", "turn_id", "control_epoch", "tabId"];
const types = ["alert", "confirm", "prompt", "beforeunload"];
const error = (kind, message) => new Error(`OBU_DIALOG_${kind}: ${message}`);
const expired = () => error("EXPIRED", "dialog decision is no longer available");
const timeout = () => error("TIMEOUT", "the original dialog deadline expired");
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function object(value, allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key)))
    throw error("INVALID", "invalid dialog fields");
}
function text(value, limit = 8192, empty = true) {
  if (typeof value !== "string" || (!empty && !value.length) || value.length > limit ||
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value) || encoder.encode(value).length > limit)
    throw error("INVALID", "invalid dialog text");
}
function scope(params, extra) {
  object(params, [...fields, ...extra]);
  text(params.session_id, 4096, false); text(params.turn_id, 4096, false);
  if (!Number.isSafeInteger(params.control_epoch) || params.control_epoch < 1 || !Number.isSafeInteger(params.tabId) || params.tabId < 0)
    throw error("INVALID", "invalid dialog scope");
}
export function validateDialog(params) {
  scope(params, ["type", "message", "accept", "promptText", "timeoutMs"]);
  if (!types.includes(params.type) || typeof params.accept !== "boolean") throw error("INVALID", "invalid dialog decision");
  if (params.message !== undefined) text(params.message);
  if (params.promptText !== undefined) {
    if (params.type !== "prompt" || !params.accept) throw error("INVALID", "promptText requires an accepted prompt");
    text(params.promptText);
  }
  const timeoutMs = params.timeoutMs === undefined ? 10000 : params.timeoutMs;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw error("INVALID", "invalid dialog timeout");
  return Object.freeze({ ...params, timeoutMs });
}
function handle(params) { scope(params, ["dialogId"]); text(params.dialogId, 128, false); }
function sameScope(a, b) { return fields.every(key => a[key] === b[key]); }
const defaultDecision = type => ({ accept: type === "beforeunload" });

export class BrowserDialogs {
  constructor({ now = () => performance.now(), setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = id => clearTimeout(id), ttlMs = 30000, maxTotal = 128 } = {}) {
    Object.assign(this, { now, setTimer, clearTimer, ttlMs, maxTotal });
    this.records = new Map(); this.byTab = new Map(); this.operations = new Set();
  }
  reserve(request) {
    const params = validateDialog(request);
    if (this.byTab.has(params.tabId)) throw error("BUSY", "a dialog decision is already active for this tab");
    if (this.records.size >= this.maxTotal) throw error("LIMIT", "dialog decision capacity reached");
    const record = { params, dialogId: crypto.randomUUID(), deadlineAt: this.now() + params.timeoutMs,
      state: "reserved", ready: false, completion: deferred(), cancellation: deferred(), pending: new Set(), responses: new Set() };
    this.records.set(record.dialogId, record); this.byTab.set(params.tabId, record);
    record.timer = this.setTimer(() => this.finish(record, "failed", timeout()), params.timeoutMs);
    return record;
  }
  check(record) {
    if (this.records.get(record.dialogId) !== record || record.invalid) throw record.error ?? expired();
    if (this.now() >= record.deadlineAt) throw timeout();
  }
  track(record, operation) {
    const promise = Promise.resolve(operation);
    this.operations.add(promise); record.pending.add(promise);
    promise.finally(() => { this.operations.delete(promise); record.pending.delete(promise); this.releaseSlot(record); }).catch(() => {});
    return promise;
  }
  within(record, operation) {
    this.check(record);
    const actual = this.track(record, Promise.resolve().then(() => { this.check(record); return operation(); }));
    return Promise.race([actual, record.cancellation.promise.then(reason => { throw reason; })]);
  }
  releaseSlot(record) {
    if (record.stopped && !record.pending.size && !record.cleanupError && !record.responseCleanupError && this.byTab.get(record.params.tabId) === record)
      this.byTab.delete(record.params.tabId);
    if (record.retireAt !== undefined && this.now() >= record.retireAt && this.byTab.get(record.params.tabId) !== record) {
      this.clearTimer(record.timer);
      this.records.delete(record.dialogId);
    }
  }
  stop(record, retry = false) {
    if (record.cleanup && !(retry && record.cleanupError)) return record.cleanup;
    record.stopped = true;
    record.page?.off("dialog", record.listener);
    record.page?.off("close", record.closed);
    const cleanup = (async () => {
      await record.enabled?.catch(() => {});
      if (record.page && !record.pageClosed && !record.page.isClosed?.()) {
        try { await record.page._channel.updateSubscription({ event: "dialog", enabled: false }); }
        catch (reason) { if (!record.pageClosed && !record.page.isClosed?.()) throw reason; }
      }
      record.cleanupError = undefined;
    })();
    record.cleanup = this.track(record, cleanup.catch(reason => { record.cleanupError = reason; throw error("FAILED", "dialog subscription cleanup failed"); }));
    record.cleanup.catch(() => {});
    this.releaseSlot(record);
    return record.cleanup;
  }
  finish(record, state, value) {
    if (record.invalid || record.state === "matched") return;
    this.clearTimer(record.timer);
    record.state = state;
    if (state === "matched") record.value = value;
    else { record.invalid = true; record.error = value; record.cancellation.resolve(value); }
    record.completion.resolve();
    void this.stop(record);
    this.retireLater(record);
  }
  retireLater(record) {
    record.retireAt ??= this.now() + this.ttlMs;
    this.clearTimer(record.timer);
    record.timer = this.setTimer(() => this.releaseSlot(record), Math.max(0, record.retireAt - this.now()));
  }
  fail(record, reason) { this.finish(record, "failed", reason); }
  async arm(record, page, boundScope, { validateScope, assertScope, prepareResponse }) {
    this.check(record);
    if (!sameScope(record.params, boundScope)) throw expired();
    record.scope = Object.freeze({ ...boundScope });
    Object.assign(record, { page, validateScope, assertScope, prepareResponse });
    record.closed = () => { record.pageClosed = true; void this.invalidate(record, this.now() >= record.deadlineAt ? timeout() : expired()).catch(() => {}); };
    record.listener = dialog => this.observe(record, dialog);
    try {
      return await this.within(record, async () => {
        await validateScope(record.scope); this.check(record); assertScope(record.scope);
        record.state = "arming";
        page.on("close", record.closed); page.on("dialog", record.listener);
        // Page.on's internal updateSubscription discards the ACK. The explicit
        // ordered round trip is the ready boundary, not EventEmitter.on().
        record.enabled = this.track(record, page._channel.updateSubscription({ event: "dialog", enabled: true }));
        await record.enabled;
        this.check(record); await validateScope(record.scope); this.check(record); assertScope(record.scope);
        record.state = "pending"; record.ready = true;
        return { dialogId: record.dialogId, remainingMs: Math.max(1, Math.ceil(record.deadlineAt - this.now())) };
      });
    } catch (reason) { this.fail(record, reason); throw reason; }
  }
  observe(record, dialog) {
    let info, malformed;
    try {
      info = { type: dialog.type(), message: dialog.message(), defaultValue: dialog.defaultValue() };
      if (!types.includes(info.type)) throw error("FAILED", "unknown native dialog type");
      text(info.message); text(info.defaultValue);
    } catch { malformed = error("FAILED", "native dialog data exceeds the supported shape or size"); }
    // Capture the native dialog identity synchronously, before any owner await.
    const respond = record.prepareResponse(record.scope, dialog);
    const selected = !malformed && record.ready && record.state === "pending" && !record.invalid &&
      info.type === record.params.type && (record.params.message === undefined || info.message === record.params.message);
    if (selected) { record.state = "responding"; void this.stop(record); }
    const requested = selected ? { accept: record.params.accept,
      ...(record.params.type === "prompt" && record.params.accept ? { promptText: record.params.promptText ?? "" } : {}) } : defaultDecision(dialog.type());
    const actual = this.track(record, (async () => {
      let failure = malformed;
      if (selected) {
        try { await record.validateScope(record.scope); this.check(record); record.assertScope(record.scope); }
        catch (reason) { failure = reason; }
      }
      const check = () => {
        if (failure) throw failure;
        this.check(record); record.assertScope(record.scope);
      };
      // Native adapter checks again at actual dispatch; a withdrawn decision
      // can only use the upstream default on that same still-open dialog.
      const submitted = await respond(requested, selected ? check : null);
      if (selected) {
        check();
        if (submitted.fallback) throw submitted.error ?? expired();
        this.finish(record, "matched", { ...info, accepted: requested.accept,
          ...(requested.promptText !== undefined ? { promptText: requested.promptText } : {}) });
      } else if (malformed) throw malformed;
    })().catch(reason => {
      if (reason?.dialogCleanupRequired) record.responseCleanupError = reason;
      throw reason;
    }));
    record.responses.add(actual);
    actual.finally(() => record.responses.delete(actual)).catch(() => {});
    actual.catch(reason => {
      this.fail(record, /^OBU_DIALOG_/.test(reason?.message ?? "") ? reason : error("FAILED", "native dialog decision failed"));
    });
  }
  lookup(params) {
    handle(params);
    const record = this.records.get(params.dialogId);
    if (!record || !sameScope(record.params, params)) throw expired();
    return record;
  }
  async collect(params) {
    const record = this.lookup(params);
    await record.completion.promise;
    if (record.invalid) throw record.error ?? expired();
    await record.validateScope(record.scope);
    if (record.invalid || this.records.get(record.dialogId) !== record) throw record.error ?? expired();
    record.assertScope(record.scope);
    await record.cleanup;
    return structuredClone(record.value);
  }
  invalidate(record, reason = expired(), retry = true) {
    if (!record.invalid) {
      record.invalid = true; record.error = reason; record.state = "failed";
      this.clearTimer(record.timer); record.cancellation.resolve(reason); record.completion.resolve();
    }
    record.retireAt = this.now();
    this.retireLater(record);
    const cleanup = this.stop(record, retry);
    // Admission may itself be waiting for this detach. Drain only response and
    // subscription operations here; global snapshot retains the admission too.
    return Promise.all([cleanup, ...record.responses].map(value => value === cleanup ? value : value.catch(() => {}))).then(() => {
      if (record.responseCleanupError) {
        if (!retry || !record.responseCleanupError.dialogCleanupComplete()) throw error("FAILED", "original native dialog cleanup is unconfirmed");
        record.responseCleanupError = undefined;
      }
      this.releaseSlot(record);
    });
  }
  async cancel(params) {
    handle(params);
    if (!this.records.has(params.dialogId)) return {};
    const record = this.lookup(params); await this.invalidate(record); return {};
  }
  invalidateWhere(predicate, reason) {
    const promises = [...this.records.values()].filter(predicate).map(record => this.invalidate(record, reason));
    return Promise.all(promises).then(() => {});
  }
  invalidateTab(tabId, preserve = null) { return this.invalidateWhere(record => record.params.tabId === tabId && record !== preserve); }
  invalidateAttachedTab(tabId) { return this.invalidateWhere(record => record.params.tabId === tabId && record.scope); }
  documentChanged(tabId) { return this.invalidateWhere(record => record.params.tabId === tabId && record.scope && ["arming", "pending"].includes(record.state)); }
  invalidateSession(sessionId) { return this.invalidateWhere(record => record.params.session_id === sessionId); }
  invalidateAll() { return this.invalidateWhere(() => true); }
  controlSnapshot() { return { tabIds: [...new Set([...this.records.values()].filter(record => record.scope && this.byTab.get(record.params.tabId) === record).map(record => record.params.tabId))], pending: [...this.operations, ...[...this.byTab.values()].map(record => record.completion.promise)] }; }
}
