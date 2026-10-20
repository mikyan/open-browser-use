import assert from "node:assert/strict";

export function managedHumanNativeTraceEnabled(scenario, variant, value) {
  assert.ok(value === undefined || value === "0" || value === "1", "OBU_TEST_HUMAN_NATIVE_TRACE must be unset, 0, or 1");
  if (value === "1") { assert.equal(scenario, "new-page"); assert.equal(variant, "parent-navigate"); }
  return value === "1";
}

export function managedHumanNativeTraceOutcome(workflowPassed, traceComplete) {
  return { instrumented: true, passed: false, featurePassed: false, diagnosticWorkflowPassed: workflowPassed === true,
    diagnosticCompleted: workflowPassed === true && traceComplete === true, diagnosticGapConfirmed: false };
}

// Serialized into the existing isolated worker only on explicit opt-in. There
// are no native dispatches, metadata reads, waits or business changes here.
export function installManagedHumanNativeTrace(api, target, options = {}) {
  const key = "__managedHumanNativeTrace";
  if (Object.hasOwn(target, key)) throw new Error("Native trace already installed");
  const maximumRecords = options.maximumRecords === undefined ? 2048 : options.maximumRecords,
    maximumCharacters = options.maximumCharacters === undefined ? 2 * 1024 * 1024 : options.maximumCharacters;
  if (!Number.isSafeInteger(maximumRecords) || maximumRecords < 1 || maximumRecords > 4096 ||
      !Number.isSafeInteger(maximumCharacters) || maximumCharacters < 1024 || maximumCharacters > 4 * 1024 * 1024) throw new Error("Invalid native trace capacity");
  const owner = api.debugger, original = owner.sendCommand, nativeThen = Promise.prototype.then;
  const beforeunload = options.beforeunload === true, originals = options.originals;
  if (options.beforeunload !== undefined && typeof options.beforeunload !== "boolean") throw new Error("Invalid beforeunload trace mode");
  if (beforeunload && (!Array.isArray(originals) || originals.length !== 1 || !Number.isSafeInteger(originals[0]?.tabId) || originals[0].tabId < 0 || typeof originals[0]?.targetId !== "string" || !originals[0].targetId)) throw new Error("One original beforeunload target required");
  if (options.publishDialogBinding === true && (!beforeunload || typeof target.__obuManagedDialogEvent !== "function")) throw new Error("Original diagnostic binding required");
  if (typeof original !== "function" || !owner.onEvent?.addListener || !owner.onDetach?.addListener) throw new Error("Native trace API unavailable");
  const methods = new Set(["Page.enable", "Page.startScreencast", "Page.stopScreencast", "Page.screencastFrameAck", "Page.getFrameTree", "Page.captureScreenshot", "Performance.enable", "Performance.getMetrics",
    "Input.dispatchMouseEvent", "Input.dispatchKeyEvent", "Input.insertText"]);
  const eventMethods = new Set(["Page.screencastFrame", "Page.screencastVisibilityChanged", "Page.frameNavigated", "Page.frameStartedLoading", "Page.frameStoppedLoading", "Page.lifecycleEvent",
    "Page.domContentEventFired", "Page.loadEventFired", "Runtime.executionContextsCleared", "Runtime.executionContextDestroyed", "Target.attachedToTarget", "Target.detachedFromTarget"]);
  const webMethods = beforeunload ? ["onBeforeNavigate", "onCommitted", "onErrorOccurred", "onHistoryStateUpdated"] : [];
  if (beforeunload) {
    methods.add("Page.handleJavaScriptDialog");
    for (const method of ["Page.javascriptDialogOpening", "Page.javascriptDialogClosed", "Page.frameStartedNavigating", "Runtime.executionContextCreated"]) eventMethods.add(method);
    if (webMethods.some(name => !api.webNavigation?.[name]?.addListener || !api.webNavigation[name].removeListener || !api.webNavigation[name].hasListener)) throw new Error("Beforeunload navigation observation unavailable");
  }
  const matches = value => !beforeunload || originals.some(original => value?.tabId === original.tabId || value?.targetId === original.targetId);
  const metricNames = new Set(["Timestamp", "NavigationStart", "DomContentLoaded", "FirstMeaningfulPaint", "LayoutCount", "RecalcStyleCount", "TaskDuration", "ScriptDuration", "JSHeapUsedSize", "JSHeapTotalSize", "Documents", "Frames", "Nodes"]);
  const records = [], pending = new Map();
  let active = true, restored = false, sequence = 0, calls = 0, retainedCharacters = 0, overflow = false, dropped = 0, projectionErrors = 0, unknownSettlements = 0;
  const restorationErrors = [];
  const data = (value, name) => { const descriptor = value && (typeof value === "object" || typeof value === "function") && Object.getOwnPropertyDescriptor(value, name); return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined; };
  const id = value => typeof value === "string" && value.length > 0 && value.length <= 128 && /^[A-Za-z0-9_.:-]+$/.test(value) ? value : undefined;
  const finite = value => typeof value === "number" && Number.isFinite(value);
  const numberFields = (value, keys) => Object.fromEntries(keys.flatMap(name => finite(data(value, name)) ? [[name, data(value, name)]] : []));
  const idFields = (value, keys) => Object.fromEntries(keys.flatMap(name => id(data(value, name)) ? [[name, data(value, name)]] : []));
  const source = value => ({ ...idFields(value, ["targetId", "sessionId"]), ...(Number.isSafeInteger(data(value, "tabId")) && data(value, "tabId") >= 0 ? { tabId: data(value, "tabId") } : {}) });
  const frame = value => ({ ...idFields(value, ["id", "parentId", "loaderId"]), ...numberFields(value, ["navigationType"]) });
  function errorInfo(error) {
    const rawMessage = typeof error === "string" ? error : data(error, "message"), code = data(error, "code");
    const message = typeof rawMessage === "string" ? rawMessage.slice(0, 4096) : undefined;
    const productCode = typeof message === "string" ? message.match(/\bOBU_[A-Z0-9_]{1,100}\b/)?.[0] : undefined;
    const serializedCode = typeof message === "string" ? message.match(/"code"\s*:\s*(-?\d{1,9})\b/)?.[1] : undefined;
    const nativeCode = Number.isSafeInteger(code) ? code : serializedCode !== undefined ? Number(serializedCode) : undefined;
    let category = "unclassified";
    for (const [name, pattern] of [["target-closed", /target closed|no tab with given id|not attached|session.*not found/i],
      ["context-destroyed", /execution context.*destroyed|cannot find context/i], ["method-unavailable", /method.*not found|wasn't found|not supported/i],
      ["browser-shutdown", /browser is shutting down/i]]) if (typeof message === "string" && pattern.test(message)) { category = name; break; }
    return { category, ...(productCode ? { code: productCode } : {}), ...(Number.isSafeInteger(nativeCode) ? { nativeCode } : {}) };
  }
  function append(value) {
    try {
      const row = { sequence: ++sequence, at: Date.now(), ...value }, length = JSON.stringify(row).length;
      if (records.length >= maximumRecords || retainedCharacters + length > maximumCharacters || length > 32768) { overflow = true; dropped++; return; }
      retainedCharacters += length; records.push(row);
      if (options.publishDialogBinding === true) target.__obuManagedDialogEvent(JSON.stringify(row));
    } catch { projectionErrors++; }
  }
  function safe(run) { try { return run(); } catch { projectionErrors++; return undefined; } }
  function parameters(method, params) {
    if (method === "Page.handleJavaScriptDialog") return typeof data(params, "accept") === "boolean" ? { accept: data(params, "accept") } : {};
    if (method.startsWith("Input.")) {
      const type = data(params, "type");
      return ["mouseMoved", "mousePressed", "mouseReleased", "mouseWheel", "keyDown", "rawKeyDown", "keyUp", "char"].includes(type) ? { inputType: type } : {};
    }
    if (method === "Page.screencastFrameAck") return numberFields(params, ["sessionId"]);
    if (method === "Page.startScreencast") return { ...numberFields(params, ["quality", "maxWidth", "maxHeight", "everyNthFrame"]),
      ...(["jpeg", "png"].includes(data(params, "format")) ? { format: data(params, "format") } : {}) };
    if (method === "Page.captureScreenshot") return { ...(["jpeg", "png", "webp"].includes(data(params, "format")) ? { format: data(params, "format") } : {}),
      ...Object.fromEntries(["fromSurface", "captureBeyondViewport"].flatMap(name => typeof data(params, name) === "boolean" ? [[name, data(params, name)]] : [])) };
    if (method === "Performance.enable") return ["timeTicks", "threadTicks"].includes(data(params, "timeDomain")) ? { timeDomain: data(params, "timeDomain") } : {};
    return {};
  }
  function resultInfo(method, value) {
    if (method === "Performance.getMetrics") {
      const metrics = data(value, "metrics");
      if (!Array.isArray(metrics)) return { metricsPresent: false };
      const retained = []; let truncated = metrics.length > 128;
      for (let index = 0; index < Math.min(metrics.length, 128); index++) {
        const metric = data(metrics, String(index)), name = data(metric, "name"), value = data(metric, "value");
        if (metricNames.has(name) && finite(value)) retained.push({ name, value });
      }
      return { metricsPresent: true, metrics: retained, truncated };
    }
    if (method === "Page.getFrameTree") {
      const frames = []; let truncated = false;
      function visit(node, depth) {
        if (!node) return;
        if (depth > 8 || frames.length >= 64) { truncated = true; return; }
        frames.push(frame(data(node, "frame")));
        const children = data(node, "childFrames");
        if (Array.isArray(children)) { if (children.length > 64) truncated = true; for (let i = 0; i < Math.min(children.length, 64); i++) visit(data(children, String(i)), depth + 1); }
      }
      visit(data(value, "frameTree"), 0); return { frames, truncated };
    }
    return {};
  }
  function traced(...args) {
    const [debuggee, method, params] = args;
    if (!active || !methods.has(method) || !matches(debuggee)) return Reflect.apply(original, this, args);
    const callId = ++calls; let identity;
    safe(() => { identity = { callId, method, source: source(debuggee) }; append({ kind: "send", ...identity, params: parameters(method, params) });
      if (pending.size < maximumRecords) pending.set(callId, identity); else { overflow = true; dropped++; } });
    const finish = (kind, value) => safe(() => { pending.delete(callId); append({ kind, ...identity, ...(kind === "resolved" ? { result: resultInfo(method, value) } : { error: errorInfo(value) }) }); });
    let promise;
    try { promise = Reflect.apply(original, this, args); }
    catch (error) { finish("thrown", error); throw error; }
    try { nativeThen.call(promise, value => { finish("resolved", value); }, error => { finish("rejected", error); }); }
    catch { safe(() => { pending.delete(callId); unknownSettlements++; append({ kind: "unobserved-return", ...identity }); }); }
    return promise;
  }
  function event(debuggee, method, params) {
    if (!active || !eventMethods.has(method) || !matches(debuggee)) return;
    safe(() => {
      let detail = {};
      if (method === "Page.javascriptDialogOpening") detail = { ...idFields(params, ["frameId"]),
        ...(["alert", "confirm", "prompt", "beforeunload"].includes(data(params, "type")) ? { type: data(params, "type") } : {}),
        ...(typeof data(params, "hasBrowserHandler") === "boolean" ? { hasBrowserHandler: data(params, "hasBrowserHandler") } : {}) };
      else if (method === "Page.javascriptDialogClosed") detail = { ...idFields(params, ["frameId"]), ...(typeof data(params, "result") === "boolean" ? { result: data(params, "result") } : {}) };
      else if (method === "Page.frameStartedNavigating") detail = { ...idFields(params, ["frameId", "loaderId"]),
        ...(["reload", "reloadBypassingCache", "restore", "restoreWithPost", "historySameDocument", "historyDifferentDocument", "sameDocument", "differentDocument"].includes(data(params, "navigationType")) ? { navigationType: data(params, "navigationType") } : {}) };
      else if (method === "Runtime.executionContextCreated") {
        const context = data(params, "context"), auxiliary = data(context, "auxData");
        detail = { context: { ...numberFields(context, ["id"]), ...idFields(context, ["uniqueId"]), auxData: {
          ...idFields(auxiliary, ["frameId"]), ...(typeof data(auxiliary, "isDefault") === "boolean" ? { isDefault: data(auxiliary, "isDefault") } : {}) } } };
      }
      else if (method === "Page.screencastFrame") detail = { ...numberFields(params, ["sessionId"]), metadata: numberFields(data(params, "metadata"), ["timestamp", "monotonicTimestamp", "offsetTop", "pageScaleFactor", "deviceWidth", "deviceHeight", "scrollOffsetX", "scrollOffsetY"]) };
      else if (method === "Page.screencastVisibilityChanged") detail = typeof data(params, "visible") === "boolean" ? { visible: data(params, "visible") } : {};
      else if (method === "Page.frameNavigated") detail = { frame: frame(data(params, "frame")) };
      else if (method === "Target.attachedToTarget") detail = { ...idFields(params, ["sessionId"]), target: { ...idFields(data(params, "targetInfo"), ["targetId"]),
        ...(["page", "iframe", "worker", "service_worker", "other"].includes(data(data(params, "targetInfo"), "type")) ? { type: data(data(params, "targetInfo"), "type") } : {}) } };
      else if (method === "Target.detachedFromTarget") detail = idFields(params, ["sessionId", "targetId"]);
      else detail = { ...idFields(params, ["frameId", "loaderId", "executionContextUniqueId"]), ...numberFields(params, ["timestamp", "executionContextId"]),
        ...(["init", "DOMContentLoaded", "load", "networkAlmostIdle", "networkIdle", "firstPaint", "firstContentfulPaint"].includes(data(params, "name")) ? { name: data(params, "name") } : {}) };
      append({ kind: "event", method, source: source(debuggee), params: detail });
    });
  }
  function detach(debuggee, reason) { if (active && matches(debuggee)) safe(() => append({ kind: "detach", source: source(debuggee), reason: ["target_closed", "canceled_by_user"].includes(reason) ? reason : "unclassified" })); }
  const webListeners = webMethods.map(method => [method, detail => {
    if (!active || !matches(detail)) return;
    safe(() => {
      const error = data(detail, "error");
      append({ kind: "webNavigation", method, source: { tabId: data(detail, "tabId") }, params: {
        ...numberFields(detail, ["frameId", "parentFrameId", "timeStamp"]), ...idFields(detail, ["documentId", "parentDocumentId"]),
        ...(method === "onErrorOccurred" ? { error: typeof error === "string" && /^net::ERR_[A-Z_]{1,80}$/.test(error) ? error : "unclassified" } : {}) } });
    });
  }]);
  const snapshot = () => structuredClone({ diagnosticOnly: true, version: 1, active, restored, methods: [...methods], eventMethods: [...eventMethods],
    maximumRecords, maximumCharacters, retainedCharacters, sequence, calls, overflow, dropped, projectionErrors, unknownSettlements,
    pending: [...pending.values()], restorationErrors, listenerPresent: owner.onEvent.hasListener(event) || owner.onDetach.hasListener(detach),
    ...(beforeunload ? { beforeunload: true, originals: structuredClone(originals), webMethods, webListenersPresent: webListeners.some(([name, listener]) => api.webNavigation[name].hasListener(listener)) } : {}), records,
    boundary: "Instrumented diagnostic only. Original receiver, arguments, return Promise and errors are preserved. Side-chain observation may change scheduling. Whitelisted identities/numeric metadata only; no image payload, URL, input text or arbitrary error text. Pending calls remain unknown; collection does not wait, dispatch, retry or repair." });
  const stop = () => {
    if (active) {
      active = false;
      if (owner.sendCommand === traced) { owner.sendCommand = original; if (owner.sendCommand !== original) restorationErrors.push("RESTORE_NOT_RETAINED"); }
      else restorationErrors.push("WRAPPER_REPLACED");
      for (const [channel, listener] of [[owner.onEvent, event], [owner.onDetach, detach]]) try { channel.removeListener(listener); } catch { restorationErrors.push("LISTENER_REMOVE_FAILED"); }
      for (const [name, listener] of webListeners) try { api.webNavigation[name].removeListener(listener); } catch { restorationErrors.push("WEB_LISTENER_REMOVE_FAILED"); }
      restored = restorationErrors.length === 0;
    }
    return snapshot();
  };
  try {
    owner.sendCommand = traced; if (owner.sendCommand !== traced) throw new Error("Native trace wrapper assignment failed");
    owner.onEvent.addListener(event); owner.onDetach.addListener(detach);
    for (const [name, listener] of webListeners) api.webNavigation[name].addListener(listener);
    Object.defineProperty(target, key, { value: Object.freeze({ snapshot, stop }), configurable: false });
  } catch (error) { stop(); throw error; }
  return snapshot();
}

export function managedHumanNativeTraceComplete(value) {
  if (!value || value.diagnosticOnly !== true || value.version !== 1 || value.active !== false || value.restored !== true || value.listenerPresent !== false ||
      value.overflow !== false || value.dropped !== 0 || value.projectionErrors !== 0 || value.unknownSettlements !== 0 || value.pending?.length !== 0 || value.restorationErrors?.length !== 0 ||
      !Array.isArray(value.records) || value.records.length !== value.sequence || value.beforeunload === true && value.webListenersPresent !== false) return false;
  const open = new Map(); let calls = 0, characters = 0;
  for (let index = 0; index < value.records.length; index++) {
    const row = value.records[index]; characters += JSON.stringify(row).length;
    if (row.sequence !== index + 1 || !Number.isFinite(row.at)) return false;
    if (row.kind === "send") { if (row.callId !== ++calls || !value.methods.includes(row.method)) return false; open.set(row.callId, row); }
    else if (["resolved", "rejected", "thrown"].includes(row.kind)) {
      const original = open.get(row.callId);
      if (!original || original.method !== row.method || JSON.stringify(original.source) !== JSON.stringify(row.source) || row.result?.truncated === true) return false;
      open.delete(row.callId);
    } else if (row.kind === "event") { if (!value.eventMethods.includes(row.method)) return false; }
    else if (row.kind === "webNavigation") { if (value.beforeunload !== true || !value.webMethods.includes(row.method)) return false; }
    else if (row.kind !== "detach") return false;
  }
  return calls > 0 && calls === value.calls && open.size === 0 && characters === value.retainedCharacters && characters <= value.maximumCharacters && value.records.length <= value.maximumRecords;
}
