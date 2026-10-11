import assert from "node:assert/strict";

export function nativeDiagnosticsEnabled(value) {
  assert.ok(value === undefined || value === "" || value === "0" || value === "1", "OBU_TEST_NATIVE_DIAGNOSTICS must be unset, 0, or 1");
  return value === "1";
}

// This entire function is serialized into the isolated worker only on opt-in.
// No production private state is read or browser action invoked during installation.
export function installNativeAPIDiagnostics(api, target, options = {}) {
  const key = "__obuNativeAPIDiagnostics";
  if (Object.hasOwn(target, key)) { target[key].duplicateInstallation(); return target[key]; }
  const maximumRecords = options.maximumRecords ?? 4096;
  if (!Number.isSafeInteger(maximumRecords) || maximumRecords < 1 || maximumRecords > 16384) throw new Error("Invalid native diagnostic capacity");
  const maximumTraceCharacters = options.maximumTraceCharacters ?? 4 * 1024 * 1024, maximumRecordCharacters = 16384;
  if (!Number.isSafeInteger(maximumTraceCharacters) || maximumTraceCharacters < 1 || maximumTraceCharacters > 16 * 1024 * 1024) throw new Error("Invalid native diagnostic character budget");
  const clock = options.clock ?? Date.now, nativeThen = Promise.prototype.then;
  const records = [], pending = new Map(), installed = [], listeners = [], installErrors = [];
  let sequence = 0, callSerial = 0, dropped = 0, recordingErrors = 0, unknownSettlements = 0, duplicateInstallations = 0, payloadTruncations = 0, retainedCharacters = 0;
  const recordingErrorSamples = [];
  const recordFailure = () => { recordingErrors++; if (recordingErrorSamples.length < 12) recordingErrorSamples.push({ sequence, reason: "diagnostic serialization, clock, or record operation failed" }); };
  const time = () => { try { return clock(); } catch { recordFailure(); return null; } };
  const startedAt = time();
  let bootId; try { bootId = target.crypto.randomUUID(); } catch { bootId = `${Date.now()}-${Math.random().toString(36).slice(2)}`; }
  function copy(value, budget = { nodes: 160, characters: 4096 }, depth = 0) {
    if (--budget.nodes < 0 || depth > 5) { payloadTruncations++; return { diagnosticTruncated: true, reason: "node/depth limit" }; }
    if (value === null || typeof value === "boolean" || typeof value === "number") return value;
    if (typeof value === "undefined") return { diagnosticType: "undefined" };
    if (typeof value === "string") {
      const limit = Math.min(512, Math.max(0, budget.characters)); budget.characters -= Math.min(value.length, limit);
      if (value.length <= limit) return value;
      payloadTruncations++; return { diagnosticTruncated: true, length: value.length, preview: value.slice(0, limit) };
    }
    if (typeof value !== "object") return { diagnosticType: typeof value };
    // Inspect own data properties only. Never invoke application getters while
    // observing an argument/result; failure remains diagnostic, not API failure.
    const descriptors = Object.getOwnPropertyDescriptors(value), array = Array.isArray(value);
    const keys = array ? Array.from({ length: Math.min(descriptors.length.value, 24) }, (_, index) => String(index)) : Object.keys(descriptors).slice(0, 24);
    const result = array ? [] : Object.create(null);
    for (const key of keys) {
      if (budget.nodes <= 0 || budget.characters <= 0) { payloadTruncations++; if (array) result.push({ diagnosticTruncated: true, reason: "payload budget" }); else result.__diagnosticTruncated = { reason: "payload budget" }; break; }
      const descriptor = descriptors[key];
      const savedKey = key.length <= 128 ? key : `${key.slice(0, 112)}[truncated-key]`;
      if (savedKey !== key) payloadTruncations++;
      budget.characters -= savedKey.length;
      result[savedKey] = descriptor && Object.hasOwn(descriptor, "value") ? copy(descriptor.value, budget, depth + 1) : { diagnosticType: descriptor ? "accessor-not-read" : "array-hole" };
    }
    const count = array ? descriptors.length.value : Object.keys(descriptors).length;
    if (count > 24) { payloadTruncations++; if (array) result.push({ diagnosticTruncated: true, reason: "item limit", count }); else result.__diagnosticTruncated = { reason: "property limit", count }; }
    return result;
  }
  function append(value) {
    const index = sequence++;
    if (records.length >= maximumRecords) { dropped++; return index; }
    const record = { sequence: index, at: time(), ...value };
    let serialized = JSON.stringify(record);
    if (serialized.length > maximumRecordCharacters) {
      payloadTruncations++;
      for (const field of ["args", "params", "result", "error", "grouping"]) delete record[field];
      record.payload = { diagnosticTruncated: true, reason: "record character limit", originalCharacters: serialized.length };
      serialized = JSON.stringify(record);
    }
    if (serialized.length > maximumRecordCharacters || retainedCharacters + serialized.length > maximumTraceCharacters) { dropped++; return index; }
    retainedCharacters += serialized.length; records.push(record); return index;
  }
  function safe(run) { try { return run(); } catch { recordFailure(); return undefined; } }
  const identity = (name, args) => {
    const value = { api: name };
    if (name.startsWith("debugger.")) { value.target = copy(args[0]); if (name === "debugger.sendCommand") value.method = copy(args[1]); }
    else if (name.startsWith("tabGroups.")) value.groupId = copy(args[0]);
    else if (name === "tabs.group") value.grouping = copy(args[0]);
    return value;
  };
  for (const [namespace, method] of [["tabs", "create"], ["tabs", "group"], ["tabGroups", "get"], ["tabGroups", "update"], ["debugger", "attach"], ["debugger", "detach"], ["debugger", "sendCommand"]]) {
    const name = `${namespace}.${method}`;
    try {
      const receiver = api[namespace], original = receiver?.[method];
      if (typeof original !== "function") throw new Error("API unavailable");
      function traced(...args) {
        const callId = ++callSerial;
        let scope = { api: name }, startSequence;
        safe(() => { scope = identity(name, args); startSequence = append({ kind: "start", callId, ...scope, args: copy(args) }); if (pending.size < maximumRecords) pending.set(callId, { callId, ...scope, startSequence }); else dropped++; });
        const finish = (kind, value) => safe(() => { pending.delete(callId); append({ kind, callId, ...scope, ...(kind === "settled" ? { result: copy(value) } : { error: copy(value) }) }); });
        let result;
        try { result = Reflect.apply(original, this, args); }
        catch (error) { finish("error", error); throw error; }
        try {
          // Observe on a side chain, then return the exact original Promise.
          // Non-Promise/callback APIs are not adapted or called a second time.
          nativeThen.call(result, value => { finish("settled", value); }, error => { finish("error", error); });
        } catch {
          safe(() => { pending.delete(callId); unknownSettlements++; append({ kind: "settlement-unobserved", callId, ...scope, reason: "API returned no native Promise; original arguments and callbacks were left untouched" }); });
        }
        return result;
      }
      receiver[method] = traced;
      if (receiver[method] !== traced) throw new Error("API wrapper assignment not retained");
      installed.push({ name, receiver, method, original, traced });
    } catch { installErrors.push({ api: name, reason: "API unavailable or wrapper installation failed" }); }
  }
  for (const [namespace, events] of [["tabs", ["onCreated", "onUpdated", "onRemoved", "onAttached", "onDetached", "onMoved", "onReplaced", "onActivated"]], ["tabGroups", ["onCreated", "onUpdated", "onRemoved", "onMoved"]]]) for (const event of events) {
    const name = `${namespace}.${event}`;
    try {
      const source = api[namespace]?.[event]; if (typeof source?.addListener !== "function") throw new Error("Event unavailable");
      const listener = (...args) => safe(() => append({ kind: "event", event: name, args: copy(args) }));
      source.addListener(listener); listeners.push({ name, source, listener });
    } catch { installErrors.push({ event: name, reason: "Passive event listener unavailable" }); }
  }
  for (const event of ["onEvent", "onDetach"]) {
    const name = `debugger.${event}`;
    try {
      const source = api.debugger?.[event]; if (typeof source?.addListener !== "function") throw new Error("Event unavailable");
      const listener = (...args) => safe(() => {
        if (event === "onEvent" && !/^(?:Page\.(?:frame|documentOpened|lifecycleEvent|domContentEventFired|loadEventFired)|Runtime\.executionContext|Target\.(?:attachedToTarget|detachedFromTarget)$|Inspector\.detached$)/.test(args[1])) return;
        append({ kind: "event", event: name, target: copy(args[0]), ...(event === "onEvent" ? { method: copy(args[1]), params: copy(args[2]) } : { reason: copy(args[1]) }) });
      });
      source.addListener(listener); listeners.push({ name, source, listener });
    } catch { installErrors.push({ event: name, reason: "Passive debugger event listener unavailable" }); }
  }
  const controller = Object.freeze({
    duplicateInstallation() { duplicateInstallations++; },
    snapshot() {
      return JSON.parse(JSON.stringify({ version: 1, bootId, startedAt, capturedAt: time(), maximumRecords, maximumRecordCharacters, maximumTraceCharacters, retainedCharacters, nextSequence: sequence, callCount: callSerial, overflow: dropped > 0, dropped, recordingErrors, recordingErrorSamples, unknownSettlements, duplicateInstallations, payloadTruncations, installErrors, apis: installed.map(value => value.name), events: listeners.map(value => value.name), pending: [...pending.values()], records,
        boundary: "This worker incarnation after observer installation only, up to capturedAt. Bounded payload excerpts are marked and do not establish omitted values. Pending commands have unknown outcomes at capture. Serialization and Promise side-chain observers add diagnostic work and may affect scheduling or unhandled-rejection reporting; this is not a timing-neutral reproduction. Original receiver, arguments, return Promise and thrown/rejected values are preserved; no retry, activation, wait, input substitute, or production private-map access." }));
    },
    restore() {
      for (const value of installed) safe(() => { if (value.receiver[value.method] !== value.traced) throw new Error("Wrapper replaced externally"); value.receiver[value.method] = value.original; });
      for (const value of listeners) safe(() => value.source.removeListener(value.listener));
      return this.snapshot();
    },
  });
  Object.defineProperty(target, key, { value: controller, configurable: true }); return controller;
}

export function nativeDiagnosticPrelude() {
  return `// Explicit isolated native diagnostics: API observation only, never acceptance.\n;try { (${installNativeAPIDiagnostics.toString()})(chrome,globalThis); } catch { /* Missing snapshot fails diagnostic completeness; do not block production startup. */ }\n`;
}

export function nativeDiagnosticTraceComplete(initial, final) {
  if (!initial || !final || initial.version !== 1 || final.version !== 1 || typeof initial.bootId !== "string" || initial.bootId !== final.bootId) return false;
  for (const value of [initial, final]) {
    if (value.overflow !== false || value.dropped !== 0 || value.recordingErrors !== 0 || value.unknownSettlements !== 0 || value.duplicateInstallations !== 0 || value.installErrors?.length !== 0) return false;
    if (!Array.isArray(value.records) || !Array.isArray(value.pending) || value.records.length !== value.nextSequence || value.records.some((record, index) => record.sequence !== index || !Number.isFinite(record.at))) return false;
    const expectedAPIs = ["tabs.create", "tabs.group", "tabGroups.get", "tabGroups.update", "debugger.attach", "debugger.detach", "debugger.sendCommand"];
    const expectedEvents = ["tabs.onCreated", "tabs.onUpdated", "tabs.onRemoved", "tabs.onAttached", "tabs.onDetached", "tabs.onMoved", "tabs.onReplaced", "tabs.onActivated", "tabGroups.onCreated", "tabGroups.onUpdated", "tabGroups.onRemoved", "tabGroups.onMoved", "debugger.onEvent", "debugger.onDetach"];
    if (JSON.stringify(value.apis) !== JSON.stringify(expectedAPIs) || JSON.stringify(value.events) !== JSON.stringify(expectedEvents)) return false;
    const lengths = value.records.map(record => JSON.stringify(record).length);
    if (lengths.some(length => length > value.maximumRecordCharacters) || lengths.reduce((sum, length) => sum + length, 0) !== value.retainedCharacters || value.retainedCharacters > value.maximumTraceCharacters) return false;
    const open = new Map(); let callCount = 0;
    for (const record of value.records) {
      if (record.kind === "start") { if (record.callId !== ++callCount) return false; open.set(record.callId, record); }
      else if (record.kind === "settled" || record.kind === "error") {
        const start = open.get(record.callId);
        if (!start || start.api !== record.api || start.method !== record.method || JSON.stringify(start.target) !== JSON.stringify(record.target)) return false;
        open.delete(record.callId);
      } else if (record.kind !== "event") return false;
    }
    if (value.callCount !== callCount || value.pending.length !== open.size) return false;
    for (const pending of value.pending) { const start = open.get(pending.callId); if (!start || pending.startSequence !== start.sequence || pending.api !== start.api || pending.method !== start.method || JSON.stringify(pending.target) !== JSON.stringify(start.target)) return false; open.delete(pending.callId); }
  }
  return final.nextSequence >= initial.nextSequence && JSON.stringify(final.records.slice(0, initial.records.length)) === JSON.stringify(initial.records);
}

export function nativeDiagnosticResult({ enabled, acceptancePassed, taskReached, traceComplete, cleanupComplete }) {
  if (!enabled) return { passed: acceptancePassed, exitCode: acceptancePassed ? 0 : 1 };
  const diagnosticCompleted = taskReached === true && traceComplete === true && cleanupComplete === true;
  return { passed: false, diagnosticCompleted, exitCode: diagnosticCompleted ? 0 : 1 };
}
