// This append-only bridge uses the pinned native controller and its actual task
// promise. It exposes no new public Playwright/channel method or page function.
export const mediaTaskBridge = `
function createOpenBrowserUseMediaOperations() {
  const releases = new WeakMap(), cancellations = new WeakMap();
  let observeHandle;
  const route = context => {
    const client = context?.delegate?._client;
    const transport = client?._connection?._transport;
    if (!(context.delegate instanceof CRExecutionContext) || !transport?._tabToTarget || !transport?._sessions)
      throw new Error("OBU_MEDIA_UNSUPPORTED: native Chromium context is unavailable");
    const root = /^crx-tab-(\\d+)$/.exec(client._sessionId);
    const target = root ? { tabId: Number(root[1]) } : { tabId: transport._sessions.get(client._sessionId), sessionId: client._sessionId };
    const identity = transport._tabToTarget.get(target.tabId);
    if (!Number.isSafeInteger(target.tabId) || !identity) throw new Error("OBU_MEDIA_SOURCE_CHANGED: native attachment is unavailable");
    const check = () => {
      if (transport._tabToTarget.get(target.tabId) !== identity || (!root && transport._sessions.get(client._sessionId) !== target.tabId))
        throw new Error("OBU_MEDIA_SOURCE_CHANGED: native attachment changed");
    };
    return { target, transport, check };
  };
  const evaluate = async (handle, fn, arg, returnByValue) => {
    if (!observeHandle || !(handle instanceof JSHandle$1) || handle._disposed || !handle._objectId || typeof fn !== "function")
      throw new Error("OBU_MEDIA_SOURCE_CHANGED: native utility handle is unavailable");
    const context = handle._context;
    if (context.world !== "utility") throw new Error("OBU_MEDIA_UNSUPPORTED: utility world required");
    const { target, transport, check } = route(context);
    if (openBrowserUseInputHooks && typeof openBrowserUseInputHooks.prepareMediaCleanup !== "function")
      throw new Error("OBU_MEDIA_UNSUPPORTED: native media cleanup hook is unavailable");
    const cleanup = openBrowserUseInputHooks ? openBrowserUseInputHooks.prepareMediaCleanup(target, context.delegate._contextId) : {
      release: objectId => { check(); return transport._send(target, "Runtime.releaseObject", { objectId }); },
      cancel: () => { throw new Error("OBU_MEDIA_UNSUPPORTED: private media cancellation hook is required"); }, close: () => {}
    };
    if (typeof cleanup?.release !== "function" || typeof cleanup?.close !== "function")
      throw new Error("OBU_MEDIA_UNSUPPORTED: invalid native media cleanup lease");
    const owned = new Set();
    let nativeSettled = false;
    const closeIfReleased = () => { if (nativeSettled && !owned.size) cleanup.close(); };
    try {
    check();
    // Do not use ExecutionContext/CRSession cancellation races: retain the real
    // native send and any object returned after the public deadline.
    const response = await transport._send(target, "Runtime.callFunctionOn", {
      objectId: handle._objectId,
      functionDeclaration: "function(argument) { return (" + String(fn) + ")(this, argument); }",
      arguments: [{ value: arg ?? null }], returnByValue, awaitPromise: true, userGesture: false
    });
    const own = remote => {
      const result = createHandle$3(context, remote);
      owned.add(result);
      releases.set(result, async checkCleanup => {
        if (result._objectId) await cleanup.release(result._objectId, checkCleanup);
        owned.delete(result); closeIfReleased();
      });
      cancellations.set(result, checkCleanup => {
        if (result._disposed) return Promise.resolve();
        if (!result._objectId || typeof cleanup.cancel !== "function") throw new Error("OBU_MEDIA_UNSUPPORTED: private media cancellation is unavailable");
        return cleanup.cancel(result._objectId, checkCleanup);
      });
      observeHandle(result);
      return result;
    };
    if (response.exceptionDetails) {
      const ids = new Set();
      for (const remote of [response.result, response.exceptionDetails.exception]) {
        if (remote?.objectId && !ids.has(remote.objectId)) { ids.add(remote.objectId); own(remote); }
      }
      throw new JavaScriptErrorInEvaluate(getExceptionMessage(response.exceptionDetails));
    }
    if (returnByValue) {
      if (response.result.objectId) { own(response.result); throw new Error("OBU_MEDIA_UNSUPPORTED: expected a by-value source result"); }
      return response.result.value;
    }
    return own(response.result);
    } finally {
      // Keep evidence through a delayed response and every object it allocated.
      // A failed object release retains this lease for an explicit retry.
      nativeSettled = true; closeIfReleased();
    }
  };
  return {
    setHandleObserver: callback => { if (observeHandle || typeof callback !== "function") throw new Error("Invalid media handle observer"); observeHandle = callback; },
    fileInputIdentity: handle => {
      if (!(handle instanceof JSHandle$1) || !releases.has(handle) || handle._disposed || !handle._objectId || !handle.asElement())
        throw new Error("OBU_FILE_INPUT_CHANGED: original input handle is unavailable");
      const context = handle._context, frame = context.frame;
      if (context.world !== "utility") throw new Error("OBU_FILE_INPUT_CHANGED: utility context required");
      const routeIdentity = route(context);
      const check = () => {
        routeIdentity.check();
        if (handle._disposed || frame.isDetached() || context._contextDestroyedScope.isClosed() || frame._contextData.get(context.world)?.context !== context)
          throw new Error("OBU_FILE_INPUT_CHANGED: original input context changed");
      };
      check();
      return { target: Object.freeze({ ...routeIdentity.target }), frameId: frame._id, check,
        describe: async () => {
          check();
          const result = await routeIdentity.transport._send(routeIdentity.target, "DOM.describeNode", { objectId: handle._objectId, depth: 0 });
          check();
          if (!Number.isSafeInteger(result.node?.backendNodeId) || result.node.backendNodeId < 1 || String(result.node.localName ?? result.node.nodeName).toLowerCase() !== "input")
            throw new Error("OBU_FILE_INPUT_CHANGED: native input identity is invalid");
          return result.node.backendNodeId;
        }
      };
    },
    getContentFrame: async handle => {
      const { target, transport, check } = route(handle._context);
      const session = handle._context.frame._page.delegate._sessionForHandle(handle);
      const client = { send: (method, params) => {
        if (method !== "DOM.describeNode") throw new Error("OBU_MEDIA_UNSUPPORTED: unexpected native frame query");
        check(); return transport._send(target, method, params);
      } };
      return session._getContentFrame.call({ _client: client, _page: session._page }, handle);
    },
    evaluate: (handle, fn, arg) => evaluate(handle, fn, arg, true),
    evaluateHandle: (handle, fn, arg) => evaluate(handle, fn, arg, false),
    cancel: async (handle, checkCleanup) => {
      const cancel = cancellations.get(handle);
      if (!cancel) throw new Error("OBU_MEDIA_CLEANUP_FAILED: binding is not owned by this source operation");
      await cancel(checkCleanup);
    },
    dispose: async (handle, checkCleanup) => {
      const release = releases.get(handle);
      if (!release) throw new Error("OBU_MEDIA_CLEANUP_FAILED: handle is not owned by this source operation");
      if (handle._disposed) return;
      await release(checkCleanup);
      handle._disposed = true;
      if (globalThis.leakedJSHandles) globalThis.leakedJSHandles.delete(handle);
    }
  };
}

export async function runOpenBrowserUseMediaTask(locator, options, task) {
  if (!(locator instanceof Locator) || typeof task !== "function" || !Number.isFinite(options?.timeoutMs) || options.timeoutMs <= 0 || options.timeoutMs > 120000)
    throw new Error("OBU_MEDIA_UNSUPPORTED: invalid private media task");
  const frame = locator._frame._toImpl();
  if (!frame?.selectors || typeof frame.retryWithProgressAndTimeouts !== "function")
    throw new Error("OBU_MEDIA_UNSUPPORTED: native Frame is unavailable");
  const controller = new ProgressController(serverSideCallMetadata(), frame);
  let actualTask;
  try {
    return await controller.run(progress => {
      actualTask = Promise.resolve().then(() => task(frame, locator._selector, progress, createOpenBrowserUseMediaOperations()));
      return actualTask;
    }, options.timeoutMs);
  } finally {
    // controller.run is a cancellation race. Wait for renderer calls, late
    // handles and their disposal even when that race already timed out.
    if (actualTask) await actualTask.catch(error => { if (error?.mediaCleanupFailed) throw error; });
  }
}
`;

export function patchCrxMediaSource(source) {
  for (const anchor of [
    "  async _getContentFrame(handle) {", "class CRExecutionContext {", "function createHandle$3(context, remoteObject) {", "class ProgressController {", "function serverSideCallMetadata() {", "class Locator {",
    "  async retryWithProgressAndTimeouts(progress2, timeouts, action) {",
    "  async resolveInjectedForSelector(selector, options2, scope) {",
    "clientConnection.toImpl = (x) => x ? dispatcherConnection._dispatcherByGuid.get(x._guid)._object : dispatcherConnection._dispatcherByGuid.get(\"\");"
  ]) if (source.split(anchor).length !== 2) throw new Error("Pinned Playwright media source shape changed; review the utility-world adapter");
  const query = '      const handle = await injectedScript.evaluateHandle((injected, { info: info2, scope: scope2, selectorString }) => {';
  const release = `      const element = handle.asElement();
      if (!element)
        return null;
      const maybeFrame = await frame._page.delegate.getContentFrame(element);
      element.dispose();
      if (!maybeFrame)
        return null;
      frame = maybeFrame;`;
  for (const anchor of [query, release]) if (source.split(anchor).length !== 2) throw new Error("Pinned Playwright media frame-handle shape changed");
  return source.replace(query, `      const evaluateOwner = options2.obuMedia ? (fn, arg) => options2.obuMedia.evaluateHandle(injectedScript, fn, arg) : (fn, arg) => injectedScript.evaluateHandle(fn, arg);
      const handle = await evaluateOwner((injected, { info: info2, scope: scope2, selectorString }) => {`)
    .replace(release, `      let maybeFrame;
      try {
        const element = handle.asElement();
        if (!element) return null;
        maybeFrame = options2.obuMedia ? await options2.obuMedia.getContentFrame(element) : await frame._page.delegate.getContentFrame(element);
      } finally {
        if (options2.obuMedia) await options2.obuMedia.dispose(handle);
        else handle.dispose();
      }
      if (!maybeFrame) return null;
      frame = maybeFrame;`) + mediaTaskBridge;
}
