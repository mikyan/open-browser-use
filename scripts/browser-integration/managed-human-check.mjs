// Actual managed human handoff acceptance. The task page is controlled only by
// the production SDK and the production viewer. Observer scripting only reads.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium as playwrightChromium } from "playwright";
import { createManagedHumanFixture, readManagedHumanDocument, assertManagedHumanReceipt, humanASCII, humanUnicode, humanPasteText } from "./managed-human-check-fixture.mjs";
import { assertManagedViewerTerminal, assertManagedViewerFrames, projectViewerCommand } from "./managed-viewer-check.mjs";
import { connectNormalCDP, managedProcess, runProcess, bound, poll } from "./normal-browser-downloads-support.mjs";
import { listenFixture } from "./fixture-listener.mjs";
import { browserStartupOptions } from "./browser-startup.mjs";
import { waitPrivateDevToolsEndpoint } from "./private-devtools-endpoint.mjs";
import { observedProcessDescendants as descendants } from "./observed-process-descendants.mjs";
import { verifyMemoryClipboard } from "./memory-clipboard.mjs";
import { managedHumanSourceFiles } from "./managed-human-source-snapshot.mjs";
import { humanKeyboardCases, createManagedHumanKeyboardFixture, readManagedHumanKeyboardDocument, assertManagedHumanKeyboardCase, assertManagedHumanKeyboardReceipt, assertManagedHumanKeyboardLedger } from "./managed-human-keyboard-fixture.mjs";
import { humanKeyRepeatCases, nativeKeyRepeatGesture, installManagedKeyRepeatObserver, assertManagedKeyRepeatCase, assertManagedKeyRepeatLedger } from "./managed-human-key-repeat.mjs";
import { createManagedKeyRepeatFixture, readManagedKeyRepeatDocument } from "./managed-human-key-repeat-fixture.mjs";
import { humanIMEText, humanIMEPreedit, installManagedIMEObserver, assertManagedIMEStage, assertManagedIMELedger, managedIMEPresentationMode, readManagedIMEPresentation, assessManagedIMEPresentation, managedIMEPresentationOutcome, assertManagedIMEAbandonment } from "./managed-human-ime.mjs";
import { humanCopyCases, createManagedHumanCopyFixture, readManagedHumanCopyDocument, installManagedCopyReadbackObserver, assertManagedHumanCopyCase } from "./managed-human-copy-fixture.mjs";
import { installManagedCopyRejectionRoute } from "./managed-human-copy-rejection.mjs";
import { createManagedMultiClickFixture, readManagedMultiClickDocument } from "./managed-human-multi-click-fixture.mjs";
import { humanMultiClickCases, managedMultiClickMode, installManagedMultiClickObserver, nativeMultiClickGesture, assertManagedMultiClickCase, assertManagedMultiClickLedger, assertManagedMultiClickTerminal } from "./managed-human-multi-click-workflow.mjs";
import { installCreatedPageObserver } from "./created-page-provenance.mjs";
import { createManagedHumanNewPageFixture, readManagedHumanNewPageDocument } from "./managed-human-new-page-fixture.mjs";
import { managedHumanNewPageTrigger, managedHumanNewPageMode, managedHumanNewPageVariant, managedHumanParentReadonlyEnabled, runManagedHumanNewPageDiagnostic, runManagedHumanNewPageAcceptance, assertManagedHumanNewPageInputs, assertManagedHumanNewPageTerminal } from "./managed-human-new-page-workflow.mjs";
import { managedHumanNativeTraceEnabled, installManagedHumanNativeTrace, managedHumanNativeTraceComplete, managedHumanNativeTraceOutcome } from "./managed-human-native-trace.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const redact = text => String(text).replace(/(#ticket=)[A-Za-z0-9_-]+/g, "$1[redacted]");
const serialize = value => JSON.stringify(value, (_key, item) => typeof item === "string" ? redact(item) : item, 2);

export function managedNewPageDiagnosticOutcome(passed, detail) {
  if (detail?.mode === "acceptance") return { featurePassed: passed === true && detail.proof?.featurePassed === true && detail.agentProof?.originalPlacementPreserved === true && detail.terminalProof?.childCallbackPOSTs === 1 &&
    (!detail.parentReadonly || detail.parentReadonlyProof?.originalReadonlyFrame === true && detail.proof?.originalParentReadonlyFrame === true),
    diagnosticCompleted: false, diagnosticGapConfirmed: false };
  return { featurePassed: false, diagnosticCompleted: passed === true,
    diagnosticGapConfirmed: passed === true && detail?.proof?.classification === "native-child-created-not-selectable" && detail.proof.diagnosticGapConfirmed === true };
}

export function managedCopyRejectionEnabled(scenario, value) {
  assert.ok(value === undefined || value === "0" || value === "1", "OBU_TEST_HUMAN_CLIPBOARD_REJECTION must be 0 or 1");
  if (value === "1") assert.equal(scenario, "human-copy", "Clipboard rejection injection is only valid for human-copy");
  return value === "1";
}

export function assertManagedCopyRejectionEvidence(row) {
  const { lease, before, released, afterLateACK, afterLocalRelease, finalRoute: route } = row;
  assert.equal(row.instrumented, true);
  assert.equal(row.permissionState, "denied");
  assert.equal(route.armed, true); assert.equal(route.connections, 1); assert.equal(route.held, false);
  assert.equal(route.overflow, false); assert.deepEqual(route.errors, []);
  assert.deepEqual(route.scope, { leaseId: lease.leaseId, generation: lease.generation });
  const request = route.request, response = route.response;
  assert.equal(request.operation, "humanInput"); assert.equal(request.leaseId, lease.leaseId); assert.equal(request.generation, lease.generation);
  assert.deepEqual(request.input, { type: "key", action: "down", key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17, modifiers: 2 });
  assert.deepEqual(route.requests, [request]); assert.equal(route.responses.length, 1);
  assert.deepEqual(route.responses[0], response);
  assert.deepEqual(response.receipt, { leaseId: request.leaseId, generation: request.generation, sequence: request.sequence, acknowledged: true });
  assert.equal(response.id, request.id);
  assert.equal(row.deliveredBeforeRelease, false);
  assert.equal(row.heldRoute.held, true);
  assert.deepEqual(row.heldRoute.request, request); assert.deepEqual(row.heldRoute.response, response);
  assert.equal(row.heldDocument.documentId, before.documentId);
  assert.equal(row.heldDocument.state.documentToken, before.state.documentToken);
  assert.deepEqual(row.heldDocument.state.controls, before.state.controls);
  assert.deepEqual(row.heldDocument.state.heldKeys, ["ControlLeft"]);
  assert.deepEqual(row.heldDocument.state.events.slice(before.state.events.length).map(event => [event.type, event.code, event.trusted]),
    [["keydown", "ControlLeft", true]]);
  assert.deepEqual(row.releaseAttempt, route.forwardAttempt);
  assert.equal(row.releaseAttempt.id, request.id);
  assert.equal(row.releaseAttempt.rawSHA256, response.rawSHA256); assert.equal(row.releaseAttempt.bytes, response.bytes);
  assert.equal(row.lateACK.observation, "original-viewer-socket-message");
  assert.equal(typeof row.lateACK.messageTrusted, "boolean"); // Playwright's route shim may report false.
  assert.equal(row.lateACK.rawSHA256, response.rawSHA256); assert.equal(row.lateACK.rawBytes, response.bytes);
  assert.ok(row.lateACK.at >= row.releaseAttempt.attemptedAt);
  assertHumanInputReceipt(request, row.lateACK);
  assert.equal(row.localRejected.pending, "false"); assert.equal(row.localRejected.dataState, "rejected");
  assert.match(row.localRejected.text, /未发送/);
  assert.equal(row.endRequest.operation, "humanEnd"); assert.equal(row.endRequest.leaseId, lease.leaseId);
  assert.equal(row.end.human, null); assert.equal(row.end.viewerCleanupComplete, true);
  assert.deepEqual(row.end.humanCleanup, { leaseId: lease.leaseId, cleanupConfirmed: true });
  assert.ok(row.endRequest.at >= response.serverArrivedAt);
  assert.deepEqual(row.wireAfterArm.map(command => [command.operation, command.id]), [["humanInput", request.id], ["humanEnd", row.endRequest.id]]);
  const originalControl = before.state.controls.copy;
  assert.ok(originalControl.value.length > 0);
  assert.deepEqual([originalControl.selectionStart, originalControl.selectionEnd], [0, originalControl.value.length]);
  for (const doc of [released, afterLateACK, afterLocalRelease]) {
    assert.equal(doc.documentId, before.documentId); assert.equal(doc.state.documentToken, before.state.documentToken);
    assert.equal(doc.state.eventOverflow, false); assert.deepEqual(doc.state.controls, before.state.controls);
    assert.deepEqual(doc.state.heldKeys, []); assert.deepEqual(doc.state.heldButtons, []);
  }
  assert.deepEqual(released.state.events.slice(0, before.state.events.length), before.state.events);
  const events = released.state.events.slice(before.state.events.length);
  assert.deepEqual(events.map(event => [event.type, event.code, event.trusted]), [
    ["keydown", "ControlLeft", true], ["keyup", "ControlLeft", true]
  ]);
  assert.deepEqual(afterLateACK.state.events, released.state.events);
  assert.deepEqual(afterLocalRelease.state.events, released.state.events);
  assert.equal(row.local.active, false); assert.equal(row.local.overflow, false);
  assert.equal(row.local.value, row.expectedLocalText);
  const pastes = row.local.events.filter(event => event.type === "paste");
  assert.equal(pastes.length, 1); assert.equal(pastes[0].trusted, true); assert.equal(pastes[0].text, row.expectedLocalText);
  assert.ok(row.local.events.every(event => event.trusted));
  assert.equal(row.permissionsRestored, true);
  return { originalRequestId: request.id, originalResponseSHA256: response.rawSHA256, endRequestId: row.endRequest.id,
    boundary: "Explicit transport and permission fault injection: one original Ctrl ACK delayed until native local write rejection caused End. The same raw ACK later reached the real viewer socket; no KeyX or cut reached the task, and the original shared memory clipboard was unchanged." };
}

export function assertManagedExtensionManifest(actualBytes, sourceBytes, mainSource) {
  const actualSHA256 = hash(actualBytes), sourceSHA256 = hash(sourceBytes);
  if (actualSHA256 === sourceSHA256) return { mode: "exact-source-bytes", actualSHA256, sourceSHA256 };
  const source = JSON.parse(sourceBytes.toString("utf8")), actual = JSON.parse(actualBytes.toString("utf8"));
  const keys = [...mainSource.matchAll(/^const betaExtensionPublicKey = "([A-Za-z0-9+/=]+)"\s*$/gm)];
  assert.equal(keys.length, 1, "The exact declared beta public key is required");
  assert.equal(Object.hasOwn(source, "key"), false); assert.equal(actual.key, keys[0][1]);
  const { key, ...withoutKey } = actual;
  assert.deepEqual(withoutKey, source, "Stable public key is the only permitted manifest difference");
  return { mode: "source-manifest-plus-declared-beta-key", actualSHA256, sourceSHA256,
    publicKeySHA256: hash(key), publicKeySource: "cmd/open-browser-use/main.go:betaExtensionPublicKey" };
}

// Passive observer on the isolated viewer only, after the clipboard guard.
// It observes browser-dispatched paste; it never constructs ClipboardEvent,
// invokes a clipboard API, or sends task input. All fields are synthetic.
export function installManagedPasteObserver() {
  const events = [], listeners = []; let overflow = false, active = true;
  for (const type of ["copy", "paste", "beforeinput", "input", "keydown", "keyup"]) {
    const listener = event => {
      if (!["human-input", "donor", "neutral"].includes(event.target?.id)) return;
      if (events.length >= 256) { overflow = true; return; }
      const bounded = value => { if (typeof value !== "string") return null; if (value.length > 4096) { overflow = true; return null; } return value; };
      events.push({ sequence: events.length + 1, at: Date.now(), type, target: event.target.id, trusted: event.isTrusted,
        defaultPrevented: event.defaultPrevented, key: event.key ?? null, code: event.code ?? null,
        inputType: event.inputType ?? null, data: bounded(event.data),
        clipboardText: event.clipboardData ? bounded(event.clipboardData.getData("text/plain")) : null,
        value: bounded(event.target.value) });
    };
    document.addEventListener(type, listener, { passive: true }); listeners.push({ type, listener });
  }
  const snapshot = () => ({ events: structuredClone(events), overflow, active });
  Object.defineProperty(globalThis, "__managedPasteObservation", { value: { snapshot, stop() { for (const { type, listener } of listeners) document.removeEventListener(type, listener); active = false; return snapshot(); } } });
}

export function assertManagedPasteEvidence({ viewer, commands, replies, before, after, expectedDraft }) {
  assert.equal(viewer.overflow, false); assert.equal(viewer.active, true);
  const paste = viewer.events.filter(event => event.type === "paste" && event.target === "human-input");
  assert.equal(paste.length, 1); assert.equal(paste[0].trusted, true); assert.equal(paste[0].defaultPrevented, true);
  assert.equal(paste[0].clipboardText, humanPasteText.replaceAll("\n", "\r\n"), "Pinned Windows memory clipboard preserves its original CRLF payload");
  const texts = commands.filter(value => value.input?.type === "text"); assert.equal(texts.length, 1, "Exactly one original committed-text command, never a replay");
  assert.equal(texts[0].input.textBytes, Buffer.byteLength(paste[0].clipboardText)); assert.equal(texts[0].input.textSHA256, hash(paste[0].clipboardText));
  assert.deepEqual(commands.map(value => value.input.type === "text" ? "text" : `${value.input.code}:${value.input.action}`), ["ControlLeft:down", "text", "ControlLeft:up"]);
  for (const request of commands) {
    assert.equal(request.operation, "humanInput"); assert.equal(request.leaseId, texts[0].leaseId); assert.equal(request.generation, texts[0].generation);
    assertHumanInputReceipt(request, replies.find(reply => reply.id === request.id && reply.connection === request.connection));
  }
  assert.equal(after.documentId, before.documentId); assert.equal(after.state.documentToken, before.state.documentToken);
  assert.equal(after.state.eventOverflow, false); assert.equal(after.draft, expectedDraft);
  const nativeEvents = after.state.events.slice(before.state.events.length);
  assert.ok(nativeEvents.some(event => event.type === "beforeinput" && event.trusted));
  assert.ok(nativeEvents.some(event => event.type === "input" && event.trusted));
  assert.equal(nativeEvents.some(event => ["paste", "copy", "cut"].includes(event.type) || event.code === "KeyV"), false, "Task must receive committed text, not a native clipboard shortcut");
  return { requestId: texts[0].id, leaseId: texts[0].leaseId, generation: texts[0].generation, sequence: texts[0].sequence,
    clipboardBytes: texts[0].input.textBytes, clipboardSHA256: texts[0].input.textSHA256, nativeEvents,
    boundary: "One trusted viewer paste, one original text request and exact receipt, unchanged original document and exact LF-normalized textarea value. Multiline native insertion may emit several DOM input events." };
}

export function projectHumanCommand(message) {
  if (["select", "humanBegin"].includes(message?.operation) && Object.hasOwn(message, "pageSelectionId")) {
    assert.equal(message.deliveryId, undefined);
    assert.ok(typeof message.pageSelectionId === "string" && message.pageSelectionId.length > 0 && message.pageSelectionId.length <= 128 && !/[\x00-\x1f\x7f]/.test(message.pageSelectionId));
    const { pageSelectionId, ...ordinary } = message;
    return { ...projectHumanCommand(ordinary), pageSelectionId };
  }
  if (!message?.operation?.startsWith("human")) return projectViewerCommand(message);
  assert.ok(Number.isSafeInteger(message.id) && message.id > 0);
  assert.ok(["humanBegin", "humanInput", "humanEnd"].includes(message.operation));
  const allowed = message.operation === "humanBegin" ? ["id", "operation", "tabId"] : message.operation === "humanEnd" ? ["id", "operation", "leaseId"] : ["id", "operation", "leaseId", "generation", "sequence", "input"];
  if (message.operation === "humanBegin" && message.deliveryId !== undefined) {
    assert.ok(typeof message.deliveryId === "string" && message.deliveryId.length > 0 && message.deliveryId.length <= 128 && !/[\x00-\x1f\x7f]/.test(message.deliveryId));
    allowed.push("deliveryId");
  }
  assert.deepEqual(Object.keys(message).sort(), allowed.sort());
  if (message.operation === "humanBegin") { assert.ok(Number.isSafeInteger(message.tabId) && message.tabId > 0); return { ...message }; }
  assert.ok(typeof message.leaseId === "string" && message.leaseId.length > 0 && message.leaseId.length <= 256);
  if (message.operation === "humanEnd") return { ...message };
  assert.ok(Number.isSafeInteger(message.generation) && message.generation > 0);
  assert.ok(Number.isSafeInteger(message.sequence) && message.sequence > 0);
  const input = message.input; assert.ok(input && typeof input === "object" && !Array.isArray(input));
  const fields = { pointer: ["type", "action", "x", "y", "button", "modifiers", "clickCount"], wheel: ["type", "x", "y", "deltaX", "deltaY", "modifiers"], key: ["type", "action", "key", "code", "windowsVirtualKeyCode", "modifiers", "repeat", "clipboardTransfer", "text"], text: ["type", "text"] }[input.type];
  assert.ok(fields); assert.ok(Object.keys(input).every(key => fields.includes(key)));
  if (input.type === "pointer") { assert.ok(["move", "down", "up"].includes(input.action)); assert.ok(input.button === undefined || ["left", "middle", "right"].includes(input.button)); }
  if (Object.hasOwn(input, "clickCount")) { assert.equal(input.type, "pointer"); assert.ok(["down", "up"].includes(input.action)); assert.ok(Number.isInteger(input.clickCount) && input.clickCount >= 1 && input.clickCount <= 2147483647); }
  if (["pointer", "wheel"].includes(input.type)) for (const key of ["x", "y"]) assert.ok(Number.isFinite(input[key]) && input[key] >= 0);
  if (input.type === "wheel") for (const key of ["deltaX", "deltaY"]) assert.ok(Number.isFinite(input[key]));
  if (input.type === "key") { assert.ok(["down", "up"].includes(input.action)); assert.equal(typeof input.key, "string"); assert.equal(typeof input.code, "string"); assert.ok(Number.isInteger(input.windowsVirtualKeyCode)); if (Object.hasOwn(input, "repeat")) { assert.equal(input.repeat, true); assert.equal(input.action, "down"); } }
  if (input.type === "key" && Object.hasOwn(input, "text")) {
    assert.equal(input.action, "down"); assert.equal(typeof input.text, "string");
    assert.ok(input.text.length >= 1 && input.text.length <= 3 && input.text.isWellFormed() && !/[\x00-\x1f\x7f-\x9f]/.test(input.text));
    assert.equal(Array.from(input.key).length, 1); assert.ok(input.key.isWellFormed() && !/[\x00-\x1f\x7f-\x9f]/.test(input.key));
  }
  if (input.modifiers !== undefined) assert.ok(Number.isInteger(input.modifiers) && input.modifiers >= 0 && input.modifiers <= 15);
  if (Object.hasOwn(input, "clipboardTransfer")) {
    assert.equal(input.action, "down"); assert.equal(input.repeat, undefined); assert.ok([2, 4].includes(input.modifiers));
    const key = input.clipboardTransfer === "copy" ? ["c", "KeyC", 67] : input.clipboardTransfer === "cut" ? ["x", "KeyX", 88] : null;
    assert.ok(key); assert.deepEqual([input.key.toLowerCase(), input.code, input.windowsVirtualKeyCode], key);
  }
  if (input.type === "text") { assert.ok(typeof input.text === "string" && Buffer.byteLength(input.text) <= 8192); return { ...message, input: { type: "text", textBytes: Buffer.byteLength(input.text), textSHA256: hash(input.text) } }; }
  return structuredClone(message);
}

export function assertHumanInputReceipt(request, reply) {
  assert.equal(reply.type, "response"); assert.equal(reply.id, request.id);
  assert.equal(reply.error, undefined, serialize(reply.error));
  const { clipboardTransfer, ...base } = reply.result?.inputReceipt ?? {};
  assert.deepEqual(base, { leaseId: request.leaseId, generation: request.generation, sequence: request.sequence, acknowledged: true }, "The exact original native input acknowledgement is required");
  if (request.input?.clipboardTransfer) {
    assert.equal(clipboardTransfer?.operation, request.input.clipboardTransfer);
    if (clipboardTransfer.status === "ready") {
      assert.deepEqual(Object.keys(clipboardTransfer).sort(), ["operation", "status", "text"]);
      assert.equal(typeof clipboardTransfer.text, "string"); assert.equal(clipboardTransfer.text.isWellFormed(), true);
      assert.ok(Buffer.byteLength(clipboardTransfer.text) <= 65536);
    } else if (clipboardTransfer.status === "unchanged") assert.deepEqual(clipboardTransfer, { operation: request.input.clipboardTransfer, status: "unchanged" });
    else {
      assert.equal(clipboardTransfer.status, "failed"); assert.deepEqual(Object.keys(clipboardTransfer).sort(), ["code", "operation", "status"]);
      assert.ok(["UNSUPPORTED", "DENIED", "BUSY", "CANCELLED", "TIMEOUT", "CHANGED", "LIMIT", "READ_FAILED"].includes(clipboardTransfer.code));
    }
  } else assert.equal(clipboardTransfer, undefined, "Ordinary inputs cannot return unsolicited clipboard text");
}

export function captureTaskAuthority(client, tabId) {
  assert.ok(Number.isSafeInteger(tabId) && tabId > 0);
  assert.ok(typeof client.sessionId === "string" && client.sessionId.length > 0);
  assert.ok(typeof client.turnId === "string" && client.turnId.length > 0);
  assert.ok(Number.isSafeInteger(client.controlEpoch) && client.controlEpoch > 0);
  return Object.freeze({ tabId, sessionId: client.sessionId, turnId: client.turnId, epoch: client.controlEpoch });
}

export function requestOriginalSnapshot(client, original) {
  // Ordinary Tab/Locator wrappers use the client's current scope. This public
  // request deliberately retains the original authority across explicit turns.
  return client.request("browserAction", { action: "snapshot", tabId: original.tabId, args: {}, timeoutMs: 1500,
    session_id: original.sessionId, turn_id: original.turnId, control_epoch: original.epoch }, { timeoutMs: 1500 });
}

export function visibleHumanViewerPoint(target, viewport, imageBox, imagePixels) {
  for (const [name, rect] of [["target", target], ["imageBox", imageBox]]) {
    assert.ok(rect && ["x", "y", "width", "height"].every(key => Number.isFinite(rect[key])) && rect.width > 0 && rect.height > 0, `Invalid ${name} bounds`);
  }
  for (const [name, size] of [["viewport", viewport], ["imagePixels", imagePixels]]) {
    assert.ok(size && ["width", "height"].every(key => Number.isFinite(size[key]) && size[key] > 0), `Invalid ${name} dimensions`);
  }
  const left = Math.max(0, target.x), top = Math.max(0, target.y);
  const right = Math.min(viewport.width, target.x + target.width), bottom = Math.min(viewport.height, target.y + target.height);
  assert.ok(right > left && bottom > top, "Original target has no visible intersection with the input viewport");
  const visible = { x: left, y: top, width: right - left, height: bottom - top };
  const nativePoint = { x: left + visible.width / 2, y: top + visible.height / 2 };
  // Match object-fit:contain using the actual decoded image, then map the
  // original full CSS surface. Scrollbar pixels are not guessed or removed.
  const scale = Math.min(imageBox.width / imagePixels.width, imageBox.height / imagePixels.height);
  const width = imagePixels.width * scale, height = imagePixels.height * scale;
  const imageContentBox = { x: imageBox.x + (imageBox.width - width) / 2, y: imageBox.y + (imageBox.height - height) / 2, width, height };
  const viewerPoint = { x: imageContentBox.x + nativePoint.x * width / viewport.width, y: imageContentBox.y + nativePoint.y * height / viewport.height };
  return { target: { ...target }, viewport: { ...viewport }, imageBox: { ...imageBox }, imagePixels: { ...imagePixels }, visible, nativePoint, imageContentBox, viewerPoint };
}

export function installManagedHumanObserver(chrome, target = globalThis) {
  if (target.__managedHumanAcceptance) throw new Error("Original observer already installed");
  const events = []; let overflow = false, active = true;
  const onEvent = (source, method, params) => {
    if (!["Page.screencastFrame", "Page.frameNavigated", "Page.frameDetached", "Runtime.executionContextsCleared"].includes(method)) return;
    if (events.length >= 1024) { overflow = true; return; }
    events.push({ at: Date.now(), method, source: { ...source }, ...(method === "Page.screencastFrame" ? { nativeSessionId: params.sessionId } : {}) });
  };
  const onDetach = (source, reason) => { if (events.length >= 1024) overflow = true; else events.push({ at: Date.now(), method: "debugger.onDetach", source: { ...source }, reason }); };
  chrome.debugger.onEvent.addListener(onEvent); chrome.debugger.onDetach.addListener(onDetach);
  const snapshot = () => ({ events: structuredClone(events), overflow, listenerPresent: active });
  Object.defineProperty(target, "__managedHumanAcceptance", { configurable: true, value: Object.freeze({ snapshot, stop() { chrome.debugger.onEvent.removeListener(onEvent); chrome.debugger.onDetach.removeListener(onDetach); active = false; return snapshot(); } }) });
  return { listenerPresent: true, readOnly: true };
}

async function treeHashes(root) {
  const entries = await fs.readdir(root, { recursive: true, withFileTypes: true });
  const files = entries.filter(entry => entry.isFile()).map(entry => path.join(entry.parentPath, entry.name)).sort();
  return Object.fromEntries(await Promise.all(files.map(async file => [path.relative(root, file).replaceAll("\\", "/"), hash(await fs.readFile(file))])));
}

export async function runManagedHumanCheck() {
  assert.equal(process.platform, "win32");
  const scenario = process.env.OBU_TEST_HUMAN_SCENARIO ?? "handoff"; assert.ok(["handoff", "local-paste", "ime", "keyboard", "key-repeat", "human-copy", "multi-click", "new-page"].includes(scenario));
  const imePresentationMode = managedIMEPresentationMode(scenario, process.env.OBU_TEST_HUMAN_IME_MODE);
  const multiClickMode = managedMultiClickMode(scenario, process.env.OBU_TEST_HUMAN_MULTI_CLICK_MODE);
  const newPageTrigger = managedHumanNewPageTrigger(scenario, process.env.OBU_TEST_HUMAN_NEW_PAGE_TRIGGER);
  const newPageMode = managedHumanNewPageMode(scenario, process.env.OBU_TEST_HUMAN_NEW_PAGE_MODE);
  const newPageVariant = managedHumanNewPageVariant(scenario, newPageMode, newPageTrigger, process.env.OBU_TEST_HUMAN_NEW_PAGE_VARIANT);
  const nativeTraceEnabled = managedHumanNativeTraceEnabled(scenario, newPageVariant, process.env.OBU_TEST_HUMAN_NATIVE_TRACE);
  const parentReadonly = managedHumanParentReadonlyEnabled(scenario, newPageMode, newPageTrigger, newPageVariant, nativeTraceEnabled, process.env.OBU_TEST_HUMAN_PARENT_READONLY);
  const clipboardRejection = managedCopyRejectionEnabled(scenario, process.env.OBU_TEST_HUMAN_CLIPBOARD_REJECTION);
  const paste = scenario === "local-paste", ime = scenario === "ime", keyboard = scenario === "keyboard", keyRepeat = scenario === "key-repeat", humanCopy = scenario === "human-copy", multiClick = scenario === "multi-click", newPage = scenario === "new-page", explicitEnd = paste || ime || keyboard || keyRepeat || humanCopy || multiClick || newPage;
  const executable = process.env.OBU_TEST_HOST_BINARY, chromium = process.env.OBU_TEST_CHROMIUM_BINARY, extension = process.env.OBU_TEST_EXTENSION_DIR;
  const viewerChromium = paste || humanCopy ? process.env.OBU_TEST_VIEWER_CHROMIUM_BINARY : chromium, buildFile = process.env.OBU_TEST_BUILD_MANIFEST;
  assert.ok(executable && chromium && extension, "Set explicit OBU_TEST_HOST_BINARY, OBU_TEST_CHROMIUM_BINARY, OBU_TEST_EXTENSION_DIR");
  assert.ok(viewerChromium && (!explicitEnd || buildFile), "Paste/IME/keyboard/key-repeat requires a build manifest; local paste also requires an explicit guarded viewer binary");
  await Promise.all([executable, chromium, viewerChromium, extension].map(file => fs.access(file)));
  await fs.mkdir(path.join(repo, ".tmp/browser-integration"), { recursive: true });
  const runDir = await fs.mkdtemp(path.join(repo, ".tmp/browser-integration/", paste ? "mhp-" : ime ? "mhi-" : keyboard ? "mhk-" : keyRepeat ? "mhr-" : humanCopy ? "mhc-" : multiClick ? "mmc-" : newPage ? "mnp-" : "managed-human-"));
  const root = path.join(runDir, explicitEnd ? "r" : "owned-root"), name = paste ? "p" : ime ? "i" : keyboard ? "k" : keyRepeat ? "r" : humanCopy ? "c" : multiClick ? "m" : newPage ? "n" : "human-acceptance", viewerProfile = path.join(runDir, "viewer-profile");
  const report = { scenario, runDir, startedAt: Date.now(), commands: [], steps: [], cleanup: {}, frames: [], viewerCommands: [], viewerMessages: [], viewerActions: [], viewerDecodedFrames: [], viewerErrors: [], denied: [],
    scope: humanCopy ? `Production Go/UI/extension clipboard transfer with independently guarded task and viewer HeadlessClipboard. Seven original copy/cut cases, including cancelled copy/cut, exact native receipts, End before trusted local paste readback, explicit Resume and original handoff one POST/Stop. No OS clipboard, task CDP attachment, clipboard API substitution or business replay. Shared managed clipboard is not page-origin provenance.${clipboardRejection ? " An additional explicitly instrumented case denies viewer clipboard permission and delays one original Ctrl ACK through a WebSocket route; actual UI message delivery is observed on its original socket." : " No permission override or WebSocket route."}`
      : paste ? "Production managed human viewer, guarded headless memory clipboard and trusted local Ctrl+V, original multiline form, exact native receipts, End with held Shift and one final SDK POST. No OS clipboard read/write/restore, no task clipboard command, no business replay or task CDP attachment."
      : ime ? "Production managed human viewer with browser-native CDP IME composition on the isolated headless viewer only. Candidate updates, two identical commits and cancellation; original task text receipts/document/one POST, held-Shift End and Stop. No Windows OS input method, clipboard, synthetic DOM event, task CDP input or business replay."
      : keyRepeat ? "Production managed viewer native key down plus explicit autoRepeat key events for Backspace/Delete/ArrowLeft/ArrowRight, prevented defaults and End-held-repeat cleanup. Original task values/selections/receipts and independent handoff one POST. CDP keyboard simulation targets only the viewer; no OS input, clipboard, synthetic DOM event, task CDP input or business replay."
      : keyboard ? "Production managed viewer native Enter/Shift+Enter/NumpadEnter editing, prevented default, one original implicit form POST; independent original handoff POST, held-Shift End, explicit Resume and Stop. No OS input, clipboard, task CDP input or business replay."
      : multiClick ? `Production managed viewer receives original native mouse down/up counts 1/2/3. Original textarea word/line selection, trusted task dblclick, exact input receipts, End/Resume and independent original handoff one POST/Stop. No task input injection, selection mutation, OS mouse or business replay. Mode=${multiClickMode}; baseline completion is not feature acceptance.`
      : newPage ? newPageMode === "diagnostic" ? `Diagnostic only: one real viewer click (${newPageTrigger}) opens a cross-site native child. Passive native source event, original parent/child documents and authoritative viewer inventory are observed without arming a waiter, adopting a child, or injecting task/child input. The untouched child cannot callback; the independent original handoff still performs its one POST after End/Resume. No OS input or personal profile. Completion is not feature acceptance or proof of window focus behavior.`
        : `Production viewer explicit page switching (${newPageTrigger}/${newPageVariant}): native cross-site child, original cleanup, user selection receipt and Begin, one trusted child callback, return to original parent, End/Resume/new turn and public SDK claim/read, independent handoff POST and Stop. The parent-navigate fixture explicitly migrates its own draft through sessionStorage; that is application behavior. Native opener provenance only locates; selection grants authority. No task/child input injection, URL reopening, OS input, personal profile or full SSO/OS-focus claim.`
      : "Production managed human UI, one original synthetic form and one final SDK POST; separate nonbusiness explicit-release page; original viewer WebSocket disconnect with held inputs; no real credentials, OS input, input retry, or extra task page CDP attachment" };
  if (nativeTraceEnabled) {
    report.instrumented = true;
    report.nativeTrace = { enabled: true, boundary: "Explicit OBU_TEST_HUMAN_NATIVE_TRACE=1. Bounded original native send/ACK/event observation may change scheduling. No acceptance claim, task input injection, retries, added readiness gates or native metadata dispatch." };
    report.scope += " This run is instrumented native tracing for parent-navigate diagnosis only; even a successful workflow is not production acceptance.";
  }
  if (parentReadonly) report.scope += " Explicit readonly-parent acceptance uses ordinary End, original parent selection, its saved and DOM-decoded user-view frame while the parent remains hidden/unfocused, then a separate real Begin click. No interception, artificial delay, extra native render command or business replay. Native focus-command exclusion relies on the frozen view implementation and its integration tests; runtime evidence is the original UI commands and passive focus/visibility snapshots.";
  const save = () => fs.writeFile(path.join(runDir, "results.json"), serialize(report));
  const registry = new Set(), frameWrites = [], screenshots = [];
  let launcher, info, worker, taskBrowser, viewerProcess, viewerBrowser, viewerContext, page, captureError, state, stopped = false, imeEndSession;
  let copyTab, repeatTab, keyboardTab, multiClickTab, oldTaskTab, oldTaskAuthority, freshTaskTab, original, normalLease, businessLease;
  let copyRejectionRoute, restoreCopyPermissions = false;
  const stopNativeTrace = async () => {
    if (!nativeTraceEnabled || !worker || !report.nativeTrace.installed || report.nativeTrace.final) return;
    report.nativeTrace.final = await worker.evaluate("globalThis.__managedHumanNativeTrace.stop()");
    report.nativeTrace.traceComplete = managedHumanNativeTraceComplete(report.nativeTrace.final);
    assert.equal(report.nativeTrace.final.active, false); assert.equal(report.nativeTrace.final.restored, true);
    assert.equal(report.nativeTrace.final.listenerPresent, false);
  };
  const fixture = createManagedHumanFixture({ scenario: keyboard || keyRepeat || humanCopy || multiClick || newPage ? "handoff" : scenario });
  const newPageFixture = newPage ? createManagedHumanNewPageFixture({ trigger: newPageTrigger, variant: newPageVariant }) : null;
  const multiClickFixture = multiClick ? createManagedMultiClickFixture() : null;
  const copyFixture = humanCopy ? createManagedHumanCopyFixture() : null;
  const repeatFixture = keyRepeat ? createManagedKeyRepeatFixture() : null;
  const keyboardFixture = keyboard ? createManagedHumanKeyboardFixture() : null;
  const server = createServer((request, response) => { if (!newPageFixture?.handle(request, response) && !multiClickFixture?.handle(request, response) && !copyFixture?.handle(request, response) && !repeatFixture?.handle(request, response) && !keyboardFixture?.handle(request, response) && !fixture.handle(request, response)) { request.resume(); response.writeHead(404); response.end("NOT_FOUND"); } });
  const launch = (program, args, options = {}) => { const record = {}; report.commands.push(record); return managedProcess(program, args, { cwd: repo, registry, record, maximumBytes: 2 * 1024 * 1024, ...options }); };
  async function command(args, expected = 0) {
    const child = launch(executable, args, { timeoutMs: args[0] === "managed" && args[1] === "stop" ? 55000 : 45000 });
    const result = await child.completed; assert.equal(result.code, expected, redact(result.stderr)); return result;
  }
  async function processTable() {
    const record = {}; await runProcess("powershell.exe", ["-NoProfile", "-Command", "@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,ExecutablePath,@{n='CreationDate';e={$_.CreationDate.ToUniversalTime().ToString('o')}}) | ConvertTo-Json -Compress"], { record, registry, timeoutMs: 15000 });
    return JSON.parse(record.stdout);
  }
  const checkCapture = () => { if (captureError) throw captureError; };
  const wait = (read, label, timeoutMs = 15000) => poll(async () => { checkCapture(); return read(); }, { timeoutMs, intervalMs: 40, label });
  async function step(label, operation) {
    const record = { name: label, startedAt: Date.now() }; report.steps.push(record); console.log("STEP", label);
    try { await operation(); checkCapture(); record.passed = true; }
    catch (error) { record.passed = false; record.error = error.stack; report.firstFailure ??= { step: label, at: Date.now(), error: error.stack }; throw error; }
    finally { record.endedAt = Date.now(); await save(); }
  }
  async function screenshot(file) { const png = await page.screenshot({ path: path.join(runDir, file) }); const record = { file, at: Date.now(), sha256: hash(png), bytes: png.length }; screenshots.push(record); return record; }
  const endpointFor = (profile, owner) => waitPrivateDevToolsEndpoint(profile, { assertAlive() { if (owner.record.exitedAt !== undefined || owner.record.closedAt !== undefined || owner.record.spawnError !== undefined) throw new Error("Original browser owner ended before endpoint"); } });
  const replyFor = (id, timeoutMs = 35000) => wait(() => report.viewerMessages.find(value => value.type === "response" && value.id === id && value.connection === connection), `original response ${id}`, timeoutMs);
  let connection = 0;
  async function uiAction(selector, operation, tabId) {
    const before = report.viewerCommands.length, action = { selector, operation, tabId, connection, startedAt: Date.now() }; report.viewerActions.push(action);
    if (operation === "select") await page.locator(selector).selectOption(String(tabId)); else await page.locator(selector).click();
    const request = await wait(() => report.viewerCommands.slice(before).find(item => item.operation === operation && (operation !== "select" || item.tabId === tabId)), `original DOM ${operation}`);
    action.requestId = request.id; const reply = await replyFor(request.id, operation === "stop" ? 55000 : 35000); action.completedAt = Date.now();
    assert.equal(report.viewerCommands.slice(before).filter(item => item.operation === operation && (operation !== "select" || item.tabId === tabId)).length, 1);
    assert.equal(reply.error, undefined, serialize(reply.error)); return reply.result;
  }
  async function inputAction(label, operation) {
    const before = report.viewerCommands.length, action = { label, connection, startedAt: Date.now(), kind: "real viewer input" }; report.viewerActions.push(action);
    await operation();
    await wait(() => report.viewerCommands.length > before, `outgoing native input ${label}`);
    // Serialize the fixture's UI gestures. Finite command replies are required;
    // a caller-side timeout must never be relabelled a native acknowledgement.
    await wait(async () => await page.locator("#human-input").getAttribute("data-pending") === "0", `all original UI input settled: ${label}`);
    const commands = report.viewerCommands.slice(before); assert.ok(commands.length); assert.ok(commands.every(item => item.operation === "humanInput"));
    action.requestIds = commands.map(item => item.id);
    for (const request of commands) assertHumanInputReceipt(request, await replyFor(request.id));
    const acknowledged = Number(await page.locator("#human-input").getAttribute("data-acknowledged-sequence"));
    assert.equal(acknowledged, commands.at(-1).sequence, "UI must have accepted the exact last native receipt before this gesture completes");
    action.acknowledgedSequence = acknowledged;
    action.completedAt = Date.now(); return commands;
  }
  async function exerciseIME(anchor) {
    const detail = report.business.ime = { stages: [], nativeCommands: [], boundary: "Native viewer composition simulation, not a Windows OS input method. Candidate text stays local; only each final commit enters the production humanInput channel. Fixed Chromium 156 reports scoped compositionend isTrusted=false; start/update/beforeinput/input are trusted. Original values and CDP ACKs are retained." };
    if (imePresentationMode) Object.assign(detail, { presentationMode: imePresentationMode, presentationAnchor: structuredClone(anchor),
      presentationBoundary: "Original computed layout, native editing value and preedit screenshots only. No OS candidate-window or remote-caret placement claim. Baseline never passes this feature." });
    const session = await viewerContext.newCDPSession(page);
    let expectedDraft = fixture.draft, eventStart = 0;
    const observe = () => page.evaluate(() => __managedIMEObservation.snapshot());
    async function native(method, params) {
      const row = { method, params: structuredClone(params), startedAt: Date.now() }; detail.nativeCommands.push(row);
      try { row.result = await session.send(method, params); row.acknowledgedAt = Date.now(); }
      catch (error) { row.error = String(error); throw error; }
      finally { row.settledAt = Date.now(); }
      return row;
    }
    async function action(phase, text) {
      assert.equal(await page.evaluate(() => document.activeElement?.id), "human-input", "IME must target the original focused viewer textarea");
      const row = { phase, text, startedAt: Date.now(), connection, wireStart: report.viewerCommands.length,
        ...(imePresentationMode === "acceptance" ? { eventStart } : {}),
        before: await documentRead(oldTaskTab.id), viewerBefore: await observe() };
      detail.stages.push(row);
      if (phase === "commit") {
        row.commands = await inputAction("native IME confirm original composition", async () => { row.nativeCommand = await native("Input.insertText", { text }); });
        expectedDraft += text;
      } else {
        row.nativeCommand = await native("Input.imeSetComposition", { text, selectionStart: text.length, selectionEnd: text.length });
      }
      row.viewerAfter = await wait(async () => {
        const observed = await observe(), events = observed.events.slice(row.viewerBefore.events.length);
        return events.some(event => event.type === (phase === "preedit" ? "input" : "compositionend")) && observed;
      }, `original native IME ${phase} event`);
      row.after = await documentRead(oldTaskTab.id); row.wireEnd = report.viewerCommands.length;
      row.commands = report.viewerCommands.slice(row.wireStart, row.wireEnd);
      if (imePresentationMode) {
        row.presentation = await page.evaluate(readManagedIMEPresentation);
        if (phase === "preedit") row.presentationScreenshot = await screenshot(`viewer-ime-preedit-${detail.stages.length}.png`);
        row.presentationProof = assessManagedIMEPresentation({ phase, text, presentation: row.presentation, anchor });
        if (imePresentationMode === "acceptance") assert.equal(row.presentationProof.passed, true, JSON.stringify(row.presentationProof));
      }
      row.proof = assertManagedIMEStage({ ...row, replies: report.viewerMessages, expectedDraft, scope: businessLease });
      row.completedAt = Date.now();
    }
    try {
      for (let confirmation = 0; confirmation < 2; confirmation++) {
        if (imePresentationMode === "acceptance") eventStart = (await observe()).events.length;
        for (const text of humanIMEPreedit) await action("preedit", text);
        await action("commit", humanIMEText);
        if (imePresentationMode === "acceptance" && confirmation === 0) {
          const preedit = await beginIMELifecyclePreedit("same-field-click", "旧候选不能提交", anchor, session);
          const row = detail.lifecycle.sameFieldClick = { preedit, before: preedit.after, viewerBefore: preedit.viewerAfter, wireStart: report.viewerCommands.length };
          row.clickCommands = await inputAction("click original draft while local IME is uncommitted", () => page.mouse.click(anchor.x, anchor.y));
          row.caretCommands = await inputAction("restore original draft end after abandoning local IME", () => page.keyboard.press("End"));
          row.after = await documentRead(oldTaskTab.id); row.viewerAfter = await observe(); row.presentation = await page.evaluate(readManagedIMEPresentation);
          row.commands = report.viewerCommands.slice(row.wireStart);
          row.proof = assertManagedIMEAbandonment({ kind: "same-field-click", ...row, replies: report.viewerMessages, scope: businessLease });
          detail.interveningRequestIds = row.commands.map(command => command.id);
        } else if (imePresentationMode === "acceptance" && confirmation === 1) {
          const first = detail.stages[3];
          detail.lifecycle.sameFieldClick.newCompositionStarted = first.viewerAfter.events.slice(first.viewerBefore.events.length).some(row => row.type === "compositionstart");
          assert.equal(detail.lifecycle.sameFieldClick.newCompositionStarted, true, "A fresh native compositionstart is required after the original frame click");
        }
      }
      if (imePresentationMode === "acceptance") eventStart = (await observe()).events.length;
      for (const text of humanIMEPreedit) await action("preedit", text);
      await action("cancel", "");
      const commits = detail.stages.filter(row => row.phase === "commit").map(row => row.commands[0]);
      assert.equal(commits.length, 2); assert.notEqual(commits[0].id, commits[1].id);
      assert.equal(commits[1].sequence, commits[0].sequence + 1 + (detail.interveningRequestIds?.length ?? 0)); assert.deepEqual(commits[0].input, commits[1].input);
      assert.equal(expectedDraft, fixture.expectedDraft);
      detail.commitRequestIds = commits.map(row => row.id); detail.confirmations = 2; detail.cancellations = 1;
    } finally {
      try { detail.observerFinal = await observe(); if (imePresentationMode !== "acceptance") detail.observerFinal = await page.evaluate(() => __managedIMEObservation.stop()); }
      finally { await session.detach(); detail.observerDetachedAt = Date.now(); }
    }
    assert.equal(detail.observerFinal.active, imePresentationMode === "acceptance"); assert.equal(detail.observerFinal.overflow, false);
    const businessEvents = detail.stages.flatMap(row => row.viewerAfter.events.slice(row.viewerBefore.events.length));
    assert.equal(businessEvents.filter(event => event.type === "compositionstart").length, 3);
    assert.equal(businessEvents.filter(event => event.type === "compositionend").length, 3);
  }
  async function beginIMELifecyclePreedit(label, text, anchor, originalSession) {
    const detail = report.business.ime; detail.lifecycle ??= {};
    const row = { label, phase: "preedit", text, wireStart: report.viewerCommands.length,
      before: await documentRead(oldTaskTab.id), viewerBefore: await page.evaluate(() => __managedIMEObservation.snapshot()) };
    detail.lifecycle[label] = row;
    row.eventStart = row.viewerBefore.events.length;
    const session = originalSession ?? (imeEndSession = await viewerContext.newCDPSession(page));
    row.sessionLifetime = originalSession ? "original exerciseIME session retained through the click and subsequent native compositions" : "original End probe session retained through End and released-document evidence";
    const native = row.nativeCommand = { method: "Input.imeSetComposition", params: { text, selectionStart: text.length, selectionEnd: text.length }, startedAt: Date.now() };
    detail.nativeCommands.push(native);
    try { native.result = await session.send(native.method, native.params); native.acknowledgedAt = Date.now(); }
    catch (error) { native.error = String(error); throw error; }
    finally { native.settledAt = Date.now(); }
    row.viewerAfter = await wait(async () => { const value = await page.evaluate(() => __managedIMEObservation.snapshot()); return value.events.slice(row.eventStart).some(event => event.type === "input") && value; }, `original lifecycle preedit ${label}`);
    row.after = await documentRead(oldTaskTab.id); row.commands = report.viewerCommands.slice(row.wireStart);
    row.presentation = await page.evaluate(readManagedIMEPresentation); row.screenshot = await screenshot(`viewer-ime-${label}-pending.png`);
    row.presentationProof = assessManagedIMEPresentation({ phase: "preedit", text, presentation: row.presentation, anchor });
    assert.equal(row.presentationProof.passed, true, JSON.stringify(row.presentationProof));
    row.proof = assertManagedIMEStage({ ...row, replies: report.viewerMessages, expectedDraft: row.before.draft, scope: businessLease });
    return row;
  }
  async function denied(label, operation, pattern) { const record = { label, at: Date.now() }; report.denied.push(record); try { await operation(); } catch (error) { record.error = error.stack; assert.match(error.message, pattern); record.verified = true; return; } throw new Error(`${label} unexpectedly succeeded`); }
  async function deniedHuman(lease, label) {
    const id = 1000000 + report.denied.length;
    const lastSequence = Math.max(0, ...report.viewerCommands.filter(value => value.operation === "humanInput" && value.leaseId === lease.leaseId).map(value => value.sequence));
    const request = { id, operation: "humanInput", leaseId: lease.leaseId, generation: lease.generation, sequence: lastSequence + 1, input: { type: "text", text: "MUST_NOT_BE_DELIVERED" } };
    await page.evaluate(message => globalThis.__managedHumanTestSocket.send(JSON.stringify(message)), request);
    const response = await replyFor(id);
    assert.ok(response.error, "Retired human capability must reject"); assert.equal(response.error.code, "HUMAN_STALE");
    report.denied.push({ label, at: Date.now(), request: projectHumanCommand(request), response, verified: true });
    // The probe consumes a high request ID on this exact connection. Do not
    // reuse it for the UI's independent counter or alter production numbering.
    // CLI view waits for original cleanup; it is issued once, without polling.
    const probePage = page, probeConnection = connection;
    await probePage.evaluate(() => globalThis.__managedHumanTestSocket.close());
    const fresh = JSON.parse((await command(["managed", "view", "--root", root, "--name", name])).stdout);
    assert.equal(new URL(fresh.viewerURL).origin, report.viewerOrigin);
    await openViewer(fresh.viewerURL); await probePage.close();
    assert.ok(connection > probeConnection);
    assert.equal(state.status.state, "paused"); assert.equal(state.human, null);
    assert.deepEqual(state.humanCleanup, { leaseId: lease.leaseId, cleanupConfirmed: true });
  }
  const documentRead = tabId => worker.evaluate(`chrome.scripting.executeScript({target:{tabId:${tabId}},func:${readManagedHumanDocument.toString()}}).then(results=>{if(results.length!==1)throw new Error('ambiguous root read');return {documentId:results[0].documentId,frameId:results[0].frameId,...results[0].result}})`);
  const keyboardRead = tabId => worker.evaluate(`chrome.scripting.executeScript({target:{tabId:${tabId}},func:${readManagedHumanKeyboardDocument.toString()}}).then(results=>{if(results.length!==1)throw new Error('ambiguous keyboard root read');return {documentId:results[0].documentId,frameId:results[0].frameId,...results[0].result}})`);
  const repeatRead = tabId => worker.evaluate(`chrome.scripting.executeScript({target:{tabId:${tabId}},func:${readManagedKeyRepeatDocument.toString()}}).then(results=>{if(results.length!==1)throw new Error('ambiguous repeat root read');return {documentId:results[0].documentId,frameId:results[0].frameId,...results[0].result}})`);
  const copyRead = tabId => worker.evaluate(`chrome.scripting.executeScript({target:{tabId:${tabId}},func:${readManagedHumanCopyDocument.toString()}}).then(results=>{if(results.length!==1)throw new Error('ambiguous copy root read');return {documentId:results[0].documentId,frameId:results[0].frameId,...results[0].result}})`);
  const multiClickRead = tabId => worker.evaluate(`chrome.scripting.executeScript({target:{tabId:${tabId}},func:${readManagedMultiClickDocument.toString()}}).then(results=>{if(results.length!==1)throw new Error('ambiguous multi-click root read');return {documentId:results[0].documentId,frameId:results[0].frameId,...results[0].result}})`);
  const newPageRead = (tabId, documentId) => worker.evaluate(`chrome.scripting.executeScript({target:${JSON.stringify({ tabId, ...(documentId ? { documentIds: [documentId] } : {}) })},func:${readManagedHumanNewPageDocument.toString()}}).then(results=>{if(results.length!==1)throw new Error('ambiguous original new-page root read');return {documentId:results[0].documentId,frameId:results[0].frameId,...results[0].result}})`);
  const newPageNative = tabId => worker.evaluate(`(async()=>{const tab=await chrome.tabs.get(${tabId}),win=await chrome.windows.get(tab.windowId);return {targets:(await chrome.debugger.getTargets()).filter(t=>t.type==='page'&&t.tabId===tab.id).map(t=>({id:t.id,tabId:t.tabId,type:t.type,attached:t.attached,url:t.url})),frames:await chrome.webNavigation.getAllFrames({tabId:tab.id}),tab:{id:tab.id,url:tab.url,windowId:tab.windowId,groupId:tab.groupId,active:tab.active,pinned:tab.pinned,openerTabId:tab.openerTabId},window:{id:win.id,type:win.type,state:win.state,focused:win.focused}}})()`);
  const newPageClosedNative = row => worker.evaluate(`(async()=>({tabId:${row.sourceProof.childTabId},targetId:${JSON.stringify(row.childNative.targets[0].id)},tabs:(await chrome.tabs.query({})).filter(t=>t.id===${row.sourceProof.childTabId}).map(t=>({id:t.id,url:t.url})),targets:(await chrome.debugger.getTargets()).filter(t=>t.tabId===${row.sourceProof.childTabId}||t.id===${JSON.stringify(row.childNative.targets[0].id)}).map(t=>({id:t.id,tabId:t.tabId,type:t.type,url:t.url}))}))()`);
  const nativeMap = tabId => worker.evaluate(`chrome.debugger.getTargets().then(items=>items.filter(item=>item.type==='page'&&item.tabId===${tabId}).map(item=>({id:item.id,tabId:item.tabId,type:item.type,attached:item.attached,url:item.url})))`);
  const observerSnapshot = () => worker.evaluate("__managedHumanAcceptance.snapshot()");
  const posts = () => fixture.stats().requests.filter(item => item.method === "POST");
  async function decodeHumanFrame(lease) {
    const frame = await wait(() => report.frames.findLast(item => item.controlMode === "human" && item.humanLeaseId === lease.leaseId && item.tabId === lease.tabId), "original human native frame");
    const decoded = await wait(async () => {
      const value = await page.locator("#frame").evaluate(element => ({ hidden: element.hidden, complete: element.complete, width: element.naturalWidth, height: element.naturalHeight, ...element.dataset }));
      const ready = await page.locator("#human-input").getAttribute("data-enabled");
      return ready === "true" && state?.human?.leaseId === lease.leaseId && state.human.generation === frame.generation && state.human.viewport?.width > 0 && state.human.viewport?.height > 0 &&
        !value.hidden && value.complete && value.width > 0 && value.height > 0 && value.controlMode === "human" && value.humanLeaseId === lease.leaseId && Number(value.generation) === frame.generation && Number(value.frameSequence) >= frame.sequence && value;
    }, "viewer decoded original human frame");
    report.viewerDecodedFrames.push({ at: Date.now(), frame: { streamId: frame.streamId, sequence: frame.sequence, humanLeaseId: frame.humanLeaseId, generation: frame.generation }, decoded });
    return frame;
  }
  async function decodeReadonlyParent(value, detail, commandStart, messageStart) {
    const lease = value.selected.view;
    assert.equal(value.selected.human, null); assert.equal(lease?.state, "active"); assert.equal(lease.tabId, detail.tabId);
    const frame = await wait(() => report.frames.find(item => item.connection === connection && item.controlMode === "user-view" && item.viewLeaseId === lease.leaseId && item.tabId === lease.tabId && item.generation === lease.generation), "original parent readonly first native frame");
    const decoded = await wait(async () => {
      const image = await page.locator("#frame").evaluate(element => ({ hidden: element.hidden, complete: element.complete, width: element.naturalWidth, height: element.naturalHeight, ...element.dataset }));
      return !image.hidden && image.complete && image.width > 0 && image.height > 0 && image.controlMode === "user-view" && image.viewLeaseId === lease.leaseId &&
        image.streamId === frame.streamId && Number(image.generation) === frame.generation && Number(image.frameSequence) === frame.sequence && image;
    }, "viewer decoded original parent readonly first frame");
    const observed = value.readonly = { lease: structuredClone(lease), frame: structuredClone(frame), decoded, decodedAt: Date.now() };
    assert.ok(frame.file, "The first readonly PNG must be retained, never metadata-only");
    await Promise.all(frameWrites);
    const saved = await fs.readFile(path.join(runDir, frame.file)); observed.savedSHA256 = hash(saved); observed.savedBytes = saved.length;
    report.viewerDecodedFrames.push({ at: observed.decodedAt, frame: { streamId: frame.streamId, sequence: frame.sequence, viewLeaseId: frame.viewLeaseId, generation: frame.generation }, decoded });
    observed.screenshot = await screenshot("viewer-parent-readonly-before-begin.png");
    observed.document = await newPageRead(detail.tabId, detail.parentNavigated.documentId);
    observed.native = await newPageNative(detail.tabId);
    observed.state = structuredClone(state);
    observed.commandsBeforeBegin = structuredClone(report.viewerCommands.slice(commandStart));
    observed.messagesBeforeBegin = structuredClone(report.viewerMessages.slice(messageStart));
    assert.deepEqual(observed.commandsBeforeBegin, [value.selectRequest], "Readonly pixels must precede every human Begin and input");
    observed.completedAt = Date.now();
  }
  async function viewerPoint(box) {
    const [image, decoded] = await Promise.all([
      page.locator("#frame").boundingBox(),
      page.locator("#frame").evaluate(element => ({ hidden: element.hidden, complete: element.complete, width: element.naturalWidth, height: element.naturalHeight, ...element.dataset }))
    ]);
    assert.ok(!decoded.hidden && decoded.complete && state.human?.viewport);
    assert.equal(decoded.controlMode, "human"); assert.equal(decoded.humanLeaseId, state.human.leaseId); assert.equal(Number(decoded.generation), state.human.generation);
    const proof = visibleHumanViewerPoint(box, state.human.viewport, image, { width: decoded.width, height: decoded.height });
    (report.pointerTargets ??= []).push({ at: Date.now(), connection, leaseId: state.human.leaseId, generation: state.human.generation, streamId: decoded.streamId, frameSequence: Number(decoded.frameSequence), ...proof });
    return proof.viewerPoint;
  }
  async function exerciseClipboardRejection(fixtureURL) {
    assert.equal(report.taskClipboardGuard.verified, true); assert.equal(report.clipboardGuard.verified, true);
    const row = report.humanCopy.localWriteRejection = { instrumented: true, startedAt: Date.now(),
      boundary: "Negative-only WebSocket route delays one unchanged original Ctrl ACK. Native viewer clipboard permission is denied. Production UI and task input implementation remain unchanged; this is not uninstrumented acceptance.",
      expectedLocalText: humanCopyCases.at(-1).text };
    // Keep the same delivered task document. Only its released viewer transport
    // is replaced so the preceding seven cases never run under a route.
    const oldPage = page;
    await oldPage.evaluate(() => __managedHumanTestSocket.close());
    const fresh = JSON.parse((await command(["managed", "view", "--root", root, "--name", name])).stdout);
    assert.equal(new URL(fresh.viewerURL).origin, report.viewerOrigin);
    await openViewer(fresh.viewerURL, true); await oldPage.close();
    row.connection = connection;
    await uiAction("#tabs", "select", copyTab.id);
    row.begin = await uiAction("#human-begin", "humanBegin"); assert.equal(row.begin.status.state, "paused");
    row.frame = await decodeHumanFrame(row.begin.human); row.lease = { ...state.human };
    assert.equal(row.lease.clipboardTransferVersion, 1);
    const position = await viewerPoint((await copyRead(copyTab.id)).boxes.copy);
    row.focusCommands = await inputAction("focus original copy field before local write rejection", () => page.mouse.click(position.x, position.y));
    row.selectionCommands = await inputAction("select original nonempty copy field", () => page.keyboard.press("Control+A"));
    row.before = await copyRead(copyTab.id);
    assert.equal(row.before.activeElement, "copy");
    assert.ok(row.before.state.controls.copy.value.length > 0);
    assert.deepEqual([row.before.state.controls.copy.selectionStart, row.before.state.controls.copy.selectionEnd],
      [0, row.before.state.controls.copy.value.length]);
    const wireStart = report.viewerCommands.length;
    try {
      row.permissionDeniedAt = Date.now(); restoreCopyPermissions = true;
      await viewerContext.grantPermissions([], { origin: report.viewerOrigin });
      row.permissionDenialAcknowledgedAt = Date.now();
      row.permissionState = await page.evaluate(async () => (await navigator.permissions.query({ name: "clipboard-write" })).state);
      assert.equal(row.permissionState, "denied", "The original viewer clipboard permission override must be effective");
      copyRejectionRoute.arm({ leaseId: row.lease.leaseId, generation: row.lease.generation });
      row.controlDownStartedAt = Date.now();
      await page.keyboard.down("Control");
      row.controlDownAcknowledgedAt = Date.now();
      row.heldRoute = await wait(() => { const value = copyRejectionRoute.snapshot(); return value.held && value.response && value; }, "original Ctrl ACK held by explicit route");
      row.heldDocument = await copyRead(copyTab.id);
      assert.deepEqual(row.heldDocument.state.heldKeys, ["ControlLeft"]);
      assert.deepEqual(row.heldDocument.state.controls, row.before.state.controls);
      row.cutDownStartedAt = Date.now(); await page.keyboard.down("x"); row.cutDownAcknowledgedAt = Date.now();
      row.localRejected = await wait(async () => {
        const value = await page.locator("#clipboard-status").evaluate(element => ({ text: element.textContent, ...element.dataset }));
        return value.pending === "false" && value.dataState === "rejected" && value;
      }, "native local clipboard rejection");
      row.endRequest = await wait(() => report.viewerCommands.slice(wireStart).find(value => value.operation === "humanEnd" && value.leaseId === row.lease.leaseId), "automatic original human End");
      const endReply = await replyFor(row.endRequest.id);
      assert.equal(endReply.error, undefined, serialize(endReply.error)); row.end = endReply.result;
      assert.deepEqual(row.end.humanCleanup, { leaseId: row.lease.leaseId, cleanupConfirmed: true });
      assert.equal(row.end.human, null); assert.equal(row.end.viewerCleanupComplete, true);
      row.released = await copyRead(copyTab.id);
      row.deliveredBeforeRelease = report.viewerMessages.some(value => value.connection === connection && value.type === "response" && value.id === row.heldRoute.request.id);
      assert.equal(row.deliveredBeforeRelease, false, "Upstream network arrival cannot stand in for viewer delivery");
      row.releaseAttempt = copyRejectionRoute.release();
      row.lateACK = await replyFor(row.heldRoute.request.id);
      await wait(async () => await page.locator("#human-input").getAttribute("data-pending") === "0", "original late input ACK settled in viewer");
      row.afterLateACK = await copyRead(copyTab.id);
      row.localKeyReleaseStartedAt = Date.now();
      await page.keyboard.up("x"); await page.keyboard.up("Control");
      row.localKeyReleaseAcknowledgedAt = Date.now(); row.afterLocalRelease = await copyRead(copyTab.id);
      await viewerContext.clearPermissions(); restoreCopyPermissions = false; row.permissionsRestored = true;
      row.permissionsRestoredAt = Date.now();
      const localPage = await viewerContext.newPage();
      try {
        await localPage.addInitScript(installManagedCopyReadbackObserver);
        await localPage.goto(fixtureURL + "/human-copy-local", { waitUntil: "domcontentloaded" });
        await localPage.locator("#neutral").focus();
        assert.equal(await localPage.locator("#neutral").inputValue(), "");
        row.localPasteStartedAt = Date.now(); await localPage.keyboard.press("Control+V");
        row.local = await localPage.evaluate(() => __managedCopyReadback.stop()); row.localPasteCompletedAt = Date.now();
      } finally { await localPage.close(); }
      await page.bringToFront();
      row.wireAfterArm = report.viewerCommands.slice(wireStart);
      row.finalRoute = copyRejectionRoute.snapshot();
      row.proof = assertManagedCopyRejectionEvidence(row);
      assert.deepEqual((await copyRead(copyTab.id)).state.events, row.afterLocalRelease.state.events);
      row.completedAt = Date.now(); row.screenshot = await screenshot("viewer-human-local-write-rejected.png");
    } finally {
      // Release only the same buffered bytes, even when a preceding check fails.
      try { row.cleanupReleaseAttempt = copyRejectionRoute.release(); }
      finally {
        row.routeAtCleanup = copyRejectionRoute.snapshot();
        if (restoreCopyPermissions) {
          await viewerContext.clearPermissions(); restoreCopyPermissions = false;
          row.permissionsRestored = true; row.permissionsRestoredAt = Date.now();
        }
      }
    }
  }
  async function openViewer(url, rejectionRoute = false) {
    connection++; const originalConnection = connection; state = undefined;
    // CDP's default context has no managed native viewport: emulating a larger
    // DOM there can leave wheel coordinates outside the original small window.
    // All viewer pages use the same explicitly sized, private test context.
    page = await viewerContext.newPage();
    if (rejectionRoute) {
      assert.equal(clipboardRejection, true); assert.equal(copyRejectionRoute, undefined);
      copyRejectionRoute = await installManagedCopyRejectionRoute(page, url);
      await page.exposeBinding("__managedCopyRejectionMessage", (_source, event) => {
        observeMessage(event.data, { observation: "original-viewer-socket-message", messageTrusted: event.trusted, pageMessageAt: event.at });
      });
    }
    if (paste) await page.addInitScript(installManagedPasteObserver);
    if (ime) await page.addInitScript(installManagedIMEObserver, { lifecycle: imePresentationMode === "acceptance" });
    if (multiClick) await page.addInitScript(installManagedMultiClickObserver);
    const geometrySession = await viewerContext.newCDPSession(page);
    try {
      const nativeWindow = await bound(geometrySession.send("Browser.getWindowForTarget"), 5000, "original viewer native window");
      const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
      (report.viewerWindows ??= []).push({ at: Date.now(), connection: originalConnection, nativeWindow, viewport });
      assert.deepEqual(viewport, { width: 1280, height: 1000 });
      assert.ok(nativeWindow.bounds.width >= viewport.width && nativeWindow.bounds.height >= viewport.height, "Original viewer window must contain its emulated viewport");
    } finally { await geometrySession.detach(); }
    // Normal runs only retain the original socket reference. The opt-in route
    // case additionally observes the actual viewer object's message event:
    // a native CDP frame on the shim's upstream socket is not UI delivery.
    await page.addInitScript(observeDelivery => {
      const Native = WebSocket;
      globalThis.WebSocket = new Proxy(Native, { construct(target, args) {
        const socket = Reflect.construct(target, args);
        Object.defineProperty(globalThis, "__managedHumanTestSocket", { configurable: true, value: socket });
        if (observeDelivery) socket.addEventListener("message", event => {
          void globalThis.__managedCopyRejectionMessage({ data: event.data, trusted: event.isTrusted, at: Date.now() });
        });
        return socket;
      } });
    }, rejectionRoute);
    page.on("pageerror", error => { report.viewerErrors.push({ at: Date.now(), connection: originalConnection, error: error.stack }); captureError ??= error; });
    page.on("websocket", socket => {
      try { assert.equal(new URL(socket.url()).origin.replace("ws:", "http:"), new URL(url).origin); } catch (error) { captureError ??= error; return; }
      socket.on("close", () => report.viewerMessages.push({ type: "socketClosed", at: Date.now(), connection: originalConnection }));
      socket.on("framesent", event => { try { const raw = JSON.parse(String(event.payload)), projected = projectHumanCommand(raw); if (!projected) return; if (report.viewerCommands.length >= 2048) throw new Error("Viewer command capacity"); report.viewerCommands.push({ ...projected, at: Date.now(), connection: originalConnection }); } catch (error) { captureError ??= error; } });
      if (!rejectionRoute) socket.on("framereceived", event => observeMessage(event.payload));
    });
    function observeMessage(raw, metadata = {}) {
        try {
          const message = JSON.parse(String(raw)), at = Date.now();
          if (report.viewerMessages.length >= 4096) throw new Error("Viewer event capacity");
          if (message.type === "frame") {
            assert.equal(message.mimeType, "image/png"); assert.ok(typeof message.data === "string" && message.data.length <= 4 * Math.ceil(4 * 1024 * 1024 / 3));
            const png = Buffer.from(message.data, "base64"); assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]); assert.ok(png.length <= 4 * 1024 * 1024 && png.length > 24);
            const frame = { ...message, data: undefined, at, connection: originalConnection, bytes: png.length, sha256: hash(png), width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
            if (report.frames.length < 96) { frame.file = `native-frame-${String(report.frames.length).padStart(4, "0")}.png`; const write = fs.writeFile(path.join(runDir, frame.file), png); frameWrites.push(write); write.catch(error => { captureError ??= error; }); }
            if (report.frames.length >= 1024) throw new Error("Frame observation capacity"); report.frames.push(frame);
            report.viewerMessages.push({ type: "frame", at, connection: originalConnection, tabId: frame.tabId, streamId: frame.streamId, sequence: frame.sequence, controlMode: frame.controlMode, humanLeaseId: frame.humanLeaseId, generation: frame.generation, sha256: frame.sha256 });
          } else {
            report.viewerMessages.push({ ...message, at, connection: originalConnection, ...metadata,
              ...(rejectionRoute ? { rawSHA256: hash(Buffer.from(raw)), rawBytes: Buffer.byteLength(raw) } : {}) });
            if (originalConnection === connection && (message.type === "state" || message.type === "response" && message.result?.status)) {
              const next = message.type === "state" ? message : message.result;
              if (!state || next.eventSequence >= state.eventSequence && next.status.revision >= state.status.revision) state = next;
            }
          }
        } catch (error) { captureError ??= error; }
    }
    await page.goto(url, { waitUntil: "domcontentloaded" }); await wait(async () => await page.locator("#connection").textContent() === "已连接", "viewer authenticated");
    assert.equal(new URL(page.url()).hash, ""); await uiAction("#refresh", "status");
  }

  try {
    report.source = { executable: hash(await fs.readFile(executable)), browser: hash(await fs.readFile(chromium)), viewerBrowser: hash(await fs.readFile(viewerChromium)), extension: await treeHashes(extension), sdk: await treeHashes(path.join(repo, "packages/open-browser-use-js/dist")) };
    const snapshot = path.join(runDir, "source-snapshot");
    const builder = await fs.readFile(path.join(repo, "scripts/build-chrome-extension.mjs"), "utf8");
    const declaration = builder.match(/const productionFiles\s*=\s*(\[[\s\S]*?\]);/); assert.ok(declaration, "The frozen builder must declare its exact production inputs");
    const productionFiles = JSON.parse(declaration[1]); assert.equal(new Set(productionFiles).size, productionFiles.length); assert.ok(productionFiles.includes("managed-human-control.js"));
    const productionInputs = {};
    for (const name of productionFiles) {
      const bytes = await fs.readFile(path.join(repo, "apps/chrome-extension", name));
      if (name === "manifest.json") report.source.manifestProof = assertManagedExtensionManifest(
        await fs.readFile(path.join(extension, name)), bytes, await fs.readFile(path.join(repo, "cmd/open-browser-use/main.go"), "utf8"));
      else assert.equal(report.source.extension[name], hash(bytes), `Provided extension does not contain the exact current production source: ${name}`);
      productionInputs[name] = hash(bytes);
    }
    report.source.productionExtensionInputs = productionInputs;
    const sourceFiles = await managedHumanSourceFiles("acceptance", launch);
    for (const source of sourceFiles) {
      const relative = path.relative(repo, path.resolve(repo, source)); assert.ok(relative && !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
      const destination = path.join(snapshot, source); await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.copyFile(path.join(repo, source), destination);
    }
    report.source.snapshot = await treeHashes(snapshot);
    if (buildFile) {
      const bytes = await fs.readFile(buildFile), build = JSON.parse(bytes); assert.equal(build.passed, true);
      assert.equal(report.source.executable, build.exeSHA256); assert.deepEqual(report.source.extension, build.extensionFiles);
      report.buildEvidence = { path: buildFile, file: "build-manifest.json", sha256: hash(bytes), kind: build.kind ?? "build-manifest" };
      await fs.writeFile(path.join(runDir, "build-manifest.json"), bytes, { flag: "wx" });
      report.source.builtInputs = build.sourceInputs; report.source.buildSnapshot = path.join(path.dirname(buildFile), "source-snapshot");
      for (const [file, expected] of Object.entries(build.sourceInputs)) {
        assert.equal(report.source.snapshot[file], expected, `Current source differs from build input ${file}`);
        const tested = await fs.readFile(path.join(report.source.buildSnapshot, file)); assert.equal(hash(tested), expected);
        const destination = path.join(runDir, "built-source-snapshot", file); await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.writeFile(destination, tested, { flag: "wx" });
      }
      report.source.provenance = build.kind === "verified-published-runtime-binding"
        ? "Verified published runtime and exact 437 source inputs; original build tests are reused, not rerun here. The separately frozen acceptance harness is new."
        : "Exact build sourceInputs and bytes bind runtime. The separately frozen acceptance harness is not represented as tested by an earlier build.";
    }
    await fs.cp(extension, path.join(runDir, "extension-input"), { recursive: true });
    await fs.cp(path.join(repo, "packages/open-browser-use-js/dist"), path.join(runDir, "sdk-input"), { recursive: true });
    const { connectOpenBrowserUse } = await import(pathToFileURL(path.join(runDir, "sdk-input/index.js")));
    await listenFixture(server); const fixtureURL = `http://127.0.0.1:${server.address().port}`;

    await step("production-run-and-original-worker-observer", async () => {
      launcher = launch(executable, ["managed", "run", "--root", root, "--name", name, "--browser-path", chromium, "--extension-dir", extension, "--startup-timeout", "30s"]);
      const ready = await wait(() => {
        if (launcher.record.closedAt) throw new Error(`Managed launcher exited ${launcher.record.code}: ${redact(launcher.record.stderr)}`);
        const text = launcher.record.stdout.trim(); return text.endsWith("}") ? JSON.parse(text) : null;
      }, "production managed ready", 40000);
      assert.equal(ready.state, "ready"); info = ready.info; report.info = info;
      const relative = path.relative(root, info.runDir); assert.ok(relative && !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
      assert.equal(info.name, name); assert.ok(info.runId && info.browserPID > 0 && info.nativePID > 0);
      report.originalProcesses = descendants(await processTable(), info.browserPID); assert.ok(report.originalProcesses.some(item => item.ProcessId === info.nativePID));
      const status = JSON.parse((await command(["managed", "status", "--root", root, "--name", name])).stdout); assert.deepEqual(status.info, info);
      if (humanCopy) {
        const endpoint = await endpointFor(info.profileDir, launcher); report.taskClipboardGuardConnection = {};
        const guardConnection = await connectNormalCDP(endpoint.url, { record: report.taskClipboardGuardConnection, authorizationRequired: false });
        try { report.taskClipboardGuard = await verifyMemoryClipboard(guardConnection, chromium); }
        finally { await guardConnection.close(); }
        assert.equal(report.taskClipboardGuard.verified, true);
      }
      const startup = browserStartupOptions([`--user-data-dir=${viewerProfile}`, "--headless=new", ...(paste || humanCopy ? ["--enable-automation"] : []), "--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "about:blank"], process.env.OBU_TEST_FIELD_TRIAL_CONFIG);
      report.viewerStartup = startup; viewerProcess = launch(viewerChromium, startup.args);
      viewerBrowser = await playwrightChromium.connectOverCDP((await endpointFor(viewerProfile, viewerProcess)).url);
      if (paste || humanCopy) {
        const session = await viewerBrowser.newBrowserCDPSession();
        try { report.clipboardGuard = await verifyMemoryClipboard({ call: (method, params) => session.send(method, params) }, viewerChromium); }
        finally { await session.detach(); }
      }
      viewerContext = await viewerBrowser.newContext({ viewport: { width: 1280, height: 1000 } });
      report.viewerProcesses = descendants(await processTable(), viewerProcess.record.pid);
      assert.ok(!report.viewerProcesses.some(item => item.ProcessId === info.browserPID));
      if (paste || humanCopy) {
        assert.equal(report.clipboardGuard.verified, true);
        const seedText = humanCopy ? "Original synthetic viewer clipboard seed" : humanPasteText;
        const donor = await viewerContext.newPage(); await donor.addInitScript(installManagedPasteObserver);
        try {
          const donorResponse = await donor.goto(fixtureURL + "/human-clipboard-donor");
          assert.equal(donorResponse.status(), 200);
          assert.equal(await donor.locator("#donor").count(), 1); assert.equal(await donor.locator("#neutral").count(), 1);
          await donor.evaluate(text => { const el = document.getElementById("donor"); el.value = text; el.focus(); el.select(); }, seedText);
          await donor.keyboard.press("Control+C"); await donor.locator("#neutral").focus(); await donor.keyboard.press("Control+V");
          report.clipboardSeed = await donor.evaluate(() => ({ value: document.getElementById("neutral").value, ...__managedPasteObservation.stop() }));
          assert.equal(report.clipboardSeed.value, seedText); assert.equal(report.clipboardSeed.overflow, false); assert.equal(report.clipboardSeed.active, false);
          for (const type of ["copy", "paste", "beforeinput", "input"]) assert.ok(report.clipboardSeed.events.some(event => event.type === type && event.trusted));
          assert.equal(report.clipboardSeed.events.filter(event => event.type === "paste").length, 1);
        } finally { await donor.close(); }
      }
      const fresh = JSON.parse((await command(["managed", "view", "--root", root, "--name", name])).stdout);
      const viewerURL = new URL(fresh.viewerURL); assert.equal(viewerURL.hostname, "127.0.0.1"); assert.equal(viewerURL.origin, new URL(ready.viewerURL).origin);
      report.viewerOrigin = viewerURL.origin; report.viewerTicketSHA256 = hash(viewerURL.hash);
      await openViewer(viewerURL.href); assert.equal(state.status.state, "running"); report.viewerInitial = await screenshot("viewer-initial.png");
      const endpoint = await endpointFor(info.profileDir, launcher);
      const targets = await (await fetch(`http://127.0.0.1:${endpoint.port}/json/list`)).json();
      const workers = targets.filter(value => value.type === "service_worker" && value.url === `chrome-extension://${info.extensionId}/background.js`); assert.equal(workers.length, 1);
      report.observerConnection = {}; worker = await connectNormalCDP(workers[0].webSocketDebuggerUrl, { record: report.observerConnection, handshakeTimeoutMs: 10000, authorizationRequired: false });
      report.observer = await worker.evaluate(`(${installManagedHumanObserver.toString()})(chrome,globalThis)`);
      if (nativeTraceEnabled) report.nativeTrace.installed = await worker.evaluate(`(${installManagedHumanNativeTrace.toString()})(chrome,globalThis)`);
      taskBrowser = await connectOpenBrowserUse({ socketPath: info.socketPath, sessionId: "managed-human-acceptance", turnId: "independent-release-check", timeoutMs: 10000 });
    });

    await step("independent-nonbusiness-explicit-human-release", async () => {
      const tab = await taskBrowser.newTab({ url: fixtureURL + "/human-control", backgroundWindow: true }); await tab.domSnapshot({ timeoutMs: 10000 });
      const originalAuthority = captureTaskAuthority(taskBrowser.client, tab.id);
      report.explicitRelease = { tabId: tab.id, originalAuthority, beforeTargets: await nativeMap(tab.id) }; assert.equal(report.explicitRelease.beforeTargets.length, 1);
      await uiAction("#refresh", "status"); await uiAction("#tabs", "select", tab.id);
      const begun = await uiAction("#human-begin", "humanBegin"); assert.ok(["preparing", "active"].includes(begun.human.state)); assert.equal(begun.status.state, "paused");
      normalLease = begun.human; report.explicitRelease.begin = begun;
      report.explicitRelease.frame = await decodeHumanFrame(normalLease);
      assert.equal(state.human.leaseId, normalLease.leaseId); assert.equal(state.human.tabId, normalLease.tabId); assert.ok(state.human.generation >= normalLease.generation);
      normalLease = { ...state.human };
      const ended = await uiAction("#human-end", "humanEnd");
      assert.equal(ended.human, null); assert.deepEqual(ended.humanCleanup, { leaseId: normalLease.leaseId, cleanupConfirmed: true });
      assert.equal(ended.status.state, "paused"); assert.equal(ended.status.cleanupComplete, true);
      report.explicitRelease.end = ended; report.explicitRelease.afterTargets = await nativeMap(tab.id);
      assert.equal(report.explicitRelease.afterTargets[0].attached, false);
      await deniedHuman(normalLease, "ended human lease cannot send input"); assert.equal(posts().length, 0);
      report.explicitRelease.resume = await uiAction("#control", "resume"); assert.equal(report.explicitRelease.resume.status.state, "running");
      await denied("nonbusiness original request before explicit new turn", () => tab.domSnapshot({ timeoutMs: 1500 }), /OBU_STALE_CONTROL_EPOCH/);
      report.originalTurn = await taskBrowser.client.beginTurn("original-unsaved-form");
      await denied("nonbusiness original authority after explicit new turn", () => requestOriginalSnapshot(taskBrowser.client, originalAuthority), /OBU_STALE_CONTROL_EPOCH/);
    });

    if (newPage) await step(newPageMode === "acceptance" ? "human-created-native-child-switch-return" : "human-created-native-child-diagnostic", async () => {
      const detail = report.newPage = { mode: newPageMode, trigger: newPageTrigger, variant: newPageVariant, parentReadonly, urls: newPageFixture.urls(fixtureURL) };
      const trace = () => worker.evaluate("__createdPageProvenance.snapshot()");
      const run = newPageMode === "acceptance" ? runManagedHumanNewPageAcceptance : runManagedHumanNewPageDiagnostic;
      await run({
        createParent: async url => { const tab = await taskBrowser.newTab({ url, backgroundWindow: true }); await tab.domSnapshot({ timeoutMs: 10000 }); return tab.id; },
        read: newPageRead, native: newPageNative,
        readSource: (tabId, url) => wait(async () => {
          const frames = await worker.evaluate(`chrome.webNavigation.getAllFrames({tabId:${tabId}})`);
          const sources = frames.filter(frame => frame.frameId > 0 && frame.url === url); assert.ok(sources.length <= 1);
          if (!sources.length) return false; const value = await newPageRead(tabId, sources[0].documentId);
          return value.ready && value.state.role === "source-frame" && value;
        }, "original cross-site source frame ready", 10000),
        installObserver: () => worker.evaluate(`(${installCreatedPageObserver.toString()})(chrome,globalThis,{maxSources:1})`),
        register: tabId => worker.evaluate(`__createdPageProvenance.register(${tabId})`), trace,
        select: async tabId => { await uiAction("#refresh", "status"); await uiAction("#tabs", "select", tabId); },
        begin: () => uiAction("#human-begin", "humanBegin"), frame: decodeHumanFrame,
        state: () => structuredClone(state), messages: () => structuredClone(report.viewerMessages), point: viewerPoint,
        position: point => inputAction("position original new-page trigger", () => page.mouse.move(point.x, point.y)),
        click: () => inputAction("one original new-page trigger", async () => { await page.mouse.down({ button: "left", clickCount: 1 }); await page.mouse.up({ button: "left", clickCount: 1 }); }),
        clickClosing: async () => {
          const before = report.viewerCommands.length, action = { label: "original child callback then native close", connection, startedAt: Date.now(), kind: "real viewer input" };
          report.viewerActions.push(action); detail.closeWireStart = before; detail.closeMessageStart = report.viewerMessages.length;
          await page.mouse.down({ button: "left", clickCount: 1 }); await page.mouse.up({ button: "left", clickCount: 1 });
          await wait(() => report.viewerCommands.slice(before).filter(command => command.operation === "humanInput").length === 2, "original closing child down/up requests");
          const inputs = report.viewerCommands.slice(before).filter(command => command.operation === "humanInput");
          action.requestIds = inputs.map(input => input.id); action.replies = [];
          for (const input of inputs) action.replies.push(await replyFor(input.id));
          action.completedAt = Date.now(); return inputs;
        },
        waitCreated: tabId => wait(async () => { const value = await trace(); assert.equal(value.overflow, false); return value.events.some(event => event.details.sourceTabId === tabId) && value; }, "original native human-created child", 10000),
        waitChild: (tabId, url) => wait(async () => { const native = await worker.evaluate(`(async()=>({status:(await chrome.tabs.get(${tabId})).status,frames:await chrome.webNavigation.getAllFrames({tabId:${tabId}})}))()`); const root = native.frames?.find(frame => frame.frameId === 0 && frame.url === url); if (native.status !== "complete" || !root) return false; const value = await newPageRead(tabId, root.documentId); return value?.state?.role === "child" && value; }, "original child document ready", 10000),
        options: () => page.locator("#tabs").evaluate(element => [...element.options].map(option => ({ value: option.value, text: option.textContent }))),
        screenshot, end: () => uiAction("#human-end", "humanEnd"), refresh: () => uiAction("#refresh", "status"),
        lastCommand: operation => structuredClone(report.viewerCommands.findLast(command => command.operation === operation)),
        resume: () => uiAction("#control", "resume"), newTurn: () => taskBrowser.client.beginTurn("original-handoff-after-new-page"),
        switchPage: async (tabId, value, closed) => {
          const readonlyParent = parentReadonly && tabId === detail.tabId;
          Object.assign(value, { tabId, startedAt: Date.now() });
          if (closed) { value.closedCleanup = structuredClone(closed.status.humanCleanup); value.selectionReadyAt = Date.now(); }
          else {
            value.endSelector = readonlyParent ? "#human-end" : "#human-switch";
            value.end = await uiAction(value.endSelector, "humanEnd");
            value.endRequest = structuredClone(report.viewerCommands.findLast(command => command.operation === "humanEnd"));
            value.endCompletedAt = (await replyFor(value.endRequest.id)).at;
          }
          await wait(async () => !(await page.locator("#tabs").isDisabled()), "original End enables page selection");
          value.status = structuredClone(state);
          value.options = await page.locator("#tabs").evaluate(element => [...element.options].map(option => ({ value: option.value, text: option.textContent })));
          const start = report.viewerCommands.length, messageStart = report.viewerMessages.length;
          value.selected = await uiAction("#tabs", "select", tabId);
          value.selectRequest = structuredClone(report.viewerCommands.slice(start).find(command => command.operation === "select"));
          value.selectCompletedAt = (await replyFor(value.selectRequest.id)).at;
          if (readonlyParent) await decodeReadonlyParent(value, detail, start, messageStart);
          if (closed || readonlyParent) { value.beginSelector = "#human-begin"; await uiAction(value.beginSelector, "humanBegin"); }
          value.beginRequest = structuredClone(await wait(() => report.viewerCommands.slice(start).find(command => command.operation === "humanBegin" && command.tabId === tabId), "one Begin for original selection"));
          const reply = await replyFor(value.beginRequest.id); assert.equal(reply.error, undefined, serialize(reply.error)); value.begin = reply.result;
          value.frame = await decodeHumanFrame(value.begin.human); value.lease = structuredClone(state.human);
          assert.deepEqual(report.viewerCommands.slice(start).map(command => command.operation), ["select", "humanBegin"], "One selection and exactly one Begin with no input");
          return value;
        },
        waitCallback: (tabId, documentId) => wait(async () => { const value = await newPageRead(tabId, documentId); return value.state.receipt !== null && value; }, "original trusted child callback receipt", 10000),
        waitClosedCallback: () => wait(() => {
          const hit = newPageFixture.stats().requests.find(hit => hit.method === "POST" && hit.path.endsWith("/callback"));
          return hit?.status === 200 && hit.finished && { receipt: hit.receipt, receivedAt: hit.at, request: hit };
        }, "original closing child callback response finished", 10000),
        closedNative: newPageClosedNative,
        waitClosed: async (row, callbackReceivedAt) => {
          const result = row.childClosed = { callbackReceivedAt };
          result.native = await wait(async () => { const value = await newPageClosedNative(row); return value.tabs.length === 0 && value.targets.length === 0 && value; }, "original child native close", 10000);
          result.message = structuredClone(await wait(() => report.viewerMessages.slice(row.closeMessageStart).find(message => {
            const value = message.type === "state" ? message : message.type === "response" ? message.result : null;
            return value?.human === null && value.view === null && value.humanCleanup?.leaseId === row.childSwitch.lease.leaseId && value.humanCleanup.cleanupConfirmed === true && value.status?.state === "paused" && value.status.cleanupComplete === true && value.viewerCleanupComplete === true;
          }), "production original child cleanup state", 15000));
          result.status = structuredClone(result.message.type === "state" ? result.message : result.message.result);
          await wait(async () => !(await page.locator("#tabs").isDisabled()), "closed child cleanup enables actual page selection", 10000);
          result.observedAt = Date.now(); result.commands = structuredClone(report.viewerCommands.slice(row.closeWireStart));
          result.messages = structuredClone(report.viewerMessages.slice(row.closeMessageStart));
          result.endReplies = [];
          for (const command of result.commands.filter(command => command.operation === "humanEnd")) result.endReplies.push(await replyFor(command.id));
          result.viewerErrors = await page.locator("#error").textContent();
          assert.ok(result.endReplies.every(reply => !reply.error), "Automatic child close must not report a stale or failed original End");
          assert.ok(!result.viewerErrors, "Automatic child close must leave no viewer error");
          return result;
        },
        waitNavigatedParent: (tabId, url) => wait(async () => {
          const native = await newPageNative(tabId), root = native.frames.find(frame => frame.frameId === 0 && frame.url === url);
          if (!root) return false; const value = await newPageRead(tabId, root.documentId); return value.ready && value.state.role === "parent-returned" && { ...value, native };
        }, "original parent callback new document", 10000),
        waitParent: (tabId, documentId) => wait(async () => { const value = await newPageRead(tabId, documentId); return value.state.callbacks.length > 0 && value; }, "original parent callback", 10000),
        claimAndRead: async (tabId, documentId, value) => {
          value.startedAt = Date.now(); value.beforeNative = await newPageNative(tabId); value.before = await newPageRead(tabId, documentId);
          value.receipt = await taskBrowser.client.claimUserTab(tabId); value.claimCompletedAt = Date.now();
          const tab = taskBrowser.tab(tabId); value.readStartedAt = Date.now();
          const text = await tab.playwright.locator("#state").textContent({ timeoutMs: 10000 });
          assert.equal(typeof text, "string"); assert.ok(Buffer.byteLength(text) <= 8192); value.state = JSON.parse(text);
          value.draft = await tab.playwright.locator("#draft").inputValue({ timeoutMs: 10000 });
          assert.ok(Buffer.byteLength(value.draft) <= 8192); value.readCompletedAt = Date.now();
          value.afterNative = await newPageNative(tabId); value.after = await newPageRead(tabId, documentId);
          return value;
        }
      }, detail);
      if (newPageMode === "diagnostic") assert.equal(newPageFixture.stats().callback, null);
      else assert.deepEqual(newPageFixture.stats().callback, detail.callback);
      assert.equal(posts().length, 0);
    });

    if (humanCopy) await step("original-copy-cut-and-local-native-paste", async () => {
      assert.equal(report.taskClipboardGuard.verified, true); assert.equal(report.clipboardGuard.verified, true);
      copyTab = await taskBrowser.newTab({ url: fixtureURL + "/human-copy", backgroundWindow: true });
      await copyTab.domSnapshot({ timeoutMs: 10000 });
      const authority = captureTaskAuthority(taskBrowser.client, copyTab.id);
      const detail = report.humanCopy = { tabId: copyTab.id, original: await copyRead(copyTab.id), authority, cases: [] };
      detail.originalTargets = await nativeMap(copyTab.id); assert.equal(detail.originalTargets.length, 1);
      detail.remoteSeed = { text: "Original synthetic managed clipboard seed", startedAt: Date.now() };
      detail.remoteSeed.result = await taskBrowser.client.writeClipboardText(copyTab.id, detail.remoteSeed.text, { timeoutMs: 10000 });
      detail.remoteSeed.completedAt = Date.now();
      detail.finalize = await taskBrowser.client.finalizeTabs([{ tabId: copyTab.id, status: "deliverable" }]);
      await uiAction("#refresh", "status"); await uiAction("#tabs", "select", copyTab.id);
      for (const definition of humanCopyCases) {
        const row = { definition, startedAt: Date.now(), connection }; detail.cases.push(row);
        row.begin = await uiAction("#human-begin", "humanBegin"); assert.equal(row.begin.status.state, "paused");
        row.frame = await decodeHumanFrame(row.begin.human); row.lease = { ...state.human };
        assert.equal(row.lease.clipboardTransferVersion, 1);
        const document = await copyRead(copyTab.id), position = await viewerPoint(document.boxes[definition.target]);
        row.focusCommands = await inputAction(`focus original clipboard field ${definition.id}`, () => page.mouse.click(position.x, position.y));
        row.selectionCommands = definition.selected
          ? await inputAction(`select original clipboard field ${definition.id}`, () => page.keyboard.press("Control+A")) : [];
        row.before = await copyRead(copyTab.id);
        const selected = row.before.state.controls[definition.target];
        assert.equal(row.before.activeElement, definition.target);
        assert.equal(selected.selectionStart, 0); assert.equal(selected.selectionEnd, definition.selected ? selected.value.length : 0);
        row.commands = await inputAction(`original clipboard shortcut ${definition.id}`, () => page.keyboard.press(definition.operation === "cut" ? "Control+X" : "Control+C"));
        row.after = await copyRead(copyTab.id);
        row.localBeforeEnd = await page.locator("#clipboard-status").evaluate(element => ({ text: element.textContent, ...element.dataset }));
        row.end = await uiAction("#human-end", "humanEnd"); assert.equal(row.end.human, null);
        assert.deepEqual(row.end.humanCleanup, { leaseId: row.lease.leaseId, cleanupConfirmed: true });
        row.localSettled = await wait(async () => {
          const value = await page.locator("#clipboard-status").evaluate(element => ({ text: element.textContent, ...element.dataset }));
          return value.pending === "false" && value;
        }, "actual local clipboard write settlement");
        if (definition.status === "ready") { assert.equal(row.localSettled.dataState, "resolved"); assert.match(row.localSettled.text, /已写入/); }
        else assert.equal(row.localSettled.dataState, "rejected");
        row.released = await copyRead(copyTab.id);
        assert.deepEqual(row.released.state.events, row.after.state.events, "End after original up cannot add task input");
        const inputs = report.viewerCommands.filter(command => command.operation === "humanInput" && command.leaseId === row.lease.leaseId);
        assert.deepEqual(inputs, [...row.focusCommands, ...row.selectionCommands, ...row.commands], "Entire lease contains only original focus, selection and shortcut");
        row.leaseLedger = inputs.map(command => command.id);
        // Local readback gets focus only after the original End. It cannot
        // silently terminate a live human lease or substitute a clipboard API.
        const wireEnd = report.viewerCommands.length, localPage = await viewerContext.newPage();
        try {
          await localPage.addInitScript(installManagedCopyReadbackObserver);
          await localPage.goto(fixtureURL + "/human-copy-local", { waitUntil: "domcontentloaded" });
          await localPage.locator("#neutral").focus();
          assert.equal(await localPage.locator("#neutral").inputValue(), "");
          row.localPasteStartedAt = Date.now(); await localPage.keyboard.press("Control+V");
          row.local = await localPage.evaluate(() => __managedCopyReadback.stop()); row.localPasteCompletedAt = Date.now();
        } finally { await localPage.close(); }
        await page.bringToFront();
        assert.equal(report.viewerCommands.length, wireEnd, "Local readback must not create remote human input");
        assert.deepEqual((await copyRead(copyTab.id)).state.events, row.released.state.events);
        row.proof = assertManagedHumanCopyCase({ ...row, original: detail.original, replies: report.viewerMessages, scope: row.lease });
        row.completedAt = Date.now(); row.screenshot = await screenshot(`viewer-human-${definition.id}.png`);
      }
      if (clipboardRejection) await exerciseClipboardRejection(fixtureURL);
      detail.released = await copyRead(copyTab.id);
      detail.afterTargets = await nativeMap(copyTab.id);
      assert.equal(detail.afterTargets[0].id, detail.originalTargets[0].id); assert.equal(detail.afterTargets[0].attached, false);
      detail.resume = await uiAction("#control", "resume"); assert.equal(detail.resume.status.state, "running");
      detail.newTurn = await taskBrowser.client.beginTurn("original-handoff-after-clipboard");
      await denied("clipboard original authority after explicit new turn", () => requestOriginalSnapshot(taskBrowser.client, authority), /OBU_STALE_CONTROL_EPOCH/);
    });

    if (keyRepeat) await step("native-key-repeat-and-original-held-End", async () => {
      repeatTab = await taskBrowser.newTab({ url: fixtureURL + "/human-key-repeat", backgroundWindow: true });
      await repeatTab.domSnapshot({ timeoutMs: 10000 });
      const authority = captureTaskAuthority(taskBrowser.client, repeatTab.id);
      const detail = report.keyRepeat = { tabId: repeatTab.id, original: await repeatRead(repeatTab.id), authority, cases: [], nativeCommands: [] };
      detail.originalTargets = await nativeMap(repeatTab.id); assert.equal(detail.originalTargets.length, 1);
      await uiAction("#refresh", "status"); await uiAction("#tabs", "select", repeatTab.id);
      detail.begin = await uiAction("#human-begin", "humanBegin"); assert.equal(detail.begin.status.state, "paused");
      detail.firstFrame = await decodeHumanFrame(detail.begin.human); const lease = { ...state.human }; detail.lease = lease;
      assert.equal(lease.keyRepeatVersion, 1);
      await page.evaluate(installManagedKeyRepeatObserver);
      const session = await viewerContext.newCDPSession(page);
      const observe = () => page.evaluate(() => __managedKeyRepeatObservation.snapshot());
      const native = async params => {
        const row = { method: "Input.dispatchKeyEvent", params: structuredClone(params), startedAt: Date.now() }; detail.nativeCommands.push(row);
        try { row.result = await session.send(row.method, params); row.acknowledgedAt = Date.now(); }
        catch (error) { row.error = String(error); throw error; }
        finally { row.settledAt = Date.now(); }
        return row;
      };
      try {
        for (const definition of humanKeyRepeatCases) {
          const row = { definition, startedAt: Date.now() }; detail.cases.push(row);
          const document = await repeatRead(repeatTab.id), position = await viewerPoint(document.boxes[definition.id]);
          row.focusCommands = await inputAction(`focus original repeat field ${definition.id}`, () => page.mouse.click(position.x, position.y));
          row.anchorCommands = await inputAction(`position original repeat caret ${definition.id}`, () => page.keyboard.press(definition.anchor));
          row.before = await repeatRead(repeatTab.id); row.viewerBefore = await observe(); row.nativeCommands = [];
          row.commands = await inputAction(`native repeat gesture ${definition.id}`, async () => {
            for (const params of nativeKeyRepeatGesture(definition)) row.nativeCommands.push(await native(params));
          });
          row.after = await repeatRead(repeatTab.id); row.viewerAfter = await observe();
          row.proof = assertManagedKeyRepeatCase({ ...row, case: definition, replies: report.viewerMessages, scope: lease });
          row.completedAt = Date.now();
        }
        detail.after = await repeatRead(repeatTab.id); assert.deepEqual(detail.after.state.heldKeys, ["Backspace"]);
        detail.screenshot = await screenshot("viewer-native-key-repeat.png");
        detail.end = await uiAction("#human-end", "humanEnd"); assert.equal(detail.end.human, null);
        assert.deepEqual(detail.end.humanCleanup, { leaseId: lease.leaseId, cleanupConfirmed: true });
        assert.equal(detail.end.status.state, "paused"); assert.equal(detail.end.status.cleanupComplete, true);
        detail.released = await repeatRead(repeatTab.id);
        const releasedEvents = detail.released.state.events.slice(detail.after.state.events.length);
        assert.equal(releasedEvents.length, 1); assert.equal(releasedEvents[0].type, "keyup"); assert.equal(releasedEvents[0].code, "Backspace");
        detail.eventLedger = assertManagedKeyRepeatLedger({ original: detail.original, after: detail.released, cases: detail.cases, replies: report.viewerMessages, scope: lease });
        const originalInputs = detail.cases.flatMap(row => [...row.focusCommands, ...row.anchorCommands, ...row.commands]);
        const leaseInputs = report.viewerCommands.filter(row => row.operation === "humanInput" && row.leaseId === lease.leaseId);
        assert.deepEqual(leaseInputs, originalInputs, "Original repeat lease cannot contain a late or invented input");
        detail.endLedger = { leaseId: lease.leaseId, generation: lease.generation, requestIds: leaseInputs.map(row => row.id) };
        // Release the viewer browser's local native key after actual remote End.
        // This is not a task release receipt and must create no new wire input.
        const wireEnd = report.viewerCommands.length;
        detail.localRelease = await native({ type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8, autoRepeat: false });
        detail.viewerAfterLocalRelease = await observe(); assert.equal(report.viewerCommands.length, wireEnd);
        assert.deepEqual((await repeatRead(repeatTab.id)).state.events, detail.released.state.events);
      } finally {
        try { detail.observerFinal = await page.evaluate(() => __managedKeyRepeatObservation.stop()); }
        finally { await session.detach(); detail.observerDetachedAt = Date.now(); }
      }
      assert.equal(detail.observerFinal.active, false); assert.equal(detail.observerFinal.overflow, false);
      detail.afterTargets = await nativeMap(repeatTab.id); assert.equal(detail.afterTargets[0].id, detail.originalTargets[0].id); assert.equal(detail.afterTargets[0].attached, false);
      await deniedHuman(lease, "ended repeat lease cannot send input");
      detail.resume = await uiAction("#control", "resume"); assert.equal(detail.resume.status.state, "running");
      await denied("repeat original request before explicit new turn", () => repeatTab.domSnapshot({ timeoutMs: 1500 }), /OBU_STALE_CONTROL_EPOCH/);
      detail.newTurn = await taskBrowser.client.beginTurn("original-handoff-after-repeat");
      await denied("repeat original authority after explicit new turn", () => requestOriginalSnapshot(taskBrowser.client, authority), /OBU_STALE_CONTROL_EPOCH/);
    });

    if (multiClick) await step("native-double-triple-click-selection", async () => {
      multiClickTab = await taskBrowser.newTab({ url: fixtureURL + "/human-multi-click", backgroundWindow: true });
      await multiClickTab.domSnapshot({ timeoutMs: 10000 });
      const authority = captureTaskAuthority(taskBrowser.client, multiClickTab.id);
      const detail = report.multiClick = { mode: multiClickMode, tabId: multiClickTab.id, authority, original: await multiClickRead(multiClickTab.id), cases: [] };
      detail.originalTargets = await nativeMap(multiClickTab.id); assert.equal(detail.originalTargets.length, 1);
      await uiAction("#refresh", "status"); await uiAction("#tabs", "select", multiClickTab.id);
      detail.begin = await uiAction("#human-begin", "humanBegin"); assert.equal(detail.begin.status.state, "paused");
      detail.firstFrame = await decodeHumanFrame(detail.begin.human); const lease = { ...state.human }; detail.lease = lease;
      if (multiClickMode === "acceptance") assert.equal(lease.pointerClickCountVersion, 1);
      for (const definition of humanMultiClickCases) {
        const row = { definition, startedAt: Date.now(), nativeCommands: [] }; detail.cases.push(row);
        row.measuredDocument = await multiClickRead(multiClickTab.id); row.position = await viewerPoint(row.measuredDocument.points[definition.id]);
        row.positionCommands = await inputAction(`position native pointer for ${definition.id}`, () => page.mouse.move(row.position.x, row.position.y));
        assert.ok(row.positionCommands.every(value => value.input.type === "pointer" && value.input.action === "move"));
        row.before = await multiClickRead(multiClickTab.id);
        assert.equal(row.before.documentId, detail.original.documentId); assert.equal(row.before.state.documentToken, detail.original.state.documentToken);
        row.viewerBefore = await page.evaluate(() => __managedMultiClickObservation.snapshot());
        row.commands = await inputAction(`original ${definition.count}-click gesture`, () => nativeMultiClickGesture(page.mouse, definition.count, row.nativeCommands));
        row.viewerAfter = await page.evaluate(() => __managedMultiClickObservation.snapshot());
        row.after = await multiClickRead(multiClickTab.id);
        row.proof = assertManagedMultiClickCase(row, report.viewerMessages, lease, multiClickMode);
        row.screenshot = await screenshot(`viewer-${definition.id}.png`); row.completedAt = Date.now();
      }
      detail.after = await multiClickRead(multiClickTab.id);
      detail.observerFinal = await page.evaluate(() => __managedMultiClickObservation.stop());
      assert.equal(detail.observerFinal.active, false); assert.equal(detail.observerFinal.overflow, false);
      detail.end = await uiAction("#human-end", "humanEnd"); assert.equal(detail.end.human, null);
      assert.deepEqual(detail.end.humanCleanup, { leaseId: lease.leaseId, cleanupConfirmed: true });
      assert.equal(detail.end.status.state, "paused"); assert.equal(detail.end.status.cleanupComplete, true);
      const inputs = report.viewerCommands.filter(value => value.operation === "humanInput" && value.leaseId === lease.leaseId);
      assert.deepEqual(inputs, detail.cases.flatMap(row => [...row.positionCommands, ...row.commands]));
      detail.endLedger = { requestIds: inputs.map(value => value.id), leaseId: lease.leaseId, generation: lease.generation };
      detail.released = await multiClickRead(multiClickTab.id); assert.equal(detail.released.documentId, detail.original.documentId);
      assert.deepEqual(detail.released.state.events, detail.after.state.events); assert.deepEqual(detail.released.controls, detail.after.controls);
      detail.eventLedger = assertManagedMultiClickLedger(detail);
      detail.afterTargets = await nativeMap(multiClickTab.id); assert.equal(detail.afterTargets.length, 1);
      assert.equal(detail.afterTargets[0].id, detail.originalTargets[0].id); assert.equal(detail.afterTargets[0].attached, false);
      await deniedHuman(lease, "ended multi-click lease cannot send input");
      detail.resume = await uiAction("#control", "resume"); assert.equal(detail.resume.status.state, "running");
      await denied("multi-click original request before explicit new turn", () => multiClickTab.domSnapshot({ timeoutMs: 1500 }), /OBU_STALE_CONTROL_EPOCH/);
      detail.newTurn = await taskBrowser.client.beginTurn("original-handoff-after-multi-click");
      await denied("multi-click original authority after explicit new turn", () => requestOriginalSnapshot(taskBrowser.client, authority), /OBU_STALE_CONTROL_EPOCH/);
    });

    if (keyboard) await step("native-keyboard-editing-and-one-implicit-submit", async () => {
      keyboardTab = await taskBrowser.newTab({ url: fixtureURL + "/human-keyboard-form", backgroundWindow: true });
      await keyboardTab.domSnapshot({ timeoutMs: 10000 });
      const authority = captureTaskAuthority(taskBrowser.client, keyboardTab.id);
      const detail = report.keyboard = { tabId: keyboardTab.id, original: await keyboardRead(keyboardTab.id), authority, cases: [] };
      detail.originalTargets = await nativeMap(keyboardTab.id); assert.equal(detail.originalTargets.length, 1);
      await uiAction("#refresh", "status"); await uiAction("#tabs", "select", keyboardTab.id);
      detail.begin = await uiAction("#human-begin", "humanBegin"); assert.equal(detail.begin.status.state, "paused");
      detail.firstFrame = await decodeHumanFrame(detail.begin.human); const lease = { ...state.human }; detail.lease = lease;
      for (const definition of humanKeyboardCases) {
        const row = { definition, startedAt: Date.now() }; detail.cases.push(row);
        const document = await keyboardRead(keyboardTab.id), position = await viewerPoint(document.boxes[definition.id]);
        row.focusCommands = await inputAction(`focus original keyboard field ${definition.id}`, () => page.mouse.click(position.x, position.y));
        row.endCommands = await inputAction(`position original keyboard caret ${definition.id}`, () => page.keyboard.press("End"));
        row.before = await keyboardRead(keyboardTab.id); row.wireStart = report.viewerCommands.length;
        row.commands = await inputAction(`original keyboard gesture ${definition.key}`, () => page.keyboard.press(definition.key));
        row.after = await keyboardRead(keyboardTab.id);
        row.proof = assertManagedHumanKeyboardCase({ case: definition, before: row.before, after: row.after,
          commands: row.commands, replies: report.viewerMessages, scope: lease });
        row.completedAt = Date.now();
      }
      detail.after = await wait(async () => { const value = await keyboardRead(keyboardTab.id); return value.state.receipt && value; }, "original implicit-submit response");
      detail.receiptProof = assertManagedHumanKeyboardReceipt({ stats: keyboardFixture.stats(), original: detail.original, after: detail.after });
      detail.screenshot = await screenshot("viewer-native-keyboard.png");
      detail.end = await uiAction("#human-end", "humanEnd"); assert.equal(detail.end.human, null);
      assert.deepEqual(detail.end.humanCleanup, { leaseId: lease.leaseId, cleanupConfirmed: true });
      assert.equal(detail.end.status.state, "paused"); assert.equal(detail.end.status.cleanupComplete, true);
      const originalInputs = detail.cases.flatMap(row => [...row.focusCommands, ...row.endCommands, ...row.commands]);
      const leaseInputs = report.viewerCommands.filter(row => row.operation === "humanInput" && row.leaseId === lease.leaseId);
      assert.deepEqual(leaseInputs, originalInputs, "The entire original keyboard lease must contain only the recorded gestures");
      assert.equal(leaseInputs.some(row => row.input.type === "text"), false, "Enter must not be replaced by a text insertion");
      detail.endLedger = { leaseId: lease.leaseId, generation: lease.generation, requestIds: leaseInputs.map(row => row.id) };
      detail.released = await keyboardRead(keyboardTab.id); assert.equal(detail.released.documentId, detail.original.documentId);
      assert.deepEqual(detail.released.state.heldKeys, []); assert.deepEqual(detail.released.state.heldButtons, []);
      assert.deepEqual(detail.released.state.events, detail.after.state.events, "End must not create extra keyboard edits or submits");
      detail.eventLedger = assertManagedHumanKeyboardLedger({ original: detail.original, after: detail.released,
        commands: detail.cases.flatMap(row => row.commands), replies: report.viewerMessages, scope: lease });
      detail.afterTargets = await nativeMap(keyboardTab.id); assert.equal(detail.afterTargets[0].attached, false);
      await deniedHuman(lease, "ended keyboard lease cannot send input");
      detail.resume = await uiAction("#control", "resume"); assert.equal(detail.resume.status.state, "running");
      await denied("keyboard original request before explicit new turn", () => keyboardTab.domSnapshot({ timeoutMs: 1500 }), /OBU_STALE_CONTROL_EPOCH/);
      detail.newTurn = await taskBrowser.client.beginTurn("original-handoff-after-keyboard");
      await denied("keyboard original authority after explicit new turn", () => requestOriginalSnapshot(taskBrowser.client, authority), /OBU_STALE_CONTROL_EPOCH/);
    });

    await step("original-agent-document-and-unsubmitted-draft", async () => {
      oldTaskTab = await taskBrowser.newTab({ url: fixtureURL + "/human-form", backgroundWindow: true });
      await oldTaskTab.getByLabel("Original draft", { exact: true }).fill(fixture.draft, { timeoutMs: 10000 });
      oldTaskAuthority = captureTaskAuthority(taskBrowser.client, oldTaskTab.id);
      original = await documentRead(oldTaskTab.id); assert.equal(original.draft, fixture.draft);
      assert.ok(original.documentId); assert.equal(original.frameId, 0); assert.equal(original.state.submits, 0); assert.deepEqual(original.state.clicks, []);
      const targets = await nativeMap(oldTaskTab.id); assert.equal(targets.length, 1);
      report.business = { tabId: oldTaskTab.id, original, originalAuthority: oldTaskAuthority, originalTarget: targets[0], originalFrames: await worker.evaluate(`chrome.webNavigation.getAllFrames({tabId:${oldTaskTab.id}})`) };
      await uiAction("#refresh", "status"); await uiAction("#tabs", "select", oldTaskTab.id);
      assert.equal(posts().length, 0); report.agentDraft = await screenshot("viewer-agent-draft.png");
    });

    await step(paste ? "same-document-native-local-paste-and-held-key-End" : ime ? "same-document-native-IME-and-held-key-End" : (keyboard || keyRepeat || multiClick) ? "same-document-original-handoff-and-held-key-End" : "same-document-real-human-input-and-held-input-disconnect", async () => {
      const eventStart = (await observerSnapshot()).events.length;
      const begun = await uiAction("#human-begin", "humanBegin"); assert.equal(begun.status.state, "paused"); assert.ok(["preparing", "active"].includes(begun.human.state));
      businessLease = begun.human; report.business.humanBegin = begun;
      report.business.firstHumanFrame = await decodeHumanFrame(businessLease);
      assert.equal(state.human.leaseId, businessLease.leaseId); assert.equal(state.human.tabId, businessLease.tabId); assert.ok(state.human.generation >= businessLease.generation);
      businessLease = { ...state.human }; assert.ok(state.human.viewport);
      const transferred = await documentRead(oldTaskTab.id); assert.equal(transferred.documentId, original.documentId); assert.equal(transferred.state.documentToken, original.state.documentToken); assert.equal(transferred.draft, fixture.draft);
      await denied("task input during human lease", () => oldTaskTab.mouse.move(2, 2, { timeoutMs: 1500 }), /OBU_AUTOMATION_PAUSED/);
      const draftPoint = await viewerPoint(transferred.boxes.draft);
      await inputAction("click original draft through native frame", () => page.mouse.click(draftPoint.x, draftPoint.y));
      await inputAction("move caret to draft end", () => page.keyboard.press("End"));
      if (paste) {
        const before = await documentRead(oldTaskTab.id);
        const commands = await inputAction("one trusted local Control+V from guarded viewer memory clipboard", () => page.keyboard.press("Control+V"));
        await wait(async () => (await documentRead(oldTaskTab.id)).draft === fixture.expectedDraft, "one original multiline paste value");
        const after = await documentRead(oldTaskTab.id), viewer = await page.evaluate(() => __managedPasteObservation.snapshot());
        report.business.localPaste = { before, after, viewer, commands, proof: assertManagedPasteEvidence({ viewer, commands, replies: report.viewerMessages, before, after, expectedDraft: fixture.expectedDraft }) };
      } else if (ime) {
        await exerciseIME(draftPoint);
      } else {
      const shiftedIndex = humanASCII.indexOf("A"); assert.ok(shiftedIndex > 0);
      await inputAction("type synthetic ASCII prefix through viewer", () => page.keyboard.type(humanASCII.slice(0, shiftedIndex)));
      const shiftStart = (await documentRead(oldTaskTab.id)).state.events.length;
      await inputAction("hold real Shift for uppercase text", () => page.keyboard.down("Shift"));
      await inputAction("type uppercase A with real Shift held", () => page.keyboard.press("KeyA"));
      await inputAction("release real Shift after uppercase text", () => page.keyboard.up("Shift"));
      const shiftEvents = (await documentRead(oldTaskTab.id)).state.events.slice(shiftStart);
      const shiftDown = shiftEvents.findIndex(event => event.type === "keydown" && event.code === "ShiftLeft" && event.trusted);
      const uppercase = shiftEvents.findIndex(event => event.type === "input" && event.data === "A" && event.trusted);
      const shiftUp = shiftEvents.findIndex(event => event.type === "keyup" && event.code === "ShiftLeft" && event.trusted);
      assert.ok(shiftDown >= 0 && uppercase > shiftDown && shiftUp > uppercase, "Original renderer must receive Shift down, committed A, then actual Shift release");
      report.business.shiftedText = { events: shiftEvents, originalDocumentId: original.documentId };
      await inputAction("type remaining synthetic ASCII through viewer", () => page.keyboard.type(humanASCII.slice(shiftedIndex + 1)));
      await inputAction("insert synthetic Unicode through viewer", () => page.keyboard.insertText(humanUnicode));
      }
      await wait(async () => (await documentRead(oldTaskTab.id)).draft === fixture.expectedDraft, "original unsaved field extended by human");
      const buttonPoint = await viewerPoint((await documentRead(oldTaskTab.id)).boxes["human-button"]);
      await inputAction("human confirmation pointer click", () => page.mouse.click(buttonPoint.x, buttonPoint.y));
      await wait(async () => (await documentRead(oldTaskTab.id)).state.clicks.length === 1, "one original human confirmation");
      if (explicitEnd) {
        // The multiline fixture makes the confirmation button partly clipped.
        // Put the actual viewer pointer over the current native page's empty
        // left margin before scrolling, instead of retaining that old edge.
        const current = await documentRead(oldTaskTab.id);
        const wheelPoint = await viewerPoint({ x: 0, y: 0, width: current.boxes.draft.x, height: current.viewport.height });
        const hit = await page.evaluate(point => ({ id: document.elementFromPoint(point.x, point.y)?.id, viewport: { width: innerWidth, height: innerHeight } }), wheelPoint);
        assert.equal(hit.id, "frame"); assert.ok(wheelPoint.x >= 0 && wheelPoint.y >= 0 && wheelPoint.x < hit.viewport.width && wheelPoint.y < hit.viewport.height);
        report.business.wheelTarget = { at: Date.now(), wheelPoint, hit };
        await inputAction("move into current visible native frame before scroll", () => page.mouse.move(wheelPoint.x, wheelPoint.y));
      }
      await inputAction("scroll original document", () => page.mouse.wheel(0, 600));
      await wait(async () => (await documentRead(oldTaskTab.id)).state.maximumScrollY > 300, "original document scroll");
      await inputAction("return original document to held-input target", () => page.mouse.wheel(0, -600));
      await wait(async () => (await documentRead(oldTaskTab.id)).viewport.scrollY === 0, "original document returned to top");
      await decodeHumanFrame(businessLease);
      report.business.beforeHeld = await documentRead(oldTaskTab.id); assert.equal(report.business.beforeHeld.documentId, original.documentId); assert.equal(report.business.beforeHeld.draft, fixture.expectedDraft);
      assert.equal(report.business.beforeHeld.state.clicks.length, 1); assert.equal(report.business.beforeHeld.state.clicks[0].trusted, true);
      const holdPoint = await viewerPoint(explicitEnd ? report.business.beforeHeld.boxes.draft : report.business.beforeHeld.boxes.hold);
      await inputAction("focus original held-input target", () => page.mouse.click(holdPoint.x, holdPoint.y));
      await inputAction("hold Shift on original document", () => page.keyboard.down("Shift"));
      if (!explicitEnd) await inputAction("hold left mouse on original document", () => page.mouse.down({ button: "left" }));
      const held = await documentRead(oldTaskTab.id); assert.deepEqual(held.state.heldKeys, ["ShiftLeft"]); assert.deepEqual(held.state.heldButtons, explicitEnd ? [] : [0]);
      report.business.held = held; report.business.heldAt = Date.now();
      businessLease = { ...state.human, lastInputSequence: Math.max(...report.viewerCommands.filter(value => value.operation === "humanInput" && value.leaseId === businessLease.leaseId).map(value => value.sequence)) };
      report.business.lastHumanLease = businessLease; report.business.humanScreenshot = await screenshot("viewer-human-edited.png");
      if (imePresentationMode === "acceptance") {
        const preedit = await beginIMELifecyclePreedit("end-uncommitted", "结束前未确认候选", holdPoint);
        report.business.ime.lifecycle.endUncommitted = { preedit, before: preedit.after, viewerBefore: preedit.viewerAfter, wireStart: report.viewerCommands.length };
      }
      const closeAt = Date.now(), commandCount = report.viewerCommands.length;
      if (explicitEnd) {
        report.business.end = await uiAction("#human-end", "humanEnd");
        assert.equal(report.business.end.human, null); assert.equal(report.business.end.status.state, "paused");
        assert.deepEqual(report.business.end.humanCleanup, { leaseId: businessLease.leaseId, cleanupConfirmed: true });
        assert.equal(await page.locator("#human-input").getAttribute("data-enabled"), "false");
        if (ime) report.business.ime.endLedger = assertManagedIMELedger({ commands: report.viewerCommands, replies: report.viewerMessages,
          scope: businessLease, commitRequestIds: report.business.ime.commitRequestIds, interveningRequestIds: report.business.ime.interveningRequestIds });
        if (imePresentationMode) {
          report.business.ime.endPresentation = await page.evaluate(readManagedIMEPresentation);
          report.business.ime.endPresentationProof = assessManagedIMEPresentation({ phase: "end", presentation: report.business.ime.endPresentation });
          if (imePresentationMode === "acceptance") assert.equal(report.business.ime.endPresentationProof.passed, true, JSON.stringify(report.business.ime.endPresentationProof));
        }
      } else {
      await page.evaluate(() => globalThis.__managedHumanTestSocket.close(1000, "synthetic held-input disconnect"));
      await wait(() => report.viewerMessages.find(value => value.type === "socketClosed" && value.connection === connection && value.at >= closeAt), "original viewer socket actually closed");
      }
      report.business.releasedDocument = await wait(async () => { const value = await documentRead(oldTaskTab.id); return value.state.heldKeys.length === 0 && value.state.heldButtons.length === 0 && value; }, "actual original native key and button release", 35000);
      assert.equal(report.business.releasedDocument.documentId, original.documentId); assert.equal(report.business.releasedDocument.draft, fixture.expectedDraft);
      const releaseEvents = report.business.releasedDocument.state.events.slice(held.state.events.length);
      assert.ok(releaseEvents.some(value => value.type === "keyup" && value.code === "ShiftLeft" && value.trusted));
      if (imePresentationMode === "acceptance") {
        const detail = report.business.ime, row = detail.lifecycle.endUncommitted;
        row.after = report.business.releasedDocument; row.viewerAfter = await page.evaluate(() => __managedIMEObservation.snapshot());
        row.commands = report.viewerCommands.slice(row.wireStart); row.presentation = detail.endPresentation;
        row.proof = assertManagedIMEAbandonment({ kind: "end", ...row, replies: report.viewerMessages, scope: businessLease });
        detail.observerFinal = await page.evaluate(() => __managedIMEObservation.stop());
        assert.equal(detail.observerFinal.active, false); assert.equal(detail.observerFinal.overflow, false);
        await imeEndSession.detach(); imeEndSession = null; row.sessionDetachedAt = Date.now();
      }
      if (explicitEnd) {
        assert.deepEqual(report.viewerCommands.slice(commandCount).map(value => value.operation), ["humanEnd"], "Original End alone must release held input; no task keyup or retry");
        const retiredCount = report.viewerCommands.length;
        await page.keyboard.up("Shift"); await page.keyboard.press("KeyZ");
        assert.equal(report.viewerCommands.length, retiredCount, "Retired UI must not send inputs, including local modifier release");
        report.business.afterRetiredUI = await documentRead(oldTaskTab.id); assert.equal(report.business.afterRetiredUI.draft, fixture.expectedDraft);
        assert.deepEqual(report.business.afterRetiredUI.state.events, report.business.releasedDocument.state.events);
        report.business.ended = { at: closeAt, connection, commandCount, actualReleaseObservedAt: Date.now(), releaseEvents,
          boundary: "The original humanEnd may be triggered by focus leaving the input during the button click. Exactly one real End and its native cleanup are required; click-handler causality is not assumed." };
      } else {
        assert.ok(releaseEvents.some(value => value.type === "mouseup" && value.button === 0 && value.trusted));
        assert.equal(report.viewerCommands.slice(commandCount).filter(value => ["humanInput", "humanEnd", "resume"].includes(value.operation)).length, 0, "Transport disconnect must not be replaced with UI keyup, End, or Resume");
        report.business.disconnected = { at: closeAt, connection, commandCount, actualReleaseObservedAt: Date.now(), releaseEvents };
      }
      const observed = await observerSnapshot(); assert.equal(observed.overflow, false);
      const frameEvents = observed.events.slice(eventStart).filter(value => value.method === "Page.screencastFrame"); assert.ok(frameEvents.length > 0);
      for (const event of frameEvents) {
        assert.equal(event.source.sessionId, undefined);
        if (event.source.targetId !== undefined) assert.equal(event.source.targetId, report.business.originalTarget.id);
        else assert.equal(event.source.tabId, oldTaskTab.id);
      }
      report.business.nativeRouting = { originalTargetId: report.business.originalTarget.id, events: frameEvents,
        sourceKinds: [...new Set(frameEvents.map(value => value.source.targetId === undefined ? "tabId-fallback" : "targetId"))],
        boundary: "Read-only native event identity plus frozen production attach code; no wrapper around native attach/sendCommand and no invented command ACK log." };
      report.business.streaming = assertManagedViewerFrames(report.frames, { tabId: oldTaskTab.id, streamId: report.business.firstHumanFrame.streamId });
      assert.equal(posts().length, 0);
    });

    await step("actual-human-cleanup-explicit-resume-and-one-original-post", async () => {
      if (!explicitEnd) {
      const oldPage = page;
      const fresh = JSON.parse((await command(["managed", "view", "--root", root, "--name", name])).stdout); assert.equal(new URL(fresh.viewerURL).origin, report.viewerOrigin);
      await openViewer(fresh.viewerURL); await oldPage.close();
      }
      assert.equal(state.status.state, "paused"); assert.equal(state.status.cleanupComplete, true); assert.equal(state.human, null);
      assert.deepEqual(state.humanCleanup, { leaseId: businessLease.leaseId, cleanupConfirmed: true });
      report.business[explicitEnd ? "endCleanup" : "disconnectCleanup"] = structuredClone(state);
      const targets = await nativeMap(oldTaskTab.id); assert.equal(targets.length, 1); assert.equal(targets[0].id, report.business.originalTarget.id); assert.equal(targets[0].attached, false);
      await deniedHuman(businessLease, explicitEnd ? "ended human lease cannot send input" : "disconnected human lease cannot send input");
      report.business.resume = await uiAction("#control", "resume"); assert.equal(report.business.resume.status.state, "running"); assert.equal(report.business.resume.human, null);
      await denied("business original request before explicit new turn", () => oldTaskTab.domSnapshot({ timeoutMs: 1500 }), /OBU_STALE_CONTROL_EPOCH/);
      report.business.newTurn = await taskBrowser.client.beginTurn("explicit-after-human-release"); freshTaskTab = taskBrowser.tab(oldTaskTab.id); await freshTaskTab.domSnapshot({ timeoutMs: 10000 });
      await denied("business original authority after explicit new turn", () => requestOriginalSnapshot(taskBrowser.client, oldTaskAuthority), /OBU_STALE_CONTROL_EPOCH/);
      const continued = await documentRead(oldTaskTab.id); assert.equal(continued.documentId, original.documentId); assert.equal(continued.state.documentToken, original.state.documentToken); assert.equal(continued.draft, fixture.expectedDraft); assert.equal(continued.state.submits, 0);
      report.business.beforeSubmit = continued; assert.equal(posts().length, 0);
      await freshTaskTab.getByRole("button", { name: "Commit original handoff receipt", exact: true }).click({ timeoutMs: 10000 });
      const receipt = await wait(async () => { const value = await freshTaskTab.locator("#result").textContent({ timeoutMs: 5000 }); return value && JSON.parse(value); }, "one original POST response");
      const after = await documentRead(oldTaskTab.id); report.business.after = after; report.business.receipt = receipt;
      report.business.receiptProof = assertManagedHumanReceipt(fixture.stats(), original, after, receipt);
      assert.equal(after.documentId, original.documentId); report.business.finalFrames = await worker.evaluate(`chrome.webNavigation.getAllFrames({tabId:${oldTaskTab.id}})`);
      assert.equal(report.business.finalFrames.find(value => value.frameId === 0).documentId, original.documentId);
      await uiAction("#refresh", "status"); await uiAction("#tabs", "select", oldTaskTab.id); report.business.receiptScreenshot = await screenshot("viewer-original-receipt.png");
      if (humanCopy) {
        report.humanCopy.finalDocument = await copyRead(copyTab.id);
        assert.deepEqual(report.humanCopy.finalDocument.state.events, report.humanCopy.released.state.events, "Original copy page cannot receive late task input");
        for (const row of report.humanCopy.cases) {
          const inputs = report.viewerCommands.filter(command => command.operation === "humanInput" && command.leaseId === row.lease.leaseId);
          assert.deepEqual(inputs.map(command => command.id), row.leaseLedger, "No late clipboard lease input after handoff");
        }
        if (report.humanCopy.localWriteRejection) {
          const row = report.humanCopy.localWriteRejection;
          row.finalLeaseInputs = report.viewerCommands.filter(command => command.operation === "humanInput" && command.leaseId === row.lease.leaseId);
          assert.deepEqual(row.finalLeaseInputs.map(command => command.id),
            [...row.focusCommands, ...row.selectionCommands, row.finalRoute.request].map(command => command.id), "No late queued cut after the rest of the workflow");
          assert.deepEqual(copyRejectionRoute.snapshot(), row.finalRoute, "The fault route cannot receive extra old-lease inputs");
        }
      }
      if (keyboard) {
        report.keyboard.finalDocument = await keyboardRead(keyboardTab.id);
        assert.deepEqual(report.keyboard.finalDocument.state.events, report.keyboard.released.state.events, "Released keyboard page must not receive late input");
        report.keyboard.finalReceiptProof = assertManagedHumanKeyboardReceipt({ stats: keyboardFixture.stats(), original: report.keyboard.original, after: report.keyboard.finalDocument });
      }
      if (multiClick) {
        const detail = report.multiClick; detail.finalDocument = await multiClickRead(multiClickTab.id);
        assert.deepEqual(detail.finalDocument.state.events, detail.released.state.events);
        assert.deepEqual(detail.finalDocument.controls, detail.released.controls);
        const negatives = report.denied.filter(row => row.request?.leaseId === detail.lease.leaseId);
        assert.equal(negatives.length, 1); assert.equal(negatives[0].response.error.code, "HUMAN_STALE");
        const entireLease = report.viewerCommands.filter(row => row.operation === "humanInput" && row.leaseId === detail.lease.leaseId);
        assert.deepEqual(entireLease.map(row => row.id), [...detail.endLedger.requestIds, negatives[0].request.id]);
        detail.finalWireLedger = { requestIds: entireLease.map(row => row.id), rejectedProbeId: negatives[0].request.id };
      }
      if (newPage) {
        const detail = report.newPage;
        detail.finalParent = await newPageRead(detail.tabId, detail.parentReturned?.documentId ?? detail.original.documentId);
        detail.finalParentNative = await newPageNative(detail.tabId);
        if (newPageVariant === "child-close") detail.finalChildAbsent = await newPageClosedNative(detail);
        else { detail.finalChild = await newPageRead(detail.sourceProof.childTabId, detail.child.documentId); detail.finalChildNative = await newPageNative(detail.sourceProof.childTabId); }
        if (newPageVariant === "iframe") detail.finalSource = await newPageRead(detail.tabId, detail.sourceOriginal.documentId);
        detail.observerFinal = await worker.evaluate("__createdPageProvenance.stop()");
        detail.finalInputLedger = assertManagedHumanNewPageInputs(detail, report.viewerCommands, report.viewerMessages);
        detail.finalInputIds = detail.finalInputLedger.flatMap(scope => scope.requestIds);
      }
      if (keyRepeat) {
        report.keyRepeat.finalDocument = await repeatRead(repeatTab.id);
        assert.deepEqual(report.keyRepeat.finalDocument.state.events, report.keyRepeat.released.state.events, "Released repeat page cannot receive late input");
        const detail = report.keyRepeat, negatives = report.denied.filter(row => row.request?.leaseId === detail.lease.leaseId);
        assert.equal(negatives.length, 1); assert.equal(negatives[0].verified, true); assert.equal(negatives[0].response.error.code, "HUMAN_STALE");
        const entireLease = report.viewerCommands.filter(row => row.operation === "humanInput" && row.leaseId === detail.lease.leaseId);
        assert.equal(entireLease.filter(row => row.id === negatives[0].request.id).length, 1);
        assert.deepEqual(entireLease.filter(row => row.id !== negatives[0].request.id), detail.cases.flatMap(row => [...row.focusCommands, ...row.anchorCommands, ...row.commands]),
          "Only the recorded original inputs and one explicit retired-lease negative are permitted through the end of the workflow");
        detail.finalWireLedger = { requestIds: entireLease.map(row => row.id), rejectedProbeId: negatives[0].request.id };
      }
      report.observerFinal = await worker.evaluate("__managedHumanAcceptance.stop()"); assert.equal(report.observerFinal.listenerPresent, false); assert.equal(report.observerFinal.overflow, false);
      await stopNativeTrace();
      await worker.close(); worker = null;
    });

    await step("trusted-stop-and-original-process-exit", async () => {
      report.preCloseProcesses = descendants(await processTable(), info.browserPID);
      const stop = await uiAction("#stop", "stop"); assert.equal(stop.stopped, true); stopped = true;
      await wait(async () => await page.locator("#state").textContent() === "会话已停止", "actual Stop UI reply", 55000);
      report.viewerStopped = await screenshot("viewer-stopped.png");
      const terminal = await bound(launcher.completed, 10000, "original supervisor terminal exit"); assert.equal(terminal.code, 0, redact(terminal.stderr));
      const lifecycleBytes = await fs.readFile(path.join(info.runDir, "lifecycle.json"));
      await fs.writeFile(path.join(runDir, "lifecycle-original.json"), lifecycleBytes, { flag: "wx" });
      report.lifecycleEvidence = { file: "lifecycle-original.json", sha256: hash(lifecycleBytes), bytes: lifecycleBytes.length, boundary: "Original raw JSON is authoritative for uint64 FILETIME; parsed numeric fields may round." };
      report.lifecycle = JSON.parse(lifecycleBytes); assertManagedViewerTerminal(report.lifecycle, info);
      report.processesGone = await wait(async () => { const table = await processTable(), originals = [...report.originalProcesses, ...report.preCloseProcesses]; const remaining = originals.filter(before => table.some(after => before.ProcessId === after.ProcessId && before.CreationDate === after.CreationDate)); return !remaining.length && { at: Date.now(), originalIdentities: originals.length, remaining }; }, "original managed tree gone");
      const status = await command(["managed", "status", "--root", root, "--name", name], 1); assert.match(status.stderr, /has no reachable supervisor/);
    });
  } catch (error) {
    report.error = error.stack; report.firstFailure ??= { at: Date.now(), error: error.stack };
    console.error(redact(error.stack ?? error));
    if (newPage && worker && report.newPage) try {
      report.newPage.failureObserver = await worker.evaluate("globalThis.__createdPageProvenance?.snapshot() ?? null");
      report.newPage.classification = report.newPage.proof?.classification ?? (report.newPage.failureObserver?.events?.length ? "native-child-observed-diagnostic-incomplete" : "native-child-unobserved");
    } catch (failure) { report.newPage.failureObserverError = redact(String(failure)); }
    // Observe the same failed document before original cleanup. These bounded
    // reads run only after failure; they cannot change prior input/ACK ordering.
    if (worker && repeatTab) try {
      report.failureRepeatDocument = { at: Date.now(), value: await bound(repeatRead(repeatTab.id), 5000, "failed original repeat document observation") };
    } catch (failure) { report.failureRepeatDocumentError = redact(String(failure)); }
    if (worker && keyboardTab) try {
      report.failureKeyboardDocument = { at: Date.now(), value: await bound(keyboardRead(keyboardTab.id), 5000, "failed original keyboard document observation") };
    } catch (failure) { report.failureKeyboardDocumentError = redact(String(failure)); }
    if (worker && copyTab) try {
      report.failureCopyDocument = { at: Date.now(), value: await bound(copyRead(copyTab.id), 5000, "failed original copy document observation") };
    } catch (failure) { report.failureCopyDocumentError = redact(String(failure)); }
    if (worker && multiClickTab) try {
      report.failureMultiClickDocument = { at: Date.now(), value: await bound(multiClickRead(multiClickTab.id), 5000, "failed original multi-click observation") };
    } catch (failure) { report.failureMultiClickDocumentError = redact(String(failure)); }
    if (worker && oldTaskTab) try {
      report.failureDocument = { at: Date.now(), value: await bound(documentRead(oldTaskTab.id), 5000, "failed original document observation") };
    } catch (failure) { report.failureDocumentError = redact(String(failure)); }
    if (page) try {
      report.failureViewer = { at: Date.now(), value: await bound(page.evaluate(() => ({
        state: document.getElementById("state")?.textContent,
        error: document.getElementById("error")?.textContent,
        input: { ...document.getElementById("human-input")?.dataset },
        activeElement: document.activeElement?.id
      })), 5000, "failed original viewer observation") };
    } catch (failure) { report.failureViewerError = redact(String(failure)); }
  }
  finally {
    if (imeEndSession) try { await imeEndSession.detach(); imeEndSession = null; } catch (error) { report.cleanup.imeSession = error.stack; }
    if (copyRejectionRoute) try { copyRejectionRoute.release(); }
    catch (error) { report.cleanup.copyRejectionRelease = error.stack; }
    if (restoreCopyPermissions && viewerContext) try {
      await viewerContext.clearPermissions(); restoreCopyPermissions = false;
      if (report.humanCopy?.localWriteRejection) report.humanCopy.localWriteRejection.permissionsRestoredInFinalCleanup = true;
    } catch (error) { report.cleanup.copyRejectionPermissions = error.stack; }
    if (worker && newPage) try { report.newPageObserverCleanup = await worker.evaluate("globalThis.__createdPageProvenance?.stop() ?? null"); } catch (error) { report.cleanup.newPageObserverError = error.stack; }
    if (worker && nativeTraceEnabled) try { await stopNativeTrace(); } catch (error) { report.cleanup.nativeTraceError = error.stack; }
    if (worker) try { report.cleanup.observerStop = await worker.evaluate("__managedHumanAcceptance.stop()"); await worker.close(); } catch (error) { report.cleanup.observerError = error.stack; }
    taskBrowser?.close();
    if (launcher && !launcher.record.closedAt) {
      if (!stopped) try { report.cleanup.stop = JSON.parse((await command(["managed", "stop", "--root", root, "--name", name])).stdout); } catch (error) { report.cleanup.stopError = error.stack; }
      try { await bound(launcher.completed, 10000, "original supervisor cleanup terminal exit"); }
      catch (error) { report.cleanup.supervisorError = error.stack; launcher.terminate("acceptance-cleanup"); try { await launcher.completed; } catch (failure) { report.cleanup.forcedSupervisor = failure.stack; } }
    }
    if (viewerBrowser) try { report.viewerPreCloseProcesses = descendants(await processTable(), viewerProcess.record.pid); const session = await viewerBrowser.newBrowserCDPSession(); await session.send("Browser.close"); } catch (error) { report.cleanup.viewerCloseError = error.stack; }
    if (viewerProcess) try { const result = await bound(viewerProcess.completed, 10000, "independent viewer terminal exit"); assert.equal(result.code, 0); report.viewerExit = { code: result.code, exitedAt: result.exitedAt, closedAt: result.closedAt }; }
    catch (error) { report.cleanup.viewerExitError = error.stack; viewerProcess.terminate("acceptance-cleanup"); try { await viewerProcess.completed; } catch (failure) { report.cleanup.forcedViewer = failure.stack; } }
    if (viewerBrowser) try { await viewerBrowser.close(); } catch (error) { report.cleanup.viewerTransportError = error.stack; }
    if (report.viewerProcesses) try {
      report.viewerProcessesGone = await poll(async () => { const table = await processTable(), originals = [...report.viewerProcesses, ...(report.viewerPreCloseProcesses ?? [])]; const remaining = originals.filter(before => table.some(after => before.ProcessId === after.ProcessId && before.CreationDate === after.CreationDate)); return !remaining.length && { at: Date.now(), originalIdentities: originals.length, remaining }; }, { timeoutMs: 15000, intervalMs: 100, label: "independent viewer original process identities gone" });
    } catch (error) { report.cleanup.viewerProcessesError = error.stack; }
    newPageFixture?.close();
    server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve));
    try { await Promise.all(frameWrites); checkCapture(); } catch (error) { report.cleanup.frameWriteError = error.stack; }
    try {
      assert.equal(hash(await fs.readFile(executable)), report.source.executable); assert.equal(hash(await fs.readFile(chromium)), report.source.browser);
      assert.equal(hash(await fs.readFile(viewerChromium)), report.source.viewerBrowser);
      assert.deepEqual(await treeHashes(extension), report.source.extension); assert.deepEqual(await treeHashes(path.join(repo, "packages/open-browser-use-js/dist")), report.source.sdk);
      assert.deepEqual(await treeHashes(path.join(runDir, "source-snapshot")), report.source.snapshot);
      for (const [relative, expected] of Object.entries(report.source.snapshot)) assert.equal(hash(await fs.readFile(path.join(repo, relative))), expected, `Source changed during acceptance: ${relative}`);
      if (report.buildEvidence) {
        assert.equal(hash(await fs.readFile(buildFile)), report.buildEvidence.sha256);
        for (const [relative, expected] of Object.entries(report.source.builtInputs)) {
          assert.equal(hash(await fs.readFile(path.join(runDir, "built-source-snapshot", relative))), expected);
          assert.equal(hash(await fs.readFile(path.join(report.source.buildSnapshot, relative))), expected);
        }
      }
    } catch (error) { report.cleanup.sourceChanged = error.stack; }
    report.fixture = fixture.stats();
    if (newPageFixture) {
      report.newPageFixture = newPageFixture.stats();
      if (report.newPage?.finalParent) try {
        report.newPage.terminalProof = assertManagedHumanNewPageTerminal(report.newPage, report.newPageFixture, report.fixture);
      } catch (error) { report.cleanup.newPageLedger = error.stack; }
    }
    if (multiClickFixture) {
      report.multiClickFixture = multiClickFixture.stats();
      if (report.multiClick?.finalDocument) try {
        report.multiClick.terminalProof = assertManagedMultiClickTerminal(report.multiClickFixture, report.multiClick, report.fixture);
      } catch (error) { report.cleanup.multiClickLedger = error.stack; }
    }
    if (copyFixture) {
      report.copyFixture = copyFixture.stats();
      if (report.humanCopy?.finalDocument) try {
        assert.equal(report.copyFixture.overflow, false);
        assert.equal(report.copyFixture.requests.length, 2 + humanCopyCases.length + Number(clipboardRejection));
        assert.equal(report.copyFixture.requests.filter(row => row.path === "/human-copy").length, 1);
        assert.equal(report.copyFixture.requests.filter(row => row.path === "/human-clipboard-donor").length, 1);
        assert.equal(report.copyFixture.requests.filter(row => row.path === "/human-copy-local").length, humanCopyCases.length + Number(clipboardRejection));
        for (const hit of report.copyFixture.requests) {
          assert.equal(hit.method, "GET"); assert.equal(hit.status, 200); assert.equal(hit.finished, true); assert.equal(hit.aborted, false);
        }
        assert.equal(report.copyFixture.requests.find(row => row.path === "/human-copy").documentToken, report.humanCopy.original.state.documentToken);
        assert.equal(report.fixture.requests.filter(row => row.method === "POST").length, 1);
      } catch (error) { report.cleanup.copyLedger = error.stack; }
    }
    if (repeatFixture) {
      report.keyRepeatFixture = repeatFixture.stats();
      if (report.keyRepeat?.finalDocument) try {
        assert.equal(report.keyRepeatFixture.overflow, false); assert.equal(report.keyRepeatFixture.requests.length, 1);
        const hit = report.keyRepeatFixture.requests[0]; assert.equal(hit.method, "GET"); assert.equal(hit.status, 200);
        assert.equal(hit.finished, true); assert.equal(hit.aborted, false); assert.equal(hit.documentToken, report.keyRepeat.original.state.documentToken);
        assert.equal(report.fixture.requests.filter(row => row.method === "POST").length, 1, "Only the independent original handoff POST is permitted");
        report.keyRepeat.finalEventLedger = assertManagedKeyRepeatLedger({ original: report.keyRepeat.original, after: report.keyRepeat.finalDocument, cases: report.keyRepeat.cases, replies: report.viewerMessages, scope: report.keyRepeat.lease });
      } catch (error) { report.cleanup.repeatLedger = error.stack; }
    }
    if (keyboardFixture) {
      report.keyboardFixture = keyboardFixture.stats();
      if (report.keyboard?.finalDocument) try {
        report.keyboard.terminalReceiptProof = assertManagedHumanKeyboardReceipt({ stats: report.keyboardFixture, original: report.keyboard.original, after: report.keyboard.finalDocument });
      } catch (error) { report.cleanup.keyboardReceipt = error.stack; }
    }
    report.screenshots = screenshots; report.endedAt = Date.now();
    report.frameRetention = { observedFrames: report.frames.length, savedPNGs: report.frames.filter(frame => frame.file).length, maximumSavedPNGs: 96, metadataOnlyFrames: report.frames.filter(frame => !frame.file).length,
      policy: "The first 96 actual native PNG payloads are retained for independent decoding; all received frames retain hash/header metadata. viewerDecodedFrames identifies actual browser decodes, not unperformed decodes of every frame." };
    report.liveRunnerChildren = [...registry].map(value => value.pid);
    report.passed = !report.error && report.steps.length === (keyboard || keyRepeat || humanCopy || multiClick || newPage ? 7 : 6) && report.steps.every(value => value.passed) && !Object.keys(report.cleanup).length && !registry.size && report.viewerExit?.code === 0;
    if (imePresentationMode) Object.assign(report, managedIMEPresentationOutcome(report.passed, report.business?.ime));
    if (multiClick) {
      report.featurePassed = report.passed && multiClickMode === "acceptance";
      report.diagnosticGapConfirmed = report.passed && multiClickMode === "baseline" && report.multiClick.cases.every(row => row.proof.gapConfirmed);
    }
    if (newPage) {
      Object.assign(report, managedNewPageDiagnosticOutcome(report.passed, report.newPage));
    }
    if (nativeTraceEnabled) {
      Object.assign(report, managedHumanNativeTraceOutcome(report.passed, report.nativeTrace.traceComplete));
      if (report.newPage) {
        report.newPage.instrumented = true; report.newPage.diagnosticWorkflowPassed = report.newPage.featurePassed === true; report.newPage.featurePassed = false;
        if (report.newPage.proof) { report.newPage.proof.diagnosticWorkflowPassed = report.newPage.proof.featurePassed === true; report.newPage.proof.featurePassed = false; }
      }
    }
    await save(); console.log("RESULT", JSON.stringify({ runDir, passed: report.passed }));
  }
  return report;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const report = await runManagedHumanCheck(); process.exitCode = report.passed ? 0 : 1;
}
