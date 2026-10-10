import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";

const require = createRequire(new URL("../apps/chrome-extension/package.json", import.meta.url));
const packageDir = path.dirname(require.resolve("playwright-crx/package.json"));
const entry = await fs.readFile(path.join(packageDir, "lib/index.mjs"), "utf8");
const chunkName = /from ["']\.\/([^"']+\.mjs)/.exec(entry)[1];
const upstream = await fs.readFile(path.join(packageDir, "lib", chunkName), "utf8");
import { buildChromeExtension, patchCrxTransport } from "./build-chrome-extension.mjs";

test("CRX observer patch fails closed when pinned upstream transport changes", async () => {
  const command = "return await chrome.debugger.sendCommand(debuggee, method, commandParams);";
  assert.throws(() => patchCrxTransport("unexpected library"), /shape changed/);
  assert.throws(() => patchCrxTransport(command + command), /shape changed/);
  assert.throws(() => patchCrxTransport(command), /frame transport shape changed/);
  const patched = patchCrxTransport(upstream);
  assert.match(patched, /Modified by Open Browser Use/);
  assert.match(patched, /method === "Input.dispatchMouseEvent"/);
  assert.match(patched, /return result/);
  assert.ok(!patched.includes("chrome.debugger.sendCommand ="));
  assert.match(patched, /await prepareCrxChildFrame/);
  assert.match(patched, /observeCrxFrameMessage\(this, message\)/);
  assert.match(patched, /refreshCrxCachedLifecycle\(this, message\)/);
  assert.match(patched, /openBrowserUseInputHooks\.send\(debuggee, method, commandParams, operation\)/);
  assert.match(patched, /observeCrxInputCommand\(this, debuggee, method, commandParams\)/);
  assert.throws(() => patchCrxTransport(upstream.replace('"_onPopupCreated"', '"_unexpectedPopupHandler"')), /popup attachment shape changed/);
});

test("production CRX popup creation cannot bypass backend ownership while standalone retains auto-attachment", async () => {
  const source = patchCrxTransport(upstream);
  const start = source.indexOf('__publicField(this, "_onPopupCreated"');
  const listener = source.slice(start, source.indexOf('__publicField(this, "_onRemoved"', start));
  const create = new Function('openBrowserUseInputHooks', '__publicField', listener + 'return this._onPopupCreated;');
  const attached = [];
  const transport = { _tabToTarget: new Map([[42, { targetId: 'owned-opener' }]]), attach: async id => { attached.push(id); } };
  const define = (object, name, value) => { object[name] = value; };
  const production = create.call(transport, { send() {} }, define);
  await production({ openerTabId: 42, id: 51 });
  await production({ openerTabId: 99, id: 52 });
  assert.deepEqual(attached, [], 'native attach must wait for explicit backend authorization');
  const standalone = create.call(transport, undefined, define);
  await standalone({ openerTabId: 42, id: 51 });
  await standalone({ openerTabId: 99, id: 52 });
  await standalone({ id: 53 });
  assert.deepEqual(attached, [51]);
});

function detachMethods(hooks, chrome, applicationHooks = hooks) {
  const source = patchCrxTransport(upstream);
  const transportBody = source.slice(source.indexOf('  async detach(tabOrTarget'), source.indexOf('  close() {', source.indexOf('  async detach(tabOrTarget')));
  const appBody = source.slice(source.indexOf('  async _doDetach(targetId)'), source.indexOf('\n};', source.indexOf('  async _doDetach(targetId)')));
  return {
    transport: new Function('openBrowserUseInputHooks', 'chrome', 'releaseCrxInput', 'return ({'+transportBody+'}).detach')(hooks, chrome, async () => {}),
    application: new Function('Page$1', 'openBrowserUseInputHooks', 'return ({'+appBody+'})._doDetach')({ Events: { Close: 'close' } }, applicationHooks)
  };
}
function transportFixture(detach, targetInfo = { targetId: 'same-target' }) {
  return { _tabToTarget: new Map([[42, targetInfo]]), _targetToTab: new Map([[targetInfo.targetId, 42]]), _emitDetachedToTarget() {}, isIncognito: () => false, detach };
}

test("CRX native cleanup preserves failures and binds input release before Page close", async () => {
  let token = {}, releases = 0, nativeDetaches = 0, finishRelease;
  const originalToken = token;
  const hooks = { prepareRelease: () => {
    const captured = token;
    return { release: async () => { releases++; await new Promise(resolve => { finishRelease = resolve; }); }, isCurrent: () => token === captured, detach: async () => { nativeDetaches++; } };
  } };
  const methods = detachMethods(hooks, {});
  const target = { targetId: 'same-target' };
  const transport = transportFixture(methods.transport, target);
  const oldDetach = transport.detach(42, target);
  assert.equal(releases, 1);
  token = {};
  const successor = { targetId: 'same-target' };
  transport._tabToTarget.set(42, successor);
  transport._targetToTab.set(successor.targetId, 42);
  finishRelease();
  await oldDetach;
  assert.equal(nativeDetaches, 0);
  assert.equal(transport._tabToTarget.get(42), successor);
  assert.notEqual(token, originalToken);

  let failRelease = true;
  const failureMethods = detachMethods({ prepareRelease: () => ({
    release: async () => { if (failRelease) throw new Error('release pending'); },
    isCurrent: () => true,
    detach: async () => { nativeDetaches++; throw new Error('native detach failed'); }
  }) }, {});
  await assert.rejects(failureMethods.transport.call(transportFixture(failureMethods.transport), 42), /release pending/);
  assert.equal(nativeDetaches, 0);
  failRelease = false;
  await assert.rejects(failureMethods.transport.call(transportFixture(failureMethods.transport), 42), /native detach failed/);
  assert.equal(nativeDetaches, 1);
});

test("old CRX application detach cannot remove a replacement attachment after awaited page initialization", async () => {
  let releases = 0, nativeDetaches = 0, finishInitialization;
  const methods = detachMethods({ prepareRelease: () => ({ release: async () => { releases++; }, isCurrent: () => true, detach: async () => { nativeDetaches++; } }) }, {}, null);
  const original = { targetId: 'same-target' };
  const transport = transportFixture(methods.transport, original);
  const page = Object.assign(new EventEmitter(), { hideHighlight: async () => {} });
  const app = { _transport: transport, isIncognito: () => false, _crPageByTargetId: () => ({ _page: { waitForInitializedOrError: () => new Promise(resolve => { finishInitialization = resolve; }) } }) };
  const oldDetach = methods.application.call(app, original.targetId);
  const successor = { targetId: original.targetId };
  transport._tabToTarget.set(42, successor);
  finishInitialization(page);
  await oldDetach;
  assert.equal(releases, 0);
  assert.equal(nativeDetaches, 0);
  assert.equal(transport._tabToTarget.get(42), successor);
  assert.equal(transport._targetToTab.get(successor.targetId), 42);

  app._crPageByTargetId = () => ({ _page: { waitForInitializedOrError: async () => page } });
  transport._emitDetachedToTarget = () => page.emit('close');
  await methods.application.call(app, successor.targetId);
  assert.equal(releases, 1);
  assert.equal(nativeDetaches, 1);
  assert.equal(transport._tabToTarget.size, 0);
});

test("production CRX detach closes Page before any optional initialization or highlight wait", async () => {
  let finishRelease, pageClosed = false, detached = false;
  const methods = detachMethods({ prepareRelease: () => ({
    release: () => new Promise(resolve => { finishRelease = resolve; }),
    isCurrent: () => true,
    detach: async () => { detached = true; }
  }) }, {});
  const transport = transportFixture(methods.transport);
  transport._emitDetachedToTarget = () => { pageClosed = true; };
  const app = { _transport: transport, isIncognito: () => false, _crPageByTargetId: () => ({
    _page: { waitForInitializedOrError() { throw new Error("must not wait for optional Page work before cancellation"); } }
  }) };
  const closing = methods.application.call(app, 'same-target');
  assert.equal(pageClosed, true);
  assert.equal(detached, false);
  finishRelease();
  await closing;
  assert.equal(detached, true);
});

test("extension build includes runnable pinned ESM and third-party notices, not tests", async () => {
  const output = await buildChromeExtension(path.resolve(".tmp/build-extension-test"));
  const vendor = path.join(output, "vendor/playwright-crx");
  assert.match(await fs.readFile(path.join(vendor, "LICENSE"), "utf8"), /Apache License/);
  assert.match(await fs.readFile(path.join(vendor, "NOTICE"), "utf8"), /Playwright/);
  assert.match(await fs.readFile(path.join(vendor, "MODIFICATIONS.txt"), "utf8"), /observer/);
  assert.match(await fs.readFile(path.join(vendor, "MODIFICATIONS.txt"), "utf8"), /BackForwardCacheRestore/);
  assert.match(await fs.readFile(path.join(vendor, "MODIFICATIONS.txt"), "utf8"), /popup auto-attachment/);
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
