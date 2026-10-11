// Locator upload resolves once, without visibility, pointer input or the
// upstream file setter. The backend owns the shared physical-node transaction.
export function validateFileInputPaths(files) {
  if (!Array.isArray(files) || files.length > 1024) throw new Error("setInputFiles files must be an array of at most 1024 paths");
  let total = 0;
  const encoder = new TextEncoder();
  return Object.freeze(Array.from(files, file => {
    if (typeof file !== "string" || !file || file.includes("\0") || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(file))
      throw new Error("setInputFiles paths must be non-empty, valid Unicode strings without NUL");
    if (!/^(?:\/|[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$))/.test(file)) throw new Error("setInputFiles requires absolute paths");
    if (file.length > 131072) throw new Error("setInputFiles paths exceed the byte limit");
    const length = encoder.encode(file).length;
    total += length;
    if (length > 131072 || total > 8 * 1024 * 1024) throw new Error("setInputFiles paths exceed the byte limit");
    return file;
  }));
}

export function captureFileInput(injected, { info, scope }) {
  const node = injected.querySelector(info.parsed, scope ?? document, info.strict);
  if (!node) return null;
  if (!(node instanceof HTMLInputElement) || node.type !== "file") throw new Error("setInputFiles locator must resolve to an input[type=file]");
  if (!node.isConnected || node.ownerDocument !== document) throw new Error("OBU_FILE_INPUT_CHANGED: original input is disconnected");
  return node;
}

export async function setLocatorInputFiles(locator, { deadlineAt, check, runNativeTask, prepare, files }) {
  const remaining = () => {
    const left = deadlineAt - performance.now();
    if (left <= 0) throw Object.assign(new Error("setInputFiles timed out"), { name: "TimeoutError" });
    return left;
  };
  const verify = async () => { remaining(); await check(); remaining(); };
  await verify();
  return runNativeTask(locator, { timeoutMs: remaining() }, async (frame, selector, progress, native) => {
    const handles = new Set();
    native.setHandleObserver(handle => handles.add(handle));
    const dispose = async handle => {
      try { await native.dispose(handle); handles.delete(handle); }
      catch (cause) { throw Object.assign(new Error("OBU_MEDIA_CLEANUP_FAILED: original file input handle release failed"), {
        mediaCleanupFailed: true, cause, retryMediaCleanup: cleanup
      }); }
    };
    const adapter = { evaluateHandle: (...args) => native.evaluateHandle(...args), getContentFrame: handle => native.getContentFrame(handle), dispose };
    let originalError;
    const cleanup = async () => {
      const errors = [];
      for (const handle of handles) {
        try { await dispose(handle); } catch (error) { errors.push(error); }
      }
      if (errors.length) throw Object.assign(new Error("OBU_MEDIA_CLEANUP_FAILED: file input handle cleanup is unconfirmed"), {
        mediaCleanupFailed: true, cause: originalError ?? errors[0], cleanupErrors: errors, retryMediaCleanup: cleanup
      });
    };
    try {
      const selected = await frame.retryWithProgressAndTimeouts(progress, [0, 20, 50, 100, 100, 500], async again => {
        try {
          await verify(); progress.throwIfAborted();
          let resolved;
          try {
            resolved = await frame.selectors.resolveInjectedForSelector(selector, { strict: true, obuMedia: adapter });
            if (resolved && resolved.injected._context !== await resolved.frame._utilityContext())
              throw new Error("OBU_FILE_INPUT_CHANGED: selector context changed");
          } catch (error) {
            await verify(); progress.throwIfAborted();
            // Before a node is selected, retain the pinned frame's normal
            // context/selector waiting policy. Authority errors never enter it.
            if (error?.mediaCleanupFailed || frame._isErrorThatCannotBeRetried(error)) return { error };
            return again;
          }
          await verify(); progress.throwIfAborted();
          if (!resolved) return again;
          if (resolved.info.world !== "utility") throw new Error("OBU_FILE_INPUT_CHANGED: utility selector context required");
          await verify();
          let node;
          try { node = await native.evaluateHandle(resolved.injected, captureFileInput, { info: resolved.info, scope: resolved.scope }); }
          catch (error) {
            await verify(); progress.throwIfAborted();
            if (error?.mediaCleanupFailed || frame._isErrorThatCannotBeRetried(error)) return { error };
            return again;
          }
          await verify(); progress.throwIfAborted();
          // null is a genuine selector miss. A selected input is never retried.
          if (!node.asElement()) { await dispose(node); return again; }
          const identity = native.fileInputIdentity(node);
          const admission = prepare(identity);
          identity.check();
          const backendNodeId = await identity.describe();
          await verify(); identity.check(); admission.check();
          return { backendNodeId, admission };
        } catch (error) { return { error }; } // bypass Playwright's generic retry catch
      });
      if (selected?.error) throw selected.error;
      if (!selected?.admission) throw new Error("OBU_FILE_INPUT_CHANGED: file input resolution failed");
      await verify(); selected.admission.check();
      // Do not verify the old document after ACK: ordinary input/change handlers
      // may navigate. The backend retains authority and directory completion checks.
      await selected.admission.submit(selected.backendNodeId, files);
    } catch (error) { originalError = error; throw error; }
    finally { await cleanup(); }
  });
}
