import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { createManagedMultiClickFixture } from "./managed-human-multi-click-fixture.mjs";

test("multi-click fixture serves two original textareas, records native events, refuses reload and all POSTs", async () => {
  const fixture = createManagedMultiClickFixture();
  const server = createServer((request, response) => { if (!fixture.handle(request, response)) response.writeHead(404).end(); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/human-multi-click`;
    const response = await fetch(url), html = await response.text(); assert.equal(response.status, 200);
    assert.equal((html.match(/<textarea id=/g) ?? []).length, 2); assert.match(html, /'dblclick'/);
    assert.match(html, /event\.isTrusted/); assert.match(html, /event\.detail/);
    assert.doesNotMatch(html, /dispatchEvent|setSelectionRange|\.select\(|clipboard|fetch\(/);
    assert.equal((await fetch(url)).status, 405);
    assert.equal((await fetch(url, { method: "POST", body: "no business" })).status, 405);
    const stats = fixture.stats(); assert.equal(stats.overflow, false); assert.ok(stats.requests[0].documentToken);
    assert.equal(stats.requests[0].finished, true); assert.equal(stats.requests[0].aborted, false);
    assert.equal(stats.requests.filter(row => row.status === 200).length, 1);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
