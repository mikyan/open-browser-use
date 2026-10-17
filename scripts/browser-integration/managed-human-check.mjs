// Actual managed human handoff acceptance. The task page is controlled only by
// the production SDK and the production viewer. Observer scripting only reads.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium as playwrightChromium } from "playwright";
import { createManagedHumanFixture, readManagedHumanDocument, assertManagedHumanReceipt, humanASCII, humanUnicode } from "./managed-human-check-fixture.mjs";
import { assertManagedViewerTerminal, assertManagedViewerFrames, projectViewerCommand } from "./managed-viewer-check.mjs";
import { connectNormalCDP, managedProcess, runProcess, bound, poll } from "./normal-browser-downloads-support.mjs";
import { listenFixture } from "./fixture-listener.mjs";
import { browserStartupOptions } from "./browser-startup.mjs";
import { waitPrivateDevToolsEndpoint } from "./private-devtools-endpoint.mjs";
import { observedProcessDescendants as descendants } from "./observed-process-descendants.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const redact = text => String(text).replace(/(#ticket=)[A-Za-z0-9_-]+/g, "$1[redacted]");
const serialize = value => JSON.stringify(value, (_key, item) => typeof item === "string" ? redact(item) : item, 2);

export function projectHumanCommand(message) {
  if (!message?.operation?.startsWith("human")) return projectViewerCommand(message);
  assert.ok(Number.isSafeInteger(message.id) && message.id > 0);
  assert.ok(["humanBegin", "humanInput", "humanEnd"].includes(message.operation));
  const allowed = message.operation === "humanBegin" ? ["id", "operation", "tabId"] : message.operation === "humanEnd" ? ["id", "operation", "leaseId"] : ["id", "operation", "leaseId", "generation", "sequence", "input"];
  if (message.operation === "humanBegin" && message.deliveryId !== undefined) {
    assert.ok(typeof message.deliveryId === "string" && message.deliveryId.length > 0 && message.deliveryId.length <= 128 && !/[\x00-\x1f\x7f]/.test(message.deliveryId));
    allowed.push("deliveryId");
  }
  assert.deepEqual(Object.keys(message).sort(), allowed.sort());
  if (message.operation === "humanBegin") { assert.ok(Number.isSafeInteger(message.tabId) && message.tabId > 0); return { ...message }; }
  assert.ok(typeof message.leaseId === "string" && message.leaseId.length > 0 && message.leaseId.length <= 256);
  if (message.operation === "humanEnd") return { ...message };
  assert.ok(Number.isSafeInteger(message.generation) && message.generation > 0);
  assert.ok(Number.isSafeInteger(message.sequence) && message.sequence > 0);
  const input = message.input; assert.ok(input && typeof input === "object" && !Array.isArray(input));
  const fields = { pointer: ["type", "action", "x", "y", "button", "modifiers"], wheel: ["type", "x", "y", "deltaX", "deltaY", "modifiers"], key: ["type", "action", "key", "code", "windowsVirtualKeyCode", "modifiers"], text: ["type", "text"] }[input.type];
  assert.ok(fields); assert.ok(Object.keys(input).every(key => fields.includes(key)));
  if (input.type === "pointer") { assert.ok(["move", "down", "up"].includes(input.action)); assert.ok(input.button === undefined || ["left", "middle", "right"].includes(input.button)); }
  if (["pointer", "wheel"].includes(input.type)) for (const key of ["x", "y"]) assert.ok(Number.isFinite(input[key]) && input[key] >= 0);
  if (input.type === "wheel") for (const key of ["deltaX", "deltaY"]) assert.ok(Number.isFinite(input[key]));
  if (input.type === "key") { assert.ok(["down", "up"].includes(input.action)); assert.equal(typeof input.key, "string"); assert.equal(typeof input.code, "string"); assert.ok(Number.isInteger(input.windowsVirtualKeyCode)); }
  if (input.modifiers !== undefined) assert.ok(Number.isInteger(input.modifiers) && input.modifiers >= 0 && input.modifiers <= 15);
  if (input.type === "text") { assert.ok(typeof input.text === "string" && Buffer.byteLength(input.text) <= 8192); return { ...message, input: { type: "text", textBytes: Buffer.byteLength(input.text), textSHA256: hash(input.text) } }; }
  return structuredClone(message);
}

export function assertHumanInputReceipt(request, reply) {
  assert.equal(reply.type, "response"); assert.equal(reply.id, request.id);
  assert.equal(reply.error, undefined, serialize(reply.error));
  assert.deepEqual(reply.result?.inputReceipt, { leaseId: request.leaseId, generation: request.generation, sequence: request.sequence, acknowledged: true }, "The exact original native input acknowledgement is required");
}

export function captureTaskAuthority(client, tabId) {
  assert.ok(Number.isSafeInteger(tabId) && tabId > 0);
  assert.ok(typeof client.sessionId === "string" && client.sessionId.length > 0);
  assert.ok(typeof client.turnId === "string" && client.turnId.length > 0);
  assert.ok(Number.isSafeInteger(client.controlEpoch) && client.controlEpoch > 0);
  return Object.freeze({ tabId, sessionId: client.sessionId, turnId: client.turnId, epoch: client.controlEpoch });
}

export function requestOriginalSnapshot(client, original) {
  // Ordinary Tab/Locator wrappers use the client's current scope. This public
  // request deliberately retains the original authority across explicit turns.
  return client.request("browserAction", { action: "snapshot", tabId: original.tabId, args: {}, timeoutMs: 1500,
    session_id: original.sessionId, turn_id: original.turnId, control_epoch: original.epoch }, { timeoutMs: 1500 });
}

export function visibleHumanViewerPoint(target, viewport, imageBox, imagePixels) {
  for (const [name, rect] of [["target", target], ["imageBox", imageBox]]) {
    assert.ok(rect && ["x", "y", "width", "height"].every(key => Number.isFinite(rect[key])) && rect.width > 0 && rect.height > 0, `Invalid ${name} bounds`);
  }
  for (const [name, size] of [["viewport", viewport], ["imagePixels", imagePixels]]) {
    assert.ok(size && ["width", "height"].every(key => Number.isFinite(size[key]) && size[key] > 0), `Invalid ${name} dimensions`);
  }
  const left = Math.max(0, target.x), top = Math.max(0, target.y);
  const right = Math.min(viewport.width, target.x + target.width), bottom = Math.min(viewport.height, target.y + target.height);
  assert.ok(right > left && bottom > top, "Original target has no visible intersection with the input viewport");
  const visible = { x: left, y: top, width: right - left, height: bottom - top };
  const nativePoint = { x: left + visible.width / 2, y: top + visible.height / 2 };
  // Match object-fit:contain using the actual decoded image, then map the
  // original full CSS surface. Scrollbar pixels are not guessed or removed.
  const scale = Math.min(imageBox.width / imagePixels.width, imageBox.height / imagePixels.height);
  const width = imagePixels.width * scale, height = imagePixels.height * scale;
  const imageContentBox = { x: imageBox.x + (imageBox.width - width) / 2, y: imageBox.y + (imageBox.height - height) / 2, width, height };
  const viewerPoint = { x: imageContentBox.x + nativePoint.x * width / viewport.width, y: imageContentBox.y + nativePoint.y * height / viewport.height };
  return { target: { ...target }, viewport: { ...viewport }, imageBox: { ...imageBox }, imagePixels: { ...imagePixels }, visible, nativePoint, imageContentBox, viewerPoint };
}

export function installManagedHumanObserver(chrome, target = globalThis) {
  if (target.__managedHumanAcceptance) throw new Error("Original observer already installed");
  const events = []; let overflow = false, active = true;
  const onEvent = (source, method, params) => {
    if (!["Page.screencastFrame", "Page.frameNavigated", "Page.frameDetached", "Runtime.executionContextsCleared"].includes(method)) return;
    if (events.length >= 1024) { overflow = true; return; }
    events.push({ at: Date.now(), method, source: { ...source }, ...(method === "Page.screencastFrame" ? { nativeSessionId: params.sessionId } : {}) });
  };
  const onDetach = (source, reason) => { if (events.length >= 1024) overflow = true; else events.push({ at: Date.now(), method: "debugger.onDetach", source: { ...source }, reason }); };
  chrome.debugger.onEvent.addListener(onEvent); chrome.debugger.onDetach.addListener(onDetach);
  const snapshot = () => ({ events: structuredClone(events), overflow, listenerPresent: active });
  Object.defineProperty(target, "__managedHumanAcceptance", { configurable: true, value: Object.freeze({ snapshot, stop() { chrome.debugger.onEvent.removeListener(onEvent); chrome.debugger.onDetach.removeListener(onDetach); active = false; return snapshot(); } }) });
  return { listenerPresent: true, readOnly: true };
}

async function treeHashes(root) {
  const entries = await fs.readdir(root, { recursive: true, withFileTypes: true });
  const files = entries.filter(entry => entry.isFile()).map(entry => path.join(entry.parentPath, entry.name)).sort();
  return Object.fromEntries(await Promise.all(files.map(async file => [path.relative(root, file).replaceAll("\\", "/"), hash(await fs.readFile(file))])));
}

export async function runManagedHumanCheck() {
  assert.equal(process.platform, "win32");
  const executable = process.env.OBU_TEST_HOST_BINARY, chromium = process.env.OBU_TEST_CHROMIUM_BINARY, extension = process.env.OBU_TEST_EXTENSION_DIR;
  assert.ok(executable && chromium && extension, "Set explicit OBU_TEST_HOST_BINARY, OBU_TEST_CHROMIUM_BINARY, OBU_TEST_EXTENSION_DIR");
  await Promise.all([executable, chromium, extension].map(file => fs.access(file)));
  await fs.mkdir(path.join(repo, ".tmp/browser-integration"), { recursive: true });
  const runDir = await fs.mkdtemp(path.join(repo, ".tmp/browser-integration/managed-human-"));
  const root = path.join(runDir, "owned-root"), name = "human-acceptance", viewerProfile = path.join(runDir, "viewer-profile");
  const report = { runDir, startedAt: Date.now(), commands: [], steps: [], cleanup: {}, frames: [], viewerCommands: [], viewerMessages: [], viewerActions: [], viewerDecodedFrames: [], viewerErrors: [], denied: [],
    scope: "Production managed human UI, one original synthetic form and one final SDK POST; separate nonbusiness explicit-release page; original viewer WebSocket disconnect with held inputs; no real credentials, OS input, input retry, or extra task page CDP attachment" };
  const save = () => fs.writeFile(path.join(runDir, "results.json"), serialize(report));
  const registry = new Set(), frameWrites = [], screenshots = [];
  let launcher, info, worker, taskBrowser, viewerProcess, viewerBrowser, viewerContext, page, captureError, state, stopped = false;
  let oldTaskTab, oldTaskAuthority, freshTaskTab, original, normalLease, businessLease;
  const fixture = createManagedHumanFixture();
  const server = createServer((request, response) => { if (!fixture.handle(request, response)) { request.resume(); response.writeHead(404); response.end("NOT_FOUND"); } });
  const launch = (program, args, options = {}) => { const record = {}; report.commands.push(record); return managedProcess(program, args, { cwd: repo, registry, record, maximumBytes: 2 * 1024 * 1024, ...options }); };
  async function command(args, expected = 0) {
    const child = launch(executable, args, { timeoutMs: args[0] === "managed" && args[1] === "stop" ? 55000 : 45000 });
    const result = await child.completed; assert.equal(result.code, expected, redact(result.stderr)); return result;
  }
  async function processTable() {
    const record = {}; await runProcess("powershell.exe", ["-NoProfile", "-Command", "@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,ExecutablePath,@{n='CreationDate';e={$_.CreationDate.ToUniversalTime().ToString('o')}}) | ConvertTo-Json -Compress"], { record, registry, timeoutMs: 15000 });
    return JSON.parse(record.stdout);
  }
  const checkCapture = () => { if (captureError) throw captureError; };
  const wait = (read, label, timeoutMs = 15000) => poll(async () => { checkCapture(); return read(); }, { timeoutMs, intervalMs: 40, label });
  async function step(label, operation) {
    const record = { name: label, startedAt: Date.now() }; report.steps.push(record); console.log("STEP", label);
    try { await operation(); checkCapture(); record.passed = true; }
    catch (error) { record.passed = false; record.error = error.stack; report.firstFailure ??= { step: label, at: Date.now(), error: error.stack }; throw error; }
    finally { record.endedAt = Date.now(); await save(); }
  }
  async function screenshot(file) { const png = await page.screenshot({ path: path.join(runDir, file) }); const record = { file, at: Date.now(), sha256: hash(png), bytes: png.length }; screenshots.push(record); return record; }
  const endpointFor = (profile, owner) => waitPrivateDevToolsEndpoint(profile, { assertAlive() { if (owner.record.exitedAt !== undefined || owner.record.closedAt !== undefined || owner.record.spawnError !== undefined) throw new Error("Original browser owner ended before endpoint"); } });
  const replyFor = (id, timeoutMs = 35000) => wait(() => report.viewerMessages.find(value => value.type === "response" && value.id === id && value.connection === connection), `original response ${id}`, timeoutMs);
  let connection = 0;
  async function uiAction(selector, operation, tabId) {
    const before = report.viewerCommands.length, action = { selector, operation, tabId, connection, startedAt: Date.now() }; report.viewerActions.push(action);
    if (operation === "select") await page.locator(selector).selectOption(String(tabId)); else await page.locator(selector).click();
    const request = await wait(() => report.viewerCommands.slice(before).find(item => item.operation === operation && (operation !== "select" || item.tabId === tabId)), `original DOM ${operation}`);
    action.requestId = request.id; const reply = await replyFor(request.id, operation === "stop" ? 55000 : 35000); action.completedAt = Date.now();
    assert.equal(report.viewerCommands.slice(before).filter(item => item.operation === operation && (operation !== "select" || item.tabId === tabId)).length, 1);
    assert.equal(reply.error, undefined, serialize(reply.error)); return reply.result;
  }
  async function inputAction(label, operation) {
    const before = report.viewerCommands.length, action = { label, connection, startedAt: Date.now(), kind: "real viewer input" }; report.viewerActions.push(action);
    await operation();
    await wait(() => report.viewerCommands.length > before, `outgoing native input ${label}`);
    // Serialize the fixture's UI gestures. Finite command replies are required;
    // a caller-side timeout must never be relabelled a native acknowledgement.
    await wait(async () => await page.locator("#human-input").getAttribute("data-pending") === "0", `all original UI input settled: ${label}`);
    const commands = report.viewerCommands.slice(before); assert.ok(commands.length); assert.ok(commands.every(item => item.operation === "humanInput"));
    action.requestIds = commands.map(item => item.id);
    for (const request of commands) assertHumanInputReceipt(request, await replyFor(request.id));
    const acknowledged = Number(await page.locator("#human-input").getAttribute("data-acknowledged-sequence"));
    assert.equal(acknowledged, commands.at(-1).sequence, "UI must have accepted the exact last native receipt before this gesture completes");
    action.acknowledgedSequence = acknowledged;
    action.completedAt = Date.now(); return commands;
  }
  async function denied(label, operation, pattern) { const record = { label, at: Date.now() }; report.denied.push(record); try { await operation(); } catch (error) { record.error = error.stack; assert.match(error.message, pattern); record.verified = true; return; } throw new Error(`${label} unexpectedly succeeded`); }
  async function deniedHuman(lease, label) {
    const id = 1000000 + report.denied.length;
    const lastSequence = Math.max(0, ...report.viewerCommands.filter(value => value.operation === "humanInput" && value.leaseId === lease.leaseId).map(value => value.sequence));
    const request = { id, operation: "humanInput", leaseId: lease.leaseId, generation: lease.generation, sequence: lastSequence + 1, input: { type: "text", text: "MUST_NOT_BE_DELIVERED" } };
    await page.evaluate(message => globalThis.__managedHumanTestSocket.send(JSON.stringify(message)), request);
    const response = await replyFor(id);
    assert.ok(response.error, "Retired human capability must reject"); assert.equal(response.error.code, "HUMAN_STALE");
    report.denied.push({ label, at: Date.now(), request: projectHumanCommand(request), response, verified: true });
    // The probe consumes a high request ID on this exact connection. Do not
    // reuse it for the UI's independent counter or alter production numbering.
    // CLI view waits for original cleanup; it is issued once, without polling.
    const probePage = page, probeConnection = connection;
    await probePage.evaluate(() => globalThis.__managedHumanTestSocket.close());
    const fresh = JSON.parse((await command(["managed", "view", "--root", root, "--name", name])).stdout);
    assert.equal(new URL(fresh.viewerURL).origin, report.viewerOrigin);
    await openViewer(fresh.viewerURL); await probePage.close();
    assert.ok(connection > probeConnection);
    assert.equal(state.status.state, "paused"); assert.equal(state.human, null);
    assert.deepEqual(state.humanCleanup, { leaseId: lease.leaseId, cleanupConfirmed: true });
  }
  const documentRead = tabId => worker.evaluate(`chrome.scripting.executeScript({target:{tabId:${tabId}},func:${readManagedHumanDocument.toString()}}).then(results=>{if(results.length!==1)throw new Error('ambiguous root read');return {documentId:results[0].documentId,frameId:results[0].frameId,...results[0].result}})`);
  const nativeMap = tabId => worker.evaluate(`chrome.debugger.getTargets().then(items=>items.filter(item=>item.type==='page'&&item.tabId===${tabId}).map(item=>({id:item.id,tabId:item.tabId,type:item.type,attached:item.attached,url:item.url})))`);
  const observerSnapshot = () => worker.evaluate("__managedHumanAcceptance.snapshot()");
  const posts = () => fixture.stats().requests.filter(item => item.method === "POST");
  async function decodeHumanFrame(lease) {
    const frame = await wait(() => report.frames.findLast(item => item.controlMode === "human" && item.humanLeaseId === lease.leaseId && item.tabId === lease.tabId), "original human native frame");
    const decoded = await wait(async () => {
      const value = await page.locator("#frame").evaluate(element => ({ hidden: element.hidden, complete: element.complete, width: element.naturalWidth, height: element.naturalHeight, ...element.dataset }));
      const ready = await page.locator("#human-input").getAttribute("data-enabled");
      return ready === "true" && state?.human?.leaseId === lease.leaseId && state.human.generation === frame.generation && state.human.viewport?.width > 0 && state.human.viewport?.height > 0 &&
        !value.hidden && value.complete && value.width > 0 && value.height > 0 && value.controlMode === "human" && value.humanLeaseId === lease.leaseId && Number(value.generation) === frame.generation && Number(value.frameSequence) >= frame.sequence && value;
    }, "viewer decoded original human frame");
    report.viewerDecodedFrames.push({ at: Date.now(), frame: { streamId: frame.streamId, sequence: frame.sequence, humanLeaseId: frame.humanLeaseId, generation: frame.generation }, decoded });
    return frame;
  }
  async function viewerPoint(box) {
    const [image, decoded] = await Promise.all([
      page.locator("#frame").boundingBox(),
      page.locator("#frame").evaluate(element => ({ hidden: element.hidden, complete: element.complete, width: element.naturalWidth, height: element.naturalHeight, ...element.dataset }))
    ]);
    assert.ok(!decoded.hidden && decoded.complete && state.human?.viewport);
    assert.equal(decoded.controlMode, "human"); assert.equal(decoded.humanLeaseId, state.human.leaseId); assert.equal(Number(decoded.generation), state.human.generation);
    const proof = visibleHumanViewerPoint(box, state.human.viewport, image, { width: decoded.width, height: decoded.height });
    (report.pointerTargets ??= []).push({ at: Date.now(), connection, leaseId: state.human.leaseId, generation: state.human.generation, streamId: decoded.streamId, frameSequence: Number(decoded.frameSequence), ...proof });
    return proof.viewerPoint;
  }
  async function openViewer(url) {
    connection++; const originalConnection = connection; state = undefined;
    // CDP's default context has no managed native viewport: emulating a larger
    // DOM there can leave wheel coordinates outside the original small window.
    // All viewer pages use the same explicitly sized, private test context.
    page = await viewerContext.newPage();
    const geometrySession = await viewerContext.newCDPSession(page);
    try {
      const nativeWindow = await bound(geometrySession.send("Browser.getWindowForTarget"), 5000, "original viewer native window");
      const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
      (report.viewerWindows ??= []).push({ at: Date.now(), connection: originalConnection, nativeWindow, viewport });
      assert.deepEqual(viewport, { width: 1280, height: 1000 });
      assert.ok(nativeWindow.bounds.width >= viewport.width && nativeWindow.bounds.height >= viewport.height, "Original viewer window must contain its emulated viewport");
    } finally { await geometrySession.detach(); }
    // Test-only reference to the original native socket: no send/receive wrapper,
    // no change to production input or ACK ordering. Used only for a rejected
    // old capability and a deliberate transport close while inputs are held.
    await page.addInitScript(() => {
      const Native = WebSocket;
      globalThis.WebSocket = new Proxy(Native, { construct(target, args) { const socket = Reflect.construct(target, args); Object.defineProperty(globalThis, "__managedHumanTestSocket", { configurable: true, value: socket }); return socket; } });
    });
    page.on("pageerror", error => { report.viewerErrors.push({ at: Date.now(), connection: originalConnection, error: error.stack }); captureError ??= error; });
    page.on("websocket", socket => {
      try { assert.equal(new URL(socket.url()).origin.replace("ws:", "http:"), new URL(url).origin); } catch (error) { captureError ??= error; return; }
      socket.on("close", () => report.viewerMessages.push({ type: "socketClosed", at: Date.now(), connection: originalConnection }));
      socket.on("framesent", event => { try { const raw = JSON.parse(String(event.payload)), projected = projectHumanCommand(raw); if (!projected) return; if (report.viewerCommands.length >= 2048) throw new Error("Viewer command capacity"); report.viewerCommands.push({ ...projected, at: Date.now(), connection: originalConnection }); } catch (error) { captureError ??= error; } });
      socket.on("framereceived", event => {
        try {
          const message = JSON.parse(String(event.payload)), at = Date.now();
          if (report.viewerMessages.length >= 4096) throw new Error("Viewer event capacity");
          if (message.type === "frame") {
            assert.equal(message.mimeType, "image/png"); assert.ok(typeof message.data === "string" && message.data.length <= 4 * Math.ceil(4 * 1024 * 1024 / 3));
            const png = Buffer.from(message.data, "base64"); assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]); assert.ok(png.length <= 4 * 1024 * 1024 && png.length > 24);
            const frame = { ...message, data: undefined, at, connection: originalConnection, bytes: png.length, sha256: hash(png), width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
            if (report.frames.length < 96) { frame.file = `native-frame-${String(report.frames.length).padStart(4, "0")}.png`; const write = fs.writeFile(path.join(runDir, frame.file), png); frameWrites.push(write); write.catch(error => { captureError ??= error; }); }
            if (report.frames.length >= 1024) throw new Error("Frame observation capacity"); report.frames.push(frame);
            report.viewerMessages.push({ type: "frame", at, connection: originalConnection, tabId: frame.tabId, streamId: frame.streamId, sequence: frame.sequence, controlMode: frame.controlMode, humanLeaseId: frame.humanLeaseId, generation: frame.generation, sha256: frame.sha256 });
          } else {
            report.viewerMessages.push({ ...message, at, connection: originalConnection });
            if (originalConnection === connection && (message.type === "state" || message.type === "response" && message.result?.status)) {
              const next = message.type === "state" ? message : message.result;
              if (!state || next.eventSequence >= state.eventSequence && next.status.revision >= state.status.revision) state = next;
            }
          }
        } catch (error) { captureError ??= error; }
      });
    });
    await page.goto(url, { waitUntil: "domcontentloaded" }); await wait(async () => await page.locator("#connection").textContent() === "已连接", "viewer authenticated");
    assert.equal(new URL(page.url()).hash, ""); await uiAction("#refresh", "status");
  }

  try {
    report.source = { executable: hash(await fs.readFile(executable)), browser: hash(await fs.readFile(chromium)), extension: await treeHashes(extension), sdk: await treeHashes(path.join(repo, "packages/open-browser-use-js/dist")) };
    const snapshot = path.join(runDir, "source-snapshot");
    const builder = await fs.readFile(path.join(repo, "scripts/build-chrome-extension.mjs"), "utf8");
    const declaration = builder.match(/const productionFiles\s*=\s*(\[[\s\S]*?\]);/); assert.ok(declaration, "The frozen builder must declare its exact production inputs");
    const productionFiles = JSON.parse(declaration[1]); assert.equal(new Set(productionFiles).size, productionFiles.length); assert.ok(productionFiles.includes("managed-human-control.js"));
    const productionInputs = {};
    for (const name of productionFiles) {
      const bytes = await fs.readFile(path.join(repo, "apps/chrome-extension", name));
      assert.equal(report.source.extension[name], hash(bytes), `Provided extension does not contain the exact current production source: ${name}`);
      productionInputs[name] = hash(bytes);
    }
    report.source.productionExtensionInputs = productionInputs;
    const sourceNames = (await fs.readdir(path.join(repo, "apps/chrome-extension"))).filter(file => /\.(js|json|html|css)$/.test(file) && !file.includes(".test."));
    const extensionSources = [...new Set([...sourceNames, ...productionFiles])].map(file => `apps/chrome-extension/${file}`);
    const builderSources = (await fs.readdir(path.join(repo, "scripts"))).filter(file => /^patch-.*\.mjs$/.test(file) && !file.includes(".test.")).map(file => `scripts/${file}`);
    const integrationSources = (await fs.readdir(path.join(repo, "scripts/browser-integration"))).filter(file => file.endsWith(".mjs") || ["package.json", "package-lock.json"].includes(file)).map(file => `scripts/browser-integration/${file}`);
    for (const source of ["cmd/open-browser-use", "internal", "packages/open-browser-use-go", "go.mod", "go.sum", "scripts/build-chrome-extension.mjs", ...builderSources, ...extensionSources, ...integrationSources]) {
      const destination = path.join(snapshot, source); await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.cp(path.join(repo, source), destination, { recursive: true });
    }
    report.source.snapshot = await treeHashes(snapshot);
    await fs.cp(extension, path.join(runDir, "extension-input"), { recursive: true });
    await fs.cp(path.join(repo, "packages/open-browser-use-js/dist"), path.join(runDir, "sdk-input"), { recursive: true });
    const { connectOpenBrowserUse } = await import(pathToFileURL(path.join(runDir, "sdk-input/index.js")));
    await listenFixture(server); const fixtureURL = `http://127.0.0.1:${server.address().port}`;

    await step("production-run-and-original-worker-observer", async () => {
      launcher = launch(executable, ["managed", "run", "--root", root, "--name", name, "--browser-path", chromium, "--extension-dir", extension, "--startup-timeout", "30s"]);
      const ready = await wait(() => {
        if (launcher.record.closedAt) throw new Error(`Managed launcher exited ${launcher.record.code}: ${redact(launcher.record.stderr)}`);
        const text = launcher.record.stdout.trim(); return text.endsWith("}") ? JSON.parse(text) : null;
      }, "production managed ready", 40000);
      assert.equal(ready.state, "ready"); info = ready.info; report.info = info;
      const relative = path.relative(root, info.runDir); assert.ok(relative && !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
      assert.equal(info.name, name); assert.ok(info.runId && info.browserPID > 0 && info.nativePID > 0);
      report.originalProcesses = descendants(await processTable(), info.browserPID); assert.ok(report.originalProcesses.some(item => item.ProcessId === info.nativePID));
      const status = JSON.parse((await command(["managed", "status", "--root", root, "--name", name])).stdout); assert.deepEqual(status.info, info);
      const startup = browserStartupOptions([`--user-data-dir=${viewerProfile}`, "--headless=new", "--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "about:blank"], process.env.OBU_TEST_FIELD_TRIAL_CONFIG);
      report.viewerStartup = startup; viewerProcess = launch(chromium, startup.args);
      viewerBrowser = await playwrightChromium.connectOverCDP((await endpointFor(viewerProfile, viewerProcess)).url);
      viewerContext = await viewerBrowser.newContext({ viewport: { width: 1280, height: 1000 } });
      report.viewerProcesses = descendants(await processTable(), viewerProcess.record.pid);
      assert.ok(!report.viewerProcesses.some(item => item.ProcessId === info.browserPID));
      const fresh = JSON.parse((await command(["managed", "view", "--root", root, "--name", name])).stdout);
      const viewerURL = new URL(fresh.viewerURL); assert.equal(viewerURL.hostname, "127.0.0.1"); assert.equal(viewerURL.origin, new URL(ready.viewerURL).origin);
      report.viewerOrigin = viewerURL.origin; report.viewerTicketSHA256 = hash(viewerURL.hash);
      await openViewer(viewerURL.href); assert.equal(state.status.state, "running"); report.viewerInitial = await screenshot("viewer-initial.png");
      const endpoint = await endpointFor(info.profileDir, launcher);
      const targets = await (await fetch(`http://127.0.0.1:${endpoint.port}/json/list`)).json();
      const workers = targets.filter(value => value.type === "service_worker" && value.url === `chrome-extension://${info.extensionId}/background.js`); assert.equal(workers.length, 1);
      report.observerConnection = {}; worker = await connectNormalCDP(workers[0].webSocketDebuggerUrl, { record: report.observerConnection, handshakeTimeoutMs: 10000, authorizationRequired: false });
      report.observer = await worker.evaluate(`(${installManagedHumanObserver.toString()})(chrome,globalThis)`);
      taskBrowser = await connectOpenBrowserUse({ socketPath: info.socketPath, sessionId: "managed-human-acceptance", turnId: "independent-release-check", timeoutMs: 10000 });
    });

    await step("independent-nonbusiness-explicit-human-release", async () => {
      const tab = await taskBrowser.newTab({ url: fixtureURL + "/human-control", backgroundWindow: true }); await tab.domSnapshot({ timeoutMs: 10000 });
      const originalAuthority = captureTaskAuthority(taskBrowser.client, tab.id);
      report.explicitRelease = { tabId: tab.id, originalAuthority, beforeTargets: await nativeMap(tab.id) }; assert.equal(report.explicitRelease.beforeTargets.length, 1);
      await uiAction("#refresh", "status"); await uiAction("#tabs", "select", tab.id);
      const begun = await uiAction("#human-begin", "humanBegin"); assert.equal(begun.human.state, "active"); assert.equal(begun.status.state, "paused");
      normalLease = begun.human; report.explicitRelease.begin = begun;
      report.explicitRelease.frame = await decodeHumanFrame(normalLease);
      normalLease = { ...state.human };
      const ended = await uiAction("#human-end", "humanEnd");
      assert.equal(ended.human, null); assert.deepEqual(ended.humanCleanup, { leaseId: normalLease.leaseId, cleanupConfirmed: true });
      assert.equal(ended.status.state, "paused"); assert.equal(ended.status.cleanupComplete, true);
      report.explicitRelease.end = ended; report.explicitRelease.afterTargets = await nativeMap(tab.id);
      assert.equal(report.explicitRelease.afterTargets[0].attached, false);
      await deniedHuman(normalLease, "ended human lease cannot send input"); assert.equal(posts().length, 0);
      report.explicitRelease.resume = await uiAction("#control", "resume"); assert.equal(report.explicitRelease.resume.status.state, "running");
      await denied("nonbusiness original request before explicit new turn", () => tab.domSnapshot({ timeoutMs: 1500 }), /OBU_STALE_CONTROL_EPOCH/);
      report.originalTurn = await taskBrowser.client.beginTurn("original-unsaved-form");
      await denied("nonbusiness original authority after explicit new turn", () => requestOriginalSnapshot(taskBrowser.client, originalAuthority), /OBU_STALE_CONTROL_EPOCH/);
    });

    await step("original-agent-document-and-unsubmitted-draft", async () => {
      oldTaskTab = await taskBrowser.newTab({ url: fixtureURL + "/human-form", backgroundWindow: true });
      await oldTaskTab.getByLabel("Original draft", { exact: true }).fill(fixture.draft, { timeoutMs: 10000 });
      oldTaskAuthority = captureTaskAuthority(taskBrowser.client, oldTaskTab.id);
      original = await documentRead(oldTaskTab.id); assert.equal(original.draft, fixture.draft);
      assert.ok(original.documentId); assert.equal(original.frameId, 0); assert.equal(original.state.submits, 0); assert.deepEqual(original.state.clicks, []);
      const targets = await nativeMap(oldTaskTab.id); assert.equal(targets.length, 1);
      report.business = { tabId: oldTaskTab.id, original, originalAuthority: oldTaskAuthority, originalTarget: targets[0], originalFrames: await worker.evaluate(`chrome.webNavigation.getAllFrames({tabId:${oldTaskTab.id}})`) };
      await uiAction("#refresh", "status"); await uiAction("#tabs", "select", oldTaskTab.id);
      assert.equal(posts().length, 0); report.agentDraft = await screenshot("viewer-agent-draft.png");
    });

    await step("same-document-real-human-input-and-held-input-disconnect", async () => {
      const eventStart = (await observerSnapshot()).events.length;
      const begun = await uiAction("#human-begin", "humanBegin"); assert.equal(begun.status.state, "paused"); assert.equal(begun.human.state, "active");
      businessLease = begun.human; report.business.humanBegin = begun;
      report.business.firstHumanFrame = await decodeHumanFrame(businessLease);
      businessLease = { ...state.human };
      assert.equal(state.human.leaseId, businessLease.leaseId); assert.ok(state.human.viewport);
      const transferred = await documentRead(oldTaskTab.id); assert.equal(transferred.documentId, original.documentId); assert.equal(transferred.state.documentToken, original.state.documentToken); assert.equal(transferred.draft, fixture.draft);
      await denied("task input during human lease", () => oldTaskTab.mouse.move(2, 2, { timeoutMs: 1500 }), /OBU_AUTOMATION_PAUSED/);
      const draftPoint = await viewerPoint(transferred.boxes.draft);
      await inputAction("click original draft through native frame", () => page.mouse.click(draftPoint.x, draftPoint.y));
      await inputAction("move caret to draft end", () => page.keyboard.press("End"));
      const shiftedIndex = humanASCII.indexOf("A"); assert.ok(shiftedIndex > 0);
      await inputAction("type synthetic ASCII prefix through viewer", () => page.keyboard.type(humanASCII.slice(0, shiftedIndex)));
      const shiftStart = (await documentRead(oldTaskTab.id)).state.events.length;
      await inputAction("hold real Shift for uppercase text", () => page.keyboard.down("Shift"));
      await inputAction("type uppercase A with real Shift held", () => page.keyboard.press("KeyA"));
      await inputAction("release real Shift after uppercase text", () => page.keyboard.up("Shift"));
      const shiftEvents = (await documentRead(oldTaskTab.id)).state.events.slice(shiftStart);
      const shiftDown = shiftEvents.findIndex(event => event.type === "keydown" && event.code === "ShiftLeft" && event.trusted);
      const uppercase = shiftEvents.findIndex(event => event.type === "input" && event.data === "A" && event.trusted);
      const shiftUp = shiftEvents.findIndex(event => event.type === "keyup" && event.code === "ShiftLeft" && event.trusted);
      assert.ok(shiftDown >= 0 && uppercase > shiftDown && shiftUp > uppercase, "Original renderer must receive Shift down, committed A, then actual Shift release");
      report.business.shiftedText = { events: shiftEvents, originalDocumentId: original.documentId };
      await inputAction("type remaining synthetic ASCII through viewer", () => page.keyboard.type(humanASCII.slice(shiftedIndex + 1)));
      await inputAction("insert synthetic Unicode through viewer", () => page.keyboard.insertText(humanUnicode));
      await wait(async () => (await documentRead(oldTaskTab.id)).draft === fixture.expectedDraft, "original unsaved field extended by human");
      const buttonPoint = await viewerPoint((await documentRead(oldTaskTab.id)).boxes["human-button"]);
      await inputAction("human confirmation pointer click", () => page.mouse.click(buttonPoint.x, buttonPoint.y));
      await wait(async () => (await documentRead(oldTaskTab.id)).state.clicks.length === 1, "one original human confirmation");
      await inputAction("scroll original document", () => page.mouse.wheel(0, 600));
      await wait(async () => (await documentRead(oldTaskTab.id)).state.maximumScrollY > 300, "original document scroll");
      await inputAction("return original document to held-input target", () => page.mouse.wheel(0, -600));
      await wait(async () => (await documentRead(oldTaskTab.id)).viewport.scrollY === 0, "original document returned to top");
      await decodeHumanFrame(businessLease);
      report.business.beforeHeld = await documentRead(oldTaskTab.id); assert.equal(report.business.beforeHeld.documentId, original.documentId); assert.equal(report.business.beforeHeld.draft, fixture.expectedDraft);
      assert.equal(report.business.beforeHeld.state.clicks.length, 1); assert.equal(report.business.beforeHeld.state.clicks[0].trusted, true);
      const holdPoint = await viewerPoint(report.business.beforeHeld.boxes.hold);
      await inputAction("focus original held-input target", () => page.mouse.click(holdPoint.x, holdPoint.y));
      await inputAction("hold Shift on original document", () => page.keyboard.down("Shift"));
      await inputAction("hold left mouse on original document", () => page.mouse.down({ button: "left" }));
      const held = await documentRead(oldTaskTab.id); assert.deepEqual(held.state.heldKeys, ["ShiftLeft"]); assert.deepEqual(held.state.heldButtons, [0]);
      report.business.held = held; report.business.heldAt = Date.now();
      businessLease = { ...state.human, lastInputSequence: Math.max(...report.viewerCommands.filter(value => value.operation === "humanInput" && value.leaseId === businessLease.leaseId).map(value => value.sequence)) };
      report.business.lastHumanLease = businessLease; report.business.humanScreenshot = await screenshot("viewer-human-edited.png");
      const closeAt = Date.now(), commandCount = report.viewerCommands.length;
      await page.evaluate(() => globalThis.__managedHumanTestSocket.close(1000, "synthetic held-input disconnect"));
      await wait(() => report.viewerMessages.find(value => value.type === "socketClosed" && value.connection === connection && value.at >= closeAt), "original viewer socket actually closed");
      report.business.releasedDocument = await wait(async () => { const value = await documentRead(oldTaskTab.id); return value.state.heldKeys.length === 0 && value.state.heldButtons.length === 0 && value; }, "actual original native key and button release", 35000);
      assert.equal(report.business.releasedDocument.documentId, original.documentId); assert.equal(report.business.releasedDocument.draft, fixture.expectedDraft);
      const releaseEvents = report.business.releasedDocument.state.events.slice(held.state.events.length);
      assert.ok(releaseEvents.some(value => value.type === "keyup" && value.code === "ShiftLeft" && value.trusted));
      assert.ok(releaseEvents.some(value => value.type === "mouseup" && value.button === 0 && value.trusted));
      assert.equal(report.viewerCommands.slice(commandCount).filter(value => ["humanInput", "humanEnd", "resume"].includes(value.operation)).length, 0, "Transport disconnect must not be replaced with UI keyup, End, or Resume");
      report.business.disconnected = { at: closeAt, connection, commandCount, actualReleaseObservedAt: Date.now(), releaseEvents };
      const observed = await observerSnapshot(); assert.equal(observed.overflow, false);
      const frameEvents = observed.events.slice(eventStart).filter(value => value.method === "Page.screencastFrame"); assert.ok(frameEvents.length > 0);
      for (const event of frameEvents) {
        assert.equal(event.source.sessionId, undefined);
        if (event.source.targetId !== undefined) assert.equal(event.source.targetId, report.business.originalTarget.id);
        else assert.equal(event.source.tabId, oldTaskTab.id);
      }
      report.business.nativeRouting = { originalTargetId: report.business.originalTarget.id, events: frameEvents,
        sourceKinds: [...new Set(frameEvents.map(value => value.source.targetId === undefined ? "tabId-fallback" : "targetId"))],
        boundary: "Read-only native event identity plus frozen production attach code; no wrapper around native attach/sendCommand and no invented command ACK log." };
      report.business.streaming = assertManagedViewerFrames(report.frames, { tabId: oldTaskTab.id, streamId: report.business.firstHumanFrame.streamId });
      assert.equal(posts().length, 0);
    });

    await step("actual-human-cleanup-explicit-resume-and-one-original-post", async () => {
      const oldPage = page;
      const fresh = JSON.parse((await command(["managed", "view", "--root", root, "--name", name])).stdout); assert.equal(new URL(fresh.viewerURL).origin, report.viewerOrigin);
      await openViewer(fresh.viewerURL); await oldPage.close();
      assert.equal(state.status.state, "paused"); assert.equal(state.status.cleanupComplete, true); assert.equal(state.human, null);
      assert.deepEqual(state.humanCleanup, { leaseId: businessLease.leaseId, cleanupConfirmed: true });
      report.business.disconnectCleanup = structuredClone(state);
      const targets = await nativeMap(oldTaskTab.id); assert.equal(targets.length, 1); assert.equal(targets[0].id, report.business.originalTarget.id); assert.equal(targets[0].attached, false);
      await deniedHuman(businessLease, "disconnected human lease cannot send input");
      report.business.resume = await uiAction("#control", "resume"); assert.equal(report.business.resume.status.state, "running"); assert.equal(report.business.resume.human, null);
      await denied("business original request before explicit new turn", () => oldTaskTab.domSnapshot({ timeoutMs: 1500 }), /OBU_STALE_CONTROL_EPOCH/);
      report.business.newTurn = await taskBrowser.client.beginTurn("explicit-after-human-release"); freshTaskTab = taskBrowser.tab(oldTaskTab.id); await freshTaskTab.domSnapshot({ timeoutMs: 10000 });
      await denied("business original authority after explicit new turn", () => requestOriginalSnapshot(taskBrowser.client, oldTaskAuthority), /OBU_STALE_CONTROL_EPOCH/);
      const continued = await documentRead(oldTaskTab.id); assert.equal(continued.documentId, original.documentId); assert.equal(continued.state.documentToken, original.state.documentToken); assert.equal(continued.draft, fixture.expectedDraft); assert.equal(continued.state.submits, 0);
      report.business.beforeSubmit = continued; assert.equal(posts().length, 0);
      await freshTaskTab.getByRole("button", { name: "Commit original handoff receipt", exact: true }).click({ timeoutMs: 10000 });
      const receipt = await wait(async () => { const value = await freshTaskTab.locator("#result").textContent({ timeoutMs: 5000 }); return value && JSON.parse(value); }, "one original POST response");
      const after = await documentRead(oldTaskTab.id); report.business.after = after; report.business.receipt = receipt;
      report.business.receiptProof = assertManagedHumanReceipt(fixture.stats(), original, after, receipt);
      assert.equal(after.documentId, original.documentId); report.business.finalFrames = await worker.evaluate(`chrome.webNavigation.getAllFrames({tabId:${oldTaskTab.id}})`);
      assert.equal(report.business.finalFrames.find(value => value.frameId === 0).documentId, original.documentId);
      await uiAction("#refresh", "status"); await uiAction("#tabs", "select", oldTaskTab.id); report.business.receiptScreenshot = await screenshot("viewer-original-receipt.png");
      report.observerFinal = await worker.evaluate("__managedHumanAcceptance.stop()"); assert.equal(report.observerFinal.listenerPresent, false); assert.equal(report.observerFinal.overflow, false);
      await worker.close(); worker = null;
    });

    await step("trusted-stop-and-original-process-exit", async () => {
      report.preCloseProcesses = descendants(await processTable(), info.browserPID);
      const stop = await uiAction("#stop", "stop"); assert.equal(stop.stopped, true); stopped = true;
      await wait(async () => await page.locator("#state").textContent() === "会话已停止", "actual Stop UI reply", 55000);
      report.viewerStopped = await screenshot("viewer-stopped.png");
      const terminal = await bound(launcher.completed, 10000, "original supervisor terminal exit"); assert.equal(terminal.code, 0, redact(terminal.stderr));
      report.lifecycle = JSON.parse(await fs.readFile(path.join(info.runDir, "lifecycle.json"), "utf8")); assertManagedViewerTerminal(report.lifecycle, info);
      report.processesGone = await wait(async () => { const table = await processTable(), originals = [...report.originalProcesses, ...report.preCloseProcesses]; const remaining = originals.filter(before => table.some(after => before.ProcessId === after.ProcessId && before.CreationDate === after.CreationDate)); return !remaining.length && { at: Date.now(), originalIdentities: originals.length, remaining }; }, "original managed tree gone");
      const status = await command(["managed", "status", "--root", root, "--name", name], 1); assert.match(status.stderr, /has no reachable supervisor/);
    });
  } catch (error) {
    report.error = error.stack; report.firstFailure ??= { at: Date.now(), error: error.stack };
    console.error(redact(error.stack ?? error));
    // Observe the same failed document before original cleanup. These bounded
    // reads run only after failure; they cannot change prior input/ACK ordering.
    if (worker && oldTaskTab) try {
      report.failureDocument = { at: Date.now(), value: await bound(documentRead(oldTaskTab.id), 5000, "failed original document observation") };
    } catch (failure) { report.failureDocumentError = redact(String(failure)); }
    if (page) try {
      report.failureViewer = { at: Date.now(), value: await bound(page.evaluate(() => ({
        state: document.getElementById("state")?.textContent,
        error: document.getElementById("error")?.textContent,
        input: { ...document.getElementById("human-input")?.dataset },
        activeElement: document.activeElement?.id
      })), 5000, "failed original viewer observation") };
    } catch (failure) { report.failureViewerError = redact(String(failure)); }
  }
  finally {
    if (worker) try { report.cleanup.observerStop = await worker.evaluate("__managedHumanAcceptance.stop()"); await worker.close(); } catch (error) { report.cleanup.observerError = error.stack; }
    taskBrowser?.close();
    if (launcher && !launcher.record.closedAt) {
      if (!stopped) try { report.cleanup.stop = JSON.parse((await command(["managed", "stop", "--root", root, "--name", name])).stdout); } catch (error) { report.cleanup.stopError = error.stack; }
      try { await bound(launcher.completed, 10000, "original supervisor cleanup terminal exit"); }
      catch (error) { report.cleanup.supervisorError = error.stack; launcher.terminate("acceptance-cleanup"); try { await launcher.completed; } catch (failure) { report.cleanup.forcedSupervisor = failure.stack; } }
    }
    if (viewerBrowser) try { report.viewerPreCloseProcesses = descendants(await processTable(), viewerProcess.record.pid); const session = await viewerBrowser.newBrowserCDPSession(); await session.send("Browser.close"); } catch (error) { report.cleanup.viewerCloseError = error.stack; }
    if (viewerProcess) try { const result = await bound(viewerProcess.completed, 10000, "independent viewer terminal exit"); assert.equal(result.code, 0); report.viewerExit = { code: result.code, exitedAt: result.exitedAt, closedAt: result.closedAt }; }
    catch (error) { report.cleanup.viewerExitError = error.stack; viewerProcess.terminate("acceptance-cleanup"); try { await viewerProcess.completed; } catch (failure) { report.cleanup.forcedViewer = failure.stack; } }
    if (viewerBrowser) try { await viewerBrowser.close(); } catch (error) { report.cleanup.viewerTransportError = error.stack; }
    if (report.viewerProcesses) try {
      report.viewerProcessesGone = await poll(async () => { const table = await processTable(), originals = [...report.viewerProcesses, ...(report.viewerPreCloseProcesses ?? [])]; const remaining = originals.filter(before => table.some(after => before.ProcessId === after.ProcessId && before.CreationDate === after.CreationDate)); return !remaining.length && { at: Date.now(), originalIdentities: originals.length, remaining }; }, { timeoutMs: 15000, intervalMs: 100, label: "independent viewer original process identities gone" });
    } catch (error) { report.cleanup.viewerProcessesError = error.stack; }
    server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve));
    try { await Promise.all(frameWrites); checkCapture(); } catch (error) { report.cleanup.frameWriteError = error.stack; }
    try {
      assert.equal(hash(await fs.readFile(executable)), report.source.executable); assert.equal(hash(await fs.readFile(chromium)), report.source.browser);
      assert.deepEqual(await treeHashes(extension), report.source.extension); assert.deepEqual(await treeHashes(path.join(repo, "packages/open-browser-use-js/dist")), report.source.sdk);
      assert.deepEqual(await treeHashes(path.join(runDir, "source-snapshot")), report.source.snapshot);
      for (const [relative, expected] of Object.entries(report.source.snapshot)) assert.equal(hash(await fs.readFile(path.join(repo, relative))), expected, `Source changed during acceptance: ${relative}`);
    } catch (error) { report.cleanup.sourceChanged = error.stack; }
    report.fixture = fixture.stats(); report.screenshots = screenshots; report.endedAt = Date.now();
    report.frameRetention = { observedFrames: report.frames.length, savedPNGs: report.frames.filter(frame => frame.file).length, maximumSavedPNGs: 96, metadataOnlyFrames: report.frames.filter(frame => !frame.file).length,
      policy: "The first 96 actual native PNG payloads are retained for independent decoding; all received frames retain hash/header metadata. viewerDecodedFrames identifies actual browser decodes, not unperformed decodes of every frame." };
    report.liveRunnerChildren = [...registry].map(value => value.pid);
    report.passed = !report.error && report.steps.length === 6 && report.steps.every(value => value.passed) && !Object.keys(report.cleanup).length && !registry.size && report.viewerExit?.code === 0;
    await save(); console.log("RESULT", JSON.stringify({ runDir, passed: report.passed }));
  }
  return report;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const report = await runManagedHumanCheck(); process.exitCode = report.passed ? 0 : 1;
}
