import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { validateBrowserAction } from "../../apps/chrome-extension/browser-action-engine.js";
import { mcpBindingEnabled, mcpBindingCases, checkMCPBindingSelection, createMCPBindingFixture, checkMCPBindingPosts, startBindingMCP, checkMCPConnectionBinding } from "./mcp-binding-fixture.mjs";

// Node-only HTTP transport witnesses; they do not claim trusted browser input.
function request(url, value) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: value === undefined ? "GET" : "POST", agent: false, headers: { "content-type": "application/json" } }, res => {
      const chunks = []; res.on("data", chunk => chunks.push(chunk)); res.once("error", reject);
      res.once("end", () => { clearTimeout(timer); resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") }); });
    });
    const timer = setTimeout(() => req.destroy(new Error("Unit HTTP deadline")), 2000);
    req.once("error", error => { clearTimeout(timer); reject(error); }); req.end(value === undefined ? undefined : JSON.stringify(value));
  });
}
async function withFixture(run) {
  const fixture = createMCPBindingFixture(), server = http.createServer((req, res) => { if (!fixture.handle(req, res)) { res.writeHead(404); res.end(); } });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  try { return await run(fixture, `http://127.0.0.1:${server.address().port}/`); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

test("MCP binding mode is opt-in, exclusive, and cannot pass with missing or extra cases", () => {
  assert.equal(mcpBindingEnabled({}), false); assert.equal(mcpBindingEnabled({ OBU_TEST_MCP_BINDING: "1" }), true);
  for (const value of ["", "0", "true"]) assert.throws(() => mcpBindingEnabled({ OBU_TEST_MCP_BINDING: value }));
  for (const name of ["OBU_TEST_CASES", "OBU_TEST_CHOOSER_DIAGNOSTIC", "OBU_TEST_SNAPSHOT_GEOMETRY", "OBU_TEST_GEOMETRY_DPR", "OBU_TEST_BACKGROUND_PARALLEL", "OBU_TEST_MEMORY_CLIPBOARD"])
    assert.throws(() => mcpBindingEnabled({ OBU_TEST_MCP_BINDING: "1", [name]: "1" }));
  const records = mcpBindingCases.map(name => ({ name, passed: true }));
  assert.equal(checkMCPBindingSelection(records), true);
  assert.equal(checkMCPBindingSelection([{ ...records[0], passed: false }, records[1]]), false);
  for (const invalid of [[], records.slice(1), [...records, records[1]], [...records].reverse()]) assert.throws(() => checkMCPBindingSelection(invalid));
});

test("fixture retains actual HTTP bytes and rejects a stale POST, false trust or changed body", () => withFixture(async (fixture, base) => {
  const key = "unit-fixture", nonce = fixture.configure(key);
  assert.throws(() => fixture.configure(key));
  const response = await request(`${base}mcp-binding?key=${key}&phase=before`);
  assert.equal(response.status, 200); assert.match(response.text, /event.isTrusted/); assert.match(response.text, /Record stale/);
  assert.equal((await request(`${base}mcp-binding?key=other&phase=before`)).status, 404);
  const value = { key, nonce, phase: "before", step: "before", documentToken: "unit-document", sequence: 1, trusted: true };
  assert.equal((await request(`${base}mcp-binding-post?key=${key}`, value)).status, 200);
  const snapshot = fixture.snapshot(); assert.deepEqual(checkMCPBindingPosts(snapshot, ["before"]), { posts: 1, steps: ["before"] });
  for (const mutate of [s => s.posts[0].bodySHA256 = "0".repeat(64), s => s.posts[0].value.trusted = false, s => s.posts[0].value.nonce = "other"]) {
    const changed = structuredClone(snapshot); mutate(changed); assert.throws(() => checkMCPBindingPosts(changed, ["before"]));
  }
  await request(`${base}mcp-binding-post?key=${key}`, { ...value, step: "stale", sequence: 2 });
  assert.throws(() => checkMCPBindingPosts(fixture.snapshot(), ["before"]), /replayed/);
}));

function stdioChild(mode) {
  const source = `const readline=require('node:readline');const mode=${JSON.stringify(mode)};
  readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;
    if(m.method==='initialize'){process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{protocolVersion:'2025-06-18'}})+'\\n');return;}
    if(mode==='stall')return;if(mode==='malformed'){process.stdout.write('{broken}\\n');return;}
    const bytes=Buffer.from(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{text:'真实🧪',echo:m.params}})+'\\n');
    for(const byte of bytes)process.stdout.write(Buffer.from([byte]));});`;
  return (executable, args, options) => {
    assert.equal(executable, process.execPath); assert.ok(!args.includes("--socket")); assert.ok(args.includes("--socket-dir"));
    return spawn(process.execPath, ["-e", source], options);
  };
}
test("persistent MCP recorder preserves the same real child and split UTF-8 wire through stdin EOF", async () => {
  const detail = {}, client = await startBindingMCP({ executable: process.execPath, socketDir: "/isolated", sessionId: "unit", detail, spawnProcess: stdioChild("reply") });
  try {
    const pid = detail.pid;
    for (const name of ["first", "second"]) { assert.equal((await client.tool(name)).result.text, "真实🧪"); client.assertAlive(); assert.equal(detail.pid, pid); }
    assert.equal(detail.requests.length, 4); assert.equal(detail.responses.length, 3);
    assert.deepEqual(detail.stdout.trim().split("\n"), detail.responses.map(item => item.line));
    assert.deepEqual(detail.requests.map(item => JSON.parse(item.line)), detail.requests.map(item => item.message));
    assert.ok(!detail.stdout.includes("�"));
  } finally { await client.close(); }
  assert.equal(detail.exitCode, 0); assert.equal(detail.exitSignal, null); assert.equal(detail.forcedKill, undefined);
});
for (const mode of ["stall", "malformed"]) test(`MCP ${mode} failure is sticky and sends no replay`, async () => {
  const detail = {}, client = await startBindingMCP({ executable: process.execPath, socketDir: "/isolated", sessionId: "unit", detail, spawnProcess: stdioChild(mode), requestTimeoutMs: 1000 });
  await assert.rejects(client.tool("once")); const count = detail.requests.length;
  await assert.rejects(client.tool("must-not-send")); assert.equal(detail.requests.length, count);
  await assert.rejects(client.close()); assert.equal(detail.exitCode, 0); assert.equal(detail.closedAt !== undefined, true);
});

const success = result => ({ jsonrpc: "2.0", result: { isError: false, structuredContent: { jsonrpc: "2.0", result } } });
const disconnect = () => ({ jsonrpc: "2.0", result: { isError: true, content: [{ type: "text", text: "OBU_MCP_BROWSER_DISCONNECTED: unit endpoint gone" }] } });

async function workflowFixture({ oldError = disconnect, finalizeError = false } = {}) {
  return withFixture(async (fixture, base) => {
    let restart = false, serial = 0, liveTabs = [], finalizes = 0;
    const commands = [], snapshots = [], clients = [];
    const options = {
      executable: process.execPath, socketDir: "/isolated", fixtureURL: base, fixture,
      until: async callback => { const result = await callback(); assert.ok(result, "Unit condition did not hold"); return result; },
      readNative: async () => ({ tabs: liveTabs.map(id => ({ id })), targets: liveTabs.map(tabId => ({ tabId })) }),
      restartHost: async () => { restart = true; return { oldPid: 50, newPid: 51, oldEndpoint: "A", newEndpoint: "B" }; },
      save: async detail => snapshots.push(structuredClone(detail)),
      startMCP: async ({ detail, sessionId }) => {
        const index = ++serial; detail.pid = 100 + index; let closed = false;
        const client = {
          detail, close: async () => { assert.equal(closed, false); closed = true; detail.closed = true; }, assertAlive: () => assert.equal(closed, false),
          tool: async (name, args = {}) => {
            commands.push({ index, name, args: structuredClone(args) });
            if (index === 1 && restart) return oldError();
            if (name === "begin_turn") return success({ nextTurnId: `turn-${index}`, controlEpoch: index });
            assert.equal(name, "call"); const { method, params } = args;
            assert.equal(params.session_id, sessionId); assert.equal(params.turn_id, `turn-${index}`); assert.equal(params.control_epoch, index);
            if (method === "createTab") { const id = 200 + index; liveTabs.push(id); return success({ id }); }
            if (method === "finalizeTabs") {
              finalizes++; liveTabs = [];
              if (finalizeError) throw new Error("Unknown finalize outcome"); return success({ controlEpoch: index + 1 });
            }
            assert.equal(method, "browserAction"); validateBrowserAction(params);
            if (params.action === "goto") { assert.equal((await request(params.args.url)).status, 200); return success({}); }
            assert.equal(params.action, "click");
            const phase = index === 1 ? "before" : "fresh", state = fixture.snapshot();
            assert.equal(params.locator[0].name, `Record ${phase}`);
            await request(`${base}mcp-binding-post?key=${sessionId}`, { key: sessionId, nonce: state.nonce, phase, step: phase, documentToken: `synthetic-doc-${index}`, sequence: 1, trusted: true });
            return success({});
          }
        }; clients.push(client); return client;
      }
    };
    let result, error;
    try { result = await checkMCPConnectionBinding(options); } catch (caught) { error = caught; }
    return { result, error, commands, detail: snapshots.at(-1), finalizes, clients };
  });
}
test("binding workflow preserves old PID and scope, requires explicit fresh process, and finalizes both exact tabs", async () => {
  const { result, error, detail, commands, finalizes } = await workflowFixture();
  assert.equal(error, undefined); assert.equal(result.sameOldProcessSurvivedRestart, true);
  assert.equal(detail.processes.length, 2); assert.equal(detail.sameOldProcessSurvivedRestart, 101);
  assert.deepEqual(detail.tabIds, [201, 202]); assert.deepEqual(detail.removal, { tabs: [], targets: [] });
  assert.equal(finalizes, 1); assert.ok(detail.processes.every(item => item.closed));
  assert.equal(commands.filter(item => item.index === 1 && item.name === "begin_turn").length, 2);
  assert.equal(commands.filter(item => item.args?.params?.locator?.[0]?.name === "Record stale").length, 2);
  assert.deepEqual(detail.serverAtEnd.posts.map(item => item.value.step), ["before", "fresh"]);
});
test("scope rejection or transport failure cannot pass as connection binding", async () => {
  for (const oldError of [() => ({ result: { isError: true, content: [{ text: "CONTROL_EXPIRED" }] } }), () => ({ error: { message: "transport gone" } })]) {
    const { error, detail, commands } = await workflowFixture({ oldError });
    assert.ok(error); assert.equal(detail.processes.length, 1); assert.equal(detail.processes[0].closed, true);
    assert.equal(commands.filter(item => item.name === "begin_turn").length, 1);
    assert.equal(detail.serverAtEnd.posts.length, 1);
  }
});
test("an uncertain finalize is retained and never sent again during cleanup", async () => {
  const { error, finalizes, detail } = await workflowFixture({ finalizeError: true });
  assert.match(error.message, /Unknown finalize outcome/); assert.equal(finalizes, 1);
  assert.ok(detail.processes.every(item => item.closed)); assert.equal(detail.failureCleanup, undefined);
});
