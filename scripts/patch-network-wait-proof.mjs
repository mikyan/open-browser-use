// Keep native request provenance outside the public Request initializer. The
// WeakMap holds no response bytes/headers and never retrieves another resource.
export const networkWaitProofBridge = `
const openBrowserUseNetworkRequests = new WeakMap();
const openBrowserUseNativeNetworkEvents = new WeakMap();
const openBrowserUseNetworkDocuments = new WeakMap();
function networkProofError() { return new Error("OBU_SITE_ACCESS_UNVERIFIED: original network document could not be verified"); }
function networkDocumentMap(identity) {
  let frames = openBrowserUseNetworkDocuments.get(identity);
  if (!frames) openBrowserUseNetworkDocuments.set(identity, frames = new Map());
  return frames;
}
function observeOpenBrowserUseNetworkDocument(transport, tabId, method, params) {
  const identity = transport._tabToTarget.get(tabId), frames = identity && openBrowserUseNetworkDocuments.get(identity);
  if (!frames) return;
  const id = params?.frameId ?? params?.frame?.id;
  // document.open need not replace Playwright's currentDocument. Preserve a
  // separate original token using the delivered browser event, never a URL.
  if (method === "Page.documentOpened" && typeof id === "string" && frames.has(id)) frames.set(id, {});
  if (method === "Page.frameDetached" && params?.reason !== "swap") frames.delete(id);
}
function networkProofRoute(session) {
  const connection = session?._connection, transport = connection?._transport, sessionId = session?._sessionId;
  const root = /^crx-tab-(\\d+)$/.exec(sessionId ?? "");
  const tabId = root ? Number(root[1]) : transport?._sessions?.get(sessionId);
  const identity = transport?._tabToTarget?.get(tabId);
  if (!Number.isSafeInteger(tabId) || !identity) throw networkProofError();
  return { transport, tabId, identity, check() {
    // A navigation request may legitimately migrate to an OOPIF session.
    // The original logical Page/attachment remains mandatory, not its route.
    if (connection._closed || connection._browserDisconnectedLogs || transport._tabToTarget.get(tabId) !== identity) throw networkProofError();
  } };
}
function captureOpenBrowserUseNativeNetworkEvent(manager, sessionInfo, native) {
  let state;
  try {
    const page = manager._page, frame = page?.frameManager.frame(native.frameId), route = networkProofRoute(sessionInfo.session);
    if (!frame || manager._serviceWorker || !page || typeof native.frameId !== "string" || native.frameId !== frame._id ||
        typeof native.loaderId !== "string" || !native.loaderId || typeof native.documentURL !== "string" || !native.documentURL)
      throw networkProofError();
    const lineage = [], seen = new Set(), documents = networkDocumentMap(route.identity);
    for (let current = frame; current; current = current.parentFrame()) {
      if (seen.has(current) || lineage.length >= 1000 || current._page !== page || !current._currentDocument) throw networkProofError();
      seen.add(current);
      if (!documents.has(current._id)) documents.set(current._id, {});
      lineage.push(Object.freeze({ frame: current, id: current._id, document: current._currentDocument,
        url: current.url(), token: documents.get(current._id) }));
    }
    state = Object.freeze({ frame, page, route, lineage: Object.freeze(lineage),
      nativeURL: native.request.url, documentURL: native.documentURL, loaderId: native.loaderId });
  } catch { state = null; }
  openBrowserUseNativeNetworkEvents.set(native, state);
}
function bindOpenBrowserUseNetworkRequest(interceptable, native) {
  const request = interceptable.request, original = openBrowserUseNativeNetworkEvents.get(native);
  const state = original && request._frame === original.frame && !request._serviceWorker
    ? Object.freeze({ ...original, request, url: request.url(), navigation: Boolean(request._documentId), previous: request._redirectedFrom }) : null;
  openBrowserUseNetworkRequests.set(request, state);
}
export function captureOpenBrowserUseNetworkWaitRequest(clientRequest, clientPage) {
  let request, page;
  try { request = clientRequest?._toImpl?.(); page = clientPage?._toImpl?.(); } catch { throw networkProofError(); }
  if (!(request instanceof Request$1) || !page) throw networkProofError();
  const states = [], seen = new Set();
  for (let current = request; current; current = current._redirectedFrom) {
    if (seen.has(current) || states.length >= 100) throw networkProofError();
    seen.add(current);
    const state = openBrowserUseNetworkRequests.get(current);
    if (!state || state.page !== page) throw networkProofError();
    states.push(state);
  }
  const first = states[0];
  const check = () => {
    for (const state of states) {
      state.route.check();
      if (state.request.url() !== state.url || state.request._redirectedFrom !== state.previous ||
          state.request._frame !== state.frame || state.frame._page !== page || page.isClosed?.()) throw networkProofError();
      const documents = openBrowserUseNetworkDocuments.get(state.route.identity);
      for (let index = 0; index < state.lineage.length; index++) {
        const item = state.lineage[index], frame = item.frame;
        if (frame.isDetached() || frame._id !== item.id || page.frameManager.frame(item.id) !== frame ||
            frame.parentFrame() !== (state.lineage[index + 1]?.frame ?? null) || documents?.get(item.id) !== item.token)
          throw networkProofError();
        if (index === 0 && state.navigation) {
          const owns = document => document?.documentId === state.loaderId;
          if (!owns(frame._currentDocument) && !owns(frame.pendingDocument())) throw networkProofError();
        } else if (frame._currentDocument !== item.document || (index === 0 && item.document.documentId !== state.loaderId)) {
          throw networkProofError();
        }
      }
    }
  };
  check();
  // Blank child documents inherit an original, also-validated ancestor. No
  // opaque/worker document can acquire authority from a current URL lookup.
  const urls = [];
  for (const state of states) {
    urls.push(state.url, state.nativeURL);
    const inheritedURL = value => ["", "about:blank", "about:srcdoc"].includes(value);
    if (!inheritedURL(state.documentURL)) urls.push(state.documentURL);
    else if (!inheritedURL(state.lineage[0].url)) throw networkProofError();
    let known = false;
    for (const item of state.lineage) {
      if (inheritedURL(item.url)) continue;
      urls.push(item.url); known = true;
    }
    if (!known || inheritedURL(state.lineage.at(-1).url)) throw networkProofError();
  }
  return Object.freeze({ frameUrl: first.lineage[0].url || first.documentURL, urls: Object.freeze(urls), check });
}
`;

export function patchCrxNetworkWaitProof(source) {
  const request = "    this.request = new Request$1(context, frame, serviceWorker, (redirectedFrom == null ? void 0 : redirectedFrom.request) || null, documentId, url2, type2, method, postDataBuffer, headersOverride || headersObjectToArray(headers));";
  const event = "      if (debugLogger.isEnabled(`chromedebugger`))";
  const native = "  _onRequestWillBeSent(sessionInfo, event) {";
  const mapping = "clientConnection.toImpl = (x) => x ? dispatcherConnection._dispatcherByGuid.get(x._guid)._object";
  if (source.includes("bindOpenBrowserUseNetworkRequest") || source.split(request).length !== 2 || source.split(event).length !== 2 || source.split(native).length !== 2 ||
      !source.includes(mapping) || !source.includes("    frame.setPendingDocument({ documentId: request2._documentId, request: request2 });"))
    throw new Error("Pinned Playwright network proof shape changed; review original Request/document identity");
  return source.replace(request, request + "\n    bindOpenBrowserUseNetworkRequest(this, requestWillBeSentEvent);")
    .replace(native, native + "\n    captureOpenBrowserUseNativeNetworkEvent(this, sessionInfo, event);")
    .replace(event, "      observeOpenBrowserUseNetworkDocument(this, tabId, message, params);\n" + event) + "\n" + networkWaitProofBridge;
}
