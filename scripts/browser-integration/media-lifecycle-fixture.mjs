import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const inlineImage = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";
const sourceChanged = /OBU_MEDIA_SOURCE_CHANGED|OBU_MEDIA_DOCUMENT_CHANGED|OBU_DOWNLOAD_EXPIRED|OBU_MEDIA_CANCELLED/;
const injection = "test-injected delivery hold after the real captureImageBinding Runtime.callFunctionOn has settled; not an unresolved native command";
const pageObservation = "fixture-only chrome.scripting MAIN-world fixed read on the exact test tab; no SDK admission or debugger reattachment";

async function readFixturePage(worker, tabId) {
  const results = await worker.evaluate(`chrome.scripting.executeScript({
    target:{tabId:${JSON.stringify(tabId)}},world:'MAIN',
    func:()=>({url:location.href,readyState:document.readyState,events:globalThis.mediaEvents,traps:globalThis.getterTraps})
  })`);
  assert.equal(results.length, 1, "read only the exact fixture root document");
  assert.equal(results[0].frameId, 0);
  assert.equal(typeof results[0].documentId, "string");
  return { ...results[0].result, documentId: results[0].documentId };
}

async function installHold(worker, tabId, probeId) {
  await worker.evaluate(`(() => {
    if (globalThis.__mediaLifecycle) throw new Error('Media lifecycle probe already installed');
    const original = chrome.debugger.sendCommand;
    const probe = globalThis.__mediaLifecycle = { original, id: ${JSON.stringify(probeId)}, tabId: ${JSON.stringify(tabId)}, seen: 0, held: false,
      released: false, nativeSettled: false, nativeObjectId: null, target: null, releaseCalls: [], contextEvents: [], sequence: 0, overflow: false };
    const push = event => { if (probe.releaseCalls.length >= 128) probe.overflow = true; else probe.releaseCalls.push(event); };
    const objectContexts = new Map();
    const routeKey = (target, objectId) => JSON.stringify([target.tabId,target.sessionId ?? null,objectId]);
    probe.onEvent = (source, method, params) => {
      if (source.tabId !== probe.tabId || !['Runtime.executionContextDestroyed','Runtime.executionContextsCleared'].includes(method)) return;
      if (probe.contextEvents.length >= 128) { probe.overflow = true; return; }
      probe.contextEvents.push({sequence:++probe.sequence, method, target:{tabId:source.tabId,...(source.sessionId === undefined ? {} : {sessionId:source.sessionId})},
        ...(method === 'Runtime.executionContextDestroyed' ? {executionContextId:params.executionContextId,executionContextUniqueId:params.executionContextUniqueId} : {})});
    };
    chrome.debugger.onEvent.addListener(probe.onEvent);
    probe.wrapper = async function(target, method, params) {
      if (target.tabId !== probe.tabId) return original.call(chrome.debugger, target, method, params);
      const capture = method === 'Runtime.callFunctionOn' && typeof params?.functionDeclaration === 'string' &&
        params.functionDeclaration.includes('function captureImageBinding(');
      const captureIndex = capture ? ++probe.seen : 0;
      const contextId = method === 'Runtime.evaluate' ? params?.contextId : method === 'Runtime.callFunctionOn'
        ? params?.executionContextId ?? objectContexts.get(routeKey(target,params?.objectId)) : undefined;
      const releasedObject = method === 'Runtime.releaseObject';
      const route = { tabId: target.tabId, ...(target.sessionId === undefined ? {} : { sessionId: target.sessionId }) };
      if (releasedObject) push({ phase: 'sent', target: route, objectId: params?.objectId });
      let result;
      try { result = await original.call(chrome.debugger, target, method, params); }
      catch (error) {
        if (releasedObject) push({ phase: 'failed', target: route, objectId: params?.objectId, error: String(error.message).slice(0, 512) });
        throw error;
      }
      if (Number.isSafeInteger(contextId) && contextId > 0 && result?.result?.objectId) {
        if (objectContexts.size >= 256) probe.overflow = true;
        else objectContexts.set(routeKey(target,result.result.objectId),contextId);
      }
      if (releasedObject) push({ phase: 'done', target: route, objectId: params?.objectId });
      if (captureIndex === 1) {
        probe.nativeSettled = true;
        probe.nativeSettledSequence = ++probe.sequence;
        probe.executionContextId = contextId;
        probe.nativeObjectId = result?.result?.objectId ?? null;
        probe.nativeException = !!result?.exceptionDetails;
        probe.target = route;
        probe.held = true;
        await new Promise(resolve => { probe.release = () => { probe.released = true; resolve(); }; });
      }
      return result;
    };
    chrome.debugger.sendCommand = probe.wrapper;
  })()`);
}

async function trace(worker, probeId) {
  return worker.evaluate(`(() => {
    const p = globalThis.__mediaLifecycle;
    if (!p || p.id !== ${JSON.stringify(probeId)}) throw new Error('Media lifecycle probe is unavailable or replaced');
    return { probeId:p.id, tabId:p.tabId, seen:p.seen, held:p.held, released:p.released, nativeSettled:p.nativeSettled,
      nativeObjectId:p.nativeObjectId, nativeException:p.nativeException, target:p.target,
      nativeSettledSequence:p.nativeSettledSequence, executionContextId:p.executionContextId,
      releaseCalls:p.releaseCalls, contextEvents:p.contextEvents, overflow:p.overflow };
  })()`);
}

async function unblock(worker, probeId) {
  await worker.evaluate(`(() => {
    const p=globalThis.__mediaLifecycle;
    if (!p) return;
    if (p.id !== ${JSON.stringify(probeId)}) throw new Error('Media lifecycle probe was replaced');
    p.release?.();
  })()`);
}

async function restore(worker, probeId) {
  await worker.evaluate(`(() => {
    const p=globalThis.__mediaLifecycle;
    if (!p) return;
    if (p.id !== ${JSON.stringify(probeId)}) throw new Error('Media lifecycle probe was replaced');
    p.release?.();
    chrome.debugger.onEvent.removeListener(p.onEvent);
    if (chrome.debugger.sendCommand !== p.wrapper) throw new Error('Media lifecycle probe wrapper was replaced');
    chrome.debugger.sendCommand=p.original;
    delete globalThis.__mediaLifecycle;
  })()`);
}

function assertExactCleanup(detail) {
  const native = detail.native;
  assert.equal(native.overflow, false);
  assert.equal(native.seen, 1, "a selected source must not be resolved again after mutation or cancellation");
  assert.equal(native.nativeSettled, true);
  assert.equal(native.nativeException, false);
  assert.equal(typeof native.nativeObjectId, "string");
  assert.ok(native.nativeObjectId.length > 0);
  const release = native.releaseCalls.filter(event => event.objectId === native.nativeObjectId);
  for (const event of release) assert.deepEqual(event.target, native.target);
  const destroyed = native.contextEvents.filter(event => event.sequence > native.nativeSettledSequence &&
    event.target.tabId === native.target.tabId && event.target.sessionId === native.target.sessionId &&
    (event.method === "Runtime.executionContextsCleared" ||
      (Number.isSafeInteger(native.executionContextId) && event.executionContextId === native.executionContextId)));
  if (detail.name === "document-navigation" && destroyed.length) {
    assert.ok(Number.isSafeInteger(native.executionContextId) && native.executionContextId > 0,
      "navigation cleanup requires a native context ID associated with this exact capture receiver");
    assert.ok(["", "sent,done", "sent,failed"].includes(release.map(event => event.phase).join(",")), "unexpected native release retry");
    detail.cleanupProof = { kind: "native-context-destruction", executionContextId: native.executionContextId, events: destroyed };
  } else {
    assert.deepEqual(release.map(event => event.phase), ["sent", "done"], "the original native source object must be released exactly once");
    detail.cleanupProof = { kind: "native-release", objectId: native.nativeObjectId };
  }
}

async function runCase(options, name) {
  const { browser, fixtureURL, server, worker, until } = options;
  const probeId = randomUUID();
  const detail = { name, probeId, faultInjection: injection, pageObservation };
  let tab, before, outcome, pending, ending, endAcknowledged = false, installed = false, failure;
  const end = () => {
    if (!ending) {
      ending = browser.client.turnEnded().then(value => { endAcknowledged = true; return value; });
      // Error is still observed below, including actual cleanup uncertainty.
      ending.catch(() => {});
    }
    return ending;
  };
  try {
    tab = await browser.newTab({ url: fixtureURL + "media-downloads/page" });
    detail.tabId = tab.id;
    installed = true;
    await installHold(worker, tab.id, probeId);
    // Install before the first engine action so native injected-script receiver
    // creation supplies its explicit context ID for later navigation evidence.
    await tab.waitForLoadState({ state: "load" });
    before = server.stats().length;
    pending = tab.locator("#selected").downloadMedia({ filename: `media-lifecycle-${name}.png`, timeoutMs: 10000 })
      .then(value => { outcome = { succeeded: true, downloadId: value.downloadId }; }, error => { outcome = { error: error.message }; });
    await until(async () => (await trace(worker, probeId)).held, "real media source result held after native settlement");
    detail.held = await trace(worker, probeId);
    assert.equal(detail.held.nativeSettled, true);
    assert.equal(detail.held.nativeException, false);
    assert.equal(typeof detail.held.nativeObjectId, "string");
    if (name === "picture-source-change") {
      detail.mutation = await tab.evaluate(`(async () => {
        const image=document.querySelector('#selected'), source=image.closest('picture').querySelector('source');
        source.srcset=${JSON.stringify(inlineImage)};
        await image.decode();
        return {sameNode:image===document.querySelector('#selected'), srcset:source.getAttribute('srcset'), complete:image.complete, naturalWidth:image.naturalWidth};
      })()`, { awaitPromise: true });
      assert.equal(detail.mutation.sameNode, true);
      assert.equal(detail.mutation.srcset, inlineImage);
      assert.equal(detail.mutation.complete, true);
      assert.ok(detail.mutation.naturalWidth > 0);
    } else if (name === "node-replacement") {
      detail.mutation = await tab.evaluate(`(async () => {
        const original=document.querySelector('#selected'), replacement=document.createElement('img');
        replacement.id='selected';replacement.alt='Replacement media';replacement.src=${JSON.stringify(inlineImage)};
        original.closest('picture').replaceWith(replacement);
        await replacement.decode();
        return {oldConnected:original.isConnected,sameNode:original===document.querySelector('#selected'), replacementPresent:replacement===document.querySelector('#selected'),complete:replacement.complete};
      })()`, { awaitPromise: true });
      assert.deepEqual(detail.mutation, { oldConnected: false, sameNode: false, replacementPresent: true, complete: true });
    } else if (name === "document-navigation") {
      const url = fixtureURL + "media-downloads/page?navigation=media-lifecycle";
      detail.previousDocument = await readFixturePage(worker, tab.id);
      assert.equal(detail.previousDocument.url, fixtureURL + "media-downloads/page");
      // This is an external document mutation while a source resolver owns the
      // engine queue. A queued public goto would wait for our deliberately held
      // source and never exercise navigation cancellation.
      detail.navigationMutation = "fixture-only native Page.navigate on the exact source tab while media response delivery is held";
      detail.navigationAck = await worker.evaluate(`chrome.debugger.sendCommand({tabId:${JSON.stringify(tab.id)}},'Page.navigate',{url:${JSON.stringify(url)}})`);
      assert.equal(detail.navigationAck.errorText, undefined);
      assert.equal(typeof detail.navigationAck.frameId, "string");
      await until(async () => {
        detail.navigation = await readFixturePage(worker, tab.id);
        return detail.navigation.url === url && detail.navigation.readyState === "complete";
      }, "replacement fixture document is loaded while media result stays held");
      assert.equal(detail.navigation.url, url);
      assert.equal(detail.navigation.readyState, "complete");
      assert.notEqual(detail.navigation.documentId, detail.previousDocument.documentId, "the navigation must replace the actual source document");
    }
    if (name === "turn-end" || name === "document-navigation") {
      end();
      await until(() => outcome, "held media caller was cancelled");
      assert.match(outcome.error ?? "", sourceChanged);
      assert.equal(endAcknowledged, false, "turn end acknowledged before the held source result and exact native cleanup drained");
      detail.endWaitedForHeldDelivery = true;
    }
    await unblock(worker, probeId);
    await pending;
    assert.match(outcome.error ?? "", sourceChanged);
    if (ending) await ending;
    detail.native = await trace(worker, probeId);
    assertExactCleanup(detail);
    detail.outcome = outcome;
    detail.endAcknowledged = endAcknowledged;
    // An SDK evaluate here would attach again after turnEnded, and its focus
    // emulation would itself deliver a focus event to the page being observed.
    detail.page = await readFixturePage(worker, tab.id);
    assert.equal(detail.page.url, fixtureURL + "media-downloads/page" + (name === "document-navigation" ? "?navigation=media-lifecycle" : ""));
    assert.deepEqual(detail.page.events, []);
    assert.deepEqual(detail.page.traps, []);
  } catch (error) {
    failure = error;
    detail.error = error.message;
    if (name === "document-navigation") detail.knownLimitation = "Navigation may destroy the original context before exact handle release; unconfirmed cleanup is a failure, not a successful cancellation.";
  } finally {
    // If an assertion fails before mutation/end, cancel while delivery is still
    // held. Unblock before awaiting end: its real cleanup needs this response.
    if (pending && !ending) {
      end();
      if (!outcome) await until(() => outcome, "media fixture cleanup cancellation").catch(error => {
        detail.cleanupCancellationError = error.message; failure ??= error;
      });
    }
    if (installed) await unblock(worker, probeId).catch(error => { detail.unblockError = error.message; failure ??= error; });
    await pending;
    if (ending) await ending.catch(error => { detail.endError = error.message; failure ??= error; });
    if (installed) {
      await trace(worker, probeId).then(value => { detail.native = value; }, error => { detail.traceError = error.message; failure ??= error; });
      await restore(worker, probeId).catch(error => { detail.restoreError = error.message; failure ??= error; });
    }
    detail.outcome = outcome;
    detail.endAcknowledged = endAcknowledged;
    await browser.client.finalizeTabs([]).then(() => { detail.finalized = true; }, error => { detail.finalizeError = error.message; failure ??= error; });
    if (before !== undefined) detail.requests = server.stats().slice(before);
    // Assert the final retained evidence after actual control cleanup, so a late
    // GET or an unconfirmed release cannot be hidden by an earlier snapshot.
    if (!failure) {
      try {
        assertExactCleanup(detail);
        if (name === "document-navigation") {
          // A real navigation loads its own fixtures. Keep every HTTP request;
          // extension-created downloads have destination "empty".
          assert.ok(detail.requests.every(request => ["image", "video"].includes(request.destination)), "navigation must not start a downloads GET");
        } else assert.deepEqual(detail.requests, [], "source mutation/cancellation must not issue any new GET");
      } catch (error) { detail.finalEvidenceError = error.message; failure = error; }
    }
  }
  if (failure) { failure.mediaLifecycle = detail; throw failure; }
  return detail;
}

export async function checkMediaLifecycle(options) {
  const detail = { faultInjection: injection, cases: [] };
  for (const name of ["picture-source-change", "node-replacement", "turn-end"]) {
    try { detail.cases.push(await runCase(options, name)); }
    catch (error) { detail.failed = error.mediaLifecycle; error.mediaLifecycle = detail; throw error; }
  }
  return detail;
}

// Kept separate so an unresolved navigation cleanup does not disappear behind
// the successful source-mutation cases. Failure remains a failing test with the
// exact native response/release evidence attached to error.mediaLifecycle.
export async function checkMediaNavigationCleanup(options) {
  return runCase(options, "document-navigation");
}
