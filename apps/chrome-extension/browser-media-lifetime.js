// Native destruction evidence for currently active media calls only. This does
// not consume Playwright's synthetic Page/context close events or retain a
// browser-wide history of context IDs. A lease outlives a late native response.
export class MediaContextLifetimes {
  #leases = new Set();
  #events;
  #listening = false;

  constructor({ onEvent, onDetach, onTabRemoved }) {
    for (const event of [onEvent, onDetach, onTabRemoved]) {
      if (typeof event?.addListener !== "function" || typeof event?.removeListener !== "function")
        throw new Error("Native media lifetime events are required");
    }
    this.#events = [
      [onEvent, (target, method, params) => {
        if (method !== "Runtime.executionContextDestroyed" && method !== "Runtime.executionContextsCleared") return;
        for (const lease of this.#leases) {
          if (!this.#sameTarget(lease.target, target)) continue;
          if (method === "Runtime.executionContextsCleared" || params?.executionContextId === lease.contextId) lease.gone = true;
        }
      }],
      [onDetach, (target, reason) => {
        if (reason !== "target_closed") return;
        for (const lease of this.#leases) {
          if (target?.tabId === lease.target.tabId &&
              (target.sessionId === undefined || target.sessionId === lease.target.sessionId)) lease.gone = true;
        }
      }],
      [onTabRemoved, tabId => {
        for (const lease of this.#leases) if (lease.target.tabId === tabId) lease.gone = true;
      }]
    ];
  }

  get size() { return this.#leases.size; }

  #sameTarget(left, right) {
    return left.tabId === right?.tabId && left.sessionId === right?.sessionId;
  }

  capture(target, contextId) {
    if (!target || typeof target !== "object" || Array.isArray(target) ||
        Object.keys(target).some(key => key !== "tabId" && key !== "sessionId") ||
        !Number.isSafeInteger(target.tabId) || target.tabId < 0 ||
        (target.sessionId !== undefined && (typeof target.sessionId !== "string" || !target.sessionId || target.sessionId.length > 256)) ||
        !Number.isSafeInteger(contextId) || contextId < 1)
      throw new Error("Invalid native media context identity");
    const lease = { target: Object.freeze({ ...target }), contextId, gone: false };
    if (!this.#listening) {
      const added = [];
      try {
        for (const [event, listener] of this.#events) { event.addListener(listener); added.push([event, listener]); }
        this.#listening = true;
      } catch (error) {
        for (const [event, listener] of added) event.removeListener(listener);
        throw error;
      }
    }
    this.#leases.add(lease);
    return Object.freeze({
      isGone: () => lease.gone,
      close: () => {
        if (!this.#leases.delete(lease)) return;
        if (!this.#leases.size) {
          for (const [event, listener] of this.#events) event.removeListener(listener);
          this.#listening = false;
        }
      }
    });
  }
}
