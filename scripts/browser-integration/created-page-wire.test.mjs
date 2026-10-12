import assert from "node:assert/strict";
import { createContext, runInContext } from "node:vm";
import test from "node:test";
import { assertCreatedPageWire, installCreatedPageWireObserver } from "./created-page-wire.mjs";

const plain = value => JSON.parse(JSON.stringify(value));
function observer({ sessions = ["owner-a"], generation = 7, previous, ...limits } = {}) {
  const context = createContext({ chrome: { runtime: { id: "original-extension" } }, Date, TextEncoder });
  if (previous) Object.defineProperty(context, "__integrationNativeRPCObserver", { configurable: true, writable: true, enumerable: false, value: previous });
  const descriptor = Object.getOwnPropertyDescriptor(context, "__integrationNativeRPCObserver");
  const installed = plain(runInContext(`(${installCreatedPageWireObserver.toString()})(chrome,globalThis,${JSON.stringify({ sessions, generation, ...limits })})`, context));
  return { context, descriptor, installed, api: context.__createdPageWire,
    emit: (direction, message) => context.__integrationNativeRPCObserver(direction, message),
    snapshot: () => plain(context.__createdPageWire.snapshot()), stop: () => plain(context.__createdPageWire.stop()) };
}
const request = (id, method = "getInfo", params = { session_id: "owner-a" }) => ({ jsonrpc: "2.0", id, method, params });
const response = (id, result = {}) => ({ jsonrpc: "2.0", id, result });

test("serialized worker observer records full selected JSON and typed IDs without mutating messages or replacing the prior hook", () => {
  const called = [], previous = function (...args) { called.push({ receiver: this, args }); }, observed = observer({ previous });
  assert.deepEqual(observed.installed, { installed: true, generation: 7, sessions: ["owner-a"], maxRecords: 10000, maxBytes: 8 * 1024 * 1024 });
  const first = request(1, "getInfo", { session_id: "owner-a", future: { original: "完整字段" } });
  observed.emit("request", first); first.params.future.original = "mutated after hook";
  observed.emit("request", request("1"));
  observed.emit("request", request("foreign", "getInfo", { session_id: "foreign" }));
  observed.emit("response", response("foreign", { secret: "must not capture" }));
  observed.emit("response", response("1", { metadata: { extra: true } }));
  observed.emit("response", response(1));
  observed.emit("response", { method: "obu.native.hello", params: { secret: "notification" } });
  const snapshot = observed.snapshot();
  assert.equal(snapshot.records.length, 4); assert.deepEqual(snapshot.pendingIds, []);
  assert.equal(snapshot.records[0].message.params.future.original, "完整字段");
  assert.deepEqual(snapshot.records[2].message.result, { metadata: { extra: true } });
  assert.equal(called.length, 7); assert.equal(called[0].args[1], first); assert.ok(called[0].receiver);
  snapshot.records.length = 0; assert.equal(observed.snapshot().records.length, 4);
  const stopped = observed.stop(); assert.equal(stopped.closed, true); assert.equal(stopped.restored, true);
  assert.deepEqual(Object.getOwnPropertyDescriptor(observed.context, "__integrationNativeRPCObserver"), observed.descriptor);
  assert.deepEqual(observed.stop(), stopped);
  observed.emit("request", request("after-stop")); assert.equal(observed.snapshot().records.length, 4); assert.equal(called.length, 8);
});

test("record and byte overflow are explicit and bounded without suppressing the actual call chain", () => {
  for (const limits of [{ maxRecords: 2 }, { maxBytes: 1 }]) {
    let calls = 0; const observed = observer({ ...limits, previous: () => { calls++; } });
    for (let index = 0; index < 10; index++) { observed.emit("request", request(index)); observed.emit("response", response(index)); }
    const snapshot = observed.stop(); assert.equal(snapshot.overflow, true); assert.equal(calls, 20);
    assert.ok(snapshot.records.length <= snapshot.maxRecords && snapshot.bytes <= snapshot.maxBytes);
  }
});

test("observer serialization/prior-hook failures never throw into business and remain failed evidence", () => {
  let businessCalls = 0, previousCalls = 0;
  const observed = observer({ previous: () => { previousCalls++; throw Error("prior observer failed"); } });
  const circular = request("circular"); circular.params.self = circular;
  assert.doesNotThrow(() => { observed.emit("request", circular); businessCalls++; });
  assert.equal(previousCalls, 1); assert.equal(businessCalls, 1);
  const snapshot = observed.stop(); assert.equal(snapshot.records.length, 0); assert.equal(snapshot.errors.length, 2);
});

test("duplicate requests or responses are failed evidence and foreign ID reuse cannot leak another response", () => {
  const observed = observer();
  observed.emit("request", request("x")); observed.emit("response", response("x")); observed.emit("response", response("x"));
  observed.emit("request", request("x", "getInfo", { session_id: "foreign" })); observed.emit("response", response("x", { secret: "foreign" }));
  const snapshot = observed.stop(); assert.equal(snapshot.records.length, 3);
  assert.equal(snapshot.errors.length, 2); assert.deepEqual(snapshot.pendingIds, ["x"]);
  assert.ok(!JSON.stringify(snapshot).includes("foreign"));
});

test("stop preserves a replacement hook but fails restoration, and removes its own newly created hook", () => {
  const observed = observer(), replacement = () => {};
  observed.context.__integrationNativeRPCObserver = replacement;
  const stopped = observed.stop(); assert.equal(stopped.closed, true); assert.equal(stopped.restored, false); assert.equal(stopped.errors.length, 1);
  assert.equal(observed.context.__integrationNativeRPCObserver, replacement);
  const clean = observer(); assert.equal(clean.stop().restored, true); assert.equal(Object.hasOwn(clean.context, "__integrationNativeRPCObserver"), false);
});

test("invalid installation limits and duplicate observer are rejected before replacing the hook", () => {
  for (const options of [{ sessions: [] }, { sessions: ["a", "a"] }, { generation: 0 }, { maxRecords: 10001 }, { maxBytes: 8 * 1024 * 1024 + 1 }]) assert.throws(() => observer(options), /Invalid/);
  const observed = observer(), hook = observed.context.__integrationNativeRPCObserver;
  assert.throws(() => installCreatedPageWireObserver(observed.context.chrome, observed.context, { sessions: ["owner-a"], generation: 7 }), /Invalid/);
  assert.equal(observed.context.__integrationNativeRPCObserver, hook); observed.stop();
});

function workflow({ variants = ["root", "oopif", "dynamic-oopif"], owners = ["owner-a", "owner-b"], role = false } = {}) {
  const observed = observer({ sessions: owners }), items = []; let id = 0;
  const rpc = (method, params, result = {}) => { const next = `host-${++id}`; observed.emit("request", request(next, method, params)); observed.emit("response", response(next, result)); };
  const locator = (kind, frame) => [...(frame ? [{ kind: "frame", selector: "#created-page-frame" }] : []), role ?
    { kind: "role", role: kind === "trigger" ? "link" : "button", name: kind === "trigger" ? "Open original child" : kind === "add" ? "Add source frame" : "Commit child receipt", exact: true } :
    { kind: "css", selector: kind === "trigger" ? "#open-child" : kind === "add" ? "#add-frame" : "#commit" }];
  const action = (scope, tabId, name, steps, args = {}) => rpc("browserAction", { ...scope, tabId, action: name, locator: steps, args, timeoutMs: 5000 }, { value: null, engine: { name: "playwright-crx", version: "1", playwrightVersion: "1" } });
  for (const variant of variants) {
    const group = [];
    for (const [index, sessionId] of owners.entries()) {
      const tabId = 10 + items.length, childId = 100 + items.length, turnId = `turn-${index}`, controlEpoch = 3 + index, waiterId = `wait-${tabId}`;
      const scope = { session_id: sessionId, turn_id: turnId, control_epoch: controlEpoch };
      items.push({ sessionId, turnId, controlEpoch, tabId, childId, variant }); group.push({ scope, tabId, childId, waiterId });
      rpc("getInfo", { session_id: sessionId });
      rpc("getControlState", { session_id: sessionId, turn_id: "bootstrap-not-protected" }, { controlEpoch, nextTurnId: turnId });
      rpc("createTab", scope, { tabId });
      rpc("attach", { ...scope, tabId });
      for (const [method, commandParams] of [["Page.enable", {}], ["Page.navigate", { url: "http://example.invalid/source" }], ["Page.getFrameTree", {}], ["Runtime.evaluate", { expression: "({ href: window.location.href, readyState: document.readyState })", returnByValue: true }]]) rpc("executeCdp", { ...scope, target: { tabId }, method, commandParams });
      rpc("armPageWait", { ...scope, tabId, timeoutMs: 20000 }, { waiterId, remainingMs: 19000 });
    }
    for (const { scope, tabId } of group) {
      if (variant === "dynamic-oopif") action(scope, tabId, "click", locator("add", false));
      action(scope, tabId, "textContent", [...(variant === "root" ? [] : [{ kind: "frame", selector: "#created-page-frame" }]), { kind: "css", selector: "#state" }]);
    }
    for (const { scope, tabId, childId, waiterId } of group) {
      action(scope, tabId, "click", locator("trigger", variant !== "root"), { modifiers: ["Control"] });
      rpc("collectPageWait", { ...scope, tabId, waiterId }, { tabId: childId });
      action(scope, childId, "textContent", [{ kind: "css", selector: "#state" }]);
      action(scope, childId, "fill", [{ kind: "label", value: "Source key", exact: true }], { value: "original-key" });
      action(scope, childId, "click", locator("commit", false));
      rpc("cancelPageWait", { ...scope, tabId, waiterId });
    }
  }
  return { snapshot: observed.stop(), items };
}
function recalculate(proof) {
  proof.snapshot.records.forEach((row, index) => { row.sequence = index + 1; });
  proof.snapshot.bytes = proof.snapshot.records.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row)), 0);
  return proof;
}
const byMethod = (proof, method, direction = "request") => proof.snapshot.records.find(row => row.direction === direction && (direction === "request" ? row.message.method === method : proof.snapshot.records.some(request => request.direction === "request" && request.message.id === row.message.id && request.message.method === method)));
const byClick = (proof, tabId) => proof.snapshot.records.find(row => row.direction === "request" && row.message.method === "browserAction" && row.message.params.tabId === tabId && row.message.params.action === "click");

test("wire verifier joins two original sessions across three layouts, parent setup and bootstrap, allowing CSS or role leaves", () => {
  for (const role of [false, true]) {
    const proof = workflow({ role }), result = assertCreatedPageWire(proof);
    assert.equal(result.sessions, 2); assert.equal(result.items.length, 6); assert.equal(result.requests, result.responses);
    assert.deepEqual(result.items.map(item => item.childId), proof.items.map(item => item.childId));
  }
});

test("wire verifier accepts genuinely interleaved RPCs using exact typed IDs, not response arrival order", () => {
  const proof = workflow({ variants: ["root"], owners: ["owner-a"] });
  const [firstRequest, firstResponse, secondRequest, secondResponse] = proof.snapshot.records.splice(0, 4);
  firstRequest.message.id = 1; firstResponse.message.id = 1; secondRequest.message.id = "1"; secondResponse.message.id = "1";
  proof.snapshot.records.unshift(firstRequest, secondRequest, secondResponse, firstResponse);
  assert.doesNotThrow(() => assertCreatedPageWire(recalculate(proof)));
});

test("actual sequence gates support one, two or five original callers per layout", () => {
  for (const count of [1, 2, 5]) {
    const result = assertCreatedPageWire(workflow({ owners: Array.from({ length: count }, (_, index) => `owner-${index}`) }));
    assert.equal(result.groups.length, 3);
    for (const group of result.groups) {
      assert.equal(group.members, count);
      assert.ok(group.lastReadySequence < group.firstInputSequence);
      assert.ok(group.lastPreparedSequence < group.firstTriggerSequence);
    }
  }
});

test("another caller's late arm ACK cannot pass the group gate even when its own Add is later", () => {
  const proof = workflow({ variants: ["dynamic-oopif"] }), second = proof.items[1];
  const arm = proof.snapshot.records.find(row => row.message.method === "armPageWait" && row.message.params.tabId === second.tabId);
  const pair = proof.snapshot.records.filter(row => row.message.id === arm.message.id);
  proof.snapshot.records = proof.snapshot.records.filter(row => row.message.id !== arm.message.id);
  const ownAdd = byClick(proof, second.tabId); proof.snapshot.records.splice(proof.snapshot.records.indexOf(ownAdd), 0, ...pair);
  assert.throws(() => assertCreatedPageWire(recalculate(proof)), /Every original arm ACK/);
});

test("another caller's late source state ACK cannot pass the prepared group gate even when its own trigger is later", () => {
  const proof = workflow({ variants: ["root"] }), second = proof.items[1];
  const read = proof.snapshot.records.find(row => row.message.method === "browserAction" && row.message.params.tabId === second.tabId && row.message.params.action === "textContent");
  const pair = proof.snapshot.records.filter(row => row.message.id === read.message.id);
  proof.snapshot.records = proof.snapshot.records.filter(row => row.message.id !== read.message.id);
  const ownTrigger = byClick(proof, second.tabId); proof.snapshot.records.splice(proof.snapshot.records.indexOf(ownTrigger), 0, ...pair);
  assert.throws(() => assertCreatedPageWire(recalculate(proof)), /Every original source state ACK/);
});

const mutations = [
  ["unclosed observer", proof => { proof.snapshot.closed = false; }],
  ["overflow", proof => { proof.snapshot.overflow = true; }],
  ["unrestored hook", proof => { proof.snapshot.restored = false; }],
  ["observer error", proof => { proof.snapshot.errors.push("failed observation"); }],
  ["actual pending request", proof => { proof.snapshot.pendingIds.push("native-pending"); }],
  ["different generation", proof => { proof.snapshot.records[0].generation++; }],
  ["new protected turn in parent creation", proof => { byMethod(proof, "createTab").message.params.turn_id = "new-turn"; }],
  ["wrong epoch in protected navigation", proof => { byMethod(proof, "executeCdp").message.params.control_epoch++; }],
  ["manual user claim", proof => { byMethod(proof, "createTab").message.method = "claimUserTab"; }],
  ["extra raw input path", proof => { byMethod(proof, "executeCdp").message.params.method = "Input.dispatchMouseEvent"; }],
  ["extra keyboard action", proof => { byClick(proof, proof.items[0].tabId).message.params.action = "press"; }],
  ["scripted business input", proof => { const row = proof.snapshot.records.find(row => row.message.params?.method === "Runtime.evaluate"); row.message.params.commandParams.expression = "document.querySelector('#open-child').click()"; }],
  ["wrong collect handle", proof => { byMethod(proof, "collectPageWait").message.params.waiterId = "successor-waiter"; }],
  ["wrong cancel handle", proof => { byMethod(proof, "cancelPageWait").message.params.waiterId = "successor-waiter"; }],
  ["wrong returned child", proof => { byMethod(proof, "collectPageWait", "response").message.result.tabId++; }],
  ["cleanup error", proof => { const response = byMethod(proof, "cancelPageWait", "response").message; delete response.result; response.error = { message: "failed" }; }],
  ["unexpected cleanup result", proof => { byMethod(proof, "cancelPageWait", "response").message.result = { cancelled: true }; }],
  ["budget replenishment", proof => { byMethod(proof, "armPageWait", "response").message.result.remainingMs = 20001; }],
  ["missing Control modifier", proof => { byClick(proof, proof.items[0].tabId).message.params.args = {}; }],
  ["wrong frame locator", proof => { byClick(proof, proof.items.find(item => item.variant === "oopif").tabId).message.params.locator[0].selector = "#successor-frame"; }],
  ["wrong business locator", proof => { byClick(proof, proof.items[0].childId).message.params.locator = [{ kind: "css", selector: "#wrong-commit" }]; }],
  ["action on foreign session child", proof => { byClick(proof, proof.items[0].childId).message.params.tabId = proof.items[1].childId; }],
  ["cross-variant scope changed", proof => { proof.items[2].turnId = "new-turn"; }],
  ["duplicate child identity", proof => { proof.items[1].childId = proof.items[0].childId; }],
];
for (const [name, mutate] of mutations) test(`wire verifier rejects ${name}`, () => { const proof = workflow(); mutate(proof); assert.throws(() => assertCreatedPageWire(recalculate(proof))); });

test("missing and replayed actual operations fail even with consistent record byte counts", () => {
  for (const method of ["armPageWait", "collectPageWait", "cancelPageWait"]) {
    const missing = workflow(), original = byMethod(missing, method);
    missing.snapshot.records = missing.snapshot.records.filter(row => row.message.id !== original.message.id);
    assert.throws(() => assertCreatedPageWire(recalculate(missing)), /One original/);
    const replayed = workflow(), originalId = byMethod(replayed, method).message.id;
    const pair = replayed.snapshot.records.filter(row => row.message.id === originalId).map(plain);
    pair.forEach(row => { row.message.id = "replayed-request"; }); replayed.snapshot.records.push(...pair);
    assert.throws(() => assertCreatedPageWire(recalculate(replayed)), /One original/);
  }
  const proof = workflow(), original = byClick(proof, proof.items[0].tabId);
  const pair = proof.snapshot.records.filter(row => row.message.id === original.message.id).map(plain);
  pair.forEach(row => { row.message.id = "replayed-click"; }); proof.snapshot.records.push(...pair);
  assert.throws(() => assertCreatedPageWire(recalculate(proof)), /One original source Control-click/);
});

test("late ready ACK, early collect and business-before-child ACK cannot satisfy the actual sequence", () => {
  for (const [method, destination] of [["armPageWait", "collectPageWait"], ["collectPageWait", "cancelPageWait"]]) {
    const proof = workflow(), response = byMethod(proof, method, "response");
    proof.snapshot.records.splice(proof.snapshot.records.indexOf(response), 1);
    const before = byMethod(proof, destination); proof.snapshot.records.splice(proof.snapshot.records.indexOf(before), 0, response);
    assert.throws(() => assertCreatedPageWire(recalculate(proof)));
  }
  const proof = workflow(), trigger = byClick(proof, proof.items[0].tabId), collect = byMethod(proof, "collectPageWait");
  proof.snapshot.records.splice(proof.snapshot.records.indexOf(collect), 1); proof.snapshot.records.splice(proof.snapshot.records.indexOf(trigger), 0, collect);
  assert.throws(() => assertCreatedPageWire(recalculate(proof)), /then collect/);
});

test("unanswered, duplicate and orphan responses fail independently of observer metadata", () => {
  const missing = workflow(); missing.snapshot.records.splice(1, 1);
  assert.throws(() => assertCreatedPageWire(recalculate(missing)), /No missing/);
  const duplicate = workflow(); duplicate.snapshot.records.push(plain(duplicate.snapshot.records[1]));
  assert.throws(() => assertCreatedPageWire(recalculate(duplicate)), /Exactly one response/);
  const orphan = workflow(); orphan.snapshot.records[1].message.id = "unknown-request";
  assert.throws(() => assertCreatedPageWire(recalculate(orphan)), /Exactly one response/);
});
