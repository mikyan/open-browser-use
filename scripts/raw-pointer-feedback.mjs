// Serialized into the pinned runtime. Optional reads use actual native promises,
// not Playwright's context cancellation race or best-effort JSHandle.dispose().
export function createRawPointerFeedbackRuntime(geometry) {
  const identity = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  function hitAt(x, y) {
    let hit = document.elementFromPoint(x, y);
    const seen = new Set();
    while (hit?.shadowRoot && !seen.has(hit)) {
      seen.add(hit);
      const inner = hit.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === hit || !hit.shadowRoot.contains(inner)) break;
      hit = inner;
    }
    // A frame must be descended before choosing any interactive ancestor.
    const interactive = ['button', 'a[href]', 'input', 'textarea', 'select', 'summary',
      '[contenteditable]:not([contenteditable="false"])', '[role="button"]', '[role="link"]',
      '[role="checkbox"]', '[role="radio"]', '[role="switch"]', '[role="textbox"]',
      '[tabindex]:not([tabindex="-1"])'].join(',');
    const target = /^(iframe|frame)$/i.test(hit?.localName || "") ? hit : hit?.closest(interactive) ?? hit;
    return target?.isConnected && target.ownerDocument === document &&
      target !== document.body && target !== document.documentElement ? target : null;
  }
  return function create(page, x, y, hooks) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || typeof hooks?.prepareMediaCleanup !== "function") return undefined;
    const rootFrame = page.mainFrame(), rows = [], leases = [], sessionMaps = new Map();
    const rootDocument = rootFrame._currentDocument;
    const rootSession = page.delegate._sessionForFrame(rootFrame);
    const rootClient = rootSession._client, transport = rootClient._connection?._transport;
    const rootMatch = /^crx-tab-(\d+)$/.exec(rootClient._sessionId || "");
    const tabId = rootMatch ? Number(rootMatch[1]) : undefined;
    const attachment = transport?._tabToTarget?.get(tabId);
    if (!attachment || typeof transport?._send !== "function") return undefined;
    const target = Object.freeze({ tabId });
    const route = session => {
      const client = session._client;
      if (client._connection !== rootClient._connection) throw new Error("Original raw feedback connection changed");
      if (session === rootSession) return target;
      if (transport._sessions.get(client._sessionId) !== tabId) throw new Error("Original raw feedback child route changed");
      return Object.freeze({ tabId, sessionId: client._sessionId });
    };
    const check = () => {
      if (rootClient._closed || rootClient._connection._closed || transport._tabToTarget.get(tabId) !== attachment ||
          page.mainFrame() !== rootFrame || rootFrame._currentDocument !== rootDocument)
        throw new Error("Original raw feedback root changed");
      for (const row of rows) {
        if (row.frame.parentFrame() !== row.parent || page.frameManager.frame(row.frame._id) !== row.frame ||
            row.frame._currentDocument !== row.document || row.frame.pendingDocument() ||
            page.delegate._sessionForFrame(row.frame) !== row.session || row.session._targetId !== row.sessionTarget || row.session._client._closed ||
            row.context.delegate._client !== row.session._client || row.context._contextDestroyedScope.isClosed() ||
            row.frame._contextData.get("utility")?.context !== row.context)
          throw new Error("Original raw feedback frame changed");
        route(row.session);
      }
    };
    const cleanup = async () => {
      // No scope admission here: exact native leases can release while paused.
      // A failed ACK preserves the original object and lease for explicit retry.
      for (const lease of leases) {
        for (const objectId of lease.objects) {
          await lease.native.release(objectId);
          lease.objects.delete(objectId);
        }
        if (!lease.closed) { lease.native.close(); lease.closed = true; }
      }
    };
    return { target, check, cleanup, decode: value => value,
      read: async checkScope => {
        const guard = () => { check(); checkScope(); };
        let frame = rootFrame, frameMap = identity;
        sessionMaps.set(rootSession, identity);
        const seen = new Set();
        for (let depth = 0; depth < 32; depth++) {
          guard();
          if (seen.has(frame)) throw new Error("Cyclic raw feedback frame route");
          seen.add(frame);
          const context = frame._contextData.get("utility")?.context;
          if (!context) return null;
          const session = page.delegate._sessionForFrame(frame);
          const row = { frame, parent: frame.parentFrame(), document: frame._currentDocument, session, sessionTarget: session._targetId, context };
          rows.push(row); guard();
          const nativeTarget = route(session), sessionMap = sessionMaps.get(session);
          if (!sessionMap) return null;
          const lease = { native: hooks.prepareMediaCleanup(nativeTarget, context.delegate._contextId), objects: new Set(), closed: false };
          leases.push(lease);
          const send = async (method, params) => {
            guard();
            const response = await transport._send(nativeTarget, method, params, guard);
            // Own even late and exceptional allocations before checking scope.
            for (const remote of [response?.result, response?.exceptionDetails?.exception]) {
              if (typeof remote?.objectId === "string" && remote.objectId) lease.objects.add(remote.objectId);
            }
            guard();
            if (response?.exceptionDetails) throw new Error("Raw feedback utility read failed");
            return response;
          };
          const local = geometry.project(geometry.inverse(frameMap), { x, y });
          const hit = await send("Runtime.evaluate", {
            expression: "(" + String(hitAt) + ")(" + JSON.stringify(local.x) + "," + JSON.stringify(local.y) + ")",
            contextId: context.delegate._contextId, returnByValue: false, awaitPromise: false, userGesture: false
          });
          const objectId = hit?.result?.objectId;
          if (!objectId) return null;
          const described = await send("DOM.describeNode", { objectId, depth: 0 });
          const node = described?.node;
          if (!Number.isSafeInteger(node?.backendNodeId) || node.backendNodeId < 1) return null;
          const model = (await send("DOM.getBoxModel", { objectId }))?.model;
          const projectQuad = raw => geometry.quad(raw).map(point => {
            if (!(sessionMap[6] * point.x + sessionMap[7] * point.y + sessionMap[8] > 0))
              throw new Error("Raw feedback plane crosses infinity");
            return geometry.project(sessionMap, point);
          });
          if (!/^(iframe|frame)$/i.test(node.localName || node.nodeName || "")) {
            const points = projectQuad(model?.border);
            const left = Math.min(...points.map(point => point.x)), top = Math.min(...points.map(point => point.y));
            guard();
            return { x: left, y: top, width: Math.max(...points.map(point => point.x)) - left,
              height: Math.max(...points.map(point => point.y)) - top };
          }
          const child = page.frameManager.frame(node.frameId);
          if (!child || child.parentFrame() !== frame || seen.has(child)) return null;
          const owner = await send("DOM.getFrameOwner", { frameId: child._id });
          if (owner?.backendNodeId !== node.backendNodeId) return null;
          const size = (await send("Runtime.callFunctionOn", {
            objectId, functionDeclaration: "function() { return (" + String(geometry.readOwnerPlane) + ")([{document}, this]); }",
            returnByValue: true, awaitPromise: false, userGesture: false
          }))?.result?.value;
          const projected = projectQuad(model?.content).flatMap(point => [point.x, point.y]);
          const childPlane = geometry.plane(projected, size?.width, size?.height);
          const childLocal = geometry.project(childPlane.inverse, { x, y });
          if (childLocal.x < 0 || childLocal.y < 0 || childLocal.x >= size.width || childLocal.y >= size.height) return null;
          const childSession = page.delegate._sessionForFrame(child);
          if (childSession !== session) {
            if (childSession._targetId !== child._id) return null;
            if (sessionMaps.has(childSession)) return null;
            route(childSession); sessionMaps.set(childSession, childPlane.forward);
          }
          frame = child; frameMap = childPlane.forward;
        }
        return null;
      }
    };
  };
}
