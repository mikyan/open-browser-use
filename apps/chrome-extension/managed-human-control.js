import { NativeInputTracker } from "./browser-input-adapter.js";
import { BrowserRendering } from "./browser-rendering.js";
import { ManagedHumanDialogs } from "./managed-human-dialogs.js";
import { ManagedHumanInputBudget } from "./managed-human-budget.js";
import { ManagedHumanDocumentContexts } from "./managed-human-document-contexts.js";

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

// One native attachment belongs to an immutable view or human lease. Only a
// human lease owns input intent and durable risk; both share document cleanup.
export class ManagedHumanControl {
  constructor({ chrome, capture, validate, pause, assertPaused, markRisk, clearRisk, assertDialog = () => {}, viewJournal = null, onFailure = () => {}, timing }) {
    Object.assign(this, { chrome, capture, validate, pause, assertPaused, markRisk, clearRisk, assertDialog, viewJournal, onFailure, timing });
    this.current = null;
    this.recoveryTimeoutMs = 10000;
  }

  assertReleased() { if (this.current) throw fail("finish releasing human control before resuming automation", "BUSY"); }
  assertHumanReleased() {
    if (this.current && (this.current.mode === "human" || this.current.state === "error"))
      throw fail("finish releasing human control before resuming automation", "BUSY");
  }
  status() { return this.current ? this.info(this.current) : null; }
  ownsTab(tabId) { return this.current?.tabId === tabId && !this.current.revoked; }
  info(record) {
    return Object.freeze({ state: record.state, leaseId: record.leaseId, tabId: record.tabId,
      generation: record.generation, viewport: record.viewport,
      ...(record.mode === "human" ? { inputBudgetVersion: 1 } : {}),
      lastInputSequence: record.mode === "view" || record.epoch?.retired ? 0 : record.epoch?.sequence ?? 0 });
  }
  tabInfo(record) {
    const epoch = record.epoch;
    const candidate = this.current === record && !record.revoked && record.state === "active" &&
      epoch && !epoch.retired && epoch.id === record.generation ? epoch.candidate : null;
    // Metadata belongs to the current verified document, never the original
    // capture or an abandoned preparation. It does not grant input authority.
    return Object.freeze({ id: record.tabId,
      title: candidate ? (typeof candidate.title === "string" ? candidate.title.slice(0, 512) : "") :
        ["starting", "navigating"].includes(record.state) ? "页面正在跳转" : "",
      url: candidate && typeof candidate.url === "string" ? candidate.url.slice(0, 8192) : "" });
  }
  notify(record) {
    try { record.onState(this.info(record)); }
    catch (error) { void this.close(record, error).catch(() => {}); }
  }
  check(record) {
    if (this.current !== record || record.revoked) throw fail("human lease was revoked", "STALE");
    record.assertAuthority();
    if (record.paused) this.assertPaused();
  }
  checkGeneration(record, epoch) {
    this.check(record);
    if (record.epoch !== epoch || epoch.retired || (record.generation && record.generation !== epoch.id))
      throw fail("input does not match the displayed human lease and generation; native input was not sent", "GENERATION_STALE");
  }
  ownsSource(record, source) {
    if (!record.attached || !source || typeof source !== "object" || source.sessionId != null || source.extensionId != null) return false;
    if (Object.hasOwn(source, "targetId")) return source.targetId === record.candidate.targetId &&
      (source.tabId === undefined || source.tabId === record.tabId);
    return source.tabId === record.tabId;
  }

  begin(tabId, assertAuthority, onFrame, onState = () => {}, options = {}) {
    return this.beginLease("human", tabId, assertAuthority, onFrame, onState, options);
  }
  beginView(tabId, assertAuthority, onFrame, onState = () => {}, options = {}) {
    return this.beginLease("view", tabId, assertAuthority, onFrame, onState, options);
  }
  beginLease(mode, tabId, assertAuthority, onFrame, onState, options) {
    this.assertReleased();
    if (!["human", "view"].includes(mode) || !Number.isSafeInteger(tabId) || tabId < 0 || typeof assertAuthority !== "function" || typeof onFrame !== "function" || typeof onState !== "function") throw fail("invalid human control request");
    fields(options, [], ["deliveryId"]);
    if (Object.hasOwn(options, "deliveryId") && (typeof options.deliveryId !== "string" || !options.deliveryId)) throw fail("invalid delivery identity");
    assertAuthority();
    const record = { tabId, assertAuthority, onFrame, onState, leaseId: crypto.randomUUID(), state: "starting",
      generation: 0, viewport: null, closed: deferred(), drains: new Set(), epochs: new Set(), pendingNavigations: new Set() };
    Object.defineProperties(record, { mode: { value: mode, enumerable: true }, options: { value: Object.freeze({ ...options }) } });
    this.current = record;
    if (mode === "human") record.documentContexts = new ManagedHumanDocumentContexts();
    if (mode === "human") record.dialogs = new ManagedHumanDialogs({ leaseId: record.leaseId,
      capture: params => this.captureDialog(record, params), assertCurrent: proof => this.checkDialog(record, proof),
      attached: () => record.attached === true, destroyed: () => record.destroyed === true,
      send: (params, check) => this.send(record, "Page.handleJavaScriptDialog", params, check),
      timing: this.timing,
      onOpened: (proof, original) => {
        const operation = proof.epoch.inputOperation;
        if (!operation) return;
        if (operation.dispatched) { original.inputOperation = operation; operation.budget.openModal(original); }
        else operation.modalInterrupted = true;
      },
      onClosed: (_proof, original) => original.inputOperation?.budget.closeModal(original),
      notify: () => this.notify(record), onFailure: error => { void this.close(record, error).catch(() => {}); } });
    record.handle = Object.freeze({ info: () => this.info(record), tabInfo: () => this.tabInfo(record),
      ...(mode === "human" ? { input: envelope => this.input(record, envelope), pendingDialog: () => record.dialogs.info(),
        respondDialog: envelope => record.dialogs.respond(envelope) } : {}),
      close: () => this.close(record), closed: record.closed.promise });
    record.start = Promise.resolve().then(() => this.start(record));
    return record.start.then(() => record.handle, async error => {
      try { await this.close(record, error); }
      catch { throw Object.assign(fail("original user-page cleanup remains unconfirmed", "CLEANUP_INCOMPLETE"),
        mode === "human" ? { humanCleanupIncomplete: true } : { viewerCleanupIncomplete: true }); }
      throw error;
    });
  }

  createGeneration(record) {
    const epoch = { id: record.generation || 1, token: {}, sequence: 0, buttons: new Set(), keys: new Map(), listeners: new Map() };
    if (record.mode === "human") {
      epoch.tracker = new NativeInputTracker({ beforeInput: () => this.markRisk(record.leaseId, record.tabId),
        assertInput: () => this.checkInputGeometry(record, epoch) });
      epoch.tracker.register(record.tabId, epoch.token);
    }
    let queue = Promise.resolve();
    epoch.rendering = new BrowserRendering({ streams: new Map(), drains: record.drains,
      queue: (_tabId, operation) => { const next = queue.catch(() => {}).then(operation); queue = next; return next; },
      send: (_target, method, params) => this.send(record, method, params,
        ["Page.enable", "Page.startScreencast"].includes(method) ? () => this.checkGeneration(record, epoch) : undefined),
      addListener: listener => {
        const wrapped = (source, method, params) => { if (this.ownsSource(record, source)) listener({ tabId: record.tabId }, method, params); };
        epoch.listeners.set(listener, wrapped); this.chrome.debugger.onEvent.addListener(wrapped);
      },
      removeListener: listener => { const wrapped = epoch.listeners.get(listener); if (wrapped) this.chrome.debugger.onEvent.removeListener(wrapped); epoch.listeners.delete(listener); },
      // Retirement revokes publication, not the original stop/ACK authority.
      isCurrent: (_tabId, token) => record.attached && epoch.token === token && !epoch.cleaned,
      isExternal: () => false
    });
    record.epoch = epoch; record.epochs.add(epoch);
    // Retain these inspection seams for existing lifecycle tests.
    record.token = epoch.token; record.tracker = epoch.tracker; record.rendering = epoch.rendering;
    return epoch;
  }

  async start(record) {
    this.check(record);
    record.candidate = await this.capture(record.tabId, record.options);
    this.check(record);
    if (record.mode === "human") { await this.pause(record); record.paused = true; }
    this.check(record); await this.validate(record.candidate); this.check(record);
    if (record.mode === "human") { await this.markRisk(record.leaseId, record.tabId); record.riskMarked = true; }
    this.check(record);
    if (record.mode === "view" && this.viewJournal) {
      await this.viewJournal.intent(record); record.viewIntent = true;
    }
    this.check(record);
    record.attachDispatched = true;
    await this.chrome.debugger.attach({ targetId: record.candidate.targetId }, "1.3"); record.attached = true;
    if (record.viewIntent) await this.viewJournal.attached(record);
    record.lifecycle = (source, method, params) => {
      if (!this.ownsSource(record, source)) return;
      if (record.documentContexts?.observe(method, params) && method.startsWith("Runtime.")) {
        record.dialogs.recheck(); return;
      }
      if (["Page.javascriptDialogOpening", "Page.javascriptDialogClosed"].includes(method)) {
        record.dialogs?.observe(method, params); return;
      }
      if (["Page.frameStartedNavigating", "Page.frameNavigated", "Page.documentOpened", "Page.navigatedWithinDocument", "Page.frameAttached", "Page.frameDetached"].includes(method)) {
        const frameId = params?.frame?.id ?? params?.frameId;
        this.navigation(record.tabId, { frameId, root: Boolean(params?.frame && !params.frame.parentId) },
          method === "Page.frameStartedNavigating" ? "pending" : "committed", "native");
      } else if (method === "Page.frameResized") this.recheckResize(record, record.epoch);
    };
    this.chrome.debugger.onEvent.addListener(record.lifecycle);
    this.check(record); await this.validate(record.candidate); this.check(record);
    if (record.mode === "human") {
      // Observe navigation and actual default contexts before either tree read.
      await this.send(record, "Page.enable", undefined, () => this.check(record));
      await this.send(record, "Runtime.enable", undefined, () => this.check(record));
      await this.send(record, "Emulation.setFocusEmulationEnabled", { enabled: true }, () => this.check(record));
    }
    await this.send(record, "Performance.enable", { timeDomain: "timeTicks" }, () => this.check(record));
    this.check(record); record.initialized = true;
    await this.recover(record);
  }

  send(record, method, params, assertAdmission) {
    if (record.mode === "view" && (method.startsWith("Input.") || method === "Emulation.setFocusEmulationEnabled" || method === "Page.handleJavaScriptDialog"))
      throw fail("a view lease has no native input or focus authority", "UNAVAILABLE");
    if (!record.attached) throw fail("original debugger attachment ended", "UNAVAILABLE");
    let dispatched = false;
    const actual = Promise.resolve().then(() => {
      if (!record.attached) throw fail("original debugger attachment ended", "UNAVAILABLE");
      assertAdmission?.();
      dispatched = true;
      return this.chrome.debugger.sendCommand({ targetId: record.candidate.targetId }, method, params);
    });
    record.drains.add(actual);
    actual.then(() => record.drains.delete(actual), error => {
      record.drains.delete(actual);
      // Navigation cannot turn an unknown native outcome into a safe retry.
      if (dispatched && !record.revoked) void this.close(record, error).catch(() => {});
    });
    return actual;
  }

  frameTree(value) {
    const entries = [], ids = new Set(), visit = (node, parent = null) => {
      const frame = node?.frame;
      if (entries.length >= 1000 || !frame || typeof frame.id !== "string" || !frame.id || typeof frame.loaderId !== "string" || !frame.loaderId || typeof frame.url !== "string")
        throw fail("native document and loader identity could not be proved", "UNAVAILABLE");
      if (ids.has(frame.id) || (frame.parentId !== undefined && frame.parentId !== parent) ||
          (frame.securityOrigin !== undefined && typeof frame.securityOrigin !== "string"))
        throw fail("native frame identity or parent relationship is ambiguous", "UNAVAILABLE");
      ids.add(frame.id);
      entries.push([frame.id, parent, frame.loaderId, frame.url, frame.urlFragment ?? "", frame.securityOrigin ?? null]);
      if (node.childFrames !== undefined && !Array.isArray(node.childFrames)) throw fail("invalid native frame tree", "UNAVAILABLE");
      for (const child of node.childFrames ?? []) visit(child, frame.id);
    };
    visit(value?.frameTree); return JSON.stringify(entries);
  }

  captureDialog(record, params) {
    this.check(record);
    const epoch = record.epoch;
    if (!epoch || epoch.retired || record.state !== "active" || !record.generation || !epoch.document)
      throw fail("dialogs require the original active human document", "DIALOG_UNSUPPORTED");
    this.assertDialog(epoch.candidate);
    const frames = JSON.parse(epoch.document), emitter = frames.find(frame => frame[0] === params?.frameId);
    if (!emitter || typeof params?.url !== "string" || params.url !== emitter[3] + emitter[4])
      throw fail("dialog emitter is outside the verified original document", "DIALOG_UNSUPPORTED");
    const contexts = emitter === frames[0] ? null : record.documentContexts.capture(epoch.dialogContexts, emitter[0]);
    return Object.freeze({ epoch, generation: epoch.id, document: epoch.document, contexts });
  }
  checkDialog(record, proof) {
    this.checkGeneration(record, proof.epoch);
    // Both response admission and final native dispatch must account the same
    // input's accumulated wait, even when its timer callback has not run yet.
    proof.epoch.inputOperation?.budget.assertAvailable();
    this.assertDialog(proof.epoch.candidate);
    if (record.state !== "active" || proof.generation !== record.generation || proof.document !== proof.epoch.document)
      throw fail("original dialog document changed", "DIALOG_STALE");
    if (proof.contexts) record.documentContexts.assert(proof.contexts);
  }

  async prepare(record, epoch) {
    const check = () => this.checkGeneration(record, epoch);
    check();
    const candidate = await this.validate(record.candidate, { advance: record.generation > 0 });
    check(); epoch.candidate = candidate ?? record.candidate;
    const contextRevision = record.documentContexts?.checkpoint();
    epoch.document = this.frameTree(await this.send(record, "Page.getFrameTree", undefined, check));
    check();
    // A read-only view has no CSS input coordinates. Zoom, visual offsets and
    // scrollbars constrain human input only, not the original native image.
    if (record.mode === "human") {
      epoch.clientViewport = clientGeometry(await this.send(record, "Page.getLayoutMetrics", undefined, check));
      check();
    }
    // Performance Timestamp and Page.monotonicTimestamp are native TimeTicks
    // seconds. Wall-clock timestamp, receipt time and a new stream ID are not
    // substitutes for the capture barrier.
    const metrics = await this.send(record, "Performance.getMetrics", undefined, check);
    check();
    const timestamps = metrics?.metrics?.filter(metric => metric.name === "Timestamp");
    if (timestamps?.length !== 1 || !Number.isFinite(timestamps[0].value) || timestamps[0].value <= 0)
      throw fail("this browser does not provide the native monotonic capture barrier; use the recommended compatible managed browser", "CAPTURE_UNSUPPORTED");
    epoch.barrier = timestamps[0].value;
    const currentCandidate = await this.validate(epoch.candidate); check();
    epoch.candidate = currentCandidate ?? epoch.candidate;
    if (this.frameTree(await this.send(record, "Page.getFrameTree", undefined, check)) !== epoch.document)
      throw fail("native document changed during capture preparation", "DOCUMENT_CHANGED");
    check();
    // This is an attachment event observation barrier, not an atomic browser
    // snapshot. A changed revision grants no child-dialog proof for this epoch.
    epoch.dialogContexts = record.documentContexts?.snapshot(epoch.document, contextRevision);
  }

  recover(record) {
    if (record.recovery) return record.recovery;
    const work = (async () => {
      while (!record.revoked) {
        if (record.epoch?.retired) await this.releaseGeneration(record, record.epoch);
        this.check(record);
        while (record.pendingNavigations.size) {
          await new Promise(resolve => { record.wake = resolve; }); record.wake = null;
          this.check(record);
        }
        const epoch = this.createGeneration(record);
        try {
          await this.prepare(record, epoch);
          this.checkGeneration(record, epoch);
          epoch.start = epoch.rendering.subscribe(record.tabId, epoch.token,
            () => { if (!record.attached) throw fail("original debugger attachment ended", "UNAVAILABLE"); },
            frame => this.frame(record, epoch, frame), { acceptFrame: frame => {
              if (epoch.retired || record.revoked) return false;
              this.checkGeneration(record, epoch);
              const capture = frame.metadata.monotonicTimestamp;
              if (!Number.isFinite(capture) || capture <= 0)
                throw fail("this browser does not provide the native frame capture timestamp; use the recommended compatible managed browser", "CAPTURE_UNSUPPORTED");
              return capture > epoch.barrier;
            } });
          epoch.subscription = await epoch.start;
          this.checkGeneration(record, epoch);
          epoch.subscription.closed.then(({ reason }) => {
            if (!record.revoked && !epoch.retired) void this.close(record, fail(reason)).catch(() => {});
          });
          clearTimeout(record.recoveryTimer); record.recoveryTimer = null;
          return;
        } catch (error) {
          if (record.revoked) throw error;
          if (!epoch.retired) throw error;
          // Only an observed navigation may retire a preparation. Do not
          // silently retry unknown native failures or failed cleanup.
          await this.releaseGeneration(record, epoch);
        }
      }
      this.check(record);
    })();
    record.recovery = work;
    work.then(() => {
      if (record.recovery === work) record.recovery = null;
      if (!record.revoked && record.state === "navigating") void this.recover(record).catch(() => {});
    }, error => {
      if (record.recovery === work) record.recovery = null;
      void this.close(record, error).catch(() => {});
    });
    return work;
  }

  navigation(tabId, details = {}, phase = "committed", source = "web") {
    const record = this.current;
    if (!record || record.tabId !== tabId || record.revoked) return;
    if (!record.initialized || phase === "error") { this.invalidateTab(tabId); return; }
    const key = `${source}:${details.frameId ?? "unknown"}`;
    if (phase === "pending") record.pendingNavigations.add(key);
    else if (phase === "committed") {
      if (details.root || details.frameId === 0) for (const item of record.pendingNavigations) if (item.startsWith(`${source}:`)) record.pendingNavigations.delete(item);
      record.pendingNavigations.delete(key);
    }
    if (record.pendingNavigations.size > 1000 || record.generation >= Number.MAX_SAFE_INTEGER) {
      void this.close(record, fail("navigation exceeded bounded capacity", "UNAVAILABLE")).catch(() => {}); return;
    }
    if (record.epoch) this.retireGeneration(record, record.epoch);
    record.generation = Math.max(1, record.generation) + 1;
    record.viewport = null; record.state = "navigating";
    this.notify(record); record.wake?.();
    if (record.revoked) return;
    if (!record.recoveryTimer) record.recoveryTimer = setTimeout(() => {
      void this.close(record, fail("navigation did not produce a verified frame before its deadline", "NAVIGATION_TIMEOUT")).catch(() => {});
    }, this.recoveryTimeoutMs);
    void this.recover(record).catch(() => {});
  }

  frame(record, epoch, frame) {
    this.checkGeneration(record, epoch);
    const metadata = frame.metadata, width = metadata.deviceWidth, height = metadata.deviceHeight;
    const invalidSurface = !Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1 || width > 16384 || height > 16384;
    const resized = epoch.viewport && (width !== epoch.viewport.width || height !== epoch.viewport.height);
    if (!invalidSurface && resized && record.mode === "view") {
      // Do not relabel this already-encoded frame as the new viewport. Retire
      // its original stream, then require a new native TimeTicks capture.
      this.navigation(record.tabId, {}, "committed", "view-resize");
      return;
    }
    if (invalidSurface || record.mode === "human" && (metadata.pageScaleFactor !== 1 || metadata.offsetTop !== 0 ||
        epoch.clientViewport.width > width || epoch.clientViewport.height > height || resized)) {
      record.generation++; record.viewport = null;
      const error = fail("viewport changed; release and start a new handoff", "GEOMETRY");
      void this.close(record, error).catch(() => {}); throw error;
    }
    if (!epoch.viewport) epoch.viewport = Object.freeze({ width, height });
    record.viewport = epoch.viewport; record.generation = epoch.id;
    if (record.state !== "active") { record.state = "active"; this.notify(record); }
    this.checkGeneration(record, epoch);
    record.onFrame(Object.freeze({ ...frame, generation: epoch.id, ...(record.mode === "human"
      ? { controlMode: "human", humanLeaseId: record.leaseId }
      : { controlMode: "user-view", viewLeaseId: record.leaseId }) }));
  }

  checkInputGeometry(record, epoch) {
    this.checkGeneration(record, epoch);
    if (record.dialogs?.hasOpen()) throw fail("answer the original native dialog before sending page input", "DIALOG_BUSY");
    if (epoch.geometryPending) throw fail("original viewport resize check is still pending", "GEOMETRY");
  }
  checkClientGeometry(epoch, metrics) {
    const client = clientGeometry(metrics);
    if (client.width !== epoch.clientViewport.width || client.height !== epoch.clientViewport.height)
      throw fail("viewport changed before native input", "GEOMETRY");
  }
  recheckResize(record, epoch) {
    if (!epoch || epoch.retired || record.revoked) return;
    if (record.mode === "view") {
      this.navigation(record.tabId, {}, "committed", "view-resize");
      return;
    }
    if (!epoch.clientViewport) return;
    epoch.geometryDirty = true;
    if (epoch.geometryPending) return;
    const pending = Promise.resolve().then(async () => {
      while (epoch.geometryDirty && !epoch.retired && !record.revoked) {
        epoch.geometryDirty = false;
        this.checkGeneration(record, epoch);
        const metrics = await this.send(record, "Page.getLayoutMetrics", undefined, () => this.checkGeneration(record, epoch));
        this.checkGeneration(record, epoch); this.checkClientGeometry(epoch, metrics);
      }
    });
    epoch.geometryPending = pending;
    const clear = () => { if (epoch.geometryPending === pending) epoch.geometryPending = null; };
    pending.then(clear, error => {
      clear();
      if (!record.revoked && !epoch.retired) { record.generation++; record.viewport = null; void this.close(record, error).catch(() => {}); }
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
      if (record.mode !== "human") throw fail("a view lease has no input authority", "UNAVAILABLE");
      fields(envelope, ["leaseId", "generation", "sequence", "input"]);
      if (envelope.leaseId !== record.leaseId) throw fail("input does not match the displayed human lease", "STALE");
      const epoch = record.epoch;
      if (!epoch || epoch.retired || record.state !== "active" || !record.generation || !record.viewport || envelope.generation !== record.generation)
        throw fail("input does not match the displayed human lease and generation; native input was not sent", "GENERATION_STALE");
      if (!Number.isSafeInteger(envelope.sequence) || envelope.sequence !== epoch.sequence + 1) throw fail("input does not match the displayed human lease sequence", "STALE");
      if (epoch.inputPending) throw fail("wait for the original input acknowledgement", "BUSY");
      if (record.dialogs.hasOpen()) throw fail("answer the original native dialog before sending page input", "DIALOG_BUSY");
      fields(envelope.input, ["type"], ["action", "x", "y", "button", "modifiers", "deltaX", "deltaY", "key", "code", "windowsVirtualKeyCode", "text"]);
      const [method, params, commit] = this.command(epoch, { ...envelope.input });
      const sequence = envelope.sequence;
      const operation = { dispatched: false, modalInterrupted: false };
      operation.budget = new ManagedHumanInputBudget({ timing: this.timing, onExpire: error => {
        // This observer deadline does not settle the actual native Promise.
        // Fence late admission synchronously, then join the original cleanup.
        this.revoke(record, error); void this.close(record, error).catch(() => {});
      } });
      epoch.inputOperation = operation;
      let sent = false;
      const pending = Promise.resolve().then(async () => {
        this.checkGeneration(record, epoch);
        if (epoch.geometryPending) await epoch.geometryPending;
        this.checkGeneration(record, epoch);
        await this.validate(epoch.candidate); this.checkGeneration(record, epoch);
        const metrics = await this.send(record, "Page.getLayoutMetrics", undefined, () => this.checkGeneration(record, epoch));
        this.checkGeneration(record, epoch); this.checkClientGeometry(epoch, metrics);
        if (this.frameTree(await this.send(record, "Page.getFrameTree", undefined, () => this.checkGeneration(record, epoch))) !== epoch.document)
          throw fail("native document changed before input", "DOCUMENT_CHANGED");
        this.checkGeneration(record, epoch);
        await epoch.tracker.send({ tabId: record.tabId }, epoch.token, method, params, () => {
          if (operation.modalInterrupted) throw fail("a native dialog interrupted this unsent input", "DIALOG_BUSY");
          this.checkInputGeometry(record, epoch);
          return this.send(record, method, params, () => {
            operation.budget.assertAvailable();
            if (operation.modalInterrupted) throw fail("a native dialog interrupted this unsent input", "DIALOG_BUSY");
            this.checkInputGeometry(record, epoch); sent = true; operation.dispatched = true;
          });
        });
        commit(); epoch.sequence = sequence;
        // An actual native ACK remains an ACK for its original tuple, even
        // after navigation or End. It never advances a successor generation.
        return Object.freeze({ leaseId: record.leaseId, generation: epoch.id, sequence, acknowledged: true });
      }).catch(error => {
        // Independent document reads can reject while the observed navigation
        // fence wins. The dispatch marker, not an error-text guess, proves this
        // old request was never delivered. Native failures revoke in send().
        if (!sent && epoch.retired && !record.revoked) {
          this.check(record);
          throw fail("input generation ended before native dispatch", "GENERATION_STALE");
        }
        throw error;
      });
      epoch.inputPending = pending;
      const settled = () => {
        if (epoch.inputPending === pending) epoch.inputPending = null;
        if (epoch.inputOperation === operation) epoch.inputOperation = null;
      };
      pending.then(settled, error => {
        settled();
        if (!sent && error?.message?.startsWith("OBU_HUMAN_GENERATION_STALE:")) return;
        void this.close(record, error).catch(() => {});
      });
      return operation.budget.observe(pending);
    } catch (error) { return Promise.reject(error); }
  }

  retireGeneration(record, epoch) {
    if (epoch.retired) return;
    record.dialogs?.retire(epoch);
    epoch.retired = true;
    void epoch.rendering.cancel(record.tabId, epoch.token).catch(() => {});
  }
  releaseGeneration(record, epoch) {
    this.retireGeneration(record, epoch);
    if (epoch.cleaned) return Promise.resolve();
    if (!epoch.cleaning) {
      epoch.cleaning = (async () => {
        await record.dialogs?.drain();
        await Promise.allSettled([epoch.start, epoch.inputPending, epoch.geometryPending].filter(Boolean));
        await record.dialogs?.drain();
        if (record.attached) {
          if (epoch.tracker) await epoch.tracker.release(record.tabId, epoch.token, (_target, method, params) => this.send(record, method, params));
          await epoch.rendering.cancel(record.tabId, epoch.token);
          if (epoch.tracker) {
            await Promise.allSettled([...epoch.tracker.controlSnapshot().pending]);
            epoch.tracker.forget(record.tabId, epoch.token);
          }
        } else if (record.destroyed) {
          if (epoch.tracker) {
            await Promise.allSettled([...epoch.tracker.controlSnapshot().pending]);
            epoch.tracker.forget(record.tabId, epoch.token, { destroyed: true });
          }
        } else throw fail("external debugger loss did not confirm original input release", "CLEANUP_INCOMPLETE");
        epoch.cleaned = true; record.epochs.delete(epoch);
      })();
      epoch.cleaning.catch(() => { epoch.cleaning = null; });
    }
    return epoch.cleaning;
  }
  revoke(record, error = fail("human control ended", "STALE")) {
    if (record.revoked) return;
    record.revoked = true; record.state = "releasing"; record.onFrame = null;
    record.dialogs?.revoke();
    clearTimeout(record.recoveryTimer); record.recoveryTimer = null; record.wake?.();
    record.closed.resolve({ reason: String(error.message) });
    for (const epoch of record.epochs) this.retireGeneration(record, epoch);
  }
  cancel(error, exempt) {
    if (!this.current || this.current === exempt) return Promise.resolve();
    return this.close(this.current, error);
  }
  revokeView(tabId) {
    const record = this.current;
    if (!record || record.mode !== "view" || (tabId !== undefined && record.tabId !== tabId)) return Promise.resolve();
    return this.close(record, fail("original view retired for task admission", "STALE"));
  }
  close(record, error) {
    this.revoke(record, error);
    if (!record.closing) {
      record.closing = (async () => {
        await record.dialogs?.close();
        await Promise.allSettled([record.start, record.recovery].filter(Boolean));
        for (const epoch of record.epochs) await this.releaseGeneration(record, epoch);
        await record.dialogs?.close();
        await Promise.allSettled([...record.drains]);
        if (record.attached) {
          if (record.mode === "human") await this.send(record, "Emulation.setFocusEmulationEnabled", { enabled: false });
          await record.dialogs?.drain();
          // No await separates this final admission from the original detach.
          record.dialogs?.assertDrained();
          record.detaching = true;
          try { await this.chrome.debugger.detach({ targetId: record.candidate.targetId }); }
          finally { record.detaching = false; }
          // Actual detach ACK ends this attachment's lifecycle-event admission.
          // An ambiguity or response observed while detach awaited still owns
          // its original cleanup obligation; ACK cannot settle either one.
          record.attached = false;
          record.detachAcknowledged = true;
        } else if (record.lost && !record.destroyed) throw fail("external debugger loss did not confirm original input release", "CLEANUP_INCOMPLETE");
        await record.dialogs?.drain();
        record.dialogs?.assertDrained();
        if (record.viewIntent) {
          // Attach rejection is not proof that an in-flight native operation
          // never acquired the target. Keep its durable intent when unknown.
          if (record.attachDispatched && !record.detachAcknowledged && !record.destroyed)
            throw fail("original view attachment outcome remains unknown", "CLEANUP_INCOMPLETE");
          await this.viewJournal.released(record); record.viewIntent = false;
        }
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
    if (destroyed) {
      record.destroyed = true; record.attached = false;
      for (const epoch of record.epochs) epoch.rendering.released(tabId, epoch.token);
    }
    void this.close(record, fail(destroyed ? "original tab closed" : "original page or ownership changed", "STALE")).catch(() => {});
  }
  observeDetach(source, reason) {
    const record = this.current;
    if (!record || !this.ownsSource(record, source)) return false;
    if (record.detaching) return true;
    record.attached = false; record.lost = true; record.destroyed = reason === "target_closed";
    for (const epoch of record.epochs) epoch.rendering.released(record.tabId, epoch.token);
    void this.close(record, fail("original debugger attachment ended", "UNAVAILABLE")).catch(() => {});
    return true;
  }
}
