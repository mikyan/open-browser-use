import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "./test-support/page-waits-fixture.mjs";

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function until(check) {
  for (let attempt = 0; attempt < 100; attempt++) { if (check()) return; await tick(); }
  assert.fail("Original ownership validation did not reach its held response");
}
const cases = [
  ["armNetworkWait", "networkWaits", { event: "request", match: { url: "https://fixture.test/report" } }],
  ["armNavigationWait", "navigationWaits", { event: "url", url: "https://fixture.test/next" }],
  ["armFileChooserWait", "fileChooserWaits", {}],
  ["armDownloadWait", "downloadWaits", {}],
  ["downloadURL", "directDownloads", { url: "https://fixture.test/report" }],
  ["exportPage", "pageExports", { format: "pdf" }],
  ["readClipboardText", "clipboard", {}]
];

for (const [method, registryName, extra] of cases) {
  for (const held of [false, true]) {
    test(`${method}: Pause excludes an unowned ${held ? "validation-pending" : "reserved"} source and drains actual work`, { timeout: 3000 }, async t => {
      const f = await fixture(t), gate = f.gate(), registry = f.backend[registryName];
      let entered = false, validationCompleted = false;
      if (held) f.hooks.query = async filter => {
        if (filter.groupId === 10 && !entered) {
          entered = true; await gate.promise; validationCompleted = true;
        }
      };
      const request = { ...f.params, tabId: 8, timeoutMs: 2000, ...extra };
      const action = f.backend[method](request);
      action.catch(() => {});
      const record = [...registry.records.values()][0];
      assert.ok(record, "The real public entry must reserve synchronously");
      if (held) await until(() => entered);
      const before = f.backend.globalControlSnapshot();
      assert.equal(record.scope, undefined);
      if (held) assert.ok(f.backend.acceptedRequests.size > 0);
      let pauseSettled = false;
      const paused = f.backend.pauseAutomation();
      const observed = paused.then(() => { pauseSettled = true; }, error => { pauseSettled = true; throw error; });
      observed.catch(() => {});
      t.after(async () => { gate.resolve(); await Promise.allSettled([action, paused, observed]); });
      await assert.rejects(action, /OBU_.*(EXPIRED|PAUSED|CANCELLED)/);
      if (held) {
        await tick();
        assert.equal(pauseSettled, false, "Pause must retain the actual ownership validation promise");
        assert.equal(validationCompleted, false);
      }
      gate.resolve(); await observed;
      if (held) assert.equal(validationCompleted, true);
      assert.equal(before.tabIds.has(8), false, "A reservation is not authority to detach its source");
      assert.equal(f.calls.some(([name, tabId]) => tabId === 8 && ["attach-start", "attach", "detach"].includes(name)), false);
      assert.ok(f.tabs.has(8));
      assert.equal(f.backend.auxiliaryTabs.entry(8), undefined);
      assert.equal(f.backend.acceptedRequests.size, 0);
      assert.equal(registry.controlSnapshot().pending.length, 0);
    });
  }
}
