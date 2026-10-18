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

function setup(inputBudgetVersion) {
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
    URL: { createObjectURL() { return `blob:${++nextBlob}`; }, revokeObjectURL(value) { revoked.push(value); } },
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
  function humanState(extra = {}) { return state(2, "paused", true, { eventSequence: 20000, retiredSequence: 19999, human: { state: "active", leaseId: "lease-a", generation: 1, tabId: 1, viewport: { width: 1280, height: 720 }, ...(inputBudgetVersion !== undefined ? { inputBudgetVersion } : {}) }, ...extra }); }
  function beginHuman() { running(); choose(); respond(2, state(1, "running", false, { selectedTabId: 1 })); element("human-begin").click(); respond(3, humanState()); }
  function humanFrame(sequence = 1, extra = {}) { frame(sequence, { streamId: "human-stream", eventSequence: 20000 + sequence, retiredSequence: 19999, controlMode: "human", humanLeaseId: "lease-a", generation: 1, ...extra }); }
  function readyHuman() { beginHuman(); humanFrame(); images.at(-1).onload(); }
  function ackInput(request = socket.sent.at(-1), extra = {}) { respond(request.id, { ...humanState(), inputReceipt: { acknowledged: true, leaseId: request.leaseId, generation: request.generation, sequence: request.sequence }, ...extra }); }
  return { element, socket, images, revoked, timers, timerDelays, replaced, authenticate, state, respond, running, choose, frame, event, windowEvents, documentEvents, humanState, beginHuman, humanFrame, readyHuman, ackInput };
}

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

test("navigation retires a delayed Begin receipt once its original admission changes generation", () => {
  for (const settlement of ["success", "error", "timeout"]) {
    const h = setup(); h.running(); h.choose();
    h.respond(2, h.state(1, "running", false, { selectedTabId: 1 }));
    h.element("human-begin").click();
    const begin = h.socket.sent.at(-1), timer = [...h.timers.values()].at(-1);
    h.socket.message({ type: "state", ...h.humanState() });
    h.socket.message({ type: "state", ...generationState(h, 2, "navigating") });
    resumeGeneration(h);
    if (settlement === "success") h.respond(begin.id, h.humanState());
    else if (settlement === "error") h.socket.message({ type: "response", id: begin.id, error: { code: "OPERATION_UNCONFIRMED", message: "old Begin" } });
    else timer();
    assert.equal(h.element("human-input").dataset.enabled, "true", settlement);
    assert.equal(h.element("connection").textContent, "已连接", settlement);
    assert.equal(h.socket.sent.filter(command => command.operation === "humanEnd").length, 0, settlement);
    h.event("human-input", "beforeinput", { inputType: "insertText", data: "new" });
    assert.equal(h.socket.sent.at(-1).generation, 2, settlement);
    assert.equal(h.socket.sent.at(-1).sequence, 1, settlement);
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
