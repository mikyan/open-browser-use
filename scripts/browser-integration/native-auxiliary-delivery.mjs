import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { installAuxiliaryDeliveryGate } from "./auxiliary-delivery-gate.mjs";
import { installCreatedPageObserver, assertCreatedPageSource, assertCreatedPageReceipt, createdPageAction } from "./created-page-provenance.mjs";
import { installCreatedPageAdoptionObserver } from "./created-page-adoption-observer.mjs";
import { installCreatedPageNativeControlObserver } from "./created-page-native-control.mjs";
import { assertPopupSourcePlacement, assertPopupChildPlacement, assertPopupFocusUnchanged, assertPopupAdoption, assertPopupNativeControl } from "./created-page-popup-source.mjs";
import { requireNativeCreatedPageRejection } from "./native-created-page-loss.mjs";

const phases = ["claim-delete", "marker-write"], interruptions = ["host-loss", "worker-stop"], variants = ["root", "oopif", "dynamic-oopif"];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const errorText = error => error?.stack ?? String(error);
const scopeOf = browser => ({ session_id: browser.client.sessionId, turn_id: browser.client.turnId, control_epoch: browser.client.controlEpoch });
const denied = /not part of browser session|already part of browser session|OBU_AUXILIARY_/i;
const one = (values, message) => { assert.equal(values.length, 1, message); return values[0]; };
const sameScope = (actual, expected) => { for (const key of ["session_id", "turn_id", "control_epoch"]) assert.equal(actual[key], expected[key]); };
const wait = async (operation, deadline, label) => {
  for (;;) { const value = await createdPageAction(deadline, operation); if (value) return value; assert.ok(performance.now() < deadline, label); await delay(20); }
};

export function assertInterruptedDeliveryHeld({ snapshot, item, phase, state }) {
  assert.ok(phases.includes(phase)); assert.equal(snapshot.stage, phase); sameScope(snapshot.scope, item.scope);
  assert.deepEqual(snapshot.tabIds, [item.tabId, item.childId]); assert.equal(snapshot.overflow, false); assert.deepEqual(snapshot.errors, []);
  const gate = snapshot.gate; assert.ok(gate?.held); assert.equal(gate.nativeSettled, true); assert.equal(gate.released, false); assert.equal(gate.published, false);
  assert.equal(Boolean(gate.timedOut), false); assert.equal(Boolean(gate.rejected), false);
  const call = one(snapshot.records.filter(row => row.kind === "call" && row.operationId === gate.operationId), "One original selected storage call");
  const ack = one(snapshot.records.filter(row => row.kind === "native-fulfilled" && row.operationId === gate.operationId), "Real original storage success ACK");
  const held = one(snapshot.records.filter(row => row.kind === "held" && row.operationId === gate.operationId), "One after-ACK hold");
  assert.equal(call.selectedGate, true); assert.ok(call.sequence < ack.sequence && ack.sequence < held.sequence);
  assert.equal(gate.nativeSequence, ack.sequence); assert.equal(gate.heldSequence, held.sequence);
  assert.equal(snapshot.current.ending, true); assert.equal(snapshot.current.sameIncarnation, true);
  for (const claim of snapshot.current.claims) { assert.equal(claim.replaced, false); assert.equal(claim.proofPresent, true); }
  assert.equal(state.native.tabs.some(tab => tab.id === item.workTabId), false, "Original omitted work page already closed");
  const source = one(state.ownership.filter(value => value.tabId === item.tabId), "Exact source state"), child = one(state.ownership.filter(value => value.tabId === item.childId), "Exact child state");
  assert.deepEqual(source.stored, []);
  if (phase === "claim-delete") {
    assert.equal(gate.gateTabId, item.tabId, "Hold FIRST source deletion, not later child deletion");
    assert.deepEqual(call.args.omitted, [{ tabId: item.tabId, claimId: item.sourceOwnership.owner.claimId }]);
    assert.deepEqual(call.args.selectedRemaining, [{ tabId: item.childId, claimId: item.childOwnership.owner.claimId, phase: "committed" }]);
    assert.deepEqual(child.owner, item.childOwnership.owner); assert.deepEqual(child.stored, [item.childOwnership.owner]);
    assert.equal(source.entry?.claimId, item.sourceOwnership.owner.claimId); assert.equal(source.entry.phase, "quarantined"); assert.equal(source.owner, null);
    for (const id of snapshot.tabIds) { assert.equal(state.delivery[id], undefined); assert.equal(state.storedDelivery[id], undefined); }
  } else {
    assert.equal(snapshot.current.finalizing, true); assert.deepEqual(child.stored, []);
    for (const value of [source, child]) { assert.equal(value.entry, null); assert.equal(value.owner, null); }
    for (const id of snapshot.tabIds) {
      const marker = state.delivery[id]; assert.ok(marker?.deliveryId);
      assert.deepEqual(state.storedDelivery[id], marker);
      assert.deepEqual(one(call.args.markers.filter(value => value.tabId === id), "Exact published marker"), { tabId: id, ...marker });
    }
  }
}

export function assertInterruptedDeliveryState({ item, phase, interruption, state, held }) {
  assert.ok(phases.includes(phase)); assert.ok(interruptions.includes(interruption));
  assertPopupChildPlacement({ item, birth: item.childBirth, native: state.native });
  assert.equal(state.native.tabs.some(tab => tab.id === item.workTabId), false, "Interrupted delivery must not recreate work page");
  const retainedChild = phase === "claim-delete" && interruption === "host-loss";
  for (const id of [item.tabId, item.childId]) {
    const value = one(state.ownership.filter(row => row.tabId === id), "Exact original ownership");
    if (retainedChild && id === item.childId) {
      assert.deepEqual(value.owner, item.childOwnership.owner, "Host loss retains the original collected child membership");
      assert.deepEqual(value.entry, value.owner); assert.deepEqual(value.stored, [value.owner]);
    } else { assert.equal(value.entry, null); assert.equal(value.owner, null); assert.deepEqual(value.stored, []); }
    assert.equal(state.native.targets.some(target => target.tabId === id && target.attached), false);
    if (phase === "marker-write" && interruption === "worker-stop") {
      assert.deepEqual(state.delivery[id], held.delivery[id], "Surviving marker retains its original delivery identity");
      assert.deepEqual(state.storedDelivery[id], held.storedDelivery[id]); assert.ok(state.delivery[id]?.deliveryId);
    } else { assert.equal(state.delivery[id], undefined); assert.equal(state.storedDelivery[id], undefined); }
  }
  return { retainedChild, markerRetained: phase === "marker-write" && interruption === "worker-stop" };
}

export function assertInterruptedDeliveryRuntime(before, after, interruption) {
  assert.ok(interruptions.includes(interruption));
  for (const key of ["browserPid", "browserId", "extensionId", "extensionInstanceId", "incarnation", "observerTarget"]) {
    assert.notEqual(before[key], undefined, `Missing original ${key}`); assert.equal(after[key], before[key], key);
  }
  for (const key of ["workerTarget", "contextId"]) { assert.ok(before[key]); assert.ok(after[key]);
    if (interruption === "host-loss") assert.equal(after[key], before[key], key); else assert.notEqual(after[key], before[key], key); }
  if (interruption === "host-loss") assert.equal(after.lifecycle.bootId, before.lifecycle.bootId); else assert.notEqual(after.lifecycle.bootId, before.lifecycle.bootId);
  assert.notEqual(after.host.pid, before.host.pid); assert.notEqual(after.host.socketPath, before.host.socketPath);
}

export function assertInterruptedDeliveryDocuments({ item, observations, server }) {
  assert.equal(server.overflow, false);
  for (const [name, frame, original] of [["source", item.sourceFrame, item.sourceAfter], ["root", item.rootFrame, item.rootAfter], ["child", item.childFrame, item.childAfter]]) {
    const value = observations[name]; assert.equal(value.documentId, frame.documentId, `${name} original document`);
    assert.equal(value.frameId, frame.frameId); assert.equal(value.result.href, frame.url); assert.deepEqual(value.result.state, original, `${name} business state replayed or changed`);
  }
  assert.deepEqual(observations.child.result.receipt, item.receipt);
  const sourceCase = one(server.cases.filter(value => value.key === item.key), "Original fixture source case");
  assert.deepEqual(sourceCase.documents, item.sourceDocuments, "Source/frame HTML was fetched again");
  const child = one(server.children.filter(value => value.nonce === item.childBefore.documentNonce), "Original child nonce");
  assert.deepEqual(child, item.originalChild, "Original child HTTP evidence changed or replayed");
  assert.equal(server.children.length, item.serverChildrenAtBusiness, "Recovery created another child document");
  for (const [frames, expected] of [[observations.sourceFrames, item.sourceFrame], [observations.sourceFrames, item.rootFrame], [observations.childFrames, item.childFrame]])
    assert.deepEqual(one(frames.filter(frame => frame.frameId === expected.frameId), "Exact original frame").documentId, expected.documentId);
  return assertCreatedPageReceipt({ item, child, state: observations.child.result.state, receipt: observations.child.result.receipt, frames: observations.childFrames });
}

export function assertInterruptedDeliveryTiming({ submittedAt, interruption, evidence, held, before }) {
  assert.ok(Number.isFinite(submittedAt)); assert.ok(interruptions.includes(interruption));
  assert.equal(held.overflow, false); assert.deepEqual(held.errors, []);
  const gate = held.gate; assert.equal(gate.nativeSettled, true); assert.equal(gate.held, true);
  assert.equal(gate.released, false); assert.equal(gate.published, false); assert.equal(Boolean(gate.timedOut), false);
  assert.ok(Number.isFinite(gate.nativeAt) && Number.isFinite(gate.heldAt));
  assert.ok(submittedAt <= gate.nativeAt && gate.nativeAt <= gate.heldAt);
  assert.ok(gate.nativeSequence < gate.heldSequence); assert.ok(Number.isFinite(held.holdTimeoutMs) && held.holdTimeoutMs > 0);
  const interruptedAt = interruption === "host-loss" ? evidence.killed?.exitedAt : evidence.stopAcknowledgedAt;
  assert.ok(Number.isFinite(interruptedAt), "Actual native interruption ACK timestamp required");
  assert.ok(interruptedAt >= gate.heldAt, "Native interruption must follow the original after-ACK hold");
  assert.ok(interruptedAt < submittedAt + 20000, "Native interruption occurred after the original finalize deadline");
  assert.ok(interruptedAt < gate.heldAt + held.holdTimeoutMs, "Original gate expired before native interruption");
  if (interruption === "host-loss") {
    assert.equal(evidence.killed.exactHandle, true); assert.equal(evidence.killed.pid, before.host.pid);
    assert.ok(evidence.killed.requestedAt >= gate.heldAt && evidence.killed.requestedAt <= interruptedAt);
  } else {
    assert.equal(evidence.stopInvocations, 1); assert.equal(evidence.before.workerTarget, before.workerTarget);
    assert.ok(evidence.requestedAt >= gate.heldAt && evidence.requestedAt <= interruptedAt);
    assert.ok(evidence.workerEvents.some(row => row.method === "ServiceWorker.workerVersionUpdated" && row.params.versions.some(version => version.versionId === evidence.version.versionId && version.runningStatus === "stopped")), "Exact original worker stopped event required");
  }
  return { interruptedAt, originalDeadlineAt: submittedAt + 20000, remainingMs: submittedAt + 20000 - interruptedAt };
}

export function assertInterruptedDeliveryOutcome({ submittedAt, observedThrough, outcome }) {
  assert.ok(Number.isFinite(submittedAt)); assert.ok(observedThrough >= submittedAt + 20250, "No-replay observation ended before original deadline");
  assert.equal(outcome?.fulfilled, false, "Interrupted original finalization must not report success");
  assert.doesNotMatch(outcome.error.split("\n", 1)[0], /timeout|timed out/i, "SDK timeout is not a native disconnect result");
  assert.match(outcome.error, /closed|disconnect|connection|pipe|socket|EOF|OBU_NATIVE_|OBU_CONTROL_|OBU_TURN_|OBU_STALE_/i);
  assert.ok(outcome.settledAt >= submittedAt && outcome.settledAt < submittedAt + 20000, "Original request must fail before its original deadline");
}

// Reads only an exact retained native document. This grants no SDK authority and
// does not attach a debugger, invoke a business handler or synthesize input.
async function readDocument(evaluate, tabId, frame) {
  const result = await evaluate(`chrome.scripting.executeScript({target:{tabId:${tabId},documentIds:[${JSON.stringify(frame.documentId)}]},world:'MAIN',func:()=>{const state=document.querySelector('#state')?.textContent,receipt=document.querySelector('#result')?.textContent;return{href:location.href,state:state?JSON.parse(state):null,receipt:receipt?JSON.parse(receipt):null}}})`);
  const value = one(result, "One exact original document read"); assert.equal(value.documentId, frame.documentId); assert.equal(value.frameId, frame.frameId); return value;
}

// Launcher supplies genuine native-host/worker controllers and owns the global
// focus ledger. Every call is one original variant, not a retry. Preparation has
// a 20s workflow budget; finalization has its own original 20s SDK request budget.
export async function checkNativeInterruptedPopupDelivery({ connect, getWorker, createPopup, readFocus, identity, fixtureURL, server,
  phase, interruption, variant, terminateHost, reconnectHost, restartWorker, saveDetail = async () => {}, detail = {} }) {
  assert.ok(phases.includes(phase)); assert.ok(interruptions.includes(interruption)); assert.ok(variants.includes(variant));
  for (const fn of [connect, getWorker, createPopup, readFocus, identity]) assert.equal(typeof fn, "function");
  if (interruption === "host-loss") { assert.equal(typeof terminateHost, "function"); assert.equal(typeof reconnectHost, "function"); }
  else assert.equal(typeof restartWorker, "function");
  const clients = [], installed = [], item = detail.item = {}; let browser, foreign, fresh, freshForeign, waiter, cancelled = false, gateInstalled = false, workerReplaced = false, failure, pending;
  const evaluate = expression => getWorker().evaluate(expression), frames = tabId => evaluate(`chrome.webNavigation.getAllFrames({tabId:${tabId}})`);
  const inventory = () => evaluate("(async()=>({tabs:await chrome.tabs.query({}),windows:await chrome.windows.getAll({}),targets:await chrome.debugger.getTargets()}))()");
  const state = async () => {
    const values = await evaluate(`(async()=>{const b=__integrationBackend,s=(await chrome.storage.session.get('OPEN_BROWSER_USE_AUXILIARY_TABS')).OPEN_BROWSER_USE_AUXILIARY_TABS?.records??[],local=(await chrome.storage.local.get('OPEN_BROWSER_USE_SESSION_STATE')).OPEN_BROWSER_USE_SESSION_STATE;return{ownership:${JSON.stringify([item.tabId, item.childId].filter(Number.isSafeInteger))}.map(tabId=>({tabId,entry:b.auxiliaryTabs.entry(tabId)??null,owner:b.auxiliaryTabs.owner(tabId)??null,stored:s.filter(r=>r.tabId===tabId)})),delivery:structuredClone(b.store.state.deliverableTabs??{}),storedDelivery:local?.deliverableTabs??{},nativeRecovery:b.nativeRecovery?{pending:b.nativeRecovery.pending,error:b.nativeRecovery.error?String(b.nativeRecovery.error):null}:null}})()`);
    return { ...values, native: await inventory() };
  };
  const read = (target, deadline, selector = "#state") => wait(async options => { const text = await target.locator(selector).textContent(options); assert.ok(typeof text === "string" && Buffer.byteLength(text) <= 65536); return text ? JSON.parse(text) : null; }, deadline, "Original fixture state ready");
  const stop = async name => {
    const value = await evaluate(`(()=>{const api=globalThis[${JSON.stringify(name)}];if(!api)throw Error('Original observer absent');const result=api.stop();if(globalThis[${JSON.stringify(name)}]!==api)throw Error('Observer replaced');delete globalThis[${JSON.stringify(name)}];return result})()`);
    assert.equal(value.closed, true); assert.equal(value.overflow, false);
    if (["__createdPageProvenance", "__nativeAuxiliaryFrames"].includes(name)) assert.equal(value.listenerPresent, false);
    else if (name !== "__nativeAuxiliaryFrames") { assert.equal(value.restored, true); assert.deepEqual(value.errors, []); assert.deepEqual(value.pendingOperations, []); }
    installed.splice(installed.indexOf(name), 1); return value;
  };
  Object.assign(detail, { phase, interruption, variant, recoveryVerified: false, startedAt: Date.now(), cleanup: [],
    boundary: "Real native launcher supplied by caller. Original user popup and natural unowned child; one trusted Control-click and one original POST. FIRST source-claim deletion ACK or original marker-write ACK held without changing storage arguments. Business observers stop before the hold; no claim of complete cross-worker native RPC coverage. Original document/HTTP continuity proves business non-replay. Worker destruction has no fictional gate-restoration ACK. No interrupted disposition replay or implicit claim recovery." });
  try {
    browser = await connect(`native-delivery-${phase}-${interruption}-${variant}`); clients.push(browser);
    assert.equal((await browser.client.getInfo()).metadata.auxiliaryDeliveryVersion, 1); await browser.client.beginTurn("native-auxiliary-delivery"); item.scope = scopeOf(browser);
    foreign = await connect(`native-delivery-foreign-${phase}-${interruption}-${variant}`); clients.push(foreign); await foreign.client.getInfo(); await foreign.client.beginTurn();
    const work = await browser.newTab(); item.workTabId = work.id; item.workBirth = one((await inventory()).tabs.filter(tab => tab.id === work.id), "Original public work page");
    assert.equal(item.workBirth.active, false);
    item.workOrigin = await evaluate(`(async()=>{const s=await __integrationBackend.store.getSession(${JSON.stringify(item.scope.session_id)});return s.tabOrigins[String(${work.id})]??__integrationBackend.auxiliaryTabs.owner(${work.id})?.origin})()`);
    assert.equal(item.workOrigin, "agent");
    for (const [name, source] of [["__createdPageNativeControl", `(${installCreatedPageNativeControlObserver.toString()})(chrome,globalThis)`], ["__createdPageProvenance", `(${installCreatedPageObserver.toString()})(chrome,globalThis)`], ["__createdPageAdoption", `(${installCreatedPageAdoptionObserver.toString()})(__integrationBackend,chrome,globalThis,${JSON.stringify({ sessions: [item.scope.session_id] })})`]]) {
      await evaluate(source); installed.push(name);
    }
    const fixture = server.createCase({ owner: `native-delivery-${phase}-${interruption}-${variant}`, variant }), before = await inventory();
    const destinationWindow = one(before.windows.filter(window => window.type === "normal"), "Single pre-existing normal window"), sentinel = one(before.tabs.filter(tab => tab.windowId === destinationWindow.id && tab.active), "Original active sentinel");
    assert.equal(destinationWindow.focused, true); assert.notEqual(destinationWindow.state, "minimized");
    const win = await createPopup("about:blank"), original = one(win.tabs ?? [], "Original sole popup tab");
    Object.assign(item, { variant, key: fixture.key, owner: fixture.owner, tabId: original.id, sourceWindow: win, createdTab: original, destinationWindow, sentinel,
      sourceURL: new URL(fixture.urlPath, fixtureURL).href, childURL: new URL("/created-page/child", fixtureURL).href });
    assert.equal(win.type, "popup"); assert.equal(win.focused, false); item.focusAfterCreation = await readFocus();
    item.beforeClaim = (await state()).ownership.find(value => value.tabId === item.tabId);
    assert.equal(item.beforeClaim.entry, null); assert.equal(item.beforeClaim.owner, null); assert.deepEqual(item.beforeClaim.stored, []);
    await browser.client.claimUserTab(item.tabId);
    item.sourceOwnership = (await state()).ownership.find(value => value.tabId === item.tabId);
    assert.equal(item.sourceOwnership.owner.kind, "popup"); assert.equal(item.sourceOwnership.owner.origin, "user"); sameScope(item.sourceOwnership.owner, item.scope);
    item.observerReady = await evaluate(`__createdPageProvenance.register(${item.tabId})`);
    await evaluate(`(()=>{const rows=[];let overflow=false,closed=false;const listener=(source,method,params)=>{if(source.tabId===${item.tabId}&&method==='Target.attachedToTarget'&&params?.targetInfo?.type==='iframe'){if(rows.length>=128){overflow=true;return}rows.push(structuredClone({source,params}))}};chrome.debugger.onEvent.addListener(listener);globalThis.__nativeAuxiliaryFrames={snapshot:()=>({rows,overflow}),stop(){chrome.debugger.onEvent.removeListener(listener);closed=true;return{rows,overflow,closed,listenerPresent:chrome.debugger.onEvent.hasListener(listener)}}}})()`); installed.push("__nativeAuxiliaryFrames");
    const tab = browser.tab(item.tabId); await browser.cdp.navigate(item.tabId, item.sourceURL);
    const deadline = performance.now() + 20000; item.workflow = { startedAt: Date.now(), timeoutMs: 20000 };
    item.rootBefore = await read(tab, deadline); assert.deepEqual(item.rootBefore.frameAdds, []);
    const arm = async () => { waiter = await createdPageAction(deadline, () => tab.expectPage({ timeoutMs: Math.floor(deadline - performance.now()) })); item.waiterId = waiter.waiterId; };
    if (variant === "dynamic-oopif") { await arm(); await createdPageAction(deadline, options => tab.locator("#add-frame").click(options)); }
    const target = variant === "root" ? tab : tab.frameLocator("#created-page-frame"); item.sourceBefore = await read(target, deadline); assert.deepEqual(item.sourceBefore.clicks, []);
    item.framesBefore = await frames(item.tabId); item.rootFrame = one(item.framesBefore.filter(frame => frame.frameId === 0), "Original source root");
    const sourceURL = variant === "root" ? item.sourceURL : new URL(`/created-page/frame?key=${encodeURIComponent(item.key)}`, fixtureURL.replace("127.0.0.1", "localhost")).href;
    item.sourceFrame = one(item.framesBefore.filter(frame => frame.url === sourceURL && (variant === "root" ? frame.frameId === 0 : frame.frameId !== 0 && frame.parentFrameId === 0)), "Exact source frame"); assert.ok(item.sourceFrame.documentId);
    item.sourceHTML = one(server.stats(item.key).documents.filter(document => document.nonce === item.sourceBefore.sourceNonce), "Exact served source HTML");
    const bytes = Buffer.from(item.sourceHTML.base64, "base64"); assert.equal(bytes.length, item.sourceHTML.bytes); assert.equal(createHash("sha256").update(bytes).digest("hex"), item.sourceHTML.sha256); assert.ok(bytes.includes(Buffer.from(item.sourceBefore.sourceNonce))); assert.equal(item.sourceHTML.url, new URL(sourceURL).pathname + new URL(sourceURL).search);
    if (variant !== "root") {
      item.renderer = await evaluate("(async()=>({trace:__nativeAuxiliaryFrames.snapshot(),targets:await chrome.debugger.getTargets()}))()"); assert.equal(item.renderer.trace.overflow, false);
      item.rendererTarget = one(item.renderer.targets.filter(value => value.url === sourceURL && item.renderer.trace.rows.some(row => row.params.targetInfo.targetId === value.id && row.params.sessionId)), "Genuine original OOPIF target");
    }
    if (!waiter) await arm(); assertPopupSourcePlacement({ item, native: await inventory() }); item.focusBeforeInput = await readFocus(); assertPopupFocusUnchanged(item.focusAfterCreation, item.focusBeforeInput);
    await createdPageAction(deadline, options => target.locator("#open-child").click({ ...options, modifiers: ["Control"] }));
    const child = await createdPageAction(deadline, () => waiter.result()); item.childId = child.id;
    item.events = (await evaluate("__createdPageProvenance.snapshot()")).events; item.sourceAfter = await read(target, deadline); item.framesAfterClick = await frames(item.tabId);
    assert.equal(assertCreatedPageSource({ item, events: item.events, afterFrames: item.framesAfterClick, sourceState: item.sourceAfter }), item.childId);
    item.rootAfter = variant === "root" ? item.sourceAfter : await read(tab, deadline); assert.deepEqual(item.rootAfter.frameAdds, variant === "dynamic-oopif" ? [{ trusted: true, sequence: 1 }] : []);
    const native = await evaluate("__createdPageNativeControl.snapshot()"); item.childBirth = one(native.records.filter(row => row.kind === "event" && row.api === "tabs.onCreated" && row.args[0].id === item.childId), "Original native child birth").args[0];
    await wait(async () => { const values = await frames(item.childId); return values?.some(frame => frame.frameId === 0 && frame.url === item.childURL && frame.documentId); }, deadline, "Original child commit");
    item.afterCollect = await state(); assertPopupChildPlacement({ item, birth: item.childBirth, native: item.afterCollect.native });
    item.childOwnership = one(item.afterCollect.ownership.filter(value => value.tabId === item.childId), "Original child authority"); assert.equal(item.childOwnership.owner.kind, "created-page"); assert.equal(item.childOwnership.owner.origin, "user"); sameScope(item.childOwnership.owner, item.scope);
    assert.equal(item.afterCollect.native.targets.some(value => value.tabId === item.childId && value.attached), false);
    item.foreignDenied = await requireNativeCreatedPageRejection(() => foreign.client.request("attach", { tabId: item.childId }, { timeoutMs: 2000 }), denied);
    item.childBefore = await read(child, deadline); item.childFrame = one((await frames(item.childId)).filter(frame => frame.frameId === 0), "Original child document");
    await createdPageAction(deadline, options => child.getByLabel("Source key", { exact: true }).fill(item.key, options));
    await createdPageAction(deadline, options => child.getByLabel("Owner", { exact: true }).fill(item.owner, options));
    await createdPageAction(deadline, options => child.locator("#commit").click(options));
    item.receipt = await read(child, deadline, "#result"); item.childAfter = await read(child, deadline); item.childFramesAfter = await frames(item.childId);
    item.originalChild = one(server.allStats().children.filter(value => value.nonce === item.childBefore.documentNonce), "Original server child");
    item.business = assertCreatedPageReceipt({ item, child: item.originalChild, state: item.childAfter, receipt: item.receipt, frames: item.childFramesAfter });
    await createdPageAction(deadline, () => waiter.cancel()); cancelled = true;
    assert.deepEqual(one((await state()).ownership.filter(value => value.tabId === item.childId), "Delivered cancel retains membership").owner, item.childOwnership.owner);
    item.sourceDocuments = server.stats(item.key).documents; item.serverChildrenAtBusiness = server.allStats().children.length;
    item.workflow.completedAt = Date.now(); assert.ok(performance.now() < deadline);
    detail.frames = await stop("__nativeAuxiliaryFrames"); detail.adoption = await stop("__createdPageAdoption"); detail.provenance = await stop("__createdPageProvenance"); detail.nativeControl = await stop("__createdPageNativeControl");
    detail.adoptionChecks = assertPopupAdoption({ snapshot: detail.adoption, items: [item] }); detail.nativeChecks = assertPopupNativeControl({ snapshot: detail.nativeControl, items: [item] });
    detail.before = await identity(); detail.focusBeforeFinalize = await readFocus(); assertPopupFocusUnchanged(item.focusBeforeInput, detail.focusBeforeFinalize);
    detail.gateInstalled = await evaluate(`(${installAuxiliaryDeliveryGate.toString()})(__integrationBackend,chrome,globalThis,${JSON.stringify({ scope: item.scope, tabIds: [item.tabId, item.childId], stage: phase, ...(phase === "claim-delete" ? { gateTabId: item.tabId } : {}), holdTimeoutMs: 20000 })})`); gateInstalled = true;
    item.keep = [item.tabId, item.childId].map(tabId => ({ tabId, status: "deliverable" })); detail.finalizeSubmittedAt = Date.now(); const finalizeDeadline = performance.now() + 20000;
    pending = browser.client.request("finalizeTabs", { keep: item.keep }, { timeoutMs: 20000 }).then(value => { detail.finalizeOutcome = { fulfilled: true, value, settledAt: Date.now() }; }, error => { detail.finalizeOutcome = { fulfilled: false, error: errorText(error), settledAt: Date.now() }; });
    detail.heldGate = await wait(async () => { const value = await evaluate("__auxiliaryDeliveryGate.snapshot()"); assert.equal(value.overflow, false); assert.deepEqual(value.errors, []); return value.gate?.held && value; }, performance.now() + 5000, "Original native storage ACK hold");
    detail.heldState = await state(); assertInterruptedDeliveryHeld({ snapshot: detail.heldGate, item, phase, state: detail.heldState }); assert.equal(detail.finalizeOutcome, undefined);
    await saveDetail(detail);
    assert.ok(Date.now() < detail.finalizeSubmittedAt + 15000, "Interruption needs at least 5s of the original request deadline");
    detail.beforeInterruptionGate = await evaluate("__auxiliaryDeliveryGate.snapshot()");
    assertInterruptedDeliveryHeld({ snapshot: detail.beforeInterruptionGate, item, phase, state: detail.heldState });
    if (interruption === "host-loss") {
      detail.termination = await terminateHost({ detail, item });
      detail.afterExitGate = await evaluate("__auxiliaryDeliveryGate.snapshot()");
      detail.interruptionTiming = assertInterruptedDeliveryTiming({ submittedAt: detail.finalizeSubmittedAt, interruption, evidence: detail.termination, held: detail.afterExitGate, before: detail.before });
      detail.disconnectObserved = await wait(() => evaluate("__integrationBackend.nativeRecovery?{pending:__integrationBackend.nativeRecovery.pending,error:__integrationBackend.nativeRecovery.error?String(__integrationBackend.nativeRecovery.error):null}:null"), performance.now() + 5000, "Actual native disconnect began");
      detail.gateReleased = await evaluate("__auxiliaryDeliveryGate.release()");
      detail.reconnection = await reconnectHost(detail.termination.previous, { detail, item });
      await wait(async () => { const value = await evaluate("__auxiliaryDeliveryGate.snapshot()"); assert.deepEqual(value.errors, []); return value.gate?.published && !value.pendingOperations.length && value; }, performance.now() + 10000, "Original storage publication settled");
    } else {
      detail.restart = await restartWorker({ detail, item, deadline: finalizeDeadline }); workerReplaced = true; gateInstalled = false;
      detail.interruptionTiming = assertInterruptedDeliveryTiming({ submittedAt: detail.finalizeSubmittedAt, interruption, evidence: detail.restart, held: detail.beforeInterruptionGate, before: detail.before });
      assert.equal(await evaluate("Object.hasOwn(globalThis,'__auxiliaryDeliveryGate')"), false, "Replacement worker cannot retain original gate");
      detail.destroyedGate = { originalHeldSnapshot: true, restored: false, reason: "Original worker destroyed; no old publication or restoration ACK claimed" };
    }
    detail.after = await identity(); assertInterruptedDeliveryRuntime(detail.before, detail.after, interruption);
    fresh = await connect(item.scope.session_id); clients.push(fresh); await fresh.client.getInfo(); await fresh.client.beginTurn("interrupted-delivery-inspection"); item.freshScope = scopeOf(fresh); assert.ok(item.freshScope.control_epoch > item.scope.control_epoch);
    freshForeign = await connect(`native-delivery-inspection-foreign-${phase}-${interruption}-${variant}`); clients.push(freshForeign); await freshForeign.client.getInfo(); await freshForeign.client.beginTurn();
    detail.afterRecovery = await state(); const expected = assertInterruptedDeliveryState({ item, phase, interruption, state: detail.afterRecovery, held: detail.heldState });
    while (Date.now() < detail.finalizeSubmittedAt + 20250) await delay(Math.min(100, detail.finalizeSubmittedAt + 20250 - Date.now()));
    await pending; detail.observedThrough = Date.now(); assertInterruptedDeliveryOutcome({ submittedAt: detail.finalizeSubmittedAt, observedThrough: detail.observedThrough, outcome: detail.finalizeOutcome });
    detail.permissionChecksStartedAt = Date.now();
    detail.oldScopeDenied = [];
    for (const id of [item.tabId, item.childId]) detail.oldScopeDenied.push(await requireNativeCreatedPageRejection(() => fresh.client.request("attach", { tabId: id, ...item.scope }, { timeoutMs: 2000 }), /OBU_STALE_CONTROL_EPOCH|OBU_TURN_|OBU_CONTROL_/));
    detail.freshTabs = await fresh.getTabs(); assert.equal(detail.freshTabs.some(tab => tab.id === item.tabId), false); assert.equal(detail.freshTabs.some(tab => tab.id === item.childId), expected.retainedChild);
    detail.freshPermissions = []; detail.foreignPermissions = [];
    for (const id of [item.tabId, item.childId]) {
      detail.foreignPermissions.push(await requireNativeCreatedPageRejection(() => freshForeign.client.request("attach", { tabId: id }, { timeoutMs: 2000 }), denied));
      if (id === item.childId && expected.retainedChild) {
        const ack = await fresh.client.request("attach", { tabId: id }, { timeoutMs: 2000 }); await fresh.client.request("detach", { tabId: id }, { timeoutMs: 2000 });
        detail.freshPermissions.push({ tabId: id, retainedOriginalMembership: true, attach: ack, detached: true });
      } else detail.freshPermissions.push(await requireNativeCreatedPageRejection(() => fresh.client.request("attach", { tabId: id }, { timeoutMs: 2000 }), denied));
    }
    detail.finalState = await state(); assertInterruptedDeliveryState({ item, phase, interruption, state: detail.finalState, held: detail.heldState });
    detail.documents = { source: await readDocument(evaluate, item.tabId, item.sourceFrame), root: await readDocument(evaluate, item.tabId, item.rootFrame), child: await readDocument(evaluate, item.childId, item.childFrame), sourceFrames: await frames(item.tabId), childFrames: await frames(item.childId) };
    detail.businessAfter = assertInterruptedDeliveryDocuments({ item, observations: detail.documents, server: server.allStats() });
    detail.focusAfter = await readFocus(); assertPopupFocusUnchanged(item.focusBeforeInput, detail.focusAfter);
    if (gateInstalled) { detail.gateStopped = await evaluate("__auxiliaryDeliveryGate.stop()"); gateInstalled = false; assert.equal(detail.gateStopped.restored, true); assert.equal(detail.gateStopped.apiRemoved, true); assert.deepEqual(detail.gateStopped.errors, []); assert.deepEqual(detail.gateStopped.pendingOperations, []); }
    detail.acceptanceComplete = true; detail.recoveryVerified = true;
  } catch (error) { failure = error; detail.error = errorText(error); }
  finally {
    const cleanup = async (name, operation) => { const row = { name, startedAt: Date.now() }; detail.cleanup.push(row); try { row.result = await operation(); row.ok = true; } catch (error) { row.error = errorText(error); failure ??= error; } row.finishedAt = Date.now(); };
    if (gateInstalled && !workerReplaced) await cleanup("release-original-gate", async () => { await evaluate("__auxiliaryDeliveryGate.release()"); await wait(async () => { const value = await evaluate("__auxiliaryDeliveryGate.snapshot()"); return !value.pendingOperations.length && value; }, performance.now() + 10000, "Original gate cleanup publication"); const value = await evaluate("__auxiliaryDeliveryGate.stop()"); assert.equal(value.restored, true); assert.deepEqual(value.errors, []); return value; });
    if (waiter && !cancelled && !detail.finalizeSubmittedAt) await cleanup("cancel-pre-finalize-original-wait", () => waiter.cancel());
    // This explicit empty finalization is cleanup, never a retry of original keep.
    if (item.scope) await cleanup("explicit-fresh-cleanup-finalize-empty", async () => { if (!fresh) { fresh = await connect(item.scope.session_id); clients.push(fresh); await fresh.client.getInfo(); await fresh.client.beginTurn(); } return fresh.client.finalizeTabs([]); });
    if (freshForeign) await cleanup("explicit-foreign-cleanup-finalize-empty", () => freshForeign.client.finalizeTabs([]));
    if (installed.includes("__createdPageNativeControl")) await cleanup("capture-original-births", async () => { detail.cleanupBirths = await evaluate("__createdPageNativeControl.snapshot()"); return { records: detail.cleanupBirths.records.length }; });
    if (installed.includes("__createdPageProvenance")) await cleanup("capture-original-source-events", async () => { detail.cleanupProvenance = await evaluate("__createdPageProvenance.snapshot()"); return { events: detail.cleanupProvenance.events.length }; });
    for (const name of [...installed].reverse()) await cleanup("remove-original-observer-" + name, () => stop(name));
    const births = detail.cleanupBirths ?? detail.nativeControl, extra = (detail.cleanupProvenance ?? detail.provenance)?.events ?? [];
    const ids = [...new Set([item.tabId, item.childId, item.workTabId, ...extra.map(event => event.details.tabId)].filter(Number.isSafeInteger))];
    for (const id of ids) await cleanup("exact-original-tab-" + id, async () => {
      const birth = id === item.tabId ? item.createdTab : id === item.workTabId ? item.workBirth : one((births?.records ?? []).filter(row => row.kind === "event" && row.api === "tabs.onCreated" && row.args[0].id === id), "Cleanup requires original native child birth").args[0];
      assert.ok(Number.isSafeInteger(birth?.windowId)); const urls = id === item.tabId ? ["about:blank", item.sourceURL] : id === item.workTabId ? [item.workBirth.url] : ["about:blank", item.childURL];
      return evaluate(`(async()=>{let tab;try{tab=await chrome.tabs.get(${id})}catch(e){if(/No tab|Invalid tab/i.test(String(e)))return{alreadyClosed:true};throw e}if(tab.windowId!==${birth.windowId}||(!${JSON.stringify(urls)}.includes(tab.url)&&!${JSON.stringify(urls)}.includes(tab.pendingUrl)))throw Error('Original fixture identity changed before cleanup');await chrome.tabs.remove(${id});return{removed:tab}})()`);
    });
    if (ids.length) await cleanup("verify-original-tabs-and-markers-absent", () => wait(async () => { const value = await state(); assert.deepEqual(value.native.tabs.filter(tab => ids.includes(tab.id)), []); assert.deepEqual(value.native.targets.filter(target => ids.includes(target.tabId) && target.attached), []); if (item.sourceWindow) assert.equal(value.native.windows.some(win => win.id === item.sourceWindow.id), false); return ids.every(id => !value.delivery[id] && !value.storedDelivery[id]) && { absent: ids }; }, performance.now() + 5000, "Exact marker prune"));
    for (const client of clients) await cleanup("close-sdk-" + client.client.sessionId, () => client.close());
    detail.server = server.allStats(); detail.passed = !failure;
    try { await saveDetail(detail); } catch (error) { failure ??= error; detail.passed = false; }
  }
  if (failure) { failure.nativeAuxiliaryDeliveryDetail = detail; throw failure; }
  return detail;
}
