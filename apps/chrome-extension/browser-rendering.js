const MAX_FRAME_BYTES = 4 * 1024 * 1024;
const MAX_FRAME_CHARS = 4 * Math.ceil(MAX_FRAME_BYTES / 3);
const MAX_NATIVE_ACKS = 4;
const metadataKeys = ["offsetTop", "pageScaleFactor", "deviceWidth", "deviceHeight", "scrollOffsetX", "scrollOffsetY", "timestamp"];

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  promise.catch(() => {});
  return { promise, resolve, reject };
}

// A managed viewer borrows the backend's existing rendering queue and native
// attachment. It never attaches a debugger or holds that queue for its lifetime.
// Rendered actions borrow this same stream; a raw caller-owned stream always wins.
export class BrowserRendering {
  constructor({ streams, drains, queue, send, addListener, removeListener, isCurrent, isExternal }) {
    Object.assign(this, { streams, drains, queue, send, addListener, removeListener, isCurrent, isExternal });
    this.records = new Map();
    this.startupTimeoutMs = 5000;
  }

  track(operation) {
    const actual = Promise.resolve().then(operation);
    this.drains.add(actual);
    const settled = () => this.drains.delete(actual);
    actual.then(settled, settled);
    return actual;
  }

  async subscribe(tabId, attachment, check, onFrame) {
    if (typeof onFrame !== "function") throw new Error("OBU_VIEWER_INVALID: a frame receiver is required");
    check();
    if (this.records.has(tabId)) throw new Error("OBU_VIEWER_BUSY: the original viewer must finish closing first");
    if (this.records.size >= 16) throw new Error("OBU_VIEWER_LIMIT: too many active viewer streams");
    if (this.isExternal(tabId)) throw new Error("OBU_VIEWER_UNAVAILABLE: the tab has a caller-owned screencast");
    const ready = deferred(), closed = deferred();
    const record = { tabId, attachment, check, onFrame, ready, closed,
      streamId: crypto.randomUUID(), sequence: 0, published: 0, publishing: true,
      active: false, started: false, frameIds: [], acks: new Set(), borrowers: new Set() };
    this.records.set(tabId, record);
    record.cancel = () => this.revoke(record, new Error("Rendered action was cancelled because tab control ended"), true);
    record.listener = (source, method, params) => this.frame(record, source, method, params);
    const timer = setTimeout(() => {
      this.revoke(record, new Error("OBU_VIEWER_TIMEOUT: no committed browser frame arrived"));
      void this.close(record).catch(() => {});
    }, this.startupTimeoutMs);
    const startup = this.queue(tabId, async () => {
      this.check(record);
      if (this.isExternal(tabId)) throw new Error("OBU_VIEWER_UNAVAILABLE: the tab has a caller-owned screencast");
      this.streams.set(tabId, record);
      this.addListener(record.listener);
      record.listening = true;
      await this.track(() => this.send({ tabId }, "Page.enable"));
      this.check(record);
      record.active = true;
      await this.track(() => this.send({ tabId }, "Page.startScreencast", { format: "png", everyNthFrame: 1 }));
      record.started = true;
      this.check(record);
      await ready.promise;
      this.check(record);
    });
    try {
      await startup;
      return Object.freeze({ close: () => this.close(record, { retryFailed: true }), closed: closed.promise });
    } catch (error) {
      this.revoke(record, error);
      // A timeout revokes delivery, but is not evidence that a native command
      // completed. Keep this subscription pending through its actual cleanup.
      try { await this.close(record); }
      catch (cleanupError) {
        throw Object.assign(new Error(`OBU_VIEWER_CLEANUP_INCOMPLETE: ${String(cleanupError?.message ?? cleanupError)}`), { viewerCleanupIncomplete: true });
      }
      throw error;
    } finally { clearTimeout(timer); }
  }

  check(record) {
    if (record.error) throw record.error;
    this.checkAttachment(record);
  }

  checkAttachment(record) {
    if (!this.isCurrent(record.tabId, record.attachment)) throw new Error("OBU_VIEWER_UNAVAILABLE: original browser attachment ended");
    record.check();
  }

  frame(record, source, method, params) {
    if (source.tabId !== record.tabId || source.sessionId != null || method !== "Page.screencastFrame" || !record.active) return;
    try { this.check(record); }
    catch (error) { this.revoke(record, error, true); void this.close(record).catch(() => {}); return; }
    if (record.acks.size >= MAX_NATIVE_ACKS || record.sequence >= Number.MAX_SAFE_INTEGER) {
      this.revoke(record, new Error("OBU_VIEWER_UNAVAILABLE: native frame delivery exceeded its bounded capacity"), true);
      void this.close(record).catch(() => {});
      return;
    }
    // sessionId identifies the native screencast, not an individual frame.
    // Every event receives exactly one ACK; duplicate sessionIds are expected.
    const sequence = ++record.sequence;
    const sessionId = params.sessionId;
    const data = typeof params.data === "string" && params.data.length <= MAX_FRAME_CHARS &&
      params.data.length / 4 * 3 - (params.data.endsWith("==") ? 2 : params.data.endsWith("=") ? 1 : 0) <= MAX_FRAME_BYTES ? params.data : undefined;
    const metadata = {};
    for (const key of metadataKeys) if (Number.isFinite(params.metadata?.[key])) metadata[key] = params.metadata[key];
    const ack = this.track(() => {
      // Revoking only the viewer's publication does not cancel this native
      // receipt. Authority and attachment checks still apply to the real send.
      this.checkAttachment(record);
      return this.send({ tabId: record.tabId }, "Page.screencastFrameAck", { sessionId });
    });
    record.acks.add(ack);
    ack.then(() => {
      record.acks.delete(ack);
      if (record.error) return;
      try { this.check(record); }
      catch (error) { this.revoke(record, error, true); void this.close(record).catch(() => {}); return; }
      record.ready.resolve();
      if (!record.publishing || sequence <= record.published) return;
      record.published = sequence;
      try { record.onFrame(Object.freeze({ tabId: record.tabId, streamId: record.streamId, sequence, mimeType: "image/png", data, metadata: Object.freeze(metadata) })); }
      catch (error) { this.revoke(record, error); void this.close(record).catch(() => {}); }
    }, error => {
      record.acks.delete(ack);
      this.revoke(record, error, true);
      void this.close(record).catch(() => {});
    });
    if (data === undefined) {
      const error = new Error(typeof params.data === "string"
        ? "OBU_VIEWER_FRAME_TOO_LARGE: browser frame exceeds the 4 MiB viewer limit"
        : "OBU_VIEWER_INVALID_FRAME: browser frame data is not a string");
      // An unavailable preview must be visible to its consumer. Keep already
      // borrowed business actions alive and join their queue before real stop.
      this.revoke(record, error);
      void this.close(record).catch(() => {});
    }
  }

  borrow(tabId, attachment, onCancel) {
    const record = this.records.get(tabId);
    if (!record || record.attachment !== attachment || this.streams.get(tabId) !== record) return null;
    this.check(record);
    record.borrowers.add(onCancel);
    return { ready: record.ready.promise, release: () => record.borrowers.delete(onCancel) };
  }

  revoke(record, error, cancelBorrowers = false) {
    record.publishing = false;
    record.onFrame = null;
    record.closed.resolve({ reason: String(error?.message ?? "Viewer closed") });
    if (!record.error) record.error = error;
    record.ready.reject(error);
    if (cancelBorrowers) for (const cancel of record.borrowers) cancel(error);
    if (record.listening) { this.removeListener(record.listener); record.listening = false; }
  }

  close(record, { retryFailed = false } = {}) {
    this.revoke(record, record.error ?? new Error("OBU_VIEWER_CLOSED: viewer subscription closed"));
    if (!record.closing || (record.closeFailed && retryFailed)) {
      record.closeFailed = false;
      record.closing = this.queue(record.tabId, () => this.stop(record));
      record.closing.catch(() => { record.closeFailed = true; });
    }
    return record.closing;
  }

  async stop(record) {
    if (record.stopping) return record.stopping;
    record.stopping = (async () => {
      await Promise.allSettled([...record.acks]);
      // Only the exact original attachment can receive a late native stop.
      if (record.started && this.isCurrent(record.tabId, record.attachment)) {
        await this.track(() => {
          if (this.isCurrent(record.tabId, record.attachment)) return this.send({ tabId: record.tabId }, "Page.stopScreencast");
        });
      }
      record.active = false;
      if (this.records.get(record.tabId) === record) this.records.delete(record.tabId);
      // Retain the small frame-session tombstone for the existing event filter.
      if (this.streams.get(record.tabId) === record) delete record.cancel;
    })();
    try { return await record.stopping; }
    catch (error) { record.stopping = null; throw error; }
  }

  cancel(tabId, attachment) {
    const record = this.records.get(tabId);
    if (!record || record.attachment !== attachment) return Promise.resolve();
    this.revoke(record, new Error("Rendered action was cancelled because tab control ended"), true);
    return this.close(record, { retryFailed: true });
  }

  released(tabId, attachment) {
    const record = this.records.get(tabId);
    if (!record || record.attachment !== attachment) return;
    this.revoke(record, new Error("Rendered action was cancelled because tab control ended"), true);
    // Native detach already destroyed the stream. A successor must not wait
    // for the old native API reply, which remains in the shared drain set.
    this.records.delete(tabId);
    void this.close(record).catch(() => {});
  }

  async beforeExternal(tabId, attachment) {
    const record = this.records.get(tabId);
    if (!record || record.attachment !== attachment) return;
    this.revoke(record, new Error("OBU_VIEWER_UNAVAILABLE: caller-owned screencast replaced the viewer"));
    // Called inside the rendering queue. Do not await a close queued behind
    // this command; stop owns a single idempotent native cleanup Promise.
    await this.stop(record);
  }
}
