import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { directUploadVariants, directUploadKey, directUploadRoute, checkDirectUploadResult, checkDirectUploadItem, checkDirectDirectoryImmediate } from "./direct-locator-upload-fixture.mjs";
import { createDirectUploadObserver, checkDirectUploadFrames, checkDirectUploadNative } from "./direct-locator-upload-native.mjs";

const css = selector => ({ kind: "css", selector });
const chain = (variant, selector) => [...(variant === "root" ? [] : [{ kind: "frame", selector: "#upload-frame" }]), css(selector)];
const describe = error => String(error?.stack ?? error);
const directory = path.dirname(fileURLToPath(import.meta.url));
function trace(detail, method, args, work) {
  const record = { index: detail.trace.length, method, args: structuredClone(args), requestedAt: Date.now() }; detail.trace.push(record);
  return Promise.resolve().then(work).then(value => { record.completedAt = Date.now(); return value; }, error => { record.error = describe(error); record.failedAt = Date.now(); throw error; });
}

export async function directUploadAdapter(options, detail) {
  const { kind, key } = options;
  if (kind === "js") {
    const browser = await options.connectOpenBrowserUse({ socketPath: options.endpoint, sessionId: key, timeoutMs: 15000 });
    try {
      await trace(detail, "beginTurn", {}, () => browser.client.beginTurn());
      detail.scope = { session_id: key, turn_id: browser.client.turnId, control_epoch: browser.client.controlEpoch };
      return {
        create: () => trace(detail, "newTab", {}, async () => (await browser.newTab()).id),
        action: (tabId, action, locator, args = {}) => trace(detail, action, { tabId, locator, args, timeoutMs: 10000 }, async () => {
          const tab = browser.tab(tabId); let target = tab.playwright;
          for (const step of locator ?? []) target = step.kind === "frame" ? target.frameLocator(step.selector) : target.locator(step.selector);
          if (action === "goto") return tab.goto(args.url, { waitUntil: "load", timeoutMs: 10000 });
          if (action === "engineInfo") return browser.client.browserAction(tabId, "engineInfo", { timeoutMs: 10000 });
          if (action === "setInputFiles") return target.setInputFiles(args.files, { timeoutMs: 10000 });
          if (action === "waitFor") return target.waitFor({ state: args.state, timeoutMs: 10000 });
          if (action === "innerText") return target.innerText({ timeoutMs: 10000 });
          throw Error(`Unsupported direct upload action ${action}`);
        }),
        invalid: (tabId, args) => trace(detail, "invalidFiles", args, () => browser.client.browserAction(tabId, "setInputFiles", { locator: [css("#upload")], args, timeoutMs: 10000 })),
        finalize: () => trace(detail, "finalizeTabs", { keep: [] }, () => browser.client.finalizeTabs([])), close: () => browser.close(),
      };
    } catch (error) { browser.close(); throw error; }
  }
  const send = (method, params) => trace(detail, method, params, () => options.call(method, params));
  const initial = { session_id: key, turn_id: key + "-turn" };
  const state = await send("getControlState", initial);
  assert.equal(state.closing, false); assert.ok(Number.isSafeInteger(state.controlEpoch));
  detail.scope = { ...initial, control_epoch: state.controlEpoch };
  const scoped = (method, params) => send(method, { ...detail.scope, ...params });
  return {
    create: async () => (await scoped("createTab", {})).id,
    action: async (tabId, action, locator = [], args = {}) => {
      const result = await scoped("browserAction", { tabId, action, ...(locator.length ? { locator } : {}), args, timeoutMs: 10000 });
      assert.equal(result.engine?.name, "playwright-crx"); assert.ok(Object.hasOwn(result, "value"));
      return action === "engineInfo" ? result : result.value;
    },
    invalid: (tabId, args) => scoped("browserAction", { tabId, action: "setInputFiles", locator: [css("#upload")], args, timeoutMs: 10000 }),
    finalize: () => scoped("finalizeTabs", { keep: [] }), close() {},
  };
}

// The original failure stays in detail; neither finish/restore nor finalize may
// replace it. Every mutation is a single attempt with its own original10s budget.
export async function executeDirectUpload(adapter, options, detail) {
  let finalizing = false, failure;
  try {
    for (const variant of directUploadVariants) {
      const item = { key: `${options.key}-${variant}`, variant, passed: false }; detail.variants.push(item);
      let started = false, businessError;
      try {
        item.tabId = await adapter.create(); detail.createdTabIds.push(item.tabId);
        started = true; await options.onStart(item);
        const url = new URL(directUploadRoute + "page", options.fixtureURL); url.search = new URLSearchParams({ key: item.key, variant }).toString(); item.url = url.href;
        await adapter.action(item.tabId, "goto", [], { url: item.url, waitUntil: "load" });
        item.engine = await adapter.action(item.tabId, "engineInfo"); assert.equal(item.engine.engine.capabilities.locatorFileUpload, 1);
        const read = async () => JSON.parse(await adapter.action(item.tabId, "innerText", chain(variant, "#state")));
        item.before = await read();
        if (variant === "root") {
          item.negatives = [];
          for (const spec of [{ name: "strict", selector: ".ambiguous", files: options.files.map(file => file.path) }, { name: "non-file", selector: "#non-file", files: options.files.map(file => file.path) },
            { name: "null", raw: { files: null } }, { name: "relative", raw: { files: ["relative.txt"] } }]) {
            const record = { name: spec.name }; item.negatives.push(record);
            try { if (spec.raw) await adapter.invalid(item.tabId, spec.raw); else await adapter.action(item.tabId, "setInputFiles", chain(variant, spec.selector), { files: spec.files }); }
            catch (error) { record.error = describe(error); }
            assert.ok(record.error, `${spec.name} incorrectly succeeded`);
            assert.doesNotMatch(record.error, /timed out|timeout|deadline|disconnect/i, "A validation error must not be inferred from an expired operation");
          }
          item.afterNegatives = await read(); assert.deepEqual(item.afterNegatives, item.before);
        }
        item.uploadStartedAt = Date.now(); await adapter.action(item.tabId, "setInputFiles", chain(variant, "#upload"), { files: options.files.map(file => file.path) }); item.uploadCompletedAt = Date.now();
        await adapter.action(item.tabId, "waitFor", chain(variant, "#receipt"), { state: "visible" });
        item.receipt = JSON.parse(await adapter.action(item.tabId, "innerText", chain(variant, "#receipt"))); item.uploaded = await read();
        item.clearStartedAt = Date.now(); await adapter.action(item.tabId, "setInputFiles", chain(variant, "#upload"), { files: [] }); item.clearCompletedAt = Date.now(); item.cleared = await read(); item.passed = true;
      } catch (error) { businessError = error; item.error = describe(error); throw error; }
      finally {
        if (started) try { await options.onFinish(item); } catch (error) { item.observerError = describe(error); if (!businessError) throw error; }
      }
    }
    finalizing = true; detail.finalizeResult = await adapter.finalize(); detail.passed = true;
  } catch (error) { failure = error; detail.error = describe(error); detail.passed = false; }
  finally {
    if (!finalizing) try { detail.cleanupResult = await adapter.finalize(); } catch (error) { detail.cleanupError = describe(error); }
    adapter.close();
  }
  if (failure) throw failure;
  return detail;
}

// A small dedicated protocol; deliberately does not relax the older chooser
// runner's variant names/flag. Hook ACK is preparation, not a browser action.
export async function runDirectUploadProcess(command, args, { onHook, env, timeoutMs = 180000 } = {}) {
  const report = { process: { pid: null, exitObserved: false, closeObserved: false, stdout: "", stderr: "" }, hooks: [], errors: [], result: null };
  let child, buffer = "", sequence = 0, active = null, pending = null, resultSeen = false, stopping = false, timer, forceTimer;
  const seen = new Set();
  const decoder = new StringDecoder("utf8");
  const stop = error => { report.errors.push(describe(error)); if (stopping || report.process.closeObserved) return; stopping = true; child.stdin.destroy(); child.kill(); forceTimer = setTimeout(() => { if (!report.process.closeObserved) child.kill("SIGKILL"); }, 1000); };
  const hook = async message => {
    let hookTimer, error;
    const record = { ...message, requestedAt: Date.now() }; report.hooks.push(record);
    try { await Promise.race([onHook(message), new Promise((_, reject) => { hookTimer = setTimeout(() => reject(Error("Direct upload hook deadline")), 5000); })]); record.completedAt = Date.now(); }
    catch (caught) { error = caught; record.error = describe(caught); report.errors.push(record.error); }
    finally { clearTimeout(hookTimer); }
    if (!stopping && !report.process.closeObserved) child.stdin.write(JSON.stringify({ type: "ack", version: 1, id: message.id, ok: !error, ...(error ? { error: describe(error) } : {}) }) + "\n");
  };
  const receive = message => {
    assert.equal(resultSeen, false); assert.equal(pending, null, "Caller did not await hook ACK");
    if (message.type === "result") { assert.equal(active, null); assert.equal(message.version, 1); assert.ok(message.result && typeof message.result === "object"); resultSeen = true; report.result = message.result; child.stdin.end(); return; }
    assert.deepEqual(Object.keys(message).sort(), ["id", "item", "kind", "type", "version"]); assert.equal(message.type, "hook"); assert.equal(message.version, 1); assert.equal(message.id, ++sequence);
    assert.ok(["start", "finish"].includes(message.kind)); const item = message.item;
    assert.deepEqual(Object.keys(item).sort(), ["key", "tabId", "variant"]); assert.ok(directUploadVariants.includes(item.variant)); assert.ok(Number.isSafeInteger(item.tabId) && item.tabId >= 0); assert.match(item.key, /^direct-(python|go)-[a-z0-9-]+$/);
    if (message.kind === "start") { assert.equal(active, null); assert.equal(seen.has(item.tabId), false); seen.add(item.tabId); active = item; }
    else { assert.deepEqual(item, active); active = null; }
    pending = hook(message).finally(() => { pending = null; }); pending.catch(stop);
  };
  child = spawn(command, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env }); report.process.pid = child.pid;
  await new Promise(resolve => {
    timer = setTimeout(() => stop(Error("Direct upload process deadline")), timeoutMs);
    child.stdout.on("data", bytes => {
      const decoded = decoder.write(bytes); report.process.stdout += decoded; if (Buffer.byteLength(report.process.stdout) > 4 * 1024 * 1024) { stop(Error("Direct upload stdout bound")); return; }
      buffer += decoded;
      while (buffer.includes("\n") && !stopping) { const index = buffer.indexOf("\n"), line = buffer.slice(0, index); buffer = buffer.slice(index + 1); try { receive(JSON.parse(line)); } catch (error) { stop(error); } }
    });
    child.stderr.on("data", bytes => { if (report.process.stderr.length < 65536) report.process.stderr += bytes.toString("utf8"); else stop(Error("Direct upload stderr bound")); });
    child.on("error", stop); child.stdin.on("error", error => { if (!report.process.closeObserved && !stopping) stop(error); });
    child.on("exit", (code, signal) => Object.assign(report.process, { exitObserved: true, exitCode: code, signal, exitedAt: Date.now() }));
    child.on("close", (code, signal) => { Object.assign(report.process, { closeObserved: true, exitCode: code, signal, closedAt: Date.now() }); clearTimeout(timer); clearTimeout(forceTimer); resolve(); });
  });
  await pending;
  if (buffer.trim() || active || !resultSeen) report.errors.push("Incomplete direct upload protocol");
  report.complete = report.errors.length === 0 && resultSeen && report.process.closeObserved;
  return report;
}

export async function checkDirectLocatorUpload(options) {
  const { kind, worker, files, server } = options; assert.ok(["js", "cli", "mcp", "python", "go"].includes(kind));
  const detail = options.detail ?? { caller: kind, key: directUploadKey(kind), variants: [], createdTabIds: [], trace: [], passed: false };
  Object.assign(detail, { caller: kind, key: detail.key ?? directUploadKey(kind), variants: detail.variants ?? [], createdTabIds: detail.createdTabIds ?? [], trace: detail.trace ?? [], passed: false });
  const observer = createDirectUploadObserver(worker);
  detail.callerProcesses = [];
  const parameters = { ...options, key: detail.key, onStart: item => observer.start(item), onFinish: item => {
    if ((kind === "cli" && detail.callerProcesses.some(record => !record.closeObserved)) || (kind === "mcp" && item.error))
      throw Error("Failed external caller has not confirmed close; native finish observation skipped");
    return observer.finish(item);
  } };
  let failure;
  try {
    if (["python", "go"].includes(kind)) {
      const input = path.join(options.runDir, `direct-locator-${kind}-files.json`), output = path.join(options.runDir, `direct-locator-${kind}-caller.json`);
      await fs.writeFile(input, JSON.stringify(files), { flag: "wx" });
      const command = kind === "go" ? options.goExecutable : options.pythonExecutable ?? process.env.OBU_TEST_PYTHON ?? "python";
      assert.ok(command, "Direct locator Go executable required");
      const args = [...(kind === "python" ? [options.pythonSource ?? path.join(directory, "direct-locator-upload-checks.py")] : []), options.endpoint, options.fixtureURL, input, output];
      const processResult = await runDirectUploadProcess(command, args, { env: options.env ?? process.env, onHook: message => message.kind === "start" ? observer.start(message.item) : observer.finish(message.item) });
      detail.childProcess = processResult; assert.equal(processResult.process.closeObserved, true);
      if (processResult.result) Object.assign(detail, structuredClone(processResult.result));
      assert.equal(detail.caller, kind);
      assert.equal(processResult.complete, true, JSON.stringify(processResult.errors)); assert.equal(processResult.process.exitCode, 0, detail.error);
      assert.deepEqual(JSON.parse(await fs.readFile(output, "utf8")), processResult.result);
    } else if (kind === "mcp") {
      const processEvidence = {}; detail.callerProcesses.push(processEvidence);
      await options.withMCPClient(options.executable, options.endpoint, detail.key, async call => executeDirectUpload(await directUploadAdapter({ ...parameters, call }, detail), parameters, detail), processEvidence);
      assert.equal(processEvidence.closeObserved, true, "MCP process has not closed");
    } else {
      const call = async (method, params) => {
        const processEvidence = { method }; detail.callerProcesses.push(processEvidence);
        const raw = JSON.parse(await options.subprocess(options.executable, ["call", "--socket", options.endpoint, "--session-id", detail.key, "--method", method, "--params", JSON.stringify(params), "--timeout", "15s"], { processEvidence }));
        assert.equal(processEvidence.closeObserved, true, "CLI process has not closed");
        assert.equal(raw.error, undefined, JSON.stringify(raw.error)); return raw.result;
      };
      await executeDirectUpload(await directUploadAdapter({ ...parameters, call }, detail), parameters, detail);
    }
    checkDirectUploadResult(detail, files, server);
    for (const item of detail.variants) {
      const observed = observer.entries.get(item.key); assert.ok(observed);
      checkDirectUploadFrames(item, observed.frames); item.nativeSummary = checkDirectUploadNative(observed.probe, item, files.map(file => file.path));
    }
    const groups = new Set(detail.variants.map(item => item.frameEvidence.tab.groupId));
    assert.equal(groups.size, 1); assert.ok([...groups][0] >= 0, "One caller must retain one original task group");
    const tabIds = detail.createdTabIds, targetIds = detail.variants.flatMap(item => item.frameEvidence.targets.filter(target => target.tabId === item.tabId || target.url === item.before.href).map(target => target.id));
    detail.cleanup = await worker.evaluate(`(async()=>({tabs:(await chrome.tabs.query({})).filter(t=>${JSON.stringify(tabIds)}.includes(t.id)),targets:(await chrome.debugger.getTargets()).filter(t=>${JSON.stringify(tabIds)}.includes(t.tabId)||${JSON.stringify(targetIds)}.includes(t.id))}))()`);
    assert.deepEqual(detail.cleanup, { tabs: [], targets: [] }, "Finalized direct-upload pages/targets remain");
  } catch (error) { failure = error; detail.passed = false; detail.auditError = describe(error); }
  finally {
    detail.observations = [...observer.entries.values()];
    try { await observer.cleanup(); } catch (error) { detail.observerCleanupError = describe(error); detail.passed = false; failure ??= error; }
  }
  if (failure) throw failure;
  return detail;
}

export async function checkDirectLocatorDirectory({ browser, worker, fixtureURL, server, files, detail = {}, createTab = () => browser.newTab({ backgroundWindow: true }), onCreated = async () => {} }) {
  Object.assign(detail, { caller: "js", key: directUploadKey("directory"), variant: "root", passed: false, directory: true });
  const observer = createDirectUploadObserver(worker); let tab, finalizeAttempted = false, failure;
  try {
    tab = await createTab(); detail.tabId = tab.id;
    await onCreated(tab); await observer.start(detail);
    const url = new URL(directUploadRoute + "page", fixtureURL); url.search = new URLSearchParams({ key: detail.key, variant: "root", directory: "1" }).toString(); detail.url = url.href;
    await tab.goto(detail.url, { waitUntil: "load", timeoutMs: 10000 });
    const read = async selector => JSON.parse(await tab.locator(selector).innerText({ timeoutMs: 10000 }));
    detail.before = await read("#state"); detail.scope = { session_id: browser.client.sessionId, turn_id: browser.client.turnId, control_epoch: browser.client.controlEpoch };
    detail.uploadStartedAt = Date.now(); await tab.locator("#upload").setInputFiles([files.root], { timeoutMs: 10000 }).then(() => {
      detail.atReturn = server.stats(detail.key); detail.uploadCompletedAt = Date.now();
    });
    checkDirectDirectoryImmediate(detail.atReturn, { before: detail.before, files: files.files });
    await tab.locator("#receipt").waitFor({ state: "visible", timeoutMs: 10000 }); detail.receipt = await read("#receipt"); detail.uploaded = await read("#state");
    detail.clearStartedAt = Date.now(); await tab.locator("#upload").setInputFiles([], { timeoutMs: 10000 }).then(() => {
      detail.clearAtReturn = server.stats(detail.key); detail.clearCompletedAt = Date.now();
    });
    checkDirectDirectoryImmediate(detail.clearAtReturn, { before: detail.before, files: [], clear: true }); detail.cleared = await read("#state");
    await observer.finish(detail); const observed = observer.entries.get(detail.key);
    checkDirectUploadFrames(detail, observed.frames, { active: true }); detail.nativeSummary = checkDirectUploadNative(observed.probe, detail, [files.root]);
    detail.passed = true; checkDirectUploadItem(detail, files.files, server.stats(detail.key), true);
    finalizeAttempted = true; detail.finalizeResult = await browser.client.finalizeTabs([]);
  } catch (error) { failure = error; detail.passed = false; detail.error = describe(error); }
  finally {
    try { await observer.cleanup(); } catch (error) { detail.observerCleanupError = describe(error); detail.passed = false; failure ??= error; }
    detail.observations = [...observer.entries.values()];
    if (!finalizeAttempted) try { detail.cleanupResult = await browser.client.finalizeTabs([]); } catch (error) { detail.cleanupError = describe(error); failure ??= error; }
  }
  if (failure) throw failure;
  return detail;
}
