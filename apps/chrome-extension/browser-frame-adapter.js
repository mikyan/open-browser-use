// chrome.debugger can omit already-loaded OOPIFs from the parent's frame tree.
// Supply only the missing CDP frame attachment, using the child's real frame
// tree; Playwright continues to own all frame, locator, and action semantics.
const framesByTransport = new WeakMap();
const revisions = new WeakMap();
const contextsByTransport = new WeakMap();

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
    if (!message.sessionId) {
      const tabId = tabForSession(transport, detached);
      framesByTransport.get(transport)?.delete(tabId);
      for (const [sessionId, record] of contextsByTransport.get(transport) ?? []) {
        if (record.tabId === tabId) contextsByTransport.get(transport).delete(sessionId);
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
    }
    removeChildren(frames, params.frame.id);
    frames.set(params.frame.id, params.frame.parentId ?? null);
  } else if (message.method === "Page.frameDetached" && params.reason !== "swap") {
    removeChildren(frames, params.frameId);
    frames.delete(params.frameId);
  }
  if (["Page.getFrameTree", "Page.frameAttached", "Page.frameNavigated", "Page.frameDetached", "Target.detachedFromTarget"].includes(message.method)) revisions.set(frames, (revisions.get(frames) ?? 0) + 1);
}

export async function prepareCrxChildFrame(transport, parent, event, sendCommand = (target, method) => chrome.debugger.sendCommand(target, method)) {
  if (event.targetInfo?.type !== "iframe") return;
  const { tabId, sessionId } = parent;
  const childSessionId = event.sessionId;
  const targetId = event.targetInfo.targetId;
  const rootTarget = transport.getTargetId(tabId);
  const frames = framesFor(transport, tabId);
  if (!rootTarget || frames.has(targetId) || transport._sessions.get(childSessionId) !== tabId) return;
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
// Rebuild only missing local frames from the native tree, then bind their actual
// still-live contexts. Lifecycle reporting comes last; no load is fabricated.
export async function refreshCrxCachedLifecycle(transport, message, sendCommand = (target, method, params) => chrome.debugger.sendCommand(target, method, params)) {
  if (message.method !== "Page.frameNavigated" || message.params?.type !== "BackForwardCacheRestore") return;
  const tabId = tabForSession(transport, message.sessionId);
  if (tabId === undefined || !transport.getTargetId(tabId)) return;
  const rootSession = message.sessionId === `crx-tab-${tabId}`;
  if (!rootSession && transport._sessions.get(message.sessionId) !== tabId) return;
  const attachment = transport._tabToTarget.get(tabId), frames = framesFor(transport, tabId), revision = revisions.get(frames);
  const original = message.params.frame, target = rootSession ? { tabId } : { tabId, sessionId: message.sessionId };
  if (!attachment || !original?.id || !original.loaderId) return;
  const current = () => transport._tabToTarget.get(tabId) === attachment && framesByTransport.get(transport)?.get(tabId) === frames &&
    revisions.get(frames) === revision && (rootSession || transport._sessions.get(message.sessionId) === tabId);
  const tree = (await sendCommand(target, "Page.getFrameTree"))?.frameTree;
  if (!current() || tree?.frame.id !== original.id || tree.frame.loaderId !== original.loaderId) return;
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
  await sendCommand(target, "Page.setLifecycleEventsEnabled", { enabled: true });
}
