// The clipboard is shared by every tab and session. A caller timing out does
// not cancel a native read/write, so its reservation lasts until the real
// admission and adapter promises settle. No operation is automatically retried.
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_JSON_BYTES = 48 * 1024 * 1024;
const MAX_PIXELS = 16 * 1024 * 1024;
const encoder = new TextEncoder();
const scopeKeys = ["session_id", "turn_id", "control_epoch", "tabId"];
const methods = ["readClipboardText", "writeClipboardText", "readClipboard", "writeClipboard"];
const invalid = () => new Error("OBU_CLIPBOARD_INVALID: unsupported clipboard request or data");
const limit = () => new Error("OBU_CLIPBOARD_LIMIT: clipboard data exceeds the permitted size");
const malformed = () => new Error("OBU_CLIPBOARD_FAILED: native clipboard returned invalid data");
const timeout = () => new Error("OBU_CLIPBOARD_TIMEOUT: clipboard operation deadline expired");
const cancelled = () => new Error("OBU_CLIPBOARD_CANCELLED: clipboard control ended");

function keys(value, allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!allowed.includes(key) || !descriptor.enumerable || !("value" in descriptor)) throw invalid();
  }
}

function denseArray(value, maximum) {
  if (!Array.isArray(value) || value.length > maximum || Reflect.ownKeys(value).length !== value.length + 1) throw invalid();
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) throw invalid();
  }
}

function textBytes(value, remaining) {
  if (typeof value !== "string") throw invalid();
  if (value.length > remaining) throw limit();
  // TextEncoder replaces lone surrogates. Reject them instead of silently
  // writing different text or accepting a falsely measured wire payload.
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw invalid();
    } else if (unit >= 0xdc00 && unit <= 0xdfff) throw invalid();
  }
  const length = encoder.encode(value).length;
  if (length > remaining) throw limit();
  return length;
}

function pngBytes(value, remaining) {
  if (typeof value !== "string") throw invalid();
  if (value.length > 4 * Math.ceil(remaining / 3)) throw limit();
  if (value.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw invalid();
  let binary;
  try { binary = atob(value); } catch { throw invalid(); }
  if (btoa(binary) !== value) throw invalid();
  if (binary.length > remaining) throw limit();
  if (binary.length < 33 || binary.slice(0, 8) !== "\x89PNG\r\n\x1a\n" || binary.slice(12, 16) !== "IHDR") throw invalid();
  const uint32 = offset => ((binary.charCodeAt(offset) * 0x1000000) + (binary.charCodeAt(offset + 1) << 16) + (binary.charCodeAt(offset + 2) << 8) + binary.charCodeAt(offset + 3));
  if (uint32(8) !== 13) throw invalid();
  const width = uint32(16), height = uint32(20);
  if (!width || !height) throw invalid();
  if (width > MAX_PIXELS / height) throw limit();
  const depth = binary.charCodeAt(24), color = binary.charCodeAt(25);
  const depths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
  if (!depths[color]?.includes(depth) || binary.charCodeAt(26) !== 0 || binary.charCodeAt(27) !== 0 || binary.charCodeAt(28) > 1) throw invalid();
  // This is only a bounded header preflight. The trusted adapter must decode
  // the complete PNG before a write; a header is not evidence of a valid image.
  return binary.length;
}

function clipboardItems(value, maxBytes) {
  denseArray(value, 1);
  let bytes = 0;
  return Object.freeze(value.map(item => {
    keys(item, ["entries", "presentation_style"]);
    if (!Object.hasOwn(item, "entries")) throw invalid();
    denseArray(item.entries, 3);
    if (!item.entries.length) throw invalid();
    const style = Object.hasOwn(item, "presentation_style") ? item.presentation_style : "unspecified";
    if (!["unspecified", "inline", "attachment"].includes(style)) throw invalid();
    const types = new Set();
    const entries = item.entries.map(entry => {
      keys(entry, ["mime_type", "text", "base64"]);
      if (!Object.hasOwn(entry, "mime_type") || types.has(entry.mime_type)) throw invalid();
      types.add(entry.mime_type);
      if (["text/plain", "text/html"].includes(entry.mime_type)) {
        if (!Object.hasOwn(entry, "text") || Object.hasOwn(entry, "base64")) throw invalid();
        bytes += textBytes(entry.text, maxBytes - bytes);
        return Object.freeze({ mime_type: entry.mime_type, text: entry.text });
      }
      if (entry.mime_type !== "image/png" || !Object.hasOwn(entry, "base64") || Object.hasOwn(entry, "text")) throw invalid();
      bytes += pngBytes(entry.base64, maxBytes - bytes);
      return Object.freeze({ mime_type: entry.mime_type, base64: entry.base64 });
    });
    return Object.freeze({ entries: Object.freeze(entries), presentation_style: style });
  }));
}

function byteLimit(value) {
  if (!Number.isInteger(value) || value < 1 || value > MAX_BYTES) throw invalid();
  return value;
}

function boundedWire(value) {
  // JSON escaping can turn 16 MiB of text into 96 MiB. Validate the actual
  // normalized JSON before a Port/native-host envelope is added. The remaining
  // 16 MiB of transport space is for that metadata, not additional content.
  // This bounds the wire value; JSON serialization and native clipboard APIs
  // can still allocate temporary memory before this check finishes.
  const json = JSON.stringify(value);
  if (json.length > MAX_JSON_BYTES) throw limit();
  let bytes = encoder.encode(json).length;
  if (bytes > MAX_JSON_BYTES) throw limit();
  // The Go relay rewrites RPC IDs with encoding/json's default HTML escaping.
  // Measure that real second encoding too: its extra escapes are not bounded
  // by the envelope allowance and must not disconnect the receiving client.
  for (let index = 0; index < json.length; index++) {
    const unit = json.charCodeAt(index);
    if (unit === 0x3c || unit === 0x3e || unit === 0x26) bytes += 5;
    else if (unit === 0x2028 || unit === 0x2029) bytes += 3;
    if (bytes > MAX_JSON_BYTES) throw limit();
  }
  return Object.freeze(value);
}

export function validateClipboardRequest(method, request) {
  if (!methods.includes(method)) throw invalid();
  const payload = method === "writeClipboardText" ? ["text"] : method === "writeClipboard" ? ["items"] : [];
  keys(request, [...scopeKeys, "timeoutMs", "maxBytes", ...payload]);
  for (const key of ["session_id", "turn_id"]) {
    if (!Object.hasOwn(request, key) || !request[key]) throw invalid();
    textBytes(request[key], 4096);
  }
  if (!Object.hasOwn(request, "control_epoch") || !Number.isSafeInteger(request.control_epoch) || request.control_epoch < 1 ||
      !Object.hasOwn(request, "tabId") || !Number.isSafeInteger(request.tabId) || request.tabId < 0) throw invalid();
  const timeoutMs = request.timeoutMs === undefined ? 10000 : request.timeoutMs;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw invalid();
  const maxBytes = byteLimit(request.maxBytes === undefined ? MAX_BYTES : request.maxBytes);
  const result = Object.fromEntries(scopeKeys.map(key => [key, request[key]]));
  Object.assign(result, { timeoutMs, maxBytes });
  if (method === "writeClipboardText") {
    if (!Object.hasOwn(request, "text")) throw invalid();
    textBytes(request.text, maxBytes);
    result.text = request.text;
  } else if (method === "writeClipboard") {
    if (!Object.hasOwn(request, "items")) throw invalid();
    result.items = clipboardItems(request.items, maxBytes);
  }
  return boundedWire(result);
}

export function validateClipboardResult(method, result, maxBytes = MAX_BYTES) {
  try {
    byteLimit(maxBytes);
    if (method === "readClipboardText") {
      keys(result, ["text"]);
      if (!Object.hasOwn(result, "text")) throw invalid();
      textBytes(result.text, maxBytes);
      return boundedWire({ text: result.text });
    }
    if (method === "readClipboard") {
      keys(result, ["items"]);
      if (!Object.hasOwn(result, "items")) throw invalid();
      return boundedWire({ items: clipboardItems(result.items, maxBytes) });
    }
    if (!["writeClipboardText", "writeClipboard"].includes(method)) throw invalid();
    keys(result, []);
    return boundedWire({});
  } catch (error) {
    if (error?.message?.startsWith("OBU_CLIPBOARD_LIMIT:")) throw error;
    throw malformed();
  }
}

export class BrowserClipboard {
  constructor({ execute, validateScope, assertScope, now = () => Date.now() } = {}) {
    if (![execute, validateScope, assertScope, now].every(value => typeof value === "function")) throw new TypeError("BrowserClipboard requires trusted adapter and scope hooks");
    Object.assign(this, { execute, validateScope, assertScope, now });
    this.records = new Set();
    this.operations = new Map();
  }

  reserve(method, request) {
    const submittedAt = this.now();
    const params = validateClipboardRequest(method, request);
    if (this.records.size) throw new Error("OBU_CLIPBOARD_BUSY: another clipboard operation is still pending");
    const deadlineAt = submittedAt + params.timeoutMs;
    if (this.now() >= deadlineAt) throw timeout();
    const record = { method, params, deadlineAt, invalid: false, listeners: new Set(), started: false, pendingCount: 0, withinDepth: 0 };
    this.records.add(record);
    return record;
  }

  check(record) {
    if (!this.records.has(record) || record.invalid) throw record.error ?? cancelled();
    if (this.now() >= record.deadlineAt) throw timeout();
    if (record.scope) this.assertScope(record.scope);
  }

  track(record, promise) {
    record.pendingCount++;
    this.operations.set(promise, record.params.tabId);
    const settled = () => {
      this.operations.delete(promise);
      record.pendingCount--;
      this.retireSettled(record);
    };
    promise.then(settled, settled);
    return promise;
  }

  retireSettled(record) {
    if (!record.pendingCount && (record.invalid || (record.completed && !record.withinDepth))) this.records.delete(record);
  }

  async within(record, operation) {
    let timer, rejectCancelled;
    record.withinDepth++;
    try {
      this.check(record);
      const result = await Promise.race([
        this.track(record, Promise.resolve().then(() => { this.check(record); return operation(); })),
        new Promise((_, reject) => { rejectCancelled = () => reject(record.error ?? cancelled()); record.listeners.add(rejectCancelled); }),
        new Promise((_, reject) => { timer = setTimeout(() => {
          const error = timeout();
          void this.cancel(record, error);
          reject(error);
        }, Math.max(1, record.deadlineAt - this.now())); })
      ]);
      this.check(record);
      return result;
    } catch (error) {
      // Do not await cancellation here: the admission promise may itself be
      // this run's caller. Actual work remains visible in controlSnapshot.
      void this.cancel(record, error);
      throw error;
    } finally {
      clearTimeout(timer);
      record.listeners.delete(rejectCancelled);
      record.withinDepth--;
      this.retireSettled(record);
    }
  }

  async validate(record) {
    this.check(record);
    await this.validateScope(record.scope);
    this.check(record);
  }

  async produce(record) {
    await this.validate(record);
    let result;
    if (record.method === "writeClipboard" && record.params.items.length === 0) {
      // Native write([]) is a no-op, not "clear the clipboard".
      result = {};
    } else {
      this.check(record);
      result = await this.execute(record.scope, record.method, record.params, {
        deadlineAt: record.deadlineAt,
        // An adapter must call this after decoding/preparation and directly
        // before native dispatch. Cancellation cannot undo a completed write.
        check: () => this.check(record)
      });
    }
    this.check(record);
    const normalized = validateClipboardResult(record.method, result, record.params.maxBytes);
    this.check(record);
    await this.validate(record);
    this.check(record);
    return normalized;
  }

  async run(record, scope) {
    try {
      this.check(record);
      if (record.started || !scope || scopeKeys.some(key => scope[key] !== record.params[key])) throw cancelled();
      record.started = true;
      record.scope = Object.freeze({ ...scope });
      record.flow = this.track(record, Promise.resolve().then(() => this.produce(record)));
      const result = await this.within(record, () => record.flow);
      this.check(record);
      record.completed = true;
      this.retireSettled(record);
      return result;
    } catch (error) {
      void this.cancel(record, error);
      throw error;
    }
  }

  cancel(record, error = cancelled()) {
    if (!this.records.has(record)) return Promise.resolve();
    record.invalid = true;
    record.error ??= error;
    for (const reject of record.listeners) reject();
    // Waiting for actual produce/adapter completion is safe. Waiting for an
    // unbound admission here can deadlock its own old-attachment cleanup.
    const cleanup = record.flow ? record.flow.then(() => {}, () => {}) : Promise.resolve();
    this.retireSettled(record);
    return cleanup;
  }

  invalidate(predicate, error) {
    return Promise.all([...this.records].filter(predicate).map(record => this.cancel(record, error))).then(() => {});
  }
  invalidateTab(tabId, preserveRecord = null) { return this.invalidate(record => record.params.tabId === tabId && (record !== preserveRecord || !!record.scope)); }
  invalidateAttachedTab(tabId, error) { return this.invalidate(record => record.params.tabId === tabId && !!record.scope, error); }
  invalidateAttachment(tabId, attachment, error) { return this.invalidate(record => record.params.tabId === tabId && !!record.scope && record.scope.attachment === attachment, error); }
  invalidateSession(sessionId, error) { return this.invalidate(record => record.params.session_id === sessionId, error); }
  invalidateAll(error) { return this.invalidate(() => true, error); }
  controlSnapshot() { return { tabIds: new Set([...this.records].map(record => record.params.tabId).concat([...this.operations.values()])), pending: [...this.operations.keys()] }; }
}
