import assert from "node:assert/strict";
import test from "node:test";
import { createServer, request } from "node:http";
import vm from "node:vm";
import { listenFixture } from "./fixture-listener.mjs";
import { createManagedOopifBfcacheFixture, assessManagedOopifBfcacheDocuments, assertManagedOopifBfcacheReceipt } from "./managed-oopif-bfcache-fixture.mjs";

async function fixtureServer(t) {
  let fixture;
  const server = createServer((req, res) => { if (!fixture?.handle(req, res)) { req.resume(); res.writeHead(404).end(); } });
  await listenFixture(server); t.after(() => new Promise(resolve => server.close(resolve)));
  fixture = createManagedOopifBfcacheFixture({ baseURL: `http://127.0.0.1:${server.address().port}/` });
  const call = (url, body) => new Promise((resolve, reject) => {
    const parsed = new URL(url), bytes = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = request({ hostname: "127.0.0.1", port: parsed.port, path: parsed.pathname + parsed.search, method: bytes ? "POST" : "GET",
      headers: { host: parsed.host, ...(bytes ? { "content-type": "application/json", "content-length": bytes.length } : {}) } }, res => {
      const chunks = []; res.on("data", chunk => chunks.push(chunk)); res.once("error", reject);
      res.once("end", () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.once("error", reject); req.end(bytes);
  });
  return { fixture, call };
}

test("three original documents have independent tokens and no restoration workaround", async t => {
  const { fixture, call } = await fixtureServer(t);
  assert.notEqual(new URL(fixture.urls.root).hostname, new URL(fixture.urls.leaf).hostname);
  for (const role of ["root", "leaf", "away"]) {
    const response = await call(fixture.urls[role]); assert.equal(response.status, 200);
    assert.equal(response.headers["cache-control"], undefined);
    assert.doesNotMatch(response.text, /localStorage|sessionStorage|beforeunload|unload|dispatchEvent|postMessage|\.focus\(/);
    const source = response.text.match(/<script>([\s\S]+)<\/script>/)[1]; new vm.Script(source);
    assert.ok(response.text.includes(fixture.stats().tokens[role]));
  }
  assert.equal(new Set(Object.values(fixture.stats().tokens)).size, 3);
  assert.equal(fixture.stats().posted, false);
  const original = fixture.stats().tokens.root;
  assert.equal((await call(fixture.urls.root)).status, 409);
  assert.equal(fixture.stats().tokens.root, original);
  assert.equal(fixture.stats().requests.length, 4);
});

test("wrong origin and query cannot be admitted as the original frame", async t => {
  const { fixture, call } = await fixtureServer(t);
  const wrong = new URL(fixture.urls.leaf); wrong.hostname = "127.0.0.1";
  assert.equal((await call(wrong)).status, 400);
  assert.equal((await call(fixture.urls.leaf + "?replay=1")).status, 400);
  assert.equal(fixture.stats().tokens.leaf, undefined);
  assert.equal((await call(fixture.urls.leaf)).status, 200);
});

function observations(fixture) {
  const { tokens, drafts, workflowId } = fixture.stats();
  const before = ["root", "leaf"].map(role => ({
    documentId: role + "-document",
    draft: drafts[role], receipt: role === "leaf" ? "" : null,
    state: { workflowId, role, documentToken: tokens[role], overflow: false, posts: 0, error: null,
      events: [{ sequence: 1, type: "input", target: role + "-draft", trusted: true, value: drafts[role] }],
      lifecycle: [{ sequence: 1, type: "pageshow", trusted: true, persisted: false, value: "" }] }
  }));
  const restored = structuredClone(before);
  for (const row of restored) row.state.lifecycle.push(
    { sequence: 2, type: "pagehide", trusted: true, persisted: true, value: row.draft },
    { sequence: 3, type: "pageshow", trusted: true, persisted: true, value: row.draft });
  restored[0].state.events.push({ sequence: 2, type: "click", target: "leave", trusted: true, value: drafts.root });
  return { before, restored };
}

test("ordinary reload, absent leaf, reordered lifecycle and synthetic events never establish coverage", () => {
  const fixture = { stats: () => ({ tokens: { root: "root-token", leaf: "leaf-token" }, drafts: { root: "root-draft", leaf: "leaf-draft" }, workflowId: "original" }) };
  const original = observations(fixture);
  assert.equal(assessManagedOopifBfcacheDocuments(original).bfcacheWitnessVerified, true);
  for (const change of [
    value => { value.restored[0].documentId = "new-root"; },
    value => { value.restored[1].state.documentToken = "new-leaf"; },
    value => { value.restored[1].state.workflowId = "other"; },
    value => { value.restored.pop(); },
    value => { value.restored.push(structuredClone(value.restored[1])); },
    value => { value.restored[1].state.lifecycle[2].persisted = false; },
    value => { value.restored[1].state.lifecycle[1].trusted = false; },
    value => { value.restored[1].state.lifecycle.reverse(); },
    value => { value.restored[1].state.overflow = true; }
  ]) {
    const value = structuredClone(original); change(value);
    assert.equal(assessManagedOopifBfcacheDocuments(value).bfcacheWitnessVerified, false);
  }
  const lostDraft = structuredClone(original); lostDraft.restored[1].draft = "";
  const assessment = assessManagedOopifBfcacheDocuments(lostDraft);
  assert.equal(assessment.bfcacheWitnessVerified, true);
  assert.equal(assessment.originalDraftsPreserved, false, "A real BFCache business failure is not relabelled uncovered");
});

test("original receipt keeps exact raw bytes, proves both drafts and rejects duplicate or substituted evidence", async t => {
  const { fixture, call } = await fixtureServer(t);
  for (const role of ["root", "leaf", "away"]) assert.equal((await call(fixture.urls[role])).status, 200);
  const state = observations(fixture), after = structuredClone(state.restored), leaf = after[1];
  leaf.state.posts = 1;
  leaf.state.events.push({ sequence: 2, type: "click", target: "submit", trusted: true, value: leaf.draft },
    { sequence: 3, type: "submit", target: "form", trusted: true, value: leaf.draft });
  const body = { workflowId: fixture.workflowId, documentToken: leaf.state.documentToken, draft: leaf.draft, posts: 1,
    lifecycle: leaf.state.lifecycle, events: leaf.state.events };
  const response = await call(fixture.urls.receipt, body); assert.equal(response.status, 200);
  const receipt = JSON.parse(response.text); leaf.receipt = response.text;
  const args = { ...state, after, receipt }, stats = fixture.stats();
  assert.equal(assertManagedOopifBfcacheReceipt(stats, args).verified, true);
  for (const mutate of [
    (data, proof) => { data.requests[3].body.sha256 = "other"; },
    (data, proof) => { proof.after[1].state.documentToken = "replacement"; },
    (data, proof) => { proof.before[0].draft = ""; },
    (data, proof) => { proof.after[0].state.events[1].trusted = false; },
    (data, proof) => { proof.after[1].state.posts = 2; },
    (data, proof) => { proof.after[1].receipt = "{}"; },
    (data, proof) => { data.requests.push(structuredClone(data.requests[0])); }
  ]) {
    const data = structuredClone(stats), proof = structuredClone(args); mutate(data, proof);
    assert.throws(() => assertManagedOopifBfcacheReceipt(data, proof));
  }
  assert.equal((await call(fixture.urls.receipt, body)).status, 409);
  assert.equal(fixture.stats().requests.length, 5);
});

test("baseline wrong drafts remain recorded instead of preventing evidence collection", async t => {
  const { fixture, call } = await fixtureServer(t);
  for (const role of ["root", "leaf", "away"]) await call(fixture.urls[role]);
  const body = { workflowId: fixture.workflowId, documentToken: fixture.stats().tokens.leaf, draft: "wrong but original", posts: 1, lifecycle: [], events: [] };
  const response = await call(fixture.urls.receipt, body);
  assert.equal(response.status, 200); assert.equal(JSON.parse(response.text).recorded, true);
  assert.equal(fixture.stats().requests[3].submitted.draft, body.draft);
  assert.equal(fixture.stats().posted, true);
});
