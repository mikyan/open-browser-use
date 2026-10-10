// Record real Playwright Page events. No page scripts, remote argument expansion,
// response bodies, request headers, or process-wide event history are involved.
const encoder = new TextEncoder();
const MAX_ENTRIES = 500;
const MAX_BYTES = 1024 * 1024;

export class BrowserDiagnostics {
  constructor(page, { maxEntries = MAX_ENTRIES, maxBytes = MAX_BYTES } = {}) {
    this.captureId = crypto.randomUUID();
    this.startedAt = new Date().toISOString();
    this.sequence = 0;
    this.dropped = 0;
    this.bytes = 0;
    this.entries = [];
    this.requestIds = new WeakMap();
    this.nextRequestId = 0;
    this.listeners = [];
    this.disposed = false;
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
    for (const kind of ["console", "pageerror", "request", "response", "requestfinished", "requestfailed"]) {
      const listener = value => {
        if (this.disposed) return;
        try { this.record(kind, value); }
        catch { this.dropped++; } // A malformed event cannot fail an action.
        finally {
          // Page console subscriptions materialize JSHandles even when only
          // text is requested. Release them; the bounded log must not retain
          // arbitrarily many remote page objects through Playwright's channels.
          if (kind === "console") {
            try { for (const handle of value.args()) Promise.resolve(handle.dispose()).catch(() => {}); } catch {}
          }
        }
      };
      page.on(kind, listener);
      this.listeners.push(() => page.off(kind, listener));
    }
    const close = () => this.dispose();
    page.on("close", close);
    this.listeners.push(() => page.off("close", close));
  }

  requestId(request) {
    if (!this.requestIds.has(request)) this.requestIds.set(request, `request-${++this.nextRequestId}`);
    return this.requestIds.get(request);
  }

  record(kind, value) {
    const entry = { sequence: ++this.sequence, timestamp: new Date().toISOString(), kind };
    const text = (value, maxBytes = 8192) => {
      if (typeof value !== "string") return "";
      // encodeInto never splits a UTF-8 character and only allocates the budget.
      const { read } = encoder.encodeInto(value, new Uint8Array(maxBytes));
      if (read < value.length) entry.truncated = true;
      return value.slice(0, read);
    };
    if (kind === "console") {
      entry.type = text(value.type(), 128);
      entry.text = text(value.text());
      const location = value.location();
      entry.location = { url: text(location.url, 4096), lineNumber: location.lineNumber, columnNumber: location.columnNumber };
    } else if (kind === "pageerror") {
      entry.name = text(value.name, 128);
      entry.message = text(value.message);
      entry.stack = text(value.stack);
    } else {
      const request = kind === "response" ? value.request() : value;
      entry.requestId = this.requestId(request);
      entry.url = text(request.url(), 4096);
      entry.method = text(request.method(), 128);
      entry.resourceType = text(request.resourceType(), 128);
      try { entry.frameUrl = text(request.frame().url(), 4096); } catch {} // Service-worker requests have no frame.
      const redirectedFrom = request.redirectedFrom();
      if (redirectedFrom) entry.redirectedFrom = this.requestId(redirectedFrom);
      if (kind === "response") {
        entry.status = value.status();
        entry.statusText = text(value.statusText(), 1024);
      } else if (kind === "requestfailed") entry.failure = text(request.failure()?.errorText);
    }
    const bytes = encoder.encode(JSON.stringify(entry)).byteLength;
    this.entries.push({ entry, bytes });
    this.bytes += bytes;
    while (this.entries.length > this.maxEntries || this.bytes > this.maxBytes) {
      this.bytes -= this.entries.shift().bytes;
      this.dropped++;
    }
  }

  snapshot({ after, limit = 100 } = {}) {
    if (this.disposed || (after && after.captureId !== this.captureId)) throw new Error("OBU_DIAGNOSTICS_EXPIRED: capture was detached or replaced");
    if (after && after.sequence > this.sequence) throw new Error("Diagnostics cursor is ahead of this capture");
    const selected = this.entries.filter(({ entry }) => entry.sequence > (after?.sequence ?? 0)).slice(0, limit);
    const sequence = selected.at(-1)?.entry.sequence ?? this.sequence;
    return {
      captureId: this.captureId, startedAt: this.startedAt,
      entries: selected.map(({ entry }) => structuredClone(entry)),
      cursor: { captureId: this.captureId, sequence }, dropped: this.dropped
    };
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const remove of this.listeners.splice(0)) remove();
    this.entries = [];
    this.bytes = 0;
    this.requestIds = new WeakMap();
  }
}
