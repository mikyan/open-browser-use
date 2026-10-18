import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createContext, Script } from "node:vm";
import test from "node:test";
import { createManagedFrameDialogFixture, managedFrameDialogLayouts, readManagedFrameDialogDocument, measureManagedFrameDialogElement } from "./managed-human-frame-dialog-fixture.mjs";
import { managedDialogUnicode } from "./managed-dialog-fixture.mjs";
import { listenFixture } from "./fixture-listener.mjs";

async function setup(t, layout) {
  let fixture; const server = createServer((req, res) => { if (!fixture?.handle(req, res)) { req.resume(); res.writeHead(404); res.end(); } });
  await listenFixture(server); t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  fixture = createManagedFrameDialogFixture({ baseURL: `http://127.0.0.1:${server.address().port}/`, layout });
  const models = [];
  for (const role of fixture.roles) {
    const response = await fetch(fixture.urls[role]); assert.equal(response.status, 200); const html = await response.text();
    assert.equal(html.includes(managedDialogUnicode), false, "The expected answer stays out of served HTML");
    models.push(model(html, fixture.urls[role]));
  }
  return { fixture, models };
}
// These DOM/native stubs validate the actual fixture script, not browser input.
function model(html, url) {
  const nodes = Object.fromEntries(["state", "phase", "result"].map(id => [id, { textContent: "" }]));
  const button = { disabled: false, addEventListener(type, handler) { assert.equal(type, "click"); this.handler = handler; } };
  const calls = [], posts = []; let answer = managedDialogUnicode, before;
  const document = { querySelector: selector => selector === "#prompt" ? button : nodes[selector.slice(1)] };
  const context = createContext({ document, location: { href: url }, innerWidth: 500, innerHeight: 220, scrollX: 0, scrollY: 0, devicePixelRatio: 1,
    window: { prompt(message, initial) { calls.push({ message, initial }); before = JSON.parse(nodes.state.textContent); if (answer instanceof Error) throw answer; return answer; } },
    fetch: async (target, options) => { posts.push({ target, ...options }); return fetch(target, options); } });
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]; assert.equal(scripts.length, 1); new Script(scripts[0][1]).runInContext(context);
  return { calls, posts, button, read: () => JSON.parse(JSON.stringify(new Script(`(${readManagedFrameDialogDocument.toString()})()`).runInContext(context))),
    get before() { return before; }, setAnswer(value) { answer = value; },
    click: overrides => button.handler({ currentTarget: button, isTrusted: true, button: 0, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...overrides }) };
}

for (const layout of managedFrameDialogLayouts) test(`${layout} keeps distinct original documents and posts once from its actual emitter`, async t => {
  const { fixture, models } = await setup(t, layout), leaf = models.at(-1); const before = models.map(value => value.read());
  assert.equal(new Set(before.map(value => value.state.documentToken)).size, models.length);
  assert.equal(leaf.read().state.role, fixture.emitterRole); await leaf.click();
  assert.equal(leaf.before.phase, "dialog"); assert.deepEqual(leaf.before.events, [{ phase: "before", type: "prompt" }]);
  assert.equal(leaf.before.postAttempts, 0); assert.equal(leaf.calls.length, 1); assert.equal(leaf.posts.length, 1); assert.equal(leaf.posts[0].target, fixture.receiptURL);
  assert.equal(new URL(leaf.posts[0].target).origin, new URL(fixture.urls[fixture.emitterRole]).origin);
  const after = models.map(value => value.read()); assert.deepEqual(after.map(value => value.state.documentToken), before.map(value => value.state.documentToken));
  assert.equal(fixture.verify(after, { answer: managedDialogUnicode }).answer, managedDialogUnicode);
  assert.equal(fixture.stats().requestCount, fixture.roles.length + 1);
});

test("diagnostic null is a cancelled native return and cannot verify a successful answer", async t => {
  const { fixture, models } = await setup(t, "same"); models.at(-1).setAnswer(null); await models.at(-1).click();
  assert.equal(fixture.verify(models.map(value => value.read()), { answer: null }).answer, null);
  assert.throws(() => fixture.verify(models.map(value => value.read()), { answer: managedDialogUnicode }));
});

test("untrusted/modified clicks and native exceptions cannot replay the prompt or POST", async t => {
  const { fixture, models } = await setup(t, "root"), leaf = models[0]; await leaf.click({ isTrusted: false }); await leaf.click();
  assert.equal(leaf.calls.length, 0); assert.equal(leaf.posts.length, 0); assert.equal(fixture.stats().committed, false);
  const another = await setup(t, "nested"), emitter = another.models.at(-1); emitter.setAnswer(new Error("native failure")); await emitter.click(); await emitter.click();
  assert.equal(emitter.calls.length, 1); assert.equal(emitter.posts.length, 0); assert.equal(emitter.read().state.phase, "failed");
});

test("one original GET and exact routes/hosts are enforced", async t => {
  const { fixture, models } = await setup(t, "oopif");
  assert.equal((await fetch(fixture.urls.leaf)).status, 409);
  assert.equal((await fetch(fixture.urls.root + "?again=1")).status, 400);
  const wrongHost = new URL(fixture.urls.leaf); wrongHost.hostname = "127.0.0.1";
  assert.equal((await fetch(wrongHost)).status, 400);
  await models.at(-1).click(); const post = models.at(-1).posts[0]; assert.equal((await fetch(post.target, { method: "POST", body: post.body })).status, 409);
  assert.throws(() => fixture.verify(models.map(value => value.read()), { answer: managedDialogUnicode }));
});

test("receipt size is bounded and a rejected first attempt cannot be retried", async t => {
  const { fixture } = await setup(t, "same");
  assert.equal((await fetch(fixture.receiptURL, { method: "POST", body: "x".repeat(17000) })).status, 413);
  assert.equal((await fetch(fixture.receiptURL, { method: "POST", body: "{}" })).status, 409);
  assert.equal(fixture.stats().committed, false);
});

test("measurement is read-only and rejects transformed fixture geometry", () => {
  const node = { tagName: "BUTTON", clientLeft: 0, clientTop: 0, clientWidth: 80, clientHeight: 40, getBoundingClientRect: () => ({ x: 10, y: 10, width: 80, height: 40 }), contains: value => value === node };
  const style = { transform: "none", zoom: "1", display: "block", visibility: "visible" };
  const context = createContext({ document: { getElementById: () => node, elementFromPoint: () => node }, location: { href: "http://127.0.0.1:50000/original" }, innerWidth: 300, innerHeight: 200, getComputedStyle: () => style });
  const measure = () => new Script(`(${measureManagedFrameDialogElement.toString()})("prompt")`).runInContext(context);
  assert.equal(measure().clickable, true); style.transform = "scale(2)"; assert.throws(measure, /untransformed/);
});
