const defaults = { now: () => performance.now(), setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: timer => clearTimeout(timer) };
const inputTimeout = phase => new Error(`OBU_HUMAN_INPUT_TIMEOUT: original input exceeded its ${phase} wait budget; do not replay it`);

// These limits are a versioned production policy, never caller-supplied timeouts.
// A local monotonic clock accounts original native events; published/coalesced
// status is not a clock. Expiry revokes authority before rejecting the observer.
class Budget {
  constructor(limits, onExpire, timing = {}) {
    this.timing = { ...defaults, ...timing }; this.limits = limits; this.onExpire = onExpire;
    this.used = { normal: 0, modal: 0 }; this.phase = "normal"; this.modal = null;
    this.last = this.timing.now(); this.finished = false; this.timer = null;
    this.expired = new Promise((_resolve, reject) => { this.reject = reject; });
    this.expired.catch(() => {});
    this.arm();
  }
  account() {
    if (this.finished) return false;
    const now = this.timing.now();
    this.used[this.phase] += Math.max(0, now - this.last); this.last = now;
    if (this.used[this.phase] < this.limits[this.phase]) return true;
    this.finished = true; this.timing.clearTimer(this.timer); this.timer = null;
    const error = this.error = this.limits.error(this.phase);
    try { this.onExpire(error); } finally { this.reject(error); }
    return false;
  }
  arm() {
    this.timing.clearTimer(this.timer); this.timer = null;
    if (this.finished) return;
    this.timer = this.timing.setTimer(() => { if (this.account()) this.arm(); }, Math.max(1, this.limits[this.phase] - this.used[this.phase]));
    this.timer?.unref?.();
  }
  finish() {
    this.finished = true; this.timing.clearTimer(this.timer); this.timer = null;
  }
}

class ModalBudget extends Budget {
  openModal(original) {
    if (!this.account() || this.modal) return;
    this.modal = original; this.phase = "modal"; this.arm();
  }
  closeModal(original) {
    if (this.modal !== original || !this.account()) return;
    this.modal = null; this.phase = "normal"; this.arm();
  }
  assertAvailable() { if (!this.account()) throw this.error; }
  observe(actual) {
    const observer = actual.then(value => {
      // Timers can run late. An ACK arriving beyond the cutoff does not undo
      // expiry, although the owner's original Promise still records that ACK.
      if (!this.account()) throw this.error;
      this.finish(); return value;
    }, error => { this.finish(); throw error; });
    return Promise.race([observer, this.expired]);
  }
}

export class ManagedHumanInputBudget extends ModalBudget {
  constructor({ onExpire, timing } = {}) {
    super({ normal: 30000, modal: 300000, error: inputTimeout }, onExpire, timing);
  }
}

// One preparation keeps its remaining ordinary time across redirects and
// verified original dialogs. A first frame ends it; an event/status never
// restarts it. Its expiry observes work, never settles a native Promise.
export class ManagedHumanPreparationBudget extends ModalBudget {
  constructor({ navigation = false, onExpire, timing } = {}) {
    super({ normal: navigation ? 10000 : 5000, modal: 300000,
      error: phase => new Error(`OBU_HUMAN_PREPARATION_TIMEOUT: original ${navigation ? "navigation" : "initial"} preparation exceeded its ${phase} wait budget`) }, onExpire, timing);
  }
}

export class ManagedHumanDialogDeadline extends Budget {
  constructor({ onExpire, timing } = {}) {
    super({ normal: 300000, error: () => new Error("OBU_HUMAN_DIALOG_TIMEOUT: original dialog exceeded its waiting deadline") }, onExpire, timing);
  }
}

// A hint check is browser metadata work, not time granted for a human decision.
// Repeated hints share this one dispatch's deadline; expiry never settles reads.
export class ManagedHumanHintDeadline extends Budget {
  constructor({ onExpire, timing } = {}) {
    super({ normal: 5000, error: () => new Error("OBU_HUMAN_HINT_TIMEOUT: original document hint verification exceeded its deadline") }, onExpire, timing);
  }
  assertAvailable() { if (!this.account()) throw this.error; }
}
