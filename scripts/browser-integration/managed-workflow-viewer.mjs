// Observe the real managed viewer through its DOM and original WebSocket.
// The supplied page belongs to the runner's separate headless test browser.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { poll, bound } from "./normal-browser-downloads-support.mjs";
import { projectViewerCommand } from "./managed-viewer-check.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");

export async function observeManagedWorkflowViewer({ page, url, directory, detail }) {
  Object.assign(detail, { commands: [], messages: [], frames: [], actions: [], decoded: [], screenshots: [], errors: [] });
  const writes = [], recent = new Map(), streams = new Set();
  let state, failure;
  const fail = error => { failure ??= error; detail.errors.push({ at: Date.now(), error: error.stack ?? String(error) }); };
  const check = () => { if (failure) throw failure; };
  const wait = (read, label, timeoutMs = 20000) => poll(async () => { check(); return bound(Promise.resolve().then(read), 5000, label); }, { timeoutMs, intervalMs: 40, label });
  function retain(frame, bytes) {
    if (frame.file) return;
    assert.ok(writes.length < 256, "Original viewer image capacity");
    frame.file = `native-frame-${String(frame.index).padStart(4, "0")}.png`;
    const write = fs.writeFile(path.join(directory, frame.file), bytes, { flag: "wx" });
    writes.push(write); write.catch(fail);
  }
  page.on("pageerror", fail);
  page.on("websocket", socket => {
    try { assert.equal(new URL(socket.url()).origin.replace("ws:", "http:"), new URL(url).origin); }
    catch (error) { fail(error); return; }
    socket.on("close", () => detail.messages.push({ type: "socketClosed", at: Date.now() }));
    socket.on("framesent", event => {
      try {
        const projected = projectViewerCommand(JSON.parse(String(event.payload)));
        if (!projected) return; // Authentication secrets are never retained.
        assert.ok(detail.commands.length < 1024); detail.commands.push({ ...projected, at: Date.now() });
      } catch (error) { fail(error); }
    });
    socket.on("framereceived", event => {
      try {
        const message = JSON.parse(String(event.payload)), at = Date.now();
        assert.ok(detail.messages.length < 8192 && detail.frames.length < 2048, "Original viewer observation capacity");
        if (message.type === "frame") {
          assert.equal(message.mimeType, "image/png");
          assert.ok(typeof message.data === "string" && message.data.length <= 4 * Math.ceil(4 * 1024 * 1024 / 3));
          const bytes = Buffer.from(message.data, "base64");
          assert.ok(bytes.length > 24 && bytes.length <= 4 * 1024 * 1024);
          assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
          assert.ok(Number.isFinite(message.metadata?.timestamp) && message.metadata.timestamp > 0, "Original native capture timestamp required");
          const frame = { ...message, data: undefined, index: detail.frames.length, at, bytes: bytes.length, sha256: hash(bytes), width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
          const previous = detail.frames.findLast(item => item.streamId === frame.streamId);
          assert.ok(!previous || frame.sequence > previous.sequence, "Original stream sequence must increase");
          detail.frames.push(frame); recent.set(frame.index, bytes);
          while (recent.size > 16) recent.delete(recent.keys().next().value);
          if (!streams.has(frame.streamId) || frame.index % 10 === 0) retain(frame, bytes);
          streams.add(frame.streamId);
          detail.messages.push({ type: "frame", at, tabId: frame.tabId, streamId: frame.streamId, sequence: frame.sequence, controlMode: frame.controlMode, viewLeaseId: frame.viewLeaseId, generation: frame.generation, sha256: frame.sha256 });
        } else {
          detail.messages.push({ ...message, at });
          const next = message.type === "state" ? message : message.type === "response" && message.result?.status ? message.result : null;
          if (next && (!state || next.eventSequence >= state.eventSequence && next.status.revision >= state.status.revision)) state = next;
        }
      } catch (error) { fail(error); }
    });
  });
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
  await wait(async () => await page.locator("#connection").textContent() === "已连接", "original viewer authenticated");
  assert.equal(new URL(page.url()).hash, "");

  async function action(selector, operation, tabId) {
    check();
    const before = detail.commands.length, item = { selector, operation, tabId, startedAt: Date.now() }; detail.actions.push(item);
    if (selector === "#tabs") await page.locator(selector).selectOption(tabId === null ? "" : String(tabId), { timeout: 10000 });
    else await page.locator(selector).click({ timeout: 10000 });
    const matches = () => detail.commands.slice(before).filter(row => row.operation === operation && (operation !== "select" || row.tabId === tabId));
    const command = await wait(() => matches()[0], `original viewer ${operation} command`);
    item.requestId = command.id;
    const reply = await wait(() => detail.messages.find(row => row.type === "response" && row.id === command.id), `original viewer ${operation} reply`, 35000);
    assert.equal(matches().length, 1); assert.equal(reply.error, undefined, JSON.stringify(reply.error));
    item.completedAt = Date.now(); return reply.result;
  }
  const refresh = () => action("#refresh", "status");
  async function select(tabId, kind) {
    const current = await refresh(), entry = current.tabs.find(row => row.id === tabId);
    assert.equal(entry?.kind, kind); assert.equal(entry.watchable, true);
    if (await page.locator("#tabs").inputValue({ timeout: 5000 }) === String(tabId)) {
      assert.notEqual(current.selectedTabId, tabId, "Do not toggle an already active original selection");
      await action("#watch", "select", tabId);
    } else await action("#tabs", "select", tabId);
    return entry;
  }
  async function capture({ tabId, label, after = 0, kind }) {
    assert.match(label, /^[a-z0-9-]+$/);
    const proof = await wait(async () => {
      if (state?.selectedTabId !== tabId) return null;
      const image = await page.locator("#frame").evaluate(element => ({ hidden: element.hidden, complete: element.complete, width: element.naturalWidth, height: element.naturalHeight, ...element.dataset }));
      if (image.hidden || !image.complete || image.width <= 0 || image.height <= 0) return null;
      const frame = detail.frames.findLast(row => row.tabId === tabId && row.metadata.timestamp * 1000 >= after && row.streamId === image.streamId && row.sequence === Number(image.frameSequence));
      if (!frame || !recent.has(frame.index)) return null;
      if (kind === "result" && (frame.controlMode !== "user-view" || state.view?.state !== "active" || state.view.tabId !== tabId || state.view.leaseId !== frame.viewLeaseId || state.view.generation !== frame.generation || image.viewLeaseId !== frame.viewLeaseId || Number(image.generation) !== frame.generation)) return null;
      return { at: Date.now(), tabId, label, kind, image, frameIndex: frame.index, frame };
    }, `real viewer decoded original ${label}`, 35000);
    retain(proof.frame, recent.get(proof.frameIndex));
    if (kind === "result") {
      const first = detail.messages.findIndex(row => row.type === "frame" && row.viewLeaseId === proof.frame.viewLeaseId && row.generation === proof.frame.generation);
      const announced = detail.messages.findIndex(row => {
        const view = row.type === "state" ? row.view : row.type === "response" ? row.result?.view : null;
        return view?.state === "active" && view.leaseId === proof.frame.viewLeaseId && view.generation === proof.frame.generation;
      });
      assert.ok(announced >= 0 && first > announced, "Original result lease must be announced before its frame");
      proof.announcement = { stateIndex: announced, frameIndex: first };
    }
    detail.decoded.push(proof);
    const file = `viewer-${label}.png`, png = await page.screenshot({ path: path.join(directory, file), timeout: 10000 });
    detail.screenshots.push({ file, at: Date.now(), bytes: png.length, sha256: hash(png), tabId, kind, nearbyFrameIndex: proof.frameIndex,
      association: "Nearby UI screenshot; asynchronous rendering may advance beyond the separately retained original native frame." });
    check(); return proof;
  }
  await refresh();
  return { refresh, select, capture, check, get state() { return state; },
    async deselect() { if (state?.selectedTabId !== null) await action("#tabs", "select", null); },
    async settle() { await Promise.all(writes); check(); return { savedImages: writes.length, frames: detail.frames.length, errors: detail.errors.length }; }
  };
}
