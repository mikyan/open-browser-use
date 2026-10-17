import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createManagedHumanFixture, assertManagedHumanReceipt } from "./managed-human-check-fixture.mjs";
import { listenFixture } from "./fixture-listener.mjs";

test("synthetic handoff fixture preserves exact one-shot POST bytes and original document identity", async () => {
  const fixture = createManagedHumanFixture();
  const server = createServer((request, response) => { if (!fixture.handle(request, response)) { response.writeHead(404); response.end(); } });
  await listenFixture(server); const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const html = await (await fetch(origin + "/human-form")).text();
    assert.match(html, /Original draft/); assert.match(html, /Hold target for disconnect/);
    const token = fixture.stats().requests[0].documentToken;
    const fields = { workflowId: fixture.workflowId, documentToken: token, draft: fixture.expectedDraft, humanClicks: "1", humanTrusted: "true", submitCount: "1", heldKeys: "0", heldButtons: "0", maximumScrollY: "500" };
    const body = new URLSearchParams(fields), response = await fetch(origin + "/human-receipt", { method: "POST", body });
    assert.equal(response.status, 200); const receipt = await response.json();
    const original = { state: { documentToken: token } }, after = { draft: fixture.expectedDraft, state: { documentToken: token, eventOverflow: false, submits: 1, heldKeys: [], heldButtons: [], clicks: [{ trusted: true }] } };
    const proof = assertManagedHumanReceipt(fixture.stats(), original, after, receipt);
    assert.deepEqual(Buffer.from(proof.post.base64, "base64"), Buffer.from(body.toString()));
    const tampered = fixture.stats(); tampered.requests[1].body.base64 = Buffer.from("different=body").toString("base64");
    assert.throws(() => assertManagedHumanReceipt(tampered, original, after, receipt));
    assert.throws(() => assertManagedHumanReceipt(fixture.stats(), original, { ...after, state: { ...after.state, documentToken: "successor" } }, receipt));
    assert.throws(() => assertManagedHumanReceipt(fixture.stats(), original, { ...after, state: { ...after.state, heldKeys: ["ShiftLeft"] } }, receipt));
    assert.equal((await fetch(origin + "/human-receipt", { method: "POST", body })).status, 409);
    assert.throws(() => assertManagedHumanReceipt(fixture.stats(), original, after, receipt));
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test("a wrong original form, unsubmitted draft, or unreleased input cannot commit the local receipt", async () => {
  const fixture = createManagedHumanFixture();
  const server = createServer((request, response) => { if (!fixture.handle(request, response)) { response.writeHead(404); response.end(); } });
  await listenFixture(server); const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    await (await fetch(origin + "/human-form")).text();
    const fields = { workflowId: fixture.workflowId, documentToken: fixture.stats().requests[0].documentToken, draft: fixture.expectedDraft, humanClicks: "1", humanTrusted: "true", submitCount: "1", heldKeys: "0", heldButtons: "0", maximumScrollY: "500" };
    for (const replacement of [{ documentToken: "not-original" }, { draft: fixture.draft }, { heldKeys: "1" }, { heldButtons: "1" }, { humanTrusted: "false" }, { maximumScrollY: "0" }]) {
      const response = await fetch(origin + "/human-receipt", { method: "POST", body: new URLSearchParams({ ...fields, ...replacement }) });
      assert.equal(response.status, 400); await response.text(); assert.equal(fixture.stats().committed, false);
    }
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
