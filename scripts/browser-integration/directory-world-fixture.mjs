import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DIRECTORY_UPLOAD_WORLD, installDirectoryUploadController } from "../../apps/chrome-extension/browser-directory-upload.js";
import { chooserScope } from "./chooser-waits-fixture.mjs";

const errorRecord = error => ({ name: error?.name ?? "Error", message: String(error?.message ?? error), stack: error?.stack });
const key = "__obuDirectoryWorldFixtureV1";
export const directoryWorldHTML = '<!doctype html><title>Directory world persistence</title><input id="directory-world" type="file" webkitdirectory multiple>';
const snapshotFunction = `function(token, initialize) {
  const key=${JSON.stringify(key)};
  if(initialize) { if(globalThis[key]) throw Error('Test world marker already exists'); globalThis[key]={token,node:this,document,events:[]};
    for(const type of ['input','change','cancel']) this.addEventListener(type,event=>globalThis[key].events.push({type,isTrusted:event.isTrusted}),true); }
  const marker=globalThis[key];
  if(!marker || marker.token!==token || marker.node!==this || marker.document!==document) throw Error('Original isolated world/node/document was lost');
  return {token,originalNode:marker.node===this,originalDocument:marker.document===document,url:location.href,
    connected:this.isConnected,tag:this.tagName,type:this.type,id:this.id,directory:this.webkitdirectory,multiple:this.multiple,
    fileCount:this.files.length,events:[...marker.events]};
}`;
const cleanupFunction = `function(token) {
  const state=globalThis.__openBrowserUseDirectoryUploadGuardsV1;
  const controller=state?.nodes.get(this);
  if(!controller || controller.token!==token) throw Error('Exact test controller is unavailable');
  return controller.cleanup(true);
}`;

function value(response) { assert.equal(response?.exceptionDetails, undefined); return response?.result?.value; }
function checkSnapshot(record, token, url) {
  assert.deepEqual(record, { token, originalNode: true, originalDocument: true, url, connected: true,
    tag: "INPUT", type: "file", id: "directory-world", directory: true, multiple: true, fileCount: 0, events: [] });
}

// This deliberately stages an unsent directory admission. It proves named-world
// persistence across native detach/attach, never enumeration recovery. No file
// mutation or synthetic event is sent, so exact-token cleanup(true) is safe.
export async function checkDirectoryWorld({ browser, fixtureURL }) {
  const detail = { kind: "isolated-world-guard-persistence", nativeFileMutationSent: false, syntheticEventsSent: false,
    boundary: "Test-only unsent admission; no real directory enumeration or worker restart is simulated", commands: [], cleanup: [] };
  const token = randomUUID(), replacementToken = randomUUID(), marker = randomUUID();
  const deadline = Date.now() + 30000;
  let tabId, frameId, nodeObjectId, pendingToken, failure;
  const remaining = end => { const duration = end - Date.now(); assert.ok(duration > 0, "Directory world fixture deadline expired"); return duration; };
  async function request(method, params, end = deadline, cleanup = false) {
    assert.deepEqual(chooserScope(browser), detail.scope, "World fixture scope changed");
    const timeoutMs = remaining(end), record = { sequence: detail.commands.length + 1, method, params: structuredClone(params), scope: { ...detail.scope }, startedAt: Date.now() };
    detail.commands.push(record); if (cleanup) detail.cleanup.push(record.sequence);
    try { const response = await browser.client.request(method, { ...detail.scope, ...params, timeoutMs }, { timeoutMs }); record.completedAt = Date.now(); record.result = response ?? null; remaining(end); return response; }
    catch (error) { record.error = errorRecord(error); throw error; }
  }
  const cdp = (method, commandParams, end, cleanup) => request("executeCdp", { target: { tabId }, method, commandParams }, end, cleanup);
  async function resolve(end = deadline, cleanup = false) {
    const world = await cdp("Page.createIsolatedWorld", { frameId, worldName: DIRECTORY_UPLOAD_WORLD, grantUniveralAccess: false }, end, cleanup);
    assert.ok(Number.isSafeInteger(world.executionContextId) && world.executionContextId > 0);
    const node = await cdp("DOM.resolveNode", { backendNodeId: detail.backendNodeId, executionContextId: world.executionContextId }, end, cleanup);
    assert.ok(typeof node.object?.objectId === "string" && node.object.objectId.length > 0);
    nodeObjectId = node.object.objectId;
    return { executionContextId: world.executionContextId, nodeObjectId };
  }
  const snapshot = initialize => cdp("Runtime.callFunctionOn", { objectId: nodeObjectId, functionDeclaration: snapshotFunction,
    arguments: [{ value: marker }, { value: initialize }], returnByValue: true }).then(value);
  async function install(controllerToken) {
    return cdp("Runtime.callFunctionOn", { objectId: nodeObjectId, functionDeclaration: installDirectoryUploadController.toString(),
      arguments: [{ value: controllerToken }, { value: Date.now() + 60000 }] });
  }
  async function cleanupGuard(end = deadline, cleanup = false) {
    const result = value(await cdp("Runtime.callFunctionOn", { objectId: nodeObjectId, functionDeclaration: cleanupFunction,
      arguments: [{ value: pendingToken }], returnByValue: true }, end, cleanup));
    assert.deepEqual(result, { token: pendingToken, removed: true }); pendingToken = null; return result;
  }
  try {
    const tab = await browser.newTab(); tabId = tab.id; detail.tabId = tabId; detail.scope = chooserScope(browser);
    const url = new URL("/directory-world", fixtureURL).href; detail.url = url;
    await browser.cdp.navigate(tabId, url, { timeoutMs: remaining(deadline) }); detail.navigationCompletedAt = Date.now();
    const tree = await cdp("Page.getFrameTree", {}); frameId = tree.frameTree?.frame?.id;
    assert.ok(typeof frameId === "string" && frameId); assert.equal(tree.frameTree.frame.url, url); detail.frameId = frameId;
    const document = await cdp("DOM.getDocument", { depth: 0 });
    const selected = await cdp("DOM.querySelector", { nodeId: document.root.nodeId, selector: "#directory-world" });
    const described = await cdp("DOM.describeNode", { nodeId: selected.nodeId, depth: 0 });
    assert.equal(described.node.nodeName, "INPUT"); assert.ok(Number.isSafeInteger(described.node.backendNodeId) && described.node.backendNodeId > 0);
    detail.backendNodeId = described.node.backendNodeId; detail.described = described.node;
    detail.beforeWorld = await resolve(); detail.before = await snapshot(true); checkSnapshot(detail.before, marker, url);
    pendingToken = token; const installed = await install(token);
    assert.equal(installed.exceptionDetails, undefined); assert.ok(installed.result?.objectId);
    detail.initialController = { token, objectId: installed.result.objectId };
    detail.begin = value(await cdp("Runtime.callFunctionOn", { objectId: installed.result.objectId,
      functionDeclaration: "function() { return this.begin(true); }", returnByValue: true }));
    assert.deepEqual(detail.begin, { token, phase: "directory-dispatched" });
    await request("detach", { tabId }); await request("attach", { tabId });
    detail.afterWorld = await resolve(); detail.after = await snapshot(false); checkSnapshot(detail.after, marker, url);
    detail.blocked = await install(replacementToken);
    const message = detail.blocked.exceptionDetails?.exception?.description ?? detail.blocked.exceptionDetails?.text;
    assert.match(message ?? "", /^(?:Error: )?OBU_DIRECTORY_UPLOAD_BUSY: original node has an unsettled native submission(?:\r?\n|$)/);
    detail.guardAfterBlocked = value(await cdp("Runtime.callFunctionOn", { objectId: nodeObjectId,
      functionDeclaration: "function() { const guard=globalThis.__openBrowserUseDirectoryUploadGuardsV1?.nodes.get(this); return guard ? {token:guard.token,phase:guard.phase} : null; }", returnByValue: true }));
    assert.deepEqual(detail.guardAfterBlocked, { token, phase: "directory-dispatched" }, "Replacement attempt must not overwrite the original guard");
    if (detail.blocked.result?.objectId) {
      detail.blockedErrorObjectId = detail.blocked.result.objectId;
      detail.blockedErrorRelease = await cdp("Runtime.releaseObject", { objectId: detail.blockedErrorObjectId });
    }
    detail.originalCleanup = await cleanupGuard();
    pendingToken = replacementToken; const replacement = await install(replacementToken);
    assert.equal(replacement.exceptionDetails, undefined); assert.ok(replacement.result?.objectId);
    detail.replacement = value(await cdp("Runtime.callFunctionOn", { objectId: replacement.result.objectId,
      functionDeclaration: "function() { return this.describe(); }", returnByValue: true }));
    assert.deepEqual(detail.replacement, { token: replacementToken, directory: true, multiple: true });
    detail.replacementCleanup = await cleanupGuard(); detail.final = await snapshot(false); checkSnapshot(detail.final, marker, url);
    assert.deepEqual(chooserScope(browser), detail.scope); detail.passed = true; return detail;
  } catch (error) { failure = error; detail.passed = false; detail.error = errorRecord(error); error.directoryWorldDetail = detail; throw error; }
  finally {
    if (pendingToken && tabId && frameId && detail.backendNodeId) {
      try { const end = Date.now() + 3000; await resolve(end, true); await cleanupGuard(end, true); }
      catch (error) { detail.cleanupError = errorRecord(error); if (!failure) { detail.passed = false; error.directoryWorldDetail = detail; throw error; } }
    }
  }
}
