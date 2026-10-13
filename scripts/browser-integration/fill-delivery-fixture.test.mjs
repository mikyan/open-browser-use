import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { listenFixture } from "./fixture-listener.mjs";
import { fillDeliveryCases, fillCompatibilityCases, fillDeliveryURLs, fillDeliveryValue, fillDeliveryHTML, createFillDeliveryFixtures,
  installFillEvidence, readFillEvidence, installFillProbe, checkFillTrace, checkFillDocuments, checkFillOOPIF } from "./fill-delivery-fixture.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const tick = async () => { for (let index = 0; index < 10; index++) await Promise.resolve(); };
const keyFor = spec => `fill-0123456789abcdef0123456789abcdef-${spec.name}`;
const scope = { session_id: "fill-unit", turn_id: "original", control_epoch: 3 };
const errorMessage = "OBU_FILL_DELIVERY_UNCONFIRMED: original edit was not observed";
const failureSpec = spec => ["drop", "cancel"].includes(spec.effect);

async function traceItem(spec) {
  const key = keyFor(spec), text = fillDeliveryValue(key), target = {}, api = { debugger: { sendCommand: () => Promise.resolve({}) } };
  const options = { id: "original-fill", tabId: 42, scope, text, drop: spec.effect === "drop" };
  const install = runInNewContext(`(${installFillProbe.toString()})`, { structuredClone, Promise }); install(api, target, options);
  const locator = spec.editor === "contenteditable" ? { kind: "css", selector: "#fill-target" } : { kind: "label", value: "Original delivery note", exact: true };
  const message = { id: "fill-1", method: "browserAction", params: { ...scope, tabId: 42, action: "fill", args: { value: text }, timeoutMs: 1998,
    locator: [...(spec.layout === "root" ? [] : [{ kind: "frame", selector: "#fill-frame" }]), locator] } };
  target.__integrationNativeRPCObserver("request", message);
  if (["clear", "empty"].includes(spec.editor)) {
    await api.debugger.sendCommand({ tabId: 42 }, "Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Delete", code: "Delete", modifiers: 0 });
    await api.debugger.sendCommand({ tabId: 42 }, "Input.dispatchKeyEvent", { type: "keyUp", key: "Delete", code: "Delete", modifiers: 0 });
  } else if (spec.editor !== "date") await api.debugger.sendCommand({ tabId: 42 }, "Input.insertText", { text });
  await tick();
  target.__integrationNativeRPCObserver("response", { id: message.id, ...(failureSpec(spec) ? { error: { message: errorMessage } } : { result: {} }) });
  return { id: options.id, key, tabId: 42, scope, spec, timeoutMs: 2000, observedThroughMs: 2250,
    outcome: failureSpec(spec) ? { ok: false, errorMessage } : { ok: true }, probe: target.__obuFillProbe.restore() };
}

// This DOM model tests the oracle only. Trusted flags are modeled, never
// claimed as real-browser evidence; the browser run supplies independent events.
async function documentItem(spec, { emptyBeforeInput = false, singleTextareaInput = false, removeEditableNode = true, replaceEditableHost = false } = {}) {
  const key = keyFor(spec), urls = fillDeliveryURLs("http://127.0.0.1:1234/", key), documentListeners = new Map(), nodeListeners = new Map(), formListeners = new Map();
  const seed = spec.editor === "empty" ? "" : spec.editor === "date" ? "2024-01-02" : `seed:${key}`;
  let removed = false, replacementHost;
  const textNode = {}, node = { id: "fill-target", isConnected: true, dataset: { token: `${key}-node` }, value: seed, contains: value => value === textNode,
    addEventListener(type, listener) { nodeListeners.set(type, listener); } };
  const host = spec.editor === "contenteditable" ? { id: "editing-host", isConnected: true, dataset: { token: `${key}-host` }, textContent: seed } : node;
  const form = { addEventListener(type, listener) { formListeners.set(type, listener); } };
  const doc = { activeElement: host, querySelector(selector) { return selector === "#fill-target" ? removed ? null : node : selector === "#editing-host" && host !== node ? replacementHost ?? host : selector === "#fill-form" ? form : null; },
    addEventListener(type, listener, options) { if (!documentListeners.has(type)) documentListeners.set(type, []); documentListeners.get(type).push({ listener, capture: options?.capture === true }); } };
  const posts = [], sandbox = { document: doc, location: { href: urls.target }, crypto: { randomUUID: () => "original-document-token" }, structuredClone, URLSearchParams,
    fetch: async (_url, options) => {
      const bytes = Buffer.from(options.body), receipt = { key, index: posts.length + 1, bodySHA256: hash(bytes) };
      posts.push({ method: "POST", bodyBytes: bytes.length, bodyBase64: bytes.toString("base64"), bodySHA256: hash(bytes), value: JSON.parse(options.body), receipt });
      return { ok: true, json: async () => receipt };
    } };
  runInNewContext(`(${installFillEvidence.toString()})`, sandbox)(doc, spec, key, urls.target);
  const read = () => structuredClone(runInNewContext(`(${readFillEvidence.toString()})()`, sandbox));
  const native = { frameId: spec.layout === "root" ? 0 : 7, documentId: "native-original-document" };
  const before = [{ ...native, result: read() }];
  const emit = (type, extra = {}) => {
    const event = { type, target: host, isTrusted: true, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...extra };
    for (const item of documentListeners.get(type) ?? []) if (item.capture) item.listener(event);
    if (host === node) nodeListeners.get(type)?.(event);
    for (const item of documentListeners.get(type) ?? []) if (!item.capture) item.listener(event);
    return event;
  };
  const deletion = ["clear", "empty"].includes(spec.editor);
  if (deletion) emit("keydown", { key: "Delete" });
  if (spec.editor === "empty" && emptyBeforeInput) emit("beforeinput", { inputType: "deleteContentForward", data: null });
  if (spec.editor === "date") {
    node.value = fillDeliveryValue(key); emit("input", { isTrusted: false }); emit("change", { isTrusted: false });
  } else if (spec.effect !== "drop" && spec.editor !== "empty") {
    const input = { inputType: deletion ? "deleteContentForward" : "insertText", data: deletion ? null : fillDeliveryValue(key) };
    const beforeInput = emit("beforeinput", { ...input, ...(host !== node ? { getTargetRanges: () => [{ startContainer: textNode, endContainer: textNode, startOffset: 0, endOffset: seed.length }] } : {}) });
    if (!beforeInput.defaultPrevented) {
      if (host === node) node.value = fillDeliveryValue(key); else host.textContent = fillDeliveryValue(key);
      if (spec.editor === "textarea" && !singleTextareaInput) {
        const lines = fillDeliveryValue(key).split("\n");
        for (const data of [lines[0], null, lines[1]]) emit("input", { ...input, data });
      } else emit("input", input);
      if (host !== node && removeEditableNode) { removed = true; node.isConnected = false; }
      if (host !== node && replaceEditableHost) { replacementHost = { ...host }; host.isConnected = false; }
    }
  }
  if (deletion) emit("keyup", { key: "Delete" });
  if (!failureSpec(spec)) {
    emit("click", { target: { id: "submit-note" } }); formListeners.get("submit")({ isTrusted: true, preventDefault() {} }); await tick();
  }
  return { key, spec, targetURL: urls.target, before, after: [{ ...native, result: read() }],
    ...(failureSpec(spec) ? {} : { submit: { ok: true } }), server: { key, posts } };
}

test("matrix preserves all four behaviors across root, existing and dynamic OOPIF", () => {
  assert.equal(fillDeliveryCases.length, 12); assert.equal(new Set(fillDeliveryCases.map(value => value.name)).size, 12);
  for (const layout of ["root", "oopif", "dynamic-oopif"]) assert.deepEqual(fillDeliveryCases.filter(value => value.layout === layout).map(value => value.effect), ["normal", "transform", "cancel", "drop"]);
  for (const spec of fillDeliveryCases) {
    const urls = fillDeliveryURLs("http://127.0.0.1:1234/", keyFor(spec)), html = fillDeliveryHTML(new URL(urls.root));
    assert.ok(html.includes("installFillEvidence")); assert.ok(!html.includes("dispatchEvent(") && !html.includes(".click()"));
    assert.equal(new URL(urls.target).hostname, spec.layout === "root" ? "127.0.0.1" : "localhost");
    if (spec.layout === "dynamic-oopif") { assert.match(html, /id="add-frame"/); assert.doesNotMatch(html, /<iframe/); }
  }
  assert.throws(() => fillDeliveryHTML(new URL("http://127.0.0.1/fill-delivery/page?key=invalid")));
});
for (const spec of fillDeliveryCases) test(`original wire/native and exact document/POST proof: ${spec.name}`, async () => {
  const item = { ...await traceItem(spec), ...await documentItem(spec) };
  assert.equal(checkFillTrace(item).nativeDispatches, spec.effect === "drop" ? 0 : 1);
  assert.equal(checkFillDocuments(item).posts, failureSpec(spec) ? 0 : 1);
});
for (const spec of fillCompatibilityCases) test(`shared original wire/document oracle preserves compatibility: ${spec.name}`, async () => {
  const item = { ...await traceItem(spec), ...await documentItem(spec) }, native = checkFillTrace(item), document = checkFillDocuments(item);
  assert.equal(document.posts, 1); assert.equal(native.nativeDispatches, spec.editor === "date" ? 0 : ["clear", "empty"].includes(spec.editor) ? 2 : 1);
  assert.equal(document.inputs, spec.editor === "empty" ? 0 : spec.editor === "textarea" ? 3 : 1);
});

test("compatibility matrix retains native Delete, editing-host range and direct-setter distinctions", async () => {
  assert.deepEqual(fillCompatibilityCases.map(value => value.editor), ["textarea", "contenteditable", "clear", "empty", "date"]);
  const itemFor = async editor => { const spec = fillCompatibilityCases.find(value => value.editor === editor); return { ...await traceItem(spec), ...await documentItem(spec) }; };
  const clear = await itemFor("clear"), missingUp = structuredClone(clear); missingUp.probe.records.splice(3, 2); assert.throws(() => checkFillTrace(missingUp));
  const changedKey = structuredClone(clear); changedKey.probe.records[1].params.key = "Backspace"; assert.throws(() => checkFillTrace(changedKey));
  const empty = await itemFor("empty"); empty.after[0].result.state.value = "undeleted"; assert.throws(() => checkFillDocuments(empty));
  const ce = await itemFor("contenteditable");
  for (const mutate of [
    value => { value.after[0].result.evidence.events.find(row => row.type === "beforeinput").ranges[0].startInOriginalNode = false; },
    value => { value.after[0].result.evidence.events.find(row => row.type === "input").originalHost = false; },
    value => { value.after[0].result.evidence.events.find(row => row.type === "input").hostToken = "sibling-host"; },
    value => { value.after[0].result.evidence.events.find(row => row.type === "input").originalNode = true; }
  ]) { const invalid = structuredClone(ce); mutate(invalid); assert.throws(() => checkFillDocuments(invalid)); }
  const date = await itemFor("date"); date.after[0].result.evidence.events.find(row => row.type === "input").trusted = true; assert.throws(() => checkFillDocuments(date));
});

test("multiline textarea preserves one native command with complete single or segmented DOM input", async () => {
  const spec = fillCompatibilityCases.find(value => value.editor === "textarea");
  for (const singleTextareaInput of [true, false]) {
    const item = await documentItem(spec, { singleTextareaInput });
    assert.equal(checkFillDocuments(item).inputs, singleTextareaInput ? 1 : 3);
    const wrong = structuredClone(item);
    wrong.after[0].result.evidence.events.find(event => event.type === "input").data += "wrong";
    assert.throws(() => checkFillDocuments(wrong));
  }
  const duplicate = await documentItem(spec);
  const input = duplicate.after[0].result.evidence.events.filter(event => event.type === "input");
  input[2].data = input[0].data;
  assert.throws(() => checkFillDocuments(duplicate));
});

test("nested editable fill preserves original host identity when native editing removes its selected span", async () => {
  const spec = fillCompatibilityCases.find(value => value.editor === "contenteditable");
  for (const removeEditableNode of [true, false]) {
    const item = await documentItem(spec, { removeEditableNode });
    assert.equal(item.after[0].result.state.originalNodePresent, !removeEditableNode);
    assert.equal(item.after[0].result.state.originalHostPresent, true);
    assert.equal(checkFillDocuments(item).posts, 1);
    const detached = structuredClone(item); detached.after[0].result.state.originalHostPresent = false;
    assert.throws(() => checkFillDocuments(detached));
    const replacedNode = structuredClone(item); replacedNode.after[0].result.state.nodePresent = removeEditableNode;
    assert.throws(() => checkFillDocuments(replacedNode));
    for (const invalidValue of [undefined, 0]) {
      const invalid = structuredClone(item);
      invalid.after[0].result.state.nodePresent = invalidValue;
      invalid.after[0].result.state.originalNodePresent = invalidValue;
      assert.throws(() => checkFillDocuments(invalid));
    }
  }
  const replacement = await documentItem(spec, { replaceEditableHost: true });
  assert.equal(replacement.after[0].result.state.originalHostPresent, false);
  assert.throws(() => checkFillDocuments(replacement));
});

test("empty Delete permits an observed uncancelled beforeinput but rejects cancellation or a fabricated edit", async () => {
  const spec = fillCompatibilityCases.find(value => value.editor === "empty"), item = await documentItem(spec, { emptyBeforeInput: true });
  const proof = checkFillDocuments(item); assert.equal(proof.beforeInputs, 1); assert.equal(proof.inputs, 0); assert.equal(proof.value, "");
  const cancelled = structuredClone(item); cancelled.after[0].result.evidence.beforeInputOutcomes[0].defaultPrevented = true;
  assert.throws(() => checkFillDocuments(cancelled));
  const missing = structuredClone(item); missing.after[0].result.evidence.beforeInputOutcomes = [];
  assert.throws(() => checkFillDocuments(missing));
});

test("probe preserves nonselected native Promise/receiver and records actual rejection", async () => {
  const target = {}, receiver = {}, records = [], native = Promise.resolve({ original: true });
  const original = function (...args) { records.push({ receiver: this, args }); return native; };
  const api = { debugger: { sendCommand: original } }, descriptor = Object.getOwnPropertyDescriptor(api.debugger, "sendCommand");
  const prior = function (...args) { records.push({ rpcReceiver: this, args }); }; target.__integrationNativeRPCObserver = prior;
  installFillProbe(api, target, { id: "one", tabId: 42, scope, text: "exact", drop: true });
  assert.equal(api.debugger.sendCommand.call(receiver, { tabId: 99 }, "Input.insertText", { text: "exact" }), native);
  assert.equal(api.debugger.sendCommand.call(receiver, { tabId: 42 }, "Input.insertText", { text: "different" }), native);
  assert.equal(api.debugger.sendCommand.call(receiver, { tabId: 42 }, "Runtime.evaluate", { expression: "1" }), native);
  await api.debugger.sendCommand({ tabId: 42 }, "Input.insertText", { text: "exact" }); await tick();
  assert.equal(records.length, 3); assert.equal(records[0].receiver, receiver); assert.equal(records[1].receiver, receiver);
  target.__integrationNativeRPCObserver.call(receiver, "request", { method: "other", id: 2 }); assert.equal(records.at(-1).rpcReceiver, receiver);
  const result = target.__obuFillProbe.restore(); assert.equal(result.pending, 0); assert.equal(result.records.filter(row => row.kind === "synthetic-ack").length, 1);
  assert.deepEqual(Object.getOwnPropertyDescriptor(api.debugger, "sendCommand"), descriptor); assert.equal(target.__integrationNativeRPCObserver, prior); assert.equal(target.__obuFillProbe, undefined);
  const rejected = Promise.reject(Error("native input failed")); rejected.catch(() => {});
  const other = {}, failing = { debugger: { sendCommand: () => rejected } };
  installFillProbe(failing, other, { id: "failure", tabId: 42, scope, text: "exact" });
  assert.equal(failing.debugger.sendCommand({ tabId: 42 }, "Input.insertText", { text: "exact" }), rejected); await tick();
  assert.equal(other.__obuFillProbe.restore().records.at(-1).ok, false);
});

test("terminal native/wire oracle rejects duplicates, missing ACK, timeout and foreign scope", async () => {
  const item = await traceItem(fillDeliveryCases.find(spec => spec.effect === "drop"));
  for (const mutate of [
    value => { value.probe.records.push({ ...value.probe.records.at(-1), sequence: 5 }); },
    value => { value.probe.records.splice(2, 1); }, value => { value.probe.pending = 1; }, value => { value.probe.overflow = true; },
    value => { value.probe.restored = false; }, value => { value.probe.errors.push("lost evidence"); },
    value => { value.probe.records[0].message.params.control_epoch++; },
    value => { value.probe.records[1].params.text += "wrong"; }, value => { value.probe.records[1].source.tabId++; },
    value => { value.probe.records[1].dispatched = true; }, value => { value.probe.records[3].message.id = "foreign"; },
    value => { value.probe.records[0].message.params.timeoutMs = 2001; }, value => { value.observedThroughMs = 2200; },
    value => { value.outcome = { ok: false, errorMessage: "SDK request timeout" }; },
    value => { value.probe.records[3].message.error.message = "Different error"; }, value => { value.outcome.ok = true; }
  ]) { const invalid = structuredClone(item); mutate(invalid); assert.throws(() => checkFillTrace(invalid)); }
});

test("business oracle rejects wrong value, synthetic input, changed identity and duplicate POST", async () => {
  const original = await documentItem(fillDeliveryCases[0]);
  for (const mutate of [
    value => { value.after[0].documentId = "replacement"; }, value => { value.after[0].result.evidence.nodeToken = "replacement"; },
    value => { value.after[0].result.state.value = "wrong"; }, value => { value.after[0].result.evidence.events.find(row => row.type === "input").trusted = false; },
    value => { value.after[0].result.evidence.events.find(row => row.type === "input").originalNode = false; },
    value => { value.after[0].result.evidence.events.find(row => row.type === "input").data = "wrong"; },
    value => { value.after[0].result.evidence.overflow = true; }, value => { value.server.posts.push(value.server.posts[0]); },
    value => { value.server.posts[0].bodyBase64 = Buffer.from("{}").toString("base64"); },
    value => { value.after[0].result.evidence.submits = 0; }, value => { value.submit.ok = false; }
  ]) { const invalid = structuredClone(original); mutate(invalid); assert.throws(() => checkFillDocuments(invalid)); }
  const cancelled = await documentItem(fillDeliveryCases.find(spec => spec.effect === "cancel"));
  for (const mutate of [value => { value.submit = { ok: true }; }, value => { value.after[0].result.evidence.effects[0].defaultPrevented = false; }, value => { value.server.posts.push({}); }]) {
    const invalid = structuredClone(cancelled); mutate(invalid); assert.throws(() => checkFillDocuments(invalid));
  }
});

test("native observer overflow and actual in-flight commands cannot yield a valid proof", async () => {
  const target = {}, api = { debugger: { sendCommand: () => new Promise(() => {}) } };
  installFillProbe(api, target, { id: "bounded", tabId: 42, scope, text: "exact" });
  for (let index = 0; index < 130; index++) api.debugger.sendCommand({ tabId: 42 }, "Input.insertText", { text: "exact" });
  const proof = target.__obuFillProbe.restore(); assert.equal(proof.records.length, 128); assert.equal(proof.overflow, true); assert.equal(proof.pending, 130);
});

test("fixture server retains exact Unicode POST bytes and rejects invalid routes/keys", async t => {
  const fixture = createFillDeliveryFixtures(); let base;
  const server = http.createServer((request, response) => { if (!fixture.handle(request, response, new URL(request.url, base))) { response.writeHead(404); response.end(); } });
  const port = await listenFixture(server); base = `http://127.0.0.1:${port}/`; t.after(() => new Promise(resolve => server.close(resolve)));
  const spec = fillDeliveryCases[0], key = keyFor(spec), urls = fillDeliveryURLs(base, key);
  assert.equal((await fetch(urls.root)).status, 200); assert.equal((await fetch(new URL("fill-delivery/page?key=bad", base))).status, 400);
  const body = JSON.stringify({ key, note: "Original π 日本語" }), response = await fetch(new URL(`fill-delivery/post?key=${key}`, base), { method: "POST", body });
  assert.equal(response.status, 200); const receipt = await response.json(), post = fixture.stats(key).posts[0];
  assert.equal(post.bodyBytes, Buffer.byteLength(body)); assert.equal(post.bodySHA256, hash(Buffer.from(body))); assert.equal(Buffer.from(post.bodyBase64, "base64").toString(), body);
  assert.equal(receipt.bodySHA256, post.bodySHA256); assert.equal(fixture.stats(key).gets.length, 1);
});

test("actual attach-before-navigation shape binds empty original URL to exact current target/document", () => {
  // Structure from run-6ryKB9: iframe attach URL was empty while native frame
  // metadata already held its committed URL and a different renderer process.
  // getTargets uses 'other' for the same target (also observed in iUAIHY).
  const rootURL = "http://127.0.0.1:1234/fill-delivery/page?key=one", targetURL = "http://localhost:1234/fill-delivery/frame?key=one";
  const native = { tab: { id: 42 }, frames: [
    { frameId: 0, parentFrameId: -1, processId: 18, documentId: "original-root-doc", documentLifecycle: "active", errorOccurred: false, url: rootURL },
    { frameId: 15, parentFrameId: 0, parentDocumentId: "original-root-doc", processId: 12, documentId: "original-child-doc", documentLifecycle: "active", errorOccurred: false, url: targetURL }
  ], oopifs: [{ tabId: 42, source: { tabId: 42 }, type: "iframe", targetId: "original-target", sessionId: "original-session", url: "" }],
  targets: [{ id: "original-target", attached: true, type: "other", url: targetURL },
    { id: "original-root-target", tabId: 42, attached: true, type: "page", url: rootURL }] };
  const options = { tabId: 42, rootURL, targetURL, expectedAttached: true }, proof = checkFillOOPIF(native, options);
  assert.equal(proof.targetId, "original-target"); assert.equal(proof.sessionId, "original-session");
  assert.equal(proof.documentId, "original-child-doc"); assert.equal(proof.processId, 12); assert.equal(native.oopifs[0].url, "");
  for (const mutate of [
    value => { value.targets[0].id = "replacement-target"; }, value => { value.targets[0].url = ""; },
    value => { value.targets[0].attached = false; }, value => { value.targets.push({ ...value.targets[0] }); },
    value => { value.oopifs[0].sessionId = ""; }, value => { value.oopifs[0].type = "page"; },
    value => { value.oopifs[0].source.tabId = 99; }, value => { value.oopifs[0].source.sessionId = "foreign-parent"; },
    value => { value.oopifs[0].tabId = 99; }, value => { value.oopifs.push({ ...value.oopifs[0], sessionId: "replacement-session" }); },
    value => { value.frames[1].processId = value.frames[0].processId; }, value => { value.frames[1].parentDocumentId = "replacement-root"; },
    value => { value.frames[1].documentLifecycle = "cached"; }, value => { value.frames[1].errorOccurred = true; },
    value => { value.frames[1].url = rootURL; }, value => { value.frames[1].parentFrameId = 8; },
    value => { value.frames[1].documentId = value.frames[0].documentId; }
  ]) { const invalid = structuredClone(native); mutate(invalid); assert.throws(() => checkFillOOPIF(invalid, options)); }
  const misleading = structuredClone(native); misleading.oopifs[0].url = targetURL; misleading.targets[0].url = "http://localhost:1234/replacement";
  assert.throws(() => checkFillOOPIF(misleading, options), /Unique original/);
  assert.throws(() => checkFillOOPIF(native, { ...options, expectedAttached: undefined }), /Explicit attachment phase/);
  // run-DU61BT correctly detached both original targets after cancelled fill.
  // Its retained documents/target IDs must remain the same without reattaching.
  const detached = structuredClone(native);
  for (const target of detached.targets) target.attached = false;
  const afterOptions = { ...options, expectedAttached: false };
  assert.deepEqual(checkFillOOPIF(detached, afterOptions), proof);
  assert.throws(() => checkFillOOPIF(detached, options));
  assert.throws(() => checkFillOOPIF(native, afterOptions));
  for (const mutate of [
    value => { value.targets[0].attached = true; },
    value => { value.targets[1].attached = true; },
    value => { value.targets[1].id = ""; },
    value => { value.targets[1].tabId = 99; },
    value => { value.targets.push({ ...value.targets[1] }); },
    value => { value.oopifs.push({ ...value.oopifs[0], sessionId: "new-session" }); }
  ]) { const invalid = structuredClone(detached); mutate(invalid); assert.throws(() => checkFillOOPIF(invalid, afterOptions)); }
  for (const mutate of [
    value => { value.targets[1].id = "replacement-root-target"; },
    value => { value.targets[0].id = value.oopifs[0].targetId = "replacement-child-target"; },
    value => { value.oopifs[0].sessionId = "replacement-session"; }
  ]) {
    const replaced = structuredClone(detached); mutate(replaced);
    assert.notDeepEqual(checkFillOOPIF(replaced, afterOptions), proof, "Caller must reject a replacement identity by comparing original proof");
  }
});
