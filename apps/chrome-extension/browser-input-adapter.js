// Production raw CDP and CRX share attachment-scoped input intent and native
// completion tracking. This is teardown state, not an input implementation or a
// global chrome.debugger proxy. The older CRX-only helpers below remain for
// standalone engines without the backend's shared inputHooks.
const states = new WeakMap();
const buttonBits = { left: 1, right: 2, middle: 4, back: 8, forward: 16 };

// One tracker is shared by the backend's raw CDP route and CRX. Tokens name a
// native attachment, not a tab's current session, so late completions cannot
// alter a replacement attachment. Track intent before sending: a rejected or
// timed-out native call is not proof that its input never reached the renderer.
export class NativeInputTracker {
  constructor({ beforeInput, assertInput, released, onDestroyed } = {}) {
    this.attachments = new Map();
    this.beforeInput = beforeInput;
    this.assertInput = assertInput;
    this.released = released;
    this.onDestroyed = onDestroyed;
    this.durability = new Map();
  }

  durable(tabId, record, operation) {
    let result;
    try { result = Promise.resolve(operation()); } catch (error) { result = Promise.reject(error); }
    const pending = result.catch(error => { record.error = error; throw error; })
      .finally(() => this.durability.delete(pending));
    this.durability.set(pending, { tabId, record });
    pending.catch(() => {});
    return pending;
  }

  confirmReleased(tabId, token, record) {
    if (!this.released || this.attachments.get(tabId) !== record || record.inflight.size || this.hasHeld(record) || record.error) return;
    // Invoke the journal mutation synchronously after checking the same token.
    // A later input must queue its own durable mark after this exact clear.
    return this.durable(tabId, record, () => this.released(tabId, token));
  }

  register(tabId, token) {
    if (!token) throw new Error("Native input tracking requires an attachment token");
    const previous = this.attachments.get(tabId);
    if (previous?.token === token) return;
    if (previous && (previous.inflight.size || this.hasHeld(previous) || previous.error)) throw new Error("OBU_INPUT_RELEASE_UNCONFIRMED: previous native input must be released or its tab closed");
    this.attachments.set(tabId, { token, states: new Map(), inflight: new Set(), blocked: false, release: null, error: null });
  }

  hasHeld(record) {
    return [...record.states.values()].some(state => state.buttons.size || state.keys.size || state.dragging || state.intercepting || state.touch || state.emulated);
  }

  current(tabId, token) {
    const record = this.attachments.get(tabId);
    if (!record || record.token !== token) throw new Error("OBU_INPUT_ATTACHMENT_CHANGED: native input attachment changed");
    return record;
  }

  assertSend(tabId, token) {
    const record = this.current(tabId, token);
    if (record.blocked) throw new Error("OBU_INPUT_RELEASE_IN_PROGRESS: native attachment is being released");
    return record;
  }

  native(record, operation, success = () => {}) {
    // This promise follows the native API itself, never an RPC timeout race.
    let sent;
    try { sent = Promise.resolve(operation()); } catch (error) { sent = Promise.reject(error); }
    const settled = sent.then(value => { success(); return value; }).finally(() => record.inflight.delete(settled));
    record.inflight.add(settled);
    settled.catch(() => {});
    return settled;
  }

  send(target, token, method, params = {}, operation) {
    if (!method.startsWith("Input.")) return operation();
    const record = this.assertSend(target.tabId, token);
    const session = target.sessionId ?? "";
    let state = record.states.get(session);
    if (!state) {
      state = { target: { tabId: target.tabId, ...(target.sessionId ? { sessionId: target.sessionId } : {}) }, buttons: new Map(), keys: new Map(), x: 0, y: 0 };
      record.states.set(session, state);
    }
    if (Number.isFinite(params.x) && Number.isFinite(params.y)) { state.x = params.x; state.y = params.y; }
    let complete = () => {};
    const confirmClear = (key, expected) => () => { if (state[key] === expected) state[key] = null; };
    if (method === "Input.dispatchMouseEvent" && Object.hasOwn(buttonBits, params.button)) {
      if (params.type === "mousePressed") state.buttons.set(params.button, {});
      if (params.type === "mouseReleased") {
        const press = state.buttons.get(params.button);
        complete = () => { if (state.buttons.get(params.button) === press) state.buttons.delete(params.button); };
      }
    } else if (method === "Input.dispatchKeyEvent") {
      const identity = params.code || params.key || String(params.windowsVirtualKeyCode ?? params.nativeVirtualKeyCode ?? "unknown");
      if (["keyDown", "rawKeyDown"].includes(params.type)) {
        const key = {};
        for (const name of ["code", "key", "windowsVirtualKeyCode", "nativeVirtualKeyCode", "location", "isKeypad"]) if (params[name] !== undefined) key[name] = params[name];
        state.keys.set(identity, key);
      } else if (params.type === "keyUp") {
        const key = state.keys.get(identity);
        complete = () => { if (state.keys.get(identity) === key) state.keys.delete(identity); };
      }
    } else if (method === "Input.dispatchDragEvent") {
      if (["drop", "dragCancel"].includes(params.type)) {
        const dragging = state.dragging, pressed = state.buttons.get("left");
        // A native dragCancel can retain pointer capture and the pressed mouse
        // button. Only drop ends that press; cancellation still needs mouseup.
        complete = () => { if (state.dragging === dragging) state.dragging = null; if (params.type === "drop" && state.buttons.get("left") === pressed) state.buttons.delete("left"); };
      } else state.dragging = {};
    } else if (method === "Input.setInterceptDrags") {
      if (params.enabled) state.intercepting = {};
      else complete = confirmClear("intercepting", state.intercepting);
    } else if (method === "Input.dispatchTouchEvent") {
      if (["touchEnd", "touchCancel"].includes(params.type)) complete = confirmClear("touch", state.touch);
      else state.touch = {};
    } else if (method === "Input.emulateTouchFromMouseEvent") {
      if (params.type === "mousePressed") state.emulated = { button: params.button ?? "left" };
      else if (params.type === "mouseReleased") complete = confirmClear("emulated", state.emulated);
    }
    const nativeOperation = this.beforeInput ? async () => {
      await this.durable(target.tabId, record, () => this.beforeInput(target.tabId, token));
      // Pause, tab movement or destruction may win while storage is pending.
      // The durability barrier cannot authorize a late native send.
      this.assertSend(target.tabId, token);
      this.assertInput?.(target.tabId, token);
      return operation();
    } : operation;
    const result = this.native(record, nativeOperation, () => {
      if (this.attachments.get(target.tabId) !== record) return;
      complete();
      if (record.states.get(session) === state && !this.hasHeld({ states: new Map([[session, state]]) })) record.states.delete(session);
    });
    return this.released ? result.then(async value => {
      await this.confirmReleased(target.tabId, token, record);
      return value;
    }) : result;
  }

  release(tabId, token, sendCommand = (target, method, params) => chrome.debugger.sendCommand(target, method, params), timeoutMs = 500) {
    const record = this.current(tabId, token);
    record.blocked = true;
    if (record.release) return record.release;
    const deadline = performance.now() + timeoutMs;
    const within = async operation => {
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new Error("OBU_INPUT_RELEASE_UNCONFIRMED: native input cleanup timed out");
      let timer;
      try { return await Promise.race([operation(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("OBU_INPUT_RELEASE_UNCONFIRMED: native input cleanup timed out")), remaining); })]); }
      finally { clearTimeout(timer); }
    };
    const pending = (async () => {
      // No new sends are admitted once blocked. A late down must settle before
      // its release, even when its caller already received an RPC timeout.
      await within(() => Promise.allSettled([...record.inflight,
        ...[...this.durability].filter(([, value]) => value.record === record).map(([pending]) => pending)]));
      for (const state of record.states.values()) {
        const send = (method, params, success = () => {}) => within(() => this.native(record, () => sendCommand(state.target, method, params), success));
        if (state.dragging || state.buttons.size) await send("Input.cancelDragging", {}, () => { state.dragging = null; });
        if (state.intercepting) await send("Input.setInterceptDrags", { enabled: false }, () => { state.intercepting = null; });
        if (state.touch) await send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] }, () => { state.touch = null; });
        if (state.emulated) await send("Input.emulateTouchFromMouseEvent", { type: "mouseReleased", x: state.x, y: state.y, button: state.emulated.button }, () => { state.emulated = null; });
        for (const [button, press] of state.buttons) {
          const buttons = [...state.buttons.keys()].filter(other => other !== button).reduce((mask, other) => mask | buttonBits[other], 0);
          await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: state.x, y: state.y, button, buttons, clickCount: 0 }, () => { if (state.buttons.get(button) === press) state.buttons.delete(button); });
        }
        for (const [identity, key] of state.keys) await send("Input.dispatchKeyEvent", { ...key, type: "keyUp", modifiers: 0 }, () => { if (state.keys.get(identity) === key) state.keys.delete(identity); });
      }
      record.states.clear();
      record.error = null;
      await within(() => this.confirmReleased(tabId, token, record));
    })().catch(error => { record.error = error; throw error; });
    record.release = pending;
    pending.finally(() => { if (record.release === pending) record.release = null; }).catch(() => {});
    return pending;
  }

  forget(tabId, token, { destroyed = false } = {}) {
    const record = this.attachments.get(tabId);
    if (!record || record.token !== token) return;
    if (!destroyed && (record.inflight.size || this.hasHeld(record) || record.error)) throw new Error("OBU_INPUT_RELEASE_UNCONFIRMED: release pending input, or close the original tab to recover");
    this.attachments.delete(tabId);
    if (destroyed && this.onDestroyed) {
      // Native target destruction is positive evidence even when its old send
      // has not returned. Keep the durable clear observable after forgetting.
      void this.durable(tabId, record, () => this.onDestroyed(tabId, token));
    }
  }

  controlSnapshot() {
    return { tabIds: [...new Set([...this.attachments.keys(), ...[...this.durability.values()].map(value => value.tabId)])],
      pending: [...new Set([...this.attachments.values()].flatMap(record => [...record.inflight, ...(record.release ? [record.release] : [])]).concat([...this.durability.keys()]))] };
  }
}

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
// reattach a cancelled page just to clean up. This compatibility helper observes
// only successful CRX sends; production uses NativeInputTracker through hooks,
// preserving the original native attachment and state on cleanup failure.
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
