import vm from "node:vm";

// Runs in the original utility world. A receipt proves delivery to the editing
// host during this action; it is not an authenticator for a CDP command. It does
// not compare the final value, which a legitimate input handler may transform.
export async function prepareFillReceipt(injected, node, { value, force }) {
  const inactive = result => ({ result, cancel: () => true });
  if (!force) {
    const result = await injected.checkElementStates(node, ["visible", "enabled", "editable"]);
    if (result) return inactive(result);
  }
  const element = injected.retarget(node, "follow-label");
  if (!element) return inactive("error:notconnected");
  const document = element.ownerDocument, view = document.defaultView;
  const result = injected.fill(node, value);
  // Preserve the pinned setters (date, colour, range, etc.), including their
  // existing synthetic input/change events. They never claim native delivery.
  if (result !== "needsinput") return inactive(result);
  const textControl = /^(input|textarea)$/i.test(element.nodeName);
  let host = element;
  if (!textControl) while (host.parentElement?.isContentEditable) host = host.parentElement;
  const current = () => node.isConnected && element.isConnected && host.isConnected &&
    node.ownerDocument === document && element.ownerDocument === document &&
    host.ownerDocument === document && injected.document === document &&
    injected.retarget(node, "follow-label") === element;
  const empty = () => textControl ? element.value === "" : element.childNodes.length === 0;
  const selected = () => {
    const active = host.getRootNode().activeElement;
    if (active !== host) return false;
    if (textControl) return true; // Number/email controls do not expose ranges.
    const selection = view.getSelection();
    if (!selection?.rangeCount) return false;
    const range = selection.getRangeAt(0);
    return element.contains(range.startContainer) && element.contains(range.endContainer);
  };
  if (!current()) return inactive("error:notconnected");
  const emptyBefore = value === "" && empty();
  const registry = Symbol.for("Open Browser Use fill receipt v1");
  let closed = false, armed = false, status = "missing", before, delivered = false;
  const expected = event => value === "" ? event.inputType === "deleteContentForward" :
    event.inputType === "insertText" || event.inputType === "insertReplacementText";
  const listener = event => {
    if (closed || !armed || !event.isTrusted) return;
    if (status === "invalid") return;
    // Earlier capture listeners may already have removed the original node.
    // The immutable dispatch path still identifies the original editing host;
    // connectivity/selection were checked when this receipt was armed.
    if (injected.document !== document || event.composedPath()[0] !== host || event.isComposing || !expected(event)) {
      status = "invalid"; return;
    }
    if (event.type === "beforeinput") {
      // A nested contenteditable locator selects only its own range, while the
      // browser targets input at the outer editing host. Bind that subrange at
      // beforeinput when Chromium exposes it, rather than accepting a sibling.
      if (host !== element) {
        const ranges = event.getTargetRanges?.();
        if (!ranges?.length || !Array.from(ranges).every(range =>
          element.contains(range.startContainer) && element.contains(range.endContainer))) {
          status = "invalid"; return;
        }
      }
      before = event;
    } else if (event.type === "input") {
      if (host !== element && !before) { status = "invalid"; return; }
      delivered = true; status = "ready";
    }
  };
  const receipt = {
    result,
    arm() {
      if (closed || armed || !current() || !selected()) return false;
      armed = true; return true;
    },
    read() {
      if (closed || !armed || injected.document !== document || before?.defaultPrevented || status === "invalid")
        return { status: "invalid" };
      // The original input handler may already have removed/replaced the node,
      // changed its value, or disabled it. Delivery remains an event-time fact.
      if (delivered) return { status: "ready" };
      // Delete on an already empty selection can legitimately produce no input
      // event. This narrow no-op is not a non-empty value-equality exception.
      // A browser may emit uncancelled beforeinput even when Delete has nothing
      // to edit. Its final cancellation state was checked above after native
      // settlement; no event or an explicitly uncancelled event is compatible.
      if (emptyBefore && current() && selected() && empty()) return { status: "noop" };
      return { status: "missing" };
    },
    cancel() {
      closed = true;
      view.removeEventListener("beforeinput", listener, true);
      view.removeEventListener("input", listener, true);
      if (view[registry] === receipt) delete view[registry];
      return true;
    }
  };
  view[registry]?.cancel();
  view[registry] = receipt;
  view.addEventListener("beforeinput", listener, true);
  view.addEventListener("input", listener, true);
  return receipt;
}

export const fillDeliveryBridge = `
function obuFillFailure(error) {
  if (error instanceof NonRecoverableDOMError && /^OBU_FILL_/.test(error.message)) return error;
  const result = new NonRecoverableDOMError("OBU_FILL_DELIVERY_UNCONFIRMED: " + (error?.message || String(error)));
  result.cause = error;
  return result;
}

async function obuRunFill(handle, progress, value, options) {
  // Preserve direct setter semantics, including pre-held-input compatibility.
  // This first callback is read-only for text controls; it never selects,
  // focuses or edits one before exclusive native admission is obtained.
  const preliminary = await handle._retryAction(progress, "fill", async () => {
    await handle.instrumentation.onBeforeInputAction(handle, progress.metadata);
    return handle.evaluateInUtility(async ([injected, node, args]) => {
      if (!args.force) {
        const state = await injected.checkElementStates(node, ["visible", "enabled", "editable"]);
        if (state) return state;
      }
      const element = injected.retarget(node, "follow-label");
      if (!element) return "error:notconnected";
      if (element.nodeName.toLowerCase() === "input" &&
          ["color", "date", "time", "datetime-local", "month", "range", "week"].includes(element.type.toLowerCase()))
        return injected.fill(node, args.value);
      return "obu:needs-native-fill";
    }, { value, force: !!options.force });
  }, options);
  progress.throwIfAborted();
  if (preliminary !== "obu:needs-native-fill") return preliminary;
  const context = handle._context, frame = handle._frame, keyboard = handle._page.keyboard;
  const client = context?.delegate?._client, transport = client?._connection?._transport;
  const root = /^crx-tab-(\\d+)$/.exec(client?._sessionId || "");
  const tabId = root ? Number(root[1]) : transport?._sessions?.get(client?._sessionId);
  const attachment = transport?._tabToTarget?.get(tabId);
  const contextCurrent = candidate => candidate && !candidate._contextDestroyedScope.isClosed() &&
    candidate.frame._contextData.get(candidate.world)?.context === candidate;
  let utility, ticket, cleanup, lease, committed = false, succeeded = false, actionError;
  const owned = new Set(), guards = new Set(), cancelled = new Set(), pending = new Set();
  const check = () => {
    progress.throwIfAborted();
    if (progress.timeUntilDeadline() <= 0) throw obuFillFailure("original fill deadline expired");
    const utilityClient = utility?.delegate?._client;
    const utilityRoot = /^crx-tab-(\\d+)$/.exec(utilityClient?._sessionId || "");
    if (!Number.isSafeInteger(tabId) || !attachment || transport._tabToTarget.get(tabId) !== attachment ||
        handle._disposed || handle._context !== context || !contextCurrent(context) ||
        utility && (!contextCurrent(utility) || (utilityRoot ? Number(utilityRoot[1]) !== tabId : transport._sessions.get(utilityClient?._sessionId) !== tabId)) ||
        !root && transport._sessions.get(client._sessionId) !== tabId)
      throw obuFillFailure("original fill context/attachment changed");
  };
  const track = async (operation, receive) => {
    const actual = (async () => { const result = await operation(); receive?.(result); return result; })();
    pending.add(actual);
    try { return await actual; } finally { pending.delete(actual); }
  };
  const call = async (method, params, receive) => {
    check(); ticket.check();
    const result = await track(() => transport._send(target, method, params), receive);
    check(); ticket.check(); return result;
  };
  const own = response => {
    for (const remote of [response.result, response.object, response.exceptionDetails?.exception])
      if (remote?.objectId) owned.add(remote.objectId);
  };
  const resultValue = response => {
    if (response.exceptionDetails) throw new JavaScriptErrorInEvaluate(getExceptionMessage(response.exceptionDetails));
    if (response.result?.objectId) throw obuFillFailure("unexpected fill receipt object");
    return response.result?.value;
  };
  let target;
  try {
    check();
    if (!(context.delegate instanceof CRExecutionContext)) throw obuFillFailure("Chromium fill context is unavailable");
    ticket = openBrowserUseInputHooks.beginFillAction({ tabId }, check);
    if (!ticket || typeof ticket.deferCleanup !== "function") throw obuFillFailure("native fill cleanup lease is unavailable");
    ticket.check();
    // Register before any allocating native call. Its real completion, including
    // a response arriving after Page cancellation, belongs to this exact lease.
    cleanup = ticket.deferCleanup(async checkCleanup => {
      while (pending.size) await Promise.allSettled([...pending]);
      checkCleanup();
      for (const id of guards) if (!cancelled.has(id)) {
        checkCleanup(); await lease.cancel(id, checkCleanup); cancelled.add(id); checkCleanup();
      }
      for (const id of owned) {
        checkCleanup(); await lease.release(id, checkCleanup); owned.delete(id); checkCleanup();
      }
      lease?.close(); return true;
    });
    utility = await frame._utilityContext(); check(); ticket.check();
    const utilityClient = utility.delegate?._client;
    const utilityRoot = /^crx-tab-(\\d+)$/.exec(utilityClient?._sessionId || "");
    if (!(utility.delegate instanceof CRExecutionContext) || utility.world !== "utility" ||
        utilityClient._connection?._transport !== transport ||
        (utilityRoot ? Number(utilityRoot[1]) !== tabId : transport._sessions.get(utilityClient._sessionId) !== tabId))
      throw obuFillFailure("original fill utility route is unavailable");
    target = { tabId, ...(utilityRoot ? {} : { sessionId: utilityClient._sessionId }) };
    lease = openBrowserUseInputHooks.prepareMediaCleanup(target, utility.delegate._contextId);
    const injected = await utility.injectedScript(); check(); ticket.check();
    let nodeId = handle._objectId;
    if (utility !== context) {
      // Retain native adoption rather than resolving the locator a second time.
      const described = await call("DOM.describeNode", { objectId: nodeId, depth: 0 });
      const resolved = await call("DOM.resolveNode", { backendNodeId: described.node.backendNodeId,
        executionContextId: utility.delegate._contextId }, own);
      nodeId = resolved.object?.objectId;
    }
    if (!nodeId || !injected._objectId) throw obuFillFailure("original fill handles are unavailable");
    const evaluate = async (id, expression) => resultValue(await call("Runtime.callFunctionOn", {
      objectId: id, functionDeclaration: expression, returnByValue: true, awaitPromise: true, userGesture: false
    }, own));
    const result = await handle._retryAction(progress, "fill", async () => {
      check(); ticket.check();
      if (committed) throw obuFillFailure("submitted fill cannot replay");
      await handle.instrumentation.onBeforeInputAction(handle, progress.metadata);
      check(); ticket.check();
      const response = await call("Runtime.callFunctionOn", {
        objectId: injected._objectId,
        functionDeclaration: "function(node, value, force) { return this.prepareOpenBrowserUseFill(node, value, force); }",
        arguments: [{ objectId: nodeId }, { value }, { value: !!options.force }],
        returnByValue: false, awaitPromise: true, userGesture: false
      }, response => { own(response); if (!response.exceptionDetails && response.result?.objectId) guards.add(response.result.objectId); });
      if (response.exceptionDetails) throw new JavaScriptErrorInEvaluate(getExceptionMessage(response.exceptionDetails));
      const receipt = response.result?.objectId;
      if (!receipt) throw obuFillFailure("original fill receipt is unavailable");
      const prepared = await evaluate(receipt, "function() { return this.result; }");
      if (prepared !== "needsinput") {
        await track(() => lease.cancel(receipt), () => cancelled.add(receipt));
        await track(() => lease.release(receipt), () => { owned.delete(receipt); guards.delete(receipt); });
        check(); ticket.check(); return prepared;
      }
      if (!await evaluate(receipt, "function() { return this.arm(); }"))
        throw obuFillFailure("original fill selection/focus changed before input");
      check(); ticket.check(); committed = true;
      if (value) await keyboard.insertText(value, ticket);
      else await keyboard.press("Delete", { [obuFillTicket]: ticket });
      check(); ticket.check();
      const delivery = await evaluate(receipt, "function() { return this.read(); }");
      if (delivery?.status !== "ready" && delivery?.status !== "noop")
        throw obuFillFailure("original editing host did not confirm trusted input");
      return "done";
    }, options);
    check(); ticket.check();
    await cleanup(); check(); ticket.check(); succeeded = true;
    return result;
  } catch (error) { actionError = obuFillFailure(error); throw actionError; }
  finally {
    // A failed committed input may still be held in the native tracker. Keep
    // its receipt until engine cleanup drains/releases that original input.
    try {
      if (!succeeded && !committed && cleanup) {
        try { await cleanup(); }
        catch (error) { if (actionError) actionError.fillCleanupError = error; else throw obuFillFailure(error); }
      }
    } finally { ticket?.close(); }
  }
}
const obuFillTicket = Symbol("Open Browser Use fill native ticket");
`;

function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw new Error("Pinned Playwright fill delivery shape changed");
  return source.replace(before, after);
}

// Applied after the existing pointer patch, which already carries optional
// private tickets through Keyboard.down/up and the native key implementation.
export function patchCrxFillDelivery(source) {
  const match = /^const source\$4 = (.*);$/m.exec(source);
  if (!match) throw new Error("Pinned Playwright fill injected source shape changed");
  let injected = vm.runInNewContext(match[1], {}, { timeout: 1000 });
  injected = replaceOnce(injected, "  fill(node, value) {", "  prepareOpenBrowserUseFill(node, value, force) {\n    return prepareFillReceipt(this, node, { value, force });\n  }\n  fill(node, value) {");
  source = source.replace(match[0], () => "const source$4 = " + JSON.stringify(prepareFillReceipt.toString() + "\n" + injected) + ";");
  source = replaceOnce(source, "  async _fill(progress2, value, options2) {\n    progress2.log(`  fill(\"${value}\")`);",
    "  async _fill(progress2, value, options2) {\n    if (openBrowserUseInputHooks?.beginFillAction) return obuRunFill(this, progress2, value, options2);\n    progress2.log(`  fill(\"${value}\")`);");
  source = replaceOnce(source, "  async insertText(text) {\n    await this._raw.sendText(text);\n  }",
    "  async insertText(text, obuTicket) {\n    await this._raw.sendText(text, obuTicket);\n  }");
  source = replaceOnce(source, '  async sendText(text) {\n    await this._client.send("Input.insertText", { text });\n  }',
    '  async sendText(text, obuTicket) {\n    await this._client.send("Input.insertText", tagPointerCommand({ text }, obuTicket));\n  }');
  const from = source.indexOf("  async press(key2, options2 = {}) {"), to = source.indexOf("  async ensureModifiers(mm, obuTicket) {", from);
  if (from < 0 || to < from) throw new Error("Pinned Playwright fill keyboard shape changed");
  let press = source.slice(from, to);
  for (const expression of ["this.down(tokens[i])", "this.down(key2)", "this.up(key2)", "this.up(tokens[i])"])
    press = replaceOnce(press, expression, expression.slice(0, -1) + ", options2[obuFillTicket])");
  return source.slice(0, from) + press + source.slice(to) + fillDeliveryBridge;
}
