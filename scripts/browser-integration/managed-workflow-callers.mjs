import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runOriginalDownloadProcess } from "./original-download-callers.mjs";
import { readOriginalDownloadProof } from "./original-download-proof.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
const describe = error => error?.stack ?? String(error);
const clone = value => value === undefined ? null : structuredClone(value);
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const remaining = deadline => { const ms = Math.floor(deadline - performance.now()); assert.ok(ms > 0, "Original workflow deadline expired; no further action submitted"); return ms; };
const tabID = value => { assert.ok(Number.isSafeInteger(value) && value >= 0, "Invalid original tab ID"); return value; };
const control = state => { assert.ok(object(state) && state.lifecycleVersion === 1 && state.closing === false && Number.isSafeInteger(state.controlEpoch) && state.controlEpoch >= 1 && typeof state.nextTurnId === "string" && state.nextTurnId, "Invalid original control acknowledgement"); return state; };
const endedControl = state => { assert.ok(object(state) && !Object.hasOwn(state, "closing") && typeof state.endedTurnId === "string" && state.endedTurnId, "Invalid original control-end acknowledgement"); control({ ...state, closing: false }); return state; };

// A single owned helper/MCP process and one in-flight JSON request. Process
// close is always observed. A timeout never starts a replacement process.
function lineProcess(command, args, detail, env, spawnProcess = spawn) {
  const record = { executable: command, args, startedAt: Date.now(), stdout: "", stderr: "", messages: [], exitObserved: false, closeObserved: false };
  detail.callerProcesses.push(record);
  const child = spawnProcess(command, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], ...(env ? { env } : {}) });
  record.pid = child.pid ?? null;
  let buffer = "", sequence = 0, pending, failure, timer, killTimer;
  const rejectPending = error => { if (!pending) return; const item = pending; pending = undefined; clearTimeout(item.timer); item.reject(error); };
  const stop = error => {
    failure ??= error; record.error ??= describe(error); rejectPending(failure);
    if (record.closeObserved || record.terminationRequestedAt) return;
    record.terminationRequestedAt = Date.now(); child.stdin.destroy(); child.kill();
    killTimer = setTimeout(() => { if (!record.closeObserved) child.kill("SIGKILL"); }, 1000);
  };
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", data => {
    if (Buffer.byteLength(record.stdout) + Buffer.byteLength(data) > 2 * 1024 * 1024) { stop(Error("Workflow stdout bound exceeded")); return; }
    record.stdout += data; buffer += data;
    try {
      while (buffer.includes("\n")) {
        const end = buffer.indexOf("\n"), line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        assert.ok(Buffer.byteLength(line) <= 512 * 1024, "Workflow response line bound exceeded");
        const response = JSON.parse(line); record.messages.push({ direction: "receive", at: Date.now(), message: response });
        if (response.id === undefined) { assert.ok(response.jsonrpc === "2.0" && typeof response.method === "string", "Invalid process notification"); continue; }
        assert.ok(pending && response.id === pending.id, "Unexpected workflow response ID");
        const item = pending; pending = undefined; clearTimeout(item.timer); item.resolve(response);
      }
      assert.ok(Buffer.byteLength(buffer) <= 512 * 1024, "Workflow response line bound exceeded");
    } catch (error) { stop(error); }
  });
  child.stderr.on("data", data => { if (Buffer.byteLength(record.stderr) + Buffer.byteLength(data) > 65536) stop(Error("Workflow stderr bound exceeded")); else record.stderr += data; });
  child.on("error", stop); child.stdin.on("error", stop);
  child.once("exit", (code, signal) => Object.assign(record, { exitObserved: true, exitCode: code, signal: signal ?? null, exitedAt: Date.now() }));
  const closed = new Promise(resolve => child.once("close", (code, signal) => {
    Object.assign(record, { closeObserved: true, exitCode: code, signal: signal ?? null, closedAt: Date.now() });
    clearTimeout(timer); clearTimeout(killTimer); rejectPending(failure ?? Error(`Workflow process closed ${code}: ${record.stderr}`)); resolve();
  }));
  const send = message => {
    if (failure || record.closeObserved) throw failure ?? Error("Workflow process is closed");
    const line = JSON.stringify(message) + "\n"; assert.ok(Buffer.byteLength(line) <= 65536, "Workflow input line exceeds bound");
    record.messages.push({ direction: "send", at: Date.now(), message: clone(message) }); child.stdin.write(line);
  };
  return {
    record, send,
    async request(message, timeoutMs) {
      assert.equal(pending, undefined, "Sequential workflow requests required"); assert.ok(++sequence <= 48, "Workflow request count exceeded");
      if (failure || record.closeObserved) throw failure ?? Error("Workflow process is closed");
      return new Promise((resolve, reject) => {
        const id = sequence; pending = { id, resolve, reject, timer: setTimeout(() => stop(Error("Workflow process response deadline exceeded")), timeoutMs) };
        try { send({ ...message, id }); } catch (error) { stop(error); }
      });
    },
    async close() {
      if (!record.closeObserved && !child.stdin.destroyed) child.stdin.end();
      if (!record.closeObserved) timer = setTimeout(() => stop(Error("Workflow process did not close after EOF")), 2000);
      await closed;
      assert.equal(buffer.trim(), "", "Incomplete workflow process response");
      if (failure) throw failure;
      assert.equal(record.exitObserved, true, "Original process exit must be observed");
      assert.equal(record.exitCode, 0, `Workflow process failed: ${record.stderr}`);
    },
  };
}

async function sdkAdapter(options) {
  const { OpenBrowserUseBrowser } = await import(pathToFileURL(options.sdkJSPath).href);
  const browser = new OpenBrowserUseBrowser({ socketPath: options.socketPath, sessionId: options.sessionId, timeoutMs: 15000 });
  const tabs = new Map(); let pageWait, downloadWait, download;
  const tab = id => { assert.ok(tabs.has(id), "Original typed tab required"); return tabs.get(id); };
  return {
    async call(op, args) {
      const actionOptions = { timeoutMs: args.timeoutMs };
      switch (op) {
        case "connect": await browser.connect(); return browser.client.beginTurn();
        case "create": { const created = await browser.newTab({ backgroundWindow: true }); tabs.set(created.id, created); return { tabId: created.id }; }
        case "goto": return tab(args.tabId).goto(args.url, { waitUntil: "load", ...actionOptions });
        case "expectPage": pageWait = await tab(args.tabId).expectPage(actionOptions); return { waiterId: pageWait.waiterId, remainingMs: pageWait.remainingMs };
        case "click": return tab(args.tabId).playwright.getByRole("button", { name: args.name, exact: true }).click(actionOptions);
        case "collectPage": { const child = await pageWait.result(); tabs.set(child.id, child); return { tabId: child.id }; }
        case "cancelPage": return pageWait.cancel();
        case "snapshot": return tab(args.tabId).domSnapshot();
        case "text": return tab(args.tabId).playwright.locator(args.selector).textContent(actionOptions);
        case "fill": return tab(args.tabId).playwright.locator(args.selector).fill(args.value, actionOptions);
        case "waitVisible": return tab(args.tabId).playwright.locator(args.selector).waitFor({ state: "visible", ...actionOptions });
        case "expectDownload": downloadWait = await tab(args.tabId).expectDownload({ requirePath: true, ...actionOptions }); return { waiterId: downloadWait.waiterId, remainingMs: downloadWait.remainingMs };
        case "collectDownload": download = await downloadWait.result(); return { downloadId: download.downloadId };
        case "downloadPath": return download.path(actionOptions);
        case "cancelDownload": return downloadWait.cancel();
        case "tabs": return browser.getTabs();
        case "finalize": return browser.client.finalizeTabs(args.keep);
        default: throw Error(`Unknown workflow SDK operation ${op}`);
      }
    },
    async close() { browser.close(); },
  };
}

function helperAdapter(options, detail) {
  const python = options.kind === "python";
  const command = python ? options.python : options.goHelperBinary;
  assert.ok(typeof command === "string" && command, "An explicit helper runtime/binary is required");
  const process = lineProcess(command, python ? [path.join(directory, "managed-workflow-helper.py")] : [], detail,
    python ? { ...globalThis.process.env, PYTHONPATH: options.pythonPackageDir, PYTHONUTF8: "1", PYTHONDONTWRITEBYTECODE: "1" } : undefined, options.spawnProcess);
  const call = async (op, args, timeoutMs) => {
    const response = await process.request({ op, args }, timeoutMs);
    assert.ok(response.ok === true || response.ok === false, "Invalid typed helper response");
    if (!response.ok) throw Error(JSON.stringify(response.error));
    assert.ok(Object.hasOwn(response, "result")); return response.result;
  };
  return { call, async close() { let error; try { await call("close", {}, 15000); } catch (failure) { error = failure; } try { await process.close(); } catch (failure) { error ??= failure; } if (error) throw error; } };
}

async function wireAdapter(options, detail) {
  let process;
  const selection = ["--managed", options.name, "--managed-root", options.root, "--session-id", options.sessionId];
  const rpc = response => { assert.ok(object(response) && response.jsonrpc === "2.0", "Invalid original RPC envelope"); if (response.error) throw Error(JSON.stringify(response.error)); assert.ok(Object.hasOwn(response, "result")); return response.result; };
  const send = async (method, params, timeoutMs) => {
    if (options.kind === "cli") {
      const record = {}; detail.callerProcesses.push(record);
      const stdout = await runOriginalDownloadProcess({ command: options.binary, args: ["call", ...selection, "--method", method, "--params", JSON.stringify(params), "--timeout", `${timeoutMs}ms`], timeoutMs: timeoutMs + 1000, detail: record, spawnProcess: options.spawnProcess });
      record.response = JSON.parse(stdout); return rpc(record.response);
    }
    const response = await process.request({ jsonrpc: "2.0", method: "tools/call", params: { name: "call", arguments: { method, params } } }, timeoutMs + 1000);
    const tool = rpc(response); assert.equal(tool.isError, false, "Original MCP tool failed"); return rpc(tool.structuredContent);
  };
  let scope, pageWait, downloadWait, downloadId;
  const scoped = (method, params, timeout) => send(method, { ...params, ...scope }, timeout);
  return {
    async call(op, args, timeoutMs) {
      const action = async (name, locator = [], value = {}) => {
        const response = await scoped("browserAction", { tabId: args.tabId, action: name, ...(locator.length ? { locator } : {}), args: value, timeoutMs: args.timeoutMs ?? 15000 }, timeoutMs);
        assert.ok(object(response) && Object.hasOwn(response, "value") && response.engine?.name === "playwright-crx", "Invalid original browser action response"); return response.value;
      };
      switch (op) {
        case "connect": {
          if (options.kind === "mcp") {
            process = lineProcess(options.binary, ["mcp", ...selection, "--timeout", "20s"], detail, undefined, options.spawnProcess);
            const initialized = rpc(await process.request({ jsonrpc: "2.0", method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "obu-managed-workflow", version: "1.0.0" } } }, timeoutMs));
            assert.equal(initialized.protocolVersion, "2025-06-18"); process.send({ jsonrpc: "2.0", method: "notifications/initialized" });
          }
          const initial = { session_id: options.sessionId, turn_id: `initial-${options.taskId}` };
          const info = await send("getInfo", initial, timeoutMs); assert.equal(info.metadata?.turnLifecycleVersion, 1);
          const state = control(await send("getControlState", initial, timeoutMs));
          scope = { session_id: options.sessionId, turn_id: state.nextTurnId, control_epoch: state.controlEpoch }; return state;
        }
        case "create": return { tabId: tabID((await scoped("createTab", { backgroundWindow: true }, timeoutMs)).id) };
        case "goto": return action("goto", [], { url: args.url, waitUntil: "load" });
        case "expectPage": pageWait = { tabId: args.tabId, ...await scoped("armPageWait", { tabId: args.tabId, timeoutMs: args.timeoutMs }, timeoutMs) }; return { waiterId: pageWait.waiterId, remainingMs: pageWait.remainingMs };
        case "click": return action("click", [{ kind: "role", role: "button", name: args.name, exact: true }]);
        case "collectPage": return scoped("collectPageWait", { tabId: pageWait.tabId, waiterId: pageWait.waiterId }, timeoutMs);
        case "cancelPage": { const result = await scoped("cancelPageWait", { tabId: pageWait.tabId, waiterId: pageWait.waiterId }, timeoutMs); assert.deepEqual(result, {}); return null; }
        case "snapshot": return action("snapshot");
        case "text": return action("textContent", [{ kind: "css", selector: args.selector }]);
        case "fill": return action("fill", [{ kind: "css", selector: args.selector }], { value: args.value });
        case "waitVisible": return action("waitFor", [{ kind: "css", selector: args.selector }], { state: "visible" });
        case "expectDownload": downloadWait = { tabId: args.tabId, ...await scoped("armDownloadWait", { tabId: args.tabId, timeoutMs: args.timeoutMs, requirePath: true }, timeoutMs) }; return { waiterId: downloadWait.waiterId, remainingMs: downloadWait.remainingMs };
        case "collectDownload": { const result = await scoped("collectDownloadWait", { tabId: downloadWait.tabId, waiterId: downloadWait.waiterId }, timeoutMs); downloadId = result.downloadId; return result; }
        case "downloadPath": return (await scoped("downloadPath", { tabId: downloadWait.tabId, downloadId, timeoutMs: args.timeoutMs }, timeoutMs)).path;
        case "cancelDownload": { const result = await scoped("cancelDownloadWait", { tabId: downloadWait.tabId, waiterId: downloadWait.waiterId }, timeoutMs); assert.deepEqual(result, {}); return null; }
        case "tabs": return scoped("getTabs", {}, timeoutMs);
        case "finalize": { const result = await scoped("finalizeTabs", { keep: args.keep }, timeoutMs); const next = endedControl(result); scope = { ...scope, turn_id: next.nextTurnId, control_epoch: next.controlEpoch }; return result; }
        default: throw Error(`Unknown workflow wire operation ${op}`);
      }
    },
    async close() { if (process) await process.close(); },
  };
}

export async function readManagedWorkflowFile({ downloadRoot, productPath, receipt, artifactDir, taskId }) {
  assert.match(taskId, /^[a-z][a-z0-9-]{0,63}$/);
  const bytes = Buffer.from(JSON.stringify(receipt) + "\n");
  const proof = await readOriginalDownloadProof(downloadRoot, productPath, { bytes: bytes.length, base64: bytes.toString("base64"), sha256: hash(bytes) });
  const root = await fs.realpath(artifactDir), stat = await fs.lstat(artifactDir);
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), "Dedicated ordinary artifact directory required");
  const artifactPath = path.join(root, `${taskId}-original-report.json`);
  const originalBytes = Buffer.from(proof.base64, "base64");
  assert.equal(originalBytes.length, proof.bytes); assert.equal(hash(originalBytes), proof.sha256);
  await fs.writeFile(artifactPath, originalBytes, { flag: "wx", mode: 0o600 });
  return { ...proof, productPath, artifactPath };
}

// Deterministic public-entry workflow, not a model solver or performance claim.
// The fixture/oracle is deliberately not imported. Values come from the Page.
export async function runManagedWorkflowCaller(options) {
  const { kind, taskId, baseURL, artifactDir, downloadRoot, detail = {}, onStep = async () => {}, timeoutMs = 180000 } = options;
  assert.ok(["js", "python", "go", "cli", "mcp"].includes(kind)); assert.match(taskId, /^[a-z][a-z0-9-]{0,63}$/);
  const base = new URL(baseURL); assert.ok(base.protocol === "http:" && base.hostname === "127.0.0.1" && !base.username && !base.password && base.pathname === "/" && !base.search && !base.hash);
  for (const value of [artifactDir, downloadRoot, options.root]) assert.ok(typeof value === "string" && path.isAbsolute(value));
  for (const value of [options.socketPath, options.name, options.binary]) assert.ok(typeof value === "string" && value && !value.includes("\0"));
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= 600000); assert.equal(typeof onStep, "function");
  const config = { ...options, sessionId: `managed-workflow-${taskId}` };
  Object.assign(detail, { kind, taskId, ok: false, sessionId: config.sessionId, sourceURL: new URL(`/managed-workflow/${taskId}/source`, base).href,
    resultURL: new URL(`/managed-workflow/${taskId}/child`, base).href, startedAt: Date.now(), trace: [], callerProcesses: [], pageWait: null, downloadWait: null, clientClose: { attempted: false, ok: false } });
  const deadline = performance.now() + timeoutMs;
  let adapter, failure, pageCancelled = false, downloadCancelled = false;
  const step = async (name, args, operation, capture = () => {}, cleanup = false) => {
    if (!cleanup) remaining(deadline);
    const record = { name, args: clone(args), startedAt: Date.now(), ok: false }; detail.trace.push(record);
    try {
      const result = await operation(); record.result = clone(result); capture(result); record.completedAt = Date.now();
      if (!cleanup) { remaining(deadline); let timer; try { await Promise.race([Promise.resolve().then(() => onStep(name, { detail, step: record })), new Promise((_, reject) => { timer = setTimeout(() => reject(Error("Workflow observation callback exceeded task deadline")), remaining(deadline)); })]); } finally { clearTimeout(timer); } }
      record.ok = true; return result;
    } catch (error) { record.error = describe(error); record.failedAt = Date.now(); throw error; }
  };
  const call = (name, op, args = {}, capture, cleanup = false) => {
    const actual = { ...args };
    if (!cleanup && Object.hasOwn(actual, "timeoutMs")) actual.timeoutMs = Math.min(actual.timeoutMs, remaining(deadline));
    return step(name, actual, () => adapter.call(op, actual, cleanup ? 15000 : Math.min(20000, remaining(deadline))), capture, cleanup);
  };
  const text = (name, tabId, selector, capture) => call(name, "text", { tabId, selector, timeoutMs: 10000 }, value => { assert.equal(typeof value, "string"); capture?.(JSON.parse(value)); });
  const ack = value => { assert.ok(object(value) && typeof value.waiterId === "string" && value.waiterId && Number.isFinite(value.remainingMs) && value.remainingMs > 0 && value.remainingMs <= 15000); return value; };
  try {
    adapter = kind === "js" ? await sdkAdapter(config) : ["python", "go"].includes(kind) ? helperAdapter(config, detail) : await wireAdapter(config, detail);
    await call("connect", "connect", { socketPath: config.socketPath, sessionId: config.sessionId, timeoutMs: 15000 }, state => { control(state); detail.scope = { session_id: config.sessionId, turn_id: state.nextTurnId, control_epoch: state.controlEpoch }; });
    await call("source-created", "create", {}, value => { detail.sourceTabId = tabID(value.tabId); });
    await call("source-navigated", "goto", { tabId: detail.sourceTabId, url: detail.sourceURL, timeoutMs: 10000 });
    let pageDeadline = performance.now() + 15000;
    await call("page-prepared", "expectPage", { tabId: detail.sourceTabId, timeoutMs: 15000 }, value => { detail.pageWait = clone(ack(value)); pageDeadline = Math.min(pageDeadline, performance.now() + value.remainingMs); });
    await call("open-clicked", "click", { tabId: detail.sourceTabId, name: "Open task form", timeoutMs: Math.min(5000, remaining(pageDeadline)) });
    remaining(pageDeadline);
    await call("child-created", "collectPage", {}, value => { detail.resultTabId = tabID(value.tabId); assert.notEqual(detail.resultTabId, detail.sourceTabId); });
    await call("page-cancelled", "cancelPage", {}, () => { pageCancelled = true; detail.pageWait.cancelled = true; });
    await call("snapshot", "snapshot", { tabId: detail.resultTabId }, value => { assert.ok(typeof value === "string" && value.includes("Review original report")); detail.snapshot = value; });
    await text("instructions", detail.resultTabId, "#instructions", value => { assert.deepEqual(Object.keys(value).sort(), ["amount", "note", "reference", "taskId"]); assert.equal(value.taskId, taskId); for (const key of ["amount", "note", "reference"]) assert.ok(typeof value[key] === "string" && value[key].length > 0 && value[key].length <= 512); detail.instructions = value; });
    await text("document-before", detail.resultTabId, "#state", value => { assert.equal(value.taskId, taskId); assert.deepEqual(value.submits, []); assert.deepEqual(value.downloads, []); assert.equal(value.error, null); detail.documentBefore = value; });
    for (const field of ["reference", "amount", "note"]) await call(`fill-${field}`, "fill", { tabId: detail.resultTabId, selector: `[name=${field}]`, value: detail.instructions[field], timeoutMs: 10000 });
    await call("submit-clicked", "click", { tabId: detail.resultTabId, name: "Submit task once", timeoutMs: 10000 });
    await call("receipt-visible", "waitVisible", { tabId: detail.resultTabId, selector: "#receipt:not(:empty)", timeoutMs: 10000 });
    await text("receipt", detail.resultTabId, "#receipt", value => { assert.deepEqual(value, { ok: true, ...detail.instructions, documentToken: detail.documentBefore.documentToken, receiptId: value.receiptId }); assert.ok(typeof value.receiptId === "string" && value.receiptId); detail.receipt = value; });
    let downloadDeadline = performance.now() + 15000;
    await call("download-prepared", "expectDownload", { tabId: detail.resultTabId, timeoutMs: 15000 }, value => { detail.downloadWait = clone(ack(value)); downloadDeadline = Math.min(downloadDeadline, performance.now() + value.remainingMs); });
    await call("download-clicked", "click", { tabId: detail.resultTabId, name: "Download original report", timeoutMs: Math.min(5000, remaining(downloadDeadline)) });
    remaining(downloadDeadline);
    await call("download-collected", "collectDownload", {}, value => { assert.ok(typeof value.downloadId === "string" && value.downloadId); detail.downloadId = value.downloadId; });
    await call("download-path", "downloadPath", { timeoutMs: 10000 }, value => { assert.ok(typeof value === "string" && path.isAbsolute(value)); detail.productPath = value; });
    await step("download-file", {}, () => readManagedWorkflowFile({ downloadRoot, productPath: detail.productPath, receipt: detail.receipt, artifactDir, taskId }), value => { detail.file = value; });
    await call("download-cancelled", "cancelDownload", {}, () => { downloadCancelled = true; detail.downloadWait.cancelled = true; });
    await text("document-after", detail.resultTabId, "#state", value => {
      assert.equal(value.documentToken, detail.documentBefore.documentToken); assert.equal(value.taskId, taskId); assert.equal(value.error, null);
      assert.deepEqual(value.submits, [{ trusted: true, submitter: "submit-task" }]); assert.deepEqual(value.downloads, [{ trusted: true, button: 0 }]);
      assert.ok(value.inputs.length >= 3 && value.inputs.every(input => input.trusted === true)); detail.documentAfter = value;
    });
    await text("source-state", detail.sourceTabId, "#state", value => { assert.equal(value.taskId, taskId); assert.equal(value.opened, true); assert.deepEqual(value.clicks, [{ trusted: true, button: 0, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false }]); detail.sourceState = value; });
    await call("tabs-before-finalize", "tabs", {}, value => {
      assert.ok(Array.isArray(value)); assert.deepEqual(value.map(tab => tab.id).sort((a,b) => a-b), [detail.sourceTabId, detail.resultTabId].sort((a,b) => a-b));
      assert.equal(value.find(tab => tab.id === detail.sourceTabId).url, detail.sourceURL); assert.equal(value.find(tab => tab.id === detail.resultTabId).url, detail.resultURL); detail.tabsBefore = value;
    });
    await call("finalize", "finalize", { keep: [{ tabId: detail.resultTabId, status: "deliverable" }] }, value => {
      detail.finalize = clone(value); endedControl(value); assert.equal(value.endedTurnId, detail.scope.turn_id); assert.ok(value.controlEpoch > detail.scope.control_epoch);
      detail.keptTabIds = [detail.resultTabId]; detail.closedTabIds = [detail.sourceTabId]; detail.kept = [{ tabId: detail.resultTabId, url: detail.resultURL }];
    });
    await call("tabs-after-finalize", "tabs", {}, value => { assert.deepEqual(value, []); detail.tabsAfter = value; });
  } catch (error) { failure = error; detail.error = describe(error); detail.failedStage = detail.trace.at(-1)?.name ?? "adapter"; }
  finally {
    for (const [needed, name, op, target] of [[detail.pageWait && !pageCancelled, "page-cleanup", "cancelPage", detail.pageWait], [detail.downloadWait && !downloadCancelled, "download-cleanup", "cancelDownload", detail.downloadWait]]) {
      if (adapter && needed) try { await call(name, op, {}, () => { target.cancelled = true; }, true); } catch (error) { target.cleanupError = describe(error); failure ??= error; }
    }
    if (adapter) {
      detail.clientClose.attempted = true;
      try { await step("close", {}, () => adapter.close(), () => { detail.clientClose.ok = true; }, true); }
      catch (error) { detail.clientClose.error = describe(error); failure ??= error; }
    }
  }
  detail.completedAt = Date.now();
  if (failure) { detail.error ??= describe(failure); detail.failedStage ??= detail.trace.find(entry => !entry.ok)?.name ?? "unknown"; failure.managedWorkflowDetail = detail; throw failure; }
  detail.ok = true; return detail;
}
