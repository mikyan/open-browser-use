import assert from "node:assert/strict";
import test from "node:test";
import { createServer, request as httpRequest } from "node:http";
import vm from "node:vm";
import { createManagedHumanNewPageFixture, readManagedHumanNewPageDocument } from "./managed-human-new-page-fixture.mjs";

function request(url, options = {}) {
  const address = new URL(url);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: "127.0.0.1", port: address.port, path: address.pathname,
      method: options.method ?? "GET", headers: { host: address.host, ...(options.headers ?? {}) } }, response => {
      let text = ""; response.setEncoding("utf8"); response.on("data", chunk => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, text }));
    });
    req.on("error", reject); req.end(options.body);
  });
}
async function fixtureTest(trigger, operation, variant = "standard") {
  const fixture = createManagedHumanNewPageFixture({ trigger, variant, waitMs: 5000 });
  const server = createServer((req, response) => { if (!fixture.handle(req, response)) response.writeHead(404).end(); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const urls = fixture.urls(`http://127.0.0.1:${server.address().port}`);
  try { await operation(fixture, urls); }
  finally { fixture.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

test("original document read identifies only uninitialized state as not ready and preserves parse errors", () => {
  for (const value of [null, { textContent: "" }]) {
    const result = vm.runInNewContext(`(${readManagedHumanNewPageDocument.toString()})()`, { document: { getElementById: () => value }, location: { href: "http://localhost:50001/original" } });
    assert.equal(result.ready, false); assert.equal(result.url, "http://localhost:50001/original");
  }
  assert.throws(() => vm.runInNewContext(`(${readManagedHumanNewPageDocument.toString()})()`, {
    document: { getElementById: () => ({ textContent: "not JSON" }) }, location: { href: "http://localhost:50001/original" }
  }), /JSON/);
});

test("variant fixtures are bounded, explicit, and not combined with a different native trigger", () => {
  for (const variant of [null, "", "unknown", "iframe,parent-navigate"]) assert.throws(() => createManagedHumanNewPageFixture({ variant }));
  for (const variant of ["iframe", "parent-navigate", "child-close"]) assert.throws(() => createManagedHumanNewPageFixture({ trigger: "target-blank", variant }));
});

for (const variant of ["iframe", "parent-navigate", "child-close"]) test(`${variant} serves only its original variant routes and parsable scripts`, async () => {
  await fixtureTest("window-open", async (fixture, urls) => {
    const parent = await request(urls.parent), child = await request(urls.child);
    for (const html of [parent.text, child.text]) new vm.Script(html.match(/<script>([\s\S]*)<\/script>/)[1]);
    if (variant === "iframe") {
      const frame = await request(urls.frame); new vm.Script(frame.text.match(/<script>([\s\S]*)<\/script>/)[1]);
      assert.match(parent.text, /<iframe id="source-frame"/); assert.doesNotMatch(parent.text, /window\.open\(/);
      assert.match(frame.text, /if\(!e\.isTrusted\)return;window\.open\(/); assert.notEqual(new URL(urls.frame).origin, new URL(urls.parent).origin);
      assert.equal((await request(urls.frame)).status, 405);
    }
    if (variant === "parent-navigate") {
      assert.equal((await request(urls.returnedParent)).status, 409);
      assert.match(parent.text, /sessionStorage\.setItem/); assert.match(parent.text, /location\.assign\(/);
      const stats = fixture.stats(); const body = JSON.stringify({ key: stats.key, documentToken: stats.childToken, trusted: true });
      assert.equal((await request(urls.child.replace(/child$/, "callback"), { method: "POST", body })).status, 200);
      const returned = await request(urls.returnedParent); assert.equal(returned.status, 200);
      assert.match(returned.text, /sessionStorage\.getItem/); assert.match(returned.text, /previousDocumentToken/);
      new vm.Script(returned.text.match(/<script>([\s\S]*)<\/script>/)[1]);
      assert.equal((await request(urls.returnedParent)).status, 405);
    }
    if (variant === "child-close") {
      assert.match(child.text, /state\.receipt=await r\.json\(\);render\(\);window\.close\(\)/);
      assert.doesNotMatch(child.text, /setTimeout|setInterval|requestAnimationFrame/);
      const stats = fixture.stats(), body = JSON.stringify({ key: stats.key, documentToken: stats.childToken, trusted: true, events: [{ type: "click", trusted: true }], submitted: true, closeRequested: true });
      assert.equal((await request(urls.child.replace(/child$/, "callback"), { method: "POST", body })).status, 200);
      assert.equal(fixture.stats().requests.at(-1).body, body);
    }
  }, variant);
});

test("closing child waits only for its actual callback response, closes once, and never delays for harness ACK", async () => {
  await fixtureTest("window-open", async (_fixture, urls) => {
    const html = (await request(urls.child)).text, listeners = {}, calls = [];
    let deliver; const response = new Promise(resolve => { deliver = resolve; });
    const elements = { state: { textContent: "" }, return: { addEventListener(type, handler) { listeners[type] = handler; } } };
    vm.runInNewContext(html.match(/<script>([\s\S]*)<\/script>/)[1], { document: { getElementById: id => elements[id] },
      fetch: async (_url, options) => { calls.push({ operation: "POST", body: JSON.parse(options.body) }); return response; }, window: { close() { calls.push({ operation: "close" }); } } });
    assert.deepEqual(calls, []); const click = listeners.click({ isTrusted: true }); assert.equal(calls.length, 1);
    deliver({ ok: true, json: async () => ({ original: true }) }); await click;
    assert.deepEqual(calls.map(call => call.operation), ["POST", "close"]);
    assert.deepEqual(calls[0].body.events, [{ type: "click", trusted: true }]); assert.equal(calls[0].body.closeRequested, true);
    await listeners.click({ isTrusted: true }); assert.equal(calls.length, 2);
  }, "child-close");
});

test("original child read reports actual noopener without creating or controlling a window", () => {
  const state = { role: "child", documentToken: "original" };
  for (const opener of [null, {}]) {
    const value = vm.runInNewContext(`(${readManagedHumanNewPageDocument.toString()})()`, {
      document: { getElementById: id => id === "state" ? { textContent: JSON.stringify(state) } : id === "return" ? { getBoundingClientRect: () => ({ x: 1, y: 2, width: 3, height: 4 }) } : null, hasFocus: () => true, visibilityState: "visible" },
      window: { opener }, location: { href: "http://localhost:50001/child" }
    });
    assert.equal(value.openerPresent, opener !== null); assert.equal(value.state.documentToken, "original");
  }
});

for (const trigger of ["window-open", "target-blank"]) test(`${trigger} fixture serves exact original cross-site documents and refuses replay`, async () => {
  await fixtureTest(trigger, async (fixture, urls) => {
    const parent = await request(urls.parent), child = await request(urls.child);
    assert.equal(parent.status, 200); assert.equal(child.status, 200);
    assert.equal(new URL(urls.parent).hostname, "127.0.0.1"); assert.equal(new URL(urls.child).hostname, "localhost");
    assert.equal((await request(urls.parent)).status, 405); assert.equal((await request(urls.child)).status, 405);
    if (trigger === "window-open") assert.match(parent.text, /window\.open\(/);
    else { assert.match(parent.text, /target="_blank"/); assert.doesNotMatch(parent.text, /window\.open\(|rel="opener"/); }
    assert.doesNotMatch(parent.text + child.text, /dispatchEvent|setInputFiles|\.click\(|setInterval/);
    assert.equal(fixture.stats().callback, null); assert.equal(fixture.stats().requests.filter(hit => hit.method === "POST").length, 0);
  });
});

test("child callback is absent on load/untrusted click and sends once only after trusted click", async () => {
  await fixtureTest("window-open", async (_fixture, urls) => {
    const html = (await request(urls.child)).text, listeners = {}, calls = [];
    const elements = { state: { textContent: "" }, return: { addEventListener(type, handler) { listeners[type] = handler; } } };
    vm.runInNewContext(html.match(/<script>([\s\S]*)<\/script>/)[1], {
      document: { getElementById: id => elements[id] },
      fetch: async (url, options) => { calls.push({ url, options }); return { ok: true, json: async () => ({ original: true }) }; }
    });
    assert.equal(calls.length, 0); await listeners.click({ isTrusted: false }); assert.equal(calls.length, 0);
    await listeners.click({ isTrusted: true }); assert.equal(calls.length, 1); assert.equal(calls[0].options.method, "POST");
    const body = JSON.parse(calls[0].options.body); assert.equal(body.trusted, true); assert.ok(body.documentToken);
    await listeners.click({ isTrusted: true }); assert.equal(calls.length, 1);
  });
});

test("single parent long poll receives only matching child callback and all routes reject replay", async () => {
  await fixtureTest("target-blank", async (fixture, urls) => {
    await request(urls.parent); await request(urls.child);
    const pollURL = urls.parent.replace(/parent$/, "await-return"), callbackURL = urls.child.replace(/child$/, "callback");
    const waiting = request(pollURL); await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(fixture.stats().pendingReads, 1); assert.equal(fixture.stats().callback, null);
    const stats = fixture.stats(), body = JSON.stringify({ key: stats.key, documentToken: stats.childToken, trusted: true });
    const response = await request(callbackURL, { method: "POST", body }); assert.equal(response.status, 200);
    const delivered = await waiting; assert.equal(delivered.status, 200); assert.equal(delivered.text, response.text);
    assert.equal((await request(callbackURL, { method: "POST", body })).status, 405);
    assert.equal((await request(pollURL)).status, 405); assert.equal(fixture.stats().pendingReads, 0);
  });
});

test("closing a baseline releases its one observation without inventing a child callback", async () => {
  await fixtureTest("window-open", async (fixture, urls) => {
    await request(urls.parent); await request(urls.child);
    const waiting = request(urls.parent.replace(/parent$/, "await-return"));
    await new Promise(resolve => setTimeout(resolve, 10)); fixture.close();
    assert.equal((await waiting).status, 204);
    assert.equal(fixture.stats().callback, null); assert.equal(fixture.stats().pendingReads, 0);
    assert.equal(fixture.stats().requests.filter(hit => hit.method === "POST").length, 0);
  });
});
