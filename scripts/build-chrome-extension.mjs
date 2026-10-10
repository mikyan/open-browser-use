import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { patchCrxAISnapshot } from "./patch-ai-snapshot.mjs";
import { patchCrxNavigationWaits } from "./patch-navigation-waits.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = path.join(repoRoot, "apps/chrome-extension");
export const PLAYWRIGHT_CRX_VERSION = "0.15.0";
const upstreamChunkSha256 = "ae0b36fa86fab5f0594530f29860721e5d05ea0cf06950df484a61f0e54c3b8c";
const productionFiles = [
  "manifest.json", "background.js", "native-message-receiver.js", "auxiliary-tab-ownership.js", "browser-action-engine.js", "browser-downloads.js", "browser-network-waits.js", "browser-navigation-waits.js", "browser-observation.js", "browser-ai-snapshot.js", "browser-diagnostics.js", "browser-frame-adapter.js", "browser-input-adapter.js", "browser-runtime.js", "content-cursor.js", "content-webmcp-main.js", "content-webmcp-bridge.js",
  "icons/icon-16.png", "icons/icon-32.png", "icons/icon-48.png", "icons/icon-128.png", "images/cursor-chat.png", "popup.css", "popup.html", "popup.js", "popup-control.js"
];
const sendExpression = "return await chrome.debugger.sendCommand(debuggee, method, commandParams);";

async function assertGeneratedOutput(destination) {
  const actualRoot = await fs.realpath(repoRoot);
  const segments = path.relative(repoRoot, destination).split(path.sep);
  let current = repoRoot;
  for (const segment of segments) {
    current = path.join(current, segment);
    let stat;
    try { stat = await fs.lstat(current); }
    catch (error) { if (error.code === "ENOENT") break; throw error; }
    if (stat.isSymbolicLink()) throw new Error(`Extension output cannot traverse a symlink or junction: ${current}`);
    const actual = await fs.realpath(current);
    const relative = path.relative(actualRoot, actual);
    if (!relative || path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) throw new Error("Extension output resolves outside its generated repository subtree");
  }
}

export function patchCrxTransport(source) {
  if (source.split(sendExpression).length !== 2) throw new Error("Pinned Playwright CRX transport shape changed; review the command observer patch before building");
  const eventHandler = '__publicField(this, "_onDebuggerEvent", ({ tabId, sessionId }, message, params) => {';
  const popupHandler = '__publicField(this, "_onPopupCreated", async ({ openerTabId, id }) => {';
  const eventDelivery = '      if (debugLogger.isEnabled(`chromedebugger`))';
  const emitMessage = '  _emitMessage(message) {\n    if (this.onmessage)\n      this.onmessage(message);\n  }';
  const nativeDetach = '    await chrome.debugger.detach({ tabId }).catch(() => {\n    });';
  const transportDetach = '  async detach(tabOrTarget) {\n    var _a2;\n    const tabId = typeof tabOrTarget === "number" ? tabOrTarget : this._targetToTab.get(tabOrTarget);\n    if (!tabId)\n      return;\n    const targetInfo = this._tabToTarget.get(tabId);';
  const appDetach = '  async _doDetach(targetId) {\n    var _a2;\n    if (!targetId)\n      return;\n    if (this._transport.isIncognito(targetId) !== this.isIncognito())\n      throw new Error("Tab is not in the expected browser context");\n    const crPage = this._crPageByTargetId(targetId);\n    if (!crPage)\n      return;';
  const appTransportDetach = '    await this._transport.detach(targetId);\n    await closed;';
  const appClosed = '    const closed = new Promise((x) => pageOrError.once(Page$1.Events.Close, x));';
  for (const expression of [eventHandler, eventDelivery, emitMessage]) {
    if (source.split(expression).length !== 2) throw new Error("Pinned Playwright CRX frame transport shape changed; review the frame attachment adapter before building");
  }
  if (source.split(popupHandler).length !== 2) throw new Error("Pinned Playwright CRX popup attachment shape changed; review before building");
  if (source.split(nativeDetach).length !== 2) throw new Error("Pinned Playwright CRX input cleanup transport shape changed; review before building");
  for (const expression of [transportDetach, appDetach, appTransportDetach, appClosed]) {
    if (source.split(expression).length !== 2) throw new Error("Pinned Playwright CRX detach identity shape changed; review before building");
  }
  const patched = source.replace(sendExpression, `const operation = () => chrome.debugger.sendCommand(debuggee, method, commandParams);
    const result = await (openBrowserUseInputHooks ? openBrowserUseInputHooks.send(debuggee, method, commandParams, operation) : operation());
    if (!openBrowserUseInputHooks) observeCrxInputCommand(this, debuggee, method, commandParams);
    if (method === "Input.dispatchMouseEvent") {
      try { Promise.resolve(openBrowserUseCommandObserver?.({ target: debuggee, method, commandParams })).catch(() => {}); } catch {}
    }
    return result;`)
    .replace(popupHandler, popupHandler + '\n      // Production Page attachment requires backend ownership and admission.\n      // Chrome-created popups must not bypass those hooks via this listener.\n      if (openBrowserUseInputHooks) return;')
    .replace(eventHandler, eventHandler.replace('({ tabId', 'async ({ tabId') + '\n      if (message === "Page.screencastFrame" && openBrowserUseEventFilter?.({ tabId, sessionId }, message, params)) return;')
    .replace(eventDelivery, '      if (message === "Target.attachedToTarget") await prepareCrxChildFrame(this, { tabId, sessionId }, params);\n' + eventDelivery)
    .replace(emitMessage, '  _emitMessage(message) {\n    observeCrxFrameMessage(this, message);\n    if (this.onmessage) this.onmessage(message);\n    refreshCrxCachedLifecycle(this, message).catch(() => {});\n  }')
    .replace(transportDetach, transportDetach.replace('detach(tabOrTarget)', 'detach(tabOrTarget, expectedTargetInfo)').replace('      return;', '      return false;') + `
    if (expectedTargetInfo && targetInfo !== expectedTargetInfo) return false;
    const inputRelease = openBrowserUseInputHooks?.prepareRelease(tabId);`)
    .replace(appDetach, appDetach + `
    const expectedTargetInfo = this._transport._tabToTarget.get(this._transport._targetToTab.get(targetId));
    if (!expectedTargetInfo) return;
    // OBU exposes no recorder/highlight API. Cancel Page work synchronously,
    // before waiting for optional UI teardown that can leave locator scripts live.
    if (openBrowserUseInputHooks) return this._transport.detach(targetId, expectedTargetInfo);`)
    .replace(appTransportDetach, '    if (await this._transport.detach(targetId, expectedTargetInfo) === false) return;\n    await closed;')
    .replace(appClosed, '    if (this._transport._tabToTarget.get(this._transport._targetToTab.get(targetId)) !== expectedTargetInfo) return;\n' + appClosed)
    .replace(nativeDetach, `    if (inputRelease) {
      await inputRelease.release();
      if (inputRelease.isCurrent()) await inputRelease.detach();
    } else {
      await releaseCrxInput(this, tabId);
${nativeDetach}
    }`);
  return `// Modified by Open Browser Use: pointer observation, native OOPIF/BFCache lifecycle repair, backend-authorized Page attachment, shared rendering event ownership, and bounded input release after Playwright cancellation.\nimport { observeCrxFrameMessage, prepareCrxChildFrame, refreshCrxCachedLifecycle } from "../../../browser-frame-adapter.js";\nimport { observeCrxInputCommand, releaseCrxInput } from "../../../browser-input-adapter.js";\nlet openBrowserUseCommandObserver, openBrowserUseEventFilter, openBrowserUseInputHooks;\nexport function setOpenBrowserUseCommandObserver(observer) { openBrowserUseCommandObserver = observer; }\nexport function setOpenBrowserUseEventFilter(filter) { openBrowserUseEventFilter = filter; }\nexport function setOpenBrowserUseInputHooks(hooks) { openBrowserUseInputHooks = hooks; }\n${patched.replace(/^\/\/# sourceMappingURL=.*$/gm, "")}`;
}

export async function buildChromeExtension(outputDir = path.join(repoRoot, "dist/chrome-extension-unpacked")) {
  const destination = path.resolve(outputDir);
  const relative = path.relative(repoRoot, destination);
  if (!relative || path.isAbsolute(relative) || relative.startsWith(`..${path.sep}`) || relative === ".." || !["dist", ".tmp"].includes(relative.split(path.sep)[0]) || relative.split(path.sep).length < 2) {
    throw new Error("Extension build output must be a child directory of this repository's dist/ or .tmp/");
  }
  await assertGeneratedOutput(destination);
  const require = createRequire(path.join(sourceDir, "package.json"));
  const packageFile = require.resolve("playwright-crx/package.json");
  const packageDir = path.dirname(packageFile);
  const packageInfo = JSON.parse(await fs.readFile(packageFile, "utf8"));
  if (packageInfo.version !== PLAYWRIGHT_CRX_VERSION || packageInfo.license !== "Apache-2.0") throw new Error("Unexpected Playwright CRX version/license; install the frozen workspace lockfile");
  const entry = await fs.readFile(path.join(packageDir, "lib/index.mjs"), "utf8");
  const chunks = [...new Set([...entry.matchAll(/from\s+["']\.\/([^"']+\.mjs)["']/g)].map(match => match[1]))];
  if (chunks.length !== 1 || chunks[0].includes("/")) throw new Error("Unexpected Playwright CRX ESM entry layout");
  const upstreamChunk = await fs.readFile(path.join(packageDir, "lib", chunks[0]), "utf8");
  if (createHash("sha256").update(upstreamChunk).digest("hex") !== upstreamChunkSha256) throw new Error("Pinned Playwright CRX chunk digest changed; review and repin the transport adapters before building");
  const chunk = patchCrxNavigationWaits(patchCrxAISnapshot(patchCrxTransport(upstreamChunk)));
  // All resolved deletion targets are restricted to a generated subtree above.
  await fs.rm(destination, { recursive: true, force: true });
  for (const file of productionFiles) {
    await fs.mkdir(path.dirname(path.join(destination, file)), { recursive: true });
    await fs.copyFile(path.join(sourceDir, file), path.join(destination, file));
  }
  const vendor = path.join(destination, "vendor/playwright-crx");
  await fs.mkdir(path.join(vendor, "upstream"), { recursive: true });
  await fs.writeFile(path.join(vendor, "upstream/index.mjs"), entry.replace(/^\/\/# sourceMappingURL=.*$/gm, ""));
  await fs.writeFile(path.join(vendor, "upstream", chunks[0]), chunk);
  await fs.writeFile(path.join(vendor, "index.mjs"), `export { crx } from "./upstream/index.mjs";\nexport { setOpenBrowserUseCommandObserver, setOpenBrowserUseEventFilter, setOpenBrowserUseInputHooks, assertOpenBrowserUseSelector, createOpenBrowserUseNavigationWait } from "./upstream/${chunks[0]}";\n`);
  for (const name of ["LICENSE", "NOTICE"]) await fs.copyFile(path.join(packageDir, name), path.join(vendor, name));
  await fs.writeFile(path.join(vendor, "MODIFICATIONS.txt"), "Open Browser Use modifies the pinned Playwright CRX transport to notify an optional observer after successful pointer commands and to deliver a missing Page.frameAttached before an already-loaded OOPIF target attachment. Frame ids and parent ids come exclusively from that attached child session's native Page.getFrameTree response; known frames and detached sessions are not replayed. After a native BackForwardCacheRestore navigation, it re-enables native lifecycle reporting on that owned session so Chromium supplies actual cached-document milestones, without fabricating load events or reloading. Internal rendering-lease screencast frames are filtered from the CRX transport so the backend remains their sole acknowledger; caller-owned screencasts are not filtered. Scoped native-send hooks share input intent, native in-flight promises, and attachment identity with the raw CDP route. After Playwright Page cancellation, bounded cleanup drains native sends and releases remaining input through its original root or child target before native debugger detachment. With production input hooks configured, Page cancellation is dispatched synchronously before optional recorder/highlight teardown; OBU exposes neither UI API. All new CRX native commands pass admission/release fences, while cleanup uses a separate native path. Production hooks also disable the upstream tabs.onCreated popup auto-attachment: every new Page must pass backend session ownership, admission, and attachment hooks first. This does not change native popup activation behavior or flat child-frame auto-attachment. Standalone CRX without hooks retains upstream popup attachment and UI teardown. Detachment captures the original CRX target object before asynchronous Page cleanup and binds release/native detach to the original backend attachment token, so late cleanup cannot release or detach a replacement connection. Cleanup failure retains the native attachment for an explicit cleanup retry; it does not reattach or replay the failed action. Locator/action semantics remain Playwright's. The pointer observer cannot change or fail the original command. The original Apache-2.0 LICENSE and NOTICE are included.\n");
  await fs.writeFile(path.join(vendor, "version.json"), `${JSON.stringify({ package: "playwright-crx", version: PLAYWRIGHT_CRX_VERSION, playwrightVersion: "1.53.0", license: packageInfo.license, upstreamChunkSha256 }, null, 2)}\n`);
  await fs.appendFile(path.join(vendor, "MODIFICATIONS.txt"), "Open Browser Use also extends the private Page.snapshotForAI channel with an opt-in bounded metadata form; the original client string result remains compatible. Live Frame identities retain stable ordinal slots and reuse detached holes. The original injected ARIA traversal and renderer count nodes, document/frame depth, UTF-8 output bytes and emitted references, collecting reference metadata at genuine renderer output sites rather than parsing page-controlled text. Recursive frame capture uses a shared deadline and node/reference/frame/output budgets; unavailable children and limit failures reject the capture instead of silently returning partial content. The runtime adapter maps dispatcher Frame GUIDs to actual client Frame objects for capture identity and ancestor pre-scroll before reference screenshots. All these adaptations are guarded by the pinned upstream digest and source-shape checks; the original Apache-2.0 LICENSE and NOTICE are retained.\n");
  await fs.appendFile(path.join(vendor, "MODIFICATIONS.txt"), "An exported pure selector guard reuses the unchanged native parseSelector and visitAllSelectorParts functions to reject the aria-ref selector engine, including captured/composite/nested selectors, outside OBU's capture-scoped descriptor. Ordinary CSS attributes, text and XPath string values containing the same characters retain their original parsing semantics.\n");
  await fs.appendFile(path.join(vendor, "MODIFICATIONS.txt"), "Bounded iframe nodes use the native ARIA collection rendering branch so iframe fallback text and the actual child document share a valid YAML child list; ordinary unbounded renderer output is unchanged.\n");
  await fs.appendFile(path.join(vendor, "MODIFICATIONS.txt"), "An opt-in private client navigation Waiter hook exposes listener readiness and cancellation around the unchanged Page.waitForURL/waitForLoadState APIs. Readiness follows installation of the actual native navigation/load-state listener or native cached-state completion. Cancellation joins the exact Waiter's native failure race, which disposes its listeners and timers, without closing the Page or changing URL matching, lifecycle state, navigation errors, or other observers. A cancelled setup cannot register a late listener. Unhooked native waits retain their original behavior.\n");
  return destination;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== "--output")) throw new Error("Usage: node scripts/build-chrome-extension.mjs [--output <repository dist/.tmp child>]");
  console.log(await buildChromeExtension(args[1]));
}
