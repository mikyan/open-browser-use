import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer, createConnection } from "node:net";
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import os from "node:os";
import path from "node:path";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const describe = error => String(error?.stack ?? error);
const keyPattern = /^sdk-connection-(js|python|go)-(eof|close)-[a-f0-9]{32}$/;
export const sdkConnectionKinds = ["js", "python", "go"];
export const sdkConnectionModes = ["eof", "close"];

export function sdkConnectionHTML(key) {
  assert.match(key, keyPattern);
  return `<!doctype html><meta charset="utf-8"><title>SDK connection recovery</title>
<p id="connection-ready">SDK_CONNECTION_READY</p><button id="stale-action">Old connection action</button>
<button id="recover-action">Recovered connection action</button><pre id="state"></pre><pre id="receipt" hidden></pre>
<script>(()=>{const key=${JSON.stringify(key)},state={key,documentToken:crypto.randomUUID(),events:[],receipts:[],errors:[]};
const render=()=>document.querySelector('#state').textContent=JSON.stringify(state);render();
for(const id of ['stale-action','recover-action'])document.getElementById(id).addEventListener('click',event=>{
 const value={key,documentToken:state.documentToken,kind:id,trusted:event.isTrusted,target:event.target.id,x:event.clientX,y:event.clientY};
 state.events.push(value);render();
 fetch('/sdk-connection/post?key='+key,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)})
 .then(async response=>{if(!response.ok)throw Error('POST '+response.status);state.receipts.push(await response.json());
 document.querySelector('#receipt').hidden=false;render();}).catch(error=>{state.errors.push(String(error));render();});
});})();</script>`;
}

export function createSDKConnectionFixtures() {
  const records = new Map();
  const get = key => {
    assert.match(key, keyPattern);
    if (!records.has(key)) records.set(key, { key, gets: [], posts: [] });
    return records.get(key);
  };
  return {
    stats: key => structuredClone(get(key)),
    allStats: () => structuredClone([...records.values()]),
    handle(request, response, url) {
      if (!url.pathname.startsWith("/sdk-connection/")) return false;
      const key = url.searchParams.get("key");
      if (!keyPattern.test(key ?? "")) { response.writeHead(400); response.end("Invalid fixture key"); return true; }
      const record = get(key);
      if (request.method === "GET" && url.pathname === "/sdk-connection/page") {
        const bytes = Buffer.from(sdkConnectionHTML(key));
        record.gets.push({ url: url.href, bytes: bytes.length, sha256: hash(bytes), bodyBase64: bytes.toString("base64"), at: Date.now() });
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }); response.end(bytes); return true;
      }
      if (request.method === "POST" && url.pathname === "/sdk-connection/post") {
        const chunks = []; let size = 0;
        request.on("data", bytes => { size += bytes.length; if (size <= 65536) chunks.push(bytes); });
        request.on("end", () => {
          if (size > 65536) { response.writeHead(413); response.end(); return; }
          const bytes = Buffer.concat(chunks); let value;
          try { value = JSON.parse(bytes.toString("utf8")); } catch { response.writeHead(400); response.end(); return; }
          // Preserve wrong/duplicate/untrusted submissions too. Acceptance is
          // checked independently after the child has actually exited.
          record.posts.push({ bytes: bytes.length, bodyBase64: bytes.toString("base64"), sha256: hash(bytes), value, at: Date.now() });
          response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify({ key, index: record.posts.length }));
        });
        return true;
      }
      response.writeHead(405); response.end(); return true;
    }
  };
}

// A byte-for-byte relay to the real Go host. Only the original connection is
// cut; the same endpoint remains available. No RPC answer is manufactured and
// no browser/backend identity or epoch is changed to force a rejection.
export async function createSDKConnectionRelay(targetEndpoint, socketDir) {
  const name = "obu-sdk-" + randomUUID();
  const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\${name}` : path.join(socketDir, name + ".sock");
  const ledger = { endpoint, targetEndpoint, connections: [], errors: [] }, live = new Set();
  const server = createServer(socket => {
    const target = createConnection(targetEndpoint), row = { id: ledger.connections.length + 1, openedAt: Date.now(), requests: [] };
    ledger.connections.push(row); live.add(socket); live.add(target);
    let buffer = Buffer.alloc(0);
    const closed = new Promise(resolve => socket.once("close", () => { row.closedAt = Date.now(); live.delete(socket); target.destroy(); resolve(); }));
    Object.defineProperty(row, "closed", { value: closed });
    Object.defineProperty(row, "cut", { value: () => { row.cutAt = Date.now(); socket.destroy(); target.destroy(); } });
    target.once("connect", () => { row.targetConnectedAt = Date.now(); });
    const targetClosed = new Promise(resolve => target.once("close", () => { row.targetClosedAt = Date.now(); live.delete(target); socket.destroy(); resolve(); }));
    Object.defineProperty(row, "targetClosed", { value: targetClosed });
    for (const stream of [socket, target]) stream.on("error", error => { row.error = describe(error); socket.destroy(); target.destroy(); });
    socket.on("data", bytes => {
      try {
        buffer = Buffer.concat([buffer, bytes]);
        if (buffer.length > 64 * 1024 * 1024 + 4) throw Error("SDK relay frame bound");
        while (buffer.length >= 4) {
          const length = os.endianness() === "LE" ? buffer.readUInt32LE(0) : buffer.readUInt32BE(0);
          if (length > 64 * 1024 * 1024) throw Error("SDK relay frame bound");
          if (buffer.length < length + 4) break;
          const body = buffer.subarray(4, length + 4); buffer = buffer.subarray(length + 4);
          row.requests.push({ at: Date.now(), bytes: body.length, sha256: hash(body), bodyBase64: body.toString("base64"), request: JSON.parse(body.toString("utf8")) });
          if (row.requests.length > 128) throw Error("SDK relay request bound");
        }
      } catch (error) { ledger.errors.push(describe(error)); socket.destroy(); target.destroy(); }
    });
    socket.pipe(target); target.pipe(socket);
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(endpoint, resolve); });
  return { endpoint, ledger,
    cut: async () => { assert.equal(ledger.connections.length, 1); ledger.connections[0].cut(); await Promise.all([ledger.connections[0].closed, ledger.connections[0].targetClosed]); },
    originalClosed: () => ledger.connections[0] ? Promise.all([ledger.connections[0].closed, ledger.connections[0].targetClosed]) : Promise.reject(Error("Missing original SDK connection")),
    snapshot: () => JSON.parse(JSON.stringify(ledger)),
    async close() {
      const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      for (const socket of live) socket.destroy();
      await closed;
      await Promise.all(ledger.connections.flatMap(row => [row.closed, row.targetClosed]));
    }
  };
}

export async function runSDKConnectionProcess(command, args, { env, onPhase, timeoutMs = 30000 } = {}) {
  const report = { pid: null, messages: [], stdout: "", stderr: "", errors: [], exitObserved: false, closeObserved: false };
  const child = spawn(command, args, { env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }); report.pid = child.pid;
  const decoder = new StringDecoder("utf8"); let buffer = "", pending = null, phaseIndex = 0, stopping = false, timer, forceTimer;
  const phases = ["armed", "blocked", "done"];
  const fail = error => {
    report.errors.push(describe(error)); if (stopping || report.closeObserved) return;
    stopping = true; child.stdin.destroy(); child.kill();
    forceTimer = setTimeout(() => { if (!report.closeObserved) child.kill("SIGKILL"); }, 1000);
  };
  const receive = message => {
    assert.equal(pending, null, "SDK caller did not wait for phase acknowledgement");
    assert.equal(message.phase, phases[phaseIndex++]); report.messages.push({ ...message, receivedAt: Date.now() });
    const current = onPhase ? onPhase(message) : Promise.resolve();
    pending = Promise.resolve(current).then(() => {
      pending = null;
      if (stopping || report.closeObserved) return;
      if (message.phase === "armed") child.stdin.write("cut\n");
      else if (message.phase === "blocked") child.stdin.write("recover\n");
      else child.stdin.end();
    }, error => { pending = null; fail(error); });
  };
  await new Promise(resolve => {
    timer = setTimeout(() => fail(Error("SDK connection caller deadline")), timeoutMs);
    child.stdout.on("data", bytes => {
      const value = decoder.write(bytes); report.stdout += value; buffer += value;
      if (Buffer.byteLength(report.stdout) > 65536) { fail(Error("SDK caller stdout bound")); return; }
      while (buffer.includes("\n") && !stopping) {
        const at = buffer.indexOf("\n"), line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
        try { receive(JSON.parse(line)); } catch (error) { fail(error); }
      }
    });
    child.stderr.on("data", bytes => { report.stderr += bytes.toString("utf8"); if (Buffer.byteLength(report.stderr) > 65536) fail(Error("SDK caller stderr bound")); });
    child.on("error", fail); child.stdin.on("error", error => { if (!stopping && !report.closeObserved) fail(error); });
    child.on("exit", (code, signal) => Object.assign(report, { exitObserved: true, exitCode: code, signal, exitedAt: Date.now() }));
    child.on("close", (code, signal) => { Object.assign(report, { closeObserved: true, exitCode: code, signal, closedAt: Date.now() }); clearTimeout(timer); clearTimeout(forceTimer); resolve(); });
  });
  // Do not run browser reads after an unconfirmed child. The actual close is
  // required even when protocol handling or a browser phase failed.
  if (pending) await pending;
  if (buffer.trim()) report.errors.push("Incomplete SDK caller JSON line");
  report.passed = report.exitObserved && report.closeObserved && report.exitCode === 0 && report.errors.length === 0 && phaseIndex === 3;
  return report;
}

export function checkSDKConnectionReceipt(item) {
  assert.equal(item.process.passed, true, JSON.stringify(item.process));
  assert.equal(item.process.exitObserved, true); assert.equal(item.process.closeObserved, true); assert.equal(item.process.exitCode, 0);
  assert.deepEqual(item.process.errors, []);
  assert.deepEqual(item.process.messages.map(value => value.phase), ["armed", "blocked", "done"]);
  const [armed, blocked, done] = item.process.messages;
  assert.equal(armed.readyText, "SDK_CONNECTION_READY"); assert.ok(blocked.firstError);
  const operations = item.kind === "go" ? ["BeginTurn", "Connect", "locator", "manualEpoch"] : ["beginTurn", "connect", "locator", "manualEpoch"];
  assert.deepEqual(Object.keys(blocked.blockedErrors).sort(), operations.sort());
  for (const error of Object.values(blocked.blockedErrors)) assert.match(error, /OBU_SDK_BROWSER_DISCONNECTED/);
  assert.match(done.oldLocatorError, /OBU_SDK_BROWSER_DISCONNECTED/);
  assert.equal(item.before.events.length, 0); assert.equal(item.blockedState.events.length, 0);
  assert.equal(item.before.documentToken, item.blockedState.documentToken);
  assert.equal(item.before.documentToken, item.after.documentToken);
  assert.deepEqual(item.after.errors, []); assert.equal(item.after.events.length, 1);
  assert.equal(item.after.receipts.length, 1); assert.equal(item.server.posts.length, 1);
  const post = item.server.posts[0], raw = Buffer.from(post.bodyBase64, "base64"), value = JSON.parse(raw.toString("utf8"));
  assert.equal(raw.length, post.bytes); assert.equal(hash(raw), post.sha256); assert.deepEqual(value, post.value);
  assert.deepEqual(value, item.after.events[0]); assert.equal(value.key, item.key); assert.equal(value.kind, "recover-action");
  assert.equal(value.target, "recover-action"); assert.equal(value.documentToken, item.before.documentToken); assert.equal(value.trusted, true);
  assert.deepEqual(item.proxy.errors, []); assert.equal(item.proxy.connections.length, 2);
  const [old, fresh] = item.proxy.connections;
  assert.ok(old.closedAt && fresh.closedAt && old.targetClosedAt && fresh.targetClosedAt && old.targetConnectedAt && fresh.targetConnectedAt);
  const clickRequests = row => row.requests.filter(v => v.request.method === "browserAction" && v.request.params?.action === "click");
  assert.equal(clickRequests(old).length, 0); assert.equal(clickRequests(fresh).length, 1);
  assert.deepEqual(clickRequests(fresh)[0].request.params.locator, [{ kind: "css", selector: "#recover-action" }]);
  const freshControl = fresh.requests.findIndex(value => value.request.method === "getControlState");
  const freshClick = fresh.requests.indexOf(clickRequests(fresh)[0]);
  assert.ok(freshControl >= 0 && freshControl < freshClick, "Fresh SDK did not explicitly obtain control before input");
  assert.equal(clickRequests(fresh)[0].request.params.control_epoch, done.freshEpoch);
  assert.equal(clickRequests(fresh)[0].request.params.turn_id, done.freshTurn);
  for (const connection of item.proxy.connections) for (const entry of connection.requests) {
    const bytes = Buffer.from(entry.bodyBase64, "base64");
    assert.equal(bytes.length, entry.bytes); assert.equal(hash(bytes), entry.sha256);
    assert.deepEqual(JSON.parse(bytes), entry.request); assert.equal(entry.request.params.session_id, item.key);
  }
  return { postBytes: raw.length, originalRequests: old.requests.length, freshRequests: fresh.requests.length };
}

export async function checkSDKConnections(options) {
  const { kind, commands, detail, connect, fixtureURL, server, socketDir, endpoint, until, worker } = options;
  detail.kind = kind; detail.cases = []; let failure;
  for (const mode of sdkConnectionModes) {
    const key = `sdk-connection-${kind}-${mode}-${randomUUID().replaceAll("-", "")}`;
    const item = { key, kind, mode }; detail.cases.push(item);
    const owner = await connect(key); let relay;
    try {
      item.url = new URL(`/sdk-connection/page?key=${key}`, fixtureURL).href;
      const tab = await owner.newTab({ url: item.url }); item.tabId = tab.id;
      const read = async () => JSON.parse(await tab.locator("#state").innerText());
      item.before = await read();
      relay = await createSDKConnectionRelay(endpoint, socketDir);
      item.process = await runSDKConnectionProcess(commands.command, [...commands.args, relay.endpoint, key, String(tab.id), mode], {
        env: commands.env,
        onPhase: async message => {
          assert.equal(message.kind, kind); assert.equal(message.mode, mode); assert.equal(message.tabId, tab.id);
          if (message.phase === "armed") {
            assert.equal(message.readyText, "SDK_CONNECTION_READY"); assert.equal(relay.ledger.connections.length, 1);
            if (mode === "eof") await relay.cut();
          } else if (message.phase === "blocked") {
            assert.ok(message.firstError);
            assert.deepEqual(Object.keys(message.blockedErrors).sort(), (kind === "go" ? ["BeginTurn", "Connect", "locator", "manualEpoch"] : ["beginTurn", "connect", "locator", "manualEpoch"]).sort());
            for (const error of Object.values(message.blockedErrors)) assert.match(error, /OBU_SDK_BROWSER_DISCONNECTED/);
            await relay.originalClosed(); assert.equal(relay.ledger.connections.length, 1, "Old SDK opened a replacement connection");
            item.blockedState = await read(); assert.deepEqual(item.blockedState, item.before);
            assert.equal(server.stats(key).posts.length, 0, "Disconnected SDK submitted a business action");
          } else {
            assert.match(message.oldLocatorError, /OBU_SDK_BROWSER_DISCONNECTED/);
            assert.equal(relay.ledger.connections.length, 2, "Fresh SDK did not open exactly one explicit connection");
          }
        }
      });
      assert.equal(item.process.passed, true, JSON.stringify(item.process));
      await until(async () => { const state = await read(); return state.receipts.length === 1 && state; }, "SDK recovery business receipt", 5000);
      item.after = await read(); item.server = server.stats(key);
      await relay.close(); item.proxy = relay.snapshot(); relay = null;
      item.proof = checkSDKConnectionReceipt(item); item.passed = true;
    } catch (error) { item.error = describe(error); failure ??= error; }
    finally {
      if (relay) { try { await relay.close(); } catch (error) { item.relayCleanupError = describe(error); failure ??= error; } item.proxy = relay.snapshot(); }
      item.server ??= server.stats(key);
      try { await owner.client.finalizeTabs([]); } catch (error) { item.cleanupError = describe(error); failure ??= error; }
      owner.close();
      try {
        item.finalNative = await worker.evaluate(`(async()=>({tabs:await chrome.tabs.query({}),targets:await chrome.debugger.getTargets()}))()`);
        assert.ok(!item.finalNative.tabs.some(tab => tab.id === item.tabId));
        assert.ok(!item.finalNative.targets.some(target => target.url === item.url));
      } catch (error) { item.finalNativeError = describe(error); failure ??= error; }
    }
  }
  detail.passed = !failure;
  if (failure) throw failure;
  return detail;
}
