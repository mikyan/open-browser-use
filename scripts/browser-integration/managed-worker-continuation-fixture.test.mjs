import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import vm from "node:vm";
import { createManagedNativeRecoveryFixture, assertManagedNativeRecoveryReceipt, assertManagedNativeRecoveryContinuationReceipt, recoveryAfterNote } from "./managed-native-recovery-fixture.mjs";

async function fixtureServer(t, options = { continuation: true }) {
  const fixture = createManagedNativeRecoveryFixture(options);
  const server = createServer((req, res) => { if (!fixture.handle(req, res)) { res.writeHead(404); res.end(); } });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, fields) => {
    const response = await fetch(base + path, fields === undefined ? {} : { method: "POST", body: typeof fields === "string" ? fields : new URLSearchParams(fields) });
    return { status: response.status, text: await response.text() };
  };
  return { fixture, base, request };
}

async function committedFixture(t) {
  const value = await fixtureServer(t), { fixture, request } = value;
  const html = (await request(fixture.paths.form)).text;
  const initialFields = { workflowId: fixture.workflowId, documentToken: fixture.stats().originalToken, draft: fixture.draft, submits: "1", trusted: "true" };
  const response = await request(fixture.paths.receipt, initialFields); assert.equal(response.status, 200);
  const receipt = JSON.parse(response.text);
  const fields = { workflowId: fixture.workflowId, documentToken: fixture.stats().originalToken, originalReceiptId: receipt.receiptId, draftSHA256: receipt.draftSHA256, note: fixture.expectedNote, reviews: "1", reviewTrusted: "true", submits: "1", trusted: "true" };
  return { ...value, html, receipt, fields, initialFields };
}

// A small VM checks the emitted fixture handlers, not browser trust or recovery.
// Its explicitly mocked events cannot replace the runner's native event proof.
function fixtureDocument(html, base) {
  const listeners = new Map(), nodes = new Map();
  for (const id of ["state", "draft", "submit", "receipt", "note", "review", "review-count", "form", "continuation-form", "confirm-review", "continuation-receipt"]) {
    const handlers = new Map();
    nodes.set(id, { id, value: "", textContent: "", disabled: id === "confirm-review", addEventListener(type, callback) { handlers.set(type, callback); },
      emit(type, values = {}) { return handlers.get(type)?.({ type, target: this, isTrusted: true, preventDefault() {}, ...values }); } });
  }
  const document = { querySelector(selector) { return nodes.get(selector.slice(1)); }, addEventListener(type, callback) { listeners.set(type, callback); } };
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  vm.runInNewContext(script, { document, URLSearchParams, fetch: (url, options) => fetch(base + url, options) });
  return { nodes, read() { return { documentId: "original-document", draft: nodes.get("draft").value, note: nodes.get("note").value, state: JSON.parse(nodes.get("state").textContent), confirmDisabled: nodes.get("confirm-review").disabled, continuationReceiptText: nodes.get("continuation-receipt").textContent }; },
    input(id, value) { const target = nodes.get(id); target.value = value; listeners.get("input")({ type: "input", target, isTrusted: true, inputType: "insertText", data: value }); } };
}

test("continuation is explicit; the default page and request contract stay one-shot", async t => {
  const normal = await fixtureServer(t, {}), optIn = await fixtureServer(t);
  const normalHTML = (await normal.request(normal.fixture.paths.form)).text;
  const continuationHTML = (await optIn.request(optIn.fixture.paths.form)).text;
  assert.equal(normal.fixture.paths.followup, undefined); assert.equal(normal.fixture.expectedNote, undefined);
  assert.doesNotMatch(normalHTML, /continuation-form|confirm-review|managed-recovery-followup/);
  assert.equal((await normal.request("/managed-recovery-followup", {})).status, 404); assert.equal(normal.fixture.stats().requests.length, 1);
  const end = '<pre id="state"></pre>';
  assert.equal(normalHTML.split(end)[0], continuationHTML.split(end)[0], "All existing visible markup and styles precede the appended continuation section unchanged");
  assert.match(continuationHTML, /<form id="continuation-form"><button id="confirm-review" type="submit" disabled>Confirm reviewed result/);
  assert.equal(optIn.fixture.expectedNote, recoveryAfterNote);
  assert.throws(() => createManagedNativeRecoveryFixture({ continuation: "true" }));
});

test("emitted handlers keep one original document, wait for the exact human note/review, then submit one linked confirmation", async t => {
  const { fixture, base, request } = await fixtureServer(t);
  const page = fixtureDocument((await request(fixture.paths.form)).text, base), original = page.read();
  assert.equal(page.read().confirmDisabled, true);
  page.input("draft", fixture.draft); await page.nodes.get("form").emit("submit");
  const first = page.read(); assertManagedNativeRecoveryReceipt(fixture.stats(), original, first);
  assert.equal(first.confirmDisabled, true);
  page.input("note", fixture.expectedNote + "wrong"); await page.nodes.get("review").emit("click");
  assert.equal(page.read().confirmDisabled, true);
  page.input("note", fixture.expectedNote); assert.equal(page.read().confirmDisabled, false);
  assert.equal(fixture.stats().requests.length, 2, "Note and review gestures must not send either business request");
  await page.nodes.get("continuation-form").emit("submit");
  const current = page.read(), proof = assertManagedNativeRecoveryContinuationReceipt(fixture.stats(), original, current);
  assert.equal(proof.gets, 1); assert.equal(proof.posts, 2); assert.equal(proof.followup.receipt.originalReceiptId, proof.initial.receipt.receiptId);
  assert.equal(current.confirmDisabled, true);
  assert.throws(() => assertManagedNativeRecoveryReceipt(fixture.stats(), original, current), /never be replayed/, "The original assertion must not silently accept a second business operation");
});

test("continuation rejects an absent original receipt and cannot recreate the original document", async t => {
  const { fixture, request } = await fixtureServer(t); await request(fixture.paths.form);
  const fields = { workflowId: fixture.workflowId, documentToken: fixture.stats().originalToken, originalReceiptId: "uncommitted", draftSHA256: "none", note: fixture.expectedNote, reviews: "1", reviewTrusted: "true", submits: "1", trusted: "true" };
  assert.equal((await request(fixture.paths.followup, fields)).status, 409); assert.equal(fixture.stats().followupCommitted, false);
  assert.equal((await request(fixture.paths.form)).status, 409);
  assert.equal((await request(fixture.paths.followup)).status, 405);
});

test("confirmation validates every original identity, note, review and submission field without consuming a bad attempt", async t => {
  const cases = [
    ["workflow", fields => ({ ...fields, workflowId: "foreign" })], ["document", fields => ({ ...fields, documentToken: "replacement" })],
    ["receipt", fields => ({ ...fields, originalReceiptId: "foreign" })], ["draft digest", fields => ({ ...fields, draftSHA256: "0".repeat(64) })],
    ["exact note", fields => ({ ...fields, note: fields.note.trim() })], ["review count", fields => ({ ...fields, reviews: "2" })],
    ["review trust", fields => ({ ...fields, reviewTrusted: "false" })], ["submit count", fields => ({ ...fields, submits: "2" })],
    ["submit trust", fields => ({ ...fields, trusted: "false" })], ["duplicate field", fields => new URLSearchParams(fields).toString() + "&note=duplicate"],
    ["extra field", fields => ({ ...fields, extra: "unexpected" })], ["missing field", fields => { const result = { ...fields }; delete result.note; return result; }],
    ["oversized", fields => ({ ...fields, note: "x".repeat(9000) })],
  ];
  for (const [name, mutate] of cases) await t.test(name, async child => {
    const { fixture, request, fields } = await committedFixture(child);
    assert.equal((await request(fixture.paths.followup, mutate(fields))).status, 400); assert.equal(fixture.stats().followupCommitted, false);
    assert.equal((await request(fixture.paths.followup, fields)).status, 200); assert.equal(fixture.stats().followupCommitted, true);
  });
});

test("both original and follow-up receipts remain one-shot and retain the first original bytes", async t => {
  const { fixture, request, fields, initialFields } = await committedFixture(t);
  assert.equal((await request(fixture.paths.followup, fields)).status, 200);
  const originalRequests = fixture.stats().requests.slice(0, 3);
  assert.equal((await request(fixture.paths.followup, fields)).status, 409);
  assert.equal((await request(fixture.paths.receipt, initialFields)).status, 409);
  assert.deepEqual(fixture.stats().requests.slice(0, 3), originalRequests);
});

test("the complete receipt assertion rejects substituted documents, altered bytes, absent native-input evidence and extra HTTP work", async t => {
  const { fixture, base, request } = await fixtureServer(t), page = fixtureDocument((await request(fixture.paths.form)).text, base), original = page.read();
  page.input("draft", fixture.draft); await page.nodes.get("form").emit("submit");
  page.input("note", fixture.expectedNote); await page.nodes.get("review").emit("click"); await page.nodes.get("continuation-form").emit("submit");
  const current = page.read(), stats = fixture.stats(); assertManagedNativeRecoveryContinuationReceipt(stats, original, current);
  const currentMutations = [
    value => { value.documentId = "replacement"; }, value => { value.state.documentToken = "replacement"; }, value => { value.state.workflowId = "foreign"; },
    value => { value.draft += "changed"; }, value => { value.note = "wrong"; }, value => { value.state.receipt.receiptId = "foreign"; },
    value => { value.state.reviews[0].trusted = false; }, value => { value.state.continuation.submits = 2; }, value => { value.confirmDisabled = false; },
    value => { value.state.continuation.events[0].trusted = false; }, value => { value.state.continuation.events[0].eventIndex = 0; },
    value => { value.state.continuation.events[0].fields.originalReceiptId = "foreign"; }, value => { value.state.continuation.receipt.note = "wrong"; },
    value => { value.state.events = value.state.events.filter(event => event.target !== "note"); }, value => { value.state.events.find(event => event.target === "note").trusted = false; },
  ];
  for (const mutate of currentMutations) { const changed = structuredClone(current); mutate(changed); assert.throws(() => assertManagedNativeRecoveryContinuationReceipt(stats, original, changed)); }
  for (const mutate of [
    value => { value.requests[2].body.sha256 = "0".repeat(64); }, value => { value.requests[2].response.bytes++; },
    value => { value.requests[2].finished = false; }, value => { value.requests[2].aborted = true; }, value => { value.requests[2].errors.push("transport error"); },
    value => { value.requests.push(structuredClone(value.requests[2])); }, value => { value.requests[2].path = value.requests[1].path; },
  ]) { const changed = structuredClone(stats); mutate(changed); assert.throws(() => assertManagedNativeRecoveryContinuationReceipt(changed, original, current)); }
});
