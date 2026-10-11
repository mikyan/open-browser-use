import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [endpoint, sessionId, tabText, mode] = process.argv.slice(2);
const tabId = Number(tabText), entry = process.env.OBU_JS_SDK_ENTRY;
assert.ok(endpoint && sessionId && entry, "endpoint, session and OBU_JS_SDK_ENTRY are required");
assert.ok(Number.isSafeInteger(tabId) && tabId >= 0, "tabId must be a nonnegative integer");
assert.ok(["eof", "close"].includes(mode), "mode must be eof or close");
const { OpenBrowserUseClient, OpenBrowserUseBrowser } = await import(entry.startsWith("file:") ? entry : pathToFileURL(resolve(entry)).href);
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
const input = lines[Symbol.asyncIterator]();
const emit = value => process.stdout.write(`${JSON.stringify({ kind: "js", mode, tabId, ...value })}\n`);
const disconnected = /OBU_SDK_BROWSER_DISCONNECTED/;
async function command(expected) {
  let timer;
  try {
    const value = await Promise.race([input.next(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out waiting for ${expected}`)), 60000);
    })]);
    assert.equal(value.done, false, `stdin ended before ${expected}`);
    assert.equal(value.value.trim(), expected);
  } finally { clearTimeout(timer); }
}
async function errorFrom(call, name) {
  try { await call(); } catch (error) { return String(error?.message ?? error); }
  throw new Error(`${name} unexpectedly succeeded`);
}
const client = new OpenBrowserUseClient({ socketPath: endpoint, sessionId, timeoutMs: 3000 });
let fresh;
try {
  await client.beginTurn(`sdk-js-${mode}-original-${randomUUID()}`);
  const tab = new OpenBrowserUseBrowser({ client }).tab(tabId);
  const locator = tab.locator("#stale-action");
  const readyText = await tab.locator("#connection-ready").textContent({ timeoutMs: 3000 });
  assert.equal(readyText, "SDK_CONNECTION_READY");
  const originalEpoch = client.controlEpoch, originalTurn = client.turnId;
  emit({ phase: "armed", readyText, originalEpoch, originalTurn });
  await command("cut");
  if (mode === "close") client.close();
  const firstError = await errorFrom(() => locator.click({ timeoutMs: 1000 }), "first stale click");
  const blockedErrors = {};
  const operations = {
    locator: () => locator.click({ timeoutMs: 1000 }),
    beginTurn: () => client.beginTurn("must-not-rebind"),
    connect: () => client.connect(),
    manualEpoch: () => client.request("browserAction", { session_id: sessionId, turn_id: originalTurn,
      control_epoch: originalEpoch, tabId, action: "click", locator: [{ kind: "css", selector: "#stale-action" }],
      timeoutMs: 1000 }, { timeoutMs: 3000 })
  };
  for (const [name, operation] of Object.entries(operations)) {
    blockedErrors[name] = await errorFrom(operation, name);
    assert.match(blockedErrors[name], disconnected);
  }
  emit({ phase: "blocked", firstError, blockedErrors, originalEpoch, originalTurn });
  await command("recover");
  fresh = new OpenBrowserUseClient({ socketPath: endpoint, sessionId, timeoutMs: 3000 });
  await fresh.beginTurn(`sdk-js-${mode}-fresh-${randomUUID()}`);
  await new OpenBrowserUseBrowser({ client: fresh }).tab(tabId).locator("#recover-action").click({ timeoutMs: 3000 });
  const oldLocatorError = await errorFrom(() => locator.click({ timeoutMs: 1000 }), "old locator after recovery");
  assert.match(oldLocatorError, disconnected);
  emit({ phase: "done", freshEpoch: fresh.controlEpoch, freshTurn: fresh.turnId, oldLocatorError });
} catch (error) {
  emit({ phase: "failed", error: String(error?.stack ?? error) });
  process.exitCode = 1;
} finally { client.close(); fresh?.close(); lines.close(); }
