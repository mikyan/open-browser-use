import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { createManagedKeyRepeatFixture } from "./managed-human-key-repeat-fixture.mjs";

test("repeat fixture serves one original bounded page and never accepts a business POST", async () => {
  const fixture = createManagedKeyRepeatFixture(), server = createServer((request, response) => { if (!fixture.handle(request, response)) response.writeHead(404).end(); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/human-key-repeat`;
    const response = await fetch(url), html = await response.text(); assert.equal(response.status, 200);
    assert.equal((html.match(/<textarea id=/g) ?? []).length, 6);
    assert.match(html, /repeat-prevented/); assert.match(html, /event\.preventDefault\(\)/);
    assert.doesNotMatch(html, /dispatchEvent|clipboard|fetch\(/);
    assert.equal((await fetch(url, { method: "POST", body: "no business" })).status, 405);
    const stats = fixture.stats(); assert.equal(stats.overflow, false); assert.equal(stats.requests.length, 2);
    assert.ok(stats.requests[0].documentToken); assert.equal(stats.requests[0].finished, true); assert.equal(stats.requests[0].aborted, false);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
