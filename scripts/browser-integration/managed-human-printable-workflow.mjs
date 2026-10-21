import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { managedPrintableCases } from "./managed-human-printable-fixture.mjs";
import { managedPrintableRepeatCases, printableLateRelease, assertManagedPrintableRepeat, assertManagedPrintableHeldEnd } from "./managed-human-printable-repeat.mjs";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const emitter = documents => documents.find(value => value.controls !== null);
export const printableExpectedControls = Object.freeze({ checkbox: true, buttonClicks: 1, grid: "7", blocked: "seed", lower: "a", upper: "A", symbol: "!" });

export function installManagedPrintableObserver() {
  const events = []; let overflow = false;
  for (const type of ["keydown", "keypress", "keyup", "beforeinput", "input", "compositionstart", "compositionend"]) {
    document.addEventListener(type, event => {
      if (event.target?.id !== "human-input") return;
      if (events.length >= 512) { overflow = true; return; }
      const sinkValue = event.target.value;
      if (typeof sinkValue !== "string" || sinkValue.length > 256) { overflow = true; return; }
      events.push({ sequence: events.length + 1, at: Date.now(), type, trusted: event.isTrusted, key: event.key ?? null,
        code: event.code ?? null, repeat: event.repeat ?? false, isComposing: event.isComposing ?? false,
        ctrlKey: event.ctrlKey ?? false, altKey: event.altKey ?? false, metaKey: event.metaKey ?? false,
        shiftKey: event.shiftKey ?? false, inputType: event.inputType ?? null, data: event.data ?? null,
        defaultPrevented: event.defaultPrevented, target: event.target.id, activeElement: document.activeElement?.id ?? "",
        sinkDisabled: event.target.disabled, sinkValue });
    }, { passive: true });
  }
  Object.defineProperty(globalThis, "__managedPrintableObservation", { value: { snapshot: () => ({ events: structuredClone(events), overflow,
    activeElement: document.activeElement?.id ?? "", sink: { value: document.querySelector("#human-input")?.value ?? null,
      disabled: document.querySelector("#human-input")?.disabled ?? null } }) } });
}

export function assertManagedPrintableLocalSequence(viewer, expected) {
  assert.equal(viewer.overflow, false); assert.equal(viewer.before.activeElement, "human-input"); assert.equal(viewer.after.activeElement, "human-input");
  assert.equal(viewer.before.sink.disabled, false); assert.equal(viewer.after.sink.disabled, false);
  for (const row of viewer.events) {
    assert.equal(row.target, "human-input"); assert.equal(row.activeElement, "human-input"); assert.equal(row.trusted, true);
    assert.equal(row.sinkDisabled, false); assert.equal(typeof row.sinkValue, "string");
  }
  const downs = viewer.events.filter(value => value.type === "keydown" && value.code !== "ShiftLeft");
  const beforeInputs = viewer.events.filter(value => value.type === "beforeinput");
  assert.deepEqual(downs.map(value => value.key), expected);
  assert.deepEqual(beforeInputs.map(value => value.data), expected);
  assert.ok(beforeInputs.every(value => value.inputType === "insertText" && value.isComposing === false));
  for (let i = 0; i < downs.length; i++) {
    assert.ok(downs[i].sequence < beforeInputs[i].sequence, "The original local keydown must precede its native beforeinput");
    const next = downs[i + 1]; if (next) assert.ok(beforeInputs[i].sequence < next.sequence);
  }
  const edits = viewer.events.filter(value => value.type === "input");
  assert.deepEqual(edits, [], "The production sink prevents local insertion after confirming the original beforeinput");
  assert.equal(viewer.after.sink.value, "");
  return { verified: true, originalDowns: downs.length, confirmedBeforeInputs: beforeInputs.length };
}

export function assertManagedPrintableCase(row) {
  const spec = managedPrintableCases.find(value => value.id === row.caseId); assert.ok(spec);
  const before = emitter(row.before), after = emitter(row.after); assert.ok(before && after);
  assert.equal(after.documentId, before.documentId); assert.equal(after.url, before.url);
  assert.equal(after.state.documentToken, before.state.documentToken); assert.equal(after.state.workflowId, before.state.workflowId);
  assert.equal(before.activeElement, spec.id); assert.equal(after.state.overflow, false);
  assert.deepEqual(after.state.events.slice(0, before.state.events.length), before.state.events);
  const events = after.state.events.slice(before.state.events.length);
  assert.ok(events.every(value => value.trusted === true));
  const keys = events.filter(value => ["keydown", "keypress", "keyup"].includes(value.type) && value.code === spec.code);
  assert.deepEqual(keys.map(value => value.type), spec.prevented ? ["keydown", "keyup"] : ["keydown", "keypress", "keyup"], "Original printable key must reach the actual focused control");
  for (const event of keys) {
    assert.equal(event.target, spec.id); assert.equal(event.key, spec.character); assert.equal(event.repeat, false);
    assert.equal(event.shiftKey, Boolean(spec.shift)); assert.equal(event.ctrlKey, false); assert.equal(event.altKey, false); assert.equal(event.metaKey, false);
  }
  assert.equal(keys[0].defaultPrevented, Boolean(spec.prevented));
  if (!spec.prevented) assert.equal(keys[1].charCode, spec.character.charCodeAt(0));
  const localKeys = row.gesture.viewer.events.filter(value => ["keydown", "keyup"].includes(value.type) && value.code === spec.code);
  assert.deepEqual(localKeys.map(value => [value.type, value.key, value.trusted]), [["keydown", spec.character, true], ["keyup", spec.character, true]]);
  assert.equal(row.gesture.viewer.overflow, false);
  assertManagedPrintableLocalSequence(row.gesture.viewer, [spec.character]);
  const commands = row.gesture.commands;
  assert.equal(commands.some(value => value.input?.type === "text"), false, "Physical printable keys cannot also send a separate text commit");
  assert.deepEqual(commands.filter(value => value.input?.code === spec.code).map(value => value.input.action), ["down", "up"]);
  assert.deepEqual(commands.filter(value => value.input?.code === spec.code).map(value => value.input.text), [spec.character, undefined]);
  const edits = events.filter(value => ["beforeinput", "input"].includes(value.type));
  const changed = spec.id === "checkbox" ? "checkbox" : spec.id === "space-button" ? "buttonClicks" : spec.id;
  assert.equal(after.controls[changed], printableExpectedControls[changed]);
  for (const key of Object.keys(before.controls).filter(value => value !== changed)) assert.equal(after.controls[key], before.controls[key]);
  if (["lower", "upper", "symbol"].includes(spec.id)) {
    assert.deepEqual(edits.map(value => [value.type, value.inputType, value.data, value.target]), [
      ["beforeinput", "insertText", spec.character, spec.id], ["input", "insertText", spec.character, spec.id]
    ]);
    assert.ok(keys[1].sequence < edits[0].sequence && edits[0].sequence < edits[1].sequence && edits[1].sequence < keys.at(-1).sequence);
  } else if (spec.id === "checkbox") {
    assert.equal(events.filter(value => value.type === "click" && value.target === spec.id).length, 1);
    assert.equal(events.filter(value => value.type === "input" && value.target === spec.id).length, 1);
    assert.equal(events.filter(value => value.type === "change" && value.target === spec.id).length, 1);
  } else {
    assert.deepEqual(edits, []);
    if (spec.id === "space-button") assert.equal(events.filter(value => value.type === "click" && value.target === spec.id).length, 1);
  }
  assert.deepEqual(after.state.heldKeys, []); assert.deepEqual(after.state.heldButtons, []);
  return { verified: true, caseId: spec.id, originalDocumentId: before.documentId, documentToken: before.state.documentToken,
    events: events.map(value => value.sequence), inputRequestIds: commands.map(value => value.id), value: after.controls[changed] };
}

export function assessManagedPrintableCase(row) {
  try { return { passed: true, proof: assertManagedPrintableCase(row) }; }
  catch (error) { return { passed: false, outcome: "failed", error: String(error.stack ?? error) }; }
}

export function assertManagedPrintableDocuments(item, documents) {
  assert.equal(documents.length, item.fixture.kind === "oopif" ? 2 : 1);
  assert.deepEqual(documents.map(value => value.documentId).sort(), item.before.map(value => value.documentId).sort());
  for (const document of documents) {
    const original = item.before.find(value => value.documentId === document.documentId); assert.ok(original);
    assert.equal(document.url, original.url); assert.equal(document.state.workflowId, item.fixture.workflowId);
    assert.equal(document.state.documentToken, original.state.documentToken); assert.equal(document.state.overflow, false);
    assert.deepEqual(document.state.events.slice(0, original.state.events.length), original.state.events);
    for (const [i, event] of document.state.events.entries()) { assert.equal(event.sequence, i + 1); assert.equal(event.trusted, true); }
  }
}

export function proveManagedPrintableFrames(item, documents, webFrames, nativeEvents, begunAt) {
  const root = documents.find(value => value.frameId === 0), leaf = emitter(documents); assert.ok(root && leaf);
  const rootWeb = webFrames.find(value => value.documentId === root.documentId), leafWeb = webFrames.find(value => value.documentId === leaf.documentId);
  assert.ok(rootWeb && leafWeb); assert.equal(rootWeb.url, root.url); assert.equal(leafWeb.url, leaf.url);
  assert.ok(Number.isSafeInteger(rootWeb.processId) && Number.isSafeInteger(leafWeb.processId));
  const sourceMatches = source => (source.targetId !== undefined || source.tabId !== undefined) &&
    (source.targetId === undefined || source.targetId === item.target.id) && (source.tabId === undefined || source.tabId === item.tabId);
  const contexts = nativeEvents.filter(value => value.method === "Runtime.executionContextCreated" && value.at >= begunAt && value.params.context.auxData?.isDefault);
  const rootContexts = contexts.filter(value => sourceMatches(value.source) && value.source.sessionId === undefined && value.params.context.auxData.frameId === item.target.id && value.params.context.origin === new URL(root.url).origin);
  assert.equal(rootContexts.length, 1);
  let childContext = null, childAttachment = null;
  if (item.fixture.kind === "oopif") {
    assert.notEqual(leaf.frameId, 0); assert.notEqual(rootWeb.processId, leafWeb.processId); assert.notEqual(new URL(root.url).origin, new URL(leaf.url).origin);
    assert.equal(leafWeb.parentDocumentId, root.documentId);
    const children = contexts.filter(value => sourceMatches(value.source) && value.source.sessionId && value.params.context.origin === new URL(leaf.url).origin);
    assert.equal(children.length, 1); childContext = children[0];
    const attached = nativeEvents.filter(value => value.method === "Target.attachedToTarget" && value.at >= begunAt && sourceMatches(value.source) && value.params.sessionId === childContext.source.sessionId);
    assert.equal(attached.length, 1); childAttachment = attached[0]; assert.equal(childAttachment.params.targetInfo.url, leaf.url);
    assert.equal(childAttachment.params.targetInfo.type, "iframe"); assert.equal(childContext.params.context.auxData.frameId, childAttachment.params.targetInfo.targetId);
  }
  return { rootDocumentId: root.documentId, leafDocumentId: leaf.documentId, rootProcessId: rootWeb.processId, leafProcessId: leafWeb.processId,
    rootContext: rootContexts[0], childContext, childAttachment };
}

export function assertManagedPrintableLease(row, commands, messages, acceptance) {
  const actions = [...row.cases, ...(row.extended?.cases ?? [])].flatMap(value => [value.focus, value.tab, value.end, value.gesture].filter(Boolean));
  const expected = actions.flatMap(value => value.commands), actual = commands.filter(value => value.operation === "humanInput" && value.leaseId === row.lease.leaseId);
  assert.deepEqual(actual, expected, "Every input in the original lease must belong to a recorded real gesture");
  for (const [i, request] of actual.entries()) {
    assert.equal(request.sequence, i + 1); assert.equal(request.generation, row.lease.generation);
    const replies = messages.filter(value => value.type === "response" && value.id === request.id); assert.equal(replies.length, 1);
    assert.equal(replies[0].error, undefined); assert.deepEqual(replies[0].result.inputReceipt,
      { leaseId: request.leaseId, generation: request.generation, sequence: request.sequence, acknowledged: true });
  }
  const leaf = emitter(row.released), events = leaf.state.events.slice(emitter(row.before).state.events.length);
  const transitions = events.filter(value => ["keydown", "keyup"].includes(value.type));
  const keys = actual.filter(value => value.input.type === "key").map(value => [value.input.action === "down" ? "keydown" : "keyup", value.input.code]);
  if (row.extended) keys.push(["keyup", "KeyH"]);
  assert.deepEqual(transitions.map(value => [value.type, value.code]), keys, "No task key can appear between recorded gestures or after release");
  assert.ok(events.every(value => value.trusted)); assert.deepEqual(leaf.state.heldKeys, []); assert.deepEqual(leaf.state.heldButtons, []);
  if (acceptance) {
    assert.equal(events.filter(value => value.type === "keypress").length, 14);
    assert.equal(events.filter(value => value.type === "beforeinput").length, 12);
    assert.equal(events.filter(value => value.type === "input").length, 13);
    assert.equal(events.filter(value => value.type === "submit").length, 0);
    assert.deepEqual(leaf.controls, { ...printableExpectedControls, lower: "abbb", upper: "AAAa", symbol: "!hhh" });
  }
  return { verified: true, originalInputRequests: actual.length, originalKeyTransitions: transitions.length,
    originalKeypresses: events.filter(value => value.type === "keypress").length };
}

export async function runManagedPrintableWorkflow(io, cases) {
  const results = []; io.record(results);
  for (const item of cases) {
    const row = { kind: item.fixture.kind, tabId: item.tabId, startedAt: Date.now(), cases: [] }; results.push(row);
    row.begin = await io.begin(item); row.lease = structuredClone(io.state().human);
    row.before = await io.read(item); assertManagedPrintableDocuments(item, row.before);
    row.webFrames = await io.webFrames(item);
    row.frameProof = proveManagedPrintableFrames(item, row.before, row.webFrames, await io.nativeEvents(), row.startedAt);
    for (const spec of managedPrintableCases) {
      const result = { caseId: spec.id, startedAt: Date.now() }; row.cases.push(result);
      result.focus = await io.printableClick(item, await io.read(item), spec.focus);
      if (spec.tab) result.tab = await io.printableKey("Tab");
      if (spec.end) result.end = await io.printableKey("End");
      result.before = await io.read(item); assertManagedPrintableDocuments(item, result.before);
      assert.equal(emitter(result.before).activeElement, spec.id, "Preparation must focus the actual original control");
      result.gesture = await io.printableKey(spec.key);
      result.after = await io.read(item); assertManagedPrintableDocuments(item, result.after);
      result.assessment = assessManagedPrintableCase(result); result.endedAt = Date.now();
      // A missing behavior is evidence, not permission to retry or abort the
      // remaining cases. Runtime/identity/transport errors still fail normally.
    }
    if (io.printableMode === "acceptance") {
      row.extended = { cases: [] }; assert.equal(row.lease.printableKeyVersion, 1);
      for (const spec of managedPrintableRepeatCases) {
        const result = { caseId: spec.id, startedAt: Date.now() }; row.extended.cases.push(result);
        result.focus = await io.printableClick(item, await io.read(item), spec.field);
        result.end = await io.printableKey("End"); result.before = await io.read(item);
        result.gesture = await io.printableNative(spec.id, spec.commands);
        result.after = await io.read(item); assertManagedPrintableDocuments(item, result.after);
        try {
          result.localProof = assertManagedPrintableLocalSequence(result.gesture.viewer, spec.characters);
          result.assessment = { passed: true, proof: assertManagedPrintableRepeat(result) };
        } catch (error) { result.assessment = { passed: false, outcome: "failed", error: String(error.stack ?? error) }; }
        result.endedAt = Date.now();
      }
    }
    row.after = await io.read(item); row.screenshot = await io.screenshot("printable-" + row.kind);
    row.end = await io.end(row.lease); row.endedAt = Date.now(); row.released = await io.read(item);
    assertManagedPrintableDocuments(item, row.released);
    if (row.extended) {
      row.extended.late = await io.printableLate(printableLateRelease);
      row.extended.afterLocalRelease = await io.read(item);
      try { row.extended.endProof = assertManagedPrintableHeldEnd({ before: row.after, released: row.released,
        afterLocalRelease: row.extended.afterLocalRelease, late: row.extended.late }); }
      catch (error) { row.extended.endFailure = String(error.stack ?? error); }
    } else assert.deepEqual(row.released.map(value => value.state.events), row.after.map(value => value.state.events));
    assert.deepEqual(emitter(row.released).state.heldKeys, []); assert.deepEqual(emitter(row.released).state.heldButtons, []);
    try { row.leaseProof = assertManagedPrintableLease(row, io.commands(), io.messages(), io.printableMode === "acceptance"); }
    catch (error) { row.leaseFailure = String(error.stack ?? error); }
  }
  await io.resumeAgent();
  for (const item of cases) {
    const row = results.find(value => value.kind === item.fixture.kind);
    row.claim = { startedAt: Date.now(), beforeTarget: await io.originalTarget(item), beforeDocuments: await io.read(item) };
    assert.deepEqual(row.claim.beforeDocuments.map(value => value.state), row.released.map(value => value.state));
    row.claim.receipt = await io.claimOriginal(item); row.claim.acknowledgedAt = Date.now();
    assert.equal(row.claim.receipt.id, item.tabId); assert.equal(row.claim.receipt.url, item.target.url);
    row.claim.afterTarget = await io.originalTarget(item); row.claim.afterDocuments = await io.read(item);
    for (const key of ["id", "tabId", "url", "tab", "window"]) assert.deepEqual(row.claim.afterTarget[key], row.claim.beforeTarget[key]);
    assert.deepEqual(row.claim.afterDocuments.map(value => value.state), row.claim.beforeDocuments.map(value => value.state));
    assertManagedPrintableDocuments(item, row.claim.afterDocuments);
    row.submitStartedAt = Date.now(); await io.submitOriginal(item, row);
    row.receipt = await io.wait(() => item.fixture.stats().receipt, "one original printable POST after End/Resume/claim");
    row.afterSubmit = await io.wait(async () => { const documents = await io.read(item), leaf = emitter(documents);
      assert.notEqual(leaf.state.phase, "failed", leaf.state.error); return leaf.state.phase === "committed" && documents; }, "original printable POST response consumed");
    assert.deepEqual(emitter(row.afterSubmit).controls, emitter(row.after).controls);
  }
  for (const item of cases) {
    const row = results.find(value => value.kind === item.fixture.kind); row.finalDocuments = await io.read(item);
    assert.deepEqual(row.finalDocuments.map(value => value.state), row.afterSubmit.map(value => value.state), "No late key or duplicate POST after original submit");
  }
  return results;
}

export function assertManagedPrintableTerminalFixtures(fixtures, results) {
  assert.equal(fixtures.length, 2); assert.equal(results.length, 2);
  assert.deepEqual(fixtures.map(value => value.kind).sort(), ["oopif", "root"]);
  for (const fixture of fixtures) {
    const row = results.find(value => value.kind === fixture.kind); assert.ok(row);
    assert.equal(row.cases.length, managedPrintableCases.length); assert.equal(fixture.overflow, false); assert.equal(fixture.posted, true);
    assert.deepEqual(fixture.receipt, row.receipt); assert.equal(row.receipt.recorded, true);
    const posts = fixture.requests.filter(value => value.method === "POST"); assert.equal(posts.length, 1);
    const post = posts[0]; assert.ok(post.at >= row.submitStartedAt && row.submitStartedAt >= row.endedAt && row.submitStartedAt >= row.claim.acknowledgedAt);
    const bytes = Buffer.from(post.body.base64, "base64"), body = JSON.parse(bytes);
    assert.equal(post.body.truncated, false); assert.equal(bytes.length, post.body.bytes); assert.equal(sha(bytes), post.body.sha256);
    assert.equal(body.documentToken, emitter(row.afterSubmit).state.documentToken); assert.equal(body.workflowId, fixture.workflowId); assert.equal(body.posts, 1);
    assert.deepEqual(body.controls, emitter(row.after).controls); assert.deepEqual(body.events, emitter(row.afterSubmit).state.events);
    assert.equal(row.receipt.bodySHA256, post.body.sha256); assert.equal(row.receipt.eventsSHA256, sha(JSON.stringify(body.events)));
    const response = Buffer.from(post.response.base64, "base64"); assert.equal(response.length, post.response.bytes); assert.equal(sha(response), post.response.sha256); assert.deepEqual(JSON.parse(response), row.receipt);
    const expected = [["GET", new URL(fixture.urls.root).pathname], ...(fixture.kind === "oopif" ? [["GET", new URL(fixture.urls.emitter).pathname]] : []), ["POST", new URL(fixture.urls.receipt).pathname]];
    assert.deepEqual(fixture.requests.map(value => [value.method, value.path]), expected);
    for (const hit of fixture.requests) { assert.equal(hit.status, 200); assert.equal(hit.finished, true); assert.equal(hit.aborted, false); assert.deepEqual(hit.errors, []); assert.equal(hit.validationError, undefined); }
  }
  return { verified: true, originalPosts: 2, cases: results.flatMap(value => value.cases).length };
}

export function managedPrintableOutcome(mode, completed, results) {
  assert.ok(["baseline", "acceptance"].includes(mode));
  const cases = results.flatMap(value => value.cases ?? []);
  const extendedPassed = mode === "baseline" || results.every(value => value.extended?.cases?.length === 3 &&
    value.extended.cases.every(row => row.assessment?.passed === true) && value.extended.endProof?.verified === true && !value.extended.endFailure);
  const leasePassed = results.every(value => value.leaseProof?.verified === true && !value.leaseFailure);
  const featureObserved = completed === true && results.length === 2 && cases.length === managedPrintableCases.length * 2 && cases.every(value => value.assessment?.passed === true) && extendedPassed && leasePassed;
  const failures = [...cases, ...results.flatMap(value => value.extended?.cases ?? [])].filter(value => value.assessment?.passed === false).map(value => value.caseId);
  return { passed: mode === "acceptance" && featureObserved, featurePassed: mode === "acceptance" && featureObserved,
    diagnosticCompleted: mode === "baseline" && completed === true, observedOutcome: !completed ? "incomplete" : featureObserved ? "success" : "failed",
    featureObserved, failedCases: failures, baselineGapConfirmed: mode === "baseline" && completed === true && failures.length > 0 };
}
