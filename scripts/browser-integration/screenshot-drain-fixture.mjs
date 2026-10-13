import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { checkParallelPixels } from "./background-parallel-workflow.mjs";
import { screencastConcurrencyHTML } from "./screencast-concurrency-fixture.mjs";

// Serialized into the isolated integration worker. Only the first successful
// native screenshot's DELIVERY is held; Chromium has already produced its PNG.
// Neither the production queue nor any native argument/result is replaced.
export function installScreenshotDrainProbe(api, target, backend, options) {
  const { id, tabId, scope, holdTimeoutMs = 30000 } = options ?? {};
  if (!id || !Number.isSafeInteger(tabId) || !scope?.session_id || !scope.turn_id || !Number.isSafeInteger(scope.control_epoch) ||
      !Number.isInteger(holdTimeoutMs) || holdTimeoutMs < 20 || holdTimeoutMs > 30000 ||
      !(backend?.renderingQueues instanceof Map) || !(backend?.renderingDrains instanceof Set) ||
      target.__obuScreenshotDrain || target.__integrationNativeRPCObserver) throw Error("Invalid screenshot drain probe installation");
  const original = api.debugger.sendCommand, records = [], requests = new Map(), waiters = new Set(), observedSuccessorTails = new Set();
  const selected = new Set(["Page.enable", "Page.startScreencast", "Page.stopScreencast", "Page.captureScreenshot", "Page.screencastFrameAck"]);
  let sequence = 0, nativePending = 0, deliveryPending = 0, selectedCapture = false, originalTail, image;
  let released = false, restored = false, watchdog = false, overflow = false, timer, releaseGate;
  const gate = new Promise(resolve => { releaseGate = resolve; });
  const append = value => {
    const record = { sequence: ++sequence, at: Date.now(), ...value };
    if (records.length < 4096) records.push(record); else overflow = true;
    for (const check of [...waiters]) check();
    return record;
  };
  const release = reason => {
    if (!released) { released = true; clearTimeout(timer); append({ kind: "release", reason }); releaseGate(); }
    return snapshot();
  };
  function wrapper(...args) {
    const [source, method, params] = args;
    if (source?.tabId !== tabId || source.sessionId != null || !selected.has(method)) return Reflect.apply(original, this, args);
    const send = append({ kind: "send", method, source: { ...source }, params: structuredClone(params ?? {}) });
    const hold = method === "Page.captureScreenshot" && !selectedCapture;
    if (hold) { selectedCapture = true; originalTail = backend.renderingQueues.get(tabId); }
    nativePending++;
    let native;
    try { native = Reflect.apply(original, this, args); }
    catch (error) { nativePending--; append({ kind: "native-settled", sendSequence: send.sequence, ok: false }); throw error; }
    const observed = native.then(value => {
      nativePending--;
      append({ kind: "native-settled", sendSequence: send.sequence, ok: true,
        ...(hold ? { dataCharacters: typeof value?.data === "string" ? value.data.length : null } : {}) });
      return value;
    }, error => { nativePending--; append({ kind: "native-settled", sendSequence: send.sequence, ok: false }); throw error; });
    observed.catch(() => {});
    if (!hold) return native;
    return observed.then(async value => {
      image = value; deliveryPending++;
      append({ kind: "capture-held", sendSequence: send.sequence });
      if (!released) timer = setTimeout(() => { watchdog = true; release("watchdog"); }, holdTimeoutMs);
      await gate;
      deliveryPending--;
      append({ kind: "capture-delivered", sendSequence: send.sequence });
      return value;
    });
  }
  const onEvent = (source, method, params) => {
    if (source?.tabId === tabId && source.sessionId == null && method === "Page.screencastFrame")
      append({ kind: "frame", source: { ...source }, frameSessionId: params.sessionId, dataCharacters: typeof params.data === "string" ? params.data.length : null });
  };
  const onRPC = (direction, message) => {
    if (direction === "request") {
      const p = message.params;
      const raw = message.method === "executeCdp" && p?.target?.tabId === tabId && p.target.sessionId == null && selected.has(p.method);
      const highLevel = message.method === "browserAction" && p?.tabId === tabId && p.action === "screenshot";
      if ((!raw && !highLevel) || p.session_id !== scope.session_id || p.turn_id !== scope.turn_id || p.control_epoch !== scope.control_epoch) return;
      if (requests.size >= 128 || requests.has(message.id)) { overflow = true; return; }
      requests.set(message.id, append({ kind: "request", requestId: message.id, method: highLevel ? "browserAction:screenshot" : p.method, timeoutMs: p.timeoutMs, scope: { ...scope } }));
    } else if (direction === "response" && requests.has(message.id)) {
      const request = requests.get(message.id);
      append({ kind: "response", requestId: message.id, requestSequence: request.sequence, method: request.method,
        ok: !message.error, ...(message.error ? { error: String(message.error.message ?? message.error).slice(0, 2048) } : {}) });
    }
  };
  function snapshot() {
    const tail = backend.renderingQueues.get(tabId);
    if (tail && originalTail && tail !== originalTail) observedSuccessorTails.add(tail);
    return structuredClone({ id, tabId, scope, records, nativePending, deliveryPending, released, restored, watchdog, overflow,
      backend: { originalQueuePresent: !!originalTail && tail === originalTail, successorQueuePresent: !!tail && !!originalTail && tail !== originalTail,
        observedSuccessorQueueCount: observedSuccessorTails.size,
        originalDrainPresent: !!originalTail && backend.renderingDrains.has(originalTail), queuePresent: !!tail,
        automation: backend.automationControl.status(), cleanupTimeoutMs: backend.automationCleanupTimeoutMs } });
  }
  function wait(kind, timeoutMs = 5000) {
    if (!["held", "successor-queued", "second-successor-queued", "delivered", "drained"].includes(kind)) throw Error("Unknown screenshot drain handshake");
    return new Promise((resolve, reject) => {
      let interval, timeout;
      const finish = (error, value) => { clearInterval(interval); clearTimeout(timeout); waiters.delete(check); error ? reject(error) : resolve(value); };
      const check = () => {
        const s = snapshot(), done = kind === "held" ? s.deliveryPending === 1 && !s.released :
          kind === "successor-queued" ? s.backend.successorQueuePresent :
          kind === "second-successor-queued" ? s.backend.successorQueuePresent && s.backend.observedSuccessorQueueCount >= 2 :
          kind === "delivered" ? s.records.some(r => r.kind === "capture-delivered") :
          s.nativePending === 0 && s.deliveryPending === 0 && !s.backend.originalDrainPresent && !s.backend.queuePresent;
        if (s.watchdog || s.overflow) finish(Error("Screenshot drain evidence watchdog/overflow"));
        else if (done) finish(null, s);
      };
      interval = setInterval(check, 10);
      timeout = setTimeout(() => finish(Error(`Screenshot drain handshake timed out: ${kind}`)), timeoutMs);
      waiters.add(check); check();
    });
  }
  const controller = { id, snapshot, wait, release,
    capture() {
      if (!image || typeof image.data !== "string" || image.data.length > 16 * 1024 * 1024) throw Error("Original native PNG unavailable or too large");
      return { data: image.data };
    },
    restore() {
      release("restore");
      const changed = api.debugger.sendCommand !== wrapper || target.__integrationNativeRPCObserver !== onRPC || target.__obuScreenshotDrain !== controller;
      if (api.debugger.sendCommand === wrapper) api.debugger.sendCommand = original;
      api.debugger.onEvent.removeListener(onEvent);
      if (target.__integrationNativeRPCObserver === onRPC) delete target.__integrationNativeRPCObserver;
      if (target.__obuScreenshotDrain === controller) delete target.__obuScreenshotDrain;
      if (changed) throw Error("Screenshot drain observer identity changed");
      if (nativePending || deliveryPending) throw Error("Screenshot drain observer restored with actual delivery still pending");
      restored = true; return snapshot();
    }
  };
  api.debugger.sendCommand = wrapper; api.debugger.onEvent.addListener(onEvent);
  target.__integrationNativeRPCObserver = onRPC; target.__obuScreenshotDrain = controller;
  return snapshot();
}

export function assertScreenshotDrainHeld(probe, { successor = false, queuedMethods = ["Page.startScreencast"], paused = false, api = "raw" } = {}) {
  assert.equal(probe.overflow, false); assert.equal(probe.watchdog, false); assert.equal(probe.released, false);
  assert.equal(probe.deliveryPending, 1, "Native ACK delivery must still be unresolved");
  const captures = probe.records.filter(r => r.kind === "send" && r.method === "Page.captureScreenshot");
  assert.equal(captures.length, 1, "The original screenshot must not be replayed");
  const settled = probe.records.filter(r => r.kind === "native-settled" && r.sendSequence === captures[0].sequence);
  const held = probe.records.filter(r => r.kind === "capture-held");
  assert.equal(settled.length, 1); assert.equal(settled[0].ok, true); assert.equal(held.length, 1);
  assert.ok(settled[0].sequence < held[0].sequence);
  assert.ok(!probe.records.some(r => r.kind === "capture-delivered"));
  assert.equal(probe.backend.originalDrainPresent, true, "Timed-out native delivery disappeared from the actual drain");
  if (successor) {
    assert.equal(probe.backend.successorQueuePresent, true, "Successor was not admitted to the actual production queue");
    const requests = probe.records.filter(r => r.kind === "request" && ["Page.stopScreencast", "Page.startScreencast"].includes(r.method) && r.sequence > held[0].sequence);
    assert.deepEqual(requests.map(r => r.method), queuedMethods);
    for (const request of requests) assert.deepEqual(request.scope, probe.scope);
    assert.equal(probe.backend.observedSuccessorQueueCount, queuedMethods.length, "Each request needs a separately observed actual queue tail");
  }
  assert.ok(!probe.records.some(r => r.kind === "send" && r.method === "Page.startScreencast" && r.sequence > held[0].sequence), "Successor native start bypassed unresolved capture delivery");
  if (api === "raw") assert.ok(!probe.records.some(r => r.kind === "send" && r.method === "Page.stopScreencast" && r.sequence > held[0].sequence), "Original stream stopped before actual screenshot delivery");
  if (paused) {
    assert.equal(probe.backend.automation.inputBlocked, true);
    assert.equal(probe.backend.automation.cleanupComplete, false, "Pause falsely acknowledged unresolved native delivery");
  }
}

export function assertScreenshotDrainEvidence(probe, { pause = false, api = "raw", lease = "internal" } = {}) {
  assert.equal(probe.overflow, false); assert.equal(probe.watchdog, false);
  assert.equal(probe.nativePending, 0); assert.equal(probe.deliveryPending, 0); assert.equal(probe.backend.originalDrainPresent, false);
  const records = probe.records, one = kind => { const values = records.filter(r => r.kind === kind); assert.equal(values.length, 1, kind); return values[0]; };
  const held = one("capture-held"), release = one("release"), delivered = one("capture-delivered");
  assert.ok(held.sequence < release.sequence && release.sequence < delivered.sequence);
  assert.notEqual(release.reason, "watchdog");
  const captures = records.filter(r => r.kind === "send" && r.method === "Page.captureScreenshot");
  assert.equal(captures.length, 1); assert.equal(captures[0].sequence, held.sendSequence); assert.equal(delivered.sendSequence, held.sendSequence);
  const nativeCapture = records.filter(r => r.kind === "native-settled" && r.sendSequence === captures[0].sequence);
  assert.equal(nativeCapture.length, 1); assert.equal(nativeCapture[0].ok, true); assert.ok(nativeCapture[0].sequence < held.sequence);
  if (api === "raw") assert.ok(!records.some(r => r.kind === "send" && r.method === "Page.stopScreencast" && r.sequence > held.sequence && r.sequence < delivered.sequence), "Original stream stopped before actual screenshot delivery");
  const captureRequests = records.filter(r => r.kind === "request" && r.method === (api === "high-level" ? "browserAction:screenshot" : "Page.captureScreenshot"));
  assert.equal(captureRequests.length, 1);
  const responses = records.filter(r => r.kind === "response" && r.requestId === captureRequests[0].requestId);
  assert.equal(responses.length, 1); assert.equal(responses[0].ok, false); assert.match(responses[0].error, /timed out|timeout.*exceeded/i);
  assert.ok(responses[0].sequence > held.sequence && responses[0].sequence < release.sequence, "Original wire deadline must expire while delivery is held");
  const starts = records.filter(r => r.kind === "send" && r.method === "Page.startScreencast" && r.sequence > held.sequence);
  const stops = records.filter(r => r.kind === "send" && r.method === "Page.stopScreencast" && r.sequence > held.sequence);
  if (api === "raw" && lease === "external") {
    const queued = records.filter(r => r.kind === "request" && ["Page.stopScreencast", "Page.startScreencast"].includes(r.method) && r.sequence > held.sequence && r.sequence < release.sequence);
    assert.deepEqual(queued.map(r => r.method), ["Page.stopScreencast", "Page.startScreencast"], "Caller-owned stream must stop before its replacement starts");
    for (const request of queued) {
      assert.deepEqual(request.scope, probe.scope);
      const replies = records.filter(r => r.kind === "response" && r.requestId === request.requestId);
      assert.equal(replies.length, 1); assert.equal(replies[0].ok, !pause); assert.ok(replies[0].sequence > delivered.sequence);
    }
    if (pause) assert.equal(stops.length, 0, "Cancelled stop was replayed after Pause");
    else {
      assert.equal(stops.length, 2, "One queued external stop and one final cleanup stop");
      assert.equal(starts.length, 1);
      const stopACK = records.find(r => r.kind === "native-settled" && r.sendSequence === stops[0].sequence);
      assert.ok(stopACK?.ok); assert.ok(delivered.sequence < stops[0].sequence && stopACK.sequence < starts[0].sequence, "Actual external stop ACK must precede replacement start");
    }
  }
  if (pause) assert.equal(starts.length, 0, "Cancelled successor was replayed after Pause");
  else {
    assert.equal(starts.length, 1); assert.ok(starts[0].sequence > delivered.sequence);
    const ack = records.find(r => r.kind === "native-settled" && r.sendSequence === starts[0].sequence && r.ok);
    assert.ok(ack, "Successor native start did not actually ACK");
    assert.ok(records.some(r => r.kind === "frame" && r.sequence > starts[0].sequence && records.some(a => a.kind === "send" && a.method === "Page.screencastFrameAck" && a.params.sessionId === r.frameSessionId && a.sequence > r.sequence)), "Successor produced no real native frame/ACK pair");
  }
  for (const send of records.filter(r => r.kind === "send")) {
    assert.deepEqual(send.source, { tabId: probe.tabId });
    assert.equal(records.filter(r => r.kind === "native-settled" && r.sendSequence === send.sequence).length, 1, "Unsettled/duplicate native operation");
  }
  return { capture: captures[0].sequence, nativeACK: records.find(r => r.kind === "native-settled" && r.sendSequence === captures[0].sequence).sequence,
    held: held.sequence, wireTimeout: responses[0].sequence, release: release.sequence, delivered: delivered.sequence, successor: starts[0]?.sequence ?? null };
}

export function assertOriginalScreenshotTimeout(probe, callerOutcome, api = "raw") {
  assert.equal(callerOutcome.ok, false); assert.match(callerOutcome.error, /timed out|timeout.*exceeded/i);
  const requests = probe.records.filter(r => r.kind === "request" && r.method === (api === "high-level" ? "browserAction:screenshot" : "Page.captureScreenshot"));
  assert.equal(requests.length, 1);
  // Public browserAction deducts SDK setup time before sending its remaining
  // engine budget. Raw executeCdp carries the exact supplied timeout instead.
  if (api === "high-level") assert.ok(Number.isInteger(requests[0].timeoutMs) && requests[0].timeoutMs > 0 && requests[0].timeoutMs <= 1000);
  else assert.equal(requests[0].timeoutMs, 1000);
  const responses = probe.records.filter(r => r.kind === "response" && r.requestId === requests[0].requestId);
  assert.equal(responses.length, 1, "An SDK-only timeout is not an original backend deadline ACK");
  assert.equal(responses[0].ok, false); assert.match(responses[0].error, /timed out|timeout.*exceeded/i);
  assert.ok(responses[0].at <= callerOutcome.settledAt, "Worker timeout arrived after the SDK had already timed out");
  assert.equal(probe.released, false);
  return { requestSequence: requests[0].sequence, responseSequence: responses[0].sequence, requestedTimeoutMs: requests[0].timeoutMs,
    requestAt: requests[0].at, responseAt: responses[0].at, callerSettledAt: callerOutcome.settledAt };
}

const errorText = error => error?.stack ?? String(error);
async function bounded(operation, timeoutMs, label) {
  let timer;
  try { return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`Screenshot drain fixture timed out: ${label}`)), timeoutMs); })]); }
  finally { clearTimeout(timer); }
}
const outcome = promise => promise.then(value => ({ ok: true, value, settledAt: Date.now() }), error => ({ ok: false, error: errorText(error), settledAt: Date.now() }));

export async function checkScreenshotDrain({ connectBrowser, worker, fixtureURL, saveScreenshot, saveDetail }) {
  const detail = { id: randomUUID(), cases: [], cleanupErrors: [], passed: false,
    boundary: "The first actual successful native capture ACK is held at delivery, after Chromium produced the original PNG. Real public RPC deadlines, exact production queue Promise identities, original native commands/frames, and unchanged Pause cleanup budgets are observed. This does not model an unfinished raster operation or establish a natural failure rate. Pause uses the existing Backend API through a test-only staged reference, not popup UI or an agent permission route." };
  let failure;
  try {
    const cases = [
      ...["internal", "external"].flatMap(lease => [false, true].map(pause => ({ api: "raw", lease, pause }))),
      { api: "high-level", lease: "internal", pause: true }
    ];
    for (const scenario of cases) {
      const entry = { id: randomUUID(), ...scenario, steps: [], frames: [], cleanupErrors: [], passed: false };
      detail.cases.push(entry);
      await runScreenshotDrainCase({ ...{ connectBrowser, worker, fixtureURL, saveScreenshot }, entry });
    }
    detail.passed = true;
  } catch (error) { failure = error; detail.error = errorText(error); }
  try { await saveDetail(detail); } catch (error) { detail.cleanupErrors.push({ stage: "persist", error: errorText(error) }); failure ??= error; detail.passed = false; }
  if (failure) throw failure;
  return detail;
}

async function runScreenshotDrainCase({ connectBrowser, worker, fixtureURL, saveScreenshot, entry }) {
  const nonce = entry.id.replaceAll("-", "").slice(0, 8), label = `${entry.api}-${entry.lease}-${entry.pause ? "pause" : "successor"}`;
  entry.nonce = nonce; entry.fixtureHTMLSHA256 = createHash("sha256").update(screencastConcurrencyHTML(nonce)).digest("hex");
  const clients = [], pending = [], acknowledgements = [], frames = new Map(), listeners = new Set();
  let owner, peer, tab, metrics, removeNotification, installed = false, pauseAttempted = false, failure;
  const run = (name, operation) => {
    const step = { name, startedAt: Date.now() }; entry.steps.push(step);
    const promise = Promise.resolve().then(operation).then(value => { step.ok = true; step.settledAt = Date.now(); return value; }, error => { step.ok = false; step.settledAt = Date.now(); step.error = errorText(error); throw error; });
    promise.catch(() => {}); pending.push(promise); return promise;
  };
  const control = (method, args = []) => bounded(worker.evaluate(`(()=>{const p=globalThis.__obuScreenshotDrain;if(!p||p.id!==${JSON.stringify(entry.id)})throw Error('Screenshot drain probe missing/replaced');return p[${JSON.stringify(method)}](...${JSON.stringify(args)})})()`), 7000, `probe ${method}`);
  const backend = (method, revision) => bounded(worker.evaluate(`(async()=>{const b=globalThis.__integrationBackend;if(!b)throw Error('Staged Backend missing');try{const value=await b[${JSON.stringify(method)}](${revision === undefined ? "" : JSON.stringify(revision)});return{ok:true,value,settledAt:Date.now()}}catch(e){return{ok:false,error:String(e?.message??e),settledAt:Date.now()}}})()`), 15000, method);
  const call = (browser, name, method, params = {}, timeoutMs = 15000) => run(name, () => browser.client.request("executeCdp", { target: { tabId: tab.id }, method, commandParams: params, timeoutMs }, { timeoutMs: timeoutMs + 2000 }));
  const evaluate = async expression => {
    const value = await call(owner, "evaluate", "Runtime.evaluate", { expression, returnByValue: true });
    assert.equal(value.exceptionDetails, undefined); return value.result?.value;
  };
  const pixels = (bytes, sequence) => checkParallelPixels(bytes, { nonce, sequence, box: { x: 0, y: 0, width: 240, height: 60 }, dpr: metrics.dpr });
  const waitFrame = sequence => bounded(new Promise(resolve => {
    const check = () => { if (frames.has(sequence)) { listeners.delete(check); resolve(frames.get(sequence)); } };
    listeners.add(check); check();
  }), 6000, `external frame ${sequence}`);
  const save = async (name, base64, sequence) => {
    assert.equal(typeof base64, "string"); const bytes = Buffer.from(base64, "base64"), proof = pixels(bytes, sequence);
    assert.equal(proof.width, Math.round(metrics.width * metrics.dpr)); assert.equal(proof.height, Math.round(metrics.height * metrics.dpr));
    await saveScreenshot(`screenshot-drain-${label}-${name}.png`, bytes); return proof;
  };
  try {
    owner = await connectBrowser(); clients.push(owner); peer = await connectBrowser(); clients.push(peer);
    const turn = `screenshot-drain-${entry.id}`;
    await owner.client.beginTurn(turn); await peer.client.beginTurn(turn);
    await owner.client.getTabs(); await peer.client.getTabs();
    const scope = browser => ({ session_id: browser.client.sessionId, turn_id: browser.client.turnId, control_epoch: browser.client.controlEpoch });
    entry.scope = scope(owner); assert.deepEqual(scope(peer), entry.scope); assert.notEqual(owner.client, peer.client);
    tab = await owner.newTab(); entry.tabId = tab.id;
    const url = new URL("/screencast-concurrency", fixtureURL); url.searchParams.set("nonce", nonce); entry.url = url.href;
    await tab.goto(url.href); await owner.client.attach(tab.id);
    metrics = await evaluate("({nonce:fixtureNonce,sequence:fixtureSequence,width:innerWidth,height:innerHeight,dpr:devicePixelRatio})");
    assert.equal(metrics.nonce, nonce); assert.equal(metrics.sequence, 0); entry.viewport = metrics;
    if (entry.api === "high-level") assert.equal(await tab.locator("#state").textContent(), `${nonce}:0`);
    entry.nativeBefore = await worker.evaluate(`chrome.tabs.get(${tab.id})`);
    removeNotification = peer.client.onNotification(notification => {
      const payload = notification.params;
      if (notification.method !== "onCDPEvent" || payload?.source?.tabId !== tab.id || payload.source.sessionId != null || payload.method !== "Page.screencastFrame") return;
      if (entry.frames.length >= 128) { entry.frameOverflow = true; return; }
      const frame = payload.params, record = { at: Date.now(), frameSessionId: frame.sessionId }; entry.frames.push(record);
      try {
        assert.deepEqual({ session_id: payload.session_id, turn_id: payload.turn_id, control_epoch: payload.control_epoch }, entry.scope);
        assert.equal(typeof frame.data, "string"); assert.ok(frame.data.length <= 16 * 1024 * 1024);
        const bytes = Buffer.from(frame.data, "base64");
        for (const sequence of [0, 1]) { let proof; try { proof = pixels(bytes, sequence); } catch { continue; } record.sequence = sequence; record.pixels = proof; frames.set(sequence, { data: frame.data, record }); }
      } catch (error) { record.error = errorText(error); }
      const ack = call(peer, "frame-ack", "Page.screencastFrameAck", { sessionId: frame.sessionId }).then(() => { record.acknowledged = true; }, error => { record.ackError = errorText(error); throw error; });
      ack.catch(() => {}); acknowledgements.push(ack); for (const listener of [...listeners]) listener();
    });
    installed = true;
    entry.installed = await worker.evaluate(`(${installScreenshotDrainProbe.toString()})(chrome,globalThis,globalThis.__integrationBackend,${JSON.stringify({ id: entry.id, tabId: tab.id, scope: entry.scope, holdTimeoutMs: 30000 })})`);
    assert.equal(entry.installed.backend.automation.inputBlocked, false);
    assert.equal(entry.installed.backend.cleanupTimeoutMs, 10000, "Production Pause cleanup budget must remain unchanged");
    if (entry.lease === "external") {
      await call(peer, "external-enable", "Page.enable");
      await call(peer, "external-start", "Page.startScreencast", { format: "png", everyNthFrame: 1 });
      await waitFrame(0); await Promise.all(acknowledgements);
    }
    const original = outcome(entry.api === "high-level" ? run("original-high-level-capture", () => tab.screenshot({ timeoutMs: 1000 })) :
      call(owner, "original-capture", "Page.captureScreenshot", { format: "png" }, 1000));
    entry.held = await control("wait", ["held", 5000]); assertScreenshotDrainHeld(entry.held, { api: entry.api });
    const originalPNG = await control("capture"); entry.originalPixels = await save("original-native-ACK", originalPNG.data, 0);
    entry.originalOutcome = await original; assert.equal(entry.originalOutcome.ok, false); assert.match(entry.originalOutcome.error, /timed out|timeout.*exceeded/i);
    entry.afterDeadline = await control("snapshot"); assertScreenshotDrainHeld(entry.afterDeadline, { api: entry.api });
    entry.originalDeadline = assertOriginalScreenshotTimeout(entry.afterDeadline, entry.originalOutcome, entry.api);
    let successor, successorStop;
    if (entry.api === "raw") {
      if (entry.lease === "external") {
        successorStop = outcome(call(peer, "queued-external-stop", "Page.stopScreencast"));
        entry.stopQueued = await control("wait", ["successor-queued", 3000]);
        assertScreenshotDrainHeld(entry.stopQueued, { successor: true, queuedMethods: ["Page.stopScreencast"] });
      }
      successor = outcome(call(peer, "queued-successor-start", "Page.startScreencast", { format: "png", everyNthFrame: 1 }));
      entry.successorQueued = await control("wait", [entry.lease === "external" ? "second-successor-queued" : "successor-queued", 3000]);
      assertScreenshotDrainHeld(entry.successorQueued, { successor: true, queuedMethods: entry.lease === "external" ? ["Page.stopScreencast", "Page.startScreencast"] : ["Page.startScreencast"] });
    } else entry.successorSkipped = "High-level abort may confirm detach and retire its attachment queue. Only original native drain and Pause are asserted; a fresh attachment may legitimately render independently.";
    if (entry.pause) {
      removeNotification(); removeNotification = undefined; await Promise.all(acknowledgements);
      pauseAttempted = true;
      entry.pause = true; entry.pauseOutcome = await backend("pauseAutomation");
      assert.equal(entry.pauseOutcome.ok, false, "Pause incorrectly succeeded before original ACK delivery");
      assert.match(entry.pauseOutcome.error, /OBU_AUTOMATION_PAUSE_FAILED/);
      entry.failedPause = await control("snapshot"); assertScreenshotDrainHeld(entry.failedPause, { paused: true, api: entry.api });
      assert.equal(entry.failedPause.backend.cleanupTimeoutMs, 10000);
      assert.equal(entry.failedPause.backend.automation.state, "error");
      const resume = await backend("resumeAutomation", entry.failedPause.backend.automation.revision);
      entry.prematureResume = resume; assert.equal(resume.ok, false); assert.match(resume.error, /OBU_AUTOMATION_PAUSE_INCOMPLETE/);
      await control("release", ["failed-Pause-explicit-release"]);
      await control("wait", ["delivered", 5000]);
      if (successorStop) { entry.successorStopOutcome = await successorStop; assert.equal(entry.successorStopOutcome.ok, false); assert.match(entry.successorStopOutcome.error, /PAUSED|STALE|expired|control|attach/i); }
      if (successor) { entry.successorOutcome = await successor; assert.equal(entry.successorOutcome.ok, false); assert.match(entry.successorOutcome.error, /PAUSED|STALE|expired|control|attach/i); }
      entry.retryPause = await backend("pauseAutomation"); assert.equal(entry.retryPause.ok, true); assert.equal(entry.retryPause.value.cleanupComplete, true);
      entry.resume = await backend("resumeAutomation", entry.retryPause.value.revision); assert.equal(entry.resume.ok, true); assert.equal(entry.resume.value.inputBlocked, false);
      pauseAttempted = false;
      const stale = await outcome(owner.client.request("getTabs", entry.scope)); entry.oldScope = stale; assert.equal(stale.ok, false); assert.match(stale.error, /STALE|ENDED|ENDING/);
      await owner.client.beginTurn(`fresh-${entry.id}`); entry.freshScope = { session_id: owner.client.sessionId, turn_id: owner.client.turnId, control_epoch: owner.client.controlEpoch };
      assert.ok(entry.freshScope.control_epoch > entry.scope.control_epoch);
      entry.freshTabs = await owner.client.getTabs(); assert.ok(entry.freshTabs.some(t => t.id === tab.id));
      await owner.client.attach(tab.id); entry.afterResume = await evaluate("({nonce:fixtureNonce,sequence:fixtureSequence})");
      assert.deepEqual(entry.afterResume, { nonce, sequence: 0 });
    } else {
      await control("release", ["deadline-and-successor-observed"]);
      if (successorStop) { entry.successorStopOutcome = await successorStop; assert.equal(entry.successorStopOutcome.ok, true); }
      entry.successorOutcome = await successor; assert.equal(entry.successorOutcome.ok, true);
      assert.deepEqual(await evaluate("setFixtureSequence(1)"), { ...metrics, sequence: 1 });
      const frame = await waitFrame(1); entry.successorPixels = await save("successor-frame", frame.data, 1);
      await Promise.all(acknowledgements);
      await call(peer, "final-stop", "Page.stopScreencast");
    }
    removeNotification?.(); removeNotification = undefined; await Promise.all(acknowledgements);
    entry.probe = await control("wait", ["drained", 5000]); entry.order = assertScreenshotDrainEvidence(entry.probe, { pause: entry.pause, api: entry.api, lease: entry.lease });
    assert.equal(entry.probe.backend.cleanupTimeoutMs, 10000);
    assert.ok(!entry.frameOverflow); assert.ok(entry.frames.every(f => !f.error && !f.ackError && f.acknowledged));
    entry.passed = true;
  } catch (error) { failure = error; entry.error = errorText(error); }
  finally {
    const cleanup = async (stage, operation) => { try { await operation(); } catch (error) { entry.cleanupErrors.push({ stage, error: errorText(error) }); failure ??= error; entry.passed = false; } };
    if (installed) await cleanup("release-original", () => control("release", ["cleanup"]));
    await cleanup("original-requests", async () => { entry.settlements = (await bounded(Promise.allSettled(pending), 18000, "all original requests")).map(r => ({ status: r.status, ...(r.status === "rejected" ? { error: errorText(r.reason) } : {}) })); });
    removeNotification?.(); listeners.clear();
    if (pauseAttempted) await cleanup("retry-Pause-and-Resume", async () => {
      const retry = await backend("pauseAutomation"); assert.equal(retry.ok, true); assert.equal(retry.value.cleanupComplete, true);
      const resumed = await backend("resumeAutomation", retry.value.revision); assert.equal(resumed.ok, true);
      entry.cleanupRecovery = { retry, resumed }; if (owner) await owner.client.beginTurn(`cleanup-${entry.id}`);
    });
    if (owner && tab) await cleanup("finalize-exact-task-tabs", async () => { entry.finalized = await owner.client.finalizeTabs([]); });
    if (installed) {
      await cleanup("real-delivery-drain", () => control("wait", ["drained", 5000]));
      await cleanup("restore-observers", async () => { entry.restored = await control("restore"); assert.equal(entry.restored.restored, true); });
    }
    if (tab) await cleanup("native-tab-target-absence", async () => {
      entry.after = await bounded(worker.evaluate(`(async()=>({tabs:(await chrome.tabs.query({})).filter(t=>t.id===${tab.id}),targets:(await chrome.debugger.getTargets()).filter(t=>t.tabId===${tab.id})}))()`), 6000, "exact native cleanup");
      assert.deepEqual(entry.after.tabs, []); assert.deepEqual(entry.after.targets, []);
    });
    for (const client of clients) await cleanup("close-connection", () => client.close());
  }
  if (failure) throw failure;
}
