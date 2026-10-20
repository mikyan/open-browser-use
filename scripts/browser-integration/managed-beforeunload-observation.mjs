// Serialized into the original worker. Passive listeners only: no sendCommand
// access, Page attachment, input, dialog response, or replacement Promise.
export function installManagedBeforeunloadObservation(api, target, originals) {
  const key = "__managedBeforeunloadObservation";
  if (Object.hasOwn(target, key) || typeof target.__obuManagedDialogEvent !== "function" ||
      !Array.isArray(originals) || originals.length !== 1 || !Number.isSafeInteger(originals[0]?.tabId) ||
      typeof originals[0]?.targetId !== "string") throw Error("Original beforeunload observation unavailable");
  const webMethods = ["onBeforeNavigate", "onCommitted", "onErrorOccurred", "onHistoryStateUpdated"];
  const eventMethods = new Set(["Page.javascriptDialogOpening", "Page.javascriptDialogClosed", "Page.frameStartedNavigating", "Page.frameNavigated",
    "Runtime.executionContextsCleared", "Runtime.executionContextCreated", "Runtime.executionContextDestroyed", "Target.attachedToTarget", "Target.detachedFromTarget"]);
  const records = [], listeners = []; let active = true, sequence = 0, overflow = false, dropped = 0, projectionErrors = 0, characters = 0;
  const matches = source => source?.tabId === originals[0].tabId || source?.targetId === originals[0].targetId;
  const ids = (value, names) => Object.fromEntries(names.flatMap(name => typeof value?.[name] === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(value[name]) ? [[name, value[name]]] : []));
  const numbers = (value, names) => Object.fromEntries(names.flatMap(name => Number.isFinite(value?.[name]) ? [[name, value[name]]] : []));
  const booleans = (value, names) => Object.fromEntries(names.flatMap(name => typeof value?.[name] === "boolean" ? [[name, value[name]]] : []));
  const sourceCopy = source => ({ ...ids(source, ["targetId", "sessionId"]), ...numbers(source, ["tabId"]) });
  function record(kind, source, method, params) {
    if (!active || !matches(source)) return;
    try {
      const row = { sequence: ++sequence, at: Date.now(), kind, source: sourceCopy(source), method, params }, text = JSON.stringify(row);
      if (records.length >= 2048 || characters + text.length > 2 * 1024 * 1024) { overflow = true; dropped++; return; }
      characters += text.length; records.push(row); target.__obuManagedDialogEvent(text);
    } catch { projectionErrors++; }
  }
  function onEvent(source, method, params = {}) {
    if (!active || !matches(source) || !eventMethods.has(method)) return;
    try {
      let value = {};
      if (method === "Page.javascriptDialogOpening") value = { ...ids(params, ["frameId"]), ...booleans(params, ["hasBrowserHandler"]),
        ...(["beforeunload", "alert", "confirm", "prompt"].includes(params.type) ? { type: params.type } : {}) };
      else if (method === "Page.javascriptDialogClosed") value = { ...ids(params, ["frameId"]), ...booleans(params, ["result"]) };
      else if (method === "Page.frameStartedNavigating") value = { ...ids(params, ["frameId", "loaderId"]),
        ...(["reload", "reloadBypassingCache", "restore", "restoreWithPost", "historySameDocument", "historyDifferentDocument", "sameDocument", "differentDocument"].includes(params.navigationType) ? { navigationType: params.navigationType } : {}) };
      else if (method === "Page.frameNavigated") value = { frame: ids(params.frame, ["id", "parentId", "loaderId"]) };
      else if (method === "Runtime.executionContextCreated") value = { context: { ...numbers(params.context, ["id"]), ...ids(params.context, ["uniqueId"]),
        auxData: { ...ids(params.context?.auxData, ["frameId"]), ...booleans(params.context?.auxData, ["isDefault"]) } } };
      else if (method === "Runtime.executionContextDestroyed") value = { ...numbers(params, ["executionContextId"]), ...ids(params, ["executionContextUniqueId"]) };
      else if (method === "Target.attachedToTarget") value = { ...ids(params, ["sessionId"]), target: { ...ids(params.targetInfo, ["targetId"]),
        ...(["iframe", "page"].includes(params.targetInfo?.type) ? { type: params.targetInfo.type } : {}) } };
      else if (method === "Target.detachedFromTarget") value = ids(params, ["sessionId", "targetId"]);
      record("event", source, method, value);
    } catch { projectionErrors++; }
  }
  const onDetach = source => record("event", source, "debugger.onDetach", {});
  function add(owner, listener) { owner.addListener(listener); listeners.push({ owner, listener }); }
  add(api.debugger.onEvent, onEvent); add(api.debugger.onDetach, onDetach);
  for (const method of webMethods) add(api.webNavigation[method], details => {
    try { record("webNavigation", { tabId: details.tabId }, method, { ...numbers(details, ["tabId", "frameId", "parentFrameId", "timeStamp"]),
      ...ids(details, ["documentId", "parentDocumentId"]), ...(method === "onErrorOccurred" ? { error: /^net::ERR_[A-Z_]{1,80}$/.test(details.error) ? details.error : "unclassified" } : {}) }); }
    catch { projectionErrors++; }
  });
  const snapshot = () => ({ readOnly: true, instrumented: false, active, records: structuredClone(records), overflow, dropped, projectionErrors,
    listenersPresent: listeners.filter(({ owner, listener }) => owner.hasListener(listener)).length });
  Object.defineProperty(target, key, { configurable: true, value: Object.freeze({ snapshot, stop() {
    active = false; for (const { owner, listener } of listeners) owner.removeListener(listener); return snapshot();
  } }) });
  return { installed: true, readOnly: true, instrumented: false, originals };
}

export function managedBeforeunloadObservationComplete(value) {
  return value?.readOnly === true && value.instrumented === false && value.active === false && value.listenersPresent === 0 &&
    value.overflow === false && value.dropped === 0 && value.projectionErrors === 0 && Array.isArray(value.records) &&
    value.records.length > 0 && value.records.every((row, index) => row.sequence === index + 1 && ["event", "webNavigation"].includes(row.kind));
}
