import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = (await readFile(new URL("./background.js", import.meta.url), "utf8")).replace('import { createBrowserActionEngine } from "./browser-runtime.js";', "");
const runtimeStart = source.indexOf("chrome.runtime.onInstalled.addListener");
assert.notEqual(runtimeStart, -1);
const session = { session_id: "session-a", turn_id: "turn-a" };
const targets = [
  { id: "owned", tabId: 7, type: "page", url: "https://owned.example" },
  { id: "other-session", tabId: 8, type: "page", url: "https://other.example" },
  { id: "unclaimed", tabId: 9, type: "page", url: "https://user.example" },
  { id: "worker", type: "service_worker", url: "https://other.example/worker.js" },
  { id: "extension", extensionId: "other-extension", type: "background_page" }
];
const json = (value) => JSON.parse(JSON.stringify(value));

async function loadBackend({ sendCommand, attached = true } = {}) {
  const calls = [];
  const result = { result: { type: "string", value: "original CDP result" } };
  const chrome = {
    debugger: {
      onDetach: { addListener() {} },
      async getTargets() { return targets; },
      async sendCommand(...args) {
        calls.push(json(args));
        return sendCommand ? sendCommand(...args) : result;
      }
    },
    storage: { local: { async get() { return {}; }, async set() {} } },
    tabs: {
      async query({ groupId }) {
        return groupId === 10 ? [{ id: 7, groupId: 10, url: "https://owned.example" }]
          : groupId === 11 ? [{ id: 8, groupId: 11, url: "https://other.example" }] : [];
      }
    }
  };
  const BrowserBackend = vm.runInNewContext(`${source.slice(0, runtimeStart)}\nBrowserBackend;`, {
    chrome, Date, setTimeout, clearTimeout
  });
  const backend = new BrowserBackend();
  await backend.store.ready;
  (await backend.store.getSession("session-a")).chromeGroupId = 10;
  (await backend.store.getSession("session-b")).chromeGroupId = 11;
  if (attached) backend.attachedTabs.add(7);
  backend.attachedTabs.add(8);
  const execute = (target, extra = {}) => backend.executeCdp({
    ...session, target, method: "Runtime.evaluate", commandParams: { expression: "document.title" }, ...extra
  });
  return { backend, execute, calls, result };
}

for (const target of [{ tabId: 7 }, { targetId: "owned" }, { tabId: 7, targetId: "owned" }]) {
  test(`owned ${JSON.stringify(target)} is normalized to a single tab root`, async () => {
    const { execute, calls, result } = await loadBackend();
    assert.equal(await execute(target), result);
    assert.deepEqual(calls, [[{ tabId: 7 }, "Runtime.evaluate", { expression: "document.title" }]]);
  });
}

for (const target of [{ tabId: 7, sessionId: "child" }, { targetId: "owned", sessionId: "child" }]) {
  test(`child debugger session remains attached to the owned root: ${JSON.stringify(target)}`, async () => {
    const { execute, calls } = await loadBackend();
    await execute(target);
    assert.deepEqual(calls[0][0], { tabId: 7, sessionId: "child" });
  });
}

for (const target of [{ tabId: 8 }, { targetId: "other-session" }, { targetId: "unclaimed" }]) {
  test(`another session or unclaimed tab is rejected before CDP dispatch: ${JSON.stringify(target)}`, async () => {
    const { execute, calls } = await loadBackend();
    await assert.rejects(execute(target), /not part of browser session session-a/);
    assert.deepEqual(calls, []);
  });
}

test("a caller cannot use a targetId to cross the session boundary in either direction", async () => {
  const { execute, calls } = await loadBackend();
  await assert.rejects(execute({ targetId: "owned" }, { session_id: "session-b" }), /not part of browser session session-b/);
  assert.deepEqual(calls, []);
});

for (const target of [
  { tabId: 7, targetId: "other-session" }, { targetId: "missing" }, { targetId: "worker" },
  { targetId: "extension" }, { extensionId: "other-extension" }, { tabId: 7, extensionId: "other-extension" },
  { tabId: "7" }, { tabId: 7.5 }, { tabId: -1 }, { tabId: null },
  { targetId: "" }, { targetId: 7 }, { sessionId: "child" }, { tabId: 7, sessionId: "" },
  { tabId: 7, sessionId: 1 }, {}, [], "owned", null
]) {
  test(`ambiguous, unsupported or malformed target never reaches Chrome: ${JSON.stringify(target)}`, async () => {
    const { execute, calls } = await loadBackend();
    await assert.rejects(execute(target), /executeCdp/);
    assert.deepEqual(calls, []);
  });
}

test("an owned targetId still requires a debugger attachment", async () => {
  const { execute, calls } = await loadBackend({ attached: false });
  await assert.rejects(execute({ targetId: "owned" }), /Debugger unattached/);
  assert.deepEqual(calls, []);
});

test("unbound discovery returns only session-owned tab targets without requiring an attachment", async () => {
  const { execute, calls } = await loadBackend({ attached: false });
  const result = await execute(undefined, { method: "Target.getTargets" });
  assert.deepEqual(json(result), { targetInfos: [targets[0]] });
  assert.deepEqual(calls, []);
  const other = await execute({}, { method: "Target.getTargets", session_id: "session-b" });
  assert.deepEqual(json(other), { targetInfos: [targets[1]] });
});

test("discovery cannot be used to skip ownership checks on an explicit target", async () => {
  const { execute, calls } = await loadBackend();
  await assert.rejects(execute({ targetId: "other-session" }, { method: "Target.getTargets" }), /not part/);
  await assert.rejects(execute({ extensionId: "other-extension" }, { method: "Target.getTargets" }), /only supports/);
  assert.deepEqual(calls, []);
});

test("normalized CDP dispatch preserves Chrome's original rejection", async () => {
  const failure = new Error("No session with given id");
  const { execute, calls } = await loadBackend({ sendCommand: () => { throw failure; } });
  await assert.rejects(execute({ targetId: "owned", sessionId: "stale-child" }), (error) => error === failure);
  assert.deepEqual(calls[0][0], { tabId: 7, sessionId: "stale-child" });
});
