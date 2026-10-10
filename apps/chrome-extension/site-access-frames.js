// Validate one native webNavigation snapshot. The caller owns freshness,
// navigation generations and attachment identity across asynchronous reads.
const MAX_FRAMES = 1000;
const DENIED = "OBU_SITE_ACCESS_DENIED: document access is not allowed by the website policy";
const UNVERIFIED = "OBU_SITE_ACCESS_UNVERIFIED: document access could not be verified";
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const unverified = () => { throw new Error(UNVERIFIED); };

function urlKind(value) {
  if (typeof value !== "string" || !value || value.trim() !== value || /[\u0000-\u0020\u007f]/.test(value)) return unverified();
  if (value === "about:blank") return "blank";
  if (value === "about:srcdoc") return "srcdoc";
  let parsed;
  try { parsed = new URL(value); } catch { return unverified(); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return unverified();
  return "http";
}

function assertAllowedUrl(policy, url, { allowBlank = false } = {}) {
  const kind = urlKind(url);
  if (kind !== "http" && !(kind === "blank" && allowBlank)) return unverified();
  if (policy.allowsUrl(url, { allowBlank }) !== true) throw new Error(DENIED);
  return kind;
}

export function assertSiteAccessFrames(policy, tab, frames) {
  policy.assertReady();
  if (!policy.restricted) return;
  if (!record(tab)) return unverified();
  const currentKind = assertAllowedUrl(policy, tab.url, { allowBlank: true });
  if (tab.pendingUrl !== undefined) assertAllowedUrl(policy, tab.pendingUrl, { allowBlank: true });
  if (!Array.isArray(frames) || frames.length === 0 || frames.length > MAX_FRAMES) return unverified();

  const byId = new Map();
  for (const frame of frames) {
    if (!record(frame) || !Number.isSafeInteger(frame.frameId) || frame.frameId < 0 ||
        !Number.isSafeInteger(frame.parentFrameId) || frame.parentFrameId < -1 ||
        byId.has(frame.frameId) || frame.documentLifecycle !== "active" || frame.errorOccurred !== false) return unverified();
    if (frame.frameId === 0 ? frame.parentFrameId !== -1 : frame.parentFrameId < 0) return unverified();
    const kind = urlKind(frame.url);
    if (kind === "http") assertAllowedUrl(policy, frame.url);
    else if (frame.frameId === 0 && (kind !== "blank" || currentKind !== "blank")) return unverified();
    byId.set(frame.frameId, frame);
  }
  if (!byId.has(0)) return unverified();

  // Every document, including independently allowed HTTP frames, needs a real
  // path to the one root. Blank/srcdoc frames inherit only that verified path.
  // Iteration bounds stack use even for a maximally deep native frame tree.
  const verified = new Set([0]);
  for (const frame of frames) {
    const path = new Set();
    let current = frame;
    while (!verified.has(current.frameId)) {
      if (path.has(current.frameId)) return unverified();
      path.add(current.frameId);
      current = byId.get(current.parentFrameId);
      if (!current) return unverified();
    }
    for (const frameId of path) verified.add(frameId);
  }
}
