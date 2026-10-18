import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import vm from "node:vm";
import { humanIMEText, installManagedIMEObserver, assertManagedIMEStage, assertManagedIMELedger } from "./managed-human-ime.mjs";

const scope = { leaseId: "original", generation: 2 };
const event = (type, data, value = data) => ({ type, data, value, target: "human-input", trusted: type !== "compositionend", isComposing: type === "input" });
const observe = events => ({ active: true, overflow: false, events: events.map((row, i) => ({ ...row, sequence: i + 1 })) });
const preedit = text => [event("compositionupdate", text), event("beforeinput", text), event("input", text)];
const textRequest = (id, sequence) => ({ id, sequence, connection: 1, operation: "humanInput", ...scope,
  input: { type: "text", textBytes: Buffer.byteLength(humanIMEText), textSHA256: createHash("sha256").update(humanIMEText).digest("hex") } });
const reply = row => ({ type: "response", id: row.id, connection: row.connection, result: { inputReceipt: { ...scope, sequence: row.sequence, acknowledged: true } } });
function proof(phase) {
  const text = phase === "commit" ? humanIMEText : phase === "cancel" ? "" : "中文组合";
  const prefix = phase === "preedit" ? [] : [event("compositionstart", ""), ...preedit("中文组合")];
  const suffix = phase === "preedit" ? [event("compositionstart", ""), ...preedit(text)] : [...preedit(text), event("compositionend", text, "")];
  const commands = phase === "commit" ? [textRequest(10, 4)] : [];
  const draft = "Original draft";
  return { phase, text, scope, viewerBefore: observe(prefix), viewerAfter: observe([...prefix, ...suffix]), commands, replies: commands.map(reply),
    before: { documentId: "document", draft, state: { documentToken: "token", eventOverflow: false, events: [] } },
    after: { documentId: "document", draft: draft + (phase === "commit" ? text : ""), state: { documentToken: "token", eventOverflow: false,
      events: phase === "commit" ? [{ type: "beforeinput", trusted: true, data: text }, { type: "input", trusted: true, data: text }] : [] } },
    expectedDraft: draft + (phase === "commit" ? text : ""),
    nativeCommand: { method: phase === "commit" ? "Input.insertText" : "Input.imeSetComposition", params: phase === "commit" ? { text } : { text, selectionStart: text.length, selectionEnd: text.length },
      startedAt: 100, acknowledgedAt: 110, settledAt: 110, result: {} } };
}

test("IME proof retains native compositionend=false while requiring original ACK and surrounding trusted events", () => {
  for (const phase of ["preedit", "commit", "cancel"]) assert.doesNotThrow(() => assertManagedIMEStage(proof(phase)));
  const commit = proof("commit"); assert.equal(commit.viewerAfter.events.at(-1).trusted, false);
});

test("candidate and cancellation never become remote commands or task mutations", () => {
  for (const phase of ["preedit", "cancel"]) for (const mutate of [
    value => { value.commands.push(textRequest(11, 5)); },
    value => { value.after.draft += "unexpected"; },
    value => { value.after.state.events.push({ type: "input", trusted: true }); },
    value => { value.viewerAfter.events.find(row => row.type === "input").trusted = false; },
    value => { value.nativeCommand.acknowledgedAt = undefined; },
    value => { value.nativeCommand.params.text = "different"; }
  ]) { const value = proof(phase); mutate(value); assert.throws(() => assertManagedIMEStage(value)); }
});

test("commit rejects duplicate/lost/stale receipts, changed document and event provenance", () => {
  for (const mutate of [
    value => { value.commands.push(structuredClone(value.commands[0])); },
    value => { value.commands = []; }, value => { value.replies = []; },
    value => { value.replies[0].result.inputReceipt.generation++; },
    value => { value.after.documentId = "new"; }, value => { value.after.state.documentToken = "new"; },
    value => { value.after.state.events.push({ type: "paste", trusted: true }); },
    value => { value.viewerAfter.events.at(-1).trusted = true; },
    value => { value.viewerAfter.events[0].type = "compositionupdate"; },
    value => { value.nativeCommand.error = "not acknowledged"; }
  ]) { const value = proof("commit"); mutate(value); assert.throws(() => assertManagedIMEStage(value)); }
});

test("whole-lease text ledger preserves identical consecutive commits and rejects late extra text between sampling windows", () => {
  const commands = [textRequest(10, 4), textRequest(11, 5)], replies = commands.map(reply);
  const value = { commands, replies, scope, commitRequestIds: [10, 11] };
  assert.equal(assertManagedIMELedger(value).textCount, 2);
  for (const mutate of [
    row => { row.commands.push(textRequest(20, 12)); },
    row => { row.commands.pop(); }, row => { row.commands[1].generation++; },
    row => { row.commands[1].sequence++; }, row => { row.replies[1].result.inputReceipt.acknowledged = false; },
    row => { row.commitRequestIds.reverse(); }
  ]) { const changed = structuredClone(value); mutate(changed); assert.throws(() => assertManagedIMELedger(changed)); }
});

test("passive IME observer copies bounded native metadata and removes exact listeners without any input or clipboard API", () => {
  const listeners = new Map(); const document = {
    addEventListener(type, listener, options) { assert.equal(options.passive, true); listeners.set(type, listener); },
    removeEventListener(type, listener) { assert.equal(listeners.get(type), listener); listeners.delete(type); }
  };
  const context = vm.createContext({ document, structuredClone }); vm.runInContext(`(${installManagedIMEObserver.toString()})()`, context);
  const emit = (type, id = "human-input", data = "中文") => listeners.get(type)({ target: { id, value: data, selectionStart: 2, selectionEnd: 2 }, isTrusted: type !== "compositionend", data, defaultPrevented: false });
  emit("compositionstart", "other"); assert.equal(context.__managedIMEObservation.snapshot().events.length, 0);
  emit("compositionend"); const snapshot = context.__managedIMEObservation.snapshot(); assert.equal(snapshot.events[0].trusted, false);
  snapshot.events[0].data = "changed"; assert.equal(context.__managedIMEObservation.snapshot().events[0].data, "中文");
  for (let i = 0; i < 256; i++) emit("compositionupdate");
  assert.equal(context.__managedIMEObservation.snapshot().events.length, 256); assert.equal(context.__managedIMEObservation.snapshot().overflow, true);
  assert.equal(context.__managedIMEObservation.stop().active, false); assert.equal(listeners.size, 0);
});
