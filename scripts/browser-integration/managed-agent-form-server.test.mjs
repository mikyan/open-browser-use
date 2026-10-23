import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startManagedAgentFormServer } from "./managed-agent-form-server.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const sourceNames = ["managed-agent-form-fixture.mjs", "managed-agent-form-app.jsx", "managed-agent-form-server.mjs", "research-request-ledger.mjs", "fixture-listener.mjs"];
async function start(t) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "obu-form-server-unit-"));
  const server = await startManagedAgentFormServer({ output: path.join(parent, "original") });
  t.after(async () => { await server.close("test-cleanup").catch(() => {}); });
  return server;
}
async function readArtifact(server, ref) {
  const bytes = await fs.readFile(path.join(server.ready.output, ref.file));
  assert.equal(bytes.length, ref.bytes); assert.equal(hash(bytes), ref.sha256);
  return JSON.parse(bytes);
}
async function partialPost(server) {
  const request = httpRequest(server.ready.tasks[0].url + "/submit", {
    method: "POST", headers: { "Content-Type": "application/json", "Content-Length": "2", Expect: "100-continue" }
  });
  request.on("error", () => {});
  const response = new Promise((resolve, reject) => {
    request.once("response", reply => { reply.resume(); reply.once("end", () => resolve(reply.statusCode)); reply.once("error", reject); });
    request.once("error", reject);
  });
  response.catch(() => {});
  await new Promise((resolve, reject) => { request.once("continue", resolve); request.once("error", reject); request.flushHeaders(); });
  request.write("{");
  return { request, response };
}

test("public four-slot contract, both loopbacks, private route denial and complete ledger", { timeout: 20000 }, async t => {
  const server = await start(t), { ready } = server;
  assert.deepEqual(Object.keys(ready).sort(), ["version", "kind", "pid", "node", "startedAt", "output", "origin", "sources", "app", "tasks"].sort());
  assert.equal(ready.version, 1); assert.equal(ready.kind, "managed-agent-form");
  assert.deepEqual(ready.tasks.map(({ slot, round, side }) => [slot, round, side]), [[1, 1, "obu"], [2, 1, "codex"], [3, 2, "codex"], [4, 2, "obu"]]);
  assert.equal(new Set(ready.tasks.map(task => task.taskId)).size, 4);
  for (const task of ready.tasks) {
    assert.deepEqual(Object.keys(task).sort(), ["slot", "round", "side", "taskId", "url", "instructions"].sort());
    assert.equal(task.url, `${ready.origin}/agent-form/${task.taskId}`);
    assert.ok(task.instructions.length > 0); assert.equal(task.instructions.includes(task.taskId), false);
    const response = await fetch(task.url); assert.equal(response.status, 200); assert.match(await response.text(), /<html|<!doctype/i);
  }
  assert.equal(ready.tasks[0].instructions, ready.tasks[1].instructions);
  assert.equal(ready.tasks[2].instructions, ready.tasks[3].instructions);
  assert.notEqual(ready.tasks[0].instructions, ready.tasks[2].instructions);
  assert.deepEqual(Object.keys(ready.sources), sourceNames);
  for (const [name, sha] of Object.entries(ready.sources)) assert.equal(sha, hash(await fs.readFile(new URL(name, import.meta.url))));
  const appBytes = await fs.readFile(path.join(ready.output, "app.bundle.js"));
  assert.deepEqual(ready.app, { sha256: hash(appBytes), bytes: appBytes.length });
  for (const hostname of ["127.0.0.1", "localhost", "[::1]"]) {
    const url = new URL(ready.tasks[0].url + "/app.js"); url.hostname = hostname;
    const response = await fetch(url); assert.equal(response.status, 200); assert.equal(hash(Buffer.from(await response.arrayBuffer())), ready.app.sha256);
  }
  for (const route of ["/server-evidence.json", "/request-ledger.json", "/__stats"]) {
    const response = await fetch(ready.origin + route); assert.equal(response.status, 404); await response.text();
  }
  const rejected = await fetch(ready.origin + "/missing?original=query", { method: "POST", body: "synthetic-private-unit-body" });
  assert.equal(rejected.status, 404); await rejected.text();
  await new Promise((resolve, reject) => {
    const request = httpRequest(ready.tasks[0].url, { headers: { Host: "outside.invalid" } }, response => {
      assert.equal(response.statusCode, 400); response.resume(); response.once("end", resolve); response.once("error", reject);
    });
    request.once("error", reject); request.end();
  });
  await assert.rejects(fs.readFile(path.join(ready.output, "server-evidence.json")), { code: "ENOENT" });
  const closed = await server.close("unit-finished"); assert.equal(await server.close("ignored-second-close"), closed);
  assert.equal(closed.complete, true); assert.equal(closed.reason, "unit-finished"); assert.equal(closed.serverClosed, true); assert.equal(closed.openConnections, 0);
  assert.deepEqual(await readArtifact(server, closed.ready), ready);
  await readArtifact(server, closed.serverEvidence); await readArtifact(server, closed.appBuild);
  const ledger = await readArtifact(server, closed.requestLedger);
  assert.equal(ledger.complete, true); assert.equal(ledger.received, 12); assert.equal(ledger.pending, 0); assert.equal(ledger.overflow, 0);
  assert.equal(ledger.requests.filter(row => row.status === 404).length, 4);
  assert.ok(ledger.requests.every(row => row.requestComplete && row.responseFinishedAt && !row.requestAbortedAt && !row.responseAbortedAt));
  assert.deepEqual([closed.requestLedger.responseFinished, closed.requestLedger.responseAborted, closed.requestLedger.requestAborted], [12, 0, 0]);
  assert.equal(ledger.requests.at(-2).url, "/missing?original=query"); assert.equal(ledger.requests.at(-1).status, 400);
  assert.doesNotMatch(JSON.stringify(ledger), /synthetic-private-unit-body/);
  await assert.rejects(startManagedAgentFormServer({ output: ready.output }), { code: "EEXIST" });
});

test("normal stop waits for the original incomplete POST to actually finish", { timeout: 15000 }, async t => {
  const server = await start(t), pending = await partialPost(server);
  let complete = false;
  const closing = server.close("during-original-request").then(value => { complete = true; return value; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(complete, false);
  pending.request.end("}"); assert.equal(await pending.response, 400);
  const closed = await closing, ledger = await readArtifact(server, closed.requestLedger);
  assert.equal(closed.complete, true); assert.equal(ledger.received, 1); assert.equal(ledger.pending, 0);
  assert.equal(ledger.requests[0].requestComplete, true); assert.ok(ledger.requests[0].responseFinishedAt);
  assert.equal(closed.requestLedger.requestAborted, 0); assert.equal(closed.requestLedger.responseAborted, 0);
});

test("original aborted POST and response stay explicit in sealed evidence", { timeout: 15000 }, async t => {
  const server = await start(t), pending = await partialPost(server);
  const actualClose = new Promise(resolve => pending.request.once("close", resolve));
  pending.request.destroy(); await actualClose;
  const closed = await server.close("after-original-abort"), ledger = await readArtifact(server, closed.requestLedger);
  assert.equal(ledger.received, 1); assert.equal(ledger.pending, 0);
  assert.equal(ledger.requests[0].requestComplete, false); assert.ok(ledger.requests[0].requestAbortedAt);
  assert.equal(ledger.requests[0].responseFinishedAt, null); assert.ok(ledger.requests[0].responseAbortedAt);
  assert.equal(closed.requestLedger.requestAborted, 1); assert.equal(closed.requestLedger.responseAborted, 1);
});

test("shutdown deadline preserves forced closure as failure and retains aborted traffic", { timeout: 15000 }, async t => {
  const server = await start(t), pending = await partialPost(server);
  await assert.rejects(server.close("original-request-never-ended"), /did not close within 5 seconds/);
  await assert.rejects(pending.response);
  const closed = JSON.parse(await fs.readFile(path.join(server.ready.output, "closed.json"), "utf8"));
  assert.equal(closed.complete, false); assert.equal(closed.serverClosed, true); assert.equal(closed.openConnections, 0);
  assert.ok(closed.failures.some(message => message.includes("did not close within 5 seconds")));
  const ledger = await readArtifact(server, closed.requestLedger); await readArtifact(server, closed.serverEvidence);
  assert.equal(ledger.received, 1); assert.equal(ledger.pending, 0); assert.equal(closed.requestLedger.requestAborted, 1);
  assert.equal(closed.requestLedger.responseAborted, 1); assert.equal(closed.requestLedger.responseFinished, 0);
});

test("relative output is rejected without starting a server", async () => {
  await assert.rejects(startManagedAgentFormServer({ output: "not-absolute" }), /fresh absolute/);
});
