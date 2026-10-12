import assert from "node:assert/strict";
import test from "node:test";
import { assertCreatedPageUnownedWire } from "./created-page-unowned-wire.mjs";

const clone = value => structuredClone(value);
const recompute = proof => {
  proof.snapshot.records.forEach((row, index) => { row.sequence = index + 1; });
  proof.snapshot.bytes = proof.snapshot.records.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row)), 0);
  return proof;
};
function workflow() {
  const snapshot = { generation: 7, sessions: [], maxRecords: 10000, maxBytes: 8 * 1024 * 1024, records: [],
    bytes: 0, overflow: false, errors: [], closed: true, restored: true, pendingIds: [] }, items = [];
  let id = 0;
  const rpc = (item, method, extra = {}, result = {}, error, fresh = false) => {
    const requestId = `original-${++id}`;
    snapshot.records.push({ direction: "request", generation: 7, receivedAt: id, message: { jsonrpc: "2.0", id: requestId, method, params: { ...(fresh ? item.freshScope : item.scope), ...extra } } },
      { direction: "response", generation: 7, receivedAt: id, message: { jsonrpc: "2.0", id: requestId, ...(error ? { error: { code: -32000, message: error } } : { result }) } });
  };
  const steps = (selector, frame = false) => [...(frame ? [{ kind: "frame", selector: "#created-page-frame" }] : []), { kind: "css", selector }];
  const action = (item, tabId, name, locator, args = {}) => rpc(item, "browserAction", { tabId, action: name, locator, args, timeoutMs: 5000 }, { value: null });
  const arm = (item, second = false) => rpc(item, "armPageWait", { tabId: item.tabId, timeoutMs: second ? 10000 : 20000 }, { waiterId: second ? item.rearmedWaiterId : item.waiterId, remainingMs: second ? 9000 : 19000 });
  const cancel = (item, second = false) => rpc(item, "cancelPageWait", { tabId: item.tabId, waiterId: second ? item.rearmedWaiterId : item.waiterId });
  for (const variant of ["root", "oopif", "dynamic-oopif"]) {
    const group = [];
    for (const outcome of ["collect-finalize", "cancel-matched"]) {
      const n = items.length, sessionId = `session-${n}`, scope = { session_id: sessionId, turn_id: `turn-${n}`, control_epoch: 3 + n };
      const item = { variant, outcome, scope, freshScope: { ...scope, turn_id: `next-${n}`, control_epoch: scope.control_epoch + 10 },
        tabId: 10 + n, childId: 100 + n, waiterId: `wait-${n}`, ...(outcome === "cancel-matched" ? { rearmedWaiterId: `rearmed-${n}` } : {}),
        key: `key-${n}`, owner: `owner-${n}`, sourceURL: `http://127.0.0.1:50000/source?key=${n}` };
      items.push(item); group.push(item); snapshot.sessions.push(sessionId);
      rpc(item, "getInfo"); rpc(item, "getControlState", {}, { controlEpoch: scope.control_epoch, nextTurnId: scope.turn_id });
      rpc(item, "createTab", { backgroundWindow: true }, { id: item.tabId, active: true }); rpc(item, "attach", { tabId: item.tabId });
      for (const [method, commandParams] of [["Page.enable", {}], ["Page.navigate", { url: item.sourceURL }], ["Page.getFrameTree", {}],
        ["Runtime.evaluate", { expression: "({ href: window.location.href, readyState: document.readyState })", returnByValue: true }]])
        rpc(item, "executeCdp", { target: { tabId: item.tabId }, method, commandParams });
      action(item, item.tabId, "textContent", steps("#state")); arm(item);
    }
    for (const item of group) {
      if (variant === "dynamic-oopif") action(item, item.tabId, "click", steps("#add-frame"));
      action(item, item.tabId, "textContent", steps("#state", variant !== "root"));
    }
    for (const item of group) action(item, item.tabId, "click", steps("#open-child", variant !== "root"), { modifiers: ["Control"] });
    for (const [index, item] of group.entries()) rpc(item, "attach", { tabId: group[1 - index].childId }, undefined, "Tab is not part of browser session");
    for (const item of group) {
      if (item.outcome === "collect-finalize") {
        rpc(item, "collectPageWait", { tabId: item.tabId, waiterId: item.waiterId }, { tabId: item.childId });
        action(item, item.childId, "textContent", steps("#state"));
        for (const [label, value] of [["Source key", item.key], ["Owner", item.owner]])
          action(item, item.childId, "fill", [{ kind: "label", value: label, exact: true }], { value });
        action(item, item.childId, "click", steps("#commit")); action(item, item.childId, "textContent", steps("#result")); cancel(item);
      } else {
        cancel(item); rpc(item, "getTabs", {}, [{ id: item.tabId }]);
        rpc(item, "collectPageWait", { tabId: item.tabId, waiterId: item.waiterId }, undefined, "OBU_PAGE_WAIT_EXPIRED: original wait unavailable");
        rpc(item, "attach", { tabId: item.childId }, undefined, "Tab is not part of browser session");
        cancel(item); action(item, item.tabId, "textContent", steps("#state")); arm(item, true); cancel(item, true);
      }
      rpc(item, "finalizeTabs", { keep: [] }, { controlEpoch: item.freshScope.control_epoch, nextTurnId: item.freshScope.turn_id, endedTurnId: item.scope.turn_id });
      rpc(item, "getControlState", {}, { controlEpoch: item.freshScope.control_epoch, nextTurnId: item.freshScope.turn_id });
      rpc(item, "getTabs", {}, [], undefined, true); rpc(item, "attach", { tabId: item.childId }, undefined, "Tab is not part of browser session", true);
    }
  }
  return recompute({ snapshot, items });
}
const requests = proof => proof.snapshot.records.filter(row => row.direction === "request");
const request = (proof, method, itemIndex = 0, predicate = () => true) => requests(proof).find(row => row.message.method === method && row.message.params.session_id === proof.items[itemIndex].scope.session_id && predicate(row.message.params));
const response = (proof, row) => proof.snapshot.records.find(value => value.direction === "response" && value.message.id === row.message.id);
const removePair = (proof, row) => { proof.snapshot.records = proof.snapshot.records.filter(value => value.message.id !== row.message.id); };
const duplicatePair = (proof, row) => {
  const records = proof.snapshot.records.filter(value => value.message.id === row.message.id).map(clone);
  for (const value of records) value.message.id = "replayed-operation";
  proof.snapshot.records.splice(proof.snapshot.records.indexOf(response(proof, row)) + 1, 0, ...records);
};
const movePairBefore = (proof, row, target) => {
  const pair = proof.snapshot.records.filter(value => value.message.id === row.message.id); removePair(proof, row);
  proof.snapshot.records.splice(proof.snapshot.records.indexOf(target), 0, ...pair);
};

test("six original native RPC workflows prove collection/finalization and matched/idempotent/rearm cancellation separately", () => {
  const result = assertCreatedPageUnownedWire(workflow());
  assert.equal(result.items.length, 6); assert.equal(result.groups.length, 3); assert.equal(result.requests, result.responses);
  assert.ok(result.groups.every(group => group.lastReady < group.firstInput && group.lastPrepared < group.firstTrigger));
});
test("actual typed IDs and interleaved response arrival order remain correctly joined", () => {
  const proof = workflow(), first = proof.snapshot.records.slice(0, 4);
  first[0].message.id = 1; first[1].message.id = 1; first[2].message.id = "1"; first[3].message.id = "1";
  proof.snapshot.records.splice(0, 4, first[0], first[2], first[3], first[1]);
  assert.doesNotThrow(() => assertCreatedPageUnownedWire(recompute(proof)));
});
test("role leaf descriptions preserve the exact original fixture click identities", () => {
  const proof = workflow();
  for (const row of requests(proof).filter(row => row.message.params.action === "click")) {
    const steps = row.message.params.locator, leaf = steps.at(-1), name = { "#open-child": "Open original child", "#add-frame": "Add source frame", "#commit": "Commit child receipt" }[leaf.selector];
    steps[steps.length - 1] = { kind: "role", role: leaf.selector === "#open-child" ? "link" : "button", name, exact: true };
  }
  assert.doesNotThrow(() => assertCreatedPageUnownedWire(recompute(proof)));
});

const mutations = [
  ["open observer", p => { p.snapshot.closed = false; }],
  ["unrestored hook", p => { p.snapshot.restored = false; }],
  ["overflow", p => { p.snapshot.overflow = true; }],
  ["observer errors", p => { p.snapshot.errors = ["observer failed"]; }],
  ["unacknowledged request metadata", p => { p.snapshot.pendingIds = ["pending"]; }],
  ["host generation changed", p => { p.snapshot.records[0].generation++; }],
  ["source scope changed", p => { request(p, "armPageWait").message.params.control_epoch++; }],
  ["wrong fresh scope", p => { request(p, "getTabs").message.params.turn_id = "stale"; }],
  ["manual child claim", p => { request(p, "createTab").message.method = "claimUserTab"; }],
  ["synthetic ordinary source", p => { request(p, "createTab").message.params.backgroundWindow = false; }],
  ["wrong source create ACK", p => { response(p, request(p, "createTab")).message.result.id++; }],
  ["raw input path", p => { request(p, "executeCdp").message.params.method = "Input.dispatchMouseEvent"; }],
  ["scripted click in readiness", p => { request(p, "executeCdp", 0, q => q.method === "Runtime.evaluate").message.params.commandParams.expression = "document.querySelector('#open-child').click()"; }],
  ["different navigation URL", p => { request(p, "executeCdp", 0, q => q.method === "Page.navigate").message.params.commandParams.url = "https://other.invalid"; }],
  ["replenished original wait", p => { response(p, request(p, "armPageWait")).message.result.remainingMs = 20001; }],
  ["wrong collected handle", p => { request(p, "collectPageWait").message.params.waiterId = "different"; }],
  ["wrong returned child", p => { response(p, request(p, "collectPageWait")).message.result.tabId++; }],
  ["wrong cancel handle", p => { request(p, "cancelPageWait").message.params.waiterId = "different"; }],
  ["cancel matched collected successfully", p => { const m = response(p, request(p, "collectPageWait", 1)).message; delete m.error; m.result = { tabId: p.items[1].childId }; }],
  ["unrelated failed collect", p => { response(p, request(p, "collectPageWait", 1)).message.error.message = "transport disconnected"; }],
  ["cleanup failed", p => { const m = response(p, request(p, "cancelPageWait")).message; delete m.result; m.error = { message: "cleanup failed" }; }],
  ["cleanup nonempty ACK", p => { response(p, request(p, "cancelPageWait")).message.result = { cleaned: true }; }],
  ["rearm reused original handle", p => { p.items[1].rearmedWaiterId = p.items[1].waiterId; }],
  ["rearm ACK wrong handle", p => { const arms = requests(p).filter(row => row.message.method === "armPageWait" && row.message.params.tabId === p.items[1].tabId); response(p, arms[1]).message.result.waiterId = "wrong"; }],
  ["retained cancelled child in inventory", p => { response(p, request(p, "getTabs", 1)).message.result.push({ id: p.items[1].childId }); }],
  ["source lost on cancel", p => { response(p, request(p, "getTabs", 1)).message.result = []; }],
  ["retained finalized child", p => { response(p, request(p, "getTabs")).message.result = [{ id: p.items[0].childId }]; }],
  ["different finalization epoch", p => { response(p, request(p, "finalizeTabs")).message.result.controlEpoch++; }],
  ["handoff instead of authority release", p => { request(p, "finalizeTabs").message.params.keep = [{ tabId: p.items[0].childId, status: "handoff" }]; }],
  ["foreign attach succeeded", p => { const m = response(p, request(p, "attach", 0, q => q.tabId === p.items[1].childId)).message; delete m.error; m.result = {}; }],
  ["fresh own attach succeeded", p => { const m = response(p, request(p, "attach", 0, q => q.tabId === p.items[0].childId)).message; delete m.error; m.result = {}; }],
  ["foreign denial only a timeout", p => { response(p, request(p, "attach", 0, q => q.tabId === p.items[1].childId)).message.error.message = "RPC timeout"; }],
  ["unrelated foreign child", p => { request(p, "attach", 0, q => q.tabId === p.items[1].childId).message.params.tabId = p.items[3].childId; }],
  ["missing Control modifier", p => { request(p, "browserAction", 0, q => q.action === "click").message.params.args = {}; }],
  ["alternate frame target", p => { request(p, "browserAction", 2, q => q.action === "click").message.params.locator[0].selector = "#other-frame"; }],
  ["wrong business field", p => { request(p, "browserAction", 0, q => q.action === "fill").message.params.locator[0].value = "Other"; }],
  ["wrong source form value", p => { request(p, "browserAction", 0, q => q.action === "fill").message.params.args.value = "other-key"; }],
  ["other child browser action", p => { request(p, "browserAction", 0, q => q.action === "fill").message.params.tabId = p.items[1].childId; }],
  ["cancelled-child browser action", p => { request(p, "browserAction", 1, q => q.action === "textContent").message.params.tabId = p.items[1].childId; }],
  ["replacement keyboard action", p => { request(p, "browserAction", 0, q => q.action === "click").message.params.action = "press"; }],
];
for (const [name, mutate] of mutations) test(`rejects ${name}`, () => {
  const proof = workflow(); mutate(proof); assert.throws(() => assertCreatedPageUnownedWire(recompute(proof)));
});

test("original wait, cancel, finalization and trigger cannot be missing or replayed", () => {
  for (const [method, index, predicate] of [["armPageWait", 0], ["collectPageWait", 0], ["cancelPageWait", 0], ["cancelPageWait", 1], ["finalizeTabs", 0], ["browserAction", 0, p => p.action === "click"]]) {
    for (const operation of [removePair, duplicatePair]) {
      const proof = workflow(); operation(proof, request(proof, method, index, predicate));
      assert.throws(() => assertCreatedPageUnownedWire(recompute(proof)), `${operation.name}: ${method}`);
    }
  }
});
test("missing, duplicate, orphan and pre-request replies cannot pass a complete metadata snapshot", () => {
  const missing = workflow(); missing.snapshot.records.splice(1, 1);
  assert.throws(() => assertCreatedPageUnownedWire(recompute(missing)), /Every actual request/);
  const duplicate = workflow(); duplicate.snapshot.records.push(clone(duplicate.snapshot.records[1]));
  assert.throws(() => assertCreatedPageUnownedWire(recompute(duplicate)), /One original response/);
  const orphan = workflow(); orphan.snapshot.records[1].message.id = "unknown";
  assert.throws(() => assertCreatedPageUnownedWire(recompute(orphan)), /One original response/);
  const reversed = workflow(); reversed.snapshot.records.splice(0, 2, reversed.snapshot.records[1], reversed.snapshot.records[0]);
  assert.throws(() => assertCreatedPageUnownedWire(recompute(reversed)), /One original response/);
});
test("both group ready ACKs precede even the other source's first trigger", () => {
  const proof = workflow(), secondArm = request(proof, "armPageWait", 1), secondRead = request(proof, "browserAction", 1, p => p.action === "textContent" && p.tabId === proof.items[1].tabId);
  const reads = requests(proof).filter(row => row.message.method === "browserAction" && row.message.params.tabId === proof.items[1].tabId && row.message.params.action === "textContent");
  const prepared = reads[1], trigger = request(proof, "browserAction", 1, p => p.action === "click");
  movePairBefore(proof, secondArm, trigger); movePairBefore(proof, prepared, trigger);
  assert.throws(() => assertCreatedPageUnownedWire(recompute(proof)), /Both original ready ACKs/);
  assert.ok(secondRead);
});
test("both original source preparations precede even the other source's first trigger", () => {
  const proof = workflow(), reads = requests(proof).filter(row => row.message.method === "browserAction" && row.message.params.tabId === proof.items[1].tabId && row.message.params.action === "textContent");
  movePairBefore(proof, reads[1], request(proof, "browserAction", 1, p => p.action === "click"));
  assert.throws(() => assertCreatedPageUnownedWire(recompute(proof)), /Both original source preparation ACKs/);
});
test("rearm cannot precede acknowledged idempotent cancellation", () => {
  const proof = workflow(), arms = requests(proof).filter(row => row.message.method === "armPageWait" && row.message.params.tabId === proof.items[1].tabId);
  movePairBefore(proof, arms[1], request(proof, "cancelPageWait", 1));
  assert.throws(() => assertCreatedPageUnownedWire(recompute(proof)), /Rearm after original reverse-lock release/);
});
test("source CDP cannot resume after original arm", () => {
  const proof = workflow(); movePairBefore(proof, request(proof, "executeCdp"), request(proof, "collectPageWait"));
  assert.throws(() => assertCreatedPageUnownedWire(recompute(proof)), /Source CDP setup ends/);
});
