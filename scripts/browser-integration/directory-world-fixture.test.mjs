import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { checkDirectoryWorld, directoryWorldHTML } from "./directory-world-fixture.mjs";
import { DIRECTORY_UPLOAD_WORLD, installDirectoryUploadController } from "../../apps/chrome-extension/browser-directory-upload.js";

function harness({ loseWorld = false, replaceNode = false, bypassGuard = false, detachError, cleanupError } = {}) {
  const calls = [], objects = new Map(); let realm, serial = 0, attached = true, detached = false, url;
  const scope = { sessionId: "directory-world", turnId: "turn", controlEpoch: 7 };
  function createRealm() {
    realm = vm.createContext({ Date, Promise, WeakMap, Map, location: { href: url } });
    vm.runInContext(`globalThis.document={defaultView:globalThis};globalThis.HTMLInputElement=class {
      constructor(){this.type='file';this.tagName='INPUT';this.id='directory-world';this.isConnected=true;this.ownerDocument=document;this.webkitdirectory=true;this.multiple=true;this.files=[];this.listeners=new Map()}
      addEventListener(type,fn){const current=this.listeners.get(type)||[];current.push(fn);this.listeners.set(type,current)}
      removeEventListener(type,fn){this.listeners.set(type,(this.listeners.get(type)||[]).filter(value=>value!==fn))}
    };globalThis.node=new HTMLInputElement();`, realm);
  }
  const remote = value => { const objectId = `remote-${++serial}`; objects.set(objectId, value); return { objectId }; };
  const browser = { client: { ...scope, async request(method, params, options) {
    calls.push({ method, params: structuredClone(params), options });
    assert.equal(params.session_id, scope.sessionId); assert.equal(params.turn_id, scope.turnId); assert.equal(params.control_epoch, scope.controlEpoch);
    assert.ok(params.timeoutMs > 0 && params.timeoutMs <= 30000); assert.equal(options.timeoutMs, params.timeoutMs);
    if (method === "detach") { if (detachError) throw detachError; attached = false; detached = true; objects.clear(); return {}; }
    if (method === "attach") { assert.equal(attached, false); attached = true; if (loseWorld) createRealm(); if (replaceNode) vm.runInContext("globalThis.node=new HTMLInputElement()", realm); return {}; }
    assert.equal(method, "executeCdp"); assert.equal(attached, true); assert.deepEqual(params.target, { tabId: 42 });
    const cmd = params.commandParams;
    switch (params.method) {
      case "Page.getFrameTree": return { frameTree: { frame: { id: "frame-root", url } } };
      case "DOM.getDocument": return { root: { nodeId: 1 } };
      case "DOM.querySelector": assert.deepEqual(cmd, { nodeId: 1, selector: "#directory-world" }); return { nodeId: 2 };
      case "DOM.describeNode": return { node: { nodeName: "INPUT", backendNodeId: 7 } };
      case "Page.createIsolatedWorld": assert.deepEqual(cmd, { frameId: "frame-root", worldName: DIRECTORY_UPLOAD_WORLD, grantUniveralAccess: false }); return { executionContextId: detached ? 102 : 101 };
      case "DOM.resolveNode": assert.equal(cmd.backendNodeId, 7); assert.equal(cmd.executionContextId, detached ? 102 : 101); return { object: remote(realm.node) };
      case "Runtime.releaseObject": assert.ok(objects.has(cmd.objectId)); objects.delete(cmd.objectId); return {};
      case "Runtime.callFunctionOn": {
        if (cleanupError && cmd.functionDeclaration.includes("controller.cleanup(true)")) throw cleanupError;
        try {
          if (bypassGuard && detached && cmd.functionDeclaration === installDirectoryUploadController.toString())
            realm.__openBrowserUseDirectoryUploadGuardsV1.nodes.delete(realm.node);
          const fn = vm.runInContext(`(${cmd.functionDeclaration})`, realm), receiver = objects.get(cmd.objectId); assert.ok(receiver);
          const result = await fn.apply(receiver, (cmd.arguments ?? []).map(arg => arg.value));
          return { result: cmd.returnByValue ? { value: JSON.parse(JSON.stringify(result)) } : remote(result) };
        } catch (error) { return { exceptionDetails: { text: "Uncaught", exception: { description: String(error) } }, result: { ...remote(error), subtype: "error" } }; }
      }
      default: assert.fail(`Unexpected command ${params.method}`);
    }
  } }, async newTab() { return { id: 42 }; }, cdp: { async navigate(tabId, destination, options) {
    assert.equal(tabId, 42); assert.ok(options.timeoutMs > 0); url = destination; createRealm(); calls.push({ navigate: destination });
  } } };
  return { browser, fixtureURL: "http://127.0.0.1:1234/fixture/", calls, state: () => realm };
}

test("same named world survives public detach/attach and blocks replacement until exact unsent cleanup", async () => {
  const f = harness(), result = await checkDirectoryWorld(f);
  assert.equal(result.passed, true); assert.equal(result.nativeFileMutationSent, false); assert.equal(result.syntheticEventsSent, false);
  assert.notEqual(result.beforeWorld.executionContextId, result.afterWorld.executionContextId, "Opaque context ID equality is not required");
  assert.notEqual(result.beforeWorld.nodeObjectId, result.afterWorld.nodeObjectId);
  assert.deepEqual(result.before, result.after); assert.deepEqual(result.before, result.final);
  assert.equal(result.guardAfterBlocked.token, result.initialController.token);
  assert.equal(result.blocked.result.subtype, "error"); assert.ok(result.blockedErrorObjectId);
  assert.ok(f.calls.some(call => call.params?.method === "Runtime.releaseObject" && call.params.commandParams.objectId === result.blockedErrorObjectId));
  assert.equal(f.calls.filter(call => call.method === "detach").length, 1); assert.equal(f.calls.filter(call => call.method === "attach").length, 1);
  assert.equal(f.calls.filter(call => call.navigate).length, 1);
  assert.equal(result.url, "http://127.0.0.1:1234/directory-world");
  assert.match(directoryWorldHTML, /<input id="directory-world" type="file" webkitdirectory multiple>/);
  assert.doesNotMatch(directoryWorldHTML, /<script|data:/);
  assert.equal(f.calls.filter(call => call.params?.commandParams?.functionDeclaration === installDirectoryUploadController.toString()).length, 3);
  assert.equal(f.calls.some(call => /DOM.setFileInputFiles|Input\./.test(call.params?.method ?? "")), false);
  assert.equal(f.state().__openBrowserUseDirectoryUploadGuardsV1.nodes.has(f.state().node), false);
  assert.equal(f.state().__openBrowserUseDirectoryUploadGuardsV1.count, 0);
});

for (const [name, options] of [["new world", { loseWorld: true }], ["replacement node", { replaceNode: true }]]) {
  test(`${name} cannot masquerade as native world persistence`, async () => {
    const f = harness(options);
    await assert.rejects(checkDirectoryWorld(f), error => {
      assert.equal(error.directoryWorldDetail.passed, false); assert.ok(error.directoryWorldDetail.error);
      assert.equal(error.directoryWorldDetail.blocked, undefined); assert.ok(error.directoryWorldDetail.cleanupError); return true;
    });
    assert.equal(f.calls.some(call => call.params?.method === "DOM.setFileInputFiles"), false);
  });
}

test("a replacement controller succeeding is a failure, not a persistence proof", async () => {
  const f = harness({ bypassGuard: true });
  await assert.rejects(checkDirectoryWorld(f), error => {
    assert.equal(error.directoryWorldDetail.passed, false); assert.ok(error.directoryWorldDetail.blocked.result.objectId);
    assert.equal(error.directoryWorldDetail.replacement, undefined); return true;
  });
});

test("original public detach error survives failed exact cleanup without task retries", async () => {
  const original = new Error("detach failed"), cleanupError = new Error("cleanup failed"), f = harness({ detachError: original, cleanupError });
  await assert.rejects(checkDirectoryWorld(f), error => {
    assert.equal(error, original); assert.equal(error.directoryWorldDetail.cleanupError.message, cleanupError.message); return true;
  });
  assert.equal(f.calls.filter(call => call.method === "detach").length, 1); assert.equal(f.calls.filter(call => call.method === "attach").length, 0);
});

test("guard cleanup failure is never converted into fixture success", async () => {
  const f = harness({ cleanupError: new Error("cleanup failed") });
  await assert.rejects(checkDirectoryWorld(f), error => {
    assert.equal(error.directoryWorldDetail.passed, false); assert.equal(error.directoryWorldDetail.error.message, "cleanup failed");
    assert.equal(error.directoryWorldDetail.replacement, undefined); return true;
  });
});
