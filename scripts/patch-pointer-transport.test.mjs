import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import vm from "node:vm";
import { patchCrxTransport } from "./build-chrome-extension.mjs";
import { patchCrxDiagnostics } from "./patch-diagnostics.mjs";
import { patchCrxPointerTransport } from "./patch-pointer-transport.mjs";
import { tagPointerCommand, pointerCommandGuard } from "../apps/chrome-extension/browser-pointer-guard.js";

const require = createRequire(new URL("../apps/chrome-extension/package.json", import.meta.url));
const packageDir = path.dirname(require.resolve("playwright-crx/package.json"));
const entry = await fs.readFile(path.join(packageDir, "lib/index.mjs"), "utf8");
const chunk = /from ["']\.\/([^"']+\.mjs)/.exec(entry)[1];
const upstream = await fs.readFile(path.join(packageDir, "lib", chunk), "utf8");
const base = patchCrxDiagnostics(patchCrxTransport(upstream));
const patched = patchCrxPointerTransport(base);
const flush = () => new Promise(resolve => setImmediate(resolve));

function slice(source, start, end) {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `Native pointer fixture boundary changed: ${start}`);
  return source.slice(from, to);
}

test("private pointer tickets have no wire fields and require a live check before tagging", () => {
  const params = Object.freeze({ type: "mouseMoved", x: 12, y: 34 });
  let live = true, checks = 0;
  const ticket = { check() { checks++; if (!live) throw new Error("expired"); } };
  assert.equal(tagPointerCommand(params, ticket), params);
  assert.equal(pointerCommandGuard(params), ticket);
  assert.equal(pointerCommandGuard({ ...params }), undefined);
  assert.equal(tagPointerCommand(params, undefined), params);
  assert.deepEqual(Reflect.ownKeys(params), ["type", "x", "y"]);
  assert.equal(JSON.stringify(params), '{"type":"mouseMoved","x":12,"y":34}');
  live = false;
  assert.throws(() => tagPointerCommand({}, ticket), /expired/);
  assert.equal(checks, 2);
  assert.equal(pointerCommandGuard(null), undefined);
  assert.throws(() => tagPointerCommand({}, {}), /OBU_POINTER_GUARD_INVALID/);
});

test("all pointer transport anchors fail closed on native drift", () => {
  for (const anchor of [
    "diagnosticReleaseGuard(message.params));",
    "async _send(debuggee, method, commandParams, diagnosticGuard)",
    "diagnosticGuard?.(); return chrome.debugger.sendCommand",
    "openBrowserUseInputHooks.send(debuggee, method, commandParams, operation)"
  ]) assert.throws(() => patchCrxPointerTransport(base.replace(anchor, "changed")), /shape changed/);
});

function fixture({ admission, diagnosticGuard } = {}) {
  const native = [], guards = [];
  const context = {
    pointerCommandGuard, diagnosticReleaseGuard: () => diagnosticGuard,
    openBrowserUseInputHooks: { send: async (_target, _method, _params, operation, ticket) => {
      guards.push(ticket);
      if (admission) await admission;
      return operation();
    } },
    openBrowserUseCommandObserver: undefined, observeCrxInputCommand() { throw new Error("Unexpected standalone input"); },
    debugLogger: { isEnabled: () => false },
    chrome: { debugger: { sendCommand: async (target, method, params) => { native.push({ target, method, params }); return {}; } } },
    eventsExports: { EventEmitter }, ProtocolError: class extends Error { setMessage(value) { this.message = value; } },
    assert
  };
  const source = slice(patched, "class CRSession extends", "let CDPSession$1 =") +
    "\nclass NativeTransport {\n" + slice(patched, "  async send(message) {\n    try {\n      const [, tabIdStr]", "  async attach(tabId, onBeforeEmitAttachedToTarget)") +
    slice(patched, "  async _send(debuggee, method, commandParams, diagnosticGuard, pointerGuard) {", "  _emitMessage(message) {") +
    "\n}\n({CRSession, NativeTransport});";
  const { CRSession, NativeTransport } = vm.runInNewContext(source, context);
  const transport = new NativeTransport();
  Object.assign(transport, { _tabToTarget: new Map([[17, { targetId: "original" }]]), _sessions: new Map() });
  let id = 0;
  const connection = { _sessions: new Map(), _transport: transport, _rawSend(sessionId, method, params) {
    const messageId = ++id; void transport.send({ id: messageId, sessionId, method, params }); return messageId;
  } };
  transport._emitMessage = message => connection._sessions.get(message.sessionId)?._onMessage(message);
  const session = sessionId => {
    const client = new CRSession(connection, null, sessionId);
    connection._sessions.set(sessionId, client);
    if (sessionId !== "crx-tab-17") transport._sessions.set(sessionId, 17);
    return client;
  };
  return { native, guards, session };
}

test("real CRSession/transport preserve ticket identity across the root and child parameter copies", async () => {
  const f = fixture();
  let checks = 0;
  const ticket = { check() { checks++; } };
  for (const id of ["crx-tab-17", "child-session"]) {
    await f.session(id).send("Input.dispatchMouseEvent", tagPointerCommand({ type: "mouseMoved", x: 12, y: 34 }, ticket));
  }
  assert.deepEqual(f.guards, [ticket, ticket]);
  assert.equal(checks, 4);
  assert.deepEqual(JSON.parse(JSON.stringify(f.native)), [
    { target: { tabId: 17 }, method: "Input.dispatchMouseEvent", params: { type: "mouseMoved", x: 12, y: 34 } },
    { target: { tabId: 17, sessionId: "child-session" }, method: "Input.dispatchMouseEvent", params: { type: "mouseMoved", x: 12, y: 34 } }
  ]);
});

test("revocation during asynchronous admission blocks the exact native pointer send", async () => {
  let admit, live = true;
  const admission = new Promise(resolve => { admit = resolve; });
  const f = fixture({ admission });
  const ticket = { check() { if (!live) throw new Error("OBU_POINTER_EXPIRED: original progress ended"); } };
  const sent = f.session("crx-tab-17").send("Input.dispatchMouseEvent", tagPointerCommand({ type: "mousePressed" }, ticket));
  const rejected = assert.rejects(sent, /OBU_POINTER_EXPIRED/);
  await flush(); live = false; admit(); await rejected;
  assert.equal(f.native.length, 0);
  assert.equal(f.guards[0], ticket);
});

test("diagnostic release guard remains effective alongside pointer metadata", async () => {
  const f = fixture({ diagnosticGuard: () => { throw new Error("old diagnostic attachment"); } });
  await assert.rejects(f.session("crx-tab-17").send("Runtime.releaseObject", { objectId: "old" }), /old diagnostic attachment/);
  assert.equal(f.native.length, 0);
});

test("untagged CRX commands retain original native parameters", async () => {
  const f = fixture();
  await f.session("crx-tab-17").send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 3, y: 4 });
  assert.equal(f.guards[0], undefined);
  assert.equal(f.native.length, 1);
});
