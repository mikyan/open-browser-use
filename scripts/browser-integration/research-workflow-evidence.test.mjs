import assert from "node:assert/strict";
import test from "node:test";
import { checkResearchTabDisposition } from "./research-workflow-evidence.mjs";

function evidence() {
  return [{ key: "trial", reportTabId: 5, createdTabIds: [2, 3, 4, 5], keptTabIds: [5], closedTabIds: [2, 3, 4] },
    [{ id: 1 }], [{ id: 1 }, { id: 5, active: false, url: "http://127.0.0.1/research-task/trial/report" }],
    [...[2, 3, 4, 5].map(id => ({ type: "created", tab: { id } })), ...[2, 3, 4].map(tabId => ({ type: "removed", tabId }))], "http://127.0.0.1/"];
}
test("research cleanup requires native create/remove observations and an inactive retained report", () => {
  assert.equal(checkResearchTabDisposition(...evidence()).report.id, 5);
  for (const corrupt of [
    input => input[3].pop(),
    input => input[2].push({ id: 2 }),
    input => input[2].splice(0, 1),
    input => { input[2][1].active = true; },
    input => { input[2][1].url = "http://127.0.0.1/research-task/wrong/report"; },
    input => { input[2][1].url = "http://localhost/research-task/trial/report"; },
    input => { input[2][0].url = "http://127.0.0.1/changed"; },
    input => { input[2][0].windowId = 99; },
    input => { input[2][0].groupId = 99; },
    input => { input[2][0].pinned = true; },
    input => input[0].createdTabIds.push(5),
    input => input[3].push({ type: "created", tab: { id: 99 } }),
  ]) {
    const input = evidence(); corrupt(input);
    assert.throws(() => checkResearchTabDisposition(...input));
  }
});
