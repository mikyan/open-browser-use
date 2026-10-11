import vm from "node:vm";

// This is an explicit pre-press actionability change to the pinned CRX build.
// A DOM receipt is evidence in an action window, not a CDP request authenticator.
export function createPointerMoveReceipt(injected, original, element, point, attempt) {
  const document = original.ownerDocument;
  const expectedPoint = point ? { x: point.x, y: point.y } : null;
  let closed = false, status = "missing", receivedPoint;
  const current = () => !closed && original.isConnected && element.isConnected &&
    original.ownerDocument === document && element.ownerDocument === document && injected.document === document;
  return {
    observe(event) {
      if (closed || event.type !== "pointermove" || !event.isTrusted ||
          event.pointerType !== "mouse" || event.isPrimary !== true) return;
      if (!current() || event.buttons !== 0 || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) {
        status = "invalid"; return;
      }
      if (status === "invalid") return;
      // PointerEvent preserves the routed local fractional coordinates. The
      // upstream framePoint is a layout approximation (including truncated
      // iframe borders), not an exact transform of the native routed point.
      // Use the original target and the event's local hit test as the receipt;
      // retain framePoint for geometry stability and its own final local hit.
      if (!event.composedPath().includes(element) ||
          injected.expectHitTarget({ x: event.clientX, y: event.clientY }, element) !== "done") {
        status = "invalid"; return;
      }
      receivedPoint = { x: event.clientX, y: event.clientY };
      status = "ready";
    },
    read(expectedAttempt, geometry) {
      const nextPoint = geometry ? geometry.point : expectedPoint;
      const samePoint = nextPoint === null && expectedPoint === null || nextPoint && expectedPoint &&
        nextPoint.x === expectedPoint.x && nextPoint.y === expectedPoint.y;
      // Recheck the received location and the planned local hit independently:
      // a hover overlay may cover one while leaving the other exposed.
      const hit = status !== "ready" || injected.expectHitTarget(receivedPoint, element) === "done" &&
        (!nextPoint || injected.expectHitTarget(nextPoint, element) === "done");
      return { attempt, status: expectedAttempt === attempt && current() && samePoint && hit ? status : "invalid" };
    },
    close() { closed = true; }
  };
}

export const pointerDeliveryBridge = `
const obuPointerTicket = Symbol("Open Browser Use pointer native ticket");
const obuPointerDelivery = Symbol("Open Browser Use pointer delivery action");

function obuPointerFailure(error) {
  if (error instanceof NonRecoverableDOMError && /^OBU_POINTER_/.test(error.message)) return error;
  const result = new NonRecoverableDOMError("OBU_POINTER_DELIVERY_UNCONFIRMED: " + (error?.message || String(error)));
  result.cause = error;
  return result;
}

async function obuRunPointerClick(handle, progress, options, actionName = "click") {
  const mouse = handle._page.mouse, context = handle._context;
  const keyboard = handle._page.keyboard, clickCount = options.clickCount ?? 1;
  if (!Number.isInteger(clickCount) || clickCount < 1)
    throw obuPointerFailure("click count must be a positive integer");
  const client = mouse._raw?._client, transport = client?._connection?._transport;
  const root = /^crx-tab-(\\d+)$/.exec(client?._sessionId || "");
  const tabId = root ? Number(root[1]) : transport?._sessions?.get(client?._sessionId);
  const nativeIdentity = transport?._tabToTarget?.get(tabId);
  const contextClient = context?.delegate?._client;
  const contextSession = contextClient?._sessionId;
  const contextRoot = /^crx-tab-(\\d+)$/.exec(contextSession || "");
  if (!Number.isSafeInteger(tabId) || !nativeIdentity || !(context?.delegate instanceof CRExecutionContext) ||
      contextClient?._connection?._transport !== transport ||
      (contextRoot ? Number(contextRoot[1]) !== tabId : transport._sessions.get(contextSession) !== tabId))
    throw obuPointerFailure("original Chromium pointer route is unavailable");
  let buttonsFinished = false, completedClicks = 0, originalReceiptContext;
  const contextIsCurrent = value => value && !value._contextDestroyedScope.isClosed() &&
    value.frame._contextData.get(value.world)?.context === value;
  const check = () => {
    progress.throwIfAborted();
    if (progress.timeUntilDeadline() <= 0) throw obuPointerFailure("original action deadline expired");
    if (transport._tabToTarget.get(tabId) !== nativeIdentity || !buttonsFinished &&
        (handle._disposed || handle._context !== context || !contextIsCurrent(context) ||
         originalReceiptContext && !contextIsCurrent(originalReceiptContext) ||
         !contextRoot && transport._sessions.get(contextSession) !== tabId))
      throw obuPointerFailure("original pointer node/context/attachment changed");
    // Do not send the next counted click after an already observed navigation.
    // This reads existing Frame state; it cannot predict future CDP messages.
    if (!buttonsFinished && completedClicks) {
      for (let frame = handle._frame; frame; frame = frame.parentFrame())
        if (frame.pendingDocument()) throw obuPointerFailure("navigation interrupted the counted click");
    }
  };
  let ticket, committed = false, moved = false, attempt = 0, currentReceipt, attemptFrameGeometry;
  const sameFrameGeometry = value => Array.isArray(value) && value.length > 0 && JSON.stringify(value) === attemptFrameGeometry;
  const closeReceipt = async () => {
    const receipt = currentReceipt;
    currentReceipt = undefined;
    if (!receipt) return;
    try { await receipt.evaluate(h => h.stop()); }
    finally { receipt.dispose(); }
  };
  const state = {
    nextAttempt() { check(); return ++attempt; },
    setFrameGeometry(value) {
      check();
      if (!Array.isArray(value) || !value.length) throw obuPointerFailure("original frame geometry is unavailable");
      attemptFrameGeometry = JSON.stringify(value);
    },
    retain(receipt) {
      currentReceipt = receipt;
      if (originalReceiptContext && originalReceiptContext !== receipt._context)
        throw obuPointerFailure("original utility context changed");
      originalReceiptContext = receipt._context;
      check();
    },
    async runAttempt(point, receipt, action) {
      // Snapshot before ensureModifiers: a partial native key failure may throw
      // before upstream returns its restore array. A retry restores this exact
      // attempt's baseline before it can arm another receipt.
      const baseline = options.modifiers ? Array.from(keyboard._modifiers()) : undefined;
      let failure;
      try {
        check(); ticket.check();
        if (baseline) await keyboard.ensureModifiers(options.modifiers, ticket);
        check(); ticket.check();
        if (!await state.prepare(point, receipt)) return false;
        await action(point);
        return true;
      } catch (error) {
        failure = error;
        throw error;
      } finally {
        if (baseline) {
          try {
            check(); ticket.check();
            await keyboard.ensureModifiers(baseline, ticket);
            check(); ticket.check();
          } catch (error) {
            // No unguarded or out-of-deadline key recovery. The engine releases
            // unknown held input through the native tracker on this terminal
            // error; retain the action error if restoration also fails.
            if (!failure) throw error;
            try { failure.pointerModifierRestoreError = error; } catch {}
          }
        }
      }
    },
    async prepare(point, receipt) {
      if (!receipt?._objectId) throw obuPointerFailure("original hit interceptor is unavailable");
      check(); ticket.check();
      moved = true;
      await mouse.move(point.x, point.y, { forClick: true, [obuPointerTicket]: ticket });
      check(); ticket.check();
      const result = await receipt.evaluate((h, id) => h.readMoveReceipt(id), attempt);
      check(); ticket.check();
      if (result?.attempt !== attempt) throw obuPointerFailure("stale pointer receipt");
      if (result.status !== "ready") {
        await closeReceipt();
        check(); ticket.check();
        return false;
      }
      const states = await handle.evaluateInUtility(async ([injected, node]) =>
        injected.checkElementStates(node, ["visible", "enabled", "stable"]));
      check(); ticket.check();
      if (states === "error:notconnected") throw obuPointerFailure("original node disconnected after move");
      if (states) { await closeReceipt(); check(); ticket.check(); return false; }
      // Hover handlers can change the ancestor chain after the receipt. Keep
      // root routing and the original parent-frame hit tests before pressing.
      const frameCheck = await handle._checkFrameIsHitTarget(point, progress);
      check(); ticket.check();
      if (frameCheck === "error:notconnected") throw obuPointerFailure("original frame disconnected after move");
      if ("hitTargetDescription" in frameCheck || !sameFrameGeometry(frameCheck.frameGeometry)) {
        await closeReceipt(); check(); ticket.check(); return false;
      }
      const finalReceipt = await receipt.evaluate((h, value) => h.readMoveReceipt(value.id, { point: value.point }),
        { id: attempt, point: frameCheck.framePoint ?? null });
      check(); ticket.check();
      if (finalReceipt?.attempt !== attempt || finalReceipt.status !== "ready") {
        await closeReceipt(); check(); ticket.check(); return false;
      }
      return true;
    },
    checkedResult(result) {
      if (committed && result !== "done") throw obuPointerFailure(typeof result === "string" ? result : JSON.stringify(result));
      return result;
    },
    forget(receipt) { if (currentReceipt === receipt) currentReceipt = undefined; }
  };
  try {
    check();
    ticket = openBrowserUseInputHooks.beginPointerAction({ tabId }, check);
    ticket.check();
    const delay = async () => {
      if (options.delay) {
        await new Promise(resolve => setTimeout(resolve, Math.min(options.delay, Math.max(0, progress.timeUntilDeadline()))));
        check(); ticket.check();
      }
    };
    const result = await handle._retryPointerAction(progress, actionName, true, async (point) => {
      for (let count = 1; count <= clickCount; count++) {
        check(); ticket.check();
        if (completedClicks) {
          // A first click may move or cover the original frame while its local
          // node and receipt remain valid. Recheck the same root point and pass
          // its current frame geometry to the original receipt; never move,
          // locate a successor or retry an already committed button sequence.
          const frameCheck = await handle._checkFrameIsHitTarget(point, progress);
          check(); ticket.check();
          if (frameCheck === "error:notconnected" || "hitTargetDescription" in frameCheck || !sameFrameGeometry(frameCheck.frameGeometry))
            throw obuPointerFailure("original frame changed between counted clicks");
          const receipt = await currentReceipt.evaluate((h, value) => h.readMoveReceipt(value.id, { point: value.point }),
            { id: attempt, point: frameCheck.framePoint ?? null });
          check(); ticket.check();
          if (receipt?.attempt !== attempt || receipt.status !== "ready")
            throw obuPointerFailure("original target changed between counted clicks");
        }
        committed = true; // Never reset: even a rejected down may have arrived.
        await mouse.down({ ...options, clickCount: count, [obuPointerTicket]: ticket });
        check(); ticket.check();
        await delay();
        await mouse.up({ ...options, clickCount: count, [obuPointerTicket]: ticket });
        completedClicks = count;
        buttonsFinished = count === clickCount;
        if (!buttonsFinished) { check(); ticket.check(); await delay(); }
      }
    }, { ...options, [obuPointerDelivery]: state });
    check(); ticket.check();
    if (moved && result !== "done") throw obuPointerFailure("original pointer target was lost");
    return result;
  } catch (error) {
    throw obuPointerFailure(error);
  } finally {
    // This is the original utility handle, never a replacement document. Native
    // context destruction retains upstream post-click navigation semantics.
    try { await closeReceipt(); } catch {}
    ticket?.close();
  }
}
`;

function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw new Error("Pinned Playwright pointer delivery shape changed; review the pre-press adapter");
  return source.replace(before, after);
}

export function patchCrxPointerDelivery(source) {
  const injectedMatch = /^const source\$4 = (.*);$/m.exec(source);
  if (!injectedMatch) throw new Error("Pinned Playwright pointer injected source shape changed");
  let injected = vm.runInNewContext(injectedMatch[1], {}, { timeout: 1000 });
  injected = replaceOnce(injected,
    "this._allHitTargetInterceptorEvents = /* @__PURE__ */ new Set([...this._hoverHitTargetInterceptorEvents, ...this._tapHitTargetInterceptorEvents, ...this._mouseHitTargetInterceptorEvents]);",
    "this._allHitTargetInterceptorEvents = /* @__PURE__ */ new Set([...this._hoverHitTargetInterceptorEvents, ...this._tapHitTargetInterceptorEvents, ...this._mouseHitTargetInterceptorEvents, \"pointermove\"]);");
  injected = replaceOnce(injected, "  setupHitTargetInterceptor(node, action, hitPoint, blockAllEvents) {",
    "  setupHitTargetInterceptor(node, action, hitPoint, blockAllEvents, obuMoveAttempt) {");
  injected = replaceOnce(injected, "    let result;\n    const listener = (event) => {\n      if (!events.has(event.type))",
    "    const obuMove = obuMoveAttempt === undefined ? undefined : createPointerMoveReceipt(this, node, element, hitPoint, obuMoveAttempt);\n    let result;\n    const listener = (event) => {\n      if (obuMove && event.type === \"pointermove\") { obuMove.observe(event); return; }\n      if (!events.has(event.type))");
  injected = replaceOnce(injected, "    const stop = () => {\n      if (this._hitTargetInterceptor === listener)",
    "    const stop = () => {\n      obuMove?.close();\n      if (this._hitTargetInterceptor === listener)");
  injected = replaceOnce(injected, "    this._hitTargetInterceptor = listener;\n    return { stop };",
    "    this._hitTargetInterceptor = listener;\n    return { stop, readMoveReceipt: (id, geometry) => obuMove?.read(id, geometry) }; ");
  injected = createPointerMoveReceipt.toString() + "\n" + injected;
  source = source.replace(injectedMatch[0], () => "const source$4 = " + JSON.stringify(injected) + ";");
  source = replaceOnce(source,
    '  _click(progress2, options2) {\n    return this._retryPointerAction(progress2, "click", true, (point) => this._page.mouse.click(point.x, point.y, options2), options2);\n  }',
    '  _click(progress2, options2) {\n    if (openBrowserUseInputHooks?.beginPointerAction && !options2.force && !options2.trial && this._page.keyboard._modifiers().size === 0)\n      return obuRunPointerClick(this, progress2, options2);\n    return this._retryPointerAction(progress2, "click", true, (point) => this._page.mouse.click(point.x, point.y, options2), options2);\n  }');
  source = replaceOnce(source,
    '  _dblclick(progress2, options2) {\n    return this._retryPointerAction(progress2, "dblclick", true, (point) => this._page.mouse.dblclick(point.x, point.y, options2), { ...options2, waitAfter: "disabled" });\n  }',
    '  _dblclick(progress2, options2) {\n    if (openBrowserUseInputHooks?.beginPointerAction && !options2.force && !options2.trial && this._page.keyboard._modifiers().size === 0)\n      return obuRunPointerClick(this, progress2, { ...options2, clickCount: 2, waitAfter: "disabled" }, "dblclick");\n    return this._retryPointerAction(progress2, "dblclick", true, (point) => this._page.mouse.dblclick(point.x, point.y, options2), { ...options2, waitAfter: "disabled" });\n  }');
  source = replaceOnce(source, '    const { force = false, position } = options2;',
    '    const { force = false, position } = options2;\n    const obuDelivery = options2[obuPointerDelivery];\n    const obuMoveAttempt = obuDelivery?.nextAttempt();');
  source = replaceOnce(source, '      const hitPoint = frameCheckResult.framePoint;',
    '      const hitPoint = frameCheckResult.framePoint;\n      obuDelivery?.setFrameGeometry(frameCheckResult.frameGeometry);');
  source = replaceOnce(source,
    'const handle = await this.evaluateHandleInUtility(([injected, node2, { actionType: actionType2, hitPoint: hitPoint2, trial }]) => injected.setupHitTargetInterceptor(node2, actionType2, hitPoint2, trial), { actionType, hitPoint, trial: !!options2.trial });',
    'const handle = await this.evaluateHandleInUtility(([injected, node2, { actionType: actionType2, hitPoint: hitPoint2, trial, obuMoveAttempt: attempt }]) => injected.setupHitTargetInterceptor(node2, actionType2, hitPoint2, trial, attempt), { actionType, hitPoint, trial: !!options2.trial, obuMoveAttempt });');
  source = replaceOnce(source, '      hitTargetInterceptionHandle = handle;',
    '      hitTargetInterceptionHandle = handle;\n      obuDelivery?.retain(handle);');
  const modifiersAndAction = '      let restoreModifiers;\n      if (options2 && options2.modifiers)\n        restoreModifiers = await this._page.keyboard.ensureModifiers(options2.modifiers);\n      progress2.log(\x60  performing ${actionName} action\x60);\n      await action(point);\n      if (restoreModifiers)\n        await this._page.keyboard.ensureModifiers(restoreModifiers);';
  source = replaceOnce(source, modifiersAndAction,
    '      if (obuDelivery) {\n        progress2.log(\x60  performing ${actionName} action\x60);\n        if (!await obuDelivery.runAttempt(point, hitTargetInterceptionHandle, action))\n          return { hitTargetDescription: "original target has not received a matching pre-press move" };\n      } else {\n' + modifiersAndAction + '\n      }');
  source = replaceOnce(source, '          hitTargetInterceptionHandle == null ? void 0 : hitTargetInterceptionHandle.dispose();',
    '          obuDelivery?.forget(hitTargetInterceptionHandle);\n          hitTargetInterceptionHandle == null ? void 0 : hitTargetInterceptionHandle.dispose();');
  source = replaceOnce(source, '        if (options2.waitAfter !== false) {\n          const hitTargetResult = await stopHitTargetInterception;\n          if (hitTargetResult !== "done")\n            return hitTargetResult;',
    '        if (obuDelivery || options2.waitAfter !== false) {\n          const hitTargetResult = await stopHitTargetInterception;\n          if (hitTargetResult !== "done")\n            return obuDelivery ? obuDelivery.checkedResult(hitTargetResult) : hitTargetResult;');
  // Private symbol arguments are explicit and absent on every old Mouse caller.
  source = replaceOnce(source,
    'await this._raw.move(middleX, middleY, this._lastButton, this._buttons, this._keyboard._modifiers(), !!options2.forClick);',
    'await this._raw.move(middleX, middleY, this._lastButton, this._buttons, this._keyboard._modifiers(), !!options2.forClick, options2[obuPointerTicket]);');
  source = replaceOnce(source,
    'await this._raw.down(this._x, this._y, this._lastButton, this._buttons, this._keyboard._modifiers(), clickCount);',
    'await this._raw.down(this._x, this._y, this._lastButton, this._buttons, this._keyboard._modifiers(), clickCount, options2[obuPointerTicket]);');
  source = replaceOnce(source,
    'await this._raw.up(this._x, this._y, button, this._buttons, this._keyboard._modifiers(), clickCount);',
    'await this._raw.up(this._x, this._y, button, this._buttons, this._keyboard._modifiers(), clickCount, options2[obuPointerTicket]);');
  // Modifier changes belong to this exact action, including per-attempt
  // restoration. Optional private parameters leave every old Keyboard caller
  // unchanged; no mutable ticket is stored on the shared keyboard object.
  const keyboardStart = source.indexOf("let Keyboard$1 = class Keyboard {"), keyboardEnd = source.indexOf("let Mouse$1 = class Mouse {", keyboardStart);
  if (keyboardStart < 0 || keyboardEnd < 0) throw new Error("Pinned Playwright keyboard shape changed");
  let keyboard = source.slice(keyboardStart, keyboardEnd);
  for (const [before, after] of [
    ["async down(key2)", "async down(key2, obuTicket)"],
    ["async up(key2)", "async up(key2, obuTicket)"],
    ["async ensureModifiers(mm)", "async ensureModifiers(mm, obuTicket)"],
    ["this._raw.keydown(this._pressedModifiers, key2, description, autoRepeat)", "this._raw.keydown(this._pressedModifiers, key2, description, autoRepeat, obuTicket)"],
    ["this._raw.keyup(this._pressedModifiers, key2, description)", "this._raw.keyup(this._pressedModifiers, key2, description, obuTicket)"],
    ["if (needDown && !isDown)\n        await this.down(key2);", "if (needDown && !isDown)\n        await this.down(key2, obuTicket);"],
    ["else if (!needDown && isDown)\n        await this.up(key2);", "else if (!needDown && isDown)\n        await this.up(key2, obuTicket);"]
  ]) keyboard = replaceOnce(keyboard, before, after);
  source = source.slice(0, keyboardStart) + keyboard + source.slice(keyboardEnd);
  const rawKeyboardStart = source.indexOf("let RawKeyboardImpl$3 = class RawKeyboardImpl {"), rawKeyboardEnd = source.indexOf("let RawMouseImpl$3 = class RawMouseImpl {", rawKeyboardStart);
  if (rawKeyboardStart < 0 || rawKeyboardEnd < 0) throw new Error("Pinned Playwright native keyboard shape changed");
  let rawKeyboard = source.slice(rawKeyboardStart, rawKeyboardEnd);
  for (const [signature, field] of [
    ["async keydown(modifiers, keyName, description, autoRepeat)", "isKeypad: location2 === keypadLocation"],
    ["async keyup(modifiers, keyName, description)", "location: location2"]
  ]) {
    const from = rawKeyboard.indexOf(signature), next = rawKeyboard.indexOf("\n  async ", from + signature.length);
    if (from < 0 || next < 0) throw new Error("Pinned Playwright native keyboard method changed");
    let method = rawKeyboard.slice(from, next);
    method = replaceOnce(method, signature, signature.slice(0, -1) + ", obuTicket)");
    method = replaceOnce(method, 'this._client.send("Input.dispatchKeyEvent", {', 'this._client.send("Input.dispatchKeyEvent", tagPointerCommand({');
    method = replaceOnce(method, field + "\n    });", field + "\n    }, obuTicket));");
    rawKeyboard = rawKeyboard.slice(0, from) + method + rawKeyboard.slice(next);
  }
  source = source.slice(0, rawKeyboardStart) + rawKeyboard + source.slice(rawKeyboardEnd);
  const rawStart = source.indexOf("let RawMouseImpl$3 = class RawMouseImpl {"), rawEnd = source.indexOf("let RawTouchscreenImpl$3 =", rawStart);
  if (rawStart < 0 || rawEnd < 0) throw new Error("Pinned Playwright native mouse shape changed");
  let raw = source.slice(rawStart, rawEnd);
  for (const [signature, field] of [
    ["async move(x, y, button, buttons, modifiers, forClick)", "force: buttons.size > 0 ? 0.5 : 0"],
    ["async down(x, y, button, buttons, modifiers, clickCount)", "force: buttons.size > 0 ? 0.5 : 0"],
    ["async up(x, y, button, buttons, modifiers, clickCount)", "clickCount"]
  ]) {
    const from = raw.indexOf(signature), next = raw.indexOf("\n  async ", from + signature.length);
    if (from < 0) throw new Error("Pinned Playwright native mouse method changed");
    const end = next < 0 ? raw.length : next;
    let method = raw.slice(from, end);
    method = method.replace(signature, signature.slice(0, -1) + ", obuTicket)");
    method = replaceOnce(method, 'this._client.send("Input.dispatchMouseEvent", {', 'this._client.send("Input.dispatchMouseEvent", tagPointerCommand({');
    const indentation = signature.includes("move(") ? "      " : "    ";
    method = replaceOnce(method, field + "\n" + indentation + "});", field + "\n" + indentation + "}, obuTicket));");
    raw = raw.slice(0, from) + method + raw.slice(end);
  }
  return source.slice(0, rawStart) + raw + source.slice(rawEnd) + pointerDeliveryBridge;
}
