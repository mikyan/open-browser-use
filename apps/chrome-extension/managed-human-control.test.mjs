import assert from "node:assert/strict";
import test from "node:test";
import { ManagedHumanControl } from "./managed-human-control.js";

const defer = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function manualTiming() {
  let time = 0, id = 0; const timers = new Map();
  return { now: () => time, skip: ms => { time += ms; }, setTimer: (fn, ms) => { const key = ++id; timers.set(key, { fn, at: time + ms }); return key; }, clearTimer: key => timers.delete(key),
    advance: ms => { const end = time + ms; while (true) {
      const entry = [...timers].filter(([, value]) => value.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!entry) break; timers.delete(entry[0]); time = entry[1].at; entry[1].fn();
    } time = end; }, timers };
}
function fixture(options = {}) {
  const calls = [], frames = [], states = [], listeners = new Set(), risks = new Set();
  let paused = false, authorized = true, documentId = "original-document", loaderId = "loader-1", clock = 100, navigationVersion = 0;
  const documentURL = () => options.documentURL ?? "https://fixture.test/" + documentId;
  const emit = (source = { targetId: "original-target" }, metadata = options.metadata ?? { deviceWidth: 800, deviceHeight: 600, pageScaleFactor: 1, offsetTop: 0 }) => {
    for (const listener of [...listeners]) listener(source, "Page.screencastFrame", { data: "cGl4ZWxz", metadata: options.nativeMetadata ?? { monotonicTimestamp: clock + 1, ...metadata }, sessionId: 42 });
  };
  const chrome = { debugger: {
    onEvent: { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) },
    async attach(target) { calls.push(["attach", target]); await options.attach?.(); },
    async detach(target) { calls.push(["detach", target]); await options.detach?.(); },
    async sendCommand(target, method, params) {
      calls.push([method, target, params]);
      const result = await options.command?.(method, params, target);
      if (method === "Page.startScreencast" && options.frames !== false) queueMicrotask(emit);
      if (result !== undefined) return result;
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "root", loaderId, url: documentURL() } } };
      if (method === "Performance.getMetrics") return { metrics: [{ name: "Timestamp", value: clock }] };
      return method === "Page.getLayoutMetrics" ? { cssVisualViewport: { clientWidth: 800, clientHeight: 600, scale: 1, zoom: 1, offsetX: 0, offsetY: 0 } } : {};
    }
  } };
  const control = new ManagedHumanControl({ chrome,
    capture: async (tabId, captureOptions) => { calls.push(["capture"]); await options.capture?.(tabId, captureOptions); return { tabId, targetId: "original-target", documentId, navigationVersion, title: `Title ${documentId}`, url: documentURL() }; },
    validate: async (candidate, { advance = false } = {}) => { if (!advance) assert.equal(candidate.documentId, documentId); await options.validate?.(candidate, { advance }); return { ...candidate, documentId, navigationVersion, title: `Title ${documentId}`, url: documentURL() }; },
    validateSameDocument: async (candidate, { inspect, retain }) => {
      inspect(); await retain(options.validateSameDocument?.(candidate)); inspect();
      assert.equal(candidate.documentId, documentId); assert.equal(candidate.url, documentURL());
      return { ...candidate, navigationVersion };
    },
    pause: async reservation => { calls.push(["pause", reservation.leaseId]); await options.pause?.(reservation); paused = true; },
    assertPaused: () => { assert.equal(paused, true); },
    assertDialog: (candidate, origins) => options.assertDialog?.(candidate, origins),
    markRisk: async id => { risks.add(id); await options.markRisk?.(); }, clearRisk: async id => { await options.clearRisk?.(); risks.delete(id); },
    viewJournal: options.viewJournal,
    clipboardTransfer: options.clipboardTransfer,
    timing: options.timing,
    onFailure: error => calls.push(["failure", error.message])
  });
  const authority = () => { if (!authorized) throw new Error("lease expired"); };
  const beginAdmitted = (request = {}) => control.begin(7, authority, frame => frames.push(frame), state => states.push(state), request);
  // Most input/lifecycle cases require a displayed page. Keep that explicit
  // test setup separate from the public two-stage Begin admission below.
  const begin = (request = {}) => {
    const admitted = beginAdmitted(request), original = control.current;
    return admitted.then(async handle => {
      try { await original.start; return handle; }
      catch (error) { await handle.close(); throw error; }
    });
  };
  const beginView = (request = {}) => control.beginView(7, authority, frame => frames.push(frame), state => states.push(state), request);
  return { control, chrome, calls, frames, states, risks, emit, listeners, begin, beginAdmitted, beginView,
    changeDocument: (id = "next-document") => { documentId = id; loaderId = "loader-" + id; clock += 10; navigationVersion++; },
    event: (method, params = {}, source = { targetId: "original-target" }) => { for (const listener of [...listeners]) listener(source, method, params); },
    expire: () => { authorized = false; } };
}
const input = (handle, value, extra = {}) => {
  const info = handle.info();
  return handle.input({ leaseId: info.leaseId, generation: info.generation, sequence: info.lastInputSequence + 1, input: value, ...extra });
};

test("human pointer click counts advertise native capability and preserve each original ACK", async t => {
  const f = fixture(), handle = await f.begin(); t.after(() => handle.close());
  assert.equal(handle.info().pointerClickCountVersion, 1);
  for (const clickCount of [undefined, 1, 2, 3, 2147483647]) {
    for (const action of ["down", "up"]) {
      const before = handle.info(), request = { type: "pointer", action, x: 12, y: 34, button: "left",
        ...(clickCount === undefined ? {} : { clickCount }) };
      assert.deepEqual(await input(handle, request), { leaseId: before.leaseId, generation: before.generation,
        sequence: before.lastInputSequence + 1, acknowledged: true });
      assert.equal(f.calls.filter(([method]) => method === "Input.dispatchMouseEvent").at(-1)[2].clickCount, clickCount ?? 1);
    }
  }
  await handle.close();
  const view = await f.beginView(); t.after(() => view.close());
  assert.equal(Object.hasOwn(view.info(), "pointerClickCountVersion"), false);
});

test("human pointer click counts reject malformed values and foreign input kinds before native input", async t => {
  const f = fixture(), handle = await f.begin(); t.after(() => handle.close());
  for (const clickCount of [null, 0, -1, 1.5, NaN, Infinity, true, "2", 2147483648, {}, []]) {
    await assert.rejects(input(handle, { type: "pointer", action: "down", x: 1, y: 1, button: "left", clickCount }), /INVALID/);
  }
  for (const request of [{ type: "pointer", action: "move", x: 1, y: 1 }, { type: "text", text: "x" },
    { type: "wheel", x: 1, y: 1, deltaX: 0, deltaY: 1 }])
    await assert.rejects(input(handle, { ...request, clickCount: 1 }), /INVALID/);
  assert.equal(f.calls.some(([method]) => method.startsWith("Input.")), false);
});

test("human pointer up uses the same ACKed button count and mismatches do not consume the hold", async t => {
  const f = fixture(), handle = await f.begin(); t.after(() => handle.close());
  const point = { type: "pointer", x: 1, y: 2, button: "left" };
  await input(handle, { ...point, action: "down", clickCount: 2 });
  for (const clickCount of [undefined, 1, 3]) {
    await assert.rejects(input(handle, { ...point, action: "up", ...(clickCount === undefined ? {} : { clickCount }) }), /count.*match|match.*count/);
  }
  assert.equal(handle.info().lastInputSequence, 1);
  assert.equal(f.calls.filter(([method]) => method === "Input.dispatchMouseEvent").length, 1);
  await input(handle, { ...point, action: "up", clickCount: 2 });
  await input(handle, { ...point, action: "down" });
  await input(handle, { ...point, action: "up" });
  assert.deepEqual(f.calls.filter(([method]) => method === "Input.dispatchMouseEvent").map(([, , params]) => params.clickCount), [2, 2, 1, 1]);
});

for (const retiring of ["End", "navigation", "unknown-ACK"]) test(`human multi-click ${retiring} keeps actual down and existing zero-count cleanup`, async t => {
  const pending = defer(), entered = defer(), released = defer(), releaseEntered = defer();
  let first = true;
  const f = fixture({ command(method, params) {
    if (method !== "Input.dispatchMouseEvent") return;
    if (params.type === "mousePressed" && first) { first = false; entered.resolve(); return pending.promise; }
    if (params.type === "mouseReleased" && params.clickCount === 0) { releaseEntered.resolve(); return released.promise; }
  } }), handle = await f.begin(), original = handle.info();
  t.after(async () => { pending.resolve(); released.resolve(); await handle.close(); });
  const request = { type: "pointer", action: "down", button: "left", x: 5, y: 6, clickCount: 3 };
  const sending = input(handle, request); sending.catch(() => {});
  // A legacy source rejects the new field synchronously, so the red run must
  // terminate with that original error rather than wait forever at the gate.
  await Promise.race([entered.promise, sending]);
  await assert.rejects(input(handle, { ...request, action: "up" }), /BUSY/);
  let closing;
  if (retiring === "End") closing = handle.close();
  if (retiring === "navigation") { f.changeDocument(); f.control.navigation(7, { frameId: 0 }, "committed"); }
  await tick();
  assert.equal(f.calls.some(([method, , params]) => method === "Input.dispatchMouseEvent" && params.type === "mouseReleased"), false);
  if (retiring === "unknown-ACK") pending.reject(new Error("original down acknowledgement unknown"));
  else pending.resolve();
  if (retiring === "unknown-ACK") await assert.rejects(sending, /acknowledgement unknown/);
  else assert.deepEqual(await sending, { leaseId: original.leaseId, generation: original.generation, sequence: 1, acknowledged: true });
  await releaseEntered.promise;
  assert.equal(f.calls.filter(([method, , params]) => method === "Input.dispatchMouseEvent" && params.type === "mousePressed").length, 1);
  released.resolve();
  if (retiring === "navigation") {
    await f.control.current.recovery;
    await assert.rejects(input(handle, { ...request, action: "up" }), /hold does not match/);
    await input(handle, { ...request, clickCount: 1 });
    await input(handle, { ...request, action: "up", clickCount: 1 });
  } else await (closing ?? handle.close());
  assert.equal(f.calls.filter(([method, , params]) => method === "Input.dispatchMouseEvent" && params.type === "mouseReleased" && params.clickCount === 0).length, 1);
});

const clipboardKey = (operation = "copy", extra = {}) => ({ type: "key", action: "down",
  key: operation === "copy" ? "c" : "x", code: operation === "copy" ? "KeyC" : "KeyX",
  windowsVirtualKeyCode: operation === "copy" ? 67 : 88, modifiers: 2, clipboardTransfer: operation, ...extra });
const clipboardKeyUp = operation => {
  const { clipboardTransfer, ...key } = clipboardKey(operation, { action: "up" }); return key;
};

test("human file chooser intercepts the original attachment and advertises only human capability", async () => {
  const f = fixture(), handle = await f.begin();
  try {
    assert.equal(handle.info().fileChooserVersion, 1);
    assert.equal(f.calls.filter(([method, target, params]) => method === "Page.setInterceptFileChooserDialog" &&
      target.targetId === "original-target" && !target.sessionId && params.enabled === true).length, 1);
    assert.equal(handle.pendingFileChooser(), null);
  } finally { await handle.close(); }
  const view = await f.beginView();
  try { assert.equal(Object.hasOwn(view.info(), "fileChooserVersion"), false); }
  finally { await view.close(); }
});

function fileChooserFixture(options = {}) {
  let f, attached = false; const tokens = new Map();
  f = fixture({ ...options, command: async (method, params, target) => {
    const custom = await options.command?.(method, params, target, f);
    if (custom !== undefined) return custom;
    if (method === "Runtime.enable") f.event("Runtime.executionContextCreated", { context: {
      id: 1, uniqueId: target.sessionId ? "child-context" : "root-context",
      origin: target.sessionId ? "https://child.test" : "https://fixture.test",
      auxData: { isDefault: true, frameId: target.sessionId ? "child-frame" : "root" }
    } }, target);
    if (options.child && method === "Target.setAutoAttach" && !target.sessionId && !attached) {
      attached = true;
      f.event("Target.attachedToTarget", { sessionId: "child-session", targetInfo: { targetId: "child-frame", type: "iframe" } });
    }
    if (target.sessionId && method === "Page.getFrameTree") return { frameTree: { frame: {
      id: "child-frame", parentId: "root", loaderId: "child-loader", url: "https://child.test/input"
    } } };
    if (method === "Page.createIsolatedWorld") return { executionContextId: 55 };
    if (method === "DOM.resolveNode") return { object: { objectId: "node-" + params.backendNodeId } };
    if (method === "Runtime.callFunctionOn") {
      if (params.functionDeclaration.includes("__openBrowserUseDirectoryUploadGuardsV1")) {
        const objectId = "guard-" + params.objectId; tokens.set(objectId, params.arguments[0].value);
        return { result: { objectId } };
      }
      const token = tokens.get(params.objectId);
      if (params.functionDeclaration.includes("this.describe")) return { result: { value: { token, directory: options.directory ?? false, multiple: options.multiple ?? false } } };
      if (params.functionDeclaration.includes("this.begin")) return { result: { value: { token, phase: "ordinary-dispatched" } } };
      if (params.functionDeclaration.includes("this.cleanup")) return { result: { value: { token, removed: true } } };
    }
  } });
  f.openChooser = async (override = {}, source = options.child ? { targetId: "original-target", sessionId: "child-session" } : { targetId: "original-target" }) => {
    f.event("Page.fileChooserOpened", { frameId: options.child ? "child-frame" : "root", backendNodeId: 9,
      mode: options.multiple ? "selectMultiple" : "selectSingle", ...override }, source);
    for (let n = 0; n < 20 && !f.control.current?.fileChoosers.info(); n++) await tick();
  };
  return f;
}
const fileTuple = (handle, transferId = "original-transfer") => {
  const { leaseId, generation, chooserId } = handle.pendingFileChooser();
  return { leaseId, generation, chooserId, transferId };
};

for (const child of [false, true]) test(`human file chooser original ${child ? "OOPIF" : "root"} node and source owns exactly one native submission`, async () => {
  const f = fileChooserFixture({ child }), handle = await f.begin();
  try {
    await f.openChooser();
    assert.deepEqual(handle.pendingFileChooser().source, { origin: child ? "https://child.test" : "https://fixture.test",
      frame: child ? "child" : "top-level" });
    const request = fileTuple(handle);
    assert.deepEqual(await handle.beginFile(request), request);
    await assert.rejects(async () => handle.beginFile(request), /FILE_STALE/);
    const receipt = await handle.commitFile({ ...request, files: ["C:\\private-staging\\hello.txt"] });
    assert.deepEqual(receipt, { ...request, acknowledged: true });
    assert.equal(handle.pendingFileChooser(), null);
    const writes = f.calls.filter(([method]) => method === "DOM.setFileInputFiles");
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0].slice(1), [{ targetId: "original-target", ...(child ? { sessionId: "child-session" } : {}) },
      { backendNodeId: 9, files: ["C:\\private-staging\\hello.txt"] }]);
    await assert.rejects(async () => handle.commitFile({ ...request, files: ["C:\\private-staging\\hello.txt"] }), /FILE_STALE/);
    assert.equal(f.calls.some(([method, , params]) => method === "DOM.setFileInputFiles" && params.files.length === 0), false);
  } finally { await handle.close(); }
  assert.equal(f.calls.filter(([method, , params]) => method === "Page.setInterceptFileChooserDialog" && params.enabled === false).length, child ? 2 : 1);
});

test("pending chooser admits only original held up ACKs before claim and never synthesizes release", async () => {
  const f = fileChooserFixture(), handle = await f.begin();
  const key = { type: "key", action: "down", key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17, modifiers: 2 };
  try {
    await input(handle, key);
    await input(handle, { type: "pointer", action: "down", button: "left", x: 5, y: 6, modifiers: 2 });
    await f.openChooser();
    const request = fileTuple(handle);
    await assert.rejects(async () => handle.beginFile(request), /FILE_BUSY/);
    for (const value of [{ type: "text", text: "unrelated" }, { type: "pointer", action: "move", x: 1, y: 2 },
      { ...key, repeat: true }]) await assert.rejects(input(handle, value), /FILE_BUSY/);
    assert.equal((await input(handle, { ...key, action: "up", modifiers: 0 })).acknowledged, true);
    assert.equal((await input(handle, { type: "pointer", action: "up", button: "left", x: 5, y: 6 })).acknowledged, true);
    assert.deepEqual(await handle.beginFile(request), request);
    const { transferId, ...withoutTransfer } = request;
    assert.deepEqual(await handle.cancelFile(withoutTransfer), { ...withoutTransfer, cancelled: true });
    assert.equal(f.calls.filter(([method]) => method === "Input.dispatchKeyEvent").length, 2);
    assert.equal(f.calls.filter(([method]) => method === "Input.dispatchMouseEvent").length, 2);
    assert.equal(f.calls.some(([method]) => method === "DOM.setFileInputFiles"), false);
  } finally { await handle.close(); }
});

test("End joins the original file write ACK, returns its old tuple and never replays it", async () => {
  const ack = defer(), dispatched = defer();
  const f = fileChooserFixture({ command: (method) => {
    if (method === "DOM.setFileInputFiles") { dispatched.resolve(); return ack.promise; }
  } }), handle = await f.begin();
  await f.openChooser(); const request = fileTuple(handle); await handle.beginFile(request);
  const write = handle.commitFile({ ...request, files: ["C:\\staging\\original.txt"] });
  await dispatched.promise;
  let ended = false; const closing = handle.close().then(() => { ended = true; });
  await tick(); assert.equal(ended, false);
  assert.equal(f.calls.some(([method]) => method === "detach"), false);
  ack.resolve({});
  assert.deepEqual(await write, { ...request, acknowledged: true });
  await closing;
  assert.equal(f.calls.filter(([method]) => method === "DOM.setFileInputFiles").length, 1);
});

test("retired OOPIF document cannot submit the original node even with a matching frame and replacement context", async () => {
  const f = fileChooserFixture({ child: true }), handle = await f.begin();
  try {
    await f.openChooser(); const request = fileTuple(handle); await handle.beginFile(request);
    f.event("Runtime.executionContextCreated", { context: { id: 1, uniqueId: "replacement", origin: "https://child.test",
      auxData: { isDefault: true, frameId: "child-frame" } } }, { targetId: "original-target", sessionId: "child-session" });
    assert.equal(handle.pendingFileChooser(), null);
    await assert.rejects(async () => handle.commitFile({ ...request, files: ["C:\\staging\\old.txt"] }), /FILE_STALE/);
    assert.equal(f.calls.some(([method]) => method === "DOM.setFileInputFiles"), false);
  } finally { await handle.close(); }
});

test("unknown original native file ACK fails once and retains cleanup without empty submission", async () => {
  const f = fileChooserFixture({ command: method => { if (method === "DOM.setFileInputFiles") throw new Error("native outcome unknown"); } });
  const handle = await f.begin();
  await f.openChooser(); const request = fileTuple(handle); await handle.beginFile(request);
  await assert.rejects(handle.commitFile({ ...request, files: ["C:\\staging\\one.txt"] }), /native outcome unknown/);
  await handle.close();
  assert.equal(f.calls.filter(([method]) => method === "DOM.setFileInputFiles").length, 1);
});

test("parent commit withdraws a child chooser but still cleans its original live remote objects", async () => {
  const cleanup = defer(), cleanupEntered = defer();
  const f = fileChooserFixture({ child: true, command: (method, params) => {
    if (method === "Runtime.callFunctionOn" && params.functionDeclaration.includes("this.cleanup")) {
      cleanupEntered.resolve(); return cleanup.promise;
    }
  } }), handle = await f.begin();
  await f.openChooser(); const request = fileTuple(handle); await handle.beginFile(request);
  const graph = f.control.current.documentGraph;
  // Isolate the precise graph invalidation from navigation recovery: parent
  // authority retires the child proof without any child Runtime destruction.
  graph.observe(undefined, "Page.frameNavigated", { frame: { id: "root", loaderId: "new-parent", url: "https://fixture.test/new" } });
  f.control.current.fileChoosers.recheck();
  await cleanupEntered.promise;
  assert.equal(handle.pendingFileChooser(), null);
  assert.equal(f.calls.find(([method, , params]) => method === "Runtime.callFunctionOn" && params.functionDeclaration.includes("this.cleanup"))[1].sessionId, "child-session");
  let ended = false; const closing = handle.close().then(() => { ended = true; });
  await tick(); assert.equal(ended, false);
  const guard = f.control.current.fileChoosers.registry.records.values().next().value;
  cleanup.resolve({ result: { value: { token: guard.token, removed: true } } });
  await closing; assert.equal(ended, true);
  assert.equal(f.calls.some(([method]) => method === "DOM.setFileInputFiles"), false);
});

test("exact child context destruction joins the old file ACK without sending cleanup to a replacement", async () => {
  const ack = defer(), entered = defer();
  const f = fileChooserFixture({ child: true, command: method => {
    if (method === "DOM.setFileInputFiles") { entered.resolve(); return ack.promise; }
  } }), handle = await f.begin();
  await f.openChooser(); const request = fileTuple(handle); await handle.beginFile(request);
  const commit = handle.commitFile({ ...request, files: ["C:\\server\\original.txt"] }); await entered.promise;
  f.event("Runtime.executionContextDestroyed", { executionContextId: 1, executionContextUniqueId: "child-context" },
    { targetId: "original-target", sessionId: "child-session" });
  let ended = false; const closing = handle.close().then(() => { ended = true; });
  await tick(); assert.equal(ended, false);
  ack.resolve({});
  assert.deepEqual(await commit, { ...request, acknowledged: true });
  await closing;
  assert.equal(f.calls.some(([method, , params]) => method === "Runtime.callFunctionOn" && params.functionDeclaration.includes("this.cleanup")), false);
  assert.equal(f.calls.filter(([method]) => method === "DOM.setFileInputFiles").length, 1);
});

for (const child of [false, true]) test(`destroyed original ${child ? "child" : "root"} file cleanup rejection does not revoke the live attachment`, async () => {
  const cleanup = defer(), entered = defer();
  const f = fileChooserFixture({ child, command: (method, params) => {
    if (method === "Runtime.callFunctionOn" && params.functionDeclaration.includes("this.cleanup")) {
      entered.resolve(); return cleanup.promise;
    }
  } }), handle = await f.begin();
  await f.openChooser(); await handle.beginFile(fileTuple(handle));
  const record = f.control.current;
  // Conservative parent retirement starts cleanup while the old renderer is
  // still alive. A later native destruction is independent resource evidence.
  record.documentGraph.observe(undefined, "Page.frameNavigated",
    { frame: { id: "root", loaderId: "new-parent", url: "https://fixture.test/new" } });
  record.fileChoosers.recheck(); await entered.promise;
  let drained = false;
  const draining = record.fileChoosers.drain().then(() => { drained = true; });
  if (child) f.event("Runtime.executionContextDestroyed",
    { executionContextId: 1, executionContextUniqueId: "child-context" },
    { targetId: "original-target", sessionId: "child-session" });
  else f.event("Runtime.executionContextsCleared");
  await tick();
  assert.equal(drained, false, "Destruction must not invent settlement of the original native Promise");
  cleanup.reject(new Error("arbitrary native cleanup rejection, not a text-based exception"));
  await draining; await tick();
  assert.equal(record.revoked, undefined, "A destroyed original cleanup resource cannot retire the live attachment");
  assert.equal(f.calls.filter(([method]) => method === "detach").length, 0);
  assert.equal(f.calls.filter(([method]) => method === "DOM.setFileInputFiles").length, 0);
  assert.equal(f.calls.filter(([method]) => method === "Runtime.releaseObject").length, 0);
  await handle.close();
});

test("destroyed original file object release keeps its actual rejection drain without revoking the attachment", async () => {
  const release = defer(), entered = defer();
  const f = fileChooserFixture({ command: (method) => {
    if (method === "Runtime.releaseObject") { entered.resolve(); return release.promise; }
  } }), handle = await f.begin();
  await f.openChooser(); const request = fileTuple(handle); await handle.beginFile(request);
  const record = f.control.current, cancellation = handle.cancelFile(request);
  await entered.promise;
  f.event("Runtime.executionContextsCleared");
  let settled = false; const draining = record.fileChoosers.drain().then(() => { settled = true; });
  await tick(); assert.equal(settled, false);
  release.reject(new Error("original release failed after destruction"));
  await cancellation; await draining; await tick();
  assert.equal(record.revoked, undefined);
  assert.equal(f.calls.filter(([method]) => method === "Runtime.releaseObject").length, 1);
  await handle.close();
});

for (const detach of [false, true]) test(`file cleanup rejection without document destruction remains fatal, detach=${detach}`, async () => {
  const cleanup = defer(), entered = defer();
  const f = fileChooserFixture({ child: true, command: (method, params) => {
    if (method === "Runtime.callFunctionOn" && params.functionDeclaration.includes("this.cleanup")) {
      entered.resolve(); return cleanup.promise;
    }
  } }), handle = await f.begin();
  await f.openChooser(); await handle.beginFile(fileTuple(handle));
  const record = f.control.current;
  record.documentGraph.observe(undefined, "Page.frameNavigated",
    { frame: { id: "root", loaderId: "new-parent", url: "https://fixture.test/new" } });
  record.fileChoosers.recheck(); await entered.promise;
  if (detach) f.event("Target.detachedFromTarget", { sessionId: "child-session", targetId: "child-frame" });
  cleanup.reject(new Error("Cannot find context with specified id"));
  await tick(); await tick();
  assert.equal(record.revoked, true, "Matching error text and parent/session retirement cannot prove document destruction");
  if (!detach) f.event("Runtime.executionContextDestroyed", { executionContextId: 1, executionContextUniqueId: "child-context" },
    { targetId: "original-target", sessionId: "child-session" });
  await tick(); await handle.close();
});

test("native file submission rejection remains fatal even after original context destruction", async () => {
  const write = defer(), entered = defer();
  const f = fileChooserFixture({ command: method => {
    if (method === "DOM.setFileInputFiles") { entered.resolve(); return write.promise; }
  } }), handle = await f.begin();
  await f.openChooser(); const request = fileTuple(handle); await handle.beginFile(request);
  const record = f.control.current, commit = handle.commitFile({ ...request, files: ["C:\\server\\original.txt"] });
  await entered.promise; f.event("Runtime.executionContextsCleared");
  const error = new Error("original business ACK unknown"); write.reject(error);
  await assert.rejects(commit, error); await tick();
  assert.equal(record.revoked, true); await handle.close();
  assert.equal(f.calls.filter(([method]) => method === "DOM.setFileInputFiles").length, 1);
});

test("End during original file guard preparation joins the late object then cleans it once", async () => {
  const install = defer(), entered = defer(); let originalToken;
  const f = fileChooserFixture({ command: (method, params) => {
    if (method === "Runtime.callFunctionOn" && params.functionDeclaration.includes("__openBrowserUseDirectoryUploadGuardsV1")) {
      originalToken = params.arguments[0].value; entered.resolve(); return install.promise;
    }
    if (method === "Runtime.callFunctionOn" && params.functionDeclaration.includes("this.cleanup"))
      return { result: { value: { token: originalToken, removed: true } } };
  } }), handle = await f.begin();
  f.event("Page.fileChooserOpened", { frameId: "root", backendNodeId: 9, mode: "selectSingle" });
  await entered.promise;
  let ended = false; const closing = handle.close().then(() => { ended = true; });
  await tick(); assert.equal(ended, false); assert.equal(handle.pendingFileChooser(), null);
  install.resolve({ result: { objectId: "late-original-guard" } });
  await closing;
  assert.equal(f.calls.filter(([method, , params]) => method === "Runtime.callFunctionOn" &&
    params.objectId === "late-original-guard" && params.functionDeclaration.includes("this.cleanup")).length, 1);
  assert.equal(f.calls.some(([method]) => method === "DOM.setFileInputFiles"), false);
});

test("End during original interception enable waits its ACK before disabling the same attachment", async () => {
  const enable = defer(), entered = defer();
  const f = fixture({ command: (method, params) => {
    if (method === "Page.setInterceptFileChooserDialog" && params.enabled) { entered.resolve(); return enable.promise; }
  } });
  const handle = await f.beginAdmitted(); await entered.promise;
  let closed = false; const closing = handle.close().then(() => { closed = true; });
  await tick(); assert.equal(closed, false);
  assert.equal(f.calls.some(([method, , params]) => method === "Page.setInterceptFileChooserDialog" && !params.enabled), false);
  enable.resolve({}); await closing;
  assert.deepEqual(f.calls.filter(([method]) => method === "Page.setInterceptFileChooserDialog").map(([, target, params]) => [target, params]),
    [[{ targetId: "original-target" }, { enabled: true }], [{ targetId: "original-target" }, { enabled: false }]]);
});

test("clipboard capability belongs to the original human lease, never a view", async () => {
  const f = fixture({ clipboardTransfer: async () => assert.fail("no clipboard action during Begin") });
  const handle = await f.begin();
  assert.equal(handle.info().clipboardTransferVersion, 1);
  assert.ok(f.states.every(state => state.clipboardTransferVersion === 1));
  await handle.close();
  const view = await f.beginView();
  assert.equal(Object.hasOwn(view.info(), "clipboardTransferVersion"), false);
  await view.close();
});

for (const operation of ["copy", "cut"]) test(`original ${operation} ACK survives collection failure and accepts its real key up`, async () => {
  let dispatches = 0;
  const f = fixture({ clipboardTransfer: async (scope, requested, { check, dispatch }) => {
    assert.equal(scope.kind, "human"); assert.equal(scope.tabId, 7); assert.equal(requested, operation);
    check(); await dispatch(); dispatches++;
    throw new Error("OBU_CLIPBOARD_CHANGED: original item changed during read");
  } });
  const handle = await f.begin(), receipt = await input(handle, clipboardKey(operation));
  assert.equal(receipt.acknowledged, true);
  assert.deepEqual(receipt.clipboardTransfer, { operation, status: "failed", code: "CHANGED" });
  assert.equal((await input(handle, clipboardKeyUp(operation))).acknowledged, true);
  assert.equal(dispatches, 1);
  assert.equal(f.calls.filter(([method]) => method === "Input.dispatchKeyEvent").length, 2);
  await handle.close();
});

test("clipboard timeout retains the original read but does not block the acknowledged key release", async () => {
  const timing = manualTiming(), read = defer(), ack = defer();
  const f = fixture({ timing, clipboardTransfer: async (_scope, operation, { check, dispatch }) => {
    await dispatch(); ack.resolve(); await read.promise; check();
    return { operation, status: "ready", text: "late private text" };
  } });
  const handle = await f.begin(), transfer = input(handle, clipboardKey("cut"));
  await ack.promise; timing.advance(3000);
  const result = await transfer;
  assert.equal(result.acknowledged, true);
  assert.deepEqual(result.clipboardTransfer, { operation: "cut", status: "failed", code: "TIMEOUT" });
  assert.equal((await input(handle, clipboardKeyUp("cut"))).acknowledged, true);
  let closed = false;
  const closing = handle.close().then(() => { closed = true; });
  await tick(); assert.equal(closed, false);
  assert.equal(f.calls.some(([method]) => method === "detach"), false);
  read.resolve(); await closing; assert.equal(closed, true);
});

test("a delayed clipboard timeout callback cannot publish text after the original ACK deadline", async () => {
  const timing = manualTiming(), read = defer(), ack = defer();
  const f = fixture({ timing, clipboardTransfer: async (_scope, operation, { check, dispatch }) => {
    await dispatch(); ack.resolve(); await read.promise; check();
    return { operation, status: "ready", text: "expired private text" };
  } });
  const handle = await f.begin(), transfer = input(handle, clipboardKey());
  await ack.promise;
  timing.skip(3001); // Native time advances while timer callbacks remain queued.
  read.resolve();
  try {
    const result = await transfer;
    assert.equal(result.acknowledged, true);
    assert.deepEqual(result.clipboardTransfer, { operation: "copy", status: "failed", code: "TIMEOUT" });
    assert.equal(f.calls.filter(([method]) => method === "Input.dispatchKeyEvent").length, 1);
  } finally { await handle.close(); }
});

test("End after native copy ACK revokes text immediately and releases its key before the read settles", async () => {
  const read = defer(), ack = defer();
  const f = fixture({ clipboardTransfer: async (_scope, operation, { dispatch }) => {
    await dispatch(); ack.resolve(); await read.promise;
    // Deliberately ignore the helper's check: controller still fences this data.
    return { operation, status: "ready", text: "retired payload" };
  } });
  const handle = await f.begin(), transfer = input(handle, clipboardKey());
  await ack.promise;
  let closed = false; const closing = handle.close().then(() => { closed = true; });
  const result = await transfer;
  assert.equal(result.acknowledged, true);
  assert.deepEqual(result.clipboardTransfer, { operation: "copy", status: "failed", code: "CANCELLED" });
  await tick();
  assert.equal(closed, false);
  assert.equal(f.calls.filter(([method, , params]) => method === "Input.dispatchKeyEvent" && params.type === "keyUp").length, 1);
  assert.equal(f.calls.some(([method]) => method === "detach"), false);
  read.resolve(); await closing;
});

test("End while clipboard preparation is pending releases earlier held input without dispatching cut", async () => {
  const preparing = defer(), started = defer();
  const f = fixture({ clipboardTransfer: async (_scope, operation, { dispatch, check }) => {
    started.resolve(); await preparing.promise; check(); await dispatch();
    return { operation, status: "unchanged" };
  } });
  const handle = await f.begin();
  await input(handle, { type: "key", action: "down", key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17, modifiers: 2 });
  const transfer = input(handle, clipboardKey("cut")); transfer.catch(() => {});
  await started.promise; const closing = handle.close();
  await tick();
  const keys = f.calls.filter(([method]) => method === "Input.dispatchKeyEvent").map(row => row[2]);
  assert.deepEqual(keys.map(key => [key.code, key.type]), [["ControlLeft", "rawKeyDown"], ["ControlLeft", "keyUp"]]);
  preparing.resolve(); await assert.rejects(transfer, /CANCELLED|STALE/); await closing;
});

test("clipboard preparation failure never dispatches the original cut", async () => {
  const f = fixture({ clipboardTransfer: async () => { throw new Error("OBU_CLIPBOARD_UNSUPPORTED: native version unavailable"); } });
  const handle = await f.begin();
  await assert.rejects(input(handle, clipboardKey("cut")), /UNSUPPORTED/);
  assert.equal(f.calls.some(([method]) => method.startsWith("Input.")), false);
  await handle.close();
});

test("a transfer implementation cannot dispatch an acknowledged cut twice", async () => {
  const f = fixture({ clipboardTransfer: async (_scope, _operation, { dispatch }) => { await dispatch(); await dispatch(); } });
  const handle = await f.begin(), result = await input(handle, clipboardKey("cut"));
  assert.equal(result.acknowledged, true);
  assert.equal(result.clipboardTransfer.status, "failed");
  assert.equal(f.calls.filter(([method]) => method === "Input.dispatchKeyEvent").length, 1);
  await handle.close();
});

for (const result of [{ operation: "copy", status: "unchanged" }, { operation: "copy", status: "ready", text: "" },
  { operation: "copy", status: "ready", text: "中文\n🧭" }]) test(`clipboard actual ${result.status} result is bound to its original ACK (${JSON.stringify(result.text)})`, async () => {
  const f = fixture({ clipboardTransfer: async (_scope, _operation, { dispatch }) => { await dispatch(); return result; } });
  const handle = await f.begin(), receipt = await input(handle, clipboardKey());
  assert.equal(receipt.sequence, 1); assert.equal(receipt.leaseId, handle.info().leaseId);
  assert.deepEqual(receipt.clipboardTransfer, result);
  await handle.close();
});

test("clipboard requests reject unsupported capability and mismatched native shortcuts before dispatch", async () => {
  const legacy = fixture(), old = await legacy.begin();
  await assert.rejects(input(old, clipboardKey()), /UNAVAILABLE/); await old.close();
  const f = fixture({ clipboardTransfer: async () => assert.fail("invalid shortcut must not reach clipboard") });
  const handle = await f.begin();
  for (const extra of [{ modifiers: 10 }, { modifiers: 6 }, { action: "up" }, { repeat: true }, { code: "KeyV" }, { key: "x" }])
    await assert.rejects(input(handle, clipboardKey("copy", extra)));
  assert.equal(f.calls.some(([method]) => method.startsWith("Input.")), false);
  await handle.close();
});

function remoteFixture(options = {}) {
  let f;
  const root = { id: "root", loaderId: "loader-1", url: "https://fixture.test/original-document" };
  const child = { id: "remote", parentId: "root", loaderId: "remote-loader", url: "https://remote.test/form" };
  const nested = { id: "nested-remote", parentId: "remote", loaderId: "nested-loader", url: "https://nested.test/form" };
  const source = sessionId => ({ targetId: "original-target", ...(sessionId ? { sessionId } : {}) });
  f = fixture({ assertDialog: options.assertDialog, command: async (method, params, target) => {
    const sessionId = target.sessionId, frame = sessionId === "child-session" ? child : sessionId === "nested-session" ? nested : root;
    if (method === "Runtime.enable") f.event("Runtime.executionContextCreated", { context: {
      id: 1, uniqueId: `context-${frame.id}`, origin: new URL(frame.url).origin, auxData: { isDefault: true, frameId: frame.id }
    } }, source(sessionId));
    if (method === "Target.setAutoAttach" && params.autoAttach && (!sessionId || options.nested && sessionId === "child-session")) {
      const next = sessionId ? nested : child;
      f.event("Target.attachedToTarget", { sessionId: sessionId ? "nested-session" : "child-session", waitingForDebugger: false,
        targetInfo: { type: "iframe", targetId: next.id, url: next.url } }, source(sessionId));
    }
    const result = await options.command?.(method, params, target, f);
    if (result !== undefined) return result;
    if (method === "Page.getFrameTree") return { frameTree: { frame: { ...frame } } };
  } });
  return Object.assign(f, { remoteSource: source, remoteFrame: options.nested ? nested : child });
}

for (const nested of [false, true]) test(`current owned remote graph answers through the root once (nested=${nested})`, async () => {
  const native = defer(), permissions = [];
  const f = remoteFixture({ nested, assertDialog: (_candidate, origins) => permissions.push(origins), command: (method, params, _target, owner) => {
    if (method === "Input.insertText") {
      opening(owner, { frameId: owner.remoteFrame.id, url: owner.remoteFrame.url }); return native.promise;
    }
    if (method === "Page.handleJavaScriptDialog") {
      owner.event("Page.javascriptDialogClosed", { frameId: owner.remoteFrame.id, result: params.accept }); native.resolve();
    }
  } });
  const handle = await f.begin(), pending = input(handle, { type: "text", text: "one original trigger" }); await tick();
  assert.ok(handle.pendingDialog()); const receipt = await answer(handle);
  assert.equal(receipt.acknowledged, true); assert.equal((await pending).acknowledged, true);
  const expected = nested ? ["https://fixture.test", "https://remote.test", "https://nested.test"] : ["https://fixture.test", "https://remote.test"];
  assert.ok(permissions.length >= 2); for (const origins of permissions) assert.deepEqual([...origins].sort(), [...expected].sort());
  const replies = f.calls.filter(([method]) => method === "Page.handleJavaScriptDialog");
  assert.equal(replies.length, 1); assert.deepEqual(replies[0][1], { targetId: "original-target" });
  assert.equal(f.calls.filter(([method]) => method === "Input.insertText").length, 1);
  assert.equal(f.calls.filter(([method]) => method === "attach").length, 1);
  await handle.close(); assert.equal(f.risks.size, 0);
  assert.deepEqual(f.calls.filter(([method]) => method === "detach").map(row => row[1]), [{ targetId: "original-target" }]);
});

test("child-session modal and screencast events cannot impersonate root delivery", async () => {
  const f = remoteFixture(), handle = await f.begin(), count = f.frames.length;
  opening(f, { frameId: "remote", url: f.remoteFrame.url }, f.remoteSource("child-session"));
  assert.equal(handle.pendingDialog(), null); f.emit(f.remoteSource("child-session"));
  assert.equal(f.frames.length, count); assert.equal(f.calls.some(([method]) => method === "Page.handleJavaScriptDialog"), false);
  await handle.close();
});

test("remote context retirement before dispatch cancels only the original root-routed dialog", async () => {
  const f = remoteFixture(), handle = await f.begin(); opening(f, { frameId: "remote", url: f.remoteFrame.url });
  assert.ok(handle.pendingDialog()); const pending = answer(handle), rejected = assert.rejects(pending, /DIALOG_STALE/);
  f.event("Runtime.executionContextDestroyed", { executionContextId: 1, executionContextUniqueId: "context-remote" }, f.remoteSource("child-session"));
  await rejected; await handle.close();
  assert.deepEqual(f.calls.filter(([method]) => method === "Page.handleJavaScriptDialog").map(row => [row[1], row[2]]),
    [[{ targetId: "original-target" }, { accept: false }]]);
});

test("foreign roots and retired SDK sessions cannot clear the current remote context", async () => {
  const f = remoteFixture(), handle = await f.begin();
  f.event("Runtime.executionContextsCleared", {}, { targetId: "foreign-target", sessionId: "child-session" });
  f.event("Runtime.executionContextsCleared", {}, f.remoteSource("old-sdk-session"));
  opening(f, { frameId: "remote", url: f.remoteFrame.url }); assert.ok(handle.pendingDialog());
  await answer(handle); f.event("Page.javascriptDialogClosed", { frameId: "remote" }); await handle.close();
});

test("revoked startup joins actual child setup before detaching the original root", async () => {
  const enabled = defer(), f = remoteFixture({ command: (method, _params, target) => method === "Page.enable" && target.sessionId ? enabled.promise : undefined });
  const beginning = f.begin(), rejected = assert.rejects(beginning, /revoked/);
  await tick(); assert.ok(f.calls.some(([method, target]) => method === "Page.enable" && target.sessionId));
  const closing = f.control.cancel(); await tick(); assert.equal(f.calls.some(([method]) => method === "detach"), false);
  enabled.resolve(); await rejected; await closing;
  assert.equal(f.calls.filter(([method]) => method === "detach").length, 1); assert.equal(f.risks.size, 0);
});

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

const opening = (f, extra = {}, source) => f.event("Page.javascriptDialogOpening", {
  type: "confirm", message: "Continue original task?", url: "https://fixture.test/original-document", frameId: "root", ...extra
}, source);
const answer = (handle, extra = {}) => {
  const { leaseId, generation, dialogId } = handle.pendingDialog();
  return handle.respondDialog({ leaseId, generation, dialogId, accept: true, ...extra });
};

function departureFixture(options = {}) {
  let f; const validations = [];
  f = fixture({ ...options, validate: (candidate, flags) => { validations.push(flags.advance); return options.validate?.(candidate, flags); },
    command: async (method, params, target) => {
      if (method === "Runtime.enable") f.event("Runtime.executionContextCreated", { context: { id: 1, uniqueId: "departure-context",
        origin: "https://fixture.test", auxData: { frameId: "root", isDefault: true } } });
      return options.command?.(method, params, target, f);
    }
  });
  f.openDeparture = async (pendingFirst = false) => {
    if (pendingFirst) f.event("Page.frameStartedNavigating", { frameId: "root", loaderId: "departure-loader" });
    opening(f, { type: "beforeunload", message: "" });
    for (let i = 0; i < 20 && !f.control.current?.dialogs.info() && !f.control.current?.revoked; i++) await tick();
    return f.control.current?.dialogs.info();
  };
  f.commitDeparture = () => {
    f.changeDocument("departed");
    f.event("Page.frameNavigated", { frame: { id: "root", loaderId: "loader-departed", url: "https://fixture.test/departed" } });
    f.event("Runtime.executionContextCreated", { context: { id: 2, uniqueId: "departed-context", origin: "https://fixture.test",
      auxData: { frameId: "root", isDefault: true } } });
  };
  return Object.assign(f, { validations });
}
async function activeDeparture(f, handle, generation) {
  for (let i = 0; i < 30 && (handle.info().state !== "active" || handle.info().generation <= generation) && !f.control.current?.revoked; i++) await tick();
  assert.equal(handle.info().state, "active"); assert.ok(handle.info().generation > generation);
}

for (const pendingFirst of [false, true]) test(`beforeunload Stay restores the original document through a new input generation (pendingFirst=${pendingFirst})`, async t => {
  const f = departureFixture({ command(method, params, _target, owner) {
    if (method === "Page.handleJavaScriptDialog") owner.event("Page.javascriptDialogClosed", { frameId: "root", result: params.accept });
  } }), handle = await f.begin(); t.after(() => handle.close());
  await input(handle, { type: "text", text: "original draft" });
  const old = handle.info(), originalEpoch = f.control.current.epoch;
  const dialog = await f.openDeparture(pendingFirst); assert.equal(dialog.type, "beforeunload");
  assert.equal(dialog.generation, pendingFirst ? old.generation + 1 : old.generation);
  if (pendingFirst) { assert.equal(handle.info().state, "navigating"); assert.equal(handle.info().viewport, null); assert.equal(originalEpoch.retired, true); }
  const receipt = await answer(handle, { accept: false }); assert.equal(receipt.acknowledged, true);
  await activeDeparture(f, handle, dialog.generation);
  assert.equal(f.control.current.candidate.documentId, "original-document");
  assert.equal(originalEpoch.cleaned, true); assert.equal(f.control.current.pendingNavigations.size, 0);
  assert.equal(f.validations.some(Boolean), false, "Stay never advances result-page document lineage");
  assert.equal((await input(handle, { type: "text", text: " continued" })).sequence, 1);
  const second = await f.openDeparture(); assert.notEqual(second.dialogId, dialog.dialogId);
  await answer(handle, { accept: false }); await activeDeparture(f, handle, second.generation);
});

for (const pendingFirst of [false, true]) test(`beforeunload Leave waits for actual native commit and a new frame (pendingFirst=${pendingFirst})`, async t => {
  const f = departureFixture({ command(method, _params, _target, owner) {
    if (method === "Page.handleJavaScriptDialog") owner.event("Page.javascriptDialogClosed", { frameId: "root", result: true });
  } }), handle = await f.begin(); t.after(() => handle.close());
  const dialog = await f.openDeparture(pendingFirst); assert.ok(dialog);
  await answer(handle); await tick();
  assert.equal(handle.info().state, "navigating"); assert.equal(handle.info().viewport, null);
  await assert.rejects(input(handle, { type: "text", text: "must not reach old document" }), /GENERATION_STALE|STALE|UNAVAILABLE|active/);
  if (!pendingFirst) f.event("Page.frameStartedNavigating", { frameId: "root", loaderId: "departure-loader" });
  await tick(); assert.equal(handle.info().state, "navigating", "native start is not a commit or ready frame");
  f.commitDeparture(); await activeDeparture(f, handle, dialog.generation);
  assert.equal(f.control.current.epoch.candidate.documentId, "departed");
  assert.equal((await input(handle, { type: "text", text: "new document" })).sequence, 1);
});

for (const pendingFirst of [false, true]) for (const accept of [false, true])
  test(`beforeunload original URL hint preserves the chosen native decision (pendingFirst=${pendingFirst}, accept=${accept})`, async t => {
    const f = departureFixture({ command(method, params, _target, owner) {
      if (method === "Page.handleJavaScriptDialog") {
        owner.event("Page.javascriptDialogClosed", { frameId: "root", result: params.accept });
      }
    } }), handle = await f.begin(); t.after(() => handle.close());
    const dialog = await f.openDeparture(pendingFirst), record = f.control.current;
    const original = record.dialogs.current.proof.candidate, validate = f.control.validate;
    let hintReads = 0;
    f.control.validate = (candidate, options) => {
      if (options?.inspect) {
        hintReads++; assert.equal(candidate, original);
        assert.equal(options.advance ?? false, false); assert.equal(options.refreshNavigation ?? false, false);
      }
      return validate(candidate, options);
    };
    assert.equal(f.control.navigationHint(7, { url: original.url }), true);
    const receipt = await answer(handle, { accept });
    assert.equal(receipt.acknowledged, true); assert.equal(hintReads, 1); assert.equal(record.urlHint, null);
    assert.deepEqual(f.calls.filter(([method]) => method === "Page.handleJavaScriptDialog").map(call => call[2]), [{ accept }]);
    if (accept) {
      assert.equal(handle.info().state, "navigating");
      if (!pendingFirst) f.event("Page.frameStartedNavigating", { frameId: "root", loaderId: "departure-loader" });
      f.commitDeparture();
    }
    await activeDeparture(f, handle, dialog.generation);
    assert.equal(record.epoch.candidate.documentId, accept ? "departed" : "original-document");
    assert.equal((await input(handle, { type: "text", text: "after original decision" })).acknowledged, true);
  });

for (const boundary of ["End", "second-pending", "default-context", "browser-document", "policy", "timeout"])
  test(`beforeunload hint read cannot authorize Leave after ${boundary}`, async t => {
    const timing = manualTiming(), read = defer(), entered = defer(); let policyDenied = false, replaceDocument = false;
    const f = departureFixture({ timing, assertDialog() { if (policyDenied) throw Error("original policy revoked"); },
      command(method, params, _target, owner) {
        if (method === "Page.handleJavaScriptDialog") owner.event("Page.javascriptDialogClosed", { frameId: "root", result: params.accept });
      } }), handle = await f.begin();
    t.after(async () => { read.resolve(); await handle.close(); });
    await f.openDeparture(true);
    const record = f.control.current, original = record.dialogs.current.proof.candidate, validate = f.control.validate;
    f.control.validate = async (candidate, options) => {
      assert.equal(candidate, original); assert.equal(options.advance ?? false, false);
      entered.resolve(); await options.retain(read.promise);
      const verified = await validate(candidate, options);
      return replaceDocument ? { ...verified, documentId: "same-url-replacement" } : verified;
    };
    f.control.navigationHint(7, { url: original.url });
    const response = answer(handle), rejected = assert.rejects(response, /DIALOG_STALE/);
    await Promise.race([entered.promise, response]);
    const frames = f.frames.length, [actual] = record.hintReads;
    assert.ok(actual); assert.equal(record.drains.has(actual), true);
    let ended = false, closing;
    if (boundary === "End") closing = handle.close().then(() => { ended = true; });
    if (boundary === "second-pending") f.event("Page.frameStartedNavigating", { frameId: "root", loaderId: "another-departure" });
    if (boundary === "default-context") f.event("Runtime.executionContextCreated", { context: { id: 3, uniqueId: "replacement-context",
      origin: "https://fixture.test", auxData: { frameId: "root", isDefault: true } } });
    if (boundary === "browser-document") replaceDocument = true;
    if (boundary === "policy") policyDenied = true;
    if (boundary === "timeout") { timing.advance(5000); closing = handle.close().then(() => { ended = true; }); }
    await tick();
    assert.equal(f.calls.some(([method, , params]) => method === "Page.handleJavaScriptDialog" && params.accept), false);
    if (closing) {
      await rejected; assert.equal(ended, false);
      assert.equal(record.hintReads.has(actual), true); assert.equal(record.drains.has(actual), true);
      assert.equal(f.calls.some(([method]) => method === "detach"), false);
    }
    read.resolve(); await rejected; await (closing ?? handle.close());
    assert.deepEqual(f.calls.filter(([method]) => method === "Page.handleJavaScriptDialog").map(call => call[2]), [{ accept: false }]);
    assert.equal(f.frames.length, frames); assert.equal(f.control.current, null); assert.equal(record.hintReads.size, 0);
    assert.equal(timing.timers.size, 0);
  });

for (const sameURL of [false, true]) test(`beforeunload hint read cannot clear a newer hint (sameURL=${sameURL})`, async t => {
  const first = defer(), second = defer(), firstEntered = defer(), secondEntered = defer();
  const f = departureFixture({ command(method, params, _target, owner) {
    if (method === "Page.handleJavaScriptDialog") owner.event("Page.javascriptDialogClosed", { frameId: "root", result: params.accept });
  } }), handle = await f.begin();
  t.after(async () => { first.resolve(); second.resolve(); await handle.close(); });
  const dialog = await f.openDeparture(true), record = f.control.current, original = record.dialogs.current.proof.candidate;
  const validate = f.control.validate; let reads = 0;
  f.control.validate = async (candidate, options) => {
    if (options?.inspect) {
      assert.equal(candidate, original); assert.equal(options.advance ?? false, false);
      reads++; assert.ok(reads <= 2);
      (reads === 1 ? firstEntered : secondEntered).resolve();
      await options.retain((reads === 1 ? first : second).promise);
    }
    return validate(candidate, options);
  };
  f.control.navigationHint(7, { url: original.url });
  const response = answer(handle, { accept: false }); response.catch(() => {});
  await Promise.race([firstEntered.promise, response]);
  f.control.navigationHint(7, { url: sameURL ? original.url : original.url + "?replacement" });
  const latest = record.urlHint;
  first.resolve();
  if (sameURL) {
    await Promise.race([secondEntered.promise, response]);
    assert.equal(record.urlHint, latest); assert.equal(reads, 2);
    assert.equal(f.calls.some(([method]) => method === "Page.handleJavaScriptDialog"), false);
    second.resolve(); assert.equal((await response).acknowledged, true);
    assert.equal(record.urlHint, null); await activeDeparture(f, handle, dialog.generation);
  } else {
    await assert.rejects(response, /DIALOG_STALE/); await handle.close();
    assert.equal(reads, 1); assert.equal(record.urlHint, latest);
  }
  assert.deepEqual(f.calls.filter(([method]) => method === "Page.handleJavaScriptDialog").map(call => call[2]), [{ accept: false }]);
});

test("beforeunload Closed, native decision ACK, and same-document read are separate input barriers", async t => {
  const ack = defer(), read = defer(); let reads = 0;
  const f = departureFixture({ validateSameDocument: () => ++reads === 2 ? read.promise : undefined,
    command: method => method === "Page.handleJavaScriptDialog" ? ack.promise : undefined }), handle = await f.begin();
  t.after(async () => { ack.resolve(); read.resolve(); await handle.close(); });
  const dialog = await f.openDeparture(true), response = answer(handle, { accept: false }); await tick();
  f.event("Page.javascriptDialogClosed", { frameId: "root", result: false }); await tick();
  assert.equal(handle.info().state, "navigating"); assert.equal(reads, 1, "Closed does not invent native ACK");
  ack.resolve(); assert.equal((await response).acknowledged, true); await tick();
  assert.equal(reads, 2); assert.equal(handle.info().state, "navigating", "ACK does not complete browser identity verification");
  await assert.rejects(input(handle, { type: "text", text: "not yet" }), /GENERATION_STALE|STALE|UNAVAILABLE|active/);
  read.resolve(); await activeDeparture(f, handle, dialog.generation);
});

test("beforeunload ACK alone keeps the original modal and cannot enable input", async t => {
  const f = departureFixture(), handle = await f.begin(); t.after(() => handle.close());
  const dialog = await f.openDeparture(); await answer(handle, { accept: false });
  assert.equal(handle.pendingDialog().dialogId, dialog.dialogId); assert.equal(f.control.current.departure.phase, "deciding");
  await assert.rejects(input(handle, { type: "text", text: "not before Closed" }), /DIALOG_BUSY/);
  f.event("Page.javascriptDialogClosed", { frameId: "root", result: false }); await activeDeparture(f, handle, dialog.generation);
});

for (const stage of ["decision-ACK", "identity-read"]) test(`End during departure ${stage} retains original work and late success cannot restore input`, async () => {
  const ack = defer(), read = defer(); let reads = 0;
  const f = departureFixture({ validateSameDocument: () => ++reads === 2 && stage === "identity-read" ? read.promise : undefined,
    command: method => method === "Page.handleJavaScriptDialog" && stage === "decision-ACK" ? ack.promise : undefined });
  const handle = await f.begin(); await f.openDeparture(true);
  const response = answer(handle, { accept: false }); response.catch(() => {}); await tick();
  f.event("Page.javascriptDialogClosed", { frameId: "root", result: false }); await tick();
  const frames = f.frames.length; let ended = false;
  const ending = handle.close().then(() => { ended = true; }); await tick();
  assert.equal(ended, false); assert.equal(handle.info().state, "releasing");
  ack.resolve(); read.resolve(); await response; await ending;
  assert.equal(f.frames.length, frames); assert.equal(f.control.current, null);
});

test("the original input ACK survives a beforeunload Stay and new generation", async t => {
  const up = defer(); let f;
  f = departureFixture({ command(method, params, _target, owner) {
    if (method === "Input.dispatchMouseEvent" && params.type === "mouseReleased") { opening(owner, { type: "beforeunload", message: "" }); return up.promise; }
    if (method === "Page.handleJavaScriptDialog") owner.event("Page.javascriptDialogClosed", { frameId: "root", result: false });
  } });
  const handle = await f.begin(); t.after(async () => { up.resolve(); await handle.close(); });
  await input(handle, { type: "pointer", action: "down", button: "left", x: 1, y: 1 });
  const old = handle.info(), sending = input(handle, { type: "pointer", action: "up", button: "left", x: 1, y: 1 });
  await tick(); const dialog = handle.pendingDialog(); assert.ok(dialog); await answer(handle, { accept: false }); await tick();
  assert.equal(handle.info().state, "navigating", "actual old input remains in cleanup");
  up.resolve(); assert.deepEqual(await sending, { leaseId: old.leaseId, generation: old.generation, sequence: 2, acknowledged: true });
  await activeDeparture(f, handle, dialog.generation);
  assert.equal(f.calls.filter(([method, , params]) => method === "Input.dispatchMouseEvent" && params.type === "mouseReleased").length, 1);
});

test("End before a beforeunload choice keeps releasing after its native Closed and waits the original cancel ACK", async () => {
  const ack = defer();
  const f = departureFixture({ command: method => method === "Page.handleJavaScriptDialog" ? ack.promise : undefined });
  const handle = await f.begin(); await f.openDeparture(true);
  let done = false; const ending = handle.close().then(() => { done = true; }); await tick();
  const generation = handle.info().generation;
  f.event("Page.javascriptDialogClosed", { frameId: "root", result: false }); await tick();
  assert.equal(done, false); assert.equal(handle.info().state, "releasing"); assert.equal(handle.info().generation, generation);
  assert.deepEqual(f.calls.filter(([method]) => method === "Page.handleJavaScriptDialog").map(call => call[2]), [{ accept: false }]);
  ack.resolve(); await ending; assert.equal(f.control.current, null);
});

for (const boundary of ["second-pending", "replaced-context", "different-document", "unknown-decision-ACK"]) {
  test(`beforeunload cannot restore original input after ${boundary}`, async () => {
    const ack = defer(), read = defer(); let reads = 0;
    const f = departureFixture({ validateSameDocument: () => ++reads === 2 ? read.promise : undefined,
      command: method => method === "Page.handleJavaScriptDialog" ? ack.promise : undefined });
    const handle = await f.begin(); await f.openDeparture(true);
    const response = answer(handle, { accept: false }); response.catch(() => {}); await tick();
    f.event("Page.javascriptDialogClosed", { frameId: "root", result: false });
    if (boundary === "unknown-decision-ACK") ack.reject(new Error("original native ACK unknown"));
    else ack.resolve();
    await tick(); const frames = f.frames.length;
    if (boundary === "second-pending") f.event("Page.frameStartedNavigating", { frameId: "root", loaderId: "second-pending" });
    if (boundary === "replaced-context") f.event("Runtime.executionContextCreated", { context: { id: 3, uniqueId: "replacement-context",
      origin: "https://fixture.test", auxData: { frameId: "root", isDefault: true } } });
    if (boundary === "different-document") f.changeDocument();
    read.resolve();
    if (boundary === "unknown-decision-ACK") await assert.rejects(response, /UNCONFIRMED/); else assert.equal((await response).acknowledged, true);
    for (let i = 0; i < 20 && f.control.current && !f.control.current.revoked; i++) await tick();
    assert.ok(!f.control.current || f.control.current.revoked);
    await handle.close(); assert.equal(f.frames.length, frames);
    assert.equal(f.calls.filter(([method]) => method === "Page.handleJavaScriptDialog").length, 1);
  });
}

test("beforeunload uses native cancellation even when the acknowledged request asked to leave", async t => {
  const f = departureFixture({ command(method, _params, _target, owner) {
    if (method === "Page.handleJavaScriptDialog") owner.event("Page.javascriptDialogClosed", { frameId: "root", result: false });
  } }), handle = await f.begin(); t.after(() => handle.close());
  const dialog = await f.openDeparture(true); assert.equal((await answer(handle)).acknowledged, true);
  await activeDeparture(f, handle, dialog.generation);
  assert.equal(f.control.current.epoch.candidate.documentId, "original-document");
  assert.deepEqual(f.calls.filter(([method]) => method === "Page.handleJavaScriptDialog").map(call => call[2]), [{ accept: true }]);
});

test("beforeunload accepted departure ignores unrelated native or web commit as completion", async t => {
  const f = departureFixture({ command(method, _params, _target, owner) {
    if (method === "Page.handleJavaScriptDialog") owner.event("Page.javascriptDialogClosed", { frameId: "root", result: true });
  } }), handle = await f.begin(); t.after(() => handle.close());
  const dialog = await f.openDeparture(true); await answer(handle);
  f.control.navigation(7, { frameId: 0 }, "committed", "web");
  f.event("Page.frameStartedNavigating", { frameId: "unrelated-child", loaderId: "child-next" });
  f.event("Page.frameNavigated", { frame: { id: "unrelated-child", parentId: "root", loaderId: "child-next", url: "https://fixture.test/child" } });
  await tick(); assert.equal(handle.info().state, "navigating"); assert.equal(f.control.current.departure.phase, "accepted");
  f.commitDeparture(); await activeDeparture(f, handle, dialog.generation);
});

test("departure recovery timeout revokes immediately but cannot forget the original late decision ACK", async () => {
  const timing = manualTiming(), ack = defer();
  const f = departureFixture({ timing, command: method => method === "Page.handleJavaScriptDialog" ? ack.promise : undefined });
  const handle = await f.begin(); await f.openDeparture(true);
  const response = answer(handle, { accept: false }); await tick();
  f.event("Page.javascriptDialogClosed", { frameId: "root", result: false }); const frames = f.frames.length;
  timing.advance(10001); await tick(); assert.equal(f.control.current.revoked, true);
  let done = false; const ending = handle.close().then(() => { done = true; }); await tick(); assert.equal(done, false);
  ack.resolve(); assert.equal((await response).acknowledged, true); await ending;
  assert.equal(f.frames.length, frames); assert.equal(timing.timers.size, 0);
});

function childFixture(options = {}) {
  const tree = { frameTree: { frame: { id: "root", loaderId: "root-loader", url: "https://fixture.test/original-document" }, childFrames: [
    { frame: { id: "child", parentId: "root", loaderId: "child-loader", url: options.url ?? "https://fixture.test/child", securityOrigin: "https://fixture.test" },
      childFrames: [{ frame: { id: "nested", parentId: "child", loaderId: "nested-loader", url: "https://fixture.test/nested" } }] }
  ] } };
  let f;
  f = fixture({ command: async (method, params) => {
    if (method === "Runtime.enable") {
      for (const [index, frameId] of ["root", "child", "nested"].entries()) {
        if (frameId === options.missing) continue;
        f.event("Runtime.executionContextCreated", { context: { id: index + 1, uniqueId: `original-${frameId}`,
          origin: frameId === "child" ? options.origin ?? "https://fixture.test" : "https://fixture.test", auxData: { frameId, isDefault: true } } }, options.source);
      }
    }
    const result = await options.command?.(method, params, f, tree);
    if (result !== undefined) return result;
    if (method === "Page.getFrameTree") return tree;
  } });
  return Object.assign(f, { tree });
}

test("human Page and Runtime listeners and actual enable ACKs precede the first document snapshot", async () => {
  const page = defer(), runtime = defer(); let f;
  f = fixture({ command: method => {
    if (["Page.enable", "Runtime.enable"].includes(method)) assert.ok(f.listeners.size > 0);
    if (method === "Page.enable") return page.promise;
    if (method === "Runtime.enable") return runtime.promise;
  } });
  const pending = f.begin(); await tick();
  assert.equal(f.calls.some(([method]) => method === "Runtime.enable"), false);
  assert.equal(f.calls.some(([method]) => method === "Page.getFrameTree"), false);
  page.resolve(); await tick(); assert.equal(f.calls.some(([method]) => method === "Runtime.enable"), true);
  assert.equal(f.calls.some(([method]) => method === "Page.getFrameTree"), false);
  runtime.resolve(); const handle = await pending; await handle.close();
});

for (const [frameId, url] of [["child", "https://fixture.test/child"], ["nested", "https://fixture.test/nested"], ["child", "about:blank"], ["child", "about:srcdoc"]]) {
  test(`original ${frameId} ${url} dialog bypasses its pending input using the frozen native context path`, async () => {
    const native = defer();
    const f = childFixture({ url: frameId === "child" ? url : undefined, command: (method, _params, owner) => {
      if (method === "Input.insertText") { opening(owner, { frameId, url }); return native.promise; }
      if (method === "Page.handleJavaScriptDialog") { owner.event("Page.javascriptDialogClosed", { frameId }); native.resolve(); }
    } });
    const handle = await f.begin(), pending = input(handle, { type: "text", text: "one original trigger" }); await tick();
    const original = handle.pendingDialog(); assert.ok(original);
    const boundary = f.calls.length, receipt = await answer(handle);
    assert.equal(receipt.dialogId, original.dialogId); assert.equal((await pending).acknowledged, true);
    assert.deepEqual(f.calls.slice(boundary).map(([method]) => method), ["Page.handleJavaScriptDialog"]);
    await handle.close();
  });
}

for (const options of [{ origin: "://" }, { origin: "https://foreign.test" }, { missing: "root" },
  { source: { targetId: "original-target", sessionId: "remote-frame" } }]) {
  test(`child default context is required independently of URL-derived origin ${JSON.stringify(options)}`, async () => {
    const f = childFixture(options), handle = await f.begin();
    opening(f, { frameId: "child", url: "https://fixture.test/child" });
    assert.equal(handle.pendingDialog(), null); await handle.close();
    assert.deepEqual(f.calls.filter(([method]) => method === "Page.handleJavaScriptDialog").map(call => call[2]), [{ accept: false }]);
  });
}

test("destroying an original child context withdraws an unsubmitted decision and only cancels once", async () => {
  const f = childFixture(), handle = await f.begin(); opening(f, { frameId: "child", url: "https://fixture.test/child" });
  const old = handle.pendingDialog(); assert.ok(old);
  f.event("Runtime.executionContextDestroyed", { executionContextId: 2, executionContextUniqueId: "original-child" });
  assert.equal(handle.pendingDialog(), null);
  await assert.rejects(handle.respondDialog({ leaseId: old.leaseId, generation: old.generation, dialogId: old.dialogId, accept: true }), /DIALOG_STALE/);
  await handle.close();
  assert.deepEqual(f.calls.filter(([method]) => method === "Page.handleJavaScriptDialog").map(call => call[2]), [{ accept: false }]);
});

test("tree ambiguity cannot grant a child dialog identity", () => {
  const f = childFixture(), tree = f.tree;
  tree.frameTree.childFrames[0].frame.id = "root";
  assert.throws(() => f.control.frameTree(tree), /ambiguous/);
  tree.frameTree.childFrames[0].frame.id = "child";
  tree.frameTree.childFrames[0].frame.parentId = "foreign";
  assert.throws(() => f.control.frameTree(tree), /ambiguous/);
});

const childContext = (f, frameId = "child", uniqueId = "replacement-child", id = 2) => f.event("Runtime.executionContextCreated", {
  context: { id, uniqueId, origin: "https://fixture.test", auxData: { frameId, isDefault: true } }
});
const childOpening = (f, frameId = "child") => opening(f, { frameId, url: `https://fixture.test/${frameId}` });
const decisions = f => f.calls.filter(([method]) => method === "Page.handleJavaScriptDialog").map(call => call[2]);

function readinessFixture(options = {}) {
  let f;
  f = fixture({ ...options, command: async (method, params, target) => {
    if (method === "Runtime.enable") childContext(f, "root", "original-root", 1);
    return options.command?.(method, params, target, f);
  } });
  return f;
}
function navigateOriginal(f, id = "B", url = `https://fixture.test/${id}`) {
  f.event("Page.frameStartedNavigating", { frameId: "root", loaderId: "loader-" + id });
  f.event("Runtime.executionContextsCleared");
  f.changeDocument(id);
  f.event("Page.frameNavigated", { frame: { id: "root", loaderId: "loader-" + id, url } });
  childContext(f, "root", "context-" + id, 2);
}

test("destination default context is observed before preparation fixes input identity", async () => {
  const f = readinessFixture({ command: (method, params, _target, owner) => {
    if (method === "Page.handleJavaScriptDialog") owner.event("Page.javascriptDialogClosed", { frameId: "root", result: params.accept });
  } });
  const handle = await f.begin();
  try {
    f.event("Page.frameStartedNavigating", { frameId: "root", loaderId: "loader-B" });
    f.event("Runtime.executionContextsCleared"); f.changeDocument("B");
    f.event("Page.frameNavigated", { frame: { id: "root", loaderId: "loader-B", url: "https://fixture.test/B" } });
    const boundary = f.calls.length;
    await tick();
    assert.equal(f.calls.slice(boundary).some(([method]) => method === "Page.getFrameTree"), false,
      "do not start metadata reads with an empty destination default-context fence");
    assert.equal(handle.info().state, "navigating");
    childContext(f, "root", "context-B", 2);
    opening(f, { url: "https://fixture.test/B", type: "prompt" });
    await tick();
    assert.ok(handle.pendingDialog()); assert.notEqual(f.control.current.revoked, true);
    await answer(handle, { promptText: "原目标文档" });
    await f.control.current.recovery;
    assert.equal(handle.info().state, "active");
    assert.deepEqual(decisions(f), [{ accept: true, promptText: "原目标文档" }]);
  } finally { await handle.close(); }
  assert.equal(f.risks.size, 0); assert.equal(f.calls.filter(([method]) => method === "detach").length, 1);
});

for (const ending of ["End", "deadline", "successor"]) test(`destination context wait preserves ${ending} without a replacement read or input replay`, async () => {
  const timing = manualTiming(), f = readinessFixture({ timing }), handle = await f.begin();
  f.event("Page.frameStartedNavigating", { frameId: "root", loaderId: "loader-B" });
  f.event("Runtime.executionContextsCleared"); f.changeDocument("B");
  f.event("Page.frameNavigated", { frame: { id: "root", loaderId: "loader-B", url: "https://fixture.test/B" } });
  const boundary = f.calls.length, record = f.control.current;
  await tick();
  try {
    assert.equal(f.calls.slice(boundary).some(([method]) => method === "Page.getFrameTree"), false);
    assert.equal(record.dialogWaiters.size, 1);
    if (ending === "successor") {
      const abandoned = handle.info().generation;
      navigateOriginal(f, "C");
      await record.recovery;
      assert.equal(handle.info().state, "active");
      assert.ok(handle.info().generation > abandoned);
      assert.equal(handle.tabInfo().url, "https://fixture.test/C");
      assert.equal(f.frames.some(frame => frame.generation === abandoned), false);
    } else if (ending === "deadline") {
      timing.advance(10001);
      assert.match((await handle.closed).reason, /PREPARATION_TIMEOUT/);
    }
  } finally { await handle.close(); }
  assert.equal(record.dialogWaiters.size, 0); assert.equal(f.risks.size, 0);
  assert.equal(f.calls.filter(([method]) => method === "detach").length, 1);
  assert.equal(f.calls.filter(([method]) => method.startsWith("Input.")).length, 0);
  if (ending !== "successor") assert.equal(f.calls.slice(boundary).some(([method]) => method === "Page.getFrameTree"), false);
});

test("actual Begin admits End before Page.enable ACK but grants no input or dialog", async () => {
  const page = defer(), entered = defer();
  const f = fixture({ command: method => { if (method === "Page.enable") { entered.resolve(); return page.promise; } } });
  const handle = await f.beginAdmitted(); await entered.promise;
  assert.deepEqual({ ...handle.info(), leaseId: "original" }, {
    state: "preparing", leaseId: "original", tabId: 7, generation: 0, viewport: null, inputBudgetVersion: 1, keyRepeatVersion: 1, pointerClickCountVersion: 1, fileChooserVersion: 1, lastInputSequence: 0
  });
  assert.equal(handle.pendingDialog(), null);
  await assert.rejects(input(handle, { type: "text", text: "must not send" }), /GENERATION_STALE/);
  let ended = false; const closing = handle.close().then(() => { ended = true; }); await tick();
  assert.equal(ended, false); assert.equal(f.calls.some(([method]) => method === "detach"), false);
  page.resolve(); await closing;
  assert.equal(f.calls.some(([method]) => ["Runtime.enable", "Page.startScreencast"].includes(method) || method.startsWith("Input.")), false);
  f.control.assertReleased(); assert.equal(f.risks.size, 0);
});

test("proved prompt before the first frame answers while original metadata ACK remains pending", async () => {
  const metadata = defer(), entered = defer(), timing = manualTiming();
  const f = readinessFixture({ timing, command: (method, params, _target, owner) => {
    if (method === "Performance.enable") { entered.resolve(); return metadata.promise; }
    if (method === "Page.handleJavaScriptDialog") owner.event("Page.javascriptDialogClosed", { frameId: "root", result: params.accept });
  } });
  const handle = await f.beginAdmitted(); await entered.promise;
  assert.equal(handle.info().state, "preparing"); assert.equal(handle.info().generation, 1); assert.equal(handle.info().viewport, null);
  opening(f, { type: "prompt", defaultPrompt: "before native frame" }); await tick();
  assert.equal(handle.pendingDialog().generation, 1); assert.equal(f.frames.length, 0);
  assert.deepEqual(handle.pendingDialog().source, { origin: "https://fixture.test", frame: "top-level" });
  timing.advance(40000); assert.equal(handle.info().state, "preparing");
  await assert.rejects(input(handle, { type: "text", text: "no page input" }), /GENERATION_STALE/);
  const boundary = f.calls.length, receipt = await answer(handle, { promptText: "原始回答 ✅" });
  assert.equal(receipt.acknowledged, true);
  assert.deepEqual(f.calls.slice(boundary).map(([method]) => method), ["Page.handleJavaScriptDialog"]);
  assert.equal(f.frames.length, 0); assert.equal(handle.info().viewport, null);
  metadata.resolve(); await f.control.current.start;
  assert.equal(handle.info().state, "active"); assert.equal(handle.info().generation, 1); assert.equal(f.frames.length, 1);
  await handle.close(); f.control.assertReleased();
});

test("End cancels before joining the original pending readiness proof and never publishes it late", async () => {
  const metadata = defer(), entered = defer(), proof = defer(), proofEntered = defer(); let holdProof = false;
  const f = readinessFixture({ validate: () => { if (holdProof) { proofEntered.resolve(); return proof.promise; } },
    command: (method, params, _target, owner) => {
      if (method === "Performance.enable") { entered.resolve(); return metadata.promise; }
      if (method === "Page.handleJavaScriptDialog") owner.event("Page.javascriptDialogClosed", { frameId: "root", result: params.accept });
    } });
  const handle = await f.beginAdmitted(); await entered.promise; holdProof = true;
  opening(f); await proofEntered.promise; assert.equal(handle.pendingDialog(), null);
  let ended = false; const closing = handle.close().then(() => { ended = true; }); await tick();
  assert.deepEqual(decisions(f), [{ accept: false }]); assert.equal(ended, false);
  assert.equal(f.calls.some(([method]) => method === "detach"), false);
  proof.resolve(); metadata.resolve(); await closing;
  assert.equal(handle.pendingDialog(), null); assert.equal(f.frames.length, 0); f.control.assertReleased();
});

for (const sameURL of [false, true]) test(`navigation prompt bypasses the old input ACK and old stop without changing their receipts (sameURL=${sameURL})`, async () => {
  const native = defer(), sent = defer(), stop = defer(), stopEntered = defer(); let stops = 0;
  const url = sameURL ? "https://fixture.test/original-document" : "https://fixture.test/B";
  const f = readinessFixture({ documentURL: sameURL ? url : undefined, command: (method, params, _target, owner) => {
    if (method === "Input.insertText") { sent.resolve(); return native.promise; }
    if (method === "Page.stopScreencast" && ++stops === 1) { stopEntered.resolve(); return stop.promise; }
    if (method === "Page.handleJavaScriptDialog") owner.event("Page.javascriptDialogClosed", { frameId: "root", result: params.accept });
  } });
  const handle = await f.begin(), originalGeneration = handle.info().generation;
  const originalInput = input(handle, { type: "text", text: "one original native operation" }); await sent.promise;
  navigateOriginal(f, "B", url); opening(f, { url, type: "prompt" }); await tick();
  const dialog = handle.pendingDialog(); assert.ok(dialog); assert.ok(dialog.generation > originalGeneration);
  assert.deepEqual(dialog.source, { origin: "https://fixture.test", frame: "top-level" });
  assert.equal(handle.info().state, "navigating"); assert.equal(handle.info().viewport, null);
  await stopEntered.promise;
  assert.equal(f.calls.filter(([method]) => method === "Page.startScreencast").length, 1);
  const boundary = f.calls.length; await answer(handle, { promptText: "新页面，原始回答" });
  assert.equal(f.calls[boundary][0], "Page.handleJavaScriptDialog");
  assert.equal(f.calls.filter(([method]) => method === "Page.startScreencast").length, 1);
  const recovering = f.control.current.recovery; native.resolve();
  const receipt = await originalInput; assert.equal(receipt.generation, originalGeneration); assert.equal(receipt.sequence, 1);
  assert.equal(f.calls.filter(([method]) => method === "Page.startScreencast").length, 1);
  stop.resolve(); await recovering;
  assert.equal(handle.info().state, "active"); assert.equal(handle.info().lastInputSequence, 0);
  assert.equal(handle.info().generation, dialog.generation); assert.equal(f.calls.filter(([method]) => method === "Input.insertText").length, 1);
  await handle.close();
});

test("a navigation dialog keeps the old input cumulative budget even when its timer callback is late", async () => {
  const timing = manualTiming(), native = defer(), sent = defer();
  const f = readinessFixture({ timing, command: (method, params, _target, owner) => {
    if (method === "Input.insertText") { sent.resolve(); return native.promise; }
    if (method === "Page.handleJavaScriptDialog") owner.event("Page.javascriptDialogClosed", { frameId: "root", result: params.accept });
  } });
  const handle = await f.begin(), pending = input(handle, { type: "text", text: "one original input" }); pending.catch(() => {}); await sent.promise;
  opening(f); timing.advance(299000); await answer(handle);
  navigateOriginal(f); opening(f, { url: "https://fixture.test/B" }); await tick();
  assert.ok(handle.pendingDialog()); timing.skip(1001);
  await assert.rejects(answer(handle), /DIALOG_STALE/); await assert.rejects(pending, /INPUT_TIMEOUT/);
  assert.deepEqual(decisions(f), [{ accept: true }, { accept: false }]);
  assert.equal(f.calls.some(([method]) => method === "detach"), false);
  native.resolve(); await handle.close(); f.control.assertReleased();
});

test("a context destroyed while Runtime.enable awaits its ACK cannot be seeded by the later tree", async () => {
  const enabled = defer(), f = childFixture({ command: method => method === "Runtime.enable" ? enabled.promise : undefined });
  const pending = f.begin(); await tick();
  assert.equal(f.calls.some(([method]) => method === "Page.getFrameTree"), false);
  f.event("Runtime.executionContextDestroyed", { executionContextId: 2, executionContextUniqueId: "original-child" });
  childContext(f, "child", "original-child"); enabled.resolve();
  const handle = await pending; childOpening(f); assert.equal(handle.pendingDialog(), null);
  await handle.close(); assert.deepEqual(decisions(f), [{ accept: false }]);
});

test("native navigation before Runtime.enable ACK ends startup without seeding an old context", async () => {
  const enabled = defer(), f = childFixture({ command: method => method === "Runtime.enable" ? enabled.promise : undefined });
  const pending = f.begin(), rejected = assert.rejects(pending, /revoked/); await tick();
  f.event("Page.frameNavigated", { frame: { id: "root", loaderId: "next-root", url: "https://fixture.test/next" } });
  assert.equal(f.calls.some(([method]) => method === "detach"), false, "actual enable Promise still belongs to cleanup");
  enabled.resolve(); await rejected;
  assert.equal(f.calls.some(([method]) => method === "Page.getFrameTree"), false);
  assert.equal(f.calls.filter(([method]) => method === "detach").length, 1); assert.equal(f.risks.size, 0);
});

test("a new default context inside the complete observation window cannot authorize an old preparation", async () => {
  let trees = 0;
  const f = childFixture({ command: (method, _params, owner) => {
    // Two preliminary root reads precede the graph's two complete tree reads.
    if (method === "Page.getFrameTree" && ++trees === 4) childContext(owner);
  } });
  await assert.rejects(f.begin(), /original.*(identity|context|document)/);
  assert.equal(f.calls.some(([method]) => method.startsWith("Input.")), false);
  assert.equal(f.calls.filter(([method]) => method === "detach").length, 1);
});

for (const replacement of [false, true]) test(`child navigation uses only contexts newly observed for the new loader (${replacement})`, async () => {
  const f = childFixture(), handle = await f.begin(), lease = handle.info().leaseId;
  const child = f.tree.frameTree.childFrames[0]; child.frame.loaderId = "next-child-loader";
  f.event("Page.frameNavigated", { frame: { ...child.frame } });
  childContext(f, "child", replacement ? "new-child" : "original-child");
  childContext(f, "nested", replacement ? "new-nested" : "original-nested", 3);
  assert.equal(handle.info().state, "navigating"); await tick();
  assert.equal(handle.info().leaseId, lease); assert.equal(handle.info().generation, 2);
  childOpening(f, "nested");
  if (replacement) {
    assert.ok(handle.pendingDialog()); await answer(handle); f.event("Page.javascriptDialogClosed", { frameId: "nested" });
  } else assert.equal(handle.pendingDialog(), null);
  await handle.close(); assert.deepEqual(decisions(f), [{ accept: replacement }]);
});

test("an attached blank child retires the frozen tree without waiting for a commit event", async () => {
  const f = childFixture(), handle = await f.begin();
  f.tree.frameTree.childFrames.push({ frame: { id: "blank", parentId: "root", loaderId: "blank-loader", url: "about:blank" } });
  f.event("Page.frameAttached", { frameId: "blank", parentFrameId: "root" });
  childContext(f, "blank", "original-blank", 4);
  assert.equal(handle.info().state, "navigating"); await tick();
  assert.equal(handle.info().state, "active"); assert.equal(handle.info().generation, 2);
  opening(f, { frameId: "blank", url: "about:blank" }); assert.ok(handle.pendingDialog());
  await answer(handle); f.event("Page.javascriptDialogClosed", { frameId: "blank" }); await handle.close();
  assert.deepEqual(decisions(f), [{ accept: true }]);
});

test("same-document child navigation reuses only the alive context while binding the new URL generation", async () => {
  const f = childFixture(), handle = await f.begin();
  f.tree.frameTree.childFrames[0].frame.urlFragment = "#next";
  f.event("Page.navigatedWithinDocument", { frameId: "child", url: "https://fixture.test/child#next" }); await tick();
  assert.equal(handle.info().generation, 2);
  opening(f, { frameId: "child", url: "https://fixture.test/child#next" }); assert.ok(handle.pendingDialog());
  await answer(handle); f.event("Page.javascriptDialogClosed", { frameId: "child" }); await handle.close();
});

const invalidateChild = {
  destroyed: f => f.event("Runtime.executionContextDestroyed", { executionContextId: 2, executionContextUniqueId: "original-child" }),
  cleared: f => f.event("Runtime.executionContextsCleared"),
  replacement: f => childContext(f),
  navigation: f => f.event("Page.frameStartedNavigating", { frameId: "child" }),
  attached: f => f.event("Page.frameAttached", { frameId: "new-child", parentFrameId: "root" })
};
for (const [name, invalidate] of Object.entries(invalidateChild)) test(`child ${name} before final native dispatch withdraws a queued choice`, async () => {
  const cancelled = defer(), f = childFixture({ command: method => method === "Page.handleJavaScriptDialog" ? cancelled.promise : undefined });
  const handle = await f.begin(); childOpening(f);
  const response = answer(handle), rejected = assert.rejects(response, /DIALOG_STALE/);
  await Promise.resolve(); assert.deepEqual(decisions(f), [], "response has entered send, but not native dispatch");
  invalidate(f); await tick(); assert.deepEqual(decisions(f), [{ accept: false }]);
  assert.equal(f.calls.some(([method]) => method === "detach"), false);
  f.event("Page.javascriptDialogClosed", { frameId: "child" }); cancelled.resolve(); await rejected; await handle.close();
  assert.deepEqual(decisions(f), [{ accept: false }]); assert.equal(f.risks.size, 0);
});

for (const choice of ["answer", "cancel"]) test(`ambiguous successor blocks queued ${choice} and cleanup waits for original target destruction`, async () => {
  const f = childFixture(), handle = await f.begin(); childOpening(f);
  const pending = choice === "answer" ? answer(handle) : handle.close();
  const rejected = assert.rejects(pending, choice === "answer" ? /DIALOG_STALE/ : /CLEANUP_INCOMPLETE/);
  await Promise.resolve(); assert.deepEqual(decisions(f), []);
  f.event("Page.javascriptDialogClosed", { frameId: "foreign" }); childOpening(f, "nested");
  await rejected; await assert.rejects(handle.close(), /CLEANUP_INCOMPLETE/);
  assert.deepEqual(decisions(f), []); assert.equal(f.risks.size, 1);
  assert.equal(f.calls.some(([method]) => method === "detach"), false);
  f.event("Page.javascriptDialogClosed", { frameId: "child" });
  f.control.observeDetach({ targetId: "original-target" }, "canceled_by_user");
  await assert.rejects(handle.close(), /CLEANUP_INCOMPLETE/);
  f.control.invalidateTab(7, { destroyed: true }); await tick(); await handle.close();
  assert.deepEqual(decisions(f), []); assert.equal(f.risks.size, 0); assert.equal(f.listeners.size, 0);
});

test("ambiguous successor keeps an already dispatched child response and input in original cleanup", async () => {
  const actual = defer(), native = defer();
  const f = childFixture({ command: (method, _params, owner) => {
    if (method === "Input.insertText") { childOpening(owner); return native.promise; }
    if (method === "Page.handleJavaScriptDialog") return actual.promise;
  } });
  const handle = await f.begin(), inserted = input(handle, { type: "text", text: "one original trigger" }); await tick();
  const info = handle.pendingDialog(), response = answer(handle); await tick();
  f.event("Page.javascriptDialogClosed", {}); childOpening(f, "nested");
  let done = false; const closing = handle.close().finally(() => { done = true; }), rejected = assert.rejects(closing, /CLEANUP_INCOMPLETE/);
  await tick(); assert.equal(done, false); assert.deepEqual(decisions(f), [{ accept: true }]);
  assert.equal(f.risks.size, 1); assert.equal(f.calls.some(([method]) => method === "detach"), false);
  actual.resolve(); assert.equal((await response).dialogId, info.dialogId); await rejected;
  f.control.invalidateTab(7, { destroyed: true }); await tick();
  assert.equal(f.risks.size, 1, "destruction does not settle the original native input Promise");
  native.resolve(); assert.equal((await inserted).acknowledged, true); await tick(); await handle.close();
  assert.deepEqual(decisions(f), [{ accept: true }]); assert.equal(f.risks.size, 0);
});

for (const phase of ["focus", "detach"]) test(`late ambiguity during final ${phase} keeps cleanup unconfirmed until original destruction`, async () => {
  const gate = defer(), entered = defer();
  const f = fixture({ command: (method, params) => {
    if (phase === "focus" && method === "Emulation.setFocusEmulationEnabled" && !params.enabled) { entered.resolve(); return gate.promise; }
  }, detach: () => { if (phase === "detach") { entered.resolve(); return gate.promise; } } });
  const handle = await f.begin(); opening(f);
  const closing = handle.close(), rejected = assert.rejects(closing, /CLEANUP_INCOMPLETE/);
  await entered.promise; f.event("Page.javascriptDialogClosed", { frameId: "foreign" }); childOpening(f);
  assert.equal(f.control.current.dialogs.ambiguous, true);
  gate.resolve(); await rejected;
  assert.equal(f.risks.size, 1); assert.notEqual(f.control.current, null);
  assert.deepEqual(decisions(f), [{ accept: false }]);
  assert.equal(f.calls.filter(([method]) => method === "detach").length, phase === "detach" ? 1 : 0);
  await assert.rejects(handle.close(), /CLEANUP_INCOMPLETE/);
  f.control.invalidateTab(7, { destroyed: true }); await tick(); await handle.close();
  assert.equal(f.risks.size, 0); assert.equal(f.control.current, null);
  assert.deepEqual(decisions(f), [{ accept: false }]);
});

test("original detach ACK ends lifecycle admission before asynchronous durable risk removal", async () => {
  const cleared = defer(), entered = defer(), f = fixture({ clearRisk: () => { entered.resolve(); return cleared.promise; } });
  const handle = await f.begin(); opening(f); const closing = handle.close(); await entered.promise;
  const original = f.control.current;
  assert.equal(original.attached, false); assert.equal(original.detachAcknowledged, true); assert.equal(f.risks.size, 1);
  f.event("Page.javascriptDialogClosed", { frameId: "foreign" }); childOpening(f);
  assert.notEqual(original.dialogs.ambiguous, true); assert.deepEqual(decisions(f), [{ accept: false }]);
  cleared.resolve(); await closing; assert.equal(f.risks.size, 0); assert.equal(f.control.current, null);
});

for (const acknowledged of [true, false]) test(`detach ACK cannot settle a cancellation actually sent during detach (${acknowledged})`, async () => {
  const detached = defer(), entered = defer(), cancelled = defer();
  const f = fixture({ detach: () => { entered.resolve(); return detached.promise; },
    command: method => method === "Page.handleJavaScriptDialog" ? cancelled.promise : undefined });
  const handle = await f.begin(); let settled = false;
  const closing = handle.close().finally(() => { settled = true; }); closing.catch(() => {});
  await entered.promise; opening(f); await tick(); assert.deepEqual(decisions(f), [{ accept: false }]);
  detached.resolve(); await tick(); assert.equal(settled, false); assert.equal(f.risks.size, 1);
  if (acknowledged) { cancelled.resolve(); await closing; }
  else {
    const rejected = assert.rejects(closing, /CLEANUP_INCOMPLETE/); cancelled.reject(new Error("native cancellation outcome unknown")); await rejected;
    assert.equal(f.risks.size, 1); assert.notEqual(f.control.current, null);
    f.control.invalidateTab(7, { destroyed: true }); await tick(); await handle.close();
  }
  assert.equal(f.risks.size, 0); assert.deepEqual(decisions(f), [{ accept: false }]);
  assert.equal(f.calls.filter(([method]) => method === "detach").length, 1);
});

test("dialog response bypasses the native input whose ACK requires that same response", async () => {
  const nativeInput = defer(), response = defer(); let f;
  f = fixture({ command: method => {
    if (method === "Input.insertText") { opening(f); return nativeInput.promise; }
    if (method === "Page.handleJavaScriptDialog") { nativeInput.resolve(); return response.promise; }
  } });
  const handle = await f.begin(); const inserted = input(handle, { type: "text", text: "trigger once" }); await tick();
  const dialog = handle.pendingDialog(); assert.equal(dialog.generation, 1);
  const responding = answer(handle); await tick();
  assert.equal((await inserted).acknowledged, true); assert.equal(handle.info().lastInputSequence, 1);
  assert.equal(f.calls.filter(([method]) => method === "Page.handleJavaScriptDialog").length, 1);
  await assert.rejects(input(handle, { type: "text", text: "must not cross modal" }), /DIALOG_BUSY/);
  response.resolve(); assert.deepEqual(await responding, { leaseId: dialog.leaseId, generation: 1, dialogId: dialog.dialogId, acknowledged: true });
  await assert.rejects(input(handle, { type: "text", text: "ACK is not Closed" }), /DIALOG_BUSY/);
  f.event("Page.javascriptDialogClosed", { frameId: "root" }); assert.equal(handle.pendingDialog(), null); await handle.close();
});

test("End cancels an original dialog before waiting for its triggering input and held release", async () => {
  const nativeInput = defer(); let f;
  f = fixture({ command: (method, params) => {
    if (method === "Input.dispatchMouseEvent" && params.type === "mousePressed") { opening(f, { type: "alert" }); return nativeInput.promise; }
    if (method === "Page.handleJavaScriptDialog") { assert.deepEqual(params, { accept: false }); f.event("Page.javascriptDialogClosed", { frameId: "root" }); nativeInput.resolve(); }
  } });
  const handle = await f.begin(), clicked = input(handle, { type: "pointer", action: "down", x: 20, y: 30, button: "left" }); await tick();
  await handle.close(); assert.equal((await clicked).acknowledged, true);
  const cancel = f.calls.findIndex(([method]) => method === "Page.handleJavaScriptDialog");
  const release = f.calls.findIndex(([method, , params]) => method === "Input.dispatchMouseEvent" && params.type === "mouseReleased");
  assert.ok(cancel >= 0 && release > cancel); assert.equal(f.risks.size, 0); assert.equal(f.listeners.size, 0);
});

test("foreign native events cannot offer, close, or answer the original human dialog", async () => {
  const f = fixture(), handle = await f.begin();
  const sources = [{ targetId: "other", tabId: 7 }, { targetId: "original-target", tabId: 8 },
    { targetId: "original-target", sessionId: "child" }, { tabId: 7, extensionId: "worker" }];
  for (const source of sources) opening(f, {}, source);
  assert.equal(handle.pendingDialog(), null); opening(f); const original = handle.pendingDialog();
  for (const source of sources) f.event("Page.javascriptDialogClosed", {}, source);
  assert.deepEqual(handle.pendingDialog(), original);
  f.event("Page.javascriptDialogClosed", { frameId: "root" }); await handle.close();
  assert.equal(f.calls.filter(([method]) => method === "Page.handleJavaScriptDialog").length, 0);
});

test("a read-only original view gains no dialog capability or native response", async () => {
  const f = fixture(), handle = await f.beginView(); opening(f);
  assert.equal(handle.pendingDialog, undefined); assert.equal(handle.respondDialog, undefined);
  assert.throws(() => f.control.send(f.control.current, "Page.handleJavaScriptDialog", { accept: true }), /no native input/);
  await handle.close(); assert.equal(f.calls.filter(([method]) => method === "Page.handleJavaScriptDialog").length, 0);
});

test("beforeunload, unsupported emitter and malformed metadata cancel only the original and retire human control", async () => {
  for (const extra of [{ type: "beforeunload" }, { url: "https://foreign.test/" }, { frameId: "other-frame" }, { frameId: undefined }, { message: "\ud800" }]) {
    const f = fixture(), handle = await f.begin(); opening(f, extra); await handle.close();
    assert.equal(handle.pendingDialog(), null);
    assert.deepEqual(f.calls.filter(([method]) => method === "Page.handleJavaScriptDialog").map(([, , params]) => params), [{ accept: false }]);
    assert.equal(handle.info().state, "released"); assert.equal(f.risks.size, 0);
  }
});

test("unknown dialog response keeps native risk until actual original close or Browser destruction", async () => {
  const f = fixture({ command: method => { if (method === "Page.handleJavaScriptDialog") throw new Error("native response unknown"); } });
  const handle = await f.begin(); opening(f);
  await assert.rejects(answer(handle), /DIALOG_UNCONFIRMED/);
  await assert.rejects(handle.close(), /DIALOG_CLEANUP_INCOMPLETE/); assert.equal(f.risks.size, 1);
  assert.equal(f.calls.some(([method]) => method === "detach"), false);
  f.event("Page.javascriptDialogClosed", { frameId: "root" }); await handle.close(); assert.equal(f.risks.size, 0);
  assert.equal(f.calls.filter(([method]) => method === "Page.handleJavaScriptDialog").length, 1);
});

test("dialog admission rechecks original policy and lifetime at the actual native dispatch", async () => {
  let permitted = true;
  const f = fixture({ assertDialog: () => { if (!permitted) throw new Error("original policy revoked"); } }), handle = await f.begin(); opening(f);
  const response = answer(handle), rejected = assert.rejects(response, /DIALOG_STALE/); permitted = false;
  await rejected; await handle.close();
  assert.deepEqual(f.calls.filter(([method]) => method === "Page.handleJavaScriptDialog").map(([, , params]) => params), [{ accept: false }]);
});

test("a modal opening during durable input admission prevents that unsent page command", async () => {
  const durable = defer(); let marks = 0;
  const f = fixture({ markRisk: () => ++marks === 2 ? durable.promise : undefined }), handle = await f.begin();
  const pending = input(handle, { type: "text", text: "must stay unsent" }); const rejected = assert.rejects(pending, /DIALOG_BUSY/);
  await tick(); opening(f); durable.resolve(); await rejected; await handle.close();
  assert.equal(f.calls.filter(([method]) => method === "Input.insertText").length, 0);
  assert.deepEqual(f.calls.filter(([method]) => method === "Page.handleJavaScriptDialog").map(([, , params]) => params), [{ accept: false }]);
});

test("native input waits through 45 seconds of original modal thinking with one original ACK", async () => {
  const timing = manualTiming(), native = defer(); let f;
  f = fixture({ timing, command: method => {
    if (method === "Input.insertText") { opening(f); return native.promise; }
    if (method === "Page.handleJavaScriptDialog") { f.event("Page.javascriptDialogClosed", { frameId: "root" }); native.resolve(); }
  } });
  const handle = await f.begin(); assert.equal(handle.info().inputBudgetVersion, 1);
  const observed = input(handle, { type: "text", text: "original" }); await tick();
  const actual = f.control.current.epoch.inputPending;
  assert.notEqual(observed, actual); timing.advance(45000); assert.equal(handle.info().state, "active");
  assert.equal(f.control.current.epoch.inputPending, actual); await answer(handle);
  assert.equal((await observed).acknowledged, true); assert.equal(f.calls.filter(([m]) => m === "Input.insertText").length, 1);
  await handle.close(); assert.equal(timing.timers.size, 0);
});

test("ordinary expiry revokes immediately while late down ACK and actual held release remain cleanup obligations", async () => {
  const timing = manualTiming(), down = defer(), released = defer();
  const f = fixture({ timing, command: (method, params) => {
    if (method === "Input.dispatchMouseEvent" && params.type === "mousePressed") return down.promise;
    if (method === "Input.dispatchMouseEvent" && params.type === "mouseReleased") return released.promise;
  } });
  const handle = await f.begin(), observed = input(handle, { type: "pointer", action: "down", x: 1, y: 1, button: "left" });
  const rejected = assert.rejects(observed, /INPUT_TIMEOUT/); await tick();
  const record = f.control.current, actual = record.epoch.inputPending; timing.advance(30000);
  assert.equal(record.revoked, true); assert.equal(record.epoch.inputPending, actual); await rejected;
  assert.equal(f.risks.size, 1); assert.equal(f.calls.some(([m]) => m === "detach"), false);
  let closed = false; const closing = handle.close().then(() => { closed = true; });
  down.resolve(); assert.equal((await actual).acknowledged, true); await tick();
  assert.equal(closed, false); assert.equal(f.calls.filter(([m,,p]) => m === "Input.dispatchMouseEvent" && p.type === "mouseReleased").length, 1);
  released.resolve(); await closing; assert.equal(f.risks.size, 0); assert.equal(timing.timers.size, 0);
});

test("an original dialog without pending input expires once and joins its real cancellation ACK", async () => {
  const timing = manualTiming(), cancel = defer(), f = fixture({ timing, command: method => method === "Page.handleJavaScriptDialog" ? cancel.promise : undefined });
  const handle = await f.begin(); opening(f); timing.advance(299999); assert.equal(handle.info().state, "active");
  timing.advance(1); assert.equal(f.control.current.revoked, true); assert.equal(handle.pendingDialog(), null); await tick();
  assert.deepEqual(f.calls.filter(([m]) => m === "Page.handleJavaScriptDialog").map(([, , p]) => p), [{ accept: false }]);
  let closed = false; const closing = handle.close().then(() => { closed = true; }); await tick();
  assert.equal(closed, false); assert.equal(f.risks.size, 1); cancel.resolve(); await closing;
  assert.equal(f.risks.size, 0); assert.equal(timing.timers.size, 0);
});

test("two modal periods share the original input cap while old response ACK is independently pending", async () => {
  const timing = manualTiming(), native = defer(), firstACK = defer(); let f, responses = 0;
  f = fixture({ timing, command: method => {
    if (method === "Input.insertText") { opening(f); return native.promise; }
    if (method === "Page.handleJavaScriptDialog") {
      if (++responses === 1) { f.event("Page.javascriptDialogClosed", { frameId: "root" }); opening(f, { message: "second" }); return firstACK.promise; }
      f.event("Page.javascriptDialogClosed", { frameId: "root" }); native.resolve();
    }
  } });
  const handle = await f.begin(), observed = input(handle, { type: "text", text: "one native command" });
  const rejected = assert.rejects(observed, /INPUT_TIMEOUT.*modal/); await tick(); timing.advance(180000);
  const first = answer(handle); await tick(); const second = handle.pendingDialog();
  timing.advance(119999); assert.equal(handle.pendingDialog().dialogId, second.dialogId); timing.advance(1);
  assert.equal(f.control.current.revoked, true); await rejected; await tick();
  assert.equal(responses, 2); assert.equal(f.calls.filter(([m]) => m === "Input.insertText").length, 1);
  let closed = false; const closing = handle.close().then(() => { closed = true; }); await tick(); assert.equal(closed, false);
  firstACK.resolve(); assert.equal((await first).acknowledged, true); await closing; assert.equal(timing.timers.size, 0);
});

for (const boundary of ["response admission", "final native guard"]) {
  test(`cumulative modal expiry withdraws a new choice at ${boundary} even before its timer runs`, async () => {
    const timing = manualTiming(), native = defer(), firstACK = defer(); let f, responses = 0;
    f = fixture({ timing, command: method => {
      if (method === "Input.insertText") { opening(f); return native.promise; }
      if (method === "Page.handleJavaScriptDialog") {
        if (++responses === 1) { f.event("Page.javascriptDialogClosed", { frameId: "root" }); opening(f, { message: "second" }); return firstACK.promise; }
        f.event("Page.javascriptDialogClosed", { frameId: "root" }); native.resolve();
      }
    } });
    const handle = await f.begin(), observed = input(handle, { type: "text", text: "one original command" });
    const inputOutcome = observed.then(value => ({ value }), error => ({ error }));
    await tick(); timing.advance(180000); const first = answer(handle); await tick();
    const second = handle.pendingDialog();
    timing.skip(boundary === "response admission" ? 120001 : 119999);
    const responseOutcome = answer(handle).then(value => ({ value }), error => ({ error }));
    if (boundary === "final native guard") timing.skip(2);
    const outcome = await responseOutcome;
    await tick(); firstACK.resolve(); assert.equal((await first).acknowledged, true);
    const expiredInput = await inputOutcome; await handle.close();
    assert.deepEqual(f.calls.filter(([m]) => m === "Page.handleJavaScriptDialog").map(([, , p]) => p), [{ accept: true }, { accept: false }]);
    assert.match(expiredInput.error?.message ?? "", /INPUT_TIMEOUT.*modal/);
    assert.match(outcome.error?.message ?? "", /DIALOG_STALE/);
    assert.ok(second.dialogId); assert.equal(f.calls.filter(([m]) => m === "Input.insertText").length, 1);
    assert.equal(f.risks.size, 0); assert.equal(timing.timers.size, 0);
  });
}

test("dialog response cannot extend an unsent input's ordinary budget when its timer runs late", async () => {
  const timing = manualTiming(), durable = defer(); let f, marks = 0;
  f = fixture({ timing, markRisk: () => ++marks === 2 ? durable.promise : undefined,
    command: method => { if (method === "Page.handleJavaScriptDialog") f.event("Page.javascriptDialogClosed", { frameId: "root" }); } });
  const handle = await f.begin(), observed = input(handle, { type: "text", text: "must remain unsent" });
  const inputOutcome = observed.then(value => ({ value }), error => ({ error }));
  await tick(); opening(f); timing.skip(30001);
  const outcome = await answer(handle).then(value => ({ value }), error => ({ error }));
  await tick(); durable.resolve(); const expiredInput = await inputOutcome; await handle.close();
  assert.deepEqual(f.calls.filter(([m]) => m === "Page.handleJavaScriptDialog").map(([, , p]) => p), [{ accept: false }]);
  assert.match(outcome.error?.message ?? "", /DIALOG_STALE/);
  assert.match(expiredInput.error?.message ?? "", /INPUT_TIMEOUT.*normal/);
  assert.equal(f.calls.some(([m]) => m === "Input.insertText"), false);
  assert.equal(f.risks.size, 0); assert.equal(timing.timers.size, 0);
});

test("a modal that closes during unsent durable admission cannot cause a late page input", async () => {
  const timing = manualTiming(), durable = defer(); let marks = 0;
  const f = fixture({ timing, markRisk: () => ++marks === 2 ? durable.promise : undefined }), handle = await f.begin();
  const observed = input(handle, { type: "text", text: "must never dispatch" });
  const rejected = assert.rejects(observed, /DIALOG_BUSY/); await tick(); opening(f); f.event("Page.javascriptDialogClosed", { frameId: "root" });
  durable.resolve(); await rejected; await handle.close();
  assert.equal(f.calls.some(([m]) => m === "Input.insertText"), false); assert.equal(timing.timers.size, 0);
});

test("preflight receives no modal allowance and cannot dispatch after ordinary expiry", async () => {
  const timing = manualTiming(), durable = defer(); let marks = 0;
  const f = fixture({ timing, markRisk: () => ++marks === 2 ? durable.promise : undefined }), handle = await f.begin();
  const observed = input(handle, { type: "text", text: "never sent" }), rejected = assert.rejects(observed, /INPUT_TIMEOUT.*normal/);
  await tick(); opening(f); timing.advance(30000); assert.equal(f.control.current.revoked, true); await rejected;
  const actual = f.control.current.epoch.inputPending; durable.resolve(); await assert.rejects(actual, /revoked|DIALOG_BUSY/); await handle.close();
  assert.equal(f.calls.some(([m]) => m === "Input.insertText"), false); assert.equal(timing.timers.size, 0);
});

test("read-only view never advertises the longer input budget", async () => {
  const f = fixture(), handle = await f.beginView(); assert.equal(Object.hasOwn(handle.info(), "inputBudgetVersion"), false); await handle.close();
});

test("final native guard refuses late preflight completion even before the timer callback runs", async () => {
  const timing = manualTiming(), durable = defer(); let marks = 0;
  const f = fixture({ timing, markRisk: () => ++marks === 2 ? durable.promise : undefined }), handle = await f.begin();
  const observed = input(handle, { type: "text", text: "not dispatched" }), rejected = assert.rejects(observed, /INPUT_TIMEOUT/);
  await tick(); timing.skip(30001); durable.resolve(); await rejected; await handle.close();
  assert.equal(f.calls.some(([m]) => m === "Input.insertText"), false); assert.equal(timing.timers.size, 0);
});

test("late original Closed expires its dialog cap without cancelling an already closed modal", async () => {
  const timing = manualTiming(), f = fixture({ timing }), handle = await f.begin(); opening(f);
  timing.skip(300001); f.event("Page.javascriptDialogClosed", { frameId: "root" }); assert.equal(f.control.current.revoked, true);
  await handle.close(); assert.equal(f.calls.some(([m]) => m === "Page.handleJavaScriptDialog"), false);
});

test("late dialog choice is withdrawn at the final native guard, even when its timer callback is delayed", async () => {
  const timing = manualTiming(), f = fixture({ timing }), handle = await f.begin(); opening(f);
  const responding = answer(handle), rejected = assert.rejects(responding, /DIALOG_STALE/); timing.skip(300001);
  await rejected; await handle.close();
  assert.deepEqual(f.calls.filter(([m]) => m === "Page.handleJavaScriptDialog").map(([, , p]) => p), [{ accept: false }]);
});

test("dialog expiry joins an already dispatched decision and never sends a cancellation retry", async () => {
  const timing = manualTiming(), native = defer(), f = fixture({ timing, command: method => method === "Page.handleJavaScriptDialog" ? native.promise : undefined });
  const handle = await f.begin(); opening(f); timing.advance(299000); const responding = answer(handle); await tick();
  timing.advance(1000); assert.equal(f.control.current.revoked, true);
  let closed = false; const closing = handle.close().then(() => { closed = true; }); await tick();
  assert.equal(closed, false); assert.deepEqual(f.calls.filter(([m]) => m === "Page.handleJavaScriptDialog").map(([, , p]) => p), [{ accept: true }]);
  native.resolve(); assert.equal((await responding).acknowledged, true); await closing; assert.equal(timing.timers.size, 0);
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

test("verified Control and Meta holds permit ordered direct text without synthesizing release", async () => {
  const control = code => ({ key: "Control", code, windowsVirtualKeyCode: 17 });
  const meta = (code, windowsVirtualKeyCode) => ({ key: "Meta", code, windowsVirtualKeyCode });
  const shift = { key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16 };
  for (const keys of [[control("ControlLeft")], [control("ControlRight")], [meta("MetaLeft", 91)], [meta("MetaRight", 92)],
    [control("ControlLeft"), shift], [meta("MetaLeft", 91), shift]]) {
    const f = fixture(), handle = await f.begin();
    try {
      for (const key of keys) await input(handle, { type: "key", action: "down", ...key });
      const held = [...f.control.current.epoch.keys.entries()];
      for (const text of ["原始文本🙂\n", "连续第二次\t"]) {
        const original = handle.info(), receipt = await input(handle, { type: "text", text });
        assert.deepEqual(receipt, { leaseId: original.leaseId, generation: original.generation, sequence: original.lastInputSequence + 1, acknowledged: true });
        assert.deepEqual([...f.control.current.epoch.keys.entries()], held);
        for (const [code, key] of held) assert.equal(f.control.current.epoch.keys.get(code), key);
      }
      assert.deepEqual(f.calls.filter(([method]) => method === "Input.insertText").map(([, , params]) => params), [{ text: "原始文本🙂\n" }, { text: "连续第二次\t" }]);
      assert.equal(f.calls.filter(([method, , params]) => method === "Input.dispatchKeyEvent" && params.type === "keyUp").length, 0);
      for (const key of [...keys].reverse()) await input(handle, { type: "key", action: "up", ...key });
      assert.equal(f.control.current.epoch.keys.size, 0);
      assert.deepEqual(f.calls.filter(([method, , params]) => method === "Input.dispatchKeyEvent" && params.type === "keyUp").map(([, , params]) => params.code), [...keys].reverse().map(key => key.code));
    } finally { await handle.close(); }
    assert.equal(f.risks.size, 0);
  }
});

test("closing Control-held text joins the original insertion and exact release before detach", async () => {
  const inserted = defer(), released = defer(), releaseEntered = defer();
  const f = fixture({ command: (method, params) => {
    if (method === "Input.insertText") return inserted.promise;
    if (method === "Input.dispatchKeyEvent" && params.type === "keyUp") { releaseEntered.resolve(); return released.promise; }
  } });
  const handle = await f.begin();
  await input(handle, { type: "key", action: "down", key: "Control", code: "ControlRight", windowsVirtualKeyCode: 17, modifiers: 2 });
  const pending = input(handle, { type: "text", text: "original known text" }); pending.catch(() => {}); await tick();
  assert.equal(f.calls.filter(([method]) => method === "Input.insertText").length, 1);
  let closed = false; const closing = handle.close().then(() => { closed = true; });
  await handle.closed; await tick(); assert.equal(closed, false);
  assert.equal(f.calls.some(([method, , params]) => method === "Input.dispatchKeyEvent" && params.type === "keyUp"), false);
  inserted.resolve(); assert.equal((await pending).acknowledged, true); await releaseEntered.promise;
  assert.equal(closed, false); assert.equal(f.calls.some(([method]) => method === "detach"), false);
  released.resolve(); await closing;
  assert.equal(f.calls.filter(([method]) => method === "Input.insertText").length, 1);
  assert.deepEqual(f.calls.filter(([method, , params]) => method === "Input.dispatchKeyEvent" && params.type === "keyUp").map(([, , params]) => [params.code, params.windowsVirtualKeyCode]), [["ControlRight", 17]]);
  assert.equal(f.risks.size, 0); f.control.assertReleased();
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

test("text still rejects other held keys, false modifier identities, and held mouse buttons", async () => {
  const keys = [
    { key: "Alt", code: "AltRight", windowsVirtualKeyCode: 18 },
    { key: "A", code: "KeyA", windowsVirtualKeyCode: 65 },
    { key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 16 },
    { key: "Control", code: "ControlRight", windowsVirtualKeyCode: 18 },
    { key: "Meta", code: "MetaLeft", windowsVirtualKeyCode: 92 },
    { key: "Meta", code: "MetaRight", windowsVirtualKeyCode: 91 },
    { key: "Control", code: "KeyA", windowsVirtualKeyCode: 17 },
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

test("an admitted startup failure retains the original unconfirmed cleanup barrier", async () => {
  const focus = defer(), entered = defer(); let failDetach = true;
  const f = fixture({ command: (method, params) => {
    if (method === "Emulation.setFocusEmulationEnabled" && params.enabled) { entered.resolve(); return focus.promise; }
  }, detach: () => { if (failDetach) throw new Error("original detach unconfirmed"); } });
  const handle = await f.beginAdmitted(); await entered.promise; f.expire(); focus.resolve();
  assert.match((await handle.closed).reason, /lease expired/);
  await assert.rejects(handle.close(), /original detach unconfirmed/);
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

for (const code of ["Enter", "NumpadEnter"]) for (const shifted of [false, true])
test(`native Enter editing uses one combined down and original up (${code}, Shift=${shifted})`, async () => {
  const f = fixture(), handle = await f.begin();
  const key = { key: "Enter", code, windowsVirtualKeyCode: 13 }, modifiers = shifted ? 8 : 0;
  const shift = { type: "key", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16 };
  try {
    if (shifted) await input(handle, { ...shift, action: "down", modifiers });
    const before = handle.info();
    const receipt = await input(handle, { type: "key", action: "down", ...key, modifiers });
    assert.deepEqual(receipt, { leaseId: before.leaseId, generation: before.generation, sequence: before.lastInputSequence + 1, acknowledged: true });
    await assert.rejects(input(handle, { type: "key", action: "down", ...key, modifiers }), /key hold does not match/);
    await input(handle, { type: "key", action: "up", ...key, modifiers });
    if (shifted) await input(handle, { ...shift, action: "up", modifiers: 0 });
    const events = f.calls.filter(([method, , params]) => method === "Input.dispatchKeyEvent" && params.code === code);
    assert.deepEqual(events.map(row => row[2]), [
      { ...key, type: "keyDown", modifiers, text: "\r", unmodifiedText: "\r" },
      { ...key, type: "keyUp", modifiers }
    ]);
    assert.ok(events.every(row => row[1].targetId === "original-target"));
    assert.equal(f.calls.some(([method]) => method === "Input.insertText"), false, "Native Enter must not synthesize a separate text commit");
  } finally { await handle.close(); }
  assert.equal(f.risks.size, 0); assert.equal(f.listeners.size, 0);
});

test("native Enter special semantics require the exact key/code/VK identity and no shortcut modifiers", async () => {
  const f = fixture(), handle = await f.begin();
  const base = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 };
  const candidates = [
    { ...base, key: "Return" }, { ...base, key: "enter" },
    { ...base, code: "KeyA" }, { ...base, code: "NumpadAdd" },
    { ...base, windowsVirtualKeyCode: 65 }, { ...base, code: "NumpadEnter", windowsVirtualKeyCode: 108 },
    ...Array.from({ length: 16 }, (_, modifiers) => modifiers).filter(value => value !== 0 && value !== 8).map(modifiers => ({ ...base, modifiers }))
  ];
  try {
    for (const value of candidates) {
      const { modifiers = 0, ...key } = value;
      await input(handle, { type: "key", action: "down", ...value });
      await input(handle, { type: "key", action: "up", ...value });
      assert.deepEqual(f.calls.filter(([method]) => method === "Input.dispatchKeyEvent").slice(-2).map(row => row[2]), [
        { ...key, type: "rawKeyDown", modifiers }, { ...key, type: "keyUp", modifiers }
      ]);
    }
    assert.equal(f.calls.some(([method]) => method === "Input.insertText"), false);
  } finally { await handle.close(); }
});

test("native Enter cancelled before actual dispatch emits neither key nor text", async () => {
  const gate = defer(), entered = defer(); let held = false;
  const f = fixture({ validate: () => { if (held) { entered.resolve(); return gate.promise; } } }), handle = await f.begin();
  held = true;
  const pending = input(handle, { type: "key", action: "down", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  const rejected = assert.rejects(pending, /revoked|cancelled/); await entered.promise;
  const closing = handle.close(); await handle.closed; gate.resolve(); await rejected; await closing;
  assert.equal(f.calls.some(([method]) => method.startsWith("Input.")), false);
  assert.equal(f.risks.size, 0); f.control.assertReleased();
});

test("native Enter End joins its original pending down ACK before exact key release and detach", async () => {
  const down = defer(), entered = defer();
  const f = fixture({ command: (method, params) => {
    if (method === "Input.dispatchKeyEvent" && params.type !== "keyUp") { entered.resolve(); return down.promise; }
  } }), handle = await f.begin(), info = handle.info();
  const key = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 };
  const pending = input(handle, { type: "key", action: "down", ...key }); await entered.promise;
  let closed = false; const closing = handle.close().then(() => { closed = true; }); await handle.closed; await tick();
  assert.equal(closed, false); assert.equal(f.calls.some(([method]) => method === "detach"), false);
  assert.equal(f.calls.filter(([method]) => method.startsWith("Input.")).length, 1);
  down.resolve(); assert.deepEqual(await pending, { leaseId: info.leaseId, generation: info.generation, sequence: 1, acknowledged: true });
  await closing;
  const events = f.calls.filter(([method]) => method === "Input.dispatchKeyEvent");
  assert.deepEqual(events.map(row => row[2]), [
    { ...key, type: "keyDown", modifiers: 0, text: "\r", unmodifiedText: "\r" },
    { ...key, type: "keyUp", modifiers: 0 }
  ]);
  assert.ok(f.calls.indexOf(events[1]) < f.calls.findIndex(([method]) => method === "detach"));
  assert.equal(f.calls.some(([method]) => method === "Input.insertText"), false);
  assert.equal(f.risks.size, 0); f.control.assertReleased();
});

test("native Enter navigation keeps its original late ACK and finishes one keyUp before the next stream", async () => {
  const down = defer(), downEntered = defer(), release = defer(), releaseEntered = defer();
  const f = fixture({ command: (method, params) => {
    if (method !== "Input.dispatchKeyEvent") return;
    if (params.type === "keyUp") { releaseEntered.resolve(); return release.promise; }
    downEntered.resolve(); return down.promise;
  } }), handle = await f.begin(), original = handle.info();
  const key = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 };
  const pending = input(handle, { type: "key", action: "down", ...key }); await downEntered.promise;
  f.changeDocument("B"); f.control.navigation(7, { frameId: 0 }, "committed");
  await tick(); assert.equal(f.calls.filter(([method]) => method === "Page.startScreencast").length, 1);
  down.resolve(); assert.deepEqual(await pending, { leaseId: original.leaseId, generation: original.generation, sequence: 1, acknowledged: true });
  await releaseEntered.promise; assert.equal(handle.info().lastInputSequence, 0);
  assert.equal(f.calls.filter(([method]) => method === "Page.startScreencast").length, 1);
  release.resolve(); await f.control.current.recovery;
  assert.equal(handle.info().generation, 2); assert.equal(handle.info().lastInputSequence, 0);
  await assert.rejects(input(handle, { type: "key", action: "up", ...key }), /key hold does not match/);
  await handle.close();
  assert.deepEqual(f.calls.filter(([method]) => method === "Input.dispatchKeyEvent").map(row => row[2]), [
    { ...key, type: "keyDown", modifiers: 0, text: "\r", unmodifiedText: "\r" }, { ...key, type: "keyUp", modifiers: 0 }
  ]);
  assert.equal(f.calls.some(([method]) => method === "Input.insertText"), false); assert.equal(f.risks.size, 0);
});

test("native Enter dialog-triggering down is cancelled before its original ACK and single held release", async () => {
  const down = defer(), entered = defer(); let f;
  f = fixture({ command: (method, params) => {
    if (method === "Input.dispatchKeyEvent" && params.type !== "keyUp") { opening(f, { type: "alert" }); entered.resolve(); return down.promise; }
    if (method === "Page.handleJavaScriptDialog") {
      assert.deepEqual(params, { accept: false }); f.event("Page.javascriptDialogClosed", { frameId: "root" }); down.resolve();
    }
  } });
  const handle = await f.begin(), original = handle.info(), key = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 };
  const pending = input(handle, { type: "key", action: "down", ...key }); await entered.promise;
  assert.ok(handle.pendingDialog()); await handle.close();
  assert.deepEqual(await pending, { leaseId: original.leaseId, generation: original.generation, sequence: 1, acknowledged: true });
  const events = f.calls.filter(([method]) => method === "Input.dispatchKeyEvent");
  assert.deepEqual(events.map(row => row[2]), [
    { ...key, type: "keyDown", modifiers: 0, text: "\r", unmodifiedText: "\r" }, { ...key, type: "keyUp", modifiers: 0 }
  ]);
  assert.equal(f.calls.filter(([method]) => method === "Page.handleJavaScriptDialog").length, 1);
  assert.ok(f.calls.findIndex(([method]) => method === "Page.handleJavaScriptDialog") < f.calls.indexOf(events[1]));
  assert.equal(f.calls.some(([method]) => method === "Input.insertText"), false); assert.equal(f.risks.size, 0);
});

test("native Enter unknown down failure is never replayed and cleanup contains only original keyUp", async () => {
  const failure = new Error("original Enter result unknown"), key = { key: "Enter", code: "NumpadEnter", windowsVirtualKeyCode: 13 };
  const f = fixture({ command: (method, params) => { if (method === "Input.dispatchKeyEvent" && params.type !== "keyUp") throw failure; } }), handle = await f.begin();
  await assert.rejects(input(handle, { type: "key", action: "down", ...key }), error => error === failure);
  await handle.close();
  assert.deepEqual(f.calls.filter(([method]) => method === "Input.dispatchKeyEvent").map(row => row[2]), [
    { ...key, type: "keyDown", modifiers: 0, text: "\r", unmodifiedText: "\r" }, { ...key, type: "keyUp", modifiers: 0 }
  ]);
  assert.equal(f.calls.some(([method]) => method === "Input.insertText"), false); assert.equal(f.risks.size, 0);
});

test("native repeat capability belongs only to human leases", async () => {
  const f = fixture(), human = await f.begin();
  assert.equal(human.info().keyRepeatVersion, 1); await human.close();
  const view = await f.beginView(); assert.equal(Object.hasOwn(view.info(), "keyRepeatVersion"), false); await view.close();
});

for (const key of [{ key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
  { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
  { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 },
  { key: "Enter", code: "NumpadEnter", windowsVirtualKeyCode: 13 }])
test(`native repeat preserves separate original acknowledgements (${key.code})`, async () => {
  const f = fixture(), handle = await f.begin(), original = handle.info();
  try {
    await input(handle, { type: "key", action: "down", ...key });
    const held = f.control.current.epoch.keys.get(key.code);
    for (let sequence = 2; sequence <= 3; sequence++) {
      assert.deepEqual(await input(handle, { type: "key", action: "down", ...key, repeat: true }),
        { leaseId: original.leaseId, generation: original.generation, sequence, acknowledged: true });
      assert.equal(f.control.current.epoch.keys.get(key.code), held);
    }
    await input(handle, { type: "key", action: "up", ...key });
    const events = f.calls.filter(([method]) => method === "Input.dispatchKeyEvent").map(row => row[2]);
    const character = key.key === "Enter" ? { text: "\r", unmodifiedText: "\r" } : {};
    const down = { ...key, type: key.key === "Enter" ? "keyDown" : "rawKeyDown", modifiers: 0, ...character };
    assert.deepEqual(events, [down, { ...down, autoRepeat: true }, { ...down, autoRepeat: true }, { ...key, type: "keyUp", modifiers: 0 }]);
    assert.equal(f.calls.some(([method]) => method === "Input.insertText"), false);
  } finally { await handle.close(); }
});

test("native repeat accepts changed DOM key and modifiers but keeps the original held identity", async () => {
  const f = fixture(), handle = await f.begin(), key = { key: "A", code: "KeyA", windowsVirtualKeyCode: 65 };
  try {
    await input(handle, { type: "key", action: "down", ...key, modifiers: 8 });
    const held = f.control.current.epoch.keys.get(key.code);
    await input(handle, { type: "key", action: "down", ...key, key: "a", repeat: true, modifiers: 0 });
    assert.equal(f.control.current.epoch.keys.get(key.code), held);
    await input(handle, { type: "key", action: "up", ...key, key: "a" });
    assert.deepEqual(f.calls.filter(([method]) => method === "Input.dispatchKeyEvent").map(row => row[2]), [
      { ...key, type: "rawKeyDown", modifiers: 8 }, { ...key, key: "a", type: "rawKeyDown", modifiers: 0, autoRepeat: true },
      { ...key, type: "keyUp", modifiers: 0 }
    ]);
  } finally { await handle.close(); }
});

test("native repeat rejects invalid spelling, missing original holds and changed physical identity without sending", async () => {
  const f = fixture(), handle = await f.begin(), key = { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 };
  try {
    const invalid = [false, null, 0, 1, "true", undefined].map(repeat => ({ type: "key", action: "down", ...key, repeat }));
    invalid.push({ type: "key", action: "up", ...key, repeat: true }, { type: "text", text: "x", repeat: true },
      { type: "pointer", action: "move", x: 1, y: 1, repeat: true }, { type: "wheel", x: 1, y: 1, deltaX: 0, deltaY: 1, repeat: true },
      { type: "key", action: "down", ...key, repeat: true });
    for (const value of invalid) await assert.rejects(input(handle, value), /OBU_HUMAN_INVALID/);
    assert.equal(f.calls.some(([method]) => method.startsWith("Input.")), false);
    await input(handle, { type: "key", action: "down", ...key });
    await assert.rejects(input(handle, { type: "key", action: "down", ...key }), /key hold does not match/);
    await assert.rejects(input(handle, { type: "key", action: "down", ...key, windowsVirtualKeyCode: 39, repeat: true }), /original virtual key/);
    await assert.rejects(input(handle, { type: "key", action: "down", ...key, code: "ArrowRight", repeat: true }), /key hold does not match/);
    assert.equal(handle.info().lastInputSequence, 1);
    await input(handle, { type: "key", action: "up", ...key });
    await assert.rejects(input(handle, { type: "key", action: "down", ...key, repeat: true }), /key hold does not match/);
  } finally { await handle.close(); }
});

test("native repeat cannot precede its original down ACK or overlap another repeat ACK", async () => {
  const first = defer(), firstEntered = defer(), repeat = defer(), repeatEntered = defer();
  const f = fixture({ command: (method, params) => {
    if (method !== "Input.dispatchKeyEvent" || params.type === "keyUp") return;
    if (params.autoRepeat) { repeatEntered.resolve(); return repeat.promise; }
    firstEntered.resolve(); return first.promise;
  } }), handle = await f.begin(), key = { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 };
  try {
    const pending = input(handle, { type: "key", action: "down", ...key }); await firstEntered.promise;
    await assert.rejects(input(handle, { type: "key", action: "down", ...key, repeat: true }), /OBU_HUMAN_BUSY/);
    first.resolve(); await pending;
    const repeated = input(handle, { type: "key", action: "down", ...key, repeat: true });
    await Promise.race([repeatEntered.promise, repeated]);
    await assert.rejects(input(handle, { type: "key", action: "down", ...key, repeat: true }), /OBU_HUMAN_BUSY/);
    assert.equal(handle.info().lastInputSequence, 1); repeat.resolve(); assert.equal((await repeated).sequence, 2);
  } finally { first.resolve(); repeat.resolve(); await handle.close(); }
});

for (const boundary of ["End", "navigation", "unknown"])
test(`native repeat ${boundary} joins the actual pending command and releases the original key once`, async () => {
  const repeated = defer(), entered = defer(), key = { key: "A", code: "KeyA", windowsVirtualKeyCode: 65 };
  const f = fixture({ command: (method, params) => {
    if (method === "Input.dispatchKeyEvent" && params.autoRepeat) { entered.resolve(); return repeated.promise; }
  } }), handle = await f.begin(), original = handle.info();
  try {
    await input(handle, { type: "key", action: "down", ...key, modifiers: 8 });
    const pending = input(handle, { type: "key", action: "down", ...key, key: "a", repeat: true });
    await Promise.race([entered.promise, pending]);
    let closing, closed = false;
    if (boundary === "End") closing = handle.close().then(() => { closed = true; });
    if (boundary === "navigation") { f.changeDocument("repeat-next"); f.control.navigation(7, { frameId: 0 }, "committed"); }
    await tick(); assert.equal(closed, false);
    assert.equal(f.calls.some(([method, , params]) => method === "Input.dispatchKeyEvent" && params.type === "keyUp"), false);
    if (boundary === "unknown") {
      const failure = new Error("original repeat native outcome unknown"), rejected = assert.rejects(pending, error => error === failure);
      repeated.reject(failure); await rejected; await handle.close();
    } else {
      repeated.resolve(); assert.deepEqual(await pending, { leaseId: original.leaseId, generation: original.generation, sequence: 2, acknowledged: true });
      if (closing) await closing;
      else {
        await f.control.current.recovery; assert.equal(handle.info().lastInputSequence, 0);
        await assert.rejects(input(handle, { type: "key", action: "down", ...key, repeat: true }), /key hold does not match/);
      }
    }
    const events = f.calls.filter(([method]) => method === "Input.dispatchKeyEvent").map(row => row[2]);
    assert.deepEqual(events, [{ ...key, type: "rawKeyDown", modifiers: 8 },
      { ...key, key: "a", type: "rawKeyDown", modifiers: 0, autoRepeat: true }, { ...key, type: "keyUp", modifiers: 0 }]);
    assert.equal(f.calls.some(([method]) => method === "Input.insertText"), false);
  } finally { repeated.resolve(); await handle.close(); }
});

test("native repeat triggering a dialog is cancelled before its original ACK and original key release", async () => {
  const repeated = defer(), entered = defer(); let f;
  const key = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 };
  f = fixture({ command: (method, params) => {
    if (method === "Input.dispatchKeyEvent" && params.autoRepeat) { opening(f, { type: "alert" }); entered.resolve(); return repeated.promise; }
    if (method === "Page.handleJavaScriptDialog") { assert.deepEqual(params, { accept: false }); f.event("Page.javascriptDialogClosed", { frameId: "root" }); repeated.resolve(); }
  } });
  const handle = await f.begin(), original = handle.info();
  try {
    await input(handle, { type: "key", action: "down", ...key });
    const pending = input(handle, { type: "key", action: "down", ...key, repeat: true }); await Promise.race([entered.promise, pending]);
    assert.ok(handle.pendingDialog()); await handle.close();
    assert.deepEqual(await pending, { leaseId: original.leaseId, generation: original.generation, sequence: 2, acknowledged: true });
    const events = f.calls.filter(([method]) => method === "Input.dispatchKeyEvent");
    assert.equal(events.length, 3); assert.equal(events[1][2].autoRepeat, true); assert.equal(events[1][2].text, "\r");
    assert.deepEqual(events[2][2], { ...key, type: "keyUp", modifiers: 0 });
    assert.ok(f.calls.findIndex(([method]) => method === "Page.handleJavaScriptDialog") < f.calls.indexOf(events[2]));
  } finally { repeated.resolve(); await handle.close(); }
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
  assert.equal(f.control.status().viewport, null); assert.equal(f.control.status().generation, 1);
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
  assert.deepEqual(original.tabInfo(), { id: 7, title: "页面正在准备", url: "" });
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
  assert.deepEqual(Object.keys(handle.info()).sort(), ["fileChooserVersion", "generation", "inputBudgetVersion", "keyRepeatVersion", "lastInputSequence", "leaseId", "pointerClickCountVersion", "state", "tabId", "viewport"]);
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
  const releasing = defer(), entered = defer(), timing = manualTiming();
  const f = fixture({ timing, command: (method, params) => {
    if (method === "Input.dispatchKeyEvent" && params.type === "keyUp") { entered.resolve(); return releasing.promise; }
  } }), handle = await f.begin();
  await input(handle, { type: "key", action: "down", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16 });
  f.control.navigation(7, { frameId: 0 }, "pending"); timing.advance(10000); await entered.promise;
  assert.match((await handle.closed).reason, /OBU_HUMAN_PREPARATION_TIMEOUT/);
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

test("view hidden surface capture follows the original start ACK and cannot replace a fresh frame ACK", async t => {
  const start = defer(), startEntered = defer(), captured = defer(), ack = defer(), freshAckEntered = defer(); let acks = 0;
  const f = fixture({ frames: false, command: (method, params, target) => {
    if (method === "Page.startScreencast") { startEntered.resolve(); return start.promise; }
    if (method === "Page.captureScreenshot") {
      assert.deepEqual(target, { targetId: "original-target" });
      assert.deepEqual(params, { format: "png", fromSurface: true, captureBeyondViewport: false });
      captured.resolve(); return { data: "c2NyZWVuc2hvdC1vbmx5" };
    }
    if (method === "Page.screencastFrameAck" && ++acks === 2) { freshAckEntered.resolve(); return ack.promise; }
  } });
  t.after(async () => { start.resolve(); ack.resolve(); await f.control.revokeView(); });
  let ready = false;
  const beginning = f.beginView().then(handle => { ready = true; return handle; }); beginning.catch(() => {});
  await startEntered.promise; await tick();
  assert.equal(f.calls.some(([method]) => method === "Page.captureScreenshot"), false);
  start.resolve(); await captured.promise; await tick();
  assert.equal(ready, false); assert.equal(f.frames.length, 0);
  f.emit(undefined, { deviceWidth: 800, deviceHeight: 600, pageScaleFactor: 1, offsetTop: 0, monotonicTimestamp: 100 });
  await tick(); assert.equal(acks, 1); assert.equal(ready, false); assert.equal(f.frames.length, 0);
  f.emit(); await freshAckEntered.promise; await tick();
  assert.equal(ready, false); assert.equal(f.frames.length, 0);
  ack.resolve(); const handle = await beginning;
  assert.equal(handle.info().state, "active"); assert.equal(f.frames.length, 1);
  assert.equal(f.frames[0].data, "cGl4ZWxz");
  assert.equal(f.calls.filter(([method]) => method === "Page.captureScreenshot").length, 1);
  await handle.close(); assertViewOnly(f); f.control.assertReleased();
});

test("human preparation never captures a hidden surface even while its first frame is absent", async t => {
  const started = defer();
  const f = fixture({ frames: false, command: method => { if (method === "Page.startScreencast") started.resolve(); } });
  const handle = await f.beginAdmitted(); t.after(() => handle.close());
  const original = f.control.current;
  await started.promise; await tick();
  assert.equal(handle.info().state, "preparing"); assert.equal(f.frames.length, 0);
  assert.equal(f.calls.some(([method]) => method === "Page.captureScreenshot"), false);
  f.emit(); await original.start; assert.equal(handle.info().state, "active");
  await handle.close();
  assert.equal(f.calls.some(([method]) => method === "Page.captureScreenshot"), false);
  f.control.assertReleased();
});

test("view hidden surface screenshot ACK supplies no missing native TimeTicks evidence", async t => {
  const captured = defer();
  const f = fixture({ frames: false, command: method => {
    if (method === "Page.captureScreenshot") { captured.resolve(); return { data: "c2NyZWVuc2hvdC1vbmx5" }; }
  } });
  t.after(() => f.control.revokeView());
  const beginning = f.beginView(); beginning.catch(() => {});
  await captured.promise; await tick(); assert.equal(f.frames.length, 0);
  const rejected = assert.rejects(beginning, /OBU_HUMAN_CAPTURE_UNSUPPORTED/);
  f.emit(undefined, { deviceWidth: 800, deviceHeight: 600, pageScaleFactor: 1, offsetTop: 0,
    timestamp: Date.now() / 1000, monotonicTimestamp: undefined });
  await rejected;
  assert.equal(f.frames.length, 0);
  assert.equal(f.calls.filter(([method]) => method === "Page.screencastFrameAck").length, 1);
  assert.equal(f.calls.filter(([method]) => method === "Page.stopScreencast").length, 1);
  assert.equal(f.calls.filter(([method]) => method === "detach").length, 1);
  assertViewOnly(f); f.control.assertReleased();
});

test("view End joins its pending hidden surface screenshot before original stop and detach", async t => {
  const capture = defer(), captured = defer(), stop = defer(), stopping = defer(), detach = defer(), detaching = defer();
  const f = fixture({ frames: false, command: method => {
    if (method === "Page.captureScreenshot") { captured.resolve(); return capture.promise; }
    if (method === "Page.stopScreencast") { stopping.resolve(); return stop.promise; }
  }, detach: () => { detaching.resolve(); return detach.promise; } });
  t.after(async () => { capture.resolve(); stop.resolve(); detach.resolve(); await f.control.revokeView(); });
  const beginning = f.beginView(); beginning.catch(() => {}); await captured.promise;
  let ended = false;
  const closing = f.control.revokeView(7).then(() => { ended = true; });
  f.emit(); await tick();
  assert.equal(ended, false); assert.equal(f.frames.length, 0);
  assert.equal(f.calls.some(([method]) => method === "Page.stopScreencast" || method === "detach"), false);
  assert.throws(() => f.beginView(), /OBU_HUMAN_BUSY/); assert.throws(() => f.begin(), /OBU_HUMAN_BUSY/);
  capture.resolve({ data: "c2NyZWVuc2hvdC1vbmx5" }); await stopping.promise;
  assert.equal(ended, false); assert.equal(f.calls.some(([method]) => method === "detach"), false);
  stop.resolve(); await detaching.promise; await tick();
  assert.equal(ended, false); assert.throws(() => f.beginView(), /OBU_HUMAN_BUSY/);
  detach.resolve(); await assert.rejects(beginning, /Rendered action was cancelled because tab control ended/); await closing;
  assert.equal(f.calls.filter(([method]) => method === "Page.captureScreenshot").length, 1);
  assert.equal(f.calls.filter(([method]) => method === "Page.stopScreencast").length, 1);
  assert.equal(f.calls.filter(([method]) => method === "detach").length, 1);
  assert.equal(f.listeners.size, 0); assertViewOnly(f); f.control.assertReleased();
});

test("view navigation joins the original hidden surface capture and stop before starting its next epoch", async t => {
  const capture = defer(), captured = defer(), nextCaptured = defer(), stop = defer(), stopping = defer(); let captures = 0, stops = 0;
  const f = fixture({ frames: false, command: method => {
    if (method === "Page.captureScreenshot") {
      if (++captures === 1) { captured.resolve(); return capture.promise; }
      nextCaptured.resolve(); return { data: "c2NyZWVuc2hvdC1vbmx5" };
    }
    if (method === "Page.stopScreencast" && ++stops === 1) { stopping.resolve(); return stop.promise; }
  } });
  t.after(async () => { capture.resolve(); stop.resolve(); await f.control.revokeView(); });
  const beginning = f.beginView(); beginning.catch(() => {}); await captured.promise;
  const original = f.control.current, epoch = original.epoch, leaseId = original.leaseId;
  f.changeDocument(); f.control.navigation(7, { frameId: 0 }, "committed"); f.emit(); await tick();
  assert.equal(epoch.retired, true); assert.equal(epoch.cleaned, undefined); assert.equal(f.frames.length, 0);
  assert.equal(f.calls.filter(([method]) => method === "Page.startScreencast").length, 1);
  assert.equal(stops, 0); assert.equal(captures, 1); assert.equal(f.calls.some(([method]) => method === "detach"), false);
  capture.resolve({ data: "c2NyZWVuc2hvdC1vbmx5" }); await stopping.promise; await tick();
  assert.equal(f.calls.filter(([method]) => method === "Page.startScreencast").length, 1); assert.equal(captures, 1);
  stop.resolve(); await nextCaptured.promise; await tick();
  assert.equal(epoch.cleaned, true); assert.equal(f.control.current, original); assert.equal(original.leaseId, leaseId);
  assert.equal(original.generation, 2); assert.equal(f.frames.length, 0);
  assert.equal(f.calls.filter(([method]) => method === "Page.startScreencast").length, 2);
  assert.equal(f.calls.filter(([method]) => method === "attach").length, 1);
  assert.equal(f.calls.some(([method]) => method === "detach"), false);
  f.emit(); const handle = await beginning;
  assert.equal(handle.info().leaseId, leaseId); assert.equal(f.frames.length, 1); assert.equal(f.frames[0].generation, 2);
  await handle.close(); assert.equal(stops, 2); assertViewOnly(f); f.control.assertReleased();
});

test("view hidden surface capture queued before generation retirement fails its final native guard", async t => {
  const nextCaptured = defer(); let queued, retired, requests = 0;
  const f = fixture({ frames: false, command: method => { if (method === "Page.captureScreenshot") nextCaptured.resolve(); } });
  const send = f.control.send;
  f.control.send = function (...args) {
    const actual = send.apply(this, args);
    if (args[1] === "Page.captureScreenshot" && ++requests === 1) {
      queued = actual; retired = args[0].epoch;
      // Retire after the owner's send queues its actual microtask, before the
      // native call. Returning the same Promise keeps its real failure visible.
      actual.catch(() => {});
      f.changeDocument(); f.control.navigation(7, { frameId: 0 }, "committed");
    }
    return actual;
  };
  t.after(() => f.control.revokeView());
  const beginning = f.beginView(); beginning.catch(() => {}); await nextCaptured.promise;
  await assert.rejects(queued, /OBU_HUMAN_GENERATION_STALE/);
  assert.equal(retired.retired, true); assert.equal(retired.cleaned, true); assert.equal(requests, 2);
  assert.equal(f.calls.filter(([method]) => method === "Page.captureScreenshot").length, 1);
  assert.equal(f.calls.filter(([method]) => method === "Page.stopScreencast").length, 1);
  assert.equal(f.calls.filter(([method]) => method === "Page.startScreencast").length, 2);
  assert.equal(f.frames.length, 0);
  f.emit(); const handle = await beginning;
  assert.equal(handle.info().generation, 2); assert.equal(f.frames.length, 1);
  await handle.close(); assertViewOnly(f); f.control.assertReleased();
});

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


test("view journal intent precedes native attach and attached commit precedes native rendering", async () => {
  const intent = defer(), attached = defer(), detached = defer(), released = defer();
  const journal = [], f = fixture({ detach: () => detached.promise, viewJournal: {
    async intent(record) { journal.push(["intent", record.leaseId]); await intent.promise; },
    async attached(record) { journal.push(["attached", record.leaseId]); await attached.promise; },
    async released(record) { journal.push(["released", record.leaseId]); await released.promise; }
  } });
  const pending = f.beginView();
  await tick(); assert.equal(f.calls.some(([method]) => method === "attach"), false);
  intent.resolve(); await tick(); assert.equal(f.calls.some(([method]) => method === "attach"), true);
  assert.equal(f.calls.some(([method]) => method === "Page.startScreencast"), false);
  attached.resolve(); const handle = await pending;
  const closing = handle.close(); await tick();
  assert.equal(journal.some(([kind]) => kind === "released"), false);
  detached.resolve(); await tick(); assert.equal(journal.at(-1)[0], "released");
  assert.equal(handle.info().state, "releasing");
  released.resolve(); await closing;
  assert.equal(handle.info().state, "released");
  assert.equal(new Set(journal.map(([, lease]) => lease)).size, 1);
});

test("known unsent view attach cancels its durable intent, while unknown attach retains the cleanup barrier", async () => {
  const intent = defer(), calls = [], f = fixture({ viewJournal: {
    async intent() { await intent.promise; }, async attached() { calls.push("attached"); }, async released() { calls.push("released"); }
  } });
  const starting = f.beginView(); starting.catch(() => {}); await tick(); f.expire(); intent.resolve();
  await assert.rejects(starting, /expired/);
  assert.deepEqual(calls, ["released"]); assert.equal(f.calls.some(([method]) => method === "attach"), false);
  const unknown = fixture({ attach: () => { throw Error("native attach outcome unknown"); }, viewJournal: {
    async intent() {}, async attached() { throw Error("must not commit attached"); }, async released() { throw Error("must not clear intent"); }
  } });
  await assert.rejects(unknown.beginView(), error => error.viewerCleanupIncomplete === true);
  assert.equal(unknown.control.status().state, "error");
  assert.throws(() => unknown.control.assertReleased(), /BUSY/);
});

test("durable attached write failure still joins the actual attachment before acknowledging local cleanup", async () => {
  const gate = defer(), calls = [], f = fixture({ detach: () => gate.promise, viewJournal: {
    async intent() { calls.push("intent"); }, async attached() { throw Error("original IDB attached transaction aborted"); },
    async released() { calls.push("released"); }
  } });
  const begin = f.beginView(); begin.catch(() => {}); await tick();
  assert.deepEqual(calls, ["intent"]); assert.equal(f.control.status().state, "releasing");
  gate.resolve(); await assert.rejects(begin, /original IDB/);
  assert.deepEqual(calls, ["intent", "released"]); assert.equal(f.control.status(), null);
});
for (const event of ["destroy", "replace"]) test(`unsent input must not cross original remote default-context ${event}`, async () => {
  const f = remoteFixture(), handle = await f.begin(), durability = defer();
  const original = f.control.markRisk;
  let marked = false;
  f.control.markRisk = async (...args) => { await original(...args); marked = true; await durability.promise; };
  const pending = input(handle, { type: "text", text: "must not reach a replacement child" });
  const result = pending.then(value => ({ value }), error => ({ error: error.message }));
  await tick(); assert.equal(marked, true);
  assert.equal(f.calls.filter(([method]) => method === "Input.insertText").length, 0);
  if (event === "destroy") f.event("Runtime.executionContextDestroyed", { executionContextId: 1, executionContextUniqueId: "context-remote" }, f.remoteSource("child-session"));
  else f.event("Runtime.executionContextCreated", { context: { id: 2, uniqueId: "replacement-remote", origin: "https://remote.test", auxData: { isDefault: true, frameId: "remote" } } }, f.remoteSource("child-session"));
  durability.resolve(); const settled = await result;
  await handle.close();
  assert.equal(f.calls.filter(([method]) => method === "Input.insertText").length, 0, `native call escaped old default context: ${JSON.stringify(settled)}`);
  assert.ok(settled.error, "caller must not receive an old-generation success");
});

test('metadata remains gated after a response ACK until the exact original Closed event', async () => {
  const f = fixture(), handle = await f.begin(), record = f.control.current;
  opening(f); const before = f.calls.filter(([method]) => method === 'Page.getLayoutMetrics').length;
  const read = f.control.send(record, 'Page.getLayoutMetrics', undefined, () => f.control.check(record));
  await tick(); assert.equal(f.calls.filter(([method]) => method === 'Page.getLayoutMetrics').length, before);
  assert.equal((await answer(handle)).acknowledged, true);
  await tick(); assert.equal(f.calls.filter(([method]) => method === 'Page.getLayoutMetrics').length, before);
  f.event('Page.javascriptDialogClosed', {frameId:'root'}); await read;
  assert.equal(f.calls.filter(([method]) => method === 'Page.getLayoutMetrics').length, before + 1);
  await handle.close(); assert.equal(f.risks.size, 0);
});
test('End rejects queued metadata but still joins original metadata and cancellation ACKs', async () => {
  const originalRead = defer(), cancellation = defer(); let holding = false;
  const f = fixture({command:(method, params) => {
    if (holding && method === 'Page.getLayoutMetrics') return originalRead.promise;
    if (method === 'Page.handleJavaScriptDialog') { assert.equal(params.accept,false); return cancellation.promise; }
  }});
  const handle = await f.begin(), record = f.control.current; holding = true;
  const read = f.control.send(record,'Page.getLayoutMetrics',undefined,()=>f.control.check(record));
  await tick(); opening(f);
  const before=f.calls.filter(([method])=>method==='Page.getLayoutMetrics').length;
  const queued=f.control.send(record,'Page.getLayoutMetrics',undefined,()=>f.control.check(record));
  const rejected=assert.rejects(queued,/revoked/); await tick();
  let done=false; const closing=handle.close().then(()=>{done=true}); await rejected; await tick();
  assert.equal(done,false); assert.equal(f.calls.filter(([method])=>method==='Page.getLayoutMetrics').length,before);
  assert.equal(f.calls.some(([method])=>method==='detach'),false);
  cancellation.resolve(); await tick(); assert.equal(done,false);
  originalRead.resolve({}); await read; await closing;
  assert.equal(f.risks.size,0); assert.equal(f.calls.filter(([method])=>method==='detach').length,1);
});
test('a modal Opening between the wait return and actual metadata dispatch remains gated', async () => {
  const f=fixture(), handle=await f.begin(), record=f.control.current;
  const before=f.calls.filter(([method])=>method==='Page.getLayoutMetrics').length;
  const read=f.control.send(record,'Page.getLayoutMetrics',undefined,()=>f.control.check(record));
  queueMicrotask(()=>opening(f));
  await tick();
  let caught;
  try { assert.equal(f.calls.filter(([method])=>method==='Page.getLayoutMetrics').length,before); }
  catch(error) { caught=error; }
  await answer(handle); f.event('Page.javascriptDialogClosed',{frameId:'root'});
  await read; await handle.close();
  if(caught) throw caught;
});


test("active root source uses its original graph context and retires with that proof", async t => {
  const f = remoteFixture(), handle = await f.begin(); t.after(() => handle.close());
  opening(f); const original = handle.pendingDialog();
  assert.deepEqual(original.source, { origin: "https://fixture.test", frame: "top-level" });
  const pending = answer(handle), rejected = assert.rejects(pending, /DIALOG_STALE/);
  f.event("Runtime.executionContextDestroyed", { executionContextId: 1, executionContextUniqueId: "context-root" });
  await rejected;
  assert.deepEqual(f.calls.filter(([method]) => method === "Page.handleJavaScriptDialog").map(row => row[2]), [{ accept: false }]);
});


test("missing root context keeps its original answer contract without URL-derived or late-filled source", async t => {
  const f = fixture(), handle = await f.begin(); t.after(() => handle.close());
  const count = f.calls.length; opening(f, { source: { origin: "https://forged.test", frame: "child" }, message: "https://forged.test asks" });
  const original = handle.pendingDialog(); assert.ok(original); assert.equal(Object.hasOwn(original, "source"), false);
  childContext(f, "root", "late-default", 1);
  assert.equal(handle.pendingDialog(), original); assert.equal(Object.hasOwn(handle.pendingDialog(), "source"), false);
  const receipt = await answer(handle); assert.equal(receipt.acknowledged, true);
  assert.deepEqual(f.calls.slice(count).map(([method]) => method), ["Page.handleJavaScriptDialog"]);
  f.event("Page.javascriptDialogClosed", { frameId: "root" });
});

for (const which of ["root", "child", "nested"]) test(`same-origin ${which} reports its native frame role without new reads`, async t => {
  const f = childFixture(), handle = await f.begin(); t.after(() => handle.close()); const count = f.calls.length;
  opening(f, { frameId: which, url: which === "root" ? "https://fixture.test/original-document" : `https://fixture.test/${which}` });
  assert.deepEqual(handle.pendingDialog().source, { origin: "https://fixture.test", frame: which === "root" ? "top-level" : "child" });
  assert.equal(f.calls.length, count); await answer(handle); f.event("Page.javascriptDialogClosed", { frameId: which });
});

for (const nested of [false, true]) test(`remote emitter source stays distinct from the ancestor (nested=${nested})`, async t => {
  const f = remoteFixture({ nested }), handle = await f.begin(); t.after(() => handle.close());
  opening(f, { frameId: f.remoteFrame.id, url: f.remoteFrame.url });
  assert.deepEqual(handle.pendingDialog().source, { origin: nested ? "https://nested.test" : "https://remote.test", frame: "child" });
  await answer(handle); f.event("Page.javascriptDialogClosed", { frameId: f.remoteFrame.id });
});
