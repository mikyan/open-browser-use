// A narrow bridge into the pinned native client Waiter. Navigation matching,
// lifecycle state, errors and cleanup remain Playwright's implementation.
function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw new Error("Pinned Playwright navigation waiter shape changed; review the ready/cancel bridge");
  return source.replace(before, after);
}

const bridge = `
const obuNavigationWaitControl = Symbol("Open Browser Use navigation wait");

export function createOpenBrowserUseNavigationWait(page, options) {
  if (!options || !["url", "loadstate"].includes(options.event) ||
      !Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0 ||
      (options.event === "url" && typeof options.url !== "string"))
    throw new Error("Invalid native navigation wait options");
  let readyResolve, readyReject, cancelReject;
  let settled = false, readySettled = false, cancellationError;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const cancelled = new Promise((_, reject) => { cancelReject = reject; });
  // Consumers may await ready before result, or cancel before native setup.
  ready.catch(() => {});
  cancelled.catch(() => {});
  const control = {
    cancelled,
    assertActive() { if (cancellationError) throw cancellationError; },
    markReady() {
      if (readySettled || cancellationError) return;
      readySettled = true;
      readyResolve();
    }
  };
  const rejectReady = error => {
    if (readySettled) return;
    readySettled = true;
    readyReject(error);
  };
  let nativeResult;
  try {
    const nativeOptions = { timeout: options.timeoutMs, [obuNavigationWaitControl]: control };
    nativeResult = options.event === "url"
      ? page.waitForURL(options.url, { ...nativeOptions, waitUntil: options.waitUntil })
      : page.waitForLoadState(options.state, nativeOptions);
  } catch (error) {
    nativeResult = Promise.reject(error);
  }
  // Result represents actual native settlement, including Waiter disposal. If
  // an API wrapper is delayed before setup, cancellation rejects ready now but
  // result stays tracked until that wrapper reaches its pre-registration fence.
  const nativeCompletion = Promise.resolve(nativeResult).then(() => {
    control.assertActive();
    control.markReady();
  });
  const result = nativeCompletion.then(
    () => { settled = true; },
    error => { settled = true; rejectReady(error); throw error; }
  );
  result.catch(() => {});
  return {
    ready, result,
    cancel(error = new Error("Navigation wait cancelled")) {
      if (settled || cancellationError) return;
      cancellationError = error;
      rejectReady(error);
      cancelReject(error);
    }
  };
}
`;

export function patchCrxNavigationWaits(source) {
  source = replaceOnce(source,
    '  _setupNavigationWaiter(options2) {\n    const waiter = new Waiter(this._page, "");',
    '  _setupNavigationWaiter(options2) {\n    const obuControl = options2[obuNavigationWaitControl];\n    obuControl?.assertActive();\n    const waiter = new Waiter(this._page, "");\n    if (obuControl) {\n      waiter._obuNavigationControl = obuControl;\n      waiter._rejectOn(obuControl.cancelled);\n    }');
  source = replaceOnce(source,
    '  async waitForEvent(emitter, event, predicate) {\n    const { promise, dispose } = waitForEvent(emitter, event, this._savedZone, predicate);\n    return await this.waitForPromise(promise, dispose);\n  }',
    '  async waitForEvent(emitter, event, predicate) {\n    try { this._obuNavigationControl?.assertActive(); }\n    catch (error) { this.dispose(); throw error; }\n    const { promise, dispose } = waitForEvent(emitter, event, this._savedZone, predicate);\n    this._obuNavigationControl?.markReady();\n    return await this.waitForPromise(promise, dispose);\n  }');
  return source + bridge;
}
