// Explicit GET downloads only. A handle is derived exclusively from the ID
// returned by downloads.download; global events/URLs never establish ownership.
const encoder = new TextEncoder();
const expired = () => new Error("OBU_DOWNLOAD_EXPIRED: unknown, unowned or retired direct download");
const timeout = () => new Error("OBU_DOWNLOAD_TIMEOUT: download operation deadline expired");
const scopeKeys = ["session_id", "turn_id", "control_epoch"];
const size = value => encoder.encode(value).length;

export function downloadDeadline(params, now = Date.now()) {
  const value = params?.timeoutMs === undefined ? 10000 : params.timeoutMs;
  if (!Number.isInteger(value) || value < 1 || value > 120000) throw new Error("timeoutMs must be an integer from 1 to 120000");
  return now + value;
}

export function validateDownloadURL(params) {
  if (!params || typeof params !== "object" || Array.isArray(params)) throw new Error("downloadURL requires an object");
  for (const key of Object.keys(params)) if (![...scopeKeys, "tabId", "url", "filename", "timeoutMs"].includes(key)) throw new Error(`downloadURL does not support ${key}`);
  for (const key of ["session_id", "turn_id"]) if (typeof params[key] !== "string" || !params[key] || size(params[key]) > 4096) throw new Error(`${key} must be nonempty and at most 4096 UTF-8 bytes`);
  if (!Number.isSafeInteger(params.control_epoch) || params.control_epoch < 1) throw new Error("control_epoch must be a positive safe integer");
  if (!Number.isSafeInteger(params.tabId) || params.tabId < 0) throw new Error("tabId must be a nonnegative safe integer");
  if (typeof params.url !== "string" || !params.url || size(params.url) > 8192 || params.url.trim() !== params.url || /[\x00-\x20\x7f]/.test(params.url)) throw new Error("url must be an absolute HTTP(S) URL of at most 8192 UTF-8 bytes without whitespace or controls");
  let url; try { url = new URL(params.url); } catch { throw new Error("url must be an absolute HTTP(S) URL"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("url must use HTTP(S) without embedded credentials");
  const name = params.filename;
  if (name !== undefined && (typeof name !== "string" || !name || size(name) > 255 || /[<>:"/\\|?*\x00-\x1f\x7f]/.test(name) || /[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name))) throw new Error("filename must be a safe single basename of at most 255 UTF-8 bytes");
  downloadDeadline(params);
  return Object.freeze({ ...params });
}

export class BrowserDownloads {
  constructor({ downloads, extensionId, validateScope, assertScope = () => {}, now = () => Date.now(), pollMs = 100, maxRecords = 128 } = {}) {
    Object.assign(this, { downloads, extensionId, validateScope, assertScope, now, pollMs, maxRecords });
    this.records = new Map();
    this.operations = new Set();
  }

  reserve(request) {
    const params = validateDownloadURL(request);
    if (this.records.size >= this.maxRecords) throw new Error("OBU_DOWNLOAD_LIMIT: direct download capacity reached");
    const record = { params, downloadId: crypto.randomUUID(), deadlineAt: downloadDeadline(params, this.now()), invalid: false, cancellationListeners: new Set() };
    this.records.set(record.downloadId, record);
    return record;
  }

  has(id) { return this.records.has(id); }

  check(record) {
    if (record.invalid || this.records.get(record.downloadId) !== record) throw expired();
    if (record.scope) this.assertScope(record.scope);
  }

  lookup(params) {
    const record = this.records.get(params.downloadId);
    if (!record || scopeKeys.some(key => record.params[key] !== params[key]) || (params.tabId !== undefined && params.tabId !== record.params.tabId)) throw expired();
    this.check(record);
    return record;
  }

  async validate(record) {
    this.check(record);
    if (!record.scope) throw expired();
    await this.validateScope(record.scope);
    this.check(record);
  }

  track(promise) {
    this.operations.add(promise);
    promise.then(() => this.operations.delete(promise), () => this.operations.delete(promise));
    return promise;
  }

  // The outer deadline never substitutes for actual native settlement in the
  // cleanup ledger. In particular a late native start ID must still be canceled.
  async within(record, deadlineAt, operation) {
    this.check(record);
    const remaining = deadlineAt - this.now();
    if (remaining <= 0) throw timeout();
    let timer, cancel;
    try {
      const value = await Promise.race([
        Promise.resolve().then(() => { this.check(record); if (deadlineAt <= this.now()) throw timeout(); return operation(); }),
        new Promise((_, reject) => { cancel = () => reject(expired()); record.cancellationListeners.add(cancel); }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(timeout()), remaining); })
      ]);
      this.check(record);
      if (deadlineAt <= this.now()) throw timeout();
      return value;
    } finally { clearTimeout(timer); record.cancellationListeners.delete(cancel); }
  }

  async start(record, scope) {
    this.check(record);
    if (record.startPromise || scopeKeys.some(key => scope[key] !== record.params[key]) || scope.tabId !== record.params.tabId) throw expired();
    record.scope = Object.freeze({ ...scope });
    return this.within(record, record.deadlineAt, async () => {
      await this.validate(record);
      if (this.now() >= record.deadlineAt) throw timeout();
      if (!this.downloads?.download) throw new Error("OBU_DOWNLOAD_UNAVAILABLE: native downloads API is unavailable");
      const options = { url: record.params.url, saveAs: false, conflictAction: "uniquify", ...(record.params.filename === undefined ? {} : { filename: record.params.filename }) };
      record.startPromise = this.track(Promise.resolve(this.downloads.download(options)).then(id => {
        if (!Number.isSafeInteger(id) || id < 0) throw new Error("OBU_DOWNLOAD_FAILED: invalid native download ID");
        record.nativeId = id;
        return id;
      }));
      await record.startPromise;
      await this.validate(record);
      return { downloadId: record.downloadId };
    });
  }

  async path(params, deadlineAt = downloadDeadline(params, this.now())) {
    const record = this.lookup(params);
    return this.within(record, deadlineAt, async () => {
      while (true) {
        await this.validate(record);
        if (this.now() >= deadlineAt) throw timeout();
        const items = await this.track(Promise.resolve(this.downloads.search({ id: record.nativeId })));
        await this.validate(record);
        const item = items?.length === 1 && items[0];
        if (!item || item.id !== record.nativeId || (this.extensionId && item.byExtensionId !== this.extensionId)) throw new Error("OBU_DOWNLOAD_NOT_FOUND: exact extension-created download is unavailable");
        if (!["safe", "deepScannedSafe"].includes(item.danger)) throw new Error("OBU_DOWNLOAD_DANGEROUS: browser safety checks have not marked the download safe");
        if (item.state === "interrupted") throw new Error(`OBU_DOWNLOAD_INTERRUPTED: ${String(item.error ?? "native download interrupted").slice(0, 256)}`);
        if (item.state === "complete") {
          if (item.exists === false) throw new Error("OBU_DOWNLOAD_NOT_FOUND: browser reports the completed file was removed");
          if (typeof item.filename !== "string" || /[\x00-\x1f\x7f]/.test(item.filename) || !/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(item.filename)) throw new Error("OBU_DOWNLOAD_PATH_UNAVAILABLE: completed download has no absolute recorded filename");
          return { path: item.filename };
        }
        if (item.state !== "in_progress") throw new Error("OBU_DOWNLOAD_FAILED: unknown native download state");
        await new Promise(resolve => setTimeout(resolve, Math.min(this.pollMs, Math.max(1, deadlineAt - this.now()))));
      }
    });
  }

  async cancel(params, deadlineAt = downloadDeadline(params, this.now())) {
    const record = this.lookup(params);
    return this.within(record, deadlineAt, async () => {
      await this.validate(record);
      if (this.now() >= deadlineAt) throw timeout();
      await this.cancelNative(record);
      await this.validate(record);
      // Keep identity until the response passes its final scope check. Retire
      // afterwards without waking this operation's own cancellation race.
      record.cancelled = true;
      return { cancelled: true };
    }).then(result => {
      this.check(record);
      this.records.delete(record.downloadId);
      for (const cancel of record.cancellationListeners) cancel();
      return result;
    });
  }

  cancelNative(record) {
    if (record.cancelled || record.nativeId === undefined) return Promise.resolve();
    if (record.cancelPromise) return record.cancelPromise;
    const pending = this.track(Promise.resolve().then(() => this.downloads.cancel(record.nativeId)).then(() => { record.cancelled = true; }));
    record.cancelPromise = pending;
    pending.finally(() => { if (record.cancelPromise === pending) record.cancelPromise = null; }).catch(() => {});
    return pending;
  }

  retire(record) {
    if (this.records.get(record.downloadId) !== record) return Promise.resolve();
    record.invalid = true;
    for (const cancel of record.cancellationListeners) cancel();
    if (record.cleanup) return record.cleanup;
    const cleanup = this.track((async () => {
      // Rejected start created no ID. A still-pending start stays in the drain.
      await record.startPromise?.catch(() => {});
      await this.cancelNative(record);
      if (this.records.get(record.downloadId) === record) this.records.delete(record.downloadId);
    })());
    record.cleanup = cleanup;
    cleanup.finally(() => { if (record.cleanup === cleanup) record.cleanup = null; }).catch(() => {});
    return cleanup;
  }

  invalidate(predicate) {
    const pending = [...this.records.values()].filter(predicate).map(record => this.retire(record));
    const cleanup = Promise.allSettled(pending).then(results => {
      const failed = results.find(result => result.status === "rejected");
      if (failed) throw new Error(`OBU_DOWNLOAD_CLEANUP_FAILED: ${String(failed.reason?.message ?? failed.reason)}`);
    });
    cleanup.catch(() => {});
    return cleanup;
  }
  invalidateTab(tabId, preserveRecord = null) { return this.invalidate(record => record.params.tabId === tabId && (record !== preserveRecord || !!record.scope)); }
  invalidateAttachedTab(tabId) { return this.invalidate(record => record.params.tabId === tabId && !!record.scope && !record.invalid); }
  invalidateSession(sessionId) { return this.invalidate(record => record.params.session_id === sessionId); }
  invalidateAll() { return this.invalidate(() => true); }
  controlSnapshot() { return { tabIds: [...new Set([...this.records.values()].map(record => record.params.tabId))], pending: [...this.operations] }; }
}
