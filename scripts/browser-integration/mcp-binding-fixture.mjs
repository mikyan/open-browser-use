import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";

export const mcpBindingCases = ["js-raw-navigation-before-engine", "mcp-connection-binding"];
export function mcpBindingEnabled(env) {
  assert.ok(env.OBU_TEST_MCP_BINDING === undefined || env.OBU_TEST_MCP_BINDING === "1", "OBU_TEST_MCP_BINDING must be 1 or unset");
  if (env.OBU_TEST_MCP_BINDING !== "1") return false;
  for (const name of ["OBU_TEST_CASES", "OBU_TEST_CHOOSER_DIAGNOSTIC", "OBU_TEST_SNAPSHOT_GEOMETRY", "OBU_TEST_GEOMETRY_DPR", "OBU_TEST_BACKGROUND_PARALLEL", "OBU_TEST_MEMORY_CLIPBOARD"])
    assert.equal(env[name], undefined, `MCP binding acceptance cannot be combined with ${name}`);
  return true;
}
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
export function checkMCPBindingSelection(records) {
  assert.deepEqual(records.map(record => record.name), mcpBindingCases, "MCP binding mode must run exactly its two cases");
  return records.every(record => record.passed === true);
}

export function createMCPBindingFixture() {
  const nonce = randomBytes(12).toString("hex"), gets = [], posts = [], errors = [];
  let key, overflow = false;
  return {
    configure(value) { assert.equal(key, undefined); assert.match(value, /^[a-z0-9-]{1,80}$/); key = value; return nonce; },
    snapshot: () => structuredClone({ key, nonce, gets, posts, errors, overflow }),
    handle(request, response) {
      const url = new URL(request.url, "http://localhost");
      if (!["/mcp-binding", "/mcp-binding-post"].includes(url.pathname)) return false;
      if (!key || url.searchParams.get("key") !== key) { response.writeHead(404); response.end(); return true; }
      if (url.pathname === "/mcp-binding" && request.method === "GET" && ["before", "fresh"].includes(url.searchParams.get("phase"))) {
        if (gets.length >= 8) { overflow = true; response.writeHead(429); response.end(); return true; }
        const phase = url.searchParams.get("phase");
        const html = `<!doctype html><meta charset="utf-8"><title>MCP binding ${phase}</title><label>Connection phase <output>${phase}</output></label>
<button id="record">Record ${phase}</button><button id="stale">Record stale</button><output id="receipt"></output>
<script>const documentToken=crypto.randomUUID();let sequence=0;for(const button of document.querySelectorAll('button'))button.onclick=async event=>{const value={key:${JSON.stringify(key)},nonce:${JSON.stringify(nonce)},phase:${JSON.stringify(phase)},step:button.id==='stale'?'stale':${JSON.stringify(phase)},documentToken,sequence:++sequence,trusted:event.isTrusted};const response=await fetch('/mcp-binding-post?key='+encodeURIComponent(value.key),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(value)});document.querySelector('#receipt').textContent=await response.text();};</script>`;
        gets.push({ at: Date.now(), method: request.method, phase, url: request.url, bytes: Buffer.byteLength(html), sha256: sha256(html) });
        response.setHeader("Content-Type", "text/html; charset=utf-8"); response.end(html); return true;
      }
      if (url.pathname !== "/mcp-binding-post" || request.method !== "POST") { response.writeHead(405); response.end(); return true; }
      const chunks = []; let size = 0, ended = false;
      request.on("data", chunk => {
        if (ended) return;
        size += chunk.length;
        if (size > 8192) { overflow = true; ended = true; response.writeHead(413); response.end(); request.destroy(); }
        else chunks.push(chunk);
      });
      request.once("error", error => { if (errors.length < 8) errors.push(String(error)); else overflow = true; });
      request.once("end", () => {
        if (ended) return;
        if (posts.length >= 8) { overflow = true; response.writeHead(429); response.end(); return; }
        const body = Buffer.concat(chunks), entry = { at: Date.now(), method: request.method, bodyBytes: body.length, bodyBase64: body.toString("base64"), bodySHA256: sha256(body) };
        posts.push(entry);
        try {
          entry.value = JSON.parse(body.toString("utf8"));
          assert.equal(entry.value.key, key); assert.equal(entry.value.nonce, nonce);
          response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ received: posts.length, step: entry.value.step }));
        } catch (error) { entry.error = String(error); response.writeHead(400); response.end(); }
      });
      return true;
    }
  };
}

export function checkMCPBindingPosts(server, expectedSteps) {
  assert.equal(server.overflow, false); assert.deepEqual(server.errors, []);
  assert.equal(server.posts.length, expectedSteps.length, "Unexpected/replayed browser POST");
  const documents = new Set();
  for (const [index, post] of server.posts.entries()) {
    const bytes = Buffer.from(post.bodyBase64, "base64"), value = JSON.parse(bytes.toString("utf8"));
    assert.equal(bytes.length, post.bodyBytes); assert.equal(sha256(bytes), post.bodySHA256); assert.deepEqual(value, post.value);
    assert.equal(post.method, "POST"); assert.equal(value.key, server.key); assert.equal(value.nonce, server.nonce);
    assert.equal(value.phase, expectedSteps[index]); assert.equal(value.step, expectedSteps[index]);
    assert.equal(value.trusted, true); assert.equal(value.sequence, 1); assert.equal(typeof value.documentToken, "string");
    assert.ok(value.documentToken && !documents.has(value.documentToken)); documents.add(value.documentToken);
  }
  return { posts: server.posts.length, steps: [...expectedSteps] };
}

// A real, persistent stdio MCP process. Capture the original lines and chunks;
// do not use a replacement server, explicit --socket, reconnect or RPC replay.
export async function startBindingMCP({ executable, socketDir, sessionId, detail, spawnProcess = spawn, requestTimeoutMs = 20000 }) {
  const args = ["mcp", "--socket-dir", socketDir, "--session-id", sessionId, "--timeout", "15s"];
  Object.assign(detail, { executable: path.resolve(executable), args, sessionId, startedAt: Date.now(), requests: [], responses: [], stdout: "", stderr: "", overflow: false });
  const child = spawnProcess(detail.executable, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  detail.pid = child.pid;
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  let serial = 0, buffer = "", fatal, closing = false;
  const pending = new Map();
  const fail = error => { fatal ??= error; for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); } pending.clear(); };
  const retain = (field, text) => {
    if (Buffer.byteLength(detail[field]) + Buffer.byteLength(text) > 2 * 1024 * 1024) { detail.overflow = true; fail(new Error(`MCP ${field} capture exceeded capacity`)); return false; }
    detail[field] += text; return true;
  };
  child.stdin.on("error", fail); child.once("error", fail);
  const closed = new Promise(resolve => child.once("close", (code, signal) => {
    Object.assign(detail, { closedAt: Date.now(), exitCode: code, exitSignal: signal });
    if (buffer.trim()) fail(new Error("MCP exited with a partial JSON line"));
    if (!closing) fail(new Error(`MCP exited unexpectedly: ${code} ${signal}`));
    else if (pending.size) fail(new Error("MCP closed with pending requests"));
    resolve();
  }));
  child.stderr.on("data", text => retain("stderr", text));
  child.stdout.on("data", chunk => {
    if (!retain("stdout", chunk)) return;
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      try {
        const response = JSON.parse(line); detail.responses.push({ at: Date.now(), line, message: response });
        assert.equal(response.jsonrpc, "2.0", "Malformed MCP response version");
        const entry = pending.get(response.id);
        if (!entry) {
          if (response.id !== undefined) throw new Error("MCP returned an unknown/duplicate request ID");
          assert.ok(typeof response.method === "string" && response.method.length > 0, "Malformed MCP notification"); continue;
        }
        pending.delete(response.id); clearTimeout(entry.timer); entry.resolve(response);
      } catch (error) { fail(error); }
    }
  });
  const send = message => {
    if (fatal) throw fatal;
    assert.equal(child.exitCode, null, "MCP process exited before request");
    assert.ok(detail.requests.length < 128, "MCP request evidence limit exceeded");
    const line = JSON.stringify(message) + "\n"; detail.requests.push({ at: Date.now(), line, message }); child.stdin.write(line);
  };
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++serial, timer = setTimeout(() => { fail(new Error(`MCP ${method} exceeded original request deadline`)); }, requestTimeoutMs);
    pending.set(id, { resolve, reject, timer });
    try { send({ jsonrpc: "2.0", id, method, params }); } catch (error) { fail(error); }
  });
  const stop = async () => {
    closing = true; child.stdin.end();
    let timer;
    try {
      const graceful = await Promise.race([closed.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 2000); })]);
      if (!graceful) {
        detail.forcedKill = true; child.kill(); clearTimeout(timer);
        await Promise.race([closed, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Exact MCP child did not exit after kill")), 5000); })]);
        throw new Error("MCP did not close after stdin EOF");
      }
      assert.equal(detail.exitCode, 0); assert.equal(detail.exitSignal, null); assert.equal(detail.overflow, false);
      if (fatal) throw fatal;
    } finally { clearTimeout(timer); }
  };
  try {
    const init = await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "obu-binding-acceptance", version: "1" } });
    assert.equal(init.error, undefined); assert.equal(init.result.protocolVersion, "2025-06-18");
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    return { detail, tool: (name, arguments_ = {}) => request("tools/call", { name, arguments: arguments_ }),
      assertAlive: () => { assert.equal(child.pid, detail.pid); assert.equal(child.exitCode, null); assert.equal(detail.closedAt, undefined); if (fatal) throw fatal; }, close: stop };
  } catch (error) { try { await stop(); } catch (cleanup) { detail.cleanupError = String(cleanup); } throw error; }
}

function successful(response) {
  assert.equal(response.error, undefined, JSON.stringify(response)); assert.equal(response.result?.isError, false, JSON.stringify(response));
  const wire = response.result.structuredContent; assert.ok(wire && Object.hasOwn(wire, "result")); assert.equal(wire.error, undefined, JSON.stringify(response)); return wire.result;
}
function disconnected(response) {
  assert.equal(response.error, undefined, "Expected a tool error, not a protocol/transport failure");
  assert.equal(response.result?.isError, true); assert.match(JSON.stringify(response.result.content), /OBU_MCP_BROWSER_DISCONNECTED/); return response;
}

export async function checkMCPConnectionBinding({ executable, socketDir, fixtureURL, fixture, restartHost, readNative, until, save, startMCP = startBindingMCP }) {
  const sessionId = `mcp-binding-${randomBytes(8).toString("hex")}`, nonce = fixture.configure(sessionId);
  const detail = { sessionId, nonce, processes: [], tabIds: [] };
  let old, fresh, failure, finalizeAttempted = false;
  const call = async (client, method, params) => successful(await client.tool("call", { method, params }));
  const begin = async client => {
    const value = successful(await client.tool("begin_turn"));
    assert.ok(typeof value.nextTurnId === "string" && Number.isSafeInteger(value.controlEpoch));
    return { session_id: sessionId, turn_id: value.nextTurnId, control_epoch: value.controlEpoch };
  };
  const actionParams = (scope, tabId, name) => ({ ...scope, tabId, action: "click", locator: [{ kind: "role", role: "button", name, exact: true }], args: {}, timeoutMs: 10000 });
  const makePage = async (client, scope, phase) => {
    const tab = await call(client, "createTab", scope); assert.ok(Number.isSafeInteger(tab.id)); detail.tabIds.push(tab.id);
    const url = new URL(`mcp-binding?key=${sessionId}&phase=${phase}`, fixtureURL).href;
    await call(client, "browserAction", { ...scope, tabId: tab.id, action: "goto", args: { url }, timeoutMs: 10000 });
    return tab.id;
  };
  try {
    const oldProcess = {}; detail.processes.push(oldProcess); old = await startMCP({ executable, socketDir, sessionId, detail: oldProcess });
    detail.oldScope = await begin(old); detail.beforeTabId = await makePage(old, detail.oldScope, "before");
    await call(old, "browserAction", actionParams(detail.oldScope, detail.beforeTabId, "Record before"));
    await until(() => fixture.snapshot().posts.length === 1, "first MCP browser POST");
    detail.before = fixture.snapshot(); checkMCPBindingPosts(detail.before, ["before"]); await save(detail);
    old.assertAlive(); detail.restart = await restartHost(); old.assertAlive();
    assert.notEqual(detail.restart.oldPid, detail.restart.newPid); assert.notEqual(detail.restart.oldEndpoint, detail.restart.newEndpoint);
    detail.oldAction = disconnected(await old.tool("call", { method: "browserAction", params: actionParams(detail.oldScope, detail.beforeTabId, "Record stale") }));
    old.assertAlive(); detail.oldBegin = disconnected(await old.tool("begin_turn")); old.assertAlive();
    detail.afterRejected = fixture.snapshot(); checkMCPBindingPosts(detail.afterRejected, ["before"]); await save(detail);
    const freshProcess = {}; detail.processes.push(freshProcess); fresh = await startMCP({ executable, socketDir, sessionId, detail: freshProcess });
    assert.notEqual(freshProcess.pid, oldProcess.pid); detail.newScope = await begin(fresh);
    assert.notEqual(detail.newScope.turn_id, detail.oldScope.turn_id); assert.ok(detail.newScope.control_epoch > detail.oldScope.control_epoch);
    detail.freshTabId = await makePage(fresh, detail.newScope, "fresh");
    await call(fresh, "browserAction", actionParams(detail.newScope, detail.freshTabId, "Record fresh"));
    await until(() => fixture.snapshot().posts.length === 2, "fresh MCP browser POST");
    detail.afterFresh = fixture.snapshot(); checkMCPBindingPosts(detail.afterFresh, ["before", "fresh"]);
    old.assertAlive(); detail.oldActionAfterFresh = disconnected(await old.tool("call", { method: "browserAction", params: actionParams(detail.oldScope, detail.beforeTabId, "Record stale") }));
    old.assertAlive(); detail.sameOldProcessSurvivedRestart = oldProcess.pid;
    finalizeAttempted = true; detail.finalize = await call(fresh, "finalizeTabs", { ...detail.newScope, keep: [] });
    detail.removal = await until(async () => { const state = await readNative(); return detail.tabIds.every(id => !state.tabs.some(tab => tab.id === id) && !state.targets.some(target => target.tabId === id)) && state; }, "both MCP task tabs and attachments removed");
    detail.server = fixture.snapshot(); checkMCPBindingPosts(detail.server, ["before", "fresh"]);
    assert.deepEqual(detail.server.gets.map(entry => entry.phase), ["before", "fresh"]);
  } catch (error) { failure = error; detail.error = error.stack ?? String(error); }
  finally {
    const cleanupErrors = [];
    if (fresh && detail.newScope && !finalizeAttempted) {
      try { detail.failureCleanup = await call(fresh, "finalizeTabs", { ...detail.newScope, keep: [] }); } catch (error) { cleanupErrors.push(String(error)); }
    }
    for (const client of [fresh, old]) if (client) try { await client.close(); } catch (error) { cleanupErrors.push(String(error)); }
    detail.serverAtEnd = fixture.snapshot();
    if (!failure) try { checkMCPBindingPosts(detail.serverAtEnd, ["before", "fresh"]); } catch (error) { failure = error; detail.error = error.stack; }
    if (cleanupErrors.length) { detail.cleanupErrors = cleanupErrors; failure ??= new Error(`MCP cleanup failed: ${cleanupErrors.join("; ")}`); }
    await save(detail);
  }
  if (failure) throw failure;
  return { sessionId, oldMCPPid: detail.processes[0].pid, newMCPPid: detail.processes[1].pid, oldEndpoint: detail.restart.oldEndpoint, newEndpoint: detail.restart.newEndpoint, posts: 2, sameOldProcessSurvivedRestart: true, noReplay: true, taskTabsRemoved: true };
}
