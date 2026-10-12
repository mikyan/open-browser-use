import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { installCreatedPageObserver, assertCreatedPageSource, assertCreatedPageReceipt, createdPageAction } from "./created-page-provenance.mjs";
import { installCreatedPageAdoptionObserver } from "./created-page-adoption-observer.mjs";
import { installCreatedPageNativeControlObserver } from "./created-page-native-control.mjs";
import { FocusLedger } from "./focus-ledger.mjs";

const errorText = error => error?.stack ?? String(error);
const scopeOf = browser => ({ session_id: browser.client.sessionId, turn_id: browser.client.turnId, control_epoch: browser.client.controlEpoch });
const denied = /not part of browser session|already part of browser session|OBU_AUXILIARY_/i;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const one = (values, message) => { assert.equal(values.length, 1, message); return values[0]; };
const protectedScope = value => ({ session_id: value?.session_id, turn_id: value?.turn_id, control_epoch: value?.control_epoch });

// This is a separate feasibility scene, not a replacement for the failed normal
// backgroundWindow scene. The source is genuinely user-origin via claimUserTab.
export function assertPopupSourcePlacement({ item, native }) {
  const normal = one(native.windows.filter(window => window.type === "normal"), "Exactly one pre-existing normal window");
  assert.equal(normal.id, item.destinationWindow.id); assert.equal(normal.focused, true);
  assert.notEqual(normal.state, "minimized");
  const sentinel = one(native.tabs.filter(tab => tab.windowId === normal.id && tab.active), "Original selected sentinel");
  for (const key of ["id", "windowId", "url", "groupId", "pinned"]) assert.equal(sentinel[key], item.sentinel[key], `Sentinel ${key} changed`);
  const source = one(native.tabs.filter(tab => tab.id === item.tabId), "Original popup source still exists");
  assert.equal(source.windowId, item.sourceWindow.id); assert.equal(source.groupId, -1);
  assert.equal(source.active, true); assert.equal(source.pinned, false);
  assert.ok(["about:blank", item.sourceURL].includes(source.url), "Source navigated away from original fixture");
  const popup = one(native.windows.filter(window => window.id === source.windowId), "Original source window exists");
  assert.equal(popup.type, "popup"); assert.equal(popup.focused, false); assert.notEqual(popup.state, "minimized");
  assert.deepEqual(native.tabs.filter(tab => tab.windowId === popup.id).map(tab => tab.id), [item.tabId], "Source popup keeps its sole original tab");
  return { source, destination: normal, sentinel };
}

export function assertPopupChildPlacement({ item, birth, native }) {
  assertPopupSourcePlacement({ item, native });
  assert.equal(birth.id, item.childId); assert.equal(birth.windowId, item.destinationWindow.id);
  assert.equal(birth.active, false); assert.equal(birth.groupId, -1); assert.equal(birth.pinned, false);
  const child = one(native.tabs.filter(tab => tab.id === item.childId), "Original native child still exists");
  for (const key of ["id", "windowId", "groupId", "pinned", "active"]) assert.equal(child[key], birth[key], `Child ${key} differs from its native birth`);
  assert.notEqual(child.windowId, item.sourceWindow.id); assert.equal(child.url, item.childURL);
  // openerTabId is evidence only. Native navigation source/frame is authoritative.
  return child;
}

export function assertPopupFocusUnchanged(before, after) {
  const ledger = new FocusLedger(); ledger.accept(before); ledger.accept(after);
  assert.deepEqual(after.events, before.events, "Popup-source workflow added activation or focus events");
}

export function assertPopupRetirement({ item, native, ownership, tabs }) {
  assertPopupChildPlacement({ item, birth: item.childBirth, native });
  for (const tabId of [item.tabId, item.childId]) {
    const state = one(ownership.filter(value => value.tabId === tabId), "Exact retired page ownership observation");
    assert.equal(state.entry, null); assert.equal(state.owner, null); assert.deepEqual(state.stored, []);
    assert.equal(tabs.some(tab => tab.id === tabId), false);
    assert.equal(native.targets.some(target => target.tabId === tabId && target.attached), false);
  }
}

export function assertPopupDelivery({ item, native, ownership, tabs, delivery, storedDelivery }) {
  assertPopupRetirement({ item, native, ownership, tabs });
  assert.ok(Number.isSafeInteger(item.workTabId));
  assert.ok(![item.tabId, item.childId, item.sentinel.id].includes(item.workTabId));
  assert.equal(native.tabs.some(tab => tab.id === item.workTabId), false, "Omitted agent work page was actually closed");
  for (const id of [item.tabId, item.childId]) {
    const tab = one(native.tabs.filter(tab => tab.id === id), "Exact delivered page"), marker = delivery[String(id)];
    for (const key of ["windowId", "groupId", "pinned"]) assert.equal(marker?.[key], tab[key], `Delivery marker preserves ${key}`);
    assert.equal(typeof marker.deliveryId, "string"); assert.ok(marker.deliveryId.length > 0);
    assert.ok(Number.isFinite(marker.deliveredAt) && marker.deliveredAt > 0);
    assert.deepEqual(storedDelivery[String(id)], marker, "Actual native storage contains the acknowledged marker");
  }
  assert.equal(delivery[String(item.workTabId)], undefined, "Closed work page is not a delivered result");
  assert.equal(storedDelivery[String(item.workTabId)], undefined);
}

export function assertPopupAdoption({ snapshot, items }) {
  assert.equal(snapshot.closed, true); assert.equal(snapshot.restored, true); assert.equal(snapshot.overflow, false);
  assert.deepEqual(snapshot.errors, []); assert.deepEqual(snapshot.pendingOperations, []);
  assert.deepEqual([...snapshot.sessions].sort(), items.map(item => item.scope.session_id).sort());
  assert.equal(snapshot.bytes, snapshot.records.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row)), 0));
  assert.equal(snapshot.records.filter(row => row.kind === "adoption-enter").length, items.length);
  for (const [index, row] of snapshot.records.entries()) assert.equal(row.sequence, index + 1);
  return items.map(item => {
    const enter = one(snapshot.records.filter(row => row.kind === "adoption-enter" && row.childId === item.childId), "One original child adoption");
    assert.deepEqual(protectedScope(enter.scope), item.scope); assert.equal(enter.scope.tabId, item.tabId);
    assert.equal(enter.event.sourceTabId, item.tabId); assert.equal(enter.event.tabId, item.childId);
    assert.equal(enter.event.sourceFrameId, item.sourceFrame.frameId); assert.equal(enter.event.url, item.childURL);
    assert.equal(enter.waiter.waiterId, item.waiterId); assert.equal(enter.waiter.params.tabId, item.tabId);
    assert.deepEqual(protectedScope(enter.waiter.params), item.scope);
    assert.deepEqual(enter.child, { entry: null, owner: null }, "Original native child had no prior auxiliary authority");
    assert.deepEqual(enter.source.entry, enter.source.owner);
    const source = enter.source.owner;
    assert.equal(source.kind, "popup"); assert.equal(source.origin, "user"); assert.equal(source.phase, "committed");
    assert.equal(source.tabId, item.tabId); assert.equal(source.windowId, item.sourceWindow.id); assert.deepEqual(protectedScope(source), item.scope);
    const rows = snapshot.records.filter(row => row.adoptionId === enter.adoptionId);
    const reserve = one(rows.filter(row => row.kind === "reserve-enter"), "One first native-child reservation");
    assert.deepEqual(reserve.before, { entry: null, owner: null }); assert.deepEqual(protectedScope(reserve.params), item.scope);
    assert.equal(reserve.params.tabId, item.childId);
    const reserved = one(rows.filter(row => row.operationId === reserve.operationId && row.kind === "reserve-return"), "Original reservation returned");
    assert.equal(reserved.result.origin, "user"); assert.equal(reserved.result.tabId, item.childId); assert.equal(reserved.result.phase, "reserved");
    const lookup = one(rows.filter(row => row.kind === "tabs-get-call").slice(0, 1), "Original native lookup");
    const lookedUp = one(rows.filter(row => row.operationId === lookup.operationId && row.kind === "tabs-get-fulfilled"), "Original native lookup ACK");
    assert.ok(enter.sequence < lookup.sequence && lookedUp.sequence < reserve.sequence);
    for (const key of ["id", "windowId", "groupId", "pinned", "active"]) assert.equal(lookedUp.result[key], item.childBirth[key]);
    const commit = one(rows.filter(row => row.kind === "commit-enter"), "One original child commit");
    assert.equal(commit.options.kind, "created-page"); assert.equal(commit.options.windowId, item.destinationWindow.id);
    assert.equal(commit.options.check, true); assert.equal(commit.options.validate, true);
    assert.equal(commit.options.control_epoch, item.scope.control_epoch); assert.deepEqual(commit.record, reserved.result);
    const committed = one(rows.filter(row => row.operationId === commit.operationId && row.kind === "commit-fulfilled"), "Original commit ACK");
    const adopted = one(rows.filter(row => row.operationId === enter.operationId && row.kind === "adoption-fulfilled"), "Original adoption ACK");
    assert.ok(reserved.sequence < commit.sequence && commit.sequence < committed.sequence && committed.sequence < adopted.sequence);
    const claim = committed.result;
    assert.equal(claim.kind, "created-page"); assert.equal(claim.origin, "user"); assert.equal(claim.phase, "committed");
    assert.equal(claim.tabId, item.childId); assert.equal(claim.windowId, item.destinationWindow.id);
    assert.equal(claim.claimId, reserved.result.claimId); assert.deepEqual(protectedScope(claim), item.scope);
    assert.deepEqual(committed.after, { entry: claim, owner: claim }); assert.deepEqual(adopted.after, committed.after);
    assert.deepEqual(adopted.result, { tabId: item.childId });
    for (const phase of ["pending", "committed"]) {
      assert.ok(snapshot.records.some(row => row.kind === "storage-set-call" && row.sequence > commit.sequence && row.sequence < committed.sequence &&
        row.value.records.some(value => value.tabId === item.childId && value.claimId === claim.claimId && value.phase === phase && value.windowId === item.destinationWindow.id) &&
        snapshot.records.some(ack => ack.operationId === row.operationId && ack.kind === "storage-set-fulfilled" && ack.sequence < committed.sequence)), `Actual ${phase} ownership write ACK`);
    }
    return { sourceTabId: item.tabId, childId: item.childId, claimId: claim.claimId, sourceWindowId: source.windowId, childWindowId: claim.windowId };
  });
}

export function assertPopupNativeControl({ snapshot, items }) {
  assert.equal(snapshot.closed, true); assert.equal(snapshot.restored, true); assert.equal(snapshot.listenersRemoved, true);
  assert.equal(snapshot.overflow, false); assert.deepEqual(snapshot.errors, []); assert.deepEqual(snapshot.pendingOperations, []);
  const calls = snapshot.records.filter(row => row.kind === "call");
  for (const call of calls) {
    one(snapshot.records.filter(row => row.operationId === call.operationId && ["fulfilled", "rejected", "threw"].includes(row.kind)), "Every actual native call has exactly one original outcome");
    assert.ok(!["tabs.create", "tabs.move", "tabs.group", "tabs.ungroup", "tabs.update", "windows.update"].includes(call.api), "No child creation, regrouping, movement or focus restoration");
    if (call.api === "debugger.sendCommand") assert.ok(!["Page.bringToFront", "Target.activateTarget"].includes(call.args[1]), "No native activation substitution");
  }
  assert.equal(calls.filter(row => row.api === "windows.create").length, items.length);
  for (const call of calls.filter(row => row.api === "windows.create")) { assert.equal(call.args[0].type, "popup"); assert.equal(call.args[0].focused, false); }
  for (const item of items) {
    const childBirth = one(snapshot.records.filter(row => row.kind === "event" && row.api === "tabs.onCreated" && row.args[0].id === item.childId), "One native child birth");
    assert.deepEqual(childBirth.args[0], item.childBirth);
    const inputs = calls.filter(row => row.api === "debugger.sendCommand" && row.args[0].tabId === item.tabId && row.args[1] === "Input.dispatchMouseEvent" && (row.args[2].modifiers & 2));
    for (const type of ["mousePressed", "mouseReleased"]) {
      const call = one(inputs.filter(row => row.args[2].type === type), `One original Control ${type}`);
      assert.equal(call.args[2].button, "left"); assert.equal(call.args[2].clickCount, 1);
      one(snapshot.records.filter(row => row.operationId === call.operationId && row.kind === "fulfilled"), `Original Control ${type} ACK`);
    }
  }
  return { calls: calls.length, rejected: snapshot.records.filter(row => ["rejected", "threw"].includes(row.kind)).length };
}

export async function checkCreatedPagePopupSource({ connectBrowser, getWorker, createPopup, readFocus, fixtureURL, server, deliverPages = false, saveDetail = async () => {}, detail = {} }) {
  const owners = [], sources = new Map(), waits = [], cancelled = new Set(), installed = []; let foreign, failure, scene;
  Object.assign(detail, { feasibilityOnly: true, deliverPages, workTabs: [], boundary: "Test-created unfocused popup source, publicly claimed as user-origin. One already-focused normal window; original trusted Control-click and native child only. This is not a public popup creation feature or a fix for backgroundWindow normal sources. No focus restoration, child substitution or regrouping. Document/frame continuity is observational. Delivery mode additionally prepares explicit public agent work tabs before the native-control observer; original popup/child input, delivery and cleanup remain observed.", cases: [], cleanup: [] });
  const evaluate = expression => getWorker().evaluate(expression);
  const inventory = () => evaluate("(async()=>({tabs:await chrome.tabs.query({}),windows:await chrome.windows.getAll({}),targets:await chrome.debugger.getTargets()}))()");
  const frames = id => evaluate(`chrome.webNavigation.getAllFrames({tabId:${id}})`);
  const ownership = ids => evaluate(`(async()=>{const b=__integrationBackend,s=(await chrome.storage.session.get('OPEN_BROWSER_USE_AUXILIARY_TABS')).OPEN_BROWSER_USE_AUXILIARY_TABS?.records??[];return ${JSON.stringify(ids)}.map(tabId=>({tabId,entry:b.auxiliaryTabs.entry(tabId)??null,owner:b.auxiliaryTabs.owner(tabId)??null,stored:s.filter(r=>r.tabId===tabId)}))})()`);
  const read = async (target, deadline, selector = "#state") => {
    for (;;) { const value = await createdPageAction(deadline, options => target.locator(selector).textContent(options)); assert.ok(typeof value === "string" && Buffer.byteLength(value) <= 65536); if (value) return JSON.parse(value); await delay(20); }
  };
  const reject = async (operation, pattern) => { let result; try { await operation(); } catch (error) { result = String(error); } assert.ok(result, "Expected refusal did not occur"); assert.match(result, pattern); return result; };
  const step = async (item, name, operation) => {
    const row = { name, startedAt: Date.now() }; (item.steps ??= []).push(row); item.stage = name;
    try { const result = await operation(); row.ok = true; return result; } catch (error) { row.error = errorText(error); throw error; } finally { row.finishedAt = Date.now(); }
  };
  try {
    for (const variant of ["root", "oopif", "dynamic-oopif"]) owners.push(await connectBrowser(`created-popup-${variant}`));
    foreign = await connectBrowser("created-popup-foreign");
    for (const [index, browser] of owners.entries()) {
      const info = await browser.client.getInfo();
      if (deliverPages) assert.equal(info.metadata?.auxiliaryDeliveryVersion, 1, "Public auxiliary delivery capability");
      await browser.client.beginTurn(`popup-${["root", "oopif", "dynamic-oopif"][index]}`);
      if (deliverPages) {
        const work = await browser.newTab();
        const native = one((await inventory()).tabs.filter(tab => tab.id === work.id), "Publicly created original agent work tab");
        assert.equal(native.active, false);
        const origin = await evaluate(`(async()=>{const s=await __integrationBackend.store.getSession(${JSON.stringify(browser.client.sessionId)});return s.tabOrigins[String(${work.id})]??__integrationBackend.auxiliaryTabs.owner(${work.id})?.origin})()`);
        assert.equal(origin, "agent");
        detail.workTabs.push({ sessionId: browser.client.sessionId, tabId: work.id, native, origin });
      }
    }
    detail.nativeControlObserver = await evaluate(`(${installCreatedPageNativeControlObserver.toString()})(chrome,globalThis)`); installed.push("nativeControl");
    detail.nativeObserver = await evaluate(`(${installCreatedPageObserver.toString()})(chrome,globalThis)`); installed.push("trace");
    detail.adoptionObserver = await evaluate(`(${installCreatedPageAdoptionObserver.toString()})(__integrationBackend,chrome,globalThis,${JSON.stringify({ sessions: owners.map(browser => browser.client.sessionId) })})`); installed.push("adoption");
    for (const [index, variant] of ["root", "oopif", "dynamic-oopif"].entries()) {
      const browser = owners[index], fixture = server.createCase({ owner: `popup-source-${variant}`, variant });
      const before = await inventory(), destinationWindow = one(before.windows.filter(window => window.type === "normal"), "Single normal window fixture");
      assert.equal(destinationWindow.focused, true); assert.notEqual(destinationWindow.state, "minimized");
      const sentinel = one(before.tabs.filter(tab => tab.windowId === destinationWindow.id && tab.active), "Original selected sentinel");
      const identity = { windowId: destinationWindow.id, sentinelId: sentinel.id, sentinelURL: sentinel.url, groupId: sentinel.groupId, pinned: sentinel.pinned };
      if (scene) assert.deepEqual(identity, scene, "All three cases keep the original already-focused normal window and sentinel"); else scene = detail.scene = identity;
      const win = await createPopup("about:blank"), original = one(win.tabs ?? [], "Popup creation returned its sole native source tab");
      const item = { variant, key: fixture.key, owner: fixture.owner, tabId: original.id, sourceWindow: win, createdTab: original, destinationWindow, sentinel,
        scope: scopeOf(browser), sourceURL: new URL(fixture.urlPath, fixtureURL).href, childURL: new URL("/created-page/child", fixtureURL).href };
      if (deliverPages) item.workTabId = detail.workTabs[index].tabId;
      sources.set(item.tabId, item); detail.cases.push(item);
      assert.equal(before.windows.some(window => window.id === win.id), false); assert.equal(win.type, "popup"); assert.equal(win.focused, false);
      item.focusAfterCreation = await readFocus();
      item.beforeClaim = await ownership([item.tabId]); assert.equal(item.beforeClaim[0].owner, null); assert.equal(item.beforeClaim[0].entry, null);
      item.claim = await browser.client.claimUserTab(item.tabId);
      item.sourceOwnership = (await ownership([item.tabId]))[0];
      assert.equal(item.sourceOwnership.owner.kind, "popup"); assert.equal(item.sourceOwnership.owner.origin, "user");
      assert.equal(item.sourceOwnership.owner.windowId, win.id); assert.deepEqual(protectedScope(item.sourceOwnership.owner), item.scope);
      item.observerReady = await evaluate(`__createdPageProvenance.register(${item.tabId})`);
      const tab = browser.tab(item.tabId); await browser.cdp.navigate(item.tabId, item.sourceURL);
      const deadline = performance.now() + 20000; item.workflow = { startedAt: Date.now(), timeoutMs: 20000 };
      item.rootBefore = await read(tab, deadline); assert.deepEqual(item.rootBefore.frameAdds, []);
      const arm = async () => {
        const timeoutMs = Math.floor(deadline - performance.now()); assert.ok(timeoutMs > 0);
        const waiter = await step(item, "ready", () => createdPageAction(deadline, () => tab.expectPage({ timeoutMs })));
        waits.push(waiter); item.waiterId = waiter.waiterId; item.ready = { timeoutMs, remainingMs: waiter.remainingMs, acknowledgedAt: Date.now() }; return waiter;
      };
      let waiter;
      if (variant === "dynamic-oopif") { waiter = await arm(); await step(item, "add-original-frame", () => createdPageAction(deadline, options => tab.locator("#add-frame").click(options))); }
      const target = variant === "root" ? tab : tab.frameLocator("#created-page-frame");
      item.sourceBefore = await read(target, deadline); assert.deepEqual(item.sourceBefore.clicks, []);
      item.framesBefore = await createdPageAction(deadline, () => frames(item.tabId));
      const sourceURL = variant === "root" ? item.sourceURL : new URL(`/created-page/frame?key=${encodeURIComponent(item.key)}`, fixtureURL.replace("127.0.0.1", "localhost")).href;
      item.sourceFrame = one(item.framesBefore.filter(frame => frame.url === sourceURL && (variant === "root" ? frame.frameId === 0 : frame.frameId !== 0 && frame.parentFrameId === 0)), "Exact original source frame");
      assert.ok(item.sourceFrame.documentId);
      item.sourceHTML = one(server.stats(item.key).documents.filter(document => document.nonce === item.sourceBefore.sourceNonce), "Original source HTML nonce");
      const bytes = Buffer.from(item.sourceHTML.base64, "base64"); assert.equal(bytes.length, item.sourceHTML.bytes); assert.equal(createHash("sha256").update(bytes).digest("hex"), item.sourceHTML.sha256);
      assert.ok(bytes.includes(Buffer.from(item.sourceBefore.sourceNonce))); assert.equal(item.sourceHTML.url, new URL(sourceURL).pathname + new URL(sourceURL).search);
      if (variant !== "root") {
        item.renderer = await createdPageAction(deadline, () => evaluate(`(async()=>({attachments:(globalThis.__integrationFrames??[]).filter(f=>f.tabId===${item.tabId}),targets:await chrome.debugger.getTargets()}))()`));
        item.rendererTarget = one(item.renderer.targets.filter(native => native.url === sourceURL && item.renderer.attachments.some(frame => frame.targetId === native.id && frame.type === "iframe" && frame.sessionId)), "Genuine original OOPIF renderer");
      }
      waiter ??= await arm();
      item.beforeInput = await createdPageAction(deadline, inventory); assertPopupSourcePlacement({ item, native: item.beforeInput });
      item.focusBeforeInput = await createdPageAction(deadline, readFocus);
      assertPopupFocusUnchanged(item.focusAfterCreation, item.focusBeforeInput);
      await step(item, "original-Control-click", () => createdPageAction(deadline, options => target.locator("#open-child").click({ ...options, modifiers: ["Control"] })));
      const child = await step(item, "collect-original-child", () => createdPageAction(deadline, () => waiter.result())); item.childId = child.id;
      item.events = (await createdPageAction(deadline, () => evaluate("__createdPageProvenance.snapshot()"))).events.filter(event => event.details.sourceTabId === item.tabId);
      item.sourceAfter = await read(target, deadline); item.framesAfterClick = await createdPageAction(deadline, () => frames(item.tabId));
      assert.equal(assertCreatedPageSource({ item, events: item.events, afterFrames: item.framesAfterClick, sourceState: item.sourceAfter }), item.childId);
      item.rootAfter = variant === "root" ? item.sourceAfter : await read(tab, deadline);
      assert.deepEqual(item.rootAfter.frameAdds, variant === "dynamic-oopif" ? [{ trusted: true, sequence: 1 }] : []);
      const trace = await createdPageAction(deadline, () => evaluate("__createdPageNativeControl.snapshot()")); assert.equal(trace.overflow, false);
      item.childBirth = one(trace.records.filter(row => row.kind === "event" && row.api === "tabs.onCreated" && row.args[0].id === item.childId), "Original native child birth record").args[0];
      // Native creation can precede the original document's navigation commit.
      for (;;) {
        item.childFramesAtCollection = await createdPageAction(deadline, () => frames(item.childId));
        if (item.childFramesAtCollection?.some(frame => frame.frameId === 0 && frame.url === item.childURL && frame.documentId)) break;
        await delay(20);
      }
      item.afterCollect = await createdPageAction(deadline, inventory); item.nativeChild = assertPopupChildPlacement({ item, birth: item.childBirth, native: item.afterCollect });
      item.childOwnership = (await createdPageAction(deadline, () => ownership([item.childId])))[0];
      assert.equal(item.childOwnership.owner.kind, "created-page"); assert.equal(item.childOwnership.owner.origin, "user"); assert.deepEqual(protectedScope(item.childOwnership.owner), item.scope);
      assert.equal(item.afterCollect.targets.some(native => native.tabId === item.childId && native.attached), false, "Adoption does not attach child");
      item.foreignAttach = await createdPageAction(deadline, options => reject(() => foreign.client.request("attach", { tabId: item.childId }, options), denied));
      item.childBefore = await read(child, deadline); item.childFramesBefore = await createdPageAction(deadline, () => frames(item.childId));
      item.childFrame = one(item.childFramesBefore.filter(frame => frame.frameId === 0), "Original child root document"); assert.ok(item.childFrame.documentId); assert.equal(item.childFrame.url, item.childURL);
      await step(item, "fill-key", () => createdPageAction(deadline, options => child.getByLabel("Source key", { exact: true }).fill(item.key, options)));
      await step(item, "fill-owner", () => createdPageAction(deadline, options => child.getByLabel("Owner", { exact: true }).fill(item.owner, options)));
      await step(item, "commit-original-child", () => createdPageAction(deadline, options => child.locator("#commit").click(options)));
      item.receipt = await read(child, deadline, "#result"); item.childAfter = await read(child, deadline); item.childFramesAfter = await createdPageAction(deadline, () => frames(item.childId));
      item.originalChild = one(server.allStats().children.filter(value => value.nonce === item.childBefore.documentNonce), "Exact served native child");
      item.business = assertCreatedPageReceipt({ item, child: item.originalChild, state: item.childAfter, receipt: item.receipt, frames: item.childFramesAfter });
      item.cancelDelivered = await step(item, "cancel-delivered-original-wait", () => createdPageAction(deadline, () => waiter.cancel())); cancelled.add(waiter.waiterId);
      item.afterDeliveredCancel = (await createdPageAction(deadline, () => ownership([item.childId])))[0];
      assert.deepEqual(item.afterDeliveredCancel.owner, item.childOwnership.owner, "Delivered cancellation retains the original child authority");
      assert.deepEqual(scopeOf(browser), item.scope); item.beforeFinalizeTabs = await createdPageAction(deadline, () => browser.getTabs());
      assert.ok(item.beforeFinalizeTabs.some(value => value.id === item.tabId)); assert.ok(item.beforeFinalizeTabs.some(value => value.id === item.childId));
      if (deliverPages) assert.ok(item.beforeFinalizeTabs.some(value => value.id === item.workTabId));
      item.afterBusiness = await createdPageAction(deadline, inventory); assertPopupChildPlacement({ item, birth: item.childBirth, native: item.afterBusiness });
      item.focusAfterBusiness = await createdPageAction(deadline, readFocus); assertPopupFocusUnchanged(item.focusBeforeInput, item.focusAfterBusiness);
      item.workflow.completedAt = Date.now(); assert.ok(performance.now() < deadline); item.businessComplete = true;
      item.keep = deliverPages ? [item.tabId, item.childId].map(tabId => ({ tabId, status: "deliverable" })) : [];
      item.finalizeAck = await step(item, "formal-finalize", () => browser.client.finalizeTabs(item.keep)); item.finalized = true;
      const retirementDeadline = performance.now() + 20000;
      item.retired = { native: await createdPageAction(retirementDeadline, inventory), ownership: await createdPageAction(retirementDeadline, () => ownership([item.tabId, item.childId])) };
      item.oldScopeDenied = await createdPageAction(retirementDeadline, options => reject(() => browser.client.request("attach", { tabId: item.childId, ...item.scope }, options), /OBU_CONTROL_|OBU_TURN_|stale|expired/i));
      await createdPageAction(retirementDeadline, () => browser.client.beginTurn()); item.freshScope = scopeOf(browser); assert.ok(item.freshScope.control_epoch > item.scope.control_epoch);
      item.retired.tabs = await createdPageAction(retirementDeadline, () => browser.getTabs()); assertPopupRetirement({ item, ...item.retired });
      if (deliverPages) {
        item.retired.delivery = await createdPageAction(retirementDeadline, () => evaluate("structuredClone(__integrationBackend.store.state.deliverableTabs??{})"));
        item.retired.storedDelivery = await createdPageAction(retirementDeadline, () => evaluate("chrome.storage.local.get('OPEN_BROWSER_USE_SESSION_STATE').then(value=>value.OPEN_BROWSER_USE_SESSION_STATE?.deliverableTabs??{})"));
        assertPopupDelivery({ item, ...item.retired });
        item.foreignDeniedAfterDelivery = [];
        for (const tabId of [item.tabId, item.childId]) item.foreignDeniedAfterDelivery.push(await createdPageAction(retirementDeadline, options => reject(() => foreign.client.request("attach", { tabId }, options), denied)));
      }
      item.retired.sourceFrames = await createdPageAction(retirementDeadline, () => frames(item.tabId)); item.retired.childFrames = await createdPageAction(retirementDeadline, () => frames(item.childId));
      assert.equal(item.retired.sourceFrames.find(frame => frame.frameId === item.sourceFrame.frameId)?.documentId, item.sourceFrame.documentId);
      assert.equal(item.retired.childFrames.find(frame => frame.frameId === 0)?.documentId, item.childFrame.documentId);
      item.freshDenied = [];
      for (const tabId of [item.tabId, item.childId]) item.freshDenied.push(await createdPageAction(retirementDeadline, options => reject(() => browser.client.request("attach", { tabId }, options), denied)));
      item.focusAfterFinalize = await readFocus(); assertPopupFocusUnchanged(item.focusBeforeInput, item.focusAfterFinalize); item.ok = true;
    }
    detail.server = server.allStats(); assert.equal(detail.server.overflow, false); assert.equal(detail.server.children.length, 3);
    assert.equal(detail.server.children.flatMap(child => child.posts).length, 3);
  } catch (error) { failure = error; detail.error = errorText(error); }
  finally {
    const cleanup = async (kind, identity, operation) => {
      const row = { kind, identity, startedAt: Date.now() }; detail.cleanup.push(row);
      try { row.result = await operation(); row.ok = true; } catch (error) { row.error = errorText(error); failure ??= error; }
      row.finishedAt = Date.now();
    };
    for (const waiter of waits.filter(value => !cancelled.has(value.waiterId))) await cleanup("cancel-original-wait", waiter.waiterId, () => waiter.cancel());
    for (const browser of [...owners, foreign].filter(Boolean)) await cleanup("formal-finalize", browser.client.sessionId, () => browser.client.finalizeTabs([]));
    if (installed.includes("trace")) await cleanup("capture-native-children", "trace", async () => { detail.trace = await evaluate("__createdPageProvenance.snapshot()"); assert.equal(detail.trace.overflow, false); });
    if (installed.includes("nativeControl")) await cleanup("capture-original-births", "nativeControl", async () => { detail.cleanupBirths = await evaluate("__createdPageNativeControl.snapshot()"); assert.equal(detail.cleanupBirths.overflow, false); });
    const ids = [...new Set([...sources.keys(), ...(detail.trace?.events ?? []).map(event => event.details.tabId)])];
    for (const tabId of ids) await cleanup("exact-fixture-tab", tabId, async () => {
      const source = sources.get(tabId), event = detail.trace?.events.find(event => event.details.tabId === tabId), parent = source ?? sources.get(event?.details.sourceTabId);
      assert.ok(parent, "Cleanup requires the exact created source or native child event");
      const birth = source ? source.createdTab : one((detail.cleanupBirths?.records ?? []).filter(row => row.kind === "event" && row.api === "tabs.onCreated" && row.args[0].id === tabId), "Cleanup requires exact native child birth").args[0];
      const windowId = birth.windowId; assert.ok(Number.isSafeInteger(windowId));
      if (!source) assert.equal(event.details.url, parent.childURL);
      const urls = source ? ["about:blank", source.sourceURL] : ["about:blank", parent.childURL];
      return evaluate(`(async()=>{let tab;try{tab=await chrome.tabs.get(${tabId})}catch(e){if(/No tab|Invalid tab/i.test(String(e)))return{alreadyClosed:true};throw e}if(tab.windowId!==${windowId}||(!${JSON.stringify(urls)}.includes(tab.url)&&!${JSON.stringify(urls)}.includes(tab.pendingUrl)))throw Error('Original fixture page changed before cleanup');await chrome.tabs.remove(${tabId});return{removed:tab}})()`);
    });
    if (ids.length) await cleanup("verify-exact-cleanup", ids, async () => {
      detail.finalNative = await inventory(); assert.deepEqual(detail.finalNative.tabs.filter(tab => ids.includes(tab.id)), []);
      assert.deepEqual(detail.finalNative.windows.filter(window => detail.cases.some(item => item.sourceWindow.id === window.id)), []);
      assert.deepEqual(detail.finalNative.targets.filter(target => ids.includes(target.tabId) && target.attached), []); return { absent: ids };
    });
    if (deliverPages && ids.length) await cleanup("delivery-markers-pruned", ids, async () => {
      const deadline = performance.now() + 5000;
      for (;;) {
        detail.finalDelivery = await createdPageAction(deadline, () => evaluate("structuredClone(__integrationBackend.store.state.deliverableTabs??{})"));
        detail.finalStoredDelivery = await createdPageAction(deadline, () => evaluate("chrome.storage.local.get('OPEN_BROWSER_USE_SESSION_STATE').then(value=>value.OPEN_BROWSER_USE_SESSION_STATE?.deliverableTabs??{})"));
        if (ids.every(id => !Object.hasOwn(detail.finalDelivery, String(id)) && !Object.hasOwn(detail.finalStoredDelivery, String(id)))) return { absent: ids };
        await delay(20);
      }
    });
    for (const browser of [...owners, foreign].filter(Boolean)) await cleanup("close-sdk", browser.client.sessionId, () => browser.close());
    const names = { adoption: "__createdPageAdoption", trace: "__createdPageProvenance", nativeControl: "__createdPageNativeControl" };
    for (const name of installed.toReversed()) await cleanup("remove-observer", name, async () => {
      const snapshot = detail[name] = await evaluate(`${names[name]}.stop()`);
      assert.equal(snapshot.closed, true); assert.equal(snapshot.overflow, false);
      if (name === "trace") assert.equal(snapshot.listenerPresent, false);
      else { assert.equal(snapshot.restored, true); assert.deepEqual(snapshot.errors, []); assert.deepEqual(snapshot.pendingOperations, []); }
      if (name === "nativeControl") assert.equal(snapshot.listenersRemoved, true);
      return { closed: true, restored: snapshot.restored, listenerPresent: snapshot.listenerPresent };
    });
    if (!failure) try {
      detail.adoptionChecks = assertPopupAdoption({ snapshot: detail.adoption, items: detail.cases });
      detail.nativeControlChecks = assertPopupNativeControl({ snapshot: detail.nativeControl, items: detail.cases });
      assert.equal(detail.trace.events.length, 3);
    } catch (error) { failure = error; }
    detail.server = server.allStats(); detail.passed = !failure;
    try { await saveDetail(detail); } catch (error) { failure ??= error; detail.passed = false; }
  }
  if (failure) { failure.createdPagePopupSourceDetail = detail; throw failure; }
  return detail;
}
