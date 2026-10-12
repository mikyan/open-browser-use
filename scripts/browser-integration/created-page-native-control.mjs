// Serialized into the isolated staged worker. Capture the extension's original
// calls and native events in one sequence. The observer does not issue native
// calls, wait on a gate, replace a returned promise, or restore focus.
export function installCreatedPageNativeControlObserver(chrome, target, options = {}) {
  const { maxRecords = 64000, maxBytes = 16 * 1024 * 1024 } = options;
  if (!target || target.__createdPageNativeControl || !Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > 64000 ||
      !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 16 * 1024 * 1024)
    throw Error("Invalid created-page native-control observer installation");
  const methods = [
    ["debugger.sendCommand", chrome?.debugger, "sendCommand"], ["debugger.attach", chrome?.debugger, "attach"], ["debugger.detach", chrome?.debugger, "detach"],
    ["tabs.update", chrome?.tabs, "update"], ["tabs.create", chrome?.tabs, "create"], ["tabs.move", chrome?.tabs, "move"],
    ["tabs.group", chrome?.tabs, "group"], ["tabs.ungroup", chrome?.tabs, "ungroup"],
    ["windows.create", chrome?.windows, "create"], ["windows.update", chrome?.windows, "update"],
  ].map(([api, object, name]) => {
    const descriptor = object && Object.getOwnPropertyDescriptor(object, name), original = object?.[name];
    if (typeof original !== "function" || descriptor && (!Object.hasOwn(descriptor, "value") || !descriptor.writable) ||
        !descriptor && !Object.isExtensible(object)) throw Error(`Cannot observe original chrome.${api}`);
    return { api, object, name, original, descriptor };
  });
  const events = [
    ["tabs.onCreated", chrome?.tabs?.onCreated], ["tabs.onActivated", chrome?.tabs?.onActivated],
    ["windows.onFocusChanged", chrome?.windows?.onFocusChanged],
    ["webNavigation.onCreatedNavigationTarget", chrome?.webNavigation?.onCreatedNavigationTarget],
  ].map(([api, event]) => {
    if (!event || ["addListener", "removeListener", "hasListener"].some(method => typeof event[method] !== "function"))
      throw Error(`Cannot observe original chrome.${api}`);
    return { api, event };
  });
  const records = [], errors = [], pending = new Map(), encoder = new TextEncoder();
  let bytes = 0, overflow = false, closed = false, restored = false, listenersRemoved = false, nextOperation = 0;
  const error = value => { if (errors.length < 16) errors.push(String(value?.message ?? value).slice(0, 1024)); };
  const safely = operation => { try { return operation(); } catch (failure) { error(failure); return undefined; } };
  // Native API arguments are JSON data. Read data descriptors rather than
  // invoking getters/toJSON that the original method might never evaluate.
  // Unsupported/cyclic values fail the evidence instead of changing the call.
  const clone = (value, budget = { nodes: 64000, remaining: maxBytes, seen: new Set() }, depth = 0) => {
    if (--budget.nodes < 0 || depth > 64) throw Error("Native-control data exceeds structural bound");
    if (value === null || value === undefined || typeof value === "boolean") return value;
    if (typeof value === "number") { if (!Number.isFinite(value)) throw Error("Non-JSON native-control number"); return value; }
    if (typeof value === "string") {
      budget.remaining -= encoder.encode(value).byteLength;
      if (budget.remaining < 0) { overflow = true; throw Error("Native-control argument exceeds byte bound"); }
      return value;
    }
    if (typeof value !== "object") throw Error(`Non-JSON native-control ${typeof value}`);
    if (budget.seen.has(value)) throw Error("Cyclic native-control data");
    budget.seen.add(value);
    try {
      const descriptors = Object.getOwnPropertyDescriptors(value), result = Array.isArray(value) ? [] : Object.create(null);
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (!descriptor.enumerable) continue;
        if (!Object.hasOwn(descriptor, "value")) throw Error("Native-control accessor was not read");
        budget.remaining -= encoder.encode(key).byteLength;
        if (budget.remaining < 0) { overflow = true; throw Error("Native-control argument exceeds byte bound"); }
        Object.defineProperty(result, key, { value: clone(descriptor.value, budget, depth + 1), writable: true, enumerable: true, configurable: true });
      }
      return result;
    } finally { budget.seen.delete(value); }
  };
  const append = (kind, value) => {
    if (closed || overflow) return false;
    const row = { sequence: records.length + 1, receivedAt: Date.now(), kind, ...clone(value) };
    const serialized = JSON.stringify(row), size = encoder.encode(serialized).byteLength;
    if (records.length >= maxRecords || bytes + size > maxBytes) { overflow = true; return false; }
    records.push(JSON.parse(serialized)); bytes += size; return true;
  };
  const failureValue = value => ({ name: String(value?.name ?? "Error"), message: String(value?.message ?? value).slice(0, 1024) });
  for (const patch of methods) patch.wrapper = function (...args) {
    if (closed || overflow) return Reflect.apply(patch.original, this, args);
    const operationId = ++nextOperation;
    const captured = safely(() => append("call", { operationId, api: patch.api, args }));
    if (captured) pending.set(operationId, { operationId, api: patch.api, callSequence: records.at(-1).sequence });
    const finish = (kind, failure) => safely(() => {
      if (closed || !captured) return;
      pending.delete(operationId);
      append(kind, { operationId, api: patch.api, ...(failure === undefined ? {} : { error: failureValue(failure) }) });
    });
    let result;
    try { result = Reflect.apply(patch.original, this, args); }
    catch (failure) { finish("threw", failure); throw failure; }
    if (captured) {
      try { Promise.prototype.then.call(result, () => finish("fulfilled"), failure => finish("rejected", failure)); }
      catch (failure) { finish("settlement-unobserved", failure); error(`${patch.api} did not return an observable original Promise`); }
    }
    return result;
  };
  for (const event of events) event.listener = (...args) => { safely(() => append("event", { api: event.api, args })); };
  const snapshot = () => JSON.parse(JSON.stringify({ version: 1, maxRecords, maxBytes, bytes, records, errors, overflow, closed, restored, listenersRemoved,
    pendingOperations: [...pending.values()],
    boundary: "This isolated extension worker after installation only. All debugger sendCommand targets/methods/parameters and selected Chrome control calls are recorded; fulfilled records acknowledge original Promise success without retaining result payloads. Promise side reactions and serialization are not timing-neutral. Absence of recorded explicit activation does not prove OS/user causation or exclude renderer-initiated focus." }));
  const installedMethods = [], installedEvents = [];
  const restore = () => {
    let complete = true, removed = true;
    for (const patch of installedMethods.toReversed()) {
      try {
        if (patch.object[patch.name] !== patch.wrapper) throw Error(`${patch.api} observer replaced before stop`);
        if (patch.descriptor) Object.defineProperty(patch.object, patch.name, patch.descriptor); else delete patch.object[patch.name];
        if (patch.object[patch.name] !== patch.original) throw Error(`${patch.api} observer restoration failed`);
      } catch (failure) { complete = false; error(failure); }
    }
    for (const { api, event, listener } of installedEvents.toReversed()) {
      try { event.removeListener(listener); if (event.hasListener(listener)) throw Error(`${api} listener still installed`); }
      catch (failure) { removed = false; error(failure); }
    }
    listenersRemoved = removed; return complete && removed;
  };
  const api = {
    snapshot,
    mark(label, value = null) {
      if (closed || typeof label !== "string" || !label || label.length > 256) throw Error("Invalid native-control stage mark");
      safely(() => append("mark", { label, value })); return snapshot();
    },
    stop() { if (!closed) { closed = true; restored = restore(); } return snapshot(); },
  };
  try {
    for (const patch of methods) {
      Object.defineProperty(patch.object, patch.name, patch.descriptor ? { ...patch.descriptor, value: patch.wrapper } :
        { value: patch.wrapper, configurable: true, enumerable: false, writable: true });
      installedMethods.push(patch);
    }
    for (const entry of events) { installedEvents.push(entry); entry.event.addListener(entry.listener); }
    Object.defineProperty(target, "__createdPageNativeControl", { value: api, configurable: true, enumerable: false, writable: true });
  } catch (failure) { closed = true; restore(); throw failure; }
  return { installed: true, version: 1, maxRecords, maxBytes, methods: methods.map(patch => patch.api), events: events.map(event => event.api) };
}
