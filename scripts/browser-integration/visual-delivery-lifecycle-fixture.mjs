import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { installBoundingGeometryProbe } from "./bounding-geometry-fixture.mjs";
import { frameTargetURLs, frameTargetGeometry, selectFrameTargetDocuments, waitForFrameTargetFeedback,
  measureFrameTargetPixels, checkFrameTargetBusiness } from "./frame-target-feedback-fixture.mjs";

const errorText = error => String(error?.message ?? error), json = JSON.stringify;
const outcome = promise => Promise.resolve(promise).then(value => ({ ok: true, value, at: Date.now() }), error => ({ ok: false, error: errorText(error), at: Date.now() }));
const scopeOf = browser => ({ session_id: browser.client.sessionId, turn_id: browser.client.turnId, control_epoch: browser.client.controlEpoch });
const center = box => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
export const visualDeliveryScenarios = Object.freeze([
  { name: "end-before-send", operation: "turnEnded", mode: "before-send", messageType: "OPEN_BROWSER_USE_CURSOR" },
  { name: "pause-after-ack", operation: "pause", mode: "after-ack", messageType: "OPEN_BROWSER_USE_CURSOR" },
  { name: "detach-before-pointer", operation: "detach", mode: "before-send", messageType: "OPEN_BROWSER_USE_POINTER_EVENT" }
].map(Object.freeze));

// Test-only delivery fault. "before-send" has NOT called the original Chrome
// API while held. "after-ack" has the original fulfilled Promise/result and
// delays only its delivery to production. Neither is natural Chrome reordering.
export function installVisualDeliveryProbe(api, target, backend, options) {
  const { id, tabId, documentId, scope, mode, messageType, holdTimeoutMs = 30000 } = options ?? {};
  if (!id || !Number.isSafeInteger(tabId) || !documentId || !scope?.session_id || !scope.turn_id || !Number.isSafeInteger(scope.control_epoch) ||
    !["before-send", "after-ack"].includes(mode) || !["OPEN_BROWSER_USE_CURSOR", "OPEN_BROWSER_USE_POINTER_EVENT"].includes(messageType) ||
    !Number.isInteger(holdTimeoutMs) || holdTimeoutMs < 20 || holdTimeoutMs > 30000 || target.__obuVisualDelivery) throw Error("Invalid visual delivery observer");
  const original = api.tabs.sendMessage, previousRPC = target.__integrationNativeRPCObserver, nativeThen = Promise.prototype.then;
  const records = [], requests = new Map(), waiters = new Set(); let sequence = 0, selected, selectedPromise, nativePending = 0, deliveryPending = 0;
  let released = false, restored = false, watchdog = false, overflow = false, recordingErrors = 0, timer, releaseGate;
  const gate = new Promise(resolve => { releaseGate = resolve; });
  const append = value => {
    try { const row = { sequence: ++sequence, at: Date.now(), ...value };
      if (records.length >= 2048 || jsonSize(row) > 128 * 1024) overflow = true; else records.push(row);
      for (const wake of [...waiters]) wake(); return row;
    } catch { recordingErrors++; return null; }
  };
  function jsonSize(value) { return JSON.stringify(value).length; }
  const snapshot = () => {
    const registry = backend.visualDeliveries, pending = registry?.pending instanceof Set ? [...registry.pending] : null;
    return structuredClone({ id, tabId, documentId, scope, mode, messageType, records, selected: selected?.sequence ?? null,
      nativePending, deliveryPending, released, restored, watchdog, overflow, recordingErrors,
      backend: { supported: !!pending, exactPending: pending?.some(record => record.promise === selectedPromise) ?? false,
        pending: pending?.map(record => ({ kind: record.kind, scope: record.scope })) ?? null,
        cleanupCount: registry?.cleanups instanceof Set ? registry.cleanups.size : null,
        ending: backend.endingSessions?.has(scope.session_id) ?? false,
        tabReleasing: backend.controlReleases?.has(tabId) ?? false,
        automation: backend.automationControl.status(), cleanupTimeoutMs: backend.automationCleanupTimeoutMs } });
  };
  const release = reason => { if (!released) { released = true; clearTimeout(timer); append({ kind: "release", reason }); releaseGate(); } return snapshot(); };
  const hold = call => { deliveryPending++; append({ kind: "held", call: call.sequence, nativeInvoked: mode === "after-ack" });
    if (!released) timer = setTimeout(() => { watchdog = true; release("watchdog"); }, holdTimeoutMs); };
  function wrapper(...args) {
    const [destination, message, destinationOptions] = args;
    if (destination !== tabId || !/^OPEN_BROWSER_USE_(?:PING$|CURSOR|POINTER_EVENT|TARGET_RECT)/.test(message?.type ?? "")) return Reflect.apply(original, this, args);
    const call = append({ kind: "call", tabId: destination, message: structuredClone(message), options: structuredClone(destinationOptions ?? null) });
    const matches = !selected && destinationOptions?.documentId === documentId && message.type === messageType &&
      message.sessionId === scope.session_id && message.turnId === scope.turn_id;
    if (matches) { selected = call; append({ kind: "selected", call: call.sequence }); }
    const invoke = () => {
      append({ kind: "native-invoke", call: call.sequence }); let native;
      try { native = Reflect.apply(original, this, args); }
      catch (error) { append({ kind: "native-settled", call: call.sequence, ok: false, error: String(error) }); throw error; }
      nativePending++;
      try { nativeThen.call(native, value => { nativePending--; append({ kind: "native-settled", call: call.sequence, ok: true, value: structuredClone(value) }); },
        error => { nativePending--; append({ kind: "native-settled", call: call.sequence, ok: false, error: String(error) }); }); }
      catch { nativePending--; recordingErrors++; }
      return native;
    };
    if (!matches) return invoke();
    if (mode === "before-send") { hold(call); selectedPromise = gate.then(invoke); }
    else selectedPromise = invoke().then(value => { hold(call); return gate.then(() => value); });
    selectedPromise.then(value => { deliveryPending--; append({ kind: "delivered", call: call.sequence, ok: true, value: structuredClone(value) }); },
      error => { if (deliveryPending) deliveryPending--; append({ kind: "delivered", call: call.sequence, ok: false, error: String(error) }); });
    return selectedPromise;
  }
  const onRPC = (direction, message) => {
    previousRPC?.(direction, message);
    const p = message.params;
    if (direction === "request" && p?.session_id === scope.session_id && p.turn_id === scope.turn_id && p.control_epoch === scope.control_epoch &&
      ["turnEnded", "detach", "attach"].includes(message.method)) {
      requests.set(message.id, message.method); append({ kind: "request", method: message.method, id: message.id, params: structuredClone(p) });
    } else if (direction === "response" && requests.has(message.id)) append({ kind: "response", method: requests.get(message.id), id: message.id,
      ok: !message.error, ...(message.error ? { error: String(message.error.message ?? message.error) } : { value: structuredClone(message.result) }) });
  };
  function wait(kind, timeoutMs = 5000) {
    if (!["held", "drained", "cleanup-response"].includes(kind)) throw Error("Unknown visual delivery handshake");
    return new Promise((resolve, reject) => {
      let interval, timeout; const finish = (error, value) => { clearInterval(interval); clearTimeout(timeout); waiters.delete(check); error ? reject(error) : resolve(value); };
      const check = () => { const s = snapshot();
        const done = kind === "held" ? s.deliveryPending === 1 && !s.released : kind === "drained" ? s.released && s.nativePending === 0 && s.deliveryPending === 0 :
          s.records.some(row => row.kind === "response" && ["turnEnded", "detach"].includes(row.method));
        if (s.watchdog || s.overflow || s.recordingErrors) finish(Error("Visual delivery evidence watchdog/overflow/error")); else if (done) finish(null, s); };
      interval = setInterval(check, 10); timeout = setTimeout(() => finish(Error(`Visual delivery handshake timed out: ${kind}`)), timeoutMs); waiters.add(check); check();
    });
  }
  const controller = { id, snapshot, wait, release, restore() {
    if (nativePending || deliveryPending) throw Error("Cannot restore while original visual delivery is unresolved");
    if (api.tabs.sendMessage !== wrapper || target.__integrationNativeRPCObserver !== onRPC || target.__obuVisualDelivery !== controller) throw Error("Visual delivery observer identity changed");
    clearTimeout(timer); api.tabs.sendMessage = original;
    if (previousRPC) target.__integrationNativeRPCObserver = previousRPC; else delete target.__integrationNativeRPCObserver;
    delete target.__obuVisualDelivery; restored = true; return snapshot();
  } };
  api.tabs.sendMessage = wrapper; target.__integrationNativeRPCObserver = onRPC; target.__obuVisualDelivery = controller; return snapshot();
}

export function checkVisualDeliveryTrace(probe) {
  assert.equal(probe.restored, true); assert.equal(probe.watchdog, false); assert.equal(probe.overflow, false); assert.equal(probe.recordingErrors, 0);
  assert.equal(probe.nativePending, 0); assert.equal(probe.deliveryPending, 0); assert.equal(probe.released, true);
  assert.ok(probe.records.every((row, index) => row.sequence === index + 1));
  const one = kind => { const rows = probe.records.filter(row => row.kind === kind && (row.call === probe.selected || kind === "release")); assert.equal(rows.length, 1, `Exactly one ${kind}`); return rows[0]; };
  const call = probe.records.find(row => row.sequence === probe.selected), invoked = one("native-invoke"), ack = one("native-settled"), held = one("held"), release = one("release"), delivered = one("delivered");
  assert.equal(call.kind, "call"); assert.equal(call.message.type, probe.messageType); assert.equal(call.message.sessionId, probe.scope.session_id); assert.equal(call.message.turnId, probe.scope.turn_id);
  assert.deepEqual(call.options, { documentId: probe.documentId }); assert.equal(call.tabId, probe.tabId); assert.equal(ack.ok, true); assert.deepEqual(ack.value, { ok: true });
  assert.equal(delivered.ok, true); assert.deepEqual(delivered.value, ack.value); assert.ok(ack.sequence < delivered.sequence); assert.ok(release.sequence < delivered.sequence);
  if (probe.mode === "before-send") { assert.equal(held.nativeInvoked, false); assert.ok(held.sequence < release.sequence && release.sequence < invoked.sequence && invoked.sequence < ack.sequence); }
  else { assert.equal(held.nativeInvoked, true); assert.ok(invoked.sequence < ack.sequence && ack.sequence < held.sequence && held.sequence < release.sequence); }
  return { selected: call.sequence, invoked: invoked.sequence, ack: ack.sequence, held: held.sequence, release: release.sequence, delivered: delivered.sequence };
}

const hidden = row => row.visual.openLayers === 0 && row.visual.rings === 0 && (row.visual.opacity === null || row.visual.opacity === "0") && row.visual.targetVisible === false;
export function checkVisualReceiverProof(probe) {
  const selected = probe.records.find(row => row.sequence === probe.selected), receiverToken = selected?.message.receiverToken;
  assert.equal(typeof receiverToken, "string"); assert.ok(receiverToken);
  const ping = probe.records.filter(row => row.kind === "call" && row.message.type === "OPEN_BROWSER_USE_PING" && row.sequence < selected.sequence).at(-1);
  assert.ok(ping, "Original visual publication must have its native PING handshake"); assert.equal(ping.tabId, probe.tabId); assert.deepEqual(ping.options, { documentId: probe.documentId });
  const invoked = probe.records.filter(row => row.kind === "native-invoke" && row.call === ping.sequence), acks = probe.records.filter(row => row.kind === "native-settled" && row.call === ping.sequence);
  assert.equal(invoked.length, 1); assert.equal(acks.length, 1); assert.equal(acks[0].ok, true); assert.deepEqual(acks[0].value, { ok: true, receiverToken });
  assert.ok(ping.sequence < invoked[0].sequence && invoked[0].sequence < acks[0].sequence && acks[0].sequence < selected.sequence);
  return { ping: ping.sequence, ack: acks[0].sequence, receiverToken };
}
export function checkVisualFinalHide(item, trace) {
  const probe = item.probe;
  let records = probe.records, upperSequence;
  if (item.operation === "pause") {
    // The popup reply is outside the native RPC observer. Retain a same-worker
    // sequence checkpoint immediately after successful Retry Pause, before
    // Resume. This proves both observations by that point, not cross-clock order.
    const checkpoint = item.retryPauseProbe;
    assert.equal(checkpoint?.id, probe.id); assert.equal(checkpoint.selected, probe.selected);
    assert.ok(checkpoint.records.length <= records.length); assert.deepEqual(records.slice(0, checkpoint.records.length), checkpoint.records);
    records = checkpoint.records; upperSequence = (records.at(-1)?.sequence ?? 0) + 1;
  } else {
    const response = records.filter(row => row.kind === "response" && row.method === item.operation);
    assert.equal(response.length, 1); assert.equal(response[0].ok, true); upperSequence = response[0].sequence;
  }
  const candidates = records.filter(row => row.kind === "call" && row.message.type === "OPEN_BROWSER_USE_CURSOR_STATE" &&
    row.message.state?.isVisible === false && row.sequence > trace.delivered && row.sequence < upperSequence);
  assert.ok(candidates.length, "Original cleanup lacks a final hidden STATE after actual delivery settled");
  const call = candidates.at(-1), invokes = records.filter(row => row.kind === "native-invoke" && row.call === call.sequence),
    acks = records.filter(row => row.kind === "native-settled" && row.call === call.sequence);
  assert.equal(call.tabId, probe.tabId); assert.deepEqual(call.options, { documentId: probe.documentId }, "Final hide must target only the original document");
  assert.equal(invokes.length, 1); assert.equal(acks.length, 1, "Final hidden STATE requires its actual native settlement");
  const receiver = checkVisualReceiverProof(probe); item.receiverProof = receiver;
  assert.equal(call.message.receiverToken, receiver.receiverToken, "Final hide must address the original receiver lifetime");
  const invoke = invokes[0], ack = acks[0]; assert.equal(ack.ok, true); assert.deepEqual(ack.value, { ok: true, receiverToken: receiver.receiverToken });
  assert.ok(call.sequence < invoke.sequence && invoke.sequence < ack.sequence && ack.sequence < upperSequence, "Final hide ACK is too late for the cleanup boundary");
  return { call: call.sequence, invocation: invoke.sequence, ack: ack.sequence, upperSequence, receiverToken: receiver.receiverToken,
    authority: item.operation === "pause" ? "hidden ACK and successful popup reply observed before Resume" : "hidden ACK before original cleanup RPC success" };
}
export function checkVisualDeliveryBoundary(item) {
  const trace = checkVisualDeliveryTrace(item.probe); item.deliveryProof = trace;
  assert.equal(item.held.deliveryPending, 1); assert.equal(item.held.released, false);
  assert.equal(item.atBoundaryProbe.deliveryPending, 1); assert.equal(item.atBoundaryProbe.released, false);
  if (item.operation === "pause") {
    assert.equal(item.controlOutcome.ok, true); assert.equal(item.controlOutcome.value.ok, false);
    assert.match(item.controlOutcome.value.error, /^OBU_AUTOMATION_PAUSE_FAILED:.*OBU_AUTOMATION_CLEANUP_TIMEOUT/s);
    assert.equal(item.atBoundaryProbe.backend.automation.state, "error"); assert.equal(item.atBoundaryProbe.backend.automation.cleanupComplete, false);
    assert.ok(item.controlOutcome.at - item.controlStartedAt >= 10000);
    assert.equal(item.retryPause.ok, true); assert.equal(item.retryPause.status.cleanupComplete, true); assert.equal(item.resumed.ok, true); assert.equal(item.resumed.status.inputBlocked, false);
  } else {
    assert.equal(item.controlOutcome.ok, false, "Control falsely completed while original visual delivery was held"); assert.match(item.controlOutcome.error, /timed out|timeout/i);
    const responses = item.probe.records.filter(row => row.kind === "response" && row.method === item.operation); assert.equal(responses.length, 1); assert.equal(responses[0].ok, true); assert.ok(responses[0].sequence > trace.delivered);
  }
  if (item.operation === "turnEnded") { assert.equal(item.blockedSuccessor.ok, false); assert.match(item.blockedSuccessor.error, /OBU_CONTROL_ENDING/); }
  if (item.operation === "detach") { assert.equal(item.blockedSuccessor.ok, false); assert.match(item.blockedSuccessor.error, /timed out|timeout/i); }
  if (item.operation === "pause") { assert.equal(item.blockedSuccessor.ok, false); assert.match(item.blockedSuccessor.error, /OBU_AUTOMATION_PAUSED/); }
  item.finalHideProof = checkVisualFinalHide(item, trace);
  assert.equal(item.atBoundaryProbe.backend.exactPending, true, "Original returned API Promise must remain in production drain");
  assert.equal(item.atBoundaryProbe.backend.cleanupTimeoutMs, 10000);
}
export function checkVisualDeliveryEvidence(item) {
  checkFrameTargetBusiness(item); checkVisualDeliveryBoundary(item);
  for (const rows of [item.atBoundary, item.afterRelease, item.hiddenAgain, item.recovered, item.finalHidden]) for (let index = 0; index < item.after.length; index++) {
    assert.equal(rows[index].nativeDocumentId, item.after[index].nativeDocumentId); assert.deepEqual(rows[index].business, item.after[index].business); assert.deepEqual(rows[index].geometry, item.after[index].geometry);
  }
  assert.ok(item.afterRelease.every(hidden), "Late original delivery revived ended feedback"); assert.ok(item.hiddenAgain.every(hidden)); assert.ok(item.hiddenObservedMs >= 550); assert.ok(item.finalHidden.every(hidden));
  assert.equal(item.freshScope.session_id, item.scope.session_id); assert.notEqual(item.freshScope.turn_id, item.scope.turn_id);
  if (item.operation !== "detach") assert.ok(item.freshScope.control_epoch > item.scope.control_epoch);
  assert.ok(item.recovered[0].visual.opacity !== "0"); assert.equal(item.recovered[0].visual.openLayers, 1); assert.equal(item.recovered[0].visual.targetVisible, true);
  assert.deepEqual(item.recovered.map(row => row.rings), item.hiddenAgain.map(row => row.rings), "Recovery hover replayed an old click effect");
  assert.equal(item.server.posts.length, 1); assert.deepEqual(item.cleanupInventory, { tabs: [], targets: [] });
  const native = item.native; assert.equal(native.restored, true); assert.equal(native.pending, 0); assert.equal(native.overflow, false); assert.equal(native.recordingErrors, 0);
  const invokes = native.records.filter(row => row.kind === "invoke"), shots = invokes.filter(row => row.method === "Page.captureScreenshot"); assert.equal(shots.length, 2);
  for (let index = 0; index < shots.length; index++) { const ack = native.records.filter(row => row.kind === "settled" && row.invocation === shots[index].sequence); assert.equal(ack.length, 1); assert.equal(ack[0].ok, true); assert.equal(ack[0].result.data, item.pngBase64[index]); }
  const buttons = invokes.filter(row => row.sequence > shots[0].sequence && row.method === "Input.dispatchMouseEvent" && ["mousePressed", "mouseReleased"].includes(row.params.type));
  assert.deepEqual(buttons.map(row => row.params.type), ["mousePressed", "mouseReleased"]);
  for (const call of buttons) { const ack = native.records.filter(row => row.kind === "settled" && row.invocation === call.sequence); assert.equal(ack.length, 1); assert.equal(ack[0].ok, true); }
  for (const pixels of item.pixels) { assert.ok(pixels.cursorDark >= 8 * pixels.scale ** 2); for (const count of Object.values(pixels.edges)) assert.ok(count >= 4 * pixels.scale ** 2); }
}

async function readDocuments(worker, item) {
  const rows = await worker.evaluate(`chrome.scripting.executeScript({target:{tabId:${item.tabId},documentIds:${json(item.frames.map(frame=>frame.documentId))}},world:'MAIN',func:()=>{
    const state=window.frameTargetFeedbackState(),host=document.getElementById('open-browser-use-cursor-root'),tree=host?.shadowRoot,
      cursor=tree?.querySelector('[data-testid="browser-agent-cursor"]'),target=tree?.querySelector('[data-testid="browser-agent-target"]');
    return {...state,visual:{openLayers:tree?.querySelectorAll(':popover-open').length??0,rings:tree?.querySelectorAll('[data-testid="browser-agent-click"]').length??0,
      opacity:cursor?getComputedStyle(cursor).opacity:null,targetVisible:!!target&&getComputedStyle(target).display!=='none'}};
  }})`);
  return item.frames.map(frame => { const matches = rows.filter(row => row.frameId === frame.frameId && row.documentId === frame.documentId); assert.equal(matches.length, 1); assert.ok(matches[0].result?.business);
    return { ...matches[0].result, nativeFrameId: frame.frameId, nativeDocumentId: frame.documentId, nativeProcessId: frame.processId }; });
}

export async function checkVisualDeliveryLifecycle({ connectBrowser, getWorker, popup, fixtureURL, fixtures, until, saveArtifact, saveDetail, closeTab }) {
  if (!popup) throw Error("Visual delivery Pause case requires the existing trusted popup");
  const detail = { cases: [], tabIds: [], cleanupErrors: [], boundary: "Controlled before-original-send and after-original-ACK delivery gates. These are not naturally observed Chrome reordering. Original public input is never replayed. Pause uses the existing trusted action popup; no popup/focus allowance is created." }; let failure;
  for (const scenario of visualDeliveryScenarios) {
    const item = { ...scenario, key: `frame-feedback-${randomUUID().replaceAll("-", "")}`, layout: "same", value: `Original ${scenario.name} π note`, cleanupErrors: [], pngBase64: [], pixels: [] }; detail.cases.push(item);
    let owner, tab, visualInstalled = false, nativeInstalled = false, pauseAttempted = false, caseFailure;
    const cleanup = async (stage, fn) => { try { return await fn(); } catch (error) { item.cleanupErrors.push({ stage, error: errorText(error) }); caseFailure ??= error; } };
    const control = (method, args = []) => getWorker().evaluate(`(()=>{const p=globalThis.__obuVisualDelivery;if(p?.id!==${json(item.key)})throw Error('Original visual observer missing');return p[${json(method)}](...${json(args)})})()`);
    const popupCall = message => popup.evaluate(`chrome.runtime.sendMessage(${json(message)})`);
    const savePNG = async label => { const shot = await tab.screenshot(); assert.equal(shot.mimeType, "image/png"); const bytes = Buffer.from(shot.base64, "base64"), name = `visual-delivery-${item.name}-${label}.png`;
      await saveArtifact(name, bytes); item.pngBase64.push(shot.base64); item.pixels.push(measureFrameTargetPixels(bytes, item.geometry)); (item.artifacts ??= []).push(name); };
    try {
      owner = await connectBrowser(`visual-delivery-${item.name}`); await owner.client.beginTurn(`original-${item.name}`);
      item.urls = frameTargetURLs(fixtureURL, item.key, "same"); tab = await owner.newTab({ url: item.urls.root }); item.tabId = tab.id; detail.tabIds.push(tab.id); item.scope = scopeOf(owner);
      await getWorker().evaluate(`(${installBoundingGeometryProbe.toString()})(chrome,globalThis,${json({ id: item.key, tabId: tab.id })})`); nativeInstalled = true;
      const leaf = tab.frameLocator("#frame"); await leaf.locator("#note").waitFor({ state: "visible", timeoutMs: 5000 });
      await until(async () => { const frames = selectFrameTargetDocuments(await getWorker().evaluate(`chrome.webNavigation.getAllFrames({tabId:${tab.id}})`), item.urls, "same"); if (!frames) return false; item.frames = frames; return true; }, "original visual lifecycle documents", 5000);
      await leaf.locator("#note").fill(item.value); item.before = await readDocuments(getWorker(), item); item.geometry = frameTargetGeometry(item.before, "same");
      await leaf.locator("#submit").hover(); await tab.evaluate(`(${waitForFrameTargetFeedback.toString()})(${json(center(item.geometry.button))})`, { awaitPromise: true });
      await savePNG("original"); item.rendered = await readDocuments(getWorker(), item);
      item.installation = await getWorker().evaluate(`(${installVisualDeliveryProbe.toString()})(chrome,globalThis,__integrationBackend,${json({ id: item.key, tabId: tab.id, documentId: item.frames[0].documentId, scope: item.scope, mode: item.mode, messageType: item.messageType })})`); visualInstalled = true;
      item.clickOutcome = await outcome(leaf.locator("#submit").click()); if (!item.clickOutcome.ok) throw Error(item.clickOutcome.error);
      await leaf.getByText("Saved same", { exact: false }).waitFor({ timeoutMs: 5000 }); item.after = await readDocuments(getWorker(), item); item.server = fixtures.stats(item.key);
      item.held = await control("wait", ["held", 5000]); item.controlStartedAt = Date.now();
      if (item.operation === "pause") { pauseAttempted = true; item.controlOutcome = await outcome(popupCall({ type: "PAUSE_AUTOMATION" })); }
      else item.controlOutcome = await outcome(owner.client.request(item.operation, { ...item.scope, ...(item.operation === "detach" ? { tabId: tab.id } : {}) }, { timeoutMs: 1000 }));
      item.atBoundaryProbe = await control("snapshot"); item.atBoundary = await readDocuments(getWorker(), item);
      item.blockedSuccessor = item.operation === "detach" ? await outcome(owner.client.request("attach", { ...item.scope, tabId: tab.id }, { timeoutMs: 1000 })) :
        item.operation === "pause" ? await outcome(owner.client.request("getTabs", item.scope, { timeoutMs: 1000 })) : await outcome(owner.client.beginTurn(`attempt-${item.name}`));
      await control("release", ["original-boundary-observed"]); item.drained = await control("wait", ["drained", 5000]);
      if (item.operation !== "pause") item.cleanupResponse = await control("wait", ["cleanup-response", 5000]);
      else { item.retryPause = await popupCall({ type: "PAUSE_AUTOMATION" }); if (!item.retryPause.ok) throw Error(item.retryPause.error); item.retryPauseProbe = await control("snapshot");
        item.resumed = await popupCall({ type: "RESUME_AUTOMATION", expectedRevision: item.retryPause.status.revision }); if (!item.resumed.ok) throw Error(item.resumed.error); pauseAttempted = false; }
      item.afterRelease = await readDocuments(getWorker(), item); const hiddenAt = Date.now(); await new Promise(resolve => setTimeout(resolve, 550)); item.hiddenAgain = await readDocuments(getWorker(), item); item.hiddenObservedMs = Date.now() - hiddenAt;
      await owner.client.beginTurn(`recovered-${item.name}`); item.freshScope = scopeOf(owner); tab = owner.tab(item.tabId);
      await tab.frameLocator("#frame").locator("#submit").hover(); await tab.evaluate(`(${waitForFrameTargetFeedback.toString()})(${json(center(item.geometry.button))})`, { awaitPromise: true });
      await savePNG("recovered"); item.recovered = await readDocuments(getWorker(), item); item.recoveryEnd = await owner.client.turnEnded(); item.finalHidden = await readDocuments(getWorker(), item);
    } catch (error) { caseFailure ??= error; item.error = errorText(error); }
    finally {
      if (visualInstalled) { await cleanup("release-original", () => control("release", ["cleanup"])); await cleanup("original-delivery-settle", () => control("wait", ["drained", 5000])); }
      if (pauseAttempted) await cleanup("explicit-Pause-and-Resume", async () => { const retry = await popupCall({ type: "PAUSE_AUTOMATION" }); assert.equal(retry.ok, true); const resumed = await popupCall({ type: "RESUME_AUTOMATION", expectedRevision: retry.status.revision }); assert.equal(resumed.ok, true); item.cleanupRecovery = { retry, resumed }; });
      if (visualInstalled) await cleanup("restore-delivery-observer", async () => { item.probe = await control("restore"); });
      if (nativeInstalled) await cleanup("restore-native-observer", async () => { item.native = await getWorker().evaluate(`(()=>{const p=globalThis.__obuBoundingGeometry;if(p?.id!==${json(item.key)})throw Error('Native visual observer changed');return p.restore()})()`); });
      await cleanup("original-server-ledger", () => { item.server = fixtures.stats(item.key); });
      if (tab) await cleanup("close-exact-tab", () => closeTab ? closeTab(tab) : getWorker().evaluate(`chrome.tabs.remove(${item.tabId})`));
      if (owner) { await cleanup("finalize-owner", async () => { await owner.client.beginTurn(`cleanup-${item.name}`); item.finalized = await owner.client.finalizeTabs([]); }); await cleanup("close-owner", () => owner.close()); }
      if (tab) await cleanup("exact-native-absence", async () => { item.cleanupInventory = await getWorker().evaluate(`(async()=>({tabs:(await chrome.tabs.query({})).filter(t=>t.id===${item.tabId}),targets:(await chrome.debugger.getTargets()).filter(t=>t.tabId===${item.tabId})}))()`); assert.deepEqual(item.cleanupInventory, { tabs: [], targets: [] }); });
    }
    if (!caseFailure) try { checkVisualDeliveryEvidence(item); item.passed = true; } catch (error) { caseFailure = error; item.oracleError = errorText(error); }
    if (caseFailure) { item.passed = false; failure ??= caseFailure; }
    try { await saveDetail(detail); } catch (error) { detail.cleanupErrors.push({ stage: "save", error: errorText(error) }); failure ??= error; }
  }
  try { detail.serverLedger = fixtures.allStats(); } catch (error) { detail.cleanupErrors.push({ stage: "final-ledger", error: errorText(error) }); failure ??= error; }
  detail.passed = !failure; if (failure) detail.error = errorText(failure);
  try { await saveDetail(detail); } catch (error) { detail.cleanupErrors.push({ stage: "final-save", error: errorText(error) }); failure ??= error; }
  if (failure) throw failure; return detail;
}
