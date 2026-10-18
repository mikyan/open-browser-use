import { ManagedHumanDialogDeadline } from "./managed-human-budget.js";

const encoder = new TextEncoder();
const fail = (code, message) => new Error(`OBU_HUMAN_DIALOG_${code}: ${message}`);
const types = ["alert", "confirm", "prompt"];
function object(value, required, optional = []) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw fail("INVALID", "invalid dialog fields");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== "string" || ![...required, ...optional].includes(key) || !("value" in descriptors[key])) ||
      required.some(key => !Object.hasOwn(descriptors, key))) throw fail("INVALID", "invalid dialog fields");
}
function text(value, limit = 8192, empty = true) {
  if (typeof value !== "string" || (!empty && !value.length) || value.length > limit ||
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value) || encoder.encode(value).length > limit)
    throw fail("INVALID", "dialog text exceeds its Unicode or UTF-8 bounds");
}

export function validateHumanDialogResponse(value) {
  object(value, ["leaseId", "generation", "dialogId", "accept"], ["promptText"]);
  text(value.leaseId, 128, false); text(value.dialogId, 128, false);
  if (/[\x00-\x1f\x7f]/.test(value.leaseId) || /[\x00-\x1f\x7f]/.test(value.dialogId)) throw fail("INVALID", "invalid dialog identity text");
  if (!Number.isSafeInteger(value.generation) || value.generation < 1 || typeof value.accept !== "boolean")
    throw fail("INVALID", "invalid dialog decision");
  if (value.promptText !== undefined) { text(value.promptText); if (!value.accept) throw fail("INVALID", "a cancelled dialog cannot receive prompt text"); }
  return value;
}

// The original native attachment owns these records, not the serial input lane.
// Chrome supplies no dialog ID: each opening gets a private object and one claim.
export class ManagedHumanDialogs {
  constructor({ leaseId, capture, assertCurrent, attached, destroyed, send, notify, onFailure,
    onOpened = () => {}, onClosed = () => {}, timing }) {
    Object.assign(this, { leaseId, capture, assertCurrent, attached, destroyed, send, notify, onFailure, onOpened, onClosed, timing });
    this.current = null; this.records = new Set(); this.operations = new Set(); this.captures = new Set(); this.revoked = false;
  }
  info() { const record = this.current; return !this.revoked && !this.ambiguous && record?.open && !record.retired ? record.info : null; }
  hasOpen() { return Boolean(this.current?.open); }
  changed() { this.notify(); }
  recheck() {
    const record = this.current;
    if (this.revoked || this.ambiguous || !record?.open || record.retired || !record.proof) return;
    try { this.assertCurrent(record.proof); }
    catch (error) { this.onFailure(error); }
  }
  observe(method, params) {
    if (method === "Page.javascriptDialogClosed") {
      if (this.current && typeof this.current.frameId === "string" && this.current.frameId && params?.frameId === this.current.frameId) {
        const original = this.current;
        original.open = false; original.deadline?.account(); original.deadline?.finish(); this.onClosed(original.proof, original);
        this.prune(original); this.current = null; this.changed();
      }
      return;
    }
    if (method !== "Page.javascriptDialogOpening") return;
    if (this.current?.open) {
      // handleJavaScriptDialog has no frame/dialog parameter. An unpaired new
      // opening makes even cancellation through the old record unsafe.
      this.ambiguous = true; this.changed();
      this.onFailure(fail("UNCONFIRMED", "another dialog opened without the original close event"));
      return;
    }
    const record = { frameId: params?.frameId, open: true, claimed: false, dispatched: false, acknowledged: false, pending: null, info: null };
    this.current = record; this.records.add(record);
    if (this.records.size >= 64) {
      // Reserve the final bounded slot for the unhandled native object. Do not
      // start an unbounded chain of cancellations while older ACKs are stalled.
      record.capacityBlocked = true;
      this.onFailure(fail("UNCONFIRMED", "unsettled native dialog capacity exceeded")); return;
    }
    try {
      text(record.frameId, 128, false);
      if (!types.includes(params.type)) throw fail("UNSUPPORTED", "only alert, confirm and prompt support human responses");
      text(params.message);
      const defaultPrompt = params.type === "prompt" ? params.defaultPrompt === undefined ? "" : params.defaultPrompt : undefined;
      if (defaultPrompt !== undefined) text(defaultPrompt);
      const metadata = Object.freeze({ type: params.type, message: params.message, ...(defaultPrompt !== undefined ? { defaultPrompt } : {}) });
      // The deadline belongs to the original Opening, not a later policy read
      // or publication. capture must freeze its native fence synchronously.
      record.deadline = new ManagedHumanDialogDeadline({ timing: this.timing,
        onExpire: error => { if (this.current === record && !this.revoked && !record.retired) this.onFailure(error); } });
      const proof = this.capture(params);
      if (proof?.pending && typeof proof.pending.then === "function" && proof.epoch) {
        record.captureEpoch = proof.epoch;
        const actual = Promise.resolve(proof.pending).then(value => this.bind(record, metadata, value));
        record.capture = actual;
        this.captures.add(actual);
        actual.then(() => { this.captures.delete(actual); record.capture = null; this.prune(record); }, error => {
          this.captures.delete(actual); record.capture = null; this.prune(record);
          // Observed retirement already withdrew this proof and owns its one
          // original cancellation. A late read failure cannot revoke a newer
          // document, and does not settle that cancellation's native Promise.
          if (this.current === record && record.open && !record.retired && !this.revoked) { this.cancel(record); this.onFailure(error); }
        });
      } else this.bind(record, metadata, proof);
    } catch (error) {
      // The source was already matched to this original attachment. Unsupported
      // metadata grants no human decision; cleanup can only cancel that dialog.
      record.info = null; this.cancel(record); this.onFailure(error);
    }
  }
  bind(record, metadata, proof) {
    // End or Closed can win while the original browser-side proof read awaits.
    // They revoke publication immediately but retain that actual read in drain.
    if (this.current !== record || !record.open || this.ambiguous || record.retired || record.claimed) return;
    if (this.revoked) { this.cancel(record); return; }
    if (!proof || !Number.isSafeInteger(proof.generation) || proof.generation < 1) throw fail("UNSUPPORTED", "the original document proof is unavailable");
    if (record.captureEpoch && proof.epoch !== record.captureEpoch) throw fail("STALE", "proof read returned a different original document owner");
    if (!record.deadline.account()) throw fail("STALE", "the original dialog deadline ended before proof publication");
    this.assertCurrent(proof);
    record.proof = proof;
    record.info = Object.freeze({ leaseId: this.leaseId, generation: proof.generation, dialogId: crypto.randomUUID(), ...metadata });
    this.onOpened(proof, record);
    if (this.revoked) this.cancel(record);
    else this.changed();
  }
  respond(value) {
    try {
      validateHumanDialogResponse(value);
      const record = this.current, info = record?.info;
      if (this.revoked || this.ambiguous || !record?.open || record.retired || record.claimed || !info ||
          value.leaseId !== info.leaseId || value.generation !== info.generation || value.dialogId !== info.dialogId)
        throw fail("STALE", "the original dialog decision is no longer available; no response was sent");
      if (value.promptText !== undefined && info.type !== "prompt") throw fail("INVALID", "prompt text requires a prompt dialog");
      if (!record.deadline.account()) throw fail("STALE", "original dialog deadline ended; the human choice was not submitted");
      try { this.assertCurrent(record.proof); }
      catch {
        const reason = fail("STALE", "original dialog authority ended; the human choice was not submitted");
        this.onFailure(reason); throw reason;
      }
      return this.dispatch(record, { accept: value.accept, ...(value.promptText !== undefined ? { promptText: value.promptText } : {}) }, true);
    } catch (error) { return Promise.reject(error); }
  }
  dispatch(record, decision, human) {
    record.claimed = true; this.changed();
    let withdrawn = false;
    const command = { ...decision };
    const actual = Promise.resolve().then(() => this.send(command, () => {
      if (this.ambiguous) throw fail("STALE", "original native dialog identity became ambiguous; no response was sent");
      if (!this.attached() || this.current !== record || !record.open)
        throw fail("STALE", "original native dialog closed before dispatch; no response was sent");
      if (human) {
        try {
          if (this.revoked || !record.deadline.account()) throw fail("STALE", "human dialog authority ended");
          this.assertCurrent(record.proof);
        }
        catch { withdrawn = true; command.accept = false; delete command.promptText; }
      }
      record.dispatched = true;
    })).then(() => {
      record.acknowledged = true;
      if (withdrawn) { record.withdrawn = true; throw fail("STALE", "human choice was withdrawn; only original dialog cancellation was acknowledged"); }
      return human ? Object.freeze({ leaseId: record.info.leaseId, generation: record.info.generation,
        dialogId: record.info.dialogId, acknowledged: true }) : undefined;
    }, error => {
      if (record.dispatched) {
        record.nativeError = error;
        throw fail("UNCONFIRMED", "original native dialog response failed; do not replay it");
      }
      throw error;
    });
    record.pending = actual; this.operations.add(actual);
    actual.then(() => this.settled(record, actual), error => { this.settled(record, actual); if (record.nativeError || record.withdrawn) this.onFailure(error); });
    return actual;
  }
  settled(record, actual) { this.operations.delete(actual); record.pending = null; this.prune(record); }
  prune(record) { if (!record.pending && !record.capture && (!record.open || record.acknowledged || this.destroyed())) this.records.delete(record); }
  cancel(record) {
    if (this.ambiguous || !record?.open || record.claimed || record.capacityBlocked || !this.attached()) return;
    void this.dispatch(record, { accept: false }, false).catch(() => {});
  }
  revoke() {
    this.revoked = true;
    for (const record of this.records) record.deadline?.finish();
    this.current?.deadline?.finish(); this.cancel(this.current);
  }
  retire(epoch) {
    if (this.current?.proof?.epoch === epoch || this.current?.captureEpoch === epoch) { this.current.retired = true; this.current.deadline?.finish(); this.cancel(this.current); }
  }
  async drain(epoch) {
    const work = () => epoch === undefined ? [...this.operations, ...this.captures] :
      [...this.records].filter(record => record.proof?.epoch === epoch || record.captureEpoch === epoch).flatMap(record => [record.pending, record.capture].filter(Boolean));
    while (work().length) await Promise.allSettled(work());
    this.assertDrained(epoch);
    for (const record of this.records) this.prune(record);
  }
  assertDrained(epoch) {
    if (epoch === undefined && (this.operations.size || this.captures.size)) throw fail("CLEANUP_INCOMPLETE", "original native dialog responses or proof reads are still pending");
    if (this.ambiguous && !this.destroyed()) throw fail("CLEANUP_INCOMPLETE", "ambiguous original native dialog requires confirmed target destruction");
    for (const record of this.records) {
      if (epoch !== undefined && record.proof?.epoch !== epoch && record.captureEpoch !== epoch) continue;
      if (record.pending || record.capture) throw fail("CLEANUP_INCOMPLETE", "original native dialog work is still pending");
      if (record.open && !record.acknowledged && !this.destroyed())
        throw fail("CLEANUP_INCOMPLETE", "original native dialog cleanup is unconfirmed");
    }
  }
  close() { this.revoke(); return this.drain(); }
}
