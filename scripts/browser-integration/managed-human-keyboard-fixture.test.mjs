import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { createServer } from "node:http";
import { createManagedHumanKeyboardFixture } from "./managed-human-keyboard-fixture.mjs";
import { humanKeyboardCases, assertManagedHumanKeyboardReceipt } from "./managed-human-keyboard.mjs";
import { listenFixture } from "./fixture-listener.mjs";

function completeControls() { return Object.fromEntries(humanKeyboardCases.map(spec => [spec.id, spec.kind === "contenteditable"
  ? { kind: spec.kind, textContent: spec.initial, innerHTML: spec.initial + "<br><br>", innerText: spec.initial + "\n\n", lineBreaks: 2 }
  : { kind: spec.kind, value: spec.kind === "textarea" ? spec.expectedValue : spec.initial }])); }

test("keyboard fixture keeps one original page and unique immediate Enter-submit bytes", async () => {
  const fixture = createManagedHumanKeyboardFixture(), server = createServer((request, response) => { if (!fixture.handle(request, response)) response.writeHead(404).end(); });
  await listenFixture(server); const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const html = await (await fetch(origin + "/human-keyboard-form")).text(); assert.doesNotThrow(() => new vm.Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]));
    assert.equal((html.match(/<textarea /g) ?? []).length, 3); assert.equal((html.match(/contenteditable="true"/g) ?? []).length, 2); assert.match(html, /grid-template-columns:repeat\(3/);
    const token = fixture.stats().requests[0].documentToken, controls = completeControls();
    const body = JSON.stringify({ workflowId: fixture.workflowId, documentToken: token, submits: 1, controls });
    const response = await fetch(origin + "/human-keyboard-receipt", { method: "POST", body }); assert.equal(response.status, 200); const receipt = await response.json();
    const original = { documentId: "original-document", state: { documentToken: token } }, after = { documentId: original.documentId, state: { documentToken: token, submits: 1, eventOverflow: false, heldKeys: [], controls, receipt } };
    assert.equal(assertManagedHumanKeyboardReceipt({ stats: fixture.stats(), original, after }).posts, 1);
    const changed = structuredClone(after); changed.state.heldKeys = ["Enter"]; assert.throws(() => assertManagedHumanKeyboardReceipt({ stats: fixture.stats(), original, after: changed }));
    assert.equal((await fetch(origin + "/human-keyboard-receipt", { method: "POST", body })).status, 409);
    assert.throws(() => assertManagedHumanKeyboardReceipt({ stats: fixture.stats(), original, after }));
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test("keyboard fixture rejects foreign identity, missing newline and duplicate Enter business submission", async () => {
  const fixture = createManagedHumanKeyboardFixture(), server = createServer((request, response) => { if (!fixture.handle(request, response)) response.writeHead(404).end(); });
  await listenFixture(server); const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    await (await fetch(origin + "/human-keyboard-form")).text();
    const body = { workflowId: fixture.workflowId, documentToken: fixture.stats().requests[0].documentToken, submits: 1, controls: completeControls() };
    for (const mutate of [row => { row.documentToken = "foreign"; }, row => { row.submits = 2; }, row => { row.controls[humanKeyboardCases[0].id].value = humanKeyboardCases[0].initial; }]) {
      const changed = structuredClone(body); mutate(changed); const response = await fetch(origin + "/human-keyboard-receipt", { method: "POST", body: JSON.stringify(changed) });
      assert.equal(response.status, 400); await response.text(); assert.equal(fixture.stats().committed, false);
    }
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
