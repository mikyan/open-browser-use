// Diagnostic only. This function is serialized into the original managed
// worker. It neither dispatches a native command nor substitutes any Promise.
export async function installManagedFileChooserErrorDiagnostic(chromeAPI = chrome, target = globalThis, controllerPrototype) {
  const key = "__managedFileChooserErrorDiagnostic";
  if (Object.hasOwn(target, key)) throw new Error("File chooser diagnostic already installed");
  const events = [], maximum = 512;
  const actionEvents = [], actionMaximum = 512;
  let actionOverflow = false, actionSequence = 0;
  let overflow = false, sequence = 0, active = true, operations = 0;
  const push = value => {
    try {
      if (events.length >= maximum) { overflow = true; return; }
      events.push({ sequence: ++sequence, at: Date.now(), ...value });
    } catch { overflow = true; }
  };
  const pushAction = value => {
    try {
      if (actionEvents.length >= actionMaximum) { actionOverflow = true; return; }
      actionEvents.push({ sequence: ++actionSequence, at: Date.now(), ...value });
    } catch { actionOverflow = true; }
  };
  const text = (value, limit = 128) => typeof value === "string" && value.length <= limit && /^[A-Za-z0-9_.:/-]+$/.test(value) ? value : undefined;
  const errorInfo = error => {
    try {
      const description = typeof error === "string" ? error : typeof error?.message === "string" ? error.message : "";
      const stack = typeof error?.stack === "string" ? error.stack : description;
      const code = description.match(/\bOBU_[A-Z0-9_]{1,100}\b/)?.[0];
      let category = code ? "coded-product-error" : "unclassified-error";
      for (const [name, pattern] of [
        ["context-destroyed", /execution context (?:was )?destroyed/i],
        ["context-missing", /cannot find context|cannot find.*execution context|uniqueContextId.*not found/i],
        ["object-missing", /could not find object|cannot find object|invalid remote object|invalid object id/i],
        ["target-detached", /not attached|target closed|session.*not found|no tab with given id/i],
        ["browser-shutdown", /browser is shutting down/i],
        ["dynamic-import-unavailable", /import.*not supported|failed to fetch dynamically imported module|dynamic import/i],
      ]) if (pattern.test(description)) { category = name; break; }
      const locations = [...stack.matchAll(/chrome-extension:\/\/[a-p]{32}\/([A-Za-z0-9_./-]+\.(?:mjs|js)):(\d+):(\d+)/g)]
        .slice(0, 8).map(value => ({ file: value[1], line: Number(value[2]), column: Number(value[3]) }));
      const property = description.match(/Cannot read properties of (?:undefined|null) \(reading '([A-Za-z_$][\w$]{0,50})'\)/)?.[1];
      return { category, ...(code ? { code } : {}), ...(text(error?.name, 40) ? { name: error.name } : {}),
        ...(Number.isInteger(error?.code) ? { nativeCode: error.code } : {}), ...(property ? { missingProperty: property } : {}), locations };
    } catch { return { category: "error-projection-failed" }; }
  };
  const recordInfo = record => ({
    ...(Number.isSafeInteger(record?.tabId) ? { tabId: record.tabId } : {}),
    ...(text(record?.leaseId) ? { leaseId: record.leaseId } : {}),
    ...(text(record?.state, 32) ? { state: record.state } : {}),
    ...(Number.isSafeInteger(record?.generation) ? { generation: record.generation } : {}),
    attached: record?.attached === true, revoked: record?.revoked === true,
    epochCount: record?.epochs?.size, drainCount: record?.drains?.size,
    fileRecords: record?.fileChoosers?.records?.size, fileOperations: record?.fileChoosers?.operations?.size,
    fileRegistry: [...record?.fileChoosers?.registry?.records?.values?.() ?? []].slice(0, 8).map(value => ({
      prepared: value.prepared === true, dispatched: value.dispatched === true, nativeSettled: value.nativeSettled === true,
      setupPending: value.setupPending, retired: value.retired === true, invalidated: value.invalidated === true,
      cleanupDone: value.cleanupDone === true, cleanupPending: Boolean(value.cleanupPromise),
      ...(value.cleanupError ? { cleanupError: errorInfo(value.cleanupError) } : {}),
    })),
  });
  const observe = (original, id, detail, record = push) => {
    if (!original || typeof original.then !== "function") {
      record({ kind: "non-promise-return", id }); return;
    }
    operations++;
    // The observer branch always fulfills. Callers receive the exact original
    // Promise, including its original rejection and timing.
    original.then(value => {
      try {
        record({ kind: "resolved", id, ...detail?.(value),
          ...(value?.exceptionDetails ? { exception: errorInfo(value.exceptionDetails.exception?.description ?? value.exceptionDetails.text) } : {}) });
      } catch { record({ kind: "observer-projection-error", id }); }
      operations--;
    }, error => {
      try { record({ kind: "rejected", id, error: errorInfo(error), ...detail?.() }); }
      catch { record({ kind: "observer-projection-error", id }); }
      operations--;
    }).catch(() => { overflow = true; });
  };
  let imported = controllerPrototype, importError;
  if (!imported) {
    try { imported = (await import(chromeAPI.runtime.getURL("managed-human-control.js"))).ManagedHumanControl.prototype; }
    catch (error) { importError = errorInfo(error); }
  }
  const nativeOwner = chromeAPI.debugger;
  const originalSend = nativeOwner.sendCommand;
  const methods = new Set(["Page.createIsolatedWorld", "DOM.resolveNode", "Runtime.callFunctionOn", "Runtime.releaseObject",
    "DOM.setFileInputFiles", "Page.setInterceptFileChooserDialog", "Page.getFrameTree", "Page.getLayoutMetrics",
    "Page.startScreencast", "Page.stopScreencast", "Page.screencastFrameAck", "Emulation.setFocusEmulationEnabled"]);
  // A separate finite ledger prevents earlier human screencast ACKs from
  // consuming the click diagnostic capacity. No original record is cleared.
  const actionMethods = new Set(["Page.enable", "Input.dispatchMouseEvent", "Runtime.evaluate", "Runtime.callFunctionOn"]);
  let nextID = 0;
  function sendCommand(...args) {
    const [source, method, params] = args;
    if (!active || !(methods.has(method) || actionMethods.has(method))) return Reflect.apply(originalSend, this, args);
    const id = ++nextID;
    const record = value => { if (methods.has(method)) push(value); if (actionMethods.has(method)) pushAction(value); };
    const nativeTarget = Object.fromEntries(["targetId", "tabId", "sessionId"].flatMap(name =>
      Number.isSafeInteger(source?.[name]) || text(source?.[name]) ? [[name, source[name]]] : []));
    const declaration = typeof params?.functionDeclaration === "string" ? params.functionDeclaration : "";
    const stage = ["cleanup", "describe", "begin"].find(name => declaration.includes(`this.${name}`)) ??
      (declaration.includes("__openBrowserUseDirectoryUploadGuardsV1") ? "install-file-guard" : undefined);
    const phase = method === "Input.dispatchMouseEvent" ? "native-pointer"
      : method === "Page.enable" ? "page-enable"
      : method === "Runtime.evaluate" ? "runtime-evaluate"
      : method === "Runtime.callFunctionOn" ? "runtime-call" : undefined;
    record({ kind: "native-call", id, method, target: nativeTarget, ...(stage ? { stage } : {}), ...(phase ? { phase } : {}),
      ...(method === "Input.dispatchMouseEvent" ? { pointer: {
        ...(["mouseMoved", "mousePressed", "mouseReleased", "mouseWheel"].includes(params?.type) ? { type: params.type } : {}),
        ...(["none", "left", "middle", "right", "back", "forward"].includes(params?.button) ? { button: params.button } : {}),
        ...Object.fromEntries(["x", "y", "buttons", "clickCount", "modifiers"].filter(k => Number.isFinite(params?.[k])).map(k => [k, params[k]])),
      } } : {}),
      ...(method === "Page.setInterceptFileChooserDialog" ? { enabled: params?.enabled === true } : {}) });
    let original;
    try { original = Reflect.apply(originalSend, this, args); }
    catch (error) { record({ kind: "synchronous-throw", id, error: errorInfo(error) }); throw error; }
    observe(original, id, value => {
      const result = value?.result;
      return result && typeof result === "object" ? { result: {
        ...(["object", "function", "undefined", "string", "number", "boolean", "symbol", "bigint"].includes(result.type) ? { type: result.type } : {}),
        objectIdPresent: typeof result.objectId === "string",
        ...(["done", "error:notconnected", "error:notvisible", "error:notinviewport"].includes(result.value) ? { marker: result.value } : {}),
      } } : {};
    }, record); return original;
  }
  nativeOwner.sendCommand = sendCommand;
  if (nativeOwner.sendCommand !== sendCommand) throw new Error("Native diagnostic wrapper was not installed");
  const originalClose = imported?.close;
  let closeWrapper;
  if (typeof originalClose === "function") {
    closeWrapper = function (...args) {
      if (!active) return Reflect.apply(originalClose, this, args);
      const id = ++nextID, [record, reason] = args;
      push({ kind: "controller-close", id, record: recordInfo(record), ...(reason ? { reason: errorInfo(reason) } : {}) });
      let original;
      try { original = Reflect.apply(originalClose, this, args); }
      catch (error) { push({ kind: "synchronous-throw", id, error: errorInfo(error) }); throw error; }
      observe(original, id, () => ({ record: recordInfo(record) })); return original;
    };
    imported.close = closeWrapper;
    if (imported.close !== closeWrapper) throw new Error("Controller diagnostic wrapper was not installed");
  }
  const capabilities = { diagnosticOnly: true, nativeSendObserved: true, controllerCloseObserved: Boolean(closeWrapper),
    returnsOriginalPromise: true, noNativeDispatchDuringInstall: true, methods: [...new Set([...methods, ...actionMethods])], maximum,
    actionMethods: [...actionMethods], actionMaximum,
    ...(importError ? { controllerImportError: importError } : {}) };
  const snapshot = () => structuredClone({ ...capabilities, active, overflow, operations, events, actionOverflow, actionEvents });
  const stop = () => {
    active = false;
    if (nativeOwner.sendCommand === sendCommand) nativeOwner.sendCommand = originalSend;
    if (closeWrapper && imported.close === closeWrapper) imported.close = originalClose;
    return snapshot();
  };
  Object.defineProperty(target, key, { value: Object.freeze({ snapshot, stop }), configurable: false });
  return structuredClone(capabilities);
}
