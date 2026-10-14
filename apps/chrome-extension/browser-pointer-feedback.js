// Private, in-process evidence. None of these tags is a CDP parameter or a
// caller-supplied locator. Keep actual reads separate from input-idle admission.
const commandTargets = new WeakMap();
export const pointerFeedbackTarget = Symbol("Open Browser Use original pointer target");
export function tagPointerFeedback(params, target) {
  if (target !== undefined) commandTargets.set(params, target);
  return params;
}
export function pointerCommandTarget(params) { return commandTargets.get(params); }

export function validTargetRect(rect) {
  return rect && [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) && rect.width > 0 && rect.height > 0;
}

export class PassivePointerReads {
  constructor() { this.pending = new Set(); }
  start(spec) {
    return spec.schedule === "latest" ? this.startLatest(spec) : this.startImmediate(spec);
  }
  startImmediate({ scope, check, read, decode, cached, cleanup, retryCleanup }) {
    const record = { scope, promise: undefined, cleanup, retryCleanup, cleanupFailed: false };
    const candidate = { scope, check, value: null, settled: false, result: undefined };
    let original;
    try {
      check();
      const full = this.pending.size >= 16 || [...this.pending].filter(value => value.scope.attachment === scope.attachment).length >= 2;
      original = full ? null : cached === undefined ? read(check) : cached;
    }
    catch { original = null; }
    // The original native Promise remains in pending even if publication is
    // abandoned. Rejection is only unavailable visual evidence, never retry.
    record.promise = Promise.resolve(original).then(value => {
      check();
      const rect = value === null ? null : decode(value);
      candidate.value = validTargetRect(rect) ? Object.freeze({ ...rect }) : null;
    }).catch(() => { candidate.value = null; }).then(async () => {
      try { await cleanup?.(); this.pending.delete(record); this.pumpLatest(scope.attachment); }
      catch (error) {
        candidate.value = null; record.cleanupFailed = true;
        // Immediate cleanup may join an existing cold lane even when its own
        // read was dropped at capacity. Its failure must settle queued hints
        // without allocating through the retained cleanup fence.
        for (const queued of this.pending) if (queued.scope.attachment === scope.attachment) this.cancelQueued(queued);
        throw error;
      }
      finally { candidate.settled = true; }
    });
    // A display result is optional; resource cleanup is not. Keep the rejected
    // native cleanup in pending for lifecycle drains and explicit retry.
    candidate.result = record.promise.then(() => candidate.value, () => null);
    this.pending.add(record);
    return candidate;
  }
  // Cold routes opt in only when construction is allocation-free. No native
  // resource exists until read() starts, so a replaced/cancelled queued item
  // requires neither read nor cleanup. Warm locator evidence keeps its original
  // immediate admission rules. Actual reads plus queued items share the same
  // sixteen-global/two-per-original-attachment bounds.
  startLatest(spec) {
    const { scope, check, cleanup, retryCleanup } = spec;
    const candidate = { scope, check, value: null, settled: false, result: undefined };
    const dropped = () => { candidate.settled = true; candidate.result = Promise.resolve(null); return candidate; };
    try { check(); } catch { return dropped(); }
    if (!scope?.attachment || typeof scope.attachment !== "object") return dropped();
    let related = [...this.pending].filter(record => record.scope.attachment === scope.attachment);
    // A failed cleanup is a fence, not a fresh read opportunity. Mixed warm
    // evidence also retains its original native ordering instead of joining a
    // cold queue whose readiness that immediate path does not own.
    if (related.some(record => !record.latest || record.cleanupFailed || record.state === "retrying")) return dropped();
    for (const record of related) if (record.state === "queued") this.cancelQueued(record);
    related = [...this.pending].filter(record => record.scope.attachment === scope.attachment);
    if (this.pending.size >= 16 || related.length >= 2) return dropped();
    let resolve, reject;
    const record = { scope, cleanup, retryCleanup, cleanupFailed: false, latest: true, state: "queued", spec, candidate,
      promise: new Promise((done, failed) => { resolve = done; reject = failed; }), resolve: value => resolve(value), reject: error => reject(error) };
    candidate.result = record.promise.then(() => candidate.value, () => null);
    this.pending.add(record);
    this.pumpLatest(scope.attachment);
    return candidate;
  }

  cancelQueued(record) {
    if (!record.latest || record.state !== "queued") return;
    record.state = "cancelled"; record.candidate.settled = true;
    this.pending.delete(record); record.resolve();
  }

  pumpLatest(attachment) {
    const related = [...this.pending].filter(record => record.scope.attachment === attachment);
    if (related.some(record => !record.latest || record.state !== "queued")) return;
    const record = related[0];
    if (!record) return;
    const { check, read, cached, decode } = record.spec, candidate = record.candidate;
    // Original turn, document and opaque attachment authority must still hold
    // after the previous candidate's actual cleanup ACK, before any allocation.
    try { check(); } catch { this.cancelQueued(record); return; }
    record.state = "running";
    let original;
    try { original = cached === undefined ? read(check) : cached; } catch { original = null; }
    Promise.resolve(original).then(value => {
      check();
      const rect = value === null ? null : decode(value);
      candidate.value = validTargetRect(rect) ? Object.freeze({ ...rect }) : null;
    }).catch(() => { candidate.value = null; }).then(() => record.cleanup?.()).then(() => {
      record.state = "complete"; candidate.settled = true;
      this.pending.delete(record); record.resolve(); this.pumpLatest(attachment);
    }, error => {
      candidate.value = null; candidate.settled = true;
      record.state = "failed"; record.cleanupFailed = true;
      // Preserve the actual failed cleanup and discard never-started hints.
      // Neither arriving input nor a later native ACK retries this resource.
      for (const queued of this.pending) if (queued.scope.attachment === attachment) this.cancelQueued(queued);
      record.reject(error);
    });
  }

  snapshot(predicate = () => true) { return [...this.pending].filter(predicate).map(record => record.promise); }
  async drain(predicate = () => true, { resourcesOnly = false, retryFailed = false } = {}) {
    const records = [...this.pending].filter(record => predicate(record) && (!resourcesOnly || record.cleanup));
    // Revoke queued evidence synchronously, before the first actual read can
    // settle and launch it during End, Pause, detach, or an action release.
    for (const record of records) this.cancelQueued(record);
    for (const record of records) if (retryFailed && record.cleanupFailed) {
      record.cleanupFailed = false;
      if (record.latest) record.state = "retrying";
      record.promise = Promise.resolve().then(record.retryCleanup ?? record.cleanup).then(() => {
        this.pending.delete(record); if (record.latest) record.state = "complete";
      }, error => {
        record.cleanupFailed = true; if (record.latest) record.state = "failed"; throw error;
      });
      record.promise.catch(() => {});
    }
    const results = await Promise.allSettled(records.map(record => record.promise));
    const failure = results.find(result => result.status === "rejected");
    if (failure) throw failure.reason;
  }
}
