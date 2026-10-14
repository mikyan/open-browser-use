import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { frameTargetURLs } from "./frame-target-feedback-fixture.mjs";

// Passive observer: retain the original API Promise and native sender identity.
// It never answers a message, changes its arguments or performs visual cleanup.
export function installVisualNavigationObserver(api, target, id) {
  if (target.__obuVisualNavigation) throw Error("Visual navigation observer already installed");
  const original = api.tabs.sendMessage, records = []; let sequence = 0, pending = 0, overflow = false;
  const append = row => { if (records.length >= 2048) overflow = true; else records.push({ sequence: ++sequence, ...structuredClone(row) }); };
  function wrapper(...args) {
    const [tabId, message, options] = args;
    if (!/^OPEN_BROWSER_USE_(?:PING|CURSOR|POINTER_EVENT|TARGET_RECT)/.test(message?.type ?? "")) return Reflect.apply(original, this, args);
    if (records.length >= 2048) { overflow = true; return Reflect.apply(original, this, args); }
    const call = ++sequence; records.push({ sequence: call, kind: "call", tabId, message: structuredClone(message), options: structuredClone(options ?? null) });
    let promise;
    try { promise = Reflect.apply(original, this, args); }
    catch (error) { append({ kind: "settled", call, ok: false, error: String(error) }); throw error; }
    pending++;
    Promise.prototype.then.call(promise, value => { pending--; append({ kind: "settled", call, ok: true, value }); },
      error => { pending--; append({ kind: "settled", call, ok: false, error: String(error) }); });
    return promise;
  }
  const listener = (message, sender) => {
    if (message?.type === "OPEN_BROWSER_USE_VISUAL_RETIRED") append({ kind: "retired", message,
      sender: { tabId: sender.tab?.id, frameId: sender.frameId, documentId: sender.documentId, url: sender.url } });
    return false;
  };
  const originalCommand = api.debugger?.sendCommand;
  function commandWrapper(...args) {
    const [source, method, params] = args;
    if (!["Page.navigate", "Page.navigateToHistoryEntry", "Page.getNavigationHistory", "Page.getFrameTree", "Runtime.enable"].includes(method)) return Reflect.apply(originalCommand, this, args);
    if (records.length >= 2048) { overflow = true; return Reflect.apply(originalCommand, this, args); }
    const call = ++sequence; records.push({ sequence: call, kind: "native-call", source: structuredClone(source), method, params: structuredClone(params ?? {}) });
    let promise;
    try { promise = Reflect.apply(originalCommand, this, args); }
    catch (error) { append({ kind: "native-settled", call, ok: false, error: String(error) }); throw error; }
    pending++;
    Promise.prototype.then.call(promise, value => { pending--; append({ kind: "native-settled", call, ok: true, value }); }, error => { pending--; append({ kind: "native-settled", call, ok: false, error: String(error) }); });
    return promise;
  }
  const nativeEvent = (source, method, params) => {
    if (["Page.frameNavigated", "Page.frameDetached", "Page.frameAttached", "Page.lifecycleEvent", "Page.loadEventFired", "Runtime.executionContextCreated", "Runtime.executionContextDestroyed", "Runtime.executionContextsCleared"].includes(method)) append({ kind: "native-event", source, method, params });
  };
  const originalScript = api.scripting?.executeScript;
  function scriptWrapper(...args) {
    const [options] = args;
    const source = typeof options?.func === "function" ? options.func.toString() : "";
    if (options?.world !== "ISOLATED" || options.files || !source.includes("open-browser-use.cursor.receiver")) return Reflect.apply(originalScript, this, args);
    if (records.length >= 2048) { overflow = true; return Reflect.apply(originalScript, this, args); }
    const call = ++sequence; records.push({ sequence: call, kind: "presence-call", target: structuredClone(options.target), world: options.world, source });
    let promise;
    try { promise = Reflect.apply(originalScript, this, args); }
    catch (error) { append({ kind: "presence-settled", call, ok: false, error: String(error) }); throw error; }
    pending++;
    Promise.prototype.then.call(promise, value => { pending--; append({ kind: "presence-settled", call, ok: true, value }); },
      error => { pending--; append({ kind: "presence-settled", call, ok: false, error: String(error) }); });
    return promise;
  }
  const snapshot = () => structuredClone({ id, pending, overflow, records });
  const controller = { snapshot, restore() {
    if (pending || api.tabs.sendMessage !== wrapper || target.__obuVisualNavigation !== controller) throw Error("Original visual navigation observer is not settled/current");
    if (originalCommand && api.debugger.sendCommand !== commandWrapper) throw Error("Original navigation command observer changed");
    if (originalScript && api.scripting.executeScript !== scriptWrapper) throw Error("Original presence observer changed");
    api.tabs.sendMessage = original; api.runtime.onMessage.removeListener(listener); delete target.__obuVisualNavigation;
    if (originalCommand) { api.debugger.sendCommand = originalCommand; api.debugger.onEvent.removeListener(nativeEvent); }
    if (originalScript) api.scripting.executeScript = originalScript;
    return { ...snapshot(), restored: true };
  } };
  api.tabs.sendMessage = wrapper; api.runtime.onMessage.addListener(listener); target.__obuVisualNavigation = controller;
  if (originalCommand) { api.debugger.sendCommand = commandWrapper; api.debugger.onEvent.addListener(nativeEvent); }
  if (originalScript) api.scripting.executeScript = scriptWrapper;
  return snapshot();
}

export async function checkVisualNavigation({ connectBrowser, getWorker, fixtureURL, fixtures, until, saveDetail, closeTab }) {
  const detail = { id: randomUUID(), stages: [], cleanupErrors: [], boundary: "Real public goto/back and original pagehide receipts. BFCache is claimed only if the original native document and passive pageshow.persisted witness are both retained." };
  let owner, tab, installed = false, failure;
  const json = JSON.stringify;
  const snapshot = () => getWorker().evaluate("globalThis.__obuVisualNavigation.snapshot()");
  const visual = async documentId => {
    const rows = await getWorker().evaluate(`chrome.scripting.executeScript({target:{tabId:${tab.id},documentIds:[${json(documentId)}]},world:'MAIN',func:()=>{const tree=document.getElementById('open-browser-use-cursor-root')?.shadowRoot,cursor=tree?.querySelector('[data-testid="browser-agent-cursor"]');return {state:window.frameTargetFeedbackState(),restorations:window.__visualNavigationRestorations??[],visual:{opacity:cursor?getComputedStyle(cursor).opacity:null,layers:tree?.querySelectorAll(':popover-open').length??0,rings:tree?.querySelectorAll('[data-testid="browser-agent-click"]').length??0}}}})`);
    assert.equal(rows.length, 1); assert.equal(rows[0].documentId, documentId); return rows[0].result;
  };
  const stage = async (name, urls) => {
    detail.phase = `stage-${name}`;
    await tab.frameLocator("#frame").locator("#submit").waitFor({ state: "visible", timeoutMs: 5000 });
    // Chromium's extension inventory can omit a restored local child. The visual
    // receiver is the exact root document; the native tree proves the leaf route.
    const frames = await until(async () => {
      const rows = await getWorker().evaluate(`chrome.webNavigation.getAllFrames({tabId:${tab.id}})`);
      const roots = rows.filter(row => row.frameId === 0 && row.parentFrameId === -1 && row.url === urls.root && row.documentLifecycle === "active" && !row.errorOccurred && row.documentId);
      return roots.length === 1 ? roots : false;
    }, `visual navigation ${name} root document`, 5000);
    const nativeTree = await getWorker().evaluate(`chrome.debugger.sendCommand({tabId:${tab.id}},'Page.getFrameTree')`);
    assert.equal(nativeTree.frameTree.frame.url, urls.root);
    assert.equal(nativeTree.frameTree.childFrames.length, 1);
    assert.equal(nativeTree.frameTree.childFrames[0].frame.url, urls.leaf);
    assert.equal(nativeTree.frameTree.childFrames[0].frame.parentId, nativeTree.frameTree.frame.id);
    const beforeSequence = (await snapshot()).records.at(-1)?.sequence ?? 0;
    await tab.frameLocator("#frame").locator("#submit").hover();
    const delivered = await until(async () => {
      const trace = await snapshot(), call = trace.records.filter(row => row.kind === "call" && row.sequence > beforeSequence && row.tabId === tab.id && row.options?.documentId === frames[0].documentId && row.message.type === "OPEN_BROWSER_USE_CURSOR").at(-1);
      if (!call) return false;
      const ack = trace.records.find(row => row.kind === "settled" && row.call === call.sequence);
      if (!ack) return false;
      assert.equal(ack.ok, true); assert.equal(ack.value?.ok, true); return { call, ack };
    }, `visual navigation ${name} original hover acknowledgement`, 5000);
    const state = await until(async () => { const value = await visual(frames[0].documentId); return value.visual.opacity === "1" && value.visual.layers === 1 ? value : false; }, `visual navigation ${name} visible`, 5000);
    const token = delivered.call.message.receiverToken; assert.equal(typeof token, "string"); assert.ok(token);
    const value = { name, frames, nativeTree, state, receiverToken: token, beforeSequence, callSequence: delivered.call.sequence, ackSequence: delivered.ack.sequence }; detail.stages.push(value); return value;
  };
  try {
    owner = await connectBrowser(); await owner.client.beginTurn("visual-navigation");
    await getWorker().evaluate(`(${installVisualNavigationObserver.toString()})(chrome,globalThis,${json(detail.id)})`); installed = true;
    const keys = [0, 1].map(() => `frame-feedback-${randomUUID().replaceAll("-", "")}`);
    detail.urls = keys.map(key => frameTargetURLs(fixtureURL, key, "same")); detail.keys = keys;
    tab = await owner.newTab({ url: detail.urls[0].root }); detail.tabId = tab.id;
    const first = await stage("first", detail.urls[0]);
    await tab.evaluate("window.__visualNavigationRestorations=[];window.addEventListener('pageshow',event=>window.__visualNavigationRestorations.push({persisted:event.persisted}));");
    detail.phase = "goto-second"; detail.goto = await tab.goto(detail.urls[1].root); await stage("second", detail.urls[1]);
    detail.phase = "goBack"; detail.back = await tab.goBack(); const returned = await stage("returned", detail.urls[0]);
    detail.bfcacheRestored = returned.frames[0].documentId === first.frames[0].documentId && returned.state.restorations.some(row => row.persisted);
    if (returned.frames[0].documentId === first.frames[0].documentId) {
      assert.notEqual(returned.receiverToken, first.receiverToken, "Restoration reused a retired visual token");
      for (const frame of ["frame", "child"]) {
        const pick = row => frame === "frame" ? row.nativeTree.frameTree.frame : row.nativeTree.frameTree.childFrames[0].frame;
        assert.deepEqual([pick(returned).id, pick(returned).loaderId], [pick(first).id, pick(first).loaderId], "The original root and local child loaders must survive BFCache");
      }
    }
    detail.ended = await owner.client.turnEnded(); detail.hidden = await visual(returned.frames[0].documentId);
    assert.equal(detail.hidden.visual.opacity, "0"); assert.equal(detail.hidden.visual.layers, 0); assert.equal(detail.hidden.visual.rings, 0);
    detail.trace = await snapshot(); assert.equal(detail.trace.overflow, false);
    for (const departed of detail.stages.slice(0, 2)) {
      const receipts = detail.trace.records.filter(row => row.kind === "retired" && row.sender.tabId === tab.id && row.sender.documentId === departed.frames[0].documentId && row.message.receiverToken === departed.receiverToken);
      assert.equal(receipts.length, 1, "Original document must confirm retirement of its actual receiver token");
    }
    const hide = detail.trace.records.filter(row => row.kind === "call" && row.tabId === tab.id && row.options?.documentId === returned.frames[0].documentId && row.message.type === "OPEN_BROWSER_USE_CURSOR_STATE" && row.message.state?.isVisible === false && row.message.receiverToken === returned.receiverToken).at(-1);
    assert.ok(hide); const ack = detail.trace.records.filter(row => row.kind === "settled" && row.call === hide.sequence); assert.equal(ack.length, 1); assert.equal(ack[0].ok, true); assert.deepEqual(ack[0].value, { ok: true, receiverToken: returned.receiverToken });
    detail.server = keys.map(key => fixtures.stats(key)); assert.ok(detail.server.every(row => row.posts.length === 0), "Navigation replayed a business submission");
  } catch (error) {
    failure = error; detail.error = error.stack ?? String(error);
    if (tab) try { detail.failureDocument = await getWorker().evaluate(`(async()=>({tab:await chrome.tabs.get(${tab.id}),frames:await chrome.webNavigation.getAllFrames({tabId:${tab.id}}),nativeTree:await chrome.debugger.sendCommand({tabId:${tab.id}},'Page.getFrameTree')}))()`); } catch (readError) { detail.failureReadError = String(readError); }
  }
  finally {
    const cleanup = async (name, fn) => { try { return await fn(); } catch (error) { detail.cleanupErrors.push({ name, error: String(error) }); failure ??= error; } };
    if (installed) await cleanup("restore-observer", async () => { detail.trace = await getWorker().evaluate("globalThis.__obuVisualNavigation.restore()"); });
    if (tab) await cleanup("close-exact-tab", () => closeTab(tab));
    if (owner) { await cleanup("finalize-owner", async () => { await owner.client.beginTurn("visual-navigation-cleanup"); detail.finalized = await owner.client.finalizeTabs([]); }); await cleanup("close-owner", () => owner.close()); }
    if (tab) await cleanup("exact-native-absence", async () => { detail.inventory = await getWorker().evaluate(`(async()=>({tabs:(await chrome.tabs.query({})).filter(t=>t.id===${tab.id}),targets:(await chrome.debugger.getTargets()).filter(t=>t.tabId===${tab.id})}))()`); assert.deepEqual(detail.inventory, { tabs: [], targets: [] }); });
    await saveDetail(detail);
  }
  if (failure) throw failure;
  return detail;
}
