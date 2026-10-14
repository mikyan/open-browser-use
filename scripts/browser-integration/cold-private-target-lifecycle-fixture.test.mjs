import test from "node:test";
import assert from "node:assert/strict";
import { NativeInputTracker } from "../../apps/chrome-extension/browser-input-adapter.js";
import { installColdPrivateTargetLifecycleProbe, checkColdPrivateTargetTrace, checkColdPrivateTargetBusiness, checkColdPrivateTargetOwnership, checkColdPrivateTargetHeldInputRisk, checkColdPrivateTargetWorkerControl, coldPrivateTargetCases, createColdPrivateTargetFixtures } from "./cold-private-target-lifecycle-fixture.mjs";

const ledgerKey = "TEST_PRIVATE_LEDGER";
const event = () => { const listeners = new Set(); return { listeners, addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn), emit: (...args) => { for (const fn of listeners) fn(...args); } }; };
const tick = async () => { await Promise.resolve(); await Promise.resolve(); };
function fixture({ native = () => Promise.resolve({}), maximumRecords, initializeRoot = true, loadRecords = [] } = {}) {
  const calls = [], originalPromises = [], attachment = {}, pending = new Set();
  const entry = { id: "lease-1", target: { targetId: "child" }, data: { leaseId: "lease-1", tabId: 7, targetId: "child", rootTargetId: "root", parentFrameId: "root", phase: "owned" }, root: { tabId: 7 }, status: "ready", owned: true, pending: new Set(), groups: new Map() };
  const registry = { entries: new Map([[entry.id, entry]]), pending, snapshot: () => ({ enabled: true, pending: [...pending], leases: [{ leaseId: entry.id }], failed: [], quarantined: [] }) };
  const debuggerAPI = { onEvent: event(), onDetach: event() }, storage = {};
  for (const name of ["sendCommand", "attach", "detach", "getTargets"]) debuggerAPI[name] = function (...args) { calls.push({ name, receiver: this, args }); const result = native(name, args); originalPromises.push(result); return result; };
  for (const name of ["get", "set"]) storage[name] = function (...args) { calls.push({ name: `storage.${name}`, receiver: this, args }); const result = Promise.resolve(name === "get" ? { [ledgerKey]: { version: 1, incarnation: "browser-1", records: loadRecords } } : undefined); originalPromises.push(result); return result; };
  const target = { crypto: { randomUUID: () => "worker-1" }, __integrationBackend: { browserEngine: null, attachedTabs: new Set([7]), attachmentEpochs: new Map([[7, attachment]]), privatePointerTargets: registry } };
  const api = { debugger: debuggerAPI, storage: { session: storage } }, originals = { send: debuggerAPI.sendCommand, attach: debuggerAPI.attach, detach: debuggerAPI.detach, get: storage.get, set: storage.set };
  installColdPrivateTargetLifecycleProbe(api, target, { ledgerKey, storageArea: "session", maximumRecords }); const probe = target.__obuColdPrivateTargets; if (initializeRoot) probe.setRoot(7);
  return { api, target, originals, probe, calls, originalPromises, registry, entry };
}

test("passive observer retains original receiver, arguments and Promise for every unselected native call", async () => {
  const f = fixture(); const source = { tabId: 7 }, params = { type: "mouseMoved", x: 234, y: 184, buttons: 0 };
  const promise = f.api.debugger.sendCommand(source, "Input.dispatchMouseEvent", params);
  assert.equal(promise, f.originalPromises[0]); assert.equal(f.calls[0].receiver, f.api.debugger); assert.equal(f.calls[0].args[0], source); assert.equal(f.calls[0].args[2], params);
  await promise; await tick(); const snapshot = f.probe.restore(); checkColdPrivateTargetTrace(snapshot);
  assert.equal(snapshot.records.filter(r => r.kind === "call").length, 1); assert.equal(f.api.debugger.sendCommand, f.originals.send);
});

test("original group ACK remains distinct from held delivery and later controlled rejection", async () => {
  const ack = {}; const f = fixture({ native: () => Promise.resolve(ack) });
  f.probe.arm({ tabId: 7, method: "Runtime.releaseObjectGroup", rejectDelivery: true });
  const promise = f.api.debugger.sendCommand({ targetId: "child" }, "Runtime.releaseObjectGroup", { objectGroup: "original-group" });
  const observed = promise.then(value => ({ value }), error => ({ error })); f.registry.pending.add(promise);
  assert.notEqual(promise, f.originalPromises[0]); await f.originalPromises[0]; await tick();
  const held = f.probe.snapshot(); assert.equal(held.deliveryPending, 1); assert.equal(held.nativePending, 0); assert.equal(held.state.exactPending, true);
  assert.equal(held.records.filter(r => r.kind === "delivery-settled").length, 0); assert.deepEqual(held.records.find(r => r.kind === "native-settled").value, ack);
  assert.throws(() => f.probe.restore(), /unresolved/); f.probe.release("explicit test release");
  const result = await observed; f.registry.pending.delete(promise); assert.match(result.error.message, /^OBU_TEST_PRIVATE_TARGET_DELIVERY_REJECTED: original Runtime.releaseObjectGroup acknowledged$/);
  const final = f.probe.restore(); checkColdPrivateTargetTrace(final);
  assert.equal(final.records.find(r => r.kind === "native-settled").ok, true); assert.equal(final.records.find(r => r.kind === "delivery-settled").ok, false);
  assert.equal(f.calls.length, 1, "Controlled failure must not replay the native call");
});

test("held attach delivers its exact original value after release without another native call", async () => {
  const ack = {}; const f = fixture({ native: () => Promise.resolve(ack) }); f.probe.arm({ tabId: 7, method: "debugger.attach", rejectDelivery: false });
  const promise = f.api.debugger.attach({ targetId: "child" }, "1.3"); await tick(); f.probe.release("original acknowledgement"); assert.equal(await promise, ack);
  const final = f.probe.restore(); checkColdPrivateTargetTrace(final); assert.equal(f.calls.length, 1);
});

test("a native rejection stays original, is never described as a fulfilled held ACK", async () => {
  const original = Error("original native attach rejected"); const f = fixture({ native: () => Promise.reject(original) });
  f.probe.arm({ tabId: 7, method: "debugger.attach", rejectDelivery: true });
  await assert.rejects(f.api.debugger.attach({ targetId: "child" }, "1.3"), error => error === original);
  const result = f.probe.restore(); assert.equal(result.nativePending, 0); assert.equal(result.deliveryPending, 0); assert.equal(result.records.some(r => r.kind === "held"), false);
  assert.equal(result.records.find(r => r.kind === "native-settled").ok, false);
});

test("an unrelated independent target is observed but cannot consume the exact original lease gate", async () => {
  const f = fixture(); f.probe.arm({ tabId: 7, method: "debugger.detach", rejectDelivery: true });
  const promise = f.api.debugger.detach({ targetId: "other-child" }); assert.equal(promise, f.originalPromises[0]); await promise;
  const result = f.probe.restore(); assert.equal(result.selected, null); assert.equal(result.deliveryPending, 0);
});

test("storage observer preserves native intent then owned writes with their actual ACK ordering", async () => {
  const f = fixture(); const intent = { version: 1, incarnation: "browser-1", records: [{ ...f.entry.data, phase: "intent" }] };
  const promise = f.api.storage.session.set({ [ledgerKey]: intent }); assert.equal(promise, f.originalPromises[0]); await promise;
  await f.api.storage.session.set({ [ledgerKey]: { ...intent, records: [{ ...f.entry.data, phase: "owned" }] } });
  await f.api.storage.session.get(ledgerKey); const final = f.probe.restore(); checkColdPrivateTargetTrace(final);
  const writes = final.records.filter(r => r.kind === "call" && r.method === "storage.session.set"); assert.deepEqual(writes.map(r => r.value.records[0].phase), ["intent", "owned"]);
  assert.ok(final.records.find(r => r.kind === "native-settled" && r.call === writes[0].sequence).sequence < writes[1].sequence);
});

test("replacement observer learns original cleanup tab only from its actual ledger read without inventing an attachment anchor", async () => {
  const f = fixture({ initializeRoot: false, loadRecords: [{ tabId: 7, targetId: "child", phase: "intent" }] });
  await f.api.storage.session.get(ledgerKey); await f.api.debugger.detach({ tabId: 7 });
  const snapshot = f.probe.restore(); checkColdPrivateTargetTrace(snapshot);
  assert.equal(snapshot.records.filter(r => r.kind === "call" && r.method === "debugger.detach" && r.target.tabId === 7).length, 1);
  assert.deepEqual(snapshot.state.roots, [], "A persisted numeric ID is not original JS attachment identity");
});

test("bounded observer reports loss, and the oracle refuses that partial evidence", async () => {
  const f = fixture({ maximumRecords: 2 }); await f.api.debugger.sendCommand({ tabId: 7 }, "Page.getFrameTree", {});
  const snapshot = f.probe.restore(); assert.equal(snapshot.overflow, true); assert.throws(() => checkColdPrivateTargetTrace(snapshot));
});

test("abandoned worker evidence explicitly retains unresolved delivery without inventing restoration", async () => {
  const f = fixture(); f.probe.arm({ tabId: 7, method: "debugger.attach", rejectDelivery: false });
  const promise = f.api.debugger.attach({ targetId: "child" }, "1.3"); await tick();
  const saved = f.probe.checkpoint("about to stop original worker"); checkColdPrivateTargetTrace(saved, { abandoned: true });
  assert.throws(() => checkColdPrivateTargetTrace(saved));
  const mutation = structuredClone(saved); mutation.deliveryPending = 0; assert.throws(() => checkColdPrivateTargetTrace(mutation, { abandoned: true }));
  f.probe.release("test cleanup only"); await promise; f.probe.restore();
});

test("missing or duplicate actual ACK cannot satisfy final native trace", async () => {
  const f = fixture(); await f.api.debugger.sendCommand({ tabId: 7 }, "Page.getFrameTree", {}); const original = f.probe.restore(); checkColdPrivateTargetTrace(original);
  const missing = structuredClone(original); missing.records = missing.records.filter(r => r.kind !== "native-settled"); assert.throws(() => checkColdPrivateTargetTrace(missing), /settle exactly once/);
  const duplicate = structuredClone(original); duplicate.records.push({ ...duplicate.records.find(r => r.kind === "native-settled"), sequence: duplicate.records.length + 1 }); assert.throws(() => checkColdPrivateTargetTrace(duplicate), /settle exactly once/);
});

test("fixture retains actual root/localhost child URL and independent original document tokens", () => {
  const fixture = createColdPrivateTargetFixtures(); const bodies = [], response = { writeHead(code) { assert.equal(code, 200); return this; }, end(value) { bodies.push(value); } };
  for (const [pathname, host] of [["page", "127.0.0.1:53123"], ["leaf", "localhost:53123"]]) {
    const request = { url: `/cold-private-target/${pathname}?key=original-case`, headers: { host } };
    assert.equal(fixture.handle(request, response, new URL(request.url, "http://127.0.0.1:53123")), true);
  }
  const stats = fixture.stats("original-case"); assert.equal(stats.gets.length, 2); assert.equal(new Set(stats.gets.map(g => g.documentToken)).size, 2);
  assert.equal(stats.gets[1].url, "http://localhost:53123/cold-private-target/leaf?key=original-case");
  assert.ok(bodies[0].includes('src="http://localhost:53123/cold-private-target/leaf?key=original-case"')); assert.ok(bodies[1].includes(stats.gets[1].documentToken));
});

function businessExample() {
  const point = { type: "mouseMoved", x: 234, y: 184, buttons: 0 };
  const before = ["root", "leaf"].map((role, n) => ({ documentId: `native-${role}`, frameId: n, result: { key: "case", role, documentToken: `original-${role}`, href: `http://${role}.example/`, sameDocument: true, sameWindow: true, originalNode: true, connected: true, activeElement: "", events: [], overflow: false } }));
  const after = structuredClone(before); after[1].result.events = ["pointermove", "mousemove"].map(type => ({ type, trusted: true, target: "target", x: 150, y: 90 }));
  return { before, after, inputOutcome: { ok: true }, inputParams: point, probe: { records: [{ kind: "call", sequence: 1, method: "Input.dispatchMouseEvent", params: point }, { kind: "native-settled", call: 1, ok: true }] }, server: { gets: before.map(row => ({ role: row.result.role, documentToken: row.result.documentToken, url: row.result.href })) } };
}
test("business oracle rejects a replay, synthetic pointer, changed original document or caller failure", () => {
  checkColdPrivateTargetBusiness(businessExample());
  for (const mutate of [x => x.probe.records.push({ ...x.probe.records[0], sequence: 3 }), x => x.after[1].result.events[0].trusted = false, x => x.after[1].documentId = "successor", x => x.inputOutcome.ok = false]) {
    const value = businessExample(); mutate(value); assert.throws(() => checkColdPrivateTargetBusiness(value));
  }
});

test("the worker scenario has one original down and its natural target focus, never an added release or click", () => {
  const item = businessExample(); item.name = "worker-owned-intent-recovery";
  item.inputParams = { type: "mousePressed", x: 234, y: 184, button: "left", buttons: 1, clickCount: 1 };
  item.probe.records[0].params = item.inputParams;
  item.after[0].result.activeElement = "frame"; item.after[1].result.activeElement = "target";
  item.after[1].result.events = [{ type: "pointerdown", trusted: true, target: "target", x: 150, y: 90 }];
  checkColdPrivateTargetBusiness(item);
  for (const mutate of [x => x.after[1].result.events.push({ ...x.after[1].result.events[0], type: "pointerup" }),
    x => x.after[1].result.events[0].type = "click", x => x.after[1].result.activeElement = "other",
    x => x.inputParams.buttons = 0, x => x.after[1].result.documentToken = "new-document"]) {
    const changed = structuredClone(item); mutate(changed); assert.throws(() => checkColdPrivateTargetBusiness(changed));
  }
});

test("a completed move clears durable input risk, whereas the single actual down keeps it until original destruction", async () => {
  const risks = new Set(), token = {}, native = [], tracker = new NativeInputTracker({
    beforeInput: async (tabId, original) => { assert.equal(original, token); risks.add(tabId); },
    released: async tabId => risks.delete(tabId), onDestroyed: async tabId => risks.delete(tabId)
  });
  tracker.register(7, token);
  const send = params => tracker.send({ tabId: 7 }, token, "Input.dispatchMouseEvent", params, async () => { native.push(params); return {}; });
  await send({ type: "mouseMoved", x: 234, y: 184, buttons: 0 }); assert.equal(risks.size, 0);
  await send({ type: "mousePressed", x: 234, y: 184, button: "left", buttons: 1, clickCount: 1 });
  assert.deepEqual([...risks], [7]); assert.equal(tracker.attachments.get(7).states.values().next().value.buttons.has("left"), true);
  tracker.forget(7, token, { destroyed: true }); await Promise.all(tracker.controlSnapshot().pending);
  assert.equal(risks.size, 0); assert.deepEqual(native.map(params => params.type), ["mouseMoved", "mousePressed"], "Original destruction must not replay a release");
});

function ownershipExample(name) {
  const key = "ledger", row = { leaseId: "lease", tabId: 7, targetId: "child", rootTargetId: "root", parentFrameId: "root", phase: "owned" }, records = [];
  const call = (method, fields = {}, value = {}, error) => {
    const entry = { kind: "call", sequence: records.length + 1, method, ...fields }; records.push(entry);
    records.push({ kind: "native-settled", sequence: records.length + 1, call: entry.sequence, ok: error === undefined, ...(error ? { error } : { value }) }); return entry;
  };
  call("Target.getTargetInfo", { target: { targetId: "child" } }, undefined, "Error: Debugger is not attached to the target with id: child.");
  call("storage.local.set", { value: { version: 1, incarnation: "browser", records: [{ ...row, phase: "intent" }] } });
  const attach = call("debugger.attach", { target: { targetId: "child" }, leaseId: "lease", originalTabId: 7 });
  call("storage.local.set", { value: { version: 1, incarnation: "browser", records: [row] } });
  const method = name === "detach-delivery-rejection" ? "debugger.detach" : "Runtime.releaseObjectGroup";
  const selected = call(method, { target: { targetId: "child" }, leaseId: "lease", originalTabId: 7, params: { objectGroup: "original-group" } });
  const delivered = { kind: "delivery-settled", sequence: records.length + 1, call: selected.sequence, ok: false, error: `Error: OBU_TEST_PRIVATE_TARGET_DELIVERY_REJECTED: original ${method} acknowledged` }; records.push(delivered);
  if (name === "held-group-delivery-rejection") { call("Runtime.releaseObjectGroup", { target: { targetId: "child" }, params: { objectGroup: "original-group" } }); call("debugger.detach", { target: { targetId: "child" } }); }
  else { call("debugger.detach", { target: { targetId: "child" } }, undefined, "Error: Debugger is not attached to the target with id: child."); call("Target.getTargetInfo", { target: { targetId: "child" } }, undefined, "Error: Debugger is not attached to the target with id: child."); }
  call("storage.local.set", { value: { version: 1, incarnation: "browser", records: [] } });
  return { name, tabId: 7, probe: { ledgerKey: key, storageArea: "local", selected: selected.sequence, records }, heldLedger: { [key]: { version: 1, incarnation: "browser", records: [row] } },
    held: { state: { engineAbsent: true, roots: [{ tabId: 7, attached: true, sameAttachment: true }], exactPending: true, registry: { pending: 1 } } },
    recoveredProbe: { ledgerKey: key, state: { registry: { pending: 0, leases: [] } } }, recoveredLedger: { [key]: { version: 1, incarnation: "browser", records: [] } },
    detachOutcome: { ok: false, error: "Original detach request timed out" }, atDetach: { deliveryPending: 1, released: false, state: { exactPending: true } }, failed: { state: { registry: { failed: ["lease"] } } }, attachSequence: attach.sequence };
}

test("ownership proof requires original intent ACK before attach and exact native recovery", () => {
  for (const name of ["held-group-delivery-rejection", "detach-delivery-rejection"]) checkColdPrivateTargetOwnership(ownershipExample(name));
  const mutations = [
    item => { const intent = item.probe.records.find(r => r.kind === "call" && r.value?.records?.[0]?.phase === "intent"); item.probe.records.find(r => r.kind === "native-settled" && r.call === intent.sequence).sequence = item.attachSequence + 1; },
    item => { item.heldLedger.ledger.records[0].targetId = "unrelated"; },
    item => { item.recoveredLedger.ledger.incarnation = "different-browser"; },
    item => { item.detachOutcome = { ok: true, value: {} }; },
    item => { item.atDetach.state.exactPending = false; },
    item => { const retry = item.probe.records.filter(r => r.method === "debugger.detach").at(-1); item.probe.records = item.probe.records.filter(r => r !== retry && !(r.kind === "native-settled" && r.call === retry.sequence)); },
    item => { const retry = item.probe.records.filter(r => r.method === "debugger.detach").at(-1); item.probe.records.find(r => r.kind === "native-settled" && r.call === retry.sequence).error = "Error: A different native failure"; },
    item => { const clear = item.probe.records.find(r => r.kind === "call" && r.value?.records?.length === 0); item.probe.records.find(r => r.kind === "native-settled" && r.call === clear.sequence).ok = false; },
    item => { const query = item.probe.records.filter(r => r.method === "Target.getTargetInfo").at(-1); item.probe.records.find(r => r.kind === "native-settled" && r.call === query.sequence).error = "Error: Some other native failure"; }
  ];
  for (const mutate of mutations) { const item = ownershipExample("detach-delivery-rejection"); mutate(item); assert.throws(() => checkColdPrivateTargetOwnership(item)); }
});

test("worker recovery preserves the input-risk boundary and rejected original caller without replay", () => {
  assert.equal(coldPrivateTargetCases.at(-1), "worker-owned-intent-recovery", "A deliberately blocked worker must not precede another input scenario");
  const scope = { session_id: "original-session", turn_id: "original-turn", control_epoch: 7 };
  const riskKey = "original-risk", risk = { riskId: "risk-1", tabId: 7, incarnation: "original-browser", startupWitness: null }, durable = { version: 1, risks: [risk] };
  const original = { name: "worker-owned-intent-recovery", tabId: 7, scope, scopeAfterRejectedBegin: { ...scope },
    beforeRestartProbe: { inputRiskKey: riskKey, ledgerKey: "ledger", storageArea: "local", records: [
      { kind: "call", sequence: 1, method: "storage.local.set", values: { [riskKey]: durable } },
      { kind: "native-settled", sequence: 2, call: 1, ok: true },
      { kind: "call", sequence: 3, method: "Input.dispatchMouseEvent", params: { type: "mousePressed", x: 234, y: 184, button: "left", buttons: 1, clickCount: 1 } },
      { kind: "native-settled", sequence: 4, call: 3, ok: true }
    ] },
    held: { state: { input: [{ tabId: 7, sameAttachment: true, riskId: risk.riskId, inflight: 0, states: [{ target: { tabId: 7 }, buttons: ["left"], keys: [], x: 234, y: 184 }] }] } },
    heldLedger: { [riskKey]: durable, ledger: { incarnation: risk.incarnation } }, recoveredLedger: { [riskKey]: durable },
    controlAfterRestart: { engineAbsent: true, inputRisks: [risk], recoveredInputRiskIds: [risk.riskId], status: { inputBlocked: true, cleanupComplete: false, error: "OBU_INPUT_RELEASE_UNCONFIRMED: previous browser input could not be confirmed as released", inputRecovery: { action: "close-controlled-pages" } } },
    beginTurnOutcome: { ok: false, error: "OBU_AUTOMATION_PAUSED: browser automation is paused" },
    finalizeRequest: { ...scope, keep: [] }, finalizeOutcome: { ok: false, error: "OBU_AUTOMATION_PAUSED: browser automation is paused" }, exactTabClosed: true,
    inputRiskAfterClose: { durable: { [riskKey]: { version: 1, risks: [] } }, records: [], recovered: [] }, probe: { records: [] } };
  assert.equal(checkColdPrivateTargetWorkerControl(original).originalFinalizeRejected, true);
  const mutations = [
    x => x.beforeRestartProbe.records[1].sequence = 4,
    x => x.beforeRestartProbe.records[1].ok = false,
    x => x.beforeRestartProbe.records[3].ok = false,
    x => x.beforeRestartProbe.records[2].params.type = "mouseMoved",
    x => x.held.state.input[0].states[0].buttons = [],
    x => x.heldLedger[riskKey] = { version: 1, risks: [] },
    x => x.recoveredLedger[riskKey] = { version: 1, risks: [] },
    x => x.controlAfterRestart.recoveredInputRiskIds = [],
    x => x.inputRiskAfterClose.durable[riskKey] = durable,
    x => x.controlAfterRestart.status.inputBlocked = false,
    x => x.controlAfterRestart.status.cleanupComplete = true,
    x => x.controlAfterRestart.status.error = "OBU_VISUAL_CLEANUP_FAILED: unrelated failure",
    x => x.controlAfterRestart.status.inputRecovery.action = "restart-browser",
    x => x.controlAfterRestart.engineAbsent = false,
    x => x.beginTurnOutcome = { ok: true, value: { controlEpoch: 8 } },
    x => x.scopeAfterRejectedBegin.control_epoch++,
    x => x.finalizeRequest.turn_id = "successor",
    x => x.finalizeOutcome = { ok: true, value: {} },
    x => x.finalizeOutcome.error = "Transport timed out: OBU_AUTOMATION_PAUSED",
    x => x.exactTabClosed = false,
    x => x.probe.records.push({ kind: "call", method: "Input.dispatchMouseEvent" })
  ];
  for (const mutate of mutations) { const changed = structuredClone(original); mutate(changed); assert.throws(() => checkColdPrivateTargetWorkerControl(changed)); }
});

test("actual risk readback key order is irrelevant while original mark ACK, identity and exact fields remain required", () => {
  const risk = { riskId: "original-risk", tabId: 7, incarnation: "original-browser", startupWitness: null };
  const item = { name: "worker-owned-intent-recovery", tabId: 7,
    beforeRestartProbe: { inputRiskKey: "risks", ledgerKey: "ledger", storageArea: "local", records: [
      { sequence: 7, kind: "call", method: "storage.local.set", values: { risks: { version: 1, risks: [risk] } } },
      { sequence: 10, kind: "native-settled", call: 7, ok: true },
      { sequence: 11, kind: "call", method: "Input.dispatchMouseEvent", params: { button: "left", buttons: 1, clickCount: 1, type: "mousePressed", x: 234, y: 184 } },
      { sequence: 14, kind: "native-settled", call: 11, ok: true, value: {} }
    ] },
    heldLedger: { risks: { risks: [{ incarnation: risk.incarnation, riskId: risk.riskId, startupWitness: null, tabId: 7 }], version: 1 }, ledger: { incarnation: risk.incarnation } },
    held: { state: { input: [{ tabId: 7, sameAttachment: true, riskId: risk.riskId, inflight: 0, states: [{ target: { tabId: 7 }, buttons: ["left"], keys: [], x: 234, y: 184 }] }] } }
  };
  assert.equal(checkColdPrivateTargetHeldInputRisk(item).risk.riskId, risk.riskId);
  for (const mutate of [x => x.beforeRestartProbe.records[1].sequence = 12,
    x => x.beforeRestartProbe.records[1].ok = false,
    x => x.beforeRestartProbe.records[0].values.risks.risks[0].riskId = "different-risk",
    x => delete x.beforeRestartProbe.records[0].values.risks.risks[0].startupWitness,
    x => x.beforeRestartProbe.records.push({ ...x.beforeRestartProbe.records[0], sequence: 8 })]) {
    const changed = structuredClone(item); mutate(changed); assert.throws(() => checkColdPrivateTargetHeldInputRisk(changed));
  }
});

test("replacement worker must read the complete original intent regardless of native object key ordering", () => {
  const item = ownershipExample("held-group-delivery-rejection"), original = structuredClone(item.probe);
  item.name = "worker-owned-intent-recovery";
  const attach = original.records.find(r => r.method === "debugger.attach"), attachACK = original.records.find(r => r.kind === "native-settled" && r.call === attach.sequence);
  original.records = original.records.filter(r => r.sequence <= attachACK.sequence); original.selected = attach.sequence; original.workerId = "original-worker";
  item.beforeRestartProbe = original;
  item.heldLedger.ledger.records[0].phase = "intent";
  const ledger = item.heldLedger.ledger, saved = ledger.records[0];
  const readback = { records: [{ targetId: saved.targetId, tabId: saved.tabId, rootTargetId: saved.rootTargetId, phase: saved.phase, parentFrameId: saved.parentFrameId, leaseId: saved.leaseId }], incarnation: ledger.incarnation, version: ledger.version };
  const records = [
    { sequence: 1, kind: "call", method: "storage.local.get", args: ["ledger"] },
    { sequence: 2, kind: "native-settled", call: 1, ok: true, value: { ledger: readback } },
    { sequence: 3, kind: "call", method: "Target.getTargetInfo", target: { targetId: saved.targetId } },
    { sequence: 4, kind: "native-settled", call: 3, ok: true, value: { targetInfo: { targetId: saved.targetId } } },
    { sequence: 5, kind: "call", method: "debugger.detach", target: { targetId: saved.targetId } },
    { sequence: 6, kind: "native-settled", call: 5, ok: true },
    { sequence: 7, kind: "call", method: "storage.local.set", value: { version: 1, incarnation: ledger.incarnation, records: [] } },
    { sequence: 8, kind: "native-settled", call: 7, ok: true }
  ];
  item.probe = { ledgerKey: "ledger", storageArea: "local", workerId: "replacement-worker", records };
  item.restart = { oldTarget: "old-native-worker", restartedTarget: "new-native-worker" };
  assert.equal(checkColdPrivateTargetOwnership(item).targetId, saved.targetId);
  for (const mutate of [x => x.probe.records[1].value.ledger.records[0].phase = "owned",
    x => delete x.probe.records[1].value.ledger.records[0].parentFrameId,
    x => x.probe.records[1].value.ledger.records[0].targetId = "other-target",
    x => x.probe.records[1].value.ledger.records.push({ ...x.probe.records[1].value.ledger.records[0] }),
    x => x.probe.records[1].ok = false]) {
    const changed = structuredClone(item); mutate(changed); assert.throws(() => checkColdPrivateTargetOwnership(changed));
  }
});
