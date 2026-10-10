import assert from "node:assert/strict";
import test from "node:test";
import { OpenBrowserUseBrowser, OpenBrowserUseClient } from "../dist/index.js";

const engine = { name: "playwright-crx", version: "0.15.0", playwrightVersion: "1.53.0" };
class RecordedClient extends OpenBrowserUseClient {
  calls = [];
  result = null;
  constructor() { super({ socketPath: "unused", timeoutMs: 10_000 }); }
  async request(method, params, options) {
    this.calls.push({ method, params, options });
    return { value: this.result, engine };
  }
}

test("locator chains are immutable and keep frame, semantic, and positional scope", async () => {
  const client = new RecordedClient();
  const tab = new OpenBrowserUseBrowser({ client }).tab(91);
  const options = { name: "Save", exact: true };
  const buttons = tab.frameLocator("#settings").getByRole("button", options);
  options.name = "Mutated outside the locator";
  const first = buttons.first();
  const second = buttons.nth(1).filter({ hasNotText: "Disabled" });
  await first.click({ timeoutMs: 25_000, force: false });
  await second.hover();
  assert.deepEqual(client.calls[0].params.locator, [
    { kind: "frame", selector: "#settings" },
    { kind: "role", role: "button", name: "Save", exact: true }, { kind: "first" }
  ]);
  assert.equal(buttons.steps.length, 2);
  assert.equal(second.steps.length, 4);
  assert.deepEqual(client.calls[0].params.args, { force: false });
  assert.equal(client.calls[0].params.timeoutMs, 25_000);
  assert.equal(client.calls[0].options.timeoutMs, 26_000);
  assert.throws(() => buttons.steps.push({ kind: "last" }), TypeError);
  assert.throws(() => buttons.steps[0].selector = "outside", TypeError);
});

test("semantic reads preserve null, false, numbers, arrays, and screenshot bytes", async () => {
  const client = new RecordedClient();
  const locator = new OpenBrowserUseBrowser({ client }).tab(92).getByTestId("entry");
  assert.equal(await locator.getAttribute("missing"), null);
  client.result = false;
  assert.equal(await locator.isChecked(), false);
  client.result = 0;
  assert.equal(await locator.count(), 0);
  client.result = ["One", "Two"];
  assert.deepEqual(await locator.allInnerTexts(), ["One", "Two"]);
  client.result = { base64: "AA==", mimeType: "image/png" };
  assert.deepEqual(await locator.screenshot(), client.result);
  client.result = "not a screenshot";
  await assert.rejects(locator.screenshot(), /Invalid screenshot/);
});

test("navigation and snapshots use the engine with metadata and explicit timeouts", async () => {
  const client = new RecordedClient();
  const tab = new OpenBrowserUseBrowser({ client }).tab(93);
  await tab.goto("https://example.test", { waitUntil: "domcontentloaded", timeoutMs: 5000 });
  await tab.waitForURL("**/done", { timeoutMs: 5000 });
  client.result = '- heading "Example"\n- button "Save"';
  assert.match(await tab.playwright.domSnapshot(), /button "Save"/);
  assert.deepEqual(await tab.engineInfo(), engine);
  assert.deepEqual(client.calls.map(call => call.params.action), ["goto", "waitForURL", "snapshot", "engineInfo"]);
  assert.ok(client.calls.every(call => call.method === "browserAction"));
  assert.deepEqual(client.calls[0].params.args, { url: "https://example.test", waitUntil: "domcontentloaded" });
  assert.equal(client.calls[1].params.timeoutMs, 5000);
});

test("locator ariaSnapshot preserves selected frame scope, timeout, and YAML result", async () => {
  const client = new RecordedClient();
  const selected = new OpenBrowserUseBrowser({ client }).tab(93).frameLocator("#settings").getByRole("region", { name: "Preferences" });
  client.result = '- region "Preferences":\n  - checkbox "Notifications" [checked]';
  assert.equal(await selected.ariaSnapshot({ timeoutMs: 1500 }), client.result);
  assert.equal(client.calls[0].params.action, "snapshot");
  assert.deepEqual(client.calls[0].params.locator, [
    { kind: "frame", selector: "#settings" }, { kind: "role", role: "region", name: "Preferences" }
  ]);
  assert.deepEqual(client.calls[0].params.args, {});
  assert.equal(client.calls[0].params.timeoutMs, 1500);
  assert.equal(client.calls[0].options.timeoutMs, 2500);
  client.result = { text: "not a YAML string" };
  await assert.rejects(selected.ariaSnapshot(), /Invalid snapshot/);
});

test("unavailable or incompatible engine response fails clearly", async () => {
  const client = new RecordedClient();
  client.request = async () => ({ value: "plain text", engine: { name: "fallback" } });
  await assert.rejects(client.browserAction(1, "snapshot"), /Invalid browserAction response/);
  client.request = async () => ({ engine });
  await assert.rejects(client.browserAction(1, "snapshot"), /Invalid browserAction response/);
});

test("form and keyboard actions send values separately from timeouts", async () => {
  const client = new RecordedClient();
  const tab = new OpenBrowserUseBrowser({ client }).tab(94);
  await tab.getByLabel("Name").fill("Ada", { timeoutMs: 2000 });
  await tab.getByRole("checkbox").setChecked(true);
  await tab.keyboard.press("Control+A");
  await tab.mouse.click(20, 30, { button: "right" });
  assert.deepEqual(client.calls.map(call => [call.params.action, call.params.args]), [
    ["fill", { value: "Ada" }], ["setChecked", { checked: true }],
    ["keyboard.press", { key: "Control+A" }], ["mouse.click", { x: 20, y: 30, button: "right" }]
  ]);
});

test("history navigation and low-level input preserve action arguments and deadlines", async () => {
  const client = new RecordedClient();
  const tab = new OpenBrowserUseBrowser({ client }).tab(95);
  client.result = { url: "http://example.test/", status: 200 };
  assert.deepEqual(await tab.goBack({ waitUntil: "domcontentloaded", timeoutMs: 2000 }), client.result);
  await tab.playwright.goForward();
  await tab.reload();
  await tab.getByLabel("Name").focus();
  await tab.getByLabel("Name").pressSequentially("Ada", { delay: 5, timeoutMs: 3000 });
  await tab.getByText("Footer").scrollIntoViewIfNeeded();
  await tab.mouse.down({ button: "right" });
  await tab.mouse.up({ button: "right" });
  assert.deepEqual(client.calls.map(call => call.params.action), ["goBack", "goForward", "reload", "focus", "pressSequentially", "scrollIntoViewIfNeeded", "mouse.down", "mouse.up"]);
  assert.deepEqual(client.calls[4].params.args, { text: "Ada", delay: 5 });
  assert.equal(client.calls[4].params.timeoutMs, 3000);
  assert.deepEqual(client.calls[6].params.args, { button: "right" });
});

test("drag target preserves its locator chain and rejects a different tab or client before sending", async () => {
  const client = new RecordedClient();
  const browser = new OpenBrowserUseBrowser({ client });
  const tab = browser.tab(96);
  const source = tab.getByTestId("source"), target = tab.frameLocator("iframe").getByRole("button", { name: "Drop" });
  await source.dragTo(target, { timeoutMs: 7000, force: false, sourcePosition: { x: 4, y: 5 } });
  assert.deepEqual(client.calls[0].params.args, { target: target.steps, force: false, sourcePosition: { x: 4, y: 5 } });
  assert.equal(client.calls[0].params.timeoutMs, 7000);
  await assert.rejects(source.dragTo(browser.tab(97).locator("#target")), /same tab and client/);
  await assert.rejects(source.dragTo(new OpenBrowserUseBrowser({ client: new RecordedClient() }).tab(96).locator("#target")), /same tab and client/);
  assert.equal(client.calls.length, 1);
});

test("diagnostics preserves typed cursors and rejects malformed snapshots", async () => {
  const client = new RecordedClient();
  const tab = new OpenBrowserUseBrowser({ client }).tab(98);
  const cursor = { captureId: "capture-one", sequence: 4 };
  client.result = { captureId: cursor.captureId, startedAt: "2026-10-11T00:00:00Z", entries: [{ kind: "console", sequence: 5, timestamp: "2026-10-11T00:00:01Z", text: "hello" }], cursor: { ...cursor, sequence: 5 }, dropped: 0 };
  assert.deepEqual(await tab.diagnostics({ after: cursor, limit: 2, timeoutMs: 3000 }), client.result);
  assert.equal(client.calls[0].params.action, "diagnostics");
  assert.deepEqual(client.calls[0].params.args, { after: cursor, limit: 2 });
  assert.equal(client.calls[0].params.timeoutMs, 3000);
  client.result = { ...client.result, entries: [{ kind: "unknown", sequence: 5, timestamp: "2026-10-11T00:00:01Z" }] };
  await assert.rejects(tab.diagnostics(), /Invalid diagnostics/);
  client.result = { captureId: "missing-cursor", entries: [] };
  await assert.rejects(tab.diagnostics(), /Invalid diagnostics/);
});
