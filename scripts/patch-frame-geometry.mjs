// Chromium reports DOM quads in the renderer's local-root viewport. A same-
// process frame is already transformed there; only renderer boundaries require
// composing a new projection. This factory is serialized into the pinned CRX.
export function createFrameGeometryRuntime() {
  const feedbackTargets = new WeakMap();
  const feedback = (point, handle, progress, state, model) => {
    // Optional visual evidence cannot fail input or change its selected point.
    if (typeof obuCapturePointerTarget === "function") {
      try { feedbackTargets.set(point, obuCapturePointerTarget(handle, progress, state, model)); } catch {}
    }
    return point;
  };
  const identity = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const identities = new WeakMap();
  let nextIdentity = 0;
  const identityOf = (object) => {
    if (!identities.has(object)) identities.set(object, ++nextIdentity);
    return identities.get(object);
  };
  const disconnected = () => Object.assign(new Error("Frame geometry changed document or route"), { obuGeometryDisconnected: true });
  const invalid = (message) => Object.assign(new Error(message), { obuGeometryInvalid: true });
  const hasNoLayout = (error) => /Could not compute box model|Node does not have a layout object/.test(error?.message || "");
  const finitePoint = (p) => p && Number.isFinite(p.x) && Number.isFinite(p.y);
  const cross = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  function quad(raw) {
    if (!Array.isArray(raw) || raw.length !== 8 || !raw.every(Number.isFinite)) throw invalid("Invalid native content quad");
    const points = Array.from({ length: 4 }, (_, i) => ({ x: raw[i * 2], y: raw[i * 2 + 1] }));
    let sign;
    for (let i = 0; i < 4; i++) {
      const a = points[i], b = points[(i + 1) % 4], c = points[(i + 2) % 4];
      const value = cross(a, b, c);
      const scale = Math.hypot(b.x - a.x, b.y - a.y) * Math.hypot(c.x - b.x, c.y - b.y);
      if (!Number.isFinite(value) || Math.abs(value) <= Number.EPSILON * 64 * scale || !value) throw invalid("Degenerate native content quad");
      if (sign !== undefined && sign !== Math.sign(value)) throw invalid("Non-convex native content quad");
      sign = Math.sign(value);
    }
    return points;
  }
  function project(matrix, point) {
    if (!finitePoint(point)) throw invalid("Invalid frame point");
    const divisor = matrix[6] * point.x + matrix[7] * point.y + matrix[8];
    if (!Number.isFinite(divisor) || !divisor) throw invalid("Frame projection crosses infinity");
    const result = { x: (matrix[0] * point.x + matrix[1] * point.y + matrix[2]) / divisor,
      y: (matrix[3] * point.x + matrix[4] * point.y + matrix[5]) / divisor };
    if (!finitePoint(result)) throw invalid("Non-finite frame projection");
    return result;
  }
  function inverse(m) {
    const a = m[4] * m[8] - m[5] * m[7], b = m[5] * m[6] - m[3] * m[8], c = m[3] * m[7] - m[4] * m[6];
    const terms = [m[0] * a, m[1] * b, m[2] * c], det = terms[0] + terms[1] + terms[2];
    if (!Number.isFinite(det) || !det || Math.abs(det) <= Number.EPSILON * 64 * terms.reduce((n, v) => n + Math.abs(v), 0))
      throw invalid("Singular frame projection");
    return [a, m[2] * m[7] - m[1] * m[8], m[1] * m[5] - m[2] * m[4],
      b, m[0] * m[8] - m[2] * m[6], m[2] * m[3] - m[0] * m[5],
      c, m[1] * m[6] - m[0] * m[7], m[0] * m[4] - m[1] * m[3]].map((v) => v / det);
  }
  function plane(raw, width, height) {
    if (!(width > 0) || !(height > 0) || !Number.isFinite(width) || !Number.isFinite(height)) throw invalid("Invalid CSS content plane size");
    const p = quad(raw), [p0, p1, p2, p3] = p;
    const dx1 = p1.x - p2.x, dx2 = p3.x - p2.x, dx3 = p0.x - p1.x + p2.x - p3.x;
    const dy1 = p1.y - p2.y, dy2 = p3.y - p2.y, dy3 = p0.y - p1.y + p2.y - p3.y;
    const divisor = dx1 * dy2 - dx2 * dy1;
    let g = 0, h = 0;
    if (dx3 || dy3) {
      if (!divisor || !Number.isFinite(divisor)) throw invalid("Singular content plane");
      g = (dx3 * dy2 - dx2 * dy3) / divisor;
      h = (dx1 * dy3 - dx3 * dy1) / divisor;
    }
    // All four denominators must stay on the same side of the projective
    // horizon. Convex, finite perspective projections work without a shortcut.
    if (![1, 1 + g, 1 + g + h, 1 + h].every((v) => Number.isFinite(v) && v > Number.EPSILON * 64))
      throw invalid("Content plane crosses a projective horizon");
    const matrix = [(p1.x - p0.x + g * p1.x) / width, (p3.x - p0.x + h * p3.x) / height, p0.x,
      (p1.y - p0.y + g * p1.y) / width, (p3.y - p0.y + h * p3.y) / height, p0.y, g / width, h / height, 1];
    if (!matrix.every(Number.isFinite)) throw invalid("Non-finite content plane");
    return { forward: matrix, inverse: inverse(matrix), polygon: p };
  }
  function clip(polygon, boundary) {
    const winding = Math.sign(cross(boundary[0], boundary[1], boundary[2]));
    let result = polygon;
    for (let i = 0; i < boundary.length && result.length; i++) {
      const a = boundary[i], b = boundary[(i + 1) % boundary.length], input = result;
      result = [];
      for (let j = 0; j < input.length; j++) {
        const previous = input[(j + input.length - 1) % input.length], current = input[j];
        const d0 = winding * cross(a, b, previous), d1 = winding * cross(a, b, current);
        if ((d0 >= 0) !== (d1 >= 0)) {
          const t = d0 / (d0 - d1);
          result.push({ x: previous.x + t * (current.x - previous.x), y: previous.y + t * (current.y - previous.y) });
        }
        if (d1 >= 0) result.push(current);
      }
    }
    return result;
  }
  function area(polygon) {
    return Math.abs(polygon.reduce((sum, p, i) => {
      const q = polygon[(i + 1) % polygon.length]; return sum + p.x * q.y - q.x * p.y;
    }, 0)) / 2;
  }
  const rectangle = (width, height) => [{ x: 0, y: 0 }, { x: width, y: 0 }, { x: width, y: height }, { x: 0, y: height }];

  // A fixed utility-world function. Resolved CSS dimensions preserve fractional
  // content sizes; innerWidth and native model.width are rounded and cannot be
  // used to normalize the iframe's content quad.
  function readOwnerPlane([injected, node]) {
    if (!node?.isConnected || node.ownerDocument !== injected.document ||
        !/^(iframe|frame)$/i.test(node.localName || "")) return "error:notconnected";
    const view = node.ownerDocument.defaultView;
    if (!view) return "error:notconnected";
    const s = view.getComputedStyle(node);
    const number = (value) => /^-?(?:\d+\.?\d*|\.\d+)px$/.test(value) ? Number.parseFloat(value) : NaN;
    const width = number(s.width), height = number(s.height);
    const horizontal = number(s.borderLeftWidth) + number(s.borderRightWidth) + number(s.paddingLeft) + number(s.paddingRight);
    const vertical = number(s.borderTopWidth) + number(s.borderBottomWidth) + number(s.paddingTop) + number(s.paddingBottom);
    return { width: s.boxSizing === "border-box" ? width - horizontal : width,
      height: s.boxSizing === "border-box" ? height - vertical : height,
      boxSizing: s.boxSizing, cssWidth: width, cssHeight: height, horizontal, vertical };
  }
  function readElementPlane([injected, node]) {
    if (!node?.isConnected || node.ownerDocument !== injected.document) return "error:notconnected";
    const view = node.ownerDocument.defaultView;
    if (!view) return "error:notconnected";
    const s = view.getComputedStyle(node), rects = node.getClientRects();
    const number = (value) => /^-?(?:\d+\.?\d*|\.\d+)px$/.test(value) ? Number.parseFloat(value) : NaN;
    const cssWidth = number(s.width), cssHeight = number(s.height);
    const borders = [s.borderLeftWidth, s.borderRightWidth, s.borderTopWidth, s.borderBottomWidth].map(number);
    const padding = [s.paddingLeft, s.paddingRight, s.paddingTop, s.paddingBottom].map(number);
    // Non-replaced inline boxes ignore specified width/height. SVG and
    // fragmented elements do not have this single CSS padding-plane contract.
    // Preserve their inherited local AABB semantics, without inventing a size
    // from rounded offsetWidth/clientWidth or a union of separate fragments.
    const replaced = /^(canvas|img|video|audio|iframe|input|textarea|select|button|object|embed)$/i.test(node.localName || "");
    if (node.namespaceURI !== "http://www.w3.org/1999/xhtml" || rects.length !== 1 ||
        s.display === "inline" && !replaced || !["content-box", "border-box"].includes(s.boxSizing) ||
        ![cssWidth, cssHeight, ...borders, ...padding].every(Number.isFinite)) {
      const box = node.getBoundingClientRect();
      return { mode: "legacy", x: box.x, y: box.y, width: box.width, height: box.height,
        left: Number.parseFloat(s.borderLeftWidth || "0"), top: Number.parseFloat(s.borderTopWidth || "0"),
        namespace: node.namespaceURI, display: s.display, fragments: rects.length };
    }
    const width = s.boxSizing === "border-box" ? cssWidth - borders[0] - borders[1] : cssWidth + padding[0] + padding[1];
    const height = s.boxSizing === "border-box" ? cssHeight - borders[2] - borders[3] : cssHeight + padding[2] + padding[3];
    return { mode: "padding", width, height, cssWidth, cssHeight, boxSizing: s.boxSizing, borders, padding };
  }
  function readViewport() {
    return { width: innerWidth, height: innerHeight, scrollX, scrollY,
      visualX: visualViewport?.offsetLeft ?? 0, visualY: visualViewport?.offsetTop ?? 0,
      visualScale: visualViewport?.scale ?? 1 };
  }
  const contextCurrent = (context) => context && !context._contextDestroyedScope?.isClosed() &&
    context.frame._contextData?.get(context.world)?.context === context;
  function viewportValid(value) {
    return value && Object.values(value).every(Number.isFinite) && value.width > 0 && value.height > 0 && value.visualScale > 0;
  }
  async function snapshot(handle, progress, layoutOnly = false) {
    const page = handle._page, delegate = page.delegate, target = handle._frame, originalContext = handle._context;
    const frames = [], handles = [], rows = [];
    const pinned = new Map(), frameMaps = new Map(), sessionMaps = new Map();
    let primaryError;
    const check = () => {
      progress.throwIfAborted();
      if (progress.timeUntilDeadline() <= 0) throw new Error("Frame geometry action deadline exceeded");
      if (handle._disposed || !contextCurrent(originalContext) || originalContext.frame !== target ||
          originalContext.delegate._client !== delegate._sessionForFrame(target)._client) throw disconnected();
      for (const row of rows) {
        if (row.frame.parentFrame() !== row.parent || page.frameManager.frame(row.frame._id) !== row.frame ||
            delegate._sessionForFrame(row.frame) !== row.session || row.session._client !== row.client ||
            row.context.delegate._client !== row.client || !contextCurrent(row.context)) throw disconnected();
        if (row.frame.pendingDocument()) throw disconnected();
      }
    };
    const read = async (operation) => { check(); const value = await operation(); check(); return value; };
    const close = () => {
      // Pinned JSHandle.dispose() clears its local reference synchronously and
      // starts a best-effort native release. It returns void, not a release ACK.
      // Keep that inherited contract; these are temporary geometry handles.
      let failure;
      for (const element of handles) {
        try { element.dispose(); } catch (error) { failure ??= error; }
      }
      if (failure && !primaryError) throw failure;
    };
    try {
      for (let frame = target; frame; frame = frame.parentFrame()) {
        if (frames.includes(frame)) throw disconnected();
        frames.unshift(frame);
      }
      if (frames[0] !== page.mainFrame()) throw disconnected();
      for (let i = 0; i < frames.length; i++) {
        const frame = frames[i], parent = i ? frames[i - 1] : null, session = delegate._sessionForFrame(frame);
        check();
        const context = await frame._utilityContext();
        const row = { frame, parent, session, client: session._client, context };
        rows.push(row); pinned.set(frame, row); check();
        row.injected = await read(() => context.injectedScript());
        row.viewport = layoutOnly ? undefined : await read(() => context.evaluate(readViewport));
        if (!layoutOnly && !viewportValid(row.viewport)) throw invalid("Invalid frame viewport");
        row.identity = { frameId: frame._id, parentId: parent?._id ?? null, sessionId: session._client._sessionId,
          localRootId: session._targetId, contextId: context.delegate._contextId,
          frameIdentity: identityOf(frame), sessionIdentity: identityOf(session), contextIdentity: identityOf(context), viewport: row.viewport };
        if (!parent) {
          frameMaps.set(frame, { forward: identity, inverse: identity, polygon: layoutOnly ? [] : rectangle(row.viewport.width, row.viewport.height) });
          sessionMaps.set(session, identity);
          continue;
        }
        const parentRow = pinned.get(parent);
        const owner = await read(() => parentRow.client.send("DOM.getFrameOwner", { frameId: frame._id }));
        if (!Number.isSafeInteger(owner.backendNodeId) || owner.backendNodeId <= 0) throw disconnected();
        check();
        // Track a late acquired handle before rechecking cancellation, so it is
        // still released when the original budget expired during adoption.
        const element = await parentRow.session._adoptBackendNodeId(owner.backendNodeId, parentRow.context);
        if (!element) throw disconnected();
        handles.push(element); row.element = element; check();
        if (element._context !== parentRow.context || delegate._sessionForHandle(element) !== parentRow.session) throw disconnected();
        const model = await read(async () => {
          try { return await parentRow.client.send("DOM.getBoxModel", { objectId: element._objectId }); }
          catch (error) {
            if (layoutOnly && hasNoLayout(error)) return null;
            throw error;
          }
        });
        // Let read() recheck the original deadline and route before treating a
        // hidden ancestor as absent layout. Only the layout query uses this.
        if (model === null) throw Object.assign(new Error("Frame owner has no layout box"), { obuGeometryNoLayout: true });
        const size = await read(() => parentRow.context.evaluate(readOwnerPlane, [parentRow.injected, element]));
        if (size === "error:notconnected") throw disconnected();
        const raw = model?.model?.content;
        if (layoutOnly && (!Array.isArray(raw) || raw.length !== 8 || !raw.every(Number.isFinite)))
          throw invalid("Invalid native content quad");
        // A same-renderer target's native border already includes these
        // ancestors, including singular transforms and zero-sized frames.
        // Layout queries need their route/no-layout checks, not an inverse.
        if (layoutOnly && session === parentRow.session) continue;
        if (!size || !Object.values(size).filter((value) => typeof value !== "string").every(Number.isFinite) ||
            !["border-box", "content-box"].includes(size.boxSizing)) throw invalid("Unknown iframe content plane");
        const sessionMap = sessionMaps.get(parentRow.session);
        if (!sessionMap) throw disconnected();
        const ownerPoints = layoutOnly ? Array.from({ length: 4 }, (_, n) => ({ x: raw[2 * n], y: raw[2 * n + 1] })) : quad(raw);
        if (layoutOnly && ownerPoints.some((p) => !(sessionMap[6] * p.x + sessionMap[7] * p.y + sessionMap[8] > 0)))
          throw invalid("Frame owner crosses or lies behind a projective horizon");
        const rootQuad = ownerPoints.map((p) => project(sessionMap, p));
        const map = plane(rootQuad.flatMap((p) => [p.x, p.y]), size.width, size.height);
        frameMaps.set(frame, map);
        if (session !== parentRow.session) {
          if (session._targetId !== frame._id || sessionMaps.has(session)) throw disconnected();
          sessionMaps.set(session, map.forward);
        }
        row.size = size;
        row.identity = { ...row.identity, ownerBackendNodeId: owner.backendNodeId, contentQuad: [...model.model.content], plane: size };
      }
      check();
      return { rows, check, read, close, frameMaps, sessionMaps, target, fingerprint: rows.map((row) => row.identity) };
    } catch (error) {
      primaryError = error;
      await close();
      throw error;
    }
  }
  async function withSnapshot(handle, progress, operation, layoutOnly = false) {
    let state, primaryError;
    try { state = await snapshot(handle, progress, layoutOnly); return await operation(state); }
    catch (error) {
      primaryError = error;
      if (error?.obuGeometryDisconnected) return "error:notconnected";
      if (error?.obuGeometryInvalid) return { hitTargetDescription: "unusable frame geometry: " + error.message };
      throw error;
    } finally {
      if (state) {
        try { state.close(); if (!primaryError) state.check(); } catch (error) { if (!primaryError) throw error; }
      }
    }
  }
  async function clickable(handle, progress) {
    const value = await withSnapshot(handle, progress, async (state) => {
      const session = handle._page.delegate._sessionForHandle(handle), map = state.sessionMaps.get(session);
      if (!map) throw disconnected();
      const response = await state.read(() => session._client.send("DOM.getContentQuads", { objectId: handle._objectId }));
      if (!response?.quads?.length) return "error:notvisible";
      const localRoot = state.rows.find((row) => row.session === session);
      const visibleWidth = Math.min(localRoot.viewport.width, localRoot.size?.width ?? Infinity);
      const visibleHeight = Math.min(localRoot.viewport.height, localRoot.size?.height ?? Infinity);
      for (const raw of response.quads) {
        if (!Array.isArray(raw) || raw.length !== 8 || !raw.every(Number.isFinite)) throw invalid("Invalid target quad");
        // Inline/fragmented nodes may have an empty fragment before a visible
        // one. Preserve upstream per-fragment filtering, not an all-or-nothing
        // rejection. An owner's transform remains strictly non-degenerate.
        const points = Array.from({ length: 4 }, (_, i) => ({ x: raw[2 * i], y: raw[2 * i + 1] }));
        if (!area(points)) continue;
        let polygon = clip(quad(raw), rectangle(visibleWidth, visibleHeight));
        if (polygon.length < 3) continue;
        // Clip in the source local-root plane BEFORE a perspective projection.
        // An offscreen polygon can otherwise cross infinity and fold back into
        // a plausible visible polygon in the destination viewport.
        polygon = polygon.map((p) => project(map, p));
        for (const row of state.rows) {
          const frameMap = state.frameMaps.get(row.frame);
          polygon = clip(polygon, frameMap.polygon);
          const width = Math.min(row.viewport.width, row.size?.width ?? Infinity);
          const height = Math.min(row.viewport.height, row.size?.height ?? Infinity);
          polygon = clip(polygon, rectangle(width, height).map((p) => project(frameMap.forward, p)));
        }
        if (polygon.length < 3 || area(polygon) <= 0.99) continue;
        state.check();
        return feedback({ x: polygon.reduce((sum, p) => sum + p.x, 0) / polygon.length,
          y: polygon.reduce((sum, p) => sum + p.y, 0) / polygon.length }, handle, progress, state);
      }
      return "error:notinviewport";
    });
    return value?.hitTargetDescription ? "error:notinviewport" : value;
  }
  async function positionGeometry(handle, value, state) {
    if (!finitePoint(value)) throw invalid("Invalid element position");
    const row = state.rows.at(-1);
    const size = await state.read(() => row.context.evaluate(readElementPlane, [row.injected, handle]));
    if (size === "error:notconnected") throw disconnected();
    if (size?.mode === "legacy") {
      const point = { x: size.x + size.left + value.x, y: size.y + size.top + value.y };
      return { point: project(state.frameMaps.get(state.target).forward, point),
        fingerprint: { elementPosition: size, handleIdentity: identityOf(handle) } };
    }
    if (size?.mode !== "padding") throw invalid("Unknown element padding plane");
    const session = handle._page.delegate._sessionForHandle(handle), map = state.sessionMaps.get(session);
    if (!map) throw disconnected();
    const model = await state.read(() => session._client.send("DOM.getBoxModel", { objectId: handle._objectId }));
    const raw = model?.model?.padding;
    const elementMap = plane(raw, size.width, size.height);
    // Native padding quads already include every transform inside this
    // renderer. Compose only the local-root session map, never the frame map.
    return { point: project(map, project(elementMap.forward, value)), model,
      fingerprint: { elementPosition: size, paddingQuad: [...raw], handleIdentity: identityOf(handle) } };
  }
  async function offset(handle, value, progress) {
    const result = await withSnapshot(handle, progress, async (state) => {
      const result = await positionGeometry(handle, value, state);
      return feedback(result.point, handle, progress, state, result.model);
    });
    return result?.hitTargetDescription ? "error:notvisible" : result;
  }
  async function bounding(handle, progress) {
    if (!progress || typeof progress.throwIfAborted !== "function" || typeof progress.timeUntilDeadline !== "function")
      throw new Error("Bounding geometry requires the original action progress");
    let result;
    try { result = await withSnapshot(handle, progress, async (state) => {
      const session = handle._page.delegate._sessionForHandle(handle), map = state.sessionMaps.get(session);
      if (!map) throw disconnected();
      const response = await state.read(async () => {
        try { return await session._client.send("DOM.getBoxModel", { objectId: handle._objectId }); }
        catch (error) {
          // A hidden/detached node has no layout box. Do not turn an unknown
          // native error, broken ancestor projection or lost route into null.
          if (hasNoLayout(error)) return null;
          throw error;
        }
      });
      if (response === null) return null;
      const raw = response?.model?.border;
      if (!Array.isArray(raw) || raw.length !== 8 || !raw.every(Number.isFinite)) throw invalid("Invalid native border quad");
      const points = Array.from({ length: 4 }, (_, i) => ({ x: raw[2 * i], y: raw[2 * i + 1] }));
      // Unlike clickable areas, layout boxes may have zero width or height and
      // may extend outside every viewport. Project the actual corners before
      // taking their enclosing box; a local AABB loses rotated-frame geometry.
      const denominators = points.map((p) => map[6] * p.x + map[7] * p.y + map[8]);
      if (denominators.some((v) => !Number.isFinite(v) || v <= 0))
        throw invalid("Border quad crosses or lies behind a projective horizon");
      const projected = points.map((p) => project(map, p));
      const x = Math.min(...projected.map((p) => p.x)), y = Math.min(...projected.map((p) => p.y));
      const width = Math.max(...projected.map((p) => p.x)) - x, height = Math.max(...projected.map((p) => p.y)) - y;
      if (![x, y, width, height].every(Number.isFinite)) throw invalid("Non-finite projected bounding box");
      return { x, y, width, height };
    }, true); } catch (error) {
      if (error?.obuGeometryNoLayout) return null;
      throw error;
    }
    if (result === "error:notconnected") throw disconnected();
    if (result?.hitTargetDescription) throw invalid(result.hitTargetDescription);
    return result;
  }
  async function hit(handle, point, progress, position) {
    return withSnapshot(handle, progress, async (state) => {
      if (position !== undefined) {
        const target = await positionGeometry(handle, position, state);
        // Use the pinned pointer pipeline's exact rounding, not an invented
        // tolerance. This also catches layout changes between point selection
        // and the first hit test. Later checks preserve the original root point.
        const rounded = { x: (target.point.x * 100 | 0) / 100, y: (target.point.y * 100 | 0) / 100 };
        if (point.x !== rounded.x || point.y !== rounded.y)
          return { hitTargetDescription: "element position geometry changed" };
        state.fingerprint.push(target.fingerprint);
      }
      for (let i = 1; i < state.rows.length; i++) {
        const row = state.rows[i], parent = state.rows[i - 1];
        const parentPoint = project(state.frameMaps.get(parent.frame).inverse, point);
        const result = await state.read(() => parent.context.evaluate(([injected, element, hitPoint]) => {
          if (!element.isConnected || element.ownerDocument !== injected.document) return "error:notconnected";
          return injected.expectHitTarget(hitPoint, element);
        }, [parent.injected, row.element, parentPoint]));
        if (result !== "done") return result;
      }
      state.check();
      return { framePoint: project(state.frameMaps.get(state.target).inverse, point), frameGeometry: state.fingerprint };
    });
  }
  async function drag(handle, point, progress, position, install) {
    return withSnapshot(handle, progress, async (state) => {
      if (position !== undefined) {
        const target = await positionGeometry(handle, position, state);
        const rounded = { x: (target.point.x * 100 | 0) / 100, y: (target.point.y * 100 | 0) / 100 };
        if (point.x !== rounded.x || point.y !== rounded.y) return { hitTargetDescription: "element position geometry changed" };
        state.fingerprint.push(target.fingerprint);
      }
      const session = handle._page.delegate._sessionForHandle(handle);
      const response = await state.read(() => session._client.send("DOM.getContentQuads", { objectId: handle._objectId }));
      if (!response?.quads?.length || response.quads.some((raw) => !Array.isArray(raw) || raw.length !== 8 || !raw.every(Number.isFinite)))
        throw invalid("Unavailable drag element quads");
      // Include the leaf even for an implicit center. A transform about an
      // unchanged center must not reuse geometry captured before drag handlers.
      state.fingerprint.push({ dragElementIdentity: identityOf(handle), contentQuads: response.quads.map((raw) => [...raw]) });
      for (let i = 0; i < state.rows.length; i++) {
        const row = state.rows[i], element = state.rows[i + 1]?.element ?? handle;
        const localPoint = project(state.frameMaps.get(row.frame).inverse, point);
        const result = await state.read(() => row.context.evaluate(([injected, node, hitPoint]) => {
          if (!node.isConnected || node.ownerDocument !== injected.document) return "error:notconnected";
          return injected.expectHitTarget(hitPoint, node);
        }, [row.injected, element, localPoint]));
        if (result !== "done") return result;
        // The caller owns every installed remote guard, including a native
        // result arriving after cancellation. Snapshot only owns owner handles.
        if (install) { state.check(); await install(element, localPoint); state.check(); }
      }
      return { framePoint: project(state.frameMaps.get(state.target).inverse, point), frameGeometry: state.fingerprint };
    });
  }
  return { quad, plane, project, inverse, clip, area, readOwnerPlane, readElementPlane, clickable, offset, bounding, hit, drag,
    targetForPoint: point => feedbackTargets.get(point) };
}

function replaceOnce(source, before, after, label) {
  if (source.split(before).length !== 2) throw new Error(`CRX frame geometry patch: expected one ${label}`);
  return source.replace(before, after);
}

export function patchCrxFrameGeometry(source) {
  source = replaceOnce(source, "let ElementHandle$1 = class ElementHandle extends JSHandle$1 {",
    `const obuFrameGeometry = (${createFrameGeometryRuntime.toString()})();\nlet ElementHandle$1 = class ElementHandle extends JSHandle$1 {`, "element handle class");
  const clickableStart = source.indexOf("  async _clickablePoint() {");
  const offsetEnd = source.indexOf("  async _retryAction(", clickableStart);
  if (clickableStart < 0 || offsetEnd < 0) throw new Error("CRX frame geometry patch: point methods absent");
  source = source.slice(0, clickableStart) + `  async _clickablePoint(progress) { return obuFrameGeometry.clickable(this, progress); }
  async _offsetPoint(offset, progress) { return obuFrameGeometry.offset(this, offset, progress); }
` + source.slice(offsetEnd);
  const hitStart = source.indexOf("  async _checkFrameIsHitTarget(point) {");
  const hitEnd = source.indexOf("\n};\nfunction throwRetargetableDOMError", hitStart);
  if (hitStart < 0 || hitEnd < 0) throw new Error("CRX frame geometry patch: frame hit method absent");
  source = source.slice(0, hitStart) + `  async _checkFrameIsHitTarget(point, progress, position) { return obuFrameGeometry.hit(this, point, progress, position); }` + source.slice(hitEnd);
  source = replaceOnce(source, "const maybePoint = position ? await this._offsetPoint(position) : await this._clickablePoint();",
    "const maybePoint = position ? await this._offsetPoint(position, progress2) : await this._clickablePoint(progress2);", "point progress");
  source = replaceOnce(source, "const frameCheckResult = await this._checkFrameIsHitTarget(point);",
    "const frameCheckResult = await this._checkFrameIsHitTarget(point, progress2, position);", "frame hit progress");
  source = replaceOnce(source, "  async boundingBox() {\n    return this._page.delegate.getBoundingBox(this);\n  }",
    "  async boundingBox(progress) {\n    return progress ? obuFrameGeometry.bounding(this, progress) : this._page.delegate.getBoundingBox(this);\n  }", "server bounding box");
  source = replaceOnce(source, "      const boundingBox = await handle.boundingBox();",
    "      const boundingBox = await handle.boundingBox(progress2);", "element screenshot progress");
  source = replaceOnce(source, "scheme.ElementHandleBoundingBoxParams = tOptional(tObject({}));",
    "scheme.ElementHandleBoundingBoxParams = tOptional(tObject({ timeout: tOptional(tNumber) }));", "bounding box private timeout schema");
  source = replaceOnce(source, "  async boundingBox(params, metadata) {\n    const value = await this._elementHandle.boundingBox();\n    return { value: value || void 0 };\n  }",
    "  async boundingBox(params, metadata) {\n    const controller = new ProgressController(metadata, this._elementHandle);\n    const value = await controller.run(progress => this._elementHandle.boundingBox(progress), params?.timeout);\n    return { value: value || void 0 };\n  }", "bounding box dispatcher progress");
  source = replaceOnce(source, "  async boundingBox() {\n    const value = (await this._elementChannel.boundingBox()).value;\n    return value === void 0 ? null : value;\n  }",
    "  async boundingBox(options2 = {}) {\n    const value = (await this._elementChannel.boundingBox({ timeout: this._frame._timeout(options2) })).value;\n    return value === void 0 ? null : value;\n  }", "client bounding box timeout");
  return replaceOnce(source, '  async boundingBox(options2) {\n    return await this._withElement((h) => h.boundingBox(), { title: "Bounding box", timeout: options2 == null ? void 0 : options2.timeout });\n  }',
    '  async boundingBox(options2) {\n    const timeout = this._frame._timeout(options2);\n    return await this._withElement((h, remaining) => {\n      if (timeout && remaining <= 0) throw new TimeoutError2(`Timeout ${timeout}ms exceeded.`);\n      return h.boundingBox({ timeout: remaining });\n    }, { title: "Bounding box", timeout });\n  }', "locator bounding box remaining timeout");
}
