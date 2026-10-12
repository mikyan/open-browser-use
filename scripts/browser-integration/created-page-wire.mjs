import assert from "node:assert/strict";

// Serialized into the worker. This observes parsed Native RPC JSON, not TCP or
// native-message framing. The generation is supplied by the runner; its separate
// host/port identity observations must prove that this label stayed current.
export function installCreatedPageWireObserver(chrome, target, options) {
  const { sessions, generation, maxRecords = 10000, maxBytes = 8 * 1024 * 1024 } = options ?? {};
  if (!chrome?.runtime || !target || target.__createdPageWire || !Array.isArray(sessions) || sessions.length < 1 || sessions.length > 128 ||
      sessions.some(value => typeof value !== "string" || !value) || new Set(sessions).size !== sessions.length ||
      !((typeof generation === "string" && generation) || (Number.isSafeInteger(generation) && generation >= 1)) ||
      !Number.isInteger(maxRecords) || maxRecords < 1 || maxRecords > 10000 || !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 8 * 1024 * 1024) {
    throw Error("Invalid created-page wire observer installation");
  }
  const name = "__integrationNativeRPCObserver", previousDescriptor = Object.getOwnPropertyDescriptor(target, name), previous = target[name];
  if (previous !== undefined && typeof previous !== "function") throw Error("Invalid previous Native RPC observer");
  const selected = new Set(sessions), requests = new Map(), records = [], errors = [], encoder = new TextEncoder();
  let bytes = 0, overflow = false, closed = false, restored = false;
  const error = value => { if (errors.length < 16) errors.push(String(value?.message ?? value).slice(0, 1024)); };
  const rpcKey = id => typeof id === "string" || (typeof id === "number" && Number.isFinite(id)) ? JSON.stringify([typeof id, id]) : null;
  const record = (direction, message) => {
    if (overflow) return false;
    const entry = { sequence: records.length + 1, receivedAt: Date.now(), direction, generation, message: JSON.parse(JSON.stringify(message)) };
    const size = encoder.encode(JSON.stringify(entry)).byteLength;
    if (records.length >= maxRecords || bytes + size > maxBytes) { overflow = true; return false; }
    records.push(entry); bytes += size; return true;
  };
  const observe = (direction, message) => {
    if (closed || overflow || message === null || typeof message !== "object") return;
    const key = rpcKey(message.id);
    if (direction === "request") {
      const relevant = selected.has(message.params?.session_id);
      if (key !== null && requests.has(key)) {
        // Do not misattribute a foreign response if another session reuses an ID.
        requests.get(key).blocked = true; error("Native RPC request ID reused");
        if (relevant) record(direction, message);
        return;
      }
      if (!relevant) return;
      if (key === null) { error("Selected Native RPC request has no valid ID"); record(direction, message); return; }
      if (record(direction, message)) requests.set(key, { id: message.id, replied: false, blocked: false });
    } else if (direction === "response" && key !== null) {
      const request = requests.get(key);
      if (!request || request.blocked) return;
      if (request.replied) error("Native RPC response ID repeated");
      if (record(direction, message)) request.replied = true;
    }
  };
  function hook(...args) {
    // Observation failures must not suppress the original request/response or
    // the previously installed observer. The verifier rejects incomplete data.
    try { observe(...args); } catch (failure) { error(failure); }
    try { previous?.apply(target, args); } catch (failure) { error(failure); }
  }
  const snapshot = () => JSON.parse(JSON.stringify({ generation, sessions: [...sessions], maxRecords, maxBytes, records, bytes, overflow, errors, closed, restored,
    pendingIds: [...requests.values()].filter(value => !value.replied || value.blocked).map(value => value.id) }));
  const api = {
    snapshot,
    stop() {
      if (!closed) {
        closed = true;
        try {
          if (target[name] !== hook) throw Error("Native RPC observer replaced before stop");
          if (previousDescriptor) Object.defineProperty(target, name, previousDescriptor);
          else delete target[name];
          restored = target[name] === previous;
          if (!restored) throw Error("Native RPC observer restoration failed");
        } catch (failure) { error(failure); }
      }
      return snapshot();
    },
  };
  Object.defineProperty(target, name, previousDescriptor && Object.hasOwn(previousDescriptor, "value")
    ? { ...previousDescriptor, value: hook } : { configurable: true, writable: true, enumerable: true, value: hook });
  target.__createdPageWire = api;
  return { installed: true, generation, sessions: [...sessions], maxRecords, maxBytes };
}

const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const rpcKey = id => { assert.ok(typeof id === "string" || (typeof id === "number" && Number.isFinite(id)), "Actual Native RPC ID"); return JSON.stringify([typeof id, id]); };
const exactKeys = (value, keys, label) => { assert.ok(object(value), label); assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), label); };
const bootstrap = new Set(["ping", "getInfo", "getControlState"]);
const forbidden = new Set(["claimUserTab", "beginTurn", "turnEnded", "finalize", "pause", "resume"]);
const allowedMethods = new Set([...bootstrap, "createTab", "getTabs", "attach", "executeCdp", "browserAction", "armPageWait", "collectPageWait", "cancelPageWait"]);

function clickKind(params) {
  assert.ok(Array.isArray(params.locator) && params.locator.length > 0, "Click must name its original locator");
  const steps = params.locator, leaf = steps.at(-1);
  const matches = (id, role, name) => leaf?.kind === "css" && leaf.selector === id || leaf?.kind === "role" && leaf.role === role && leaf.name === name;
  const kind = matches("#open-child", "link", "Open original child") ? "trigger" :
    matches("#add-frame", "button", "Add source frame") ? "add" : matches("#commit", "button", "Commit child receipt") ? "commit" : null;
  assert.ok(kind, "Unexpected business click locator");
  // A CSS leaf and a role leaf are equivalent for these unique fixture nodes.
  // Other locator transformations could change their identity and are rejected.
  const prefix = steps.slice(0, -1);
  assert.ok(prefix.length <= 1 && prefix.every(step => step.kind === "frame" && step.selector === "#created-page-frame"), "Original source frame locator");
  const args = params.args ?? {};
  assert.ok(object(args), "Click arguments");
  assert.deepEqual(args.modifiers ?? [], kind === "trigger" ? ["Control"] : [], "Original click modifiers");
  assert.ok(args.button === undefined || args.button === "left", "Original left click");
  assert.ok(args.clickCount === undefined || args.clickCount === 1, "One original click");
  assert.ok(args.trial !== true && args.force !== true, "Actual actionable business click");
  return { kind, frame: prefix.length === 1 };
}

// Complements the native source/document and trusted DOM/server proofs. RPC
// observations alone do not prove a trusted click or atomic document binding.
export function assertCreatedPageWire({ snapshot, items }) {
  assert.ok(object(snapshot) && Array.isArray(items) && items.length > 0, "Created-page wire evidence");
  assert.equal(snapshot.closed, true, "Wire observer actually stopped");
  assert.equal(snapshot.restored, true, "Prior wire observer restored");
  assert.equal(snapshot.overflow, false, "Complete bounded wire capture");
  assert.deepEqual(snapshot.errors, [], "Wire observer errors");
  assert.deepEqual(snapshot.pendingIds, [], "All observed actual RPCs acknowledged before stop");
  assert.ok(Number.isInteger(snapshot.maxRecords) && snapshot.maxRecords > 0 && snapshot.maxRecords <= 10000);
  assert.ok(Number.isInteger(snapshot.maxBytes) && snapshot.maxBytes > 0 && snapshot.maxBytes <= 8 * 1024 * 1024);
  assert.ok(Array.isArray(snapshot.records) && snapshot.records.length <= snapshot.maxRecords);
  assert.equal(snapshot.bytes, snapshot.records.reduce((size, row) => size + Buffer.byteLength(JSON.stringify(row)), 0), "Complete serialized JSON byte accounting");
  assert.ok(snapshot.bytes <= snapshot.maxBytes);
  const sessions = new Map(), sources = new Map(), children = new Map();
  for (const item of items) {
    assert.ok(typeof item.sessionId === "string" && item.sessionId && typeof item.turnId === "string" && item.turnId);
    assert.ok(Number.isSafeInteger(item.controlEpoch) && item.controlEpoch > 0);
    assert.ok(Number.isSafeInteger(item.tabId) && item.tabId >= 0 && Number.isSafeInteger(item.childId) && item.childId >= 0 && item.childId !== item.tabId);
    assert.ok(["root", "oopif", "dynamic-oopif"].includes(item.variant));
    const scope = { session_id: item.sessionId, turn_id: item.turnId, control_epoch: item.controlEpoch };
    if (sessions.has(item.sessionId)) assert.deepEqual(scope, sessions.get(item.sessionId), "Original protected scope across variants");
    else sessions.set(item.sessionId, scope);
    assert.ok(!sources.has(item.tabId) && !children.has(item.childId), "Unique source and child identities");
    sources.set(item.tabId, item); children.set(item.childId, item);
  }
  assert.ok([...sources.keys()].every(id => !children.has(id)), "Child is not an existing source");
  assert.deepEqual([...snapshot.sessions].sort(), [...sessions.keys()].sort(), "Exact selected sessions");
  const requests = new Map(), pairs = [];
  for (const row of snapshot.records) {
    assert.equal(row.sequence, requests.size + pairs.length + 1, "Contiguous captured RPC sequence");
    assert.equal(row.generation, snapshot.generation, "Original captured host generation label");
    const message = row.message;
    assert.ok(object(message) && message.jsonrpc === "2.0", "Original JSON-RPC envelope");
    const key = rpcKey(message.id);
    if (row.direction === "request") {
      assert.ok(!requests.has(key), "Unique actual Native RPC request ID");
      assert.ok(typeof message.method === "string" && object(message.params), "Actual request method and parameters");
      const params = message.params, scope = sessions.get(params.session_id);
      assert.ok(scope, "Captured request belongs to selected original session");
      assert.ok(!forbidden.has(message.method), "No manual claim, new turn or control transition inside the wait workflow");
      assert.ok(allowedMethods.has(message.method), "Only the observed workflow's setup, reads, actions and page waits");
      if (!bootstrap.has(message.method)) assert.deepEqual({ session_id: params.session_id, turn_id: params.turn_id, control_epoch: params.control_epoch }, scope, "Original protected request scope");
      assert.ok(!(message.method === "executeCdp" && /^Input\./.test(params.method)) && message.method !== "moveMouse", "No additional raw input path");
      requests.set(key, { request: row, response: null });
    } else {
      assert.equal(row.direction, "response", "Known Native RPC direction");
      const pair = requests.get(key); assert.ok(pair && !pair.response, "Exactly one response to its original request");
      assert.ok(!Object.hasOwn(message, "error") && Object.hasOwn(message, "result"), "Successful original Native RPC acknowledgement");
      pair.response = row; pairs.push(pair);
    }
  }
  assert.equal(requests.size, pairs.length, "No missing actual RPC acknowledgement");
  const all = [...requests.values()], waitMethods = new Set(["armPageWait", "collectPageWait", "cancelPageWait"]);
  for (const { request } of all) {
    const { method, params } = request.message;
    if (waitMethods.has(method)) assert.equal(sources.get(params.tabId)?.sessionId, params.session_id, "Wait belongs to an exact original source");
    if (method === "browserAction") {
      assert.equal((sources.get(params.tabId) ?? children.get(params.tabId))?.sessionId, params.session_id, "Action belongs to its original source or collected child");
      assert.ok(["click", "fill", "textContent"].includes(params.action), "No other browser input or scripting action");
      if (params.action === "fill") {
        assert.ok(children.has(params.tabId), "Only fill the collected child's original form");
        assert.ok(params.locator?.length === 1 && params.locator[0].kind === "label" && ["Source key", "Owner"].includes(params.locator[0].value), "Original child form field");
      }
    }
    if (method === "executeCdp" || method === "attach") {
      const tabId = method === "attach" ? params.tabId : params.target?.tabId;
      assert.equal(sources.get(tabId)?.sessionId, params.session_id, "Only original parent source CDP preparation");
      if (method === "executeCdp") {
        exactKeys(params.target, ["tabId"], "Exact original parent CDP target");
        const command = params.commandParams;
        assert.ok(["Page.enable", "Page.navigate", "Page.getFrameTree", "Runtime.evaluate"].includes(params.method), "Only parent navigation and document readiness CDP");
        if (params.method === "Runtime.evaluate") assert.deepEqual(command, { expression: "({ href: window.location.href, readyState: document.readyState })", returnByValue: true }, "Exact read-only navigation state expression");
        else if (params.method === "Page.navigate") { exactKeys(command, ["url"], "Parent navigation URL only"); assert.ok(typeof command.url === "string" && command.url); }
        else exactKeys(command, [], "Readiness CDP takes no extra parameters");
      }
    }
  }
  const clicks = all.filter(pair => pair.request.message.method === "browserAction" && pair.request.message.params.action === "click")
    .map(pair => ({ ...pair, ...clickKind(pair.request.message.params) }));
  const checks = [];
  for (const item of items) {
    const forSource = method => all.filter(pair => pair.request.message.method === method && pair.request.message.params.tabId === item.tabId);
    const one = (values, label) => { assert.equal(values.length, 1, label); return values[0]; };
    const arm = one(forSource("armPageWait"), "One original arm per source"), collect = one(forSource("collectPageWait"), "One original collect per source"), cancel = one(forSource("cancelPageWait"), "One original cancel cleanup per source");
    const ready = arm.response.message.result;
    exactKeys(ready, ["waiterId", "remainingMs"], "Exact ready acknowledgement");
    assert.ok(typeof ready.waiterId === "string" && ready.waiterId);
    assert.ok(Number.isFinite(arm.request.message.params.timeoutMs) && arm.request.message.params.timeoutMs >= 1 && arm.request.message.params.timeoutMs <= 120000);
    assert.ok(Number.isFinite(ready.remainingMs) && ready.remainingMs > 0 && ready.remainingMs <= arm.request.message.params.timeoutMs, "Ready preserves original wait budget");
    assert.equal(collect.request.message.params.waiterId, ready.waiterId, "Original collected waiter handle");
    assert.equal(cancel.request.message.params.waiterId, ready.waiterId, "Original cancelled waiter handle");
    assert.deepEqual(collect.response.message.result, { tabId: item.childId }, "Exact original child acknowledgement");
    exactKeys(cancel.response.message.result, [], "Exact waiter cleanup acknowledgement");
    const sourceClicks = clicks.filter(pair => pair.request.message.params.tabId === item.tabId);
    const trigger = one(sourceClicks.filter(pair => pair.kind === "trigger"), "One original source Control-click");
    assert.equal(trigger.frame, item.variant !== "root", "Original trigger frame layout");
    assert.equal(sourceClicks.filter(pair => pair.kind === "add").length, item.variant === "dynamic-oopif" ? 1 : 0, "One dynamic frame creation only where required");
    assert.ok(sourceClicks.every(pair => pair.kind === "trigger" || pair.kind === "add"), "No source commit click");
    assert.ok(arm.response.sequence < trigger.request.sequence && trigger.response.sequence < collect.request.sequence, "Ready, original trigger ACK, then collect");
    for (const add of sourceClicks.filter(pair => pair.kind === "add")) {
      assert.equal(add.frame, false, "Frame creation is in source root");
      assert.ok(arm.response.sequence < add.request.sequence && add.response.sequence < trigger.request.sequence, "Create dynamic frame after ready and before trigger");
    }
    const childClicks = clicks.filter(pair => pair.request.message.params.tabId === item.childId);
    const commit = one(childClicks, "One original child business click");
    assert.equal(commit.kind, "commit"); assert.equal(commit.frame, false, "Commit on original child root");
    for (const pair of all.filter(pair => pair.request.message.method === "browserAction" && pair.request.message.params.tabId === item.childId)) assert.ok(collect.response.sequence < pair.request.sequence, "Original child ACK precedes every child action");
    assert.ok(commit.response.sequence < cancel.request.sequence, "Cleanup after original child business ACK");
    for (const pair of all.filter(pair => pair.request.message.method === "attach" && pair.request.message.params.tabId === item.tabId || pair.request.message.method === "executeCdp" && pair.request.message.params.target?.tabId === item.tabId)) {
      assert.ok(pair.response.sequence < arm.request.sequence, "Parent CDP preparation must finish before original arm");
    }
    const sourceReads = all.filter(pair => {
      const { method, params } = pair.request.message, steps = params.locator;
      return method === "browserAction" && params.tabId === item.tabId && params.action === "textContent" && pair.request.sequence < trigger.request.sequence &&
        Array.isArray(steps) && steps.at(-1)?.kind === "css" && steps.at(-1)?.selector === "#state" &&
        (item.variant === "root" ? steps.length === 1 : steps.length === 2 && steps[0].kind === "frame" && steps[0].selector === "#created-page-frame");
    });
    const sourceRead = sourceReads.at(-1);
    assert.ok(sourceRead && arm.response.sequence < sourceRead.request.sequence && sourceRead.response.sequence < trigger.request.sequence, "Last original source state read after ready and before trigger");
    checks.push({ sessionId: item.sessionId, tabId: item.tabId, childId: item.childId, variant: item.variant, waiterId: ready.waiterId,
      armSequence: arm.request.sequence, readySequence: arm.response.sequence, triggerSequence: trigger.request.sequence,
      firstInputSequence: Math.min(...sourceClicks.map(pair => pair.request.sequence)), sourcePreparedSequence: sourceRead.response.sequence,
      collectSequence: collect.request.sequence, childAcknowledgedSequence: collect.response.sequence, commitSequence: commit.request.sequence, cancelSequence: cancel.request.sequence, cleanupAcknowledgedSequence: cancel.response.sequence });
  }
  const groups = [...new Set(items.map(item => item.variant))].map(variant => {
    const group = checks.filter(item => item.variant === variant);
    const value = { variant, members: group.length, lastReadySequence: Math.max(...group.map(item => item.readySequence)), firstInputSequence: Math.min(...group.map(item => item.firstInputSequence)),
      lastPreparedSequence: Math.max(...group.map(item => item.sourcePreparedSequence)), firstTriggerSequence: Math.min(...group.map(item => item.triggerSequence)) };
    assert.ok(value.lastReadySequence < value.firstInputSequence, "Every original arm ACK precedes the group's first Add or trigger");
    assert.ok(value.lastPreparedSequence < value.firstTriggerSequence, "Every original source state ACK precedes the group's first trigger");
    return value;
  });
  return { generation: snapshot.generation, sessions: sessions.size, requests: requests.size, responses: pairs.length, items: checks, groups,
    boundary: "Parsed Native RPC JSON at the adapter hook. Generation continuity, native source/document identity, trusted DOM and original POST evidence are checked separately." };
}
