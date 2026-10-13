// Ready-first waits over real Playwright Page events. This registry never
// scans diagnostics history, reads headers/bodies, or invokes page JavaScript.
import { updatePageSubscription } from "./browser-page-subscriptions.js";
const encoder = new TextEncoder();
const MAX_RESULT_BYTES = 16 * 1024;
const scopeFields = ["session_id", "turn_id", "control_epoch", "tabId"];
const expired = () => new Error("OBU_NETWORK_WAIT_EXPIRED: network wait is no longer available");
const timedOut = () => new Error("OBU_NETWORK_WAIT_TIMEOUT: the original network wait deadline expired");
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function objectKeys(value, allowed, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`${label} does not support ${key}`);
}
function text(value, label, maxBytes) {
  if (typeof value !== "string" || !value.length || value.length > maxBytes || encoder.encode(value).length > maxBytes)
    throw new Error(`${label} must be a non-empty string of at most ${maxBytes} UTF-8 bytes`);
}
function scopeParams(params, allowed) {
  objectKeys(params, [...scopeFields, ...allowed], "network wait");
  text(params.session_id, "session_id", 4096);
  text(params.turn_id, "turn_id", 4096);
  if (!Number.isSafeInteger(params.control_epoch) || params.control_epoch < 1) throw new Error("control_epoch must be a positive safe integer");
  if (!Number.isSafeInteger(params.tabId) || params.tabId < 0) throw new Error("tabId must be a nonnegative safe integer");
}
export function validateNetworkWait(params) {
  scopeParams(params, ["event", "match", "timeoutMs"]);
  if (!["request", "response"].includes(params.event)) throw new Error("event must be request or response");
  objectKeys(params.match, ["url", "urlMatch", "method", "status"], "network match");
  text(params.match.url, "match.url", 4096);
  if (params.match.urlMatch !== undefined && !["exact", "contains"].includes(params.match.urlMatch)) throw new Error("urlMatch must be exact or contains");
  if (params.match.method !== undefined) text(params.match.method, "match.method", 128);
  if (params.match.status !== undefined && (params.event !== "response" || !Number.isInteger(params.match.status) || params.match.status < 100 || params.match.status > 599))
    throw new Error("status must be a response status from 100 to 599");
  const timeoutMs = params.timeoutMs ?? 10000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw new Error("timeoutMs must be an integer from 1 to 120000");
  return Object.freeze({ ...params, timeoutMs, match: Object.freeze({ ...params.match, urlMatch: params.match.urlMatch ?? "exact" }) });
}
function handleParams(params) {
  scopeParams(params, ["waiterId"]);
  text(params.waiterId, "waiterId", 128);
}
function sameScope(left, right) { return scopeFields.every(key => left[key] === right[key]); }
function shortText(value, budget) {
  const { read } = encoder.encodeInto(value, new Uint8Array(budget));
  return value.slice(0, read);
}

function describe(record, value, request, url, method) {
  const result = { event: record.params.event, requestId: record.requestState.id(request), url, method, resourceType: request.resourceType() };
  if (record.candidate) result.frameUrl = record.candidate.frameUrl;
  else try { result.frameUrl = request.frame().url(); } catch {} // Unrestricted worker requests may have no Frame.
  const previous = request.redirectedFrom();
  if (previous) result.redirectedFrom = record.requestState.id(previous);
  if (result.event === "response") {
    result.status = value.status(); result.statusText = value.statusText();
    if (!Number.isInteger(result.status) || result.status < 100 || result.status > 599) throw new Error("Invalid native response status");
  }
  const budgets = { url: 4096, method: 128, resourceType: 128, frameUrl: 4096, statusText: 1024 };
  for (const [key, budget] of Object.entries(budgets)) {
    if (result[key] === undefined) continue;
    if (typeof result[key] !== "string") throw new Error(`Invalid native ${key}`);
    const limited = shortText(result[key], budget);
    if (limited !== result[key]) result.truncated = true;
    result[key] = limited;
  }
  // JSON escaping can consume more bytes than the raw UTF-8 fields. Bound the
  // actual wire representation too, preserving complete Unicode characters.
  while (encoder.encode(JSON.stringify(result)).length > MAX_RESULT_BYTES) {
    const key = Object.keys(budgets).filter(key => result[key]?.length).sort((a, b) => result[b].length - result[a].length)[0];
    if (!key) throw new Error("Native network result exceeds its metadata budget");
    result[key] = shortText(result[key], Math.max(0, Math.floor(encoder.encode(result[key]).length / 2)));
    result.truncated = true;
  }
  return Object.freeze(result);
}

export class BrowserNetworkWaits {
  constructor({ now = () => performance.now(), setTimer = (callback, delay) => setTimeout(callback, delay), clearTimer = timer => clearTimeout(timer), ttlMs = 30000, maxPerTab = 16, maxPerSession = 32, maxTotal = 128 } = {}) {
    Object.assign(this, { now, setTimer, clearTimer, ttlMs, maxPerTab, maxPerSession, maxTotal });
    this.records = new Map();
    this.operations = new Set();
    this.requestStates = new WeakMap();
    this.cleanups = new Set();
  }

  reserve(request, { deadlineAt } = {}) {
    const params = validateNetworkWait(request);
    const now = this.now();
    deadlineAt ??= now + params.timeoutMs;
    if (!Number.isFinite(deadlineAt) || deadlineAt <= now) throw timedOut();
    deadlineAt = Math.min(deadlineAt, now + params.timeoutMs);
    const records = [...new Set([...this.records.values(), ...this.cleanups])];
    if (records.length >= this.maxTotal || records.filter(record => record.params.tabId === params.tabId).length >= this.maxPerTab || records.filter(record => record.params.session_id === params.session_id).length >= this.maxPerSession)
      throw new Error("OBU_NETWORK_WAIT_LIMIT: network wait capacity reached");
    const completion = deferred(), cancellation = deferred(), disposed = deferred();
    const record = { params, deadlineAt, waiterId: crypto.randomUUID(), state: "reserved", ready: false, completion, cancellation, disposed, cancelled: cancellation.promise, listeners: [] };
    this.records.set(record.waiterId, record);
    record.timer = this.setTimer(() => this.finish(record, "timed-out", timedOut()), Math.max(0, deadlineAt - now));
    return record;
  }

  check(record, selectedEvent = false) {
    if (this.records.get(record.waiterId) !== record) throw expired();
    if (["timed-out", "failed"].includes(record.state)) throw record.error;
    if (this.now() >= (selectedEvent ? record.validationDeadlineAt : record.deadlineAt)) throw timedOut();
  }

  track(promise) {
    this.operations.add(promise);
    promise.finally(() => this.operations.delete(promise)).catch(() => {});
    return promise;
  }

  within(record, operation, { selectedEvent = false } = {}) {
    const running = (async () => {
      this.check(record, selectedEvent);
      let timer;
      const deadline = new Promise((_, reject) => {
        const checkDeadline = () => {
          const remaining = (selectedEvent ? record.validationDeadlineAt : record.deadlineAt) - this.now();
          if (remaining <= 0) reject(timedOut());
          else timer = this.setTimer(checkDeadline, remaining);
        };
        checkDeadline();
      });
      try {
        const result = await Promise.race([Promise.resolve().then(() => { this.check(record, selectedEvent); return operation(); }), record.cancelled.then(error => { throw error; }), deadline]);
        this.check(record, selectedEvent);
        return result;
      } finally { this.clearTimer(timer); }
    })();
    return this.track(running);
  }

  subscription(record) {
    if (record.pageClosed) return Promise.resolve();
    return this.track(updatePageSubscription(record.page, record.params.event));
  }

  cleanupListeners(record, retry = false) {
    const removed = record.listeners.splice(0);
    for (const remove of removed) remove();
    if (record.cleanup && !(retry && record.cleanupError)) return record.cleanup;
    if (!removed.length && !record.cleanup) return Promise.resolve();
    if (!record.page?._channel?.updateSubscription) return record.cleanup = Promise.resolve();
    this.cleanups.add(record);
    const actual = this.subscription(record).catch(reason => {
      if (!record.pageClosed && !record.page?.isClosed?.()) throw reason;
    });
    record.cleanup = this.track(actual.then(() => {
      record.cleanupError = undefined; this.cleanups.delete(record);
    }, () => {
      record.cleanupError = new Error("OBU_NETWORK_WAIT_FAILED: original network subscription cleanup is unconfirmed");
      throw record.cleanupError;
    }));
    record.cleanup.catch(() => {});
    return record.cleanup;
  }

  finish(record, state, value) {
    if (this.records.get(record.waiterId) !== record || ["matched", "timed-out", "failed"].includes(record.state)) return;
    this.cleanupListeners(record);
    this.clearTimer(record.timer);
    record.state = state;
    if (state === "matched") record.value = value;
    else {
      record.error = value;
      record.cancellation.resolve(value);
    }
    record.completion.resolve();
    record.timer = this.setTimer(() => this.remove(record), this.ttlMs);
  }

  remove(record, retry = false) {
    if (this.records.get(record.waiterId) !== record) return this.cleanupListeners(record, retry);
    this.records.delete(record.waiterId);
    const cleanup = this.cleanupListeners(record, retry);
    record.removeClose?.();
    record.removeClose = undefined;
    this.clearTimer(record.timer);
    record.cancellation.resolve(expired());
    record.disposed.resolve(expired());
    record.completion.resolve();
    return cleanup;
  }

  fail(record, error) {
    if (!record.ready) this.remove(record);
    else this.finish(record, "failed", /^OBU_SITE_ACCESS_/.test(error?.message ?? "") ? error : new Error("OBU_NETWORK_WAIT_FAILED: " + shortText(String(error?.message ?? error), 2048)));
  }

  async arm(record, page, scope, validateScope, { assertScope = () => {}, captureCandidate } = {}) {
    this.check(record);
    if (record.state !== "reserved" || !sameScope(record.params, scope) || typeof validateScope !== "function") throw new Error("Invalid network wait registration scope");
    record.state = "arming";
    record.scope = Object.freeze({ ...scope });
    record.validateScope = validateScope;
    Object.assign(record, { page, assertScope, captureCandidate });
    try { await this.within(record, () => validateScope(record.scope)); }
    catch (error) { this.remove(record); throw error; }
    let state = this.requestStates.get(page);
    if (!state || state.attachment !== scope.attachment) {
      const ids = new WeakMap(); let next = 0;
      state = { attachment: scope.attachment, id: request => { if (!ids.has(request)) ids.set(request, `request-${++next}`); return ids.get(request); } };
      this.requestStates.set(page, state);
    }
    record.requestState = state;
    const listener = value => this.observe(record, value);
    const closed = () => { record.pageClosed = true; this.remove(record); };
    try {
      page.on(record.params.event, listener);
      record.listeners.push(() => page.off(record.params.event, listener));
      page.on("close", closed);
      record.removeClose = () => page.off("close", closed);
      record.state = "pending";
      record.enabled = this.subscription(record);
      await this.within(record, () => record.enabled);
      await this.within(record, () => validateScope(record.scope));
      this.check(record); record.assertScope(record.scope);
      record.ready = true;
      return { waiterId: record.waiterId, remainingMs: Math.max(1, Math.min(record.params.timeoutMs, Math.ceil(record.deadlineAt - this.now()))) };
    } catch (error) { this.remove(record); throw error; }
  }

  observe(record, value) {
    if (this.records.get(record.waiterId) !== record || record.state !== "pending") return;
    const occurredAt = this.now();
    if (occurredAt >= record.deadlineAt) { this.finish(record, "timed-out", timedOut()); return; }
    try {
      const request = record.params.event === "response" ? value.request() : value;
      const url = request.url(), method = request.method(), match = record.params.match;
      if ((match.urlMatch === "exact" ? url !== match.url : !url.includes(match.url)) || (match.method !== undefined && method !== match.method) || (match.status !== undefined && value.status() !== match.status)) return;
      // Choose the first candidate synchronously before an asynchronous owner
      // check. A later event never wins because its validation was faster.
      record.state = "matching";
      record.selectedAt = occurredAt;
      record.validationDeadlineAt = this.now() + 10000;
      this.clearTimer(record.timer);
      record.timer = this.setTimer(() => this.finish(record, "failed", new Error("OBU_NETWORK_WAIT_FAILED: event scope validation timed out")), 10000);
      record.candidate = record.captureCandidate?.(request, value);
      this.cleanupListeners(record);
      const result = describe(record, value, request, url, method);
      this.within(record, () => record.validateScope(record.scope), { selectedEvent: true }).then(() => {
        record.assertScope(record.scope);
        this.finish(record, "matched", result);
      }).catch(error => {
        if (!["timed-out", "failed"].includes(record.state)) {
          if (/^OBU_SITE_ACCESS_/.test(error?.message ?? "")) this.fail(record, error);
          else this.remove(record);
        }
      });
    } catch (error) { this.fail(record, error); }
  }

  lookup(params) {
    handleParams(params);
    const record = this.records.get(params.waiterId);
    if (!record || !sameScope(params, record.params)) throw expired();
    return record;
  }

  validateResultScope(record, includeCleanup = false) {
    return this.track((async () => {
      if (this.records.get(record.waiterId) !== record || !record.ready) throw expired();
      let timer;
      const terminal = ["matched", "timed-out", "failed"].includes(record.state);
      const deadline = new Promise((_, reject) => { timer = this.setTimer(() => reject(new Error("OBU_NETWORK_WAIT_FAILED: result scope validation timed out")), 10000); });
      try {
        await Promise.race([Promise.resolve().then(async () => {
          await record.validateScope(record.scope);
          if (includeCleanup) await record.cleanup;
        }), record.disposed.promise.then(error => { throw error; }), deadline,
          ...(!terminal ? [record.cancelled.then(error => { throw error; })] : [])]);
        if (this.records.get(record.waiterId) !== record) throw expired();
        record.assertScope(record.scope);
      } catch (error) { if (!["timed-out", "failed"].includes(record.state)) this.remove(record); throw error; }
      finally { this.clearTimer(timer); }
    })());
  }

  collect(params) { return this.track((async () => {
    const record = this.lookup(params);
    await this.validateResultScope(record);
    await record.completion.promise;
    if (this.records.get(record.waiterId) !== record) throw expired();
    await this.validateResultScope(record, true);
    if (record.state !== "matched") throw record.error ?? expired();
    record.assertScope(record.scope);
    return structuredClone(record.value);
  })()); }

  async cancel(params) {
    handleParams(params);
    const record = this.records.get(params.waiterId) ?? [...this.cleanups].find(value => value.waiterId === params.waiterId);
    if (!record || !sameScope(record.params, params)) return {};
    await this.remove(record, true);
    return {};
  }

  invalidateWhere(predicate) {
    const cleanup = Promise.all([...new Set([...this.records.values(), ...this.cleanups])].filter(predicate).map(record => this.remove(record, true))).then(() => {});
    cleanup.catch(() => {}); return cleanup;
  }
  invalidateTab(tabId) { return this.invalidateWhere(record => record.params.tabId === tabId); }
  invalidateAttachedTab(tabId) { return this.invalidateWhere(record => record.params.tabId === tabId && record.scope); }
  invalidateSession(sessionId) { return this.invalidateWhere(record => record.params.session_id === sessionId); }
  invalidateAll() { return this.invalidateWhere(() => true); }
  controlSnapshot() { return { tabIds: [...new Set([...this.records.values(), ...this.cleanups].filter(record => record.scope).map(record => record.params.tabId))], pending: [...this.operations, ...[...this.records.values()].map(record => record.completion.promise)] }; }
}
