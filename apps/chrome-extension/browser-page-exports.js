// Native page exports never expose a CDP stream handle. A rejected RPC is not
// evidence that a native print/read/close has settled: those promises stay in
// the control snapshot until their actual completion.
const MAX_BYTES = 16 * 1024 * 1024;
const READ_BYTES = 64 * 1024;
const encoder = new TextEncoder();
const scopeKeys = ["session_id", "turn_id", "control_epoch", "tabId"];
const timeout = () => new Error("OBU_EXPORT_TIMEOUT: page export deadline expired");
const cancelled = () => new Error("OBU_EXPORT_CANCELLED: page export control ended");
const limit = () => new Error("OBU_EXPORT_LIMIT: page export exceeds the byte limit");
const malformed = () => new Error("OBU_EXPORT_FAILED: native page export returned invalid data");
const cleanupFailed = () => new Error("OBU_EXPORT_CLEANUP_FAILED: native page export stream could not be closed");

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
}
function keys(value, allowed, label) {
  object(value, label);
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error(`${label} contains unsupported options`);
}

export function validatePageExport(request) {
  keys(request, [...scopeKeys, "format", "maxBytes", "timeoutMs", "pdf"], "exportPage");
  for (const key of ["session_id", "turn_id"])
    if (typeof request[key] !== "string" || !request[key] || encoder.encode(request[key]).length > 4096)
      throw new Error(`${key} must be nonempty and at most 4096 UTF-8 bytes`);
  if (!Number.isSafeInteger(request.control_epoch) || request.control_epoch < 1) throw new Error("control_epoch must be a positive safe integer");
  if (!Number.isSafeInteger(request.tabId) || request.tabId < 0) throw new Error("tabId must be a nonnegative safe integer");
  if (!["pdf", "mhtml"].includes(request.format)) throw new Error("format must be pdf or mhtml");
  const timeoutMs = request.timeoutMs === undefined ? 10000 : request.timeoutMs;
  const maxBytes = request.maxBytes === undefined ? MAX_BYTES : request.maxBytes;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw new Error("timeoutMs must be an integer from 1 to 120000");
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BYTES) throw new Error("maxBytes must be an integer from 1 to 16777216");
  let pdf;
  if (Object.hasOwn(request, "pdf")) {
    if (request.format !== "pdf") throw new Error("pdf options require pdf format");
    const bools = ["landscape", "printBackground", "preferCSSPageSize", "generateTaggedPDF", "generateDocumentOutline"];
    const paper = ["paperWidth", "paperHeight"], margins = ["marginTop", "marginBottom", "marginLeft", "marginRight"];
    keys(request.pdf, [...bools, ...paper, ...margins, "scale", "pageRanges"], "pdf");
    for (const key of bools) if (Object.hasOwn(request.pdf, key) && typeof request.pdf[key] !== "boolean") throw new Error(`pdf.${key} must be a boolean`);
    for (const key of [...paper, ...margins]) if (Object.hasOwn(request.pdf, key)) {
      const value = request.pdf[key];
      if (!Number.isFinite(value) || value > 200 || (paper.includes(key) ? value <= 0 : value < 0)) throw new Error(`pdf.${key} is outside the supported inch range`);
    }
    if (Object.hasOwn(request.pdf, "scale") && (!Number.isFinite(request.pdf.scale) || request.pdf.scale < 0.1 || request.pdf.scale > 2)) throw new Error("pdf.scale must be between 0.1 and 2");
    if (Object.hasOwn(request.pdf, "pageRanges") && (typeof request.pdf.pageRanges !== "string" || request.pdf.pageRanges.length > 1024 || /[^0-9, -]/.test(request.pdf.pageRanges))) throw new Error("pdf.pageRanges must contain at most 1024 digits, commas, hyphens and spaces");
    pdf = Object.freeze({ ...request.pdf });
  }
  return Object.freeze({ ...request, timeoutMs, maxBytes, ...(pdf === undefined ? {} : { pdf }) });
}

function decodeChunk(result, remaining) {
  if (!result || typeof result !== "object" || typeof result.data !== "string" || typeof result.eof !== "boolean" ||
      (result.base64Encoded !== undefined && typeof result.base64Encoded !== "boolean")) throw malformed();
  if (!result.base64Encoded) {
    // Check a cheap lower bound before allocating UTF-8 bytes.
    if (result.data.length > remaining) throw limit();
    const bytes = encoder.encode(result.data);
    if (bytes.length > remaining) throw limit();
    return bytes;
  }
  const data = result.data;
  if (data.length > 4 * Math.ceil(remaining / 3)) throw limit();
  if (data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw malformed();
  const binary = atob(data);
  if (btoa(binary) !== data) throw malformed();
  if (binary.length > remaining) throw limit();
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

function encodeBytes(bytes) {
  // Each piece except the last is divisible by 3. Concatenating arbitrary
  // base64 CDP chunks would introduce padding in the middle of the result.
  const encoded = [];
  for (let i = 0; i < bytes.length; i += 49152)
    encoded.push(btoa(String.fromCharCode(...bytes.subarray(i, i + 49152))));
  return { data: encoded.join(""), byteLength: bytes.length };
}

export class BrowserPageExports {
  constructor({ send, validateScope, assertScope, now = () => Date.now() } = {}) {
    Object.assign(this, { send, validateScope, assertScope, now });
    this.records = new Set();
    this.operations = new Map();
  }

  reserve(request) {
    const params = validatePageExport(request);
    if (this.records.size >= 4) throw new Error("OBU_EXPORT_LIMIT: page export capacity reached");
    if ([...this.records].some(record => record.params.tabId === params.tabId)) throw new Error("OBU_EXPORT_BUSY: this tab already has a page export or pending cleanup");
    const record = { params, deadlineAt: this.now() + params.timeoutMs, invalid: false, listeners: new Set(), started: false, flowSettled: false, stream: null, closeFailure: false, withinDepth: 0, pendingCount: 0, cleanupComplete: false };
    this.records.add(record);
    return record;
  }

  check(record) {
    if (!this.records.has(record) || record.invalid) throw record.error ?? cancelled();
    if (this.now() >= record.deadlineAt) throw timeout();
    if (record.scope) this.assertScope(record.scope);
  }

  track(record, promise) {
    record.pendingCount += 1;
    this.operations.set(promise, record.params.tabId);
    const settled = () => {
      this.operations.delete(promise);
      record.pendingCount -= 1;
      this.retireSettled(record);
    };
    promise.then(settled, settled);
    return promise;
  }

  retireSettled(record) {
    // Retaining an invalid reservation is also a capacity fence: callers may
    // time out, but cannot create unlimited unresolved native/admission work.
    if (record.pendingCount) return;
    if ((record.invalid && record.cleanupComplete) || (record.completed && !record.withinDepth)) this.records.delete(record);
  }

  async within(record, operation) {
    this.check(record);
    record.withinDepth += 1;
    let timer, rejectCancelled;
    try {
      const result = await Promise.race([
        this.track(record, Promise.resolve().then(() => { this.check(record); return operation(); })),
        new Promise((_, reject) => { rejectCancelled = () => reject(record.error ?? cancelled()); record.listeners.add(rejectCancelled); }),
        new Promise((_, reject) => { timer = setTimeout(() => {
          const error = timeout();
          void this.cancel(record, error, false).catch(() => {});
          reject(error);
        }, Math.max(1, record.deadlineAt - this.now())); })
      ]);
      this.check(record);
      return result;
    } finally {
      clearTimeout(timer);
      record.listeners.delete(rejectCancelled);
      record.withinDepth -= 1;
      this.retireSettled(record);
    }
  }

  async validate(record) {
    this.check(record);
    await this.validateScope(record.scope);
    this.check(record);
  }

  native(record, method, args, cleanup = false) {
    if (!cleanup) this.check(record);
    return this.track(record, Promise.resolve().then(() => {
      if (!cleanup) this.check(record);
      // A send adapter may await live ownership/site inspection. It must call
      // check again immediately before its actual native dispatch.
      return this.send(record.scope, method, args, cleanup ? { cleanup: true } : { check: () => this.check(record) });
    }));
  }

  closeStream(record) {
    if (record.stream === null) return Promise.resolve();
    if (record.closing) return record.closing;
    const handle = record.stream;
    const closing = this.native(record, "IO.close", { handle }, true).then(() => {
      if (record.stream === handle) record.stream = null;
      record.closeFailure = false;
    }, () => { record.closeFailure = true; throw cleanupFailed(); });
    record.closing = closing;
    closing.finally(() => { if (record.closing === closing) record.closing = null; }).catch(() => {});
    return closing;
  }

  async produce(record) {
    let buffer = new Uint8Array(0), length = 0;
    try {
      await this.validate(record);
      if (record.params.format === "pdf") {
        const result = await this.native(record, "Page.printToPDF", { ...record.params.pdf, transferMode: "ReturnAsStream" });
        // Capture a late stream before checking cancellation so it is always
        // closed, even when the caller has already received a timeout.
        if (typeof result?.stream !== "string" || !result.stream) throw malformed();
        record.stream = result.stream;
        this.check(record);
        let emptyReads = 0;
        while (true) {
          await this.validate(record);
          const result = await this.native(record, "IO.read", { handle: record.stream, size: READ_BYTES });
          this.check(record);
          const bytes = decodeChunk(result, record.params.maxBytes - length);
          if (length + bytes.length > buffer.length) {
            const expanded = new Uint8Array(Math.min(record.params.maxBytes, Math.max(READ_BYTES, buffer.length * 2, length + bytes.length)));
            expanded.set(buffer.subarray(0, length));
            buffer = expanded;
          }
          buffer.set(bytes, length);
          length += bytes.length;
          if (result.eof) break;
          // No spin if a malformed/stalled native stream repeatedly reports
          // no progress. A real empty EOF chunk is allowed.
          if (!bytes.length && ++emptyReads > 4) throw malformed();
          if (bytes.length) emptyReads = 0;
        }
      } else {
        const result = await this.native(record, "Page.captureSnapshot", { format: "mhtml" });
        this.check(record);
        if (typeof result?.data !== "string") throw malformed();
        if (result.data.length > record.params.maxBytes) throw limit();
        const bytes = encoder.encode(result.data);
        if (bytes.length > record.params.maxBytes) throw limit();
        buffer = bytes;
        length = bytes.length;
      }
    } finally {
      await this.closeStream(record);
    }
    await this.validate(record);
    const encoded = encodeBytes(buffer.subarray(0, length));
    if (!encoded.byteLength) throw malformed();
    this.check(record);
    return { format: record.params.format, mimeType: record.params.format === "pdf" ? "application/pdf" : "multipart/related", encoding: "base64", ...encoded };
  }

  async run(record, scope) {
    this.check(record);
    if (record.started || !scope || scopeKeys.some(key => scope[key] !== record.params[key])) throw cancelled();
    record.started = true;
    record.scope = Object.freeze({ ...scope });
    record.flow = this.track(record, Promise.resolve().then(() => this.produce(record)));
    record.flow.then(() => { record.flowSettled = true; }, () => { record.flowSettled = true; });
    try {
      const result = await this.within(record, () => record.flow);
      this.check(record);
      record.completed = true;
      this.retireSettled(record);
      return result;
    } catch (error) {
      // The rejection is timely; cleanup continues to retain the actual flow.
      void this.cancel(record, error, false).catch(() => {});
      throw error;
    }
  }

  cancel(record, error = cancelled(), retryCleanup = true) {
    if (!this.records.has(record)) return Promise.resolve();
    record.invalid = true;
    record.error ??= error;
    for (const reject of record.listeners) reject();
    if (record.cleanup) return record.cleanup;
    record.cleanupComplete = false;
    // An explicit retry after a failed close is the only path that retries it.
    const retryClose = retryCleanup && record.flowSettled && record.closeFailure;
    const cleanup = this.track(record, (async () => {
      await record.flow?.catch(() => {});
      if (retryClose) await this.closeStream(record);
      if (record.closeFailure || record.stream !== null) throw cleanupFailed();
      record.cleanupComplete = true;
    })());
    record.cleanup = cleanup;
    cleanup.finally(() => { if (record.cleanup === cleanup) record.cleanup = null; }).catch(() => {});
    return cleanup;
  }

  invalidate(predicate, error) {
    const cleanup = Promise.allSettled([...this.records].filter(predicate).map(record => this.cancel(record, error))).then(results => {
      const failed = results.find(result => result.status === "rejected");
      if (failed) throw failed.reason;
    });
    cleanup.catch(() => {});
    return cleanup;
  }
  invalidateTab(tabId, preserveRecord = null) { return this.invalidate(record => record.params.tabId === tabId && (record !== preserveRecord || !!record.scope)); }
  invalidateAttachedTab(tabId, error) { return this.invalidate(record => record.params.tabId === tabId && !!record.scope, error); }
  invalidateAttachment(tabId, attachment, error) { return this.invalidate(record => record.params.tabId === tabId && !!record.scope && record.scope.attachment === attachment, error); }
  invalidateSession(sessionId, error) { return this.invalidate(record => record.params.session_id === sessionId, error); }
  invalidateAll(error) { return this.invalidate(() => true, error); }
  controlSnapshot() { return { tabIds: [...new Set([...this.records].map(record => record.params.tabId).concat([...this.operations.values()]))], pending: [...this.operations.keys()] }; }
}
