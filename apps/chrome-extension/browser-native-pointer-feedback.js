// Optional cold-coordinate evidence. The adapter owns native attachment/route
// authority; this reader never initializes a Page, changes domain subscriptions,
// dispatches input, or substitutes a parent frame for an unavailable leaf.
// One identity per backend/module lifetime, never one world per coordinate read.
// Random names avoid an ordinary caller reusing a documented, shared world.
// This is not isolation from a raw-CDP peer that races the first bootstrap with
// the same debugging authority. No public CDP command is filtered or delayed.
// Captured DOM functions survive later DOM-prototype/own-property changes. This
// is not a sandbox against arbitrary same-realm JavaScript-intrinsic tampering.
export const NATIVE_POINTER_WORLD = "Open Browser Use passive pointer " + crypto.randomUUID();
const kernelKey = "__obuNativePointer_" + crypto.randomUUID();
const kernelToken = crypto.randomUUID();

function captureDocument(view, key, token, readOwnerPlane) {
  const descriptor = Object.getOwnPropertyDescriptor;
  const previous = descriptor(view, key);
  let kernel;
  if (previous) {
    // Inspect the descriptor before reading any unknown value/accessor. A
    // coincidentally present property must never be invoked as a bootstrap.
    if (previous.get || previous.set || previous.configurable || previous.writable) return null;
    kernel = previous.value;
    const mark = kernel && descriptor(kernel, "token"), capture = kernel && descriptor(kernel, "capture");
    if (!mark || mark.get || mark.set || mark.value !== token || mark.configurable || mark.writable ||
        !capture || capture.get || capture.set || typeof capture.value !== "function" ||
        capture.configurable || capture.writable) return null;
  } else {
    // Capture methods/getters from the fresh realm once. The per-read wrapper
    // below never consults mutable DOM prototypes or document own properties.
    const apply = Reflect.apply, freeze = Object.freeze, define = Object.defineProperty;
    const getter = (prototype, name) => descriptor(prototype, name).get;
    const documentGetter = descriptor(view, "document")?.get;
    if (typeof documentGetter !== "function") return null;
    const documentElement = getter(Document.prototype, "documentElement");
    const body = getter(Document.prototype, "body"), defaultView = getter(Document.prototype, "defaultView");
    const connected = getter(Node.prototype, "isConnected"), ownerDocument = getter(Node.prototype, "ownerDocument");
    const localName = getter(Element.prototype, "localName"), shadowRoot = getter(Element.prototype, "shadowRoot");
    const elementAt = Document.prototype.elementFromPoint, shadowAt = ShadowRoot.prototype.elementFromPoint;
    const contains = Node.prototype.contains, closest = Element.prototype.closest;
    const getStyle = view.getComputedStyle, cssValue = CSSStyleDeclaration.prototype.getPropertyValue;
    const setHas = Set.prototype.has, setAdd = Set.prototype.add, NativeSet = Set;
    const regexTest = RegExp.prototype.test, frameName = /^(iframe|frame)$/i;
    const interactive = 'button,a[href],input,textarea,select,summary,[contenteditable]:not([contenteditable="false"]),[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="switch"],[role="textbox"],[tabindex]:not([tabindex="-1"])';
    const call = (fn, receiver, args = []) => apply(fn, receiver, args);
    const capture = () => {
      const document = call(documentGetter, view), root = call(documentElement, document);
      const inDocument = node => !!node && call(connected, node) && call(ownerDocument, node) === document;
      const current = () => call(documentGetter, view) === document && call(defaultView, document) === view &&
        call(documentElement, document) === root && inDocument(root);
      if (!current()) return null;
      const valid = node => current() && inDocument(node);
      const hit = (x, y) => {
        if (!current()) return null;
        let node = call(elementAt, document, [x, y]);
        const seen = new NativeSet();
        while (node && !call(setHas, seen, [node])) {
          const shadow = call(shadowRoot, node);
          if (!shadow) break;
          call(setAdd, seen, [node]);
          const inner = call(shadowAt, shadow, [x, y]);
          if (!inner || inner === node || !call(contains, shadow, [inner])) break;
          node = inner;
        }
        if (!node) return null;
        const target = call(regexTest, frameName, [call(localName, node)]) ? node : call(closest, node, [interactive]) ?? node;
        return valid(target) && target !== call(body, document) && target !== root ? target : null;
      };
      const ownerPlane = node => {
        if (!valid(node)) return null;
        const name = call(localName, node);
        if (!call(regexTest, frameName, [name])) return null;
        const style = call(getStyle, view, [node]);
        const value = property => call(cssValue, style, [property]);
        // Preserve the shared fractional CSS formula unchanged, supplying only
        // captured native values through a private facade, never the live DOM.
        const css = { width: value("width"), height: value("height"), boxSizing: value("box-sizing"),
          borderLeftWidth: value("border-left-width"), borderRightWidth: value("border-right-width"),
          borderTopWidth: value("border-top-width"), borderBottomWidth: value("border-bottom-width"),
          paddingLeft: value("padding-left"), paddingRight: value("padding-right"),
          paddingTop: value("padding-top"), paddingBottom: value("padding-bottom") };
        const facade = { defaultView: { getComputedStyle: () => css } };
        return readOwnerPlane([{ document: facade }, { isConnected: true, ownerDocument: facade, localName: name }]);
      };
      return freeze({ root: () => current() ? root : null, hit, valid, ownerPlane });
    };
    kernel = freeze({ token, capture });
    define(view, key, { value: kernel, configurable: false, writable: false, enumerable: false });
  }
  return kernel.capture();
}

function originalRoot() { return this.root(); }
function hitAt(x, y) { return this.hit(x, y); }
function originalNode(node) { return this.valid(node); }
function ownerPlane(node) { return this.ownerPlane(node); }

const identity = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const validId = value => typeof value === "string" && value.length > 0 && value.length <= 4096;
const validBackend = value => Number.isSafeInteger(value) && value > 0;
const unavailable = () => new Error("Original native pointer document or route is unavailable");

function routeKey(target) {
  if (!target || typeof target !== "object" || Array.isArray(target) ||
      Object.keys(target).some(key => !["tabId", "targetId", "sessionId"].includes(key)) ||
      (target.tabId !== undefined && (!Number.isSafeInteger(target.tabId) || target.tabId < 0)) ||
      (target.targetId !== undefined && !validId(target.targetId)) ||
      ((Number.isSafeInteger(target.tabId) && target.tabId >= 0) === validId(target.targetId)) ||
      (target.sessionId !== undefined && !validId(target.sessionId))) throw unavailable();
  return JSON.stringify([target.tabId ?? null, target.targetId ?? null, target.sessionId ?? null]);
}

function frameTree(value) {
  const frames = new Map();
  function visit(tree, parent) {
    const frame = tree?.frame;
    if (!validId(frame?.id) || !validId(frame.loaderId) || frames.has(frame.id) ||
        (parent !== undefined && frame.parentId !== parent) ||
        (frame.parentId !== undefined && !validId(frame.parentId)) ||
        (tree.childFrames !== undefined && !Array.isArray(tree.childFrames))) throw unavailable();
    frames.set(frame.id, Object.freeze({ id: frame.id, parentId: frame.parentId, loaderId: frame.loaderId }));
    for (const child of tree.childFrames ?? []) visit(child, frame.id);
  }
  visit(value, undefined);
  return { root: value.frame.id, frames };
}

/**
 * Returns the PassivePointerReads read/check/cleanup contract, without starting
 * native work. send() must expose its actual native Promise. prepareGroup()
 * captures an original-route cleanup lease with releaseGroup/close;
 * it must not waive late allocations on numeric context-ID destruction alone.
 * Optional acquireChild() returns null or an owned { ready, check, release }
 * lease. The reader owns that lease before awaiting ready, including failed or
 * late attachment. The adapter must not detach a caller-owned route.
 */
export function createNativePointerFeedback({ target, x, y, geometry, adapter }) {
  if (!Number.isFinite(x) || !Number.isFinite(y) ||
      !["quad", "plane", "project", "inverse", "readOwnerPlane"].every(key => typeof geometry?.[key] === "function") ||
      !["check", "send", "prepareGroup"].every(key => typeof adapter?.[key] === "function")) return undefined;
  let rootTarget;
  try { routeKey(target); rootTarget = Object.freeze({ ...target }); adapter.check(); } catch { return undefined; }
  const groups = new Map(), routes = [], rows = [], snapshots = new Map();
  const groupPrefix = "obu-native-pointer-" + crypto.randomUUID();
  let started = false, closing = false, readPending, cleanupPending;
  const check = () => adapter.check();
  const guard = checkScope => {
    if (closing) throw unavailable();
    check(); checkScope();
    for (const route of routes) route.lease.check();
  };
  const groupFor = nativeTarget => {
    const key = routeKey(nativeTarget);
    if (!groups.has(key)) {
      const name = groupPrefix + "-" + groups.size;
      const lease = adapter.prepareGroup(nativeTarget, name);
      if (!["releaseGroup", "close"].every(k => typeof lease?.[k] === "function")) throw unavailable();
      groups.set(key, { name, lease, objects: new Set(), released: false, closed: false });
    }
    return groups.get(key);
  };
  const read = checkScope => {
    if (started || closing) throw new Error("Native pointer read cannot be replayed");
    started = true;
    readPending = (async () => {
      const send = async (nativeTarget, method, params, group) => {
        guard(checkScope);
        const result = await adapter.send(nativeTarget, method, params);
        // Acquire every returned handle before any authority/document check.
        // Even an exception from a by-value call can allocate a remote object.
        if (group) for (const remote of [result?.result, result?.exceptionDetails?.exception]) {
          if (remote?.objectId !== undefined) {
            if (!validId(remote.objectId)) throw unavailable();
            group.objects.add(remote.objectId);
          }
        }
        guard(checkScope);
        if (result?.exceptionDetails) throw unavailable();
        return result;
      };
      const call = (row, fn, args = [], returnByValue = true) => send(row.target, "Runtime.callFunctionOn", {
        objectId: row.documentObject, functionDeclaration: String(fn), arguments: args,
        objectGroup: row.group.name, returnByValue, awaitPromise: false, userGesture: false, silent: true
      }, row.group);
      const tree = async nativeTarget => frameTree((await send(nativeTarget, "Page.getFrameTree", {}))?.frameTree);
      let nativeTarget = rootTarget, snapshot = await tree(nativeTarget);
      snapshots.set(routeKey(nativeTarget), { target: nativeTarget, snapshot });
      let frame = snapshot.frames.get(snapshot.root), frameMap = identity, sessionMap = identity;
      const seen = new Set();
      for (let depth = 0; depth < 32; depth++) {
        guard(checkScope);
        if (seen.has(frame.id)) return null;
        seen.add(frame.id);
        const world = await send(nativeTarget, "Page.createIsolatedWorld", {
          frameId: frame.id, worldName: NATIVE_POINTER_WORLD, grantUniveralAccess: false
        });
        if (!Number.isSafeInteger(world?.executionContextId) || world.executionContextId <= 0) return null;
        const group = groupFor(nativeTarget);
        const captured = await send(nativeTarget, "Runtime.evaluate", {
          expression: "(" + String(captureDocument) + ")(this," + JSON.stringify(kernelKey) + "," +
            JSON.stringify(kernelToken) + ",(" + String(geometry.readOwnerPlane) + "))", contextId: world.executionContextId,
          objectGroup: group.name, returnByValue: false, awaitPromise: false, userGesture: false, silent: true
        }, group);
        if (!validId(captured?.result?.objectId)) return null;
        const row = { target: nativeTarget, frame, group, documentObject: captured.result.objectId };
        rows.push(row);
        const root = await call(row, originalRoot, [], false);
        if (!validId(root?.result?.objectId)) return null;
        row.rootObject = root.result.objectId;
        const rootNode = (await send(nativeTarget, "DOM.describeNode", { objectId: row.rootObject, depth: 0 }))?.node;
        // Chromium's native description stamps a document element with its
        // actual FrameId. Unlike a numeric context ID, this proves the frame
        // reached by the first capture, including a reused-context-ID race.
        if (rootNode?.frameId !== frame.id || !validBackend(rootNode?.backendNodeId)) return null;
        row.rootBackend = rootNode.backendNodeId;
        const local = geometry.project(geometry.inverse(frameMap), { x, y });
        const hit = await call(row, hitAt, [{ value: local.x }, { value: local.y }], false);
        if (!validId(hit?.result?.objectId)) return null;
        row.nodeObject = hit.result.objectId;
        const node = (await send(nativeTarget, "DOM.describeNode", { objectId: row.nodeObject, depth: 0 }))?.node;
        if (!validBackend(node?.backendNodeId)) return null;
        row.nodeBackend = node.backendNodeId;
        const model = (await send(nativeTarget, "DOM.getBoxModel", { objectId: row.nodeObject }))?.model;
        const projectQuad = raw => geometry.quad(raw).map(point => {
          if (!(sessionMap[6] * point.x + sessionMap[7] * point.y + sessionMap[8] > 0)) throw unavailable();
          return geometry.project(sessionMap, point);
        });
        if (!/^(iframe|frame)$/i.test(node.localName || node.nodeName || "")) {
          const points = projectQuad(model?.border);
          // Recheck every original tree/document/owner at the end; use only
          // pinned objects, never a newly evaluated global document/context.
          for (const entry of snapshots.values()) {
            const latest = await tree(entry.target);
            if (latest.root !== entry.snapshot.root) return null;
            for (const original of rows.filter(r => routeKey(r.target) === routeKey(entry.target))) {
              const now = latest.frames.get(original.frame.id);
              if (!now || now.parentId !== original.frame.parentId || now.loaderId !== original.frame.loaderId) return null;
            }
          }
          for (const original of rows) {
            if ((await call(original, originalNode, [{ objectId: original.nodeObject }]))?.result?.value !== true) return null;
            const described = (await send(original.target, "DOM.describeNode", { objectId: original.rootObject, depth: 0 }))?.node;
            if (described?.frameId !== original.frame.id || described.backendNodeId !== original.rootBackend) return null;
            if (original.childId) {
              const owner = await send(original.target, "DOM.getFrameOwner", { frameId: original.childId });
              if (owner?.backendNodeId !== original.nodeBackend) return null;
            }
          }
          guard(checkScope);
          const left = Math.min(...points.map(p => p.x)), top = Math.min(...points.map(p => p.y));
          return { x: left, y: top, width: Math.max(...points.map(p => p.x)) - left,
            height: Math.max(...points.map(p => p.y)) - top };
        }
        const childId = node.frameId;
        if (!validId(childId) || seen.has(childId)) return null;
        const owner = await send(nativeTarget, "DOM.getFrameOwner", { frameId: childId });
        if (owner?.backendNodeId !== row.nodeBackend) return null;
        row.childId = childId;
        const size = (await call(row, ownerPlane, [{ objectId: row.nodeObject }]))?.result?.value;
        if (!size || !(size.width > 0) || !(size.height > 0)) return null;
        const projected = projectQuad(model?.content).flatMap(point => [point.x, point.y]);
        const childPlane = geometry.plane(projected, size.width, size.height);
        const childLocal = geometry.project(childPlane.inverse, { x, y });
        if (childLocal.x < 0 || childLocal.y < 0 || childLocal.x >= size.width || childLocal.y >= size.height) return null;
        let child = snapshot.frames.get(childId);
        if (child) {
          if (child.parentId !== frame.id) return null;
        } else {
          const lease = adapter.acquireChild?.({ parentTarget: nativeTarget, parentFrameId: frame.id, frameId: childId });
          if (!lease) return null;
          if (typeof lease.check !== "function" || typeof lease.release !== "function") throw unavailable();
          const route = { lease, released: false }; routes.push(route);
          const acquired = await lease.ready;
          guard(checkScope);
          routeKey(acquired);
          const key = routeKey(acquired);
          if (snapshots.has(key)) return null;
          nativeTarget = Object.freeze({ ...acquired });
          snapshot = await tree(nativeTarget);
          child = snapshot.frames.get(snapshot.root);
          if (child.id !== childId || child.parentId !== frame.id) return null;
          snapshots.set(key, { target: nativeTarget, snapshot });
          sessionMap = childPlane.forward;
        }
        frame = child; frameMap = childPlane.forward;
      }
      return null;
    })();
    return readPending;
  };
  const cleanup = () => {
    if (cleanupPending) return cleanupPending;
    closing = true;
    cleanupPending = (async () => {
      // Even an early explicit cleanup must wait for the actual allocation or
      // child attach response. Visual cancellation does not settle native work.
      try { await readPending; } catch {}
      for (const group of groups.values()) {
        // Every allocating call explicitly uses this unique group. V8 wraps
        // both result and exceptionDetails.exception in that same group, also
        // for callFunctionOn compile/execute failures. Releasing the group works
        // after an old context disappears, unlike releaseObject's ObjectScope
        // lookup. Keep all handles until that actual original-route group ACK.
        if (!group.released) {
          await group.lease.releaseGroup();
          group.released = true;
          group.objects.clear();
        }
        if (!group.closed) { group.lease.close(); group.closed = true; }
      }
      for (const route of [...routes].reverse()) {
        if (!route.released) { await route.lease.release(); route.released = true; }
      }
    })().catch(error => { cleanupPending = undefined; throw error; });
    return cleanupPending;
  };
  return { target: rootTarget, check, read, cleanup, decode: value => value };
}
