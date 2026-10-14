// Diagnostic only: creates a named isolated world and, when permitted, owns an
// independent debugger route. It never enables domains or changes page input.
export const coldRouteWorldName = "__obu_cold_native_route_diagnostic_v1__";

// Self-contained for evaluation in the original extension worker. Each native
// Promise is observed directly; rejected route admission is evidence, not an ACK.
export async function runColdNativeRouteProbe(api, target, { tabId, independentTarget = false, reader }, factories) {
  if (target.__obuColdNativeRouteProbe) throw Error("Cold native route probe already active");
  const backend = target.__integrationBackend, anchor = backend?.attachmentEpochs.get(tabId);
  if (!backend || backend.browserEngine !== null || !backend.attachedTabs.has(tabId) || anchor === undefined) throw Error("Cold probe requires the original attached raw tab and no browser engine");
  const worldName = "__obu_cold_native_route_diagnostic_v1__", objectGroup = "__obu_cold_native_route_objects_v1__";
  const detail = { tabId, independentTarget, mode: reader ? "native-reader" : "route-capability", worldName, objectGroup, records: [], documents: [], owners: [], routes: [], cleanup: [], pending: 0, overflow: false, restored: false,
    boundary: "Diagnostic native reads and named isolated-world creation on a separate raw tab. Optional independent child attachment is a debugger-state change. No domain enable, autoattach change, browser engine, input, navigation or screenshot. Capability errors remain original failures; no inferred child session or URL-based ownership." };
  let failure, bytes = 0, rootDetached = false;
  const owned = [], resources = [], groups = new Map(), seen = new Set(), provedSources = new Set(), nativeThen = Promise.prototype.then;
  const sourceKey = source => JSON.stringify(source);
  const trackObject = (source, objectId, group) => {
    if (typeof objectId !== "string" || !objectId) return;
    if (!resources.some(row => row.objectId === objectId && sourceKey(row.source) === sourceKey(source))) resources.push({ source: structuredClone(source), objectId, objectGroup: group, released: false });
  };
  const state = () => ({ backendCurrent: target.__integrationBackend === backend, engineAbsent: backend.browserEngine === null, attached: backend.attachedTabs.has(tabId), sameAttachment: backend.attachmentEpochs.get(tabId) === anchor });
  const assert = (condition, message) => { if (!condition) throw Error(message); };
  const fail = (owner, field, error) => { owner[field] = String(error?.stack ?? error); failure ??= error; };
  const append = row => { const value = structuredClone({ sequence: detail.records.length + 1, ...row, state: state() }), size = JSON.stringify(value).length;
    if (detail.records.length >= 2048 || size > 2 * 1024 * 1024 || bytes + size > 12 * 1024 * 1024) { detail.overflow = true; return null; }
    detail.records.push(value); bytes += size; return value;
  };
  const invoke = (source, method, params = {}) => {
    if (method === "Runtime.evaluate" || method === "Runtime.callFunctionOn") {
      params = { ...params, objectGroup: params.objectGroup ?? objectGroup, awaitPromise: false, userGesture: false };
      const key = `${sourceKey(source)}:${params.objectGroup}`;
      if (!groups.has(key)) groups.set(key, { source: structuredClone(source), objectGroup: params.objectGroup, released: false });
    }
    const row = append({ kind: "invoke", source, method, params }); let promise;
    try {
      if (method === "debugger.attach") promise = Reflect.apply(api.debugger.attach, api.debugger, [source, "1.3"]);
      else if (method === "debugger.detach") promise = Reflect.apply(api.debugger.detach, api.debugger, [source]);
      else if (method === "debugger.getTargets") promise = Reflect.apply(api.debugger.getTargets, api.debugger, []);
      else promise = Reflect.apply(api.debugger.sendCommand, api.debugger, [source, method, params]);
    } catch (error) { append({ kind: "settled", invocation: row?.sequence, ok: false, error: String(error) }); throw error; }
    detail.pending++;
    nativeThen.call(promise, result => {
      detail.pending--; trackObject(source, result?.result?.objectId, params.objectGroup); trackObject(source, result?.exceptionDetails?.exception?.objectId, params.objectGroup);
      append({ kind: "settled", invocation: row?.sequence, ok: true, result });
    }, error => { detail.pending--; append({ kind: "settled", invocation: row?.sequence, ok: false, error: String(error) }); });
    return promise;
  };
  const relevant = source => source.tabId === tabId || owned.some(row => row.source.targetId && row.source.targetId === source.targetId) || detail.routes.some(row => row.targetId === source.targetId);
  const onEvent = (source, method, params) => { if (relevant(source) && /^(?:Target\.(?:attachedToTarget|detachedFromTarget)|Page\.(?:frameAttached|frameDetached|frameNavigated)|Runtime\.(?:executionContextCreated|executionContextDestroyed|executionContextsCleared))$/.test(method)) append({ kind: "event", source, method, params }); };
  const onDetach = (source, reason) => { if (relevant(source)) { append({ kind: "detached", source, reason }); if (source.tabId === tabId && !source.sessionId) rootDetached = true; for (const route of owned) if (sourceKey(route.source) === sourceKey(source)) route.nativeDetached = true; } };
  api.debugger.onEvent.addListener(onEvent); api.debugger.onDetach.addListener(onDetach); target.__obuColdNativeRouteProbe = detail;
  const rootSource = { tabId };
  const notAttached = (error, targetId) => String(error?.message ?? error) === `Debugger is not attached to the target with id: ${targetId}.`;
  const checkCleanupRoute = source => {
    if (sourceKey(source) === sourceKey(rootSource)) assert(!rootDetached && state().sameAttachment, "Original root cleanup route changed");
    else assert(owned.some(route => sourceKey(route.source) === sourceKey(source) && !route.nativeDetached && !route.detached), "Original child cleanup route changed");
  };
  const findFrame = (tree, id) => tree?.frame?.id === id ? tree.frame : tree?.childFrames?.map(child => findFrame(child, id)).find(Boolean);
  const remote = (response, label) => { assert(!response?.exceptionDetails && response?.result?.objectId && response.result.type === "object", `${label} did not return an original object handle`); return response.result.objectId; };
  async function proveGroupRelease(source, contextId) {
    if (provedSources.has(sourceKey(source))) return; provedSources.add(sourceKey(source));
    const group = "__obu_cold_native_route_group_proof_v1__", proof = { source: structuredClone(source), contextId, objectGroup: group, checks: [] };
    (detail.groupProofs ??= []).push(proof);
    proof.value = await invoke(source, "Runtime.evaluate", { expression: "({diagnostic:'OBU group probe'})", contextId, objectGroup: group, returnByValue: false, silent: true });
    const objectId = remote(proof.value, "Original group object");
    proof.exception = await invoke(source, "Runtime.evaluate", { expression: "(()=>{throw new Error('OBU group probe')})()", contextId, objectGroup: group, returnByValue: false, silent: true });
    const exceptionId = proof.exception.exceptionDetails?.exception?.objectId;
    assert(typeof exceptionId === "string" && exceptionId, "Original diagnostic exception handle missing");
    proof.releaseACK = await invoke(source, "Runtime.releaseObjectGroup", { objectGroup: group });
    groups.get(`${sourceKey(source)}:${group}`).released = true;
    for (const resource of resources) if (sourceKey(resource.source) === sourceKey(source) && resource.objectGroup === group) { resource.released = true; resource.releaseMethod = "Runtime.releaseObjectGroup"; }
    for (const id of [objectId, exceptionId]) {
      const check = { objectId: id }; proof.checks.push(check); let rejected = false;
      try { check.result = await invoke(source, "Runtime.callFunctionOn", { objectId: id, functionDeclaration: "function(){return true}", returnByValue: true, silent: true }); }
      catch (error) { rejected = true; check.error = String(error); }
      assert(rejected, "Released group handle remained callable");
    }
  }
  async function describeDocument(source, frameId, tree, depth) {
    assert(depth <= 4 && detail.documents.length < 12, "Diagnostic frame bound exceeded");
    const key = `${sourceKey(source)}:${frameId}`; if (seen.has(key)) return; seen.add(key);
    const row = { source: structuredClone(source), frameId, treeFrame: findFrame(tree.frameTree, frameId) ?? null }; detail.documents.push(row);
    let first;
    try { first = await invoke(source, "Page.createIsolatedWorld", { frameId, worldName }); }
    catch (error) { row.worldUnavailable = String(error); return; }
    assert(Number.isSafeInteger(first.executionContextId) && first.executionContextId > 0, "Invalid original isolated context ID");
    row.world = first; row.worldAgain = await invoke(source, "Page.createIsolatedWorld", { frameId, worldName });
    row.contextReused = row.worldAgain.executionContextId === first.executionContextId;
    // A native observation, not an assumed renderer-world implementation contract.
    row.binding = await invoke(source, "Runtime.evaluate", { expression: "({document,root:document.documentElement})", contextId: first.executionContextId, objectGroup, returnByValue: false, silent: true });
    const objectId = remote(row.binding, "Original document binding");
    row.identity = await invoke(source, "Runtime.callFunctionOn", { objectId, functionDeclaration: "function(){return {sameDocument:this.document===document,sameWindow:this.document.defaultView===window,sameRoot:this.root===this.document.documentElement,nodeType:this.document.nodeType,nodeName:this.document.nodeName,url:location.href,origin:globalThis.origin,readyState:this.document.readyState,owners:this.document.querySelectorAll('iframe,frame').length}}", returnByValue: true, silent: true });
    assert(!row.identity.exceptionDetails && row.identity.result?.value?.sameDocument === true && row.identity.result.value.sameWindow === true && row.identity.result.value.sameRoot === true && row.identity.result.value.nodeType === 9, "Original isolated document identity changed");
    row.document = await invoke(source, "Runtime.callFunctionOn", { objectId, functionDeclaration: "function(){return this.document}", objectGroup, returnByValue: false, silent: true });
    const documentId = remote(row.document, "Original document");
    row.description = await invoke(source, "DOM.describeNode", { objectId: documentId, depth: 0, pierce: false });
    assert(row.description.node?.nodeType === 9 && row.description.node.backendNodeId > 0, "Original native document/backend identity mismatch");
    assert(row.description.node.frameId === undefined || row.description.node.frameId === frameId, "Original native document/frame identity mismatch");
    row.root = await invoke(source, "Runtime.callFunctionOn", { objectId, functionDeclaration: "function(){return this.root}", objectGroup, returnByValue: false, silent: true });
    row.rootDescription = await invoke(source, "DOM.describeNode", { objectId: remote(row.root, "Original document element"), depth: 0, pierce: false });
    assert(row.rootDescription.node?.nodeType === 1 && row.rootDescription.node.backendNodeId > 0 && row.rootDescription.node.frameId === frameId, "Original native document element/frame identity mismatch");
    const count = row.identity.result.value.owners; assert(Number.isInteger(count) && count >= 0 && count <= 8, "Diagnostic owner bound exceeded");
    for (let index = 0; index < count; index++) {
      const owner = { source: structuredClone(source), parentFrameId: frameId, index }; detail.owners.push(owner);
      owner.handle = await invoke(source, "Runtime.callFunctionOn", { objectId, functionDeclaration: "function(index){return this.document.querySelectorAll('iframe,frame')[index]??null}", arguments: [{ value: index }], objectGroup, returnByValue: false, silent: true });
      const ownerId = remote(owner.handle, "Original frame owner");
      owner.identity = await invoke(source, "Runtime.callFunctionOn", { objectId: ownerId, functionDeclaration: "function(){const r=this.getBoundingClientRect(),s=getComputedStyle(this);return {same:this.ownerDocument===document,connected:this.isConnected,tag:this.tagName,src:this.getAttribute('src'),documentURL:location.href,contentDocumentAccessible:this.contentDocument!==null,rect:{x:r.x,y:r.y,width:r.width,height:r.height},styles:{transform:s.transform,transformOrigin:s.transformOrigin,borderLeftWidth:s.borderLeftWidth,borderTopWidth:s.borderTopWidth,paddingLeft:s.paddingLeft,paddingTop:s.paddingTop,zoom:s.zoom}}}", returnByValue: true, silent: true });
      assert(!owner.identity.exceptionDetails && owner.identity.result?.value?.same === true && owner.identity.result.value.connected === true, "Original frame owner no longer belongs to document");
      owner.description = await invoke(source, "DOM.describeNode", { objectId: ownerId, depth: 0, pierce: false });
      const childId = owner.description.node?.frameId;
      assert(typeof childId === "string" && childId && childId !== frameId && owner.description.node.backendNodeId > 0, "Native frame owner did not identify its child frame");
      owner.frameId = childId;
      // Local world availability is tested even when this frame has its own target.
      await describeDocument(source, childId, tree, depth + 1);
      const targets = await invoke(rootSource, "debugger.getTargets");
      const candidates = targets.filter(value => value.id === childId);
      assert(candidates.length <= 1, "Ambiguous exact native frame target"); owner.target = candidates[0] ?? null;
      if (!owner.target) continue;
      const route = { source: rootSource, parentSource: structuredClone(source), parentFrameId: frameId, targetId: childId, target: owner.target }; detail.routes.push(route);
      try {
        route.attachment = await invoke(rootSource, "Target.attachToTarget", { targetId: childId, flatten: true });
        assert(typeof route.attachment.sessionId === "string" && route.attachment.sessionId, "Native child attach returned no session");
        const childSource = { tabId, sessionId: route.attachment.sessionId }; owned.push({ source: childSource, kind: "session", sessionId: route.attachment.sessionId });
        route.childSource = childSource;
      } catch (error) { route.attachError = String(error); }
      if (!route.childSource && independentTarget) {
        const childSource = { targetId: childId };
        route.preflight = { source: childSource, method: "Target.getTargetInfo" };
        try { route.preflight.result = await invoke(childSource, "Target.getTargetInfo", {}); }
        catch (error) { route.preflight.error = String(error); route.preflight.notAttached = notAttached(error, childId); }
        assert(route.preflight.notAttached === true, "Independent route was not proven unattached by this extension");
        try { route.independentACK = await invoke(childSource, "debugger.attach", { version: "1.3" }); owned.push({ source: childSource, kind: "target" }); route.childSource = childSource; }
        catch (error) { route.independentError = String(error); }
      }
      if (!route.childSource) continue;
      route.frameTree = await invoke(route.childSource, "Page.getFrameTree");
      assert(route.frameTree.frameTree?.frame?.id === childId, "Independent route returned a different root frame");
      const parent = route.frameTree.frameTree.frame.parentId; route.parentObserved = parent !== undefined;
      assert(parent === undefined || parent === frameId, "Independent route returned a different parent frame");
      await describeDocument(route.childSource, childId, route.frameTree, depth + 1);
    }
    row.finalIdentity = await invoke(source, "Runtime.callFunctionOn", { objectId, functionDeclaration: "function(){return this.document===document&&this.document.defaultView===window&&this.root===this.document.documentElement}", returnByValue: true, silent: true });
    assert(!row.finalIdentity.exceptionDetails && row.finalIdentity.result?.value === true, "Document replaced during original native reads");
    await proveGroupRelease(source, first.executionContextId);
  }
  async function readNativePointer() {
    const result = detail.reader = { point: structuredClone(reader.point), leases: [], groups: [] };
    assert(typeof factories?.createNativePointerFeedback === "function" && typeof factories?.createFrameGeometryRuntime === "function", "Original staged native reader factories unavailable");
    assert(Number.isFinite(reader.point?.x) && Number.isFinite(reader.point?.y), "Finite authored reader point required");
    let invalid = false;
    const check = () => { assert(!invalid && !rootDetached && Object.values(state()).every(value => value === true), "Original reader attachment authority changed"); };
    const known = source => sourceKey(source) === sourceKey(rootSource) || owned.some(route => sourceKey(route.source) === sourceKey(source) && !route.nativeDetached && !route.detached);
    const send = (source, method, params) => {
      check(); assert(known(source), "Reader attempted an unowned native route");
      const original = invoke(source, method, params);
      const after = () => { try { check(); assert(known(source), "Reader native route changed during original command"); } catch (error) { invalid = true; result.authorityError ??= String(error); } };
      nativeThen.call(original, after, after); return original;
    };
    const adapter = { check, send,
      prepareGroup(source, name) {
        check(); assert(known(source), "Reader group requested an unowned native route");
        const row = { source: structuredClone(source), name, released: false, closed: false }; result.groups.push(row);
        return {
          async releaseGroup() {
            // Cleanup keeps original route authority; it never reattaches one.
            assert(!rootDetached && state().sameAttachment && known(source), "Original reader cleanup route changed");
            row.ack = await invoke(source, "Runtime.releaseObjectGroup", { objectGroup: name }); row.released = true;
            const group = groups.get(`${sourceKey(source)}:${name}`); if (group) group.released = true;
            for (const resource of resources) if (sourceKey(resource.source) === sourceKey(source) && resource.objectGroup === name) { resource.released = true; resource.releaseMethod = "Runtime.releaseObjectGroup"; }
          },
          close() { assert(row.released, "Reader group closed before its original ACK"); row.closed = true; }
        };
      },
      acquireChild({ parentTarget, frameId }) {
        check(); assert(known(parentTarget), "Reader child requested by an unowned parent");
        const source = { targetId: frameId }, row = { parentSource: structuredClone(parentTarget), targetId: frameId, source, acquired: false, released: false };
        result.leases.push(row); detail.routes.push(row); let resource;
        const ready = (async () => {
          // Chromium lazily materializes DevToolsAgentHost entries. Discovery
          // does not establish client ownership; the exact native preflight below does.
          const targets = await invoke(rootSource, "debugger.getTargets"); check();
          assert(Array.isArray(targets), "Reader target discovery did not return an inventory");
          const exact = targets.filter(value => value.id === frameId);
          assert(exact.length === 1, "Reader exact native frame target unavailable or ambiguous"); row.target = exact[0];
          row.preflight = { source, method: "Target.getTargetInfo" };
          try { row.preflight.result = await invoke(source, "Target.getTargetInfo", {}); }
          catch (error) { row.preflight.error = String(error); row.preflight.notAttached = notAttached(error, frameId); }
          assert(row.preflight.notAttached === true, "Reader independent route was not proven unattached by this extension"); check();
          row.attachACK = await invoke(source, "debugger.attach", { version: "1.3" });
          resource = { source, kind: "target", detached: false }; owned.push(resource); row.acquired = true; check();
          return source;
        })();
        return { ready,
          check() { check(); assert(row.acquired && !row.released && !resource?.nativeDetached && !resource?.detached, "Original reader child route retired"); },
          async release() {
            try { await ready; } catch {}
            if (resource && !resource.detached) { row.detachACK = await invoke(source, "debugger.detach"); resource.detached = true; }
            row.released = true;
          }
        };
      }
    };
    const spec = factories.createNativePointerFeedback({ target: rootSource, ...reader.point, geometry: factories.createFrameGeometryRuntime(), adapter });
    assert(spec && typeof spec.read === "function" && typeof spec.cleanup === "function", "Original reader did not create a read contract");
    try { result.result = await spec.read(check); result.readSettled = true; }
    catch (error) { result.readSettled = true; fail(result, "readError", error); }
    finally {
      try { await spec.cleanup(); result.cleanupComplete = true; }
      catch (error) { result.cleanupComplete = false; fail(result, "cleanupError", error); }
    }
  }
  try {
    detail.initialState = state();
    if (reader) { await readNativePointer(); }
    else {
    detail.frameTree = await invoke(rootSource, "Page.getFrameTree");
    const frame = detail.frameTree.frameTree?.frame; assert(frame?.id && frame?.loaderId, "Original root frame/loader unavailable");
    await describeDocument(rootSource, frame.id, detail.frameTree, 0);
    assert(detail.documents[0].description, "Original root document could not be read");
    detail.finalFrameTree = await invoke(rootSource, "Page.getFrameTree");
    assert(detail.finalFrameTree.frameTree?.frame?.id === frame.id && detail.finalFrameTree.frameTree.frame.loaderId === frame.loaderId, "Original root frame/loader changed during diagnostic");
    }
  } catch (error) { fail(detail, "error", error); }
  finally {
    for (const resource of resources.reverse()) if (!resource.released) try { checkCleanupRoute(resource.source); resource.ack = await invoke(resource.source, "Runtime.releaseObject", { objectId: resource.objectId }); resource.released = true; resource.releaseMethod = "Runtime.releaseObject"; } catch (error) { fail(resource, "error", error); }
    for (const group of groups.values()) if (!group.released) try { checkCleanupRoute(group.source); group.ack = await invoke(group.source, "Runtime.releaseObjectGroup", { objectGroup: group.objectGroup }); group.released = true; } catch (error) { fail(group, "error", error); }
    for (const route of owned.reverse()) { const row = { ...route, detached: !!route.detached }; detail.cleanup.push(row);
      if (!row.detached) try { checkCleanupRoute(route.source); row.ack = route.kind === "session" ? await invoke(rootSource, "Target.detachFromTarget", { sessionId: route.sessionId }) : await invoke(route.source, "debugger.detach"); row.detached = true; } catch (error) { fail(row, "error", error); }
    }
    detail.resources = resources; detail.groups = [...groups.values()];
    for (const route of detail.routes) route.nativeAttachEvents = detail.records.filter(row => row.kind === "event" && row.method === "Target.attachedToTarget" && row.params?.targetInfo?.targetId === route.targetId);
    api.debugger.onEvent.removeListener(onEvent); api.debugger.onDetach.removeListener(onDetach); detail.restored = true;
    if (target.__obuColdNativeRouteProbe === detail) delete target.__obuColdNativeRouteProbe;
    detail.finalState = state();
    try { assert(detail.pending === 0 && !detail.overflow, "Diagnostic native observation incomplete"); assert(Object.values(detail.finalState).every(value => value === true), "Original raw attachment or engine state changed"); } catch (error) { fail(detail, "cleanupError", error); }
    if (failure) detail.error ??= String(failure?.stack ?? failure);
  }
  return detail;
}

export async function inspectColdNativeRoutes({ getWorker, tabId, independentTarget = false, reader, saveDetail }) {
  const detail = await getWorker().evaluate(`(${runColdNativeRouteProbe.toString()})(chrome,globalThis,${JSON.stringify({ tabId, independentTarget, reader })},globalThis.__integrationNativePointerFactory)`);
  let saveError; try { await saveDetail(detail); } catch (error) { saveError = error; }
  if (detail.error) throw Error(detail.error);
  if (saveError) throw saveError;
  return detail;
}
