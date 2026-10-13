import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { listenFixture } from "./fixture-listener.mjs";
import { keyboardChordCases, invalidKeyboardChord, keyboardChordURLs, keyboardChordHTML, createKeyboardChordFixtures,
  installKeyboardChordEarlyEvidence, installKeyboardChordEvidence, readKeyboardChordEvidence, installKeyboardChordProbe, checkKeyboardChordTrace,
  checkKeyboardChordSetup, checkKeyboardChordDocuments, checkKeyboardChords } from "./keyboard-chord-fixture.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex"), tick = async () => { for (let index = 0; index < 10; index++) await Promise.resolve(); };
const keyFor = spec => `chord-0123456789abcdef0123456789abcdef-${spec.name}`;
const scope = { session_id: "chord-unit", turn_id: "original", control_epoch: 3 };
const phaseNames = spec => spec.effect === "plus" ? ["plus", "shift-plus"] : spec.effect === "raw-held-invalid" ? ["raw-hold", "invalid", "raw-release", "recovery"] : [spec.effect, "recovery"];
const commandRows = name => ({ setup: [["End", "rawKeyDown", 0], ["End", "keyUp", 0]], invalid: [], partial: [["Control", "rawKeyDown", 2], ["Control", "keyUp", 0]], recovery: [["a", "keyDown", 0], ["a", "keyUp", 0]],
  plus: [["+", "keyDown", 0], ["+", "keyUp", 0]], "shift-plus": [["Shift", "rawKeyDown", 8], ["+", "keyDown", 8], ["+", "keyUp", 8], ["Shift", "keyUp", 0]],
  "raw-hold": [["Shift", "keyDown", 8]], "raw-release": [["Shift", "keyUp", 0]] })[name];
const keyCodes = { End: "End", Control: "ControlLeft", Shift: "ShiftLeft", a: "KeyA", "+": "Equal" };
const keys = { setup: "End", invalid: invalidKeyboardChord, partial: "Control+a", recovery: "a", plus: "+", "shift-plus": "Shift++" };
const failure = name => name === "invalid" ? 'OBU_KEYBOARD_PRESS_INVALID: Unknown key: "DefinitelyNotAKey"' : "OBU_KEYBOARD_PRESS_UNCONFIRMED: keyboard fixture rejection after original Control ACK";

async function traceItem(spec) {
  const key = keyFor(spec), target = {}, api = { debugger: { sendCommand: () => Promise.resolve({ original: true }) } };
  const options = { id: "original-keyboard", tabId: 42, scope, failAfterControlACK: spec.effect === "partial" };
  runInNewContext(`(${installKeyboardChordProbe.toString()})`, { structuredClone, Promise })(api, target, options);
  const phases = [];
  for (const name of ["setup", ...phaseNames(spec)]) {
    target.__obuKeyboardChordProbe.setPhase(name); const raw = name.startsWith("raw-"), bad = ["invalid", "partial"].includes(name);
    const keyboard = name !== "setup" && spec.api === "keyboard";
    const message = { id: `request-${name}`, method: "browserAction", params: { ...scope, tabId: 42, action: keyboard ? "keyboard.press" : "press", args: { key: keys[name] }, timeoutMs: 1998,
      locator: keyboard ? [] : [...(spec.layout === "root" ? [] : [{ kind: "frame", selector: "#chord-frame" }]), { kind: "label", value: "Original chord note", exact: true }] } };
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
  const setup = { ...phases.shift(), timeoutMs: 5000 };
  return { id: options.id, key, spec, tabId: 42, scope, timeoutMs: 2000, setup, phases, probe: target.__obuKeyboardChordProbe.restore() };
}

// This unit DOM model verifies rejection/acceptance of the oracle only. Real
// trusted events, Chromium targets and original Promise ACKs come from run.mjs.
async function documentItem(spec, { earlyEndDown = false, key: suppliedKey } = {}) {
  const key = suppliedKey ?? keyFor(spec), urls = keyboardChordURLs("http://127.0.0.1:1234/", key), listeners = new Map(), formListeners = new Map();
  const node = { id: "chord-target", nodeName: "INPUT", isConnected: true, dataset: { token: `${key}-node` }, value: "" };
  let replacement;
  const form = { addEventListener(type, listener) { formListeners.set(type, listener); } };
  const add = (map, type, listener) => { if (!map.has(type)) map.set(type, []); map.get(type).push(listener); };
  const windowListeners = new Map(), view = { addEventListener(type, listener) { add(windowListeners, type, listener); } };
  const doc = { defaultView: view, readyState: "loading", visibilityState: "visible", hasFocus: () => true, activeElement: null, querySelector: selector => selector === "#chord-target" ? replacement ?? node : selector === "#chord-form" ? form : null,
    addEventListener(type, listener) { add(listeners, type, listener); } };
  let clock = 0;
  const posts = [], sandbox = { document: doc, performance: { timeOrigin: 1700000000000, now: () => ++clock }, location: { href: urls.target }, crypto: { randomUUID: () => "original-doc-token" }, URLSearchParams, structuredClone,
    fetch: async (_url, options) => {
      const bytes = Buffer.from(options.body), receipt = { key, index: posts.length + 1, bodySHA256: hash(bytes) };
      posts.push({ method: "POST", bodyBytes: bytes.length, bodyBase64: bytes.toString("base64"), bodySHA256: hash(bytes), value: JSON.parse(options.body), receipt });
      return { ok: true, json: async () => receipt };
    } };
  const emit = (type, extra = {}) => { for (const listener of listeners.get(type) ?? []) listener({ type, target: node, isTrusted: true, ...extra }); };
  runInNewContext(`(${installKeyboardChordEarlyEvidence.toString()})`, sandbox)(doc, key);
  if (earlyEndDown) emit("keydown", { key: "End", code: "End" });
  runInNewContext(`(${installKeyboardChordEvidence.toString()})`, sandbox)(doc, spec, key);
  const native = { frameId: spec.layout === "root" ? 0 : 7, documentId: "native-original-document" };
  const read = () => [{ ...native, result: structuredClone(runInNewContext(`(${readKeyboardChordEvidence.toString()})()`, sandbox)) }];
  const setupBefore = read(); doc.activeElement = node;
  emit("focus", { relatedTarget: null }); emit("focusin", { relatedTarget: null });
  if (!earlyEndDown) emit("keydown", { key: "End", code: "End" });
  emit("keyup", { key: "End", code: "End" }); const before = read(), phases = [];
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
  return { key, spec, targetURL: urls.target, setup: { before: setupBefore, after: before }, before, phases, after, submit: { ok: true }, server: { key, posts }, replaced };
}
async function itemFor(spec) {
  const trace = await traceItem(spec), document = await documentItem(spec);
  return { ...trace, ...document, setup: { ...trace.setup, ...document.setup }, phases: trace.phases.map((phase, index) => ({ ...phase, ...document.phases[index] })) };
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
  assert.equal(trace.nativeDispatches, 2 + (spec.effect === "plus" ? 6 : ["partial", "raw-held-invalid"].includes(spec.effect) ? 4 : 2));
  assert.equal(trace.controlledRejections, spec.effect === "partial" ? 1 : 0); assert.equal(document.posts, 1);
});

test("setup requires the original locator RPC, both native ACKs and the unchanged bottom listener prefix", async () => {
  const item = await itemFor(keyboardChordCases[0]);
  assert.equal(checkKeyboardChordSetup(item).nativeDispatches, 2);
  for (const mutate of [
    value => { value.probe.records.find(row => row.kind === "request").message.params.action = "keyboard.press"; },
    value => { value.probe.records.find(row => row.kind === "invoke").params.key = "Home"; },
    value => { value.probe.records.find(row => row.kind === "settled").ok = false; },
    value => { value.probe.records.find(row => row.kind === "invoke").selected = true; },
    value => { value.probe.records.find(row => row.kind === "settled").invocation++; },
    value => { const rows = value.probe.records, firstACK = rows.findIndex(row => row.kind === "settled"), up = rows.findIndex(row => row.kind === "invoke" && row.params.type === "keyUp");
      [rows[firstACK], rows[up]] = [rows[up], rows[firstACK]]; rows.forEach((row, index) => { row.sequence = index + 1; }); },
    value => { value.before[0].result.evidence.events.shift(); },
    value => { value.before[0].result.evidence.early.overflow = true; },
    value => { value.before[0].result.evidence.focusEvents[0].order = 100; },
    value => { value.before[0].result.evidence.listenerInstallation.state.originalNodePresent = false; }
  ]) { const invalid = structuredClone(item); mutate(invalid); assert.throws(() => checkKeyboardChordSetup(invalid)); }
  // Later business failure cannot erase independently verified setup evidence.
  item.phases = []; item.probe.pending = 1;
  assert.equal(checkKeyboardChordSetup(item).nativeDispatches, 2);
});

test("head records a pre-install End down but never substitutes it into the strict original listener oracle", async () => {
  const spec = keyboardChordCases[0], original = await documentItem(spec, { earlyEndDown: true });
  const evidence = original.before[0].result.evidence;
  assert.deepEqual(evidence.events.map(row => [row.type, row.key]), [["keyup", "End"]]);
  const down = evidence.early.events.find(row => row.type === "keydown"), installed = evidence.early.events.find(row => row.kind === "listeners-installed");
  assert.ok(down.sequence < installed.sequence && down.at < installed.at);
  assert.deepEqual(evidence.early.events.filter(row => ["keydown", "keyup"].includes(row.type)).map(row => row.key), ["End", "End"]);
  assert.throws(() => checkKeyboardChordDocuments(original));
});

test("setup failure preserves the original error, observes End before navigation, restores the probe and closes the exact tab", async () => {
  const calls = [], originalError = Error("original setup failure after both ACKs"), originalSend = () => Promise.resolve({});
  let closed = false, url = "about:blank", reads = 0;
  const sandbox = { Promise, structuredClone, chrome: {
    debugger: { sendCommand: originalSend, getTargets: async () => closed ? [] : [{ id: "original-target", tabId: 42, type: "page", attached: true }] },
    tabs: { get: async () => ({ id: 42, url, active: false }), query: async () => closed ? [] : [{ id: 42 }] },
    webNavigation: { getAllFrames: async () => [{ frameId: 0, documentId: "original-document", url, documentLifecycle: "active", errorOccurred: false }] },
    scripting: { executeScript: async () => { reads++; return [{ documentId: "original-document", frameId: 0, result: { href: url } }]; } }
  } };
  const worker = { evaluate: async source => { calls.push("worker"); return structuredClone(await runInNewContext(source, sandbox)); } };
  const locator = { press: async (key, options) => {
    calls.push("End"); assert.equal(reads, 0, "No readiness read was inserted before End"); assert.deepEqual(options, { timeoutMs: 5000 }); assert.equal(key, "End");
    assert.ok(sandbox.__obuKeyboardChordProbe); assert.equal(sandbox.__obuKeyboardChordProbe.snapshot().records[0].phase, "setup");
    const message = { id: "original-setup", method: "browserAction", params: { ...scope, tabId: 42, action: "press", locator: [{ kind: "label", value: "Original chord note", exact: true }], args: { key }, timeoutMs: 4999 } };
    sandbox.__integrationNativeRPCObserver("request", message);
    for (const type of ["rawKeyDown", "keyUp"]) await sandbox.chrome.debugger.sendCommand({ tabId: 42 }, "Input.dispatchKeyEvent", { key, code: "End", modifiers: 0, type });
    sandbox.__integrationNativeRPCObserver("response", { id: message.id, error: { message: originalError.message } });
    throw originalError;
  } };
  const tab = { id: 42, getByLabel: () => locator, locator: selector => ({ textContent: async () => {
    calls.push(selector); return selector === "h1" ? "Original keyboard chord fixture" : "Submit original chord note";
  } }), close: async () => { calls.push("close-42"); assert.equal(sandbox.__obuKeyboardChordProbe, undefined); closed = true; } };
  const browser = { client: { sessionId: scope.session_id, turnId: scope.turn_id, controlEpoch: scope.control_epoch }, newTab: async () => tab,
    cdp: { navigate: async (_id, targetURL) => { assert.ok(sandbox.__obuKeyboardChordProbe); calls.push("navigate"); url = targetURL; } } };
  const detail = {};
  await assert.rejects(checkKeyboardChords({ browser, worker, fixtureURL: "http://127.0.0.1:1234/", server: { stats: () => ({ posts: [] }), allStats: () => [] }, until: async () => {}, detail }), error => error === originalError);
  assert.deepEqual(calls.slice(0, 5), ["worker", "navigate", "h1", "#submit-note", "End"]);
  const item = detail.cases[0]; assert.equal(item.setup.outcome.errorMessage, originalError.message); assert.equal(item.probe.restored, true);
  assert.deepEqual(item.probe.records.map(row => row.kind), ["phase", "request", "invoke", "settled", "invoke", "settled", "response"]);
  assert.match(item.setup.nativeProofError, /false !== true/); assert.equal(item.setup.afterFailure[0].documentId, "original-document");
  assert.equal(sandbox.chrome.debugger.sendCommand, originalSend); assert.equal(closed, true); assert.equal(calls.filter(value => value === "close-42").length, 1);
  assert.deepEqual(detail.cleanup.tabIds, [42]); assert.deepEqual(detail.cleanup.tabs, []); assert.deepEqual(detail.cleanup.targets, []); assert.equal(detail.cleanup.probePresent, false);
});

test("missing setup DOM down still follows the original single submit and receipt path before failing", async () => {
  // This executes the real orchestration with a unit native/DOM model. It does
  // not stand in for trusted browser delivery or real HTTP acceptance.
  let closed = false, url = "about:blank", model, current, submitted = 0, receipts = 0;
  const posted = [], calls = [], sandbox = { Promise, structuredClone, chrome: {
    debugger: { sendCommand: () => Promise.resolve({}), getTargets: async () => closed ? [] : [{ id: "original-target", tabId: 42, type: "page", attached: true }] },
    tabs: { get: async () => ({ id: 42, url, active: false, windowId: 4, groupId: 7, pinned: false }), query: async () => closed ? [] : [{ id: 42 }] },
    webNavigation: { getAllFrames: async () => [{ frameId: 0, documentId: "native-original-document", url, documentLifecycle: "active", errorOccurred: false }] },
    scripting: { executeScript: async () => structuredClone(current) }
  } };
  const worker = { evaluate: async source => structuredClone(await runInNewContext(source, sandbox)) };
  const press = async (key, options) => {
    calls.push(key); const name = key === "End" ? "setup" : key === invalidKeyboardChord ? "invalid" : "recovery", bad = name === "invalid";
    const message = { id: `original-${name}`, method: "browserAction", params: { ...scope, tabId: 42,
      action: name === "setup" ? "press" : "keyboard.press", args: { key }, timeoutMs: options.timeoutMs - 1,
      locator: name === "setup" ? [{ kind: "label", value: "Original chord note", exact: true }] : [] } };
    sandbox.__integrationNativeRPCObserver("request", message);
    for (const [nativeKey, type, modifiers] of commandRows(name)) await sandbox.chrome.debugger.sendCommand({ tabId: 42 }, "Input.dispatchKeyEvent",
      { key: nativeKey, code: keyCodes[nativeKey], type, modifiers, ...(nativeKey === "a" && type === "keyDown" ? { text: "a" } : {}) });
    sandbox.__integrationNativeRPCObserver("response", { id: message.id, ...(bad ? { error: { message: failure(name) } } : { result: {} }) });
    current = name === "setup" ? model.before : model.phases[name === "invalid" ? 0 : 1].after;
    if (bad) throw Error(failure(name));
  };
  const tab = { id: 42, keyboard: { press }, getByLabel: () => ({ press }),
    locator: selector => ({ textContent: async () => selector === "h1" ? "Original keyboard chord fixture" : "Submit original chord note" }),
    getByRole: () => ({ click: async () => {
      assert.equal(sandbox.__obuKeyboardChordProbe, undefined, "Submission keeps the original post-probe position");
      submitted++; calls.push("submit"); posted.push(structuredClone(model.server.posts[0])); current = model.after;
    } }), close: async () => { closed = true; } };
  const browser = { client: { sessionId: scope.session_id, turnId: scope.turn_id, controlEpoch: scope.control_epoch }, newTab: async () => tab,
    cdp: { navigate: async (_id, targetURL) => { url = targetURL; model = await documentItem(keyboardChordCases[0], { earlyEndDown: true, key: new URL(url).searchParams.get("key") }); current = model.before; } } };
  const server = { stats: key => ({ key, posts: structuredClone(posted) }), allStats: () => [{ posts: structuredClone(posted) }] }, detail = {};
  await assert.rejects(checkKeyboardChords({ browser, worker, fixtureURL: "http://127.0.0.1:1234/", server,
    until: async predicate => { assert.ok(predicate()); receipts++; }, detail }), /deep-equal/);
  const item = detail.cases[0]; assert.equal(item.setup.nativeProof.nativeDispatches, 2); assert.ok(item.setup.proofError);
  assert.equal(item.traceProof.nativeDispatches, 4); assert.deepEqual(calls, ["End", invalidKeyboardChord, "a", "submit"]);
  assert.equal(submitted, 1); assert.equal(receipts, 1); assert.equal(item.submit.ok, true); assert.equal(item.server.posts.length, 1);
  assert.equal(item.server.posts[0].bodySHA256, model.server.posts[0].bodySHA256); assert.equal(item.server.posts[0].value.value, "a");
  assert.deepEqual(item.after[0].result.evidence.events.filter(row => row.key === "End").map(row => row.type), ["keyup"]);
  assert.ok(item.evidenceError); assert.equal(item.passed, false); assert.equal(detail.passed, false); assert.equal(closed, true);
  assert.equal(detail.cleanup.probePresent, false); assert.deepEqual(detail.cleanup.tabs, []); assert.deepEqual(detail.cleanup.targets, []);
});

test("invalid phase rejects an early modifier, wrong RPC, wrong error and hidden replay", async () => {
  const item = await itemFor(keyboardChordCases[0]);
  for (const mutate of [
    value => { value.probe.records.find(row => row.kind === "request" && row.phase === "invalid").message.params.args.key = "Control+a"; },
    value => { value.probe.records.find(row => row.kind === "request" && row.phase === "invalid").message.params.control_epoch++; },
    value => { value.probe.records.find(row => row.kind === "request" && row.phase === "invalid").message.params.locator = [{ kind: "css", selector: "#wrong" }]; },
    value => { value.probe.records.find(row => row.kind === "response" && row.phase === "invalid").message.error.message = "different"; },
    value => { value.phases[0].outcome.ok = true; }, value => { value.phases[0].observedThroughMs = 2249; },
    value => { value.probe.pending = 1; }, value => { value.probe.overflow = true; }, value => { value.probe.restored = false; },
    value => { value.probe.errors.push("lost observation"); },
    value => { value.probe.records.push({ ...value.probe.records.find(row => row.kind === "request" && row.phase === "invalid"), sequence: value.probe.records.length + 1 }); },
    value => { value.probe.records.find(row => row.kind === "invoke" && row.phase === "recovery").phase = "invalid"; },
    value => { value.probe.records.find(row => row.kind === "invoke" && row.phase === "recovery").params.modifiers = 2; },
    value => { value.probe.records.find(row => row.kind === "invoke" && row.phase === "recovery").params.text = ""; },
    value => { value.probe.records.find(row => row.kind === "settled" && row.phase === "recovery").ok = false; }
  ]) { const invalid = structuredClone(item); mutate(invalid); assert.throws(() => checkKeyboardChordTrace(invalid)); }
});

test("partial proof requires the exact real ACK before one controlled rejection and release before response", async () => {
  const item = await itemFor(keyboardChordCases.find(spec => spec.effect === "partial"));
  for (const mutate of [
    value => { value.probe.injected = false; },
    value => { value.probe.records.find(row => row.kind === "controlled-rejection").invocation++; },
    value => { value.probe.records.find(row => row.kind === "settled" && row.phase === "partial").ok = false; },
    value => { value.probe.records.find(row => row.kind === "invoke" && row.phase === "partial").selected = false; },
    value => { value.probe.records.find(row => row.kind === "invoke" && row.phase === "partial" && row.params.type === "keyUp").params.key = "a"; },
    value => { value.probe.records.find(row => row.kind === "invoke" && row.phase === "partial" && row.params.type === "keyUp").params.type = "rawKeyDown"; },
    value => { const records = value.probe.records, ack = records.find(row => row.kind === "settled" && row.phase === "partial"), rejection = records.find(row => row.kind === "controlled-rejection"); [ack.kind, rejection.kind] = [rejection.kind, ack.kind]; },
    value => { const rows = value.probe.records, response = rows.findIndex(row => row.kind === "response" && row.phase === "partial"), release = rows.findIndex(row => row.kind === "invoke" && row.phase === "partial" && row.params.type === "keyUp"); [rows[response], rows[release]] = [rows[release], rows[response]]; rows.forEach((row, index) => { row.sequence = index + 1; }); }
  ]) { const invalid = structuredClone(item); mutate(invalid); assert.equal(checkKeyboardChordSetup(invalid).nativeDispatches, 2); assert.throws(() => checkKeyboardChordTrace(invalid)); }
});

test("partial injection remains inert during setup and rejects only its named partial phase", async () => {
  const native = Promise.resolve({ original: true }), target = {}, api = { debugger: { sendCommand: () => native } };
  installKeyboardChordProbe(api, target, { id: "phase-bound", tabId: 42, scope, failAfterControlACK: true });
  const command = { type: "rawKeyDown", key: "Control", code: "ControlLeft" };
  target.__obuKeyboardChordProbe.setPhase("setup");
  assert.equal(api.debugger.sendCommand({ tabId: 42 }, "Input.dispatchKeyEvent", command), native); await tick();
  assert.equal(target.__obuKeyboardChordProbe.snapshot().injected, false);
  target.__obuKeyboardChordProbe.setPhase("partial");
  await assert.rejects(api.debugger.sendCommand({ tabId: 42 }, "Input.dispatchKeyEvent", command), /after original Control ACK/);
  const proof = target.__obuKeyboardChordProbe.restore();
  assert.deepEqual(proof.records.filter(row => row.kind === "controlled-rejection").map(row => row.phase), ["partial"]);
  assert.ok(proof.records.every(row => Number.isSafeInteger(row.at)));
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
