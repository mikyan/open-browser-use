import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import vm from "node:vm";
import { listenFixture } from "./fixture-listener.mjs";
import { createManagedHumanNavigationFixture, assertManagedHumanNavigationReceipt, readManagedHumanNavigationDocument } from "./managed-human-navigation-fixture.mjs";

async function fixtureServer(options, body) {
  const fixture = createManagedHumanNavigationFixture(options);
  const server = createServer((request, response) => { if (!fixture.handle(request, response)) { response.writeHead(404); response.end(); } });
  await listenFixture(server);
  try { await body(fixture, `http://127.0.0.1:${server.address().port}`); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

const nextFields = fixture => ({ workflowId: fixture.workflowId, documentAToken: fixture.stats().documentAToken, draft: fixture.expectedNextDraft, trusted: "true", count: "1", heldKeys: "0", heldButtons: "0" });
const frameQuery = (fixture, step) => new URLSearchParams({ workflowId: fixture.workflowId, documentBToken: fixture.stats().documentBToken, step: String(step), ...(step ? { trusted: "true", count: "1" } : {}) });
function postFields(fixture, frameStep = 0) {
  const stats = fixture.stats(), frame = stats.requests.filter(hit => hit.path === fixture.paths.frame && hit.step === frameStep).at(-1);
  return { workflowId: fixture.workflowId, documentAToken: stats.documentAToken, documentBToken: stats.documentBToken, draft: fixture.expectedDraft,
    nextClicks: "1", nextTrusted: "true", spaClicks: "1", spaTrusted: "true", route: "spa", submitCount: "1", heldKeys: "0", heldButtons: "0", frameClicks: String(frameStep), frameTrusted: "true", frameDocumentToken: frame?.documentToken ?? "", eventOverflow: "false" };
}
async function prepare(fixture, origin, frameStep = 0) {
  const a = await fetch(origin + fixture.paths.a); assert.equal(a.status, 200); const htmlA = await a.text();
  const query = new URLSearchParams(nextFields(fixture));
  const next = await fetch(origin + fixture.paths.next + "?" + query, { redirect: "manual" });
  assert.equal(next.status, 302); await next.text();
  const b = await fetch(origin + next.headers.get("location")); assert.equal(b.status, 200); const htmlB = await b.text();
  for (let step = 0; step <= frameStep; step++) {
    const frame = await fetch(origin + fixture.paths.frame + "?" + frameQuery(fixture, step)); assert.equal(frame.status, 200); await frame.text();
  }
  return { htmlA, htmlB, query };
}
function snapshots(fixture, frameStep = 0) {
  const stats = fixture.stats(), fields = postFields(fixture, frameStep);
  return {
    originalA: { state: { documentToken: stats.documentAToken } },
    originalB: { draft: fixture.expectedNextDraft, state: { documentToken: stats.documentBToken, documentAToken: stats.documentAToken, handoffDraft: fixture.expectedNextDraft } },
    after: { draft: fixture.expectedDraft, state: { documentToken: stats.documentBToken, handoffDraft: fixture.expectedNextDraft,
      route: "spa", eventOverflow: false, inputCount: 2, trustedInputCount: 2, submits: 1, heldKeys: [], heldButtons: [],
      nextClicks: [{ trusted: true }], spaClicks: [{ trusted: true }], frameClicks: frameStep ? [{ trusted: true }] : [] }, childState: { documentToken: fields.frameDocumentToken } }
  };
}

test("navigation fixture validates one original redirect, transferred draft, child and final POST bytes", async () => {
  await fixtureServer({ requireFrameNavigation: true }, async (fixture, origin) => {
    const { htmlA, htmlB, query } = await prepare(fixture, origin, 1);
    for (const html of [htmlA, htmlB]) {
      new vm.Script(html.match(/<script>([\s\S]*)<\/script>/)[1]);
      assert.match(html, /<pre id="state" hidden>/); assert.match(html, /height:100%;overflow:hidden/);
    }
    const fields = postFields(fixture, 1), body = new URLSearchParams(fields);
    const response = await fetch(origin + fixture.paths.receipt, { method: "POST", body });
    assert.equal(response.status, 200); const receipt = await response.json();
    const { originalA, originalB, after } = snapshots(fixture, 1);
    const proof = assertManagedHumanNavigationReceipt(fixture.stats(), originalA, originalB, after, receipt);
    assert.deepEqual(Buffer.from(proof.post.base64, "base64"), Buffer.from(body.toString()));
    assert.equal(proof.frameNavigations, 1);
    const originalTarget = fixture.stats().requests.find(hit => hit.path === fixture.paths.next).requestTarget;
    assert.equal(Buffer.from(originalTarget.base64, "base64").toString(), fixture.paths.next + "?" + query);
    const tampered = fixture.stats(); tampered.requests.at(-1).body.base64 = Buffer.from("changed=body").toString("base64");
    assert.throws(() => assertManagedHumanNavigationReceipt(tampered, originalA, originalB, after, receipt));
    const redirectChanged = fixture.stats(); redirectChanged.requests.find(hit => hit.path === fixture.paths.next).headers.Location = "/another-document";
    assert.throws(() => assertManagedHumanNavigationReceipt(redirectChanged, originalA, originalB, after, receipt));
    assert.throws(() => assertManagedHumanNavigationReceipt(fixture.stats(), originalA, originalB, { ...after, state: { ...after.state, documentToken: "replacement-B" } }, receipt));
    assert.throws(() => assertManagedHumanNavigationReceipt(fixture.stats(), originalA, originalB, { ...after, state: { ...after.state, heldKeys: ["ShiftLeft"] } }, receipt));
    assert.throws(() => assertManagedHumanNavigationReceipt(fixture.stats(), originalA, originalB, { ...after, state: { ...after.state, trustedInputCount: 0 } }, receipt));
    assert.equal((await fetch(origin + fixture.paths.next + "?" + query, { redirect: "manual" })).status, 409);
    assert.equal((await fetch(origin + fixture.paths.receipt, { method: "POST", body })).status, 409);
    assert.throws(() => assertManagedHumanNavigationReceipt(fixture.stats(), originalA, originalB, after, receipt));
  });
});

test("invalid Next cannot be retried or mint an original B document", async () => {
  for (const replacement of [{ documentAToken: "other" }, { workflowId: "other" }, { draft: "wrong" }, { trusted: "false" }, { count: "2" }, { heldKeys: "1" }, { heldButtons: "1" }]) {
    await fixtureServer({}, async (fixture, origin) => {
      await (await fetch(origin + fixture.paths.a)).text();
      const invalid = new URLSearchParams({ ...nextFields(fixture), ...replacement });
      const first = await fetch(origin + fixture.paths.next + "?" + invalid, { redirect: "manual" });
      assert.equal(first.status, 400); await first.text();
      const retry = await fetch(origin + fixture.paths.next + "?" + new URLSearchParams(nextFields(fixture)), { redirect: "manual" });
      assert.equal(retry.status, 409); await retry.text();
      assert.equal(fixture.stats().documentBToken, null); assert.equal(fixture.stats().committed, false);
    });
  }
});

test("final receipt rejects missing child navigation, untrusted SPA, wrong draft and held input without retry", async () => {
  for (const replacement of [{}, { documentBToken: "other" }, { draft: "partial" }, { spaTrusted: "false" }, { spaClicks: "2" }, { route: "initial" }, { heldKeys: "1" }, { heldButtons: "1" }, { eventOverflow: "true" }]) {
    await fixtureServer({ requireFrameNavigation: true }, async (fixture, origin) => {
      const missingFrame = Object.keys(replacement).length === 0;
      await prepare(fixture, origin, missingFrame ? 0 : 1);
      const fields = { ...postFields(fixture, missingFrame ? 0 : 1), ...replacement };
      const response = await fetch(origin + fixture.paths.receipt, { method: "POST", body: new URLSearchParams(fields) });
      assert.equal(response.status, 400); await response.text(); assert.equal(fixture.stats().committed, false);
      const retry = await fetch(origin + fixture.paths.receipt, { method: "POST", body: new URLSearchParams(postFields(fixture, missingFrame ? 0 : 1)) });
      assert.equal(retry.status, 409); await retry.text();
    });
  }
});

test("ordinary B flow permits initial child only while duplicate query fields and page reload are rejected", async () => {
  await fixtureServer({}, async (fixture, origin) => {
    await prepare(fixture, origin);
    const body = new URLSearchParams(postFields(fixture));
    const response = await fetch(origin + fixture.paths.receipt, { method: "POST", body });
    assert.equal(response.status, 200); const receipt = await response.json();
    const { originalA, originalB, after } = snapshots(fixture);
    assert.equal(assertManagedHumanNavigationReceipt(fixture.stats(), originalA, originalB, after, receipt).frameNavigations, 0);
    assert.equal((await fetch(origin + fixture.paths.a)).status, 409);
    const query = new URLSearchParams({ workflowId: fixture.workflowId, documentBToken: fixture.stats().documentBToken });
    assert.equal((await fetch(origin + fixture.paths.b + "?" + query)).status, 409);
  });
  await fixtureServer({}, async (fixture, origin) => {
    await (await fetch(origin + fixture.paths.a)).text();
    const query = new URLSearchParams(nextFields(fixture)); query.append("trusted", "true");
    assert.equal((await fetch(origin + fixture.paths.next + "?" + query, { redirect: "manual" })).status, 400);
  });
});

test("read-only document observer returns original root-coordinate aliases and child identity", () => {
  const elements = new Map(["draft", "next", "spa", "frame-next", "commit", "hold", "child"].map((id, i) => [id, { value: "draft", getBoundingClientRect: () => ({ x: 12, y: 20 + i * 30, width: 120, height: 24 }) }]));
  elements.set("state", { textContent: JSON.stringify({ documentToken: "B" }) });
  elements.set("result", { textContent: "" });
  elements.get("child").contentDocument = { querySelector: () => ({ textContent: JSON.stringify({ documentToken: "child-1", step: 1 }) }) };
  const context = vm.createContext({ document: { querySelector: selector => elements.get(selector.slice(1)), getElementById: id => elements.get(id), documentElement: { clientWidth: 758, clientHeight: 426, scrollWidth: 758, scrollHeight: 426 } },
    location: { href: "http://127.0.0.1/nav-b#spa" }, innerWidth: 758, innerHeight: 426, scrollX: 0, scrollY: 0, devicePixelRatio: 1 });
  const value = JSON.parse(JSON.stringify(vm.runInContext(`(${readManagedHumanNavigationDocument.toString()})()`, context)));
  assert.deepEqual(value.boxes.input, value.boxes.draft); assert.deepEqual(value.boxes.submit, value.boxes.commit); assert.deepEqual(value.boxes.frameNavigate, value.boxes["frame-next"]);
  assert.equal(value.childState.documentToken, "child-1"); assert.equal(value.state.documentToken, "B"); assert.equal(value.viewport.clientHeight, 426);
});
