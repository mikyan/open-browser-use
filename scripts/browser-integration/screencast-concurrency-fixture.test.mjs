import test from "node:test";
import assert from "node:assert/strict";
import { installScreencastConcurrencyProbe, checkScreencastConcurrencyEvidence, checkScreencastConcurrency, screencastConcurrencyHTML } from "./screencast-concurrency-fixture.mjs";

function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function setup(sendCommand) {
  const listeners = new Set(), target = {}, api = { debugger: { sendCommand, onEvent: { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) } } };
  installScreencastConcurrencyProbe(api, target, { id: "probe", tabId: 7, sessionId: "session", turnId: "turn", controlEpoch: 3 });
  return { api, target, listeners, controller: target.__obuScreencastConcurrency };
}

test("screenshot gate preserves actual receiver, args and result and waits until explicit release", async () => {
  const native = deferred(), calls = [], result = { data: "real-native-png" };
  const f = setup(function(...args) { calls.push({ receiver: this, args }); return native.promise; });
  const args = [{ tabId: 7 }, "Page.captureScreenshot", { format: "png" }];
  const held = f.api.debugger.sendCommand(...args); let delivered = false;
  held.then(() => { delivered = true; });
  assert.equal(calls.length, 1); assert.equal(calls[0].receiver, f.api.debugger);
  assert.ok(calls[0].args.every((value, index) => value === args[index]));
  native.resolve(result);
  await f.controller.wait("capture-held");
  assert.equal(delivered, false); assert.equal(f.controller.snapshot().pending, 0);
  assert.equal(f.controller.snapshot().records.filter(item => item.kind === "frame").length, 0);
  f.controller.release("test"); assert.equal(await held, result);
  assert.equal(f.controller.restore().restored, true); assert.equal(f.listeners.size, 0);
});

test("other tabs, child sessions, and ordinary calls retain exact native Promise", async () => {
  const native = deferred(), calls = [];
  const f = setup(function(...args) { calls.push(args); return native.promise; });
  for (const args of [[{ tabId: 8 }, "Page.captureScreenshot", {}], [{ tabId: 7, sessionId: "child" }, "Page.captureScreenshot", {}], [{ tabId: 7 }, "Page.startScreencast", {}]])
    assert.equal(f.api.debugger.sendCommand(...args), native.promise);
  assert.equal(calls.length, 3); native.resolve({}); await native.promise;
  assert.equal(f.controller.restore().records.filter(item => item.kind === "send").length, 1);
});

test("native synchronous and asynchronous failures keep original error and are never retried", async () => {
  const error = Object.freeze(new Error("original native failure")); let calls = 0;
  const f = setup(() => { calls++; throw error; });
  assert.throws(() => f.api.debugger.sendCommand({ tabId: 7 }, "Page.captureScreenshot", {}), value => value === error);
  assert.equal(calls, 1); assert.equal(f.controller.restore().pending, 0);
  const g = setup(() => { calls++; return Promise.reject(error); });
  await assert.rejects(g.api.debugger.sendCommand({ tabId: 7 }, "Page.captureScreenshot", {}), value => value === error);
  assert.equal(calls, 2); assert.equal(g.controller.restore().records.some(item => item.kind === "capture-held"), false);
});

test("restore releases held native result and rejects replacement identity", async () => {
  const result = { data: "real" }, f = setup(() => Promise.resolve(result));
  const held = f.api.debugger.sendCommand({ tabId: 7 }, "Page.captureScreenshot", {});
  await f.controller.wait("capture-held"); f.controller.restore(); assert.equal(await held, result);
  const g = setup(() => Promise.resolve({})), foreign = () => Promise.resolve({});
  g.api.debugger.sendCommand = foreign;
  assert.throws(() => g.controller.restore(), /identity changed/); assert.equal(g.api.debugger.sendCommand, foreign); assert.equal(g.listeners.size, 0);
});

test("native listener and request handshake are exact tab/session/turn and bounded", async () => {
  const f = setup(() => Promise.resolve({}));
  const rpc = params => f.target.__integrationNativeRPCObserver("request", { id: 1, method: "executeCdp", params });
  const valid = { target: { tabId: 7 }, session_id: "session", turn_id: "turn", control_epoch: 3, method: "Page.stopScreencast" };
  rpc({ ...valid, session_id: "other" }); rpc({ ...valid, turn_id: "other" }); rpc({ ...valid, control_epoch: 4 }); rpc({ ...valid, target: { tabId: 8 } });
  assert.equal(f.controller.snapshot().requests.length, 0); rpc(valid);
  assert.equal((await f.controller.wait("request")).requests.length, 1);
  for (const listener of f.listeners) {
    listener({ tabId: 8 }, "Page.screencastFrame", { sessionId: 1, data: "foreign" });
    for (let i = 0; i < 2050; i++) listener({ tabId: 7 }, "Page.screencastFrame", { sessionId: i, data: "actual", metadata: { timestamp: 1 } });
  }
  const p = f.controller.restore(); assert.equal(p.records.length, 2048); assert.equal(p.overflow, true);
  assert.ok(p.records.every(item => item.source?.tabId !== 8));
});

function validTrace() {
  let sequence = 0; const records = [], requests = [];
  const entry = fields => { const v = { sequence: ++sequence, at: 10, ...fields }; records.push(v); return v; };
  const send = (method, params = {}) => entry({ kind: "send", source: { tabId: 7 }, method, params });
  const done = call => entry({ kind: "settled", sendSequence: call.sequence, ok: true });
  const frame = id => { entry({ kind: "frame", source: { tabId: 7 }, frameSessionId: id }); done(send("Page.screencastFrameAck", { sessionId: id })); };
  done(send("Page.startScreencast")); frame(1); const capture = send("Page.captureScreenshot"); done(capture);
  entry({ kind: "capture-held", sendSequence: capture.sequence });
  for (const method of ["Page.stopScreencast", "Page.startScreencast"]) requests.push(entry({ kind: "request", method }));
  entry({ kind: "release", reason: "explicit" });
  done(send("Page.stopScreencast")); done(send("Page.stopScreencast")); done(send("Page.startScreencast")); frame(2);
  done(send("Page.captureScreenshot")); frame(3); done(send("Page.stopScreencast"));
  return { tabId: 7, records, requests, pending: 0, overflow: false, watchdog: false };
}

test("native order requires actual frames/ACKs and rejects old finally stopping replacement stream", () => {
  checkScreencastConcurrencyEvidence(validTrace());
  for (const change of [
    p => { p.records.find(item => item.kind === "release").sequence = 999; },
    p => { p.records.find(item => item.kind === "send" && item.method === "Page.stopScreencast").sequence = 1; },
    p => { p.records = p.records.filter(item => item.kind !== "frame"); },
    p => { p.records.find(item => item.kind === "settled").ok = false; },
    p => { p.records.find(item => item.kind === "send").source.sessionId = "child"; },
    p => { p.pending = 1; }, p => { p.overflow = true; }, p => { p.watchdog = true; }
  ]) { const trace = validTrace(); change(trace); assert.throws(() => checkScreencastConcurrencyEvidence(trace)); }
});

test("fixture draws nonce and sequence without timers, activation or generated frame events", () => {
  const html = screencastConcurrencyHTML("1234abcd");
  assert.match(html, /fixtureNonce="1234abcd"/); assert.match(html, /setFixtureSequence\(0\)/);
  assert.doesNotMatch(html, /setTimeout|setInterval|\.focus\(|dispatchEvent|requestAnimationFrame/);
  assert.throws(() => screencastConcurrencyHTML("<script>"));
});

test("a frozen original failure releases and drains all requests before single stop/finalize; cleanup failures remain separate", async () => {
  const original = Object.freeze(new Error("original public read failed")), cleanupError = new Error("finalization failed");
  const waiting = [], events = []; let connects = 0, stopCount = 0, detail, nonce, removed = 0;
  const clients = Array.from({ length: 2 }, () => ({
    client: { sessionId: "same", turnId: "turn", controlEpoch: 7,
      getTabs: async () => [], onNotification: () => () => { removed++; },
      finalizeTabs: async () => { events.push("finalize"); assert.ok(waiting.every(value => value.done)); throw cleanupError; } },
    newTab: async () => ({ id: 7, goto: async url => { nonce = new URL(url).searchParams.get("nonce"); } }),
    cdp: { call: async (_tabId, method, params) => {
      if (method === "Runtime.evaluate") {
        if (params.expression.includes("innerWidth")) return { result: { value: { nonce, sequence: 0, width: 800, height: 600, dpr: 1 } } };
        throw original;
      }
      if (method === "Page.stopScreencast" && ++stopCount === 2) { events.push("cleanup-stop"); return {}; }
      const d = deferred(); const item = { ...d, done: false }; waiting.push(item);
      return d.promise.then(value => { item.done = true; events.push(`settled:${method}`); return value; });
    } },
    close: () => { events.push("close"); }
  }));
  const worker = { evaluate: async expression => {
    if (expression.includes("installScreencastConcurrencyProbe")) return { installed: true };
    if (expression.includes("chrome.tabs.query")) return { tabs: [], targets: [] };
    const method = expression.match(/return p\["([^"]+)"\]/)?.[1];
    if (method === "release") { events.push("release"); for (const item of waiting) item.resolve({}); return true; }
    if (method === "restore") { events.push("restore"); return { restored: true }; }
    if (method === "wait") return {};
    throw new Error("Unexpected fixture read");
  } };
  await assert.rejects(checkScreencastConcurrency({ connectBrowser: async () => clients[connects++], worker,
    fixtureURL: "http://127.0.0.1:8888/", saveScreenshot: async () => { throw new Error("No capture should be saved after barrier failure"); },
    saveDetail: async value => { detail = structuredClone(value); events.push("saved"); }
  }), error => error === original);
  assert.equal(connects, 2); assert.equal(waiting.length, 3); assert.equal(stopCount, 2); assert.equal(removed, 1);
  assert.ok(events.indexOf("release") < events.findIndex(value => value.startsWith("settled:")));
  assert.ok(events.indexOf("cleanup-stop") > events.findLastIndex(value => value.startsWith("settled:")));
  assert.ok(events.indexOf("finalize") < events.indexOf("restore"));
  assert.equal(events.filter(value => value === "finalize").length, 1); assert.equal(events.filter(value => value === "close").length, 2);
  assert.equal(detail.passed, false); assert.match(detail.error, /original public read failed/);
  assert.deepEqual(detail.cleanupErrors.map(value => value.stage), ["finalize"]);
  assert.ok(detail.requestSettlements.some(value => value.status === "rejected"));
});
