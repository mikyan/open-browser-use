import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { createManagedNativeRecoveryFixture, assertManagedNativeRecoveryReceipt } from "./managed-native-recovery-fixture.mjs";

async function fixtureServer(t) {
  const fixture = createManagedNativeRecoveryFixture();
  const server = createServer((req, res) => { if (!fixture.handle(req, res)) { res.writeHead(404); res.end(); } });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { fixture, base: `http://127.0.0.1:${server.address().port}` };
}

test("one original HTTP document and POST preserve raw receipt bytes; local result fields do not submit", async t => {
  const { fixture, base } = await fixtureServer(t);
  const html = await (await fetch(base + fixture.paths.form)).text();
  assert.match(html, /<\/form>[\s\S]*id="note"/); assert.match(html, /id="review" type="button"/); assert.match(html, /#state\{display:none\}/);
  const original = { documentId: "original-document", draft: fixture.draft, state: { documentToken: fixture.stats().originalToken } };
  const body = new URLSearchParams({ workflowId: fixture.workflowId, documentToken: original.state.documentToken, draft: fixture.draft, submits: "1", trusted: "true" });
  const response = await fetch(base + fixture.paths.receipt, { method: "POST", body }); assert.equal(response.status, 200); const receipt = await response.json();
  const current = { ...original, state: { ...original.state, submits: 1, receipt, overflow: false, heldKeys: [], heldButtons: [] } };
  const proof = assertManagedNativeRecoveryReceipt(fixture.stats(), original, current); assert.equal(proof.posts, 1); assert.equal(proof.gets, 1);
  assert.throws(() => assertManagedNativeRecoveryReceipt(fixture.stats(), original, { ...current, documentId: "replacement-document" }));
  assert.throws(() => assertManagedNativeRecoveryReceipt(fixture.stats(), original, { ...current, state: { ...current.state, heldKeys: ["ShiftLeft"] } }));
  const replay = await fetch(base + fixture.paths.receipt, { method: "POST", body }); assert.equal(replay.status, 409); await replay.arrayBuffer();
  const reload = await fetch(base + fixture.paths.form); assert.equal(reload.status, 409); await reload.arrayBuffer();
  assert.throws(() => assertManagedNativeRecoveryReceipt(fixture.stats(), original, current), /reopened/);
});

test("fixture rejects foreign workflow, duplicate fields and oversized original request without consuming a receipt", async t => {
  const { fixture, base } = await fixtureServer(t);
  await (await fetch(base + fixture.paths.form)).arrayBuffer();
  const fields = { workflowId: fixture.workflowId, documentToken: fixture.stats().originalToken, draft: fixture.draft, submits: "1", trusted: "true" };
  for (const body of [new URLSearchParams({ ...fields, workflowId: "foreign" }).toString(), new URLSearchParams(fields).toString() + "&submits=1", "x=" + "a".repeat(9000)]) {
    const response = await fetch(base + fixture.paths.receipt, { method: "POST", body }); assert.equal(response.status, 400); await response.arrayBuffer();
  }
  assert.equal(fixture.stats().committed, false);
});
