import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chooserScope } from "./chooser-waits-fixture.mjs";

const route = "/fill-delivery/";
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const errorText = error => error?.stack ?? String(error);
const negative = spec => ["cancel", "drop"].includes(spec.effect);
export const fillDeliveryCases = Object.freeze(["root", "oopif", "dynamic-oopif"].flatMap(layout =>
  ["normal", "transform", "cancel", "drop"].map(effect => Object.freeze({ name: `${layout}-${effect}`, layout, effect }))));
export const fillCompatibilityCases = Object.freeze(["textarea", "contenteditable", "clear", "empty", "date"].map(editor =>
  Object.freeze({ name: `root-${editor}`, layout: "root", effect: "normal", editor })));
const keyPattern = /^fill-[a-f0-9]{32}-([a-z-]+)$/;
function specFor(key) {
  const name = keyPattern.exec(key ?? "")?.[1], spec = [...fillDeliveryCases, ...fillCompatibilityCases].find(value => value.name === name);
  assert.ok(spec, "Invalid fill fixture key"); return spec;
}
export function fillDeliveryURLs(base, key) {
  const spec = specFor(key), root = new URL(`${route}page`, base); root.searchParams.set("key", key);
  const frame = new URL(root); frame.pathname = `${route}frame`; frame.hostname = "localhost";
  return { root: root.href, target: spec.layout === "root" ? root.href : frame.href };
}
export const fillDeliveryValue = key => {
  const { editor } = specFor(key);
  return ["clear", "empty"].includes(editor) ? "" : editor === "date" ? "2026-10-12" :
    editor === "textarea" ? `Original π 日本語\nSecond line ${key}` : `Original π 日本語 ${key}`;
};
const seedFor = key => specFor(key).editor === "empty" ? "" : specFor(key).editor === "date" ? "2024-01-02" : `seed:${key}`;

// Runs only in fixture HTML. The transform/cancel handlers are intentional page
// behavior. No automation script assigns the requested fill value or emits input.
export function installFillEvidence(doc, spec, key, frameURL) {
  const node = doc.querySelector("#fill-target"), form = doc.querySelector("#fill-form"), add = doc.querySelector("#add-frame");
  const host = doc.querySelector("#editing-host") ?? node;
  const value = () => host ? ("value" in host ? host.value : host.textContent) : null;
  globalThis.fillDeliveryOriginalState = () => ({
    originalHostPresent: Boolean(host?.isConnected && host === (doc.querySelector("#editing-host") ?? doc.querySelector("#fill-target"))),
    originalNodePresent: Boolean(node?.isConnected && node === doc.querySelector("#fill-target"))
  });
  const evidence = globalThis.fillDeliveryEvidence = { key, caseName: spec.name, documentToken: crypto.randomUUID(),
    nodeToken: node?.dataset.token ?? null, hostToken: host?.dataset.token ?? null, events: [], beforeInputOutcomes: [], overflow: false, effects: [], submits: 0, frameAdds: [], errors: [] };
  const append = row => { if (evidence.events.length >= 128) { evidence.overflow = true; return; } evidence.events.push({ sequence: evidence.events.length + 1, ...row }); };
  for (const type of ["beforeinput", "input", "change", "keydown", "keyup", "pointerdown", "pointerup", "click"]) doc.addEventListener(type, event => {
    const ranges = typeof event.getTargetRanges === "function" ? [...event.getTargetRanges()] : [];
    if (ranges.length > 8) evidence.overflow = true;
    append({ type, trusted: event.isTrusted, originalNode: event.target === node, originalHost: event.target === host, targetId: event.target?.id ?? "",
      nodeToken: event.target === node ? evidence.nodeToken : null, hostToken: event.target === host ? evidence.hostToken : null,
      inputType: event.inputType ?? null, data: event.data ?? null, key: event.key ?? null, value: value(),
      ranges: ranges.slice(0, 8).map(range => ({ startInOriginalNode: node === range.startContainer || node?.contains(range.startContainer) === true,
        endInOriginalNode: node === range.endContainer || node?.contains(range.endContainer) === true, startOffset: range.startOffset, endOffset: range.endOffset })) });
  }, { capture: true, passive: true });
  if (node) {
    node.addEventListener("beforeinput", event => {
      if (spec.effect === "cancel") { event.preventDefault(); evidence.effects.push({ kind: "cancel", trusted: event.isTrusted, defaultPrevented: event.defaultPrevented }); }
    });
    node.addEventListener("input", event => {
      if (spec.effect === "transform") { node.value = node.value.toUpperCase(); evidence.effects.push({ kind: "transform", trusted: event.isTrusted, value: node.value }); }
    });
  }
  // Observe after this fixture's target handlers have had their ordinary
  // cancellation opportunity. This is document-bubble evidence, not a claim
  // about arbitrary later listeners in unrelated sites.
  doc.addEventListener("beforeinput", event => {
    if (evidence.beforeInputOutcomes.length >= 128) { evidence.overflow = true; return; }
    evidence.beforeInputOutcomes.push({ trusted: event.isTrusted, originalHost: event.target === host, defaultPrevented: event.defaultPrevented });
  }, { passive: true });
  if (add) add.addEventListener("click", event => {
    evidence.frameAdds.push({ trusted: event.isTrusted });
    if (evidence.frameAdds.length !== 1) { evidence.errors.push("Repeated frame creation"); return; }
    const frame = doc.createElement("iframe"); frame.id = "fill-frame"; frame.src = frameURL; doc.body.append(frame); add.disabled = true;
  });
  if (form) form.addEventListener("submit", event => {
    event.preventDefault(); evidence.submits++;
    const body = { key, caseName: spec.name, href: location.href, documentToken: evidence.documentToken, nodeToken: evidence.nodeToken,
      value: value(), trustedSubmit: event.isTrusted, evidence: structuredClone(evidence) };
    fetch(`/fill-delivery/post?${new URLSearchParams({ key })}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      .then(response => { if (!response.ok) throw Error(`Fill receipt HTTP ${response.status}`); return response.json(); })
      .then(receipt => { evidence.receipt = receipt; }).catch(error => evidence.errors.push(String(error)));
  });
}
export function readFillEvidence() {
  const node = document.querySelector("#fill-target");
  const host = document.querySelector("#editing-host") ?? node;
  return { href: location.href, evidence: globalThis.fillDeliveryEvidence,
    state: { value: host ? ("value" in host ? host.value : host.textContent) : null, nodePresent: Boolean(node), activeOriginalNode: node !== null && document.activeElement === node,
      ...globalThis.fillDeliveryOriginalState() } };
}
export function fillDeliveryHTML(url) {
  const key = url.searchParams.get("key"), spec = specFor(key), urls = fillDeliveryURLs(url, key);
  assert.ok([`${route}page`, `${route}frame`].includes(url.pathname));
  const ownsTarget = spec.layout === "root" || url.pathname === `${route}frame`;
  const target = spec.editor === "textarea" ? `<textarea id="fill-target" data-token="${key}-node">${seedFor(key)}</textarea>` :
    spec.editor === "contenteditable" ? `<div id="editing-host" contenteditable="true" data-token="${key}-host"><div><span id="fill-target" data-token="${key}-node">${seedFor(key)}</span></div></div>` :
      `<input id="fill-target" data-token="${key}-node" ${spec.editor === "date" ? 'type="date"' : ""} value="${seedFor(key)}">`;
  return `<!doctype html><meta charset="utf-8"><title>Fill delivery ${key}</title>
<style>body{margin:20px;font:16px sans-serif}input{width:430px;padding:12px}button{padding:14px;margin:20px}iframe{width:650px;height:340px;border:3px solid #246}</style><h1>Original fill fixture</h1>
${ownsTarget ? `<form id="fill-form"><label for="fill-target">Original delivery note</label>${target}<button id="submit-note">Submit original note</button></form>` : spec.layout === "dynamic-oopif" ? '<button id="add-frame">Add original frame</button>' : `<iframe id="fill-frame" src="${urls.target}"></iframe>`}
<script>(${installFillEvidence.toString()})(document,${JSON.stringify(spec)},${JSON.stringify(key)},${JSON.stringify(urls.target)});</script>`;
}
export function createFillDeliveryFixtures() {
  const records = new Map();
  const entry = key => {
    specFor(key);
    if (!records.has(key)) { assert.ok(records.size < 32, "Fill fixture record limit"); records.set(key, { key, gets: [], posts: [] }); }
    return records.get(key);
  };
  return { stats: key => structuredClone(entry(key)), allStats: () => structuredClone([...records.values()]),
    handle(request, response, url) {
      if (![`${route}page`, `${route}frame`, `${route}post`].includes(url.pathname)) return false;
      let record; const key = url.searchParams.get("key");
      try { record = entry(key); } catch { response.writeHead(400); response.end("Invalid fill fixture key"); return true; }
      if (url.pathname !== `${route}post`) {
        if (request.method !== "GET") { response.writeHead(405); response.end(); return true; }
        if (record.gets.length >= 8) { record.overflow = true; response.writeHead(429); response.end(); return true; }
        const html = Buffer.from(fillDeliveryHTML(url));
        record.gets.push({ path: url.pathname, at: Date.now(), bytes: html.length, sha256: hash(html) });
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }); response.end(html); return true;
      }
      if (request.method !== "POST") { response.writeHead(405); response.end(); return true; }
      if (record.posts.length >= 4) { record.overflow = true; response.writeHead(429); response.end(); return true; }
      const post = { method: "POST", receivedAt: Date.now() }; record.posts.push(post);
      const chunks = []; let size = 0;
      request.on("data", chunk => { size += chunk.length; if (size <= 65536) chunks.push(chunk); });
      request.once("aborted", () => { post.error = "HTTP request aborted"; });
      request.once("error", () => { post.error = "HTTP request failed"; });
      request.once("end", () => {
        const bytes = Buffer.concat(chunks);
        Object.assign(post, { completedAt: Date.now(), bodyBytes: size, bodyBase64: bytes.toString("base64"), bodySHA256: hash(bytes) });
        try {
          assert.ok(size <= 65536); post.value = JSON.parse(bytes.toString("utf8")); assert.equal(post.value.key, key);
          post.receipt = { key, index: record.posts.length, bodySHA256: post.bodySHA256 };
          response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify(post.receipt));
        } catch { post.error = "Invalid fill receipt"; response.writeHead(400); response.end(post.error); }
      }); return true;
    }
  };
}

// Exact fixture-only controlled failure: drop Input.insertText with a synthetic
// ACK. Other calls retain their original receiver, arguments and Promise. The
// same worker sequence records original browserAction RPC and native settlement.
export function installFillProbe(api, target, options) {
  const { id, tabId, scope, text, drop = false } = options ?? {};
  if (!id || !Number.isSafeInteger(tabId) || !scope?.session_id || !scope?.turn_id || !Number.isSafeInteger(scope.control_epoch) ||
      typeof text !== "string" || text.length > 512 || typeof drop !== "boolean" || drop && !text || target.__obuFillProbe) throw Error("Invalid fill probe");
  const object = api.debugger, descriptor = Object.getOwnPropertyDescriptor(object, "sendCommand"), original = object.sendCommand;
  const rpcName = "__integrationNativeRPCObserver", rpcDescriptor = Object.getOwnPropertyDescriptor(target, rpcName), previous = target[rpcName];
  if (typeof original !== "function" || previous !== undefined && typeof previous !== "function") throw Error("Unobservable fill native/RPC method");
  const records = [], errors = [], requests = new Set(); let sequence = 0, pending = 0, overflow = false, restored = false;
  const append = row => {
    if (records.length >= 128) { overflow = true; return; }
    const copy = structuredClone(row);
    if (JSON.stringify(copy).length > 16384) { overflow = true; return; }
    records.push({ sequence: ++sequence, ...copy });
  };
  const safely = fn => { try { fn(); } catch { if (errors.length < 8) errors.push("Fill probe recording error"); } };
  function wrapper(...args) {
    const [source, method, params] = args;
    if (source?.tabId !== tabId || !method?.startsWith("Input.")) return Reflect.apply(original, this, args);
    const dropped = drop && method === "Input.insertText" && params?.text === text;
    safely(() => append({ kind: "invoke", source, method, params, dispatched: !dropped })); const invocation = sequence;
    if (dropped) { safely(() => append({ kind: "synthetic-ack", invocation })); return Promise.resolve({}); }
    let value;
    try { value = Reflect.apply(original, this, args); }
    catch (error) { safely(() => append({ kind: "settled", invocation, ok: false })); throw error; }
    pending++;
    try { Promise.prototype.then.call(value,
      () => { pending--; safely(() => append({ kind: "settled", invocation, ok: true })); },
      () => { pending--; safely(() => append({ kind: "settled", invocation, ok: false })); }); }
    catch { pending--; errors.push("Native fill input returned no original Promise"); }
    return value;
  }
  function hook(direction, message) {
    if (previous) Reflect.apply(previous, this, [direction, message]);
    safely(() => {
      if (overflow) return;
      const p = message?.params;
      if (direction === "request" && message.method === "browserAction" && p?.tabId === tabId && p.action === "fill" &&
          p.session_id === scope.session_id && p.turn_id === scope.turn_id && p.control_epoch === scope.control_epoch) {
        if (requests.size >= 128) { overflow = true; return; }
        if (requests.has(message.id) && errors.length < 8) errors.push("Repeated fill request ID"); requests.add(message.id);
        append({ kind: "request", message });
      } else if (direction === "response" && requests.has(message?.id)) append({ kind: "response", message });
    });
  }
  const snapshot = () => structuredClone({ version: 1, id, tabId, scope, text, drop, records, errors, pending, overflow, restored });
  const controller = { id, snapshot, restore() {
    if (restored) return snapshot();
    if (object.sendCommand !== wrapper || target[rpcName] !== hook || target.__obuFillProbe !== controller) throw Error("Original fill observer replaced");
    if (descriptor) Object.defineProperty(object, "sendCommand", descriptor); else delete object.sendCommand;
    if (rpcDescriptor) Object.defineProperty(target, rpcName, rpcDescriptor); else delete target[rpcName];
    delete target.__obuFillProbe; restored = true; return snapshot();
  } };
  Object.defineProperty(object, "sendCommand", descriptor ? { ...descriptor, value: wrapper } : { value: wrapper, writable: true, configurable: true });
  try { Object.defineProperty(target, rpcName, rpcDescriptor ? { ...rpcDescriptor, value: hook } : { value: hook, configurable: true, writable: true }); target.__obuFillProbe = controller; }
  catch (error) { if (descriptor) Object.defineProperty(object, "sendCommand", descriptor); else delete object.sendCommand; throw error; }
  return snapshot();
}

export function checkFillTrace(item) {
  const probe = item.probe, spec = item.spec;
  assert.equal(probe?.version, 1); assert.equal(probe.id, item.id); assert.equal(probe.tabId, item.tabId); assert.deepEqual(probe.scope, item.scope);
  assert.equal(probe.text, fillDeliveryValue(item.key)); assert.equal(probe.drop, spec.effect === "drop");
  assert.equal(probe.restored, true); assert.equal(probe.pending, 0); assert.equal(probe.overflow, false); assert.deepEqual(probe.errors, []);
  assert.ok(probe.records.every((row, index) => row.sequence === index + 1));
  const requests = probe.records.filter(row => row.kind === "request"), responses = probe.records.filter(row => row.kind === "response"), calls = probe.records.filter(row => row.kind === "invoke");
  assert.equal(requests.length, 1, "One original fill browserAction"); assert.equal(responses.length, 1, "One original fill server response");
  const request = requests[0], response = responses[0], p = request.message.params;
  assert.equal(request.message.method, "browserAction"); assert.equal(p.action, "fill"); assert.equal(p.tabId, item.tabId);
  for (const [key, value] of Object.entries(item.scope)) assert.equal(p[key], value);
  assert.equal(p.args.value, fillDeliveryValue(item.key)); assert.ok(Number.isSafeInteger(p.timeoutMs) && p.timeoutMs > 0 && p.timeoutMs <= item.timeoutMs);
  assert.deepEqual(p.args, { value: fillDeliveryValue(item.key) }, "Ordinary fill cannot silently become force/trial or change modifiers");
  const locator = spec.editor === "contenteditable" ? { kind: "css", selector: "#fill-target" } : { kind: "label", value: "Original delivery note", exact: true };
  assert.deepEqual(p.locator, [...(spec.layout === "root" ? [] : [{ kind: "frame", selector: "#fill-frame" }]), locator], "Original source locator and frame");
  assert.equal(response.message.id, request.message.id); assert.ok(response.sequence > request.sequence);
  const deletion = ["clear", "empty"].includes(spec.editor), setter = spec.editor === "date";
  assert.equal(calls.length, setter ? 0 : deletion ? 2 : 1, "No implicit mouse/key fallback or duplicate fill dispatch");
  const acks = [];
  for (const [index, call] of calls.entries()) {
    assert.equal(call.source.tabId, item.tabId); assert.equal(call.dispatched, spec.effect !== "drop");
    if (deletion) {
      assert.equal(call.method, "Input.dispatchKeyEvent"); assert.equal(call.params.key, "Delete"); assert.equal(call.params.code, "Delete");
      assert.equal(call.params.modifiers ?? 0, 0);
      if (index === 0) assert.ok(["keyDown", "rawKeyDown"].includes(call.params.type)); else assert.equal(call.params.type, "keyUp");
    } else { assert.equal(call.method, "Input.insertText"); assert.deepEqual(call.params, { text: fillDeliveryValue(item.key) }); }
    const settlements = probe.records.filter(row => row.invocation === call.sequence); assert.equal(settlements.length, 1);
    const ack = settlements[0]; acks.push(ack);
    assert.equal(ack.kind, spec.effect === "drop" ? "synthetic-ack" : "settled"); if (spec.effect !== "drop") assert.equal(ack.ok, true);
    assert.ok(call.sequence > request.sequence && ack.sequence > call.sequence && response.sequence > ack.sequence);
    if (index > 0) assert.ok(call.sequence > acks[index - 1].sequence, "Native Delete release follows original press ACK");
  }
  assert.equal(probe.records.length, 2 + calls.length * 2);
  if (negative(spec)) {
    assert.equal(item.outcome.ok, false); assert.match(item.outcome.errorMessage, /OBU_FILL_DELIVERY_UNCONFIRMED/);
    assert.doesNotMatch(item.outcome.errorMessage, /timed out|timeout/i);
    assert.equal(response.message.error?.message, item.outcome.errorMessage);
    assert.ok(item.observedThroughMs >= item.timeoutMs + 250, "Negative observation must extend beyond the original action deadline");
  } else { assert.equal(item.outcome.ok, true); assert.equal(response.message.error, undefined); }
  return { requests: 1, responses: 1, insertText: setter || deletion ? 0 : 1, nativeDispatches: spec.effect === "drop" ? 0 : calls.length,
    syntheticACKs: spec.effect === "drop" ? 1 : 0, deletion, directSetter: setter };
}
export function checkFillDocuments(item) {
  const { spec } = item, expected = spec.effect === "transform" ? fillDeliveryValue(item.key).toUpperCase() : negative(spec) ? seedFor(item.key) : fillDeliveryValue(item.key);
  const before = item.before.find(value => value.result.href === item.targetURL), after = item.after.find(value => value.result.href === item.targetURL);
  assert.ok(before && after); assert.equal(after.documentId, before.documentId); assert.equal(after.frameId, before.frameId);
  const original = before.result.evidence, final = after.result.evidence;
  for (const key of ["key", "caseName", "documentToken", "nodeToken", "hostToken"]) assert.equal(final[key], original[key]);
  assert.equal(final.key, item.key); assert.equal(final.caseName, spec.name); assert.equal(final.nodeToken, `${item.key}-node`);
  assert.ok(original.documentToken); assert.equal(before.result.state.value, seedFor(item.key)); assert.equal(after.result.state.value, expected);
  assert.equal(before.result.state.originalHostPresent, true); assert.equal(before.result.state.originalNodePresent, true);
  assert.equal(after.result.state.originalHostPresent, true);
  // Chromium may remove the fully selected nested span while editing its
  // original contenteditable host (ozs5WA). Its original range/event identity
  // and surviving original host remain mandatory; a replacement is not enough.
  if (spec.editor !== "contenteditable") {
    assert.equal(after.result.state.nodePresent, true); assert.equal(after.result.state.originalNodePresent, true);
  } else {
    assert.equal(typeof after.result.state.nodePresent, "boolean");
    assert.equal(typeof after.result.state.originalNodePresent, "boolean");
    assert.equal(after.result.state.nodePresent, after.result.state.originalNodePresent);
  }
  assert.equal(final.overflow, false); assert.deepEqual(final.errors, []);
  assert.deepEqual(original.events.filter(event => event.originalNode), []);
  const setter = spec.editor === "date", deletion = ["clear", "empty"].includes(spec.editor), empty = spec.editor === "empty", contenteditable = spec.editor === "contenteditable";
  assert.equal(final.hostToken, `${item.key}-${contenteditable ? "host" : "node"}`);
  assert.ok(final.events.every((event, index) => event.sequence === index + 1 && event.trusted === !(setter && ["input", "change"].includes(event.type))), "Preserve native trust and explicit direct-setter synthetic semantics");
  assert.deepEqual(final.events.slice(0, original.events.length), original.events);
  const inputs = final.events.filter(event => event.originalHost && event.type === "input"), beforeInputs = final.events.filter(event => event.originalHost && event.type === "beforeinput");
  if (spec.editor === "textarea") {
    // Chromium can publish one input per text segment/newline for a single
    // multiline insertText (observed in BJZrns). The native trace must still
    // prove one full command; validate the complete ordered payload shape.
    const text = fillDeliveryValue(item.key), lines = text.split("\n");
    assert.equal(lines.length, 2);
    assert.ok(inputs.length === 1 || inputs.length === 3);
    assert.deepEqual(inputs.map(event => event.data), inputs.length === 1 ? [text] : [lines[0], null, lines[1]]);
    assert.ok(inputs.every(event => event.value === expected));
  } else assert.equal(inputs.length, negative(spec) || empty ? 0 : 1);
  if (empty) assert.ok(beforeInputs.length <= 1, "Empty Delete may have one uncancelled beforeinput without an edit");
  else assert.equal(beforeInputs.length, spec.effect === "drop" || setter ? 0 : 1);
  assert.equal(final.beforeInputOutcomes.length, beforeInputs.length);
  for (const outcome of final.beforeInputOutcomes) assert.deepEqual(outcome, { trusted: true, originalHost: true, defaultPrevented: spec.effect === "cancel" });
  assert.equal(final.events.filter(event => event.originalHost && ["pointerdown", "pointerup", "click"].includes(event.type)).length, 0);
  const keys = final.events.filter(event => event.originalHost && ["keydown", "keyup"].includes(event.type)); assert.equal(keys.length, deletion ? 2 : 0);
  if (deletion) { assert.deepEqual(keys.map(event => event.type), ["keydown", "keyup"]); assert.ok(keys.every(event => event.key === "Delete")); }
  for (const event of [...inputs, ...beforeInputs]) {
    assert.equal(event.hostToken, final.hostToken); assert.equal(event.originalNode, !contenteditable);
    assert.equal(event.inputType, setter ? null : deletion ? "deleteContentForward" : "insertText");
    if (spec.editor !== "textarea" || event.type === "beforeinput") assert.equal(event.data, setter || deletion ? null : fillDeliveryValue(item.key));
  }
  if (contenteditable) {
    assert.equal(beforeInputs[0].ranges.length, 1); const range = beforeInputs[0].ranges[0];
    assert.equal(range.startInOriginalNode, true); assert.equal(range.endInOriginalNode, true);
    assert.equal(range.startOffset, 0); assert.equal(range.endOffset, seedFor(item.key).length);
  }
  assert.equal(final.effects.length, ["cancel", "transform"].includes(spec.effect) ? 1 : 0);
  if (spec.effect === "cancel") assert.deepEqual(final.effects[0], { kind: "cancel", trusted: true, defaultPrevented: true });
  if (spec.effect === "transform") assert.deepEqual(final.effects[0], { kind: "transform", trusted: true, value: expected });
  assert.equal(item.server.overflow, undefined); assert.equal(item.server.posts.length, negative(spec) ? 0 : 1); assert.equal(final.submits, negative(spec) ? 0 : 1);
  if (negative(spec)) { assert.equal(item.submit, undefined); return { inputs: 0, beforeInputs: beforeInputs.length, posts: 0, value: expected }; }
  assert.equal(item.submit.ok, true);
  const post = item.server.posts[0], bytes = Buffer.from(post.bodyBase64, "base64");
  assert.equal(post.error, undefined); assert.equal(bytes.length, post.bodyBytes); assert.equal(hash(bytes), post.bodySHA256); assert.deepEqual(JSON.parse(bytes.toString("utf8")), post.value);
  for (const [key, value] of Object.entries({ key: item.key, caseName: spec.name, href: item.targetURL, documentToken: final.documentToken, nodeToken: final.nodeToken, value: expected, trustedSubmit: true })) assert.equal(post.value[key], value);
  assert.equal(post.value.evidence.submits, 1); assert.equal(post.receipt.index, 1); assert.equal(post.receipt.bodySHA256, post.bodySHA256);
  assert.equal(final.events.filter(event => event.type === "click" && event.targetId === "submit-note").length, 1);
  return { inputs: inputs.length, beforeInputs: beforeInputs.length, posts: 1, value: expected, bytes: bytes.length, sha256: post.bodySHA256 };
}

async function bounded(operation, label, timeoutMs = 7000) {
  let timer; try { return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`Fill fixture ${label} timed out`)), timeoutMs); })]); }
  finally { clearTimeout(timer); }
}
export function checkFillOOPIF(native, { tabId, rootURL, targetURL, expectedAttached }) {
  assert.equal(typeof expectedAttached, "boolean", "Explicit attachment phase required");
  assert.equal(native.tab.id, tabId);
  const roots = native.frames.filter(frame => frame.frameId === 0 && frame.url === rootURL);
  const children = native.frames.filter(frame => frame.frameId !== 0 && frame.url === targetURL);
  assert.equal(roots.length, 1); assert.equal(children.length, 1);
  const root = roots[0], child = children[0];
  assert.equal(child.parentFrameId, 0); assert.equal(child.parentDocumentId, root.documentId);
  for (const frame of [root, child]) {
    assert.ok(typeof frame.documentId === "string" && frame.documentId);
    assert.ok(Number.isSafeInteger(frame.processId) && frame.processId > 0);
    assert.equal(frame.documentLifecycle, "active"); assert.equal(frame.errorOccurred, false);
  }
  assert.notEqual(child.documentId, root.documentId); assert.notEqual(child.processId, root.processId, "Real OOPIF process required");
  const rootTargets = native.targets.filter(target => target.tabId === tabId && target.type === "page" && target.url === rootURL);
  assert.equal(rootTargets.length, 1, "Unique original root target required");
  const rootTarget = rootTargets[0];
  assert.ok(typeof rootTarget.id === "string" && rootTarget.id);
  assert.equal(rootTarget.attached, expectedAttached, "Root attachment state must match the explicit fill phase");
  assert.equal(native.oopifs.length, 1, "Only the original single-child attachment event may exist");
  // Auto-attach can precede navigation: its original targetInfo.url may be
  // empty. Keep that event intact and join its original ID/session to the
  // current native target URL; getTargets describes OOPIFs as type 'other'.
  const matches = native.oopifs.flatMap(attachment => {
    if (attachment.tabId !== tabId || attachment.source?.tabId !== tabId || attachment.source.sessionId !== undefined ||
        attachment.type !== "iframe" || typeof attachment.targetId !== "string" || !attachment.targetId ||
        typeof attachment.sessionId !== "string" || !attachment.sessionId) return [];
    return native.targets.filter(target => target.id === attachment.targetId && target.url === targetURL && target.attached === expectedAttached)
      .map(target => ({ attachment, target }));
  });
  assert.equal(matches.length, 1, "Unique original OOPIF attachment/current native target association required");
  const { attachment, target } = matches[0];
  assert.notEqual(target.id, rootTarget.id);
  return { tabId, rootTargetId: rootTarget.id, targetId: target.id, sessionId: attachment.sessionId, frameId: child.frameId, documentId: child.documentId,
    parentDocumentId: root.documentId, rootProcessId: root.processId, processId: child.processId, url: target.url,
    boundary: "Original attach ID/session plus current target URL and webNavigation document/process observations; not an atomic browser-internal document-to-target proof." };
}
export async function checkFillDelivery({ browser, worker, fixtureURL, server, until, detail = {} }) {
  Object.assign(detail, { passed: false, cases: [], cleanupErrors: [], boundary: "Original fill on root/existing/dynamic OOPIF. Drop cases deliberately suppress exact Input.insertText with a synthetic ACK; this is not a natural Vivaldi failure. Original DOM handlers transform/cancel. Negative fill stops before Submit and is observed through its original deadline plus 250ms. No new focus allowance." });
  const tabs = []; let primary;
  const native = tabId => bounded(worker.evaluate(`(async()=>{const tab=await chrome.tabs.get(${tabId}),frames=await chrome.webNavigation.getAllFrames({tabId:${tabId}}),oopifs=(globalThis.__integrationFrames??[]).filter(v=>v.tabId===${tabId}),ids=new Set(oopifs.map(v=>v.targetId)),targets=(await chrome.debugger.getTargets()).filter(v=>v.tabId===${tabId}||ids.has(v.id));return{tab,frames,oopifs,targets}})()`), "native identities");
  const read = (tabId, documents) => bounded(worker.evaluate(`chrome.scripting.executeScript({target:{tabId:${tabId},documentIds:${JSON.stringify(documents.map(frame => frame.documentId))}},world:'MAIN',func:${readFillEvidence.toString()}})`), "original documents");
  try {
    for (const spec of [...fillDeliveryCases, ...fillCompatibilityCases]) {
      const id = randomUUID(), key = `fill-${id.replaceAll("-", "")}-${spec.name}`, urls = fillDeliveryURLs(fixtureURL, key);
      const item = { id, key, spec, url: urls.root, targetURL: urls.target, timeoutMs: 2000, passed: false }; detail.cases.push(item);
      const tab = await browser.newTab(); tabs.push(tab); item.tabId = tab.id;
      await browser.cdp.navigate(tab.id, urls.root);
      assert.equal(await tab.locator("h1").textContent({ timeoutMs: 5000 }), "Original fill fixture");
      if (spec.layout === "dynamic-oopif") {
        item.beforeFrame = await native(tab.id); assert.equal(item.beforeFrame.frames.length, 1);
        await tab.getByRole("button", { name: "Add original frame", exact: true }).click({ timeoutMs: 5000 });
      }
      const frame = spec.layout === "root" ? tab : tab.frameLocator("#fill-frame"), locator = spec.editor === "contenteditable" ? frame.locator("#fill-target") : frame.getByLabel("Original delivery note", { exact: true });
      // A renderer read warms only the already-existing original target; it does
      // not focus or prefill it, and remains outside the single fill budget.
      assert.equal(await frame.locator("#submit-note").textContent({ timeoutMs: 5000 }), "Submit original note");
      assert.equal(await locator.count(), 1);
      item.nativeBefore = await native(tab.id); const frames = item.nativeBefore.frames;
      const root = frames.filter(value => value.frameId === 0 && value.url === urls.root), target = frames.filter(value => value.url === urls.target);
      assert.equal(root.length, 1); assert.equal(target.length, 1);
      const documents = spec.layout === "root" ? root : [...root, ...target];
      assert.ok(documents.every(value => value.documentId && value.documentLifecycle === "active" && value.errorOccurred === false));
      if (spec.layout !== "root") {
        item.rendererBefore = checkFillOOPIF(item.nativeBefore, { tabId: tab.id, rootURL: urls.root, targetURL: urls.target, expectedAttached: true });
      }
      item.before = await read(tab.id, documents); item.scope = chooserScope(browser);
      let attempted = false, failure; const started = performance.now();
      try {
        attempted = true;
        item.installation = await bounded(worker.evaluate(`(()=>{if(Date.now()>=${Date.now() + 6500})throw Error('Fill probe setup expired');return (${installFillProbe.toString()})(chrome,globalThis,${JSON.stringify({ id, tabId: tab.id, scope: item.scope, text: fillDeliveryValue(key), drop: spec.effect === "drop" })})})()`), "probe install");
        item.startedAt = Date.now(); item.startedMonotonic = performance.now();
        item.outcome = await locator.fill(fillDeliveryValue(key), { timeoutMs: item.timeoutMs }).then(() => ({ ok: true, settledAt: Date.now() }), error => ({ ok: false, errorMessage: String(error?.message ?? error), error: errorText(error), settledAt: Date.now() }));
        if (negative(spec)) {
          assert.equal(item.outcome.ok, false, "Undelivered fill returned success"); assert.match(item.outcome.errorMessage, /OBU_FILL_DELIVERY_UNCONFIRMED/);
          const observedUntil = item.startedMonotonic + item.timeoutMs + 250;
          while (performance.now() < observedUntil) await new Promise(resolve => setTimeout(resolve, Math.max(1, observedUntil - performance.now())));
          item.observedThroughMs = performance.now() - item.startedMonotonic;
        } else assert.equal(item.outcome.ok, true, item.outcome.errorMessage);
      } catch (error) { failure = error; item.error = errorText(error); }
      finally {
        if (attempted) try { item.probe = await bounded(worker.evaluate(`(()=>{const p=globalThis.__obuFillProbe;if(!p||p.id!==${JSON.stringify(id)})throw Error('Original fill probe missing');return p.restore()})()`), "probe restore"); }
        catch (error) { item.restoreError = errorText(error); detail.cleanupErrors.push({ stage: "probe-restore", error: item.restoreError }); failure ??= error; }
      }
      if (!failure && !negative(spec)) {
        try {
          await frame.getByRole("button", { name: "Submit original note", exact: true }).click({ timeoutMs: 5000 }); item.submit = { ok: true };
          await until(() => server.stats(key).posts[0]?.receipt, "one original fill business POST", 5000);
        } catch (error) { failure = error; item.submit = { ok: false, error: errorText(error) }; }
      }
      try {
        item.nativeAfter = await native(tab.id); assert.deepEqual(chooserScope(browser), item.scope);
        for (const field of ["id", "windowId", "groupId", "pinned"]) assert.equal(item.nativeAfter.tab[field], item.nativeBefore.tab[field]);
        assert.equal(item.nativeAfter.tab.active, false); assert.equal(item.nativeAfter.tab.url, urls.root);
        for (const frame of documents) assert.equal(item.nativeAfter.frames.filter(value => value.documentId === frame.documentId && value.frameId === frame.frameId && value.url === frame.url).length, 1);
        if (spec.layout !== "root") {
          item.rendererAfter = checkFillOOPIF(item.nativeAfter, { tabId: tab.id, rootURL: urls.root, targetURL: urls.target, expectedAttached: !negative(spec) });
          assert.deepEqual(item.nativeAfter.oopifs, item.nativeBefore.oopifs, "Fill must not add or replace the original attachment event");
          assert.deepEqual(item.rendererAfter, item.rendererBefore, "Original OOPIF target/session/document identities survive fill, including expected failure detach");
        }
        item.after = await read(tab.id, documents); assert.equal(item.before.length, documents.length); assert.equal(item.after.length, documents.length);
        for (const frame of documents) for (const values of [item.before, item.after]) assert.equal(values.filter(value => value.documentId === frame.documentId && value.frameId === frame.frameId && value.result.href === frame.url).length, 1);
        if (spec.layout === "dynamic-oopif") assert.deepEqual(item.after.find(value => value.frameId === 0).result.evidence.frameAdds, [{ trusted: true }]);
        item.server = server.stats(key); item.traceProof = checkFillTrace(item); item.documentProof = checkFillDocuments(item);
      } catch (error) { item.evidenceError = errorText(error); failure ??= error; }
      item.elapsedMs = performance.now() - started;
      if (failure) throw failure; item.passed = true;
    }
    detail.passed = true;
  } catch (error) { primary = error; detail.error = errorText(error); }
  finally {
    for (const tab of tabs) try { await bounded(tab.close(), "close exact fixture tab"); }
    catch (error) { detail.cleanupErrors.push({ stage: "tab.close", tabId: tab.id, error: errorText(error) }); primary ??= error; }
    try {
      const ids = tabs.map(tab => tab.id);
      detail.cleanup = await bounded(worker.evaluate(`(async()=>({tabIds:${JSON.stringify(ids)},tabs:(await chrome.tabs.query({})).filter(t=>${JSON.stringify(ids)}.includes(t.id)),targets:(await chrome.debugger.getTargets()).filter(t=>${JSON.stringify(ids)}.includes(t.tabId)),probePresent:Object.hasOwn(globalThis,'__obuFillProbe')}))()`), "native cleanup inventory");
      assert.deepEqual(detail.cleanup.tabs, []); assert.deepEqual(detail.cleanup.targets, []); assert.equal(detail.cleanup.probePresent, false);
    } catch (error) { detail.cleanupErrors.push({ stage: "native-cleanup", error: errorText(error) }); primary ??= error; }
    detail.server = server.allStats(); if (primary) { detail.passed = false; primary.fillDeliveryDetail = detail; }
  }
  if (primary) throw primary; return detail;
}
