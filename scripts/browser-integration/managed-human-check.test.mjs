import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import fs from "node:fs/promises";
import { installManagedHumanObserver, installManagedPasteObserver, assertManagedPasteEvidence, projectHumanCommand, assertHumanInputReceipt, captureTaskAuthority, requestOriginalSnapshot, visibleHumanViewerPoint } from "./managed-human-check.mjs";
import { humanPasteText } from "./managed-human-check-fixture.mjs";
import vm from "node:vm";

function pasteProof() {
  const leaseId = "original", generation = 2, connection = 1, raw = humanPasteText.replaceAll("\n", "\r\n");
  const commands = [
    { type: "key", action: "down", code: "ControlLeft", key: "Control", windowsVirtualKeyCode: 17 },
    { type: "text", text: raw },
    { type: "key", action: "up", code: "ControlLeft", key: "Control", windowsVirtualKeyCode: 17 }
  ].map((input, index) => ({ ...projectHumanCommand({ id: index + 1, operation: "humanInput", leaseId, generation, sequence: index + 1, input }), connection }));
  return { viewer: { overflow: false, active: true, events: [{ type: "paste", target: "human-input", trusted: true, defaultPrevented: true, clipboardText: raw }] }, commands,
    replies: commands.map(request => ({ type: "response", id: request.id, connection, result: { inputReceipt: { leaseId, generation, sequence: request.sequence, acknowledged: true } } })),
    before: { documentId: "doc-original", state: { documentToken: "token", events: [] } },
    after: { documentId: "doc-original", draft: "draft" + humanPasteText, state: { documentToken: "token", eventOverflow: false,
      events: [{ type: "beforeinput", trusted: true, data: raw }, { type: "input", trusted: true, data: "line one" }, { type: "input", trusted: true, data: "line two" }] } },
    expectedDraft: "draft" + humanPasteText };
}

test("native local paste proof uses exact one text receipt, not a fixed count of multiline DOM input events", () => {
  const proof = pasteProof(); assert.doesNotThrow(() => assertManagedPasteEvidence(proof));
  assert.equal(assertManagedPasteEvidence(proof).clipboardSHA256, createHash("sha256").update(humanPasteText.replaceAll("\n", "\r\n")).digest("hex"));
});

test("paste proof rejects synthetic events, replay, stale receipt/document and task clipboard routing", () => {
  for (const change of [
    value => { value.viewer.events[0].trusted = false; }, value => { value.viewer.events[0].clipboardText = humanPasteText; },
    value => { value.commands.push(structuredClone(value.commands[1])); }, value => { value.replies[1].result.inputReceipt.generation++; },
    value => { value.after.documentId = "successor"; }, value => { value.after.draft += humanPasteText; },
    value => { value.after.state.events.push({ type: "paste", trusted: true }); },
    value => { value.after.state.events.push({ type: "keydown", code: "KeyV", trusted: true }); }
  ]) { const proof = pasteProof(); change(proof); assert.throws(() => assertManagedPasteEvidence(proof)); }
});

test("passive paste observer bounds synthetic fields and removes the exact listeners", () => {
  const listeners = new Map(), document = { addEventListener(type, listener) { listeners.set(type, listener); }, removeEventListener(type, listener) { assert.equal(listeners.get(type), listener); listeners.delete(type); } };
  const context = vm.createContext({ document, structuredClone }); vm.runInContext(`(${installManagedPasteObserver.toString()})()`, context);
  const event = { type: "paste", target: { id: "human-input", value: "" }, isTrusted: true, defaultPrevented: true, clipboardData: { getData(type) { assert.equal(type, "text/plain"); return humanPasteText; } } };
  listeners.get("paste")(event);
  const before = context.__managedPasteObservation.snapshot(); assert.equal(before.events.length, 1); assert.equal(before.events[0].trusted, true);
  before.events[0].clipboardText = "mutated"; assert.equal(context.__managedPasteObservation.snapshot().events[0].clipboardText, humanPasteText);
  for (let i = 0; i < 256; i++) listeners.get("paste")(event);
  assert.equal(context.__managedPasteObservation.snapshot().overflow, true); assert.equal(context.__managedPasteObservation.snapshot().events.length, 256);
  assert.equal(context.__managedPasteObservation.stop().active, false); assert.equal(listeners.size, 0);
});

test("human viewer point uses the target's visible intersection rather than its offscreen center", () => {
  const target = { x: 24, y: 329.59375, width: 240, height: 90 };
  const viewport = { width: 758, height: 369 }, imageBox = { x: 10, y: 20, ...viewport };
  const point = visibleHumanViewerPoint(target, viewport, imageBox, viewport);
  assert.deepEqual(point.visible, { x: 24, y: 329.59375, width: 240, height: 39.40625 });
  assert.deepEqual(point.nativePoint, { x: 144, y: 349.296875 });
  assert.deepEqual(point.viewerPoint, { x: 154, y: 369.296875 });
  assert.deepEqual(point.target, target); assert.deepEqual(point.viewport, viewport);
  assert.deepEqual(visibleHumanViewerPoint({ x: -30, y: -20, width: 50, height: 40 }, viewport, imageBox, viewport).nativePoint, { x: 10, y: 10 });
  // Native scrollbar pixels are part of the full surface; no guessed inset.
  assert.equal(visibleHumanViewerPoint({ x: 750, y: 0, width: 20, height: 20 }, viewport, imageBox, viewport).nativePoint.x, 754);
});

test("human viewer point preserves decoded image letterboxing and CSS surface coordinates", () => {
  const point = visibleHumanViewerPoint({ x: 40, y: 10, width: 20, height: 30 }, { width: 200, height: 100 },
    { x: 10, y: 20, width: 400, height: 400 }, { width: 800, height: 400 });
  assert.deepEqual(point.imageContentBox, { x: 10, y: 120, width: 400, height: 200 });
  assert.deepEqual(point.nativePoint, { x: 50, y: 25 });
  assert.deepEqual(point.viewerPoint, { x: 110, y: 170 });
  assert.ok(point.viewerPoint.y > point.imageContentBox.y && point.viewerPoint.y < point.imageContentBox.y + point.imageContentBox.height);
});

test("human viewer point fails explicitly for fully invisible or empty targets", () => {
  const viewport = { width: 758, height: 369 }, imageBox = { x: 10, y: 20, ...viewport };
  for (const target of [
    { x: 758, y: 0, width: 20, height: 20 }, { x: 0, y: 369, width: 20, height: 20 },
    { x: -20, y: 0, width: 20, height: 20 }, { x: 0, y: -20, width: 20, height: 20 }
  ]) assert.throws(() => visibleHumanViewerPoint(target, viewport, imageBox, viewport), /no visible intersection/);
  assert.throws(() => visibleHumanViewerPoint({ x: 0, y: 0, width: 0, height: 20 }, viewport, imageBox, viewport), /Invalid target/);
});

test("retired authority probe retains exact original wire scope after the dynamic client begins a new turn", async () => {
  const calls = [];
  const client = { sessionId: "original-session", turnId: "original-turn", controlEpoch: 7,
    request(method, params, options) { calls.push({ method, params, options }); return Promise.reject(new Error("OBU_STALE_CONTROL_EPOCH: original scope retired")); } };
  const original = captureTaskAuthority(client, 42);
  assert.equal(Object.isFrozen(original), true);
  client.turnId = "explicit-successor-turn"; client.controlEpoch = 9;
  await assert.rejects(requestOriginalSnapshot(client, original), /OBU_STALE_CONTROL_EPOCH/);
  assert.deepEqual(calls, [{ method: "browserAction", params: { action: "snapshot", tabId: 42, args: {}, timeoutMs: 1500,
    session_id: "original-session", turn_id: "original-turn", control_epoch: 7 }, options: { timeoutMs: 1500 } }]);
  assert.equal(client.turnId, "explicit-successor-turn"); assert.equal(client.controlEpoch, 9);
  for (const bad of [{ ...client, controlEpoch: null }, { ...client, controlEpoch: 0 }, { ...client, turnId: "" }]) assert.throws(() => captureTaskAuthority(bad, 42));
});

test("each high-ID retired-capability probe replaces its connection before returning to UI control", async () => {
  const source = await fs.readFile(new URL("./managed-human-check.mjs", import.meta.url), "utf8");
  const probe = source.slice(source.indexOf("  async function deniedHuman("), source.indexOf("  const documentRead ="));
  const order = ["const id = 1000000", "lastSequence + 1", "await replyFor(id)", "response.error.code, \"HUMAN_STALE\"", "__managedHumanTestSocket.close()", "command([\"managed\", \"view\"", "await openViewer(fresh.viewerURL)", "await probePage.close()"];
  let offset = -1;
  for (const fragment of order) { const index = probe.indexOf(fragment); assert.ok(index > offset, `Missing or reordered probe boundary: ${fragment}`); offset = index; }
  assert.equal((probe.match(/command\(\["managed", "view"/g) ?? []).length, 1);
  assert.equal(probe.includes("uiAction("), false, "No UI command on the probed connection");
  assert.ok(source.includes('managedHumanSourceFiles'), 'Shared strict source selection is retained');
  const down = source.indexOf('page.keyboard.down("Shift")');
  const text = source.indexOf('page.keyboard.press("KeyA")', down);
  const up = source.indexOf('page.keyboard.up("Shift")', text);
  assert.ok(down > 0 && text > down && up > text, "The original business input includes real Shift+A transitions");
});

test("human command evidence preserves authority and sequence while hashing text payloads", () => {
  assert.equal(projectHumanCommand({ type: "authenticate", token: "private-ticket" }), null);
  assert.deepEqual(projectHumanCommand({ id: 1, operation: "humanBegin", tabId: 8 }), { id: 1, operation: "humanBegin", tabId: 8 });
  const delivered = { id: 9, operation: "humanBegin", tabId: 8, deliveryId: "original-delivery" };
  assert.deepEqual(projectHumanCommand(delivered), delivered);
  for (const deliveryId of [null, "", "x".repeat(129), "bad\nidentity"]) assert.throws(() => projectHumanCommand({ ...delivered, deliveryId }));
  assert.deepEqual(projectHumanCommand({ id: 2, operation: "humanEnd", leaseId: "original-lease" }), { id: 2, operation: "humanEnd", leaseId: "original-lease" });
  const base = { id: 3, operation: "humanInput", leaseId: "original-lease", generation: 1, sequence: 4 };
  const text = "synthetic 人工π", projected = projectHumanCommand({ ...base, input: { type: "text", text } });
  assert.deepEqual(projected, { ...base, input: { type: "text", textBytes: Buffer.byteLength(text), textSHA256: createHash("sha256").update(text).digest("hex") } });
  assert.equal(JSON.stringify(projected).includes(text), false);
  for (const input of [
    { type: "pointer", action: "down", button: "left", x: 10, y: 20, modifiers: 8 },
    { type: "wheel", x: 10, y: 20, deltaX: 0, deltaY: 600 },
    { type: "key", action: "up", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, modifiers: 0 }
  ]) assert.deepEqual(projectHumanCommand({ ...base, input }), { ...base, input });
  for (const command of [
    { ...base, input: { type: "evaluate", expression: "not-allowed" } },
    { ...base, generation: 0, input: { type: "text", text: "x" } },
    { ...base, sequence: 0, input: { type: "text", text: "x" } },
    { ...base, input: { type: "pointer", action: "down", x: -1, y: 20 } },
    { ...base, input: { type: "text", text: "x", channelKey: "private" } },
    { ...base, channelKey: "private", input: { type: "text", text: "x" } },
    { id: 4, operation: "humanBegin", tabId: -1 },
    { id: 4, operation: "humanEnd", leaseId: "" }
  ]) assert.throws(() => projectHumanCommand(command));
});

test("read-only native observer never wraps or invokes debugger commands and removes its original listeners", () => {
  const channel = () => { const listeners = new Set(); return { listeners, addListener: value => listeners.add(value), removeListener: value => listeners.delete(value), emit: (...args) => { for (const listener of listeners) listener(...args); } }; };
  const onEvent = channel(), onDetach = channel();
  const never = () => { throw new Error("Observer must not perform native commands"); };
  const chrome = { debugger: { onEvent, onDetach, attach: never, detach: never, sendCommand: never } }, target = {};
  assert.deepEqual(installManagedHumanObserver(chrome, target), { listenerPresent: true, readOnly: true });
  assert.equal(chrome.debugger.attach, never); assert.equal(chrome.debugger.sendCommand, never);
  onEvent.emit({ targetId: "original-target" }, "Page.screencastFrame", { sessionId: 2, data: "do-not-record-frame-data" });
  onEvent.emit({ tabId: 8 }, "Page.screencastFrame", { sessionId: 3 });
  onEvent.emit({ tabId: 99 }, "Network.requestWillBeSent", { request: { body: "do-not-record-page-data" } });
  onDetach.emit({ targetId: "original-target" }, "canceled_by_user");
  const snapshot = target.__managedHumanAcceptance.snapshot();
  assert.equal(snapshot.events.length, 3); assert.equal(snapshot.overflow, false);
  assert.deepEqual(snapshot.events[0].source, { targetId: "original-target" }); assert.deepEqual(snapshot.events[1].source, { tabId: 8 });
  assert.equal(JSON.stringify(snapshot).includes("do-not-record"), false);
  snapshot.events[0].source.targetId = "mutated-copy";
  assert.equal(target.__managedHumanAcceptance.snapshot().events[0].source.targetId, "original-target");
  const stopped = target.__managedHumanAcceptance.stop(); assert.equal(stopped.listenerPresent, false);
  assert.equal(onEvent.listeners.size, 0); assert.equal(onDetach.listeners.size, 0);
});

test("UI queue completion requires the exact original native input receipt, not just an error-free response", () => {
  const request = { id: 4, operation: "humanInput", leaseId: "original", generation: 2, sequence: 3 };
  const reply = { type: "response", id: 4, result: { inputReceipt: { leaseId: "original", generation: 2, sequence: 3, acknowledged: true } } };
  assert.doesNotThrow(() => assertHumanInputReceipt(request, reply));
  for (const change of [
    value => { value.id = 5; },
    value => { delete value.result.inputReceipt; },
    value => { value.result.inputReceipt.leaseId = "successor"; },
    value => { value.result.inputReceipt.generation = 1; },
    value => { value.result.inputReceipt.sequence = 4; },
    value => { value.result.inputReceipt.acknowledged = false; },
    value => { value.error = { code: "UNKNOWN", message: "original result unknown" }; }
  ]) { const wrong = structuredClone(reply); change(wrong); assert.throws(() => assertHumanInputReceipt(request, wrong)); }
});
