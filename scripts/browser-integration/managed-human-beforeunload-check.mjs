// Shared original-viewer beforeunload workflow. Only explicit --acceptance uses
// passive event observation; the default send/ACK diagnostic can never pass.
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { runManagedHumanDialogCheck, assertManagedDialogEnded } from "./managed-human-dialog-check.mjs";
import { visibleHumanViewerPoint, assertHumanInputReceipt } from "./managed-human-check.mjs";
import { installManagedHumanNativeTrace, managedHumanNativeTraceComplete } from "./managed-human-native-trace.mjs";
import { installManagedBeforeunloadObservation, managedBeforeunloadObservationComplete } from "./managed-beforeunload-observation.mjs";
import { bound } from "./normal-browser-downloads-support.mjs";
import { createManagedBeforeunloadFixture, readManagedBeforeunloadDocument, measureManagedBeforeunloadLink, measureManagedBeforeunloadChildElement, projectManagedBeforeunloadChildMeasurements, beforeunloadDraft } from "./managed-human-beforeunload-fixture.mjs";

export function summarizeManagedBeforeunloadTrace(records, original) {
  assert.ok(Array.isArray(records)); let previous = 0;
  const sourceMatches = source => source?.tabId === original.tabId || source?.targetId === original.target.id;
  for (const row of records) { assert.ok(Number.isSafeInteger(row.sequence) && row.sequence > previous); previous = row.sequence; }
  const selected = records.filter(row => sourceMatches(row.source));
  const ordering = selected.filter(row => row.kind === "webNavigation" ||
    ["Page.javascriptDialogOpening", "Page.javascriptDialogClosed", "Page.frameStartedNavigating", "Page.frameNavigated", "Runtime.executionContextsCleared", "Runtime.executionContextCreated", "Runtime.executionContextDestroyed", "Input.dispatchMouseEvent", "Page.handleJavaScriptDialog"].includes(row.method));
  const openings = selected.filter(row => row.kind === "event" && row.method === "Page.javascriptDialogOpening");
  const closes = selected.filter(row => row.kind === "event" && row.method === "Page.javascriptDialogClosed");
  return { ordering, openingSequences: openings.map(row => row.sequence), closedSequences: closes.map(row => row.sequence),
    boundary: records.some(row => row.kind === "send") ? "One worker ledger gives observation order, not browser causality. Native send settlement, UI response, dialog publication and document navigation remain distinct original evidence."
      : "Passive native/web listeners give observation order, not browser causality. Native input ACK authority is the original production viewer receipt; no native send wrapper is installed." };
}

export async function runManagedBeforeunloadDiagnostic(context) {
  const { report, fixture, worker, page, business, state, readDocument, measureButton, decodedHuman, nativeEvents, wait, uiAction, uiObservation, screenshot, save } = context;
  const decoded = await decodedHuman(), before = await readDocument(), measurement = await measureButton("leave");
  assert.equal(before.documentId, business.before.documentId); assert.equal(before.state.documentToken, business.before.state.documentToken);
  assert.equal(before.draft, beforeunloadDraft); assert.equal(before.state.clicks.length, 0); assert.equal(before.state.beforeunloads.length, 0);
  assert.equal(measurement.clickable, true);
  if (fixture.variant === "child-navigates-parent") {
    assert.equal(measurement.child.target, "_top"); assert.equal(measurement.child.state.documentToken, fixture.stats().childToken);
    assert.equal(measurement.child.url, fixture.stats().childOrigin + fixture.paths.child);
  }
  const pointer = visibleHumanViewerPoint(measurement.rect, state().human.viewport, await page.locator("#frame").boundingBox(), decoded.image);
  const row = report.beforeunload = { variant: fixture.variant ?? "root-anchor", before, measurement, pointer, originalScope: { leaseId: state().human.leaseId, generation: state().human.generation },
    wireStart: report.viewerCommands.length, nativeStart: nativeEvents().length, startedAt: Date.now(), gestureCount: 1,
    boundary: "One ordinary viewer click on the original anchor. No Page.navigate/reload, task-page CDP input, injected activation, dialog answer fallback or business replay." };
  if (fixture.variant === "child-navigates-parent") {
    const frames = await worker.evaluate(`chrome.webNavigation.getAllFrames({tabId:${business.tabId}})`, 3000);
    const root = frames.find(frame => frame.frameId === 0 && frame.documentId === measurement.root.documentId), child = frames.find(frame => frame.frameId === measurement.child.frameId && frame.documentId === measurement.child.documentId);
    assert.ok(root && child); assert.equal(child.parentFrameId, 0); assert.equal(child.url, measurement.child.url);
    assert.ok(Number.isInteger(root.processId) && root.processId >= 0 && Number.isInteger(child.processId) && child.processId >= 0); assert.notEqual(child.processId, root.processId);
    const begin = report.viewerCommands.findLast(command => command.operation === "humanBegin"), events = nativeEvents();
    const attached = events.findLast(event => event.kind === "event" && event.method === "Target.attachedToTarget" && event.params.target?.type === "iframe" && event.at >= begin.at);
    assert.ok(attached?.params.sessionId && attached.params.target.targetId, "Actual current human iframe target/session required");
    const created = events.findLast(event => event.kind === "event" && event.method === "Runtime.executionContextCreated" && event.source.sessionId === attached.params.sessionId && event.params.context?.auxData?.isDefault === true && event.params.context.auxData.frameId === attached.params.target.targetId && event.sequence > attached.sequence);
    assert.ok(created?.params.context.uniqueId, "Actual original OOPIF default context required");
    assert.equal(events.some(event => event.method === "Target.detachedFromTarget" && event.params.sessionId === attached.params.sessionId && event.sequence > attached.sequence), false);
    row.oopif = { frames, root, child, attached, created, measurements: measurement.measurements };
    row.nativeStart = events.length;
  }
  const gesture = page.mouse.click(pointer.viewerPoint.x, pointer.viewerPoint.y).then(() => { row.gestureCompletedAt = Date.now(); }, error => { row.gestureError = error.stack; });
  try {
    row.opening = await wait(() => nativeEvents().slice(row.nativeStart).find(event => event.kind === "event" && event.method === "Page.javascriptDialogOpening"), "original native beforeunload opening", 8000);
    assert.equal(row.opening.params.type, "beforeunload");
    row.atOpening = { at: Date.now(), commands: report.viewerCommands.slice(row.wireStart), messages: report.viewerMessages.filter(message => message.at >= row.startedAt) };
    row.pending = await wait(async () => {
      const current = state(), pending = current?.pendingDialog;
      return pending?.type === "beforeunload" && pending.leaseId === row.originalScope.leaseId && pending.generation === row.originalScope.generation &&
        await page.locator("#page-dialog").isVisible() && await page.locator("#dialog-cancel").isEnabled() && structuredClone(pending);
    }, "original beforeunload Stay decision must reach the viewer", 2500);
    row.pendingUI = await uiObservation("beforeunload-pending"); row.pendingScreenshot = await screenshot("beforeunload-pending");
    row.stay = await uiAction("#dialog-cancel", "humanDialogRespond");
    row.closed = await wait(() => nativeEvents().slice(row.nativeStart).find(event => event.kind === "event" && event.method === "Page.javascriptDialogClosed"), "original beforeunload native close", 5000);
    assert.equal(row.closed.params.result, false);
    await decodedHuman(); row.afterStay = await readDocument();
    assert.equal(row.afterStay.documentId, before.documentId); assert.equal(row.afterStay.state.documentToken, before.state.documentToken); assert.equal(row.afterStay.draft, before.draft);
    assert.equal(fixture.stats().requests.some(request => request.path === fixture.paths.destination), false);
    row.userCouldStay = true;
  } finally {
    try { await bound(gesture, 5000, "original viewer gesture completion"); } catch (error) { row.gestureWaitError = error.stack; }
    row.commands = structuredClone(report.viewerCommands.slice(row.wireStart));
    row.responses = structuredClone(report.viewerMessages.filter(message => message.type === "response" && row.commands.some(command => command.id === message.id)));
    row.native = nativeEvents().slice(row.nativeStart); row.ordering = summarizeManagedBeforeunloadTrace(row.native, business);
    for (const [key, read] of [["finalUI", () => uiObservation("beforeunload-original-outcome")], ["finalScreenshot", () => screenshot("beforeunload-original-outcome")],
      ["after", readDocument], ["traceSnapshot", () => worker.evaluate("__managedHumanNativeTrace.snapshot()", 3000)]]) {
      try { row[key] = await read(); } catch (error) { row[key + "Error"] = error.stack; }
    }
    if (row.oopif) {
      try { row.childAfter = await worker.evaluate(`chrome.scripting.executeScript({target:{tabId:${business.tabId},documentIds:[${JSON.stringify(measurement.child.documentId)}]},func:()=>({url:location.href,state:JSON.parse(document.querySelector('#state').textContent)})}).then(rows=>rows.map(row=>({documentId:row.documentId,frameId:row.frameId,...row.result})))`, 3000); }
      catch (error) { row.childAfterError = error.stack; }
    }
    row.originalRequests = fixture.stats(); row.endedAt = Date.now(); await save();
  }
  assert.equal(row.gestureError, undefined);
  assert.equal(row.gestureWaitError, undefined);
}

export function assertBeforeunloadStayed(before, after, expectedDraft, fixture) {
  assert.equal(after.documentId, before.documentId); assert.equal(after.frameId, 0);
  assert.equal(after.state.documentToken, before.state.documentToken); assert.equal(after.state.workflowId, before.state.workflowId);
  assert.equal(after.state.phase, "draft"); assert.equal(after.state.error, null); assert.equal(after.state.eventOverflow, false);
  assert.equal(after.draft, expectedDraft); assert.equal(after.state.beforeunloads.length, 1);
  assert.equal(after.state.beforeunloads[0].trusted, true); assert.equal(after.state.beforeunloads[0].hasBeenActive, true);
  assert.equal(fixture.requests.some(request => request.method === "POST" || request.path.endsWith("/review")), false);
}

export function assertBeforeunloadReceipt(fixture, original, destination, after) {
  assert.equal(fixture.overflow, false); assert.equal(fixture.attempted, true);
  assert.notEqual(destination.documentId, original.documentId); assert.notEqual(destination.state.documentToken, original.state.documentToken);
  assert.equal(after.documentId, destination.documentId); assert.equal(after.state.documentToken, destination.state.documentToken);
  assert.equal(after.state.originalToken, original.state.documentToken); assert.equal(after.state.workflowId, fixture.workflowId);
  assert.equal(after.state.phase, "committed"); assert.equal(after.state.error, null); assert.equal(after.state.postAttempts, 1);
  assert.deepEqual(after.state.clicks, [{ trusted: true, button: 0 }]);
  const receipt = { ok: true, workflowId: fixture.workflowId, documentToken: destination.state.documentToken, originalToken: original.state.documentToken, submitCount: 1 };
  assert.deepEqual(fixture.receipt, receipt); assert.deepEqual(after.result, receipt);
  const posts = fixture.requests.filter(row => row.method === "POST"); assert.equal(posts.length, 1);
  assert.equal(posts[0].status, 200); assert.equal(posts[0].finished, true); assert.equal(posts[0].aborted, false);
  assert.deepEqual(JSON.parse(Buffer.from(posts[0].body.base64, "base64")), { workflowId: fixture.workflowId, documentToken: destination.state.documentToken,
    originalToken: original.state.documentToken, postAttempts: 1, clicks: [{ trusted: true, button: 0 }] });
  assert.deepEqual(JSON.parse(Buffer.from(posts[0].response.base64, "base64")), receipt);
  return { receipt, post: posts[0] };
}

export function assertBeforeunloadDecodedFrame(decoded, leaseId, afterGeneration, earliestAt) {
  const { image, frame } = decoded;
  assert.equal(image.hidden, false); assert.equal(image.complete, true);
  assert.equal(image.controlMode, "human"); assert.equal(frame.controlMode, "human");
  assert.equal(image.humanLeaseId, leaseId); assert.equal(frame.humanLeaseId, leaseId);
  assert.equal(Number(image.generation), frame.generation); assert.ok(frame.generation > afterGeneration);
  assert.equal(image.streamId, frame.streamId); assert.equal(Number(image.frameSequence), frame.sequence);
  assert.equal(image.width, frame.width); assert.equal(image.height, frame.height); assert.ok(frame.width > 0 && frame.height > 0);
  assert.match(frame.file, /^native-frame-\d{4}\.png$/); assert.match(frame.sha256, /^[a-f0-9]{64}$/);
  assert.ok(frame.at >= earliestAt && frame.bytes > 24);
}

export async function collectManagedBeforeunloadInputs({ report, page, wait, state, leaseId, start, label, generation }) {
  await wait(() => report.viewerCommands.slice(start).find(command => command.operation === "humanInput"), `${label} original outgoing input`);
  // The viewer serializes native input. The local Playwright gesture can finish
  // while later transitions are still queued. Capture only after that queue has
  // drained. Modal callers reach here only after the original UI decision/Closed.
  await wait(async () => await page.locator("#human-input").getAttribute("data-pending") === "0", `${label} original input queue settled`);
  const requests = report.viewerCommands.slice(start).filter(command => command.operation === "humanInput");
  assert.ok(requests.length, label); const receipts = [];
  for (const request of requests) {
    assert.equal(request.leaseId, leaseId); assert.equal(request.generation, generation);
    const response = await wait(() => report.viewerMessages.find(message => message.type === "response" && message.id === request.id), `${label} original input ACK`, 10000);
    assertHumanInputReceipt(request, response); receipts.push({ request, response });
  }
  // Closed/navigation may already have reset the current generation's local
  // counter. It cannot replace any of the original receipts required above.
  if (state().human?.leaseId === leaseId && state().human.generation === generation)
    assert.equal(Number(await page.locator("#human-input").getAttribute("data-acknowledged-sequence")), requests.at(-1).sequence);
  return receipts;
}

export function assertBeforeunloadDecision({ decision, original, requests, responses }) {
  const { opening, closed, pending, request, reply } = decision;
  assert.equal(opening.method, "Page.javascriptDialogOpening"); assert.equal(opening.params.type, "beforeunload");
  assert.equal(closed.method, "Page.javascriptDialogClosed");
  assert.ok(Number.isSafeInteger(opening.sequence) && opening.sequence > 0);
  assert.ok(Number.isSafeInteger(closed.sequence) && closed.sequence > opening.sequence);
  for (const event of [opening, closed]) {
    assert.equal(event.params.frameId, original.target.id);
    assert.ok(Object.keys(event.source).length > 0 && Object.keys(event.source).every(key => ["tabId", "targetId"].includes(key)));
    if (Object.hasOwn(event.source, "tabId")) assert.equal(event.source.tabId, original.tabId);
    if (Object.hasOwn(event.source, "targetId")) assert.equal(event.source.targetId, original.target.id);
  }
  assert.deepEqual(closed.source, opening.source);
  assert.equal(request.operation, "humanDialogRespond"); assert.ok(Number.isSafeInteger(request.id) && request.id > 0);
  assert.equal(request.leaseId, pending.leaseId); assert.equal(request.generation, pending.generation); assert.equal(request.dialogId, pending.dialogId);
  assert.equal(typeof request.accept, "boolean"); assert.equal(request.accept, decision.accept); assert.equal(closed.params.result, request.accept);
  const decisions = requests.filter(value => value.operation === "humanDialogRespond");
  assert.equal(decisions.length, 1, "Exactly one original UI dialog decision is required"); assert.deepEqual(decisions[0], request);
  const received = responses.filter(value => value.type === "response" && value.id === request.id);
  assert.equal(received.length, 1); assert.equal(received[0].error, undefined); assert.deepEqual(received[0].result, reply);
  assert.deepEqual(reply.dialogReceipt, { leaseId: pending.leaseId, generation: pending.generation, dialogId: pending.dialogId, acknowledged: true });
  return { openingSequence: opening.sequence, closedSequence: closed.sequence, requestId: request.id,
    leaseId: pending.leaseId, generation: pending.generation, dialogId: pending.dialogId,
    timing: { openingWorkerAt: opening.at, closedWorkerAt: closed.at, requestObservedAt: request.at, responseObservedAt: received[0].at },
    boundary: "Opening/Closed order comes from one worker ledger. The unique viewer request and its exact original dialogReceipt bind the decision; native Closed independently supplies the result. Worker event Date.now and Node Playwright framesent observation Date.now are different recording points, not comparable send/close causality." };
}

export async function runManagedBeforeunloadAcceptance(context) {
  const { report, fixture, worker, taskBrowser, page, business, state, readDocument, measureButton, decodedHuman, nativeEvents, wait, uiAction, uiObservation, screenshot, save } = context;
  const row = report.beforeunload = { variant: fixture.variant, instrumented: false, inputs: [], decisions: [], startedAt: Date.now(),
    boundary: "Passive listeners only. Original viewer edits and two native anchor clicks; Stay then Leave. SDK resumes only after End and an explicit new turn/claim. No navigation fallback, direct dialog answer, native wrapper or business replay." };
  const lease = structuredClone(state().human), firstDraft = beforeunloadDraft + " | traveller edit", finalDraft = firstDraft + " | kept after Stay";
  const targets = () => worker.evaluate(`chrome.debugger.getTargets().then(rows=>rows.filter(row=>row.type==='page'&&row.tabId===${business.tabId}).map(row=>({id:row.id,tabId:row.tabId,url:row.url,attached:row.attached})))`, 3000);
  const rootEvent = event => !event.source.sessionId && (event.source.tabId === business.tabId || event.source.targetId === business.target.id);
  const rootContext = () => nativeEvents().findLast(event => rootEvent(event) && event.method === "Runtime.executionContextCreated" &&
    event.params.context?.auxData?.isDefault === true && event.params.context.auxData.frameId === business.target.id);
  async function inputsSince(start, label, generation) {
    return collectManagedBeforeunloadInputs({ report, page, wait, state, leaseId: lease.leaseId, start, label, generation });
  }
  async function edit(label, text, expected) {
    const decoded = await decodedHuman(), before = await readDocument();
    assert.equal(before.documentId, business.before.documentId); assert.equal(before.draftHit, "draft");
    const pointer = visibleHumanViewerPoint(before.draftRect, state().human.viewport, await page.locator("#frame").boundingBox(), decoded.image);
    const action = { label, before, pointer, generation: state().human.generation, startedAt: Date.now(), wireStart: report.viewerCommands.length }; row.inputs.push(action);
    await page.mouse.click(pointer.viewerPoint.x, pointer.viewerPoint.y);
    action.clickACK = await inputsSince(action.wireStart, label + " draft focus", action.generation);
    const keyStart = report.viewerCommands.length; await page.keyboard.press("Control+End");
    action.keyACK = await inputsSince(keyStart, label + " caret", action.generation);
    const textStart = report.viewerCommands.length; await page.keyboard.insertText(text);
    action.textACK = await inputsSince(textStart, label + " edit", action.generation);
    action.after = await wait(async () => { const value = await readDocument(); return value.draft === expected && value; }, `${label} original draft text`);
    assert.equal(action.after.documentId, before.documentId); assert.equal(action.after.state.documentToken, before.state.documentToken);
    action.completedAt = Date.now(); action.screenshot = await screenshot(label);
  }
  async function leave(accept) {
    const decoded = await decodedHuman(), before = await readDocument(), measurement = await measureButton("leave"); assert.equal(measurement.clickable, true);
    const pointer = visibleHumanViewerPoint(measurement.rect, state().human.viewport, await page.locator("#frame").boundingBox(), decoded.image);
    const decision = { accept, before, measurement, pointer, beforeContext: rootContext(), beforeHuman: structuredClone(state().human), wireStart: report.viewerCommands.length, nativeStart: nativeEvents().length, startedAt: Date.now() }; row.decisions.push(decision);
    assert.ok(decision.beforeContext?.params.context.uniqueId);
    if (fixture.variant === "child-navigates-parent") {
      assert.equal(measurement.child.state.documentToken, fixture.stats().childToken); assert.equal(measurement.child.target, "_top");
      const frames = await worker.evaluate(`chrome.webNavigation.getAllFrames({tabId:${business.tabId}})`, 3000);
      const root = frames.find(value => value.frameId === 0 && value.documentId === before.documentId), child = frames.find(value => value.frameId === measurement.child.frameId && value.documentId === measurement.child.documentId);
      assert.ok(root && child); assert.equal(child.parentFrameId, 0); assert.equal(child.url, measurement.child.url);
      assert.ok(Number.isInteger(root.processId) && root.processId >= 0 && Number.isInteger(child.processId) && child.processId >= 0); assert.notEqual(root.processId, child.processId);
      const events = nativeEvents();
      // The original Begin wire time is authoritative, not a synthetic fixture timestamp.
      const beginAt = report.viewerCommands.find(command => command.operation === "humanBegin").at;
      const currentAttached = events.findLast(event => event.method === "Target.attachedToTarget" && event.params.target?.type === "iframe" && event.at >= beginAt);
      assert.ok(currentAttached?.params.sessionId && currentAttached.params.target.targetId);
      const created = events.findLast(event => event.method === "Runtime.executionContextCreated" && event.source.sessionId === currentAttached.params.sessionId && event.params.context?.auxData?.isDefault === true && event.params.context.auxData.frameId === currentAttached.params.target.targetId && event.sequence > currentAttached.sequence);
      assert.ok(created?.params.context.uniqueId); assert.equal(events.some(event => event.method === "Target.detachedFromTarget" && event.params.sessionId === currentAttached.params.sessionId && event.sequence > currentAttached.sequence), false);
      decision.oopif = { frames, root, child, attached: currentAttached, created };
    }
    const gesture = page.mouse.click(pointer.viewerPoint.x, pointer.viewerPoint.y).then(() => { decision.gestureCompletedAt = Date.now(); }, error => { decision.gestureError = error.stack; });
    try {
      decision.opening = await wait(() => nativeEvents().slice(decision.nativeStart).find(event => rootEvent(event) && event.method === "Page.javascriptDialogOpening"), "original beforeunload opening", 8000);
      assert.equal(decision.opening.params.type, "beforeunload"); assert.equal(decision.opening.params.frameId, business.target.id);
      decision.navigationStartBeforeOpening = nativeEvents().slice(decision.nativeStart).find(event => rootEvent(event) && event.method === "Page.frameStartedNavigating" && event.params.frameId === business.target.id && event.sequence < decision.opening.sequence) ?? null;
      decision.navigationOrder = decision.navigationStartBeforeOpening ? "root-start-before-opening" : "opening-without-prior-root-start";
      if (fixture.variant === "child-navigates-parent") assert.ok(decision.navigationStartBeforeOpening?.params.loaderId, "Actual OOPIF root start-first order is required");
      decision.pending = await wait(async () => {
        const current = state(), pending = current?.pendingDialog;
        return pending?.type === "beforeunload" && pending.leaseId === lease.leaseId && pending.generation === current.human?.generation &&
          current.human.leaseId === lease.leaseId && await page.locator("#page-dialog").isVisible() &&
          await page.locator(accept ? "#dialog-accept" : "#dialog-cancel").isEnabled() && structuredClone(pending);
      }, "original pending beforeunload decision", 5000);
      assert.ok(decision.pending.generation >= decision.beforeHuman.generation);
      decision.pendingHuman = structuredClone(state().human); decision.pendingUI = await uiObservation(accept ? "leave-pending" : "stay-pending");
      decision.screenshot = await screenshot(accept ? "leave-pending" : "stay-pending");
      decision.reply = await uiAction(accept ? "#dialog-accept" : "#dialog-cancel", "humanDialogRespond");
      decision.request = report.viewerCommands.findLast(command => command.operation === "humanDialogRespond");
      assert.equal(decision.request.leaseId, lease.leaseId); assert.equal(decision.request.generation, decision.pending.generation);
      assert.equal(decision.request.dialogId, decision.pending.dialogId); assert.equal(decision.request.accept, accept);
      decision.closed = await wait(() => nativeEvents().slice(decision.nativeStart).find(event => rootEvent(event) && event.method === "Page.javascriptDialogClosed"), "original native beforeunload closed", 5000);
      decision.association = assertBeforeunloadDecision({ decision, original: business, requests: report.viewerCommands.slice(decision.wireStart), responses: report.viewerMessages });
      await bound(gesture, 5000, "original leave viewer gesture"); assert.equal(decision.gestureError, undefined);
      decision.inputs = await inputsSince(decision.wireStart, accept ? "Leave" : "Stay", decision.beforeHuman.generation);
      return decision;
    } finally {
      try { await bound(gesture, 5000, "original leave gesture final settlement"); } catch (error) { decision.gestureWaitError = error.stack; }
      decision.native = nativeEvents().slice(decision.nativeStart); decision.ordering = summarizeManagedBeforeunloadTrace(decision.native, business);
      await save();
    }
  }
  try {
    row.before = await readDocument(); assert.equal(row.before.documentId, business.before.documentId); assert.equal(row.before.draft, beforeunloadDraft);
    await edit("draft-before-stay", " | traveller edit", firstDraft);
    const stayed = await leave(false);
    await wait(() => state().human?.leaseId === lease.leaseId && state().human.generation > stayed.pending.generation, "original Stay successor generation");
    row.stayedFrame = await decodedHuman(); row.afterStay = await readDocument(); row.afterStayContext = rootContext();
    assertBeforeunloadDecodedFrame(row.stayedFrame, lease.leaseId, stayed.pending.generation, stayed.closed.at);
    assert.equal(row.afterStayContext?.params.context.uniqueId, stayed.beforeContext.params.context.uniqueId);
    assert.ok(row.stayedFrame.frame.generation > stayed.pending.generation);
    assertBeforeunloadStayed(row.before, row.afterStay, firstDraft, fixture.stats());
    assert.equal(state().human.leaseId, lease.leaseId); assert.equal(state().status.state, "paused");
    if (fixture.variant === "root-anchor") assert.deepEqual(row.afterStay.state.clicks, [{ sequence: 1, trusted: true, button: 0, defaultPrevented: false, hasBeenActive: true }]);
    else { row.childAfterStay = await measureButton("leave"); assert.equal(row.childAfterStay.child.documentId, stayed.measurement.child.documentId);
      assert.deepEqual(row.childAfterStay.child.state.clicks, [{ sequence: 1, trusted: true, button: 0, defaultPrevented: false, hasBeenActive: true }]); }
    await edit("draft-after-stay", " | kept after Stay", finalDraft);
    const left = await leave(true);
    row.destination = await wait(async () => { const value = await readDocument(); return value.state.phase === "review" && value.documentId !== row.before.documentId && value; }, "original new review document");
    assert.equal(row.destination.url, report.fixtureURL + fixture.paths.destination); assert.equal(row.destination.state.originalToken, row.before.state.documentToken);
    assert.equal(row.destination.state.documentToken, fixture.stats().destinationToken); assert.equal(row.destination.state.postAttempts, 0);
    await wait(() => state().human?.leaseId === lease.leaseId && state().human.generation > left.pending.generation, "new original human generation");
    row.destinationFrame = await decodedHuman(); assert.ok(row.destinationFrame.frame.file); assert.ok(row.destinationFrame.frame.at >= left.closed.at);
    assertBeforeunloadDecodedFrame(row.destinationFrame, lease.leaseId, left.pending.generation, left.closed.at);
    assert.equal(row.destinationFrame.frame.humanLeaseId, lease.leaseId); assert.ok(row.destinationFrame.frame.generation > left.pending.generation);
    row.destinationContext = rootContext(); assert.ok(row.destinationContext?.params.context.uniqueId);
    assert.notEqual(row.destinationContext.params.context.uniqueId, left.beforeContext.params.context.uniqueId);
    row.destinationFrames = await worker.evaluate(`chrome.webNavigation.getAllFrames({tabId:${business.tabId}})`, 3000);
    assert.equal(row.destinationFrames.length, 1); assert.equal(row.destinationFrames[0].frameId, 0); assert.equal(row.destinationFrames[0].documentId, row.destination.documentId);
    row.destinationScreenshot = await screenshot("original-new-review-document"); row.destinationUI = await uiObservation("original-new-review-document");
    row.targetsBeforeEnd = await targets(); assert.equal(row.targetsBeforeEnd.length, 1); assert.equal(row.targetsBeforeEnd[0].id, business.target.id);
    assert.equal(fixture.stats().receipt, null); assert.equal(fixture.stats().requests.filter(request => request.method === "POST").length, 0);
    row.end = await uiAction("#human-end", "humanEnd"); assertManagedDialogEnded(row.end, lease.leaseId);
    row.targetsAfterEnd = await targets(); assert.equal(row.targetsAfterEnd.length, 1); assert.equal(row.targetsAfterEnd[0].id, business.target.id); assert.equal(row.targetsAfterEnd[0].attached, false);
    row.resume = await uiAction("#control", "resume"); assert.equal(row.resume.status.state, "running");
    row.turnBefore = { turnId: taskBrowser.client.turnId, controlEpoch: taskBrowser.client.controlEpoch };
    row.newTurn = await taskBrowser.client.beginTurn("explicit-after-beforeunload-stay-leave");
    assert.notEqual(taskBrowser.client.turnId, row.turnBefore.turnId);
    row.claim = { requestedTabId: business.tabId, before: await readDocument(), startedAt: Date.now() };
    assert.equal(row.claim.before.documentId, row.destination.documentId); assert.deepEqual(row.claim.before.state, row.destination.state);
    row.claim.receipt = await taskBrowser.client.claimUserTab(business.tabId); row.claim.acknowledgedAt = Date.now();
    assert.equal(row.claim.receipt.id, business.tabId); assert.equal(row.claim.receipt.url, row.destination.url);
    row.claim.after = await readDocument(); assert.equal(row.claim.after.documentId, row.destination.documentId); assert.deepEqual(row.claim.after.state, row.destination.state);
    row.claim.targets = await targets(); assert.equal(row.claim.targets.length, 1); assert.equal(row.claim.targets[0].id, business.target.id);
    const fresh = taskBrowser.tab(business.tabId); row.agentSnapshot = await fresh.domSnapshot({ timeoutMs: 10000 });
    row.submitStartedAt = Date.now(); await fresh.getByRole("button", { name: "Submit reviewed request", exact: true }).click({ timeoutMs: 10000 });
    row.afterSubmit = await wait(async () => { const value = await readDocument(); assert.notEqual(value.state.phase, "failed"); return value.state.phase === "committed" && value; }, "one original reviewed request receipt");
    row.receiptProof = assertBeforeunloadReceipt(fixture.stats(), row.before, row.destination, row.afterSubmit);
    row.finalize = { before: { turnId: taskBrowser.client.turnId, controlEpoch: taskBrowser.client.controlEpoch }, startedAt: Date.now() };
    row.finalize.result = await taskBrowser.client.finalizeTabs([{ tabId: business.tabId, status: "deliverable" }]);
    row.finalize.endedAt = Date.now(); assert.equal(row.finalize.result.endedTurnId, row.finalize.before.turnId); assert.ok(row.finalize.result.controlEpoch > row.finalize.before.controlEpoch);
    await uiAction("#refresh", "status"); row.delivered = structuredClone(state().tabs.find(value => value.id === business.tabId));
    assert.equal(row.delivered.kind, "result"); assert.ok(row.delivered.deliveryId); assert.notEqual(row.delivered.deliveryId, business.delivery.deliveryId); assert.equal(row.delivered.url, row.destination.url);
    assert.equal(report.viewerCommands.filter(command => command.operation === "humanBegin").length, 1);
    assert.equal(report.viewerCommands.filter(command => command.operation === "humanEnd").length, 1);
    assert.equal(report.viewerCommands.filter(command => command.operation === "resume").length, 1);
    assert.deepEqual(report.viewerCommands.filter(command => command.operation === "humanDialogRespond").map(command => command.accept), [false, true]);
    assert.notEqual(row.decisions[0].pending.dialogId, row.decisions[1].pending.dialogId);
    for (const command of report.viewerCommands.filter(value => value.operation === "humanInput")) assertHumanInputReceipt(command, report.viewerMessages.find(value => value.type === "response" && value.id === command.id));
    assert.deepEqual(report.viewerMessages.filter(value => value.type === "response" && value.error), []);
    assert.deepEqual(report.unexpectedRequests, []);
    const expected = [["GET", fixture.paths.page], ...(fixture.variant === "child-navigates-parent" ? [["GET", fixture.paths.child]] : []), ["GET", fixture.paths.destination], ["POST", fixture.paths.receipt]];
    assert.deepEqual(fixture.stats().requests.map(value => [value.method, value.path]), expected);
    assert.ok(fixture.stats().requests.every(value => value.status === 200 && value.finished === true && value.aborted === false));
    assert.equal(nativeEvents().filter(event => rootEvent(event) && event.method === "Page.javascriptDialogOpening").length, 2);
    assert.equal(nativeEvents().filter(event => rootEvent(event) && event.method === "Page.javascriptDialogClosed").length, 2);
    row.businessCompleted = true;
  } finally {
    row.native = nativeEvents(); row.ordering = summarizeManagedBeforeunloadTrace(row.native, business); row.originalRequests = fixture.stats(); row.endedAt = Date.now(); await save();
  }
}

export function createManagedBeforeunloadScenario({ variant = "root-anchor", acceptance = false } = {}) {
  assert.equal(typeof acceptance, "boolean");
  const fixture = createManagedBeforeunloadFixture({ variant });
  return {
    kind: acceptance ? "beforeunload-acceptance" : "beforeunload-diagnostic", instrumented: !acceptance, fixtures: [fixture],
    readDocument: readManagedBeforeunloadDocument, measureButton: variant === "root-anchor" ? measureManagedBeforeunloadLink : measureManagedBeforeunloadChildElement,
    ...(variant === "child-navigates-parent" ? { measureOriginal: async ({ worker, tabId, caseId }) => {
      const rows = await worker.evaluate(`chrome.scripting.executeScript({target:{tabId:${tabId},allFrames:true},func:${measureManagedBeforeunloadChildElement.toString()},args:[${JSON.stringify(caseId)}]}).then(rows=>rows.map(row=>({documentId:row.documentId,frameId:row.frameId,...row.result})))`, 5000);
      const value = projectManagedBeforeunloadChildMeasurements(rows);
      const hit = await worker.evaluate(`chrome.scripting.executeScript({target:{tabId:${tabId},documentIds:[${JSON.stringify(value.root.documentId)}]},func:point=>({hitTargetId:document.elementFromPoint(point.x,point.y)?.id??null}),args:[${JSON.stringify(value.point)}]}).then(rows=>{if(rows.length!==1)throw Error('Original root hit missing');return rows[0]})`, 3000);
      assert.equal(hit.documentId, value.root.documentId); assert.equal(hit.result.hitTargetId, "leave-child"); value.rootHit = hit; return value;
    } } : {}),
    observerExpression: "__managedHumanNativeTrace",
    isTraceComplete: managedHumanNativeTraceComplete,
    scope: "Instrumented beforeunload diagnosis through the production managed run/view and original delivered page. One ordinary viewer anchor click; original native send/ACK, dialog, navigation and execution-context events share a bounded worker ledger. No task CDP input or dialog fallback. Original failure and genuine Stop/Job/resource cleanup are retained. This run can never establish feature acceptance or full stay/leave/Resume business completion." + (variant === "child-navigates-parent" ? " Explicit child-navigates-parent variant: the original cross-site OOPIF anchor targets _top; readonly iframe/link geometry maps the ordinary viewer click to the root surface. Distinct renderer processes and the actual current iframe target/session/default context are required. Event order is observed, never assumed to be start-first." : ""),
    limits: "The opt-in native send wrapper preserves original receiver/arguments/Promise/errors but its observation side-chain may affect scheduling. Native and webNavigation listeners only observe. This is a single root-page diagnosis, not formal feature acceptance, Windows OS input/focus proof, real SSO or browser-toolbar navigation. Pending/overflowed or unrestored trace remains incomplete even if the workflow ends. Original Stop/Job receipts remain cleanup authority.",
    installObservation: ({ worker, originals }) => worker.evaluate(`(${installManagedHumanNativeTrace.toString()})(chrome,globalThis,${JSON.stringify({ beforeunload: true, publishDialogBinding: true, originals })})`),
    run: runManagedBeforeunloadDiagnostic,
    ...(acceptance ? {
      observerExpression: "__managedBeforeunloadObservation", isTraceComplete: managedBeforeunloadObservationComplete,
      installObservation: ({ worker, originals }) => worker.evaluate(`(${installManagedBeforeunloadObservation.toString()})(chrome,globalThis,${JSON.stringify(originals)})`),
      run: runManagedBeforeunloadAcceptance,
      scope: "Formal original delivered-page beforeunload acceptance: viewer edits draft, Stay preserves original document, further edit, Leave reaches a new document and decoded original PNG, then End, explicit Resume/new SDK turn/claim, unique business POST and original receipt, re-finalize and genuine Stop cleanup. Native/web events are passive listeners with no sendCommand wrapper. Variant: " + variant,
      limits: "Bounded local business flow using committed text, not IME preedit, real SSO, browser toolbar navigation or OS focus proof. Unsaved text is deliberately discarded only on Leave. Listener observation order does not prove browser causality; exact native input ACKs are the production viewer receipts. Original native PNG and decoded frame identity establish pixels independently of later SDK work.",
    } : {}),
  };
}

export async function runManagedHumanBeforeunloadCheck(options) {
  return runManagedHumanDialogCheck({ scenario: createManagedBeforeunloadScenario(options) });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2); assert.ok(args.length <= 2 && new Set(args).size === args.length && args.every(value => ["--acceptance", "--child-navigates-parent"].includes(value)), "Only explicit acceptance and child-navigates-parent modes are supported");
  const report = await runManagedHumanBeforeunloadCheck({ acceptance: args.includes("--acceptance"), variant: args.includes("--child-navigates-parent") ? "child-navigates-parent" : "root-anchor" });
  process.exitCode = report.featurePassed ? 0 : 1;
}
