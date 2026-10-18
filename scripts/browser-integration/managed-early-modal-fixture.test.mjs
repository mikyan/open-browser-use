import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { Script } from "node:vm";
import { listenFixture } from "./fixture-listener.mjs";
import { createManagedEarlyModalFixture, managedEarlyModalCases, managedEarlyModalUnicode } from "./managed-early-modal-fixture.mjs";

async function withFixture(caseId, operation, answerMode = "cancel-only") {
  let fixture; const server = createServer((req, res) => { if (!fixture?.handle(req, res)) { res.writeHead(404); res.end(); } });
  await listenFixture(server); fixture = createManagedEarlyModalFixture({ baseURL: `http://127.0.0.1:${server.address().port}`, caseId, answerMode });
  try { await operation(fixture); } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
function body(f) { const s = f.stats(), answer = f.answerMode === "cancel-only" ? null : managedEarlyModalUnicode; return { workflowId: f.workflowId, caseId: f.caseId, documentToken: s.documentToken, events: [{ phase: "before", type: "prompt" }, { phase: "after", type: "prompt", answer }], answer, postAttempts: 1 }; }
async function post(f, value = body(f)) { return fetch(f.urls.receipt, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) }); }
async function enter(f) {
  const html = await (await fetch(f.urls.source)).text();
  const gate = fetch(f.urls.gate); while (!f.stats().requests.some(row => row.url.endsWith("/gate"))) await new Promise(resolve => setTimeout(resolve, 1));
  assert.match(f.releaseGate().scope, /not native modal proof/); assert.equal(await (await gate).text(), "release-original-once");
  await fetch(f.urls.entered); return html;
}

for (const caseId of managedEarlyModalCases) test(`${caseId}: one original gate/document/receipt; HTTP evidence is not native proof`, async () => withFixture(caseId, async f => {
  const html = await enter(f); assert.doesNotThrow(() => new Script(html.match(/<script>([\s\S]*)<\/script>/)[1]));
  assert.equal((html.match(/window\.prompt\(/g) ?? []).length, 1); assert.ok(!html.includes("location.replace"));
  const response = await post(f); assert.equal(response.status, 200); const receipt = await response.json();
  assert.deepEqual(f.verify({ url: f.urls.source, state: { ...body(f), phase: "committed", error: null }, result: receipt }), receipt);
  const hit = f.stats().requests.find(row => row.method === "POST"); assert.equal(Buffer.from(hit.body.base64, "base64").toString(), JSON.stringify(body(f)));
}));
test("future real viewer fixture accepts exact Unicode, without adding an input or native authority", async () => withFixture("warm-document", async f => {
  await enter(f); const response = await post(f); assert.equal(response.status, 200); const receipt = await response.json();
  assert.equal(receipt.answer, managedEarlyModalUnicode); assert.deepEqual(f.verify({ url: f.urls.source, state: { ...body(f), phase: "committed", error: null }, result: receipt }), receipt);
}, "viewer-unicode"));
test("gate cannot release before original request or release twice", async () => withFixture("cold-runtime", async f => { assert.throws(() => f.releaseGate()); await enter(f); assert.throws(() => f.releaseGate()); }));
test("original document GET cannot replay", async () => withFixture("cold-runtime", async f => { assert.equal((await fetch(f.urls.source)).status, 200); assert.equal((await fetch(f.urls.source)).status, 409); }));
test("business POST cannot replay", async () => withFixture("cold-runtime", async f => { await enter(f); assert.equal((await post(f)).status, 200); assert.equal((await post(f)).status, 409); }));
test("wrong original document token is rejected", async () => withFixture("cold-runtime", async f => { await enter(f); assert.equal((await post(f, { ...body(f), documentToken: "replacement" })).status, 400); }));
test("answer cannot silently change from cancel to Unicode", async () => withFixture("cold-runtime", async f => { await enter(f); assert.equal((await post(f, { ...body(f), answer: managedEarlyModalUnicode })).status, 400); }));
test("entered marker before release cannot substitute for original sequencing", async () => withFixture("cold-runtime", async f => { await fetch(f.urls.source); assert.equal((await fetch(f.urls.entered)).status, 409); }));
test("receipt cannot precede original gate and marker", async () => withFixture("cold-runtime", async f => { await fetch(f.urls.source); assert.equal((await post(f)).status, 400); }));
test("query and unknown original routes are rejected", async () => withFixture("cold-runtime", async f => { assert.equal((await fetch(f.urls.source + "?replay=1")).status, 400); assert.equal((await fetch(f.urls.source.replace("/source", "/unknown"))).status, 404); }));
test("request and body bounds reject excess rather than incomplete receipt", async () => withFixture("cold-runtime", async f => {
  await enter(f); assert.equal((await fetch(f.urls.receipt, { method: "POST", body: "x".repeat(16385) })).status, 413);
  for (let i = f.stats().requests.length; i < 17; i++) await fetch(f.urls.source);
  assert.equal(f.stats().requests.length, 16); assert.equal(f.stats().overflow, true);
}));
