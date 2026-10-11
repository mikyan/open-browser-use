import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once, EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { Transform, PassThrough } from "node:stream";
import test from "node:test";
import vm from "node:vm";

// Test the actual launcher helpers without importing the browser-launching
// module. Unique boundary checks make source movement fail explicitly.
const source = await fs.readFile(new URL("./run.mjs", import.meta.url), "utf8");
function actualFunction(startMarker, endMarker, context) {
  assert.equal(source.split(startMarker).length, 2, "Start anchor must be unique");
  assert.equal(source.split(endMarker).length, 2, "End anchor must be unique");
  const start = source.indexOf(startMarker), end = source.indexOf(endMarker, start);
  assert.ok(end > start, "Helper boundaries changed");
  const declaration = source.slice(start, end).trim();
  assert.ok(declaration.endsWith("\n}"), "Only the intended helper may occur between anchors");
  return new vm.Script(`(${declaration})`, { filename: `run.mjs#${startMarker}` }).runInNewContext({ setTimeout, clearTimeout, ...context });
}
const subprocess = spawnImpl => actualFunction("function subprocess(command, args,", "\nasync function hashTree(root,", { spawn: spawnImpl });

// Keep the real child's bytes and lifecycle, but feed its output through
// one-byte chunks. This deterministically splits every multibyte sequence.
function splitOutput(child) {
  for (const name of ["stdout", "stderr"]) {
    const pipe = child[name];
    const split = new Transform({ transform(chunk, _encoding, callback) {
      for (const byte of chunk) this.push(Buffer.from([byte]));
      callback();
    } });
    pipe.pipe(split); child[name] = split;
  }
  return child;
}

test("actual subprocess preserves split Chinese, emoji and literal U+FFFD in stdout and stderr", { timeout: 10000 }, async () => {
  const value = "表单回执 林晓🧪 / 保留此值 / 🚀 / �";
  const run = subprocess((...args) => splitOutput(spawn(...args)));
  const result = await run(process.execPath, ["-e", `process.stdout.write(${JSON.stringify(value)})`]);
  assert.equal(result, value);
  await assert.rejects(run(process.execPath, ["-e", `process.stderr.write(${JSON.stringify(value)});process.exitCode=7`]), error => {
    assert.ok(error.message.endsWith(`exited 7: ${value}`)); return true;
  });
});

test("actual subprocess waits for buffered stdout to drain after the child exits", { timeout: 10000 }, async () => {
  let child, exited, closed;
  const run = subprocess((...args) => {
    child = spawn(...args); exited = once(child, "exit"); closed = once(child, "close");
    child.stdout.pause(); return child;
  });
  const tail = "收据尾部🧪🚀".repeat(32);
  let settled = false;
  const task = run(process.execPath, ["-e", `process.stdout.write(${JSON.stringify(tail)})`], { timeoutMs: 5000 });
  task.then(() => { settled = true; }, () => { settled = true; });
  try {
    await exited;
    assert.equal(settled, false, "An exit event is not evidence that output pipes are empty");
    child.stdout.resume();
    assert.equal(await task, tail);
    await closed;
  } finally {
    // Always release the test's read backpressure, including on assertion failure.
    child.stdout.resume();
    await task.catch(() => {});
    await closed;
  }
});

test("subprocess timeout still rejects and terminates its own child", { timeout: 10000 }, async () => {
  let child, closed;
  const run = subprocess((...args) => { child = spawn(...args); closed = once(child, "close"); return child; });
  await assert.rejects(run(process.execPath, ["-e", "setInterval(()=>{},1000)"], { timeoutMs: 30 }), /exceeded test deadline/);
  await closed;
  assert.equal(child.killed, true);
});

test("actual MCP line reader preserves split multibyte response payloads", { timeout: 10000 }, async () => {
  const text = "林晓🧪 · 研发二组 · �";
  const program = `const readline=require('node:readline');readline.createInterface({input:process.stdin}).on('line',line=>{
    const request=JSON.parse(line);if(request.id===undefined)return;
    const result=request.method==='initialize'?{protocolVersion:'2025-06-18'}:{isError:false,structuredContent:{result:{text:${JSON.stringify(text)}}}};
    process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\\n');
  });`;
  let child;
  const useMCP = actualFunction("async function withMCPClient(executable, endpoint, sessionId, use,", "\nasync function workerConnection(url)", {
    assert, path, delay: ms => new Promise(resolve => setTimeout(resolve, ms)),
    spawn: (_command, _args, options) => { child = splitOutput(spawn(process.execPath, ["-e", program], options)); return child; }
  });
  const processEvidence = {};
  const result = await useMCP(process.execPath, "unused", "synthetic", call => call("browserAction", {}), processEvidence);
  assert.equal(result.text, text);
  assert.equal(child.exitCode, 0);
  assert.equal(processEvidence.closeObserved, true);
  assert.equal(processEvidence.exitCode, 0);
});

test("subprocess evidence distinguishes timeout/kill/exit from actual close without changing original rejection", async () => {
  const child = new EventEmitter(), evidence = {}; let kills = 0;
  Object.assign(child, { pid: 42, stdout: new PassThrough(), stderr: new PassThrough(), stdin: { end() {} }, kill() { kills++; return true; } });
  const run = subprocess((_command, _args, options) => { assert.equal(options.processEvidence, undefined); return child; });
  await assert.rejects(run("test-child", [], { timeoutMs: 10, processEvidence: evidence }), /exceeded test deadline/);
  assert.equal(kills, 1); assert.equal(evidence.closeObserved, false); assert.ok(evidence.terminationRequestedAt);
  child.emit("exit", null, "SIGTERM"); assert.equal(evidence.closeObserved, false);
  child.emit("close", null, "SIGTERM"); assert.equal(evidence.closeObserved, true); assert.equal(evidence.signal, "SIGTERM");
  const error = Object.freeze(new Error("spawn failed")), failed = {};
  await assert.rejects(subprocess(() => { throw error; })("test-child", [], { processEvidence: failed }), value => value === error);
  assert.equal(failed.closeObserved, false);
});

test("MCP shutdown signal is not promoted to confirmed close and preserves a frozen callback error", async () => {
  const child = new EventEmitter(), evidence = {}, original = Object.freeze(new Error("original callback failed")); let kills = 0;
  Object.assign(child, { pid: 42, stdout: new PassThrough(), stderr: new PassThrough(), stdin: {
    write(line) { const request = JSON.parse(line); if (request.id !== undefined) queueMicrotask(() => child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2025-06-18" } }) + "\n")); }, end() {}
  }, kill() { kills++; return true; } });
  const useMCP = actualFunction("async function withMCPClient(executable, endpoint, sessionId, use,", "\nasync function workerConnection(url)", { assert, path, delay: () => Promise.resolve(), spawn: () => child });
  await assert.rejects(useMCP("test-child", "unused", "synthetic", () => { throw original; }, evidence), value => value === original);
  assert.equal(kills, 1); assert.equal(evidence.closeObserved, false); assert.ok(evidence.terminationRequestedAt);
  child.emit("exit", null, "SIGTERM"); assert.equal(evidence.closeObserved, false);
  child.emit("close", null, "SIGTERM"); assert.equal(evidence.closeObserved, true);
});
