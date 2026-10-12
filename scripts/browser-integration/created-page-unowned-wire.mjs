import assert from "node:assert/strict";

const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const originalScope = item => item.scope ?? { session_id: item.sessionId, turn_id: item.turnId, control_epoch: item.controlEpoch };
const scope = value => ({ session_id: value?.session_id, turn_id: value?.turn_id, control_epoch: value?.control_epoch });
const key = id => { assert.ok(typeof id === "string" || typeof id === "number" && Number.isFinite(id), "Original typed RPC identity"); return JSON.stringify([typeof id, id]); };
const one = (values, label) => { assert.equal(values.length, 1, label); return values[0]; };
const exactKeys = (value, keys, label) => { assert.ok(object(value), label); assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), label); };
const bootstrap = new Set(["ping", "getInfo", "getControlState"]);
const methods = new Set([...bootstrap, "createTab", "getTabs", "attach", "executeCdp", "browserAction", "armPageWait", "collectPageWait", "cancelPageWait", "finalizeTabs"]);
const denied = /not part of browser session|OBU_AUXILIARY_/;
const succeeded = pair => assert.ok(!Object.hasOwn(pair.response.message, "error") && Object.hasOwn(pair.response.message, "result"), "Original RPC must succeed");
const rejected = (pair, pattern) => {
  const message = pair.response.message;
  assert.ok(!Object.hasOwn(message, "result") && object(message.error) && typeof message.error.message === "string", "Original RPC must be rejected");
  assert.match(message.error.message, pattern);
};
const before = (left, right, label) => assert.ok(left < right, label);

function locator(params) {
  assert.ok(Array.isArray(params.locator) && params.locator.length >= 1 && params.locator.length <= 2, "Exact original fixture locator");
  const steps = params.locator, frame = steps.length === 2;
  if (frame) assert.deepEqual(steps[0], { kind: "frame", selector: "#created-page-frame" }, "Original source frame");
  return { leaf: steps.at(-1), frame };
}
function click(params) {
  const { leaf, frame } = locator(params);
  const matches = (css, role, name) => leaf.kind === "css" && leaf.selector === css || leaf.kind === "role" && leaf.role === role && leaf.name === name;
  const kind = matches("#open-child", "link", "Open original child") ? "trigger" :
    matches("#add-frame", "button", "Add source frame") ? "add" : matches("#commit", "button", "Commit child receipt") ? "commit" : null;
  assert.ok(kind, "Original fixture click target");
  const args = params.args ?? {};
  assert.ok(object(args)); assert.deepEqual(args.modifiers ?? [], kind === "trigger" ? ["Control"] : []);
  assert.ok(args.button === undefined || args.button === "left"); assert.ok(args.clickCount === undefined || args.clickCount === 1);
  assert.ok(args.force !== true && args.trial !== true, "Original actual actionable click");
  return { kind, frame };
}

// This verifier consumes only the original parsed native-RPC records. It does
// not infer trusted input, an unowned child or durable storage from an RPC ACK;
// the native/source/adoption/server observers prove those separate properties.
export function assertCreatedPageUnownedWire({ snapshot, items }) {
  assert.ok(object(snapshot) && Array.isArray(items) && items.length === 6, "Two outcomes across three original layouts");
  assert.equal(snapshot.closed, true); assert.equal(snapshot.restored, true); assert.equal(snapshot.overflow, false);
  assert.deepEqual(snapshot.errors, []); assert.deepEqual(snapshot.pendingIds, []);
  assert.ok(Number.isSafeInteger(snapshot.maxRecords) && snapshot.maxRecords > 0 && snapshot.maxRecords <= 10000);
  assert.ok(Number.isSafeInteger(snapshot.maxBytes) && snapshot.maxBytes > 0 && snapshot.maxBytes <= 8 * 1024 * 1024);
  assert.ok(Array.isArray(snapshot.records) && snapshot.records.length <= snapshot.maxRecords);
  assert.equal(snapshot.bytes, snapshot.records.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row)), 0));
  assert.ok(snapshot.bytes <= snapshot.maxBytes);
  const sessions = new Map(), sources = new Map(), children = new Map();
  for (const item of items) {
    const value = originalScope(item);
    assert.ok(typeof value.session_id === "string" && value.session_id && typeof value.turn_id === "string" && value.turn_id);
    assert.ok(Number.isSafeInteger(value.control_epoch) && value.control_epoch > 0);
    assert.equal(item.freshScope?.session_id, value.session_id); assert.ok(typeof item.freshScope.turn_id === "string" && item.freshScope.turn_id);
    assert.ok(Number.isSafeInteger(item.freshScope.control_epoch) && item.freshScope.control_epoch > value.control_epoch);
    assert.ok(["root", "oopif", "dynamic-oopif"].includes(item.variant));
    assert.ok(["collect-finalize", "cancel-matched"].includes(item.outcome));
    assert.ok(Number.isSafeInteger(item.tabId) && item.tabId >= 0 && Number.isSafeInteger(item.childId) && item.childId >= 0 && item.tabId !== item.childId);
    assert.ok(typeof item.waiterId === "string" && item.waiterId);
    assert.ok(!sessions.has(value.session_id) && !sources.has(item.tabId) && !children.has(item.childId), "Distinct original owners, sources and children");
    sessions.set(value.session_id, item); sources.set(item.tabId, item); children.set(item.childId, item);
  }
  assert.ok([...sources.keys()].every(id => !children.has(id)));
  assert.deepEqual([...snapshot.sessions].sort(), [...sessions.keys()].sort());
  const pairs = new Map();
  for (const [index, row] of snapshot.records.entries()) {
    assert.equal(row.sequence, index + 1); assert.equal(row.generation, snapshot.generation); assert.ok(Number.isFinite(row.receivedAt));
    assert.ok(object(row.message) && row.message.jsonrpc === "2.0");
    const id = key(row.message.id);
    if (row.direction === "request") {
      assert.ok(!pairs.has(id), "Unique actual request ID"); assert.ok(methods.has(row.message.method), "Only original public workflow methods");
      assert.ok(object(row.message.params) && sessions.has(row.message.params.session_id), "Exact selected original session");
      pairs.set(id, { request: row });
    } else {
      assert.equal(row.direction, "response"); const pair = pairs.get(id);
      assert.ok(pair && !pair.response, "One original response for its exact request ID"); pair.response = row;
      assert.notEqual(Object.hasOwn(row.message, "result"), Object.hasOwn(row.message, "error"), "Exactly one native result or error");
    }
  }
  assert.ok([...pairs.values()].every(pair => pair.response), "Every actual request has its original ACK");
  const all = [...pairs.values()], checks = [], readyHandles = new Set();
  for (const item of items) {
    const bound = originalScope(item), mine = all.filter(pair => pair.request.message.params.session_id === bound.session_id);
    const calls = method => mine.filter(pair => pair.request.message.method === method);
    const final = one(calls("finalizeTabs"), "One original finalization"); succeeded(final);
    assert.deepEqual(final.request.message.params.keep, [], "Release all original task authority");
    assert.equal(final.response.message.result.endedTurnId, bound.turn_id);
    assert.equal(final.response.message.result.controlEpoch, item.freshScope.control_epoch, "Fresh epoch is the actual finalization ACK");
    for (const pair of mine) {
      const { method, params } = pair.request.message;
      if (!bootstrap.has(method)) {
        const fresh = pair.request.sequence > final.request.sequence;
        if (fresh) before(final.response.sequence, pair.request.sequence, "No successor request before finalization ACK");
        assert.deepEqual(scope(params), fresh ? scope(item.freshScope) : bound, "Exact original or explicitly refreshed control scope");
        if (fresh) assert.ok(["getTabs", "attach"].includes(method), "Only denied access and inventory after explicit new turn");
      }
      if (method !== "attach" && !(method === "collectPageWait" && item.outcome === "cancel-matched")) succeeded(pair);
    }
    const create = one(calls("createTab"), "One public background source creation");
    assert.equal(create.request.message.params.backgroundWindow, true); assert.equal(create.response.message.result.id, item.tabId);
    const arms = calls("armPageWait"), collects = calls("collectPageWait"), cancels = calls("cancelPageWait");
    assert.equal(arms.length, item.outcome === "collect-finalize" ? 1 : 2, "Exact original and explicit rearm count");
    const arm = arms[0], ready = arm.response.message.result;
    before(create.response.sequence, arm.request.sequence, "Create source before original ready");
    for (const pair of [...arms, ...collects, ...cancels]) assert.equal(pair.request.message.params.tabId, item.tabId, "Wait always addresses its original source");
    for (const pair of arms) {
      const ack = pair.response.message.result, timeout = pair.request.message.params.timeoutMs;
      exactKeys(ack, ["waiterId", "remainingMs"], "Exact ready ACK"); assert.ok(typeof ack.waiterId === "string" && ack.waiterId);
      assert.ok(!readyHandles.has(ack.waiterId), "Distinct original actual ready handles"); readyHandles.add(ack.waiterId);
      assert.ok(Number.isInteger(timeout) && timeout >= 1 && timeout <= 120000);
      assert.ok(Number.isFinite(ack.remainingMs) && ack.remainingMs > 0 && ack.remainingMs <= timeout, "Ready never replenishes the requested budget");
    }
    assert.equal(ready.waiterId, item.waiterId);
    const collect = one(collects, "One original collect attempt"); assert.equal(collect.request.message.params.waiterId, item.waiterId);
    for (const pair of cancels) exactKeys(pair.response.message.result, [], "Exact cleanup ACK");
    const actions = calls("browserAction"), sourceActions = actions.filter(pair => pair.request.message.params.tabId === item.tabId);
    const childActions = actions.filter(pair => pair.request.message.params.tabId === item.childId);
    assert.equal(actions.length, sourceActions.length + childActions.length, "No foreign or unrecognized browser action");
    for (const pair of actions) {
      const p = pair.request.message.params, shape = locator(p);
      assert.ok(["click", "fill", "textContent"].includes(p.action), "Only fixture locator operations");
      if (p.action === "textContent") {
        assert.equal(shape.leaf.kind, "css"); assert.ok(["#state", "#result"].includes(shape.leaf.selector));
        if (p.tabId === item.tabId) assert.equal(shape.leaf.selector, "#state"); else assert.equal(shape.frame, false);
      } else if (p.action === "fill") {
        assert.equal(p.tabId, item.childId); assert.equal(shape.frame, false); assert.equal(shape.leaf.kind, "label");
        assert.ok(["Source key", "Owner"].includes(shape.leaf.value));
        assert.equal(p.args?.value, shape.leaf.value === "Source key" ? item.key : item.owner, "Original child form value");
      }
    }
    const sourceClicks = sourceActions.filter(pair => pair.request.message.params.action === "click").map(pair => ({ ...pair, ...click(pair.request.message.params) }));
    const trigger = one(sourceClicks.filter(pair => pair.kind === "trigger"), "One original source Control-click");
    assert.equal(trigger.frame, item.variant !== "root");
    const adds = sourceClicks.filter(pair => pair.kind === "add"); assert.equal(adds.length, item.variant === "dynamic-oopif" ? 1 : 0);
    assert.equal(sourceClicks.length, 1 + adds.length, "No other original-source click");
    before(arm.response.sequence, trigger.request.sequence, "Ready ACK before trigger"); before(trigger.response.sequence, collect.request.sequence, "Original trigger ACK before collect attempt");
    for (const add of adds) { assert.equal(add.frame, false); before(arm.response.sequence, add.request.sequence, "Ready before future frame Add"); before(add.response.sequence, trigger.request.sequence, "Future frame Add before trigger"); }
    for (const pair of calls("executeCdp")) {
      const p = pair.request.message.params; exactKeys(p.target, ["tabId"], "Exact source CDP target"); assert.equal(p.target.tabId, item.tabId);
      before(pair.response.sequence, arm.request.sequence, "Source CDP setup ends before original arm");
      assert.ok(["Page.enable", "Page.navigate", "Page.getFrameTree", "Runtime.evaluate"].includes(p.method), "No raw input or scripting path");
      if (p.method === "Runtime.evaluate") assert.deepEqual(p.commandParams, { expression: "({ href: window.location.href, readyState: document.readyState })", returnByValue: true });
      else if (p.method === "Page.navigate") { exactKeys(p.commandParams, ["url"], "Exact source URL"); assert.equal(p.commandParams.url, item.sourceURL); }
      else exactKeys(p.commandParams, [], "Exact source readiness command");
    }
    const sourceReads = sourceActions.filter(pair => pair.request.message.params.action === "textContent" && pair.request.sequence < trigger.request.sequence && locator(pair.request.message.params).frame === (item.variant !== "root"));
    const prepared = sourceReads.at(-1); assert.ok(prepared, "Original source preparation read");
    before(arm.response.sequence, prepared.request.sequence, "Prepared after original ready"); before(prepared.response.sequence, trigger.request.sequence, "Original source prepared before trigger");
    const originalCancels = cancels.filter(pair => pair.request.message.params.waiterId === item.waiterId);
    if (item.outcome === "collect-finalize") {
      assert.equal(cancels.length, 1); assert.equal(originalCancels.length, 1);
      assert.deepEqual(collect.response.message.result, { tabId: item.childId });
      for (const pair of childActions) before(collect.response.sequence, pair.request.sequence, "Successful original collect before every child action");
      const commits = childActions.filter(pair => pair.request.message.params.action === "click"); const commit = one(commits, "One original child commit");
      assert.deepEqual(click(commit.request.message.params), { kind: "commit", frame: false });
      const fills = childActions.filter(pair => pair.request.message.params.action === "fill"); assert.equal(fills.length, 2);
      assert.deepEqual(fills.map(pair => locator(pair.request.message.params).leaf.value).sort(), ["Owner", "Source key"]);
      for (const fill of fills) before(fill.response.sequence, commit.request.sequence, "Original field ACK before child commit");
      before(commit.response.sequence, originalCancels[0].request.sequence, "Delivered cancel follows business commit ACK");
      before(originalCancels[0].response.sequence, final.request.sequence, "Delivered no-op cancel before finalization");
    } else {
      assert.equal(childActions.length, 0, "No child action before or after matched cancellation");
      assert.equal(cancels.length, 3); assert.equal(originalCancels.length, 2, "Original cancel and explicit idempotent cancel");
      rejected(collect, /OBU_PAGE_WAIT_EXPIRED/);
      before(trigger.response.sequence, originalCancels[0].request.sequence, "Original trigger ACK before matched cancellation");
      before(originalCancels[0].response.sequence, collect.request.sequence, "Cancel ACK before expired collect attempt");
      before(originalCancels[0].response.sequence, originalCancels[1].request.sequence, "Idempotent cancel follows original cancel ACK");
      assert.ok(typeof item.rearmedWaiterId === "string" && item.rearmedWaiterId !== item.waiterId);
      assert.equal(arms[1].response.message.result.waiterId, item.rearmedWaiterId);
      assert.ok(arms[1].request.message.params.timeoutMs <= arm.request.message.params.timeoutMs, "Rearm does not exceed the original workflow budget");
      before(originalCancels[1].response.sequence, arms[1].request.sequence, "Rearm after original reverse-lock release");
      const alive = sourceActions.filter(pair => pair.request.message.params.action === "textContent" && !locator(pair.request.message.params).frame && pair.request.sequence > originalCancels[0].response.sequence && pair.response.sequence < arms[1].request.sequence);
      assert.ok(alive.length > 0, "Original source remains usable after cancellation");
      const rearmCancel = one(cancels.filter(pair => pair.request.message.params.waiterId === item.rearmedWaiterId), "Cancel exact newly armed handle");
      before(arms[1].response.sequence, rearmCancel.request.sequence, "New ready ACK before new cancel");
      before(rearmCancel.response.sequence, final.request.sequence, "New cancel ACK before finalization");
    }
    const attaches = calls("attach"), foreign = [], ownDenied = [], freshDenied = [];
    for (const pair of attaches) {
      const id = pair.request.message.params.tabId;
      if (id === item.tabId) { succeeded(pair); before(pair.response.sequence, arm.request.sequence, "Source attach before original arm"); }
      else {
        const child = children.get(id); assert.ok(child, "Denied attach addresses one of the exact native children"); rejected(pair, denied);
        if (id !== item.childId) {
          assert.equal(child.variant, item.variant); assert.notEqual(originalScope(child).session_id, bound.session_id);
          before(pair.response.sequence, collect.request.sequence, "Foreign denial checked before original collect attempt"); foreign.push(pair);
        } else if (pair.request.sequence > final.response.sequence) freshDenied.push(pair);
        else { assert.equal(item.outcome, "cancel-matched"); before(originalCancels[0].response.sequence, pair.request.sequence, "Own denied attach after cancel ACK"); ownDenied.push(pair); }
      }
    }
    assert.equal(foreign.length, 1, "One competing-owner denied attach"); assert.equal(freshDenied.length, 1, "One fresh-scope denied attach after finalize");
    assert.equal(ownDenied.length, item.outcome === "cancel-matched" ? 1 : 0);
    const inventory = calls("getTabs");
    assert.equal(inventory.filter(pair => pair.request.sequence > final.response.sequence).length, 1, "One fresh public inventory after finalization");
    assert.equal(inventory.filter(pair => pair.request.sequence < final.request.sequence).length, item.outcome === "cancel-matched" ? 1 : 0, "Exact public inventory after matched cancellation");
    for (const pair of inventory) {
      const value = pair.response.message.result; assert.ok(Array.isArray(value));
      if (pair.request.sequence > final.response.sequence) assert.deepEqual(value, [], "Finalized session has no automatically inherited pages");
      else { assert.equal(item.outcome, "cancel-matched"); before(originalCancels[0].response.sequence, pair.request.sequence, "Cancelled public inventory after cleanup ACK"); assert.ok(value.some(tab => tab.id === item.tabId)); assert.ok(!value.some(tab => tab.id === item.childId)); }
    }
    checks.push({ sessionId: bound.session_id, tabId: item.tabId, childId: item.childId, variant: item.variant, outcome: item.outcome,
      readySequence: arm.response.sequence, firstInputSequence: Math.min(...sourceClicks.map(pair => pair.request.sequence)),
      preparedSequence: prepared.response.sequence, triggerSequence: trigger.request.sequence, collectSequence: collect.request.sequence,
      finalizeSequence: final.request.sequence, finalizeAckSequence: final.response.sequence });
  }
  const groups = ["root", "oopif", "dynamic-oopif"].map(variant => {
    const members = checks.filter(item => item.variant === variant); assert.equal(members.length, 2);
    assert.deepEqual(members.map(item => item.outcome).sort(), ["cancel-matched", "collect-finalize"]);
    const value = { variant, lastReady: Math.max(...members.map(item => item.readySequence)), firstInput: Math.min(...members.map(item => item.firstInputSequence)),
      lastPrepared: Math.max(...members.map(item => item.preparedSequence)), firstTrigger: Math.min(...members.map(item => item.triggerSequence)) };
    before(value.lastReady, value.firstInput, "Both original ready ACKs before the group's first input");
    before(value.lastPrepared, value.firstTrigger, "Both original source preparation ACKs before the group's first trigger"); return value;
  });
  return { requests: pairs.size, responses: pairs.size, items: checks, groups,
    boundary: "Original parsed native RPC identities, scopes, outcomes and order; native provenance, unowned first admission, trusted input, storage and business receipts require separate evidence." };
}
