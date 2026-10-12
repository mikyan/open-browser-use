import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runOriginalDownloadCaller, runOriginalDownloadProcess } from "./original-download-callers.mjs";

const mock = String.raw`
const fs=require('node:fs'),readline=require('node:readline');
const args=process.argv.slice(2), mode=process.env.TEST_CALLER_MODE;
function invoke(method,params){
 fs.appendFileSync(process.env.TEST_CALLER_LOG,JSON.stringify({method,params,pid:process.pid})+'\n');
 if(method==='browserAction'&&mode==='hang-click'){setInterval(()=>{},1000);return null}
 if(method==='browserAction'&&mode==='fail-click')return {error:{message:'ORIGINAL_CLICK_ERROR'}};
 if(method==='cancelDownloadWait'&&mode==='fail-click')return {error:{message:'SECONDARY_CLEANUP_ERROR'}};
 if(method==='collectDownloadWait'&&mode==='fail-collect')return {error:{message:'ORIGINAL_COLLECT_ERROR'}};
 if(method==='browserAction'&&mode==='slow-add')Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,180);
 if(method==='browserAction'&&mode.startsWith('budget-')){
   const add=params.locator.at(-1).name==='Add download frame';
   const readyAfter=mode==='budget-second'?(add?200:800):500;
   Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,Math.min(readyAfter,params.timeoutMs));
   if(params.timeoutMs<readyAfter)return {error:{message:'MOCK_ACTION_EXPIRED_WITHOUT_INPUT'}};
   fs.appendFileSync(process.env.TEST_CALLER_INPUT_LOG,JSON.stringify({add,timeoutMs:params.timeoutMs})+'\n');
 }
 switch(method){
 case 'armDownloadWait':return {result:{waiterId:'original-waiter',remainingMs:mode==='budget-second'?1000:mode.startsWith('budget-')?600:['short-wait','slow-add'].includes(mode)?120:14900}};
 case 'browserAction':return {result:{engine:{name:'playwright-crx'},value:null}};
 case 'collectDownloadWait':return {result:{downloadId:'original-guid'}};
 case 'downloadPath':return {result:{path:mode==='missing-file'?process.env.TEST_CALLER_PATH+'.missing':process.env.TEST_CALLER_PATH}};
 case 'cancelDownloadWait':return {result:mode==='bad-cancel'?{cancelled:true}:{}};
 default:throw Error('Unexpected browser method '+method);
 }
}
function emit(value){process.stdout.write(JSON.stringify(value)+'\n')}
if(args[0]==='call'){
 const at=name=>args[args.indexOf(name)+1];
 const result=invoke(at('--method'),JSON.parse(at('--params')));
 if(result)emit({jsonrpc:'2.0',id:'mock-cli',...result});
}else if(args[0]==='mcp'){
 const input=readline.createInterface({input:process.stdin});
 input.on('line',line=>{
 const request=JSON.parse(line);
 if(request.method==='initialize'){emit({jsonrpc:'2.0',id:request.id,result:{protocolVersion:mode==='bad-init'?'wrong':'2025-06-18'}});return}
 if(request.method==='notifications/initialized')return;
 if(request.method!=='tools/call'||request.params.name!=='call')throw Error('Unexpected MCP request');
 const result=invoke(request.params.arguments.method,request.params.arguments.params);
 if(result)emit({jsonrpc:'2.0',id:request.id,result:{isError:false,structuredContent:{jsonrpc:'2.0',id:request.id,...result}}});
 });
}else throw Error('Unexpected executable arguments');
`;

async function fixture(t, { kind = "cli", variant = "root", mode = "", downloadKind = "post" } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "obu-original-caller-"));
  t.after(async () => {
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const script = path.join(directory, "mock.cjs"), log = path.join(directory, "calls.jsonl"), file = path.join(directory, "report.bin"), inputLog = path.join(directory, "input.jsonl");
  const analysis = { key: "original-key", kind: downloadKind, owner: "original-owner", nonce: "unique-original-nonce" };
  const bytes = Buffer.concat([Buffer.from(JSON.stringify(analysis) + "\n原始 UTF-8\n"), Buffer.from([0, 255, 195, 40, 128])]);
  await Promise.all([fs.writeFile(script, mock), fs.writeFile(file, bytes), fs.writeFile(log, ""), fs.writeFile(inputLog, "")]);
  const detail = {};
  return {
    detail, bytes, analysis,
    options: { kind, downloadKind, key: analysis.key, variant, executable: process.execPath, socketPath: "original-exact-endpoint", sessionId: "original-session", turnId: "original-turn", controlEpoch: 7, tabId: 42, detail,
      spawnProcess(command, args, options) {
        assert.equal(command, path.resolve(process.execPath)); assert.equal(options.windowsHide, true);
        return spawn(command, [script, ...args], { ...options, env: { ...process.env, TEST_CALLER_MODE: mode, TEST_CALLER_LOG: log, TEST_CALLER_PATH: file, TEST_CALLER_INPUT_LOG: inputLog } });
      } },
    calls: async () => (await fs.readFile(log, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line)),
    applied: async () => (await fs.readFile(inputLog, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line)),
  };
}

for (const kind of ["cli", "mcp"]) for (const variant of ["root", "oopif", "dynamic-oopif"]) {
  test(`${kind} ${variant} keeps exact scope, single trigger, raw file and actual child close`, async t => {
    const f = await fixture(t, { kind, variant, downloadKind: variant === "root" ? "post" : "blob" });
    const result = await runOriginalDownloadCaller(f.options), calls = await f.calls();
    assert.equal(result, f.detail); assert.equal(result.ok, true); assert.equal(result.kind, f.analysis.kind);
    assert.equal(result.caller, kind); assert.equal(result.waiterId, "original-waiter"); assert.equal(result.downloadId, "original-guid");
    assert.equal(result.waitCleanup.ok, true); assert.deepEqual(result.file.analysis, f.analysis);
    assert.deepEqual(Buffer.from(result.file.base64, "base64"), f.bytes);
    assert.equal(result.file.bytes, f.bytes.length); assert.equal(result.file.sha256, createHash("sha256").update(f.bytes).digest("hex"));
    assert.ok(result.readyAt <= result.triggerAt && result.triggerAt <= result.collectedAt);
    assert.deepEqual(calls.map(x => x.method), ["armDownloadWait", ...(variant === "dynamic-oopif" ? ["browserAction"] : []), "browserAction", "collectDownloadWait", "downloadPath", "cancelDownloadWait"]);
    for (const { params } of calls) assert.deepEqual([params.session_id, params.turn_id, params.control_epoch, params.tabId], ["original-session", "original-turn", 7, 42]);
    const actions = calls.filter(x => x.method === "browserAction"), trigger = actions.at(-1);
    assert.deepEqual(trigger.params.locator, [...(variant === "root" ? [] : [{ kind: "frame", selector: "#download-frame" }]), { kind: "role", role: "button", name: "Download original report", exact: true }]);
    if (variant === "dynamic-oopif") assert.equal(actions[0].params.locator[0].name, "Add download frame");
    assert.ok(result.callerProcesses.every(x => x.exitObserved && x.closeObserved && x.exitCode === 0 && x.closedAt <= result.completedAt));
    if (kind === "cli") {
      assert.equal(result.callerProcesses.length, calls.length);
      for (let i = 1; i < result.callerProcesses.length; i++) assert.ok(result.callerProcesses[i - 1].closedAt <= result.callerProcesses[i].startedAt);
    } else {
      assert.equal(result.callerProcesses.length, 1);
      const sent = result.callerProcesses[0].messages.filter(x => x.direction === "send");
      assert.deepEqual(sent.slice(0, 2).map(x => x.message.method), ["initialize", "notifications/initialized"]);
      assert.equal(sent.slice(2).length, calls.length);
      assert.ok(sent.slice(2).every(x => x.message.method === "tools/call" && x.message.params.name === "call"));
    }
  });
}

for (const kind of ["cli", "mcp"]) {
  for (const mode of ["budget-root", "budget-add", "budget-second"]) test(`${kind} ${mode} passes only the original remaining action budget to actual child`, async t => {
    const f = await fixture(t, { kind, variant: mode === "budget-root" ? "root" : "dynamic-oopif", mode });
    let originalError;
    try { await runOriginalDownloadCaller({ ...f.options, afterReady: () => new Promise(resolve => setTimeout(resolve, mode === "budget-second" ? 100 : 250)) }); }
    catch (error) { originalError = error; }
    // This real child models a backend which applies input only if the element
    // becomes ready inside the timeout parameter. It is not a browser event.
    const applied = await f.applied(), actions = (await f.calls()).filter(x => x.method === "browserAction");
    assert.equal(applied.length, mode === "budget-second" ? 1 : 0, "An overlong action timeout must not permit simulated input after original wait expiry");
    assert.match(originalError?.message ?? "", /MOCK_ACTION_EXPIRED_WITHOUT_INPUT/);
    assert.equal(f.detail.waitCleanup.ok, true); assert.ok(f.detail.callerProcesses.every(x => x.closeObserved));
    assert.ok(actions.every(x => Number.isSafeInteger(x.params.timeoutMs) && x.params.timeoutMs > 0 && x.params.timeoutMs < 1000));
    if (mode === "budget-second") { assert.equal(applied[0].add, true); assert.equal(actions.length, 2); assert.ok(actions[1].params.timeoutMs < actions[0].params.timeoutMs - 150); }
    else assert.equal(actions.length, 1);
  });
  test(`${kind} wall-clock rollback cannot revive original budget after dynamic frame ACK`, async t => {
    const f = await fixture(t, { kind, variant: "dynamic-oopif", mode: "slow-add" });
    const originalNow = Date.now;
    try {
      await assert.rejects(runOriginalDownloadCaller({ ...f.options, afterReady: async () => { t.mock.method(Date, "now", () => originalNow() - 60000); } }), /Original-download wait deadline exceeded/);
      assert.deepEqual((await f.calls()).map(x => x.method), ["armDownloadWait", "browserAction", "cancelDownloadWait"]);
      assert.equal(f.detail.triggerAt, undefined); assert.equal(f.detail.waitCleanup.ok, true);
    } finally { t.mock.restoreAll(); }
  });
  test(`${kind} dynamic frame ACK after original deadline cannot submit download-button input`, async t => {
    const f = await fixture(t, { kind, variant: "dynamic-oopif", mode: "slow-add" });
    await assert.rejects(runOriginalDownloadCaller(f.options), /Original-download wait deadline exceeded/);
    const calls = await f.calls();
    assert.deepEqual(calls.map(x => x.method), ["armDownloadWait", "browserAction", "cancelDownloadWait"]);
    assert.equal(calls[1].params.locator[0].name, "Add download frame");
    assert.equal(f.detail.triggerAt, undefined); assert.equal(f.detail.waitCleanup.ok, true);
    assert.ok(f.detail.callerProcesses.every(x => x.closeObserved));
  });
  test(`${kind} ready gate holds both dynamic-frame and original-button input until released`, async t => {
    const f = await fixture(t, { kind, variant: "dynamic-oopif" });
    let release, notify, gate;
    const reached = new Promise(resolve => { notify = resolve; });
    const hold = new Promise(resolve => { release = resolve; });
    const pending = runOriginalDownloadCaller({ ...f.options, afterReady: async ready => { gate = ready; notify(); await hold; } });
    try {
      await reached;
      assert.deepEqual(gate, { waiterId: "original-waiter", remainingMs: 14900, readyAt: f.detail.readyAt, scope: f.detail.scope, tabId: 42 });
      assert.ok(Object.isFrozen(gate) && Object.isFrozen(gate.scope));
      await new Promise(resolve => setTimeout(resolve, 35));
      assert.deepEqual((await f.calls()).map(x => x.method), ["armDownloadWait"]);
      assert.equal(f.detail.triggerAt, undefined);
      assert.equal(f.detail.gateReleasedAt, undefined);
      const deadline = f.detail.waitDeadline;
      release(); await pending;
      assert.equal(f.detail.waitDeadline, deadline);
      assert.ok(f.detail.readyAt <= f.detail.gateReleasedAt && f.detail.gateReleasedAt <= f.detail.triggerAt);
      assert.deepEqual((await f.calls()).map(x => x.method), ["armDownloadWait", "browserAction", "browserAction", "collectDownloadWait", "downloadPath", "cancelDownloadWait"]);
      assert.ok(f.detail.callerProcesses.every(x => x.closeObserved));
    } finally { release(); await pending.catch(() => {}); }
  });
  test(`${kind} rejected ready gate cancels the original waiter and closes every actual child without input`, async t => {
    const f = await fixture(t, { kind, variant: "dynamic-oopif" });
    const original = Error("ORIGINAL_GATE_REJECTION");
    await assert.rejects(runOriginalDownloadCaller({ ...f.options, afterReady: async () => { throw original; } }), error => error === original);
    assert.equal(f.detail.failedStage, "gate"); assert.equal(f.detail.waitCleanup.ok, true);
    assert.equal(f.detail.triggerAt, undefined); assert.equal(f.detail.downloadId, undefined);
    assert.deepEqual((await f.calls()).map(x => x.method), ["armDownloadWait", "cancelDownloadWait"]);
    assert.ok(f.detail.callerProcesses.every(x => x.exitObserved && x.closeObserved && x.exitCode === 0));
  });
  test(`${kind} pending ready gate expires within original waiter budget and late release cannot trigger input`, async t => {
    const f = await fixture(t, { kind, variant: "dynamic-oopif", mode: "short-wait" });
    let release;
    const hold = new Promise(resolve => { release = resolve; });
    await assert.rejects(runOriginalDownloadCaller({ ...f.options, afterReady: () => hold }), /ready gate exceeded the original wait deadline/);
    const deadline = f.detail.waitDeadline;
    release(); await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(f.detail.waitDeadline, deadline); assert.equal(f.detail.failedStage, "gate");
    assert.equal(f.detail.waitCleanup.ok, true); assert.equal(f.detail.triggerAt, undefined);
    assert.deepEqual((await f.calls()).map(x => x.method), ["armDownloadWait", "cancelDownloadWait"]);
    assert.ok(f.detail.callerProcesses.every(x => x.closeObserved));
  });
  test(`${kind} retains original click failure when observer cleanup also fails, with no replay`, async t => {
    const f = await fixture(t, { kind, mode: "fail-click" });
    await assert.rejects(runOriginalDownloadCaller(f.options), error => {
      assert.match(error.message, /ORIGINAL_CLICK_ERROR/); assert.equal(error.originalDownloadCallerDetail, f.detail); return true;
    });
    assert.equal(f.detail.ok, false); assert.equal(f.detail.failedStage, "click");
    assert.match(f.detail.waitCleanup.error, /SECONDARY_CLEANUP_ERROR/); assert.match(f.detail.originalError, /ORIGINAL_CLICK_ERROR/);
    assert.deepEqual((await f.calls()).map(x => x.method), ["armDownloadWait", "browserAction", "cancelDownloadWait"]);
    assert.ok(f.detail.callerProcesses.every(x => x.closeObserved));
  });
  test(`${kind} collection failure never retriggers and only releases its original waiter`, async t => {
    const f = await fixture(t, { kind, mode: "fail-collect" });
    await assert.rejects(runOriginalDownloadCaller(f.options), /ORIGINAL_COLLECT_ERROR/);
    assert.equal(f.detail.failedStage, "collect"); assert.equal(f.detail.waitCleanup.ok, true);
    assert.deepEqual((await f.calls()).map(x => x.method), ["armDownloadWait", "browserAction", "collectDownloadWait", "cancelDownloadWait"]);
  });
  test(`${kind} missing original path is not replaced by a filename or directory search`, async t => {
    const f = await fixture(t, { kind, mode: "missing-file" });
    await assert.rejects(runOriginalDownloadCaller(f.options), /ENOENT/);
    assert.equal(f.detail.failedStage, "readFile"); assert.equal(f.detail.file, undefined);
    assert.equal(f.detail.downloadId, "original-guid"); assert.equal(f.detail.waitCleanup.ok, true);
    assert.equal((await f.calls()).filter(x => x.method === "browserAction").length, 1);
  });
  test(`${kind} malformed observer cleanup ACK does not become a successful proof`, async t => {
    const f = await fixture(t, { kind, mode: "bad-cancel" });
    await assert.rejects(runOriginalDownloadCaller(f.options), /cancellation acknowledgement/);
    assert.equal(f.detail.failedStage, "cancelWait"); assert.equal(f.detail.waitCleanup.ok, false); assert.equal(f.detail.ok, false);
    assert.ok(f.detail.file && f.detail.callerProcesses.every(x => x.closeObserved));
  });
  test(`${kind} stalled action kills the exact process, observes close and does not replay`, async t => {
    const f = await fixture(t, { kind, mode: "hang-click" });
    await assert.rejects(runOriginalDownloadCaller({ ...f.options, responseTimeoutMs: 500 }), /response deadline exceeded/);
    assert.equal(f.detail.failedStage, "click");
    const stopped = f.detail.callerProcesses.filter(x => x.terminationRequestedAt);
    assert.equal(stopped.length, 1); assert.ok(stopped[0].closeObserved && stopped[0].exitObserved);
    assert.equal((await f.calls()).filter(x => x.method === "browserAction").length, 1);
    assert.equal(f.detail.downloadId, undefined);
  });
}

test("MCP malformed initialization closes actual child before returning and sends no browser request", async t => {
  const f = await fixture(t, { kind: "mcp", mode: "bad-init" });
  await assert.rejects(runOriginalDownloadCaller(f.options));
  assert.equal(f.detail.failedStage, "connect"); assert.equal(f.detail.callerProcesses[0].closeObserved, true);
  assert.deepEqual(await f.calls(), []);
});

for (const exit of ["clean", "killed"]) test(`MCP ${exit} child close rejects pending ready gate immediately without input or successor process`, async t => {
  const f = await fixture(t, { kind: "mcp", variant: "dynamic-oopif" });
  let child, childClosed, release;
  const hold = new Promise(resolve => { release = resolve; });
  const spawnOriginal = f.options.spawnProcess;
  const pending = runOriginalDownloadCaller({ ...f.options,
    spawnProcess(...args) {
      child = spawnOriginal(...args);
      childClosed = new Promise(resolve => child.once("close", resolve));
      return child;
    },
    afterReady: async () => {
      if (exit === "clean") child.stdin.end(); else child.kill();
      await hold;
    },
  });
  const outcome = pending.then(() => ({ success: true }), error => ({ error }));
  let timer;
  try {
    // Wait for the actual child to exist, then its real close event. The gate
    // remains unresolved until after the immediate-close assertion.
    while (!childClosed) await new Promise(resolve => setImmediate(resolve));
    await childClosed;
    const result = await Promise.race([outcome, new Promise(resolve => { timer = setTimeout(() => resolve({ stalled: true }), 250); })]);
    assert.equal(result.stalled, undefined, "Actual MCP close must wake the gate without waiting for release/deadline");
    assert.match(result.error?.message ?? "", /Original-download MCP closed/);
    assert.equal(f.detail.failedStage, "gate"); assert.equal(f.detail.triggerAt, undefined);
    assert.equal(f.detail.waitCleanup.attempted, true); assert.equal(f.detail.waitCleanup.ok, false);
    assert.match(f.detail.waitCleanup.error, /MCP is closed/);
    assert.equal(f.detail.callerProcesses.length, 1); assert.equal(f.detail.callerProcesses[0].closeObserved, true);
    assert.deepEqual((await f.calls()).map(x => x.method), ["armDownloadWait"]);
    release(); await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual((await f.calls()).map(x => x.method), ["armDownloadWait"]);
  } finally { clearTimeout(timer); release(); await outcome; }
});

test("process runner preserves stdin and split UTF-8 stdout through actual close", async () => {
  const detail = {}, input = '{"original":"中文"}\n';
  const stdout = await runOriginalDownloadProcess({ command: process.execPath, args: ["-e", "let b='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>b+=x);process.stdin.on('end',()=>{const a=Buffer.from(b);process.stdout.write(a.subarray(0,15));setTimeout(()=>process.stdout.end(a.subarray(15)),10)})"], input, detail });
  assert.equal(stdout, input); assert.equal(detail.stdout, input); assert.equal(detail.stderr, "");
  assert.equal(detail.exitCode, 0); assert.equal(detail.exitObserved, true); assert.equal(detail.closeObserved, true);
});

test("process runner preserves original timeout, termination and actual close", async () => {
  const detail = {};
  await assert.rejects(runOriginalDownloadProcess({ command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], timeoutMs: 100, detail }), error => {
    assert.match(error.message, /response deadline exceeded/); assert.equal(error.originalProcessDetail, detail); return true;
  });
  assert.ok(detail.terminationRequestedAt <= detail.closedAt); assert.equal(detail.closeObserved, true);
});

test("process runner retains nonzero exit and stderr without parsing success", async () => {
  const detail = {};
  await assert.rejects(runOriginalDownloadProcess({ command: process.execPath, args: ["-e", "process.stderr.write('original-error');process.exitCode=7"], detail }), /exited 7: original-error/);
  assert.equal(detail.exitCode, 7); assert.equal(detail.closeObserved, true); assert.equal(detail.stderr, "original-error");
});

test("process runner preserves bare executable PATH lookup", async () => {
  const env = { ...process.env }, key = Object.keys(env).find(key => key.toLowerCase() === "path") ?? "PATH";
  env[key] = path.dirname(process.execPath) + path.delimiter + (env[key] ?? "");
  const detail = {}, command = path.basename(process.execPath);
  assert.equal(await runOriginalDownloadProcess({ command, args: ["-e", "process.stdout.write('actual PATH child')"], env, detail }), "actual PATH child");
  assert.equal(detail.executable, command); assert.equal(detail.closeObserved, true);
});

test("invalid original scope is rejected without any child process", async t => {
  const f = await fixture(t);
  await assert.rejects(runOriginalDownloadCaller({ ...f.options, controlEpoch: 0 }));
  assert.deepEqual(await f.calls(), []);
});
