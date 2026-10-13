// Original-response access deliberately bypasses Response.body(): the pinned
// implementation can call Network.loadNetworkResource and retrieve a new body.
// The WeakMap retains no bodies and is reachable only through an original
// server Response. Existing Playwright body APIs retain their upstream behavior.
export const responseBodyBridge = `
const openBrowserUseResponses = new WeakMap();
function responseBodyError(code, text) { return new Error("OBU_RESPONSE_BODY_" + code + ": " + text); }
function responseBodyRoute(client, original) {
  const connection = client?._connection, transport = connection?._transport, sessionId = client?._sessionId;
  const root = /^crx-tab-(\\d+)$/.exec(sessionId ?? "");
  const tabId = root ? Number(root[1]) : transport?._sessions?.get(sessionId);
  const identity = transport?._tabToTarget?.get(tabId);
  if (!Number.isSafeInteger(tabId) || !identity || !sessionId || typeof transport?._send !== "function" ||
      (original && (original.connection !== connection || original.transport !== transport || original.tabId !== tabId || original.identity !== identity)))
    throw responseBodyError("EXPIRED", "original native response target is unavailable");
  const check = () => {
    if (client._closed || client._crashed || connection._closed || connection._browserDisconnectedLogs ||
        connection._sessions.get(sessionId) !== client || transport._tabToTarget.get(tabId) !== identity ||
        (!root && transport._sessions.get(sessionId) !== tabId))
      throw responseBodyError("EXPIRED", "original native response session changed");
  };
  check();
  return { connection, transport, tabId, identity, target: Object.freeze(root ? { tabId } : { tabId, sessionId }), check };
}
function bindOpenBrowserUseResponse(response, request) {
  const state = { request, requestId: request._requestId, route: undefined, error: undefined, terminal: false };
  openBrowserUseResponses.set(response, state);
  let original;
  try { original = responseBodyRoute(request.session); } catch (error) { state.error = error; }
  // LoadingFinished updates the original request's session before resolving
  // this promise (notably when a main-document request moves into an OOPIF).
  // Capture that terminal session now, never by looking up the current Page at
  // read time. Failed/redirected requests also finish and must be distinguished.
  response._finishedPromise.then(() => {
    state.terminal = true;
    if (state.error) return;
    try {
      if (state.redirected || request.request._redirectedTo)
        throw responseBodyError("UNAVAILABLE", "redirect response body is unavailable");
      if (request.request._failureText !== null)
        throw responseBodyError("FAILED", "original network request failed");
      state.route = responseBodyRoute(request.session, original);
    } catch (error) { state.error = error; }
  }, () => { state.terminal = true; state.error = responseBodyError("FAILED", "original network response did not finish"); });
}
export function createOpenBrowserUseResponseBodyRead(clientResponse) {
  let response;
  try { response = clientResponse?._toImpl?.(); }
  catch { throw responseBodyError("UNAVAILABLE", "original native response is unavailable"); }
  const state = response && openBrowserUseResponses.get(response);
  if (!state || !(response instanceof Response$1)) throw responseBodyError("UNAVAILABLE", "original native response is unavailable");
  let called = false;
  return Object.freeze({ finished: response._finishedPromise, read: async checkSync => {
    if (called) throw responseBodyError("FAILED", "original response read was already attempted");
    called = true;
    if (typeof checkSync !== "function") throw responseBodyError("INVALID", "response read requires an original scope check");
    if (!state.terminal) throw responseBodyError("UNAVAILABLE", "original response is not complete");
    if (state.error) throw state.error;
    const route = state.route;
    const check = () => { route.check(); checkSync(); };
    check();
    let result;
    try {
      // _send is the actual native promise, not CRSession/Channel's close race.
      // Its private fourth guard runs after asynchronous backend admission and
      // immediately before chrome.debugger.sendCommand; nothing is added to CDP.
      result = await route.transport._send(route.target, "Network.getResponseBody", { requestId: state.requestId }, check);
    } catch (error) {
      // Prefer a precise original-scope failure; otherwise expose a fixed error
      // rather than any body or page-controlled text from a native failure.
      check();
      throw responseBodyError("UNAVAILABLE", "original response body is no longer available from Chromium");
    }
    check();
    return result;
  } });
}
`;

function once(source, before, after) {
  if (source.split(before).length !== 2) throw new Error("Pinned Playwright response body shape changed; review original-response/session identity");
  return source.replace(before, after);
}

export function patchCrxResponseBody(source) {
  const response = "    const response2 = new Response$1(request2.request, responsePayload.status, responsePayload.statusText, headersObjectToArray(responsePayload.headers), timing, getResponseBody, !!responsePayload.fromServiceWorker, responsePayload.protocol);";
  const redirect = "    const response2 = this._createResponse(request2, responsePayload, hasExtraInfo);\n    response2.setTransferSize(null);";
  const finish = "    this._maybeUpdateRequestSession(sessionInfo, request2);\n    const response2 = request2.request._existingResponse();";
  if (source.split(finish).length !== 3 || !source.includes("diagnosticGuard?.();") ||
      !source.includes("clientConnection.toImpl = (x) => x ? dispatcherConnection._dispatcherByGuid.get(x._guid)._object"))
    throw new Error("Pinned Playwright response body shape changed; original terminal session and guarded native transport are required");
  source = once(source, response, response + "\n    bindOpenBrowserUseResponse(response2, request2);");
  source = once(source, redirect, redirect.replace("\n    response2.setTransferSize", "\n    openBrowserUseResponses.get(response2).redirected = true;\n    response2.setTransferSize"));
  return source + "\n" + responseBodyBridge;
}
