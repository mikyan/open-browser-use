import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { captureFixture, captureResultFixture } from "../testdata/generate-bridge-fixture.mjs";

const source = readFileSync(new URL("./viewer.js", import.meta.url), "utf8");
const ticket = "a".repeat(43);

const resultTab = (extra = {}) => ({ id: 1, title: "Result", url: "https://example.test/result", kind: "result", deliveryId: "original-delivery", watchable: true, takeover: true, ...extra });
const viewState = (extra = {}) => ({ state: "active", leaseId: "view-a", tabId: 1, generation: 1, viewport: { width: 1280, height: 720 }, ...extra });
function readyResult(h, mode = "paused") {
  h.authenticate();
  h.respond(1, h.state(2, mode, mode === "paused", { tabs: [resultTab()], view: null }));
  h.choose();
  const request = h.socket.sent.at(-1);
  h.respond(request.id, h.state(2, mode, mode === "paused", { tabs: [resultTab()], selectedTabId: 1, view: viewState() }));
  h.frame(1, { eventSequence: 20001, controlMode: "user-view", viewLeaseId: "view-a", generation: 1 });
  h.images.at(-1).onload();
}

test("paused delivered result is watchable but a decoded view never grants input", () => {
  const h = setup(); readyResult(h);
  assert.deepEqual(h.socket.sent[2], { id: 2, operation: "select", tabId: 1, deliveryId: "original-delivery" });
  assert.equal(h.element("tabs").children[1].text, "已交付结果 · Result");
  assert.equal(h.element("human-begin").textContent, "操作结果页");
  assert.equal(h.element("human-begin").disabled, false);
  assert.equal(h.element("control").disabled, false);
  assert.equal(h.element("frame").dataset.controlMode, "user-view");
  assert.equal(h.element("frame").dataset.viewLeaseId, "view-a");
  assert.equal(h.element("human-input").dataset.enabled, "false");
  const before = h.socket.sent.length;
  h.event("frame", "pointerdown", { button: 0, pointerId: 1, clientX: 100, clientY: 100 });
  h.event("human-input", "keydown", { key: "A", code: "KeyA", keyCode: 65 });
  assert.equal(h.socket.sent.length, before);
  h.element("control").click();
  assert.equal(h.socket.sent.at(-1).operation, "resume");
});

test("result takeover carries delivery identity and End permits another takeover while paused", () => {
  const h = setup(); readyResult(h);
  h.element("human-begin").click();
  const begin = h.socket.sent.at(-1);
  assert.deepEqual(begin, { id: 3, operation: "humanBegin", tabId: 1, deliveryId: "original-delivery" });
  h.respond(begin.id, h.humanState({ tabs: [resultTab()], selectedTabId: 1, view: null, eventSequence: 20002, retiredSequence: 20001 }));
  assert.equal(h.element("human-input").dataset.enabled, "false");
  h.humanFrame(1, { eventSequence: 20003, retiredSequence: 20001 }); h.images.at(-1).onload();
  assert.equal(h.element("human-input").dataset.enabled, "true");
  h.element("human-end").click();
  const end = h.socket.sent.at(-1);
  h.respond(end.id, h.state(2, "paused", true, { tabs: [resultTab()], human: null, view: null, eventSequence: 20004, retiredSequence: 20003, humanCleanup: { leaseId: "lease-a", cleanupConfirmed: true } }));
  assert.equal(h.element("human-begin").disabled, false);
  assert.equal(h.element("watch").disabled, false);
  h.element("human-begin").click();
  assert.equal(h.socket.sent.at(-1).deliveryId, "original-delivery");
  assert.equal(h.socket.sent.filter(x => x.operation === "resume").length, 0);
});

test("capabilities and cleanup restrict result admission; paused legacy tasks remain blocked", () => {
  for (const extra of [{ tabs: [resultTab({ watchable: false, takeover: false })] }, { tabs: [resultTab()], viewerCleanupComplete: false }, {}]) {
    const h = setup(); h.authenticate(); h.respond(1, h.state(2, "paused", true, extra));
    h.choose();
    assert.equal(h.element("watch").disabled, true);
    assert.equal(h.element("human-begin").disabled, true);
    assert.equal(h.socket.sent.some(x => x.operation === "select"), false);
  }
});

test("delivery replacement retires pending selection and requires a fresh explicit choice", () => {
  for (const late of ["success", "error", "timeout"]) {
    const h = setup(); h.authenticate(); h.respond(1, h.state(2, "paused", true, { tabs: [resultTab()] })); h.choose();
    const timeout = [...h.timers.values()].at(-1);
    h.socket.message({ type: "state", ...h.state(2, "paused", true, { tabs: [resultTab({ deliveryId: "successor" })], eventSequence: 20002 }) });
    if (late === "timeout") timeout();
    else if (late === "error") h.socket.message({ type: "response", id: 2, error: { code: "OPERATION_UNCONFIRMED" } });
    else h.respond(2, h.state(2, "paused", true, { tabs: [resultTab()], selectedTabId: 1, view: viewState() }));
    assert.equal(h.element("tabs").value, "");
    assert.equal(h.element("state").textContent, "已暂停");
    assert.equal(h.element("human-begin").disabled, true);
    h.choose();
    assert.equal(h.socket.sent.at(-1).deliveryId, "successor");
  }
});

test("read-only navigation retires decode and admits only the matching successor frame", () => {
  const h = setup(); readyResult(h);
  h.frame(2, { eventSequence: 20002, controlMode: "user-view", viewLeaseId: "view-a", generation: 1 });
  const oldDecode = h.images.at(-1);
  h.socket.message({ type: "state", ...h.state(2, "paused", true, { tabs: [resultTab()], selectedTabId: 1, view: viewState({ state: "navigating", generation: 2, viewport: null }), eventSequence: 20003 }) });
  h.frame(1, { eventSequence: 20005, streamId: "view-next", controlMode: "user-view", viewLeaseId: "view-a", generation: 2 });
  oldDecode.onload();
  assert.equal(h.element("frame").src, undefined);
  h.socket.message({ type: "state", ...h.state(2, "paused", true, { tabs: [resultTab()], selectedTabId: 1, view: viewState({ generation: 2 }), eventSequence: 20004 }) });
  h.images.at(-1).onload();
  assert.equal(h.element("frame").dataset.generation, "2");
  assert.equal(h.element("frame").dataset.viewLeaseId, "view-a");
  assert.equal(h.element("human-input").dataset.enabled, "false");
  assert.equal(h.socket.sent.some(x => x.operation === "humanEnd"), false);
  const count = h.images.length;
  h.frame(10, { eventSequence: 20006, controlMode: "user-view", viewLeaseId: "view-a", generation: 1 });
  h.frame(11, { eventSequence: 20007, controlMode: "user-view", viewLeaseId: "other", generation: 2 });
  h.frame(12, { eventSequence: 20008 });
  assert.equal(h.images.length, count);
});

test("actual Go-projected result fixture supports view, paused takeover, End and a second takeover", () => {
  const fixture = JSON.parse(readFileSync(new URL("../testdata/public-result-fixture.json", import.meta.url), "utf8"));
  const h = setup();
  const state = value => ({ ...value, retiredSequence: 0 });
  const receiveFrame = (mode, lease) => {
    const value = fixture.events.find(e => e.type === "frame" && e.controlMode === mode && (e.viewLeaseId || e.humanLeaseId) === lease);
    assert.ok(value);
    h.socket.message(state(value));
    h.images.at(-1).naturalWidth = h.images.at(-1).naturalHeight = 1;
    h.images.at(-1).onload();
  };
  h.authenticate(); h.respond(1, state(fixture.open)); h.choose(7);
  assert.equal(h.socket.sent.at(-1).deliveryId, "fixture-delivery-original");
  h.respond(2, state(fixture.viewRunningStatus)); receiveFrame("user-view", fixture.viewRunningStatus.view.leaseId);
  assert.equal(h.element("human-input").dataset.enabled, "false");
  h.element("control").click(); h.respond(3, state(fixture.pause));
  h.element("watch").click(); h.respond(4, state(fixture.viewPausedStatus)); receiveFrame("user-view", fixture.viewPausedStatus.view.leaseId);
  h.element("human-begin").click(); h.respond(5, state(fixture.humanBegin)); receiveFrame("human", fixture.humanBegin.human.leaseId);
  assert.equal(h.element("human-input").dataset.enabled, "true");
  h.event("human-input", "beforeinput", { inputType: "insertText", data: "x" });
  h.respond(6, state(fixture.humanInput));
  assert.equal(h.element("human-input").dataset.acknowledgedSequence, "1");
  h.socket.message({ type: "state", ...state(fixture.humanNavigation.navigating) });
  assert.equal(h.element("human-input").dataset.enabled, "false");
  h.socket.message({ type: "state", ...state(fixture.humanNavigation.active) });
  const successor = fixture.events.find(e => e.type === "frame" && e.controlMode === "human" && e.generation === 2);
  h.socket.message(state(successor)); h.images.at(-1).onload();
  h.element("human-end").click(); h.respond(7, state(fixture.humanEnd));
  assert.equal(h.element("state").textContent, "已暂停");
  h.element("watch").click(); h.respond(8, state(fixture.viewAfterHumanStatus)); receiveFrame("user-view", fixture.viewAfterHumanStatus.view.leaseId);
  assert.ok(h.element("page-title").textContent.includes("B"));
  h.element("human-begin").click(); h.respond(9, state(fixture.secondHumanBegin)); receiveFrame("human", fixture.secondHumanBegin.human.leaseId);
  h.element("human-end").click(); h.respond(10, state(fixture.secondHumanEnd));
  assert.equal(h.element("human-begin").disabled, false);
  assert.equal(h.socket.sent.filter(x => x.operation === "resume").length, 0);
});

test("Go projection fixture matches the current real managed worker bridge", async () => {
  assert.deepEqual(await captureFixture(), JSON.parse(readFileSync(new URL("../testdata/bridge-fixture.json", import.meta.url), "utf8")));
});

test("result fixture records the real bridge lifecycle, including view navigation", async () => {
  assert.deepEqual(await captureResultFixture(), JSON.parse(readFileSync(new URL("../testdata/result-bridge-fixture.json", import.meta.url), "utf8")));
});

function setup(inputBudgetVersion, keyRepeatVersion) {
  const nodes = new Map();
  const images = [], revoked = [], timers = new Map(), timerDelays = new Map();
  const windowEvents = {}, documentEvents = {};
  let timerId = 0, replaced, socket;
  let focused = null;
  function element(id) {
    if (!nodes.has(id)) nodes.set(id, {
      disabled: false, hidden: false, textContent: "", value: "", listeners: {}, dataset: {},
      addEventListener(event, handler) { this.listeners[event] = handler; },
      replaceChildren(...children) { this.children = children; },
      removeAttribute(name) { delete this[name]; },
      click() { this.listeners.click?.(); },
      focus() { const old = focused; focused = this; if (old && old !== this) old.listeners.blur?.(); },
      getBoundingClientRect() { return this.rect || { left: 10, top: 20, width: 640, height: 360 }; },
      setPointerCapture(id) { this.capture = id; },
      hasPointerCapture(id) { return this.capture === id; },
      releasePointerCapture() { this.capture = null; this.listeners.lostpointercapture?.(); }
    });
    return nodes.get(id);
  }
  class FakeSocket {
    static OPEN = 1;
    constructor(url) { this.url = url; this.readyState = 1; this.handlers = {}; this.sent = []; socket = this; }
    addEventListener(name, handler) { this.handlers[name] = handler; }
    send(message) { this.sent.push(JSON.parse(message)); }
    close() { this.handlers.close?.(); }
    open() { this.handlers.open?.(); }
    message(data) { this.handlers.message?.({ data: JSON.stringify(data) }); }
  }
  class FakeImage {
    constructor() { this.naturalWidth = 1280; this.naturalHeight = 720; images.push(this); }
  }
  let nextBlob = 0;
  const context = vm.createContext({
    document: { getElementById: element, addEventListener(name, handler) { documentEvents[name] = handler; } },
    location: { hash: `#ticket=${ticket}`, host: "127.0.0.1:44555", pathname: "/" },
    history: { replaceState(...args) { replaced = args; } },
    URLSearchParams, WebSocket: FakeSocket, Blob, Uint8Array, TextEncoder,
    URL: class extends URL { static createObjectURL() { return `blob:${++nextBlob}`; } static revokeObjectURL(value) { revoked.push(value); } },
    Image: FakeImage, Option: class { constructor(text, value) { this.text = text; this.value = value; } },
    atob: value => Buffer.from(value, "base64").toString("binary"),
    setTimeout(callback, delay) { timers.set(++timerId, callback); timerDelays.set(timerId, delay); return timerId; },
    clearTimeout(id) { timers.delete(id); timerDelays.delete(id); }, setInterval() {},
    window: { addEventListener(name, handler) { windowEvents[name] = handler; } }
  });
  vm.runInContext(source, context);
  function authenticate() { socket.open(); socket.message({ type: "authenticated" }); }
  function state(revision = 1, mode = "running", cleanupComplete = false, extra = {}) {
    return { status: { state: mode, inputBlocked: mode !== "running", revision, cleanupComplete }, workerBootId: "worker-a", eventSequence: revision * 10000, retiredSequence: 0, viewerCleanupComplete: true, selectedTabId: null, tabs: [{ id: 1, title: "<img onerror=bad>", url: "https://example.test" }], ...extra };
  }
  function respond(id, result) { socket.message({ type: "response", id, result }); }
  function running() { authenticate(); respond(1, state()); }
  function choose(tab = 1) { element("tabs").value = String(tab); element("tabs").listeners.change(); }
  function frame(sequence, extra = {}) { socket.message({ type: "frame", tabId: 1, streamId: "stream-a", sequence, eventSequence: 10000 + sequence, retiredSequence: 0, data: "aW1hZ2U=", mimeType: "image/png", metadata: {}, ...extra }); }
  function event(id, name, data = {}) { const e = { preventDefault() { this.prevented = true; }, ...data }; element(id).listeners[name]?.(e); return e; }
  function humanState(extra = {}) { return state(2, "paused", true, { eventSequence: 20000, retiredSequence: 19999, human: { state: "active", leaseId: "lease-a", generation: 1, tabId: 1, viewport: { width: 1280, height: 720 }, ...(inputBudgetVersion !== undefined ? { inputBudgetVersion } : {}), ...(keyRepeatVersion !== undefined ? { keyRepeatVersion } : {}) }, ...extra }); }
  function beginHuman() { running(); choose(); respond(2, state(1, "running", false, { selectedTabId: 1 })); element("human-begin").click(); respond(3, humanState()); }
  function humanFrame(sequence = 1, extra = {}) { frame(sequence, { streamId: "human-stream", eventSequence: 20000 + sequence, retiredSequence: 19999, controlMode: "human", humanLeaseId: "lease-a", generation: 1, ...extra }); }
  function readyHuman() { beginHuman(); humanFrame(); images.at(-1).onload(); }
  function ackInput(request = socket.sent.at(-1), extra = {}) { respond(request.id, { ...humanState(), inputReceipt: { acknowledged: true, leaseId: request.leaseId, generation: request.generation, sequence: request.sequence }, ...extra }); }
  return { element, socket, images, revoked, timers, timerDelays, replaced, authenticate, state, respond, running, choose, frame, event, windowEvents, documentEvents, humanState, beginHuman, humanFrame, readyHuman, ackInput };
}

function beginPreparing(h, generation = 1, state = "preparing") {
  h.running(); h.choose(); h.respond(2, h.state(1, "running", false, { selectedTabId: 1 }));
  h.element("human-begin").click();
  const begin = h.socket.sent.at(-1);
  const original = h.humanState({ human: { ...h.humanState().human, state, generation, viewport: null } });
  return { begin, original };
}

for (const generation of [0, 1]) test(`preparing generation ${generation} admits End only after its original Begin receipt`, () => {
  const h = setup(1), { begin, original } = beginPreparing(h, generation);
  h.socket.message({ type: "state", ...original });
  assert.equal(h.element("human-end").disabled, true);
  h.element("human-end").click();
  assert.equal(h.socket.sent.at(-1), begin);
  h.respond(begin.id, original);
  assert.equal(h.element("connection").textContent, "已连接");
  assert.equal(h.element("human-input").dataset.enabled, "false");
  assert.equal(h.element("human-end").disabled, false);
  h.element("human-end").click();
  assert.equal(h.socket.sent.at(-1).operation, "humanEnd");
  assert.equal(h.socket.sent.at(-1).leaseId, "lease-a");
  h.respond(h.socket.sent.at(-1).id, releaseState(h));
  assert.equal(h.element("human-end").hidden, true);
});

for (const stage of ["preparing", "navigating"]) test(`${stage} proven dialog is independent of viewport and requires Begin receipt`, () => {
  const h = setup(1), { begin, original } = beginPreparing(h, 1, stage);
  original.pendingDialog = dialog();
  h.socket.message({ type: "state", ...original });
  assert.equal(h.element("dialog-accept").disabled, true);
  h.element("dialog-accept").click(); assert.equal(h.socket.sent.at(-1), begin);
  h.respond(begin.id, original);
  assert.equal(h.element("dialog-accept").disabled, false);
  h.element("dialog-prompt").value = "原输入😀"; h.element("dialog-accept").click();
  const answer = h.socket.sent.at(-1);
  assert.equal(answer.operation, "humanDialogRespond"); assert.equal(answer.generation, 1);
  assert.equal(h.element("human-input").dataset.enabled, "false");
  h.respond(answer.id, { ...original, eventSequence: 20002, pendingDialog: null,
    dialogReceipt: { leaseId: "lease-a", generation: 1, dialogId: original.pendingDialog.dialogId, acknowledged: true } });
  assert.equal(h.element("human-input").dataset.enabled, "false");
  assert.equal(h.socket.sent.some(x => x.operation === "humanInput" || x.operation === "humanEnd"), false);
});

for (const order of ["state-first", "frame-first"]) test(`preparing same-generation first viewport requires decoded frame: ${order}`, () => {
  const h = setup(1), { begin, original } = beginPreparing(h);
  h.respond(begin.id, original);
  if (order === "frame-first") h.humanFrame(3, { eventSequence: 20003 });
  h.socket.message({ type: "state", ...h.humanState({ eventSequence: 20002 }) });
  assert.equal(h.element("human-input").dataset.enabled, "false");
  if (order === "state-first") h.humanFrame(3, { eventSequence: 20003 });
  assert.equal(h.images.length, 1); h.images[0].onload();
  assert.equal(h.element("human-input").dataset.enabled, "true");
  assert.equal(h.socket.sent.some(x => x.operation === "humanEnd"), false);
  h.socket.message({ type: "state", ...h.humanState({ eventSequence: 20004,
    human: { ...h.humanState().human, viewport: { width: 800, height: 600 } } }) });
  assert.equal(h.element("human-input").dataset.enabled, "false", "later same-generation resize is not initial readiness");
});

test("navigating dialog response does not wait for the old input receipt or new frame", () => {
  const h = setup(1); h.readyHuman();
  h.event("human-input", "beforeinput", { inputType: "insertText", data: "original" });
  const input = h.socket.sent.at(-1);
  const next = generationState(h, 2, "navigating"); next.pendingDialog = dialog({ generation: 2 });
  h.socket.message({ type: "state", ...next });
  h.element("dialog-accept").click(); const answer = h.socket.sent.at(-1);
  assert.equal(answer.operation, "humanDialogRespond"); assert.equal(answer.generation, 2);
  h.ackInput(input);
  assert.equal(h.element("human-input").dataset.enabled, "false");
  assert.equal(h.socket.sent.at(-1), answer); assert.equal(h.element("dialog-accept").disabled, true);
});

test("pre-admission starting geometry can become ready but cannot replace Begin", () => {
  const h = setup(), { begin, original } = beginPreparing(h, 1, "starting");
  h.socket.message({ type: "state", ...original });
  const active = h.humanState({ eventSequence: 20002 });
  h.socket.message({ type: "state", ...active });
  h.humanFrame(3, { eventSequence: 20003 }); h.images.at(-1).onload();
  assert.equal(h.element("human-end").disabled, true); assert.equal(h.element("human-input").dataset.enabled, "false");
  h.respond(begin.id, active);
  assert.equal(h.element("human-input").dataset.enabled, "true");
  assert.equal(h.socket.sent.some(x => x.operation === "humanEnd"), false);
});

for (const wrong of ["starting", "zero-dialog", "foreign-lease", "readonly", "viewport"]) test(`preparing rejects invalid authority: ${wrong}`, () => {
  const h = setup(), { begin, original } = beginPreparing(h);
  if (wrong === "starting") original.human.state = "starting";
  else if (wrong === "zero-dialog") { original.human.generation = 0; original.pendingDialog = dialog(); }
  else if (wrong === "foreign-lease") { h.socket.message({ type: "state", ...original }); original.human.leaseId = "foreign"; }
  else if (wrong === "readonly") { original.view = original.human; original.human = null; }
  else original.human.viewport = { width: 1280, height: 720 };
  h.respond(begin.id, original);
  assert.equal(h.element("human-input").dataset.enabled, "false");
  assert.equal(h.element("human-end").disabled, true);
  assert.equal(h.element("dialog-accept").disabled, true);
  assert.equal(h.socket.sent.some(x => x.operation === "humanEnd" || x.operation === "humanDialogRespond"), false);
});

test("blur and disconnect during preparing retain the original admission and never enable late frame", () => {
  for (const ended of ["blur", "disconnect"]) {
    const h = setup(), { begin, original } = beginPreparing(h);
    h.socket.message({ type: "state", ...original });
    if (ended === "blur") h.windowEvents.blur(); else h.socket.close();
    h.respond(begin.id, original);
    h.humanFrame();
    assert.equal(h.element("human-input").dataset.enabled, "false");
    assert.equal(h.socket.sent.filter(x => x.operation === "humanEnd").length, ended === "blur" ? 1 : 0);
  }
});

test("ticket is removed before connecting and sent only in first WebSocket auth", () => {
  const h = setup();
  assert.deepEqual(h.replaced, [null, "", "/"]);
  assert.equal(h.socket.url, "ws://127.0.0.1:44555/ws");
  assert.equal(h.element("control").disabled, true);
  h.authenticate();
  assert.deepEqual(h.socket.sent, [{ type: "authenticate", token: ticket }, { id: 1, operation: "status" }]);
  h.respond(1, h.state());
  h.element("refresh").click();
  assert.equal(JSON.stringify(h.socket.sent.slice(1)).includes(ticket), false);
  assert.equal(h.element("tabs").children[1].text, "<img onerror=bad>");
});

test("pause remains unconfirmed until receipt; resume requires current complete revision and worker", () => {
  const h = setup(); h.running();
  h.element("control").click();
  assert.deepEqual(h.socket.sent.at(-1), { id: 2, operation: "pause" });
  assert.equal(h.element("state").textContent, "正在暂停");
  h.socket.message({ type: "state", ...h.state(1) });
  assert.equal(h.element("state").textContent, "正在暂停");
  h.socket.message({ type: "response", id: 2, error: { message: "unconfirmed" } });
  assert.equal(h.element("control").disabled, true);
  h.element("refresh").click();
  h.respond(3, h.state(2, "paused", false));
  assert.equal(h.element("control").textContent, "重试暂停");
  h.element("control").click();
  assert.equal(h.socket.sent.at(-1).operation, "pause");
  h.respond(4, h.state(3, "paused", true));
  h.element("control").click();
  assert.deepEqual(h.socket.sent.at(-1), { id: 5, operation: "resume", expectedRevision: 3, expectedWorkerBootId: "worker-a" });
});

test("stale replies cannot replace newer status and a worker change revokes resume", () => {
  const h = setup(); h.authenticate();
  h.element("refresh").click();
  h.respond(2, h.state(4, "paused", true));
  h.respond(1, h.state(1));
  assert.equal(h.element("state").textContent, "已暂停");
  h.socket.message({ type: "state", ...h.state(1, "paused", true, { workerBootId: "worker-b" }) });
  assert.equal(h.element("control").disabled, true);
  assert.equal(h.element("state").textContent, "状态未确认");
});

test("disconnect and timeouts never claim pause or stop success or replay commands", () => {
  const h = setup(); h.running();
  h.element("control").click();
  const before = h.socket.sent.length;
  [...h.timers.values()].at(-1)();
  assert.equal(h.element("state").textContent, "状态未确认");
  assert.equal(h.socket.sent.length, before);
  h.socket.close();
  assert.equal(h.element("stop").disabled, true);
  assert.equal(h.element("state").textContent, "状态未确认");
  assert.equal(h.socket.sent.length, before);
});

test("stop remains available after backend loss and only acknowledgement confirms stopped", () => {
  const h = setup(); h.running();
  h.socket.message({ type: "unavailable" });
  assert.equal(h.element("control").disabled, true);
  assert.equal(h.element("stop").disabled, false);
  h.element("stop").click();
  h.respond(2, { stopped: true });
  assert.equal(h.element("state").textContent, "会话已停止");
  h.socket.close();
  assert.equal(h.element("state").textContent, "会话已停止");
});

test("image decode has one active and one latest slot; pause suppresses late image", () => {
  const h = setup(); h.running(); h.choose();
  h.frame(1);
  for (let sequence = 2; sequence <= 1000; sequence++) h.frame(sequence);
  assert.equal(h.images.length, 1);
  h.images[0].onload();
  assert.equal(h.images.length, 2);
  assert.equal(h.element("frame").src, "blob:1");
  h.socket.message({ type: "state", ...h.state(2, "paused", true, { tabs: [] }) });
  h.images[1].onload();
  assert.equal(h.element("frame").src, "blob:1");
  assert.equal(h.revoked.includes("blob:2"), true);
  assert.equal(h.element("freshness").textContent.startsWith("保留画面"), true);
  assert.equal(h.element("frame").hidden, false);
});

test("changing selection rejects old tab frames and releases image URLs", () => {
  const h = setup(); h.running(); h.choose(); h.frame(1); h.images[0].onload();
  h.respond(2, h.state(1, "running", false, { selectedTabId: 1 }));
  h.element("tabs").value = ""; h.element("tabs").listeners.change();
  assert.deepEqual(h.socket.sent.at(-1), { id: 3, operation: "select", tabId: null });
  assert.equal(h.revoked.includes("blob:1"), true);
  h.frame(2);
  assert.equal(h.images.length, 1);
  assert.equal(h.element("frame").hidden, true);
});

test("resume never resubscribes; the same option has an explicit start watching action", () => {
  const h = setup(); h.running(); h.choose();
  h.respond(2, h.state(1, "running", false, { selectedTabId: 1 }));
  assert.equal(h.element("watch").textContent, "停止查看");
  h.element("control").click();
  h.respond(3, h.state(2, "paused", true));
  h.element("control").click();
  h.respond(4, h.state(3));
  assert.equal(h.socket.sent.at(-1).operation, "resume");
  assert.equal(h.element("watch").textContent, "开始查看");
  h.element("watch").click();
  assert.deepEqual(h.socket.sent.at(-1), { id: 5, operation: "select", tabId: 1 });
});

test("retirement fences cross-queue late frames and late select responses", () => {
  const h = setup(); h.running(); h.choose();
  h.frame(1); // Decode started while Select is still awaiting its receipt.
  h.socket.message({ type: "clear", eventSequence: 10004, retiredSequence: 10004 });
  h.frame(2, { eventSequence: 10003 }); // Delivered after Clear from the frame queue.
  assert.equal(h.images.length, 1);
  h.images[0].onload();
  assert.equal(h.element("frame").hidden, true);
  h.respond(2, h.state(1, "running", false, { selectedTabId: 1, eventSequence: 10002 }));
  assert.equal(h.element("watch").textContent, "开始查看");
  h.frame(3, { eventSequence: 10003 });
  assert.equal(h.images.length, 1);
  h.element("watch").click();
  h.respond(3, h.state(1, "running", false, { selectedTabId: 1, eventSequence: 10005 }));
  h.frame(1, { streamId: "stream-b", eventSequence: 10006 });
  assert.equal(h.images.length, 2);
  h.images[1].onload();
  assert.equal(h.element("frame").dataset.eventSequence, "10006");
});

test("backend revocation cannot be undone by a late successful command", () => {
  const h = setup(); h.authenticate();
  h.socket.message({ type: "unavailable" });
  h.respond(1, h.state(9, "paused", true));
  assert.equal(h.element("control").disabled, true);
  assert.equal(h.element("stop").disabled, false);
});

test("bridge rendering cleanup failure prevents Resume even if automation cleanup completed", () => {
  const h = setup(); h.authenticate();
  h.respond(1, h.state(1, "paused", true, { viewerCleanupComplete: false }));
  assert.equal(h.element("control").textContent, "重试暂停");
  h.element("control").click();
  assert.equal(h.socket.sent.at(-1).operation, "pause");
});

test("a coalesced status retains the retirement barrier when Clear was replaced", () => {
  const h = setup(); h.running(); h.choose();
  h.frame(1);
  h.socket.message({ type: "state", ...h.state(1, "running", false, { selectedTabId: 1, eventSequence: 10007, retiredSequence: 10005 }) });
  h.images[0].onload();
  assert.equal(h.element("frame").hidden, true);
  h.frame(2, { eventSequence: 10004, retiredSequence: 10005 });
  assert.equal(h.images.length, 1);
  h.frame(1, { streamId: "stream-b", eventSequence: 10006, retiredSequence: 10005 });
  assert.equal(h.images.length, 2);
  h.images[1].onload();
  assert.equal(h.element("frame").dataset.streamId, "stream-b");
});

const mouse = (extra = {}) => ({ pointerId: 1, pointerType: "mouse", clientX: 330, clientY: 200, button: 0, ...extra });
const key = (extra = {}) => ({ key: "Shift", code: "ShiftLeft", keyCode: 16, shiftKey: true, ...extra });

const dialog = (extra = {}) => ({ leaseId: "lease-a", generation: 1, dialogId: "original-dialog", type: "prompt", message: "<img onerror=bad>\n原网页消息", defaultPrompt: "原值", ...extra });
function showDialog(h, value = dialog(), eventSequence = 20002) {
  h.socket.message({ type: "state", ...h.humanState({ eventSequence, pendingDialog: value }) });
}
function dialogReply(h, request, extra = {}) {
  h.respond(request.id, h.humanState({ eventSequence: 20004, pendingDialog: null,
    dialogReceipt: { leaseId: request.leaseId, generation: request.generation, dialogId: request.dialogId, acknowledged: true }, ...extra }));
}

test("dialog source is separate plain text from page messages and absent legacy metadata", () => {
  for (const source of [undefined, { origin: "https://child.example:8443", frame: "child" }, { origin: "https://xn--bcher-kva.example", frame: "top-level" }]) {
    const h = setup(); h.readyHuman();
    const message = "来源：https://pretend.example <img onerror=bad>";
    showDialog(h, dialog({ message, ...(source ? { source } : {}) }));
    assert.equal(h.element("dialog-source").textContent, source ? `来源：${source.frame === "child" ? "子页面" : "主页面"} · ${source.origin}` : "来源未提供");
    assert.equal(h.element("dialog-message").textContent, message);
    assert.equal(h.element("dialog-source").innerHTML, undefined);
    h.element("dialog-accept").click();
    const answer = h.socket.sent.at(-1);
    assert.equal(answer.operation, "humanDialogRespond");
    assert.equal(Object.hasOwn(answer, "source"), false);
  }
});

test("dialog source rejects malformed or noncanonical origin metadata before any choice", () => {
  const invalid = [null, {}, { origin: "https://site.test" }, { origin: "https://site.test", frame: "other" },
    { origin: "https://site.test", frame: "child", url: "https://other.test" },
    ...["null", "data:text/plain,x", "https://user@site.test", "https://site.test/", "https://site.test?", "https://site.test#", "HTTPS://site.test", "https://SITE.test", "https://site.test:443", "https://site.test:", "https://site.test:0444", "https://bücher.test", "https://site.test\n", "https://" + "a".repeat(2048)].map(origin => ({ origin, frame: "child" }))];
  for (const source of invalid) {
    const h = setup(); h.readyHuman(); showDialog(h, dialog({ source }));
    h.element("dialog-accept").click();
    assert.equal(h.socket.sent.some(value => value.operation === "humanDialogRespond"), false, JSON.stringify(source));
    assert.equal(h.element("human-input").dataset.enabled, "false");
  }
});

test("dialog source is pinned including absence without resetting the original choice", () => {
  const original = { origin: "https://child.test", frame: "child" };
  for (const [before, after] of [[original, { ...original, origin: "https://other.test" }], [original, { ...original, frame: "top-level" }], [undefined, original], [original, undefined]]) {
    const h = setup(); h.readyHuman();
    showDialog(h, dialog(before ? { source: before } : {}));
    h.element("dialog-prompt").value = "original answer";
    showDialog(h, dialog(after ? { source: after } : {}), 20003);
    h.element("dialog-accept").click();
    assert.equal(h.socket.sent.some(value => value.operation === "humanDialogRespond"), false);
    assert.equal(h.element("dialog-source").textContent, "");
  }
});

test("dialog source ignores old state and keeps duplicate metadata from resetting edits or claims", () => {
  const h = setup(); h.readyHuman(); const source = { origin: "http://[::1]:8080", frame: "child" };
  showDialog(h, dialog({ source }), 20005);
  h.element("dialog-prompt").value = "edited";
  showDialog(h, dialog({ source: { origin: "https://old.test", frame: "child" } }), 20004);
  showDialog(h, dialog({ source }), 20006);
  assert.equal(h.element("dialog-source").textContent, "来源：子页面 · http://[::1]:8080");
  assert.equal(h.element("dialog-prompt").value, "edited");
  h.element("dialog-accept").click();
  showDialog(h, dialog({ source }), 20007); h.element("dialog-accept").click();
  assert.equal(h.socket.sent.filter(value => value.operation === "humanDialogRespond").length, 1);
  h.element("human-end").click();
  assert.equal(h.element("dialog-source").textContent, "");
});

test("negotiated human input has one bounded outer wait; modal states do not reset it", () => {
  for (const version of [undefined, 1]) {
    const h = setup(version); h.readyHuman();
    const human = { ...h.humanState().human, ...(version ? { inputBudgetVersion: version } : {}) };
    h.socket.message({ type: "state", ...h.humanState({ eventSequence: 20002, human }) });
    h.event("human-input", "beforeinput", { inputType: "insertText", data: "trigger" });
    const input = h.socket.sent.at(-1), originalTimer = [...h.timers.keys()].at(-1);
    assert.equal(h.timerDelays.get(originalTimer), version ? 340000 : 35000);
    for (const [index, dialogId] of ["original", "original", "successor"].entries()) {
      h.socket.message({ type: "state", ...h.humanState({ eventSequence: 20003 + index, human, pendingDialog: dialog({ dialogId }) }) });
      assert.equal([...h.timers.keys()].at(-1), originalTimer);
      assert.equal(h.timerDelays.get(originalTimer), version ? 340000 : 35000);
      assert.equal(h.element("human-input").dataset.acknowledgedSequence, "0");
    }
    assert.match(h.element("dialog-status").textContent, version ? /5 分钟.*共用/ : /30 秒/);
    h.element("dialog-accept").click();
    assert.equal([...h.timerDelays.values()].at(-1), 35000, "native decision keeps its ordinary acknowledgement deadline");
    assert.equal(h.socket.sent.filter(value => value.operation === "humanInput").length, 1);
    h.timers.get(originalTimer)();
    assert.equal(h.socket.sent.at(-1).operation, "humanEnd");
    assert.equal([...h.timerDelays.values()].at(-1), 35000);
    assert.equal(h.element("human-input").dataset.acknowledgedSequence, "0");
    assert.equal(h.socket.sent.filter(value => value.id === input.id).length, 1);
    assert.equal(h.socket.sent.some(value => value.operation === "resume"), false);
  }
});

test("unknown or read-only budget claims grant no input waiting authority", () => {
  for (const version of [0, 1, 2, "1", null]) {
    const h = setup(); h.readyHuman();
    const count = h.socket.sent.length;
    h.socket.message({ type: "state", ...h.humanState({ eventSequence: 20002,
      human: { ...h.humanState().human, inputBudgetVersion: version } }) });
    h.event("human-input", "beforeinput", { inputType: "insertText", data: "never" });
    assert.equal(h.socket.sent.slice(count).some(value => value.operation === "humanInput"), false);
    assert.equal([...h.timerDelays.values()].includes(340000), false);
  }
  const h = setup(); readyResult(h);
  h.socket.message({ type: "state", ...h.state(2, "paused", true, { eventSequence: 20002, tabs: [resultTab()], selectedTabId: 1,
    view: viewState({ inputBudgetVersion: 1 }) }) });
  assert.equal(h.element("human-input").dataset.enabled, "false");
  assert.equal([...h.timerDelays.values()].includes(340000), false);
});

test("human dialog decision bypasses pending input while preserving its separate ACK", () => {
  const h = setup(); h.readyHuman();
  h.event("human-input", "beforeinput", { inputType: "insertText", data: "original-trigger" });
  const input = h.socket.sent.at(-1);
  showDialog(h);
  assert.equal(h.element("dialog-message").textContent, dialog().message);
  assert.equal(h.element("page-dialog").hidden, false);
  assert.equal(h.element("human-input").dataset.enabled, "false");
  assert.equal(h.element("dialog-accept").disabled, false);
  assert.equal(h.element("stop").disabled, false);
  h.element("dialog-prompt").focus(); // Local focus transfer is not lease loss.
  h.element("dialog-prompt").value = "人工输入 中文π 😀";
  h.element("dialog-accept").click();
  const response = h.socket.sent.at(-1);
  assert.deepEqual(response, { id: 5, operation: "humanDialogRespond", leaseId: "lease-a", generation: 1, dialogId: "original-dialog", accept: true, promptText: "人工输入 中文π 😀" });
  assert.equal(h.socket.sent.filter(value => value.operation === "humanEnd").length, 0);
  assert.equal(h.element("human-input").dataset.acknowledgedSequence, "0");
  dialogReply(h, response);
  assert.equal(h.element("human-input").dataset.pending, "1");
  assert.equal(h.element("human-input").dataset.acknowledgedSequence, "0");
  h.ackInput(input, { eventSequence: 20005, pendingDialog: null });
  assert.equal(h.element("human-input").dataset.acknowledgedSequence, "1");
  assert.equal(h.element("human-input").dataset.pending, "0");
  assert.equal(h.socket.sent.some(value => value.operation === "resume"), false);
});

test("same dialog state does not reset an edited prompt or allow duplicate decisions", () => {
  const h = setup(); h.readyHuman(); showDialog(h);
  h.element("dialog-prompt").value = "用户编辑";
  showDialog(h, dialog(), 20003);
  assert.equal(h.element("dialog-prompt").value, "用户编辑");
  h.element("dialog-accept").click();
  showDialog(h, dialog(), 20004);
  h.element("dialog-accept").click(); h.element("dialog-cancel").click();
  assert.equal(h.socket.sent.filter(value => value.operation === "humanDialogRespond").length, 1);
  assert.equal(h.element("dialog-accept").disabled, true);
});

test("a dialog opened by held pointer or key preserves the real release behind original ACK", () => {
  for (const kind of ["pointer", "key"]) {
    const h = setup(); h.readyHuman();
    if (kind === "pointer") h.event("frame", "pointerdown", mouse());
    else h.event("human-input", "keydown", key());
    const down = h.socket.sent.at(-1);
    showDialog(h);
    if (kind === "pointer") h.event("frame", "pointerup", mouse());
    else {
      assert.equal(h.element("human-input").disabled, true);
      h.element("dialog-prompt").focus();
      h.windowEvents.keyup({ ...key({ shiftKey: false }), preventDefault() {} });
      // A bubbled duplicate from the original textarea cannot enqueue twice.
      h.event("human-input", "keyup", key({ shiftKey: false }));
    }
    assert.equal(h.socket.sent.at(-1).id, down.id);
    assert.equal(h.element("human-input").dataset.pending, "2");
    assert.equal(h.socket.sent.some(row => row.operation === "humanEnd"), false);
    h.element("dialog-accept").click(); const decision = h.socket.sent.at(-1);
    // No original release may overtake the pending down ACK, even after Closed.
    dialogReply(h, decision);
    assert.equal(h.socket.sent.at(-1).id, decision.id);
    h.ackInput(down, { eventSequence: 20005, pendingDialog: null });
    const up = h.socket.sent.at(-1);
    assert.equal(up.operation, "humanInput"); assert.equal(up.input.type, kind);
    assert.equal(up.input.action, "up"); assert.equal(up.sequence, down.sequence + 1);
    h.ackInput(up, { eventSequence: 20006, pendingDialog: null });
    if (kind === "pointer") h.event("frame", "pointerdown", mouse());
    else h.event("human-input", "keydown", key());
    assert.equal(h.socket.sent.at(-1).input.action, "down");
    assert.equal(h.socket.sent.at(-1).sequence, up.sequence + 1);
  }
});

test("modal blocks new input and an out-of-frame held release ends control instead of guessing coordinates", () => {
  const h = setup(); h.readyHuman(); h.event("frame", "pointerdown", mouse()); showDialog(h);
  const before = h.socket.sent.length;
  h.event("frame", "pointerdown", mouse({ button: 2 }));
  h.event("human-input", "keydown", key());
  h.event("human-input", "beforeinput", { inputType: "insertText", data: "not-sent" });
  assert.equal(h.socket.sent.length, before);
  h.event("frame", "pointerup", mouse({ clientX: -10 }));
  assert.equal(h.socket.sent.at(-1).operation, "humanEnd");
});

test("successor dialog can be answered before old ACK without borrowing its prompt or choice", () => {
  const h = setup(); h.readyHuman(); showDialog(h);
  h.element("dialog-accept").click(); const first = h.socket.sent.at(-1);
  const successor = dialog({ dialogId: "successor", defaultPrompt: "新值" });
  showDialog(h, successor, 20004);
  assert.equal(h.element("dialog-prompt").value, "新值");
  assert.equal(h.element("dialog-cancel").disabled, false);
  h.element("dialog-cancel").click(); const second = h.socket.sent.at(-1);
  assert.equal(second.accept, false); assert.equal(second.promptText, undefined);
  dialogReply(h, first, { eventSequence: 20003 });
  assert.equal(h.element("page-dialog").dataset.dialogId, "successor");
  assert.equal(h.element("dialog-accept").disabled, true);
  dialogReply(h, second, { eventSequence: 20005 });
  assert.equal(h.element("page-dialog").hidden, true);
  showDialog(h, dialog(), 20002);
  assert.equal(h.element("page-dialog").hidden, true);
});

test("dialog replies require their exact independent receipt and never retry unknown results", () => {
  for (const mode of ["missing", "wrong", "error", "timeout"]) {
    const h = setup(); h.readyHuman(); showDialog(h); h.element("dialog-accept").click();
    const request = h.socket.sent.at(-1);
    if (mode === "timeout") [...h.timers.values()].at(-1)();
    else if (mode === "error") h.socket.message({ type: "response", id: request.id, error: { code: "OPERATION_UNCONFIRMED" } });
    else dialogReply(h, request, { dialogReceipt: mode === "missing" ? undefined : { leaseId: request.leaseId, generation: 1, dialogId: "other", acknowledged: true } });
    assert.equal(h.socket.sent.filter(value => value.operation === "humanDialogRespond").length, 1);
    assert.equal(h.socket.sent.at(-1).operation, "humanEnd");
    assert.equal(h.element("human-input").dataset.enabled, "false");
    assert.equal(h.element("dialog-accept").disabled, true);
  }
});

test("definite unsent stale dialog rejection refreshes state without ending its successor", () => {
  const h = setup(); h.readyHuman(); showDialog(h); h.element("dialog-accept").click();
  const first = h.socket.sent.at(-1);
  showDialog(h, dialog({ dialogId: "next" }), 20004);
  h.socket.message({ type: "response", id: first.id, error: { code: "HUMAN_DIALOG_STALE" } });
  assert.equal(h.socket.sent.at(-1).operation, "status");
  assert.equal(h.socket.sent.some(row => row.operation === "humanEnd"), false);
  assert.equal(h.element("dialog-accept").disabled, false);
  assert.equal(h.element("page-dialog").dataset.dialogId, "next");
  assert.equal(h.socket.sent.filter(row => row.operation === "humanDialogRespond").length, 1);
});

test("invalid or foreign dialog state grants no decision; read-only view cannot answer", () => {
  for (const extra of [{ leaseId: "foreign" }, { generation: 2 }, { type: "beforeunload" }, { message: "\ud800" }, { message: "界".repeat(2731) }, { dialogId: "" }]) {
    const h = setup(); h.readyHuman(); showDialog(h, dialog(extra)); h.element("dialog-accept").click();
    assert.equal(h.socket.sent.some(value => value.operation === "humanDialogRespond"), false);
    assert.equal(h.element("human-input").dataset.enabled, "false");
  }
  const h = setup(); readyResult(h);
  h.socket.message({ type: "state", ...h.state(2, "paused", true, { eventSequence: 20002, tabs: [resultTab()], view: viewState(), pendingDialog: dialog() }) });
  h.element("dialog-accept").click();
  assert.equal(h.socket.sent.some(value => value.operation === "humanDialogRespond"), false);
});

test("dialog prompt rejects malformed or oversized UTF-8 but supports empty and cancellation", () => {
  const h = setup(); h.readyHuman(); showDialog(h);
  for (const value of ["\ud800", "界".repeat(2731)]) {
    h.element("dialog-prompt").value = value; h.element("dialog-accept").click();
    assert.equal(h.socket.sent.some(row => row.operation === "humanDialogRespond"), false);
  }
  h.element("dialog-prompt").value = ""; h.element("dialog-accept").click();
  assert.equal(h.socket.sent.at(-1).promptText, "");
  const cancel = setup(); cancel.readyHuman(); showDialog(cancel);
  cancel.element("dialog-prompt").value = "\ud800"; cancel.element("dialog-cancel").click();
  assert.equal(cancel.socket.sent.at(-1).accept, false);
  assert.equal(cancel.socket.sent.at(-1).promptText, undefined);
});

test("dialog controls stay independent of fresh image decode and are revoked by End or Stop", () => {
  for (const action of ["human-end", "stop", "disconnect"]) {
    const h = setup(); h.readyHuman(); showDialog(h, dialog({ type: "alert", defaultPrompt: undefined }));
    assert.equal(h.element("dialog-prompt-label").hidden, true);
    assert.equal(h.element("dialog-cancel").hidden, true);
    if (action === "disconnect") h.socket.close(); else h.element(action).click();
    h.element("dialog-accept").click();
    assert.equal(h.socket.sent.some(row => row.operation === "humanDialogRespond"), false);
    assert.equal(h.element("page-dialog").hidden, true);
  }
});

test("human input requires a real decode of the matching lease and generation", () => {
  const h = setup(); h.beginHuman();
  assert.equal(h.element("human-input").dataset.enabled, "false");
  h.event("frame", "pointerdown", mouse());
  assert.equal(h.socket.sent.at(-1).operation, "humanBegin");
  h.humanFrame(1, { humanLeaseId: "retired-lease" });
  h.humanFrame(1, { generation: 2 });
  assert.equal(h.images.length, 0);
  h.humanFrame();
  assert.equal(h.element("human-input").dataset.enabled, "false");
  h.images[0].onload();
  assert.equal(h.element("human-input").dataset.enabled, "true");
  assert.equal(h.element("frame").dataset.controlMode, "human");
  assert.equal(h.element("control").disabled, true);
  assert.equal(h.element("watch").disabled, true);
  h.event("frame", "pointerdown", mouse());
  assert.deepEqual(h.socket.sent.at(-1), { id: 4, operation: "humanInput", leaseId: "lease-a", generation: 1, sequence: 1, input: { type: "pointer", action: "down", x: 640, y: 360, button: "left", modifiers: 0 } });
});

test("input coordinates use actual image content and reject letterboxing", () => {
  const h = setup(); h.readyHuman();
  h.element("frame").rect = { left: 10, top: 20, width: 640, height: 640 };
  h.event("frame", "pointerdown", mouse({ clientY: 40 }));
  assert.equal(h.socket.sent.at(-1).operation, "humanBegin");
  h.event("frame", "pointerdown", mouse({ clientY: 340 }));
  assert.equal(h.socket.sent.at(-1).input.x, 640);
  assert.equal(h.socket.sent.at(-1).input.y, 360);
  h.event("frame", "pointermove", mouse({ clientY: 10 }));
  assert.equal(h.socket.sent.at(-1).operation, "humanEnd");
  assert.equal(h.element("human-input").dataset.enabled, "false");
});

test("one in-flight input waits for exact receipt; only adjacent unsent moves coalesce", () => {
  const h = setup(); h.readyHuman();
  h.event("frame", "pointerdown", mouse());
  const first = h.socket.sent.at(-1);
  for (let x = 340; x < 380; x++) h.event("frame", "pointermove", mouse({ clientX: x }));
  h.event("frame", "pointerup", mouse({ clientX: 380 }));
  assert.equal(h.socket.sent.at(-1), first);
  assert.equal(h.element("human-input").dataset.pending, "3");
  h.ackInput(first);
  const move = h.socket.sent.at(-1);
  assert.equal(move.sequence, 2);
  assert.equal(move.input.action, "move");
  assert.equal(move.input.x, 738);
  h.ackInput(move);
  const up = h.socket.sent.at(-1);
  assert.equal(up.sequence, 3);
  assert.equal(up.input.action, "up");
  h.ackInput(up);
  assert.equal(h.element("human-input").dataset.pending, "0");
  assert.equal(h.element("human-input").dataset.acknowledgedSequence, "3");
});

test("ending synchronously blocks admission and does not wait in the input queue", () => {
  const h = setup(); h.readyHuman();
  h.event("frame", "pointerdown", mouse());
  const original = h.socket.sent.at(-1);
  h.event("frame", "pointerup", mouse());
  h.element("human-end").click();
  const end = h.socket.sent.at(-1);
  assert.equal(end.operation, "humanEnd");
  assert.equal(h.element("human-input").dataset.enabled, "false");
  h.ackInput(original);
  assert.equal(h.socket.sent.at(-1), end);
  h.respond(end.id, { ...h.state(2, "paused", true, { eventSequence: 20010, retiredSequence: 20010 }), human: null, humanCleanup: { leaseId: "lease-a", cleanupConfirmed: true } });
  assert.equal(h.element("control").textContent, "继续操作");
  assert.equal(h.element("control").disabled, false);
  assert.equal(h.socket.sent.some(command => command.operation === "resume"), false);
  h.humanFrame(3, { eventSequence: 20011 });
  assert.equal(h.images.length, 1);
});

test("blur releases held input exactly once while native input is still pending", () => {
  const h = setup(); h.readyHuman();
  h.event("frame", "pointerdown", mouse());
  h.event("human-input", "keydown", key());
  h.event("human-input", "blur");
  h.windowEvents.blur();
  assert.equal(h.socket.sent.filter(command => command.operation === "humanEnd").length, 1);
  assert.equal(h.element("human-input").dataset.enabled, "false");
  assert.equal(h.element("human-input").dataset.pending, "1");
});

test("plain text, committed composition and shortcut key transitions have distinct paths", () => {
  const h = setup(); h.readyHuman();
  h.event("human-input", "keydown", key({ key: "a", code: "KeyA", keyCode: 65, shiftKey: false }));
  h.event("human-input", "beforeinput", { inputType: "insertText", data: "a", isComposing: false });
  const text = h.socket.sent.at(-1);
  assert.deepEqual(text.input, { type: "text", text: "a" });
  h.event("human-input", "keyup", key({ key: "a", code: "KeyA", keyCode: 65, shiftKey: false }));
  h.ackInput(text);
  h.event("human-input", "compositionstart");
  h.event("human-input", "beforeinput", { inputType: "insertCompositionText", data: "中文", isComposing: true });
  h.event("human-input", "compositionend", { data: "中文" });
  const composed = h.socket.sent.at(-1);
  assert.deepEqual(composed.input, { type: "text", text: "中文" });
  h.event("human-input", "beforeinput", { inputType: "insertFromComposition", data: "中文", isComposing: false });
  h.ackInput(composed);
  h.event("human-input", "keydown", key({ key: "a", code: "KeyA", keyCode: 65, ctrlKey: true, shiftKey: false }));
  const down = h.socket.sent.at(-1);
  assert.equal(down.input.type, "key");
  assert.equal(down.input.action, "down");
  h.event("human-input", "keyup", key({ key: "a", code: "KeyA", keyCode: 65, ctrlKey: false, shiftKey: false }));
  h.ackInput(down);
  assert.equal(h.socket.sent.at(-1).input.action, "up");
  assert.equal(h.socket.sent.filter(command => command.input?.type === "text").length, 2);
});

for (const [name, code] of [["Backspace", 8], ["Delete", 46], ["ArrowLeft", 37], ["ArrowRight", 39], ["Enter", 13]]) test(`native repeat ${name} preserves every real down and the one up in receipt order`, () => {
  const h = setup(undefined, 1); h.readyHuman();
  const event = { key: name, code: name, keyCode: code, shiftKey: false };
  h.event("human-input", "keydown", key(event));
  const first = h.socket.sent.at(-1);
  h.event("human-input", "keydown", key({ ...event, repeat: false }));
  h.event("human-input", "keydown", key({ ...event, repeat: true }));
  h.event("human-input", "keydown", key({ ...event, repeat: true, shiftKey: true }));
  h.event("human-input", "keyup", key(event));
  assert.equal(h.socket.sent.at(-1), first);
  assert.equal(h.element("human-input").dataset.pending, "4");
  for (let sequence = 1; sequence <= 4; sequence++) {
    const request = h.socket.sent.at(-1);
    assert.equal(request.sequence, sequence);
    assert.deepEqual(request.input, { type: "key", action: sequence === 4 ? "up" : "down", key: name,
      code: name, windowsVirtualKeyCode: code, modifiers: sequence === 3 ? 8 : 0, ...([2, 3].includes(sequence) ? { repeat: true } : {}) });
    h.ackInput(request);
  }
  assert.equal(h.socket.sent.filter(row => row.operation === "humanInput").length, 4);
  assert.equal(h.element("human-input").dataset.pending, "0");
  assert.equal(h.element("human-input").dataset.acknowledgedSequence, "4");
});

test("native repeat requires an original held key and the native lease capability", () => {
  for (const version of [undefined, 1]) {
    const h = setup(undefined, version); h.readyHuman();
    const event = { key: "Backspace", code: "Backspace", keyCode: 8, shiftKey: false };
    const initial = h.socket.sent.length;
    h.event("human-input", "keydown", key({ ...event, repeat: true }));
    assert.equal(h.socket.sent.length, initial, "orphan repeat cannot invent a new held key");
    h.event("human-input", "keydown", key(event)); h.ackInput();
    const down = h.socket.sent.at(-1);
    h.event("human-input", "keydown", key({ ...event, repeat: true }));
    if (version === 1) { assert.equal(h.socket.sent.at(-1).input.repeat, true); h.ackInput(); }
    else assert.equal(h.socket.sent.at(-1), down);
    h.event("human-input", "keyup", key(event));
    assert.equal(h.socket.sent.at(-1).input.action, "up"); h.ackInput();
    assert.equal(h.socket.sent.filter(row => row.operation === "humanInput").length, version === 1 ? 3 : 2);
  }
});

test("native repeat printable characters retain only their original committed text path", () => {
  const h = setup(undefined, 1); h.readyHuman();
  for (const repeat of [false, true, true]) {
    const event = h.event("human-input", "keydown", key({ key: "a", code: "KeyA", keyCode: 65, repeat, shiftKey: false }));
    assert.equal(event.prevented, undefined);
    h.event("human-input", "beforeinput", { inputType: "insertText", data: "a" });
    assert.deepEqual(h.socket.sent.at(-1).input, { type: "text", text: "a" }); h.ackInput();
  }
  h.event("human-input", "keyup", key({ key: "a", code: "KeyA", keyCode: 65, shiftKey: false }));
  assert.equal(h.socket.sent.filter(row => row.operation === "humanInput").length, 3);
});

test("native repeat End and blur drop unsent repetitions without replaying an in-flight one", () => {
  for (const ending of ["End", "blur"]) {
    const h = setup(undefined, 1); h.readyHuman();
    const event = { key: "Delete", code: "Delete", keyCode: 46, shiftKey: false };
    h.event("human-input", "keydown", key(event)); h.ackInput();
    h.event("human-input", "keydown", key({ ...event, repeat: true }));
    const repeat = h.socket.sent.at(-1); assert.equal(repeat.input.repeat, true);
    h.event("human-input", "keydown", key({ ...event, repeat: true }));
    if (ending === "End") h.element("human-end").click(); else h.windowEvents.blur();
    const end = h.socket.sent.at(-1); assert.equal(end.operation, "humanEnd");
    h.ackInput(repeat); assert.equal(h.socket.sent.at(-1), end);
    h.event("human-input", "keyup", key(event));
    assert.equal(h.socket.sent.filter(row => row.operation === "humanInput").length, 2);
    assert.equal(h.socket.sent.filter(row => row.operation === "humanEnd").length, 1);
    h.respond(end.id, releaseState(h));
    assert.equal(h.element("human-input").dataset.pending, "0");
  }
});

test("native repeat navigation retires queued repetitions and requires a new original down", () => {
  const h = setup(undefined, 1); h.readyHuman();
  const event = { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37, shiftKey: false };
  h.event("human-input", "keydown", key(event)); h.ackInput();
  h.event("human-input", "keydown", key({ ...event, repeat: true }));
  const repeat = h.socket.sent.at(-1); assert.equal(repeat.input.repeat, true);
  h.event("human-input", "keydown", key({ ...event, repeat: true }));
  const human = { ...h.humanState().human, generation: 2 };
  h.socket.message({ type: "state", ...h.humanState({ eventSequence: 20003, human: { ...human, state: "navigating", viewport: null } }) });
  h.ackInput(repeat);
  h.socket.message({ type: "state", ...h.humanState({ eventSequence: 20004, human }) });
  h.humanFrame(1, { generation: 2, streamId: "successor", eventSequence: 20005 }); h.images.at(-1).onload();
  assert.equal(h.element("human-input").dataset.enabled, "true");
  h.event("human-input", "keydown", key({ ...event, repeat: true }));
  h.event("human-input", "keyup", key(event));
  assert.equal(h.socket.sent.filter(row => row.operation === "humanInput").length, 2);
  h.event("human-input", "keydown", key(event));
  assert.equal(h.socket.sent.at(-1).generation, 2); assert.equal(h.socket.sent.at(-1).sequence, 1);
  assert.equal(h.socket.sent.at(-1).input.repeat, undefined);
});

test("native repeat capability cannot change on an original lease or a delayed Begin", () => {
  for (const version of [undefined, 1]) {
    for (const next of [undefined, 0, 1, 2, null, "1"]) {
      if (next === version) continue;
      const h = setup(undefined, version); h.readyHuman();
      const human = { ...h.humanState().human }; delete human.keyRepeatVersion;
      if (next !== undefined) human.keyRepeatVersion = next;
      h.socket.message({ type: "state", ...h.humanState({ human, eventSequence: 20002 }) });
      assert.equal(h.element("human-input").dataset.enabled, "false");
      assert.equal(h.socket.sent.at(-1).operation, "humanEnd");
    }
    const h = setup(undefined, version), { begin, original } = beginPreparing(h);
    h.socket.message({ type: "state", ...original, eventSequence: 20003 });
    const human = { ...original.human }; delete human.keyRepeatVersion;
    if (version === undefined) human.keyRepeatVersion = 1;
    h.respond(begin.id, { ...original, human });
    assert.equal(h.element("human-input").dataset.enabled, "false");
    // A rejected Begin never grants the admission required to issue End.
    // The connection becomes unavailable; the UI must not invent a lease ACK.
    assert.equal(h.element("connection").textContent, "控制状态不可用");
    assert.equal(h.socket.sent.some(row => row.operation === "humanInput" || row.operation === "humanEnd"), false);
  }
});

test("native repeat capability is rejected on a read-only view", () => {
  const h = setup(); readyResult(h);
  h.socket.message({ type: "state", ...h.state(2, "paused", true, { eventSequence: 20002, tabs: [resultTab()], selectedTabId: 1,
    view: viewState({ keyRepeatVersion: 1 }) }) });
  assert.equal(h.element("watch").disabled, true);
  assert.equal(h.element("human-input").dataset.enabled, "false");
});

test("native repeat cannot turn an original held key into a remote paste shortcut", () => {
  for (const [held, repeating] of [
    [{ key: "Insert", code: "Insert", keyCode: 45, shiftKey: false }, { key: "Insert", code: "Insert", keyCode: 45, shiftKey: true }],
    [{ key: "v", code: "KeyV", keyCode: 86, altKey: true, shiftKey: false }, { key: "v", code: "KeyV", keyCode: 86, ctrlKey: true, shiftKey: false }],
    [{ key: "v", code: "KeyV", keyCode: 86, altKey: true, shiftKey: false }, { key: "v", code: "KeyV", keyCode: 86, metaKey: true, shiftKey: false }]
  ]) {
    const h = setup(undefined, 1); h.readyHuman();
    h.event("human-input", "keydown", key(held)); h.ackInput();
    const original = h.socket.sent.at(-1);
    const repeat = h.event("human-input", "keydown", key({ ...repeating, repeat: true }));
    assert.equal(repeat.prevented, true, "neither remote nor local paste may run while this original nonmodifier key remains held");
    assert.equal(h.socket.sent.at(-1), original);
    assert.match(h.element("error").textContent, /松开.*粘贴/);
    h.event("human-input", "keyup", key({ ...repeating, repeat: false }));
    assert.equal(h.socket.sent.at(-1).input.action, "up");
    assert.equal(h.socket.sent.at(-1).input.code, held.code); h.ackInput();
    assert.equal(h.socket.sent.filter(row => row.operation === "humanInput").length, 2);
    const normalPaste = h.event("human-input", "keydown", key(repeating));
    assert.equal(normalPaste.prevented, undefined, "released original key restores the normal local paste shortcut");
  }
});

test("local paste shortcuts preserve the browser default without forwarding a paste key", () => {
  for (const shortcut of [
    { key: "v", code: "KeyV", keyCode: 86, ctrlKey: true, shiftKey: false },
    { key: "V", code: "KeyV", keyCode: 86, ctrlKey: true, shiftKey: true },
    { key: "v", code: "KeyV", keyCode: 86, metaKey: true, shiftKey: false },
    { key: "v", code: "Period", keyCode: 86, ctrlKey: true, shiftKey: false },
    { key: "Insert", code: "Insert", keyCode: 45, shiftKey: true },
  ]) {
    const h = setup(); h.readyHuman(); const count = h.socket.sent.length;
    const down = h.event("human-input", "keydown", key(shortcut));
    assert.equal(down.prevented, undefined, "browser must be able to dispatch its original paste");
    h.event("human-input", "keyup", key({ ...shortcut, ctrlKey: false, metaKey: false, shiftKey: false }));
    assert.equal(h.socket.sent.length, count, "paste shortcut must not access the remote clipboard");
  }
});

test("local paste reads plain text once and cannot duplicate it through beforeinput", () => {
  const h = setup(); h.readyHuman(); const reads = [], text = "本地粘贴 🙂\n第二行\t終わり";
  const event = h.event("human-input", "paste", { clipboardData: { getData(type) { reads.push(type); return type === "text/plain" ? text : "<b>wrong</b>"; } } });
  assert.equal(event.prevented, true);
  const sent = h.socket.sent.at(-1); assert.deepEqual(sent.input, { type: "text", text });
  assert.deepEqual(reads, ["text/plain"]);
  h.event("human-input", "beforeinput", { inputType: "insertFromPaste", data: text });
  h.ackInput(sent);
  assert.equal(h.socket.sent.filter(row => row.input?.type === "text").length, 1);
  assert.equal(h.element("human-input").value, "");
});

test("local paste does not inspect clipboard data after End or during composition", () => {
  for (const cause of ["End", "composition"]) {
    const h = setup(); h.readyHuman();
    if (cause === "End") h.element("human-end").click(); else h.event("human-input", "compositionstart");
    const count = h.socket.sent.length;
    const event = h.event("human-input", "paste", { clipboardData: { getData() { throw new Error("unavailable paste data must not be read"); } } });
    assert.equal(event.prevented, true);
    assert.equal(h.socket.sent.length, count);
  }
});

test("local paste keeps repeated text and real modifier transitions in original receipt order", () => {
  for (const held of [
    { key: "Control", code: "ControlLeft", keyCode: 17, ctrlKey: true, shiftKey: false },
    { key: "Meta", code: "MetaLeft", keyCode: 91, metaKey: true, shiftKey: false },
    { key: "Shift", code: "ShiftLeft", keyCode: 16, shiftKey: true },
  ]) {
    const h = setup(); h.readyHuman(); h.event("human-input", "keydown", key(held));
    const down = h.socket.sent.at(-1);
    for (const text of ["第一次\n🙂", "第二次\t終わり"]) h.event("human-input", "paste", { clipboardData: { getData: () => text } });
    h.event("human-input", "keyup", key({ ...held, ctrlKey: false, metaKey: false, shiftKey: false }));
    assert.equal(h.socket.sent.at(-1), down);
    h.ackInput(down); const first = h.socket.sent.at(-1);
    assert.deepEqual(first.input, { type: "text", text: "第一次\n🙂" });
    h.ackInput(first); const second = h.socket.sent.at(-1);
    assert.deepEqual(second.input, { type: "text", text: "第二次\t終わり" });
    h.ackInput(second); const up = h.socket.sent.at(-1);
    assert.equal(up.input.code, held.code); assert.equal(up.input.action, "up");
    h.ackInput(up);
    const commands = h.socket.sent.filter(row => row.operation === "humanInput");
    assert.deepEqual(commands.map(row => row.sequence), [1, 2, 3, 4]);
    assert.ok(commands.every(row => row.leaseId === down.leaseId && row.generation === down.generation));
    assert.equal(h.element("human-input").dataset.pending, "0");
  }
});

test("local paste preserves an older remote key release and honors virtual-key layout", () => {
  const h = setup(); h.readyHuman();
  h.event("human-input", "keydown", key({ key: ".", code: "KeyV", keyCode: 190, ctrlKey: true, shiftKey: false }));
  const down = h.socket.sent.at(-1); assert.equal(down.input.windowsVirtualKeyCode, 190);
  h.event("human-input", "keyup", key({ key: ".", code: "KeyV", keyCode: 190, ctrlKey: true, shiftKey: false }));
  h.ackInput(down);
  const up = h.socket.sent.at(-1); assert.equal(up.input.action, "up");
  assert.equal(up.input.windowsVirtualKeyCode, 190); h.ackInput(up);
  h.event("human-input", "keydown", key({ key: "v", code: "KeyV", keyCode: 86, ctrlKey: true, altKey: true, shiftKey: false }));
  const older = h.socket.sent.at(-1); assert.equal(older.input.action, "down");
  const release = h.event("human-input", "keyup", key({ key: "v", code: "KeyV", keyCode: 86, ctrlKey: true, altKey: false, shiftKey: false }));
  assert.equal(release.prevented, true); h.ackInput(older);
  assert.equal(h.socket.sent.at(-1).input.action, "up");
  assert.equal(h.socket.sent.at(-1).input.windowsVirtualKeyCode, 86);
});

test("local paste modifiers retain their original release during composition", () => {
  const h = setup(); h.readyHuman();
  h.event("human-input", "keydown", key({ key: "Control", code: "ControlLeft", keyCode: 17, ctrlKey: true, shiftKey: false }));
  const down = h.socket.sent.at(-1); h.ackInput(down);
  h.event("human-input", "compositionstart");
  const release = h.event("human-input", "keyup", key({ key: "Control", code: "ControlLeft", keyCode: 17, ctrlKey: false, shiftKey: false, isComposing: true }));
  assert.equal(release.prevented, true);
  const up = h.socket.sent.at(-1); assert.equal(up.input.action, "up");
  assert.equal(up.input.code, "ControlLeft"); h.ackInput(up);
  h.event("human-input", "keydown", key({ key: "Control", code: "ControlLeft", keyCode: 17, ctrlKey: true, isComposing: true }));
  assert.equal(h.socket.sent.at(-1), up, "composition cannot admit a new key hold");
});

test("local paste rejects malformed text without reading rich data or sending replacements", () => {
  for (const text of ["\ud800", "bad\u0000value", "bad\u000bvalue"]) {
    const h = setup(); h.readyHuman(); const count = h.socket.sent.length, reads = [];
    h.event("human-input", "paste", { clipboardData: { getData(type) { reads.push(type); return text; } } });
    assert.equal(h.socket.sent.length, count); assert.deepEqual(reads, ["text/plain"]);
    assert.match(h.element("error").textContent, /未发送/);
  }
});

test("local paste queued before End cannot be sent by a late original key acknowledgment", () => {
  const h = setup(); h.readyHuman();
  h.event("human-input", "keydown", key({ key: "Control", code: "ControlLeft", keyCode: 17, ctrlKey: true, shiftKey: false }));
  const down = h.socket.sent.at(-1);
  h.event("human-input", "paste", { clipboardData: { getData: () => "must not outlive original human" } });
  h.element("human-end").click(); const end = h.socket.sent.at(-1);
  h.ackInput(down);
  assert.equal(h.socket.sent.at(-1), end);
  assert.equal(h.socket.sent.some(row => row.input?.type === "text"), false);
});

test("held Shift, committed uppercase and Shift release keep exact receipt order", () => {
  const h = setup(); h.readyHuman();
  h.event("human-input", "keydown", key());
  const down = h.socket.sent.at(-1);
  h.event("human-input", "keydown", key({ key: "A", code: "KeyA", keyCode: 65 }));
  h.event("human-input", "beforeinput", { inputType: "insertText", data: "A", isComposing: false });
  h.event("human-input", "keyup", key({ key: "A", code: "KeyA", keyCode: 65 }));
  h.event("human-input", "keyup", key({ shiftKey: false }));
  assert.equal(h.socket.sent.at(-1), down);
  assert.equal(h.element("human-input").dataset.pending, "3");
  h.ackInput(down);
  const text = h.socket.sent.at(-1);
  assert.equal(text.sequence, 2); assert.deepEqual(text.input, { type: "text", text: "A" });
  h.ackInput(text);
  const up = h.socket.sent.at(-1);
  assert.equal(up.sequence, 3);
  assert.deepEqual(up.input, { type: "key", action: "up", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, modifiers: 0 });
  h.ackInput(up);
  assert.equal(h.element("human-input").dataset.pending, "0");
  assert.equal(h.element("human-input").dataset.acknowledgedSequence, "3");
  assert.equal(h.socket.sent.filter(command => command.operation === "humanInput").length, 3);
  assert.equal(h.socket.sent.filter(command => command.operation === "humanEnd").length, 0);
});

test("the Go-projected canonical bridge fixture drives human UI without private sequence fields", () => {
  const fixture = JSON.parse(readFileSync(new URL("../testdata/public-human-fixture.json", import.meta.url), "utf8"));
  const h = setup(); h.authenticate();
  const state = name => ({ ...fixture[name], retiredSequence: 0 });
  h.respond(1, state("open")); h.choose(7); h.respond(2, state("select"));
  h.element("human-begin").click();
  h.respond(3, state("humanBegin"));
  assert.equal(h.element("human-input").dataset.enabled, "false");
  assert.equal(fixture.humanBegin.human.viewport, null);
  assert.deepEqual(Object.keys(fixture.humanBegin.human).sort(), ["generation", "leaseId", "state", "tabId", "viewport"]);
  h.socket.message({ type: "state", ...state("humanStatus") });
  h.socket.message({ ...fixture.humanFrame, retiredSequence: 0 });
  assert.equal(h.images.length, 1);
  h.images[0].naturalWidth = h.images[0].naturalHeight = 1;
  h.images[0].onload();
  assert.equal(h.element("human-input").dataset.enabled, "true");
  h.event("human-input", "beforeinput", { inputType: "insertText", data: "A" });
  const input = h.socket.sent.at(-1);
  assert.equal(input.operation, "humanInput"); assert.equal(input.sequence, 1);
  h.respond(input.id, state("humanInput"));
  assert.equal(h.element("human-input").dataset.pending, "0");
  h.element("human-end").click(); h.respond(h.socket.sent.at(-1).id, state("humanEnd"));
  assert.equal(h.element("control").disabled, false);
  h.element("control").click();
  assert.equal(h.socket.sent.at(-1).operation, "resume");
  h.respond(h.socket.sent.at(-1).id, state("humanResume"));
  assert.equal(h.element("state").textContent, "正在运行");
});

test("wheel coordinates and pixel deltas follow the decoded viewport", () => {
  const h = setup(); h.readyHuman();
  const wheel = h.event("frame", "wheel", mouse({ deltaX: 0, deltaY: 3, deltaMode: 1 }));
  assert.equal(wheel.prevented, true);
  assert.deepEqual(h.socket.sent.at(-1).input, { type: "wheel", x: 640, y: 360, deltaX: 0, deltaY: 48, modifiers: 0 });
});

test("committed text uses the same UTF-16 bound as the native human protocol", () => {
  const h = setup(); h.readyHuman();
  h.event("human-input", "beforeinput", { inputType: "insertText", data: "😀".repeat(2049) });
  assert.equal(h.socket.sent.filter(command => command.operation === "humanInput").length, 0);
  assert.equal(h.socket.sent.at(-1).operation, "humanEnd");
  assert.equal(h.element("human-input").dataset.enabled, "false");
});

test("bounded input overflow revokes admission instead of dropping release transitions", () => {
  const h = setup(); h.readyHuman();
  for (let i = 0; i < 34; i++) h.event("human-input", "beforeinput", { inputType: "insertText", data: "a" });
  assert.equal(h.socket.sent.filter(command => command.operation === "humanInput").length, 1);
  assert.equal(h.socket.sent.at(-1).operation, "humanEnd");
  assert.equal(h.element("human-input").dataset.pending, "1");
  assert.equal(h.element("human-input").dataset.enabled, "false");
});

test("wrong original input receipt never drains the next command", () => {
  const h = setup(); h.readyHuman();
  h.event("frame", "pointerdown", mouse());
  const original = h.socket.sent.at(-1);
  h.event("frame", "pointerup", mouse());
  h.ackInput(original, { inputReceipt: { acknowledged: true, leaseId: "lease-a", generation: 1, sequence: 2 } });
  assert.equal(h.socket.sent.filter(command => command.operation === "humanInput").length, 1);
  assert.equal(h.socket.sent.at(-1).operation, "humanEnd");
});

test("late human frame and reply cannot revive control after geometry revocation", () => {
  const h = setup(); h.readyHuman();
  h.humanFrame(2);
  h.socket.message({ type: "state", ...h.humanState({ eventSequence: 20003, human: { ...h.humanState().human, state: "releasing", generation: 2 } }) });
  h.images[1].onload();
  assert.equal(h.element("frame").dataset.frameSequence, "1");
  assert.equal(h.element("human-input").dataset.enabled, "false");
  h.socket.message({ type: "state", ...h.humanState() });
  h.humanFrame(4, { generation: 1 });
  assert.equal(h.images.length, 2);
  assert.equal(h.element("control").disabled, true);
});

test("blur during Begin fences late activation and requests cleanup without input", () => {
  const h = setup(); h.running(); h.choose(); h.respond(2, h.state(1, "running", false, { selectedTabId: 1 }));
  h.element("human-begin").click();
  h.windowEvents.blur();
  h.respond(3, h.humanState());
  assert.equal(h.socket.sent.at(-1).operation, "humanEnd");
  h.humanFrame();
  assert.equal(h.images.length, 0);
  assert.equal(h.element("human-input").dataset.enabled, "false");
});

test("a human frame before Begin receipt waits for matching state and never enables early", () => {
  const h = setup(); h.running(); h.choose(); h.respond(2, h.state(1, "running", false, { selectedTabId: 1 }));
  h.element("human-begin").click();
  h.humanFrame();
  assert.equal(h.images.length, 0);
  h.respond(3, h.humanState());
  assert.equal(h.images.length, 1);
  assert.equal(h.element("human-input").dataset.enabled, "false");
  h.images[0].onload();
  assert.equal(h.element("human-input").dataset.enabled, "true");
});

test("an early human frame survives a pending-Begin paused snapshot without inferred retirement", () => {
  const h = setup(); h.running(); h.choose(); h.respond(2, h.state(1, "running", false, { selectedTabId: 1 }));
  h.element("human-begin").click();
  h.humanFrame();
  h.socket.message({ type: "state", ...h.state(2, "paused", true, { eventSequence: 20002, retiredSequence: 19999, human: null, tabs: [] }) });
  assert.equal(h.images.length, 0);
  assert.equal(h.element("human-input").dataset.enabled, "false");
  h.respond(3, h.humanState({ eventSequence: 20003 }));
  assert.equal(h.images.length, 1);
  h.images[0].onload();
  assert.equal(h.element("human-input").dataset.enabled, "true");
  assert.equal(h.socket.sent.filter(command => command.operation === "humanEnd").length, 0);
});

test("active generation zero waits for the first matching decoded frame and later real generation status", () => {
  const h = setup(); h.running(); h.choose(); h.respond(2, h.state(1, "running", false, { selectedTabId: 1 }));
  h.element("human-begin").click();
  const unready = { ...h.humanState().human, generation: 0, viewport: null };
  h.respond(3, h.humanState({ human: unready }));
  assert.equal(h.element("human-input").dataset.enabled, "false");
  h.humanFrame(2);
  h.humanFrame(1); // An older event cannot replace the single latest slot.
  h.socket.message({ type: "state", ...h.humanState({ eventSequence: 20003, human: unready }) });
  assert.equal(h.images.length, 0);
  h.socket.message({ type: "state", ...h.humanState({ eventSequence: 20004 }) });
  assert.equal(h.images.length, 1);
  assert.equal(h.element("human-input").dataset.enabled, "false");
  h.images[0].onload();
  assert.equal(h.element("human-input").dataset.enabled, "true");
  assert.equal(h.element("frame").dataset.frameSequence, "2");
  assert.equal(h.socket.sent.filter(command => command.operation === "humanEnd").length, 0);
});

test("a failed or retiring human geometry may have null viewport without restoring input", () => {
  const h = setup(); h.readyHuman();
  h.socket.message({ type: "state", ...h.humanState({ eventSequence: 20004, human: { ...h.humanState().human, state: "releasing", generation: 2, viewport: null } }) });
  assert.equal(h.element("human-input").dataset.enabled, "false");
  assert.equal(h.element("control").disabled, true);
  assert.equal(h.element("connection").textContent, "已连接");
  h.socket.message({ type: "state", ...h.humanState({ eventSequence: 20005, human: { ...h.humanState().human, state: "error", generation: 2, viewport: null }, viewerCleanupComplete: false }) });
  assert.equal(h.element("human-end").disabled, false);
  assert.equal(h.element("control").disabled, true);
  assert.equal(h.element("connection").textContent, "已连接");
});

test("explicit retirement or blur discards an early frame before first geometry readiness", () => {
  for (const invalidate of [h => h.socket.message({ type: "clear", eventSequence: 20003, retiredSequence: 20003 }), h => h.windowEvents.blur()]) {
    const h = setup(); h.running(); h.choose(); h.respond(2, h.state(1, "running", false, { selectedTabId: 1 }));
    h.element("human-begin").click();
    h.respond(3, h.humanState({ human: { ...h.humanState().human, generation: 0, viewport: null } }));
    h.humanFrame(); invalidate(h);
    h.socket.message({ type: "state", ...h.humanState({ eventSequence: 20005 }) });
    assert.equal(h.images.length, 0);
    assert.equal(h.element("human-input").dataset.enabled, "false");
  }
});

function readyResultHuman() {
  const h = setup(); readyResult(h); h.element("human-begin").click();
  h.respond(h.socket.sent.at(-1).id, h.humanState({ tabs: [resultTab()], selectedTabId: 1, view: null, eventSequence: 20002, retiredSequence: 20001 }));
  h.humanFrame(1, { eventSequence: 20003, retiredSequence: 20001 }); h.images.at(-1).onload();
  return h;
}
const releaseClear = (h, sequence = 20010) => h.socket.message({ type: "clear", eventSequence: sequence, retiredSequence: sequence });
const releaseState = (h, extra = {}) => h.state(2, "paused", true, { tabs: [resultTab()], human: null, view: null,
  eventSequence: 20011, retiredSequence: 20010, humanCleanup: { leaseId: "lease-a", cleanupConfirmed: true }, ...extra });

for (const order of ["state-first", "response-first"]) test(`human release notice clears on its exact cleanup in ${order} order`, () => {
  const h = readyResultHuman(); h.element("human-end").click(); const end = h.socket.sent.at(-1);
  releaseClear(h); assert.match(h.element("error").textContent, /正在释放人工控制/);
  const cleanup = releaseState(h);
  if (order === "state-first") h.socket.message({ type: "state", ...cleanup });
  h.respond(end.id, cleanup);
  if (order === "response-first") h.socket.message({ type: "state", ...cleanup });
  assert.equal(h.element("error").hidden, true); assert.equal(h.element("error").textContent, "");
  assert.equal(h.element("watch").disabled, false); assert.equal(h.element("human-begin").disabled, false);
  assert.equal(h.element("control").disabled, false); assert.equal(h.element("human-end").hidden, true);
  assert.equal(h.socket.sent.filter(command => command.operation === "humanEnd").length, 1);
});

for (const beginOrder of ["state-first", "response-first"]) test(`human release notice binds a pending Begin only when its original lease is confirmed ${beginOrder}`, () => {
  const h = setup(); readyResult(h); h.element("human-begin").click(); const begin = h.socket.sent.at(-1);
  h.windowEvents.blur(); const notice = h.element("error").textContent;
  assert.match(notice, /正在释放人工控制/);
  assert.equal(h.socket.sent.filter(command => command.operation === "humanEnd").length, 0);
  h.socket.message({ type: "state", ...releaseState(h, { eventSequence: 20002, retiredSequence: 20001, humanCleanup: { leaseId: "old-lease", cleanupConfirmed: true } }) });
  assert.equal(h.element("error").textContent, notice, "a cleanup cannot guess the pending Begin lease");
  const active = h.humanState({ tabs: [resultTab()], selectedTabId: 1, view: null, eventSequence: 20003, retiredSequence: 20001 });
  if (beginOrder === "state-first") h.socket.message({ type: "state", ...active });
  h.respond(begin.id, active);
  const end = h.socket.sent.at(-1); assert.equal(end.operation, "humanEnd"); assert.equal(end.leaseId, "lease-a");
  h.socket.message({ type: "state", ...releaseState(h) }); h.respond(end.id, releaseState(h));
  assert.equal(h.element("error").hidden, true); assert.equal(h.element("human-begin").disabled, false);
  assert.equal(h.socket.sent.filter(command => command.operation === "humanEnd").length, 1);
});

test("human release notice from pending Begin is not revived after an error replaces it", () => {
  const h = setup(); readyResult(h); h.element("human-begin").click(); const begin = h.socket.sent.at(-1);
  h.windowEvents.blur();
  h.socket.message({ type: "response", id: begin.id, error: { code: "OPERATION_UNCONFIRMED", message: "Original Begin outcome is unknown." } });
  h.socket.message({ type: "state", ...h.humanState({ tabs: [resultTab()], selectedTabId: 1, view: null, eventSequence: 20003, retiredSequence: 20001 }) });
  assert.equal(h.socket.sent.filter(command => command.operation === "humanEnd").length, 0, "late state cannot replace the failed Begin receipt");
  h.socket.message({ type: "state", ...releaseState(h) });
  assert.equal(h.element("error").textContent, "Original Begin outcome is unknown.");
  assert.equal(h.element("error").hidden, false);
});

for (const cleanup of [undefined, { leaseId: "other-lease", cleanupConfirmed: true }, { leaseId: "lease-a", cleanupConfirmed: false }]) {
  test(`human release notice requires its own confirmed receipt ${JSON.stringify(cleanup)}`, () => {
    const h = readyResultHuman(); releaseClear(h); const notice = h.element("error").textContent;
    h.socket.message({ type: "state", ...releaseState(h, { humanCleanup: cleanup }) });
    assert.equal(h.element("error").textContent, notice); assert.equal(h.element("error").hidden, false);
    assert.equal(h.element("control").disabled, true); assert.equal(h.element("human-begin").disabled, true);
    h.socket.message({ type: "state", ...releaseState(h, { eventSequence: 20012 }) });
    assert.equal(h.element("error").hidden, true); assert.equal(h.element("control").disabled, false);
  });
}

for (const errorOrder of ["before-clear", "after-clear"]) for (const cleanupOrder of ["state-first", "response-first"]) {
  test(`human release notice cannot hide an unknown input outcome ${errorOrder}/${cleanupOrder}`, () => {
    const h = readyResultHuman(); h.event("human-input", "beforeinput", { inputType: "insertText", data: "one original input" });
    const original = h.socket.sent.at(-1);
    h.element("human-end").click(); const end = h.socket.sent.at(-1);
    if (errorOrder === "after-clear") releaseClear(h);
    h.socket.message({ type: "response", id: original.id, error: { code: "OPERATION_UNCONFIRMED", message: "Original input outcome is unknown; do not replay." } });
    if (errorOrder === "before-clear") releaseClear(h);
    assert.equal(h.element("error").textContent, "Original input outcome is unknown; do not replay.");
    if (cleanupOrder === "state-first") h.socket.message({ type: "state", ...releaseState(h) });
    h.respond(end.id, releaseState(h));
    if (cleanupOrder === "response-first") h.socket.message({ type: "state", ...releaseState(h) });
    assert.equal(h.element("error").textContent, "Original input outcome is unknown; do not replay.");
    assert.equal(h.element("error").hidden, false); assert.equal(h.element("human-input").dataset.acknowledgedSequence, "0");
    assert.equal(h.socket.sent.filter(command => command.operation === "humanInput").length, 1);
    assert.equal(h.socket.sent.filter(command => command.operation === "humanEnd").length, 1);
  });
}

for (const settlement of ["success", "error", "timeout"]) for (const currentNotice of ["progress", "error"]) {
  test(`human release notice and errors belong to the current lease, not old ${settlement}/${currentNotice}`, () => {
    const h = readyResultHuman(); releaseClear(h); const old = h.socket.sent.at(-1), timer = [...h.timers.values()].at(-1);
    h.socket.message({ type: "state", ...releaseState(h) });
    h.element("human-begin").click();
    h.respond(h.socket.sent.at(-1).id, h.humanState({ tabs: [resultTab()], selectedTabId: 1, view: null, eventSequence: 30000, retiredSequence: 29999,
      human: { ...h.humanState().human, leaseId: "lease-b" } }));
    h.humanFrame(1, { eventSequence: 30001, retiredSequence: 29999, streamId: "successor", humanLeaseId: "lease-b" }); h.images.at(-1).onload();
    if (currentNotice === "error") {
      h.event("human-input", "beforeinput", { inputType: "insertText", data: "one successor input" });
      h.socket.message({ type: "response", id: h.socket.sent.at(-1).id, error: { code: "OPERATION_UNCONFIRMED", message: "Successor input outcome is unknown." } });
    } else releaseClear(h, 30002);
    const notice = h.element("error").textContent, sent = h.socket.sent.length;
    if (settlement === "timeout") timer();
    else if (settlement === "error") h.socket.message({ type: "response", id: old.id, error: { code: "OPERATION_UNCONFIRMED", message: "Retired End failed." } });
    else h.respond(old.id, releaseState(h));
    assert.equal(h.element("error").textContent, notice); assert.equal(h.element("error").hidden, false);
    assert.equal(h.socket.sent.length, sent);
    h.socket.message({ type: "state", ...releaseState(h, { eventSequence: 30003, retiredSequence: 30002 }) });
    assert.equal(h.element("error").textContent, notice, "a foreign lease cleanup cannot clear the current message");
    h.socket.message({ type: "state", ...releaseState(h, { eventSequence: 30004, retiredSequence: 30002, humanCleanup: { leaseId: "lease-b", cleanupConfirmed: true } }) });
    assert.equal(h.element("error").hidden, currentNotice === "progress");
    if (currentNotice === "error") assert.equal(h.element("error").textContent, notice);
  });
}

test("human release needs the original cleanup receipt before enabling Agent Resume", () => {
  const h = setup(); h.readyHuman();
  h.element("human-end").click();
  const end = h.socket.sent.at(-1);
  h.respond(end.id, { ...h.state(2, "paused", true, { eventSequence: 20010, retiredSequence: 20010 }), human: null });
  assert.equal(h.element("control").disabled, true);
  assert.equal(h.element("human-end").hidden, false);
  h.socket.message({ type: "state", ...h.state(2, "paused", true, { eventSequence: 20011, retiredSequence: 20010 }), human: null, humanCleanup: { leaseId: "lease-a", cleanupConfirmed: true } });
  assert.equal(h.element("control").disabled, false);
});

test("timeout or socket closure fences queued text without replay", () => {
  const h = setup(); h.readyHuman();
  h.event("human-input", "beforeinput", { inputType: "insertText", data: "a" });
  h.event("human-input", "beforeinput", { inputType: "insertText", data: "b" });
  [...h.timers.values()].at(-1)();
  assert.equal(h.element("human-input").dataset.enabled, "false");
  assert.equal(h.socket.sent.at(-1).operation, "humanEnd");
  assert.equal(h.socket.sent.filter(command => command.operation === "humanInput").length, 1);
  h.socket.close();
  h.event("human-input", "beforeinput", { inputType: "insertText", data: "c" });
  assert.equal(h.socket.sent.filter(command => command.operation === "humanInput").length, 1);
});

test("a late receipt from a finished lease cannot drain its successor input lane", () => {
  const h = setup(); h.readyHuman();
  h.event("human-input", "beforeinput", { inputType: "insertText", data: "old" });
  const old = h.socket.sent.at(-1);
  h.element("human-end").click();
  h.respond(h.socket.sent.at(-1).id, { ...h.state(2, "paused", true, { eventSequence: 20010, retiredSequence: 20010 }), human: null, humanCleanup: { leaseId: "lease-a", cleanupConfirmed: true } });
  h.element("control").click();
  h.respond(h.socket.sent.at(-1).id, h.state(3));
  h.element("human-begin").click();
  const nextState = h.state(4, "paused", true, { eventSequence: 40000, retiredSequence: 39999, human: { ...h.humanState().human, leaseId: "lease-b" } });
  h.respond(h.socket.sent.at(-1).id, nextState);
  h.humanFrame(1, { humanLeaseId: "lease-b", eventSequence: 40001, retiredSequence: 39999, streamId: "human-b" });
  h.images.at(-1).onload();
  h.event("human-input", "beforeinput", { inputType: "insertText", data: "new" });
  const current = h.socket.sent.at(-1);
  h.event("human-input", "beforeinput", { inputType: "insertText", data: "queued" });
  h.ackInput(old);
  assert.equal(h.socket.sent.at(-1), current);
  assert.equal(h.element("human-input").dataset.pending, "2");
  h.respond(current.id, { ...nextState, inputReceipt: { acknowledged: true, leaseId: "lease-b", generation: 1, sequence: 1 } });
  assert.equal(h.socket.sent.at(-1).sequence, 2);
  assert.equal(h.socket.sent.at(-1).leaseId, "lease-b");
});

test("retired Begin, Input and End callbacks cannot change a successor admission", () => {
  for (const operation of ["humanBegin", "humanInput", "humanEnd"]) {
    for (const settlement of ["success", "error", "timeout"]) {
      for (const successorReady of [false, true]) {
        const label = `${operation}/${settlement}/${successorReady ? "active" : "pending"}`;
        const h = setup(); h.running(); h.choose();
        h.respond(2, h.state(1, "running", false, { selectedTabId: 1 }));
        h.element("human-begin").click();
        let old = h.socket.sent.at(-1), timer = [...h.timers.values()].at(-1);
        if (operation === "humanBegin") h.socket.message({ type: "state", ...h.humanState() });
        else {
          h.respond(old.id, h.humanState()); h.humanFrame(); h.images.at(-1).onload();
          if (operation === "humanInput") {
            h.event("human-input", "beforeinput", { inputType: "insertText", data: "original" });
            old = h.socket.sent.at(-1); timer = [...h.timers.values()].at(-1);
          }
        }
        h.element("human-end").click();
        const end = h.socket.sent.at(-1);
        const cleanup = { ...h.state(2, "paused", true, { eventSequence: 20010, retiredSequence: 20010 }), human: null, humanCleanup: { leaseId: "lease-a", cleanupConfirmed: true } };
        if (operation === "humanEnd") {
          old = end; timer = [...h.timers.values()].at(-1);
          h.socket.message({ type: "state", ...cleanup }); // Real cleanup can precede its command response.
        } else if (operation === "humanBegin") {
          assert.equal(h.element("human-end").disabled, true, "early status is not Begin admission");
          h.socket.message({ type: "state", ...cleanup }); // Original backend cleanup may retire a still-pending Begin.
        } else h.respond(end.id, cleanup);
        assert.equal(h.element("control").disabled, false, label);
        h.element("control").click(); h.respond(h.socket.sent.at(-1).id, h.state(3));
        h.element("human-begin").click();
        const begin = h.socket.sent.at(-1);
        const next = h.state(4, "paused", true, { eventSequence: 40000, retiredSequence: 39999, human: { ...h.humanState().human, leaseId: "lease-b" } });
        const makeReady = () => {
          h.respond(begin.id, next);
          h.humanFrame(1, { humanLeaseId: "lease-b", eventSequence: 40001, retiredSequence: 39999, streamId: "human-b" });
          h.images.at(-1).onload();
        };
        if (successorReady) makeReady();
        const count = h.socket.sent.length;
        if (settlement === "timeout") timer();
        else if (settlement === "error") h.socket.message({ type: "response", id: old.id, error: { message: "original operation was revoked" } });
        else if (operation === "humanInput") h.ackInput(old);
        else h.respond(old.id, operation === "humanBegin" ? h.humanState() : cleanup);
        assert.equal(h.socket.sent.length, count, label);
        if (!successorReady) {
          assert.equal(h.element("human-status").textContent, "正在暂停 Agent 并等待原控制释放…", label);
          makeReady();
        }
        assert.equal(h.element("human-input").dataset.enabled, "true", label);
        assert.equal(h.element("connection").textContent, "已连接", label);
        h.event("human-input", "beforeinput", { inputType: "insertText", data: "successor" });
        assert.equal(h.socket.sent.at(-1).leaseId, "lease-b", label);
        assert.equal(h.socket.sent.at(-1).sequence, 1, label);
      }
    }
  }
});

test("retired human callbacks do not suppress the independent Stop acknowledgement", () => {
  const h = setup(); h.readyHuman();
  h.event("human-input", "beforeinput", { inputType: "insertText", data: "old" });
  const old = h.socket.sent.at(-1), timer = [...h.timers.values()].at(-1);
  h.element("human-end").click();
  h.respond(h.socket.sent.at(-1).id, { ...h.state(2, "paused", true, { eventSequence: 20010, retiredSequence: 20010 }), human: null, humanCleanup: { leaseId: "lease-a", cleanupConfirmed: true } });
  h.element("stop").click();
  const stop = h.socket.sent.at(-1);
  timer(); h.socket.message({ type: "response", id: old.id, error: { message: "old" } });
  assert.equal(h.element("state").textContent, "正在停止");
  h.respond(stop.id, { stopped: true });
  assert.equal(h.element("state").textContent, "会话已停止");
});

function generationState(h, generation, state = "active", eventSequence = 21000 + generation * 10) {
  return h.humanState({ eventSequence, retiredSequence: 21000 + generation * 10 - 2,
    human: { ...h.humanState().human, state, generation, viewport: state === "navigating" ? null : { width: 1280, height: 720 } } });
}

function resumeGeneration(h, generation = 2) {
  const state = generationState(h, generation);
  h.socket.message({ type: "state", ...state });
  h.humanFrame(1, { generation, streamId: `human-generation-${generation}`, eventSequence: state.eventSequence + 1, retiredSequence: state.retiredSequence });
  h.images.at(-1).onload();
  return state;
}

test("navigation suspends one lease, clears held UI and unsent input, then restarts sequence after decode", () => {
  const h = setup(); h.readyHuman();
  h.event("frame", "pointerdown", mouse());
  const old = h.socket.sent.at(-1);
  h.event("human-input", "keydown", key());
  h.event("human-input", "compositionstart");
  h.element("human-input").value = "uncommitted";
  h.socket.message({ type: "state", ...generationState(h, 2, "navigating") });
  assert.equal(h.element("human-input").dataset.enabled, "false");
  assert.equal(h.element("human-input").dataset.pending, "0");
  assert.equal(h.element("human-input").value, "");
  assert.equal(h.element("frame").hasPointerCapture(1), false);
  assert.equal(h.element("frame").hidden, true);
  h.event("human-input", "blur"); // Disabling the focused input must not end navigation.
  h.event("frame", "pointerup", mouse());
  h.event("human-input", "beforeinput", { inputType: "insertText", data: "during-navigation" });
  assert.equal(h.socket.sent.at(-1), old);
  assert.equal(h.element("human-end").disabled, false);
  assert.match(h.element("human-status").textContent, /跳转/);
  const next = generationState(h, 2);
  h.socket.message({ type: "state", ...next });
  h.humanFrame(1, { generation: 2, streamId: "new-document", eventSequence: next.eventSequence + 1, retiredSequence: next.retiredSequence });
  assert.equal(h.element("human-input").dataset.enabled, "false");
  h.images.at(-1).onload();
  assert.equal(h.element("human-input").dataset.enabled, "true");
  h.event("human-input", "compositionend", { data: "retired-composition" });
  h.event("human-input", "keyup", key({ shiftKey: false }));
  h.event("frame", "pointerup", mouse());
  assert.equal(h.socket.sent.at(-1), old);
  h.event("human-input", "beforeinput", { inputType: "insertText", data: "new-document" });
  assert.equal(h.socket.sent.at(-1).generation, 2);
  assert.equal(h.socket.sent.at(-1).sequence, 1);
  assert.equal(h.socket.sent.filter(command => command.operation === "humanBegin").length, 1);
  assert.equal(h.socket.sent.filter(command => command.operation === "humanEnd").length, 0);
});

test("navigation retires old success, error and timeout without changing successor input or status", () => {
  for (const settlement of ["success", "error", "timeout"]) {
    const h = setup(); h.readyHuman();
    h.event("human-input", "beforeinput", { inputType: "insertText", data: "old" });
    const old = h.socket.sent.at(-1), timer = [...h.timers.values()].at(-1);
    h.socket.message({ type: "state", ...generationState(h, 2, "navigating") });
    const next = resumeGeneration(h);
    h.event("human-input", "beforeinput", { inputType: "insertText", data: "new" });
    const current = h.socket.sent.at(-1);
    h.event("human-input", "beforeinput", { inputType: "insertText", data: "queued" });
    if (settlement === "success") h.ackInput(old);
    else if (settlement === "error") h.socket.message({ type: "response", id: old.id, error: { code: "OPERATION_UNCONFIRMED", message: "old" } });
    else timer();
    assert.equal(h.socket.sent.at(-1), current, settlement);
    assert.equal(h.element("human-input").dataset.pending, "2", settlement);
    assert.equal(h.element("human-input").dataset.acknowledgedSequence, "0", settlement);
    assert.equal(h.element("connection").textContent, "已连接", settlement);
    h.ackInput(current, next);
    assert.equal(h.socket.sent.at(-1).generation, 2, settlement);
    assert.equal(h.socket.sent.at(-1).sequence, 2, settlement);
  }
});

test("navigation accepts the triggering input's exact old receipt and current navigating state", () => {
  const h = setup(); h.readyHuman();
  h.event("frame", "pointerdown", mouse());
  const down = h.socket.sent.at(-1);
  h.event("frame", "pointerup", mouse());
  h.ackInput(down, generationState(h, 2, "navigating"));
  assert.equal(h.element("human-input").dataset.pending, "0");
  assert.equal(h.element("human-input").dataset.acknowledgedSequence, "0");
  assert.equal(h.socket.sent.at(-1), down);
  resumeGeneration(h);
  h.event("frame", "pointerdown", mouse());
  assert.equal(h.socket.sent.at(-1).generation, 2);
  assert.equal(h.socket.sent.at(-1).sequence, 1);
});

test("navigation buffers one early future frame and rejects late old decode", () => {
  const h = setup(); h.readyHuman();
  h.humanFrame(2);
  const oldDecode = h.images.at(-1);
  h.humanFrame(1, { generation: 2, streamId: "new-document", eventSequence: 21021, retiredSequence: 21018 });
  h.socket.message({ type: "state", ...generationState(h, 2, "navigating") });
  h.humanFrame(2, { generation: 2, streamId: "new-document", eventSequence: 21022, retiredSequence: 21018 });
  h.humanFrame(1, { generation: 2, streamId: "new-document", eventSequence: 21021, retiredSequence: 21018 });
  h.socket.message({ type: "state", ...generationState(h, 2, "active", 21023) });
  assert.equal(h.images.length, 2);
  oldDecode.onload();
  assert.equal(h.element("frame").hidden, true);
  assert.equal(h.images.length, 3);
  h.images.at(-1).onload();
  assert.equal(h.element("frame").dataset.generation, "2");
  assert.equal(h.element("frame").dataset.frameSequence, "2");
  assert.equal(h.element("human-input").dataset.enabled, "true");
  assert.equal(h.socket.sent.filter(command => command.operation === "humanEnd").length, 0);
});

test("navigation coalesced active generation still discards old lane and waits for decode", () => {
  const h = setup(); h.readyHuman();
  h.event("human-input", "beforeinput", { inputType: "insertText", data: "old" });
  h.socket.message({ type: "state", ...generationState(h, 3) });
  assert.equal(h.element("human-input").dataset.enabled, "false");
  assert.equal(h.element("frame").hidden, true);
  h.event("human-input", "blur"); // The coalesced active snapshot also disables the old focused input.
  resumeGeneration(h, 3);
  h.event("human-input", "beforeinput", { inputType: "insertText", data: "new" });
  assert.equal(h.socket.sent.at(-1).sequence, 1);
  assert.equal(h.socket.sent.at(-1).generation, 3);
});

test("navigation stale-before-dispatch error waits for a newer generation without replay or End", () => {
  const h = setup(); h.readyHuman();
  h.event("human-input", "beforeinput", { inputType: "insertText", data: "not-dispatched" });
  const old = h.socket.sent.at(-1);
  h.event("human-input", "beforeinput", { inputType: "insertText", data: "queued-old" });
  h.socket.message({ type: "response", id: old.id, error: { code: "HUMAN_GENERATION_STALE", message: "generation retired before dispatch" } });
  assert.equal(h.element("human-input").dataset.enabled, "false");
  assert.equal(h.element("human-input").dataset.pending, "0");
  assert.equal(h.socket.sent.at(-1), old);
  h.socket.message({ type: "state", ...h.humanState({ eventSequence: 20002 }) });
  h.humanFrame(3); h.images.at(-1).onload();
  assert.equal(h.element("human-input").dataset.enabled, "false");
  resumeGeneration(h);
  h.event("human-input", "beforeinput", { inputType: "insertText", data: "fresh" });
  assert.equal(h.socket.sent.at(-1).input.text, "fresh");
  assert.equal(h.socket.sent.at(-1).sequence, 1);
  assert.equal(h.socket.sent.filter(command => command.operation === "humanEnd").length, 0);
});

test("navigation never overrides explicit End, Stop, blur or connection loss", () => {
  for (const finish of ["end", "stop", "blur", "disconnect"]) {
    const h = setup(); h.readyHuman();
    h.socket.message({ type: "state", ...generationState(h, 2, "navigating") });
    if (finish === "end") h.element("human-end").click();
    else if (finish === "stop") h.element("stop").click();
    else if (finish === "blur") h.windowEvents.blur();
    else h.socket.close();
    const command = h.socket.sent.at(-1);
    h.socket.message({ type: "state", ...generationState(h, 2) });
    h.humanFrame(1, { generation: 2, streamId: "late-new-document", eventSequence: 21021, retiredSequence: 21018 });
    assert.equal(h.element("human-input").dataset.enabled, "false", finish);
    assert.equal(h.socket.sent.at(-1), command, finish);
    if (finish === "end" || finish === "blur") {
      assert.equal(command.operation, "humanEnd");
      h.respond(command.id, h.state(2, "paused", true, { eventSequence: 21030, retiredSequence: 21030, human: null, humanCleanup: { leaseId: "lease-a", cleanupConfirmed: true } }));
      assert.equal(h.element("control").disabled, false, finish);
    } else if (finish === "stop") {
      h.respond(command.id, { stopped: true });
      assert.equal(h.element("state").textContent, "会话已停止");
    }
  }
});

test("navigation cannot replace Begin admission and a valid late receipt cannot regress its generation", () => {
  for (const settlement of ["success", "error", "timeout"]) {
    const h = setup(); h.running(); h.choose();
    h.respond(2, h.state(1, "running", false, { selectedTabId: 1 }));
    h.element("human-begin").click();
    const begin = h.socket.sent.at(-1), timer = [...h.timers.values()].at(-1);
    h.socket.message({ type: "state", ...h.humanState() });
    h.socket.message({ type: "state", ...generationState(h, 2, "navigating") });
    resumeGeneration(h);
    assert.equal(h.element("human-input").dataset.enabled, "false", "state and decoded frame do not admit Begin");
    assert.equal(h.element("human-end").disabled, true);
    if (settlement === "success") h.respond(begin.id, h.humanState());
    else if (settlement === "error") h.socket.message({ type: "response", id: begin.id, error: { code: "OPERATION_UNCONFIRMED", message: "old Begin" } });
    else timer();
    assert.equal(h.element("human-input").dataset.enabled, String(settlement === "success"), settlement);
    assert.equal(h.element("connection").textContent, settlement === "success" ? "已连接" : "控制状态不可用", settlement);
    assert.equal(h.socket.sent.filter(command => command.operation === "humanEnd").length, 0, settlement);
    h.event("human-input", "beforeinput", { inputType: "insertText", data: "new" });
    if (settlement === "success") {
      assert.equal(h.socket.sent.at(-1).generation, 2, settlement);
      assert.equal(h.socket.sent.at(-1).sequence, 1, settlement);
    } else assert.equal(h.socket.sent.filter(command => command.operation === "humanInput").length, 0);
  }
});

test("navigation does not reinterpret unknown input failure as a confirmed stale rejection", () => {
  for (const failure of ["OPERATION_UNCONFIRMED", "HUMAN_STALE", "timeout"]) {
    const h = setup(); h.readyHuman();
    h.event("human-input", "beforeinput", { inputType: "insertText", data: "unknown" });
    const input = h.socket.sent.at(-1);
    if (failure === "timeout") [...h.timers.values()].at(-1)();
    else h.socket.message({ type: "response", id: input.id, error: { code: failure, message: "unknown original result" } });
    assert.equal(h.socket.sent.at(-1).operation, "humanEnd", failure);
    h.socket.message({ type: "state", ...generationState(h, 2, "navigating") });
    h.socket.message({ type: "state", ...generationState(h, 2) });
    h.humanFrame(1, { generation: 2, eventSequence: 21021, retiredSequence: 21018 });
    assert.equal(h.element("human-input").dataset.enabled, "false", failure);
    assert.equal(h.socket.sent.filter(command => command.operation === "humanInput").length, 1, failure);
  }
});

test("navigation rejects malformed readiness and never regresses an established generation", () => {
  const h = setup(); h.readyHuman();
  h.socket.message({ type: "state", ...generationState(h, 2, "navigating") });
  resumeGeneration(h);
  h.socket.message({ type: "state", ...h.humanState({ eventSequence: 21029, retiredSequence: 21018 }) });
  h.event("human-input", "beforeinput", { inputType: "insertText", data: "still-generation-two" });
  assert.equal(h.socket.sent.at(-1).generation, 2);
  for (const human of [
    { state: "navigating", generation: 0, viewport: null },
    { state: "navigating", generation: 2, viewport: { width: 1280, height: 720 } },
    { state: "active", generation: 2, viewport: null }
  ]) {
    const invalid = setup(); invalid.readyHuman();
    invalid.socket.message({ type: "state", ...invalid.humanState({ eventSequence: 21020, human: { ...invalid.humanState().human, ...human } }) });
    assert.equal(invalid.element("human-input").dataset.enabled, "false");
    assert.equal(invalid.socket.sent.at(-1).operation, "humanEnd");
  }
});
