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

export function captureImageBinding(injected, { info, scope }) {
  const element = injected.querySelector(info.parsed, scope || document, true);
  if (!element) return { missing: true };
  const connected = Object.getOwnPropertyDescriptor(Node.prototype, "isConnected").get;
  const owner = Object.getOwnPropertyDescriptor(Node.prototype, "ownerDocument").get;
  const currentSrc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "currentSrc").get;
  if (!connected.call(element) || owner.call(element) !== document)
    throw new Error("OBU_MEDIA_SOURCE_CHANGED: media element is detached");
  let url;
  try { url = currentSrc.call(element); }
  catch { throw new Error("OBU_MEDIA_UNSUPPORTED: an exact HTML img element is required"); }
  if (!url) throw new Error("OBU_MEDIA_UNSUPPORTED: the image has no selected currentSrc");
  // Keep the exact node and its actual Document alive in one utility-world
  // handle. Query and the first getter call occur in this same renderer call.
  return { missing: false, element, document, url };
}

export function verifyImageBinding(binding) {
  const connected = Object.getOwnPropertyDescriptor(Node.prototype, "isConnected").get;
  const owner = Object.getOwnPropertyDescriptor(Node.prototype, "ownerDocument").get;
  const currentSrc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "currentSrc").get;
  if (binding.document !== document || !connected.call(binding.element) || owner.call(binding.element) !== document)
    throw new Error("OBU_MEDIA_SOURCE_CHANGED: media element or document changed");
  if (currentSrc.call(binding.element) !== binding.url)
    throw new Error("OBU_MEDIA_SOURCE_CHANGED: selected image source changed");
  return { url: binding.url };
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

export async function readMediaSource(locator, { deadlineAt, check, runNativeTask }) {
  if (!Number.isFinite(deadlineAt) || typeof check !== "function" || typeof runNativeTask !== "function") throw new Error("Invalid media source adapter options");
  const remaining = () => { const value = deadlineAt - performance.now(); if (value <= 0) throw timedOut(); return value; };
  const verify = async () => { remaining(); await check(); remaining(); };
  await verify();
  try {
    return await runNativeTask(locator, { timeoutMs: remaining() }, async (frame, selector, progress, native) => {
      const handles = new Set(), failedDisposals = new Set();
      let operationError;
      native.setHandleObserver(handle => handles.add(handle));
      const dispose = async handle => {
        try { await native.dispose(handle); handles.delete(handle); failedDisposals.delete(handle); }
        catch (error) { failedDisposals.add(handle); throw error; }
      };
      const cleanup = async (retry = false) => {
        for (const handle of [...handles]) {
          if (!retry && failedDisposals.has(handle)) continue;
          try { await dispose(handle); } catch { /* Preserve this exact handle for explicit cleanup retry. */ }
        }
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
            const first = await native.evaluate(binding, value => ({ missing: value.missing, url: value.url }));
            await assertDocument();
            if (first.missing) { await dispose(binding); binding = undefined; return continuePolling; }
            validateSourceURL(first.url);
            const selectedBinding = { binding, frame: resolved.frame, context, url: first.url };
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
        await assertDocument();
        if (selected.frame.isDetached() || await selected.frame._utilityContext() !== selected.context) throw expired();
        await assertDocument();
        const result = await native.evaluate(selected.binding, verifyImageBinding);
        await assertDocument();
        if (result.url !== selected.url) throw expired();
        return { url: validateSourceURL(result.url) };
      } catch (error) {
        operationError = error;
        throw error;
      } finally {
        // Join the actual dispose promise. Neither the caller's deadline race
        // nor Playwright ProgressController timeout substitutes for settlement.
        await cleanup();
      }
    });
  } catch (error) {
    if (error?.name === "TimeoutError") throw timedOut();
    throw error;
  }
}
