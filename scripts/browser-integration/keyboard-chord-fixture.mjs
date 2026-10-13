import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chooserScope } from "./chooser-waits-fixture.mjs";
import { checkFillOOPIF } from "./fill-delivery-fixture.mjs";

const route = "/keyboard-chord/", hash = bytes => createHash("sha256").update(bytes).digest("hex");
const errorText = error => error?.stack ?? String(error);
export const keyboardChordCases = Object.freeze([
  ...["root", "oopif"].flatMap(layout => ["keyboard", "locator"].map(api => ({ name: `${layout}-${api}-invalid`, layout, api, effect: "invalid" }))),
  ...["keyboard", "locator"].map(api => ({ name: `root-${api}-plus`, layout: "root", api, effect: "plus" })),
  { name: "root-keyboard-raw-held-invalid", layout: "root", api: "keyboard", effect: "raw-held-invalid" },
  ...["keyboard", "locator"].map(api => ({ name: `root-${api}-partial`, layout: "root", api, effect: "partial" }))
].map(Object.freeze));
export const invalidKeyboardChord = "Control+DefinitelyNotAKey";
const specFor = key => {
  const name = /^chord-[a-f0-9]{32}-([a-z-]+)$/.exec(key ?? "")?.[1];
  const spec = keyboardChordCases.find(value => value.name === name); assert.ok(spec, "Invalid keyboard chord fixture key"); return spec;
};
export function keyboardChordURLs(base, key) {
  const spec = specFor(key), root = new URL(`${route}page`, base); root.searchParams.set("key", key);
  const frame = new URL(root); frame.pathname = `${route}frame`; frame.hostname = "localhost";
  return { root: root.href, target: spec.layout === "root" ? root.href : frame.href };
}

// Passive evidence in the original document; no page script focuses, types,
// changes the input value or synthesizes the events being tested.
export function installKeyboardChordEarlyEvidence(doc, key) {
  const view = doc.defaultView, early = globalThis.keyboardChordEarlyEvidence = {
    key, documentToken: crypto.randomUUID(), timeOrigin: performance.timeOrigin, events: [], overflow: false
  };
  const snapshot = target => ({ readyState: doc.readyState, documentHasFocus: doc.hasFocus(),
    activeElementId: doc.activeElement?.id ?? "", targetId: target?.id ?? "", targetNode: target?.nodeName ?? "",
    targetToken: target?.dataset?.token ?? null });
  const append = value => {
    if (early.events.length >= 64) { early.overflow = true; return; }
    early.events.push({ sequence: early.events.length + 1, at: performance.now(), ...value });
  };
  const record = source => event => append({ kind: "event", source, type: event.type, trusted: event.isTrusted,
    key: event.key ?? null, code: event.code ?? null, ...snapshot(event.target) });
  for (const type of ["keydown", "keyup", "focus", "blur", "focusin", "focusout"])
    doc.addEventListener(type, record("document"), { capture: true, passive: true });
  for (const type of ["focus", "blur"]) view.addEventListener(type, event => {
    if (event.target === view) record("window")(event);
  }, { capture: true, passive: true });
  globalThis.keyboardChordMarkListenersInstalled = () => append({ kind: "listeners-installed", ...snapshot(doc.querySelector("#chord-target")) });
}
export function installKeyboardChordEvidence(doc, spec, key) {
  const node = doc.querySelector("#chord-target"), form = doc.querySelector("#chord-form");
  const early = globalThis.keyboardChordEarlyEvidence;
  const evidence = globalThis.keyboardChordEvidence = { key, caseName: spec.name, documentToken: early.documentToken,
    nodeToken: node?.dataset.token ?? null, events: [], focusEvents: [], early, overflow: false, submits: 0, errors: [], listenersReady: false };
  let order = 0;
  globalThis.keyboardChordOriginalState = () => ({ value: node?.value ?? null,
    originalNodePresent: Boolean(node?.isConnected && doc.querySelector("#chord-target") === node), activeOriginalNode: Boolean(node && doc.activeElement === node),
    documentHasFocus: doc.hasFocus(), visibilityState: doc.visibilityState,
    activeElement: { id: doc.activeElement?.id ?? "", nodeName: doc.activeElement?.nodeName ?? "", originalNode: Boolean(node && doc.activeElement === node) } });
  for (const type of ["keydown", "keyup", "beforeinput", "input", "change", "pointerdown", "pointerup", "click"]) doc.addEventListener(type, event => {
    if (evidence.events.length >= 128) { evidence.overflow = true; return; }
    evidence.events.push({ sequence: evidence.events.length + 1, order: ++order, at: performance.now(), type, trusted: event.isTrusted, originalNode: event.target === node,
      nodeToken: event.target === node ? evidence.nodeToken : null, targetId: event.target?.id ?? "", key: event.key ?? null,
      code: event.code ?? null, ctrl: event.ctrlKey ?? false, shift: event.shiftKey ?? false, alt: event.altKey ?? false, meta: event.metaKey ?? false,
      data: event.data ?? null, inputType: event.inputType ?? null, value: node?.value ?? null });
  }, { capture: true, passive: true });
  const focus = source => event => {
    if (evidence.focusEvents.length >= 32) { evidence.overflow = true; return; }
    evidence.focusEvents.push({ sequence: evidence.focusEvents.length + 1, order: ++order, at: performance.now(), source,
      type: event.type, trusted: event.isTrusted, targetId: event.target?.id ?? "", originalNode: event.target === node,
      relatedTargetId: event.relatedTarget?.id ?? "", state: globalThis.keyboardChordOriginalState() });
  };
  for (const type of ["focus", "blur", "focusin", "focusout"]) doc.addEventListener(type, focus("document"), { capture: true, passive: true });
  for (const type of ["focus", "blur"]) doc.defaultView.addEventListener(type, event => {
    if (event.target === doc.defaultView) focus("window")(event);
  }, { capture: true, passive: true });
  form?.addEventListener("submit", event => {
    event.preventDefault(); evidence.submits++;
    const body = { key, caseName: spec.name, href: location.href, documentToken: evidence.documentToken, nodeToken: evidence.nodeToken,
      value: node.value, trustedSubmit: event.isTrusted, evidence: structuredClone(evidence) };
    fetch(`/keyboard-chord/post?${new URLSearchParams({ key })}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      .then(response => { if (!response.ok) throw Error(`Keyboard receipt HTTP ${response.status}`); return response.json(); })
      .then(receipt => { evidence.receipt = receipt; }).catch(error => evidence.errors.push(String(error)));
  });
  evidence.listenersReady = true;
  // This snapshot is taken by the original bottom script, not by a readiness
  // RPC before End. The head ledger can expose input that preceded this point.
  evidence.listenerInstallation = { at: performance.now(), state: globalThis.keyboardChordOriginalState() };
  globalThis.keyboardChordMarkListenersInstalled();
}
export function readKeyboardChordEvidence() {
  return { href: location.href, evidence: globalThis.keyboardChordEvidence, state: globalThis.keyboardChordOriginalState() };
}
export function keyboardChordHTML(url) {
  const key = url.searchParams.get("key"), spec = specFor(key), urls = keyboardChordURLs(url, key);
  assert.ok([`${route}page`, `${route}frame`].includes(url.pathname));
  return `<!doctype html><meta charset="utf-8"><title>Keyboard chord ${key}</title><script>(${installKeyboardChordEarlyEvidence.toString()})(document,${JSON.stringify(key)});</script>
<style>body{margin:20px;font:16px sans-serif}input{width:430px;padding:12px}button{padding:14px;margin:20px}iframe{width:650px;height:340px;border:3px solid #246}</style><h1>Original keyboard chord fixture</h1>
${spec.layout === "root" || url.pathname === `${route}frame` ? `<form id="chord-form"><label for="chord-target">Original chord note</label><input id="chord-target" data-token="${key}-node" value=""><button id="submit-note">Submit original chord note</button></form>` : `<iframe id="chord-frame" src="${urls.target}"></iframe>`}
<script>(${installKeyboardChordEvidence.toString()})(document,${JSON.stringify(spec)},${JSON.stringify(key)});</script>`;
}
export function createKeyboardChordFixtures() {
  const records = new Map();
  const entry = key => {
    specFor(key); if (!records.has(key)) { assert.ok(records.size < 16); records.set(key, { key, gets: [], posts: [] }); } return records.get(key);
  };
  return { stats: key => structuredClone(entry(key)), allStats: () => structuredClone([...records.values()]),
    handle(request, response, url) {
      if (![`${route}page`, `${route}frame`, `${route}post`].includes(url.pathname)) return false;
      const key = url.searchParams.get("key"); let record;
      try { record = entry(key); } catch { response.writeHead(400); response.end("Invalid keyboard chord fixture key"); return true; }
      if (url.pathname !== `${route}post`) {
        if (request.method !== "GET") { response.writeHead(405); response.end(); return true; }
        if (record.gets.length >= 8) { record.overflow = true; response.writeHead(429); response.end(); return true; }
        const bytes = Buffer.from(keyboardChordHTML(url)); record.gets.push({ path: url.pathname, at: Date.now(), bytes: bytes.length, sha256: hash(bytes) });
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }); response.end(bytes); return true;
      }
      if (request.method !== "POST") { response.writeHead(405); response.end(); return true; }
      if (record.posts.length >= 4) { record.overflow = true; response.writeHead(429); response.end(); return true; }
      const post = { method: "POST", receivedAt: Date.now() }; record.posts.push(post); const chunks = []; let size = 0;
      request.on("data", chunk => { size += chunk.length; if (size <= 65536) chunks.push(chunk); });
      request.once("aborted", () => { post.error = "HTTP request aborted"; }); request.once("error", () => { post.error = "HTTP request failed"; });
      request.once("end", () => {
        const bytes = Buffer.concat(chunks); Object.assign(post, { completedAt: Date.now(), bodyBytes: size, bodyBase64: bytes.toString("base64"), bodySHA256: hash(bytes) });
        try {
          assert.ok(size <= 65536); post.value = JSON.parse(bytes.toString("utf8")); assert.equal(post.value.key, key);
          post.receipt = { key, index: record.posts.length, bodySHA256: post.bodySHA256 };
          response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify(post.receipt));
        } catch { post.error = "Invalid keyboard receipt"; response.writeHead(400); response.end(post.error); }
      }); return true;
    }
  };
}

// Selected partial cases dispatch the original Control down exactly once and
// wait for its real Promise ACK, then reject only the caller's returned Promise.
// This is a controlled transport-facing failure, not a natural browser failure.
export function installKeyboardChordProbe(api, target, options) {
  const { id, tabId, scope, failAfterControlACK = false } = options ?? {};
  if (!id || !Number.isSafeInteger(tabId) || !scope?.session_id || !scope?.turn_id || !Number.isSafeInteger(scope.control_epoch) ||
    typeof failAfterControlACK !== "boolean" || target.__obuKeyboardChordProbe) throw Error("Invalid keyboard chord probe");
  const object = api.debugger, descriptor = Object.getOwnPropertyDescriptor(object, "sendCommand"), original = object.sendCommand;
  const rpcName = "__integrationNativeRPCObserver", rpcDescriptor = Object.getOwnPropertyDescriptor(target, rpcName), previous = target[rpcName];
  if (typeof original !== "function" || previous !== undefined && typeof previous !== "function") throw Error("Unobservable keyboard native/RPC method");
  const records = [], errors = [], requests = new Set(); let sequence = 0, phase = null, pending = 0, overflow = false, restored = false, injected = false;
  const append = row => {
    if (records.length >= 256) { overflow = true; return; }
    const copy = structuredClone(row); if (JSON.stringify(copy).length > 16384) { overflow = true; return; }
    records.push({ sequence: ++sequence, phase, at: Date.now(), ...copy });
  };
  const safely = fn => { try { fn(); } catch { if (errors.length < 8) errors.push("Keyboard probe recording error"); } };
  function wrapper(...args) {
    const [source, method, params] = args;
    if (source?.tabId !== tabId || !method?.startsWith("Input.")) return Reflect.apply(original, this, args);
    const selected = failAfterControlACK && !injected && phase === "partial" && method === "Input.dispatchKeyEvent" &&
      ["keyDown", "rawKeyDown"].includes(params?.type) && params.key === "Control" && params.code === "ControlLeft";
    if (selected) injected = true;
    safely(() => append({ kind: "invoke", source, method, params, selected })); const invocation = sequence, originalPhase = phase;
    let value; try { value = Reflect.apply(original, this, args); }
    catch (error) { safely(() => append({ phase: originalPhase, kind: "settled", invocation, ok: false })); throw error; }
    pending++;
    try {
      const observed = Promise.prototype.then.call(value, result => {
        pending--; safely(() => append({ phase: originalPhase, kind: "settled", invocation, ok: true }));
        if (selected) {
          safely(() => append({ phase: originalPhase, kind: "controlled-rejection", invocation, message: "keyboard fixture rejection after original Control ACK" }));
          throw Error("keyboard fixture rejection after original Control ACK");
        }
        return result;
      }, error => { pending--; safely(() => append({ phase: originalPhase, kind: "settled", invocation, ok: false })); if (selected) throw error; });
      if (selected) return observed;
    } catch { pending--; errors.push("Native keyboard input returned no original Promise"); }
    return value;
  }
  function hook(direction, message) {
    if (previous) Reflect.apply(previous, this, [direction, message]);
    safely(() => {
      const p = message?.params;
      if (direction === "request" && message.method === "browserAction" && p?.tabId === tabId && ["press", "keyboard.press"].includes(p.action) &&
        p.session_id === scope.session_id && p.turn_id === scope.turn_id && p.control_epoch === scope.control_epoch) {
        if (requests.size >= 128) { overflow = true; return; }
        if (requests.has(message.id)) errors.push("Repeated keyboard request ID"); requests.add(message.id); append({ kind: "request", message });
      } else if (direction === "response" && requests.has(message?.id)) append({ kind: "response", message });
    });
  }
  const snapshot = () => structuredClone({ version: 1, id, tabId, scope, failAfterControlACK, records, errors, pending, overflow, restored, injected });
  const controller = { id, snapshot, setPhase(value) {
    if (restored || pending || typeof value !== "string" || !/^[a-z-]+$/.test(value)) throw Error("Invalid keyboard probe phase");
    phase = value; append({ kind: "phase" }); return snapshot();
  }, restore() {
    if (restored) return snapshot();
    if (object.sendCommand !== wrapper || target[rpcName] !== hook || target.__obuKeyboardChordProbe !== controller) throw Error("Original keyboard observer replaced");
    if (descriptor) Object.defineProperty(object, "sendCommand", descriptor); else delete object.sendCommand;
    if (rpcDescriptor) Object.defineProperty(target, rpcName, rpcDescriptor); else delete target[rpcName];
    delete target.__obuKeyboardChordProbe; restored = true; return snapshot();
  } };
  Object.defineProperty(object, "sendCommand", descriptor ? { ...descriptor, value: wrapper } : { value: wrapper, writable: true, configurable: true });
  try { Object.defineProperty(target, rpcName, rpcDescriptor ? { ...rpcDescriptor, value: hook } : { value: hook, configurable: true, writable: true }); target.__obuKeyboardChordProbe = controller; }
  catch (error) { if (descriptor) Object.defineProperty(object, "sendCommand", descriptor); else delete object.sendCommand; throw error; }
  return snapshot();
}

const phasesFor = spec => spec.effect === "plus" ? ["plus", "shift-plus"] : spec.effect === "raw-held-invalid" ? ["raw-hold", "invalid", "raw-release", "recovery"] : [spec.effect, "recovery"];
const keyForPhase = name => ({ setup: "End", invalid: invalidKeyboardChord, partial: "Control+a", recovery: "a", plus: "+", "shift-plus": "Shift++" })[name];
const expectedCalls = name => ({ setup: [["End", "down", 0], ["End", "up", 0]], invalid: [], partial: [["Control", "down", 2], ["Control", "up", 0]], recovery: [["a", "down", 0], ["a", "up", 0]],
  plus: [["+", "down", 0], ["+", "up", 0]], "shift-plus": [["Shift", "down", 8], ["+", "down", 8], ["+", "up", 8], ["Shift", "up", 0]],
  "raw-hold": [["Shift", "down", 8]], "raw-release": [["Shift", "up", 0]] })[name];
export function checkKeyboardChordTrace(item, { setupOnly = false } = {}) {
  const { spec, probe } = item, names = ["setup", ...(setupOnly ? [] : phasesFor(spec))];
  const records = setupOnly ? probe.records.filter(row => row.phase === "setup") : probe.records;
  assert.equal(probe.version, 1); assert.equal(probe.id, item.id); assert.equal(probe.tabId, item.tabId); assert.deepEqual(probe.scope, item.scope);
  assert.equal(probe.restored, true); assert.equal(probe.overflow, false); assert.deepEqual(probe.errors, []);
  assert.equal(probe.failAfterControlACK, spec.effect === "partial");
  if (!setupOnly) { assert.equal(probe.pending, 0); assert.equal(probe.injected, spec.effect === "partial"); }
  assert.ok(records.every((row, index) => row.sequence === index + 1));
  assert.ok(records.every(row => names.includes(row.phase)), "Every observation belongs to an explicit original phase");
  assert.deepEqual(records.filter(row => row.kind === "phase").map(row => row.phase), names);
  const phases = [item.setup, ...(setupOnly ? [] : item.phases)];
  assert.deepEqual(phases.map(value => value.name), names);
  let nativeDispatches = 0;
  for (const phase of phases) {
    const rows = records.filter(row => row.phase === phase.name), marker = rows[0];
    assert.equal(marker.kind, "phase"); assert.equal(rows.filter(row => row.kind === "phase").length, 1);
    assert.ok(rows.every((row, index) => row.sequence === marker.sequence + index), "No late native work crosses into another phase");
    const raw = phase.name.startsWith("raw-"), calls = rows.filter(row => row.kind === "invoke"), requests = rows.filter(row => row.kind === "request"), responses = rows.filter(row => row.kind === "response");
    assert.equal(requests.length, raw ? 0 : 1); assert.equal(responses.length, raw ? 0 : 1);
    let request, response;
    if (!raw) {
      [request] = requests; [response] = responses; const p = request.message.params;
      for (const [key, value] of Object.entries(item.scope)) assert.equal(p[key], value);
      const keyboard = phase.name !== "setup" && spec.api === "keyboard";
      assert.equal(p.tabId, item.tabId); assert.equal(p.action, keyboard ? "keyboard.press" : "press");
      assert.deepEqual(p.args, { key: keyForPhase(phase.name) });
      assert.deepEqual(p.locator ?? [], keyboard ? [] : [...(spec.layout === "root" ? [] : [{ kind: "frame", selector: "#chord-frame" }]), { kind: "label", value: "Original chord note", exact: true }]);
      assert.ok(Number.isSafeInteger(p.timeoutMs) && p.timeoutMs > 0 && p.timeoutMs <= (phase.name === "setup" ? item.setup.timeoutMs : item.timeoutMs));
      assert.equal(response.message.id, request.message.id); assert.ok(response.sequence > request.sequence);
      if (["invalid", "partial"].includes(phase.name)) {
        assert.equal(phase.outcome.ok, false); assert.equal(response.message.error?.message, phase.outcome.errorMessage);
        assert.match(phase.outcome.errorMessage, phase.name === "invalid" ? /OBU_KEYBOARD_PRESS_INVALID:.*Unknown key:.*DefinitelyNotAKey/ : /OBU_KEYBOARD_PRESS_UNCONFIRMED:.*keyboard fixture rejection after original Control ACK/s);
        assert.doesNotMatch(phase.outcome.errorMessage, /timed out|timeout/i); assert.ok(phase.observedThroughMs >= item.timeoutMs + 250);
      } else { assert.equal(phase.outcome.ok, true); assert.equal(response.message.error, undefined); }
    } else assert.equal(phase.outcome.ok, true);
    const expected = expectedCalls(phase.name); assert.equal(calls.length, expected.length, `Exact native commands in ${phase.name}`);
    let previousACK = marker.sequence;
    for (const [index, call] of calls.entries()) {
      const [key, direction, modifiers] = expected[index]; nativeDispatches++;
      assert.equal(call.source.tabId, item.tabId); assert.equal(call.method, "Input.dispatchKeyEvent");
      assert.equal(call.params.key, key); assert.equal(call.params.modifiers ?? 0, modifiers);
      assert.equal(call.params.code, key === "End" ? "End" : key === "Control" ? "ControlLeft" : key === "Shift" ? "ShiftLeft" : key === "a" ? "KeyA" : "Equal");
      if (direction === "down") assert.ok(["keyDown", "rawKeyDown"].includes(call.params.type)); else assert.equal(call.params.type, "keyUp");
      if (key === "a" && direction === "down" || key === "+" && direction === "down") assert.equal(call.params.text, key);
      assert.equal(call.selected, phase.name === "partial" && index === 0);
      const acks = rows.filter(row => row.kind === "settled" && row.invocation === call.sequence); assert.equal(acks.length, 1); assert.equal(acks[0].ok, true);
      assert.ok(call.sequence > previousACK && acks[0].sequence > call.sequence); previousACK = acks[0].sequence;
      if (request) assert.ok(call.sequence > request.sequence && response.sequence > acks[0].sequence);
    }
    const rejections = rows.filter(row => row.kind === "controlled-rejection"); assert.equal(rejections.length, phase.name === "partial" ? 1 : 0);
    if (phase.name === "partial") {
      assert.equal(rejections[0].invocation, calls[0].sequence); assert.ok(rejections[0].sequence > rows.find(row => row.kind === "settled" && row.invocation === calls[0].sequence).sequence);
      assert.ok(calls[1].sequence > rejections[0].sequence); assert.equal(rejections[0].message, "keyboard fixture rejection after original Control ACK");
    }
    assert.equal(rows.length, 1 + (raw ? 0 : 2) + calls.length * 2 + rejections.length, "No duplicate request, ACK or hidden extra input");
  }
  return { phases: names.length, nativeDispatches, controlledRejections: !setupOnly && spec.effect === "partial" ? 1 : 0, invalidDispatches: 0 };
}

function originalDocument(item, values) {
  const matches = values.filter(value => value.result.href === item.targetURL); assert.equal(matches.length, 1); return matches[0];
}
function assertSameDocument(original, current) {
  for (const field of ["documentId", "frameId"]) assert.equal(current[field], original[field]);
  for (const field of ["key", "caseName", "documentToken", "nodeToken"]) assert.equal(current.result.evidence[field], original.result.evidence[field]);
  assert.equal(current.result.state.originalNodePresent, true); assert.equal(current.result.evidence.overflow, false); assert.deepEqual(current.result.evidence.errors, []);
  assert.ok(current.result.evidence.events.every((event, index) => event.sequence === index + 1 && event.trusted === true));
  assert.deepEqual(current.result.evidence.events.slice(0, original.result.evidence.events.length), original.result.evidence.events);
  assert.deepEqual(current.result.evidence.focusEvents.slice(0, original.result.evidence.focusEvents.length), original.result.evidence.focusEvents);
  assert.deepEqual(current.result.evidence.early.events.slice(0, original.result.evidence.early.events.length), original.result.evidence.early.events);
}
function checkSetupDocument(item) {
  const original = originalDocument(item, item.before), evidence = original.result.evidence;
  assert.equal(original.result.evidence.key, item.key); assert.equal(original.result.evidence.caseName, item.spec.name); assert.equal(original.result.evidence.nodeToken, `${item.key}-node`);
  assert.ok(original.result.evidence.documentToken); assert.ok(original.documentId); assert.ok(Number.isSafeInteger(original.frameId));
  assert.equal(original.result.state.value, ""); assert.equal(original.result.state.originalNodePresent, true); assert.equal(original.result.state.activeOriginalNode, true);
  const initialKeys = original.result.evidence.events.filter(event => event.originalNode && ["keydown", "keyup"].includes(event.type));
  assert.deepEqual(initialKeys.map(event => [event.type, event.key]), [["keydown", "End"], ["keyup", "End"]]);
  assert.equal(original.result.evidence.events.length, 2); assert.ok(initialKeys.every(event => !event.ctrl && !event.shift && !event.alt && !event.meta));
  assert.equal(evidence.listenersReady, true); assert.equal(evidence.listenerInstallation.state.originalNodePresent, true);
  assert.equal(evidence.listenerInstallation.state.value, "");
  assert.equal(evidence.early.key, item.key); assert.equal(evidence.early.documentToken, evidence.documentToken); assert.equal(evidence.early.overflow, false);
  const early = evidence.early.events, markers = early.filter(row => row.kind === "listeners-installed"), keys = early.filter(row => ["keydown", "keyup"].includes(row.type));
  assert.ok(early.every((row, index) => row.sequence === index + 1 && Number.isFinite(row.at) && (index === 0 || row.at >= early[index - 1].at)));
  assert.equal(markers.length, 1); assert.deepEqual(keys.map(row => [row.type, row.key]), [["keydown", "End"], ["keyup", "End"]]);
  assert.ok(keys.every(row => row.trusted && row.targetId === "chord-target" && row.targetToken === evidence.nodeToken));
  assert.ok(markers[0].sequence < keys[0].sequence); assert.ok(evidence.listenerInstallation.at <= markers[0].at);
  for (const [index, event] of initialKeys.entries()) assert.ok(keys[index].at <= event.at && markers[0].at <= event.at);
  const ordered = [...evidence.events, ...evidence.focusEvents].sort((left, right) => left.order - right.order);
  assert.ok(ordered.every((row, index) => row.order === index + 1 && Number.isFinite(row.at) && (index === 0 || row.at >= ordered[index - 1].at)));
  assert.ok(evidence.focusEvents.every((row, index) => row.sequence === index + 1 && row.trusted === true));
  return original;
}
export function checkKeyboardChordSetup(item) {
  const trace = checkKeyboardChordTrace(item, { setupOnly: true }), original = checkSetupDocument(item);
  return { ...trace, documentId: original.documentId, documentToken: original.result.evidence.documentToken, nodeToken: original.result.evidence.nodeToken };
}
export function checkKeyboardChordDocuments(item) {
  const original = checkSetupDocument(item), expectedValue = item.spec.effect === "plus" ? "++" : "a";
  assert.deepEqual(item.phases.map(phase => phase.name), phasesFor(item.spec));
  let before = original;
  for (const phase of item.phases) {
    const after = originalDocument(item, phase.after); assertSameDocument(before, after); assertSameDocument(original, after);
    assert.equal(after.result.state.activeOriginalNode, true); assert.equal(after.result.evidence.submits, 0);
    const events = after.result.evidence.events.slice(before.result.evidence.events.length), keys = events.filter(event => ["keydown", "keyup"].includes(event.type));
    const expected = expectedCalls(phase.name);
    assert.deepEqual(keys.map(event => [event.key, event.type]), expected.map(([key, direction]) => [key, direction === "down" ? "keydown" : "keyup"]));
    assert.ok(events.every(event => event.originalNode && event.nodeToken === `${item.key}-node`));
    for (const [index, key] of keys.entries()) {
      assert.equal(key.ctrl, Boolean(expected[index][2] & 2)); assert.equal(key.shift, Boolean(expected[index][2] & 8)); assert.equal(key.alt, false); assert.equal(key.meta, false);
      assert.equal(key.code, key.key === "Control" ? "ControlLeft" : key.key === "Shift" ? "ShiftLeft" : key.key === "a" ? "KeyA" : "Equal");
    }
    const writes = events.filter(event => ["beforeinput", "input"].includes(event.type)), text = ["plus", "shift-plus"].includes(phase.name) ? "+" : phase.name === "recovery" ? "a" : null;
    assert.deepEqual(writes.map(event => [event.type, event.data, event.inputType]), text ? [["beforeinput", text, "insertText"], ["input", text, "insertText"]] : []);
    assert.equal(events.length, keys.length + writes.length, "No pointer, change or unexpected fallback events inside keyboard phase");
    assert.equal(after.result.state.value, before.result.state.value + (text ?? ""));
    if (phase.name === "invalid") assert.deepEqual(after.result, before.result, "Invalid chord must not change the original focused document");
    before = after;
  }
  const final = originalDocument(item, item.after); assertSameDocument(before, final); assertSameDocument(original, final);
  assert.equal(final.result.state.value, expectedValue); assert.equal(final.result.evidence.submits, 1); assert.equal(item.submit.ok, true);
  assert.equal(final.result.evidence.events.filter(event => event.type === "click" && event.targetId === "submit-note").length, 1);
  assert.equal(item.server.overflow, undefined); assert.equal(item.server.posts.length, 1);
  const post = item.server.posts[0], bytes = Buffer.from(post.bodyBase64, "base64");
  assert.equal(post.error, undefined); assert.equal(bytes.length, post.bodyBytes); assert.equal(hash(bytes), post.bodySHA256); assert.deepEqual(JSON.parse(bytes.toString("utf8")), post.value);
  for (const [key, value] of Object.entries({ key: item.key, caseName: item.spec.name, href: item.targetURL, documentToken: original.result.evidence.documentToken,
    nodeToken: original.result.evidence.nodeToken, value: expectedValue, trustedSubmit: true })) assert.equal(post.value[key], value);
  assert.equal(post.value.evidence.submits, 1); assert.equal(post.receipt.index, 1); assert.equal(post.receipt.bodySHA256, post.bodySHA256);
  for (const field of ["key", "caseName", "documentToken", "nodeToken", "overflow"]) assert.equal(post.value.evidence[field], final.result.evidence[field]);
  assert.deepEqual(post.value.evidence.events, final.result.evidence.events); assert.deepEqual(post.value.evidence.errors, []);
  assert.deepEqual(post.value.evidence.focusEvents, final.result.evidence.focusEvents); assert.deepEqual(post.value.evidence.early, final.result.evidence.early);
  return { posts: 1, value: expectedValue, bytes: bytes.length, sha256: post.bodySHA256 };
}

async function bounded(operation, label, timeoutMs = 7000) {
  let timer; try { return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`Keyboard chord fixture ${label} timed out`)), timeoutMs); })]); }
  finally { clearTimeout(timer); }
}
export async function checkKeyboardChords({ browser, worker, fixtureURL, server, until, detail = {} }) {
  Object.assign(detail, { passed: false, cases: [], cleanupErrors: [], boundary: "Invalid keys send zero native input. Partial cases reject after one original Control down real ACK; not a natural native failure. Raw-CDP held Shift tests native ledger preservation, not Playwright internal held state. Explicit recovery is a separate user API call on the same document. No new focus allowance. The probe is installed on the blank tab before navigation; passive head recording changes instrumentation timing. There is no new pre-End readiness read or wait. A passing diagnostic run does not repair or reinterpret the original missing-End-down failure." });
  const tabs = []; let primary;
  const native = tabId => bounded(worker.evaluate(`(async()=>{const tab=await chrome.tabs.get(${tabId}),frames=await chrome.webNavigation.getAllFrames({tabId:${tabId}}),oopifs=(globalThis.__integrationFrames??[]).filter(v=>v.tabId===${tabId}),ids=new Set(oopifs.map(v=>v.targetId)),targets=(await chrome.debugger.getTargets()).filter(v=>v.tabId===${tabId}||ids.has(v.id));return{tab,frames,oopifs,targets}})()`), "native identities");
  const read = (tabId, documents) => bounded(worker.evaluate(`chrome.scripting.executeScript({target:{tabId:${tabId},documentIds:${JSON.stringify(documents.map(frame => frame.documentId))}},world:'MAIN',func:${readKeyboardChordEvidence.toString()}})`), "original documents");
  try {
    for (const spec of keyboardChordCases) {
      const id = randomUUID(), key = `chord-${id.replaceAll("-", "")}-${spec.name}`, urls = keyboardChordURLs(fixtureURL, key);
      const item = { id, key, spec, url: urls.root, targetURL: urls.target, timeoutMs: 2000, passed: false, phases: [] }; detail.cases.push(item);
      const tab = await browser.newTab(); tabs.push(tab); item.tabId = tab.id;
      const frame = spec.layout === "root" ? tab : tab.frameLocator("#chord-frame"), locator = frame.getByLabel("Original chord note", { exact: true });
      item.scope = chooserScope(browser); item.setup = { name: "setup", timeoutMs: 5000 }; let installed = false, failure, setupFailure, documents;
      try {
        installed = true;
        item.installation = await bounded(worker.evaluate(`(()=>{(${installKeyboardChordProbe.toString()})(chrome,globalThis,${JSON.stringify({ id, tabId: tab.id, scope: item.scope, failAfterControlACK: spec.effect === "partial" })});return globalThis.__obuKeyboardChordProbe.setPhase('setup')})()`), "probe install before navigation");
        await browser.cdp.navigate(tab.id, urls.root); assert.equal(await tab.locator("h1").textContent({ timeoutMs: 5000 }), "Original keyboard chord fixture");
        assert.equal(await frame.locator("#submit-note").textContent({ timeoutMs: 5000 }), "Submit original chord note");
        // Exactly the original public End action and budget. No observation
        // roundtrip or readiness guard is inserted immediately before it.
        item.setup.startedAt = Date.now();
        item.setup.outcome = await locator.press("End", { timeoutMs: 5000 }).then(() => ({ ok: true, settledAt: Date.now() }), error => {
          failure = error; return { ok: false, errorMessage: String(error?.message ?? error), error: errorText(error), settledAt: Date.now() };
        });
        if (failure) throw failure;
        item.nativeBefore = await native(tab.id);
        documents = item.nativeBefore.frames.filter(value => value.url === urls.root || value.url === urls.target);
        assert.equal(documents.length, spec.layout === "root" ? 1 : 2);
        assert.ok(documents.every(value => value.documentId && value.documentLifecycle === "active" && value.errorOccurred === false));
        if (spec.layout === "oopif") item.rendererBefore = checkFillOOPIF(item.nativeBefore, { tabId: tab.id, rootURL: urls.root, targetURL: urls.target, expectedAttached: true });
        item.before = await read(tab.id, documents);
        item.setup.listenerInstallation = originalDocument(item, item.before).result.evidence.listenerInstallation;
        for (const name of phasesFor(spec)) {
          const phase = { name, startedAt: Date.now() }; item.phases.push(phase);
          await bounded(worker.evaluate(`globalThis.__obuKeyboardChordProbe.setPhase(${JSON.stringify(name)})`), "phase start");
          const start = performance.now();
          const action = name.startsWith("raw-") ? () => browser.cdp.call(tab.id, "Input.dispatchKeyEvent", { type: name === "raw-hold" ? "keyDown" : "keyUp", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, modifiers: name === "raw-hold" ? 8 : 0 }) :
            () => (spec.api === "keyboard" ? tab.keyboard : locator).press(keyForPhase(name), { timeoutMs: item.timeoutMs });
          phase.outcome = await action().then(() => ({ ok: true, settledAt: Date.now() }), error => ({ ok: false, errorMessage: String(error?.message ?? error), error: errorText(error), settledAt: Date.now() }));
          if (["invalid", "partial"].includes(name)) {
            assert.equal(phase.outcome.ok, false); assert.match(phase.outcome.errorMessage, name === "invalid" ? /OBU_KEYBOARD_PRESS_INVALID/ : /OBU_KEYBOARD_PRESS_UNCONFIRMED/);
            const deadline = start + item.timeoutMs + 250;
            while (performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, Math.max(1, deadline - performance.now())));
            phase.observedThroughMs = performance.now() - start;
          } else assert.equal(phase.outcome.ok, true, phase.outcome.errorMessage);
          phase.native = await native(tab.id); phase.after = await read(tab.id, documents); assert.equal(server.stats(key).posts.length, 0);
          const rootTarget = phase.native.targets.filter(value => value.tabId === tab.id && value.type === "page"); assert.equal(rootTarget.length, 1);
          assert.equal(rootTarget[0].id, item.nativeBefore.targets.find(value => value.tabId === tab.id && value.type === "page").id);
          assert.equal(rootTarget[0].attached, name !== "partial", "Partial failure releases original attachment before explicit recovery; invalid keeps it");
          if (spec.layout === "oopif") {
            assert.deepEqual(checkFillOOPIF(phase.native, { tabId: tab.id, rootURL: urls.root, targetURL: urls.target, expectedAttached: true }), item.rendererBefore);
            assert.deepEqual(phase.native.oopifs, item.nativeBefore.oopifs);
          }
        }
      } catch (error) { failure = error; item.error = errorText(error); }
      finally {
        if (installed) try { item.probe = await bounded(worker.evaluate(`(()=>{const p=globalThis.__obuKeyboardChordProbe;if(!p||p.id!==${JSON.stringify(id)})throw Error('Original keyboard probe missing');return p.restore()})()`), "probe restore"); }
        catch (error) { item.restoreError = errorText(error); detail.cleanupErrors.push({ stage: "probe-restore", error: item.restoreError }); failure ??= error; }
      }
      if (item.probe) try { item.setup.nativeProof = checkKeyboardChordTrace(item, { setupOnly: true }); }
      catch (error) { item.setup.nativeProofError = errorText(error); setupFailure ??= error; }
      if (item.before) try { item.setup.proof = checkKeyboardChordSetup(item); }
      catch (error) { item.setup.proofError = errorText(error); setupFailure ??= error; }
      if (!failure) try {
        item.traceProof = checkKeyboardChordTrace(item);
        await frame.getByRole("button", { name: "Submit original chord note", exact: true }).click({ timeoutMs: 5000 }); item.submit = { ok: true };
        await until(() => server.stats(key).posts[0]?.receipt, "one original keyboard chord POST", 5000);
      } catch (error) { failure = error; item.submit ??= { ok: false, error: errorText(error) }; }
      try {
        item.nativeAfter = await native(tab.id);
        documents ??= item.nativeAfter.frames.filter(value => value.url === urls.root || value.url === urls.target);
        item.after = await read(tab.id, documents); item.server = server.stats(key); assert.deepEqual(chooserScope(browser), item.scope);
        if (!item.before) item.setup.afterFailure = item.after;
        if (!item.nativeBefore) throw failure ?? Error("Original keyboard setup did not finish");
        for (const field of ["id", "windowId", "groupId", "pinned"]) assert.equal(item.nativeAfter.tab[field], item.nativeBefore.tab[field]);
        assert.equal(item.nativeAfter.tab.active, false); assert.equal(item.nativeAfter.tab.url, urls.root);
        for (const value of [item.before, ...item.phases.map(phase => phase.after).filter(Boolean), item.after]) {
          assert.equal(value.length, documents.length);
          for (const doc of documents) assert.equal(value.filter(row => row.documentId === doc.documentId && row.frameId === doc.frameId && row.result.href === doc.url).length, 1);
        }
        if (!failure) item.documentProof = checkKeyboardChordDocuments(item);
      } catch (error) { item.evidenceError = errorText(error); failure ??= error; }
      // Preserve the original submit/receipt path for a missing setup DOM
      // event. Diagnostic setup checks must not suppress that later evidence.
      failure ??= setupFailure;
      if (failure) throw failure; item.passed = true;
    }
    detail.passed = true;
  } catch (error) { primary = error; detail.error = errorText(error); }
  finally {
    for (const tab of tabs) try { await bounded(tab.close(), "close exact fixture tab"); }
    catch (error) { detail.cleanupErrors.push({ stage: "tab.close", tabId: tab.id, error: errorText(error) }); primary ??= error; }
    try {
      const ids = tabs.map(tab => tab.id);
      detail.cleanup = await bounded(worker.evaluate(`(async()=>({tabIds:${JSON.stringify(ids)},tabs:(await chrome.tabs.query({})).filter(t=>${JSON.stringify(ids)}.includes(t.id)),targets:(await chrome.debugger.getTargets()).filter(t=>${JSON.stringify(ids)}.includes(t.tabId)),probePresent:Object.hasOwn(globalThis,'__obuKeyboardChordProbe')}))()`), "native cleanup inventory");
      assert.deepEqual(detail.cleanup.tabs, []); assert.deepEqual(detail.cleanup.targets, []); assert.equal(detail.cleanup.probePresent, false);
    } catch (error) { detail.cleanupErrors.push({ stage: "native-cleanup", error: errorText(error) }); primary ??= error; }
    detail.server = server.allStats(); if (primary) { detail.passed = false; primary.keyboardChordDetail = detail; }
  }
  if (primary) throw primary; return detail;
}
