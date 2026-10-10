import { validateClipboardRequest, validateClipboardResult } from "./browser-clipboard.js";

const PORT_NAME = "obu.clipboard.private.v1";
const STORAGE_KEY = "obuClipboardPendingV1";
const PAGE = "clipboard-offscreen.html";
const TITLE = "Open Browser Use private clipboard";
const failure = code => new Error(`OBU_CLIPBOARD_${code}: private clipboard broker unavailable`);
const uuid = value => typeof value === "string" && value.length === 36 && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);

// The only messages carrying clipboard data travel on a verified private
// offscreen Port. Neither tabs nor runtime.sendMessage receive that data.
export class BrowserClipboardBroker {
  constructor({ chrome, validateScope }) {
    if (!chrome || typeof validateScope !== "function") throw new TypeError("BrowserClipboardBroker requires Chrome and scope validation");
    Object.assign(this, { chrome, validateScope });
    this.workerNonce = crypto.randomUUID();
    this.channel = null;
    this.candidates = new Set();
    this.channelWaiters = new Set();
    this.operation = null;
    this.unknown = null;
    this.recovery = null;
    this.recoveryWork = null;
    chrome.runtime?.onConnect?.addListener(port => { this.accept(port); });
  }

  supported() {
    const c = this.chrome;
    return c.runtime?.getContexts && c.runtime?.onConnect && c.runtime?.sendMessage && c.offscreen?.createDocument && c.offscreen?.closeDocument &&
      c.debugger?.getTargets && c.debugger?.attach && c.debugger?.sendCommand && c.debugger?.detach && c.storage?.session?.get && c.storage?.session?.set;
  }

  async contexts() {
    const url = this.chrome.runtime.getURL(PAGE);
    const contexts = await this.chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [url] });
    return contexts.filter(context => context.contextType === "OFFSCREEN_DOCUMENT" && context.documentUrl === url && context.tabId === -1 && context.windowId === -1 && typeof context.documentId === "string" && context.documentId);
  }

  accept(port) {
    if (port.name !== PORT_NAME) return;
    const sender = port.sender;
    if (!sender || sender.id !== this.chrome.runtime.id || sender.url !== this.chrome.runtime.getURL(PAGE) || sender.tab ||
        (sender.documentId !== undefined && (typeof sender.documentId !== "string" || !sender.documentId)) ||
        (this.channel && !this.channel.disconnected) || this.candidates.size >= 4) {
      port.disconnect();
      return;
    }
    let seenHello = false;
    const channel = { port, documentId: sender.documentId, pending: new Map(), disconnected: false, verified: false };
    channel.expiry = setTimeout(() => { if (!channel.verified) port.disconnect(); }, 10000);
    this.candidates.add(channel);
    port.onDisconnect.addListener(() => {
      clearTimeout(channel.expiry);
      channel.disconnected = true;
      for (const pending of channel.pending.values()) pending.reject(failure("CHANNEL_LOST"));
      channel.pending.clear();
      this.candidates.delete(channel);
      if (this.channel === channel) this.channel = null;
    });
    port.onMessage.addListener(message => {
      if (!seenHello) {
        seenHello = true;
        if (message?.type !== "hello" || message.version !== 1 || !uuid(message.documentNonce) || Object.keys(message).some(key => !["type", "version", "documentNonce"].includes(key))) { port.disconnect(); return; }
        channel.documentNonce = message.documentNonce;
        void this.contexts().then(contexts => {
          if (channel.disconnected || contexts.length !== 1 || (channel.documentId !== undefined && contexts[0].documentId !== channel.documentId)) { port.disconnect(); return; }
          // Chromium offscreen Port.sender omits documentId. The live context
          // supplies a candidate ID; native nonce proof below authenticates it.
          channel.documentId = contexts[0].documentId;
          channel.ready = true;
          for (const waiter of this.channelWaiters) if (waiter.documentId === channel.documentId) { this.channelWaiters.delete(waiter); clearTimeout(waiter.timer); waiter.resolve(channel); break; }
        }, () => port.disconnect());
        return;
      }
      if (this.channel !== channel || message?.type !== "reply" || message.documentNonce !== channel.documentNonce || message.workerNonce !== this.workerNonce) return;
      const pending = channel.pending.get(message.requestId);
      if (!pending) return;
      channel.pending.delete(message.requestId);
      if (message.ok === true) pending.resolve(message.value);
      else pending.reject(new Error(/^OBU_CLIPBOARD_[A-Z_]+:/.test(message.error ?? "") ? message.error.slice(0, 160) : failure("FAILED").message));
    });
  }

  nextCandidate(documentId, deadlineAt) {
    const candidate = [...this.candidates].find(channel => channel.ready && channel.documentId === documentId && !channel.disconnected);
    if (candidate) return Promise.resolve(candidate);
    return new Promise((resolve, reject) => {
      const waiter = { documentId, resolve, reject };
      waiter.timer = setTimeout(() => { this.channelWaiters.delete(waiter); reject(failure("CHANNEL_LOST")); }, Math.max(1, Math.min(10000, deadlineAt - Date.now())));
      this.channelWaiters.add(waiter);
    });
  }

  async authenticate(channel) {
    const candidates = (await this.chrome.debugger.getTargets()).filter(target => target.url === this.chrome.runtime.getURL(PAGE) && target.title === TITLE && target.type === "background_page" && target.tabId === undefined);
    if (candidates.length !== 1) throw failure("UNSUPPORTED");
    const debuggee = { targetId: candidates[0].id };
    let newlyAttached = false;
    try {
      if (!candidates[0].attached) { await this.chrome.debugger.attach(debuggee, "1.3"); newlyAttached = true; }
      const identity = await this.chrome.debugger.sendCommand(debuggee, "Runtime.evaluate", { expression: "globalThis.__obuClipboardDocumentNonce", returnByValue: true });
      if (identity.exceptionDetails || identity.result?.value !== channel.documentNonce) throw failure("UNSUPPORTED");
      const contexts = await this.contexts();
      if (channel.disconnected || contexts.length !== 1 || contexts[0].documentId !== channel.documentId) throw failure("CHANNEL_LOST");
    } finally {
      // Existing attachment may be an in-flight broker operation. An invalid
      // candidate must never disconnect it, even if sendCommand proved ours.
      if (newlyAttached) await this.chrome.debugger.detach(debuggee);
    }
  }

  async waitChannel(documentId, deadlineAt) {
    if (this.channel?.documentId === documentId && !this.channel.disconnected) return this.channel;
    while (Date.now() < deadlineAt) {
      const candidate = await this.nextCandidate(documentId, deadlineAt);
      try {
        await this.authenticate(candidate);
        if (Date.now() >= deadlineAt) throw failure("TIMEOUT");
        if (this.channel && !this.channel.disconnected) { candidate.port.disconnect(); return this.channel; }
        candidate.verified = true;
        clearTimeout(candidate.expiry);
        this.candidates.delete(candidate);
        this.channel = candidate;
        return candidate;
      } catch (error) {
        candidate.port.disconnect();
        // Identity failure is terminal for this attempt, never permission to
        // accept the same URL without proof or disturb an established channel.
        throw error;
      }
    }
    throw failure("TIMEOUT");
  }

  request(channel, type, params = {}) {
    if (!channel.verified || channel.disconnected || this.channel !== channel) return Promise.reject(failure("CHANNEL_LOST"));
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      channel.pending.set(requestId, { resolve, reject });
      try {
        channel.port.postMessage({ type, requestId, workerNonce: this.workerNonce, documentNonce: channel.documentNonce, ...params });
      } catch {
        channel.pending.delete(requestId);
        reject(failure("CHANNEL_LOST"));
      }
    });
  }

  async bind(documentId, deadlineAt) {
    if (!this.channel || this.channel.documentId !== documentId) {
      // This contains no clipboard text, bytes, operation ID, or scope.
      await this.chrome.runtime.sendMessage({ type: "obu.clipboard.reconnect" }).catch(() => {});
    }
    const channel = await this.waitChannel(documentId, deadlineAt);
    const bound = await this.request(channel, "bind");
    if (!bound || Object.keys(bound).length !== 1 || !(bound.clearedOperationId === null || uuid(bound.clearedOperationId))) throw failure("FAILED");
    return { channel, bound };
  }

  markUnknown(metadata) {
    if (!this.unknown) {
      let resolve;
      const pending = new Promise(done => { resolve = done; });
      this.unknown = { metadata, pending, resolve };
    }
    return failure("CLEANUP_UNKNOWN");
  }

  async detachOwned(metadata) {
    if (!metadata.targetId) return;
    const targets = await this.chrome.debugger.getTargets();
    const target = targets.find(candidate => candidate.id === metadata.targetId);
    if (!target || !target.attached) return;
    if (target.url !== this.chrome.runtime.getURL(PAGE) || target.type !== "background_page" || target.tabId !== undefined) throw failure("CLEANUP_UNKNOWN");
    // sendCommand succeeds only for this extension's own debugger attachment.
    const identity = await this.chrome.debugger.sendCommand({ targetId: target.id }, "Runtime.evaluate", { expression: "globalThis.__obuClipboardDocumentNonce", returnByValue: true });
    if (identity.exceptionDetails || identity.result?.value !== metadata.documentNonce) throw failure("CLEANUP_UNKNOWN");
    await this.chrome.debugger.detach({ targetId: target.id });
  }

  async clean(metadata) {
    await this.detachOwned(metadata);
    const contexts = await this.contexts();
    if (contexts.length !== 1 || contexts[0].documentId !== metadata.documentId) throw failure("CLEANUP_UNKNOWN");
    await this.chrome.offscreen.closeDocument();
    await this.chrome.storage.session.set({ [STORAGE_KEY]: null });
    if (this.unknown) { this.unknown.resolve(); this.unknown = null; }
  }

  async reconcile(metadata) {
    try {
      const contexts = await this.contexts();
      if (contexts.length !== 1 || contexts[0].documentId !== metadata.documentId) throw failure("CLEANUP_UNKNOWN");
      const { channel, bound } = await this.bind(metadata.documentId, Date.now() + 10000);
      if (channel.documentNonce !== metadata.documentNonce || (bound.clearedOperationId !== null && bound.clearedOperationId !== metadata.operationId)) throw failure("CLEANUP_UNKNOWN");
      await this.clean(metadata);
    } catch { throw this.markUnknown(metadata); }
  }

  recover() {
    if (this.recovery) return this.recovery;
    const work = { metadata: null, promise: null };
    this.recoveryWork = work;
    // Publish the pending work before even dispatching storage.get. Until its
    // marker is read, its owner is unknown and scoped cleanup must wait too.
    this.recovery = Promise.resolve().then(() => this.recoverPending(work)).catch(error => {
      this.recovery = null;
      throw error;
    }).finally(() => { if (this.recoveryWork === work) this.recoveryWork = null; });
    work.promise = this.recovery;
    return this.recovery;
  }

  retryCleanup() {
    if (this.cleaning) return this.cleaning;
    if (!this.unknown) return Promise.resolve();
    // Invoked by an explicit cleanup retry, never by a normal API request.
    // A failed startup read has not established that the marker is absent.
    // Read it again before deciding which original document needs cleanup;
    // never create a replacement document or replay a clipboard operation.
    this.cleaning = (this.unknown.markerUnread ? this.recover() : this.reconcile(this.unknown.metadata))
      .then(() => { this.recovery = Promise.resolve(); }).finally(() => { this.cleaning = null; });
    return this.cleaning;
  }

  async recoverPending(work) {
    const storage = this.chrome.storage?.session;
    if (!storage?.get && !this.unknown?.markerUnread) return; // Old test fixtures / unsupported browser.
    let data;
    try {
      if (!storage?.get) throw failure("UNSUPPORTED");
      if (storage.setAccessLevel) await storage.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
      data = await storage.get(STORAGE_KEY);
    } catch (error) {
      this.markUnknown(null);
      this.unknown.markerUnread = true;
      // Preserve the actual storage failure, while unknown.pending keeps end,
      // detach and Pause blocked after this read promise has rejected.
      throw error;
    }
    const metadata = data?.[STORAGE_KEY];
    work.metadata = metadata;
    if (this.unknown?.markerUnread) {
      if (metadata == null) { this.unknown.resolve(); this.unknown = null; }
      else { this.unknown.metadata = metadata; this.unknown.markerUnread = false; }
    }
    if (metadata == null) return;
    if (!this.supported() || !metadata || metadata.version !== 1 || !uuid(metadata.documentNonce) || !uuid(metadata.operationId) || typeof metadata.documentId !== "string" || !metadata.documentId || typeof metadata.session_id !== "string" || !metadata.session_id || !Number.isSafeInteger(metadata.tabId) || metadata.tabId < 0 || typeof metadata.targetId !== "string" || !metadata.targetId) throw this.markUnknown(metadata);
    await this.reconcile(metadata);
  }

  async attach(channel, metadata = null) {
    const url = this.chrome.runtime.getURL(PAGE);
    const candidates = (await this.chrome.debugger.getTargets()).filter(target => target.url === url && target.title === TITLE && target.type === "background_page" && target.tabId === undefined);
    if (candidates.length !== 1) throw failure("UNSUPPORTED");
    const target = candidates[0];
    const debuggee = { targetId: target.id };
    let owned = false;
    try {
      if (!target.attached) { await this.chrome.debugger.attach(debuggee, "1.3"); owned = true; if (metadata) metadata.targetId = target.id; }
      const identity = await this.chrome.debugger.sendCommand(debuggee, "Runtime.evaluate", { expression: "globalThis.__obuClipboardDocumentNonce", returnByValue: true });
      // An existing attachment is ours only after this succeeds. Do not detach
      // a competing debugger when sendCommand rejects.
      owned = true;
      if (metadata) metadata.targetId = target.id;
      if (identity.exceptionDetails || identity.result?.value !== channel.documentNonce) throw failure("UNSUPPORTED");
      await this.chrome.debugger.sendCommand(debuggee, "Emulation.setFocusEmulationEnabled", { enabled: true });
      return target.id;
    } catch (error) {
      if (owned) await this.chrome.debugger.detach(debuggee);
      throw error;
    }
  }

  execute(scope, method, request, { check, deadlineAt }) {
    if (this.operation || this.unknown) return Promise.reject(failure(this.unknown ? "CLEANUP_UNKNOWN" : "BUSY"));
    const operation = { scope, promise: null };
    this.operation = operation;
    operation.promise = this.produce(scope, method, request, { check, deadlineAt }).catch(async error => {
      // A missing document is not evidence that the native operation settled.
      // Keep the actual adapter flow in end/Pause drains until reconciliation.
      if (this.unknown) await this.unknown.pending;
      throw error;
    }).finally(() => { if (this.operation === operation) this.operation = null; });
    return operation.promise;
  }

  async produce(scope, method, request, { check, deadlineAt }) {
    await this.recover();
    if (!this.supported()) throw failure("UNSUPPORTED");
    const params = validateClipboardRequest(method, request);
    const assert = () => { check(); if (!Number.isFinite(deadlineAt) || Date.now() >= deadlineAt) throw failure("TIMEOUT"); };
    assert();
    let metadata, channel, marked = false;
    try {
      let contexts = await this.contexts();
      assert();
      if (!contexts.length) {
        await this.chrome.offscreen.createDocument({ url: PAGE, reasons: ["CLIPBOARD"], justification: "Perform an explicitly requested, scoped clipboard operation" });
        contexts = await this.contexts();
      }
      assert();
      if (contexts.length !== 1) throw failure("UNSUPPORTED");
      ({ channel } = await this.bind(contexts[0].documentId, deadlineAt));
      assert();
      metadata = { version: 1, documentId: channel.documentId, documentNonce: channel.documentNonce, operationId: crypto.randomUUID(), targetId: null, session_id: params.session_id, tabId: params.tabId };
      await this.attach(channel, metadata);
      assert();
      // No contents are persisted. Await this write before dispatching any
      // payload or native call; a suspended write stays in the real promise.
      marked = true;
      await this.chrome.storage.session.set({ [STORAGE_KEY]: metadata });
      assert();
      await this.request(channel, "prepare", { operationId: metadata.operationId, method, params, deadlineAt });
      assert();
      await this.validateScope(scope);
      assert();
      const result = await this.request(channel, "commit", { operationId: metadata.operationId });
      const validated = validateClipboardResult(method, result, params.maxBytes);
      await this.clean(metadata);
      return validated;
    } catch (error) {
      if (metadata && marked) {
        try {
          // Bind revokes preparation and waits for a committed native promise;
          // it never issues the native action a second time.
          await this.reconcile(metadata);
        } catch (cleanupError) { throw cleanupError; }
      } else if (metadata?.targetId) {
        try { await this.clean(metadata); } catch { throw this.markUnknown(metadata); }
      }
      // Before ownership is proven, leave the idle offscreen document alone.
      // Closing a target attached by another debugger would disconnect it too.
      throw error;
    }
  }

  controlSnapshot() {
    const records = [this.operation, this.unknown, this.recoveryWork].filter(Boolean);
    return {
      tabIds: new Set(records.map(record => record.scope?.tabId ?? record.metadata?.tabId).filter(Number.isSafeInteger)),
      pending: records.map(record => record.promise ?? record.pending).filter(Boolean)
    };
  }
  async waitForSession(sessionId) {
    const recovery = this.recoveryWork;
    if (recovery && (!recovery.metadata?.session_id || recovery.metadata.session_id === sessionId)) await recovery.promise.catch(() => {});
    if (this.operation?.scope.session_id === sessionId) await this.operation.promise.catch(() => {});
    if (this.unknown && (!this.unknown.metadata?.session_id || this.unknown.metadata.session_id === sessionId)) await this.unknown.pending;
  }
  async waitForTab(tabId) {
    const recovery = this.recoveryWork;
    if (recovery && (!Number.isSafeInteger(recovery.metadata?.tabId) || recovery.metadata.tabId === tabId)) await recovery.promise.catch(() => {});
    if (this.operation?.scope.tabId === tabId) await this.operation.promise.catch(() => {});
    if (this.unknown && (!Number.isSafeInteger(this.unknown.metadata?.tabId) || this.unknown.metadata.tabId === tabId)) await this.unknown.pending;
  }
}
