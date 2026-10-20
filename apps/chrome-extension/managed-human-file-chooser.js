import { DirectoryUploadRegistry } from "./browser-directory-upload.js";

const fail = (code, message) => new Error(`OBU_HUMAN_FILE_${code}: ${message}`);
const id = value => typeof value === "string" && /^[\x21-\x7e]{1,128}$/.test(value);
function fields(value, required, optional = []) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw fail("INVALID", "invalid chooser request");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== "string" || ![...required, ...optional].includes(key) ||
      !("value" in descriptors[key])) || required.some(key => !Object.hasOwn(descriptors, key)))
    throw fail("INVALID", "invalid chooser fields");
}
export function validateHumanFileRequest(value, operation) {
  const required = ["leaseId", "generation", "chooserId"];
  if (operation !== "cancel") required.push("transferId");
  if (operation === "commit") required.push("files");
  if (!["begin", "commit", "cancel"].includes(operation)) throw fail("INVALID", "unknown chooser operation");
  fields(value, required, operation === "cancel" ? ["transferId"] : []);
  if (!id(value.leaseId) || !id(value.chooserId) || !Number.isSafeInteger(value.generation) || value.generation < 1 ||
      (Object.hasOwn(value, "transferId") && !id(value.transferId))) throw fail("INVALID", "invalid chooser identity");
  if (operation === "commit") {
    if (!Array.isArray(value.files) || value.files.length < 1 || value.files.length > 16) throw fail("INVALID", "invalid file count");
    const entries = Object.getOwnPropertyDescriptors(value.files);
    if (Reflect.ownKeys(entries).length !== value.files.length + 1) throw fail("INVALID", "invalid file list");
    for (let i = 0; i < value.files.length; i++) {
      const path = entries[i]?.value;
      if (typeof path !== "string" || !path || path.length > 32768 || /[\0\r\n]/.test(path) ||
          /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(path) ||
          !(/^[A-Za-z]:[\\/]/.test(path) || /^\\\\[^\\/]+[\\/][^\\/]+/.test(path) || path.startsWith("/")))
        throw fail("INVALID", "only server-owned absolute file paths can be submitted");
    }
  }
  return value;
}
const tuple = (record, transfer = record.transferId) => ({ leaseId: record.info.leaseId, generation: record.info.generation,
  chooserId: record.info.chooserId, ...(transfer === undefined ? {} : { transferId: transfer }) });

// One human attachment owns interception, original node reservations and their
// actual native Promises. Cancellation retires intent; it never clears files or
// invents a browser chooser-cancel event.
export class ManagedHumanFileChoosers {
  constructor({ leaseId, tabId, capture, assertCurrent, addressable, retirement, attached, send,
    sendCleanup = (_proof, sessionId, method, params) => send(sessionId, method, params), notify, onFailure, assertIdle }) {
    Object.assign(this, { leaseId, tabId, capture, assertCurrent, addressable, retirement, attached, send, notify, onFailure, assertIdle });
    this.current = null; this.records = new Set(); this.operations = new Set(); this.sessions = new Map(); this.revoked = false;
    this.attachment = Object.freeze({});
    this.registry = new DirectoryUploadRegistry({
      send: (target, method, params, check) => this.send(target.sessionId, method, params, check),
      sendFileInput: (target, params, check, markDispatched) => {
        const original = this.current;
        if (!original?.info.directory || !original.submitted || original.sessionId !== target.sessionId ||
            original.reservation.identity.backendNodeId !== params.backendNodeId)
          throw fail("STALE", "original directory submission is unavailable");
        // Registry enumeration owns its native Promise, while this exact human
        // choice still requires the normal final document/hint admission.
        return this.send(target.sessionId, "DOM.setFileInputFiles", params, () => {
          check(); this.check(original); markDispatched();
        }, original.proof);
      },
      sendCleanup: (target, method, params, identity) => sendCleanup(identity.proof, target.sessionId, method, params),
      checkCurrent: scope => {
        if (scope.kind !== "human" || scope.leaseId !== leaseId || scope.tabId !== tabId) throw fail("STALE", "foreign chooser owner");
      },
      canCleanup: identity => this.attached() && this.addressable(identity.proof)
    });
  }
  track(promise) {
    const actual = Promise.resolve(promise); this.operations.add(actual);
    actual.then(() => this.operations.delete(actual), () => this.operations.delete(actual)); return actual;
  }
  enable(sessionId, check) {
    if (this.sessions.has(sessionId)) throw fail("STALE", "chooser interception cannot be enabled twice");
    const entry = { sessionId, enabled: false }; this.sessions.set(sessionId, entry);
    entry.enable = this.track(this.send(sessionId, "Page.setInterceptFileChooserDialog", { enabled: true }, () => {
      if (this.revoked) throw fail("STALE", "chooser interception was withdrawn"); check();
    }).then(() => { entry.enabled = true; }));
    return entry.enable;
  }
  info() { return !this.revoked && !this.current?.retired && this.current?.ready ? this.current.info : null; }
  hasPending() { return Boolean(!this.revoked && this.current && !this.current.retired); }
  check(record) {
    if (this.revoked || this.current !== record || record.retired || Date.now() >= record.deadlineAt)
      throw fail("STALE", "original chooser is no longer available");
    this.assertCurrent(record.proof);
  }
  observe(sessionId, params) {
    if (this.revoked) return;
    try {
      if (!this.sessions.get(sessionId)?.enabled || !id(params?.frameId) ||
          !Number.isSafeInteger(params.backendNodeId) || params.backendNodeId < 1 ||
          !["selectSingle", "selectMultiple"].includes(params.mode)) throw fail("UNSUPPORTED", "original file input identity is unavailable");
      if (this.records.size >= 64) throw fail("BUSY", "original chooser cleanup capacity reached");
      if (this.current) this.retire(this.current);
      const proof = this.capture({ sessionId, frameId: params.frameId });
      const record = { proof, sessionId, deadlineAt: Date.now() + 1200000, ready: false, retired: false,
        info: Object.freeze({ leaseId: this.leaseId, generation: proof.generation, chooserId: crypto.randomUUID(),
          multiple: params.mode === "selectMultiple", ...(proof.source ? { source: proof.source } : {}) }) };
      this.current = record; this.records.add(record);
      record.timer = setTimeout(() => this.retire(record), Math.max(1, record.deadlineAt - Date.now()));
      record.timer.unref?.();
      record.reservation = this.registry.reserve({
        identity: { tabId: this.tabId, attachment: this.attachment, sessionId, backendNodeId: params.backendNodeId,
          frameId: params.frameId, proof },
        scope: { kind: "human", leaseId: this.leaseId, tabId: this.tabId },
        deadlineAt: record.deadlineAt, check: () => this.check(record), validate: async () => {}
      });
      record.reservation.timer?.unref?.();
      record.preparation = this.track((async () => {
        const metadata = await this.registry.prepare(record.reservation);
        this.check(record);
        if (!metadata.directory && metadata.multiple !== record.info.multiple)
          throw fail("UNSUPPORTED", "original file input mode changed");
        // Opening's selection mode cannot distinguish a directory from an
        // ordinary multiple input. Only the original resolved node decides.
        record.info = Object.freeze({ ...record.info, multiple: metadata.multiple, directory: metadata.directory });
        record.ready = true; this.notify();
      })());
      record.preparation.catch(error => { this.retire(record); if (!this.revoked) this.onFailure(error); });
      this.notify();
    } catch (error) { this.onFailure(error); }
  }
  lookup(value, operation) {
    validateHumanFileRequest(value, operation);
    const record = this.current, info = record?.info;
    if (!info || value.leaseId !== info.leaseId || value.generation !== info.generation || value.chooserId !== info.chooserId)
      throw fail("STALE", "original chooser tuple does not match");
    this.check(record);
    if (!record.ready) throw fail("BUSY", "original node preparation is pending");
    return record;
  }
  begin(value) {
    const record = this.lookup(value, "begin");
    this.assertIdle(record.proof);
    if (record.transferId) throw fail("STALE", "original chooser was already claimed");
    record.transferId = value.transferId;
    return Object.freeze(tuple(record));
  }
  commit(value) {
    const record = this.lookup(value, "commit");
    this.assertIdle(record.proof);
    if (record.transferId !== value.transferId || record.submitted) throw fail("STALE", "original chooser claim is unavailable");
    if ((record.info.directory || !record.info.multiple) && value.files.length !== 1)
      throw fail("INVALID", record.info.directory ? "original directory input requires one server-owned root" : "original input accepts one file");
    const files = [...value.files]; record.submitted = true;
    const actual = this.track((async () => {
      let native;
      try {
        if (record.info.directory) {
          // A directory ACK only starts enumeration. Preserve the registry's
          // original trusted input/cancel and cleanup result, including errors.
          await this.registry.submit(record.reservation, files);
        } else {
          try {
            await this.registry.write(record.reservation, () => {
              this.check(record);
              native = this.send(record.sessionId, "DOM.setFileInputFiles",
                { backendNodeId: record.reservation.identity.backendNodeId, files }, () => this.check(record), record.proof);
              return native;
            });
          } catch (error) {
            // Ordinary files retain the original native ACK after navigation.
            // This fallback must never stand in for directory enumeration.
            if (!native) throw error;
            await native;
          }
        }
      } finally { this.retire(record); }
      await this.registry.drain(entry => entry === record.reservation);
      return Object.freeze({ ...tuple(record), acknowledged: true });
    })());
    actual.catch(error => { if (!this.revoked) this.onFailure(error); });
    return actual;
  }
  async cancel(value) {
    const record = this.lookup(value, "cancel");
    if (value.transferId !== undefined && value.transferId !== record.transferId)
      throw fail("STALE", "original transfer claim does not match");
    if (record.submitted) throw fail("STALE", "a submitted file operation cannot be cancelled or replayed");
    const response = Object.freeze({ leaseId: record.info.leaseId, generation: record.info.generation,
      chooserId: record.info.chooserId, ...(value.transferId === undefined ? {} : { transferId: value.transferId }), cancelled: true });
    this.retire(record); await this.registry.drain(entry => entry === record.reservation); return response;
  }
  retire(record) {
    if (!record || record.retired) return;
    record.retired = true;
    clearTimeout(record.timer);
    if (record.reservation) this.registry.cancel(record.reservation, fail("STALE", "original chooser intent was retired"));
    if (this.current === record) this.current = null;
    this.notify();
  }
  retireEpoch(epoch) { for (const record of this.records) if (record.proof.epoch === epoch) this.retire(record); }
  recheck() {
    for (const record of this.records) {
      const retired = this.retirement(record.proof);
      if (retired) this.registry.invalidate({ proof: record.proof }, fail("STALE", "original native identity ended"), { document: retired === "document" });
      if (!record.retired) { try { this.check(record); } catch { this.retire(record); } }
      if (record.retired && record.reservation?.retired) this.records.delete(record);
    }
  }
  revoke() { this.revoked = true; for (const record of this.records) this.retire(record); }
  async drain() {
    while (this.operations.size) await Promise.allSettled([...this.operations]);
    this.recheck(); await this.registry.drain();
  }
  async close() {
    this.revoke(); await this.drain();
    for (const entry of this.sessions.values()) {
      await Promise.allSettled([entry.enable]);
      if (entry.enabled && !entry.disabled && this.attached(entry.sessionId)) {
        await this.send(entry.sessionId, "Page.setInterceptFileChooserDialog", { enabled: false });
        entry.disabled = true;
      }
    }
  }
}
