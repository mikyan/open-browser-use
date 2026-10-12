import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chooserScope } from "./chooser-waits-fixture.mjs";
import { installCountedPointerProbe, installPointerDeliveryGate } from "./pointer-delivery-cases.mjs";

const route = "/hover-delivery/";
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const errorText = error => error?.stack ?? String(error);
export const hoverDeliveryCases = Object.freeze([
  { name: "root-first-shift", layout: "root", gate: "drop-first", modifiers: ["Shift"], effect: "menu" },
  { name: "same-first-disabled", layout: "same", gate: "drop-first", disabled: true, effect: "menu" },
  { name: "oopif-first-cover", layout: "oopif", gate: "drop-first", effect: "cover" },
  { name: "transformed-first-move", layout: "transformed", gate: "drop-first", effect: "move" },
  { name: "root-remove", layout: "root", gate: "observe", effect: "remove" },
  { name: "root-all", layout: "root", gate: "drop-all", effect: "menu" },
  { name: "oopif-all", layout: "oopif", gate: "drop-all", effect: "menu" }
].map(spec => Object.freeze({ modifiers: [], ...spec })));
const keyPattern = /^hover-[a-f0-9]{32}-([a-z-]+)$/;
const pauseSpec = Object.freeze({ name: "root-pause", layout: "root", gate: "hold", modifiers: [], effect: "menu" });
function specFor(key) {
  const name = keyPattern.exec(key ?? "")?.[1], spec = [...hoverDeliveryCases, pauseSpec].find(value => value.name === name);
  assert.ok(spec, "Invalid hover fixture key"); return spec;
}
export function hoverDeliveryURLs(base, key) {
  const spec = specFor(key), root = new URL(`${route}page`, base); root.searchParams.set("key", key);
  const target = new URL(root); target.pathname = `${route}frame`;
  if (["oopif", "transformed"].includes(spec.layout)) target.hostname = "localhost";
  return { root: root.href, target: spec.layout === "root" ? root.href : target.href };
}

// Synthetic fixture script, not a browser automation implementation. It records
// native DOM events and changes its own menu/layout only in its normal handler.
export function installHoverEvidence(doc, spec, key) {
  const node = doc.querySelector("#hover-target"), menu = doc.querySelector("#menu");
  const evidence = globalThis.hoverDeliveryEvidence = {
    key, caseName: spec.name, documentToken: crypto.randomUUID(), nodeToken: node?.dataset.token ?? null,
    events: [], overflow: false, moves: 0, effects: [], compatibilityInitializations: 0, posts: 0, errors: []
  };
  // mousemove is retained as passive compatibility-event evidence; the hover
  // success contract deliberately requires only the primary pointer receipt.
  for (const type of ["pointermove", "mousemove", "pointerdown", "pointerup", "click", "keydown", "keyup"]) doc.addEventListener(type, event => {
    if (evidence.events.length >= 64) { evidence.overflow = true; return; }
    const hit = node && event.composedPath().includes(node);
    evidence.events.push({ sequence: evidence.events.length + 1, type, trusted: event.isTrusted, targetId: event.target?.id ?? "",
      originalNode: Boolean(hit), nodeToken: hit ? evidence.nodeToken : null, key: event.key ?? null,
      pointerType: event.pointerType ?? null, primary: event.isPrimary ?? null, buttons: event.buttons ?? null,
      shift: event.shiftKey, alt: event.altKey, ctrl: event.ctrlKey, meta: event.metaKey });
  }, true);
  // Normal menu business behavior: a delivered compatibility event initializes
  // the menu that pointermove just opened. The automation does not call this.
  doc.addEventListener("mousemove", event => {
    if (spec.effect !== "cover" || !menu || menu.hidden || !event.isTrusted || event.buttons !== 0) return;
    evidence.compatibilityInitializations++;
    menu.dataset.initialized = String(evidence.compatibilityInitializations);
  });
  if (!node) return;
  node.addEventListener("pointermove", event => {
    if (!event.isTrusted || event.pointerType !== "mouse" || !event.isPrimary || event.buttons !== 0) return;
    evidence.moves++;
    if (evidence.moves !== 1) return;
    evidence.effects.push(spec.effect);
    if (spec.effect === "remove") node.remove();
    else if (spec.effect === "move") node.style.transform = "translate(140px, 50px)";
    else { menu.hidden = false; if (spec.effect === "cover") { menu.style.pointerEvents = "auto"; menu.style.inset = "65px auto auto 65px"; } }
    evidence.posts++;
    const body = { key, caseName: spec.name, href: location.href, trusted: event.isTrusted, documentToken: evidence.documentToken,
      nodeToken: evidence.nodeToken, moves: evidence.moves, effect: spec.effect, evidence: structuredClone(evidence) };
    fetch(`/hover-delivery/post?${new URLSearchParams({ key })}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      .then(response => { if (!response.ok) throw Error(`Hover receipt HTTP ${response.status}`); return response.json(); })
      .then(receipt => { evidence.receipt = receipt; }).catch(error => evidence.errors.push(String(error)));
  });
}

// Read only the synthetic fixture's DOM and event ledger. No automation input.
export function readHoverEvidence() {
  const node = document.querySelector("#hover-target"), menu = document.querySelector("#menu");
  return { href: location.href, evidence: globalThis.hoverDeliveryEvidence,
    state: { targetPresent: Boolean(node), disabled: node?.disabled ?? null, transform: node?.style.transform ?? null,
      menuVisible: Boolean(menu && !menu.hidden), menuInset: menu?.style.inset ?? null, menuInitialized: menu?.dataset.initialized ?? null } };
}

export function hoverDeliveryHTML(url) {
  const key = url.searchParams.get("key"), spec = specFor(key), urls = hoverDeliveryURLs(url, key);
  assert.ok([`${route}page`, `${route}frame`].includes(url.pathname));
  const ownsTarget = spec.layout === "root" || url.pathname === `${route}frame`;
  return `<!doctype html><meta charset="utf-8"><title>Hover delivery ${key}</title>
<style>html,body{margin:0;background:white;font:16px sans-serif}#hover-target{position:absolute;left:70px;top:70px;width:230px;height:70px}#menu{position:absolute;left:340px;top:70px;width:240px;height:100px;background:#def;pointer-events:none}iframe{margin:60px 0 0 65px;width:650px;height:360px;border:3px solid #246;transform-origin:0 0;${spec.layout === "transformed" ? "transform:rotate(7deg) scale(.88,1.04)" : ""}}</style>
${ownsTarget ? `<button id="hover-target" data-token="${key}-node" ${spec.disabled ? "disabled" : ""}>Hover menu</button><div id="menu" hidden>Menu opened</div>` : `<iframe id="hover-frame" title="Hover frame" src="${urls.target}"></iframe>`}
<script>(${installHoverEvidence.toString()})(document,${JSON.stringify(spec)},${JSON.stringify(key)});</script>`;
}

export function createHoverDeliveryFixtures() {
  const records = new Map();
  const entry = key => {
    specFor(key);
    if (!records.has(key)) { assert.ok(records.size < 128, "Hover fixture record limit"); records.set(key, { key, gets: [], posts: [] }); }
    return records.get(key);
  };
  return {
    stats: key => structuredClone(entry(key)), allStats: () => structuredClone([...records.values()]),
    handle(request, response, url) {
      if (![`${route}page`, `${route}frame`, `${route}post`].includes(url.pathname)) return false;
      let record; const key = url.searchParams.get("key");
      try { record = entry(key); } catch { response.writeHead(400); response.end("Invalid hover fixture key"); return true; }
      if (url.pathname !== `${route}post`) {
        if (request.method !== "GET") { response.writeHead(405); response.end(); return true; }
        if (record.gets.length >= 32) { record.overflow = true; response.writeHead(429); response.end(); return true; }
        const html = hoverDeliveryHTML(url);
        record.gets.push({ path: url.pathname, sha256: hash(Buffer.from(html)), at: Date.now() });
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); response.end(html); return true;
      }
      if (request.method !== "POST") { response.writeHead(405); response.end(); return true; }
      if (record.posts.length >= 16) { record.overflow = true; response.writeHead(429); response.end(); return true; }
      const post = { method: "POST", receivedAt: Date.now() }; record.posts.push(post);
      const chunks = []; let size = 0;
      request.on("data", chunk => { size += chunk.length; if (size <= 64 * 1024) chunks.push(chunk); });
      request.once("aborted", () => { post.error = "HTTP request aborted"; });
      request.once("error", error => { post.error = String(error); });
      request.once("end", () => {
        const bytes = Buffer.concat(chunks);
        Object.assign(post, { completedAt: Date.now(), bodyBytes: size, bodyBase64: bytes.toString("base64"), bodySHA256: hash(bytes) });
        try {
          assert.ok(size <= 64 * 1024, "Hover receipt size limit"); post.value = JSON.parse(bytes.toString("utf8")); assert.equal(post.value.key, key);
          post.receipt = { key, index: record.posts.length, bodySHA256: post.bodySHA256 };
          response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify(post.receipt));
        } catch (error) { post.error = errorText(error); response.writeHead(400); response.end("Invalid hover receipt"); }
      });
      return true;
    }
  };
}

export function checkHoverTrace(probe, spec) {
  assert.equal(probe?.version, 1); assert.equal(probe.mode, spec.gate);
  assert.equal(probe.overflow, false); assert.equal(probe.recordingErrors, 0); assert.equal(probe.pending, 0); assert.equal(probe.restored, true);
  assert.ok(probe.records.every((value, index) => value.sequence === index + 1));
  const calls = probe.records.filter(value => value.kind === "invoke"), acks = new Map();
  assert.equal(probe.records.length, calls.length * 2, "Unassociated input evidence");
  for (const call of calls) {
    assert.deepEqual(call.source, { tabId: probe.tabId }, "Hover input must use exact root routing");
    const settlements = probe.records.filter(value => value.invocation === call.sequence); assert.equal(settlements.length, 1);
    const ack = settlements[0]; assert.ok(ack.sequence > call.sequence);
    assert.equal(ack.kind, call.dispatched ? "settled" : "synthetic-ack");
    if (call.dispatched) assert.equal(ack.ok, true); else assert.equal(call.params.type, "mouseMoved");
    acks.set(call.sequence, ack.sequence);
  }
  const mouse = calls.filter(call => !call.method || call.method === "Input.dispatchMouseEvent"), keys = calls.filter(call => call.method === "Input.dispatchKeyEvent");
  assert.equal(mouse.length + keys.length, calls.length); assert.ok(mouse.length > 0);
  assert.ok(mouse.every(call => call.params.type === "mouseMoved" && !call.params.buttons && (!call.params.button || call.params.button === "none")), "Hover must not press or release a mouse button");
  assert.ok(mouse.every(call => (call.params.modifiers ?? 0) === (spec.modifiers.includes("Shift") ? 8 : 0)), "Hover must preserve the exact requested modifier set");
  const dropped = mouse.filter(call => !call.dispatched), delivered = mouse.filter(call => call.dispatched);
  assert.equal(dropped.length, probe.dropped);
  assert.equal(delivered.length, spec.gate === "drop-all" ? 0 : 1, "Exactly one original move must reach the renderer");
  assert.equal(dropped.length, spec.gate === "drop-all" ? mouse.length : spec.gate === "drop-first" ? 1 : 0);
  if (spec.gate === "drop-all") assert.ok(dropped.length >= 2, "Missing receipt must be retried until the original deadline");
  for (let index = 1; index < mouse.length; index++) assert.ok(mouse[index].sequence > acks.get(mouse[index - 1].sequence), "A retry preceded the original move ACK");
  if (spec.modifiers.includes("Shift")) {
    const down = keys.filter(call => call.params.key === "Shift" && ["keyDown", "rawKeyDown"].includes(call.params.type));
    const up = keys.filter(call => call.params.key === "Shift" && call.params.type === "keyUp");
    assert.equal(down.length, mouse.length); assert.equal(up.length, mouse.length); assert.equal(keys.length, mouse.length * 2);
    assert.ok(down.every(call => call.params.code === "ShiftLeft" && call.params.modifiers === 8));
    assert.ok(up.every(call => call.params.code === "ShiftLeft" && call.params.modifiers === 0));
    for (let index = 0; index < mouse.length; index++) {
      assert.ok(acks.get(down[index].sequence) < mouse[index].sequence);
      assert.ok(up[index].sequence > acks.get(mouse[index].sequence));
      if (index) assert.ok(down[index].sequence > acks.get(up[index - 1].sequence), "The previous attempt did not restore modifiers before retry");
    }
  } else assert.equal(keys.length, 0);
  return { attempts: mouse.length, syntheticAcks: dropped.length, nativeMoves: delivered.length, mouseButtons: 0, keyCommands: keys.length };
}

export function checkHoverDocuments(item, spec) {
  assert.equal(item.server.overflow, undefined);
  const document = item.documents.find(value => value.result?.href === item.targetURL)?.result, target = document?.evidence;
  assert.ok(target); assert.equal(target.key, item.key); assert.equal(target.caseName, spec.name);
  assert.equal(target.nodeToken, `${item.key}-node`); assert.equal(target.overflow, false); assert.deepEqual(target.errors, []);
  assert.ok(typeof target.documentToken === "string" && target.documentToken);
  const events = item.documents.flatMap(value => value.result.evidence.events);
  assert.ok(events.every(value => value.trusted), "Every observed input event must be native/trusted");
  assert.equal(events.filter(value => ["pointerdown", "pointerup", "click"].includes(value.type)).length, 0);
  for (const document of item.documents) {
    assert.equal(document.result.evidence.key, item.key); assert.equal(document.result.evidence.overflow, false);
    assert.deepEqual(document.result.evidence.errors, []);
  }
  const moves = target.events.filter(value => value.type === "pointermove" && value.originalNode);
  const expected = spec.gate === "drop-all" ? 0 : 1;
  assert.equal(moves.length, expected); assert.equal(target.moves, expected); assert.equal(target.posts, expected); assert.equal(item.server.posts.length, expected);
  assert.equal(document.state.targetPresent, !expected || spec.effect !== "remove");
  if (document.state.targetPresent) assert.equal(document.state.disabled, Boolean(spec.disabled));
  assert.equal(document.state.menuVisible, Boolean(expected && ["menu", "cover"].includes(spec.effect)));
  if (expected && spec.effect === "move") assert.equal(document.state.transform, "translate(140px, 50px)");
  if (expected && spec.effect === "cover") {
    assert.equal(document.state.menuInset, "65px auto auto 65px");
    assert.equal(target.compatibilityInitializations, 1, "The opened menu must receive exactly one native compatibility initialization");
    assert.equal(document.state.menuInitialized, "1");
    const compatibility = target.events.filter(value => value.type === "mousemove"); assert.equal(compatibility.length, 1);
    assert.equal(compatibility[0].buttons, 0); assert.ok(compatibility[0].sequence > moves[0].sequence);
  }
  if (!expected) { assert.deepEqual(target.effects, []); return { moves: 0, posts: 0, documentToken: target.documentToken }; }
  const move = moves[0]; assert.equal(move.nodeToken, target.nodeToken); assert.equal(move.pointerType, "mouse"); assert.equal(move.primary, true); assert.equal(move.buttons, 0);
  assert.equal(move.shift, spec.modifiers.includes("Shift"));
  for (const key of ["ctrl", "alt", "meta"]) assert.equal(move[key], false);
  assert.deepEqual(target.effects, [spec.effect]);
  const post = item.server.posts[0], bytes = Buffer.from(post.bodyBase64, "base64");
  assert.equal(post.error, undefined); assert.equal(post.method, "POST"); assert.equal(bytes.length, post.bodyBytes); assert.equal(hash(bytes), post.bodySHA256);
  assert.deepEqual(JSON.parse(bytes.toString("utf8")), post.value);
  for (const [key, value] of Object.entries({ key: item.key, caseName: spec.name, href: item.targetURL, documentToken: target.documentToken, nodeToken: target.nodeToken, trusted: true, moves: 1, effect: spec.effect })) assert.equal(post.value[key], value);
  assert.deepEqual(post.value.evidence.effects, [spec.effect]); assert.equal(post.receipt.index, 1); assert.equal(post.receipt.bodySHA256, post.bodySHA256);
  return { moves: 1, posts: 1, documentToken: target.documentToken, nodeToken: target.nodeToken, bytes: bytes.length, sha256: post.bodySHA256 };
}

export function checkHoverDeadline(item) {
  assert.equal(item.timeoutMs, 5000); assert.equal(item.completedAt, undefined);
  assert.match(item.actionError, /timed out|timeout/i);
  assert.ok(Number.isFinite(item.startedAt) && Number.isFinite(item.failedAt));
  assert.ok(item.failedAt - item.startedAt >= 4900, "A premature failure is not deadline coverage");
  assert.ok(item.failedAt - item.startedAt < 7500, "Original hover deadline was not bounded");
  return { elapsedMs: item.failedAt - item.startedAt, timeoutMs: item.timeoutMs };
}

// Staged Native Port observer. Only the original tab/scope hover is retained;
// other task requests and response data are never copied or intercepted.
export function installHoverRPCObserver(api, target, { id, tabId, scope }) {
  if (target.__obuHoverRPC || target.__integrationNativeRPCObserver || typeof id !== "string" || !id ||
      !Number.isSafeInteger(tabId) || !scope?.session_id || !scope.turn_id || !Number.isSafeInteger(scope.control_epoch) || scope.control_epoch <= 0)
    throw Error("Invalid hover RPC observer setup");
  const original = api.debugger.sendCommand, nativeThen = Promise.prototype.then, inputCalls = [];
  const records = [], requests = new Map(); let overflow = false, restored = false, inputPending = 0, inputRecordingErrors = 0;
  if (typeof original !== "function") throw Error("Hover native input observer unavailable");
  // This outer observer sees calls INTO the existing suppression gate. It is
  // not another native ACK proof; it establishes that no key/drag path bypassed
  // the mouse-only gate. It preserves every original Promise and argument.
  function inputObserver(...args) {
    let descriptors;
    try { descriptors = Object.getOwnPropertyDescriptors(args[0] ?? {}); } catch { return Reflect.apply(original, this, args); }
    if (descriptors.tabId?.value !== tabId || typeof args[1] !== "string" || !args[1].startsWith("Input.")) return Reflect.apply(original, this, args);
    let call;
    try {
      if (inputCalls.length >= 256) overflow = true;
      else { call = { sequence: inputCalls.length + 1, source: structuredClone(args[0]), method: args[1], params: structuredClone(args[2]) }; inputCalls.push(call); }
    } catch { inputRecordingErrors++; }
    let operation;
    try { operation = Reflect.apply(original, this, args); }
    catch (error) { if (call) call.settled = "rejected"; throw error; }
    inputPending++;
    try { nativeThen.call(operation, () => { inputPending--; if (call) call.settled = "fulfilled"; }, () => { inputPending--; if (call) call.settled = "rejected"; }); }
    catch { inputPending--; inputRecordingErrors++; }
    return operation;
  }
  const append = value => { if (records.length >= 16) { overflow = true; return; } records.push({ sequence: records.length + 1, at: Date.now(), ...value }); };
  const observer = (direction, message) => {
    if (direction === "request") {
      const p = message.params;
      if (message.method !== "browserAction" || p?.action !== "hover" || p.tabId !== tabId ||
          p.session_id !== scope.session_id || p.turn_id !== scope.turn_id || p.control_epoch !== scope.control_epoch) return;
      if (requests.size >= 4 || requests.has(message.id)) { overflow = true; return; }
      append({ kind: "request", requestId: message.id, method: "browserAction:hover", scope: { ...scope }, timeoutMs: p.timeoutMs });
      requests.set(message.id, records.length);
    } else if (direction === "response" && requests.has(message.id)) {
      append({ kind: "response", requestId: message.id, requestSequence: requests.get(message.id), ok: !message.error,
        ...(message.error ? { error: String(message.error.message ?? message.error).slice(0, 2048) } : {}) });
    }
  };
  const snapshot = () => structuredClone({ version: 1, id, tabId, scope, records, overflow, restored, inputCalls, inputPending, inputRecordingErrors });
  const controller = { id, snapshot, restore() {
    if (!restored) {
      const changed = target.__obuHoverRPC !== controller || target.__integrationNativeRPCObserver !== observer || api.debugger.sendCommand !== inputObserver;
      if (api.debugger.sendCommand === inputObserver) api.debugger.sendCommand = original;
      if (target.__integrationNativeRPCObserver === observer) delete target.__integrationNativeRPCObserver;
      if (target.__obuHoverRPC === controller) delete target.__obuHoverRPC;
      if (changed) throw Error("Hover RPC observer replaced externally");
      restored = true;
    }
    return snapshot();
  } };
  api.debugger.sendCommand = inputObserver;
  if (api.debugger.sendCommand !== inputObserver) throw Error("Hover input observer not installed");
  target.__integrationNativeRPCObserver = observer; target.__obuHoverRPC = controller; return snapshot();
}

// The native bridge calls observe synchronously in the SAME Node process as
// the public SDK caller. No browser command, payload mutation or clock offset.
export function createHoverRPCRelay() {
  let active;
  const cloneScope = scope => ({ session_id: scope.session_id, turn_id: scope.turn_id, control_epoch: scope.control_epoch });
  return {
    observe(direction, message) {
      const state = active; if (!state) return;
      try {
        const append = value => { if (state.records.length >= 16) { state.overflow = true; return; } state.records.push({ sequence: state.records.length + 1, at: Date.now(), ...value }); };
        if (direction === "request") {
          const p = message?.params;
          if (message.method !== "browserAction" || p?.action !== "hover" || p.tabId !== state.tabId ||
              p.session_id !== state.scope.session_id || p.turn_id !== state.scope.turn_id || p.control_epoch !== state.scope.control_epoch) return;
          if (typeof message.id !== "string" || message.id.length > 128 || state.requests.size >= 4 || state.requests.has(message.id)) { state.overflow = true; return; }
          append({ kind: "request", requestId: message.id, method: "browserAction:hover", scope: cloneScope(state.scope), timeoutMs: p.timeoutMs });
          state.requests.set(message.id, state.records.length);
        } else if (direction === "response" && state.requests.has(message?.id)) {
          const error = message.error ? String(message.error.message ?? message.error) : null;
          if (error?.length > 2048) state.overflow = true;
          append({ kind: "response", requestId: message.id, requestSequence: state.requests.get(message.id), ok: !message.error,
            ...(error === null ? {} : { error: error.slice(0, 2048) }) });
        }
      } catch { state.recordingErrors++; }
    },
    arm(tabId, scope) {
      assert.equal(active, undefined, "Hover relay already armed");
      assert.ok(Number.isSafeInteger(tabId) && tabId >= 0);
      assert.ok([scope?.session_id, scope?.turn_id].every(value => typeof value === "string" && value.length > 0 && value.length <= 1024));
      assert.ok(Number.isSafeInteger(scope.control_epoch) && scope.control_epoch > 0);
      const state = { tabId, scope: cloneScope(scope), records: [], requests: new Map(), overflow: false, recordingErrors: 0, stopped: false }; active = state;
      const snapshot = () => structuredClone({ version: 1, tabId, scope: state.scope, records: state.records, overflow: state.overflow, recordingErrors: state.recordingErrors, stopped: state.stopped });
      return { snapshot, stop() { if (active === state) active = undefined; state.stopped = true; return snapshot(); } };
    }
  };
}

export function checkHoverRPCDeadline(probe, outcome, timeoutMs, callerStartedAt, relayProbe) {
  for (const evidence of [probe, relayProbe]) {
    assert.equal(evidence?.version, 1); assert.equal(evidence.overflow, false);
    assert.ok(evidence.records.every((record, index) => record.sequence === index + 1));
  }
  assert.equal(relayProbe.recordingErrors, 0); assert.equal(relayProbe.tabId, probe.tabId); assert.deepEqual(relayProbe.scope, probe.scope);
  assert.equal(outcome.ok, false); assert.match(outcome.error, /timed out|timeout/i);
  const pair = evidence => {
    const requests = evidence.records.filter(value => value.kind === "request"); assert.equal(requests.length, 1);
    const request = requests[0], responses = evidence.records.filter(value => value.kind === "response" && value.requestId === request.requestId);
    assert.equal(request.method, "browserAction:hover"); assert.deepEqual(request.scope, evidence.scope);
    assert.equal(responses.length, 1, "An SDK-only timeout does not prove the backend deadline");
    const response = responses[0]; assert.equal(response.requestSequence, request.sequence); assert.ok(response.sequence > request.sequence);
    assert.equal(response.ok, false); assert.match(response.error, /timed out|timeout/i); return { request, response };
  };
  const worker = pair(probe), relay = pair(relayProbe), request = relay.request;
  for (const key of ["requestId", "method", "timeoutMs"]) assert.equal(worker.request[key], request[key], "Worker/relay original request differs");
  assert.equal(worker.response.requestId, relay.response.requestId); assert.equal(worker.response.error, relay.response.error);
  assert.equal(typeof outcome.errorMessage, "string");
  assert.equal(outcome.errorMessage, relay.response.error, "Caller must receive the exact original backend error");
  assert.doesNotMatch(outcome.errorMessage, /^Open Browser Use request timed out/i, "An SDK-local timeout is not a backend response");
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0);
  assert.ok(Number.isSafeInteger(callerStartedAt) && callerStartedAt >= 0 && Number.isSafeInteger(request.at));
  const elapsedToWireMs = request.at - callerStartedAt;
  assert.ok(elapsedToWireMs >= 0 && elapsedToWireMs < timeoutMs, "The original request must arrive within its caller budget");
  // The SDK debits preparation before sending. This Node relay sees receipt,
  // not the private send instant: elapsedToWire also contains IPC transit.
  // Consequently this interval is a conservative bound, not an exact debit.
  const minimumWireBudgetMs = Math.max(1, timeoutMs - elapsedToWireMs);
  assert.ok(Number.isSafeInteger(request.timeoutMs) && request.timeoutMs >= minimumWireBudgetMs && request.timeoutMs <= timeoutMs,
    "The wire budget must be positive, unextended, and consistent with observed preparation/transit time");
  assert.ok(Number.isSafeInteger(relay.response.at) && relay.response.at >= request.at && Number.isSafeInteger(outcome.settledAt));
  assert.ok(relay.response.at <= outcome.settledAt, "The same-process relay response must precede caller settlement");
  return { ...worker, relay, callerStartedAt, callerSettledAt: outcome.settledAt,
    requestedTimeoutMs: timeoutMs, elapsedToWireMs, minimumWireBudgetMs, maximumWireBudgetMs: timeoutMs, observedWireBudgetMs: request.timeoutMs };
}

export function checkHoverDropAllDeadline(item) {
  assert.equal(item.rpcProbe.restored, true); assert.equal(item.rpcProbe.inputPending, 0); assert.equal(item.rpcProbe.inputRecordingErrors, 0);
  const expected = item.probe.records.filter(value => value.kind === "invoke").map(value => ({ source: value.source, method: "Input.dispatchMouseEvent", params: value.params }));
  assert.deepEqual(item.rpcProbe.inputCalls.map(value => { assert.equal(value.settled, "fulfilled"); return { source: value.source, method: value.method, params: value.params }; }), expected);
  return checkHoverRPCDeadline(item.rpcProbe, { ok: false, error: item.actionError, errorMessage: item.actionErrorMessage, settledAt: item.failedAt }, item.timeoutMs, item.startedAt, item.relayProbe);
}

async function bounded(operation, label, timeoutMs = 7000) {
  let timer;
  try { return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`Hover fixture ${label} timed out`)), timeoutMs); })]); }
  finally { clearTimeout(timer); }
}

async function exactCleanupEvidence(worker, tabs) {
  const ids = tabs.map(tab => tab.id);
  const evidence = await bounded(worker.evaluate(`(async()=>({tabs:(await chrome.tabs.query({})).filter(t=>${JSON.stringify(ids)}.includes(t.id)),targets:(await chrome.debugger.getTargets()).filter(t=>${JSON.stringify(ids)}.includes(t.tabId))}))()`), "exact native cleanup");
  return { tabIds: ids, ...evidence };
}

export async function checkHoverDelivery({ browser, worker, fixtureURL, server, until, rpcRelay, detail = {} }) {
  Object.assign(detail, { passed: false, cases: [], cleanupErrors: [], boundary: "Controlled root mouseMoved suppression receives a synthetic ACK; delivered moves and DOM receipts remain native. This does not reproduce a natural compositor failure. No focus allowance is added." });
  const tabs = []; let primary;
  try {
    for (const spec of hoverDeliveryCases) {
      const id = randomUUID(), key = `hover-${id.replaceAll("-", "")}-${spec.name}`, urls = hoverDeliveryURLs(fixtureURL, key);
      const item = { id, key, spec, url: urls.root, targetURL: urls.target, timeoutMs: 5000, passed: false }; detail.cases.push(item);
      const tab = await browser.newTab(); tabs.push(tab); item.tabId = tab.id;
      await browser.cdp.navigate(tab.id, urls.root);
      const frame = spec.layout === "root" ? tab : tab.frameLocator("#hover-frame"), locator = frame.getByRole("button", { name: "Hover menu", exact: true });
      assert.equal(await locator.textContent({ timeoutMs: 5000 }), "Hover menu");
      assert.equal(await locator.count(), 1);
      item.scope = chooserScope(browser);
      const install = spec.gate === "drop-all" ? installPointerDeliveryGate : installCountedPointerProbe;
      const slot = spec.gate === "drop-all" ? "__obuPointerDelivery" : "__obuCountedPointer";
      let attempted = false, failure, relay;
      try {
        if (spec.gate === "drop-all") relay = rpcRelay.arm(tab.id, item.scope);
        attempted = true;
        item.installation = await bounded(worker.evaluate(`(()=>{if(Date.now()>=${Date.now() + 6500})throw Error('Hover probe setup expired');const gate=(${install.toString()})(chrome,globalThis,${JSON.stringify({ id, tabId: tab.id, mode: spec.gate })});${spec.gate === "drop-all" ? `try{(${installHoverRPCObserver.toString()})(chrome,globalThis,${JSON.stringify({ id, tabId: tab.id, scope: item.scope })})}catch(error){globalThis[${JSON.stringify(slot)}].restore();throw error;}` : ""}return gate;})()`), "probe install");
        item.startedAt = Date.now();
        try { await locator.hover({ timeoutMs: item.timeoutMs, modifiers: spec.modifiers }); item.completedAt = Date.now(); }
        catch (error) { item.failedAt = Date.now(); item.actionError = errorText(error); item.actionErrorMessage = String(error?.message ?? error); if (spec.gate !== "drop-all") throw error; }
        if (spec.gate === "drop-all") item.deadlineProof = checkHoverDeadline(item);
        else await until(() => server.stats(key).posts.length === 1 && server.stats(key).posts[0].receipt, "one original hover receipt", 5000);
      } catch (error) { failure = error; item.error = errorText(error); }
      finally {
        if (relay) item.relayProbe = relay.stop();
        // Unwind the transparent outer observer before the shared inner gate.
        if (attempted && spec.gate === "drop-all") try {
          item.rpcProbe = await bounded(worker.evaluate(`(()=>{const p=globalThis.__obuHoverRPC;if(!p||p.id!==${JSON.stringify(id)})throw Error('Hover RPC observer missing/replaced');return p.restore()})()`), "RPC observer restore");
        } catch (error) { item.rpcRestoreError = errorText(error); detail.cleanupErrors.push({ stage: "rpc-restore", error: item.rpcRestoreError }); failure ??= error; }
        if (attempted) try {
          item.probe = await bounded(worker.evaluate(`(()=>{const p=globalThis[${JSON.stringify(slot)}];if(!p||p.id!==${JSON.stringify(id)})throw Error('Hover probe missing/replaced');return p.restore()})()`), "probe restore");
        } catch (error) { item.restoreError = errorText(error); detail.cleanupErrors.push({ stage: "restore", error: item.restoreError }); failure ??= error; }
      }
      try {
        item.server = server.stats(key); assert.deepEqual(chooserScope(browser), item.scope);
        item.native = await bounded(worker.evaluate(`(async()=>({tab:await chrome.tabs.get(${tab.id}),frames:await chrome.webNavigation.getAllFrames({tabId:${tab.id}})}))()`), "native documents");
        assert.equal(item.native.tab.active, false); assert.equal(item.native.tab.url, urls.root);
        const roots = item.native.frames.filter(value => value.frameId === 0 && value.url === urls.root);
        const targets = item.native.frames.filter(value => value.url === urls.target);
        assert.equal(roots.length, 1); assert.equal(targets.length, 1);
        if (["oopif", "transformed"].includes(spec.layout)) assert.notEqual(roots[0].processId, targets[0].processId, "A real OOPIF is required");
        const documents = spec.layout === "root" ? roots : [...roots, ...targets];
        assert.ok(documents.every(value => value.documentId && value.documentLifecycle === "active" && value.errorOccurred === false));
        item.documents = await bounded(worker.evaluate(`chrome.scripting.executeScript({target:{tabId:${tab.id},documentIds:${JSON.stringify(documents.map(value => value.documentId))}},world:'MAIN',func:${readHoverEvidence.toString()}})`), "read fixture evidence");
        assert.equal(item.documents.length, documents.length);
        for (const document of documents) assert.equal(item.documents.filter(value => value.documentId === document.documentId && value.frameId === document.frameId && value.result.href === document.url).length, 1);
        item.traceProof = checkHoverTrace(item.probe, spec); item.documentProof = checkHoverDocuments(item, spec);
        if (spec.gate === "drop-all") item.wireTimeout = checkHoverDropAllDeadline(item);
      } catch (error) { item.evidenceError = errorText(error); failure ??= error; }
      if (failure) throw failure;
      item.passed = true;
    }
    detail.passed = true;
  } catch (error) { primary = error; detail.error = errorText(error); }
  finally {
    for (const tab of tabs) try { await bounded(tab.close(), "close fixture tab"); }
    catch (error) { detail.cleanupErrors.push({ stage: "tab.close", tabId: tab.id, error: errorText(error) }); primary ??= error; }
    try { detail.after = await exactCleanupEvidence(worker, tabs); assert.deepEqual(detail.after.tabs, []); assert.deepEqual(detail.after.targets, []); }
    catch (error) { detail.cleanupErrors.push({ stage: "native-tab-target-absence", error: errorText(error) }); primary ??= error; }
    detail.server = server.allStats();
    if (primary) { detail.passed = false; primary.hoverDeliveryDetail = detail; }
  }
  if (primary) throw primary;
  return detail;
}

// Test-only fault injection: await the ORIGINAL successful native mouse move,
// retain its result, then hold only Promise publication. No move is suppressed
// or repeated here. The watchdog is recorded failure, never successful release.
export function installHoverAckHold(api, target, { id, tabId, scope, holdTimeoutMs = 30000 }) {
  if (target.__obuHoverHold || target.__integrationNativeRPCObserver || typeof id !== "string" || !id || !Number.isSafeInteger(tabId) || tabId < 0 ||
      !scope?.session_id || !scope.turn_id || !Number.isSafeInteger(scope.control_epoch) || scope.control_epoch <= 0 ||
      !Number.isInteger(holdTimeoutMs) || holdTimeoutMs < 1 || holdTimeoutMs > 30000) throw Error("Invalid hover hold setup");
  const original = api.debugger.sendCommand, records = [], requests = new Map();
  if (typeof original !== "function") throw Error("Native sendCommand missing");
  let sequence = 0, selected = false, held = false, released = false, restored = false, overflow = false, pending = 0, failure = null, timer, publish;
  const append = value => { if (records.length >= 128) { overflow = true; return; } records.push({ sequence: ++sequence, at: Date.now(), ...value }); };
  function wrapper(...args) {
    let source;
    try { source = Object.getOwnPropertyDescriptors(args[0] ?? {}); } catch { return Reflect.apply(original, this, args); }
    if (source.tabId?.value !== tabId || typeof args[1] !== "string" || !args[1].startsWith("Input.")) return Reflect.apply(original, this, args);
    const choose = !selected && Object.keys(source).length === 1 && args[1] === "Input.dispatchMouseEvent" && Object.getOwnPropertyDescriptor(args[2] ?? {}, "type")?.value === "mouseMoved";
    append({ kind: "invoke", source: structuredClone(args[0]), method: args[1], params: structuredClone(args[2]), heldCall: choose });
    const invocation = sequence; if (choose) selected = true;
    let native;
    try { native = Reflect.apply(original, this, args); }
    catch (error) { append({ kind: "native-settled", invocation, ok: false, error: String(error) }); throw error; }
    pending++;
    const actual = Promise.resolve(native).then(value => {
      append({ kind: "native-settled", invocation, ok: true, result: structuredClone(value) });
      if (!choose || released) return value;
      held = true; append({ kind: "held", invocation });
      return new Promise((resolve, reject) => {
        publish = () => { clearTimeout(timer); held = false; append({ kind: "published", invocation }); resolve(value); };
        timer = setTimeout(() => { failure = "Hover ACK hold watchdog expired"; held = false; append({ kind: "watchdog-failed", invocation }); reject(Error(failure)); }, holdTimeoutMs);
      });
    }, error => { append({ kind: "native-settled", invocation, ok: false, error: String(error) }); throw error; }).finally(() => { pending--; });
    actual.catch(() => {}); return actual;
  }
  const onRPC = (direction, message) => {
    if (direction === "request") {
      const p = message.params;
      if (message.method !== "browserAction" || p?.action !== "hover" || p.tabId !== tabId ||
          p.session_id !== scope.session_id || p.turn_id !== scope.turn_id || p.control_epoch !== scope.control_epoch) return;
      if (requests.size >= 4 || requests.has(message.id)) { overflow = true; return; }
      append({ kind: "request", requestId: message.id, method: "browserAction:hover", scope: { ...scope }, timeoutMs: p.timeoutMs });
      requests.set(message.id, sequence);
    } else if (direction === "response" && requests.has(message.id)) {
      append({ kind: "response", requestId: message.id, requestSequence: requests.get(message.id), ok: !message.error,
        ...(message.error ? { error: String(message.error.message ?? message.error).slice(0, 2048) } : {}) });
    }
  };
  const snapshot = () => structuredClone({ version: 1, id, tabId, scope, records, held, released, restored, pending, overflow, failure });
  const controller = { id, snapshot, release() {
    if (failure) throw Error(failure);
    if (!released) { released = true; append({ kind: "release-requested" }); publish?.(); }
    return snapshot();
  }, restore() {
    if (!restored) {
      const changed = api.debugger.sendCommand !== wrapper || target.__integrationNativeRPCObserver !== onRPC || target.__obuHoverHold !== controller;
      if (!released && !failure) controller.release();
      if (api.debugger.sendCommand === wrapper) api.debugger.sendCommand = original;
      if (target.__integrationNativeRPCObserver === onRPC) delete target.__integrationNativeRPCObserver;
      if (target.__obuHoverHold === controller) delete target.__obuHoverHold;
      if (changed) throw Error("Hover hold replaced externally");
      if (pending) throw Error("Hover hold restored with actual delivery pending");
      restored = true;
    }
    const result = snapshot(); if (target.__obuHoverHold === controller) delete target.__obuHoverHold; return result;
  } };
  api.debugger.sendCommand = wrapper; if (api.debugger.sendCommand !== wrapper) throw Error("Hover hold not installed");
  target.__integrationNativeRPCObserver = onRPC; target.__obuHoverHold = controller; return snapshot();
}

export function checkHoverHold(probe, { complete = false } = {}) {
  assert.equal(probe?.version, 1); assert.equal(probe.overflow, false); assert.equal(probe.failure, null);
  assert.ok(probe.records.every((value, index) => value.sequence === index + 1));
  const invokes = probe.records.filter(value => value.kind === "invoke"), moves = invokes.filter(value => value.method === "Input.dispatchMouseEvent");
  assert.equal(invokes.length, 1, "The unmodified held hover must not emit extra input");
  assert.equal(moves.length, 1, "Held native move cannot be repeated or followed by button input");
  assert.equal(moves[0].params.type, "mouseMoved"); assert.equal(moves[0].heldCall, true); assert.deepEqual(moves[0].source, { tabId: probe.tabId });
  assert.equal(moves[0].params.modifiers ?? 0, 0); assert.equal(moves[0].params.buttons ?? 0, 0); assert.ok(!moves[0].params.button || moves[0].params.button === "none");
  const native = probe.records.filter(value => value.kind === "native-settled" && value.invocation === moves[0].sequence);
  assert.equal(native.length, 1); assert.equal(native[0].ok, true);
  const held = probe.records.filter(value => value.kind === "held"); assert.equal(held.length, 1); assert.ok(held[0].sequence > native[0].sequence);
  const published = probe.records.filter(value => value.kind === "published"), release = probe.records.filter(value => value.kind === "release-requested");
  if (complete) {
    assert.equal(probe.held, false); assert.equal(probe.released, true); assert.equal(probe.restored, true); assert.equal(probe.pending, 0);
    assert.equal(release.length, 1); assert.equal(published.length, 1); assert.ok(release[0].sequence > held[0].sequence); assert.ok(published[0].sequence > release[0].sequence);
  } else {
    assert.equal(probe.held, true); assert.equal(probe.released, false); assert.equal(probe.pending, 1); assert.equal(probe.restored, false);
    assert.equal(release.length, 0); assert.equal(published.length, 0);
  }
  return { invocation: moves[0].sequence, nativeACK: native[0].sequence, held: held[0].sequence, publication: published[0]?.sequence ?? null };
}

export function checkHoverWireTimeout(probe, outcome, callerStartedAt, relayProbe) {
  checkHoverHold(probe);
  const proof = checkHoverRPCDeadline(probe, outcome, 1000, callerStartedAt, relayProbe);
  assert.ok(proof.response.sequence > probe.records.find(value => value.kind === "held").sequence); return proof;
}

export function checkHoverPauseDeadline(detail) {
  assert.equal(detail.cleanupTimeoutMs, 10000);
  assert.equal(detail.pause.ok, false); assert.match(detail.pause.error, /OBU_AUTOMATION_PAUSE_FAILED/);
  assert.match(detail.pause.error, /OBU_AUTOMATION_CLEANUP_TIMEOUT/, "An unrelated cleanup error is not pending-input deadline evidence");
  assert.ok(Number.isFinite(detail.pauseStartedAt) && Number.isFinite(detail.pauseSettledAt));
  const elapsedMs = detail.pauseSettledAt - detail.pauseStartedAt;
  assert.ok(elapsedMs >= 9900 && elapsedMs < 15000, "Pause must consume the unchanged actual cleanup budget");
  assert.equal(detail.failed.ok, true); assert.equal(detail.failed.value.state, "error");
  assert.match(detail.failed.value.error, /OBU_AUTOMATION_CLEANUP_TIMEOUT/);
  assert.equal(detail.failed.value.inputBlocked, true); assert.equal(detail.failed.value.cleanupComplete, false);
  checkHoverHold(detail.stillHeld);
  return { elapsedMs, timeoutMs: detail.cleanupTimeoutMs, error: detail.pause.error };
}

export async function checkHoverPause({ browser, worker, fixtureURL, server, until, rpcRelay, detail = {} }) {
  const id = randomUUID(), key = `hover-${id.replaceAll("-", "")}-root-pause`, urls = hoverDeliveryURLs(fixtureURL, key);
  Object.assign(detail, { id, key, url: urls.root, targetURL: urls.target, passed: false, cleanupErrors: [], boundary: "A successful original native mouseMoved ACK is held before Promise publication. Pause/Resume invoke the staged Backend, not popup UI. No focus allowance or changed production cleanup timeout." });
  let tab, attempted = false, installed = false, original, primary, relay;
  const control = method => bounded(worker.evaluate(`(()=>{const p=globalThis.__obuHoverHold;if(!p||p.id!==${JSON.stringify(id)})throw Error('Hover hold missing/replaced');return p[${JSON.stringify(method)}]()})()`), `hold ${method}`);
  const backend = (method, argument) => bounded(worker.evaluate(`(async()=>{const b=globalThis.__integrationBackend;if(!b)throw Error('Staged backend unavailable');try{return{ok:true,value:await b[${JSON.stringify(method)}](${argument === undefined ? "" : JSON.stringify(argument)})}}catch(error){return{ok:false,error:String(error?.message??error)}}})()`), method, 15000);
  try {
    tab = await browser.newTab(); detail.tabId = tab.id;
    await browser.cdp.navigate(tab.id, urls.root);
    const locator = tab.getByRole("button", { name: "Hover menu", exact: true }); assert.equal(await locator.textContent({ timeoutMs: 5000 }), "Hover menu");
    detail.scope = chooserScope(browser);
    relay = rpcRelay.arm(tab.id, detail.scope);
    detail.cleanupTimeoutMs = await worker.evaluate("globalThis.__integrationBackend.automationCleanupTimeoutMs");
    assert.equal(detail.cleanupTimeoutMs, 10000);
    installed = true;
    detail.installation = await bounded(worker.evaluate(`(()=>{if(Date.now()>=${Date.now() + 6500})throw Error('Hover hold setup expired');return (${installHoverAckHold.toString()})(chrome,globalThis,${JSON.stringify({ id, tabId: tab.id, scope: detail.scope, holdTimeoutMs: 30000 })})})()`), "hold install");
    detail.startedAt = Date.now();
    original = locator.hover({ timeoutMs: 1000 }).then(value => ({ ok: true, value, settledAt: Date.now() }), error => ({ ok: false, error: errorText(error), errorMessage: String(error?.message ?? error), settledAt: Date.now() }));
    await until(async () => (await control("snapshot")).held, "original hover native ACK held", 5000);
    detail.held = await control("snapshot"); detail.holdProof = checkHoverHold(detail.held);
    detail.original = await bounded(original, "original hover deadline", 4000); assert.equal(detail.original.ok, false); assert.match(detail.original.error, /timed out|timeout/i);
    detail.afterDeadline = await control("snapshot"); detail.relayProbe = relay.snapshot(); detail.wireTimeout = checkHoverWireTimeout(detail.afterDeadline, detail.original, detail.startedAt, detail.relayProbe);
    attempted = true; detail.pauseStartedAt = Date.now(); detail.pause = await backend("pauseAutomation"); detail.pauseSettledAt = Date.now();
    assert.equal(detail.pause.ok, false); assert.match(detail.pause.error, /OBU_AUTOMATION_PAUSE_FAILED/);
    detail.failed = await backend("getAutomationControlStatus"); assert.equal(detail.failed.ok, true); assert.equal(detail.failed.value.inputBlocked, true); assert.equal(detail.failed.value.cleanupComplete, false);
    detail.stillHeld = await control("snapshot"); detail.pauseDeadline = checkHoverPauseDeadline(detail);
    detail.prematureResume = await backend("resumeAutomation", detail.failed.value.revision); assert.equal(detail.prematureResume.ok, false);
    detail.released = await control("release");
    await until(async () => (await control("snapshot")).pending === 0, "original move publication drained", 5000);
    detail.retryPause = await backend("pauseAutomation"); assert.equal(detail.retryPause.ok, true); assert.equal(detail.retryPause.value.cleanupComplete, true);
    detail.resume = await backend("resumeAutomation", detail.retryPause.value.revision); assert.equal(detail.resume.ok, true); attempted = false;
    try { await browser.client.request("getTabs", detail.scope); assert.fail("The old hover scope was revived"); }
    catch (error) { detail.staleError = errorText(error); assert.match(detail.staleError, /STALE_CONTROL_EPOCH|CONTROL_BOOTSTRAP_REQUIRED|CONTROL_ENDED|expired/i); }
    detail.probe = await control("restore"); installed = false; detail.proof = checkHoverHold(detail.probe, { complete: true });
    await until(() => server.stats(key).posts[0]?.receipt, "original hover single receipt", 5000);
    detail.server = server.stats(key);
    detail.documents = await bounded(worker.evaluate(`chrome.scripting.executeScript({target:{tabId:${tab.id},frameIds:[0]},world:'MAIN',func:${readHoverEvidence.toString()}})`), "original fixture evidence");
    assert.equal(detail.documents.length, 1); detail.documentProof = checkHoverDocuments(detail, pauseSpec);
    detail.passed = true;
  } catch (error) { primary = error; detail.error = errorText(error); }
  finally {
    const cleanup = async (stage, operation) => { try { await operation(); } catch (error) { detail.cleanupErrors.push({ stage, error: errorText(error) }); primary ??= error; } };
    if (relay) await cleanup("stop-relay-observer", async () => {
      detail.relayProbe = relay.stop();
      // Do not let an early good snapshot hide duplicate/late responses or
      // observer overflow that occurred during Pause/Resume and cleanup.
      if (detail.passed) detail.finalWireTimeout = checkHoverRPCDeadline(detail.probe, detail.original, 1000, detail.startedAt, detail.relayProbe);
    });
    if (installed) await cleanup("release-original", () => control("release"));
    if (original) await cleanup("settle-original", () => bounded(original, "settle original"));
    if (installed) {
      await cleanup("actual-delivery-drain", () => until(async () => (await control("snapshot")).pending === 0, "original move cleanup drained", 5000));
      await cleanup("restore-observers", async () => { detail.finalProbe = await control("restore"); });
    }
    if (attempted) await cleanup("retry-Pause-Resume", async () => { const paused = await backend("pauseAutomation"); assert.equal(paused.ok, true); const resumed = await backend("resumeAutomation", paused.value.revision); assert.equal(resumed.ok, true); });
    if (tab) await cleanup("close-exact-fixture", async () => { await browser.client.beginTurn(`hover-cleanup-${id}`); await bounded(tab.close(), "close fixture"); });
    if (tab) await cleanup("native-tab-target-absence", async () => { detail.after = await exactCleanupEvidence(worker, [tab]); assert.deepEqual(detail.after.tabs, []); assert.deepEqual(detail.after.targets, []); });
    detail.server = server.stats(key);
    if (primary) { detail.passed = false; primary.hoverDeliveryDetail = detail; }
  }
  if (primary) throw primary;
  return detail;
}
