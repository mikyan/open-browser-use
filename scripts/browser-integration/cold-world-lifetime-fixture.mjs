import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { measureFrameTargetPixels, waitForFrameTargetFeedback } from "./frame-target-feedback-fixture.mjs";

const route = "/cold-world-lifetime/", worldPrefix = "Open Browser Use passive pointer ";
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const errorText = error => error?.stack ?? String(error);
const scopeOf = browser => ({ session_id: browser.client.sessionId, turn_id: browser.client.turnId, control_epoch: browser.client.controlEpoch });
const button = Object.freeze({ x: 46, y: 134, width: 280, height: 64 });
const move = Object.freeze({ type: "mouseMoved", x: 186, y: 166, buttons: 0 });

// Installed before Backend construction in each real worker. It does not enable
// a domain, create a world, alter a native result, or retain an old worker task.
export function installColdWorldLifetimeProbe(api, target) {
  if (target.__obuColdWorldLifetime) throw Error("Cold world observer already installed");
  const original = {}, wrappers = {}, records = [], nativeThen = Promise.prototype.then;
  let tabId, attachment, pending = 0, size = 0, overflow = false, recordingErrors = 0, restored = false;
  const workerId = crypto.randomUUID();
  const state = () => {
    const b = target.__integrationBackend, current = b?.attachmentEpochs.get(tabId);
    if (attachment === undefined && current !== undefined) attachment = current;
    return { engineAbsent: b ? b.browserEngine === null : null, attached: b?.attachedTabs.has(tabId) ?? false,
      originalAttachmentSeen: attachment !== undefined, sameAttachment: attachment === undefined ? null : attachment === current,
      pointerPending: [...(b?.pointerFeedbackReads?.pending ?? [])].filter(row => row.scope.tabId === tabId).length,
      privateLeases: [...(b?.privatePointerTargets?.entries.values() ?? [])].filter(row => row.root?.tabId === tabId).length };
  };
  const append = row => {
    try { const value = structuredClone({ sequence: records.length + 1, ...row }), bytes = JSON.stringify(value).length;
      if (records.length >= 4096 || size + bytes > 24 * 1024 * 1024) { overflow = true; return null; }
      size += bytes; records.push(value); return value;
    } catch { recordingErrors++; return null; }
  };
  for (const name of ["sendCommand", "attach", "detach"]) {
    original[name] = api.debugger[name];
    wrappers[name] = function (...args) {
      const call = append({ kind: "call", method: name === "sendCommand" ? args[1] : `debugger.${name}`, target: args[0],
        params: name === "sendCommand" ? args[2] ?? {} : { version: args[1] ?? null }, state: state() });
      let promise;
      try { promise = Reflect.apply(original[name], this, args); }
      catch (error) { append({ kind: "settled", invocation: call?.sequence, ok: false, error: String(error), synchronous: true }); throw error; }
      pending++;
      try { nativeThen.call(promise, value => { pending--; append({ kind: "settled", invocation: call?.sequence, ok: true, value }); },
        error => { pending--; append({ kind: "settled", invocation: call?.sequence, ok: false, error: String(error) }); }); }
      catch { pending--; recordingErrors++; }
      return promise;
    };
    api.debugger[name] = wrappers[name];
  }
  const watched = new Set(["Runtime.executionContextCreated", "Runtime.executionContextDestroyed", "Runtime.executionContextsCleared", "Page.frameNavigated", "Page.frameAttached", "Page.frameDetached", "Target.attachedToTarget", "Target.detachedFromTarget"]);
  const onEvent = (source, method, params) => { if (watched.has(method)) append({ kind: "event", source, method, params }); };
  const onDetach = (source, reason) => append({ kind: "detached", source, reason });
  api.debugger.onEvent.addListener(onEvent); api.debugger.onDetach.addListener(onDetach);
  const snapshot = () => structuredClone({ workerId, tabId, records, pending, overflow, recordingErrors, restored, state: state() });
  const controller = { select(value) { if (!Number.isInteger(value) || value < 0 || tabId !== undefined && value !== tabId) throw Error("Observer tab identity changed"); tabId = value; return snapshot(); },
    snapshot, mark(label) { append({ kind: "marker", label, state: state() }); return snapshot(); },
    restore() { if (!restored) { if (pending) throw Error("Original native calls remain pending");
      for (const name of Object.keys(original)) if (api.debugger[name] !== wrappers[name]) throw Error("Original observer wrapper replaced");
      for (const name of Object.keys(original)) api.debugger[name] = original[name];
      api.debugger.onEvent.removeListener(onEvent); api.debugger.onDetach.removeListener(onDetach); restored = true;
    } const result = snapshot(); if (target.__obuColdWorldLifetime === controller) delete target.__obuColdWorldLifetime; return result; } };
  target.__obuColdWorldLifetime = controller;
  return { workerId };
}

export const coldWorldLifetimeProbePrefix = () => `;(${installColdWorldLifetimeProbe.toString()})(chrome,globalThis);`;

// Original application observations. The three screenshots share this exact
// document, root node and untouched form. Feedback observations never mutate it.
export function installColdWorldLifetimeDocument(config) {
  const originalDocument = document, originalWindow = window, originalRoot = document.documentElement, windowToken = crypto.randomUUID();
  const nodes = new Map(["note", "submit", "form", "panel"].map(id => [id, document.getElementById(id)]));
  const events = [], focus = [], rings = [], errors = [], roots = [], seen = new WeakSet(); let receipt = null, overflow = false;
  const add = (rows, row) => { if (rows.length >= 128) overflow = true; else rows.push({ sequence: rows.length + 1, ...row }); };
  const rect = node => { if (!node) return null; const b = node.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; };
  const observe = () => {
    const current = document.getElementById("open-browser-use-cursor-root");
    if (current && !roots.some(row => row.node === current)) { if (roots.length >= 8) overflow = true; else { const tree = current.shadowRoot ?? current; roots.push({ node: current, tree }); new MutationObserver(observe).observe(tree, { childList: true, subtree: true }); } }
    for (const [rootIndex, root] of roots.entries()) for (const ring of root.tree.querySelectorAll('[data-testid="browser-agent-click"]')) if (!seen.has(ring)) {
      seen.add(ring); const style = getComputedStyle(ring); add(rings, { documentToken: config.documentToken, rootIndex, connected: ring.isConnected, currentRoot: current === root.node,
        rect: rect(ring), modelPoint: { x: parseFloat(ring.style.left), y: parseFloat(ring.style.top) }, color: style.borderTopColor, opacity: Number(style.opacity) });
    }
  };
  new MutationObserver(observe).observe(document, { childList: true, subtree: true }); observe();
  window.coldWorldLifetimeState = window.frameTargetFeedbackState = () => {
    const input = nodes.get("note"), current = document.getElementById("open-browser-use-cursor-root"), selected = roots.find(row => row.node === current), tree = selected?.tree;
    const cursor = tree?.querySelector('[data-testid="browser-agent-cursor"]'), target = tree?.querySelector('[data-testid="browser-agent-target"]'), transform = cursor?.style.transform.match(/^translate3d\(([-\d.]+)px,\s*([-\d.]+)px,/);
    return { business: { key: config.key, documentToken: config.documentToken, windowToken, href: location.href, sameDocument: document === originalDocument,
      sameWindow: window === originalWindow, sameRoot: document.documentElement === originalRoot,
      nodes: [...nodes].map(([id, node]) => ({ id, token: node.dataset.token, connected: node.isConnected, original: node === document.getElementById(id) })),
      value: input.value, activeElement: document.activeElement?.id ?? "", selection: { start: input.selectionStart, end: input.selectionEnd, direction: input.selectionDirection },
      events: structuredClone(events), focus: structuredClone(focus), errors: [...errors], overflow, receipt },
      geometry: { button: rect(nodes.get("submit")), input: rect(input), parents: [], viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio, scrollX, scrollY } },
      rings: structuredClone(rings), feedback: { connected: !!selected?.node.isConnected, currentRoot: !!selected, currentCount: document.querySelectorAll('[id="open-browser-use-cursor-root"]').length,
        rootIndex: selected ? roots.indexOf(selected) : -1, cursor: rect(cursor), target: target && getComputedStyle(target).display !== "none" ? rect(target) : null,
        modelPoint: transform ? { x: Number(transform[1]) + parseFloat(cursor.style.width) / 2, y: Number(transform[2]) + parseFloat(cursor.style.height) / 2 } : null } };
  };
  for (const type of ["input", "click", "submit", "pointerdown", "pointerup", "keydown", "keyup"]) document.addEventListener(type, event => add(events, { type, targetId: event.target.id ?? "", nodeToken: event.target.dataset?.token ?? null, trusted: event.isTrusted,
    value: event.target.value ?? null, ...(["click", "pointerdown", "pointerup"].includes(type) ? { x: event.clientX, y: event.clientY } : {}) }), { capture: true, passive: true });
  for (const type of ["focusin", "focusout"]) document.addEventListener(type, event => add(focus, { type, targetId: event.target.id ?? "", trusted: event.isTrusted }), { capture: true, passive: true });
  nodes.get("form").addEventListener("submit", event => {
    event.preventDefault(); const body = { key: config.key, trustedSubmit: event.isTrusted, business: window.coldWorldLifetimeState().business };
    fetch(`/cold-world-lifetime/post?key=${config.key}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      .then(response => { if (!response.ok) throw Error(`Receipt HTTP ${response.status}`); return response.json(); })
      .then(value => { receipt = value; document.getElementById("receipt").textContent = `Saved ${value.bodySHA256}`; }).catch(error => errors.push(String(error)));
  });
}

export function createColdWorldLifetimeFixtures() {
  const records = new Map();
  return { stats: key => structuredClone(records.get(key)), allStats: () => structuredClone([...records.values()]), handle(request, response, suppliedURL) {
    if (![`${route}page`, `${route}post`].includes(suppliedURL.pathname)) return false;
    const url = new URL(request.url, `http://${request.headers.host}`), key = url.searchParams.get("key");
    if (!/^world-[a-f0-9]{32}$/.test(key ?? "") || !["127.0.0.1", "localhost"].includes(url.hostname)) { response.writeHead(400); response.end("Invalid world fixture request"); return true; }
    if (!records.has(key)) records.set(key, { key, gets: [], posts: [] }); const record = records.get(key);
    if (url.pathname.endsWith("/page")) {
      if (request.method !== "GET" || record.gets.length) { response.writeHead(400); response.end("Original document may load once"); return true; }
      const documentToken = randomUUID(), token = id => `data-token="${key}-${id}"`;
      const bytes = Buffer.from(`<!doctype html><html><head><meta charset="utf-8"><title>Original cold world lifetime</title><style>
html,body{margin:0;background:#eee;color:#333;font:16px sans-serif}*{box-sizing:border-box}#panel{position:absolute;inset:0;background:#eee}label{position:absolute;left:46px;top:20px}#note{position:absolute;left:46px;top:48px;width:280px;height:36px;background:#fafafa;border:1px solid #777}#note:focus{outline:2px solid #555}#submit{position:absolute;left:46px;top:134px;width:280px;height:64px;padding:0 0 0 12px;border:0;margin:0;background:#ddd;color:#333;text-align:left;font:16px sans-serif}#submit:focus{outline:1px solid #555}#receipt{position:absolute;left:46px;top:228px;font-size:12px}
</style></head><body><section id="panel" ${token("panel")}><form id="form" ${token("form")}><label for="note">Original note</label><input id="note" ${token("note")}><button id="submit" ${token("submit")}>Save</button></form><output id="receipt"></output></section><script>(${installColdWorldLifetimeDocument.toString()})(${JSON.stringify({ key, documentToken })});</script></body></html>`);
      record.gets.push({ url: url.href, documentToken, bytes: bytes.length, sha256: hash(bytes) });
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }); response.end(bytes); return true;
    }
    if (request.method !== "POST") { response.writeHead(405); response.end(); return true; }
    const post = { index: record.posts.length + 1, url: url.href }, chunks = []; let size = 0; record.posts.push(post);
    request.on("data", chunk => { size += chunk.length; if (size <= 128 * 1024) chunks.push(chunk); });
    request.once("error", error => { post.error = String(error); }); request.once("aborted", () => { post.error = "Original POST aborted"; });
    request.once("end", () => { const bytes = Buffer.concat(chunks); Object.assign(post, { bodyBytes: size, bodyBase64: bytes.toString("base64"), bodySHA256: hash(bytes) });
      try { assert.ok(size <= 128 * 1024); post.value = JSON.parse(bytes); assert.equal(post.index, 1); assert.equal(post.value.key, key); assert.equal(post.value.trustedSubmit, true);
        assert.equal(record.gets.length, 1); assert.equal(post.value.business.documentToken, record.gets[0].documentToken); assert.equal(post.value.business.href, record.gets[0].url);
        post.receipt = { key, index: post.index, bodySHA256: post.bodySHA256 }; response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify(post.receipt));
      } catch (error) { post.error = errorText(error); response.writeHead(400); response.end("Invalid original world receipt"); }
    }); return true;
  } };
}

// The live set is reconstructed from original Runtime events, not from the
// number of createIsolatedWorld calls (which can return an existing context).
export function coldWorldContexts(probe, frameId) {
  const contexts = new Map();
  for (const row of probe.records) {
    if (row.kind === "detached" && row.source.tabId === probe.tabId && !row.source.sessionId) contexts.clear();
    if (row.kind !== "event" || row.source.tabId !== probe.tabId || row.source.sessionId) continue;
    if (row.method === "Runtime.executionContextsCleared") contexts.clear();
    if (row.method === "Runtime.executionContextDestroyed") {
      const uniqueId = row.params.executionContextUniqueId;
      if (uniqueId !== undefined) {
        assert.ok(typeof uniqueId === "string" && uniqueId.length, "Malformed native context unique ID");
        // A numeric ID may already belong to a successor after navigation.
        for (const [id, context] of contexts) if (context.uniqueId === uniqueId) contexts.delete(id);
      } else contexts.delete(row.params.executionContextId);
    }
    if (row.method === "Runtime.executionContextCreated") contexts.set(row.params.context.id, row.params.context);
  }
  const all = [...contexts.values()].filter(context => context.auxData?.frameId === frameId);
  return { all, defaults: all.filter(context => context.auxData.isDefault === true), worlds: all.filter(context => context.name.startsWith(worldPrefix)) };
}

export function checkColdWorldCardinality(detail) {
  assert.equal(detail.phases.length, 3); assert.equal(new Set(detail.phases.map(phase => phase.native.workerId)).size, 3, "Three real worker identities");
  const original = detail.phases[0].after, originalWorld = detail.phases[0].contexts.worlds[0];
  assert.ok(originalWorld?.uniqueId); assert.ok(originalWorld.name.startsWith(worldPrefix));
  for (const [index, phase] of detail.phases.entries()) {
    assert.equal(phase.native.restored, true); assert.equal(phase.native.pending, 0); assert.equal(phase.native.overflow, false); assert.equal(phase.native.recordingErrors, 0);
    assert.equal(phase.native.state.engineAbsent, true); assert.equal(phase.native.state.privateLeases, 0); assert.equal(phase.native.state.pointerPending, 0);
    assert.equal(phase.contexts.defaults.length, 1, "Actual Runtime domain enumeration must include the original root default context");
    assert.deepEqual(phase.contexts, coldWorldContexts(phase.beforeRestore, phase.tree.frameTree.frame.id));
    assert.equal(phase.contexts.worlds.length, 1, `Original root document accumulated passive worlds after worker generation ${index}`);
    assert.equal(phase.contexts.worlds[0].uniqueId, originalWorld.uniqueId, "Original document's world must be reused across workers");
    assert.equal(phase.contexts.worlds[0].name, originalWorld.name);
    for (const snapshot of [phase.before, phase.after]) {
      for (const name of ["nativeDocumentId", "nativeFrameId", "nativeProcessId"]) assert.equal(snapshot[name], original[name]);
      assert.deepEqual(snapshot.business, original.business); assert.deepEqual(snapshot.geometry, original.geometry);
      assert.equal(snapshot.business.sameDocument, true); assert.equal(snapshot.business.sameWindow, true); assert.equal(snapshot.business.sameRoot, true);
      assert.deepEqual(snapshot.business.events, []); assert.deepEqual(snapshot.business.focus, []); assert.equal(snapshot.business.value, "");
    }
    assert.deepEqual(phase.tree.frameTree.frame.id, detail.phases[0].tree.frameTree.frame.id);
    assert.deepEqual(phase.tree.frameTree.frame.loaderId, detail.phases[0].tree.frameTree.frame.loaderId);
  }
}

export function checkColdWorldNative(phase, tabId, bytes, final = false) {
  const probe = phase.beforeRestore, calls = probe.records.filter(row => row.kind === "call" && row.target.tabId === tabId && !row.target.sessionId), acks = new Map();
  for (const call of calls) { const matches = probe.records.filter(row => row.kind === "settled" && row.invocation === call.sequence); assert.equal(matches.length, 1, `Original ${call.method} settlement`); assert.ok(matches[0].sequence > call.sequence); acks.set(call.sequence, matches[0]); }
  const failures = calls.filter(call => acks.get(call.sequence).ok !== true);
  for (const call of failures) {
    // resetClaimedColdAttachment probes the original explicit claim before a
    // new native attach. Its exact no-client rejection is an observed absence,
    // not a successful ACK and not permission to ignore another native error.
    assert.equal(failures.length, 1); assert.ok(phase.index === 1 || phase.index === 2);
    assert.ok(typeof phase.restart?.oldTarget === "string" && typeof phase.restart.restartedTarget === "string");
    assert.notEqual(phase.restart.oldTarget, phase.restart.restartedTarget); assert.equal(phase.claim?.id, tabId);
    assert.equal(call.method, "Target.getTargetInfo"); assert.deepEqual(call.target, { tabId }); assert.deepEqual(call.params, {});
    const rejected = acks.get(call.sequence);
    assert.equal(rejected.ok, false); assert.equal(rejected.error, `Error: Debugger is not attached to the tab with id: ${tabId}.`);
    assert.equal(rejected.synchronous, undefined); assert.equal(call.state.engineAbsent, true); assert.equal(call.state.attached, false);
    assert.equal(call.state.originalAttachmentSeen, false); assert.equal(call.state.sameAttachment, null);
    const firstAttach = calls.find(row => row.method === "debugger.attach"); assert.ok(firstAttach);
    assert.deepEqual(firstAttach.target, { tabId }); assert.deepEqual(firstAttach.params, { version: "1.3" });
    assert.ok(rejected.sequence < firstAttach.sequence); assert.equal(acks.get(firstAttach.sequence).ok, true);
    const earlier = calls.filter(row => row.sequence < firstAttach.sequence);
    assert.equal(earlier.filter(row => row.method === "Target.getTargetInfo").length, 1);
    assert.ok(earlier.every(row => row === call || row.method === "debugger.detach"));
    for (const row of earlier.filter(row => row !== call)) assert.ok(acks.get(row.sequence).ok === true && acks.get(row.sequence).sequence < call.sequence);
    const enable = calls.find(row => row.method === "Runtime.enable"); assert.ok(enable && acks.get(firstAttach.sequence).sequence < enable.sequence);
  }
  const inputs = calls.filter(row => row.method.startsWith("Input."));
  const expected = final ? [move, move, { type: "mouseMoved", x: 186, y: 66, buttons: 0 },
    { type: "mousePressed", x: 186, y: 66, button: "left", buttons: 1, clickCount: 1 }, { type: "mouseReleased", x: 186, y: 66, button: "left", buttons: 0, clickCount: 1 },
    { text: phase.value }, move, { type: "mousePressed", x: 186, y: 166, button: "left", buttons: 1, clickCount: 1 }, { type: "mouseReleased", x: 186, y: 166, button: "left", buttons: 0, clickCount: 1 }] : [move, move];
  assert.deepEqual(inputs.map(call => call.params), expected, "Only explicitly requested original inputs, no replay");
  assert.deepEqual(inputs.map(call => call.method), expected.map(params => "text" in params ? "Input.insertText" : "Input.dispatchMouseEvent"));
  for (let index = 1; index < inputs.length; index++) assert.ok(acks.get(inputs[index - 1].sequence).sequence < inputs[index].sequence);
  const enable = calls.filter(call => call.method === "Runtime.enable"); assert.equal(enable.length, 1); assert.ok(acks.get(enable[0].sequence).sequence < inputs[0].sequence);
  for (const call of calls.filter(call => call.sequence >= enable[0].sequence)) { assert.equal(call.state.engineAbsent, true); assert.notEqual(call.state.sameAttachment, false, "No cold root attachment migration during the original input/read path"); }
  const worlds = calls.filter(call => call.method === "Page.createIsolatedWorld"); assert.ok(worlds.length >= 1);
  for (const call of worlds) { assert.ok(call.params.worldName.startsWith(worldPrefix)); assert.equal(call.params.frameId, phase.tree.frameTree.frame.id); assert.equal(call.params.grantUniveralAccess, false);
    const context = phase.contexts.all.find(context => context.id === acks.get(call.sequence).value.executionContextId); assert.ok(context); assert.equal(context.name, call.params.worldName); }
  const shots = calls.filter(call => call.method === "Page.captureScreenshot"); assert.equal(shots.length, 1);
  assert.deepEqual(Buffer.from(acks.get(shots[0].sequence).value.data, "base64"), bytes); assert.ok(acks.get(inputs[1].sequence).sequence < shots[0].sequence);
  for (const call of calls) assert.ok(!["DOM.enable", "Target.setAutoAttach", "Runtime.disable"].includes(call.method), `Unexpected caller-domain mutation ${call.method}`);
  return { inputs: inputs.map(call => ({ invocation: call.sequence, ack: acks.get(call.sequence).sequence })), worlds: worlds.map(call => ({ invocation: call.sequence, ack: acks.get(call.sequence).sequence })), screenshot: { invocation: shots[0].sequence, ack: acks.get(shots[0].sequence).sequence } };
}

export function checkColdWorldBusiness(detail) {
  const first = detail.phases[0].before, last = detail.after; assert.equal(detail.server.gets.length, 1); assert.equal(detail.server.posts.length, 1);
  const post = detail.server.posts[0], bytes = Buffer.from(post.bodyBase64, "base64"); assert.equal(post.error, undefined); assert.equal(bytes.length, post.bodyBytes); assert.equal(hash(bytes), post.bodySHA256); assert.deepEqual(JSON.parse(bytes), post.value);
  assert.equal(first.business.documentToken, detail.server.gets[0].documentToken); assert.equal(first.business.href, detail.server.gets[0].url);
  for (const field of ["nativeDocumentId", "nativeFrameId", "nativeProcessId"]) assert.equal(last[field], first[field]);
  for (const field of ["documentToken", "windowToken", "nodes", "sameDocument", "sameWindow", "sameRoot"]) assert.deepEqual(last.business[field], first.business[field]);
  assert.ok(last.business.nodes.every(node => node.original && node.connected)); assert.deepEqual(last.geometry, first.geometry); assert.deepEqual(last.business.errors, []); assert.equal(last.business.overflow, false);
  assert.equal(last.business.value, detail.value); assert.equal(post.value.trustedSubmit, true); assert.deepEqual({ ...post.value.business, receipt: post.receipt }, last.business);
  assert.deepEqual(last.business.events.map(event => [event.type, event.targetId]), [["pointerdown", "note"], ["pointerup", "note"], ["click", "note"], ["input", "note"], ["pointerdown", "submit"], ["pointerup", "submit"], ["click", "submit"], ["submit", "form"]]);
  for (const event of last.business.events) { assert.equal(event.trusted, true); assert.equal(event.nodeToken, `${detail.key}-${event.targetId}`); }
  for (const phase of detail.phases) { assert.deepEqual(phase.after.geometry.button, button); assert.equal(phase.after.feedback.connected, true); assert.equal(phase.after.feedback.currentRoot, true); assert.equal(phase.after.feedback.currentCount, 1);
    for (const key of ["x", "y", "width", "height"]) assert.ok(Math.abs(phase.after.feedback.target?.[key] - button[key]) <= 1);
    assert.ok(phase.pixels.cursorDark >= 8 * phase.pixels.scale ** 2); for (const count of Object.values(phase.pixels.edges)) assert.ok(count >= 4 * phase.pixels.scale ** 2);
  }
  const rings = last.rings; assert.equal(rings.length, 2); for (const [index, ring] of rings.entries()) { assert.equal(ring.documentToken, first.business.documentToken); assert.equal(ring.connected, true); assert.equal(ring.currentRoot, true); assert.equal(ring.color, "rgb(20, 184, 166)"); assert.ok(ring.opacity > 0);
    const expected = { x: 186, y: index === 0 ? 66 : 166 }; for (const axis of ["x", "y"]) { assert.equal(ring.modelPoint[axis], expected[axis]); assert.ok(Math.abs(ring.rect[axis] + ring.rect[axis === "x" ? "width" : "height"] / 2 - expected[axis]) <= 1.1); }
  }
}

async function readDocument(worker, tabId, frame) {
  const rows = await worker.evaluate(`chrome.scripting.executeScript({target:{tabId:${tabId},documentIds:[${JSON.stringify(frame.documentId)}]},world:'MAIN',func:()=>window.coldWorldLifetimeState?.()??null})`);
  assert.equal(rows.length, 1); assert.equal(rows[0].documentId, frame.documentId); assert.equal(rows[0].frameId, 0); assert.ok(rows[0].result);
  return { ...rows[0].result, nativeDocumentId: frame.documentId, nativeFrameId: frame.frameId, nativeProcessId: frame.processId };
}

// This is a bounded diagnostic precondition, not part of production input.
// Return terminal failures from `until`: the runner intentionally retries
// callback exceptions, whereas a disabled identity must fail immediately.
export async function waitForColdWorldRealm({ getWorker, until, evidence = { observations: [] } }) {
  const terminal = await until(async () => {
    try {
      const value = await getWorker().evaluate(`(()=>{const realm=globalThis.__integrationBackend?.nativePointerRealm;return realm?{mode:'persistent-identity',snapshot:realm.snapshot()}:{mode:'legacy-module'}})()`);
      evidence.observations.push(value);
      assert.ok(evidence.observations.length <= 64, "Bounded realm readiness observations");
      if (value?.mode === "legacy-module") return { value };
      assert.equal(value?.mode, "persistent-identity");
      if (value.snapshot?.state === "disabled") return { error: Error(`Original native pointer realm disabled: ${value.snapshot.reason}`) };
      if (value.snapshot?.available === true) { assert.equal(value.snapshot.state, "ready"); return { value }; }
      assert.equal(value.snapshot?.available, false); assert.equal(value.snapshot.state, "loading");
      return false;
    } catch (error) { return { error }; }
  }, "original optional pointer realm readiness", 5000);
  if (terminal.error) throw terminal.error;
  Object.assign(evidence, terminal.value); return evidence;
}

export async function checkColdWorldLifetime({ connectBrowser, getWorker, restartWorker, fixtureURL, fixtures, until, saveArtifact, saveDetail, closeTab, checkEnd }) {
  const detail = { key: `world-${randomUUID().replaceAll("-", "")}`, phases: [], restarts: [], tabIds: [], cleanupErrors: [],
    boundary: "One original root document, three real worker generations. Caller Runtime.enable observes native existing-context enumeration; explicit public CDP inputs and PNGs use production cold feedback. Does not establish iframe, document replacement, or arbitrary caller-domain coexistence coverage." };
  let browser, tab, failure; const pngs = [], control = (method, args = []) => getWorker().evaluate(`(()=>{const p=globalThis.__obuColdWorldLifetime;if(!p)throw Error('Cold world prefix missing');return p[${JSON.stringify(method)}](...${JSON.stringify(args)})})()`);
  const cleanup = async (stage, fn) => { try { return await fn(); } catch (error) { detail.cleanupErrors.push({ stage, error: errorText(error) }); failure ??= error; } };
  try {
    browser = await connectBrowser("cold-world-lifetime"); await browser.client.beginTurn("cold-world-original-0");
    // createTab's public default is inactive; it has no public `active` option.
    tab = await browser.newTab(); detail.tabIds.push(tab.id); detail.tabId = tab.id; detail.url = new URL(`${route}page?key=${detail.key}`, fixtureURL).href;
    detail.createdTab = await getWorker().evaluate(`chrome.tabs.get(${tab.id})`); assert.equal(detail.createdTab.active, false);
    await control("select", [tab.id]); await browser.cdp.navigate(tab.id, detail.url);
    await until(async () => { const frames = await getWorker().evaluate(`chrome.webNavigation.getAllFrames({tabId:${tab.id}})`); const candidates = frames.filter(frame => frame.frameId === 0 && frame.url === detail.url && frame.documentLifecycle === "active" && !frame.errorOccurred); if (candidates.length !== 1) return false; detail.frames = candidates; return true; }, "original cold world root document", 5000);
    for (let index = 0; index < 3; index++) {
      const phase = { index, scope: scopeOf(browser) }; detail.phases.push(phase);
      if (index) { phase.restart = await restartWorker(); detail.restarts.push(phase.restart); await control("select", [tab.id]);
        phase.beginTurn = await browser.client.beginTurn(`cold-world-original-${index}`); phase.claim = await browser.client.claimUserTab(tab.id); phase.scope = scopeOf(browser); }
      phase.before = await readDocument(getWorker(), tab.id, detail.frames[0]); phase.tree = await browser.cdp.call(tab.id, "Page.getFrameTree", {});
      phase.beforeRuntimeEnable = await control("mark", [`generation-${index}-before-caller-runtime-enable`]);
      phase.runtimeEnable = await browser.cdp.call(tab.id, "Runtime.enable", {});
      phase.afterRuntimeEnable = await control("mark", [`generation-${index}-after-caller-runtime-enable`]);
      phase.realmReadiness = { observations: [] };
      await waitForColdWorldRealm({ getWorker, until, evidence: phase.realmReadiness });
      phase.moves = []; for (let repetition = 0; repetition < 2; repetition++) phase.moves.push(await browser.cdp.call(tab.id, "Input.dispatchMouseEvent", move));
      await getWorker().evaluate(`chrome.scripting.executeScript({target:{tabId:${tab.id},documentIds:[${JSON.stringify(detail.frames[0].documentId)}]},world:'MAIN',func:${waitForFrameTargetFeedback.toString()},args:[${JSON.stringify({ x: move.x, y: move.y, rectangle: button })}]})`);
      const shot = await browser.cdp.call(tab.id, "Page.captureScreenshot", { format: "png" }); const bytes = Buffer.from(shot.data, "base64"); pngs.push(bytes);
      phase.artifact = `cold-world-lifetime-generation-${index}.png`; await saveArtifact(phase.artifact, bytes);
      phase.after = await readDocument(getWorker(), tab.id, detail.frames[0]); phase.pixels = measureFrameTargetPixels(bytes, phase.after.geometry);
      await until(async () => { const value = await control("snapshot"); return value.pending === 0 && value.state.pointerPending === 0 && value.state.privateLeases === 0; }, "original cold world native reads settle", 5000);
      phase.beforeRestore = await control("mark", [`generation-${index}-before-restart-or-business`]); phase.contexts = coldWorldContexts(phase.beforeRestore, phase.tree.frameTree.frame.id);
      if (index < 2) {
        phase.restartInputBoundary = await getWorker().evaluate(`(async()=>{const b=__integrationBackend,r=b.inputTracker.attachments.get(${tab.id});await b.browserLifetime.writes;return {status:await b.getAutomationControlStatus(),inflight:r?.inflight.size??null,states:[...(r?.states.values()??[])].map(s=>({buttons:[...s.buttons.keys()],keys:[...s.keys.keys()]})),durable:await chrome.storage.local.get('OPEN_BROWSER_USE_INPUT_RISKS')}})()`);
        assert.equal(phase.restartInputBoundary.status.inputBlocked, false); assert.equal(phase.restartInputBoundary.inflight, 0);
        assert.ok(phase.restartInputBoundary.states.every(state => state.buttons.length === 0 && state.keys.length === 0));
        assert.equal(phase.restartInputBoundary.durable.OPEN_BROWSER_USE_INPUT_RISKS.version, 1);
        assert.ok(phase.restartInputBoundary.durable.OPEN_BROWSER_USE_INPUT_RISKS.risks.every(risk => risk.tabId !== tab.id));
        phase.native = await control("restore"); await saveDetail(detail);
      }
    }
    const last = detail.phases.at(-1); detail.value = last.value = "Original same document across two worker restarts π";
    const mouse = params => browser.cdp.call(tab.id, "Input.dispatchMouseEvent", params);
    await mouse({ type: "mouseMoved", x: 186, y: 66, buttons: 0 });
    await mouse({ type: "mousePressed", x: 186, y: 66, button: "left", buttons: 1, clickCount: 1 });
    await mouse({ type: "mouseReleased", x: 186, y: 66, button: "left", buttons: 0, clickCount: 1 });
    await browser.cdp.call(tab.id, "Input.insertText", { text: detail.value }); await mouse(move);
    await mouse({ type: "mousePressed", x: 186, y: 166, button: "left", buttons: 1, clickCount: 1 });
    await mouse({ type: "mouseReleased", x: 186, y: 166, button: "left", buttons: 0, clickCount: 1 });
    await until(async () => { detail.after = await readDocument(getWorker(), tab.id, detail.frames[0]); return !!detail.after.business.receipt; }, "original world lifetime receipt", 5000);
    await until(async () => { const value = await control("snapshot"); return value.pending === 0 && value.state.pointerPending === 0 && value.state.privateLeases === 0; }, "original final native reads settle", 5000);
    last.beforeRestore = await control("mark", ["after-original-business"]); last.contexts = coldWorldContexts(last.beforeRestore, last.tree.frameTree.frame.id);
    if (checkEnd) await cleanup("original-turn-end", async () => { detail.endCleanup = await checkEnd(detail, browser); });
  } catch (error) { failure ??= error; detail.workflowError = errorText(error); }
  finally {
    await cleanup("original-server-ledger", () => { detail.server = fixtures.stats(detail.key); });
    if (browser) await cleanup("original-owner-finalize", async () => { detail.finalizeScope = scopeOf(browser); detail.finalized = await browser.client.finalizeTabs([]); });
    if (tab) await cleanup("original-exact-tab-close", async () => { const tabs = await getWorker().evaluate(`chrome.tabs.query({})`); if (tabs.some(value => value.id === tab.id)) await closeTab(tab); });
    if (browser) await cleanup("original-owner-close", () => browser.close());
    await cleanup("original-observer-drain", () => until(async () => { const probe = await control("snapshot"); return probe.pending === 0; }, "original cold world observer drain", 5000));
    await cleanup("original-observer-restore", async () => { const last = detail.phases.at(-1); const value = await control("restore"); if (last) last.native = value; else detail.failureNative = value; });
    await cleanup("original-exact-inventory", async () => { detail.cleanup = await getWorker().evaluate(`(async()=>({tabs:(await chrome.tabs.query({})).filter(t=>t.id===${tab?.id ?? -1}),targets:(await chrome.debugger.getTargets()).filter(t=>t.tabId===${tab?.id ?? -1})}))()`); assert.deepEqual(detail.cleanup, { tabs: [], targets: [] }); });
  }
  // A world-growth failure must not prevent the original POST, PNGs, end-hide,
  // and exact tab cleanup from being collected on the old production source.
  if (!failure) try {
    checkColdWorldBusiness(detail);
    for (const [index, phase] of detail.phases.entries()) phase.nativeProof = checkColdWorldNative(phase, detail.tabId, pngs[index], index === 2);
    checkColdWorldCardinality(detail);
  } catch (error) { failure = error; detail.oracleError = errorText(error); }
  detail.passed = !failure; if (failure) detail.error = errorText(failure);
  try { await saveDetail(detail); } catch (error) { failure ??= error; }
  if (failure) throw failure; return detail;
}
