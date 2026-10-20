import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { createManagedHumanFileChooserFixture, assertManagedHumanFileChooserDocument, createManagedFileWorkflowFixture, managedFileWorkflowPayloads, readManagedFileWorkflowDocument } from "./managed-human-file-chooser-fixture.mjs";
import { Script } from "node:vm";
import { listenFixture } from "./fixture-listener.mjs";

async function fixtureServer(operation) {
  const fixture = createManagedHumanFileChooserFixture();
  const server = createServer((req, res) => { if (!fixture.handle(req, res)) { req.resume(); res.writeHead(404); res.end(); } });
  await listenFixture(server);
  try { await operation(fixture, `http://127.0.0.1:${server.address().port}`); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

test("original single GET returns one native input and stable recorded token; replay refused", async () => {
  await fixtureServer(async (fixture, base) => {
    const response = await fetch(base + fixture.route); assert.equal(response.status, 200);
    const html = await response.text(), original = fixture.stats();
    assert.ok(html.includes('type="file"')); assert.ok(html.includes(original.documentToken));
    assert.equal((await fetch(base + fixture.route)).status, 409);
    assert.equal(fixture.stats().documentToken, original.documentToken);
    assert.deepEqual(fixture.stats().requests.map(row => row.status), [200, 409]);
    assert.equal(fixture.stats().overflow, false);
  });
});

test("query and POST cannot create or replace original document", async () => {
  await fixtureServer(async (fixture, base) => {
    assert.equal((await fetch(base + fixture.route + "?different=1")).status, 400);
    assert.equal((await fetch(base + fixture.route, { method: "POST", body: "not a file" })).status, 405);
    assert.equal(fixture.stats().documentToken, null);
    assert.equal((await fetch(base + fixture.route)).status, 200);
  });
});

test("request evidence has explicit finite overflow", async () => {
  await fixtureServer(async (fixture, base) => {
    for (let i = 0; i < 9; i++) await fetch(base + fixture.route);
    assert.equal(fixture.stats().requests.length, 8); assert.equal(fixture.stats().overflow, true);
  });
});

const before = { documentId: "original-doc", frameId: 0, url: "http://127.0.0.1/fixture", inputType: "file", fileCount: 0,
  state: { workflowId: "original", documentToken: "token", overflow: false, events: [] } };
const click = { type: "click", trusted: true, button: 0, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false };
const after = () => ({ ...structuredClone(before), state: { ...structuredClone(before.state), events: [click] } });

test("document proof requires one original trusted unmodified click and no assigned files", () => {
  assert.equal(assertManagedHumanFileChooserDocument(before, after()).trustedClicks, 1);
  for (const change of [
    row => { row.documentId = "replacement"; },
    row => { row.state.documentToken = "new-token"; },
    row => { row.state.events = []; },
    row => { row.state.events.push(click); },
    row => { row.state.events = [{ ...click, trusted: false }]; },
    row => { row.state.events = [{ ...click, ctrlKey: true }]; },
    row => { row.fileCount = 1; },
    row => { row.state.events.push({ type: "change", trusted: true }); },
  ]) { const row = after(); change(row); assert.throws(() => assertManagedHumanFileChooserDocument(before, row)); }
});

test("workflow document observation measures submit and visibility without clicking or changing the fixture", () => {
  const submit = { id: "submit", tagName: "BUTTON", disabled: false, hidden: false,
    getBoundingClientRect: () => ({ x: 10, y: 20, width: 80, height: 30 }), click() { throw Error("No input from a read"); } };
  const elements = { state: { textContent: '{"phase":"ready","posts":0}' }, submit, receipt: { textContent: "" } };
  const document = { visibilityState: "hidden", hidden: true, hasFocus: () => false,
    getElementById: id => elements[id] ?? null,
    elementFromPoint(x, y) { assert.equal(x, 50); assert.equal(y, 35); return submit; } };
  const result = new Script(`(${readManagedFileWorkflowDocument.toString()})()`).runInNewContext({
    document, location: { href: "http://127.0.0.1/original" }, innerWidth: 758, innerHeight: 369,
    getComputedStyle(element) { assert.equal(element, submit); return { display: "inline-block", visibility: "visible", pointerEvents: "auto" }; },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(result.documentVisibility)), { state: "hidden", hidden: true, hasFocus: false });
  assert.deepEqual(JSON.parse(JSON.stringify(result.submit)), { rect: { x: 10, y: 20, width: 80, height: 30 },
    disabled: false, hidden: false, display: "inline-block", visibility: "visible", pointerEvents: "auto",
    centerHit: { id: "submit", tag: "BUTTON", isSubmit: true } });
  assert.equal(elements.state.textContent, '{"phase":"ready","posts":0}');
});

async function workflowServer(kind, operation) {
  let fixture;
  const server = createServer((req, res) => { if (!fixture?.handle(req, res)) { req.resume(); res.writeHead(404); res.end(); } });
  await listenFixture(server);
  fixture = createManagedFileWorkflowFixture({ kind, baseURL: `http://127.0.0.1:${server.address().port}` });
  try { await operation(fixture); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
async function loadOriginal(fixture) {
  const response = await fetch(fixture.urls.root); assert.equal(response.status, 200);
  const html = await response.text(); new Script(html.match(/<script>([\s\S]*)<\/script>/)[1]);
  if (fixture.kind === "oopif") {
    const child = await fetch(fixture.urls.emitter); assert.equal(child.status, 200);
    new Script((await child.text()).match(/<script>([\s\S]*)<\/script>/)[1]);
  }
}
function originalBody(fixture) {
  const state = fixture.stats();
  return { workflowId: fixture.workflowId, documentToken: state.tokens[fixture.kind === "oopif" ? "leaf" : "root"], posts: 1,
    files: managedFileWorkflowPayloads(fixture.kind).map(value => ({ name: value.name, size: value.buffer.length, data: value.buffer.toString("base64") })),
    events: [{ type: "click", trusted: true }, { type: "input", trusted: true }, { type: "change", trusted: true }, { type: "submit", trusted: true }] };
}
const post = (fixture, body) => fetch(fixture.urls.receipt, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

test("workflow originals accept one exact byte receipt, including duplicate names and empty file", async () => {
  for (const kind of ["root", "oopif"]) await workflowServer(kind, async fixture => {
    await loadOriginal(fixture);
    const response = await post(fixture, originalBody(fixture)); assert.equal(response.status, 200);
    const receipt = await response.json(); assert.equal(receipt.ok, true);
    assert.deepEqual(receipt.files.map(file => [file.name, file.size]), managedFileWorkflowPayloads(kind).map(file => [file.name, file.buffer.length]));
    assert.equal((await post(fixture, originalBody(fixture))).status, 409);
    assert.equal((await fetch(fixture.urls.root)).status, 409);
    assert.equal(fixture.stats().requests.filter(value => value.method === "POST").length, 2);
  });
});
test("workflow server rejects wrong original document, corrupted bytes and untrusted submit without retry", async () => {
  for (const mutate of [
    body => { body.documentToken = "replacement"; },
    body => { body.files[0].data = Buffer.from("changed").toString("base64"); },
    body => { body.events.at(-1).trusted = false; },
    body => { body.events.push({ type: "submit", trusted: true }); },
  ]) await workflowServer("root", async fixture => {
    await loadOriginal(fixture); const body = originalBody(fixture); mutate(body);
    assert.equal((await post(fixture, body)).status, 400); assert.equal(fixture.stats().receipt, null);
    assert.equal((await post(fixture, originalBody(fixture))).status, 409);
  });
});
test("navigation gate controls only original navigation and never permits business POST", async () => {
  await workflowServer("transfer-navigation", async fixture => {
    await loadOriginal(fixture);
    assert.equal((await fetch(fixture.urls.landed)).status, 409);
    const gate = fetch(fixture.urls.gate);
    for (let i = 0; !fixture.stats().requests.some(value => value.path.endsWith("/gate")) && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 2));
    fixture.releaseNavigation();
    assert.deepEqual(await (await gate).json(), { navigate: true });
    assert.throws(() => fixture.releaseNavigation());
    assert.equal((await fetch(fixture.urls.landed)).status, 200);
    assert.equal((await fetch(fixture.urls.landed)).status, 409);
    assert.equal((await post(fixture, {})).status, 405);
    assert.equal(fixture.stats().posted, false);
  });
});
