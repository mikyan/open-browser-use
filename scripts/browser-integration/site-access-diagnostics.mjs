// Explicit private-browser diagnostic only. This function is self-contained so
// the runner can inject it into the original service worker without a bundle.
export function installSiteAccessDiagnostics(backend, chrome, target, { maxRecords = 4096 } = {}) {
  const apiKey = "__siteAccessDiagnostics";
  if (!Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > 16384 || Object.hasOwn(target, apiKey))
    throw Error("Invalid website access diagnostic installation");
  const specs = [
    [backend, "assertSiteTab", "assertSiteTab", true],
    [chrome?.tabs, "get", "tabs.get", true],
    [chrome?.webNavigation, "getAllFrames", "webNavigation.getAllFrames", true],
    [backend, "onSiteNavigation", "onSiteNavigation", false],
    [backend, "revokeSiteTab", "revokeSiteTab", false]
  ];
  const patches = specs.map(([owner, key, name, asynchronous]) => {
    const descriptor = owner && Object.getOwnPropertyDescriptor(owner, key), original = owner?.[key];
    if (typeof original !== "function" || descriptor && (!Object.hasOwn(descriptor, "value") || !descriptor.writable))
      throw Error("Website access diagnostic method is unavailable");
    return { owner, key, name, asynchronous, descriptor, original };
  });
  const records = [], errors = [], inspections = [];
  let sequence = 0, nextCall = 0, droppedRecords = 0, overflow = false, pending = 0;
  let closed = false, restored = false, apiRemoved = false, final;
  const copy = value => JSON.parse(JSON.stringify(value));
  const limited = (value, length = 4096) => typeof value === "string" ? value.slice(0, length) : null;
  const errorValue = error => ({ name: limited(error?.name, 128), message: limited(error?.message ?? String(error)), stack: limited(error?.stack, 4096) });
  const noteError = value => { if (errors.length < 32) errors.push(value); else overflow = true; };
  const record = data => {
    if (closed) return;
    const row = { sequence: ++sequence, at: Date.now(), ...data };
    if (records.length >= maxRecords) { overflow = true; droppedRecords++; return; }
    records.push(row);
  };
  const safely = operation => { try { return operation(); } catch { noteError("Diagnostic observation failed"); return null; } };
  const state = tabId => safely(() => {
    const policy = backend.siteAccess.status(), entries = [...(backend.sitePendingFrames.get(tabId)?.entries() ?? [])];
    return {
      generation: limited(policy.generation, 128), revision: policy.revision, ready: policy.ready,
      restricted: backend.siteAccess.restricted, navigationVersion: backend.siteNavigationVersions.get(tabId) ?? 0,
      revoked: backend.siteRevokedTabs.has(tabId), attached: backend.attachedTabs.has(tabId),
      attaching: backend.pendingAttachmentTabs.has(tabId),
      pendingNavigationCount: entries.length,
      pendingNavigations: entries.slice(0, 1000).map(([frameId, url]) => ({ frameId, url: limited(url) }))
    };
  });
  const fields = (value, names) => {
    if (!value || typeof value !== "object") return { invalidType: value === null ? "null" : typeof value };
    return Object.fromEntries(names.filter(name => Object.hasOwn(value, name)).map(name => {
      const item = value[name];
      return [name, typeof item === "string" ? limited(item) : typeof item === "number" || typeof item === "boolean" || item === null ? item : "[invalid type]"];
    }));
  };
  const frameFields = ["frameId", "parentFrameId", "url", "documentId", "parentDocumentId", "documentLifecycle", "errorOccurred", "frameType", "processId"];
  const nativeValue = (name, value) => name === "tabs.get"
    ? fields(value, ["id", "windowId", "url", "pendingUrl", "status", "active", "discarded"])
    : name === "webNavigation.getAllFrames"
      ? Array.isArray(value) ? { frameCount: value.length, framesTruncated: value.length > 1000, frames: value.slice(0, 1000).map(frame => fields(frame, frameFields)) } : { invalidType: value === null ? "null" : typeof value }
      : fields(value, ["tabId", "generation", "revision", "version", "documentId"]);
  for (const patch of patches) {
    patch.wrapper = function (...args) {
      const { name } = patch;
      const tabId = name === "onSiteNavigation" ? args[0]?.tabId : name === "webNavigation.getAllFrames" ? args[0]?.tabId : args[0];
      const callId = ++nextCall, parentInspectionId = inspections.at(-1) ?? null;
      safely(() => record({ kind: "call", method: name, callId, parentInspectionId, tabId,
        state: state(tabId),
        ...(name === "assertSiteTab" ? { options: fields(args[1] ?? {}, ["recover", "allowBlank"]) } : {}),
        ...(name === "onSiteNavigation" ? { phase: args[1], navigation: fields(args[0], ["tabId", ...frameFields, "timeStamp", "error"]) } : {}),
        ...(name === "revokeSiteTab" ? { stack: limited(new Error("Website access revoke call").stack, 4096) } : {})
      }));
      let result;
      if (name === "assertSiteTab") inspections.push(callId);
      try { result = Reflect.apply(patch.original, this, args); }
      catch (error) {
        safely(() => record({ kind: "threw", method: name, callId, tabId, state: state(tabId), error: errorValue(error) }));
        throw error;
      } finally { if (name === "assertSiteTab") inspections.pop(); }
      if (!patch.asynchronous) {
        safely(() => record({ kind: "returned", method: name, callId, tabId, state: state(tabId) }));
        return result;
      }
      pending++;
      const finish = (kind, value) => {
        pending--;
        safely(() => record({ kind, method: name, callId, tabId, state: state(tabId),
          ...(kind === "fulfilled" ? { value: nativeValue(name, value) } : { error: errorValue(value) }) }));
      };
      try { Promise.prototype.then.call(result, value => finish("fulfilled", value), error => finish("rejected", error)); }
      catch { pending--; noteError("Diagnostic method did not return an observable native Promise"); }
      return result;
    };
  }
  const snapshot = () => copy(final ?? { records, errors, pending, closed, restored, apiRemoved, overflow, droppedRecords, maxRecords,
    boundary: "Passive private-profile method/Promise observations; original calls, receivers, arguments and results are unchanged. No extra native queries, waits or input retries. Snapshots are bounded and are not an atomic browser document snapshot." });
  const restore = patch => {
    if (patch.owner[patch.key] !== patch.wrapper) { noteError(`Diagnostic wrapper replaced: ${patch.name}`); return false; }
    if (patch.descriptor) Object.defineProperty(patch.owner, patch.key, patch.descriptor); else delete patch.owner[patch.key];
    return patch.owner[patch.key] === patch.original;
  };
  const api = { snapshot, stop() {
    if (closed) return snapshot();
    const results = patches.slice().reverse().map(patch => safely(() => restore(patch)));
    restored = results.every(Boolean);
    if (target[apiKey] === api) { delete target[apiKey]; apiRemoved = !Object.hasOwn(target, apiKey); }
    else noteError("Diagnostic API replaced");
    if (pending) noteError("Stopped before original observed Promises settled");
    closed = true; final = snapshot(); return snapshot();
  } };
  const installed = [];
  try {
    for (const patch of patches) {
      Object.defineProperty(patch.owner, patch.key, patch.descriptor ? { ...patch.descriptor, value: patch.wrapper } : { value: patch.wrapper, configurable: true, writable: true });
      installed.push(patch);
    }
    Object.defineProperty(target, apiKey, { value: api, configurable: true });
  } catch (error) {
    for (const patch of installed.reverse()) restore(patch);
    throw error;
  }
  return { installed: true, maxRecords };
}
