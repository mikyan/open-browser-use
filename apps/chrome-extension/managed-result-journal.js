// This journal stores provenance and cleanup obligations, never a task grant.
// A replacement worker must be explicitly admitted by the original manager.
export const MANAGED_RESULT_DATABASE = "open-browser-use-managed-results";
export const MANAGED_RESULT_STORE = "journal";
const KEY = "state", LIMIT = 256, VIEW_LIMIT = 64;
const failure = message => new Error(`OBU_MANAGED_JOURNAL_UNCONFIRMED: ${message}`);
const text = value => typeof value === "string" && value.length > 0 && value.length <= 128 && !value.includes("\0");
const integer = value => Number.isSafeInteger(value) && value >= 0;
const fields = (value, names) => value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
const position = value => fields(value, ["windowId", "groupId", "pinned"]) && integer(value.windowId) &&
  Number.isSafeInteger(value.groupId) && value.groupId >= -1 && typeof value.pinned === "boolean";
const validRecord = value => fields(value, ["recordId", "revision", "tabId", "targetId", "originalDocument", "currentDocument", "position"]) &&
  ["recordId", "targetId", "originalDocument", "currentDocument"].every(key => text(value[key])) && integer(value.tabId) &&
  integer(value.revision) && value.revision > 0 && position(value.position);
const validView = value => fields(value, ["leaseId", "recordId", "tabId", "targetId", "documentId", "phase"]) &&
  ["leaseId", "recordId", "targetId", "documentId"].every(key => text(value[key])) && integer(value.tabId) && ["intent", "attached"].includes(value.phase);
function validState(value) {
  if (!fields(value, ["version", "runId", "browserIncarnation", "journalId", "workerBootId", "workerEpoch", "records", "views"]) ||
      value.version !== 1 || !["runId", "browserIncarnation", "journalId", "workerBootId"].every(key => text(value[key])) ||
      !integer(value.workerEpoch) || value.workerEpoch < 1 || !Array.isArray(value.records) || !Array.isArray(value.views) ||
      value.records.length > LIMIT || value.views.length > VIEW_LIMIT || !value.records.every(validRecord) || !value.views.every(validView)) return false;
  return [value.records.map(row => row.recordId), value.records.map(row => row.tabId), value.records.map(row => row.targetId),
    value.views.map(row => row.leaseId), value.views.map(row => row.tabId)].every(values => new Set(values).size === values.length);
}

export class ManagedResultJournal {
  constructor({ indexedDB = globalThis.indexedDB, runId, incarnation, newId = () => crypto.randomUUID() }) {
    if (!text(runId) || typeof incarnation !== "function" || typeof newId !== "function") throw failure("invalid configuration");
    Object.assign(this, { runId, incarnation, newId });
    this.pending = new Set(); this.state = null; this.error = null;
    this.ready = new Promise((resolve, reject) => {
      let request;
      try { request = indexedDB.open(MANAGED_RESULT_DATABASE, 1); }
      catch (error) { reject(error); return; }
      request.onblocked = () => { this.error = failure("database open was blocked"); reject(this.error); };
      request.onupgradeneeded = event => {
        if (event.oldVersion !== 0 || request.result.objectStoreNames.length) { request.transaction.abort(); return; }
        request.result.createObjectStore(MANAGED_RESULT_STORE);
      };
      request.onerror = () => reject(failure("database open failed"));
      request.onsuccess = () => {
        const db = request.result;
        if (this.error || db.version !== 1 || db.objectStoreNames.length !== 1 || !db.objectStoreNames.contains(MANAGED_RESULT_STORE)) {
          db.close(); reject(failure("database schema is unavailable")); return;
        }
        this.db = db;
        db.onversionchange = () => { this.error = failure("database version changed"); db.close(); };
        db.onclose = () => { this.error = failure("database connection closed"); };
        resolve();
      };
    });
    this.ready.catch(error => { this.error = error; });
  }

  track(promise) {
    this.pending.add(promise);
    promise.then(() => this.pending.delete(promise), () => this.pending.delete(promise));
    return promise;
  }

  transaction(change, check = () => {}) {
    return this.track((async () => {
      await this.ready;
      if (this.error) throw this.error;
      check();
      return new Promise((resolve, reject) => {
        let transaction, next, result, error;
        try {
          transaction = this.db.transaction(MANAGED_RESULT_STORE, "readwrite", { durability: "strict" });
          // Register settlement before inspecting the store: a schema error
          // below still owns a live transaction and must observe its abort.
          // Request success is not durable completion. A late abort must not
          // publish an epoch or report a native resource as released.
          transaction.oncomplete = () => {
            this.state = structuredClone(next);
            resolve(structuredClone(result));
          };
          transaction.onerror = () => { error ??= failure("journal transaction failed"); };
          transaction.onabort = () => reject(error ?? failure("journal transaction aborted"));
          const store = transaction.objectStore(MANAGED_RESULT_STORE);
          if (store.keyPath !== null || store.autoIncrement || store.indexNames.length) throw failure("unexpected journal schema");
          const get = store.get(KEY), count = store.count();
          let read = false, counted = false;
          const update = () => {
            if (!read || !counted) return;
            try {
              if (count.result !== (get.result === undefined ? 0 : 1) || get.result !== undefined && !validState(get.result))
                throw failure("missing, corrupt or extra journal record");
              check();
              ({ next, result } = change(get.result === undefined ? undefined : structuredClone(get.result)));
              if (!validState(next)) throw failure("invalid journal mutation");
              check(); store.put(next, KEY);
            } catch (reason) { error = reason; transaction.abort(); }
          };
          get.onsuccess = () => { read = true; update(); };
          count.onsuccess = () => { counted = true; update(); };
        } catch (reason) {
          error = reason;
          if (transaction) { try { transaction.abort(); } catch { reject(error); } }
          else reject(error);
        }
      });
    })());
  }

  claimWorker(workerBootId, expected, check = () => {}) {
    if (!text(workerBootId)) return Promise.reject(failure("invalid worker identity"));
    const incarnation = this.incarnation();
    if (!text(incarnation)) return Promise.reject(failure("browser incarnation is unavailable"));
    return this.transaction(saved => {
      let next = saved;
      if (!expected) {
        if (saved && saved.runId === this.runId) {
          if (saved.browserIncarnation !== incarnation || saved.workerBootId !== workerBootId) throw failure("explicit worker recovery is required");
        } else {
          // Only the manager's initial open may initialize a new run. A new
          // Browser incarnation cannot adopt the prior run's stored pages.
          if (saved && saved.browserIncarnation === incarnation) throw failure("another run owns this browser incarnation");
          next = { version: 1, runId: this.runId, browserIncarnation: incarnation, journalId: this.newId(), workerBootId,
            workerEpoch: 1, records: [], views: [] };
        }
      } else {
        if (!saved || saved.runId !== this.runId || saved.browserIncarnation !== incarnation || expected.browserIncarnation !== incarnation ||
            saved.journalId !== expected.expectedJournalId || saved.workerEpoch !== expected.expectedWorkerEpoch ||
            saved.workerBootId !== expected.previousWorkerBootId || saved.workerBootId === workerBootId || saved.workerEpoch >= Number.MAX_SAFE_INTEGER)
          throw failure("original journal or worker epoch does not match");
        if (saved.views.some(view => view.phase !== "attached")) throw failure("original native view attachment outcome is unknown");
        next.workerBootId = workerBootId; next.workerEpoch++;
      }
      return { next, result: next };
    }, check).then(state => { this.writer = this.identity(state); return state; });
  }

  identity(state = this.state) {
    if (!state) throw failure("journal has not been admitted");
    return Object.freeze({ version: 1, browserIncarnation: state.browserIncarnation, journalId: state.journalId, workerEpoch: state.workerEpoch });
  }

  mutate(operation, check) {
    const writer = this.writer;
    return this.transaction(state => {
      if (!writer || !state || state.runId !== this.runId || state.browserIncarnation !== this.incarnation() ||
          state.journalId !== writer.journalId || state.workerEpoch !== writer.workerEpoch)
        throw failure("original worker writer was retired");
      const result = operation(state);
      return { next: state, result };
    }, check);
  }

  commitResults(records, check) {
    const rows = structuredClone(records);
    return this.mutate(state => {
      if (!Array.isArray(rows) || !rows.every(validRecord) || state.records.length + rows.length > LIMIT)
        throw failure("invalid or over-capacity result commit");
      for (const row of rows) {
        if (state.records.some(item => item.recordId === row.recordId || item.tabId === row.tabId || item.targetId === row.targetId) ||
            state.views.some(item => item.tabId === row.tabId)) throw failure("prior result or native cleanup still owns this page");
        state.records.push(row);
      }
      return rows;
    }, check);
  }

  revoke(recordId) {
    return this.mutate(state => {
      state.records = state.records.filter(row => row.recordId !== recordId);
      // Revoking display/input permission never deletes a cleanup obligation.
      return true;
    });
  }

  advance(recordId, revision, documentId, check) {
    return this.mutate(state => {
      const row = state.records.find(item => item.recordId === recordId);
      if (!row || row.revision !== revision || !text(documentId) || row.revision >= Number.MAX_SAFE_INTEGER) throw failure("result revision was retired");
      row.currentDocument = documentId; row.revision++;
      return row;
    }, check);
  }

  beginView(owner, check) {
    const view = { ...structuredClone(owner), phase: "intent" };
    return this.mutate(state => {
      const row = state.records.find(item => item.recordId === view.recordId);
      if (!validView(view) || !row || row.tabId !== view.tabId || row.targetId !== view.targetId || row.currentDocument !== view.documentId ||
          state.views.length >= VIEW_LIMIT || state.views.some(item => item.leaseId === view.leaseId || item.tabId === view.tabId))
        throw failure("native view intent has no exact original result owner");
      state.views.push(view); return view;
    }, check);
  }

  attachedView(leaseId, check) {
    return this.mutate(state => {
      const view = state.views.find(item => item.leaseId === leaseId);
      if (!view || view.phase !== "intent") throw failure("original view intent is unavailable");
      view.phase = "attached"; return view;
    }, check);
  }

  finishView(leaseId) {
    return this.mutate(state => {
      if (!state.views.some(item => item.leaseId === leaseId)) throw failure("original view cleanup owner is unavailable");
      state.views = state.views.filter(item => item.leaseId !== leaseId); return true;
    });
  }

  snapshot() { return { admitted: !!this.writer, pending: [...this.pending], state: this.state ? structuredClone(this.state) : null }; }
}
