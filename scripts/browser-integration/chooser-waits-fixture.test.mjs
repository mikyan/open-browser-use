import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";
import { Script } from "node:vm";
import { chooserPageHTML, chooserVariants, createChooserWaitFixtures, checkChooserReceipts, installChooserTrace } from "./chooser-waits-fixture.mjs";

const bytes = Buffer.from("actual file 中文\0bytes");
const files = [{ name: "fixture.txt", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }];
const payload = (sequence, variant = "root") => ({ key: "test-root", variant, sequence, documentToken: "document-one",
  href: `http://${variant === "root" ? "127.0.0.1" : "localhost"}:1234/chooser-waits/page`,
  clicks: Array.from({ length: sequence }, () => ({ trusted: true })),
  changes: [{ trusted: true, count: 1 }, ...(sequence === 2 ? [{ trusted: false, count: 0 }] : [])],
  files: sequence === 1 ? [{ name: files[0].name, size: bytes.length, base64: bytes.toString("base64") }] : [] });

test("chooser native trace retains exact bounded event order and ignores other tabs/methods", () => {
  let listener; const target = {}, chrome = { debugger: { onEvent: { addListener(value) { listener = value; } } } };
  installChooserTrace(chrome, target, 42, 2);
  listener({ tabId: 43 }, "Page.frameNavigated", { frame: { id: "foreign" } });
  listener({ tabId: 42 }, "Runtime.consoleAPICalled", { type: "log" });
  const source = { tabId: 42, sessionId: "native-child" }, params = { frame: { id: "frame", parentId: "root", loaderId: "loader", url: "about:blank" }, type: "Navigation" };
  listener(source, "Page.frameNavigated", params); params.frame.url = "changed";
  listener(source, "Page.frameDetached", { frameId: "frame", reason: "swap" });
  listener(source, "Page.fileChooserOpened", { frameId: "frame" });
  assert.equal(target.__chooserReadyTrace.overflow, true);
  assert.deepEqual(target.__chooserReadyTrace.events.map(({ sequence, source, method, params }) => ({ sequence, source, method, params })), [
    { sequence: 0, source, method: "Page.frameNavigated", params: { frame: { id: "frame", parentId: "root", loaderId: "loader", url: "about:blank" }, type: "Navigation" } },
    { sequence: 1, source, method: "Page.frameDetached", params: { frameId: "frame", reason: "swap" } }
  ]);
});

test("chooser fixture root and static/dynamic cross-origin scripts parse and retain real File bytes and event trust", () => {
  for (const variant of chooserVariants) for (const route of ["page", "frame"]) {
    const html = chooserPageHTML(new URL(`http://127.0.0.1/chooser-waits/${route}?key=test-root&variant=${variant}`), 1234);
    for (const [, script] of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Script(script);
    assert.match(html, /file\.arrayBuffer\(\)/); assert.match(html, /event\.isTrusted/);
    if (variant === "dynamic-oopif" && route === "page") { assert.match(html, /Add upload frame/); assert.doesNotMatch(html, /<iframe/); }
    if (variant === "oopif" && route === "page") assert.match(html, /<iframe[^>]+localhost:1234/);
  }
});

test("HTTP chooser witness computes actual decoded bytes and rejects mismatched lengths", async () => {
  const fixture = createChooserWaitFixtures();
  const server = createServer((request, response) => { if (!fixture.handle(request, response, server.address().port)) { response.writeHead(404); response.end(); } });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}/chooser-waits/upload?key=test-root&variant=root`;
  const post = value => fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });
  try {
    for (const sequence of [1, 2]) {
      const response = await post(payload(sequence)); assert.equal(response.status, 200);
      const receipt = await response.json(); assert.deepEqual(receipt.files, sequence === 1 ? files : []);
    }
    const record = fixture.stats("test-root"); checkChooserReceipts(record, files, "root");
    const wrong = payload(3); wrong.files = [{ name: "fixture.txt", size: 100, base64: bytes.toString("base64") }];
    assert.equal((await post(wrong)).status, 400); assert.ok(fixture.stats("test-root").posts[2].error);
    // A server-successful RPC/POST is insufficient: exact trust, multiplicity,
    // bytes and same document must independently match the retained witness.
    for (const mutate of [
      value => value.posts.push(structuredClone(value.posts[1])),
      value => { value.posts[0].files[0].sha256 = "forged"; },
      value => { value.posts[0].clicks[0].trusted = false; },
      value => { value.posts[1].documentToken = "replaced"; },
      value => { value.posts[1].files = files; }
    ]) { const invalid = structuredClone(record); mutate(invalid); assert.throws(() => checkChooserReceipts(invalid, files, "root")); }
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
