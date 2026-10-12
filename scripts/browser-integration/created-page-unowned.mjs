import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { installCreatedPageObserver, assertCreatedPageSource, assertCreatedPageReceipt, createdPageAction } from "./created-page-provenance.mjs";
import { installCreatedPageAdoptionObserver, assertCreatedPageAdoption } from "./created-page-adoption-observer.mjs";
import { installCreatedPageWireObserver } from "./created-page-wire.mjs";
import { assertCreatedPageUnownedWire } from "./created-page-unowned-wire.mjs";
import { installCreatedPageNativeControlObserver } from "./created-page-native-control.mjs";
import { checkBackgroundWindowSuccessor } from "./background-window-fixture.mjs";
import { checkCreatedPageWorkerRestart } from "./created-page-worker-restart.mjs";

const scopeOf = browser => ({ session_id: browser.client.sessionId, turn_id: browser.client.turnId, control_epoch: browser.client.controlEpoch });
const errorText = error => error?.stack ?? String(error);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const unowned = /not part of browser session|OBU_AUXILIARY_/;

// A retained native page is not proof of revoked authority: also require the
// reverse lock, durable owner, public enumeration and debugger to be absent.
export function assertCreatedPageRevoked({ snapshot, item, tabs }) {
  assert.equal(snapshot.tab.id, item.childId);
  assert.equal(snapshot.tab.windowId, item.createdTab.windowId);
  assert.equal(snapshot.tab.groupId, -1); assert.equal(snapshot.tab.pinned, false);
  assert.equal(snapshot.tab.url, item.childURL);
  assert.equal(snapshot.entry, null); assert.equal(snapshot.owner, null);
  assert.deepEqual(snapshot.stored, []);
  assert.equal(snapshot.targets.some(target => target.tabId === item.childId && target.attached), false);
  assert.equal(tabs.some(tab => tab.id === item.childId), false);
}

export async function checkCreatedPageUnowned({ connectBrowser, getWorker, recorderFor, readNative, readFocus, focusLedger,
  allowedActivations, allowedFocus, connectionState, fixtureURL, server, restartWorker, persistentEvaluate,
  saveDetail = async () => {}, detail = {} }) {
  const owners = [], sources = new Map(), waits = new Map();
  const variants = restartWorker ? ["root"] : ["root", "oopif", "dynamic-oopif"];
  const outcomes = restartWorker ? ["collect-restart", "matched-restart", "idle-restart"] : ["collect-finalize", "cancel-matched"];
  let nativeInstalled = false, wireInstalled = false, adoptionInstalled = false, nativeControlInstalled = false, failure;
  Object.assign(detail, { boundary: "Natural Control-click children of public backgroundWindow sources; passive original adoption/Chrome acknowledgements. Matched cancellation and collected finalization preserve the child but retire authority. Native source/document reads are observational, not atomic event-document binding. Exact background creation and successor activation allowances are recorded; no focus restoration.", cases: [], groups: [], cleanup: [] });
  if (restartWorker) detail.boundary = "Three natural unowned root children, matched/collected/ended-idle before real worker restart; original child and source documents, persistent storage transitions, old and explicit fresh scope probes. Lifecycle results are separate from the unchanged final focus gate; no input replay, child replacement or focus allowance.";
  const evaluate = expression => getWorker().evaluate(expression);
  const frames = tabId => evaluate(`chrome.webNavigation.getAllFrames({tabId:${tabId}})`);
  const read = async (target, deadline, selector = "#state") => {
    while (true) {
      const value = await createdPageAction(deadline, options => target.locator(selector).textContent(options));
      assert.ok(typeof value === "string" && Buffer.byteLength(value) <= 65536);
      if (value !== "") return JSON.parse(value);
      assert.ok(performance.now() < deadline); await delay(20);
    }
  };
  const waitFor = async (operation, deadline, label) => {
    while (true) {
      assert.ok(performance.now() < deadline, label);
      const value = await operation(); assert.ok(performance.now() < deadline, label);
      if (value) return value;
      await delay(20);
    }
  };
  const rejected = async (operation, pattern) => {
    let result;
    try { result = { value: await operation() }; } catch (error) { result = { error: String(error), at: Date.now() }; }
    assert.ok(result.error, "Operation unexpectedly retained authority"); assert.match(result.error, pattern); return result;
  };
  const ownership = item => evaluate(`(async()=>{const backend=globalThis.__integrationBackend;return{tab:await chrome.tabs.get(${item.childId}),entry:backend.auxiliaryTabs.entry(${item.childId})??null,owner:backend.auxiliaryTabs.owner(${item.childId})??null,stored:((await chrome.storage.session.get('OPEN_BROWSER_USE_AUXILIARY_TABS')).OPEN_BROWSER_USE_AUXILIARY_TABS?.records??[]).filter(record=>record.tabId===${item.childId}),targets:await chrome.debugger.getTargets()}})()`);
  const step = async (item, name, operation) => {
    const record = { name, startedAt: Date.now() }; (item.steps ??= []).push(record);
    try { const value = await operation(); record.ok = true; return value; }
    catch (error) { record.error = errorText(error); throw error; }
    finally { record.finishedAt = Date.now(); }
  };
  const finalize = async (browser, item) => {
    if (item.finalized) return;
    const record = item.finalization = {};
    record.before = await readNative(); record.focusBefore = await readFocus();
    focusLedger.assertAllowed(record.focusBefore, allowedActivations, allowedFocus);
    record.ack = await browser.client.finalizeTabs([]); item.finalized = true;
    record.after = await readNative(); record.focusAfter = await readFocus();
    record.allowances = checkBackgroundWindowSuccessor({ before: record.before, after: record.after,
      focusBefore: record.focusBefore, focusAfter: record.focusAfter, agentTabId: item.tabId, extraTabId: item.childId, windowId: item.createdTab.windowId });
    allowedActivations.push(...record.allowances);
    focusLedger.assertAllowed(record.focusAfter, allowedActivations, allowedFocus);
  };
  const observeFinalized = async (browser, item) => {
    // Separate observation budget after the actual finalize ACK. The SDK and
    // worker retain their own 20s RPC bounds; a late result fails this budget
    // and cannot start another operation. This is not native cancellation.
    const deadline = performance.now() + 20000;
    const observed = operation => createdPageAction(deadline, operation);
    const result = { startedAt: Date.now(), budgetMs: 20000, finalizedNative: await observed(() => ownership(item)) };
    await observed(() => browser.client.beginTurn()); result.freshScope = scopeOf(browser);
    result.tabsAfterFinalize = await observed(() => browser.getTabs());
    assert.ok(result.freshScope.control_epoch > item.scope.control_epoch);
    assertCreatedPageRevoked({ snapshot: result.finalizedNative, item, tabs: result.tabsAfterFinalize });
    result.deniedFreshAttach = await observed(options => rejected(() => browser.client.request("attach", { tabId: item.childId }, { timeoutMs: Math.min(2000, options.timeoutMs) }), unowned));
    result.finalChildFrames = await observed(() => frames(item.childId));
    assert.equal(result.finalChildFrames.find(frame => frame.frameId === 0)?.documentId, item.childFrame.documentId);
    result.finishedAt = Date.now();
    return result;
  };
  try {
    for (const variant of variants)
      for (const outcome of outcomes) owners.push(await connectBrowser(`created-unowned-${variant}-${outcome}`));
    detail.connectionBefore = connectionState();
    detail.nativeControlObserver = await evaluate(`(${installCreatedPageNativeControlObserver.toString()})(chrome,globalThis)`); nativeControlInstalled = true;
    detail.nativeObserver = await evaluate(`(${installCreatedPageObserver.toString()})(chrome,globalThis)`); nativeInstalled = true;
    const options = { sessions: owners.map(browser => browser.client.sessionId) };
    detail.adoptionObserver = await evaluate(`(${installCreatedPageAdoptionObserver.toString()})(__integrationBackend,chrome,globalThis,${JSON.stringify(options)})`); adoptionInstalled = true;
    detail.wireObserver = await evaluate(`(${installCreatedPageWireObserver.toString()})(chrome,globalThis,${JSON.stringify({ ...options, generation: detail.connectionBefore.generation })})`); wireInstalled = true;
    for (const [variantIndex, variant] of variants.entries()) {
      const group = []; detail.groups.push({ variant, items: [] }); const groupDetail = detail.groups.at(-1);
      for (const [offset, outcome] of outcomes.entries()) {
        const browser = owners[variantIndex * outcomes.length + offset], record = server.createCase({ owner: `${variant}-${outcome}`, variant });
        // Establish the public scope before recording window creation.
        await browser.client.getInfo(); await browser.client.beginTurn(`unowned-${variant}-${outcome}`);
        const recorder = recorderFor(browser), tab = await recorder.createTab();
        const item = { variant, outcome, key: record.key, owner: record.owner, tabId: tab.id, scope: scopeOf(browser),
          sourceURL: new URL(record.urlPath, fixtureURL).href, childURL: new URL("/created-page/child", fixtureURL).href, backgroundWindows: recorder.records };
        sources.set(tab.id, item); detail.cases.push(item); groupDetail.items.push(item.key); group.push({ browser, tab, item });
        item.createdTab = await evaluate(`chrome.tabs.get(${tab.id})`); assert.equal(item.createdTab.groupId, -1);
        item.sourceClaim = await evaluate(`__integrationBackend.auxiliaryTabs.owner(${tab.id})`);
        assert.equal(item.sourceClaim.kind, "background-window"); assert.equal(item.sourceClaim.origin, "agent");
        item.observerReady = await evaluate(`__createdPageProvenance.register(${tab.id})`);
        await browser.cdp.navigate(tab.id, item.sourceURL);
      }
      // Both callers arm before any trigger; matching uses native source IDs,
      // never the common child URL or a child ID supplied to the product.
      const deadline = performance.now() + 20000; groupDetail.startedAt = Date.now();
      const ready = await Promise.allSettled(group.map(async ({ tab, item }) => {
        item.rootBefore = await read(tab, deadline); assert.deepEqual(item.rootBefore.frameAdds, []);
        const waiter = await step(item, "ready", () => tab.expectPage({ timeoutMs: Math.floor(deadline - performance.now()) }));
        waits.set(item.key, waiter); item.waiterId = waiter.waiterId; item.readyAt = Date.now(); item.remainingMs = waiter.remainingMs;
      }));
      const failedReady = ready.find(result => result.status === "rejected"); if (failedReady) throw failedReady.reason;
      groupDetail.allReadyAt = Date.now();
      for (const member of group) {
        const { tab, item } = member;
        if (variant === "dynamic-oopif") await step(item, "addFrame", () => createdPageAction(deadline, options => tab.locator("#add-frame").click(options)));
        member.target = variant === "root" ? tab : tab.frameLocator("#created-page-frame");
        item.sourceBefore = await read(member.target, deadline); assert.deepEqual(item.sourceBefore.clicks, []);
        item.framesBefore = await frames(item.tabId);
        const url = variant === "root" ? item.sourceURL : new URL(`/created-page/frame?key=${encodeURIComponent(item.key)}`, fixtureURL.replace("127.0.0.1", "localhost")).href;
        const matches = item.framesBefore.filter(frame => frame.url === url && (variant === "root" ? frame.frameId === 0 : frame.frameId !== 0 && frame.parentFrameId === 0));
        assert.equal(matches.length, 1); item.sourceFrame = matches[0]; assert.ok(item.sourceFrame.documentId);
        item.sourceHTML = server.stats(item.key).documents.filter(document => document.nonce === item.sourceBefore.sourceNonce);
        assert.equal(item.sourceHTML.length, 1);
        const bytes = Buffer.from(item.sourceHTML[0].base64, "base64"); assert.equal(bytes.length, item.sourceHTML[0].bytes);
        assert.equal(createHash("sha256").update(bytes).digest("hex"), item.sourceHTML[0].sha256);
        assert.ok(bytes.includes(Buffer.from(item.sourceBefore.sourceNonce)));
        if (variant !== "root") {
          item.renderer = await evaluate(`(async()=>({attachments:(globalThis.__integrationFrames??[]).filter(frame=>frame.tabId===${item.tabId}),targets:await chrome.debugger.getTargets()}))()`);
          const matches = item.renderer.targets.filter(native => native.url === url && item.renderer.attachments.some(attachment => attachment.targetId === native.id && attachment.type === "iframe" && attachment.sessionId));
          assert.equal(matches.length, 1); item.rendererTarget = matches[0];
        }
      }
      groupDetail.allPreparedAt = Date.now();
      const triggers = await Promise.allSettled(group.map(({ target, item }) => step(item, "trigger", () => createdPageAction(deadline, options => target.locator("#open-child").click({ ...options, modifiers: ["Control"] })))));
      const failedTrigger = triggers.find(result => result.status === "rejected"); if (failedTrigger) throw failedTrigger.reason;
      for (const { browser, tab, target, item } of group) {
        item.matched = await waitFor(async () => {
          const record = await evaluate(`(()=>{const r=__integrationBackend.pageWaits.records.get(${JSON.stringify(item.waiterId)});return r?{state:r.state,invalid:r.invalid,delivered:r.delivered,error:r.error?String(r.error):null,result:r.result??null,params:r.params}:null})()`);
          assert.ok(record, "Original waiter disappeared before collection"); assert.equal(Boolean(record.invalid), false, record.error ?? "waiter invalidated");
          return record.state === "matched" ? record : null;
        }, deadline, "Native child not matched within original deadline");
        assert.equal(Boolean(item.matched.delivered), false); item.childId = item.matched.result.tabId;
        item.events = (await evaluate("__createdPageProvenance.snapshot()")).events.filter(event => event.details.sourceTabId === item.tabId);
        item.sourceAfter = await read(target, deadline); item.framesAfterClick = await frames(item.tabId);
        assert.equal(assertCreatedPageSource({ item, events: item.events, afterFrames: item.framesAfterClick, sourceState: item.sourceAfter }), item.childId);
        item.rootAfter = variant === "root" ? item.sourceAfter : await read(tab, deadline);
        assert.deepEqual(item.rootAfter.frameAdds, variant === "dynamic-oopif" ? [{ trusted: true, sequence: 1 }] : []);
        item.adopted = await ownership(item);
        assert.equal(item.adopted.tab.groupId, -1); assert.equal(item.adopted.tab.active, false); assert.equal(item.adopted.tab.windowId, item.createdTab.windowId);
        assert.equal(item.adopted.owner.kind, "created-page"); assert.equal(item.adopted.owner.origin, "user"); assert.equal(item.adopted.owner.session_id, item.scope.session_id);
        assert.equal(item.adopted.owner.turn_id, item.scope.turn_id); assert.equal(item.adopted.owner.control_epoch, item.scope.control_epoch);
        assert.equal(item.adopted.targets.some(target => target.tabId === item.childId && target.attached), false, "Adoption itself must not attach the child");
        item.childFramesBefore = await waitFor(async () => { const value = await frames(item.childId); return value.some(frame => frame.frameId === 0 && frame.url === item.childURL && frame.documentId) ? value : null; }, deadline, "Original native child document not committed");
        item.childFrame = item.childFramesBefore.find(frame => frame.frameId === 0); assert.ok(item.childFrame?.documentId);
      }
      assert.equal(new Set(group.map(({ item }) => item.childId)).size, group.length);
      for (const [index, { item }] of group.entries()) item.foreignAttach = await rejected(() => group[(index + 1) % group.length].browser.client.request("attach", { tabId: item.childId }, { timeoutMs: 2000 }), unowned);
      if (restartWorker) {
        detail.workerRestart = {};
        await checkCreatedPageWorkerRestart({ group, waiters: waits, deadline, evaluate, frames, ownership,
          restartWorker, persistentEvaluate, readSource: read, detail: detail.workerRestart,
          onBeforeRestart: async () => {
            detail.adoption = await evaluate("__createdPageAdoption.stop()"); adoptionInstalled = false;
            detail.adoptionChecks = assertCreatedPageAdoption({ snapshot: detail.adoption, items: detail.cases.map(item => ({ ...item, sessionId: item.scope.session_id, turnId: item.scope.turn_id, controlEpoch: item.scope.control_epoch })) });
            detail.wire = await evaluate("__createdPageWire.stop()"); wireInstalled = false;
            detail.trace = await evaluate("__createdPageProvenance.stop()"); nativeInstalled = false;
            detail.nativeControl = await evaluate("__createdPageNativeControl.stop()"); nativeControlInstalled = false;
            detail.beforeRestartObservers = { wire: detail.wire, nativeControl: detail.nativeControl };
            for (const snapshot of [detail.wire, detail.nativeControl]) {
              assert.equal(snapshot.closed, true); assert.equal(snapshot.restored, true);
              assert.equal(snapshot.overflow, false); assert.deepEqual(snapshot.errors, []);
            }
            assert.deepEqual(detail.wire.pendingIds, []); assert.deepEqual(detail.nativeControl.pendingOperations, []);
            assert.equal(detail.nativeControl.listenersRemoved, true); assert.equal(detail.trace.listenerPresent, false);
          },
          onAfterRestart: async () => {
            detail.connectionAfterRestart = connectionState(); assert.deepEqual(detail.connectionAfterRestart, detail.connectionBefore);
            detail.restartedWireObserver = await evaluate(`(${installCreatedPageWireObserver.toString()})(chrome,globalThis,${JSON.stringify({ ...options, generation: detail.connectionAfterRestart.generation })})`); wireInstalled = true;
            detail.restartedNativeControlObserver = await evaluate(`(${installCreatedPageNativeControlObserver.toString()})(chrome,globalThis)`); nativeControlInstalled = true;
          }
        });
        const stats = server.allStats();
        assert.equal(stats.children.length, 3); assert.equal(stats.children.flatMap(child => child.posts).length, 0);
        for (const { item } of group) {
          const nonce = item.workerRestart?.childBefore?.documentNonce;
          if (nonce) {
            const matches = stats.children.filter(child => child.nonce === nonce); assert.equal(matches.length, 1);
            item.restartChildHTML = matches[0];
            const bytes = Buffer.from(matches[0].html.base64, "base64");
            assert.equal(bytes.length, matches[0].html.bytes); assert.equal(createHash("sha256").update(bytes).digest("hex"), matches[0].html.sha256);
            assert.ok(bytes.includes(Buffer.from(nonce)));
          }
        }
        groupDetail.finishedAt = Date.now();
        // Lifecycle evidence never waives a focus failure from native creation
        // or restart. Preserve the full persistent ledger as the final gate.
        focusLedger.assertAllowed(await readFocus(), allowedActivations, allowedFocus);
        break;
      }
      for (const { browser, item } of group) {
        const waiter = waits.get(item.key);
        if (item.outcome === "collect-finalize") {
          const child = await step(item, "collect", () => waiter.result()); assert.equal(child.id, item.childId);
          item.childBefore = await read(child, deadline);
          await step(item, "fillKey", () => createdPageAction(deadline, options => child.getByLabel("Source key", { exact: true }).fill(item.key, options)));
          await step(item, "fillOwner", () => createdPageAction(deadline, options => child.getByLabel("Owner", { exact: true }).fill(item.owner, options)));
          await step(item, "commit", () => createdPageAction(deadline, options => child.locator("#commit").click(options)));
          item.receipt = await read(child, deadline, "#result"); item.childAfter = await read(child, deadline);
          item.childFramesAfter = await frames(item.childId);
          const original = server.allStats().children.filter(child => child.nonce === item.childBefore.documentNonce); assert.equal(original.length, 1); item.originalChild = original[0];
          item.business = assertCreatedPageReceipt({ item, child: item.originalChild, state: item.childAfter, receipt: item.receipt, frames: item.childFramesAfter });
          item.attachedBeforeFinalize = await ownership(item);
          assert.ok(item.attachedBeforeFinalize.targets.some(target => target.tabId === item.childId && target.attached));
          await step(item, "cancelDeliveredNoOp", () => waiter.cancel());
          item.afterDeliveredCancel = await ownership(item); assert.deepEqual(item.afterDeliveredCancel.owner, item.adopted.owner);
        } else {
          assert.ok(performance.now() < deadline, "Matched cancellation exceeded original workflow deadline");
          item.beforeMatchedCancel = await evaluate(`(()=>{const r=__integrationBackend.pageWaits.records.get(${JSON.stringify(item.waiterId)});return r?{state:r.state,invalid:Boolean(r.invalid),delivered:Boolean(r.delivered),remainingMs:r.deadlineAt-__integrationBackend.pageWaits.now(),result:r.result??null,params:r.params}:null})()`);
          assert.equal(item.beforeMatchedCancel?.state, "matched"); assert.equal(item.beforeMatchedCancel.invalid, false);
          assert.equal(item.beforeMatchedCancel.delivered, false); assert.ok(item.beforeMatchedCancel.remainingMs > 0);
          assert.equal(item.beforeMatchedCancel.result.tabId, item.childId);
          item.cancel = await step(item, "cancelMatched", () => waiter.cancel());
          item.retired = await ownership(item); item.tabsAfterCancel = await browser.getTabs();
          assertCreatedPageRevoked({ snapshot: item.retired, item, tabs: item.tabsAfterCancel });
          item.expiredCollect = await rejected(() => browser.client.request("collectPageWait", { ...item.scope, tabId: item.tabId, waiterId: item.waiterId }, { timeoutMs: 2000 }), /OBU_PAGE_WAIT_EXPIRED/);
          item.deniedAttach = await rejected(() => browser.client.request("attach", { tabId: item.childId }, { timeoutMs: 2000 }), unowned);
          item.cancelAgain = await browser.client.request("cancelPageWait", { ...item.scope, tabId: item.tabId, waiterId: item.waiterId }, { timeoutMs: 2000 });
          assert.deepEqual(item.cancelAgain, {});
          item.sourceAfterCancel = await read(browser.tab(item.tabId), deadline);
          assert.equal(item.sourceAfterCancel.documentToken, item.rootBefore.documentToken);
          const rearmed = await browser.tab(item.tabId).expectPage({ timeoutMs: Math.floor(deadline - performance.now()) });
          item.rearmedWaiterId = rearmed.waiterId; assert.notEqual(rearmed.waiterId, item.waiterId);
          await rearmed.cancel();
        }
        assert.ok(performance.now() < deadline, "Original created-page workflow deadline expired");
      }
      // Complete both independent business outcomes before either owner ends
      // its turn. A focus failure still stops this group at the original strict
      // finalization check; it never authorizes another layout or input replay.
      for (const { browser, item } of group) {
        assert.ok(performance.now() < deadline, "Original created-page workflow deadline expired");
        await step(item, "finalize", () => finalize(browser, item));
        Object.assign(item, await observeFinalized(browser, item));
        item.ok = true;
      }
      groupDetail.finishedAt = Date.now();
    }
    if (!restartWorker) {
    detail.adoption = await evaluate("__createdPageAdoption.stop()");
    detail.adoptionChecks = assertCreatedPageAdoption({ snapshot: detail.adoption, items: detail.cases.map(item => ({ ...item, sessionId: item.scope.session_id, turnId: item.scope.turn_id, controlEpoch: item.scope.control_epoch })) });
    detail.wire = await evaluate("__createdPageWire.stop()");
    detail.wireChecks = assertCreatedPageUnownedWire({ snapshot: detail.wire, items: detail.cases });
    detail.trace = await evaluate("__createdPageProvenance.snapshot()"); assert.equal(detail.trace.overflow, false); assert.equal(detail.trace.events.length, 6);
    detail.connectionAfter = connectionState(); assert.deepEqual(detail.connectionAfter, detail.connectionBefore);
    const stats = server.allStats(); assert.equal(stats.children.length, 6); assert.equal(stats.children.flatMap(child => child.posts).length, 3);
    assert.equal(stats.children.filter(child => child.posts.length === 0).length, 3);
    }
  } catch (error) { failure = error; detail.error = errorText(error); }
  finally {
    const cleanup = async (kind, identity, operation) => {
      const record = { kind, identity, startedAt: Date.now() }; detail.cleanup.push(record);
      try { record.result = await operation(); record.ok = true; } catch (error) { record.error = errorText(error); failure ??= error; }
      finally { record.finishedAt = Date.now(); }
    };
    if (adoptionInstalled) await cleanup("remove-adoption-observer", "adoption", async () => {
      detail.adoption = await evaluate("__createdPageAdoption.stop()");
      assert.equal(detail.adoption.closed, true); assert.equal(detail.adoption.restored, true);
      assert.equal(detail.adoption.overflow, false); assert.deepEqual(detail.adoption.errors, []);
      assert.deepEqual(detail.adoption.pendingOperations, []); return { closed: true, restored: true };
    });
    if (nativeInstalled) await cleanup("remove-native-observer", "native", async () => { detail.trace = await evaluate("__createdPageProvenance.stop()"); assert.equal(detail.trace.listenerPresent, false); return { closed: true, listenerPresent: false }; });
    for (const browser of owners) {
      const item = detail.cases.find(item => item.scope.session_id === browser.client.sessionId);
      // A failed focus precondition must not prevent the actual authorized
      // cleanup. Preserve that failure; do not grant any new focus allowance.
      if (!item?.finalized) await cleanup("formal-finalize", browser.client.sessionId, async () => {
        const record = { requestedAt: Date.now(), ack: await browser.client.finalizeTabs([]) };
        if (item) { item.finalized = true; item.failureFinalization = record; }
        record.after = await readNative(); record.focusAfter = await readFocus();
        if (item?.childFrame?.documentId) {
          assert.equal(record.after.tabs.some(tab => tab.id === item.tabId), false, "Finalization retained the agent source");
          record.retirement = await observeFinalized(browser, item);
        }
        return record;
      });
    }
    const ids = [...new Set([...sources.keys(), ...(detail.trace?.events ?? []).map(event => event.details.tabId)])];
    for (const tabId of ids) await cleanup("exact-fixture-tab", tabId, () => evaluate(`(async()=>{let tab;try{tab=await chrome.tabs.get(${tabId})}catch(error){if(/No tab|Invalid tab/i.test(String(error)))return{alreadyClosed:true};throw error}const urls=${JSON.stringify([new URL("/created-page/child", fixtureURL).href, sources.get(tabId)?.sourceURL].filter(Boolean))};if(!urls.includes(tab.url)&&!urls.includes(tab.pendingUrl))throw new Error('Fixture tab changed before cleanup');await chrome.tabs.remove(${tabId});return{removed:tab}})()`));
    await cleanup("verify-exact-cleanup", ids, async () => {
      detail.finalNative = await readNative();
      const windows = detail.cases.map(item => item.createdTab.windowId);
      assert.deepEqual(detail.finalNative.tabs.filter(tab => ids.includes(tab.id)), []);
      assert.deepEqual(detail.finalNative.windows.filter(window => windows.includes(window.id)), []);
      assert.deepEqual(detail.finalNative.targets.filter(target => ids.includes(target.tabId) && target.attached), []);
      return { tabsAbsent: ids, windowsAbsent: windows };
    });
    for (const browser of owners) await cleanup("close-sdk", browser.client.sessionId, () => browser.close());
    if (wireInstalled) await cleanup("remove-wire-observer", "wire", async () => {
      detail.wire = await evaluate("__createdPageWire.stop()");
      assert.equal(detail.wire.closed, true); assert.equal(detail.wire.restored, true);
      assert.equal(detail.wire.overflow, false); assert.deepEqual(detail.wire.errors, []);
      assert.deepEqual(detail.wire.pendingIds, []); return { closed: true, restored: true };
    });
    if (nativeControlInstalled) await cleanup("remove-native-control-observer", "native-control", async () => {
      detail.nativeControl = await evaluate("__createdPageNativeControl.stop()");
      assert.equal(detail.nativeControl.closed, true); assert.equal(detail.nativeControl.restored, true);
      assert.equal(detail.nativeControl.listenersRemoved, true);
      assert.equal(detail.nativeControl.overflow, false); assert.deepEqual(detail.nativeControl.errors, []);
      assert.deepEqual(detail.nativeControl.pendingOperations, []); return { closed: true, restored: true };
    });
    detail.server = server.allStats();
    try { await saveDetail(detail); } catch (error) { failure ??= error; }
  }
  if (failure) { failure.createdPageUnownedDetail = detail; throw failure; } return detail;
}
