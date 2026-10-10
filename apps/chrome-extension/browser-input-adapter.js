// Only observe this CRX transport's successful native input. This is teardown
// state, not an input implementation or a global chrome.debugger proxy.
const states = new WeakMap();
const buttonBits = { left: 1, right: 2, middle: 4, back: 8, forward: 16 };

export function observeCrxInputCommand(transport, target, method, params) {
  if (!target?.tabId || target.sessionId || !transport._tabToTarget.has(target.tabId)) return;
  if (!["Input.dispatchMouseEvent", "Input.dispatchDragEvent", "Input.dispatchKeyEvent", "Input.setInterceptDrags"].includes(method)) return;
  let tabs = states.get(transport);
  if (!tabs) states.set(transport, tabs = new Map());
  let state = tabs.get(target.tabId);
  if (!state) tabs.set(target.tabId, state = { buttons: new Set(), keys: new Map(), x: 0, y: 0, dragging: false, intercepting: false });
  if (Number.isFinite(params.x) && Number.isFinite(params.y)) { state.x = params.x; state.y = params.y; }
  if (method === "Input.dispatchMouseEvent" && Object.hasOwn(buttonBits, params.button)) {
    if (params.type === "mousePressed") state.buttons.add(params.button);
    if (params.type === "mouseReleased") state.buttons.delete(params.button);
  }
  if (method === "Input.dispatchDragEvent") {
    state.dragging = !["drop", "dragCancel"].includes(params.type);
    if (!state.dragging) state.buttons.delete("left");
  }
  if (method === "Input.setInterceptDrags") state.intercepting = params.enabled === true;
  if (method === "Input.dispatchKeyEvent" && params.code) {
    if (params.type === "keyUp") state.keys.delete(params.code);
    else if (["keyDown", "rawKeyDown"].includes(params.type)) state.keys.set(params.code, {
      code: params.code, key: params.key, windowsVirtualKeyCode: params.windowsVirtualKeyCode,
      nativeVirtualKeyCode: params.nativeVirtualKeyCode, location: params.location, isKeypad: params.isKeypad
    });
  }
  if (!state.buttons.size && !state.keys.size && !state.dragging && !state.intercepting) tabs.delete(target.tabId);
}

// Called after CRX emits Target.detachedFromTarget (closing Playwright's Page
// and cancelling its waits), while the same debugger is still attached. Never
// reattach a cancelled page just to clean up. The transport detaches in finally.
// Release at the last known position to preserve native pointerup/capture
// semantics. Its page effects (including a possible click) cannot be rolled back.
export async function releaseCrxInput(transport, tabId, sendCommand = (target, method, params) => chrome.debugger.sendCommand(target, method, params), timeoutMs = 500) {
  const tabs = states.get(transport), state = tabs?.get(tabId);
  tabs?.delete(tabId);
  if (!state) return;
  const deadline = performance.now() + timeoutMs;
  const send = async (method, params = {}) => {
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new Error("Native input cleanup timed out");
    let timer;
    try {
      await Promise.race([
        sendCommand({ tabId }, method, params),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Native input cleanup timed out")), remaining); })
      ]);
    } finally { clearTimeout(timer); }
  };
  if (state.dragging || state.buttons.size) await send("Input.cancelDragging");
  if (state.intercepting) await send("Input.setInterceptDrags", { enabled: false });
  for (const button of state.buttons) {
    state.buttons.delete(button);
    const buttons = [...state.buttons].reduce((mask, value) => mask | buttonBits[value], 0);
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: state.x, y: state.y, button, buttons, clickCount: 0 });
  }
  for (const key of state.keys.values()) await send("Input.dispatchKeyEvent", { ...key, type: "keyUp", modifiers: 0 });
}
