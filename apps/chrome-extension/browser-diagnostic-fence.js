// Runtime.enable replays Chromium's stored console/errors with their original
// epoch-millisecond timestamps. Fence each production Page before enabling any
// root/child/worker Runtime, without clearing the user's browser console.
const fences = new WeakMap();
const releaseGuards = new WeakMap();

export function beginDiagnosticFence(page, now = () => performance.timeOrigin + performance.now()) {
  if (fences.has(page)) throw new Error("Diagnostic Page fence already initialized");
  const cutoff = now();
  if (!Number.isFinite(cutoff) || cutoff < 0) throw new Error("Invalid diagnostic timestamp boundary");
  fences.set(page, { cutoff, sessions: new WeakMap() });
  return cutoff;
}

function captureSession(client) {
  const connection = client?._connection;
  const transport = connection?._transport;
  const sessionId = client?._sessionId;
  const root = /^crx-tab-(\d+)$/.exec(sessionId ?? "");
  const tabId = root ? Number(root[1]) : transport?._sessions?.get(sessionId);
  const targetInfo = transport?._tabToTarget?.get(tabId);
  if (!Number.isSafeInteger(tabId) || !targetInfo || !sessionId) return;
  return () => !client._closed && !client._crashed && !connection._closed &&
    !connection._browserDisconnectedLogs && connection._sessions.get(sessionId) === client &&
    transport._tabToTarget.get(tabId) === targetInfo &&
    (root || transport._sessions.get(sessionId) === tabId);
}

// Bind before Runtime.enable. A later callback must not rediscover a replacement
// target through a reused numeric tab or session ID.
export function bindDiagnosticSession(page, client) {
  const fence = fences.get(page);
  if (!fence || fence.sessions.has(client)) return;
  fence.sessions.set(client, captureSession(client) ?? (() => false));
}

function objectsFor(kind, event) {
  if (kind === "console") return event?.args ?? [];
  if (kind === "exception") return [event?.exceptionDetails?.exception];
  if (kind === "log") return event?.entry?.args ?? [];
  throw new Error("Unknown native diagnostic event kind");
}

export function acceptDiagnosticEvent(page, client, kind, event) {
  const fence = fences.get(page);
  if (!fence) return true; // Standalone CRX retains upstream behavior.
  const current = fence.sessions.get(client);
  const timestamp = kind === "log" ? event?.entry?.timestamp : event?.timestamp;
  if (current?.() && Number.isFinite(timestamp) && timestamp >= fence.cutoff) return true;
  const ids = new Set(objectsFor(kind, event).map(object => object?.objectId).filter(id => typeof id === "string" && id.length));
  for (const objectId of ids) {
    if (!current?.()) break;
    const params = { objectId };
    releaseGuards.set(params, () => {
      if (!current()) throw new Error("Diagnostic object belongs to a retired native session");
    });
    // This is native event-handle best-effort cleanup, like CRX's Log handler,
    // not the media source's durable cleanup lease. _sendMayFail logs failures;
    // neither its settlement nor a disposed Page is asserted to prove release.
    // Calling it now (not in a later microtask) captures the original routing.
    void client._sendMayFail("Runtime.releaseObject", params);
  }
  return false;
}

// Only params created above carry this guard. The transport retrieves it before
// copying protocol params and checks it again immediately before native send,
// after any asynchronous backend admission. No private field reaches CDP.
export function diagnosticReleaseGuard(params) {
  return params && releaseGuards.get(params);
}
