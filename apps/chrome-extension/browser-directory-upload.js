// Directory enumeration outlives DOM.setFileInputFiles' acknowledgement. The
// renderer guard is deliberately independent of chooser IDs, owners and native
// attachments: a late enumeration must not complete a successor's submission.
export const DIRECTORY_UPLOAD_WORLD = "__open_browser_use_directory_upload_v1";
const busy = () => new Error("OBU_DIRECTORY_UPLOAD_BUSY: this file input has an unsettled submission");
const expired = () => new Error("OBU_DIRECTORY_UPLOAD_TIMEOUT: original submission deadline expired; native selection may still complete");
const cancelled = () => new Error("OBU_DIRECTORY_UPLOAD_CANCELLED: directory selection did not complete");
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  promise.catch(() => {});
  return { promise, resolve, reject };
};
const text = value => typeof value === "string" && value.length > 0 && value.length <= 512;
function validateIdentity(identity) {
  if (!identity || !Number.isSafeInteger(identity.tabId) || identity.tabId < 0 ||
      !identity.attachment || typeof identity.attachment !== "object" || Array.isArray(identity.attachment) ||
      !Number.isSafeInteger(identity.backendNodeId) || identity.backendNodeId < 1 || !text(identity.frameId) ||
      (identity.sessionId !== undefined && !text(identity.sessionId))) throw new Error("Invalid directory upload node identity");
}

// Executed on the exact resolved node in the named isolated world. No selector,
// MAIN-world property or page-defined callback supplies the completion signal.
export function installDirectoryUploadController(token, deadlineAt) {
  const node = this;
  if (!(node instanceof HTMLInputElement) || node.type !== "file" || !node.isConnected ||
      node.ownerDocument !== document || document.defaultView !== globalThis)
    throw new Error("File chooser node is not a connected file input in the original document");
  const key = "__openBrowserUseDirectoryUploadGuardsV1";
  let state = globalThis[key];
  if (!state) state = globalThis[key] = { version: 1, nodes: new WeakMap(), count: 0 };
  if (state.version !== 1 || !(state.nodes instanceof WeakMap) || !Number.isInteger(state.count))
    throw new Error("Directory upload renderer guard identity changed");
  const previous = state.nodes.get(node);
  if (previous) {
    // Prepared work has never dispatched a file mutation. Its own begin()
    // checks the same expiry, so retiring it cannot authorize a late dispatch.
    if (previous.phase === "prepared" && Date.now() >= previous.deadlineAt) previous.cleanup();
    else if (previous.phase === "terminal" || previous.phase === "released") previous.cleanup();
    else throw new Error("OBU_DIRECTORY_UPLOAD_BUSY: original node has an unsettled native submission");
  }
  if (state.count >= 128) throw new Error("OBU_DIRECTORY_UPLOAD_LIMIT: renderer file input capacity reached");
  if (typeof token !== "string" || !token || !Number.isFinite(deadlineAt) || Date.now() >= deadlineAt)
    throw new Error("Directory upload setup expired");
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  const controller = {
    token, deadlineAt, phase: "prepared", directory: node.webkitdirectory === true, multiple: node.multiple === true,
    promise,
    describe() { return { token, directory: this.directory, multiple: this.multiple }; },
    begin(directory) {
      if (state.nodes.get(node) !== this || this.phase !== "prepared" || Date.now() >= deadlineAt ||
          !node.isConnected || node.ownerDocument !== document || node.type !== "file" ||
          node.webkitdirectory !== this.directory || node.multiple !== this.multiple)
        throw new Error("Directory upload original node or admission changed");
      if (directory && !this.directory) throw new Error("File input does not accept a directory");
      this.phase = directory ? "directory-dispatched" : "ordinary-dispatched";
      return { token, phase: this.phase };
    },
    cleanup(abortBeforeSend = false) {
      // Unknown directory enumeration keeps its listener and guard even after
      // the worker, debugger attachment or caller has gone away.
      if (this.phase === "directory-dispatched" && !abortBeforeSend) return { token, removed: false };
      node.removeEventListener("input", listener, true);
      node.removeEventListener("cancel", listener, true);
      if (state.nodes.get(node) === this) { state.nodes.delete(node); state.count--; }
      this.phase = "released";
      resolve({ token, kind: "disposed" });
      return { token, removed: true };
    }
  };
  function listener(event) {
    if (controller.phase !== "directory-dispatched" || event.target !== node || event.isTrusted !== true) return;
    controller.phase = "terminal";
    node.removeEventListener("input", listener, true);
    node.removeEventListener("cancel", listener, true);
    // The terminal event itself confirms enumeration has stopped touching this
    // node. A dead worker need not return to release a now-settled guard.
    if (state.nodes.get(node) === controller) { state.nodes.delete(node); state.count--; }
    resolve({ token, kind: event.type, count: node.files.length });
  }
  node.addEventListener("input", listener, true);
  node.addEventListener("cancel", listener, true);
  state.nodes.set(node, controller); state.count++;
  return controller;
}

export class DirectoryUploadRegistry {
  constructor({ send, sendCleanup = (target, method, params) => send(target, method, params), checkCurrent = () => {}, canCleanup, now = () => Date.now(),
    setTimer = (fn, delay) => globalThis.setTimeout(fn, delay), clearTimer = id => globalThis.clearTimeout(id), maxTotal = 128 } = {}) {
    if (typeof send !== "function" || typeof canCleanup !== "function" || !Number.isInteger(maxTotal) || maxTotal < 1 || maxTotal > 128)
      throw new Error("Directory upload native hooks and a capacity up to 128 are required");
    Object.assign(this, { send, sendCleanup, checkCurrent, canCleanup, now, setTimer, clearTimer, maxTotal });
    this.records = new Map();
    this.operations = new Set();
    this.operationRecords = new Map();
    this.attachments = new WeakMap();
    this.nextAttachment = 0;
  }

  get size() { return this.records.size; }
  tabIds() { return [...new Set([...this.records.values()].map(record => record.identity.tabId))]; }
  key(identity) {
    validateIdentity(identity);
    if (!this.attachments.has(identity.attachment)) this.attachments.set(identity.attachment, ++this.nextAttachment);
    return JSON.stringify([identity.tabId, this.attachments.get(identity.attachment), identity.sessionId ?? null, identity.backendNodeId]);
  }
  assertAvailable(identity) { if (this.records.has(this.key(identity))) throw busy(); }

  reserve({ identity, scope, deadlineAt, check = () => {}, validate = async () => {} }) {
    const key = this.key(identity);
    this.assertAvailable(identity);
    if (this.records.size >= this.maxTotal) throw new Error("OBU_DIRECTORY_UPLOAD_LIMIT: file input capacity reached");
    if (!Number.isFinite(deadlineAt) || this.now() >= deadlineAt) throw expired();
    check(); this.checkCurrent(scope);
    const record = { key, identity: Object.freeze({ ...identity }), scope: Object.freeze({ ...scope }), deadlineAt, check, validate,
      token: crypto.randomUUID(), cancellation: deferred(), setupPending: 0, dispatched: false, nativeSettled: false,
      terminal: null, retired: false, callerDone: false, cleanupDone: false, remoteErrorObjectIds: new Set() };
    this.records.set(key, record);
    const expire = () => {
      const remaining = deadlineAt - this.now();
      if (remaining > 0) record.timer = this.setTimer(expire, remaining);
      else this.cancel(record, expired());
    };
    record.timer = this.setTimer(expire, Math.max(1, deadlineAt - this.now()));
    return record;
  }

  track(operation, record) {
    this.operations.add(operation);
    this.operationRecords.set(operation, record);
    const settled = () => { this.operations.delete(operation); this.operationRecords.delete(operation); };
    operation.then(settled, settled);
    return operation;
  }

  async drain(predicate = () => true) {
    // Resource identity survives node retirement, caller timeout and document
    // destruction. It confers no authority to detach a replacement attachment.
    const records = new Set([...this.records.values(), ...this.operationRecords.values()].filter(record => record && predicate(record)));
    for (;;) {
      const pending = [...this.operationRecords].filter(([, record]) => records.has(record)).map(([operation]) => operation);
      await Promise.allSettled(pending);
      for (const record of records) await this.cleanup(record);
      if ([...this.operationRecords.values()].some(record => records.has(record))) continue;
      if ([...records].some(record => !record.retired && !record.cleanupDone))
        throw new Error("OBU_DIRECTORY_UPLOAD_CLEANUP_FAILED: original file input cleanup is unconfirmed");
      return;
    }
  }

  check(record) {
    if (record.error) throw record.error;
    if (record.retired && !record.documentCompleted) throw cancelled();
    if (this.now() >= record.deadlineAt) { this.cancel(record, expired()); throw record.error; }
    // Once mutation has been dispatched, input/change may legitimately navigate.
    // The backend's pre-send node check must not reject that successful write.
    if (!record.dispatched) record.check();
    this.checkCurrent(record.scope);
  }

  target(record) { const { tabId, sessionId } = record.identity; return { tabId, ...(sessionId === undefined ? {} : { sessionId }) }; }

  call(record, method, params) {
    this.check(record);
    let operation;
    try { operation = Promise.resolve(this.send(this.target(record), method, params, () => this.check(record))); }
    catch (error) { operation = Promise.reject(error); }
    return this.track(operation, record);
  }

  async within(record, operation) {
    this.check(record);
    const result = await Promise.race([operation(), record.cancellation.promise]);
    this.check(record);
    return result;
  }

  setupCall(record, method, params, receive = () => {}) {
    record.setupPending++;
    let pending;
    try { pending = this.call(record, method, params); }
    catch (error) { record.setupPending--; throw error; }
    // Observe the actual native promise, not the caller's deadline race. A late
    // installation ACK still yields its original object for exact cleanup.
    const observed = pending.then(value => {
      // Runtime exceptions may return a remote Error object. It is a cleanup
      // handle only, never the controller whose installation just failed.
      if (value.exceptionDetails && text(value.result?.objectId)) record.remoteErrorObjectIds.add(value.result.objectId);
      receive(value); return value;
    });
    observed.then(() => { record.setupPending--; this.reconcile(record); }, () => { record.setupPending--; this.reconcile(record); });
    return observed;
  }

  async prepare(record) {
    if (record.prepareStarted) throw new Error("Directory upload preparation cannot be replayed");
    record.prepareStarted = true;
    try {
      const world = await this.within(record, () => this.setupCall(record, "Page.createIsolatedWorld", {
        frameId: record.identity.frameId, worldName: DIRECTORY_UPLOAD_WORLD, grantUniveralAccess: false
      }));
      if (!Number.isSafeInteger(world.executionContextId) || world.executionContextId < 1) throw new Error("Directory upload isolated context is unavailable");
      record.contextId = world.executionContextId;
      const node = await this.within(record, () => this.setupCall(record, "DOM.resolveNode", {
        backendNodeId: record.identity.backendNodeId, executionContextId: record.contextId
      }, value => { record.nodeObjectId = value.object?.objectId; }));
      if (!text(node.object?.objectId)) throw new Error("Directory upload original node could not be resolved");
      const installed = await this.within(record, () => this.setupCall(record, "Runtime.callFunctionOn", {
        objectId: record.nodeObjectId, functionDeclaration: installDirectoryUploadController.toString(),
        arguments: [{ value: record.token }, { value: record.deadlineAt }]
      }, value => { if (!value.exceptionDetails) record.controllerObjectId = value.result?.objectId; }));
      if (installed.exceptionDetails) {
        const message = installed.exceptionDetails.exception?.description ?? installed.exceptionDetails.text;
        if (/^(?:Error: )?OBU_DIRECTORY_UPLOAD_BUSY: original node has an unsettled native submission(?:\r?\n|$)/.test(message)) throw busy();
        if (/^(?:Error: )?OBU_DIRECTORY_UPLOAD_LIMIT: renderer file input capacity reached(?:\r?\n|$)/.test(message))
          throw new Error("OBU_DIRECTORY_UPLOAD_LIMIT: renderer file input capacity reached");
        throw new Error("Directory upload renderer guard could not be installed");
      }
      if (!text(installed.result?.objectId)) throw new Error("Directory upload renderer guard could not be installed");
      const described = await this.within(record, () => this.setupCall(record, "Runtime.callFunctionOn", {
        objectId: record.controllerObjectId, functionDeclaration: "function() { return this.describe(); }", returnByValue: true
      }));
      const value = described.result?.value;
      if (described.exceptionDetails || value?.token !== record.token || typeof value.directory !== "boolean" || typeof value.multiple !== "boolean")
        throw new Error("Directory upload renderer guard identity is invalid");
      record.prepared = true;
      return record.metadata = { directory: value.directory, multiple: value.multiple };
    } catch (error) { this.cancel(record, error); throw error; }
  }

  async begin(record, directory) {
    if (!record.prepared || record.beginStarted) throw new Error("File input submission is not prepared or already dispatched");
    record.beginStarted = true;
    record.directory = directory;
    const result = await this.within(record, () => this.call(record, "Runtime.callFunctionOn", {
      objectId: record.controllerObjectId, functionDeclaration: "function(directory) { return this.begin(directory); }",
      arguments: [{ value: directory }], returnByValue: true
    }));
    if (result.exceptionDetails || result.result?.value?.token !== record.token ||
        result.result.value.phase !== (directory ? "directory-dispatched" : "ordinary-dispatched")) throw new Error("File input renderer admission failed");
    this.check(record);
  }

  async submit(record, files) {
    try {
      if (!Array.isArray(files) || files.length !== 1 || typeof files[0] !== "string" || !files[0] || files[0].includes("\0") ||
          !(/^[A-Za-z]:[\\/]/.test(files[0]) || /^\\\\[^\\/]+[\\/][^\\/]+/.test(files[0]) || files[0].startsWith("/")))
        throw new Error("Directory upload requires exactly one absolute directory path");
      await this.begin(record, true);
      this.check(record);
      const waiting = this.call(record, "Runtime.callFunctionOn", { objectId: record.controllerObjectId,
        functionDeclaration: "function() { return this.promise; }", awaitPromise: true, returnByValue: true });
      record.wait = waiting.then(response => {
        const value = response.result?.value;
        if (response.exceptionDetails || value?.token !== record.token || !["input", "cancel"].includes(value.kind) ||
            !Number.isSafeInteger(value.count) || value.count < 0) throw new Error("Directory upload completion evidence is unavailable");
        record.terminal = value;
        if (value.kind === "cancel") this.cancel(record, cancelled());
        this.reconcile(record);
        return value;
      });
      record.wait.catch(error => { record.observationError = error; this.cancel(record, error); });
      this.check(record);
      record.dispatched = true;
      record.native = this.call(record, "DOM.setFileInputFiles", { backendNodeId: record.identity.backendNodeId, files: [...files] });
      this.observeNative(record);
      await this.within(record, () => Promise.all([record.native, record.wait]));
      if (record.terminal.kind !== "input") throw cancelled();
      await this.within(record, () => record.validate());
      await this.within(record, () => this.cleanup(record));
      if (!record.cleanupDone) throw new Error("OBU_DIRECTORY_UPLOAD_CLEANUP_FAILED: original renderer guard cleanup is unconfirmed");
      return {};
    } catch (error) { this.cancel(record, error); throw error; }
    finally { record.callerDone = true; this.clearTimer(record.timer); this.reconcile(record); }
  }

  async write(record, operation) {
    try {
      await this.begin(record, false);
      this.check(record);
      record.dispatched = true;
      // There is no await between the final admission check and the original
      // ordinary mutation. It retains its own native ACK and navigation rules.
      try { record.native = this.track(Promise.resolve(operation()), record); }
      catch (error) { record.native = this.track(Promise.reject(error), record); }
      this.observeNative(record);
      const result = await this.within(record, () => record.native);
      await this.within(record, () => record.validate());
      await this.within(record, () => this.cleanup(record));
      if (!record.cleanupDone) throw new Error("OBU_DIRECTORY_UPLOAD_CLEANUP_FAILED: original renderer guard cleanup is unconfirmed");
      return result;
    } catch (error) { this.cancel(record, error); throw error; }
    finally { record.callerDone = true; this.clearTimer(record.timer); this.reconcile(record); }
  }

  observeNative(record) {
    record.native.then(() => { record.nativeSettled = true; this.reconcile(record); }, error => {
      record.nativeSettled = true; record.nativeError = error; this.cancel(record, error); this.reconcile(record);
    });
  }

  cancel(record, error = cancelled()) {
    if (record.error || record.callerDone) return;
    record.error = error;
    this.clearTimer(record.timer);
    record.cancellation.reject(error);
    this.reconcile(record);
  }

  cancelWhere(predicate, error = cancelled()) {
    for (const record of this.records.values()) if (predicate(record)) this.cancel(record, error);
  }

  reconcile(record) {
    if (record.retired) return;
    if (record.cleanupDone && (record.callerDone || record.error)) { this.retire(record); return; }
    if (record.error || record.callerDone) this.cleanup(record).catch(() => {});
  }

  cleanup(record) {
    if (record.cleanupDone || record.retired) return Promise.resolve();
    if (record.cleanupPromise) return record.cleanupPromise;
    if (record.cleanupError) return Promise.reject(record.cleanupError);
    if (record.setupPending) return Promise.resolve();
    if (record.dispatched && (record.directory ? !record.terminal : !record.nativeSettled)) return Promise.resolve();
    if (!this.canCleanup(record.identity)) return Promise.resolve();
    const operation = (async () => {
      if (record.controllerObjectId) {
        // The sole exceptional rollback is provably unsent native work. Even a
        // late begin() sees the released controller and cannot authorize send.
        const response = await this.sendCleanup(this.target(record), "Runtime.callFunctionOn", {
          objectId: record.controllerObjectId, functionDeclaration: "function(abortBeforeSend) { return this.cleanup(abortBeforeSend); }",
          arguments: [{ value: !record.dispatched }], returnByValue: true
        }, record.identity);
        if (response.exceptionDetails || response.result?.value?.token !== record.token || response.result.value.removed !== true)
          throw new Error("OBU_DIRECTORY_UPLOAD_CLEANUP_FAILED: original renderer guard remains pending");
      }
      for (const objectId of [record.controllerObjectId, record.nodeObjectId, ...record.remoteErrorObjectIds]) {
        if (objectId && this.canCleanup(record.identity)) await this.sendCleanup(this.target(record), "Runtime.releaseObject", { objectId }, record.identity);
      }
      record.cleanupDone = true;
    })();
    record.cleanupPromise = this.track(operation, record);
    operation.then(() => { record.cleanupPromise = null; this.reconcile(record); }, error => {
      record.cleanupPromise = null; record.cleanupError = error; this.cancel(record, error);
    });
    return operation;
  }

  retire(record) {
    // A destroyed document can retire its node lock while the original caller
    // is still awaiting an already-dispatched ACK. Its deadline remains live.
    if (!record.documentCompleted || record.callerDone) this.clearTimer(record.timer);
    if (this.records.get(record.key) === record) this.records.delete(record.key);
    record.retired = true;
  }

  invalidate(match, error = cancelled(), { document = false } = {}) {
    for (const record of [...this.records.values()]) {
      if (Object.keys(match).some(key => record.identity[key] !== match[key])) continue;
      // Detach alone does not cancel renderer enumeration. No remote cleanup is
      // sent here; the persistent world guard protects reattachment/new workers.
      record.documentCompleted = document && record.dispatched && (!record.directory || record.terminal?.kind === "input");
      record.invalidated = true;
      record.cleanupDone = true; // This native identity is no longer addressable.
      if (!record.documentCompleted) this.cancel(record, error);
      this.retire(record);
    }
  }
}
