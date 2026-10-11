import assert from "node:assert/strict";

export const chooserDiagnosticCases = ["js-file-chooser-ready-two-connections", "js-raw-navigation-before-engine"];
export function chooserDiagnosticEnabled(env) {
  const value = env.OBU_TEST_CHOOSER_DIAGNOSTIC;
  assert.ok(value === undefined || value === "1", "OBU_TEST_CHOOSER_DIAGNOSTIC must be 1 or unset");
  if (value !== "1") return false;
  for (const name of ["OBU_TEST_CASES", "OBU_TEST_SNAPSHOT_GEOMETRY", "OBU_TEST_BACKGROUND_PARALLEL", "OBU_TEST_MEMORY_CLIPBOARD"])
    assert.equal(env[name], undefined, `Chooser diagnostic cannot be combined with ${name}`);
  return true;
}

// Serialized into the isolated worker on explicit opt-in. Never invokes an API
// action itself; the original receiver, arguments, Promise and errors survive.
export function installChooserDiagnostic(api, target, tabId, options = {}) {
  const kind = options.kind === undefined ? "chooser" : options.kind;
  if (!["chooser", "download"].includes(kind)) throw new Error("Invalid diagnostic kind");
  const key = kind === "download" ? "__obuDownloadDiagnostic" : "__obuChooserDiagnostic";
  if (Object.hasOwn(target, key)) throw new Error("Chooser diagnostic already installed");
  if (!Number.isSafeInteger(tabId) || tabId < 0) throw new Error("Invalid diagnostic tab");
  const maximumRecords = options.maximumRecords ?? 1024, maximumCharacters = options.maximumCharacters ?? 1024 * 1024;
  if (!Number.isInteger(maximumRecords) || maximumRecords < 1 || maximumRecords > 4096 ||
      !Number.isInteger(maximumCharacters) || maximumCharacters < 1 || maximumCharacters > 4 * 1024 * 1024) throw new Error("Invalid diagnostic bounds");
  const bootId = target.crypto.randomUUID(), startedAt = Date.now(), nativeThen = Promise.prototype.then;
  const records = [], pending = new Map(), errors = [];
  let nextSequence = 0, callSerial = 0, retainedCharacters = 0, dropped = 0, truncations = 0, recordingErrors = 0, unknownSettlements = 0, restored = false;
  const methods = new Set(["Page.frameAttached", "Page.frameNavigated", "Page.frameDetached", "Page.documentOpened", "Target.attachedToTarget", "Target.detachedFromTarget",
    ...(kind === "download" ? ["Page.downloadWillBegin", "Page.downloadProgress"] : ["Page.fileChooserOpened"])]);
  const command = kind === "download" ? /^(?:Input\.|Page\.(?:enable|disable)$|Runtime\.runIfWaitingForDebugger$)/ : /^(?:Input\.|Page\.(?:setInterceptFileChooserDialog|enable|disable)$|Runtime\.runIfWaitingForDebugger$)/;
  const copy = (value, budget = { nodes: 512, characters: 12000 }, depth = 0) => {
    if (--budget.nodes < 0 || depth > 10 || budget.characters <= 0) { truncations++; return { diagnosticTruncated: true }; }
    if (value === null || ["boolean", "number"].includes(typeof value)) return value;
    if (typeof value === "string") {
      const length = Math.min(2048, budget.characters); budget.characters -= Math.min(length, value.length);
      if (value.length <= length) return value;
      truncations++; return { diagnosticTruncated: true, length: value.length, preview: value.slice(0, length) };
    }
    if (typeof value !== "object") return { diagnosticType: typeof value };
    const descriptors = Object.getOwnPropertyDescriptors(value), array = Array.isArray(value);
    const keys = Object.keys(descriptors).filter(key => !(array && key === "length"));
    const result = array ? [] : Object.create(null);
    for (const key of keys.slice(0, 64)) {
      if (budget.nodes <= 0 || budget.characters <= 0) { truncations++; break; }
      budget.characters -= key.length;
      const descriptor = descriptors[key];
      result[key] = Object.hasOwn(descriptor, "value") ? copy(descriptor.value, budget, depth + 1) : { diagnosticType: "accessor-not-read" };
    }
    if (keys.length > 64) truncations++;
    return result;
  };
  const safe = operation => { try { return operation(); } catch { recordingErrors++; } };
  const append = value => {
    const sequence = nextSequence++;
    if (records.length >= maximumRecords) { dropped++; return sequence; }
    const record = { sequence, at: Date.now(), monotonicMs: performance.now(), ...value };
    const size = JSON.stringify(record).length;
    if (size > 16384 || retainedCharacters + size > maximumCharacters) { dropped++; return sequence; }
    retainedCharacters += size; records.push(record); return sequence;
  };
  const receiver = api.debugger, original = receiver.sendCommand;
  if (typeof original !== "function") throw new Error("Native sendCommand unavailable");
  function traced(...args) {
    // Data properties only: do not evaluate an application getter for filtering.
    let id;
    try { id = args[0] && Object.getOwnPropertyDescriptor(args[0], "tabId"); }
    catch { return Reflect.apply(original, this, args); }
    if (!id || id.value !== tabId || typeof args[1] !== "string" || !command.test(args[1]))
      return Reflect.apply(original, this, args);
    const callId = ++callSerial;
    let identity, startSequence;
    safe(() => {
      identity = { target: copy(args[0]), method: args[1] };
      startSequence = append({ kind: "start", callId, ...identity, params: copy(args[2]) });
      if (pending.size < maximumRecords) pending.set(callId, { callId, startSequence, ...identity }); else dropped++;
    });
    const finish = (kind, value) => safe(() => {
      pending.delete(callId);
      append({ kind, callId, ...identity, ...(kind === "settled" ? { result: copy(value) } : { error: copy(value) }) });
    });
    let result;
    try { result = Reflect.apply(original, this, args); }
    catch (error) { finish("error", error); throw error; }
    try { nativeThen.call(result, value => finish("settled", value), error => finish("error", error)); }
    catch { safe(() => { pending.delete(callId); unknownSettlements++; append({ kind: "settlement-unobserved", callId, ...identity }); }); }
    return result;
  }
  const listener = (source, method, params) => safe(() => {
    if (source.tabId === tabId && methods.has(method)) append({ kind: "event", source: copy(source), method, params: copy(params) });
  });
  const snapshot = () => JSON.parse(JSON.stringify({ version: 1, ...(kind === "download" ? { kind } : {}), bootId, tabId, startedAt, capturedAt: Date.now(),
    maximumRecords, maximumCharacters, maximumRecordCharacters: 16384, retainedCharacters, nextSequence,
    dropped, overflow: dropped > 0, truncations, recordingErrors, unknownSettlements, errors, restored,
    pending: [...pending.values()], records,
    boundary: "Exact tab, this worker incarnation, after installation only. Side-chain Promise observers and serialization can affect scheduling/unhandled rejection reporting; not timing-neutral. Failed-task reads occur later and cannot prove the click-time DOM or OS dialog state." }));
  try {
    receiver.sendCommand = traced;
    if (receiver.sendCommand !== traced) throw new Error("Native wrapper assignment not retained");
    receiver.onEvent.addListener(listener);
  } catch (error) {
    if (receiver.sendCommand === traced) receiver.sendCommand = original;
    throw error;
  }
  const controller = { snapshot, restore() {
    if (!restored) {
      if (receiver.sendCommand !== traced) errors.push("Wrapper replaced externally; foreign wrapper left intact");
      else { try { receiver.sendCommand = original; if (receiver.sendCommand !== original) throw new Error("Restore not retained"); } catch (error) { errors.push(String(error)); } }
      try { receiver.onEvent.removeListener(listener); } catch (error) { errors.push(String(error)); }
      restored = errors.length === 0;
    }
    return snapshot();
  } };
  target[key] = controller;
  return snapshot();
}

export function chooserTraceComplete(trace) {
  if (!trace || trace.version !== 1 || !trace.bootId || trace.overflow || trace.dropped || trace.truncations || trace.recordingErrors || trace.unknownSettlements || trace.errors.length || trace.pending.length) return false;
  if (trace.records.length !== trace.nextSequence || trace.records.some((record, index) => record.sequence !== index)) return false;
  const starts = new Map();
  for (const record of trace.records) {
    if (record.kind === "start") { if (starts.has(record.callId)) return false; starts.set(record.callId, record); }
    else if (["settled", "error"].includes(record.kind)) {
      const start = starts.get(record.callId);
      if (!start || start.method !== record.method || JSON.stringify(start.target) !== JSON.stringify(record.target)) return false;
      starts.delete(record.callId);
    } else if (record.kind !== "event") return false;
  }
  return starts.size === 0;
}

export function chooserChildTarget(trace, initialAttachments = []) {
  const sessions = new Map();
  for (const entry of initialAttachments) if (entry.tabId === trace.tabId && entry.type === "iframe" && typeof entry.sessionId === "string" && entry.source?.tabId === trace.tabId)
    sessions.set(entry.sessionId, { sessionId: entry.sessionId, targetId: entry.targetId, parentSessionId: entry.source.sessionId ?? null });
  for (const event of trace.records.filter(record => record.kind === "event")) {
    if (event.method === "Target.attachedToTarget" && event.params.targetInfo?.type === "iframe")
      sessions.set(event.params.sessionId, { sessionId: event.params.sessionId, targetId: event.params.targetInfo.targetId, parentSessionId: event.source.sessionId ?? null });
    if (event.method === "Target.detachedFromTarget") sessions.delete(event.params.sessionId);
  }
  const candidates = [...sessions.values()].filter(entry => entry.parentSessionId === null);
  return { status: candidates.length === 1 ? "unique-observed-child" : "unknown", candidates, target: candidates.length === 1 ? { tabId: trace.tabId, sessionId: candidates[0].sessionId } : null };
}

// Read only, in the current document. Root native coordinates are never applied
// to a child viewport. A child's center hit is labeled as a later observation.
export function chooserDocumentObservation(point) {
  const rect = element => element ? element.getBoundingClientRect().toJSON() : null;
  const describe = element => element ? { tag: element.tagName, id: element.id, type: element.getAttribute("type") } : null;
  const input = document.querySelector("#upload"), box = rect(input);
  const center = box && { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  return { at: Date.now(), href: location.href, readyState: document.readyState, hasFocus: document.hasFocus(), visibility: document.visibilityState,
    viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY, devicePixelRatio },
    chooserEvidence: typeof chooserEvidence === "object" ? chooserEvidence : null,
    activeElement: describe(document.activeElement), input: input ? { node: describe(input), rect: box, disabled: input.disabled, files: input.files.length } : null,
    frames: [...document.querySelectorAll("iframe")].map(frame => ({ node: describe(frame), src: frame.src, rect: rect(frame) })),
    nativeRootPoint: point, nativeRootHit: point ? describe(document.elementFromPoint(point.x, point.y)) : null,
    laterInputCenter: center, laterInputCenterHit: center ? describe(document.elementFromPoint(center.x, center.y)) : null };
}

export function createChooserDiagnostic({ worker, readFocus }) {
  const errors = [];
  const read = expression => worker.evaluate(expression);
  const traceExpression = "globalThis.__obuChooserDiagnostic?.snapshot()";
  async function within(deadline, operation) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Diagnostic observation budget expired before send");
    let timer;
    try {
      const result = await Promise.race([operation(remaining), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Diagnostic observation budget expired; read outcome unknown")), remaining);
      })]);
      if (Date.now() >= deadline) throw new Error("Diagnostic observation settled after original diagnostic budget");
      return result;
    } finally { clearTimeout(timer); }
  }
  return {
    errors,
    async start({ owner, item }) {
      const scope = { session_id: owner.client.sessionId, turn_id: owner.client.turnId, control_epoch: owner.client.controlEpoch };
      const value = item.diagnostic = { version: 1, scope, tabId: item.tabId, startedAt: Date.now(), failureRead: null };
      value.initialAttachments = await read(`globalThis.__integrationFrames.filter(entry=>entry.tabId===${item.tabId})`);
      value.installed = await read(`(${installChooserDiagnostic.toString()})(chrome,globalThis,${item.tabId})`);
    },
    async failure({ owner, item }) {
      const value = item.diagnostic;
      if (!value || value.failureRead) return;
      const requestedAt = Date.now(), deadline = requestedAt + 3000;
      const observation = value.failureRead = { requestedAt, deadline, budgetMs: 3000, reads: [], errors: [], timing: "After original failure, before original waiter cancellation and task finalization; one total budget for trace, native metadata, focus and DOM; no original deadline is extended" };
      try {
        observation.trace = await within(deadline, () => read(traceExpression));
        if (!observation.trace || observation.trace.bootId !== value.installed.bootId) throw new Error("Diagnostic worker incarnation missing or changed");
        // Independent read-only APIs are all issued together. A late metadata
        // result cannot issue another API after the outer budget has expired.
        observation.nativeState = await within(deadline, () => read(`(async()=>{const capture=async fn=>{try{return{value:await fn()}}catch(error){return{error:String(error)}}};const requestedAt=Date.now();const [tab,windows,currentWindow,frames]=await Promise.all([capture(()=>chrome.tabs.get(${item.tabId})),capture(()=>chrome.windows.getAll({populate:false})),capture(()=>chrome.windows.getCurrent({populate:false})),capture(()=>chrome.webNavigation.getAllFrames({tabId:${item.tabId}}))]);return{requestedAt,completedAt:Date.now(),tab,windows,currentWindow,frames}})()`));
        try { observation.focus = await within(deadline, () => readFocus()); } catch (error) { observation.errors.push({ kind: "focus-read", error: String(error) }); }
        observation.child = chooserChildTarget(observation.trace, value.initialAttachments);
        const lastPress = observation.trace.records.filter(record => record.kind === "start" && record.method === "Input.dispatchMouseEvent" && record.params?.type === "mousePressed" && record.target.sessionId === undefined).at(-1);
        const point = Number.isFinite(lastPress?.params?.x) && Number.isFinite(lastPress?.params?.y) ? { x: lastPress.params.x, y: lastPress.params.y, commandSequence: lastPress.sequence } : null;
        const targets = [{ tabId: item.tabId }, ...(item.variant === "root" || !observation.child.target ? [] : [observation.child.target])];
        for (const target of targets) {
          const record = { target, requestedAt: Date.now() }; observation.reads.push(record);
          const timeoutMs = deadline - Date.now();
          if (timeoutMs <= 0) { record.error = "Diagnostic DOM-read budget expired before send"; record.skipped = true; continue; }
          try {
            record.result = await within(deadline, remaining => owner.client.request("executeCdp", { ...value.scope, target, method: "Runtime.evaluate", commandParams: {
              expression: `(${chooserDocumentObservation.toString()})(${JSON.stringify(target.sessionId ? null : point)})`, returnByValue: true, awaitPromise: false
            }, timeoutMs: remaining }, { timeoutMs: remaining }));
            record.completedAt = Date.now();
          } catch (error) { record.error = String(error); record.failedAt = Date.now(); }
        }
      } catch (error) { observation.errors.push({ kind: "diagnostic-read", error: String(error) }); }
      observation.completedAt = Date.now();
      const expectedReads = item.variant === "root" ? 1 : 2;
      observation.complete = observation.completedAt < deadline && observation.errors.length === 0 &&
        ["tab", "windows", "currentWindow", "frames"].every(key => observation.nativeState?.[key] && !observation.nativeState[key].error) &&
        !!observation.focus && observation.reads.length === expectedReads && observation.reads.every(record =>
          !record.error && !record.result?.exceptionDetails && record.result?.result?.value?.chooserEvidence?.documentToken);
    },
    async finish({ item }) {
      const value = item.diagnostic;
      if (!value) return;
      try {
        value.trace = await within(Date.now() + 1500, () => read("(()=>{const probe=globalThis.__obuChooserDiagnostic;if(!probe)throw new Error('Chooser diagnostic lost');const trace=probe.restore();if(trace.restored)delete globalThis.__obuChooserDiagnostic;return trace})()"));
        value.traceComplete = value.trace.bootId === value.installed.bootId && value.trace.restored && chooserTraceComplete(value.trace);
        value.observationComplete = !value.failureRead || value.failureRead.complete === true;
        value.collectionComplete = value.traceComplete && value.observationComplete;
      } catch (error) { value.collectionComplete = false; value.error = String(error); errors.push(String(error)); }
      value.completedAt = Date.now();
    }
  };
}
