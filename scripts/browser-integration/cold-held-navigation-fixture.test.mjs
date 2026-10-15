import test from "node:test";
import assert from "node:assert/strict";
import { installColdHeldNavigationProbe, checkColdHeldNavigationEvidence } from "./cold-held-navigation-fixture.mjs";
import { installColdWorldLifetimeProbe } from "./cold-world-lifetime-fixture.mjs";
import { coldNavigationHeldMove, coldNavigationInputs } from "./cold-navigation-fixture.mjs";

const clone = value => structuredClone(value), flush = () => new Promise(resolve => setImmediate(resolve));
const hit = "function hitAt(x, y) { return this.hit(x, y); }";
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function environment() {
  const attachment = {}, events = { addListener() {}, removeListener() {} }, calls = [], raw = { next: null };
  const scope = { tabId: 7, attachment, session_id: "session", turn_id: "turn", control_epoch: 1 };
  const record = { scope, state: "running", candidate: { settled: false, value: null } };
  const backend = { browserEngine: null, attachedTabs: new Set([7]), attachmentEpochs: new Map([[7, attachment]]), exportDocumentRevisions: new Map([[7, 1]]),
    pointerFeedbackReads: { pending: new Set([record]) }, privatePointerTargets: { entries: new Map() } };
  const api = { debugger: { onEvent: events, onDetach: events,
    sendCommand(...args) { calls.push({ receiver: this, args }); const next = raw.next; raw.next = null; if (next?.throw) throw next.throw; return next?.promise ?? Promise.resolve({}); },
    attach() { return Promise.resolve(); }, detach() { return Promise.resolve(); } }, tabs: { sendMessage(...args) { calls.push({ receiver: this, args, visual: true }); return raw.message ?? Promise.resolve({ ok: true }); } } };
  const target = { __integrationBackend: backend };
  installColdWorldLifetimeProbe(api, target); target.__obuColdWorldLifetime.select(7);
  const original = api.debugger.sendCommand, originalMessage = api.tabs.sendMessage;
  const options = { tabId: 7, documentId: "A-document", frameId: "root-frame", contextId: 2, contextUniqueId: "A-passive", scope: { session_id: "session", turn_id: "turn", control_epoch: 1 }, point: { x: 210, y: 166 }, holdTimeoutMs: 3000 };
  installColdHeldNavigationProbe(api, target, options);
  const controller = target.__obuColdHeldNavigation;
  const complete = () => { record.state = "complete"; record.candidate.settled = true; backend.pointerFeedbackReads.pending.delete(record); };
  const capture = async () => { const value = { result: { type: "object", objectId: "original-capture" } }; raw.next = { promise: Promise.resolve(value) };
    assert.equal(await api.debugger.sendCommand({ tabId: 7 }, "Runtime.evaluate", { expression: "(function captureDocument(view,key,token){})", contextId: 2, objectGroup: "obu-native-pointer-original-0", returnByValue: false }), value); };
  const params = () => ({ objectId: "original-capture", functionDeclaration: hit, objectGroup: "obu-native-pointer-original-0", arguments: [{ value: 210 }, { value: 166 }], returnByValue: false, awaitPromise: false, userGesture: false, silent: true });
  const finish = async () => { controller.release("finally"); await flush(); complete(); const final = controller.restore(); assert.equal(api.debugger.sendCommand, original); assert.equal(api.tabs.sendMessage, originalMessage); target.__obuColdWorldLifetime.restore(); return final; };
  return { api, target, backend, raw, calls, record, controller, capture, params, complete, finish, original };
}

test("unselected original Promise, receiver and args pass through unchanged", async () => {
  const h = environment(), native = deferred(), params = { type: "mouseMoved", x: 1, y: 2 }, receiver = h.api.debugger;
  h.raw.next = native; const actual = receiver.sendCommand({ tabId: 7 }, "Input.dispatchMouseEvent", params);
  assert.equal(actual, native.promise); assert.equal(h.calls[0].receiver, receiver); assert.equal(h.calls[0].args[2], params);
  native.resolve({ originalACK: true }); await actual;
  const visual = Promise.resolve({ ok: true }); h.raw.message = visual;
  assert.equal(h.api.tabs.sendMessage(7, { type: "OPEN_BROWSER_USE_CURSOR", receiverToken: "original" }, { documentId: "A-document" }), visual);
  await h.finish();
});

test("only exact original capture/group/context and hit args select one real successful handle", async () => {
  const h = environment(); await h.capture();
  for (const patch of [{ objectId: "foreign" }, { objectGroup: "other" }, { arguments: [{ value: 211 }, { value: 166 }] }, { returnByValue: true }, { functionDeclaration: "function other(){}" }]) {
    const native = Promise.resolve({ result: { type: "object", subtype: "node", className: "HTMLButtonElement", objectId: "unselected" } }); h.raw.next = { promise: native };
    assert.equal(h.api.debugger.sendCommand({ tabId: 7 }, "Runtime.callFunctionOn", { ...h.params(), ...patch }), native); await native;
  }
  assert.equal(h.controller.snapshot().selected, null);
  const native = deferred(), value = { result: { type: "object", subtype: "node", className: "HTMLButtonElement", objectId: "original-button" } };
  h.raw.next = native; const delivered = h.api.debugger.sendCommand({ tabId: 7 }, "Runtime.callFunctionOn", h.params());
  assert.notEqual(delivered, native.promise); native.resolve(value); await flush();
  const held = h.controller.snapshot(), common = h.target.__obuColdWorldLifetime.snapshot();
  assert.equal(held.nativePending, 0); assert.equal(held.deliveryPending, 1); assert.equal(common.pending, 0); assert.equal(common.records.at(-1).kind, "settled");
  assert.deepEqual(common.records.at(-1).value, value); assert.equal(held.records.some(row => row.kind === "delivery-settled"), false);
  h.backend.exportDocumentRevisions.set(7, 2); h.controller.release("original-B-committed"); assert.equal(await delivered, value);
  h.controller.release("duplicate"); assert.equal(h.controller.snapshot().records.filter(row => row.kind === "release").length, 1);
  const again = Promise.resolve(value); h.raw.next = { promise: again }; assert.equal(h.api.debugger.sendCommand({ tabId: 7 }, "Runtime.callFunctionOn", h.params()), again);
  await again; await h.finish();
});

test("original sync throw and async rejection identity are preserved without a held success", async () => {
  for (const synchronous of [true, false]) {
    const h = environment(); await h.capture(); const original = Error("Original native failure");
    if (synchronous) { h.raw.next = { throw: original }; assert.throws(() => h.api.debugger.sendCommand({ tabId: 7 }, "Runtime.callFunctionOn", h.params()), error => error === original); }
    else { h.raw.next = { promise: Promise.reject(original) }; await assert.rejects(h.api.debugger.sendCommand({ tabId: 7 }, "Runtime.callFunctionOn", h.params()), error => error === original); }
    await flush(); assert.equal(h.controller.snapshot().records.some(row => row.kind === "held"), false); await h.finish();
  }
});

test("unqualified native null or exception reply remains the original value and is never converted to success", async () => {
  for (const value of [{ result: { type: "object", subtype: "null", value: null } }, { exceptionDetails: { exception: { objectId: "original-exception" } } }]) {
    const h = environment(); await h.capture(); h.raw.next = { promise: Promise.resolve(value) };
    assert.equal(await h.api.debugger.sendCommand({ tabId: 7 }, "Runtime.callFunctionOn", h.params()), value);
    assert.equal(h.controller.snapshot().deliveryPending, 0); assert.equal(h.controller.snapshot().records.filter(row => row.kind === "unqualified-reply").length, 1); await h.finish();
  }
});

test("early restore records sticky release intent but cannot remove a pending original observer", async () => {
  const h = environment(); await h.capture(); const original = deferred(), value = { result: { subtype: "node", className: "HTMLButtonElement", objectId: "late-native-button" } };
  h.raw.next = original; const delivered = h.api.debugger.sendCommand({ tabId: 7 }, "Runtime.callFunctionOn", h.params());
  assert.throws(() => h.controller.restore(), /remain pending/); assert.equal(h.controller.snapshot().released, true);
  assert.notEqual(h.api.debugger.sendCommand, h.original); original.resolve(value); assert.equal(await delivered, value); await flush();
  assert.equal(h.controller.snapshot().deliveryPending, 0); assert.equal(h.controller.snapshot().watchdog, false); await h.finish();
});

test("cleanup before any selected call restores both observers without inventing a hit", async () => {
  const h = environment(); h.complete(); const result = await h.finish(); assert.equal(result.selected, null); assert.equal(result.nativeAndDeliveryDistinct, false);
});

function oracle() {
  const group = "obu-native-pointer-original-0", scope = { session_id: "session", turn_id: "turn", control_epoch: 1 }, value = { result: { subtype: "node", className: "HTMLButtonElement", objectId: "A-hit" } };
  const state = { engineAbsent: true, attached: true, sameAttachment: true, revision: 1, pointerPending: 1, selectedRetained: true, selectedState: "running", selectedSettled: false, selectedValue: null, privateLeases: 0 };
  const records = [], append = row => { const r = { sequence: records.length + 1, worldSequence: 5, ...row }; records.push(r); return r; };
  append({ kind: "call", method: "Runtime.evaluate", params: { contextId: 2, objectGroup: group }, target: { tabId: 7 } });
  append({ kind: "native-settled", call: 1, ok: true, value: { result: { objectId: "A-wrapper" } } });
  append({ kind: "call", method: "Runtime.callFunctionOn", target: { tabId: 7 }, params: { functionDeclaration: hit, objectId: "A-wrapper", objectGroup: group, arguments: [{ value: 210 }, { value: 166 }], returnByValue: false }, capture: { objectId: "A-wrapper", group, contextId: 2, invocation: 1, ack: 2 } });
  append({ kind: "native-settled", call: 3, ok: true, value }); append({ kind: "held", call: 3, nativeAlreadyFulfilled: true });
  const base = { selected: 3, tabId: 7, documentId: "A-document", contextUniqueId: "A-passive", point: { x: 210, y: 166 }, initialRevision: 1, records, state, released: false, deliveryPending: 1 };
  const held = clone(base), bCommitted = clone(base); bCommitted.state.revision = 2;
  append({ kind: "release", reason: "original-B-committed", worldSequence: 11 });
  append({ kind: "delivery-settled", call: 3, ok: true, value, sameOriginalValue: true, worldSequence: 11 });
  const final = { ...clone(base), restored: true, released: true, nativePending: 0, messagePending: 0, deliveryPending: 0, nativeAndDeliveryDistinct: true,
    watchdog: false, overflow: false, recordingErrors: 0, state: { ...state, revision: 2, pointerPending: 0, selectedRetained: false, selectedSettled: true, selectedState: "complete" } };
  const common = [], add = row => { const r = { sequence: common.length + 1, ...row }; common.push(r); return r; }, command = (method, params, response = {}) => { const c = add({ kind: "call", method, params }); add({ kind: "settled", invocation: c.sequence, ok: true, value: response }); return c; };
  const inputs = coldNavigationInputs("value", { heldReadNavigation: true });
  command("Page.navigate", { url: "A" }); command("Input.dispatchMouseEvent", inputs[0]); command("Input.dispatchMouseEvent", inputs[1]);
  command("Runtime.callFunctionOn", clone(records[2].params), value); command("Page.navigate", { url: "B" });
  add({ kind: "event", source: { tabId: 7 }, method: "Page.frameNavigated", params: { frame: { loaderId: "B-loader" } } });
  command("Runtime.releaseObjectGroup", { objectGroup: group }); for (const params of inputs.slice(2)) command("text" in params ? "Input.insertText" : "Input.dispatchMouseEvent", params);
  return { tabId: 7, native: { records: common }, phases: [{ contexts: { worlds: [{ id: 2, uniqueId: "A-passive" }] }, after: { geometry: { button: { x: 46, y: 134, width: 280, height: 64 } } } },
    { before: { nativeDocumentId: "B-document" }, tree: { frameTree: { frame: { loaderId: "B-loader" } } } }],
    heldRead: { held, bCommitted, input: { ok: true, params: clone(coldNavigationHeldMove), checkpointWorldSequence: 8 }, final, drained: clone(final) } };
}

test("held oracle requires original native success, same delayed value, revoked candidate and release before B input", () => {
  checkColdHeldNavigationEvidence(oracle());
  for (const mutate of [d => { d.heldRead.final.records[3].ok = false; }, d => { d.heldRead.final.records[6].sameOriginalValue = false; },
    d => { d.heldRead.bCommitted.state.revision = 1; }, d => { d.heldRead.held.released = true; }, d => { d.heldRead.drained.state.selectedValue = { x: 1, y: 2, width: 3, height: 4 }; },
    d => { d.heldRead.drained.state.selectedRetained = true; }, d => { d.heldRead.input.ok = false; }, d => { d.heldRead.final.watchdog = true; },
    d => { const release = d.native.records.find(row => row.method === "Runtime.releaseObjectGroup"); d.native.records.find(row => row.invocation === release.sequence).ok = false; },
    d => { d.heldRead.final.records[6].worldSequence = 9999; }, d => { d.heldRead.input.checkpointWorldSequence = 9999; }
  ]) { const value = oracle(); mutate(value); assert.throws(() => checkColdHeldNavigationEvidence(value)); }
});

test("late old object read without objectGroup and old target delivered to B are rejected", () => {
  for (const mutate of [d => { const records = d.native.records, sequence = records.length + 1;
      records.push({ sequence, kind: "call", target: { tabId: 7 }, method: "DOM.describeNode", params: { objectId: "A-hit" } },
        { sequence: sequence + 1, kind: "settled", invocation: sequence, ok: true, value: { node: { backendNodeId: 99, nodeName: "BUTTON" } } }); },
    d => { const p = d.heldRead.final; p.records.push({ sequence: p.records.length + 1, kind: "visual-call", options: { documentId: "B-document" }, message: { type: "OPEN_BROWSER_USE_CURSOR", x: 210, y: 166, feedbackSequence: 1 } }); },
    d => { const p = d.heldRead.final; p.records.push({ sequence: p.records.length + 1, kind: "visual-call", options: { documentId: "B-document" }, message: { type: "OPEN_BROWSER_USE_TARGET_RECT", feedbackSequence: 9, targetRect: d.phases[0].after.geometry.button } }); }
  ]) { const value = oracle(); mutate(value); assert.throws(() => checkColdHeldNavigationEvidence(value)); }
});
