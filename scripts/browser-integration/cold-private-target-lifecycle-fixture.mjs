import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

const json = JSON.stringify;
const errorText = error => error?.stack ?? String(error);
const outcome = promise => promise.then(value => ({ ok: true, value }), error => ({ ok: false, error: String(error?.message ?? error) }));
const scopeOf = owner => ({ session_id: owner.client.sessionId, turn_id: owner.client.turnId, control_epoch: owner.client.controlEpoch });
export const coldPrivateTargetCases = Object.freeze(["held-group-delivery-rejection", "detach-delivery-rejection", "worker-owned-intent-recovery"]);

// Install before Backend construction in each isolated diagnostic worker.
// The original Chrome Promise is returned unchanged except for one explicitly
// armed delivery seam. Native fulfillment and controlled delivery failure are
// separate records. This does not synthesize a native target or response.
export function installColdPrivateTargetLifecycleProbe(api, target, { ledgerKey, initializedKey, inputRiskKey = "OPEN_BROWSER_USE_INPUT_RISKS", storageArea = "local", maximumRecords = 4096, holdTimeoutMs = 25000 } = {}) {
  const key = "__obuColdPrivateTargets";
  if (target[key]) throw Error("Private target lifecycle observer already installed");
  if (typeof ledgerKey !== "string" || !ledgerKey || typeof inputRiskKey !== "string" || !inputRiskKey || !["local", "session"].includes(storageArea) || (initializedKey !== undefined && (typeof initializedKey !== "string" || !initializedKey)) || !Number.isSafeInteger(maximumRecords) || maximumRecords < 1 || maximumRecords > 8192) throw Error("Invalid private lifecycle observer options");
  const nativeThen = Promise.prototype.then, records = [], roots = new Map(), watchedRoots = new Set(), originals = [], requests = new Map();
  const workerId = target.crypto.randomUUID();
  let bytes = 0, overflow = false, recordingErrors = 0, nativePending = 0, deliveryPending = 0, restored = false, watchdog = false, armed, selected, selectedPromise, releaseGate, timer, released = false;
  const clone = value => structuredClone(value);
  const append = value => {
    try {
      const row = clone({ sequence: records.length + 1, ...value }), size = JSON.stringify(row).length;
      if (records.length >= maximumRecords || size > 2 * 1024 * 1024 || bytes + size > 12 * 1024 * 1024) { overflow = true; return null; }
      records.push(row); bytes += size; return row;
    } catch { recordingErrors++; return null; }
  };
  const backend = () => target.__integrationBackend;
  const entryFor = id => [...(backend()?.privatePointerTargets?.entries.values() ?? [])].find(entry => entry.target.targetId === id);
  const registryState = () => {
    const b = backend(), registry = b?.privatePointerTargets, snapshot = registry?.snapshot();
    return { present: !!registry, engineAbsent: b?.browserEngine === null,
      roots: [...roots].map(([tabId, attachment]) => ({ tabId, attached: b?.attachedTabs.has(tabId) ?? false, sameAttachment: b?.attachmentEpochs.get(tabId) === attachment })),
      input: [...roots].map(([tabId, attachment]) => { const r = b?.inputTracker?.attachments.get(tabId); return { tabId, sameAttachment: r?.token === attachment, riskId: b?.inputRiskIds?.get(attachment) ?? null, inflight: r?.inflight.size ?? null,
        states: [...(r?.states.values() ?? [])].map(s => ({ target: s.target, buttons: [...s.buttons.keys()], keys: [...s.keys.keys()], x: s.x, y: s.y })) }; }),
      registry: snapshot ? { ...snapshot, pending: snapshot.pending.length } : null,
      exactPending: !!registry && registry.pending.has(selectedPromise),
      entries: [...(registry?.entries.values() ?? [])].map(entry => ({ leaseId: entry.id, target: entry.target, data: entry.data, status: entry.status, owned: entry.owned, recovered: entry.recovered,
        pending: entry.pending.size, groups: [...entry.groups.values()].map(group => ({ name: group.name, pending: group.pending.size, closing: group.closing, released: group.released, closed: group.closed, failed: group.failed })) })) };
  };
  const snapshot = () => clone({ workerId, ledgerKey, initializedKey, inputRiskKey, storageArea, records, nativePending, deliveryPending, selected: selected?.sequence ?? null, armed, released, restored, watchdog, overflow, recordingErrors, state: registryState() });
  const release = reason => { if (!released) { released = true; clearTimeout(timer); append({ kind: "release", reason, selected: selected?.sequence ?? null }); releaseGate?.(); } return snapshot(); };
  function invoke(original, receiver, args, row) {
    let promise;
    try { promise = Reflect.apply(original, receiver, args); }
    catch (error) { append({ kind: "native-settled", call: row.sequence, ok: false, synchronous: true, error: String(error) }); throw error; }
    nativePending++;
    nativeThen.call(promise, value => { nativePending--;
      const ledgerRecords = row.method === `storage.${storageArea}.get` ? value?.[ledgerKey]?.records : undefined;
      if (Array.isArray(ledgerRecords)) for (const record of ledgerRecords) if (Number.isSafeInteger(record?.tabId)) watchedRoots.add(record.tabId);
      append({ kind: "native-settled", call: row.sequence, ok: true, value }); },
      error => { nativePending--; append({ kind: "native-settled", call: row.sequence, ok: false, error: String(error) }); });
    return promise;
  }
  function wrap(receiver, name, methodOf, argsOf, relevant) {
    const original = receiver[name];
    if (typeof original !== "function") throw Error(`Missing native lifecycle API ${name}`);
    const wrapper = function (...args) {
      if (!relevant(args)) return Reflect.apply(original, this, args);
      const method = methodOf(args), source = argsOf(args), entry = source.target?.targetId ? entryFor(source.target.targetId) : undefined;
      const row = append({ kind: "call", method, ...source, ...(entry ? { leaseId: entry.id, originalTabId: entry.data?.tabId ?? entry.root?.tabId } : {}) });
      if (!row) return Reflect.apply(original, this, args);
      const match = armed && !selected && method === armed.method && entry && (entry.data?.tabId ?? entry.root?.tabId) === armed.tabId;
      if (match) { selected = row; append({ kind: "selected", call: row.sequence }); }
      const native = invoke(original, this, args, row);
      if (!match) return native;
      selectedPromise = nativeThen.call(native, value => {
        deliveryPending++; append({ kind: "held", call: row.sequence, nativeAlreadyFulfilled: true });
        if (!released) timer = setTimeout(() => { watchdog = true; release("watchdog"); }, holdTimeoutMs);
        return new Promise(resolve => { releaseGate = resolve; if (released) resolve(); }).then(() => {
          if (armed.rejectDelivery) throw Error(`OBU_TEST_PRIVATE_TARGET_DELIVERY_REJECTED: original ${method} acknowledged`);
          return value;
        });
      });
      nativeThen.call(selectedPromise, value => { if (deliveryPending) deliveryPending--; append({ kind: "delivery-settled", call: row.sequence, ok: true, value }); },
        error => { if (deliveryPending) deliveryPending--; append({ kind: "delivery-settled", call: row.sequence, ok: false, error: String(error) }); });
      return selectedPromise;
    };
    receiver[name] = wrapper; originals.push({ receiver, name, original, wrapper });
  }
  const sourceRelevant = args => !!args[0]?.targetId || watchedRoots.has(args[0]?.tabId);
  wrap(api.debugger, "sendCommand", args => args[1], args => ({ target: clone(args[0]), params: clone(args[2] ?? {}) }), sourceRelevant);
  wrap(api.debugger, "attach", () => "debugger.attach", args => ({ target: clone(args[0]), version: args[1] }), sourceRelevant);
  wrap(api.debugger, "detach", () => "debugger.detach", args => ({ target: clone(args[0]) }), sourceRelevant);
  wrap(api.debugger, "getTargets", () => "debugger.getTargets", () => ({}), () => true);
  const keys = [ledgerKey, inputRiskKey, ...(initializedKey ? [initializedKey] : [])];
  const hasKey = value => keys.some(key => value === key || (Array.isArray(value) && value.includes(key)) || (value && typeof value === "object" && Object.hasOwn(value, key)));
  wrap(api.storage[storageArea], "get", () => `storage.${storageArea}.get`, args => ({ args: clone(args) }), args => hasKey(args[0]));
  wrap(api.storage[storageArea], "set", () => `storage.${storageArea}.set`, args => ({ value: clone(args[0][ledgerKey]), values: Object.fromEntries(keys.filter(key => Object.hasOwn(args[0], key)).map(key => [key, clone(args[0][key])])) }), args => args[0] && keys.some(key => Object.hasOwn(args[0], key)));
  const event = (source, method, params) => { if (source.targetId || watchedRoots.has(source.tabId)) append({ kind: "event", target: source, method, params }); };
  const detached = (source, reason) => { if (source.targetId || watchedRoots.has(source.tabId)) append({ kind: "detached", target: source, reason }); };
  api.debugger.onEvent.addListener(event); api.debugger.onDetach.addListener(detached);
  const priorRPC = target.__integrationNativeRPCObserver;
  const rpc = (direction, message) => {
    priorRPC?.(direction, message);
    if (direction === "request" && (watchedRoots.has(message.params?.tabId) || watchedRoots.has(message.params?.target?.tabId))) { requests.set(message.id, message.method); append({ kind: "request", id: message.id, method: message.method, params: message.params }); }
    else if (direction === "response" && requests.has(message.id)) append({ kind: "response", id: message.id, method: requests.get(message.id), ok: !message.error, ...(message.error ? { error: message.error } : { value: message.result }) });
  };
  target.__integrationNativeRPCObserver = rpc;
  const controller = {
    snapshot, release,
    setRoot(tabId) {
      const b = backend(), attachment = b?.attachmentEpochs.get(tabId);
      if (!Number.isSafeInteger(tabId) || attachment === undefined || !b.attachedTabs.has(tabId) || b.browserEngine !== null) throw Error("Original cold raw attachment required");
      roots.set(tabId, attachment); watchedRoots.add(tabId); append({ kind: "root", tabId }); return snapshot();
    },
    arm(value) {
      if (selected || armed || !roots.has(value?.tabId) || !["debugger.attach", "Runtime.releaseObjectGroup", "debugger.detach"].includes(value?.method) || typeof value?.rejectDelivery !== "boolean") throw Error("Invalid one-shot private lifecycle gate");
      armed = clone(value); append({ kind: "armed", ...armed }); return snapshot();
    },
    checkpoint(label) { append({ kind: "checkpoint", label, state: registryState() }); return snapshot(); },
    restore() {
      if (nativePending || deliveryPending) throw Error("Cannot restore unresolved private lifecycle observer");
      if (target[key] !== controller || target.__integrationNativeRPCObserver !== rpc || originals.some(x => x.receiver[x.name] !== x.wrapper)) throw Error("Private lifecycle observer was replaced");
      for (const x of originals) x.receiver[x.name] = x.original;
      api.debugger.onEvent.removeListener(event); api.debugger.onDetach.removeListener(detached);
      if (priorRPC) target.__integrationNativeRPCObserver = priorRPC; else delete target.__integrationNativeRPCObserver;
      restored = true; clearTimeout(timer); const result = snapshot(); delete target[key]; return result;
    }
  };
  target[key] = controller; return { workerId, installed: true, ledgerKey };
}

export function coldPrivateTargetLifecyclePrefix(options) {
  return `\n(${installColdPrivateTargetLifecycleProbe.toString()})(chrome,globalThis,${json(options)});\n`;
}

export function createColdPrivateTargetFixtures() {
  const values = new Map();
  const entry = key => { if (!values.has(key)) values.set(key, { key, gets: [] }); return values.get(key); };
  return {
    handle(request, response, url) {
      if (url.pathname !== "/cold-private-target/page" && url.pathname !== "/cold-private-target/leaf") return false;
      const key = url.searchParams.get("key"); if (!/^[a-z0-9-]{1,100}$/.test(key ?? "")) { response.writeHead(400).end(); return true; }
      const actual = new URL(request.url, `http://${request.headers.host}`), role = url.pathname.endsWith("/leaf") ? "leaf" : "root", documentToken = randomUUID();
      const child = new URL(`/cold-private-target/leaf?key=${encodeURIComponent(key)}`, actual); child.hostname = "localhost";
      entry(key).gets.push({ role, url: actual.href, documentToken });
      const body = role === "root" ? `<iframe id="frame" src="${child.href}" style="position:absolute;left:80px;top:90px;width:400px;height:260px;border:4px solid #777"></iframe>` : '<button id="target" style="position:absolute;left:50px;top:60px;width:200px;height:60px">Original pointer target</button>';
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }).end(`<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:#ddd}</style>${body}<script>
        (()=>{const originalDocument=document,originalWindow=window,originalNode=document.getElementById(${json(role === "root" ? "frame" : "target")}),documentToken=${json(documentToken)},events=[];let overflow=false;
        for(const type of ['pointermove','mousemove','pointerdown','pointerup','click','input'])document.addEventListener(type,event=>{if(events.length>=64){overflow=true;return;}events.push({type,trusted:event.isTrusted,target:event.target.id,x:event.clientX??null,y:event.clientY??null});},true);
        window.coldPrivateTargetState=()=>({key:${json(key)},role:${json(role)},documentToken,href:location.href,sameDocument:document===originalDocument,sameWindow:window===originalWindow,originalNode:document.getElementById(originalNode.id)===originalNode,connected:originalNode.isConnected,activeElement:document.activeElement?.id??'',events:[...events],overflow});})();</script>`);
      return true;
    },
    stats: key => structuredClone(entry(key)), allStats: () => structuredClone([...values.values()])
  };
}

export function checkColdPrivateTargetTrace(probe, { abandoned = false } = {}) {
  assert.equal(probe.overflow, false); assert.equal(probe.recordingErrors, 0); assert.equal(probe.watchdog, false);
  assert.ok(probe.records.every((r, n) => r.sequence === n + 1));
  for (const call of probe.records.filter(r => r.kind === "call")) {
    const settlements = probe.records.filter(r => r.kind === "native-settled" && r.call === call.sequence);
    assert.equal(settlements.length, 1, `Original native call ${call.sequence} must settle exactly once`); assert.ok(settlements[0].sequence > call.sequence);
  }
  assert.equal(probe.nativePending, 0);
  if (!abandoned) { assert.equal(probe.deliveryPending, 0); assert.equal(probe.restored, true); }
  if (probe.selected !== null) {
    const native = probe.records.filter(r => r.kind === "native-settled" && r.call === probe.selected), held = probe.records.filter(r => r.kind === "held" && r.call === probe.selected);
    assert.equal(native.length, 1); assert.equal(native[0].ok, true); assert.equal(held.length, 1); assert.ok(native[0].sequence < held[0].sequence);
    const delivery = probe.records.filter(r => r.kind === "delivery-settled" && r.call === probe.selected);
    if (abandoned) { assert.equal(delivery.length, 0); assert.equal(probe.deliveryPending, 1); assert.equal(probe.released, false); }
    else { assert.equal(delivery.length, 1); const releases = probe.records.filter(r => r.kind === "release"); assert.equal(releases.length, 1); assert.ok(held[0].sequence < releases[0].sequence && releases[0].sequence < delivery[0].sequence); }
  }
}

export function checkColdPrivateTargetBusiness(item) {
  const heldButton = item.name === "worker-owned-intent-recovery";
  assert.equal(item.before.length, 2); assert.equal(item.after.length, 2);
  assert.equal(item.inputOutcome.ok, true); assert.deepEqual(item.inputParams, heldButton
    ? { type: "mousePressed", x: 234, y: 184, button: "left", buttons: 1, clickCount: 1 }
    : { type: "mouseMoved", x: 234, y: 184, buttons: 0 });
  for (let n = 0; n < 2; n++) {
    const before = item.before[n], after = item.after[n];
    for (const key of ["documentId", "frameId"]) assert.equal(after[key], before[key]);
    for (const key of ["key", "role", "documentToken", "href", "sameDocument", "sameWindow", "originalNode", "connected"]) assert.equal(after.result[key], before.result[key]);
    if (heldButton) { assert.equal(before.result.activeElement, ""); assert.equal(after.result.activeElement, n === 0 ? "frame" : "target"); }
    else assert.equal(after.result.activeElement, before.result.activeElement);
    assert.equal(after.result.sameDocument, true); assert.equal(after.result.sameWindow, true); assert.equal(after.result.originalNode, true); assert.equal(after.result.connected, true); assert.equal(after.result.overflow, false);
    assert.deepEqual(before.result.events, []);
  }
  assert.deepEqual(item.after[0].result.events, []);
  assert.deepEqual(item.after[1].result.events.map(e => e.type), heldButton ? ["pointerdown"] : ["pointermove", "mousemove"]);
  assert.ok(item.after[1].result.events.every(e => e.trusted && e.target === "target" && e.x === 150 && e.y === 90));
  const calls = item.beforeRestartProbe?.records ?? item.probe.records;
  const inputs = calls.filter(r => r.kind === "call" && r.method.startsWith("Input."));
  assert.equal(inputs.length, 1); assert.deepEqual(inputs[0].params, item.inputParams);
  assert.equal(calls.filter(r => r.kind === "native-settled" && r.call === inputs[0].sequence && r.ok === true).length, 1);
  assert.equal(item.server.gets.length, 2);
  for (const row of item.after) assert.equal(item.server.gets.filter(g => g.role === row.result.role && g.documentToken === row.result.documentToken && g.url === row.result.href).length, 1);
}

export function checkColdPrivateTargetOwnership(item) {
  const original = item.beforeRestartProbe ?? item.probe, records = original.records;
  const selected = records.find(r => r.sequence === original.selected);
  assert.ok(selected?.target?.targetId && selected.leaseId); assert.equal(selected.originalTabId, item.tabId);
  const ledger = item.heldLedger[original.ledgerKey], heldRow = ledger.records.filter(r => r.leaseId === selected.leaseId);
  assert.equal(ledger.version, 1); assert.equal(typeof ledger.incarnation, "string"); assert.ok(ledger.incarnation); assert.equal(heldRow.length, 1);
  const owned = heldRow[0]; assert.equal(owned.targetId, selected.target.targetId); assert.equal(owned.tabId, item.tabId);
  assert.equal(owned.phase, item.name === "worker-owned-intent-recovery" ? "intent" : "owned"); assert.ok(owned.rootTargetId && owned.parentFrameId);
  const oneACK = (rows, call) => { const acks = rows.filter(r => r.kind === "native-settled" && r.call === call.sequence); assert.equal(acks.length, 1); return acks[0]; };
  const attach = records.filter(r => r.kind === "call" && r.method === "debugger.attach" && r.target?.targetId === owned.targetId);
  assert.equal(attach.length, 1); const attachACK = oneACK(records, attach[0]); assert.equal(attachACK.ok, true);
  const writes = records.filter(r => r.kind === "call" && r.method === `storage.${original.storageArea}.set` && r.value?.records?.some(value => value.leaseId === owned.leaseId));
  const intent = writes.filter(r => r.value.records.find(value => value.leaseId === owned.leaseId)?.phase === "intent");
  assert.equal(intent.length, 1); assert.equal(intent[0].value.incarnation, ledger.incarnation);
  const intentACK = oneACK(records, intent[0]); assert.equal(intentACK.ok, true); assert.ok(intentACK.sequence < attach[0].sequence, "Actual durable intent ACK must precede native attachment");
  const persisted = writes.filter(r => r.value.records.find(value => value.leaseId === owned.leaseId)?.phase === "owned");
  if (item.name === "worker-owned-intent-recovery") assert.equal(persisted.length, 0, "Held attach delivery cannot have published owned persistence");
  else { assert.equal(persisted.length, 1); assert.ok(attachACK.sequence < persisted[0].sequence); assert.equal(oneACK(records, persisted[0]).ok, true); }
  const admission = records.filter(r => r.kind === "call" && r.method === "Target.getTargetInfo" && r.target?.targetId === owned.targetId && r.sequence < attach[0].sequence);
  assert.equal(admission.length, 1); const admissionACK = oneACK(records, admission[0]); assert.equal(admissionACK.ok, false);
  assert.equal(admissionACK.error, `Error: Debugger is not attached to the target with id: ${owned.targetId}.`);
  assert.ok(admissionACK.sequence < intent[0].sequence);
  assert.equal(item.held.state.engineAbsent, true); assert.ok(item.held.state.roots.every(root => root.tabId === item.tabId && root.attached && root.sameAttachment));
  assert.equal(item.held.state.exactPending, true); assert.ok(item.held.state.registry.pending > 0);
  assert.equal(item.recoveredProbe.state.registry.pending, 0); assert.deepEqual(item.recoveredProbe.state.registry.leases, []);
  const recoveredLedger = item.recoveredLedger[item.recoveredProbe.ledgerKey]; assert.equal(recoveredLedger.incarnation, ledger.incarnation); assert.deepEqual(recoveredLedger.records, []);
  const recoveredRecords = item.probe.records;
  const clears = recoveredRecords.filter(r => r.kind === "call" && r.method === `storage.${item.probe.storageArea}.set` && r.value?.incarnation === ledger.incarnation && r.value.records?.length === 0);
  assert.ok(clears.some(call => oneACK(recoveredRecords, call).ok === true), "Cleared ledger requires actual durable write ACK");
  if (item.name === "worker-owned-intent-recovery") {
    assert.notEqual(item.beforeRestartProbe.workerId, item.probe.workerId); assert.notEqual(item.restart.oldTarget, item.restart.restartedTarget);
    assert.equal(recoveredRecords.some(r => r.kind === "call" && r.method.startsWith("Input.")), false, "Recovery must not replay the original input");
    const reads = recoveredRecords.filter(r => r.kind === "call" && r.method === `storage.${item.probe.storageArea}.get`);
    assert.ok(reads.some(call => { const a = oneACK(recoveredRecords, call); return a.ok && isDeepStrictEqual(a.value?.[original.ledgerKey], ledger); }), "Replacement worker must observe the original durable intent");
    const proof = recoveredRecords.filter(r => r.kind === "call" && r.method === "Target.getTargetInfo" && r.target?.targetId === owned.targetId);
    assert.ok(proof.length > 0, "Cleanup-only worker recovery requires an exact native query");
    const first = oneACK(recoveredRecords, proof[0]);
    if (first.ok) {
      assert.equal(first.value?.targetInfo?.targetId, owned.targetId);
      const detach = recoveredRecords.filter(r => r.kind === "call" && r.method === "debugger.detach" && r.target?.targetId === owned.targetId); assert.equal(detach.length, 1); assert.equal(oneACK(recoveredRecords, detach[0]).ok, true);
    } else assert.ok([`Error: Debugger is not attached to the target with id: ${owned.targetId}.`, `Error: No target with given id ${owned.targetId}.`].includes(first.error));
  } else {
    assert.equal(item.detachOutcome.ok, false); assert.match(item.detachOutcome.error, /timed out|timeout/i);
    assert.equal(item.atDetach.deliveryPending, 1); assert.equal(item.atDetach.released, false); assert.equal(item.atDetach.state.exactPending, true);
    assert.ok(item.failed.state.registry.failed.includes(owned.leaseId));
    const delivery = records.filter(r => r.kind === "delivery-settled" && r.call === selected.sequence); assert.equal(delivery.length, 1); assert.equal(delivery[0].ok, false);
    assert.equal(delivery[0].error, `Error: OBU_TEST_PRIVATE_TARGET_DELIVERY_REJECTED: original ${selected.method} acknowledged`);
    if (item.name === "held-group-delivery-rejection") {
      const groups = records.filter(r => r.kind === "call" && r.method === "Runtime.releaseObjectGroup" && r.target?.targetId === owned.targetId && r.params.objectGroup === selected.params.objectGroup);
      assert.equal(groups.length, 2); assert.ok(groups[1].sequence > delivery[0].sequence); assert.ok(groups.every(call => oneACK(records, call).ok));
      const detach = records.filter(r => r.kind === "call" && r.method === "debugger.detach" && r.target?.targetId === owned.targetId); assert.equal(detach.length, 1); assert.ok(oneACK(records, groups[1]).sequence < detach[0].sequence); assert.equal(oneACK(records, detach[0]).ok, true);
    } else {
      assert.equal(selected.method, "debugger.detach");
      const detaches = records.filter(r => r.kind === "call" && r.method === "debugger.detach" && r.target?.targetId === owned.targetId);
      assert.equal(detaches.length, 2); assert.equal(detaches[0].sequence, selected.sequence); assert.equal(oneACK(records, detaches[0]).ok, true);
      assert.ok(detaches[1].sequence > delivery[0].sequence); const retryDetach = oneACK(records, detaches[1]); assert.equal(retryDetach.ok, false);
      assert.equal(retryDetach.error, `Error: Debugger is not attached to the target with id: ${owned.targetId}.`);
      const exactQueries = records.filter(r => r.kind === "call" && r.method === "Target.getTargetInfo" && r.target?.targetId === owned.targetId && r.sequence > delivery[0].sequence);
      assert.equal(exactQueries.length, 1); const absence = oneACK(records, exactQueries[0]); assert.equal(absence.ok, false);
      assert.ok(retryDetach.sequence < exactQueries[0].sequence);
      assert.ok([`Error: Debugger is not attached to the target with id: ${owned.targetId}.`, `Error: No target with given id ${owned.targetId}.`].includes(absence.error), "Only an original exact native absence error can retire cleanup");
    }
  }
  return { leaseId: owned.leaseId, targetId: owned.targetId, incarnation: ledger.incarnation, intentACK: intentACK.sequence, attachACK: attachACK.sequence };
}

export function checkColdPrivateTargetHeldInputRisk(item) {
  assert.equal(item.name, "worker-owned-intent-recovery");
  const original = item.beforeRestartProbe, riskKey = original.inputRiskKey, durable = item.heldLedger[riskKey];
  assert.equal(durable.version, 1); assert.equal(durable.risks.length, 1);
  const risk = durable.risks[0]; assert.equal(risk.tabId, item.tabId); assert.equal(risk.incarnation, item.heldLedger[original.ledgerKey].incarnation);
  assert.deepEqual(item.held.state.input, [{ tabId: item.tabId, sameAttachment: true, riskId: risk.riskId, inflight: 0,
    states: [{ target: { tabId: item.tabId }, buttons: ["left"], keys: [], x: 234, y: 184 }] }]);
  const input = original.records.filter(r => r.kind === "call" && r.method.startsWith("Input.")); assert.equal(input.length, 1);
  assert.deepEqual(input[0].params, { type: "mousePressed", x: 234, y: 184, button: "left", buttons: 1, clickCount: 1 });
  const inputACK = original.records.filter(r => r.kind === "native-settled" && r.call === input[0].sequence);
  assert.equal(inputACK.length, 1); assert.equal(inputACK[0].ok, true); assert.ok(inputACK[0].sequence > input[0].sequence);
  const marks = original.records.filter(r => r.kind === "call" && r.method === `storage.${original.storageArea}.set` && isDeepStrictEqual(r.values?.[riskKey], durable));
  assert.equal(marks.length, 1); const markACK = original.records.filter(r => r.kind === "native-settled" && r.call === marks[0].sequence);
  assert.equal(markACK.length, 1); assert.equal(markACK[0].ok, true); assert.ok(markACK[0].sequence < input[0].sequence);
  return { riskKey, durable, risk };
}

export function checkColdPrivateTargetWorkerControl(item) {
  const { riskKey, durable, risk } = checkColdPrivateTargetHeldInputRisk(item);
  assert.deepEqual(item.recoveredLedger[riskKey], durable);
  assert.deepEqual(item.controlAfterRestart.inputRisks, durable.risks); assert.deepEqual(item.controlAfterRestart.recoveredInputRiskIds, [risk.riskId]);
  assert.equal(item.controlAfterRestart.engineAbsent, true);
  assert.equal(item.controlAfterRestart.status.inputBlocked, true);
  assert.equal(item.controlAfterRestart.status.cleanupComplete, false);
  assert.match(item.controlAfterRestart.status.error, /^OBU_INPUT_RELEASE_UNCONFIRMED:/);
  assert.deepEqual(item.controlAfterRestart.status.inputRecovery, { action: "close-controlled-pages" });
  assert.equal(item.beginTurnOutcome.ok, false); assert.match(item.beginTurnOutcome.error, /^OBU_AUTOMATION_PAUSED:/);
  assert.deepEqual(item.scopeAfterRejectedBegin, item.scope, "Rejected bootstrap must not replace the original caller binding");
  assert.deepEqual(item.finalizeRequest, { ...item.scope, keep: [] });
  assert.equal(item.finalizeOutcome.ok, false);
  assert.match(item.finalizeOutcome.error, /^OBU_(?:AUTOMATION_PAUSED|STALE_CONTROL_EPOCH|TURN_ENDED):/);
  assert.equal(item.exactTabClosed, true);
  assert.deepEqual(item.inputRiskAfterClose.durable[riskKey], { version: 1, risks: [] });
  assert.deepEqual(item.inputRiskAfterClose.records, []); assert.deepEqual(item.inputRiskAfterClose.recovered, []);
  assert.equal(item.probe.records.some(r => r.kind === "call" && r.method.startsWith("Input.")), false);
  return { authority: "constructor cleanup-only recovery; original root input risk remains blocked", beginTurnRejected: true, originalFinalizeRejected: true };
}

async function readDocuments(worker, tabId, frames) {
  const rows = await worker.evaluate(`chrome.scripting.executeScript({target:{tabId:${tabId},documentIds:${json(frames.map(f => f.documentId))}},world:'MAIN',func:()=>window.coldPrivateTargetState?.()})`);
  return frames.map(frame => { const found = rows.filter(row => row.documentId === frame.documentId && row.frameId === frame.frameId); assert.equal(found.length, 1); assert.ok(found[0].result); return found[0]; });
}

// Delivery failures retry the original public detach. After a real worker
// restart, the callback only observes constructor recovery; it must not invoke
// private recovery or clear the independent durable input-risk fence.
export async function checkColdPrivateTargetLifecycle({ connectBrowser, getWorker, restartWorker, recover, fixtureURL, fixtures, until, saveDetail, closeTab }) {
  assert.equal(typeof recover, "function", "Original recovery callback required");
  assert.equal(typeof closeTab, "function", "Exact-tab cleanup callback required");
  const observerOptions = await getWorker().evaluate(`(()=>{const p=globalThis.__obuColdPrivateTargets;if(!p)throw Error('Private lifecycle prefix was not installed');const {ledgerKey,initializedKey,inputRiskKey,storageArea}=p.snapshot();return {ledgerKey,initializedKey,inputRiskKey,storageArea}})()`);
  const detail = { cases: [], cleanupErrors: [], boundary: "Three isolated production-registry lifecycles. Native attach/group/detach actually run; selected original ACK delivery is deliberately held/rejected. Final worker replacement recovers only owned target cleanup and keeps unresolved original root input risk blocked. No natural native failure, old worker delivery settlement or autoattach coexistence is claimed." };
  let failure;
  for (const name of coldPrivateTargetCases) {
    const item = { name, key: `private-${randomUUID()}`, cleanupErrors: [] }; detail.cases.push(item);
    let owner, tab, caseFailure, restarted = false;
    const control = (method, args = []) => getWorker().evaluate(`(()=>{const p=globalThis.__obuColdPrivateTargets;if(!p)throw Error('Private lifecycle observer missing');return p[${json(method)}](...${json(args)})})()`);
    const cleanup = async (stage, fn) => { try { return await fn(); } catch (error) { item.cleanupErrors.push({ stage, error: errorText(error) }); caseFailure ??= error; } };
    try {
      if (detail.cases.length > 1) await getWorker().evaluate(`(${installColdPrivateTargetLifecycleProbe.toString()})(chrome,globalThis,${json(observerOptions)})`);
      owner = await connectBrowser(`cold-private-${name}`); await owner.client.beginTurn(`original-${name}`);
      tab = await owner.newTab(); item.tabId = tab.id; item.scope = scopeOf(owner);
      item.url = new URL(`/cold-private-target/page?key=${item.key}`, fixtureURL).href;
      await owner.cdp.navigate(tab.id, item.url);
      item.installation = await control("setRoot", [tab.id]); assert.equal(item.installation.state.registry?.enabled, true);
      await until(async () => { const frames = await getWorker().evaluate(`chrome.webNavigation.getAllFrames({tabId:${tab.id}})`); const root = frames.find(f => f.frameId === 0 && f.url === item.url), leaf = frames.find(f => f.parentFrameId === 0 && f.url.includes(`/cold-private-target/leaf?key=${item.key}`)); if (!root || !leaf) return false; item.frames = [root, leaf]; return true; }, "original private lifecycle documents", 5000);
      item.before = await readDocuments(getWorker(), tab.id, item.frames);
      const method = name === "worker-owned-intent-recovery" ? "debugger.attach" : name === "detach-delivery-rejection" ? "debugger.detach" : "Runtime.releaseObjectGroup";
      item.armed = await control("arm", [{ tabId: tab.id, method, rejectDelivery: name !== "worker-owned-intent-recovery" }]);
      item.inputParams = name === "worker-owned-intent-recovery"
        ? { type: "mousePressed", x: 234, y: 184, button: "left", buttons: 1, clickCount: 1 }
        : { type: "mouseMoved", x: 234, y: 184, buttons: 0 };
      item.inputOutcome = await outcome(owner.cdp.call(tab.id, "Input.dispatchMouseEvent", item.inputParams));
      await until(async () => { const p = await control("snapshot"); if (p.deliveryPending !== 1 || p.released) return false; item.held = p; return true; }, "original private native ACK held", 5000);
      item.after = await readDocuments(getWorker(), tab.id, item.frames);
      item.heldLedger = await getWorker().evaluate(`chrome.storage[${json(item.held.storageArea)}].get(${json([item.held.ledgerKey, item.held.inputRiskKey])})`);
      if (name === "worker-owned-intent-recovery") {
        item.beforeRestartProbe = await control("checkpoint", ["before-real-worker-restart"]);
        item.heldInputRiskProof = checkColdPrivateTargetHeldInputRisk(item);
        item.restart = await restartWorker(); restarted = true;
        item.recovery = await recover({ item, owner, reason: "same-browser-worker-recovery" });
        item.recoveryAuthority = "observed automatic constructor recovery";
        item.controlAfterRestart = await getWorker().evaluate(`(async()=>{const b=globalThis.__integrationBackend;await b.controlReady;return {engineAbsent:b.browserEngine===null,status:await b.getAutomationControlStatus(),inputRisks:[...b.browserLifetime.records.values()],recoveredInputRiskIds:[...b.browserLifetime.recovered]}})()`);
        item.beginTurnOutcome = await outcome(owner.client.beginTurn(`rejected-after-worker-${name}`));
        item.scopeAfterRejectedBegin = scopeOf(owner);
      } else {
        item.detachOutcome = await outcome(owner.client.request("detach", { ...item.scope, tabId: tab.id }, { timeoutMs: 1000 }));
        item.atDetach = await control("snapshot");
        await control("release", ["original-detach-outcome-observed"]);
        await until(async () => { const p = await control("snapshot"); if (p.deliveryPending || !p.state.registry?.failed.length) return false; item.failed = p; return true; }, "controlled delivery failure retained", 5000);
        item.recovery = await recover({ item, owner, reason: "controlled-delivery-failure" });
        item.recoveryAuthority = "explicit original public detach retry";
      }
      item.recoveredProbe = await control("checkpoint", [restarted ? "after-automatic-worker-recovery" : "after-explicit-detach-retry"]);
      item.recoveredLedger = await getWorker().evaluate(`chrome.storage[${json(item.recoveredProbe.storageArea)}].get(${json([item.recoveredProbe.ledgerKey, item.recoveredProbe.inputRiskKey])})`);
      item.after = await readDocuments(getWorker(), tab.id, item.frames);
    } catch (error) { caseFailure ??= error; item.error = errorText(error); }
    finally {
      await cleanup("release-gate", () => control("release", ["finally"]));
      await cleanup("original-recovery", async () => { const p = await control("snapshot"); if (p.state.registry?.leases.length || p.state.registry?.pending) item.cleanupRecovery = await recover({ item, owner, reason: restarted ? "same-browser-worker-recovery" : "finally" }); });
      await cleanup("native-and-delivery-drain", () => until(async () => { const p = await control("snapshot"); return p.nativePending === 0 && p.deliveryPending === 0; }, "private observer original drain", 5000));
      await cleanup("server-ledger", () => { item.server = fixtures.stats(item.key); });
      if (tab) await cleanup("close-original-tab", async () => { await closeTab(tab); item.exactTabClosed = true; });
      if (restarted) await cleanup("original-input-risk-removal", async () => {
        const riskId = item.heldInputRiskProof?.risk.riskId; assert.ok(riskId, "Original held risk proof must precede worker replacement");
        await until(async () => {
          item.inputRiskAfterClose = await getWorker().evaluate(`(async()=>{const b=__integrationBackend;return {durable:await chrome.storage.local.get(${json(observerOptions.inputRiskKey)}),records:[...b.browserLifetime.records.values()],recovered:[...b.browserLifetime.recovered]}})()`);
          const s = item.inputRiskAfterClose, saved = s.durable[observerOptions.inputRiskKey];
          return saved?.version === 1 && Array.isArray(saved.risks) && !saved.risks.some(r => r.riskId === riskId) && !s.records.some(r => r.riskId === riskId) && !s.recovered.includes(riskId);
        }, "original exact-tab destruction clears its durable input risk", 5000);
      });
      if (owner) {
        await cleanup("finalize-original-owner", async () => {
          if (restarted) {
            item.finalizeRequest = { ...item.scope, keep: [] };
            item.finalizeOutcome = await outcome(owner.client.request("finalizeTabs", item.finalizeRequest, { timeoutMs: 15000 }));
            assert.equal(item.finalizeOutcome.ok, false); assert.match(item.finalizeOutcome.error, /^OBU_(?:AUTOMATION_PAUSED|STALE_CONTROL_EPOCH|TURN_ENDED):/);
          } else item.finalized = await owner.client.finalizeTabs([]);
        });
        await cleanup("close-owner", () => owner.close());
      }
      await cleanup("exact-target-cleanup", async () => { const current = await control("snapshot"), targetIds = [...new Set([...(item.beforeRestartProbe?.records ?? []), ...current.records].filter(r => r.kind === "call" && r.method === "debugger.attach" && r.target?.targetId).map(r => r.target.targetId))]; item.cleanupInventory = await getWorker().evaluate(`(async()=>({tabs:(await chrome.tabs.query({})).filter(t=>t.id===${item.tabId ?? -1}),targets:(await chrome.debugger.getTargets()).filter(t=>t.tabId===${item.tabId ?? -1}||${json(targetIds)}.includes(t.id))}))()`); assert.deepEqual(item.cleanupInventory, { tabs: [], targets: [] }); });
      await cleanup("final-native-drain", () => until(async () => { const p = await control("snapshot"); return p.nativePending === 0 && p.deliveryPending === 0; }, "original close/finalize native drain", 5000));
      await cleanup("restore-observer", async () => { item.probe = await control("restore"); });
    }
    if (!caseFailure) try {
      checkColdPrivateTargetTrace(item.probe); if (restarted) { checkColdPrivateTargetTrace(item.beforeRestartProbe, { abandoned: true }); assert.notEqual(item.beforeRestartProbe.workerId, item.probe.workerId); }
      checkColdPrivateTargetBusiness(item);
      item.ownershipProof = checkColdPrivateTargetOwnership(item);
      if (restarted) item.workerControlProof = checkColdPrivateTargetWorkerControl(item);
      assert.equal(item.held.nativePending, 0);
      item.passed = true;
    } catch (error) { caseFailure = error; item.oracleError = errorText(error); }
    if (caseFailure) { item.passed = false; failure ??= caseFailure; }
    try { await saveDetail(detail); } catch (error) { detail.cleanupErrors.push({ stage: "save", error: errorText(error) }); failure ??= error; }
  }
  detail.passed = !failure; if (failure) detail.error = errorText(failure);
  try { await saveDetail(detail); } catch (error) { failure ??= error; }
  if (failure) throw failure; return detail;
}
