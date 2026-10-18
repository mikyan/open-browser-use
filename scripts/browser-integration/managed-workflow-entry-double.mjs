// Test-only CLI/MCP transport double. Never used by the real workflow runner.
// It verifies managed selectors and relays to a unit-test IPC server, not Chrome.
import assert from "node:assert/strict";
import { createConnection } from "node:net";
import { createInterface } from "node:readline";
const args = process.argv.slice(2), config = JSON.parse(process.env.OBU_WORKFLOW_ENTRY_DOUBLE);
const flag = name => { const at = args.indexOf(name); assert.ok(at > 0 && args.lastIndexOf(name) === at); return args[at + 1]; };
assert.equal(flag("--managed"), config.name); assert.equal(flag("--managed-root"), config.root);
assert.equal(flag("--session-id"), config.sessionId); assert.equal(args.includes("--socket"), false);
assert.ok(args[0] === "call" || args[0] === "mcp");
const socket = createConnection(config.endpoint);
let pending, buffer = Buffer.alloc(0), sequence = 0;
socket.on("error", error => { pending?.reject(error); process.exitCode = 1; });
socket.on("data", bytes => {
  buffer = Buffer.concat([buffer, bytes]);
  while (buffer.length >= 4) {
    const size = buffer.readUInt32LE(); if (buffer.length < size + 4) break;
    const response = JSON.parse(buffer.subarray(4, size + 4)); buffer = buffer.subarray(size + 4);
    const item = pending; pending = undefined; assert.ok(item && item.id === response.id); item.resolve(response);
  }
});
const request = (method, params) => new Promise((resolve, reject) => {
  assert.equal(pending, undefined); const id = ++sequence; pending = { id, resolve, reject };
  const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method, params })), header = Buffer.alloc(4); header.writeUInt32LE(body.length); socket.write(Buffer.concat([header, body]));
});
try {
  await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  if (args[0] === "call") {
    const response = await request(flag("--method"), JSON.parse(flag("--params"))); console.log(JSON.stringify(response)); if (response.error) process.exitCode = 1;
  } else {
    for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
      const message = JSON.parse(line); if (message.id === undefined) { assert.equal(message.method, "notifications/initialized"); continue; }
      let result;
      if (message.method === "initialize") result = { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "test-double", version: "1" } };
      else { assert.equal(message.method, "tools/call"); assert.equal(message.params.name, "call"); result = { isError: false, content: [], structuredContent: await request(message.params.arguments.method, message.params.arguments.params) }; }
      console.log(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    }
  }
} finally { socket.end(); }
