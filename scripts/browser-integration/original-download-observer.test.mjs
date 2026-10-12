import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { WebSocketServer } from "ws";
import { connectOriginalDownloadObserver } from "./original-download-observer.mjs";

const profile = path.join(os.tmpdir(), "observer-unit-owned-profile");
const filePath = path.join(os.tmpdir(), "native-original.bin");
const begin = guid => ({ method: "Browser.downloadWillBegin", params: { guid, frameId: "original-frame", url: "blob:https://fixture.invalid/same-url", suggestedFilename: "same.bin" } });
const progress = (guid, more = {}) => ({ method: "Browser.downloadProgress", params: { guid, receivedBytes: 17, totalBytes: 17, state: "completed", filePath, ...more } });

async function nativeServer(t, reply) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise(resolve => server.once("listening", resolve));
  const state = { received: [], outgoing: [], peers: [], closed: 0 };
  state.send = message => { const raw = JSON.stringify(message); state.outgoing.push(raw); state.peers[0].send(raw); };
  server.on("connection", peer => {
    state.peers.push(peer); peer.on("error", () => {}); peer.on("close", () => state.closed++);
    peer.on("message", raw => {
      const message = JSON.parse(raw.toString()); state.received.push({ raw: raw.toString(), message });
      const respond = result => state.send({ id: message.id, result });
      if (reply) reply(message, respond, state);
      else respond(message.method === "Target.getTargets" ? { targetInfos: [{ targetId: "original-target", type: "page", browserContextId: "native-context", extra: { keep: true } }] } : {});
    });
  });
  t.after(async () => { for (const peer of server.clients) peer.terminate(); await new Promise(resolve => server.close(resolve)); });
  return { ...state, state, url: `ws://127.0.0.1:${server.address().port}/devtools/browser/unit-original` };
}
async function observer(t, options = {}, reply) {
  const server = await nativeServer(t, reply);
  const value = await connectOriginalDownloadObserver({ webSocketURL: server.url, ownedIsolatedProfile: profile, ...options });
  t.after(() => value.close().catch(() => {}));
  return { value, state: server.state };
}
const barrier = value => value.call("Browser.getVersion");

test("observer rejects page/CRX endpoints and absent explicit isolated-profile ownership", async () => {
  for (const options of [
    { webSocketURL: "ws://127.0.0.1:1/devtools/page/target", ownedIsolatedProfile: profile },
    { webSocketURL: "ws://127.0.0.1:1/crx", ownedIsolatedProfile: profile },
    { webSocketURL: "ws://127.0.0.1:1/devtools/browser/id" },
    { webSocketURL: "ws://user:secret@127.0.0.1:1/devtools/browser/id", ownedIsolatedProfile: profile }
  ]) await assert.rejects(connectOriginalDownloadObserver(options));
});

test("default observer preserves exact raw commands/ACKs/events, GUID path and actual close", async t => {
  const { value, state } = await observer(t);
  const targets = await value.call("Target.getTargets"); assert.equal(targets.targetInfos[0].extra.keep, true);
  await assert.rejects(value.call("Input.dispatchMouseEvent"), /Only unfiltered/);
  await value.start({ behavior: "default" });
  await assert.rejects(value.start({ behavior: "default" }), /ALREADY_STARTED/);
  assert.equal(value.download("original"), null);
  state.send({ method: "Target.targetCreated", params: { targetInfo: { targetId: "unrelated", arbitraryMetadata: [1, 2] } } });
  state.send(begin("original")); state.send(progress("original")); await barrier(value);
  assert.deepEqual(value.download("original"), { guid: "original", begin: begin("original").params, progress: progress("original").params, filePath });
  const returned = value.download("original"); returned.begin.frameId = "forged";
  assert.equal(value.download("original").begin.frameId, "original-frame");
  await Promise.all([value.close(), value.close()]);
  const trace = value.snapshot();
  assert.equal(trace.closeObserved, true); assert.equal(trace.closeCode, 1000); assert.equal(trace.cleanup.restored, true);
  assert.deepEqual(trace.commands.map(row => row.message.method), ["Target.getTargets", "Browser.setDownloadBehavior", "Browser.getVersion", "Browser.setDownloadBehavior"]);
  assert.deepEqual(trace.commands.at(-1).message.params, { behavior: "default", eventsEnabled: false });
  assert.deepEqual(trace.commands.map(row => Buffer.from(row.bodyBase64, "base64").toString()), state.received.map(row => row.raw));
  assert.deepEqual(trace.records.filter(row => row.direction === "receive").map(row => Buffer.from(row.bodyBase64, "base64").toString()), state.outgoing);
  for (const [i, row] of trace.records.entries()) {
    const bytes = Buffer.from(row.bodyBase64, "base64"); assert.equal(row.sequence, i); assert.equal(row.bytes, bytes.length);
    assert.equal(row.sha256, createHash("sha256").update(bytes).digest("hex")); assert.deepEqual(JSON.parse(bytes), row.message);
  }
  assert.deepEqual(trace.events[0].message.params.targetInfo.arbitraryMetadata, [1, 2]);
  await assert.rejects(value.call("Browser.getVersion"), /DISCONNECTED/);
});

test("allowAndName still requires actual native filePath and never derives it from directory/GUID", async t => {
  const { value, state } = await observer(t);
  await assert.rejects(value.start({ behavior: "allowAndName", downloadPath: "relative" }));
  await value.start({ behavior: "allowAndName", downloadPath: path.join(os.tmpdir(), "owned-downloads") });
  state.send(begin("missing")); state.send(progress("missing", { filePath: undefined }));
  state.send(begin("foreign")); state.send(progress("foreign", { filePath: path.join(os.tmpdir(), "other-native.bin") }));
  await barrier(value);
  assert.throws(() => value.download("missing"), /PATH_UNAVAILABLE/);
  assert.equal(value.download("not-observed"), null);
  assert.equal(value.download("foreign").filePath, path.join(os.tmpdir(), "other-native.bin"));
  assert.deepEqual(state.received[0].message.params, { behavior: "allowAndName", eventsEnabled: true, downloadPath: path.join(os.tmpdir(), "owned-downloads") });
});

for (const [name, messages, expected] of [
  ["duplicate original begin", [begin("one"), begin("one"), progress("one")], /IDENTITY/],
  ["terminal with no begin", [progress("one")], /IDENTITY/],
  ["begin after terminal", [progress("one"), begin("one")], /IDENTITY/],
  ["duplicate terminal", [begin("one"), progress("one"), progress("one")], /IDENTITY/],
  ["native cancellation", [begin("one"), progress("one", { state: "canceled" })], /CANCELED/],
  ["relative native path", [begin("one"), progress("one", { filePath: "same.bin" })], /PATH_UNAVAILABLE/]
]) test(`observer rejects ${name} without a substitute path`, async t => {
  const { value, state } = await observer(t); await value.start({ behavior: "default" });
  for (const message of messages) state.send(message); await barrier(value);
  assert.throws(() => value.download("one"), expected);
});

test("restore ACK failure remains failure but finally observes socket close", async t => {
  const { value, state } = await observer(t, {}, (message, respond, server) => {
    if (message.params.eventsEnabled === false) server.send({ id: message.id, error: { code: -32000, message: "restore failed" } }); else respond({});
  });
  await value.start({ behavior: "default" });
  await assert.rejects(value.close(), /restore failed/); await assert.rejects(value.close(), /restore failed/);
  const snapshot = value.snapshot(); assert.equal(snapshot.closeObserved, true); assert.equal(snapshot.cleanup.restored, false); assert.match(snapshot.cleanup.error, /restore failed/);
  assert.equal(state.received.filter(row => row.message.params.eventsEnabled === false).length, 1);
});

test("close during configuration cannot be revived by its late successful ACK", async t => {
  let releaseStart, started;
  const startReceived = new Promise(resolve => { started = resolve; });
  const { value, state } = await observer(t, {}, (message, respond) => {
    if (message.params.eventsEnabled === true) { releaseStart = respond; started(); }
    else { respond({}); releaseStart({}); }
  });
  const configuring = value.start({ behavior: "default" });
  const rejectedStart = assert.rejects(configuring, /DISCONNECTED/);
  await startReceived;
  await value.close(); await rejectedStart;
  const snapshot = value.snapshot();
  assert.equal(snapshot.cleanup.restored, true); assert.equal(snapshot.closeObserved, true);
  assert.equal(snapshot.start.acknowledgedAt, undefined);
  assert.equal(snapshot.acks.length, 2);
  assert.deepEqual(state.received.map(row => row.message.params.eventsEnabled), [true, false]);
  assert.throws(() => value.download("one"), /NOT_STARTED/);
  await assert.rejects(value.call("Browser.getVersion"), /DISCONNECTED/);
});

test("restore response timeout still closes the original socket without replay", async t => {
  const { value, state } = await observer(t, { timeoutMs: 80 }, (message, respond) => {
    if (message.params.eventsEnabled !== false) respond({});
  });
  await value.start({ behavior: "default" });
  await assert.rejects(value.close(), /TIMEOUT/);
  const snapshot = value.snapshot();
  assert.equal(snapshot.cleanup.restored, false); assert.equal(snapshot.closeObserved, true);
  assert.match(snapshot.cleanup.error, /TIMEOUT/);
  assert.equal(snapshot.commands.at(-1).ackSequence, undefined);
  assert.equal(typeof snapshot.commands.at(-1).timedOutAt, "number");
  assert.equal(state.received.filter(row => row.message.params.eventsEnabled === false).length, 1);
});

test("failed native handshake records actual socket close without sending CDP", async t => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0, verifyClient: () => false });
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  await assert.rejects(connectOriginalDownloadObserver({
    webSocketURL: `ws://127.0.0.1:${server.address().port}/devtools/browser/rejected`, ownedIsolatedProfile: profile, timeoutMs: 500
  }), failure => {
    assert.match(failure.message, /401/);
    assert.equal(failure.observerSnapshot.closeObserved, true);
    assert.equal(failure.observerSnapshot.records.length, 0);
    return true;
  });
});

test("late ACK is retained on the original connection and a timed-out command is not replayed", async t => {
  let held;
  const { value, state } = await observer(t, { timeoutMs: 80 }, (message, respond) => {
    if (message.method === "Target.getTargets") held = respond; else respond({});
  });
  await value.start({ behavior: "default" });
  await assert.rejects(value.call("Target.getTargets"), /TIMEOUT/);
  held({ targetInfos: [] }); await barrier(value);
  assert.equal(value.snapshot().acks.filter(row => row.late).length, 1);
  assert.equal(state.received.filter(row => row.message.method === "Target.getTargets").length, 1);
  await value.close(); assert.equal(state.peers.length, 1);
});

test("transport loss rejects pending metadata and cannot reconnect or claim cleanup ACK", async t => {
  const { value, state } = await observer(t, {}, (message, respond, server) => {
    if (message.method === "Target.getTargets") server.peers[0].terminate(); else respond({});
  });
  await value.start({ behavior: "default" });
  await assert.rejects(value.call("Target.getTargets"), /DISCONNECTED/);
  await assert.rejects(value.call("Browser.getVersion"), /DISCONNECTED/);
  await assert.rejects(value.close(), /DISCONNECTED/);
  assert.equal(value.snapshot().closeObserved, true); assert.equal(value.snapshot().cleanup.restored, false); assert.equal(state.peers.length, 1);
});

test("raw ledger overflow is explicit, terminates observation, and rejects download evidence", async t => {
  const { value, state } = await observer(t, { maxRecords: 4 }); await value.start({ behavior: "default" });
  state.send(begin("one")); state.send(progress("one"));
  state.send({ method: "Target.targetCreated", params: { targetInfo: { targetId: "overflow" } } });
  await assert.rejects(value.call("Browser.getVersion"), /OVERFLOW/);
  await assert.rejects(value.close(), /OVERFLOW/);
  const snapshot = value.snapshot(); assert.equal(snapshot.overflow, true); assert.equal(snapshot.closeObserved, true);
  assert.throws(() => value.download("one"), /OVERFLOW/);
});
