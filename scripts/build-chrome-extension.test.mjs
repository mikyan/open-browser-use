import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { buildChromeExtension, patchCrxTransport } from "./build-chrome-extension.mjs";

test("CRX observer patch fails closed when pinned upstream transport changes", () => {
  const command = "return await chrome.debugger.sendCommand(debuggee, method, commandParams);";
  assert.throws(() => patchCrxTransport("unexpected library"), /shape changed/);
  assert.throws(() => patchCrxTransport(command + command), /shape changed/);
  assert.throws(() => patchCrxTransport(command), /frame transport shape changed/);
  const shape = [command, '__publicField(this, "_onDebuggerEvent", ({ tabId, sessionId }, message, params) => {', '      if (debugLogger.isEnabled(`chromedebugger`))', '  _emitMessage(message) {\n    if (this.onmessage)\n      this.onmessage(message);\n  }', '    await chrome.debugger.detach({ tabId }).catch(() => {\n    });'].join("\n");
  const patched = patchCrxTransport(shape);
  assert.match(patched, /Modified by Open Browser Use/);
  assert.match(patched, /method === "Input.dispatchMouseEvent"/);
  assert.match(patched, /return result/);
  assert.ok(!patched.includes("chrome.debugger.sendCommand ="));
  assert.match(patched, /await prepareCrxChildFrame/);
  assert.match(patched, /observeCrxFrameMessage\(this, message\)/);
  assert.match(patched, /refreshCrxCachedLifecycle\(this, message\)/);
  assert.match(patched, /try \{ await releaseCrxInput\(this, tabId\); \} finally/);
  assert.match(patched, /observeCrxInputCommand\(this, debuggee, method, commandParams\)/);
});

test("extension build includes runnable pinned ESM and third-party notices, not tests", async () => {
  const output = await buildChromeExtension(path.resolve(".tmp/build-extension-test"));
  const vendor = path.join(output, "vendor/playwright-crx");
  assert.match(await fs.readFile(path.join(vendor, "LICENSE"), "utf8"), /Apache License/);
  assert.match(await fs.readFile(path.join(vendor, "NOTICE"), "utf8"), /Playwright/);
  assert.match(await fs.readFile(path.join(vendor, "MODIFICATIONS.txt"), "utf8"), /observer/);
  assert.match(await fs.readFile(path.join(vendor, "MODIFICATIONS.txt"), "utf8"), /BackForwardCacheRestore/);
  assert.equal(JSON.parse(await fs.readFile(path.join(vendor, "version.json"), "utf8")).playwrightVersion, "1.53.0");
  const entry = await fs.readFile(path.join(vendor, "index.mjs"), "utf8");
  for (const match of entry.matchAll(/from "(.+?)"/g)) await fs.access(path.join(vendor, match[1]));
  assert.ok(!(await fs.readdir(output)).some(file => file.endsWith(".test.mjs")));
  await fs.access(path.join(output, "browser-action-engine.js"));
  await fs.access(path.join(output, "browser-frame-adapter.js"));
  await fs.access(path.join(output, "browser-input-adapter.js"));
  await fs.access(path.join(output, "browser-diagnostics.js"));
});

test("build refuses destructive output paths outside generated subtrees", async () => {
  await assert.rejects(buildChromeExtension("apps/chrome-extension"), /generated|child directory/);
  await assert.rejects(buildChromeExtension("dist"), /child directory/);
});

test("build rejects junction or symlink ancestors before clearing output", async () => {
  const target = path.resolve(".tmp/build-link-target");
  const link = path.resolve(".tmp/build-output-link");
  await fs.mkdir(target, { recursive: true });
  await fs.writeFile(path.join(target, "preserve.txt"), "preserve");
  try {
    await fs.symlink(target, link, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(buildChromeExtension(path.join(link, "nested")), /symlink|junction/);
    assert.equal(await fs.readFile(path.join(target, "preserve.txt"), "utf8"), "preserve");
  } finally { await fs.unlink(link).catch(error => { if (error.code !== "ENOENT") throw error; }); }
});
