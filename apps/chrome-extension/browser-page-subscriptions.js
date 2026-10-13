// One exact Page/event queue shared by diagnostics and explicit network waits.
// This acknowledges the local PageDispatcher filter, not Chrome Network.enable.
const queuesByPage = new WeakMap();
const protocolEvents = new Map([["console", "console"], ["request", "request"], ["response", "response"],
  ["requestfinished", "requestFinished"], ["requestfailed", "requestFailed"]]);

export function updatePageSubscription(page, event) {
  const protocolEvent = protocolEvents.get(event);
  if (!protocolEvent) throw new Error("Unsupported Page subscription event");
  // EventEmitter-only consumers have no remote dispatcher. Production Pages
  // always have this channel; no such fallback is evidence of native readiness.
  if (!page?._channel?.updateSubscription) return Promise.resolve();
  let queues = queuesByPage.get(page);
  if (!queues) queuesByPage.set(page, queues = new Map());
  const actual = (queues.get(protocolEvent) ?? Promise.resolve()).catch(() => {}).then(() => {
    if (page.isClosed?.()) return;
    return page._channel.updateSubscription({ event: protocolEvent, enabled: page.listenerCount(event) > 0 });
  });
  queues.set(protocolEvent, actual);
  actual.finally(() => { if (queues.get(protocolEvent) === actual) queues.delete(protocolEvent); }).catch(() => {});
  return actual;
}
