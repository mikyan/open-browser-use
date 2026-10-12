import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { installCreatedPageObserver, assertCreatedPageSource, createdPageAction } from "./created-page-provenance.mjs";
import { installCreatedPageAdoptionObserver, assertCreatedPageAdoption } from "./created-page-adoption-observer.mjs";
import { installCreatedPageNativeControlObserver } from "./created-page-native-control.mjs";

const scopeOf = browser => ({ session_id: browser.client.sessionId, turn_id: browser.client.turnId, control_epoch: browser.client.controlEpoch });
const errorText = error => error?.stack ?? String(error);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Installed after matching in the same surviving worker. Only one original
// record/claim is retained. Calls, return values, `this`, throws and returned
// Promise identities remain the product's; evidence reactions never gate them.
export function installNativeCreatedPageLossObserver(backend, target, options) {
  const { waiterId, childId, claimId, maxRecords = 256, maxBytes = 1024 * 1024 } = options ?? {};
  const waits = backend?.pageWaits, record = waits?.records?.get(waiterId), claim = backend?.auxiliaryTabs?.entry(childId);
  if (!target || target.__nativeCreatedPageLoss || !record || record.state !== "matched" || record.invalid || record.delivered ||
      record.result?.tabId !== childId || !claim || claim.claimId !== claimId || claim.kind !== "created-page" || claim.phase !== "committed" ||
      !Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > 2048 ||
      !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 4 * 1024 * 1024) throw Error("Invalid native created-page loss observer installation");
  const patches = [[waits, "fail"], [backend, "nativeDisconnected"], [backend, "releaseAuxiliaryClaim"]].map(([object, name]) => {
    const descriptor = Object.getOwnPropertyDescriptor(object, name), original = object[name];
    if (typeof original !== "function" || descriptor && (!Object.hasOwn(descriptor, "value") || !descriptor.writable) ||
        !descriptor && !Object.isExtensible(object)) throw Error(`Cannot observe original ${name}`);
    return { object, name, descriptor, original };
  });
  const rows = [], errors = [], pending = new Map(), encoder = new TextEncoder();
  let bytes = 0, overflow = false, closed = false, restored = false, operationId = 0, cleanupObserved = false;
  const copy = value => JSON.parse(JSON.stringify(value));
  const problem = error => { if (errors.length < 16) errors.push(String(error?.message ?? error).slice(0, 1024)); };
  const safe = operation => { try { return operation(); } catch (error) { problem(error); } };
  const state = () => ({ waiterId, childId, claimId, state: record.state, invalid: Boolean(record.invalid), delivered: Boolean(record.delivered),
    remainingMs: record.deadlineAt - waits.now(), deadlineAt: record.deadlineAt, error: record.error ? String(record.error) : null,
    cleaned: Boolean(record.cleaned), cleanupSettled: Boolean(record.cleanupSettled), cleanupError: record.cleanupError ? String(record.cleanupError) : null,
    registered: waits.records.get(waiterId) === record, reverseLocked: waits.byTab.get(record.params.tabId) === record,
    entry: backend.auxiliaryTabs.entry(childId) ?? null, owner: backend.auxiliaryTabs.owner(childId) ?? null });
  const emit = (kind, value = {}) => {
    if (closed || overflow) return;
    const row = copy({ sequence: rows.length + 1, receivedAt: Date.now(), kind, ...value, snapshot: state() });
    const size = encoder.encode(JSON.stringify(row)).byteLength;
    if (rows.length >= maxRecords || bytes + size > maxBytes) { overflow = true; return; }
    rows.push(row); bytes += size;
  };
  const observe = (promise, id, kind) => {
    pending.set(id, kind);
    Promise.prototype.then.call(promise, () => {
      if (closed) return; pending.delete(id); safe(() => emit(`${kind}-fulfilled`, { operationId: id }));
    }, error => {
      if (closed) return; pending.delete(id); safe(() => emit(`${kind}-rejected`, { operationId: id, error: String(error) }));
    });
  };
  for (const patch of patches) patch.wrapper = function (...args) {
    const relevant = patch.name === "nativeDisconnected" || patch.name === "fail" && args[0] === record || patch.name === "releaseAuxiliaryClaim" && args[0] === claim;
    if (closed || overflow || !relevant) return Reflect.apply(patch.original, this, args);
    const id = ++operationId;
    safe(() => emit(`${patch.name}-enter`, { operationId: id, error: patch.name === "fail" ? String(args[1]) : null,
      exactClaim: patch.name === "releaseAuxiliaryClaim" ? args[0] === claim : null }));
    let result;
    try { result = Reflect.apply(patch.original, this, args); }
    catch (error) { safe(() => emit(`${patch.name}-threw`, { operationId: id, error: String(error) })); throw error; }
    if (patch.name === "fail") {
      safe(() => emit("fail-return", { operationId: id }));
      if (!cleanupObserved && record.cleanup) { cleanupObserved = true; safe(() => observe(record.cleanup, ++operationId, "cleanup")); }
    } else safe(() => observe(result, id, patch.name));
    return result;
  };
  const snapshot = () => copy({ waiterId, childId, claimId, rows, bytes, maxRecords, maxBytes, overflow, errors, closed, restored,
    pending: [...pending].map(([id, kind]) => ({ id, kind })), current: state() });
  const restore = () => {
    let complete = true;
    for (const patch of patches.toReversed()) try {
      if (patch.object[patch.name] !== patch.wrapper) throw Error(`${patch.name} observer replaced before stop`);
      if (patch.descriptor) Object.defineProperty(patch.object, patch.name, patch.descriptor); else delete patch.object[patch.name];
      if (patch.object[patch.name] !== patch.original) throw Error(`${patch.name} observer restoration failed`);
    } catch (error) { complete = false; problem(error); }
    return complete;
  };
  const installed = [];
  try {
    for (const patch of patches) {
      Object.defineProperty(patch.object, patch.name, patch.descriptor ? { ...patch.descriptor, value: patch.wrapper } :
        { configurable: true, writable: true, enumerable: false, value: patch.wrapper }); installed.push(patch);
    }
    target.__nativeCreatedPageLoss = { snapshot, stop() { if (!closed) { closed = true; restored = restore(); } return snapshot(); } };
    safe(() => emit("installed"));
  } catch (error) {
    for (const patch of installed.toReversed()) {
      if (patch.descriptor) Object.defineProperty(patch.object, patch.name, patch.descriptor); else delete patch.object[patch.name];
    }
    throw error;
  }
  return { installed: true, waiterId, childId, claimId, maxRecords, maxBytes };
}

export function assertNativeCreatedPageImmediateLoss(snapshot, { stopped = false } = {}) {
  assert.equal(snapshot.overflow, false); assert.deepEqual(snapshot.errors, []);
  assert.equal(snapshot.bytes, snapshot.rows.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row)), 0));
  assert.ok(snapshot.rows.length <= snapshot.maxRecords && snapshot.bytes <= snapshot.maxBytes);
  for (const [index, row] of snapshot.rows.entries()) {
    assert.equal(row.sequence, index + 1); assert.equal(row.snapshot.waiterId, snapshot.waiterId);
    assert.equal(row.snapshot.childId, snapshot.childId); assert.equal(row.snapshot.claimId, snapshot.claimId);
  }
  const first = snapshot.rows[0]; assert.equal(first.kind, "installed");
  assert.equal(first.snapshot.state, "matched"); assert.equal(first.snapshot.delivered, false); assert.equal(first.snapshot.invalid, false);
  assert.ok(first.snapshot.remainingMs >= 5000, "Host loss lacked a meaningful original-deadline opportunity");
  const disconnect = snapshot.rows.find(row => row.kind === "nativeDisconnected-enter");
  const failed = snapshot.rows.find(row => row.kind === "fail-return" && row.snapshot.invalid);
  const released = snapshot.rows.find(row => row.kind === "releaseAuxiliaryClaim-fulfilled" && row.snapshot.entry === null);
  const cleaned = snapshot.rows.find(row => row.kind === "cleanup-fulfilled");
  const recovered = snapshot.rows.find(row => row.kind === "nativeDisconnected-fulfilled");
  assert.ok(disconnect && failed && released && cleaned && recovered, "Missing actual disconnect failure/release/cleanup acknowledgements");
  assert.ok(disconnect.sequence < failed.sequence && failed.sequence < cleaned.sequence);
  assert.match(failed.snapshot.error, /OBU_NATIVE_CONNECTION_LOST/);
  assert.equal(failed.snapshot.delivered, false); assert.equal(failed.snapshot.state, "failed");
  for (const row of [disconnect, failed, released, cleaned, recovered]) assert.ok(row.snapshot.remainingMs > 0, "Host-loss cleanup completed after the original deadline");
  assert.equal(cleaned.snapshot.cleaned, true); assert.equal(cleaned.snapshot.cleanupSettled, true);
  assert.equal(cleaned.snapshot.cleanupError, null); assert.equal(cleaned.snapshot.reverseLocked, false);
  assert.equal(cleaned.snapshot.entry, null); assert.equal(cleaned.snapshot.owner, null);
  assert.deepEqual(snapshot.pending, []);
  if (stopped) { assert.equal(snapshot.closed, true); assert.equal(snapshot.restored, true); }
  return { disconnectSequence: disconnect.sequence, failureSequence: failed.sequence, releaseSequence: released.sequence,
    cleanupSequence: cleaned.sequence, recoverySequence: recovered.sequence, cleanupRemainingMs: cleaned.snapshot.remainingMs };
}

export function assertNativeCreatedPageRetired({ item, snapshot, sourceFrames, childFrames, tabs }) {
  assert.equal(snapshot.source.id, item.tabId);
  assert.equal(snapshot.source.windowId, item.createdTab.windowId, "Source moved to another window");
  assert.equal(snapshot.source.groupId, item.createdTab.groupId, "Source group changed");
  assert.equal(snapshot.source.pinned, item.createdTab.pinned, "Source pinned state changed");
  assert.equal(snapshot.tab.id, item.childId); assert.equal(snapshot.tab.windowId, item.createdTab.windowId);
  assert.equal(snapshot.tab.groupId, -1); assert.equal(snapshot.tab.pinned, false); assert.equal(snapshot.tab.url, item.childURL);
  assert.equal(snapshot.entry, null); assert.equal(snapshot.owner, null); assert.deepEqual(snapshot.stored, []);
  assert.equal(snapshot.targets.some(target => target.tabId === item.childId && target.attached), false);
  for (const [frames, original, name] of [[sourceFrames, item.sourceFrame, "Source"], [childFrames, item.childFrame, "Child"]]) {
    const matches = frames.filter(frame => frame.frameId === original.frameId); assert.equal(matches.length, 1);
    assert.ok(original.documentId); assert.equal(matches[0].documentId, original.documentId, `${name} document replaced`);
    assert.equal(matches[0].url, original.url);
  }
  if (tabs) { assert.equal(tabs.some(tab => tab.id === item.childId), false, "Child authority inherited after reconnect"); assert.equal(tabs.filter(tab => tab.id === item.tabId).length, 1); }
}

export async function requireNativeCreatedPageRejection(operation, pattern) {
  let result;
  try { result = { value: await operation() }; } catch (error) { result = { error: String(error), receivedAt: Date.now() }; }
  assert.ok(result.error, "Operation unexpectedly retained old or child authority"); assert.match(result.error, pattern); return result;
}

// Root owns the private browser/host and strict global focus gate. This helper
// observes one undelivered native child, not worker replacement or collected
// child recovery. No child DOM read/attachment/input is performed at any point.
export async function checkNativeCreatedPageHostLoss({ connect, worker, recorderFor, fixtureURL, server, terminateHost, reconnectHost,
  identity, readFocus, detail = {}, saveDetail = async () => {} }) {
  const evaluate = expression => worker.evaluate(expression), frames = tabId => evaluate(`chrome.webNavigation.getAllFrames({tabId:${tabId}})`);
  const clients = [], item = detail.item = {}, installed = new Set(); let browser, fresh, failure;
  Object.assign(detail, { lifecycleVerified: false, startedAt: Date.now(), cleanup: [],
    boundary: "One root natural Control-click child of a public backgroundWindow source, matched and undelivered at actual host termination. Same surviving worker, original 20s waiter deadline, passive fail/cleanup observations before replacement-endpoint observation and fresh SDK connection; later explicit fresh scope. No worker-restart or collected-child equivalence, child input/read/attachment, focus allowance, focus restoration or complete scene success claim." });
  const ownership = () => evaluate(`(async()=>{const b=__integrationBackend;return{source:await chrome.tabs.get(${item.tabId}),tab:await chrome.tabs.get(${item.childId}),entry:b.auxiliaryTabs.entry(${item.childId})??null,owner:b.auxiliaryTabs.owner(${item.childId})??null,stored:((await chrome.storage.session.get('OPEN_BROWSER_USE_AUXILIARY_TABS')).OPEN_BROWSER_USE_AUXILIARY_TABS?.records??[]).filter(r=>r.tabId===${item.childId}),targets:await chrome.debugger.getTargets()}})()`);
  const read = async (tab, deadline) => {
    while (true) {
      const value = await createdPageAction(deadline, options => tab.locator("#state").textContent(options));
      assert.ok(typeof value === "string" && Buffer.byteLength(value) <= 65536);
      if (value) return JSON.parse(value); await delay(20);
    }
  };
  const wait = async (operation, deadline, message) => {
    while (true) { const result = await createdPageAction(deadline, operation); if (result) return result; assert.ok(performance.now() < deadline, message); await delay(20); }
  };
  const originalRecord = () => evaluate(`(()=>{const b=__integrationBackend,r=b.pageWaits.records.get(${JSON.stringify(item.waiterId)});return r?{state:r.state,invalid:Boolean(r.invalid),delivered:Boolean(r.delivered),remainingMs:r.deadlineAt-b.pageWaits.now(),error:r.error?String(r.error):null,result:r.result??null}:null})()`);
  try {
    browser = await connect("native-created-page-loss"); clients.push(browser);
    await browser.client.getInfo(); await browser.client.beginTurn("native-created-page-loss"); item.scope = scopeOf(browser);
    for (const [name, expression] of [
      ["nativeControl", `(${installCreatedPageNativeControlObserver.toString()})(chrome,globalThis)`],
      ["provenance", `(${installCreatedPageObserver.toString()})(chrome,globalThis)`],
      ["adoption", `(${installCreatedPageAdoptionObserver.toString()})(__integrationBackend,chrome,globalThis,${JSON.stringify({ sessions: [item.scope.session_id] })})`],
    ]) { installed.add(name); detail[`${name}Observer`] = await evaluate(expression); }
    const fixture = server.createCase({ owner: "native-host-loss", variant: "root" }), recorder = recorderFor(browser), tab = await recorder.createTab();
    Object.assign(item, { variant: "root", key: fixture.key, owner: fixture.owner, tabId: tab.id, backgroundWindows: recorder.records,
      sourceURL: new URL(fixture.urlPath, fixtureURL).href, childURL: new URL("/created-page/child", fixtureURL).href });
    item.createdTab = await evaluate(`chrome.tabs.get(${tab.id})`); assert.equal(item.createdTab.groupId, -1);
    item.sourceClaim = await evaluate(`__integrationBackend.auxiliaryTabs.owner(${tab.id})`);
    assert.equal(item.sourceClaim.kind, "background-window"); assert.equal(item.sourceClaim.origin, "agent");
    item.observerReady = await evaluate(`__createdPageProvenance.register(${tab.id})`);
    await browser.cdp.navigate(tab.id, item.sourceURL);
    const deadline = performance.now() + 20000; detail.originalBudget = { startedAt: Date.now(), budgetMs: 20000 };
    item.sourceBefore = await read(tab, deadline); assert.deepEqual(item.sourceBefore.clicks, []); assert.deepEqual(item.sourceBefore.frameAdds, []);
    item.framesBefore = await frames(tab.id); item.sourceFrame = item.framesBefore.find(frame => frame.frameId === 0);
    assert.equal(item.sourceFrame.url, item.sourceURL); assert.ok(item.sourceFrame.documentId);
    item.sourceHTML = server.stats(item.key).documents.filter(document => document.nonce === item.sourceBefore.sourceNonce);
    assert.equal(item.sourceHTML.length, 1);
    const html = item.sourceHTML[0], bytes = Buffer.from(html.base64, "base64"); assert.equal(bytes.length, html.bytes);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), html.sha256); assert.ok(bytes.includes(Buffer.from(item.sourceBefore.sourceNonce)));
    const waiter = await createdPageAction(deadline, () => tab.expectPage({ timeoutMs: Math.floor(deadline - performance.now()) })); item.waiterId = waiter.waiterId;
    await createdPageAction(deadline, options => tab.locator("#open-child").click({ ...options, modifiers: ["Control"] }));
    item.matched = await wait(async () => {
      const value = await originalRecord(); assert.ok(value); assert.equal(value.invalid, false, value.error ?? "Waiter invalidated");
      return value.state === "matched" ? value : null;
    }, deadline, "Original child did not match");
    assert.equal(item.matched.delivered, false); item.childId = item.matched.result.tabId;
    item.sourceAfter = await read(tab, deadline); item.events = (await evaluate("__createdPageProvenance.snapshot()")).events;
    assert.equal(assertCreatedPageSource({ item, events: item.events, afterFrames: await frames(tab.id), sourceState: item.sourceAfter }), item.childId);
    item.adopted = await ownership();
    assert.equal(item.adopted.tab.active, false); assert.equal(item.adopted.tab.groupId, -1); assert.equal(item.adopted.tab.windowId, item.createdTab.windowId);
    assert.equal(item.adopted.owner.kind, "created-page"); assert.equal(item.adopted.owner.origin, "user");
    assert.deepEqual(item.adopted.entry, item.adopted.owner); assert.deepEqual(item.adopted.stored, [item.adopted.owner]);
    assert.equal(item.adopted.targets.some(target => target.tabId === item.childId && target.attached), false);
    item.childFrames = await wait(async () => { const value = await frames(item.childId); return value.some(frame => frame.frameId === 0 && frame.url === item.childURL && frame.documentId) ? value : null; }, deadline, "Original child document did not commit");
    item.childFrame = item.childFrames.find(frame => frame.frameId === 0);
    detail.before = await identity(); detail.focusBeforeKill = await readFocus();
    detail.preKill = await originalRecord(); assert.equal(detail.preKill.state, "matched"); assert.equal(detail.preKill.invalid, false);
    assert.equal(detail.preKill.delivered, false); assert.ok(detail.preKill.remainingMs >= 5000);
    installed.add("loss"); detail.lossObserver = await evaluate(`(${installNativeCreatedPageLossObserver.toString()})(__integrationBackend,globalThis,${JSON.stringify({ waiterId: item.waiterId, childId: item.childId, claimId: item.adopted.owner.claimId })})`);
    detail.termination = await createdPageAction(deadline, () => terminateHost());
    // Do not wait for endpoint replacement here: only the existing worker's
    // passively observed original failure and actual cleanup can satisfy this.
    detail.immediate = await wait(async () => {
      const value = await evaluate("__nativeCreatedPageLoss.snapshot()"); assert.equal(value.overflow, false); assert.deepEqual(value.errors, []);
      return value.rows.some(row => row.kind === "nativeDisconnected-fulfilled") && value.rows.some(row => row.kind === "cleanup-fulfilled") ? value : null;
    }, deadline, "Native disconnect did not clean the original waiter promptly");
    detail.immediateChecks = assertNativeCreatedPageImmediateLoss(detail.immediate);
    detail.immediateOwnership = await createdPageAction(deadline, () => ownership());
    assertNativeCreatedPageRetired({ item, snapshot: detail.immediateOwnership, sourceFrames: await frames(item.tabId), childFrames: await frames(item.childId) });
    detail.immediateObservedAt = Date.now(); await saveDetail(detail);
    detail.oldSDK = await requireNativeCreatedPageRejection(() => browser.client.request("getTabs", { ...item.scope }, { timeoutMs: 1500 }), /closed|disconnected|not connected|connection|pipe|socket|EOF/i);
    detail.reconnection = await reconnectHost(detail.termination.previous);
    detail.after = await identity();
    for (const key of ["browserPid", "browserId", "extensionId", "extensionInstanceId", "workerTarget", "contextId", "incarnation", "observerTarget"])
      assert.equal(detail.after[key], detail.before[key], `Native host loss changed ${key}`);
    assert.equal(detail.after.lifecycle.bootId, detail.before.lifecycle.bootId);
    assert.notEqual(detail.after.host.pid, detail.before.host.pid); assert.notEqual(detail.after.host.socketPath, detail.before.host.socketPath);
    fresh = await connect(item.scope.session_id); clients.push(fresh);
    const params = { ...item.scope, tabId: item.tabId, waiterId: item.waiterId }, reject = requireNativeCreatedPageRejection;
    detail.oldScope = {
      attach: await reject(() => fresh.client.request("attach", { ...item.scope, tabId: item.childId }, { timeoutMs: 2000 }), /OBU_STALE_CONTROL_EPOCH/),
      cancel: await reject(() => fresh.client.request("cancelPageWait", params, { timeoutMs: 2000 }), /OBU_STALE_CONTROL_EPOCH/),
      collect: await reject(() => fresh.client.request("collectPageWait", params, { timeoutMs: 2000 }), /OBU_PAGE_WAIT_EXPIRED|OBU_NATIVE_CONNECTION_LOST/),
    };
    await fresh.client.beginTurn(); item.recoveredScope = scopeOf(fresh); assert.ok(item.recoveredScope.control_epoch > item.scope.control_epoch);
    const freshDeadline = performance.now() + 20000;
    detail.fresh = { tabs: await fresh.getTabs(), ownership: await ownership(), sourceFrames: await frames(item.tabId), childFrames: await frames(item.childId) };
    assertNativeCreatedPageRetired({ item, snapshot: detail.fresh.ownership, ...detail.fresh });
    detail.fresh.attach = await reject(() => fresh.client.request("attach", { tabId: item.childId }, { timeoutMs: 2000 }), /not part of browser session|OBU_AUXILIARY_/);
    detail.fresh.source = await read(fresh.tab(item.tabId), freshDeadline); assert.deepEqual(detail.fresh.source, item.sourceAfter);
    const rearmed = await createdPageAction(freshDeadline, options => fresh.tab(item.tabId).expectPage(options));
    detail.fresh.rearmedWaiterId = rearmed.waiterId; assert.notEqual(rearmed.waiterId, item.waiterId);
    await createdPageAction(freshDeadline, () => rearmed.cancel()); detail.fresh.rearmedCancelled = true;
    detail.fresh.afterRearm = { snapshot: await ownership(), sourceFrames: await frames(item.tabId), childFrames: await frames(item.childId) };
    assertNativeCreatedPageRetired({ item, ...detail.fresh.afterRearm });
    detail.focusAfterRecovery = await readFocus();
  } catch (error) { failure = error; detail.error = errorText(error); }
  finally {
    const cleanup = async (name, operation) => {
      const record = { name, startedAt: Date.now() }; detail.cleanup.push(record);
      try { record.result = await operation(); record.ok = true; } catch (error) { record.error = errorText(error); failure ??= error; }
      finally { record.finishedAt = Date.now(); }
    };
    // Stop original-record observation before explicit finalization may invoke
    // unrelated cleanup, while retaining full native control through teardown.
    if (installed.has("loss")) await cleanup("loss-observer", async () => {
      detail.loss = await evaluate("globalThis.__nativeCreatedPageLoss?.stop() ?? null"); assert.ok(detail.loss);
      assert.equal(detail.loss.closed, true); assert.equal(detail.loss.restored, true); assert.equal(detail.loss.overflow, false); assert.deepEqual(detail.loss.errors, []);
      if (!failure) detail.lossChecks = assertNativeCreatedPageImmediateLoss(detail.loss, { stopped: true });
      return { closed: true, restored: true };
    });
    if (item.tabId !== undefined) await cleanup("formal-finalize", async () => {
      if (!fresh) { fresh = await connect(item.scope.session_id); clients.push(fresh); await fresh.client.beginTurn(); }
      return fresh.client.finalizeTabs([]);
    });
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
    for (const tabId of ids) await cleanup(`exact-tab-${tabId}`, () => evaluate(`(async()=>{let tab;try{tab=await chrome.tabs.get(${tabId})}catch(e){if(/No tab|Invalid tab/i.test(String(e)))return{alreadyClosed:true};throw e}const urls=${JSON.stringify([item.sourceURL, item.childURL].filter(Boolean))};if(!urls.includes(tab.url)&&!urls.includes(tab.pendingUrl))throw Error('Fixture tab changed before cleanup');await chrome.tabs.remove(${tabId});return{removed:tab}})()`));
    if (ids.length) await cleanup("exact-tabs-absent", async () => {
      const value = await evaluate("(async()=>({tabs:await chrome.tabs.query({}),windows:await chrome.windows.getAll({}),targets:await chrome.debugger.getTargets()}))()");
      assert.deepEqual(value.tabs.filter(tab => ids.includes(tab.id)), []);
      assert.deepEqual(value.targets.filter(target => ids.includes(target.tabId) && target.attached), []);
      if (item.createdTab) assert.deepEqual(value.windows.filter(window => window.id === item.createdTab.windowId), []);
      return value;
    });
    for (const client of clients) await cleanup("close-sdk", () => client.close());
    if (installed.has("nativeControl")) await cleanup("native-control-observer", async () => {
      detail.nativeControl = await evaluate("__createdPageNativeControl.stop()");
      assert.equal(detail.nativeControl.closed, true); assert.equal(detail.nativeControl.restored, true); assert.equal(detail.nativeControl.listenersRemoved, true);
      assert.equal(detail.nativeControl.overflow, false); assert.deepEqual(detail.nativeControl.errors, []); assert.deepEqual(detail.nativeControl.pendingOperations, []);
      if (item.childId !== undefined) {
        assert.deepEqual(detail.nativeControl.records.filter(row => row.kind === "call" && row.api === "debugger.attach" && row.args?.[0]?.tabId === item.childId), []);
        assert.deepEqual(detail.nativeControl.records.filter(row => row.kind === "call" && row.api === "debugger.sendCommand" && row.args?.[0]?.tabId === item.childId && /^(Input\.|Runtime\.(evaluate|callFunctionOn)$)/.test(row.args?.[1])), []);
      }
      return { closed: true, restored: true };
    });
    await cleanup("fixture-ledger", async () => {
      detail.server = server.allStats(); assert.equal(detail.server.overflow, false);
      assert.equal(detail.server.children.length, 1); assert.deepEqual(detail.server.children.flatMap(child => child.posts), []);
      assert.equal(detail.server.requests.filter(request => request.method !== "GET").length, 0);
      const child = detail.server.children[0], html = Buffer.from(child.html.base64, "base64");
      assert.equal(child.get.status, 200); assert.equal(child.get.finished, true); assert.equal(child.get.aborted, false);
      assert.equal(child.get.url, "/created-page/child"); assert.deepEqual(child.html, child.get.response);
      assert.equal(html.length, child.html.bytes); assert.equal(createHash("sha256").update(html).digest("hex"), child.html.sha256);
      assert.ok(html.includes(Buffer.from(child.nonce))); assert.equal(child.consumed, false);
      return { children: detail.server.children.length, posts: 0 };
    });
    detail.finishedAt = Date.now(); detail.lifecycleVerified = !failure;
    try { await saveDetail(detail); } catch (error) { failure ??= error; detail.lifecycleVerified = false; }
  }
  if (failure) { failure.nativeCreatedPageLossDetail = detail; throw failure; } return detail;
}
