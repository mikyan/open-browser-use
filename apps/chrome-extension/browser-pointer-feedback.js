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
  start({ scope, check, read, decode, cached }) {
    const record = { scope, promise: undefined };
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
    }).catch(() => { candidate.value = null; }).finally(() => {
      candidate.settled = true; this.pending.delete(record);
    });
    candidate.result = record.promise.then(() => candidate.value);
    this.pending.add(record);
    return candidate;
  }
  snapshot(predicate = () => true) { return [...this.pending].filter(predicate).map(record => record.promise); }
  async drain(predicate = () => true) { await Promise.allSettled(this.snapshot(predicate)); }
}
