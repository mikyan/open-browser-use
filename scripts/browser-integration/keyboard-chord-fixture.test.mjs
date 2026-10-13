import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { listenFixture } from "./fixture-listener.mjs";
import { keyboardChordCases, invalidKeyboardChord, keyboardChordURLs, keyboardChordHTML, createKeyboardChordFixtures,
  installKeyboardChordEvidence, readKeyboardChordEvidence, installKeyboardChordProbe, checkKeyboardChordTrace, checkKeyboardChordDocuments } from "./keyboard-chord-fixture.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex"), tick = async () => { for (let index = 0; index < 10; index++) await Promise.resolve(); };
const keyFor = spec => `chord-0123456789abcdef0123456789abcdef-${spec.name}`;
const scope = { session_id: "chord-unit", turn_id: "original", control_epoch: 3 };
const phaseNames = spec => spec.effect === "plus" ? ["plus", "shift-plus"] : spec.effect === "raw-held-invalid" ? ["raw-hold", "invalid", "raw-release", "recovery"] : [spec.effect, "recovery"];
const commandRows = name => ({ invalid: [], partial: [["Control", "rawKeyDown", 2], ["Control", "keyUp", 0]], recovery: [["a", "keyDown", 0], ["a", "keyUp", 0]],
  plus: [["+", "keyDown", 0], ["+", "keyUp", 0]], "shift-plus": [["Shift", "rawKeyDown", 8], ["+", "keyDown", 8], ["+", "keyUp", 8], ["Shift", "keyUp", 0]],
  "raw-hold": [["Shift", "keyDown", 8]], "raw-release": [["Shift", "keyUp", 0]] })[name];
const keyCodes = { Control: "ControlLeft", Shift: "ShiftLeft", a: "KeyA", "+": "Equal" };
const keys = { invalid: invalidKeyboardChord, partial: "Control+a", recovery: "a", plus: "+", "shift-plus": "Shift++" };
const failure = name => name === "invalid" ? 'OBU_KEYBOARD_PRESS_INVALID: Unknown key: "DefinitelyNotAKey"' : "OBU_KEYBOARD_PRESS_UNCONFIRMED: keyboard fixture rejection after original Control ACK";

async function traceItem(spec) {
  const key = keyFor(spec), target = {}, api = { debugger: { sendCommand: () => Promise.resolve({ original: true }) } };
  const options = { id: "original-keyboard", tabId: 42, scope, failAfterControlACK: spec.effect === "partial" };
  runInNewContext(`(${installKeyboardChordProbe.toString()})`, { structuredClone, Promise })(api, target, options);
  const phases = [];
  for (const name of phaseNames(spec)) {
    target.__obuKeyboardChordProbe.setPhase(name); const raw = name.startsWith("raw-"), bad = ["invalid", "partial"].includes(name);
    const message = { id: `request-${name}`, method: "browserAction", params: { ...scope, tabId: 42, action: spec.api === "keyboard" ? "keyboard.press" : "press", args: { key: keys[name] }, timeoutMs: 1998,
      locator: spec.api === "keyboard" ? [] : [...(spec.layout === "root" ? [] : [{ kind: "frame", selector: "#chord-frame" }]), { kind: "label", value: "Original chord note", exact: true }] } };
    if (!raw) target.__integrationNativeRPCObserver("request", message);
    for (const [index, [key, type, modifiers]] of commandRows(name).entries()) {
      const params = { key, code: keyCodes[key], type, modifiers, ...(["+", "a"].includes(key) && type === "keyDown" ? { text: key } : {}) };
      const pending = api.debugger.sendCommand({ tabId: 42 }, "Input.dispatchKeyEvent", params);
      if (name === "partial" && index === 0) await assert.rejects(pending, /keyboard fixture rejection after original Control ACK/); else await pending;
    }
    await tick();
    if (!raw) target.__integrationNativeRPCObserver("response", { id: message.id, ...(bad ? { error: { message: failure(name) } } : { result: {} }) });
    phases.push({ name, outcome: bad ? { ok: false, errorMessage: failure(name) } : { ok: true }, ...(bad ? { observedThroughMs: 2250 } : {}) });
  }
  return { id: options.id, key, spec, tabId: 42, scope, timeoutMs: 2000, phases, probe: target.__obuKeyboardChordProbe.restore() };
}

// This unit DOM model verifies rejection/acceptance of the oracle only. Real
// trusted events, Chromium targets and original Promise ACKs come from run.mjs.
async function documentItem(spec) {
  const key = keyFor(spec), urls = keyboardChordURLs("http://127.0.0.1:1234/", key), listeners = new Map(), formListeners = new Map();
  const node = { id: "chord-target", isConnected: true, dataset: { token: `${key}-node` }, value: "" };
  let replacement;
  const form = { addEventListener(type, listener) { formListeners.set(type, listener); } };
  const doc = { activeElement: node, querySelector: selector => selector === "#chord-target" ? replacement ?? node : selector === "#chord-form" ? form : null,
    addEventListener(type, listener) { listeners.set(type, listener); } };
  const posts = [], sandbox = { document: doc, location: { href: urls.target }, crypto: { randomUUID: () => "original-doc-token" }, URLSearchParams, structuredClone,
    fetch: async (_url, options) => {
      const bytes = Buffer.from(options.body), receipt = { key, index: posts.length + 1, bodySHA256: hash(bytes) };
      posts.push({ method: "POST", bodyBytes: bytes.length, bodyBase64: bytes.toString("base64"), bodySHA256: hash(bytes), value: JSON.parse(options.body), receipt });
      return { ok: true, json: async () => receipt };
    } };
  runInNewContext(`(${installKeyboardChordEvidence.toString()})`, sandbox)(doc, spec, key);
  const native = { frameId: spec.layout === "root" ? 0 : 7, documentId: "native-original-document" };
  const read = () => [{ ...native, result: structuredClone(runInNewContext(`(${readKeyboardChordEvidence.toString()})()`, sandbox)) }];
  const emit = (type, extra = {}) => listeners.get(type)?.({ type, target: node, isTrusted: true, ...extra });
  emit("keydown", { key: "End", code: "End" }); emit("keyup", { key: "End", code: "End" }); const before = read(), phases = [];
  for (const name of phaseNames(spec)) {
    for (const [key, type, modifiers] of commandRows(name)) {
      emit(type === "keyUp" ? "keyup" : "keydown", { key, code: keyCodes[key], ctrlKey: Boolean(modifiers & 2), shiftKey: Boolean(modifiers & 8) });
      if (["a", "+"].includes(key) && type === "keyDown") {
        emit("beforeinput", { data: key, inputType: "insertText" }); node.value += key; emit("input", { data: key, inputType: "insertText" });
      }
    }
    phases.push({ name, after: read() });
  }
  emit("change"); emit("click", { target: { id: "submit-note" } }); formListeners.get("submit")({ isTrusted: true, preventDefault() {} }); await tick();
  const after = read(); replacement = { ...node }; const replaced = read();
  return { key, spec, targetURL: urls.target, before, phases, after, submit: { ok: true }, server: { key, posts }, replaced };
}
async function itemFor(spec) {
  const trace = await traceItem(spec), document = await documentItem(spec);
  return { ...trace, ...document, phases: trace.phases.map((phase, index) => ({ ...phase, ...document.phases[index] })) };
}

test("nine-case matrix covers both APIs, original OOPIF, plus grammar and explicit raw-held boundary", () => {
  assert.equal(keyboardChordCases.length, 9); assert.equal(new Set(keyboardChordCases.map(spec => spec.name)).size, 9);
  assert.equal(keyboardChordCases.filter(spec => spec.layout === "oopif").length, 2);
  for (const spec of keyboardChordCases) {
    const urls = keyboardChordURLs("http://127.0.0.1:1234/", keyFor(spec)), html = keyboardChordHTML(new URL(urls.root));
    assert.equal(new URL(urls.target).hostname, spec.layout === "root" ? "127.0.0.1" : "localhost");
    assert.match(html, /installKeyboardChordEvidence/); assert.doesNotMatch(html, /dispatchEvent\(|\.click\(\)|\.focus\(\)|\.value\s*=/);
  }
  assert.throws(() => keyboardChordURLs("http://127.0.0.1/", "invalid"));
});
for (const spec of keyboardChordCases) test(`wire/native/document/POST oracle: ${spec.name}`, async () => {
  const item = await itemFor(spec), trace = checkKeyboardChordTrace(item), document = checkKeyboardChordDocuments(item);
  assert.equal(trace.nativeDispatches, spec.effect === "plus" ? 6 : ["partial", "raw-held-invalid"].includes(spec.effect) ? 4 : 2);
  assert.equal(trace.controlledRejections, spec.effect === "partial" ? 1 : 0); assert.equal(document.posts, 1);
});

test("invalid phase rejects an early modifier, wrong RPC, wrong error and hidden replay", async () => {
  const item = await itemFor(keyboardChordCases[0]);
  for (const mutate of [
    value => { value.probe.records.find(row => row.kind === "request").message.params.args.key = "Control+a"; },
    value => { value.probe.records.find(row => row.kind === "request").message.params.control_epoch++; },
    value => { value.probe.records.find(row => row.kind === "request").message.params.locator = [{ kind: "css", selector: "#wrong" }]; },
    value => { value.probe.records.find(row => row.kind === "response").message.error.message = "different"; },
    value => { value.phases[0].outcome.ok = true; }, value => { value.phases[0].observedThroughMs = 2249; },
    value => { value.probe.pending = 1; }, value => { value.probe.overflow = true; }, value => { value.probe.restored = false; },
    value => { value.probe.errors.push("lost observation"); },
    value => { value.probe.records.push({ ...value.probe.records[1], sequence: value.probe.records.length + 1 }); },
    value => { value.probe.records.find(row => row.kind === "invoke").phase = "invalid"; },
    value => { value.probe.records.find(row => row.kind === "invoke").params.modifiers = 2; },
    value => { value.probe.records.find(row => row.kind === "invoke").params.text = ""; },
    value => { value.probe.records.find(row => row.kind === "settled").ok = false; }
  ]) { const invalid = structuredClone(item); mutate(invalid); assert.throws(() => checkKeyboardChordTrace(invalid)); }
});

test("partial proof requires the exact real ACK before one controlled rejection and release before response", async () => {
  const item = await itemFor(keyboardChordCases.find(spec => spec.effect === "partial"));
  for (const mutate of [
    value => { value.probe.injected = false; },
    value => { value.probe.records.find(row => row.kind === "controlled-rejection").invocation++; },
    value => { value.probe.records.find(row => row.kind === "settled").ok = false; },
    value => { value.probe.records.find(row => row.kind === "invoke").selected = false; },
    value => { value.probe.records.find(row => row.kind === "invoke" && row.params.type === "keyUp").params.key = "a"; },
    value => { value.probe.records.find(row => row.kind === "invoke" && row.params.type === "keyUp").params.type = "rawKeyDown"; },
    value => { const records = value.probe.records, ack = records.find(row => row.kind === "settled"), rejection = records.find(row => row.kind === "controlled-rejection"); [ack.kind, rejection.kind] = [rejection.kind, ack.kind]; },
    value => { const rows = value.probe.records, response = rows.findIndex(row => row.kind === "response"), release = rows.findIndex(row => row.kind === "invoke" && row.params.type === "keyUp"); [rows[response], rows[release]] = [rows[release], rows[response]]; rows.forEach((row, index) => { row.sequence = index + 1; }); }
  ]) { const invalid = structuredClone(item); mutate(invalid); assert.throws(() => checkKeyboardChordTrace(invalid)); }
});

test("document oracle requires invalid no-op, original unmodified a, exact host and one POST", async () => {
  const item = await itemFor(keyboardChordCases[0]);
  for (const mutate of [
    value => { value.phases[0].after[0].result.state.value = "wrong"; },
    value => { value.phases[0].after[0].result.state.activeOriginalNode = false; },
    value => { value.phases[1].after[0].result.evidence.events.find(event => event.key === "a").ctrl = true; },
    value => { value.phases[1].after[0].result.evidence.events.find(event => event.type === "input").trusted = false; },
    value => { value.phases[1].after[0].result.evidence.events.find(event => event.type === "input").data = "A"; },
    value => { value.phases[1].after[0].result.evidence.events.find(event => event.type === "input").originalNode = false; },
    value => { value.phases[1].after[0].documentId = "replacement"; },
    value => { value.after[0].result.evidence.nodeToken = "replacement"; },
    value => { value.after[0].result.evidence.overflow = true; }, value => { value.after[0].result.state.value = "wrong"; },
    value => { value.server.posts.push(value.server.posts[0]); }, value => { value.server.posts[0].bodyBase64 = Buffer.from("{}").toString("base64"); },
    value => { value.submit.ok = false; }, value => { value.after = value.replaced; }
  ]) { const invalid = structuredClone(item); mutate(invalid); assert.throws(() => checkKeyboardChordDocuments(invalid)); }
});

test("probe preserves unselected native Promise and receiver, restores descriptors, and rejects only after real ACK", async () => {
  let resolve; const originalPromise = new Promise(value => { resolve = value; }), calls = [], receiver = {}, target = {};
  const original = function (...args) { calls.push({ receiver: this, args }); return originalPromise; };
  const previous = function (...args) { calls.push({ rpcReceiver: this, args }); }; target.__integrationNativeRPCObserver = previous;
  const api = { debugger: { sendCommand: original } }, descriptor = Object.getOwnPropertyDescriptor(api.debugger, "sendCommand");
  installKeyboardChordProbe(api, target, { id: "probe", tabId: 42, scope, failAfterControlACK: true });
  target.__obuKeyboardChordProbe.setPhase("partial");
  assert.equal(api.debugger.sendCommand.call(receiver, { tabId: 99 }, "Input.dispatchKeyEvent", {}), originalPromise);
  assert.equal(api.debugger.sendCommand.call(receiver, { tabId: 42 }, "Runtime.evaluate", {}), originalPromise);
  const selected = api.debugger.sendCommand.call(receiver, { tabId: 42 }, "Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Control", code: "ControlLeft" });
  assert.notEqual(selected, originalPromise); assert.equal(calls.length, 3); assert.ok(calls.every(value => value.receiver === receiver));
  assert.equal(target.__obuKeyboardChordProbe.snapshot().pending, 1);
  assert.equal(target.__obuKeyboardChordProbe.snapshot().records.filter(row => row.kind === "controlled-rejection").length, 0);
  assert.throws(() => target.__obuKeyboardChordProbe.setPhase("recovery"), /Invalid keyboard probe phase/);
  resolve({ original: true }); await assert.rejects(selected, /after original Control ACK/); await tick();
  const proof = target.__obuKeyboardChordProbe.snapshot(); assert.deepEqual(proof.records.map(row => row.kind), ["phase", "invoke", "settled", "controlled-rejection"]); assert.equal(proof.pending, 0);
  target.__integrationNativeRPCObserver.call(receiver, "request", { method: "other", id: 1 }); assert.equal(calls.at(-1).rpcReceiver, receiver);
  target.__obuKeyboardChordProbe.restore(); assert.deepEqual(Object.getOwnPropertyDescriptor(api.debugger, "sendCommand"), descriptor);
  assert.equal(target.__integrationNativeRPCObserver, previous); assert.equal(target.__obuKeyboardChordProbe, undefined);
});

test("ordinary native rejection and unresolved command cannot masquerade as controlled ACK", async () => {
  const rejected = Promise.reject(Error("natural failure")); rejected.catch(() => {});
  const target = {}, api = { debugger: { sendCommand: () => rejected } };
  installKeyboardChordProbe(api, target, { id: "failed", tabId: 42, scope }); target.__obuKeyboardChordProbe.setPhase("recovery");
  assert.equal(api.debugger.sendCommand({ tabId: 42 }, "Input.dispatchKeyEvent", { type: "keyDown", key: "a" }), rejected); await tick();
  const proof = target.__obuKeyboardChordProbe.restore(); assert.equal(proof.records.at(-1).ok, false); assert.equal(proof.injected, false); assert.equal(proof.pending, 0);
  const pendingTarget = {}, pendingAPI = { debugger: { sendCommand: () => new Promise(() => {}) } };
  installKeyboardChordProbe(pendingAPI, pendingTarget, { id: "pending", tabId: 42, scope }); pendingTarget.__obuKeyboardChordProbe.setPhase("recovery");
  for (let index = 0; index < 260; index++) pendingAPI.debugger.sendCommand({ tabId: 42 }, "Input.dispatchKeyEvent", { type: "keyDown", key: "a" });
  const unresolved = pendingTarget.__obuKeyboardChordProbe.restore(); assert.equal(unresolved.records.length, 256); assert.equal(unresolved.overflow, true); assert.equal(unresolved.pending, 260);
});

test("fixture server records exact original POST bytes and rejects malformed keys", async t => {
  const fixture = createKeyboardChordFixtures(); let base;
  const server = http.createServer((request, response) => { if (!fixture.handle(request, response, new URL(request.url, base))) { response.writeHead(404); response.end(); } });
  const port = await listenFixture(server); base = `http://127.0.0.1:${port}/`; t.after(() => new Promise(resolve => server.close(resolve)));
  const key = keyFor(keyboardChordCases[0]), urls = keyboardChordURLs(base, key);
  assert.equal((await fetch(urls.root)).status, 200); assert.equal((await fetch(new URL("keyboard-chord/page?key=bad", base))).status, 400);
  const body = JSON.stringify({ key, note: "Original π 日本語" }), response = await fetch(new URL(`keyboard-chord/post?key=${key}`, base), { method: "POST", body });
  assert.equal(response.status, 200); const receipt = await response.json(), post = fixture.stats(key).posts[0];
  assert.equal(post.bodyBytes, Buffer.byteLength(body)); assert.equal(post.bodySHA256, hash(Buffer.from(body))); assert.equal(Buffer.from(post.bodyBase64, "base64").toString(), body);
  assert.equal(receipt.bodySHA256, post.bodySHA256); assert.equal(fixture.stats(key).gets.length, 1); assert.equal(fixture.allStats().length, 1);
});
