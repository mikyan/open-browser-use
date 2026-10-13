import assert from "node:assert/strict";
import path from "node:path";
import { spawn } from "node:child_process";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { createChooserConvenienceCaller, checkChooserConvenienceProcesses, readChooserConvenienceClear, checkChooserConvenienceClear, checkChooserConvenienceScope } from "./chooser-convenience-fixture.mjs";

const scope = { session_id: "original-owner", turn_id: "original-turn", control_epoch: 7 };
const files = ["C:/fixture/original 中文.txt", "C:/fixture/two.dat"];
const params = selected => ({ ...scope, fileChooserId: "original-chooser", files: selected });
function adapter(kind, options = {}) {
  const detail = { callerProcesses: [], convenienceCalls: [] }, calls = [], tools = [], children = [];
  const base = { kind, role: "owner", executable: "fixture/obu.exe", endpoint: "original-endpoint", sessionId: scope.session_id, detail,
    call: async (method, args) => { calls.push({ method, args: structuredClone(args) }); return { original: true }; },
    tool: async (name, args) => { tools.push({ name, args: structuredClone(args) }); return { isError: false, structuredContent: { result: { accepted: true } } }; },
    subprocess: async (command, args, { processEvidence }) => {
      children.push({ command, args: [...args], processEvidence });
      Object.assign(processEvidence, { pid: 101 + children.length, startedAt: 1, closedAt: 2, closeObserved: true, exitCode: 0, signal: null });
      return JSON.stringify({ result: { accepted: true } });
    } };
  return { detail, calls, tools, children, call: createChooserConvenienceCaller({ ...base, ...options }), base };
}

test("CLI convenience setter uses repeated --file and explicit --clear, never raw call", async () => {
  const f = adapter("cli");
  for (const selected of [files, []]) assert.deepEqual(await f.call("setFileChooserFiles", params(selected)), { accepted: true });
  assert.equal(f.calls.length, 0); assert.equal(f.tools.length, 0); assert.equal(f.children.length, 2);
  for (const [index, child] of f.children.entries()) {
    assert.equal(child.command, path.resolve("fixture/obu.exe"));
    assert.deepEqual(child.args, ["set-file-chooser-files", "--socket", "original-endpoint", "--session-id", scope.session_id, "--file-chooser-id", "original-chooser",
      ...(index === 0 ? files.flatMap(file => ["--file", file]) : ["--clear"]), "--timeout", "15s"]);
    const record = f.detail.convenienceCalls[index]; assert.deepEqual(record.argv, child.args); assert.deepEqual(record.sourceParams, params(index === 0 ? files : []));
    assert.equal(record.processIndex, index); assert.equal(record.passed, true); assert.deepEqual(record.response, { result: { accepted: true } });
  }
});

test("MCP setter uses the dedicated tool with explicit empty array and retains the exact result", async () => {
  const f = adapter("mcp");
  for (const selected of [files, []]) assert.deepEqual(await f.call("setFileChooserFiles", params(selected)), { accepted: true });
  assert.deepEqual(f.tools, [{ name: "set_file_chooser_files", args: { file_chooser_id: "original-chooser", files } },
    { name: "set_file_chooser_files", args: { file_chooser_id: "original-chooser", files: [] } }]);
  assert.equal(f.children.length, 0); assert.equal(f.calls.length, 0);
  for (const [index, record] of f.detail.convenienceCalls.entries()) {
    assert.equal(record.tool, "set_file_chooser_files"); assert.deepEqual(record.arguments, f.tools[index].args);
    assert.equal(record.response.isError, false); assert.equal(record.passed, true);
  }
});

test("ready/click/collect/cancel retain generic plumbing, captured scope and 15s transport", async () => {
  for (const kind of ["cli", "mcp"]) {
    const f = adapter(kind, { role: "trigger" }), original = { ...scope, tabId: 42, waiterId: "original-waiter", timeoutMs: 10000 };
    for (const method of ["armFileChooserWait", "browserAction", "collectFileChooserWait", "cancelFileChooserWait"]) await f.call(method, original);
    assert.equal(f.detail.convenienceCalls.length, 0); assert.equal(f.tools.length, 0);
    if (kind === "mcp") assert.deepEqual(f.calls.map(call => call.args), Array.from({ length: 4 }, () => original));
    else for (const child of f.children) {
      assert.equal(child.args[0], "call"); assert.deepEqual(JSON.parse(child.args[child.args.indexOf("--params") + 1]), original);
      assert.deepEqual(child.args.slice(-2), ["--timeout", "15s"]); assert.equal(child.processEvidence.role, "trigger");
    }
  }
});

test("missing/null files, wrong connection and failed convenience tool never fall back to raw setter", async () => {
  for (const kind of ["cli", "mcp"]) {
    for (const selected of [undefined, null, [""], [null]]) {
      const f = adapter(kind); await assert.rejects(f.call("setFileChooserFiles", params(selected)));
      assert.equal(f.children.length + f.tools.length + f.calls.length, 0);
    }
    const f = adapter(kind, { role: "trigger" }); await assert.rejects(f.call("setFileChooserFiles", params([]))); assert.equal(f.calls.length, 0);
  }
  for (const response of [{ isError: true, content: [{ type: "text", text: "original failure" }] }, { isError: false, structuredContent: { error: { message: "native failure" } } }, { isError: false, structuredContent: {} }]) {
    let sent = 0; const f = adapter("mcp", { tool: async () => { sent++; return response; } });
    await assert.rejects(f.call("setFileChooserFiles", params([]))); assert.equal(sent, 1); assert.equal(f.calls.length, 0);
    assert.equal(f.detail.convenienceCalls[0].passed, false); assert.deepEqual(f.detail.convenienceCalls[0].response, response);
  }
});

test("process proof accepts actual close events and rejects callback-only, signaled or reused MCP process evidence", async () => {
  const processes = [];
  await Promise.all(["owner", "trigger"].map(role => new Promise((resolve, reject) => {
    const evidence = { role, startedAt: Date.now(), closeObserved: false }; processes.push(evidence);
    const child = spawn(process.execPath, ["-e", "process.stdout.write('original response');"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    evidence.pid = child.pid; child.on("error", reject); child.stdout.resume(); child.stderr.resume();
    child.once("close", (exitCode, signal) => { Object.assign(evidence, { closeObserved: true, closedAt: Date.now(), exitCode, signal }); resolve(); });
  })));
  checkChooserConvenienceProcesses(processes, "mcp"); checkChooserConvenienceProcesses(processes, "cli");
  for (const mutate of [
    value => { value[0].closeObserved = false; }, value => { value[0].exitCode = 1; }, value => { value[0].signal = "SIGTERM"; },
    value => { value[0].terminationRequestedAt = Date.now(); }, value => { value[0].spawnError = "spawn failed"; },
    value => { value[0].closedAt = value[0].startedAt - 1; }, value => { value[0].pid = value[1].pid; }, value => { value[0].role = "trigger"; }
  ]) { const invalid = structuredClone(processes); mutate(invalid); assert.throws(() => checkChooserConvenienceProcesses(invalid, "mcp")); }
  assert.throws(() => checkChooserConvenienceProcesses([], "cli"));
});

test("clear proof independently reads actual file input on the original native document without mutation", () => {
  const href = "http://localhost:1234/chooser-waits/frame?key=mcp-convenience-chooser-oopif&variant=oopif";
  const input = { id: "upload", type: "file", isConnected: true, files: [], value: "" };
  const evidence = { documentToken: "original-document-token", clicks: [{ trusted: true }, { trusted: true }], changes: [{ trusted: true, count: 2 }, { trusted: false, count: 0 }] };
  const result = structuredClone(runInNewContext(`(${readChooserConvenienceClear.toString()})()`, { document: { querySelector(selector) { assert.equal(selector, "#upload"); return input; } }, location: { href }, chooserEvidence: evidence }));
  const post = { href, ...evidence }, item = { server: { posts: [{}, post] }, frames: { frames: [{ frameId: 7, documentId: "native-original", documentLifecycle: "active", errorOccurred: false, url: href }] } };
  const results = [{ frameId: 7, documentId: "native-original", result }];
  assert.equal(checkChooserConvenienceClear(item, results).filesLength, 0); assert.deepEqual(input.files, []); assert.equal(input.value, "");
  for (const mutate of [
    value => { value[0].documentId = "replacement"; }, value => { value[0].frameId = 8; }, value => { value[0].result.documentToken = "replacement"; },
    value => { value[0].result.input.filesLength = 1; }, value => { value[0].result.input.value = "C:/fakepath/original.txt"; },
    value => { value[0].result.input.connected = false; }, value => { value[0].result.input.type = "text"; },
    value => { value[0].result.clicks.push({ trusted: true }); }, value => { value[0].result.changes[1].trusted = true; }
  ]) { const invalid = structuredClone(results); mutate(invalid); assert.throws(() => checkChooserConvenienceClear(item, invalid)); }
});

test("lazy bootstrap uses the first original newTab scope and rejects later variant or owner changes", () => {
  // Both en3ccC convenience workflows completed with their native admitted
  // epoch while the pre-newTab SDK owner still began with control_epoch:null.
  const initial = { ...scope, control_epoch: null }, variants = ["root", "oopif", "dynamic-oopif"].map(variant => ({ variant, scope: { ...scope } }));
  assert.deepEqual(checkChooserConvenienceScope(initial, variants, scope), scope);
  assert.equal(initial.control_epoch, null, "Do not rewrite pre-bootstrap evidence");
  assert.deepEqual(checkChooserConvenienceScope(scope, variants, scope), scope);
  for (const mutate of [
    value => { value.initial.session_id = "different-owner"; }, value => { value.initial.turn_id = "different-turn"; },
    value => { value.initial.control_epoch = scope.control_epoch - 1; },
    value => { value.variants[1].scope.control_epoch++; }, value => { value.variants[2].scope.turn_id = "replacement"; },
    value => { value.variants[0].scope.control_epoch = null; }, value => { value.variants[0].scope.control_epoch = 0; },
    value => { value.variants[0].scope.control_epoch = 1.5; }, value => { value.variants = []; },
    value => { value.current.control_epoch++; }, value => { value.current.control_epoch = null; }, value => { value.current.session_id = "replacement"; }
  ]) {
    const invalid = structuredClone({ initial, variants, current: scope }); mutate(invalid);
    assert.throws(() => checkChooserConvenienceScope(invalid.initial, invalid.variants, invalid.current));
  }
});
