// Passive, task-local instrumentation of the public JS SDK. No browser driver,
// fixture knowledge, automatic cleanup, retry, or replacement action lives here.
import * as fs from "node:fs/promises";
import path from "node:path";
import { URL, pathToFileURL, fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { isPromise } from "node:util/types";
import { Buffer } from "node:buffer";
import { performance } from "node:perf_hooks";

const LIMITS = Object.freeze({ calls: 10000, nodes: 20000, depth: 64, itemBytes: 64 * 1024 * 1024,
  totalBytes: 256 * 1024 * 1024, inlineStringBytes: 32768 });
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
// performance.now() remains available in the solver runtime without a global
// process. Preserve integer nanosecond units, not a nanosecond precision claim.
const stamp = () => ({ wallMs: Date.now(), monotonicNs: BigInt(Math.trunc(performance.now() * 1e6)).toString() });
const plain = value => value !== null && typeof value === "object" &&
  (Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

// Only copy data containers when they actually contain a mapped SDK object.
// Descriptors, symbols, holes, cycles and untouched values are preserved. Never
// evaluate an input getter merely to log or unwrap it.
function mapSDKReferences(value, map) {
  const object = current => (typeof current === "object" || typeof current === "function") && current !== null;
  if (!object(value)) return value;
  const replacement = map(value);
  if (replacement !== value || !plain(value)) return replacement;
  const nodes = new WeakMap(), changed = [];
  const inspect = current => {
    if (nodes.has(current)) return nodes.get(current);
    const node = { original: current, properties: [], parents: new Set(), dirty: false };
    nodes.set(current, node);
    for (const key of Reflect.ownKeys(current)) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key), entry = { key, descriptor };
      node.properties.push(entry);
      if (!("value" in descriptor) || !object(descriptor.value)) continue;
      entry.replacement = map(descriptor.value);
      if (entry.replacement !== descriptor.value) node.dirty = true;
      else if (plain(descriptor.value)) { entry.child = inspect(descriptor.value); entry.child.parents.add(node); }
    }
    if (node.dirty) changed.push(node);
    return node;
  };
  const root = inspect(value);
  for (let index = 0; index < changed.length; index++) for (const parent of changed[index].parents) {
    if (!parent.dirty) { parent.dirty = true; changed.push(parent); }
  }
  if (!root.dirty) return value;
  const copied = new WeakMap();
  const copy = node => {
    if (!node.dirty) return node.original;
    if (copied.has(node.original)) return copied.get(node.original);
    const result = Array.isArray(node.original) ? [] : Object.create(Object.getPrototypeOf(node.original));
    copied.set(node.original, result);
    for (const entry of node.properties) {
      const descriptor = { ...entry.descriptor };
      if (entry.child) descriptor.value = copy(entry.child);
      else if (Object.hasOwn(entry, "replacement")) descriptor.value = entry.replacement;
      Object.defineProperty(result, entry.key, descriptor);
    }
    return result;
  };
  return copy(root);
}

/** Await this factory. directory must be a new absolute attempt directory. */
export async function createRecordedAgentSDK({ sdkPath, directory }) {
  if (typeof directory !== "string" || !path.isAbsolute(directory)) throw Error("An absolute new log directory is required");
  const sdkURL = sdkPath instanceof URL ? sdkPath : typeof sdkPath === "string" && path.isAbsolute(sdkPath) ? pathToFileURL(sdkPath) : null;
  if (!sdkURL || sdkURL.protocol !== "file:") throw Error("sdkPath must be an absolute file path or file URL");
  const sdk = await import(sdkURL.href);
  if (typeof sdk.connectOpenBrowserUse !== "function") throw Error("The module does not export connectOpenBrowserUse");
  const prototypes = new Map(Object.entries(sdk).filter(([name, value]) =>
    name.startsWith("OpenBrowserUse") && typeof value === "function" && value.prototype).map(([name, value]) => [value.prototype, name]));
  if (!prototypes.size) throw Error("No exported SDK class prototypes found");
  await fs.mkdir(directory); // EEXIST is deliberate: never reuse an old attempt.
  await fs.mkdir(path.join(directory, "artifacts"));
  await fs.writeFile(path.join(directory, "recording.json"), JSON.stringify({ version: 1, sdkURL: sdkURL.href,
    sdkEntrySha256: digest(await fs.readFile(fileURLToPath(sdkURL))), created: stamp(), limits: LIMITS,
    scope: "Public SDK calls only; no internal RPC or notification capture. SDK and callback objects are opaque references. Accessors are not evaluated. flush never waits for an SDK operation." }, null, 2) + "\n", { flag: "wx" });
  const log = await fs.open(path.join(directory, "calls.jsonl"), "wx");
  let queue = Promise.resolve(), failure, bytes = 0, callNumber = 0, objectNumber = 0, artifactNumber = 0, closed = false, closing = false, closePromise;
  const originals = new WeakMap(), proxies = new WeakMap(), references = new WeakMap(), pending = new Set();
  const fail = error => { failure ??= error instanceof Error ? error : Error(String(error)); };
  const enqueue = operation => { queue = queue.then(operation).catch(fail); };
  const reserve = size => {
    if (size > LIMITS.itemBytes || bytes + size > LIMITS.totalBytes) throw Error("Recorded SDK byte limit exceeded; audit is incomplete");
    bytes += size;
  };
  const className = value => {
    if (!value || typeof value !== "object") return null;
    for (let prototype = Object.getPrototypeOf(value); prototype; prototype = Object.getPrototypeOf(prototype)) {
      if (prototypes.has(prototype)) return prototypes.get(prototype);
    }
    return null;
  };
  const ref = (value, kind = className(value) ?? (typeof value === "function" ? "Function" : "OpaqueObject")) => {
    value = originals.get(value) ?? value;
    if (!references.has(value)) {
      const result = { $sdkRef: `object-${++objectNumber}`, kind };
      // Only these documented public properties identify a tab. In particular,
      // do not enumerate compiled TypeScript private fields such as .call.
      const id = kind === "OpenBrowserUseTab" ? Object.getOwnPropertyDescriptor(value, "id")?.value :
        ["OpenBrowserUseLocator", "OpenBrowserUseTabPlaywright", "OpenBrowserUseMouse", "OpenBrowserUseKeyboard"].includes(kind)
          ? Object.getOwnPropertyDescriptor(Object.getOwnPropertyDescriptor(value, "tab")?.value ?? {}, "id")?.value : undefined;
      if (Number.isSafeInteger(id)) result.tabId = id;
      references.set(value, result);
    }
    return references.get(value);
  };
  const artifact = (content, encoding, extra = {}) => {
    reserve(content.length);
    const file = `artifacts/${String(++artifactNumber).padStart(6, "0")}.${encoding === "json-string" ? "json" : "bin"}`;
    const result = { $artifact: file, encoding, bytes: content.length, sha256: digest(content), ...extra };
    enqueue(() => fs.writeFile(path.join(directory, file), content, { flag: "wx" }));
    return result;
  };
  const serialize = input => {
    const seen = new WeakMap(); let count = 0;
    const visit = (value, depth = 0) => {
      if (++count > LIMITS.nodes || depth > LIMITS.depth) throw Error("Recorded SDK structure limit exceeded; audit is incomplete");
      if (value === undefined) return { $type: "undefined" };
      if (value === null || typeof value === "boolean") return value;
      if (typeof value === "number") return Number.isFinite(value) && !Object.is(value, -0) ? value : { $type: "number", value: String(Object.is(value, -0) ? "-0" : value) };
      if (typeof value === "bigint") return { $type: "bigint", value: value.toString() };
      if (typeof value === "string") {
        const length = Buffer.byteLength(value);
        if (length > LIMITS.itemBytes) throw Error("Recorded SDK string limit exceeded; audit is incomplete");
        // JSON preserves even isolated UTF-16 surrogates; Buffer.from(value)
        // alone would silently replace them before the evidence was written.
        return length > LIMITS.inlineStringBytes ? artifact(Buffer.from(JSON.stringify(value)), "json-string") : value;
      }
      if (typeof value === "symbol") return { $type: "symbol", description: value.description };
      value = originals.get(value) ?? value;
      if (className(value) || typeof value === "function") return ref(value);
      if (seen.has(value)) return { $cycle: seen.get(value) };
      const objectId = `value-${count}`; seen.set(value, objectId);
      if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) {
        return artifact(Buffer.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)), "bytes", { type: Buffer.isBuffer(value) ? "Buffer" : Object.getPrototypeOf(value).constructor.name });
      }
      if (value instanceof ArrayBuffer) return artifact(Buffer.from(new Uint8Array(value)), "bytes", { type: "ArrayBuffer" });
      if (value instanceof Date) return { $type: "Date", value: Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString() };
      if (value instanceof RegExp) return { $type: "RegExp", source: value.source, flags: value.flags, lastIndex: value.lastIndex };
      if (!plain(value) && !(value instanceof Error)) return ref(value);
      const properties = {};
      for (const key of Reflect.ownKeys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        const name = typeof key === "symbol" ? `[symbol:${key.description ?? ""}]` : key;
        Object.defineProperty(properties, name, { value: "value" in descriptor ? visit(descriptor.value, depth + 1) :
          { $type: "accessor", get: Boolean(descriptor.get), set: Boolean(descriptor.set), observed: false }, enumerable: true });
      }
      if (Array.isArray(value)) return { $type: "Array", $id: objectId, properties };
      if (value instanceof Error) return { $type: "Error", $id: objectId, name: Object.getOwnPropertyDescriptor(Object.getPrototypeOf(value), "name")?.value ?? "Error", properties };
      return { $type: "Object", $id: objectId, nullPrototype: Object.getPrototypeOf(value) === null, properties };
    };
    return visit(input);
  };
  const write = record => {
    if (failure) return;
    try { const line = JSON.stringify(record) + "\n"; reserve(Buffer.byteLength(line)); enqueue(() => log.appendFile(line)); }
    catch (error) { fail(error); }
  };
  const observe = value => { if (failure) return { $unrecorded: true }; try { return serialize(value); } catch (error) { fail(error); return { $unrecorded: true }; } };
  const wrap = value => mapSDKReferences(value, current => {
    if (originals.has(current) || !className(current)) return current;
    if (proxies.has(current)) return proxies.get(current);
    const methods = new Map();
    const proxy = new Proxy(current, { get(target, key) {
      const member = Reflect.get(target, key, target);
      let sdkMethod = false;
      if (typeof key === "string" && key !== "constructor" && !Object.hasOwn(target, key)) {
        for (let prototype = Object.getPrototypeOf(target); prototypes.has(prototype); prototype = Object.getPrototypeOf(prototype)) {
          if (Object.getOwnPropertyDescriptor(prototype, key)?.value === member) { sdkMethod = true; break; }
        }
      }
      if (typeof member !== "function" || !sdkMethod) return wrap(member);
      if (!methods.has(key) || methods.get(key).original !== member) methods.set(key, { original: member,
        wrapped: (...args) => invoke(target, key, member, args) });
      return methods.get(key).wrapped;
    } });
    proxies.set(current, proxy); originals.set(proxy, current); ref(current);
    return proxy;
  });
  function invoke(receiver, operation, method, args) {
    if (closed || closing) throw Error("Recorded SDK log is closed; create a new recorder for new calls");
    const callId = `call-${++callNumber}`;
    if (callNumber > LIMITS.calls) fail(Error("Recorded SDK call limit exceeded; audit is incomplete"));
    const recordedArgs = observe(args), receiverRef = receiver === sdk ? { $sdkModule: sdkURL.href } : ref(receiver);
    let actualArgs;
    try { actualArgs = mapSDKReferences(args, value => originals.get(value) ?? value); }
    catch (error) { fail(error); throw error; }
    const start = stamp(); pending.add(callId);
    write({ version: 1, phase: "start", callId, receiver: receiverRef, operation, start, args: recordedArgs });
    const finish = (phase, value, asynchronous) => {
      const end = stamp(); pending.delete(callId);
      write({ version: 1, phase, callId, receiver: receiverRef, operation, start, end,
        elapsedNs: (BigInt(end.monotonicNs) - BigInt(start.monotonicNs)).toString(), asynchronous,
        [phase === "return" ? "result" : "error"]: observe(value) });
    };
    let result;
    try { result = Reflect.apply(method, receiver, actualArgs); }
    catch (error) { finish("throw", error, false); throw error; }
    const deliver = value => { try { return wrap(value); } catch (error) { fail(error); return value; } };
    if (isPromise(result)) return result.then(value => { finish("return", value, true); return deliver(value); }, error => { finish("throw", error, true); throw error; });
    finish("return", result, false); return deliver(result);
  }
  const flush = async () => {
    // Flush only already-enqueued evidence. A pending native operation is not
    // completed, cancelled, retried or waited upon by this logging API.
    await queue;
    if (!closed) try { await log.sync(); } catch (error) { fail(error); }
    if (failure) throw failure;
    return { calls: callNumber, pendingCalls: [...pending], bytes, directory };
  };
  return Object.freeze({
    connect: options => invoke(sdk, "connectOpenBrowserUse", sdk.connectOpenBrowserUse, [options]),
    flush,
    async closeLog() {
      if (closed) return flush();
      if (closePromise) return closePromise;
      if (pending.size) throw Error("SDK calls are still pending; closeLog does not cancel or wait for them");
      closing = true;
      write({ version: 1, phase: "close", at: stamp(), calls: callNumber, pendingCalls: [] });
      closePromise = (async () => {
        try { await flush(); } finally { try { await log.close(); } catch (error) { fail(error); } closed = true; closing = false; }
        if (failure) throw failure;
        return { calls: callNumber, pendingCalls: [], bytes, directory };
      })();
      return closePromise;
    },
  });
}
