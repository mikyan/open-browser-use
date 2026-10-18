import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { runManagedWorkflowCaller, readManagedWorkflowFile } from "./managed-workflow-callers.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url)), repo = path.resolve(directory, "../..");
const sdkJSPath = path.join(repo, "packages/open-browser-use-js/dist/index.js");
const python = process.env.OBU_WORKFLOW_PYTHON || process.env.PYTHON || (process.platform === "win32" ? "python" : "python3");
const { encodeFrame } = await import(new URL("../../packages/open-browser-use-js/dist/index.js", import.meta.url));

// Real SDK and subprocess transports against a deterministic fake IPC backend.
// These tests prove harness contracts, never native input or browser behavior.
async function setup(t, kind, fail = "") {
  const temporary = await fs.realpath(path.join(repo, ".tmp"));
  const root = await fs.mkdtemp(path.join(temporary, "managed-workflow-unit-"));
  const artifactDir = path.join(root, "artifacts"), downloadRoot = path.join(root, "downloads");
  await fs.mkdir(artifactDir); await fs.mkdir(downloadRoot);
  const taskId = `unit-${kind}`, baseURL = "http://127.0.0.1:54321/", endpoint = process.platform === "win32" ? `\\\\.\\pipe\\managed-workflow-${randomUUID()}` : path.join(root, "test.sock");
  const sourceURL = `${baseURL}managed-workflow/${taskId}/source`, resultURL = `${baseURL}managed-workflow/${taskId}/child`;
  const instructions = { taskId, reference: "REF-unit", amount: "137.25", note: "Reviewed 原始报表" };
  const receipt = { ok: true, ...instructions, documentToken: "original-document", receiptId: "original-receipt" };
  const calls = [], sockets = new Set(), state = { taskId, documentToken: "original-document", submits: [], downloads: [], inputs: [], error: null };
  let opened = false, submitted = false, downloaded = false, finalized = false;
  const productPath = path.join(downloadRoot, "original.json");
  const handler = async ({ method, params }) => {
    if (method === "getInfo") return { metadata: { turnLifecycleVersion: 1, backgroundWindowVersion: 1, pageWaitVersion: 1, downloadWaitVersion: 1, downloadWaitPathVersion: 1, directDownloadsVersion: 1 } };
    if (method === "getControlState") return { lifecycleVersion: 1, controlEpoch: 7, nextTurnId: "original-turn", closing: false };
    assert.equal(params.session_id, `managed-workflow-${taskId}`); assert.equal(params.control_epoch, finalized ? 8 : 7); assert.equal(params.turn_id, finalized ? "next-turn" : "original-turn");
    if (method === "createTab") { assert.equal(params.backgroundWindow, true); return { id: 10 }; }
    if (method === "armPageWait") { assert.equal(params.tabId, 10); return { waiterId: "original-page-wait", remainingMs: 14000 }; }
    if (method === "collectPageWait") { assert.equal(opened, true); assert.equal(params.waiterId, "original-page-wait"); return { tabId: 11 }; }
    if (method === "cancelPageWait") { assert.equal(params.waiterId, "original-page-wait"); return {}; }
    if (method === "armDownloadWait") { assert.equal(submitted, true); assert.equal(params.tabId, 11); assert.equal(params.requirePath, true); return { waiterId: "original-download-wait", remainingMs: 14000 }; }
    if (method === "collectDownloadWait") { assert.equal(downloaded, true); if (fail === "collect") throw Error("injected collect outcome unknown"); return { downloadId: "original-download" }; }
    if (method === "downloadPath") { assert.equal(params.downloadId, "original-download"); return { path: productPath }; }
    if (method === "cancelDownloadWait") { assert.equal(params.waiterId, "original-download-wait"); return {}; }
    if (method === "getTabs") return finalized ? [] : [{ id: 10, url: sourceURL }, { id: 11, url: resultURL }];
    if (method === "finalizeTabs") { assert.deepEqual(params.keep, [{ tabId: 11, status: "deliverable" }]); if (fail === "finalize") throw Error("injected finalize outcome unknown"); finalized = true; return { lifecycleVersion: 1, endedTurnId: "original-turn", nextTurnId: "next-turn", controlEpoch: 8 }; }
    assert.equal(method, "browserAction"); let value = null;
    const { action, locator = [], args = {} } = params, selected = locator.at(-1);
    if (action === "goto") { assert.equal(params.tabId, 10); assert.equal(args.url, sourceURL); }
    else if (action === "snapshot") value = "- heading \"Review original report\"";
    else if (action === "fill") { state.inputs.push({ name: selected.selector, value: args.value, trusted: true }); }
    else if (action === "waitFor") { assert.equal(selected.selector, "#receipt:not(:empty)"); assert.equal(submitted, true); }
    else if (action === "click") {
      assert.equal(selected.kind, "role"); assert.equal(selected.exact, true); assert.deepEqual(args, {});
      if (selected.name === "Open task form") { assert.equal(opened, false); opened = true; }
      else if (selected.name === "Submit task once") { assert.equal(submitted, false); submitted = true; state.submits.push({ trusted: true, submitter: "submit-task" }); if (fail === "submit") throw Error("injected POST outcome unknown"); }
      else { assert.equal(selected.name, "Download original report"); assert.equal(downloaded, false); downloaded = true; state.downloads.push({ trusted: true, button: 0 }); await fs.writeFile(productPath, JSON.stringify(receipt) + "\n", { flag: "wx" }); }
    } else if (action === "textContent") {
      if (selected.selector === "#instructions") value = JSON.stringify(instructions);
      else if (selected.selector === "#receipt") value = JSON.stringify(receipt);
      else if (params.tabId === 11) value = JSON.stringify(state);
      else value = JSON.stringify({ taskId, opened, clicks: [{ trusted: true, button: 0, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false }] });
    } else throw Error(`Unknown mock action ${action}`);
    return { value, engine: { name: "playwright-crx", version: "0.15.0", playwrightVersion: "1.53.0" } };
  };
  const server = createServer(socket => {
    sockets.add(socket); socket.on("error", () => {}); socket.on("close", () => sockets.delete(socket)); let buffer = Buffer.alloc(0), queue = Promise.resolve();
    socket.on("data", chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const size = buffer.readUInt32LE(); if (buffer.length < size + 4) break;
        const request = JSON.parse(buffer.subarray(4, size + 4)); buffer = buffer.subarray(size + 4); calls.push(request);
        queue = queue.then(async () => { let result; try { result = { result: await handler(request) }; } catch (error) { result = { error: { code: -32000, message: error.message } }; } socket.write(encodeFrame({ jsonrpc: "2.0", id: request.id, ...result })); });
      }
    });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(endpoint, resolve); });
  t.after(async () => {
    for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve));
    const actual = await fs.realpath(root); assert.equal(path.dirname(actual), temporary); assert.equal(actual, root); await fs.rm(actual, { recursive: true });
  });
  const options = { kind, taskId, baseURL, socketPath: endpoint, root, name: "unit-managed", binary: "unit-binary", artifactDir, downloadRoot, sdkJSPath,
    python, pythonPackageDir: path.join(repo, "packages/open-browser-use-python"), goHelperBinary: process.env.OBU_WORKFLOW_GO_HELPER, timeoutMs: 60000 };
  if (["cli", "mcp"].includes(kind)) options.spawnProcess = (_command, args, settings) => spawn(process.execPath, [path.join(directory, "managed-workflow-entry-double.mjs"), ...args], { ...settings, env: { ...process.env, OBU_WORKFLOW_ENTRY_DOUBLE: JSON.stringify({ endpoint, name: options.name, root, sessionId: `managed-workflow-${taskId}` }) } });
  return { options, calls, receipt, productPath };
}

const kinds = ["js", "python", "go", "cli", "mcp"];
for (const kind of kinds) {
  const skip = kind === "go" && !process.env.OBU_WORKFLOW_GO_HELPER ? "Set OBU_WORKFLOW_GO_HELPER to the compiled helper; scripts/ci.sh always builds it" : false;
  test(`${kind}: complete public transport workflow retains exact scope, file and finalize`, { skip }, async t => {
    const { options, calls, receipt } = await setup(t, kind), callbacks = [];
    const result = await runManagedWorkflowCaller({ ...options, onStep: async (name, { detail }) => { callbacks.push(name); if (name === "receipt") assert.deepEqual(detail.receipt, receipt); } });
    assert.equal(result.ok, true); assert.deepEqual(result.receipt, receipt); assert.deepEqual(result.keptTabIds, [11]); assert.deepEqual(result.closedTabIds, [10]);
    assert.equal(await fs.readFile(result.file.artifactPath, "utf8"), JSON.stringify(receipt) + "\n"); assert.ok(result.file.identity.ino);
    for (const record of result.callerProcesses) { assert.equal(record.exitObserved, true); assert.equal(record.closeObserved, true); assert.equal(record.exitCode, 0); }
    assert.equal(calls.filter(call => call.method === "createTab").length, 1); assert.equal(calls.filter(call => call.method === "finalizeTabs").length, 1);
    assert.equal(calls.filter(call => call.method === "browserAction" && call.params.action === "click").length, 3);
    assert.ok(callbacks.indexOf("page-prepared") < callbacks.indexOf("open-clicked")); assert.ok(callbacks.indexOf("download-prepared") < callbacks.indexOf("download-clicked"));
  });
  test(`${kind}: unknown submit result stops without replay, download or fallback finalize`, { skip }, async t => {
    const { options, calls } = await setup(t, kind, "submit"); let outcome;
    await assert.rejects(runManagedWorkflowCaller(options), error => { outcome = error.managedWorkflowDetail; return /outcome unknown|process exited/.test(error.message); });
    assert.equal(outcome.ok, false); assert.equal(outcome.failedStage, "submit-clicked");
    assert.equal(calls.filter(call => call.method === "browserAction" && call.params.locator?.[0]?.name === "Submit task once").length, 1);
    assert.equal(calls.some(call => ["armDownloadWait", "finalizeTabs"].includes(call.method)), false);
    for (const record of outcome.callerProcesses) { assert.equal(record.exitObserved, true); assert.equal(record.closeObserved, true); }
    if (["python", "go"].includes(kind)) assert.equal(outcome.callerProcesses[0].exitCode, 1);
  });
}

test("collection failure cancels only original wait and never repeats download or finalization", async t => {
  const { options, calls } = await setup(t, "js", "collect");
  await assert.rejects(runManagedWorkflowCaller(options), /outcome unknown/);
  assert.equal(calls.filter(call => call.method === "collectDownloadWait").length, 1); assert.equal(calls.filter(call => call.method === "cancelDownloadWait").length, 1);
  assert.equal(calls.some(call => ["cancelDownload", "downloadURL", "finalizeTabs"].includes(call.method)), false);
});

test("uncertain finalize is recorded once and never followed by fallback finalization", async t => {
  const { options, calls } = await setup(t, "js", "finalize"); let outcome;
  await assert.rejects(runManagedWorkflowCaller(options), error => { outcome = error.managedWorkflowDetail; return /finalize outcome unknown/.test(error.message); });
  assert.equal(outcome.failedStage, "finalize"); assert.equal(calls.filter(call => call.method === "finalizeTabs").length, 1);
  assert.equal(outcome.keptTabIds, undefined); assert.equal(outcome.file.analysis.receiptId, "original-receipt");
});

test("observer callback is awaited and failure stops after original receipt without download", async t => {
  const { options, calls } = await setup(t, "js"); let observed = false;
  await assert.rejects(runManagedWorkflowCaller({ ...options, onStep: async name => {
    if (name === "receipt") { await new Promise(resolve => setTimeout(resolve, 20)); observed = true; throw Error("observer unavailable"); }
  } }), /observer unavailable/);
  assert.equal(observed, true); assert.equal(calls.some(call => ["armDownloadWait", "finalizeTabs"].includes(call.method)), false);
});

test("remaining workflow budget narrows the next native action timeout", async t => {
  const { options, calls } = await setup(t, "js");
  await assert.rejects(runManagedWorkflowCaller({ ...options, timeoutMs: 1200, onStep: async name => {
    if (name === "source-created") await new Promise(resolve => setTimeout(resolve, 900));
    if (name === "source-navigated") throw Error("test ends at bounded navigation");
  } }), /test ends/);
  const goto = calls.find(call => call.method === "browserAction" && call.params.action === "goto");
  assert.ok(goto.params.timeoutMs > 0 && goto.params.timeoutMs < 500);
  assert.equal(calls.some(call => call.method === "armPageWait"), false);
});

test("file proof rejects unknown bytes and does not overwrite a prior artifact", async t => {
  const { options, receipt, productPath } = await setup(t, "js");
  await fs.writeFile(productPath, "unrelated private content", { flag: "wx" });
  const params = { ...options, productPath, receipt };
  await assert.rejects(readManagedWorkflowFile(params), /do not match/); assert.deepEqual(await fs.readdir(options.artifactDir), []);
  await fs.writeFile(productPath, JSON.stringify(receipt) + "\n");
  const file = await readManagedWorkflowFile(params); await assert.rejects(readManagedWorkflowFile(params), /EEXIST/);
  assert.equal(await fs.readFile(file.artifactPath, "utf8"), JSON.stringify(receipt) + "\n");
});
