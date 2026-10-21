// chrome.debugger can omit already-loaded OOPIFs from the parent's frame tree.
// Supply only the missing CDP frame attachment, using the child's real frame
// tree; Playwright continues to own all frame, locator, and action semantics.
const framesByTransport = new WeakMap();
const frameChanges = new WeakMap();
const contextsByTransport = new WeakMap();
const childrenByTransport = new WeakMap();

function retireChild(children, sessionId) {
  const child = children?.get(sessionId);
  if (!child) return;
  children.delete(sessionId);
  child.delivered(null);
}

function currentChild(transport, child) {
  return childrenByTransport.get(transport)?.get(child.sessionId) === child &&
    transport._tabToTarget.get(child.tabId) === child.attachment &&
    transport._sessions.get(child.sessionId) === child.tabId &&
    (child.parentSessionId === `crx-tab-${child.tabId}` || transport._sessions.get(child.parentSessionId) === child.tabId);
}

// CRX keeps the one original CRSession even when its Frame has not arrived yet.
// This controller can adopt that session once, or rebind its existing
// FrameSession after a cache restore. It never replays Target.attachedToTarget.
export function getCrxChildFrameAdmission(transport, parentSessionId, event) {
  const child = childrenByTransport.get(transport)?.get(event.sessionId);
  if (!child || child.event !== event || child.parentSessionId !== parentSessionId || !currentChild(transport, child)) return null;
  return () => currentChild(transport, child);
}

export function bindCrxChildFrameSession(transport, parentSessionId, event, controller) {
  const child = childrenByTransport.get(transport)?.get(event.sessionId);
  if (!child || child.event !== event || child.parentSessionId !== parentSessionId || !currentChild(transport, child) || child.controller) return false;
  child.controller = controller;
  return true;
}

export function isCrxChildFrameSessionCurrent(transport, sessionId, requireInitialFrame = true) {
  const child = childrenByTransport.get(transport)?.get(sessionId);
  return !!child && currentChild(transport, child) && child.controller?.isCurrent() === true &&
    (!requireInitialFrame || child.controller.initialFrameCurrent() === true);
}

export function finishCrxFrameMessage(transport, message) {
  if (message.method !== "Target.attachedToTarget" || message.params?.targetInfo?.type !== "iframe") return;
  const child = childrenByTransport.get(transport)?.get(message.params.sessionId);
  if (!child || child.event !== message.params) return;
  // Pinned CRSession queues the original event listener before this microtask.
  // Its absence is a failed delivery, never an unbounded wait for a new owner.
  Promise.resolve().then(() => child.delivered(currentChild(transport, child) ? child.controller ?? null : null));
}

function tabForSession(transport, sessionId) {
  const root = /^crx-tab-(\d+)$/.exec(sessionId ?? "");
  return root ? Number(root[1]) : transport._sessions.get(sessionId);
}

function framesFor(transport, tabId) {
  let tabs = framesByTransport.get(transport);
  if (!tabs) { tabs = new Map(); framesByTransport.set(transport, tabs); }
  if (!tabs.has(tabId)) tabs.set(tabId, new Map());
  return tabs.get(tabId);
}

function removeChildren(frames, parentId) {
  for (const [frameId, parent] of frames) {
    if (parent !== parentId) continue;
    removeChildren(frames, frameId);
    frames.delete(frameId);
  }
}

export function observeCrxFrameMessage(transport, message) {
  if (message.method === "Target.detachedFromTarget") {
    const detached = message.params?.sessionId;
    contextsByTransport.get(transport)?.delete(detached);
    retireChild(childrenByTransport.get(transport), detached);
    if (!message.sessionId) {
      const tabId = tabForSession(transport, detached);
      framesByTransport.get(transport)?.delete(tabId);
      for (const [sessionId, record] of contextsByTransport.get(transport) ?? []) {
        if (record.tabId === tabId) contextsByTransport.get(transport).delete(sessionId);
      }
      for (const [sessionId, child] of childrenByTransport.get(transport) ?? []) {
        if (child.tabId === tabId) retireChild(childrenByTransport.get(transport), sessionId);
      }
      return;
    }
  }
  const tabId = tabForSession(transport, message.sessionId);
  if (tabId === undefined) return;
  if (message.method.startsWith("Runtime.executionContext")) {
    let sessions = contextsByTransport.get(transport);
    if (!sessions) { sessions = new Map(); contextsByTransport.set(transport, sessions); }
    if (!sessions.has(message.sessionId)) sessions.set(message.sessionId, { tabId, contexts: new Map() });
    const contexts = sessions.get(message.sessionId).contexts;
    if (message.method === "Runtime.executionContextsCleared") contexts.clear();
    else if (message.method === "Runtime.executionContextDestroyed") contexts.delete(message.params.executionContextId);
    else if (message.method === "Runtime.executionContextCreated") contexts.set(message.params.context.id, message);
    return;
  }
  let frames = framesFor(transport, tabId);
  const params = message.params;
  if (message.method === "Page.getFrameTree" && message.result?.frameTree) {
    const visit = tree => {
      frames.set(tree.frame.id, tree.frame.parentId ?? null);
      for (const child of tree.childFrames ?? []) visit(child);
    };
    visit(message.result.frameTree);
  } else if (message.method === "Page.frameAttached") {
    frames.set(params.frameId, params.parentFrameId);
  } else if (message.method === "Page.frameNavigated") {
    if (!params.frame.parentId) {
      // Invalidate a pending child-tree read from the previous top document.
      frames = new Map();
      framesByTransport.get(transport).set(tabId, frames);
      if (message.sessionId === `crx-tab-${tabId}` && params.type !== "BackForwardCacheRestore") {
        for (const [sessionId, child] of childrenByTransport.get(transport) ?? []) {
          if (child.tabId === tabId) retireChild(childrenByTransport.get(transport), sessionId);
        }
      }
    }
    removeChildren(frames, params.frame.id);
    frames.set(params.frame.id, params.frame.parentId ?? null);
  } else if (message.method === "Page.frameDetached" && params.reason !== "swap") {
    const removed = new Set([params.frameId]);
    const visit = frameId => { for (const [id, parent] of frames) if (parent === frameId) { removed.add(id); visit(id); } };
    visit(params.frameId);
    for (const [sessionId, child] of childrenByTransport.get(transport) ?? []) {
      if (child.tabId === tabId && removed.has(child.targetId)) retireChild(childrenByTransport.get(transport), sessionId);
    }
    removeChildren(frames, params.frameId);
    frames.delete(params.frameId);
  }
  if (["Page.frameAttached", "Page.frameNavigated", "Page.frameDetached", "Target.detachedFromTarget"].includes(message.method)) frameChanges.set(frames, (frameChanges.get(frames) ?? 0) + 1);
}

export async function prepareCrxChildFrame(transport, parent, event, sendCommand = (target, method) => chrome.debugger.sendCommand(target, method)) {
  if (event.targetInfo?.type !== "iframe") return;
  const { tabId, sessionId } = parent;
  const childSessionId = event.sessionId;
  const targetId = event.targetInfo.targetId;
  const rootTarget = transport.getTargetId(tabId);
  const frames = framesFor(transport, tabId);
  if (!rootTarget || transport._sessions.get(childSessionId) !== tabId) return;
  let children = childrenByTransport.get(transport);
  if (!children) { children = new Map(); childrenByTransport.set(transport, children); }
  // A duplicate native event cannot replace an already bound original session.
  if (!children.has(childSessionId)) {
    let delivered;
    const delivery = new Promise(resolve => { delivered = resolve; });
    children.set(childSessionId, { tabId, sessionId: childSessionId, parentSessionId: sessionId, targetId,
      attachment: transport._tabToTarget.get(tabId), event, delivery, delivered });
  }
  if (frames.has(targetId)) return;
  let frame;
  try { frame = (await sendCommand({ tabId, sessionId: childSessionId }, "Page.getFrameTree"))?.frameTree?.frame; }
  catch { return; } // A target removed during attachment retains native failure behavior.
  // A detach/navigation may happen during the read. Never resurrect a stale
  // tab/session, infer a parent from a URL, or duplicate an observed attachment.
  if (transport.getTargetId(tabId) !== rootTarget || transport._sessions.get(childSessionId) !== tabId || framesByTransport.get(transport)?.get(tabId) !== frames || frames.has(targetId)) return;
  if (frame?.id !== targetId || !frame.parentId || !frames.has(frame.parentId)) return;
  transport._emitMessage({
    method: "Page.frameAttached", sessionId,
    params: { frameId: frame.id, parentFrameId: frame.parentId }
  });
}

// BFCache can report child contexts before the root navigation, without child
// attachment events. PW drops those contexts while the old frame tree is live.
// Rebuild missing local frames and rebind each original live OOPIF session
// from its own native tree, then bind their actual still-live contexts.
// Lifecycle reporting comes last; no load is fabricated.
export async function refreshCrxCachedLifecycle(transport, message, sendCommand = (target, method, params) => chrome.debugger.sendCommand(target, method, params)) {
  if (message.method !== "Page.frameNavigated" || message.params?.type !== "BackForwardCacheRestore") return;
  const tabId = tabForSession(transport, message.sessionId);
  if (tabId === undefined || !transport.getTargetId(tabId)) return;
  const rootSession = message.sessionId === `crx-tab-${tabId}`;
  if (!rootSession && transport._sessions.get(message.sessionId) !== tabId) return;
  const attachment = transport._tabToTarget.get(tabId), frames = framesFor(transport, tabId), changes = frameChanges.get(frames);
  const original = message.params.frame, target = rootSession ? { tabId } : { tabId, sessionId: message.sessionId };
  if (!attachment || !original?.id || !original.loaderId) return;
  const current = () => transport._tabToTarget.get(tabId) === attachment && framesByTransport.get(transport)?.get(tabId) === frames &&
    frameChanges.get(frames) === changes && (rootSession || transport._sessions.get(message.sessionId) === tabId);
  const tree = (await sendCommand(target, "Page.getFrameTree"))?.frameTree;
  if (!current() || tree?.frame.id !== original.id || tree.frame.loaderId !== original.loaderId) return;
  const remote = [];
  if (rootSession) for (const child of childrenByTransport.get(transport)?.values() ?? []) {
    if (child.tabId !== tabId || !currentChild(transport, child)) continue;
    const controller = await child.delivery;
    if (!current()) return;
    if (!currentChild(transport, child) || !controller?.isCurrent()) return;
    const childTree = (await sendCommand({ tabId, sessionId: child.sessionId }, "Page.getFrameTree"))?.frameTree;
    if (!current() || !currentChild(transport, child) || !controller.isCurrent()) return;
    if (childTree?.frame.id !== child.targetId || !childTree.frame.parentId || !childTree.frame.loaderId) return;
    const seen = new Set();
    const validTree = (node, parentId) => {
      if (!node.frame?.id || !node.frame.loaderId || node.frame.parentId !== parentId || seen.has(node.frame.id)) return false;
      seen.add(node.frame.id);
      return (node.childFrames ?? []).every(descendant => validTree(descendant, node.frame.id));
    };
    if (!validTree(childTree, childTree.frame.parentId)) return;
    remote.push({ child, controller, tree: childTree });
  }
  const missing = [];
  const visit = (node, parentId) => {
    if (node.frame?.parentId !== parentId || !node.frame.id || !node.frame.loaderId) return;
    if (!frames.has(node.frame.id)) missing.push(node.frame);
    for (const child of node.childFrames ?? []) visit(child, node.frame.id);
  };
  for (const child of tree.childFrames ?? []) visit(child, original.id);
  const repaired = new Set();
  for (const frame of missing) {
    if (!frames.has(frame.parentId) || frames.has(frame.id)) continue;
    transport._emitMessage({ method: "Page.frameAttached", sessionId: message.sessionId, params: { frameId: frame.id, parentFrameId: frame.parentId } });
    transport._emitMessage({ method: "Page.frameNavigated", sessionId: message.sessionId, params: { frame, type: "Navigation" } });
    repaired.add(frame.id);
  }
  for (const context of contextsByTransport.get(transport)?.get(message.sessionId)?.contexts.values() ?? []) {
    if (repaired.has(context.params.context.auxData?.frameId)) transport._emitMessage(context);
  }
  const expectedChanges = frameChanges.get(frames);
  // The local native event delivery is queued by CRSession. Let that exact
  // delivery create parents before the original child controllers use them.
  await Promise.resolve();
  const stillOriginal = () => transport._tabToTarget.get(tabId) === attachment && framesByTransport.get(transport)?.get(tabId) === frames &&
    frameChanges.get(frames) === expectedChanges;
  while (remote.length) {
    const index = remote.findIndex(item => frames.has(item.tree.frame.parentId));
    if (index < 0 || !stillOriginal()) return;
    const { child, controller, tree: childTree } = remote.splice(index, 1)[0];
    if (!currentChild(transport, child) || !controller.isCurrent()) return;
    // No URL/target guess: parent and every child come from this original
    // session's native tree, under the still-current restored root.
    const add = node => {
      frames.set(node.frame.id, node.frame.parentId ?? null);
      for (const descendant of node.childFrames ?? []) add(descendant);
    };
    add(childTree);
    const initialized = controller.restore(childTree);
    if (!initialized) return;
    await initialized;
    if (!stillOriginal() || !currentChild(transport, child) || !controller.isCurrent()) return;
    for (const context of contextsByTransport.get(transport)?.get(child.sessionId)?.contexts.values() ?? []) {
      if (frames.has(context.params.context.auxData?.frameId)) transport._emitMessage(context);
    }
    await sendCommand({ tabId, sessionId: child.sessionId }, "Page.setLifecycleEventsEnabled", { enabled: true });
    if (!stillOriginal() || !currentChild(transport, child) || !controller.isCurrent()) return;
  }
  if (!stillOriginal()) return;
  await sendCommand(target, "Page.setLifecycleEventsEnabled", { enabled: true });
}
