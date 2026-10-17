import { NativeInputTracker } from "./browser-input-adapter.js";
import { BrowserRendering } from "./browser-rendering.js";

const fail = (message, code = "INVALID") => new Error(`OBU_HUMAN_${code}: ${message}`);
const buttons = { left: 1, right: 2, middle: 4 };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fields(value, required, optional = []) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw fail("invalid input object");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== "string" || ![...required, ...optional].includes(key) || !("value" in descriptors[key])) ||
      required.some(key => !Object.hasOwn(descriptors, key))) throw fail("invalid input fields");
  return value;
}
function finite(value, min, max) { if (!Number.isFinite(value) || value < min || value > max) throw fail("input is outside its supported bounds"); return value; }
function clientGeometry(metrics) {
  const viewport = metrics?.cssVisualViewport;
  if (!viewport || viewport.scale !== 1 || viewport.zoom !== 1 || viewport.offsetX !== 0 || viewport.offsetY !== 0 ||
      !Number.isFinite(viewport.clientWidth) || !Number.isFinite(viewport.clientHeight) ||
      viewport.clientWidth < 1 || viewport.clientHeight < 1 || viewport.clientWidth > 16384 || viewport.clientHeight > 16384)
    throw fail("only an unscaled CSS viewport without a visual offset is supported", "GEOMETRY");
  return Object.freeze({ width: viewport.clientWidth, height: viewport.clientHeight });
}

// This owns a separate native attachment after task Pause actually completes.
// It never lends the task backend a token, changes task admission, or reattaches
// a replacement tab. All native work (including timed-out work) stays here.
export class ManagedHumanControl {
  constructor({ chrome, capture, validate, pause, assertPaused, markRisk, clearRisk, onFailure = () => {} }) {
    Object.assign(this, { chrome, capture, validate, pause, assertPaused, markRisk, clearRisk, onFailure });
    this.current = null;
  }

  assertReleased() { if (this.current) throw fail("finish releasing human control before resuming automation", "BUSY"); }
  status() { return this.current ? this.info(this.current) : null; }
  info(record) {
    return Object.freeze({ state: record.state, leaseId: record.leaseId, tabId: record.tabId,
      generation: record.generation, viewport: record.viewport, lastInputSequence: record.sequence });
  }
  check(record) {
    if (this.current !== record || record.revoked) throw fail("human lease was revoked", "STALE");
    record.assertAuthority();
    if (record.paused) this.assertPaused();
  }
  ownsSource(record, source) {
    if (!record.attached || !source || typeof source !== "object" || source.sessionId != null || source.extensionId != null) return false;
    // Chrome may report a page session by tabId even when attached by targetId.
    // The fallback is valid only during this exclusive, original attachment.
    if (Object.hasOwn(source, "targetId")) return source.targetId === record.candidate.targetId &&
      (source.tabId === undefined || source.tabId === record.tabId);
    return source.tabId === record.tabId;
  }

  begin(tabId, assertAuthority, onFrame) {
    this.assertReleased();
    if (!Number.isSafeInteger(tabId) || tabId < 0 || typeof assertAuthority !== "function" || typeof onFrame !== "function") throw fail("invalid human control request");
    assertAuthority();
    const record = { tabId, assertAuthority, onFrame, leaseId: crypto.randomUUID(), token: {}, state: "starting",
      generation: 0, viewport: null, sequence: 0, closed: deferred(), buttons: new Set(), keys: new Map(), drains: new Set(), listeners: new Map() };
    // Reserve synchronously, before capture, storage, Pause, or native attach.
    this.current = record;
    record.tracker = new NativeInputTracker({
      beforeInput: () => this.markRisk(record.leaseId, tabId),
      assertInput: () => this.checkInputGeometry(record)
    });
    let queue = Promise.resolve();
    record.rendering = new BrowserRendering({ streams: new Map(), drains: record.drains,
      queue: (_tabId, operation) => { const next = queue.catch(() => {}).then(operation); queue = next; return next; },
      // Starting work still requires live human authority. Native frame ACKs
      // and stop belong to the original attachment even after publication is
      // revoked, and must be allowed to finish their actual cleanup.
      send: (_target, method, params) => this.send(record, method, params,
        ["Page.enable", "Page.startScreencast"].includes(method) ? () => this.check(record) : undefined),
      addListener: listener => {
        const wrapped = (source, method, params) => { if (this.ownsSource(record, source)) listener({ tabId }, method, params); };
        record.listeners.set(listener, wrapped); this.chrome.debugger.onEvent.addListener(wrapped);
      },
      removeListener: listener => { const wrapped = record.listeners.get(listener); if (wrapped) this.chrome.debugger.onEvent.removeListener(wrapped); record.listeners.delete(listener); },
      isCurrent: (_tabId, token) => record.attached && record.token === token,
      isExternal: () => false
    });
    record.handle = Object.freeze({ info: () => this.info(record), input: envelope => this.input(record, envelope), close: () => this.close(record), closed: record.closed.promise });
    record.start = Promise.resolve().then(() => this.start(record));
    return record.start.then(() => record.handle, async error => {
      try { await this.close(record, error); }
      catch { throw Object.assign(fail("original human cleanup remains unconfirmed", "CLEANUP_INCOMPLETE"), { humanCleanupIncomplete: true }); }
      throw error;
    });
  }

  async start(record) {
    this.check(record);
    record.candidate = await this.capture(record.tabId);
    this.check(record);
    await this.pause(record);
    record.paused = true;
    this.check(record);
    await this.validate(record.candidate);
    this.check(record);
    await this.markRisk(record.leaseId, record.tabId);
    record.riskMarked = true;
    this.check(record);
    await this.chrome.debugger.attach({ targetId: record.candidate.targetId }, "1.3");
    record.attached = true;
    record.tracker.register(record.tabId, record.token);
    record.lifecycle = (source, method, params) => {
      if (!this.ownsSource(record, source)) return;
      if (["Page.frameNavigated", "Page.documentOpened"].includes(method) && !params?.frame?.parentId)
        this.invalidateTab(record.tabId);
      else if (method === "Page.frameResized") this.recheckResize(record);
    };
    this.chrome.debugger.onEvent.addListener(record.lifecycle);
    this.check(record);
    await this.validate(record.candidate);
    this.check(record);
    await this.send(record, "Emulation.setFocusEmulationEnabled", { enabled: true }, () => this.check(record));
    this.check(record);
    // CSS client dimensions exclude native scrollbars. They guard subsequent
    // layout changes; only the original native frame establishes the complete
    // input surface (DIP == CSS pixels here because both zoom and scale are 1).
    record.clientViewport = clientGeometry(await this.send(record, "Page.getLayoutMetrics", undefined, () => this.check(record)));
    this.check(record);
    record.subscription = await record.rendering.subscribe(record.tabId, record.token,
      () => { if (!record.attached) throw fail("original debugger attachment ended", "UNAVAILABLE"); },
      frame => this.frame(record, frame));
    this.check(record);
    record.subscription.closed.then(({ reason }) => { if (!record.revoked) void this.close(record, fail(reason)).catch(() => {}); });
    record.state = "active";
  }

  send(record, method, params, assertAdmission) {
    if (!record.attached) throw fail("original debugger attachment ended", "UNAVAILABLE");
    const actual = Promise.resolve().then(() => {
      if (!record.attached) throw fail("original debugger attachment ended", "UNAVAILABLE");
      assertAdmission?.();
      return this.chrome.debugger.sendCommand({ targetId: record.candidate.targetId }, method, params);
    });
    record.drains.add(actual);
    actual.then(() => record.drains.delete(actual), () => record.drains.delete(actual));
    return actual;
  }

  frame(record, frame) {
    this.check(record);
    const metadata = frame.metadata;
    const width = metadata.deviceWidth, height = metadata.deviceHeight;
    if (metadata.pageScaleFactor !== 1 || metadata.offsetTop !== 0 ||
        !Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1 || width > 16384 || height > 16384 ||
        record.clientViewport.width > width || record.clientViewport.height > height ||
        record.viewport && (width !== record.viewport.width || height !== record.viewport.height)) {
      // Never deliver coordinates whose relationship to the current viewport
      // was guessed. A new explicit handoff is required after geometry changes.
      record.generation++;
      record.viewport = null;
      void this.close(record, fail("viewport changed; release and start a new handoff", "GEOMETRY")).catch(() => {});
      return;
    }
    // Preserve the entire displayed surface, including native scrollbars.
    // Never scale its image coordinates down to the smaller CSS client area.
    if (!record.viewport) record.viewport = Object.freeze({ width, height });
    if (!record.generation) record.generation = 1;
    record.onFrame(Object.freeze({ ...frame, controlMode: "human", humanLeaseId: record.leaseId, generation: record.generation }));
  }

  checkInputGeometry(record) {
    this.check(record);
    if (record.geometryPending) throw fail("original viewport resize check is still pending", "GEOMETRY");
  }

  checkClientGeometry(record, metrics) {
    const client = clientGeometry(metrics);
    if (client.width !== record.clientViewport.width || client.height !== record.clientViewport.height)
      throw fail("viewport changed before native input", "GEOMETRY");
  }

  recheckResize(record) {
    if (record.revoked || !record.clientViewport) return;
    // Coalesce events into one original native call at a time. A late reply
    // can only validate this lease; it never updates geometry or a successor.
    record.geometryDirty = true;
    if (record.geometryPending) return;
    const pending = Promise.resolve().then(async () => {
      while (record.geometryDirty && !record.revoked) {
        record.geometryDirty = false;
        this.check(record);
        const metrics = await this.send(record, "Page.getLayoutMetrics", undefined, () => this.check(record));
        this.check(record);
        this.checkClientGeometry(record, metrics);
      }
    });
    record.geometryPending = pending;
    const clear = () => { if (record.geometryPending === pending) record.geometryPending = null; };
    pending.then(clear, error => {
      clear();
      if (!record.revoked) {
        record.generation++; record.viewport = null;
        void this.close(record, error).catch(() => {});
      }
    });
  }

  command(record, input) {
    const modifier = () => { const value = input.modifiers ?? 0; if (!Number.isInteger(value)) throw fail("invalid modifiers"); return finite(value, 0, 15); };
    const point = () => {
      const x = finite(input.x, 0, record.viewport.width), y = finite(input.y, 0, record.viewport.height);
      if (x >= record.viewport.width || y >= record.viewport.height) throw fail("input is outside its supported bounds");
      return { x, y };
    };
    if (input?.type === "pointer") {
      fields(input, ["type", "action", "x", "y"], ["button", "modifiers"]);
      if (!["move", "down", "up"].includes(input.action) || input.action === "move" && input.button !== undefined || input.action !== "move" && !Object.hasOwn(buttons, input.button)) throw fail("invalid pointer input");
      if (input.action === "down" && record.buttons.has(input.button) || input.action === "up" && !record.buttons.has(input.button)) throw fail("pointer hold does not match this lease");
      const next = new Set(record.buttons); if (input.action === "down") next.add(input.button); if (input.action === "up") next.delete(input.button);
      return ["Input.dispatchMouseEvent", { ...point(), type: { move: "mouseMoved", down: "mousePressed", up: "mouseReleased" }[input.action],
        button: input.button ?? "none", buttons: [...next].reduce((mask, button) => mask | buttons[button], 0), modifiers: modifier(), clickCount: input.action === "move" ? 0 : 1 }, () => { record.buttons = next; }];
    }
    if (input?.type === "wheel") {
      fields(input, ["type", "x", "y", "deltaX", "deltaY"], ["modifiers"]);
      return ["Input.dispatchMouseEvent", { ...point(), type: "mouseWheel", deltaX: finite(input.deltaX, -4096, 4096), deltaY: finite(input.deltaY, -4096, 4096), modifiers: modifier() }, () => {}];
    }
    if (input?.type === "key") {
      fields(input, ["type", "action", "key", "code", "windowsVirtualKeyCode"], ["modifiers"]);
      if (!["down", "up"].includes(input.action) || typeof input.key !== "string" || !input.key.length || input.key.length > 64 || typeof input.code !== "string" || !/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(input.code) ||
          !Number.isInteger(input.windowsVirtualKeyCode) || input.windowsVirtualKeyCode < 0 || input.windowsVirtualKeyCode > 255) throw fail("invalid key input");
      if (input.action === "down" && record.keys.has(input.code) || input.action === "up" && !record.keys.has(input.code)) throw fail("key hold does not match this lease");
      const held = record.keys.get(input.code);
      if (input.action === "up" && held.windowsVirtualKeyCode !== input.windowsVirtualKeyCode) throw fail("key release must match its original virtual key");
      // DOM key text can change as another modifier is released. The native
      // release uses the original acknowledged key, never an unrelated keyUp
      // that would incorrectly clear the input tracker's held intent.
      const key = input.action === "up" ? held : { key: input.key, code: input.code, windowsVirtualKeyCode: input.windowsVirtualKeyCode };
      return ["Input.dispatchKeyEvent", { ...key, type: input.action === "down" ? "rawKeyDown" : "keyUp", modifiers: modifier() },
        () => { if (input.action === "down") record.keys.set(input.code, key); else record.keys.delete(input.code); }];
    }
    if (input?.type === "text") {
      fields(input, ["type", "text"]);
      if (typeof input.text !== "string" || input.text.length < 1 || input.text.length > 4096 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(input.text)) throw fail("invalid text input");
      // insertText commits text directly (including the viewer's already
      // shifted character); it does not synthesize or release a physical key.
      // Preserve real Shift holds through this commit and their later ACKed up.
      const onlyShift = [...record.keys.values()].every(key =>
        ["ShiftLeft", "ShiftRight"].includes(key.code) && key.windowsVirtualKeyCode === 16);
      if (!onlyShift || record.buttons.size) throw fail("release held input before inserting text");
      return ["Input.insertText", { text: input.text }, () => {}];
    }
    throw fail("unsupported input type");
  }

  input(record, envelope) {
    try {
      this.check(record);
      fields(envelope, ["leaseId", "generation", "sequence", "input"]);
      if (record.state !== "active" || !record.generation || !record.viewport || envelope.leaseId !== record.leaseId || envelope.generation !== record.generation ||
          !Number.isSafeInteger(envelope.sequence) || envelope.sequence !== record.sequence + 1) throw fail("input does not match the displayed human lease and generation", "STALE");
      if (record.inputPending) throw fail("wait for the original input acknowledgement", "BUSY");
      fields(envelope.input, ["type"], ["action", "x", "y", "button", "modifiers", "deltaX", "deltaY", "key", "code", "windowsVirtualKeyCode", "text"]);
      const [method, params, commit] = this.command(record, { ...envelope.input });
      const sequence = envelope.sequence;
      const pending = Promise.resolve().then(async () => {
        this.check(record);
        if (record.geometryPending) await record.geometryPending;
        this.check(record);
        await this.validate(record.candidate);
        this.check(record);
        const metrics = await this.send(record, "Page.getLayoutMetrics", undefined, () => this.check(record));
        this.check(record);
        this.checkClientGeometry(record, metrics);
        record.sequence = sequence;
        await record.tracker.send({ tabId: record.tabId }, record.token, method, params, () => {
          this.checkInputGeometry(record);
          return this.send(record, method, params, () => this.checkInputGeometry(record));
        });
        commit();
        this.check(record);
        return this.info(record);
      });
      record.inputPending = pending;
      pending.then(() => { if (record.inputPending === pending) record.inputPending = null; }, error => {
        if (record.inputPending === pending) record.inputPending = null;
        void this.close(record, error).catch(() => {});
      });
      return pending;
    } catch (error) { return Promise.reject(error); }
  }

  revoke(record, error = fail("human control ended", "STALE")) {
    if (record.revoked) return;
    record.revoked = true; record.state = "releasing"; record.onFrame = null;
    record.closed.resolve({ reason: String(error.message) });
    void record.rendering.cancel(record.tabId, record.token).catch(() => {});
  }
  cancel(error, exempt) {
    if (!this.current || this.current === exempt) return Promise.resolve();
    return this.close(this.current, error);
  }
  close(record, error) {
    this.revoke(record, error);
    if (!record.closing) {
      record.closing = (async () => {
        await Promise.allSettled([record.start, record.inputPending, record.geometryPending].filter(Boolean));
        if (record.attached) {
          await record.tracker.release(record.tabId, record.token, (_target, method, params) => this.send(record, method, params));
          await record.rendering.cancel(record.tabId, record.token);
          await Promise.allSettled([...record.drains]);
          await this.send(record, "Emulation.setFocusEmulationEnabled", { enabled: false });
          // No synthetic onDetach acknowledgement: Chrome's detach Promise is
          // the native completion. Never detach while an original send lives.
          record.detaching = true;
          try { await this.chrome.debugger.detach({ targetId: record.candidate.targetId }); }
          finally { record.detaching = false; }
          record.attached = false;
          record.tracker.forget(record.tabId, record.token);
        } else if (record.destroyed) {
          await Promise.allSettled([...record.tracker.controlSnapshot().pending, ...record.drains]);
          record.tracker.forget(record.tabId, record.token, { destroyed: true });
        } else if (record.lost) throw fail("external debugger loss did not confirm original input release", "CLEANUP_INCOMPLETE");
        if (record.riskMarked) await this.clearRisk(record.leaseId);
        if (record.lifecycle) this.chrome.debugger.onEvent.removeListener(record.lifecycle);
        record.state = "released";
        if (this.current === record) this.current = null;
      })().catch(error => { record.state = "error"; this.onFailure(error); throw error; });
      record.closing.catch(() => { record.closing = null; });
    }
    return record.closing;
  }
  invalidateTab(tabId, { destroyed = false } = {}) {
    const record = this.current;
    if (!record || record.tabId !== tabId) return;
    if (destroyed) { record.destroyed = true; record.attached = false; record.rendering.released(tabId, record.token); }
    void this.close(record, fail(destroyed ? "original tab closed" : "original page or ownership changed", "STALE")).catch(() => {});
  }
  observeDetach(source, reason) {
    const record = this.current;
    if (!record || !this.ownsSource(record, source)) return false;
    if (record.detaching) return true;
    record.attached = false; record.lost = true; record.destroyed = reason === "target_closed";
    record.rendering.released(record.tabId, record.token);
    void this.close(record, fail("original debugger attachment ended", "UNAVAILABLE")).catch(() => {});
    return true;
  }
}
