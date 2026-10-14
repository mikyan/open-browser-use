import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { frameTargetURLs, frameTargetGeometry, frameTargetRootPoint, selectFrameTargetDocuments,
  waitForFrameTargetFeedback, measureFrameTargetPixels, checkFrameTargetVisible } from "./frame-target-feedback-fixture.mjs";

export const coldRawLayouts = Object.freeze(["same", "oopif", "dynamic-oopif", "nested", "scaled-oopif", "rotated-oopif"]);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const errorText = error => error?.stack ?? String(error);
const center = rect => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
const nearPoint = (actual, expected, label) => { for (const key of ["x", "y"]) assert.ok(Number.isFinite(actual?.[key]) && Math.abs(actual[key] - expected[key]) <= 1.1, `${label} ${key}`); };

// Passive API observer. No native domains, sessions, input or renderer are
// enabled here. Each wrapper returns the original Chrome Promise unchanged.
export function installColdRawProbe(api, target, { id, tabId }) {
  if (target.__obuColdRawFeedback) throw Error("Cold raw observer already installed");
  const backend = target.__integrationBackend;
  if (!backend || backend.browserEngine !== null) throw Error("Cold raw requires an uncreated browser engine");
  const originals = { sendCommand: api.debugger.sendCommand, attach: api.debugger.attach, detach: api.debugger.detach };
  const nativeThen = Promise.prototype.then, records = [], wrappers = {};
  let anchor, pending = 0, overflow = false, recordingErrors = 0, restored = false, size = 0;
  const state = () => {
    const current = backend.attachmentEpochs.get(tabId);
    if (anchor === undefined && current !== undefined) anchor = current;
    return { backendCurrent: target.__integrationBackend === backend, engineAbsent: backend.browserEngine === null,
      attached: backend.attachedTabs.has(tabId), attachmentKnown: current !== undefined,
      originalAttachmentSeen: anchor !== undefined, sameAttachment: anchor === undefined ? null : current === anchor };
  };
  const append = row => {
    try { const value = { sequence: records.length + 1, ...row }, bytes = JSON.stringify(value).length;
      if (records.length >= 2048 || bytes > 2 * 1024 * 1024 || size + bytes > 12 * 1024 * 1024) { overflow = true; return null; }
      records.push(value); size += bytes; return value;
    } catch { recordingErrors++; return null; }
  };
  for (const name of Object.keys(originals)) {
    wrappers[name] = function (...args) {
      if (args[0]?.tabId !== tabId) return Reflect.apply(originals[name], this, args);
      const row = append({ kind: "invoke", method: name === "sendCommand" ? args[1] : `debugger.${name}`,
        source: structuredClone(args[0]), params: structuredClone(name === "sendCommand" ? args[2] ?? {} : { version: args[1] ?? null }), state: state() });
      let promise;
      try { promise = Reflect.apply(originals[name], this, args); }
      catch (error) { append({ kind: "settled", invocation: row?.sequence, ok: false, error: String(error), state: state() }); throw error; }
      pending++;
      try { nativeThen.call(promise, value => { pending--; append({ kind: "settled", invocation: row?.sequence, ok: true, result: structuredClone(value), state: state() }); },
        error => { pending--; append({ kind: "settled", invocation: row?.sequence, ok: false, error: String(error), state: state() }); }); }
      catch { pending--; recordingErrors++; }
      return promise;
    };
    api.debugger[name] = wrappers[name];
  }
  const eventMethods = new Set(["Page.frameNavigated", "Page.frameAttached", "Page.frameDetached", "Runtime.executionContextCreated", "Runtime.executionContextDestroyed", "Runtime.executionContextsCleared", "Target.attachedToTarget", "Target.detachedFromTarget"]);
  const onEvent = (source, method, params) => { if (source.tabId === tabId && eventMethods.has(method)) append({ kind: "event", source: structuredClone(source), method, params: structuredClone(params), state: state() }); };
  const onDetach = (source, reason) => { if (source.tabId === tabId) append({ kind: "detached", source: structuredClone(source), reason, state: state() }); };
  api.debugger.onEvent.addListener(onEvent); api.debugger.onDetach.addListener(onDetach);
  const snapshot = () => structuredClone({ id, tabId, records, pending, overflow, recordingErrors, restored, state: state() });
  const controller = { id, snapshot, mark(label) { const value = state(); append({ kind: "state", label, state: value }); return value; }, restore() {
    if (!restored) {
      for (const name of Object.keys(originals)) if (api.debugger[name] !== wrappers[name]) throw Error("Original cold raw observer was replaced");
      for (const name of Object.keys(originals)) api.debugger[name] = originals[name];
      api.debugger.onEvent.removeListener(onEvent); api.debugger.onDetach.removeListener(onDetach); restored = true;
    }
    const value = snapshot(); if (target.__obuColdRawFeedback === controller) delete target.__obuColdRawFeedback; return value;
  } };
  target.__obuColdRawFeedback = controller; return controller.mark("installed-before-navigation");
}

// The original page owns the business ledger. This read adds only the input's
// current geometry; it never focuses, edits, dispatches input or repairs UI.
export function readColdRawDocument() {
  const value = window.frameTargetFeedbackState?.();
  if (!value) return null;
  const control = id => { const node = document.getElementById(id); if (!node) return null; const rect = node.getBoundingClientRect(), style = getComputedStyle(node);
    return { connected: node.isConnected, token: node.dataset.token, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      styles: Object.fromEntries(["left", "top", "width", "height", "transform", "zoom", "boxSizing"].map(key => [key, style[key]])) }; };
  return { ...value, inputGeometry: control("note"), addGeometry: control("add") };
}

async function readDocuments(worker, tabId, frames) {
  const rows = await worker.evaluate(`chrome.scripting.executeScript({target:{tabId:${tabId},documentIds:${JSON.stringify(frames.map(frame => frame.documentId))}},world:'MAIN',func:${readColdRawDocument.toString()}})`);
  return frames.map(frame => {
    const matching = rows.filter(row => row.frameId === frame.frameId && row.documentId === frame.documentId);
    assert.equal(matching.length, 1); assert.ok(matching[0].result); assert.equal(matching[0].result.business.href, frame.url);
    return { ...matching[0].result, nativeFrameId: frame.frameId, nativeDocumentId: frame.documentId, nativeProcessId: frame.processId };
  });
}

export function coldRawInputPoint(documents, layout) {
  const input = documents.at(-1).inputGeometry;
  assert.equal(input.connected, true); assert.deepEqual(input.rect, { x: 46, y: 48, width: 280, height: 36 });
  assert.deepEqual(input.styles, { left: "46px", top: "48px", width: "280px", height: "36px", transform: "none", zoom: "1", boxSizing: "border-box" });
  assert.equal(input.token, `${documents[0].business.key}-leaf-note`);
  return frameTargetRootPoint(center(input.rect), documents, layout);
}

export function coldRawAddPoint(document) {
  assert.equal(document.business.role, "root"); assert.equal(document.geometry.frame, null);
  assert.equal(document.geometry.viewport.scrollX, 0); assert.equal(document.geometry.viewport.scrollY, 0);
  const add = document.addGeometry; assert.equal(add.connected, true); assert.equal(add.token, `${document.business.key}-root-add`);
  assert.deepEqual(add.rect, { x: 76, y: 20, width: 210, height: 32 });
  assert.deepEqual(add.styles, { left: "76px", top: "20px", width: "210px", height: "32px", transform: "none", zoom: "1", boxSizing: "border-box" });
  return center(add.rect);
}

export function checkColdRawBusiness(item) {
  const roles = item.layout === "nested" ? ["root", "middle", "leaf"] : ["root", "leaf"];
  assert.deepEqual(item.initial.map(row => row.business.role), roles);
  assert.equal(item.server.posts.length, 1); const post = item.server.posts[0], bytes = Buffer.from(post.bodyBase64, "base64");
  assert.equal(post.error, undefined); assert.equal(bytes.length, post.bodyBytes); assert.equal(hash(bytes), post.bodySHA256); assert.deepEqual(JSON.parse(bytes), post.value);
  for (const snapshot of [item.initial, item.before, item.rendered, item.after]) for (const [index, row] of snapshot.entries()) {
    const initial = item.initial[index], get = item.server.gets.find(value => value.role === roles[index]);
    for (const field of ["nativeDocumentId", "nativeFrameId", "nativeProcessId"]) assert.equal(row[field], initial[field]);
    for (const field of ["key", "layout", "role", "documentToken", "windowToken", "href"]) assert.equal(row.business[field], initial.business[field]);
    assert.equal(row.business.documentToken, get.documentToken); assert.equal(row.business.href, get.url); assert.equal(row.business.sameDocument, true); assert.equal(row.business.sameWindow, true);
    assert.deepEqual(row.business.nodes, initial.business.nodes); assert.ok(row.business.nodes.every(node => node.original && node.connected && node.token));
    assert.deepEqual(row.geometry, initial.geometry); assert.deepEqual(row.inputGeometry, initial.inputGeometry); assert.deepEqual(row.addGeometry, initial.addGeometry); assert.deepEqual(row.business.errors, []); assert.equal(row.business.overflow, false);
  }
  assert.ok(item.initial.slice(1).every(row => row.business.events.length === 0)); assert.equal(item.initial.at(-1).business.value, "");
  if (item.layout === "dynamic-oopif") {
    const original = item.preAdd[0], root = item.initial[0]; assert.equal(item.preAdd.length, 1); assert.deepEqual(original.business.events, []); assert.deepEqual(original.business.changes, []);
    assert.deepEqual(item.addPoint, coldRawAddPoint(original));
    for (const field of ["nativeDocumentId", "nativeFrameId", "nativeProcessId"]) assert.equal(root[field], original[field]);
    for (const field of ["documentToken", "windowToken", "href"]) assert.equal(root.business[field], original.business[field]);
    assert.deepEqual(original.business.nodes, root.business.nodes.filter(node => node.id === "add"));
    assert.deepEqual(root.business.events.map(event => [event.type, event.targetId]), [["pointerdown", "add"], ["pointerup", "add"], ["click", "add"]]);
    for (const event of root.business.events) { assert.equal(event.trusted, true); assert.equal(event.nodeToken, `${item.key}-root-add`); nearPoint(event, item.addPoint, "Original dynamic Add"); }
    assert.equal(root.business.changes.length, 1); const change = root.business.changes[0];
    assert.equal(change.type, "add-frame"); assert.equal(change.trusted, true); assert.equal(change.documentToken, original.business.documentToken); assert.equal(change.sourceNode, `${item.key}-root-add`); assert.equal(change.childURL, item.urls.leaf);
  } else assert.deepEqual(item.initial[0].business.events, []);
  for (let index = 0; index < roles.length; index++) {
    const before = item.before[index].business, rendered = item.rendered[index].business;
    for (const field of ["activeElement", "selection", "focus", "events"]) assert.deepEqual(rendered[field], before[field], `Original hover/capture ${field}`);
    assert.equal(before.activeElement, index === roles.length - 1 ? "note" : "frame");
  }
  const leaf = item.after.at(-1).business; assert.equal(leaf.value, item.value); assert.equal(item.before.at(-1).business.value, item.value);
  assert.deepEqual({ ...post.value.business, receipt: post.receipt }, leaf); assert.equal(post.value.trustedSubmit, true); assert.deepEqual(leaf.receipt, post.receipt);
  assert.deepEqual(leaf.events.map(row => [row.type, row.targetId]), [["pointerdown", "note"], ["pointerup", "note"], ["click", "note"], ["input", "note"], ["pointerdown", "submit"], ["pointerup", "submit"], ["click", "submit"], ["submit", "form"]]);
  for (const event of leaf.events) { assert.equal(event.trusted, true); assert.equal(event.nodeToken, `${item.key}-leaf-${event.targetId}`); }
  for (const [index, row] of item.after.slice(0, -1).entries()) { assert.deepEqual(row.business.events, item.initial[index].business.events); assert.deepEqual(row.business.changes, item.initial[index].business.changes); }
  for (const id of ["note", "submit"]) {
    const click = leaf.events.find(row => row.type === "click" && row.targetId === id), point = frameTargetRootPoint(click, item.after, item.layout);
    nearPoint(point, id === "note" ? item.inputPoint : item.buttonPoint, `Original ${id} click`);
    if (id === "submit") item.rootClick = point;
  }
}

export function checkColdRawNative(item, bytes) {
  const probe = item.native; assert.equal(probe.restored, true); assert.equal(probe.pending, 0); assert.equal(probe.overflow, false); assert.equal(probe.recordingErrors, 0);
  assert.ok(probe.records.every((row, index) => row.sequence === index + 1));
  for (const state of [...probe.records.map(row => row.state), probe.state]) { assert.equal(state.backendCurrent, true); assert.equal(state.engineAbsent, true); assert.notEqual(state.sameAttachment, false); }
  assert.equal(probe.state.attached, true); assert.equal(probe.state.originalAttachmentSeen, true); assert.equal(probe.state.sameAttachment, true);
  const calls = probe.records.filter(row => row.kind === "invoke"), acks = new Map();
  for (const call of calls) {
    const matching = probe.records.filter(row => row.invocation === call.sequence); assert.equal(matching.length, 1); const ack = matching[0];
    assert.equal(ack.kind, "settled"); assert.equal(ack.ok, true); assert.ok(ack.sequence > call.sequence); acks.set(call.sequence, ack);
  }
  assert.equal(probe.records.filter(row => row.kind === "settled").length, calls.length);
  assert.equal(calls.filter(row => row.method === "debugger.attach").length, 1); assert.equal(calls.filter(row => row.method === "debugger.detach").length, 0); assert.equal(probe.records.filter(row => row.kind === "detached").length, 0);
  const input = calls.filter(row => row.method.startsWith("Input.") || row.method === "Page.captureScreenshot");
  const expected = [...(item.layout === "dynamic-oopif" ? ["mouseMoved", "mousePressed", "mouseReleased"].map(type => ({ type, point: item.addPoint })) : []),
    ...["mouseMoved", "mousePressed", "mouseReleased"].map(type => ({ type, point: item.inputPoint })), { type: "Input.insertText" },
    { type: "mouseMoved", point: item.buttonPoint }, { type: "Page.captureScreenshot" }, ...["mousePressed", "mouseReleased"].map(type => ({ type, point: item.buttonPoint }))];
  assert.deepEqual(input.map(row => row.method === "Input.dispatchMouseEvent" ? row.params.type : row.method), expected.map(row => row.type));
  for (const [index, call] of input.entries()) {
    assert.deepEqual(call.source, { tabId: item.tabId }); if (index) assert.ok(acks.get(input[index - 1].sequence).sequence < call.sequence);
    if (call.method === "Input.insertText") assert.deepEqual(call.params, { text: item.value });
    else if (call.method === "Page.captureScreenshot") assert.deepEqual(Buffer.from(acks.get(call.sequence).result.data, "base64"), bytes);
    else { nearPoint(call.params, expected[index].point, "Original raw coordinate"); if (call.params.type !== "mouseMoved") { assert.equal(call.params.button, "left"); assert.equal(call.params.clickCount, 1); } }
  }
  const root = item.frameTree.frameTree.frame; assert.equal(root.url, item.urls.root); assert.ok(root.id); assert.ok(root.loaderId); assert.equal(root.loaderId, item.navigation.loaderId);
  assert.ok(probe.records.some(row => row.kind === "event" && row.method === "Page.frameNavigated" && row.source.tabId === item.tabId && row.params.frame.id === root.id && row.params.frame.loaderId === root.loaderId && row.params.frame.url === root.url), "Original root navigation event required");
  return { inputInvocations: input.map(row => row.sequence), inputACKs: input.map(row => acks.get(row.sequence).sequence), rootFrameId: root.id, rootLoaderId: root.loaderId };
}

export async function checkColdRawFeedback({ browser, getWorker, fixtureURL, fixtures, until, saveArtifact, saveDetail, checkEnd, closeTab }) {
  assert.equal(typeof closeTab, "function", "Cold cleanup must not reopen an SDK turn after End");
  const detail = { states: [], tabIds: [], childTargetIds: [], cleanup: [], boundary: "Cold public CDP only, before any browser engine creation. Original blank tabs, raw navigation/input/capture, exact-document passive reads and unchanged raw attachment. Native child sessions are observations, not fabricated CRX readiness. No input replay or focus allowance." };
  const tabs = []; let failure;
  const remember = (owner, field, error) => { owner[field] = errorText(error); failure ??= error; };
  try {
    detail.initialEngine = await getWorker().evaluate(`({engineAbsent:globalThis.__integrationBackend?.browserEngine===null})`); assert.equal(detail.initialEngine.engineAbsent, true);
    for (const layout of coldRawLayouts) {
      const key = `frame-feedback-${randomUUID().replaceAll("-", "")}`, urls = frameTargetURLs(fixtureURL, key, layout), item = { key, layout, urls, value: `Cold original ${layout} π note`, rpc: [] }; detail.states.push(item);
      const tab = await browser.newTab(); tabs.push(tab); item.tabId = tab.id; detail.tabIds.push(tab.id); const worker = getWorker(); let installed = false, bytes;
      const call = async (method, params = {}) => { const row = { method, params: structuredClone(params) }; item.rpc.push(row); try { const result = await browser.cdp.call(tab.id, method, params); row.ok = true; return result; } catch (error) { row.ok = false; row.error = errorText(error); throw error; } };
      const mark = label => worker.evaluate(`globalThis.__obuColdRawFeedback.mark(${JSON.stringify(label)})`);
      const pointer = async (type, point) => call("Input.dispatchMouseEvent", { type, ...point, ...(type === "mouseMoved" ? {} : { button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 }) });
      try {
        item.installed = await worker.evaluate(`(${installColdRawProbe.toString()})(chrome,globalThis,${JSON.stringify({ id: key, tabId: tab.id })})`); installed = true;
        item.navigation = await browser.cdp.navigate(tab.id, urls.root); item.afterNavigate = await mark("navigated");
        item.frameTree = await call("Page.getFrameTree");
        if (layout === "dynamic-oopif") {
          item.preAddFrames = await worker.evaluate(`chrome.webNavigation.getAllFrames({tabId:${tab.id}})`);
          assert.equal(item.preAddFrames.length, 1); const root = item.preAddFrames[0]; assert.equal(root.frameId, 0); assert.equal(root.url, urls.root); assert.equal(root.documentLifecycle, "active"); assert.ok(root.documentId); assert.equal(root.errorOccurred, false);
          item.preAdd = await readDocuments(worker, tab.id, item.preAddFrames); item.addPoint = coldRawAddPoint(item.preAdd[0]);
          for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await pointer(type, item.addPoint);
          item.afterAdd = await mark("dynamic-child-created");
        }
        await until(async () => { const all = await worker.evaluate(`chrome.webNavigation.getAllFrames({tabId:${tab.id}})`), frames = selectFrameTargetDocuments(all, urls, layout); if (!frames) return false; item.frames = frames; return true; }, "original cold frame documents committed", 5000);
        item.initial = await readDocuments(worker, tab.id, item.frames); item.geometry = frameTargetGeometry(item.initial, layout); item.inputPoint = coldRawInputPoint(item.initial, layout); item.buttonPoint = center(item.geometry.button);
        for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await pointer(type, item.inputPoint);
        await call("Input.insertText", { text: item.value }); item.afterInput = await mark("input"); item.before = await readDocuments(worker, tab.id, item.frames);
        await pointer("mouseMoved", item.buttonPoint);
        try { const rows = await worker.evaluate(`chrome.scripting.executeScript({target:{tabId:${tab.id},documentIds:[${JSON.stringify(item.frames[0].documentId)}]},world:'MAIN',func:${waitForFrameTargetFeedback.toString()},args:[${JSON.stringify({ ...item.buttonPoint, rectangle: item.geometry.button })}]})`); assert.equal(rows.length, 1); assert.equal(rows[0].documentId, item.frames[0].documentId); item.arrival = rows[0].result; }
        catch (error) { remember(item, "arrivalError", error); }
        // Even absent feedback retains its original PNG and single submission.
        const shot = await call("Page.captureScreenshot", { format: "png" }); assert.equal(typeof shot?.data, "string"); bytes = Buffer.from(shot.data, "base64"); item.artifact = `cold-raw-frame-${layout}.png`; await saveArtifact(item.artifact, bytes);
        item.rendered = await readDocuments(worker, tab.id, item.frames);
        for (const type of ["mousePressed", "mouseReleased"]) await pointer(type, item.buttonPoint);
        try { await until(async () => { item.after = await readDocuments(worker, tab.id, item.frames); return !!item.after.at(-1).business.receipt; }, "original cold form receipt", 5000); }
        catch (error) { remember(item, "receiptError", error); }
        item.after ??= await readDocuments(worker, tab.id, item.frames); item.afterSubmit = await mark("submitted"); item.server = fixtures.stats(key); item.pixels = measureFrameTargetPixels(bytes, item.geometry);
      } catch (error) { remember(item, "error", error); }
      finally {
        if (installed) try { item.native = await worker.evaluate(`(()=>{const probe=globalThis.__obuColdRawFeedback;if(probe?.id!==${JSON.stringify(key)})throw Error('Original cold observer changed');return probe.restore()})()`); } catch (error) { remember(item, "nativeError", error); }
        try { item.server = fixtures.stats(key); item.inventory = await worker.evaluate(`(async()=>({frames:await chrome.webNavigation.getAllFrames({tabId:${tab.id}}),targets:await chrome.debugger.getTargets(),engineAbsent:__integrationBackend.browserEngine===null}))()`); assert.equal(item.inventory.engineAbsent, true);
          if (item.frames) { const current = selectFrameTargetDocuments(item.inventory.frames, urls, layout); assert.ok(current); assert.deepEqual(current.map(frame => [frame.frameId, frame.documentId, frame.processId]), item.frames.map(frame => [frame.frameId, frame.documentId, frame.processId])); }
          item.childTargetIds = item.inventory.targets.filter(target => [urls.middle, urls.leaf].filter(Boolean).includes(target.url)).map(target => target.id); detail.childTargetIds.push(...item.childTargetIds);
        } catch (error) { remember(item, "identityError", error); }
      }
      if (item.after && bytes) for (const [name, check] of [["business", () => checkColdRawBusiness(item)], ["native", () => { item.nativeProof = checkColdRawNative(item, bytes); }], ["visible", () => checkFrameTargetVisible(item)]]) {
        try { check(); item[`${name}Passed`] = true; } catch (error) { item[`${name}Passed`] = false; remember(item, `${name}Error`, error); }
      }
    }
    if (detail.states.every(item => item.frames && item.after && item.artifact) && checkEnd) try { detail.end = await checkEnd(detail); } catch (error) { remember(detail, "endError", error); }
  } catch (error) { remember(detail, "error", error); }
  finally {
    try { detail.serverLedger = fixtures.allStats(); } catch (error) { remember(detail, "serverLedgerError", error); }
    for (const tab of tabs) try { await closeTab(tab); detail.cleanup.push({ tabId: tab.id, closed: true }); } catch (error) { detail.cleanup.push({ tabId: tab.id, error: errorText(error) }); failure ??= error; }
    try { detail.cleanupInventory = await getWorker().evaluate(`(async()=>({tabs:(await chrome.tabs.query({})).filter(row=>${JSON.stringify(detail.tabIds)}.includes(row.id)),targets:(await chrome.debugger.getTargets()).filter(row=>${JSON.stringify(detail.tabIds)}.includes(row.tabId)||${JSON.stringify(detail.childTargetIds)}.includes(row.id)),engineAbsent:__integrationBackend.browserEngine===null}))()`); assert.deepEqual(detail.cleanupInventory, { tabs: [], targets: [], engineAbsent: true }); } catch (error) { remember(detail, "cleanupError", error); }
    if (failure) detail.error = errorText(failure); try { await saveDetail(detail); } catch (error) { failure ??= error; }
  }
  if (failure) throw failure; return detail;
}
