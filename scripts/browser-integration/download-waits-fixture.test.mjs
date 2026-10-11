import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createServer as createIPCServer } from "node:net";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Script, createContext } from "node:vm";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { createDownloadWaitFixtures, downloadPageHTML, downloadVariants, installDownloadTrace, verifyDownloadFiles, startDownloadEvidence } from "./download-waits-fixture.mjs";

test("an actual SDK listener alone sends no session binding; monitor readiness awaits a public scoped read", { timeout: 10000 }, async () => {
  // Bundle current SDK source in memory so this harness test does not depend on
  // an earlier dist build. The IPC peer supplies wire replies, not a browser.
  // Actual host session routing is separately covered by notification_routing_test.go.
  const bundled = await build({ entryPoints: [fileURLToPath(new URL("../../packages/open-browser-use-js/src/index.ts", import.meta.url))], bundle: true, platform: "node", format: "esm", write: false });
  const { connectOpenBrowserUse, encodeFrame } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`);
  const temporaryParent = await fs.realpath(os.tmpdir()), directory = await fs.mkdtemp(path.join(temporaryParent, "obu-download-monitor-"));
  const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\obu-download-monitor-${randomUUID()}` : path.join(directory, "monitor.sock");
  const calls = [], sockets = new Set(); let peer, owner, finish, connected;
  const accepted = new Promise(resolve => { connected = resolve; });
  const ipc = createIPCServer(socket => {
    peer = socket; connected(socket); sockets.add(socket); socket.on("close", () => sockets.delete(socket)); let bytes = Buffer.alloc(0);
    socket.on("data", chunk => {
      bytes = Buffer.concat([bytes, chunk]);
      while (bytes.length >= 4) {
        const length = os.endianness() === "LE" ? bytes.readUInt32LE() : bytes.readUInt32BE();
        if (bytes.length < length + 4) break;
        const request = JSON.parse(bytes.subarray(4, length + 4)); bytes = bytes.subarray(length + 4); calls.push(request);
        const result = request.method === "getInfo" ? { metadata: { turnLifecycleVersion: 1 } } : request.method === "getControlState" ? { controlEpoch: 7, nextTurnId: "next", lifecycleVersion: 1, closing: false } : request.method === "getTabs" ? [] : undefined;
        socket.write(encodeFrame(result === undefined ? { jsonrpc: "2.0", id: request.id, error: { message: "test permits read-only bootstrap only" } } : { jsonrpc: "2.0", id: request.id, result }));
      }
    });
  });
  await new Promise(resolve => ipc.listen(endpoint, resolve));
  const context = createContext({ structuredClone, performance, chrome: { debugger: { onEvent: { addListener() {}, removeListener() {} } } } });
  const worker = { evaluate: async expression => new Script(expression).runInContext(context) };
  try {
    owner = await connectOpenBrowserUse({ socketPath: endpoint, sessionId: "readonly-monitor", turnId: "original", timeoutMs: 2000 });
    await accepted;
    let heartbeat, change;
    const heartbeatSeen = new Promise(resolve => { heartbeat = resolve; }), changeSeen = new Promise(resolve => { change = resolve; });
    const unsubscribe = owner.client.onNotification(event => { if (event.method === "heartbeat") heartbeat(); if (event.method === "onDownloadChange") change(); });
    peer.write(encodeFrame({ jsonrpc: "2.0", method: "heartbeat", params: {} }));
    await heartbeatSeen; assert.deepEqual(calls, [], "Connecting and registering local handlers must not be mistaken for a scoped RPC");
    const empty = createDownloadWaitFixtures();
    finish = await startDownloadEvidence({ worker, owner, server: empty, downloadRoot: directory, until: async operation => operation() });
    assert.deepEqual(calls.map(call => call.method), ["getInfo", "getControlState", "getTabs"]);
    assert.deepEqual(calls.at(-1).params, { session_id: "readonly-monitor", turn_id: "original", control_epoch: 7 });
    const notification = { id: "wire-test-guid", session_id: "readonly-monitor", turn_id: "original", control_epoch: 7, tabId: 1, status: "complete" };
    peer.write(encodeFrame({ jsonrpc: "2.0", method: "onDownloadChange", params: notification })); await changeSeen;
    const detail = {}; await finish(detail, false); finish = null; unsubscribe();
    assert.deepEqual(detail.notifications, [notification]); assert.equal(detail.monitorAssociation.method, "getTabs");
    assert.deepEqual(detail.monitorAssociation.scope, calls.at(-1).params);
    assert.ok(detail.monitorAssociation.completedAt >= detail.monitorAssociation.startedAt);
  } finally {
    if (finish) await finish({}, false);
    owner?.close(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => ipc.close(resolve));
    const resolved = await fs.realpath(directory); assert.equal(path.dirname(resolved), temporaryParent); assert.ok(path.basename(resolved).startsWith("obu-download-monitor-"));
    await fs.rm(resolved, { recursive: true, force: true });
  }
});

test("page download variants preserve real native link actions and dynamic child creation", () => {
  for (const variant of downloadVariants) for (const route of ["page", "frame"]) {
    const html = downloadPageHTML(new URL(`http://127.0.0.1/download-waits/${route}?key=test-root&variant=${variant}`), 1234);
    for (const [, script] of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Script(script);
    assert.match(html, /event\.isTrusted/); assert.doesNotMatch(html, /chrome\.downloads|downloadURL|fetch\(/);
    if (variant === "dynamic-oopif" && route === "page") { assert.match(html, /Add download frame/); assert.doesNotMatch(html, /<iframe/); }
    if (variant === "oopif" && route === "page") assert.match(html, /<iframe[^>]+localhost:1234/);
  }
});

test("passive download trace keeps original native GUID/source and bounds capture", () => {
  let listener; const target = {}, chrome = { debugger: { onEvent: { addListener(value) { listener = value; } } } };
  installDownloadTrace(chrome, target, 2);
  listener({ tabId: 1 }, "Page.downloadProgress", { guid: "unseen", state: "completed" });
  listener({ tabId: 1 }, "Page.downloadWillBegin", { guid: "other", url: "https://example.com/file" });
  const source = { tabId: 2, sessionId: "native-child" }, params = { guid: "real-guid", frameId: "real-frame", url: "http://localhost/download-waits/file?key=test-root" };
  listener(source, "Page.downloadWillBegin", params); params.guid = "mutated";
  listener(source, "Page.downloadProgress", { guid: "real-guid", state: "inProgress" });
  listener(source, "Page.downloadProgress", { guid: "real-guid", state: "completed" });
  const trace = target.__downloadReadyTrace;
  assert.equal(trace.overflow, true); assert.equal(trace.events.length, 2);
  assert.equal(trace.events[0].params.guid, "real-guid"); assert.deepEqual(trace.events[0].source, source);
  assert.deepEqual(trace.events.map(event => event.sequence), [0, 1]);
});

test("real HTTP suffix gate retains exact binary bytes; disk verifier rejects duplicate or wrong content", async () => {
  const fixture = createDownloadWaitFixtures(), key = "test-gated";
  const server = createServer((request, response) => { if (!fixture.handle(request, response, server.address().port)) { response.writeHead(404); response.end(); } });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "obu-download-fixture-"));
  try {
    fixture.hold(key);
    const response = await fetch(`http://127.0.0.1:${server.address().port}/download-waits/file?key=${key}&variant=root&sequence=1`);
    assert.equal(response.status, 200); assert.equal(fixture.stats(key).requests[0].finished, false);
    const reader = response.body.getReader(), first = await reader.read(); assert.equal(first.value.length, 4096);
    fixture.release(key);
    const chunks = [first.value]; while (true) { const next = await reader.read(); if (next.done) break; chunks.push(next.value); }
    const bytes = Buffer.concat(chunks), hit = fixture.stats(key).requests[0];
    assert.deepEqual(bytes, Buffer.from(hit.base64, "base64")); assert.equal(hit.finished, true);
    await fs.writeFile(path.join(directory, "arbitrary-native-name.bin"), bytes);
    const once = async operation => { const value = await operation(); assert.ok(value); return value; };
    const files = await verifyDownloadFiles(directory, [], [hit], once); assert.equal(files[0].nonce, hit.nonce);
    await fs.writeFile(path.join(directory, "arbitrary-native-name.bin"), Buffer.from("wrong bytes"));
    await assert.rejects(verifyDownloadFiles(directory, [], [hit], once), /exact fixture response/);
    await assert.rejects(verifyDownloadFiles(directory, [], [hit, hit], once), /Expected values to be strictly equal/);
  } finally {
    fixture.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    const resolved = await fs.realpath(directory), parent = await fs.realpath(os.tmpdir());
    assert.equal(path.dirname(resolved), parent); assert.ok(path.basename(resolved).startsWith("obu-download-fixture-"));
    await fs.rm(resolved, { recursive: true, force: true });
  }
});
