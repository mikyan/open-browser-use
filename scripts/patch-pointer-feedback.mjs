import { createRawPointerFeedbackRuntime } from "./raw-pointer-feedback.mjs";

// Applied after the existing frame, pointer and drag adapters. Private tags
// survive transport parameter copies but never become native CDP fields.
export const pointerFeedbackBridge = `
const obuRawPointerFeedback = (${createRawPointerFeedbackRuntime.toString()})(obuFrameGeometry);
function obuCaptureRawPointerTarget(page, x, y) {
  if (!openBrowserUseInputHooks?.capturePointerFeedback) return undefined;
  try {
    const read = obuRawPointerFeedback(page, x, y, openBrowserUseInputHooks);
    return read && openBrowserUseInputHooks.capturePointerFeedback(read);
  } catch { return undefined; }
}
function createOpenBrowserUseRawPointerRead(page, x, y) {
  return obuRawPointerFeedback(page._toImpl(), x, y, openBrowserUseInputHooks);
}
function obuCapturePointerTarget(handle, progress, state, cached) {
  if (!openBrowserUseInputHooks?.capturePointerFeedback) return undefined;
  const client = handle._page.delegate._sessionForHandle(handle)._client;
  const connection = client._connection, transport = connection?._transport;
  const sessionId = client._sessionId, root = /^crx-tab-(\\d+)$/.exec(sessionId || "");
  const tabId = root ? Number(root[1]) : transport?._sessions?.get(sessionId);
  const attachment = transport?._tabToTarget?.get(tabId), map = state.sessionMaps.get(handle._page.delegate._sessionForHandle(handle));
  if (!attachment || !map || typeof transport?._send !== "function") return undefined;
  const rows = state.rows.map(row => ({ ...row, document: row.frame._currentDocument }));
  const check = () => {
    if (client._closed || connection._closed || transport._tabToTarget.get(tabId) !== attachment ||
        !root && transport._sessions.get(sessionId) !== tabId) throw new Error("Original feedback route changed");
    for (const row of rows) if (row.frame.parentFrame() !== row.parent ||
      handle._page.frameManager.frame(row.frame._id) !== row.frame || row.frame._currentDocument !== row.document ||
      row.frame.pendingDocument() || handle._page.delegate._sessionForFrame(row.frame) !== row.session ||
      row.context._contextDestroyedScope.isClosed() || row.frame._contextData.get(row.context.world)?.context !== row.context)
      throw new Error("Original feedback document changed");
  };
  const target = root ? { tabId } : { tabId, sessionId };
  return openBrowserUseInputHooks.capturePointerFeedback({ target, check,
    read: checkScope => {
      const beforeSend = () => { state.check(); check(); checkScope(); };
      beforeSend();
      return transport._send(target, "DOM.getBoxModel", { objectId: handle._objectId }, beforeSend);
    }, cached,
    decode: result => {
      const raw = result?.model?.border;
      if (!Array.isArray(raw) || raw.length !== 8 || !raw.every(Number.isFinite)) return null;
      const points = Array.from({length:4}, (_,i) => ({x:raw[i*2],y:raw[i*2+1]}));
      if (points.some(p => !(map[6]*p.x + map[7]*p.y + map[8] > 0))) return null;
      const projected = points.map(p => obuFrameGeometry.project(map,p));
      const x = Math.min(...projected.map(p=>p.x)), y = Math.min(...projected.map(p=>p.y));
      return { x, y, width:Math.max(...projected.map(p=>p.x))-x, height:Math.max(...projected.map(p=>p.y))-y };
    }
  });
}
`;

function replace(source, before, after, count = 1) {
  if (source.split(before).length !== count + 1) throw new Error("Pinned pointer feedback shape changed: " + before.slice(0,100));
  return source.replaceAll(before, after);
}
export function patchCrxPointerFeedback(source) {
  if (!source.includes("targetForPoint: point => feedbackTargets.get(point)") || source.includes("function obuCapturePointerTarget("))
    throw new Error("Pinned pointer feedback requires the original frame geometry adapter exactly once");
  source = replace(source, "const point = roundPoint(maybePoint);", "const point = roundPoint(maybePoint);\n    const obuVisualTarget = obuFrameGeometry.targetForPoint(maybePoint);");
  source = replace(source, "obuDelivery.runAttempt(point, hitTargetInterceptionHandle, action)", "obuDelivery.runAttempt(point, hitTargetInterceptionHandle, action, obuVisualTarget)");
  // Only the original _performPointerAction's legacy invocation is changed.
  source = replace(source, "      await action(point);\n      if (restoreModifiers)", "      await action(point, obuVisualTarget);\n      if (restoreModifiers)");
  // All existing locator pointer routes, including force/preheld compatibility.
  source = replace(source, "(point) => this._page.mouse.move(point.x, point.y)", "(point, visual) => this._page.mouse.move(point.x, point.y, { [pointerFeedbackTarget]: visual })");
  for (const name of ["click", "dblclick"]) source = replace(source,
    "(point) => this._page.mouse." + name + "(point.x, point.y, options2)",
    "(point, visual) => this._page.mouse." + name + "(point.x, point.y, { ...options2, [pointerFeedbackTarget]: visual })");
  source = replace(source, "point => mouse.move(point.x, point.y),", "(point, visual) => mouse.move(point.x, point.y, { [pointerFeedbackTarget]: visual }),");
  source = replace(source, "point => mouse.move(point.x, point.y, { forClick: true, [obuPointerTicket]: ticket })", "(point, visual) => mouse.move(point.x, point.y, { forClick: true, [obuPointerTicket]: ticket, [pointerFeedbackTarget]: visual })");
  source = replace(source, "async runAttempt(point, receipt, action) {", "async runAttempt(point, receipt, action, visual) {", 2);
  source = replace(source, "await action(point); // The original native move", "await action(point, visual); // The original native move");
  source = replace(source, "state.prepare(point, receipt)", "state.prepare(point, receipt, visual)");
  source = replace(source, "        await action(point);\n        return true;", "        await action(point, visual);\n        return true;");
  source = replace(source, "async prepare(point, receipt) {", "async prepare(point, receipt, visual) {");
  source = replace(source, "{ forClick: true, [obuPointerTicket]: ticket });", "{ forClick: true, [obuPointerTicket]: ticket, [pointerFeedbackTarget]: visual });");
  source = replace(source, "actionName, true, async (point) => {", "actionName, true, async (point, visual) => {");
  source = replace(source, "{ ...options, clickCount: count, [obuPointerTicket]: ticket }", "{ ...options, clickCount: count, [obuPointerTicket]: ticket, [pointerFeedbackTarget]: visual }", 2);
  for (const name of ["original", "ignored"]) source = replace(source,
    "async runAttempt(point, " + name + ", action) {", "async runAttempt(point, " + name + ", action, visual) {\n      nativeOptions[pointerFeedbackTarget] = visual;");
  for (const kind of ["down", "up"]) source = replace(source,
    '"move and ' + kind + '", false, async (point) => {\n          await this._page.mouse.move(point.x, point.y);\n          await this._page.mouse.' + kind + '();',
    '"move and ' + kind + '", false, async (point, visual) => {\n          await this._page.mouse.move(point.x, point.y, { [pointerFeedbackTarget]: visual });\n          await this._page.mouse.' + kind + '({ [pointerFeedbackTarget]: visual });');
  // Mouse.click's own pre-move preserves the private option as do down/up.
  const mouseStart = source.indexOf("let Mouse$1 ="), mouseEnd = source.indexOf("let Touchscreen$1 =", mouseStart);
  if (mouseStart < 0 || mouseEnd < mouseStart) throw new Error("Pinned Mouse class shape changed");
  let mouse = source.slice(mouseStart, mouseEnd);
  mouse = replace(mouse, "  async click(x, y, options2 = {}, metadata) {", `  async click(x, y, options2 = {}, metadata) {
    if (options2[pointerFeedbackTarget] === undefined) {
      const visual = obuCaptureRawPointerTarget(this._page, x, y);
      if (visual !== undefined) options2 = { ...options2, [pointerFeedbackTarget]: visual };
    }`);
  source = source.slice(0, mouseStart) + mouse + source.slice(mouseEnd);
  source = replace(source, "this.move(x, y, { forClick: true })", "this.move(x, y, { forClick: true, [pointerFeedbackTarget]: options2[pointerFeedbackTarget] })", 2);
  source = replace(source, "options2[obuPointerTicket], options2[obuDragProgress]);", "options2[obuPointerTicket], options2[obuDragProgress], options2[pointerFeedbackTarget]);");
  source = replace(source, "clickCount, options2[obuPointerTicket]);", "clickCount, options2[obuPointerTicket], options2[pointerFeedbackTarget]);", 2);
  source = replace(source, "async move(x, y, button, buttons, modifiers, forClick, obuTicket, obuProgress)", "async move(x, y, button, buttons, modifiers, forClick, obuTicket, obuProgress, obuVisual)");
  for (const name of ["down", "up"]) source = replace(source, "async " + name + "(x, y, button, buttons, modifiers, clickCount, obuTicket)", "async " + name + "(x, y, button, buttons, modifiers, clickCount, obuTicket, obuVisual)");
  const rawStart = source.indexOf("let RawMouseImpl$3 ="), rawEnd = source.indexOf("let RawTouchscreenImpl$3 =",rawStart);
  let raw = source.slice(rawStart,rawEnd);
  for (const name of ["move", "down", "up"]) {
    const signature = name === "move" ? "async move(x, y, button, buttons, modifiers, forClick, obuTicket, obuProgress, obuVisual) {" :
      "async " + name + "(x, y, button, buttons, modifiers, clickCount, obuTicket, obuVisual) {";
    raw = replace(raw, signature, signature + "\n    if (obuVisual === undefined) obuVisual = obuCaptureRawPointerTarget(this._page._page, x, y);");
  }
  raw = replace(raw, 'tagPointerCommand({', 'tagPointerFeedback(tagPointerCommand({', 3);
  raw = replace(raw, '}, obuTicket));', '}, obuTicket), obuVisual));', 3);
  raw = replace(raw, "actualMove, obuTicket, obuProgress)", "actualMove, obuTicket, obuProgress, obuVisual)");
  raw = replace(raw, "this._dragManager.drop(x, y, modifiers, obuTicket)", "this._dragManager.drop(x, y, modifiers, obuTicket, obuVisual)");
  raw = replace(raw, "async wheel(x, y, buttons, modifiers, deltaX, deltaY) {", "async wheel(x, y, buttons, modifiers, deltaX, deltaY) {\n    const obuVisual = obuCaptureRawPointerTarget(this._page._page, x, y);");
  raw = replace(raw, 'this._client.send("Input.dispatchMouseEvent", {', 'this._client.send("Input.dispatchMouseEvent", tagPointerFeedback({');
  raw = replace(raw, "      deltaY\n    });", "      deltaY\n    }, obuVisual));");
  source = source.slice(0,rawStart) + raw + source.slice(rawEnd);
  source = replace(source, "async interceptDragCausedByMove(x, y, button, buttons, modifiers, moveCallback, obuTicket, obuProgress)", "async interceptDragCausedByMove(x, y, button, buttons, modifiers, moveCallback, obuTicket, obuProgress, obuVisual)");
  source = replace(source, "async drop(x, y, modifiers, obuTicket)", "async drop(x, y, modifiers, obuTicket, obuVisual)");
  const start = source.indexOf("class DragManager {"), end = source.indexOf("class CRExecutionContext {",start);
  let drag = source.slice(start,end);
  // Cancel remains cleanup-only, with no visual target or feedback.
  const cancelEnd = drag.indexOf("async interceptDragCausedByMove");
  let normalDrag = drag.slice(cancelEnd);
  normalDrag = replace(normalDrag, '.send("Input.dispatchDragEvent", tagPointerCommand({', '.send("Input.dispatchDragEvent", tagPointerFeedback(tagPointerCommand({', 3);
  normalDrag = normalDrag.replaceAll("}, obuTicket));", "}, obuTicket), obuVisual));");
  // Intercept enable/disable also use tagPointerCommand; undo those two tags.
  normalDrag = normalDrag.replaceAll("{ enabled: true }, obuTicket), obuVisual));", "{ enabled: true }, obuTicket));")
    .replaceAll("{ enabled: false }, obuTicket), obuVisual));", "{ enabled: false }, obuTicket));");
  source = source.slice(0,start) + drag.slice(0,cancelEnd) + normalDrag + source.slice(end);
  source = replace(source, "{ ...message.params }, diagnosticReleaseGuard(message.params), pointerCommandGuard(message.params)",
    "tagPointerFeedback({ ...message.params }, pointerCommandTarget(message.params)), diagnosticReleaseGuard(message.params), pointerCommandGuard(message.params)");
  source = replace(source, "    const result = await (openBrowserUseInputHooks ?", `    let obuPublishFeedback;
    const obuPrepareFeedback = typeof openBrowserUseInputHooks?.capturePointerFeedback === "function";
    if (obuPrepareFeedback && (method === "Input.dispatchMouseEvent" || method === "Input.dispatchDragEvent")) {
      try {
        const prepared = openBrowserUseCommandObserver?.({ phase: "prepare", target: debuggee, method, commandParams, feedbackTarget: pointerCommandTarget(commandParams) });
        if (typeof prepared === "function") obuPublishFeedback = prepared;
        else Promise.resolve(prepared).catch(() => {});
      } catch {}
    }
    const result = await (openBrowserUseInputHooks ?`);
  source = replace(source, `    if (method === "Input.dispatchMouseEvent") {
      try { Promise.resolve(openBrowserUseCommandObserver?.({ target: debuggee, method, commandParams })).catch(() => {}); } catch {}
    }`, `    if (obuPrepareFeedback) {
      try { Promise.resolve(obuPublishFeedback?.()).catch(() => {}); } catch {}
    } else if (method === "Input.dispatchMouseEvent") {
      // Standalone observers retain the original successful-ACK notification.
      try { Promise.resolve(openBrowserUseCommandObserver?.({ target: debuggee, method, commandParams })).catch(() => {}); } catch {}
    }`);
  return 'import { pointerFeedbackTarget, tagPointerFeedback, pointerCommandTarget } from "../../../browser-pointer-feedback.js";\n' + source + "\n" + pointerFeedbackBridge + "\nexport { createOpenBrowserUseRawPointerRead };\n";
}
