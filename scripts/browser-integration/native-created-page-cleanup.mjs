import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { installCreatedPageObserver, assertCreatedPageSource, createdPageAction } from "./created-page-provenance.mjs";
import { installCreatedPageAdoptionObserver, assertCreatedPageAdoption } from "./created-page-adoption-observer.mjs";
import { installCreatedPageNativeControlObserver } from "./created-page-native-control.mjs";
import { installCreatedPageCleanupFault } from "./created-page-cleanup-fault.mjs";
import { requireNativeCreatedPageRejection } from "./native-created-page-loss.mjs";

const scopeOf = browser => ({ session_id: browser.client.sessionId, turn_id: browser.client.turnId, control_epoch: browser.client.controlEpoch });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const errorText = error => error?.stack ?? String(error);
const quotaError = /quota|QUOTA_BYTES/i;

function terminalCode(change) {
  assert.ok(["source-navigation", "child-close"].includes(change));
  return change === "source-navigation" ? "OBU_PAGE_WAIT_SOURCE_CHANGED" : "OBU_PAGE_WAIT_EXPIRED";
}

// collect checks the original registry handle before session admission. While
// retained, an invalid record returns its original lifecycle error; after its
// bounded retention expires it returns EXPIRED. This differs from cancel/getTabs,
// which must reject the old control epoch after an explicit successful recovery.
export function requireCreatedPageCleanupCollectionRejection(operation, change) {
  const codes = [...new Set([terminalCode(change), "OBU_PAGE_WAIT_EXPIRED"])];
  return requireNativeCreatedPageRejection(operation, new RegExp(`^(?:Error: )?(?:${codes.join("|")}):`));
}

function assertFaultComplete(fault, item) {
  assert.equal(fault.waiterId, item.waiterId); assert.equal(fault.childId, item.childId); assert.equal(fault.claimId, item.adopted.owner.claimId);
  assert.deepEqual(fault.scope, { ...item.scope, tabId: item.tabId }); assert.equal(fault.incarnation, item.adopted.incarnation);
  assert.equal(fault.overflow, false); assert.deepEqual(fault.errors, []);
  assert.deepEqual(fault.pendingAttempts, []); assert.equal(fault.pendingCount, 0);
  assert.equal(fault.bytes, fault.records.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row)), 0));
  assert.ok(fault.records.length <= fault.maxRecords && fault.bytes <= fault.maxBytes);
  assert.ok(fault.quotaBytes > 0); assert.equal(fault.paddingBytes, fault.quotaBytes + 1024);
  assert.equal(fault.current.deadlineAt, item.matched.deadlineAt, "Original waiter deadline changed");
  assert.equal(fault.current.noReplacement, true); assert.equal(fault.current.sameIncarnation, true);
  assert.equal(fault.current.scopeIntact, true); assert.equal(fault.current.recordReplaced, false); assert.equal(fault.current.claimReplaced, false);
  for (const [index, row] of fault.records.entries()) {
    assert.equal(row.sequence, index + 1); assert.equal(row.state.deadlineAt, item.matched.deadlineAt);
    assert.equal(row.state.noReplacement, true);
  }
}

export function assertCreatedPageCleanupFailure({ fault, ownership, item, timely = false }) {
  assertFaultComplete(fault, item);
  assert.equal(ownership.incarnation, item.adopted.incarnation);
  const current = fault.current;
  assert.equal(fault.enabled, true); assert.equal(current.invalid, true); assert.equal(current.delivered, false);
  assert.equal(current.state, "failed"); assert.equal(current.recordPresent, true);
  assert.equal(current.cleaned, false); assert.equal(current.cleanupSettled, true); assert.match(current.cleanupError, quotaError);
  assert.equal(current.reverseLocked, true); assert.equal(current.claimPresent, true); assert.equal(current.claimPhase, "quarantined");
  assert.equal(ownership.owner, null); assert.equal(ownership.entry.phase, "quarantined");
  for (const claim of [ownership.entry, ...ownership.stored]) {
    for (const key of ["claimId", "tabId", "windowId", "session_id", "turn_id", "control_epoch", "origin", "kind"])
      assert.equal(claim[key], item.adopted.owner[key], `Original durable claim changed ${key}`);
  }
  assert.equal(ownership.stored.length, 1, "Original claim disappeared despite native quota rejection");
  assert.deepEqual(ownership.testStorage, {}, "Oversized test key unexpectedly persisted");
  const calls = fault.records.filter(row => row.kind === "call");
  assert.ok(calls.length > 0, "No actual targeted deletion attempted");
  for (const call of calls) {
    const result = fault.records.filter(row => row.attemptId === call.attemptId && row.kind !== "call");
    assert.equal(result.length, 1); assert.equal(result[0].kind, "rejected", "Fault must be a rejected native Promise");
    assert.match(result[0].error.message, quotaError); assert.ok(result[0].sequence > call.sequence);
    assert.equal(call.injected, true); assert.equal(result[0].injected, true);
    assert.equal(call.args.omittedChildId, item.childId); assert.equal(call.args.omittedClaimId, item.adopted.owner.claimId);
    assert.equal(call.args.paddingKey, fault.testKey); assert.equal(call.args.paddingBytes, fault.paddingBytes);
  }
  if (timely) {
    assert.ok(current.remainingMs > 0, "Initial cleanup failure was observed after original deadline");
    assert.ok(calls[0].state.remainingMs > 0); assert.ok(fault.records.find(row => row.kind === "rejected").state.remainingMs > 0);
  }
  return { attempts: calls.length, cleanupAttempts: current.cleanupAttempts, deadlineAt: current.deadlineAt, remainingMs: current.remainingMs };
}

export function assertCreatedPageCleanupDocuments({ item, change, ownership, sourceFrames, childFrames, tabs }) {
  for (const key of ["id", "windowId", "groupId", "pinned"])
    assert.equal(ownership.source[key], item.createdTab[key], `Source native ${key} changed`);
  const source = sourceFrames.filter(frame => frame.frameId === 0); assert.equal(source.length, 1);
  const expectedSource = change === "source-navigation" ? item.replacementSourceFrame : item.sourceFrame;
  assert.ok(expectedSource.documentId); assert.equal(source[0].documentId, expectedSource.documentId, "Source document replaced unexpectedly");
  assert.equal(source[0].url, expectedSource.url); assert.equal(ownership.source.url, expectedSource.url);
  if (change === "source-navigation") {
    assert.notEqual(expectedSource.documentId, item.sourceFrame.documentId, "Source navigation never committed a new document");
    assert.equal(expectedSource.url, item.replacementSourceURL);
    assert.ok(ownership.tab, "Original child disappeared");
    for (const key of ["id", "windowId", "groupId", "pinned", "url"])
      assert.equal(ownership.tab[key], item.adopted.tab[key], `Original child native ${key} changed`);
    const children = childFrames.filter(frame => frame.frameId === 0); assert.equal(children.length, 1);
    assert.equal(children[0].documentId, item.childFrame.documentId, "Original child document replaced");
    assert.equal(children[0].url, item.childFrame.url);
  } else {
    assert.equal(change, "child-close"); assert.equal(ownership.tab, null, "Closed original child reappeared");
    assert.equal(childFrames, null); assert.equal(ownership.targets.some(target => target.tabId === item.childId), false);
  }
  assert.equal(ownership.targets.some(target => target.tabId === item.childId && target.attached), false);
  if (tabs) {
    assert.equal(tabs.some(tab => tab.id === item.childId), false, "Original child authority inherited by fresh scope");
    assert.equal(tabs.filter(tab => tab.id === item.tabId).length, 1);
  }
}

export function assertCreatedPageCleanupRecovered({ item, fault, ownership, ...documents }) {
  assertFaultComplete(fault, item);
  assert.equal(ownership.incarnation, item.adopted.incarnation);
  assert.equal(fault.enabled, false); assert.equal(fault.current.invalid, true); assert.equal(fault.current.delivered, false);
  assert.equal(fault.current.cleaned, true); assert.equal(fault.current.cleanupSettled, true); assert.equal(fault.current.cleanupError, null);
  assert.ok(fault.current.cleanupAttempts > item.failedCleanupAttempts, "Public recovery did not retry original cleanup");
  assert.equal(fault.current.reverseLocked, false); assert.equal(fault.current.claimPresent, false);
  assert.equal(ownership.entry, null); assert.equal(ownership.owner, null); assert.deepEqual(ownership.stored, []);
  assert.deepEqual(ownership.testStorage, {});
  const calls = fault.records.filter(row => row.kind === "call"), successes = [];
  for (const call of calls) {
    assert.equal(call.args.omittedChildId, item.childId); assert.equal(call.args.omittedClaimId, item.adopted.owner.claimId);
    const results = fault.records.filter(row => row.attemptId === call.attemptId && row.kind !== "call");
    assert.equal(results.length, 1); const result = results[0]; assert.ok(call.sequence < result.sequence);
    assert.equal(result.injected, call.injected);
    if (call.injected) { assert.equal(result.kind, "rejected"); assert.match(result.error.message, quotaError); }
    else { assert.equal(result.kind, "fulfilled", "Actual recovery deletion lacked native success ACK"); successes.push(result); }
  }
  assert.equal(successes.length, 1, "One actual successful deletion after disabling quota fault");
  assert.ok(successes[0].sequence > Math.max(...fault.records.filter(row => row.injected).map(row => row.sequence)));
  assertCreatedPageCleanupDocuments({ item, ownership, ...documents });
}

export function assertCreatedPageCleanupIdentity(before, after) {
  for (const key of ["browserPid", "browserId", "extensionId", "extensionInstanceId", "workerTarget", "contextId", "incarnation", "observerTarget"])
    assert.equal(after[key], before[key], `Cleanup recovery changed ${key}`);
  assert.equal(after.lifecycle.bootId, before.lifecycle.bootId);
  for (const key of ["pid", "socketPath", "startedAt"]) assert.equal(after.host[key], before.host[key], `Cleanup recovery replaced native host ${key}`);
  for (const identity of [before, after]) {
    const native = identity.hostProcess; assert.ok(native?.process && native.ancestry?.length, "Missing live native process identity");
    assert.equal(native.process.ProcessId, identity.host.pid); assert.deepEqual(native.ancestry[0], native.process);
    assert.equal(native.ancestry.at(-1).ProcessId, identity.browserPid, "Native process is not descended from this browser");
    for (const process of native.ancestry) {
      assert.ok(Number.isSafeInteger(process.ProcessId) && process.ProcessId > 0);
      assert.ok(typeof process.ExecutablePath === "string" && process.ExecutablePath);
      assert.ok(typeof process.CreationDate === "string" && process.CreationDate);
    }
    for (let index = 1; index < native.ancestry.length; index++) assert.equal(native.ancestry[index - 1].ParentProcessId, native.ancestry[index].ProcessId);
  }
  assert.deepEqual(after.hostProcess, before.hostProcess, "Live native process or browser ancestry changed");
}

export function assertCreatedPageCleanupNoReplay(nativeControl, item) {
  assert.equal(nativeControl.overflow, false); assert.deepEqual(nativeControl.errors, []); assert.deepEqual(nativeControl.pendingOperations, []);
  const marks = nativeControl.records.filter(row => row.kind === "mark" && row.label === "created-page-cleanup-trigger");
  assert.equal(marks.length, 1); const trigger = marks[0];
  assert.deepEqual(nativeControl.records.filter(row => row.kind === "call" && row.sequence > trigger.sequence && row.api === "debugger.sendCommand" && /^Input\./.test(row.args?.[1])), [], "Recovery replayed input");
  assert.deepEqual(nativeControl.records.filter(row => row.kind === "call" && row.api === "debugger.attach" && row.args?.[0]?.tabId === item.childId), [], "Original child attached");
  assert.deepEqual(nativeControl.records.filter(row => row.kind === "call" && row.api === "debugger.sendCommand" && row.args?.[0]?.tabId === item.childId && /^(Input\.|Runtime\.(evaluate|callFunctionOn)$)/.test(row.args?.[1])), [], "Original child DOM/input accessed");
}

// One real-worker scenario per launcher run. The external fixture transition
// and targeted API-argument fault are deliberate; Chrome supplies the actual
// quota rejection. Focus remains raw evidence for the launcher's strict gate.
export async function checkNativeCreatedPageCleanup({ connect, worker, fixtureURL, server, detail = {}, recorderFor, identity,
  readFocus, popupControl, saveDetail = async () => {}, change, recovery }) {
  assert.ok(["source-navigation", "child-close"].includes(change)); assert.ok(["session-bootstrap", "retry-pause"].includes(recovery));
  const evaluate = expression => worker.evaluate(expression), frames = tabId => evaluate(`chrome.webNavigation.getAllFrames({tabId:${tabId}})`);
  const item = detail.item = {}, installed = new Set(); let browser, failure, popupUsed = false;
  Object.assign(detail, { change, recovery, recoveryVerified: false, startedAt: Date.now(), cleanup: [],
    boundary: "One public backgroundWindow root source and its natural trusted Control-click child, matched and undelivered. Real external fixture navigation or exact child close; targeted oversized storage argument causes real Chrome quota rejection. Public turnEnded/beginTurn or real popup Pause/Retry Pause/resume recovers the same original failed cleanup. No host/worker replacement, deadline extension, child collection/DOM read/attachment/input, replay or focus allowance. Recovery verification is separate from the launcher's strict focus result." });
  const wait = async (operation, deadline, message) => {
    while (true) { const value = await createdPageAction(deadline, operation); if (value) return value; assert.ok(performance.now() < deadline, message); await delay(20); }
  };
  const read = (tab, deadline) => wait(async options => {
    const value = await tab.locator("#state").textContent(options); assert.ok(typeof value === "string" && Buffer.byteLength(value) <= 65536);
    return value ? JSON.parse(value) : null;
  }, deadline, "Source state not ready");
  const originalRecord = () => evaluate(`(()=>{const b=__integrationBackend,r=b.pageWaits.records.get(${JSON.stringify(item.waiterId)});return r?{state:r.state,invalid:Boolean(r.invalid),delivered:Boolean(r.delivered),remainingMs:r.deadlineAt-b.pageWaits.now(),deadlineAt:r.deadlineAt,error:r.error?String(r.error):null,result:r.result??null}:null})()`);
  const ownership = () => evaluate(`(async()=>{const b=__integrationBackend;let tab;try{tab=await chrome.tabs.get(${item.childId})}catch(e){if(!/No tab|Invalid tab/i.test(String(e)))throw e;tab=null}const stored=await chrome.storage.session.get(['OPEN_BROWSER_USE_AUXILIARY_TABS',${JSON.stringify(item.testKey)}]);return{source:await chrome.tabs.get(${item.tabId}),tab,entry:b.auxiliaryTabs.entry(${item.childId})??null,owner:b.auxiliaryTabs.owner(${item.childId})??null,stored:(stored.OPEN_BROWSER_USE_AUXILIARY_TABS?.records??[]).filter(r=>r.tabId===${item.childId}),incarnation:stored.OPEN_BROWSER_USE_AUXILIARY_TABS?.incarnation??null,testStorage:Object.hasOwn(stored,${JSON.stringify(item.testKey)})?{unexpectedKey:true}:{},targets:await chrome.debugger.getTargets(),control:b.controlLedger.records.get(${JSON.stringify(item.scope?.session_id)})??null,automation:b.automationControl.status()}})()`);
  const faultSnapshot = () => evaluate("__createdPageCleanupFault.snapshot()");
  const documents = async () => ({ ownership: await ownership(), sourceFrames: await frames(item.tabId), childFrames: change === "child-close" ? null : await frames(item.childId) });
  const popup = async (action, state, deadline = performance.now() + 10000) => {
    const timeoutMs = Math.floor(deadline - performance.now()); assert.ok(timeoutMs > 0, "Popup action exhausted recovery budget before dispatch");
    popupUsed = true; return popupControl({ action, timeoutMs, ...(state ? { state } : {}) });
  };
  const reject = requireNativeCreatedPageRejection;
  try {
    browser = await connect(`native-cleanup-${change}-${recovery}`); await browser.client.getInfo(); await browser.client.beginTurn("native-created-page-cleanup");
    item.scope = scopeOf(browser); item.testKey = `__OBU_TEST_CLEANUP_QUOTA_${randomUUID()}`;
    for (const [name, expression] of [
      ["nativeControl", `(${installCreatedPageNativeControlObserver.toString()})(chrome,globalThis)`],
      ["provenance", `(${installCreatedPageObserver.toString()})(chrome,globalThis)`],
      ["adoption", `(${installCreatedPageAdoptionObserver.toString()})(__integrationBackend,chrome,globalThis,${JSON.stringify({ sessions: [item.scope.session_id] })})`],
    ]) { installed.add(name); detail[`${name}Observer`] = await evaluate(expression); }
    const fixture = server.createCase({ owner: `native-cleanup-${change}-${recovery}`, variant: "root" }), recorder = recorderFor(browser), tab = await recorder.createTab();
    Object.assign(item, { variant: "root", key: fixture.key, owner: fixture.owner, tabId: tab.id, backgroundWindows: recorder.records,
      sourceURL: new URL(fixture.urlPath, fixtureURL).href, childURL: new URL("/created-page/child", fixtureURL).href });
    item.createdTab = await evaluate(`chrome.tabs.get(${tab.id})`); assert.equal(item.createdTab.groupId, -1);
    item.sourceClaim = await evaluate(`__integrationBackend.auxiliaryTabs.owner(${tab.id})`);
    assert.equal(item.sourceClaim.kind, "background-window"); assert.equal(item.sourceClaim.origin, "agent");
    item.observerReady = await evaluate(`__createdPageProvenance.register(${tab.id})`); await browser.cdp.navigate(tab.id, item.sourceURL);
    const deadline = performance.now() + 20000; detail.originalBudget = { startedAt: Date.now(), budgetMs: 20000 };
    item.sourceBefore = await read(tab, deadline); assert.deepEqual(item.sourceBefore.clicks, []); assert.deepEqual(item.sourceBefore.frameAdds, []);
    item.framesBefore = await frames(tab.id); item.sourceFrame = item.framesBefore.find(frame => frame.frameId === 0);
    assert.equal(item.sourceFrame.url, item.sourceURL); assert.ok(item.sourceFrame.documentId);
    item.sourceHTML = server.stats(item.key).documents.filter(document => document.nonce === item.sourceBefore.sourceNonce);
    assert.equal(item.sourceHTML.length, 1); verifyHTML(item.sourceHTML[0], item.sourceBefore.sourceNonce);
    const waiter = await createdPageAction(deadline, () => tab.expectPage({ timeoutMs: Math.floor(deadline - performance.now()) })); item.waiterId = waiter.waiterId;
    await createdPageAction(deadline, options => tab.locator("#open-child").click({ ...options, modifiers: ["Control"] }));
    item.matched = await wait(async () => { const value = await originalRecord(); assert.ok(value); assert.equal(value.invalid, false, value.error ?? "Waiter invalidated"); return value.state === "matched" ? value : null; }, deadline, "Original child did not match");
    assert.equal(item.matched.delivered, false); item.childId = item.matched.result.tabId;
    item.sourceAfter = await read(tab, deadline); item.events = (await evaluate("__createdPageProvenance.snapshot()")).events;
    assert.equal(assertCreatedPageSource({ item, events: item.events, afterFrames: await frames(tab.id), sourceState: item.sourceAfter }), item.childId);
    item.adopted = await ownership(); assert.equal(item.adopted.tab.active, false); assert.equal(item.adopted.tab.groupId, -1);
    assert.equal(item.adopted.tab.windowId, item.createdTab.windowId); assert.equal(item.adopted.owner.kind, "created-page"); assert.equal(item.adopted.owner.origin, "user");
    assert.deepEqual(item.adopted.entry, item.adopted.owner); assert.deepEqual(item.adopted.stored, [item.adopted.owner]);
    assert.equal(item.adopted.targets.some(target => target.tabId === item.childId && target.attached), false);
    item.childFrames = await wait(async () => { const value = await frames(item.childId); return value.some(frame => frame.frameId === 0 && frame.url === item.childURL && frame.documentId) ? value : null; }, deadline, "Original child document did not commit");
    item.childFrame = item.childFrames.find(frame => frame.frameId === 0);
    detail.before = await identity(); detail.focusBeforeChange = await readFocus(); detail.preChange = await originalRecord();
    assert.equal(detail.preChange.state, "matched"); assert.equal(detail.preChange.invalid, false); assert.equal(detail.preChange.delivered, false); assert.ok(detail.preChange.remainingMs >= 5000);
    detail.testKeyPrecheck = await evaluate(`chrome.storage.session.get(${JSON.stringify(item.testKey)})`); assert.deepEqual(detail.testKeyPrecheck, {});
    installed.add("fault"); detail.faultObserver = await evaluate(`(${installCreatedPageCleanupFault.toString()})(__integrationBackend,chrome,globalThis,${JSON.stringify({ waiterId: item.waiterId, childId: item.childId, claimId: item.adopted.owner.claimId, testKey: item.testKey })})`);
    detail.triggerMark = await evaluate(`__createdPageNativeControl.mark('created-page-cleanup-trigger',${JSON.stringify({ change, recovery, waiterId: item.waiterId, childId: item.childId })})`);
    if (change === "source-navigation") {
      const replacement = new URL(item.sourceURL); replacement.searchParams.set("cleanup-transition", randomUUID()); item.replacementSourceURL = replacement.href;
      detail.changeAck = await createdPageAction(deadline, () => evaluate(`chrome.tabs.update(${item.tabId},{url:${JSON.stringify(item.replacementSourceURL)}})`));
      item.replacementSourceFrame = await wait(async () => (await frames(item.tabId)).find(frame => frame.frameId === 0 && frame.url === item.replacementSourceURL && frame.documentId !== item.sourceFrame.documentId), deadline, "Real source navigation did not commit");
    } else detail.changeAck = await createdPageAction(deadline, () => evaluate(`(async()=>{await chrome.tabs.remove(${item.childId});return{removedTabId:${item.childId}}})()`));
    detail.initialFailure = await wait(async () => {
      const fault = await faultSnapshot(); assert.equal(fault.overflow, false); assert.deepEqual(fault.errors, []);
      return fault.current.cleanupSettled && fault.current.cleanupError && fault.pendingCount === 0 ? { fault, ...await documents() } : null;
    }, deadline, "Original cleanup did not fail before deadline");
    detail.initialFailure.record = await originalRecord();
    assert.match(detail.initialFailure.record.error, new RegExp(`^Error: ${terminalCode(change)}:`), "Original waiter failed for a different lifecycle reason");
    detail.initialFailure.checks = assertCreatedPageCleanupFailure({ item, ...detail.initialFailure, timely: true });
    assertCreatedPageCleanupDocuments({ item, change, ...detail.initialFailure });
    const recoveryDeadline = performance.now() + 30000; detail.recoveryBudget = { startedAt: Date.now(), budgetMs: 30000 };
    const oldParams = { ...item.scope, tabId: item.tabId, waiterId: item.waiterId };
    if (recovery === "session-bootstrap") {
      detail.publicFailure = await reject(() => browser.client.turnEnded(), /OBU_CONTROL_RELEASE_FAILED/);
      detail.oldScope = { tabs: await reject(() => browser.client.request("getTabs", item.scope), /OBU_STALE_CONTROL_EPOCH|OBU_CONTROL_ENDING/),
        cancel: await reject(() => browser.client.request("cancelPageWait", oldParams), /OBU_STALE_CONTROL_EPOCH|OBU_CONTROL_ENDING/) };
      detail.repeatedPublicFailure = await reject(() => browser.client.beginTurn(), /OBU_CONTROL_RELEASE_FAILED|OBU_CONTROL_ENDING|quota/i);
    } else {
      detail.publicFailure = await popup("pause", "error", recoveryDeadline); assertPauseFailure(detail.publicFailure);
      detail.oldScope = { tabs: await reject(() => browser.client.request("getTabs", item.scope), /OBU_AUTOMATION_PAUSED/),
        cancel: await reject(() => browser.client.request("cancelPageWait", oldParams), /OBU_AUTOMATION_PAUSED/) };
      detail.repeatedPublicFailure = await popup("retry", "error", recoveryDeadline); assertPauseFailure(detail.repeatedPublicFailure);
    }
    detail.persistentFailure = { fault: await faultSnapshot(), ...await documents() };
    detail.persistentFailure.checks = assertCreatedPageCleanupFailure({ item, ...detail.persistentFailure });
    assertCreatedPageCleanupDocuments({ item, change, ...detail.persistentFailure });
    assert.ok(detail.persistentFailure.fault.current.cleanupAttempts > detail.initialFailure.fault.current.cleanupAttempts, "Repeated public recovery never retried");
    if (recovery === "session-bootstrap") assert.equal(detail.persistentFailure.ownership.control.status, "closing");
    else { assert.equal(detail.persistentFailure.ownership.automation.inputBlocked, true); assert.equal(detail.persistentFailure.ownership.automation.cleanupComplete, false); }
    item.failedCleanupAttempts = detail.persistentFailure.fault.current.cleanupAttempts;
    await saveDetail(detail); detail.disabled = await evaluate("__createdPageCleanupFault.disable()"); assert.equal(detail.disabled.enabled, false);
    if (recovery === "retry-pause") {
      detail.retryPause = await popup("retry", "paused", recoveryDeadline); assert.equal(detail.retryPause.state, "paused"); assert.equal(detail.retryPause.inputBlocked, true); assert.equal(detail.retryPause.cleanupComplete, true);
      detail.resume = await popup("resume", "running", recoveryDeadline); assert.equal(detail.resume.state, "running"); assert.equal(detail.resume.inputBlocked, false);
    }
    detail.beginTurn = await createdPageAction(recoveryDeadline, () => browser.client.beginTurn()); item.recoveredScope = scopeOf(browser);
    assert.equal(item.recoveredScope.session_id, item.scope.session_id); assert.ok(item.recoveredScope.control_epoch > item.scope.control_epoch);
    assert.notEqual(item.recoveredScope.turn_id, item.scope.turn_id);
    detail.recovered = { fault: await faultSnapshot(), ...await documents(), tabs: await browser.getTabs() };
    assertCreatedPageCleanupRecovered({ item, change, ...detail.recovered });
    detail.recovered.oldScope = {
      tabs: await reject(() => browser.client.request("getTabs", item.scope), /OBU_STALE_CONTROL_EPOCH/),
      cancel: await reject(() => browser.client.request("cancelPageWait", oldParams), /OBU_STALE_CONTROL_EPOCH/),
      collect: await requireCreatedPageCleanupCollectionRejection(() => browser.client.request("collectPageWait", oldParams), change),
    };
    detail.recovered.attach = await reject(() => browser.client.request("attach", { tabId: item.childId }), /not part of browser session|No tab|OBU_AUXILIARY_/);
    detail.recovered.source = await read(browser.tab(item.tabId), recoveryDeadline);
    if (change === "child-close") assert.deepEqual(detail.recovered.source, item.sourceAfter);
    else {
      assert.notEqual(detail.recovered.source.sourceNonce, item.sourceBefore.sourceNonce); assert.notEqual(detail.recovered.source.documentToken, item.sourceBefore.documentToken);
      assert.deepEqual(detail.recovered.source.clicks, []); assert.deepEqual(detail.recovered.source.frameAdds, []);
      item.replacementSourceHTML = server.stats(item.key).documents.filter(document => document.nonce === detail.recovered.source.sourceNonce);
      assert.equal(item.replacementSourceHTML.length, 1); verifyHTML(item.replacementSourceHTML[0], detail.recovered.source.sourceNonce);
    }
    const rearmed = await createdPageAction(recoveryDeadline, options => browser.tab(item.tabId).expectPage(options));
    detail.recovered.rearmedWaiterId = rearmed.waiterId; assert.notEqual(rearmed.waiterId, item.waiterId);
    await createdPageAction(recoveryDeadline, () => rearmed.cancel()); detail.recovered.rearmedCancelled = true;
    detail.afterRearm = { fault: await faultSnapshot(), ...await documents(), tabs: await browser.getTabs() };
    assertCreatedPageCleanupRecovered({ item, change, ...detail.afterRearm });
    detail.after = await identity(); assertCreatedPageCleanupIdentity(detail.before, detail.after); detail.focusAfterRecovery = await readFocus();
  } catch (error) { failure = error; detail.error = errorText(error); }
  finally {
    const cleanup = async (name, operation) => {
      const record = { name, startedAt: Date.now() }; detail.cleanup.push(record);
      try { record.result = await operation(); record.ok = true; } catch (error) { record.error = errorText(error); failure ??= error; }
      finally { record.finishedAt = Date.now(); }
    };
    // Restore the topmost storage wrapper before stopping the adoption wrapper.
    if (installed.has("fault")) {
      await cleanup("fault-disable", () => evaluate("globalThis.__createdPageCleanupFault?.disable() ?? null"));
      await cleanup("fault-settled", () => wait(async () => { const value = await faultSnapshot(); return value.pendingCount === 0 ? value : null; }, performance.now() + 5000, "Actual storage call still pending"));
      await cleanup("fault-observer", async () => {
        detail.fault = await evaluate("globalThis.__createdPageCleanupFault?.stop() ?? null"); assert.ok(detail.fault);
        assert.equal(detail.fault.closed, true); assert.equal(detail.fault.restored, true); assert.equal(detail.fault.apiRemoved, true);
        assert.equal(detail.fault.overflow, false); assert.deepEqual(detail.fault.errors, []); assert.equal(detail.fault.pendingCount, 0);
        return { closed: true, restored: true, apiRemoved: true };
      });
    }
    if (browser && item.tabId !== undefined) await cleanup("formal-finalize", async () => {
      if (popupUsed) {
        detail.cleanupPopupStatus = await popup("status");
        if (detail.cleanupPopupStatus.state === "error") detail.cleanupPopupRetry = await popup("retry", "paused");
        if (["error", "paused"].includes(detail.cleanupPopupStatus.state)) detail.cleanupPopupResume = await popup("resume", "running");
      }
      await browser.client.beginTurn(); return browser.client.finalizeTabs([]);
    });
    if (popupUsed) await cleanup("popup-close", () => popup("close"));
    if (installed.has("adoption")) await cleanup("adoption-observer", async () => {
      detail.adoption = await evaluate("__createdPageAdoption.stop()");
      assert.equal(detail.adoption.closed, true); assert.equal(detail.adoption.restored, true); assert.equal(detail.adoption.overflow, false);
      assert.deepEqual(detail.adoption.errors, []); assert.deepEqual(detail.adoption.pendingOperations, []);
      if (item.childId !== undefined) detail.adoptionChecks = assertCreatedPageAdoption({ snapshot: detail.adoption, items: [{ ...item, sessionId: item.scope.session_id, turnId: item.scope.turn_id, controlEpoch: item.scope.control_epoch }] });
      return { closed: true, restored: true };
    });
    if (installed.has("provenance")) await cleanup("provenance-observer", async () => {
      detail.provenance = await evaluate("__createdPageProvenance.stop()"); assert.equal(detail.provenance.listenerPresent, false); assert.equal(detail.provenance.overflow, false);
      return { closed: true, listenerPresent: false };
    });
    const ids = [...new Set([item.tabId, item.childId, ...(detail.provenance?.events ?? []).map(event => event.details.tabId)].filter(Number.isSafeInteger))];
    for (const tabId of ids) await cleanup(`exact-tab-${tabId}`, () => evaluate(`(async()=>{let tab;try{tab=await chrome.tabs.get(${tabId})}catch(e){if(/No tab|Invalid tab/i.test(String(e)))return{alreadyClosed:true};throw e}const urls=${JSON.stringify([item.sourceURL, item.replacementSourceURL, item.childURL].filter(Boolean))};if(!urls.includes(tab.url)&&!urls.includes(tab.pendingUrl))throw Error('Fixture tab changed before cleanup');await chrome.tabs.remove(${tabId});return{removed:tab}})()`));
    if (ids.length) await cleanup("exact-tabs-absent", async () => {
      const value = await evaluate("(async()=>({tabs:await chrome.tabs.query({}),windows:await chrome.windows.getAll({}),targets:await chrome.debugger.getTargets()}))()");
      assert.deepEqual(value.tabs.filter(tab => ids.includes(tab.id)), []); assert.deepEqual(value.targets.filter(target => ids.includes(target.tabId) && target.attached), []);
      if (item.createdTab) assert.deepEqual(value.windows.filter(window => window.id === item.createdTab.windowId), []); return value;
    });
    if (item.testKey) await cleanup("quota-key-absent", async () => {
      const value = await evaluate(`chrome.storage.session.get(${JSON.stringify(item.testKey)})`);
      // If a browser accepted the oversized key, remove only this prechecked
      // private key, while retaining the failure and never deleting user data.
      if (Object.keys(value).length) await evaluate(`chrome.storage.session.remove(${JSON.stringify(item.testKey)})`);
      assert.deepEqual(value, {}, "Unexpected quota key persisted"); return { absent: true };
    });
    if (browser) await cleanup("close-sdk", () => browser.close());
    if (installed.has("nativeControl")) await cleanup("native-control-observer", async () => {
      detail.nativeControl = await evaluate("__createdPageNativeControl.stop()");
      assert.equal(detail.nativeControl.closed, true); assert.equal(detail.nativeControl.restored, true); assert.equal(detail.nativeControl.listenersRemoved, true);
      assert.equal(detail.nativeControl.overflow, false); assert.deepEqual(detail.nativeControl.errors, []); assert.deepEqual(detail.nativeControl.pendingOperations, []);
      if (detail.triggerMark) assertCreatedPageCleanupNoReplay(detail.nativeControl, item); return { closed: true, restored: true };
    });
    await cleanup("fixture-ledger", async () => {
      detail.server = server.allStats(); assert.equal(detail.server.overflow, false);
      assert.equal(detail.server.children.length, 1); assert.deepEqual(detail.server.children.flatMap(child => child.posts), []);
      assert.equal(detail.server.requests.filter(request => request.method !== "GET").length, 0);
      const child = detail.server.children[0]; assert.equal(child.get.status, 200); assert.equal(child.get.finished, true); assert.equal(child.get.aborted, false);
      assert.equal(child.get.url, "/created-page/child"); assert.deepEqual(child.html, child.get.response); verifyHTML(child.html, child.nonce); assert.equal(child.consumed, false);
      return { children: detail.server.children.length, posts: 0 };
    });
    detail.finishedAt = Date.now(); detail.recoveryVerified = !failure;
    try { await saveDetail(detail); } catch (error) { failure ??= error; detail.recoveryVerified = false; }
  }
  if (failure) { failure.nativeCreatedPageCleanupDetail = detail; throw failure; } return detail;
}

function verifyHTML(value, nonce) {
  const bytes = Buffer.from(value.base64, "base64"); assert.equal(bytes.length, value.bytes);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), value.sha256); assert.ok(bytes.includes(Buffer.from(nonce)));
}

function assertPauseFailure(status) {
  assert.equal(status.state, "error"); assert.equal(status.inputBlocked, true); assert.equal(status.cleanupComplete, false);
  assert.match(status.error, /OBU_AUTOMATION_PAUSE_FAILED|quota/i);
  assert.ok(status.context, "Pause failure lacks original popup context"); assert.ok(status.ui, "Pause failure lacks actual UI evidence");
}
