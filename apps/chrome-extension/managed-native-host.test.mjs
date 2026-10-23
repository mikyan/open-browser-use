import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "./test-support/backend-vm.mjs";
import managedConfig from "./managed-config.js";
import { resolveManagedNativeHost, resolveManagedWorkerScript } from "./managed-native-host.js";
import { NativeInputTracker } from "./browser-input-adapter.js";

const ordinaryHost = "com.ifuryst.open_browser_use.extension";
const privateHost = "com.openbrowseruse.managed.n0123456789abcdef0123456789abcdef";
const validConfig = { version: 1, nativeHostName: privateHost };
const invalidConfigs = [
  undefined, false, 0, "", [], {},
  { version: 1 }, { nativeHostName: privateHost },
  { ...validConfig, version: 2 }, { ...validConfig, version: "1" },
  { ...validConfig, extra: true }, { ...validConfig, [Symbol("extra")]: true },
  Object.create(validConfig),
  ...[ordinaryHost, "com.other.host", "com.openbrowseruse.managed.n", privateHost.slice(0, -1),
    privateHost + "0", privateHost + "\n", privateHost.toUpperCase(), privateHost.replace("f", "g"),
    null, 1].map(nativeHostName => ({ version: 1, nativeHostName }))
];

test("only the packaged null default selects the ordinary native host", () => {
  assert.equal(managedConfig, null);
  assert.equal(resolveManagedNativeHost(managedConfig, ordinaryHost), ordinaryHost);
  assert.equal(resolveManagedNativeHost(validConfig, ordinaryHost), privateHost);
  for (const config of invalidConfigs) {
    assert.throws(() => resolveManagedNativeHost(config, ordinaryHost), /OBU_MANAGED_CONFIG_INVALID/);
  }
});

test("private worker entry uses the complete validated run configuration", () => {
  assert.equal(resolveManagedWorkerScript(managedConfig), "background.js");
  assert.equal(resolveManagedWorkerScript(validConfig), "managed-worker-0123456789abcdef0123456789abcdef.js");
  for (const config of invalidConfigs) {
    assert.throws(() => resolveManagedWorkerScript(config), /OBU_MANAGED_CONFIG_INVALID/);
  }
});

// Evaluate the actual worker bootstrap and NativeTransport, including its native
// hello. Only browser APIs are faked; there is no replacement host selector.
const source = (await readFile(new URL("./background.js", import.meta.url), "utf8"))
  .replace('import { createBrowserActionEngine } from "./browser-runtime.js";', "")
  .replace('import { NativeInputTracker } from "./browser-input-adapter.js";', "");
function fixture(config) {
  const calls = [], messages = [];
  const event = () => ({ addListener() {} });
  const area = () => {
    const data = {};
    return {
      async get(key) { return structuredClone(Object.hasOwn(data, key) ? { [key]: data[key] } : {}); },
      async set(value) { Object.assign(data, structuredClone(value)); },
      async setAccessLevel() {}
    };
  };
  const chrome = {
    storage: { local: area(), session: area() },
    runtime: {
      id: "a".repeat(32), onStartup: event(), onInstalled: event(), onMessage: event(),
      getManifest: () => ({ version: "test" }), getURL: name => `chrome-extension://${"a".repeat(32)}/${name}`,
      connectNative(name) {
        calls.push(name);
        return { onMessage: event(), onDisconnect: event(), postMessage: message => messages.push(message) };
      }
    },
    alarms: { onAlarm: event(), async create() {}, async clear() {} },
    debugger: { onDetach: event(), onEvent: event(), async getTargets() { return []; } },
    tabs: { async query() { return []; } },
    tabGroups: { async query() { return []; } },
    downloads: { onCreated: event(), onChanged: event() }
  };
  return {
    calls, messages,
    start: () => vm.runInNewContext(`${source}\n({ backend, transport, handleAutomationControlMessage, handleSiteAccessMessage, managedUser: globalThis.__obuManagedUser, managedDescriptor: Object.getOwnPropertyDescriptor(globalThis, "__obuManagedUser") });`, {
      chrome, managedConfig: config, NativeInputTracker, URL, Date, setTimeout, clearTimeout
    })
  };
}

for (const [label, config, expected] of [["ordinary", null, ordinaryHost], ["managed", validConfig, privateHost]]) {
  test(`${label} worker connects to and advertises the same native host`, async () => {
    const f = fixture(config), worker = f.start();
    await worker.backend.controlReady;
    const info = await worker.backend.getInfo();
    assert.deepEqual(f.calls, [expected]);
    assert.equal(info.metadata.nativeHostName, expected);
    assert.equal(worker.transport.getStatus().hostName, expected);
    assert.equal(worker.transport.getStatus().state, "connected");
    assert.equal(f.messages[0].method, "obu.native.hello");
    if (config === null) assert.equal(worker.managedUser, undefined);
    else {
      assert.equal(Object.isFrozen(worker.managedUser), true);
      assert.equal(worker.managedDescriptor.writable, false);
      assert.equal(worker.managedDescriptor.configurable, false);
      assert.deepEqual(Object.keys(worker.managedUser), ["open", "request"]);
    }
    // A managed host changes routing only; it grants no popup control authority.
    for (const [handler, type] of [[worker.handleAutomationControlMessage, "PAUSE_AUTOMATION"],
      [worker.handleSiteAccessMessage, "SET_SITE_ACCESS_POLICY"]]) {
      await assert.rejects(handler({ type }, { id: "a".repeat(32), url: "http://127.0.0.1/viewer" }), /OBU_CONTROL_FORBIDDEN/);
    }
  });
}

test("invalid managed configuration stops worker bootstrap before any native connection", () => {
  for (const config of invalidConfigs) {
    const f = fixture(config);
    assert.throws(f.start, /OBU_MANAGED_CONFIG_INVALID/);
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.messages, []);
  }
});
