import assert from "node:assert/strict";

// Independent browser metadata verifies the caller's cleanup intent. Neither
// these observations nor the server's private answer are available to drivers.
export function checkResearchTabDisposition(caller, before, after, events, fixtureURL) {
  const created = caller.createdTabIds, kept = caller.keptTabIds, closed = caller.closedTabIds;
  assert.ok(Array.isArray(created) && created.length >= 4);
  assert.ok(created.every(Number.isSafeInteger));
  assert.equal(new Set(created).size, created.length);
  assert.equal(kept.length, 1, "Keep exactly the final report");
  assert.equal(caller.reportTabId, kept[0]);
  assert.deepEqual([...closed, ...kept].sort((a, b) => a - b), [...created].sort((a, b) => a - b));
  assert.ok(created.every(id => !before.some(tab => tab.id === id)), "Do not claim pre-existing pages as created");
  assert.deepEqual(events.filter(event => event.type === "created").map(event => event.tab.id).sort((a, b) => a - b), [...created].sort((a, b) => a - b));
  assert.deepEqual(events.filter(event => event.type === "removed").map(event => event.tabId).sort((a, b) => a - b), [...closed].sort((a, b) => a - b));
  assert.ok(closed.every(id => !after.some(tab => tab.id === id)), "Research pages must actually close");
  const report = after.find(tab => tab.id === kept[0]);
  assert.ok(report, "Deliverable must remain open");
  assert.equal(new URL(report.url).pathname, `/research-task/${caller.key}/report`);
  assert.equal(new URL(report.url).origin, new URL(fixtureURL).origin);
  assert.equal(report.active, false, "Do not activate the final report");
  assert.deepEqual(after.filter(tab => !created.includes(tab.id)).map(tab => tab.id).sort((a, b) => a - b), before.map(tab => tab.id).sort((a, b) => a - b), "Preserve all pre-existing tabs");
  for (const original of before) {
    const current = after.find(tab => tab.id === original.id);
    for (const field of ["url", "windowId", "groupId", "pinned"]) assert.equal(current[field], original[field], `Preserve tab ${original.id} ${field}`);
  }
  return { report, createdTabIds: created, closedTabIds: closed, events, before, after };
}
