import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import vm from "node:vm";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { BACKGROUND_PARALLEL_MIN_IDLE_MS, checkBackgroundParallelWorkflow, checkParallelNativeEvidence,
  checkParallelPixels, createBackgroundParallelFixture, decodeParallelPNG, installBackgroundParallelProbe,
  parallelElementClip, parallelMarkerCode, settleParallelWork } from "./background-parallel-workflow.mjs";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]), header = Buffer.alloc(4), trailer = Buffer.alloc(4); header.writeUInt32BE(data.length);
  let crc = 0xffffffff; for (const byte of body) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  trailer.writeUInt32BE((crc ^ 0xffffffff) >>> 0); return Buffer.concat([header, body, trailer]);
}
function png({ width = 272, height = 100, x = 16, y = 20, dpr = 1, nonce = "01234567", sequence = 0x89abcdef, channels = 4, filter = 0 } = {}) {
  width = Math.round(width * dpr); height = Math.round(height * dpr);
  const code = parallelMarkerCode(nonce, sequence), stride = width * channels, pixels = Buffer.alloc(stride * height, 255), raw = Buffer.alloc((stride + 1) * height);
  for (let row = 0; row < height; row++) for (let col = 0; col < width; col++) {
    const cy = (row + 0.5) / dpr - y, cx = (col + 0.5) / dpr - x;
    if (cx < 0 || cy < 0 || cx >= 240 || cy >= 60) continue;
    const index = Math.floor(cy / 30) * 8 + Math.floor(cx / 30), nibble = parseInt(code[index], 16), offset = row * stride + col * channels;
    pixels[offset] = 40 + Math.floor(nibble / 4) * 48; pixels[offset + 1] = 40 + nibble % 4 * 48; pixels[offset + 2] = 150;
  }
  const paeth = (a, b, c) => { const p = a + b - c, distances = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)]; return [a, b, c][distances.indexOf(Math.min(...distances))]; };
  for (let row = 0; row < height; row++) {
    raw[row * (stride + 1)] = filter;
    for (let col = 0; col < stride; col++) {
      const i = row * stride + col, a = col >= channels ? pixels[i - channels] : 0, b = row ? pixels[i - stride] : 0, c = row && col >= channels ? pixels[i - stride - channels] : 0;
      raw[row * (stride + 1) + col + 1] = (pixels[i] - [0, a, b, Math.floor((a + b) / 2), paeth(a, b, c)][filter]) & 255;
    }
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = channels === 4 ? 6 : 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

test("PNG evidence checks exact document/version pixels for all filters, RGB/RGBA and DPR", () => {
  for (const channels of [3, 4]) for (const filter of [0, 1, 2, 3, 4]) for (const dpr of [1, 2]) {
    const bytes = png({ channels, filter, dpr });
    const evidence = checkParallelPixels(bytes, { nonce: "01234567", sequence: 0x89abcdef, box: { x: 16, y: 20, width: 240, height: 60 }, dpr });
    assert.equal(evidence.samples.length, 16); assert.equal(evidence.width, 272 * dpr); assert.equal(evidence.sha256, sha(bytes));
  }
  const bytes = png({ x: 0, y: 0, width: 240, height: 60 });
  const documentBox = { x: 555, y: 999, width: 240, height: 60 };
  const options = { nonce: "01234567", sequence: 0x89abcdef, box: documentBox, documentBox, nativeClip: parallelElementClip(documentBox), dpr: 1, element: true };
  assert.equal(checkParallelPixels(bytes, options).height, 60);
  assert.throws(() => checkParallelPixels(bytes, { ...options, nonce: "01234568" }), /Wrong document\/sequence/);
  assert.throws(() => checkParallelPixels(bytes, { ...options, sequence: 0x89abcdee }), /Wrong document\/sequence/);
  assert.throws(() => checkParallelPixels(bytes, { ...options, dpr: 2 }));
  assert.throws(() => decodeParallelPNG(bytes.subarray(0, bytes.length - 1)), /Truncated PNG/);
  const oversized = Buffer.from(bytes); oversized.writeUInt32BE(1000000, 16); assert.throws(() => decodeParallelPNG(oversized));
  const interlaced = Buffer.from(bytes); interlaced[28] = 1; assert.throws(() => decodeParallelPNG(interlaced));
});

test("fractional element origins use the native enclosing CSS clip before DPR, retaining exact identity pixels", () => {
  for (const dpr of [1.25, 1.5, 1.75]) for (const point of [{ x: 32, y: 1053.0833587646484 }, { x: 32.25, y: 2353.6667 }, { x: 32.9998, y: 700.0002 }]) {
    const documentBox = { ...point, width: 240, height: 60 }, nativeClip = parallelElementClip(documentBox);
    const bytes = png({ width: nativeClip.width, height: nativeClip.height, x: point.x - nativeClip.x, y: point.y - nativeClip.y, dpr });
    const options = { nonce: "01234567", sequence: 0x89abcdef, box: documentBox, documentBox, nativeClip, dpr, element: true };
    const evidence = checkParallelPixels(bytes, options); assert.equal(evidence.samples.length, 16);
    if (dpr === 1.5 && point.y === 1053.0833587646484) assert.equal(evidence.height, 92);
    assert.throws(() => checkParallelPixels(bytes, { ...options, nativeClip: { ...nativeClip, height: nativeClip.height + 1 } }), /Native clip differs/);
    assert.throws(() => checkParallelPixels(bytes, { ...options, sequence: 0x89abcdee }), /Wrong document\/sequence/);
    assert.throws(() => checkParallelPixels(png({ width: nativeClip.width, height: nativeClip.height + 1, x: point.x - nativeClip.x, y: point.y - nativeClip.y, dpr }), options));
  }
});

async function withFixture(work) {
  const fixture = createBackgroundParallelFixture(), server = http.createServer((request, response) => {
    if (!fixture.handle(request, response, server.address().port)) { response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try { await work(fixture, `http://127.0.0.1:${server.address().port}`); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
test("fixture isolates three nonce documents, preserves actual POST bytes and rejects replay/forgery", () => withFixture(async (fixture, base) => {
  const root = await (await fetch(`${base}/background-parallel/task-one`)).text();
  assert.match(root, /iframe title="跨源记录" src="http:\/\/localhost:/);
  const documents = fixture.stats("task-one").documents; assert.equal(new Set(Object.values(documents).map(doc => doc.nonce)).size, 3);
  for (const role of ["root", "same", "cross"]) {
    const html = role === "root" ? root : await (await fetch(`${base}/background-parallel/task-one/frame/${role}`)).text();
    for (const script of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new vm.Script(script[1]);
    assert.ok(html.includes(documents[role].nonce));
    const payload = { nonce: documents[role].nonce, document: role, sequence: 1, text: `${role} 中文记录`, click: { trusted: true, type: "click" }, submit: { trusted: true } };
    // HTTP units use synthetic flags; only real browser acceptance establishes trusted DOM input.
    const send = async value => fetch(`${base}/background-parallel/task-one/save/${role}`, { method: "POST", body: JSON.stringify(value) });
    assert.equal((await send({ ...payload, nonce: "ffffffff" })).status, 422);
    assert.equal((await send({ ...payload, click: { trusted: false } })).status, 422);
    assert.equal((await send({ ...payload, document: "alien" })).status, 422);
    const accepted = await send(payload); assert.equal(accepted.status, 200); assert.equal((await accepted.json()).text, payload.text);
    assert.equal((await send(payload)).status, 422);
    const evidence = fixture.stats("task-one").posts.filter(post => post.role === role && post.status === 200); assert.equal(evidence.length, 1);
    const bytes = Buffer.from(evidence[0].base64, "base64"); assert.equal(bytes.toString(), JSON.stringify(payload)); assert.equal(evidence[0].sha256, sha(bytes)); assert.equal(evidence[0].bytes, bytes.length);
  }
  await fetch(`${base}/background-parallel/task-two`); assert.notEqual(fixture.stats("task-two").documents.root.nonce, documents.root.nonce);
  const clone = fixture.stats("task-one"); clone.posts.length = 0; assert.equal(fixture.stats("task-one").posts.length, 15);
}));

const emitter = () => { const listeners = new Set(); return { addListener: listener => listeners.add(listener), removeListener: listener => listeners.delete(listener), emit: (...args) => { for (const listener of listeners) listener(...args); }, get count() { return listeners.size; } }; };
test("native probe forwards exact promise/receiver/args once, preserves throw and rejection, restores listeners", async () => {
  const target = {}, calls = [], success = { unique: 1 }, failure = new Error("native rejected"), syncFailure = new Error("native threw");
  let response = Promise.resolve(success);
  const original = function (...args) { calls.push({ receiver: this, args }); if (args[1] === "sync") throw syncFailure; return response; };
  const chrome = { debugger: { sendCommand: original, onEvent: emitter(), onDetach: emitter() }, tabs: { onRemoved: emitter() } };
  installBackgroundParallelProbe(chrome, target); const probe = target.__obuBackgroundParallelProbe; probe.track(7, "first", { session_id: "session-one", control_epoch: 2 });
  const args = [{ tabId: 7 }, "Page.startScreencast", { everyNthFrame: 1 }];
  assert.strictEqual(chrome.debugger.sendCommand(...args), response); assert.strictEqual(await response, success); assert.equal(calls.length, 1); assert.strictEqual(calls[0].receiver, chrome.debugger);
  for (let i = 0; i < args.length; i++) assert.strictEqual(calls[0].args[i], args[i]);
  response = Promise.reject(failure); const rejected = chrome.debugger.sendCommand({ tabId: 7 }, "Page.captureScreenshot", {});
  assert.strictEqual(rejected, response); await assert.rejects(rejected, error => error === failure);
  assert.throws(() => chrome.debugger.sendCommand({ tabId: 7 }, "sync"), error => error === syncFailure);
  chrome.debugger.onEvent.emit({ tabId: 7 }, "Page.screencastFrame", { sessionId: 55, data: "abc", metadata: { timestamp: 1 } });
  chrome.tabs.onRemoved.emit(7);
  const state = probe.snapshot(); assert.equal(state.tabs[0].commands, 3); assert.equal(state.tabs[0].pending, 0); assert.equal(state.tabs[0].frames.count, 1); assert.equal(state.commands[1].ok, false);
  assert.equal(state.events[0].frameSessionId, 55); assert.equal("data" in state.events[0], false); assert.equal(calls.length, 3);
  probe.restore(); assert.strictEqual(chrome.debugger.sendCommand, original); assert.equal(chrome.debugger.onEvent.count + chrome.debugger.onDetach.count + chrome.tabs.onRemoved.count, 0); assert.equal(target.__obuBackgroundParallelProbe, undefined);
});

function nativeEvidence() {
  const command = (tabId, owner, method, at, settledAt, extra = {}) => ({ index: at * 10, tabId, owner, method, at, settledAt, ok: true, ...extra });
  return { overflow: false, observerErrors: [], tabs: [1, 2].map(tabId => ({ tabId, pending: 0, frames: { count: 1 }, acks: 1 })), events: [
    { index: 150, type: "frame", tabId: 1, at: 15, frameSessionId: 101 }, { index: 250, type: "frame", tabId: 2, at: 25, frameSessionId: 102 },
    { type: "iframe", tabId: 1, sessionId: "child1", targetId: "iframe1" }, { type: "iframe", tabId: 2, sessionId: "child2", targetId: "iframe2" },
    { type: "removed", tabId: 1 }, { type: "removed", tabId: 2 }
  ], commands: [command(1, "first", "Page.startScreencast", 10, 12), command(1, "first", "Page.screencastFrameAck", 16, 17, { frameSessionId: 101 }),
    command(2, "second", "Page.startScreencast", 20, 22), command(2, "second", "Page.screencastFrameAck", 26, 27, { frameSessionId: 102 }),
    command(1, "first", "Page.stopScreencast", 30, 32), command(2, "second", "Page.stopScreencast", 40, 42)] };
}
test("parallel native proof requires real cross-owner intervals, frames, ACK and removal", () => {
  const evidence = nativeEvidence(), result = checkParallelNativeEvidence(evidence, { tabIds: [1, 2] }); assert.equal(result.overlaps[0].milliseconds, 8);
  const serial = nativeEvidence(); for (const command of serial.commands) if (command.tabId === 2) { command.at += 20; command.settledAt += 20; } serial.events.find(event => event.type === "frame" && event.tabId === 2).at += 20;
  assert.throws(() => checkParallelNativeEvidence(serial), /No actual rendering/);
  const same = nativeEvidence(); for (const command of same.commands) command.owner = "first"; assert.throws(() => checkParallelNativeEvidence(same), /No actual rendering/);
  const pending = nativeEvidence(); pending.tabs[0].pending = 1; assert.throws(() => checkParallelNativeEvidence(pending), /still pending/);
  const unclosed = nativeEvidence(); unclosed.commands = unclosed.commands.filter(command => command.method !== "Page.stopScreencast"); assert.throws(() => checkParallelNativeEvidence(unclosed), /not stopped/);
  const noFrame = nativeEvidence(); noFrame.events = noFrame.events.filter(event => event.type !== "frame"); assert.throws(() => checkParallelNativeEvidence(noFrame), /No actual frame/);
  const wrongAck = nativeEvidence(); wrongAck.commands[1].frameSessionId = 99; assert.throws(() => checkParallelNativeEvidence(wrongAck), /not acknowledged/);
  const noRemoval = nativeEvidence(); noRemoval.events = noRemoval.events.filter(event => event.type !== "removed"); assert.throws(() => checkParallelNativeEvidence(noRemoval, { tabIds: [1, 2] }), /not actually closed/);
  const inFlight = nativeEvidence(); inFlight.events.push({ type: "frame", tabId: 1, at: 30, index: 301, frameSessionId: 999 }); assert.equal(checkParallelNativeEvidence(inFlight).overlaps.length, 1);
});

test("parallel failure drains all outstanding siblings and retains every error before cleanup", async () => {
  let release, complete = false; const first = new Error("first"), second = new Error("second");
  const late = new Promise(resolve => { release = resolve; }).then(() => { complete = true; throw second; });
  const batch = settleParallelWork([Promise.reject(first), late]); let returned = false; batch.catch(() => { returned = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(returned, false); release();
  await assert.rejects(batch, error => { assert.equal(complete, true); assert.deepEqual(error.errors, [first, second]); return true; });
  assert.deepEqual(await settleParallelWork([Promise.resolve(1), Promise.resolve(2)]), [1, 2]);
});

test("formal idle cannot be weakened to a fast unit acceptance or unbounded duration", async () => {
  assert.equal(BACKGROUND_PARALLEL_MIN_IDLE_MS, 310000);
  for (const idleMs of [0, 309999, 600001, NaN]) await assert.rejects(checkBackgroundParallelWorkflow({ idleMs }), /Formal idle/);
  for (const cadenceMs of [0, 15001]) await assert.rejects(checkBackgroundParallelWorkflow({ cadenceMs }));
});
