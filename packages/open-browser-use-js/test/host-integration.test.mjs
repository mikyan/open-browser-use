import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { endianness, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { OpenBrowserUseClient, encodeFrame } from "../dist/index.js";

test("real Go native host routes Node concurrent requests and notifications over local IPC", {
  skip: !process.env.OBU_TEST_HOST_BINARY,
  timeout: 15_000
}, async t => {
  const directory = await mkdtemp(join(tmpdir(), "obu-js-host-"));
  const child = spawn(resolve(process.env.OBU_TEST_HOST_BINARY), ["host", "--socket-dir", directory], {
    windowsHide: true, stdio: ["pipe", "pipe", "pipe"]
  });
  const clients = [];
  t.after(async () => {
    for (const client of clients) client.close();
    const exit = child.exitCode === null ? once(child, "exit") : Promise.resolve();
    child.kill();
    await exit;
    await rm(directory, { recursive: true, force: true });
  });
  let startupError;
  child.once("error", error => { startupError = error; });
  child.stderr.resume();
  let buffer = Buffer.alloc(0);
  let requests = 0;
  child.stdout.on("data", chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const length = endianness() === "LE" ? buffer.readUInt32LE(0) : buffer.readUInt32BE(0);
      if (buffer.length < length + 4) break;
      const request = JSON.parse(buffer.subarray(4, length + 4).toString("utf8"));
      buffer = buffer.subarray(length + 4);
      requests++;
      assert.match(request.id, /^obu:/);
      child.stdin.write(encodeFrame({ jsonrpc: "2.0", method: "heartbeat", params: { active: true } }));
      child.stdin.write(encodeFrame({ jsonrpc: "2.0", id: request.id, result: { session: request.params.session_id, method: request.method } }));
    }
  });
  let endpoint;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (startupError) throw startupError;
    try { endpoint = JSON.parse(await readFile(join(directory, "active.json"), "utf8")).socketPath; break; }
    catch { await delay(10); }
  }
  assert.ok(endpoint, "host publishes its local endpoint");
  if (process.platform === "win32") assert.match(endpoint, /^\\\\\.\\pipe\\/);
  const first = new OpenBrowserUseClient({ socketPath: endpoint, sessionId: "first" });
  const second = new OpenBrowserUseClient({ socketPath: endpoint, sessionId: "second" });
  clients.push(first, second);
  const notifications = [];
  const secondNotifications = [];
  first.onNotification(notification => notifications.push(notification));
  second.onNotification(notification => secondNotifications.push(notification));
  const results = await Promise.all([first.getInfo(), second.getTabs(), first.createTab()]);
  assert.deepEqual(results, [
    { session: "first", method: "getInfo" }, { session: "second", method: "getTabs" }, { session: "first", method: "createTab" }
  ]);
  assert.equal(requests, 5);
  assert.ok(notifications.some(notification => notification.method === "heartbeat"));
  const scoped = (method, session_id, tabId) => ({ jsonrpc: "2.0", method, params: { session_id, tabId, turn_id: "test", control_epoch: 1, marker: "scoped-test" } });
  for (const message of [
    scoped("onCDPEvent", "first", 11),
    scoped("onDownloadChange", "second", 22),
    { jsonrpc: "2.0", method: "onCDPEvent", params: { source: { tabId: 33 }, marker: "must-drop" } },
    { jsonrpc: "2.0", method: "onDownloadChange", params: { marker: "must-drop" } },
    scoped("onCDPEvent", "", 44),
    scoped("onCDPEvent", 123, 55),
    { jsonrpc: "2.0", method: "unknownGlobalEvent", params: { marker: "must-drop" } },
    { jsonrpc: "2.0", method: "heartbeat", params: { marker: "scope-barrier" } },
  ]) child.stdin.write(encodeFrame(message));
  const routedDeadline = Date.now() + 2000;
  while (Date.now() < routedDeadline && ![notifications, secondNotifications].every(events => events.some(event => event.params?.marker === "scope-barrier"))) await delay(5);
  for (const [events, session, tabId] of [[notifications, "first", 11], [secondNotifications, "second", 22]]) {
    assert.ok(events.some(event => event.params?.marker === "scope-barrier"));
    const scopedEvents = events.filter(event => event.method !== "heartbeat");
    assert.equal(scopedEvents.length, 1, JSON.stringify(scopedEvents));
    assert.equal(scopedEvents[0].params.session_id, session);
    assert.equal(scopedEvents[0].params.tabId, tabId);
  }
  // An explicitly requested second session is a routing subscription, not an
  // authentication claim. It does not subscribe unrelated connections.
  await second.request("ping", { session_id: "first" });
  child.stdin.write(encodeFrame({ ...scoped("onCDPEvent", "first", 66), params: { session_id: "first", tabId: 66 } }));
  const sharedDeadline = Date.now() + 2000;
  while (Date.now() < sharedDeadline && ![notifications, secondNotifications].every(events => events.some(event => event.params?.tabId === 66))) await delay(5);
  assert.ok([notifications, secondNotifications].every(events => events.some(event => event.params?.tabId === 66)));
});
