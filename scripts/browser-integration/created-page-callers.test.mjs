import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { validateBrowserAction } from "../../apps/chrome-extension/browser-action-engine.js";
import { runCreatedPageCaller } from "./created-page-callers.mjs";

// Real child processes relay public CLI arguments / MCP JSONL over actual
// framed IPC. The independent server validates the real action wire schema.
const relay = String.raw`
const net=require('node:net'),readline=require('node:readline');
const args=process.argv.slice(2),at=k=>args[args.indexOf(k)+1],socket=net.connect(at('--socket'));
let buffer=Buffer.alloc(0),request,initialized=false;
const send=v=>{const b=Buffer.from(JSON.stringify(v)),h=Buffer.alloc(4);h.writeUInt32LE(b.length);socket.write(Buffer.concat([h,b]));};
const emit=v=>process.stdout.write(JSON.stringify(v)+'\n');
socket.on('data',data=>{buffer=Buffer.concat([buffer,data]);while(buffer.length>=4&&buffer.length>=buffer.readUInt32LE(0)+4){const size=buffer.readUInt32LE(0),response=JSON.parse(buffer.subarray(4,4+size));buffer=buffer.subarray(4+size);if(args[0]==='call'){emit(response);socket.end()}else{emit({jsonrpc:'2.0',id:request.id,result:{isError:false,structuredContent:response}});request=null;}}});
socket.on('error',e=>{process.stderr.write(String(e));process.exit(1)});socket.on('close',()=>process.exit(0));
if(args[0]==='call')socket.on('connect',()=>send({jsonrpc:'2.0',id:'cli-1',method:at('--method'),params:JSON.parse(at('--params'))}));
else if(args[0]==='mcp'){
const input=readline.createInterface({input:process.stdin});input.on('close',()=>socket.end());input.on('line',line=>{const m=JSON.parse(line);if(m.method==='initialize'){initialized=true;emit({jsonrpc:'2.0',id:m.id,result:{protocolVersion:'2025-06-18'}});return;}if(m.method==='notifications/initialized')return;if(!initialized||m.method!=='tools/call'||m.params.name!=='call'||request)throw Error('Invalid MCP ordering');request=m;send({jsonrpc:'2.0',id:'cli-1',method:m.params.arguments.method,params:m.params.arguments.params});});
}else throw Error('Invalid caller mode');
`;
const scope = { session_id: "original-session", turn_id: "original-turn", control_epoch: 7 };
const sourceNonce = "01234567-89ab-4cde-8fab-0123456789ab", sourceToken = "22222222-89ab-4cde-8fab-0123456789ab";
const childNonce = "11111111-89ab-4cde-8fab-0123456789ab", childToken = "33333333-89ab-4cde-8fab-0123456789ab";
const tick = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

async function fixture(t, { kind = "cli", variant = "root", mode = "", executable } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "obu-created-caller-"));
  const script = path.join(directory, "relay.cjs"), endpoint = process.platform === "win32" ? `\\\\.\\pipe\\obu-created-test-${randomUUID()}` : path.join(directory, "native.sock");
  await fs.writeFile(script, relay);
  const requests = [], actions = [], errors = [], sockets = new Set(), gates = {};
  let clicked = 0, added = 0, committed = 0, texts = 0, beforeReply;
  const source = (frame = false) => ({ key: "case-key", owner: "original-owner", variant, sourceNonce, documentToken: sourceToken,
    clicks: (variant === "root" || frame) && clicked ? [{ trusted: true, ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, button: 0, sequence: 1, sourceNonce, documentToken: sourceToken }] : [],
    frameAdds: !frame && added ? [{ trusted: true, sequence: 1 }] : [] });
  const child = () => ({ documentNonce: childNonce, documentToken: childToken, clicks: committed ? [{ trusted: true, sequence: 1, documentNonce: childNonce, documentToken: childToken }] : [] });
  const result = async request => {
    const { method, params } = request;
    requests.push({ ...structuredClone(request), observedAt: Date.now() });
    if (!["getInfo"].includes(method)) for (const [k, value] of Object.entries(scope)) assert.equal(params[k], value, `Original scope ${k}`);
    if (method === "getInfo") return { metadata: { pageWaitVersion: mode === "unsupported" ? 0 : 1 } };
    if (method === "getControlState") return { lifecycleVersion: 1, controlEpoch: 7, closing: false, nextTurnId: "next-turn" };
    if (method === "armPageWait") {
      assert.equal(params.tabId, 42); assert.ok(params.timeoutMs > 0 && params.timeoutMs < 20000);
      await beforeReply?.();
      return { waiterId: "original-waiter", remainingMs: mode === "short-gate" ? 150 : mode.startsWith("budget") ? 1550 : Math.min(18000, params.timeoutMs), ...(mode === "bad-ready" ? { extra: true } : {}) };
    }
    if (method === "collectPageWait") {
      assert.equal(params.tabId, 42); assert.equal(params.waiterId, "original-waiter"); assert.equal(clicked, 1);
      if (mode === "collect-error") throw Error("ORIGINAL_COLLECT_ERROR");
      return mode === "same-child" ? { tabId: 42 } : mode === "bad-child" ? { tabId: 84, url: "guessed" } : { tabId: 84 };
    }
    if (method === "cancelPageWait") {
      assert.equal(params.tabId, 42); assert.equal(params.waiterId, "original-waiter");
      if (mode === "trigger-error") throw Error("SECONDARY_CLEANUP_ERROR");
      return mode === "bad-cancel" ? { cancelled: true } : {};
    }
    assert.equal(method, "browserAction"); validateBrowserAction(params);
    const step = params.locator.at(-1), selector = step.selector, frame = params.locator.some(x => x.kind === "frame");
    if (frame) assert.equal(params.locator[0].selector, "#created-page-frame");
    assert.ok(params.timeoutMs > 0 && params.timeoutMs <= 5000);
    let value = null;
    if (params.action === "textContent") {
      if (selector === "#state") {
        if (mode === "empty-state" && texts++ < 2) value = "";
        else if (mode === "malformed-state") value = "{invalid";
        else value = JSON.stringify(params.tabId === 42 ? source(frame) : child());
      } else { assert.equal(selector, "#result"); assert.equal(params.tabId, 84); value = JSON.stringify({ ok: true, key: "case-key", owner: "original-owner", documentNonce: mode === "wrong-receipt" ? sourceNonce : childNonce }); }
    } else {
      if (mode.startsWith("budget") && selector === "#open-child") {
        await tick(Math.min(500, params.timeoutMs)); if (params.timeoutMs < 500) throw Error("ACTION_EXPIRED_WITHOUT_INPUT");
      }
      if (selector === "#open-child" && mode === "trigger-error") throw Error("ORIGINAL_TRIGGER_ERROR");
      actions.push({ action: params.action, locator: structuredClone(params.locator), args: structuredClone(params.args), tabId: params.tabId, timeoutMs: params.timeoutMs });
      if (selector === "#add-frame") { assert.equal(params.tabId, 42); assert.equal(variant, "dynamic-oopif"); assert.equal(added++, 0); }
      else if (selector === "#open-child") { assert.equal(params.tabId, 42); assert.deepEqual(params.args, { modifiers: ["Control"] }); assert.equal(clicked++, 0); }
      else if (selector === "#commit") { assert.equal(params.tabId, 84); assert.equal(committed++, 0); }
      else { assert.equal(params.action, "fill"); assert.equal(params.tabId, 84); assert.equal(step.kind, "label"); assert.equal(params.args.value, step.value === "Source key" ? "case-key" : "original-owner"); }
    }
    return { engine: { name: "playwright-crx", version: "0.15.0", playwrightVersion: "1.0.0" }, value };
  };
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on("error", () => {}); socket.once("close", () => sockets.delete(socket)); let buffer = Buffer.alloc(0), queue = Promise.resolve();
    socket.on("data", chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE(0) + 4) {
        const size = buffer.readUInt32LE(0), request = JSON.parse(buffer.subarray(4, size + 4)); buffer = buffer.subarray(size + 4);
        queue = queue.then(async () => {
          let reply; try { reply = { result: await result(request) }; } catch (error) { if (error.code === "ERR_ASSERTION") errors.push(error); reply = { error: { code: -32000, message: error.message } }; }
          const bytes = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: request.id, ...reply })), prefix = Buffer.alloc(4); prefix.writeUInt32LE(bytes.length); if (!socket.destroyed) socket.write(Buffer.concat([prefix, bytes]));
        }).catch(error => errors.push(error));
      }
    });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(endpoint, resolve); });
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)); await fs.rm(directory, { recursive: true, force: true }); assert.deepEqual(errors, []); });
  const detail = {}, options = { kind, executable: executable ?? process.execPath, socketPath: endpoint, sessionId: scope.session_id, turnId: scope.turn_id, controlEpoch: 7, tabId: 42, variant, key: "case-key", owner: "original-owner", detail,
    ...(executable ? {} : { spawnProcess(command, args, settings) { assert.equal(settings.windowsHide, true); return spawn(command, [script, ...args], settings); } }) };
  return { options, detail, requests, actions, sockets, gates, setBeforeReply(value) { beforeReply = value; } };
}

for (const kind of ["cli", "mcp"]) {
  for (const variant of ["root", "oopif", "dynamic-oopif"]) test(`${kind} ${variant}: actual IPC, exact returned child and sole trigger/commit`, async t => {
    const f = await fixture(t, { kind, variant }), result = await runCreatedPageCaller(f.options);
    assert.equal(result, f.detail); assert.equal(result.ok, true); assert.equal(result.childId, 84); assert.equal(result.waitCleanup.ok, true); assert.equal(result.clientClose.ok, true);
    assert.equal(f.actions.filter(x => x.locator.at(-1).selector === "#open-child").length, 1); assert.equal(f.actions.filter(x => x.locator.at(-1).selector === "#commit").length, 1);
    assert.ok(f.detail.callerProcesses.every(x => x.exitObserved && x.closeObserved && x.exitCode === 0));
    if (kind === "mcp") { assert.equal(f.detail.callerProcesses.length, 1); assert.ok(f.detail.callerProcesses[0].eofRequestedAt); }
    else for (let i = 1; i < f.detail.callerProcesses.length; i++) assert.ok(f.detail.callerProcesses[i - 1].closedAt <= f.detail.callerProcesses[i].startedAt);
    assert.ok(f.detail.readyAt <= f.detail.preparedAt && f.detail.preparedAt <= f.detail.triggerAt); assert.deepEqual(f.detail.receipt, { ok: true, key: "case-key", owner: "original-owner", documentNonce: childNonce });
  });
  test(`${kind}: both actual gates prohibit early dynamic add and trigger`, async t => {
    const f = await fixture(t, { kind, variant: "dynamic-oopif" }), reached = deferred(), release = deferred(), prepared = deferred(), trigger = deferred();
    const running = runCreatedPageCaller({ ...f.options, afterReady: async value => { f.gates.ready = value; reached.resolve(); await release.promise; }, afterPrepared: async value => { f.gates.prepared = value; prepared.resolve(); await trigger.promise; } });
    try {
      await reached.promise; await tick(35); assert.deepEqual(f.actions, []); assert.equal(f.gates.ready.waiterId, "original-waiter"); assert.ok(Object.isFrozen(f.gates.ready.scope));
      release.resolve(); await prepared.promise; await tick(35); assert.deepEqual(f.actions.map(x => x.locator.at(-1).selector), ["#add-frame"]); assert.deepEqual(f.gates.prepared.sourceBefore.clicks, []); assert.ok(f.gates.prepared.remainingMs < f.gates.ready.remainingMs);
      trigger.resolve(); await running;
    } finally { release.resolve(); trigger.resolve(); await running.catch(() => {}); }
  });
  for (const gate of ["afterReady", "afterPrepared"]) test(`${kind}: ${gate} rejection preserves original error and no trigger`, async t => {
    const f = await fixture(t, { kind }), error = Error("ORIGINAL_GATE_ERROR");
    await assert.rejects(runCreatedPageCaller({ ...f.options, [gate]: async () => { throw error; } }), value => value === error);
    assert.deepEqual(f.actions, []); assert.equal(f.detail.waitCleanup.ok, true); assert.equal(f.detail.clientClose.ok, true);
  });
  for (const mode of ["unsupported", "bad-ready", "bad-child", "same-child", "bad-cancel", "malformed-state", "wrong-receipt", "collect-error", "trigger-error"]) test(`${kind}: ${mode} cannot report success or replay input`, async t => {
    const f = await fixture(t, { kind, mode }); await assert.rejects(runCreatedPageCaller(f.options));
    assert.equal(f.detail.ok, false); assert.ok(f.actions.filter(x => x.locator.at(-1).selector === "#open-child").length <= 1); assert.ok(f.actions.filter(x => x.locator.at(-1).selector === "#commit").length <= 1);
    assert.ok(f.detail.callerProcesses.every(x => x.closeObserved));
    if (mode === "bad-ready") assert.equal(f.detail.waitCleanup.ok, true);
    if (mode === "trigger-error") { assert.match(f.detail.originalError, /ORIGINAL_TRIGGER_ERROR/); assert.match(f.detail.waitCleanup.error, /SECONDARY_CLEANUP_ERROR/); }
    if (mode === "malformed-state") assert.equal(f.requests.filter(x => x.method === "browserAction").length, 1);
  });
  test(`${kind}: only empty state is polled`, async t => { const f = await fixture(t, { kind, mode: "empty-state" }); await runCreatedPageCaller(f.options); assert.equal(f.detail.stages.filter(x => x.name === "rootBefore").length, 3); });
  test(`${kind}: expired ready gate cannot be revived by late release`, async t => {
    const f = await fixture(t, { kind, mode: "short-gate" }), hold = deferred();
    await assert.rejects(runCreatedPageCaller({ ...f.options, afterReady: () => hold.promise }), /gate exceeded original deadline/); hold.resolve(); await tick(30);
    assert.deepEqual(f.actions, []); assert.equal(f.detail.waitCleanup.ok, true); assert.ok(f.detail.callerProcesses.every(x => x.closeObserved));
  });
  test(`${kind}: prepared gate expires under wall-clock rollback and late release cannot trigger`, async t => {
    const f = await fixture(t, { kind, mode: "budget-prepared" }), hold = deferred(), originalNow = Date.now;
    try {
      await assert.rejects(runCreatedPageCaller({ ...f.options, afterPrepared: () => { t.mock.method(Date, "now", () => originalNow() - 60000); return hold.promise; } }), /preparedGate exceeded original deadline/);
      hold.resolve(); await tick(30); assert.deepEqual(f.actions, []); assert.equal(f.detail.waitCleanup.ok, true); assert.equal(f.detail.failedStage, "preparedGate"); assert.ok(f.detail.callerProcesses.every(x => x.closeObserved));
    } finally { hold.resolve(); t.mock.restoreAll(); }
  });
  test(`${kind}: original remaining action budget includes transport reserve after both gates`, async t => {
    const f = await fixture(t, { kind, mode: "budget-trigger" });
    await assert.rejects(runCreatedPageCaller({ ...f.options, afterReady: () => tick(120), afterPrepared: () => tick(120) }), /ACTION_EXPIRED_WITHOUT_INPUT|action deadline expired/);
    assert.deepEqual(f.actions, []); const call = f.requests.find(x => x.params?.locator?.at(-1)?.selector === "#open-child"); if (call) assert.ok(call.params.timeoutMs < 500);
    assert.equal(f.detail.waitCleanup.ok, true);
  });
  test(`${kind}: late readiness ACK cannot reset original monotonic deadline`, async t => {
    const f = await fixture(t, { kind }); const original = performance.now.bind(performance); let offset = 0; t.mock.method(performance, "now", () => original() + offset); f.setBeforeReply(() => { offset = 21000; });
    try { await assert.rejects(runCreatedPageCaller(f.options), /Original created-page deadline expired/); assert.deepEqual(f.actions, []); assert.equal(f.detail.waitCleanup.ok, true); }
    finally { t.mock.restoreAll(); }
  });
}
for (const gate of ["afterReady", "afterPrepared"]) test(`MCP actual EOF during ${gate} rejects without waiting for gate release`, async t => {
  const f = await fixture(t, { kind: "mcp" }), hold = deferred();
  await assert.rejects(runCreatedPageCaller({ ...f.options, [gate]: () => { for (const socket of f.sockets) socket.end(); return hold.promise; } }), /MCP closed/);
  hold.resolve(); await tick(20); assert.deepEqual(f.actions, []); assert.ok(f.detail.callerProcesses[0].exitObserved && f.detail.callerProcesses[0].closeObserved);
});

// When the repository's real CLI has been built, exercise its public parsing,
// control/capability negotiation and MCP server against the same native IPC.
const binary = process.env.OBU_TEST_CREATED_PAGE_CALLER_BINARY ?? path.resolve(".tmp/created-page-ready/bin-v1/open-browser-use.exe");
for (const kind of ["cli", "mcp"]) test(`${kind}: actual Go public executable over fake native IPC`, async t => {
  try { await fs.access(binary); } catch { t.skip("Set OBU_TEST_CREATED_PAGE_CALLER_BINARY to a current CLI build"); return; }
  const f = await fixture(t, { kind, variant: "dynamic-oopif", executable: binary }); await runCreatedPageCaller(f.options);
  assert.equal(f.detail.ok, true); assert.ok(f.detail.callerProcesses.every(x => x.exitObserved && x.closeObserved && x.exitCode === 0)); assert.equal(f.actions.filter(x => x.locator.at(-1).selector === "#open-child").length, 1);
});
