import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { captureFixture } from "../testdata/generate-bridge-fixture.mjs";

const source = readFileSync(new URL("./viewer.js", import.meta.url), "utf8");
const ticket = "a".repeat(43);

test("Go projection fixture matches the current real managed worker bridge", async () => {
  assert.deepEqual(await captureFixture(), JSON.parse(readFileSync(new URL("../testdata/bridge-fixture.json", import.meta.url), "utf8")));
});

function setup() {
  const nodes = new Map();
  const images = [], revoked = [], timers = new Map();
  let timerId = 0, replaced, socket;
  function element(id) {
    if (!nodes.has(id)) nodes.set(id, {
      disabled: false, hidden: false, textContent: "", value: "", listeners: {}, dataset: {},
      addEventListener(event, handler) { this.listeners[event] = handler; },
      replaceChildren(...children) { this.children = children; },
      removeAttribute(name) { delete this[name]; },
      click() { this.listeners.click?.(); }
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
    document: { getElementById: element },
    location: { hash: `#ticket=${ticket}`, host: "127.0.0.1:44555", pathname: "/" },
    history: { replaceState(...args) { replaced = args; } },
    URLSearchParams, WebSocket: FakeSocket, Blob, Uint8Array,
    URL: { createObjectURL() { return `blob:${++nextBlob}`; }, revokeObjectURL(value) { revoked.push(value); } },
    Image: FakeImage, Option: class { constructor(text, value) { this.text = text; this.value = value; } },
    atob: value => Buffer.from(value, "base64").toString("binary"),
    setTimeout(callback) { timers.set(++timerId, callback); return timerId; },
    clearTimeout(id) { timers.delete(id); }, setInterval() {},
    window: { addEventListener() {} }
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
  return { element, socket, images, revoked, timers, replaced, authenticate, state, respond, running, choose, frame };
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
