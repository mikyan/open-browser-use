// Durable ownership for the private *frame* allocator only. Clipboard and root
// debugger clients have separate owners and never enter this ledger.
export const PRIVATE_TARGET_LEDGER_KEY = "OPEN_BROWSER_USE_PRIVATE_FRAME_TARGETS";
export const PRIVATE_TARGET_INITIALIZED_KEY = "OPEN_BROWSER_USE_PRIVATE_FRAME_TARGETS_INITIALIZED";
const marker = Object.freeze({ version: 1, allocator: "private-frame-targets" });
const textId = value => typeof value === "string" && value.length > 0 && value.length <= 4096;
const exactKeys = (value, keys) => value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
const validMarker = value => exactKeys(value, ["version", "allocator"]) && value.version === 1 && value.allocator === marker.allocator;
const validLedger = value => {
  if (!exactKeys(value, ["version", "incarnation", "records"]) || value.version !== 1 || !textId(value.incarnation) || !Array.isArray(value.records) || value.records.length > 64) return false;
  const ids = new Set(), targets = new Set();
  return value.records.every(row => {
    if (!exactKeys(row, ["leaseId", "tabId", "rootTargetId", "targetId", "parentFrameId", "phase"]) || !textId(row.leaseId) || !Number.isSafeInteger(row.tabId) || row.tabId < 0 || !textId(row.rootTargetId) || !textId(row.targetId) || !textId(row.parentFrameId) || row.rootTargetId === row.targetId || !["intent", "owned"].includes(row.phase) || ids.has(row.leaseId) || targets.has(row.targetId)) return false;
    ids.add(row.leaseId); targets.add(row.targetId); return true;
  });
};
const sameLedger = (left, right) => validLedger(left) && validLedger(right) && left.version === right.version && left.incarnation === right.incarnation && left.records.length === right.records.length && left.records.every((row, index) => Object.keys(row).every(key => row[key] === right.records[index][key]));
const unavailable = () => new Error("OBU_PRIVATE_TARGET_STORE_UNKNOWN: private frame ownership storage is unavailable");

// Native proof, pinned to the browser used by integration tests:
// - OnExtensionUnloaded calls Close(), which calls DetachClient synchronously.
// - Updating removes the old extension before loading the replacement.
// - onInstalled(update) also covers unpacked-extension reload.
// https://github.com/chromium/chromium/blob/156.0.8078.4/chrome/browser/extensions/api/debugger/debugger_api.cc#L644-L646
// https://github.com/chromium/chromium/blob/156.0.8078.4/chrome/browser/extensions/api/debugger/debugger_api.cc#L699-L705
// https://github.com/chromium/chromium/blob/156.0.8078.4/extensions/browser/extension_registrar.cc#L195-L206
// https://developer.chrome.com/docs/extensions/reference/api/runtime#unpacked-extension-behavior
//
// Runtime events have no native generation token and can arrive late. They may
// initialize only a never-initialized store, not erase an existing ledger or
// reopen a lost one. A durable marker is consumed before the first empty ledger
// is written. Neither marker absence, a new BrowserLifetime incarnation,
// startup/chrome_update, nor worker replacement is itself a fresh witness.
// Storage is trusted extension-owned state: privileged deletion of *both* keys
// together with delivery of an old native install event cannot be distinguished
// from first installation and is outside this witness contract.
export class PrivateTargetStore {
  /**
   * Construct once, synchronously during worker evaluation, before the frame
   * registry. Pass the real runtime.onInstalled event, never a request flag.
   * load()/save() are the registry adapter; neither exposes a fresh:true flag.
   * onAvailable fires only after a late native install/update has durably
   * initialized an unavailable store. The caller may then replace its disabled,
   * resource-free registry. Normal input must never await this optional store.
   */
  constructor({ storage, browserLifetime, onInstalled, onAvailable = () => {} }) {
    this.storage = storage; this.browserLifetime = browserLifetime; this.onAvailable = onAvailable;
    this.pending = new Set(); this.writes = Promise.resolve(); this.available = false; this.unknown = "loading";
    this.initialIncarnation = browserLifetime.incarnation; this.installSeen = false; this.used = false;
    onInstalled?.addListener(details => {
      if (!["install", "update"].includes(details?.reason) || this.installSeen) return;
      this.installSeen = true;
      // Capture the current incarnation at delivery, including when lifetime
      // initialization is still pending. The latter is bound by ready below.
      this.witnessIncarnation = this.browserLifetime.incarnation;
      const operation = this.ready.then(() => this.initializeFresh(true));
      this.track(operation).catch(() => {});
    });
    this.ready = this.initialize().catch(() => { this.available = false; this.unknown = "unreadable-storage"; });
    this.track(this.ready);
  }

  track(promise) {
    this.pending.add(promise);
    promise.then(() => this.pending.delete(promise), () => this.pending.delete(promise));
    return promise;
  }

  current() {
    return textId(this.originalIncarnation) && this.browserLifetime.incarnation === this.originalIncarnation;
  }

  async read() {
    return this.track(this.storage.local.get([PRIVATE_TARGET_LEDGER_KEY, PRIVATE_TARGET_INITIALIZED_KEY]));
  }

  async initialize() {
    await this.browserLifetime.ready;
    this.originalIncarnation = this.browserLifetime.incarnation;
    if (!this.current() || (this.initialIncarnation !== undefined && this.initialIncarnation !== this.originalIncarnation)) { this.unknown = "changed-incarnation"; return; }
    const saved = await this.read();
    if (!this.current()) { this.unknown = "changed-incarnation"; return; }
    const ledger = saved?.[PRIVATE_TARGET_LEDGER_KEY], initialized = saved?.[PRIVATE_TARGET_INITIALIZED_KEY];
    this.neverInitialized = ledger === undefined && initialized === undefined;
    if (this.neverInitialized) { this.unknown = "missing-ledger"; await this.initializeFresh(false); return; }
    if (!validMarker(initialized) || !validLedger(ledger)) { this.unknown = "invalid-or-missing-ledger"; return; }
    if (ledger.incarnation !== this.originalIncarnation) {
      // Empty is positive prior cleanup evidence: this exclusive allocator
      // records intent before attach, and clears only after actual cleanup.
      // A nonempty old incarnation cannot be adopted, detached, or erased here.
      if (ledger.records.length) { this.unknown = "previous-incarnation-resources"; return; }
      const rebound = { version: 1, incarnation: this.originalIncarnation, records: [] };
      await this.track(this.storage.local.set({ [PRIVATE_TARGET_LEDGER_KEY]: rebound }));
      if (!this.current()) { this.unknown = "changed-incarnation"; return; }
      this.ledger = rebound;
    } else this.ledger = structuredClone(ledger);
    this.available = true; this.unknown = null;
  }

  initializeFresh(notify) {
    if (this.freshAttempt) return this.freshAttempt;
    if (!this.neverInitialized || !this.installSeen || this.used || this.available || !this.current() || (this.witnessIncarnation !== undefined && this.witnessIncarnation !== this.originalIncarnation)) return Promise.resolve();
    this.freshAttempt = (async () => {
      // Consume the live witness even if a write fails. A replacement worker
      // must not replay it to recreate a missing ownership ledger.
      this.neverInitialized = false;
      const saved = await this.read();
      if (!this.current()) throw unavailable();
      if (saved?.[PRIVATE_TARGET_LEDGER_KEY] !== undefined || saved?.[PRIVATE_TARGET_INITIALIZED_KEY] !== undefined) throw unavailable();
      await this.track(this.storage.local.set({ [PRIVATE_TARGET_INITIALIZED_KEY]: { ...marker } }));
      if (!this.current()) throw unavailable();
      const ledger = { version: 1, incarnation: this.originalIncarnation, records: [] };
      await this.track(this.storage.local.set({ [PRIVATE_TARGET_LEDGER_KEY]: ledger }));
      if (!this.current()) throw unavailable();
      this.ledger = ledger; this.available = true; this.unknown = null;
      if (notify) {
        // A consumer's coordinator is not part of the storage ACK. Its own
        // errors must not turn a successful write into a false storage failure.
        try { Promise.resolve(this.onAvailable()).catch(() => {}); } catch {}
      }
    })().catch(error => { this.available = false; this.unknown = "initialization-failed"; throw error; });
    this.track(this.freshAttempt).catch(() => {});
    return this.freshAttempt;
  }

  async load() {
    await this.ready;
    if (this.freshAttempt) await this.freshAttempt.catch(() => {});
    if (!this.available || !this.current()) return {};
    this.used = true;
    return { ledger: structuredClone(this.ledger) };
  }

  save(ledger) {
    // Capture before enqueueing so caller mutations cannot alter a later write.
    const snapshot = structuredClone(ledger);
    const operation = this.writes.catch(() => {}).then(async () => {
      await this.ready;
      if (!this.available || !this.used || !this.current() || !validLedger(snapshot) || snapshot.incarnation !== this.originalIncarnation) throw unavailable();
      const saved = await this.read();
      if (!this.current() || !validMarker(saved?.[PRIVATE_TARGET_INITIALIZED_KEY]) || !sameLedger(saved?.[PRIVATE_TARGET_LEDGER_KEY], this.ledger)) {
        this.available = false; this.unknown = "storage-changed"; throw unavailable();
      }
      await this.track(this.storage.local.set({ [PRIVATE_TARGET_LEDGER_KEY]: snapshot }));
      if (!this.current()) { this.available = false; this.unknown = "changed-incarnation"; throw unavailable(); }
      this.ledger = snapshot;
    });
    this.writes = operation;
    return this.track(operation);
  }

  snapshot() {
    return { available: this.available && this.current(), unknown: this.current() ? this.unknown : "changed-incarnation", pending: [...this.pending] };
  }
}
