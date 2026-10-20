import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import vm from "node:vm";
import { listenFixture } from "./fixture-listener.mjs";
import { humanCopyCases, createManagedHumanCopyFixture, assertManagedHumanCopyCase, installManagedCopyReadbackObserver } from "./managed-human-copy-fixture.mjs";
import { createManagedHumanFixture } from "./managed-human-check-fixture.mjs";

test("human-copy composed handoff server serves the real donor and neutral textarea body", async () => {
  const copy = createManagedHumanCopyFixture(), handoff = createManagedHumanFixture({ scenario: "handoff" });
  const server = createServer((request, response) => {
    if (!copy.handle(request, response) && !handoff.handle(request, response)) { request.resume(); response.writeHead(404).end("NOT_FOUND"); }
  });
  await listenFixture(server);
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/human-clipboard-donor`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/html/);
    const body = await response.text();
    assert.match(body, /<textarea id="donor"><\/textarea>/);
    assert.match(body, /<textarea id="neutral"><\/textarea>/);
    assert.doesNotMatch(body, /<script>|navigator\.clipboard/);
    assert.equal(copy.stats().requests[0].status, 200);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

function proof(definition) {
  const scope = { leaseId: "original", generation: 1 }, key = definition.operation === "cut" ? "KeyX" : "KeyC";
  const keys = [["ControlLeft", "down"], [key, "down"], [key, "up"], ["ControlLeft", "up"]];
  const commands = keys.map(([code, action], i) => ({ id: i + 1, connection: 1, operation: "humanInput", ...scope, sequence: i + 1,
    input: { type: "key", code, action, ...(i === 1 ? { clipboardTransfer: definition.operation } : {}) } }));
  const replies = commands.map((request, i) => ({ id: request.id, connection: 1, type: "response", result: { inputReceipt: {
    ...scope, sequence: request.sequence, acknowledged: true, ...(i === 1 ? { clipboardTransfer: {
      operation: definition.operation, status: definition.status, ...(definition.status === "ready" ? { text: definition.text } : {})
    } } : {})
  } } }));
  const original = { documentId: "document", state: { documentToken: "token" } };
  const before = { ...original, state: { ...original.state, events: [], controls: {
    [definition.target]: { value: definition.value, selectionStart: 0, selectionEnd: 0 }
  } } };
  const events = keys.map(([code, action]) => ({ type: action === "down" ? "keydown" : "keyup", code, trusted: true }));
  events.splice(2, 0, { type: definition.operation, trusted: true, defaultPrevented: definition.target === "custom" });
  if (definition.operation === "cut") events.splice(3, 0, ...["beforeinput", "input"].map(type => ({ type, inputType: "deleteByCut", trusted: true })));
  const after = { ...original, state: { ...before.state, events, eventOverflow: false, heldKeys: [], heldButtons: [] } };
  const local = { value: definition.text, active: false, overflow: false, events: [
    { type: "paste", text: definition.text, trusted: true },
    { type: "beforeinput", inputType: "insertFromPaste", trusted: true },
    { type: "input", inputType: "insertFromPaste", trusted: true }
  ] };
  return { definition, original, before, after, commands, replies, scope, local };
}

test("copy fixture provides original default/cut/custom documents and passive local readback", async () => {
  const fixture = createManagedHumanCopyFixture();
  const server = createServer((request, response) => { if (!fixture.handle(request, response)) response.writeHead(404).end(); });
  await listenFixture(server); const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const html = await (await fetch(origin + "/human-copy")).text();
    assert.doesNotThrow(() => new vm.Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]));
    assert.match(html, /addEventListener\('copy'/); assert.match(html, /clipboardData\.setData/);
    const local = await (await fetch(origin + "/human-copy-local")).text();
    assert.match(local, /id="neutral"/); assert.doesNotMatch(local, /navigator\.clipboard|<script>/);
    assert.equal((await fetch(origin + "/human-copy", { method: "POST", body: "not permitted" })).status, 405);
    const stats = fixture.stats(); assert.equal(stats.overflow, false);
    assert.equal(stats.requests.length, 3); assert.ok(stats.requests[0].documentToken);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

for (const definition of humanCopyCases) test(`copy proof preserves exact original shortcut/receipt/document/readback: ${definition.id}`, () => {
  assert.doesNotThrow(() => assertManagedHumanCopyCase(proof(definition)));
});

test("copy proof rejects duplicate native shortcuts, stale or mismatched replies, stale local text and invented events", () => {
  for (const mutate of [
    value => value.commands.push(structuredClone(value.commands[1])),
    value => value.replies[1].result.inputReceipt.sequence++,
    value => value.replies[1].result.inputReceipt.clipboardTransfer.text = "selection fallback",
    value => value.local.value = "old clipboard",
    value => value.local.events[0].trusted = false,
    value => value.local.events.push(structuredClone(value.local.events[0])),
    value => value.after.documentId = "replacement",
    value => value.after.state.documentToken = "replacement",
    value => value.after.state.events.push({ type: "input", inputType: "insertText", trusted: true }),
    value => value.after.state.events.push({ type: "keydown", code: "Unrelated", trusted: true }),
    value => value.after.state.heldKeys.push("ControlLeft")
  ]) { const value = proof(humanCopyCases[0]); mutate(value); assert.throws(() => assertManagedHumanCopyCase(value)); }
  const unchanged = proof(humanCopyCases[2]); unchanged.replies[1].result.inputReceipt.clipboardTransfer.text = "stale exported";
  assert.throws(() => assertManagedHumanCopyCase(unchanged));
  const custom = proof(humanCopyCases[3]); custom.after.state.events.find(row => row.type === "copy").defaultPrevented = false;
  assert.throws(() => assertManagedHumanCopyCase(custom));
});

test("local readback observer is bounded, passive, removable and cannot operate the clipboard", () => {
  const listeners = new Map(), field = { id: "neutral", value: "known" };
  const context = vm.createContext({ structuredClone, document: {
    addEventListener(type, handler, options) { assert.equal(options.passive, true); listeners.set(type, handler); },
    removeEventListener(type, handler) { assert.equal(listeners.get(type), handler); listeners.delete(type); },
    getElementById() { return field; }
  } });
  vm.runInContext(`(${installManagedCopyReadbackObserver.toString()})()`, context);
  listeners.get("paste")({ type: "paste", target: field, isTrusted: true, clipboardData: { getData(type) { assert.equal(type, "text/plain"); return "known"; } } });
  const result = JSON.parse(JSON.stringify(context.__managedCopyReadback.stop()));
  assert.equal(result.active, false); assert.equal(result.overflow, false); assert.equal(result.events.length, 1); assert.equal(listeners.size, 0);
  assert.equal(result.events[0].trusted, true); assert.equal(result.events[0].text, "known");
});
