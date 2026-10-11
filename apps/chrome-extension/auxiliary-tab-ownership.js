// Explicit ownership of ungrouped ordinary and popup tabs.
// This store does not infer ownership, query Chrome, attach a debugger, or
// release native input. The backend supplies live validation and exact cleanup.
export const AUXILIARY_TABS_KEY = "OPEN_BROWSER_USE_AUXILIARY_TABS";
const expired = () => new Error("OBU_AUXILIARY_CLAIM_EXPIRED: auxiliary claim was cancelled or replaced");
const conflict = () => new Error("OBU_AUXILIARY_CLAIM_CONFLICT: tab already has an auxiliary owner or pending claim");
const blocked = () => new Error("OBU_AUXILIARY_CLEANUP_REQUIRED: retry cleanup before claiming this tab");
const capacity = () => new Error("OBU_AUXILIARY_CAPACITY: auxiliary tab limit reached");
const invalid = () => new Error("OBU_AUXILIARY_STATE_INVALID: invalid persisted auxiliary tab ownership");
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const integer = (value, minimum = 0) => Number.isSafeInteger(value) && value >= minimum;
const identifier = value => typeof value === "string" && value.length > 0 && value.length <= 256;
const fields = ["claimId", "tabId", "windowId", "session_id", "turn_id", "control_epoch", "controlRevision", "kind", "origin", "phase", "excludedGroupId"];
function scope(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !integer(value.tabId) ||
      !identifier(value.session_id) || !identifier(value.turn_id) ||
      (value.control_epoch !== undefined && !integer(value.control_epoch, 1)) ||
      (value.controlRevision !== undefined && !integer(value.controlRevision)))
    throw new Error("Invalid auxiliary claim tab/session/turn/epoch/revision");
  return { tabId: value.tabId, session_id: value.session_id, turn_id: value.turn_id,
    ...(value.control_epoch !== undefined ? { control_epoch: value.control_epoch } : {}),
    ...(value.controlRevision !== undefined ? { controlRevision: value.controlRevision } : {}) };
}
function storedRecord(value, version) {
  try { scope(value); } catch { throw invalid(); }
  const allowed = version === 1 ? fields.filter(key => !["kind", "excludedGroupId"].includes(key)) : fields;
  if (Object.keys(value).some(key => !allowed.includes(key)) || !identifier(value.claimId) ||
      !integer(value.windowId) || !["pending", "committed", "quarantined", ...(version >= 2 ? ["excluded"] : [])].includes(value.phase)) throw invalid();
  if (version === 1) { if (value.origin !== "user") throw invalid(); return { ...value, kind: "popup" }; }
  if (!["popup", "ordinary", ...(version >= 3 ? ["background-window"] : [])].includes(value.kind) || !["agent", "user"].includes(value.origin) ||
      (value.kind === "popup" && value.origin !== "user")) throw invalid();
  if (value.kind === "background-window") {
    if (value.origin !== (value.phase === "excluded" ? "user" : "agent") || Object.hasOwn(value, "excludedGroupId")) throw invalid();
  } else if (value.phase === "excluded" ? value.kind !== "ordinary" || value.origin !== "user" || !integer(value.excludedGroupId) : Object.hasOwn(value, "excludedGroupId")) throw invalid();
  return { ...value };
}

export class AuxiliaryTabOwnership {
  constructor({ storage, maxRecords = 256, createId = () => crypto.randomUUID() } = {}) {
    if (!storage || !["get", "set", "setAccessLevel"].every(method => typeof storage[method] === "function"))
      throw new Error("AuxiliaryTabOwnership requires chrome.storage.session with trusted-context access");
    if (!integer(maxRecords, 1) || maxRecords > 256) throw new Error("maxRecords must be between 1 and 256");
    Object.assign(this, { storage, maxRecords, createId });
    this.records = new Map(); // Includes reserved/quarantined reverse locks.
    this.creations = new Set(); // Capacity reserved before Chrome returns a tab ID.
    this.states = new WeakMap();
    this.queues = new Map();
    this.operations = new Set();
    this.writes = Promise.resolve();
    this.ready = this.load().then(() => { this.loaded = true; });
    this.ready.catch(error => { this.loadError = error; });
  }

  state(record) { return this.states.get(record); }

  async load() {
    await this.storage.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
    const stored = await this.storage.get(AUXILIARY_TABS_KEY);
    const value = stored?.[AUXILIARY_TABS_KEY];
    if (value === undefined) return;
    if (!value || ![1, 2, 3].includes(value.version) || !Array.isArray(value.records) || value.records.length > this.maxRecords ||
        Object.keys(value).some(key => !["version", "records"].includes(key))) throw invalid();
    const recovered = value.records.map(record => storedRecord(record, value.version));
    if (new Set(recovered.map(record => record.tabId)).size !== recovered.length ||
        new Set(recovered.map(record => record.claimId)).size !== recovered.length) throw invalid();
    for (const record of recovered) {
      if (record.phase === "pending" && record.origin === "user") continue;
      // A new native tab may already exist. Keep its denial/cleanup identity;
      // recovery must neither grant control nor replay its creation/disposition.
      if (record.phase === "pending") record.phase = "quarantined";
      const reservation = this.records.get(record.tabId);
      if (reservation) {
        const state = this.state(reservation);
        if (!state.error && reservation.session_id === record.session_id && record.phase === "committed") state.replacement = record;
        else state.error ??= reservation.session_id === record.session_id ? blocked() : conflict();
        state.completion.resolve();
      }
      this.states.set(record, { persisted: true, durable: record.phase === "committed", completion: deferred() });
      this.records.set(record.tabId, record);
    }
    // Early reservations cannot displace recovered ownership to satisfy capacity.
    if (this.records.size + this.creations.size > this.maxRecords) {
      for (const record of this.creations) { this.state(record).error = capacity(); this.state(record).completion.resolve(); }
      for (const [tabId, record] of this.records) {
        if (this.state(record).persisted) continue;
        this.state(record).error = capacity();
        this.state(record).completion.resolve();
        this.records.delete(tabId);
      }
    }
    if (value.version < 3 || value.records.some(record => record.phase === "pending")) await this.save();
  }

  reserve(value) {
    const params = scope(value);
    if (this.loadError) throw this.loadError;
    const previous = this.records.get(params.tabId);
    if (previous) {
      if (previous.session_id !== params.session_id) throw conflict();
      if (previous.phase === "excluded") {
        if (this.state(previous).error) throw blocked();
        Object.assign(previous, params);
        return previous; // Only explicit admission receives this non-owner record.
      }
      if (previous.phase === "quarantined") throw blocked();
      if (previous.phase === "committed" && this.state(previous).durable) return previous;
      throw conflict();
    }
    if (this.records.size + this.creations.size >= this.maxRecords) throw capacity();
    const record = { claimId: this.createId(), ...params, windowId: null, kind: "popup", origin: "user", phase: "reserved" };
    if (!identifier(record.claimId)) throw new Error("Invalid auxiliary claim identity");
    if ([...this.records.values(), ...this.creations].some(previous => previous.claimId === record.claimId)) throw new Error("Duplicate auxiliary claim identity");
    this.states.set(record, { persisted: false, durable: false, completion: deferred() });
    this.records.set(record.tabId, record);
    return record;
  }

  reserveCreation(value, { kind = "ordinary" } = {}) {
    if (!["ordinary", "background-window"].includes(kind)) throw invalid();
    const { tabId: _ignored, ...params } = scope({ ...value, tabId: 0 });
    if (this.loadError) throw this.loadError;
    if (!this.loaded) throw new Error("Auxiliary creation requires completed ownership recovery");
    if (this.records.size + this.creations.size >= this.maxRecords) throw capacity();
    const record = { claimId: this.createId(), ...params, tabId: null, windowId: null, kind, origin: "agent", phase: "reserved" };
    if (!identifier(record.claimId) || [...this.records.values(), ...this.creations].some(other => other.claimId === record.claimId)) throw invalid();
    this.states.set(record, { persisted: false, durable: false, completion: deferred() });
    this.creations.add(record);
    return record;
  }

  async bindCreated(record, tab) {
    if (!this.creations.has(record) || !integer(tab?.id) || !integer(tab?.windowId)) throw invalid();
    if (this.records.has(tab.id)) throw conflict();
    this.creations.delete(record);
    record.tabId = tab.id; record.windowId = tab.windowId;
    const state = this.state(record);
    record.phase = state.error ? "quarantined" : "pending";
    state.persisted = true;
    this.records.set(tab.id, record);
    await this.ready;
    await this.save();
    return this.check(record);
  }

  check(record) {
    if (this.loadError) throw this.loadError;
    const state = this.state(record);
    if (!state) throw expired();
    if (state.error) throw state.error;
    if (state.replacement) return this.check(state.replacement);
    if (record.tabId === null ? !this.creations.has(record) : this.records.get(record.tabId) !== record) throw expired();
    if (record.phase === "quarantined") throw blocked();
    return record;
  }

  // Queue/write promises remain real operations: callers may bound their wait,
  // but must not equate a timeout with Chrome having settled its storage write.
  serial(tabId, operation) {
    const previous = this.queues.get(tabId) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(operation);
    this.queues.set(tabId, pending);
    this.operations.add(pending);
    void pending.finally(() => {
      this.operations.delete(pending);
      if (this.queues.get(tabId) === pending) this.queues.delete(tabId);
    }).catch(() => {});
    return pending;
  }

  save() {
    const records = [...this.records.values()].filter(record => this.state(record).persisted && !this.state(record).removing)
      .map(record => Object.fromEntries(fields.filter(key => record[key] !== undefined).map(key => [key, record[key]])));
    const value = { version: 3, records };
    const write = this.writes.catch(() => {}).then(() => this.storage.set({ [AUXILIARY_TABS_KEY]: value }));
    this.writes = write;
    this.operations.add(write);
    void write.finally(() => this.operations.delete(write)).catch(() => {});
    return write;
  }

  commit(reservation, { windowId, kind = reservation?.kind, control_epoch, controlRevision, check, validate } = {}) {
    if (!integer(windowId) || (control_epoch !== undefined && !integer(control_epoch, 1)) ||
        (controlRevision !== undefined && !integer(controlRevision)) || !["popup", "ordinary", "background-window"].includes(kind) ||
        (kind === "background-window" && reservation?.origin !== "agent") || typeof check !== "function" || typeof validate !== "function")
      return Promise.reject(new Error("Auxiliary commit requires window identity, control check, and live validation"));
    return this.serial(reservation?.tabId, async () => {
      let record = reservation;
      try {
        await this.ready;
        record = this.check(record);
        const state = this.state(record);
        const current = () => {
          if (check(record)?.then) throw new Error("Auxiliary commit control check must be synchronous");
          this.check(record);
        };
        current();
        if (record.phase === "excluded") {
          // Backend validation must prove that this explicit claim has really
          // left its excluded native group before admitting ungrouped ownership.
          await validate(record);
          current();
          delete record.excludedGroupId;
          record.phase = "reserved";
        }
        if (record.phase === "committed") {
          if (!state.durable) throw blocked();
          if (record.windowId !== windowId || record.kind !== kind) { this.quarantine(record); throw blocked(); }
          await validate(record);
          current();
          return record;
        }
        if (record.phase !== "reserved" && !(record.phase === "pending" && record.origin === "agent")) throw conflict();
        record.windowId = windowId;
        record.kind = kind;
        if (control_epoch !== undefined) record.control_epoch = control_epoch;
        if (controlRevision !== undefined) record.controlRevision = controlRevision;
        record.phase = "pending";
        state.persisted = true;
        await this.save();
        current();
        await validate(record);
        current();
        // The synchronous commit gate wins before an end/Pause that runs later.
        // The membership is still hidden from admission until its write settles.
        record.phase = "committed";
        try { await this.save(); }
        catch (error) { state.error = error; this.quarantine(record); throw error; }
        state.durable = true;
        current();
        return record;
      } catch (error) {
        const state = this.state(record);
        if (state && this.records.get(record.tabId) === record && record.phase !== "committed") {
          state.error ??= error;
          this.quarantine(record);
        }
        throw error;
      } finally {
        this.state(reservation)?.completion.resolve();
        this.state(record)?.completion.resolve();
      }
    });
  }

  quarantine(record) {
    if (record?.tabId === null ? !this.creations.has(record) : this.records.get(record?.tabId) !== record) return false;
    if (record.phase === "excluded") return true; // Release must not erase a persisted denial.
    const changed = record.phase !== "quarantined";
    record.phase = "quarantined";
    const state = this.state(record);
    state.durable = false;
    state.error ??= expired();
    // Persist the denial even if the caller has not started native cleanup yet.
    // Do not put that write ahead of cleanup in the per-tab action queue: a
    // stuck storage operation must not prevent release of native held input.
    if (changed && state.persisted) {
      state.quarantineWrite = this.save();
      state.quarantineWrite.catch(error => { state.error = error; });
    }
    return true;
  }

  cancelPending(sessionId) {
    for (const record of [...this.records.values(), ...this.creations]) {
      if (sessionId !== undefined && record.session_id !== sessionId) continue;
      if (["reserved", "pending"].includes(record.phase)) this.quarantine(record);
    }
  }

  remove(record, { cleanup = async () => {}, releaseExcluded = false } = {}) {
    if (typeof cleanup !== "function") return Promise.reject(new Error("cleanup must be a function"));
    if (!this.quarantine(record)) return Promise.resolve(false);
    if (record.tabId === null) return Promise.resolve(false); // Real create must settle before the slot can be retired.
    return this.serial(record.tabId, async () => {
      await this.ready;
      if (this.records.get(record.tabId) !== record) return false;
      const state = this.state(record);
      try {
        const removed = await cleanup(record);
        if (this.records.get(record.tabId) !== record) return false;
        if (removed === false || (record.phase === "excluded" && !releaseExcluded)) return false;
        state.removing = true;
        if (state.persisted) await this.save();
        if (this.records.get(record.tabId) !== record) return false;
        this.records.delete(record.tabId);
        state.completion.resolve();
        return true;
      } catch (error) {
        state.removing = false;
        state.error = error;
        throw error;
      }
    });
  }

  exclude(record, groupId) {
    if (!integer(groupId) || record?.kind !== "ordinary" || !integer(record.windowId)) return Promise.reject(invalid());
    return this.serial(record.tabId, async () => {
      await this.ready;
      if (this.records.get(record.tabId) !== record) throw expired();
      const state = this.state(record);
      record.phase = "excluded";
      record.origin = "user";
      record.excludedGroupId = groupId;
      state.persisted = true;
      state.durable = false;
      state.removing = false;
      try { await this.save(); state.error = undefined; }
      catch (error) { state.error = error; throw error; }
      finally { state.completion.resolve(); }
      return record;
    });
  }

  excludeBackground(record) {
    if (record?.kind !== "background-window" || !integer(record.windowId)) return Promise.reject(invalid());
    return this.serial(record.tabId, async () => {
      await this.ready;
      if (this.records.get(record.tabId) !== record || record.kind !== "background-window") throw expired();
      const state = this.state(record);
      // A move consists of multiple native events. Retain this exact tab's
      // denial across intermediate ungrouped positions and later regrouping.
      record.phase = "excluded";
      record.origin = "user";
      state.persisted = true;
      state.durable = false;
      state.removing = false;
      try { await this.save(); state.error = undefined; }
      catch (error) { state.error = error; throw error; }
      finally { state.completion.resolve(); }
      return record;
    });
  }

  retireCreation(record) {
    if (record.tabId !== null || !this.creations.delete(record)) return false;
    this.state(record).completion.resolve();
    return true;
  }

  entry(tabId) { return this.records.get(tabId); }
  owner(tabId) {
    const record = this.records.get(tabId);
    return this.loaded && !this.loadError && record?.phase === "committed" && this.state(record).durable ? record : undefined;
  }
  list(sessionId) { return [...this.records.values()].filter(record => record.session_id === sessionId && this.owner(record.tabId) === record); }
  entries(sessionId) { return [...this.records.values()].filter(record => sessionId === undefined || record.session_id === sessionId); }
  async settled(tabId) {
    await this.ready;
    for (;;) {
      const queue = this.queues.get(tabId);
      const write = this.state(this.records.get(tabId))?.quarantineWrite;
      await Promise.all([queue, write]);
      if (!this.queues.has(tabId) && this.state(this.records.get(tabId))?.quarantineWrite === write) return;
    }
  }
  controlSnapshot() {
    return { tabIds: [...this.records.keys()], pending: [...new Set([this.ready, ...this.operations, ...[...this.creations].map(record => this.state(record).completion.promise),
      ...[...this.records.values()].filter(record => ["reserved", "pending"].includes(record.phase)).map(record => this.state(record).completion.promise)])] };
  }
}
