import assert from "node:assert/strict";
import test from "node:test";
import { ManagedHumanControl } from "./managed-human-control.js";

const defer = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function fixture(options = {}) {
  const calls = [], frames = [], states = [], listeners = new Set(), risks = new Set();
  let paused = false, authorized = true, documentId = "original-document", loaderId = "loader-1", clock = 100;
  const emit = (source = { targetId: "original-target" }, metadata = options.metadata ?? { deviceWidth: 800, deviceHeight: 600, pageScaleFactor: 1, offsetTop: 0 }) => {
    for (const listener of [...listeners]) listener(source, "Page.screencastFrame", { data: "cGl4ZWxz", metadata: options.nativeMetadata ?? { monotonicTimestamp: clock + 1, ...metadata }, sessionId: 42 });
  };
  const chrome = { debugger: {
    onEvent: { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) },
    async attach(target) { calls.push(["attach", target]); await options.attach?.(); },
    async detach(target) { calls.push(["detach", target]); await options.detach?.(); },
    async sendCommand(target, method, params) {
      calls.push([method, target, params]);
      const result = await options.command?.(method, params);
      if (method === "Page.startScreencast" && options.frames !== false) queueMicrotask(emit);
      if (result !== undefined) return result;
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "root", loaderId, url: "https://fixture.test/" + documentId } } };
      if (method === "Performance.getMetrics") return { metrics: [{ name: "Timestamp", value: clock }] };
      return method === "Page.getLayoutMetrics" ? { cssVisualViewport: { clientWidth: 800, clientHeight: 600, scale: 1, zoom: 1, offsetX: 0, offsetY: 0 } } : {};
    }
  } };
  const control = new ManagedHumanControl({ chrome,
    capture: async (tabId, captureOptions) => { calls.push(["capture"]); await options.capture?.(tabId, captureOptions); return { tabId, targetId: "original-target", documentId, title: `Title ${documentId}`, url: `https://fixture.test/${documentId}` }; },
    validate: async (candidate, { advance = false } = {}) => { if (!advance) assert.equal(candidate.documentId, documentId); await options.validate?.(candidate, { advance }); return { ...candidate, documentId, title: `Title ${documentId}`, url: `https://fixture.test/${documentId}` }; },
    pause: async reservation => { calls.push(["pause", reservation.leaseId]); await options.pause?.(reservation); paused = true; },
    assertPaused: () => { assert.equal(paused, true); },
    markRisk: async id => { risks.add(id); await options.markRisk?.(); }, clearRisk: async id => { await options.clearRisk?.(); risks.delete(id); },
    onFailure: error => calls.push(["failure", error.message])
  });
  const authority = () => { if (!authorized) throw new Error("lease expired"); };
  const begin = (request = {}) => control.begin(7, authority, frame => frames.push(frame), state => states.push(state), request);
  const beginView = (request = {}) => control.beginView(7, authority, frame => frames.push(frame), state => states.push(state), request);
  return { control, chrome, calls, frames, states, risks, emit, listeners, begin, beginView,
    changeDocument: (id = "next-document") => { documentId = id; loaderId = "loader-" + id; clock += 10; },
    event: (method, params = {}, source = { targetId: "original-target" }) => { for (const listener of [...listeners]) listener(source, method, params); },
    expire: () => { authorized = false; } };
}
const input = (handle, value, extra = {}) => {
  const info = handle.info();
  return handle.input({ leaseId: info.leaseId, generation: info.generation, sequence: info.lastInputSequence + 1, input: value, ...extra });
};

test("human attachment starts only after the original Pause and uses only the frozen target", async () => {
  const pause = defer(), f = fixture({ pause: () => pause.promise });
  const pending = f.begin();
  assert.throws(() => f.control.assertReleased(), /releasing human control/);
  await tick(); assert.equal(f.calls.some(([method]) => method === "attach"), false);
  pause.resolve(); const handle = await pending;
  assert.equal(handle.info().state, "active"); assert.equal(handle.info().generation, 1);
  assert.equal(f.frames.length, 1); assert.equal(f.frames[0].controlMode, "human");
  assert.equal(f.frames[0].humanLeaseId, handle.info().leaseId);
  assert.deepEqual(handle.info().viewport, { width: 800, height: 600 });
  assert.equal(f.calls.filter(([method]) => method === "Page.screencastFrameAck").length, 1);
  for (const [method, target] of f.calls.filter(([method]) => !["capture", "pause"].includes(method))) assert.deepEqual(target, { targetId: "original-target" }, method);
  await handle.close(); assert.equal(handle.info().state, "released"); assert.equal(f.risks.size, 0);
  f.control.assertReleased(); assert.equal(f.listeners.size, 0);
});

test("sequences and typed input are scoped to the actual displayed lease", async () => {
  const f = fixture(), handle = await f.begin();
  await assert.rejects(input(handle, { type: "text", text: "unchanged" }, { generation: 0 }), /displayed human lease/);
  await assert.rejects(input(handle, { type: "text", text: "unchanged" }, { leaseId: "other" }), /displayed human lease/);
  await assert.rejects(input(handle, { type: "pointer", action: "move", x: 800, y: 1 }), /bounds/);
  await assert.rejects(input(handle, { type: "text", text: "x", method: "Runtime.evaluate" }), /invalid input fields/);
  let getterCalled = false;
  const hostile = Object.defineProperty({}, "type", { get() { getterCalled = true; return "text"; } });
  await assert.rejects(input(handle, hostile), /invalid input fields/); assert.equal(getterCalled, false);
  assert.equal(f.calls.filter(([method]) => method.startsWith("Input.")).length, 0);
  await input(handle, { type: "text", text: "one original insertion" });
  await assert.rejects(input(handle, { type: "text", text: "duplicate" }, { sequence: 1 }), /displayed human lease/);
  assert.equal(handle.info().lastInputSequence, 1);
  assert.equal(f.calls.filter(([method]) => method === "Input.insertText").length, 1);
  await handle.close(); await assert.rejects(input(handle, { type: "text", text: "late" }), /revoked/);
});

test("close revokes immediately but joins the original delayed down, release, and detach", async () => {
  const down = defer(), detached = defer();
  const f = fixture({ command: (method, params) => method === "Input.dispatchMouseEvent" && params.type === "mousePressed" ? down.promise : undefined, detach: () => detached.promise });
  const handle = await f.begin();
  const pending = input(handle, { type: "pointer", action: "down", x: 30, y: 40, button: "left" });
  pending.catch(() => {}); await tick();
  let closed = false; const closing = handle.close().then(() => { closed = true; });
  assert.match((await handle.closed).reason, /ended/);
  await assert.rejects(input(handle, { type: "text", text: "late" }), /revoked/);
  await tick(); assert.equal(closed, false); assert.equal(f.calls.some(([method]) => method === "detach"), false);
  assert.throws(() => f.control.assertReleased(), /releasing human control/);
  down.resolve(); assert.equal((await pending).acknowledged, true); await tick();
  const released = f.calls.findIndex(([method, , params]) => method === "Input.dispatchMouseEvent" && params.type === "mouseReleased");
  const detach = f.calls.findIndex(([method]) => method === "detach");
  assert.ok(released >= 0 && detach > released);
  assert.equal(f.risks.size, 1); assert.equal(closed, false);
  detached.resolve(); await closing; assert.equal(f.risks.size, 0);
});

test("pending input and stale requests never trigger a second native business command", async () => {
  const sent = defer(), f = fixture({ command: method => method === "Input.insertText" ? sent.promise : undefined });
  const handle = await f.begin(); const first = input(handle, { type: "text", text: "first" }); await tick();
  await assert.rejects(input(handle, { type: "text", text: "second" }), /original input acknowledgement/);
  assert.equal(f.calls.filter(([method]) => method === "Input.insertText").length, 1);
  sent.resolve(); await first; await handle.close();
});

test("committed text permits only actual Shift holds without releasing or replaying them", async () => {
  for (const codes of [["ShiftLeft"], ["ShiftRight"], ["ShiftLeft", "ShiftRight"]]) {
    const f = fixture(), handle = await f.begin();
    for (const code of codes) await input(handle, { type: "key", action: "down", key: "Shift", code, windowsVirtualKeyCode: 16, modifiers: 8 });
    await input(handle, { type: "text", text: "A!" });
    const inserts = f.calls.filter(([method]) => method === "Input.insertText");
    assert.equal(inserts.length, 1); assert.deepEqual(inserts[0][2], { text: "A!" });
    assert.equal(f.calls.filter(([method, , params]) => method === "Input.dispatchKeyEvent" && params.type === "keyUp").length, 0);
    for (const code of codes) {
      await assert.rejects(input(handle, { type: "key", action: "down", key: "Shift", code, windowsVirtualKeyCode: 16 }), /hold does not match/);
      await input(handle, { type: "key", action: "up", key: "Shift", code, windowsVirtualKeyCode: 16 });
    }
    await handle.close();
    const releases = f.calls.filter(([method, , params]) => method === "Input.dispatchKeyEvent" && params.type === "keyUp");
    assert.deepEqual(releases.map(([, , params]) => params.code), codes);
    assert.equal(f.risks.size, 0);
  }
});

test("closing shifted committed text joins its real insertion and Shift release before detach", async () => {
  const inserted = defer(), released = defer(), releaseEntered = defer();
  const f = fixture({ command: (method, params) => {
    if (method === "Input.insertText") return inserted.promise;
    if (method === "Input.dispatchKeyEvent" && params.type === "keyUp") { releaseEntered.resolve(); return released.promise; }
  } });
  const handle = await f.begin();
  await input(handle, { type: "key", action: "down", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, modifiers: 8 });
  const pending = input(handle, { type: "text", text: "A" }); pending.catch(() => {}); await tick();
  let closed = false; const closing = handle.close().then(() => { closed = true; });
  await handle.closed; await tick();
  assert.equal(closed, false); assert.equal(f.calls.some(([method, , params]) => method === "Input.dispatchKeyEvent" && params.type === "keyUp"), false);
  inserted.resolve(); assert.equal((await pending).acknowledged, true); await releaseEntered.promise;
  assert.throws(() => f.control.assertReleased(), /OBU_HUMAN_BUSY/);
  assert.equal(f.calls.some(([method]) => method === "detach"), false); assert.equal(f.risks.size, 1);
  released.resolve(); await closing;
  assert.equal(f.calls.filter(([method]) => method === "Input.insertText").length, 1);
  assert.equal(f.calls.filter(([method, , params]) => method === "Input.dispatchKeyEvent" && params.type === "keyUp").length, 1);
  assert.equal(f.risks.size, 0); f.control.assertReleased();
});

test("text still rejects other held keys, false Shift identities, and held mouse buttons", async () => {
  const keys = [
    { key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17 },
    { key: "Alt", code: "AltRight", windowsVirtualKeyCode: 18 },
    { key: "Meta", code: "MetaLeft", windowsVirtualKeyCode: 91 },
    { key: "A", code: "KeyA", windowsVirtualKeyCode: 65 },
    { key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 17 },
    { key: "Shift", code: "ShiftRight", windowsVirtualKeyCode: 17 },
    { key: "Shift", code: "KeyA", windowsVirtualKeyCode: 16 }
  ];
  for (const key of keys) {
    const f = fixture(), handle = await f.begin();
    await input(handle, { type: "key", action: "down", ...key });
    await assert.rejects(input(handle, { type: "text", text: "MUST_NOT_INSERT" }), /release held input/);
    assert.equal(f.calls.filter(([method]) => method === "Input.insertText").length, 0);
    assert.equal(handle.info().lastInputSequence, 1); await handle.close();
  }
  for (const button of ["left", "middle", "right"]) {
    const f = fixture(), handle = await f.begin();
    await input(handle, { type: "key", action: "down", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16 });
    await input(handle, { type: "pointer", action: "down", x: 1, y: 1, button });
    await assert.rejects(input(handle, { type: "text", text: "MUST_NOT_INSERT" }), /release held input/);
    assert.equal(f.calls.filter(([method]) => method === "Input.insertText").length, 0);
    assert.equal(handle.info().lastInputSequence, 2); await handle.close();
  }
});

test("durable input admission rechecks authority after the original storage completion", async () => {
  const durable = defer(); let marks = 0;
  const f = fixture({ markRisk: () => ++marks === 2 ? durable.promise : undefined });
  const handle = await f.begin(), pending = input(handle, { type: "key", action: "down", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16 });
  pending.catch(() => {}); await tick(); f.expire(); const closing = handle.close();
  assert.equal(f.calls.some(([method]) => method === "Input.dispatchKeyEvent"), false);
  durable.resolve(); await assert.rejects(pending, /revoked|expired/); await closing;
  assert.equal(f.calls.filter(([method, , params]) => method === "Input.dispatchKeyEvent" && params.type === "rawKeyDown").length, 0);
});

test("unknown native input rejects without replay and still releases original held intent", async () => {
  const failure = new Error("original native input failed");
  const f = fixture({ command: (method, params) => { if (method === "Input.dispatchKeyEvent" && params.type === "rawKeyDown") throw failure; } });
  const handle = await f.begin();
  await assert.rejects(input(handle, { type: "key", action: "down", key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17 }), error => error === failure);
  await handle.close();
  assert.equal(f.calls.filter(([method, , params]) => method === "Input.dispatchKeyEvent" && params.type === "rawKeyDown").length, 1);
  assert.equal(f.calls.filter(([method, , params]) => method === "Input.dispatchKeyEvent" && params.type === "keyUp").length, 1);
});

test("foreign targets and child sessions cannot publish or retire the human lease", async () => {
  const f = fixture(), handle = await f.begin();
  f.emit({ targetId: "successor-target", tabId: 7 }); f.emit({ targetId: "original-target", sessionId: "child" }); await tick();
  f.emit({ targetId: "original-target", tabId: 8 }); f.emit({ targetId: 7, tabId: 7 }); f.emit({ extensionId: "worker", tabId: 7 }); await tick();
  assert.equal(f.frames.length, 1);
  assert.equal(f.control.observeDetach({ targetId: "successor-target", tabId: 7 }, "target_closed"), false);
  assert.equal(handle.info().state, "active");
  f.emit({ tabId: 7 }); await tick(); assert.equal(f.frames.length, 2);
  await handle.close();
});

for (const boundary of ["capture", "pause", "markRisk", "attach", "Page.enable", "Page.startScreencast", "Page.screencastFrameAck"]) {
  test(`revoked authority during ${boundary} joins its original work and cleans without further startup`, async () => {
    const pending = defer(), entered = defer();
    const wait = () => { entered.resolve(); return pending.promise; };
    const options = boundary.includes(".") ? { command: method => method === boundary ? wait() : undefined } : { [boundary]: wait };
    const f = fixture(options), beginning = f.begin(); beginning.catch(() => {});
    await entered.promise;
    f.expire();
    let finished = false;
    beginning.finally(() => { finished = true; }).catch(() => {});
    await tick(); assert.equal(finished, false);
    assert.throws(() => f.control.assertReleased(), /OBU_HUMAN_BUSY/);
    pending.resolve();
    await assert.rejects(beginning, /expired|revoked/);
    f.control.assertReleased();
    assert.equal(f.frames.length, 0); assert.equal(f.risks.size, 0); assert.equal(f.listeners.size, 0);
    assert.equal(f.calls.filter(([method]) => method.startsWith("Input.")).length, 0);
    if (["capture", "pause", "markRisk"].includes(boundary)) assert.equal(f.calls.filter(([method]) => method === "attach").length, 0);
    else assert.equal(f.calls.filter(([method]) => method === "detach").length, 1);
    if (!["Page.startScreencast", "Page.screencastFrameAck"].includes(boundary)) assert.equal(f.calls.filter(([method]) => method === "Page.startScreencast").length, 0);
  });
}

test("a failed begin with unconfirmed cleanup reports its barrier instead of a resource-free rejection", async () => {
  const focus = defer(), entered = defer(); let failDetach = true;
  const f = fixture({ command: (method, params) => {
    if (method === "Emulation.setFocusEmulationEnabled" && params.enabled) { entered.resolve(); return focus.promise; }
  }, detach: () => { if (failDetach) throw new Error("original detach unconfirmed"); } });
  const beginning = f.begin(); beginning.catch(() => {}); await entered.promise; f.expire(); focus.resolve();
  await assert.rejects(beginning, error => error.humanCleanupIncomplete === true && /OBU_HUMAN_CLEANUP_INCOMPLETE/.test(error.message));
  assert.throws(() => f.control.assertReleased(), /OBU_HUMAN_BUSY/); assert.equal(f.risks.size, 1);
  failDetach = false; await f.control.cancel(new Error("explicit cleanup")); f.control.assertReleased();
});

test("closing waits for the original native frame ACK and stop before detaching", async () => {
  const ack = defer(), ackEntered = defer(), stop = defer(), stopEntered = defer(); let ackNumber = 0;
  const f = fixture({ command: method => {
    if (method === "Page.screencastFrameAck" && ++ackNumber === 2) { ackEntered.resolve(); return ack.promise; }
    if (method === "Page.stopScreencast") { stopEntered.resolve(); return stop.promise; }
  } });
  const handle = await f.begin(); f.emit(); await ackEntered.promise;
  const closing = handle.close(); await handle.closed; await tick();
  assert.equal(f.calls.some(([method]) => method === "Page.stopScreencast"), false);
  assert.equal(f.calls.some(([method]) => method === "detach"), false);
  ack.resolve(); await stopEntered.promise;
  assert.equal(f.calls.some(([method]) => method === "detach"), false);
  assert.equal(f.frames.length, 1); assert.equal(f.risks.size, 1);
  stop.resolve(); await closing;
  assert.equal(f.calls.filter(([method]) => method === "Page.screencastFrameAck").length, 2);
  assert.equal(f.calls.filter(([method]) => method === "detach").length, 1);
});

test("input admission snapshots caller values and errors name stale, busy, and invalid contracts", async () => {
  const durable = defer(), entered = defer(); let writes = 0;
  const f = fixture({ markRisk: () => { if (++writes === 2) { entered.resolve(); return durable.promise; } } }), handle = await f.begin();
  await assert.rejects(input(handle, { type: "text", text: "x" }, { generation: 2 }), /OBU_HUMAN_GENERATION_STALE/);
  await assert.rejects(input(handle, { type: "wheel", x: 1, y: 1, deltaX: 4097, deltaY: 0 }), /OBU_HUMAN_INVALID/);
  await assert.rejects(input(handle, { type: "key", action: "down", key: "x".repeat(65), code: "KeyX", windowsVirtualKeyCode: 88 }), /OBU_HUMAN_INVALID/);
  const value = { type: "key", action: "down", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16 };
  const info = handle.info(), envelope = { leaseId: info.leaseId, generation: info.generation, sequence: 1, input: value };
  const pending = handle.input(envelope); await entered.promise;
  value.code = "ControlLeft"; value.key = "Control"; value.windowsVirtualKeyCode = 17; envelope.sequence = 10;
  await assert.rejects(input(handle, { type: "text", text: "queued" }), /OBU_HUMAN_BUSY/);
  durable.resolve(); await pending;
  assert.equal(handle.info().lastInputSequence, 1);
  const down = f.calls.find(([method, , params]) => method === "Input.dispatchKeyEvent" && params.type === "rawKeyDown");
  assert.equal(down[2].code, "ShiftLeft");
  await input(handle, { type: "key", action: "up", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16 });
  await handle.close();
});

test("failed detach does not hide a later external detach from the original lease", async () => {
  let failure = true;
  const f = fixture({ detach: () => { if (failure) throw new Error("detach failed"); } }), handle = await f.begin();
  await assert.rejects(handle.close(), /detach failed/);
  assert.equal(f.control.observeDetach({ targetId: "original-target" }, "canceled_by_user"), true);
  failure = false;
  await assert.rejects(handle.close(), /OBU_HUMAN_CLEANUP_INCOMPLETE/);
  assert.equal(f.risks.size, 1);
  f.control.invalidateTab(7, { destroyed: true }); await handle.close();
});

test("key release binds the original virtual key and retains its acknowledged key identity", async () => {
  const f = fixture(), handle = await f.begin();
  await input(handle, { type: "key", action: "down", key: "C", code: "KeyC", windowsVirtualKeyCode: 67, modifiers: 8 });
  await assert.rejects(input(handle, { type: "key", action: "up", key: "Control", code: "KeyC", windowsVirtualKeyCode: 17 }), /original virtual key/);
  assert.equal(f.calls.filter(([method, , params]) => method === "Input.dispatchKeyEvent" && params.type === "keyUp").length, 0);
  await input(handle, { type: "key", action: "up", key: "c", code: "KeyC", windowsVirtualKeyCode: 67 });
  const release = f.calls.find(([method, , params]) => method === "Input.dispatchKeyEvent" && params.type === "keyUp");
  assert.equal(release[2].key, "C"); assert.equal(release[2].windowsVirtualKeyCode, 67);
  await handle.close();
});

test("geometry changes retire coordinates and never silently reopen a stream", async () => {
  const f = fixture(), handle = await f.begin();
  f.emit(undefined, { deviceWidth: 801, deviceHeight: 600, pageScaleFactor: 1, offsetTop: 0 });
  await handle.closed; await handle.close();
  assert.equal(f.frames.length, 1); assert.equal(handle.info().viewport, null);
  assert.equal(handle.info().generation, 2);
  assert.equal(f.calls.filter(([method]) => method === "Page.startScreencast").length, 1);
});

const metrics = overrides => ({ cssVisualViewport: { clientWidth: 800, clientHeight: 600, scale: 1, zoom: 1, offsetX: 0, offsetY: 0, ...overrides } });
const resize = (f, source = { targetId: "original-target" }) => {
  for (const listener of [...f.listeners]) listener(source, "Page.frameResized", {});
};

test("only an actual first frame establishes the full input surface, including scrollbars", async () => {
  // Native diagnostic cEDK4O measured these same dimensions in both LTR and
  // RTL. Public coordinates do not infer which side contains the scrollbar.
  const f = fixture({ frames: false, command: method => method === "Page.getLayoutMetrics" ? metrics({ clientWidth: 763, clientHeight: 446 }) : undefined });
  const beginning = f.begin(); await tick();
  assert.equal(f.control.status().viewport, null); assert.equal(f.control.status().generation, 0);
  const metadata = { deviceWidth: 778, deviceHeight: 446, pageScaleFactor: 1, offsetTop: 0 };
  f.emit(undefined, metadata); const handle = await beginning;
  assert.deepEqual(handle.info().viewport, { width: 778, height: 446 });
  for (const point of [{ x: 777, y: 445 }, { x: 0, y: 445 }, { x: 762.5, y: 0 }]) {
    await input(handle, { type: "pointer", action: "move", ...point });
    assert.deepEqual(f.calls.filter(([method]) => method === "Input.dispatchMouseEvent").at(-1)[2],
      { ...point, type: "mouseMoved", button: "none", buttons: 0, modifiers: 0, clickCount: 0 });
  }
  for (const point of [{ x: 778, y: 0 }, { x: 0, y: 446 }])
    await assert.rejects(input(handle, { type: "pointer", action: "move", ...point }), /OBU_HUMAN_INVALID/);
  assert.equal(handle.info().lastInputSequence, 3);
  await handle.close(); f.control.assertReleased();
});

test("unsupported CSS scale, zoom, offset and client bounds reject startup with actual cleanup", async () => {
  for (const change of [{ scale: 2 }, { zoom: 1.25 }, { zoom: undefined }, { offsetX: 1 }, { offsetY: 1 },
    { clientWidth: NaN }, { clientHeight: 0 }, { clientWidth: 16385 }]) {
    const f = fixture({ command: method => method === "Page.getLayoutMetrics" ? metrics(change) : undefined });
    await assert.rejects(f.begin(), /OBU_HUMAN_GEOMETRY/);
    assert.equal(f.calls.filter(([method]) => method === "detach").length, 1);
    assert.equal(f.risks.size, 0); f.control.assertReleased();
  }
});

test("invalid native surfaces never grant input and still ACK, stop and detach the original stream", async () => {
  for (const change of [{ deviceWidth: 799 }, { deviceHeight: 599 }, { deviceWidth: Infinity }, { deviceHeight: 16385 },
    { pageScaleFactor: 2 }, { offsetTop: 1 }, { offsetTop: undefined }]) {
    const f = fixture({ metadata: { deviceWidth: 800, deviceHeight: 600, pageScaleFactor: 1, offsetTop: 0, ...change } });
    await assert.rejects(f.begin(), /revoked|cancelled because tab control ended|OBU_HUMAN_GEOMETRY/);
    assert.equal(f.frames.length, 0); assert.equal(f.risks.size, 0); f.control.assertReleased();
    for (const method of ["Page.screencastFrameAck", "Page.stopScreencast", "detach"])
      assert.equal(f.calls.filter(([name]) => name === method).length, 1, method);
  }
});

test("client-only changes, zoom and offsets stop an original input before native delivery", async () => {
  for (const change of [{ clientWidth: 799 }, { clientHeight: 599 }, { zoom: 2 }, { scale: 2 }, { offsetX: 1 }, { offsetY: 1 }]) {
    let current = metrics();
    const f = fixture({ command: method => method === "Page.getLayoutMetrics" ? current : undefined }), handle = await f.begin();
    current = metrics(change);
    await assert.rejects(input(handle, { type: "text", text: "MUST_NOT_INSERT" }), /OBU_HUMAN_GEOMETRY/);
    await handle.close();
    assert.equal(f.calls.filter(([method]) => method.startsWith("Input.")).length, 0);
    assert.equal(handle.info().lastInputSequence, 0); f.control.assertReleased();
  }
});

test("original resize events retire changed client geometry without waiting for user input", async () => {
  for (const change of [{ clientWidth: 799 }, { clientHeight: 599 }, { zoom: 1.25 }, { offsetY: 1 }]) {
    let current = metrics();
    const f = fixture({ command: method => method === "Page.getLayoutMetrics" ? current : undefined }), handle = await f.begin();
    current = metrics(change); resize(f);
    assert.match((await handle.closed).reason, /OBU_HUMAN_GEOMETRY/); await handle.close();
    assert.equal(handle.info().viewport, null); assert.equal(handle.info().generation, 2);
    assert.equal(f.calls.filter(([method]) => method.startsWith("Input.")).length, 0);
  }
});

test("scroll offsets and unchanged resize notifications preserve full-surface coordinates", async () => {
  let current = metrics();
  const f = fixture({ command: method => method === "Page.getLayoutMetrics" ? current : undefined }), handle = await f.begin();
  current = metrics({ pageX: 12, pageY: 345 });
  resize(f, { targetId: "foreign", tabId: 7 }); await tick();
  assert.equal(f.calls.filter(([method]) => method === "Page.getLayoutMetrics").length, 1);
  resize(f); await tick();
  f.emit(undefined, { deviceWidth: 800, deviceHeight: 600, pageScaleFactor: 1, offsetTop: 0, scrollOffsetX: 12, scrollOffsetY: 345 }); await tick();
  await input(handle, { type: "pointer", action: "move", x: 799, y: 599 });
  assert.equal(handle.info().generation, 1); assert.equal(f.frames.length, 2); await handle.close();
});

test("End joins a pending original resize reply and never revives coordinates or a successor", async () => {
  const gate = defer(), entered = defer(); let reads = 0;
  const f = fixture({ command: method => {
    if (method === "Page.getLayoutMetrics" && ++reads === 2) { entered.resolve(); return gate.promise; }
  } }), handle = await f.begin();
  resize(f); await entered.promise;
  for (let n = 0; n < 20; n++) resize(f);
  assert.equal(reads, 2);
  let finished = false; const closing = handle.close().then(() => { finished = true; });
  await handle.closed; await tick(); assert.equal(finished, false);
  assert.equal(f.calls.some(([method]) => method === "detach"), false);
  assert.throws(() => f.begin(), /OBU_HUMAN_BUSY/);
  gate.resolve(metrics({ clientWidth: 790 })); await closing;
  assert.equal(reads, 2); assert.equal(handle.info().state, "released");
  assert.equal(f.frames.length, 1); assert.equal(f.risks.size, 0);
  const successor = await f.begin(); assert.notEqual(successor.info().leaseId, handle.info().leaseId);
  assert.deepEqual(successor.info().viewport, { width: 800, height: 600 }); await successor.close();
});

test("resize uncertainty during durable admission cannot dispatch a native input", async () => {
  const durable = defer(), marked = defer(), resized = defer(), resizeEntered = defer();
  let marks = 0, reads = 0;
  const f = fixture({ markRisk: () => { if (++marks === 2) { marked.resolve(); return durable.promise; } }, command: method => {
    if (method === "Page.getLayoutMetrics" && ++reads === 3) { resizeEntered.resolve(); return resized.promise; }
  } }), handle = await f.begin();
  const pending = input(handle, { type: "text", text: "MUST_NOT_INSERT" }); pending.catch(() => {}); await marked.promise;
  resize(f); await resizeEntered.promise; durable.resolve();
  await assert.rejects(pending, /OBU_HUMAN_GEOMETRY/); await handle.closed;
  let finished = false; const closing = handle.close().then(() => { finished = true; }); await tick();
  assert.equal(finished, false); assert.equal(f.calls.some(([method]) => method.startsWith("Input.")), false);
  assert.equal(f.calls.some(([method]) => method === "detach"), false);
  resized.resolve(metrics()); await closing;
  assert.equal(f.risks.size, 0); f.control.assertReleased();
});

test("an external debugger loss is not a fabricated input-release acknowledgement", async () => {
  const f = fixture(), handle = await f.begin();
  await input(handle, { type: "pointer", action: "down", x: 1, y: 1, button: "left" });
  assert.equal(f.control.observeDetach({ tabId: 7 }, "canceled_by_user"), true);
  await assert.rejects(handle.close(), /did not confirm/);
  assert.throws(() => f.control.assertReleased(), /releasing human control/);
  assert.equal(f.risks.size, 1); assert.equal(f.calls.some(([method]) => method === "detach"), false);
  f.control.invalidateTab(7, { destroyed: true }); await handle.close(); f.control.assertReleased();
});

test("actual tab destruction clears risk without sending cleanup to a successor", async () => {
  const f = fixture(), handle = await f.begin();
  await input(handle, { type: "key", action: "down", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16 });
  f.control.invalidateTab(7, { destroyed: true }); await handle.close();
  assert.equal(f.risks.size, 0); assert.equal(f.calls.some(([method]) => method === "detach"), false);
  assert.equal(f.calls.filter(([method, , params]) => method === "Input.dispatchKeyEvent" && params.type === "keyUp").length, 0);
});

test("failed real detach retains the reservation and durable risk until explicit cleanup", async () => {
  let failDetach = true;
  const f = fixture({ detach: () => { if (failDetach) throw new Error("native detach failed"); } }), handle = await f.begin();
  await assert.rejects(handle.close(), /native detach failed/);
  assert.equal(handle.info().state, "error"); assert.equal(f.risks.size, 1);
  assert.throws(() => f.begin(), /releasing human control/);
  failDetach = false; await handle.close(); f.control.assertReleased();
});

test("cancel during original attach waits for that completion and never attaches twice", async () => {
  const attaching = defer(), f = fixture({ attach: () => attaching.promise });
  const pending = f.begin(); pending.catch(() => {}); await tick();
  const closing = f.control.cancel(new Error("viewer disconnected")); await tick();
  assert.equal(f.calls.some(([method]) => method === "detach"), false);
  attaching.resolve(); await assert.rejects(pending, /revoked/); await closing;
  assert.equal(f.calls.filter(([method]) => method === "attach").length, 1);
  assert.equal(f.calls.filter(([method]) => method === "detach").length, 1);
});


test("navigation keeps the same lease and target but synchronously retires its displayed generation", async () => {
  const f = fixture(), handle = await f.begin(), before = handle.info();
  await input(handle, { type: "text", text: "A only" });
  let wholeClosed = false; handle.closed.then(() => { wholeClosed = true; });
  f.changeDocument("B");
  f.control.navigation(7, { frameId: 0 }, "committed");
  assert.deepEqual(handle.info(), { ...before, state: "navigating", generation: 2, viewport: null, lastInputSequence: 0 });
  assert.deepEqual(f.states.at(-1), handle.info());
  await assert.rejects(handle.input({ leaseId: before.leaseId, generation: 1, sequence: 2, input: { type: "text", text: "old queue" } }), /OBU_HUMAN_GENERATION_STALE/);
  await f.control.current.recovery;
  assert.equal(handle.info().state, "active"); assert.equal(handle.info().leaseId, before.leaseId);
  assert.equal(handle.info().generation, 2); assert.equal(handle.info().lastInputSequence, 0);
  const receipt = await input(handle, { type: "text", text: "B only" });
  assert.deepEqual(receipt, { leaseId: before.leaseId, generation: 2, sequence: 1, acknowledged: true });
  assert.equal(Object.isFrozen(receipt), true); assert.equal(wholeClosed, false);
  assert.equal(f.calls.filter(([method]) => method === "attach").length, 1);
  assert.equal(f.calls.filter(([method]) => method === "pause").length, 1);
  assert.equal(f.risks.size, 1); assert.throws(() => f.control.assertReleased(), /OBU_HUMAN_BUSY/);
  await handle.close();
});

test("tab metadata stays blank before a verified frame and after the original lease closes", async t => {
  const f = fixture({ frames: false }), beginning = f.begin();
  t.after(async () => { f.emit(); try { await beginning; } finally { await f.control.current?.handle.close(); } });
  await tick();
  const original = f.control.current.handle;
  assert.deepEqual(original.tabInfo(), { id: 7, title: "页面正在跳转", url: "" });
  f.emit(); const handle = await beginning;
  assert.deepEqual(handle.tabInfo(), { id: 7, title: "Title original-document", url: "https://fixture.test/original-document" });
  assert.equal(Object.isFrozen(handle.tabInfo()), true);
  await handle.close();
  assert.deepEqual(handle.tabInfo(), { id: 7, title: "", url: "" });
});

test("tab metadata never publishes a late candidate from an abandoned navigation", async t => {
  const f = fixture(), handle = await f.begin(), entered = defer(), read = defer();
  t.after(async () => { read.resolve(); await handle.close(); });
  const validate = f.control.validate;
  f.control.validate = async (candidate, options) => {
    const result = await validate(candidate, options);
    if (options?.advance && result.documentId === "B") { entered.resolve(); await read.promise; }
    return result;
  };
  f.changeDocument("B"); f.control.navigation(7, { frameId: 0 }, "committed"); await entered.promise;
  assert.deepEqual(handle.tabInfo(), { id: 7, title: "页面正在跳转", url: "" });
  f.changeDocument("C"); f.control.navigation(7, { frameId: 0 }, "committed");
  read.resolve(); await f.control.current.recovery;
  assert.deepEqual(handle.tabInfo(), { id: 7, title: "Title C", url: "https://fixture.test/C" });
  assert.deepEqual(f.frames.map(frame => frame.generation), [1, 3]);
  assert.equal(f.calls.filter(([method]) => method === "attach").length, 1);
});

test("tab metadata uses the final original validation without changing typed human info", async t => {
  const f = fixture(), validate = f.control.validate;
  f.control.validate = async (...args) => ({ ...await validate(...args), title: f.control.current?.epoch?.document ? "Final title" : "Early title" });
  const handle = await f.begin(); t.after(() => handle.close());
  assert.equal(handle.tabInfo().title, "Final title");
  assert.deepEqual(Object.keys(handle.info()).sort(), ["generation", "lastInputSequence", "leaseId", "state", "tabId", "viewport"]);
});

test("old down ACK remains its exact tuple and held release finishes before any successor stream", async () => {
  const down = defer(), release = defer(), releaseEntered = defer(); let held = false;
  const f = fixture({ command: (method, params) => {
    if (method === "Input.dispatchMouseEvent" && params.type === "mousePressed") { held = true; return down.promise; }
    if (method === "Input.dispatchMouseEvent" && params.type === "mouseReleased") { releaseEntered.resolve(); return release.promise; }
  } }), handle = await f.begin(), old = handle.info();
  const sending = input(handle, { type: "pointer", action: "down", x: 10, y: 20, button: "left" });
  await tick(); assert.equal(held, true);
  f.changeDocument(); f.control.navigation(7, { frameId: 0 }, "committed");
  await tick(); assert.equal(f.calls.filter(([method]) => method === "Page.startScreencast").length, 1);
  down.resolve();
  assert.deepEqual(await sending, { leaseId: old.leaseId, generation: 1, sequence: 1, acknowledged: true });
  await releaseEntered.promise; assert.equal(handle.info().lastInputSequence, 0);
  assert.equal(f.calls.filter(([method]) => method === "Page.startScreencast").length, 1);
  release.resolve(); await f.control.current.recovery;
  assert.equal(handle.info().state, "active"); assert.equal(handle.info().generation, 2);
  await assert.rejects(input(handle, { type: "pointer", action: "up", x: 10, y: 20, button: "left" }), /hold does not match/);
  assert.equal(f.calls.filter(([method, , params]) => method === "Input.dispatchMouseEvent" && params.type === "mouseReleased").length, 1);
  await handle.close();
});

test("navigation during durable input admission rejects definitely unsent old input and retains the lease", async () => {
  const marked = defer(), markEntered = defer(); let marks = 0;
  const f = fixture({ markRisk: () => { if (++marks === 2) { markEntered.resolve(); return marked.promise; } } }), handle = await f.begin();
  const sending = input(handle, { type: "text", text: "must never be inserted" }); sending.catch(() => {});
  await markEntered.promise; f.changeDocument(); f.control.navigation(7, { frameId: 0 }, "committed");
  marked.resolve(); await assert.rejects(sending, /OBU_HUMAN_GENERATION_STALE/);
  await f.control.current.recovery;
  assert.equal(handle.info().state, "active"); assert.equal(handle.info().lastInputSequence, 0);
  assert.equal(f.calls.filter(([method]) => method === "Input.insertText").length, 0);
  await handle.close();
});

test("retirement waits for original frame ACK and real stop before a new native start", async () => {
  const ack = defer(), stop = defer(), stopped = defer(); let acks = 0, stops = 0;
  const f = fixture({ command: method => {
    if (method === "Page.screencastFrameAck" && ++acks === 2) return ack.promise;
    if (method === "Page.stopScreencast" && ++stops === 1) { stopped.resolve(); return stop.promise; }
  } }), handle = await f.begin();
  f.emit(); await tick(); f.changeDocument(); f.control.navigation(7, { frameId: 0 }, "committed");
  await tick(); assert.equal(stops, 0); assert.equal(f.frames.length, 1);
  ack.resolve(); await stopped.promise;
  assert.equal(f.calls.filter(([method]) => method === "Page.startScreencast").length, 1);
  stop.resolve(); await f.control.current.recovery;
  assert.deepEqual(f.frames.map(frame => frame.generation), [1, 2]); await handle.close();
});

test("a new native stream ACKs but rejects an old encoding captured before its TimeTicks barrier", async () => {
  let starts = 0;
  const f = fixture({ frames: false, command: method => { if (method === "Page.startScreencast") starts++; } });
  const beginning = f.begin(); await tick(); f.emit(); const handle = await beginning;
  f.changeDocument(); f.control.navigation(7, { frameId: 0 }, "committed");
  await tick(); assert.equal(starts, 2);
  f.emit(undefined, { deviceWidth: 800, deviceHeight: 600, pageScaleFactor: 1, offsetTop: 0, timestamp: 9999999999, monotonicTimestamp: 101 });
  await tick(); assert.equal(handle.info().state, "navigating"); assert.equal(handle.info().viewport, null); assert.equal(f.frames.length, 1);
  assert.equal(f.calls.filter(([method]) => method === "Page.screencastFrameAck").length, 2);
  f.emit(); await f.control.current.recovery;
  assert.equal(handle.info().state, "active"); assert.equal(f.frames.at(-1).metadata.monotonicTimestamp, 111);
  await handle.close();
});

test("missing native monotonic evidence never falls back to wall clock or stream identity", async () => {
  const f = fixture({ metadata: { deviceWidth: 800, deviceHeight: 600, pageScaleFactor: 1, offsetTop: 0, timestamp: Date.now() / 1000, monotonicTimestamp: undefined } });
  await assert.rejects(f.begin(), /OBU_HUMAN_CAPTURE_UNSUPPORTED:.*capture timestamp/); f.control.assertReleased();
  assert.equal(f.frames.length, 0); assert.equal(f.calls.filter(([method]) => method === "Page.screencastFrameAck").length, 1);
  for (const mode of ["human", "view"]) {
    const g = fixture({ command: method => method === "Performance.getMetrics" ? { metrics: [] } : undefined });
    await assert.rejects(mode === "human" ? g.begin() : g.beginView(), /OBU_HUMAN_CAPTURE_UNSUPPORTED:.*capture barrier/);
    g.control.assertReleased();
    assert.equal(g.calls.filter(([method]) => method === "Page.startScreencast").length, 0);
    assert.equal(g.calls.filter(([method]) => method === "detach").length, 1);
    assert.equal(g.frames.length, 0); assert.equal(g.risks.size, 0);
  }
});

for (const mode of ["human", "view"]) {
  test(`${mode} rejects the Chrome 155 metadata shape only after original ACK, stop and detach settle`, async () => {
    // Chromium tag 155.0.8059.84 Page.pdl declares only the wall-clock field;
    // page_handler.cc constructs it with Time::Now(), not capture TimeTicks.
    // This is a protocol-shaped unit fixture, not the original browser event.
    const nativeMetadata = Object.freeze({ offsetTop: 0, pageScaleFactor: 1, deviceWidth: 800, deviceHeight: 600,
      scrollOffsetX: 0, scrollOffsetY: 0, timestamp: 1792231474.855 });
    const ack = defer(), ackEntered = defer(), stop = defer(), stopEntered = defer(), detach = defer(), detachEntered = defer();
    const f = fixture({ nativeMetadata, command: method => {
      if (method === "Page.screencastFrameAck") { ackEntered.resolve(); return ack.promise; }
      if (method === "Page.stopScreencast") { stopEntered.resolve(); return stop.promise; }
    }, detach: () => { detachEntered.resolve(); return detach.promise; } });
    const beginning = mode === "human" ? f.begin() : f.beginView();
    let settled = false;
    beginning.then(() => { settled = true; }, () => { settled = true; });
    await ackEntered.promise;
    assert.equal(settled, false); assert.equal(f.frames.length, 0);
    assert.equal(f.calls.some(([method]) => method === "Page.stopScreencast" || method === "detach"), false);
    ack.resolve(); await stopEntered.promise;
    assert.equal(settled, false); assert.equal(f.calls.some(([method]) => method === "detach"), false);
    assert.throws(() => f.control.assertReleased(), /OBU_HUMAN_BUSY/);
    stop.resolve(); await detachEntered.promise;
    assert.equal(settled, false); assert.equal(f.risks.size, mode === "human" ? 1 : 0);
    detach.resolve();
    await assert.rejects(beginning, /OBU_HUMAN_CAPTURE_UNSUPPORTED:.*recommended compatible managed browser/);
    f.control.assertReleased();
    assert.equal(f.frames.length, 0); assert.equal(f.states.some(value => value.state === "active"), false);
    assert.equal(f.listeners.size, 0); assert.equal(f.risks.size, 0);
    assert.equal(f.calls.some(([method]) => method.startsWith("Input.")), false);
    for (const method of ["Page.startScreencast", "Page.screencastFrameAck", "Page.stopScreencast", "detach"])
      assert.equal(f.calls.filter(([name]) => name === method).length, 1, method);
    if (mode === "view") assertViewOnly(f);
  });
}

test("redirect and subframe pending events keep input closed until the last original navigation commits", async () => {
  const f = fixture(), handle = await f.begin();
  f.control.navigation(7, { frameId: 0 }, "pending");
  f.control.navigation(7, { frameId: 0 }, "updated");
  f.event("Page.frameStartedNavigating", { frameId: "root" });
  await tick(); assert.equal(f.calls.filter(([method]) => method === "Page.startScreencast").length, 1);
  f.changeDocument("B"); f.control.navigation(7, { frameId: 0 }, "committed");
  await tick(); assert.equal(handle.info().state, "navigating");
  f.event("Page.frameNavigated", { frame: { id: "root" } });
  await f.control.current.recovery; const generation = handle.info().generation;
  f.control.navigation(7, { frameId: 4 }, "pending"); await tick();
  assert.equal(handle.info().state, "navigating");
  f.control.navigation(7, { frameId: 4 }, "committed"); await f.control.current.recovery;
  assert.ok(handle.info().generation > generation); assert.equal(handle.info().state, "active");
  f.event("Page.navigatedWithinDocument", { frameId: "root", url: "https://fixture.test/B#next" });
  await f.control.current.recovery; assert.equal(handle.info().state, "active");
  assert.equal(f.calls.filter(([method]) => method === "attach").length, 1); await handle.close();
});

test("navigation during document preparation cannot publish or reuse that abandoned generation", async () => {
  const reading = defer(), entered = defer(); let reads = 0;
  const f = fixture({ command: method => {
    if (method === "Performance.getMetrics" && ++reads === 2) { entered.resolve(); return reading.promise; }
  } }), handle = await f.begin();
  f.changeDocument("B"); f.control.navigation(7, { frameId: 0 }, "committed"); await entered.promise;
  const abandoned = handle.info().generation;
  f.changeDocument("C"); f.control.navigation(7, { frameId: 0 }, "committed");
  reading.resolve({ metrics: [{ name: "Timestamp", value: 110 }] }); await f.control.current.recovery;
  assert.equal(handle.info().generation, abandoned + 1);
  assert.deepEqual(f.frames.map(frame => frame.generation), [1, abandoned + 1]);
  await handle.close();
});

test("End during navigation keeps the original native preparation in cleanup and never opens a successor", async () => {
  const reading = defer(), entered = defer(); let reads = 0;
  const f = fixture({ command: method => {
    if (method === "Performance.getMetrics" && ++reads === 2) { entered.resolve(); return reading.promise; }
  } }), handle = await f.begin();
  f.changeDocument(); f.control.navigation(7, { frameId: 0 }, "committed"); await entered.promise;
  let ended = false; const closing = handle.close().then(() => { ended = true; });
  await tick(); assert.equal(ended, false); assert.equal(f.calls.some(([method]) => method === "detach"), false);
  reading.resolve({ metrics: [{ name: "Timestamp", value: 110 }] }); await closing;
  assert.equal(handle.info().state, "released"); assert.equal(f.calls.filter(([method]) => method === "Page.startScreencast").length, 1);
});

test("a bounded navigation deadline revokes but never invents a pending native release ACK", async () => {
  const releasing = defer(), entered = defer();
  const f = fixture({ command: (method, params) => {
    if (method === "Input.dispatchKeyEvent" && params.type === "keyUp") { entered.resolve(); return releasing.promise; }
  } }), handle = await f.begin(); f.control.recoveryTimeoutMs = 15;
  await input(handle, { type: "key", action: "down", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16 });
  f.control.navigation(7, { frameId: 0 }, "pending"); await entered.promise;
  assert.match((await handle.closed).reason, /OBU_HUMAN_NAVIGATION_TIMEOUT/);
  assert.equal(f.risks.size, 1); assert.throws(() => f.control.assertReleased(), /OBU_HUMAN_BUSY/);
  assert.equal(f.calls.some(([method]) => method === "detach"), false);
  releasing.resolve(); await handle.close(); assert.equal(f.risks.size, 0);
});

test("an unknown old native input error ends the whole lease instead of continuing its new document", async () => {
  const sent = defer(), f = fixture({ command: method => method === "Input.insertText" ? sent.promise : undefined }), handle = await f.begin();
  const sending = input(handle, { type: "text", text: "unknown" }); sending.catch(() => {}); await tick();
  f.changeDocument(); f.control.navigation(7, { frameId: 0 }, "committed");
  sent.reject(new Error("native outcome unknown")); await assert.rejects(sending, /outcome unknown/);
  await handle.close(); assert.equal(handle.info().state, "released");
  assert.equal(f.calls.filter(([method]) => method === "Page.startScreencast").length, 1);
  assert.equal(f.calls.filter(([method]) => method === "Input.insertText").length, 1);
});

const assertViewOnly = f => {
  assert.equal(f.calls.some(([method]) => method === "pause" || method.startsWith("Input.") || method === "Emulation.setFocusEmulationEnabled"), false);
  assert.equal(f.risks.size, 0);
};

test("view mode shares original native frames without Pause, input, focus or durable input risk", async () => {
  const forbidden = () => assert.fail("view acquired human authority");
  const f = fixture({ pause: forbidden, markRisk: forbidden, clearRisk: forbidden });
  f.control.assertPaused = forbidden;
  const handle = await f.beginView(), record = f.control.current;
  assert.equal(record.mode, "view"); assert.throws(() => { record.mode = "human"; }, TypeError);
  assert.equal(record.tracker, undefined); assert.equal(record.epoch.tracker, undefined);
  assert.deepEqual(Object.keys(handle).sort(), ["close", "closed", "info", "tabInfo"]);
  assert.equal(Object.isFrozen(handle), true); assert.equal(handle.info().state, "active");
  assert.equal(handle.info().lastInputSequence, 0); f.control.assertHumanReleased();
  assert.throws(() => f.control.assertReleased(), /OBU_HUMAN_BUSY/);
  assert.deepEqual(handle.tabInfo(), { id: 7, title: "Title original-document", url: "https://fixture.test/original-document" });
  const frame = f.frames[0];
  assert.equal(frame.controlMode, "user-view"); assert.equal(frame.viewLeaseId, handle.info().leaseId);
  assert.equal(Object.hasOwn(frame, "humanLeaseId"), false); assert.equal(frame.generation, 1);
  await assert.rejects(f.control.input(record, {}), /view lease has no input authority/);
  assert.throws(() => f.control.send(record, "Input.insertText", { text: "must not send" }), /no native input or focus authority/);
  await handle.close(); assertViewOnly(f); f.control.assertReleased(); f.control.assertHumanReleased();
  assert.equal(f.listeners.size, 0); assert.equal(f.calls.filter(([method]) => method === "detach").length, 1);
});

test("both immutable lease modes capture only the original private delivery option snapshot", async () => {
  for (const mode of ["human", "view"]) {
    let captured;
    const f = fixture({ capture: (tabId, options) => { assert.equal(tabId, 7); captured = options; } });
    const request = { deliveryId: "original-delivery" };
    const pending = mode === "view" ? f.beginView(request) : f.begin(request);
    request.deliveryId = "successor-delivery";
    const handle = await pending;
    assert.deepEqual(captured, { deliveryId: "original-delivery" }); assert.equal(Object.isFrozen(captured), true);
    assert.equal(f.control.current.mode, mode); await handle.close();
    let accessed = false;
    assert.throws(() => f.beginView(Object.defineProperty({}, "deliveryId", { get() { accessed = true; return "hidden"; } })), /invalid input fields/);
    assert.equal(accessed, false); assert.throws(() => f.beginView({ mode: "human" }), /invalid input fields/);
    f.control.assertReleased();
  }
});

for (const boundary of ["capture", "attach", "Performance.enable", "Page.enable", "Page.startScreencast", "Page.screencastFrameAck"]) {
  test(`view authority revoked during ${boundary} waits for its original work and cleans without input`, async () => {
    const pending = defer(), entered = defer(), wait = () => { entered.resolve(); return pending.promise; };
    const f = fixture(boundary.includes(".") ? { command: method => method === boundary ? wait() : undefined } : { [boundary]: wait });
    const beginning = f.beginView(); beginning.catch(() => {}); await entered.promise;
    f.expire(); let finished = false;
    const closing = f.control.revokeView(7).then(() => { finished = true; });
    await tick(); assert.equal(finished, false); assert.equal(f.frames.length, 0);
    assert.throws(() => f.beginView(), /OBU_HUMAN_BUSY/); assert.throws(() => f.begin(), /OBU_HUMAN_BUSY/);
    pending.resolve();
    await assert.rejects(beginning, boundary.startsWith("Page.")
      ? /^Error: Rendered action was cancelled because tab control ended$/ : /expired|revoked/);
    await closing;
    assertViewOnly(f); f.control.assertReleased(); assert.equal(f.listeners.size, 0);
    assert.equal(f.calls.filter(([method]) => method === "detach").length, boundary === "capture" ? 0 : 1);
  });
}

test("view retirement synchronously drops late frames and joins original ACK, stop and detach", async () => {
  const ack = defer(), ackEntered = defer(), stop = defer(), stopEntered = defer(), detach = defer(); let acks = 0;
  const f = fixture({ command: method => {
    if (method === "Page.screencastFrameAck" && ++acks === 2) { ackEntered.resolve(); return ack.promise; }
    if (method === "Page.stopScreencast") { stopEntered.resolve(); return stop.promise; }
  }, detach: () => detach.promise });
  const handle = await f.beginView(); await f.control.revokeView(8);
  assert.equal(handle.info().state, "active");
  f.emit(); await ackEntered.promise;
  const closing = f.control.revokeView(7);
  assert.equal(closing, f.control.revokeView()); assert.equal(closing, handle.close());
  assert.equal(handle.info().state, "releasing");
  f.emit(); await tick(); assert.equal(f.frames.length, 1);
  assert.equal(f.calls.some(([method]) => method === "Page.stopScreencast" || method === "detach"), false);
  assert.throws(() => f.begin(), /OBU_HUMAN_BUSY/);
  ack.resolve(); await stopEntered.promise;
  assert.equal(f.calls.some(([method]) => method === "detach"), false);
  stop.resolve(); await tick(); assert.throws(() => f.beginView(), /OBU_HUMAN_BUSY/);
  detach.resolve(); await closing; assertViewOnly(f); f.control.assertReleased();
  const human = await f.begin();
  await f.control.revokeView(7); assert.equal(human.info().state, "active");
  assert.throws(() => f.control.assertHumanReleased(), /OBU_HUMAN_BUSY/); await human.close();
});

test("view navigation preserves its whole lease and filters old captures before the new document", async () => {
  let starts = 0;
  const f = fixture({ frames: false, command: method => { if (method === "Page.startScreencast") starts++; } });
  const beginning = f.beginView(); await tick(); f.emit(); const handle = await beginning, original = handle.info();
  let closed = false; handle.closed.then(() => { closed = true; });
  f.changeDocument("delivered-B"); f.control.navigation(7, { frameId: 0 }, "committed");
  assert.deepEqual(handle.info(), { ...original, state: "navigating", generation: 2, viewport: null });
  assert.deepEqual(f.states.at(-1), handle.info());
  assert.deepEqual(handle.tabInfo(), { id: 7, title: "页面正在跳转", url: "" });
  await tick(); assert.equal(starts, 2); f.control.assertHumanReleased();
  f.emit(undefined, { deviceWidth: 800, deviceHeight: 600, pageScaleFactor: 1, offsetTop: 0, monotonicTimestamp: 101 });
  await tick(); assert.equal(f.frames.length, 1); assert.equal(handle.info().state, "navigating");
  f.emit(); await f.control.current.recovery;
  assert.equal(handle.info().leaseId, original.leaseId); assert.equal(handle.info().state, "active");
  assert.equal(handle.info().lastInputSequence, 0); assert.equal(closed, false);
  assert.equal(handle.tabInfo().url, "https://fixture.test/delivered-B");
  assert.deepEqual(f.frames.map(frame => [frame.controlMode, frame.viewLeaseId, frame.generation]),
    [["user-view", original.leaseId, 1], ["user-view", original.leaseId, 2]]);
  assert.equal(f.calls.filter(([method]) => method === "attach").length, 1);
  await handle.close(); assertViewOnly(f);
});

test("view revoke during new document preparation waits for that native reply without publishing a successor", async () => {
  const read = defer(), entered = defer(); let reads = 0;
  const f = fixture({ command: method => {
    if (method === "Performance.getMetrics" && ++reads === 2) { entered.resolve(); return read.promise; }
  } }), handle = await f.beginView();
  f.changeDocument(); f.control.navigation(7, { frameId: 0 }, "committed"); await entered.promise;
  let finished = false; const closing = f.control.revokeView().then(() => { finished = true; });
  await tick(); assert.equal(finished, false); assert.equal(f.calls.some(([method]) => method === "detach"), false);
  read.resolve({ metrics: [{ name: "Timestamp", value: 110 }] }); await closing;
  assert.equal(handle.info().state, "released"); assert.equal(f.frames.length, 1);
  assert.equal(f.calls.filter(([method]) => method === "Page.startScreencast").length, 1); assertViewOnly(f);
});

test("unconfirmed view detach blocks Resume and every new lease until real cleanup", async () => {
  let failDetach = true;
  const f = fixture({ detach: () => { if (failDetach) throw new Error("original view detach unconfirmed"); } });
  const handle = await f.beginView(); f.control.assertHumanReleased();
  await assert.rejects(f.control.revokeView(), /original view detach unconfirmed/);
  assert.equal(handle.info().state, "error"); assert.throws(() => f.control.assertHumanReleased(), /OBU_HUMAN_BUSY/);
  assert.throws(() => f.beginView(), /OBU_HUMAN_BUSY/); assert.throws(() => f.begin(), /OBU_HUMAN_BUSY/);
  failDetach = false; await f.control.revokeView(); f.control.assertHumanReleased(); f.control.assertReleased(); assertViewOnly(f);
});

test("a failed view begin exposes its unconfirmed cleanup barrier without human input risk", async () => {
  const ready = defer(), entered = defer(); let failDetach = true;
  const f = fixture({ command: method => {
    if (method === "Performance.enable") { entered.resolve(); return ready.promise; }
  }, detach: () => { if (failDetach) throw new Error("original view detach unconfirmed"); } });
  const beginning = f.beginView(); beginning.catch(() => {}); await entered.promise; f.expire(); ready.resolve();
  await assert.rejects(beginning, error => error.viewerCleanupIncomplete === true && !error.humanCleanupIncomplete);
  assert.throws(() => f.control.assertHumanReleased(), /OBU_HUMAN_BUSY/);
  failDetach = false; await f.control.revokeView(); f.control.assertReleased(); assertViewOnly(f);
});

test("external view debugger loss remains unknown until original target destruction is confirmed", async () => {
  const f = fixture(), handle = await f.beginView();
  assert.equal(f.control.observeDetach({ targetId: "original-target" }, "canceled_by_user"), true);
  await assert.rejects(handle.close(), /did not confirm/);
  assert.throws(() => f.control.assertHumanReleased(), /OBU_HUMAN_BUSY/);
  assert.equal(f.calls.some(([method]) => method === "detach"), false);
  f.control.invalidateTab(7, { destroyed: true }); await handle.close();
  f.control.assertReleased(); f.control.assertHumanReleased(); assertViewOnly(f);
});

test("viewing a zoomed or offset page never acquires the human CSS input restrictions", async () => {
  for (const metadata of [
    { deviceWidth: 900, deviceHeight: 700, pageScaleFactor: 2, offsetTop: 25 },
    { deviceWidth: 600, deviceHeight: 400, pageScaleFactor: 0.75, offsetTop: -1 },
    { deviceWidth: 800, deviceHeight: 600 }
  ]) {
    const f = fixture({ metadata, command: method => {
      if (method === "Page.getLayoutMetrics") assert.fail("view must not obtain an input coordinate proof");
    } }), handle = await f.beginView();
    assert.equal(handle.info().state, "active");
    assert.deepEqual(handle.info().viewport, { width: metadata.deviceWidth, height: metadata.deviceHeight });
    assert.equal(f.frames.length, 1); assert.equal(handle.input, undefined);
    await handle.close(); assertViewOnly(f);
  }
});

test("view surface bounds still reject invalid images and perform real cleanup", async () => {
  for (const change of [{ deviceWidth: 0 }, { deviceHeight: Infinity }, { deviceWidth: 16385 }]) {
    const f = fixture({ metadata: { deviceWidth: 800, deviceHeight: 600, ...change } });
    await assert.rejects(f.beginView(), /revoked|cancelled because tab control ended|OBU_HUMAN_GEOMETRY/);
    assert.equal(f.frames.length, 0); f.control.assertReleased(); assertViewOnly(f);
    for (const method of ["Page.screencastFrameAck", "Page.stopScreencast", "detach"])
      assert.equal(f.calls.filter(([name]) => name === method).length, 1, method);
  }
});

test("a native view resize retires the old frame and waits for actual ACK and stop before a new capture", async () => {
  const ack = defer(), ackEntered = defer(), stop = defer(), stopEntered = defer(); let acks = 0, barriers = 0;
  const f = fixture({ frames: false, command: method => {
    if (method === "Performance.getMetrics") return { metrics: [{ name: "Timestamp", value: ++barriers * 100 }] };
    if (method === "Page.screencastFrameAck" && ++acks === 2) { ackEntered.resolve(); return ack.promise; }
    if (method === "Page.stopScreencast" && barriers === 1) { stopEntered.resolve(); return stop.promise; }
  } });
  const beginning = f.beginView(); await tick(); f.emit(); const handle = await beginning, original = handle.info();
  let closed = false; handle.closed.then(() => { closed = true; });
  f.emit(); await ackEntered.promise; resize(f);
  assert.deepEqual(handle.info(), { ...original, state: "navigating", generation: 2, viewport: null });
  await tick(); assert.equal(f.calls.some(([method]) => method === "Page.stopScreencast"), false);
  ack.resolve(); await stopEntered.promise;
  assert.equal(f.frames.length, 1); assert.equal(f.calls.filter(([method]) => method === "Page.startScreencast").length, 1);
  stop.resolve(); await tick(); assert.equal(barriers, 2);
  const metadata = { deviceWidth: 640, deviceHeight: 480, pageScaleFactor: 2, offsetTop: 20 };
  f.emit(undefined, { ...metadata, monotonicTimestamp: 150 }); await tick();
  assert.equal(f.frames.length, 1); assert.equal(handle.info().state, "navigating");
  f.emit(undefined, { ...metadata, monotonicTimestamp: 201 }); await f.control.current.recovery;
  assert.equal(handle.info().leaseId, original.leaseId); assert.equal(handle.info().state, "active");
  assert.deepEqual(handle.info().viewport, { width: 640, height: 480 }); assert.equal(handle.info().generation, 2);
  assert.deepEqual(f.frames.map(frame => frame.generation), [1, 2]); assert.equal(closed, false);
  assert.equal(f.calls.filter(([method]) => method === "attach").length, 1);
  await handle.close(); assertViewOnly(f);
});

test("a changed view frame surface starts a verified generation without reusing that triggering encoding", async () => {
  let barriers = 0;
  const f = fixture({ frames: false, command: method => method === "Performance.getMetrics" ? { metrics: [{ name: "Timestamp", value: ++barriers * 100 }] } : undefined });
  const beginning = f.beginView(); await tick(); f.emit(); const handle = await beginning;
  const resized = { deviceWidth: 960, deviceHeight: 720, pageScaleFactor: 1.5, offsetTop: 10 };
  f.emit(undefined, { ...resized, monotonicTimestamp: 150 }); await tick();
  assert.equal(handle.info().state, "navigating"); assert.equal(handle.info().generation, 2);
  assert.equal(f.frames.length, 1); assert.equal(barriers, 2);
  f.emit(undefined, { ...resized, monotonicTimestamp: 150 }); await tick(); assert.equal(f.frames.length, 1);
  f.emit(undefined, { ...resized, monotonicTimestamp: 201 }); await f.control.current.recovery;
  assert.equal(handle.info().state, "active"); assert.deepEqual(handle.info().viewport, { width: 960, height: 720 });
  assert.equal(f.frames.at(-1).metadata.monotonicTimestamp, 201);
  assert.equal(f.calls.filter(([method]) => method === "Page.startScreencast").length, 2);
  await handle.close(); assertViewOnly(f);
});

test("ending a view during resize preparation joins the original native reply and cannot publish late geometry", async () => {
  const reading = defer(), entered = defer(); let barriers = 0;
  const f = fixture({ command: method => {
    if (method === "Performance.getMetrics" && ++barriers === 2) { entered.resolve(); return reading.promise; }
  } }), handle = await f.beginView();
  resize(f); await entered.promise;
  let closed = false; const closing = f.control.revokeView().then(() => { closed = true; });
  await tick(); assert.equal(closed, false); assert.equal(f.calls.some(([method]) => method === "detach"), false);
  reading.resolve({ metrics: [{ name: "Timestamp", value: 200 }] }); await closing;
  assert.equal(handle.info().state, "released"); assert.equal(f.frames.length, 1);
  assert.equal(f.calls.filter(([method]) => method === "Page.startScreencast").length, 1); assertViewOnly(f);
});
