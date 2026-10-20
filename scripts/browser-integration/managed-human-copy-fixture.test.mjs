import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import vm from "node:vm";
import { listenFixture } from "./fixture-listener.mjs";
import { humanCopyCases, humanCutText, createManagedHumanCopyFixture, assertManagedHumanCopyCase, installManagedCopyReadbackObserver } from "./managed-human-copy-fixture.mjs";
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
  const initialValue = definition.id === "cut-original" ? humanCutText : definition.value;
  const original = { documentId: "document", state: { documentToken: "token", controls: {
    [definition.target]: { value: initialValue, selectionStart: 0, selectionEnd: 0 }
  } } };
  const before = { ...original, state: { ...original.state, events: [], controls: {
    [definition.target]: { value: initialValue, selectionStart: 0, selectionEnd: definition.selected ? initialValue.length : 0 }
  } } };
  const events = keys.map(([code, action]) => ({ type: action === "down" ? "keydown" : "keyup", code, trusted: true }));
  events.splice(2, 0, { type: definition.operation, trusted: true, defaultPrevented: definition.defaultPrevented });
  events.splice(3, 0, ...definition.editEvents.map(value => {
    const [type, inputType] = value.split(":"); return { type, inputType, trusted: true };
  }));
  const after = { ...original, state: { ...before.state, events, eventOverflow: false, heldKeys: [], heldButtons: [], controls: {
    [definition.target]: { value: definition.value, selectionStart: 0, selectionEnd: definition.selectionEnd }
  } } };
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
    const fields = new Map([...html.matchAll(/<textarea id="([^"]+)" autocomplete="off">([^<]*)<\/textarea>/g)].map(([, id, value]) => [
      id, { id, value, selectionStart: 0, selectionEnd: value.length, handlers: new Map(), addEventListener(type, listener) { this.handlers.set(type, listener); } }
    ]));
    assert.equal(fields.size, 6);
    fields.set("state", { textContent: "" });
    const observed = new Map();
    const context = vm.createContext({ document: {
      getElementById(id) { assert.ok(fields.has(id)); return fields.get(id); },
      addEventListener(type, listener, options) { assert.equal(options.passive, true); observed.set(type, listener); }
    } });
    vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], context);
    for (const [target, type] of [["cancel-copy", "copy"], ["cancel-cut", "cut"]]) {
      const field = fields.get(target), value = field.value; let prevented = 0;
      const event = { type, target: field, isTrusted: true, defaultPrevented: false,
        get clipboardData() { throw Error("Cancellation must not read or modify clipboard data"); },
        preventDefault() { prevented++; this.defaultPrevented = true; }
      };
      field.handlers.get(type)(event);
      observed.get(type)(event);
      assert.equal(prevented, 1); assert.equal(field.value, value);
      assert.deepEqual([field.selectionStart, field.selectionEnd], [0, value.length]);
      const recorded = JSON.parse(fields.get("state").textContent).events.at(-1);
      assert.deepEqual({ type: recorded.type, target: recorded.target, defaultPrevented: recorded.defaultPrevented },
        { type, target, defaultPrevented: true });
    }
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

test("two page cancellations follow the original five cases and preserve the last confirmed cut text", () => {
  assert.deepEqual(humanCopyCases.map(row => row.id), [
    "copy-original", "copy-same-again", "copy-no-selection", "copy-custom-handler", "cut-original", "copy-cancelled", "cut-cancelled"
  ]);
  for (const definition of humanCopyCases.slice(5)) {
    assert.equal(definition.status, "unchanged"); assert.equal(definition.text, humanCutText);
    assert.equal(definition.defaultPrevented, true); assert.equal(definition.selected, true);
    assert.deepEqual(definition.editEvents, []); assert.ok(definition.value.length > 0);
    assert.equal(definition.selectionEnd, definition.value.length);
  }
});

test("cancelled copy and cut require the original cancelled event and unchanged selected text/local contents", () => {
  for (const definition of humanCopyCases.slice(5)) {
    for (const mutate of [
      value => { value.after.state.events = value.after.state.events.filter(event => event.type !== definition.operation); },
      value => { value.after.state.events.find(event => event.type === definition.operation).defaultPrevented = false; },
      value => value.after.state.events.push({ type: "beforeinput", inputType: "deleteByCut", trusted: true }),
      value => value.after.state.events.push({ type: "input", inputType: "deleteByCut", trusted: true }),
      value => { value.after.state.controls[definition.target].value = ""; },
      value => { value.after.state.controls[definition.target].selectionEnd = 0; },
      value => { value.before.state.controls[definition.target].selectionEnd = 0; },
      value => { value.replies[1].result.inputReceipt.clipboardTransfer.text = definition.value; },
      value => { value.local.value = definition.value; value.local.events[0].text = definition.value; },
      value => { value.local.value = ""; value.local.events[0].text = ""; }
    ]) { const value = proof(definition); mutate(value); assert.throws(() => assertManagedHumanCopyCase(value)); }
  }
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
