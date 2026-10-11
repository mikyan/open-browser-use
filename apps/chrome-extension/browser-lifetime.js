// Browser IDs outlive neither the extension-loaded session nor its native
// targets. The session marker revokes ownership; only positive evidence retires
// unknown input. Missing session storage and debugger target-list absence are
// deliberately not destruction evidence.
export const BROWSER_LIFETIME_KEY = "OPEN_BROWSER_USE_BROWSER_LIFETIME";
export const INPUT_RISK_KEY = "OPEN_BROWSER_USE_INPUT_RISKS";
const MAX_RISKS = 10000;
const id = value => typeof value === "string" && value.length > 0 && value.length <= 128;
const tab = value => Number.isSafeInteger(value) && value >= 0;
const invalid = () => new Error("OBU_BROWSER_LIFETIME_INVALID: persisted browser lifetime is invalid");
const unknown = () => new Error("OBU_INPUT_RELEASE_UNCONFIRMED: previous native input cannot be attributed; automation remains blocked until original-target destruction is proven");

export class BrowserLifetime {
  constructor({ storage, onStartup, legacyPending = async () => ({ tabIds: [] }), randomUUID = () => crypto.randomUUID() }) {
    this.storage = storage;
    this.randomUUID = randomUUID;
    this.records = new Map();
    this.recovered = new Set();
    this.pending = new Set();
    this.writes = Promise.resolve();
    this.startupSeen = false;
    onStartup?.addListener(() => this.observeStartup());
    this.ready = this.load(legacyPending);
    this.ready.catch(() => {});
  }

  track(promise) {
    this.pending.add(promise);
    promise.finally(() => this.pending.delete(promise)).catch(() => {});
    return promise;
  }

  enqueue(operation) {
    const write = this.writes.catch(() => {}).then(operation);
    this.writes = write;
    return this.track(write);
  }

  async load(legacyPending) {
    const [session, local, legacy] = await Promise.all([
      this.storage.session.get(BROWSER_LIFETIME_KEY), this.storage.local.get(INPUT_RISK_KEY), legacyPending()
    ]);
    const saved = session?.[BROWSER_LIFETIME_KEY], riskState = local?.[INPUT_RISK_KEY];
    if (saved !== undefined && (!saved || saved.version !== 1 || !id(saved.incarnation) ||
      !Array.isArray(saved.startupCandidates) || saved.startupCandidates.length > MAX_RISKS ||
      saved.startupCandidates.some(value => !id(value)) || typeof saved.startupConsumed !== "boolean" ||
      !(saved.startupWitness == null || id(saved.startupWitness)))) throw invalid();
    if (riskState !== undefined && (!riskState || riskState.version !== 1 || !Array.isArray(riskState.risks) || riskState.risks.length > MAX_RISKS)) throw invalid();
    for (const record of riskState?.risks ?? []) {
      if (!record || !id(record.riskId) || !tab(record.tabId) || !(record.incarnation === null || id(record.incarnation)) ||
        !(record.startupWitness == null || id(record.startupWitness)) || this.records.has(record.riskId)) throw invalid();
      this.records.set(record.riskId, Object.freeze({ riskId: record.riskId, tabId: record.tabId, incarnation: record.incarnation, startupWitness: record.startupWitness ?? null }));
    }
    let imported = false;
    for (const tabId of legacy?.tabIds ?? []) {
      if (!tab(tabId)) throw invalid();
      const incarnation = id(legacy.incarnation) ? legacy.incarnation : null;
      if ([...this.records.values()].some(record => record.tabId === tabId && record.incarnation === incarnation)) continue;
      if (this.records.size >= MAX_RISKS) throw invalid();
      const riskId = this.randomUUID();
      this.records.set(riskId, Object.freeze({ riskId, tabId, incarnation, startupWitness: null }));
      imported = true;
    }
    this.marker = saved ? structuredClone(saved) : { version: 1, incarnation: this.randomUUID(), startupCandidates: [...this.records.keys()], startupConsumed: false, startupWitness: null };
    this.incarnation = this.marker.incarnation;
    for (const riskId of this.records.keys()) this.recovered.add(riskId);
    if (imported) await this.persistRisks();
    if (!saved) await this.enqueue(() => this.storage.session.set({ [BROWSER_LIFETIME_KEY]: this.marker }));
    await this.consumeStartup();
  }

  persistRisks() {
    const snapshot = { version: 1, risks: [...this.records.values()] };
    return this.enqueue(() => this.storage.local.set({ [INPUT_RISK_KEY]: snapshot }));
  }

  isCurrent(incarnation) { return id(this.incarnation) && incarnation === this.incarnation; }

  observeStartup() {
    this.startupSeen = true;
    // The event is registered synchronously; absence is never interpreted as a
    // restart. A late event sees only the immutable prior-incarnation candidates.
    const operation = this.ready.then(() => this.consumeStartup());
    this.track(operation);
    return operation;
  }

  async consumeStartup() {
    if ((!this.startupSeen && !this.marker.startupWitness) || this.marker.startupConsumed) return;
    return this.enqueue(async () => {
      if (this.marker.startupConsumed) return;
      // Persist the once-per-profile event's identity before changing risks.
      // A crash after stamping a null risk must not turn replay into clearing it.
      const witness = this.marker.startupWitness ?? this.randomUUID();
      const intent = { ...this.marker, startupWitness: witness, startupConsumed: false };
      await this.storage.session.set({ [BROWSER_LIFETIME_KEY]: structuredClone(intent) });
      this.marker = intent;
      const candidates = new Set(intent.startupCandidates), next = new Map();
      for (const [riskId, record] of this.records) {
        if (candidates.has(riskId) && record.incarnation !== this.incarnation && record.startupWitness && record.startupWitness !== witness) continue;
        next.set(riskId, record.startupWitness ? record : Object.freeze({ ...record, startupWitness: witness }));
      }
      await this.storage.local.set({ [INPUT_RISK_KEY]: { version: 1, risks: [...next.values()] } });
      this.records = next;
      for (const riskId of this.recovered) if (!next.has(riskId)) this.recovered.delete(riskId);
      const complete = { ...intent, startupCandidates: [], startupConsumed: true };
      await this.storage.session.set({ [BROWSER_LIFETIME_KEY]: complete });
      this.marker = complete;
    });
  }

  async markInputRisk({ riskId, tabId, incarnation = this.incarnation }) {
    await this.ready;
    if (!id(riskId) || !tab(tabId) || !this.isCurrent(incarnation)) throw invalid();
    return this.enqueue(async () => {
      const previous = this.records.get(riskId);
      if (previous && (previous.tabId !== tabId || previous.incarnation !== incarnation || this.recovered.has(riskId))) throw invalid();
      if (!previous) {
        if (this.records.size >= MAX_RISKS) throw new Error("OBU_INPUT_RISK_LIMIT: too many unresolved input attachments");
        this.records.set(riskId, Object.freeze({ riskId, tabId, incarnation, startupWitness: this.marker.startupWitness ?? null }));
      }
      await this.storage.local.set({ [INPUT_RISK_KEY]: { version: 1, risks: [...this.records.values()] } });
    });
  }

  async clearInputRisk(riskId) {
    await this.ready;
    // Live tracker cleanup cannot claim a replacement worker's unknown state.
    if (this.recovered.has(riskId)) throw unknown();
    return this.enqueue(async () => {
      const record = this.records.get(riskId);
      await this.storage.local.set({ [INPUT_RISK_KEY]: { version: 1, risks: [...this.records.values()].filter(value => value.riskId !== riskId) } });
      if (this.records.get(riskId) === record) this.records.delete(riskId);
    });
  }

  async originalTabRemoved(tabId) {
    await this.ready;
    return this.enqueue(async () => {
      const removed = [];
      for (const [riskId, record] of this.records) {
      // Within one extension-loaded incarnation Chrome tab IDs cannot be reused.
      // Across incarnations the same numeric ID is unrelated and ignored.
      if (record.tabId === tabId && record.incarnation === this.incarnation) {
        removed.push(riskId);
      }
      }
      if (!removed.length) return;
      await this.storage.local.set({ [INPUT_RISK_KEY]: { version: 1, risks: [...this.records.values()].filter(value => !removed.includes(value.riskId)) } });
      for (const riskId of removed) { this.records.delete(riskId); this.recovered.delete(riskId); }
    });
  }

  recoveredRisks() { return [...this.recovered].map(key => this.records.get(key)).filter(Boolean); }
  assertInputRecoveryClear() { if (this.recoveredRisks().length) throw unknown(); }
  controlSnapshot() { return { tabIds: [], pending: [...this.pending] }; }
}
