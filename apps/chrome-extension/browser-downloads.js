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

function validateRequest(params, source) {
  const name = source ? "download source" : "downloadURL";
  if (!params || typeof params !== "object" || Array.isArray(params)) throw new Error(`${name} requires an object`);
  for (const key of Object.keys(params)) if (![...scopeKeys, "tabId", "filename", "timeoutMs", ...(source ? [] : ["url"])].includes(key)) throw new Error(`${name} does not support ${key}`);
  for (const key of ["session_id", "turn_id"]) if (typeof params[key] !== "string" || !params[key] || size(params[key]) > 4096) throw new Error(`${key} must be nonempty and at most 4096 UTF-8 bytes`);
  if (!Number.isSafeInteger(params.control_epoch) || params.control_epoch < 1) throw new Error("control_epoch must be a positive safe integer");
  if (!Number.isSafeInteger(params.tabId) || params.tabId < 0) throw new Error("tabId must be a nonnegative safe integer");
  if (!source) validateURL(params.url);
  const filename = params.filename;
  if (filename !== undefined && (typeof filename !== "string" || !filename || size(filename) > 255 || /[<>:"/\\|?*\x00-\x1f\x7f]/.test(filename) || /[. ]$/.test(filename) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(filename))) throw new Error("filename must be a safe single basename of at most 255 UTF-8 bytes");
  downloadDeadline(params);
  return Object.freeze({ ...params });
}

function validateURL(value) {
  if (typeof value !== "string" || !value || size(value) > 8192 || value.trim() !== value || /[\x00-\x20\x7f]/.test(value)) throw new Error("url must be an absolute HTTP(S) URL of at most 8192 UTF-8 bytes without whitespace or controls");
  let url; try { url = new URL(value); } catch { throw new Error("url must be an absolute HTTP(S) URL"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("url must use HTTP(S) without embedded credentials");
  return value;
}

export function validateDownloadURL(params) { return validateRequest(params, false); }
export function validateDownloadSource(params) { return validateRequest(params, true); }

export class BrowserDownloads {
  constructor({ downloads, extensionId, validateScope, assertScope = () => {}, now = () => Date.now(), pollMs = 100, maxRecords = 128 } = {}) {
    Object.assign(this, { downloads, extensionId, validateScope, assertScope, now, pollMs, maxRecords });
    this.records = new Map();
    this.operations = new Set();
  }

  reserve(request) {
    return this.reserveRecord(validateDownloadURL(request), false);
  }

  // Internal unresolved-source seam. Locator validation belongs to the engine;
  // no placeholder URL or caller-provided native node handle is accepted here.
  reserveSource(request) {
    return this.reserveRecord(validateDownloadSource(request), true);
  }

  reserveRecord(params, unresolvedSource) {
    if (this.records.size >= this.maxRecords) throw new Error("OBU_DOWNLOAD_LIMIT: direct download capacity reached");
    const record = { params, downloadId: crypto.randomUUID(), deadlineAt: downloadDeadline(params, this.now()), invalid: false, cancellationListeners: new Set(), unresolvedSource, pendingCount: 0, cleanupComplete: false, started: false };
    this.records.set(record.downloadId, record);
    return record;
  }

  has(id) { return this.records.has(id); }

  check(record) {
    if (record.invalid || this.records.get(record.downloadId) !== record) throw record.error ?? expired();
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

  track(record, promise) {
    record.pendingCount += 1;
    this.operations.add(promise);
    const settled = () => {
      this.operations.delete(promise);
      record.pendingCount -= 1;
      this.retireSettled(record);
    };
    promise.then(settled, settled);
    return promise;
  }

  retireSettled(record) {
    if (record.invalid && record.cleanupComplete && record.pendingCount === 0 && this.records.get(record.downloadId) === record)
      this.records.delete(record.downloadId);
  }

  checkStart(record) {
    this.check(record);
    if (this.now() >= record.deadlineAt) throw timeout();
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
        this.track(record, Promise.resolve().then(() => { this.check(record); if (deadlineAt <= this.now()) throw timeout(); return operation(); })),
        new Promise((_, reject) => { cancel = () => reject(record.error ?? expired()); record.cancellationListeners.add(cancel); }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(timeout()), remaining); })
      ]);
      this.check(record);
      if (deadlineAt <= this.now()) throw timeout();
      return value;
    } finally { clearTimeout(timer); record.cancellationListeners.delete(cancel); }
  }

  async start(record, scope) {
    this.beginStart(record, scope, false);
    return this.within(record, record.deadlineAt, () => this.startNative(record, record.params.url));
  }

  beginStart(record, scope, fromSource) {
    this.checkStart(record);
    if (record.started || record.unresolvedSource !== fromSource || !scope || scopeKeys.some(key => scope[key] !== record.params[key]) || scope.tabId !== record.params.tabId) throw expired();
    // Fence concurrent starts before any ownership inspection can await.
    record.started = true;
    record.scope = Object.freeze({ ...scope });
  }

  async startFromSource(record, scope, resolveSource) {
    if (typeof resolveSource !== "function") throw new Error("download source resolver must be a function");
    this.beginStart(record, scope, true);
    try {
      return await this.within(record, record.deadlineAt, async () => {
        await this.validate(record);
        this.checkStart(record);
        // This must be the resolver's ACTUAL Promise, including native work and
        // handle disposal, never its caller-facing timeout/cancellation race.
        record.sourcePromise = this.track(record, Promise.resolve().then(() => {
          this.checkStart(record);
          return resolveSource({ check: () => this.checkStart(record), deadlineAt: record.deadlineAt });
        }).catch(error => {
          // The trusted resolver distinguishes a source failure with successful
          // disposal from an unresolved exact handle cleanup failure.
          if (error?.mediaCleanupFailed === true) record.sourceCleanupError = error;
          throw error;
        }));
        const source = await record.sourcePromise;
        this.checkStart(record);
        if (!source || typeof source !== "object" || Array.isArray(source) || Object.keys(source).length !== 1 || !Object.hasOwn(source, "url")) throw new Error("OBU_DOWNLOAD_SOURCE_INVALID: resolver must return one URL snapshot");
        record.sourceURL = validateURL(source.url);
        // The immutable URL is an authorized source snapshot. It is not an
        // atomic transaction with subsequent DOM changes or the Chrome GET.
        return this.startNative(record, record.sourceURL);
      });
    } catch (error) {
      void this.retire(record, { error }).catch(() => {});
      throw error;
    }
  }

  async startNative(record, url) {
    await this.validate(record);
    this.checkStart(record);
    if (!this.downloads?.download) throw new Error("OBU_DOWNLOAD_UNAVAILABLE: native downloads API is unavailable");
    const options = { url, saveAs: false, conflictAction: "uniquify", ...(record.params.filename === undefined ? {} : { filename: record.params.filename }) };
    record.startPromise = this.track(record, Promise.resolve(this.downloads.download(options)).then(id => {
      if (!Number.isSafeInteger(id) || id < 0) throw new Error("OBU_DOWNLOAD_FAILED: invalid native download ID");
      record.nativeId = id;
      return id;
    }));
    await record.startPromise;
    await this.validate(record);
    this.checkStart(record);
    return { downloadId: record.downloadId };
  }

  async path(params, deadlineAt = downloadDeadline(params, this.now())) {
    const record = this.lookup(params);
    return this.within(record, deadlineAt, async () => {
      while (true) {
        await this.validate(record);
        if (this.now() >= deadlineAt) throw timeout();
        const items = await this.track(record, Promise.resolve(this.downloads.search({ id: record.nativeId })));
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
      record.invalid = true;
      record.cleanupComplete = true;
      for (const cancel of record.cancellationListeners) cancel();
      this.retireSettled(record);
      return result;
    });
  }

  cancelNative(record) {
    if (record.cancelled || record.nativeId === undefined) return Promise.resolve();
    if (record.cancelPromise) return record.cancelPromise;
    const pending = this.track(record, Promise.resolve().then(() => this.downloads.cancel(record.nativeId)).then(() => { record.cancelled = true; }));
    record.cancelPromise = pending;
    pending.finally(() => { if (record.cancelPromise === pending) record.cancelPromise = null; }).catch(() => {});
    return pending;
  }

  retire(record, { retrySourceCleanup = false, error } = {}) {
    if (this.records.get(record.downloadId) !== record) return Promise.resolve();
    // A nested source failure must reach the outer admission deadline race.
    // Once external cancellation wins, a late resolver error cannot replace it.
    if (!record.invalid && error !== undefined) record.error = error;
    record.invalid = true;
    for (const cancel of record.cancellationListeners) cancel();
    if (record.cleanup) return record.cleanup;
    const cleanup = this.track(record, (async () => {
      // Source resolution is bound work and includes exact native handle
      // disposal. Unbound admission is retained for capacity/controlSnapshot,
      // but not awaited here: it may itself be waiting for this detach barrier.
      await record.sourcePromise?.catch(() => {});
      if (record.sourceCleanupError) {
        const failure = record.sourceCleanupError;
        // Ordinary RPC rejection must not silently retry a failed native
        // disposal. Explicit lifecycle cleanup may retry that exact handle;
        // it must never repeat source resolution or start a new download.
        if (!retrySourceCleanup || typeof failure.retryMediaCleanup !== "function") throw failure;
        await this.track(record, Promise.resolve().then(() => failure.retryMediaCleanup()));
        if (record.sourceCleanupError === failure) record.sourceCleanupError = null;
      }
      // Rejected start created no ID. A still-pending start stays in the drain.
      await record.startPromise?.catch(() => {});
      await this.cancelNative(record);
      record.cleanupComplete = true;
      this.retireSettled(record);
    })());
    record.cleanup = cleanup;
    cleanup.finally(() => { if (record.cleanup === cleanup) record.cleanup = null; }).catch(() => {});
    return cleanup;
  }

  invalidate(predicate) {
    const pending = [...this.records.values()].filter(predicate).map(record => this.retire(record, { retrySourceCleanup: true }));
    const cleanup = Promise.allSettled(pending).then(results => {
      const failed = results.find(result => result.status === "rejected");
      if (failed) throw new Error(`OBU_DOWNLOAD_CLEANUP_FAILED: ${String(failed.reason?.message ?? failed.reason)}`);
    });
    cleanup.catch(() => {});
    return cleanup;
  }
  invalidateTab(tabId, preserveRecord = null) { return this.invalidate(record => record.params.tabId === tabId && (record !== preserveRecord || !!record.scope)); }
  invalidateAttachedTab(tabId) { return this.invalidate(record => record.params.tabId === tabId && !!record.scope); }
  invalidateSession(sessionId) { return this.invalidate(record => record.params.session_id === sessionId); }
  invalidateAll() { return this.invalidate(() => true); }
  controlSnapshot() { return { tabIds: [...new Set([...this.records.values()].map(record => record.params.tabId))], pending: [...this.operations] }; }
}
