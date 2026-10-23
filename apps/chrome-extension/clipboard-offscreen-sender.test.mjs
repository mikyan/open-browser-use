import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { webcrypto } from "node:crypto";
import test from "node:test";
import vm from "node:vm";
import { resolveManagedWorkerScript } from "./managed-native-host.js";

// Exercise the real document bootstrap and reconnect listener with inert Ports.
// No browser or system clipboard is involved.
const source = (await readFile(new URL("./clipboard-offscreen.js", import.meta.url), "utf8"))
  .replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, "");
const runID = "a".repeat(32), extensionID = "b".repeat(32);
const managed = `managed-worker-${runID}.js`;

function fixture(config) {
  let listener, disconnect, connections = 0;
  const getURL = name => `chrome-extension://${extensionID}/${name}`;
  const runtime = {
    // Match the real offscreen API: getManifest is unavailable.
    id: extensionID, getURL,
    onMessage: { addListener(value) { listener = value; } },
    connect() {
      connections++;
      return {
        onDisconnect: { addListener(value) { disconnect = value; } },
        onMessage: { addListener() {} }, postMessage() {}
      };
    }
  };
  try { vm.runInNewContext(source, {
    chrome: { runtime }, managedConfig: config, resolveManagedWorkerScript, document: {}, navigator: { clipboard: {
      read() { throw Error("unexpected clipboard read"); },
      write() { throw Error("unexpected clipboard write"); }
    } },
    crypto: webcrypto, ClipboardItem: class {}, Blob, createImageBitmap() {}
  }); } catch (error) {
    assert.equal(connections, 0, "invalid configuration must fail before a Port is opened");
    assert.equal(listener, undefined, "invalid configuration cannot authorize a reconnect listener");
    throw error;
  }
  assert.equal(connections, 1);
  disconnect();
  return {
    send(sender, message = { type: "obu.clipboard.reconnect" }) { listener(message, sender); },
    sender: { id: extensionID, url: getURL(resolveManagedWorkerScript(config)) }, getURL,
    connections: () => connections
  };
}

for (const script of ["background.js", managed]) test(`only the declared ${script} can reconnect the offscreen Port`, () => {
  const f = fixture(script === "background.js" ? null : { version: 1, nativeHostName: `com.openbrowseruse.managed.n${runID}` });
  for (const sender of [
    { ...f.sender, id: "c".repeat(32) },
    { ...f.sender, tab: { id: 7 } },
    { ...f.sender, url: f.getURL("popup.html") },
    { ...f.sender, url: f.getURL(`managed-worker-${"d".repeat(32)}.js`) },
    { ...f.sender, url: f.getURL(script === "background.js" ? managed : "background.js") },
    { ...f.sender, url: f.sender.url + "?previous=1" },
    { ...f.sender, url: f.sender.url + "#previous" },
    { ...f.sender, url: f.sender.url.replace(extensionID, "e".repeat(32)) }
  ]) f.send(sender);
  f.send(f.sender, { type: "unrelated" });
  assert.equal(f.connections(), 1, "a stale or unrelated sender must not reopen the Port");
  f.send(f.sender);
  assert.equal(f.connections(), 2);
});

for (const config of [undefined, {}, { version: 2, nativeHostName: `com.openbrowseruse.managed.n${runID}` },
  ...["../background.js", "com.openbrowseruse.managed.nshort", `com.openbrowseruse.managed.n${"A".repeat(32)}`,
    `com.openbrowseruse.managed.n${runID}?run=1`].map(nativeHostName => ({ version: 1, nativeHostName }))])
  test(`invalid packaged configuration ${JSON.stringify(config)} rejects bootstrap`, () => {
    assert.throws(() => fixture(config), /OBU_MANAGED_CONFIG_INVALID/);
  });
