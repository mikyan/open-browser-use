import { createHash } from "node:crypto";

// Serialized as a fixed utility-world function by the existing native cleanup
// lease. No page selector or replacement node is resolved inside this guard.
export function createDragCommitGuard(node, { point }) {
  const document = node.ownerDocument, view = document.defaultView;
  const registry = Symbol.for("Open Browser Use drag commit guard v1");
  let closed = false, status = "armed";
  const parent = (element) => element.parentElement || element.getRootNode()?.host || null;
  const chain = [];
  for (let current = node; current; current = parent(current)) chain.push(current);
  // A stable AABB does not imply a stable padding plane: individual rotate
  // is separate from transform, and a border can move the padding origin
  // without changing a border-box's outer rectangle. Record resolved inputs
  // to that plane without treating paint-only colour changes as geometry.
  const planeProperties = ["transform", "transformOrigin", "transformBox", "translate", "rotate", "scale", "zoom",
    "perspective", "perspectiveOrigin", "transformStyle", "backfaceVisibility",
    "offsetPath", "offsetDistance", "offsetRotate", "offsetAnchor", "offsetPosition",
    "boxSizing", "width", "height", "borderLeftWidth", "borderTopWidth", "borderRightWidth", "borderBottomWidth",
    "paddingLeft", "paddingTop", "paddingRight", "paddingBottom", "writingMode", "direction"];
  const geometry = () => ({
    viewport: [view.scrollX, view.scrollY, view.innerWidth, view.innerHeight,
      view.visualViewport?.offsetLeft, view.visualViewport?.offsetTop, view.visualViewport?.width,
      view.visualViewport?.height, view.visualViewport?.scale],
    elements: chain.map((element) => {
      const style = view.getComputedStyle(element);
      return [Array.from(element.getClientRects(), (r) => [r.x, r.y, r.width, r.height]),
        planeProperties.map(property => style[property]),
        [element.scrollLeft, element.scrollTop, element.clientLeft, element.clientTop, element.clientWidth, element.clientHeight]];
    })
  });
  const initialGeometry = JSON.stringify(geometry());
  const hit = (p) => {
    for (let target = node; target;) {
      const root = target.getRootNode(), actual = root.elementFromPoint(p.x, p.y);
      if (!actual || actual !== target && !target.contains(actual)) return false;
      target = root.host || null;
    }
    return true;
  };
  const current = () => !closed && node.isConnected && node.ownerDocument === document &&
    chain.every((element, i) => element.isConnected && parent(element) === (chain[i + 1] ?? null)) &&
    JSON.stringify(geometry()) === initialGeometry && hit(point);
  const listener = (event) => {
    if (!event.isTrusted) return;
    if (status !== "blocked" && current() && event.composedPath().includes(node) &&
        Number.isFinite(event.clientX) && Number.isFinite(event.clientY) && hit({ x: event.clientX, y: event.clientY })) {
      status = "accepted";
      return;
    }
    status = "blocked";
    event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation();
  };
  const guard = {
    read: () => ({ status, current: current() }),
    cancel() {
      closed = true; view.removeEventListener("drop", listener, true);
      if (view[registry] === guard) delete view[registry];
      return true;
    }
  };
  // This factory is only called after a newly admitted ticket's source press.
  // Startup input recovery and admission must settle older native input first.
  // An isolated-world successor can then retire a guard whose host was lost;
  // no deadline timer pretends that an outstanding native drop was cancelled.
  view[registry]?.cancel();
  view[registry] = guard;
  view.addEventListener("drop", listener, true);
  return guard;
}

export const dragDeliveryBridge = `
const obuDragProgress = Symbol("Open Browser Use drag progress");

async function obuAwaitDragIntercept(promise, progress, ticket) {
  if (!progress) return promise;
  progress.throwIfAborted(); ticket.check();
  const remaining = progress.timeUntilDeadline();
  if (remaining <= 0) throw obuPointerFailure("original drag deadline expired");
  let timer, active = true;
  const aborted = new Promise((_, reject) => {
    const stop = () => { if (active) reject(obuPointerFailure("original drag action aborted")); };
    timer = setTimeout(stop, remaining);
    progress.cleanupWhenAborted(stop);
  });
  try { return await Promise.race([promise, aborted]); }
  finally { active = false; clearTimeout(timer); }
}

async function obuRunPointerDrag(source, target, progress, options) {
  const page = source._page, mouse = page.mouse;
  const client = mouse._raw?._client, transport = client?._connection?._transport;
  const root = /^crx-tab-(\\d+)$/.exec(client?._sessionId || "");
  const tabId = root ? Number(root[1]) : transport?._sessions?.get(client?._sessionId);
  const attachment = transport?._tabToTarget?.get(tabId);
  const handles = [source, target], contexts = handles.map(h => h._context), frames = new Map();
  let committed = false, finished = false, ticket, cleanup, receipt, actionError, attempt = 0;
  const owned = new Set(), guards = new Set(), cancelled = new Set(), pending = new Set();
  const native = createOpenBrowserUseMediaOperations();
  native.setHandleObserver(handle => owned.add(handle));
  for (const handle of handles) for (let frame = handle._frame; frame; frame = frame.parentFrame()) {
    if (!frames.has(frame)) frames.set(frame, { parent: frame.parentFrame(), session: page.delegate._sessionForFrame(frame),
      context: frame._contextData.get("utility")?.context });
  }
  const contextCurrent = context => context && !context._contextDestroyedScope.isClosed() &&
    context.frame._contextData.get(context.world)?.context === context;
  const check = () => {
    progress.throwIfAborted();
    if (progress.timeUntilDeadline() <= 0) throw obuPointerFailure("original drag deadline expired");
    if (!Number.isSafeInteger(tabId) || !attachment || transport._tabToTarget.get(tabId) !== attachment)
      throw obuPointerFailure("original drag attachment changed");
    if (finished) return;
    for (let i = 0; i < handles.length; i++) {
      const handle = handles[i], context = contexts[i], contextClient = context?.delegate?._client;
      const contextRoot = /^crx-tab-(\\d+)$/.exec(contextClient?._sessionId || "");
      if (handle._page !== page || handle._disposed || handle._context !== context || !contextCurrent(context) ||
          !(context.delegate instanceof CRExecutionContext) || contextClient._connection?._transport !== transport ||
          (contextRoot ? Number(contextRoot[1]) !== tabId : transport._sessions.get(contextClient._sessionId) !== tabId))
        throw obuPointerFailure("original drag node/context/route changed");
    }
    for (const [frame, pinned] of frames) {
      if (frame.parentFrame() !== pinned.parent || page.frameManager.frame(frame._id) !== frame || frame.pendingDocument() ||
          page.delegate._sessionForFrame(frame) !== pinned.session || pinned.context && !contextCurrent(pinned.context))
        throw obuPointerFailure("original drag ancestor changed");
    }
  };
  const closeReceipt = async () => {
    const value = receipt; receipt = undefined;
    if (value) { try { await value.evaluate(h => h.stop()); } finally { value.dispose(); } }
  };
  const snapshot = async (handle, point, position, install) => {
    check(); ticket.check();
    const value = await obuFrameGeometry.drag(handle, point, progress, position, install);
    check(); ticket.check();
    if (value === "error:notconnected") throw obuPointerFailure("original drag node disconnected");
    return value;
  };
  const trackNative = async (operation, received) => {
    check(); ticket.check();
    // By-value reads can also return exception RemoteObjects. Keep their real
    // native lifetime in the same barrier as guard allocations and ownership.
    const task = (async () => { const result = await operation(); received?.(result); return result; })();
    pending.add(task);
    try { return await task; }
    finally { pending.delete(task); }
  };
  const install = async (element, point) => {
    await trackNative(() => native.evaluateHandle(element, createDragCommitGuard, { point }), guard => guards.add(guard));
    check(); ticket.check();
  };
  const valid = value => value && typeof value === "object" && Array.isArray(value.frameGeometry) && value.frameGeometry.length > 0 && !value.hitTargetDescription;
  const nativeOptions = { [obuPointerTicket]: undefined, [obuDragProgress]: progress };
  const sourceState = {
    nextAttempt() { check(); if (committed) throw obuPointerFailure("a committed drag cannot retry"); return ++attempt; },
    setFrameGeometry() {},
    retain(value) { receipt = value; check(); },
    forget(value) { if (receipt === value) receipt = undefined; },
    checkedResult(value) { if (committed && value !== "done") throw obuPointerFailure("drag press was intercepted"); return value; },
    async runAttempt(point, original, action) {
      const before = await snapshot(source, point, options.sourcePosition);
      if (!valid(before)) { await closeReceipt(); return false; }
      await mouse.move(point.x, point.y, { ...nativeOptions, forClick: true });
      check(); ticket.check();
      const move = await original.evaluate((h, id) => h.readMoveReceipt(id), attempt);
      check(); ticket.check();
      if (move?.attempt !== attempt) throw obuPointerFailure("stale drag source receipt");
      if (move.status !== "ready") { await closeReceipt(); return false; }
      const states = await source.evaluateInUtility(([injected, node]) => injected.checkElementStates(node, ["visible", "stable"]));
      check(); ticket.check();
      if (states === "error:notconnected") throw obuPointerFailure("original drag source disappeared");
      const after = await snapshot(source, point, options.sourcePosition);
      if (states || !valid(after) || JSON.stringify(before.frameGeometry) !== JSON.stringify(after.frameGeometry)) { await closeReceipt(); return false; }
      const final = await original.evaluate((h, value) => h.readMoveReceipt(value.id, { point: value.point }), { id: attempt, point: after.framePoint });
      check(); ticket.check();
      if (final?.attempt !== attempt || final.status !== "ready") { await closeReceipt(); return false; }
      // A source hover may replace the pre-resolved destination without yet
      // destroying its execution context. Check the original node explicitly.
      const targetCurrent = await target.evaluateInUtility(([injected, node]) => node.isConnected && node.ownerDocument === injected.document);
      check(); ticket.check();
      if (!targetCurrent) throw obuPointerFailure("original drag destination disappeared before press");
      await action(point); return true;
    }
  };
  const targetState = {
    nextAttempt() { check(); return ++attempt; }, setFrameGeometry() {}, retain() {}, forget() {},
    checkedResult(value) { if (value !== "done") throw obuPointerFailure("drag destination was intercepted"); return value; },
    async runAttempt(point, ignored, action) {
      const before = await snapshot(target, point, options.targetPosition, install);
      if (!valid(before)) throw obuPointerFailure("original drag destination is covered");
      await mouse.move(point.x, point.y, nativeOptions);
      check(); ticket.check();
      // The first intercepted HTML move emits dragEnter only. Give dragover
      // handlers their native event before the last geometry check as well.
      if (mouse._raw._dragManager.isDragging()) await mouse.move(point.x, point.y, nativeOptions);
      check(); ticket.check();
      const after = await snapshot(target, point, options.targetPosition);
      if (!valid(after) || JSON.stringify(before.frameGeometry) !== JSON.stringify(after.frameGeometry))
        throw obuPointerFailure("original drag destination changed after move");
      for (const guard of guards) {
        const state = await trackNative(() => native.evaluate(guard, value => value.read()));
        check(); ticket.check();
        if (!state.current || state.status === "blocked") throw obuPointerFailure("original drop document changed");
      }
      await action(point);
      return true;
    }
  };
  try {
    check();
    ticket = openBrowserUseInputHooks.beginPointerAction({ tabId }, check);
    if (typeof ticket.deferCleanup !== "function") throw obuPointerFailure("native drag cleanup lease is unavailable");
    // Register before the first guard allocation or native input. A public
    // timeout can start release before an allocating Runtime response arrives.
    cleanup = ticket.deferCleanup(async checkCleanup => {
      while (pending.size) await Promise.allSettled([...pending]);
      checkCleanup();
      for (const guard of guards) if (!guard._disposed && !cancelled.has(guard)) {
        checkCleanup(); await native.cancel(guard, checkCleanup); cancelled.add(guard); checkCleanup();
      }
      for (const handle of owned) if (!handle._disposed) { checkCleanup(); await native.dispose(handle, checkCleanup); checkCleanup(); }
      return true;
    });
    nativeOptions[obuPointerTicket] = ticket;
    const pressed = await source._retryPointerAction(progress, "move and down", false, async () => {
      check(); ticket.check(); committed = true;
      await mouse.down(nativeOptions);
      check(); ticket.check();
    }, { ...options, waitAfter: "disabled", position: options.sourcePosition, [obuPointerDelivery]: sourceState });
    if (pressed !== "done") throw obuPointerFailure("original drag source was lost");
    const released = await target._performPointerAction(progress, "move and up", false, async () => {
      check(); ticket.check();
      await mouse.up(nativeOptions);
      finished = true; // Only after the actual drop/up response, not the RPC race.
      for (const guard of guards) {
        try { const state = await trackNative(() => native.evaluate(guard, value => value.read()));
          if (state.status === "blocked") throw obuPointerFailure("native drop was blocked after dragover");
        } catch (error) {
          if (!guard._context._contextDestroyedScope.isClosed()) throw error;
        }
      }
    }, undefined, { ...options, waitAfter: "disabled", position: options.targetPosition, [obuPointerDelivery]: targetState });
    if (released !== "done") throw obuPointerFailure("original drag destination was lost");
    await cleanup();
    return "done";
  } catch (error) { actionError = obuPointerFailure(error); throw actionError; }
  finally {
    try { await closeReceipt(); } catch {}
    // An uncertain committed native command keeps all drop fences until the
    // original tracker drains it, cancels the drag and releases held input.
    try {
      if (!committed && cleanup) {
        try { await cleanup(); }
        catch (error) { if (actionError) actionError.cleanupError = error; else throw obuPointerFailure(error); }
      }
    } finally { ticket?.close(); }
  }
}
`;

function replaceOnce(source, before, after, label) {
  if (source.split(before).length !== 2) throw new Error(`Pinned drag delivery shape changed: ${label}`);
  return source.replace(before, after);
}

function pinnedPart(source, start, end, expected, label) {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  if (from < 0 || to <= from) throw new Error(`Pinned drag delivery shape changed: ${label}`);
  const value = source.slice(from, to);
  if (createHash("sha256").update(value).digest("hex") !== expected) throw new Error(`Pinned drag delivery shape changed: ${label}`);
  return value;
}

export function patchCrxDragDelivery(source) {
  const frame = pinnedPart(source, "  async dragAndDrop(metadata, source2, target, options2) {", "  async tap(metadata, selector, options2) {",
    "d2bc7c18bd3d48bd47996f579988ab18ef5f57fe98b0bb87244f38952d9ab237", "Frame.dragAndDrop");
  const guardedFrame = frame.replace("    const controller = new ProgressController(metadata, this);", `    if (openBrowserUseInputHooks?.beginPointerAction && !options2.force && !options2.trial && this._page.keyboard._modifiers().size === 0 && this._page.mouse._buttons.size === 0) {
      const controller = new ProgressController(metadata, this);
      await controller.run(progress => this._retryWithProgressIfNotConnected(progress, source2, options2.strict, true, sourceHandle =>
        this._retryWithProgressIfNotConnected(progress, target, options2.strict, true, targetHandle =>
          obuRunPointerDrag(sourceHandle, targetHandle, progress, options2))), options2.timeout);
      return;
    }
    const controller = new ProgressController(metadata, this);`);
  source = replaceOnce(source, frame, guardedFrame, "guarded original handles");
  source = replaceOnce(source, "!!options2.forClick, options2[obuPointerTicket]);", "!!options2.forClick, options2[obuPointerTicket], options2[obuDragProgress]);", "Mouse drag progress");
  source = replaceOnce(source, "async move(x, y, button, buttons, modifiers, forClick, obuTicket)", "async move(x, y, button, buttons, modifiers, forClick, obuTicket, obuProgress)", "RawMouse progress");
  source = replaceOnce(source, "this._dragManager.interceptDragCausedByMove(x, y, button, buttons, modifiers, actualMove);", "this._dragManager.interceptDragCausedByMove(x, y, button, buttons, modifiers, actualMove, obuTicket, obuProgress);", "RawMouse interception ticket");
  source = replaceOnce(source, "await this._dragManager.drop(x, y, modifiers);", "await this._dragManager.drop(x, y, modifiers, obuTicket);", "RawMouse drop ticket");
  const originalDrag = pinnedPart(source, "class DragManager {", "class CRExecutionContext {",
    "8acbed33bae0d54c88adbaa22d141c9bf06d5ed263f1d5b41728b4796ae1f8e7", "DragManager");
  let drag = originalDrag;
  for (const [before, after] of [
    ["async cancelDrag()", "async cancelDrag(obuTicket)"],
    ["async interceptDragCausedByMove(x, y, button, buttons, modifiers, moveCallback)", "async interceptDragCausedByMove(x, y, button, buttons, modifiers, moveCallback, obuTicket, obuProgress)"],
    ["async drop(x, y, modifiers)", "async drop(x, y, modifiers, obuTicket)"],
    ['await client.send("Input.setInterceptDrags", { enabled: true });', 'await client.send("Input.setInterceptDrags", tagPointerCommand({ enabled: true }, obuTicket));'],
    ['await client.send("Input.setInterceptDrags", { enabled: false });', 'await client.send("Input.setInterceptDrags", tagPointerCommand({ enabled: false }, obuTicket));'],
    ['    } catch {\n      client.off("Input.dragIntercepted", onDragIntercepted);', '    } catch (error) {\n      client.off("Input.dragIntercepted", onDragIntercepted);\n      if (obuTicket) throw error;'],
    ["    await moveCallback();\n    const expectingDrag", "    try {\n    obuTicket?.check();\n    await moveCallback();\n    obuTicket?.check();\n    const expectingDrag"],
    ["this._dragState = expectingDrag ? (await dragInterceptedPromise).data : null;", "obuTicket?.check();\n    this._dragState = expectingDrag ? (await obuAwaitDragIntercept(dragInterceptedPromise, obuProgress, obuTicket)).data : null;"],
    ['    client.off("Input.dragIntercepted", onDragIntercepted);\n    await client.send', '    obuTicket?.check();\n    await client.send']
  ]) drag = replaceOnce(drag, before, after, "native drag interception");
  // Tag every native drag event, including the compatibility cancel path.
  drag = drag.replaceAll('.send("Input.dispatchDragEvent", {', '.send("Input.dispatchDragEvent", tagPointerCommand({');
  drag = replaceOnce(drag, '        dragOperationsMask: 65535\n      }\n    });', '        dragOperationsMask: 65535\n      }\n    }, obuTicket));', "cancel ticket");
  if (drag.split("modifiers: toModifiersMask$2(modifiers)\n      });").length !== 3) throw new Error("Pinned drag event bodies changed");
  drag = drag.replaceAll("modifiers: toModifiersMask$2(modifiers)\n      });", "modifiers: toModifiersMask$2(modifiers)\n      }, obuTicket));");
  drag = replaceOnce(drag, "modifiers: toModifiersMask$2(modifiers)\n    });", "modifiers: toModifiersMask$2(modifiers)\n    }, obuTicket));", "drop ticket");
  drag = replaceOnce(drag, "    }\n  }\n  isDragging()", '    }\n    } finally { client.off("Input.dragIntercepted", onDragIntercepted); }\n  }\n  isDragging()', "interception listener cleanup");
  source = replaceOnce(source, originalDrag, drag, "tagged DragManager");
  return source + "\n" + createDragCommitGuard.toString() + "\n" + dragDeliveryBridge;
}
