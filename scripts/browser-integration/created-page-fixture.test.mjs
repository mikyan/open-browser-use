import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { Script, createContext } from "node:vm";
import test from "node:test";
import { createCreatedPageFixtures } from "./created-page-fixture.mjs";

async function serve(t) {
  const fixture = createCreatedPageFixtures();
  const server = createServer((req, res) => { if (!fixture.handle(req, res)) { res.writeHead(404); res.end(); } });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { fixture, base: `http://127.0.0.1:${server.address().port}` };
}
const describe = text => { const bytes = Buffer.from(text); return { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), base64: bytes.toString("base64") }; };
const body = (record, child, extra = {}) => new URLSearchParams({ key: record.key, owner: record.owner, documentNonce: child.nonce, documentToken: "original-dom-token", trusted: "true", buttonCount: "1", ...extra }).toString();
const post = value => ({ method: "POST", body: value, headers: { "Content-Type": "application/x-www-form-urlencoded" } });

function script(html, selectors, extra = {}) {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]; assert.equal(scripts.length, 1);
  const document = { querySelector: selector => selectors[selector], createElement: () => ({}), body: { append(frame) { selectors.appended = frame; } } };
  new Script(scripts[0][1]).runInContext(createContext({ document, crypto: { randomUUID: () => "original-dom-token" }, URLSearchParams, ...extra }));
}
const element = properties => ({ ...properties, handlers: {}, addEventListener(name, handler) { this.handlers[name] = handler; } });

test("two owners and three layouts serve original links to one identical child URL with distinct document nonces", async t => {
  const { fixture, base } = await serve(t); const hrefs = [];
  for (const variant of ["root", "oopif", "dynamic-oopif"]) for (const owner of ["first", "second"]) {
    const record = fixture.createCase({ owner, variant });
    const html = await (await fetch(base + record.urlPath)).text();
    assert.doesNotMatch(html, /window\.open|tabs\.create|target="_blank"|preventDefault/);
    const state = element({ textContent: "" }), link = variant === "root" ? element({ href: base + "/created-page/child" }) : undefined;
    const add = variant === "dynamic-oopif" ? element() : undefined, selectors = { "#state": state, "#open-child": link, "#add-frame": add };
    script(html, selectors); let parsed = JSON.parse(state.textContent);
    assert.equal(parsed.owner, owner); assert.equal(parsed.key, record.key); assert.equal(parsed.clicks.length, 0);
    assert.deepEqual(fixture.stats(record.key).documents[0], { nonce: parsed.sourceNonce, url: record.urlPath, ...describe(html) });
    if (add) { add.handlers.click({ isTrusted: true }); assert.equal(add.disabled, true); assert.match(selectors.appended.src, /^http:\/\/localhost:\d+\/created-page\/frame\?key=/); assert.equal(JSON.parse(state.textContent).frameAdds[0].trusted, true); }
    const sourceHTML = variant === "root" ? html : await (await fetch(base + "/created-page/frame?key=" + record.key)).text();
    hrefs.push(sourceHTML.match(/<a id="open-child" href="([^"]+)"/)[1]);
    const sourceState = element({ textContent: "" }), sourceLink = element({ href: hrefs.at(-1) });
    script(sourceHTML, { "#state": sourceState, "#open-child": sourceLink });
    sourceLink.handlers.click({ isTrusted: true, ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, button: 0 });
    parsed = JSON.parse(sourceState.textContent); assert.equal(parsed.clicks.length, 1); assert.equal(parsed.clicks[0].documentToken, "original-dom-token");
    assert.equal(parsed.clicks[0].href, base + "/created-page/child"); assert.equal(parsed.clicks[0].ctrlKey, true);
  }
  assert.equal(new Set(hrefs).size, 1); assert.equal(fixture.allStats().cases.length, 6); assert.equal(fixture.allStats().overflow, false);
});

test("same child URL gets different original HTML, then its real script submits exactly the original nonce and click", async t => {
  const { fixture, base } = await serve(t), record = fixture.createCase({ owner: "first", variant: "root" });
  const html = await (await fetch(base + "/created-page/child")).text();
  const second = await (await fetch(base + "/created-page/child")).text(); assert.notEqual(second, html);
  const state = element({ textContent: "" }), result = element({ textContent: "" }), button = element();
  const form = element({ elements: { key: { value: record.key }, owner: { value: record.owner } } });
  const calls = [];
  script(html, { "#state": state, "#result": result, "#commit": button, "#receipt": form }, { fetch: async (url, options) => { calls.push({ url, body: String(options.body) }); return fetch(base + url, options); } });
  const before = JSON.parse(state.textContent); button.handlers.click({ isTrusted: true });
  let prevented = false; await form.handlers.submit({ preventDefault() { prevented = true; } }); assert.equal(prevented, true);
  assert.equal(calls.length, 1); assert.equal(calls[0].url, "/created-page/receipt");
  assert.deepEqual(JSON.parse(result.textContent), { ok: true, key: record.key, owner: record.owner, documentNonce: before.documentNonce });
  const children = fixture.allStats().children; assert.equal(new Set(children.map(child => child.nonce)).size, 2);
  const child = children.find(child => child.nonce === before.documentNonce); assert.deepEqual(child.html, describe(html));
  assert.deepEqual(child.posts[0].body, { ...describe(calls[0].body), truncated: false }); assert.equal(child.posts[0].once, true);
  assert.equal(child.posts[0].fields.documentToken, "original-dom-token"); assert.equal(child.posts[0].finished, true);
  const duplicate = await fetch(base + "/created-page/receipt", post(calls[0].body)); assert.equal(duplicate.status, 409); await duplicate.text();
  assert.equal(fixture.allStats().children.find(child => child.nonce === before.documentNonce).posts.length, 2);
});

test("wrong owner, unknown nonce, duplicate fields and oversized receipt do not consume a child", async t => {
  const { fixture, base } = await serve(t), record = fixture.createCase({ owner: "first", variant: "root" });
  await (await fetch(base + "/created-page/child")).text(); const child = fixture.allStats().children[0];
  for (const [value, status] of [[body(record, child, { owner: "second" }), 403], [body(record, child, { documentNonce: "wrong" }), 403],
    [body(record, child) + "&key=duplicate", 400], [body(record, child) + "&extra=1", 400], ["x".repeat(8193), 400]]) {
    const response = await fetch(base + "/created-page/receipt", post(value)); assert.equal(response.status, status); await response.text();
    assert.equal(fixture.allStats().children[0].consumed, false);
  }
  assert.equal(fixture.allStats().requests.at(-1).body.bytes, 8192); assert.equal(fixture.allStats().requests.at(-1).body.truncated, true);
  const response = await fetch(base + "/created-page/receipt", post(body(record, child))); assert.equal(response.status, 200); await response.text();
});

test("untrusted or repeated child business clicks fail once without a reusable nonce", async t => {
  const { fixture, base } = await serve(t), record = fixture.createCase({ owner: "first", variant: "root" });
  for (const extra of [{ trusted: "false" }, { buttonCount: "2" }]) {
    await (await fetch(base + "/created-page/child")).text(); const child = fixture.allStats().children.at(-1);
    const response = await fetch(base + "/created-page/receipt", post(body(record, child, extra))); assert.equal(response.status, 400); await response.text();
    const retry = await fetch(base + "/created-page/receipt", post(body(record, child))); assert.equal(retry.status, 409); await retry.text();
  }
});

test("case and HTTP record limits are bounded, overflow is explicit, and snapshots cannot mutate registry", async t => {
  const { fixture, base } = await serve(t);
  for (let i = 0; i < 16; i++) fixture.createCase({ key: String(i), owner: "owner", variant: "root" });
  assert.throws(() => fixture.createCase({ owner: "over", variant: "root" }), /limit/);
  for (const options of [{ key: "bad?", owner: "owner", variant: "root" }, { owner: "", variant: "root" }, { owner: "owner", variant: "unknown" }]) assert.throws(() => fixture.createCase(options));
  const copied = fixture.stats("0"); copied.owner = "changed"; assert.equal(fixture.stats("0").owner, "owner");
  assert.equal((await fetch(base + "/unrelated")).status, 404); assert.equal(fixture.allStats().requests.length, 0);
  for (let i = 0; i < 128; i++) await (await fetch(base + "/created-page/unknown")).text();
  const overflow = await fetch(base + "/created-page/unknown"); assert.equal(overflow.status, 503); await overflow.text();
  assert.equal(fixture.allStats().requests.length, 128); assert.equal(fixture.allStats().overflow, true);
});
