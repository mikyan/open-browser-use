import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { checkParallelPixels } from "./background-parallel-workflow.mjs";

export function screencastConcurrencyHTML(nonce) {
  assert.match(nonce, /^[a-f0-9]{8}$/);
  return `<!doctype html><meta charset="utf-8"><title>Screencast concurrency ${nonce}</title>
<style>html,body{margin:0;background:#fff}#marker{width:240px;height:60px;display:grid;grid-template-columns:repeat(8,30px);grid-template-rows:repeat(2,30px)}</style>
<div id="marker"></div><output id="state"></output><script>
globalThis.fixtureNonce=${JSON.stringify(nonce)};globalThis.fixtureSequence=0;
globalThis.setFixtureSequence=sequence=>{if(!Number.isInteger(sequence)||sequence<0||sequence>2)throw Error('Invalid fixture sequence');globalThis.fixtureSequence=sequence;const code=fixtureNonce+sequence.toString(16).padStart(8,'0');document.querySelector('#marker').replaceChildren(...[...code].map(c=>{const n=parseInt(c,16),d=document.createElement('div');d.style.background='rgb('+(40+Math.floor(n/4)*48)+','+(40+n%4*48)+',150)';return d}));document.querySelector('#state').textContent=fixtureNonce+':'+sequence;return{nonce:fixtureNonce,sequence,width:innerWidth,height:innerHeight,dpr:devicePixelRatio}};setFixtureSequence(0);
</script>`;
}

// Test-only: the first real screenshot result is held AFTER native settlement.
// Other calls receive their original Promise. No arguments, result objects,
// events, or native dispatches are fabricated. This intentionally changes the
// screenshot ACK delivery schedule and cannot establish natural failure rates.
export function installScreencastConcurrencyProbe(api, target, { id, tabId, sessionId, turnId, controlEpoch }) {
  if (target.__obuScreencastConcurrency || target.__integrationNativeRPCObserver) throw new Error("Screencast test observer already installed");
  const original = api.debugger.sendCommand, records = [], requests = [], waiters = new Set();
  const selected = new Set(["Page.enable", "Page.startScreencast", "Page.stopScreencast", "Page.captureScreenshot", "Page.screencastFrameAck"]);
  let sequence = 0, overflow = false, pending = 0, captured = false, released = false, restored = false, watchdog = false, timer;
  let releaseGate;
  const gate = new Promise(resolve => { releaseGate = resolve; });
  const changed = () => { for (const fn of [...waiters]) fn(); };
  const append = value => { const record = { sequence: ++sequence, at: Date.now(), ...value }; if (records.length < 2048) records.push(record); else overflow = true; changed(); return record; };
  const release = reason => { if (!released) { released = true; clearTimeout(timer); append({ kind: "release", reason }); releaseGate(); } return released; };
  function wrapper(...args) {
    const [source, method, params] = args;
    if (source?.tabId !== tabId || source.sessionId != null || !selected.has(method)) return Reflect.apply(original, this, args);
    const start = append({ kind: "send", method, source: { ...source }, params: params ? { ...params } : {} });
    const hold = method === "Page.captureScreenshot" && !captured;
    if (hold) captured = true;
    pending++;
    let native;
    try { native = Reflect.apply(original, this, args); }
    catch (error) { pending--; append({ kind: "settled", sendSequence: start.sequence, ok: false, error: String(error) }); throw error; }
    const settled = native.then(value => {
      pending--;
      append({ kind: "settled", sendSequence: start.sequence, ok: true,
        ...(method === "Page.captureScreenshot" ? { dataCharacters: typeof value?.data === "string" ? value.data.length : null } : {}) });
      return value;
    }, error => { pending--; append({ kind: "settled", sendSequence: start.sequence, ok: false, error: String(error) }); throw error; });
    settled.catch(() => {});
    if (!hold) return native;
    return settled.then(async value => {
      append({ kind: "capture-held", sendSequence: start.sequence });
      if (!released) timer = setTimeout(() => { watchdog = true; release("watchdog"); }, 10000);
      await gate;
      append({ kind: "capture-delivered", sendSequence: start.sequence });
      return value;
    });
  }
  const onEvent = (source, method, params) => {
    if (source.tabId === tabId && source.sessionId == null && method === "Page.screencastFrame")
      append({ kind: "frame", source: { ...source }, frameSessionId: params.sessionId,
        dataCharacters: typeof params.data === "string" ? params.data.length : null,
        metadata: { ...params.metadata } });
  };
  const onRPC = (direction, message) => {
    if (direction !== "request" || message.method !== "executeCdp" || message.params?.target?.tabId !== tabId ||
        message.params?.session_id !== sessionId || message.params?.turn_id !== turnId || message.params?.control_epoch !== controlEpoch ||
        !["Page.stopScreencast", "Page.startScreencast"].includes(message.params.method)) return;
    if (requests.length < 16) requests.push({ id: message.id, method: message.params.method, scope: { session_id: sessionId, turn_id: turnId, control_epoch: controlEpoch }, ...append({ kind: "request", method: message.params.method, requestId: message.id }) });
    else overflow = true;
    changed();
  };
  function snapshot() { return structuredClone({ id, tabId, records, requests, pending, released, watchdog, overflow, restored }); }
  function wait(kind, count = 1, timeoutMs = 5000) {
    if (!["capture-held", "request", "drained"].includes(kind)) throw new Error("Unknown screencast handshake");
    return new Promise((resolve, reject) => {
      let timer;
      const check = () => {
        const complete = kind === "drained" ? pending === 0 : records.filter(item => item.kind === kind).length >= count;
        if (!complete) return;
        clearTimeout(timer); waiters.delete(check); resolve(snapshot());
      };
      timer = setTimeout(() => { waiters.delete(check); reject(new Error(`Screencast handshake timed out: ${kind}`)); }, timeoutMs);
      waiters.add(check); check();
    });
  }
  api.debugger.sendCommand = wrapper;
  api.debugger.onEvent.addListener(onEvent);
  target.__integrationNativeRPCObserver = onRPC;
  const controller = { id, snapshot, wait, release,
    restore() {
      release("restore");
      const changed = api.debugger.sendCommand !== wrapper || target.__integrationNativeRPCObserver !== onRPC;
      if (api.debugger.sendCommand === wrapper) api.debugger.sendCommand = original;
      api.debugger.onEvent.removeListener(onEvent);
      if (target.__integrationNativeRPCObserver === onRPC) delete target.__integrationNativeRPCObserver;
      if (changed) throw new Error("Screencast observer identity changed");
      restored = true;
      const result = snapshot(); delete target.__obuScreencastConcurrency; return result;
    }
  };
  target.__obuScreencastConcurrency = controller;
  return snapshot();
}

export function checkScreencastConcurrencyEvidence(probe) {
  assert.equal(probe.overflow, false); assert.equal(probe.watchdog, false); assert.equal(probe.pending, 0);
  const sends = probe.records.filter(item => item.kind === "send");
  const commands = method => sends.filter(item => item.method === method);
  const settle = call => {
    const values = probe.records.filter(item => item.kind === "settled" && item.sendSequence === call.sequence);
    assert.equal(values.length, 1); assert.equal(values[0].ok, true); return values[0].sequence;
  };
  for (const call of sends) { assert.deepEqual(call.source, { tabId: probe.tabId }); settle(call); }
  const starts = commands("Page.startScreencast"), stops = commands("Page.stopScreencast"), captures = commands("Page.captureScreenshot");
  assert.equal(starts.length, 2); assert.equal(stops.length, 3); assert.equal(captures.length, 2);
  const held = probe.records.filter(item => item.kind === "capture-held"), released = probe.records.filter(item => item.kind === "release");
  assert.equal(held.length, 1); assert.equal(released.length, 1);
  assert.ok(settle(captures[0]) < held[0].sequence && held[0].sequence < released[0].sequence);
  assert.deepEqual(probe.requests.slice(0, 2).map(item => item.method), ["Page.stopScreencast", "Page.startScreencast"]);
  assert.ok(probe.requests.slice(0, 2).every(item => item.sequence > held[0].sequence && item.sequence < released[0].sequence));
  assert.ok(settle(starts[0]) < captures[0].sequence);
  assert.ok(released[0].sequence < stops[0].sequence, "External control bypassed the held screenshot lease");
  assert.ok(settle(stops[0]) < stops[1].sequence && settle(stops[1]) < starts[1].sequence);
  assert.ok(settle(starts[1]) < captures[1].sequence && settle(captures[1]) < stops[2].sequence);
  for (const [start, stop] of [[starts[0], stops[0]], [starts[1], stops[2]]]) {
    const frames = probe.records.filter(item => item.kind === "frame" && item.sequence > start.sequence && item.sequence < stop.sequence);
    assert.ok(frames.length > 0, "Real native stream produced no recorded frame");
    assert.ok(frames.some(frame => commands("Page.screencastFrameAck").some(ack => ack.params.sessionId === frame.frameSessionId && ack.sequence > frame.sequence && settle(ack) < stop.sequence)), "No actual frame/ACK pair in stream interval");
  }
  return { internalStart: starts[0].sequence, internalStop: stops[0].sequence, externalStop: stops[1].sequence,
    externalStart: starts[1].sequence, captures: captures.map(item => item.sequence), finalStop: stops[2].sequence };
}

const errorText = error => error?.stack ?? String(error);
async function bounded(promise, timeoutMs, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Screencast fixture timeout: ${label}`)), timeoutMs); })]); }
  finally { clearTimeout(timer); }
}

export async function checkScreencastConcurrency({ connectBrowser, worker, fixtureURL, saveScreenshot, saveDetail }) {
  const id = randomUUID(), nonce = id.replaceAll("-", "").slice(0, 8);
  const detail = { id, nonce, fixtureHTMLSHA256: createHash("sha256").update(screencastConcurrencyHTML(nonce)).digest("hex"), steps: [], captures: [], frames: [], cleanupErrors: [], passed: false,
    boundary: "Controlled real screenshot ACK delivery, with a 300ms overlap window after exact worker requests and a public same-client read barrier. Elapsed time/request delivery is not proof of queue admission or native execution; real native order, frames, public ACKs and pixels are verified separately. No natural reproduction or performance claim." };
  const pending = [], acknowledgements = [], clients = [], frameListeners = new Set();
  let owner, peer, tab, metrics, originalError, removeNotification, installAttempted = false, stopAttempted = false;
  const scope = browser => ({ session_id: browser.client.sessionId, turn_id: browser.client.turnId, control_epoch: browser.client.controlEpoch });
  const run = (label, operation) => {
    const record = { label, startedAt: Date.now() }; detail.steps.push(record);
    let promise;
    try { promise = Promise.resolve(operation()); } catch (error) { promise = Promise.reject(error); }
    const tracked = promise.then(value => { record.completedAt = Date.now(); record.ok = true; return value; }, error => { record.completedAt = Date.now(); record.ok = false; record.error = errorText(error); throw error; });
    tracked.catch(() => {}); pending.push(tracked); return tracked;
  };
  const control = (method, args = []) => bounded(worker.evaluate(`(()=>{const p=globalThis.__obuScreencastConcurrency;if(!p||p.id!==${JSON.stringify(id)})throw Error('Screencast probe missing/replaced');return p[${JSON.stringify(method)}](...${JSON.stringify(args)})})()`), 6000, `probe ${method}`);
  const call = (browser, label, method, params = {}) => run(label, () => browser.cdp.call(tab.id, method, params, { timeoutMs: 15000 }));
  const evaluate = async (browser, label, expression) => {
    const result = await call(browser, label, "Runtime.evaluate", { expression, returnByValue: true });
    assert.equal(result.exceptionDetails, undefined); return result.result?.value;
  };
  const pixels = (bytes, sequence) => checkParallelPixels(bytes, { nonce, sequence, box: { x: 0, y: 0, width: 240, height: 60 }, dpr: metrics.dpr });
  const capture = async (name, result, sequence) => {
    assert.equal(typeof result.data, "string"); const bytes = Buffer.from(result.data, "base64");
    const entry = { name, sequence, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
    detail.captures.push(entry); await saveScreenshot(name, bytes);
    entry.pixels = pixels(bytes, sequence);
    assert.equal(entry.pixels.width, Math.round(metrics.width * metrics.dpr));
    assert.equal(entry.pixels.height, Math.round(metrics.height * metrics.dpr));
  };
  const matchingFrames = new Map();
  const waitFrame = sequence => bounded(new Promise(resolve => {
    const check = () => { if (matchingFrames.has(sequence)) { frameListeners.delete(check); resolve(matchingFrames.get(sequence)); } };
    frameListeners.add(check); check();
  }), 7000, `real external frame phase ${sequence}`);
  try {
    owner = await connectBrowser(); clients.push(owner); peer = await connectBrowser(); clients.push(peer);
    await owner.client.getTabs(); await peer.client.getTabs();
    detail.scope = scope(owner); assert.deepEqual(scope(peer), detail.scope);
    assert.notEqual(owner.client, peer.client, "Two independent SDK connections are required");
    tab = await run("newTab", () => owner.newTab()); detail.tabId = tab.id;
    const url = new URL("/screencast-concurrency", fixtureURL); url.searchParams.set("nonce", nonce); detail.url = url.href;
    await run("goto", () => tab.goto(url.href));
    metrics = await evaluate(owner, "initial-state", "({nonce:fixtureNonce,sequence:fixtureSequence,width:innerWidth,height:innerHeight,dpr:devicePixelRatio})");
    assert.equal(metrics.nonce, nonce); assert.equal(metrics.sequence, 0); detail.viewport = metrics;
    removeNotification = peer.client.onNotification(notification => {
      const payload = notification.params;
      if (notification.method !== "onCDPEvent" || payload?.source?.tabId !== tab.id || payload.source.sessionId != null || payload.method !== "Page.screencastFrame") return;
      if (detail.frames.length >= 64) { detail.frameOverflow = true; return; }
      const frame = payload.params, entry = { at: Date.now(), source: payload.source, frameSessionId: frame.sessionId,
        scope: { session_id: payload.session_id, turn_id: payload.turn_id, control_epoch: payload.control_epoch }, metadata: frame.metadata, dataCharacters: typeof frame.data === "string" ? frame.data.length : null };
      detail.frames.push(entry);
      try {
        assert.deepEqual(entry.scope, detail.scope);
        assert.equal(typeof frame.data, "string"); assert.ok(frame.data.length <= 16 * 1024 * 1024);
        const bytes = Buffer.from(frame.data, "base64"); entry.bytes = bytes.length; entry.sha256 = createHash("sha256").update(bytes).digest("hex");
        for (const sequence of [1, 2]) {
          let proof; try { proof = pixels(bytes, sequence); } catch { continue; }
          entry.sequence = sequence; entry.pixels = proof;
          if (!matchingFrames.has(sequence)) matchingFrames.set(sequence, { bytes, entry });
        }
      } catch (error) { entry.error = errorText(error); }
      entry.ackStep = `frame-ack-${detail.frames.length}`;
      const ack = call(peer, entry.ackStep, "Page.screencastFrameAck", { sessionId: frame.sessionId }).then(value => { entry.acknowledged = true; entry.ackResult = value; }, error => { entry.ackError = errorText(error); throw error; });
      ack.catch(() => {}); acknowledgements.push(ack);
      for (const listener of [...frameListeners]) listener();
    });
    installAttempted = true;
    detail.installed = await bounded(worker.evaluate(`(${installScreencastConcurrencyProbe.toString()})(chrome,globalThis,${JSON.stringify({ id, tabId: tab.id, sessionId: detail.scope.session_id, turnId: detail.scope.turn_id, controlEpoch: detail.scope.control_epoch })})`), 6000, "probe installation");
    const firstCapture = call(owner, "capture-internal", "Page.captureScreenshot", { format: "png" });
    detail.held = await control("wait", ["capture-held", 1, 5000]);
    const externalStop = call(peer, "raw-stop", "Page.stopScreencast");
    await control("wait", ["request", 1, 5000]);
    const externalStart = call(peer, "raw-start", "Page.startScreencast", { format: "png", everyNthFrame: 1 });
    await control("wait", ["request", 2, 5000]);
    detail.readBarrier = await evaluate(peer, "same-client-read-barrier", "({nonce:fixtureNonce,sequence:fixtureSequence})");
    assert.deepEqual(detail.readBarrier, { nonce, sequence: 0 });
    detail.overlap = { requestedMilliseconds: 300, startedAt: Date.now(), provesQueueAdmission: false };
    await new Promise(resolve => setTimeout(resolve, 300));
    detail.overlap.completedAt = Date.now(); detail.beforeRelease = await control("snapshot");
    assert.equal(detail.beforeRelease.released, false, "Capture gate already released before overlap observation");
    await control("release", ["controlled-overlap-complete"]);
    const outcomes = await Promise.allSettled([firstCapture, externalStop, externalStart]);
    for (const outcome of outcomes) if (outcome.status === "rejected") throw outcome.reason;
    await capture("screencast-concurrency-internal.png", outcomes[0].value, 0);
    assert.deepEqual(await evaluate(peer, "phase-1", "setFixtureSequence(1)"), { ...metrics, sequence: 1 });
    const frame1 = await waitFrame(1); await saveScreenshot("screencast-concurrency-frame-1.png", frame1.bytes);
    await capture("screencast-concurrency-external.png", await call(owner, "capture-external", "Page.captureScreenshot", { format: "png" }), 1);
    assert.deepEqual(await evaluate(peer, "phase-2", "setFixtureSequence(2)"), { ...metrics, sequence: 2 });
    const frame2 = await waitFrame(2); await saveScreenshot("screencast-concurrency-frame-2.png", frame2.bytes);
    const ackResults = await Promise.allSettled(acknowledgements); for (const result of ackResults) if (result.status === "rejected") throw result.reason;
    stopAttempted = true; await call(peer, "final-stop", "Page.stopScreencast");
    removeNotification(); removeNotification = undefined;
    const finalAckResults = await Promise.allSettled(acknowledgements); for (const result of finalAckResults) if (result.status === "rejected") throw result.reason;
    detail.probe = await control("wait", ["drained", 1, 5000]);
    detail.nativeOrder = checkScreencastConcurrencyEvidence(detail.probe);
    assert.ok(!detail.frameOverflow); assert.ok(detail.frames.every(frame => !frame.error && !frame.ackError && frame.acknowledged));
    for (const frame of [frame1.entry, frame2.entry]) {
      assert.ok(detail.probe.records.some(record => record.kind === "frame" && record.frameSessionId === frame.frameSessionId && record.dataCharacters === frame.dataCharacters && record.metadata?.timestamp === frame.metadata?.timestamp), "Public frame has no corresponding real native frame");
      assert.ok(detail.steps.some(step => step.label === frame.ackStep && step.ok === true), "Public frame ACK did not settle");
    }
    assert.deepEqual(scope(owner), detail.scope); assert.deepEqual(scope(peer), detail.scope);
    detail.passed = true;
  } catch (error) { originalError = error; detail.error = errorText(error); detail.passed = false; }
  finally {
    const cleanup = async (stage, operation) => { try { await operation(); } catch (error) { detail.cleanupErrors.push({ stage, error: errorText(error) }); originalError ??= error; detail.passed = false; } };
    if (installAttempted) await cleanup("release", () => control("release", ["cleanup"]));
    await cleanup("settle-original-requests", async () => {
      const results = await bounded(Promise.allSettled(pending), 18000, "original public requests");
      detail.requestSettlements = results.map(result => result.status === "fulfilled" ? { status: result.status } : { status: result.status, error: errorText(result.reason) });
    });
    if (tab && peer && !stopAttempted) { stopAttempted = true; await cleanup("public-stop", () => call(peer, "cleanup-stop", "Page.stopScreencast")); }
    removeNotification?.(); frameListeners.clear();
    await cleanup("settle-frame-acks", async () => {
      const results = await bounded(Promise.allSettled(acknowledgements), 18000, "frame ACKs");
      if (results.some(result => result.status === "rejected")) throw new AggregateError(results.filter(result => result.status === "rejected").map(result => result.reason), "Frame ACK cleanup failed");
    });
    if (owner) await cleanup("finalize", async () => { detail.finalize = await owner.client.finalizeTabs([]); });
    if (installAttempted) {
      await cleanup("native-drain", () => control("wait", ["drained", 1, 5000]));
      await cleanup("restore", async () => { detail.restored = await control("restore"); });
    }
    if (tab) await cleanup("native-tab-cleanup", async () => {
      detail.after = await bounded(worker.evaluate("(async()=>({tabs:await chrome.tabs.query({}),targets:await chrome.debugger.getTargets()}))()"), 6000, "native cleanup read");
      assert.ok(!detail.after.tabs.some(value => value.id === tab.id)); assert.ok(!detail.after.targets.some(value => value.tabId === tab.id));
    });
    for (const client of clients) await cleanup("close-connection", () => client.close());
    await cleanup("persist", () => saveDetail(detail));
  }
  if (originalError) throw originalError;
  return detail;
}
