import assert from "node:assert/strict";
import { createHash } from "node:crypto";

export const humanKeyboardCases = Object.freeze([
  { id: "textarea-enter", kind: "textarea", key: "Enter", code: "Enter", shift: false, initial: "Textarea enter", inputType: "insertLineBreak" },
  { id: "textarea-shift-enter", kind: "textarea", key: "Shift+Enter", code: "Enter", shift: true, initial: "Textarea shift", inputType: "insertLineBreak" },
  { id: "textarea-numpad-enter", kind: "textarea", key: "NumpadEnter", code: "NumpadEnter", shift: false, initial: "Textarea numpad", inputType: "insertLineBreak" },
  { id: "editable-enter", kind: "contenteditable", key: "Enter", code: "Enter", shift: false, initial: "Editable paragraph", inputType: "insertParagraph" },
  { id: "editable-shift-enter", kind: "contenteditable", key: "Shift+Enter", code: "Enter", shift: true, initial: "Editable line", inputType: "insertLineBreak" },
  { id: "prevented-enter", kind: "prevented", key: "Enter", code: "Enter", shift: false, initial: "Prevented original" },
  { id: "submit-enter", kind: "submit", key: "Enter", code: "Enter", shift: false, initial: "Submit original once" }
].map(value => Object.freeze({ ...value, ...(value.kind === "textarea" ? { expectedValue: value.initial + "\n" } : {}) })));

export function assertManagedHumanKeyboardValues(controls, { complete = true } = {}) {
  assert.deepEqual(Object.keys(controls).sort(), humanKeyboardCases.map(row => row.id).sort());
  for (const spec of humanKeyboardCases) {
    const value = controls[spec.id]; assert.equal(value.kind, spec.kind);
    if (spec.kind === "contenteditable") {
      assert.equal(value.textContent, spec.initial, "Enter changes line structure without replacing original editable text");
      if (complete) { assert.notEqual(value.innerHTML, spec.initial); assert.ok(value.lineBreaks > 0); }
    } else assert.equal(value.value, complete && spec.kind === "textarea" ? spec.expectedValue : spec.initial);
  }
}

export function assertManagedHumanKeyboardCase({ case: spec, before, after, commands, replies, scope }) {
  assert.deepEqual(spec, humanKeyboardCases.find(value => value.id === spec.id));
  assert.ok(before.documentId); assert.equal(after.documentId, before.documentId);
  assert.equal(after.state.documentToken, before.state.documentToken); assert.equal(after.state.workflowId, before.state.workflowId);
  assert.equal(after.state.eventOverflow, false); assert.equal(before.activeElement, spec.id);
  assert.deepEqual(after.state.events.slice(0, before.state.events.length), before.state.events);
  const events = after.state.events.slice(before.state.events.length);
  for (const [index, row] of after.state.events.entries()) assert.equal(row.sequence, index + 1);
  for (const row of events) assert.equal(row.trusted, true);
  const keyed = events.filter(row => ["keydown", "keypress", "keyup"].includes(row.type) && row.key === "Enter");
  const downs = keyed.filter(row => row.type === "keydown"), ups = keyed.filter(row => row.type === "keyup"), presses = keyed.filter(row => row.type === "keypress");
  assert.equal(downs.length, 1); assert.equal(ups.length, 1);
  for (const row of keyed) { assert.equal(row.target, spec.id); assert.equal(row.trusted, true); assert.equal(row.code, spec.code); assert.equal(row.repeat, false); }
  assert.equal(downs[0].shiftKey, spec.shift); assert.ok(downs[0].sequence < ups[0].sequence);
  assert.deepEqual(after.state.heldKeys, []);
  const edits = events.filter(row => row.type === "beforeinput" || row.type === "input");
  const original = before.state.controls[spec.id], current = after.state.controls[spec.id];
  if (spec.kind === "prevented") {
    assert.equal(downs[0].defaultPrevented, true); assert.equal(presses.length, 0); assert.deepEqual(edits, []);
    assert.equal(current.value, original.value); assert.equal(after.state.submits, before.state.submits);
  } else {
    assert.equal(downs[0].defaultPrevented, false);
    assert.equal(presses.length, 1); assert.equal(presses[0].charCode, 13);
    assert.ok(downs[0].sequence < presses[0].sequence && presses[0].sequence < ups[0].sequence);
    if (spec.kind === "submit") {
      assert.equal(current.value, original.value); assert.equal(after.state.submits, before.state.submits + 1);
      const submits = events.filter(row => row.type === "submit"); assert.equal(submits.length, 1); assert.equal(submits[0].trusted, true);
      assert.equal(edits.some(row => row.type === "input"), false);
    } else {
      assert.equal(after.state.submits, before.state.submits);
      assert.equal(edits.filter(row => row.type === "beforeinput").length, 1); assert.equal(edits.filter(row => row.type === "input").length, 1);
      for (const row of edits) { assert.equal(row.target, spec.id); assert.equal(row.trusted, true); assert.equal(row.inputType, spec.inputType); assert.equal(row.isComposing, false); }
      assert.ok(presses[0].sequence < edits[0].sequence && edits[0].sequence < edits[1].sequence && edits[1].sequence < ups[0].sequence);
      if (spec.kind === "textarea") { assert.equal(original.value, spec.initial); assert.equal(current.value, spec.expectedValue); }
      else { assert.equal(original.innerHTML, spec.initial); assert.equal(current.textContent, spec.initial); assert.notEqual(current.innerHTML, original.innerHTML); assert.ok(current.lineBreaks > 0); }
    }
  }
  for (const other of humanKeyboardCases.filter(row => row.id !== spec.id)) {
    const left = before.state.controls[other.id], right = after.state.controls[other.id];
    assert.equal(right.value, left.value); assert.equal(right.innerHTML, left.innerHTML);
  }
  assert.equal(commands.length, spec.shift ? 4 : 2, "Only original key transitions may carry Enter; no extra text or retry");
  const expected = spec.shift ? [["ShiftLeft", "down"], [spec.code, "down"], [spec.code, "up"], ["ShiftLeft", "up"]] : [[spec.code, "down"], [spec.code, "up"]];
  const transitions = events.filter(row => row.type === "keydown" || row.type === "keyup");
  assert.deepEqual(transitions.map(row => [row.code, row.type === "keydown" ? "down" : "up"]), expected);
  for (const row of transitions) { assert.equal(row.target, spec.id); assert.equal(row.repeat, false); }
  for (const [index, row] of commands.entries()) {
    assert.equal(row.operation, "humanInput"); assert.equal(row.leaseId, scope.leaseId); assert.equal(row.generation, scope.generation);
    assert.equal(row.input.type, "key"); assert.deepEqual([row.input.code, row.input.action], expected[index]);
    if (index) assert.equal(row.sequence, commands[index - 1].sequence + 1);
    const matches = replies.filter(reply => reply.type === "response" && reply.id === row.id && reply.connection === row.connection);
    assert.equal(matches.length, 1); assert.equal(matches[0].error, undefined);
    assert.deepEqual(matches[0].result?.inputReceipt, { leaseId: row.leaseId, generation: row.generation, sequence: row.sequence, acknowledged: true });
  }
  return { caseId: spec.id, documentId: before.documentId, documentToken: before.state.documentToken,
    requestIds: commands.map(row => row.id), eventSequences: events.map(row => row.sequence), original, current };
}

export function assertManagedHumanKeyboardReceipt({ stats, original, after }) {
  const receipt = after.state.receipt;
  assert.equal(stats.overflow, false); assert.equal(stats.committed, true);
  const gets = stats.requests.filter(row => row.method === "GET" && row.path === "/human-keyboard-form"), posts = stats.requests.filter(row => row.method === "POST");
  assert.equal(gets.length, 1); assert.equal(posts.length, 1); assert.equal(gets[0].documentToken, original.state.documentToken);
  assert.equal(after.documentId, original.documentId); assert.equal(after.state.documentToken, original.state.documentToken);
  assert.equal(after.state.submits, 1); assert.equal(after.state.eventOverflow, false); assert.deepEqual(after.state.heldKeys, []);
  assertManagedHumanKeyboardValues(after.state.controls);
  const post = posts[0]; assert.equal(post.status, 200); assert.equal(post.once, true); assert.equal(post.body.truncated, false);
  const bytes = Buffer.from(post.body.base64, "base64"), body = JSON.parse(bytes);
  const sha = value => createHash("sha256").update(value).digest("hex");
  assert.equal(bytes.length, post.body.bytes); assert.equal(sha(bytes), post.body.sha256);
  assert.equal(body.documentToken, original.state.documentToken); assert.equal(body.workflowId, stats.workflowId); assert.equal(body.submits, 1);
  assertManagedHumanKeyboardValues(body.controls);
  assert.equal(receipt.controlsSHA256, sha(JSON.stringify(body.controls)));
  assert.deepEqual(receipt, post.publicReceipt); const response = Buffer.from(post.response.base64, "base64");
  assert.equal(response.length, post.response.bytes); assert.equal(sha(response), post.response.sha256); assert.deepEqual(JSON.parse(response), receipt);
  for (const hit of stats.requests) { assert.equal(hit.finished, true); assert.equal(hit.aborted, false); assert.deepEqual(hit.errors, []); }
  return { documentToken: original.state.documentToken, posts: 1, originalFormLoads: 1, post: post.body, response: post.response };
}

// Account for every original page event, including events arriving between
// per-case reads. Focus/caret positioning keys are not Enter gestures.
export function assertManagedHumanKeyboardLedger({ original, after, commands, replies, scope }) {
  assert.ok(original.documentId); assert.equal(after.documentId, original.documentId);
  assert.equal(after.state.documentToken, original.state.documentToken); assert.equal(after.state.workflowId, original.state.workflowId);
  assert.equal(after.state.eventOverflow, false); assert.equal(after.state.submits, 1);
  assert.deepEqual(after.state.heldKeys, []); assert.deepEqual(after.state.heldButtons, []);
  assertManagedHumanKeyboardValues(after.state.controls);
  const events = after.state.events;
  assert.deepEqual(events.slice(0, original.state.events.length), original.state.events);
  for (const [index, row] of events.entries()) assert.equal(row.sequence, index + 1);
  const enter = events.filter(row => ["keydown", "keypress", "keyup"].includes(row.type) && row.key === "Enter");
  assert.equal(enter.filter(row => row.type === "keydown").length, 7);
  assert.equal(enter.filter(row => row.type === "keyup").length, 7);
  assert.equal(enter.filter(row => row.type === "keypress").length, 6);
  const inputs = events.filter(row => row.type === "input"), beforeInputs = events.filter(row => row.type === "beforeinput");
  assert.equal(inputs.length, 5);
  const submits = events.filter(row => row.type === "submit"); assert.equal(submits.length, 1);
  assert.equal(submits[0].target, "submit-form"); assert.equal(submits[0].trusted, true); assert.equal(submits[0].defaultPrevented, true);
  const fieldIDs = new Set(humanKeyboardCases.map(row => row.id));
  for (const row of [...enter, ...inputs, ...beforeInputs]) { assert.ok(fieldIDs.has(row.target)); assert.equal(row.trusted, true); }
  let commandIndex = 0;
  for (const spec of humanKeyboardCases) {
    const rows = enter.filter(row => row.target === spec.id);
    assert.deepEqual(rows.map(row => row.type), spec.kind === "prevented" ? ["keydown", "keyup"] : ["keydown", "keypress", "keyup"]);
    for (const row of rows) { assert.equal(row.code, spec.code); assert.equal(row.repeat, false); assert.equal(row.shiftKey, spec.shift); }
    assert.equal(rows[0].defaultPrevented, spec.kind === "prevented");
    if (spec.kind !== "prevented") assert.equal(rows[1].charCode, 13);
    const edits = events.filter(row => row.target === spec.id && (row.type === "beforeinput" || row.type === "input"));
    if (spec.inputType) {
      assert.deepEqual(edits.map(row => row.type), ["beforeinput", "input"]);
      for (const row of edits) { assert.equal(row.inputType, spec.inputType); assert.equal(row.isComposing, false); }
      assert.ok(rows[1].sequence < edits[0].sequence && edits[1].sequence < rows.at(-1).sequence);
    } else if (spec.kind === "prevented") assert.deepEqual(edits, []);
    else {
      // The single-line native submit may produce a beforeinput, but never
      // changes its value. Preserve the real browser's optional event.
      assert.ok(edits.length <= 1); if (edits.length) { assert.equal(edits[0].type, "beforeinput"); assert.equal(edits[0].inputType, "insertLineBreak"); assert.equal(edits[0].isComposing, false); }
      assert.ok(rows[1].sequence < submits[0].sequence && submits[0].sequence < rows.at(-1).sequence);
    }
    const transitions = spec.shift ? [["ShiftLeft", "down"], [spec.code, "down"], [spec.code, "up"], ["ShiftLeft", "up"]] : [[spec.code, "down"], [spec.code, "up"]];
    for (let i = 0; i < transitions.length; i++, commandIndex++) {
      const row = commands[commandIndex]; assert.ok(row); assert.equal(row.operation, "humanInput");
      assert.equal(row.leaseId, scope.leaseId); assert.equal(row.generation, scope.generation); assert.equal(row.input.type, "key");
      assert.deepEqual([row.input.code, row.input.action], transitions[i]);
      assert.equal(row.input.key, row.input.code === "ShiftLeft" ? "Shift" : "Enter");
      assert.equal(row.input.windowsVirtualKeyCode, row.input.code === "ShiftLeft" ? 16 : 13);
      if (commandIndex) assert.ok(row.sequence > commands[commandIndex - 1].sequence);
      if (i) assert.equal(row.sequence, commands[commandIndex - 1].sequence + 1);
      const matches = replies.filter(reply => reply.type === "response" && reply.connection === row.connection && reply.id === row.id);
      assert.equal(matches.length, 1); assert.equal(matches[0].error, undefined);
      assert.deepEqual(matches[0].result?.inputReceipt, { leaseId: row.leaseId, generation: row.generation, sequence: row.sequence, acknowledged: true });
    }
  }
  assert.equal(commands.length, commandIndex); assert.equal(new Set(commands.map(row => `${row.connection}:${row.id}`)).size, commands.length);
  return { documentId: after.documentId, documentToken: after.state.documentToken, enterDown: 7, enterUp: 7, keypress: 6, inputs: 5, submits: 1,
    requestIds: commands.map(row => row.id), enterEventSequences: enter.map(row => row.sequence), inputEventSequences: inputs.map(row => row.sequence) };
}
