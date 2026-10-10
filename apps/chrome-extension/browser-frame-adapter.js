// chrome.debugger can omit already-loaded OOPIFs from the parent's frame tree.
// Supply only the missing CDP frame attachment, using the child's real frame
// tree; Playwright continues to own all frame, locator, and action semantics.
const framesByTransport = new WeakMap();

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
  if (message.method === "Target.detachedFromTarget" && !message.sessionId) {
    framesByTransport.get(transport)?.delete(tabForSession(transport, message.params?.sessionId));
    return;
  }
  const tabId = tabForSession(transport, message.sessionId);
  if (tabId === undefined) return;
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

// A BFCache restore does not fire fresh load/DOMContentLoaded events. Enabling
// lifecycle events again asks Chromium to report its actual current milestones;
// it does not reload, disable caching, or fabricate a completed load for PW.
export async function refreshCrxCachedLifecycle(transport, message, sendCommand = (target, method, params) => chrome.debugger.sendCommand(target, method, params)) {
  if (message.method !== "Page.frameNavigated" || message.params?.type !== "BackForwardCacheRestore") return;
  const tabId = tabForSession(transport, message.sessionId);
  if (tabId === undefined || !transport.getTargetId(tabId)) return;
  const rootSession = message.sessionId === `crx-tab-${tabId}`;
  if (!rootSession && transport._sessions.get(message.sessionId) !== tabId) return;
  await sendCommand(rootSession ? { tabId } : { tabId, sessionId: message.sessionId }, "Page.setLifecycleEventsEnabled", { enabled: true });
}
