import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { EventEmitter } from "node:events";
import { createResearchRequestLedger } from "./research-request-ledger.mjs";

async function serve(t, handle, limits) {
  const ledger = createResearchRequestLedger(limits);
  const server = createServer((request, response) => { ledger.observe(request, response); handle(request, response); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { ledger, url: `http://127.0.0.1:${server.address().port}` };
}

test("ledger includes rejected methods and exact query without request headers or body", async t => {
  const { ledger, url } = await serve(t, (request, response) => { response.writeHead(404); response.end("Missing"); });
  const response = await fetch(`${url}/unknown?variant=3`, { method: "POST", body: "synthetic-private-body",
    headers: { Cookie: "synthetic-private-cookie", Authorization: "synthetic-private-authorization" } });
  assert.equal(response.status, 404); await response.text();
  const sealed = await ledger.seal();
  assert.equal(sealed.complete, true); assert.equal(sealed.received, 1); assert.equal(sealed.pending, 0);
  const [row] = sealed.requests;
  assert.equal(row.sequence, 1); assert.equal(row.method, "POST"); assert.equal(row.url, "/unknown?variant=3");
  assert.equal(row.status, 404); assert.equal(row.requestComplete, true);
  assert.equal(row.requestAbortedAt, null); assert.equal(row.responseAbortedAt, null);
  assert.ok(Date.parse(row.receivedAt) <= Date.parse(row.responseFinishedAt));
  assert.ok(Date.parse(row.responseFinishedAt) <= Date.parse(sealed.sealedAt));
  assert.doesNotMatch(JSON.stringify(sealed), /synthetic-private|[Aa]uthorization|[Cc]ookie/);
});

test("sealing waits for the last actual response finish", async t => {
  let finishResponse, firstChunk;
  const arrived = new Promise(resolve => { firstChunk = resolve; });
  const { ledger, url } = await serve(t, (_request, response) => {
    finishResponse = () => response.end("finished"); response.writeHead(200); response.write("started");
  });
  const received = new Promise((resolve, reject) => {
    httpRequest(url, response => { response.on("data", firstChunk); response.on("end", resolve); response.on("error", reject); }).end();
  });
  await arrived;
  let sealed = false;
  const sealing = ledger.seal().then(value => { sealed = true; return value; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(sealed, false);
  finishResponse(); await received;
  const snapshot = await sealing;
  assert.equal(snapshot.complete, true); assert.equal(snapshot.requests[0].status, 200);
  assert.ok(snapshot.requests[0].responseFinishedAt); assert.equal(snapshot.requests[0].responseAbortedAt, null);
  assert.throws(() => ledger.observe({}, {}), /already sealing/);
});

test("a partial response closed by the client is aborted rather than finished", async t => {
  const { ledger, url } = await serve(t, (_request, response) => { response.writeHead(200); response.write("partial"); });
  await new Promise(resolve => {
    const request = httpRequest(url, response => { response.once("data", () => request.destroy()); });
    request.once("close", resolve); request.end();
  });
  const snapshot = await ledger.seal();
  assert.equal(snapshot.complete, true); assert.equal(snapshot.pending, 0);
  assert.equal(snapshot.requests[0].status, 200); assert.equal(snapshot.requests[0].requestComplete, true);
  assert.equal(snapshot.requests[0].responseFinishedAt, null); assert.ok(snapshot.requests[0].responseAbortedAt);
  assert.equal(snapshot.requests[0].responseAbortReason, "response-closed-before-finish");
});

test("an interrupted POST body has a received request and explicit abort evidence", async t => {
  let arrived;
  const arrival = new Promise(resolve => { arrived = resolve; });
  const { ledger, url } = await serve(t, request => { request.on("data", arrived); });
  const request = httpRequest(url + "/submit", { method: "POST", headers: { "Content-Length": "100" } });
  request.on("error", () => {}); request.write("partial");
  await arrival; request.destroy();
  const snapshot = await ledger.seal();
  assert.equal(snapshot.complete, true); assert.equal(snapshot.received, 1); assert.equal(snapshot.pending, 0);
  const [row] = snapshot.requests;
  assert.equal(row.method, "POST"); assert.equal(row.url, "/submit"); assert.equal(row.status, null);
  assert.equal(row.requestComplete, false); assert.ok(row.requestAbortedAt);
  assert.equal(row.responseFinishedAt, null); assert.ok(row.responseAbortedAt);
});

test("overflow is bounded and cannot claim a complete ledger", async t => {
  const { ledger, url } = await serve(t, (_request, response) => response.end("ok"), { maxRequests: 2 });
  for (let i = 0; i < 4; i++) await (await fetch(`${url}/${i}`)).text();
  const snapshot = await ledger.seal();
  assert.equal(snapshot.complete, false); assert.equal(snapshot.received, 4); assert.equal(snapshot.overflow, 2);
  assert.equal(snapshot.requests.length, 2); assert.deepEqual(snapshot.failures, ["Research request ledger overflow"]);
});

test("oversized URL metadata is bounded and invalidates completeness", async t => {
  const { ledger, url } = await serve(t, (_request, response) => response.end("ok"), { maxURLBytes: 8 });
  await (await fetch(`${url}/long-metadata?ignored=1`)).text();
  const snapshot = await ledger.seal();
  assert.equal(snapshot.complete, false); assert.equal(snapshot.requests[0].metadataTruncated, true);
  assert.equal(snapshot.requests[0].url, "/long-me");
});

test("a missing terminal event is left unsettled and invalidates completeness", async () => {
  const ledger = createResearchRequestLedger(), request = new EventEmitter(), response = new EventEmitter();
  Object.assign(request, { url: "/unfinished", method: "POST", complete: false });
  ledger.observe(request, response);
  const snapshot = await ledger.seal({ timeoutMs: 5 });
  assert.equal(snapshot.complete, false); assert.equal(snapshot.pending, 1);
  assert.equal(snapshot.requests[0].responseFinishedAt, null); assert.equal(snapshot.requests[0].responseAbortedAt, null);
  assert.deepEqual(snapshot.failures, ["Research request ledger has unsettled messages"]);
});
