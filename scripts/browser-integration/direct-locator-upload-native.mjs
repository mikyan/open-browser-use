import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

// Opt-in acceptance observer. Exact tab, bounded copying, unchanged original
// receiver/arguments/Promise/errors. Promise sidechains can affect scheduling.
export function installDirectUploadProbe(api, target, { id, tabId }) {
  if (target.__obuDirectUploadClosed?.has(id)) throw Error("Direct upload installation was cancelled");
  if (target.__obuDirectUpload) throw Error("Direct upload probe already installed");
  const original = api.debugger.sendCommand, records = [], errors = [];
  let sequence = 0, pending = 0, overflow = false, total = 0, restored = false;
  const copy = value => {
    const json = JSON.stringify(value ?? {});
    if (json.length > 160000) throw Error("Direct upload observation payload exceeds bound");
    return JSON.parse(json);
  };
  const append = value => {
    const record = { sequence: ++sequence, at: Date.now(), ...value };
    try {
      const copied = copy(record); total += JSON.stringify(copied).length;
      if (records.length >= 2048 || total > 8 * 1024 * 1024) overflow = true; else records.push(copied);
    } catch (error) { if (errors.length < 16) errors.push(String(error)); else overflow = true; }
    return record.sequence;
  };
  const selected = method => method.startsWith("Input.") || ["DOM.setFileInputFiles", "DOM.resolveNode", "DOM.describeNode", "Page.createIsolatedWorld", "Runtime.callFunctionOn", "Runtime.releaseObject"].includes(method);
  function wrapper(...args) {
    const [source, method, params] = args;
    if (source?.tabId !== tabId || !selected(method)) return Reflect.apply(original, this, args);
    const call = append({ kind: "send", source, method, params: params ?? {} }); pending++;
    let native;
    try { native = Reflect.apply(original, this, args); }
    catch (error) { pending--; append({ kind: "settled", call, ok: false, error: String(error) }); throw error; }
    // Keep only native identity/result shape; bytes are proven independently by
    // the original HTTP body and FileList, never by this observer's copied value.
    Promise.resolve(native).then(value => { pending--; append({ kind: "settled", call, ok: true, result: {
      ...(value?.executionContextId !== undefined ? { executionContextId: value.executionContextId } : {}),
      ...(value?.object ? { object: value.object } : {}),
      ...(value?.node ? { node: value.node } : {}),
      ...(value?.exceptionDetails ? { exceptionDetails: value.exceptionDetails } : {}),
      ...(value?.result ? { result: { type: value.result.type, subtype: value.result.subtype, objectId: value.result.objectId,
        ...(typeof value.result.value === "number" || typeof value.result.value === "boolean" ? { value: value.result.value } : {}) } } : {}),
    } }); }, error => { pending--; append({ kind: "settled", call, ok: false, error: String(error) }); }).catch(error => { if (errors.length < 16) errors.push(String(error)); else overflow = true; });
    return native;
  }
  const listener = (source, method, params) => {
    if (source?.tabId === tabId && ["Page.fileChooserOpened", "Page.frameNavigated", "Page.documentOpened", "Target.attachedToTarget", "Target.detachedFromTarget"].includes(method)) append({ kind: "event", source, method, params });
  };
  api.debugger.sendCommand = wrapper;
  if (api.debugger.sendCommand !== wrapper) throw Error("Direct upload native wrapper is not writable");
  api.debugger.onEvent.addListener(listener);
  // Snapshot has a larger aggregate bound than each individual copied record.
  const all = () => JSON.parse(JSON.stringify({ id, tabId, records, pending, overflow, errors, restored }));
  target.__obuDirectUpload = { id, tabId, snapshot: all, restore() {
    if (target.__obuDirectUpload !== this || api.debugger.sendCommand !== wrapper) throw Error("Direct upload probe identity changed");
    api.debugger.sendCommand = original; api.debugger.onEvent.removeListener(listener); restored = true;
    const value = all(); delete target.__obuDirectUpload; return value;
  } };
  return { id, tabId, installed: true };
}

export function checkDirectUploadNative(probe, item, expectedPaths) {
  assert.equal(probe.tabId, item.tabId); assert.equal(probe.restored, true); assert.equal(probe.overflow, false); assert.equal(probe.pending, 0); assert.deepEqual(probe.errors, []);
  assert.deepEqual(probe.records.map(record => record.sequence), Array.from({ length: probe.records.length }, (_, index) => index + 1));
  const sends = probe.records.filter(record => record.kind === "send");
  for (const send of sends) {
    assert.equal(send.source.tabId, item.tabId);
    const settled = probe.records.filter(record => record.kind === "settled" && record.call === send.sequence); assert.equal(settled.length, 1); assert.ok(settled[0].sequence > send.sequence);
  }
  assert.equal(sends.filter(record => record.method.startsWith("Input.")).length, 0, "Direct upload must not send input");
  assert.equal(probe.records.filter(record => record.method === "Page.fileChooserOpened").length, 0, "Direct upload opened a chooser");
  const writes = sends.filter(record => record.method === "DOM.setFileInputFiles"); assert.equal(writes.length, 1);
  if (item.variant === "root" || item.variant === "same") assert.equal(writes[0].source.sessionId, undefined);
  if (item.variant === "dynamic-oopif") {
    assert.ok(typeof writes[0].source.sessionId === "string" && writes[0].source.sessionId.length > 0);
    const targets = item.frameEvidence.targets.filter(target => target.url === item.before.href && target.attached === true); assert.equal(targets.length, 1);
    const attachments = probe.records.filter(record => record.method === "Target.attachedToTarget" && record.params.targetInfo?.type === "iframe" && record.params.sessionId === writes[0].source.sessionId && record.params.targetInfo?.targetId === targets[0].id);
    assert.equal(attachments.length, 1, "Mutation session must be the exact native child target");
  }
  assert.deepEqual(writes[0].params.files, expectedPaths);
  assert.ok(Number.isSafeInteger(writes[0].params.backendNodeId));
  assert.equal(probe.records.find(record => record.kind === "settled" && record.call === writes[0].sequence).ok, true);
  const clears = sends.filter(record => record.method === "Runtime.callFunctionOn" && /this\.value\s*=\s*["']{2}/.test(record.params.functionDeclaration ?? ""));
  assert.equal(clears.length, 1, "Exact original clear mutation must occur once");
  const writeACK = probe.records.find(record => record.kind === "settled" && record.call === writes[0].sequence);
  assert.ok(clears[0].sequence > writeACK.sequence);
  const ack = probe.records.find(record => record.kind === "settled" && record.call === clears[0].sequence);
  assert.equal(ack.ok, true); assert.equal(ack.result.exceptionDetails, undefined); assert.equal(ack.result.result?.value, 0);
  assert.deepEqual(clears[0].source, writes[0].source);
  const resolution = sends.filter(record => record.method === "DOM.resolveNode" && record.params.backendNodeId === writes[0].params.backendNodeId &&
    record.source.tabId === clears[0].source.tabId && record.source.sessionId === clears[0].source.sessionId).find(record => probe.records.some(ack => ack.kind === "settled" && ack.call === record.sequence && ack.ok &&
      ack.result?.object?.objectId === clears[0].params.objectId && ack.sequence < clears[0].sequence));
  assert.ok(resolution, "Clear object was not resolved from the same exact backend node");
  item.native = probe;
  return { writes: 1, clears: 1, inputCommands: 0, chooserEvents: 0, target: writes[0].source, backendNodeId: writes[0].params.backendNodeId };
}

// Parent only: these hooks cannot execute the business SDK action. The handshake
// installs an exact-tab observer before goto, so this is not a cold-timing claim.
export function createDirectUploadObserver(worker) {
  const entries = new Map(); let current = null;
  const expression = (id, method) => `(()=>{const probe=globalThis.__obuDirectUpload;if(!probe||probe.id!==${JSON.stringify(id)})throw Error('Direct upload probe replaced');return probe.${method}()})()`;
  return {
    entries,
    async start(item) {
      assert.equal(current, null); assert.ok(Number.isSafeInteger(item.tabId) && item.tabId >= 0); assert.equal(entries.has(item.key), false);
      const id = randomUUID(), record = { id, key: item.key, variant: item.variant, tabId: item.tabId }; entries.set(item.key, record); current = record;
      record.installed = await worker.evaluate(`(${installDirectUploadProbe.toString()})(chrome,globalThis,${JSON.stringify({ id, tabId: item.tabId })})`);
    },
    async finish(item) {
      const record = entries.get(item.key); assert.ok(record && current === record && record.tabId === item.tabId);
      try {
        record.frames = await worker.evaluate(`(async()=>({tab:await chrome.tabs.get(${item.tabId}),frames:await chrome.webNavigation.getAllFrames({tabId:${item.tabId}}),targets:await chrome.debugger.getTargets()}))()`);
      } finally {
        record.probe = await worker.evaluate(expression(record.id, "restore")); current = null;
      }
    },
    async cleanup() {
      if (!current) return; const record = current;
      record.probe = await worker.evaluate(`(()=>{const id=${JSON.stringify(record.id)};const closed=globalThis.__obuDirectUploadClosed??=new Set();if(closed.size>=128)throw Error('Direct upload tombstone capacity');closed.add(id);const probe=globalThis.__obuDirectUpload;if(!probe)return null;if(probe.id!==id)throw Error('Foreign direct upload probe');return probe.restore()})()`); current = null;
    },
  };
}

export function checkDirectUploadFrames(item, observed, { active = false } = {}) {
  assert.equal(observed.tab.id, item.tabId); assert.equal(observed.tab.active, active);
  const roots = observed.frames.filter(frame => frame.frameId === 0); assert.equal(roots.length, 1);
  assert.equal(roots[0].url, item.url); assert.equal(roots[0].documentLifecycle, "active"); assert.equal(roots[0].errorOccurred, false);
  const url = new URL(item.url); if (item.variant !== "root") { url.pathname = "/direct-locator-upload/frame"; if (item.variant === "dynamic-oopif") url.hostname = "localhost"; }
  const target = observed.frames.filter(frame => frame.url === url.href); assert.equal(target.length, 1);
  assert.equal(target[0].documentLifecycle, "active"); assert.equal(target[0].errorOccurred, false);
  assert.equal(item.before.href, url.href);
  if (item.variant === "same") assert.equal(target[0].processId, roots[0].processId);
  if (item.variant === "dynamic-oopif") assert.notEqual(target[0].processId, roots[0].processId);
  item.frameEvidence = observed;
  return target[0];
}
