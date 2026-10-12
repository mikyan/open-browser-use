import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { patchCrxAISnapshot } from "./patch-ai-snapshot.mjs";
import { patchCrxNavigationWaits } from "./patch-navigation-waits.mjs";
import { patchCrxMediaSource } from "./patch-media-source.mjs";
import { patchCrxDiagnostics } from "./patch-diagnostics.mjs";
import { patchCrxPointerTransport } from "./patch-pointer-transport.mjs";
import { patchCrxPointerDelivery } from "./patch-pointer-delivery.mjs";
import { patchCrxFrameGeometry } from "./patch-frame-geometry.mjs";
import { patchCrxDragDelivery } from "./patch-drag-delivery.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = path.join(repoRoot, "apps/chrome-extension");
export const PLAYWRIGHT_CRX_VERSION = "0.15.0";
const upstreamChunkSha256 = "ae0b36fa86fab5f0594530f29860721e5d05ea0cf06950df484a61f0e54c3b8c";
const productionFiles = [
  "native-page-downloads.js",
  "browser-lifetime.js",
  "browser-file-chooser-waits.js",
  "browser-directory-upload.js",
  "browser-file-input.js",
  "browser-download-waits.js",
  "browser-media-source.js",
  "browser-media-lifetime.js",
  "browser-diagnostic-fence.js",
  "browser-pointer-guard.js",
  "browser-snapshot-geometry.js",
  "browser-clipboard.js", "clipboard-broker.js", "clipboard-offscreen.html", "clipboard-offscreen.js",
  "site-access-policy.js", "site-access-frames.js", "popup-site-access.js",
  "manifest.json", "background.js", "native-message-receiver.js", "auxiliary-tab-ownership.js", "browser-action-engine.js", "browser-downloads.js", "browser-page-exports.js", "browser-network-waits.js", "browser-navigation-waits.js", "browser-observation.js", "browser-ai-snapshot.js", "browser-diagnostics.js", "browser-frame-adapter.js", "browser-input-adapter.js", "browser-runtime.js", "content-cursor.js", "content-webmcp-main.js", "content-webmcp-bridge.js",
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
  const chunk = patchCrxDragDelivery(patchCrxPointerDelivery(patchCrxFrameGeometry(patchCrxPointerTransport(patchCrxDiagnostics(patchCrxMediaSource(patchCrxNavigationWaits(patchCrxAISnapshot(patchCrxTransport(upstreamChunk)))))))));
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
  await fs.writeFile(path.join(vendor, "index.mjs"), `export { crx } from "./upstream/index.mjs";\nexport { setOpenBrowserUseCommandObserver, setOpenBrowserUseEventFilter, setOpenBrowserUseInputHooks, assertOpenBrowserUseSelector, createOpenBrowserUseNavigationWait, runOpenBrowserUseMediaTask } from "./upstream/${chunks[0]}";\n`);
  for (const name of ["LICENSE", "NOTICE"]) await fs.copyFile(path.join(packageDir, name), path.join(vendor, name));
  await fs.writeFile(path.join(vendor, "MODIFICATIONS.txt"), "Open Browser Use modifies the pinned Playwright CRX transport to notify an optional observer after successful pointer commands and to deliver a missing Page.frameAttached before an already-loaded OOPIF target attachment. Frame ids and parent ids come exclusively from that attached child session's native Page.getFrameTree response; known frames and detached sessions are not replayed. After a native BackForwardCacheRestore navigation, it re-enables native lifecycle reporting on that owned session so Chromium supplies actual cached-document milestones, without fabricating load events or reloading. Internal rendering-lease screencast frames are filtered from the CRX transport so the backend remains their sole acknowledger; caller-owned screencasts are not filtered. Scoped native-send hooks share input intent, native in-flight promises, and attachment identity with the raw CDP route. After Playwright Page cancellation, bounded cleanup drains native sends and releases remaining input through its original root or child target before native debugger detachment. With production input hooks configured, Page cancellation is dispatched synchronously before optional recorder/highlight teardown; OBU exposes neither UI API. All new CRX native commands pass admission/release fences, while cleanup uses a separate native path. Production hooks also disable the upstream tabs.onCreated popup auto-attachment: every new Page must pass backend session ownership, admission, and attachment hooks first. This does not change native popup activation behavior or flat child-frame auto-attachment. Standalone CRX without hooks retains upstream popup attachment and UI teardown. Detachment captures the original CRX target object before asynchronous Page cleanup and binds release/native detach to the original backend attachment token, so late cleanup cannot release or detach a replacement connection. Cleanup failure retains the native attachment for an explicit cleanup retry; it does not reattach or replay the failed action. Locator resolution and the existing actionability checks remain Playwright's; the locator pointer preparation adaptation is described below. The pointer observer cannot change or fail the original command. The original Apache-2.0 LICENSE and NOTICE are included.\n");
  await fs.writeFile(path.join(vendor, "version.json"), `${JSON.stringify({ package: "playwright-crx", version: PLAYWRIGHT_CRX_VERSION, playwrightVersion: "1.53.0", license: packageInfo.license, upstreamChunkSha256 }, null, 2)}\n`);
  await fs.appendFile(path.join(vendor, "MODIFICATIONS.txt"), "Open Browser Use also extends the private Page.snapshotForAI channel with an opt-in bounded metadata form; the original client string result remains compatible. Live Frame identities retain stable ordinal slots and reuse detached holes. The original injected ARIA traversal and renderer count nodes, document/frame depth, UTF-8 output bytes and emitted references, collecting reference metadata at genuine renderer output sites rather than parsing page-controlled text. Recursive frame capture uses a shared deadline and node/reference/frame/output budgets; unavailable children and limit failures reject the capture instead of silently returning partial content. The runtime adapter maps dispatcher Frame GUIDs to actual client Frame objects for capture identity and ancestor pre-scroll before reference screenshots. All these adaptations are guarded by the pinned upstream digest and source-shape checks; the original Apache-2.0 LICENSE and NOTICE are retained.\n");
  await fs.appendFile(path.join(vendor, "MODIFICATIONS.txt"), "An additional explicit boxes option samples getBoundingClientRect on each genuine emitted ref element and records that frame's viewport, scroll offsets and devicePixelRatio during the same synchronous utility-world ARIA capture. Inline box numbers count toward the existing UTF-8 output budget. Geometry uses frame-viewport CSS pixels, retains fractional and zero dimensions, and rejects disconnected nodes or non-finite values. Native Frame GUIDs and parent/iframe-owner refs bind the bounded geometry arrays to real Frame identities; runtime validation removes the private GUIDs from public results. Child rectangles are not projected into the root viewport, including for transformed or cross-origin frames. Geometry capture does not scroll or activate a page, issue per-ref native commands, or change legacy/default snapshot output. Frames are sampled recursively, not as a cross-frame atomic layout snapshot.\n");
  await fs.appendFile(path.join(vendor, "MODIFICATIONS.txt"), "An exported pure selector guard reuses the unchanged native parseSelector and visitAllSelectorParts functions to reject the aria-ref selector engine, including captured/composite/nested selectors, outside OBU's capture-scoped descriptor. Ordinary CSS attributes, text and XPath string values containing the same characters retain their original parsing semantics.\n");
  await fs.appendFile(path.join(vendor, "MODIFICATIONS.txt"), "With website restrictions enabled, the same recursive native selector parser additionally permits only audited built-in query engines and enter-frame controls; React/Vue object traversal and custom/unknown engines are rejected. Bounded has/hasNot/and/or operands are current-frame relative: their raw selectors receive an additional parser-backed check that rejects actual enter-frame controls, recursively, without rejecting ordinary CSS/text literals. Every nested descriptor, including media selectors and drag destinations, receives the same reference and site-policy checks. Composition and visible filtering retain the original native Locator behavior. The default unrestricted mode retains its existing top-level selector behavior.\n");
  await fs.appendFile(path.join(vendor, "MODIFICATIONS.txt"), "Bounded iframe nodes use the native ARIA collection rendering branch so iframe fallback text and the actual child document share a valid YAML child list; ordinary unbounded renderer output is unchanged.\n");
  await fs.appendFile(path.join(vendor, "MODIFICATIONS.txt"), "An opt-in private client navigation Waiter hook exposes listener readiness and cancellation around the unchanged Page.waitForURL/waitForLoadState APIs. Readiness follows installation of the actual native navigation/load-state listener or native cached-state completion. Cancellation joins the exact Waiter's native failure race, which disposes its listeners and timers, without closing the Page or changing URL matching, lifecycle state, navigation errors, or other observers. A cancelled setup cannot register a late listener. Unhooked native waits retain their original behavior.\n");
  await fs.appendFile(path.join(vendor, "MODIFICATIONS.txt"), "Production Chromium Pages establish an epoch-millisecond diagnostic admission boundary before enabling Runtime. Root frames, OOPIFs and dedicated workers share that Page boundary: older or missing/non-finite timestamp console, exception and Log events are excluded before creating Playwright handles, preventing asynchronously replayed browser history from entering a later owner/turn capture. Events exactly at the boundary are admitted; this is a timestamp fence, not a browser-provided replay discriminator. Public raw CDP notifications and standalone CRX retain their existing semantics, and console history is never cleared. Rejected events' remote objects are deduplicated and released through the original native CRSession using its existing best-effort error-logging path. A private out-of-wire guard checks the exact session and original target identity again after asynchronous admission, immediately before native release; it cannot borrow a successor attachment. This event cleanup is not the durable media-source lease and does not report failed releases as confirmed cleanup. The patch is protected by the pinned source digest and unique native shape checks.\n");
  await fs.appendFile(path.join(vendor, "MODIFICATIONS.txt"), "An internal media-source bridge reuses the native Locator, server Frame selector resolver, ProgressController and polling loop. A fixed utility-world adapter resolves an exact HTML image, video, audio or canvas and reads native currentSrc or canvas dimensions in the same renderer call; a retained node/document handle is checked again and disposed before returning the source snapshot. Custom/main-world selector engines are forbidden for this route. Opt-in frame-owner queries retain the original native selector resolver and content-frame lookup, while renderer calls and exact object releases await actual transport sends rather than context/session cancellation races or fire-and-forget JSHandle.dispose. A private cleanup factory binds the original attachment and child session before each call; only its exact returned object can be released while automation is paused. Failed releases retain the handle for explicit cleanup retry. Active source leases observe only raw Chrome execution-context-destruction/clear, actual tab removal and target_closed events as object-lifetime evidence; local Playwright closure, arbitrary debugger cancellation and child detach do not substitute. A delayed native response keeps its original lease, and the last released object closes that lease and removes idle listeners. The bridge joins actual task and handle-disposal settlement after controller cancellation, without detaching the Page or retrying a selected element. HTTP(S) sources retain the later native GET. Selected same-origin blob and data sources are read in their original frame through native fetch with AbortController; canvas uses native origin-clean PNG encoding. Embedded output has an 8 MiB byte limit and canvas a 16M pixel limit, with bounded native chunks and exact binding cancellation through the private cleanup lease. Byte reads and cleanup retain actual native settlement after cancellation; canvas encoding itself is not abortable. It does not fabricate selectors or claim atomicity between a source snapshot and a later native download GET.\n");
  await fs.appendFile(path.join(vendor, "MODIFICATIONS.txt"), "Locator file upload reuses the private utility task and exact native handle cleanup bridge. A fixed descriptor binds the selected real file input to its original utility context, frame, debugger target and backend node id. The original action deadline covers strict attached locator waiting, and selected inputs are never re-resolved after submission starts. The backend shares physical-node admission with chooser uploads: ordinary files retain native ACK semantics, directories require the original trusted input completion, and unknown native completion retains the node guard. No upstream file setter, pointer input, chooser or visibility/scroll prerequisite is used. This lock covers the two OBU upload APIs, not arbitrary page or raw CDP mutation.\n");
  await fs.appendFile(path.join(vendor, "MODIFICATIONS.txt"), "Production locator clicks, counted clicks and double clicks without force/trial or pre-held input require a current target move receipt before sending buttons. Explicit modifiers use the same private ticket through Keyboard and native keydown/up; every attempt snapshots its modifier baseline before setup and restores it in finally, with expired or revoked restoration handled by attachment cleanup. The private utility interceptor records trusted mouse pointermove readiness with the actual fractional local hit test separately from its original button hit checks; it does not compare native event coordinates against the approximate framePoint. Original frame geometry is checked again before pressing. Only settled pre-press moves may repeat at the existing actionability cadence within the original deadline; these moves can cause hover effects. Root routing and original node/context/ancestor checks are retained. Counted down/up pairs execute sequentially with native acknowledgements and original delays; explicit post-commit hit failures and native errors cannot re-enter locator retry. Later presses recheck the ancestor hit at the original root point and compare its framePoint through the original receipt, along with observed pending frame/ancestor navigation; these non-atomic reads neither retarget nor predict future native messages. Normal navigation after the final up retains upstream completion handling; double click retains its disabled navigation wait. An attachment-scoped input ticket rejects held or unconfirmed input, is invalidated by foreign Input commands, and checks original authority/deadline immediately before native send after asynchronous admission. Its WeakMap metadata stays out of CDP and page parameters. A trusted DOM move has no CDP request ID and cannot authenticate its source or guarantee later press routing. Frame geometry is now captured for each attempt and compared after hover and before every later press. Missing or changed geometry cannot authorize buttons. The frame projection patch below supplies ancestor hit tests; no full input-reliability or parity claim is made.\n");
  await fs.appendFile(path.join(vendor, "MODIFICATIONS.txt"), "A private frame geometry adapter replaces the transformed-frame ancestor shortcut for locator pointer preparation. Native content quads are mapped by actual Chromium renderer-local-root session identity, with fractional CSS content dimensions instead of rounded child innerWidth. Convex finite invertible plane projections compose across renderer boundaries; same-process quads are not transformed twice. Default target quads are clipped against ancestor content and viewport polygons before choosing the root point. Explicit position on a single resolved HTML CSS box now projects its padding-local point through the native padding quad and renderer map, retaining fractional padding dimensions and existing pointer rounding. The original and later hit checks include that element plane in the geometry fingerprint, so hover may trigger pre-press preparation while a changed plane after a committed click stops the sequence. SVG, non-replaced inline, fragmented or unresolved boxes retain their inherited local AABB convention; no padding-plane size is guessed. Every ancestor still performs a utility-world hit test on its exact native frame owner. Frame, session, context, parent, viewport, owner backend node and content geometry are captured under the original action progress; the observations are not an atomic layout snapshot. Temporary owner handles retain Playwright's best-effort disposal semantics, not a durable native release acknowledgement. Browser focus, system mouse routing and public protocol are unchanged.\n");
  await fs.appendFile(path.join(vendor, "MODIFICATIONS.txt"), "Public locator boundingBox and element screenshots project each native border-quad vertex through the actual renderer-local-root map before taking a root-viewport AABB. Layout bounds are not clipped to viewports and retain zero dimensions. The private locator/client/channel/dispatcher path forwards its remaining timeout into a real ProgressController; an exhausted finite locator deadline never becomes the zero-means-unlimited setting. Element screenshots reuse their original progress. A bounds-only snapshot preserves route/context/deadline and known no-layout checks without the pointer path's viewport clipping or same-renderer inverse requirement. Known absent target or owner layout returns null; unknown native errors, changed routes and unsupported renderer-boundary planes fail explicitly instead of returning guessed rectangles. Geometry reads remain sequential, and temporary handles retain upstream best-effort disposal. No public Browser Use wire API or foreground input route changes.\n");
  await fs.appendFile(path.join(vendor, "MODIFICATIONS.txt"), "Ordinary locator dragTo freezes the original source and destination before input. Source preparation uses the original trusted-move receipt and actual frame/element geometry; only pre-press preparation may repeat. Once a down is submitted, explicit failures are terminal. Destination preparation runs native dragenter/dragover before rechecking original geometry and hit targets. Utility-world drop guards check the original node and local ancestor geometry at drop dispatch, including the dragover emitted inside Chromium's drop command; earlier page listeners and concurrent layout remain non-atomic boundaries. Capture-pointer drags retain their source delivery semantics. One private input ticket follows RawMouse and DragManager Input calls under the original progress. Native intercepted HTML drag cleanup explicitly cancels before releasing buttons; cancellation cannot roll back page side effects. Original attachment cleanup resources retain late guard allocations and remove guards only after actual input settlement, using the existing fixed context-bound cancellation/release lease. Failed or unknown cleanup retains the resource barrier. Force/trial and pre-held Playwright modifiers or mouse buttons keep the inherited branch; other tracked held or unconfirmed input is rejected at admission. No public Browser Use wire or operating-system mouse route changes.\n");
  return destination;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== "--output")) throw new Error("Usage: node scripts/build-chrome-extension.mjs [--output <repository dist/.tmp child>]");
  console.log(await buildChromeExtension(args[1]));
}
