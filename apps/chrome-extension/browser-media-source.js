// Private fixed-runtime adapter. These functions run in the selected Frame's
// utility world, never through public locator.evaluate or a main-world handle.
import { validateLocator } from "./browser-action-engine.js";
import { validateDownloadSource } from "./browser-downloads.js";
const expired = () => new Error("OBU_MEDIA_SOURCE_CHANGED: media element or document changed");
const timedOut = () => new Error("OBU_DOWNLOAD_TIMEOUT: media source deadline expired");

export function validateMediaDownload(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) throw new Error("downloadMedia requires an object");
  const { locator, ...base } = request;
  const params = validateDownloadSource(base);
  validateLocator(locator);
  if (!locator.length || locator.at(-1)?.kind === "frame") throw new Error("downloadMedia requires an exact element locator");
  return Object.freeze({ ...params, timeoutMs: params.timeoutMs ?? 10000,
    locator: Object.freeze(locator.map(step => Object.freeze({ ...step }))) });
}

export const MAX_MEDIA_BYTES = 8 * 1024 * 1024;
// Non-final chunks are divisible by three, so their canonical base64 joins
// without interior padding while remaining below the 256 KiB native limit.
export const MEDIA_CHUNK_BYTES = 256 * 1024 - 1;
// Only an adapter-owned binding from captureImageBinding reaches this private
// cleanup operation. Callers cannot supply an expression, function or arguments.
export const MEDIA_CANCEL_FUNCTION = "async function() { try { await this.cancel(); return true; } catch { return false; } }";

export function captureImageBinding(injected, { info, scope }) {
  const element = injected.querySelector(info.parsed, scope || document, true);
  if (!element) return { missing: true };
  const maxBytes = 8 * 1024 * 1024, maxPixels = 16 * 1024 * 1024;
  const connected = Object.getOwnPropertyDescriptor(Node.prototype, "isConnected").get;
  const owner = Object.getOwnPropertyDescriptor(Node.prototype, "ownerDocument").get;
  const unsupported = message => new Error("OBU_MEDIA_UNSUPPORTED: " + message);
  const changed = () => new Error("OBU_MEDIA_SOURCE_CHANGED: media element or document changed");
  const limit = () => new Error("OBU_MEDIA_LIMIT: embedded media exceeds its size limit");
  let kind, getter, url, width, height;
  try {
    getter = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "currentSrc").get;
    url = getter.call(element); kind = "img";
  } catch {
    if (typeof HTMLMediaElement !== "undefined") {
      try {
        getter = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "currentSrc").get;
        url = getter.call(element);
        kind = Object.getOwnPropertyDescriptor(Element.prototype, "localName").get.call(element);
        if (kind !== "audio" && kind !== "video") kind = undefined;
      } catch { kind = undefined; }
    }
    if (!kind && typeof HTMLCanvasElement !== "undefined") {
      try {
        width = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, "width").get.call(element);
        height = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, "height").get.call(element);
        kind = "canvas";
      } catch { kind = undefined; }
    }
  }
  if (!kind) throw unsupported("an exact HTML img, video, audio or canvas element is required");
  let transport;
  if (kind === "canvas") {
    if (!width || !height) throw unsupported("canvas has no pixels");
    if (width > maxPixels / height) throw limit();
    transport = "bytes";
  } else {
    if (!url) throw unsupported("the media has no selected currentSrc");
    // Keep arbitrarily large data strings inside their original renderer. The
    // length guard runs before URL parsing, UTF-8 encoding or native decoding.
    if (url.length > maxBytes * 3 + 1024) throw limit();
    let parsed;
    try { parsed = new URL(url); } catch { throw unsupported("selected source is not an absolute URL"); }
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      if (new TextEncoder().encode(url).length > 8192 || parsed.username || parsed.password || /[\x00-\x20\x7f]/.test(url))
        throw unsupported("HTTP(S) media source is invalid or too large");
      transport = "http";
    } else if (parsed.protocol === "data:") {
      const comma = url.indexOf(",");
      if (comma < 5 || comma > 1024) throw unsupported("invalid data media source");
      transport = "bytes";
    } else if (parsed.protocol === "blob:") {
      if (url.length > 8192) throw limit();
      const originGetter = Object.getOwnPropertyDescriptor(globalThis, "origin")?.get ??
        (typeof Window === "undefined" ? undefined : Object.getOwnPropertyDescriptor(Window.prototype, "origin")?.get);
      const origin = originGetter?.call(globalThis);
      if (!origin || origin === "null" || parsed.origin !== origin) throw unsupported("blob source must belong to the selected document origin");
      transport = "bytes";
    } else throw unsupported("selected media scheme is unsupported");
  }
  const binding = { missing: false, element, document, kind, url, transport, width, height, maxBytes,
    controller: transport === "bytes" ? new AbortController() : null, reader: null, cancelled: false, blob: null, started: false };
  binding.verify = () => {
    if (binding.document !== document || !connected.call(element) || owner.call(element) !== document) throw changed();
    if (kind === "canvas") {
      if (Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, "width").get.call(element) !== width ||
          Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, "height").get.call(element) !== height) throw changed();
    } else if (getter.call(element) !== url) throw changed();
    if (kind === "audio" || kind === "video") {
      const media = HTMLMediaElement.prototype;
      if (Object.getOwnPropertyDescriptor(media, "srcObject").get.call(element) !== null)
        throw unsupported("srcObject media providers are unsupported");
      const duration = Object.getOwnPropertyDescriptor(media, "duration").get.call(element);
      if (duration === Infinity) throw unsupported("unbounded live media is unsupported");
      const keys = Object.getOwnPropertyDescriptor(media, "mediaKeys")?.get;
      if (keys && keys.call(element) !== null) throw unsupported("encrypted media is unsupported");
    }
    if (binding.cancelled) throw new Error("OBU_DOWNLOAD_EXPIRED: media read was cancelled");
    return transport === "http" ? { url } : { transport: "bytes", kind };
  };
  binding.stop = () => {
    if (!binding.stopPromise) {
      // Close pending read requests before abort errors the fetch stream. Both
      // native cancellation and the reader's finally block join this exact
      // promise; an underlying stream cancellation failure is not swallowed.
      let pending;
      try { pending = binding.reader ? ReadableStreamDefaultReader.prototype.cancel.call(binding.reader) : undefined; }
      catch (error) { pending = Promise.reject(error); }
      binding.stopPromise = Promise.resolve(pending);
      if (binding.controller) AbortController.prototype.abort.call(binding.controller);
    }
    return binding.stopPromise;
  };
  binding.cancel = async () => {
    binding.cancelled = true;
    await binding.stop();
  };
  binding.verify();
  return binding;
}

export function verifyImageBinding(binding) {
  return binding.verify();
}

export async function prepareMediaBytes(binding) {
  binding.verify();
  if (binding.started || binding.transport !== "bytes") throw new Error("OBU_MEDIA_READ_FAILED: invalid embedded media state");
  binding.started = true;
  const limit = () => new Error("OBU_MEDIA_LIMIT: embedded media exceeds its size limit");
  let blob;
  try {
    if (binding.kind === "canvas") {
      try {
        blob = await new Promise(resolve => HTMLCanvasElement.prototype.toBlob.call(binding.element, resolve, "image/png"));
      } catch (error) {
        if (error?.name === "SecurityError") throw new Error("OBU_MEDIA_TAINTED: canvas is not origin-clean");
        throw error;
      }
    } else {
      // Only a selected same-document-origin blob or data URL gets here. HTTP
      // continues through the native download GET and never uses utility fetch.
      const response = await globalThis.fetch(binding.url, { signal: binding.controller.signal, credentials: "omit", redirect: "error" });
      binding.verify();
      if (!response.ok || !response.body) throw new Error("OBU_MEDIA_READ_FAILED: embedded media is unavailable");
      const mimeType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() ?? "";
      const expected = binding.kind === "img" ? "image/" : binding.kind + "/";
      if ((mimeType.length > 127 || !/^(?:image|audio|video)\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(mimeType)) || !mimeType.startsWith(expected))
        throw new Error("OBU_MEDIA_UNSUPPORTED: embedded media MIME type does not match the selected element");
      const declared = response.headers.get("content-length");
      if (declared !== null && /^\d+$/.test(declared) && Number(declared) > binding.maxBytes) throw limit();
      const chunks = []; let byteLength = 0;
      const reader = ReadableStream.prototype.getReader.call(response.body);
      binding.reader = reader;
      try {
        while (true) {
          binding.verify();
          const chunk = await ReadableStreamDefaultReader.prototype.read.call(reader);
          binding.verify();
          if (chunk.done) break;
          if (!(chunk.value instanceof Uint8Array) || chunk.value.byteLength > binding.maxBytes - byteLength) throw limit();
          byteLength += chunk.value.byteLength; chunks.push(chunk.value);
        }
      } finally {
        // Abort covers an incomplete stream even when the source changed or a
        // size/MIME check failed. Never leave a fetch behind a disposed handle.
        try { await binding.stop(); }
        finally {
          ReadableStreamDefaultReader.prototype.releaseLock.call(reader);
          binding.reader = null;
        }
      }
      blob = new Blob(chunks, { type: mimeType });
    }
    binding.verify();
    if (!blob) throw new Error("OBU_MEDIA_READ_FAILED: native media encoding returned no bytes");
    const byteLength = Object.getOwnPropertyDescriptor(Blob.prototype, "size").get.call(blob);
    const mimeType = Object.getOwnPropertyDescriptor(Blob.prototype, "type").get.call(blob);
    if (!Number.isSafeInteger(byteLength) || byteLength < 1) throw new Error("OBU_MEDIA_READ_FAILED: embedded media is empty");
    if (byteLength > binding.maxBytes) throw limit();
    if (binding.kind === "canvas" && mimeType !== "image/png") throw new Error("OBU_MEDIA_READ_FAILED: canvas encoding is not PNG");
    binding.blob = blob;
    return { mimeType, byteLength };
  } catch (error) {
    // Headers may reject before a reader is acquired. The fetch promise has
    // settled; abort synchronously signals cancellation of its unread body.
    AbortController.prototype.abort.call(binding.controller);
    if (/^OBU_(?:MEDIA|DOWNLOAD)_/.test(error?.message ?? "")) throw error;
    throw new Error("OBU_MEDIA_READ_FAILED: embedded media is revoked, unreadable or not a finite Blob");
  }
}

export async function readMediaChunk(binding, { offset, length }) {
  binding.verify();
  if (!binding.blob || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > 256 * 1024)
    throw new Error("OBU_MEDIA_READ_FAILED: invalid media chunk");
  const size = Object.getOwnPropertyDescriptor(Blob.prototype, "size").get.call(binding.blob);
  if (offset >= size || length > size - offset) throw new Error("OBU_MEDIA_READ_FAILED: media chunk exceeds captured bytes");
  const chunk = Blob.prototype.slice.call(binding.blob, offset, offset + length);
  const bytes = new Uint8Array(await Blob.prototype.arrayBuffer.call(chunk));
  binding.verify();
  let binary = "";
  for (let index = 0; index < bytes.length; index += 32768) binary += String.fromCharCode(...bytes.subarray(index, index + 32768));
  return { offset, byteLength: bytes.byteLength, base64: btoa(binary) };
}

function validateSourceURL(value) {
  if (typeof value !== "string" || !value || new TextEncoder().encode(value).length > 8192 || /[\x00-\x20\x7f]/.test(value))
    throw new Error("OBU_MEDIA_UNSUPPORTED: selected image source is unavailable or too large");
  let url;
  try { url = new URL(value); } catch { throw new Error("OBU_MEDIA_UNSUPPORTED: selected image source is not an absolute URL"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new Error("OBU_MEDIA_UNSUPPORTED: only HTTP(S) image sources without embedded credentials are supported");
  return value;
}

export async function readMediaSource(locator, { deadlineAt, check, runNativeTask, onCancel }) {
  if (!Number.isFinite(deadlineAt) || typeof check !== "function" || typeof runNativeTask !== "function" || (onCancel !== undefined && typeof onCancel !== "function")) throw new Error("Invalid media source adapter options");
  let cancelled, cancelNative = null, cancelPromise = null, cleaned = false;
  const cancel = reason => {
    cancelled ??= reason instanceof Error ? reason : new Error("OBU_DOWNLOAD_EXPIRED: media read was cancelled");
    if (cleaned || !cancelNative) return Promise.resolve();
    if (cancelPromise) return cancelPromise;
    const pending = Promise.resolve().then(cancelNative);
    cancelPromise = pending;
    pending.catch(() => { if (cancelPromise === pending) cancelPromise = null; });
    return pending;
  };
  const unsubscribe = onCancel?.(cancel) ?? (() => {});
  const remaining = () => { if (cancelled) throw cancelled; const value = deadlineAt - performance.now(); if (value <= 0) throw timedOut(); return value; };
  const verify = async () => { remaining(); await check(); remaining(); };
  try {
    await verify();
    return await runNativeTask(locator, { timeoutMs: remaining() }, async (frame, selector, progress, native) => {
      const handles = new Set(), failedDisposals = new Set();
      let operationError;
      native.setHandleObserver(handle => handles.add(handle));
      progress.cleanupWhenAborted?.(() => cancel(timedOut()));
      const dispose = async handle => {
        try { await native.dispose(handle); handles.delete(handle); failedDisposals.delete(handle); }
        catch (error) { failedDisposals.add(handle); throw error; }
      };
      const cleanup = async (retry = false) => {
        for (const handle of [...handles]) {
          if (!retry && failedDisposals.has(handle)) continue;
          try { await dispose(handle); } catch { /* Preserve this exact handle for explicit cleanup retry. */ }
        }
        if (!handles.size) cleaned = true;
        if (handles.size) throw Object.assign(new Error("OBU_MEDIA_CLEANUP_FAILED: media handle disposal is not confirmed"), {
          mediaCleanupFailed: true, retryMediaCleanup: () => cleanup(true), cause: operationError
        });
      };
      const media = {
        getContentFrame: handle => native.getContentFrame(handle),
        evaluateHandle: async (handle, fn, arg) => {
          const owned = await native.evaluateHandle(handle, fn, arg);
          handles.add(owned);
          return owned;
        },
        dispose
      };
      try {
        const root = frame._page.mainFrame();
        await verify();
        const rootContext = await root._utilityContext();
        await verify(); progress.throwIfAborted();
        const assertDocument = async () => {
          await verify(); progress.throwIfAborted();
          if (root !== frame._page.mainFrame() || root.isDetached() || frame.isDetached()) throw expired();
          if (await root._utilityContext() !== rootContext) throw expired();
          await verify(); progress.throwIfAborted();
        };
        // Reuse the pinned native polling loop. Only an absent node/frame is
        // retried; a selected node, context error, or ownership failure is final.
        const selected = await frame.retryWithProgressAndTimeouts(progress, [0, 20, 50, 100, 100, 500], async continuePolling => {
          let binding;
          try {
            await assertDocument();
            const resolved = await frame.selectors.resolveInjectedForSelector(selector, { strict: true, obuMedia: media });
            await assertDocument();
            if (!resolved) return continuePolling;
            if (resolved.info.world !== "utility") throw new Error("OBU_MEDIA_UNSUPPORTED: media selectors must resolve in the utility world");
            const context = await resolved.frame._utilityContext();
            await assertDocument();
            if (resolved.injected._context !== context || context.world !== "utility") throw expired();
            binding = await media.evaluateHandle(resolved.injected, captureImageBinding, { info: resolved.info, scope: resolved.scope });
            await assertDocument();
            const first = await native.evaluate(binding, value => value.missing ? { missing: true } : { missing: false, ...value.verify() });
            await assertDocument();
            if (first.missing) { await dispose(binding); binding = undefined; return continuePolling; }
            if (first.url !== undefined) validateSourceURL(first.url);
            else if (first.transport !== "bytes") throw new Error("OBU_MEDIA_READ_FAILED: invalid source metadata");
            const selectedBinding = { binding, frame: resolved.frame, context, url: first.url, transport: first.transport };
            binding = undefined;
            return selectedBinding;
          } catch (error) {
            // Return the error outside the native retry catch; an ordinary policy
            // error is not a transient selector miss and must not be retried.
            return { error };
          }
        });
        if (selected?.error) throw selected.error;
        if (!selected?.binding) throw expired();
        if (selected.transport === "bytes") {
          if (typeof native.cancel !== "function") throw new Error("OBU_MEDIA_UNSUPPORTED: private media cancellation is unavailable");
          cancelNative = () => native.cancel(selected.binding);
          if (cancelled) await cancel(cancelled);
        }
        await assertDocument();
        if (selected.frame.isDetached() || await selected.frame._utilityContext() !== selected.context) throw expired();
        await assertDocument();
        if (selected.transport !== "bytes") {
          const result = await native.evaluate(selected.binding, verifyImageBinding);
          await assertDocument();
          if (result.url !== selected.url) throw expired();
          return { url: validateSourceURL(result.url) };
        }
        const metadata = await native.evaluate(selected.binding, prepareMediaBytes);
        await assertDocument();
        if (!metadata || !Number.isSafeInteger(metadata.byteLength) || metadata.byteLength < 1 || metadata.byteLength > MAX_MEDIA_BYTES ||
            typeof metadata.mimeType !== "string" || metadata.mimeType.length > 127 || !/^(?:image|audio|video)\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(metadata.mimeType))
          throw new Error("OBU_MEDIA_READ_FAILED: invalid captured byte metadata");
        const chunks = [];
        for (let offset = 0; offset < metadata.byteLength; offset += MEDIA_CHUNK_BYTES) {
          await assertDocument();
          const length = Math.min(MEDIA_CHUNK_BYTES, metadata.byteLength - offset);
          const chunk = await native.evaluate(selected.binding, readMediaChunk, { offset, length });
          await assertDocument();
          if (!chunk || chunk.offset !== offset || chunk.byteLength !== length || typeof chunk.base64 !== "string" ||
              chunk.base64.length !== 4 * Math.ceil(length / 3) || !/^[A-Za-z0-9+/]*={0,2}$/.test(chunk.base64))
            throw new Error("OBU_MEDIA_READ_FAILED: invalid native media chunk");
          const binary = atob(chunk.base64);
          if (binary.length !== length || btoa(binary) !== chunk.base64) throw new Error("OBU_MEDIA_READ_FAILED: noncanonical media chunk");
          chunks.push(chunk.base64);
        }
        await native.evaluate(selected.binding, verifyImageBinding);
        await assertDocument();
        return { bytesBase64: chunks.join(""), mimeType: metadata.mimeType, byteLength: metadata.byteLength };
      } catch (error) {
        operationError = error;
        throw error;
      } finally {
        // Join the actual dispose promise. Neither the caller's deadline race
        // nor Playwright ProgressController timeout substitutes for settlement.
        // Cancellation commands use the exact original binding and may bypass
        // admission solely for cleanup. Join actual abort before releasing it.
        if (cancelPromise) await cancelPromise.catch(() => {});
        await cleanup();
        cleaned = true;
      }
    });
  } catch (error) {
    if (error?.name === "TimeoutError") throw timedOut();
    throw error;
  } finally {
    unsubscribe();
  }
}
