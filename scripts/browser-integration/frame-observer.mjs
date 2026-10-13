// Passive native attach witnesses, scoped to this actual worker lifetime. No
// target inventory is used to reconstruct events missed before installation.
export function installFrameObserver(chrome, target, identity) {
  if (typeof identity !== "string" || !identity) throw Error("Frame observer identity required");
  const existing = target.__integrationFrameObserver;
  if (existing) {
    if (existing.identity !== identity) throw Error("Frame observer worker identity changed");
    return existing.snapshot();
  }
  if (Object.hasOwn(target, "__integrationFrames")) throw Error("Unproven frame observer history already exists");
  const frames = [], events = chrome.debugger.onEvent;
  const listener = (source, method, params) => {
    if (method === "Target.attachedToTarget" && params?.targetInfo?.type === "iframe")
      frames.push({ tabId: source.tabId, source, sessionId: params.sessionId, targetId: params.targetInfo.targetId, type: params.targetInfo.type, url: params.targetInfo.url });
  };
  const state = { identity, snapshot() {
    if (target.__integrationFrameObserver !== state || target.__integrationFrames !== frames || !events.hasListener(listener))
      throw Error("Original frame observer or history was replaced");
    return { identity, ready: true, count: frames.length };
  } };
  events.addListener(listener);
  target.__integrationFrames = frames; target.__integrationFrameObserver = state;
  return state.snapshot();
}
