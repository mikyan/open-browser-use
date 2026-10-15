import test from "node:test";
import assert from "node:assert/strict";
import { coldRouteWorldName, runColdNativeRouteProbe, inspectColdNativeRoutes } from "./cold-native-route-probe.mjs";

const copy = value => structuredClone(value);
function harness({ cdpAttach = false, independentRefused = false, badChildFrame = false, changedDocument = false, releaseFailure = false, preflight, missingTarget = false } = {}) {
  const events = () => { const listeners = new Set(); return { listeners, addListener(fn) { listeners.add(fn); }, removeListener(fn) { listeners.delete(fn); }, emit(...args) { for (const fn of listeners) fn(...args); } }; };
  const onEvent = events(), onDetach = events(), calls = [], objects = new Map(), contexts = new Map(), attached = new Set(), released = [], groups = [], anchor = {};
  let counter = 0, contextCounter = 100;
  const root = { id: "root-native", loaderId: "loader-original", url: "http://127.0.0.1/same-url" }, child = { id: "exact-native-child", parentId: root.id, loaderId: "child-loader", url: "http://localhost/same-url" };
  const sourceKey = source => JSON.stringify(source), own = (source, type, group) => { const id = `object-${++counter}`; objects.set(id, { source: sourceKey(source), type, group }); return { result: { objectId: id, type: "object", subtype: "node" } }; };
  const api = { debugger: { onEvent, onDetach,
    getTargets() { assert.equal(this, api.debugger); calls.push({ method: "debugger.getTargets" }); return Promise.resolve([{ id: "unrelated-url-match", type: "iframe", url: child.url }, ...(missingTarget ? [] : [{ id: child.id, type: "other", url: child.url }])]); },
    attach(source, version) { assert.equal(this, api.debugger); calls.push({ source: copy(source), method: "debugger.attach", params: { version } }); assert.deepEqual(source, { targetId: child.id }); assert.equal(version, "1.3"); if (independentRefused) return Promise.reject(Error("Already attached")); attached.add(sourceKey(source)); return Promise.resolve(); },
    detach(source) { assert.equal(this, api.debugger); calls.push({ source: copy(source), method: "debugger.detach" }); assert.equal(attached.delete(sourceKey(source)), true); onDetach.emit(source, "target_closed"); return Promise.resolve(); },
    sendCommand(source, method, params) {
      assert.equal(this, api.debugger); calls.push({ source: copy(source), method, params: copy(params) });
      if (method === "Target.getTargetInfo") {
        assert.deepEqual(source, { targetId: child.id }); assert.deepEqual(params, {});
        if (preflight === "attached") return Promise.resolve({ targetInfo: { targetId: child.id } });
        if (preflight === "no-target") return Promise.reject(Error(`No target with given id ${child.id}.`));
        return Promise.reject(Error(preflight === "unknown" ? "Unexpected permission error" : `Debugger is not attached to the target with id: ${preflight === "wrong-target" ? "another-target" : "exact-native-child"}.`));
      }
      if (method === "Page.getFrameTree") return Promise.resolve({ frameTree: { frame: source.targetId || source.sessionId ? { ...child, ...(badChildFrame ? { id: "other-frame" } : {}) } : root } });
      if (method === "Page.createIsolatedWorld") {
        assert.equal(params.worldName, coldRouteWorldName); assert.deepEqual(Object.keys(params).sort(), ["frameId", "worldName"]);
        if (params.frameId === child.id && !source.targetId && !source.sessionId) return Promise.reject(Error("No frame for given id"));
        const key = `${sourceKey(source)}:${params.frameId}`; if (!contexts.has(key)) contexts.set(key, ++contextCounter); return Promise.resolve({ executionContextId: contexts.get(key) });
      }
      if (method === "Runtime.evaluate" || method === "Runtime.callFunctionOn") { assert.equal(params.awaitPromise, false); assert.equal(params.userGesture, false); assert.ok(params.objectGroup); }
      if (method === "Runtime.evaluate") {
        assert.equal(params.returnByValue, false); assert.ok([...contexts.values()].includes(params.contextId));
        if (params.expression.includes("throw new Error")) return Promise.resolve({ exceptionDetails: { exception: own(source, "exception", params.objectGroup).result } });
        assert.ok(["({document,root:document.documentElement})", "({diagnostic:'OBU group probe'})"].includes(params.expression));
        return Promise.resolve(own(source, params.expression.includes("documentElement") ? "binding" : "plain", params.objectGroup));
      }
      if (method === "Runtime.callFunctionOn") {
        const object = objects.get(params.objectId); if (!object) return Promise.reject(Error("Could not find object with given id")); assert.equal(object.source, sourceKey(source));
        if (params.functionDeclaration.includes("return this.document===document&&")) return Promise.resolve({ result: { type: "boolean", value: !changedDocument } });
        if (params.functionDeclaration === "function(){return this.document}") return Promise.resolve(own(source, "document", params.objectGroup));
        if (params.functionDeclaration === "function(){return this.root}") return Promise.resolve(own(source, "root", params.objectGroup));
        if (params.functionDeclaration.includes("querySelectorAll('iframe,frame')[index]")) { assert.equal(params.arguments[0].value, 0); return Promise.resolve(own(source, "owner", params.objectGroup)); }
        if (object.type === "binding") return Promise.resolve({ result: { type: "object", value: { sameDocument: true, sameWindow: true, sameRoot: true, nodeType: 9, nodeName: "#document", url: source.targetId || source.sessionId ? child.url : root.url, origin: "http://localhost", readyState: "complete", owners: source.targetId || source.sessionId ? 0 : 1 } } });
        return Promise.resolve({ result: { type: "object", value: { same: true, connected: true, tag: "IFRAME", documentURL: root.url, contentDocumentAccessible: false, rect: { x: 76, y: 74, width: 522, height: 312 } } } });
      }
      if (method === "DOM.describeNode") { const object = objects.get(params.objectId); assert.equal(object?.source, sourceKey(source)); return Promise.resolve({ node: object.type === "document" ? { nodeType: 9, backendNodeId: 1 } : object.type === "root" ? { nodeType: 1, nodeName: "HTML", backendNodeId: 3, frameId: source.targetId || source.sessionId ? child.id : root.id } : { nodeType: 1, nodeName: "IFRAME", backendNodeId: 2, frameId: child.id } }); }
      if (method === "Target.attachToTarget") {
        assert.deepEqual(params, { targetId: child.id, flatten: true });
        if (!cdpAttach) return Promise.reject(Error("Not allowed"));
        onEvent.emit({ tabId: 7 }, "Target.attachedToTarget", { sessionId: "child-session", targetInfo: { targetId: child.id, type: "iframe" }, waitingForDebugger: false }); attached.add("child-session"); return Promise.resolve({ sessionId: "child-session" });
      }
      if (method === "Target.detachFromTarget") { assert.equal(attached.delete(params.sessionId), true); onEvent.emit({ tabId: 7 }, "Target.detachedFromTarget", { sessionId: params.sessionId, targetId: child.id }); return Promise.resolve({}); }
      if (method === "Runtime.releaseObject") { const object = objects.get(params.objectId); assert.equal(object?.source, sourceKey(source)); released.push(params.objectId); if (releaseFailure && released.length === 1) return Promise.reject(Error("Original release failed")); objects.delete(params.objectId); return Promise.resolve({}); }
      if (method === "Runtime.releaseObjectGroup") { groups.push({ source, name: params.objectGroup }); for (const [id, object] of objects) if (object.source === sourceKey(source) && object.group === params.objectGroup) objects.delete(id); return Promise.resolve({}); }
      throw Error(`Unexpected diagnostic call ${method}`);
    }
  } };
  const realmIdentity = Object.freeze({ kernelABI: "fixture-v1", worldName: "original-committed-world", kernelKey: "original-kernel", kernelToken: "original-token" });
  const realmState = { captures: 0, checks: 0, available: true, revoked: false };
  const nativePointerRealm = { capture() { realmState.captures++; return realmState.available ? Object.freeze({ identity: realmIdentity, check() { realmState.checks++; if (realmState.revoked) throw Error("OBU_POINTER_REALM_UNAVAILABLE: original identity revoked"); } }) : null; } };
  const target = { __integrationBackend: { browserEngine: null, attachedTabs: new Set([7]), attachmentEpochs: new Map([[7, anchor]]), nativePointerRealm } };
  return { api, target, calls, objects, released, groups, attached, onEvent, onDetach, realmIdentity, realmState };
}

function complete(detail, h) {
  assert.equal(detail.pending, 0); assert.equal(detail.overflow, false); assert.equal(detail.restored, true); assert.deepEqual(detail.finalState, { backendCurrent: true, engineAbsent: true, attached: true, sameAttachment: true });
  assert.equal(h.onEvent.listeners.size, 0); assert.equal(h.onDetach.listeners.size, 0); assert.equal(h.target.__obuColdNativeRouteProbe, undefined);
  assert.equal(h.attached.size, 0); assert.equal(h.objects.size, 0);
  assert.ok(h.calls.every(call => !/^(?:DOM|Runtime|Page)\.enable$|^Input\.|^Target\.setAutoAttach$|^DOM\.getDocument$/.test(call.method)));
  const calls = detail.records.filter(row => row.kind === "invoke");
  for (const call of calls) { const acks = detail.records.filter(row => row.invocation === call.sequence); assert.equal(acks.length, 1); assert.ok(acks[0].sequence > call.sequence); }
  assert.ok(detail.resources.every(resource => resource.released)); assert.ok(detail.groups.every(group => group.released));
}

test("native attach denial keeps root identity and uses only the exact owner frame for independent route", async () => {
  const h = harness(), detail = await runColdNativeRouteProbe(h.api, h.target, { tabId: 7, independentTarget: true });
  assert.equal(detail.error, undefined); complete(detail, h); assert.equal(detail.routes.length, 1);
  assert.match(detail.routes[0].attachError, /^Error: Not allowed$/); assert.deepEqual(detail.routes[0].childSource, { targetId: "exact-native-child" });
  assert.equal(detail.routes[0].preflight.notAttached, true); assert.deepEqual(detail.routes[0].preflight.source, { targetId: "exact-native-child" });
  const preflight = detail.records.find(row => row.method === "Target.getTargetInfo" && row.kind === "invoke"), preflightACK = detail.records.find(row => row.invocation === preflight.sequence), attach = detail.records.find(row => row.method === "debugger.attach" && row.kind === "invoke");
  assert.equal(preflightACK.ok, false); assert.ok(preflightACK.sequence < attach.sequence);
  assert.ok(detail.documents.some(row => row.frameId === "exact-native-child" && row.worldUnavailable));
  assert.equal(detail.documents.filter(row => row.description).length, 2); assert.ok(detail.documents.filter(row => row.description).every(row => row.contextReused));
  assert.equal(detail.routes[0].parentObserved, true); assert.deepEqual(detail.cleanup.map(row => [row.kind, row.detached]), [["target", true]]);
  const released = new Set(detail.resources.map(row => row.objectId)); assert.equal(released.size, 11); assert.equal(h.released.length, 7); assert.equal(h.groups.length, 4);
  assert.equal(detail.groupProofs.length, 2); assert.ok(detail.groupProofs.every(proof => proof.checks.length === 2 && proof.checks.every(check => /Could not find object/.test(check.error))));
  const groupReleased = detail.resources.filter(row => row.releaseMethod === "Runtime.releaseObjectGroup"); assert.equal(groupReleased.length, 4);
  assert.ok(groupReleased.every(row => !h.calls.some(call => call.method === "Runtime.releaseObject" && call.params.objectId === row.objectId)));
});

test("native preflight success or unknown rejection never acquires or borrows an existing route", async () => {
  for (const preflight of ["attached", "unknown", "wrong-target"]) {
    const h = harness({ preflight }), detail = await runColdNativeRouteProbe(h.api, h.target, { tabId: 7, independentTarget: true });
    assert.match(detail.error, /not proven unattached/); complete(detail, h);
    assert.equal(h.calls.some(row => row.method === "debugger.attach" || row.method === "debugger.detach"), false); assert.deepEqual(detail.cleanup, []);
    if (preflight === "attached") assert.deepEqual(detail.routes[0].preflight.result, { targetInfo: { targetId: "exact-native-child" } });
    else assert.match(detail.routes[0].preflight.error, preflight === "unknown" ? /Unexpected permission error/ : /another-target/);
  }
});

test("original Target event before ACK and returned flat child source remain separate evidence", async () => {
  const h = harness({ cdpAttach: true }), detail = await runColdNativeRouteProbe(h.api, h.target, { tabId: 7, independentTarget: true });
  assert.equal(detail.error, undefined); complete(detail, h); assert.deepEqual(detail.routes[0].childSource, { tabId: 7, sessionId: "child-session" });
  const call = detail.records.find(row => row.method === "Target.attachToTarget" && row.kind === "invoke"), event = detail.routes[0].nativeAttachEvents[0], ack = detail.records.find(row => row.invocation === call.sequence);
  assert.ok(call.sequence < event.sequence && event.sequence < ack.sequence); assert.equal(ack.result.sessionId, event.params.sessionId);
  assert.equal(h.calls.some(row => row.method === "debugger.attach"), false); assert.deepEqual(detail.cleanup.map(row => [row.kind, row.detached]), [["session", true]]);
});

test("independent attach refusal never borrows or detaches an existing target", async () => {
  const h = harness({ independentRefused: true }), detail = await runColdNativeRouteProbe(h.api, h.target, { tabId: 7, independentTarget: true });
  assert.equal(detail.error, undefined); complete(detail, h); assert.match(detail.routes[0].independentError, /Already attached/); assert.deepEqual(detail.cleanup, []);
  assert.equal(h.calls.filter(row => row.method === "Page.getFrameTree").length, 2); assert.equal(h.calls.some(row => row.method === "debugger.detach"), false);
});

test("a mismatched native child tree fails without discarding original object and route cleanup", async () => {
  const h = harness({ badChildFrame: true }), detail = await runColdNativeRouteProbe(h.api, h.target, { tabId: 7, independentTarget: true });
  assert.match(detail.error, /different root frame/); complete(detail, h); assert.equal(detail.cleanup[0].detached, true);
  assert.equal(detail.documents.filter(row => row.description).length, 1);
});

test("original document replacement keeps the first failure and actual release rejection", async () => {
  const h = harness({ changedDocument: true, releaseFailure: true }), detail = await runColdNativeRouteProbe(h.api, h.target, { tabId: 7 });
  assert.match(detail.error, /Document replaced/); assert.equal(detail.pending, 0); assert.equal(detail.restored, true);
  assert.ok(detail.resources.some(row => row.error?.includes("Original release failed") && row.released === false));
  assert.ok(detail.records.some(row => row.kind === "settled" && row.ok === false && row.error.includes("Original release failed")));
  assert.ok(detail.groups.every(group => group.released)); assert.equal(h.objects.size, 0); assert.equal(h.onEvent.listeners.size, 0);
});

test("warm engine is rejected before native calls and wrapper saves a failed diagnostic", async () => {
  const h = harness(); h.target.__integrationBackend.browserEngine = {};
  await assert.rejects(runColdNativeRouteProbe(h.api, h.target, { tabId: 7 }), /no browser engine/); assert.deepEqual(h.calls, []);
  const failure = { error: "original diagnostic failure", records: [{ sequence: 1 }] }; let saved;
  await assert.rejects(inspectColdNativeRoutes({ tabId: 7, independentTarget: true, getWorker: () => ({ evaluate: async code => { assert.match(code, /"independentTarget":true/); return failure; } }), saveDetail: async detail => { saved = detail; } }), /original diagnostic failure/);
  assert.equal(saved, failure);
});

function readerFactories({ readError, cleanupError, expectedRealm, afterAllocate } = {}) {
  const geometry = {}, scopes = [], sources = [], allocations = [], leases = [];
  return { scopes, sources, allocations, leases,
    createFrameGeometryRuntime() { return geometry; },
    createNativePointerFeedback(options) {
      assert.equal(options.geometry, geometry); assert.deepEqual(options.target, { tabId: 7 }); assert.deepEqual({ x: options.x, y: options.y }, { x: 264.5, y: 240.25 });
      if (expectedRealm) assert.equal(options.realm, expectedRealm, "Direct factory must receive the captured original realm identity");
      const adapter = options.adapter;
      const allocate = async source => {
        sources.push(source); const group = adapter.prepareGroup(source, `reader-group-${sources.length}`); allocations.push(group);
        const frame = (await adapter.send(source, "Page.getFrameTree", {})).frameTree.frame;
        const world = await adapter.send(source, "Page.createIsolatedWorld", { frameId: frame.id, worldName: coldRouteWorldName });
        await adapter.send(source, "Runtime.evaluate", { expression: "({document,root:document.documentElement})", contextId: world.executionContextId, objectGroup: `reader-group-${sources.length}`, returnByValue: false, awaitPromise: false, userGesture: false });
      };
      return {
        async read(scope) {
          scopes.push(scope); scope(); await allocate(options.target);
          const route = adapter.acquireChild({ parentTarget: options.target, frameId: "exact-native-child" }); leases.push(route);
          const source = await route.ready; route.check(); await allocate(source);
          afterAllocate?.(); scope();
          if (readError) throw readError;
          return { x: 124.5, y: 208.25, width: 280, height: 64 };
        },
        async cleanup() {
          if (cleanupError) throw cleanupError;
          for (const group of allocations) { await group.releaseGroup(); group.close(); }
          for (const route of leases) await route.release();
        }
      };
    }
  };
}

test("direct reader captures one original realm lease and still releases actual resources after revocation", async () => {
  const h = harness(), factories = readerFactories({ expectedRealm: h.realmIdentity, afterAllocate: () => { h.realmState.revoked = true; } });
  const detail = await runColdNativeRouteProbe(h.api, h.target, { tabId: 7, reader: { point: { x: 264.5, y: 240.25 } } }, factories);
  assert.match(detail.error, /OBU_POINTER_REALM_UNAVAILABLE/); assert.match(detail.reader.readError, /OBU_POINTER_REALM_UNAVAILABLE/);
  assert.equal(h.realmState.captures, 1); assert.ok(h.realmState.checks > 1);
  assert.equal(detail.reader.cleanupComplete, true); complete(detail, h);
  assert.equal(h.calls.filter(call => call.method === "Runtime.releaseObjectGroup").length, 2);
  assert.equal(h.calls.filter(call => call.method === "debugger.detach").length, 1);
});

test("unavailable original realm never starts a direct factory or a native command", async () => {
  const h = harness(); h.realmState.available = false; let factoriesCalled = false;
  const factories = { createFrameGeometryRuntime() { throw Error("Unexpected geometry creation"); }, createNativePointerFeedback() { factoriesCalled = true; throw Error("Unexpected reader creation"); } };
  const detail = await runColdNativeRouteProbe(h.api, h.target, { tabId: 7, reader: { point: { x: 264.5, y: 240.25 } } }, factories);
  assert.match(detail.error, /original native pointer realm unavailable/i); assert.equal(h.realmState.captures, 1); assert.equal(factoriesCalled, false); assert.deepEqual(h.calls, []); complete(detail, h);
});

test("reader mode uses supplied factories directly and records actual group and child-route cleanup", async () => {
  const h = harness(), factories = readerFactories();
  const detail = await runColdNativeRouteProbe(h.api, h.target, { tabId: 7, reader: { point: { x: 264.5, y: 240.25 } } }, factories);
  assert.equal(detail.error, undefined); complete(detail, h); assert.equal(detail.mode, "native-reader");
  assert.deepEqual(detail.documents, []); assert.deepEqual(detail.owners, []); assert.equal(detail.groupProofs, undefined);
  assert.deepEqual(detail.reader.result, { x: 124.5, y: 208.25, width: 280, height: 64 }); assert.equal(detail.reader.cleanupComplete, true);
  assert.ok(detail.reader.groups.every(group => group.released && group.closed)); assert.ok(detail.reader.leases.every(lease => lease.acquired && lease.released));
  assert.equal(h.calls.filter(call => call.method === "debugger.attach").length, 1); assert.equal(h.calls.filter(call => call.method === "debugger.detach").length, 1);
  assert.equal(h.calls.some(call => call.method === "Target.attachToTarget" || call.method === "Runtime.releaseObject"), false);
  const discovery = h.calls.findIndex(call => call.method === "debugger.getTargets"), preflight = h.calls.findIndex(call => call.method === "Target.getTargetInfo"), attach = h.calls.findIndex(call => call.method === "debugger.attach");
  assert.ok(discovery >= 0 && discovery < preflight && preflight < attach); assert.equal(detail.reader.leases[0].target.id, "exact-native-child");
  assert.equal(h.calls.filter(call => call.method === "Page.createIsolatedWorld").length, 2, "No old world-reuse probe precedes reader calls");
  assert.ok(detail.records.filter(row => row.kind === "invoke").every(row => Object.values(row.state).every(value => value === true)));
});

test("reader discovery needs one exact frame target and never treats persistent NoTarget as no-client", async () => {
  for (const options of [{ missingTarget: true }, { preflight: "no-target" }]) {
    const h = harness(options), detail = await runColdNativeRouteProbe(h.api, h.target, { tabId: 7, reader: { point: { x: 264.5, y: 240.25 } } }, readerFactories());
    assert.match(detail.reader.readError, options.missingTarget ? /exact native frame target unavailable/ : /not proven unattached/);
    assert.equal(detail.reader.cleanupComplete, true); complete(detail, h);
    assert.equal(h.calls.some(call => call.method === "debugger.attach" || call.method === "debugger.detach"), false);
    assert.equal(detail.reader.leases[0].acquired, false); assert.equal(detail.reader.leases[0].released, true);
    if (options.missingTarget) assert.equal(h.calls.some(call => call.method === "Target.getTargetInfo"), false);
    else { assert.equal(detail.reader.leases[0].preflight.notAttached, false); assert.match(detail.reader.leases[0].preflight.error, /^Error: No target with given id exact-native-child\.$/); }
  }
});

test("reader first failure and cleanup failure survive fallback cleanup and missing factories fail closed", async () => {
  const h = harness(), original = Error("Original reader rejected"), cleanup = Error("Original reader cleanup rejected");
  const detail = await runColdNativeRouteProbe(h.api, h.target, { tabId: 7, reader: { point: { x: 264.5, y: 240.25 } } }, readerFactories({ readError: original, cleanupError: cleanup }));
  assert.match(detail.error, /Original reader rejected/); assert.match(detail.reader.readError, /Original reader rejected/); assert.match(detail.reader.cleanupError, /Original reader cleanup rejected/);
  assert.equal(detail.reader.cleanupComplete, false); complete(detail, h); assert.ok(detail.resources.every(row => row.releaseMethod === "Runtime.releaseObject"));
  const absent = harness(), missing = await runColdNativeRouteProbe(absent.api, absent.target, { tabId: 7, reader: { point: { x: 1, y: 2 } } });
  assert.match(missing.error, /factories unavailable/); assert.deepEqual(absent.calls, []); assert.equal(missing.restored, true);
});

test("reader wrapper passes only the authored point and staged factory reference, preserving first error on save failure", async () => {
  const failure = { error: "First native failure" }; let captured;
  await assert.rejects(inspectColdNativeRoutes({ tabId: 7, reader: { point: { x: 1, y: 2 } }, getWorker: () => ({ evaluate: async code => { captured = code; return failure; } }), saveDetail: async () => { throw Error("Secondary save failure"); } }), /First native failure/);
  assert.match(captured, /globalThis\.__integrationNativePointerFactory\)/); assert.match(captured, /"reader":\{"point":\{"x":1,"y":2\}\}/); assert.doesNotMatch(captured, /import\(|expectedRect/);
});
